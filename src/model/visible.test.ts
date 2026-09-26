import { describe, expect, it } from 'vitest';
import { barePods, nvlPods } from '../fixtures.js';
import { nvidiaRuntime, parseVisible, visibleDevices } from './visible.js';

describe('GPUs named in a pod’s env', () => {
    it('reads indexes, UUIDs and all, and nothing from none', () => {
        expect(parseVisible('0,1')).toEqual({ all: false, devices: ['0', '1'] });
        expect(parseVisible(' GPU-5e83768b-5b44 ')).toEqual({ all: false, devices: ['GPU-5e83768b-5b44'] });
        expect(parseVisible('all')).toEqual({ all: true, devices: [] });
        expect(parseVisible('void')).toBeUndefined();
        expect(parseVisible('')).toBeUndefined();
    });

    it('reads a pod that asks the scheduler for nothing, and not one that asks', () => {
        expect(visibleDevices(barePods[1]!)).toMatchObject({ devices: ['0', '1'], env: 'NVIDIA_VISIBLE_DEVICES' });
        expect(visibleDevices(barePods[3]!)).toBeUndefined();
        expect(nvidiaRuntime(barePods[3]!)).toBe(true);
        const asks = { ...nvlPods[0]!, spec: { ...nvlPods[0]!.spec, containers: [{ ...nvlPods[0]!.spec!.containers![0]!, env: [{ name: 'CUDA_VISIBLE_DEVICES', value: '0' }] }] } };
        expect(visibleDevices(asks)).toBeUndefined();
    });
});
