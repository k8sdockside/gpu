// What the names mean: which extended resources are devices, which vendor a
// DRA driver belongs to, what a MIG profile is, and what a node's labels say
// about the card in it.
//
// The resource and label names are the ones the vendors' own components
// write, not guesses:
//
//   nvidia.com/gpu, nvidia.com/mig-<profile>, nvidia.com/gpu.shared
//       NVIDIA's device plugin (github.com/NVIDIA/k8s-device-plugin). The
//       `.shared` name is what time-slicing advertises with renameByDefault.
//   nvidia.com/gpu.product, .memory (MiB), .count, .replicas,
//   .sharing-strategy, nvidia.com/cuda.driver-version.full, ...
//       gpu-feature-discovery, from the same repository (internal/lm).
//   gpu.nvidia.com
//       NVIDIA's DRA driver (github.com/NVIDIA/k8s-dra-driver-gpu), whose
//       devices carry `type` ("gpu" or "mig"), `productName`, `uuid`,
//       `driverVersion`, `cudaDriverVersion` and, on a MIG device, `profile`
//       and `parentUUID`.
//   gpu.example.com
//       kubernetes-sigs/dra-example-driver, which simulates GPUs.
//   amd.com/gpu, gpu.intel.com/i915, gpu.intel.com/xe, habana.ai/gaudi,
//   aws.amazon.com/neuron(device), google.com/tpu
//       the other vendors' device plugins.
//
// Intel's GPU plugin also advertises gpu.intel.com/millicores,
// gpu.intel.com/memory.max and gpu.intel.com/tiles when its resource
// management is on. Those are fractions of a device, not devices, and
// counting them would turn one GPU into a thousand.

export type Vendor = 'nvidia' | 'amd' | 'intel' | 'habana' | 'aws' | 'google' | 'example' | 'other';

export const VENDOR_NAMES: Record<Vendor, string> = {
    nvidia: 'NVIDIA',
    amd: 'AMD',
    intel: 'Intel',
    habana: 'Intel Gaudi',
    aws: 'AWS Neuron',
    google: 'Google TPU',
    example: 'Simulated (example driver)',
    other: 'Other',
};

/** The extended resources that count whole devices, and whose they are. */
const DEVICE_RESOURCES: [RegExp, Vendor][] = [
    [/^nvidia\.com\/gpu(\.shared)?$/, 'nvidia'],
    [/^nvidia\.com\/mig-\d+(c\.\d+)?g\.\d+gb(\+[a-z]+)?$/, 'nvidia'],
    [/^amd\.com\/gpu$/, 'amd'],
    [/^gpu\.intel\.com\/(i915|xe)$/, 'intel'],
    [/^habana\.ai\/gaudi$/, 'habana'],
    [/^aws\.amazon\.com\/neuron(device)?$/, 'aws'],
    [/^google\.com\/tpu$/, 'google'],
];

/** Whether an extended resource name counts accelerators, as opposed to CPU, memory or a device's fraction. */
export function isDeviceResource(name: string): boolean {
    return DEVICE_RESOURCES.some(([pattern]) => pattern.test(name));
}

/** The vendor behind an extended resource name, or undefined for one that is not a device. */
export function resourceVendor(name: string): Vendor | undefined {
    return DEVICE_RESOURCES.find(([pattern]) => pattern.test(name))?.[1];
}

/**
 * The vendor behind a DRA driver name. Drivers are named by a DNS subdomain
 * their vendor owns, so the name gives it away: gpu.nvidia.com,
 * gpu.amd.com, gpu.intel.com.
 */
export function driverVendor(driver: string): Vendor {
    const name = driver.toLowerCase();
    if (name === 'gpu.example.com' || name.endsWith('.example.com')) return 'example';
    if (/(^|\.)nvidia\.com$/.test(name)) return 'nvidia';
    if (/(^|\.)amd\.com$/.test(name)) return 'amd';
    if (/(^|\.)habana\.ai$/.test(name)) return 'habana';
    if (/(^|\.)intel\.com$/.test(name)) return 'intel';
    if (/(^|\.)(amazon|aws)\.com$/.test(name)) return 'aws';
    if (/(^|\.)google\.com$/.test(name)) return 'google';
    return 'other';
}

/**
 * DRA drivers that publish something other than accelerators. NVIDIA's
 * compute-domain driver hands out IMEX channels -- a way for GPUs on
 * different nodes to share memory -- and counting those as GPUs would double
 * a GB200 rack.
 */
export function isAcceleratorDriver(driver: string): boolean {
    return !/^compute-domain\./.test(driver);
}

// ----- MIG --------------------------------------------------------------------

export interface MigProfile {
    /** As written: "1g.10gb", "3g.40gb", "1g.10gb+me", "1c.3g.40gb". */
    name: string;
    /** Compute slices of the GPU it takes: the number before the `g`. */
    slices: number;
    /** Memory in the profile's own gigabytes, as NVIDIA names it: 10 for "1g.10gb". */
    gigabytes: number;
}

/**
 * Reads a MIG profile name.
 *
 * NVIDIA writes them `<g>g.<mem>gb`, optionally with a compute-instance
 * prefix (`1c.3g.40gb`) or a media-extension suffix (`1g.10gb+me`). The `g`
 * is what matters for drawing: an A100 or H100 has seven compute slices, and
 * a 3g profile takes three of them.
 */
export function parseMigProfile(text: string): MigProfile | undefined {
    const match = /^(?:mig-)?(?:(\d+)c\.)?(\d+)g\.(\d+)gb(\+[a-z]+)?$/i.exec(text.trim());
    if (!match) return undefined;
    const slices = Number(match[2]);
    const gigabytes = Number(match[3]);
    if (!(slices > 0)) return undefined;
    return { name: text.replace(/^mig-/, ''), slices, gigabytes };
}

/** The profile a `nvidia.com/mig-<profile>` resource name hands out. */
export function migResourceProfile(resource: string): MigProfile | undefined {
    const match = /^nvidia\.com\/mig-(.+)$/.exec(resource);
    return match ? parseMigProfile(match[1] ?? '') : undefined;
}

/**
 * How many compute slices a GPU of this model divides into. Seven on every
 * MIG-capable part except the A30, which has four. Anything unrecognised is
 * taken as seven, the common case, since a wrong guess only changes how
 * finely a square is divided.
 */
export function migSlicesFor(product: string): number {
    return /\bA30\b/i.test(product.replace(/[-_]/g, ' ')) ? 4 : 7;
}

// ----- names ------------------------------------------------------------------

/**
 * A product name as a person would say it.
 *
 * GFD sanitises spaces into dashes and appends `-SHARED` when time-slicing is
 * on ("NVIDIA-H100-80GB-HBM3-SHARED"); the DRA driver writes the name NVML
 * gives ("NVIDIA H100 80GB HBM3"); AMD's labeller uses underscores. All three
 * become "H100 80GB HBM3" -- the vendor is shown beside it anyway. The example driver's
 * "LATEST-GPU-MODEL" becomes "LATEST GPU MODEL", which is as good as it gets.
 */
export function friendlyModel(raw: string): string {
    let name = raw.trim();
    if (!name) return '';
    // Spaces, dashes and underscores all separate words in one source or another;
    // written with spaces, "A100-SXM4-80GB" from NVML and "NVIDIA-A100-SXM4-80GB"
    // from GFD group together.
    name = name.replace(/-SHARED$/, '').replace(/[_-]+/g, ' ');
    name = name.replace(/^(NVIDIA|AMD|Intel\(R\)|Intel)\s+/i, '');
    return name.replace(/\s+/g, ' ').trim();
}

/** Which vendor-specific labels a node's card is described by. */
export interface NodeCard {
    product: string;
    /** Bytes, 0 when no label says. */
    memory: number;
    /** GPUs GFD counted on the machine -- physical cards, whatever the device plugin advertises. */
    count: number;
    /** Time-slicing or MPS replicas per GPU; 1 when not shared. */
    replicas: number;
    sharing: string;
    driverVersion: string;
    cudaVersion: string;
    migStrategy: string;
}

/**
 * The card on a node, as its labels describe it. Only NVIDIA's GFD and AMD's
 * node labeller write these; a node without them still has its devices
 * counted, just without a model name.
 */
export function nodeCard(labels: Record<string, string> | undefined): NodeCard {
    const l = labels ?? {};
    const num = (key: string) => {
        const n = Number(l[key]);
        return Number.isFinite(n) && n > 0 ? n : 0;
    };
    const joined = (...keys: string[]) => {
        const parts = keys.map((key) => l[key]).filter((v): v is string => v !== undefined && v !== '');
        return parts.length === keys.length ? parts.join('.') : '';
    };
    const product = l['nvidia.com/gpu.product'] ?? l['amd.com/gpu.product-name'] ?? l['beta.amd.com/gpu.product-name'] ?? '';
    const mib = num('nvidia.com/gpu.memory');
    const amdVram = l['amd.com/gpu.vram'] ?? l['beta.amd.com/gpu.vram'] ?? '';
    return {
        product,
        memory: mib > 0 ? mib * 1024 ** 2 : amdVram ? vram(amdVram) : 0,
        count: num('nvidia.com/gpu.count'),
        replicas: Math.max(1, num('nvidia.com/gpu.replicas')),
        sharing: l['nvidia.com/gpu.sharing-strategy'] ?? '',
        driverVersion:
            l['nvidia.com/cuda.driver-version.full'] ??
            (joined('nvidia.com/cuda.driver.major', 'nvidia.com/cuda.driver.minor', 'nvidia.com/cuda.driver.rev') ||
                l['amd.com/gpu.driver-version'] ||
                ''),
        cudaVersion: l['nvidia.com/cuda.runtime-version.full'] ?? joined('nvidia.com/cuda.runtime.major', 'nvidia.com/cuda.runtime.minor'),
        migStrategy: l['nvidia.com/mig.strategy'] ?? '',
    };
}

/** AMD writes VRAM as "192G" or "64G"; read it as bytes. */
function vram(text: string): number {
    const match = /^(\d+(?:\.\d+)?)\s*([GMT])i?B?$/i.exec(text.trim());
    if (!match) return 0;
    const n = Number(match[1]);
    const unit = (match[2] ?? 'G').toUpperCase();
    return n * (unit === 'T' ? 1024 ** 4 : unit === 'M' ? 1024 ** 2 : 1024 ** 3);
}

/** The plain word for a device resource, for a sentence: "GPU", "MIG 1g.10gb", "Gaudi". */
export function resourceNoun(resource: string): string {
    const mig = migResourceProfile(resource);
    if (mig) return `MIG ${mig.name}`;
    if (resource === 'habana.ai/gaudi') return 'Gaudi';
    if (resource.startsWith('aws.amazon.com/')) return 'Neuron device';
    if (resource === 'google.com/tpu') return 'TPU';
    return 'GPU';
}
