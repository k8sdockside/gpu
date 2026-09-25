import { describe, expect, it } from 'vitest';
import * as fixtures from '../fixtures.js';
import { buildInventory } from './inventory.js';
import type { Pod } from './kube.js';
import { podClaims, podDeviceRequests } from './requests.js';
import { buildWorkloads, plainReason } from './workloads.js';

const inventory = buildInventory(fixtures);
const work = buildWorkloads(fixtures, inventory);
const podNamed = (name: string) => work.pods.find((p) => p.name === name);
const claimNamed = (name: string) => work.claims.find((c) => c.name === name);

describe('what a pod asks for', () => {
    it('sums containers and sidecars, and takes the biggest ordinary init container', () => {
        const pod: Pod = {
            metadata: { name: 'p' },
            spec: {
                containers: [{ resources: { limits: { 'nvidia.com/gpu': '1', cpu: '4' } } }, { resources: { limits: { 'nvidia.com/gpu': '1' } } }],
                initContainers: [
                    { resources: { limits: { 'nvidia.com/gpu': '4' } } },
                    { restartPolicy: 'Always', resources: { limits: { 'nvidia.com/gpu': '1' } } },
                ],
            },
        };
        expect(podDeviceRequests(pod)).toEqual({ 'nvidia.com/gpu': 4 });
    });

    it('counts an extended resource a DeviceClass serves, and the implicit class name', () => {
        const pod: Pod = { metadata: { name: 'p' }, spec: { containers: [{ resources: { limits: { 'example.com/gpu': '1', 'deviceclass.resource.kubernetes.io/gpu.example.com': '2' } } }] } };
        expect(podDeviceRequests(pod, new Set(['example.com/gpu']))).toEqual({ 'example.com/gpu': 1, 'deviceclass.resource.kubernetes.io/gpu.example.com': 2 });
    });

    it('finds the claim a template was turned into from the pod s status', () => {
        const pod: Pod = {
            metadata: { name: 'p' },
            spec: { resourceClaims: [{ name: 'gpu', resourceClaimTemplateName: 't' }, { name: 'shared', resourceClaimName: 'mine' }] },
            status: { resourceClaimStatuses: [{ name: 'gpu', resourceClaimName: 'p-gpu-abcde' }] },
        };
        expect(podClaims(pod)).toEqual([
            { entry: 'gpu', claim: 'p-gpu-abcde', template: 't' },
            { entry: 'shared', claim: 'mine', template: '' },
        ]);
    });
});

describe('who uses what', () => {
    it('ties a DRA pod to the exact devices its claim was given', () => {
        expect(podNamed('two-gpu-pod')?.held.map((h) => h.label)).toEqual(['gpu-1', 'gpu-2']);
        expect(podNamed('two-gpu-pod')?.held.every((h) => !h.inferred)).toBe(true);
    });

    it('ties a device-plugin pod to units, marked as inferred', () => {
        expect(podNamed('detector-1')?.held).toHaveLength(2);
        expect(podNamed('detector-1')?.held.every((h) => h.inferred)).toBe(true);
    });

    it('names a MIG instance by its profile and its GPU', () => {
        expect(podNamed('nb-0')?.held[0]?.label).toBe('1g.10gb on gpu-0');
    });

    it('leaves out pods that ask for no accelerator and pods that have finished', () => {
        expect(podNamed('web-0')).toBeUndefined();
        expect(podNamed('batch-done')).toBeUndefined();
    });
});

describe('claims', () => {
    it('say they are shared, and by how many', () => {
        expect(claimNamed('vllm-shared')).toMatchObject({ state: 'reserved', shared: true, pods: ['vllm-a', 'vllm-b'] });
        expect(claimNamed('vllm-shared')?.why).toContain('Shared by 2 pods');
    });

    it('know the template a generated claim came from', () => {
        expect(claimNamed('llm-pretrain-0-gpu-7xk2p')).toMatchObject({ template: 'h100-x8', owner: 'llm-pretrain-0' });
    });

    it('say why a pending claim is pending', () => {
        expect(claimNamed('too-many-gpus-pod-gpus-z9x8c')?.why).toContain('can never be scheduled');
        expect(claimNamed('spare')?.why).toContain('no pod uses it');
    });

    it('come pending first', () => {
        expect(work.claims[0]?.state).toBe('pending');
    });
});

describe('why a pod is waiting', () => {
    it('spots a pod that asks for more than any node has', () => {
        expect(podNamed('too-many-gpus-pod')?.never).toBe('This can never be scheduled: it asks for 16 gpu.example.com devices and the biggest node has 8.');
    });

    it('says a pod that could fit is waiting for devices to free up', () => {
        const pod = podNamed('llama-finetune-3');
        expect(pod?.never).toBe('');
        expect(pod?.reason).toContain('No node has enough free GPUs (nvidia.com/gpu)');
        expect(pod?.detail).toContain('Insufficient nvidia.com/gpu');
    });

    it('reads the FailedScheduling event when the condition has no message', () => {
        expect(podNamed('nb-7')?.reason).toContain('No node has a free device that matches its claims');
    });

    it('adds up the pending demand', () => {
        expect(work.demand).toEqual({ pods: 3, devices: 21, all: false });
    });

    it('says when the claim a pod names does not exist', () => {
        const pod: Pod = { metadata: { name: 'orphan', namespace: 'ns' }, spec: { resourceClaims: [{ name: 'gpu', resourceClaimName: 'gone' }] }, status: { phase: 'Pending' } };
        const w = buildWorkloads({ ...fixtures, pods: [pod] }, inventory);
        expect(w.pods[0]?.reason).toBe('It uses ResourceClaim gone, which does not exist.');
    });

    it('says when no node has the resource at all', () => {
        const pod: Pod = { metadata: { name: 'p', namespace: 'ns' }, spec: { containers: [{ resources: { limits: { 'habana.ai/gaudi': '1' } } }] }, status: { phase: 'Pending' } };
        const w = buildWorkloads({ ...fixtures, pods: [pod] }, inventory);
        expect(w.pods[0]?.never).toContain('no node has any habana.ai/gaudi');
    });
});

describe('the scheduler s message, in words', () => {
    it('turns Insufficient into "not enough free"', () => {
        const text = plainReason('0/3 nodes are available: 1 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: }, 2 Insufficient nvidia.com/gpu. preemption: 0/3 nodes are available: 3 Preemption is not helpful for scheduling.');
        expect(text).toBe('No node has enough free GPUs (nvidia.com/gpu). Of 3 nodes: 1 node is tainted and it does not tolerate that; 2 nodes do not have enough nvidia.com/gpu free.');
    });

    it('explains the DRA reason', () => {
        expect(plainReason('0/2 nodes are available: 2 cannot allocate all claims.')).toContain('no free device that matches its claims');
    });

    it('keeps a reason it does not know as it was written', () => {
        expect(plainReason('0/1 nodes are available: 1 node(s) had volume node affinity conflict.')).toBe('None of the 1 node can take it: 1 node: node(s) had volume node affinity conflict.');
        expect(plainReason('something else entirely')).toBe('something else entirely');
    });
});
