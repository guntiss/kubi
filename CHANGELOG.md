# Changelog

All notable changes to Kubi are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

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
