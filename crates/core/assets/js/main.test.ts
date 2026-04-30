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

describe('MarkonApp', () => {
    let restore: () => void;

    beforeEach(() => {
        document.body.innerHTML = '';
        document.head.innerHTML = '';
        localStorage.clear();
        ({ restore } = silenceLogs());
        // Wipe globals between tests.
        delete (window as { markonApp?: unknown }).markonApp;
        delete (window as { searchManager?: unknown }).searchManager;
        delete (window as { editorManager?: unknown }).editorManager;
        delete (window as { chatManager?: unknown }).chatManager;
    });

    afterEach(() => {
        restore();
        vi.restoreAllMocks();
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
        expect(m.undoManager).not.toBeNull();
        expect(m.tocNavigator).not.toBeNull();
        expect(m.annotationNavigator).not.toBeNull();
        expect(m.storage).not.toBeNull();
        // No WS manager unless shared / live is enabled.
        expect(m.wsManager).toBeNull();
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
});
