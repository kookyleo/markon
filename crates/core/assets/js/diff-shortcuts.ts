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

const init = (): void => {
    const shell = document.querySelector<HTMLElement>('[data-diff-shell]');
    if (!shell) return;

    const km = new KeyboardShortcutsManager();
    // Global (every page).
    km.register('HELP', () => km.showHelp());
    km.register('THEME_PANEL', () => window.MarkonTheme?.togglePanel());
    // Diff-specific.
    km.register('DIFF_TOGGLE_VIEW', () => toggleView(shell));
    km.register('DIFF_NEXT_FILE', () => cycleFile(shell, 1));
    km.register('DIFF_PREV_FILE', () => cycleFile(shell, -1));

    document.addEventListener('keydown', (e) => km.handle(e));
    window.shortcutsManager = km;
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}
