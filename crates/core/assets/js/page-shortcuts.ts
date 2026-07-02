/**
 * Keyboard shortcuts for the lightweight read-only pages that don't boot
 * MarkonApp: git history and branches/tags (git-refs).
 *
 * These pages have no document view, no diff, no search — only the shortcuts
 * that hold on EVERY surface: Help (`?`), Theme (`t`) and Escape. Because the
 * help panel renders from the manager's live registered set, pressing `?` here
 * lists exactly this trio and nothing that doesn't exist on the page.
 *
 * Mirrors the wiring pattern of {@link ./diff-shortcuts}: construct a manager,
 * register the page's real shortcuts, route `keydown` through it, and expose it
 * as `window.shortcutsManager` (the footer "Keyboard Shortcuts" link calls
 * `showHelp()` on it).
 */

import { KeyboardShortcutsManager } from './managers/keyboard-shortcuts';
import { CONFIG } from './core/config';

/** Dismiss the shortcuts help overlay if it's open. Returns whether it was. */
const closeHelpPanel = (): boolean => {
    const panel = document.querySelector<HTMLElement>('.shortcuts-help-panel');
    if (!panel) return false;
    panel.classList.remove('visible');
    setTimeout(() => panel.remove(), CONFIG.ANIMATION.PANEL_TRANSITION);
    return true;
};

const init = (): void => {
    const km = new KeyboardShortcutsManager();
    km.register('HELP', () => km.showHelp());
    km.register('THEME_PANEL', () => window.MarkonTheme?.togglePanel());
    km.register('ESCAPE', () => closeHelpPanel());

    document.addEventListener('keydown', (e) => km.handle(e));

    window.shortcutsManager = km;
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}
