/**
 * KeyboardShortcutsManager - Keyboard shortcuts manager
 * Unified management of keyboard shortcuts.
 */

import { CONFIG, type ShortcutDef, type ShortcutName } from '../core/config';
import { PlatformUtils, Logger } from '../core/utils';
import { closeShortcutsHelp, openShortcutsHelp } from '../components/shortcuts-help';

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

    #comboKey(name: ShortcutName): string {
        const shortcut = CONFIG.SHORTCUTS[name];
        return [
            shortcut.ctrl ? 'ctrl' : '',
            shortcut.shift ? 'shift' : '',
            shortcut.key.length === 1 ? shortcut.key.toLowerCase() : shortcut.key,
        ].filter(Boolean).join('+');
    }

    #featureKey(name: ShortcutName): string {
        return (CONFIG.SHORTCUTS[name] as ShortcutDef).feature || name;
    }

    /**
     * Register a handler for a named shortcut.
     */
    register(name: ShortcutName, handler: ShortcutHandler): void {
        const combo = this.#comboKey(name);
        const feature = this.#featureKey(name);
        for (const existingName of this.#handlers.keys()) {
            if (this.#comboKey(existingName) !== combo) continue;
            if (this.#featureKey(existingName) === feature) continue;
            Logger.warn(
                'KeyboardShortcuts',
                `Skipped ${name}; shortcut conflicts with registered ${existingName}`,
            );
            return;
        }
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
        if (!shortcut.ctrl && shortcut.key.length === 1 && !(/[a-z]/i.exec(shortcut.key))) {
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

        if (document.querySelector('.shortcuts-help-panel') && event.key === 'Escape') {
            event.preventDefault();
            closeShortcutsHelp(true);
            return true;
        }

        const target = event.target as Element | null;

        // Don't intercept keys typed inside input fields (except the viewed checkbox).
        const isViewedCheckbox =
            !!target && !!(target).classList && (target).classList.contains('viewed-checkbox');

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
        if (tocNav?.active) {
            if (event.key === 'j' || event.key === 'k' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                return false;
            }
        }

        // Try each registered shortcut.
        for (const [name, handler] of this.#handlers.entries()) {
            if (this.matches(event, name)) {
                Logger.log('KeyboardShortcuts', `Matched: ${name}`);
                event.preventDefault();
                if (document.querySelector('.shortcuts-help-panel') && name !== 'HELP') {
                    closeShortcutsHelp(true);
                }
                handler(event);
                return true;
            }
        }

        return false;
    }

    /**
     * Show the features/shortcuts panel. Delegates to the reusable
     * {@link openShortcutsHelp} component, passing the LIVE set of registered
     * shortcut names — so the panel lists exactly what this page/state offers,
     * not a static catalogue.
     */
    showHelp(): void {
        openShortcutsHelp(this.#handlers.keys(), (name) => this.run(name));
        Logger.log('KeyboardShortcuts', 'Help panel shown');
    }

    /**
     * Invoke a registered shortcut by name. Used by the feature panel's
     * click-to-open rows so clicking and pressing the shortcut share the same
     * implementation.
     */
    run(name: ShortcutName): boolean {
        const handler = this.#handlers.get(name);
        if (!handler) return false;
        const shortcut = CONFIG.SHORTCUTS[name];
        const isMac = PlatformUtils.isMac();
        const event = new KeyboardEvent('keydown', {
            key: shortcut.key,
            ctrlKey: shortcut.ctrl && !isMac,
            metaKey: shortcut.ctrl && isMac,
            shiftKey: shortcut.shift,
            bubbles: true,
            cancelable: true,
        });
        Logger.log('KeyboardShortcuts', `Run: ${name}`);
        handler(event);
        return true;
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
