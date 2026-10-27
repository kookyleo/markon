import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MarkonApp } from './main';
import { FloatingLayer } from './components/floating-layer';
import { WebSocketManager } from './managers/websocket-manager';
import type { Annotation } from './managers/annotation-manager';

/**
 * MarkonApp integration tests.
 *
 * Focus: the conditional manager-wiring logic. We exercise the public surface
 * (constructor + init + getManagers) under various meta-flag combinations to
 * confirm only the expected managers come up.
 */

function seedMeta(name: string, value: string): void {
    const meta = document.createElement('meta');
    meta.setAttribute('name', name);
    meta.setAttribute('content', value);
    document.head.appendChild(meta);
}

function seedMarkdownBody(): HTMLElement {
    const body = document.createElement('article');
    body.className = 'markdown-body';
    body.setAttribute('data-markon-interactive-body', '');
    body.innerHTML = '<h1 id="title">Hello</h1><p>World</p>';
    document.body.appendChild(body);
    return body;
}

async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
}

function serveAnnotations(annotations: Annotation[]): void {
    vi.mocked(fetch).mockResolvedValue({
        ok: true, status: 200, text: async () => '',
        json: async () => ({ annotations, viewed_state: {} }),
    } as Response);
}

function silenceLogs(): { restore: () => void } {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    return {
        restore: () => {
            log.mockRestore();
            warn.mockRestore();
            error.mockRestore();
        },
    };
}

function itemAt<T>(items: ArrayLike<T>, index: number): T {
    const item = items[index];
    expect(item).toBeDefined();
    if (item === undefined) throw new Error(`Missing item at index ${index}`);
    return item;
}

class MockWS {
    static OPEN = 1;
    static CLOSED = 3;
    static instances: MockWS[] = [];

    readyState = MockWS.OPEN;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;

    constructor(readonly url: string) {
        MockWS.instances.push(this);
        queueMicrotask(() => this.onopen?.());
    }

    send(payload: string): void {
        this.sent.push(payload);
    }

    close(): void {
        this.readyState = MockWS.CLOSED;
    }

    dispatchMessage(data: unknown): void {
        this.onmessage?.({
            data: typeof data === 'string' ? data : JSON.stringify(data),
        } as MessageEvent);
    }
}

describe('MarkonApp', () => {
    let restore: () => void;

    beforeEach(() => {
        vi.stubGlobal('ResizeObserver', class {
            observe(): void {}
            unobserve(): void {}
            disconnect(): void {}
        });
        document.body.innerHTML = '';
        document.head.innerHTML = '';
        seedMeta('workspace-id', 'ws1');
        seedMeta('can-manage', 'true');
        localStorage.clear();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: () => Promise.resolve(''),
            json: () => Promise.resolve({ annotations: [], viewed_state: {} }),
        }));
        MockWS.instances = [];
        ({ restore } = silenceLogs());
        // Wipe globals between tests.
        delete (window as { markonApp?: unknown }).markonApp;
        delete (window as { workspaceSpotlight?: unknown }).workspaceSpotlight;
        delete (window as { editorManager?: unknown }).editorManager;
        delete (window as { chatManager?: unknown }).chatManager;
        delete (window as { visualZoomManager?: unknown }).visualZoomManager;
        delete (window as { MarkonTheme?: unknown }).MarkonTheme;
        delete (window as { __MARKON_I18N__?: unknown }).__MARKON_I18N__;
    });

    afterEach(() => {
        window.chatManager?.destroy();
        for (const layer of FloatingLayer.all()) layer.destroy();
        restore();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('directory mode (no .markdown-body) initializes workspace-level managers only', async () => {
        const app = new MarkonApp({ filePath: 'docs/' });
        await app.init();

        const m = app.getManagers();
        expect(m.storage).toBeNull();
        expect(m.shortcutsManager).not.toBeNull();
        // Document-mode managers should remain null.
        expect(m.annotationManager).toBeNull();
        expect(m.noteManager).toBeNull();
        expect(m.popoverManager).toBeNull();
        expect(m.visualZoomManager).toBeNull();
        expect(m.tocNavigator).toBeNull();
        expect(m.annotationNavigator).toBeNull();
    });

    it('directory mode keeps truly global shortcuts such as Theme available', async () => {
        const togglePanel = vi.fn();
        (window as { MarkonTheme?: { togglePanel: () => void } }).MarkonTheme = { togglePanel };

        const app = new MarkonApp({ filePath: 'docs/' });
        await app.init();

        expect(app.getManagers().shortcutsManager?.run('THEME_PANEL')).toBe(true);
        expect(togglePanel).toHaveBeenCalledTimes(1);
    });

    it.each([
        [false, false, false], [false, false, true],
        [false, true, false], [false, true, true],
        [true, false, false], [true, false, true],
        [true, true, false], [true, true, true],
    ])('keeps personal review available independently of legacy flags and roles (Viewed=%s, admin=%s, Share=%s)', async (viewed, admin, shared) => {
        document.querySelector('meta[name="can-manage"]')?.setAttribute('content', String(admin));
        seedMeta('enable-viewed', String(viewed));
        seedMeta('shared-annotation', String(shared));
        vi.stubGlobal('WebSocket', MockWS);
        seedMarkdownBody();
        const app = new MarkonApp({ filePath: 'docs/x.md', isSharedMode: shared });
        await app.init();

        app.getManagers().shortcutsManager?.showHelp();
        const listed = (name: string): boolean =>
            document.querySelector(`.shortcut-item[data-shortcut-name="${name}"]`) !== null;
        expect(listed('TOGGLE_SECTION_COLLAPSE')).toBe(true);
        expect(listed('TOGGLE_VIEWED')).toBe(true);
        for (const name of ['UNDO', 'REDO', 'EXPORT_NOTES', 'NEXT_ANNOTATION', 'PREV_ANNOTATION', 'TOGGLE_SELECTION_TOOLBAR']) {
            expect(listed(name), name).toBe(true);
        }
        expect(listed('REDO_ALT')).toBe(false); // Shown as an alias on the Redo row.
        expect(document.querySelector('[data-shortcut-name="TOGGLE_SECTION_COLLAPSE"]')
            ?.closest('.shortcuts-category')?.querySelector('h3')?.textContent).toBe('web.kbd.cat.reading');
        {
            expect(document.querySelector('[data-shortcut-name="EXPORT_NOTES"]')
                ?.closest('.shortcuts-category')?.querySelector('h3')?.textContent).toBe('web.kbd.cat.output');
            expect(document.querySelector('[data-shortcut-name="TOGGLE_VIEWED"]')
                ?.closest('.shortcuts-category')?.querySelector('h3')?.textContent).toBe('web.kbd.cat.review');
        }
    });

    it('clears annotations without deleting independent progress markers', async () => {
        seedMarkdownBody();
        seedMeta('enable-viewed', 'false');
        vi.stubGlobal('WebSocket', MockWS);
        const app = new MarkonApp({ filePath: 'docs/x.md', isSharedMode: true });
        await app.init();
        const managers = app.getManagers();
        const clearAnnotations = vi.spyOn(managers.annotationManager!, 'clear').mockResolvedValue();
        const clearProgress = vi.spyOn(managers.storage!, 'clearViewedState').mockResolvedValue();

        await app.clearAllAnnotations();
        document.querySelector<HTMLButtonElement>('.confirm-ok')?.click();
        await vi.waitFor(() => expect(clearAnnotations).toHaveBeenCalledOnce());
        await flush();
        expect(clearProgress).not.toHaveBeenCalled();
    });

    it.each(Array.from({ length: 16 }, (_, flags) => [
        Boolean(flags & 1), Boolean(flags & 2), Boolean(flags & 4), Boolean(flags & 8),
    ]))('keeps Annotate independent while selection actions follow Edit=%s Chat=%s Live=%s Share=%s', async (edit, chat, live, share) => {
        document.querySelector('meta[name="can-manage"]')?.setAttribute('content', 'false');
        for (const [name, value] of [['can-annotate', true], ['enable-edit', edit], ['enable-chat', chat], ['enable-live', live], ['shared-annotation', share]]) {
            seedMeta(String(name), String(value));
        }
        vi.stubGlobal('WebSocket', MockWS);
        const body = seedMarkdownBody();
        const app = new MarkonApp({ filePath: 'docs/x.md', enableEdit: edit, enableLive: live, isSharedMode: share });
        await app.init();
        const managers = app.getManagers();
        expect(managers.storage).not.toBeNull();
        expect(managers.annotationManager).not.toBeNull();
        expect(managers.popoverManager?.isEnabled()).toBe(true);
        const range = document.createRange();
        range.selectNodeContents(body.querySelector('p')!);
        range.getBoundingClientRect = () => new DOMRect(100, 100, 120, 20);
        managers.popoverManager!.show(range);
        const toolbar = document.querySelector('.selection-popover')!;
        expect(toolbar.querySelector('[data-action="add-note"]')).not.toBeNull();
        expect(toolbar.querySelector('[data-action="highlight-yellow"]')).not.toBeNull();
        expect(toolbar.querySelector('[data-action="edit"]') !== null).toBe(edit);
        expect(toolbar.querySelector('[data-action="chat"]') !== null).toBe(chat);
        expect(managers.shortcutsManager?.run('TOGGLE_SELECTION_TOOLBAR')).toBe(true);
        expect(managers.popoverManager?.isEnabled()).toBe(false);
        managers.shortcutsManager?.run('TOGGLE_SELECTION_TOOLBAR');
        expect(managers.popoverManager?.isEnabled()).toBe(true);
    });

    it('does not block personal review on a pending Live handshake', async () => {
        vi.spyOn(WebSocketManager.prototype, 'connect').mockReturnValue(new Promise(() => {}));
        seedMeta('enable-live', 'true');
        seedMarkdownBody();
        const app = new MarkonApp({ filePath: 'docs/x.md', enableLive: true });
        await app.init();
        expect(app.getManagers().popoverManager).not.toBeNull();
        expect(app.getManagers().shortcutsManager?.run('TOGGLE_SELECTION_TOOLBAR')).toBe(true);
    });

    it('document mode produces a populated manager snapshot', async () => {
        seedMarkdownBody();
        const app = new MarkonApp({ filePath: 'docs/x.md' });
        await app.init();

        const m = app.getManagers();
        expect(m.annotationManager).not.toBeNull();
        expect(m.noteManager).not.toBeNull();
        expect(m.popoverManager).not.toBeNull();
        expect(m.visualZoomManager).not.toBeNull();
        expect(m.undoManager).not.toBeNull();
        expect(m.tocNavigator).not.toBeNull();
        expect(m.annotationNavigator).not.toBeNull();
        expect(m.storage).not.toBeNull();
        // No WS manager unless shared / live is enabled.
        expect(m.wsManager).toBeNull();
    });

    it.each(['load', 'new_annotation', 'all_annotations'] as const)(
        '%s skips malformed annotations and still renders valid notes and author badges',
        async (source) => {
            const body = seedMarkdownBody();
            vi.stubGlobal('WebSocket', MockWS);
            const valid: Annotation = {
                id: 'anno-valid',
                type: 'has-note',
                tagName: 'span',
                anchor: { position: 5, exact: 'World', prefix: 'Hello', suffix: '' },
                text: 'World',
                note: 'Keep this note',
                createdAt: 1,
                author: { color: '#123456', name: 'Alice' },
            };
            const invalid = [
                undefined, null, false, 5, 'anchor', [], {}, { position: '5' },
                { position: 5, exact: 'World' },
                { ...valid.anchor, prefix: null },
                { ...valid.anchor, suffix: 1 },
                { ...valid.anchor, version: 2, fragments: 'World' },
                { ...valid.anchor, version: 2, fragments: [null] },
                { ...valid.anchor, version: 2, fragments: [{ position: 5, exact: 'World' }] },
                { ...valid.anchor, fragments: [{ ...valid.anchor, exact: null }] },
            ].map((anchor, index) => ({ ...valid, id: `anno-invalid-${index}`, anchor }));
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                json: () => Promise.resolve({
                    annotations: source === 'load' ? [...invalid, valid] : [],
                    viewed_state: {},
                }),
            }));
            const app = new MarkonApp({ filePath: 'docs/x.md', isSharedMode: true });
            await app.init();
            const ws = itemAt(MockWS.instances, 0);
            const { annotationManager, wsManager } = app.getManagers();

            try {
                if (source === 'all_annotations') {
                    // WS snapshots only trigger an authoritative HTTP refresh.
                    vi.mocked(fetch).mockResolvedValue({
                        ok: true, status: 200,
                        json: async () => ({ annotations: [...invalid, valid], viewed_state: {} }),
                    } as Response);
                    ws.dispatchMessage({ type: source, annotations: [] });
                    await flush();
                } else if (source === 'new_annotation') {
                    invalid.forEach(annotation => ws.dispatchMessage({ type: source, annotation }));
                    expect(annotationManager?.getAll()).toEqual([]);
                    ws.dispatchMessage({ type: source, annotation: valid });
                }

                expect(annotationManager?.getAll()).toEqual([valid]);
                const highlight = body.querySelector<HTMLElement>('[data-annotation-id="anno-valid"]');
                expect(highlight?.textContent).toBe('World');
                expect(highlight?.dataset['authorName']).toBe('Alice');
                const card = document.querySelector('.note-card-margin[data-annotation-id="anno-valid"]');
                expect(card?.textContent).toContain('Keep this note');
                expect(card?.querySelector('.note-author-name')?.textContent).toBe('Alice');
                expect(document.querySelector('[data-annotation-id^="anno-invalid-"]')).toBeNull();
            } finally {
                wsManager?.disconnect();
            }
        },
    );

    it('toggles the selection toolbar from its shortcut and lists it in help', async () => {
        seedMarkdownBody();
        const app = new MarkonApp({ filePath: 'docs/x.md' });
        await app.init();

        const { popoverManager, shortcutsManager } = app.getManagers();
        expect(popoverManager?.isEnabled()).toBe(true);
        expect(shortcutsManager?.run('TOGGLE_SELECTION_TOOLBAR')).toBe(true);
        expect(popoverManager?.isEnabled()).toBe(false);

        shortcutsManager?.showHelp();
        const item = document.querySelector<HTMLElement>(
            '.shortcut-item[data-shortcut-name="TOGGLE_SELECTION_TOOLBAR"]',
        );
        expect(item).not.toBeNull();
        item?.click();
        expect(popoverManager?.isEnabled()).toBe(true);
        expect(document.querySelector('.shortcuts-help-panel')).toBeNull();
    });

    it('edits a wide-screen margin note directly over its card', async () => {
        vi.stubGlobal('innerWidth', 1600);
        const body = seedMarkdownBody();
        const app = new MarkonApp({ filePath: 'docs/x.md' });
        await app.init();

        const { annotationManager, noteManager } = app.getManagers();
        expect(annotationManager).not.toBeNull();
        expect(noteManager).not.toBeNull();
        if (!annotationManager || !noteManager) return;

        const text = body.querySelector('p')?.firstChild;
        expect(text).not.toBeNull();
        if (!text) return;
        const range = document.createRange();
        range.selectNodeContents(text);
        const annotation = annotationManager.createAnnotation(
            range,
            'has-note',
            'span',
            'Original note',
        );
        await annotationManager.add(annotation, true);
        annotationManager.applyToDOM([annotation]);
        noteManager.render();

        const card = document.querySelector<HTMLElement>(
            `.note-card-margin[data-annotation-id="${annotation.id}"]`,
        );
        expect(card).not.toBeNull();
        if (!card) return;
        card.getBoundingClientRect = () => ({
            left: 1200,
            top: 180,
            right: 1480,
            bottom: 270,
            width: 280,
            height: 90,
            x: 1200,
            y: 180,
            toJSON: () => ({}),
        });

        const editRange = annotationManager.rangeForAnnotation(annotation);
        expect(editRange).not.toBeNull();
        if (!editRange) return;
        editRange.getClientRects = () => [] as unknown as DOMRectList;
        editRange.getBoundingClientRect = () => ({
            left: 120,
            top: 180,
            right: 220,
            bottom: 200,
            width: 100,
            height: 20,
            x: 120,
            y: 180,
            toJSON: () => ({}),
        });
        vi.spyOn(annotationManager, 'rangeForAnnotation').mockReturnValue(editRange);

        card.querySelector<HTMLButtonElement>('.note-edit')?.click();
        await flush();

        const editor = document.querySelector<HTMLElement>(
            '.note-input-modal.is-note-card-editor',
        );
        expect(editor).not.toBeNull();
        expect(editor?.style.left).toBe('1200px');
        expect(editor?.style.top).toBe('180px');
        expect(editor?.style.width).toBe('280px');
        expect(editor?.querySelector<HTMLTextAreaElement>('.note-textarea')?.value)
            .toBe('Original note');
        expect(card.classList.contains('highlight-active')).toBe(true);
    });

    it('upserts remote Note edits, refreshes open content, and skips exact replays', async () => {
        seedMeta('shared-annotation', 'true');
        seedMeta('file-path', '/docs/shared.md');
        vi.stubGlobal('WebSocket', MockWS);
        const body = seedMarkdownBody();
        const app = new MarkonApp({ filePath: '/docs/shared.md', isSharedMode: true });
        await app.init();
        const { annotationManager, noteManager, wsManager } = app.getManagers();
        if (!annotationManager || !noteManager || !wsManager) throw new Error('Missing shared managers');
        const socket = itemAt(MockWS.instances, 0);
        const range = document.createRange();
        range.selectNodeContents(body.querySelector('p')!);
        const original = annotationManager.createAnnotation(range, 'has-note', 'span', 'Original note');
        serveAnnotations([original]);
        socket.dispatchMessage({ type: 'all_annotations', annotations: [original] });
        await flush();
        const selector = `[data-annotation-id="${original.id}"]`;
        const highlight = body.querySelector<HTMLElement>(selector)!;
        noteManager.showNotePopup(highlight, original.id);
        const render = vi.spyOn(noteManager, 'render');
        const dispatch = vi.spyOn(document, 'dispatchEvent');
        const fetchCount = vi.mocked(fetch).mock.calls.length;

        const updated = { ...original, note: 'Updated by another reader' };
        socket.dispatchMessage({ type: 'new_annotation', annotation: updated, op_id: 'remote-update' });

        expect(annotationManager.getById(original.id)?.note).toBe(updated.note);
        expect(body.querySelectorAll(selector)).toHaveLength(1);
        expect(body.querySelector<HTMLElement>(selector)?.dataset['note']).toBe(updated.note);
        expect(noteManager.getNoteCardsData()).toHaveLength(1);
        expect(noteManager.getNoteCardsData()[0]?.note).toBe(updated.note);
        expect(document.querySelector('.note-popup .note-content')?.textContent).toBe(updated.note);
        expect(app.notesCount()).toBe(1);
        expect(render).toHaveBeenCalledOnce();
        const updatedWrapper = body.querySelector(selector);
        const eventCount = dispatch.mock.calls.length;

        socket.dispatchMessage({ type: 'new_annotation', annotation: { ...updated }, op_id: 'remote-replay' });
        expect(body.querySelectorAll(selector)).toHaveLength(1);
        expect(body.querySelector(selector)).toBe(updatedWrapper);
        expect(render).toHaveBeenCalledOnce();
        expect(dispatch.mock.calls).toHaveLength(eventCount);

        socket.dispatchMessage({ type: 'new_annotation', annotation: { ...updated, note: '' } });
        expect(app.notesCount()).toBe(0);
        expect(noteManager.getNoteCardsData()).toHaveLength(0);
        expect(document.querySelector('.note-popup')).toBeNull();
        const event = dispatch.mock.calls.at(-1)?.[0];
        expect(event).toBeInstanceOf(CustomEvent);
        expect((event as CustomEvent<{ count: number }>).detail.count).toBe(0);
        expect(vi.mocked(fetch).mock.calls).toHaveLength(fetchCount);
        wsManager.disconnect();
    });

    it('reloads committed annotations after delayed initial and reconnect snapshots', async () => {
        seedMeta('shared-annotation', 'true');
        seedMeta('file-path', '/docs/shared.md');
        vi.stubGlobal('WebSocket', MockWS);
        const body = seedMarkdownBody();
        const app = new MarkonApp({ filePath: '/docs/shared.md', isSharedMode: true });
        await app.init();
        const { annotationManager, noteManager, wsManager } = app.getManagers();
        if (!annotationManager || !noteManager || !wsManager) throw new Error('Missing shared managers');
        const socket = itemAt(MockWS.instances, 0);
        const range = document.createRange();
        range.selectNodeContents(body.querySelector('p')!);
        const committed = annotationManager.createAnnotation(range, 'has-note', 'span', 'Committed before WS');
        await annotationManager.add(committed);
        annotationManager.applyToDOM();
        noteManager.render();
        const fetchCount = vi.mocked(fetch).mock.calls.length;

        // The delayed WS payload predates our commit; the fresh GET sees it.
        serveAnnotations([committed]);
        socket.dispatchMessage({ type: 'all_annotations', annotations: [] });
        await flush();
        expect(annotationManager.getById(committed.id)).not.toBeNull();
        expect(app.notesCount()).toBe(1);
        const highlight = body.querySelector<HTMLElement>(`[data-annotation-id="${committed.id}"]`)!;
        noteManager.showNotePopup(highlight, committed.id);

        // A reconnect snapshot must reflect a deletion made while disconnected.
        const dispatch = vi.spyOn(document, 'dispatchEvent');
        serveAnnotations([]);
        socket.dispatchMessage({ type: 'all_annotations', annotations: [] });
        await flush();
        expect(annotationManager.getAll()).toEqual([]);
        expect(body.querySelector('[data-annotation-id]')).toBeNull();
        expect(noteManager.getNoteCardsData()).toEqual([]);
        expect(document.querySelector('.note-popup')).toBeNull();
        expect(app.notesCount()).toBe(0);
        const event = dispatch.mock.calls.at(-1)?.[0];
        expect((event as CustomEvent<{ count: number }>).detail.count).toBe(0);
        expect(vi.mocked(fetch).mock.calls).toHaveLength(fetchCount + 2);
        wsManager.disconnect();
    });

    it('replaces stale HTTP state and retains only local commits made during a reconnect', async () => {
        seedMeta('shared-annotation', 'true');
        seedMeta('file-path', '/docs/shared.md');
        vi.stubGlobal('WebSocket', MockWS);
        const body = seedMarkdownBody();
        const http: Annotation = {
            id: 'anno-http', type: 'has-note', tagName: 'span',
            anchor: { position: 0, exact: 'World', prefix: '', suffix: '' },
            text: 'World', note: 'deleted before the socket subscribed', createdAt: 1,
        };
        vi.mocked(fetch).mockResolvedValue({
            ok: true, status: 200, text: async () => '',
            json: async () => ({ annotations: [http], viewed_state: {} }),
        } as Response);
        const app = new MarkonApp({ filePath: '/docs/shared.md', isSharedMode: true });
        await app.init();
        const { annotationManager, wsManager } = app.getManagers();
        if (!annotationManager || !wsManager) throw new Error('Missing shared managers');
        const socket = itemAt(MockWS.instances, 0);
        expect(app.notesCount()).toBe(1);
        serveAnnotations([]);
        socket.dispatchMessage({ type: 'all_annotations', annotations: [] });
        await flush();
        expect(app.notesCount()).toBe(0);
        expect(annotationManager.getAll()).toEqual([]);

        socket.dispatchMessage({ type: 'new_annotation', annotation: { ...http, id: 'anno-peer' } });
        socket.readyState = MockWS.CLOSED;
        socket.onclose?.({ code: 1006, reason: '', wasClean: false } as CloseEvent);
        const range = document.createRange();
        range.selectNodeContents(body.querySelector('p')!);
        const local = annotationManager.createAnnotation(range, 'has-note', 'span', 'committed while disconnected');
        await annotationManager.add(local);
        await wsManager.connect();
        serveAnnotations([local]);
        itemAt(MockWS.instances, 1).dispatchMessage({ type: 'all_annotations', annotations: [] });
        await flush();
        expect(annotationManager.getAll()).toEqual([local]);
        expect(app.notesCount()).toBe(1);
        expect(body.querySelector('[data-annotation-id="anno-peer"]')).toBeNull();
        expect(body.querySelector(`[data-annotation-id="${local.id}"]`)).not.toBeNull();
        wsManager.disconnect();
    });

    it('double-clicking Read text does not trigger the heading fold action', async () => {
        const body = seedMarkdownBody();
        const heading = document.createElement('h2');
        heading.id = 'read-section';
        heading.innerHTML = '<span class="heading-title">Section</span><span class="section-actions"><label class="viewed-checkbox-label"><input type="checkbox" class="viewed-checkbox"><span class="viewed-text">Read</span></label></span>';
        body.appendChild(heading);
        const app = new MarkonApp({ filePath: '/docs/read.md' });
        await app.init();
        const previous = window.viewedManager;
        const toggleCollapse = vi.fn();
        window.viewedManager = { toggleCollapse } as unknown as NonNullable<typeof window.viewedManager>;
        try {
            heading.querySelector('.viewed-text')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            expect(toggleCollapse).not.toHaveBeenCalled();
            heading.querySelector('.heading-title')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            expect(toggleCollapse).toHaveBeenCalledWith('read-section');
        } finally {
            if (previous) window.viewedManager = previous;
            else delete window.viewedManager;
        }
    });

    it('plain markdown-body without the interactive marker stays in minimal mode', async () => {
        const body = document.createElement('article');
        body.className = 'markdown-body';
        body.innerHTML = '<h1 id="title">Compare only</h1><p>Styled but inert</p>';
        document.body.appendChild(body);

        const app = new MarkonApp({ filePath: '__markon_diff__/compare' });
        await app.init();

        const m = app.getManagers();
        expect(m.shortcutsManager).not.toBeNull();
        expect(m.annotationManager).toBeNull();
        expect(m.noteManager).toBeNull();
        expect(m.popoverManager).toBeNull();
        expect(m.visualZoomManager).toBeNull();
    });

    it('missing workspace id leaves WorkspaceSpotlight null and hides its triggers', async () => {
        document.querySelector('meta[name="workspace-id"]')?.remove();
        seedMarkdownBody();
        const trigger = document.createElement('button');
        trigger.setAttribute('data-workspace-spotlight-trigger', '');
        document.body.appendChild(trigger);
        const app = new MarkonApp({ filePath: 'docs/x.md', enableSearch: true });
        await app.init();

        expect(app.getManagers().workspaceSpotlight).toBeNull();
        expect(window.workspaceSpotlight).toBeUndefined();
        expect(trigger.hidden).toBe(true);
    });

    it('workspace id creates WorkspaceSpotlight and mounts it on window', async () => {
        seedMeta('workspace-id', 'ws1');
        seedMarkdownBody();
        const app = new MarkonApp({ filePath: 'docs/x.md', enableSearch: true });
        await app.init();

        expect(app.getManagers().workspaceSpotlight).not.toBeNull();
        expect(window.workspaceSpotlight).toBeDefined();
    });

    it('workspace document navigator opens from the document-page trigger', async () => {
        seedMeta('workspace-id', 'ws1');
        seedMarkdownBody();
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.setAttribute('data-workspace-spotlight-trigger', '');
        document.body.appendChild(trigger);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve([
                { path: 'README.md', name: 'README.md', url: '/ws1/README.md', is_markdown: true },
            ]),
        }));

        const app = new MarkonApp({ filePath: 'README.md' });
        await app.init();
        trigger.click();
        await flush();

        expect(fetch).toHaveBeenCalledWith('/_/ws1/files/data', { credentials: 'same-origin' });
        expect(document.querySelector('.workspace-spotlight-overlay.is-open')).not.toBeNull();
        expect(document.body.textContent).toContain('README.md');
    });

    it('public mirrors expose enableLive and ws', () => {
        const app = new MarkonApp({ filePath: 'docs/x.md', enableLive: true });
        expect(app.enableLive).toBe(true);
        expect(app.ws).toBeNull();
    });

    it('clearAllAnnotations is callable and routes through ModalManager (no throw)', async () => {
        seedMarkdownBody();
        const app = new MarkonApp({ filePath: 'docs/x.md' });
        await app.init();
        // Just ensure the entry point is wired and doesn't blow up.
        await expect(app.clearAllAnnotations(null)).resolves.toBeUndefined();
    });

    it('file_changed for the active workspace reloads the page', async () => {
        seedMeta('workspace-id', 'ws1');
        seedMarkdownBody();
        vi.stubGlobal('WebSocket', MockWS);
        const reload = vi.fn();
        Object.defineProperty(window, 'location', {
            value: { ...window.location, reload },
            configurable: true,
        });
        const app = new MarkonApp({
            filePath: 'docs/spec.md',
            enableLive: true,
        });
        await app.init();
        const ws = itemAt(MockWS.instances, 0);

        ws.dispatchMessage({ type: 'file_changed', workspace_id: 'other', path: 'spec.md' });
        expect(reload).not.toHaveBeenCalled();
        ws.dispatchMessage({ type: 'file_changed', workspace_id: 'ws1', path: 'spec.md' });
        expect(reload).toHaveBeenCalledOnce();

        app.getManagers().wsManager?.disconnect();
    });
});
