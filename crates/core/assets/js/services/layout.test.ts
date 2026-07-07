import { describe, it, expect, beforeEach } from 'vitest';
import { LayoutEngine, type NoteCardInput } from './layout.js';

function rect(top: number, height = 10): DOMRect {
    return {
        left: 0,
        top,
        right: 0,
        bottom: top + height,
        width: 0,
        height,
        x: 0,
        y: top,
        toJSON: () => ({}),
    };
}

function makeCard(top: number, height: number, id: string): NoteCardInput {
    const highlightElement = document.createElement('span');
    document.body.appendChild(highlightElement);
    highlightElement.getBoundingClientRect = () => rect(top);

    const element = document.createElement('div');
    document.body.appendChild(element);
    Object.defineProperty(element, 'offsetHeight', { configurable: true, value: height });
    return { element, highlightElement, highlightId: id };
}

function itemAt<T>(items: ArrayLike<T>, index: number): T {
    const item = items[index];
    expect(item).toBeDefined();
    if (item === undefined) throw new Error(`Missing item at index ${index}`);
    return item;
}

beforeEach(() => {
    document.body.innerHTML = '';
    Object.defineProperty(window, 'scrollX', { configurable: true, value: 0 });
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 800 });
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
        expect(itemAt(out, 0).currentTop).toBe(100);
        expect(itemAt(out, 1).currentTop).toBe(500);
        expect(itemAt(out, 0).id).toBe('a');
        expect(itemAt(out, 1).id).toBe('b');
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
        // minIdealTop is 100; spacing is height(40) + NOTE_MIN_SPACING(32) = 72
        expect(itemAt(out, 0).currentTop).toBe(100);
        expect(itemAt(out, 1).currentTop).toBe(172);
        expect(itemAt(out, 2).currentTop).toBe(244);
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
        expect(itemAt(out, 0).currentTop).toBe(100);
        // min allowed = prev.currentTop(100) + prev.height(200) + 32 = 332
        expect(itemAt(out, 1).currentTop).toBe(332);
    });

    it('falls back to height 80 when offsetHeight is 0', () => {
        const engine = new LayoutEngine();
        const cards = [makeCard(100, 0, 'a')];
        const out = engine.calculate(cards);
        expect(itemAt(out, 0).height).toBe(80);
    });

    it('marks cards outside the viewport as not visible without letting them affect visible layout', () => {
        const engine = new LayoutEngine();
        const cards = [
            makeCard(100, 40, 'visible-a'),
            makeCard(1200, 400, 'offscreen'),
            makeCard(130, 40, 'visible-b'),
        ];
        const out = engine.calculate(cards);

        expect(itemAt(out, 0).visible).toBe(true);
        expect(itemAt(out, 1).visible).toBe(false);
        expect(itemAt(out, 2).visible).toBe(true);
        expect(itemAt(out, 0).currentTop).toBe(100);
        expect(itemAt(out, 2).currentTop).toBe(172);
    });

    it('anchors a hidden source to its visible collapsed section heading', () => {
        const engine = new LayoutEngine();
        document.body.innerHTML = `
            <article class="markdown-body">
                <h2 class="section-collapsed" id="section">Hidden section</h2>
                <div class="section-content-hidden">
                    <p><span id="source">source</span></p>
                </div>
            </article>
        `;
        const source = document.querySelector<HTMLElement>('#source')!;
        const section = document.querySelector<HTMLElement>('#section')!;
        source.getBoundingClientRect = () => rect(1200);
        section.getBoundingClientRect = () => rect(240, 30);
        const element = document.createElement('div');
        Object.defineProperty(element, 'offsetHeight', { configurable: true, value: 40 });

        const out = engine.calculate([{ element, highlightElement: source, highlightId: 'hidden' }]);

        expect(itemAt(out, 0).anchorElement).toBe(section);
        expect(itemAt(out, 0).idealTop).toBe(240);
        expect(itemAt(out, 0).visible).toBe(true);
    });

    it('uses the first still-visible collapsed ancestor when nested collapsed content is hidden', () => {
        const engine = new LayoutEngine();
        document.body.innerHTML = `
            <article class="markdown-body">
                <h2 class="section-collapsed" id="outer">Outer</h2>
                <div class="section-content-hidden">
                    <h3 class="section-collapsed" id="inner">Inner</h3>
                    <p><span id="source">source</span></p>
                </div>
            </article>
        `;
        const source = document.querySelector<HTMLElement>('#source')!;
        const outer = document.querySelector<HTMLElement>('#outer')!;
        const inner = document.querySelector<HTMLElement>('#inner')!;
        source.getBoundingClientRect = () => rect(1200);
        outer.getBoundingClientRect = () => rect(300, 30);
        inner.getBoundingClientRect = () => rect(400, 30);
        const element = document.createElement('div');
        Object.defineProperty(element, 'offsetHeight', { configurable: true, value: 40 });

        const out = engine.calculate([{ element, highlightElement: source, highlightId: 'nested' }]);

        expect(itemAt(out, 0).anchorElement).toBe(outer);
        expect(itemAt(out, 0).idealTop).toBe(300);
        expect(itemAt(out, 0).visible).toBe(true);
    });
});
