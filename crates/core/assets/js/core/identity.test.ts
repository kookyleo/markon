import { describe, it, expect, beforeEach } from 'vitest';
import { Identity } from './identity';
import { CONFIG } from './config';

describe('Identity', () => {
    beforeEach(() => localStorage.clear());

    it('auto-assigns and persists a palette colour on first read', () => {
        const c = Identity.color();
        expect(CONFIG.COLLABORATION.COLORS).toContain(c);
        expect(Identity.color()).toBe(c); // stable across reads
        expect(localStorage.getItem(CONFIG.STORAGE_KEYS.LIVE_COLOR)).toBe(c);
    });

    it('reuses an existing saved colour (shared with Live presence)', () => {
        localStorage.setItem(CONFIG.STORAGE_KEYS.LIVE_COLOR, '#123456');
        expect(Identity.color()).toBe('#123456');
    });

    it('round-trips and clears the nickname (trimmed)', () => {
        expect(Identity.name()).toBe('');
        Identity.setName('  leo  ');
        expect(Identity.name()).toBe('leo');
        Identity.setName('   ');
        expect(Identity.name()).toBe('');
    });

    it('author() carries colour, and name only when set', () => {
        Identity.setColor('#abcdef');
        expect(Identity.author()).toEqual({ color: '#abcdef' });
        Identity.setName('leo');
        expect(Identity.author()).toEqual({ color: '#abcdef', name: 'leo' });
    });
});
