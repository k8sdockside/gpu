import { describe, expect, it } from 'vitest';
import * as fixtures from '../fixtures.js';
import { buildInventory, type Unit } from './inventory.js';
import type { Device, Node, Pod, ResourceClaim, ResourceSlice } from './kube.js';

// ----- small builders -----------------------------------------------------------------

function node(name: string, capacity: Record<string, string> = {}, allocatable = capacity, labels: Record<string, string> = {}): Node {
    return { metadata: { name, labels }, status: { capacity, allocatable, conditions: [{ type: 'Ready', status: 'True' }] } };
}

function pod(name: string, nodeName: string, limits: Record<string, string>, phase = 'Running', created = '2026-01-01T00:00:00Z'): Pod {
    return { metadata: { name, namespace: 'ns', creationTimestamp: created }, spec: { nodeName, containers: [{ name: 'c', resources: { limits } }] }, status: { phase } };
}

function slice(nodeName: string, devices: Device[], driver = 'gpu.nvidia.com'): ResourceSlice {
    return { metadata: { name: `${nodeName}-slice` }, spec: { driver, nodeName, pool: { name: nodeName, generation: 1 }, devices } };
}

function gpu(i: number, extra: Partial<Device> = {}): Device {
    return { name: `gpu-${i}`, attributes: { type: { string: 'gpu' }, uuid: { string: `GPU-${i}` }, productName: { string: 'NVIDIA H100 80GB HBM3' } }, capacity: { memory: { value: '81559Mi' } }, ...extra };
}

function claim(name: string, pool: string, devices: string[], pods: string[], driver = 'gpu.nvidia.com'): ResourceClaim {
    return {
        metadata: { name, namespace: 'ns' },
        spec: {},
        status: { allocation: { devices: { results: devices.map((device) => ({ request: 'gpu', driver, pool, device })) } }, reservedFor: pods.map((p) => ({ resource: 'pods', name: p })) },
    };
}

const empty = { nodes: [] as Node[], pods: [] as Pod[], slices: [] as ResourceSlice[], claims: [] as ResourceClaim[] };
const states = (units: Unit[]) => units.map((u) => u.state);

// ----- the device plugin --------------------------------------------------------------

describe('the device plugin path', () => {
    it('makes one unit per advertised GPU and puts pods on them by count', () => {
        const inv = buildInventory({ ...empty, nodes: [node('n', { 'nvidia.com/gpu': '4' })], pods: [pod('a', 'n', { 'nvidia.com/gpu': '1' }), pod('b', 'n', { 'nvidia.com/gpu': '2' })] });
        expect(states(inv.units)).toEqual(['allocated', 'allocated', 'allocated', 'free']);
        expect(inv.units.every((u) => u.inferred)).toBe(true);
        expect(inv.totals).toMatchObject({ total: 4, inUse: 3, free: 1 });
    });

    it('does not count pods that have finished', () => {
        const inv = buildInventory({ ...empty, nodes: [node('n', { 'nvidia.com/gpu': '2' })], pods: [pod('done', 'n', { 'nvidia.com/gpu': '2' }, 'Succeeded')] });
        expect(inv.totals.inUse).toBe(0);
    });

    it('draws a GPU the device plugin dropped from allocatable as unhealthy, and puts nobody on it', () => {
        const inv = buildInventory({ ...empty, nodes: [node('n', { 'nvidia.com/gpu': '4' }, { 'nvidia.com/gpu': '3' })], pods: [pod('a', 'n', { 'nvidia.com/gpu': '3' })] });
        expect(states(inv.units)).toEqual(['allocated', 'allocated', 'allocated', 'unhealthy']);
        expect(inv.units[3]?.problem).toContain('1 of 4');
        expect(inv.totals.unhealthy).toBe(1);
    });

    it('divides time-slicing replicas back out into physical cards with slots', () => {
        const labels = { 'nvidia.com/gpu.replicas': '4', 'nvidia.com/gpu.sharing-strategy': 'time-slicing', 'nvidia.com/gpu.product': 'NVIDIA-Tesla-T4-SHARED' };
        const inv = buildInventory({
            ...empty,
            nodes: [node('n', { 'nvidia.com/gpu': '8' }, { 'nvidia.com/gpu': '8' }, labels)],
            pods: [pod('a', 'n', { 'nvidia.com/gpu': '1' }), pod('b', 'n', { 'nvidia.com/gpu': '1' }), pod('c', 'n', { 'nvidia.com/gpu': '1' })],
        });
        expect(inv.units).toHaveLength(2);
        expect(inv.units[0]).toMatchObject({ slots: 4, sharing: 'time-slicing', model: 'Tesla T4' });
        // Spread over the least-used card first: a, c on card 0 and b on card 1.
        expect(states(inv.units)).toEqual(['shared', 'allocated']);
    });

    it('packs MIG instances of mixed strategy onto as few GPUs as their slices fit', () => {
        const inv = buildInventory({
            ...empty,
            nodes: [node('n', { 'nvidia.com/mig-3g.40gb': '2', 'nvidia.com/mig-1g.10gb': '3' }, undefined, { 'nvidia.com/gpu.product': 'NVIDIA-H100-80GB-HBM3' })],
            pods: [pod('a', 'n', { 'nvidia.com/mig-1g.10gb': '1' })],
        });
        // 3 + 3 + 1 = 7 slices on the first card, the last two 1g on a second.
        expect(inv.units).toHaveLength(2);
        expect(inv.units[0]?.partitions.map((p) => p.profile)).toEqual(['3g.40gb', '3g.40gb', '1g.10gb']);
        expect(inv.units[0]?.slices).toBe(7);
        expect(inv.units[0]?.state).toBe('partial');
        expect(inv.units[0]?.vendor).toBe('nvidia');
        expect(inv.totals).toMatchObject({ total: 2, partitions: 5, partitionsInUse: 1 });
    });

    it('reads mig.strategy=single, where plain nvidia.com/gpu hands out MIG instances', () => {
        const labels = { 'nvidia.com/mig.strategy': 'single', 'nvidia.com/gpu.product': 'NVIDIA-A100-SXM4-40GB-MIG-1g.5gb' };
        const inv = buildInventory({ ...empty, nodes: [node('n', { 'nvidia.com/gpu': '14' }, undefined, labels)] });
        expect(inv.units).toHaveLength(2);
        expect(inv.units.flatMap((u) => u.partitions)).toHaveLength(14);
        expect(inv.units[0]?.model).toBe('A100 SXM4 40GB');
    });

    it('counts Neuron devices once when both of their names are advertised', () => {
        const inv = buildInventory({ ...empty, nodes: [node('n', { 'aws.amazon.com/neuron': '4', 'aws.amazon.com/neurondevice': '4', 'aws.amazon.com/neuroncore': '8' })] });
        expect(inv.units).toHaveLength(4);
    });

    it('ignores Intel s millicores, which are not devices', () => {
        const inv = buildInventory({ ...empty, nodes: [node('n', { 'gpu.intel.com/i915': '1', 'gpu.intel.com/millicores': '1000' })] });
        expect(inv.units).toHaveLength(1);
    });
});

// ----- DRA ------------------------------------------------------------------------------

describe('the DRA path', () => {
    it('makes one unit per device and marks what claims hold', () => {
        const inv = buildInventory({ ...empty, nodes: [node('n')], slices: [slice('n', [gpu(0), gpu(1), gpu(2)])], claims: [claim('c', 'n', ['gpu-1'], ['p'])] });
        expect(states(inv.units)).toEqual(['free', 'allocated', 'free']);
        expect(inv.units[1]?.consumers).toEqual([{ namespace: 'ns', pod: 'p', claim: 'c' }]);
        expect(inv.units[1]).toMatchObject({ model: 'H100 80GB HBM3', inferred: false, source: 'dra' });
    });

    it('calls a device shared when two pods use one claim', () => {
        const inv = buildInventory({ ...empty, slices: [slice('n', [gpu(0)])], claims: [claim('c', 'n', ['gpu-0'], ['a', 'b'])] });
        expect(inv.units[0]?.state).toBe('shared');
        expect(inv.totals.shared).toBe(1);
    });

    it('calls a device allocated when a claim holds it with no pod', () => {
        const inv = buildInventory({ ...empty, slices: [slice('n', [gpu(0)])], claims: [claim('c', 'n', ['gpu-0'], [])] });
        expect(inv.units[0]?.state).toBe('allocated');
        expect(inv.units[0]?.claims).toEqual([{ namespace: 'ns', name: 'c' }]);
    });

    it('ignores admin access, which lets a monitor look without taking the device', () => {
        const c = claim('c', 'n', ['gpu-0'], ['monitor']);
        c.status!.allocation!.devices!.results![0]!.adminAccess = true;
        const inv = buildInventory({ ...empty, slices: [slice('n', [gpu(0)])], claims: [c] });
        expect(inv.units[0]?.state).toBe('free');
    });

    it('draws a device its driver tainted as unhealthy', () => {
        const inv = buildInventory({ ...empty, slices: [slice('n', [gpu(0, { taints: [{ key: 'xid', value: '79', effect: 'NoSchedule' }] })])] });
        expect(inv.units[0]?.state).toBe('unhealthy');
        expect(inv.units[0]?.problem).toContain('xid=79:NoSchedule');
    });

    it('makes a static MIG instance a cell of the GPU its parentUUID names', () => {
        const instance = (k: number): Device => ({
            name: `gpu-0-mig-1g10gb-19-${k}`,
            attributes: { type: { string: 'mig' }, parentUUID: { string: 'GPU-0' }, profile: { string: '1g.10gb' }, productName: { string: 'NVIDIA A100-SXM4-80GB' } },
        });
        const inv = buildInventory({ ...empty, slices: [slice('n', [gpu(0), instance(0), instance(1)])], claims: [claim('c', 'n', ['gpu-0-mig-1g10gb-19-1'], ['p'])] });
        expect(inv.units).toHaveLength(1);
        expect(inv.units[0]?.partitions.map((p) => p.state)).toEqual(['free', 'allocated']);
        expect(inv.units[0]?.state).toBe('partial');
        expect(inv.units[0]?.slices).toBe(7);
    });

    it('makes up the GPU when the driver lists only its MIG instances', () => {
        const instance: Device = { name: 'gpu-3-mig-7g80gb-0-0', attributes: { type: { string: 'mig' }, parentUUID: { string: 'GPU-X' }, profile: { string: '7g.80gb' }, productName: { string: 'NVIDIA A100-SXM4-80GB' } } };
        const inv = buildInventory({ ...empty, slices: [slice('n', [instance])], claims: [claim('c', 'n', ['gpu-3-mig-7g80gb-0-0'], ['p'])] });
        expect(inv.units).toHaveLength(1);
        expect(inv.units[0]).toMatchObject({ name: 'gpu-3', label: '3', model: 'A100 SXM4 80GB' });
        // One 7g instance is the whole card.
        expect(inv.units[0]?.state).toBe('allocated');
    });

    it('counts a partitionable card once, whatever it could be carved into', () => {
        const counters = [{ counterSet: 'gpu-0-counters' }];
        const whole = gpu(0, { consumesCounters: counters });
        const carvings: Device[] = [0, 1, 2].map((k) => ({
            name: `gpu-0-mig-1g10gb-${k}`,
            attributes: { type: { string: 'mig' }, profile: { string: '1g.10gb' } },
            consumesCounters: counters,
        }));
        const inv = buildInventory({ ...empty, slices: [slice('n', [whole, ...carvings])], claims: [claim('c', 'n', ['gpu-0-mig-1g10gb-1'], ['p'])] });
        expect(inv.units).toHaveLength(1);
        // Only the carving actually allocated is drawn.
        expect(inv.units[0]?.partitions.map((p) => p.name)).toEqual(['gpu-0-mig-1g10gb-1']);
        expect(inv.units[0]?.state).toBe('partial');
    });

    it('leaves NVIDIA compute-domain channels out', () => {
        const inv = buildInventory({ ...empty, slices: [slice('n', [{ name: 'channel-0' }], 'compute-domain.nvidia.com')] });
        expect(inv.units).toHaveLength(0);
    });
});

// ----- both at once --------------------------------------------------------------------

describe('both paths on one node', () => {
    it('counts the cards once, from DRA, and says why', () => {
        const inv = buildInventory({ ...empty, nodes: [node('n', { 'nvidia.com/gpu': '2' })], slices: [slice('n', [gpu(0), gpu(1)])] });
        expect(inv.totals.total).toBe(2);
        expect(inv.units.every((u) => u.source === 'dra')).toBe(true);
        expect(inv.nodes[0]?.notes[0]).toContain('counted once, from DRA');
    });

    it('still counts another vendor s device plugin on the same node', () => {
        const inv = buildInventory({ ...empty, nodes: [node('n', { 'amd.com/gpu': '1' })], slices: [slice('n', [gpu(0)])] });
        expect(inv.totals.total).toBe(2);
    });
});

// ----- the fixture cluster ------------------------------------------------------------------

describe('the fixture cluster', () => {
    const inv = buildInventory(fixtures);

    it('adds up to what the preview shows', () => {
        expect(inv.totals).toMatchObject({ total: 55, inUse: 28, unhealthy: 2, shared: 4 });
        expect(inv.totals.free).toBe(inv.totals.total - inv.totals.inUse - inv.totals.unhealthy);
    });

    it('groups by model with the same card from DRA and from GFD together', () => {
        const h100 = inv.byModel.find((t) => t.label === 'H100 80GB HBM3');
        expect(h100?.total).toBe(25);
        expect(inv.byVendor.map((t) => t.label)).toContain('Simulated (example driver)');
    });

    it('ignores the stale slice dgx-h100-03 left behind', () => {
        expect(inv.nodes.find((n) => n.name === 'dgx-h100-03')?.units).toHaveLength(8);
    });

    it('leaves out nodes with no accelerators', () => {
        expect(inv.nodes.map((n) => n.name)).not.toContain('cpu-01');
    });
});
