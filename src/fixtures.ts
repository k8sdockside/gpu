// A cluster's worth of accelerators, shaped the way the API really writes them.
//
// Used by the page render test and by scripts/preview.mjs, so that what the
// test asserts on and what the preview draws are the same cluster and cannot
// drift apart. It mirrors what dev/ sets up for real -- the DRA example
// driver's simulated GPUs on a kind worker, and a KWOK fleet of H100 nodes
// with NVIDIA-shaped ResourceSlices, a MIG node, and device-plugin nodes --
// plus the states a healthy cluster never shows you:
//
//   dgx-h100-01..03   8 × H100 each through NVIDIA's DRA driver: one node busy
//                     with a single 8-GPU training pod, one with a claim shared
//                     by two pods, one with a device its driver has tainted
//                     and a claim holding a GPU that no pod uses. dgx-h100-02
//                     also still advertises nvidia.com/gpu from the old
//                     device plugin -- counted once.
//   dgx-a100-mig      A100s through DRA with static MIG: gpu-0 in seven
//                     1g.10gb instances, gpu-1 in 3g + 2g + 2g, two whole.
//   gpu-l4-01         4 × L4 through the device plugin, three in use.
//   gpu-a10-02        4 × A10 through the device plugin; one lost (allocatable
//                     3 of capacity 4).
//   gpu-t4-ts         2 × T4, time-sliced 4 ways (nvidia.com/gpu: 8).
//   gpu-mig-dp        an H100 in mig.strategy=mixed through the device plugin.
//   mi300-01          8 × AMD MI300X, cordoned.
//   kind-worker       the DRA example driver's 8 simulated GPUs, with the
//                     workloads dev/manifests/dra-workloads.yaml creates.
//
// Pending: a pod waiting for four GPUs, a DRA pod that can never fit (16
// GPUs asked, 8 per node), and a MIG notebook no instance is free for.
//
// It lives in src/ rather than src/pages/ because scripts/build.mjs turns
// every non-test .ts under src/pages into a page of its own.

import type { Container, DaemonSet, Device, DeviceClass, KubeEvent, Node, Pod, ResourceClaim, ResourceClaimTemplate, ResourceSlice } from './model/kube.js';

const T0 = '2026-09-20T08:00:00Z';

// ----- nodes ----------------------------------------------------------------------

function node(name: string, labels: Record<string, string>, capacity: Record<string, string> = {}, allocatable = capacity, extra: Partial<Node> = {}): Node {
    return {
        apiVersion: 'v1',
        kind: 'Node',
        metadata: { name, labels: { 'kubernetes.io/hostname': name, ...labels }, creationTimestamp: T0 },
        spec: extra.spec ?? {},
        status: {
            capacity: { cpu: '96', memory: '1Ti', pods: '110', ...capacity },
            allocatable: { cpu: '95', memory: '1000Gi', pods: '110', ...allocatable },
            conditions: [{ type: 'Ready', status: 'True' }],
            ...extra.status,
        },
    };
}

function gfd(product: string, memoryMiB: number, count: number, more: Record<string, string> = {}): Record<string, string> {
    return {
        'nvidia.com/gpu.present': 'true',
        'nvidia.com/gpu.product': product,
        'nvidia.com/gpu.memory': String(memoryMiB),
        'nvidia.com/gpu.count': String(count),
        'nvidia.com/gpu.replicas': '1',
        'nvidia.com/gpu.sharing-strategy': 'none',
        'nvidia.com/cuda.driver-version.full': '570.124.06',
        'nvidia.com/cuda.runtime-version.full': '12.8',
        'nvidia.com/mig.strategy': 'single',
        ...more,
    };
}

export const nodes: Node[] = [
    node('dgx-h100-01', gfd('NVIDIA-H100-80GB-HBM3', 81559, 8)),
    node('dgx-h100-02', gfd('NVIDIA-H100-80GB-HBM3', 81559, 8), { 'nvidia.com/gpu': '8' }),
    node('dgx-h100-03', gfd('NVIDIA-H100-80GB-HBM3', 81559, 8)),
    node('dgx-a100-mig', gfd('NVIDIA-A100-SXM4-80GB', 81920, 4, { 'nvidia.com/mig.capable': 'true' })),
    node('gpu-l4-01', gfd('NVIDIA-L4', 23034, 4), { 'nvidia.com/gpu': '4' }),
    node('gpu-a10-02', gfd('NVIDIA-A10', 23028, 4), { 'nvidia.com/gpu': '4' }, { 'nvidia.com/gpu': '3' }),
    node(
        'gpu-t4-ts',
        gfd('NVIDIA-Tesla-T4-SHARED', 15360, 2, { 'nvidia.com/gpu.replicas': '4', 'nvidia.com/gpu.sharing-strategy': 'time-slicing' }),
        { 'nvidia.com/gpu': '8' },
    ),
    node(
        'gpu-mig-dp',
        gfd('NVIDIA-H100-80GB-HBM3', 81559, 1, { 'nvidia.com/mig.strategy': 'mixed' }),
        { 'nvidia.com/mig-1g.10gb': '4', 'nvidia.com/mig-3g.40gb': '1' },
    ),
    node('mi300-01', { 'amd.com/gpu.product-name': 'AMD_Instinct_MI300X_OAM', 'amd.com/gpu.vram': '192G' }, { 'amd.com/gpu': '8' }, { 'amd.com/gpu': '8' }, { spec: { unschedulable: true } }),
    node('kind-worker', {}),
    node('cpu-01', {}),
];

// ----- DRA: device classes and slices ------------------------------------------------------

export const classes: DeviceClass[] = [
    {
        apiVersion: 'resource.k8s.io/v1',
        kind: 'DeviceClass',
        metadata: { name: 'gpu.nvidia.com' },
        spec: { selectors: [{ cel: { expression: "device.driver == 'gpu.nvidia.com' && device.attributes['gpu.nvidia.com'].type == 'gpu'" } }] },
    },
    {
        apiVersion: 'resource.k8s.io/v1',
        kind: 'DeviceClass',
        metadata: { name: 'mig.nvidia.com' },
        spec: { selectors: [{ cel: { expression: "device.driver == 'gpu.nvidia.com' && device.attributes['gpu.nvidia.com'].type == 'mig'" } }] },
    },
    {
        apiVersion: 'resource.k8s.io/v1',
        kind: 'DeviceClass',
        metadata: { name: 'gpu.example.com' },
        spec: { selectors: [{ cel: { expression: "device.driver == 'gpu.example.com'" } }] },
    },
];

const str = (v: string) => ({ string: v });
const ver = (v: string) => ({ version: v });
const int = (v: number) => ({ int: v });

function uuid(nodeName: string, i: number): string {
    let h = 0;
    for (const c of `${nodeName}/${i}`) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const hex = h.toString(16).padStart(8, '0');
    return `GPU-${hex}-${hex.slice(0, 4)}-4${hex.slice(1, 4)}-a${hex.slice(2, 5)}-${hex}${hex.slice(0, 4)}`;
}

function h100(nodeName: string, i: number, product = 'NVIDIA H100 80GB HBM3', memory = '81559Mi', extra: Partial<Device> = {}): Device {
    return {
        name: `gpu-${i}`,
        attributes: {
            type: str('gpu'),
            uuid: str(uuid(nodeName, i)),
            productName: str(product),
            brand: str('Nvidia'),
            architecture: str(product.includes('A100') ? 'Ampere' : 'Hopper'),
            cudaComputeCapability: ver(product.includes('A100') ? '8.0.0' : '9.0.0'),
            driverVersion: ver('570.124.6'),
            cudaDriverVersion: ver('12.8.0'),
            'resource.kubernetes.io/pcieRoot': str(`pci0000:${i < 4 ? '00' : '80'}`),
        },
        capacity: { memory: { value: memory } },
        ...extra,
    };
}

function mig(nodeName: string, parent: number, profile: string, profileId: number, start: number, memory: string, sms: number): Device {
    return {
        name: `gpu-${parent}-mig-${profile.replace('.', '')}-${profileId}-${start}`,
        attributes: {
            type: str('mig'),
            uuid: str(`MIG-${uuid(nodeName, parent * 100 + start).slice(4)}`),
            parentUUID: str(uuid(nodeName, parent)),
            profile: str(profile),
            productName: str('NVIDIA A100-SXM4-80GB'),
            brand: str('Nvidia'),
            architecture: str('Ampere'),
            cudaComputeCapability: ver('8.0.0'),
            driverVersion: ver('570.124.6'),
            cudaDriverVersion: ver('12.8.0'),
        },
        capacity: { memory: { value: memory }, multiprocessors: { value: String(sms) } },
    };
}

function slice(nodeName: string, driver: string, devices: Device[], generation = 1): ResourceSlice {
    return {
        apiVersion: 'resource.k8s.io/v1',
        kind: 'ResourceSlice',
        metadata: { name: `${nodeName}-${driver}-x${generation}`, ownerReferences: [{ apiVersion: 'v1', kind: 'Node', name: nodeName, uid: `uid-${nodeName}`, controller: true }] },
        spec: { driver, nodeName, pool: { name: nodeName, generation, resourceSliceCount: 1 }, devices },
    };
}

const eight = (f: (i: number) => Device) => Array.from({ length: 8 }, (_, i) => f(i));

export const slices: ResourceSlice[] = [
    slice('dgx-h100-01', 'gpu.nvidia.com', eight((i) => h100('dgx-h100-01', i))),
    slice('dgx-h100-02', 'gpu.nvidia.com', eight((i) => h100('dgx-h100-02', i))),
    slice(
        'dgx-h100-03',
        'gpu.nvidia.com',
        eight((i) => h100('dgx-h100-03', i, undefined, undefined, i === 5 ? { taints: [{ key: 'gpu.nvidia.com/xid', value: '79', effect: 'NoSchedule' }] } : {})),
    ),
    // A stale slice from before the driver restarted: generation 0, superseded.
    slice('dgx-h100-03', 'gpu.nvidia.com', eight((i) => h100('dgx-h100-03', i)), 0),
    slice('dgx-a100-mig', 'gpu.nvidia.com', [
        ...[0, 1, 2, 3, 4, 5, 6].map((k) => mig('dgx-a100-mig', 0, '1g.10gb', 19, k, '9728Mi', 14)),
        mig('dgx-a100-mig', 1, '3g.40gb', 9, 0, '40192Mi', 42),
        mig('dgx-a100-mig', 1, '2g.20gb', 14, 4, '19968Mi', 28),
        mig('dgx-a100-mig', 1, '2g.20gb', 14, 6, '19968Mi', 28),
        h100('dgx-a100-mig', 2, 'NVIDIA A100-SXM4-80GB', '81920Mi'),
        h100('dgx-a100-mig', 3, 'NVIDIA A100-SXM4-80GB', '81920Mi'),
    ]),
    slice(
        'kind-worker',
        'gpu.example.com',
        eight((i) => ({
            name: `gpu-${i}`,
            attributes: { driverVersion: ver('1.0.0'), index: int(i), model: str('LATEST-GPU-MODEL'), uuid: str(`gpu-${uuid('kind-worker', i).slice(4).toLowerCase()}`) },
            capacity: { memory: { value: '80Gi' } },
        })),
    ),
];

// ----- DRA: templates and claims -------------------------------------------------------------

function template(namespace: string, name: string, deviceClass: string, count = 1, cel = ''): ResourceClaimTemplate {
    return {
        apiVersion: 'resource.k8s.io/v1',
        kind: 'ResourceClaimTemplate',
        metadata: { name, namespace, creationTimestamp: T0 },
        spec: {
            spec: {
                devices: {
                    requests: [
                        {
                            name: 'gpu',
                            exactly: { deviceClassName: deviceClass, allocationMode: 'ExactCount', count, ...(cel ? { selectors: [{ cel: { expression: cel } }] } : {}) },
                        },
                    ],
                },
            },
        },
    };
}

export const templates: ResourceClaimTemplate[] = [
    template('training', 'h100-x8', 'gpu.nvidia.com', 8),
    template('inference', 'h100-x1', 'gpu.nvidia.com', 1),
    template('notebooks', 'mig-1g', 'mig.nvidia.com', 1, "device.attributes['gpu.nvidia.com'].profile == '1g.10gb'"),
    template('dra-demo', 'single-gpu', 'gpu.example.com', 1),
    template('dra-demo', 'two-gpus', 'gpu.example.com', 2),
    template('dra-demo', 'too-many-gpus', 'gpu.example.com', 16),
];

interface Allocation {
    pool: string;
    devices: string[];
    driver?: string;
}

function claim(
    namespace: string,
    name: string,
    deviceClass: string,
    alloc: Allocation | null,
    pods: string[],
    options: { count?: number; owner?: string; entry?: string } = {},
): ResourceClaim {
    return {
        apiVersion: 'resource.k8s.io/v1',
        kind: 'ResourceClaim',
        metadata: {
            name,
            namespace,
            creationTimestamp: T0,
            ...(options.owner
                ? {
                      ownerReferences: [{ apiVersion: 'v1', kind: 'Pod', name: options.owner, uid: `uid-${options.owner}`, controller: true, blockOwnerDeletion: true }],
                      annotations: { 'resource.kubernetes.io/pod-claim-name': options.entry ?? 'gpu' },
                  }
                : {}),
        },
        spec: { devices: { requests: [{ name: 'gpu', exactly: { deviceClassName: deviceClass, allocationMode: 'ExactCount', count: options.count ?? 1 } }] } },
        status: alloc
            ? {
                  allocation: {
                      devices: { results: alloc.devices.map((device) => ({ request: 'gpu', driver: alloc.driver ?? 'gpu.nvidia.com', pool: alloc.pool, device })) },
                  },
                  reservedFor: pods.map((pod) => ({ resource: 'pods', name: pod, uid: `uid-${pod}` })),
              }
            : {},
    };
}

const all8 = ['gpu-0', 'gpu-1', 'gpu-2', 'gpu-3', 'gpu-4', 'gpu-5', 'gpu-6', 'gpu-7'];

export const claims: ResourceClaim[] = [
    // One training pod holding a whole DGX.
    claim('training', 'llm-pretrain-0-gpu-7xk2p', 'gpu.nvidia.com', { pool: 'dgx-h100-01', devices: all8 }, ['llm-pretrain-0'], { count: 8, owner: 'llm-pretrain-0' }),
    // Inference: three single-GPU pods, and a claim two replicas share.
    claim('inference', 'embed-0-gpu-a1b2c', 'gpu.nvidia.com', { pool: 'dgx-h100-02', devices: ['gpu-0'] }, ['embed-0'], { owner: 'embed-0' }),
    claim('inference', 'embed-1-gpu-d3e4f', 'gpu.nvidia.com', { pool: 'dgx-h100-02', devices: ['gpu-1'] }, ['embed-1'], { owner: 'embed-1' }),
    claim('inference', 'rerank-0-gpu-g5h6i', 'gpu.nvidia.com', { pool: 'dgx-h100-02', devices: ['gpu-2'] }, ['rerank-0'], { owner: 'rerank-0' }),
    claim('inference', 'vllm-shared', 'gpu.nvidia.com', { pool: 'dgx-h100-02', devices: ['gpu-3'] }, ['vllm-a', 'vllm-b']),
    // A claim left allocated with nobody using it.
    claim('research', 'old-experiment', 'gpu.nvidia.com', { pool: 'dgx-h100-03', devices: ['gpu-0'] }, []),
    // MIG notebooks, and a bigger instance.
    ...[0, 1, 2, 3].map((k) =>
        claim('notebooks', `nb-${k}-gpu-m${k}`, 'mig.nvidia.com', { pool: 'dgx-a100-mig', devices: [`gpu-0-mig-1g10gb-19-${k}`] }, [`nb-${k}`], { owner: `nb-${k}` }),
    ),
    claim('research', 'protein-fold', 'mig.nvidia.com', { pool: 'dgx-a100-mig', devices: ['gpu-1-mig-3g40gb-9-0'] }, ['alphafold-0']),
    // The DRA example driver's demo.
    claim('dra-demo', 'single-gpu-pod-gpu-q8w7e', 'gpu.example.com', { pool: 'kind-worker', devices: ['gpu-0'], driver: 'gpu.example.com' }, ['single-gpu-pod'], { owner: 'single-gpu-pod' }),
    claim('dra-demo', 'two-gpu-pod-gpus-r5t6y', 'gpu.example.com', { pool: 'kind-worker', devices: ['gpu-1', 'gpu-2'], driver: 'gpu.example.com' }, ['two-gpu-pod'], {
        count: 2,
        owner: 'two-gpu-pod',
        entry: 'gpus',
    }),
    claim('dra-demo', 'shared-gpu', 'gpu.example.com', { pool: 'kind-worker', devices: ['gpu-3'], driver: 'gpu.example.com' }, ['shared-a', 'shared-b']),
    claim('dra-demo', 'too-many-gpus-pod-gpus-z9x8c', 'gpu.example.com', null, [], { count: 16, owner: 'too-many-gpus-pod', entry: 'gpus' }),
    claim('dra-demo', 'spare', 'gpu.example.com', null, []),
];

// ----- pods ------------------------------------------------------------------------------------

function pod(
    namespace: string,
    name: string,
    nodeName: string,
    options: { limits?: Record<string, string>; claims?: { name: string; claim?: string; template?: string; generated?: string }[]; pending?: string; created?: string } = {},
): Pod {
    const pending = options.pending !== undefined;
    return {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name, namespace, uid: `uid-${name}`, creationTimestamp: options.created ?? T0 },
        spec: {
            ...(pending ? {} : { nodeName }),
            containers: [
                {
                    name: 'main',
                    resources: {
                        ...(options.limits ? { limits: options.limits } : {}),
                        ...(options.claims ? { claims: options.claims.map((c) => ({ name: c.name })) } : {}),
                    },
                },
            ],
            ...(options.claims
                ? {
                      resourceClaims: options.claims.map((c) => (c.claim ? { name: c.name, resourceClaimName: c.claim } : { name: c.name, resourceClaimTemplateName: c.template ?? '' })),
                  }
                : {}),
        },
        status: {
            phase: pending ? 'Pending' : 'Running',
            conditions: pending
                ? [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: options.pending ?? '' }]
                : [
                      { type: 'PodScheduled', status: 'True' },
                      { type: 'Ready', status: 'True' },
                  ],
            ...(options.claims?.some((c) => c.generated) ? { resourceClaimStatuses: options.claims.filter((c) => c.generated).map((c) => ({ name: c.name, resourceClaimName: c.generated })) } : {}),
        },
    };
}

export const pods: Pod[] = [
    pod('training', 'llm-pretrain-0', 'dgx-h100-01', { claims: [{ name: 'gpu', template: 'h100-x8', generated: 'llm-pretrain-0-gpu-7xk2p' }] }),
    pod('inference', 'embed-0', 'dgx-h100-02', { claims: [{ name: 'gpu', template: 'h100-x1', generated: 'embed-0-gpu-a1b2c' }] }),
    pod('inference', 'embed-1', 'dgx-h100-02', { claims: [{ name: 'gpu', template: 'h100-x1', generated: 'embed-1-gpu-d3e4f' }] }),
    pod('inference', 'rerank-0', 'dgx-h100-02', { claims: [{ name: 'gpu', template: 'h100-x1', generated: 'rerank-0-gpu-g5h6i' }] }),
    pod('inference', 'vllm-a', 'dgx-h100-02', { claims: [{ name: 'gpu', claim: 'vllm-shared' }] }),
    pod('inference', 'vllm-b', 'dgx-h100-02', { claims: [{ name: 'gpu', claim: 'vllm-shared' }] }),
    ...[0, 1, 2, 3].map((k) => pod('notebooks', `nb-${k}`, 'dgx-a100-mig', { claims: [{ name: 'gpu', template: 'mig-1g', generated: `nb-${k}-gpu-m${k}` }] })),
    pod('research', 'alphafold-0', 'dgx-a100-mig', { claims: [{ name: 'gpu', claim: 'protein-fold' }] }),
    // The device-plugin path.
    pod('vision', 'detector-0', 'gpu-l4-01', { limits: { 'nvidia.com/gpu': '1' } }),
    pod('vision', 'detector-1', 'gpu-l4-01', { limits: { 'nvidia.com/gpu': '2' } }),
    pod('vision', 'ocr-0', 'gpu-a10-02', { limits: { 'nvidia.com/gpu': '1' } }),
    ...[0, 1, 2, 3, 4].map((k) => pod('dev', `jupyter-${k}`, 'gpu-t4-ts', { limits: { 'nvidia.com/gpu': '1' } })),
    pod('research', 'small-model-0', 'gpu-mig-dp', { limits: { 'nvidia.com/mig-1g.10gb': '1' } }),
    pod('research', 'small-model-1', 'gpu-mig-dp', { limits: { 'nvidia.com/mig-1g.10gb': '1' } }),
    pod('research', 'medium-model', 'gpu-mig-dp', { limits: { 'nvidia.com/mig-3g.40gb': '1' } }),
    pod('hpc', 'rocm-bench', 'mi300-01', { limits: { 'amd.com/gpu': '2' } }),
    // The DRA example driver's demo workloads (dev/manifests/dra-workloads.yaml).
    pod('dra-demo', 'single-gpu-pod', 'kind-worker', { claims: [{ name: 'gpu', template: 'single-gpu', generated: 'single-gpu-pod-gpu-q8w7e' }] }),
    pod('dra-demo', 'two-gpu-pod', 'kind-worker', { claims: [{ name: 'gpus', template: 'two-gpus', generated: 'two-gpu-pod-gpus-r5t6y' }] }),
    pod('dra-demo', 'shared-a', 'kind-worker', { claims: [{ name: 'gpu', claim: 'shared-gpu' }] }),
    pod('dra-demo', 'shared-b', 'kind-worker', { claims: [{ name: 'gpu', claim: 'shared-gpu' }] }),
    pod('dra-demo', 'too-many-gpus-pod', '', {
        claims: [{ name: 'gpus', template: 'too-many-gpus', generated: 'too-many-gpus-pod-gpus-z9x8c' }],
        pending: '0/11 nodes are available: 1 cannot allocate all claims, 10 node(s) had untolerated taint {kwok.x-k8s.io/node: fake}. preemption: 0/11 nodes are available: 11 Preemption is not helpful for scheduling.',
    }),
    // Waiting, and able to run once something frees up.
    pod('training', 'llama-finetune-3', '', {
        limits: { 'nvidia.com/gpu': '4' },
        pending: '0/11 nodes are available: 3 Insufficient nvidia.com/gpu, 1 node(s) were unschedulable, 7 node(s) didn\'t match Pod\'s node affinity/selector. preemption: 0/11 nodes are available: 3 No preemption victims found for incoming pod, 8 Preemption is not helpful for scheduling.',
        created: '2026-09-20T09:12:00Z',
    }),
    pod('notebooks', 'nb-7', '', {
        claims: [{ name: 'gpu', template: 'mig-1g' }],
        pending: '',
        created: '2026-09-20T09:30:00Z',
    }),
    // Finished pods let go of what they had, and are not counted.
    { ...pod('vision', 'batch-done', 'gpu-l4-01', { limits: { 'nvidia.com/gpu': '1' } }), status: { phase: 'Succeeded' } },
    pod('default', 'web-0', 'cpu-01'),
];

// The MIG notebook has no condition message yet; the scheduler's event carries it.
export const events: KubeEvent[] = [
    {
        apiVersion: 'v1',
        kind: 'Event',
        metadata: { name: 'nb-7.18a2', namespace: 'notebooks' },
        involvedObject: { kind: 'Pod', namespace: 'notebooks', name: 'nb-7' },
        reason: 'FailedScheduling',
        type: 'Warning',
        message: "0/11 nodes are available: 1 cannot allocate all claims, 10 node(s) didn't match Pod's node affinity/selector. preemption: 0/11 nodes are available: 11 Preemption is not helpful for scheduling.",
        lastTimestamp: '2026-09-20T09:31:00Z',
    },
];

// ----- the drivers --------------------------------------------------------------------------

function ds(namespace: string, name: string, desired: number, ready: number): DaemonSet {
    return {
        apiVersion: 'apps/v1',
        kind: 'DaemonSet',
        metadata: { name, namespace, labels: { app: name } },
        status: { desiredNumberScheduled: desired, numberReady: ready, numberAvailable: ready },
    };
}

export const daemonSets: DaemonSet[] = [
    ds('nvidia-dra-driver-gpu', 'nvidia-dra-driver-gpu-kubelet-plugin', 4, 4),
    ds('gpu-operator', 'nvidia-device-plugin-daemonset', 5, 4),
    ds('gpu-operator', 'gpu-feature-discovery', 8, 8),
    ds('gpu-operator', 'nvidia-dcgm-exporter', 8, 8),
    ds('dra-example-driver', 'dra-example-driver-kubeletplugin', 1, 1),
    ds('kube-system', 'kube-proxy', 11, 11),
];

/** Every list the pages read, by the kind the app names it with. */
export const LISTS: Record<string, unknown[]> = {
    nodes,
    pods,
    resourceslices: slices,
    resourceclaims: claims,
    resourceclaimtemplates: templates,
    deviceclasses: classes,
    daemonsets: daemonSets,
    events,
};

/** The objects the panels are drawn for, in the preview and the test. */
export const panelObjects = {
    node: nodes[3] as Node,
    pod: pods.find((p) => p.metadata.name === 'too-many-gpus-pod') as Pod,
    claim: claims.find((c) => c.metadata.name === 'vllm-shared') as ResourceClaim,
};

// ----- Prometheus -------------------------------------------------------------------------

/** Three hours of DCGM-shaped numbers, deterministic, for the charts on the dashboard. */
function series(name: string, base: number, swing: number, phase: number): K8sDockside.ChartSeries {
    const start = Date.parse('2026-09-20T05:00:00Z') / 1000;
    return {
        name,
        points: Array.from({ length: 37 }, (_, i) => ({ t: start + i * 300, v: Math.max(0, base + swing * Math.sin(i / 4 + phase) + (swing / 3) * Math.sin(i * 1.7 + phase)) })),
    };
}

function chart(id: string, label: string, unit: string, list: K8sDockside.ChartSeries[]): K8sDockside.Chart {
    return { pluginId: 'gpu', pluginName: 'GPU & Accelerators', id, label, unit, description: '', series: list, error: '' };
}

const source: K8sDockside.MetricsSource = {
    endpoint: { namespace: 'monitoring', service: 'prometheus-operated', port: 'web', path: '', url: '', source: 'label' },
    configured: '',
    available: true,
    error: '',
    describe: 'monitoring/prometheus-operated:9090',
};

/** What `charts()` answers with a DCGM exporter behind Prometheus. */
export const chartsPanel: K8sDockside.ChartsPanel = {
    attached: true,
    range: 180,
    source,
    charts: [
        chart('gpu-util', 'GPU utilisation, by model', 'percent', [series('H100 80GB HBM3', 0.62, 0.18, 0), series('A100-SXM4-80GB', 0.41, 0.15, 1), series('L4', 0.23, 0.12, 2)]),
        chart('gpu-memory', 'GPU memory used', 'bytes', [series('', 1.1e12, 1.8e11, 0.5)]),
        chart('gpu-memory-free', 'GPU memory free', 'bytes', [series('', 9.6e11, 1.8e11, 3.6)]),
        chart('gpu-power', 'Power draw (watts)', '', [series('', 9800, 1400, 1.2)]),
        chart('gpu-temp', 'Hottest GPU (°C)', '', [series('', 71, 5, 2.2)]),
    ],
};

/** What `charts()` answers on a cluster with no Prometheus at all. */
export const noPrometheus: K8sDockside.ChartsPanel = {
    attached: true,
    range: 180,
    source: { ...source, available: false, describe: '' },
    charts: [],
};

/** What `charts()` answers when Prometheus is there and DCGM is not. */
export const noDcgm: K8sDockside.ChartsPanel = {
    attached: true,
    range: 180,
    source,
    charts: chartsPanel.charts.map((c) => ({ ...c, series: [] })),
};

// ----- one machine, four H100 NVL, three models ----------------------------------------------
//
// A real-world shape: one node with four H100 NVL cards bridged in pairs
// (0–1 and 2–3, NV12), handed out by the device plugin, and three vLLM
// servers with a model each in memory -- one of them split over two cards
// with tensor parallelism. DCGM, scraped by Prometheus without honorLabels,
// names the pod on each card as exported_pod. The pods were created in an
// order that puts them on the wrong cards if they are placed by count, so
// a test can tell DCGM's word from the count.

const NVL_NODE = 'gpu-h100nvl-01';
const NVL_CARDS = [
    { index: '0', uuid: 'GPU-d1891b91-980f-4191-34f1-9b2046bf3af5', bus: '00000000:02:00.0', used: 86912 },
    { index: '1', uuid: 'GPU-4e451bfb-2162-d0f0-777c-51277748e36c', bus: '00000000:64:00.0', used: 86890 },
    { index: '2', uuid: 'GPU-5e83768b-5b44-7593-8d06-0a0bc7b22822', bus: '00000000:82:00.0', used: 85120 },
    { index: '3', uuid: 'GPU-7ecb082d-46c8-e7b2-8804-c2979adfe8fe', bus: '00000000:E3:00.0', used: 88064 },
];
const NVL_MEMORY_MIB = 95830;

function vllmPod(namespace: string, name: string, created: string, gpus: number, container: Container): Pod {
    return {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name, namespace, uid: `uid-${name}`, creationTimestamp: created, labels: { app: namespace } },
        spec: { nodeName: NVL_NODE, containers: [{ name: 'vllm', ...container, resources: { limits: { 'nvidia.com/gpu': String(gpus), memory: '64Gi' } } }] },
        status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
    };
}

export const nvlPods: Pod[] = [
    // The image's entrypoint is the API server; the model is a flag.
    vllmPod('vllm-gpt-oss-120b', 'vllm-gpt-oss-120b-67fcdc9f66-rz5j8', '2026-09-18T07:00:00Z', 1, {
        image: 'vllm/vllm-openai:v0.11.2',
        args: ['--model', 'openai/gpt-oss-120b', '--served-model-name', 'nhn-large', '--gpu-memory-utilization', '0.92', '--max-model-len', '131072'],
    }),
    // `vllm serve <model>`, with tensor parallelism over the NVLink pair.
    vllmPod('vllm-ornith-1-5-35b', 'vllm-ornith-1-5-35b-69c77dbfcc-89ffh', '2026-09-18T07:05:00Z', 2, {
        image: 'vllm/vllm-openai:v0.11.2',
        command: ['vllm', 'serve', 'ornith-ai/Ornith-1.5-35B-A3B-FP8'],
        args: ['--served-model-name=nhn-medium', '--tensor-parallel-size', '2', '--quantization', 'fp8'],
    }),
    // A shell script, with the model taken from the env.
    vllmPod('vllm-qwen3-8-27b', 'vllm-qwen3-8-27b-7cfd766d96-rxpmz', '2026-09-18T07:10:00Z', 1, {
        image: 'registry.internal/ai/vllm:0.11.2-cu128',
        command: ['/bin/sh', '-c'],
        args: ['exec vllm serve "$(MODEL)" --served-model-name nhn-coder --max-model-len 65536 --enable-auto-tool-choice'],
        env: [{ name: 'MODEL', value: 'Qwen/Qwen3.8-27B-FP8' }],
    }),
];

/** Which pod DCGM says each card is handed to, as in `nvidia-smi` and kubectl on the real machine. */
const NVL_HOLDERS: Record<string, Pod> = {
    '0': nvlPods[1] as Pod,
    '1': nvlPods[1] as Pod,
    '2': nvlPods[2] as Pod,
    '3': nvlPods[0] as Pod,
};

export const nvlNodes: Node[] = [
    node(NVL_NODE, gfd('NVIDIA-H100-NVL', NVL_MEMORY_MIB, 4, { 'nvidia.com/cuda.driver-version.full': '580.95.05', 'nvidia.com/cuda.runtime-version.full': '13.0' }), { 'nvidia.com/gpu': '4' }),
    node('cpu-01', {}),
];

export const nvlLists: Record<string, unknown[]> = {
    nodes: nvlNodes,
    pods: [...nvlPods, pods.find((p) => p.metadata.name === 'web-0') as Pod],
    resourceslices: [],
    resourceclaims: [],
    resourceclaimtemplates: [],
    deviceclasses: [],
    daemonsets: [ds('gpu-operator', 'nvidia-device-plugin-daemonset', 1, 1), ds('gpu-operator', 'nvidia-dcgm-exporter', 1, 1), ds('gpu-operator', 'gpu-feature-discovery', 1, 1)],
    events: [],
};

/** A series named the way the app names one from a chart with no legend: every label, sorted. */
function labelled(labels: Record<string, string>, value: number, end = Date.parse('2026-09-20T08:00:00Z') / 1000): K8sDockside.ChartSeries {
    const name = Object.entries(labels)
        .map(([k, v]) => `${k}=${v}`)
        .sort()
        .join(', ');
    return { name, points: [0, 1, 2].map((i) => ({ t: end - (2 - i) * 15, v: value })) };
}

function dcgmLabels(card: (typeof NVL_CARDS)[number], holder: Pod | undefined): Record<string, string> {
    return {
        DCGM_FI_DRIVER_VERSION: '580.95.05',
        Hostname: NVL_NODE,
        UUID: card.uuid,
        device: `nvidia${card.index}`,
        gpu: card.index,
        modelName: 'NVIDIA H100 NVL',
        pci_bus_id: card.bus,
        // Without honorLabels, the target's own labels keep the plain names...
        namespace: 'gpu-operator',
        pod: 'nvidia-dcgm-exporter-x7k2p',
        // ...and the pod DCGM maps the card to is renamed.
        ...(holder ? { exported_namespace: holder.metadata.namespace ?? '', exported_pod: holder.metadata.name, exported_container: 'vllm' } : {}),
    };
}

/** What `charts()` answers on that machine: the DCGM charts and the vLLM ones, as Prometheus has them. */
export function nvlCharts(options: { mapping?: boolean; stale?: boolean } = {}): K8sDockside.ChartsPanel {
    const mapping = options.mapping ?? true;
    const holder = (index: string) => (mapping ? NVL_HOLDERS[index] : undefined);
    const perCard = (value: (card: (typeof NVL_CARDS)[number]) => number) => NVL_CARDS.map((card) => labelled({ Hostname: NVL_NODE, UUID: card.uuid }, value(card)));
    const vllm = (value: (pod: Pod) => number) =>
        nvlPods.map((pod) => labelled({ namespace: pod.metadata.namespace ?? '', pod: pod.metadata.name, model_name: ['nhn-large', 'nhn-medium', 'nhn-coder'][nvlPods.indexOf(pod)] ?? '' }, value(pod)));
    const used = NVL_CARDS.map((card) => labelled(dcgmLabels(card, holder(card.index)), card.used));
    // A pod that was on GPU 2 an hour ago and is gone: its series stopped, and must not count.
    if (options.stale) used.push(labelled({ ...dcgmLabels(NVL_CARDS[2] as (typeof NVL_CARDS)[number], undefined), exported_namespace: 'old', exported_pod: 'gone-0' }, 1000, Date.parse('2026-09-20T07:00:00Z') / 1000));
    return {
        attached: true,
        range: 10,
        source,
        charts: [
            chart('gpu-util', 'GPU utilisation, by model', 'percent', [series('H100 NVL', 0.71, 0.1, 0)]),
            chart('data-dcgm-memory-used', 'Data: DCGM memory used, per card', '', used),
            chart('data-dcgm-util', 'Data: DCGM utilisation, per card', '', NVL_CARDS.map((card, i) => labelled(dcgmLabels(card, holder(card.index)), [64, 61, 38, 83][i] ?? 0))),
            chart('data-dcgm-memory-free', 'Data: DCGM memory free, per card', '', perCard((card) => NVL_MEMORY_MIB - card.used)),
            chart('data-dcgm-temperature', 'Data: DCGM temperature, per card', '', perCard((card) => 52 + Number(card.index) * 3)),
            chart('data-dcgm-power', 'Data: DCGM power, per card', '', perCard((card) => 240 + Number(card.index) * 20)),
            chart('data-vllm-running', 'Data: vLLM requests running', '', vllm((pod) => [7, 3, 12][nvlPods.indexOf(pod)] ?? 0)),
            chart('data-vllm-kv-cache', 'Data: vLLM KV cache in use', '', vllm((pod) => [0.41, 0.18, 0.66][nvlPods.indexOf(pod)] ?? 0)),
        ],
    };
}

// ----- the same machine, set up by hand -------------------------------------------------------
//
// What a cluster looks like when the GPUs were wired up outside the
// scheduler: the device plugin advertises 4 nvidia.com/gpu with no GPU
// feature discovery beside it, no Prometheus, and the model servers ask for
// no GPU at all -- they run with NVIDIA's runtime class and pick their cards
// with NVIDIA_VISIBLE_DEVICES. An Ollama server names none.

const BARE_NODE = 'talos-0uk-687';

function byHand(pod: Pod, visible: string | null): Pod {
    const container = pod.spec?.containers?.[0] ?? {};
    const env = [...(container.env ?? []), ...(visible === null ? [] : [{ name: 'NVIDIA_VISIBLE_DEVICES', value: visible }])];
    return {
        ...pod,
        spec: { ...pod.spec, nodeName: BARE_NODE, runtimeClassName: 'nvidia', containers: [{ ...container, env, resources: { limits: { memory: '64Gi' } } }] },
    };
}

export const barePods: Pod[] = [
    byHand(nvlPods[0] as Pod, '3'),
    byHand(nvlPods[1] as Pod, '0,1'),
    byHand(nvlPods[2] as Pod, 'GPU-5e83768b-5b44-7593-8d06-0a0bc7b22822'),
    byHand(
        {
            apiVersion: 'v1',
            kind: 'Pod',
            metadata: { name: 'ollama-5d8f7c9b4-kq2lm', namespace: 'ollama', uid: 'uid-ollama', creationTimestamp: '2026-09-18T08:00:00Z' },
            spec: { containers: [{ name: 'ollama', image: 'ollama/ollama:0.12.3' }] },
            status: { phase: 'Running' },
        },
        null,
    ),
];

export const bareLists: Record<string, unknown[]> = {
    nodes: [node(BARE_NODE, { 'node-role.kubernetes.io/worker': '' }, { 'nvidia.com/gpu': '4' })],
    pods: barePods,
    daemonsets: [ds('kube-system', 'nvidia-device-plugin', 1, 1)],
    events: [],
};
