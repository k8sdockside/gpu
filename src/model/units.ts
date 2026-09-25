// Sizes, quantities, and the tones this plugin colours things by.
//
// Kept apart from the Kubernetes types because the drawing helpers in src/ui
// need them and should not have to import a page's worth of device knowledge
// to get a memory size written.

/** The tones the app's theme has: '' is "no opinion", drawn in the faint colour. */
export type Tone = 'ok' | 'warn' | 'error' | 'info' | '';

/** Bytes in the shorthand Kubernetes uses: 1.5 Gi, 940 Mi, 12 Ti. */
export function size(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return '0';
    const units = ['B', 'Ki', 'Mi', 'Gi', 'Ti', 'Pi', 'Ei'];
    let n = value;
    let unit = 0;
    while (n >= 1024 && unit < units.length - 1) {
        n /= 1024;
        unit++;
    }
    const digits = n >= 100 || unit === 0 ? 0 : n >= 10 ? 1 : 2;
    return `${n.toFixed(digits)} ${units[unit]}`;
}

/**
 * A GPU's memory, the way people say it: "80 GiB", "9.5 GiB", "512 MiB".
 *
 * Rounder than `size`, because a card's memory is read as a model trait, not
 * as a measurement: an H100 reports 81559 MiB and nobody wants "79.6 Gi" on a
 * tile that says "80GB" in its product name.
 */
export function memory(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    const gib = bytes / 1024 ** 3;
    if (gib >= 10) return `${Math.round(gib)} GiB`;
    if (gib >= 1) return `${(Math.round(gib * 10) / 10).toString()} GiB`;
    return `${Math.round(bytes / 1024 ** 2)} MiB`;
}

/** A fraction as a percentage, clamped to 0-100 and safe when the whole is zero. */
export function percent(part: number, whole: number): number {
    if (!(whole > 0)) return 0;
    return Math.max(0, Math.min(100, (part / whole) * 100));
}

/**
 * A Kubernetes quantity -- "80Gi", "81559Mi", "500M", "8" -- as a number.
 *
 * Device capacities and node resources are all written this way, and a page
 * that adds them up must not read "80Gi" as 80. Both the binary suffixes
 * (Ki, Mi, Gi ...) and the decimal ones (k, M, G ...) are understood, and so
 * is the exponent form ("1e3") the API server sometimes normalises to.
 */
export function quantity(value: string | number | undefined | null): number {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (!value) return 0;
    const match = /^\s*([0-9.]+(?:[eE][+-]?[0-9]+)?)\s*([EPTGMk]i?|m)?\s*$/.exec(value);
    if (!match) return 0;
    const n = Number(match[1]);
    if (!Number.isFinite(n)) return 0;
    const suffix = match[2] ?? '';
    const binary: Record<string, number> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6 };
    const decimal: Record<string, number> = { k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18, m: 1e-3 };
    return n * (binary[suffix] ?? decimal[suffix] ?? 1);
}

/** A number of things, with the noun made plural when it needs to be. */
export function count(n: number, noun: string, plural = `${noun}s`): string {
    return `${n} ${n === 1 ? noun : plural}`;
}

/** `namespace/name`, or just the name when there is no namespace. */
export function where(namespace: string | undefined, name: string): string {
    return namespace ? `${namespace}/${name}` : name;
}
