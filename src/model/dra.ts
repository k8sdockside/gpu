// Dynamic Resource Allocation, read into plain shapes.
//
// A driver publishes what each node has as ResourceSlices: one or more per
// pool, each listing devices with typed attributes and quantities. A claim
// asks for devices of a DeviceClass; the scheduler allocates specific
// devices to it -- by driver, pool and device name -- and records the pods
// using it in `status.reservedFor`.
//
// Three details that are easy to get wrong, and that the tests pin down:
//
//  1. A pool can be spread over several slices, and when a driver
//     republishes it the pool's generation goes up. Slices of an older
//     generation are stale until the driver deletes them; the scheduler
//     ignores them, and so must we, or a node's devices are counted twice.
//  2. v1beta1 nests a device's attributes and capacity under `basic`; v1 and
//     v1beta2 do not. The app lists at the cluster's preferred version, so a
//     1.32 cluster answers in the old shape.
//  3. An attribute name without a domain belongs to the driver: `productName`
//     on a gpu.nvidia.com device is `gpu.nvidia.com/productName`. The two
//     spellings mean the same attribute.

import type { AllocationResult, ClaimSpec, Device, DeviceAttribute, DeviceClass, DeviceRequest, ExactRequest, ResourceClaim, ResourceSlice } from './kube.js';
import { quantity } from './units.js';

/** One device, as a slice publishes it, with the slice's facts folded in. */
export interface SliceDevice {
    driver: string;
    pool: string;
    name: string;
    /** The node it is on: the slice's, or the device's own with per-device node selection; '' for network-attached. */
    node: string;
    slice: string;
    /** Attribute values by their short name ("productName"), each written as a string. */
    attributes: Record<string, string>;
    /** Capacity values as written ("80Gi"). */
    capacity: Record<string, string>;
    /** The counter sets it consumes from: devices sharing one are carved out of the same hardware. */
    counterSets: string[];
    tainted: string;
    /** Whether several claims may be allocated this device at once (consumable capacity, 1.34+). */
    multiple: boolean;
}

/** The key the scheduler writes into an allocation result: driver, pool, device. */
export function deviceKey(driver: string, pool: string, device: string): string {
    return `${driver}/${pool}/${device}`;
}

/** An attribute's value as text, whatever its type. */
export function attributeText(attribute: DeviceAttribute | undefined): string {
    if (!attribute) return '';
    if (attribute.string !== undefined) return attribute.string;
    if (attribute.version !== undefined) return attribute.version;
    if (attribute.int !== undefined) return String(attribute.int);
    if (attribute.bool !== undefined) return attribute.bool ? 'true' : 'false';
    return '';
}

/** Drops the driver's own domain from an attribute name; any other domain is kept. */
export function shortName(name: string, driver: string): string {
    const prefix = `${driver}/`;
    return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/**
 * Every device the cluster's drivers currently publish.
 *
 * Only slices of each pool's newest generation are read (see the top of the
 * file). The result is sorted by node, driver and a natural reading of the
 * device name, so gpu-10 comes after gpu-9.
 */
export function sliceDevices(slices: ResourceSlice[]): SliceDevice[] {
    const newest = new Map<string, number>();
    for (const slice of slices) {
        const key = poolKey(slice);
        const generation = slice.spec?.pool?.generation ?? 0;
        newest.set(key, Math.max(newest.get(key) ?? -Infinity, generation));
    }

    const out: SliceDevice[] = [];
    const seen = new Set<string>();
    for (const slice of slices) {
        const spec = slice.spec ?? {};
        if ((spec.pool?.generation ?? 0) !== newest.get(poolKey(slice))) continue;
        const driver = spec.driver ?? '';
        const pool = spec.pool?.name ?? '';
        for (const device of spec.devices ?? []) {
            const name = device.name ?? '';
            const key = deviceKey(driver, pool, name);
            // A device listed twice in one pool is a driver bug; count it once.
            if (!name || seen.has(key)) continue;
            seen.add(key);
            out.push(readDevice(device, driver, pool, spec.nodeName ?? '', slice.metadata.name));
        }
    }
    return out.sort(
        (a, b) =>
            a.node.localeCompare(b.node) ||
            a.driver.localeCompare(b.driver) ||
            a.pool.localeCompare(b.pool) ||
            a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
}

function poolKey(slice: ResourceSlice): string {
    return `${slice.spec?.driver ?? ''}/${slice.spec?.pool?.name ?? ''}`;
}

function readDevice(device: Device, driver: string, pool: string, sliceNode: string, slice: string): SliceDevice {
    // v1 and v1beta2 put the fields on the device; v1beta1 under `basic`.
    const fields = device.basic ?? device;
    const attributes: Record<string, string> = {};
    for (const [name, value] of Object.entries(fields.attributes ?? {})) attributes[shortName(name, driver)] = attributeText(value);
    const capacity: Record<string, string> = {};
    for (const [name, value] of Object.entries(fields.capacity ?? {})) {
        if (value?.value !== undefined) capacity[shortName(name, driver)] = String(value.value);
    }
    const taint = (fields.taints ?? []).find((t) => t.effect === 'NoSchedule' || t.effect === 'NoExecute');
    return {
        driver,
        pool,
        name: device.name ?? '',
        node: sliceNode || fields.nodeName || '',
        slice,
        attributes,
        capacity,
        counterSets: (fields.consumesCounters ?? []).map((c) => c.counterSet ?? '').filter((s) => s !== ''),
        tainted: taint ? `${taint.key ?? ''}${taint.value ? `=${taint.value}` : ''}:${taint.effect ?? ''}` : '',
        multiple: fields.allowMultipleAllocations === true,
    };
}

/** A device's memory in bytes, from its `memory` capacity (every GPU driver we know names it that). */
export function deviceMemory(device: SliceDevice): number {
    return quantity(device.capacity['memory'] ?? device.capacity['memorySize'] ?? '');
}

/** A device's product name, from whichever attribute its driver uses for one. */
export function deviceModel(device: SliceDevice): string {
    for (const key of ['productName', 'model', 'product', 'productname', 'deviceName', 'marketingName', 'family']) {
        const value = device.attributes[key];
        if (value) return value;
    }
    return '';
}

// ----- claims ---------------------------------------------------------------------

/** One request of a claim, in either API shape, as one line a person can read. */
export interface RequestView {
    name: string;
    /** The class asked for; for a prioritised list, the first alternative's, with the rest in `alternatives`. */
    deviceClass: string;
    alternatives: string[];
    /** How many devices; Infinity for allocationMode All. */
    count: number;
    adminAccess: boolean;
}

/** The requests in a claim spec -- a ResourceClaim's own, or a template's `spec.spec`. */
export function requestsOf(spec: ClaimSpec | undefined): RequestView[] {
    return (spec?.devices?.requests ?? []).map(readRequest);
}

function readRequest(request: DeviceRequest): RequestView {
    const alternatives = request.firstAvailable ?? [];
    // v1: `exactly`; v1beta1: the same fields on the request; either: a prioritised list.
    const exact: ExactRequest = request.exactly ?? (request.deviceClassName ? request : (alternatives[0] ?? {}));
    const all = exact.allocationMode === 'All';
    return {
        name: request.name ?? '',
        deviceClass: exact.deviceClassName ?? '',
        alternatives: alternatives.slice(request.exactly || request.deviceClassName ? 0 : 1).map((a) => a.deviceClassName ?? '').filter((c) => c !== ''),
        count: all ? Infinity : Math.max(1, exact.count ?? 1),
        adminAccess: exact.adminAccess === true,
    };
}

/** How many devices a set of requests adds up to, with "all" kept apart. */
export function requestedDevices(requests: RequestView[]): { count: number; all: boolean } {
    let count = 0;
    let all = false;
    for (const request of requests) {
        if (request.adminAccess) continue;
        if (request.count === Infinity) all = true;
        else count += request.count;
    }
    return { count, all };
}

export type ClaimState = 'reserved' | 'allocated' | 'pending' | 'deleting';

/**
 * kubectl's STATE for a claim, in the order that matters: going away, in use
 * by a pod, allocated but not in use, or not allocated yet.
 */
export function claimState(claim: ResourceClaim): ClaimState {
    if (claim.metadata.deletionTimestamp) return 'deleting';
    if (!claim.status?.allocation) return 'pending';
    if ((claim.status.reservedFor ?? []).length > 0) return 'reserved';
    return 'allocated';
}

/** The allocation results that hand a device over -- not the ones that only let an admin look at it. */
export function allocatedDevices(claim: ResourceClaim): AllocationResult[] {
    return (claim.status?.allocation?.devices?.results ?? []).filter((r) => r.adminAccess !== true && r.device);
}

/** The pods a claim is reserved for, by name. */
export function reservedPods(claim: ResourceClaim): string[] {
    return (claim.status?.reservedFor ?? []).filter((r) => (r.resource ?? 'pods') === 'pods' && !r.apiGroup).map((r) => r.name ?? '').filter((n) => n !== '');
}

/**
 * The annotation the resource claim controller puts on a claim it made from
 * a template, naming the pod's claim entry; the pod itself is the owner.
 */
export const POD_CLAIM_ANNOTATION = 'resource.kubernetes.io/pod-claim-name';

/** The pod a claim was generated for, if it was generated from a template. */
export function claimOwnerPod(claim: ResourceClaim): string {
    const owner = (claim.metadata.ownerReferences ?? []).find((o) => o.kind === 'Pod' && o.controller);
    return owner?.name ?? '';
}

/**
 * The driver a DeviceClass selects, read from its CEL selectors.
 *
 * Every class a driver ships selects on `device.driver == '<name>'`, so this
 * is enough to say which devices a class could possibly be given -- which is
 * what "can this pod ever be scheduled?" needs. A class that selects some
 * other way yields ''.
 */
export function classDriver(deviceClass: DeviceClass | undefined): string {
    for (const selector of deviceClass?.spec?.selectors ?? []) {
        const match = /device\.driver\s*==\s*["']([^"']+)["']/.exec(selector.cel?.expression ?? '');
        if (match?.[1]) return match[1];
    }
    return '';
}

/** A device type a class narrows to, when its CEL says so -- NVIDIA's classes separate "gpu" from "mig". */
export function classDeviceType(deviceClass: DeviceClass | undefined): string {
    for (const selector of deviceClass?.spec?.selectors ?? []) {
        const match = /\.type\s*==\s*["']([^"']+)["']/.exec(selector.cel?.expression ?? '');
        if (match?.[1]) return match[1];
    }
    return '';
}
