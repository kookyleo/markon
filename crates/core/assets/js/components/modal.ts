/**
 * ModalManager - Unified modal manager
 * Eliminates duplication between addNote / editNote / showConfirmDialog.
 */

import { Logger } from '../core/utils';
import { CONFIG } from '../core/config';
import { Position } from '../services/position';
import { DraggableManager, DEFAULT_NON_DRAG_SELECTOR } from './draggable';

const _t: (k: string, ...args: unknown[]) => string =
    (window.__MARKON_I18N__?.t) || ((k: string) => k);

type ModalDragStorageMode = 'position' | 'offset';

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
    /** Whether the modal can be dragged. Defaults to true for glass-frame popups. */
    draggable?: boolean;
    /** CSS selector or element that drags the modal frame. Defaults to the glass frame itself. */
    dragHandle?: string | HTMLElement | null;
    /** localStorage key used to remember this modal's last dragged position. */
    dragStorageKey?: string | null;
    /** Whether drag persistence stores an absolute position or anchor-relative offset. */
    dragStorageMode?: ModalDragStorageMode;
}

interface BaseModalHandlers {
    keydown?: (e: KeyboardEvent) => void;
    click?: (e: MouseEvent) => void;
}

type RequiredBaseOptions = Required<BaseModalOptions>;

export interface ModalDragOptions {
    /** CSS selector or element that should initiate dragging. */
    handle: string | HTMLElement;
    /** localStorage key used to remember the last position. */
    storageKey?: string | null;
    /** Drag persistence mode. Defaults to absolute position. */
    storageMode?: ModalDragStorageMode;
    /** Descendant selector that should not initiate a drag. */
    nonDragSelector?: string | null;
    /** Minimum viewport gap while dragging. Defaults to 10px. */
    margin?: number;
}

export const MODAL_DRAG_HANDLE_CLASS = 'markon-modal-drag-handle';
export const MODAL_FRAME_DRAG_REGION_SELECTOR = '.markon-modal-frame-drag-region';

const MODAL_FRAME_NON_DRAG_SELECTOR = `${DEFAULT_NON_DRAG_SELECTOR}, .markon-modal-frame > *`;

export const renderModalFrameDragRegions = (): string => `
    <span class="markon-modal-frame-drag-region markon-modal-frame-drag-top" aria-hidden="true"></span>
    <span class="markon-modal-frame-drag-region markon-modal-frame-drag-right" aria-hidden="true"></span>
    <span class="markon-modal-frame-drag-region markon-modal-frame-drag-bottom" aria-hidden="true"></span>
    <span class="markon-modal-frame-drag-region markon-modal-frame-drag-left" aria-hidden="true"></span>
`;

export const makeModalDraggable = (element: HTMLElement, options: ModalDragOptions): DraggableManager =>
    new DraggableManager(element, {
        handle: options.handle,
        storageKey: options.storageKey ?? null,
        saveOffset: options.storageMode === 'offset' && Boolean(options.storageKey),
        restoreOffset: options.storageMode === 'offset' && Boolean(options.storageKey),
        savePosition: (options.storageMode ?? 'position') === 'position' && Boolean(options.storageKey),
        restorePosition: (options.storageMode ?? 'position') === 'position' && Boolean(options.storageKey),
        fixed: true,
        margin: options.margin ?? 10,
        nonDragSelector: options.nonDragSelector ?? DEFAULT_NON_DRAG_SELECTOR,
        handleClassName: MODAL_DRAG_HANDLE_CLASS,
    });

/**
 * Base modal class.
 */
export abstract class BaseModal {
    #element: HTMLElement | null = null;
    #options: RequiredBaseOptions;
    #handlers: BaseModalHandlers = {};
    #draggable: DraggableManager | null = null;

    constructor(options: BaseModalOptions) {
        this.#options = {
            className: '',
            closeOnOutsideClick: true,
            closeOnEscape: true,
            draggable: true,
            dragHandle: null,
            dragStorageKey: null,
            dragStorageMode: 'position',
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
        // role+aria-modal so screen readers announce it as a dialog.
        // Subclasses that already set these attributes win because
        // `setAttribute` here would clobber a more specific value.
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

        if (this.#options.draggable) {
            const handle = this.#options.dragHandle ?? this.#element;
            this.#draggable = makeModalDraggable(this.#element, {
                handle,
                storageKey: this.#options.dragStorageKey,
                storageMode: this.#options.dragStorageMode,
                nonDragSelector: this.#options.dragHandle
                    ? DEFAULT_NON_DRAG_SELECTOR
                    : MODAL_FRAME_NON_DRAG_SELECTOR,
            });
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
            this.#draggable?.destroy();
            this.#draggable = null;
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
     * Optional cancel hook, used by Esc / outside-click when subclass defines it.
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
        this.#element.dataset['originalLeft'] = String(left);
        this.#element.dataset['originalTop'] = String(top);
    }

    /**
     * Install the keydown / outside-click event listeners.
     */
    #setupEventListeners(): void {
        // Esc closes the modal.
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

        const focusable = this.#element.querySelector<HTMLElement>('input, textarea, button');
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
    #resizeObserver: ResizeObserver | null = null;
    #sizeTrackingReady = false;

    constructor(options: NoteInputModalOptions = {}) {
        super({
            className: 'note-input-modal',
            dragHandle: '.note-input-drag-region',
            dragStorageKey: CONFIG.STORAGE_KEYS.NOTE_INPUT_OFFSET,
            dragStorageMode: 'offset',
            ...options,
        });

        this.#onSave = options.onSave ?? (() => {});
        this.#onCancel = options.onCancel ?? (() => {});
        this.#initialValue = options.initialValue ?? '';
    }

    override show(anchorElement: HTMLElement | null = null): void {
        super.show(anchorElement);
        const modal = this.getElement();
        if (!modal) return;
        this.#restoreSize(modal);
        this.#constrainCurrentPosition(modal);
        this.#observeSize(modal);
    }

    override close(): void {
        this.#resizeObserver?.disconnect();
        this.#resizeObserver = null;
        this.#sizeTrackingReady = false;
        super.close();
    }

    create(): HTMLElement {
        const modal = document.createElement('div');
        modal.className = 'note-input-modal markon-modal-frame';

        modal.innerHTML = `
            <span class="note-input-drag-region note-input-drag-top" aria-hidden="true"></span>
            <span class="note-input-drag-region note-input-drag-right" aria-hidden="true"></span>
            <span class="note-input-drag-region note-input-drag-bottom" aria-hidden="true"></span>
            <span class="note-input-drag-region note-input-drag-left" aria-hidden="true"></span>
            <div class="note-input-field">
                <textarea class="note-textarea" placeholder="${_t('web.modal.note.placeholder')}"></textarea>
                <div class="note-input-actions">
                    <button class="note-cancel" type="button" title="${_t('web.modal.cancel')}" aria-label="${_t('web.modal.cancel')}">
                        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                            <path d="M6 6l12 12M18 6L6 18"></path>
                        </svg>
                    </button>
                    <button class="note-save" type="button" title="${_t('web.modal.save')}" aria-label="${_t('web.modal.save')}" disabled>
                        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                            <path d="M12 19V5M6.5 10.5 12 5l5.5 5.5"></path>
                        </svg>
                    </button>
                </div>
            </div>
        `;

        const textarea = modal.querySelector('.note-textarea') as HTMLTextAreaElement;
        // Assign the (possibly peer-supplied, in shared mode) note text via
        // .value, never string-interpolated into innerHTML — a note containing
        // </textarea>… would otherwise break out and inject markup.
        textarea.value = this.#initialValue;
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
    override cancel(): void {
        this.#onCancel();
        this.close();
    }

    #restoreSize(modal: HTMLElement): void {
        try {
            const raw: unknown = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.NOTE_INPUT_SIZE) || 'null');
            if (!raw || typeof raw !== 'object') return;
            const saved = raw as Record<string, unknown>;
            const width = typeof saved['width'] === 'number' ? saved['width'] : NaN;
            const height = typeof saved['height'] === 'number' ? saved['height'] : NaN;
            if (!Number.isFinite(width) || !Number.isFinite(height)) return;

            const { width: nextWidth, height: nextHeight } = this.#clampSize(modal, width, height);
            modal.style.width = `${nextWidth}px`;
            modal.style.height = `${nextHeight}px`;
        } catch {
            // Ignore invalid stored size and keep the CSS default.
        }
    }

    #observeSize(modal: HTMLElement): void {
        if (typeof ResizeObserver === 'undefined') return;

        let lastWidth = Math.round(modal.offsetWidth);
        let lastHeight = Math.round(modal.offsetHeight);
        this.#sizeTrackingReady = false;
        window.setTimeout(() => {
            this.#sizeTrackingReady = true;
        }, 0);

        this.#resizeObserver = new ResizeObserver(() => {
            if (!this.#sizeTrackingReady) {
                lastWidth = Math.round(modal.offsetWidth);
                lastHeight = Math.round(modal.offsetHeight);
                return;
            }

            const width = Math.round(modal.offsetWidth);
            const height = Math.round(modal.offsetHeight);
            if (Math.abs(width - lastWidth) < 2 && Math.abs(height - lastHeight) < 2) return;
            lastWidth = width;
            lastHeight = height;
            localStorage.setItem(CONFIG.STORAGE_KEYS.NOTE_INPUT_SIZE, JSON.stringify({ width, height }));
            this.#constrainCurrentPosition(modal);
        });
        this.#resizeObserver.observe(modal);
    }

    #clampSize(modal: HTMLElement, width: number, height: number): { width: number; height: number } {
        const style = getComputedStyle(modal);
        const minWidth = parseFloat(style.minWidth) || 0;
        const minHeight = parseFloat(style.minHeight) || 0;
        const maxWidth = Math.max(minWidth, window.innerWidth - 24);
        const maxHeight = Math.max(minHeight, window.innerHeight - 24);
        return {
            width: Math.min(Math.max(width, minWidth), maxWidth),
            height: Math.min(Math.max(height, minHeight), maxHeight),
        };
    }

    #constrainCurrentPosition(modal: HTMLElement): void {
        const left = parseFloat(modal.style.left);
        const top = parseFloat(modal.style.top);
        if (!Number.isFinite(left) || !Number.isFinite(top)) return;

        const constrained = Position.constrainToViewport(
            left,
            top,
            modal.offsetWidth,
            modal.offsetHeight,
            { fixed: true, margin: 10 },
        );
        modal.style.left = `${constrained.left}px`;
        modal.style.top = `${constrained.top}px`;
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
        modal.className = 'confirm-dialog markon-modal-frame';

        modal.innerHTML = `
            <p class="confirm-message"></p>
            <div class="confirm-actions">
                <button class="confirm-cancel">${this.#cancelText}</button>
                <button class="confirm-ok">${this.#confirmText}</button>
            </div>
        `;
        // Set the message as text, not interpolated HTML.
        (modal.querySelector('.confirm-message') as HTMLElement).textContent = this.#message;

        const cancelBtn = modal.querySelector('.confirm-cancel') as HTMLButtonElement;
        const okBtn = modal.querySelector('.confirm-ok') as HTMLButtonElement;

        cancelBtn.addEventListener('click', () => {
            this.#onCancel();
            this.close();
        });

        okBtn.addEventListener('click', () => {
            Logger.log('ConfirmModal', 'OK button clicked, executing callback');
            void (async () => {
                try {
                    await this.#onConfirm();
                    Logger.log('ConfirmModal', 'Callback completed successfully');
                } catch (error) {
                    Logger.error('ConfirmModal', 'Callback failed:', error);
                }
                this.close();
            })();
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
    /**
     * Show a note-input modal.
     */
    static showNoteInput(options: NoteInputModalOptions & AnchoredOptions = {}): NoteInputModal {
        const modal = new NoteInputModal(options);
        modal.show(options.anchorElement ?? null);
        return modal;
    }

    /**
     * Show a confirm dialog.
     */
    static showConfirm(options: ConfirmModalOptions & AnchoredOptions = {}): ConfirmModal {
        const modal = new ConfirmModal(options);
        modal.show(options.anchorElement ?? null);
        return modal;
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
