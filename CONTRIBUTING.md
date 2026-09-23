# Contributing to Kubi

Thanks for taking a look. Issues and pull requests are welcome.

## Getting set up

You need Node 20+, `kubectl` on your `PATH`, and a kubeconfig pointing at a
cluster you don't mind poking at. A local `kind` or `minikube` cluster is ideal —
some of what the extension surfaces (crash loops, failing probes, pending pods)
is easiest to test on a cluster you can deliberately break.

```
npm install
npm run compile
```

Press <kbd>F5</kbd> to launch an Extension Development Host with the extension
loaded. `npm run watch` recompiles on save; reload the host window
(<kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>R</kbd>) to pick the changes up.

To build an installable package:

```
npm run package
code --install-extension kubi-<version>.vsix
```

## How the code is laid out

| File | What lives there |
| --- | --- |
| `src/extension.ts` | Activation: registers the tree view, commands and the webview serializer. |
| `src/kubectl.ts` | Every `kubectl` invocation. Nothing else shells out. |
| `src/model.ts` | Per-kind knowledge: columns, how a row is built, how health is judged. |
| `src/metrics.ts` | CPU and memory from metrics-server, and the history behind the sparklines. |
| `src/panel.ts` | The dashboard webview host — message handling, loading, caching. |
| `src/tree.ts` | The contexts sidebar. |
| `src/cache.ts` | The per-context payload cache that lets a reopened page paint instantly. |
| `media/dashboard.js` | The webview front end. Plain DOM, no framework, no build step. |
| `media/dashboard.css` | Dashboard styling, themed off VS Code's CSS variables. |
| `media/icon.svg` | Source for the marketplace tile. |
| `media/icon.png` | The marketplace tile itself, rendered from `icon.svg`. |
| `media/icon-mono.svg` | The activity-bar icon. VS Code masks it to a flat colour. |

There is no bundler and no front-end framework. `media/dashboard.js` is served
to the webview as-is, which keeps the build to a single `tsc` invocation; please
keep it that way unless there's a strong reason not to.

## The icon

The mark — a lightning bolt inside the Kubernetes hexagon — is drawn four
times: `media/icon.svg` for the marketplace tile, `media/icon-mono.svg` for the
activity bar, and inline in both `src/panel.ts` (`BRAND_MARK`) and
`media/dashboard.js` (`BRAND_HEX`/`BRAND_BOLT`) for the dashboard rail. The two
inline copies share their path data; change one and change the other.

Everywhere but the tile the mark is a single colour: the activity bar masks it
to a flat silhouette, and the rail tints it with `currentColor`. So the bolt and
the hexagon must never touch — there is no keyline to separate them once the
colour is gone. Check any change in greyscale before shipping it.

`media/icon.png` is rendered from `media/icon.svg` at 256px, the largest size
the marketplace shows. Render it at that size directly rather than downscaling a
larger image, which visibly softens the edges:

```
chrome --headless --force-device-scale-factor=1 --window-size=256,256 \
  --default-background-color=00000000 --screenshot=icon.png page-with-svg.html
```

`icon-mono.svg` uses a viewBox cropped to the mark's inked bounds, stroke miters
included, so it fills the activity bar's own padding rather than adding more.

## Conventions

**Adding a resource kind** means adding it to `src/model.ts` — its columns, its
row builder, and how its health is judged — and to the rail grouping. If it
needs a `kubectl` call that doesn't exist yet, that call belongs in
`src/kubectl.ts`.

**Health should reflect what actually goes wrong with that kind.** A bare phase
is rarely the answer: a crash-looping pod is `phase: Running`, so pod status
reads container-level `waiting`/`terminated` reasons instead. Something
deliberately idle — a scaled-to-zero Deployment, a suspended CronJob, a finished
Job — should read grey rather than green, so the healthy count only covers what
is really serving.

**Comments explain why, not what.** The existing code leans heavily on this, and
it's the convention most worth matching: if a line looks arbitrary, the comment
should say what breaks without it. `kubectl get events --field-selector
type=Warning` being unsupported on some versions is the reason a filter is
applied locally, and the code says so. Skip comments that restate the line.

**Never mutate the user's kubeconfig implicitly.** Every call passes `--context`
explicitly, and nothing changes the current context.

**Mutating actions confirm.** Delete always confirms; a scale to zero confirms,
because it stops the workload. Every confirmation names the context it is about
to act on, since the same workload name exists in every cluster.

**Secrets show key names, never values.**

## Releasing

Publishing is driven by a version tag: `.github/workflows/release.yml` fires on
`v*`, packages the extension, attaches the `.vsix` to a GitHub release and
pushes to the marketplace. So whatever reaches users is always a commit that
exists here, and a bump that is never tagged never ships.

Version numbers follow semver: **patch** for fixes and packaging or metadata
changes, **minor** for new resource kinds, commands or settings, **major** for
removing or renaming a command or setting, changing a default in a way that
breaks existing configs, or raising `engines.vscode`.

`npm run changelog` drafts the next entry from the commits since the last tag,
grouping them into Keep a Changelog sections by their leading verb. It prints
to stdout by default; `-- --write` inserts it into `CHANGELOG.md` and stops
there, leaving the commit to you:

```
npm run changelog -- --write --release patch
```

The generated bullets are commit subjects, which are rarely the sentence a
reader wants — edit them before committing. The 1.0.0 entry is the register to
aim for: what changed, and why it matters to someone using the extension.

Then bump, commit and tag. `.npmrc` sets `git-tag-version=false`, so
`npm version` only rewrites `package.json` and `package-lock.json` -- the
commit and the tag are yours to make, once you have read the diff:

```
npm version patch
git add package.json package-lock.json CHANGELOG.md
git commit -m "Release 1.0.2"
git tag v1.0.2
git push --follow-tags
```

Always let `npm version` edit the version field rather than typing it, so
`package-lock.json` stays in step. The bump and its changelog entry belong in
one commit, and the tag goes on that commit: the workflow packages whatever the
tag points at, so a tag on a commit that predates the bump publishes the old
version number.

## Pull requests

Please make sure `npm run compile` is clean, and say in the description which
cluster you tried it against — a lot of behavior here only shows up against real
resources. Screenshots help for anything that changes the dashboard.
