/**
 * ModalManager - 统一的模态框管理器
 * 消除 addNote、editNote、showConfirmDialog 之间的代码重复
 */

import { Logger } from '../core/utils.js';
import { Position } from '../services/position.js';

/**
 * 模态框类型枚举
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
     * 创建模态框 DOM 元素
     * @returns {HTMLElement}
     */
    create() {
        throw new Error('create() must be implemented');
    }

    /**
     * 显示模态框
     * @param {HTMLElement} anchorElement - 锚点元素（用于定位）
     */
    show(anchorElement = null) {
        // 移除已存在的同类模态框
        this.#removeExisting();

        // 创建元素
        this.#element = this.create();
        document.body.appendChild(this.#element);

        // 定位
        if (anchorElement) {
            this.#positionNear(anchorElement);
        }

        // 设置事件监听器
        this.#setupEventListeners();

        // 聚焦第一个可聚焦元素
        setTimeout(() => this.#focusFirst(), 0);

        Logger.log('Modal', `Showed ${this.#options.className}`);
    }

    /**
     * 关闭模态框
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
     * 获取模态框元素
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
     * 在锚点元素附近定位
     * @private
     */
    #positionNear(anchorElement) {
        const rect = anchorElement.getBoundingClientRect();

        // 强制重排以获取准确的尺寸
        const modalWidth = this.#element.offsetWidth;
        const modalHeight = this.#element.offsetHeight;

        // 检查 Modal 的 position 类型
        const position = getComputedStyle(this.#element).position;
        const isFixed = position === 'fixed';

        // 获取滚动位置（仅在 absolute 定位时需要）
        const scrollX = isFixed ? 0 : (window.pageXOffset || document.documentElement.scrollLeft);
        const scrollY = isFixed ? 0 : (window.pageYOffset || document.documentElement.scrollTop);

        // 默认位置：锚点下方
        let left = rect.left + scrollX;
        let top = rect.bottom + scrollY + 5;

        // 调整位置以保持在视口内
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const margin = 10;

        if (left + modalWidth > viewportWidth - margin) {
            left = viewportWidth - modalWidth - margin;
        }
        if (left < margin) {
            left = margin;
        }

        // 检查下方空间，如果不够则放在上方
        const spaceBelow = viewportHeight - rect.bottom;
        if (spaceBelow < modalHeight + 10) {
            // 放在上方
            top = rect.top + scrollY - modalHeight - 5;
        }

        // 确保不超出视口
        if (isFixed) {
            // Fixed 定位：使用视口坐标
            if (top < margin) {
                top = margin;
            }
            if (top + modalHeight > viewportHeight - margin) {
                top = viewportHeight - modalHeight - margin;
            }
        } else {
            // Absolute 定位：使用文档坐标
            const viewportTop = scrollY;
            const viewportBottom = scrollY + viewportHeight;

            if (top < viewportTop + margin) {
                top = viewportTop + margin;
            }
            if (top + modalHeight > viewportBottom - margin) {
                top = viewportBottom - modalHeight - margin;
            }
        }

        this.#element.style.left = `${left}px`;
        this.#element.style.top = `${top}px`;

        Logger.log('Modal', `Positioned at (${Math.round(left)}, ${Math.round(top)}) [${position}] with scroll (${scrollX}, ${scrollY})`);
    }

    /**
     * 设置事件监听器
     * @private
     */
    #setupEventListeners() {
        // ESC 键关闭
        if (this.#options.closeOnEscape) {
            this.#handlers.keydown = (e) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    this.close();
                }
            };
            document.addEventListener('keydown', this.#handlers.keydown);
        }

        // 点击外部关闭
        if (this.#options.closeOnOutsideClick) {
            this.#handlers.click = (e) => {
                if (!this.#element.contains(e.target)) {
                    this.close();
                }
            };
            setTimeout(() => {
                document.addEventListener('click', this.#handlers.click);
            }, 0);
        }
    }

    /**
     * 移除事件监听器
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
     * 聚焦第一个可聚焦元素
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
 * 笔记输入模态框
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
            <textarea class="note-textarea" placeholder="Enter your note...">${this.#initialValue}</textarea>
            <div class="note-input-actions">
                <button class="note-cancel">Cancel</button>
                <button class="note-save">Save</button>
            </div>
        `;

        const textarea = modal.querySelector('.note-textarea');
        const cancelBtn = modal.querySelector('.note-cancel');
        const saveBtn = modal.querySelector('.note-save');

        // 如果有初始值，选中全部文本
        if (this.#initialValue) {
            setTimeout(() => textarea.select(), 0);
        }

        // 取消按钮
        cancelBtn.addEventListener('click', () => {
            this.#onCancel();
            this.close();
        });

        // 保存按钮
        const save = () => {
            const value = textarea.value.trim();
            this.#onSave(value);
            this.close();
        };

        saveBtn.addEventListener('click', save);

        // Enter 保存（Shift+Enter 换行）
        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
                e.preventDefault();
                save();
            }
        });

        return modal;
    }
}

/**
 * 确认对话框
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

        this.#message = options.message || 'Are you sure?';
        this.#onConfirm = options.onConfirm || (() => {});
        this.#onCancel = options.onCancel || (() => {});
        this.#confirmText = options.confirmText || 'OK';
        this.#cancelText = options.cancelText || 'Cancel';
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
 * 模态框管理器（静态类）
 */
export class ModalManager {
    static #current = null;

    /**
     * 显示笔记输入模态框
     * @param {Object} options - 配置选项
     * @returns {NoteInputModal}
     */
    static showNoteInput(options = {}) {
        const modal = new NoteInputModal(options);
        modal.show(options.anchorElement);
        ModalManager.#current = modal;
        return modal;
    }

    /**
     * 显示确认对话框
     * @param {Object} options - 配置选项
     * @returns {ConfirmModal}
     */
    static showConfirm(options = {}) {
        const modal = new ConfirmModal(options);
        modal.show(options.anchorElement);
        ModalManager.#current = modal;
        return modal;
    }

    /**
     * 关闭当前模态框
     */
    static closeCurrent() {
        if (ModalManager.#current) {
            ModalManager.#current.close();
            ModalManager.#current = null;
        }
    }

    /**
     * 获取当前模态框
     * @returns {BaseModal|null}
     */
    static getCurrent() {
        return ModalManager.#current;
    }
}

/**
 * 便捷函数：显示确认对话框
 * @param {string} message - 消息
 * @param {Function} onConfirm - 确认回调
 * @param {HTMLElement} anchorElement - 锚点元素
 * @param {string} confirmText - 确认按钮文本
 * @returns {ConfirmModal}
 */
export function showConfirmDialog(message, onConfirm, anchorElement = null, confirmText = 'OK') {
    return ModalManager.showConfirm({
        message,
        onConfirm,
        anchorElement,
        confirmText
    });
}
