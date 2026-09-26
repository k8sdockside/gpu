// The dashboard: the questions you open a GPU cluster for.
//
//   How many are there?        the tiles, and the fleet as one bar
//   How many are free?         the same bar, and each model's own
//   Who is waiting, and why?   the waiting tile, and the attention list
//   Is anything broken?        lost GPUs, tainted devices, drivers not ready
//
// It counts both ways a cluster hands out accelerators -- device plugins and
// DRA -- as one fleet, and says which it is looking at.

import { acceleratorDaemons, drivers, issues, type DaemonView, type DriverView, type Issue } from '../model/attention.js';
import { type Inventory, type Tally } from '../model/inventory.js';
import { DAEMONSETS } from '../model/kube.js';
import { count, memory, percent } from '../model/units.js';
import { buildWorkloads, type Workloads } from '../model/workloads.js';
import { chartsBlock } from '../ui/charts.js';
import { byId, button, el, replace } from '../ui/dom.js';
import { STATE_WORDS } from '../ui/grid.js';
import { dcgmReader, inventoryWithDcgm, loadSnapshot, servesDra } from '../ui/load.js';
import { every, message, remember, start } from '../ui/page.js';
import { block, clickable, heading, legend, nothing, openName, pill, ring, stack, tile, type Slice } from '../ui/parts.js';

const REFRESH = 15_000;

start('page', async (ctx) => {
    replace(byId('head'), heading('GPU & Accelerators', `Every accelerator in ${ctx.contextName}, and who is using it.`));
    const body = byId('body');
    const failure = el('p', { class: 'refresh-failure' });
    // The charts are asked for once: they are hours of history, not live counts.
    const charts = chartsBlock();
    const read = dcgmReader();

    const stop = every(
        REFRESH,
        async () => {
            const snap = await loadSnapshot();
            const { inventory } = await inventoryWithDcgm(snap, read);
            const work = buildWorkloads(snap, inventory);
            const daemons = acceleratorDaemons(snap.daemonSets);
            failure.textContent = '';
            document.getElementById('first')?.remove();

            if (inventory.units.length === 0 && work.pods.length === 0) {
                replace(body, failure, empty(ctx, servesDra(snap)), await charts);
                return;
            }
            replace(
                body,
                failure,
                tiles(inventory, work),
                fleet(inventory),
                el('div', { class: 'split' }, models(inventory.byModel), vendors(inventory)),
                attention(issues(inventory, work, daemons)),
                driverBlock(drivers(inventory, snap.slices), daemons, servesDra(snap)),
                await charts,
                links(ctx),
            );
        },
        (err) => {
            failure.textContent = message(err);
        },
    );
    addEventListener('pagehide', stop);
});

function tiles(inv: Inventory, work: Workloads): HTMLElement {
    const t = inv.totals;
    const nodes = inv.nodes.filter((n) => n.name).length;
    const waiting = work.demand;
    return el(
        'div',
        { class: 'tiles' },
        tile('Accelerators', String(t.total), `on ${count(nodes, 'node')}${t.partitions ? ` · ${count(t.partitions, 'MIG instance')}` : ''}`, 'accent'),
        tile('In use', String(t.inUse), t.total ? `${percent(t.inUse, t.total).toFixed(0)}% of the fleet${t.shared ? ` · ${t.shared} shared` : ''}` : 'nothing to use', 'info'),
        tile('Free', String(t.free), t.unhealthy ? `and ${t.unhealthy} more that are unhealthy` : 'ready for the next pod', 'ok'),
        tile(
            'Waiting for',
            waiting.all ? `${waiting.devices}+` : String(waiting.devices),
            waiting.pods ? `${count(waiting.pods, 'pod')} pending` : 'no pod is waiting',
            waiting.pods ? 'warn' : 'none',
        ),
    );
}

/** The whole fleet as one bar: what is in use, shared, free and broken. */
function fleet(inv: Inventory): HTMLElement {
    const t = inv.totals;
    const slices: Slice[] = [
        { label: STATE_WORDS.allocated, count: inv.units.filter((u) => u.state === 'allocated').length, tone: 'state-allocated' },
        { label: STATE_WORDS.partial, count: inv.units.filter((u) => u.state === 'partial').length, tone: 'state-partial' },
        { label: STATE_WORDS.shared, count: t.shared, tone: 'state-shared' },
        { label: STATE_WORDS.free, count: t.free, tone: 'state-free' },
        { label: STATE_WORDS.unhealthy, count: t.unhealthy, tone: 'state-unhealthy' },
    ];
    const open = button('Open the inventory', () => void k8sdockside.openView('inventory'), { class: 'primary' });
    return el(
        'section',
        { class: 'block fleet' },
        el('div', { class: 'fleet-head' }, el('h2', {}, 'The fleet'), el('span', { class: 'spacer' }), open),
        stack(slices, t.total, 'stack big'),
        legend(slices.filter((s) => s.count > 0 || s.tone === 'state-free'), { counts: true }),
    );
}

function models(byModel: Tally[]): HTMLElement {
    const list = el('ul', { class: 'models' });
    for (const t of byModel) {
        const row = el(
            'li',
            { class: 'model' },
            el('span', { class: 'model-count' }, `${t.total}×`),
            el('div', { class: 'model-body' }, el('div', { class: 'model-name' }, t.label, t.memory && !/\d+\s?GB/i.test(t.label) ? el('span', { class: 'faint' }, ` ${memory(t.memory)}`) : null), stack(modelSlices(t), t.total, 'stack thin')),
            el('span', { class: 'model-free' }, el('strong', {}, String(t.free)), ' free'),
        );
        row.title = `${t.inUse} in use, ${t.free} free${t.unhealthy ? `, ${t.unhealthy} unhealthy` : ''}`;
        clickable(row, () => {
            remember('inventory.group', 'model');
            void k8sdockside.openView('inventory');
        });
        list.append(row);
    }
    return block('By model', 'Each row opens the inventory, grouped by model.', list);
}

function modelSlices(t: Tally): Slice[] {
    return [
        { label: 'in use', count: t.inUse, tone: 'state-allocated' },
        { label: 'free', count: t.free, tone: 'state-free' },
        { label: 'unhealthy', count: t.unhealthy, tone: 'state-unhealthy' },
    ];
}

function vendors(inv: Inventory): HTMLElement {
    const tones = ['chart-1', 'chart-3', 'chart-7', 'chart-4', 'chart-5', 'chart-2', 'chart-6', 'chart-8'];
    return ring(
        'By vendor',
        inv.byVendor.map((t, i) => ({ label: t.label, count: t.total, tone: tones[i % tones.length] ?? '' })),
        { unit: 'devices', onPick: () => void k8sdockside.openView('inventory') },
    );
}

function attention(problems: Issue[]): HTMLElement {
    if (problems.length === 0) {
        return block('Needs attention', '', nothing('Nothing. No pod is waiting for a device, no device is lost, and every driver is ready.'));
    }
    const list = el('ul', { class: 'issues' });
    for (const issue of problems.slice(0, 20)) {
        const row = el(
            'li',
            { class: `issue issue-${issue.tone || 'none'}` },
            el('span', { class: `dot dot-${issue.tone || 'none'}` }),
            el('div', { class: 'issue-text' }, el('div', { class: 'issue-title' }, issue.title), el('div', { class: 'issue-detail' }, issue.detail)),
        );
        clickable(row, () => void k8sdockside.open(issue.ref));
        list.append(row);
    }
    return block('Needs attention', problems.length > 20 ? `The worst 20 of ${problems.length}. Each row opens the object.` : 'Worst first. Each row opens the object it is about.', list);
}

function driverBlock(list: DriverView[], daemons: DaemonView[], dra: boolean): HTMLElement {
    const rows = el('ul', { class: 'drivers' });
    for (const d of list) {
        rows.append(
            el(
                'li',
                { class: 'driver' },
                pill(d.kind === 'DRA driver' ? 'DRA' : 'device plugin', d.kind === 'DRA driver' ? 'dra' : 'dp'),
                el('span', { class: 'mono driver-name' }, d.name),
                el('span', { class: 'faint' }, d.vendor),
                el('span', { class: 'spacer' }),
                el('span', { class: 'driver-count' }, d.devices ? `${count(d.devices, 'device')} on ${count(d.nodes, 'node')}` : 'publishes no devices'),
            ),
        );
    }
    const pods = el('ul', { class: 'drivers' });
    for (const d of daemons) {
        pods.append(
            el(
                'li',
                { class: 'driver' },
                el('span', { class: `dot dot-${d.tone || 'none'}` }),
                openName(d.name, { kind: DAEMONSETS, namespace: d.namespace, name: d.name }, 'link-name mono'),
                el('span', { class: 'faint' }, d.namespace),
                el('span', { class: 'spacer' }),
                el('span', { class: 'driver-count' }, `${d.ready} of ${d.desired} ready`),
            ),
        );
    }
    return block(
        'Drivers & device plugins',
        dra ? 'How the accelerators are advertised, and the daemonsets that do it.' : 'This cluster does not serve resource.k8s.io, so only device plugins are read.',
        list.length ? rows : nothing('Nothing advertises an accelerator.'),
        daemons.length ? el('h3', {}, 'Their pods') : null,
        daemons.length ? pods : null,
    );
}

function empty(ctx: K8sDockside.Context, dra: boolean): HTMLElement {
    return el(
        'div',
        {},
        el(
            'div',
            { class: 'banner' },
            el('h2', {}, `No accelerators in ${ctx.contextName}`),
            el(
                'p',
                { class: 'note' },
                'No node advertises a GPU or other device through a device plugin (nvidia.com/gpu, amd.com/gpu …)' +
                    (dra ? ', and no DRA driver publishes one in a ResourceSlice.' : ', and this cluster does not serve Dynamic Resource Allocation (resource.k8s.io).') +
                    ' This page fills in as soon as one does.',
            ),
            el(
                'p',
                { class: 'note', style: 'margin-bottom:0' },
                'No GPU to try it with? The plugin’s repository has a dev/ folder: a kind cluster with the DRA example driver’s simulated GPUs, and a KWOK fleet of fake H100 nodes.',
            ),
        ),
        el(
            'div',
            { class: 'links' },
            button('Dynamic Resource Allocation', () => void k8sdockside.openUrl('https://kubernetes.io/docs/concepts/scheduling-eviction/dynamic-resource-allocation/')),
            button('Device plugins', () => void k8sdockside.openUrl('https://kubernetes.io/docs/concepts/extend-kubernetes/compute-storage-net/device-plugins/')),
            button('Testing without a GPU', () => void k8sdockside.openUrl('https://github.com/k8sdockside/gpu/tree/main/dev')),
        ),
    );
}

function links(ctx: K8sDockside.Context): HTMLElement | null {
    const list = ctx.plugin?.links ?? [];
    if (!list.length) return null;
    return el('div', { class: 'links foot' }, ...list.map((link) => button(link.label, () => void k8sdockside.openUrl(link.url))));
}
