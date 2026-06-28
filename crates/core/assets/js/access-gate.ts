/**
 * Access-gate (code prompt) page controls: i18n labels, the error message, and
 * the press-and-hold "eye" that reveals the code while held.
 *
 * Classic (IIFE) bundle, loaded as a non-module `<script>` after i18n-boot.
 */

const t: (key: string) => string = (window.__MARKON_I18N__ && window.__MARKON_I18N__.t) || ((k: string) => k);

document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n') || '');
});
document.querySelectorAll<HTMLInputElement>('[data-i18n-ph]').forEach((el) => {
    el.placeholder = t(el.getAttribute('data-i18n-ph') || '');
});

const gate = document.querySelector<HTMLElement>('.gate');
const err = document.getElementById('err');
if (gate && err) {
    const e = gate.getAttribute('data-error');
    if (e === 'wrong') err.textContent = t('access.err.wrong');
    else if (e === 'cooldown') err.textContent = t('access.err.cooldown').replace('{n}', gate.getAttribute('data-cooldown') || '');
}

// Press-and-hold the eye to reveal the code; release re-masks it.
const input = gate?.querySelector<HTMLInputElement>('input[name=code]');
const peek = gate?.querySelector<HTMLElement>('.peek');
if (peek && input) {
    peek.setAttribute('aria-label', t('access.peek'));
    peek.setAttribute('title', t('access.peek'));
    const reveal = (ev?: Event): void => { if (ev) ev.preventDefault(); input.type = 'text'; };
    const mask = (): void => { input.type = 'password'; };
    peek.addEventListener('mousedown', reveal);
    peek.addEventListener('touchstart', reveal, { passive: false });
    peek.addEventListener('mouseleave', mask);
    (['mouseup', 'touchend', 'touchcancel'] as const).forEach((evt) => peek.addEventListener(evt, mask));
    window.addEventListener('mouseup', mask);
}

export {};
