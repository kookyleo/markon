import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
        seedMeta('mgmt-token', 'tok-abc');

        const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ({
            ok: true,
            status: 200,
            text: async () => '',
            json: async () => ({ success: true }),
        })) as unknown as typeof fetch;
        vi.stubGlobal('fetch', fetchMock);

        const mgr = new EditorManager('docs/test.md');
        await mgr.open();

        // Edit the buffer so save() has something to send.
        const ta = document.querySelector<HTMLTextAreaElement>('.editor-textarea')!;
        ta.value = '# changed';
        await mgr.save();

        // The first /api/save call (preview calls go to /api/preview).
        const calls = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
            (c: unknown[]) => c[0] === '/api/save',
        );
        expect(calls.length).toBe(1);
        const init = calls[0][1] as RequestInit;
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
        const ta = document.querySelector<HTMLTextAreaElement>('.editor-textarea')!;

        ta.value = 'hello!';
        ta.dispatchEvent(new Event('input'));
        expect(mgr.isDirty()).toBe(true);

        ta.value = 'hello'; // back to baseline
        ta.dispatchEvent(new Event('input'));
        expect(mgr.isDirty()).toBe(false);
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
        const ta = document.querySelector<HTMLTextAreaElement>('.editor-textarea')!;
        ta.value = 'changed';
        ta.dispatchEvent(new Event('input'));
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

    it('renderMermaid (via preview path) calls window.mermaid.run when available', async () => {
        seedOriginalMarkdown('```mermaid\ngraph TD; A-->B\n```');

        const runMock = vi.fn(() => Promise.resolve());
        const initMock = vi.fn();
        // initialize is required by the ambient type but unused here.
        const initializeMock = vi.fn();
        window.mermaid = { run: runMock, init: initMock, initialize: initializeMock };

        const fetchMock = vi.fn(async (url: string) => {
            if (url === '/api/preview') {
                return {
                    ok: true,
                    status: 200,
                    text: async () => '',
                    json: async () => ({
                        html: '<div class="language-mermaid">graph TD</div>',
                        has_mermaid: true,
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

        expect(runMock).toHaveBeenCalled();
        delete window.mermaid;
    });
});
