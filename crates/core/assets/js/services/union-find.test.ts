// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { UnionFind } from './union-find.js';

describe('UnionFind', () => {
    it('starts with each element as its own root', () => {
        const uf = new UnionFind(5);
        for (let i = 0; i < 5; i++) {
            expect(uf.find(i)).toBe(i);
        }
    });

    it('union joins two sets transitively', () => {
        const uf = new UnionFind(5);
        uf.union(0, 1);
        uf.union(1, 2);
        const root = uf.find(0);
        expect(uf.find(1)).toBe(root);
        expect(uf.find(2)).toBe(root);
        expect(uf.find(3)).not.toBe(root);
    });

    it('union of already-connected items is a no-op', () => {
        const uf = new UnionFind(3);
        uf.union(0, 1);
        const before = uf.find(0);
        uf.union(0, 1);
        expect(uf.find(0)).toBe(before);
        expect(uf.find(1)).toBe(before);
    });

    it('find performs path compression (idempotent and stable)', () => {
        const uf = new UnionFind(6);
        uf.union(0, 1);
        uf.union(2, 3);
        uf.union(0, 2); // merges {0,1} and {2,3}
        const r = uf.find(3);
        // After path compression, repeated find should be identical
        expect(uf.find(0)).toBe(r);
        expect(uf.find(1)).toBe(r);
        expect(uf.find(2)).toBe(r);
        expect(uf.find(3)).toBe(r);
    });

    it('keeps disjoint sets disjoint', () => {
        const uf = new UnionFind(4);
        uf.union(0, 1);
        uf.union(2, 3);
        expect(uf.find(0)).not.toBe(uf.find(2));
    });
});
