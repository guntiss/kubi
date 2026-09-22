import * as k from './kubectl';

export type Health = 'ok' | 'warn' | 'bad' | 'muted';

export interface Column {
  key: string;
  label: string;
  /** Hidden below ~900px in the webview. */
  secondary?: boolean;
  /** Right-align numeric-ish values. */
  numeric?: boolean;
}

/**
 * One container of a pod, flattened for the details modal. Everything here is
 * read off the pod object the table already fetched, so opening a pod costs no
 * extra call and the panel's cached rows replay the container list too.
 */
export interface ContainerInfo {
  name: string;
  image: string;
  /** Init and ephemeral containers are listed apart from the ordinary ones. */
  kind: 'init' | 'app' | 'ephemeral';
  ready: boolean;
  health: Health;
  /** Phase word for the pill: Running / Waiting / Terminated / Completed. */
  state: string;
  /** What the state is caused by: CrashLoopBackOff, OOMKilled (137), ... */
  reason: string;
  /** The state's own message, long enough that it belongs in a tooltip. */
  message: string;
  restarts: number;
  /** Running since; carried as a timestamp so the webview can age it live. */
  startedAt?: string;
  /** How the previous instance ended — the explanation for a restart count. */
  lastReason?: string;
  lastFinishedAt?: string;
  /** Configured probes, by name: liveness, readiness, startup. */
  probes: string[];
  ports: string;
  /** "request / limit", with an em dash for whichever is unset. */
  cpu: string;
  memory: string;
}

export interface Row {
  name: string;
  namespace?: string;
  /**
   * `metadata.uid`: the one field that tells two objects apart when they share
   * a name. A pod deleted and recreated under the same name is a different
   * object, and the webview keys a row's tick by this so the new one does not
   * inherit the old one's checkbox. Optional because some kinds are synthesised
   * rather than read back from the API server.
   */
  uid?: string;
  /**
   * Creation time, carried so the webview can recompute the age cell. A cached
   * row is replayed long after it was fetched, and a frozen "5m" would lie.
   */
  created?: string;
  health: Health;
  /** Short status word shown in the pill, e.g. Running / Ready. */
  status: string;
  cells: Record<string, string>;
  /** Free-text blob the client filters against. */
  search: string;
  /** Pods only: what is actually running inside, for the details modal. */
  containers?: ContainerInfo[];
  /**
   * Scalable kinds only: `spec.replicas` as a number, so the scale prompt can
   * open on the count that is actually set. Kept apart from the `ready` cell,
   * which is display text ("3/5") and rounds a missing spec to 0.
   */
  replicas?: number;
  /**
   * The controller that created this object; see `ownerOf`. Carried on every
   * kind that has one so a row can be matched to its owner without another
   * fetch: it is what scoping the pod table to a Deployment resolves through,
   * pod -> ReplicaSet -> Deployment.
   */
  owner?: Owner;
}

/** A `kind/name` pair from an ownerReference, within the object's namespace. */
export interface Owner {
  kind: string;
  name: string;
}

/**
 * Rail sections. A flat list of thirty kinds is a wall of names; grouping them
 * the way the API itself is organised lets someone find a kind by what it does
 * rather than by reading every entry. Order here is the order they appear.
 */
export type KindGroup = 'cluster' | 'workloads' | 'network' | 'config' | 'storage';

export const GROUPS: { id: KindGroup; label: string }[] = [
  { id: 'cluster', label: 'Cluster' },
  { id: 'workloads', label: 'Workloads' },
  { id: 'network', label: 'Network' },
  { id: 'config', label: 'Config' },
  { id: 'storage', label: 'Storage' }
];

export interface ResourceKind {
  id: string;
  label: string;
  singular: string;
  namespaced: boolean;
  icon: string;
  group: KindGroup;
  columns: Column[];
  /** Column the table sorts by on first open; defaults to name ascending. */
  sort?: { key: string; dir: number };
  /**
   * Has a `spec.replicas` the scale subresource can write — the panel offers a
   * Scale button for these and nothing else.
   *
   * DaemonSets are excluded on purpose: their count is one pod per matching
   * node, computed by the scheduler, and is changed by editing the node
   * selector rather than by a number. Jobs are excluded because `parallelism`
   * is immutable on a job that has already started.
   */
  scalable?: boolean;
}

const AGE: Column = { key: 'age', label: 'Age', numeric: true };
const NAME: Column = { key: 'name', label: 'Name' };
const NAMESPACE: Column = { key: 'namespace', label: 'Namespace' };

const DECLARED_KINDS: ResourceKind[] = [
  {
    id: 'nodes',
    label: 'Nodes',
    singular: 'Node',
    namespaced: false,
    icon: 'server',
    group: 'cluster',
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'status', label: 'Status' },
      { key: 'roles', label: 'Roles', secondary: true },
      { key: 'version', label: 'Version', secondary: true },
      { key: 'internalIP', label: 'Internal IP', secondary: true },
      AGE
    ]
  },
  {
    id: 'pods',
    label: 'Pods',
    singular: 'Pod',
    namespaced: true,
    icon: 'box',
    group: 'workloads',
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'namespace', label: 'Namespace' },
      { key: 'status', label: 'Status' },
      { key: 'ready', label: 'Ready', numeric: true },
      { key: 'restarts', label: 'Restarts', numeric: true },
      { key: 'node', label: 'Node', secondary: true },
      AGE
    ]
  },
  {
    id: 'services',
    label: 'Services',
    singular: 'Service',
    namespaced: true,
    icon: 'plug',
    group: 'network',
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'namespace', label: 'Namespace' },
      { key: 'type', label: 'Type' },
      { key: 'clusterIP', label: 'Cluster IP', secondary: true },
      { key: 'externalIP', label: 'External', secondary: true },
      { key: 'ports', label: 'Ports', secondary: true },
      AGE
    ]
  },
  {
    id: 'ingresses',
    label: 'Ingresses',
    singular: 'Ingress',
    namespaced: true,
    icon: 'globe',
    group: 'network',
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'namespace', label: 'Namespace' },
      { key: 'hosts', label: 'Hosts' },
      { key: 'class', label: 'Class', secondary: true },
      { key: 'address', label: 'Address', secondary: true },
      AGE
    ]
  },
  {
    id: 'events',
    label: 'Events',
    singular: 'Event',
    namespaced: true,
    icon: 'bell',
    group: 'cluster',
    /**
     * A log rather than an inventory, so the columns lead with what happened
     * and to what, and the event's own generated name — which nothing useful
     * can be read out of — is dropped from the table entirely.
     */
    columns: [
      { key: 'lastSeen', label: 'Last seen', numeric: true },
      { key: 'namespace', label: 'Namespace' },
      { key: 'status', label: 'Type' },
      { key: 'reason', label: 'Reason' },
      { key: 'object', label: 'Object' },
      { key: 'message', label: 'Message' },
      { key: 'count', label: 'Count', numeric: true, secondary: true }
    ]
    // No declared sort: the default — the age column ascending, newest first —
    // is already what a log wants, and `lastSeen` is this kind's age column.
  },
  {
    id: 'namespaces',
    label: 'Namespaces',
    singular: 'Namespace',
    namespaced: false,
    icon: 'folder',
    group: 'cluster',
    columns: [NAME, { key: 'status', label: 'Status' }, AGE]
  },
  {
    id: 'deployments',
    label: 'Deployments',
    singular: 'Deployment',
    namespaced: true,
    icon: 'rocket',
    group: 'workloads',
    scalable: true,
    columns: [
      NAME,
      NAMESPACE,
      { key: 'status', label: 'Status' },
      { key: 'ready', label: 'Ready', numeric: true },
      { key: 'upToDate', label: 'Up-to-date', numeric: true, secondary: true },
      { key: 'available', label: 'Available', numeric: true, secondary: true },
      AGE
    ]
  },
  {
    id: 'statefulsets',
    label: 'StatefulSets',
    singular: 'StatefulSet',
    namespaced: true,
    icon: 'database',
    group: 'workloads',
    scalable: true,
    columns: [
      NAME,
      NAMESPACE,
      { key: 'status', label: 'Status' },
      { key: 'ready', label: 'Ready', numeric: true },
      { key: 'service', label: 'Service', secondary: true },
      AGE
    ]
  },
  {
    id: 'daemonsets',
    label: 'DaemonSets',
    singular: 'DaemonSet',
    namespaced: true,
    icon: 'layers',
    group: 'workloads',
    columns: [
      NAME,
      NAMESPACE,
      { key: 'status', label: 'Status' },
      { key: 'ready', label: 'Ready', numeric: true },
      { key: 'upToDate', label: 'Up-to-date', numeric: true, secondary: true },
      { key: 'nodeSelector', label: 'Node selector', secondary: true },
      AGE
    ]
  },
  {
    id: 'replicasets',
    label: 'ReplicaSets',
    singular: 'ReplicaSet',
    namespaced: true,
    icon: 'copy',
    group: 'workloads',
    scalable: true,
    columns: [
      NAME,
      NAMESPACE,
      { key: 'status', label: 'Status' },
      { key: 'ready', label: 'Ready', numeric: true },
      { key: 'desired', label: 'Desired', numeric: true, secondary: true },
      { key: 'owner', label: 'Owner', secondary: true },
      AGE
    ]
  },
  {
    id: 'jobs',
    label: 'Jobs',
    singular: 'Job',
    namespaced: true,
    icon: 'play',
    group: 'workloads',
    columns: [
      NAME,
      NAMESPACE,
      { key: 'status', label: 'Status' },
      { key: 'completions', label: 'Completions', numeric: true },
      { key: 'duration', label: 'Duration', numeric: true, secondary: true },
      AGE
    ]
  },
  {
    id: 'cronjobs',
    label: 'CronJobs',
    singular: 'CronJob',
    namespaced: true,
    icon: 'clock',
    group: 'workloads',
    columns: [
      NAME,
      NAMESPACE,
      { key: 'status', label: 'Status' },
      { key: 'schedule', label: 'Schedule' },
      { key: 'active', label: 'Active', numeric: true, secondary: true },
      { key: 'lastSchedule', label: 'Last run', numeric: true, secondary: true },
      AGE
    ]
  },
  {
    id: 'endpoints',
    label: 'Endpoints',
    singular: 'Endpoints',
    namespaced: true,
    icon: 'link',
    group: 'network',
    columns: [
      NAME,
      NAMESPACE,
      { key: 'status', label: 'Status' },
      { key: 'endpoints', label: 'Endpoints' },
      AGE
    ]
  },
  {
    id: 'networkpolicies',
    label: 'Network policies',
    singular: 'NetworkPolicy',
    namespaced: true,
    icon: 'shield',
    group: 'network',
    columns: [
      NAME,
      NAMESPACE,
      { key: 'podSelector', label: 'Pod selector' },
      { key: 'types', label: 'Types', secondary: true },
      AGE
    ]
  },
  {
    id: 'configmaps',
    label: 'ConfigMaps',
    singular: 'ConfigMap',
    namespaced: true,
    icon: 'file',
    group: 'config',
    columns: [
      NAME,
      NAMESPACE,
      { key: 'keys', label: 'Keys' },
      { key: 'data', label: 'Data', numeric: true, secondary: true },
      AGE
    ]
  },
  {
    id: 'secrets',
    label: 'Secrets',
    singular: 'Secret',
    namespaced: true,
    icon: 'lock',
    group: 'config',
    columns: [
      NAME,
      NAMESPACE,
      { key: 'type', label: 'Type' },
      { key: 'keys', label: 'Keys' },
      { key: 'data', label: 'Data', numeric: true, secondary: true },
      AGE
    ]
  },
  {
    id: 'serviceaccounts',
    label: 'Service accounts',
    singular: 'ServiceAccount',
    namespaced: true,
    icon: 'account',
    group: 'config',
    columns: [
      NAME,
      NAMESPACE,
      { key: 'secrets', label: 'Secrets', numeric: true, secondary: true },
      AGE
    ]
  },
  {
    id: 'resourcequotas',
    label: 'Resource quotas',
    singular: 'ResourceQuota',
    namespaced: true,
    icon: 'gauge',
    group: 'config',
    columns: [
      NAME,
      NAMESPACE,
      { key: 'status', label: 'Status' },
      { key: 'usage', label: 'Usage' },
      AGE
    ]
  },
  {
    id: 'limitranges',
    label: 'Limit ranges',
    singular: 'LimitRange',
    namespaced: true,
    icon: 'ruler',
    group: 'config',
    columns: [
      NAME,
      NAMESPACE,
      { key: 'limits', label: 'Limits' },
      AGE
    ]
  },
  {
    id: 'horizontalpodautoscalers',
    label: 'Autoscalers',
    singular: 'HorizontalPodAutoscaler',
    namespaced: true,
    icon: 'chart',
    group: 'workloads',
    columns: [
      NAME,
      NAMESPACE,
      { key: 'status', label: 'Status' },
      { key: 'target', label: 'Target' },
      { key: 'replicas', label: 'Replicas', numeric: true },
      { key: 'range', label: 'Min/Max', numeric: true, secondary: true },
      AGE
    ]
  },
  {
    id: 'persistentvolumeclaims',
    label: 'Volume claims',
    singular: 'PersistentVolumeClaim',
    namespaced: true,
    icon: 'disk',
    group: 'storage',
    columns: [
      NAME,
      NAMESPACE,
      { key: 'status', label: 'Status' },
      { key: 'capacity', label: 'Capacity', numeric: true },
      { key: 'accessModes', label: 'Access', secondary: true },
      { key: 'storageClass', label: 'Class', secondary: true },
      { key: 'volume', label: 'Volume', secondary: true },
      AGE
    ]
  },
  {
    id: 'persistentvolumes',
    label: 'Volumes',
    singular: 'PersistentVolume',
    namespaced: false,
    icon: 'disk',
    group: 'storage',
    columns: [
      NAME,
      { key: 'status', label: 'Status' },
      { key: 'capacity', label: 'Capacity', numeric: true },
      { key: 'accessModes', label: 'Access', secondary: true },
      { key: 'reclaim', label: 'Reclaim', secondary: true },
      { key: 'claim', label: 'Claim', secondary: true },
      { key: 'storageClass', label: 'Class', secondary: true },
      AGE
    ]
  },
  {
    id: 'storageclasses',
    label: 'Storage classes',
    singular: 'StorageClass',
    namespaced: false,
    icon: 'stack',
    group: 'storage',
    columns: [
      NAME,
      { key: 'provisioner', label: 'Provisioner' },
      { key: 'reclaim', label: 'Reclaim', secondary: true },
      { key: 'binding', label: 'Binding', secondary: true },
      { key: 'expansion', label: 'Expandable', secondary: true },
      AGE
    ]
  }
];

/**
 * The namespace is the first thing you read a namespaced row by, so it leads
 * the table wherever a kind declares it. The kind definitions keep their own
 * natural order — this is applied once here rather than being spelled out
 * twenty times above.
 */
export const KINDS: ResourceKind[] = DECLARED_KINDS.map((kind) => {
  const index = kind.columns.findIndex((column) => column.key === 'namespace');
  if (index <= 0) return kind;
  const columns = [...kind.columns];
  const [namespace] = columns.splice(index, 1);
  return { ...kind, columns: [namespace, ...columns] };
});

export function kindById(id: string): ResourceKind | undefined {
  return KINDS.find((kind) => kind.id === id);
}

export function toRow(kindId: string, object: k.KubeObject): Row {
  const base = { name: object.metadata.name, namespace: object.metadata.namespace };
  const built = build(kindId, object);
  const owner = ownerOf(object);
  const cells: Record<string, string> = {
    name: base.name,
    namespace: base.namespace ?? '',
    age: age(object.metadata.creationTimestamp),
    ...built.cells
  };
  return {
    ...base,
    // `created` is what the webview recomputes the live age cell from. For an
    // event that has to be when the event fired, not when its record was made.
    created: built.created ?? object.metadata.creationTimestamp,
    health: built.health,
    status: built.status,
    cells,
    search: Object.values(cells).join(' ').toLowerCase(),
    ...(built.containers ? { containers: built.containers } : {}),
    ...(built.replicas !== undefined ? { replicas: built.replicas } : {}),
    ...(owner ? { owner } : {}),
    ...(object.metadata.uid ? { uid: object.metadata.uid } : {})
  };
}

/**
 * The controlling owner of an object. Kubernetes allows several
 * ownerReferences but only one controller, and that is the one a "which
 * workload does this belong to" question means; where none is flagged — some
 * controllers omit `controller: true` — the first reference stands in.
 */
function ownerOf(object: k.KubeObject): Owner | undefined {
  const refs = object.metadata.ownerReferences ?? [];
  const ref = refs.find((r) => r.controller) ?? refs[0];
  return ref?.kind && ref.name ? { kind: ref.kind, name: ref.name } : undefined;
}

interface Built {
  health: Health;
  status: string;
  cells: Record<string, string>;
  /** Overrides the timestamp the age cell is recomputed from. */
  created?: string;
  containers?: ContainerInfo[];
  replicas?: number;
}

function build(kindId: string, object: k.KubeObject): Built {
  switch (kindId) {
    case 'pods':
      return buildPod(object);
    case 'nodes':
      return buildNode(object);
    case 'services':
      return buildService(object);
    case 'ingresses':
      return buildIngress(object);
    case 'events':
      return buildEvent(object);
    case 'namespaces':
      return buildNamespace(object);
    case 'deployments':
      return buildDeployment(object);
    case 'statefulsets':
      return buildStatefulSet(object);
    case 'daemonsets':
      return buildDaemonSet(object);
    case 'replicasets':
      return buildReplicaSet(object);
    case 'jobs':
      return buildJob(object);
    case 'cronjobs':
      return buildCronJob(object);
    case 'endpoints':
      return buildEndpoints(object);
    case 'networkpolicies':
      return buildNetworkPolicy(object);
    case 'configmaps':
      return buildConfigMap(object);
    case 'secrets':
      return buildSecret(object);
    case 'serviceaccounts':
      return buildServiceAccount(object);
    case 'resourcequotas':
      return buildResourceQuota(object);
    case 'limitranges':
      return buildLimitRange(object);
    case 'horizontalpodautoscalers':
      return buildHpa(object);
    case 'persistentvolumeclaims':
      return buildPvc(object);
    case 'persistentvolumes':
      return buildPv(object);
    case 'storageclasses':
      return buildStorageClass(object);
    default:
      return { health: 'muted', status: '', cells: {} };
  }
}

function buildPod(pod: k.KubeObject): Built {
  const statuses: any[] = pod.status?.containerStatuses ?? [];
  const ready = statuses.filter((c) => c.ready).length;
  const restarts = statuses.reduce((sum, c) => sum + (c.restartCount ?? 0), 0);
  // Container-level reasons are far more actionable than the coarse pod phase.
  const reason =
    statuses.map((c) => c.state?.waiting?.reason ?? c.state?.terminated?.reason).find(Boolean) ??
    pod.status?.reason ??
    pod.status?.phase ??
    'Unknown';

  const allReady = statuses.length > 0 && ready === statuses.length;
  let health: Health = 'bad';
  if (reason === 'Completed') {
    health = 'muted';
  } else if (reason === 'Running' && allReady) {
    health = 'ok';
  } else if (reason === 'Running' || reason === 'ContainerCreating' || reason === 'PodInitializing' || reason === 'Pending') {
    health = 'warn';
  }

  return {
    health,
    status: reason,
    containers: buildContainers(pod),
    cells: {
      status: reason,
      ready: `${ready}/${statuses.length}`,
      restarts: String(restarts),
      node: pod.spec?.nodeName ?? ''
    }
  };
}

/**
 * Flattens a pod's three container lists into one. Spec order is kept — init
 * containers run before the app ones, and that is the order someone debugging a
 * stuck pod reads them in — and each spec entry is paired with its status by
 * name, since a pod that has not started yet has specs with no status at all.
 */
function buildContainers(pod: k.KubeObject): ContainerInfo[] {
  const spec = pod.spec ?? {};
  const status = pod.status ?? {};
  const groups: Array<[ContainerInfo['kind'], any[], any[]]> = [
    ['init', spec.initContainers ?? [], status.initContainerStatuses ?? []],
    ['app', spec.containers ?? [], status.containerStatuses ?? []],
    ['ephemeral', spec.ephemeralContainers ?? [], status.ephemeralContainerStatuses ?? []]
  ];
  return groups.flatMap(([kind, specs, statuses]) =>
    specs.map((container: any) =>
      buildContainer(kind, container, statuses.find((s: any) => s.name === container.name))
    )
  );
}

/** Waiting reasons that mean "still working on it" rather than "this is broken". */
const PROGRESSING = new Set(['ContainerCreating', 'PodInitializing', 'Pending']);

function buildContainer(kind: ContainerInfo['kind'], spec: any, status: any): ContainerInfo {
  const state = status?.state ?? {};
  let phase = 'Waiting';
  let reason = '';
  let message = '';
  let startedAt: string | undefined;

  if (state.running) {
    phase = 'Running';
    startedAt = state.running.startedAt;
  } else if (state.terminated) {
    const term = state.terminated;
    const exit = Number(term.exitCode ?? 0);
    // An init container that exited 0 did its job; calling that "Terminated"
    // next to a red pill would send someone hunting for a problem there isn't.
    phase = exit === 0 ? 'Completed' : 'Terminated';
    reason = exit === 0 ? (term.reason ?? 'Completed') : `${term.reason ?? 'Error'} (${exit})`;
    message = term.message ?? '';
  } else if (state.waiting) {
    reason = state.waiting.reason ?? '';
    message = state.waiting.message ?? '';
  }

  // The previous instance's exit is the only thing on the pod object that says
  // *why* a container is restarting, so it is worth carrying even though the
  // current state looks fine between crashes.
  const last = status?.lastState?.terminated;
  const lastExit = last ? Number(last.exitCode ?? 0) : 0;

  return {
    name: spec.name ?? status?.name ?? '',
    image: status?.image || spec.image || '',
    kind,
    ready: Boolean(status?.ready),
    health: containerHealth(phase, reason, Boolean(status?.ready)),
    state: phase,
    reason,
    message: String(message).replace(/\s+/g, ' ').trim(),
    restarts: Number(status?.restartCount ?? 0),
    startedAt,
    lastReason: last ? `${last.reason ?? 'Error'} (${lastExit})` : undefined,
    lastFinishedAt: last?.finishedAt,
    probes: [
      spec.livenessProbe ? 'liveness' : '',
      spec.readinessProbe ? 'readiness' : '',
      spec.startupProbe ? 'startup' : ''
    ].filter(Boolean),
    ports: (spec.ports ?? [])
      .map((p: any) => `${p.name ? `${p.name}:` : ''}${p.containerPort}/${p.protocol ?? 'TCP'}`)
      .join(', '),
    cpu: resource(spec.resources, 'cpu'),
    memory: resource(spec.resources, 'memory')
  };
}

function containerHealth(phase: string, reason: string, ready: boolean): Health {
  if (phase === 'Completed') {
    return 'muted';
  }
  if (phase === 'Terminated') {
    return 'bad';
  }
  if (phase === 'Running') {
    // Running but failing its readiness probe is the classic half-broken pod,
    // and the pod-level Ready column is the only other place it shows.
    return ready ? 'ok' : 'warn';
  }
  // Waiting: an image that won't pull or a container that won't start is a
  // failure; a container still being created is not, and neither is a pod so
  // young the kubelet has not reported a reason yet.
  return !reason || PROGRESSING.has(reason) ? 'warn' : 'bad';
}

/** "100m / 500m" for a request and limit pair; empty when neither is set. */
function resource(resources: any, key: string): string {
  const request = resources?.requests?.[key];
  const limit = resources?.limits?.[key];
  if (!request && !limit) {
    return '';
  }
  return `${request ?? '\u2014'} / ${limit ?? '\u2014'}`;
}

function buildNode(node: k.KubeObject): Built {
  const conditions: any[] = node.status?.conditions ?? [];
  const isReady = conditions.find((c) => c.type === 'Ready')?.status === 'True';
  const unschedulable = Boolean(node.spec?.unschedulable);
  const status = isReady ? (unschedulable ? 'Ready,SchedulingDisabled' : 'Ready') : 'NotReady';

  const roles = Object.keys(node.metadata.labels ?? {})
    .filter((l) => l.startsWith('node-role.kubernetes.io/'))
    .map((l) => l.replace('node-role.kubernetes.io/', ''))
    .filter(Boolean);
  const addresses: any[] = node.status?.addresses ?? [];

  return {
    health: isReady ? (unschedulable ? 'warn' : 'ok') : 'bad',
    status,
    cells: {
      status,
      roles: roles.join(',') || '<none>',
      version: node.status?.nodeInfo?.kubeletVersion ?? '',
      internalIP: addresses.find((a) => a.type === 'InternalIP')?.address ?? ''
    }
  };
}

function buildService(service: k.KubeObject): Built {
  const type = service.spec?.type ?? 'ClusterIP';
  const ports: any[] = service.spec?.ports ?? [];
  const ingress: any[] = service.status?.loadBalancer?.ingress ?? [];
  const external = ingress.map((i) => i.ip ?? i.hostname).filter(Boolean).join(', ');
  const pendingLb = type === 'LoadBalancer' && ingress.length === 0;

  return {
    health: pendingLb ? 'warn' : 'ok',
    status: pendingLb ? 'Pending' : type,
    cells: {
      type,
      clusterIP: service.spec?.clusterIP ?? '',
      externalIP: type === 'LoadBalancer' ? external || '<pending>' : external || '<none>',
      ports: ports.map((p) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ''}/${p.protocol ?? 'TCP'}`).join(', ')
    }
  };
}

function buildIngress(ingress: k.KubeObject): Built {
  const rules: any[] = ingress.spec?.rules ?? [];
  const hosts = rules.map((r) => r.host).filter(Boolean);
  const lb: any[] = ingress.status?.loadBalancer?.ingress ?? [];
  const address = lb.map((i) => i.ip ?? i.hostname).filter(Boolean).join(', ');

  return {
    health: address ? 'ok' : 'warn',
    status: address ? 'Active' : 'Pending',
    cells: {
      hosts: hosts.join(', ') || '*',
      class: ingress.spec?.ingressClassName ?? '<none>',
      address
    }
  };
}

/**
 * An event's "when". The legacy core/v1 shape and events.k8s.io disagree, and a
 * cluster can serve either through `kubectl get events`, so each candidate is
 * tried in turn; a one-shot event has no `lastTimestamp` at all and falls back
 * to when it was first seen.
 */
function eventTime(event: k.KubeObject): string | undefined {
  return (
    event.status?.lastTimestamp ??
    (event as any).lastTimestamp ??
    (event as any).series?.lastObservedTime ??
    (event as any).deprecatedLastTimestamp ??
    (event as any).eventTime ??
    (event as any).firstTimestamp ??
    event.metadata.creationTimestamp
  );
}

/**
 * Event reasons that read louder than their type.
 *
 * Kubernetes grades an event Normal or Warning, and that grade answers "did
 * the cluster fail at something", not "did something happen to my workload".
 * The two come apart most sharply at `Killing`: the kubelet tearing a
 * container down is filed Normal because it is the cluster doing exactly what
 * it was told, but it is the line that explains a restart count going up, and
 * it is what someone scanning the list is looking for. Preemption, eviction
 * and a node dropping out are the same shape — deliberate, healthy, and the
 * reason your container is no longer running.
 *
 * These are graded `bad` whatever their type. Nothing is graded down: a
 * Warning the API server raised keeps at least `warn`, because deciding some
 * warnings are noise is how the one that mattered ends up grey.
 */
const DISRUPTIVE_EVENTS =
  /^(Killing|Preempting|Preempted|Evicted|NodeNotReady|TaintManagerEviction)$/;

function eventHealth(type: string, reason: string): Health {
  if (DISRUPTIVE_EVENTS.test(reason)) return 'bad';
  // Warning is the whole reason to open this table, so it gets the loud
  // colour; a Normal event is routine bookkeeping and stays grey rather than
  // green, which would read as "something succeeded".
  return type === 'Warning' ? 'warn' : 'muted';
}

function buildEvent(event: k.KubeObject): Built {
  const type = (event as any).type ?? 'Normal';
  const reason = (event as any).reason ?? '';
  const involved = (event as any).involvedObject ?? (event as any).regarding ?? {};
  // "Pod/web-7d9" reads better than the kind and name in separate columns, and
  // it is what someone scanning for the failing object is looking for.
  const object = [involved.kind, involved.name].filter(Boolean).join('/');
  const count = Number((event as any).count ?? (event as any).series?.count ?? 0);
  const message = ((event as any).message ?? (event as any).note ?? '').replace(/\s+/g, ' ').trim();
  const when = eventTime(event);

  return {
    created: when,
    health: eventHealth(type, reason),
    status: type,
    cells: {
      lastSeen: age(when),
      // The table's Type column reads this; the webview would otherwise fall
      // back to the row's own status, which happens to match but leaves the
      // declared column with no cell behind it.
      status: type,
      reason,
      object,
      message,
      // A one-off event reports no count; "1" is truer than an empty cell.
      count: String(count || 1)
    }
  };
}

/**
 * A replica count read as health. Every controller kind reports "how many did
 * you ask for" against "how many are actually serving", and that difference is
 * the only thing worth colouring: none of the wanted replicas up is a failure,
 * some of them is a rollout or a problem in progress, all of them is fine.
 *
 * `desired` of zero is deliberately muted rather than green — a scaled-to-zero
 * Deployment is neither healthy nor broken, and painting it green next to a
 * real one hides which workloads are actually running.
 */
function replicaHealth(ready: number, desired: number): { health: Health; status: string } {
  if (desired === 0) {
    return { health: 'muted', status: 'Scaled to zero' };
  }
  if (ready === 0) {
    return { health: 'bad', status: 'Unavailable' };
  }
  if (ready < desired) {
    return { health: 'warn', status: 'Progressing' };
  }
  return { health: 'ok', status: 'Ready' };
}

function buildNamespace(namespace: k.KubeObject): Built {
  // A namespace stuck Terminating — almost always a finalizer that will not
  // clear — is the one state anybody opens this table to find.
  const phase = namespace.status?.phase ?? 'Unknown';
  return {
    health: phase === 'Active' ? 'ok' : phase === 'Terminating' ? 'warn' : 'muted',
    status: phase,
    cells: { status: phase }
  };
}

function buildDeployment(deployment: k.KubeObject): Built {
  const status = deployment.status ?? {};
  const desired = Number(deployment.spec?.replicas ?? 0);
  const ready = Number(status.readyReplicas ?? 0);
  const verdict = replicaHealth(ready, desired);

  // A deployment reports why it is stuck in its conditions, and
  // ProgressDeadlineExceeded is the difference between "rolling out" and "this
  // rollout is never going to finish".
  const conditions: any[] = status.conditions ?? [];
  const progressing = conditions.find((c) => c.type === 'Progressing');
  const stalled = progressing?.status === 'False' || progressing?.reason === 'ProgressDeadlineExceeded';

  return {
    health: stalled && desired > 0 ? 'bad' : verdict.health,
    status: stalled && desired > 0 ? (progressing?.reason ?? 'Stalled') : verdict.status,
    replicas: desired,
    cells: {
      status: stalled && desired > 0 ? (progressing?.reason ?? 'Stalled') : verdict.status,
      ready: `${ready}/${desired}`,
      upToDate: String(status.updatedReplicas ?? 0),
      available: String(status.availableReplicas ?? 0)
    }
  };
}

function buildStatefulSet(set: k.KubeObject): Built {
  const desired = Number(set.spec?.replicas ?? 0);
  const ready = Number(set.status?.readyReplicas ?? 0);
  const verdict = replicaHealth(ready, desired);
  return {
    health: verdict.health,
    status: verdict.status,
    replicas: desired,
    cells: {
      status: verdict.status,
      ready: `${ready}/${desired}`,
      service: set.spec?.serviceName ?? ''
    }
  };
}

function buildDaemonSet(set: k.KubeObject): Built {
  const status = set.status ?? {};
  // A DaemonSet's "desired" is how many nodes it should be on, which the
  // scheduler computes; it is not a number anyone wrote in the spec.
  const desired = Number(status.desiredNumberScheduled ?? 0);
  const ready = Number(status.numberReady ?? 0);
  const verdict = replicaHealth(ready, desired);
  const selector = set.spec?.template?.spec?.nodeSelector ?? {};
  return {
    health: verdict.health,
    status: verdict.status,
    cells: {
      status: verdict.status,
      ready: `${ready}/${desired}`,
      upToDate: String(status.updatedNumberScheduled ?? 0),
      nodeSelector: Object.entries(selector).map(([key, value]) => `${key}=${value}`).join(', ') || '<none>'
    }
  };
}

function buildReplicaSet(set: k.KubeObject): Built {
  const desired = Number(set.spec?.replicas ?? 0);
  const ready = Number(set.status?.readyReplicas ?? 0);
  const verdict = replicaHealth(ready, desired);
  // Most ReplicaSets are the superseded revisions a Deployment leaves behind,
  // so the owner is what tells you which Deployment a row belongs to.
  const owner = ownerOf(set);
  return {
    health: verdict.health,
    status: verdict.status,
    replicas: desired,
    cells: {
      status: verdict.status,
      ready: `${ready}/${desired}`,
      desired: String(desired),
      owner: owner ? `${owner.kind}/${owner.name}` : ''
    }
  };
}

function buildJob(job: k.KubeObject): Built {
  const status = job.status ?? {};
  const succeeded = Number(status.succeeded ?? 0);
  const failed = Number(status.failed ?? 0);
  const active = Number(status.active ?? 0);
  // `completions` unset means a single-run job, which needs one success.
  const wanted = Number(job.spec?.completions ?? 1);

  let health: Health = 'warn';
  let word = 'Running';
  if (failed > 0 && succeeded < wanted) {
    health = 'bad';
    word = 'Failed';
  } else if (succeeded >= wanted) {
    // A finished job is done, not healthy — it is not serving anything, and
    // green would put it on the same footing as a running workload.
    health = 'muted';
    word = 'Complete';
  } else if (active === 0) {
    health = 'warn';
    word = 'Pending';
  }

  return {
    health,
    status: word,
    cells: {
      status: word,
      completions: `${succeeded}/${wanted}`,
      duration: jobDuration(status)
    }
  };
}

/**
 * How long a job ran, or has been running; empty before it starts.
 *
 * `completionTime` is only set on a job that succeeded, so a failed one has to
 * take its end from the transition time of whichever terminal condition fired.
 * Without that a job that gave up days ago reports a duration that is still
 * counting, which reads as one that is somehow still going.
 */
function jobDuration(status: any): string {
  const start = status.startTime ? new Date(status.startTime).getTime() : NaN;
  if (Number.isNaN(start)) {
    return '';
  }
  const finished: any[] = (status.conditions ?? []).filter(
    (c: any) => (c.type === 'Complete' || c.type === 'Failed') && c.status === 'True'
  );
  const ended = status.completionTime ?? finished.map((c) => c.lastTransitionTime).find(Boolean);
  const end = ended ? new Date(ended).getTime() : Date.now();
  return humanDuration(Math.max(0, Math.floor((end - start) / 1000)));
}

function buildCronJob(job: k.KubeObject): Built {
  const suspended = Boolean(job.spec?.suspend);
  const active = (job.status?.active ?? []).length;
  return {
    // Suspended is a deliberate state rather than a fault, but it is the reason
    // a schedule someone expects to be firing is not, so it does not read green.
    health: suspended ? 'muted' : 'ok',
    status: suspended ? 'Suspended' : active > 0 ? 'Running' : 'Scheduled',
    cells: {
      status: suspended ? 'Suspended' : active > 0 ? 'Running' : 'Scheduled',
      schedule: job.spec?.schedule ?? '',
      active: String(active),
      lastSchedule: age(job.status?.lastScheduleTime)
    }
  };
}

function buildEndpoints(endpoints: k.KubeObject): Built {
  const subsets: any[] = (endpoints as any).subsets ?? [];
  const addresses = subsets.flatMap((s) => s.addresses ?? []);
  const notReady = subsets.flatMap((s) => s.notReadyAddresses ?? []);
  // The ip:port pairs, flattened the way kubectl prints them, capped so one
  // large Service cannot push the rest of the table off the screen.
  const pairs = subsets.flatMap((s) =>
    (s.addresses ?? []).flatMap((a: any) => (s.ports ?? []).map((p: any) => `${a.ip}:${p.port}`))
  );
  const shown = pairs.slice(0, 6).join(', ');
  const rest = pairs.length - 6;

  return {
    // No backing addresses is the classic "the Service exists but resolves to
    // nothing" — the selector matches no ready pod.
    health: addresses.length === 0 ? 'warn' : notReady.length > 0 ? 'warn' : 'ok',
    status: addresses.length === 0 ? 'No endpoints' : `${addresses.length} ready`,
    cells: {
      status: addresses.length === 0 ? 'No endpoints' : `${addresses.length} ready`,
      endpoints: pairs.length === 0 ? '<none>' : rest > 0 ? `${shown} +${rest} more` : shown
    }
  };
}

function buildNetworkPolicy(policy: k.KubeObject): Built {
  const selector = policy.spec?.podSelector?.matchLabels ?? {};
  const pairs = Object.entries(selector).map(([key, value]) => `${key}=${value}`);
  // An empty podSelector is not "nothing"; it selects every pod in the
  // namespace, which is the opposite reading and worth spelling out.
  const types: string[] = policy.spec?.policyTypes ?? [];
  return {
    health: 'ok',
    status: types.join(', ') || 'Ingress',
    cells: {
      podSelector: pairs.length ? pairs.join(', ') : '<all pods>',
      types: types.join(', ') || 'Ingress'
    }
  };
}

/** The keys of a data map, capped; the count is carried in its own column. */
function dataKeys(object: k.KubeObject): { keys: string; count: number } {
  const names = [
    ...Object.keys((object as any).data ?? {}),
    ...Object.keys((object as any).binaryData ?? {}),
    ...Object.keys((object as any).stringData ?? {})
  ];
  const shown = names.slice(0, 5).join(', ');
  const rest = names.length - 5;
  return { keys: rest > 0 ? `${shown} +${rest} more` : shown, count: names.length };
}

function buildConfigMap(map: k.KubeObject): Built {
  const { keys, count } = dataKeys(map);
  return {
    // An empty ConfigMap is usually a mistake, but not a cluster fault; muted
    // says "nothing here" without claiming something is broken.
    health: count === 0 ? 'muted' : 'ok',
    status: `${count} key${count === 1 ? '' : 's'}`,
    cells: { keys: keys || '<empty>', data: String(count) }
  };
}

function buildSecret(secret: k.KubeObject): Built {
  // Only the key names are ever read here; values stay in the cluster. The
  // table is something people screen-share, and a decoded value has no place
  // in it — the YAML actions are the deliberate way to see one.
  const { keys, count } = dataKeys(secret);
  const type = (secret as any).type ?? 'Opaque';
  return {
    health: count === 0 ? 'muted' : 'ok',
    status: type,
    cells: { type, keys: keys || '<empty>', data: String(count) }
  };
}

function buildServiceAccount(account: k.KubeObject): Built {
  const secrets = ((account as any).secrets ?? []).length;
  return {
    health: 'ok',
    status: 'Active',
    cells: { secrets: String(secrets) }
  };
}

function buildResourceQuota(quota: k.KubeObject): Built {
  const hard: Record<string, string> = quota.status?.hard ?? quota.spec?.hard ?? {};
  const used: Record<string, string> = quota.status?.used ?? {};
  const entries = Object.keys(hard).slice(0, 4).map((key) => `${key}: ${used[key] ?? '0'}/${hard[key]}`);
  const rest = Object.keys(hard).length - 4;

  // A quota that is exhausted is the reason pods stop being admitted, and
  // nothing else in the dashboard says so. Compared numerically where both
  // sides parse; quantities like "2Gi" fall back to a string match.
  const exhausted = Object.keys(hard).some((key) => atCapacity(used[key], hard[key]));

  return {
    health: exhausted ? 'warn' : 'ok',
    status: exhausted ? 'At limit' : 'Within limits',
    cells: {
      status: exhausted ? 'At limit' : 'Within limits',
      usage: entries.join(' · ') + (rest > 0 ? ` +${rest} more` : '')
    }
  };
}

/**
 * Whether a used value has reached its hard limit. Kubernetes quantities carry
 * suffixes ("2Gi", "500m") that Number() cannot read, so a pair that does not
 * parse as plain numbers is compared as text — equal strings mean the limit is
 * met, which is the case worth flagging.
 */
function atCapacity(used: string | undefined, hard: string | undefined): boolean {
  if (used === undefined || hard === undefined) {
    return false;
  }
  const u = Number(used);
  const h = Number(hard);
  if (Number.isFinite(u) && Number.isFinite(h)) {
    return h > 0 && u >= h;
  }
  return used === hard;
}

function buildLimitRange(range: k.KubeObject): Built {
  const limits: any[] = range.spec?.limits ?? [];
  const summary = limits
    .map((l) => {
      const parts = [
        l.default ? `default ${pairs(l.default)}` : '',
        l.defaultRequest ? `request ${pairs(l.defaultRequest)}` : '',
        l.max ? `max ${pairs(l.max)}` : '',
        l.min ? `min ${pairs(l.min)}` : ''
      ].filter(Boolean);
      return `${l.type}: ${parts.join(', ')}`;
    })
    .join(' · ');
  return {
    health: 'ok',
    status: limits.map((l) => l.type).join(', ') || 'LimitRange',
    cells: { limits: summary || '<none>' }
  };
}

/** "cpu=100m, memory=128Mi" for a resource map. */
function pairs(map: Record<string, string>): string {
  return Object.entries(map).map(([key, value]) => `${key}=${value}`).join('/');
}

function buildHpa(hpa: k.KubeObject): Built {
  const status = hpa.status ?? {};
  const spec = hpa.spec ?? {};
  const current = Number(status.currentReplicas ?? 0);
  const desired = Number(status.desiredReplicas ?? 0);
  const min = Number(spec.minReplicas ?? 1);
  const max = Number(spec.maxReplicas ?? 0);

  // An HPA that cannot read its metrics is silently not scaling anything,
  // which looks identical to a healthy one from the replica counts alone.
  const conditions: any[] = status.conditions ?? [];
  const scalingActive = conditions.find((c) => c.type === 'ScalingActive');
  const blind = scalingActive?.status === 'False';
  const atCeiling = max > 0 && current >= max && desired >= max;

  return {
    health: blind ? 'bad' : atCeiling ? 'warn' : 'ok',
    status: blind ? (scalingActive?.reason ?? 'No metrics') : atCeiling ? 'At max' : 'Scaling',
    cells: {
      status: blind ? (scalingActive?.reason ?? 'No metrics') : atCeiling ? 'At max' : 'Scaling',
      target: hpaTarget(hpa),
      replicas: String(current),
      range: `${min}/${max}`
    }
  };
}

/**
 * What the autoscaler is tracking, as "current/target". autoscaling/v2 reports
 * a list of metrics; v1 reports a single CPU percentage in its own fields, and
 * a cluster can serve either through the same `get`.
 */
function hpaTarget(hpa: k.KubeObject): string {
  const metrics: any[] = hpa.spec?.metrics ?? [];
  if (metrics.length) {
    const current: any[] = hpa.status?.currentMetrics ?? [];
    return metrics
      .map((metric, index) => {
        const name = metric.resource?.name ?? metric.pods?.metric?.name ?? metric.type ?? 'metric';
        const want = metric.resource?.target?.averageUtilization;
        const have = current[index]?.resource?.current?.averageUtilization;
        return want !== undefined
          ? `${name} ${have ?? '<unknown>'}%/${want}%`
          : String(name);
      })
      .join(', ');
  }
  const want = hpa.spec?.targetCPUUtilizationPercentage;
  const have = hpa.status?.currentCPUUtilizationPercentage;
  return want !== undefined ? `cpu ${have ?? '<unknown>'}%/${want}%` : '<none>';
}

function buildPvc(claim: k.KubeObject): Built {
  const phase = claim.status?.phase ?? 'Unknown';
  return {
    // Pending is the state that keeps pods from starting — no volume was
    // provisioned — so it is a warning rather than routine progress.
    health: phase === 'Bound' ? 'ok' : phase === 'Lost' ? 'bad' : 'warn',
    status: phase,
    cells: {
      status: phase,
      capacity: claim.status?.capacity?.storage ?? claim.spec?.resources?.requests?.storage ?? '',
      accessModes: (claim.spec?.accessModes ?? []).join(', '),
      // The three cases are distinct and a blank cell would merge them: an
      // absent field takes the cluster's default class, an empty string opts
      // out of dynamic provisioning entirely (the volume is bound by hand),
      // and anything else names a class.
      storageClass: claim.spec?.storageClassName || (claim.spec?.storageClassName === '' ? '<none>' : '<default>'),
      volume: claim.spec?.volumeName ?? ''
    }
  };
}

function buildPv(volume: k.KubeObject): Built {
  const phase = volume.status?.phase ?? 'Unknown';
  const claim = volume.spec?.claimRef;
  return {
    // Released means the claim is gone but the volume — and whatever data is on
    // it — is still there, which is a state someone has to act on.
    health: phase === 'Bound' ? 'ok' : phase === 'Failed' ? 'bad' : phase === 'Available' ? 'muted' : 'warn',
    status: phase,
    cells: {
      status: phase,
      capacity: volume.spec?.capacity?.storage ?? '',
      accessModes: (volume.spec?.accessModes ?? []).join(', '),
      reclaim: volume.spec?.persistentVolumeReclaimPolicy ?? '',
      claim: claim ? `${claim.namespace ?? ''}/${claim.name ?? ''}`.replace(/^\//, '') : '',
      storageClass: volume.spec?.storageClassName ?? '<none>'
    }
  };
}

function buildStorageClass(storageClass: k.KubeObject): Built {
  // The default class is what every PVC without an explicit class lands on, so
  // it is the one fact worth surfacing about a class from the table.
  const annotations = storageClass.metadata.annotations ?? {};
  const isDefault = annotations['storageclass.kubernetes.io/is-default-class'] === 'true';
  return {
    health: 'ok',
    status: isDefault ? 'Default' : 'Available',
    cells: {
      provisioner: (storageClass as any).provisioner ?? '',
      reclaim: (storageClass as any).reclaimPolicy ?? 'Delete',
      binding: (storageClass as any).volumeBindingMode ?? 'Immediate',
      expansion: (storageClass as any).allowVolumeExpansion ? 'yes' : 'no'
    }
  };
}

/** A span in the same shape as an age: 2y271d, 5d, 3h, 12m, 45s. */
function humanDuration(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  if (days >= 365) {
    return `${Math.floor(days / 365)}y${days % 365}d`;
  }
  if (days > 0) {
    return `${days}d`;
  }
  const hours = Math.floor(seconds / 3600);
  if (hours > 0) {
    return `${hours}h`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
}

export interface Skew {
  health: Health;
  /** Headline shown beside the two versions, e.g. "Supported". */
  label: string;
  /** One sentence explaining what the difference means in practice. */
  detail: string;
  /** Minor versions of client minus server; undefined when either is unparseable. */
  delta?: number;
}

/**
 * Parses the minor version out of a version block. `minor` is preferred over
 * splitting `gitVersion` because vendors append to the latter ("v1.35.6-eks-…")
 * and managed providers report minor as "35+", but either can be absent, so
 * gitVersion is the fallback.
 */
function minorOf(version?: k.VersionInfo): { major: number; minor: number } | undefined {
  if (!version) {
    return undefined;
  }
  const major = Number(String(version.major ?? '').replace(/\D/g, ''));
  const minor = Number(String(version.minor ?? '').replace(/\D/g, ''));
  if (Number.isFinite(major) && Number.isFinite(minor) && String(version.minor ?? '').trim()) {
    return { major, minor };
  }
  const parsed = /^v?(\d+)\.(\d+)/.exec(version.gitVersion ?? '');
  return parsed ? { major: Number(parsed[1]), minor: Number(parsed[2]) } : undefined;
}

/**
 * Judges client/server version skew against the documented support policy: the
 * API server supports a kubectl one minor newer and up to two older. Outside
 * that window kubectl is not merely old, it can be wrong — missing subresources
 * and unknown fields are silently dropped — which is what the warning is for.
 */
export function skew(versions: k.Versions): Skew {
  const client = minorOf(versions.client);
  const server = minorOf(versions.server);
  if (!client || !server) {
    return {
      health: 'muted',
      label: 'Unknown',
      detail: versions.serverError
        ? 'The server version could not be read, so compatibility cannot be checked.'
        : 'One of the versions could not be parsed, so compatibility cannot be checked.'
    };
  }
  // A major-version difference is far outside the policy; treat it as such
  // rather than letting the minor arithmetic produce a meaningless delta.
  if (client.major !== server.major) {
    return {
      health: 'bad',
      label: 'Unsupported',
      detail: `kubectl ${client.major}.${client.minor} and the cluster's ${server.major}.${server.minor} are different major versions. Expect commands to fail or behave incorrectly.`
    };
  }
  const delta = client.minor - server.minor;
  if (delta > 1) {
    return {
      health: 'bad',
      label: 'Unsupported',
      delta,
      detail: `kubectl is ${delta} minor versions ahead of the cluster; only 1 ahead is supported. It may send fields and subresources this cluster does not understand.`
    };
  }
  if (delta < -2) {
    return {
      health: 'bad',
      label: 'Unsupported',
      delta,
      detail: `kubectl is ${-delta} minor versions behind the cluster; only 2 behind is supported. It may silently drop fields it does not know about when editing or applying.`
    };
  }
  // Inside the window, but the edges are where upgrading the cluster tips into
  // unsupported, so they are worth flagging before that happens.
  if (delta === 1 || delta === -2) {
    return {
      health: 'warn',
      label: 'Supported, at the limit',
      delta,
      detail: delta === 1
        ? 'kubectl is 1 minor version ahead of the cluster — the most the policy allows. Upgrading kubectl again without upgrading the cluster puts it out of support.'
        : 'kubectl is 2 minor versions behind the cluster — the most the policy allows. Upgrading the cluster again without upgrading kubectl puts it out of support.'
    };
  }
  return {
    health: 'ok',
    label: 'Supported',
    delta,
    detail: delta === 0
      ? 'kubectl and the cluster are on the same minor version.'
      : `kubectl is ${-delta} minor version${delta === -1 ? '' : 's'} behind the cluster, well within the supported range.`
  };
}

/** Formats an age the way kubectl does: 5d, 3h, 12m, 45s. */
export function age(timestamp?: string): string {
  if (!timestamp) {
    return '';
  }
  return humanDuration(Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000)));
}
