# ⚡ Kubi

[![Marketplace](https://vsmarketplacebadges.dev/version-short/guntiss.kubi.svg?label=marketplace)](https://marketplace.visualstudio.com/items?itemName=guntiss.kubi)
[![Installs](https://vsmarketplacebadges.dev/installs-short/guntiss.kubi.svg?label=installs)](https://marketplace.visualstudio.com/items?itemName=guntiss.kubi)
[![CI](https://github.com/guntiss/kubi/actions/workflows/ci.yml/badge.svg)](https://github.com/guntiss/kubi/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Manage Kubernetes clusters in VS Code at lightning speed — in a dashboard you
make your own.**

Keep only the resource kinds you use, in the order you want them. Arrange each
table's columns, hide the ones you never read, and add columns of your own from
any label. Kubi remembers all of it.

To get started, run this in your terminal: `code --install-extension guntiss.kubi`

## A look around

| | |
| --- | --- |
| <a href="https://raw.githubusercontent.com/guntiss/kubi/main/docs/overview.png"><img src="https://raw.githubusercontent.com/guntiss/kubi/main/docs/overview.png" width="400" alt="The Overview, leading with unhealthy pods and Warning events grouped by reason"></a><br>**Overview** — unhealthy pods and Warning events at a glance. | <a href="https://raw.githubusercontent.com/guntiss/kubi/main/docs/nodes.png"><img src="https://raw.githubusercontent.com/guntiss/kubi/main/docs/nodes.png" width="400" alt="The Nodes table with CPU and memory sparklines, and a node's right-click menu"></a><br>**Resource tables** — live usage, right-click actions. |
| <a href="https://raw.githubusercontent.com/guntiss/kubi/main/docs/node-details.png"><img src="https://raw.githubusercontent.com/guntiss/kubi/main/docs/node-details.png" width="400" alt="The detail drawer for a node, with its CPU and memory history and its events"></a><br>**Detail drawer** — usage history, events and actions. | <a href="https://raw.githubusercontent.com/guntiss/kubi/main/docs/describe.png"><img src="https://raw.githubusercontent.com/guntiss/kubi/main/docs/describe.png" width="400" alt="The Describe tab of a deployment's drawer, with kubectl describe output highlighted"></a><br>**Describe** — highlighted `kubectl describe` in the drawer. |
| <a href="https://raw.githubusercontent.com/guntiss/kubi/main/docs/shell-terminal.png"><img src="https://raw.githubusercontent.com/guntiss/kubi/main/docs/shell-terminal.png" width="400" alt="A pod's logs and a shell open side by side in VS Code's terminal"></a><br>**Logs and shell** — right in VS Code's terminal. | <a href="https://raw.githubusercontent.com/guntiss/kubi/main/docs/delete.png"><img src="https://raw.githubusercontent.com/guntiss/kubi/main/docs/delete.png" width="400" alt="Four selected pods and the confirmation dialog for deleting them"></a><br>**Bulk actions** — select rows, act on them at once. |

## Why Kubi

**Fully customizable.** Keep only the kinds you use, lay out each table your way, and
add columns from labels. See [Make it yours](#make-it-yours).

**Works out of the box.** All you need is VS Code and `kubectl` with your
existing kubeconfig. Cloud SSO works too.

**Shallow learning curve.** The friendly UI makes Kubi quick to learn and
master. Right-click context menus let you navigate quickly without memorizing
keyboard shortcuts.

**It feels super fast.** Every view is cache-first, and refreshes never clear
the screen, steal focus or block the UI — keep navigating and filtering while
the refresh happens in the background. Everything is optimized for speed, and
filtering happens client-side, so it is always instant.

**Notice issues faster.** A human-friendly overview page shows cluster issues at
a glance, without the need to dig through each page.

**Work with many clusters simultaneously.** Each context opens in its own editor
tab, and you can switch between them at any time. Every call passes `--context`
explicitly, and your kubeconfig is never modified. You can even set a custom
kubeconfig path for each workspace. Each window remembers its state even after
a reload, so you can continue where you left off.

**Use VS Code's native terminal and editor.** Quickly check logs for the current
or a terminated container, or open a shell to run commands. The native VS Code
terminal lets you quickly edit a command, add a `grep`, or even pipe the output
to a file on the fly. Editing Kubernetes resources is a breeze too, since it
happens right in the IDE, with syntax highlighting, formatting and the rest.

**The codebase is small and lightweight.** Around 5,000 lines of TypeScript
across seven files, with no runtime dependencies and no build step beyond `tsc`.
It is easy to read end to end, easy to submit a change to, and small enough to
hand to a coding agent with the whole thing in view.

## Make it yours

Most Kubernetes tools give everyone the same screen. Kubi lets you strip it down
to what you work with and shape the rest around it.

**Keep only the menu items you need.** The sidebar starts with the kinds most
sessions reach for, and every other kind waits under **More**. Drag a kind to
reorder it, or drag it onto **More** to remove it. Under **More**, hover a kind
and click **+** to add it, or drag it up into the list. Right-click any kind to
move it up or down, add or remove it, or **Reset sidebar** to the defaults. The
sidebar is one list for every context and every open dashboard, and it
collapses to icons when you want the room for the table.

**Arrange the columns.** Drag a header to move its column. Drag a header's edge
to set its width, and double-click the edge to fit it to its content again.
Right-click a header, or use the **Columns** button in the toolbar, to hide the
columns you don't need, show them again, or put the table back to its defaults.
Each table remembers its layout, in every dashboard.

**Add your own columns from labels.** **Add label column…** in the same menu
shows any label as a column under a name you choose, such as
`node.kubernetes.io/instance-type` as **SKU** on Nodes. It offers the labels on
the objects listed, with a few of their values, or takes a key you type. The
value is read from the list the table already fetches, so it costs no extra
calls. Right-click the header to rename or remove it, and filter on it like any
other column: `sku:D2ds`.

**Tune the UI and the behaviour.** Pick compact, default or comfortable rows;
draw CPU and memory sparklines in the tables; set the refresh interval or turn
it off; turn drag-to-select on or off; open new dashboards as a tab among your
editors or in the group beside them; and point each workspace at its own
kubeconfig, `kubectl` and editor. **Settings** at the bottom of the sidebar
takes you straight there — see [Settings](#settings) for the full list.

## Main features

**Dashboard — one editor tab per context.** Inside a dashboard:

- **Overview** — unhealthy pods and every Warning event the cluster is holding,
  grouped by reason. A cluster whose events have all expired past their TTL says
  so rather than claiming all is well.

- **Resource tables** — compact, sortable, filterable tables with columns
  matched to each kind, and statuses colored by health. The sidebar starts with
  the kinds most sessions reach for: Pods, Deployments, StatefulSets,
  DaemonSets, HPA, Nodes, Events, ConfigMaps, Secrets, PersistentVolumes, PVC,
  StorageClasses and Services. The rest wait under **More**, sorted by what they
  are for:

  | Group | Kinds |
  | --- | --- |
  | Workloads | Pods, Deployments, StatefulSets, DaemonSets, ReplicaSets, Jobs, CronJobs, HorizontalPodAutoscalers |
  | Cluster | Nodes, Events, Namespaces |
  | Network | Services, Ingresses, Endpoints, NetworkPolicies, IngressClasses |
  | Config | ConfigMaps, Secrets |
  | Storage | PersistentVolumeClaims, PersistentVolumes, StorageClasses |
  | Policy | ResourceQuotas, LimitRanges, PodDisruptionBudgets, PriorityClasses, ValidatingWebhookConfigurations, MutatingWebhookConfigurations |
  | Access | ServiceAccounts, Roles, RoleBindings, ClusterRoles, ClusterRoleBindings |

  Kinds go by their Kubernetes names. The few too long for the sidebar show
  their short name there instead (HPA, PVC, PDB), with the full name on hover.
  Add, remove and reorder them as described under
  [Make it yours](#make-it-yours).

  To skip the sidebar, press `:` (as in k9s) or click **Go to…** and type a
  kind's name, its kubectl short name (`svc`, `cm`, `pvc`) or its initials
  (`crb`).

  Tick rows for the bulk actions with their checkboxes, or drag across the
  table to draw a selection box, as on the desktop: a plain drag replaces the
  ticks, **Shift** adds to them and **Ctrl**/**Cmd** flips the rows it covers.
  Turn dragging off with `kubi.dragToSelect`.
  **Ctrl**/**Cmd**+**A** ticks every row shown. **Ctrl**/**Cmd**+**R** refreshes
  the view, with a progress bar across the top until it lands.

  Columns size themselves to their content and to the pane: when a table is
  too wide, the long text columns (node names, messages) give way before
  anything scrolls sideways. Move, resize and hide them, or add your own from
  labels, as described under [Make it yours](#make-it-yours).

- **Detail drawer** — select a row for its fields plus actions: Describe, YAML,
  Logs, Shell, Pods, Port forward, Scale, Restart, Delete. Scale is offered on Deployments,
  StatefulSets and ReplicaSets, starting from the replica count currently set;
  scaling to zero confirms first. Deployments, StatefulSets and DaemonSets add
  Restart, which confirms, describing how that kind rolls, and then replaces every
  pod through `kubectl rollout restart`; it warns when the update strategy is
  `OnDelete`, where nothing is replaced until the pods are deleted.
  Port forward is offered on Pods, Services, Deployments and StatefulSets. Its
  dialog lists the ports from the spec: tick one or several, give each a local
  port or leave it empty for any free one, and add ports the spec doesn't
  declare. It also sets the address to listen on (localhost unless changed;
  0.0.0.0 lets other machines connect), how long to wait for a running pod, and
  whether to open the browser once the forward listens. A local port already in
  use is reported in the dialog. The forward runs in a terminal you close to
  stop it.
  Nodes add Cordon or Uncordon, and Drain, which confirms and then runs in a
  terminal. CronJobs add Trigger now, which confirms and then creates a Job from
  the CronJob's template, offering to jump to that Job or to its pods, and
  Suspend or Resume, whichever changes something; both of those also work on
  several ticked rows. The same actions are on a row's right-click menu; with several rows
  ticked, the menu offers the bulk actions instead.

  The **Events** section lists everything the cluster recorded about the selected
  object, newest first. For a container that has restarted, **previous logs**
  reads the log of the instance that died — the one that explains the restart.

  Pods, Deployments, StatefulSets, DaemonSets and ReplicaSets add a **Logs** tab
  that follows a container's log right in the drawer, starting from its last
  1,000 lines. Pick the container from the dropdown (it opens on the one
  `kubectl` would pick), filter the lines, and toggle Follow, Wrap, Timestamps,
  JSON and Previous; colour codes are drawn as in the terminal. Timestamps show
  the time of day in your computer's timezone; hover one for the full date and
  time. Lines that are JSON are shown indented and coloured, unless JSON is
  toggled off. The filter marks each match in the text, and the line under the
  pointer is highlighted, so it is clear where a wrapped line or a JSON block
  starts and ends. A workload's log comes
  from one of its pods, as `kubectl logs deployment/…` picks it. The **Logs**
  buttons still open a terminal.

- **CPU and memory** — Nodes and Pods show live usage. Beside each reading,
  **CPU %** and **MEM %** give the usage as a share of the pod's limits or the
  node's allocatable; they turn yellow at 75% and red at 90%. The drawer charts
  the last ten minutes of usage, and breaks pod usage down per container. Turn
  on `kubi.tableSparklines` to draw that history as a sparkline beside each
  reading in the table too; a row's sparkline appears only once a full ten
  minutes has been recorded, so there are none for the first ten minutes. Needs
  [metrics-server](https://github.com/kubernetes-sigs/metrics-server) in the
  cluster; without it the columns simply do not appear. The history is what
  the dashboard has seen since it opened, as metrics-server keeps none.

Every kind is judged on what actually goes wrong with it: a Deployment past its
progress deadline, an autoscaler that cannot read its metrics, a Service with no
ready endpoints, a quota at its limit, a namespace stuck `Terminating`, a
disruption budget allowing no disruptions (the reason a drain sits waiting), a
binding to a role that does not exist, a `Fail` webhook whose Service has no
ready endpoints. Something deliberately idle — a scaled-to-zero Deployment, a suspended CronJob, a
finished Job — reads grey rather than green, so the healthy count only covers
what is really serving.

Secrets list their key names and never their values: the table refresh never
fetches or caches them. A Secret's drawer adds a Data section where each key has
**Reveal**, which fetches that one value fresh and shows it decoded until you hide
it, close the drawer or 30 seconds pass, and **Copy**, which puts it on the
clipboard without displaying it. A value that is not UTF-8 shows as
`<binary, N bytes>` and copies as base64.

### About

The last item in the rail opens with Kubi's own version and links to the GitHub
repository, the contributing guide, the issue tracker and the changelog. Under
that it pairs your `kubectl` version against the cluster's and says whether the
skew is inside Kubernetes' support policy, names the user and groups the API
server authenticated you as — what your RBAC is really evaluated against, not
the kubeconfig entry's name — and lists the context, cluster, default namespace
and any `kubectl` plugins on your `PATH`.

### Pods of a workload

Select a row and press **Pods** in the drawer, pick **Go to › Pods** from its
right-click menu, or press **Shift**+**Enter** on the row: the pod table opens
narrowed to that workload, with a chip naming the scope; `×` widens it again. It
works from Deployments, StatefulSets, DaemonSets, ReplicaSets, Jobs, CronJobs,
Nodes and Services.

Pods are matched by ownership rather than by label selector, so two Deployments
sharing an `app=` label do not show each other's pods. A Deployment is matched
through its ReplicaSets, so a rollout in progress shows the old and new pods
together. A Service owns nothing, so its pods are the ones its selector matches.

### Go to

A row's right-click menu has a **Go to** submenu for the objects it is tied to:
a pod's node, its controller (the Deployment and ReplicaSet, or the StatefulSet,
DaemonSet, Job or CronJob) and the volume claims it mounts; a ReplicaSet's
Deployment and a Job's CronJob; a Service's pods and Endpoints; an Ingress's
Services; the object an event is about; an autoscaler's target; a volume claim's
volume and back; a binding's role and service accounts. The object's table opens
with its row selected and its drawer open, and **←** (or **Esc**) goes back.

### Filtering

Every table has filters beside its title: a namespace picker, a status picker,
and a query box. They combine, and `✕ Clear` resets all three, plus the pod scope.

The namespace picker filters as you type: open it, or just start typing while
it has focus, then pick with the arrow keys and `Enter`. Names starting with
what you typed are listed first.

The status picker is built from the rows on screen, so it only offers what this
cluster reports, with a count beside each. It groups health buckets —
**Problems**, **Failing**, **Warning / pending**, **Healthy**, **Inactive** —
above the kind's own status words.

The query box matches plain words anywhere in a row, and understands a little
more than that:

| Query | Matches |
| --- | --- |
| `web` | any row containing `web` |
| `status:Running` | one column, case-insensitively |
| `ns:kube-system` | `ns`, `n` and `s` are short for namespace, name, status |
| `restarts:>3` | numbers compare — also `<`, `>=`, `<=`, `=` |
| `age:<2h` | ages and ready ratios compare too: `age:>7d`, `ready:<1` |
| `memory:>1Gi` | usage compares in quantities: `cpu:>500m`, `cpu:>=2` (cores) |
| `memPct:>80` | share of limits or allocatable, in percent — also `cpuPct` |
| `!running` | a leading `!` or minus excludes — also `-status:Running` |
| `reason:"Back-off restarting"` | quote a value with spaces |
| `ns:prod restarts:>0` | terms combine with AND |

Field names are the kind's own column keys, plus `name`, `namespace` and
`status` on every kind. A label column is addressed by its name with spaces
removed: `sku:D2ds`. An unrecognized field is treated as plain text, so a name
containing a colon still finds itself. Press `/` or `Ctrl`/`Cmd`+`F` to jump to
the box.

## Requirements

`kubectl` on your `PATH` and a readable kubeconfig. No cluster-side component, no
agent, no account.

## Installing

From the VS Code Marketplace — search **Kubi** in the Extensions view, or:

```
code --install-extension guntiss.kubi
```

Each [release](https://github.com/guntiss/kubi/releases) also attaches a `.vsix`:

```
code --install-extension kubi.vsix
```

Then open the **Kubi** icon in the activity bar, or run **Kubi: Open Dashboard**
from the command palette.

VS Code keeps running the old version after an update until the window
reloads, so when a newer Kubi is installed Kubi offers **Reload Window**. Open
dashboards come back after the reload on the page they were showing.

## Building from source

```
npm install
npm run compile
```

Press <kbd>F5</kbd> for an Extension Development Host, or `npm run package` to
build a `.vsix`. Packaging uses `vsce`, a devDependency — a plain `npm install`
is enough, but an install run with `--omit=dev` or `NODE_ENV=production` skips it
and `npm run package` then fails.

## Settings

**Settings** at the bottom of the dashboard's sidebar opens these in VS Code's
settings editor. Like any VS Code setting, each can be set for all your
windows or just for one workspace.

The sidebar, column layouts and label columns are not settings: you change
them in the dashboard itself, as described under
[Make it yours](#make-it-yours).

**Look and feel**

| Setting | Default | Description |
| --- | --- | --- |
| `kubi.rowHeight` | `default` | Height of the table rows: `compact`, close to the editor's line height; `default`, slightly taller; or `comfortable`, the most spacious. |
| `kubi.tableSparklines` | `false` | Draw a sparkline of the last ten minutes beside the CPU and memory readings in the Nodes and Pods tables. A row's sparkline appears only once a full ten minutes of readings has been recorded, so there are none for the first ten minutes after a dashboard opens. |
| `kubi.dragToSelect` | `true` | Select table rows by dragging a selection box across them. |
| `kubi.dashboardEditorGroup` | `active` | Which editor group a new dashboard opens in: `active` as a tab next to the editors already in the current group, or `beside` in the group to its side, as Open to the Side does. |
| `kubi.autoRefreshSeconds` | `5` | Auto-refresh interval in seconds; `0` disables. Only visible dashboards refresh. |
| `kubi.preserveCacheAfterUpdates` | `true` | Keep cached dashboard data when the extension updates, so the first dashboard opened after an update paints immediately. Turn it off if you would rather each update start empty: a view cached by an older build can paint blank cells until its first refresh replaces it. Also on the About page. |

**Cluster access and tools**

| Setting | Default | Description |
| --- | --- | --- |
| `kubi.kubeconfigPath` | *(empty)* | Kubeconfig to use instead of the default. Empty means `$KUBECONFIG`, or `~/.kube/config` when that is unset. Accepts `~` and a `:`-joined list, like `$KUBECONFIG` itself. |
| `kubi.kubectlPath` | `kubectl` | Path to the kubectl binary. |
| `kubi.editorCommand` | `code --wait` | Editor used as `KUBE_EDITOR` for `kubectl edit`. Must block until the file is closed. |

## Roadmap

- **All standard Kubernetes resources** — some are still missing.
- **More keyboard shortcuts** — reach the common actions from the row you are
  already on, without the drawer or the mouse.
- **Custom resources** — opt in to the CRDs your cluster defines and get them
  in the rail beside the built-in kinds.
- **More settings** — more of the defaults above made yours, per workspace.
- **Refactor filtering** - UI improvements

## Status

Early but usable: read-mostly across the standard resource types. Delete, scale,
restart, cordon, drain, trigger, suspend and `kubectl edit` are the only mutating
actions; delete, restart, drain and trigger always confirm first, as does a scale
to zero.

Expect rough edges, and please
[open an issue](https://github.com/guntiss/kubi/issues) when you find one —
which cluster and which Kubernetes version helps a lot.

## Contributing

Issues and pull requests are welcome. Most additions touch one file:

| To change | Edit |
| --- | --- |
| A resource kind's columns or status rules | [src/model.ts](src/model.ts) |
| The dashboard UI and its webview | [src/panel.ts](src/panel.ts) |
| How `kubectl` is invoked | [src/kubectl.ts](src/kubectl.ts) |
| The contexts sidebar | [src/tree.ts](src/tree.ts) |

See [CONTRIBUTING.md](CONTRIBUTING.md) for the layout and conventions.

## License

[MIT](LICENSE)
