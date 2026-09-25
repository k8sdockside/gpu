// What needs someone to look at it, worst first.
//
// The list the dashboard ends on. Each issue is one sentence about one
// object, with the object to open, so "a GPU is lost on gpu-node-3" is also
// the way to get to gpu-node-3.

import type { Inventory } from './inventory.js';
import { DAEMONSETS, NODES, PODS, CLAIMS, type DaemonSet, type ResourceSlice } from './kube.js';
import { count, where, type Tone } from './units.js';
import type { Workloads } from './workloads.js';
import { driverVendor, isAcceleratorDriver, VENDOR_NAMES } from './vendors.js';

export interface Issue {
    tone: Tone;
    title: string;
    detail: string;
    ref: K8sDockside.ObjectRef;
}

// ----- the drivers ------------------------------------------------------------------

/**
 * Whether a DaemonSet is part of getting accelerators onto nodes: a device
 * plugin, a DRA kubelet plugin, a driver installer, feature discovery or the
 * DCGM exporter. Matched by name, the one thing every install method keeps:
 * nvidia-device-plugin-daemonset, gpu-feature-discovery,
 * nvidia-dra-driver-gpu-kubelet-plugin, dra-example-driver-kubeletplugin,
 * amdgpu-device-plugin-daemonset, intel-gpu-plugin, habana-ai-device-plugin,
 * neuron-device-plugin-daemonset, nvidia-dcgm-exporter.
 */
export function isAcceleratorDaemonSet(ds: DaemonSet): boolean {
    const names = [ds.metadata.name, ds.metadata.labels?.['app'] ?? '', ds.metadata.labels?.['app.kubernetes.io/name'] ?? ''].join(' ').toLowerCase();
    return /nvidia|gpu|dcgm|amdgpu|habana|gaudi|neuron|(^|[-\s])dra([-\s]|$)|dra-driver|kubeletplugin|kubelet-plugin|device-plugin/.test(names);
}

export interface DaemonView {
    namespace: string;
    name: string;
    desired: number;
    ready: number;
    tone: Tone;
}

export function acceleratorDaemons(daemonSets: DaemonSet[]): DaemonView[] {
    return daemonSets
        .filter(isAcceleratorDaemonSet)
        .map((ds) => {
            const desired = ds.status?.desiredNumberScheduled ?? 0;
            const ready = ds.status?.numberReady ?? 0;
            const tone: Tone = desired === 0 ? '' : ready >= desired ? 'ok' : ready === 0 ? 'error' : 'warn';
            return { namespace: ds.metadata.namespace ?? '', name: ds.metadata.name, desired, ready, tone };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
}

export interface DriverView {
    /** The DRA driver name or the extended resource. */
    name: string;
    kind: 'DRA driver' | 'device plugin';
    vendor: string;
    nodes: number;
    devices: number;
}

/** Every way accelerators are advertised here: each DRA driver, each device-plugin resource. */
export function drivers(inventory: Inventory, slices: ResourceSlice[]): DriverView[] {
    const out = new Map<string, DriverView>();
    const nodes = new Map<string, Set<string>>();
    for (const unit of inventory.units) {
        const name = unit.source === 'dra' ? unit.driver : unit.partitions.length ? 'nvidia.com/mig-*' : unit.driver;
        const key = `${unit.source}/${name}`;
        const view = out.get(key) ?? { name, kind: unit.source === 'dra' ? 'DRA driver' : 'device plugin', vendor: VENDOR_NAMES[unit.vendor], nodes: 0, devices: 0 };
        view.devices++;
        const seen = nodes.get(key) ?? new Set<string>();
        seen.add(unit.node);
        nodes.set(key, seen);
        view.nodes = seen.size;
        out.set(key, view);
    }
    // A driver that publishes slices with no devices in them is still there, and worth a row.
    for (const slice of slices) {
        const driver = slice.spec?.driver ?? '';
        if (!driver || !isAcceleratorDriver(driver) || out.has(`dra/${driver}`)) continue;
        out.set(`dra/${driver}`, { name: driver, kind: 'DRA driver', vendor: VENDOR_NAMES[driverVendor(driver)], nodes: 0, devices: 0 });
    }
    return [...out.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

// ----- the list ------------------------------------------------------------------------

const RANK: Record<Tone, number> = { error: 0, warn: 1, info: 2, ok: 3, '': 4 };

export function issues(inventory: Inventory, workloads: Workloads, daemons: DaemonView[]): Issue[] {
    const out: Issue[] = [];

    for (const pod of workloads.pods) {
        if (!pod.pending) continue;
        const wants = pod.wants.map((w) => w.short).join(', ');
        out.push({
            tone: pod.never ? 'error' : 'warn',
            title: pod.never ? `${where(pod.namespace, pod.name)} can never start` : `${where(pod.namespace, pod.name)} is waiting for devices`,
            detail: pod.never ? pod.never.replace(/^This can never be scheduled: /, '').replace(/^./, (c) => c.toUpperCase()) : `${pod.reason}${wants ? ` It asks for ${wants}.` : ''}`,
            ref: { kind: PODS, namespace: pod.namespace, name: pod.name },
        });
    }

    for (const node of inventory.nodes) {
        if (!node.name) continue;
        const lost = node.units.filter((u) => u.state === 'unhealthy');
        const lostCells = node.units.flatMap((u) => u.partitions).filter((p) => p.state === 'unhealthy');
        if (!node.ready) {
            out.push({
                tone: 'error',
                title: `${node.name} is not Ready`,
                detail: `Its ${count(node.units.length, 'accelerator')} cannot be used until the node is back.`,
                ref: { kind: NODES, name: node.name },
            });
        }
        if (lost.length > 0) {
            const first = lost[0];
            out.push({
                tone: 'warn',
                title: `${node.name} has lost ${lost.length === 1 ? 'a device' : `${lost.length} devices`}`,
                detail: `${lost.length} of ${node.units.length} ${first?.model || 'devices'} cannot be handed out. ${first?.problem ?? ''}`.trim(),
                ref: { kind: NODES, name: node.name },
            });
        } else if (lostCells.length > 0) {
            out.push({
                tone: 'warn',
                title: `${node.name} has ${count(lostCells.length, 'unhealthy MIG instance')}`,
                detail: 'The device plugin reports them unhealthy; they are left out of what the node can give.',
                ref: { kind: NODES, name: node.name },
            });
        }
        const free = node.units.filter((u) => u.state === 'free').length;
        if (node.unschedulable && free > 0) {
            out.push({
                tone: 'info',
                title: `${node.name} is cordoned`,
                detail: `${count(free, 'free accelerator')} on it cannot take new pods until it is uncordoned.`,
                ref: { kind: NODES, name: node.name },
            });
        }
        for (const note of node.notes) out.push({ tone: 'info', title: `${node.name} advertises its cards twice`, detail: note, ref: { kind: NODES, name: node.name } });
    }

    for (const claim of workloads.claims) {
        if (claim.state === 'allocated' && claim.pods.length === 0) {
            out.push({
                tone: 'info',
                title: `${where(claim.namespace, claim.name)} holds devices nobody uses`,
                detail: `${claim.held.map((h) => h.label).join(', ') || 'Its devices'} ${claim.held.length === 1 ? 'is' : 'are'} set aside for it with no pod using ${claim.held.length === 1 ? 'it' : 'them'}.`,
                ref: { kind: CLAIMS, namespace: claim.namespace, name: claim.name },
            });
        }
        if (claim.state === 'pending' && !workloads.pods.some((p) => p.pending && p.namespace === claim.namespace && p.claims.includes(claim.name))) {
            out.push({
                tone: 'info',
                title: `${where(claim.namespace, claim.name)} is not allocated`,
                detail: claim.why,
                ref: { kind: CLAIMS, namespace: claim.namespace, name: claim.name },
            });
        }
    }

    for (const daemon of daemons) {
        if (daemon.tone !== 'warn' && daemon.tone !== 'error') continue;
        out.push({
            tone: daemon.tone,
            title: `${daemon.name} is not ready everywhere`,
            detail: `${daemon.ready} of ${daemon.desired} pods ready. Nodes without it cannot advertise or prepare their devices.`,
            ref: { kind: DAEMONSETS, namespace: daemon.namespace, name: daemon.name },
        });
    }

    return out.sort((a, b) => RANK[a.tone] - RANK[b.tone]);
}
