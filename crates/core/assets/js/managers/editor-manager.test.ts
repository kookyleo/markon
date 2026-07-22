import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { downloadTextFile } from '../core/download';
import type * as DownloadModule from '../core/download';
import { EditorManager } from './editor-manager';

vi.mock('../core/download', async importOriginal => {
    const actual = await importOriginal<typeof DownloadModule>();
    return { ...actual, downloadTextFile: vi.fn() };
});

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
    // jsdom exposes alert/confirm placeholders that only print
    // "Not implemented", so replace them even when the properties exist.
    Object.defineProperty(window, 'confirm', { value: vi.fn(() => true), writable: true, configurable: true });
    Object.defineProperty(window, 'alert', { value: vi.fn(), writable: true, configurable: true });
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
        vi.mocked(downloadTextFile).mockClear();
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

    it('coalesces concurrent open() calls into one editor session', async () => {
        seedOriginalMarkdown('# hello');
        const mgr = new EditorManager('docs/test.md');

        await Promise.all([
            mgr.open(),
            mgr.open({ line: 1 }),
        ]);

        expect(document.querySelectorAll('.editor-modal')).toHaveLength(1);
        expect(document.querySelectorAll('.cm-editor')).toHaveLength(1);
        expect(mgr.isOpen()).toBe(true);
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

    it('keeps edits made during save dirty and coalesces concurrent saves', async () => {
        seedOriginalMarkdown('# initial');
        let resolveSave!: (response: {
            ok: boolean;
            status: number;
            text: () => Promise<string>;
            json: () => Promise<{ success: boolean }>;
        }) => void;
        const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
            if (url === '/api/save') {
                return new Promise(resolve => {
                    resolveSave = resolve;
                });
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                text: async () => '',
                json: async () => ({ html: '' }),
            });
        }) as unknown as typeof fetch;
        vi.stubGlobal('fetch', fetchMock);

        const mgr = new EditorManager('docs/test.md');
        await mgr.open();
        const view = getEditorView();
        replaceDocument(view, '# sent');

        const firstSave = mgr.save();
        const duplicateSave = mgr.save();

        replaceDocument(view, '# typed while saving');
        resolveSave({
            ok: true,
            status: 200,
            text: async () => '',
            json: async () => ({ success: true }),
        });
        await Promise.all([firstSave, duplicateSave]);

        const saveCalls = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
            (call: unknown[]) => call[0] === '/api/save',
        );
        expect(saveCalls).toHaveLength(1);
        expect(JSON.parse((itemAt(saveCalls, 0)[1] as RequestInit).body as string).content)
            .toBe('# sent');
        expect(view.state.doc.toString()).toBe('# typed while saving');
        expect(mgr.isDirty()).toBe(true);
        expect(document.querySelector<HTMLElement>('.editor-save-btn')?.style.display).toBe('block');
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
        {
            label: 'an ordered marker beyond Number.MAX_SAFE_INTEGER',
            source: '9007199254740992. # heading',
            cursor: 18,
            expected: '9007199254740992. \n9007199254740993. # heading',
            caret: 37,
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

    it('resets the narrow-screen tab to Edit when an export editor reopens', async () => {
        Object.defineProperty(window, 'innerWidth', { value: 600, configurable: true, writable: true });
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            status: 200,
            text: async () => '',
            json: async () => ({ html: '' }),
        })));
        const mgr = new EditorManager('a.md');

        await mgr.open({ mode: 'export', content: 'first' });
        document.querySelector<HTMLButtonElement>('.editor-tab-preview')?.click();
        expect(document.querySelector('.editor-tab-preview')?.classList.contains('active')).toBe(true);
        mgr.close();

        await mgr.open({ mode: 'export', content: 'second' });
        expect(document.querySelector('.editor-tab-edit')?.classList.contains('active')).toBe(true);
        expect(document.querySelector<HTMLElement>('.editor-pane-source')?.style.display).toBe('flex');
        expect(document.querySelector<HTMLElement>('.editor-pane-preview')?.style.display).toBe('none');
        mgr.close();
    });

    it('puts the function title in the header and the filename inside the copyable export buffer', async () => {
        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            text: async () => '',
            json: async () => ({ html: '' }),
        })) as unknown as typeof fetch;
        vi.stubGlobal('fetch', fetchMock);
        const writeText = vi.fn(async () => {});
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText },
            configurable: true,
        });

        const mgr = new EditorManager('a.md');
        await mgr.open({
            mode: 'export',
            exportFileName: 'Project charter',
            content: '"quoted"\n> note\n',
        });

        expect(document.querySelector('.editor-file-name')?.textContent).toBe('web.export.label');
        expect(getEditorView().state.doc.toString())
            .toBe('Project-charter.md\n\n"quoted"\n> note\n');

        document.querySelector<HTMLButtonElement>('.editor-copy-btn')?.click();
        await vi.waitFor(() => {
            expect(writeText).toHaveBeenCalledWith(
                'Project-charter.md\n\n"quoted"\n> note\n',
            );
        });

        await vi.waitFor(() => {
            const previewCalls = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls
                .filter((call: unknown[]) => call[0] === '/api/preview');
            const previewContents = previewCalls.map((call: unknown[]) => {
                const init = call[1] as RequestInit;
                return JSON.parse(init.body as string).content as string;
            });
            expect(previewContents).toContain('"quoted"\n> note\n');
        });
        mgr.close();
    });

    it('downloads the body under the filename edited on the first line', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            status: 200,
            text: async () => '',
            json: async () => ({ html: '' }),
        })));
        const mgr = new EditorManager('a.md');
        await mgr.open({ mode: 'export', exportFileName: 'notes', content: 'old body' });
        replaceDocument(getEditorView(), 'Renamed export.md\n\nnew body\n');

        await mgr.save();

        expect(downloadTextFile).toHaveBeenCalledWith('Renamed-export.md', 'new body\n');
        mgr.close();
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

    it('ignores a stale preview response that arrives after a newer render', async () => {
        seedOriginalMarkdown('preview-old-session');
        const pending: Array<{
            content: string;
            resolve: (response: {
                ok: boolean;
                status: number;
                json: () => Promise<{ html: string }>;
            }) => void;
        }> = [];
        const fetchMock = vi.fn((url: string, init?: RequestInit) => {
            if (url !== '/api/preview') {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: async () => ({ success: true }),
                });
            }
            const content = JSON.parse(init?.body as string).content as string;
            return new Promise(resolve => {
                pending.push({ content, resolve });
            });
        }) as unknown as typeof fetch;
        vi.stubGlobal('fetch', fetchMock);

        const mgr = new EditorManager('a.md');
        await mgr.open();
        await vi.waitFor(() => {
            expect(pending.filter(request => request.content.startsWith('preview-'))).toHaveLength(1);
        });

        replaceDocument(getEditorView(), 'preview-new-session');
        await vi.waitFor(() => {
            expect(pending.filter(request => request.content.startsWith('preview-'))).toHaveLength(2);
        });
        const sessionRequests = pending.filter(request => request.content.startsWith('preview-'));
        const newest = itemAt(sessionRequests, 1);
        expect(newest.content).toBe('preview-new-session');
        newest.resolve({
            ok: true,
            status: 200,
            json: async () => ({ html: '<p id="new-preview">new</p>' }),
        });
        await vi.waitFor(() => {
            expect(document.querySelector('#new-preview')?.textContent).toBe('new');
        });

        const stale = itemAt(sessionRequests, 0);
        stale.resolve({
            ok: true,
            status: 200,
            json: async () => ({ html: '<p id="old-preview">old</p>' }),
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(document.querySelector('#new-preview')?.textContent).toBe('new');
        expect(document.querySelector('#old-preview')).toBeNull();
    });
});
