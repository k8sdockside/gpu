// Who is using what, and who is waiting.
//
// The inventory says which devices are held; this says it the other way
// round -- from the pod's side -- and, for a pod that is not running, why
// not, in words. The scheduler already knows why: it writes it into the pod's
// PodScheduled condition ("0/7 nodes are available: 1 node(s) had
// untolerated taint {...}, 6 Insufficient nvidia.com/gpu.") and into a
// FailedScheduling event. That sentence is accurate and unreadable; the job
// here is to turn it into "no node has 4 nvidia.com/gpu free", and to spot
// the pod that can never be scheduled because it asks for more than any node
// has.

import {
    allocatedDevices,
    claimOwnerPod,
    claimState,
    classDeviceType,
    classDriver,
    deviceKey,
    requestedDevices,
    requestsOf,
    reservedPods,
    type ClaimState,
    type RequestView,
} from './dra.js';
import type { Inventory, Unit } from './inventory.js';
import { condition, isLive, isPending, type DeviceClass, type KubeEvent, type Pod, type ResourceClaim, type Snapshot } from './kube.js';
import { CLASS_RESOURCE_PREFIX, podClaims, podDeviceRequests } from './requests.js';
import { count, quantity } from './units.js';
import { isDeviceResource, resourceNoun } from './vendors.js';

/** A device a pod or claim holds, described for a chip. */
export interface Held {
    unitId: string;
    partitionId: string;
    /** "gpu-3", or "1g.10gb on gpu-0" for a MIG instance. */
    label: string;
    node: string;
    model: string;
    /** The claim it came through; '' for the device plugin. */
    claim: string;
    inferred: boolean;
}

/** One thing a pod asks for, as a line: "2 × nvidia.com/gpu", "claim gpu → gpu.example.com". */
export interface Want {
    text: string;
    /** Without the claim's name: "16 × gpu.example.com". */
    short: string;
    count: number;
    all: boolean;
}

export interface PodView {
    namespace: string;
    name: string;
    node: string;
    phase: string;
    pending: boolean;
    created: string;
    wants: Want[];
    held: Held[];
    claims: string[];
    /** Why it is not running, in words; '' when it is. */
    reason: string;
    /** What the scheduler actually said, for anyone who wants it. */
    detail: string;
    /** Set when no node could ever take it, with why. */
    never: string;
}

export interface ClaimView {
    namespace: string;
    name: string;
    state: ClaimState;
    requests: RequestView[];
    held: Held[];
    pods: string[];
    /** The pod it was made for, when it came from a template. */
    owner: string;
    template: string;
    shared: boolean;
    /** What its state means here, in words. */
    why: string;
    created: string;
}

export interface TemplateView {
    namespace: string;
    name: string;
    requests: RequestView[];
    /** Pods naming it right now. */
    pods: number;
}

export interface Workloads {
    pods: PodView[];
    claims: ClaimView[];
    templates: TemplateView[];
    /** What pending pods are waiting for, added up. */
    demand: { pods: number; devices: number; all: boolean };
}

export function buildWorkloads(snap: Pick<Snapshot, 'nodes' | 'pods' | 'claims' | 'templates' | 'classes' | 'events'>, inventory: Inventory): Workloads {
    const classResources = new Set(snap.classes.map((c) => c.spec?.extendedResourceName ?? '').filter((n) => n !== ''));
    const claimsByKey = new Map(snap.claims.map((c) => [`${c.metadata.namespace ?? ''}/${c.metadata.name}`, c]));
    const templatesByKey = new Map(snap.templates.map((t) => [`${t.metadata.namespace ?? ''}/${t.metadata.name}`, t]));
    const classes = new Map(snap.classes.map((c) => [c.metadata.name, c]));
    const limits = capacityLimits(snap.nodes, inventory, classes);

    // Which of a pod's claims ended up on which devices.
    const heldByClaim = new Map<string, Held[]>();
    for (const claim of snap.claims) heldByClaim.set(`${claim.metadata.namespace ?? ''}/${claim.metadata.name}`, claimHeld(claim, inventory));

    const heldByPod = new Map<string, Held[]>();
    for (const unit of inventory.units) {
        if (unit.source !== 'device-plugin') continue;
        const cells = unit.partitions.length ? unit.partitions.map((p) => ({ holders: p.consumers, label: `${p.profile} on ${unit.name}`, partitionId: p.id })) : [{ holders: unit.consumers, label: unit.name, partitionId: '' }];
        for (const cell of cells) {
            for (const c of cell.holders) {
                const key = `${c.namespace}/${c.pod}`;
                heldByPod.set(key, [...(heldByPod.get(key) ?? []), { unitId: unit.id, partitionId: cell.partitionId, label: cell.label, node: unit.node, model: unit.model, claim: '', inferred: unit.inferred }]);
            }
        }
    }

    const pods: PodView[] = [];
    for (const pod of snap.pods) {
        if (!isLive(pod)) continue;
        const ns = pod.metadata.namespace ?? '';
        const requests = podDeviceRequests(pod, classResources);
        const claims = podClaims(pod);
        if (Object.keys(requests).length === 0 && claims.length === 0) continue;

        const wants: Want[] = [];
        for (const [resource, n] of Object.entries(requests)) {
            if (n > 0) wants.push({ text: `${n} × ${resource.replace(CLASS_RESOURCE_PREFIX, 'class ')}`, short: `${n} × ${resource.replace(CLASS_RESOURCE_PREFIX, 'class ')}`, count: n, all: false });
        }
        const held: Held[] = [...(heldByPod.get(`${ns}/${pod.metadata.name}`) ?? [])];
        const names: string[] = [];
        let missingClaim = '';
        for (const c of claims) {
            const claim = c.claim ? claimsByKey.get(`${ns}/${c.claim}`) : undefined;
            const template = c.template ? templatesByKey.get(`${ns}/${c.template}`) : undefined;
            const reqs = requestsOf(claim?.spec ?? template?.spec?.spec);
            const n = requestedDevices(reqs);
            const classesAsked = [...new Set(reqs.map((r) => r.deviceClass).filter((x) => x))].join(', ');
            wants.push({
                text: `${n.all ? 'all' : n.count} × ${classesAsked || 'device'} (claim ${c.claim || c.entry}${c.template ? ` from template ${c.template}` : ''})`,
                short: `${n.all ? 'all' : n.count} × ${classesAsked || 'device'}`,
                count: n.count,
                all: n.all,
            });
            if (c.claim) names.push(c.claim);
            if (c.claim && !claim && !c.template) missingClaim = c.claim;
            if (!c.claim && c.template && !template) missingClaim = `template ${c.template}`;
            if (claim) held.push(...(heldByClaim.get(`${ns}/${claim.metadata.name}`) ?? []));
        }

        const pending = isPending(pod);
        const view: PodView = {
            namespace: ns,
            name: pod.metadata.name,
            node: pod.spec?.nodeName ?? '',
            phase: pod.status?.phase ?? 'Pending',
            pending,
            created: pod.metadata.creationTimestamp ?? '',
            wants,
            held: dedupe(held),
            claims: names,
            reason: '',
            detail: '',
            never: '',
        };
        if (pending) explain(view, pod, snap.events, requests, claims.map((c) => requestsOf((c.claim ? claimsByKey.get(`${ns}/${c.claim}`) : undefined)?.spec ?? (c.template ? templatesByKey.get(`${ns}/${c.template}`) : undefined)?.spec?.spec)), limits, missingClaim);
        pods.push(view);
    }
    pods.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name, undefined, { numeric: true }));

    const podsByName = new Map(pods.map((p) => [`${p.namespace}/${p.name}`, p]));
    const claims: ClaimView[] = snap.claims.map((claim) => {
        const ns = claim.metadata.namespace ?? '';
        const users = reservedPods(claim);
        const owner = claimOwnerPod(claim);
        const naming = pods.filter((p) => p.namespace === ns && p.claims.includes(claim.metadata.name)).map((p) => p.name);
        const view: ClaimView = {
            namespace: ns,
            name: claim.metadata.name,
            state: claimState(claim),
            requests: requestsOf(claim.spec),
            held: heldByClaim.get(`${ns}/${claim.metadata.name}`) ?? [],
            pods: users,
            owner,
            template: templateOf(claim, snap.pods),
            shared: users.length > 1,
            why: '',
            created: claim.metadata.creationTimestamp ?? '',
        };
        view.why = claimWhy(view, [...new Set([...naming, ...(owner ? [owner] : [])])].map((name) => podsByName.get(`${ns}/${name}`)).filter((p): p is PodView => p !== undefined));
        return view;
    });
    claims.sort((a, b) => stateOrder(a.state) - stateOrder(b.state) || a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));

    const templates: TemplateView[] = snap.templates.map((t) => ({
        namespace: t.metadata.namespace ?? '',
        name: t.metadata.name,
        requests: requestsOf(t.spec?.spec),
        pods: snap.pods.filter((p) => isLive(p) && p.metadata.namespace === t.metadata.namespace && (p.spec?.resourceClaims ?? []).some((c) => c.resourceClaimTemplateName === t.metadata.name)).length,
    }));

    const waiting = pods.filter((p) => p.pending);
    return {
        pods,
        claims,
        templates,
        demand: { pods: waiting.length, devices: waiting.reduce((n, p) => n + p.wants.reduce((m, w) => m + w.count, 0), 0), all: waiting.some((p) => p.wants.some((w) => w.all)) },
    };
}

function stateOrder(state: ClaimState): number {
    return { pending: 0, deleting: 1, allocated: 2, reserved: 3 }[state];
}

function dedupe(held: Held[]): Held[] {
    const seen = new Set<string>();
    return held.filter((h) => {
        const key = `${h.unitId}/${h.partitionId}/${h.claim}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** The devices a claim was given, found in the inventory. */
function claimHeld(claim: ResourceClaim, inventory: Inventory): Held[] {
    const out: Held[] = [];
    for (const result of allocatedDevices(claim)) {
        const entry = inventory.byKey.get(deviceKey(result.driver ?? '', result.pool ?? '', result.device ?? ''));
        const unit: Unit | undefined = entry?.unit;
        out.push({
            unitId: unit?.id ?? '',
            partitionId: entry?.partition?.id ?? '',
            label: entry?.partition ? `${entry.partition.profile || entry.partition.name} on ${unit?.name ?? ''}` : (result.device ?? ''),
            node: unit?.node ?? '',
            model: unit?.model ?? '',
            claim: claim.metadata.name,
            inferred: false,
        });
    }
    return out;
}

/** The template a claim was made from, found through the pod that owns it. */
function templateOf(claim: ResourceClaim, pods: Pod[]): string {
    const owner = claimOwnerPod(claim);
    const entry = claim.metadata.annotations?.['resource.kubernetes.io/pod-claim-name'];
    if (!owner || !entry) return '';
    const pod = pods.find((p) => p.metadata.name === owner && p.metadata.namespace === claim.metadata.namespace);
    return pod?.spec?.resourceClaims?.find((c) => c.name === entry)?.resourceClaimTemplateName ?? '';
}

function claimWhy(claim: ClaimView, pods: PodView[]): string {
    switch (claim.state) {
        case 'deleting':
            return 'Being deleted. Its devices go back to the pool once the pods using it are gone.';
        case 'reserved':
            return claim.shared ? `Shared by ${count(claim.pods.length, 'pod')}: they use the same ${claim.held.length === 1 ? 'device' : 'devices'} at once.` : `In use by ${claim.pods[0] ?? 'a pod'}.`;
        case 'allocated':
            return 'Devices are set aside for it, but no pod is using it right now.';
        case 'pending': {
            const waiting = pods.find((p) => p.pending);
            if (waiting) {
                const why = waiting.never || waiting.reason || 'The scheduler has not placed it yet.';
                return `Not allocated: ${waiting.name} is waiting. ${why}`;
            }
            if (pods.length === 0) return 'Not allocated, and no pod uses it. Devices are allocated when the first pod using the claim is scheduled.';
            return 'Not allocated yet. The scheduler allocates it together with the pod that uses it.';
        }
    }
}

// ----- why a pod is waiting --------------------------------------------------------------

/** The most any single node can offer, per extended resource and per DRA device class. */
export interface Limits {
    resources: Map<string, number>;
    classes: Map<string, number>;
    /** Extended resource names a DeviceClass serves through DRA, and the class. */
    extended: Map<string, string>;
}

/**
 * What the biggest node has, which is what "could this ever fit?" is asked
 * against. For a device class, the driver its CEL selects on says which
 * devices it could be given, and NVIDIA's `type` split keeps whole GPUs and
 * MIG instances apart. A class that selects some other way is not judged.
 */
export function capacityLimits(nodes: Snapshot['nodes'], inventory: Inventory, classes: Map<string, DeviceClass>): Limits {
    const resources = new Map<string, number>();
    for (const node of nodes) {
        for (const [name, value] of Object.entries(node.status?.allocatable ?? {})) {
            if (!isDeviceResource(name)) continue;
            resources.set(name, Math.max(resources.get(name) ?? 0, quantity(value)));
        }
    }
    const classLimits = new Map<string, number>();
    const extended = new Map<string, string>();
    for (const [name, deviceClass] of classes) {
        if (deviceClass.spec?.extendedResourceName) extended.set(deviceClass.spec.extendedResourceName, name);
        const driver = classDriver(deviceClass);
        if (!driver) continue;
        const type = classDeviceType(deviceClass);
        const perNode = new Map<string, number>();
        for (const unit of inventory.units) {
            if (unit.source !== 'dra' || unit.driver !== driver || unit.state === 'unhealthy') continue;
            const n = type === 'mig' ? unit.partitions.filter((p) => !p.dynamic && p.state !== 'unhealthy').length : 1;
            perNode.set(unit.node, (perNode.get(unit.node) ?? 0) + n);
        }
        classLimits.set(name, Math.max(0, ...perNode.values()));
    }
    return { resources, classes: classLimits, extended };
}

function explain(view: PodView, pod: Pod, events: KubeEvent[], requests: Record<string, number>, claimRequests: RequestView[][], limits: Limits, missingClaim: string): void {
    const scheduled = condition(pod.status?.conditions, 'PodScheduled');
    const event = events
        .filter((e) => e.reason === 'FailedScheduling' && e.involvedObject?.kind === 'Pod' && e.involvedObject.name === pod.metadata.name && e.involvedObject.namespace === pod.metadata.namespace)
        .sort((a, b) => (b.lastTimestamp ?? b.eventTime ?? '').localeCompare(a.lastTimestamp ?? a.eventTime ?? ''))[0];
    const message = scheduled?.status === 'False' && scheduled.message ? scheduled.message : (event?.message ?? '');
    view.detail = message;

    // Can it ever fit? Asked of the biggest node, whatever the others are doing.
    const nevers: string[] = [];
    const judgeClass = (deviceClass: string, n: number) => {
        const most = limits.classes.get(deviceClass);
        if (most === undefined) return;
        if (most === 0) nevers.push(`no node has a ${deviceClass} device`);
        else if (n > most) nevers.push(`it asks for ${count(n, `${deviceClass} device`)} and the biggest node has ${most}`);
    };
    for (const [resource, n] of Object.entries(requests)) {
        if (resource.startsWith(CLASS_RESOURCE_PREFIX)) judgeClass(resource.slice(CLASS_RESOURCE_PREFIX.length), n);
        else if (limits.resources.has(resource)) {
            const most = limits.resources.get(resource) ?? 0;
            if (n > most) nevers.push(`it asks for ${n} ${resource} and the biggest node has ${most}`);
        } else if (limits.extended.has(resource)) judgeClass(limits.extended.get(resource) ?? '', n);
        else nevers.push(`no node has any ${resource}`);
    }
    for (const reqs of claimRequests) {
        for (const request of reqs) {
            if (request.adminAccess || request.count === Infinity || request.alternatives.length > 0) continue;
            judgeClass(request.deviceClass, request.count);
        }
    }
    if (missingClaim) {
        view.reason = `It uses ${missingClaim.startsWith('template ') ? 'ResourceClaimTemplate ' + missingClaim.slice(9) : 'ResourceClaim ' + missingClaim}, which does not exist.`;
        return;
    }
    if (nevers.length) {
        view.never = `This can never be scheduled: ${nevers.join('; ')}.`;
        view.reason = view.never;
        return;
    }
    view.reason = message ? plainReason(message) : scheduled?.status === 'False' ? 'The scheduler could not place it yet.' : 'Waiting for the scheduler.';
}

/**
 * The scheduler's "0/7 nodes are available: ..." in words.
 *
 * The part after the colon is a comma-separated list of "<n> <why>". Each
 * why the scheduler has is mapped to a plain phrase; one it does not know is
 * kept as it is written.
 */
export function plainReason(message: string): string {
    const match = /^\s*0\/(\d+) nodes are available:\s*(.*?)(?:\.\s*preemption:.*)?\.?\s*$/s.exec(message);
    if (!match) {
        if (/resourceclaim .* not found|not found.*resourceclaim/i.test(message)) return 'A ResourceClaim it uses does not exist yet.';
        return message.trim();
    }
    const parts = (match[2] ?? '').split(/,\s+(?=\d+\s)/);
    const phrases: [number, string][] = [];
    let short = '';
    for (const part of parts) {
        const m = /^(\d+)\s+(.*)$/.exec(part.trim());
        if (!m) continue;
        const n = Number(m[1]);
        const why = (m[2] ?? '').trim();
        const nodes = count(n, 'node');
        let phrase: string;
        const insufficient = /^Insufficient\s+(\S+)/.exec(why);
        if (insufficient) {
            const resource = insufficient[1] ?? '';
            phrase = `${nodes} ${n === 1 ? 'does' : 'do'} not have enough ${resource} free`;
            if (isDeviceResource(resource)) short = `No node has enough free ${resourceNoun(resource)}s (${resource})`;
        } else if (/cannot allocate all claims/i.test(why)) {
            phrase = `${nodes} ${n === 1 ? 'has' : 'have'} no free device that matches its claims`;
            short = 'No node has a free device that matches its claims';
        } else if (/untolerated taint/i.test(why)) {
            phrase = `${nodes} ${n === 1 ? 'is' : 'are'} tainted and it does not tolerate that`;
        } else if (/didn't match Pod's node affinity\/selector/i.test(why)) {
            phrase = `${nodes} ${n === 1 ? 'does' : 'do'} not match its node selector`;
        } else if (/unschedulable/i.test(why)) {
            phrase = `${nodes} ${n === 1 ? 'is' : 'are'} cordoned`;
        } else if (/resourceclaim.*not found|waiting for .*claim/i.test(why)) {
            phrase = `its claim is not ready (${why})`;
        } else if (/Too many pods/i.test(why)) {
            phrase = `${nodes} ${n === 1 ? 'is' : 'are'} full of pods`;
        } else {
            phrase = `${nodes}: ${why}`;
        }
        phrases.push([n, phrase]);
    }
    const list = phrases.map(([, p]) => p).join('; ');
    if (short) return `${short}. Of ${count(Number(match[1]), 'node')}: ${list}.`;
    return `None of the ${count(Number(match[1]), 'node')} can take it: ${list}.`;
}
