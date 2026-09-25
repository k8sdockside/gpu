// Renders every page of the plugin to standalone HTML, with no cluster and no
// app: the same fixtures the render test uses, the plugin's real stylesheet,
// and the app's real theme tokens written onto :root the way the SDK does.
//
//   node preview.mjs <out-dir>
//
// It is a way to look at the pages, not a test -- the test is
// `npm run test`, which asserts on what this draws.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] ?? path.join(ROOT, 'preview');
const APP = path.resolve(ROOT, '../k8sdockside');

const PAGE = '<div id="page"><div id="head"></div><div id="bar" class="bar"></div><p id="first"></p><div id="body"></div></div>';
const PAGES = [
    ['overview', 'Dashboard', 'page', PAGE],
    ['inventory', 'Inventory', 'page', PAGE],
    ['workloads', 'Claims & workloads', 'page', PAGE],
    ['node', 'Panel: Node', 'panel', '<div id="panel"></div>'],
    ['pod', 'Panel: Pod', 'panel', '<div id="panel"></div>'],
    ['claim', 'Panel: ResourceClaim', 'panel', '<div id="panel"></div>'],
];

/**
 * Bundles a TypeScript entry point and imports what it exports.
 *
 * The fragment on the end is not decoration: Node caches an ES module by its
 * URL, and a page is imported once per theme with byte-identical code. Import
 * it twice at the same URL and the second import returns the cached module
 * without running it again -- which draws the first theme and leaves every
 * page of the second blank.
 */
let imports = 0;
async function load(entry, bundle = true) {
    const built = await esbuild.build({
        entryPoints: [entry],
        bundle,
        write: false,
        format: 'esm',
        platform: 'browser',
        target: ['es2022'],
    });
    const code = built.outputFiles[0].text;
    return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${imports++}`);
}

const themes = ['k8sdockside-light', 'k8sdockside-dark'].map((id) =>
    JSON.parse(readFileSync(path.join(APP, 'internal/themes/builtin', `${id}.json`), 'utf8')),
);

// The same fixtures the render test asserts on, bundled to a module this
// script can import.
const fixtures = await load(path.join(ROOT, 'src/fixtures.ts'));

const css = readFileSync(path.join(ROOT, 'ui/gpu.css'), 'utf8');
const logo = readFileSync(path.join(ROOT, 'ui/logo.svg'), 'utf8');

const OBJECTS = {
    node: fixtures.panelObjects.node,
    pod: fixtures.panelObjects.pod,
    claim: fixtures.panelObjects.claim,
};

// The inventory is drawn with one device picked, so the inspector has
// something in it: the H100 two vLLM replicas share.
const STORAGE = { 'inventory.pin': 'dra/gpu.nvidia.com/dgx-h100-02/gpu-3' };

function stub(theme, object) {
    return {
        ready: async () => ({
            pluginId: 'gpu', viewId: '', sectionId: '', object: null,
            contextId: 'preview', contextName: 'gpu-cluster', readable: [], write: false,
            actions: [], theme,
            plugin: { id: 'gpu', name: 'GPU & Accelerators', version: '1.0.0', docs: '', links: [], author: 'K8s Dockside', authorUrl: '' },
        }),
        object: async () => object,
        list: async ({ kind }) => { if (!(kind in fixtures.LISTS)) throw new Error(`the cluster does not serve ${kind}`); return fixtures.LISTS[kind]; },
        get: async () => object,
        open: async () => null, openView: async () => null, openUrl: async () => null,
        summary: async () => ({ pluginId: 'gpu', installed: true, checked: true, requirements: [], cards: [], error: '' }),
        storage: { get: async (key) => STORAGE[key] ?? null, set: async () => null, remove: async () => null, keys: async () => [] },
        actions: async () => [], run: async () => ({ created: '' }), resize: async () => null,
        watch: () => () => {}, namespaces: async () => [],
        charts: async () => fixtures.chartsPanel,
        patch: async () => null, create: async () => ({ name: '' }),
        edit: async () => null, logs: async () => null, on: () => () => {},
    };
}

async function render(page, body, theme, object) {
    const win = new Window({ url: 'https://preview.local/' });
    const { document } = win;
    document.body.innerHTML = body;
    document.body.className = page[2] === 'panel' ? 'panel' : '';

    // What the SDK does before a page runs: the tokens on :root, and the base
    // recorded so the stylesheet's dark rules apply.
    const root = document.documentElement;
    for (const [name, value] of Object.entries(theme.tokens)) root.style.setProperty(`--${name}`, value);
    root.setAttribute('data-theme-base', theme.base);

    // The page expects a browser's globals. Node defines some of these as
    // getters with no setter, so each is defined rather than assigned.
    const globals = ['window', 'document', 'navigator', 'location', 'DOMParser', 'URLSearchParams', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'Event', 'KeyboardEvent', 'CSS', 'addEventListener', 'setTimeout', 'setInterval', 'clearInterval'];
    for (const key of globals) {
        if (win[key] === undefined) continue;
        const value = typeof win[key] === 'function' && key.endsWith('EventListener') ? win[key].bind(win) : win[key];
        Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }
    Object.defineProperty(globalThis, 'k8sdockside', { value: stub(theme, object), configurable: true, writable: true });

    // Each page is bundled fresh: a page runs its work on import, and an
    // already-imported module would not run again.
    await load(path.join(ROOT, 'src/pages', `${page[0]}.ts`));
    for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 1));

    const html = document.body.innerHTML;
    // Every view polls on an interval, so the window has live timers on it
    // and nothing would ever exit until they are stopped.
    await win.happyDOM.close();
    return html;
}

mkdirSync(OUT, { recursive: true });
const index = [];

for (const page of PAGES) {
    for (const theme of themes) {
        const html = await render(page, page[3], theme, OBJECTS[page[0]]);
        const file = `${page[0]}.${theme.base}.html`;
        writeFileSync(
            path.join(OUT, file),
            `<!doctype html><html lang="en" data-theme-base="${theme.base}" style="${Object.entries(theme.tokens).map(([k, v]) => `--${k}:${v}`).join(';')};color-scheme:${theme.base}">
<head><meta charset="utf-8"><title>${page[1]} — ${theme.base}</title><style>${css}</style></head>
<body class="${page[2] === 'panel' ? 'panel' : ''}" style="background:var(--bg);color:var(--text)">${html}</body></html>`,
        );
        if (theme.base === 'light') index.push([page[1], page[0]]);
    }
}

writeFileSync(path.join(OUT, 'logo.svg'), logo);
writeFileSync(
    path.join(OUT, 'index.html'),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>GPU &amp; Accelerators plugin preview</title>
<style>body{font:14px/1.6 system-ui;margin:40px auto;max-width:640px;color:#1a1d21}h1{font-size:20px}li{margin:4px 0}a{color:#0b6bcb}</style></head>
<body><h1>GPU &amp; Accelerators plugin — page preview</h1>
<p>Every page, drawn against fixtures: H100 nodes through NVIDIA's DRA driver (one with a tainted device, one still advertising the device plugin too), an A100 node with static MIG, L4, A10, time-sliced T4 and mixed-MIG nodes through the device plugin (the A10 node has lost a GPU), a cordoned AMD node, the DRA example driver's simulated GPUs, a claim shared by two pods, a pod waiting for four GPUs and one that can never fit.</p>
<ul>${index.map(([label, id]) => `<li>${label} — <a href="${id}.light.html">light</a> · <a href="${id}.dark.html">dark</a></li>`).join('')}</ul>
<p style="color:#5c636b">Static HTML. Buttons and links do nothing, and hovering a device does not fill the inspector: there is no app behind them.</p></body></html>`,
);
console.log(`wrote ${PAGES.length * 2 + 2} files to ${OUT}`);
console.log(`open ${path.join(OUT, 'index.html')}`);
// Anything the pages left running is irrelevant now that the files are out.
process.exit(0);
