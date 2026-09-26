// Claims & workloads: who is using what, and who is waiting.
//
// The inventory is drawn from the devices' side; this is the pods' side.
// Waiting pods come first, each with the scheduler's reason in words and the
// scheduler's own sentence under it for anyone who wants it. Then every
// namespace with the pods in it and the devices each one holds -- a device
// chip opens the inventory on that device -- and then the ResourceClaims
// with what their state means, the templates they are made from, and the
// DeviceClasses they ask for.

import { classDriver, type RequestView } from '../model/dra.js';
import { CLAIMS, CLASSES, NODES, PODS, TEMPLATES, type DeviceClass } from '../model/kube.js';
import { count } from '../model/units.js';
import { buildWorkloads, type ClaimView, type Held, type PodView, type TemplateView, type Workloads } from '../model/workloads.js';
import { byId, el, replace } from '../ui/dom.js';
import { dcgmReader, inventoryWithDcgm, loadSnapshot, servesDra } from '../ui/load.js';
import { ago, every, message, remember, start } from '../ui/page.js';
import { block, clickable, heading, nothing, openName, pill, tile } from '../ui/parts.js';

const REFRESH = 10_000;

start('page', async (ctx) => {
    replace(byId('head'), heading('Claims & workloads', `Who is using the accelerators in ${ctx.contextName}, and who is waiting for one.`));
    const body = byId('body');
    const failure = el('p', { class: 'refresh-failure' });
    let filter = '';
    let last: { work: Workloads; classes: DeviceClass[]; dra: boolean } | null = null;

    const search = el('input', { type: 'search', placeholder: 'Filter by namespace, pod or claim', 'aria-label': 'Filter' });
    search.addEventListener('input', () => {
        filter = search.value.trim().toLowerCase();
        draw();
    });
    replace(byId('bar'), search);

    const draw = () => {
        if (!last) return;
        const { work, classes, dra } = last;
        const pods = work.pods.filter((p) => !filter || `${p.namespace}/${p.name} ${p.claims.join(' ')}`.toLowerCase().includes(filter));
        const claims = work.claims.filter((c) => !filter || `${c.namespace}/${c.name} ${c.pods.join(' ')}`.toLowerCase().includes(filter));
        const templates = work.templates.filter((t) => !filter || `${t.namespace}/${t.name}`.toLowerCase().includes(filter));
        replace(
            body,
            failure,
            tiles(work),
            waiting(pods.filter((p) => p.pending)),
            namespaces(pods.filter((p) => !p.pending)),
            dra ? claimBlock(claims) : block('ResourceClaims', '', nothing('This cluster does not serve resource.k8s.io, so there are no claims: every accelerator here goes through a device plugin.')),
            dra && templates.length ? templateBlock(templates) : null,
            dra && classes.length ? classBlock(classes) : null,
        );
    };

    const read = dcgmReader();
    const stop = every(
        REFRESH,
        async () => {
            const snap = await loadSnapshot({ daemonSets: false });
            const { inventory } = await inventoryWithDcgm(snap, read);
            last = { work: buildWorkloads(snap, inventory), classes: snap.classes, dra: servesDra(snap) };
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

function tiles(work: Workloads): HTMLElement {
    const running = work.pods.filter((p) => !p.pending);
    const waiting = work.pods.filter((p) => p.pending);
    const states = (s: ClaimView['state']) => work.claims.filter((c) => c.state === s).length;
    return el(
        'div',
        { class: 'tiles' },
        tile('Pods using devices', String(running.length), `in ${count(new Set(running.map((p) => p.namespace)).size, 'namespace')}`, 'info'),
        tile('Waiting', String(waiting.length), waiting.length ? `${count(waiting.filter((p) => p.never).length, 'pod')} can never fit` : 'no pod is waiting', waiting.some((p) => p.never) ? 'error' : waiting.length ? 'warn' : 'none'),
        tile('ResourceClaims', String(work.claims.length), `${states('reserved')} in use · ${states('allocated')} idle · ${states('pending')} pending`, 'accent'),
        tile('Claim templates', String(work.templates.length), `${work.templates.reduce((n, t) => n + t.pods, 0)} pods use them`, 'none'),
    );
}

/** Pods the scheduler has not placed, each with why in words. */
function waiting(pods: PodView[]): HTMLElement | null {
    if (pods.length === 0) return null;
    const list = el('div', { class: 'waits' });
    for (const pod of pods) {
        const card = el(
            'article',
            { class: `wait ${pod.never ? 'wait-never' : ''}` },
            el(
                'div',
                { class: 'wait-head' },
                openName(pod.name, { kind: PODS, namespace: pod.namespace, name: pod.name }, 'link-name strong'),
                el('span', { class: 'faint' }, pod.namespace),
                pill(pod.never ? 'can never fit' : 'waiting', pod.never ? 'error' : 'warn'),
                el('span', { class: 'spacer' }),
                el('span', { class: 'faint' }, pod.created ? `for ${ago(pod.created)}` : ''),
            ),
            el('p', { class: 'wait-reason' }, pod.reason),
            el('p', { class: 'wait-wants' }, 'Asks for ', pod.wants.map((w) => w.text).join(', ') || 'devices', '.'),
            pod.detail ? el('details', {}, el('summary', {}, 'What the scheduler said'), el('p', { class: 'mono detail' }, pod.detail)) : null,
        );
        list.append(card);
    }
    return block(`Waiting (${pods.length})`, 'Pods asking for accelerators that the scheduler has not placed.', list);
}

/** Every namespace, its pods, and the devices each one holds. */
function namespaces(pods: PodView[]): HTMLElement {
    if (pods.length === 0) return block('In use', '', nothing('No running pod holds an accelerator.'));
    const byNs = new Map<string, PodView[]>();
    for (const pod of pods) byNs.set(pod.namespace, [...(byNs.get(pod.namespace) ?? []), pod]);
    const sections = [...byNs.entries()].map(([ns, list]) => {
        const devices = list.reduce((n, p) => n + p.held.length, 0);
        return el(
            'section',
            { class: 'ns' },
            el('div', { class: 'ns-head' }, el('span', { class: 'ns-name' }, ns), el('span', { class: 'faint' }, `${count(list.length, 'pod')} · ${count(devices, 'device')}`)),
            el('ul', { class: 'ns-pods' }, ...list.map(podRow)),
        );
    });
    return block('In use, by namespace', 'Each device chip opens the inventory on that device.', el('div', { class: 'ns-list' }, ...sections));
}

function podRow(pod: PodView): HTMLElement {
    return el(
        'li',
        { class: 'pod-row' },
        el(
            'div',
            { class: 'pod-who' },
            openName(pod.name, { kind: PODS, namespace: pod.namespace, name: pod.name }),
            pod.node ? el('span', { class: 'faint' }, 'on ', openName(pod.node, { kind: NODES, name: pod.node }, 'link-name small')) : null,
        ),
        el('span', { class: 'arrow', 'aria-hidden': 'true' }, '→'),
        el('div', { class: 'chips' }, ...(pod.held.length ? pod.held.map(chip) : [el('span', { class: 'faint' }, pod.wants.map((w) => w.text).join(', '))])),
    );
}

/** One held device, as a chip that opens the inventory on it. */
function chip(held: Held): HTMLElement {
    const node = el(
        'span',
        { class: `chip ${held.inferred ? 'chip-inferred' : ''}`, title: `${held.label}${held.model ? ` — ${held.model}` : ''}${held.node ? ` on ${held.node}` : ''}${held.claim ? `, through claim ${held.claim}` : ', through the device plugin'}` },
        el('span', { class: 'chip-name' }, held.label),
        held.model ? el('span', { class: 'chip-model' }, held.model) : null,
    );
    if (held.unitId) {
        clickable(node, () => {
            remember('inventory.pin', held.unitId);
            void k8sdockside.openView('inventory');
        });
    }
    return node;
}

const STATE_TONE: Record<ClaimView['state'], string> = { reserved: 'info', allocated: 'ok', pending: 'warn', deleting: '' };
const STATE_WORD: Record<ClaimView['state'], string> = { reserved: 'in use', allocated: 'allocated', pending: 'pending', deleting: 'deleting' };

function requestText(requests: RequestView[]): string {
    return requests.map((r) => `${r.count === Infinity ? 'all' : r.count} × ${r.deviceClass}${r.alternatives.length ? ` (or ${r.alternatives.join(', ')})` : ''}${r.adminAccess ? ' (admin access)' : ''}`).join(', ');
}

function claimBlock(claims: ClaimView[]): HTMLElement {
    if (claims.length === 0) return block('ResourceClaims', '', nothing('No ResourceClaims. Pods here get their accelerators from device plugins, or none at all.'));
    const tbody = el('tbody', {});
    for (const c of claims) {
        tbody.append(
            el(
                'tr',
                {},
                el('td', {}, pill(STATE_WORD[c.state], STATE_TONE[c.state]), c.shared ? pill('shared', 'shared') : null),
                el('td', {}, el('div', {}, openName(c.name, { kind: CLAIMS, namespace: c.namespace, name: c.name })), el('div', { class: 'faint small' }, c.namespace)),
                el('td', { class: 'mono small' }, requestText(c.requests)),
                el('td', { class: 'wrap' }, c.held.length ? el('div', { class: 'chips' }, ...c.held.map(chip)) : el('span', { class: 'faint' }, '—')),
                el(
                    'td',
                    { class: 'wrap' },
                    c.pods.length ? el('span', {}, ...c.pods.map((p, i) => el('span', {}, i ? ', ' : '', openName(p, { kind: PODS, namespace: c.namespace, name: p }, 'link-name small')))) : el('span', { class: 'faint' }, 'no pod'),
                ),
                el('td', { class: 'why' }, c.why),
            ),
        );
    }
    return block(
        `ResourceClaims (${claims.length})`,
        'Pending ones first. A claim is allocated when the first pod using it is scheduled, so a pending claim with no pod is waiting for one, not stuck.',
        el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ...['State', 'Claim', 'Asks for', 'Devices', 'Used by', 'What that means'].map((h) => el('th', {}, h)))), tbody)),
    );
}

function templateBlock(templates: TemplateView[]): HTMLElement {
    const tbody = el('tbody', {});
    for (const t of templates) {
        tbody.append(
            el(
                'tr',
                {},
                el('td', {}, openName(t.name, { kind: TEMPLATES, namespace: t.namespace, name: t.name })),
                el('td', { class: 'faint' }, t.namespace),
                el('td', { class: 'mono small' }, requestText(t.requests)),
                el('td', {}, t.pods ? count(t.pods, 'pod') : el('span', { class: 'faint' }, 'no pod')),
            ),
        );
    }
    return block(
        'ResourceClaimTemplates',
        'Each pod that names a template gets a claim of its own, made from it and deleted with the pod.',
        el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ...['Template', 'Namespace', 'Asks for', 'Used by'].map((h) => el('th', {}, h)))), tbody)),
    );
}

function classBlock(classes: DeviceClass[]): HTMLElement {
    const list = el('ul', { class: 'drivers' });
    for (const c of classes) {
        list.append(
            el(
                'li',
                { class: 'driver' },
                openName(c.metadata.name, { kind: CLASSES, name: c.metadata.name }, 'link-name mono'),
                el('span', { class: 'faint' }, classDriver(c) ? `devices of ${classDriver(c)}` : 'selects by its own rules'),
                el('span', { class: 'spacer' }),
                c.spec?.extendedResourceName ? pill(`also answers ${c.spec.extendedResourceName}`, 'dp', 'Pods asking for this extended resource in their limits get a device of this class through DRA') : null,
            ),
        );
    }
    return block('DeviceClasses', 'What a claim can ask for. Drivers install these.', list);
}
