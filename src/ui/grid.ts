// The device grid: one square per accelerator, and the inspector that says
// everything about the one under the pointer.
//
// A square is a <button>, so it takes focus and answers Enter and Space like
// one. Its colour is its state -- free, in use, shared, partly in use,
// unhealthy -- set by class, so the app's theme colours it. A GPU split into
// MIG instances is drawn as cells across the square, each as wide as the
// compute slices it takes; a time-sliced card has a row of slot marks along
// its foot, one per replica, filled for each pod on it.

import { isInUse, type Consumer, type NodeView, type Partition, type Unit, type UnitState } from '../model/inventory.js';
import { NODES, PODS, CLAIMS, SLICES } from '../model/kube.js';
import { count, memory } from '../model/units.js';
import { VENDOR_NAMES } from '../model/vendors.js';
import { el } from './dom.js';
import { facts, legend, openName, pill, type Slice } from './parts.js';

export const STATE_WORDS: Record<UnitState, string> = {
    free: 'Free',
    allocated: 'In use',
    shared: 'Shared',
    partial: 'Partly in use',
    unhealthy: 'Unhealthy',
};

const STATE_TONES: Record<UnitState, string> = { free: 'ok', allocated: 'info', shared: 'shared', partial: 'info', unhealthy: 'error' };

/** The legend for the grid: every state, with how many there are when counts are given. */
export function stateLegend(units: Unit[], counts = false): HTMLElement {
    const slices: Slice[] = (['free', 'allocated', 'shared', 'partial', 'unhealthy'] as UnitState[])
        .map((state) => ({ label: STATE_WORDS[state], count: units.filter((u) => u.state === state).length, tone: `state-${state}` }))
        .filter((s) => !counts || s.count > 0 || s.tone === 'state-free' || s.tone === 'state-allocated');
    return legend(slices, { counts });
}

/** Everything a square says on hover, as one string for its title. */
export function unitTitle(unit: Unit): string {
    const lines = [`${unit.name} — ${[unit.model, memory(unit.memory)].filter(Boolean).join(', ') || VENDOR_NAMES[unit.vendor]}`, STATE_WORDS[unit.state]];
    if (unit.live?.util !== undefined) lines.push(`${Math.round(unit.live.util * 100)}% busy${unit.live.memoryUsed !== undefined ? `, ${memory(unit.live.memoryUsed) || '0'} in memory` : ''}`);
    if (unit.consumers.length) lines.push(`Used by ${unit.consumers.map((c) => c.pod).join(', ')}`);
    else if (unit.claims.length) lines.push(`Held by claim ${unit.claims.map((c) => c.name).join(', ')}`);
    if (unit.partitions.length) lines.push(`${unit.partitions.length} partitions: ${unit.partitions.map((p) => `${p.profile} ${p.state === 'free' ? 'free' : p.state === 'unhealthy' ? 'unhealthy' : 'in use'}`).join(', ')}`);
    if (unit.slots > 1) lines.push(`${unit.sharing || 'Shared'}: ${Math.min(unit.consumers.length, unit.slots)} of ${unit.slots} slots taken`);
    if (unit.problem) lines.push(unit.problem);
    return lines.join('\n');
}

export interface GridOptions {
    selected?: string;
    onPick?: (unit: Unit) => void;
    onHover?: (unit: Unit | null) => void;
    /** Smaller squares, for a panel. */
    compact?: boolean;
}

/** One device as a square. */
export function square(unit: Unit, options: GridOptions = {}): HTMLElement {
    const classes = ['gpu', `gpu-${unit.state}`];
    if (unit.partitions.length) classes.push('gpu-cut');
    if (unit.slots > 1) classes.push('gpu-sliced');
    if (options.selected === unit.id) classes.push('selected');
    const node = el('button', { type: 'button', class: classes.join(' '), title: unitTitle(unit), 'aria-label': unitTitle(unit).replace(/\n/g, '. '), 'data-unit': unit.id });

    if (unit.partitions.length) node.append(cells(unit));
    node.append(el('span', { class: 'gpu-label' }, unit.label));
    if (unit.slots > 1) {
        const marks = el('span', { class: 'gpu-slots', 'aria-hidden': 'true' });
        const taken = Math.min(unit.consumers.length, unit.slots);
        for (let i = 0; i < unit.slots; i++) marks.append(el('span', { class: i < taken ? 'slot taken' : 'slot' }));
        node.append(marks);
    }

    node.addEventListener('click', () => options.onPick?.(unit));
    node.addEventListener('mouseenter', () => options.onHover?.(unit));
    node.addEventListener('mouseleave', () => options.onHover?.(null));
    node.addEventListener('focus', () => options.onHover?.(unit));
    return node;
}

/** The MIG cells across a square, each as wide as its slices, and whatever is not carved as a gap. */
function cells(unit: Unit): HTMLElement {
    const row = el('span', { class: 'gpu-cells', 'aria-hidden': 'true' });
    let used = 0;
    for (const partition of unit.partitions) {
        const cell = el('span', { class: `cell cell-${partition.state}` });
        cell.style.flexGrow = String(partition.slices);
        row.append(cell);
        used += partition.slices;
    }
    const rest = Math.max(0, unit.slices - used);
    if (rest > 0) {
        const gap = el('span', { class: 'cell cell-uncut' });
        gap.style.flexGrow = String(rest);
        row.append(gap);
    }
    return row;
}

/** A row of squares. */
export function grid(units: Unit[], options: GridOptions = {}): HTMLElement {
    return el('div', { class: options.compact ? 'gpu-grid compact' : 'gpu-grid', role: 'group' }, ...units.map((unit) => square(unit, options)));
}

/** "8 × H100 80GB HBM3", or several of those joined, for a node's line. */
export function modelsLine(units: Unit[]): string {
    const counts = new Map<string, number>();
    for (const unit of units) {
        const name = [unit.model || VENDOR_NAMES[unit.vendor], memory(unit.memory) && !/\d+\s?GB/i.test(unit.model) ? memory(unit.memory) : ''].filter(Boolean).join(' ');
        counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()].map(([name, n]) => `${n} × ${name}`).join(' · ');
}

/** "5 of 8 in use", with the tone of how full the node is. */
export function usePill(units: Unit[]): HTMLElement {
    const used = units.filter(isInUse).length;
    const bad = units.filter((u) => u.state === 'unhealthy').length;
    const tone = bad ? 'warn' : used === units.length ? 'info' : used === 0 ? 'ok' : '';
    return pill(`${used} of ${units.length} in use${bad ? ` · ${bad} unhealthy` : ''}`, tone);
}

/** Where a node's devices come from, as small pills: "DRA", "device plugin". */
export function sourcePills(units: Unit[]): HTMLElement[] {
    const out: HTMLElement[] = [];
    if (units.some((u) => u.source === 'dra')) out.push(pill('DRA', 'dra', 'Published by a DRA driver in ResourceSlices'));
    if (units.some((u) => u.source === 'device-plugin')) out.push(pill('device plugin', 'dp', 'Advertised by a device plugin as an extended resource'));
    if (units.some((u) => u.live)) out.push(pill('DCGM', 'dp', 'NVIDIA’s DCGM exporter, through Prometheus: which card is which, who has it, and how busy it is'));
    return out;
}

/** A node's card: its name, what it has, how busy it is, and the squares. */
export function nodeCard(view: NodeView, options: GridOptions = {}): HTMLElement {
    const name = view.name ? openName(view.name, { kind: NODES, name: view.name }, 'link-name node-name') : el('span', { class: 'node-name' }, 'Not tied to a node');
    const flags: (HTMLElement | null)[] = [
        !view.ready && view.name ? pill('NotReady', 'error', 'Its devices cannot be used until the node is Ready') : null,
        view.unschedulable ? pill('cordoned', 'warn', 'New pods will not be scheduled here') : null,
    ];
    const versions = [...new Set(view.units.map((u) => u.driverVersion).filter(Boolean))];
    const cuda = [...new Set(view.units.map((u) => u.cudaVersion).filter(Boolean))];
    return el(
        'article',
        { class: 'node-card' },
        el('div', { class: 'node-head' }, name, ...flags, el('span', { class: 'spacer' }), usePill(view.units)),
        el(
            'div',
            { class: 'node-sub' },
            el('span', {}, modelsLine(view.units)),
            ...sourcePills(view.units),
            versions.length ? el('span', { class: 'faint' }, `driver ${versions.join(', ')}${cuda.length ? ` · CUDA ${cuda.join(', ')}` : ''}`) : null,
        ),
        grid(view.units, options),
    );
}

// ----- the inspector ------------------------------------------------------------------

function consumerRow(c: Consumer): HTMLElement {
    return el(
        'li',
        { class: 'who' },
        openName(c.pod, { kind: PODS, namespace: c.namespace, name: c.pod }),
        el('span', { class: 'faint' }, c.namespace),
        c.claim
            ? el('span', { class: 'via' }, 'via ', openName(c.claim, { kind: CLAIMS, namespace: c.namespace, name: c.claim }, 'link-name small'))
            : el('span', { class: 'via', title: c.via ? 'Named in the pod’s env; the scheduler does not know it has this card' : '' }, c.via ? `via ${c.via}` : 'via device plugin'),
    );
}

function partitionRow(p: Partition): HTMLElement {
    return el(
        'li',
        { class: 'part' },
        el('span', { class: `swatch fill-state-${p.state}`, 'aria-hidden': 'true' }),
        el('span', { class: 'mono' }, p.profile || p.name),
        el('span', { class: 'faint' }, memory(p.memory)),
        el('span', { class: 'spacer' }),
        p.consumers.length
            ? el('span', {}, ...p.consumers.map((c, i) => el('span', {}, i ? ', ' : '', openName(c.pod, { kind: PODS, namespace: c.namespace, name: c.pod }, 'link-name small'))))
            : el('span', { class: 'faint' }, p.claims.length ? `claim ${p.claims.map((c) => c.name).join(', ')}` : STATE_WORDS[p.state].toLowerCase()),
    );
}

/**
 * Everything about one device: what it is, where it is, who is using it,
 * and every attribute its driver publishes. Each name opens its object.
 */
export function inspector(unit: Unit | undefined, empty = 'Point at a device to see what it is and who is using it. Click one to keep it here.'): HTMLElement {
    if (!unit) return el('div', { class: 'inspector empty-inspector' }, el('p', { class: 'faint' }, empty));

    const head = el(
        'div',
        { class: 'inspector-head' },
        el('span', { class: `swatch big fill-state-${unit.state}`, 'aria-hidden': 'true' }),
        el('div', {}, el('div', { class: 'inspector-name' }, unit.name), el('div', { class: 'faint' }, unit.model || VENDOR_NAMES[unit.vendor])),
        el('span', { class: 'spacer' }),
        pill(STATE_WORDS[unit.state], STATE_TONES[unit.state]),
    );

    const rows: [string, Node | string][] = [
        ['Node', unit.node ? openName(unit.node, { kind: NODES, name: unit.node }) : 'not tied to a node'],
        ['Vendor', VENDOR_NAMES[unit.vendor]],
        ['Memory', memory(unit.memory)],
        [unit.source === 'dra' ? 'DRA driver' : 'Resource', el('span', { class: 'mono' }, unit.driver)],
    ];
    if (unit.driverVersion) rows.push(['Driver version', unit.driverVersion]);
    if (unit.cudaVersion) rows.push(['CUDA', unit.cudaVersion]);
    if (unit.slots > 1) rows.push(['Sharing', `${unit.sharing || 'shared'}, ${unit.slots} slots — ${Math.min(unit.consumers.length, unit.slots)} taken`]);
    if (unit.device) rows.push(['ResourceSlice', openName(unit.device.slice, { kind: SLICES, name: unit.device.slice }, 'link-name small')]);
    if (unit.uuid) rows.push(['UUID', el('span', { class: 'mono small' }, unit.uuid)]);
    if (unit.pciBus) rows.push(['PCI bus', el('span', { class: 'mono' }, unit.pciBus)]);
    const live = unit.live;
    if (live) {
        if (live.util !== undefined) rows.push(['Utilisation', `${Math.round(live.util * 100)}%`]);
        if (live.memoryUsed !== undefined) rows.push(['Memory in use', live.memoryTotal ? `${memory(live.memoryUsed) || '0'} of ${memory(live.memoryTotal)}` : memory(live.memoryUsed) || '0']);
        if (live.temperature !== undefined) rows.push(['Temperature', `${Math.round(live.temperature)} °C`]);
        if (live.power !== undefined) rows.push(['Power', `${Math.round(live.power)} W`]);
    }

    const who = unit.consumers.length
        ? el('ul', { class: 'whos' }, ...unit.consumers.map(consumerRow))
        : unit.claims.length
          ? el('p', { class: 'note' }, 'Held by ', ...unit.claims.map((c, i) => el('span', {}, i ? ', ' : '', openName(c.name, { kind: CLAIMS, namespace: c.namespace, name: c.name }))), ', which no pod is using right now.')
          : el('p', { class: 'faint', style: 'margin:0' }, unit.state === 'unhealthy' ? 'Nobody — it cannot be handed out.' : 'Nobody. It is free.');

    const attributes = unit.device ? Object.entries(unit.device.attributes).sort(([a], [b]) => a.localeCompare(b)) : [];
    const capacity = unit.device ? Object.entries(unit.device.capacity).sort(([a], [b]) => a.localeCompare(b)) : [];

    return el(
        'div',
        { class: 'inspector' },
        head,
        unit.problem ? el('p', { class: 'problem' }, unit.problem) : null,
        facts(rows),
        el('h3', {}, unit.consumers.length > 1 ? `Used by ${count(unit.consumers.length, 'pod')}` : 'Used by'),
        who,
        unit.inferred && unit.consumers.length
            ? el('p', { class: 'hint' }, 'The device plugin says how many GPUs a pod got, not which ones. Pods are drawn on the cards in order — NVIDIA’s DCGM exporter, scraped by Prometheus, would say exactly.')
            : null,
        !unit.inferred && unit.source === 'device-plugin' && unit.live ? el('p', { class: 'hint' }, 'Which pod has this card is DCGM’s pod mapping, read through Prometheus.') : null,
        unit.partitions.length
            ? el('div', {}, el('h3', {}, `${count(unit.partitions.length, 'partition')} of ${unit.slices} slices`), el('ul', { class: 'parts' }, ...unit.partitions.map(partitionRow)))
            : null,
        attributes.length ? el('div', {}, el('h3', {}, 'Attributes'), el('ul', { class: 'params' }, ...attributes.map(([k, v]) => param(k, v)))) : null,
        capacity.length ? el('div', {}, el('h3', {}, 'Capacity'), el('ul', { class: 'params' }, ...capacity.map(([k, v]) => param(k, v)))) : null,
    );
}

function param(name: string, value: string): HTMLElement {
    return el('li', { class: 'param' }, el('span', { class: 'param-name mono' }, name), el('span', { class: 'param-value mono' }, value));
}
