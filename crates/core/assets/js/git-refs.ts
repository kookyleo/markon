/**
 * Git refs page (branches / tags): apply i18n labels, drive the client-side
 * branch search filter, and copy branch/tag names to the clipboard.
 *
 * Read-only view — no write actions. Classic (IIFE) bundle, loaded as a
 * non-module `<script>` after i18n-boot.
 */

const t: (key: string) => string = (window.__MARKON_I18N__ && window.__MARKON_I18N__.t) || ((k: string) => k);

// Visible text.
document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n') || '');
});
// Attribute-only labels (placeholder / title / aria-label).
document.querySelectorAll<HTMLElement>('[data-i18n-placeholder]').forEach((el) => {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder') || ''));
});
document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
    el.setAttribute('title', t(el.getAttribute('data-i18n-title') || ''));
});
document.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((el) => {
    el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria') || ''));
});

// ── Branch search: hide rows whose name doesn't match; hide a group whose rows
//    are all filtered out. ─────────────────────────────────────────────────────
const search = document.getElementById('refs-branch-search') as HTMLInputElement | null;
if (search) {
    const rows = Array.prototype.slice.call(
        document.querySelectorAll<HTMLElement>('[data-branch-row]'),
    ) as HTMLElement[];
    const groups = Array.prototype.slice.call(
        document.querySelectorAll<HTMLElement>('[data-branch-group]'),
    ) as HTMLElement[];

    const applyFilter = (): void => {
        const q = search.value.trim().toLowerCase();
        rows.forEach((row) => {
            const name = (row.getAttribute('data-branch-name') || '').toLowerCase();
            row.style.display = !q || name.indexOf(q) !== -1 ? '' : 'none';
        });
        // A group with no visible rows (its box-head is not a row) collapses.
        groups.forEach((group) => {
            const groupRows = Array.prototype.slice.call(
                group.querySelectorAll<HTMLElement>('[data-branch-row]'),
            ) as HTMLElement[];
            const anyVisible = groupRows.some((row) => row.style.display !== 'none');
            group.style.display = anyVisible ? '' : 'none';
        });
    };
    search.addEventListener('input', applyFilter);
}

// ── Copy branch / tag name to the clipboard; briefly flag success. ────────────
function flash(button: HTMLElement): void {
    button.classList.add('is-copied');
    setTimeout(() => button.classList.remove('is-copied'), 1200);
}
document.querySelectorAll<HTMLElement>('[data-copy]').forEach((button) => {
    button.addEventListener('click', () => {
        const text = button.getAttribute('data-copy') || '';
        if (!text) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => flash(button), () => {});
        } else {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try {
                document.execCommand('copy');
                flash(button);
            } catch (e) {
                /* clipboard unavailable — leave silently */
            }
            document.body.removeChild(ta);
        }
    });
});

export {};
