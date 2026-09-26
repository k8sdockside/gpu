// The inventory: every accelerator in the cluster, once, and who holds it.
//
// Accelerators reach a pod two ways, and a cluster can use both:
//
//   the device plugin    a node advertises `nvidia.com/gpu: 8` in its
//                        capacity; a pod asks for `nvidia.com/gpu: 2` in its
//                        limits. The API says how many a node has and how
//                        many its pods asked for -- never which card a pod
//                        got.
//   DRA                  a driver publishes each device in a ResourceSlice;
//                        a claim is allocated named devices, and records the
//                        pods using it. The API says exactly who has what.
//
// A "unit" here is one physical accelerator: one square on the Inventory
// page. The rules that make the counts honest:
//
//  - A node whose DRA driver publishes a vendor's devices is not counted
//    again through that vendor's extended resources. Running the device
//    plugin and the DRA driver side by side is a migration state, and the
//    two describe the same cards.
//  - MIG instances are partitions of a unit, not units: a GPU split seven
//    ways is one GPU with seven cells. DRA says which GPU each instance is on
//    (`parentUUID`); the device plugin does not, so its MIG instances are
//    packed onto as few GPUs as their slices fit.
//  - Time-slicing multiplies what a node advertises (`nvidia.com/gpu: 32` on
//    8 cards with 4 replicas each). GFD's `nvidia.com/gpu.replicas` label is
//    divided back out, so the node has 8 units with 4 slots each.
//  - A device plugin that finds a card unhealthy drops it from allocatable
//    and leaves it in capacity. The difference is drawn as units that are
//    there and unusable, because "7 of 8" is how a lost GPU shows up.
//  - Where the device plugin cannot say which card a pod got, pods are put
//    on the least-used units in order and every such unit is marked
//    `inferred`, so the page can say it is a picture of the counts rather
//    than of the cards.
//  - Unless DCGM says. Its exporter reads every card through NVML and, with
//    pod mapping on, asks the kubelet which pod each was handed to; when
//    Prometheus has that, a device-plugin card gets its real index, UUID and
//    PCI address, and the pods DCGM names replace the ones placed by count.
//    Every card DCGM reports also gets its live numbers: utilisation,
//    memory, temperature, power.

import type { DcgmGpu } from './dcgm.js';
import { visibleDevices } from './visible.js';
import { allocatedDevices, deviceKey, deviceMemory, deviceModel, reservedPods, sliceDevices, type SliceDevice } from './dra.js';
import { condition, isLive, type Node, type Pod, type ResourceClaim, type Snapshot } from './kube.js';
import { podDeviceRequests } from './requests.js';
import { quantity } from './units.js';
import {
    driverVendor,
    friendlyModel,
    isAcceleratorDriver,
    isDeviceResource,
    migResourceProfile,
    migSlicesFor,
    nodeCard,
    parseMigProfile,
    resourceNoun,
    resourceVendor,
    VENDOR_NAMES,
    type NodeCard,
    type Vendor,
} from './vendors.js';

export type UnitState = 'free' | 'allocated' | 'shared' | 'partial' | 'unhealthy';
export type Source = 'dra' | 'device-plugin';

/** A pod using a device, and the claim it uses it through ('' for the device plugin). */
export interface Consumer {
    namespace: string;
    pod: string;
    claim: string;
    /** The env variable that named the card, for a pod that did not ask the scheduler for it. */
    via?: string;
}

/** A claim holding a device, by namespace and name. */
export interface ClaimRef {
    namespace: string;
    name: string;
}

/** A MIG instance or other partition of a unit. */
export interface Partition {
    id: string;
    name: string;
    profile: string;
    /** Compute slices it takes, out of the unit's `slices`. */
    slices: number;
    memory: number;
    state: Exclude<UnitState, 'partial'>;
    consumers: Consumer[];
    claims: ClaimRef[];
    /** The DRA device, when it is one. */
    device?: SliceDevice;
    /** One of the ways a partitionable card could be carved, drawn only once it is allocated. */
    dynamic?: boolean;
}

/** A card's numbers right now, from DCGM. */
export interface Live {
    /** 0-1. */
    util?: number;
    memoryUsed?: number;
    memoryTotal?: number;
    temperature?: number;
    power?: number;
    nvlink?: number;
}

export interface Unit {
    /** Stable across refreshes: what the page remembers a selection by. */
    id: string;
    node: string;
    source: Source;
    vendor: Vendor;
    /** The DRA driver, or the extended resource the device plugin advertises. */
    driver: string;
    /** What goes inside the square: the device's index. */
    label: string;
    /** The device's own name: `gpu-3`, or `nvidia.com/gpu #3` for the device plugin. */
    name: string;
    model: string;
    memory: number;
    driverVersion: string;
    cudaVersion: string;
    /** The DRA device, when the unit is one the driver publishes (a parent synthesised from MIG instances has none). */
    device?: SliceDevice;
    state: UnitState;
    consumers: Consumer[];
    claims: ClaimRef[];
    partitions: Partition[];
    /** How many compute slices the unit divides into, when it has partitions. */
    slices: number;
    /** Time-slicing or MPS replicas; 1 when the card is not shared that way. */
    slots: number;
    sharing: string;
    /** Placed by counting, not by the API: the device plugin never says which card a pod got. */
    inferred: boolean;
    problem: string;
    /** The card's UUID, from its DRA driver or DCGM; '' when neither says. */
    uuid: string;
    /** Its PCI bus address, "00000000:02:00.0". */
    pciBus: string;
    /** What DCGM reports about it now; absent when Prometheus has no DCGM for it. */
    live?: Live;
}

export interface NodeView {
    /** '' for devices a driver publishes without a node (network-attached). */
    name: string;
    ready: boolean;
    unschedulable: boolean;
    card: NodeCard;
    units: Unit[];
    /** Things worth a sentence: both paths advertising, a label disagreeing with capacity. */
    notes: string[];
}

export interface Tally {
    key: string;
    label: string;
    vendor: Vendor;
    total: number;
    inUse: number;
    free: number;
    unhealthy: number;
    memory: number;
}

export interface Totals {
    total: number;
    inUse: number;
    free: number;
    unhealthy: number;
    shared: number;
    partitions: number;
    partitionsInUse: number;
}

export interface Inventory {
    nodes: NodeView[];
    units: Unit[];
    totals: Totals;
    byModel: Tally[];
    byVendor: Tally[];
    /** Every unit and partition by the DRA key (driver/pool/device), for claims to find their devices. */
    byKey: Map<string, { unit: Unit; partition?: Partition }>;
}

// ----- building it ------------------------------------------------------------------

export function buildInventory(snap: Pick<Snapshot, 'nodes' | 'pods' | 'slices' | 'claims'>, dcgm: DcgmGpu[] = []): Inventory {
    const nodesByName = new Map(snap.nodes.map((node) => [node.metadata.name, node]));
    const devices = sliceDevices(snap.slices).filter((d) => isAcceleratorDriver(d.driver));

    const byKey = new Map<string, { unit: Unit; partition?: Partition }>();
    const draUnits = unitsFromDevices(devices, byKey);
    applyClaims(snap.claims, byKey);
    for (const unit of draUnits) settle(unit);

    const views = new Map<string, NodeView>();
    const view = (name: string): NodeView => {
        let v = views.get(name);
        if (!v) {
            const node = nodesByName.get(name);
            v = {
                name,
                ready: node ? condition(node.status?.conditions, 'Ready')?.status === 'True' : name === '',
                unschedulable: node?.spec?.unschedulable === true,
                card: nodeCard(node?.metadata.labels),
                units: [],
                notes: [],
            };
            views.set(name, v);
        }
        return v;
    };

    // By driver, then as nvidia-smi numbers them: a GPU made up from its MIG
    // instances is created after the whole ones, and must not be drawn last.
    draUnits.sort((a, b) => a.node.localeCompare(b.node) || a.driver.localeCompare(b.driver) || a.label.localeCompare(b.label, undefined, { numeric: true }) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const unit of draUnits) view(unit.node).units.push(unit);

    // The device plugin, node by node, skipping what DRA already describes.
    const podsByNode = new Map<string, Pod[]>();
    for (const pod of snap.pods) {
        const name = pod.spec?.nodeName;
        if (!name || !isLive(pod)) continue;
        podsByNode.set(name, [...(podsByNode.get(name) ?? []), pod]);
    }
    for (const node of snap.nodes) {
        const draVendors = new Set((views.get(node.metadata.name)?.units ?? []).map((u) => u.vendor));
        const units = unitsFromNode(node, podsByNode.get(node.metadata.name) ?? [], draVendors, (note) => view(node.metadata.name).notes.push(note));
        if (units.length) view(node.metadata.name).units.push(...units);
    }

    if (dcgm.length) applyDcgm([...views.values()], dcgm);
    applyVisible([...views.values()], snap.pods);

    const nodes = [...views.values()]
        .filter((v) => v.units.length > 0)
        .sort((a, b) => (a.name === '' ? 1 : b.name === '' ? -1 : a.name.localeCompare(b.name, undefined, { numeric: true })));
    const units = nodes.flatMap((n) => n.units);
    return { nodes, units, totals: totals(units), byModel: tally(units, (u) => modelKey(u)), byVendor: tally(units, (u) => [u.vendor, VENDOR_NAMES[u.vendor]]), byKey };
}

// ----- DRA ------------------------------------------------------------------------------

function blankUnit(partial: Partial<Unit> & Pick<Unit, 'id' | 'node' | 'source' | 'vendor' | 'driver' | 'name'>): Unit {
    return {
        label: '',
        model: '',
        memory: 0,
        driverVersion: '',
        cudaVersion: '',
        state: 'free',
        consumers: [],
        claims: [],
        partitions: [],
        slices: 0,
        slots: 1,
        sharing: '',
        inferred: false,
        problem: '',
        uuid: '',
        pciBus: '',
        ...partial,
    };
}

/** The index a device's name ends in -- gpu-3 is "3" -- or its whole name when it has none. */
function indexLabel(name: string): string {
    const match = /(\d+)$/.exec(name);
    return match?.[1] ?? name.slice(0, 3);
}

function unitFromDevice(device: SliceDevice): Unit {
    return blankUnit({
        id: `dra/${deviceKey(device.driver, device.pool, device.name)}`,
        node: device.node,
        source: 'dra',
        vendor: driverVendor(device.driver),
        driver: device.driver,
        name: device.name,
        label: device.attributes['index'] ?? indexLabel(device.name),
        model: friendlyModel(deviceModel(device)),
        memory: deviceMemory(device),
        driverVersion: device.attributes['driverVersion'] ?? '',
        cudaVersion: device.attributes['cudaDriverVersion'] ?? '',
        device,
        uuid: device.attributes['uuid'] ?? '',
        pciBus: device.attributes['pcieBusID'] ?? device.attributes['pciBusID'] ?? device.attributes['pciAddress'] ?? '',
        problem: device.tainted ? `The driver has tainted this device (${device.tainted}): the scheduler will not hand it out.` : '',
    });
}

function partitionFrom(device: SliceDevice, dynamic = false): Partition {
    const profile = device.attributes['profile'] ?? /-mig-([0-9a-z]+?)-\d+-\d+$/.exec(device.name)?.[1] ?? '';
    const parsed = parseMigProfile(profile) ?? parseMigProfile(profile.replace(/^(\d+g)(\d+gb)$/, '$1.$2'));
    return {
        id: `dra/${deviceKey(device.driver, device.pool, device.name)}`,
        name: device.name,
        profile: parsed?.name ?? profile,
        slices: parsed?.slices ?? 1,
        memory: deviceMemory(device),
        state: device.tainted ? 'unhealthy' : 'free',
        consumers: [],
        claims: [],
        device,
        ...(dynamic ? { dynamic } : {}),
    };
}

/**
 * Units from the devices DRA drivers publish.
 *
 * A MIG instance names its GPU by `parentUUID`; it becomes a partition of the
 * device whose `uuid` that is, or of a unit made up for it when the driver
 * does not list the whole GPU (static MIG lists only the instances).
 *
 * Partitionable devices (1.33+) are the other shape: every way a card could
 * be carved up is listed, each consuming from one shared counter set. Those
 * overlap -- a card listed as one whole GPU and seven 1g instances is still
 * one card -- so a counter set is one unit, and only the carvings actually
 * allocated are drawn as its cells.
 */
function unitsFromDevices(devices: SliceDevice[], byKey: Inventory['byKey']): Unit[] {
    const units: Unit[] = [];
    const byUuid = new Map<string, Unit>();
    const byCounterSet = new Map<string, Unit>();
    const carved = new Set<Unit>();
    const groupKey = (d: SliceDevice, set: string) => `${d.driver}/${d.pool}/${set}`;

    // Parents first: whole devices, one unit per counter set.
    const children: SliceDevice[] = [];
    const counterGroups = new Map<string, SliceDevice[]>();
    for (const device of devices) {
        if (device.attributes['parentUUID'] || device.attributes['type'] === 'mig') {
            children.push(device);
            continue;
        }
        const set = device.counterSets[0];
        if (set) counterGroups.set(groupKey(device, set), [...(counterGroups.get(groupKey(device, set)) ?? []), device]);
        else addUnit(unitFromDevice(device));
    }
    for (const [key, group] of counterGroups) {
        // The whole card: typed as one, or else the biggest.
        const whole = group.find((d) => d.attributes['type'] === 'gpu') ?? [...group].sort((a, b) => deviceMemory(b) - deviceMemory(a) || a.name.length - b.name.length)[0];
        if (!whole) continue;
        const unit = addUnit(unitFromDevice(whole));
        byCounterSet.set(key, unit);
        for (const other of group) {
            if (other === whole) continue;
            byKey.set(deviceKey(other.driver, other.pool, other.name), { unit, partition: partitionFrom(other, true) });
            carved.add(unit);
        }
    }

    for (const device of children) {
        const parentUuid = device.attributes['parentUUID'] ?? '';
        let parent = parentUuid ? byUuid.get(`${device.node}/${device.driver}/${parentUuid}`) : undefined;
        if (!parent && device.counterSets[0]) parent = byCounterSet.get(groupKey(device, device.counterSets[0]));
        if (!parent) {
            // Static MIG: the driver lists the instances and not the GPU. Make it up
            // from what the instances say about it -- NVIDIA names them gpu-<minor>-mig-...
            const minor = /^gpu-(\d+)-mig-/.exec(device.name)?.[1];
            const name = minor !== undefined ? `gpu-${minor}` : parentUuid ? `GPU ${parentUuid.slice(0, 12)}` : device.name;
            parent = addUnit(
                blankUnit({
                    id: `dra/${device.driver}/${device.pool}/${parentUuid || name}`,
                    node: device.node,
                    source: 'dra',
                    vendor: driverVendor(device.driver),
                    driver: device.driver,
                    name,
                    label: minor ?? indexLabel(name),
                    model: friendlyModel(deviceModel(device)),
                    driverVersion: device.attributes['driverVersion'] ?? '',
                    cudaVersion: device.attributes['cudaDriverVersion'] ?? '',
                }),
                parentUuid,
            );
        }
        if (device.counterSets.length > 0) {
            // A carving that may or may not exist: drawn only once allocated.
            byKey.set(deviceKey(device.driver, device.pool, device.name), { unit: parent, partition: partitionFrom(device, true) });
            carved.add(parent);
        } else {
            const partition = partitionFrom(device);
            parent.partitions.push(partition);
            byKey.set(deviceKey(device.driver, device.pool, device.name), { unit: parent, partition });
        }
    }

    for (const unit of units) {
        if (unit.partitions.length > 0 || carved.has(unit)) unit.slices = migSlicesFor(unit.model);
        unit.partitions.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    }
    return units;

    function addUnit(unit: Unit, uuid = unit.device?.attributes['uuid'] ?? ''): Unit {
        units.push(unit);
        if (unit.device) byKey.set(deviceKey(unit.device.driver, unit.device.pool, unit.device.name), { unit });
        if (uuid) byUuid.set(`${unit.node}/${unit.driver}/${uuid}`, unit);
        return unit;
    }
}

/** Puts each allocated claim's pods on the devices it was given. */
function applyClaims(claims: ResourceClaim[], byKey: Inventory['byKey']): void {
    for (const claim of claims) {
        const ref = { namespace: claim.metadata.namespace ?? '', name: claim.metadata.name };
        const pods = reservedPods(claim);
        for (const result of allocatedDevices(claim)) {
            const entry = byKey.get(deviceKey(result.driver ?? '', result.pool ?? '', result.device ?? ''));
            if (!entry) continue;
            let target: Unit | Partition = entry.unit;
            if (entry.partition) {
                // A dynamic carving becomes a cell the first time it is allocated.
                let partition = entry.unit.partitions.find((p) => p.id === entry.partition?.id);
                if (!partition) {
                    partition = entry.partition;
                    entry.unit.partitions.push(partition);
                }
                target = partition;
            }
            if (!target.claims.some((c) => c.namespace === ref.namespace && c.name === ref.name)) target.claims.push(ref);
            for (const pod of pods) {
                if (!target.consumers.some((c) => c.namespace === ref.namespace && c.pod === pod)) target.consumers.push({ namespace: ref.namespace, pod, claim: ref.name });
            }
        }
    }
}

/** A device's state from what holds it: nobody, one claim or pod, or more than one. */
function holdState(claims: ClaimRef[], consumers: Consumer[], unhealthy: boolean): Exclude<UnitState, 'partial'> {
    if (claims.length > 1 || new Set(consumers.map((c) => `${c.namespace}/${c.pod}`)).size > 1) return 'shared';
    if (claims.length === 1 || consumers.length === 1) return 'allocated';
    return unhealthy ? 'unhealthy' : 'free';
}

/** Works out a unit's state from its own holders and its partitions'. */
function settle(unit: Unit): void {
    for (const partition of unit.partitions) {
        partition.state = holdState(partition.claims, partition.consumers, partition.state === 'unhealthy' || Boolean(partition.device?.tainted));
    }
    const own = holdState(unit.claims, unit.consumers, Boolean(unit.device?.tainted));
    const used = unit.partitions.filter((p) => p.state === 'allocated' || p.state === 'shared');
    if (own !== 'free' && own !== 'unhealthy') {
        unit.state = own;
    } else if (used.length > 0) {
        // The partitions' holders are the unit's too, for the tooltip and the counts.
        for (const p of used) {
            for (const c of p.consumers) if (!unit.consumers.some((u) => u.namespace === c.namespace && u.pod === c.pod)) unit.consumers.push(c);
            for (const c of p.claims) if (!unit.claims.some((u) => u.namespace === c.namespace && u.name === c.name)) unit.claims.push(c);
        }
        unit.state = used.length === unit.partitions.length && used.every((p) => p.state === 'allocated') && sum(unit.partitions.map((p) => p.slices)) >= unit.slices ? 'allocated' : 'partial';
    } else {
        unit.state = own;
    }
}

function sum(values: number[]): number {
    return values.reduce((n, v) => n + v, 0);
}

// ----- the device plugin -----------------------------------------------------------------------

/**
 * Units from one node's extended resources, with its pods put on them.
 *
 * `draVendors` are the vendors whose cards a DRA driver already publishes on
 * this node; their resources are left out, with a note.
 */
function unitsFromNode(node: Node, pods: Pod[], draVendors: Set<Vendor>, note: (text: string) => void): Unit[] {
    const name = node.metadata.name;
    const capacity = node.status?.capacity ?? {};
    const allocatable = node.status?.allocatable ?? {};
    const card = nodeCard(node.metadata.labels);
    let resources = Object.keys(capacity).filter((r) => isDeviceResource(r) && quantity(capacity[r]) > 0);
    // Neuron devices are advertised under two names by different plugin versions.
    if (resources.includes('aws.amazon.com/neurondevice')) resources = resources.filter((r) => r !== 'aws.amazon.com/neuron');

    const skipped = resources.filter((r) => draVendors.has(resourceVendor(r) ?? 'other'));
    if (skipped.length) {
        note(`${skipped.join(', ')} ${skipped.length === 1 ? 'is' : 'are'} also advertised by a device plugin here. The same cards are published through DRA, so they are counted once, from DRA.`);
        resources = resources.filter((r) => !skipped.includes(r));
    }

    const requests = pods
        .map((pod) => ({ pod, wants: podDeviceRequests(pod) }))
        .sort((a, b) => (a.pod.metadata.creationTimestamp ?? '').localeCompare(b.pod.metadata.creationTimestamp ?? '') || a.pod.metadata.name.localeCompare(b.pod.metadata.name));

    const units: Unit[] = [];
    const whole = resources.filter((r) => !migResourceProfile(r) && !isSingleMig(r, card)).sort();
    const mig = resources.filter((r) => migResourceProfile(r) || isSingleMig(r, card)).sort();

    for (const resource of whole) {
        const made = wholeUnits(name, resource, quantity(capacity[resource]), quantity(allocatable[resource] ?? capacity[resource]), card);
        place(
            made,
            requests.map(({ pod, wants }) => ({ pod, n: wants[resource] ?? 0 })),
        );
        units.push(...made);
    }
    if (mig.length) units.push(...migUnits(name, mig, capacity, allocatable, card, requests));

    // Numbered across the node, the way nvidia-smi numbers its cards.
    units.forEach((unit, index) => (unit.label = String(index)));
    return units;
}

/** Under `mig.strategy=single`, plain nvidia.com/gpu hands out MIG instances, and GFD's product label says which. */
function isSingleMig(resource: string, card: NodeCard): boolean {
    return resource === 'nvidia.com/gpu' && card.migStrategy === 'single' && /-MIG-/i.test(card.product);
}

function dpUnit(node: string, resource: string, index: number, card: NodeCard, vendor: Vendor = resourceVendor(resource) ?? 'other'): Unit {
    return blankUnit({
        id: `dp/${node}/${resource}/${index}`,
        node,
        source: 'device-plugin',
        vendor,
        driver: resource,
        name: `${resource} #${index}`,
        model: friendlyModel(card.product.replace(/-MIG-.*$/i, '')) || `${VENDOR_NAMES[vendor]} ${resourceNoun(resource)}`,
        memory: card.memory,
        driverVersion: card.driverVersion,
        cudaVersion: card.cudaVersion,
        inferred: true,
    });
}

function wholeUnits(node: string, resource: string, capacity: number, allocatable: number, card: NodeCard): Unit[] {
    // Time-slicing and MPS: GFD says how many replicas each card was split into.
    const nvidia = resource.startsWith('nvidia.com/');
    const replicas = nvidia && card.replicas > 1 ? card.replicas : 1;
    const physical = Math.ceil(capacity / replicas);
    const lost = Math.min(physical, Math.ceil(Math.max(0, capacity - allocatable) / replicas));
    const units: Unit[] = [];
    for (let i = 0; i < physical; i++) {
        const unit = dpUnit(node, resource, i, card);
        unit.slots = replicas;
        unit.sharing = replicas > 1 ? card.sharing || 'time-slicing' : '';
        if (i >= physical - lost) {
            unit.state = 'unhealthy';
            unit.problem = `The device plugin reports ${capacity - allocatable} of ${capacity} ${resource} unhealthy: the node has ${allocatable} to give out.`;
        }
        units.push(unit);
    }
    return units;
}

/**
 * Puts pods on units by count, least used first, in the order they were
 * created. Unhealthy units are skipped; a unit with `slots` > 1 takes that
 * many pods before it is full.
 */
function place(units: Unit[], wants: { pod: Pod; n: number }[]): void {
    const healthy = units.filter((u) => u.state !== 'unhealthy');
    const used = new Map<Unit, number>();
    for (const { pod, n } of wants) {
        for (let k = 0; k < n; k++) {
            const target = [...healthy].filter((u) => (used.get(u) ?? 0) < u.slots).sort((a, b) => (used.get(a) ?? 0) - (used.get(b) ?? 0))[0];
            if (!target) break;
            used.set(target, (used.get(target) ?? 0) + 1);
            const consumer = { namespace: pod.metadata.namespace ?? '', pod: pod.metadata.name, claim: '' };
            if (!target.consumers.some((c) => c.namespace === consumer.namespace && c.pod === consumer.pod)) target.consumers.push(consumer);
        }
    }
    for (const unit of healthy) unit.state = holdState([], unit.consumers, false);
}

/**
 * MIG instances the device plugin advertises (`mig.strategy=mixed`, or
 * `single`), packed onto GPUs.
 *
 * The plugin says there are, say, seven 1g.10gb instances and two 3g.40gb
 * ones -- not which card each is on. Packed largest first onto cards of
 * seven slices, that is two cards; the drawing is honest about the counts
 * and says it is a packing.
 */
function migUnits(
    node: string,
    resources: string[],
    capacity: Record<string, string>,
    allocatable: Record<string, string>,
    card: NodeCard,
    requests: { pod: Pod; wants: Record<string, number> }[],
): Unit[] {
    const perCard = migSlicesFor(card.product);
    const instances: { resource: string; profile: string; slices: number; lost: boolean }[] = [];
    for (const resource of resources) {
        const profile = migResourceProfile(resource) ?? parseMigProfile(/-MIG-(.+)$/i.exec(card.product)?.[1] ?? '');
        const have = quantity(capacity[resource]);
        const usable = quantity(allocatable[resource] ?? capacity[resource]);
        for (let i = 0; i < have; i++) instances.push({ resource, profile: profile?.name ?? resource, slices: Math.min(perCard, profile?.slices ?? 1), lost: i >= usable });
    }
    instances.sort((a, b) => b.slices - a.slices || a.profile.localeCompare(b.profile));

    const units: Unit[] = [];
    const free = new Map<Unit, number>();
    for (const instance of instances) {
        let unit = units.find((u) => (free.get(u) ?? 0) >= instance.slices);
        if (!unit) {
            unit = dpUnit(node, 'nvidia.com/mig', units.length, card, 'nvidia');
            unit.name = `MIG GPU #${units.length}`;
            unit.slices = perCard;
            units.push(unit);
            free.set(unit, perCard);
        }
        free.set(unit, (free.get(unit) ?? 0) - instance.slices);
        unit.partitions.push({
            id: `${unit.id}/${unit.partitions.length}`,
            name: instance.resource,
            profile: instance.profile,
            slices: instance.slices,
            memory: (parseMigProfile(instance.profile)?.gigabytes ?? 0) * 1e9,
            state: instance.lost ? 'unhealthy' : 'free',
            consumers: [],
            claims: [],
        });
    }

    // Pods onto instances of the profile they asked for, in order.
    for (const resource of resources) {
        const cells = units.flatMap((u) => u.partitions).filter((p) => p.name === resource && p.state !== 'unhealthy');
        let next = 0;
        for (const { pod, wants } of requests) {
            for (let k = 0; k < (wants[resource] ?? 0) && next < cells.length; k++, next++) {
                const cell = cells[next];
                if (cell) cell.consumers.push({ namespace: pod.metadata.namespace ?? '', pod: pod.metadata.name, claim: '' });
            }
        }
    }
    for (const unit of units) {
        for (const p of unit.partitions) {
            if (p.state !== 'unhealthy') p.state = holdState([], p.consumers, false);
        }
        settle(unit);
        if (unit.partitions.every((p) => p.state === 'unhealthy')) unit.state = 'unhealthy';
        const lost = unit.partitions.filter((p) => p.state === 'unhealthy').length;
        if (lost) unit.problem = `The device plugin reports ${lost} MIG instance${lost === 1 ? '' : 's'} here unhealthy.`;
    }
    return units;
}

// ----- DCGM ------------------------------------------------------------------------------------

/**
 * Puts what DCGM says onto the cards it describes.
 *
 * A DRA device is found by its UUID. The device plugin's cards have no
 * identity of their own -- they are counted -- so they take DCGM's cards in
 * nvidia-smi's order: the first square is GPU 0. When DCGM names the pods on
 * a node's cards, those replace the pods placed by count, and the cards stop
 * being `inferred`. MIG cards are left as they are: DCGM's instances and the
 * device plugin's packing do not line up one to one.
 */
function applyDcgm(views: NodeView[], gpus: DcgmGpu[]): void {
    const byNode = new Map<string, DcgmGpu[]>();
    for (const gpu of gpus) byNode.set(gpu.node, [...(byNode.get(gpu.node) ?? []), gpu]);

    for (const view of views) {
        const list = (byNode.get(view.name) ?? []).sort((a, b) => Number(a.index) - Number(b.index));
        if (!list.length) continue;
        const taken = new Set<DcgmGpu>();

        for (const unit of view.units) {
            if (unit.source !== 'dra' || !unit.uuid) continue;
            const gpu = list.find((g) => g.uuid === unit.uuid);
            if (!gpu) continue;
            taken.add(gpu);
            describe(unit, gpu);
        }

        const counted = view.units.filter((u) => u.source === 'device-plugin' && u.vendor === 'nvidia' && u.partitions.length === 0);
        const cards = list.filter((g) => !taken.has(g) && !g.mig);
        if (!counted.length || !cards.length) continue;
        if (cards.length !== counted.length) {
            view.notes.push(`DCGM reports ${cards.length} ${cards.length === 1 ? 'GPU' : 'GPUs'} here and the device plugin advertises ${counted.length}: ${cards.length > counted.length ? 'some cards are not handed out' : 'some cards are not reported'}, so which card is which is matched in order.`);
        }
        // Pod mapping is on for a node when DCGM names a pod on any of its cards.
        const mapped = cards.some((g) => g.consumers.length > 0);
        counted.forEach((unit, i) => {
            const gpu = cards[i];
            if (!gpu) return;
            describe(unit, gpu);
            unit.label = gpu.index || unit.label;
            unit.name = gpu.index ? `GPU ${gpu.index}` : unit.name;
            if (!mapped) return;
            unit.consumers = gpu.consumers.map((c) => ({ namespace: c.namespace, pod: c.pod, claim: '' }));
            unit.inferred = false;
            if (unit.consumers.length) unit.state = holdState([], unit.consumers, false);
            else if (unit.state !== 'unhealthy') unit.state = 'free';
        });
    }
}

function describe(unit: Unit, gpu: DcgmGpu): void {
    unit.uuid ||= gpu.uuid;
    unit.pciBus ||= gpu.pciBus;
    unit.model ||= friendlyModel(gpu.model);
    const total = (gpu.memoryUsed ?? 0) + (gpu.memoryFree ?? 0);
    if (!unit.memory && total > 0) unit.memory = total;
    unit.live = {
        util: gpu.util,
        memoryUsed: gpu.memoryUsed,
        memoryTotal: total > 0 ? total : unit.memory || undefined,
        temperature: gpu.temperature,
        power: gpu.power,
        nvlink: gpu.nvlink,
    };
}

// ----- GPUs named in a pod's env ------------------------------------------------------------------

/**
 * Puts the pods that reach a GPU through NVIDIA_VISIBLE_DEVICES or
 * CUDA_VISIBLE_DEVICES -- and not through the scheduler -- on the cards they
 * name: by index, as nvidia-smi numbers them, or by UUID. "all" is every
 * card on the node. See visible.ts.
 */
function applyVisible(views: NodeView[], pods: Pod[]): void {
    const byNode = new Map(views.map((v) => [v.name, v]));
    for (const pod of pods) {
        const node = pod.spec?.nodeName;
        if (!node || !isLive(pod)) continue;
        const view = byNode.get(node);
        const visible = view ? visibleDevices(pod) : undefined;
        if (!view || !visible) continue;
        const wanted = visible.devices.map((d) => d.toLowerCase());
        const targets = visible.all ? view.units : view.units.filter((u) => wanted.includes(u.label.toLowerCase()) || (u.uuid !== '' && wanted.includes(u.uuid.toLowerCase())));
        for (const unit of targets) {
            const consumer: Consumer = { namespace: pod.metadata.namespace ?? '', pod: pod.metadata.name, claim: '', via: visible.env };
            if (unit.consumers.some((c) => c.namespace === consumer.namespace && c.pod === consumer.pod)) continue;
            unit.consumers.push(consumer);
            if (unit.partitions.length === 0) unit.state = holdState(unit.claims, unit.consumers, false);
            // Named in the spec, not counted: the card is no guess when these are all it has.
            if (unit.consumers.every((c) => c.via)) unit.inferred = false;
        }
    }
}

// ----- adding up -------------------------------------------------------------------------------

export function isInUse(unit: Pick<Unit, 'state'>): boolean {
    return unit.state === 'allocated' || unit.state === 'shared' || unit.state === 'partial';
}

function totals(units: Unit[]): Totals {
    const partitions = units.flatMap((u) => u.partitions);
    return {
        total: units.length,
        inUse: units.filter(isInUse).length,
        free: units.filter((u) => u.state === 'free').length,
        unhealthy: units.filter((u) => u.state === 'unhealthy').length,
        shared: units.filter((u) => u.state === 'shared').length,
        partitions: partitions.length,
        partitionsInUse: partitions.filter((p) => p.state === 'allocated' || p.state === 'shared').length,
    };
}

/** What a unit is grouped under on "by model": its model, or what it is when no label names one. */
export function modelKey(unit: Unit): [string, string] {
    const label = unit.model || (unit.source === 'dra' ? `${unit.driver} device` : `${VENDOR_NAMES[unit.vendor]} ${resourceNoun(unit.driver)}`);
    return [`${unit.vendor}/${label}`, label];
}

function tally(units: Unit[], by: (unit: Unit) => [string, string]): Tally[] {
    const out = new Map<string, Tally>();
    for (const unit of units) {
        const [key, label] = by(unit);
        let t = out.get(key);
        if (!t) {
            t = { key, label, vendor: unit.vendor, total: 0, inUse: 0, free: 0, unhealthy: 0, memory: unit.memory };
            out.set(key, t);
        }
        t.total++;
        if (isInUse(unit)) t.inUse++;
        else if (unit.state === 'free') t.free++;
        else if (unit.state === 'unhealthy') t.unhealthy++;
        if (!t.memory && unit.memory) t.memory = unit.memory;
    }
    return [...out.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
}
