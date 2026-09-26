import { describe, expect, it } from 'vitest';
import { nvlCharts, nvlLists, nvlNodes, nvlPods } from '../fixtures.js';
import { parseLabels, readDcgm, shortUuid } from './dcgm.js';
import { buildInventory } from './inventory.js';
import type { Node, Pod } from './kube.js';

const pods = nvlLists['pods'] as Pod[];

describe('reading labels back', () => {
    it('reads a series name into its labels, a value with a comma in it included', () => {
        expect(parseLabels('UUID=GPU-1, gpu=0, modelName=NVIDIA H100 NVL, note=a, b')).toEqual({ UUID: 'GPU-1', gpu: '0', modelName: 'NVIDIA H100 NVL', note: 'a, b' });
        expect(parseLabels('')).toEqual({});
    });

    it('shortens a UUID to its first block', () => {
        expect(shortUuid('GPU-d1891b91-980f-4191-34f1-9b2046bf3af5')).toBe('GPU-d1891b91');
    });
});

describe('DCGM', () => {
    it('reads every card with its identity, its pod and its numbers', () => {
        const { gpus, status } = readDcgm(nvlCharts(), nvlNodes, pods);
        expect(status).toMatchObject({ prometheus: true, found: true, mapping: true });
        expect(gpus.map((g) => [g.index, g.pciBus, g.consumers.map((c) => c.pod)])).toEqual([
            ['0', '00000000:02:00.0', ['vllm-ornith-1-5-35b-69c77dbfcc-89ffh']],
            ['1', '00000000:64:00.0', ['vllm-ornith-1-5-35b-69c77dbfcc-89ffh']],
            ['2', '00000000:82:00.0', ['vllm-qwen3-8-27b-7cfd766d96-rxpmz']],
            ['3', '00000000:E3:00.0', ['vllm-gpt-oss-120b-67fcdc9f66-rz5j8']],
        ]);
        expect(gpus[3]).toMatchObject({ node: 'gpu-h100nvl-01', model: 'NVIDIA H100 NVL', util: 0.83, temperature: 61, power: 300 });
        expect(gpus[3]?.memoryUsed).toBe(88064 * 1024 ** 2);
    });

    it('does not take the exporter for the pod on a card', () => {
        const { gpus, status } = readDcgm(nvlCharts({ mapping: false }), nvlNodes, pods);
        expect(status.mapping).toBe(false);
        expect(gpus.every((g) => g.consumers.length === 0)).toBe(true);
    });

    it('leaves out a series that stopped before the others', () => {
        const { gpus } = readDcgm(nvlCharts({ stale: true }), nvlNodes, pods);
        expect(gpus[2]?.consumers.map((c) => c.pod)).toEqual(['vllm-qwen3-8-27b-7cfd766d96-rxpmz']);
        expect(gpus[2]?.memoryUsed).toBe(85120 * 1024 ** 2);
    });

    it('matches a short hostname to its node, and one host to the one GPU node', () => {
        const fqdn: Node[] = nvlNodes.map((n) => ({ ...n, metadata: { ...n.metadata, name: n.metadata.name === 'gpu-h100nvl-01' ? 'gpu-h100nvl-01.dc1.example.com' : n.metadata.name } }));
        const moved = pods.map((p) => ({ ...p, spec: { ...p.spec, nodeName: p.spec?.nodeName === 'gpu-h100nvl-01' ? 'gpu-h100nvl-01.dc1.example.com' : p.spec?.nodeName } }));
        expect(readDcgm(nvlCharts(), fqdn, moved).gpus[0]?.node).toBe('gpu-h100nvl-01.dc1.example.com');
        const renamed: Node[] = nvlNodes.map((n) => ({ ...n, metadata: { ...n.metadata, name: n.metadata.name === 'gpu-h100nvl-01' ? 'worker-7' : n.metadata.name } }));
        expect(readDcgm(nvlCharts(), renamed, [], ['worker-7']).gpus[0]?.node).toBe('worker-7');
    });

    it('is nothing at all without a Prometheus', () => {
        const panel = { ...nvlCharts(), source: { ...nvlCharts().source, available: false } };
        expect(readDcgm(panel, nvlNodes, pods).gpus).toEqual([]);
    });
});

describe('the inventory, with DCGM', () => {
    it('counts pods onto cards in order without DCGM, and says it is a count', () => {
        const inv = buildInventory({ nodes: nvlNodes, pods, slices: [], claims: [] });
        const cards = inv.nodes[0]?.units ?? [];
        expect(cards.map((u) => u.consumers.map((c) => c.pod)[0])).toEqual([nvlPods[0]?.metadata.name, nvlPods[1]?.metadata.name, nvlPods[1]?.metadata.name, nvlPods[2]?.metadata.name]);
        expect(cards.every((u) => u.inferred)).toBe(true);
    });

    it('puts each pod on the card DCGM says it has, with the card’s UUID and PCI address', () => {
        const { gpus } = readDcgm(nvlCharts(), nvlNodes, pods);
        const inv = buildInventory({ nodes: nvlNodes, pods, slices: [], claims: [] }, gpus);
        const cards = inv.nodes[0]?.units ?? [];
        expect(cards.map((u) => [u.name, u.consumers.map((c) => c.pod)[0], u.inferred])).toEqual([
            ['GPU 0', 'vllm-ornith-1-5-35b-69c77dbfcc-89ffh', false],
            ['GPU 1', 'vllm-ornith-1-5-35b-69c77dbfcc-89ffh', false],
            ['GPU 2', 'vllm-qwen3-8-27b-7cfd766d96-rxpmz', false],
            ['GPU 3', 'vllm-gpt-oss-120b-67fcdc9f66-rz5j8', false],
        ]);
        expect(cards[0]).toMatchObject({ uuid: 'GPU-d1891b91-980f-4191-34f1-9b2046bf3af5', pciBus: '00000000:02:00.0', model: 'H100 NVL' });
        expect(cards[3]?.live?.util).toBe(0.83);
        expect(inv.totals).toMatchObject({ total: 4, inUse: 4, free: 0 });
    });

    it('takes the identity but keeps the count when DCGM has no pod mapping', () => {
        const { gpus } = readDcgm(nvlCharts({ mapping: false }), nvlNodes, pods);
        const cards = buildInventory({ nodes: nvlNodes, pods, slices: [], claims: [] }, gpus).nodes[0]?.units ?? [];
        expect(cards[3]?.uuid).toBe('GPU-7ecb082d-46c8-e7b2-8804-c2979adfe8fe');
        expect(cards.every((u) => u.inferred)).toBe(true);
    });
});
