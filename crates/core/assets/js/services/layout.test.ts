import { describe, it, expect, beforeEach } from 'vitest';
import { LayoutEngine, type NoteCardInput } from './layout.js';

function makeCard(top: number, height: number, id: string): NoteCardInput {
    const highlightElement = document.createElement('span');
    document.body.appendChild(highlightElement);
    highlightElement.getBoundingClientRect = () =>
        ({ left: 0, top, right: 0, bottom: top + 10, width: 0, height: 10, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

    const element = document.createElement('div');
    document.body.appendChild(element);
    Object.defineProperty(element, 'offsetHeight', { configurable: true, value: height });
    return { element, highlightElement, highlightId: id };
}

beforeEach(() => {
    document.body.innerHTML = '';
    Object.defineProperty(window, 'scrollX', { configurable: true, value: 0 });
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
});

describe('LayoutEngine.calculate', () => {
    it('returns an empty array for empty input', () => {
        const engine = new LayoutEngine();
        expect(engine.calculate([])).toEqual([]);
    });

    it('keeps far-apart notes at their ideal position', () => {
        const engine = new LayoutEngine();
        const cards = [makeCard(100, 50, 'a'), makeCard(500, 50, 'b')];
        const out = engine.calculate(cards);
        expect(out).toHaveLength(2);
        expect(out[0].currentTop).toBe(100);
        expect(out[1].currentTop).toBe(500);
        expect(out[0].id).toBe('a');
        expect(out[1].id).toBe('b');
    });

    it('clusters near-by notes via union-find and stacks them with min spacing', () => {
        const engine = new LayoutEngine();
        // NOTE_CLUSTER threshold is 50; 100 -> 130 -> 160 are within reach via chain
        const cards = [
            makeCard(100, 40, 'a'),
            makeCard(130, 40, 'b'),
            makeCard(160, 40, 'c'),
        ];
        const out = engine.calculate(cards);
        // minIdealTop is 100; spacing is height(40) + NOTE_MIN_SPACING(10) = 50
        expect(out[0].currentTop).toBe(100);
        expect(out[1].currentTop).toBe(150);
        expect(out[2].currentTop).toBe(200);
    });

    it('enforces vertical spacing between non-clustered but overlapping notes', () => {
        const engine = new LayoutEngine();
        // 100 and 200 are NOT within NOTE_CLUSTER(50), so they aren't unioned.
        // But the first card is huge: height 200, so #enforceSpacing kicks in.
        const cards = [
            makeCard(100, 200, 'a'),
            makeCard(200, 50, 'b'),
        ];
        const out = engine.calculate(cards);
        expect(out[0].currentTop).toBe(100);
        // min allowed = prev.currentTop(100) + prev.height(200) + 10 = 310
        expect(out[1].currentTop).toBe(310);
    });

    it('falls back to height 80 when offsetHeight is 0', () => {
        const engine = new LayoutEngine();
        const cards = [makeCard(100, 0, 'a')];
        const out = engine.calculate(cards);
        expect(out[0].height).toBe(80);
    });
});
