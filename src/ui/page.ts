// The things every page in this plugin does the same way.
//
//  1. `start` wraps the page in one try/catch. Every bridge call rejects with
//     an Error carrying a sentence written for a person, so the honest thing
//     to do with a failure is show that sentence -- not a blank page and a
//     console nobody can open, because the page is in a sandboxed frame.
//  2. `fail` puts it where the user is looking.
//  3. Nothing subscribes to the theme: the SDK writes the app's tokens onto
//     :root before `ready()` resolves and rewrites them when the user
//     switches, so a stylesheet in var(--text) follows along on its own. The
//     device squares and rings are coloured by class for the same reason.

import { el, replace } from './dom.js';

/** Shows a failure where the user is looking, as a sentence. */
export function fail(host: HTMLElement, err: unknown): void {
    replace(host, el('div', { class: 'failure' }, el('strong', {}, 'That did not work. '), el('span', {}, message(err))));
}

/** An error's sentence. */
export function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * Runs a page's body once the bridge is ready, and shows anything that goes
 * wrong instead of dying silently.
 */
export function start(hostId: string, body: (ctx: K8sDockside.Context) => Promise<void>): void {
    const run = async () => {
        const host = document.getElementById(hostId);
        try {
            const ctx = await k8sdockside.ready();
            await body(ctx);
        } catch (err) {
            if (host) fail(host, err);
        }
    };
    void run();
}

/**
 * Runs `body` now and every `ms` milliseconds after it, and hands anything it
 * throws to `onError`. The page has no network of its own, so this is how a
 * view stays live: the bridge's `watch` polls one list, and this polls the
 * handful of lists a page needs together.
 */
export function every(ms: number, body: () => Promise<void>, onError: (err: unknown) => void): () => void {
    let stopped = false;
    const tick = async () => {
        if (stopped) return;
        try {
            await body();
        } catch (err) {
            onError(err);
        }
    };
    void tick();
    const timer = setInterval(() => void tick(), ms);
    return () => {
        stopped = true;
        clearInterval(timer);
    };
}

/** How long ago a timestamp was, the way the app writes it; the app's own formatter when it has one. */
export function ago(timestamp: string | undefined): string {
    if (!timestamp) return '';
    if (k8sdockside.format) return k8sdockside.format.age(timestamp);
    const then = Date.parse(timestamp);
    if (Number.isNaN(then)) return '';
    const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 172800) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
}

/** A value kept between visits, when the app is new enough to keep one; `fallback` otherwise. */
export async function remembered<T>(key: string, fallback: T): Promise<T> {
    try {
        const value = await k8sdockside.storage?.get(key);
        return value === null || value === undefined ? fallback : (value as T);
    } catch {
        return fallback;
    }
}

export function remember(key: string, value: unknown): void {
    void k8sdockside.storage?.set(key, value)?.catch(() => undefined);
}
