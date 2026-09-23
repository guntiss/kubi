import * as vscode from 'vscode';
import * as k from './kubectl';
import { PartialCeiling, Row, Usage } from './model';

/**
 * CPU and memory usage from metrics-server, and the short history behind the
 * sparklines in the Nodes and Pods tables.
 *
 * metrics-server keeps no history of its own — it answers with one reading per
 * object, averaged over its last scrape window — so the trend a sparkline draws
 * is whatever this extension has seen since it started asking. The history
 * lives here, in the extension host, rather than in the webview: it then
 * survives switching kinds, which rebuilds the table from nothing, and every
 * dashboard open on the same context draws from one series instead of each
 * polling its own.
 *
 * The polling lives here too. While at least one dashboard is open on a
 * context, that context's nodes and pods are read on a timer of their own,
 * whichever page the dashboards show and whether or not anyone is looking at
 * them: the tables only poll while attended, and a history fed by them alone
 * broke every time the window lost focus, and never grew for nodes while the
 * Pods page was up. One timer per context, however many dashboards share it.
 */

export type MetricsKind = 'nodes' | 'pods';

/** Kinds metrics-server reports on. */
function hasMetrics(kindId: string): kindId is MetricsKind {
  return kindId === 'nodes' || kindId === 'pods';
}

/**
 * How far back a sparkline reaches. Long enough to show a trend — a leak
 * climbing, a spike that has passed — and short enough that a pod table's
 * worth of series stays a small payload on every poll.
 */
const WINDOW_MS = 10 * 60 * 1000;

/**
 * A backstop on samples per series. metrics-server scrapes every 15s by
 * default, which fills the window with 40; a server tuned to scrape faster
 * would otherwise grow every row's payload in step.
 */
const MAX_SAMPLES = 40;

/**
 * How long readings are still shown after metrics stop arriving. One failed
 * poll — a timeout, a metrics-server pod restarting — should not blank the
 * column, but numbers minutes old presented as current would be a lie.
 */
const STALE_MS = 3 * 60 * 1000;

/**
 * How long to leave the metrics API alone after it fails. On a cluster without
 * metrics-server every attempt fails the same way, and one kubectl process per
 * poll spent learning that again is waste.
 */
const RETRY_MS = 60 * 1000;

/**
 * The background poll. Under metrics-server's default 15s scrape, so no
 * reading is skipped for long, but not so far under that most polls come back
 * with the reading already held.
 */
const POLL_MS = 10 * 1000;

/**
 * A reading this recent is not fetched again. Dashboards ask for the kind they
 * show before drawing it, so a table opened or refreshed just after the timer
 * fired reuses its reading rather than repeating it.
 */
const FRESH_MS = 5 * 1000;

/** One reading: when (ms), CPU in millicores, memory in bytes. */
type Sample = [number, number, number];

interface ContainerUsage {
  cpu: number;
  memory: number;
}

class ContextMetrics {
  private readonly series: Record<MetricsKind, Map<string, Sample[]>> = { nodes: new Map(), pods: new Map() };
  /** Per-container readings from the latest fetch, for the pod details panel. */
  private readonly containers = new Map<string, Record<string, ContainerUsage>>();
  private readonly retryAt: Record<MetricsKind, number> = { nodes: 0, pods: 0 };
  /** Local time of the last successful fetch; see STALE_MS. */
  private readonly fetchedAt: Record<MetricsKind, number> = { nodes: 0, pods: 0 };
  /** Kinds already seeded from the cache, so a later empty history is not re-seeded with old data. */
  private readonly seeded = new Set<MetricsKind>();
  /** The fetch under way per kind, which every caller asking meanwhile shares. */
  private readonly inFlight: Partial<Record<MetricsKind, Promise<void>>> = {};
  /** Dashboards open on this context; the timer runs while there are any. */
  private holders = 0;
  private timer: NodeJS.Timeout | undefined;
  /** Cancels the fetches under way when the last dashboard closes. */
  private abort = new AbortController();

  constructor(private readonly context: string) {}

  /**
   * Keeps the background poll running until the returned disposable is
   * disposed. Each dashboard holds one for its lifetime; the first starts the
   * timer and the last to let go stops it.
   */
  retain(): vscode.Disposable {
    if (this.holders++ === 0) {
      this.abort = new AbortController();
      this.timer = setInterval(() => this.poll(), POLL_MS);
      this.poll();
    }
    let released = false;
    return new vscode.Disposable(() => {
      if (released) return;
      released = true;
      if (--this.holders === 0) {
        clearInterval(this.timer);
        this.timer = undefined;
        this.abort.abort();
      }
    });
  }

  /**
   * Both kinds, whatever the dashboards show. Skipped while auto-refresh is
   * off: whoever turned it off asked for no kubectl running on a timer, and
   * the tables still read usage on every load they make.
   */
  private poll(): void {
    const seconds = vscode.workspace.getConfiguration('kubi').get<number>('autoRefreshSeconds') ?? 5;
    if (seconds > 0) {
      void this.refresh('nodes');
      void this.refresh('pods');
    }
  }

  /**
   * Takes one reading of every node or pod and appends it to the history; a
   * no-op for any other kind, so callers need not check. A fetch already under
   * way is joined, and a reading younger than FRESH_MS is reused, so two
   * dashboards and the timer asking at once cost one kubectl.
   *
   * Never rejects: metrics are an extra on top of the table, and a cluster
   * without metrics-server — or an RBAC role that cannot read it — must still
   * get its rows. Nor does it take the caller's signal: the fetch is shared,
   * and one dashboard moving on is no reason to cancel it for the others.
   */
  refresh(kind: string): Promise<void> {
    if (!hasMetrics(kind) || Date.now() < this.retryAt[kind] || Date.now() - this.fetchedAt[kind] < FRESH_MS) {
      return Promise.resolve();
    }
    return (this.inFlight[kind] ??= this.fetch(kind).finally(() => {
      delete this.inFlight[kind];
    }));
  }

  private async fetch(kind: MetricsKind): Promise<void> {
    let items: k.MetricsItem[];
    try {
      items = await k.metrics(kind, this.context, this.abort.signal);
    } catch (err) {
      // Cancelled only when the last dashboard closed; that is no failure of
      // the metrics API to back off from.
      if (!k.isCancelled(err)) {
        this.retryAt[kind] = Date.now() + RETRY_MS;
      }
      return;
    }
    this.retryAt[kind] = 0;
    this.fetchedAt[kind] = Date.now();

    const series = this.series[kind];
    const seen = new Set<string>();
    // Pruned against the newest reading rather than the local clock: the
    // timestamps are the API server's, and a skewed laptop clock would
    // otherwise throw away every sample or keep them all.
    let latest = 0;
    for (const item of items) {
      const time = Date.parse(item.timestamp ?? '');
      if (Number.isFinite(time) && time > latest) latest = time;
    }
    for (const item of items) {
      const key = seriesKey(item.metadata.name, item.metadata.namespace);
      const time = Date.parse(item.timestamp ?? '');
      if (!Number.isFinite(time)) continue;
      seen.add(key);

      const usage = readUsage(item);
      const sample: Sample = [time, round1(usage.cpu), Math.round(usage.memory)];
      const list = series.get(key) ?? [];
      // The dashboard polls every few seconds and metrics-server rescrapes
      // every 15 or more, so most fetches return the reading already held.
      // Appending it again would draw a flat step where nothing was measured.
      const last = list[list.length - 1];
      if (!last || time > last[0]) {
        list.push(sample);
      }
      while (list.length && (list[0][0] < latest - WINDOW_MS || list.length > MAX_SAMPLES)) {
        list.shift();
      }
      series.set(key, list);

      if (kind === 'pods') {
        const perContainer: Record<string, ContainerUsage> = {};
        for (const c of item.containers ?? []) {
          perContainer[c.name] = { cpu: round1(cpuMillis(c.usage?.cpu)), memory: Math.round(bytes(c.usage?.memory)) };
        }
        this.containers.set(key, perContainer);
      }
    }
    // A pod that is gone takes its history with it; on a cluster that churns
    // through Jobs, keeping every series ever seen would grow without end.
    for (const key of [...series.keys()]) {
      if (!seen.has(key)) {
        series.delete(key);
        this.containers.delete(key);
      }
    }
  }

  /**
   * Restores the history from rows cached by an earlier session, once, so a
   * reloaded window picks the sparklines up where they were rather than
   * starting every one from a single point. Readings older than the window are
   * dropped here and never drawn.
   */
  seed(kind: string, rows: unknown): void {
    if (!hasMetrics(kind) || this.seeded.has(kind)) {
      return;
    }
    this.seeded.add(kind);
    if (!Array.isArray(rows) || this.series[kind].size) {
      return;
    }
    const cutoff = Date.now() - WINDOW_MS;
    for (const row of rows as Row[]) {
      const usage = row.usage;
      if (!usage || !Array.isArray(usage.samples)) continue;
      const samples = usage.samples
        .map(([offset, cpu, memory]): Sample => [usage.from + offset * 1000, cpu, memory])
        .filter(([time]) => time >= cutoff);
      if (samples.length) {
        this.series[kind].set(seriesKey(row.name, row.namespace), samples);
      }
    }
  }

  /**
   * Adds the usage cells and the history to a row built by `toRow`. The raw
   * object is passed alongside because the ceiling a reading is measured
   * against — a node's allocatable, a pod's limits — lives in its spec and
   * status, which the row does not carry.
   *
   * Rows with no reading are left as they are: a completed pod has no usage,
   * and neither does anything when metrics-server is missing, or any kind it
   * does not report on.
   */
  decorate(kind: string, row: Row, object: k.KubeObject): Row {
    if (!hasMetrics(kind) || Date.now() - this.fetchedAt[kind] > STALE_MS) {
      return row;
    }
    const key = seriesKey(row.name, row.namespace);
    const samples = this.series[kind].get(key);
    if (!samples?.length) {
      return row;
    }
    const [, cpu, memory] = samples[samples.length - 1];
    const ceiling = kind === 'nodes' ? nodeCeiling(object) : podCeiling(object, this.containers.get(key));
    const from = samples[0][0];
    const usage: Usage = {
      cpu,
      memory,
      ...ceiling,
      from,
      to: samples[samples.length - 1][0],
      // Offsets in whole seconds from `from`, rather than epoch milliseconds:
      // a pod table carries one of these per row on every poll.
      samples: samples.map(([time, c, m]) => [Math.round((time - from) / 1000), c, m]),
      ...(kind === 'pods' && this.containers.has(key) ? { containers: this.containers.get(key) } : {})
    };
    return {
      ...row,
      usage,
      cells: {
        ...row.cells,
        cpu: formatCpu(cpu),
        memory: formatMemory(memory),
        ...(usage.cpuCeiling ? { cpuPct: formatShare((usage.cpuPartial?.used ?? cpu) / usage.cpuCeiling) } : {}),
        ...(usage.memoryCeiling
          ? { memPct: formatShare((usage.memoryPartial?.used ?? memory) / usage.memoryCeiling) }
          : {})
      }
    };
  }
}

const stores = new Map<string, ContextMetrics>();

/** The metrics history for a context, shared by every dashboard open on it. */
export function metricsFor(context: string): ContextMetrics {
  let store = stores.get(context);
  if (!store) {
    store = new ContextMetrics(context);
    stores.set(context, store);
  }
  return store;
}

function seriesKey(name: string, namespace?: string): string {
  return `${namespace ?? ''}/${name}`;
}

/** A node's reading is its own; a pod's is per container, and the row shows the total. */
function readUsage(item: k.MetricsItem): ContainerUsage {
  if (item.usage) {
    return { cpu: cpuMillis(item.usage.cpu), memory: bytes(item.usage.memory) };
  }
  let cpu = 0;
  let memory = 0;
  for (const c of item.containers ?? []) {
    cpu += cpuMillis(c.usage?.cpu);
    memory += bytes(c.usage?.memory);
  }
  return { cpu, memory };
}

/** What the scheduler can hand out on this node, which is what "full" means for it. */
function nodeCeiling(node: k.KubeObject): Pick<Usage, 'cpuCeiling' | 'memoryCeiling'> {
  const allocatable = node.status?.allocatable ?? {};
  return {
    ...(allocatable.cpu ? { cpuCeiling: cpuMillis(allocatable.cpu) } : {}),
    ...(allocatable.memory ? { memoryCeiling: bytes(allocatable.memory) } : {})
  };
}

type PodCeiling = Pick<Usage, 'cpuCeiling' | 'memoryCeiling' | 'cpuPartial' | 'memoryPartial'>;

/**
 * A pod's limits, summed over the containers that are running for its life:
 * the ordinary ones and native sidecars (init containers with `restartPolicy:
 * Always`).
 *
 * When only some of them set a limit, the ceiling is the sum of those that
 * do, measured against their usage alone. Counting an unlimited sidecar's
 * usage against the app's limit would show pressure that is not there, and
 * dropping the ceiling altogether, the pod as a whole being unbounded, would
 * blank the column for nearly every pod that runs a sidecar. That needs the
 * per-container readings; without them a partial ceiling is left out.
 */
function podCeiling(pod: k.KubeObject, used: Record<string, ContainerUsage> | undefined): PodCeiling {
  const running: any[] = [
    ...(pod.spec?.containers ?? []),
    ...(pod.spec?.initContainers ?? []).filter((c: any) => c.restartPolicy === 'Always')
  ];
  const measure = (key: 'cpu' | 'memory', parse: (q: string) => number) => {
    const limited = running.filter((c) => c.resources?.limits?.[key]);
    if (!limited.length) return {};
    const ceiling = limited.reduce((total, c) => total + parse(c.resources.limits[key]), 0);
    if (limited.length === running.length) return { ceiling };
    if (!used) return {};
    const partial: PartialCeiling = {
      used: limited.reduce((total, c) => total + (used[c.name]?.[key] ?? 0), 0),
      unlimited: running.filter((c) => !limited.includes(c)).map((c) => c.name)
    };
    return { ceiling, partial };
  };
  const cpu = measure('cpu', cpuMillis);
  const memory = measure('memory', bytes);
  return {
    ...(cpu.ceiling !== undefined ? { cpuCeiling: cpu.ceiling } : {}),
    ...(cpu.partial ? { cpuPartial: cpu.partial } : {}),
    ...(memory.ceiling !== undefined ? { memoryCeiling: memory.ceiling } : {}),
    ...(memory.partial ? { memoryPartial: memory.partial } : {})
  };
}

const SUFFIXES: Record<string, number> = {
  n: 1e-9, u: 1e-6, m: 1e-3, '': 1,
  k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
  Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60
};

/**
 * A Kubernetes quantity ("250m", "3796976Ki", "270432092n", "1.5", "1e3") in
 * base units. Unparseable input reads as 0 rather than NaN, which would
 * poison every sum and sort it reached.
 */
function quantity(text: string | undefined): number {
  const match = /^([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)([a-zA-Z]*)$/.exec((text ?? '').trim());
  if (!match || !(match[2] in SUFFIXES)) return 0;
  return Number(match[1]) * SUFFIXES[match[2]];
}

function cpuMillis(text: string | undefined): number {
  return quantity(text) * 1000;
}

function bytes(text: string | undefined): number {
  return quantity(text);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Millicores, the unit `kubectl top` uses for pods and nodes alike. */
export function formatCpu(millis: number): string {
  // Matches the webview: an idle pod is not a pod using nothing.
  return millis > 0 && millis < 0.5 ? '<1m' : `${Math.round(millis)}m`;
}

/** Mi, as `kubectl top` prints it, switching to Gi once Mi runs to four digits. */
export function formatMemory(value: number): string {
  const mi = value / 2 ** 20;
  return mi >= 1024 ? `${(mi / 1024).toFixed(1)}Gi` : `${Math.round(mi)}Mi`;
}

/** A share of a ceiling as a whole percentage; a trace of usage is not "0%". */
function formatShare(share: number): string {
  return share > 0 && share < 0.005 ? '<1%' : `${Math.round(share * 100)}%`;
}
