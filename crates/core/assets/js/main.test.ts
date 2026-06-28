import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MarkonApp } from './main';

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
        document.body.innerHTML = '';
        document.head.innerHTML = '';
        localStorage.clear();
        MockWS.instances = [];
        ({ restore } = silenceLogs());
        // Wipe globals between tests.
        delete (window as { markonApp?: unknown }).markonApp;
        delete (window as { searchManager?: unknown }).searchManager;
        delete (window as { editorManager?: unknown }).editorManager;
        delete (window as { chatManager?: unknown }).chatManager;
        delete (window as { visualZoomManager?: unknown }).visualZoomManager;
        delete (window as { __MARKON_I18N__?: unknown }).__MARKON_I18N__;
    });

    afterEach(() => {
        restore();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('directory mode (no .markdown-body) only initializes the keyboard layer', async () => {
        const app = new MarkonApp({ filePath: 'docs/' });
        await app.init();

        const m = app.getManagers();
        expect(m.shortcutsManager).not.toBeNull();
        // Document-mode managers should remain null.
        expect(m.annotationManager).toBeNull();
        expect(m.noteManager).toBeNull();
        expect(m.popoverManager).toBeNull();
        expect(m.visualZoomManager).toBeNull();
        expect(m.tocNavigator).toBeNull();
        expect(m.annotationNavigator).toBeNull();
        expect(m.storage).toBeNull();
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

    it('enableSearch=false leaves searchManager null and skips window mount', async () => {
        seedMarkdownBody();
        const app = new MarkonApp({ filePath: 'docs/x.md', enableSearch: false });
        await app.init();

        expect(app.getManagers().searchManager).toBeNull();
        expect(window.searchManager).toBeUndefined();
    });

    it('enableSearch=true creates SearchManager and mounts on window', async () => {
        seedMarkdownBody();
        const app = new MarkonApp({ filePath: 'docs/x.md', enableSearch: true });
        await app.init();

        expect(app.getManagers().searchManager).not.toBeNull();
        expect(window.searchManager).toBeDefined();
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
        const ws = MockWS.instances[0];

        ws.dispatchMessage({ type: 'file_changed', workspace_id: 'other', path: 'spec.md' });
        expect(reload).not.toHaveBeenCalled();
        ws.dispatchMessage({ type: 'file_changed', workspace_id: 'ws1', path: 'spec.md' });
        expect(reload).toHaveBeenCalledOnce();

        app.getManagers().wsManager?.disconnect();
    });
});
