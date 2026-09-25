// @vitest-environment happy-dom
//
// Does each page actually draw?
//
// The model tests say the device knowledge is right; this says the pages that
// use it put it on the screen, against objects shaped the way the API really
// writes them -- ResourceSlices with typed attributes, claims with allocation
// results, pods with `nvidia.com/gpu` in their limits. It runs each page
// module against a stub of the bridge, with no cluster and no app, and reads
// the text that comes out.
//
// It is here rather than in a browser because the thing worth catching is a
// page that throws on a shape the cluster produces and this machine does not:
// a cluster with no DRA API at all, one with no accelerators, a Prometheus
// with no DCGM behind it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chartsPanel, LISTS, noDcgm, noPrometheus, panelObjects, nodes } from '../fixtures.js';

type Lists = Record<string, unknown[]>;

function bridge(lists: Lists, object: unknown = null, charts: K8sDockside.ChartsPanel = chartsPanel, storage: Record<string, unknown> = {}) {
    return {
        ready: async () => ({
            pluginId: 'gpu',
            viewId: '',
            sectionId: '',
            object: null,
            contextId: 'test',
            contextName: 'test-cluster',
            readable: [],
            write: false,
            actions: [],
            theme: { id: 'k8sdockside-dark', base: 'dark' as const, tokens: {} },
        }),
        object: async () => object,
        list: async ({ kind }: { kind: string }) => {
            if (!(kind in lists)) throw new Error(`this cluster does not serve ${kind}`);
            return lists[kind];
        },
        get: async () => object,
        open: async () => null,
        openView: async () => null,
        openUrl: async () => null,
        summary: async () => ({ pluginId: 'gpu', installed: true, checked: true, requirements: [], cards: [], error: '' }),
        storage: { get: async (key: string) => storage[key] ?? null, set: async () => null, remove: async () => null, keys: async () => [] },
        actions: async () => [],
        run: async () => ({ created: '' }),
        resize: async () => null,
        watch: () => () => {},
        namespaces: async () => [],
        charts: async () => charts,
        patch: async () => null,
        create: async () => ({ name: '' }),
        edit: async () => null,
        logs: async () => null,
        on: () => () => {},
    };
}

const PAGE = '<div id="page"><div id="head"></div><div id="bar"></div><p id="first"></p><div id="body"></div></div>';

/** Runs a page module fresh, then lets its promises settle. */
async function run(module: string): Promise<string> {
    vi.resetModules();
    await import(module);
    for (let i = 0; i < 40; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
    return document.body.textContent ?? '';
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

/** Only what a cluster without Dynamic Resource Allocation serves. */
const NO_DRA: Lists = { nodes: LISTS['nodes'] ?? [], pods: LISTS['pods'] ?? [], daemonsets: LISTS['daemonsets'] ?? [], events: [] };

describe('the dashboard', () => {
    it('counts the fleet, by model, and says what needs attention', async () => {
        vi.stubGlobal('k8sdockside', bridge(LISTS));
        document.body.innerHTML = PAGE;
        const text = await run('./overview.js');

        expect(text).toContain('Accelerators55');
        expect(text).toContain('In use28');
        expect(text).toContain('Waiting for21');
        expect(text).toContain('H100 80GB HBM3');
        expect(text).toContain('25×');
        expect(text).toContain('dra-demo/too-many-gpus-pod can never start');
        expect(text).toContain('gpu-a10-02 has lost a device');
        expect(text).toContain('nvidia-device-plugin-daemonset is not ready everywhere');
        expect(text).toContain('gpu.nvidia.com');
        expect(text).toContain('GPU utilisation, by model');
    });

    it('says there is no Prometheus rather than drawing empty charts', async () => {
        vi.stubGlobal('k8sdockside', bridge(LISTS, null, noPrometheus));
        document.body.innerHTML = PAGE;
        const text = await run('./overview.js');
        expect(text).toContain('No Prometheus was found');
        expect(text).toContain('Accelerators55');
    });

    it('says Prometheus has no DCGM metrics, and how to get them without a GPU', async () => {
        vi.stubGlobal('k8sdockside', bridge(LISTS, null, noDcgm));
        document.body.innerHTML = PAGE;
        const text = await run('./overview.js');
        expect(text).toContain('has no DCGM metrics');
        expect(text).toContain('fake-gpu-operator');
    });

    it('works on a cluster with no DRA API, from the device plugins alone', async () => {
        vi.stubGlobal('k8sdockside', bridge(NO_DRA));
        document.body.innerHTML = PAGE;
        const text = await run('./overview.js');
        expect(text).toContain('does not serve resource.k8s.io');
        expect(text).toContain('Tesla T4');
        expect(text).not.toContain('gpu.example.com');
    });

    it('says plainly that there are no accelerators', async () => {
        vi.stubGlobal('k8sdockside', bridge({ nodes: [{ metadata: { name: 'cpu-only' } }], pods: [] }));
        document.body.innerHTML = PAGE;
        const text = await run('./overview.js');
        expect(text).toContain('No accelerators in test-cluster');
        expect(text).toContain('Testing without a GPU');
    });
});

describe('the inventory', () => {
    it('draws a square per device, grouped by node, with the pinned one in the inspector', async () => {
        vi.stubGlobal('k8sdockside', bridge(LISTS, null, chartsPanel, { 'inventory.pin': 'dra/gpu.nvidia.com/dgx-h100-02/gpu-3' }));
        document.body.innerHTML = PAGE;
        const text = await run('./inventory.js');

        expect(document.querySelectorAll('.gpu')).toHaveLength(55);
        expect(document.querySelectorAll('.gpu-unhealthy')).toHaveLength(2);
        expect(document.querySelectorAll('.gpu-cut').length).toBeGreaterThan(0);
        expect(document.querySelectorAll('.gpu-sliced')).toHaveLength(2);
        expect(document.querySelector('.gpu.selected')?.getAttribute('data-unit')).toBe('dra/gpu.nvidia.com/dgx-h100-02/gpu-3');
        expect(text).toContain('55 accelerators on 10 nodes, 28 in use.');
        // The inspector: the shared H100, both pods, and the driver's attributes.
        expect(text).toContain('Used by 2 pods');
        expect(text).toContain('vllm-a');
        expect(text).toContain('cudaComputeCapability');
    });

    it('groups by model when that was the choice last time', async () => {
        vi.stubGlobal('k8sdockside', bridge(LISTS, null, chartsPanel, { 'inventory.group': 'model' }));
        document.body.innerHTML = PAGE;
        await run('./inventory.js');
        const groups = [...document.querySelectorAll('.group-name')].map((n) => n.textContent);
        expect(groups[0]).toBe('H100 80GB HBM3');
        expect(groups).toContain('Instinct MI300X OAM');
    });

    it('does not put cluster data on the page as HTML', async () => {
        const evil = structuredClone(LISTS);
        (evil['nodes'] as { metadata: { name: string } }[])[4]!.metadata.name = '<img src=x onerror=alert(1)>';
        vi.stubGlobal('k8sdockside', bridge(evil));
        document.body.innerHTML = PAGE;
        const text = await run('./inventory.js');
        expect(document.querySelector('img[src=x]')).toBe(null);
        expect(text).toContain('<img src=x onerror=alert(1)>');
    });
});

describe('claims & workloads', () => {
    it('puts the waiting pods first, with why, then the namespaces and the claims', async () => {
        vi.stubGlobal('k8sdockside', bridge(LISTS));
        document.body.innerHTML = PAGE;
        const text = await run('./workloads.js');

        expect(text).toContain('Waiting (3)');
        expect(text).toContain('can never fit');
        expect(text).toContain('No node has enough free GPUs (nvidia.com/gpu)');
        expect(text).toContain('What the scheduler said');
        expect(text).toContain('In use, by namespace');
        expect(text).toContain('1g.10gb on gpu-0');
        expect(text).toContain('ResourceClaims (16)');
        expect(text).toContain('Shared by 2 pods');
        expect(text).toContain('ResourceClaimTemplates');
        expect(text).toContain('mig.nvidia.com');
    });

    it('says there are no claims on a cluster without DRA', async () => {
        vi.stubGlobal('k8sdockside', bridge(NO_DRA));
        document.body.innerHTML = PAGE;
        const text = await run('./workloads.js');
        expect(text).toContain('does not serve resource.k8s.io');
        expect(text).toContain('jupyter-0');
    });
});

describe('the panels', () => {
    it('draws a node s devices, MIG and all, and who holds them', async () => {
        vi.stubGlobal('k8sdockside', bridge(LISTS, panelObjects.node));
        document.body.innerHTML = '<div id="panel"></div>';
        const text = await run('./node.js');
        expect(document.querySelectorAll('.gpu')).toHaveLength(4);
        expect(text).toContain('2 of 4 in use');
        expect(text).toContain('notebooks/nb-0');
        expect(text).toContain('research/alphafold-0');
    });

    it('says a node with no accelerators has none', async () => {
        vi.stubGlobal('k8sdockside', bridge(LISTS, nodes.find((n) => n.metadata.name === 'cpu-01')));
        document.body.innerHTML = '<div id="panel"></div>';
        expect(await run('./node.js')).toContain('No accelerators on this node');
    });

    it('tells a pod why it will never be scheduled', async () => {
        vi.stubGlobal('k8sdockside', bridge(LISTS, panelObjects.pod));
        document.body.innerHTML = '<div id="panel"></div>';
        const text = await run('./pod.js');
        expect(text).toContain('can never fit');
        expect(text).toContain('asks for 16 gpu.example.com devices and the biggest node has 8');
    });

    it('draws what a shared claim was given', async () => {
        vi.stubGlobal('k8sdockside', bridge(LISTS, panelObjects.claim));
        document.body.innerHTML = '<div id="panel"></div>';
        const text = await run('./claim.js');
        expect(text).toContain('shared by 2 pods');
        expect(text).toContain('gpu-3');
        expect(text).toContain('dgx-h100-02');
        expect(text).toContain('vllm-b');
    });
});
