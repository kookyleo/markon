import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    ReadingProgressTracker,
    anchorScrollTop,
    captureAnchor,
    readingProgressKey,
} from './reading-progress';

/**
 * jsdom has no layout engine: every `getBoundingClientRect()` is a zero rect
 * and nothing is ever "visible". These helpers stand in for layout by pinning
 * an explicit absolute top on each heading and driving `window.scrollY` by
 * hand, which is exactly the state the anchor math consumes.
 */
function buildDoc(headingTops: Record<string, number>): HTMLElement {
    const body = document.createElement('article');
    body.className = 'markdown-body';
    for (const id of Object.keys(headingTops)) {
        const h = document.createElement('h2');
        h.id = id;
        h.textContent = id;
        body.appendChild(h);
        const p = document.createElement('p');
        p.textContent = `body of ${id}`;
        body.appendChild(p);
    }
    document.body.appendChild(body);

    for (const [id, top] of Object.entries(headingTops)) {
        stubLayout(document.getElementById(id)!, top);
    }
    return body;
}

/** Make one element report a fixed document-space top, and count as visible. */
function stubLayout(el: HTMLElement, absoluteTop: number, visible = true): void {
    el.getClientRects = (() => (visible ? [{}] : [])) as unknown as typeof el.getClientRects;
    el.getBoundingClientRect = () => ({
        top: absoluteTop - window.scrollY,
        bottom: absoluteTop - window.scrollY + 20,
        left: 0,
        right: 0,
        width: 0,
        height: 20,
        x: 0,
        y: absoluteTop - window.scrollY,
        toJSON: () => ({}),
    });
}

function scrollTo(y: number): void {
    Object.defineProperty(window, 'scrollY', { value: y, configurable: true, writable: true });
}

describe('reading progress anchors', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        localStorage.clear();
        scrollTo(0);
    });

    it('anchors to the last heading above the viewport top', () => {
        const body = buildDoc({ 'h-a': 100, 'h-b': 500, 'h-c': 900 });

        scrollTo(620);
        expect(captureAnchor(body)).toEqual({ id: 'h-b', offset: 120 });
    });

    it('falls back to a raw offset above the first heading', () => {
        const body = buildDoc({ 'h-a': 300 });

        scrollTo(80);
        expect(captureAnchor(body)).toEqual({ id: null, offset: 80 });
    });

    it('skips headings hidden inside a collapsed section', () => {
        const body = buildDoc({ 'h-a': 100, 'h-b': 500 });
        stubLayout(document.getElementById('h-b')!, 500, false);

        scrollTo(600);
        expect(captureAnchor(body)).toEqual({ id: 'h-a', offset: 500 });
    });

    it('resolves an anchor against the current layout, not the stored pixels', () => {
        buildDoc({ 'h-a': 100 });

        // The heading moved down (an image above it finished loading), so the
        // same anchor must resolve to a larger scroll position.
        stubLayout(document.getElementById('h-a')!, 400);
        expect(anchorScrollTop({ id: 'h-a', offset: 120 })).toBe(520);
    });

    it('reports an unresolvable anchor when the heading is gone', () => {
        buildDoc({ 'h-a': 100 });
        expect(anchorScrollTop({ id: 'h-missing', offset: 10 })).toBeNull();
    });
});

describe('ReadingProgressTracker', () => {
    let scrollToSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        document.body.innerHTML = '';
        localStorage.clear();
        scrollTo(0);
        window.location.hash = '';
        scrollToSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('stores the anchor under a per-document key', () => {
        const body = buildDoc({ 'h-a': 100, 'h-b': 500 });
        const tracker = new ReadingProgressTracker(body, 'docs/x.md');

        scrollTo(560);
        tracker.save();

        expect(JSON.parse(localStorage.getItem(readingProgressKey('docs/x.md'))!))
            .toEqual({ id: 'h-b', offset: 60 });
    });

    it('clears the stored anchor once the reader returns to the top', () => {
        const body = buildDoc({ 'h-a': 100 });
        const tracker = new ReadingProgressTracker(body, 'docs/x.md');

        scrollTo(300);
        tracker.save();
        expect(localStorage.getItem(readingProgressKey('docs/x.md'))).not.toBeNull();

        scrollTo(0);
        tracker.save();
        expect(localStorage.getItem(readingProgressKey('docs/x.md'))).toBeNull();
    });

    it('scrolls back to the stored anchor on start', () => {
        const body = buildDoc({ 'h-a': 100, 'h-b': 500 });
        localStorage.setItem(readingProgressKey('docs/x.md'), JSON.stringify({ id: 'h-b', offset: 60 }));

        new ReadingProgressTracker(body, 'docs/x.md').start();

        expect(scrollToSpy).toHaveBeenCalledWith({ top: 560, behavior: 'auto' });
    });

    it('lets a #hash deep link win over stored progress', () => {
        const body = buildDoc({ 'h-a': 100, 'h-b': 500 });
        localStorage.setItem(readingProgressKey('docs/x.md'), JSON.stringify({ id: 'h-b', offset: 60 }));
        window.location.hash = '#h-a';

        new ReadingProgressTracker(body, 'docs/x.md').start();

        expect(scrollToSpy).not.toHaveBeenCalled();
    });

    it('ignores a stored anchor whose heading no longer exists', () => {
        const body = buildDoc({ 'h-a': 100 });
        localStorage.setItem(readingProgressKey('docs/x.md'), JSON.stringify({ id: 'h-gone', offset: 60 }));

        new ReadingProgressTracker(body, 'docs/x.md').start();

        expect(scrollToSpy).not.toHaveBeenCalled();
    });

    it('ignores a corrupt stored anchor', () => {
        const body = buildDoc({ 'h-a': 100 });
        localStorage.setItem(readingProgressKey('docs/x.md'), '{not json');

        expect(new ReadingProgressTracker(body, 'docs/x.md').read()).toBeNull();
    });

    it('debounces scroll writes and flushes on pagehide', () => {
        vi.useFakeTimers();
        const body = buildDoc({ 'h-a': 100 });
        const tracker = new ReadingProgressTracker(body, 'docs/x.md');
        tracker.start();

        scrollTo(300);
        window.dispatchEvent(new Event('scroll'));
        expect(localStorage.getItem(readingProgressKey('docs/x.md'))).toBeNull();

        vi.advanceTimersByTime(400);
        expect(JSON.parse(localStorage.getItem(readingProgressKey('docs/x.md'))!))
            .toEqual({ id: 'h-a', offset: 200 });

        scrollTo(700);
        window.dispatchEvent(new Event('scroll'));
        window.dispatchEvent(new Event('pagehide'));
        expect(JSON.parse(localStorage.getItem(readingProgressKey('docs/x.md'))!))
            .toEqual({ id: 'h-a', offset: 600 });

        tracker.stop();
    });
});
