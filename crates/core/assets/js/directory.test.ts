import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const flagKeys = [
    'enable_edit',
    'enable_chat',
    'enable_live',
    'shared_annotation',
];

describe('workspace feature controls', () => {
    const originalLocation = Object.getOwnPropertyDescriptor(window, 'location');
    const reload = vi.fn();
    const fetchMock = vi.fn<typeof fetch>();

    beforeEach(() => {
        vi.resetModules();
        reload.mockReset();
        fetchMock.mockReset();
        vi.stubGlobal('fetch', fetchMock);
        vi.spyOn(window, 'alert').mockImplementation(() => {});
        Object.defineProperty(window, 'location', {
            configurable: true,
            value: { ...window.location, reload },
        });
        document.body.innerHTML = `
            <div data-workspace-feature-form data-can-edit="true"
                 data-update-url="/_/ws/settings/features">
                ${flagKeys.map((key, index) => `
                    <label class="workspace-feature-switch">
                        <input type="checkbox" data-feature-key="${key}" ${index === 0 ? 'checked' : ''}>
                    </label>
                `).join('')}
            </div>`;
    });

    afterEach(() => {
        document.body.innerHTML = '';
        if (originalLocation) Object.defineProperty(window, 'location', originalLocation);
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    const inputs = (): HTMLInputElement[] =>
        Array.from(document.querySelectorAll<HTMLInputElement>('input[data-feature-key]'));

    it.each(flagKeys)('refreshes page capabilities after changing %s', async (key) => {
        let finishRequest!: (response: Response) => void;
        fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finishRequest = resolve; }));
        await import('./directory');

        const input = document.querySelector<HTMLInputElement>(`[data-feature-key="${key}"]`)!;
        input.checked = !input.checked;
        input.dispatchEvent(new Event('change', { bubbles: true }));

        expect(fetchMock).toHaveBeenCalledWith('/_/ws/settings/features', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.fromEntries(inputs().map((item) => [item.dataset['featureKey'], item.checked]))),
        });
        expect(inputs().every((item) => item.disabled)).toBe(true);
        expect(reload).not.toHaveBeenCalled();

        finishRequest(new Response(JSON.stringify({ success: true }), { status: 200 }));
        await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
        // Keep updates locked until navigation has installed the new flags.
        expect(inputs().every((item) => item.disabled)).toBe(true);
        expect(window.alert).not.toHaveBeenCalled();
    });

    it.each([
        new Response(JSON.stringify({ success: false, message: 'Save rejected' }), { status: 200 }),
        new Response('Save rejected', { status: 500 }),
    ])('restores the previous flag and allows retry after a rejected save', async (response) => {
        fetchMock.mockResolvedValueOnce(response);
        await import('./directory');
        const input = document.querySelector<HTMLInputElement>('[data-feature-key="enable_chat"]')!;
        input.checked = true;
        input.dispatchEvent(new Event('change', { bubbles: true }));

        await vi.waitFor(() => expect(window.alert).toHaveBeenCalledOnce());
        expect(reload).not.toHaveBeenCalled();
        expect(input.checked).toBe(false);
        expect(input.closest('.workspace-feature-switch')?.classList.contains('is-on')).toBe(false);
        expect(inputs().every((item) => !item.disabled)).toBe(true);
    });

    it('leaves collaborator feature controls read-only', async () => {
        document.querySelector('[data-workspace-feature-form]')!.setAttribute('data-can-edit', 'false');
        inputs().forEach((input) => { input.disabled = true; });
        await import('./directory');
        inputs()[0]!.dispatchEvent(new Event('change', { bubbles: true }));

        expect(fetchMock).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
        expect(inputs().every((item) => item.disabled)).toBe(true);
    });

    it('does not send or wire legacy Search and Progress controls from stale markup', async () => {
        const form = document.querySelector('[data-workspace-feature-form]')!;
        form.insertAdjacentHTML('beforeend', '<input type="checkbox" data-feature-key="enable_search"><input type="checkbox" data-feature-key="enable_viewed">');
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
        await import('./directory');
        form.querySelector('[data-feature-key="enable_viewed"]')!.dispatchEvent(new Event('change', { bubbles: true }));
        expect(fetchMock).not.toHaveBeenCalled();

        const edit = form.querySelector<HTMLInputElement>('[data-feature-key="enable_edit"]')!;
        edit.checked = false;
        edit.dispatchEvent(new Event('change', { bubbles: true }));
        await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
        const options = fetchMock.mock.calls[0]?.[1];
        expect(JSON.parse(String(options?.body))).toEqual({
            enable_edit: false, enable_chat: false, enable_live: false, shared_annotation: false,
        });
    });
});
