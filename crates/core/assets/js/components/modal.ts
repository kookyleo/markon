/**
 * ModalManager - Unified modal manager
 * Eliminates duplication between addNote / editNote / showConfirmDialog.
 */

import { Logger } from '../core/utils';
import { Position } from '../services/position';

const _t: (k: string, ...args: unknown[]) => string =
    (window.__MARKON_I18N__ && window.__MARKON_I18N__.t) || ((k: string) => k);

/**
 * Modal type enum.
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
 * Base modal class.
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
     * Build the modal DOM element. Subclasses must override.
     */
    abstract create(): HTMLElement;

    /**
     * Show the modal.
     * @param anchorElement - anchor used for positioning, if any.
     */
    show(anchorElement: HTMLElement | null = null): void {
        // Remove any existing modal of the same class first.
        this.#removeExisting();

        this.#element = this.create();
        // Assistive-tech semantics: anything we surface as a modal needs
        // role+aria-modal so screen readers announce it as a dialog and the
        // focus trap (see #setupEventListeners → tab-key cycling) is
        // discoverable. Subclasses that already set these attributes win
        // because `setAttribute` here would clobber a more specific value.
        if (!this.#element.hasAttribute('role')) {
            this.#element.setAttribute('role', 'dialog');
        }
        if (!this.#element.hasAttribute('aria-modal')) {
            this.#element.setAttribute('aria-modal', 'true');
        }
        document.body.appendChild(this.#element);

        if (anchorElement) {
            this.#positionNear(anchorElement);
        }

        this.#setupEventListeners();

        // Move focus into the modal on the next tick.
        setTimeout(() => this.#focusFirst(), 0);

        Logger.log('Modal', `Showed ${this.#options.className}`);
    }

    /**
     * Close the modal.
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
     * Get the modal element.
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
     * Remove any pre-existing modal that shares this class.
     */
    #removeExisting(): void {
        const existing = document.querySelector(`.${this.#options.className}`);
        if (existing) {
            existing.remove();
        }
    }

    /**
     * Position the modal near the anchor element.
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
     * Install the keydown / outside-click event listeners.
     */
    #setupEventListeners(): void {
        // ESC closes the modal.
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

        // Click outside the modal closes it.
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
     * Detach the event listeners installed by #setupEventListeners.
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
     * Focus the first focusable element inside the modal.
     */
    #focusFirst(): void {
        if (!this.#element) return;

        const focusable = this.#element.querySelector('input, textarea, button') as HTMLElement | null;
        if (focusable) {
            // preventScroll keeps the page in place while we move focus in.
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
 * Note input modal.
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

        // Pre-select the existing value so typing replaces it instead of appending.
        if (this.#initialValue) {
            setTimeout(() => textarea.select(), 0);
        }

        // Cancel button.
        cancelBtn.addEventListener('click', () => {
            this.#onCancel();
            this.close();
        });

        // Save button.
        const save = (): void => {
            const value = textarea.value.trim();
            if (value) {
                this.#onSave(value);
                this.close();
            }
        };

        saveBtn.addEventListener('click', save);

        // Enter saves; Shift+Enter inserts a newline.
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
 * Confirm dialog.
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
 * Modal manager (static class).
 */
export class ModalManager {
    static #current: BaseModal | null = null;

    /**
     * Show a note-input modal.
     */
    static showNoteInput(options: NoteInputModalOptions & AnchoredOptions = {}): NoteInputModal {
        const modal = new NoteInputModal(options);
        modal.show(options.anchorElement ?? null);
        ModalManager.#current = modal;
        return modal;
    }

    /**
     * Show a confirm dialog.
     */
    static showConfirm(options: ConfirmModalOptions & AnchoredOptions = {}): ConfirmModal {
        const modal = new ConfirmModal(options);
        modal.show(options.anchorElement ?? null);
        ModalManager.#current = modal;
        return modal;
    }

    /**
     * Close the currently-open modal, if any.
     */
    static closeCurrent(): void {
        if (ModalManager.#current) {
            ModalManager.#current.close();
            ModalManager.#current = null;
        }
    }

    /**
     * Get the currently-open modal, if any.
     */
    static getCurrent(): BaseModal | null {
        return ModalManager.#current;
    }
}

/**
 * Convenience function: show a confirm dialog.
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
