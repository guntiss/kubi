import { execFile } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export class KubectlError extends Error {
  constructor(message: string, readonly stderr: string) {
    super(message);
  }
}

export const ALL_NAMESPACES = '__all__';

/**
 * Thrown when a run was aborted through its signal rather than failing on its
 * own. Callers tell the two apart to keep a cancellation out of the UI: nobody
 * needs an error banner for the refresh they just stopped.
 */
export class KubectlCancelled extends Error {
  constructor() {
    super('kubectl cancelled');
  }
}

export function isCancelled(err: unknown): boolean {
  return err instanceof KubectlCancelled;
}

function binary(): string {
  return vscode.workspace.getConfiguration('kubi').get<string>('kubectlPath') || 'kubectl';
}

/**
 * The configured kubeconfig, or undefined to let kubectl find its own the
 * usual way (`$KUBECONFIG`, then `~/.kube/config`). Empty and whitespace-only
 * settings count as unset, so clearing the field in the settings UI goes back
 * to the default rather than pointing kubectl at "".
 *
 * `~` is expanded here because this is passed to execFile rather than a shell,
 * and nothing else would expand it. The value may hold several files joined
 * the way `$KUBECONFIG` joins them, so each is expanded separately.
 */
export function kubeconfig(): string | undefined {
  const raw = vscode.workspace.getConfiguration('kubi').get<string>('kubeconfigPath')?.trim();
  if (!raw) return undefined;
  return raw
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.startsWith('~') ? path.join(os.homedir(), entry.slice(1)) : entry))
    .join(path.delimiter) || undefined;
}

/**
 * Prefixes the kubeconfig flag when one is configured. It leads the args so it
 * cannot land after a `--`, where it would belong to the command on the far
 * side rather than to kubectl.
 *
 * Not for the plugin calls — see runWithStdin.
 */
function withKubeconfig(args: string[]): string[] {
  const config = kubeconfig();
  return config ? ['--kubeconfig', config, ...args] : args;
}

/**
 * Runs kubectl against an explicit context. Every caller passes one so the
 * extension never depends on (or mutates) the kubeconfig's current-context.
 *
 * An optional `signal` kills the process. Dropping a promise on the floor does
 * not stop the kubectl behind it, and a cancelled refresh that leaves its
 * processes running is exactly the pile-up cancelling was meant to avoid.
 */
export function run(
  args: string[],
  context?: string,
  timeoutMs = 30000,
  signal?: AbortSignal
): Promise<string> {
  const full = withKubeconfig(context ? ['--context', context, ...args] : args);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new KubectlCancelled());
      return;
    }
    execFile(
      binary(),
      full,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, signal },
      (err, stdout, stderr) => {
        if (err) {
          // An abort surfaces as a killed process, which is indistinguishable
          // from a timeout by message alone — so the signal is what decides.
          if (signal?.aborted) {
            reject(new KubectlCancelled());
            return;
          }
          const detail = (stderr || err.message).trim();
          reject(new KubectlError(`kubectl ${args[0] ?? ''} failed: ${firstLine(detail)}`, detail));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

async function runJson<T>(args: string[], context?: string, signal?: AbortSignal): Promise<T> {
  return JSON.parse(await run([...args, '-o', 'json'], context, undefined, signal)) as T;
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim().length > 0);
  return line ? line.trim() : 'unknown error';
}

export interface KubeObject {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name: string;
    namespace?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    ownerReferences?: { kind?: string; name?: string; controller?: boolean }[];
  };
  // Shapes differ per kind; model.ts reads these defensively.
  spec?: any;
  status?: any;
}

interface ListResponse<T> {
  items: T[];
}

export interface ContextInfo {
  name: string;
  cluster: string;
  user: string;
  namespace?: string;
  current: boolean;
}

/** Reads all contexts from the kubeconfig without contacting any cluster. */
export async function listContexts(): Promise<ContextInfo[]> {
  const raw = await run([
    'config', 'view', '-o',
    'jsonpath={range .contexts[*]}{.name}{"\\t"}{.context.cluster}{"\\t"}{.context.user}{"\\t"}{.context.namespace}{"\\n"}{end}'
  ]);
  let current = '';
  try {
    current = (await run(['config', 'current-context'])).trim();
  } catch {
    // No current context set; not an error for our purposes.
  }
  return raw
    .split('\n')
    .map((line) => line.split('\t'))
    .filter((parts) => parts[0]?.trim())
    .map((parts) => ({
      name: parts[0].trim(),
      cluster: (parts[1] ?? '').trim(),
      user: (parts[2] ?? '').trim(),
      namespace: (parts[3] ?? '').trim() || undefined,
      current: parts[0].trim() === current
    }));
}

export interface VersionInfo {
  gitVersion?: string;
  major?: string;
  minor?: string;
  platform?: string;
  goVersion?: string;
  buildDate?: string;
}

export interface Versions {
  client?: VersionInfo;
  server?: VersionInfo;
  /** Why the server side is missing — an unreachable cluster still shows a client version. */
  serverError?: string;
}

/**
 * Both halves of `kubectl version`. The client half is answered from the local
 * binary even when the cluster is unreachable, so the two are reported
 * separately: `serverError` explains a missing server rather than blanking the
 * whole panel.
 */
export async function versions(context: string, signal?: AbortSignal): Promise<Versions> {
  // `--output=json` exits non-zero when the server is unreachable but still
  // prints the client block, so stdout is parsed even on failure.
  const parse = (raw: string): Versions => {
    const data = JSON.parse(raw) as { clientVersion?: VersionInfo; serverVersion?: VersionInfo };
    return { client: data.clientVersion, server: data.serverVersion };
  };
  try {
    return parse(await run(['version', '-o', 'json', '--request-timeout=5s'], context, 8000, signal));
  } catch (err) {
    // A cancelled run is not a dead cluster, so it must not fall through to the
    // client-only recovery below — that would report a bogus `serverError`.
    if (isCancelled(err)) {
      throw err;
    }
    const stderr = err instanceof KubectlError ? err.stderr : '';
    // Recover the client block from a partial run; `kubectl version --client`
    // never contacts the cluster, so it answers even when the context is dead.
    try {
      const local = parse(await run(['version', '-o', 'json', '--client'], undefined, 8000, signal));
      return { client: local.client, serverError: firstLine(stderr || errorText(err)) };
    } catch (inner) {
      if (isCancelled(inner)) {
        throw inner;
      }
      return { serverError: firstLine(stderr || errorText(err)) };
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The cluster's server version, for the rail. Best-effort: a cluster that
 * answers `get` but not `version` still gets a usable dashboard, so failures
 * return undefined rather than propagating.
 */
export async function serverVersion(context: string): Promise<string | undefined> {
  const { server } = await versions(context);
  return server?.gitVersion || undefined;
}

export interface WhoAmI {
  username?: string;
  uid?: string;
  groups?: string[];
}

/**
 * The authenticated identity, via the SelfSubjectReview API. `auth whoami` is
 * still marked experimental and the API is only served from Kubernetes 1.27, so
 * an older or restricted cluster answers with an error; that is reported as
 * text rather than treated as a failure of the panel.
 *
 * The response's `extra` map is deliberately dropped: on cloud providers it
 * carries credential material (an AWS access key id, for one), which has no
 * place on a dashboard someone may be screen-sharing.
 */
export async function whoAmI(context: string, signal?: AbortSignal): Promise<WhoAmI> {
  const raw = await run(['auth', 'whoami', '-o', 'json', '--request-timeout=10s'], context, 12000, signal);
  const review = JSON.parse(raw) as { status?: { userInfo?: WhoAmI } };
  const user = review.status?.userInfo ?? {};
  return { username: user.username, uid: user.uid, groups: user.groups };
}

export interface PluginInfo {
  /** The subcommand it answers to: `kubectl-neat` is invoked as `kubectl neat`. */
  name: string;
  /** Absolute path of the executable, which is what distinguishes two same-named plugins. */
  path: string;
}

/**
 * The kubectl plugins on PATH, as `kubectl plugin list` sees them — this is
 * what "enabled" means for a plugin: an executable named `kubectl-*` that
 * kubectl is willing to dispatch to.
 *
 * Contacts no cluster, so it is not passed a context. kubectl writes a
 * "Skipping..." warning to stderr for every unreadable PATH entry, and on a
 * typical macOS PATH that is several lines of noise about directories nobody
 * asked about; only stdout is parsed, so those never reach the panel.
 *
 * Shadowed plugins (a second executable of the same name later in PATH) are
 * reported by kubectl as a warning on stderr but still listed on stdout, so
 * the same name can legitimately appear twice with different paths.
 */
export async function listPlugins(): Promise<PluginInfo[]> {
  const raw = await run(['plugin', 'list'], undefined, 15000);
  return raw
    .split('\n')
    .map((line) => line.trim())
    // Only the path lines matter; the header sentence and any blank lines go.
    .filter((line) => line.startsWith('/') || /^[A-Za-z]:\\/.test(line))
    .map((path) => {
      const file = path.split(/[\\/]/).pop() ?? path;
      // Strip the `kubectl-` prefix and any extension, so the name shown is
      // what you would actually type after `kubectl`. Nested words keep the
      // dashes kubectl turns into spaces (`kubectl-view-secret` → view-secret).
      const name = file.replace(/^kubectl-/, '').replace(/\.(exe|bat|cmd|sh|py|rb)$/i, '');
      return { name, path };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listNamespaces(context: string): Promise<string[]> {
  const list = await runJson<ListResponse<KubeObject>>(['get', 'namespaces'], context);
  return list.items.map((i) => i.metadata.name).sort();
}

/** Lists a resource type. Pass namespace `undefined` for cluster-scoped kinds. */
export async function list(
  resource: string,
  context: string,
  namespace?: string,
  signal?: AbortSignal
): Promise<KubeObject[]> {
  const args = ['get', resource];
  if (namespace === ALL_NAMESPACES) {
    args.push('--all-namespaces');
  } else if (namespace) {
    args.push('-n', namespace);
  }
  const response = await runJson<ListResponse<KubeObject>>(args, context, signal);
  return response.items ?? [];
}

function scopeArgs(namespace?: string): string[] {
  return namespace && namespace !== ALL_NAMESPACES ? ['-n', namespace] : [];
}

/**
 * The events one object is the subject of.
 *
 * `involvedObject.name` is the only selector every server version agrees on:
 * the `regarding.name` field of events.k8s.io is not selectable, and the kind
 * is left out deliberately — a cluster serving the newer API stores no
 * `involvedObject.kind` to match against, and a name collision between two
 * kinds in one namespace is rarer than silently returning nothing.
 *
 * A cluster-scoped object (a Node, a PersistentVolume) has its events written
 * into `default`, not into no namespace at all, so those are searched across
 * all namespaces rather than assuming where kubelet put them.
 */
export async function eventsFor(
  name: string,
  context: string,
  namespace?: string,
  signal?: AbortSignal
): Promise<KubeObject[]> {
  const args = [
    'get', 'events',
    '--field-selector', `involvedObject.name=${name}`,
    ...(namespace ? ['-n', namespace] : ['--all-namespaces'])
  ];
  const response = await runJson<ListResponse<KubeObject>>(args, context, signal);
  return response.items ?? [];
}

export function describe(resource: string, name: string, context: string, namespace?: string): Promise<string> {
  return run(['describe', resource, name, ...scopeArgs(namespace)], context);
}

export function getYaml(resource: string, name: string, context: string, namespace?: string): Promise<string> {
  return run(['get', resource, name, ...scopeArgs(namespace), '-o', 'yaml'], context);
}

/**
 * The object's YAML with the cluster's bookkeeping stripped out, via the
 * kubectl-neat plugin: no managedFields, no status block, no
 * last-applied-configuration, none of the defaulted fields nobody wrote.
 *
 * Run as two processes rather than `kubectl neat get --`, because the plugin
 * mechanism does not forward kubectl's global flags and this extension must
 * never fall back on the kubeconfig's current-context. The fetch carries the
 * context; the neat stage only reshapes text and talks to nothing.
 */
export async function neatYaml(resource: string, name: string, context: string, namespace?: string): Promise<string> {
  const yaml = await getYaml(resource, name, context, namespace);
  try {
    return await runWithStdin(['neat', '-f', '-', '--output', 'yaml'], yaml);
  } catch (err) {
    const detail = err instanceof KubectlError ? err.stderr : errorText(err);
    // kubectl reports a missing plugin as an unknown command, which says
    // nothing about how to fix it.
    if (/unknown command|executable file not found|not found/i.test(detail)) {
      throw new Error('kubectl-neat is not installed. Install it with: kubectl krew install neat');
    }
    throw err;
  }
}

/**
 * Runs kubectl with `input` on stdin. Used for the plugins that filter text.
 *
 * Deliberately not given the kubeconfig flag: kubectl rejects a global flag
 * placed before a plugin name ("flags cannot be placed before plugin name"),
 * and these calls only reshape text that has already been fetched, so there is
 * no cluster for a kubeconfig to select.
 */
function runWithStdin(args: string[], input: string, timeoutMs = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      binary(), args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || err.message).trim();
          reject(new KubectlError(`kubectl ${args[0] ?? ''} failed: ${firstLine(detail)}`, detail));
          return;
        }
        resolve(stdout);
      }
    );
    // A kubectl that exited before reading — a missing plugin, most often —
    // breaks the pipe as we write. The exec callback already has the real
    // reason, so this only stops an EPIPE from crashing the host.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input);
  });
}

export function remove(resource: string, name: string, context: string, namespace?: string): Promise<string> {
  return run(['delete', resource, name, ...scopeArgs(namespace)], context, 60000);
}

/**
 * Sets an object's replica count.
 *
 * Returns as soon as the API server has accepted the new spec, without
 * `--timeout` or any wait for the pods to actually arrive: scaling to a number
 * the cluster cannot satisfy — no capacity, an unschedulable node selector — is
 * a normal thing to do and must not read as a failed command. The table's next
 * refresh is what shows how far the rollout has got.
 *
 * `--current-replicas` is deliberately not sent. It would make the write
 * conditional on the count the panel last saw, and that count can be seconds
 * old or, with an HPA attached, wrong the moment it was read; the failure it
 * produces ("current replicas 4 does not match 3") is not something the user
 * can act on.
 */
export function scale(
  resource: string,
  name: string,
  replicas: number,
  context: string,
  namespace?: string
): Promise<string> {
  return run(
    ['scale', resource, name, `--replicas=${replicas}`, ...scopeArgs(namespace)],
    context,
    60000
  );
}

/**
 * Deletes several objects of one kind that share a namespace, in a single
 * kubectl call. One process instead of one per object matters for a bulk
 * delete: a hundred rows would otherwise be a hundred process spawns and a
 * hundred round trips.
 *
 * The timeout scales with the batch, since kubectl waits for each object's
 * graceful termination before it reports, but stays bounded so a wedged
 * finalizer cannot leave the call pending forever.
 */
export function removeMany(
  resource: string,
  names: string[],
  context: string,
  namespace?: string
): Promise<string> {
  const timeout = Math.min(10 * 60000, 60000 + names.length * 5000);
  return run(['delete', resource, ...names, ...scopeArgs(namespace)], context, timeout);
}

/**
 * Opens `kubectl edit` with VS Code itself as the editor. `code --wait` blocks
 * until the tab closes, which is what lets kubectl apply the result, so this
 * call stays pending for as long as the user has the file open — hence no
 * timeout. Resolves with kubectl's stdout ("edited", "unchanged", ...).
 */
export function edit(resource: string, name: string, context: string, namespace?: string): Promise<string> {
  const args = withKubeconfig(['--context', context, 'edit', resource, name, ...scopeArgs(namespace)]);
  const editor = vscode.workspace.getConfiguration('kubi').get<string>('editorCommand') || 'code --wait';
  const config = kubeconfig();
  return new Promise((resolve, reject) => {
    execFile(
      binary(),
      args,
      {
        timeout: 0,
        maxBuffer: 32 * 1024 * 1024,
        env: {
          ...process.env,
          KUBE_EDITOR: editor,
          EDITOR: editor,
          ...(config ? { KUBECONFIG: config } : {})
        }
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || err.message).trim();
          reject(new KubectlError(`kubectl edit failed: ${firstLine(detail)}`, detail));
          return;
        }
        resolve((stdout || stderr).trim());
      }
    );
  });
}
