/**
 * Reusable feature-and-shortcuts help panel.
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
import { makeModalDraggable } from './modal';

const _t = (key: string, ...args: unknown[]): string => i18n.t(key, ...args);

/** Category render order. Global first; any registered category not listed
 *  here is appended after, in CONFIG declaration order. */
const CAT_ORDER = ['global', 'core', 'nav', 'diff', 'search', 'visual', 'edit', 'viewed', 'live', 'chat'];

type ShortcutInvoker = (name: ShortcutName) => void;
type ShortcutsPanelElement = HTMLElement & { __markonShortcutCleanup?: () => void };
interface ShortcutFeatureEntry { names: ShortcutName[] }
interface ShortcutGroup { cat: string; entries: ShortcutFeatureEntry[] }

const TWO_COLUMN_ENTRY_THRESHOLD = 10;
const TWO_COLUMN_MIN_WIDTH = 720;

const escapeHtml = (value: string): string =>
    value.replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    })[ch] ?? ch);

/** Pretty-print one shortcut's key combo into individual <kbd> tokens. */
const formatShortcut = (shortcut: ShortcutDef): string[] => {
    const modKey = PlatformUtils.isMac() ? '⌘' : 'Ctrl';
    const keys: string[] = [];
    if (shortcut.ctrl) keys.push(modKey);
    if (shortcut.shift) keys.push('Shift');

    let keyDisplay = shortcut.key;
    if (shortcut.key === ' ') keyDisplay = 'Space';
    else if (shortcut.key === 'Escape') keyDisplay = 'Esc';
    else if (shortcut.key.length === 1 && (/[a-z]/i.exec(shortcut.key))) keyDisplay = shortcut.key.toLowerCase();

    keys.push(keyDisplay);
    return keys;
};

/** Group the registered shortcut names by category and feature, preserving
 *  CONFIG order within each group and ordering the groups by {@link CAT_ORDER}. */
const groupByCategory = (registered: Set<ShortcutName>): ShortcutGroup[] => {
    const byCat = new Map<string, Map<string, ShortcutFeatureEntry>>();
    for (const name of Object.keys(CONFIG.SHORTCUTS) as ShortcutName[]) {
        if (!registered.has(name)) continue;
        const shortcut = CONFIG.SHORTCUTS[name] as ShortcutDef;
        const cat = shortcut.cat;
        const feature = shortcut.feature || name;
        let features = byCat.get(cat);
        if (!features) {
            features = new Map();
            byCat.set(cat, features);
        }
        const entry = features.get(feature) ?? { names: [] };
        entry.names.push(name);
        features.set(feature, entry);
    }
    const order = (cat: string): number => {
        const i = CAT_ORDER.indexOf(cat);
        return i === -1 ? CAT_ORDER.length : i;
    };
    return [...byCat.entries()]
        .sort((a, b) => order(a[0]) - order(b[0]))
        .map(([cat, entries]) => ({ cat, entries: [...entries.values()] }));
};

const entryCount = (groups: ShortcutGroup[]): number =>
    groups.reduce((total, group) => total + group.entries.length, 0);

const splitGroupsIntoColumns = (groups: ShortcutGroup[]): [ShortcutGroup[], ShortcutGroup[]] => {
    const target = Math.ceil(entryCount(groups) / 2);
    const left: ShortcutGroup[] = [];
    const right: ShortcutGroup[] = [];
    let leftCount = 0;

    for (const group of groups) {
        if (left.length > 0 && leftCount >= target) {
            right.push(group);
        } else {
            left.push(group);
            leftCount += group.entries.length;
        }
    }

    if (right.length === 0 && left.length > 1) {
        right.unshift(left.pop() as ShortcutGroup);
    }

    return [left, right];
};

const renderShortcutEntry = (entry: ShortcutFeatureEntry): string => {
    const name = entry.names[0];
    if (!name) return '';
    const shortcut = CONFIG.SHORTCUTS[name];
    const seenCombos = new Set<string>();
    const keys = entry.names
        .map((entryName) => {
            const combo = formatShortcut(CONFIG.SHORTCUTS[entryName])
                .map(key => `<kbd>${escapeHtml(key)}</kbd>`)
                .join('');
            if (seenCombos.has(combo)) return '';
            seenCombos.add(combo);
            return `<span class="shortcut-key-combo">${combo}</span>`;
        })
        .filter(Boolean)
        .join('<span class="shortcut-key-separator">or</span>');

    return [
        `<div class="shortcut-item" data-shortcut-name="${name}">`,
        `<div class="shortcut-key">${keys}</div>`,
        '<div class="shortcut-desc">',
        `<button type="button" class="shortcut-action" data-shortcut-name="${name}">${escapeHtml(shortcut.desc)}</button>`,
        '</div>',
        '</div>',
    ].join('');
};

const renderCategory = ({ cat, entries }: ShortcutGroup): string => [
    '<div class="shortcuts-category">',
    `<h3>${escapeHtml(_t(`web.kbd.cat.${cat}`))}</h3>`,
    '<div class="shortcuts-list">',
    entries.map(renderShortcutEntry).join(''),
    '</div></div>',
].join('');

const closePanel = (panel: ShortcutsPanelElement, immediate = false): void => {
    panel.__markonShortcutCleanup?.();
    delete panel.__markonShortcutCleanup;
    if (immediate) {
        panel.remove();
        return;
    }
    panel.classList.remove('visible');
    setTimeout(() => panel.remove(), CONFIG.ANIMATION.PANEL_TRANSITION);
};

export const closeShortcutsHelp = (immediate = false): boolean => {
    const panel = document.querySelector<ShortcutsPanelElement>('.shortcuts-help-panel');
    if (!panel) return false;
    closePanel(panel, immediate);
    return true;
};

/**
 * Toggle the features/shortcuts panel. When open, a second call closes it.
 * `registered` is the live set of shortcut names the calling page has wired up
 * — only those are shown.
 */
export function openShortcutsHelp(registered: Iterable<ShortcutName>, invoke?: ShortcutInvoker): void {
    if (document.querySelector<HTMLElement>('.shortcuts-help-panel')) {
        // Toggling off via `?` is instant (snappy); the overlay-click / Esc paths
        // animate out (see closePanel).
        closeShortcutsHelp(true);
        return;
    }

    const groups = groupByCategory(new Set(registered));
    const useTwoColumns =
        entryCount(groups) > TWO_COLUMN_ENTRY_THRESHOLD &&
        window.innerWidth >= TWO_COLUMN_MIN_WIDTH;
    const columns = useTwoColumns ? splitGroupsIntoColumns(groups) : [groups];

    const panel = document.createElement('div') as ShortcutsPanelElement;
    panel.className = 'shortcuts-help-panel markon-modal-layer';

    let html = '<div class="shortcuts-help-overlay markon-modal-backdrop"></div>';
    html += `<div class="shortcuts-help-modal markon-modal-frame${useTwoColumns ? ' is-two-column' : ''}">`;
    html += `<div class="shortcuts-help-header"><h2>${escapeHtml(_t('web.kbd.title'))}</h2></div>`;
    html += '<div class="shortcuts-help-content">';

    for (const columnGroups of columns) {
        html += `<div class="shortcuts-column">${columnGroups.map(renderCategory).join('')}</div>`;
    }

    html += '</div>';
    html += `<div class="shortcuts-help-footer">${escapeHtml(_t('web.kbd.footer'))}</div>`;
    html += '</div>';

    panel.innerHTML = html;
    document.body.appendChild(panel);

    let dragManager: ReturnType<typeof makeModalDraggable> | null = null;
    panel.classList.add('visible');
    const modal = panel.querySelector<HTMLElement>('.shortcuts-help-modal');
    if (modal) {
        dragManager = makeModalDraggable(modal, {
            handle: '.shortcuts-help-header',
            storageKey: CONFIG.STORAGE_KEYS.SHORTCUTS_HELP_POS,
        });
    }

    // Overlay click closes.
    panel.querySelector('.shortcuts-help-overlay')?.addEventListener('click', () => closePanel(panel));

    const invokeShortcut = (name: ShortcutName | undefined): void => {
        if (!name || !invoke) return;
        if (name === 'HELP') {
            invoke(name);
            return;
        }
        closePanel(panel, true);
        invoke(name);
    };

    panel.querySelectorAll<HTMLElement>('.shortcut-item').forEach((item) => {
        item.addEventListener('click', (event) => {
            if ((event.target as Element | null)?.closest('.shortcut-action')) return;
            invokeShortcut(item.dataset['shortcutName'] as ShortcutName | undefined);
        });
    });

    panel.querySelectorAll<HTMLButtonElement>('.shortcut-action').forEach((button) => {
        button.addEventListener('click', () => {
            invokeShortcut(button.dataset['shortcutName'] as ShortcutName | undefined);
        });
    });

    // Esc or ? closes.
    const escHandler = (e: KeyboardEvent): void => {
        if (e.key === 'Escape' || e.key === '?') {
            e.preventDefault();
            closePanel(panel);
        }
    };
    panel.__markonShortcutCleanup = () => {
        dragManager?.destroy();
        dragManager = null;
        document.removeEventListener('keydown', escHandler);
    };
    document.addEventListener('keydown', escHandler);
}
