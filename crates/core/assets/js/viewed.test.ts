import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SectionViewedManager } from './viewed';

/**
 * Tests for the section viewed manager.
 *
 * Importing `./viewed` triggers its IIFE init handler. Because the test DOM
 * is empty at import time the handler is a no-op (no `.markdown-body`),
 * leaving us free to construct managers directly per test.
 */

function buildArticle(headings: string[] = ['h2-a', 'h3-b', 'h2-c']): HTMLElement {
    const article = document.createElement('article');
    article.className = 'markdown-body';

    article.innerHTML = `<h1 id="title">Doc</h1>`;
    for (const id of headings) {
        const lvl = id.startsWith('h3') ? 'h3' : 'h2';
        article.innerHTML += `<${lvl} id="${id}">Section ${id}</${lvl}><p>body of ${id}</p>`;
    }
    document.body.appendChild(article);
    return article;
}

function seedMeta(name: string, value: string): void {
    const meta = document.createElement('meta');
    meta.setAttribute('name', name);
    meta.setAttribute('content', value);
    document.head.appendChild(meta);
}

describe('SectionViewedManager', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        document.body.innerHTML = '';
        document.head.innerHTML = '';
        localStorage.clear();
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        delete (window as { viewedManager?: unknown }).viewedManager;
        delete (window as { ws?: unknown }).ws;
    });

    afterEach(() => {
        logSpy.mockRestore();
        warnSpy.mockRestore();
        vi.restoreAllMocks();
    });

    it('injects a viewed checkbox per h2/h3 (h1 untouched)', async () => {
        seedMeta('file-path', 'docs/x.md');
        seedMeta('enable-viewed', 'true');
        buildArticle(['h2-a', 'h3-b', 'h2-c']);

        const mgr = new SectionViewedManager(false, null);
        await mgr.ready;

        const checkboxes = document.querySelectorAll<HTMLInputElement>('.viewed-checkbox');
        expect(checkboxes.length).toBe(3 + 1); // 3 sections + the toolbar's "All Viewed".

        const h1 = document.querySelector('h1');
        expect(h1?.querySelector('.viewed-checkbox')).not.toBeNull(); // toolbar mounts on h1
    });

    it('toggleViewed marks a section collapsed and persists to LocalStorage in local mode', async () => {
        seedMeta('file-path', 'docs/x.md');
        seedMeta('enable-viewed', 'true');
        buildArticle(['h2-a']);

        const mgr = new SectionViewedManager(false, null);
        await mgr.ready;

        mgr.toggleViewed('h2-a', true);
        const heading = document.getElementById('h2-a');
        expect(heading?.classList.contains('section-collapsed')).toBe(true);

        // Persisted to localStorage.
        const raw = localStorage.getItem('markon-viewed-docs/x.md');
        expect(raw).not.toBeNull();
        expect(JSON.parse(raw as string)).toEqual({ 'h2-a': true });
    });

    it('toggleCollapse flips section-collapsed without touching viewedState', async () => {
        seedMeta('file-path', 'docs/x.md');
        seedMeta('enable-viewed', 'true');
        buildArticle(['h2-a']);

        const mgr = new SectionViewedManager(false, null);
        await mgr.ready;

        const heading = document.getElementById('h2-a')!;
        expect(heading.classList.contains('section-collapsed')).toBe(false);

        mgr.toggleCollapse('h2-a');
        expect(heading.classList.contains('section-collapsed')).toBe(true);
        expect(mgr.viewedState['h2-a']).toBeUndefined();

        mgr.toggleCollapse('h2-a');
        expect(heading.classList.contains('section-collapsed')).toBe(false);
    });

    it('shared-mode: WS viewed_state push updates viewedState and reflects in checkboxes', async () => {
        seedMeta('file-path', 'docs/x.md');
        seedMeta('enable-viewed', 'true');
        buildArticle(['h2-a', 'h2-b']);

        // Minimal WebSocket-shaped EventTarget that supports `addEventListener('message', …)`.
        const fakeWs = new EventTarget() as unknown as WebSocket;
        // Pretend it's open so saveState() doesn't warn.
        Object.defineProperty(fakeWs, 'readyState', { value: WebSocket.OPEN, configurable: true });
        Object.defineProperty(fakeWs, 'send', { value: vi.fn(), configurable: true });

        const mgr = new SectionViewedManager(true, fakeWs);

        // Simulate a server push BEFORE the constructor's init() resolves.
        const event = new MessageEvent('message', {
            data: JSON.stringify({ type: 'viewed_state', state: { 'h2-a': true } }),
        });
        (fakeWs as EventTarget).dispatchEvent(event);

        await mgr.ready;

        expect(mgr.viewedState).toEqual({ 'h2-a': true });
        // Checkbox state reflects the push.
        const cb = document.querySelector<HTMLInputElement>('.viewed-checkbox[data-heading-id="h2-a"]');
        expect(cb?.checked).toBe(true);
    });

    it('saveState in shared mode sends update_viewed_state through the WebSocket', () => {
        seedMeta('file-path', 'docs/x.md');
        seedMeta('enable-viewed', 'true');
        buildArticle(['h2-a']);

        const send = vi.fn();
        const fakeWs = new EventTarget() as unknown as WebSocket;
        Object.defineProperty(fakeWs, 'readyState', { value: WebSocket.OPEN, configurable: true });
        Object.defineProperty(fakeWs, 'send', { value: send, configurable: true });

        const mgr = new SectionViewedManager(true, fakeWs);
        mgr.viewedState = { 'h2-a': true };
        mgr.saveState();

        expect(send).toHaveBeenCalledTimes(1);
        const payload = JSON.parse(send.mock.calls[0][0] as string);
        expect(payload).toEqual({ type: 'update_viewed_state', state: { 'h2-a': true } });
    });

    it('markAllViewed and markAllUnviewed flip every section', async () => {
        seedMeta('file-path', 'docs/x.md');
        seedMeta('enable-viewed', 'true');
        buildArticle(['h2-a', 'h2-b', 'h2-c']);

        const mgr = new SectionViewedManager(false, null);
        await mgr.ready;

        mgr.markAllViewed();
        expect(mgr.viewedState).toEqual({ 'h2-a': true, 'h2-b': true, 'h2-c': true });
        expect(document.querySelectorAll('.section-collapsed').length).toBeGreaterThanOrEqual(3);

        mgr.markAllUnviewed();
        expect(mgr.viewedState).toEqual({});
    });

    it('updateTocHighlights mirrors viewedState onto .toc-item elements', async () => {
        seedMeta('file-path', 'docs/x.md');
        seedMeta('enable-viewed', 'true');
        buildArticle(['h2-a', 'h2-b']);

        // Stub a TOC.
        const toc = document.createElement('div');
        toc.className = 'toc';
        toc.innerHTML = `
            <div class="toc-item"><a href="#h2-a">a</a></div>
            <div class="toc-item"><a href="#h2-b">b</a></div>
        `;
        document.body.appendChild(toc);

        const mgr = new SectionViewedManager(false, null);
        await mgr.ready;

        mgr.viewedState = { 'h2-a': true };
        mgr.updateTocHighlights();

        const items = document.querySelectorAll<HTMLElement>('.toc-item');
        expect(items[0].classList.contains('viewed')).toBe(true);
        expect(items[1].classList.contains('viewed')).toBe(false);
    });
});
