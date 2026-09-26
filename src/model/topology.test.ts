import { describe, expect, it } from 'vitest';
import { linkGroups, nodeTopology, parseTopology, productWiring } from './topology.js';

// What `nvidia-smi topo -m` prints on a machine with two bridged H100 NVL pairs.
const MATRIX = `
        GPU0    GPU1    GPU2    GPU3    NIC0    CPU Affinity    NUMA Affinity   GPU NUMA ID
GPU0     X      NV12    SYS     SYS     SYS     0-31,64-95      0               N/A
GPU1    NV12     X      SYS     SYS     SYS     0-31,64-95      0               N/A
GPU2    SYS     SYS      X      NV12    NODE    32-63,96-127    1               N/A
GPU3    SYS     SYS     NV12     X      NODE    32-63,96-127    1               N/A
NIC0    SYS     SYS     NODE    NODE     X

Legend:

  X    = Self
  SYS  = Connection traversing PCIe as well as the SMP interconnect between NUMA nodes (e.g., QPI/UPI)
  NV#  = Connection traversing a bonded set of # NVLinks
`;

describe('reading nvidia-smi', () => {
    it('reads the NVLinks out of the topology matrix, once each', () => {
        expect(parseTopology(MATRIX)).toEqual([
            { a: '0', b: '1', kind: 'NV12' },
            { a: '2', b: '3', kind: 'NV12' },
        ]);
    });

    it('reads lines written GPU 0 <-> GPU 1: NV12', () => {
        expect(parseTopology('NVLink connections\nGPU 0 <-> GPU 1: NV12\nGPU 2 <-> GPU 3: NV12\n')).toEqual([
            { a: '0', b: '1', kind: 'NV12' },
            { a: '2', b: '3', kind: 'NV12' },
        ]);
    });

    it('reads a matrix with no NVLink as none, and anything else as nothing', () => {
        expect(parseTopology('        GPU0    GPU1\nGPU0     X      SYS\nGPU1    SYS      X\n')).toEqual([]);
        expect(parseTopology('hello')).toBeNull();
    });
});

describe('what a model is built as', () => {
    it('knows the NVL cards come in bridged pairs, whichever source spells the name', () => {
        expect(productWiring('NVIDIA-H100-NVL')).toMatchObject({ fabric: 'pairs', kind: 'NV12' });
        expect(productWiring('NVIDIA H100 NVL')).toMatchObject({ fabric: 'pairs' });
        expect(productWiring('NVIDIA H200 NVL')).toMatchObject({ fabric: 'pairs' });
    });

    it('knows SXM parts sit on NVSwitch, and PCIe inference cards have no NVLink', () => {
        expect(productWiring('NVIDIA-H100-80GB-HBM3').fabric).toBe('nvswitch');
        expect(productWiring('NVIDIA A100-SXM4-80GB').fabric).toBe('nvswitch');
        expect(productWiring('NVIDIA-L4').fabric).toBe('none');
        expect(productWiring('NVIDIA-Tesla-T4-SHARED').fabric).toBe('none');
        expect(productWiring('NVIDIA A100 80GB PCIe').fabric).toBe('unknown');
    });

    it('pairs four H100 NVL cards 0–1 and 2–3, marked as read from the model', () => {
        const t = nodeTopology('NVIDIA-H100-NVL', ['0', '1', '2', '3']);
        expect(t.source).toBe('model');
        expect(t.links).toEqual([
            { a: '0', b: '1', kind: 'NV12' },
            { a: '2', b: '3', kind: 'NV12' },
        ]);
        expect(t.sentence).toContain('paste nvidia-smi topo -m');
    });

    it('prefers what was pasted over what the model says', () => {
        const t = nodeTopology('NVIDIA-H100-NVL', ['0', '1', '2', '3'], {}, [{ a: '0', b: '3', kind: 'NV12' }]);
        expect(t.source).toBe('pasted');
        expect(t.links).toEqual([{ a: '0', b: '3', kind: 'NV12' }]);
    });

    it('names the multi-node NVLink domain GFD labels a node with', () => {
        expect(nodeTopology('NVIDIA GB200', ['0', '1', '2', '3'], { 'nvidia.com/gpu.clique': 'a1b2.1' }).sentence).toContain('a1b2.1');
    });
});

describe('groups', () => {
    it('frames linked GPUs together and leaves the rest on their own', () => {
        expect(linkGroups(['0', '1', '2', '3', '4'], [{ a: '0', b: '1', kind: 'NV12' }, { a: '2', b: '3', kind: 'NV12' }])).toEqual([['0', '1'], ['2', '3'], ['4']]);
    });
});
