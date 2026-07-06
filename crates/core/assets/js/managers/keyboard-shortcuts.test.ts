import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyboardShortcutsManager } from './keyboard-shortcuts';
import { CONFIG } from '../core/config';

/**
 * Helper to construct a KeyboardEvent with the right shape for the manager.
 * jsdom's KeyboardEvent honors the standard `keydown` constructor.
 */
function kbd(
    key: string,
    opts: {
        ctrlKey?: boolean;
        metaKey?: boolean;
        shiftKey?: boolean;
        altKey?: boolean;
        target?: EventTarget | null;
    } = {},
): KeyboardEvent {
    const ev = new KeyboardEvent('keydown', {
        key,
        ctrlKey: opts.ctrlKey ?? false,
        metaKey: opts.metaKey ?? false,
        shiftKey: opts.shiftKey ?? false,
        altKey: opts.altKey ?? false,
        bubbles: true,
        cancelable: true,
    });
    if (opts.target !== undefined) {
        Object.defineProperty(ev, 'target', { value: opts.target, configurable: true });
    }
    return ev;
}

function setPlatform(name: string): void {
    Object.defineProperty(navigator, 'platform', { value: name, configurable: true });
}

function itemAt<T>(items: ArrayLike<T>, index: number): T {
    const item = items[index];
    expect(item).toBeDefined();
    if (item === undefined) throw new Error(`Missing item at index ${index}`);
    return item;
}

describe('KeyboardShortcutsManager', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        document.body.innerHTML = '';
        // Default to mac so meta-key tests are deterministic.
        setPlatform('MacIntel');
    });

    afterEach(() => {
        logSpy.mockRestore();
        warnSpy.mockRestore();
        delete (window as { tocNavigator?: unknown }).tocNavigator;
    });

    it('matches() recognizes Cmd+Z (UNDO) on macOS via metaKey', () => {
        setPlatform('MacIntel');
        const m = new KeyboardShortcutsManager();
        expect(m.matches(kbd('z', { metaKey: true }), 'UNDO')).toBe(true);
        // Plain Z without meta should not match UNDO.
        expect(m.matches(kbd('z'), 'UNDO')).toBe(false);
    });

    it('matches() recognizes Ctrl+Z (UNDO) on Windows via ctrlKey', () => {
        setPlatform('Win32');
        const m = new KeyboardShortcutsManager();
        expect(m.matches(kbd('z', { ctrlKey: true }), 'UNDO')).toBe(true);
        // metaKey on non-mac is irrelevant; would not match.
        expect(m.matches(kbd('z', { metaKey: true }), 'UNDO')).toBe(false);
    });

    it('matches() distinguishes REDO (shift) from UNDO', () => {
        setPlatform('MacIntel');
        const m = new KeyboardShortcutsManager();
        expect(m.matches(kbd('z', { metaKey: true, shiftKey: true }), 'REDO')).toBe(true);
        expect(m.matches(kbd('z', { metaKey: true, shiftKey: true }), 'UNDO')).toBe(false);
    });

    it('matches() handles single non-letter keys without modifiers (?, /, \\)', () => {
        const m = new KeyboardShortcutsManager();
        expect(m.matches(kbd('?'), 'HELP')).toBe(true);
        expect(m.matches(kbd('/'), 'SEARCH')).toBe(true);
        // With Alt, the special-key branch rejects.
        expect(m.matches(kbd('?', { altKey: true }), 'HELP')).toBe(false);
    });

    it('handle() invokes the registered handler and returns true', () => {
        const m = new KeyboardShortcutsManager();
        const handler = vi.fn();
        m.register('NEXT_HEADING', handler);

        const ev = kbd('j', { target: document.body });
        const handled = m.handle(ev);
        expect(handled).toBe(true);
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('handle() returns false when manager is disabled', () => {
        const m = new KeyboardShortcutsManager();
        const handler = vi.fn();
        m.register('NEXT_HEADING', handler);
        m.disable();

        const ev = kbd('j', { target: document.body });
        expect(m.handle(ev)).toBe(false);
        expect(handler).not.toHaveBeenCalled();
        expect(m.isEnabled()).toBe(false);

        m.enable();
        expect(m.handle(kbd('j', { target: document.body }))).toBe(true);
    });

    it('handle() ignores keystrokes inside <input> / <textarea>', () => {
        const m = new KeyboardShortcutsManager();
        const handler = vi.fn();
        m.register('NEXT_HEADING', handler);

        const input = document.createElement('input');
        document.body.appendChild(input);
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        expect(m.handle(kbd('j', { target: input }))).toBe(false);
        expect(m.handle(kbd('j', { target: textarea }))).toBe(false);
        expect(handler).not.toHaveBeenCalled();
    });

    it('handle() bypasses j/k while tocNavigator is active', () => {
        const m = new KeyboardShortcutsManager();
        const handler = vi.fn();
        m.register('NEXT_HEADING', handler);
        (window as { tocNavigator?: unknown }).tocNavigator = { active: true };

        expect(m.handle(kbd('j', { target: document.body }))).toBe(false);
        expect(handler).not.toHaveBeenCalled();
    });

    it('unregister() removes the handler from the dispatch table', () => {
        const m = new KeyboardShortcutsManager();
        const handler = vi.fn();
        m.register('NEXT_HEADING', handler);
        m.unregister('NEXT_HEADING');
        expect(m.handle(kbd('j', { target: document.body }))).toBe(false);
        expect(handler).not.toHaveBeenCalled();
    });

    it('showHelp() appends a panel to the DOM and toggles off on second call', () => {
        const m = new KeyboardShortcutsManager();
        m.register('HELP', () => {});
        m.showHelp();
        expect(document.querySelector('.shortcuts-help-panel')).not.toBeNull();
        // Second call removes the existing panel (toggle behavior).
        m.showHelp();
        expect(document.querySelector('.shortcuts-help-panel')).toBeNull();
    });

    it('showHelp() lists only the registered shortcuts (not the whole catalogue)', () => {
        const m = new KeyboardShortcutsManager();
        // A diff-page-like registration: global + diff, nothing else.
        m.register('HELP', () => {});
        m.register('THEME_PANEL', () => {});
        m.register('DIFF_TOGGLE_VIEW', () => {});
        m.showHelp();

        const panel = document.querySelector('.shortcuts-help-panel')!;
        const descs = [...panel.querySelectorAll('.shortcut-desc')].map((d) => d.textContent);
        // The registered ones appear...
        expect(descs).toEqual(
            expect.arrayContaining([
                CONFIG.SHORTCUTS.HELP.desc,
                CONFIG.SHORTCUTS.THEME_PANEL.desc,
                CONFIG.SHORTCUTS.DIFF_TOGGLE_VIEW.desc,
            ]),
        );
        // ...unregistered ones do NOT (e.g. Undo, Search, next-heading).
        expect(descs).not.toContain(CONFIG.SHORTCUTS.UNDO.desc);
        expect(descs).not.toContain(CONFIG.SHORTCUTS.SEARCH.desc);
        expect(descs).not.toContain(CONFIG.SHORTCUTS.NEXT_HEADING.desc);
        // Global category renders first.
        const cats = [...panel.querySelectorAll('.shortcuts-category h3')].map((h) => h.textContent);
        expect(cats[0]).toBe('web.kbd.cat.global');
    });

    it('showHelp() lets feature titles invoke their registered handlers', () => {
        const m = new KeyboardShortcutsManager();
        const theme = vi.fn();
        m.register('HELP', () => m.showHelp());
        m.register('THEME_PANEL', theme);

        m.showHelp();
        const button = document.querySelector<HTMLButtonElement>('.shortcut-action[data-shortcut-name="THEME_PANEL"]')!;
        button.click();

        expect(theme).toHaveBeenCalledTimes(1);
        expect(document.querySelector('.shortcuts-help-panel')).toBeNull();
    });

    it('showHelp() lets the whole feature row invoke its registered handler', () => {
        const m = new KeyboardShortcutsManager();
        const theme = vi.fn();
        m.register('HELP', () => m.showHelp());
        m.register('THEME_PANEL', theme);

        m.showHelp();
        const row = document.querySelector<HTMLElement>('.shortcut-item[data-shortcut-name="THEME_PANEL"]')!;
        row.click();

        expect(theme).toHaveBeenCalledTimes(1);
        expect(document.querySelector('.shortcuts-help-panel')).toBeNull();
    });

    it('showHelp() groups shortcut aliases for the same feature into one row', () => {
        const m = new KeyboardShortcutsManager();
        m.register('HELP', () => m.showHelp());
        m.register('SEARCH', () => {});
        m.register('WORKSPACE_NAVIGATOR', () => {});

        m.showHelp();

        const rows = document.querySelectorAll('.shortcut-item[data-shortcut-name="SEARCH"]');
        expect(rows.length).toBe(1);
        const row = itemAt(rows, 0);
        expect(row.querySelectorAll('kbd').length).toBe(2);
        expect(row.textContent).toContain('/');
        expect(row.textContent).toContain('g');
        expect(document.querySelector('.shortcut-item[data-shortcut-name="WORKSPACE_NAVIGATOR"]')).toBeNull();
    });

    it('showHelp() switches long shortcut lists to a two-column panel', () => {
        const m = new KeyboardShortcutsManager();
        [
            'HELP',
            'THEME_PANEL',
            'UNDO',
            'REDO',
            'REDO_ALT',
            'ESCAPE',
            'TOGGLE_TOC',
            'EXPORT_NOTES',
            'PREV_HEADING',
            'NEXT_HEADING',
            'PREV_ANNOTATION',
            'NEXT_ANNOTATION',
        ].forEach((name) => m.register(name as keyof typeof CONFIG.SHORTCUTS, () => {}));

        m.showHelp();

        const modal = document.querySelector<HTMLElement>('.shortcuts-help-modal')!;
        expect(modal.classList.contains('is-two-column')).toBe(true);
        expect(modal.querySelectorAll('.shortcuts-column').length).toBe(2);
    });

    it('skips later registrations whose effective shortcut conflicts with another feature', () => {
        const original = { ...CONFIG.SHORTCUTS.SEARCH };
        try {
            CONFIG.SHORTCUTS.SEARCH.key = 't';
            const m = new KeyboardShortcutsManager();
            const theme = vi.fn();
            const search = vi.fn();
            m.register('THEME_PANEL', theme);
            m.register('SEARCH', search);

            expect(m.handle(kbd('t', { target: document.body }))).toBe(true);
            expect(theme).toHaveBeenCalledTimes(1);
            expect(search).not.toHaveBeenCalled();

            m.showHelp();
            expect(document.querySelector('.shortcut-item[data-shortcut-name="THEME_PANEL"]')).not.toBeNull();
            expect(document.querySelector('.shortcut-item[data-shortcut-name="SEARCH"]')).toBeNull();
        } finally {
            Object.assign(CONFIG.SHORTCUTS.SEARCH, original);
        }
    });

    it('handle() closes the feature panel before running another shortcut', () => {
        const m = new KeyboardShortcutsManager();
        const theme = vi.fn();
        m.register('HELP', () => m.showHelp());
        m.register('THEME_PANEL', theme);

        m.showHelp();
        expect(document.querySelector('.shortcuts-help-panel')).not.toBeNull();

        expect(m.handle(kbd('t', { target: document.body }))).toBe(true);
        expect(theme).toHaveBeenCalledTimes(1);
        expect(document.querySelector('.shortcuts-help-panel')).toBeNull();
    });
});
