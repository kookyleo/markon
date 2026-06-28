import { describe, expect, it } from 'vitest';
import { lineDiff, wordDiff, visibleBlockItems } from './diff-segments';

describe('lineDiff (line-level LCS)', () => {
    it('keeps unchanged lines aligned around a single changed line', () => {
        const ops = lineDiff(['a', 'b', 'c'], ['a', 'B', 'c']);
        expect(ops).toEqual([
            { type: 'equal', oldIndex: 0, newIndex: 0 },
            { type: 'replace', oldIndex: 1, newIndex: 1 },
            { type: 'equal', oldIndex: 2, newIndex: 2 },
        ]);
    });

    it('treats a mid-block insertion as a single add (no downstream mispairing)', () => {
        // The naive index-pairing bug: inserting 'x' would mark b/c/d as changed.
        const ops = lineDiff(['a', 'b', 'c'], ['a', 'x', 'b', 'c']);
        expect(ops).toEqual([
            { type: 'equal', oldIndex: 0, newIndex: 0 },
            { type: 'add', newIndex: 1 },
            { type: 'equal', oldIndex: 1, newIndex: 2 },
            { type: 'equal', oldIndex: 2, newIndex: 3 },
        ]);
    });

    it('pairs a removed+added run as replaces, surplus as pure del', () => {
        const ops = lineDiff(['a', 'b', 'c', 'd'], ['a', 'X', 'Y']);
        // b→X, c→Y replaced; d removed (surplus del, no matching add).
        expect(ops).toEqual([
            { type: 'equal', oldIndex: 0, newIndex: 0 },
            { type: 'replace', oldIndex: 1, newIndex: 1 },
            { type: 'replace', oldIndex: 2, newIndex: 2 },
            { type: 'del', oldIndex: 3 },
        ]);
    });

    it('handles pure add / pure delete blocks', () => {
        expect(lineDiff([], ['a', 'b'])).toEqual([
            { type: 'add', newIndex: 0 },
            { type: 'add', newIndex: 1 },
        ]);
        expect(lineDiff(['a', 'b'], [])).toEqual([
            { type: 'del', oldIndex: 0 },
            { type: 'del', oldIndex: 1 },
        ]);
    });
});

describe('wordDiff (intra-line)', () => {
    it('marks only the changed tokens, keeping shared ones unmarked', () => {
        const { old, new: nw } = wordDiff('the quick fox', 'the slow fox');
        expect(old.filter((s) => s.cls === 'del').map((s) => s.text.trim())).toEqual(['quick']);
        expect(nw.filter((s) => s.cls === 'add').map((s) => s.text.trim())).toEqual(['slow']);
        // Shared head/tail survive on both sides unmarked.
        expect(old.map((s) => s.text).join('')).toBe('the quick fox');
        expect(nw.map((s) => s.text).join('')).toBe('the slow fox');
    });
});

describe('visibleBlockItems', () => {
    it('collapses unchanged runs beyond the context window into a gap', () => {
        const blocks = Array.from({ length: 12 }, (_, i) => ({
            kind: (i === 11 ? 'modified' : 'equal') as 'equal' | 'modified',
        }));
        const items = visibleBlockItems(blocks);
        const gap = items.find((it) => it.kind === 'gap');
        expect(gap).toBeTruthy();
        // Last block + 3 context shown; the leading run collapses.
        expect(items[items.length - 1]).toMatchObject({ kind: 'block', index: 11 });
    });
});
