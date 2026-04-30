import { describe, it, expect } from 'vitest';
import { CONFIG, i18n } from './config.js';

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
    });
});

describe('CONFIG.SHORTCUTS', () => {
    it('exposes the expected core shortcuts', () => {
        expect(CONFIG.SHORTCUTS.UNDO).toMatchObject({ key: 'z', ctrl: true, shift: false });
        expect(CONFIG.SHORTCUTS.REDO).toMatchObject({ key: 'z', ctrl: true, shift: true });
        expect(CONFIG.SHORTCUTS.REDO_ALT).toMatchObject({ key: 'y', ctrl: true, shift: false });
        expect(CONFIG.SHORTCUTS.ESCAPE).toMatchObject({ key: 'Escape', ctrl: false, shift: false });
        expect(CONFIG.SHORTCUTS.SEARCH).toMatchObject({ key: '/', ctrl: false, shift: false });
        expect(CONFIG.SHORTCUTS.HELP).toMatchObject({ key: '?', ctrl: false, shift: false });
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
            "EDIT",
            "ESCAPE",
            "HELP",
            "NEXT_ANNOTATION",
            "NEXT_HEADING",
            "PREV_ANNOTATION",
            "PREV_HEADING",
            "REDO",
            "REDO_ALT",
            "SCROLL_HALF_PAGE_DOWN",
            "SEARCH",
            "TOGGLE_CHAT",
            "TOGGLE_CHAT_ALT",
            "TOGGLE_LIVE_ACTIVE",
            "TOGGLE_LIVE_OFF",
            "TOGGLE_SECTION_COLLAPSE",
            "TOGGLE_TOC",
            "TOGGLE_VIEWED",
            "UNDO",
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
