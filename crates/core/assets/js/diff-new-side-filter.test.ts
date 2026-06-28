import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TextAnchoring } from './services/text-anchor';
import { NEW_SIDE_REJECT, newSideRootFor, sectionForNode } from './diff-new-side-filter';
import {
    AnnotationManager,
    type Annotation,
    type AnnotationStorage,
} from './managers/annotation-manager';

function mount(html: string): HTMLElement {
    const d = document.createElement('div');
    d.innerHTML = html;
    document.body.appendChild(d);
    return d;
}

/** First text node whose data contains `needle`, anywhere under `root`. */
function textNode(root: Node, needle: string): Text {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n: Node | null = w.nextNode();
    while (n) {
        if ((n as Text).data.includes(needle)) return n as Text;
        n = w.nextNode();
    }
    throw new Error(`no text node containing ${JSON.stringify(needle)}`);
}

/** First non-empty text node under `root`. */
function firstText(root: Node): Text {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const n = w.nextNode();
    if (!n) throw new Error('no text node');
    return n as Text;
}

function rangeOver(root: Node, startNeedle: string, endNeedle: string): Range {
    const sNode = textNode(root, startNeedle);
    const eNode = textNode(root, endNeedle);
    const r = document.createRange();
    r.setStart(sNode, sNode.data.indexOf(startNeedle));
    r.setEnd(eNode, eNode.data.indexOf(endNeedle) + endNeedle.length);
    return r;
}

function makeStorage(): AnnotationStorage {
    return {
        loadAnnotations: vi.fn(async () => []),
        saveAnnotation: vi.fn(async () => null),
        deleteAnnotation: vi.fn(async () => null),
        clearAnnotations: vi.fn(async () => null),
    };
}

beforeEach(() => {
    document.body.innerHTML = '';
});
afterEach(() => {
    document.body.innerHTML = '';
});

describe('NEW_SIDE_REJECT truth table', () => {
    const cases: Array<[string, boolean]> = [
        ['<section class="md-diff-change-card-old"><p>x</p></section>', true],
        ['<section class="md-diff-change-card md-diff-change-card-new"><p>x</p></section>', false],
        ['<article class="md-diff-block is-deleted"><p>x</p></article>', true],
        ['<article class="md-diff-block is-added"><p>x</p></article>', false],
        ['<li class="md-diff-item-old">x</li>', true],
        ['<li class="md-diff-item-new">x</li>', false],
        ['<span class="git-diff-word-del">x</span>', true],
        ['<span class="git-diff-word-add">x</span>', false],
        ['<div class="md-diff-gap">x</div>', true],
        ['<span class="md-diff-gap-label">x</span>', true],
        ['<div class="md-diff-file-header">x</div>', true],
        ['<div class="md-diff-diagnostics">x</div>', true],
        ['<p>plain new content</p>', false],
    ];

    for (const [html, expected] of cases) {
        it(`${expected ? 'rejects' : 'keeps'}: ${html}`, () => {
            const root = mount(html);
            expect(NEW_SIDE_REJECT(firstText(root))).toBe(expected);
        });
    }

    it('rejects an element node directly (not just text)', () => {
        const root = mount('<section class="md-diff-change-card-old"><b>x</b></section>');
        const bold = root.querySelector('b')!;
        expect(NEW_SIDE_REJECT(bold)).toBe(true);
    });
});

describe('newSideRootFor / sectionForNode', () => {
    it('newSideRootFor returns the file body', () => {
        const root = mount(
            '<section class="md-diff-file-section" data-abs-path="/a.md">' +
                '<div class="md-diff-file-header">h</div>' +
                '<div class="md-diff-file-body"><p>body</p></div>' +
                '</section>',
        );
        const section = root.querySelector<HTMLElement>('.md-diff-file-section')!;
        expect(newSideRootFor(section)).toBe(root.querySelector('.md-diff-file-body'));
    });

    it('sectionForNode finds the keyed section, else null', () => {
        const root = mount(
            '<section class="md-diff-file-section" data-abs-path="/a.md">' +
                '<div class="md-diff-file-body"><p>inside</p></div>' +
                '</section>' +
                '<section class="md-diff-file-section"><p>unkeyed</p></section>',
        );
        const inside = textNode(root, 'inside');
        const unkeyed = textNode(root, 'unkeyed');
        expect(sectionForNode(inside)?.dataset.absPath).toBe('/a.md');
        expect(sectionForNode(unkeyed)).toBeNull();
    });
});

describe('collect/describe/anchor with NEW_SIDE_REJECT', () => {
    it('skips rejected nodes: a quote only in the old side is not found', () => {
        const root = mount(
            '<div class="md-diff-file-body">' +
                '<section class="md-diff-change-card-new"><p>kept new text</p></section>' +
                '<section class="md-diff-change-card-old"><p>dropped old text</p></section>' +
                '</div>',
        );
        // Anchor a quote that exists ONLY in the old side.
        const a = TextAnchoring.describe(root, rangeOver(root, 'dropped', 'old text'));
        // Captured from full stream → exact is the old text…
        expect(a.exact).toContain('dropped');
        // …but re-anchoring with the reject can't see the old side: orphaned.
        expect(TextAnchoring.anchor(root, a, NEW_SIDE_REJECT)).toBeNull();
        // The new side is still anchorable.
        const b = TextAnchoring.describe(root, rangeOver(root, 'kept', 'new text'), NEW_SIDE_REJECT);
        expect(TextAnchoring.anchor(root, b, NEW_SIDE_REJECT)?.toString()).toBe('kept new text');
    });

    it('duplicate quote in old + new → only the new occurrence is found', () => {
        const root = mount(
            '<div class="md-diff-file-body">' +
                '<section class="md-diff-change-card-old"><p>common phrase</p></section>' +
                '<section class="md-diff-change-card-new"><p>common phrase</p></section>' +
                '</div>',
        );
        const newNode = root.querySelector('.md-diff-change-card-new p')!.firstChild as Text;
        const newRange = document.createRange();
        newRange.setStart(newNode, 0);
        newRange.setEnd(newNode, 'common phrase'.length);
        const a = TextAnchoring.describe(root, newRange, NEW_SIDE_REJECT);
        const found = TextAnchoring.anchor(root, a, NEW_SIDE_REJECT);
        expect(found?.toString()).toBe('common phrase');
        // It is the NEW occurrence, not the old one.
        expect(found!.startContainer).toBe(newNode);
        expect((found!.startContainer.parentElement as Element).closest('.md-diff-change-card-new')).not.toBeNull();
    });

    it('word-add is included, word-del is excluded', () => {
        const root = mount(
            '<div class="md-diff-file-body">' +
                '<section class="md-diff-change-card-old">old <span class="git-diff-word-del">removedword</span> tail</section>' +
                '<section class="md-diff-change-card-new">new <span class="git-diff-word-add">addedword</span> tail</section>' +
                '</div>',
        );
        const add = TextAnchoring.describe(root, rangeOver(root, 'addedword', 'addedword'), NEW_SIDE_REJECT);
        expect(TextAnchoring.anchor(root, add, NEW_SIDE_REJECT)?.toString()).toBe('addedword');
        const del = TextAnchoring.describe(root, rangeOver(root, 'removedword', 'removedword'));
        expect(TextAnchoring.anchor(root, del, NEW_SIDE_REJECT)).toBeNull();
    });

    it('anchors across a partial new-side stream vs the full document, both directions', () => {
        const partial = mount('<p>Alpha beta gamma</p>'); // block-level new-side render
        const full = mount('<p>intro text Alpha beta gamma trailing outro</p>'); // whole doc

        // describe on the partial stream → re-anchor on the full document.
        const fromPartial = TextAnchoring.describe(
            partial,
            rangeOver(partial, 'beta', 'beta'),
        );
        expect(
            TextAnchoring.anchor(full, fromPartial, undefined, { ignorePosition: true })?.toString(),
        ).toBe('beta');

        // describe on the full document → re-anchor on the partial stream.
        const fromFull = TextAnchoring.describe(full, rangeOver(full, 'beta', 'beta'));
        expect(
            TextAnchoring.anchor(partial, fromFull, undefined, { ignorePosition: true })?.toString(),
        ).toBe('beta');
    });
});

describe('AnnotationManager scoped to the new side', () => {
    function findWrappers(root: HTMLElement, id: string): HTMLElement[] {
        return [...root.querySelectorAll<HTMLElement>(`[data-annotation-id="${id}"]`)];
    }

    it('#wrapRange wraps only new-side nodes when the range spans an interleaved old item', async () => {
        // New stream reads "Hello world"; an old/deleted node sits physically
        // between the two new text nodes the range spans.
        const root = mount(
            '<div class="md-diff-file-body">' +
                '<section class="md-diff-change-card-new">Hello </section>' +
                '<section class="md-diff-change-card-old">REMOVED</section>' +
                '<section class="md-diff-change-card-new">world</section>' +
                '</div>',
        );
        const mgr = new AnnotationManager(makeStorage(), root, NEW_SIDE_REJECT);

        const range = rangeOver(root, 'Hello', 'world');
        const anno = mgr.createAnnotation(range, 'highlight-yellow', 'span');
        expect(anno.text).toBe('Hello world');

        await mgr.add(anno);
        mgr.applyToDOM();

        const wrappers = findWrappers(root, anno.id);
        // One wrapper per new-side text node; the old node is never wrapped.
        expect(wrappers.length).toBe(2);
        for (const w of wrappers) {
            expect(w.closest('.md-diff-change-card-old')).toBeNull();
        }
        // The deleted text survives untouched (no wrapper, exact text intact).
        const oldCard = root.querySelector<HTMLElement>('.md-diff-change-card-old')!;
        expect(oldCard.querySelector('[data-annotation-id]')).toBeNull();
        expect(oldCard.textContent).toBe('REMOVED');
    });

    it('setRoot rebinds and re-wraps in the rebuilt tree', async () => {
        const html =
            '<div class="md-diff-file-body">' +
            '<section class="md-diff-change-card-new">Hello </section>' +
            '<section class="md-diff-change-card-old">REMOVED</section>' +
            '<section class="md-diff-change-card-new">world</section>' +
            '</div>';
        const first = mount(html);
        const mgr = new AnnotationManager(makeStorage(), first, NEW_SIDE_REJECT);
        const anno = mgr.createAnnotation(rangeOver(first, 'Hello', 'world'), 'highlight-yellow', 'span');
        await mgr.add(anno);

        // The view switch rebuilds the whole tree; the old root is now detached.
        document.body.innerHTML = '';
        const second = mount(html);
        mgr.setRoot(second);
        mgr.applyToDOM();

        // Nothing landed in the stale tree; new tree carries the highlight.
        expect(findWrappers(first, anno.id).length).toBe(0);
        const wrappers = findWrappers(second, anno.id);
        expect(wrappers.length).toBe(2);
        expect(wrappers.map((w) => w.textContent).join('')).toBe('Hello world');
    });

    it('default (no reject) AnnotationManager still wraps the whole range', async () => {
        const root = mount('<article class="markdown-body"><p>Alpha beta gamma</p></article>');
        const body = root.querySelector<HTMLElement>('.markdown-body')!;
        const mgr = new AnnotationManager(makeStorage(), body);
        const anno: Annotation = mgr.createAnnotation(
            rangeOver(body, 'beta', 'beta'),
            'highlight-orange',
            'span',
        );
        await mgr.add(anno);
        mgr.applyToDOM();
        expect(body.querySelector(`[data-annotation-id="${anno.id}"]`)?.textContent).toBe('beta');
    });
});
