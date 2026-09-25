// The slices of Kubernetes objects these pages actually read.
//
// The bridge hands back whole objects typed only as K8sDockside.KubeObject,
// whose `spec` and `status` are `unknown`. Narrowing them here, once, is what
// makes the rest of src/ type-safe: a page says `list<Pod>(...)` and gets
// fields rather than casts.
//
// Only the fields the pages read are declared, and every one of them is
// optional: a node the device plugin has not registered with has no GPU
// capacity at all, a claim nobody has scheduled has no status, and a field
// added in a later Kubernetes is simply absent in an older one.
//
// The Dynamic Resource Allocation kinds are read at whatever version the
// cluster prefers -- the app resolves `resourceslices` and friends through
// discovery, not at a pinned version. On Kubernetes 1.34 and later that is
// resource.k8s.io/v1, whose field names are the JSON tags in
// k8s.io/api/resource/v1/types.go. A 1.32 cluster serves only v1beta1, which
// nests a device's attributes and capacity under `basic` and a request's
// class directly on the request rather than under `exactly`; both shapes are
// declared, and src/model/dra.ts reads either.

/** The kinds this plugin reads, spelled as the app spells them. */
export const NODES = 'nodes';
export const PODS = 'pods';
export const DAEMONSETS = 'daemonsets';
export const EVENTS = 'events';
// Built-in kind names in the app, not `crd:` ones: resource.k8s.io is part of
// Kubernetes, and the app's catalogue lists these four under "Dynamic
// Resources" (internal/kube/resources.go, frontend/src/lib/catalogue.ts).
export const SLICES = 'resourceslices';
export const CLAIMS = 'resourceclaims';
export const TEMPLATES = 'resourceclaimtemplates';
export const CLASSES = 'deviceclasses';

type Meta = K8sDockside.ObjectMeta;

export interface Condition {
    type?: string;
    status?: string;
    reason?: string;
    message?: string;
    lastTransitionTime?: string;
}

// ----- nodes -----------------------------------------------------------------

export interface Node extends K8sDockside.KubeObject {
    metadata: Meta;
    spec?: { unschedulable?: boolean; taints?: { key?: string; value?: string; effect?: string }[] };
    status?: {
        capacity?: Record<string, string>;
        allocatable?: Record<string, string>;
        conditions?: Condition[];
        nodeInfo?: { kubeletVersion?: string };
    };
}

// ----- pods ------------------------------------------------------------------

export interface ResourceRequirements {
    limits?: Record<string, string>;
    requests?: Record<string, string>;
    claims?: { name?: string; request?: string }[];
}

export interface Container {
    name?: string;
    resources?: ResourceRequirements;
}

export interface PodResourceClaim {
    name?: string;
    resourceClaimName?: string;
    resourceClaimTemplateName?: string;
}

export interface Pod extends K8sDockside.KubeObject {
    metadata: Meta;
    spec?: {
        nodeName?: string;
        containers?: Container[];
        initContainers?: (Container & { restartPolicy?: string })[];
        resourceClaims?: PodResourceClaim[];
    };
    status?: {
        phase?: string;
        conditions?: Condition[];
        resourceClaimStatuses?: { name?: string; resourceClaimName?: string }[];
        /** The claim the scheduler made for an extended resource DRA serves (KEP-5004, 1.34+). */
        extendedResourceClaimStatus?: { resourceClaimName?: string };
        nominatedNodeName?: string;
    };
}

// ----- workloads ---------------------------------------------------------------

export interface DaemonSet extends K8sDockside.KubeObject {
    metadata: Meta;
    status?: {
        desiredNumberScheduled?: number;
        numberReady?: number;
        numberAvailable?: number;
        numberUnavailable?: number;
        updatedNumberScheduled?: number;
    };
}

export interface KubeEvent extends K8sDockside.KubeObject {
    metadata: Meta;
    involvedObject?: { kind?: string; namespace?: string; name?: string; uid?: string };
    reason?: string;
    message?: string;
    type?: string;
    lastTimestamp?: string;
    eventTime?: string;
    count?: number;
}

// ----- dynamic resource allocation ----------------------------------------------

/** One typed attribute value: exactly one of these is set. */
export interface DeviceAttribute {
    int?: number;
    bool?: boolean;
    string?: string;
    version?: string;
}

export interface DeviceCapacity {
    value?: string | number;
}

export interface DeviceTaint {
    key?: string;
    value?: string;
    effect?: string;
}

export interface CounterConsumption {
    counterSet?: string;
    counters?: Record<string, DeviceCapacity>;
}

/** The fields a device has in v1 (and v1beta2); v1beta1 has them under `basic`. */
export interface DeviceFields {
    attributes?: Record<string, DeviceAttribute>;
    capacity?: Record<string, DeviceCapacity>;
    consumesCounters?: CounterConsumption[];
    taints?: DeviceTaint[];
    nodeName?: string;
    allowMultipleAllocations?: boolean;
}

export interface Device extends DeviceFields {
    name?: string;
    basic?: DeviceFields;
}

export interface ResourceSlice extends K8sDockside.KubeObject {
    metadata: Meta;
    spec?: {
        driver?: string;
        pool?: { name?: string; generation?: number; resourceSliceCount?: number };
        nodeName?: string;
        nodeSelector?: unknown;
        allNodes?: boolean;
        perDeviceNodeSelection?: boolean;
        devices?: Device[];
        sharedCounters?: { name?: string; counters?: Record<string, DeviceCapacity> }[];
    };
}

/** What a request asks for, in both shapes: v1's `exactly`, or v1beta1's fields on the request itself. */
export interface ExactRequest {
    deviceClassName?: string;
    allocationMode?: string;
    count?: number;
    adminAccess?: boolean;
    selectors?: { cel?: { expression?: string } }[];
}

export interface DeviceRequest extends ExactRequest {
    name?: string;
    exactly?: ExactRequest;
    firstAvailable?: (ExactRequest & { name?: string })[];
}

export interface ClaimSpec {
    devices?: { requests?: DeviceRequest[] };
}

export interface AllocationResult {
    request?: string;
    driver?: string;
    pool?: string;
    device?: string;
    adminAccess?: boolean;
    shareID?: string;
}

export interface ResourceClaim extends K8sDockside.KubeObject {
    metadata: Meta;
    spec?: ClaimSpec;
    status?: {
        allocation?: { devices?: { results?: AllocationResult[] }; nodeSelector?: unknown };
        reservedFor?: { resource?: string; name?: string; uid?: string; apiGroup?: string }[];
        devices?: { driver?: string; pool?: string; device?: string; conditions?: Condition[] }[];
    };
}

export interface ResourceClaimTemplate extends K8sDockside.KubeObject {
    metadata: Meta;
    spec?: { spec?: ClaimSpec };
}

export interface DeviceClass extends K8sDockside.KubeObject {
    metadata: Meta;
    spec?: {
        selectors?: { cel?: { expression?: string } }[];
        /** Serves pods that ask for this extended resource through DRA instead (KEP-5004, 1.34+). */
        extendedResourceName?: string;
    };
}

/** Everything the pages read, in one place, so the model functions take one argument. */
export interface Snapshot {
    nodes: Node[];
    pods: Pod[];
    slices: ResourceSlice[];
    claims: ResourceClaim[];
    templates: ResourceClaimTemplate[];
    classes: DeviceClass[];
    daemonSets: DaemonSet[];
    events: KubeEvent[];
    /** Kinds that could not be read, with why, so a page can say so instead of drawing zero. */
    missing: Record<string, string>;
}

export function emptySnapshot(): Snapshot {
    return { nodes: [], pods: [], slices: [], claims: [], templates: [], classes: [], daemonSets: [], events: [], missing: {} };
}

/** The status of a condition of one type, or '' when there is none. */
export function condition(conditions: Condition[] | undefined, type: string): Condition | undefined {
    return (conditions ?? []).find((c) => c.type === type);
}

/** Whether a pod is still holding what it was given: not finished, not gone. */
export function isLive(pod: Pod): boolean {
    const phase = pod.status?.phase ?? '';
    return phase !== 'Succeeded' && phase !== 'Failed';
}

/** A pod that the scheduler has not placed yet. */
export function isPending(pod: Pod): boolean {
    return (pod.status?.phase ?? 'Pending') === 'Pending' && !pod.spec?.nodeName;
}
