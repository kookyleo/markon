import { describe, it, expect } from 'vitest';
import { UnionFind } from '../../assets/js/services/union-find.js';

describe('UnionFind', () => {
  it('find returns own index for fresh elements', () => {
    const uf = new UnionFind(5);
    for (let i = 0; i < 5; i++) {
      expect(uf.find(i)).toBe(i);
    }
  });

  it('union merges two components', () => {
    const uf = new UnionFind(5);
    uf.union(0, 1);
    expect(uf.find(0)).toBe(uf.find(1));
  });

  it('transitive union', () => {
    const uf = new UnionFind(5);
    uf.union(0, 1);
    uf.union(1, 2);
    expect(uf.find(0)).toBe(uf.find(2));
  });

  it('separate components remain separate', () => {
    const uf = new UnionFind(4);
    uf.union(0, 1);
    uf.union(2, 3);
    expect(uf.find(0)).not.toBe(uf.find(2));
  });

  it('double union is idempotent', () => {
    const uf = new UnionFind(3);
    uf.union(0, 1);
    uf.union(0, 1);
    uf.union(1, 0);
    expect(uf.find(0)).toBe(uf.find(1));
  });

  it('path compression after chain', () => {
    const uf = new UnionFind(100);
    for (let i = 0; i < 99; i++) {
      uf.union(i, i + 1);
    }
    const root = uf.find(0);
    // After path compression, all elements should resolve in O(1)
    for (let i = 0; i < 100; i++) {
      expect(uf.find(i)).toBe(root);
    }
  });
});
