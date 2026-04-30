import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnnotationNavigator } from './annotation-navigator';

function makeBody(): HTMLElement {
    const body = document.createElement('div');
    body.className = 'markdown-body';
    document.body.appendChild(body);
    return body;
}

function addHighlight(body: HTMLElement, label: string, top: number): HTMLElement {
    const el = document.createElement('span');
    el.className = 'highlight-yellow';
    el.textContent = label;
    el.dataset.testLabel = label;
    body.appendChild(el);
    // jsdom returns 0-rects; stub getBoundingClientRect for ordering tests.
    el.getBoundingClientRect = () => ({
        top, bottom: top + 20, left: 0, right: 50, width: 50, height: 20, x: 0, y: top, toJSON: () => ({}),
    });
    return el;
}

function addNote(body: HTMLElement, label: string, top: number, id: string): HTMLElement {
    const el = document.createElement('span');
    el.className = 'has-note';
    el.dataset.annotationId = id;
    el.dataset.testLabel = label;
    el.textContent = label;
    body.appendChild(el);
    el.getBoundingClientRect = () => ({
        top, bottom: top + 20, left: 0, right: 50, width: 50, height: 20, x: 0, y: top, toJSON: () => ({}),
    });
    return el;
}

describe('AnnotationNavigator', () => {
    let body: HTMLElement;
    let nav: AnnotationNavigator;

    beforeEach(() => {
        body = makeBody();
        // Wide screen so notes use the desktop branch (no popup, deterministic).
        Object.defineProperty(window, 'innerWidth', { value: 2000, configurable: true });
        Object.defineProperty(window, 'innerHeight', { value: 2000, configurable: true });
        Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
        // scrollIntoView isn't implemented in jsdom.
        Element.prototype.scrollIntoView = vi.fn();
        nav = new AnnotationNavigator();
    });

    afterEach(() => {
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    it('next() focuses annotations in document (top) order', () => {
        const a = addHighlight(body, 'A', 100);
        const b = addHighlight(body, 'B', 50);
        const c = addNote(body, 'C', 200, 'n-1');

        nav.next();
        // sorted by position: B(50) → A(100) → C(200)
        expect(b.classList.contains('annotation-focused')).toBe(true);
        nav.next();
        expect(a.classList.contains('annotation-focused')).toBe(true);
        // Only the freshly focused element should carry the class now.
        expect(b.classList.contains('annotation-focused')).toBe(false);
        nav.next();
        expect(c.classList.contains('annotation-focused')).toBe(true);
        // Wrap around
        nav.next();
        expect(b.classList.contains('annotation-focused')).toBe(true);
    });

    it('previous() goes backward and wraps to last', () => {
        const a = addHighlight(body, 'A', 100);
        const b = addHighlight(body, 'B', 200);

        // From currentIndex = -1, previous wraps to last (index = length-1).
        nav.previous();
        expect(b.classList.contains('annotation-focused')).toBe(true);
        nav.previous();
        expect(a.classList.contains('annotation-focused')).toBe(true);
    });

    it('returns gracefully when no annotations exist', () => {
        // Empty body: should not throw.
        expect(() => nav.next()).not.toThrow();
        expect(() => nav.previous()).not.toThrow();
    });

    it('note focus also highlights the matching note-card-margin', () => {
        const note = addNote(body, 'N', 100, 'aid-7');
        const card = document.createElement('div');
        card.className = 'note-card-margin';
        card.dataset.annotationId = 'aid-7';
        card.getBoundingClientRect = () => ({
            top: 100, bottom: 200, left: 0, right: 200, width: 200, height: 100, x: 0, y: 100, toJSON: () => ({}),
        });
        document.body.appendChild(card);

        nav.next();
        expect(note.classList.contains('annotation-focused')).toBe(true);
        expect(card.classList.contains('highlight-active')).toBe(true);
    });
});
