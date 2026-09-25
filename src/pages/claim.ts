// The panel on a ResourceClaim: what it asked for, what it was given, who
// uses it, and what its state means.

import { buildInventory } from '../model/inventory.js';
import { NODES, PODS, TEMPLATES, type ResourceClaim } from '../model/kube.js';
import { buildWorkloads } from '../model/workloads.js';
import { byId, el, replace } from '../ui/dom.js';
import { loadSnapshot } from '../ui/load.js';
import { remember, start } from '../ui/page.js';
import { clickable, facts, openName, pill } from '../ui/parts.js';

const TONE = { reserved: 'info', allocated: 'ok', pending: 'warn', deleting: '' } as const;
const WORD = { reserved: 'in use', allocated: 'allocated, idle', pending: 'pending', deleting: 'deleting' } as const;

start('panel', async () => {
    const host = byId('panel');
    const claim = await k8sdockside.object<ResourceClaim>();
    const snap = await loadSnapshot({ daemonSets: false });
    const ns = claim.metadata.namespace ?? '';
    const view = buildWorkloads(snap, buildInventory(snap)).claims.find((c) => c.namespace === ns && c.name === claim.metadata.name);
    if (!view) throw new Error('the claim is not in the list the cluster returned; it may have just been deleted');

    const devices = el('div', { class: 'held-list' });
    for (const held of view.held) {
        const row = el(
            'div',
            { class: 'held' },
            el('span', { class: `swatch fill-state-${view.shared ? 'shared' : 'allocated'}`, 'aria-hidden': 'true' }),
            el('strong', {}, held.label),
            el('span', {}, held.model),
            held.node ? el('span', { class: 'faint' }, 'on ', openName(held.node, { kind: NODES, name: held.node }, 'link-name small')) : null,
        );
        if (held.unitId) {
            row.title = 'Open the inventory on this device';
            clickable(row, () => {
                remember('inventory.pin', held.unitId);
                void k8sdockside.openView('inventory');
            });
        }
        devices.append(row);
    }

    const rows: [string, Node | string][] = [
        ['Asks for', view.requests.map((r) => `${r.count === Infinity ? 'all' : r.count} × ${r.deviceClass}${r.alternatives.length ? ` (or ${r.alternatives.join(', ')})` : ''}`).join(', ') || 'nothing'],
        ['Used by', view.pods.length ? el('span', {}, ...view.pods.map((p, i) => el('span', {}, i ? ', ' : '', openName(p, { kind: PODS, namespace: ns, name: p }, 'link-name')))) : 'no pod'],
    ];
    if (view.owner) rows.push(['Made for', openName(view.owner, { kind: PODS, namespace: ns, name: view.owner }, 'link-name')]);
    if (view.template) rows.push(['From template', openName(view.template, { kind: TEMPLATES, namespace: ns, name: view.template }, 'link-name')]);

    replace(
        host,
        el('div', { class: 'panel-head' }, pill(WORD[view.state], TONE[view.state]), view.shared ? pill(`shared by ${view.pods.length} pods`, 'shared') : null),
        el('p', { class: 'note', style: 'margin:0 0 8px' }, view.why),
        view.held.length ? devices : null,
        facts(rows),
    );
});
