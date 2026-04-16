/**
 * ModalManager - Unified modal manager
 * Eliminate addNote、editNote、showConfirmDialog betweencode duplication
 */

import { Logger } from '../core/utils.js';
import { Position } from '../services/position.js';

const _t = (window.__MARKON_I18N__ && window.__MARKON_I18N__.t) || (k => k);

/**
 * 模态框Type枚举
 */
export const ModalType = {
    NOTE_INPUT: 'note_input',
    CONFIRM: 'confirm',
    CUSTOM: 'custom',
};

/**
 * 基础模态框类
 */
class BaseModal {
    #element;
    #options;
    #handlers = {};

    constructor(options) {
        this.#options = {
            className: '',
            closeOnOutsideClick: true,
            closeOnEscape: true,
            ...options
        };
    }

    /**
     * Create模态框 DOM Element
     * @returns {HTMLElement}
     */
    create() {
        throw new Error('create() must be implemented');
    }

    /**
     * Show模态框
     * @param {HTMLElement} anchorElement - 锚点Element（用于定位）
     */
    show(anchorElement = null) {
        // 移除已存在的同类模态框
        this.#removeExisting();

        // CreateElement
        this.#element = this.create();
        document.body.appendChild(this.#element);

        // 定位
        if (anchorElement) {
            this.#positionNear(anchorElement);
        }

        // SettingsEventListen器
        this.#setupEventListeners();

        // 聚焦第一个可聚焦Element
        setTimeout(() => this.#focusFirst(), 0);

        Logger.log('Modal', `Showed ${this.#options.className}`);
    }

    /**
     * Close模态框
     */
    close() {
        if (this.#element) {
            this.#element.remove();
            this.#element = null;
        }

        this.#removeEventListeners();
        Logger.log('Modal', `Closed ${this.#options.className}`);
    }

    /**
     * Get模态框Element
     * @returns {HTMLElement|null}
     */
    getElement() {
        return this.#element;
    }

    /**
     * 移除已存在的同类模态框
     * @private
     */
    #removeExisting() {
        const existing = document.querySelector(`.${this.#options.className}`);
        if (existing) {
            existing.remove();
        }
    }

    /**
     * 在锚点Element附近定位
     * @private
     */
    #positionNear(anchorElement) {
        const rect = anchorElement.getBoundingClientRect();
        const modalWidth = this.#element.offsetWidth;
        const modalHeight = this.#element.offsetHeight;
        const isFixed = getComputedStyle(this.#element).position === 'fixed';
        const scrollX = isFixed ? 0 : (window.pageXOffset || document.documentElement.scrollLeft);
        const scrollY = isFixed ? 0 : (window.pageYOffset || document.documentElement.scrollTop);

        let left = rect.left + scrollX;
        let top = rect.bottom + scrollY + 5;

        // Flip to above if there's no room below.
        if (window.innerHeight - rect.bottom < modalHeight + 10) {
            top = rect.top + scrollY - modalHeight - 5;
        }

        ({ left, top } = Position.constrainToViewport(left, top, modalWidth, modalHeight, { fixed: isFixed }));
        this.#element.style.left = `${left}px`;
        this.#element.style.top = `${top}px`;
    }

    /**
     * SettingsEventListen器
     * @private
     */
    #setupEventListeners() {
        // ESC 键Close
        if (this.#options.closeOnEscape) {
            this.#handlers.keydown = (e) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    // Call cancel() if available (e.g., NoteInputModal), otherwise close()
                    if (typeof this.cancel === 'function') {
                        this.cancel();
                    } else {
                        this.close();
                    }
                }
            };
            document.addEventListener('keydown', this.#handlers.keydown);
        }

        // 点击外部Close
        if (this.#options.closeOnOutsideClick) {
            this.#handlers.click = (e) => {
                if (!this.#element.contains(e.target)) {
                    // Call cancel() if available (e.g., NoteInputModal), otherwise close()
                    if (typeof this.cancel === 'function') {
                        this.cancel();
                    } else {
                        this.close();
                    }
                }
            };
            setTimeout(() => {
                document.addEventListener('click', this.#handlers.click);
            }, 0);
        }
    }

    /**
     * 移除EventListen器
     * @private
     */
    #removeEventListeners() {
        if (this.#handlers.keydown) {
            document.removeEventListener('keydown', this.#handlers.keydown);
        }
        if (this.#handlers.click) {
            document.removeEventListener('click', this.#handlers.click);
        }
    }

    /**
     * 聚焦第一个可聚焦Element
     * @private
     */
    #focusFirst() {
        if (!this.#element) return;

        const focusable = this.#element.querySelector('input, textarea, button');
        if (focusable) {
            // 使用 preventScroll 防止自动滚动
            focusable.focus({ preventScroll: true });
        }
    }
}

/**
 * NoteInput模态框
 */
export class NoteInputModal extends BaseModal {
    #onSave;
    #onCancel;
    #initialValue;

    constructor(options = {}) {
        super({
            className: 'note-input-modal',
            ...options
        });

        this.#onSave = options.onSave || (() => {});
        this.#onCancel = options.onCancel || (() => {});
        this.#initialValue = options.initialValue || '';
    }

    create() {
        const modal = document.createElement('div');
        modal.className = 'note-input-modal';

        modal.innerHTML = `
            <textarea class="note-textarea" placeholder="${_t('web.modal.note.placeholder')}">${this.#initialValue}</textarea>
            <div class="note-input-actions">
                <button class="note-cancel">${_t('web.modal.cancel')}</button>
                <button class="note-save" disabled>${_t('web.modal.save')}</button>
            </div>
        `;

        const textarea = modal.querySelector('.note-textarea');
        const cancelBtn = modal.querySelector('.note-cancel');
        const saveBtn = modal.querySelector('.note-save');

        // Update Save button state based on content
        const updateSaveButton = () => {
            const hasContent = textarea.value.trim().length > 0;
            saveBtn.disabled = !hasContent;
        };

        // Initialize button state
        updateSaveButton();

        // Monitor content changes
        textarea.addEventListener('input', updateSaveButton);

        // 如果有初始值，选中全部Text
        if (this.#initialValue) {
            setTimeout(() => textarea.select(), 0);
        }

        // CancelButton
        cancelBtn.addEventListener('click', () => {
            this.#onCancel();
            this.close();
        });

        // SaveButton
        const save = () => {
            const value = textarea.value.trim();
            if (value) {
                this.#onSave(value);
                this.close();
            }
        };

        saveBtn.addEventListener('click', save);

        // Enter Save（Shift+Enter 换行）
        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
                e.preventDefault();
                save();
            }
        });

        return modal;
    }

    /**
     * Handle cancel action
     */
    cancel() {
        this.#onCancel();
        this.close();
    }

    /**
     * Override close to prevent direct closure (use cancel() instead)
     */
    close() {
        super.close();
    }
}

/**
 * Confirm对话框
 */
export class ConfirmModal extends BaseModal {
    #message;
    #onConfirm;
    #onCancel;
    #confirmText;
    #cancelText;

    constructor(options = {}) {
        super({
            className: 'confirm-dialog',
            ...options
        });

        this.#message = options.message || _t('web.modal.confirm');
        this.#onConfirm = options.onConfirm || (() => {});
        this.#onCancel = options.onCancel || (() => {});
        this.#confirmText = options.confirmText || _t('web.modal.ok');
        this.#cancelText = options.cancelText || _t('web.modal.cancel');
    }

    create() {
        const modal = document.createElement('div');
        modal.className = 'confirm-dialog';

        modal.innerHTML = `
            <p class="confirm-message">${this.#message}</p>
            <div class="confirm-actions">
                <button class="confirm-cancel">${this.#cancelText}</button>
                <button class="confirm-ok">${this.#confirmText}</button>
            </div>
        `;

        const cancelBtn = modal.querySelector('.confirm-cancel');
        const okBtn = modal.querySelector('.confirm-ok');

        cancelBtn.addEventListener('click', () => {
            this.#onCancel();
            this.close();
        });

        okBtn.addEventListener('click', async () => {
            Logger.log('ConfirmModal', 'OK button clicked, executing callback');
            try {
                await this.#onConfirm();
                Logger.log('ConfirmModal', 'Callback completed successfully');
            } catch (error) {
                Logger.error('ConfirmModal', 'Callback failed:', error);
            }
            this.close();
        });

        return modal;
    }
}

/**
 * 模态框Management器（静态类）
 */
export class ModalManager {
    static #current = null;

    /**
     * ShowNoteInput模态框
     * @param {Object} options - ConfigurationOptions
     * @returns {NoteInputModal}
     */
    static showNoteInput(options = {}) {
        const modal = new NoteInputModal(options);
        modal.show(options.anchorElement);
        ModalManager.#current = modal;
        return modal;
    }

    /**
     * ShowConfirm对话框
     * @param {Object} options - ConfigurationOptions
     * @returns {ConfirmModal}
     */
    static showConfirm(options = {}) {
        const modal = new ConfirmModal(options);
        modal.show(options.anchorElement);
        ModalManager.#current = modal;
        return modal;
    }

    /**
     * Close当前模态框
     */
    static closeCurrent() {
        if (ModalManager.#current) {
            ModalManager.#current.close();
            ModalManager.#current = null;
        }
    }

    /**
     * Get当前模态框
     * @returns {BaseModal|null}
     */
    static getCurrent() {
        return ModalManager.#current;
    }
}

/**
 * 便捷函数：ShowConfirm对话框
 * @param {string} message - Message
 * @param {Function} onConfirm - ConfirmCallback
 * @param {HTMLElement} anchorElement - 锚点Element
 * @param {string} confirmText - ConfirmButtonText
 * @returns {ConfirmModal}
 */
export function showConfirmDialog(message, onConfirm, anchorElement = null, confirmText = _t('web.modal.ok')) {
    return ModalManager.showConfirm({
        message,
        onConfirm,
        anchorElement,
        confirmText
    });
}
