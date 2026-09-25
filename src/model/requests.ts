// What a pod asks for, through either path.
//
// Through the device plugin a pod writes `nvidia.com/gpu: 2` in a
// container's limits (a request, if given, must equal it -- extended
// resources cannot be overcommitted). Through DRA it names claims in
// `spec.resourceClaims`, each either an existing ResourceClaim or a template
// a claim is made from. Since 1.34 a DeviceClass can also serve an extended
// resource name, so `nvidia.com/gpu: 1` may be answered by DRA on a node
// whose device plugin is gone; and every class is reachable as
// `deviceclass.resource.kubernetes.io/<class>`.

import type { Container, Pod } from './kube.js';
import { quantity } from './units.js';
import { isDeviceResource } from './vendors.js';

/** The implicit extended resource name every DeviceClass answers to (KEP-5004). */
export const CLASS_RESOURCE_PREFIX = 'deviceclass.resource.kubernetes.io/';

/** Whether a resource name in a pod's limits asks for an accelerator, by either path. */
export function isAcceleratorRequest(name: string, classResources: Set<string> = new Set()): boolean {
    return isDeviceResource(name) || name.startsWith(CLASS_RESOURCE_PREFIX) || classResources.has(name);
}

/**
 * How many of each accelerator resource a pod needs at once.
 *
 * The way the scheduler adds it up: the app containers and restartable
 * (sidecar) init containers run together, so they are summed; an ordinary
 * init container runs alone before them, so only the biggest of those
 * counts, and only if it is bigger than the rest.
 */
export function podDeviceRequests(pod: Pod, classResources: Set<string> = new Set()): Record<string, number> {
    const running: Record<string, number> = {};
    const add = (into: Record<string, number>, container: Container) => {
        for (const [name, amount] of Object.entries(wanted(container))) {
            if (isAcceleratorRequest(name, classResources)) into[name] = (into[name] ?? 0) + amount;
        }
    };
    for (const container of pod.spec?.containers ?? []) add(running, container);
    const inits = pod.spec?.initContainers ?? [];
    for (const container of inits) if (container.restartPolicy === 'Always') add(running, container);
    const out = { ...running };
    for (const container of inits) {
        if (container.restartPolicy === 'Always') continue;
        const alone: Record<string, number> = {};
        add(alone, container);
        for (const [name, amount] of Object.entries(alone)) out[name] = Math.max(out[name] ?? 0, amount);
    }
    return out;
}

/** A container's limits, with requests filling in any that are only requested. */
function wanted(container: Container): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [name, value] of Object.entries(container.resources?.requests ?? {})) out[name] = quantity(value);
    for (const [name, value] of Object.entries(container.resources?.limits ?? {})) out[name] = quantity(value);
    return out;
}

/** The claims a pod names, with the ResourceClaim each resolves to (once the controller has made it). */
export interface PodClaim {
    /** The pod's own name for the claim. */
    entry: string;
    /** The ResourceClaim, '' while a template's claim has not been made yet. */
    claim: string;
    template: string;
}

export function podClaims(pod: Pod): PodClaim[] {
    const statuses = new Map((pod.status?.resourceClaimStatuses ?? []).map((s) => [s.name ?? '', s.resourceClaimName ?? '']));
    const out: PodClaim[] = (pod.spec?.resourceClaims ?? []).map((c) => ({
        entry: c.name ?? '',
        claim: c.resourceClaimName ?? statuses.get(c.name ?? '') ?? '',
        template: c.resourceClaimTemplateName ?? '',
    }));
    const extended = pod.status?.extendedResourceClaimStatus?.resourceClaimName;
    if (extended) out.push({ entry: '(extended resource)', claim: extended, template: '' });
    return out;
}
