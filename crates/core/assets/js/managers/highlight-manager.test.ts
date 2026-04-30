import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HighlightManager } from './highlight-manager.js';

describe('HighlightManager', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        document.body.innerHTML = '';
        // Clear any ?highlight= param so the constructor doesn't auto-run.
        window.history.replaceState({}, '', '/');
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        logSpy.mockRestore();
        errorSpy.mockRestore();
    });

    function setupBody(html: string): HTMLElement {
        const root = document.createElement('div');
        root.className = 'markdown-body';
        root.innerHTML = html;
        document.body.appendChild(root);
        return root;
    }

    it('logs an error when .markdown-body is missing', () => {
        // body has no .markdown-body
        new HighlightManager();
        expect(errorSpy).toHaveBeenCalled();
        expect(errorSpy.mock.calls[0]?.[0]).toBe('[HighlightManager]');
    });

    it('wraps a single match in a <span class="search-highlight">', () => {
        const root = setupBody('<p>hello world</p>');
        const mgr = new HighlightManager();
        mgr.highlightAndScroll('world');

        const spans = root.querySelectorAll('span.search-highlight');
        expect(spans.length).toBe(1);
        expect(spans[0].textContent).toBe('world');
        expect(root.textContent).toBe('hello world');
    });

    it('preserves the original text content with multiple matches', () => {
        const root = setupBody('<p>foo bar foo baz</p>');
        const mgr = new HighlightManager();
        mgr.highlightAndScroll('foo');

        const spans = root.querySelectorAll('span.search-highlight');
        expect(spans.length).toBe(2);
        // Round-tripping through text nodes must not duplicate or drop content.
        expect(root.textContent).toBe('foo bar foo baz');
    });

    it('matches multiple words case-insensitively', () => {
        const root = setupBody('<p>Hello World, hello again</p>');
        const mgr = new HighlightManager();
        mgr.highlightAndScroll('hello world');

        const spans = root.querySelectorAll('span.search-highlight');
        // 2x "hello" + 1x "World"
        expect(spans.length).toBe(3);
        const texts = Array.from(spans).map(s => s.textContent);
        expect(texts).toEqual(expect.arrayContaining(['Hello', 'hello', 'World']));
    });

    it('marks the first match active and removes the active class after the timeout', () => {
        const root = setupBody('<p>find me here</p>');
        // jsdom does not implement scrollIntoView; stub it on the prototype.
        const scrollSpy = vi.fn();
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
            value: scrollSpy,
            configurable: true,
            writable: true,
        });

        const mgr = new HighlightManager();
        mgr.highlightAndScroll('me');

        const span = root.querySelector('span.search-highlight') as HTMLElement;
        expect(span).not.toBeNull();
        expect(span.classList.contains('search-highlight-active')).toBe(true);

        // Advance past both the scroll timeout (100ms) and the cleanup (3000ms).
        vi.advanceTimersByTime(3000);
        expect(span.classList.contains('search-highlight-active')).toBe(false);
        expect(scrollSpy).toHaveBeenCalled();
    });

    it('returns early on whitespace-only queries without DOM mutation', () => {
        const root = setupBody('<p>untouched</p>');
        const before = root.innerHTML;
        const mgr = new HighlightManager();
        mgr.highlightAndScroll('   ');
        expect(root.innerHTML).toBe(before);
    });

    it('skips text inside existing highlight spans on subsequent calls', () => {
        const root = setupBody('<p>alpha beta alpha</p>');
        const mgr = new HighlightManager();
        mgr.highlightAndScroll('alpha');
        const firstPass = root.querySelectorAll('span.search-highlight').length;
        // Re-running should not re-wrap content already inside a highlight.
        mgr.highlightAndScroll('alpha');
        const secondPass = root.querySelectorAll('span.search-highlight').length;
        expect(secondPass).toBe(firstPass);
    });
});
