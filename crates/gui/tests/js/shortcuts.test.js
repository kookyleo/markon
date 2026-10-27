import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { CONFIG } from '../../../core/assets/js/core/config.ts';

const settingsSource = readFileSync('crates/gui/ui/index.html', 'utf8');

// Read the settings UI's real static declarations; do not maintain another
// shortcut table in the test. Only these literal objects/arrays are evaluated.
function settingsLiteral(name) {
    const match = settingsSource.match(new RegExp(`const ${name} = ([\\s\\S]*?);\\n`));
    if (!match) throw new Error(`Missing settings declaration: ${name}`);
    return runInNewContext(`(${match[1]})`);
}

const defaults = settingsLiteral('DEFAULT_SHORTCUTS');
const descriptions = settingsLiteral('SHORTCUT_DESC_KEYS');
const rows = settingsLiteral('SHORTCUT_ROWS');

describe('desktop shortcut settings', () => {
    it('offers every web shortcut with the same default binding', () => {
        const { NEW_WORKSPACE, ...webDefaults } = defaults;
        expect(NEW_WORKSPACE).toEqual({ key: 'n', ctrl: true, shift: false });
        expect(Object.keys(webDefaults).sort()).toEqual(Object.keys(CONFIG.SHORTCUTS).sort());
        for (const [name, shortcut] of Object.entries(CONFIG.SHORTCUTS)) {
            const { key, ctrl, shift } = shortcut;
            expect(webDefaults[name], name).toEqual({ key, ctrl, shift });
            expect(descriptions[name], name).toEqual(shortcut.desc);
        }
    });

    it('renders every configurable binding exactly once', () => {
        const renderedNames = rows.flat();
        expect(renderedNames.sort()).toEqual(Object.keys(defaults).sort());
        expect(new Set(renderedNames).size).toBe(renderedNames.length);
        expect(Object.keys(descriptions).sort()).toEqual(Object.keys(defaults).sort());
    });

    it('keeps aliases for the same web feature together in one row', () => {
        const groups = new Map();
        for (const [name, shortcut] of Object.entries(CONFIG.SHORTCUTS)) {
            if (!shortcut.feature) continue;
            const group = groups.get(shortcut.feature) ?? [];
            group.push(name);
            groups.set(shortcut.feature, group);
        }
        for (const names of groups.values()) {
            if (names.length < 2) continue;
            const row = rows.find(entries => entries.includes(names[0]));
            expect([...row].sort()).toEqual([...names].sort());
        }
    });
});
