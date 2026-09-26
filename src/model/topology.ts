// How the GPUs in a machine are wired to each other.
//
// Nothing in the Kubernetes API says which cards share an NVLink: not the
// device plugin, not GFD's labels, not NVIDIA's DRA driver, and DCGM's
// exporter reports each card's NVLink traffic but not who is at the other
// end. `nvidia-smi topo -m` on the machine is what knows. So the wiring comes
// from the best of three places, and the page says which:
//
//   pasted       `nvidia-smi topo -m` (or "GPU 0 <-> GPU 1: NV12" lines),
//                pasted into the page and kept per node. What the machine
//                itself says.
//   the model    what the product is built as. An H100 NVL or H200 NVL is a
//                PCIe card sold in pairs joined by NVLink bridges; an SXM
//                part sits on an HGX board where NVSwitch joins every GPU to
//                every other. Right for the product, a guess for the machine
//                -- which cards a bridge joins is read from their order --
//                and marked as one.
//   GFD          `nvidia.com/gpu.clique` on a GB200/GB300 node: the
//                multi-node NVLink domain the node's GPUs belong to.
//
// A PCIe card with no NVLink at all (L4, L40S, T4, A10 …) is said to have
// none; anything else unrecognised is "not known" rather than guessed.

export interface Link {
    /** GPU indexes, as nvidia-smi numbers them, with a < b. */
    a: string;
    b: string;
    /** What nvidia-smi calls it: "NV12" is twelve bonded NVLinks. "NVSwitch" or "NVLink" when not from a matrix. */
    kind: string;
}

export type Fabric = 'links' | 'pairs' | 'nvswitch' | 'none' | 'unknown';
export type TopologySource = 'pasted' | 'model' | 'none';

export interface Topology {
    fabric: Fabric;
    links: Link[];
    source: TopologySource;
    /** One sentence on what the wiring is and where it was read from. */
    sentence: string;
    /** GFD's multi-node NVLink domain, when the node is in one. */
    clique: string;
}

/** Kept per cluster in the plugin's storage: pasted links by node name. */
export type PastedTopologies = Record<string, Link[]>;
export const TOPOLOGY_KEY = 'topology';

function ordered(a: string, b: string, kind: string): Link {
    return Number(a) <= Number(b) ? { a, b, kind } : { a: b, b: a, kind };
}

/**
 * Reads NVLinks out of what nvidia-smi prints.
 *
 * `nvidia-smi topo -m` prints a matrix: a header of GPU0 GPU1 … NIC0 … and a
 * row per device, with NV<n> where two GPUs are joined by n NVLinks and
 * SYS/NODE/PHB/PXB/PIX for the PCIe paths that are not NVLink. Lines written
 * "GPU 0 <-> GPU 1: NV12" are read too. Anything else is ignored, so a paste
 * with the legend and the CPU affinity columns still reads. Returns null when
 * nothing in it is a link or a matrix.
 */
export function parseTopology(text: string): Link[] | null {
    const lines = text.split(/\r?\n/).map((l) => l.replace(/\t/g, ' ').trim());
    const links = new Map<string, Link>();
    const add = (a: string, b: string, kind: string) => {
        if (a === b) return;
        const link = ordered(a, b, kind);
        links.set(`${link.a}-${link.b}`, link);
    };
    let sawMatrix = false;

    // "GPU 0 <-> GPU 1: NV12", "GPU0 - GPU1 NV4".
    for (const line of lines) {
        const pair = /^GPU\s*(\d+)\s*(?:<->|<=>|↔|-|—|,)\s*GPU\s*(\d+)\s*[:=]?\s*(NV\d+|NVLink|NVSwitch)?/i.exec(line);
        if (pair && pair[1] !== undefined && pair[2] !== undefined) add(pair[1], pair[2], (pair[3] ?? 'NVLink').toUpperCase().replace('NVLINK', 'NVLink').replace('NVSWITCH', 'NVSwitch'));
    }

    // The matrix: the header names the columns, each GPU row fills them in.
    // The header is the line naming GPU0 as a column: unlike a row, it has no X in it.
    const header = lines.find((l) => l.split(/\s+/).includes('GPU0') && !l.split(/\s+/).includes('X') && !/<->|↔/.test(l));
    if (header) {
        const columns = header.split(/\s+/).filter((c) => c !== '');
        // Columns run in order from the first GPU0; the header may start with a blank cell.
        const first = columns.indexOf('GPU0');
        const names = columns.slice(first);
        for (const line of lines) {
            const row = /^GPU(\d+)\s+(.*)$/.exec(line);
            if (!row || row[1] === undefined) continue;
            const cells = (row[2] ?? '').split(/\s+/);
            sawMatrix = true;
            names.forEach((column, i) => {
                const other = /^GPU(\d+)$/.exec(column)?.[1];
                const cell = cells[i] ?? '';
                if (other !== undefined && /^NV\d+$/i.test(cell)) add(row[1] as string, other, cell.toUpperCase());
            });
        }
    }

    const list = [...links.values()].sort((x, y) => Number(x.a) - Number(y.a) || Number(x.b) - Number(y.b));
    return list.length > 0 || sawMatrix ? list : null;
}

/** Writes links back out the way the page lists them, and the way a paste can read them again. */
export function linkLines(links: Link[]): string[] {
    return links.map((l) => `GPU ${l.a} <-> GPU ${l.b}: ${l.kind}`);
}

type Wiring = { fabric: Exclude<Fabric, 'links'>; kind: string; product: string };

/**
 * What a product is built as. The model name arrives in whichever spelling
 * its source uses -- "NVIDIA-H100-NVL" from GFD, "NVIDIA H100 NVL" from NVML
 * -- and is compared with spaces.
 */
export function productWiring(model: string): Wiring {
    const name = model.replace(/[_-]+/g, ' ').replace(/^NVIDIA\s+/i, '').trim();
    const has = (pattern: RegExp) => pattern.test(name);
    // Rack-scale parts first: GB200 NVL72 is not a bridged pair.
    if (has(/\bG[BH]\d{3}\b/i) || has(/\bNVL\s?\d{2,}\b/i)) return { fabric: 'nvswitch', kind: 'NVLink', product: name };
    // PCIe cards sold bridged in pairs.
    if (has(/\bH100\b.*\bNVL\b/i)) return { fabric: 'pairs', kind: 'NV12', product: name };
    if (has(/\bH200\b.*\bNVL\b/i) || has(/\bNVL\b/i)) return { fabric: 'pairs', kind: 'NVLink', product: name };
    // HGX boards: SXM parts, whose NVML names say SXM or the HBM3 memory only SXM parts carry.
    if (has(/\bSXM\d?\b/i) || has(/\b(H100|H800)\b.*\bHBM3\b/i) || has(/\b(H200|H20|B200|B300|B100)\b/i)) return { fabric: 'nvswitch', kind: 'NVSwitch', product: name };
    // PCIe parts with no NVLink at all.
    if (has(/\b(L4|L40S?|L20|T4|A10G?|A2|A16|T1000|RTX\s?(A?\d{4}|PRO)|Tesla\s?T4)\b/i)) return { fabric: 'none', kind: '', product: name };
    return { fabric: 'unknown', kind: '', product: name };
}

/**
 * A node's wiring: what was pasted for it if anything, else what its model is
 * built as. `indexes` are its GPUs as nvidia-smi numbers them.
 */
export function nodeTopology(model: string, indexes: string[], labels: Record<string, string> = {}, pasted?: Link[]): Topology {
    const clique = labels['nvidia.com/gpu.clique'] ?? '';
    const cliqueNote = clique ? ` Its GPUs are in the multi-node NVLink domain ${clique}, with every other node GFD labels with the same clique.` : '';
    const sorted = [...new Set(indexes)].sort((a, b) => Number(a) - Number(b));

    if (pasted) {
        return {
            fabric: 'links',
            links: pasted,
            source: 'pasted',
            sentence: pasted.length ? `${pasted.length} NVLink ${pasted.length === 1 ? 'connection' : 'connections'}, as nvidia-smi on the machine reported them.${cliqueNote}` : `No NVLink between these GPUs, as nvidia-smi on the machine reported it.${cliqueNote}`,
            clique,
        };
    }
    if (sorted.length < 2) {
        return { fabric: 'none', links: [], source: 'none', sentence: sorted.length ? `One GPU: nothing to link it to.${cliqueNote}` : '', clique };
    }

    const wiring = productWiring(model);
    const product = wiring.product || 'this model';
    switch (wiring.fabric) {
        case 'pairs': {
            const links: Link[] = [];
            for (let i = 0; i + 1 < sorted.length; i += 2) links.push(ordered(sorted[i] as string, sorted[i + 1] as string, wiring.kind));
            return {
                fabric: 'pairs',
                links,
                source: 'model',
                sentence: `${product} cards are sold in pairs joined by NVLink bridges. Which cards are paired is read from their order (${links.map((l) => `${l.a}–${l.b}`).join(', ')}); paste nvidia-smi topo -m to confirm it.${cliqueNote}`,
                clique,
            };
        }
        case 'nvswitch': {
            const links: Link[] = [];
            for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) links.push(ordered(sorted[i] as string, sorted[j] as string, wiring.kind));
            return {
                fabric: 'nvswitch',
                links,
                source: 'model',
                sentence: `${product} is an SXM part: on an HGX board NVSwitch joins every GPU to every other at full NVLink bandwidth. Read from the model, not the machine; paste nvidia-smi topo -m to confirm it.${cliqueNote}`,
                clique,
            };
        }
        case 'none':
            return { fabric: 'none', links: [], source: 'model', sentence: `${product} has no NVLink: its GPUs talk over PCIe.${cliqueNote}`, clique };
        default:
            return {
                fabric: 'unknown',
                links: [],
                source: 'none',
                sentence: `Nothing in the cluster says how these GPUs are linked. Paste nvidia-smi topo -m from the machine to draw its NVLinks.${cliqueNote}`,
                clique,
            };
    }
}

/**
 * The GPUs that are linked together, as groups: a bridged pair is a group of
 * two, an NVSwitch board one group of all. A GPU linked to nothing is a group
 * of its own. Groups keep nvidia-smi's order.
 */
export function linkGroups(indexes: string[], links: Link[]): string[][] {
    const parent = new Map(indexes.map((i) => [i, i]));
    const find = (x: string): string => {
        let root = x;
        while (parent.get(root) !== root && parent.get(root) !== undefined) root = parent.get(root) as string;
        parent.set(x, root);
        return root;
    };
    for (const link of links) {
        if (!parent.has(link.a) || !parent.has(link.b)) continue;
        const [ra, rb] = [find(link.a), find(link.b)];
        if (ra !== rb) parent.set(Number(ra) < Number(rb) ? rb : ra, Number(ra) < Number(rb) ? ra : rb);
    }
    const groups = new Map<string, string[]>();
    for (const index of indexes) groups.set(find(index), [...(groups.get(find(index)) ?? []), index]);
    return [...groups.values()].map((g) => g.sort((a, b) => Number(a) - Number(b))).sort((a, b) => Number(a[0]) - Number(b[0]));
}
