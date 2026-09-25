import { describe, expect, it } from 'vitest';
import { count, memory, percent, quantity, size, where } from './units.js';

describe('quantity', () => {
    it('reads the binary and decimal suffixes, not just the number', () => {
        expect(quantity('80Gi')).toBe(80 * 1024 ** 3);
        expect(quantity('81559Mi')).toBe(81559 * 1024 ** 2);
        expect(quantity('500M')).toBe(500e6);
        expect(quantity('8')).toBe(8);
        expect(quantity(4)).toBe(4);
    });

    it('reads the exponent form the API server sometimes writes', () => {
        expect(quantity('1e3')).toBe(1000);
    });

    it('is zero for nothing or nonsense rather than NaN', () => {
        expect(quantity(undefined)).toBe(0);
        expect(quantity('')).toBe(0);
        expect(quantity('lots')).toBe(0);
    });
});

describe('memory', () => {
    it('writes a card the way its product name does', () => {
        expect(memory(81559 * 1024 ** 2)).toBe('80 GiB');
        expect(memory(9728 * 1024 ** 2)).toBe('9.5 GiB');
        expect(memory(512 * 1024 ** 2)).toBe('512 MiB');
    });

    it('is empty when nothing reported one', () => {
        expect(memory(0)).toBe('');
        expect(memory(Number.NaN)).toBe('');
    });
});

describe('the small ones', () => {
    it('size, percent, count and where', () => {
        expect(size(1.5 * 1024 ** 3)).toBe('1.50 Gi');
        expect(percent(3, 0)).toBe(0);
        expect(percent(50, 10)).toBe(100);
        expect(count(1, 'GPU')).toBe('1 GPU');
        expect(count(3, 'GPU')).toBe('3 GPUs');
        expect(where('ns', 'p')).toBe('ns/p');
        expect(where('', 'n')).toBe('n');
    });
});
