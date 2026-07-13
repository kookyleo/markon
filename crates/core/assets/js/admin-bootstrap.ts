/** Redeem a one-time native bootstrap capability for an HttpOnly admin session. */

const t: (key: string) => string = window.__MARKON_I18N__?.t || ((key: string) => key);

document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((element) => {
    element.textContent = t(element.dataset['i18n'] || '');
});
document.querySelectorAll<HTMLInputElement>('[data-i18n-ph]').forEach((element) => {
    element.placeholder = t(element.dataset['i18nPh'] || '');
});

const form = document.querySelector<HTMLFormElement>('#admin-code-form');
const input = document.querySelector<HTMLInputElement>('#admin-code');
const status = document.querySelector<HTMLElement>('#admin-status');

function showStatus(message: string, error = false): void {
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('is-error', error);
}

async function exchange(body: { nonce?: string; code?: string }): Promise<void> {
    showStatus(t('admin.exchanging'));
    const response = await fetch('/_/admin/session', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`exchange failed: ${response.status}`);
    const result = await response.json() as { redirect?: string };
    window.location.replace(result.redirect || '/');
}

const fragment = new URLSearchParams(window.location.hash.slice(1));
const nonce = fragment.get('nonce');
// The fragment never reaches HTTP, but remove it before any asynchronous work
// so screenshots, copied URLs, and browser history do not retain the secret.
if (window.location.hash) {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
}

if (nonce) {
    form?.setAttribute('hidden', '');
    void exchange({ nonce }).catch(() => {
        form?.removeAttribute('hidden');
        showStatus(t('admin.err.invalid'), true);
        input?.focus();
    });
}

form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const code = input?.value.trim() || '';
    if (!code) return;
    const button = form.querySelector<HTMLButtonElement>('button[type=submit]');
    if (button) button.disabled = true;
    void exchange({ code }).catch(() => {
        if (button) button.disabled = false;
        showStatus(t('admin.err.invalid'), true);
        input?.select();
    });
});

export {};
