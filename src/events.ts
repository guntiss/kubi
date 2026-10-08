import * as vscode from 'vscode';
import * as k from './kubectl';
import { Health, Link, Row, notifiable, toRow } from './model';

/**
 * The cluster's events as notifications: fetched in the background while any
 * dashboard is open on a context, whichever page it shows, grouped into
 * issues, and tracked as read or unread so the same problem is raised once
 * rather than on every poll.
 *
 * Like the metrics history, this lives in the extension host, one store per
 * context: every dashboard on a cluster sees the same issues and the same
 * read state, and marking one read in one window clears it in the other.
 */

/**
 * The background poll. Events are not urgent to the second — a warning seen
 * half a minute late is still news — and `get events` across a busy cluster
 * is one of the heavier lists, so this runs well under the tables' pace.
 */
const POLL_MS = 30 * 1000;

/**
 * A fetch this recent is reused. The Overview asks for events on every load
 * and the timer asks on its own; whichever comes second shares the first.
 */
const FRESH_MS = 5 * 1000;

/**
 * How long a read issue has to go quiet before it counts as a new incident.
 * A crash loop repeats every few minutes for as long as it lasts, and having
 * read it once should silence every one of those; an hour of silence and then
 * the same failure is a different afternoon. An hour is also Kubernetes'
 * default event TTL, after which the old record is gone anyway.
 */
const QUIET_MS = 60 * 60 * 1000;

/**
 * Read marks whose issue has not been seen for this long are dropped. The
 * event expired long before; the mark is only taking up space.
 */
const FORGET_MS = 24 * 60 * 60 * 1000;

/** Read state for every context, in globalState under one key. */
const READ_KEY = 'kubi.eventsRead';

interface ContextReadState {
  /** Issue key → the last occurrence (ms) seen while it was read. */
  read: Record<string, number>;
  /** Reasons never notified about on this context. */
  muted: string[];
}

/**
 * One problem: the events about one object, for one reason. A pod's 400
 * BackOff records are one issue with a count, which is what is worth telling
 * someone about.
 */
export interface Issue {
  key: string;
  reason: string;
  namespace?: string;
  /** "Pod/web-7d9", as the Events table's Object column reads. */
  object: string;
  /** The object the events are about, as a Go to target, when Kubi lists its kind. */
  link?: Link;
  health: Health;
  /** The newest occurrence's message. */
  message: string;
  /** Occurrences the cluster counted, across every record in the issue. */
  count: number;
  /** When it last happened, as the event reports it. */
  lastSeen?: string;
  /** The event rows behind it, newest first, for the Overview. */
  rows: Row[];
}

/** An issue as the webview gets it: no rows, plus its read state. */
export type IssueState = Omit<Issue, 'rows'> & { unread: boolean; muted: boolean };

export interface Snapshot {
  issues: IssueState[];
  muted: string[];
  /** When the issues were fetched; 0 before the first fetch. */
  generated: number;
}

function issueKey(row: Row): string {
  return [row.namespace ?? '', row.cells.object ?? '', row.cells.reason ?? ''].join('\u0000');
}

function time(value: string | undefined): number {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : 0;
}

class ContextEvents {
  private issues: Issue[] = [];
  /** Every event the last fetch returned, Normal ones included. */
  private total = 0;
  private fetchedAt = 0;
  private inFlight: Promise<void> | undefined;
  private holders = 0;
  private timer: NodeJS.Timeout | undefined;
  private abort = new AbortController();
  private readonly emitter = new vscode.EventEmitter<void>();
  /** Fires when the issues or their read state change. */
  readonly onDidChange = this.emitter.event;
  /**
   * What the last change looked like, so a poll that finds the same issues
   * in the same state tells nobody: every dashboard repaints its bell on a
   * change, and one every 30 seconds for nothing is waste.
   */
  private signature = '';

  constructor(private readonly context: string, private readonly memento: vscode.Memento) {}

  /**
   * Keeps the background poll running until the returned disposable is
   * disposed, as `ContextMetrics.retain` does: one timer per context, started
   * by the first dashboard and stopped by the last.
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
   * Skipped while auto-refresh is off, like the metrics poll, and while
   * notifications are: either way someone asked for no kubectl on a timer.
   * The Overview still fetches when it is opened.
   */
  private poll(): void {
    const config = vscode.workspace.getConfiguration('kubi');
    if ((config.get<number>('autoRefreshSeconds') ?? 5) <= 0 || notificationMode() === 'off') {
      return;
    }
    this.refresh().catch(() => {
      // The page on screen reports a cluster that cannot be reached; the
      // issues already held stand until a poll gets through.
    });
  }

  /**
   * Fetches the cluster's events, joining a fetch already under way and
   * reusing one younger than FRESH_MS. Rejects when the fetch fails, so the
   * Overview can report it; the poll swallows that itself.
   *
   * Takes no signal, as `ContextMetrics.refresh` does not: the fetch is
   * shared, and one dashboard moving on is no reason to cancel it for the
   * others.
   */
  refresh(): Promise<void> {
    if (Date.now() - this.fetchedAt < FRESH_MS) {
      return Promise.resolve();
    }
    return (this.inFlight ??= k.list('events', this.context, k.ALL_NAMESPACES, this.abort.signal)
      .then((items) => this.ingest(items))
      .finally(() => {
        this.inFlight = undefined;
      }));
  }

  /**
   * Rebuilds the issues from a full list of the cluster's events, from the
   * poll or from anything else that fetched one — the Events table does on
   * every load, and its rows are as good as the poll's.
   */
  ingest(items: k.KubeObject[]): void {
    this.fetchedAt = Date.now();
    this.total = items.length;
    const issues = new Map<string, Issue>();
    for (const item of items) {
      const row = toRow('events', item);
      if (!notifiable(row)) continue;
      const key = issueKey(row);
      const link = row.links?.[0];
      const issue = issues.get(key) ?? {
        key,
        reason: row.cells.reason || 'Unknown',
        // A Node's events are filed in `default`, which says nothing about a
        // cluster-scoped object; its link has no namespace, and nor does this.
        namespace: link && !link.namespace ? undefined : row.namespace,
        object: row.cells.object || row.name,
        link,
        health: row.health,
        message: '',
        count: 0,
        rows: []
      };
      issue.count += Number(row.cells.count || 1);
      if (row.health === 'bad') issue.health = 'bad';
      issue.rows.push(row);
      issues.set(key, issue);
    }
    for (const issue of issues.values()) {
      issue.rows.sort((a, b) => time(b.created) - time(a.created));
      issue.lastSeen = issue.rows[0].created;
      issue.message = issue.rows[0].cells.message ?? '';
    }
    this.issues = [...issues.values()].sort((a, b) => time(b.lastSeen) - time(a.lastSeen));
    this.settleRead();
    this.changed();
  }

  /**
   * Applies the read rules to the issues just fetched: a read issue that
   * keeps happening carries its mark forward, one that comes back after
   * QUIET_MS loses it, and marks nothing has been seen under for FORGET_MS
   * are dropped.
   */
  private settleRead(): void {
    const state = this.readState();
    let dirty = false;
    for (const issue of this.issues) {
      const mark = state.read[issue.key];
      if (mark === undefined) continue;
      const last = time(issue.lastSeen);
      if (last - mark >= QUIET_MS) {
        delete state.read[issue.key];
        dirty = true;
      } else if (last > mark) {
        state.read[issue.key] = last;
        dirty = true;
      }
    }
    const cutoff = Date.now() - FORGET_MS;
    for (const [key, mark] of Object.entries(state.read)) {
      if (mark < cutoff) {
        delete state.read[key];
        dirty = true;
      }
    }
    if (dirty) this.saveReadState(state);
  }

  /** Marks the issues with these keys read, at their latest occurrence. */
  markRead(keys: string[]): void {
    const state = this.readState();
    const wanted = new Set(keys);
    for (const issue of this.issues) {
      if (wanted.has(issue.key)) state.read[issue.key] = time(issue.lastSeen) || Date.now();
    }
    this.saveReadState(state);
    this.changed();
  }

  markAllRead(): void {
    this.markRead(this.issues.map((issue) => issue.key));
  }

  /** Stops or resumes notifying about one reason on this context. */
  setMuted(reason: string, muted: boolean): void {
    const state = this.readState();
    const set = new Set(state.muted);
    if (muted) set.add(reason);
    else set.delete(reason);
    state.muted = [...set].sort();
    this.saveReadState(state);
    this.changed();
  }

  /** The issues as the bell and the toasts need them. */
  snapshot(): Snapshot {
    const state = this.readState();
    const muted = new Set(state.muted);
    return {
      issues: this.issues.map(({ rows: _rows, ...issue }) => ({
        ...issue,
        muted: muted.has(issue.reason),
        unread: !muted.has(issue.reason) && state.read[issue.key] === undefined
      })),
      muted: state.muted,
      generated: this.fetchedAt
    };
  }

  /** The full issues, rows and all, for the Overview, and how many events there were in all. */
  detail(): { issues: Issue[]; total: number } {
    return { issues: this.issues, total: this.total };
  }

  /**
   * Restores the issues from a snapshot cached by an earlier session, once
   * and only before anything has been fetched, so the bell paints its count
   * as the dashboard opens rather than half a minute later. Read state is
   * not part of the cache — it is always the live one.
   */
  seed(cached: unknown): void {
    if (this.fetchedAt || this.issues.length || !cached || typeof cached !== 'object') return;
    const issues = (cached as Partial<Snapshot>).issues;
    if (!Array.isArray(issues)) return;
    this.issues = issues.map(({ unread: _u, muted: _m, ...issue }) => ({ ...issue, rows: [] }));
  }

  private readState(): ContextReadState {
    const all = this.memento.get<Record<string, ContextReadState>>(READ_KEY, {});
    const mine = all[this.context];
    return { read: { ...(mine?.read ?? {}) }, muted: [...(mine?.muted ?? [])] };
  }

  private saveReadState(state: ContextReadState): void {
    const all = { ...this.memento.get<Record<string, ContextReadState>>(READ_KEY, {}) };
    if (Object.keys(state.read).length || state.muted.length) {
      all[this.context] = state;
    } else {
      delete all[this.context];
    }
    void this.memento.update(READ_KEY, all);
  }

  private changed(): void {
    const { issues, muted } = this.snapshot();
    const signature = JSON.stringify([muted, issues.map((i) => [i.key, i.unread, i.lastSeen, i.count])]);
    if (signature === this.signature) return;
    this.signature = signature;
    this.emitter.fire();
  }
}

/** `kubi.eventNotifications`: toasts and the bell, the bell only, or neither. */
export type NotificationMode = 'toasts' | 'badge' | 'off';

export function notificationMode(): NotificationMode {
  const mode = vscode.workspace.getConfiguration('kubi').get<string>('eventNotifications');
  return mode === 'badge' || mode === 'off' ? mode : 'toasts';
}

const stores = new Map<string, ContextEvents>();

/** The context's event store, created on first use and kept for the session. */
export function eventsFor(context: string, memento: vscode.Memento): ContextEvents {
  let store = stores.get(context);
  if (!store) {
    store = new ContextEvents(context, memento);
    stores.set(context, store);
  }
  return store;
}
