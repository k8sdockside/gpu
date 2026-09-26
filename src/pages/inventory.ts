// The inventory: every accelerator as a square, on the machine it is in.
//
// The picture is the point. A node with eight blue squares is full; one with
// a red square has lost a card; a square cut into cells is a GPU split into
// MIG instances; a row of marks along a square's foot is a card time-sliced
// between pods. Pointing at a square fills the inspector on the right with
// what the square is -- model, memory, driver, every attribute its driver
// publishes -- and who is using it, each name a link to the object.
//
// Grouped by node (where is there room?), by model (how many H100s are
// free?) or by driver (what does the DRA driver publish, and what the device
// plugin?). The choice is remembered.

import { type Inventory, type Unit } from '../model/inventory.js';
import { NODES } from '../model/kube.js';
import { count } from '../model/units.js';
import { VENDOR_NAMES } from '../model/vendors.js';
import { byId, el, replace } from '../ui/dom.js';
import { grid, inspector, nodeCard, sourcePills, stateLegend, usePill, type GridOptions } from '../ui/grid.js';
import { dcgmReader, inventoryWithDcgm, loadSnapshot } from '../ui/load.js';
import { every, message, remember, remembered, start } from '../ui/page.js';
import { heading, nothing, openName } from '../ui/parts.js';

type Group = 'node' | 'model' | 'driver';
const GROUPS: [Group, string][] = [
    ['node', 'Node'],
    ['model', 'Model'],
    ['driver', 'Driver'],
];
const REFRESH = 10_000;

start('page', async (ctx) => {
    replace(byId('head'), heading('Inventory', `Every accelerator in ${ctx.contextName}, on the machine it is in.`));
    const body = byId('body');
    const bar = byId('bar');
    const failure = el('p', { class: 'refresh-failure' });

    let group = await remembered<Group>('inventory.group', 'node');
    if (!GROUPS.some(([g]) => g === group)) group = 'node';
    let filter = '';
    // A device chip on another page opens this one on that device.
    let pinned = await remembered<string>('inventory.pin', '');
    if (pinned) void k8sdockside.storage?.remove('inventory.pin')?.catch(() => undefined);
    let hovered: Unit | null = null;
    let inventory: Inventory | null = null;

    const side = el('aside', { class: 'side' });
    const main = el('div', { class: 'groups' });
    const summary = el('p', { class: 'summary' });
    const legendHost = el('div', { class: 'legend-host' });

    const showInspector = () => {
        const unit = hovered ?? inventory?.units.find((u) => u.id === pinned);
        replace(side, inspector(unit));
    };
    const options: GridOptions = {
        onPick: (unit) => {
            pinned = pinned === unit.id ? '' : unit.id;
            hovered = null;
            for (const node of main.querySelectorAll('.gpu.selected')) node.classList.remove('selected');
            if (pinned) main.querySelector(`[data-unit="${CSS.escape(pinned)}"]`)?.classList.add('selected');
            showInspector();
        },
        onHover: (unit) => {
            hovered = unit;
            showInspector();
        },
    };

    // The controls: group by, and a filter over node, model, driver and pod names.
    const segmented = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Group by' });
    const drawButtons = () => {
        replace(
            segmented,
            el('span', { class: 'segmented-label' }, 'Group by'),
            ...GROUPS.map(([g, label]) => {
                const b = el('button', { type: 'button', class: g === group ? 'on' : '', 'aria-pressed': g === group ? 'true' : 'false' }, label);
                b.addEventListener('click', () => {
                    group = g;
                    remember('inventory.group', g);
                    drawButtons();
                    draw();
                });
                return b;
            }),
        );
    };
    drawButtons();
    const search = el('input', { type: 'search', placeholder: 'Filter by node, model, driver or pod', 'aria-label': 'Filter' });
    search.addEventListener('input', () => {
        filter = search.value.trim().toLowerCase();
        draw();
    });
    replace(bar, segmented, search, el('span', { class: 'spacer' }), legendHost);

    const draw = () => {
        if (!inventory) return;
        const units = inventory.units.filter((u) => matches(u, filter));
        replace(legendHost, stateLegend(inventory.units));
        summary.textContent = summaryLine(inventory, units);
        if (inventory.units.length === 0) {
            replace(main, nothing('No accelerators here: no node advertises one through a device plugin, and no DRA driver publishes one.'));
        } else if (units.length === 0) {
            replace(main, nothing(`Nothing matches “${filter}”.`));
        } else if (group === 'node') {
            const shown = new Set(units);
            replace(main, el('div', { class: 'node-cards' }, ...inventory.nodes.filter((n) => n.units.some((u) => shown.has(u))).map((n) => nodeCard({ ...n, units: n.units.filter((u) => shown.has(u)) }, { ...options, selected: pinned }))));
        } else {
            replace(main, ...grouped(units, group, { ...options, selected: pinned }));
        }
        showInspector();
    };

    replace(body, failure, summary, el('div', { class: 'inventory' }, main, side));
    const read = dcgmReader();
    const stop = every(
        REFRESH,
        async () => {
            const snap = await loadSnapshot({ events: false, daemonSets: false });
            ({ inventory } = await inventoryWithDcgm(snap, read));
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

function matches(unit: Unit, filter: string): boolean {
    if (!filter) return true;
    const words = [unit.node, unit.model, unit.name, unit.driver, VENDOR_NAMES[unit.vendor], ...unit.consumers.map((c) => `${c.namespace}/${c.pod}`), ...unit.claims.map((c) => c.name)];
    return words.some((w) => w.toLowerCase().includes(filter));
}

function summaryLine(inv: Inventory, shown: Unit[]): string {
    const nodes = new Set(shown.map((u) => u.node)).size;
    const used = shown.filter((u) => u.state === 'allocated' || u.state === 'shared' || u.state === 'partial').length;
    const lead = shown.length === inv.units.length ? '' : `Showing ${shown.length} of ${inv.units.length}: `;
    return `${lead}${count(shown.length, 'accelerator')} on ${count(nodes, 'node')}, ${used} in use.`;
}

/** Units under a heading each -- a model or a driver -- with a row per node inside. */
function grouped(units: Unit[], by: Exclude<Group, 'node'>, options: GridOptions): HTMLElement[] {
    const groups = new Map<string, Unit[]>();
    for (const unit of units) {
        const key = by === 'model' ? unit.model || `${VENDOR_NAMES[unit.vendor]} (no model reported)` : `${unit.source === 'dra' ? 'DRA' : 'device plugin'} · ${unit.driver === 'nvidia.com/mig' ? 'nvidia.com/mig-*' : unit.driver}`;
        groups.set(key, [...(groups.get(key) ?? []), unit]);
    }
    return [...groups.entries()]
        .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
        .map(([label, members]) => {
            const byNode = new Map<string, Unit[]>();
            for (const unit of members) byNode.set(unit.node, [...(byNode.get(unit.node) ?? []), unit]);
            return el(
                'article',
                { class: 'group-card' },
                el('div', { class: 'node-head' }, el('span', { class: 'group-name' }, label), ...(by === 'model' ? sourcePills(members) : []), el('span', { class: 'spacer' }), usePill(members)),
                el(
                    'div',
                    { class: 'group-rows' },
                    ...[...byNode.entries()].map(([node, list]) =>
                        el('div', { class: 'group-row' }, el('div', { class: 'row-node' }, node ? openName(node, { kind: NODES, name: node }) : el('span', { class: 'faint' }, 'no node')), grid(list, options)),
                    ),
                ),
            );
        });
}
