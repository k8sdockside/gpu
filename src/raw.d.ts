// Vite's `?raw` import, typed.
//
// It is what the logo test reads the mark with. Reading it with node:fs would
// need @types/node, and that would put `process`, `Buffer` and the rest into
// the page code's global scope -- where none of them exist, because a page
// runs in a sandboxed browser frame. Keeping `types: []` in tsconfig.json is
// what makes a reference to one of those a compile error rather than a
// runtime one, so the file is read the bundler's way instead.
//
// It lives in src/ rather than src/assets/, which the build copies whole into
// ui/.

declare module '*.svg?raw' {
    const content: string;
    export default content;
}
