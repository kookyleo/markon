/**
 * Reusable keyboard-shortcuts help panel.
 *
 * Renders the "press ? for help" overlay from the set of shortcuts that are
 * ACTUALLY registered on the current page (and current state) — not a static
 * dump of every shortcut Markon knows. Each shortcut carries a `cat` (category)
 * in CONFIG.SHORTCUTS; the panel groups the registered ones by category, with
 * the always-available `global` group first, so every surface (the document
 * view, the compare/diff page, …) gets a help panel tailored to what it offers.
 *
 * Used by every page through {@link KeyboardShortcutsManager.showHelp}, which
 * passes its live registered-handler set here.
 */

import { CONFIG, i18n, type ShortcutDef, type ShortcutName } from '../core/config';
import { PlatformUtils } from '../core/utils';

const _t = (key: string, ...args: unknown[]): string => i18n.t(key, ...args);

/** Category render order. Global first; any registered category not listed
 *  here is appended after, in CONFIG declaration order. */
const CAT_ORDER = ['global', 'core', 'nav', 'diff', 'search', 'edit', 'viewed', 'live', 'chat'];

/** Pretty-print one shortcut's key combo into individual <kbd> tokens. */
const formatShortcut = (shortcut: ShortcutDef): string[] => {
    const modKey = PlatformUtils.isMac() ? '⌘' : 'Ctrl';
    const keys: string[] = [];
    if (shortcut.ctrl) keys.push(modKey);
    if (shortcut.shift) keys.push('Shift');

    let keyDisplay = shortcut.key;
    if (shortcut.key === ' ') keyDisplay = 'Space';
    else if (shortcut.key === 'Escape') keyDisplay = 'ESC';
    else if (shortcut.key.length === 1 && shortcut.key.match(/[a-z]/i)) keyDisplay = shortcut.key.toLowerCase();

    keys.push(keyDisplay);
    return keys;
};

/** Group the registered shortcut names by category, preserving CONFIG order
 *  within each group and ordering the groups by {@link CAT_ORDER}. */
const groupByCategory = (registered: Set<ShortcutName>): Array<{ cat: string; names: ShortcutName[] }> => {
    const byCat = new Map<string, ShortcutName[]>();
    for (const name of Object.keys(CONFIG.SHORTCUTS) as ShortcutName[]) {
        if (!registered.has(name)) continue;
        const cat = CONFIG.SHORTCUTS[name].cat;
        const list = byCat.get(cat) ?? [];
        list.push(name);
        byCat.set(cat, list);
    }
    const order = (cat: string): number => {
        const i = CAT_ORDER.indexOf(cat);
        return i === -1 ? CAT_ORDER.length : i;
    };
    return [...byCat.entries()]
        .sort((a, b) => order(a[0]) - order(b[0]))
        .map(([cat, names]) => ({ cat, names }));
};

const closePanel = (panel: HTMLElement): void => {
    panel.classList.remove('visible');
    setTimeout(() => panel.remove(), CONFIG.ANIMATION.PANEL_TRANSITION);
};

/**
 * Toggle the shortcuts help panel. When open, a second call closes it.
 * `registered` is the live set of shortcut names the calling page has wired up
 * — only those are shown.
 */
export function openShortcutsHelp(registered: Iterable<ShortcutName>): void {
    const existing = document.querySelector<HTMLElement>('.shortcuts-help-panel');
    if (existing) {
        // Toggling off via `?` is instant (snappy); the overlay-click / ESC paths
        // animate out (see closePanel).
        existing.remove();
        return;
    }

    const groups = groupByCategory(new Set(registered));

    const panel = document.createElement('div');
    panel.className = 'shortcuts-help-panel';

    let html = '<div class="shortcuts-help-overlay"></div>';
    html += '<div class="shortcuts-help-modal">';
    html += `<div class="shortcuts-help-header"><h2>${_t('web.kbd.title')}</h2></div>`;
    html += '<div class="shortcuts-help-content">';

    for (const { cat, names } of groups) {
        html += '<div class="shortcuts-category">';
        html += `<h3>${_t(`web.kbd.cat.${cat}`)}</h3>`;
        html += '<div class="shortcuts-list">';
        for (const name of names) {
            const shortcut = CONFIG.SHORTCUTS[name];
            html += '<div class="shortcut-item">';
            html += `<div class="shortcut-key"><kbd>${formatShortcut(shortcut).join('</kbd><kbd>')}</kbd></div>`;
            html += `<div class="shortcut-desc">${shortcut.desc}</div>`;
            html += '</div>';
        }
        html += '</div></div>';
    }

    html += '</div>';
    html += `<div class="shortcuts-help-footer">${_t('web.kbd.footer')}</div>`;
    html += '</div>';

    panel.innerHTML = html;
    document.body.appendChild(panel);

    // Trigger the show animation.
    setTimeout(() => panel.classList.add('visible'), 10);

    // Overlay click closes.
    panel.querySelector('.shortcuts-help-overlay')?.addEventListener('click', () => closePanel(panel));

    // ESC or ? closes.
    const escHandler = (e: KeyboardEvent): void => {
        if (e.key === 'Escape' || e.key === '?') {
            e.preventDefault();
            closePanel(panel);
            document.removeEventListener('keydown', escHandler);
        }
    };
    document.addEventListener('keydown', escHandler);
}
