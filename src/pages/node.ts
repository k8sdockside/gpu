// The panel on a Node: its accelerators as squares, and the one pointed at.
//
// The same grid the inventory draws, for one machine -- which is what you
// want in front of you before draining it: how many cards, how many busy,
// and whose pods they are.

import { buildInventory, isInUse, type Unit } from '../model/inventory.js';
import { PODS, type Node } from '../model/kube.js';
import { byId, el, replace } from '../ui/dom.js';
import { grid, inspector, modelsLine, sourcePills, usePill } from '../ui/grid.js';
import { loadSnapshot } from '../ui/load.js';
import { start } from '../ui/page.js';
import { nothing, openName, pill } from '../ui/parts.js';

start('panel', async () => {
    const host = byId('panel');
    const node = await k8sdockside.object<Node>();
    const snap = await loadSnapshot({ events: false, daemonSets: false });
    const view = buildInventory(snap).nodes.find((n) => n.name === node.metadata.name);

    if (!view) {
        replace(host, nothing('No accelerators on this node: it advertises no GPU or other device through a device plugin, and no DRA driver publishes one here.'));
        return;
    }

    let pinned = '';
    const detail = el('div', { class: 'panel-inspector' });
    const show = (id: string) => replace(detail, id ? inspector(view.units.find((u) => u.id === id)) : users(view.units));
    const squares = grid(view.units, {
        compact: true,
        onPick: (unit) => {
            pinned = pinned === unit.id ? '' : unit.id;
            for (const s of squares.querySelectorAll('.gpu')) s.classList.toggle('selected', s.getAttribute('data-unit') === pinned);
            show(pinned);
        },
        onHover: (unit) => show(unit?.id ?? pinned),
    });
    show('');

    replace(
        host,
        el('div', { class: 'panel-head' }, usePill(view.units), ...sourcePills(view.units), view.unschedulable ? pill('cordoned', 'warn') : null, el('span', { class: 'faint' }, modelsLine(view.units))),
        squares,
        ...view.notes.map((note) => el('p', { class: 'hint' }, note)),
        detail,
    );
});

/**
 * Who holds what on this machine, one line per busy device: what the panel
 * shows until a square is pointed at, because it is the question asked
 * before a drain.
 */
function users(units: Unit[]): HTMLElement {
    const busy = units.filter((u) => isInUse(u) && u.consumers.length > 0);
    if (busy.length === 0) return el('p', { class: 'hint' }, 'No pod holds a device here. Point at a square for its details.');
    return el(
        'div',
        {},
        el(
            'ul',
            { class: 'users' },
            ...busy.map((u) =>
                el(
                    'li',
                    {},
                    el('span', { class: 'mono' }, u.name),
                    ...u.consumers.map((c) => el('span', {}, openName(`${c.namespace}/${c.pod}`, { kind: PODS, namespace: c.namespace, name: c.pod }, 'link-name small'))),
                    u.inferred ? el('span', { class: 'faint' }, '(counted, not reported)') : null,
                ),
            ),
        ),
        el('p', { class: 'hint' }, 'Point at a square for everything about it; click to keep it here.'),
    );
}
