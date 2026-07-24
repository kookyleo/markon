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

async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
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
