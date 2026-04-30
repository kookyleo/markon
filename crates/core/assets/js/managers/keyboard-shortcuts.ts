/**
 * KeyboardShortcutsManager - Keyboard shortcuts manager
 * Unified management of keyboard shortcuts.
 */

import { CONFIG, i18n, type ShortcutDef, type ShortcutName } from '../core/config';
import { PlatformUtils, Logger } from '../core/utils';
import { Meta } from '../services/dom';

const _t = (key: string, ...args: unknown[]): string => i18n.t(key, ...args);

/**
 * Handler function invoked when a shortcut matches.
 */
export type ShortcutHandler = (e: KeyboardEvent) => void;

/**
 * Keyboard shortcuts manager — owns the active {@link ShortcutDef} table and
 * routes matching keyboard events to registered handlers.
 */
export class KeyboardShortcutsManager {
    #shortcuts: Record<ShortcutName, ShortcutDef>;
    #handlers = new Map<ShortcutName, ShortcutHandler>();
    #enabled = true;

    constructor() {
        // Shallow clone keeps the manager's table mutable while leaving
        // CONFIG.SHORTCUTS frozen.
        this.#shortcuts = { ...CONFIG.SHORTCUTS } as Record<ShortcutName, ShortcutDef>;
    }

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
        const shortcut = this.#shortcuts[shortcutName];
        if (!shortcut) return false;

        const isMac = PlatformUtils.isMac();
        const ctrlPressed = isMac ? event.metaKey : event.ctrlKey;

        // 特殊Handle单字符键（不需要修饰符）
        if (!shortcut.ctrl && shortcut.key.length === 1 && !shortcut.key.match(/[a-z]/i)) {
            return event.key === shortcut.key && !ctrlPressed && !event.altKey;
        }

        // 常规匹配
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

        // 不拦截Input框内的按键（除了已读复选框）
        const isViewedCheckbox =
            !!target && !!(target as Element).classList && (target as Element).classList.contains('viewed-checkbox');

        const tagName = (target as HTMLElement | null)?.tagName;
        const isContentEditable = !!(target as HTMLElement | null)?.isContentEditable;
        if ((tagName === 'INPUT' || tagName === 'TEXTAREA' || isContentEditable) && !isViewedCheckbox) {
            return false;
        }

        // j/k Navigation时，如果已读复选框有焦点，失焦
        if (isViewedCheckbox && (event.key === 'j' || event.key === 'k')) {
            (target as HTMLElement).blur();
        }

        // 不拦截 TOC Navigation器的按键
        // TODO(phase-3-typing): tighten window.tocNavigator type once toc-navigator
        // exposes a stable interface; today it's typed as `unknown` in ambient.d.ts.
        const tocNav = (window as { tocNavigator?: { active?: boolean } }).tocNavigator;
        if (tocNav && tocNav.active) {
            if (event.key === 'j' || event.key === 'k' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                return false;
            }
        }

        // Check每个快捷键
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
     * Show the keyboard-shortcuts help panel.
     */
    showHelp(): void {
        // 移除已存在的Panel
        const existing = document.querySelector('.shortcuts-help-panel');
        if (existing) {
            existing.remove();
            return;
        }

        const panel = document.createElement('div');
        panel.className = 'shortcuts-help-panel';

        const isMac = PlatformUtils.isMac();
        const modKey = isMac ? '⌘' : 'Ctrl';

        const formatShortcut = (shortcut: ShortcutDef): string => {
            const keys: string[] = [];
            if (shortcut.ctrl) keys.push(modKey);
            if (shortcut.shift) keys.push('Shift');

            // Show特殊键
            let keyDisplay = shortcut.key;
            if (shortcut.key === ' ') {
                keyDisplay = 'Space';
            } else if (shortcut.key === 'Escape') {
                keyDisplay = 'ESC';
            } else if (shortcut.key === '\\') {
                keyDisplay = '\\';
            } else if (shortcut.key === '?') {
                keyDisplay = '?';
            } else if (shortcut.key.length === 1 && shortcut.key.match(/[a-z]/i)) {
                keyDisplay = shortcut.key.toLowerCase();
            }

            keys.push(keyDisplay);
            return keys.join(' + ');
        };

        const categories: Record<string, ShortcutName[]> = {
            [_t('web.kbd.cat.core')]: ['UNDO', 'REDO', 'REDO_ALT', 'ESCAPE', 'TOGGLE_TOC', 'HELP'],
            [_t('web.kbd.cat.nav')]: ['SCROLL_HALF_PAGE_DOWN', 'PREV_HEADING', 'NEXT_HEADING', 'PREV_ANNOTATION', 'NEXT_ANNOTATION'],
            [_t('web.kbd.cat.search')]: ['SEARCH'],
            [_t('web.kbd.cat.edit')]: ['EDIT'],
            [_t('web.kbd.cat.viewed')]: ['TOGGLE_VIEWED', 'TOGGLE_SECTION_COLLAPSE'],
            [_t('web.kbd.cat.live')]: ['TOGGLE_LIVE_ACTIVE', 'TOGGLE_LIVE_OFF'],
            [_t('web.kbd.cat.chat')]: ['TOGGLE_CHAT', 'TOGGLE_CHAT_ALT'],
        };

        let html = '<div class="shortcuts-help-overlay"></div>';
        html += '<div class="shortcuts-help-modal">';
        html += '<div class="shortcuts-help-header">';
        html += `<h2>${_t('web.kbd.title')}</h2>`;
        html += '</div>';
        html += '<div class="shortcuts-help-content">';

        for (const [category, shortcutNames] of Object.entries(categories)) {
            if (shortcutNames.includes('SEARCH' as ShortcutName) && !Meta.flag(CONFIG.META_TAGS.ENABLE_SEARCH)) {
                continue;
            }
            if (shortcutNames.includes('EDIT' as ShortcutName) && !Meta.flag(CONFIG.META_TAGS.ENABLE_EDIT)) {
                continue;
            }
            if (shortcutNames.includes('TOGGLE_VIEWED' as ShortcutName) && !Meta.flag(CONFIG.META_TAGS.ENABLE_VIEWED)) {
                continue;
            }
            if (
                (shortcutNames.includes('TOGGLE_LIVE_ACTIVE' as ShortcutName) ||
                    shortcutNames.includes('TOGGLE_LIVE_OFF' as ShortcutName)) &&
                !Meta.flag(CONFIG.META_TAGS.ENABLE_LIVE)
            ) {
                continue;
            }
            if (
                (shortcutNames.includes('TOGGLE_CHAT' as ShortcutName) ||
                    shortcutNames.includes('TOGGLE_CHAT_ALT' as ShortcutName)) &&
                !Meta.flag(CONFIG.META_TAGS.ENABLE_CHAT)
            ) {
                continue;
            }

            // FormatCategoryHeading
            let categoryHtml = category;
            const parenMatch = category.match(/^([^(]+)(\(.+\))$/);
            if (parenMatch) {
                categoryHtml = `${parenMatch[1]}<span style="text-transform: none;">${parenMatch[2]}</span>`;
            }

            html += '<div class="shortcuts-category">';
            html += `<h3>${categoryHtml}</h3>`;
            html += '<div class="shortcuts-list">';

            for (const name of shortcutNames) {
                const shortcut = this.#shortcuts[name];
                if (shortcut) {
                    html += '<div class="shortcut-item">';
                    html += `<div class="shortcut-key"><kbd>${formatShortcut(shortcut)
                        .split(' + ')
                        .join('</kbd><kbd>')}</kbd></div>`;
                    html += `<div class="shortcut-desc">${shortcut.desc}</div>`;
                    html += '</div>';
                }
            }

            html += '</div></div>';
        }

        html += '</div>';
        html += `<div class="shortcuts-help-footer">${_t('web.kbd.footer')}</div>`;
        html += '</div>';

        panel.innerHTML = html;
        document.body.appendChild(panel);

        // Show动画
        setTimeout(() => panel.classList.add('visible'), 10);

        // 点击遮罩Close
        const overlay = panel.querySelector('.shortcuts-help-overlay');
        overlay?.addEventListener('click', () => {
            panel.classList.remove('visible');
            setTimeout(() => panel.remove(), CONFIG.ANIMATION.PANEL_TRANSITION);
        });

        // ESC 或 ? Close
        const escHandler = (e: KeyboardEvent): void => {
            if (e.key === 'Escape' || e.key === '?') {
                e.preventDefault();
                panel.classList.remove('visible');
                setTimeout(() => panel.remove(), CONFIG.ANIMATION.PANEL_TRANSITION);
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);

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
