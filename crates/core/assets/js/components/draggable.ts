/**
 * DraggableManager - Unified drag-and-drop manager
 */

import { Logger } from '../core/utils';
import { Position } from '../services/position';

/**
 * Callback fired when a drag ends, with the element's final left/top.
 */
export type DragEndCallback = (left: number, top: number) => void;

/**
 * Configuration options for {@link DraggableManager}.
 */
export interface DraggableOptions {
    /** localStorage key used to persist drag offset (only when {@link saveOffset} is true). */
    storageKey?: string | null;
    /** CSS selector for an inner drag handle (defaults to the whole element). */
    handle?: string | null;
    /** Called when the drag ends with final left/top. */
    onDragEnd?: DragEndCallback | null;
    /** When true, persists offset relative to `data-original-left/top` to `storageKey`. */
    saveOffset?: boolean;
}

interface InternalHandlers {
    mousedown?: (e: MouseEvent) => void;
    mousemove?: (e: MouseEvent) => void;
    mouseup?: (e: MouseEvent) => void;
    touchstart?: (e: TouchEvent) => void;
    touchmove?: (e: TouchEvent) => void;
    touchend?: (e: TouchEvent) => void;
}

/**
 * Drag-and-drop manager class.
 */
export class DraggableManager {
    #element: HTMLElement;
    #handle: HTMLElement | null = null;
    #options: Required<DraggableOptions>;
    #isDragging = false;
    #startX = 0;
    #startY = 0;
    #initialLeft = 0;
    #initialTop = 0;
    #handlers: InternalHandlers = {};

    /**
     * @param element - the element to make draggable
     * @param options - configuration options
     */
    constructor(element: HTMLElement, options: DraggableOptions = {}) {
        this.#element = element;
        this.#options = {
            storageKey: null,
            handle: null,
            onDragEnd: null,
            saveOffset: false,
            ...options,
        };

        this.#init();
    }

    /**
     * Initialize the drag behavior.
     */
    #init(): void {
        this.#handle = this.#options.handle
            ? (this.#element.querySelector(this.#options.handle) as HTMLElement | null)
            : this.#element;

        if (!this.#handle) {
            Logger.warn('Draggable', 'Handle element not found');
            return;
        }

        // Do not set cursor here; rely on the CSS default (grab).

        // Mouse events
        this.#handlers.mousedown = (e: MouseEvent) => this.#onDragStart(e);
        this.#handlers.mousemove = (e: MouseEvent) => this.#onDragmove(e);
        this.#handlers.mouseup = () => this.#onDragEnd();

        // Touch events
        this.#handlers.touchstart = (e: TouchEvent) => this.#onDragStart(e);
        this.#handlers.touchmove = (e: TouchEvent) => this.#onDragmove(e);
        this.#handlers.touchend = () => this.#onDragEnd();

        this.#handle.addEventListener('mousedown', this.#handlers.mousedown);
        this.#handle.addEventListener('touchstart', this.#handlers.touchstart, { passive: false });
    }

    /**
     * Begin a drag.
     */
    #onDragStart(e: MouseEvent | TouchEvent): void {
        // Skip when the press target is a button/input control.
        const target = e.target as Element | null;
        if (target && (target.tagName === 'BUTTON' || target.tagName === 'INPUT')) {
            return;
        }

        this.#isDragging = true;

        const point = this.#extractPoint(e);
        this.#startX = point.pageX;
        this.#startY = point.pageY;

        // Read the initial position from style.left/top because we use absolute positioning.
        this.#initialLeft = parseFloat(this.#element.style.left) || 0;
        this.#initialTop = parseFloat(this.#element.style.top) || 0;

        this.#element.style.cursor = 'grabbing';
        document.body.style.userSelect = 'none';

        // Attach global listeners
        if (this.#handlers.mousemove) document.addEventListener('mousemove', this.#handlers.mousemove);
        if (this.#handlers.mouseup) document.addEventListener('mouseup', this.#handlers.mouseup);
        if (this.#handlers.touchmove) document.addEventListener('touchmove', this.#handlers.touchmove, { passive: false });
        if (this.#handlers.touchend) document.addEventListener('touchend', this.#handlers.touchend);

        e.preventDefault();
    }

    /**
     * Mid-drag handler.
     */
    #onDragmove(e: MouseEvent | TouchEvent): void {
        if (!this.#isDragging) return;

        const point = this.#extractPoint(e);
        const dx = point.pageX - this.#startX;
        const dy = point.pageY - this.#startY;

        // Compute the new position
        let newLeft = this.#initialLeft + dx;
        let newTop = this.#initialTop + dy;

        ({ left: newLeft, top: newTop } = Position.constrainToViewport(
            newLeft,
            newTop,
            this.#element.offsetWidth,
            this.#element.offsetHeight,
        ));

        this.#element.style.left = `${newLeft}px`;
        this.#element.style.top = `${newTop}px`;
    }

    /**
     * Finish a drag.
     */
    #onDragEnd(): void {
        if (!this.#isDragging) return;

        this.#isDragging = false;
        this.#element.style.cursor = ''; // restore the CSS default cursor
        document.body.style.userSelect = '';

        // Detach global listeners
        if (this.#handlers.mousemove) document.removeEventListener('mousemove', this.#handlers.mousemove);
        if (this.#handlers.mouseup) document.removeEventListener('mouseup', this.#handlers.mouseup);
        if (this.#handlers.touchmove) document.removeEventListener('touchmove', this.#handlers.touchmove);
        if (this.#handlers.touchend) document.removeEventListener('touchend', this.#handlers.touchend);

        // Persist the offset
        if (this.#options.saveOffset && this.#options.storageKey) {
            this.#saveOffset();
        }

        // Fire callback
        if (this.#options.onDragEnd) {
            const finalLeft = parseFloat(this.#element.style.left) || 0;
            const finalTop = parseFloat(this.#element.style.top) || 0;
            this.#options.onDragEnd(finalLeft, finalTop);
        }
    }

    /**
     * Persist the offset to localStorage.
     */
    #saveOffset(): void {
        // Use style.left/top rather than offsetLeft/Top because the element is absolutely positioned.
        const finalLeft = parseFloat(this.#element.style.left) || 0;
        const finalTop = parseFloat(this.#element.style.top) || 0;
        const originalLeft = parseFloat(this.#element.dataset.originalLeft ?? '');
        const originalTop = parseFloat(this.#element.dataset.originalTop ?? '');

        if (!isNaN(originalLeft) && !isNaN(originalTop) && this.#options.storageKey) {
            const offset = {
                dx: finalLeft - originalLeft,
                dy: finalTop - originalTop,
            };
            localStorage.setItem(this.#options.storageKey, JSON.stringify(offset));
            Logger.log('Draggable', `Saved offset to ${this.#options.storageKey}:`, offset);
        }
    }

    /**
     * Extract page coordinates from a mouse or touch event.
     */
    #extractPoint(e: MouseEvent | TouchEvent): { pageX: number; pageY: number } {
        if (e.type === 'touchstart' || e.type === 'touchmove') {
            const touch = (e as TouchEvent).touches[0];
            return { pageX: touch.pageX, pageY: touch.pageY };
        }
        const mouse = e as MouseEvent;
        return { pageX: mouse.pageX, pageY: mouse.pageY };
    }

    /**
     * Tear down the drag behavior.
     */
    destroy(): void {
        if (this.#handle) {
            if (this.#handlers.mousedown) this.#handle.removeEventListener('mousedown', this.#handlers.mousedown);
            if (this.#handlers.touchstart) this.#handle.removeEventListener('touchstart', this.#handlers.touchstart);
        }

        // Detach global listeners if a drag is still active.
        if (this.#isDragging) {
            if (this.#handlers.mousemove) document.removeEventListener('mousemove', this.#handlers.mousemove);
            if (this.#handlers.mouseup) document.removeEventListener('mouseup', this.#handlers.mouseup);
            if (this.#handlers.touchmove) document.removeEventListener('touchmove', this.#handlers.touchmove);
            if (this.#handlers.touchend) document.removeEventListener('touchend', this.#handlers.touchend);
        }

        this.#element.style.cursor = '';
        Logger.log('Draggable', 'Destroyed');
    }
}
