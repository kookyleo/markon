/**
 * Keyboard shortcuts for the compare / diff page.
 *
 * The diff page does NOT boot MarkonApp, so it wires its own
 * {@link KeyboardShortcutsManager}: the GLOBAL shortcuts every page shares
 * (Help `?`, Theme `t`) plus the diff-specific ones (toggle Raw⇄Rendered,
 * next/previous file). Because the help panel renders from the manager's live
 * registered set, pressing `?` here shows exactly this page's shortcuts.
 */

import { KeyboardShortcutsManager } from './managers/keyboard-shortcuts';

const currentView = (shell: HTMLElement): 'rendered' | 'raw' =>
    shell.getAttribute('data-current-diff-view') === 'rendered' ? 'rendered' : 'raw';

/** Switch Raw⇄Rendered by clicking the other segment button (reusing all of the
 *  page's existing view-activation + preference-persistence logic). */
const toggleView = (shell: HTMLElement): void => {
    const next = currentView(shell) === 'rendered' ? 'raw' : 'rendered';
    document.querySelector<HTMLElement>(`[data-diff-view-seg] [data-view="${next}"]`)?.click();
};

/** Sidebar file buttons currently visible (respecting the filter). */
const visibleFileButtons = (): HTMLElement[] =>
    [...document.querySelectorAll<HTMLElement>('[data-diff-scroll-path]')].filter((button) => {
        const entry = button.closest<HTMLElement>('[data-diff-nav-entry]');
        return !entry || entry.style.display !== 'none';
    });

/** Jump to the next/previous changed file (dir = +1 / -1). Anchors on the
 *  currently-selected file, else the file at the top of the viewport. */
const cycleFile = (shell: HTMLElement, dir: 1 | -1): void => {
    const buttons = visibleFileButtons();
    if (!buttons.length) return;

    let index = buttons.findIndex((b) => b.classList.contains('is-active'));
    if (index < 0) {
        const api = currentView(shell) === 'rendered' ? window.markonMarkdownDiff : window.markonSourceDiff;
        const topPath = api?.topAnchor?.()?.path ?? null;
        index = topPath ? buttons.findIndex((b) => b.getAttribute('data-diff-scroll-path') === topPath) : -1;
    }

    const target =
        index < 0
            ? dir > 0
                ? buttons[0]
                : buttons[buttons.length - 1]
            : buttons[Math.min(buttons.length - 1, Math.max(0, index + dir))];
    target?.click();
};

// ── Step through individual changes (Rendered view) ─────────────────────────
const CHANGE_SELECTOR =
    '.md-diff-block.is-modified, .md-diff-block.is-added, .md-diff-block.is-deleted';

/** Move focus to the next/previous changed block in the Rendered view, scroll it
 *  under the sticky header, and mark it `.is-focused` (a left accent rail). Only
 *  visible blocks count, so viewed-hidden sections are skipped. */
const stepChange = (dir: 1 | -1): void => {
    const panel = document.querySelector<HTMLElement>('[data-diff-view-panel="rendered"]');
    if (!panel) return;
    const blocks = [...panel.querySelectorAll<HTMLElement>(CHANGE_SELECTOR)].filter(
        (b) => b.offsetParent !== null,
    );
    if (!blocks.length) return;

    let index = blocks.findIndex((b) => b.classList.contains('is-focused'));
    let next: HTMLElement | undefined;
    if (index >= 0) {
        next = blocks[index + dir];
    } else {
        // No current focus: pick the first change just past the sticky header
        // (going down) or just above it (going up).
        const line = panel.getBoundingClientRect().top + 56;
        if (dir > 0) {
            next = blocks.find((b) => b.getBoundingClientRect().top > line + 4) || blocks[0];
        } else {
            const above = blocks.filter((b) => b.getBoundingClientRect().top < line - 4);
            next = above[above.length - 1] || blocks[blocks.length - 1];
        }
    }
    if (!next) {
        // Boundary of the currently-rendered range — nudge the scroll so the
        // next section virtualizes in; the following press continues from there.
        panel.scrollBy({ top: dir * panel.clientHeight * 0.85, behavior: 'smooth' });
        return;
    }
    blocks.forEach((b) => b.classList.remove('is-focused'));
    next.classList.add('is-focused');
    const header = next.closest('.md-diff-file-section')?.querySelector<HTMLElement>('.md-diff-file-header');
    const offset = (header?.offsetHeight || 44) + 10;
    const y = next.getBoundingClientRect().top - panel.getBoundingClientRect().top - offset + panel.scrollTop;
    panel.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
};

const init = (): void => {
    const shell = document.querySelector<HTMLElement>('[data-diff-shell]');
    if (!shell) return;

    const km = new KeyboardShortcutsManager();
    // Global (every page).
    km.register('HELP', () => km.showHelp());
    km.register('THEME_PANEL', () => window.MarkonTheme?.togglePanel());
    // Diff-specific. j/k step through individual changes in the Rendered view;
    // in Raw they fall back to next/previous file.
    const step = (dir: 1 | -1): void =>
        currentView(shell) === 'rendered' ? stepChange(dir) : cycleFile(shell, dir);
    km.register('DIFF_TOGGLE_VIEW', () => toggleView(shell));
    km.register('DIFF_NEXT_FILE', () => step(1));
    km.register('DIFF_PREV_FILE', () => step(-1));

    document.addEventListener('keydown', (e) => km.handle(e));
    window.shortcutsManager = km;
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}
