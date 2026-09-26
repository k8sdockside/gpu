// Reading the cluster, all of it at once.
//
// Every kind is read in parallel, and one the cluster does not serve -- the
// DRA kinds on a cluster older than 1.32, or with the API switched off -- is
// recorded as missing and read as empty. A cluster with only device plugins
// is an ordinary cluster, not an error, and the pages say which half they
// are looking at.

import { noDcgm, readDcgm, type Dcgm } from '../model/dcgm.js';
import { buildInventory, type Inventory } from '../model/inventory.js';
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

/** What the `data-` charts answered, and DCGM's cards read out of it. */
export interface Metrics {
    dcgm: Dcgm;
    /** The whole answer, for the pages that read other `data-` charts from it; null without one. */
    panel: K8sDockside.ChartsPanel | null;
}

/**
 * DCGM's view of the cards, through the plugin's `data-` charts.
 *
 * Asked for ten minutes back -- only the last point of each series is read,
 * and a window any shorter would miss a Prometheus scraping once a minute --
 * and no more often than every 45 seconds, whatever the page's own refresh:
 * each ask is a dozen range queries. A cluster with no Prometheus, or an app
 * that refuses the call, is a Dcgm with nothing in it, never an error: the
 * pages work from the API alone.
 */
export function dcgmReader(minutes = 10, every = 45_000): (snap: Snapshot, gpuNodes?: string[]) => Promise<Metrics> {
    let panel: K8sDockside.ChartsPanel | null = null;
    let asked = 0;
    let failure = '';
    return async (snap, gpuNodes = []) => {
        if (!panel || Date.now() - asked >= every) {
            asked = Date.now();
            try {
                panel = await k8sdockside.charts({ minutes });
                failure = '';
            } catch (err) {
                failure = message(err);
            }
        }
        return { dcgm: panel ? readDcgm(panel, snap.nodes, snap.pods, gpuNodes) : noDcgm(failure), panel };
    };
}

/**
 * The inventory with DCGM's word on it: built from the API first, so DCGM's
 * hostnames can be matched to the nodes that have accelerators, and again
 * with DCGM's cards when it reported any.
 */
export async function inventoryWithDcgm(snap: Snapshot, read: ReturnType<typeof dcgmReader>): Promise<Metrics & { inventory: Inventory }> {
    const plain = buildInventory(snap);
    const metrics = await read(
        snap,
        plain.nodes.map((n) => n.name).filter((n) => n !== ''),
    );
    return { ...metrics, inventory: metrics.dcgm.gpus.length ? buildInventory(snap, metrics.dcgm.gpus) : plain };
}
