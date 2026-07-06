import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceSpotlight } from './workspace-spotlight';

const files = [
    { path: 'README.md', name: 'README.md', url: '/ws/README.md', is_markdown: true },
    { path: 'docs/Guide.md', name: 'Guide.md', url: '/ws/docs/Guide.md', is_markdown: true },
    { path: 'Cargo.toml', name: 'Cargo.toml', url: '/ws/Cargo.toml', is_markdown: false },
];

const contentResults = [
    {
        title: 'Guide',
        file_path: 'docs/Guide.md',
        snippet: 'A <b>guide</b> to the workspace',
    },
];

async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
}

describe('WorkspaceSpotlight', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        window.history.replaceState(null, '', '/ws/docs/Guide.md');
        vi.stubGlobal('fetch', vi.fn((url: string) => {
            if (url.startsWith('/_/ws/search')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve(contentResults),
                });
            }
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve(files),
            });
        }));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        document.body.innerHTML = '';
    });

    it('opens a Spotlight-style document list backed by the workspace file endpoint', async () => {
        const nav = new WorkspaceSpotlight({ workspaceId: 'ws' });
        nav.open();
        await flush();

        expect(fetch).toHaveBeenCalledWith('/_/ws/files/data', { credentials: 'same-origin' });
        expect(document.querySelector('.workspace-spotlight-overlay.is-open')).not.toBeNull();

        const text = document.body.textContent || '';
        expect(text).toContain('README.md');
        expect(text).toContain('docs/Guide.md');
        expect(text).not.toContain('Cargo.toml');
    });

    it('filters results and marks the current document', async () => {
        const nav = new WorkspaceSpotlight({ workspaceId: 'ws' });
        nav.open();
        await flush();

        const input = document.querySelector<HTMLInputElement>('.workspace-spotlight-input')!;
        input.value = 'guide';
        input.dispatchEvent(new Event('input', { bubbles: true }));

        expect(document.body.textContent).toContain('docs/Guide.md');
        expect(document.body.textContent).not.toContain('README.md');
        expect(document.querySelector('.workspace-spotlight-result.is-current')).not.toBeNull();
    });

    it('merges file-name matches and content matches in the same Spotlight panel', async () => {
        const nav = new WorkspaceSpotlight({ workspaceId: 'ws', enableContentSearch: true });
        nav.open();
        await flush();

        const input = document.querySelector<HTMLInputElement>('.workspace-spotlight-input')!;
        input.value = 'guide';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 150));
        await flush();

        expect(fetch).toHaveBeenCalledWith('/_/ws/search?q=guide', { credentials: 'same-origin' });
        const text = document.body.textContent || '';
        expect(text).toContain('web.wsnav.files');
        expect(text).toContain('web.wsnav.contents');
        expect(text).toContain('docs/Guide.md');
        expect(document.querySelector('.workspace-spotlight-result--content')?.innerHTML).toContain('<b>guide</b>');
    });

    it('closes from Escape inside the navigator input', async () => {
        const nav = new WorkspaceSpotlight({ workspaceId: 'ws' });
        nav.open();
        await flush();

        const input = document.querySelector<HTMLInputElement>('.workspace-spotlight-input')!;
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

        expect(nav.isOpen()).toBe(false);
    });

    it('contains wheel scrolling inside the Spotlight panel', async () => {
        const nav = new WorkspaceSpotlight({ workspaceId: 'ws' });
        nav.open();
        await flush();

        const input = document.querySelector<HTMLInputElement>('.workspace-spotlight-input')!;
        const results = document.querySelector<HTMLElement>('.workspace-spotlight-results')!;
        Object.defineProperty(results, 'clientHeight', { value: 100, configurable: true });
        Object.defineProperty(results, 'scrollHeight', { value: 300, configurable: true });

        results.scrollTop = 200;
        const bottomWheel = new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true });
        expect(results.dispatchEvent(bottomWheel)).toBe(false);
        expect(bottomWheel.defaultPrevented).toBe(true);

        results.scrollTop = 80;
        const middleWheel = new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true });
        expect(results.dispatchEvent(middleWheel)).toBe(true);
        expect(middleWheel.defaultPrevented).toBe(false);

        results.scrollTop = 0;
        const headerWheel = new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true });
        expect(input.dispatchEvent(headerWheel)).toBe(false);
        expect(headerWheel.defaultPrevented).toBe(true);
        expect(results.scrollTop).toBe(40);
    });
});
