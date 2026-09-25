import { describe, expect, it } from 'vitest';
import { driverVendor, friendlyModel, isAcceleratorDriver, isDeviceResource, migResourceProfile, migSlicesFor, nodeCard, parseMigProfile, resourceNoun, resourceVendor } from './vendors.js';

describe('which extended resources are devices', () => {
    it('counts whole devices from every vendor', () => {
        for (const name of ['nvidia.com/gpu', 'nvidia.com/gpu.shared', 'nvidia.com/mig-1g.10gb', 'nvidia.com/mig-3g.40gb', 'amd.com/gpu', 'gpu.intel.com/i915', 'gpu.intel.com/xe', 'habana.ai/gaudi', 'google.com/tpu']) {
            expect(isDeviceResource(name), name).toBe(true);
        }
    });

    it('does not count a fraction of a device as a device', () => {
        // Intel's resource management: a thousand millicores is one GPU.
        for (const name of ['gpu.intel.com/millicores', 'gpu.intel.com/memory.max', 'gpu.intel.com/tiles', 'cpu', 'memory', 'ephemeral-storage', 'hugepages-2Mi', 'aws.amazon.com/neuroncore']) {
            expect(isDeviceResource(name), name).toBe(false);
        }
    });

    it('knows whose each one is', () => {
        expect(resourceVendor('nvidia.com/mig-1g.10gb')).toBe('nvidia');
        expect(resourceVendor('amd.com/gpu')).toBe('amd');
        expect(resourceVendor('habana.ai/gaudi')).toBe('habana');
        expect(resourceVendor('cpu')).toBeUndefined();
    });
});

describe('DRA drivers', () => {
    it('are told apart by the domain they are named in', () => {
        expect(driverVendor('gpu.nvidia.com')).toBe('nvidia');
        expect(driverVendor('gpu.amd.com')).toBe('amd');
        expect(driverVendor('gpu.intel.com')).toBe('intel');
        expect(driverVendor('gpu.example.com')).toBe('example');
        expect(driverVendor('dra.acme.io')).toBe('other');
    });

    it('leave NVIDIA compute-domain channels out of the accelerators', () => {
        expect(isAcceleratorDriver('compute-domain.nvidia.com')).toBe(false);
        expect(isAcceleratorDriver('gpu.nvidia.com')).toBe(true);
    });
});

describe('MIG profiles', () => {
    it('read the compute slices and the memory', () => {
        expect(parseMigProfile('1g.10gb')).toEqual({ name: '1g.10gb', slices: 1, gigabytes: 10 });
        expect(parseMigProfile('3g.40gb')).toEqual({ name: '3g.40gb', slices: 3, gigabytes: 40 });
        expect(parseMigProfile('7g.80gb')?.slices).toBe(7);
    });

    it('read the variants NVIDIA also writes', () => {
        expect(parseMigProfile('1g.10gb+me')?.slices).toBe(1);
        expect(parseMigProfile('1c.3g.40gb')?.slices).toBe(3);
        expect(parseMigProfile('mig-2g.20gb')?.name).toBe('2g.20gb');
    });

    it('refuse what is not one', () => {
        expect(parseMigProfile('gpu')).toBeUndefined();
        expect(parseMigProfile('0g.10gb')).toBeUndefined();
    });

    it('come out of the device plugin resource name', () => {
        expect(migResourceProfile('nvidia.com/mig-2g.20gb')?.slices).toBe(2);
        expect(migResourceProfile('nvidia.com/gpu')).toBeUndefined();
    });

    it('divide an A30 in four and everything else in seven', () => {
        expect(migSlicesFor('NVIDIA-A30')).toBe(4);
        expect(migSlicesFor('A30')).toBe(4);
        expect(migSlicesFor('NVIDIA-A100-SXM4-80GB')).toBe(7);
        expect(migSlicesFor('H100 80GB HBM3')).toBe(7);
    });
});

describe('product names', () => {
    it('come out the same from GFD, NVML and AMD', () => {
        expect(friendlyModel('NVIDIA-H100-80GB-HBM3')).toBe('H100 80GB HBM3');
        expect(friendlyModel('NVIDIA H100 80GB HBM3')).toBe('H100 80GB HBM3');
        expect(friendlyModel('NVIDIA A100-SXM4-80GB')).toBe(friendlyModel('NVIDIA-A100-SXM4-80GB'));
        expect(friendlyModel('AMD_Instinct_MI300X_OAM')).toBe('Instinct MI300X OAM');
    });

    it('drop the -SHARED GFD appends for time-slicing', () => {
        expect(friendlyModel('NVIDIA-Tesla-T4-SHARED')).toBe('Tesla T4');
    });

    it('name the thing when there is no product', () => {
        expect(resourceNoun('nvidia.com/mig-1g.10gb')).toBe('MIG 1g.10gb');
        expect(resourceNoun('habana.ai/gaudi')).toBe('Gaudi');
        expect(resourceNoun('amd.com/gpu')).toBe('GPU');
    });
});

describe('a node s card, from its labels', () => {
    it('reads what GFD writes', () => {
        const card = nodeCard({
            'nvidia.com/gpu.product': 'NVIDIA-H100-80GB-HBM3',
            'nvidia.com/gpu.memory': '81559',
            'nvidia.com/gpu.count': '8',
            'nvidia.com/gpu.replicas': '4',
            'nvidia.com/gpu.sharing-strategy': 'time-slicing',
            'nvidia.com/cuda.driver-version.full': '570.124.06',
            'nvidia.com/cuda.runtime-version.full': '12.8',
        });
        expect(card.memory).toBe(81559 * 1024 ** 2);
        expect(card.count).toBe(8);
        expect(card.replicas).toBe(4);
        expect(card.sharing).toBe('time-slicing');
        expect(card.driverVersion).toBe('570.124.06');
        expect(card.cudaVersion).toBe('12.8');
    });

    it('falls back to the older split driver labels', () => {
        const card = nodeCard({ 'nvidia.com/cuda.driver.major': '535', 'nvidia.com/cuda.driver.minor': '104', 'nvidia.com/cuda.driver.rev': '05', 'nvidia.com/cuda.runtime.major': '12', 'nvidia.com/cuda.runtime.minor': '2' });
        expect(card.driverVersion).toBe('535.104.05');
        expect(card.cudaVersion).toBe('12.2');
    });

    it('reads AMD s VRAM and is harmless on a node with no labels', () => {
        expect(nodeCard({ 'amd.com/gpu.vram': '192G' }).memory).toBe(192 * 1024 ** 3);
        expect(nodeCard(undefined)).toMatchObject({ product: '', memory: 0, count: 0, replicas: 1 });
    });
});
