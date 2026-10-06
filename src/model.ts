import * as k from './kubectl';

export type Health = 'ok' | 'warn' | 'bad' | 'muted';

export interface Column {
  key: string;
  label: string;
  /**
   * Steps aside in a window narrower than ~900px, unless the user has chosen
   * to show it from the column menu.
   */
  secondary?: boolean;
  /** Right-align numeric-ish values. */
  numeric?: boolean;
  /**
   * Which reading from `Row.usage` the column draws: a sparkline and the
   * value, or with `share` the value as a share of its ceiling. The webview
   * hides these columns while no row has usage, so a cluster without
   * metrics-server does not carry empty columns.
   */
  metric?: 'cpu' | 'memory';
  /**
   * With `metric`: the reading as a percentage of the node's allocatable or
   * the pod's limits. Hidden while no row has that ceiling — a namespace
   * where nothing sets limits would otherwise get a column of blanks.
   */
  share?: boolean;
}

/** The part of a pod's reading that its partial ceiling is measured against. */
export interface PartialCeiling {
  /** Usage of the containers that set the limit: millicores or bytes. */
  used: number;
  /** The containers left out, which set no limit. */
  unlimited: string[];
}

/**
 * Live CPU and memory for a node or pod, from metrics-server, with the recent
 * history behind the table's sparkline. Attached by metrics.ts after `toRow`,
 * and only to rows that had a reading.
 */
export interface Usage {
  /** Millicores. */
  cpu: number;
  /** Bytes. */
  memory: number;
  /**
   * What the reading is measured against: allocatable for a node, the summed
   * limits for a pod. Absent when there is none — a pod with an unlimited
   * container can use whatever the node has.
   */
  cpuCeiling?: number;
  memoryCeiling?: number;
  /**
   * Pods where some containers set the limit and others do not, most often an
   * app beside a sidecar left unlimited. The ceiling then sums the limited
   * containers alone, and the share is their usage against it.
   */
  cpuPartial?: PartialCeiling;
  memoryPartial?: PartialCeiling;
  /** Time of the first and last sample, ms since epoch. */
  from: number;
  to: number;
  /** Oldest first: [seconds after `from`, millicores, bytes]. */
  samples: [number, number, number][];
  /** Pods only: the latest reading per container, by name. */
  containers?: Record<string, { cpu: number; memory: number }>;
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
   * Workloads whose logs kubectl reads as `kind/name` only: the containers of
   * their pod template, which every pod they run has, so the Logs tab can
   * offer a choice before kubectl has picked a pod. A pod's own come from
   * `containers` instead.
   */
  logContainers?: { name: string; kind: 'init' | 'app' }[];
  /**
   * Pods and those workloads: the `kubectl.kubernetes.io/default-container`
   * annotation, the container kubectl reads when none is named. The Logs tab
   * opens on it, so it starts on the same log the terminal would.
   */
  defaultContainer?: string;
  /**
   * Scalable kinds only: `spec.replicas` as a number, so the scale prompt can
   * open on the count that is actually set. Kept apart from the `ready` cell,
   * which is display text ("3/5") and rounds a missing spec to 0.
   */
  replicas?: number;
  /** Nodes only: `spec.unschedulable`, so the menu can offer Cordon or Uncordon. */
  unschedulable?: boolean;
  /** CronJobs only: `spec.suspend`, so the menu can offer Suspend or Resume. */
  suspended?: boolean;
  /**
   * Secrets only: the names of the keys under `data`, so the drawer can offer
   * Reveal and Copy per key. Names only; a value is fetched on demand and never
   * rides on a row.
   */
  secretKeys?: string[];
  /**
   * Pods being deleted only: when the deletion was requested, so the webview
   * can count up "Terminating (13s)" live instead of showing a bare word.
   */
  terminating?: string;
  /** Alongside `terminating`: the grace period in seconds, shown as "12s/30s". */
  terminatingGrace?: number;
  /**
   * The controller that created this object; see `ownerOf`. Carried on every
   * kind that has one so a row can be matched to its owner without another
   * fetch: it is what scoping the pod table to a Deployment resolves through,
   * pod -> ReplicaSet -> Deployment.
   */
  owner?: Owner;
  /**
   * Other objects this one names, for the row menu's Go to: the claims a pod
   * mounts, the workload an autoscaler drives, the object an event is about.
   * A pod's node and any kind's owner are left out, since `cells.node` and
   * `owner` already carry them and a pod table is the one where every byte
   * per row counts. See `linksOf`.
   */
  links?: Link[];
  /** Nodes and pods, when metrics-server answered; see `Usage`. */
  usage?: Usage;
}

/** A `kind/name` pair from an ownerReference, within the object's namespace. */
export interface Owner {
  kind: string;
  name: string;
}

/** A reference to another object Kubi lists. */
export interface Link {
  /** A kind id from `KINDS`, not the API's Kind: 'persistentvolumes'. */
  kind: string;
  name: string;
  /** Absent for a cluster-scoped kind. */
  namespace?: string;
}

/**
 * Rail sections. A flat list of thirty kinds is a wall of names; grouping them
 * the way the API itself is organised lets someone find a kind by what it does
 * rather than by reading every entry. Order here is the order they appear.
 *
 * Every section folds, and `open` is how it starts before the user has chosen:
 * only the two that most sessions live in. The rest stay a heading apiece
 * until asked for, so the rail opens at about twenty rows rather than forty.
 *
 * Config is kept to ConfigMaps and Secrets — what nearly every visit to it is
 * for — and the cluster-wide guard rails it used to hold (quotas, limits,
 * disruption budgets, priorities, admission webhooks) have a section of their
 * own, most of them from the `policy` and admission APIs.
 */
export type KindGroup = 'cluster' | 'workloads' | 'network' | 'config' | 'storage' | 'policy' | 'access';

export const GROUPS: { id: KindGroup; label: string; open: boolean }[] = [
  { id: 'workloads', label: 'Workloads', open: true },
  { id: 'cluster', label: 'Cluster', open: true },
  { id: 'network', label: 'Network', open: false },
  { id: 'config', label: 'Config', open: false },
  { id: 'storage', label: 'Storage', open: false },
  { id: 'policy', label: 'Policy', open: false },
  { id: 'access', label: 'Access', open: false }
];

export interface ResourceKind {
  id: string;
  label: string;
  singular: string;
  namespaced: boolean;
  icon: string;
  group: KindGroup;
  /**
   * kubectl's short names, so the rail's Go to box answers to `svc` or `cm`
   * the way a k9s `:` prompt does. Lower case.
   */
  aliases?: string[];
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
  /**
   * Can be rolled with `kubectl rollout restart` — the panel offers a Restart
   * button for these.
   */
  restartable?: boolean;
  /**
   * Has ports `kubectl port-forward` can reach, as `pod/`, `svc/` or a
   * workload's `kind/name` — the panel offers Port forward for these.
   */
  forwardable?: boolean;
}

const AGE: Column = { key: 'age', label: 'Age', numeric: true };
const CPU: Column = { key: 'cpu', label: 'CPU', numeric: true, metric: 'cpu' };
const MEMORY: Column = { key: 'memory', label: 'Memory', numeric: true, metric: 'memory' };
/**
 * Usage as a share of the ceiling, beside the reading it is a share of: a
 * pod's limits, or what the scheduler can allocate on a node. The labels are
 * kept short because the table is already wide; the cell's tooltip says which
 * ceiling it is. Keys are shared by both kinds so one filter works on either.
 */
const share = (metric: 'cpu' | 'memory', label: string): Column =>
  ({ key: metric === 'cpu' ? 'cpuPct' : 'memPct', label, numeric: true, metric, share: true });
const NAME: Column = { key: 'name', label: 'Name' };
const NAMESPACE: Column = { key: 'namespace', label: 'Namespace' };

/** Validating and mutating configurations are the same shape and are judged the same way. */
const WEBHOOK_COLUMNS: Column[] = [
  NAME,
  { key: 'status', label: 'Status' },
  { key: 'webhooks', label: 'Webhooks', numeric: true },
  { key: 'policy', label: 'Failure policy' },
  { key: 'targets', label: 'Targets' },
  AGE
];

const DECLARED_KINDS: ResourceKind[] = [
  {
    id: 'nodes',
    label: 'Nodes',
    singular: 'Node',
    namespaced: false,
    icon: 'server',
    group: 'cluster',
    aliases: ['no'],
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'status', label: 'Status' },
      CPU,
      share('cpu', 'CPU %'),
      MEMORY,
      share('memory', 'MEM %'),
      { key: 'roles', label: 'Roles', secondary: true },
      { key: 'version', label: 'Version', secondary: true },
      { key: 'internalIP', label: 'Internal IP', secondary: true },
      AGE
    ]
  },
  {
    id: 'pods',
    forwardable: true,
    label: 'Pods',
    singular: 'Pod',
    namespaced: true,
    icon: 'box',
    group: 'workloads',
    aliases: ['po'],
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'namespace', label: 'Namespace' },
      { key: 'status', label: 'Status' },
      { key: 'ready', label: 'Ready', numeric: true },
      { key: 'restarts', label: 'Restarts', numeric: true },
      CPU,
      share('cpu', 'CPU %'),
      MEMORY,
      share('memory', 'MEM %'),
      { key: 'node', label: 'Node', secondary: true },
      AGE
    ]
  },
  {
    id: 'services',
    forwardable: true,
    label: 'Services',
    singular: 'Service',
    namespaced: true,
    icon: 'plug',
    group: 'network',
    aliases: ['svc'],
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
    aliases: ['ing'],
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
    aliases: ['ev'],
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
    aliases: ['ns'],
    columns: [NAME, { key: 'status', label: 'Status' }, AGE]
  },
  {
    id: 'deployments',
    forwardable: true,
    label: 'Deployments',
    singular: 'Deployment',
    namespaced: true,
    icon: 'rocket',
    group: 'workloads',
    aliases: ['deploy'],
    scalable: true,
    restartable: true,
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
    forwardable: true,
    label: 'StatefulSets',
    singular: 'StatefulSet',
    namespaced: true,
    icon: 'database',
    group: 'workloads',
    aliases: ['sts'],
    scalable: true,
    restartable: true,
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
    aliases: ['ds'],
    restartable: true,
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
    aliases: ['rs'],
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
    aliases: ['cj'],
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
    aliases: ['ep'],
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
    aliases: ['netpol'],
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
    aliases: ['cm'],
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
    group: 'access',
    aliases: ['sa'],
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
    group: 'policy',
    aliases: ['quota'],
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
    group: 'policy',
    aliases: ['limits'],
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
    aliases: ['hpa'],
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
    aliases: ['pvc'],
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
    aliases: ['pv'],
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
    aliases: ['sc'],
    columns: [
      NAME,
      { key: 'provisioner', label: 'Provisioner' },
      { key: 'reclaim', label: 'Reclaim', secondary: true },
      { key: 'binding', label: 'Binding', secondary: true },
      { key: 'expansion', label: 'Expandable', secondary: true },
      AGE
    ]
  },
  {
    id: 'poddisruptionbudgets',
    label: 'Disruption budgets',
    singular: 'PodDisruptionBudget',
    namespaced: true,
    icon: 'shield',
    group: 'policy',
    aliases: ['pdb'],
    columns: [
      NAME,
      NAMESPACE,
      { key: 'status', label: 'Status' },
      { key: 'minAvailable', label: 'Min available', numeric: true, secondary: true },
      { key: 'maxUnavailable', label: 'Max unavailable', numeric: true, secondary: true },
      { key: 'allowed', label: 'Allowed', numeric: true },
      { key: 'healthy', label: 'Healthy', numeric: true },
      AGE
    ]
  },
  {
    id: 'priorityclasses',
    label: 'Priority classes',
    singular: 'PriorityClass',
    namespaced: false,
    icon: 'stack',
    group: 'policy',
    aliases: ['pc'],
    columns: [
      NAME,
      { key: 'value', label: 'Value', numeric: true },
      { key: 'default', label: 'Default' },
      { key: 'preemption', label: 'Preemption', secondary: true },
      { key: 'description', label: 'Description', secondary: true },
      AGE
    ],
    sort: { key: 'value', dir: -1 }
  },
  {
    id: 'ingressclasses',
    label: 'Ingress classes',
    singular: 'IngressClass',
    namespaced: false,
    icon: 'globe',
    group: 'network',
    columns: [
      NAME,
      { key: 'controller', label: 'Controller' },
      { key: 'default', label: 'Default' },
      { key: 'parameters', label: 'Parameters', secondary: true },
      AGE
    ]
  },
  {
    id: 'validatingwebhookconfigurations',
    label: 'Validating webhooks',
    singular: 'ValidatingWebhookConfiguration',
    namespaced: false,
    icon: 'shield',
    group: 'policy',
    columns: WEBHOOK_COLUMNS
  },
  {
    id: 'mutatingwebhookconfigurations',
    label: 'Mutating webhooks',
    singular: 'MutatingWebhookConfiguration',
    namespaced: false,
    icon: 'shield',
    group: 'policy',
    columns: WEBHOOK_COLUMNS
  },
  {
    id: 'roles',
    label: 'Roles',
    singular: 'Role',
    namespaced: true,
    icon: 'lock',
    group: 'access',
    columns: [
      NAME,
      NAMESPACE,
      { key: 'rules', label: 'Rules', numeric: true },
      { key: 'aggregation', label: 'Aggregation', secondary: true },
      AGE
    ]
  },
  {
    id: 'rolebindings',
    label: 'Role bindings',
    singular: 'RoleBinding',
    namespaced: true,
    icon: 'link',
    group: 'access',
    columns: [
      NAME,
      NAMESPACE,
      { key: 'status', label: 'Status' },
      { key: 'role', label: 'Role' },
      { key: 'subjects', label: 'Subjects' },
      AGE
    ]
  },
  {
    id: 'clusterroles',
    label: 'Cluster roles',
    singular: 'ClusterRole',
    namespaced: false,
    icon: 'lock',
    group: 'access',
    columns: [
      NAME,
      { key: 'rules', label: 'Rules', numeric: true },
      { key: 'aggregation', label: 'Aggregation', secondary: true },
      AGE
    ]
  },
  {
    id: 'clusterrolebindings',
    label: 'Cluster role bindings',
    singular: 'ClusterRoleBinding',
    namespaced: false,
    icon: 'link',
    group: 'access',
    columns: [
      NAME,
      { key: 'status', label: 'Status' },
      { key: 'role', label: 'Role' },
      { key: 'subjects', label: 'Subjects' },
      AGE
    ]
  }
];

/**
 * Other kinds a kind's rows are judged against. A binding is only broken
 * relative to the roles that exist, and a webhook only relative to the
 * Services behind it, so the panel lists these beside the kind itself and
 * hands them to `toRow`. A list that could not be read — forbidden, or the
 * API not served — is simply absent, and the check that needs it is skipped:
 * a warning built on data nobody saw would be a false alarm.
 */
export const REFERENCES: Record<string, string[]> = {
  rolebindings: ['roles', 'clusterroles'],
  clusterrolebindings: ['clusterroles'],
  validatingwebhookconfigurations: ['services', 'endpoints'],
  mutatingwebhookconfigurations: ['services', 'endpoints']
};

/** The lists named by `REFERENCES`, by kind id. */
export type Refs = Record<string, k.KubeObject[]>;

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

export function toRow(kindId: string, object: k.KubeObject, refs: Refs = {}): Row {
  const base = { name: object.metadata.name, namespace: object.metadata.namespace };
  const built = build(kindId, object, refs);
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
    ...logFields(kindId, object),
    ...(built.replicas !== undefined ? { replicas: built.replicas } : {}),
    ...(built.unschedulable ? { unschedulable: true } : {}),
    ...(built.suspended ? { suspended: true } : {}),
    ...(built.secretKeys ? { secretKeys: built.secretKeys } : {}),
    ...(built.terminating ? { terminating: built.terminating } : {}),
    ...(built.terminatingGrace ? { terminatingGrace: built.terminatingGrace } : {}),
    ...(owner ? { owner } : {}),
    ...linksField(kindId, object),
    ...(object.metadata.uid ? { uid: object.metadata.uid } : {})
  };
}

/** The workload kinds `kubectl logs` accepts as `kind/name`. */
const LOG_WORKLOADS = new Set(['deployments', 'statefulsets', 'daemonsets', 'replicasets']);

/** The annotation kubectl reads to choose a container when none is named. */
const DEFAULT_CONTAINER = 'kubectl.kubernetes.io/default-container';

/**
 * What the Logs tab needs beyond a pod's own containers: the default
 * container for pods, and for workloads their template's containers as well.
 * Ephemeral containers are left out of a template — they are added to a
 * running pod, never declared on the workload.
 */
function logFields(kindId: string, object: k.KubeObject): Pick<Row, 'logContainers' | 'defaultContainer'> {
  if (kindId === 'pods') {
    const annotated = object.metadata.annotations?.[DEFAULT_CONTAINER];
    return annotated ? { defaultContainer: annotated } : {};
  }
  if (!LOG_WORKLOADS.has(kindId)) return {};
  const template = object.spec?.template ?? {};
  const spec = template.spec ?? {};
  const annotated = template.metadata?.annotations?.[DEFAULT_CONTAINER];
  return {
    logContainers: [
      ...(spec.initContainers ?? []).map((c: any) => ({ name: String(c.name), kind: 'init' as const })),
      ...(spec.containers ?? []).map((c: any) => ({ name: String(c.name), kind: 'app' as const }))
    ],
    ...(annotated ? { defaultContainer: annotated } : {})
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

/** The kind id Kubi lists an API Kind under, if it lists it at all: 'StatefulSet' -> 'statefulsets'. */
function kindIdOf(apiKind: string | undefined): string | undefined {
  return apiKind ? KINDS.find((kind) => kind.singular === apiKind)?.id : undefined;
}

function linksField(kindId: string, object: k.KubeObject): Pick<Row, 'links'> {
  const links = linksOf(kindId, object);
  return links.length ? { links } : {};
}

/**
 * The objects a row points at by name, for Go to. Only references the object
 * itself spells out are followed; one that would take a search to answer —
 * which Services select this pod, which autoscaler drives this Deployment —
 * is not, since that would be a list per refresh for a menu item.
 */
function linksOf(kindId: string, object: k.KubeObject): Link[] {
  const namespace = object.metadata.namespace;
  const spec: any = object.spec ?? {};
  switch (kindId) {
    case 'pods':
      return (spec.volumes ?? []).flatMap((volume: any): Link[] => {
        if (volume.persistentVolumeClaim?.claimName) {
          return [{ kind: 'persistentvolumeclaims', name: volume.persistentVolumeClaim.claimName, namespace }];
        }
        // A generic ephemeral volume's claim is created for the pod, and named
        // after it and the volume by rule rather than recorded anywhere.
        if (volume.ephemeral) {
          return [{ kind: 'persistentvolumeclaims', name: `${object.metadata.name}-${volume.name}`, namespace }];
        }
        return [];
      });
    case 'services':
      // An ExternalName Service is a DNS alias with nothing behind it. Every
      // other type has an Endpoints of its own name, kept by the control plane
      // from the selector, or by hand for a Service without one.
      return spec.type === 'ExternalName' ? [] : [{ kind: 'endpoints', name: object.metadata.name, namespace }];
    case 'endpoints':
      return [{ kind: 'services', name: object.metadata.name, namespace }];
    case 'ingresses': {
      // networking.k8s.io/v1 names `service.name`; the v1beta1 shape some
      // clusters still serve names `serviceName`.
      const backends: any[] = [
        spec.defaultBackend ?? spec.backend,
        ...(spec.rules ?? []).flatMap((rule: any) => (rule.http?.paths ?? []).map((path: any) => path.backend))
      ];
      const names = new Set(backends.map((b) => b?.service?.name ?? b?.serviceName).filter(Boolean));
      return [...names].map((name) => ({ kind: 'services', name, namespace }));
    }
    case 'events': {
      const involved = (object as any).involvedObject ?? (object as any).regarding ?? {};
      const target = kindIdOf(involved.kind);
      if (!target || !involved.name) return [];
      const namespaced = kindById(target)?.namespaced;
      return [{ kind: target, name: involved.name, ...(namespaced ? { namespace: involved.namespace ?? namespace } : {}) }];
    }
    case 'horizontalpodautoscalers': {
      const target = kindIdOf(spec.scaleTargetRef?.kind);
      return target && spec.scaleTargetRef.name ? [{ kind: target, name: spec.scaleTargetRef.name, namespace }] : [];
    }
    case 'persistentvolumeclaims':
      return spec.volumeName ? [{ kind: 'persistentvolumes', name: spec.volumeName }] : [];
    case 'persistentvolumes':
      return spec.claimRef?.name
        ? [{ kind: 'persistentvolumeclaims', name: spec.claimRef.name, namespace: spec.claimRef.namespace }]
        : [];
    case 'rolebindings':
    case 'clusterrolebindings': {
      const ref = (object as any).roleRef ?? {};
      if (!ref.name) return [];
      // A RoleBinding may grant a ClusterRole; a Role is always the binding's own namespace's.
      const role: Link = ref.kind === 'ClusterRole'
        ? { kind: 'clusterroles', name: ref.name }
        : { kind: 'roles', name: ref.name, namespace };
      const accounts = ((object as any).subjects ?? [])
        .filter((s: any) => s.kind === 'ServiceAccount' && s.name)
        .map((s: any): Link => ({ kind: 'serviceaccounts', name: s.name, namespace: s.namespace ?? namespace }));
      return [role, ...accounts];
    }
    default:
      return [];
  }
}

interface Built {
  health: Health;
  status: string;
  cells: Record<string, string>;
  /** Overrides the timestamp the age cell is recomputed from. */
  created?: string;
  containers?: ContainerInfo[];
  replicas?: number;
  unschedulable?: boolean;
  suspended?: boolean;
  secretKeys?: string[];
  terminating?: string;
  terminatingGrace?: number;
}

function build(kindId: string, object: k.KubeObject, refs: Refs): Built {
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
    case 'poddisruptionbudgets':
      return buildPdb(object);
    case 'priorityclasses':
      return buildPriorityClass(object);
    case 'ingressclasses':
      return buildIngressClass(object);
    case 'validatingwebhookconfigurations':
    case 'mutatingwebhookconfigurations':
      return buildWebhookConfiguration(object, refs);
    case 'roles':
    case 'clusterroles':
      return buildRole(object);
    case 'rolebindings':
    case 'clusterrolebindings':
      return buildBinding(object, refs);
    default:
      return { health: 'muted', status: '', cells: {} };
  }
}

/**
 * When a pod's deletion was asked for. `deletionTimestamp` is not that: the
 * API server sets it to the request time plus the grace period, the moment the
 * kubelet may kill the pod, so it sits in the future for the whole graceful
 * shutdown. Taking the grace period back off recovers the request time.
 */
function deletionRequested(pod: k.KubeObject): string | undefined {
  const deadline = new Date(pod.metadata.deletionTimestamp ?? '').getTime();
  if (Number.isNaN(deadline)) return undefined;
  const grace = pod.metadata.deletionGracePeriodSeconds ?? 0;
  return new Date(deadline - grace * 1000).toISOString();
}

function buildPod(pod: k.KubeObject): Built {
  const statuses: any[] = pod.status?.containerStatuses ?? [];
  const ready = statuses.filter((c) => c.ready).length;
  const restarts = statuses.reduce((sum, c) => sum + (c.restartCount ?? 0), 0);
  // Container-level reasons are far more actionable than the coarse pod phase.
  let reason =
    statuses.map((c) => c.state?.waiting?.reason ?? c.state?.terminated?.reason).find(Boolean) ??
    pod.status?.reason ??
    pod.status?.phase ??
    'Unknown';
  // A pod being deleted keeps `phase: Running` until its containers stop; the
  // deletion timestamp is the only sign, so mirror kubectl and say so.
  let terminating: string | undefined;
  if (pod.metadata.deletionTimestamp) {
    reason = pod.status?.reason === 'NodeLost' ? 'Unknown' : 'Terminating';
    if (reason === 'Terminating') terminating = deletionRequested(pod);
  }

  const allReady = statuses.length > 0 && ready === statuses.length;
  let health: Health = 'bad';
  if (reason === 'Completed') {
    health = 'muted';
  } else if (reason === 'Running' && allReady) {
    health = 'ok';
  } else if (reason === 'Running' || reason === 'Terminating' || reason === 'ContainerCreating' || reason === 'PodInitializing' || reason === 'Pending') {
    health = 'warn';
  }

  return {
    health,
    status: reason,
    containers: buildContainers(pod),
    ...(terminating ? { terminating } : {}),
    ...(terminating && pod.metadata.deletionGracePeriodSeconds
      ? { terminatingGrace: pod.metadata.deletionGracePeriodSeconds }
      : {}),
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
  // Worded as kubectl words it: a cordon is shown whatever the readiness.
  const status = (isReady ? 'Ready' : 'NotReady') + (unschedulable ? ',SchedulingDisabled' : '');

  const roles = Object.keys(node.metadata.labels ?? {})
    .filter((l) => l.startsWith('node-role.kubernetes.io/'))
    .map((l) => l.replace('node-role.kubernetes.io/', ''))
    .filter(Boolean);
  const addresses: any[] = node.status?.addresses ?? [];

  return {
    health: isReady ? (unschedulable ? 'warn' : 'ok') : 'bad',
    status,
    unschedulable,
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
    suspended,
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
  // in it — the drawer's Reveal and Copy fetch one key at a time, on demand.
  const { keys, count } = dataKeys(secret);
  const type = (secret as any).type ?? 'Opaque';
  return {
    health: count === 0 ? 'muted' : 'ok',
    status: type,
    cells: { type, keys: keys || '<empty>', data: String(count) },
    secretKeys: Object.keys((secret as any).data ?? {})
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

function buildPdb(budget: k.KubeObject): Built {
  const status = budget.status ?? {};
  const current = Number(status.currentHealthy ?? 0);
  const desired = Number(status.desiredHealthy ?? 0);
  const allowed = Number(status.disruptionsAllowed ?? 0);
  const expected = Number(status.expectedPods ?? 0);

  // Zero allowed disruptions is what makes a drain sit for minutes, but it only
  // explains something while the pods are healthy. Below the minimum the budget
  // is not the cause, the workload is; and a budget that selects no pods
  // protects nothing, so it is grey rather than a warning about a number that
  // cannot be anything else.
  let health: Health = 'ok';
  let word = 'Allowed';
  if (expected === 0) {
    health = 'muted';
    word = 'No pods';
  } else if (current < desired) {
    health = 'bad';
    word = 'Below minimum';
  } else if (allowed === 0) {
    health = 'warn';
    word = 'Blocking';
  }

  const bound = (value: unknown): string => (value === undefined ? 'N/A' : String(value));
  return {
    health,
    status: word,
    cells: {
      status: word,
      minAvailable: bound(budget.spec?.minAvailable),
      maxUnavailable: bound(budget.spec?.maxUnavailable),
      allowed: String(allowed),
      healthy: `${current}/${desired}`
    }
  };
}

function buildPriorityClass(priority: k.KubeObject): Built {
  const isDefault = Boolean((priority as any).globalDefault);
  return {
    health: 'ok',
    status: isDefault ? 'Default' : 'Available',
    cells: {
      value: String((priority as any).value ?? 0),
      default: isDefault ? 'yes' : 'no',
      // Never is the one that changes behaviour: pods of the class wait for
      // room rather than evicting lower-priority ones.
      preemption: (priority as any).preemptionPolicy ?? 'PreemptLowerPriority',
      description: String((priority as any).description ?? '').replace(/\s+/g, ' ').trim()
    }
  };
}

function buildIngressClass(ingressClass: k.KubeObject): Built {
  const annotations = ingressClass.metadata.annotations ?? {};
  const isDefault = annotations['ingressclass.kubernetes.io/is-default-class'] === 'true';
  const parameters = ingressClass.spec?.parameters;
  return {
    health: 'ok',
    status: isDefault ? 'Default' : 'Available',
    cells: {
      controller: ingressClass.spec?.controller ?? '',
      default: isDefault ? 'yes' : 'no',
      parameters: parameters ? `${parameters.kind}/${parameters.name}` : '<none>'
    }
  };
}

const WEBHOOK_RANK: Record<Health, number> = { ok: 0, muted: 0, warn: 1, bad: 2 };

/**
 * A webhook configuration is judged by whether the API server can reach what it
 * calls. A `Fail` policy turns an unreachable webhook into a rejection of every
 * create or update it matches, with an error that names the webhook rather than
 * the Service behind it, so this is the row that explains it. `Ignore` lets the
 * request through, so an unreachable target there is shown but not graded.
 *
 * Only a Service target can be checked from here; a `url` is somewhere outside
 * the cluster. The worst webhook in the configuration sets the row's health.
 */
function buildWebhookConfiguration(config: k.KubeObject, refs: Refs): Built {
  const hooks: any[] = (config as any).webhooks ?? [];
  let health: Health = 'ok';
  let word = 'Active';
  const policies = new Set<string>();
  const targets: string[] = [];

  for (const hook of hooks) {
    // `failurePolicy` defaults to Fail in admissionregistration.k8s.io/v1.
    const policy: string = hook.failurePolicy ?? 'Fail';
    policies.add(policy);
    const service = hook.clientConfig?.service;
    if (!service) {
      targets.push(hostOf(hook.clientConfig?.url));
      continue;
    }
    const target = `${service.namespace}/${service.name}`;
    const problem = serviceProblem(service.namespace, service.name, refs);
    targets.push(problem ? `${target} (${problem})` : target);
    if (!problem || policy !== 'Fail') continue;
    const verdict: Health = problem === 'not found' ? 'bad' : 'warn';
    if (WEBHOOK_RANK[verdict] > WEBHOOK_RANK[health]) {
      health = verdict;
      word = problem === 'not found' ? 'Service missing' : 'No endpoints';
    }
  }

  const unique = [...new Set(targets.filter(Boolean))];
  const shown = unique.slice(0, 3).join(', ');
  return {
    health,
    status: word,
    cells: {
      status: word,
      webhooks: String(hooks.length),
      policy: [...policies].join(', ') || '<none>',
      targets: unique.length > 3 ? `${shown} +${unique.length - 3} more` : shown || '<none>'
    }
  };
}

/** The host of a webhook's external `url`, which is all the table has room for. */
function hostOf(url: unknown): string {
  try {
    return new URL(String(url)).host;
  } catch {
    return String(url ?? '');
  }
}

/**
 * What is wrong with the Service behind a webhook, or undefined when nothing
 * is — or when it cannot be told because the lists were not read.
 */
function serviceProblem(namespace: string, name: string, refs: Refs): 'not found' | 'no endpoints' | undefined {
  const same = (o: k.KubeObject) => o.metadata.name === name && o.metadata.namespace === namespace;
  if (refs.services && !refs.services.some(same)) return 'not found';
  if (refs.endpoints) {
    const endpoints = refs.endpoints.find(same);
    const ready = ((endpoints as any)?.subsets ?? []).some((s: any) => (s.addresses ?? []).length > 0);
    if (!ready) return 'no endpoints';
  }
  return undefined;
}

const AGGREGATE_PREFIX = 'rbac.authorization.k8s.io/aggregate-to-';

function buildRole(role: k.KubeObject): Built {
  const rules = ((role as any).rules ?? []).length;
  const selectors: any[] = (role as any).aggregationRule?.clusterRoleSelectors ?? [];
  // Two directions of the same mechanism: a role can be assembled from others
  // by selector, and can carry the label that puts it into another. Both
  // explain rules that are not written on the object itself.
  const from = selectors.flatMap((s) => Object.entries(s.matchLabels ?? {}).map(([key, value]) => `${key.replace('rbac.authorization.k8s.io/', '')}=${value}`));
  const feeds = Object.entries(role.metadata.labels ?? {})
    .filter(([key, value]) => key.startsWith(AGGREGATE_PREFIX) && value === 'true')
    .map(([key]) => key.slice(AGGREGATE_PREFIX.length));
  const aggregation = [
    from.length ? `from ${from.join(', ')}` : '',
    feeds.length ? `into ${feeds.join(', ')}` : ''
  ].filter(Boolean).join(' · ');

  // An aggregated role's rules are filled in by a controller, so having none
  // yet is not the same as having none at all.
  const empty = rules === 0 && selectors.length === 0;
  return {
    health: empty ? 'muted' : 'ok',
    status: empty ? 'No rules' : `${rules} rule${rules === 1 ? '' : 's'}`,
    cells: { rules: String(rules), aggregation }
  };
}

function buildBinding(binding: k.KubeObject, refs: Refs): Built {
  const ref = (binding as any).roleRef ?? {};
  const subjects: any[] = (binding as any).subjects ?? [];
  const role = `${ref.kind ?? 'Role'}/${ref.name ?? ''}`;

  // A binding to a role that does not exist grants nothing, and nothing else
  // in the tables shows that. A RoleBinding may point at either kind of role,
  // and a Role is looked for in the binding's own namespace.
  const roles = ref.kind === 'ClusterRole' ? refs.clusterroles : refs.roles;
  const dangling = roles !== undefined && !roles.some(
    (r) => r.metadata.name === ref.name && (ref.kind === 'ClusterRole' || r.metadata.namespace === binding.metadata.namespace)
  );

  const names = subjects.map((s) =>
    s.kind === 'ServiceAccount' ? `ServiceAccount/${s.namespace ?? binding.metadata.namespace ?? ''}/${s.name}` : `${s.kind}/${s.name}`
  );
  const shown = names.slice(0, 5).join(', ');
  const rest = names.length - 5;

  const word = dangling ? 'Role missing' : subjects.length === 0 ? 'No subjects' : 'Bound';
  return {
    health: dangling ? 'warn' : subjects.length === 0 ? 'muted' : 'ok',
    status: word,
    cells: {
      status: word,
      role,
      subjects: names.length === 0 ? '<none>' : rest > 0 ? `${shown} +${rest} more` : shown
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
