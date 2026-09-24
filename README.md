# ⚡ Kubi

[![Marketplace](https://vsmarketplacebadges.dev/version-short/guntiss.kubi.svg?label=marketplace)](https://marketplace.visualstudio.com/items?itemName=guntiss.kubi)
[![Installs](https://vsmarketplacebadges.dev/installs-short/guntiss.kubi.svg?label=installs)](https://marketplace.visualstudio.com/items?itemName=guntiss.kubi)
[![CI](https://github.com/guntiss/kubi/actions/workflows/ci.yml/badge.svg)](https://github.com/guntiss/kubi/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Manage Kubernetes clusters in VS Code at lightning speed.**

To get started, run this in your terminal: `code --install-extension guntiss.kubi`

## A look around

| | |
| --- | --- |
| <a href="https://raw.githubusercontent.com/guntiss/kubi/main/docs/overview.png"><img src="https://raw.githubusercontent.com/guntiss/kubi/main/docs/overview.png" width="400" alt="The Overview, leading with unhealthy pods and Warning events grouped by reason"></a><br>**Overview** — unhealthy pods and Warning events at a glance. | <a href="https://raw.githubusercontent.com/guntiss/kubi/main/docs/nodes.png"><img src="https://raw.githubusercontent.com/guntiss/kubi/main/docs/nodes.png" width="400" alt="The Nodes table with CPU and memory sparklines, and a node's right-click menu"></a><br>**Resource tables** — live usage, right-click actions. |
| <a href="https://raw.githubusercontent.com/guntiss/kubi/main/docs/node-details.png"><img src="https://raw.githubusercontent.com/guntiss/kubi/main/docs/node-details.png" width="400" alt="The detail drawer for a node, with its CPU and memory history and its events"></a><br>**Detail drawer** — usage history, events and actions. | <a href="https://raw.githubusercontent.com/guntiss/kubi/main/docs/describe.png"><img src="https://raw.githubusercontent.com/guntiss/kubi/main/docs/describe.png" width="400" alt="The Describe tab of a deployment's drawer, with kubectl describe output highlighted"></a><br>**Describe** — highlighted `kubectl describe` in the drawer. |
| <a href="https://raw.githubusercontent.com/guntiss/kubi/main/docs/shell-terminal.png"><img src="https://raw.githubusercontent.com/guntiss/kubi/main/docs/shell-terminal.png" width="400" alt="A pod's logs and a shell open side by side in VS Code's terminal"></a><br>**Logs and shell** — right in VS Code's terminal. | <a href="https://raw.githubusercontent.com/guntiss/kubi/main/docs/delete.png"><img src="https://raw.githubusercontent.com/guntiss/kubi/main/docs/delete.png" width="400" alt="Four selected pods and the confirmation dialog for deleting them"></a><br>**Bulk actions** — select rows, act on them at once. |

## Why Kubi

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

## Main features

**Dashboard — one editor tab per context.** Inside a dashboard:

- **Overview** — unhealthy pods and every Warning event the cluster is holding,
  grouped by reason. A cluster whose events have all expired past their TTL says
  so rather than claiming all is well.

- **Resource tables** — sortable, filterable tables with columns matched to each
  kind, and status pills colored by health. The rail groups them:

  | Group | Kinds |
  | --- | --- |
  | Cluster | Nodes, Namespaces, Events |
  | Workloads | Pods, Deployments, StatefulSets, DaemonSets, ReplicaSets, Jobs, CronJobs, Autoscalers |
  | Network | Services, Ingresses, Endpoints, Network policies |
  | Config | ConfigMaps, Secrets, Service accounts, Resource quotas, Limit ranges |
  | Storage | Volume claims, Volumes, Storage classes |

  Tick rows for the bulk actions with their checkboxes, or drag across the
  table to draw a selection box, as on the desktop: a plain drag replaces the
  ticks, **Shift** adds to them and **Ctrl**/**Cmd** flips the rows it covers.
  Dragging is experimental; turn it off with `kubi.dragToSelect`.

- **Detail drawer** — select a row for its fields plus actions: Describe, YAML,
  Logs, Shell, Pods, Scale, Delete. Scale is offered on Deployments, StatefulSets
  and ReplicaSets, starting from the replica count currently set; scaling to zero
  confirms first.
  Nodes add Cordon or Uncordon, and Drain, which confirms and then runs in a
  terminal. The same actions are on a row's right-click menu; with several rows
  ticked, the menu offers the bulk actions instead.

  The **Events** section lists everything the cluster recorded about the selected
  object, newest first. For a container that has restarted, **previous logs**
  reads the log of the instance that died — the one that explains the restart.

- **CPU and memory** — Nodes and Pods show live usage with a sparkline of the
  last ten minutes, once a full ten minutes has been recorded. Beside each,
  **CPU %** and **MEM %** give the usage as a share of the pod's limits or the
  node's allocatable; they turn yellow at 75% and red at 90%. The drawer draws
  the same history larger, and breaks pod usage down per container. Needs
  [metrics-server](https://github.com/kubernetes-sigs/metrics-server) in the
  cluster; without it the columns simply do not appear. The history is what
  the dashboard has seen since it opened, as metrics-server keeps none.

Every kind is judged on what actually goes wrong with it: a Deployment past its
progress deadline, an autoscaler that cannot read its metrics, a Service with no
ready endpoints, a quota at its limit, a namespace stuck `Terminating`.
Something deliberately idle — a scaled-to-zero Deployment, a suspended CronJob, a
finished Job — reads grey rather than green, so the healthy count only covers
what is really serving.

Secrets list their key names and never their values.

### About

The last item in the rail pairs your `kubectl` version against the cluster's and
says whether the skew is inside Kubernetes' support policy, names the user and
groups the API server authenticated you as — what your RBAC is really evaluated
against, not the kubeconfig entry's name — and lists the context, cluster,
default namespace and any `kubectl` plugins on your `PATH`.

### Pods of a workload

Select a row and press **Pods** in the drawer, or **Shift**+**Enter** on the row:
the pod table opens narrowed to that workload, with a chip naming the scope; `×`
widens it again. It works from Deployments, StatefulSets, DaemonSets,
ReplicaSets, Jobs and CronJobs.

Pods are matched by ownership rather than by label selector, so two Deployments
sharing an `app=` label do not show each other's pods. A Deployment is matched
through its ReplicaSets, so a rollout in progress shows the old and new pods
together.

### Filtering

Every table has a filter row: a namespace picker, a status picker, and a query
box. They combine, and `✕ Clear` resets all three, plus the pod scope.

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
`status` on every kind. An unrecognized field is treated as plain text, so a name
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

| Setting | Default | Description |
| --- | --- | --- |
| `kubi.kubectlPath` | `kubectl` | Path to the kubectl binary. |
| `kubi.kubeconfigPath` | *(empty)* | Kubeconfig to use instead of the default. Empty means `$KUBECONFIG`, or `~/.kube/config` when that is unset. Accepts `~` and a `:`-joined list, like `$KUBECONFIG` itself. |
| `kubi.editorCommand` | `code --wait` | Editor used as `KUBE_EDITOR` for `kubectl edit`. Must block until the file is closed. |
| `kubi.autoRefreshSeconds` | `5` | Auto-refresh interval in seconds; `0` disables. Only visible dashboards refresh. |
| `kubi.preserveCacheAfterUpdates` | `true` | Keep cached dashboard data when the extension updates, so the first dashboard opened after an update paints immediately. Turn it off if you would rather each update start empty: a view cached by an older build can paint blank cells until its first refresh replaces it. Also on the About page. |
| `kubi.dragToSelect` | `true` | Experimental: select table rows by dragging a selection box across them. |

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
cordon, drain and `kubectl edit` are the only mutating actions; delete and drain
always confirm first, as does a scale to zero.

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
