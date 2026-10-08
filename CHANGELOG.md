# Changelog

All notable changes to Kubi are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] — 2026-10-08

### Changed

- Narrow the collapsed rail back to 48px, insetting its pills by 6px to fit.
- Give the rail room to breathe and draw its kinds as SVG icons: rows are taller rounded pills with an edge bar on the open page, headings and Go to get more space, and each kind, Overview, About and Settings get a stroked icon in place of the Unicode characters.

## [1.2.0] — 2026-10-06

### Added

- Add a Port forward dialog that forwards several ports at once and sets the listen address, pod timeout and opening the browser, replacing the port and local-port prompts.

### Changed

- Offer to reload the window when a newer Kubi is installed, since VS Code keeps running the old version, open dashboards included, until it reloads.
- Open the About page with Kubi's tile, its version and links to GitHub for contributing, reporting an issue and the changelog.
- Play the rail mark's hover animation once per visit, instead of again every time a refresh rebuilds the rail under the pointer.
- Keep the rail's mark blue on hover and charge it instead: the hexagon turns a third of a turn while the bolt strikes and the mark lights up.
- Inset the rail's brand row from the top edge and Go to, so its hover background no longer runs into the frame.
- Replace the rail's folding sections with one customisable list of kinds, shared by every context, and name kinds by their Kubernetes names.
- Give the page header a minimum height, so Overview and About match the tables' band instead of shrinking to their title.
- Fit table columns to the rows shown, measuring them again whenever a refresh, the filter or the namespace changes what they hold.

### Removed

- Remove the context name and server version from the rail.

## [1.1.0] — 2026-10-06

### Added

- Add a Go to submenu to the row menu that opens a pod's node and owners, a Service's pods, and other related objects.
- Add kubi.tableSparklines, off by default, to draw CPU and memory sparklines in the Nodes and Pods tables.
- Add a Settings item to the dashboard sidebar that opens Kubi's settings.

### Changed

- Name a pod's Deployment and CronJob in Go to, read off its ReplicaSet's or Job's name rather than looked up.
- Tint ticked table rows with the focus colour, keeping failing and pending rows' washes readable under it.
- Hide the toolbar spinner along with the Refresh button.
- Keep auto-refreshing a dashboard that is visible in another editor group while VS Code has focus.
- Hide the toolbar Refresh button and refresh with Ctrl/Cmd+R, showing the load bar until it lands.

### Removed

- Remove the kubi.allowSecretReveal setting, leaving Reveal and Copy for Secret values always on.
- Drop the experimental label from drag-to-select.

## [1.0.7] — 2026-10-06

### Added

- Add a Logs tab to the detail drawer that streams a container's log, with a container picker, filter, and Follow, Wrap, Timestamps and Previous toggles.
- Add foldable rail sections and a Go to box, and split Policy out of Config.
- Add type-to-filter to the namespace picker.

### Changed

- Highlight the log line under the pointer and mark filter matches in the Logs tab.
- Show log lines that are JSON indented and coloured, with a JSON toggle that is on by default.
- Show log timestamps by default and leave long log lines unwrapped.
- Show log timestamps as local time of day, with the full date and time on hover.
- Make table columns resizable, movable and hideable, and compact the table views.
- Show a progress bar across the top of the page while data older than 10s is being refreshed.
- Put Workloads above Cluster in the rail, so Pods sits right under Overview.
- Rename kubi.dashboardLocation to kubi.dashboardEditorGroup, opening dashboards in the active editor group by default.

## [1.0.6] — 2026-09-29

### Added

- Add kubi.dashboardLocation setting, opening dashboards in a new tab by default.
- Add RBAC, PodDisruptionBudgets, PriorityClasses, IngressClasses and webhook configurations.
- Add Trigger now, Suspend and Resume for CronJobs.
- Add Restart for StatefulSets and DaemonSets, warning on OnDelete.
- Add Reveal and Copy for Secret values in the drawer.
- Add Port forward for Pods, Services, Deployments and StatefulSets.

## [1.0.5] — 2026-09-25

### Added

- Add Restart for Deployments, via kubectl rollout restart.
- Add Ctrl/Cmd+A shortcut to select all rows.
- Add drag-to-select feature.

### Changed

- Stop Ctrl/Cmd+A selecting page text behind drawers and dialogs.

## [1.0.4] — 2026-09-23

### Added

- Add metrics integration.
- Add Logs and Shell actions for Deployments, StatefulSets, DaemonSets and ReplicaSets.
- Add an Open Another Window context-menu entry for extra dashboards on one context.
- Add Cordon, Uncordon and Drain for nodes.
- Add Previous logs to the pod row menu once a container has restarted.
- Add Logs and Shell for a pod's main container to the row menu.
- Add a right-click context menu to table rows with the detail panel's actions.
- Add a Pods button to nodes that shows the pods scheduled on them.

### Changed

- Update readme & screenshots.
- Show table sparklines only once a row has a full window of history.
- Show CPU and memory % for pods whose sidecars set no limit.
- Frame table sparklines with a border so partial data reads clearly.
- Show live Terminating duration and grace period on pod status.
- Clear the refresh-failed note when a background refresh succeeds.
- Use a blue icon for dashboard tabs.
- Update package description.
- Keep pending-row pulses in step and let hover shade them.
- Pulse the wash on pending (yellow) rows.
- Confirm deletes in a custom dialog with a Force checkbox, off by default.
- Stop tinting ticked rows so the health wash stays visible.
- Offer only bulk actions in the row menu when several rows are ticked.
- Keep the context-menu row outlined across background refreshes.
- Let kubectl choose the container for the row menu's Logs and Shell.
- Replace the row menu's Details item with Describe.
- Show Terminating status for pods being deleted.
- Refresh status & button improvements.
- Push release tags by name, not --follow-tags.

### Removed

- Remove the Set as Current Context command.
- Drop the bold from the name column.
- Remove the fade-and-collapse animation for rows that leave the table.
- Drop the ellipsis from Drain; it only confirms, like Delete.

## [1.0.3] — 2026-09-22

### Added

- Add "Preserve cache after updates" setting, on by default,

### Changed

- Bump the package version alongside the changelog entry.
- Hide the action bar when nothing is selected.
- Fade and collapse rows when they leave the table.
- Stop the row flash firing on age alone.
- Shorten the row-change flash to 1.4s.
- Make the row-change flash fade out instead of switching off.

### Fixed

- Checkbox sometimes doesn't reset.
- Fix uncaught "Webview is disposed" errors.

## [1.0.2] — 2026-09-21

### Added

- Add changelog generator script.

### Changed

- Replace retired Shields marketplace badges with vsmarketplacebadges.dev.

### Fixed

- Namespace filter not showing correct count.

## [1.0.1] — 2026-09-19

Updated extension name.
Exclude unnecessary files from package

## [1.0.0] — 2026-09-19

First public release.
