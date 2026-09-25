import { describe, expect, it } from 'vitest';
import { attributeText, claimOwnerPod, claimState, classDeviceType, classDriver, deviceMemory, deviceModel, requestedDevices, requestsOf, reservedPods, shortName, sliceDevices } from './dra.js';
import type { ResourceClaim, ResourceSlice } from './kube.js';

function slice(name: string, pool: string, generation: number, devices: NonNullable<ResourceSlice['spec']>['devices'], node = pool): ResourceSlice {
    return { metadata: { name }, spec: { driver: 'gpu.nvidia.com', nodeName: node, pool: { name: pool, generation, resourceSliceCount: 1 }, devices } };
}

describe('devices from slices', () => {
    it('reads v1 devices, with attributes by their short name', () => {
        const [device] = sliceDevices([
            slice('s', 'node-a', 1, [{ name: 'gpu-0', attributes: { productName: { string: 'NVIDIA H100 80GB HBM3' }, 'gpu.nvidia.com/uuid': { string: 'GPU-1' }, index: { int: 0 } }, capacity: { memory: { value: '80Gi' } } }]),
        ]);
        expect(device?.node).toBe('node-a');
        expect(device?.attributes['uuid']).toBe('GPU-1');
        expect(device?.attributes['index']).toBe('0');
        expect(deviceModel(device!)).toBe('NVIDIA H100 80GB HBM3');
        expect(deviceMemory(device!)).toBe(80 * 1024 ** 3);
    });

    it('reads v1beta1 devices, which nest everything under basic', () => {
        const [device] = sliceDevices([slice('s', 'node-a', 1, [{ name: 'gpu-0', basic: { attributes: { model: { string: 'LATEST-GPU-MODEL' } }, capacity: { memory: { value: '80Gi' } } } }])]);
        expect(deviceModel(device!)).toBe('LATEST-GPU-MODEL');
        expect(deviceMemory(device!)).toBe(80 * 1024 ** 3);
    });

    it('ignores the slices of a pool s older generation, so nothing is counted twice', () => {
        const devices = sliceDevices([
            slice('old', 'node-a', 3, [{ name: 'gpu-0' }, { name: 'gpu-1' }]),
            slice('new', 'node-a', 4, [{ name: 'gpu-0' }, { name: 'gpu-1' }]),
        ]);
        expect(devices.map((d) => d.slice)).toEqual(['new', 'new']);
    });

    it('keeps every slice of a pool spread over several', () => {
        const devices = sliceDevices([slice('a', 'pool', 2, [{ name: 'gpu-0' }]), slice('b', 'pool', 2, [{ name: 'gpu-1' }])]);
        expect(devices).toHaveLength(2);
    });

    it('sorts gpu-10 after gpu-9', () => {
        const devices = sliceDevices([slice('s', 'n', 1, [{ name: 'gpu-10' }, { name: 'gpu-9' }, { name: 'gpu-1' }])]);
        expect(devices.map((d) => d.name)).toEqual(['gpu-1', 'gpu-9', 'gpu-10']);
    });

    it('notes a NoSchedule taint and the counter sets a device draws on', () => {
        const [device] = sliceDevices([slice('s', 'n', 1, [{ name: 'gpu-0', taints: [{ key: 'xid', value: '79', effect: 'NoSchedule' }], consumesCounters: [{ counterSet: 'gpu-0-counters' }] }])]);
        expect(device?.tainted).toBe('xid=79:NoSchedule');
        expect(device?.counterSets).toEqual(['gpu-0-counters']);
    });

    it('writes every attribute type as text', () => {
        expect(attributeText({ version: '12.8.0' })).toBe('12.8.0');
        expect(attributeText({ bool: false })).toBe('false');
        expect(attributeText({ int: 7 })).toBe('7');
        expect(attributeText(undefined)).toBe('');
        expect(shortName('gpu.nvidia.com/type', 'gpu.nvidia.com')).toBe('type');
        expect(shortName('resource.kubernetes.io/pcieRoot', 'gpu.nvidia.com')).toBe('resource.kubernetes.io/pcieRoot');
    });
});

describe('claims', () => {
    const base = (status: ResourceClaim['status'] = {}): ResourceClaim => ({ metadata: { name: 'c', namespace: 'ns' }, spec: {}, status });

    it('read requests in v1 s shape and in v1beta1 s', () => {
        expect(requestsOf({ devices: { requests: [{ name: 'gpu', exactly: { deviceClassName: 'gpu.nvidia.com', count: 2 } }] } })[0]).toMatchObject({ deviceClass: 'gpu.nvidia.com', count: 2 });
        expect(requestsOf({ devices: { requests: [{ name: 'gpu', deviceClassName: 'gpu.example.com' }] } })[0]).toMatchObject({ deviceClass: 'gpu.example.com', count: 1 });
    });

    it('read a prioritised list as its first choice, with the rest as alternatives', () => {
        const [request] = requestsOf({ devices: { requests: [{ name: 'gpu', firstAvailable: [{ name: 'big', deviceClassName: 'gpu.nvidia.com' }, { name: 'small', deviceClassName: 'mig.nvidia.com' }] }] } });
        expect(request).toMatchObject({ deviceClass: 'gpu.nvidia.com', alternatives: ['mig.nvidia.com'] });
    });

    it('add up what they ask for, keeping "all" and admin access apart', () => {
        const requests = requestsOf({
            devices: {
                requests: [
                    { name: 'a', exactly: { deviceClassName: 'x', count: 2 } },
                    { name: 'b', exactly: { deviceClassName: 'x', allocationMode: 'All' } },
                    { name: 'c', exactly: { deviceClassName: 'x', adminAccess: true } },
                ],
            },
        });
        expect(requestedDevices(requests)).toEqual({ count: 2, all: true });
    });

    it('have kubectl s states', () => {
        expect(claimState(base())).toBe('pending');
        expect(claimState(base({ allocation: { devices: { results: [] } } }))).toBe('allocated');
        expect(claimState(base({ allocation: {}, reservedFor: [{ resource: 'pods', name: 'p' }] }))).toBe('reserved');
        expect(claimState({ ...base(), metadata: { name: 'c', deletionTimestamp: '2026-01-01T00:00:00Z' } })).toBe('deleting');
    });

    it('say which pods they are reserved for, and which pod they were made for', () => {
        const claim: ResourceClaim = {
            metadata: { name: 'c', namespace: 'ns', ownerReferences: [{ apiVersion: 'v1', kind: 'Pod', name: 'owner', uid: 'u', controller: true }] },
            status: { reservedFor: [{ resource: 'pods', name: 'a' }, { resource: 'pods', name: 'b' }, { resource: 'workloads', apiGroup: 'scheduling.k8s.io', name: 'w' }] },
        };
        expect(reservedPods(claim)).toEqual(['a', 'b']);
        expect(claimOwnerPod(claim)).toBe('owner');
    });
});

describe('device classes', () => {
    it('name the driver and type their CEL selects', () => {
        const cls = { metadata: { name: 'mig.nvidia.com' }, spec: { selectors: [{ cel: { expression: "device.driver == 'gpu.nvidia.com' && device.attributes['gpu.nvidia.com'].type == 'mig'" } }] } };
        expect(classDriver(cls)).toBe('gpu.nvidia.com');
        expect(classDeviceType(cls)).toBe('mig');
        expect(classDriver({ metadata: { name: 'x' }, spec: { selectors: [{ cel: { expression: 'true' } }] } })).toBe('');
    });
});
