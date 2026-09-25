// @vitest-environment happy-dom
//
// The mark `heading()` draws has to be well-formed XML.
//
// It is drawn through <img src="logo.svg">, both by the pages' own headings
// and by the app's plugin list, and an <img> parses SVG as XML rather than as
// HTML. XML is stricter than anyone writing a comment expects -- a double
// hyphen inside one ends it -- and the only symptom is a broken-image icon in
// every heading, with nothing in any log to say why. So it is parsed here,
// the same way the browser will.

import { describe, expect, it } from 'vitest';
import svg from '../assets/logo.svg?raw';

describe('the plugin mark', () => {
    it('parses as XML, the way an <img> will', () => {
        const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
        expect(parsed.querySelector('parsererror')).toBe(null);
        expect(parsed.documentElement.tagName).toBe('svg');
    });

    it('has a viewBox, without which it will not scale', () => {
        const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
        expect(parsed.documentElement.getAttribute('viewBox')).toBeTruthy();
    });
});
