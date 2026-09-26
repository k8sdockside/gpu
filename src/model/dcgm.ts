// What NVIDIA's DCGM exporter says about each card, read back out of Prometheus.
//
// The device plugin tells the API how many GPUs a pod asked for and never
// which ones. DCGM knows: it reads every card through NVML -- its index, its
// UUID, its PCI bus address, its model -- and, with pod mapping on (the GPU
// Operator's default), asks the kubelet which pod each card was handed to.
// It writes all of that as labels on every metric:
//
//   DCGM_FI_DEV_FB_USED{gpu="0", UUID="GPU-d189…", pci_bus_id="00000000:02:00.0",
//       device="nvidia0", modelName="NVIDIA H100 NVL", Hostname="gpu-01",
//       namespace="vllm-ornith", pod="vllm-ornith-69c7…", container="vllm"} 61234
//
// The app hands a plugin its Prometheus data only through its declared
// charts. A chart with no `legend` names each series by its whole label set
// ("UUID=GPU-…, gpu=0, modelName=NVIDIA H100 NVL, …"), which is exactly the
// identity wanted here -- so the manifest declares a handful of `data-`
// charts that no page draws, and this module reads their labels and last
// values.
//
// Prometheus renames a target's own `namespace` and `pod` labels to
// `exported_namespace` and `exported_pod` unless the scrape honours labels,
// and then `namespace` and `pod` are the exporter's own. So a pod named in a
// series is believed only if it is live, on that node, and asks for an
// accelerator -- which is also what keeps a stale series from a pod that has
// since gone from putting a ghost on a card.

import { isLive, type Node, type Pod } from './kube.js';
import { podClaims, podDeviceRequests } from './requests.js';

/** The chart ids the manifest declares for this module. Kept in step with plugin.json. */
export const DCGM_CHARTS = {
    /** The identity charts: every label DCGM writes, one series per card (and per pod on it). */
    memoryUsed: 'data-dcgm-memory-used',
    util: 'data-dcgm-util',
    memoryFree: 'data-dcgm-memory-free',
    temperature: 'data-dcgm-temperature',
    power: 'data-dcgm-power',
    nvlink: 'data-dcgm-nvlink',
} as const;

/** Charts whose data this plugin reads rather than draws: never shown as charts. */
export function isDataChart(id: string): boolean {
    return id.startsWith('data-');
}

export interface DcgmConsumer {
    namespace: string;
    pod: string;
    container: string;
}

/** One physical card, as DCGM reports it. */
export interface DcgmGpu {
    /** The node it is on: DCGM's Hostname, matched to a Node's name. */
    node: string;
    /** As nvidia-smi numbers it: "0". */
    index: string;
    uuid: string;
    /** "00000000:02:00.0". */
    pciBus: string;
    /** As NVML writes it: "NVIDIA H100 NVL". */
    model: string;
    /** "nvidia0". */
    device: string;
    driverVersion: string;
    /** Whether it is split into MIG instances (DCGM reports a series per instance). */
    mig: boolean;
    /** Pods DCGM says the card was handed to, each checked against the API. */
    consumers: DcgmConsumer[];
    /** Utilisation, 0-1. */
    util?: number;
    /** Framebuffer bytes in use and free. */
    memoryUsed?: number;
    memoryFree?: number;
    /** Degrees Celsius. */
    temperature?: number;
    /** Watts. */
    power?: number;
    /** NVLink traffic, bytes per second, both directions. */
    nvlink?: number;
}

export interface DcgmStatus {
    /** Whether the cluster has a Prometheus the app can ask. */
    prometheus: boolean;
    /** Whether Prometheus has DCGM series for any card. */
    found: boolean;
    /** Whether any card's series name a pod that checks out: DCGM's pod mapping is on. */
    mapping: boolean;
    /** The Prometheus, for a sentence: "monitoring/prometheus-operated:9090". */
    describe: string;
    /** Why there is no answer, when there is none. */
    error: string;
    /** Hostnames DCGM reports that match no node. */
    unmatched: string[];
}

export interface Dcgm {
    gpus: DcgmGpu[];
    status: DcgmStatus;
}

export function noDcgm(error = ''): Dcgm {
    return { gpus: [], status: { prometheus: false, found: false, mapping: false, describe: '', error, unmatched: [] } };
}

/**
 * Reads a series' name back into its labels.
 *
 * The app writes a label set as `key=value` pairs sorted by key and joined
 * with ", ". A value may itself hold ", " -- a model name could -- so a pair
 * is found by where the next `, key=` begins rather than by splitting.
 */
export function parseLabels(name: string): Record<string, string> {
    const out: Record<string, string> = {};
    const starts: { key: string; at: number; from: number }[] = [];
    const pattern = /(?:^|, )([A-Za-z_][A-Za-z0-9_]*)=/g;
    for (let match = pattern.exec(name); match; match = pattern.exec(name)) {
        starts.push({ key: match[1] ?? '', at: match.index, from: match.index + match[0].length });
    }
    starts.forEach((start, i) => {
        const next = starts[i + 1];
        out[start.key] = name.slice(start.from, next ? next.at : name.length);
    });
    return out;
}

export interface Sample {
    labels: Record<string, string>;
    value: number;
}

/**
 * The series of a chart that are still current, with their last value.
 *
 * `charts()` answers with a window of history. A series that stopped a while
 * before the others did -- a pod that finished an hour ago -- is history,
 * not the present, and is left out.
 */
export function current(chart: K8sDockside.Chart | undefined): Sample[] {
    if (!chart) return [];
    const series = chart.series.filter((s) => s.points.length > 0);
    const lastOf = (s: K8sDockside.ChartSeries) => s.points[s.points.length - 1] as K8sDockside.ChartPoint;
    const newest = Math.max(...series.map((s) => lastOf(s).t), 0);
    const spacing = Math.max(
        15,
        ...series.map((s) => {
            const n = s.points.length;
            return n > 1 ? (s.points[n - 1] as K8sDockside.ChartPoint).t - (s.points[n - 2] as K8sDockside.ChartPoint).t : 0;
        }),
    );
    const cutoff = newest - Math.max(60, 3 * spacing);
    return series.filter((s) => lastOf(s).t >= cutoff).map((s) => ({ labels: parseLabels(s.name), value: lastOf(s).v }));
}

/** DCGM's name for the node, whichever label it arrived under. */
function hostOf(labels: Record<string, string>): string {
    return labels['Hostname'] ?? labels['kubernetes_node'] ?? labels['node'] ?? '';
}

/**
 * Finds the Node a DCGM hostname is. Usually it is the node's name exactly
 * (the GPU Operator passes NODE_NAME); a bare exporter reports the machine's
 * hostname, which may be the short form of an FQDN node name or differ in
 * case. With one GPU node and one hostname, they are the same machine.
 */
function nodeMatcher(nodes: Node[], hosts: string[], gpuNodes: string[]): (host: string) => string {
    const names = nodes.map((n) => n.metadata.name);
    const short = (name: string) => name.toLowerCase().split('.')[0] ?? '';
    const distinct = [...new Set(hosts)];
    return (host) => {
        if (names.includes(host)) return host;
        const lower = names.find((n) => n.toLowerCase() === host.toLowerCase());
        if (lower) return lower;
        const same = names.filter((n) => short(n) === short(host));
        if (same.length === 1 && same[0]) return same[0];
        if (distinct.length === 1 && gpuNodes.length === 1 && gpuNodes[0]) return gpuNodes[0];
        return '';
    };
}

/** Whether a pod is one the device plugin or DRA could have handed a card to. */
function asksForDevices(pod: Pod): boolean {
    return Object.keys(podDeviceRequests(pod)).length > 0 || podClaims(pod).length > 0;
}

/**
 * Every card DCGM reports, with its pods and its latest numbers.
 *
 * `gpuNodes` are the nodes the API already knows have accelerators, for
 * matching a hostname that is not a node's name.
 */
export function readDcgm(panel: K8sDockside.ChartsPanel | null, nodes: Node[], pods: Pod[], gpuNodes: string[] = []): Dcgm {
    if (!panel) return noDcgm();
    const status: DcgmStatus = { prometheus: panel.source.available, found: false, mapping: false, describe: panel.source.describe, error: panel.source.error, unmatched: [] };
    if (!panel.source.available) return { gpus: [], status };

    const byId = new Map(panel.charts.map((c) => [c.id, c]));
    const used = current(byId.get(DCGM_CHARTS.memoryUsed));
    const util = current(byId.get(DCGM_CHARTS.util));
    const identity = [...used, ...util];
    if (identity.length === 0) return { gpus: [], status };
    status.found = true;

    const matchNode = nodeMatcher(nodes, identity.map((s) => hostOf(s.labels)), gpuNodes);
    const livePods = new Map(pods.filter(isLive).map((p) => [`${p.metadata.namespace ?? ''}/${p.metadata.name}`, p]));
    const unmatched = new Set<string>();

    const gpus = new Map<string, DcgmGpu>();
    const keyOf = (labels: Record<string, string>) => `${hostOf(labels)}/${labels['UUID'] ?? labels['gpu'] ?? ''}`;
    const gpuFor = (labels: Record<string, string>): DcgmGpu => {
        const key = keyOf(labels);
        let gpu = gpus.get(key);
        if (!gpu) {
            const host = hostOf(labels);
            const node = matchNode(host);
            if (!node && host) unmatched.add(host);
            gpu = {
                node: node || host,
                index: labels['gpu'] ?? '',
                uuid: labels['UUID'] ?? '',
                pciBus: labels['pci_bus_id'] ?? '',
                model: labels['modelName'] ?? '',
                device: labels['device'] ?? '',
                driverVersion: labels['DCGM_FI_DRIVER_VERSION'] ?? '',
                mig: false,
                consumers: [],
            };
            gpus.set(key, gpu);
        }
        return gpu;
    };

    for (const { labels } of identity) {
        const gpu = gpuFor(labels);
        if (labels['GPU_I_ID'] !== undefined && labels['GPU_I_ID'] !== '') gpu.mig = true;
        const consumer = consumerOf(labels, gpu.node, livePods);
        if (consumer && !gpu.consumers.some((c) => c.namespace === consumer.namespace && c.pod === consumer.pod)) gpu.consumers.push(consumer);
    }

    // The numbers. A card split into MIG instances has one series per instance;
    // what is in use adds up, and the rest are the card's own.
    const each = (samples: Sample[], apply: (gpu: DcgmGpu, value: number, labels: Record<string, string>) => void) => {
        for (const { labels, value } of samples) {
            const gpu = gpus.get(keyOf(labels));
            if (gpu) apply(gpu, value, labels);
        }
    };
    const mib = 1024 ** 2;
    const perCard = new Set<string>();
    each(used, (gpu, v, labels) => {
        // One series per pod on a shared card, each with the card's whole number: count it once.
        const key = `${gpu.node}/${gpu.uuid}/${labels['GPU_I_ID'] ?? ''}`;
        if (perCard.has(key)) return;
        perCard.add(key);
        gpu.memoryUsed = (gpu.memoryUsed ?? 0) + v * mib;
    });
    each(util, (gpu, v) => (gpu.util = Math.max(gpu.util ?? 0, v / 100)));
    each(current(byId.get(DCGM_CHARTS.memoryFree)), (gpu, v) => (gpu.memoryFree = (gpu.memoryFree ?? 0) + v * mib));
    each(current(byId.get(DCGM_CHARTS.temperature)), (gpu, v) => (gpu.temperature = v));
    each(current(byId.get(DCGM_CHARTS.power)), (gpu, v) => (gpu.power = v));
    each(current(byId.get(DCGM_CHARTS.nvlink)), (gpu, v) => (gpu.nvlink = v));

    const list = [...gpus.values()].sort((a, b) => a.node.localeCompare(b.node) || Number(a.index) - Number(b.index) || a.uuid.localeCompare(b.uuid));
    status.mapping = list.some((g) => g.consumers.length > 0);
    status.unmatched = [...unmatched].sort();
    return { gpus: list, status };
}

/**
 * The pod a series names, if it is one that could hold the card: live, on
 * the card's node, and asking for an accelerator. `exported_*` wins over the
 * plain labels, which may be the exporter's own.
 */
function consumerOf(labels: Record<string, string>, node: string, pods: Map<string, Pod>): DcgmConsumer | undefined {
    const candidates: [string, string, string][] = [
        [labels['exported_namespace'] ?? '', labels['exported_pod'] ?? '', labels['exported_container'] ?? ''],
        [labels['namespace'] ?? '', labels['pod'] ?? '', labels['container'] ?? ''],
    ];
    for (const [namespace, name, container] of candidates) {
        if (!namespace || !name) continue;
        const pod = pods.get(`${namespace}/${name}`);
        if (!pod) continue;
        if (node && pod.spec?.nodeName && pod.spec.nodeName !== node) continue;
        if (!asksForDevices(pod)) continue;
        return { namespace, pod: name, container };
    }
    return undefined;
}

/** A UUID short enough to read: "GPU-d1891b91". */
export function shortUuid(uuid: string): string {
    const match = /^((?:GPU|MIG)-)?([0-9a-f]{8})/i.exec(uuid);
    return match ? `${match[1] ?? ''}${match[2]}` : uuid.slice(0, 12);
}
