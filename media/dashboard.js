(function () {
  const vscode = acquireVsCodeApi();

  /**
   * Brand mark geometry, shared with the server-rendered shell in panel.ts: a
   * lightning bolt inside a hexagon. The hexagon is a stroke and the bolt a
   * fill, both in `currentColor`; they never touch, so the mark holds together
   * in one colour. Keep the two files in sync.
   */
  const BRAND_HEX = 'M64 12 108 37.5v51L64 114 20 88.5v-51L64 12Z';
  const BRAND_BOLT = 'M71 33 45 71h16l-5 24 28-39H68l3-23Z';

  /** @type {{kinds: any[], context: string, cluster: string, allNamespaces: string,
   *  active: string, namespace: string, namespaces: string[], rows: any[],
   *  empty: boolean, stale: boolean, busy: boolean,
   *  error: string, refreshError: string, filter: string, status: string,
   *  sort: {key: string, dir: number}, selected: any, generated: number}} */
  const state = {
    kinds: [],
    /** Rail sections, in display order; sent with the kinds. @type {{id: string, label: string}[]} */
    groups: [],
    context: '',
    cluster: '',
    /** Server gitVersion for the rail; arrives after the first paint. */
    version: '',
    /** Rail narrowed to an icon strip. Persisted globally by the extension. */
    railCollapsed: false,
    allNamespaces: '__all__',
    active: 'overview',
    namespace: '',
    namespaces: [],
    rows: [],
    /**
     * The About view's payload: versions, skew verdict and identity. Null until
     * About has been opened at least once.
     */
    about: null,
    /**
     * The Overview's payload: the cluster's Warning events, the reasons they
     * group under, and how many events were seen in total. Null until Overview
     * has produced content at least once.
     * @type {{rows: any[], groups: any[], namespaces: string[], total: number} | null}
     */
    overview: null,
    /**
     * Reasons expanded on the Overview. A group is collapsed to its newest
     * occurrence until opened, so a hundred identical BackOffs cost one line
     * rather than a hundred.
     * @type {Set<string>}
     */
    openReasons: new Set(),
    /**
     * What the extension's cache is holding, as { entries, bytes }. Arrives on
     * its own message rather than inside `about`, since the About payload is
     * itself cached and would report a size frozen at the time it was stored.
     */
    cacheStats: null,
    /**
     * Whether the cache is kept across extension updates. Travels with
     * `cacheStats` because it is drawn in the same card; the extension owns the
     * value, so a tick here only asks for the change and waits to be told.
     */
    preserveCache: false,
    /** True until this kind has ever produced content (cached or fresh). */
    empty: true,
    /** Content on screen came from cache rather than a completed fetch. */
    stale: false,
    /** A refresh is in flight; shows a spinner beside the freshness label. */
    busy: false,
    error: '',
    /** A refresh failed while cached content is on screen. */
    refreshError: '',
    filter: '',
    /**
     * Narrows the pod table to the pods of one workload, the way k9s does when
     * you press Enter on a Deployment. Null when the table is showing
     * everything.
     *
     * `owners` is the set of ownerReference names a pod may name to belong
     * here — the workload itself for a StatefulSet or DaemonSet, and its
     * ReplicaSets for a Deployment, which the extension resolves. Matching by
     * ownership rather than by label selector keeps two workloads that share
     * an `app=` label out of each other's lists.
     *
     * A node scope has no owners: its pods are the ones scheduled onto it,
     * which every pod row already carries, so it is set here in the view
     * without asking the extension.
     *
     * @type {{kind: string, name: string, namespace?: string, owners: string[]} | null}
     */
    scope: null,
    /**
     * Where a drill-down came from, so it can be walked back. Set when the
     * Pods button jumps to the pod table and cleared on any other kind switch,
     * since a back button that outlives the jump it belongs to would send you
     * somewhere you never were.
     *
     * `name` and `namespace` identify the row to put the cursor back on, which
     * is what makes the return feel like coming back rather than reloading the
     * table from the top.
     *
     * @type {{kind: string, name: string, namespace?: string} | null}
     */
    origin: null,
    /**
     * The status picker's selection, as an encoded token: '' for any,
     * `health:<bucket>` for one of HEALTH_FILTERS, or `status:<word>` for an
     * exact status. One control rather than two, because for most kinds health
     * is derived from the status and separate pickers would overlap.
     */
    status: '',
    /** Replaced by `defaultSort` for the kind as soon as one is opened. */
    sort: { key: 'age', dir: 1 },
    selected: null,
    generated: 0,
    /**
     * Which tab the details panel is showing. Reset to the overview whenever
     * the selection changes, so a new row never opens straight onto the tab
     * that costs a fetch.
     * @type {'details' | 'describe'}
     */
    detailTab: 'details',
    /**
     * The details panel's describe tab. Reset whenever the selection changes, so it
     * only ever holds output for the row currently on screen. `requested`
     * records that the tab has been opened at least once for this row, which
     * is what keeps reopening it from refetching.
     * @type {{requested: boolean, loading: boolean, text: string, error: string,
     *  stale: boolean, generated: number}}
     */
    describe: newDescribe(),
    /**
     * The details tab's Events section: what happened to the selected object.
     * Reset with the selection, and fetched when the panel opens rather than
     * on demand — unlike describe it is one API read, and an object's recent
     * events are usually the reason it was opened in the first place.
     * @type {{loading: boolean, rows: object[], error: string, stale: boolean,
     *  generated: number, expanded: boolean}}
     */
    events: newObjectEvents(),
    /**
     * Identity keys of objects with a `kubectl edit` tab open. Several can be
     * open at once; only re-editing the same object is blocked, since kubectl
     * edits a snapshot and the one saved last would silently win.
     * @type {string[]}
     */
    editing: [],
    /**
     * Object keys ticked for a bulk action (see `checkKey`). Keys rather than
     * rows, so a refresh that replaces every row object keeps the selection
     * pointing at the same objects. A row that has since been deleted simply
     * stops matching, and `checkedRows` drops it.
     * @type {Set<string>}
     */
    checked: new Set(),
    /**
     * Key of the row the keyboard cursor is on, or null before the arrows have
     * been used. A key rather than an index, so sorting, filtering and a
     * refresh that replaces every row object all leave the cursor on the same
     * object; if that object is gone, the cursor falls back to the top.
     *
     * Deliberately separate from `checked` (what an action would act on) and
     * from `selected` (what the panel is showing): moving the cursor must not
     * tick a row, and ticking with the mouse must not move it.
     * @type {string | null}
     */
    cursor: null
  };

  const app = document.getElementById('app');

  // ---------- helpers ----------

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (key === 'class') {
        node.className = value;
      } else if (key === 'text') {
        node.textContent = value;
      } else if (key.startsWith('on')) {
        // A null handler is how a caller says "not in this mode" — skip it
        // rather than registering a listener that does nothing.
        if (value) node.addEventListener(key.slice(2), value);
      } else if (value !== undefined && value !== null && value !== false) {
        node.setAttribute(key, value);
      }
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  /**
   * The extension's own icon, drawn inline rather than loaded from media/. A
   * file would need a webview URI threaded through `init` and would flash in
   * late on a cold panel; the mark is a handful of paths, so it costs less to
   * emit it here and it is painted with the first frame. `currentColor` on the
   * strokes lets the rail tint it like any other glyph — the mark reads on
   * both themes without a second asset.
   */
  function brandMark() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'mark');
    svg.setAttribute('viewBox', '0 0 128 128');
    svg.setAttribute('aria-hidden', 'true');
    const path = (d, extra) => {
      const node = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      node.setAttribute('d', d);
      node.setAttribute('fill', 'none');
      node.setAttribute('stroke', 'currentColor');
      node.setAttribute('stroke-width', '9');
      for (const [key, value] of Object.entries(extra || {})) node.setAttribute(key, value);
      return node;
    };
    svg.appendChild(path(BRAND_HEX, { 'stroke-linejoin': 'round' }));
    svg.appendChild(path(BRAND_BOLT, { fill: 'currentColor', stroke: 'none' }));
    return svg;
  }

  function kindOf(id) {
    return state.kinds.find((k) => k.id === id);
  }

  /**
   * The kind's declared opening sort, or newest first. Ages sort numerically
   * as a span — "5m" is 300, "5d" is 432000 — so ascending age is the freshest
   * object at the top, which is what you want to see first on every kind.
   * A kind with no age column falls back to name ascending.
   */
  function defaultSort(id) {
    const kind = kindOf(id);
    if (kind && kind.sort) return { ...kind.sort };
    const ageColumn = kind && kind.columns.find((col) => isAgeColumn(col.key));
    return ageColumn ? { key: ageColumn.key, dir: 1 } : { key: 'name', dir: 1 };
  }

  /** A fresh describe tab: unopened, with nothing fetched yet. */
  function newDescribe() {
    return { requested: false, loading: false, text: '', error: '', stale: false, generated: 0 };
  }

  /** A fresh Events section: nothing fetched, showing only the newest few. */
  function newObjectEvents() {
    return { loading: false, rows: [], error: '', stale: false, generated: 0, expanded: false };
  }

  /** How many of an object's events the section shows before "Show all". */
  const EVENTS_PREVIEW = 5;

  /**
   * Selects a row (or clears the selection), discarding the previous describe
   * output. No describe is fetched here: the panel opens on the details tab,
   * whose content rides along on the row, and `kubectl describe` is a process
   * per row that most selections never look at.
   */
  function selectRow(row) {
    state.selected = row;
    state.detailTab = 'details';
    state.describe = newDescribe();
    state.events = newObjectEvents();
    // The Events table's own rows are events already; asking the API server
    // which events are about an event would be a question with no answer.
    if (row && state.active !== 'events') {
      state.events.loading = true;
      post({ type: 'events', kind: state.active, name: row.name, namespace: row.namespace });
    }
  }

  /**
   * Switches the panel's tab, fetching describe output the first time its tab
   * is opened for this row. The extension replays its cached text before
   * refreshing, so a row looked at before usually paints without a wait.
   */
  function openDetailTab(tab) {
    state.detailTab = tab;
    const row = state.selected;
    if (tab === 'describe' && row && !state.describe.requested) {
      state.describe.requested = true;
      state.describe.loading = true;
      post({ type: 'describe', kind: state.active, name: row.name, namespace: row.namespace });
    }
    renderContentOnly();
  }

  /** Must match DashboardPanel.editKey in panel.ts; the extension sends these. */
  function editKey(kindId, row) {
    return `${kindId}\u0000${row.namespace ?? ''}\u0000${row.name}`;
  }

  function isSelected(row) {
    return Boolean(state.selected)
      && state.selected.name === row.name
      && state.selected.namespace === row.namespace;
  }

  /** Identity of a row within the active kind: where it sits in the table. */
  function rowKey(row) {
    return `${row.namespace ?? ''}\u0000${row.name}`;
  }

  /**
   * Identity of the object a row stands for, used as its checkbox key. Unlike
   * `rowKey` this pins the tick to one particular object: a pod deleted and
   * recreated under the same name — a StatefulSet replica, or a Deployment pod
   * whose name repeats — is a different object, and the new one must arrive
   * unticked rather than inheriting a tick aimed at the one just deleted.
   * Objects the API server reports without a uid fall back to the name, which
   * is the behaviour this replaced.
   */
  function checkKey(row) {
    return row.uid ? `uid\u0000${row.uid}` : rowKey(row);
  }

  function isChecked(row) {
    return state.checked.has(checkKey(row));
  }

  function isCursor(row) {
    return state.cursor !== null && state.cursor === rowKey(row);
  }

  /**
   * Where the cursor sits in the rows currently on screen, or -1 if it is on a
   * row that filtering, sorting or a refresh has taken away. Resolved on every
   * keystroke rather than stored, since the row list under it changes freely.
   */
  function cursorIndex(rows) {
    if (state.cursor === null) return -1;
    return rows.findIndex((row) => rowKey(row) === state.cursor);
  }

  /**
   * Moves the cursor by `step` rows and repaints. From nowhere, the first press
   * lands on the first row (or the last, moving up) rather than jumping past
   * it; at either end it stays put, so holding an arrow does not wrap around
   * into the rows just left behind.
   */
  function moveCursor(step) {
    const rows = visibleRows();
    if (rows.length === 0) return;
    const at = cursorIndex(rows);
    const next = at === -1
      ? (step > 0 ? 0 : rows.length - 1)
      : Math.min(rows.length - 1, Math.max(0, at + step));
    state.cursor = rowKey(rows[next]);
    renderContentOnly();
    scrollCursorIntoView();
  }

  /**
   * Keeps the cursor row in sight after a move. `nearest` rather than a fixed
   * alignment so stepping through a long list scrolls by a row at a time
   * instead of recentring the table under every press.
   */
  function scrollCursorIntoView() {
    const node = app.querySelector('tbody tr.cursor');
    if (node) node.scrollIntoView({ block: 'nearest' });
  }

  /**
   * The checked rows that are actually on screen. A tick survives sorting and
   * a refresh, but a row hidden by a filter — or deleted out from under the
   * table — must not be swept up by an action aimed at what is visible.
   */
  function checkedRows() {
    return visibleRows().filter(isChecked);
  }

  /** Forgets every tick; used when the set would otherwise become invisible. */
  function clearChecked() {
    state.checked.clear();
  }

  /** Drops ticks for rows a refresh no longer reports. */
  function pruneChecked(rows) {
    if (!state.checked.size) return;
    const live = new Set(rows.map(checkKey));
    for (const key of [...state.checked]) {
      if (!live.has(key)) state.checked.delete(key);
    }
  }

  function post(message) {
    vscode.postMessage(message);
  }

  function nsLabel(ns) {
    return ns === state.allNamespaces ? 'All namespaces' : ns;
  }

  /**
   * How many rows each namespace option would leave on screen. Cluster-scoped
   * rows carry no namespace and survive every choice, so they count everywhere
   * — the same rule `inNamespace` filters by, so the number matches the table.
   */
  function namespaceCounts() {
    const counts = new Map();
    let unscoped = 0;
    for (const row of state.rows) {
      if (!row.namespace) unscoped += 1;
      else counts.set(row.namespace, (counts.get(row.namespace) ?? 0) + 1);
    }
    if (unscoped) {
      for (const ns of counts.keys()) counts.set(ns, counts.get(ns) + unscoped);
    }
    counts.set(state.allNamespaces, state.rows.length);
    return counts;
  }

  /** Columns whose value is a span since `row.created` rather than a stored cell. */
  function isAgeColumn(key) {
    return key === 'age' || key === 'lastSeen';
  }

  /**
   * Reads a cell, recomputing the age from the creation timestamp so a replayed
   * cached row shows how old the object is now, not how old it was when cached.
   */
  function cellValue(row, key) {
    if (isAgeColumn(key) && row.created) {
      return formatAge(row.created);
    }
    return row.cells[key] ?? '';
  }

  /**
   * The value a cell sorts on. Age columns sort on the creation timestamp
   * itself rather than on the text in the cell: the text is rounded down to one
   * unit, so "59s" and "1m" are a second apart but two rows both showing "1m"
   * can be a minute apart, and as they cross a unit boundary the rounding
   * flips their order under a text comparison. Returns a number when the value
   * sorts numerically and null when it is plain text.
   */
  function sortValue(row, key) {
    if (isAgeColumn(key) && row.created) {
      const time = new Date(row.created).getTime();
      // Older is larger, matching the seconds an age string parses to, so a
      // column sorted ascending still puts the freshest row first.
      return Number.isNaN(time) ? null : -time;
    }
    return numericValue(cellValue(row, key));
  }

  /** Formats an age the way kubectl does: 2y271d, 5d, 3h, 12m, 45s. */
  function formatAge(timestamp) {
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000));
    const days = Math.floor(seconds / 86400);
    if (days >= 365) return `${Math.floor(days / 365)}y${days % 365}d`;
    if (days > 0) return `${days}d`;
    const hours = Math.floor(seconds / 3600);
    if (hours > 0) return `${hours}h`;
    const minutes = Math.floor(seconds / 60);
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
  }

  /**
   * The exact moment an age counts from, for a tooltip: the local date and time
   * plus the zone abbreviation, so a timestamp read off a cluster in another
   * region is never ambiguous about whose clock it is on.
   */
  function formatTimestamp(timestamp) {
    // new Date(null) is the Unix epoch, not an invalid date, so a missing
    // timestamp has to be rejected before it turns into a bogus "Jan 1, 1970".
    if (timestamp === null || timestamp === undefined || timestamp === '') return '';
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '';
    // Explicit components rather than dateStyle/timeStyle: those two cannot be
    // combined with timeZoneName, which is the part that disambiguates the zone.
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short'
    });
  }

  /** Coarse "how old is this" label for the toolbar: just now, 4m ago, 2d ago. */
  function ago(timestamp) {
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    if (seconds < 10) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  // ---------- rendering ----------

  /**
   * Puts every pending row's pulse on one clock. A CSS animation starts when
   * its row gets the class, so rows built by different refreshes would each
   * pulse on their own beat; a start time of zero on the document timeline
   * gives them all the same phase. Deferred to after the render that may have
   * added rows. See `warn-pulse` in the CSS.
   */
  function syncPulse() {
    queueMicrotask(() => {
      for (const anim of document.getAnimations()) {
        if (anim.animationName === 'warn-pulse' && anim.startTime !== 0) anim.startTime = 0;
      }
    });
  }

  function render() {
    syncPulse();
    const content0 = app.querySelector('.content');
    const scroll = content0?.scrollTop ?? 0;
    // The table is wider than the pane whenever a kind has many columns, so the
    // horizontal position has to survive a rebuild too — otherwise a refresh
    // landing while the user is reading a right-hand column snaps them back to
    // the name column.
    const scrollX = content0?.scrollLeft ?? 0;
    // The rail's kind list scrolls in its own right once a cluster has more
    // kinds than fit, and switching pages rebuilds it. Without this it would
    // jump back to the top every time, losing sight of the item just clicked.
    const railScroll = app.querySelector('.rail-scroll')?.scrollTop ?? 0;
    const caret = captureSearchFocus();
    const detail = captureDetailScroll();
    app.textContent = '';
    app.appendChild(renderRail());
    app.appendChild(renderMain());
    const content = app.querySelector('.content');
    if (content) {
      content.scrollTop = scroll;
      content.scrollLeft = scrollX;
    }
    const rail = app.querySelector('.rail-scroll');
    if (rail) rail.scrollTop = railScroll;
    restoreDetailScroll(detail);
    restoreSearchFocus(caret);
  }

  /** The filter box, if it is on screen. */
  function searchInput() {
    return app.querySelector('.filters input.search');
  }

  /**
   * A render replaces the filter row wholesale, which drops focus if the user
   * was typing in the filter — and a refresh landing mid-search does exactly
   * that. The caret is noted here and put back afterwards, the same way the
   * content scroll position is.
   */
  function captureSearchFocus() {
    const node = searchInput();
    if (!node || document.activeElement !== node) return null;
    return { start: node.selectionStart, end: node.selectionEnd, dir: node.selectionDirection };
  }

  function restoreSearchFocus(caret) {
    if (!caret) return;
    const node = searchInput();
    if (!node) return;
    node.focus();
    node.setSelectionRange(caret.start, caret.end, caret.dir || 'none');
  }

  /**
   * What the details panel is showing, as an identity. It is stamped on the
   * panel when it is built rather than recomputed when its scroll is put back:
   * opening a tab and selecting a row both change the state before the
   * re-render, so reading the key off the live state would say the panel on
   * screen is the one about to replace it.
   */
  function detailScrollKey() {
    const row = state.selected;
    if (!row) return '';
    return `${state.active}\u0000${rowKey(row)}\u0000${state.detailTab}`;
  }

  /**
   * Where the details panel is scrolled to. The panel is a child of the
   * content, so a refresh rebuilds it — and describe output runs to hundreds of
   * lines and refreshes on a timer, so without this, reading the middle of one
   * means being thrown back to the top every few seconds.
   */
  function captureDetailScroll() {
    const panel = app.querySelector('.modal-backdrop');
    const body = panel?.querySelector('.body');
    if (!body) return null;
    return {
      key: panel.getAttribute('data-detail'),
      top: body.scrollTop,
      // Describe output is column-aligned and scrolls sideways in its own
      // right, inside the pane that scrolls vertically.
      left: body.querySelector('.describe-text')?.scrollLeft ?? 0
    };
  }

  /**
   * Puts that position back, but only onto the same object on the same tab —
   * a different one is a different body of text, where the old offset means
   * nothing and the top is where a reader expects to start.
   */
  function restoreDetailScroll(saved) {
    if (!saved) return;
    const panel = app.querySelector('.modal-backdrop');
    if (!panel || panel.getAttribute('data-detail') !== saved.key) return;
    const body = panel.querySelector('.body');
    if (!body) return;
    body.scrollTop = saved.top;
    const text = body.querySelector('.describe-text');
    if (text) text.scrollLeft = saved.left;
  }

  function renderRail() {
    const collapsed = state.railCollapsed;

    // Collapsed, the label is hidden, so hovering a glyph flies the same text
    // out beside the rail. A CSS flyout rather than the native tooltip: no
    // delay before it appears, and it matches the rail's styling.
    const navItem = (id, label, glyphText) => el('div', {
      class: 'nav-item' + (state.active === id ? ' active' : ''),
      onclick: () => select(id),
      // The flyout is `position: fixed`, so it has to be told where its item
      // is. Placing it on enter rather than in CSS is what keeps it out of the
      // scroller's clip — see `placeFlyout`.
      onmouseenter: collapsed ? placeFlyout : null,
      onmouseleave: collapsed ? hideFlyout : null
    },
      el('span', { class: 'glyph', text: glyphText }),
      el('span', { class: 'label-text', text: label }),
      collapsed ? el('span', { class: 'flyout' }, label) : null
    );

    // Kinds are grouped by what they do, in the order the extension sent the
    // groups. A section with no kinds — everything filtered out by a future
    // change, or a group nothing is assigned to — draws nothing rather than a
    // heading over empty space.
    const items = [navItem('overview', 'Overview', '◈')];
    let first = true;
    for (const group of state.groups) {
      const members = state.kinds.filter((kind) => kind.group === group.id);
      if (!members.length) continue;
      // Both a heading and a rule are emitted for each group; CSS shows the
      // heading when the rail is expanded and the rule when it is collapsed.
      // The rule above the first group is skipped — the context box already
      // separates it from what is above.
      if (!first) {
        items.push(el('div', { class: 'rail-divider' }));
      }
      items.push(el('div', { class: 'rail-label', text: group.label }));
      items.push(...members.map((kind) => navItem(kind.id, kind.label, glyph(kind.id))));
      first = false;
    }

    return el('div', { class: 'rail' },
      // Expanded, the whole top bar is the collapse target — a big, easy hit
      // rather than a small chevron. Collapsed, only the dot is left to click,
      // so it becomes the way back open.
      // so it becomes the way back open — as a full-width button rather than
      // one sized to the mark, which left most of the 48px strip dead.
      collapsed
        ? el('button', {
            class: 'brand',
            title: 'Expand sidebar',
            'aria-label': 'Expand sidebar',
            'aria-expanded': 'false',
            onclick: toggleRail
          }, brandMark())
        : el('button', {
            class: 'brand',
            title: 'Collapse sidebar',
            'aria-label': 'Collapse sidebar',
            'aria-expanded': 'true',
            onclick: toggleRail
          },
            brandMark(),
            el('span', { class: 'name', text: 'Kubi' }),
            el('span', { class: 'chevron', text: '«' })
          ),
      el('div', { class: 'context-box' },
        el('div', { class: 'context-name', title: state.cluster || state.context },
          state.context
        ),
        state.version ? el('div', { class: 'context-version', text: state.version }) : null
      ),
      // Everything above stays put; only the kinds scroll, so the brand row and
      // the context/version block remain visible however long the list gets.
      el('div', { class: 'rail-scroll' },
        ...items,
        // About is not a resource, so it is pushed to the bottom and separated
        // rather than sitting in the list of kinds.
        el('div', { class: 'rail-spacer' }),
        el('div', { class: 'rail-footer' }, navItem('about', 'About', 'ⓘ'))
      )
    );
  }

  /**
   * Puts the hovered item's flyout beside it, in viewport coordinates.
   *
   * The flyout used to be absolutely positioned against the nav item, which
   * worked until the rail's list became its own scroller. `.rail-scroll` sets
   * `overflow-y: auto`, and CSS resolves a `visible` on the other axis to
   * `auto` whenever its pair is not `visible` — so the strip clipped the
   * flyouts at its own 48px edge no matter what `overflow-x` asked for, and
   * the labels simply stopped appearing. `position: fixed` escapes the
   * scroller (and #app's own `overflow: hidden`) entirely; the cost is that
   * the coordinates can no longer come from CSS, so they are measured here.
   *
   * Vertically the flyout is clamped into the viewport, so the bottom-most
   * glyphs — About especially — do not push their label off-screen.
   */
  function placeFlyout(event) {
    const item = event.currentTarget;
    const flyout = item.querySelector('.flyout');
    if (!flyout) return;
    const box = item.getBoundingClientRect();
    flyout.style.left = `${box.right + 6}px`;
    // Measured while visible, since a `display: none` box has no height.
    flyout.style.visibility = 'hidden';
    flyout.style.display = 'flex';
    const height = flyout.offsetHeight;
    const top = Math.min(
      Math.max(4, box.top + box.height / 2 - height / 2),
      window.innerHeight - height - 4
    );
    flyout.style.top = `${top}px`;
    flyout.style.visibility = '';
  }

  function hideFlyout(event) {
    const flyout = event.currentTarget.querySelector('.flyout');
    if (flyout) flyout.style.display = '';
  }

  /**
   * Collapsing only changes the rail's own width, so the table beside it keeps
   * its scroll position and nothing is re-fetched.
   */
  function toggleRail() {
    state.railCollapsed = !state.railCollapsed;
    document.body.classList.toggle('rail-collapsed', state.railCollapsed);
    post({ type: 'setRailCollapsed', collapsed: state.railCollapsed });
    renderRailOnly();
  }

  /** Swaps the rail in place, leaving the content and its scroll untouched. */
  function renderRailOnly() {
    const node = app.querySelector('.rail');
    if (node) {
      // The scroll lives on the inner list now that the header is pinned.
      const scroll = node.querySelector('.rail-scroll')?.scrollTop ?? 0;
      const next = renderRail();
      node.replaceWith(next);
      const scroller = next.querySelector('.rail-scroll');
      if (scroller) scroller.scrollTop = scroll;
    } else {
      render();
    }
  }

  function glyph(id) {
    return GLYPHS[id] || '•';
  }

  /**
   * One glyph per kind. Text rather than icon files: the rail renders inside a
   * webview with a strict CSP, and a character inherits the theme's foreground
   * colour for free where an SVG would need a palette per theme.
   */
  const GLYPHS = {
    nodes: '▣',
    namespaces: '◱',
    events: '❢',
    pods: '◉',
    deployments: '◳',
    statefulsets: '◫',
    daemonsets: '▤',
    replicasets: '◰',
    jobs: '▸',
    cronjobs: '◴',
    horizontalpodautoscalers: '↕',
    services: '⇄',
    ingresses: '⌘',
    endpoints: '⚭',
    networkpolicies: '⬡',
    configmaps: '☰',
    secrets: '✱',
    serviceaccounts: '☺',
    resourcequotas: '◔',
    limitranges: '↕',
    persistentvolumeclaims: '◧',
    persistentvolumes: '■',
    storageclasses: '≡'
  };

  /**
   * The picker filters the rows of a namespaced table. Overview has no table
   * and nodes are cluster-scoped, so on those it would be a control that
   * changes nothing.
   */
  function namespaceApplies() {
    if (!isTable()) return false;
    const kind = kindOf(state.active);
    return !kind || kind.namespaced;
  }

  /** True for the resource views — the ones backed by a filterable table. */
  function isTable() {
    return state.active !== 'overview' && state.active !== 'about';
  }

  function renderNamespacePicker() {
    const options = [state.allNamespaces, ...state.namespaces.filter((n) => n !== state.allNamespaces)];
    // Keep the current value selectable even before the namespace list arrives.
    if (state.namespace && !options.includes(state.namespace)) {
      options.push(state.namespace);
    }
    const counts = namespaceCounts();
    return el('select', {
      class: 'ns-picker',
      title: 'Namespace',
      onchange: (e) => {
        state.namespace = e.target.value;
        // A selection that hides the selected row would leave the panel open on
        // something no longer in the table.
        if (state.selected && !inNamespace(state.selected)) selectRow(null);
        // The rows are already here; only the view changes. Tell the extension
        // so the choice survives a reopen.
        post({ type: 'setNamespace', namespace: state.namespace });
        // The status picker counts within the namespace, so its options move
        // with this; rebuilding the row keeps them honest.
        renderFiltersOnly();
        renderContentOnly();
      }
    }, ...options.map((ns) =>
      el('option', { value: ns, selected: ns === state.namespace },
        `${nsLabel(ns)} (${counts.get(ns) ?? 0})`)
    ));
  }

  /**
   * What the status picker counts over: everything the namespace leaves
   * visible. Deliberately not narrowed by the picker itself or by the query,
   * so the counts hold still instead of shifting under the cursor as the
   * filter box is typed into.
   */
  function statusScope() {
    return state.rows.filter(inNamespace);
  }

  /**
   * Health buckets over kind-specific status words, in one control. Both are
   * built from the rows actually on hand, so the list is never a guess about
   * what this cluster can report.
   */
  function renderStatusPicker() {
    const scope = statusScope();

    const tally = new Map();
    for (const row of scope) {
      if (row.status) tally.set(row.status, (tally.get(row.status) ?? 0) + 1);
    }
    // Commonest first: the head of the list is what you check the table
    // against, and the tail is where the interesting failures sit.
    const statuses = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const health = HEALTH_FILTERS
      .map((bucket) => ({ ...bucket, count: scope.filter(bucket.test).length }))
      .filter((bucket) => bucket.count > 0);

    const offered = new Set();
    const option = (value, label, count) => {
      offered.add(value);
      return el('option', { value, selected: value === state.status }, `${label} (${count})`);
    };

    const groups = [];
    // A single bucket or a single status word is not a choice, so the group is
    // dropped rather than shown as a control that cannot change anything.
    if (health.length > 1) {
      groups.push(el('optgroup', { label: 'Health' },
        ...health.map((bucket) => option(`health:${bucket.value}`, bucket.label, bucket.count))
      ));
    }
    if (statuses.length > 1) {
      groups.push(el('optgroup', { label: 'Status' },
        ...statuses.map(([status, count]) => option(`status:${status}`, status, count))
      ));
    }
    // A selection that a refresh has left with nothing to match stays listed.
    // Dropping it would silently widen the table under someone still reading
    // it as filtered — and this runs before the empty check, so a filter that
    // is on always has a control showing it.
    if (state.status && !offered.has(state.status)) {
      groups.push(el('optgroup', { label: 'Selected' },
        option(state.status, statusLabel(), 0)
      ));
    }
    // Nothing to choose between: every row shares one status and one health.
    if (groups.length === 0) {
      return null;
    }

    return el('select', {
      class: 'status-picker',
      title: 'Status',
      onchange: (e) => {
        state.status = e.target.value;
        // A selection the filter now hides would leave the panel open on
        // something no longer in the table.
        if (state.selected && !inStatus(state.selected)) selectRow(null);
        renderFiltersOnly();
        renderContentOnly();
      }
    }, el('option', { value: '', selected: !state.status }, 'Any status'), ...groups);
  }

  /** The picker's selection in words, for the empty state and stale options. */
  function statusLabel() {
    const [scope, value] = statusParts(state.status);
    if (scope !== 'health') return value;
    const bucket = HEALTH_FILTERS.find((h) => h.value === value);
    return bucket ? bucket.label : value;
  }

  /**
   * A namespace only counts as a filter where it actually narrows the table;
   * on Overview and cluster-scoped kinds it is ignored, so it must not light up
   * the clear button there.
   */
  function filtersActive() {
    const ns = namespaceApplies() && state.namespace && state.namespace !== state.allNamespaces;
    return Boolean(ns || state.status || state.filter.trim() || state.scope);
  }

  function clearFilters() {
    state.filter = '';
    state.status = '';
    clearScope();
    if (state.namespace !== state.allNamespaces) {
      state.namespace = state.allNamespaces;
      post({ type: 'setNamespace', namespace: state.namespace });
    }
    // The filter row itself changes (the button greys out, the input empties,
    // the pickers reset), so this is a full render rather than content-only.
    render();
  }

  /** Reads back what is narrowing the table, for the empty state. */
  function activeFilterSummary() {
    const parts = [];
    if (namespaceApplies() && state.namespace && state.namespace !== state.allNamespaces) {
      parts.push(`namespace ${state.namespace}`);
    }
    if (state.status) parts.push(`status ${statusLabel().toLowerCase()}`);
    if (state.filter.trim()) parts.push(`query “${state.filter.trim()}”`);
    if (state.scope) parts.push(scopeSummary());
    return parts.join(' · ');
  }

  /**
   * The filter row exists only for the resource tables. It sits on its own line
   * under the toolbar because the pickers grow with the data — a cluster's
   * status words are not a fixed list — and would otherwise squeeze the title,
   * the count and the freshness label off the toolbar.
   */
  function showFilters() {
    return isTable() && !state.error;
  }

  /**
   * Drops the scope, in the one place that does it. The extension is told as
   * well: it re-resolves the owner set on every pod refresh, and one that is
   * still holding the target would push the scope straight back.
   */
  function clearScope() {
    if (!state.scope) return;
    state.scope = null;
    post({ type: 'clearScope' });
  }

  /**
   * Walks back out of a drill-down to the table it started from, landing the
   * cursor on the row that was clicked. `select` clears the origin along with
   * the scope, so it is read out first.
   */
  function goBack() {
    const origin = state.origin;
    if (!origin) return;
    select(origin.kind);
    // Set after `select`, which resets the cursor on a kind switch, so the
    // table is redrawn once more to show it. The key is the one `rowKey`
    // builds, so it matches whatever the table loads — and if the workload has
    // since been deleted, the cursor falls back to the top rather than
    // pointing at nothing.
    state.cursor = rowKey({ name: origin.name, namespace: origin.namespace });
    renderContentOnly();
  }

  /**
   * The way out of a drill-down, next to the chip saying what you drilled
   * into. It is separate from the chip's own dismiss: that one widens the pod
   * table to every pod, this one returns to the workload — two different
   * intentions that a single control kept conflating.
   */
  function renderBackButton() {
    if (!state.origin) return null;
    // The kind's own plural, rather than one built from the singular, so
    // Endpoints and the other kinds that are already plural read correctly.
    const label = kindOf(state.origin.kind)?.label ?? state.origin.kind;
    return el('button', {
      class: 'scope-back',
      title: `Back to ${label} (Esc)`,
      onclick: goBack
    }, `← ${label}`);
  }

  /** What the scope narrows to, in prose: 'owned by deployment web' or 'on node ip-10-0-1-5'. */
  function scopeSummary() {
    const { kind, name } = state.scope;
    return kind === 'nodes' ? `on node ${name}` : `owned by ${singularOf(kind).toLowerCase()} ${name}`;
  }

  /** A kind's singular label, for prose: 'deployments' -> 'Deployment'. */
  function singularOf(kindId) {
    const kind = kindOf(kindId);
    return kind ? kind.singular : kindId;
  }

  /**
   * The scope chip: what the table is narrowed to, and the way back out. It
   * leads the filter row because it is the strongest narrowing on screen — a
   * table showing three of four hundred pods has to say why — and it carries
   * its own dismiss rather than relying on Clear, which drops every filter at
   * once.
   */
  function renderScopeChip() {
    if (!state.scope) return null;
    const { kind, name, namespace, owners } = state.scope;
    // A Deployment matches through its ReplicaSets, and how many were found is
    // the difference between "no pods yet" and "the rollout has two revisions
    // live" — worth having in reach without being in the way.
    const via = kind === 'nodes' || (owners.length === 1 && owners[0] === name)
      ? ''
      : `\nMatching ${owners.length} ${owners.length === 1 ? 'ReplicaSet' : 'ReplicaSets'}: ${owners.join(', ') || 'none'}`;
    return el('div', {
      class: 'scope-chip',
      title: `Showing only pods ${scopeSummary()}`
        + (namespace ? ` in ${namespace}` : '') + via
    },
      el('span', { class: 'scope-kind', text: singularOf(kind) }),
      el('span', { class: 'scope-name', text: name }),
      el('button', {
        class: 'scope-clear',
        title: 'Show all pods again',
        onclick: () => { clearScope(); render(); }
      }, '\u00d7')
    );
  }

  /** Tooltip on the filter box; the query syntax is otherwise invisible. */
  const QUERY_HELP = [
    'Plain words match anywhere in the row.',
    'field:value narrows to one column — status:Running, ns:kube-system, node:ip-10-0-1-5',
    'Numbers and ages compare — restarts:>3, age:<2h, ready:<1',
    'A leading ! or minus excludes — !running, -status:Running, -kube',
    'Quote a value with spaces — reason:"Back-off restarting"',
    'Terms combine with AND.'
  ].join('\n');

  function renderFilters() {
    if (!showFilters()) return null;
    const input = el('input', {
      class: 'search',
      type: 'text',
      placeholder: 'Filter… try status:Running or restarts:>3',
      title: QUERY_HELP,
      value: state.filter,
      oninput: (e) => {
        state.filter = e.target.value;
        renderContentOnly();
        // Re-rendering the filter row here would steal focus mid-keystroke, so
        // the clear button is toggled in place instead.
        updateClearButton();
      }
    });
    return el('div', { class: 'filters' },
      renderBackButton(),
      renderScopeChip(),
      namespaceApplies() ? renderNamespacePicker() : null,
      renderStatusPicker(),
      input,
      el('button', {
        class: 'clear-filters',
        disabled: !filtersActive(),
        title: 'Clear every filter',
        onclick: clearFilters
      }, '✕ Clear')
    );
  }

  /**
   * Rebuilds the filter row in place, for when one control changes what
   * another offers. Focus is carried across by class, since replacing the node
   * the change event came from would otherwise drop the keyboard out of it —
   * and the filter box carries its caret across too, since rows landing under
   * a half-typed query come through here.
   */
  function renderFiltersOnly() {
    const node = app.querySelector('.filters');
    if (!node) return render();
    const focused = node.contains(document.activeElement)
      ? document.activeElement.className.split(' ')[0]
      : '';
    const caret = captureSearchFocus();
    const next = renderFilters();
    if (!next) return render();
    node.replaceWith(next);
    if (caret) {
      restoreSearchFocus(caret);
    } else if (focused) {
      const restored = app.querySelector(`.filters .${focused}`);
      if (restored) restored.focus();
    }
  }

  function renderMain() {
    // The action bar is a row of the main column rather than something inside
    // the scrolling content, so it is pinned to the bottom of the view without
    // overlaying the list or needing the list to reserve room for it.
    return el('div', { class: 'main' },
      renderToolbar(), renderFilters(), renderContent(), renderActionBar()
    );
  }

  function renderToolbar() {
    const kind = kindOf(state.active);
    const title = state.active === 'overview' ? 'Overview'
      : state.active === 'about' ? 'About'
        : kind ? kind.label : state.active;
    const children = [el('span', { class: 'title', text: title })];

    children.push(el('span', { class: 'spacer' }));

    const refreshError = renderRefreshError();
    if (refreshError) children.push(refreshError);

    children.push(renderFreshness());
    children.push(renderRefresh());
    // The filter row below draws its own separator, so the toolbar drops its
    // rule rather than stacking two lines a few pixels apart.
    return el('div', { class: 'toolbar' + (showFilters() ? ' with-filters' : '') }, ...children);
  }

  function renderRefreshError() {
    if (!state.refreshError) return null;
    return el('span', {
      class: 'refresh-error',
      title: state.refreshError,
      text: 'Refresh failed'
    });
  }

  /**
   * The refresh control, which is also where a fetch in flight is reported: the
   * button is disabled for the whole of one anyway, so rather than dimming a
   * control nobody can press, the spinner takes its place. Both are laid out on
   * the same fixed square, so the toolbar doesn't shift as they swap.
   */
  function renderRefresh() {
    if (state.busy) {
      return el('span', { class: 'refresh-slot busy', title: 'Refreshing…' },
        el('span', { class: 'spinner' })
      );
    }
    return el('button', {
      class: 'refresh-slot refresh',
      onclick: () => select(state.active),
      title: 'Refresh',
      'aria-label': 'Refresh'
    }, refreshMark());
  }

  /**
   * The refresh arrow, drawn rather than typed. `⟳` renders at whatever size
   * and weight the theme's font gives it — small inside its em box, and not the
   * same small on every platform — which left the button mostly padding. A path
   * in `currentColor` fills the square the slot reserves and is sized in CSS,
   * the way the brand mark is.
   */
  function refreshMark() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'refresh-mark');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    // An open circle with the gap at the top right, closed by an arrowhead —
    // the standard reload glyph, at a stroke weight that matches the rail's.
    const arc = document.createElementNS(ns, 'path');
    arc.setAttribute('d', 'M13.4 8a5.4 5.4 0 1 1-1.9-4.1');
    arc.setAttribute('fill', 'none');
    arc.setAttribute('stroke', 'currentColor');
    arc.setAttribute('stroke-width', '1.6');
    arc.setAttribute('stroke-linecap', 'round');
    const head = document.createElementNS(ns, 'path');
    head.setAttribute('d', 'M13.6 1.3v3.2h-3.2');
    head.setAttribute('fill', 'none');
    head.setAttribute('stroke', 'currentColor');
    head.setAttribute('stroke-width', '1.6');
    head.setAttribute('stroke-linecap', 'round');
    head.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(arc);
    svg.appendChild(head);
    return svg;
  }

  /**
   * How old the content on screen is. Sitting in the toolbar keeps it out of
   * the way of the content it describes. The spinner that used to sit beside it
   * now stands in for the refresh button; see `renderRefresh`.
   */
  function renderFreshness() {
    if (state.busy) {
      return el('span', { class: 'freshness busy', title: 'Refreshing…' },
        state.generated ? ago(state.generated) : 'Loading…'
      );
    }
    if (state.empty || state.error || !state.generated) {
      return el('span', { class: 'freshness' });
    }
    return el('span', {
      class: 'freshness' + (state.stale ? ' stale' : ''),
      title: new Date(state.generated).toLocaleString(),
      text: ago(state.generated)
    });
  }

  /**
   * Swaps the freshness label in place, so a refresh doesn't rebuild the view.
   * The refresh control tracks the same busy flag, so it is swapped in step
   * rather than waiting for the next full render.
   */
  function renderFreshnessOnly() {
    const node = app.querySelector('.toolbar .freshness');
    if (node) {
      node.replaceWith(renderFreshness());
    } else {
      render();
      return;
    }
    // The failure note sits just before the label and comes and goes with the
    // same payloads: a background refresh that succeeds has to take it away
    // without the full render a manual refresh gets.
    const oldError = app.querySelector('.toolbar .refresh-error');
    const newError = renderRefreshError();
    if (oldError && newError) oldError.replaceWith(newError);
    else if (oldError) oldError.remove();
    else if (newError) app.querySelector('.toolbar .freshness').before(newError);
    const slot = app.querySelector('.toolbar .refresh-slot');
    if (slot) slot.replaceWith(renderRefresh());
  }

  /** Enables or disables the clear button in place, for the same focus reason. */
  function updateClearButton() {
    const node = app.querySelector('.filters .clear-filters');
    if (node) node.disabled = !filtersActive();
  }

  function renderContentOnly() {
    syncPulse();
    const old = app.querySelector('.content');
    if (!old) return render();
    // The common case by a wide margin: a refresh, a sort or a tick on a table
    // that is already on screen, where only the rows differ. Updating them in
    // place keeps a text selection, a hover and the browser's find-on-page
    // alive across the 10s auto-refresh, none of which survive the node being
    // replaced — and on a large cluster it is the difference between rebuilding
    // thousands of rows and writing the handful of cells that moved.
    if (reconcileContent(old)) return;
    // Replacing the node loses where the list was scrolled to. That was
    // harmless while this only ran on kind switches and refreshes, but ticking
    // a row goes through here too, and jumping to the top of the table on every
    // click would make a long list impossible to select from.
    const scroll = old.scrollTop;
    const scrollX = old.scrollLeft;
    const detail = captureDetailScroll();
    const next = renderContent();
    old.replaceWith(next);
    next.scrollTop = scroll;
    next.scrollLeft = scrollX;
    restoreDetailScroll(detail);
    // The action bar is a sibling of the content, not part of it, but it
    // reports on the same rows — so it is refreshed in step. Ticking a row goes
    // through here, and the count would otherwise go stale.
    renderActionBarOnly(next);
  }

  /**
   * Tries to bring the content pane up to date without replacing it, and says
   * whether it managed. Only the table path qualifies: overview and about are
   * small enough that rebuilding them costs nothing, and the details modal has
   * its own state — an open select, a scrolled body — that a rebuild handles
   * through `captureDetailScroll` rather than through here.
   *
   * Anything that changes the shape of the pane rather than its rows returns
   * false, and the caller rebuilds.
   */
  function reconcileContent(content) {
    if (state.error || state.empty || !isTable()) return false;
    const kind = kindOf(state.active);
    if (!kind) return false;
    // A modal opening or closing changes what is in the pane beside the table.
    const hasModal = Boolean(content.querySelector('.modal'));
    if (hasModal !== Boolean(state.selected)) return false;
    // While one is open its contents track the selected row, which is not
    // something the table reconciler knows how to update.
    if (hasModal) return false;

    const table = content.querySelector('table');
    if (!table) return false;
    const columns = kind.columns.filter(
      (c) => !(c.key === 'namespace' && state.namespace !== state.allNamespaces)
    );
    const rows = visibleRows();
    if (!reconcileTable(table, rows, columns)) return false;

    // The header carries the sort arrow, and sorting comes through this path.
    updateTableHeader(table, columns, rows);
    // Counts and the select-all state are read off the same rows, which are
    // handed over rather than recomputed — `renderActionBar` would otherwise
    // filter and sort the whole cluster again for a number this pass already
    // has.
    renderActionBarOnly(content, rows);
    return true;
  }

  /**
   * Keeps the header's sort arrow and select-all box in step with the rows
   * under them. The header's own click handlers read `state.sort` when they
   * fire, so they never go stale and are left attached.
   */
  function updateTableHeader(table, columns, rows) {
    const head = table.tHead && table.tHead.rows[0];
    if (!head) return;
    const checkedHere = rows.filter(isChecked).length;
    const allChecked = rows.length > 0 && checkedHere === rows.length;
    const selectAll = head.querySelector('input.row-check');
    if (selectAll) {
      if (selectAll.checked !== allChecked) selectAll.checked = allChecked;
      selectAll.disabled = rows.length === 0;
      selectAll.indeterminate = checkedHere > 0 && checkedHere < rows.length;
      const label = allChecked ? 'Clear selection' : 'Select all rows shown';
      if (selectAll.getAttribute('aria-label') !== label) {
        selectAll.setAttribute('aria-label', label);
        selectAll.setAttribute('title', label);
      }
    }
    // Cells run one ahead of `columns`, the first being the checkbox column.
    columns.forEach((col, i) => {
      const th = head.cells[i + 1];
      if (!th) return;
      const active = state.sort.key === col.key;
      const arrow = th.querySelector('.arrow');
      if (active && !arrow) {
        th.appendChild(el('span', { class: 'arrow', text: state.sort.dir > 0 ? ' ▲' : ' ▼' }));
      } else if (!active && arrow) {
        arrow.remove();
      } else if (active && arrow) {
        const glyph = state.sort.dir > 0 ? ' ▲' : ' ▼';
        if (arrow.textContent !== glyph) arrow.textContent = glyph;
      }
    });
  }

  /**
   * Swaps the action bar in place. Takes the content node it belongs beside,
   * since on a kind switch the bar may need to appear or disappear and there is
   * nothing already in the DOM to replace.
   */
  function renderActionBarOnly(content, visible) {
    const existing = app.querySelector('.action-bar');
    const next = renderActionBar(visible);
    if (existing && next) {
      existing.replaceWith(next);
    } else if (existing) {
      existing.remove();
    } else if (next) {
      // Always the last row of the main column, after the content.
      (content ?? app.querySelector('.content'))?.after(next);
    }
  }

  /**
   * A stand-in drawn in the shape of whatever is being loaded: the About cards,
   * or the table's own columns on a resource kind. Because it occupies the same
   * geometry as the real content, arriving rows replace it without the pane
   * resizing, and there is nothing to delay — a shape carries no claim about
   * the cluster, so a cache replay overwriting it within a frame reads as the
   * content painting rather than as a message being retracted.
   *
   */
  function renderSkeleton() {
    if (state.active === 'about') return renderAboutSkeleton();
    if (state.active === 'overview') return renderOverviewSkeleton();
    return renderTableSkeleton();
  }

  /** The Overview's summary band, a few pod rows, and collapsed reason rows. */
  function renderOverviewSkeleton() {
    return el('div', { class: 'skeleton overview', 'aria-busy': 'true', 'aria-label': 'Loading' },
      el('div', { class: 'ov-summary' },
        el('div', { class: 'ov-stat' }, bar('54%'), el('div', { class: 'sk-bar sk-line', style: 'width: 38%' })),
        el('div', { class: 'ov-stat' }, bar('46%'), el('div', { class: 'sk-bar sk-line', style: 'width: 44%' })),
        el('div', { class: 'ov-stat' }, bar('50%'), el('div', { class: 'sk-bar sk-line', style: 'width: 34%' })),
        el('div', { class: 'ov-stat' }, bar('44%'), el('div', { class: 'sk-bar sk-line', style: 'width: 40%' }))
      ),
      el('div', { class: 'ov-pods' },
        ...['52%', '68%', '44%'].map((width) =>
          el('div', { class: 'ov-pod' },
            el('span', { class: 'sk-bar', style: 'width: 118px' }),
            el('span', { class: 'sk-bar', style: `width: ${width}` })
          )
        )
      ),
      ...['88%', '64%', '76%', '58%'].map((width) =>
        el('div', { class: 'ov-group' },
          el('div', { class: 'ov-group-head' },
            el('span', { class: 'sk-bar', style: 'width: 74px' }),
            el('span', { class: 'sk-bar', style: `width: ${width}` })
          )
        )
      )
    );
  }

  /** A bar of shimmering placeholder. Widths vary so rows don't read as a grid. */
  function bar(width) {
    return el('span', { class: 'sk-bar', style: `width: ${width}` });
  }

  /**
   * Mirrors the real table: same header row, same column count, same row
   * height. The kind's own columns are used when it declares them, so opening
   * Pods sketches a Pods table rather than a generic one.
   */
  function renderTableSkeleton() {
    const kind = kindOf(state.active);
    const columns = kind
      ? kind.columns.filter((c) => !(c.key === 'namespace' && state.namespace !== state.allNamespaces))
      : [{ label: 'Namespace' }, { label: 'Name' }, { label: 'Status' }, { label: 'Age' }];

    // Enough rows to fill a typical pane without implying a count: the skeleton
    // is cut off by the viewport either way.
    const widths = ['72%', '54%', '85%', '46%', '66%', '78%', '58%', '90%', '50%', '70%', '62%', '82%'];
    const rows = widths.map((seed, index) =>
      el('tr', { class: 'sk-row' },
        el('td', { class: 'check' }, el('span', { class: 'sk-bar sk-check' })),
        ...columns.map((col, col_index) =>
          el('td', {}, bar(col_index === 0 ? seed : widths[(index + col_index * 5) % widths.length]))
        )
      )
    );

    return el('div', { class: 'skeleton', 'aria-busy': 'true', 'aria-label': 'Loading' },
      el('table', {},
        el('thead', {}, el('tr', {},
          el('th', { class: 'check' }),
          ...columns.map((col) => el('th', { text: col.label }))
        )),
        el('tbody', {}, ...rows)
      )
    );
  }

  /** The About page's two cards, in their real proportions. */
  function renderAboutSkeleton() {
    return el('div', { class: 'skeleton about', 'aria-busy': 'true', 'aria-label': 'Loading' },
      el('div', { class: 'about-card' },
        el('h3', {}, bar('42%')),
        el('div', { class: 'sk-bar sk-line' }),
        el('div', { class: 'sk-bar sk-line', style: 'width: 76%' })
      ),
      el('div', { class: 'about-card' },
        el('h3', {}, bar('30%')),
        el('div', { class: 'sk-bar sk-line', style: 'width: 64%' }),
        el('div', { class: 'sk-bar sk-line', style: 'width: 48%' })
      )
    );
  }

  function renderContent() {
    if (state.error) {
      return el('div', { class: 'content' }, el('div', { class: 'state error', text: state.error }));
    }
    if (state.empty) {
      // Nothing cached and nothing fetched yet. A skeleton in the shape of the
      // view being opened can be drawn immediately — unlike a "Loading…" label,
      // which had to be delayed so a cache replay wouldn't flash it — so the
      // pane is never blank and the layout doesn't jump when the rows land.
      return el('div', { class: 'content' }, renderSkeleton());
    }
    const content = state.active === 'overview'
      ? el('div', { class: 'content' }, renderOverview())
      : state.active === 'about'
        ? el('div', { class: 'content' }, renderAbout())
        : el('div', { class: 'content' }, renderTable());
    if (state.selected && isTable()) {
      content.appendChild(renderModal());
    }
    return content;
  }

  /**
   * What is going wrong in the cluster right now, in the order someone triaging
   * reads it: the pods that are not healthy, then the Warning events behind
   * them.
   *
   * Pods lead because they are the thing to act on — a pod is a name you can
   * restart, get logs from or describe, while an event is a sentence about one.
   * The events stay because they carry the *why* and because plenty of failures
   * (failed mounts, evictions, scheduling) are reported against objects that
   * are not pods at all.
   *
   * The events are grouped rather than listed flat because warnings arrive in
   * floods — one crash-looping pod writes a BackOff every couple of minutes —
   * and a flat log buries five distinct problems under four hundred repetitions
   * of the loudest one. The reasons are the problems; the occurrences under
   * them are evidence, so they stay folded away until asked for.
   */
  function renderOverview() {
    const overview = state.overview;
    if (!overview) {
      return el('div', { class: 'overview', 'aria-busy': 'true' },
        ...Array.from(renderOverviewSkeleton().children));
    }
    // Older cached payloads predate the pods section and carry no `pods` field.
    // Treating that as "none" rather than letting it throw keeps a replayed
    // entry rendering until the refresh behind it lands.
    const pods = overview.pods || [];

    if (!overview.rows.length && !pods.length) {
      // Three different quiets, and the differences matter. A cluster with
      // healthy pods and no warnings is genuinely well; one holding no events
      // at all has told us nothing about its recent past — its retention window
      // has expired, and "no warnings" would be a claim the data does not
      // support.
      const detail = overview.total
        ? `${count(overview.total, 'event')} in the cluster, none of them warnings.`
        : 'No events are being held — they expire after about an hour by default, so this says nothing about the recent past.';
      return el('div', { class: 'state' },
        el('div', { class: 'ov-clear', text: '✓ All clear' }),
        el('div', { class: 'state-detail', text: overview.podTotal
          ? `All ${overview.podTotal} pods are healthy. ${detail}`
          : detail })
      );
    }

    return el('div', { class: 'overview' },
      renderOverviewSummary(overview, pods),
      pods.length ? renderUnhealthyPods(pods) : null,
      overview.rows.length
        ? el('div', { class: 'ov-section' },
          ovHeading('Warning events', overview.rows.length),
          el('div', { class: 'ov-groups' }, ...overview.groups.map(renderReasonGroup)))
        : null
    );
  }

  /** The figures that answer "how bad is it" before anything is read. */
  function renderOverviewSummary(overview, pods) {
    const total = overview.podTotal;
    return el('div', { class: 'ov-summary' },
      ovStat(String(pods.length),
        count(pods.length, 'pod') + ' unhealthy',
        pods.length ? 'bad' : 'ok',
        total ? `of ${count(total, 'pod')} in the cluster` : undefined),
      ovStat(String(overview.rows.length), count(overview.rows.length, 'warning'),
        overview.rows.length ? 'warn' : undefined),
      ovStat(String(overview.groups.length), count(overview.groups.length, 'distinct reason')),
      ovStat(String(overview.namespaces.length),
        count(overview.namespaces.length, 'namespace') + ' affected',
        undefined, overview.namespaces.join(', '))
    );
  }

  /** A section title with the count it covers, so neither list is a surprise. */
  function ovHeading(text, n) {
    return el('div', { class: 'ov-heading' },
      el('span', { text }),
      el('span', { class: 'ov-heading-count', text: String(n) })
    );
  }

  /**
   * The unhealthy pods, one row each — no grouping. There are rarely many (a
   * cluster with fifty broken pods has one broken thing, and its events say
   * which), and a pod's name is the whole point: it is what gets typed into the
   * next command. Clicking one opens the Pods table with that pod selected,
   * where logs, describe and the container list already live.
   */
  function renderUnhealthyPods(pods) {
    return el('div', { class: 'ov-section' },
      ovHeading('Unhealthy pods', pods.length),
      el('div', { class: 'ov-pods' }, ...pods.map(renderUnhealthyPod))
    );
  }

  function renderUnhealthyPod(row) {
    const restarts = Number(row.cells.restarts || 0);
    return el('button', {
      class: 'ov-pod',
      title: 'Open in Pods',
      onclick: () => openPod(row)
    },
      el('span', { class: 'pill ' + row.health, text: row.cells.status || row.status }),
      el('span', { class: 'ov-pod-name' },
        row.namespace ? el('span', { class: 'ov-ns', text: row.namespace }) : null,
        el('span', { class: 'ov-object', text: row.name })
      ),
      el('span', { class: 'spacer' }),
      el('span', { class: 'ov-ready', title: 'Containers ready', text: row.cells.ready || '' }),
      // Zero restarts is the normal case and a column of "0" is noise; a
      // restart count only earns space once there is one to report.
      restarts ? el('span', { class: 'ov-restarts', title: count(restarts, 'restart'), text: '↻' + restarts }) : null,
      el('span', {
        class: 'ov-age',
        title: formatTimestamp(row.created),
        'data-age-from': row.created || undefined
      }, row.created ? formatAge(row.created) : '')
    );
  }

  /**
   * Jumps to the Pods table with this pod selected. The row travels as-is
   * rather than being looked up after the switch: `select` clears the rows and
   * the extension's reply is a round-trip away, so waiting for it would leave
   * the panel empty for as long as the load takes. The rows that arrive carry
   * the same key, and the selection survives them.
   */
  function openPod(row) {
    select('pods');
    selectRow(row);
    render();
  }

  function ovStat(value, label, health, title) {
    return el('div', { class: 'ov-stat' + (health ? ' ' + health : ''), title: title || undefined },
      el('span', { class: 'ov-stat-value', text: value }),
      el('span', { class: 'ov-stat-label', text: label })
    );
  }

  /** "1 warning" / "4 warnings", so the summary never reads "1 warnings". */
  function count(n, noun) {
    return `${n} ${noun}${n === 1 ? '' : 's'}`;
  }

  /**
   * One reason, folded. The head carries the reason, how many occurrences the
   * cluster counted, and the newest one's target and age — enough to triage
   * without expanding, since the newest occurrence is usually the story.
   */
  function renderReasonGroup(group) {
    const open = state.openReasons.has(group.reason);
    const newest = group.rows[0];
    // The cluster's repeat count, not the number of records: `count` on a
    // single event can be in the hundreds on its own.
    const occurrences = group.count;

    const head = el('button', {
      class: 'ov-group-head',
      'aria-expanded': String(open),
      onclick: () => {
        if (open) state.openReasons.delete(group.reason);
        else state.openReasons.add(group.reason);
        renderContentOnly();
      }
    },
      el('span', { class: 'ov-caret', text: open ? '▾' : '▸' }),
      el('span', { class: 'ov-reason', text: group.reason }),
      el('span', { class: 'ov-count', title: `${occurrences} occurrence${occurrences === 1 ? '' : 's'} across ${count(group.rows.length, 'event')}` },
        String(occurrences)),
      el('span', { class: 'ov-newest' },
        el('span', { class: 'ov-object', text: newest.cells.object || newest.name }),
        el('span', {
          class: 'ov-age',
          title: formatTimestamp(newest.created),
          'data-age-from': newest.created || undefined,
          'data-age-suffix': ' ago'
        }, newest.created ? formatAge(newest.created) + ' ago' : '')
      )
    );

    return el('div', { class: 'ov-group' + (open ? ' open' : '') },
      head,
      open ? el('div', { class: 'ov-events' }, ...group.rows.map(renderOverviewEvent)) : null
    );
  }

  /** One occurrence: where, what it said, and when it was last seen. */
  function renderOverviewEvent(row) {
    return el('div', { class: 'ov-event' },
      el('div', { class: 'ov-event-head' },
        row.namespace
          ? el('span', { class: 'ov-ns', text: row.namespace })
          : null,
        el('span', { class: 'ov-object', text: row.cells.object || row.name }),
        Number(row.cells.count) > 1
          ? el('span', { class: 'ov-repeat', title: 'Times the cluster saw this', text: '×' + row.cells.count })
          : null,
        el('span', { class: 'spacer' }),
        el('span', {
          class: 'ov-age',
          title: formatTimestamp(row.created),
          'data-age-from': row.created || undefined,
          'data-age-suffix': ' ago'
        }, row.created ? formatAge(row.created) + ' ago' : '')
      ),
      el('div', { class: 'ov-message', text: row.cells.message || '' })
    );
  }

  /** A label/value pair; values are monospaced, since most are identifiers. */
  function field(label, value, mono = true) {
    return el('div', { class: 'field' },
      el('span', { class: 'field-label', text: label }),
      el('span', { class: 'field-value' + (mono ? ' mono' : ''), title: value, text: value })
    );
  }

  /**
   * About: the versions on both ends of the connection, whether they are
   * compatible, and who the cluster thinks you are.
   */
  function renderAbout() {
    const about = state.about;
    if (!about) {
      // Reached when the tab is opened before its first payload lands; same
      // skeleton treatment as the table views rather than an empty pane.
      return renderAboutSkeleton();
    }
    const client = about.client || {};
    const server = about.server || {};
    const verdict = about.skew || { health: 'muted', label: 'Unknown', detail: '' };

    // The verdict leads: it is the question the page answers. The two versions
    // sit under it as the evidence, rather than making the reader compare
    // version strings themselves.
    const compat = el('div', { class: 'about-card compat ' + verdict.health },
      el('div', { class: 'compat-head' },
        el('span', { class: 'pill ' + verdict.health }, verdict.label),
        el('h3', { text: 'Version compatibility' })
      ),
      el('div', { class: 'compat-versions' },
        el('div', { class: 'version-side' },
          el('span', { class: 'side-label', text: 'kubectl (client)' }),
          el('span', { class: 'side-version mono', text: client.gitVersion || 'unknown' }),
          client.platform ? el('span', { class: 'side-meta', text: client.platform }) : null
        ),
        el('span', { class: 'compat-arrow ' + verdict.health, text: '⟷' }),
        el('div', { class: 'version-side' },
          el('span', { class: 'side-label', text: 'Cluster (server)' }),
          el('span', {
            class: 'side-version mono' + (about.serverError ? ' unreachable' : ''),
            text: server.gitVersion || 'unreachable'
          }),
          server.platform ? el('span', { class: 'side-meta', text: server.platform }) : null
        )
      ),
      verdict.detail ? el('p', { class: 'compat-detail', text: verdict.detail }) : null,
      about.serverError
        ? el('p', { class: 'compat-error', text: about.serverError })
        : null
    );

    // Identity. A failure here is expected on older clusters and under RBAC, so
    // it is explained in place instead of being shown as a broken panel.
    const identity = el('div', { class: 'about-card' },
      el('h3', { text: 'Authorized as' }),
      about.who
        ? el('div', { class: 'fields' },
            field('Username', about.who.username || '(none reported)'),
            about.who.uid ? field('UID', about.who.uid) : null,
            el('div', { class: 'field' },
              el('span', { class: 'field-label', text: 'Groups' }),
              el('span', { class: 'field-value groups' },
                ...(about.who.groups && about.who.groups.length
                  ? about.who.groups.map((g) => el('span', { class: 'chip mono', text: g }))
                  : [el('span', { class: 'field-value', text: '(none)' })])
              )
            )
          )
        : el('div', { class: 'identity-missing' },
            el('p', { text: 'Could not determine the authenticated user.' }),
            el('p', { class: 'why', text: about.error || '' }),
            el('p', { class: 'why', text: 'kubectl auth whoami needs Kubernetes 1.27 or newer and permission to create a SelfSubjectReview.' })
          ),
      // The kubeconfig's own idea of the user is a local label chosen by
      // whoever wrote the file, not the identity the cluster authenticated.
      // It is set apart so it cannot be read as part of the answer above.
      about.user
        ? el('div', { class: 'aside' }, field('kubeconfig user', about.user))
        : null
    );

    const connection = el('div', { class: 'about-card' },
      el('h3', {}, 'Connection'),
      el('div', { class: 'fields' },
        field('Context', about.context),
        about.cluster ? field('Cluster', about.cluster) : null,
        field('Default namespace', about.namespace || '(none set)')
      )
    );

    // The kubectl plugins on PATH. Names lead, since a name is what you type;
    // the path is the answer to "which one of these is running", so it rides
    // along quietly on the right rather than competing with the name.
    const pluginList = about.plugins || [];
    const plugins = el('div', { class: 'about-card' },
      el('h3', {},
        'Enabled plugins',
        pluginList.length
          ? el('span', { class: 'count-badge', text: String(pluginList.length) })
          : null
      ),
      about.pluginsError
        ? el('p', { class: 'compat-error', text: about.pluginsError })
        : pluginList.length
          ? el('div', { class: 'plugin-list' },
              ...pluginList.map((p) => el('div', { class: 'plugin-row' },
                el('span', { class: 'plugin-name mono', text: p.name }),
                el('span', { class: 'plugin-path mono', title: p.path, text: p.path })
              ))
            )
          : el('div', { class: 'identity-missing' },
              el('p', { text: 'No kubectl plugins found on PATH.' }),
              el('p', { class: 'why', text: 'Plugins are executables named kubectl-* on your PATH; krew installs them into ~/.krew/bin.' })
            )
    );

    // Build rows are grouped by side rather than interleaved, so a missing
    // server half just drops its column instead of leaving gaps in a grid.
    const buildSide = (label, version) => {
      const rows = [
        version.goVersion ? field('Go', version.goVersion) : null,
        version.buildDate ? field('Built', formatDate(version.buildDate), false) : null
      ].filter(Boolean);
      return rows.length
        ? el('div', { class: 'build-side' },
            el('span', { class: 'side-label', text: label }),
            el('div', { class: 'fields' }, ...rows)
          )
        : null;
    };
    const sides = [buildSide('kubectl', client), buildSide('Cluster', server)].filter(Boolean);
    const build = sides.length
      ? el('div', { class: 'about-card' },
          el('h3', { text: 'Build details' }),
          el('div', { class: 'build-grid' }, ...sides)
        )
      : null;

    // Local storage, not cluster state — the only card on the page that is
    // about the extension rather than the connection, so it sits last and
    // explains what clearing it costs before offering the button.
    const stats = state.cacheStats;
    const empty = !stats || !stats.entries;
    const cache = el('div', { class: 'about-card' },
      el('h3', {},
        'Local cache',
        stats ? el('span', { class: 'count-badge', text: formatBytes(stats.bytes) }) : null
      ),
      el('p', { class: 'cache-note', text: empty
        ? 'Nothing cached yet. Views you open are kept here so a reopened dashboard paints immediately instead of waiting on kubectl.'
        : `${stats.entries} cached ${stats.entries === 1 ? 'view' : 'views'} across all contexts, so a reopened dashboard paints immediately instead of waiting on kubectl.` }),
      el('div', { class: 'cache-actions' },
        el('button', {
          class: 'danger',
          disabled: empty,
          onclick: () => post({ type: 'clearCache' })
        }, 'Clear cache'),
        el('span', { class: 'cache-why', text: 'Clears stored data only; nothing in any cluster is touched.' })
      ),
      // What happens to the cache on an update, under the card that shows what
      // is in it. The box is inside its own label so the words are part of the
      // click target, and the caveat sits below rather than in a tooltip: it is
      // the cost of leaving this on, so it has to be readable without unticking.
      el('label', { class: 'cache-option' },
        el('input', {
          type: 'checkbox',
          class: 'row-check',
          checked: state.preserveCache,
          onchange: (e) => post({ type: 'setPreserveCache', preserve: e.target.checked })
        }),
        el('span', {},
          el('span', { class: 'cache-option-label', text: 'Preserve cache after updates' }),
          el('span', { class: 'cache-why', text: 'A view cached by an older build can paint blank cells until its first refresh replaces it. Untick to start each update with an empty cache.' })
        )
      )
    );

    return el('div', { class: 'about' }, compat, identity, connection, plugins, build, cache);
  }

  /** A cache size is read as a magnitude, so it never shows more than one decimal. */
  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
  }

  /** A build date is only ever read as a rough "how old is this". */
  function formatDate(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? iso
      : `${date.toLocaleDateString()} · ${formatAge(iso)} ago`;
  }

  const AGE_UNITS = { s: 1, m: 60, h: 3600, d: 86400, y: 31536000 };

  /**
   * Returns a number for values that should sort numerically rather than
   * lexically: ages ("90d"), ready counts ("2/3"), restarts ("7").
   * Returns null when the value is plain text.
   */
  function numericValue(text) {
    if (text === '') return null;
    // Ages come in one or two segments — "5d", "2y271d" — so every segment is
    // summed rather than only the first; matching just one would leave "2y36d"
    // and "2y271d" to sort as text, where "36d" lands after "271d".
    if (/^(\d+[smhdy])+$/.test(text)) {
      let seconds = 0;
      for (const [, count, unit] of text.matchAll(/(\d+)([smhdy])/g)) {
        seconds += Number(count) * AGE_UNITS[unit];
      }
      return seconds;
    }
    const ratio = /^(\d+)\/(\d+)$/.exec(text);
    if (ratio) return Number(ratio[1]) / Math.max(1, Number(ratio[2]));
    return /^\d+$/.test(text) ? Number(text) : null;
  }

  /**
   * Rows always arrive spanning every namespace, so the picker narrows what is
   * on screen rather than triggering a re-fetch. Cluster-scoped rows carry no
   * namespace and are never hidden by it.
   */
  function inNamespace(row) {
    if (state.namespace === state.allNamespaces || !state.namespace) return true;
    return !row.namespace || row.namespace === state.namespace;
  }

  /**
   * True when a row belongs to the workload the table is scoped to. A pod
   * qualifies by naming one of the scope's owners — its ReplicaSet, or the
   * workload itself — and by sitting in the same namespace, since owner names
   * are only unique within one.
   */
  function inScope(row) {
    if (!state.scope) return true;
    if (state.scope.kind === 'nodes') return row.cells.node === state.scope.name;
    if (state.scope.namespace && row.namespace !== state.scope.namespace) return false;
    return Boolean(row.owner && state.scope.owners.includes(row.owner.name));
  }

  /**
   * The health buckets the status picker offers. They cut across kinds — "show
   * me what is broken" is the same question whether the table holds pods or
   * nodes — where the status words underneath them are kind-specific.
   */
  const HEALTH_FILTERS = [
    { value: 'problem', label: 'Problems', test: (r) => r.health === 'bad' || r.health === 'warn' },
    { value: 'bad', label: 'Failing', test: (r) => r.health === 'bad' },
    { value: 'warn', label: 'Warning / pending', test: (r) => r.health === 'warn' },
    { value: 'ok', label: 'Healthy', test: (r) => r.health === 'ok' },
    { value: 'muted', label: 'Inactive', test: (r) => r.health === 'muted' }
  ];

  /** Splits an encoded picker token into its scope and value. */
  function statusParts(token) {
    const index = token.indexOf(':');
    return index < 0 ? ['', token] : [token.slice(0, index), token.slice(index + 1)];
  }

  function inStatus(row) {
    if (!state.status) return true;
    const [scope, value] = statusParts(state.status);
    if (scope !== 'health') return row.status === value;
    const bucket = HEALTH_FILTERS.find((h) => h.value === value);
    // An unknown bucket can only come from a stale token; widening beats
    // hiding every row behind a filter that no longer means anything.
    return bucket ? bucket.test(row) : true;
  }

  /**
   * Short field names the query accepts on top of the kind's own column keys,
   * so the common ones are one or two characters to type.
   */
  const QUERY_ALIASES = { ns: 'namespace', n: 'name', s: 'status' };

  /**
   * Fields a scoped term may address. `name`, `namespace` and `status` are on
   * every row even where the table has no such column — events drop the name
   * column but their rows still carry one.
   */
  function queryKeys(kind) {
    const keys = new Set(['name', 'namespace', 'status']);
    for (const column of kind ? kind.columns : []) keys.add(column.key);
    return keys;
  }

  /**
   * Whitespace splits terms, except inside double quotes, so a value with a
   * space in it — reason:"Back-off restarting" — survives as one term.
   */
  function splitTerms(text) {
    return text.match(/(?:[^\s"]|"[^"]*")+/g) || [];
  }

  /**
   * Parses one term. A leading '-' or '!' negates it — neither starts a
   * Kubernetes name, so nothing legitimate is shadowed. `key:value` scopes the
   * match to one field, and <, >, <= or >= in front of the value compares
   * numerically instead of matching text. An unrecognised key is not an error:
   * the term falls back to plain text, so a name that contains a colon still
   * finds itself rather than silently matching nothing.
   */
  function parseTerm(raw, keys) {
    const negated = raw.length > 1 && (raw.startsWith('-') || raw.startsWith('!'));
    const text = negated ? raw.slice(1) : raw;
    const scoped = /^([A-Za-z][\w.-]*):(.*)$/.exec(text);
    if (scoped) {
      const key = QUERY_ALIASES[scoped[1].toLowerCase()] ?? scoped[1];
      if (keys.has(key)) {
        const value = scoped[2].replace(/"/g, '');
        const compared = /^(>=|<=|>|<|=)(.+)$/.exec(value);
        return compared
          ? { negated, key, op: compared[1], value: compared[2] }
          : { negated, key, op: '', value: value.toLowerCase() };
      }
    }
    return { negated, key: '', op: '', value: text.replace(/"/g, '').toLowerCase() };
  }

  function parseQuery(text, kind) {
    const keys = queryKeys(kind);
    return splitTerms(text.trim())
      .map((raw) => parseTerm(raw, keys))
      .filter((term) => term.value !== '');
  }

  /**
   * A comparison only means anything when both sides read as numbers, and
   * `numericValue` already knows the shapes a cell takes — an age ("7d"), a
   * ready ratio ("2/3"), a plain count. Anything else simply does not match,
   * rather than being compared as text and giving a confident wrong answer.
   */
  function compareCell(cell, op, value) {
    const left = numericValue(cell);
    const right = numericValue(value);
    if (left === null || right === null) return false;
    switch (op) {
      case '>': return left > right;
      case '<': return left < right;
      case '>=': return left >= right;
      case '<=': return left <= right;
      default: return left === right;
    }
  }

  function matchesTerm(row, term) {
    if (!term.key) return row.search.includes(term.value);
    const cell = cellValue(row, term.key);
    return term.op
      ? compareCell(cell, term.op, term.value)
      : cell.toLowerCase().includes(term.value);
  }

  /** Terms combine with AND; a negated term must not match. */
  function matchesQuery(row, terms) {
    return terms.every((term) => matchesTerm(row, term) !== term.negated);
  }

  function visibleRows() {
    const terms = parseQuery(state.filter, kindOf(state.active));
    const rows = state.rows.filter(
      (row) => inScope(row) && inNamespace(row) && inStatus(row) && matchesQuery(row, terms)
    );
    const { key, dir } = state.sort;
    return rows.sort((a, b) => {
      const an = sortValue(a, key);
      const bn = sortValue(b, key);
      const cmp =
        an !== null && bn !== null
          ? an - bn
          : String(cellValue(a, key)).localeCompare(String(cellValue(b, key)));
      // Fall back to name so equal keys keep a stable, predictable order.
      return (cmp || a.name.localeCompare(b.name)) * dir;
    });
  }

  function renderTable() {
    const kind = kindOf(state.active);
    if (!kind) return el('div', { class: 'state', text: 'Unknown resource.' });

    const rows = visibleRows();
    const noun = kind.label.toLowerCase();

    // An empty result is reported inside the table rather than in place of it.
    // The header carries the column names and the sort, which are how you tell
    // a filtered-out table from an empty cluster and how you get back — so
    // replacing the whole table with a message took away the controls at
    // exactly the moment they are needed.
    // state.rows always spans the cluster, so an empty one means the cluster
    // really has none; anything else is the namespace or text filter at work.
    const empty = state.rows.length === 0
      ? el('div', { class: 'state' }, el('div', { text: `No ${noun} in this cluster.` }))
      : rows.length === 0
        // Filters combine now, so the message names what is actually on rather
        // than guessing which one emptied the table.
        ? el('div', { class: 'state' },
            el('div', { text: `No ${noun} match the current filters.` }),
            el('div', { class: 'state-detail', text: activeFilterSummary() }),
            el('button', { class: 'clear-inline', onclick: clearFilters }, 'Clear filters')
          )
        : null;

    // Namespace is redundant unless we're looking across all of them.
    const columns = kind.columns.filter(
      (c) => !(c.key === 'namespace' && state.namespace !== state.allNamespaces)
    );

    // Ticking every visible row, or clearing them. Indeterminate whenever the
    // ticked rows are only some of what is on screen, so the header reads as a
    // summary of the column under it rather than just a button.
    const checkedHere = rows.filter(isChecked).length;
    // With no rows under it there is nothing to select, so the control is
    // disabled rather than offering to tick an empty table.
    const allChecked = rows.length > 0 && checkedHere === rows.length;
    const selectAll = el('input', {
      type: 'checkbox',
      class: 'row-check',
      disabled: rows.length === 0 || undefined,
      title: allChecked ? 'Clear selection' : 'Select all rows shown',
      'aria-label': allChecked ? 'Clear selection' : 'Select all rows shown',
      checked: allChecked,
      onchange: (e) => {
        // Only the visible rows: a filtered-out row is not something the user
        // can see to un-tick, so it must not be ticked on their behalf.
        // Recomputed rather than closed over: the header now outlives the rows
        // it was built with, so the set to tick is whatever is on screen when
        // the box is actually clicked.
        for (const row of visibleRows()) {
          if (e.target.checked) {
            state.checked.add(checkKey(row));
          } else {
            state.checked.delete(checkKey(row));
          }
        }
        renderContentOnly();
      }
    });
    selectAll.indeterminate = checkedHere > 0 && checkedHere < rows.length;

    const head = el('tr', {},
      // Sorting is bound to a th's click; this one holds a control instead, so
      // it deliberately carries no sort handler.
      el('th', { class: 'check' }, selectAll),
      ...columns.map((col) => {
        const active = state.sort.key === col.key;
        return el('th', {
          class: [
            col.secondary ? 'secondary' : '',
            col.numeric ? 'numeric' : '',
            col.key === 'message' ? 'message' : ''
          ].filter(Boolean).join(' '),
          onclick: () => {
            // `state.sort` is read here rather than through the `active` above:
            // the header survives refreshes now, so a flag captured when it was
            // built would describe an older sort than the one being toggled.
            const on = state.sort.key === col.key;
            state.sort = on ? { key: col.key, dir: -state.sort.dir } : { key: col.key, dir: 1 };
            renderContentOnly();
          }
        }, col.label, active ? el('span', { class: 'arrow', text: state.sort.dir > 0 ? ' ▲' : ' ▼' }) : null);
      })
    );

    const body = rows.map((row, index) => buildRow(row, index, rows, columns));

    // The message spans every column so it sits under the whole header rather
    // than squeezing into the first one. +1 covers the checkbox column, which
    // precedes the kind's own.
    const tbody = empty
      ? el('tbody', {}, el('tr', { class: 'empty-row' },
          el('td', { class: 'empty-cell', colspan: String(columns.length + 1) }, empty)
        ))
      : el('tbody', {}, ...body);

    // Stamped so a later repaint can tell whether the table on screen is the
    // same shape as the one being drawn now. A kind switch changes the columns
    // under the same `.content`, and reconciling one kind's rows into another's
    // would keep the old header's cells; comparing this rules that out cheaply.
    const table = el('table', { 'data-kind': state.active, 'data-cols': columnSignature(columns) },
      el('thead', {}, head), tbody);
    return table;
  }

  /**
   * One table row, built from scratch. Split out of `renderTable` so the
   * reconciler can rebuild a single row without redrawing the table around it —
   * both paths then agree on what a row is by construction rather than by two
   * copies of the same markup being kept in step by hand.
   */
  function buildRow(row, index, rows, columns) {
    {
      const selected = isSelected(row);
      const ticked = isChecked(row);

      // What this row currently stands for. The handlers below close over this
      // record rather than over `row`, `index` and `rows` directly, so a
      // reconciled row can be repointed at the refreshed object by writing its
      // fields — without detaching listeners, which would mean replacing the
      // node and losing the selection this whole path exists to keep.
      // `cells` and `check` are the nodes this row writes into, kept here so a
      // refresh doesn't have to find them again: reaching them through
      // `tr.children` and `querySelector` on every row was, at a few thousand
      // rows, most of the cost of a refresh — the lookups outweighed the
      // handful of writes they led to.
      const live = { row, index, rows, cells: null, check: null };

      // The row opens details now, so ticking belongs to this box and the cell
      // around it, which handles the mouse for both. Only the keyboard is left
      // here: space on a focused box fires change without a click.
      const check = el('input', {
        type: 'checkbox',
        class: 'row-check',
        checked: ticked,
        'aria-label': `Select ${row.name}`,
        onchange: (e) => {
          // The cell has already handled anything that came from a click,
          // leaving state and DOM in agreement; only a keyboard toggle arrives
          // here with them out of step.
          if (e.target.checked === isChecked(live.row)) return;
          toggleChecked(live.rows, live.index, e.target.checked, null);
        }
      });

      // A failing or pending object is worth spotting without reading the
      // status column.
      const tr = el('tr', {
        'data-key': rowKey(row),
        class: [
          selected ? 'selected' : '',
          ticked ? 'checked' : '',
          isCursor(row) ? 'cursor' : '',
          isMenuRow(row) ? 'menu-open' : '',
          row.health === 'bad' ? 'bad' : row.health === 'warn' ? 'warn' : ''
        ].filter(Boolean).join(' '),
        // Opening details is what a row click is for. It is the common thing
        // to want from a single object, so it gets the whole row as its target
        // rather than a control hunted for somewhere along it; ticking, which
        // is for acting on several at once, keeps the checkbox and the
        // keyboard.
        onclick: () => {
          selectRow(isSelected(live.row) ? null : live.row);
          renderContentOnly();
        },
        oncontextmenu: (e) => {
          e.preventDefault();
          openRowMenu(e, tr, live.row);
        }
      },
        // The whole cell ticks, not just the 13px box inside it. Ticking is the
        // only thing this column does and the box is now the sole mouse route
        // to it, so the target is the cell's full height and padding rather
        // than the control's own drawn size. The box's own click is left to
        // bubble to here, so there is one handler for both.
        el('td', {
          class: 'check',
          onclick: (e) => {
            e.stopPropagation();
            // A click on the box itself has already flipped it; a click on the
            // cell around it has not, so the intended state is read from the
            // box only when it was the thing clicked.
            const next = e.target === check ? check.checked : !isChecked(live.row);
            toggleChecked(live.rows, live.index, next, e);
          }
        }, check),
        ...columns.map((col) => {
          const value = cellValue(row, col.key);
          const classes = [
            col.secondary ? 'secondary' : '',
            col.numeric ? 'numeric' : '',
            col.key === 'name' ? 'name' : '',
            col.key === 'message' ? 'message' : ''
          ].filter(Boolean).join(' ');
          if (col.key === 'status') {
            return el('td', { class: classes, 'data-col': col.key },
              el('span', { class: 'pill ' + row.health }, value));
          }
          // An age cell carries the timestamp it was computed from, so the
          // ticker can rewrite it each second without a render — and without
          // the row's identity, which is what makes a cheap text swap safe.
          if (isAgeColumn(col.key) && row.created) {
            return el('td', {
              class: classes,
              title: formatTimestamp(row.created),
              'data-col': col.key,
              'data-age-from': row.created
            }, value);
          }
          return el('td', { class: classes, title: value, 'data-col': col.key }, value);
        })
      );
      // Snapshotted once, here, where the row's shape is known: the cells are
      // in column order after the checkbox cell, and nothing reorders them
      // afterwards — a row whose columns change is rebuilt, not updated.
      live.cells = Array.prototype.slice.call(tr.children, 1);
      live.check = check;
      rowState.set(tr, live);
      return tr;
    }
  }

  /**
   * The object and position each rendered row currently stands for, keyed by
   * its node. A WeakMap so a row dropped from the table is collectable with
   * nothing to unregister — on a cluster whose pods turn over steadily, an
   * ordinary Map here would be a slow leak for as long as the panel is open.
   */
  const rowState = new WeakMap();

  /**
   * Whether two versions of the same row would draw identically. Compares the
   * `cells` map the columns are read from, plus the two fields that are drawn
   * from the row itself rather than from a cell: `health` colours the row and
   * the status pill, and `created` is what the age ticker counts from.
   *
   * Age cells are skipped. Their text on screen is never the string in `cells`
   * — `cellValue` recomputes it from `created`, and the ticker rewrites it
   * every second — but the fetched string is a fresh measurement each time, so
   * comparing it reported every row as changed as soon as its age rolled over
   * a unit, which on a young object is every fetch. `created` is compared
   * above, and that is the only thing about an age that can actually move.
   *
   * Only ever used to skip work, so it is deliberately conservative: an added
   * or removed key, or anything it doesn't know to compare, reads as different
   * and the cells are examined one by one as before.
   */
  function sameCells(a, b) {
    if (a.health !== b.health || a.created !== b.created) return false;
    const before = a.cells;
    const after = b.cells;
    if (before === after) return true;
    if (!before || !after) return false;
    const keys = Object.keys(after);
    if (keys.length !== Object.keys(before).length) return false;
    for (const key of keys) {
      if (isAgeColumn(key)) continue;
      if (before[key] !== after[key]) return false;
    }
    return true;
  }

  /**
   * Set when a fetch has landed with new rows, and cleared by the paint that
   * follows it. Only those paints mark what moved: sorting, filtering, ticking
   * and cursor moves all come through the same reconciler, and flashing rows
   * that the user themselves just rearranged would be noise — the point is to
   * catch a change that arrived on its own, while they were looking elsewhere.
   *
   * A flag rather than a parameter because the paint is several calls
   * downstream of the message handler, through `renderContentOnly`, which every
   * other repaint shares.
   */
  let flashChangedRows = false;

  /**
   * Marks a row as changed for as long as the flash lasts, then takes the mark
   * off again. Without the removal the class would still be on the node at the
   * next fetch, and the animation — already finished — would not replay.
   *
   * The timer is held per node so that a row changing twice in quick succession
   * restarts its flash rather than being cut short by the first one's cleanup.
   * Re-adding the class alone would not restart it: the animation only replays
   * when the class has actually been off the node between paints, which is what
   * the reflow read below forces.
   */
  const flashTimers = new WeakMap();

  function flashRow(tr, className) {
    const running = flashTimers.get(tr);
    if (running) {
      clearTimeout(running.timer);
      tr.classList.remove(running.className);
      // Forces the removal to take effect as its own style resolution, so the
      // class going back on counts as a change and the animation starts over.
      void tr.offsetWidth;
    }
    tr.classList.add(className);
    const timer = setTimeout(() => {
      tr.classList.remove(className);
      flashTimers.delete(tr);
    }, FLASH_MS);
    flashTimers.set(tr, { timer, className });
  }

  /**
   * How long a flash stays on a row. Must match `row-flash`'s duration in the
   * stylesheet: long enough to catch the eye on a table that is scanned rather
   * than read, short enough to be gone before the next 10s fetch.
   */
  const FLASH_MS = 1400;

  /**
   * The columns a table was drawn with, as a string cheap enough to compare on
   * every repaint. The namespace column comes and goes with the picker, so the
   * count alone would not catch a change that keeps the number the same.
   */
  function columnSignature(columns) {
    return columns.map((c) => c.key).join(',');
  }

  /**
   * Updates the table already on screen to match `rows`, instead of building a
   * new one and swapping it in.
   *
   * This is what keeps a text selection alive across a refresh. A selection is
   * anchored to text nodes, so replacing the table — even with identical markup
   * — collapses it; at a 10s auto-refresh that meant a selection could rarely be
   * completed, let alone copied. The same applies to the cell the pointer is
   * hovering and to the browser's own find-on-page.
   *
   * Rows are matched by `data-key`, so a row keeps its node as long as the
   * object is still reported, wherever it has moved to in the sort. Only cells
   * whose text actually differs are written, which on a steady cluster is a
   * handful out of thousands.
   *
   * Returns false when the table on screen cannot be reconciled — a different
   * kind, different columns, or an empty-state message in place of rows — and
   * the caller falls back to a full rebuild.
   */
  function reconcileTable(table, rows, columns) {
    if (!table || table.tagName !== 'TABLE') return false;
    if (table.getAttribute('data-kind') !== state.active) return false;
    if (table.getAttribute('data-cols') !== columnSignature(columns)) return false;
    const tbody = table.tBodies[0];
    if (!tbody) return false;
    // An empty table holds a message spanning every column, not rows; going
    // from or to that state changes the shape rather than the contents.
    if (tbody.querySelector('.empty-row')) return false;
    if (rows.length === 0) return false;

    // Walked by sibling rather than indexed through `children`: the collection
    // is a live view that has to be rechecked on every access, which at a few
    // thousand rows costs more than the rest of the pass put together.
    const existing = new Map();
    for (let tr = tbody.firstChild; tr; tr = tr.nextSibling) {
      const key = tr.nodeType === 1 ? tr.getAttribute('data-key') : null;
      if (key !== null) existing.set(key, tr);
    }

    // Rows the refresh no longer reports are dropped before anything is
    // placed, so the placement pass below only ever walks live rows.
    const wanted = new Set(rows.map(rowKey));
    for (const [key, tr] of existing) {
      if (wanted.has(key)) continue;
      existing.delete(key);
      tr.remove();
    }

    // Built in order, then applied against the DOM in the same order, so a row
    // that moved is relocated rather than rebuilt.
    let cursor = tbody.firstChild;
    rows.forEach((row, index) => {
      const key = rowKey(row);
      const found = existing.get(key);
      const reused = found && updateRow(found, row, index, rows, columns);
      const tr = reused ? found : buildRow(row, index, rows, columns);
      if (flashChangedRows) {
        // A row with no node to reuse is one that wasn't on screen a moment
        // ago: scheduled, scaled up, or newly matching the filter. It gets its
        // own flash, since "this is new" and "this changed" are different
        // things to spot.
        if (!found) {
          flashRow(tr, 'flash-new');
        } else if (reused) {
          const live = rowState.get(tr);
          if (live && live.changed) flashRow(tr, 'flash');
        }
      }
      if (found) {
        existing.delete(key);
        // A node we couldn't update is replaced rather than reused, so it has
        // to go: it would otherwise sit in the table as a duplicate of the row
        // that displaced it.
        if (!reused) {
          // It may be the very node the cursor is resting on, and removing the
          // cursor would strand the rest of the pass after a detached node.
          if (cursor === found) cursor = found.nextSibling;
          found.remove();
        }
      }
      if (cursor === tr) {
        cursor = tr.nextSibling;
      } else {
        tbody.insertBefore(tr, cursor);
      }
    });

    // Anything still indexed here was reported by the fetch but could not be
    // reconciled into its node, which the pass above replaced; the leftover
    // node is a duplicate and goes without ceremony.
    for (const tr of existing.values()) tr.remove();
    return true;
  }

  /**
   * Writes `row` into the node it was last drawn into, touching only what
   * changed. Returns false if the node isn't the shape this row needs, leaving
   * the caller to build a fresh one.
   *
   * The handlers close over the row and its index, both of which change between
   * refreshes, so they are rebound — but rebinding a listener doesn't disturb
   * the text nodes under it, which is what the selection holds on to.
   */
  function updateRow(tr, row, index, rows, columns) {
    // Repoint the handlers before anything else: the node is about to stand for
    // the refreshed object, and a click landing between here and the next
    // refresh must act on that one, not on the object it displaced. `index` and
    // `rows` move with it, so shift-click still ranges over what is on screen.
    const live = rowState.get(tr);
    // A row this build didn't create — nothing cached to write through, so it
    // is replaced rather than updated.
    if (!live || !live.cells || !live.check) return false;
    const cells = live.cells;
    if (cells.length !== columns.length) return false;
    const previous = live.row;
    // Whether anything the user can read off this row moved, for the flash. The
    // health tint and the age both count: a pod going Running -> Error changes
    // its wash, and an age that restarted means the object was replaced under
    // the same name, which is exactly the kind of change that is easy to miss.
    // Selection, ticks and the cursor are deliberately not part of it — those
    // are the user's own doing and are already visible as they happen.
    live.changed = Boolean(previous) && previous !== row && !sameCells(previous, row);
    live.row = row;
    live.index = index;
    live.rows = rows;

    const selected = isSelected(row);
    const ticked = isChecked(row);
    const className = [
      selected ? 'selected' : '',
      ticked ? 'checked' : '',
      isCursor(row) ? 'cursor' : '',
      isMenuRow(row) ? 'menu-open' : '',
      row.health === 'bad' ? 'bad' : row.health === 'warn' ? 'warn' : ''
    ].filter(Boolean).join(' ');
    if (tr.className !== className) tr.className = className;

    // Only when it differs: writing `checked` on a box the user is interacting
    // with would fight them, and it is the common case that it already agrees.
    if (live.check.checked !== ticked) live.check.checked = ticked;

    // On a settled cluster almost every row comes back byte-identical, and the
    // cells were last written from `previous` — so if the values behind them
    // haven't moved, neither has anything on screen, and the per-cell reads
    // below can be skipped entirely. Reading `textContent` out of the DOM is
    // far more expensive than comparing the strings we already hold.
    //
    // The columns are checked by the caller, which refuses to reconcile a table
    // drawn with a different set, so skipping the per-cell `data-col` check
    // here doesn't let a mismatched row through.
    if (previous && previous !== row && !live.changed) return true;

    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      const cell = cells[i];
      const value = cellValue(row, col.key);

      if (col.key === 'status') {
        const pill = cell.firstElementChild;
        if (!pill) return false;
        const pillClass = 'pill ' + row.health;
        if (pill.className !== pillClass) pill.className = pillClass;
        if (pill.textContent !== String(value)) pill.textContent = value;
        continue;
      }

      if (isAgeColumn(col.key) && row.created) {
        // The ticker owns this cell's text between fetches; all that can change
        // here is the timestamp it counts from, and only if the object was
        // replaced by a new one under the same name.
        if (cell.getAttribute('data-age-from') !== String(row.created)) {
          cell.setAttribute('data-age-from', row.created);
          cell.setAttribute('title', formatTimestamp(row.created));
          cell.textContent = value;
        }
        continue;
      }

      if (cell.textContent !== String(value)) {
        cell.textContent = value;
        cell.setAttribute('title', value);
      }
    }
    return true;
  }

  /**
   * Key of the last row ticked by hand, so a shift-click can fill the range
   * between there and here. Held outside the state object because it is a
   * property of the pointer's history, not of the view — it is reset whenever
   * the table it refers to changes.
   *
   * A key rather than an index: an index means a position in one particular
   * ordering, so it stopped meaning anything the moment a refresh re-sorted the
   * table, and the anchor had to be dropped on every fetch. Ticking a row then
   * shift-clicking after a refresh — seconds later, at a 10s cadence — ticked
   * just the two ends. The key names the row itself, so the anchor survives a
   * refresh and is resolved to a position only when the range is drawn.
   */
  let lastCheckedKey = null;

  /**
   * Ticks or unticks a row, extending from the previous tick when shift is
   * held. The range takes the new row's state throughout, which is what makes
   * shift-click work as "make all of these match" rather than flipping each
   * one and scattering the selection.
   */
  function toggleChecked(rows, index, checked, event) {
    // Resolved against the rows on screen now, not the ones the anchor was set
    // from: the row may have moved, and a row that has since been filtered out
    // or deleted has no position at all, which reads as no anchor.
    const anchor = event && event.shiftKey && lastCheckedKey !== null
      ? rows.findIndex((row) => rowKey(row) === lastCheckedKey)
      : -1;
    const from = anchor === -1 ? index : Math.min(anchor, index);
    const to = anchor === -1 ? index : Math.max(anchor, index);
    for (let i = from; i <= to; i++) {
      const key = checkKey(rows[i]);
      if (checked) {
        state.checked.add(key);
      } else {
        state.checked.delete(key);
      }
    }
    lastCheckedKey = rowKey(rows[index]);
    // Every tick lands here — row click, space, or the checkbox's own keyboard
    // handling — so the cursor follows the last row touched by any of them and
    // arrowing on from a clicked row carries on from there.
    state.cursor = rowKey(rows[index]);
    renderContentOnly();
  }

  /**
   * Bulk actions, in the order they appear in the bar. Declared as data so
   * adding one is a matter of adding an entry rather than editing the bar's
   * layout: each gets the checked rows, and `danger` marks the destructive
   * ones for styling.
   *
   * Every action is enabled only while something is ticked; the bar itself is
   * always on screen, so this is what makes it clear that they act on a
   * selection rather than on the whole table.
   *
   * `key` is an optional Ctrl/Cmd shortcut. It lives on the action rather than
   * in the key handler so the button and the shortcut cannot drift apart: the
   * bar shows it in the tooltip and the handler looks it up here.
   *
   * `applies` is an optional test against the current kind. An action that
   * cannot mean anything here — scaling a ConfigMap — is left out of the bar
   * entirely rather than shown disabled: a disabled button says "tick some
   * rows", which would be a lie for a kind that can never be scaled.
   */
  const BULK_ACTIONS = [
    {
      id: 'scale',
      key: 's',
      applies: (kind) => Boolean(kind && kind.scalable),
      label: (rows) => `Scale ${rows.length}…`,
      title: (rows, noun) => `Set the replica count on the ${rows.length} selected ${noun}`,
      run: (rows) => post({
        type: 'scaleMany',
        kind: state.active,
        targets: rows.map((row) => ({
          name: row.name,
          namespace: row.namespace,
          // The count the row is showing, so a single-row selection can open
          // the prompt on it exactly as the detail panel's Scale… does.
          replicas: row.replicas
        }))
      })
    },
    ...['cordon', 'uncordon', 'drain'].map((id) => ({
      id,
      applies: (kind) => Boolean(kind && kind.id === 'nodes'),
      label: (rows) => `${id.charAt(0).toUpperCase()}${id.slice(1)} ${rows.length}`,
      title: (rows, noun) => ({
        cordon: `Stop new pods being scheduled on the ${rows.length} selected ${noun}`,
        uncordon: `Let new pods be scheduled on the ${rows.length} selected ${noun} again`,
        drain: `Cordon the ${rows.length} selected ${noun} and evict their pods, in a terminal`
      })[id],
      run: (rows) => post({ type: 'nodeAction', action: id, names: rows.map((row) => row.name) })
    })),
    {
      id: 'delete',
      danger: true,
      key: 'd',
      label: (rows) => `Delete ${rows.length}`,
      title: (rows, noun) => `Delete the ${rows.length} selected ${noun}`,
      run: (rows) => {
        const kind = kindOf(state.active);
        const noun = rows.length === 1
          ? (kind ? kind.singular.toLowerCase() : 'item')
          : (kind ? kind.label.toLowerCase() : 'items');
        confirmDelete({
          heading: `Delete ${rows.length} ${noun}?`,
          labels: rows.map((row) => (row.namespace ? `${row.namespace}/${row.name}` : row.name)),
          confirmLabel: `Delete ${rows.length}`,
          onConfirm: (force) => post({
            type: 'deleteMany',
            kind: state.active,
            targets: rows.map((row) => ({ name: row.name, namespace: row.namespace })),
            force
          })
        });
      }
    }
  ];

  /** The delete confirmation on screen, if any. */
  let deleteDialog = null;

  /**
   * Asks before a delete, in the webview rather than through the extension's
   * native modal, because the native one can carry only buttons and this needs
   * a Force checkbox. Force is off every time the dialog opens: it skips
   * graceful termination, and a setting that remembered itself would carry
   * that into the next delete unnoticed.
   *
   * The dialog lives on the body, outside `#app`, so a refresh that rebuilds
   * the dashboard underneath it does not take it away mid-decision.
   */
  function confirmDelete({ heading, labels, confirmLabel, onConfirm }) {
    closeDeleteDialog();
    // Enough names to recognise the set, then a count for the rest, so the
    // dialog stays a readable size even for a hundred rows.
    const sorted = [...labels].sort();
    const shown = sorted.slice(0, 10);
    const rest = sorted.length - shown.length;

    const force = el('input', { type: 'checkbox', id: 'delete-force' });
    const confirm = () => {
      const forced = force.checked;
      closeDeleteDialog();
      onConfirm(forced);
    };
    const cancel = el('button', { onclick: closeDeleteDialog }, 'Cancel');

    deleteDialog = el('div', {
      class: 'confirm-backdrop',
      onmousedown: (e) => { if (e.target === e.currentTarget) closeDeleteDialog(); }
    },
      el('div', {
        class: 'confirm', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': heading,
        onkeydown: (e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            closeDeleteDialog();
          } else if (e.key === 'Tab') {
            // Keeps focus inside the dialog, which is modal to the page.
            const stops = [...deleteDialog.querySelectorAll('input, button')];
            const at = stops.indexOf(document.activeElement);
            const next = (at + (e.shiftKey ? -1 : 1) + stops.length) % stops.length;
            e.preventDefault();
            stops[next].focus();
          }
          // Nothing typed here is meant for the table behind.
          e.stopPropagation();
        }
      },
        el('h2', { text: heading }),
        el('div', { class: 'context', text: `Context "${state.context}"` }),
        el('ul', { class: 'targets' },
          ...shown.map((label) => el('li', { text: label })),
          rest > 0 ? el('li', { class: 'more', text: `…and ${rest} more` }) : null
        ),
        el('label', { class: 'force', for: 'delete-force' },
          force,
          el('span', {},
            'Force',
            el('span', {
              class: 'hint',
              text: 'Skip graceful termination (--force --grace-period=0)'
            })
          )
        ),
        el('div', { class: 'note', text: 'This cannot be undone.' }),
        el('div', { class: 'buttons' },
          cancel,
          el('button', { class: 'danger solid', onclick: confirm }, confirmLabel)
        )
      )
    );
    document.body.appendChild(deleteDialog);
    // Cancel takes focus, so a stray Enter backs out rather than deletes.
    cancel.focus();
  }

  function closeDeleteDialog() {
    if (!deleteDialog) return;
    deleteDialog.remove();
    deleteDialog = null;
  }

  /**
   * The action bar along the bottom of a table view: the home for bulk actions
   * generally, not just delete.
   *
   * It exists only while rows are ticked. Idle it had nothing to say but that
   * nothing was selected, and neither a row of dead buttons nor an empty strip
   * earns the space — the list gets it back instead.
   *
   * `visible` is the rows already on screen, when the caller has them. It is
   * only ever an optimisation: left out, the bar works them out for itself.
   */
  function renderActionBar(visible) {
    if (!isTable() || state.error || state.empty) return null;
    const rows = (visible ?? visibleRows()).filter(isChecked);
    if (rows.length === 0) return null;
    const kind = kindOf(state.active);
    const noun = rows.length === 1
      ? (kind ? kind.singular.toLowerCase() : 'item')
      : (kind ? kind.label.toLowerCase() : 'items');

    return el('div', { class: 'action-bar active' },
      el('span', {
        class: 'selection-count',
        text: `${rows.length} ${noun} selected`
      }),
      el('button', {
        class: 'link',
        title: 'Clear the selection',
        onclick: () => { clearChecked(); renderContentOnly(); }
      }, 'Clear'),
      el('span', { class: 'spacer' }),
      ...bulkActionsFor(kind).map((action) => el('button', {
        class: action.danger ? 'danger' : '',
        title: action.title(rows, noun)
          + (action.key ? ` (${modifierLabel()}+${action.key.toUpperCase()})` : ''),
        onclick: () => action.run(rows)
      }, action.label(rows)))
    );
  }

  /** The bulk actions that mean anything for a kind, in bar order. */
  function bulkActionsFor(kind) {
    return BULK_ACTIONS.filter((action) => !action.applies || action.applies(kind));
  }

  /** What to call the Ctrl/Cmd key in a tooltip, per platform. */
  function modifierLabel() {
    return navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl';
  }

  /** The message that asks the extension to run `action` on one object. */
  function actionMessage(kind, row, action, container) {
    return {
      type: 'action', action, kind: kind.id, name: row.name, namespace: row.namespace, container,
      // Only scale reads this; the extension opens its prompt on the count the
      // row is showing rather than re-fetching the object to find it.
      replicas: row.replicas
    };
  }

  /**
   * What can be done to one object, in the order the detail panel's buttons
   * show it. Declared once, as data, so the panel and the row's context menu
   * offer the same things and cannot drift apart.
   */
  function objectActions(kind, row) {
    const act = (action) => () => post(actionMessage(kind, row, action));

    // Only this object's own open editor disables the button. Other objects
    // edit in parallel; re-editing this one would race the tab already open,
    // since each kubectl edit applies over the snapshot it started from.
    const editingThis = state.editing.includes(editKey(kind.id, row));

    const actions = [{
      label: 'Neat YAML',
      variant: 'primary',
      run: act('neat'),
      title: 'YAML with the cluster bookkeeping stripped, via kubectl-neat'
    }];
    // An event is a record the API server writes and expires on its own, so
    // editing one is meaningless — the field you changed is overwritten or the
    // record is gone. Every other kind is a spec someone is meant to change.
    if (kind.id !== 'events') {
      actions.push({
        label: editingThis ? 'Editing…' : 'Edit',
        run: act('edit'),
        disabled: editingThis,
        title: editingThis
          ? 'Editing — close the editor tab to apply'
          : 'kubectl edit in a VS Code tab'
      });
    }
    // Drilling into a workload's pods, for the kinds that have them. It sits
    // before Scale and Delete: reading what a workload is running comes ahead
    // of changing it, and it is the only action here that navigates rather
    // than acting on the object.
    if (ownsPods(kind.id)) {
      actions.push({
        label: 'Pods',
        run: () => { selectRow(null); showOwned(kind.id, row); },
        title: kind.id === 'nodes'
          ? 'Show only the pods running on this node'
          : `Show only the pods of this ${kind.singular.toLowerCase()}`
      });
    }
    // Node maintenance. Only the one of Cordon and Uncordon that would change
    // something is offered; Drain cordons on its own, so it is there either way.
    if (kind.id === 'nodes') {
      const node = (action) => () => post({ type: 'nodeAction', action, names: [row.name] });
      actions.push(row.unschedulable
        ? { label: 'Uncordon', run: node('uncordon'), title: 'Let new pods be scheduled on this node again' }
        : { label: 'Cordon', run: node('cordon'), title: 'Stop new pods being scheduled on this node' });
      actions.push({
        label: 'Drain',
        run: node('drain'),
        title: 'Cordon the node and evict its pods, in a terminal'
      });
    }
    // Only the kinds with a spec.replicas the scale subresource can write; see
    // `scalable` in model.ts for why DaemonSets and Jobs are not among them.
    if (kind.scalable) {
      const at = row.replicas !== undefined ? ` (currently ${row.replicas})` : '';
      actions.push({ label: 'Scale…', run: act('scale'), title: `Set the replica count${at}` });
    }
    actions.push({
      label: 'Delete',
      variant: 'danger',
      run: () => confirmDelete({
        heading: `Delete ${kind.singular.toLowerCase()}?`,
        labels: [row.namespace ? `${row.namespace}/${row.name}` : row.name],
        confirmLabel: 'Delete',
        onConfirm: (force) => post({ ...actionMessage(kind, row, 'delete'), force })
      })
    });
    return actions;
  }

  /** The row context menu on screen, if any. */
  let rowMenu = null;

  /**
   * A right-click menu on a table row, offering what the detail panel's
   * buttons do without opening the panel first. Built from `objectActions`,
   * so the two cannot drift apart. It lives on the body, outside the table,
   * so a refresh rebuilding the rows underneath does not take it with it.
   */
  function openRowMenu(event, tr, row) {
    closeRowMenu();
    const kind = kindOf(state.active);
    const run = (fn) => () => { closeRowMenu(); fn(); };
    // Right-clicking one of several ticked rows acts on all of them, as in a
    // file explorer, so only what the action bar can do to the lot is offered.
    // A row outside the selection, or a selection of one, gets its own menu.
    const ticked = isChecked(row) ? checkedRows() : [];
    const bulk = ticked.length > 1;
    const items = bulk ? bulkMenuItems(kind, ticked) : rowMenuItems(kind, row);
    const buttons = [];
    const menu = el('div', { class: 'row-menu', role: 'menu' },
      ...items.map((item) => {
        if (!item) return el('div', { class: 'separator', role: 'separator' });
        const button = el('button', {
          class: item.variant === 'danger' ? 'danger' : '',
          role: 'menuitem',
          disabled: item.disabled,
          title: item.title,
          onclick: run(item.run)
        }, item.label);
        if (!item.disabled) buttons.push(button);
        return button;
      })
    );
    document.body.appendChild(menu);

    // Opened at the pointer, and flipped back inside the viewport when it
    // would run off the right or bottom edge.
    const box = menu.getBoundingClientRect();
    const x = Math.min(event.clientX, window.innerWidth - box.width - 4);
    const y = event.clientY + box.height > window.innerHeight
      ? Math.max(4, event.clientY - box.height)
      : event.clientY;
    menu.style.left = `${Math.max(4, x)}px`;
    menu.style.top = `${y}px`;

    // Held by key rather than by node: a refresh rewrites each row's classes
    // from state, and may rebuild the row outright, so the outline has to be
    // something the row renderers can ask about. A bulk menu outlines nothing;
    // the ticks already show what it acts on.
    rowMenu = { menu, key: bulk ? null : rowKey(row), buttons };
    if (!bulk) tr.classList.add('menu-open');
  }

  /**
   * The menu for a multi-row selection: the action bar's actions, in its
   * order. The rows are looked up again on click, so one a refresh removed in
   * the meantime is not acted on.
   */
  function bulkMenuItems(kind, rows) {
    const noun = kind.label.toLowerCase();
    return bulkActionsFor(kind).map((action) => ({
      label: action.label(rows),
      variant: action.danger ? 'danger' : '',
      title: action.title(rows, noun),
      run: () => {
        const now = checkedRows();
        if (now.length) action.run(now);
      }
    }));
  }

  /** The menu for a single row: the detail panel's actions, plus a pod's logs and shell. */
  function rowMenuItems(kind, row) {
    // A pod's logs and shell are what it is most often right-clicked for, so
    // they sit at the top. No container is named: kubectl picks the pod's
    // default-container annotation, or its first container, and names it in
    // the terminal. The detail panel is the place to choose a specific one.
    const pod = kind.id === 'pods';
    const act = (action) => () => post(actionMessage(kind, row, action));
    const ordinary = (row.containers || []).filter((c) => c.kind === 'app');
    const running = ordinary.some((c) => c.state === 'Running');
    // A previous container only exists once one has died; `kubectl logs -p`
    // errors out otherwise, so the item is absent until a restart happens.
    const restarted = ordinary.some((c) => c.restarts);
    return [
      { label: 'Describe', run: () => { selectRow(row); openDetailTab('describe'); }, title: 'kubectl describe, in the detail panel' },
      ...(pod ? [
        restarted ? {
          label: 'Previous logs',
          run: act('logs-previous'),
          title: 'kubectl logs -p --tail 100, in a terminal'
        } : undefined,
        { label: 'Logs', run: act('logs'), title: 'kubectl logs -f --tail 100, in a terminal' },
        {
          label: 'Shell',
          run: act('shell'),
          disabled: !running,
          title: running ? 'kubectl exec into the default container' : 'Only a running container can be shelled into'
        }
      ].filter(Boolean) : []),
      null,
      ...objectActions(kind, row)
    ];
  }

  function closeRowMenu() {
    if (!rowMenu) return;
    rowMenu.menu.remove();
    rowMenu = null;
    for (const tr of app.querySelectorAll('tr.menu-open')) tr.classList.remove('menu-open');
  }

  /** Whether `row` is the one the open context menu acts on. */
  function isMenuRow(row) {
    return Boolean(rowMenu) && rowMenu.key === rowKey(row);
  }

  /** Arrow keys walk the menu's items, wrapping at either end. */
  function stepRowMenu(step) {
    const { buttons } = rowMenu;
    if (!buttons.length) return;
    const at = buttons.indexOf(document.activeElement);
    const next = at === -1
      ? (step > 0 ? 0 : buttons.length - 1)
      : (at + step + buttons.length) % buttons.length;
    buttons[next].focus();
  }

  // Anything that moves the ground under the menu dismisses it: a press
  // anywhere else, a scroll, or the panel losing focus or size.
  document.addEventListener('mousedown', (e) => {
    if (rowMenu && !rowMenu.menu.contains(e.target)) closeRowMenu();
  }, true);
  document.addEventListener('scroll', () => closeRowMenu(), true);
  window.addEventListener('blur', () => closeRowMenu());
  window.addEventListener('resize', () => closeRowMenu());

  /** Item details, as a slide-over panel down the right of the dashboard. */
  function renderModal() {
    const row = state.selected;
    const kind = kindOf(state.active);
    const entries = kind.columns
      .filter((c) => c.key !== 'name' && cellValue(row, c.key) !== '')
      .map((c) => [c.label, cellValue(row, c.key)]);

    const act = (action, container) => () => post(actionMessage(kind, row, action, container));
    const actions = objectActions(kind, row).map((a) => el('button', {
      class: a.variant,
      onclick: a.run,
      disabled: a.disabled,
      title: a.title
    }, a.label));

    // An event's name is a generated hash; its reason and target are what
    // identify it to a reader, so they take the heading.
    const isEvent = kind.id === 'events';
    const heading = isEvent ? (row.cells.reason || kind.singular) : row.name;
    const sub = isEvent
      ? [row.cells.object, row.namespace].filter(Boolean).join(' · ') || kind.singular
      : row.namespace ? `${kind.singular} · ${row.namespace}` : kind.singular;

    const close = () => { selectRow(null); renderContentOnly(); };

    // Both tabs exist for every kind, including events, which have no
    // containers: a strip that changes shape per kind moves the Describe tab
    // out from under the pointer as you step between rows.
    const tab = (id, label) => el('button', {
      class: 'tab' + (state.detailTab === id ? ' active' : ''),
      role: 'tab',
      'aria-selected': String(state.detailTab === id),
      onclick: () => openDetailTab(id)
    }, label);

    return el('div', {
      class: 'modal-backdrop',
      // Read back after a rebuild, to tell this panel from the one for another
      // row or the other tab. See captureDetailScroll.
      'data-detail': detailScrollKey(),
      // Only a click that lands on the backdrop itself dismisses; one that
      // started inside the panel and drifted out (a text selection dragged
      // past the edge) must not close it, hence target rather than
      // currentTarget.
      onmousedown: (e) => { if (e.target === e.currentTarget) close(); }
    },
      el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': heading },
        el('header', {},
          el('div', { class: 'who' },
            el('h2', { text: heading, title: row.name }),
            el('div', { class: 'ns', text: sub })
          ),
          el('button', { class: 'close', title: 'Close', onclick: close }, '×')
        ),
        el('div', { class: 'tabs', role: 'tablist' }, tab('details', 'Details'), tab('describe', 'Describe')),
        state.detailTab === 'describe'
          ? renderDescribePane()
          : el('div', { class: 'body' },
              el('dl', {}, ...entries.flatMap(([label, value]) => [
                el('dt', { text: label }),
                el('dd', {}, label === 'Status' ? el('span', { class: 'pill ' + row.health }, value) : value)
              ])),
              renderContainers(row, act),
              renderObjectEvents()
            ),
        el('div', { class: 'actions' }, ...actions)
      )
    );
  }

  /** Full names for the probe letters, used as their tooltips. */
  const PROBE_LABELS = { liveness: 'Liveness probe', readiness: 'Readiness probe', startup: 'Startup probe' };

  const CONTAINER_KINDS = { init: 'init', ephemeral: 'ephemeral' };

  /**
   * What is actually running inside a pod: one block per container, in spec
   * order so init containers come first. The data rides along on the row, so
   * this paints with the panel and needs no fetch of its own.
   */
  function renderContainers(row, act) {
    const containers = row.containers || [];
    if (!containers.length) return null;

    return el('div', { class: 'containers' },
      el('h3', {}, 'Containers', el('span', { class: 'count', text: String(containers.length) })),
      ...containers.map((c) => renderContainer(c, act))
    );
  }

  function renderContainer(c, act) {
    // The state pill says Running/Waiting/…; the reason beside it says which
    // CrashLoopBackOff or ImagePullBackOff, which is the part worth reading.
    const stateText = c.reason && c.reason !== c.state ? `${c.state} · ${c.reason}` : c.state;

    const facts = [
      ['Image', c.image, c.image],
      ['Ready', c.ready ? 'Yes' : 'No'],
      // A restart count is only half the story; the previous exit is the other.
      // The age in here is baked into a composed string and so does not tick —
      // it is a timestamp for an event that already happened, where a minute's
      // drift reads the same either way.
      ['Restarts', c.restarts
        ? `${c.restarts}${c.lastReason ? ` · last ${c.lastReason}${c.lastFinishedAt ? ` ${formatAge(c.lastFinishedAt)} ago` : ''}` : ''}`
        : '0'],
      // A running container's uptime is the one fact here that keeps moving on
      // its own, so it ticks with the table's age cells.
      ['Started', c.startedAt ? `${formatAge(c.startedAt)} ago` : '', formatTimestamp(c.startedAt), c.startedAt],
      ['Ports', c.ports],
      ['CPU', c.cpu],
      ['Memory', c.memory]
    ].filter(([, value]) => value !== '' && value !== undefined);

    // Shell needs a process to attach to, and an init container that has done
    // its job no longer has one; logs survive the container, so they stay.
    const running = c.state === 'Running';
    const buttons = [
      // A previous container only exists once one has died, so the button is
      // absent rather than disabled until a restart has actually happened —
      // `kubectl logs -p` errors out otherwise.
      c.restarts ? el('button', {
        onclick: act('logs-previous', c.name),
        title: `kubectl logs -p --tail 100 -c ${c.name}, in a terminal`
      }, 'Previous logs') : null,
      el('button', {
        onclick: act('logs', c.name),
        title: `kubectl logs -f --tail 100 -c ${c.name}, in a terminal`
      }, 'Logs'),
      el('button', {
        onclick: running ? act('shell', c.name) : () => {},
        disabled: !running,
        title: running ? `kubectl exec -c ${c.name}` : 'Only a running container can be shelled into'
      }, 'Shell')
    ];

    return el('div', { class: 'container-card' },
      el('div', { class: 'container-head' },
        el('span', { class: 'container-name', text: c.name, title: c.name }),
        CONTAINER_KINDS[c.kind] ? el('span', { class: 'tag', text: CONTAINER_KINDS[c.kind] }) : null,
        ...c.probes.map((probe) => el('span', {
          class: 'tag probe',
          title: `${PROBE_LABELS[probe] || probe} configured`,
          text: probe.charAt(0).toUpperCase()
        })),
        el('span', { class: 'pill ' + c.health, text: stateText, title: c.message || stateText })
      ),
      el('dl', { class: 'container-facts' }, ...facts.flatMap(([label, value, title, ageFrom]) => [
        el('dt', { text: label }),
        el('dd', {
          text: value,
          title: title || undefined,
          'data-age-from': ageFrom || undefined,
          'data-age-suffix': ageFrom ? ' ago' : undefined
        })
      ])),
      // A waiting or terminated container's message is the actual error text —
      // "Back-off pulling image", "OOMKilled" — so it is shown, not hidden in a
      // tooltip, whenever the container is not simply running.
      c.message && !running ? el('div', { class: 'container-message', text: c.message }) : null,
      el('div', { class: 'container-actions' }, ...buttons)
    );
  }

  /**
   * The Events section of the details tab: everything the cluster recorded
   * about this one object, newest first.
   *
   * It sits at the bottom of the tab, under the object's own facts and its
   * containers, because it is the narrative rather than the state — you read
   * down to it once the fields above have not explained what you are looking
   * at. Warnings are coloured and everything else stays grey, matching the
   * Events table and the Overview.
   *
   * Only the newest few are shown until asked otherwise: a busy pod can hold
   * dozens of near-identical Pulled/Created/Started lines, and pushing the
   * action bar off the bottom of the panel to show them all serves nobody.
   */
  function renderObjectEvents() {
    // Every row here is an event already, so there is no section to draw; see
    // the guard in selectRow, which is why nothing was ever fetched.
    if (state.active === 'events') return null;

    const e = state.events;
    const heading = (...extra) => el('h3', {}, 'Events', ...extra);

    if (e.error && !e.rows.length) {
      return el('div', { class: 'events-section' },
        heading(),
        el('div', { class: 'events-state error', text: e.error })
      );
    }
    // Nothing on screen yet and a fetch in flight: one line rather than a
    // skeleton, since this is a single API read and usually lands at once.
    if (e.loading && !e.rows.length) {
      return el('div', { class: 'events-section' },
        heading(),
        el('div', { class: 'events-state', text: 'Loading…' })
      );
    }
    if (!e.rows.length) {
      // Worth saying explicitly: events expire after about an hour by default,
      // so "none" means nothing recent, not nothing ever.
      return el('div', { class: 'events-section' },
        heading(),
        el('div', { class: 'events-state', text: 'No events — they expire after about an hour, so this says nothing about the recent past.' })
      );
    }

    const shown = e.expanded ? e.rows : e.rows.slice(0, EVENTS_PREVIEW);
    const hidden = e.rows.length - shown.length;

    return el('div', { class: 'events-section' },
      heading(
        el('span', { class: 'count', text: String(e.rows.length) }),
        // Cached rows are on screen while the refresh runs; say so rather than
        // letting an hour-old list pass for current.
        e.loading || e.stale
          ? el('span', { class: 'events-note', text: e.loading ? 'refreshing…' : ago(e.generated) })
          : e.error
            ? el('span', { class: 'events-note error', text: 'refresh failed' })
            : null
      ),
      el('div', { class: 'events-list' }, ...shown.map(renderObjectEvent)),
      hidden > 0
        ? el('button', {
            class: 'events-more',
            onclick: () => { state.events.expanded = true; renderContentOnly(); }
          }, `Show ${hidden} older`)
        : null
    );
  }

  /** One event: its type and reason, what it said, and when it was last seen. */
  function renderObjectEvent(row) {
    const repeats = Number(row.cells.count) > 1;
    const health = row.health || 'muted';
    // A disruptive Normal (Killing, Evicted) is graded `bad` in the model, so
    // it shows red while still calling itself Normal. Say why, or the colour
    // looks like a bug to anyone who knows what the type field says.
    const title = health === 'bad' && row.status !== 'Warning'
      ? row.status + ' event — disruptive; this is what restarts a container'
      : row.status;
    return el('div', { class: 'event-item ' + health },
      el('div', { class: 'event-head' },
        el('span', { class: 'pill ' + health, title, text: row.cells.reason || row.status }),
        repeats
          ? el('span', { class: 'event-repeat', title: 'Times the cluster saw this', text: '×' + row.cells.count })
          : null,
        el('span', { class: 'spacer' }),
        el('span', {
          class: 'event-age',
          title: formatTimestamp(row.created),
          'data-age-from': row.created || undefined,
          'data-age-suffix': ' ago'
        }, row.created ? formatAge(row.created) + ' ago' : '')
      ),
      el('div', { class: 'event-message', text: row.cells.message || '' })
    );
  }

  /**
   * Values that carry a verdict rather than just a reading, so the eye can find
   * the bad one without reading every line. Matched against the whole value, so
   * a Reason of "Completed" colours and a message mentioning it in passing does
   * not.
   */
  const DESCRIBE_GOOD = /^(Running|Ready|Active|True|Succeeded|Completed|Bound|Healthy|Normal|Available|Established|Synced)$/;
  const DESCRIBE_BAD = /^(Failed|Error|CrashLoopBackOff|ImagePullBackOff|ErrImagePull|Unhealthy|Evicted|OOMKilled|NotReady|Terminated|Unknown|False|BackOff|InvalidImageName|CreateContainerError|Lost|Unschedulable)$/;
  const DESCRIBE_WARN = /^(Pending|Warning|Terminating|ContainerCreating|PodInitializing|Waiting|Init|Progressing|Released|Degraded)$/;

  /** The class for a value, or '' for one that is just a reading. */
  function describeValueClass(value) {
    if (DESCRIBE_GOOD.test(value)) return ' good';
    if (DESCRIBE_BAD.test(value)) return ' bad';
    if (DESCRIBE_WARN.test(value)) return ' warn';
    return '';
  }

  /**
   * Colours one line of `kubectl describe` output.
   *
   * The output is not a format with a parser, it is aligned text, so this reads
   * the shapes that hold across every kind: a section header sits flush left
   * with nothing after the colon, a field is `Key:` plus a value at any indent,
   * and everything under `Events:` is a table whose first column is the type.
   * Anything that matches none of them is left plain rather than guessed at —
   * a wrong colour is worse than none.
   */
  function describeLine(line) {
    // Blank lines still need a box, or the gaps between sections collapse.
    if (!line.trim()) return el('div', { class: 'd-line', text: line || ' ' });

    // Events rows: "  Normal   Pulled  3m  kubelet  ...". The type is the one
    // token worth colouring; the rest is prose and timestamps.
    const event = /^(\s+)(Normal|Warning)(\s+)(.*)$/.exec(line);
    if (event) {
      return el('div', { class: 'd-line' },
        event[1],
        el('span', { class: 'd-event' + (event[2] === 'Warning' ? ' warn' : ' good'), text: event[2] }),
        event[3],
        event[4]);
    }

    // `Key:` with nothing after it — a section header (Events:, Conditions:,
    // Containers:) or a parent whose children are the lines below it.
    const header = /^(\s*)([A-Za-z][\w .\/-]*):\s*$/.exec(line);
    if (header) {
      return el('div', { class: 'd-line' },
        header[1],
        el('span', { class: 'd-section', text: header[2] + ':' }));
    }

    // `Key:   value` at any indent. The gap is preserved verbatim so the
    // columns stay aligned with the lines around them.
    const field = /^(\s*)([A-Za-z][\w .\/()-]*):(\s+)(.*)$/.exec(line);
    if (field) {
      const value = field[4].trim();
      // A restart count is a verdict spelled as a number: zero is silence,
      // anything else is the reason the pod is being looked at.
      const restarts = /^Restart Count$/.test(field[2]) && /^[1-9]\d*$/.test(value);
      return el('div', { class: 'd-line' },
        field[1],
        el('span', { class: 'd-key', text: field[2] + ':' }),
        field[3],
        el('span', {
          class: 'd-value' + (restarts ? ' warn' : describeValueClass(value)),
          text: field[4]
        }));
    }

    // A table's rule row ("----  ------  ----"): pure separator, so it recedes
    // along with the header above it.
    if (/^\s*-+(\s+-+)*\s*$/.test(line)) {
      return el('div', { class: 'd-line' }, el('span', { class: 'd-rule', text: line }));
    }

    // Column-aligned table rows, the shape `Conditions:` and `Events:` use:
    // two or more tokens separated by runs of spaces, no colon in sight. The
    // status sits in the second column, and it is the reason to look at all.
    const columns = /^(\s+)(\S+)(\s{2,})(\S+)(\s*)(.*)$/.exec(line);
    if (columns) {
      const status = describeValueClass(columns[4]);
      // The header row ("Type  Status  Reason") has no verdict in it, so it
      // dims as a whole rather than colouring a word that only names a column.
      if (!status && /^[A-Z]/.test(columns[2]) && /^[A-Z]/.test(columns[4])) {
        return el('div', { class: 'd-line' }, el('span', { class: 'd-th', text: line }));
      }
      return el('div', { class: 'd-line' },
        columns[1],
        columns[2],
        columns[3],
        el('span', { class: 'd-value' + status, text: columns[4] }),
        columns[5],
        columns[6]);
    }

    // Anything else — continuation lines of a wrapped value, free-form
    // messages — stays as it came.
    return el('div', { class: 'd-line', text: line });
  }

  /**
   * The describe tab: `kubectl describe` output, fetched the first time the tab
   * is opened for a row and kept for as long as that row stays selected, so
   * switching back and forth never costs a call.
   */
  function renderDescribePane() {
    const d = state.describe;
    // Cached text is on screen while a refresh runs behind it; say so rather
    // than letting stale output pass for current.
    const note = d.text && (d.loading || d.stale)
      ? el('div', { class: 'describe-note', text: d.loading ? 'refreshing…' : ago(d.generated) })
      : d.text && d.error
        ? el('div', { class: 'describe-note error', text: 'refresh failed' })
        : null;

    // Text wins over both states: once there is something to read, a spinner or
    // a failed refresh shouldn't take it away.
    const body = d.text
      // One element per line, so each can be coloured in place. The class stays
      // on the `pre` itself: it is still the element that scrolls sideways, and
      // the scroll-restore code looks for it by name.
      ? el('pre', { class: 'describe-text' }, ...d.text.split('\n').map(describeLine))
      : d.error
        ? el('div', { class: 'describe-state error', text: d.error })
        // describe shells out to kubectl, so this is a real wait every time.
        // Lines in the shape of the output that is coming, rather than a label.
        : el('div', { class: 'skeleton describe-skeleton', 'aria-busy': 'true', 'aria-label': 'Loading' },
            ...['38%', '72%', '55%', '84%', '46%', '67%', '78%', '50%'].map((width) =>
              el('span', { class: 'sk-bar sk-line', style: `width: ${width}` })));
    return el('div', { class: 'body describe' }, note, body);
  }

  // ---------- actions ----------

  /**
   * Kinds whose rows have pods underneath them. A CronJob reaches them through
   * its Jobs and a Deployment through its ReplicaSets; the extension walks
   * whichever hop is needed, so this list is just "does asking make sense".
   * A node does not own its pods but hosts them, and gets the same jump.
   */
  const POD_OWNERS = ['deployments', 'statefulsets', 'daemonsets', 'jobs', 'cronjobs', 'replicasets', 'nodes'];

  function ownsPods(kindId) {
    return POD_OWNERS.includes(kindId);
  }

  /**
   * Where the drill-down in flight started, held until the extension resolves
   * the owner set and the `scope` message lands. Kept outside `state` because
   * a resolve that fails never arrives, and a stale origin sitting in the view
   * state would offer a back button out of a jump that never happened.
   * @type {{kind: string, name: string, namespace?: string} | null}
   */
  let pendingOrigin = null;

  /** Opens the pods table scoped to one workload, or to the pods on one node. */
  function showOwned(kindId, row) {
    pendingOrigin = { kind: kindId, name: row.name, namespace: row.namespace };
    // Every pod row names its node, so there is nothing for the extension to
    // resolve and the scope is entered straight away.
    if (kindId === 'nodes') {
      enterScope('pods', { kind: kindId, name: row.name, owners: [] });
      return;
    }
    post({ type: 'showOwned', kind: kindId, name: row.name, namespace: row.namespace });
  }

  /** Switches to `kindId` narrowed to `scope`, with a way back to where the jump started. */
  function enterScope(kindId, scope) {
    // Switching kinds clears any scope, so `select` runs first and the
    // new one is applied after it.
    select(kindId);
    state.scope = scope;
    // Claimed here rather than at the click, so a resolve that never lands
    // leaves no back button behind, and one drill-down started while
    // another was in flight cannot leave the older origin on screen.
    state.origin = pendingOrigin;
    pendingOrigin = null;
    // A scope is a narrowing of its own; a namespace left over from the
    // previous view would narrow it further and could hide every pod, so
    // the picker is moved to the scope's own namespace — or widened to all
    // of them for a node, whose pods span every namespace.
    const namespace = scope.namespace ?? state.allNamespaces;
    if (state.namespace !== namespace) {
      state.namespace = namespace;
      post({ type: 'setNamespace', namespace: state.namespace });
    }
    render();
  }

  function select(kindId) {
    const switching = kindId !== state.active;
    state.active = kindId;
    selectRow(null);
    if (switching) {
      // A row key is only unique within a kind, so ticks cannot travel between
      // tables — a pod and a service of the same name would be the same key.
      clearChecked();
      lastCheckedKey = null;
      // A row key means nothing in the new table either, so the cursor starts
      // over rather than landing on whatever happens to share the name.
      state.cursor = null;
      // Drop the previous kind's rows so they can't flash in the new table. The
      // extension replies with this kind's cached rows almost immediately.
      state.rows = [];
      state.empty = true;
      state.generated = 0;
      state.refreshError = '';
      state.filter = '';
      // A scope names a workload that only means something for the table it
      // was opened from; leaving the pods view abandons it. `showOwned` sets
      // its scope after this runs, so an owner jump is not clobbered here.
      // Cleared locally only: the extension drops the target on its own kind
      // switch, and a `clearScope` racing a drill-down's resolve would cancel
      // the scope being opened.
      state.scope = null;
      // The back button belongs to the drill-down that opened this table, so
      // navigating anywhere else retires it. `showOwned`'s own jump restores
      // it after this runs, the same way the scope is.
      state.origin = null;
      // Status words belong to the kind that reports them; carrying a pod's
      // CrashLoopBackOff into the nodes table would just empty it.
      state.status = '';
      state.sort = defaultSort(kindId);
    }
    state.error = '';
    post({ type: 'load', kind: kindId });
    render();
  }

  // ---------- messages ----------

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'init':
        state.kinds = message.kinds;
        state.groups = message.groups || [];
        state.context = message.context;
        state.cluster = message.cluster;
        // Handed back to the extension's panel serializer after a window
        // reload, which is the only record of which context this panel was
        // showing — VS Code recreates the frame but not the extension's map.
        vscode.setState({ contextName: message.context });
        state.allNamespaces = message.allNamespaces;
        // The page the panel was last left on. The extension is already loading
        // it, so this only aims the rail and the table at what is coming.
        if (message.active) {
          state.active = message.active;
          state.sort = defaultSort(message.active);
        }
        state.railCollapsed = Boolean(message.railCollapsed);
        document.body.classList.toggle('rail-collapsed', state.railCollapsed);
        render();
        break;
      case 'namespace':
        // Restores the saved preference at startup. Rows span all namespaces
        // regardless, so this only changes which of them are shown.
        state.namespace = message.namespace;
        render();
        break;
      case 'namespaces':
        state.namespaces = message.namespaces;
        render();
        break;
      case 'version':
        state.version = message.version || '';
        // Only the rail's context box grows; leave the table and scroll alone.
        renderRailOnly();
        break;
      case 'busy':
        if (message.kind !== state.active) break;
        state.busy = Boolean(message.busy);
        // Clearing the last failure optimistically only makes sense for a
        // refresh the user asked for: it acknowledges the click. An unattended
        // poll spins up on its own every few seconds, and wiping the banner on
        // each tick would blink the failure in and out while nothing is being
        // asked of the cluster differently.
        if (state.busy && !message.silent) {
          state.error = '';
          state.refreshError = '';
        }
        // Only the spinner changes, so leave the table and its scroll alone.
        renderFreshnessOnly();
        break;
      case 'cancelled':
        if (message.kind !== state.active) break;
        // Whatever is on screen was the newest thing available and no longer
        // has a fetch coming to replace it, so it is cached rather than live.
        // Not an error: this is what was asked for.
        state.busy = false;
        state.refreshError = '';
        if (!state.empty) state.stale = true;
        renderFreshnessOnly();
        break;
      case 'rows': {
        if (message.kind !== state.active) break;
        // Read before the rows are replaced: the first payload for a kind has
        // nothing to have changed against, and marking every row on it would
        // light the whole table up on arrival.
        const hadRows = Array.isArray(state.rows) && state.rows.length > 0;
        state.rows = message.rows;
        // Ticks for objects the refresh no longer reports — deleted here or by
        // someone else — are dropped, so the count in the bar always matches
        // rows that still exist. The shift-click anchor names a row rather than
        // a position, so it survives: it is resolved against the rows on screen
        // when a range is actually drawn, and a row that has gone simply
        // doesn't resolve.
        pruneChecked(message.rows);
        state.empty = false;
        state.stale = Boolean(message.stale);
        state.error = '';
        if (!message.stale) state.refreshError = '';
        state.generated = message.generated;
        // The refresh path, and the one that has to keep a selection alive: the
        // rail and toolbar don't depend on the rows, so rebuilding them would
        // throw away the user's place for nothing. The freshness label does,
        // and is written in place.
        //
        // The only paint that marks what moved. Cached rows replayed on arrival
        // are exempt: they are what was already on screen, or the first thing
        // to arrive for this kind, and neither is a change the user missed.
        flashChangedRows = !message.stale && hadRows;
        renderContentOnly();
        flashChangedRows = false;
        // Both pickers count over the rows, so they go stale the moment a new
        // payload lands. Switching kinds empties the table before the fetch,
        // and the render that follows builds the row against no rows at all —
        // leaving every namespace reading (0) over a table full of pods until
        // something else happened to rebuild it.
        renderFiltersOnly();
        renderFreshnessOnly();
        break;
      }
      case 'about':
        if (message.kind !== state.active) break;
        state.about = message.about;
        state.empty = false;
        state.stale = Boolean(message.stale);
        state.error = '';
        if (!message.stale) state.refreshError = '';
        state.generated = message.generated;
        render();
        break;
      case 'cacheStats':
        state.cacheStats = message.stats;
        state.preserveCache = Boolean(message.preserve);
        // Only About draws these, and a stats message can arrive alongside one
        // of its payloads, so re-rendering elsewhere would be wasted work.
        if (state.active === 'about') render();
        break;
      case 'overview':
        if (message.kind && message.kind !== state.active) break;
        state.overview = message.overview;
        state.empty = false;
        state.stale = Boolean(message.stale);
        state.error = '';
        if (!message.stale) state.refreshError = '';
        state.generated = message.generated;
        render();
        break;
      case 'scope':
        // Which owners count, resolved by the extension. A resolve that failed
        // never arrives here: it reports itself and leaves the view alone.
        //
        // `update` marks a re-resolve of the scope already on screen, after a
        // rollout moved the owner set. Only the rows it admits change, so this
        // touches neither the view's kind and namespace nor the selection, and
        // it is ignored once the scope is gone — a re-resolve in flight when
        // the chip was dismissed must not bring the scope back.
        if (message.update) {
          if (state.scope && state.active === 'pods') {
            state.scope = message.scope;
            renderContentOnly();
          }
          break;
        }
        enterScope(message.kind, message.scope);
        break;
      case 'error':
        if (message.kind !== state.active) break;
        // Cached content still beats an error page: keep showing it, and put
        // the failure in the toolbar instead of replacing the whole view.
        if (state.empty) {
          state.error = message.message;
        } else {
          state.stale = true;
          state.refreshError = message.message;
        }
        state.busy = false;
        render();
        break;
      case 'editing':
        // The full set, resent whenever an edit starts or ends. The panel may
        // have moved on to another row by the time a tab closes, so this is
        // stored per panel rather than on the selection.
        state.editing = message.editing || [];
        // Only the panel's buttons change, so spare the rail and toolbar.
        renderContentOnly();
        break;
      case 'describe':
        // A describe can outlive the selection that asked for it; anything that
        // no longer matches the open panel is stale and gets dropped.
        if (state.active !== message.kind || !state.selected || !isSelected(message)) break;
        if (message.error) {
          // A refresh that failed over cached text leaves the text alone and is
          // shown as a note; with nothing cached, the error is all there is.
          state.describe.error = message.error;
          state.describe.loading = false;
        } else {
          state.describe.text = message.text ?? '';
          state.describe.generated = message.generated ?? 0;
          state.describe.stale = Boolean(message.stale);
          state.describe.error = '';
          // A cached reply is followed by a fresh one, so stay in the loading
          // state until that arrives.
          state.describe.loading = Boolean(message.stale);
        }
        renderContentOnly();
        break;
      case 'events':
        // Same rule as describe: a reply for a row that is no longer open is
        // stale by definition and gets dropped.
        if (state.active !== message.kind || !state.selected || !isSelected(message)) break;
        if (message.error) {
          state.events.error = message.error;
          state.events.loading = false;
        } else {
          state.events.rows = message.rows || [];
          state.events.generated = message.generated || 0;
          state.events.stale = Boolean(message.stale);
          state.events.error = '';
          // A cached reply is followed by a fresh one; stay loading until it lands.
          state.events.loading = Boolean(message.stale);
        }
        renderContentOnly();
        break;
      case 'fatal':
        state.error = message.message;
        state.busy = false;
        render();
        break;
    }
  });

  /**
   * True while the keystroke belongs to a field the user is typing into, so
   * the bare '/' shortcut doesn't swallow a slash meant for the filter itself.
   */
  function typingInField(target) {
    if (!target) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
  }

  /** Puts the cursor in the filter box and selects what's there, ready to retype. */
  function focusSearch() {
    const node = searchInput();
    if (!node) return false;
    node.focus();
    node.select();
    return true;
  }

  document.addEventListener('keydown', (e) => {
    // The delete dialog handles its own keys; one that arrives here came from
    // outside it, and nothing behind a modal should react.
    if (deleteDialog) return;

    // An open context menu has the keyboard to itself.
    if (rowMenu) {
      if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault();
        closeRowMenu();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        stepRowMenu(e.key === 'ArrowDown' ? 1 : -1);
      }
      return;
    }

    if (e.key === 'Escape' && state.selected) {
      selectRow(null);
      renderContentOnly();
      return;
    }

    // With no panel open, Escape backs out of the selection instead — the same
    // "get me out of this" reflex, applied to whatever mode is actually on.
    if (e.key === 'Escape' && state.checked.size && !typingInField(e.target)) {
      clearChecked();
      renderContentOnly();
      return;
    }

    // With nothing on screen to dismiss, Escape leaves the drill-down — the
    // same reflex one level further out, and the keyboard's version of the
    // back button.
    if (e.key === 'Escape' && state.origin && !typingInField(e.target)) {
      goBack();
      return;
    }

    // Last of the Escape branches, once there is no panel and no selection to
    // back out of: stop the fetch in flight. It comes last because dismissing
    // what's on screen is the more common reflex and a poll nobody asked for is
    // often what `busy` means — but against a slow or unreachable cluster this
    // is the one thing a refresh otherwise makes you sit and wait out. The rows
    // already on screen stay put.
    if (e.key === 'Escape' && state.busy && !typingInField(e.target)) {
      post({ type: 'cancelLoad' });
      return;
    }

    // Ctrl/Cmd+F takes over from the webview's own find widget: within a table
    // view the filter is the more useful search, and it narrows the rows rather
    // than just highlighting the ones already rendered.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'f' || e.key === 'F')) {
      if (focusSearch()) e.preventDefault();
      return;
    }

    // Bare '/' is the unmodified shortcut, so it only applies outside a field.
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !typingInField(e.target)) {
      if (focusSearch()) e.preventDefault();
      return;
    }

    // Ctrl/Cmd shortcuts for the bulk actions, on the same terms as their
    // buttons: a table view, with rows ticked. They run the action's own `run`,
    // so the shortcut and the button cannot diverge — and every destructive one
    // confirms before anything is touched.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && isTable() && !state.selected
        && !typingInField(e.target)) {
      const action = bulkActionsFor(kindOf(state.active))
        .find((a) => a.key && a.key === e.key.toLowerCase());
      if (action) {
        // Swallowed even with nothing ticked: the shortcut is ours either way,
        // and letting it fall through to the host would be a surprise.
        e.preventDefault();
        const rows = checkedRows();
        if (rows.length) action.run(rows);
        return;
      }
    }

    // Everything below drives the table's keyboard cursor, so it applies only
    // to a table view with the panel closed, and never while a field or a
    // control (a checkbox or button, which do their own thing with space and
    // the arrows) has focus.
    if (!isTable() || state.selected || typingInField(e.target)) return;
    if (e.target instanceof HTMLElement && e.target.closest('button, input, select, a')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // Otherwise the webview scrolls the table out from under the cursor.
      e.preventDefault();
      moveCursor(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }

    // Home and End come along for free: the same move, sized to the list.
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      moveCursor(e.key === 'Home' ? -Infinity : Infinity);
      return;
    }

    if (e.key === ' ' || e.key === 'Spacebar') {
      const rows = visibleRows();
      const at = cursorIndex(rows);
      if (at === -1) return;
      // Space is also the page's scroll key, so it is only swallowed once it
      // has a row to act on.
      e.preventDefault();
      toggleChecked(rows, at, !isChecked(rows[at]), e);
      scrollCursorIntoView();
      return;
    }

    // Enter opens the row under the cursor, matching what a click on it does;
    // Shift+Enter drills into its pods instead, for the kinds that have them.
    if (e.key === 'Enter') {
      const rows = visibleRows();
      const at = cursorIndex(rows);
      if (at === -1) return;
      e.preventDefault();
      if (e.shiftKey && ownsPods(state.active)) {
        showOwned(state.active, rows[at]);
        return;
      }
      selectRow(rows[at]);
      renderContentOnly();
    }
  });

  /**
   * Ages are spans from a fixed timestamp, so they go stale on their own —
   * without any new data. Once a second the age cells on screen are recomputed
   * from the timestamps they already carry and their text is swapped in place.
   *
   * Deliberately not a re-render: the table is rebuilt by `renderContentOnly`,
   * which would move focus out of the filter box, drop an open select and redo
   * the row work every second. Writing `textContent` on the handful of cells
   * that changed touches nothing else on the page.
   *
   * Sort order is left alone between fetches on purpose. Rows age at the same
   * rate, so their order by age almost never changes, and resorting the table
   * under the pointer would move a row out from under a click.
   */
  setInterval(() => {
    if (document.hidden) return;
    for (const cell of app.querySelectorAll('[data-age-from]')) {
      // A table cell reads "5m"; a detail line reads "5m ago". The suffix rides
      // along on the element so the ticker doesn't have to know which is which.
      const next = formatAge(cell.getAttribute('data-age-from'))
        + (cell.getAttribute('data-age-suffix') ?? '');
      if (cell.textContent !== next) {
        cell.textContent = next;
      }
      // The tooltip is the fixed moment the age counts from, so it survives the
      // text swap untouched.
    }
    // The freshness label counts from the same clock and would otherwise sit
    // at "updated 0s ago" until the next fetch.
    const freshness = app.querySelector('.toolbar .freshness');
    if (freshness && !state.busy) renderFreshnessOnly();
  }, 1000);

  render();
  post({ type: 'ready' });
})();
