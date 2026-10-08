import * as fs from 'fs';
import * as net from 'net';
import * as vscode from 'vscode';
import * as k from './kubectl';
import { DashboardCache } from './cache';
import { metricsFor } from './metrics';
import { GROUPS, KINDS, RAIL_DEFAULT, REFERENCES, Refs, Row, kindById, skew, toRow } from './model';

/** Rail collapse is a global layout preference, shared by every context's panel. */
const RAIL_COLLAPSED_KEY = 'kubi.railCollapsed';

/**
 * The kinds the user keeps in the rail, by id, in their order. Absent until
 * they first change it, and cleared again when they put it back to
 * `RAIL_DEFAULT`, so someone who never customised it follows the default as
 * it changes in later releases.
 */
const RAIL_KINDS_KEY = 'kubi.railKinds';

/** Whether the rail's More section, the kinds not kept in it, is unfolded. */
const RAIL_MORE_KEY = 'kubi.railMore';

/**
 * Each table's columns as the user has arranged them, by kind id. Only their
 * own choices are stored, as with the rail: a kind missing here, or a column
 * missing from its entry, takes what `KINDS` declares, so a column added in a
 * later release still turns up in a table someone has already rearranged.
 */
const COLUMN_LAYOUTS_KEY = 'kubi.columnLayouts';

/** One table's arrangement; see COLUMN_LAYOUTS_KEY. */
interface ColumnLayout {
  /** Column keys, left to right. */
  order?: string[];
  /** Widths the user dragged a column to, in CSS pixels. */
  widths?: Record<string, number>;
  /** Columns explicitly shown or hidden; anything absent follows the default. */
  visible?: Record<string, boolean>;
}

/**
 * The extension's mark for the boot shell's brand row, kept identical to
 * `brandMark()` in dashboard.js so the handover to the script is a swap of the
 * same pixels rather than a visible change. Inline for the same reason the
 * rest of the shell is: an <img> would resolve and paint after the first
 * frame, which is the flicker the shell exists to avoid.
 */
/**
 * Brand mark: a lightning bolt inside a hexagon. The hexagon is a stroke and
 * the bolt a fill, both in `currentColor`, so the rail tints it like any other
 * glyph and the mark reads on both themes. The two shapes never touch, which
 * keeps them separate in one colour. Mirrored in media/dashboard.js as
 * BRAND_HEX/BRAND_BOLT; keep the two in sync.
 */
const BRAND_MARK =
  '<svg class="mark" viewBox="0 0 128 128" aria-hidden="true">'
  + '<path class="mark-hex" d="M64 12 108 37.5v51L64 114 20 88.5v-51L64 12Z" fill="none"'
  + ' stroke="currentColor" stroke-width="9" stroke-linejoin="round"/>'
  + '<path class="mark-bolt" d="M71 33 45 71h16l-5 24 28-39H68l3-23Z" fill="currentColor"/>'
  + '</svg>';

/** The rail's Go to magnifier, as `searchMark()` in dashboard.js draws it. */
const SEARCH_MARK =
  '<svg class="glyph search-mark" viewBox="0 0 16 16" aria-hidden="true">'
  + '<circle cx="6.8" cy="6.8" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'
  + '<path d="M10.3 10.3 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'
  + '</svg>';

/** Messages sent from the webview to the extension. */
type Inbound =
  | { type: 'ready' }
  | { type: 'load'; kind: string }
  /** Escape in the webview: stop the fetch in flight, keep what's on screen. */
  | { type: 'cancelLoad' }
  | { type: 'setNamespace'; namespace: string }
  | { type: 'setRailCollapsed'; collapsed: boolean }
  /** The rail's kinds, rearranged; null puts back the default. */
  | { type: 'setRailKinds'; kinds: string[] | null }
  | { type: 'setRailMore'; open: boolean }
  /** A table's columns were moved, resized, shown or hidden; null resets them. */
  | { type: 'setColumnLayout'; kind: string; layout: ColumnLayout | null }
  | { type: 'describe'; kind: string; name: string; namespace?: string }
  /** The events section of the details tab: what happened to this one object. */
  | { type: 'events'; kind: string; name: string; namespace?: string }
  /**
   * The drawer's Logs tab: follow one container's log, or read its previous
   * instance's. `id` is the webview's, echoed on every chunk so output from a
   * stream it has since replaced can be told apart and dropped. An empty
   * container leaves kubectl to pick, as it does in the terminal.
   */
  | { type: 'streamLogs'; id: number; kind: string; name: string; namespace: string; container?: string; previous?: boolean }
  /** The Logs tab was closed, or moved on to another object. */
  | { type: 'stopLogs' }
  | {
      type: 'action';
      action: string;
      kind: string;
      name: string;
      namespace?: string;
      container?: string;
      /** Scale only: the count the row was showing, used as the prompt's default. */
      replicas?: number;
      /** Delete only: skip graceful termination. */
      force?: boolean;
    }
  /**
   * Deletes arrive already confirmed: the webview asks, since the native modal
   * cannot carry the Force checkbox.
   */
  | { type: 'deleteMany'; kind: string; targets: { name: string; namespace?: string }[]; force?: boolean }
  /** Cordon, uncordon or drain: node maintenance, for one node or a ticked set. */
  | { type: 'nodeAction'; action: 'cordon' | 'uncordon' | 'drain'; names: string[] }
  | {
      type: 'scaleMany';
      kind: string;
      /** `replicas` is the count each row was showing, for the prompt's default. */
      targets: { name: string; namespace?: string; replicas?: number }[];
    }
  /**
   * CronJob actions. Trigger starts a Job from one CronJob and is confirmed
   * here; suspend and resume flip `spec.suspend` on one or a ticked set.
   */
  | {
      type: 'cronJobAction';
      action: 'trigger' | 'suspend' | 'resume';
      targets: { name: string; namespace?: string }[];
    }
  /** A rollout restart, for one workload or a ticked set. Confirmed here. */
  | { type: 'restart'; kind: string; targets: { name: string; namespace?: string }[] }
  /**
   * The port-forward dialog opening: the ports the object declares, for it to
   * offer. `id` is the dialog's, echoed on the reply so an answer meant for a
   * dialog since closed or reopened can be told apart and dropped.
   */
  | { type: 'forwardPorts'; id: number; kind: string; name: string; namespace: string }
  /**
   * A port-forward the dialog has filled in, for one pod, service or workload.
   * A `local` of 0 asks for any free port. `name` is the port's name in the
   * spec, empty for one typed in. Answered with the same `id`, carrying the
   * reason when the forward could not start.
   */
  | {
      type: 'portForward';
      id: number;
      kind: string;
      name: string;
      namespace: string;
      ports: { remote: number; local: number; name: string }[];
      /** `--address`: `localhost`, or IP addresses, comma separated. */
      address: string;
      /** `--pod-running-timeout`, in seconds; absent leaves kubectl's minute. */
      timeout?: number;
      /** Open each forwarded port in the browser once it listens. */
      open: boolean;
    }
  /** One Secret key, decoded on demand: shown in the drawer, or copied unseen. */
  | { type: 'secretValue'; mode: 'reveal' | 'copy'; name: string; namespace: string; key: string }
  | { type: 'clearCache' }
  /** The "Preserve cache after updates" tick on the About page. */
  | { type: 'setPreserveCache'; preserve: boolean }
  /** The rail's Settings item: VS Code's settings editor, narrowed to Kubi's. */
  | { type: 'openSettings' }
  /**
   * "Show me the pods of this thing". The owner chain is resolved here rather
   * than in the webview because a Deployment does not own its pods directly —
   * the ReplicaSets in between are a kind the webview is not holding rows for
   * while the deployments table is open.
   */
  | { type: 'showOwned'; kind: string; name: string; namespace?: string }
  /** A Go to landed on a table without the object in it; said here, where toasts live. */
  | { type: 'goToMissing'; kind: string; name: string; namespace?: string }
  /**
   * The scope was dismissed in the view. Without this the panel would keep
   * re-resolving the owner set on every pod refresh and push it back, silently
   * re-narrowing a table the user had just widened.
   */
  | { type: 'clearScope' };

/**
 * Dashboards keyed by context name. Opening a context reuses its dashboard;
 * further ones for the same context are only opened on explicit request.
 */
export class DashboardPanel {
  /** Per context, ordered least to most recently focused. */
  private static readonly open = new Map<string, DashboardPanel[]>();
  static readonly viewType = 'kubi.dashboard';

  /** One store shared by every panel; it is backed by a single globalState key. */
  private static cacheInstance: DashboardCache | undefined;

  private static cache(context: vscode.ExtensionContext): DashboardCache {
    // Keyed by extension version, so an upgrade never replays payloads built by
    // an older `toRow`/`KINDS` — unless the user has asked for the cache to
    // survive updates. See the note in cache.ts.
    //
    // Read once, at the store's construction: the setting decides what an
    // upgrade inherits, which has already happened by the time anything could
    // be toggled, so re-reading it later would change nothing until the next
    // update anyway.
    DashboardPanel.cacheInstance ??= new DashboardCache(
      context.globalState,
      String(context.extension.packageJSON.version ?? '0'),
      vscode.workspace.getConfiguration('kubi').get<boolean>('preserveCacheAfterUpdates') ?? true
    );
    return DashboardPanel.cacheInstance;
  }

  private readonly disposables: vscode.Disposable[] = [];
  private namespace: string | undefined;
  private activeKind = 'overview';
  private refreshTimer: NodeJS.Timeout | undefined;
  /**
   * When the last sync of any kind settled — poll, manual refresh, kind
   * switch, or the reload after an action. The interval is measured from here,
   * so anything that just put fresh rows on screen postpones the next poll:
   * refreshing by hand and then being refreshed again a second later is the
   * setting not being honoured, whoever asked for the fetch.
   *
   * Seeded at construction because opening the panel is itself a sync: the
   * bootstrap load is about to run, and a zero here would make the first tick
   * instantly overdue and race it.
   */
  private lastSync = Date.now();
  /**
   * The workload the pods table is currently scoped to, if any. Held here and
   * re-resolved on every pod refresh because the owner set is not static: a
   * rollout creates a new ReplicaSet, and a scope resolved once would keep
   * showing only the pods of the old revision — making a deployment mid-update
   * look like it was losing pods.
   */
  private scopeTarget: { kind: string; name: string; namespace?: string } | undefined;
  /**
   * The owner set last sent for `scopeTarget`, so a re-resolve that comes back
   * identical — the steady state between rollouts — sends nothing.
   */
  private scopeOwners: string[] = [];
  private readonly cache: DashboardCache;
  /** Incremented per load so a slow fetch can't overwrite a newer one. */
  private loadToken = 0;
  /**
   * The load currently fetching, if any. A refresh slower than the poll
   * interval would otherwise have the next tick start on top of it, and
   * because each overlapping load spawns its own batch of kubectl processes,
   * the extra load makes the next one slower still — the overlap compounds
   * instead of clearing. A skipped tick costs one stale interval; the pile-up
   * never recovers on its own.
   *
   * This covers *every* load, not just the polled ones. A guard that only knew
   * about auto-refreshes still let a manual refresh — the button, a kind
   * switch, a focus change — run on top of a poll, and let repeated clicks
   * stack without limit; `loadToken` then discarded the results, but every
   * kubectl had already been spawned and was still running.
   */
  private inFlight: { token: number; kind: string; silent: boolean; abort: AbortController } | undefined;
  /**
   * Objects with a `kubectl edit` in flight, keyed by identity. Different
   * objects edit in parallel; a second edit of the *same* one is refused,
   * because kubectl edits the snapshot it took when the editor opened and the
   * one saved last would silently win.
   */
  private readonly editing = new Set<string>();
  /**
   * The last error message reported to the user per scope (a kind id, or
   * `bootstrap`). Auto-refresh runs every few seconds, so a cluster that is
   * down fails on every tick; without this, an unreachable context would bury
   * the editor under a toast per poll. The same message in the same scope is
   * shown once and then stays quiet until it changes or the scope recovers.
   */
  private readonly reported = new Map<string, string>();
  /**
   * The Logs tab's `kubectl logs`, if one is running. One per panel: the tab
   * belongs to the drawer, which shows one object at a time, so starting a
   * stream stops the one before it.
   */
  private logStream: k.LogStream | undefined;

  /**
   * Reveals the context's most recently focused dashboard, or opens one if
   * none is open. `another` skips the reuse and always opens a new one.
   */
  static show(
    context: vscode.ExtensionContext,
    contextName: string,
    contextInfo?: k.ContextInfo,
    another = false
  ): void {
    const existing = another ? [] : [...(DashboardPanel.open.get(contextName) ?? [])].reverse();
    for (const candidate of existing) {
      // `reveal` throws "Webview is disposed" on a panel VS Code has already
      // torn down. That happens whenever the map entry outlives the panel:
      // `onDidDispose` is delivered asynchronously, so between the panel dying
      // and the handler running, this entry still looks live. Reopening the
      // context in that window — the tab was just closed, or the whole window
      // was closed with the dashboard open — would otherwise throw out of a
      // command handler as an uncaught runtime error.
      try {
        candidate.panel.reveal(candidate.panel.viewColumn ?? vscode.ViewColumn.One);
        return;
      } catch {
        // The entry is stale. Drop it and try the next one, falling through to
        // a fresh panel rather than leaving the context permanently unopenable.
        candidate.dispose();
      }
    }
    const panel = vscode.window.createWebviewPanel(
      DashboardPanel.viewType,
      contextName,
      dashboardColumn(),
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: resourceRoots(context.extensionUri)
      }
    );
    DashboardPanel.track(new DashboardPanel(panel, context, contextName, contextInfo));
  }

  /** Records `panel` as its context's most recently focused dashboard. */
  private static track(panel: DashboardPanel): void {
    const list = (DashboardPanel.open.get(panel.contextName) ?? []).filter((p) => p !== panel);
    list.push(panel);
    DashboardPanel.open.set(panel.contextName, list);
  }

  /**
   * Adopts a panel VS Code recreated after a window reload. The frame comes
   * back on its own, but nothing else does: the options it was created with,
   * the extension's `open` map, and the context it was showing are all gone.
   *
   * `contextInfo` is re-resolved rather than left undefined because the About
   * panel reads the cluster, user and namespace off it — a revived panel
   * without it would show a dashboard that cannot say what it is pointed at.
   */
  static async revive(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, state: unknown): Promise<void> {
    const contextName =
      (state && typeof state === 'object' && typeof (state as { contextName?: unknown }).contextName === 'string'
        ? (state as { contextName: string }).contextName
        : undefined) ?? panel.title;
    if (!contextName) {
      panel.dispose();
      return;
    }
    // `webview.options` are not restored, so scripts and the media root have to
    // be granted again before the html is set. The panel-level options
    // (`retainContextWhenHidden`) are carried over by VS Code and are readonly
    // here, which is why only the webview half is reapplied.
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: resourceRoots(context.extensionUri)
    };
    // `revive` awaits kubectl below, and the panel can be closed in the
    // meantime — constructing against a disposed panel throws on the first
    // property set, and would leave a stale `open` entry blocking reopen.
    let closed = false;
    const watch = panel.onDidDispose(() => {
      closed = true;
    });
    let info: k.ContextInfo | undefined;
    try {
      info = (await k.listContexts()).find((c) => c.name === contextName);
    } catch {
      // kubeconfig unreadable; the panel still opens and surfaces the failure
      // on its first load like any other unreachable context.
    }
    watch.dispose();
    if (closed) {
      return;
    }
    // The `closed` flag above covers disposal this function observed. Setting
    // `iconPath` and `html` in the constructor throws "Webview is disposed" on
    // a panel that went away without that listener seeing it, so the
    // construction is guarded too rather than throwing out of `revive` and
    // leaving the restored tab dead with no way to reopen it.
    let revived: DashboardPanel;
    try {
      revived = new DashboardPanel(panel, context, contextName, info);
    } catch {
      return;
    }
    DashboardPanel.track(revived);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extension: vscode.ExtensionContext,
    private readonly contextName: string,
    private readonly contextInfo: k.ContextInfo | undefined
  ) {
    this.cache = DashboardPanel.cache(extension);
    // Namespace selection is remembered per context.
    this.namespace = extension.workspaceState.get<string>(this.stateKey());
    // So does the open page, so a reload comes back where it was left. A kind
    // stored by an older version may no longer exist; fall back to the overview
    // rather than asking for a kind nothing can render.
    const savedKind = extension.workspaceState.get<string>(this.kindStateKey());
    if (savedKind && isKnownKind(savedKind)) {
      this.activeKind = savedKind;
    }
    this.panel.iconPath = vscode.Uri.joinPath(extension.extensionUri, 'media', 'icon-tab.svg');
    this.panel.webview.html = this.html();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    // Usage history is polled per context while any dashboard is open on it,
    // picking up from the rows an earlier session cached.
    const metrics = metricsFor(contextName);
    metrics.seed('nodes', this.cache.get(this.cacheKey('nodes'))?.payload);
    metrics.seed('pods', this.cache.get(this.cacheKey('pods'))?.payload);
    this.disposables.push(metrics.retain());
    this.panel.webview.onDidReceiveMessage((m: Inbound) => this.onMessage(m), null, this.disposables);
    // Polling pauses while the panel is out of sight, so coming back to it would
    // otherwise show rows as old as the time spent away until the next tick.
    // Refreshing on the way back makes that wait the one case it isn't:
    // returning to the dashboard is exactly when the data is being looked at.
    // It also restarts the countdown, so a tick already due cannot land on top
    // of the rows this just fetched.
    this.panel.onDidChangeViewState(() => {
      // Clicking the context in the sidebar goes back to the dashboard used last.
      if (this.panel.active) {
        DashboardPanel.track(this);
      }
      this.onFocusRefresh();
    }, null, this.disposables);
    // A panel stays `visible` while the whole window sits in the background, so
    // without this the dashboard polls on behind another app. Window focus is
    // the other half of `isAttended`, and it changes without any view-state
    // event, so it needs its own subscription into the same resume path.
    this.disposables.push(vscode.window.onDidChangeWindowState(() => this.onFocusRefresh()));

    this.applyAutoRefresh();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('kubi.autoRefreshSeconds')) {
          this.applyAutoRefresh();
        }
        // The About page draws this setting, and it can be changed from VS
        // Code's own settings UI or from another panel's tick, neither of which
        // passes through the handler that drew it.
        if (e.affectsConfiguration('kubi.preserveCacheAfterUpdates')) {
          this.postCacheStats();
        }
        // Applied to open dashboards as it changes, so trying it out needs no
        // reload.
        if (e.affectsConfiguration('kubi.dragToSelect')) {
          this.post({ type: 'dragToSelect', enabled: dragToSelect() });
        }
        if (e.affectsConfiguration('kubi.tableSparklines')) {
          this.post({ type: 'tableSparklines', enabled: tableSparklines() });
        }
      })
    );
  }

  /** The user's rail, or undefined while it is the default. See RAIL_KINDS_KEY. */
  private railKinds(): string[] | undefined {
    const stored = this.extension.globalState.get<unknown>(RAIL_KINDS_KEY);
    return Array.isArray(stored) ? knownKinds(stored) : undefined;
  }

  private stateKey(): string {
    return `kubi.namespace:${this.contextName}`;
  }

  private kindStateKey(): string {
    return `kubi.kind:${this.contextName}`;
  }

  /**
   * Idempotent: `onDidDispose` runs it, and `show` runs it directly when it
   * finds a map entry whose panel is already gone.
   */
  private dispose(): void {
    // Removes only this panel's own entry, so one disposed late cannot evict
    // the other dashboards open on the same context.
    const list = DashboardPanel.open.get(this.contextName)?.filter((p) => p !== this) ?? [];
    if (list.length) {
      DashboardPanel.open.set(this.contextName, list);
    } else {
      DashboardPanel.open.delete(this.contextName);
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    // Nothing is left to receive the rows, so the processes fetching them are
    // pure waste — a closed panel shouldn't keep a slow cluster busy.
    this.inFlight?.abort.abort();
    this.inFlight = undefined;
    this.stopLogs();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  /** Identity of an object within this panel's context. */
  private static editKey(kind: string, name: string, namespace?: string): string {
    return `${kind}\u0000${namespace ?? ''}\u0000${name}`;
  }

  private setEditing(key: string, active: boolean): void {
    if (active) {
      this.editing.add(key);
    } else {
      this.editing.delete(key);
    }
    this.post({ type: 'editing', editing: [...this.editing] });
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  /**
   * Surfaces a kubectl or sync failure as an editor notification, on top of the
   * in-page banner. The banner is easy to miss — an auto-refresh can fail while
   * the panel sits in a background tab, and the rows on screen stay there
   * looking current — so the failure is also raised where the user is actually
   * looking.
   *
   * De-duplicated per scope: repeating the same message every poll is noise,
   * not information. A changed message is a changed situation and is shown
   * again; `clearError` is what re-arms a scope once it recovers.
   */
  private notifyError(scope: string, message: string): void {
    if (this.reported.get(scope) === message) {
      return;
    }
    this.reported.set(scope, message);
    const label = scope === 'bootstrap' ? this.contextName : `${this.contextName}/${scope}`;
    void vscode.window.showErrorMessage(`Kubi: ${label}: ${message}`);
  }

  /** Re-arms a scope after a good fetch, so the next failure is reported again. */
  private clearError(scope: string): void {
    this.reported.delete(scope);
  }

  /**
   * A view-state change refreshes only if the rows are actually old enough to
   * be worth refetching, then restarts the countdown either way.
   *
   * Focus events are far more frequent than the interval — every click back
   * into the panel is one — so refreshing unconditionally is its own version
   * of ignoring the setting: alt-tabbing twice would fetch twice, seconds
   * apart. Waiting out the remaining interval keeps the guarantee the setting
   * makes, while still refreshing on the return that matters, the one after
   * time away.
   */
  private onFocusRefresh(): void {
    if (!this.isAttended() || !this.syncDue()) {
      return;
    }
    this.autoRefresh();
  }

  /**
   * Whether anyone is actually looking at this panel.
   *
   * Two conditions, because either one alone leaks polling. `panel.visible` is
   * scoped to the window: it says the dashboard is the tab in front of its
   * editor group, and stays true while that whole window sits behind another
   * app. `window.state.focused` says VS Code has the OS focus, but says
   * nothing about which tab is in front. A dashboard is being read only when
   * both hold.
   *
   * `visible` rather than `active`, which also requires keyboard focus: a
   * dashboard kept open in a second group beside the code being edited is on
   * screen and being watched, and it went stale the moment the cursor moved to
   * the other group.
   */
  private isAttended(): boolean {
    return this.panel.visible && vscode.window.state.focused;
  }

  /** Records a completed sync and restarts the countdown from it. */
  private noteSync(): void {
    this.lastSync = Date.now();
    this.armAutoRefresh();
  }

  /** Whether a full interval has passed since the last sync of any kind. */
  private syncDue(): boolean {
    const ms = this.intervalMs();
    return ms > 0 && Date.now() - this.lastSync >= ms;
  }

  /**
   * One unattended refresh, skipped unless the panel is worth refreshing.
   *
   * `isAttended` rather than `visible` alone: a panel in a window that has
   * been alt-tabbed away from stays visible while nobody is reading it, and
   * polling every open cluster in the background is how a dozen dashboards
   * quietly become a dozen kubectl invocations every few seconds. A panel
   * behind another tab is not visible, so it is skipped either way.
   *
   * The overlap guard itself lives in `load`, which every path goes through.
   * A tick arriving while anything is still fetching is simply dropped: the
   * fetch already running is about to deliver the same rows.
   *
   * The countdown is driven by `noteSync`, which every finished sync calls —
   * this poll, a manual refresh, a kind switch, the reload after an action —
   * so the interval is time since the rows were last fetched by anyone, not
   * time since the last tick. A fixed-grid timer measured the wrong thing
   * twice over: a fetch outlasting a tick swallowed it and the next landed the
   * moment the rows arrived, and a manual refresh didn't delay the poll that
   * was already due behind it.
   */
  private autoRefresh(): void {
    if (!this.isAttended() || this.inFlight) {
      // Still a tick: re-arm so polling survives the skip. A panel that is
      // hidden or in an unfocused window keeps its timer running, and the
      // view-state and window-state handlers refresh on the way back in.
      this.armAutoRefresh();
      return;
    }
    if (!this.syncDue()) {
      // Something else synced after this timer was armed — a manual refresh, a
      // kind switch, the reload after an action — so the rows are younger than
      // the interval. Wait out the remainder instead of refetching them.
      this.armAutoRefresh();
      return;
    }
    // `load` stamps the sync and re-arms the timer on its way out, for this
    // tick exactly as for a manual refresh.
    void this.load(this.activeKind, true);
  }

  /** Restarts the countdown from now, cancelling any pending tick. */
  private applyAutoRefresh(): void {
    this.armAutoRefresh();
  }

  /**
   * Schedules the next tick for when the interval will have elapsed since the
   * last sync, cancelling any pending one.
   *
   * The delay is the *remaining* time rather than a full interval, so a tick
   * that arrives early and defers doesn't push the next one a whole interval
   * further out — deferring repeatedly would otherwise starve polling on a
   * panel that is refreshed by hand now and then.
   */
  private armAutoRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    const ms = this.intervalMs();
    if (ms > 0) {
      const remaining = Math.max(0, this.lastSync + ms - Date.now());
      this.refreshTimer = setTimeout(() => this.autoRefresh(), remaining);
    }
  }

  /** The configured gap between refreshes, or 0 when polling is off. */
  private intervalMs(): number {
    const seconds = vscode.workspace.getConfiguration('kubi').get<number>('autoRefreshSeconds') ?? 5;
    return seconds > 0 ? Math.max(2, seconds) * 1000 : 0;
  }

  private async onMessage(message: Inbound): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.bootstrap();
        break;
      case 'load':
        await this.load(message.kind);
        break;
      case 'cancelLoad':
        this.cancelLoad();
        break;
      case 'setNamespace':
        // Purely a view preference: every fetch already spans all namespaces,
        // so the webview filters the rows it holds and nothing is re-fetched.
        this.namespace = message.namespace;
        await this.extension.workspaceState.update(this.stateKey(), message.namespace);
        break;
      case 'setRailCollapsed':
        // A layout preference rather than a per-cluster one, so it is global:
        // someone who wants the rail out of the way wants that everywhere.
        await this.extension.globalState.update(RAIL_COLLAPSED_KEY, message.collapsed);
        break;
      case 'setRailKinds': {
        // Global for the same reason: which kinds someone keeps to hand is
        // about the work they do, not about the cluster they are looking at.
        // Pushed to the other open dashboards too, so two side by side never
        // disagree about it.
        const kinds = message.kinds ? knownKinds(message.kinds) : undefined;
        const stored = kinds && !sameList(kinds, RAIL_DEFAULT) ? kinds : undefined;
        await this.extension.globalState.update(RAIL_KINDS_KEY, stored);
        for (const panel of [...DashboardPanel.open.values()].flat()) {
          if (panel !== this) panel.post({ type: 'railKinds', kinds: stored ?? null });
        }
        break;
      }
      case 'setRailMore':
        await this.extension.globalState.update(RAIL_MORE_KEY, message.open);
        break;
      case 'setColumnLayout': {
        // Global for the same reason again, and pushed to the other open
        // dashboards straight away like the rail's kinds: two tables of the
        // same kind side by side, laid out differently until one is reloaded,
        // would read as the change not having taken.
        const layouts = { ...this.extension.globalState.get<Record<string, ColumnLayout>>(COLUMN_LAYOUTS_KEY, {}) };
        if (message.layout) {
          layouts[message.kind] = message.layout;
        } else {
          delete layouts[message.kind];
        }
        await this.extension.globalState.update(COLUMN_LAYOUTS_KEY, layouts);
        for (const panel of [...DashboardPanel.open.values()].flat()) {
          if (panel !== this) panel.post({ type: 'columnLayouts', layouts });
        }
        break;
      }
      case 'describe':
        await this.describe(message);
        break;
      case 'events':
        await this.objectEvents(message);
        break;
      case 'streamLogs':
        this.streamLogs(message);
        break;
      case 'stopLogs':
        this.stopLogs();
        break;
      case 'action':
        await this.runAction(message);
        break;
      case 'deleteMany':
        await this.deleteMany(message);
        break;
      case 'nodeAction':
        await this.nodeAction(message);
        break;
      case 'cronJobAction':
        await this.cronJobAction(message);
        break;
      case 'scaleMany':
        await this.scaleMany(message);
        break;
      case 'restart':
        await this.restart(message);
        break;
      case 'forwardPorts':
        await this.forwardOptions(message);
        break;
      case 'portForward':
        await this.portForward(message);
        break;
      case 'secretValue':
        await this.secretValue(message);
        break;
      case 'clearCache':
        await this.clearCache();
        break;
      case 'setPreserveCache':
        // Global, like the store it governs: the cache spans every context and
        // every window, so a per-workspace value would mean the setting applied
        // or not depending on which folder happened to open the dashboard.
        await vscode.workspace
          .getConfiguration('kubi')
          .update('preserveCacheAfterUpdates', message.preserve, vscode.ConfigurationTarget.Global);
        break;
      case 'openSettings':
        await vscode.commands.executeCommand(
          'workbench.action.openSettings',
          `@ext:${this.extension.extension.id}`
        );
        break;
      case 'showOwned':
        await this.showOwned(message);
        break;
      case 'goToMissing': {
        const label = message.namespace ? `${message.namespace}/${message.name}` : message.name;
        vscode.window.showInformationMessage(
          `Kubi: ${kindById(message.kind)?.singular ?? message.kind} ${label} not found`
        );
        break;
      }
      case 'clearScope':
        this.scopeTarget = undefined;
        this.scopeOwners = [];
        break;
    }
  }

  private async bootstrap(): Promise<void> {
    // A reloaded webview has forgotten the stream it asked for, so nothing
    // would ever stop it and its output would go nowhere.
    this.stopLogs();
    this.post({
      type: 'init',
      kinds: KINDS,
      groups: GROUPS,
      context: this.contextName,
      allNamespaces: k.ALL_NAMESPACES,
      // The page this panel was last showing, so a reload repaints the rail on
      // it before the load below starts filling it in.
      active: this.activeKind,
      railCollapsed: this.extension.globalState.get<boolean>(RAIL_COLLAPSED_KEY, false),
      railDefault: RAIL_DEFAULT,
      railKinds: this.railKinds() ?? null,
      railMore: this.extension.globalState.get<boolean>(RAIL_MORE_KEY, false),
      columnLayouts: this.extension.globalState.get<Record<string, ColumnLayout>>(COLUMN_LAYOUTS_KEY, {}),
      dragToSelect: dragToSelect(),
      tableSparklines: tableSparklines(),
      extension: extensionInfo(this.extension.extension)
    });
    // A webview reload loses its state but not the kubectl processes behind it,
    // so edits in flight have to be replayed or their buttons come back enabled.
    if (this.editing.size) {
      this.post({ type: 'editing', editing: [...this.editing] });
    }
    try {
      if (!this.namespace) {
        this.namespace = this.defaultNamespace();
      }
      this.post({ type: 'namespace', namespace: this.namespace });
      // Replay the cached picker list before any network call so the namespace
      // the user last chose is selectable straight away.
      const nsKey = DashboardCache.key(this.contextName, 'namespaces', undefined);
      const cachedNamespaces = this.cache.get(nsKey);
      if (cachedNamespaces) {
        this.post({ type: 'namespaces', namespaces: cachedNamespaces.payload });
      }
      await this.load(this.activeKind);
      // Namespaces populate the picker but aren't needed to render; fetch after.
      try {
        const namespaces = await k.listNamespaces(this.contextName);
        this.cache.set(nsKey, namespaces);
        this.post({ type: 'namespaces', namespaces });
      } catch {
        // Listing namespaces can be forbidden by RBAC; the picker just stays short.
      }
    } catch (err) {
      const message = describeError(err);
      this.post({ type: 'fatal', message });
      this.notifyError('bootstrap', message);
    }
  }

  /**
   * Opens showing every namespace. A kubeconfig context namespace is usually an
   * artifact of the last `kubectl -n` (often `default` or `kube-system`) rather
   * than what someone wants to see first, and starting narrowed to it makes the
   * dashboard look empty. The picker is right there to filter it down.
   */
  private defaultNamespace(): string {
    return k.ALL_NAMESPACES;
  }

  /**
   * Cache key for a kind. Payloads always span every namespace, so the selected
   * namespace is not part of the identity — switching it reuses this entry.
   */
  private cacheKey(kindId: string): string {
    return DashboardCache.key(this.contextName, kindId, undefined);
  }

  /** Replays the last known payload for a kind so the view is never blank. */
  private postCached(kindId: string): boolean {
    const entry = this.cache.get(this.cacheKey(kindId));
    if (!entry) {
      return false;
    }
    // Each view names its own payload field; the webview reads them separately.
    const body =
      kindId === 'about' ? { type: 'about', about: entry.payload }
        : kindId === 'overview' ? { type: 'overview', overview: entry.payload }
          : { type: 'rows', rows: entry.payload };
    this.post({ ...body, kind: kindId, generated: entry.generated, stale: true });
    return true;
  }

  /**
   * Cache size travels as its own message rather than inside the About payload:
   * that payload is itself cached, so a replayed one would report the size the
   * store had when it was written — and would be wrong the moment anything else
   * was cached, including itself.
   */
  private postCacheStats(): void {
    // The preserve tick rides along: it is drawn in the same card, changes on
    // the same occasions, and is read from settings rather than held by the
    // webview, so it would otherwise need a message of its own that always
    // travelled beside this one.
    this.post({
      type: 'cacheStats',
      stats: this.cache.stats(),
      preserve: vscode.workspace.getConfiguration('kubi').get<boolean>('preserveCacheAfterUpdates') ?? true
    });
  }

  /**
   * Kinds whose pods hang one controller further down: the workload owns
   * ReplicaSets (Deployment) or Jobs (CronJob), and those own the pods. The
   * value is the intermediate kind to look through.
   */
  private static readonly OWNER_HOP: Record<string, { kind: string; owner: string }> = {
    deployments: { kind: 'replicasets', owner: 'Deployment' },
    cronjobs: { kind: 'jobs', owner: 'CronJob' }
  };

  /**
   * Scopes the pods table to one workload's pods, the way k9s does when you
   * press Enter on a Deployment.
   *
   * Matching is by ownerReference rather than by the workload's label
   * selector. A selector is a query anything can satisfy — two Deployments in
   * a namespace commonly share `app=foo` labels, and a bare `kubectl get pods
   * -l` would mix their pods together — whereas ownership is the actual parent
   * link, so a rollout in progress shows the old and new pods and nothing
   * else.
   */
  private async showOwned(target: { kind: string; name: string; namespace?: string }): Promise<void> {
    const resolved = await this.resolveOwners(target);
    if (resolved.error) {
      // The view stays where it is. Sending it to an unscoped pod table would
      // answer "show me this deployment's pods" with every pod in the cluster,
      // which is the wrong answer rather than a missing one — so the failure is
      // reported and nothing moves. The target is not retained either, or a
      // later refresh would resolve a scope the view never entered.
      this.scopeTarget = undefined;
      this.scopeOwners = [];
      vscode.window.showErrorMessage(
        `Kubi: could not list the pods of ${target.kind.replace(/s$/, '')} ${target.name}: ${resolved.error}`
      );
      return;
    }
    this.scopeTarget = target;
    this.scopeOwners = resolved.owners;
    this.post({
      type: 'scope',
      kind: 'pods',
      scope: { ...target, owners: resolved.owners, selector: resolved.selector }
    });
  }

  /**
   * Which owner names a pod of this workload may carry. For a StatefulSet,
   * DaemonSet, Job or ReplicaSet that is the workload itself; a Deployment and
   * a CronJob own their pods one controller further down, so their
   * intermediates are listed and their names collected.
   *
   * A Service owns nothing: its pods are whatever its selector matches, and
   * the names of those pods stand in for owners. They are listed with the
   * selector rather than matched in the view, which holds no pod labels.
   */
  private async resolveOwners(
    target: { kind: string; name: string; namespace?: string }
  ): Promise<{ owners: string[]; selector?: string; error?: string }> {
    if (target.kind === 'services') {
      return this.resolveSelected(target);
    }
    const hop = DashboardPanel.OWNER_HOP[target.kind];
    if (!hop) {
      return { owners: [target.name] };
    }
    try {
      const items = await k.list(hop.kind, this.contextName, target.namespace);
      // Both name and kind have to match: a ReplicaSet and a StatefulSet can
      // share a name in one namespace, and matching on the name alone would
      // pull the wrong workload's pods into the list.
      const owners = items
        .filter((item) => (item.metadata.ownerReferences ?? []).some(
          (ref) => ref.name === target.name && ref.kind === hop.owner
        ))
        .map((item) => item.metadata.name);
      return { owners };
    } catch (err) {
      // An empty owner set would read as "this workload has no pods", which is
      // a different and more misleading claim than saying the lookup failed.
      return { owners: [], error: describeError(err) };
    }
  }

  /** The names of the pods a Service's selector matches, for its scope. */
  private async resolveSelected(
    target: { kind: string; name: string; namespace?: string }
  ): Promise<{ owners: string[]; selector?: string; error?: string }> {
    try {
      // Read on every resolve rather than once: a selector edited while the
      // scope is open should move the pods with it, as a rollout does.
      const service = await k.getObject('services', target.name, this.contextName, target.namespace);
      const selector = Object.entries<string>(service.spec?.selector ?? {})
        .map(([key, value]) => `${key}=${value}`)
        .join(',');
      // No selector means no pods, not every pod — which is what `-l ''`
      // would list. Its endpoints are managed by hand, if at all.
      if (!selector) {
        return { owners: [], error: 'it has no selector, so it selects no pods' };
      }
      const pods = await k.list('pods', this.contextName, target.namespace, undefined, selector);
      return { owners: pods.map((pod) => pod.metadata.name), selector };
    } catch (err) {
      return { owners: [], error: describeError(err) };
    }
  }

  /**
   * Re-resolves the live scope after a pod refresh, and sends it on only when
   * the owner set has actually changed — a rollout adding a ReplicaSet — so a
   * poll against a settled deployment costs one list and no repaint.
   */
  private async refreshScope(): Promise<void> {
    const target = this.scopeTarget;
    if (!target) {
      return;
    }
    const resolved = await this.resolveOwners(target);
    // A failed re-resolve leaves the scope exactly as it is: the pods on screen
    // are still that workload's, and dropping the scope over one failed list
    // would silently widen the table to the whole cluster. A target that
    // changed under the await belongs to a different scope now.
    if (resolved.error || this.scopeTarget !== target) {
      return;
    }
    // Nothing is sent while the owner set is unchanged, which is the steady
    // state: the webview repaints the table on this message, and a repaint
    // every few seconds would fight the scroll position and the filter box for
    // no new information.
    if (sameOwners(this.scopeOwners, resolved.owners)) {
      return;
    }
    this.scopeOwners = resolved.owners;
    this.post({
      type: 'scope',
      kind: 'pods',
      scope: { ...target, owners: resolved.owners, selector: resolved.selector },
      // Nothing about the view changes but the owner set, so the webview keeps
      // its filters, selection and scroll rather than re-entering the scope.
      update: true
    });
  }

  /**
   * One load, and the only way a fetch starts.
   *
   * At most one runs at a time. A request arriving while another is in flight
   * either supersedes it — killing its kubectl processes first, so the two
   * never overlap — or is dropped as redundant:
   *
   *  - same kind, and the one running is not silent: dropped. The spinner on
   *    screen already reports the fetch that will answer this, and a poll
   *    dropped against a manual refresh leaves it running rather than
   *    flickering the toolbar off and on.
   *  - anything else (a different kind, or a user refresh over a poll): the
   *    running one is cancelled and replaced. A kind switch makes its rows
   *    irrelevant, and an explicit refresh is a request for *new* data, which
   *    a poll that started earlier will not deliver.
   */
  private async load(kindId: string, silent = false): Promise<void> {
    const running = this.inFlight;
    if (running) {
      if (running.kind === kindId && (silent || !running.silent)) {
        return;
      }
      // Supersede it. Cancelling is what keeps this a guard rather than a
      // queue: without it the processes outlive the load that wanted them.
      running.abort.abort();
      if (running.kind !== kindId) {
        this.post({ type: 'busy', kind: running.kind, busy: false });
      }
      this.inFlight = undefined;
    }

    if (kindId !== this.activeKind) {
      this.activeKind = kindId;
      void this.extension.workspaceState.update(this.kindStateKey(), kindId);
      // A scope belongs to the pods table; leaving it abandons the scope, and
      // holding the target would have a later return to pods silently
      // re-narrow the view. Switching *to* pods must not clear it: a drill-down
      // sets the target and the webview's load for pods arrives right after.
      if (kindId !== 'pods') {
        this.scopeTarget = undefined;
        this.scopeOwners = [];
      }
    }
    const token = ++this.loadToken;
    const abort = new AbortController();
    this.inFlight = { token, kind: kindId, silent, abort };
    if (!silent) {
      // Paint whatever we last saw, then refresh behind the toolbar spinner. A
      // silent auto-refresh skips the replay: the view already holds fresher
      // data than the cache does.
      this.postCached(kindId);
    }
    // The spinner is not skipped, though. An unattended refresh spawns the
    // same kubectl calls as a clicked one and takes just as long, so leaving
    // the toolbar idle only hid that the rows were mid-fetch — and left the
    // Refresh button live to start a second one on top of it.
    this.post({ type: 'busy', kind: kindId, busy: true, silent });
    try {
      if (kindId === 'about') {
        await this.loadAbout(token, abort.signal);
      } else if (kindId === 'overview') {
        await this.loadOverview(token, abort.signal);
      } else {
        await this.loadKind(kindId, token, abort.signal);
      }
    } catch (err) {
      // A cancelled load is a decision, not a failure; the load that replaced
      // it owns the view now.
      if (!k.isCancelled(err)) {
        throw err;
      }
    } finally {
      if (this.inFlight?.token === token) {
        this.inFlight = undefined;
      }
      // Only clear the spinner if this load still owns it — a newer one that
      // superseded this has already turned it back on for itself.
      if (token === this.loadToken) {
        this.post({ type: 'busy', kind: kindId, busy: false });
        // Same ownership test for the poll clock: this load put the rows on
        // screen, so the next poll is due a full interval from now. A
        // superseded load must not stamp — the one that replaced it is still
        // fetching, and its own completion is what the interval should run
        // from.
        this.noteSync();
      }
    }
  }

  /**
   * Stops whatever is fetching and leaves the cached rows on screen. Escape in
   * the webview lands here — a refresh against a slow or unreachable cluster
   * can sit there for the full 30s timeout, and waiting it out was the only
   * option.
   */
  private cancelLoad(): void {
    const running = this.inFlight;
    if (!running) {
      return;
    }
    running.abort.abort();
    this.inFlight = undefined;
    // Retire the token as well. The cancelled load's own `finally` still runs
    // whenever its kubectl actually dies, and without this it would match
    // `loadToken` and clear the spinner belonging to whatever load started in
    // the meantime.
    this.loadToken++;
    // The rows already on screen are now the newest thing there is, so the
    // view is told the fetch is over and they are stale rather than pending.
    this.post({ type: 'busy', kind: running.kind, busy: false });
    this.post({ type: 'cancelled', kind: running.kind });
  }

  /**
   * The lists a kind's rows are judged against; see `REFERENCES`. Read beside
   * the kind's own list. One that fails — most often a role that may not list
   * roles — is left out rather than failing the table, and the checks that
   * need it are skipped; only a cancellation propagates.
   */
  private async listReferences(kindId: string, signal: AbortSignal): Promise<Refs> {
    const wanted = REFERENCES[kindId] ?? [];
    const lists = await Promise.all(
      wanted.map(async (id) => {
        try {
          const meta = kindById(id);
          return await k.list(id, this.contextName, meta?.namespaced ? k.ALL_NAMESPACES : undefined, signal);
        } catch (err) {
          if (k.isCancelled(err)) {
            throw err;
          }
          return undefined;
        }
      })
    );
    const refs: Refs = {};
    wanted.forEach((id, index) => {
      const list = lists[index];
      if (list) {
        refs[id] = list;
      }
    });
    return refs;
  }

  private async loadKind(kindId: string, token: number, signal: AbortSignal): Promise<void> {
    const kind = kindById(kindId);
    if (!kind) {
      return;
    }
    const metrics = metricsFor(this.contextName);
    try {
      // Usage is read beside the list rather than after it, so the table waits
      // for the slower of the two instead of their sum. The metrics half never
      // fails the load, and costs nothing for kinds metrics-server does not
      // report on; see `refresh`.
      const [items, refs] = await Promise.all([
        k.list(
          kind.id,
          this.contextName,
          kind.namespaced ? k.ALL_NAMESPACES : undefined,
          signal
        ),
        this.listReferences(kind.id, signal),
        metrics.refresh(kind.id)
      ]);
      if (token !== this.loadToken) {
        return;
      }
      // A log is ordered by time; everything else reads as an inventory.
      const rows = items
        .map((item) => metrics.decorate(kind.id, toRow(kind.id, item, refs), item))
        .sort(kindId === 'events' ? byNewest : byNamespaceThenName);
      const generated = Date.now();
      this.cache.set(this.cacheKey(kindId), rows, generated);
      this.post({ type: 'rows', kind: kindId, rows, generated });
      this.clearError(kindId);
      // The rows are on screen; the scope that filters them is refreshed after
      // them, so a rollout's new ReplicaSet starts counting as soon as its
      // pods appear.
      if (kindId === 'pods') {
        await this.refreshScope();
      }
    } catch (err) {
      // A cancelled fetch is not a failure to report: the rows already on
      // screen stand, and an error banner would claim the cluster was at fault.
      if (k.isCancelled(err)) {
        return;
      }
      if (token === this.loadToken) {
        const message = describeError(err);
        this.post({ type: 'error', kind: kindId, message });
        this.notifyError(kindId, message);
      }
    }
  }

  /**
   * Builds the Overview: the pods that are not healthy right now, and every
   * Warning event the cluster is currently holding, across all namespaces.
   *
   * Kubernetes has no severity beyond `type`, which is only ever `Normal` or
   * `Warning` — there is no "Error" tier to ask for — so a Warning is the whole
   * of what the API server will tell you went wrong, and the filter is applied
   * here rather than in the query: `kubectl get events` has no server-side type
   * selector worth relying on (`--field-selector type=Warning` is unsupported
   * on some versions and silently returns everything on others), so the full
   * list is fetched and narrowed locally.
   *
   * Pods are fetched whole rather than through a `--field-selector`, which can
   * only see `status.phase`: a crash-looping pod is `phase: Running` with a
   * container waiting in CrashLoopBackOff, so a phase filter would omit exactly
   * the failure this page exists to surface. The full list costs one request
   * either way, and it is the same request the Pods table makes — so its rows
   * are written to the Pods cache here, and opening Pods next paints from cache
   * instead of fetching the list a second time.
   *
   * The two lists are fetched in parallel: neither depends on the other, and
   * the page is only as quick as the slower of them.
   *
   * The events and pods tables' own rows are reused rather than a second shape
   * being invented: the same builders, the same cells, so a warning or a pod
   * reads identically on both pages and the age cell recomputes from `created`
   * the same way.
   */
  private async loadOverview(token: number, signal: AbortSignal): Promise<void> {
    try {
      // Pod usage is read here too, though the Overview draws none of it: the
      // pod rows are cached for the Pods page below, and rows without usage
      // would open that page with its CPU and memory columns missing until
      // its own fetch put them back.
      const metrics = metricsFor(this.contextName);
      const [items, podItems] = await Promise.all([
        k.list('events', this.contextName, k.ALL_NAMESPACES, signal),
        k.list('pods', this.contextName, k.ALL_NAMESPACES, signal),
        metrics.refresh('pods')
      ]);
      if (token !== this.loadToken) {
        return;
      }
      const rows = items
        .map((item) => toRow('events', item))
        .filter((row) => row.status === 'Warning')
        .sort(byNewest);

      // What the events are *about*, counted by reason, so a hundred rows of
      // the same BackOff read as one problem rather than a hundred. The newest
      // occurrence leads each group, which is what `rows` is already ordered by.
      const groups = new Map<string, { reason: string; count: number; rows: Row[] }>();
      for (const row of rows) {
        const reason = row.cells.reason || 'Unknown';
        const group = groups.get(reason) ?? { reason, count: 0, rows: [] };
        // `count` is the cluster's own repeat count, not the number of event
        // records: one BackOff event seen 400 times is 400 occurrences, and
        // reporting "1" would understate exactly the thing worth escalating.
        group.count += Number(row.cells.count || 1);
        group.rows.push(row);
        groups.set(reason, group);
      }

      // Every pod, built once. The whole list is what the Pods table shows, so
      // it is cached under that kind — the fetch has already been paid for, and
      // leaving it unsaved would have the Pods page repeat it.
      const podRows = podItems
        .map((item) => metrics.decorate('pods', toRow('pods', item), item))
        .sort(byNamespaceThenName);

      // `muted` is a pod that finished its work — a completed Job's pod is not
      // a problem, and listing it here would bury the ones that are. `warn`
      // covers the pods still on their way up (ContainerCreating, Pending);
      // they are worth showing because a pod that has been "Pending" for an
      // hour is a failure, but they sort below the outright broken ones.
      const pods = podRows
        .filter((row) => row.health === 'bad' || row.health === 'warn')
        .sort((a, b) =>
          (a.health === b.health ? 0 : a.health === 'bad' ? -1 : 1) || byNamespaceThenName(a, b)
        );

      const overview = {
        rows,
        pods,
        // What "all pods" was, so the page can say "3 of 210" rather than
        // reporting a bare count that means nothing without the denominator.
        podTotal: podRows.length,
        groups: [...groups.values()].sort((a, b) => b.count - a.count),
        // Namespaces with at least one warning or unhealthy pod, so the page
        // can say where the trouble is without the reader scanning every row.
        namespaces: [...new Set(
          [...rows, ...pods].map((row) => row.namespace).filter(Boolean)
        )].sort(),
        // Distinguishes "the cluster is quiet" from "the cluster keeps no
        // events": a cluster whose event TTL has expired everything reports
        // zero of both, and the page says so rather than claiming all is well.
        total: items.length
      };
      const generated = Date.now();
      this.cache.set(this.cacheKey('overview'), overview, generated);
      // Both payloads came out of the same pair of fetches, so they carry the
      // same timestamp: the Pods page must not claim its rows are fresher (or
      // staler) than the Overview they were built alongside.
      this.cache.set(this.cacheKey('pods'), podRows, generated);
      this.post({ type: 'overview', kind: 'overview', overview, generated });
      this.clearError('overview');
    } catch (err) {
      if (k.isCancelled(err)) {
        return;
      }
      if (token === this.loadToken) {
        const message = describeError(err);
        this.post({ type: 'error', kind: 'overview', message });
        this.notifyError('overview', message);
      }
    }
  }

  /**
   * Builds the About view: who kubectl is talking to, as whom, and whether the
   * two versions are compatible, and which kubectl plugins are enabled.
   * Identity, versions and plugins are fetched independently — `auth whoami` is
   * unavailable on clusters older than 1.27 and can be denied by RBAC, neither
   * of which should cost the version report.
   */
  private async loadAbout(token: number, signal: AbortSignal): Promise<void> {
    // Sent before the fetches rather than after: the cache card is the one part
    // of this page that owes nothing to kubectl, and a cluster — or a kubectl —
    // that cannot be reached is exactly when clearing a stale cache is wanted.
    this.postCacheStats();
    const [versions, identity, plugins] = await Promise.all([
      k.versions(this.contextName, signal),
      k.whoAmI(this.contextName, signal).then(
        (who) => ({ who }),
        (err) => {
          // A cancel stops the page; anything else is just an identity the
          // cluster wouldn't tell us, which the card reports on its own.
          if (k.isCancelled(err)) {
            throw err;
          }
          return { error: describeError(err) };
        }
      ),
      // A kubectl too old to have `plugin list` fails here; the rest of the
      // page is unaffected, so the card explains itself instead.
      k.listPlugins().then(
        (list) => ({ plugins: list }),
        (err) => ({ pluginsError: describeError(err) })
      )
    ]);
    if (token !== this.loadToken || signal.aborted) {
      return;
    }
    const about = {
      context: this.contextName,
      cluster: this.contextInfo?.cluster ?? '',
      user: this.contextInfo?.user ?? '',
      namespace: this.contextInfo?.namespace ?? '',
      client: versions.client,
      server: versions.server,
      serverError: versions.serverError,
      skew: skew(versions),
      ...identity,
      ...plugins
    };
    const generated = Date.now();
    // The server half being unreachable makes this a snapshot of a broken
    // connection, not a fact worth replaying into a later session.
    if (versions.server) {
      this.cache.set(this.cacheKey('about'), about, generated);
    }
    this.post({ type: 'about', kind: 'about', about, generated });
    // The identity and plugin cards explain their own failures in place, but an
    // unreachable server is the connection itself being down — the same thing
    // every other page would report, so it is raised the same way.
    if (versions.serverError) {
      this.notifyError('about', versions.serverError);
    } else {
      this.clearError('about');
    }
    // Again, now that the writes above have landed, so the figure counts what
    // this load itself stored rather than the size it found on arrival.
    this.postCacheStats();
  }

  /**
   * Empties the cache for every context, not just this one: it is offered on a
   * page about the extension rather than about the cluster, and someone
   * clearing it is reclaiming the storage or discarding stale data everywhere.
   *
   * Other open panels keep whatever they are already showing — the cache only
   * feeds the first paint — so nothing needs to be told about this beyond the
   * panel the button was clicked in.
   */
  private async clearCache(): Promise<void> {
    const { entries, bytes } = this.cache.stats();
    if (!entries) {
      return;
    }
    const confirmed = await vscode.window.showWarningMessage(
      `Clear the Kubi cache for all contexts?`,
      {
        modal: true,
        detail: `${entries} cached ${entries === 1 ? 'view' : 'views'} (${formatBytes(bytes)}) will be discarded.\n\nNothing in any cluster is affected — dashboards will just fetch from scratch instead of opening with their last known contents.`
      },
      'Clear cache'
    );
    if (confirmed !== 'Clear cache') {
      return;
    }
    this.cache.clearAll();
    this.postCacheStats();
    vscode.window.showInformationMessage('Kubi: cache cleared');
  }

  /**
   * Fetches describe output for the details panel, replaying the last known text first
   * so reselecting a row shows something immediately instead of a spinner. The
   * reply echoes the identity it was asked about so the webview can drop a slow
   * answer for a row that is no longer selected, and errors come back as text
   * rather than a popup because the panel has somewhere to show them.
   */
  private async describe(message: Extract<Inbound, { type: 'describe' }>): Promise<void> {
    const { kind, name, namespace } = message;
    const reply = { type: 'describe', kind, name, namespace };
    // Unlike the row lists, this is per-object, so the name is part of the key.
    const key = DashboardCache.key(this.contextName, `describe ${kind} ${name}`, namespace);
    const cached = this.cache.get(key);
    if (cached) {
      this.post({ ...reply, text: cached.payload, generated: cached.generated, stale: true });
    }
    try {
      const text = await k.describe(kind, name, this.contextName, namespace) || '(empty)';
      const generated = Date.now();
      this.cache.set(key, text, generated);
      this.post({ ...reply, text, generated });
    } catch (err) {
      // With cached text on screen, a failed refresh is a footnote, not a
      // replacement: the webview keeps the text and notes the staleness.
      this.post({ ...reply, error: describeError(err) });
    }
  }

  /**
   * The events one object is the subject of, for the details tab. Built with
   * the same `toRow('events', …)` the Events table and the Overview use, so a
   * warning reads identically wherever it is shown and its age cell ticks the
   * same way.
   *
   * Cached and replayed like describe: reselecting a row paints its history at
   * once and refreshes behind it. Newest first — an event list is read from the
   * top, and the most recent one is the reason the row was opened.
   */
  private async objectEvents(message: Extract<Inbound, { type: 'events' }>): Promise<void> {
    const { kind, name, namespace } = message;
    const reply = { type: 'events', kind, name, namespace };
    const key = DashboardCache.key(this.contextName, `events ${kind} ${name}`, namespace);
    const cached = this.cache.get(key);
    if (cached) {
      this.post({ ...reply, rows: cached.payload, generated: cached.generated, stale: true });
    }
    try {
      const items = await k.eventsFor(name, this.contextName, namespace);
      const rows = items.map((item) => toRow('events', item)).sort(byNewest);
      const generated = Date.now();
      this.cache.set(key, rows, generated);
      this.post({ ...reply, rows, generated });
    } catch (err) {
      this.post({ ...reply, error: describeError(err) });
    }
  }

  /**
   * Streams one container's log into the drawer's Logs tab. Timestamps are
   * always asked for and the webview shows or hides them, so toggling them is
   * instant rather than a refetch that loses the scrollback.
   *
   * Output is batched before it is posted: a busy container writes thousands
   * of lines a second, and a message per chunk would flood the webview with
   * renders it cannot keep up with.
   */
  private streamLogs(message: Extract<Inbound, { type: 'streamLogs' }>): void {
    this.stopLogs();
    const { id, kind, name, namespace, container, previous } = message;
    const args = [
      terminalTarget(kind, name), '-n', namespace,
      ...(container ? ['-c', container] : []),
      '--tail', String(LOG_TAIL), '--timestamps',
      // A previous instance's log is complete the moment it is read, so it is
      // fetched rather than followed, as in the terminal.
      ...(previous ? ['-p'] : ['-f'])
    ];
    let pending = '';
    let timer: NodeJS.Timeout | undefined;
    const flush = () => {
      timer = undefined;
      if (!pending) return;
      this.post({ type: 'logText', id, text: pending });
      pending = '';
    };
    const stream = k.streamLogs(args, this.contextName, (text) => {
      pending += text;
      timer ??= setTimeout(flush, LOG_FLUSH_MS);
    }, (error) => {
      clearTimeout(timer);
      flush();
      if (this.logStream === handle) {
        this.logStream = undefined;
      }
      this.post({ type: 'logEnd', id, error });
    });
    const handle: k.LogStream = {
      stop: () => {
        clearTimeout(timer);
        stream.stop();
      }
    };
    this.logStream = handle;
  }

  private stopLogs(): void {
    this.logStream?.stop();
    this.logStream = undefined;
  }

  private async runAction(message: Extract<Inbound, { type: 'action' }>): Promise<void> {
    const { action, kind, name, namespace } = message;
    const ctx = this.contextName;
    try {
      switch (action) {
        case 'neat':
          await openDocument(await k.neatYaml(kind, name, ctx, namespace), 'yaml');
          break;
        case 'edit': {
          // The webview disables the button while an edit runs, but it can be
          // out of date, so the authoritative guard is here.
          const key = DashboardPanel.editKey(kind, name, namespace);
          if (this.editing.has(key)) {
            return;
          }
          const label = namespace ? `${namespace}/${name}` : name;
          this.setEditing(key, true);
          let cancelled: string | undefined;
          try {
            // kubectl holds the temp file open until the tab is closed, so this
            // awaits the user.
            const result = await k.edit(kind, name, ctx, namespace);
            cancelled = editCancelled(result);
            vscode.window.showInformationMessage(
              cancelled ? `Kubi: ${cancelled} (${label})` : `Kubi: edited ${label}`
            );
          } finally {
            this.setEditing(key, false);
          }
          // Nothing was applied on a cancel, so there is nothing to re-fetch.
          if (!cancelled) {
            await this.load(this.activeKind);
          }
          break;
        }
        case 'logs':
          if (namespace) {
            openLogs(terminalTarget(kind, name), ctx, namespace, message.container);
          }
          break;
        case 'logs-previous':
          if (namespace) {
            openLogs(terminalTarget(kind, name), ctx, namespace, message.container, true);
          }
          break;
        case 'shell':
          if (namespace) {
            openShell(terminalTarget(kind, name), ctx, namespace, message.container);
          }
          break;
        case 'scale': {
          await this.scale(message);
          break;
        }
        case 'delete': {
          const label = namespace ? `${namespace}/${name}` : name;
          await k.remove(kind, name, ctx, namespace, message.force);
          vscode.window.showInformationMessage(`Kubi: deleted ${label}`);
          await this.load(this.activeKind);
          break;
        }
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Kubi: ${describeError(err)}`);
    }
  }

  /**
   * Changes an object's replica count, asking for the number first.
   *
   * The prompt opens on the count the row was showing and validates as the user
   * types, so a bad value is refused at the box rather than coming back as a
   * kubectl error. Scaling down to zero is confirmed separately: every other
   * scale is a capacity change, but zero stops the workload, and the input box
   * — unlike Delete — has no warning of its own to carry that.
   */
  private async scale(message: Extract<Inbound, { type: 'action' }>): Promise<void> {
    const { kind, name, namespace } = message;
    const ctx = this.contextName;
    const meta = kindById(kind);
    const singular = (meta?.singular ?? kind).toLowerCase();
    const label = namespace ? `${namespace}/${name}` : name;
    const current = message.replicas;

    const answer = await vscode.window.showInputBox({
      title: `Scale ${singular} ${label}`,
      prompt: `Replicas for "${label}" in context "${ctx}"`,
      value: current !== undefined ? String(current) : '',
      valueSelection: current !== undefined ? [0, String(current).length] : undefined,
      ignoreFocusOut: true,
      validateInput: (text) => {
        const trimmed = text.trim();
        if (!trimmed) {
          return 'Enter a replica count.';
        }
        // Integers only, and no sign: kubectl would reject "2.5" or "-1"
        // anyway, and a leading "+" silently parses as the positive number.
        if (!/^\d+$/.test(trimmed)) {
          return 'Replicas must be a whole number, 0 or greater.';
        }
        return undefined;
      }
    });
    if (answer === undefined) {
      return;
    }

    const replicas = Number(answer.trim());
    // Nothing to do, and a no-op scale would still churn the table.
    if (replicas === current) {
      return;
    }

    if (replicas === 0) {
      const confirmed = await vscode.window.showWarningMessage(
        `Scale ${singular} "${label}" to 0 in context "${ctx}"?`,
        {
          modal: true,
          detail: 'This stops every pod it runs.'
        },
        'Scale to 0'
      );
      if (confirmed !== 'Scale to 0') {
        return;
      }
    }

    await k.scale(kind, name, replicas, ctx, namespace);
    vscode.window.showInformationMessage(`Kubi: scaled ${label} to ${replicas}`);
    // The new count is in the spec immediately; the pods follow over the next
    // few seconds, which the table's own refresh picks up.
    await this.load(this.activeKind);
  }

  /**
   * Node maintenance on one node or several.
   *
   * Cordon and uncordon only flip `spec.unschedulable`, are undone by each
   * other, and run without asking. Drain evicts every pod on the node and can
   * sit for minutes on a PodDisruptionBudget, so it is confirmed first and run
   * in a terminal, where its progress is visible and Ctrl+C stops it.
   */
  private async nodeAction(message: Extract<Inbound, { type: 'nodeAction' }>): Promise<void> {
    const { action, names } = message;
    if (!names.length) {
      return;
    }
    const ctx = this.contextName;
    const noun = names.length === 1 ? `node "${names[0]}"` : `${names.length} nodes`;
    try {
      if (action === 'drain') {
        const list = names.length > 1 ? `${[...names].sort().join('\n')}\n\n` : '';
        const confirmed = await vscode.window.showWarningMessage(
          `Drain ${noun} in context "${ctx}"?`,
          {
            modal: true,
            detail: `${list}The node is cordoned and every pod on it is evicted. DaemonSet pods `
              + 'are left in place, and data in emptyDir volumes is lost.'
          },
          'Drain'
        );
        if (confirmed === 'Drain') {
          openDrain(names, ctx);
        }
        return;
      }
      await k.cordon(names, ctx, action === 'uncordon');
      vscode.window.showInformationMessage(`Kubi: ${action === 'cordon' ? 'cordoned' : 'uncordoned'} ${noun}`);
      await this.load(this.activeKind);
    } catch (err) {
      vscode.window.showErrorMessage(`Kubi: ${describeError(err)}`);
    }
  }

  /**
   * CronJob actions: run one now, or suspend and resume any number.
   *
   * Suspend and resume only flip `spec.suspend`, are undone by each other, and
   * run without asking, as cordon does. Trigger starts real work, so it is
   * confirmed first, and afterwards offers to jump to the Job it made or to that
   * Job's pods. It takes one CronJob: it is about the one you are looking at,
   * and a bulk trigger would be a burst of Jobs nobody could check first.
   *
   * Each CronJob is its own kubectl call, as with restart: a patch takes one
   * name, and a set spans namespaces.
   */
  private async cronJobAction(message: Extract<Inbound, { type: 'cronJobAction' }>): Promise<void> {
    const { action, targets } = message;
    if (!targets.length) {
      return;
    }
    const ctx = this.contextName;
    const labels = targets.map((t) => (t.namespace ? `${t.namespace}/${t.name}` : t.name));

    if (action === 'trigger') {
      const [target] = targets;
      const confirmed = await vscode.window.showWarningMessage(
        `Trigger cronjob "${labels[0]}" in context "${ctx}"?`,
        {
          modal: true,
          detail: 'A Job is created from the CronJob\'s template and runs now, on top of its schedule. '
            + 'It runs even if the CronJob is suspended.'
        },
        'Trigger now'
      );
      if (confirmed !== 'Trigger now') {
        return;
      }
      let job: string;
      try {
        job = await k.triggerCronJob(target.name, ctx, target.namespace);
      } catch (err) {
        vscode.window.showErrorMessage(`Kubi: ${describeError(err)}`);
        return;
      }
      await this.load(this.activeKind);
      // Not awaited: the toast stays up until it is dismissed, and this handler
      // has nothing left to do after it.
      void vscode.window
        .showInformationMessage(`Kubi: started job ${job} from ${labels[0]}`, 'Show Job', 'Show Pods')
        .then(async (choice) => {
          try {
            if (choice === 'Show Job') {
              this.post({ type: 'reveal', kind: 'jobs', name: job, namespace: target.namespace });
            } else if (choice === 'Show Pods') {
              await this.showOwned({ kind: 'jobs', name: job, namespace: target.namespace });
            }
          } catch {
            // The panel was closed while the toast was open; nothing to show it in.
          }
        });
      return;
    }

    const suspend = action === 'suspend';
    const verb = suspend ? 'suspended' : 'resumed';
    const noun = targets.length === 1 ? 'cronjob' : 'cronjobs';
    let done = 0;
    const failures: string[] = [];
    for (const [i, target] of targets.entries()) {
      try {
        await k.suspendCronJob(target.name, suspend, ctx, target.namespace);
        done += 1;
      } catch (err) {
        failures.push(`${labels[i]}: ${describeError(err)}`);
      }
    }
    if (failures.length) {
      vscode.window.showErrorMessage(
        targets.length === 1
          ? `Kubi: ${failures[0]}`
          : `Kubi: ${verb} ${done} of ${targets.length}; ${failures.join('; ')}`
      );
    } else {
      vscode.window.showInformationMessage(
        `Kubi: ${verb} ${targets.length === 1 ? `${noun} ${labels[0]}` : `${done} ${noun}`}`
      );
    }
    await this.load(this.activeKind);
  }

  /**
   * Deletes a checked set of rows, already confirmed by the webview's dialog.
   * One confirmation covers the whole set — a prompt per object would train
   * people to click through them — and it names what is about to go, because a
   * count alone is not something anyone can check their intent against.
   *
   * Objects are deleted a namespace at a time, so one kubectl call handles
   * each group, and a group that fails does not cancel the rest: a bulk delete
   * that stops halfway leaves the user guessing which half went. Whatever
   * failed is reported at the end.
   */
  private async deleteMany(message: Extract<Inbound, { type: 'deleteMany' }>): Promise<void> {
    const { kind, targets, force } = message;
    if (!targets.length) {
      return;
    }
    const ctx = this.contextName;
    const meta = kindById(kind);
    const noun = targets.length === 1
      ? (meta?.singular ?? kind).toLowerCase()
      : (meta?.label ?? kind).toLowerCase();

    const groups = new Map<string, { namespace?: string; names: string[] }>();
    for (const target of targets) {
      const key = target.namespace ?? '';
      const group = groups.get(key) ?? { namespace: target.namespace, names: [] };
      group.names.push(target.name);
      groups.set(key, group);
    }

    let deleted = 0;
    const failures: string[] = [];
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Kubi: deleting ${targets.length} ${noun}…` },
      async () => {
        for (const group of groups.values()) {
          try {
            await k.removeMany(kind, group.names, ctx, group.namespace, force);
            deleted += group.names.length;
          } catch (err) {
            failures.push(`${group.namespace ? `${group.namespace}: ` : ''}${describeError(err)}`);
          }
        }
      }
    );

    if (failures.length) {
      vscode.window.showErrorMessage(
        `Kubi: deleted ${deleted} of ${targets.length}; ${failures.join('; ')}`
      );
    } else {
      vscode.window.showInformationMessage(`Kubi: deleted ${deleted} ${noun}`);
    }
    // Refresh either way: a partial failure still changed the cluster.
    await this.load(this.activeKind);
  }

  /**
   * Sets one replica count across a checked set of rows.
   *
   * Asked once and applied to all of them: a prompt per object would be the
   * same click-through problem as a delete prompt per object, and "scale these
   * five to 3" is the thing people actually want from a multi-selection. The
   * box only opens on a current count when every row already agrees on one —
   * with a mixed selection there is no count that is the obvious default, and
   * pre-filling one of them would invite scaling the rest to a number that was
   * never chosen.
   *
   * Unlike a delete there is no confirmation for an ordinary scale, which
   * matches the single-row Scale…; zero is confirmed, for the same reason it is
   * there — it stops the workload and the input box carries no warning of its
   * own. Each object is its own kubectl call (`kubectl scale` takes one name
   * per invocation for a specific count), and a failure does not cancel the
   * rest: a bulk scale that stops halfway leaves the user guessing which half
   * moved.
   */
  private async scaleMany(message: Extract<Inbound, { type: 'scaleMany' }>): Promise<void> {
    const { kind, targets } = message;
    if (!targets.length) {
      return;
    }
    const ctx = this.contextName;
    const meta = kindById(kind);
    const singular = (meta?.singular ?? kind).toLowerCase();
    const noun = targets.length === 1 ? singular : (meta?.label ?? kind).toLowerCase();

    const labels = targets.map((t) => (t.namespace ? `${t.namespace}/${t.name}` : t.name)).sort();
    const shown = labels.slice(0, 10);
    const rest = labels.length - shown.length;
    const list = shown.join('\n') + (rest > 0 ? `\n…and ${rest} more` : '');

    const counts = new Set(targets.map((t) => t.replicas));
    const common = counts.size === 1 ? [...counts][0] : undefined;

    const answer = await vscode.window.showInputBox({
      title: `Scale ${targets.length} ${noun}`,
      prompt: `Replicas for ${targets.length} ${noun} in context "${ctx}"`,
      value: common !== undefined ? String(common) : '',
      valueSelection: common !== undefined ? [0, String(common).length] : undefined,
      ignoreFocusOut: true,
      validateInput: (text) => {
        const trimmed = text.trim();
        if (!trimmed) {
          return 'Enter a replica count.';
        }
        if (!/^\d+$/.test(trimmed)) {
          return 'Replicas must be a whole number, 0 or greater.';
        }
        return undefined;
      }
    });
    if (answer === undefined) {
      return;
    }

    const replicas = Number(answer.trim());
    // Every row is already there, so there is nothing to write.
    if (replicas === common) {
      return;
    }

    if (replicas === 0) {
      const confirmed = await vscode.window.showWarningMessage(
        `Scale ${targets.length} ${noun} to 0 in context "${ctx}"?`,
        {
          modal: true,
          detail: `${list}\n\nThis stops every pod they run.`
        },
        'Scale to 0'
      );
      if (confirmed !== 'Scale to 0') {
        return;
      }
    }

    let scaled = 0;
    const failures: string[] = [];
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Kubi: scaling ${targets.length} ${noun} to ${replicas}…`
      },
      async () => {
        for (const target of targets) {
          // Rows already at the requested count are skipped rather than
          // written: a no-op scale still churns the table.
          if (target.replicas === replicas) {
            scaled += 1;
            continue;
          }
          try {
            await k.scale(kind, target.name, replicas, ctx, target.namespace);
            scaled += 1;
          } catch (err) {
            const label = target.namespace ? `${target.namespace}/${target.name}` : target.name;
            failures.push(`${label}: ${describeError(err)}`);
          }
        }
      }
    );

    if (failures.length) {
      vscode.window.showErrorMessage(
        `Kubi: scaled ${scaled} of ${targets.length}; ${failures.join('; ')}`
      );
    } else {
      vscode.window.showInformationMessage(
        `Kubi: scaled ${scaled} ${noun} to ${replicas}`
      );
    }
    await this.load(this.activeKind);
  }

  /**
   * Replaces every pod of one workload or several through `kubectl rollout
   * restart`, after one confirmation for the whole set.
   *
   * It confirms even though nothing is removed: a rolling update keeps serving
   * throughout, but under `Recreate` every old pod stops before a new one
   * starts, and even a clean roll drops whatever the pods held in memory. The
   * panel does not know which of those it is about to trigger.
   *
   * Each object is its own kubectl call, as with scale. Given several names
   * kubectl carries on past one it cannot restart — a paused Deployment, most
   * often — but reports only the failure, so a grouped call could not say
   * which of the rest went through.
   */
  private async restart(message: Extract<Inbound, { type: 'restart' }>): Promise<void> {
    const { kind, targets } = message;
    if (!targets.length) {
      return;
    }
    const ctx = this.contextName;
    const meta = kindById(kind);
    const singular = (meta?.singular ?? kind).toLowerCase();
    const noun = targets.length === 1 ? singular : (meta?.label ?? kind).toLowerCase();

    const labels = targets.map((t) => (t.namespace ? `${t.namespace}/${t.name}` : t.name)).sort();
    const shown = labels.slice(0, 10);
    const rest = labels.length - shown.length;
    const list = targets.length > 1
      ? `${shown.join('\n')}${rest > 0 ? `\n…and ${rest} more` : ''}\n\n`
      : '';

    const rollout = await this.describeRollout(kind, targets, labels.length === 1);

    const confirmed = await vscode.window.showWarningMessage(
      targets.length === 1
        ? `Restart ${singular} "${labels[0]}" in context "${ctx}"?`
        : `Restart ${targets.length} ${noun} in context "${ctx}"?`,
      { modal: true, detail: `${list}${rollout}` },
      'Restart'
    );
    if (confirmed !== 'Restart') {
      return;
    }

    let restarted = 0;
    const failures: string[] = [];
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Kubi: restarting ${targets.length} ${noun}…` },
      async () => {
        for (const target of targets) {
          try {
            await k.restart(kind, target.name, ctx, target.namespace);
            restarted += 1;
          } catch (err) {
            const label = target.namespace ? `${target.namespace}/${target.name}` : target.name;
            failures.push(`${label}: ${describeError(err)}`);
          }
        }
      }
    );

    if (failures.length) {
      vscode.window.showErrorMessage(
        targets.length === 1
          ? `Kubi: ${failures[0]}`
          : `Kubi: restarted ${restarted} of ${targets.length}; ${failures.join('; ')}`
      );
    } else {
      vscode.window.showInformationMessage(
        `Kubi: restarted ${targets.length === 1 ? labels[0] : `${restarted} ${noun}`}`
      );
    }
    // Only the pod template has changed so far; the rollout plays out over the
    // next while, which the table's own refresh picks up.
    await this.load(this.activeKind);
  }

  /**
   * The confirmation's account of how the pods will be replaced, which differs
   * per kind. The update strategy is read from each object, since `OnDelete`
   * turns a restart into a no-op until the pods are deleted by hand; when an
   * object cannot be read the text falls back to the kind's usual behaviour,
   * because kubectl will report the real failure on its own.
   */
  private async describeRollout(
    kind: string,
    targets: { name: string; namespace?: string }[],
    single: boolean
  ): Promise<string> {
    const generic: Record<string, string> = {
      statefulsets: 'Pods are replaced one at a time, from the highest ordinal down, each waiting to be Ready '
        + 'before the next; a rollingUpdate maxUnavailable above 1 lets several go at once.',
      daemonsets: 'Pods are replaced node by node, following the update strategy; maxUnavailable sets how '
        + 'many nodes go at once.'
    };
    const base = generic[kind]
      ?? 'Every pod is replaced through a new rollout, paced by the update strategy. '
        + 'Under Recreate, the old pods all stop before any new one starts.';

    if (kind !== 'statefulsets' && kind !== 'daemonsets') {
      return base;
    }
    const ctx = this.contextName;
    const onDelete: string[] = [];
    await Promise.all(targets.map(async (target) => {
      try {
        const obj = await k.getObject(kind, target.name, ctx, target.namespace);
        if ((obj as any)?.spec?.updateStrategy?.type === 'OnDelete') {
          onDelete.push(target.namespace ? `${target.namespace}/${target.name}` : target.name);
        }
      } catch {
        // Fall back to the generic text; the restart itself reports the failure.
      }
    }));
    if (!onDelete.length) {
      return base;
    }
    onDelete.sort();
    const who = single ? 'This one uses' : `${onDelete.join(', ')} ${onDelete.length === 1 ? 'uses' : 'use'}`;
    return `${base}\n\nWarning: ${who} the OnDelete update strategy, so the restart changes the pod `
      + 'template but replaces nothing until its pods are deleted.';
  }

  /**
   * The ports the port-forward dialog offers, read off the object's spec. The
   * dialog is already open by the time this runs, and fills in on the reply.
   */
  private async forwardOptions(message: Extract<Inbound, { type: 'forwardPorts' }>): Promise<void> {
    const { id, kind, name, namespace } = message;
    try {
      const object = await k.getObject(kind, name, this.contextName, namespace);
      this.post({ type: 'forwardPorts', id, ports: forwardPorts(kind, object) });
    } catch (err) {
      this.post({ type: 'forwardPorts', id, error: describeError(err) });
    }
  }

  /**
   * Starts a forward the dialog has filled in, in a terminal named after the
   * command so that closing it is how the forward is stopped.
   *
   * The dialog checks what it can and this checks it again, since the message
   * is all the extension sees. Then it checks what only it can: that every
   * address is one this machine has, and every local port is free on them. A
   * local port of 0 is looked up here rather than left to kubectl, so the
   * address to open is known before the forward starts.
   *
   * The reply closes the dialog, or puts the reason under its fields for the
   * user to fix — `field` and `local` say which one, so nothing has to be
   * typed in again.
   */
  private async portForward(message: Extract<Inbound, { type: 'portForward' }>): Promise<void> {
    const { id, kind, name, namespace } = message;
    const fail = (error: string, at: { field?: 'address' | 'timeout'; local?: number } = {}) =>
      this.post({ type: 'portForward', id, error, ...at });
    try {
      const addresses = message.address.split(',').map((a) => a.trim()).filter(Boolean);
      const bad = addresses.find((a) => a !== 'localhost' && !net.isIP(a));
      if (!addresses.length || bad !== undefined) {
        fail(`${bad ? `"${bad}" is not an IP address. ` : ''}Listen on localhost or IP addresses, comma separated.`,
          { field: 'address' });
        return;
      }
      if (message.timeout !== undefined && !(Number.isInteger(message.timeout) && message.timeout > 0)) {
        fail('The pod timeout is a whole number of seconds.', { field: 'timeout' });
        return;
      }
      if (!message.ports.length) {
        fail('Tick a port to forward.');
        return;
      }
      const hosts = addresses.map(listenHost);
      for (const host of hosts) {
        // Port 0 always binds, so all this can fail on is the address itself.
        const problem = await listenProblem(host, 0);
        if (problem) {
          fail(problem, { field: 'address' });
          return;
        }
      }

      const pairs: ForwardPair[] = [];
      for (const port of message.ports) {
        if (!isPort(port.remote, 1) || !isPort(port.local, 0)) {
          fail('Ports run from 1 to 65535.');
          return;
        }
        let local = port.local;
        if (local === 0) {
          local = await freePort(hosts, pairs.map((p) => p.local));
        } else if (pairs.some((p) => p.local === local)) {
          fail(`Local port ${local} is given twice.`, { local });
          return;
        } else {
          for (const host of hosts) {
            const problem = await listenProblem(host, local);
            if (problem) {
              fail(problem, { local });
              return;
            }
          }
        }
        pairs.push({ local, remote: port.remote, https: looksHttps(port.remote, port.name) });
      }

      const terminal = openPortForward(
        forwardTarget(kind, name), pairs, addresses, message.timeout, this.contextName, namespace
      );
      this.post({ type: 'portForward', id });
      void announceForward(terminal, pairs, addresses, message.timeout, message.open);
    } catch (err) {
      fail(describeError(err));
    }
  }

  /**
   * Fetches one Secret key fresh and either hands the decoded text to the
   * drawer or puts it on the clipboard without it ever reaching the page.
   *
   * Nothing is cached: the value lives in this function, the reply message and
   * (for Reveal) the drawer until it closes. A value that is not valid UTF-8 is
   * never sent as text: Reveal reports only its size, and Copy puts the base64
   * form on the clipboard instead.
   */
  private async secretValue(message: Extract<Inbound, { type: 'secretValue' }>): Promise<void> {
    const { mode, name, namespace, key } = message;
    const reply = { type: 'secretValue', name, namespace, key };
    try {
      const encoded = (await k.secretKeyValue(name, key, this.contextName, namespace)).trim();
      const bytes = Buffer.from(encoded, 'base64');
      let text: string | undefined;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        text = undefined;
      }
      if (mode === 'copy') {
        await vscode.env.clipboard.writeText(text ?? encoded);
        vscode.window.setStatusBarMessage(
          text === undefined ? `Kubi: copied ${key} as base64 (binary value)` : `Kubi: copied ${key}`,
          3000
        );
        this.post({ ...reply, copied: true });
      } else if (text === undefined) {
        this.post({ ...reply, binary: bytes.length });
      } else {
        this.post({ ...reply, text });
      }
    } catch (err) {
      this.post({ ...reply, error: describeError(err) });
    }
  }

  private html(): string {
    const webview = this.panel.webview;
    /**
     * `asWebviewUri` returns the same URL for a given file in every build, so
     * the webview's HTTP cache — and the desktop app's disk cache, which
     * outlives the window — serves the previous version's `dashboard.js` and
     * `.css` after an upgrade. The CSP nonce doesn't help: it gates script
     * execution, not fetching, and isn't part of the URL. So each asset carries
     * its own mtime as a query param, which changes whenever the file does.
     * That covers an installed upgrade and `npm run watch` alike, and needs no
     * version bump to stay correct.
     */
    const root = assetRoot(this.extension.extensionUri);
    const uri = (file: string) => {
      const path = vscode.Uri.joinPath(root, file);
      return webview.asWebviewUri(path).with({ query: `v=${assetVersion(path.fsPath)}` });
    };
    const nonce = makeNonce();
    const collapsed = this.extension.globalState.get<boolean>(RAIL_COLLAPSED_KEY, false);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${uri('dashboard.css')}" rel="stylesheet">
<title>Kubi</title>
</head>
<body${collapsed ? ' class="rail-collapsed"' : ''}>
<div id="app">${this.bootShell()}</div>
<script nonce="${nonce}" src="${uri('dashboard.js')}"></script>
</body>
</html>`;
  }

  /**
   * The first frame, written into the HTML itself.
   *
   * `dashboard.js` only paints once it has downloaded, parsed and run, and on a
   * cold panel that is long enough to see: the webview sat blank — no rail, no
   * toolbar, no title — until the last line of the script called `render()`.
   * The skeletons the script draws were never the problem; nothing was reaching
   * them. So the same shape is emitted here, in markup, reusing the script's own
   * classes so the handover is a swap of identical geometry rather than a jump.
   *
   * Only what is known before any kubectl call goes in: the rail's chrome and
   * how long its list is. Anything cluster-derived — the title, row counts —
   * would be a guess that the first render would correct in front of
   * the reader, which is the flicker this is meant to avoid. The content area
   * is left empty for the same reason: the panel restores whichever page it was
   * last on, so its shape is not known here.
   */
  private bootShell(): string {
    const bar = (width: string) => `<span class="sk-bar" style="width:${width}"></span>`;
    // Placeholder rail entries: the real ones are drawn by the script, which
    // holds the icons. How many there are is known here, though — Overview
    // and the kinds the user keeps — so the list does not grow or shrink as
    // the real one replaces it.
    const navRows = Array.from({ length: 1 + (this.railKinds() ?? RAIL_DEFAULT).length }, () =>
      `<div class="nav-item"><span class="glyph"></span>${bar('62%')}</div>`
    ).join('');
    return `<div class="rail">`
      + `<button class="brand">${BRAND_MARK}<span class="name">Kubi</span>`
      + `<span class="chevron">«</span></button>`
      // Inert until the script takes over; it is here for its geometry, so the
      // list under it does not shift down when the real one is drawn.
      + `<div class="rail-jump-row"><button class="rail-jump" type="button" tabindex="-1" aria-hidden="true">`
      + `${SEARCH_MARK}<span class="label-text">Go to…</span><kbd class="rail-jump-key">:</kbd></button></div>`
      + `<div class="rail-scroll">${navRows}</div>`
      + `</div>`
      + `<div class="main">`
      + `<div class="toolbar"><span class="spacer"></span></div>`
      + `<div class="content"></div>`
      + `</div>`;
  }
}

/**
 * kubectl reports a no-op edit on stderr and still exits 0, so the outcome can
 * only be read out of its output. As of 1.35 it has four such messages:
 *
 *   Edit cancelled, no changes made.
 *   Edit cancelled, no objects found
 *   Edit cancelled, saved file was empty.
 *   Edit cancelled, no valid changes were saved.
 *
 * Returns the reason lower-cased for the notification, or undefined when the
 * edit was applied. Matching the shared "edit cancelled" prefix rather than the
 * exact sentences keeps this working if the wording shifts between versions.
 */
function editCancelled(output: string): string | undefined {
  const line = output
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^edit cancelled\b/i.test(l));
  return line ? line.replace(/\.$/, '').toLowerCase() : undefined;
}

/**
 * A cache size is only ever read as a rough magnitude, so it is rounded to one
 * decimal and never shown in bytes past a kilobyte. The webview formats the
 * same figure its own way; this copy is for the confirmation dialog.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function byNamespaceThenName(a: Row, b: Row): number {
  return (a.namespace ?? '').localeCompare(b.namespace ?? '') || a.name.localeCompare(b.name);
}

/** Newest first, for rows whose `created` is when something happened. */
function byNewest(a: Row, b: Row): number {
  return time(b.created) - time(a.created);
}

function time(timestamp?: string): number {
  const ms = timestamp ? new Date(timestamp).getTime() : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

/** The workload kinds `kubectl logs` and `kubectl exec` accept as `kind/name`. */
const WORKLOAD_TERMINALS = new Set(['deployments', 'statefulsets', 'daemonsets', 'replicasets']);

/**
 * How much history the Logs tab starts with. More than the terminal's 100,
 * since the tab is where a log is read back rather than watched, but bounded
 * so a long-lived pod does not replay its whole life before going live.
 */
const LOG_TAIL = 1000;

/** How long output gathers before it is posted to the Logs tab; see streamLogs. */
const LOG_FLUSH_MS = 80;

/**
 * What logs and shell point kubectl at: a pod by its name, or a workload as
 * `kind/name`, for which kubectl picks one of its pods.
 */
function terminalTarget(kind: string, name: string): string {
  const meta = kindById(kind);
  return meta && WORKLOAD_TERMINALS.has(kind) ? `${meta.singular.toLowerCase()}/${name}` : name;
}

/**
 * Follows a container's logs in a terminal. Captured into a document the log
 * was frozen at the moment it was fetched, which is the wrong shape for the
 * thing people actually watch during a deploy or a crash loop; `-f` keeps it
 * live, and the tail bounds the backlog so a long-lived pod does not replay
 * hours of history before catching up.
 *
 * The container is always named when the panel knows it — without it kubectl
 * refuses a multi-container pod unless it carries a default-container
 * annotation.
 *
 * `previous` reads the log of the instance that died instead, which is the one
 * that holds the reason for a crash loop. That log is complete the moment it is
 * opened, so it is fetched rather than followed.
 */
function openLogs(name: string, context: string, namespace: string, container?: string, previous = false): void {
  const kubectl = vscode.workspace.getConfiguration('kubi').get<string>('kubectlPath') || 'kubectl';
  const args = [
    ...kubeconfigArgs(),
    '--context', context, 'logs', name, '-n', namespace,
    ...(container ? ['-c', container] : []),
    '--tail', '100',
    ...(previous ? ['-p'] : ['-f'])
  ];
  const terminal = vscode.window.createTerminal({
    name: `${previous ? 'previous logs' : 'logs'} ${label(name, container)} (${context})`,
    env: terminalEnv()
  });
  terminal.sendText(`${kubectl} ${args.map(quote).join(' ')}`);
  terminal.show();
}

/** What `kubectl port-forward` takes for each kind that offers it. */
const FORWARD_PREFIX: Record<string, string> = {
  pods: 'pod',
  services: 'svc',
  deployments: 'deployment',
  statefulsets: 'statefulset'
};

function forwardTarget(kind: string, name: string): string {
  return `${FORWARD_PREFIX[kind] ?? kind}/${name}`;
}

/**
 * The ports an object declares: a service's own ports, and for everything else
 * its containers' ports. A service forwards its `port`; a pod or workload, the
 * `containerPort`. `name` is the port's own name, which the dialog hands back
 * so the URL to open can be guessed from it; `label` is what the dialog shows.
 */
function forwardPorts(kind: string, object: k.KubeObject): { port: number; name: string; label: string }[] {
  const spec: any = (object as any).spec ?? {};
  const found: { port: number; name: string; label: string }[] = [];
  if (kind === 'services') {
    for (const p of spec.ports ?? []) {
      found.push({
        port: p.port,
        name: p.name ?? '',
        label: [p.name, p.protocol && p.protocol !== 'TCP' ? p.protocol : ''].filter(Boolean).join(' ')
      });
    }
  } else {
    const podSpec = kind === 'pods' ? spec : spec.template?.spec ?? {};
    for (const c of podSpec.containers ?? []) {
      for (const p of c.ports ?? []) {
        if ((p.protocol ?? 'TCP') === 'TCP') {
          found.push({ port: p.containerPort, name: p.name ?? '', label: [c.name, p.name].filter(Boolean).join(' · ') });
        }
      }
    }
  }
  return found.filter((p, i) => found.findIndex((q) => q.port === p.port) === i);
}

/** One `LOCAL:REMOTE` of a forward, with the scheme its URL is opened with. */
interface ForwardPair {
  local: number;
  remote: number;
  https: boolean;
}

function isPort(port: unknown, min: number): port is number {
  return Number.isInteger(port) && (port as number) >= min && (port as number) <= 65535;
}

/**
 * Whether a port is likely to speak TLS, going by its name or the two numbers
 * conventionally used for it. It only picks the scheme of the URL offered;
 * the forward itself carries bytes either way.
 */
function looksHttps(remote: number, name: string): boolean {
  return /https/i.test(name) || remote === 443 || remote === 8443;
}

/**
 * What to bind to check an `--address` entry is usable. kubectl takes
 * `localhost` to mean the loopback addresses, so its IPv4 one stands in.
 */
function listenHost(address: string): string {
  return address === 'localhost' ? '127.0.0.1' : address;
}

/**
 * Why kubectl would fail to listen on `host:port`, found by trying it first;
 * undefined when it can. kubectl's own message for this would land in the
 * terminal after the dialog had closed, with everything typed in it gone.
 */
function listenProblem(host: string, port: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err: NodeJS.ErrnoException) => resolve(
      err.code === 'EADDRINUSE' ? `Local port ${port} is already in use.`
        : err.code === 'EACCES' ? `Local port ${port} needs elevated privileges; pick one above 1023.`
          : err.code === 'EADDRNOTAVAIL' ? `${host} is not an address of this machine.`
            : `Cannot listen on ${host}: ${err.message}`
    ));
    server.listen(port, host, () => server.close(() => resolve(undefined)));
  });
}

/**
 * A local port free on every host, and not among `taken` — the ports already
 * handed out to the same forward, which nothing is listening on yet.
 */
async function freePort(hosts: string[], taken: number[]): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, hosts[0], () => {
        const { port } = server.address() as net.AddressInfo;
        server.close(() => resolve(port));
      });
    });
    if (taken.includes(port)) {
      continue;
    }
    const problems = await Promise.all(hosts.slice(1).map((host) => listenProblem(host, port)));
    if (problems.every((problem) => !problem)) {
      return port;
    }
  }
  throw new Error('found no local port free on every address');
}

/**
 * Runs the forward in a terminal; closing the terminal ends it. kubectl's own
 * defaults — listening on localhost, waiting a minute for a running pod — are
 * left off the command, so it reads as it would have been typed.
 */
function openPortForward(
  target: string,
  pairs: ForwardPair[],
  addresses: string[],
  timeout: number | undefined,
  context: string,
  namespace: string
): vscode.Terminal {
  const kubectl = vscode.workspace.getConfiguration('kubi').get<string>('kubectlPath') || 'kubectl';
  const ports = pairs.map((p) => `${p.local}:${p.remote}`);
  const address = addresses.join(',');
  const args = [
    ...kubeconfigArgs(),
    '--context', context, 'port-forward', target, ...ports, '-n', namespace,
    ...(address === 'localhost' ? [] : ['--address', address]),
    ...(timeout ? ['--pod-running-timeout', `${timeout}s`] : [])
  ];
  const terminal = vscode.window.createTerminal({
    name: `Kubi: port-forward ${target} ${ports.join(' ')}`,
    env: terminalEnv()
  });
  terminal.sendText(`${kubectl} ${args.map(quote).join(' ')}`);
  terminal.show();
  return terminal;
}

/**
 * Waits for the forward to start accepting connections, then opens it or
 * offers to. Gives up when the terminal closes, or a while after kubectl
 * would have stopped waiting for a running pod — it exits at once on a bad
 * target, and the terminal shows why.
 *
 * Every pair starts together, so the first one listening stands for them all.
 * A wildcard or `localhost` forward is dialled, and opened, on the loopback
 * address; one on a particular address, on that address.
 */
async function announceForward(
  terminal: vscode.Terminal,
  pairs: ForwardPair[],
  addresses: string[],
  timeout: number | undefined,
  open: boolean
): Promise<void> {
  const local = addresses.find((a) => a === 'localhost' || a === '0.0.0.0' || a === '::');
  const dial = local === undefined ? addresses[0] : local === '::' ? '::1' : '127.0.0.1';
  const host = local !== undefined ? 'localhost' : net.isIPv6(dial) ? `[${dial}]` : dial;
  const urls = pairs.map((p) => `${p.https ? 'https' : 'http'}://${host}:${p.local}`);

  let closed = false;
  const sub = vscode.window.onDidCloseTerminal((t) => {
    if (t === terminal) {
      closed = true;
    }
  });
  try {
    const deadline = Date.now() + ((timeout ?? 60) + 30) * 1000;
    while (Date.now() < deadline && !closed) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (await new Promise<boolean>((resolve) => {
        const socket = net.connect(pairs[0].local, dial);
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', () => resolve(false));
      })) {
        const text = `Kubi: forwarding ${urls.join(', ')}`;
        if (open) {
          for (const url of urls) {
            await vscode.env.openExternal(vscode.Uri.parse(url));
          }
          vscode.window.showInformationMessage(text);
          return;
        }
        const buttons = urls.length === 1 ? ['Open in Browser'] : pairs.map((p) => `Open :${p.local}`);
        const choice = await vscode.window.showInformationMessage(text, ...buttons);
        if (choice !== undefined) {
          await vscode.env.openExternal(vscode.Uri.parse(urls[buttons.indexOf(choice)]));
        }
        return;
      }
    }
  } finally {
    sub.dispose();
  }
}

/**
 * Drains nodes in a terminal. `--ignore-daemonsets` because a DaemonSet pod
 * is recreated on the node straight away, so kubectl otherwise refuses almost
 * every real node; `--delete-emptydir-data` because scratch volumes are what
 * emptyDir is for, and refusing on them stops most drains for no benefit. The
 * confirmation says both.
 */
function openDrain(names: string[], context: string): void {
  const kubectl = vscode.workspace.getConfiguration('kubi').get<string>('kubectlPath') || 'kubectl';
  const args = [
    ...kubeconfigArgs(),
    '--context', context, 'drain', ...names,
    '--ignore-daemonsets', '--delete-emptydir-data'
  ];
  const terminal = vscode.window.createTerminal({
    name: `drain ${names.length === 1 ? names[0] : `${names.length} nodes`} (${context})`,
    env: terminalEnv()
  });
  terminal.sendText(`${kubectl} ${args.map(quote).join(' ')}`);
  terminal.show();
}

async function openDocument(content: string, language: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ content: content || '(empty)', language });
  await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
}

function openShell(name: string, context: string, namespace: string, container?: string): void {
  const kubectl = vscode.workspace.getConfiguration('kubi').get<string>('kubectlPath') || 'kubectl';
  const args = [
    ...kubeconfigArgs(),
    '--context', context, 'exec', '-it', name, '-n', namespace,
    ...(container ? ['-c', container] : []),
    '--',
    'sh', '-c', 'command -v bash >/dev/null && exec bash || exec sh'
  ];
  const terminal = vscode.window.createTerminal({
    name: `${label(name, container)} (${context})`,
    env: terminalEnv()
  });
  terminal.sendText(`${kubectl} ${args.map(quote).join(' ')}`);
  terminal.show();
}

/** Names a terminal after the pod, and the container too when there is one. */
function label(name: string, container?: string): string {
  return container ? `${name}/${container}` : name;
}

function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * The kubeconfig flag for a terminal command line, if one is configured. The
 * flag goes on the command as well as in the environment below, because it is
 * the command that must not change meaning if the user's shell profile sets
 * its own KUBECONFIG.
 */
function kubeconfigArgs(): string[] {
  const config = k.kubeconfig();
  return config ? ['--kubeconfig', config] : [];
}

/**
 * KUBECONFIG for the terminal, so the commands people type themselves after
 * the one we sent — a `kubectl get` alongside a shell, an edited and re-run
 * log command — stay on the same kubeconfig as the dashboard they came from.
 */
function terminalEnv(): Record<string, string> | undefined {
  const config = k.kubeconfig();
  return config ? { KUBECONFIG: config } : undefined;
}

/**
 * Pages the rail can be left on: every resource kind plus the two views that
 * have no kind behind them.
 */
function isKnownKind(id: string): boolean {
  return id === 'overview' || id === 'about' || kindById(id) !== undefined;
}

/**
 * A rail list with anything that is not a kind taken out, and each kind once.
 * A stored list can outlive a kind a later release drops, and the rail has no
 * way to draw an entry that opens nothing.
 */
function knownKinds(ids: unknown[]): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && kindById(id) !== undefined))];
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** Whether a drag across a table draws a selection box. On unless turned off. */
function dragToSelect(): boolean {
  return vscode.workspace.getConfiguration('kubi').get<boolean>('dragToSelect') ?? true;
}

/** Whether the Nodes and Pods tables draw usage sparklines. Off unless turned on. */
function tableSparklines(): boolean {
  return vscode.workspace.getConfiguration('kubi').get<boolean>('tableSparklines') ?? false;
}

/**
 * What the About page's header says about Kubi itself: the version running and
 * where to take a bug or a pull request. Read off package.json, so a release
 * bump or a moved repository is one edit there rather than one here as well.
 */
function extensionInfo(extension: vscode.Extension<unknown>) {
  const pkg = extension.packageJSON;
  const repository = String(pkg.homepage ?? '').replace(/\/$/, '');
  return {
    version: String(pkg.version ?? ''),
    description: String(pkg.description ?? ''),
    repository,
    issues: String(pkg.bugs?.url ?? `${repository}/issues`),
    contributing: `${repository}/blob/main/CONTRIBUTING.md`,
    changelog: `${repository}/blob/main/CHANGELOG.md`
  };
}

/** Which editor group a new dashboard opens in, per `kubi.dashboardEditorGroup`. */
function dashboardColumn(): vscode.ViewColumn {
  const group = vscode.workspace.getConfiguration('kubi').get<string>('dashboardEditorGroup');
  return group === 'beside' ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
}

/**
 * Whether two owner sets hold the same names. Compared as sets rather than as
 * lists: the order a `kubectl get` returns items in is not something to depend
 * on, and a reshuffle is not a change worth repainting the table for.
 */
function sameOwners(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const seen = new Set(a);
  return b.every((name) => seen.has(name));
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

/**
 * A cache-busting stamp for one webview asset: its mtime in ms, which moves
 * whenever the file is rewritten by an upgrade or a recompile.
 *
 * Panels are opened by hand, so this stat is not on any hot path. If it fails —
 * a packaging layout that doesn't put the file where we expect — the fallback is
 * a value that is merely constant for this session, which busts a cache left by
 * a previous install without spinning up a new URL on every render.
 */
const SESSION_STAMP = Date.now();

function assetVersion(fsPath: string): number {
  try {
    return fs.statSync(fsPath).mtimeMs;
  } catch {
    return SESSION_STAMP;
  }
}

/**
 * Where the webview's `dashboard.js` and `.css` are served from.
 *
 * Packaging runs `npm run build` (via `vscode:prepublish`), which minifies both
 * into `out/media`, leaving the readable originals in `media` as the sources
 * they are. A packaged install therefore
 * has `out/media` and uses it; a working tree that has only ever been compiled
 * doesn't, and falls back to the unminified sources, so `npm run watch` keeps
 * serving the file being edited. The other assets in `media` — icons, which are
 * not built — are addressed as before.
 *
 * Both directories stay inside `localResourceRoots`, since the fallback has to
 * remain loadable in development.
 */
function assetRoot(extensionUri: vscode.Uri): vscode.Uri {
  const built = vscode.Uri.joinPath(extensionUri, 'out', 'media');
  return fs.existsSync(built.fsPath) ? built : vscode.Uri.joinPath(extensionUri, 'media');
}

function resourceRoots(extensionUri: vscode.Uri): vscode.Uri[] {
  return [vscode.Uri.joinPath(extensionUri, 'media'), vscode.Uri.joinPath(extensionUri, 'out', 'media')];
}
