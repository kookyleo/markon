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

// ── Step through individual changed blocks (BOTH views) ─────────────────────
// Both views mark their changed-block wrappers with the shared `diff-change-block`
// class and their scroll container with `data-diff-scroller`, so this one stepper
// works for Raw and Rendered alike — only the surface DOM differs, not the logic.
const CHANGE_SELECTOR =
    '.diff-change-block.is-modified, .diff-change-block.is-added, .diff-change-block.is-deleted';

/** The active view panel and the element that actually scrolls inside it. */
const activeScroller = (shell: HTMLElement): { panel: HTMLElement; scroller: HTMLElement } | null => {
    const view = currentView(shell);
    const panel = document.querySelector<HTMLElement>(`[data-diff-view-panel="${view}"]`);
    if (!panel || panel.hidden) return null;
    const scroller = panel.matches('[data-diff-scroller]')
        ? panel
        : panel.querySelector<HTMLElement>('[data-diff-scroller]') || panel;
    return { panel, scroller };
};

/** Move focus to the next/previous changed block in the active view, scroll it
 *  under the sticky header, and mark it `.is-focused` (a left accent rail). Only
 *  visible blocks count, so viewed-hidden sections are skipped. */
const stepBlock = (shell: HTMLElement, dir: 1 | -1): void => {
    const ctx = activeScroller(shell);
    if (!ctx) return;
    const { panel, scroller } = ctx;
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
        const line = scroller.getBoundingClientRect().top + 56;
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
        scroller.scrollBy({ top: dir * scroller.clientHeight * 0.85, behavior: 'smooth' });
        return;
    }
    blocks.forEach((b) => b.classList.remove('is-focused'));
    next.classList.add('is-focused');
    const header = next.closest('.md-diff-file-section')?.querySelector<HTMLElement>('.md-diff-file-header');
    const offset = (header?.offsetHeight || 44) + 10;
    const y = next.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset + scroller.scrollTop;
    scroller.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
};

const init = (): void => {
    const shell = document.querySelector<HTMLElement>('[data-diff-shell]');
    if (!shell) return;

    const km = new KeyboardShortcutsManager();
    // Global (every page).
    km.register('HELP', () => km.showHelp());
    km.register('THEME_PANEL', () => window.MarkonTheme?.togglePanel());
    // Diff-specific. j/k step through individual changed blocks in BOTH views
    // (the same stepper; only the underlying DOM differs).
    km.register('DIFF_TOGGLE_VIEW', () => toggleView(shell));
    km.register('DIFF_NEXT_FILE', () => stepBlock(shell, 1));
    km.register('DIFF_PREV_FILE', () => stepBlock(shell, -1));

    document.addEventListener('keydown', (e) => km.handle(e));
    window.shortcutsManager = km;
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}
