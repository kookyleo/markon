import { describe, it, expect, beforeAll } from 'vitest';

/**
 * These cover the real `ui/i18n.js`, not a copy of it.
 *
 * The module destructures `window.__TAURI__.core` at import time — that is
 * deliberate (a top-level `await` would be a SyntaxError on the older WebKit
 * the desktop app still supports), so the stub has to be in place before the
 * dynamic import runs.
 */
let buildTemplateFunc;
let buildLang;

beforeAll(async () => {
    window.__TAURI__ = { core: { invoke: async () => ({}) } };
    ({ buildTemplateFunc, buildLang } = await import('../../ui/i18n.js'));
});

describe('buildTemplateFunc', () => {
    it('replaces all placeholders', () => {
        const tpl = buildTemplateFunc('v{app_version} on {os} {os_version} ({arch})');
        const result = tpl({ app_version: '1.0', os: 'macOS', os_version: '14.0', arch: 'arm64' });
        expect(result).toBe('v1.0 on macOS 14.0 (arm64)');
    });

    it('uses fallback for missing values', () => {
        const tpl = buildTemplateFunc('{app_version} - {os}');
        expect(tpl({})).toBe('? - ?');
    });

    it('replaces multiple occurrences', () => {
        const tpl = buildTemplateFunc('{os}/{os}');
        expect(tpl({ os: 'linux' })).toBe('linux/linux');
    });

    it('fills {ua} from the user agent', () => {
        const tpl = buildTemplateFunc('ua={ua}');
        expect(tpl({})).toBe(`ua=${navigator.userAgent}`);
    });
});

describe('buildLang', () => {
    it('returns null for null input', () => {
        expect(buildLang(null)).toBeNull();
    });

    it('builds feedback shortcuts from flat keys', () => {
        const lang = buildLang({
            'feedback.bug.label': 'Report Bug',
            'feedback.bug.tip': 'Tell us',
            'feedback.idea.label': 'Idea',
            'feedback.idea.tip': 'Share',
            'feedback.ask.label': 'Ask',
            'feedback.ask.tip': 'Question',
            'tpl.bug': 'Bug on {os}',
            'tpl.idea': 'Idea for {app_version}',
            'tpl.ask': 'Ask about {arch}',
            'tpl.title.bug': 'Bug Report',
            'tpl.title.idea': 'Feature Request',
            'tpl.title.ask': 'Question',
        });
        expect(lang.bug.label).toBe('Report Bug');
        expect(lang.idea.tip).toBe('Share');
        expect(lang.titleBug).toBe('Bug Report');
        expect(typeof lang.tplBug).toBe('function');
        expect(lang.tplBug({ os: 'mac' })).toBe('Bug on mac');
    });
});
