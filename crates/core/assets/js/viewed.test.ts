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

function buildNestedArticle(): HTMLElement {
    const article = document.createElement('article');
    article.className = 'markdown-body';
    article.innerHTML = `
        <h1 id="title">Doc</h1>
        <div class="heading-section">
            <h2 id="h2-a">Section h2-a</h2>
            <p>body of h2-a</p>
            <div class="heading-section">
                <h3 id="h3-b">Section h3-b</h3>
                <p>body of h3-b</p>
            </div>
        </div>
    `;
    document.body.appendChild(article);
    return article;
}

function seedMeta(name: string, value: string): void {
    const meta = document.createElement('meta');
    meta.setAttribute('name', name);
    meta.setAttribute('content', value);
    document.head.appendChild(meta);
}

function itemAt<T>(items: ArrayLike<T>, index: number): T {
    const item = items[index];
    expect(item).toBeDefined();
    if (item === undefined) throw new Error(`Missing item at index ${index}`);
    return item;
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
        delete window.markonExportNotes;
        delete window.markonNotesCount;
    });

    afterEach(() => {
        vi.useRealTimers();
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

    it('groups each section heading action row for focus-only visibility', async () => {
        seedMeta('file-path', 'docs/x.md');
        seedMeta('enable-viewed', 'true');
        buildArticle(['h2-a', 'h3-b']);

        const mgr = new SectionViewedManager(false, null);
        await mgr.ready;

        document.querySelectorAll<HTMLElement>('h2, h3').forEach((heading) => {
            const actionRows = heading.querySelectorAll(':scope > .section-actions');
            expect(actionRows).toHaveLength(1);
            expect(actionRows[0]?.querySelector('.viewed-checkbox-label')).not.toBeNull();
            expect(actionRows[0]?.querySelector('.section-print-btn')).not.toBeNull();
            expect(actionRows[0]?.querySelector('.section-export-notes')).not.toBeNull();
            expect(actionRows[0]?.querySelector('.section-expand-toggle')).not.toBeNull();
        });

        expect(document.querySelector('h1 > .section-actions')).toBeNull();
    });

    it('exports notes from each heading scope and refreshes scoped counts', async () => {
        seedMeta('file-path', 'docs/x.md');
        seedMeta('enable-viewed', 'false');
        buildNestedArticle();

        const counts: Record<string, number> = { 'h2-a': 2, 'h3-b': 1 };
        const notesCount = vi.fn((headingId?: string | null) => headingId ? counts[headingId] ?? 0 : 3);
        const exportNotes = vi.fn();
        window.markonNotesCount = notesCount;
        window.markonExportNotes = exportNotes;

        const mgr = new SectionViewedManager(false, null);
        await mgr.ready;

        const parentButton = document.querySelector<HTMLElement>(
            '#h2-a > .section-actions .section-export-notes',
        );
        const childButton = document.querySelector<HTMLElement>(
            '#h3-b > .section-actions .section-export-notes',
        );
        expect(parentButton?.textContent).toBe('web.export.label (2)');
        expect(childButton?.textContent).toBe('web.export.label (1)');
        expect(document.querySelector('.viewed-toolbar')).toBeNull();

        childButton?.click();
        expect(exportNotes).toHaveBeenCalledWith(childButton, 'h3-b');

        counts['h3-b'] = 0;
        document.dispatchEvent(new CustomEvent('markon:notes-count-changed'));
        expect(childButton?.textContent).toBe('web.export.label (0)');
        expect(childButton?.getAttribute('aria-disabled')).toBe('true');

        exportNotes.mockClear();
        childButton?.click();
        expect(exportNotes).not.toHaveBeenCalled();
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

        const collapsedRaw = localStorage.getItem('markon-collapsed-docs/x.md');
        expect(collapsedRaw).not.toBeNull();
        expect(JSON.parse(collapsedRaw as string)).toEqual({ 'h2-a': true });
    });

    it('restores viewed sections as collapsed when no explicit collapse state exists', async () => {
        seedMeta('file-path', 'docs/x.md');
        seedMeta('enable-viewed', 'true');
        localStorage.setItem('markon-viewed-docs/x.md', JSON.stringify({ 'h2-a': true }));
        buildArticle(['h2-a']);

        const mgr = new SectionViewedManager(false, null);
        await mgr.ready;

        expect(document.getElementById('h2-a')?.classList.contains('section-collapsed')).toBe(true);
        const cb = document.querySelector<HTMLInputElement>('.viewed-checkbox[data-heading-id="h2-a"]');
        expect(cb?.checked).toBe(true);
    });

    it('persists manual collapse and expand independently of viewed state', async () => {
        seedMeta('file-path', 'docs/x.md');
        seedMeta('enable-viewed', 'true');
        buildArticle(['h2-a']);

        const mgr = new SectionViewedManager(false, null);
        await mgr.ready;

        mgr.toggleCollapse('h2-a');
        expect(JSON.parse(localStorage.getItem('markon-collapsed-docs/x.md') ?? '{}')).toEqual({ 'h2-a': true });

        document.body.innerHTML = '';
        buildArticle(['h2-a']);
        const restoredCollapsed = new SectionViewedManager(false, null);
        await restoredCollapsed.ready;
        expect(document.getElementById('h2-a')?.classList.contains('section-collapsed')).toBe(true);

        restoredCollapsed.toggleCollapse('h2-a');
        expect(JSON.parse(localStorage.getItem('markon-collapsed-docs/x.md') ?? '{}')).toEqual({ 'h2-a': false });

        document.body.innerHTML = '';
        buildArticle(['h2-a']);
        const restoredExpanded = new SectionViewedManager(false, null);
        await restoredExpanded.ready;
        expect(document.getElementById('h2-a')?.classList.contains('section-collapsed')).toBe(false);
    });

    it('keeps a manually expanded viewed section expanded after reload', async () => {
        seedMeta('file-path', 'docs/x.md');
        seedMeta('enable-viewed', 'true');
        localStorage.setItem('markon-viewed-docs/x.md', JSON.stringify({ 'h2-a': true }));
        buildArticle(['h2-a']);

        const mgr = new SectionViewedManager(false, null);
        await mgr.ready;
        expect(document.getElementById('h2-a')?.classList.contains('section-collapsed')).toBe(true);

        mgr.toggleCollapse('h2-a');
        expect(document.getElementById('h2-a')?.classList.contains('section-collapsed')).toBe(false);

        document.body.innerHTML = '';
        buildArticle(['h2-a']);
        const restored = new SectionViewedManager(false, null);
        await restored.ready;

        expect(restored.viewedState).toEqual({ 'h2-a': true });
        expect(restored.collapsedState).toEqual({ 'h2-a': false });
        expect(document.getElementById('h2-a')?.classList.contains('section-collapsed')).toBe(false);
        const cb = document.querySelector<HTMLInputElement>('.viewed-checkbox[data-heading-id="h2-a"]');
        expect(cb?.checked).toBe(true);
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

    it('collapseAll / expandAll keep the per-section toggle button label in sync (#15)', async () => {
        seedMeta('file-path', 'docs/x.md');
        seedMeta('enable-viewed', 'true');
        buildArticle(['h2-a', 'h2-b']);

        const mgr = new SectionViewedManager(false, null);
        await mgr.ready;

        const btnFor = (id: string): HTMLElement | null =>
            document.querySelector<HTMLElement>(
                `#${id} .section-expand-toggle`,
            );
        // Initial label: "Collapse" (sections start expanded).
        expect(btnFor('h2-a')?.textContent).toBe('web.viewed.collapse');
        expect(btnFor('h2-b')?.textContent).toBe('web.viewed.collapse');

        mgr.collapseAll();
        expect(btnFor('h2-a')?.textContent).toBe('web.viewed.expand');
        expect(btnFor('h2-b')?.textContent).toBe('web.viewed.expand');

        mgr.expandAll();
        expect(btnFor('h2-a')?.textContent).toBe('web.viewed.collapse');
        expect(btnFor('h2-b')?.textContent).toBe('web.viewed.collapse');
    });

    it('expandAll clears hidden state from nested section wrappers', async () => {
        seedMeta('file-path', 'docs/x.md');
        seedMeta('enable-viewed', 'true');
        buildNestedArticle();

        const mgr = new SectionViewedManager(false, null);
        await mgr.ready;

        mgr.collapseAll();
        expect(document.querySelectorAll('.section-collapsed').length).toBe(2);
        expect(document.querySelectorAll('.section-content-hidden').length).toBeGreaterThan(0);

        mgr.expandAll();
        expect(document.querySelectorAll('.section-collapsed').length).toBe(0);
        expect(document.querySelectorAll('.section-collapsed-placeholder').length).toBe(0);
        expect(document.querySelectorAll('.section-content-hidden').length).toBe(0);
        expect(document.querySelectorAll('.section-content-temp-visible').length).toBe(0);
    });

    it('toggleCollapse (o shortcut path) keeps the toggle button label in sync (#15)', async () => {
        seedMeta('file-path', 'docs/x.md');
        seedMeta('enable-viewed', 'true');
        buildArticle(['h2-a']);

        const mgr = new SectionViewedManager(false, null);
        await mgr.ready;

        const btn = document.querySelector<HTMLElement>('#h2-a .section-expand-toggle')!;
        expect(btn.textContent).toBe('web.viewed.collapse');

        mgr.toggleCollapse('h2-a');
        expect(btn.textContent).toBe('web.viewed.expand');

        mgr.toggleCollapse('h2-a');
        expect(btn.textContent).toBe('web.viewed.collapse');
    });

    it('toggleCollapse removes temporary expand sizing after the expand transition', async () => {
        seedMeta('file-path', 'docs/x.md');
        seedMeta('enable-viewed', 'true');
        buildArticle(['h2-a']);

        const mgr = new SectionViewedManager(false, null);
        await mgr.ready;

        mgr.toggleCollapse('h2-a');
        const paragraph = document.querySelector<HTMLElement>('p')!;
        expect(paragraph.classList.contains('section-content-hidden')).toBe(true);

        mgr.toggleCollapse('h2-a');
        expect(paragraph.classList.contains('section-content-hidden')).toBe(false);
        expect(paragraph.classList.contains('section-content-temp-visible')).toBe(true);

        paragraph.dispatchEvent(new TransitionEvent('transitionend', { propertyName: 'opacity' }));
        expect(paragraph.classList.contains('section-content-temp-visible')).toBe(false);
    });

    it('temporarily expands a collapsed note source and restores it when the note loses focus', async () => {
        seedMeta('file-path', 'docs/x.md');
        seedMeta('enable-viewed', 'true');
        localStorage.setItem('markon-viewed-docs/x.md', JSON.stringify({ 'h2-a': true }));
        const article = buildArticle(['h2-a']);
        const paragraph = article.querySelector('p')!;
        paragraph.innerHTML = '<span class="has-note" data-annotation-id="anno-a">note source</span>';

        const mgr = new SectionViewedManager(false, null);
        await mgr.ready;

        const heading = document.getElementById('h2-a')!;
        const source = article.querySelector<HTMLElement>('[data-annotation-id="anno-a"]')!;
        expect(heading.classList.contains('section-collapsed')).toBe(true);

        mgr.revealNoteSource('anno-a', source);
        expect(heading.classList.contains('section-collapsed')).toBe(false);
        expect(paragraph.classList.contains('section-content-hidden')).toBe(false);

        mgr.clearNoteSourceReveal('anno-a');
        expect(heading.classList.contains('section-collapsed')).toBe(true);
        expect(paragraph.classList.contains('section-content-hidden')).toBe(true);
    });

    it('does not restore an auto-expanded note source after manual expand/collapse', async () => {
        seedMeta('file-path', 'docs/x.md');
        seedMeta('enable-viewed', 'true');
        localStorage.setItem('markon-viewed-docs/x.md', JSON.stringify({ 'h2-a': true }));
        const article = buildArticle(['h2-a']);
        const paragraph = article.querySelector('p')!;
        paragraph.innerHTML = '<span class="has-note" data-annotation-id="anno-a">note source</span>';

        const mgr = new SectionViewedManager(false, null);
        await mgr.ready;

        const heading = document.getElementById('h2-a')!;
        const source = article.querySelector<HTMLElement>('[data-annotation-id="anno-a"]')!;

        mgr.revealNoteSource('anno-a', source);
        mgr.toggleCollapse('h2-a');
        mgr.toggleCollapse('h2-a');
        mgr.clearNoteSourceReveal('anno-a');

        expect(heading.classList.contains('section-collapsed')).toBe(false);
    });

    it('temporarily expands every collapsed ancestor section containing the note source', async () => {
        seedMeta('file-path', 'docs/x.md');
        seedMeta('enable-viewed', 'true');
        buildNestedArticle();

        const mgr = new SectionViewedManager(false, null);
        await mgr.ready;

        const nestedParagraph = document.querySelector<HTMLElement>('#h3-b + p')!;
        nestedParagraph.innerHTML = '<span class="has-note" data-annotation-id="anno-b">nested source</span>';
        const source = nestedParagraph.querySelector<HTMLElement>('[data-annotation-id="anno-b"]')!;

        mgr.collapseSection('h2-a');
        mgr.collapseSection('h3-b');
        mgr.revealNoteSource('anno-b', source);

        expect(document.getElementById('h2-a')?.classList.contains('section-collapsed')).toBe(false);
        expect(document.getElementById('h3-b')?.classList.contains('section-collapsed')).toBe(false);

        mgr.clearNoteSourceReveal('anno-b');
        expect(document.getElementById('h2-a')?.classList.contains('section-collapsed')).toBe(true);
        expect(document.getElementById('h3-b')?.classList.contains('section-collapsed')).toBe(true);
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

    it('can preserve current expansion state for the first shared viewed_state replay', async () => {
        seedMeta('file-path', 'docs/x.md');
        seedMeta('enable-viewed', 'true');
        buildArticle(['h2-a', 'h2-b']);

        const fakeWs = new EventTarget() as unknown as WebSocket;
        Object.defineProperty(fakeWs, 'readyState', { value: WebSocket.OPEN, configurable: true });
        Object.defineProperty(fakeWs, 'send', { value: vi.fn(), configurable: true });

        const mgr = new SectionViewedManager(false, null);
        await mgr.ready;

        mgr.toggleCollapse('h2-a');
        expect(document.getElementById('h2-a')?.classList.contains('section-collapsed')).toBe(true);
        expect(document.getElementById('h2-b')?.classList.contains('section-collapsed')).toBe(false);

        mgr.isSharedMode = true;
        mgr.ws = fakeWs;
        mgr.preserveExpansionForNextSharedState();
        mgr.setupWebSocketListeners();
        (fakeWs as EventTarget).dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({ type: 'viewed_state', state: { 'h2-b': true } }),
        }));

        expect(mgr.viewedState).toEqual({ 'h2-b': true });
        expect(document.getElementById('h2-a')?.classList.contains('section-collapsed')).toBe(true);
        expect(document.getElementById('h2-b')?.classList.contains('section-collapsed')).toBe(false);
    });

    it('saveState without attached SQLite uses local fallback, never WebSocket persistence', () => {
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

        expect(send).not.toHaveBeenCalled();
        expect(JSON.parse(localStorage.getItem('markon-viewed-docs/x.md') ?? '{}')).toEqual({
            'h2-a': true,
        });
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
        expect(itemAt(items, 0).classList.contains('viewed')).toBe(true);
        expect(itemAt(items, 1).classList.contains('viewed')).toBe(false);
    });
});
