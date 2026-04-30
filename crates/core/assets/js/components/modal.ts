/**
 * ModalManager - Unified modal manager
 * Eliminate addNote、editNote、showConfirmDialog betweencode duplication
 */

import { Logger } from '../core/utils';
import { Position } from '../services/position';

const _t: (k: string, ...args: unknown[]) => string =
    (window.__MARKON_I18N__ && window.__MARKON_I18N__.t) || ((k: string) => k);

/**
 * 模态框Type枚举
 */
export const ModalType = {
    NOTE_INPUT: 'note_input',
    CONFIRM: 'confirm',
    CUSTOM: 'custom',
} as const;
export type ModalType = (typeof ModalType)[keyof typeof ModalType];

/**
 * Shared options accepted by every modal.
 */
export interface BaseModalOptions {
    /** CSS class on the modal root and used to dedupe duplicate modals. */
    className?: string;
    /** Close the modal when clicking outside it. Defaults to true. */
    closeOnOutsideClick?: boolean;
    /** Close the modal when pressing Escape. Defaults to true. */
    closeOnEscape?: boolean;
}

interface BaseModalHandlers {
    keydown?: (e: KeyboardEvent) => void;
    click?: (e: MouseEvent) => void;
}

type RequiredBaseOptions = Required<BaseModalOptions>;

/**
 * 基础模态框类
 */
export abstract class BaseModal {
    #element: HTMLElement | null = null;
    #options: RequiredBaseOptions;
    #handlers: BaseModalHandlers = {};

    constructor(options: BaseModalOptions) {
        this.#options = {
            className: '',
            closeOnOutsideClick: true,
            closeOnEscape: true,
            ...options,
        };
    }

    /**
     * Create模态框 DOM Element. Subclasses must override.
     */
    abstract create(): HTMLElement;

    /**
     * Show模态框
     * @param anchorElement - 锚点Element（用于定位）
     */
    show(anchorElement: HTMLElement | null = null): void {
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
    close(): void {
        if (this.#element) {
            this.#element.remove();
            this.#element = null;
        }

        this.#removeEventListeners();
        Logger.log('Modal', `Closed ${this.#options.className}`);
    }

    /**
     * Get模态框Element
     */
    getElement(): HTMLElement | null {
        return this.#element;
    }

    /**
     * Optional cancel hook, used by ESC / outside-click when subclass defines it.
     * Default falls back to {@link close}.
     */
    cancel?(): void;

    /**
     * 移除已存在的同类模态框
     */
    #removeExisting(): void {
        const existing = document.querySelector(`.${this.#options.className}`);
        if (existing) {
            existing.remove();
        }
    }

    /**
     * 在锚点Element附近定位
     */
    #positionNear(anchorElement: HTMLElement): void {
        if (!this.#element) return;
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
     */
    #setupEventListeners(): void {
        // ESC 键Close
        if (this.#options.closeOnEscape) {
            this.#handlers.keydown = (e: KeyboardEvent) => {
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
            this.#handlers.click = (e: MouseEvent) => {
                if (!this.#element) return;
                if (!this.#element.contains(e.target as Node | null)) {
                    // Call cancel() if available (e.g., NoteInputModal), otherwise close()
                    if (typeof this.cancel === 'function') {
                        this.cancel();
                    } else {
                        this.close();
                    }
                }
            };
            setTimeout(() => {
                if (this.#handlers.click) {
                    document.addEventListener('click', this.#handlers.click);
                }
            }, 0);
        }
    }

    /**
     * 移除EventListen器
     */
    #removeEventListeners(): void {
        if (this.#handlers.keydown) {
            document.removeEventListener('keydown', this.#handlers.keydown);
        }
        if (this.#handlers.click) {
            document.removeEventListener('click', this.#handlers.click);
        }
    }

    /**
     * 聚焦第一个可聚焦Element
     */
    #focusFirst(): void {
        if (!this.#element) return;

        const focusable = this.#element.querySelector('input, textarea, button') as HTMLElement | null;
        if (focusable) {
            // 使用 preventScroll 防止自动滚动
            focusable.focus({ preventScroll: true });
        }
    }
}

/**
 * Options for {@link NoteInputModal}.
 */
export interface NoteInputModalOptions extends BaseModalOptions {
    onSave?: (value: string) => void;
    onCancel?: () => void;
    initialValue?: string;
}

/**
 * NoteInput模态框
 */
export class NoteInputModal extends BaseModal {
    #onSave: (value: string) => void;
    #onCancel: () => void;
    #initialValue: string;

    constructor(options: NoteInputModalOptions = {}) {
        super({
            className: 'note-input-modal',
            ...options,
        });

        this.#onSave = options.onSave ?? (() => {});
        this.#onCancel = options.onCancel ?? (() => {});
        this.#initialValue = options.initialValue ?? '';
    }

    create(): HTMLElement {
        const modal = document.createElement('div');
        modal.className = 'note-input-modal';

        modal.innerHTML = `
            <textarea class="note-textarea" placeholder="${_t('web.modal.note.placeholder')}">${this.#initialValue}</textarea>
            <div class="note-input-actions">
                <button class="note-cancel">${_t('web.modal.cancel')}</button>
                <button class="note-save" disabled>${_t('web.modal.save')}</button>
            </div>
        `;

        const textarea = modal.querySelector('.note-textarea') as HTMLTextAreaElement;
        const cancelBtn = modal.querySelector('.note-cancel') as HTMLButtonElement;
        const saveBtn = modal.querySelector('.note-save') as HTMLButtonElement;

        // Update Save button state based on content
        const updateSaveButton = (): void => {
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
        const save = (): void => {
            const value = textarea.value.trim();
            if (value) {
                this.#onSave(value);
                this.close();
            }
        };

        saveBtn.addEventListener('click', save);

        // Enter Save（Shift+Enter 换行）
        textarea.addEventListener('keydown', (e: KeyboardEvent) => {
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
    cancel(): void {
        this.#onCancel();
        this.close();
    }

    /**
     * Override close to prevent direct closure (use cancel() instead)
     */
    close(): void {
        super.close();
    }
}

/**
 * Options for {@link ConfirmModal}.
 */
export interface ConfirmModalOptions extends BaseModalOptions {
    message?: string;
    onConfirm?: () => void | Promise<void>;
    onCancel?: () => void;
    confirmText?: string;
    cancelText?: string;
}

/**
 * Confirm对话框
 */
export class ConfirmModal extends BaseModal {
    #message: string;
    #onConfirm: () => void | Promise<void>;
    #onCancel: () => void;
    #confirmText: string;
    #cancelText: string;

    constructor(options: ConfirmModalOptions = {}) {
        super({
            className: 'confirm-dialog',
            ...options,
        });

        this.#message = options.message ?? _t('web.modal.confirm');
        this.#onConfirm = options.onConfirm ?? (() => {});
        this.#onCancel = options.onCancel ?? (() => {});
        this.#confirmText = options.confirmText ?? _t('web.modal.ok');
        this.#cancelText = options.cancelText ?? _t('web.modal.cancel');
    }

    create(): HTMLElement {
        const modal = document.createElement('div');
        modal.className = 'confirm-dialog';

        modal.innerHTML = `
            <p class="confirm-message">${this.#message}</p>
            <div class="confirm-actions">
                <button class="confirm-cancel">${this.#cancelText}</button>
                <button class="confirm-ok">${this.#confirmText}</button>
            </div>
        `;

        const cancelBtn = modal.querySelector('.confirm-cancel') as HTMLButtonElement;
        const okBtn = modal.querySelector('.confirm-ok') as HTMLButtonElement;

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
 * Options shared by ModalManager static helpers (adds an optional anchor).
 */
export interface AnchoredOptions {
    anchorElement?: HTMLElement | null;
}

/**
 * 模态框Management器（静态类）
 */
export class ModalManager {
    static #current: BaseModal | null = null;

    /**
     * ShowNoteInput模态框
     */
    static showNoteInput(options: NoteInputModalOptions & AnchoredOptions = {}): NoteInputModal {
        const modal = new NoteInputModal(options);
        modal.show(options.anchorElement ?? null);
        ModalManager.#current = modal;
        return modal;
    }

    /**
     * ShowConfirm对话框
     */
    static showConfirm(options: ConfirmModalOptions & AnchoredOptions = {}): ConfirmModal {
        const modal = new ConfirmModal(options);
        modal.show(options.anchorElement ?? null);
        ModalManager.#current = modal;
        return modal;
    }

    /**
     * Close当前模态框
     */
    static closeCurrent(): void {
        if (ModalManager.#current) {
            ModalManager.#current.close();
            ModalManager.#current = null;
        }
    }

    /**
     * Get当前模态框
     */
    static getCurrent(): BaseModal | null {
        return ModalManager.#current;
    }
}

/**
 * 便捷函数：ShowConfirm对话框
 */
export function showConfirmDialog(
    message: string,
    onConfirm: () => void | Promise<void>,
    anchorElement: HTMLElement | null = null,
    confirmText: string = _t('web.modal.ok'),
): ConfirmModal {
    return ModalManager.showConfirm({
        message,
        onConfirm,
        anchorElement,
        confirmText,
    });
}
