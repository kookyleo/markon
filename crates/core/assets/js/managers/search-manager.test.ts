import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchManager, type SearchResultPayload } from './search-manager';

/**
 * Build the markup that SearchManager expects in layout.html and a
 * <meta name="workspace-id"> tag so #getWorkspaceId() resolves.
 */
function setupDom(workspaceId = 'ws1'): {
    modal: HTMLElement;
    input: HTMLInputElement;
    results: HTMLElement;
} {
    document.body.innerHTML = '';
    document.head.innerHTML = '';

    const meta = document.createElement('meta');
    meta.setAttribute('name', 'workspace-id');
    meta.setAttribute('content', workspaceId);
    document.head.appendChild(meta);

    const modal = document.createElement('div');
    modal.id = 'search-modal';
    const input = document.createElement('input');
    input.id = 'search-input';
    const results = document.createElement('ul');
    results.id = 'search-results';
    modal.append(input, results);
    document.body.appendChild(modal);

    return { modal, input, results };
}

/**
 * Stub global.fetch and resolve with `payload` parsed as JSON.
 */
function stubFetch(payload: unknown): ReturnType<typeof vi.fn> {
    const fn = vi.fn(async () => ({
        json: async () => payload,
    } as unknown as Response));
    (globalThis as { fetch: unknown }).fetch = fn;
    return fn;
}

/** Wait for a microtask flush — for promises chained inside the input handler. */
async function flush(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
}

describe('SearchManager', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        logSpy.mockRestore();
        errorSpy.mockRestore();
        document.body.innerHTML = '';
        document.head.innerHTML = '';
    });

    it('show() / hide() toggle modal display and clear input', () => {
        const { modal, input } = setupDom();
        const m = new SearchManager();
        input.value = 'leftover';
        m.show();
        expect(modal.style.display).toBe('block');
        expect(input.value).toBe('');

        m.hide();
        expect(modal.style.display).toBe('none');
    });

    it('toggle() flips visibility', () => {
        const { modal } = setupDom();
        const m = new SearchManager();
        m.toggle();
        expect(modal.style.display).toBe('block');
        m.toggle();
        expect(modal.style.display).toBe('none');
    });

    it('typing >= 2 chars triggers fetch and renders results', async () => {
        const { input, results } = setupDom('myws');
        const payload: SearchResultPayload[] = [
            { title: 'Hello', file_path: 'docs/a.md', snippet: '...hello world...' },
            { title: 'World', file_path: 'docs/b.md', snippet: '...the world is...' },
        ];
        const fetchStub = stubFetch(payload);
        const m = new SearchManager();
        m.show();

        input.value = 'he';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await flush();

        expect(fetchStub).toHaveBeenCalledTimes(1);
        const url = String(fetchStub.mock.calls[0][0]);
        expect(url).toContain('/search?ws=myws');
        expect(url).toContain('q=he');

        const items = results.querySelectorAll('.search-result-item');
        expect(items.length).toBe(2);
        expect(items[0].querySelector('.search-result-title')?.textContent).toBe('Hello');
        expect(items[1].querySelector('.search-result-path')?.textContent).toBe('docs/b.md');
    });

    it('query shorter than 2 chars clears results and skips fetch', async () => {
        const { input, results } = setupDom();
        const fetchStub = stubFetch([]);
        const m = new SearchManager();
        m.show();

        // First populate something to ensure the clear path actually fires.
        results.innerHTML = '<li class="search-result-item">stale</li>';

        input.value = 'a';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await flush();

        expect(fetchStub).not.toHaveBeenCalled();
        expect(results.innerHTML).toBe('');
    });

    it('empty result set renders the no-result message', async () => {
        const { input, results } = setupDom();
        stubFetch([]);
        const m = new SearchManager();
        m.show();

        input.value = 'zz';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await flush();

        const noResult = results.querySelector('.no-results');
        expect(noResult).not.toBeNull();
    });

    it('fetch failure is logged and does not throw', async () => {
        const { input } = setupDom();
        (globalThis as { fetch: unknown }).fetch = vi.fn(async () => {
            throw new Error('network down');
        });
        const m = new SearchManager();
        m.show();

        input.value = 'oops';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await flush();

        expect(errorSpy).toHaveBeenCalled();
        // The first arg is the prefixed `[SearchManager]` tag.
        expect(String(errorSpy.mock.calls.at(-1)?.[0] ?? '')).toContain('SearchManager');
    });

    it('Escape on document hides the modal when visible', () => {
        const { modal } = setupDom();
        const m = new SearchManager();
        m.show();
        expect(modal.style.display).toBe('block');

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(modal.style.display).toBe('none');
    });
});
