import { afterEach, describe, expect, it } from 'vitest';
import {
    ANNOTATION_CHROME_REJECT,
    annotationBlockFor,
    combineRejects,
    rangeIntersectsRejected,
} from './annotation-target';

function mount(html: string): HTMLElement {
    const root = document.createElement('article');
    root.className = 'markdown-body';
    root.innerHTML = html;
    document.body.appendChild(root);
    return root;
}

afterEach(() => {
    document.body.innerHTML = '';
});

describe('annotation target policy', () => {
    it('recognizes injected chrome without rejecting adjacent document text', () => {
        const root = mount(
            '<h2>Heading<span class="section-actions">Print</span></h2>' +
            '<div class="section-collapsed-placeholder">Section collapsed</div><p>Body</p>',
        );
        const headingText = root.querySelector('h2')!.firstChild!;
        const chromeText = root.querySelector('.section-actions')!.firstChild!;
        const collapsedText = root.querySelector('.section-collapsed-placeholder')!.firstChild!;
        expect(ANNOTATION_CHROME_REJECT(headingText)).toBe(false);
        expect(ANNOTATION_CHROME_REJECT(chromeText)).toBe(true);
        expect(ANNOTATION_CHROME_REJECT(collapsedText)).toBe(true);
    });

    it('composes normal chrome and surface-specific rejection', () => {
        const root = mount(
            '<p>Current</p><p class="old-side">Deleted</p>' +
            '<span class="viewed-toolbar">Toolbar</span>',
        );
        const reject = combineRejects(
            ANNOTATION_CHROME_REJECT,
            (node) => !!node.parentElement?.closest('.old-side'),
        );
        expect(reject(root.querySelector('p')!.firstChild!)).toBe(false);
        expect(reject(root.querySelector('.old-side')!.firstChild!)).toBe(true);
        expect(reject(root.querySelector('.viewed-toolbar')!.firstChild!)).toBe(true);
    });

    it('detects rejected content anywhere inside a range', () => {
        const root = mount('<p>New</p><p class="old-side">Old</p><p>Newer</p>');
        const paragraphs = root.querySelectorAll('p');
        const range = document.createRange();
        range.setStart(paragraphs[0]!.firstChild!, 0);
        range.setEnd(paragraphs[2]!.firstChild!, 5);
        expect(
            rangeIntersectsRejected(
                range,
                (node) => !!node.parentElement?.closest('.old-side'),
            ),
        ).toBe(true);
    });

    it('resolves the nearest structural block', () => {
        const root = mount('<ul><li><strong>Item</strong></li></ul>');
        const text = root.querySelector('strong')!.firstChild!;
        expect(annotationBlockFor(text, root)?.tagName).toBe('LI');
    });
});
