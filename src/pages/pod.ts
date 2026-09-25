// The panel on a Pod: the accelerators it has, or is waiting for, and why.

import { buildInventory } from '../model/inventory.js';
import { CLAIMS, NODES, type Pod } from '../model/kube.js';
import { buildWorkloads } from '../model/workloads.js';
import { byId, el, replace } from '../ui/dom.js';
import { loadSnapshot } from '../ui/load.js';
import { remember, start } from '../ui/page.js';
import { clickable, facts, nothing, openName, pill } from '../ui/parts.js';

start('panel', async () => {
    const host = byId('panel');
    const pod = await k8sdockside.object<Pod>();
    const snap = await loadSnapshot({ daemonSets: false });
    const view = buildWorkloads(snap, buildInventory(snap)).pods.find((p) => p.namespace === (pod.metadata.namespace ?? '') && p.name === pod.metadata.name);

    if (!view) {
        replace(host, nothing('This pod asks for no accelerator: no GPU in its limits and no ResourceClaim.'));
        return;
    }

    const devices = el('div', { class: 'held-list' });
    for (const held of view.held) {
        const row = el(
            'div',
            { class: 'held' },
            el('span', { class: 'swatch fill-state-allocated', 'aria-hidden': 'true' }),
            el('strong', {}, held.label),
            el('span', {}, held.model),
            held.node ? el('span', { class: 'faint' }, 'on ', openName(held.node, { kind: NODES, name: held.node }, 'link-name small')) : null,
            el('span', { class: 'spacer' }),
            held.claim ? el('span', { class: 'faint' }, 'via ', openName(held.claim, { kind: CLAIMS, namespace: view.namespace, name: held.claim }, 'link-name small')) : el('span', { class: 'faint' }, held.inferred ? 'device plugin — which card is not reported' : 'device plugin'),
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

    replace(
        host,
        el(
            'div',
            { class: 'panel-head' },
            view.pending ? pill(view.never ? 'can never fit' : 'waiting for devices', view.never ? 'error' : 'warn') : pill(`${view.held.length} ${view.held.length === 1 ? 'device' : 'devices'}`, 'info'),
            el('span', { class: 'faint' }, view.wants.map((w) => w.text).join(', ')),
        ),
        view.pending ? el('p', { class: `wait-reason ${view.never ? 'tone-error' : ''}` }, view.reason) : null,
        view.pending && view.detail ? el('details', {}, el('summary', {}, 'What the scheduler said'), el('p', { class: 'mono detail' }, view.detail)) : null,
        view.held.length ? devices : null,
        !view.pending && view.claims.length ? facts([['Claims', view.claims.join(', ')]]) : null,
    );
});
