import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyboardShortcutsManager } from './keyboard-shortcuts';

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

describe('KeyboardShortcutsManager', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        document.body.innerHTML = '';
        // Default to mac so meta-key tests are deterministic.
        setPlatform('MacIntel');
    });

    afterEach(() => {
        logSpy.mockRestore();
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
        m.showHelp();
        expect(document.querySelector('.shortcuts-help-panel')).not.toBeNull();
        // Second call removes the existing panel (toggle behavior).
        m.showHelp();
        expect(document.querySelector('.shortcuts-help-panel')).toBeNull();
    });
});
