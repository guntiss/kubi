# Changelog

All notable changes to Kubi are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`!` excludes in the query box.** `!running` hides every row mentioning
  "Running", alongside the leading minus that already did this.

### Changed

- **Smaller download.** The extension and webview assets are minified at package
  time, taking the `.vsix` from 139 KB to 54 KB. The sources in `media/` stay
  readable, and a development build still serves them unminified.

## [1.0.0] — 2026-09-19

First public release.

### Added

- **Contexts sidebar.** Every context in the kubeconfig, current one first and
  the rest alphabetical, each showing its cluster, user and default namespace on
  hover. Contexts can be opened, or set as the kubeconfig's current context,
  from the context menu.
- **A dashboard per context**, each in its own editor tab and pinned to its own
  cluster — every call passes `--context` explicitly, so opening a dashboard
  never mutates the kubeconfig's current context.
- **Overview.** The pods that are not healthy right now, and every Warning event
  the cluster is holding, grouped by reason and counted by the cluster's own
  repeat count so a hundred rows of the same BackOff read as one problem.
- **Resource tables** across Cluster, Workloads, Network, Config and Storage —
  sortable and filterable, with columns matched to each kind and status pills
  colored by health.
- **Detail drawer** with Describe, YAML, Logs, Shell, Pods, Scale and Delete,
  plus an Events section listing everything the cluster recorded about the
  selected object.
- **Previous logs** for a container that restarted, so the crash that caused a
  restart is readable after the fact.
- **Pod scoping.** `Shift`+`Enter` on a workload, or **Pods** in the drawer,
  narrows the pod table to that workload — matched by ownership rather than by
  label selector, so workloads sharing an `app=` label stay separate.
- **Query language** in every table's filter box: `status:Running`,
  `restarts:>3`, `age:<2h`, `-status:Running`, quoted values, and AND-combined
  terms.
- **Auto-refresh**, configurable and applied only to visible dashboards, with
  caching so a reopened page paints from cache before it refetches.
- **`kubi.kubeconfigPath`.** Points the extension at a kubeconfig other than
  the default, without touching `$KUBECONFIG` for the rest of the machine.
  Useful for keeping a set of clusters — a demo set, a customer's — separate
  from the ones you work with day to day. Accepts `~` and a `:`-joined list.
  Changing it re-reads the contexts sidebar.

### Security

- Secrets list their key names and never their values.

[1.0.0]: https://github.com/guntiss/kubi/releases/tag/v1.0.0
