/**
 * KeyboardShortcutsManager - Keyboard shortcuts manager
 * Unified management of keyboard shortcuts
 */

import { CONFIG } from '../core/config.js';
import { PlatformUtils, Logger } from '../core/utils.js';

/**
 * Keyboard shortcuts manager
 */
export class KeyboardShortcutsManager {
    #shortcuts;
    #handlers = new Map();
    #enabled = true;

    constructor() {
        this.#shortcuts = { ...CONFIG.SHORTCUTS };
    }

    /**
     * Register快捷键Handle器
     * @param {string} name - 快捷键Name
     * @param {Function} handler - Handle函数
     */
    register(name, handler) {
        this.#handlers.set(name, handler);
        Logger.log('KeyboardShortcuts', `Registered handler: ${name}`);
    }

    /**
     * CancelRegister快捷键Handle器
     * @param {string} name - 快捷键Name
     */
    unregister(name) {
        this.#handlers.delete(name);
        Logger.log('KeyboardShortcuts', `Unregistered handler: ${name}`);
    }

    /**
     * CheckEvent是否匹配快捷键
     * @param {KeyboardEvent} event - 键盘Event
     * @param {string} shortcutName - 快捷键Name
     * @returns {boolean}
     */
    matches(event, shortcutName) {
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
     * Handle键盘Event
     * @param {KeyboardEvent} event - 键盘Event
     * @returns {boolean} 是否Handle了Event
     */
    handle(event) {
        if (!this.#enabled) return false;

        // 不拦截Input框内的按键（除了已读复选框）
        const target = event.target;
        const isViewedCheckbox = target.classList && target.classList.contains('viewed-checkbox');

        if ((target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) && !isViewedCheckbox) {
            return false;
        }

        // j/k Navigation时，如果已读复选框有焦点，失焦
        if (isViewedCheckbox && (event.key === 'j' || event.key === 'k')) {
            target.blur();
        }

        // 不拦截 TOC Navigation器的按键
        if (window.tocNavigator && window.tocNavigator.active) {
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
     * ShowHelpPanel
     */
    showHelp() {
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

        const formatShortcut = (shortcut) => {
            let keys = [];
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

        const categories = {
            'Core': ['UNDO', 'REDO', 'REDO_ALT', 'ESCAPE', 'TOGGLE_TOC', 'HELP'],
            'Navigation': ['SCROLL_HALF_PAGE_DOWN', 'PREV_HEADING', 'NEXT_HEADING', 'PREV_ANNOTATION', 'NEXT_ANNOTATION'],
            'Viewed (when enabled)': ['TOGGLE_VIEWED', 'TOGGLE_SECTION_COLLAPSE']
        };

        let html = '<div class="shortcuts-help-overlay"></div>';
        html += '<div class="shortcuts-help-modal">';
        html += '<div class="shortcuts-help-header">';
        html += '<h2>Keyboard Shortcuts</h2>';
        html += '</div>';
        html += '<div class="shortcuts-help-content">';

        for (const [category, shortcutNames] of Object.entries(categories)) {
            // Skip Viewed Category（如果未启用）
            if (category.startsWith('Viewed') && !document.querySelector('meta[name="enable-viewed"]')) {
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
                    html += `<div class="shortcut-key"><kbd>${formatShortcut(shortcut).split(' + ').join('</kbd><kbd>')}</kbd></div>`;
                    html += `<div class="shortcut-desc">${shortcut.desc}</div>`;
                    html += '</div>';
                }
            }

            html += '</div></div>';
        }

        html += '</div>';
        html += '<div class="shortcuts-help-footer">Press <kbd>ESC</kbd> or <kbd>?</kbd> to close</div>';
        html += '</div>';

        panel.innerHTML = html;
        document.body.appendChild(panel);

        // Show动画
        setTimeout(() => panel.classList.add('visible'), 10);

        // 点击遮罩Close
        const overlay = panel.querySelector('.shortcuts-help-overlay');
        overlay.addEventListener('click', () => {
            panel.classList.remove('visible');
            setTimeout(() => panel.remove(), CONFIG.ANIMATION.PANEL_TRANSITION);
        });

        // ESC 或 ? Close
        const escHandler = (e) => {
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
     * 启用快捷键
     */
    enable() {
        this.#enabled = true;
        Logger.log('KeyboardShortcuts', 'Enabled');
    }

    /**
     * 禁用快捷键
     */
    disable() {
        this.#enabled = false;
        Logger.log('KeyboardShortcuts', 'Disabled');
    }

    /**
     * Check是否已启用
     * @returns {boolean}
     */
    isEnabled() {
        return this.#enabled;
    }
}
