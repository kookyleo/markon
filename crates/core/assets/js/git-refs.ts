/**
 * Git refs page: apply i18n labels to `[data-i18n]` elements.
 *
 * Classic (IIFE) bundle, loaded as a non-module `<script>` after i18n-boot.
 */

const t: (key: string) => string = (window.__MARKON_I18N__ && window.__MARKON_I18N__.t) || ((k: string) => k);

document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n') || '');
});

export {};
