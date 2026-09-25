import { describe, expect, it } from 'vitest';
import * as fixtures from '../fixtures.js';
import { acceleratorDaemons, drivers, isAcceleratorDaemonSet, issues } from './attention.js';
import { buildInventory } from './inventory.js';
import { buildWorkloads } from './workloads.js';

const inventory = buildInventory(fixtures);
const work = buildWorkloads(fixtures, inventory);
const daemons = acceleratorDaemons(fixtures.daemonSets);
const list = issues(inventory, work, daemons);

describe('the accelerator daemonsets', () => {
    it('are found by name, and kube-proxy is not one', () => {
        expect(daemons.map((d) => d.name)).not.toContain('kube-proxy');
        expect(daemons.map((d) => d.name)).toContain('dra-example-driver-kubeletplugin');
        for (const name of ['nvidia-device-plugin-daemonset', 'gpu-feature-discovery', 'amdgpu-device-plugin-daemonset', 'nvidia-dra-driver-gpu-kubelet-plugin', 'neuron-device-plugin-daemonset']) {
            expect(isAcceleratorDaemonSet({ metadata: { name } }), name).toBe(true);
        }
        expect(isAcceleratorDaemonSet({ metadata: { name: 'hydra-api' } })).toBe(false);
    });

    it('are toned by how many are ready', () => {
        expect(daemons.find((d) => d.name === 'nvidia-device-plugin-daemonset')?.tone).toBe('warn');
        expect(daemons.find((d) => d.name === 'gpu-feature-discovery')?.tone).toBe('ok');
    });
});

describe('the drivers', () => {
    it('lists each DRA driver and each device plugin resource once', () => {
        const names = drivers(inventory, fixtures.slices).map((d) => `${d.kind}:${d.name}`);
        expect(names).toContain('DRA driver:gpu.nvidia.com');
        expect(names).toContain('DRA driver:gpu.example.com');
        expect(names).toContain('device plugin:nvidia.com/gpu');
        expect(names).toContain('device plugin:amd.com/gpu');
        expect(new Set(names).size).toBe(names.length);
    });
});

describe('what needs attention', () => {
    it('puts the pod that can never start first', () => {
        expect(list[0]).toMatchObject({ tone: 'error', title: 'dra-demo/too-many-gpus-pod can never start' });
    });

    it('lists the waiting pods, the lost GPUs, and the daemonset that is not ready', () => {
        const titles = list.map((i) => i.title);
        expect(titles).toContain('training/llama-finetune-3 is waiting for devices');
        expect(titles).toContain('gpu-a10-02 has lost a device');
        expect(titles).toContain('dgx-h100-03 has lost a device');
        expect(titles).toContain('nvidia-device-plugin-daemonset is not ready everywhere');
    });

    it('mentions the claim nobody uses, the cordoned node and the double advertising, as information', () => {
        const info = list.filter((i) => i.tone === 'info').map((i) => i.title);
        expect(info).toContain('research/old-experiment holds devices nobody uses');
        expect(info).toContain('mi300-01 is cordoned');
        expect(info).toContain('dgx-h100-02 advertises its cards twice');
    });

    it('opens the object each row is about', () => {
        expect(list.find((i) => i.title.startsWith('gpu-a10-02'))?.ref).toEqual({ kind: 'nodes', name: 'gpu-a10-02' });
        expect(list.find((i) => i.title.startsWith('nvidia-device-plugin'))?.ref).toEqual({ kind: 'daemonsets', namespace: 'gpu-operator', name: 'nvidia-device-plugin-daemonset' });
    });

    it('says a node that is not Ready takes its GPUs with it', () => {
        const nodes = fixtures.nodes.map((n) => (n.metadata.name === 'gpu-l4-01' ? { ...n, status: { ...n.status, conditions: [{ type: 'Ready', status: 'False' }] } } : n));
        const inv = buildInventory({ ...fixtures, nodes });
        const titles = issues(inv, buildWorkloads({ ...fixtures, nodes }, inv), []).map((i) => i.title);
        expect(titles).toContain('gpu-l4-01 is not Ready');
    });
});
