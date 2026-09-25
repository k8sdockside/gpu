// Small DOM helpers.
//
// The rule these exist to enforce: cluster data goes on the page as text,
// never as HTML. Nothing here takes a string of markup, and there is no
// innerHTML anywhere in src/: the device grid and the rings are built element
// by element too. A page that builds its rows with `el` cannot have an
// injection bug through a device attribute, a pod's name or a scheduler
// message, which is where cluster data is genuinely hostile -- a driver
// writes whatever strings it likes into a ResourceSlice.

type Attrs = Record<string, string | number | boolean | undefined>;
type Child = Node | string | null | undefined | false;

/** An element, with attributes and children. Strings become text nodes. */
export function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attrs: Attrs = {},
    ...children: Child[]
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) {
        if (value === undefined || value === false) continue;
        if (name === 'class') node.className = String(value);
        else if (name === 'text') node.textContent = String(value);
        else node.setAttribute(name, String(value));
    }
    for (const child of children) {
        if (child === null || child === undefined || child === false) continue;
        node.append(child);
    }
    return node;
}

/** A <button> with a click handler. */
export function button(label: string, onClick: () => void, attrs: Attrs = {}): HTMLButtonElement {
    const node = el('button', { type: 'button', ...attrs }, label);
    node.addEventListener('click', onClick);
    return node;
}

/** Replaces everything in a node. */
export function replace(parent: Element, ...children: Child[]): void {
    parent.replaceChildren();
    for (const child of children) {
        if (child === null || child === undefined || child === false) continue;
        parent.append(child);
    }
}

/** The element with an id, or a thrown error -- a missing id is our bug, not the user's. */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
    const node = document.getElementById(id);
    if (!node) throw new Error(`the page has no #${id}`);
    return node as T;
}

/** A coloured dot for a tone. */
export function dot(tone: string): HTMLElement {
    return el('span', { class: `dot dot-${tone || 'none'}`, 'aria-hidden': 'true' });
}
