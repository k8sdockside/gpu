// GPUs a pod reaches without asking the scheduler for them.
//
// The device plugin and DRA are the scheduler's ways of handing out a GPU.
// There is a third, older way that goes round it: run the container with
// NVIDIA's container runtime (`runtimeClassName: nvidia`, or a node whose
// default runtime is NVIDIA's) and name the cards in its env --
//
//   NVIDIA_VISIBLE_DEVICES=2         the runtime mounts GPU 2 into the container
//   NVIDIA_VISIBLE_DEVICES=GPU-5e83… the same card, by UUID
//   CUDA_VISIBLE_DEVICES=0,1         CUDA uses cards 0 and 1 of those it can see
//
// A pod set up that way asks for no nvidia.com/gpu, so the scheduler, the
// device plugin and DCGM's pod mapping all think the card is free -- while
// it holds a model in its memory. It is common where GPUs were set up by
// hand, and it is the only record of which pod has which card, so it is read
// here. Only a literal value in the pod's spec can be read: `all` baked into
// a CUDA image's own env is not in the spec, and neither is a value from a
// ConfigMap or Secret.

import type { Pod } from './kube.js';
import { podClaims, podDeviceRequests } from './requests.js';

/** The env names read, most specific to the runtime first. */
export const VISIBLE_ENV = ['NVIDIA_VISIBLE_DEVICES', 'CUDA_VISIBLE_DEVICES'] as const;

export interface Visible {
    /** Every GPU on the node. */
    all: boolean;
    /** Indexes ("0") and UUIDs ("GPU-…"), as written. */
    devices: string[];
    /** Which variable said so, for the sentence under it. */
    env: string;
    container: string;
}

/** Reads one env value. Undefined for one that names no card: "none", "void", "". */
export function parseVisible(value: string): Pick<Visible, 'all' | 'devices'> | undefined {
    const text = value.trim();
    if (!text || /^(none|void|NoDevFiles)$/i.test(text)) return undefined;
    if (/^all$/i.test(text)) return { all: true, devices: [] };
    const devices = text
        .split(',')
        .map((d) => d.trim())
        .filter((d) => /^\d+$/.test(d) || /^(GPU|MIG)-[0-9a-f-]+$/i.test(d));
    return devices.length ? { all: false, devices } : undefined;
}

/** Whether a pod asks the scheduler for an accelerator, by either path. */
export function asksScheduler(pod: Pod): boolean {
    return Object.keys(podDeviceRequests(pod)).length > 0 || podClaims(pod).length > 0;
}

/**
 * The cards a pod names in its env, when it asks the scheduler for none.
 *
 * A pod that does ask is left alone: the device plugin or DRA already put it
 * on its cards, and CUDA_VISIBLE_DEVICES in it then counts within what it
 * was given, not the machine's own numbering.
 */
export function visibleDevices(pod: Pod): Visible | undefined {
    if (asksScheduler(pod)) return undefined;
    for (const container of pod.spec?.containers ?? []) {
        for (const name of VISIBLE_ENV) {
            const value = container.env?.find((e) => e.name === name)?.value;
            if (value === undefined) continue;
            const parsed = parseVisible(value);
            if (parsed) return { ...parsed, env: name, container: container.name ?? '' };
        }
    }
    return undefined;
}

/** Whether a pod runs with NVIDIA's runtime by its runtime class, and so may reach a GPU it did not ask for. */
export function nvidiaRuntime(pod: Pod): boolean {
    return /nvidia/i.test(pod.spec?.runtimeClassName ?? '');
}
