// The pieces the pages are drawn from: tiles, rings, bars, pills, blocks.
//
// They are built as SVG and CSS classes rather than with colour values, so
// the app's theme tokens colour them and a switch from light to dark needs no
// JavaScript at all.

import { el, replace } from './dom.js';
import { percent, type Tone } from '../model/units.js';

/** An SVG element, with attributes. SVG needs its own namespace. */
export function svgEl(tag: string, attrs: Record<string, string | number> = {}, ...children: Node[]): SVGElement {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
    for (const child of children) node.append(child);
    return node;
}

export interface Slice {
    label: string;
    count: number;
    /** A class suffix: a tone (`ok`, `warn`...) or a device state (`allocated`, `shared`...). */
    tone: string;
}

/**
 * A donut: one arc per slice, the total in the middle, a legend beside it.
 * The whole legend row is a button when `onPick` is given.
 */
export function ring(title: string, slices: Slice[], options: { onPick?: (label: string) => void; unit?: string; note?: string } = {}): HTMLElement {
    const total = slices.reduce((n, s) => n + s.count, 0);
    const R = 54;
    const C = 2 * Math.PI * R;
    const drawing = svgEl('svg', { viewBox: '0 0 140 140', class: 'ring-svg', 'aria-hidden': 'true' });
    drawing.append(svgEl('circle', { cx: 70, cy: 70, r: R, class: 'ring-track', fill: 'none', 'stroke-width': 16 }));

    let offset = 0;
    for (const slice of slices) {
        if (slice.count <= 0) continue;
        const fraction = total > 0 ? slice.count / total : 0;
        drawing.append(
            svgEl('circle', {
                cx: 70,
                cy: 70,
                r: R,
                fill: 'none',
                'stroke-width': 16,
                class: `ring-arc arc-${slice.tone || 'none'}`,
                'stroke-dasharray': `${(fraction * C).toFixed(2)} ${C.toFixed(2)}`,
                'stroke-dashoffset': `${(-offset * C).toFixed(2)}`,
                transform: 'rotate(-90 70 70)',
            }),
        );
        offset += fraction;
    }

    const legend = el('ul', { class: 'legend' });
    for (const slice of slices) {
        const row = el(
            'li',
            { class: slice.count === 0 ? 'legend-row zero' : 'legend-row' },
            el('span', { class: `dot dot-${slice.tone || 'none'}` }),
            el('span', { class: 'legend-label' }, slice.label),
            el('span', { class: 'legend-count' }, String(slice.count)),
        );
        if (options.onPick && slice.count > 0) clickable(row, () => options.onPick?.(slice.label));
        legend.append(row);
    }

    return el(
        'section',
        { class: 'ring-card' },
        el('h2', {}, title),
        options.note ? el('p', { class: 'note' }, options.note) : null,
        el(
            'div',
            { class: 'ring-body' },
            el(
                'div',
                { class: 'ring-holder' },
                drawing,
                el('div', { class: 'ring-centre' }, el('span', { class: 'ring-total' }, String(total)), el('span', { class: 'ring-unit' }, options.unit ?? '')),
            ),
            legend,
        ),
    );
}

/**
 * A stacked bar: one segment per slice, as a share of `whole` (the slices'
 * sum when not given). The same state classes as the device squares, so a
 * bar and a grid read the same.
 */
export function stack(slices: Slice[], whole = slices.reduce((n, s) => n + s.count, 0), className = 'stack'): HTMLElement {
    const bar = el('div', { class: className, role: 'img', 'aria-label': slices.map((s) => `${s.count} ${s.label}`).join(', ') });
    for (const slice of slices) {
        if (slice.count <= 0) continue;
        const piece = el('span', { class: `stack-part fill-${slice.tone || 'none'}`, title: `${slice.count} ${slice.label}` });
        piece.style.width = `${percent(slice.count, whole)}%`;
        bar.append(piece);
    }
    return bar;
}

/** The legend a stack or a grid is read with: a swatch, a word, and a count when there is one. */
export function legend(slices: Slice[], options: { counts?: boolean } = {}): HTMLElement {
    const list = el('ul', { class: 'swatches' });
    for (const slice of slices) {
        list.append(
            el(
                'li',
                { class: slice.count === 0 && options.counts ? 'zero' : '' },
                el('span', { class: `swatch fill-${slice.tone || 'none'}`, 'aria-hidden': 'true' }),
                el('span', {}, slice.label),
                options.counts ? el('strong', {}, String(slice.count)) : null,
            ),
        );
    }
    return list;
}

/** A small coloured label: a state, a vendor, a source. */
export function pill(text: string, tone: Tone | string = '', title = ''): HTMLElement {
    return el('span', { class: `pill pill-${tone || 'none'}`, ...(title ? { title } : {}) }, text);
}

/**
 * A big friendly number: what the dashboard opens with. The value is the
 * thing read from across the room; the label says what it counts and the
 * note says what it means.
 */
export function tile(label: string, value: string, note: string | Node = '', tone: string = '', extra: Node | null = null): HTMLElement {
    return el(
        'div',
        { class: `tile tile-${tone || 'none'}` },
        el('div', { class: 'tile-label' }, label),
        el('div', { class: 'tile-value' }, value),
        note ? el('div', { class: 'tile-note' }, note) : null,
        extra,
    );
}

/** A section with a heading, an optional sentence, and whatever follows. */
export function block(title: string, note: string, ...children: (Node | null)[]): HTMLElement {
    return el('section', { class: 'block' }, el('h2', {}, title), note ? el('p', { class: 'note' }, note) : null, ...children.filter((c): c is Node => c !== null));
}

/** A row of facts: a term and a value each, in two columns. */
export function facts(pairs: [string, Node | string][]): HTMLElement {
    const list = el('dl', { class: 'facts' });
    for (const [term, value] of pairs) {
        list.append(el('dt', {}, term), el('dd', {}, typeof value === 'string' ? value || '—' : value));
    }
    return list;
}

/** An empty state that says what would have been here. */
export function nothing(message: string): HTMLElement {
    return el('p', { class: 'empty' }, message);
}

/** A page's own heading, with the plugin's mark beside it. */
export function heading(title: string, note: string): HTMLElement {
    return el(
        'header',
        { class: 'page-head' },
        el('img', { class: 'mark', src: 'logo.svg', alt: '', width: 28, height: 28 }),
        el('div', {}, el('h1', {}, title), note ? el('p', { class: 'note' }, note) : null),
    );
}

/** Replaces a host's contents with a single "still reading" line. */
export function loading(host: HTMLElement, message: string): void {
    replace(host, el('p', { class: 'loading' }, message));
}

/**
 * Makes a row behave like a button: clickable, focusable, and answering the
 * keys a button answers. A <div> that opens something and cannot be reached
 * with a keyboard is a page half the people cannot use.
 */
export function clickable(node: HTMLElement, onPick: () => void): HTMLElement {
    node.classList.add('pick');
    node.setAttribute('role', 'button');
    node.setAttribute('tabindex', '0');
    node.addEventListener('click', onPick);
    node.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onPick();
        }
    });
    return node;
}

/** A button that opens an object in the app, drawn as the name of the thing. */
export function openName(label: string, ref: K8sDockside.OpenRef, className = 'link-name'): HTMLElement {
    const node = el('button', { type: 'button', class: className, title: `Open ${label}` }, label);
    node.addEventListener('click', (event) => {
        event.stopPropagation();
        void k8sdockside.open(ref);
    });
    return node;
}

export { el, replace };
