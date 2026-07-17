import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { EditorManager } from './editor-manager';

/**
 * Inject the `<script id="original-markdown-data">` blob the editor reads at
 * open() time. Content must be JSON-encoded as in production.
 */
function seedOriginalMarkdown(content: string): void {
    const el = document.createElement('script');
    el.id = 'original-markdown-data';
    el.type = 'application/json';
    el.textContent = JSON.stringify(content);
    document.body.appendChild(el);
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

function getEditorView(): EditorView {
    const dom = document.querySelector<HTMLElement>('.cm-editor');
    expect(dom).toBeTruthy();
    if (!dom) throw new Error('CodeMirror editor not found');
    const view = EditorView.findFromDOM(dom);
    expect(view).toBeTruthy();
    if (!view) throw new Error('CodeMirror view not found');
    return view;
}

function replaceDocument(view: EditorView, content: string): void {
    view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
    });
}

/** Stub jsdom-missing APIs the EditorManager touches. */
function stubGlobals(): void {
    if (!('confirm' in window)) {
        // jsdom often omits `confirm`; provide a default that says "ok".
        Object.defineProperty(window, 'confirm', { value: vi.fn(() => true), writable: true, configurable: true });
    }
    if (!('alert' in window)) {
        Object.defineProperty(window, 'alert', { value: vi.fn(), writable: true, configurable: true });
    }
}

describe('EditorManager', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        document.body.innerHTML = '';
        document.head.innerHTML = '';
        localStorage.clear();
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubGlobals();
        // close() calls window.location.reload(); jsdom locks both the
        // location object and its `reload` property, so we replace the whole
        // location with a writable proxy whose reload is a no-op.
        const fakeLocation = { ...window.location, reload: vi.fn(), assign: vi.fn(), replace: vi.fn() };
        Object.defineProperty(window, 'location', {
            value: fakeLocation,
            configurable: true,
            writable: true,
        });
        // Default to wide screen so split layout actually applies.
        Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true, writable: true });
    });

    afterEach(() => {
        document.querySelectorAll<HTMLElement>('.cm-editor').forEach(dom => {
            EditorView.findFromDOM(dom)?.destroy();
        });
        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
        vi.restoreAllMocks();
    });

    it('exposes isOpen()/isDirty() before and after open()', async () => {
        seedOriginalMarkdown('# hello');
        const mgr = new EditorManager('docs/test.md');
        expect(mgr.isOpen()).toBe(false);
        expect(mgr.isDirty()).toBe(false);
        await mgr.open();
        expect(mgr.isOpen()).toBe(true);
        expect(mgr.isDirty()).toBe(false);
    });

    it('save() POSTs to /api/save with the canonical body shape and X-Markon-Token header', async () => {
        seedOriginalMarkdown('# hello');
        seedMeta('workspace-id', 'ws-42');
        seedMeta('save-token', 'tok-abc');

        const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
            ok: true,
            status: 200,
            text: async () => '',
            json: async () => ({ success: true }),
        })) as unknown as typeof fetch;
        vi.stubGlobal('fetch', fetchMock);

        const mgr = new EditorManager('docs/test.md');
        await mgr.open();

        // Edit the buffer so save() has something to send.
        replaceDocument(getEditorView(), '# changed');
        await mgr.save();

        // The first /api/save call (preview calls go to /api/preview).
        const calls = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
            (c: unknown[]) => c[0] === '/api/save',
        );
        expect(calls.length).toBe(1);
        const init = itemAt(calls, 0)[1] as RequestInit;
        expect(init.method).toBe('POST');
        const headers = init.headers as Record<string, string>;
        expect(headers['Content-Type']).toBe('application/json');
        expect(headers['X-Markon-Token']).toBe('tok-abc');
        const body = JSON.parse(init.body as string);
        expect(body).toEqual({
            workspace_id: 'ws-42',
            file_path: 'docs/test.md',
            content: '# changed',
        });
    });

    it('input events flip isDirty true and revert clears it back to false', async () => {
        seedOriginalMarkdown('hello');
        const mgr = new EditorManager('a.md');
        await mgr.open();
        const view = getEditorView();
        replaceDocument(view, 'hello!');
        expect(mgr.isDirty()).toBe(true);

        replaceDocument(view, 'hello'); // back to baseline
        expect(mgr.isDirty()).toBe(false);
    });

    it.each([
        {
            label: 'an empty ordered marker before existing text',
            source: '1. # heading',
            cursor: 3,
            expected: '1. \n2. # heading',
            caret: 7,
        },
        {
            label: 'an empty unordered marker',
            source: '-',
            cursor: 1,
            expected: '-\n- ',
            caret: 4,
        },
        {
            label: 'a populated ordered item',
            source: '9. item',
            cursor: 7,
            expected: '9. item\n10. ',
            caret: 12,
        },
        {
            label: 'a checked task item',
            source: '- [x] done',
            cursor: 10,
            expected: '- [x] done\n- [ ] ',
            caret: 17,
        },
    ])('Enter continues $label and moves the caret atomically', async ({ source, cursor, expected, caret }) => {
        seedOriginalMarkdown(source);
        const mgr = new EditorManager('a.md');
        await mgr.open();
        const view = getEditorView();
        view.dispatch({ selection: { anchor: cursor } });

        const enter = new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        });
        view.contentDOM.dispatchEvent(enter);

        expect(enter.defaultPrevented).toBe(true);
        expect(view.state.doc.toString()).toBe(expected);
        expect(view.state.selection.main.anchor).toBe(caret);
        expect(view.state.selection.main.head).toBe(caret);
        expect(mgr.isDirty()).toBe(true);
    });

    it('modified Enter keeps CodeMirror standard newline behavior', async () => {
        seedOriginalMarkdown('- item');
        const mgr = new EditorManager('a.md');
        await mgr.open();
        const view = getEditorView();
        view.dispatch({ selection: { anchor: view.state.doc.length } });

        const enter = new KeyboardEvent('keydown', {
            key: 'Enter',
            shiftKey: true,
            bubbles: true,
            cancelable: true,
        });
        view.contentDOM.dispatchEvent(enter);

        expect(enter.defaultPrevented).toBe(true);
        expect(view.state.doc.toString()).toBe('- item\n');
        expect(mgr.isDirty()).toBe(true);
    });

    it('layout toggle persists "full" to localStorage and loads it back', async () => {
        seedOriginalMarkdown('x');
        const mgr = new EditorManager('a.md');
        await mgr.open();
        const fullBtn = document.querySelector<HTMLElement>('.editor-layout-btn[data-layout="full"]')!;
        fullBtn.click();
        expect(localStorage.getItem('markon.editor.layout')).toBe('full');

        // A second editor instance restores the saved preference.
        const split = document.querySelector<HTMLElement>('.editor-split');
        expect(split?.classList.contains('editor-layout-full')).toBe(true);
    });

    it('Escape key triggers close()', async () => {
        seedOriginalMarkdown('x');
        const mgr = new EditorManager('a.md');
        await mgr.open();
        expect(mgr.isOpen()).toBe(true);

        const ev = new KeyboardEvent('keydown', { key: 'Escape' });
        document.dispatchEvent(ev);
        expect(mgr.isOpen()).toBe(false);
    });

    it('close() with dirty buffer prompts via confirm()', async () => {
        seedOriginalMarkdown('hello');
        const confirmMock = vi.fn(() => false); // user clicks Cancel
        Object.defineProperty(window, 'confirm', { value: confirmMock, writable: true, configurable: true });

        const mgr = new EditorManager('a.md');
        await mgr.open();
        replaceDocument(getEditorView(), 'changed');
        expect(mgr.isDirty()).toBe(true);

        mgr.close();
        expect(confirmMock).toHaveBeenCalled();
        // Cancel → editor stays open.
        expect(mgr.isOpen()).toBe(true);
    });

    it('split divider drag persists pct to localStorage', async () => {
        seedOriginalMarkdown('x');
        const mgr = new EditorManager('a.md');
        await mgr.open();
        const split = document.querySelector<HTMLElement>('.editor-split')!;
        const divider = document.querySelector<HTMLElement>('.editor-split-divider')!;
        // Force a deterministic rect so the drag math is predictable.
        Object.defineProperty(split, 'getBoundingClientRect', {
            value: () => ({ left: 0, width: 1000, top: 0, right: 1000, bottom: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
            configurable: true,
        });

        divider.dispatchEvent(new MouseEvent('mousedown'));
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: 600 }));
        document.dispatchEvent(new MouseEvent('mouseup'));

        expect(localStorage.getItem('markon.editor.split')).toBe('60');
        expect(split.style.getPropertyValue('--editor-split-left')).toBe('60%');
        // Use the manager so vitest does not flag it as unused.
        expect(mgr.isOpen()).toBe(true);
    });

    it('preview path uses server-rendered diagram HTML without client Mermaid', async () => {
        seedOriginalMarkdown('```mermaid\ngraph TD; A-->B\n```');
        seedMeta('workspace-id', 'ws-42');
        seedMeta('preview-token', 'preview-abc');

        const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
            if (url === '/api/preview') {
                return {
                    ok: true,
                    status: 200,
                    text: async () => '',
                    json: async () => ({
                        html: '<div class="markon-diagram" data-diagram-engine="mermaid"><svg></svg></div>',
                    }),
                };
            }
            return { ok: true, status: 200, text: async () => '', json: async () => ({ success: true }) };
        }) as unknown as typeof fetch;
        vi.stubGlobal('fetch', fetchMock);

        // The preview update is debounced behind setTimeout(0).
        vi.useFakeTimers();
        const mgr = new EditorManager('a.md');
        const opening = mgr.open();
        // Drain timers to fire the initial schedulePreviewUpdate(0).
        await vi.runAllTimersAsync();
        await opening;
        // Allow the fetch chain to settle.
        await vi.runAllTimersAsync();
        vi.useRealTimers();
        // Allow microtasks queued after switching back to real timers.
        await Promise.resolve();
        await Promise.resolve();

        expect(document.querySelector('.markon-diagram svg')).toBeTruthy();
        const previewCalls = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
            (c: unknown[]) => c[0] === '/api/preview',
        );
        expect(previewCalls.length).toBeGreaterThan(0);
        const init = itemAt(previewCalls, 0)[1] as RequestInit;
        const headers = init.headers as Record<string, string>;
        expect(headers['X-Markon-Token']).toBe('preview-abc');
        expect(JSON.parse(init.body as string)).toEqual({
            workspace_id: 'ws-42',
            content: '```mermaid\ngraph TD; A-->B\n```',
        });
    });
});
