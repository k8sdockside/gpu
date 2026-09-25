// Reading the cluster, all of it at once.
//
// Every kind is read in parallel, and one the cluster does not serve -- the
// DRA kinds on a cluster older than 1.32, or with the API switched off -- is
// recorded as missing and read as empty. A cluster with only device plugins
// is an ordinary cluster, not an error, and the pages say which half they
// are looking at.

import { CLAIMS, CLASSES, DAEMONSETS, EVENTS, NODES, PODS, SLICES, TEMPLATES, emptySnapshot, type Snapshot } from '../model/kube.js';
import { message } from './page.js';

const KINDS: [keyof Omit<Snapshot, 'missing'>, string][] = [
    ['nodes', NODES],
    ['pods', PODS],
    ['slices', SLICES],
    ['claims', CLAIMS],
    ['templates', TEMPLATES],
    ['classes', CLASSES],
    ['daemonSets', DAEMONSETS],
    ['events', EVENTS],
];

/** What a page needs, and nothing it does not: events are only asked for by pages that explain waiting pods. */
export async function loadSnapshot(options: { events?: boolean; daemonSets?: boolean } = {}): Promise<Snapshot> {
    const snap = emptySnapshot();
    const lists = snap as unknown as Record<string, K8sDockside.KubeObject[]>;
    await Promise.all(
        KINDS.filter(([field]) => (field === 'events' ? options.events !== false : field === 'daemonSets' ? options.daemonSets !== false : true)).map(async ([field, kind]) => {
            try {
                lists[field] = await k8sdockside.list({ kind });
            } catch (err) {
                snap.missing[kind] = message(err);
            }
        }),
    );
    // Without nodes or pods nothing here means anything; say so rather than draw zeros.
    if (snap.missing[NODES]) throw new Error(`could not read the cluster's nodes: ${snap.missing[NODES]}`);
    return snap;
}

/** Whether the cluster serves Dynamic Resource Allocation at all. */
export function servesDra(snap: Snapshot): boolean {
    return !snap.missing[SLICES];
}
