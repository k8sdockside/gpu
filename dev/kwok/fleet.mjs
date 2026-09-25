// The KWOK fleet: fake GPU nodes, written out as Kubernetes objects.
//
//   node dev/kwok/fleet.mjs yaml      the manifests (what dev/manifests/kwok-fleet.yaml holds)
//   node dev/kwok/fleet.mjs status    one line per node: its name, then a status patch as JSON
//
// KWOK makes a Node object behave like a machine -- it keeps it Ready and
// runs whatever is scheduled onto it -- without a kubelet or a container. So
// nothing here needs a GPU: a node's GPUs are whatever its status says
// (device-plugin path) or whatever a ResourceSlice naming it lists (DRA path),
// and the real scheduler hands them out.
//
// What it builds:
//
//   h100-node-1..6   8 × "NVIDIA H100 80GB HBM3" each, through DRA, with the
//                    attributes NVIDIA's DRA driver publishes (type, uuid,
//                    productName, architecture, driverVersion,
//                    cudaDriverVersion ...) and GFD-style labels.
//   a100-mig-node    4 × A100 80GB through DRA with static MIG: gpu-0 in seven
//                    1g.10gb instances, gpu-1 in 3g.40gb + 2 × 2g.20gb, two
//                    whole. Instance names and attributes follow the NVIDIA
//                    driver's (gpu-<minor>-mig-<profile>-<profileId>-<start>,
//                    `parentUUID`, `profile`).
//   l4-node-1, -2    4 × L4 through the device plugin (nvidia.com/gpu in the
//                    node's status); l4-node-2 has lost one (allocatable 3).
//   t4-ts-node       2 × T4 time-sliced 4 ways: nvidia.com/gpu is 8, with
//                    GFD's replicas and sharing-strategy labels.
//
// and the DeviceClasses gpu.nvidia.com and mig.nvidia.com with the CEL
// selectors NVIDIA's chart installs, plus workloads in namespace gpu-fleet.
//
// Nothing here is read from a real driver: the attribute names are checked
// against github.com/NVIDIA/k8s-dra-driver-gpu (cmd/gpu-kubelet-plugin) and
// the labels against gpu-feature-discovery, but the values are made up.

const TAINT = { key: 'kwok.x-k8s.io/node', value: 'fake', effect: 'NoSchedule' };

function uuid(node, i) {
    let h = 2166136261;
    for (const c of `${node}/${i}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    const x = h.toString(16).padStart(8, '0');
    return `GPU-${x}-${x.slice(0, 4)}-4${x.slice(1, 4)}-a${x.slice(2, 5)}-${x}${x.slice(4, 8)}`;
}

function gfd(product, memoryMiB, count, extra = {}) {
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
        ...extra,
    };
}

/** The fleet's nodes: name, labels, and the extended resources in their status. */
const NODES = [
    ...[1, 2, 3, 4, 5, 6].map((n) => ({ name: `h100-node-${n}`, labels: gfd('NVIDIA-H100-80GB-HBM3', 81559, 8), capacity: {}, allocatable: {} })),
    { name: 'a100-mig-node', labels: gfd('NVIDIA-A100-SXM4-80GB', 81920, 4, { 'nvidia.com/mig.capable': 'true' }), capacity: {}, allocatable: {} },
    { name: 'l4-node-1', labels: gfd('NVIDIA-L4', 23034, 4), capacity: { 'nvidia.com/gpu': '4' }, allocatable: { 'nvidia.com/gpu': '4' } },
    { name: 'l4-node-2', labels: gfd('NVIDIA-L4', 23034, 4), capacity: { 'nvidia.com/gpu': '4' }, allocatable: { 'nvidia.com/gpu': '3' } },
    {
        name: 't4-ts-node',
        labels: gfd('NVIDIA-Tesla-T4-SHARED', 15360, 2, { 'nvidia.com/gpu.replicas': '4', 'nvidia.com/gpu.sharing-strategy': 'time-slicing' }),
        capacity: { 'nvidia.com/gpu': '8' },
        allocatable: { 'nvidia.com/gpu': '8' },
    },
];

function node(n) {
    const { name, labels } = n;
    return {
        apiVersion: 'v1',
        kind: 'Node',
        metadata: {
            name,
            annotations: { 'node.alpha.kubernetes.io/ttl': '0', 'kwok.x-k8s.io/node': 'fake' },
            labels: {
                'kubernetes.io/arch': 'amd64',
                'kubernetes.io/os': 'linux',
                'kubernetes.io/hostname': name,
                'kubernetes.io/role': 'agent',
                'node-role.kubernetes.io/agent': '',
                type: 'kwok',
                ...labels,
            },
        },
        spec: { taints: [TAINT] },
        status: status(n),
    };
}

function status(n) {
    const base = { cpu: '128', memory: '2Ti', pods: '110' };
    return {
        capacity: { ...base, ...n.capacity },
        allocatable: { ...base, ...n.allocatable },
        nodeInfo: { architecture: 'amd64', kubeletVersion: 'fake', kubeProxyVersion: 'fake', operatingSystem: 'linux' },
        phase: 'Running',
    };
}

// ----- DRA ---------------------------------------------------------------------------

const s = (v) => ({ string: v });
const v = (x) => ({ version: x });

function gpu(nodeName, minor, product, memory, extra = {}) {
    return {
        name: `gpu-${minor}`,
        attributes: {
            type: s('gpu'),
            uuid: s(uuid(nodeName, minor)),
            productName: s(product),
            brand: s('Nvidia'),
            architecture: s(product.includes('A100') ? 'Ampere' : 'Hopper'),
            cudaComputeCapability: v(product.includes('A100') ? '8.0.0' : '9.0.0'),
            driverVersion: v('570.124.6'),
            cudaDriverVersion: v('12.8.0'),
            'resource.kubernetes.io/pcieRoot': s(`pci0000:${minor < 4 ? '00' : '80'}`),
        },
        capacity: { memory: { value: memory } },
        ...extra,
    };
}

function mig(nodeName, parent, profile, profileId, start, memory, sms) {
    return {
        name: `gpu-${parent}-mig-${profile.replace('.', '')}-${profileId}-${start}`,
        attributes: {
            type: s('mig'),
            uuid: s(`MIG-${uuid(nodeName, parent * 100 + start).slice(4)}`),
            parentUUID: s(uuid(nodeName, parent)),
            profile: s(profile),
            productName: s('NVIDIA A100-SXM4-80GB'),
            brand: s('Nvidia'),
            architecture: s('Ampere'),
            cudaComputeCapability: v('8.0.0'),
            driverVersion: v('570.124.6'),
            cudaDriverVersion: v('12.8.0'),
        },
        capacity: { memory: { value: memory }, multiprocessors: { value: String(sms) } },
    };
}

function slice(nodeName, devices) {
    return {
        apiVersion: 'resource.k8s.io/v1',
        kind: 'ResourceSlice',
        metadata: { name: `${nodeName}-gpu.nvidia.com` },
        spec: { driver: 'gpu.nvidia.com', nodeName, pool: { name: nodeName, generation: 1, resourceSliceCount: 1 }, devices },
    };
}

const SLICES = [
    ...[1, 2, 3, 4, 5, 6].map((n) => slice(`h100-node-${n}`, Array.from({ length: 8 }, (_, i) => gpu(`h100-node-${n}`, i, 'NVIDIA H100 80GB HBM3', '81559Mi')))),
    slice('a100-mig-node', [
        ...[0, 1, 2, 3, 4, 5, 6].map((k) => mig('a100-mig-node', 0, '1g.10gb', 19, k, '9728Mi', 14)),
        mig('a100-mig-node', 1, '3g.40gb', 9, 0, '40192Mi', 42),
        mig('a100-mig-node', 1, '2g.20gb', 14, 4, '19968Mi', 28),
        mig('a100-mig-node', 1, '2g.20gb', 14, 6, '19968Mi', 28),
        gpu('a100-mig-node', 2, 'NVIDIA A100-SXM4-80GB', '81920Mi'),
        gpu('a100-mig-node', 3, 'NVIDIA A100-SXM4-80GB', '81920Mi'),
    ]),
];

const CLASSES = [
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
];

// ----- workloads ------------------------------------------------------------------------

const NS = 'gpu-fleet';

function template(name, deviceClass, count = 1, cel = '') {
    return {
        apiVersion: 'resource.k8s.io/v1',
        kind: 'ResourceClaimTemplate',
        metadata: { namespace: NS, name },
        spec: { spec: { devices: { requests: [{ name: 'gpu', exactly: { deviceClassName: deviceClass, allocationMode: 'ExactCount', count, ...(cel ? { selectors: [{ cel: { expression: cel } }] } : {}) } }] } } },
    };
}

function pod(name, { template: t, claim, limits, selector = {} } = {}) {
    return {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { namespace: NS, name },
        spec: {
            nodeSelector: { type: 'kwok', ...selector },
            tolerations: [{ key: TAINT.key, operator: 'Exists', effect: 'NoSchedule' }],
            containers: [{ name: 'main', image: 'fake-image', resources: { ...(limits ? { limits } : {}), ...(t || claim ? { claims: [{ name: 'gpu' }] } : {}) } }],
            ...(t ? { resourceClaims: [{ name: 'gpu', resourceClaimTemplateName: t }] } : {}),
            ...(claim ? { resourceClaims: [{ name: 'gpu', resourceClaimName: claim }] } : {}),
        },
    };
}

const L4 = { 'nvidia.com/gpu.product': 'NVIDIA-L4' };
const T4 = { 'nvidia.com/gpu.product': 'NVIDIA-Tesla-T4-SHARED' };

const WORKLOADS = [
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: NS } },
    template('h100-x8', 'gpu.nvidia.com', 8),
    template('h100-x1', 'gpu.nvidia.com', 1),
    template('h100-x16', 'gpu.nvidia.com', 16),
    template('mig-1g', 'mig.nvidia.com', 1, "device.attributes['gpu.nvidia.com'].profile == '1g.10gb'"),
    {
        apiVersion: 'resource.k8s.io/v1',
        kind: 'ResourceClaim',
        metadata: { namespace: NS, name: 'vllm-shared' },
        spec: { devices: { requests: [{ name: 'gpu', exactly: { deviceClassName: 'gpu.nvidia.com' } }] } },
    },
    // Two whole nodes of H100s for training.
    pod('llm-pretrain-0', { template: 'h100-x8' }),
    pod('llm-pretrain-1', { template: 'h100-x8' }),
    // Inference, one GPU each, and two replicas sharing one.
    ...[0, 1, 2, 3, 4].map((k) => pod(`embed-${k}`, { template: 'h100-x1' })),
    pod('vllm-a', { claim: 'vllm-shared' }),
    pod('vllm-b', { claim: 'vllm-shared' }),
    // MIG notebooks.
    ...[0, 1, 2, 3].map((k) => pod(`notebook-${k}`, { template: 'mig-1g' })),
    // The device plugin path.
    pod('detector-0', { limits: { 'nvidia.com/gpu': '1' }, selector: L4 }),
    pod('detector-1', { limits: { 'nvidia.com/gpu': '2' }, selector: L4 }),
    pod('ocr-0', { limits: { 'nvidia.com/gpu': '2' }, selector: L4 }),
    ...[0, 1, 2, 3, 4].map((k) => pod(`jupyter-${k}`, { limits: { 'nvidia.com/gpu': '1' }, selector: T4 })),
    // Waiting: four L4s wanted, three free across two nodes.
    pod('llama-finetune', { limits: { 'nvidia.com/gpu': '4' }, selector: L4 }),
    // Never: sixteen H100s on one node, and no node has more than eight.
    pod('too-big-to-fit', { template: 'h100-x16' }),
];

// ----- out --------------------------------------------------------------------------------

/** YAML without a dependency: every value here is a plain string, number, boolean, array or object. */
function yaml(value, indent = '') {
    if (Array.isArray(value)) {
        if (value.length === 0) return ' []';
        return value.map((item) => `\n${indent}-${block(item, `${indent}  `).replace(/^\n\s*/, ' ')}`).join('');
    }
    if (value && typeof value === 'object') {
        const entries = Object.entries(value);
        if (entries.length === 0) return ' {}';
        return entries.map(([k, v]) => `\n${indent}${key(k)}:${block(v, `${indent}  `)}`).join('');
    }
    return ` ${scalar(value)}`;
}

function block(value, indent) {
    return yaml(value, indent);
}

function key(k) {
    return /^[A-Za-z0-9_.\/-]+$/.test(k) ? k : JSON.stringify(k);
}

function scalar(value) {
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    const text = String(value);
    // Quote anything YAML could read as something other than a string.
    return /^[A-Za-z_][A-Za-z0-9_.\/-]*$/.test(text) && !/^(true|false|yes|no|on|off|null)$/i.test(text) ? text : JSON.stringify(text);
}

const command = process.argv[2] ?? 'yaml';
if (command === 'yaml') {
    const header = [
        '# Generated by dev/kwok/fleet.mjs -- edit that, then: node dev/kwok/fleet.mjs yaml > dev/manifests/kwok-fleet.yaml',
        '# A fleet of fake GPU nodes for KWOK. Applied by dev/kwok-fleet.sh, which also patches the',
        "# nodes' status with their GPUs (kubectl apply does not write a Node's status on update).",
    ].join('\n');
    const docs = [...NODES.map(node), ...CLASSES, ...SLICES, ...WORKLOADS];
    process.stdout.write(`${header}\n${docs.map((d) => `---${yaml(d)}\n`).join('')}`);
} else if (command === 'status') {
    for (const n of NODES) process.stdout.write(`${n.name} ${JSON.stringify({ status: status(n) })}\n`);
} else {
    console.error('usage: node dev/kwok/fleet.mjs yaml|status');
    process.exit(2);
}
