import { describe, it, expect } from 'vitest';
import { CONFIG, i18n, type ShortcutDef } from './config.js';

describe('CONFIG.STORAGE_KEYS', () => {
    it('builds the per-file annotations storage key', () => {
        expect(CONFIG.STORAGE_KEYS.ANNOTATIONS('/foo')).toBe('markon-annotations-/foo');
        expect(CONFIG.STORAGE_KEYS.ANNOTATIONS('docs/readme.md')).toBe('markon-annotations-docs/readme.md');
    });

    it('builds the per-file viewed storage key', () => {
        expect(CONFIG.STORAGE_KEYS.VIEWED('/bar')).toBe('markon-viewed-/bar');
    });

    it('exposes the static storage keys', () => {
        expect(CONFIG.STORAGE_KEYS.LIVE_POS).toBe('markon-live-pos');
        expect(CONFIG.STORAGE_KEYS.LIVE_COLOR).toBe('markon-user-color');
        expect(CONFIG.STORAGE_KEYS.LIVE_MODE).toBe('markon-live-mode');
        expect(CONFIG.STORAGE_KEYS.CLIENT_ID).toBe('markon-client-id');
        expect(CONFIG.STORAGE_KEYS.CHAT_POS).toBe('markon-chat-pos');
        expect(CONFIG.STORAGE_KEYS.SHORTCUTS_HELP_POS).toBe('markon-shortcuts-help-pos');
    });
});

describe('CONFIG.SHORTCUTS', () => {
    it('exposes the expected core shortcuts', () => {
        expect(CONFIG.SHORTCUTS.UNDO).toMatchObject({ key: 'z', ctrl: true, shift: false });
        expect(CONFIG.SHORTCUTS.REDO).toMatchObject({ key: 'z', ctrl: true, shift: true });
        expect(CONFIG.SHORTCUTS.REDO_ALT).toMatchObject({ key: 'y', ctrl: true, shift: false });
        expect(CONFIG.SHORTCUTS.ESCAPE).toMatchObject({ key: 'Escape', ctrl: false, shift: false });
        expect(CONFIG.SHORTCUTS.SEARCH).toMatchObject({ key: '/', ctrl: false, shift: false });
        expect(CONFIG.SHORTCUTS.EXPORT_NOTES).toMatchObject({ key: 'x', ctrl: false, shift: false });
        expect(CONFIG.SHORTCUTS.WORKSPACE_NAVIGATOR).toMatchObject({ key: 'g', ctrl: false, shift: false });
        expect(CONFIG.SHORTCUTS.HELP).toMatchObject({ key: '?', ctrl: false, shift: false });
        expect(CONFIG.SHORTCUTS.THEME_PANEL).toMatchObject({ key: 't', ctrl: false, shift: false });
        expect(CONFIG.SHORTCUTS.DIFF_TOGGLE_VIEW).toMatchObject({ key: 'm', ctrl: false, shift: false });
        expect(CONFIG.SHORTCUTS.DIFF_NEXT_FILE).toMatchObject({ key: 'n', ctrl: false, shift: false });
        expect(CONFIG.SHORTCUTS.DIFF_PREV_FILE).toMatchObject({ key: 'p', ctrl: false, shift: false });
        expect(CONFIG.SHORTCUTS.VISUAL_ZOOM_TOOL).toMatchObject({ key: 'z', ctrl: false, shift: false });
        expect(CONFIG.SHORTCUTS.VISUAL_ZOOM_TOOL_OUT).toMatchObject({ key: 'z', ctrl: false, shift: true });
        expect(CONFIG.SHORTCUTS.VISUAL_ZOOM_FIT_CMD).toMatchObject({ key: '0', ctrl: true, shift: false });
    });

    it('does not assign the same default chord to different features', () => {
        const seen = new Map<string, string>();
        for (const [name, rawShortcut] of Object.entries(CONFIG.SHORTCUTS)) {
            const shortcut = rawShortcut as ShortcutDef;
            const combo = [
                shortcut.ctrl ? 'ctrl' : '',
                shortcut.shift ? 'shift' : '',
                shortcut.key.length === 1 ? shortcut.key.toLowerCase() : shortcut.key,
            ].filter(Boolean).join('+');
            const feature = shortcut.feature || name;
            const previous = seen.get(combo);
            if (previous && previous !== feature) {
                throw new Error(`Shortcut ${combo} is shared by ${previous} and ${feature}`);
            }
            seen.set(combo, feature);
        }
    });

    it('includes the expected navigation shortcuts', () => {
        const names = Object.keys(CONFIG.SHORTCUTS);
        expect(names).toEqual(
            expect.arrayContaining([
                'PREV_HEADING',
                'NEXT_HEADING',
                'PREV_ANNOTATION',
                'NEXT_ANNOTATION',
                'SCROLL_HALF_PAGE_DOWN',
                'TOGGLE_SECTION_COLLAPSE',
                'TOGGLE_VIEWED',
                'EDIT',
                'TOGGLE_LIVE_ACTIVE',
                'TOGGLE_LIVE_OFF',
            ]),
        );
    });

    it('matches the documented snapshot of names', () => {
        expect(Object.keys(CONFIG.SHORTCUTS).sort()).toMatchInlineSnapshot(`
          [
            "DIFF_NEXT_FILE",
            "DIFF_PREV_FILE",
            "DIFF_TOGGLE_VIEW",
            "EDIT",
            "ESCAPE",
            "EXPORT_NOTES",
            "HELP",
            "NEXT_ANNOTATION",
            "NEXT_HEADING",
            "PREV_ANNOTATION",
            "PREV_HEADING",
            "REDO",
            "REDO_ALT",
            "SCROLL_HALF_PAGE_DOWN",
            "SEARCH",
            "THEME_PANEL",
            "TOGGLE_CHAT",
            "TOGGLE_CHAT_ALT",
            "TOGGLE_LIVE_ACTIVE",
            "TOGGLE_LIVE_OFF",
            "TOGGLE_SECTION_COLLAPSE",
            "TOGGLE_TOC",
            "TOGGLE_VIEWED",
            "UNDO",
            "VISUAL_ZOOM_CLOSE",
            "VISUAL_ZOOM_FIT",
            "VISUAL_ZOOM_FIT_CMD",
            "VISUAL_ZOOM_IN",
            "VISUAL_ZOOM_IN_ALT",
            "VISUAL_ZOOM_OUT",
            "VISUAL_ZOOM_RESET",
            "VISUAL_ZOOM_RESET_ALT",
            "VISUAL_ZOOM_TOOL",
            "VISUAL_ZOOM_TOOL_OUT",
            "WORKSPACE_NAVIGATOR",
          ]
        `);
    });
});

describe('i18n', () => {
    it('returns the key itself when window.__MARKON_I18N__ is unset', () => {
        // Tests run before main.js installs window.__MARKON_I18N__,
        // so the fallback path should be exercised.
        const previous = window.__MARKON_I18N__;
        try {
            delete window.__MARKON_I18N__;
            expect(i18n.t('web.kbd.undo')).toBe('web.kbd.undo');
            expect(i18n.t('whatever.key', 1, 2)).toBe('whatever.key');
        } finally {
            if (previous) window.__MARKON_I18N__ = previous;
        }
    });

    it('delegates to window.__MARKON_I18N__.t when present', () => {
        const previous = window.__MARKON_I18N__;
        try {
            window.__MARKON_I18N__ = { t: (k: string) => `T:${k}` };
            expect(i18n.t('hello')).toBe('T:hello');
        } finally {
            if (previous) window.__MARKON_I18N__ = previous;
            else delete window.__MARKON_I18N__;
        }
    });
});

describe('CONFIG immutability', () => {
    it('freezes WS_MESSAGE_TYPES', () => {
        expect(Object.isFrozen(CONFIG.WS_MESSAGE_TYPES)).toBe(true);
        // Strict mode (TS modules are strict) makes mutation of a frozen
        // object throw. Wrap in a function so the assertion is reliable.
        expect(() => {
            (CONFIG.WS_MESSAGE_TYPES as { ALL_ANNOTATIONS: string }).ALL_ANNOTATIONS = 'tampered';
        }).toThrow(TypeError);
        expect(CONFIG.WS_MESSAGE_TYPES.ALL_ANNOTATIONS).toBe('all_annotations');
    });

    it('freezes the top-level CONFIG and key sub-objects', () => {
        expect(Object.isFrozen(CONFIG)).toBe(true);
        expect(Object.isFrozen(CONFIG.BREAKPOINTS)).toBe(true);
        expect(Object.isFrozen(CONFIG.SHORTCUTS)).toBe(true);
        expect(Object.isFrozen(CONFIG.SELECTORS)).toBe(true);
        expect(Object.isFrozen(CONFIG.HTML_TAGS)).toBe(true);
    });
});
