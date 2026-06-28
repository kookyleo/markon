/**
 * KeyboardShortcutsManager - Keyboard shortcuts manager
 * Unified management of keyboard shortcuts.
 */

import { CONFIG, type ShortcutName } from '../core/config';
import { PlatformUtils, Logger } from '../core/utils';
import { openShortcutsHelp } from '../components/shortcuts-help';

/**
 * Handler function invoked when a shortcut matches.
 */
export type ShortcutHandler = (e: KeyboardEvent) => void;

/**
 * Keyboard shortcuts manager — matches keyboard events against the
 * {@link ShortcutDef} table in CONFIG.SHORTCUTS (user overrides already
 * applied at config-module load) and routes them to registered handlers.
 */
export class KeyboardShortcutsManager {
    #handlers = new Map<ShortcutName, ShortcutHandler>();
    #enabled = true;

    /**
     * Register a handler for a named shortcut.
     */
    register(name: ShortcutName, handler: ShortcutHandler): void {
        this.#handlers.set(name, handler);
        Logger.log('KeyboardShortcuts', `Registered handler: ${name}`);
    }

    /**
     * Unregister a previously-registered handler.
     */
    unregister(name: ShortcutName): void {
        this.#handlers.delete(name);
        Logger.log('KeyboardShortcuts', `Unregistered handler: ${name}`);
    }

    /**
     * Check whether the event matches the named shortcut.
     */
    matches(event: KeyboardEvent, shortcutName: ShortcutName): boolean {
        const shortcut = CONFIG.SHORTCUTS[shortcutName];
        if (!shortcut) return false;

        const isMac = PlatformUtils.isMac();
        const ctrlPressed = isMac ? event.metaKey : event.ctrlKey;

        // Special case: single non-letter keys that don't require modifiers.
        if (!shortcut.ctrl && shortcut.key.length === 1 && !shortcut.key.match(/[a-z]/i)) {
            return event.key === shortcut.key && !ctrlPressed && !event.altKey;
        }

        // Regular match
        return (
            event.key.toLowerCase() === shortcut.key.toLowerCase() &&
            ctrlPressed === shortcut.ctrl &&
            event.shiftKey === shortcut.shift &&
            !event.altKey
        );
    }

    /**
     * Dispatch a keyboard event to the first matching handler.
     * Returns true if the event was handled (and `preventDefault` was called).
     */
    handle(event: KeyboardEvent): boolean {
        if (!this.#enabled) return false;

        // Handle search input escape key
        const target = event.target as Element | null;
        if (target && (target as HTMLElement).id === 'search-input' && event.key === 'Escape') {
            return false;
        }

        // Don't intercept keys typed inside input fields (except the viewed checkbox).
        const isViewedCheckbox =
            !!target && !!(target as Element).classList && (target as Element).classList.contains('viewed-checkbox');

        const tagName = (target as HTMLElement | null)?.tagName;
        const isContentEditable = !!(target as HTMLElement | null)?.isContentEditable;
        if ((tagName === 'INPUT' || tagName === 'TEXTAREA' || isContentEditable) && !isViewedCheckbox) {
            return false;
        }

        // When navigating with j/k, blur the viewed checkbox if it currently has focus.
        if (isViewedCheckbox && (event.key === 'j' || event.key === 'k')) {
            (target as HTMLElement).blur();
        }

        // Don't intercept keys claimed by the TOC navigator.
        // TODO(phase-3-typing): tighten window.tocNavigator type once toc-navigator
        // exposes a stable interface; today it's typed as `unknown` in ambient.d.ts.
        const tocNav = (window as { tocNavigator?: { active?: boolean } }).tocNavigator;
        if (tocNav && tocNav.active) {
            if (event.key === 'j' || event.key === 'k' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                return false;
            }
        }

        // Try each registered shortcut.
        for (const [name, handler] of this.#handlers.entries()) {
            if (this.matches(event, name)) {
                Logger.log('KeyboardShortcuts', `Matched: ${name}`);
                event.preventDefault();
                handler(event);
                return true;
            }
        }

        return false;
    }

    /**
     * Show the keyboard-shortcuts help panel. Delegates to the reusable
     * {@link openShortcutsHelp} component, passing the LIVE set of registered
     * shortcut names — so the panel lists exactly what this page/state offers,
     * not a static catalogue.
     */
    showHelp(): void {
        openShortcutsHelp(this.#handlers.keys());
        Logger.log('KeyboardShortcuts', 'Help panel shown');
    }

    /**
     * Enable the manager (resumes dispatching).
     */
    enable(): void {
        this.#enabled = true;
        Logger.log('KeyboardShortcuts', 'Enabled');
    }

    /**
     * Disable the manager (handle() short-circuits to false).
     */
    disable(): void {
        this.#enabled = false;
        Logger.log('KeyboardShortcuts', 'Disabled');
    }

    /**
     * Whether the manager is currently dispatching events.
     */
    isEnabled(): boolean {
        return this.#enabled;
    }
}
