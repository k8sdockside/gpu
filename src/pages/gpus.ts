// GPUs: every card, from every source that can describe it, as one picture.
//
// No one source knows everything about a GPU in Kubernetes:
//
//   the device plugin     that a node has 4 nvidia.com/gpu, and that a pod
//                         asked for 2 -- not which two
//   DRA                   exactly which device a claim was given, with its
//                         UUID -- when the cluster uses DRA at all
//   GFD's node labels     the model, its memory, the driver and CUDA versions
//   DCGM, in Prometheus   each card's index, UUID and PCI bus, the pod
//                         holding it, and how busy and how full it is
//   the pods themselves   which model an inference server has loaded, by
//                         its command line
//   nvidia-smi topo -m    which cards share an NVLink, pasted in; else what
//                         the model is built as
//
// This page puts them together per machine: a card per GPU in nvidia-smi's
// order, cards that share an NVLink framed together, and on each card the
// model it is serving and the pod serving it. Then the same as tables -- the
// models on the GPUs, the cards with their UUIDs and PCI addresses, the
// NVLinks -- and all of it as plain text to copy into a ticket. Each source
// says what it contributed, so a picture drawn from counts is never mistaken
// for one read off the cards.

import { shortUuid, type Dcgm } from '../model/dcgm.js';
import { isInUse, type Inventory, type NodeView, type Unit } from '../model/inventory.js';
import { isLive, NODES, PODS, type Node as KubeNode, type Pod, type Snapshot } from '../model/kube.js';
import { asksScheduler, nvidiaRuntime, visibleDevices } from '../model/visible.js';
import { readServerLoad, servedModels, shortName, type Served, type ServerLoad } from '../model/serving.js';
import { linkGroups, linkLines, nodeTopology, parseTopology, TOPOLOGY_KEY, type Link, type PastedTopologies, type Topology } from '../model/topology.js';
import { count, memory, percent } from '../model/units.js';
import { VENDOR_NAMES } from '../model/vendors.js';
import { byId, button, el, replace } from '../ui/dom.js';
import { STATE_WORDS, modelsLine, sourcePills, usePill } from '../ui/grid.js';
import { dcgmReader, inventoryWithDcgm, loadSnapshot, servesDra } from '../ui/load.js';
import { every, message, remember, remembered, start } from '../ui/page.js';
import { block, clickable, heading, nothing, openName, pill } from '../ui/parts.js';

const REFRESH = 15_000;

interface Card {
    unit: Unit;
    /** The servers running in the pods that hold it. */
    served: Served[];
}

interface Board {
    view: NodeView;
    cards: Card[];
    topology: Topology;
    /** What the page has to say about this machine that its cards cannot. */
    notes: string[];
}

interface Picture {
    snap: Snapshot;
    inventory: Inventory;
    dcgm: Dcgm;
    served: Served[];
    load: Map<string, ServerLoad>;
    boards: Board[];
}

start('page', async (ctx) => {
    replace(byId('head'), heading('GPUs', `Every GPU in ${ctx.contextName}, from every source that describes it, in one picture.`));
    const body = byId('body');
    const failure = el('p', { class: 'refresh-failure' });
    let pasted = await remembered<PastedTopologies>(TOPOLOGY_KEY, {});
    if (!pasted || typeof pasted !== 'object') pasted = {};
    let picture: Picture | null = null;
    // An editor keeps what is typed in it across refreshes: the same element is put back each time.
    const editors = new Map<string, HTMLElement>();

    const setPasted = (node: string, links: PastedTopologies[string] | undefined) => {
        const next = { ...pasted };
        if (links) next[node] = links;
        else delete next[node];
        pasted = next;
        remember(TOPOLOGY_KEY, next);
        if (picture) picture = { ...picture, boards: boards(picture.snap, picture.inventory, picture.served, pasted) };
        draw();
    };

    const editor = (node: string): HTMLElement => {
        let host = editors.get(node);
        if (!host) {
            host = topologyEditor(node, () => pasted[node] !== undefined, setPasted);
            editors.set(node, host);
        }
        host.dispatchEvent(new Event('refresh'));
        return host;
    };

    const draw = () => {
        if (!picture) return;
        const p = picture;
        const units = p.inventory.units;
        if (units.length === 0) {
            replace(body, failure, sourcesBlock(p), nothing('No GPUs here: no node advertises one through a device plugin, no DRA driver publishes one, and DCGM reports none.'));
            return;
        }
        replace(
            body,
            failure,
            summaryLine(p),
            ...p.boards.map((board) => boardCard(board, p.load)),
            modelsBlock(p),
            inventoryBlock(p),
            topologyBlock(p, editor),
            sourcesBlock(p),
            textBlock(p),
        );
    };

    const read = dcgmReader();
    const stop = every(
        REFRESH,
        async () => {
            const snap = await loadSnapshot({ events: false });
            const { inventory, dcgm, panel } = await inventoryWithDcgm(snap, read);
            const served = servedModels(snap.pods);
            picture = { snap, inventory, dcgm, served, load: readServerLoad(panel), boards: boards(snap, inventory, served, pasted) };
            failure.textContent = '';
            document.getElementById('first')?.remove();
            draw();
        },
        (err) => {
            failure.textContent = message(err);
        },
    );
    addEventListener('pagehide', stop);
});

// ----- putting it together ------------------------------------------------------------------

function boards(snap: Snapshot, inventory: Inventory, served: Served[], pasted: PastedTopologies): Board[] {
    const nodes = new Map(snap.nodes.map((n) => [n.metadata.name, n]));
    return inventory.nodes.map((view) => {
        const cards = view.units.map((unit) => ({ unit, served: served.filter((s) => unit.consumers.some((c) => c.namespace === s.namespace && c.pod === s.pod)) }));
        const node: KubeNode | undefined = nodes.get(view.name);
        const model = view.card.product || view.units.find((u) => u.model)?.model || '';
        const topology = nodeTopology(
            model,
            view.units.map((u) => u.label),
            node?.metadata.labels ?? {},
            pasted[view.name],
        );
        return { view, cards, topology, notes: boardNotes(view, snap.pods.filter((p) => isLive(p) && p.spec?.nodeName === view.name), served) };
    });
}

/**
 * The sentences a machine needs: what nothing here says about its cards, and
 * pods that use a GPU the scheduler does not know they have.
 */
function boardNotes(view: NodeView, pods: Pod[], served: Served[]): string[] {
    const notes: string[] = [];
    const counted = view.units.every((u) => u.source === 'device-plugin' && !u.live) && !view.card.product;
    if (counted && view.units.length) {
        notes.push(
            `Only the device plugin describes these cards: it says there are ${view.units.length}, not what they are. GPU feature discovery (node labels) or NVIDIA’s DCGM exporter in Prometheus would name the model, its memory, the driver and each card’s UUID.`,
        );
    }
    const byEnv = pods.filter((p) => visibleDevices(p));
    if (byEnv.length) {
        const vars = [...new Set(byEnv.map((p) => visibleDevices(p)?.env ?? ''))].join(' or ');
        notes.push(
            `${list(byEnv.map((p) => p.metadata.name))} ${byEnv.length === 1 ? 'picks its GPU' : 'pick their GPUs'} with ${vars} instead of asking the scheduler for one. The cards are drawn as in use, but the scheduler still counts them free and may give them to another pod that asks for nvidia.com/gpu.`,
        );
    }
    // A pod naming a card by UUID when nothing here knows the cards' UUIDs.
    const unmatched = byEnv.filter((p) => !view.units.some((u) => u.consumers.some((c) => c.namespace === p.metadata.namespace && c.pod === p.metadata.name)));
    for (const pod of unmatched) {
        const visible = visibleDevices(pod);
        notes.push(
            `${pod.metadata.name} names ${visible?.devices.join(', ')} in ${visible?.env}, and no card here is known by that name: the device plugin numbers its cards but does not say their UUIDs. DCGM or a DRA driver would, or name the card by its index.`,
        );
    }
    const unknown = served.filter((s) => s.node === view.name).map((s) => pods.find((p) => p.metadata.namespace === s.namespace && p.metadata.name === s.pod)).filter((p): p is Pod => p !== undefined && !asksScheduler(p) && !visibleDevices(p));
    if (unknown.length) {
        const one = unknown.length === 1;
        const runtime = unknown.some(nvidiaRuntime) ? ` ${one ? 'It runs' : 'They run'} with NVIDIA’s runtime class, which hands out GPUs outside the scheduler, so` : ' So';
        notes.push(
            `${list(unknown.map((p) => p.metadata.name))} ${one ? 'serves a model here but asks' : 'serve models here but ask'} the scheduler for no GPU and ${one ? 'names' : 'name'} none in NVIDIA_VISIBLE_DEVICES or CUDA_VISIBLE_DEVICES.${runtime} which card ${one ? 'it uses' : 'each uses'} is not in the pod’s spec. Set NVIDIA_VISIBLE_DEVICES on the pod — or better, ask for nvidia.com/gpu — and it is drawn on its card.`,
        );
    }
    return notes;
}

function list(names: string[]): string {
    if (names.length <= 1) return names[0] ?? '';
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "GPU 3", or "gpu-01 / GPU 3" when there is more than one machine to tell apart. */
function gpuName(unit: Unit, many: boolean): string {
    return `${many && unit.node ? `${unit.node} / ` : ''}${unit.label}`;
}

function allocation(card: Card): string {
    if (card.served.length) return [...new Set(card.served.map(shortName))].join(', ');
    if (card.unit.consumers.length) return card.unit.consumers.map((c) => c.pod).join(', ');
    if (card.unit.claims.length) return `claim ${card.unit.claims.map((c) => c.name).join(', ')}`;
    return card.unit.state === 'unhealthy' ? 'unhealthy' : 'free';
}

// ----- the machines ------------------------------------------------------------------------------

function summaryLine(p: Picture): HTMLElement {
    const t = p.inventory.totals;
    const machines = p.boards.filter((b) => b.view.name).length;
    const models = new Set(p.served.map(shortName)).size;
    return el(
        'p',
        { class: 'summary' },
        `${count(t.total, 'GPU')} on ${count(machines, 'machine')}, ${t.inUse} in use`,
        models ? `, serving ${count(models, 'model')}` : '',
        '.',
    );
}

function boardCard(board: Board, load: Map<string, ServerLoad>): HTMLElement {
    const { view, topology } = board;
    const byLabel = new Map(board.cards.map((c) => [c.unit.label, c]));
    const groups = linkGroups(
        board.cards.map((c) => c.unit.label),
        topology.links,
    );
    const row = el('div', { class: 'board-row' });
    for (const group of groups) {
        const cards = group.map((label) => byLabel.get(label)).filter((c): c is Card => c !== undefined);
        if (cards.length === 1 && cards[0]) {
            row.append(gpuCard(cards[0], load));
            continue;
        }
        const kinds = [...new Set(topology.links.filter((l) => group.includes(l.a) && group.includes(l.b)).map((l) => l.kind))];
        const frame = el(
            'div',
            { class: `nvl-group${topology.source === 'model' ? ' guessed' : ''}`, title: topology.sentence },
            el('span', { class: 'nvl-tag' }, `NVLink${kinds.length ? ` · ${kinds.join(', ')}` : ''}${topology.source === 'model' ? ' (from the model)' : ''}`),
        );
        const inner = el('div', { class: 'nvl-cards' });
        cards.forEach((card, i) => {
            if (i > 0 && topology.fabric !== 'nvswitch') inner.append(el('span', { class: 'nvl-bridge', 'aria-hidden': 'true' }));
            inner.append(gpuCard(card, load));
        });
        frame.append(inner);
        if (topology.fabric === 'nvswitch') frame.append(el('div', { class: 'nvl-switch' }, 'NVSwitch — every GPU to every other'));
        row.append(frame);
    }

    const name = view.name ? openName(view.name, { kind: NODES, name: view.name }, 'link-name node-name') : el('span', { class: 'node-name' }, 'Not tied to a node');
    return el(
        'article',
        { class: 'board' },
        el(
            'div',
            { class: 'node-head' },
            name,
            !view.ready && view.name ? pill('NotReady', 'error') : null,
            view.unschedulable ? pill('cordoned', 'warn') : null,
            el('span', { class: 'spacer' }),
            usePill(view.units),
        ),
        el('div', { class: 'node-sub' }, el('span', {}, modelsLine(view.units)), ...sourcePills(view.units), versions(view)),
        row,
        ...board.notes.map((note) => el('p', { class: 'board-note' }, note)),
        topology.sentence ? el('p', { class: 'hint' }, topology.sentence) : null,
        ...view.notes.map((note) => el('p', { class: 'hint' }, note)),
    );
}

function versions(view: NodeView): HTMLElement | null {
    const driver = [...new Set(view.units.map((u) => u.driverVersion).filter(Boolean))];
    const cuda = [...new Set(view.units.map((u) => u.cudaVersion).filter(Boolean))];
    return driver.length ? el('span', { class: 'faint' }, `driver ${driver.join(', ')}${cuda.length ? ` · CUDA ${cuda.join(', ')}` : ''}`) : null;
}

/** One GPU as a card: what it is, how full and busy it is, and what it is serving. */
function gpuCard(card: Card, load: Map<string, ServerLoad>): HTMLElement {
    const { unit } = card;
    const live = unit.live;
    const node = el(
        'div',
        { class: `gpu-card card-${unit.state}`, 'data-unit': unit.id },
        el(
            'div',
            { class: 'card-top' },
            el('span', { class: `swatch fill-state-${unit.state}`, 'aria-hidden': 'true' }),
            el('span', { class: 'card-index' }, /^\d+$/.test(unit.label) ? `GPU ${unit.label}` : unit.name),
            el('span', { class: 'spacer' }),
            el('span', { class: 'card-state' }, STATE_WORDS[unit.state]),
        ),
        el('div', { class: 'card-model' }, unit.model || VENDOR_NAMES[unit.vendor], unit.memory && !/\d+\s?GB/i.test(unit.model) ? el('span', { class: 'faint' }, ` · ${memory(unit.memory)}`) : null),
        unit.uuid || unit.pciBus
            ? el('div', { class: 'card-ids mono' }, unit.uuid ? el('span', { title: unit.uuid }, shortUuid(unit.uuid)) : null, unit.pciBus ? el('span', { title: 'PCI bus' }, unit.pciBus.replace(/^0000/, '')) : null)
            : null,
    );

    if (live) {
        const total = live.memoryTotal ?? unit.memory;
        if (live.memoryUsed !== undefined && total) {
            const bar = el('div', { class: 'meter', role: 'img', 'aria-label': `${memory(live.memoryUsed) || '0'} of ${memory(total)} in use` });
            const fill = el('span', { class: 'meter-fill' });
            fill.style.width = `${percent(live.memoryUsed, total)}%`;
            bar.append(fill);
            node.append(el('div', { class: 'card-meter' }, el('span', { class: 'meter-label' }, `${memory(live.memoryUsed) || '0'} / ${memory(total)}`), bar));
        }
        const numbers = [
            live.util !== undefined ? `${Math.round(live.util * 100)}% busy` : '',
            live.temperature !== undefined ? `${Math.round(live.temperature)} °C` : '',
            live.power !== undefined ? `${Math.round(live.power)} W` : '',
            live.nvlink ? `NVLink ${rate(live.nvlink)}` : '',
        ].filter(Boolean);
        if (numbers.length) node.append(el('div', { class: 'card-numbers' }, numbers.join(' · ')));
    }

    const work = el('div', { class: 'card-work' });
    if (card.served.length) {
        for (const s of card.served) {
            const l = load.get(`${s.namespace}/${s.pod}`);
            work.append(
                el(
                    'div',
                    { class: 'served' },
                    el('div', { class: 'served-head' }, el('strong', { class: 'served-name' }, shortName(s)), pill(s.engine, 'info'), s.tensorParallel > 1 ? pill(`TP ${s.tensorParallel}`, '', 'Tensor parallel: the model is split across this many GPUs') : null),
                    s.model && s.model !== shortName(s) ? el('div', { class: 'served-model mono', title: s.model }, s.model) : null,
                    l ? el('div', { class: 'served-load faint' }, loadLine(l)) : null,
                    el('div', { class: 'served-pod' }, openName(`${s.namespace}/${s.pod}`, { kind: PODS, namespace: s.namespace, name: s.pod }, 'link-name small')),
                    viaLine(unit, s.namespace, s.pod),
                ),
            );
        }
    } else if (unit.consumers.length) {
        for (const c of unit.consumers) work.append(el('div', { class: 'served-pod' }, openName(`${c.namespace}/${c.pod}`, { kind: PODS, namespace: c.namespace, name: c.pod }, 'link-name small'), viaLine(unit, c.namespace, c.pod)));
    } else {
        work.append(el('span', { class: 'faint' }, unit.claims.length ? `held by claim ${unit.claims.map((c) => c.name).join(', ')}` : unit.state === 'unhealthy' ? 'cannot be handed out' : 'nothing on it'));
    }
    if (unit.inferred && unit.consumers.some((c) => !c.via)) work.append(el('div', { class: 'card-guess' }, 'placed by count: the device plugin does not say which card'));
    if (unit.problem) work.append(el('div', { class: 'card-problem' }, unit.problem));
    node.append(work);

    clickable(node, () => {
        remember('inventory.pin', unit.id);
        void k8sdockside.openView('inventory');
    });
    node.title = 'Open the inventory on this GPU';
    return node;
}

/** "via NVIDIA_VISIBLE_DEVICES", under a pod that named its card in its env. */
function viaLine(unit: Unit, namespace: string, pod: string): HTMLElement | null {
    const via = unit.consumers.find((c) => c.namespace === namespace && c.pod === pod)?.via;
    return via ? el('div', { class: 'card-guess', title: 'The scheduler does not know this pod has the card' }, `via ${via}, not the scheduler`) : null;
}

/** Where a card's pod came from, in words: what the "which GPU" column is read from. */
function mappingSource(unit: Unit, served: Served): string {
    const c = unit.consumers.find((x) => x.namespace === served.namespace && x.pod === served.pod);
    if (c?.via) return `the pod’s ${c.via}`;
    if (c?.claim) return 'its ResourceClaim';
    if (unit.inferred) return 'the device plugin’s count (marked ~)';
    return 'DCGM’s pod mapping';
}

function rate(bytes: number): string {
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s'];
    let n = bytes;
    let i = 0;
    while (n >= 1000 && i < units.length - 1) {
        n /= 1000;
        i++;
    }
    return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function loadLine(l: ServerLoad): string {
    return [
        l.running !== undefined ? `${Math.round(l.running)} running` : '',
        l.waiting ? `${Math.round(l.waiting)} waiting` : '',
        l.kvCache !== undefined ? `KV cache ${Math.round(l.kvCache * 100)}%` : '',
        l.tokensPerSecond !== undefined ? `${Math.round(l.tokensPerSecond)} tok/s` : '',
    ]
        .filter(Boolean)
        .join(' · ');
}

// ----- the tables ---------------------------------------------------------------------------------

function table(head: string[], rows: (Node | string)[][]): HTMLElement {
    return el(
        'div',
        { class: 'table-wrap' },
        el(
            'table',
            {},
            el('thead', {}, el('tr', {}, ...head.map((h) => el('th', {}, h)))),
            el('tbody', {}, ...rows.map((cells) => el('tr', {}, ...cells.map((c) => el('td', {}, c))))),
        ),
    );
}

function allCards(p: Picture): Card[] {
    return p.boards.flatMap((b) => b.cards);
}

/** One row per GPU and the model on it -- a model split over two GPUs is on two rows -- and the servers no card was found for. */
function modelsBlock(p: Picture): HTMLElement {
    if (p.served.length === 0) {
        return block(
            'Models on the GPUs',
            '',
            nothing('No inference server among the pods. vLLM, SGLang, TGI, TensorRT-LLM, llama.cpp, NIM, KServe, Triton and Ollama are recognised by their image and command line.'),
        );
    }
    const many = p.boards.length > 1;
    const rows: (Node | string)[][] = [];
    const placed = new Set<Served>();
    for (const card of allCards(p)) {
        for (const s of card.served) {
            placed.add(s);
            rows.push(modelRow(gpuName(card.unit, many), s, card.unit.inferred, p.load));
        }
    }
    for (const s of p.served) {
        if (!placed.has(s)) rows.push(modelRow(s.running ? '—' : 'waiting', s, false, p.load));
    }
    const hasLoad = p.served.some((s) => p.load.has(`${s.namespace}/${s.pod}`));
    const head = ['GPU', 'Short name', 'Source model', 'Engine', 'Namespace', 'Pod', ...(hasLoad ? ['Now'] : [])];
    const sources = [...new Set(allCards(p).flatMap((c) => c.served.map((s) => mappingSource(c.unit, s))))];
    const unplaced = p.served.some((s) => !placed.has(s) && s.running);
    const note = [
        'The model is read from each server’s command line.',
        sources.length ? ` Which GPU it is on, from ${list(sources)}.` : '',
        unplaced ? ' A — is a server whose card cannot be read from the cluster; the notes under its machine say why.' : '',
    ].join('');
    return block(
        'Models on the GPUs',
        note,
        table(
            head,
            rows.map((r) => (hasLoad ? r : r.slice(0, 6))),
        ),
    );
}

function modelRow(gpu: string, s: Served, inferred: boolean, load: Map<string, ServerLoad>): (Node | string)[] {
    const l = load.get(`${s.namespace}/${s.pod}`);
    return [
        el('span', { class: 'mono' }, inferred ? `~${gpu}` : gpu),
        el('strong', {}, shortName(s)),
        el('span', { class: 'mono' }, s.model || '(pulled at run time)'),
        [s.engine, s.tensorParallel > 1 ? `TP ${s.tensorParallel}` : '', s.pipelineParallel > 1 ? `PP ${s.pipelineParallel}` : ''].filter(Boolean).join(' · '),
        s.namespace,
        openName(s.pod, { kind: PODS, namespace: s.namespace, name: s.pod }),
        l ? loadLine(l) : '',
    ];
}

function inventoryBlock(p: Picture): HTMLElement {
    const many = p.boards.length > 1;
    const rows = allCards(p).map((card) => [
        el('span', { class: 'mono' }, gpuName(card.unit, many)),
        card.unit.model ? `${card.unit.vendor === 'nvidia' && !/^NVIDIA\b/i.test(card.unit.model) ? 'NVIDIA ' : ''}${card.unit.model}` : VENDOR_NAMES[card.unit.vendor],
        el('span', { class: 'mono' }, card.unit.uuid || '—'),
        el('span', { class: 'mono' }, card.unit.pciBus || '—'),
        el('span', { class: isInUse(card.unit) ? '' : 'faint' }, `${card.unit.inferred && card.unit.consumers.length ? '~' : ''}${allocation(card)}`),
    ]);
    const missing = allCards(p).some((c) => !c.unit.uuid);
    return block(
        'GPU inventory',
        missing
            ? 'UUIDs and PCI addresses come from DCGM or a DRA driver; a card neither describes is counted from its node, and has none to show.'
            : 'Every card with its UUID and PCI address, and what is allocated on it.',
        table(['GPU', 'Model', 'UUID', 'PCI bus', 'Allocation'], rows),
    );
}

function topologyBlock(p: Picture, editor: (node: string) => HTMLElement): HTMLElement {
    const many = p.boards.length > 1;
    const sections = p.boards
        .filter((b) => b.view.name && b.cards.length > 1)
        .map((b) =>
            el(
                'div',
                { class: 'topo' },
                many ? el('h3', {}, b.view.name) : null,
                b.topology.links.length
                    ? el('ul', { class: 'topo-links mono' }, ...linkLines(b.topology.links).map((line) => el('li', {}, line)))
                    : el('p', { class: 'faint', style: 'margin:0 0 6px' }, b.topology.fabric === 'none' ? 'No NVLink.' : 'Not known.'),
                el('p', { class: 'hint' }, sourceWords(b.topology)),
                editor(b.view.name),
            ),
        );
    if (sections.length === 0) return block('NVLink connections', '', nothing('No machine has more than one GPU, so there is nothing to link.'));
    return block('NVLink connections', 'Which GPUs share an NVLink: what nvidia-smi on the machine says when it has been pasted here, else what the model is built as.', ...sections);
}

function sourceWords(t: Topology): string {
    switch (t.source) {
        case 'pasted':
            return 'From nvidia-smi topo -m, pasted here and kept for this cluster.';
        case 'model':
            return 'From the model, not the machine.';
        default:
            return t.fabric === 'none' ? '' : 'Nothing in the cluster says; paste nvidia-smi topo -m to draw them.';
    }
}

/** The paste box for one node: read what nvidia-smi printed, keep the links, or forget them. */
function topologyEditor(node: string, saved: () => boolean, onSave: (node: string, links: Link[] | undefined) => void): HTMLElement {
    const area = el('textarea', { rows: 7, spellcheck: 'false', placeholder: 'nvidia-smi topo -m\n\n        GPU0    GPU1    GPU2    GPU3\nGPU0     X      NV12    SYS     SYS\n…\n\nor lines like  GPU 0 <-> GPU 1: NV12', 'aria-label': `nvidia-smi topo -m for ${node}` });
    const status = el('span', { class: 'faint' });
    const forget = button('Forget it', () => {
        onSave(node, undefined);
        status.textContent = 'Forgotten: back to what the model says.';
    });
    const save = button(
        'Use this',
        () => {
            const links = parseTopology(area.value);
            if (!links) {
                status.textContent = 'No GPU matrix or GPU <-> GPU lines in that.';
                return;
            }
            onSave(node, links);
            area.value = '';
            status.textContent = `Kept: ${count(links.length, 'NVLink')}.`;
        },
        { class: 'primary' },
    );
    const box = el(
        'details',
        { class: 'topo-edit' },
        el('summary', {}, `Paste nvidia-smi topo -m from ${node}`),
        area,
        el('div', { class: 'topo-buttons' }, save, forget, status),
        k8sdockside.storage ? null : el('p', { class: 'hint' }, 'This version of the app cannot keep it: it is used until the page is closed.'),
    );
    box.addEventListener('refresh', () => {
        forget.hidden = !saved();
    });
    return box;
}

// ----- the sources ----------------------------------------------------------------------------------

interface SourceRow {
    name: string;
    tone: 'ok' | 'warn' | 'none';
    gives: string;
    finding: string;
}

function sourcesBlock(p: Picture): HTMLElement {
    const units = p.inventory.units;
    const dp = units.filter((u) => u.source === 'device-plugin');
    const dra = units.filter((u) => u.source === 'dra');
    const gfd = p.snap.nodes.filter((n) => n.metadata.labels?.['nvidia.com/gpu.product'] || n.metadata.labels?.['nvidia.com/gpu.present'] === 'true');
    const status = p.dcgm.status;
    const engines = [...new Set(p.served.map((s) => s.engine))];
    const pastedBoards = p.boards.filter((b) => b.topology.source === 'pasted').length;
    const modelBoards = p.boards.filter((b) => b.topology.source === 'model' && b.topology.links.length).length;
    const envPods = p.snap.pods.filter((pod) => isLive(pod) && visibleDevices(pod));
    const dpResources = [...new Set(dp.map((u) => (u.driver === 'nvidia.com/mig' ? 'nvidia.com/mig-*' : u.driver)))];

    const rows: SourceRow[] = [
        {
            name: 'Device plugin',
            tone: dp.length ? 'ok' : 'none',
            gives: 'how many GPUs each node has, and how many each pod asked for',
            finding: dp.length ? `${count(dp.length, 'card')} as ${dpResources.join(', ')} on ${count(new Set(dp.map((u) => u.node)).size, 'node')}.` : 'No node advertises a GPU as an extended resource.',
        },
        {
            name: 'Dynamic Resource Allocation',
            tone: dra.length ? 'ok' : 'none',
            gives: 'exactly which device each claim holds, with its UUID and attributes',
            finding: !servesDra(p.snap)
                ? 'This cluster does not serve resource.k8s.io.'
                : dra.length
                  ? `${count(dra.length, 'device')} from ${[...new Set(dra.map((u) => u.driver))].join(', ')}.`
                  : 'Served, but no DRA driver publishes a GPU.',
        },
        {
            name: 'GPU feature discovery',
            tone: gfd.length ? 'ok' : 'none',
            gives: 'the model, its memory, the driver and CUDA versions, as node labels',
            finding: gfd.length ? `${count(gfd.length, 'node')} labelled: ${[...new Set(gfd.map((n) => n.metadata.labels?.['nvidia.com/gpu.product'] ?? '').filter(Boolean))].join(', ') || 'no product named'}.` : 'No node carries nvidia.com/gpu.* labels.',
        },
        {
            name: 'DCGM exporter, in Prometheus',
            tone: status.found ? (status.mapping || units.every((u) => !u.consumers.length) ? 'ok' : 'warn') : 'none',
            gives: 'each card’s index, UUID and PCI bus, the pod holding it, and how busy and full it is',
            finding: dcgmFinding(p.dcgm, p.inventory),
        },
        {
            name: 'Inference servers',
            tone: p.served.length ? 'ok' : 'none',
            gives: 'which model each GPU has loaded, from the server’s command line',
            finding: p.served.length ? `${count(p.served.length, 'server')} (${engines.join(', ')}) serving ${count(new Set(p.served.map(shortName)).size, 'model')}.` : 'None of the pods is a server this page recognises.',
        },
        {
            name: 'Pod env',
            tone: envPods.length ? 'ok' : 'none',
            gives: 'the cards a pod picks with NVIDIA_VISIBLE_DEVICES or CUDA_VISIBLE_DEVICES, outside the scheduler',
            finding: envPods.length ? `${count(envPods.length, 'pod')} ${envPods.length === 1 ? 'names its' : 'name their'} GPUs this way.` : 'No pod names its GPUs in its env.',
        },
        {
            name: 'NVLink topology',
            tone: pastedBoards ? 'ok' : modelBoards ? 'warn' : 'none',
            gives: 'which GPUs share an NVLink',
            finding: pastedBoards
                ? `Pasted from nvidia-smi for ${count(pastedBoards, 'machine')}${modelBoards ? `; ${count(modelBoards, 'machine')} from the model` : ''}.`
                : modelBoards
                  ? `Read from the model for ${count(modelBoards, 'machine')}: nothing in the cluster says. Paste nvidia-smi topo -m to confirm it.`
                  : 'Nothing in the cluster says, and the model does not settle it.',
        },
    ];
    const list = el('ul', { class: 'sources' });
    for (const row of rows) {
        list.append(
            el(
                'li',
                { class: `source source-${row.tone}` },
                el('span', { class: `dot dot-${row.tone === 'none' ? 'none' : row.tone}` }),
                el('div', {}, el('div', { class: 'source-name' }, row.name, el('span', { class: 'faint' }, ` — ${row.gives}`)), el('div', { class: 'source-finding' }, row.finding)),
            ),
        );
    }
    return block('Where this comes from', 'No one source knows everything about a GPU in Kubernetes. What each one said here:', list);
}

function dcgmFinding(dcgm: Dcgm, inventory: Inventory): string {
    const s = dcgm.status;
    if (!s.prometheus) return s.error || 'No Prometheus was found, so which card each pod has is counted rather than read.';
    if (!s.found) return `Prometheus (${s.describe}) has no DCGM metrics. NVIDIA’s dcgm-exporter publishes them; the GPU Operator installs it.`;
    const unmatched = s.unmatched.length ? ` Hosts matching no node: ${s.unmatched.join(', ')}.` : '';
    const mapped = s.mapping
        ? 'with pod mapping, so which pod has which card is read, not counted.'
        : inventory.units.some((u) => u.consumers.length)
          ? 'without pod mapping: turn on DCGM_EXPORTER_KUBERNETES in the exporter to see which pod has which card.'
          : 'and no pod is on them.';
    return `${count(dcgm.gpus.length, 'card')} on ${count(new Set(dcgm.gpus.map((g) => g.node)).size, 'host')} through ${s.describe}, ${mapped}${unmatched}`;
}

// ----- as text ---------------------------------------------------------------------------------------

/**
 * The whole picture as plain text, the way it would be written by hand from
 * nvidia-smi and kubectl: the models on the GPUs, the cards, the NVLinks.
 */
export function asText(p: Pick<Picture, 'boards'>): string {
    const out: string[] = [];
    const many = p.boards.length > 1;
    for (const board of p.boards) {
        if (many) out.push(`== ${board.view.name || 'not tied to a node'} ==`, '');
        const rows: string[][] = [];
        for (const card of board.cards) for (const s of card.served) rows.push([`${card.unit.inferred ? '~' : ''}${card.unit.label}`, shortName(s), s.model, s.namespace, s.pod]);
        if (rows.length) {
            const head = ['GPU', 'SHORT NAME', 'SOURCE MODEL', 'NAMESPACE', 'POD'];
            // At least as wide as the table people write by hand from kubectl, so the two line up.
            const least = [5, 18, 42, 24, 3];
            const widths = head.map((h, i) => (i === head.length - 1 ? 3 : Math.max(least[i] ?? 0, h.length, ...rows.map((r) => (r[i] ?? '').length))));
            const line = (cells: string[]) =>
                cells
                    .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? 0)))
                    .join('  ')
                    .trimEnd();
            out.push(line(head), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line), '');
        }
        out.push('GPU inventory');
        for (const card of board.cards) {
            const u = card.unit;
            const model = u.model ? `${u.vendor === 'nvidia' && !/^NVIDIA\b/i.test(u.model) ? 'NVIDIA ' : ''}${u.model}` : VENDOR_NAMES[u.vendor];
            out.push(`GPU ${u.label}: ${[model, u.uuid, u.pciBus].filter(Boolean).join(' | ')} | allocation: ${allocation(card)}`);
        }
        if (board.topology.links.length) out.push('', 'NVLink connections', ...linkLines(board.topology.links));
        out.push('');
    }
    return out.join('\n').trimEnd() + '\n';
}

function textBlock(p: Picture): HTMLElement {
    const pre = el('pre', { class: 'as-text' }, asText(p));
    return el('details', { class: 'block text-block' }, el('summary', {}, 'As text'), el('p', { class: 'note' }, 'All of the above as plain text, to copy into a ticket or a chat.'), pre);
}
