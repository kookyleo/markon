/**
 * DraggableManager - Unified drag-and-drop manager
 */

import { Logger } from '../core/utils';
import { Position } from '../services/position';

export const DEFAULT_NON_DRAG_SELECTOR = [
    'button',
    'input',
    'textarea',
    'select',
    'option',
    'a[href]',
    '[contenteditable="true"]',
    '[data-no-drag]',
].join(', ');

export const isDragBlockedTarget = (
    target: EventTarget | null,
    selector: string | null = DEFAULT_NON_DRAG_SELECTOR,
): boolean => {
    if (!selector) return false;
    if (!(target instanceof Node)) return false;
    const element = target instanceof Element ? target : target.parentElement;
    return Boolean(element?.closest(selector));
};

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
    handle?: string | HTMLElement | null;
    /** Called when the drag ends with final left/top. */
    onDragEnd?: DragEndCallback | null;
    /** When true, persists offset relative to `data-original-left/top` to `storageKey`. */
    saveOffset?: boolean;
    /** When true, restores offset relative to `data-original-left/top` from `storageKey`. */
    restoreOffset?: boolean;
    /** When true, persists the element's absolute left/top to `storageKey`. */
    savePosition?: boolean;
    /** When true, restores the element's absolute left/top from `storageKey` during init. */
    restorePosition?: boolean;
    /** Use fixed viewport coordinates instead of document coordinates. */
    fixed?: boolean;
    /** Minimum gap from viewport edges while dragging. */
    margin?: number;
    /** CSS selector for descendants that should not initiate a drag. */
    nonDragSelector?: string | null;
    /** CSS class applied to the resolved handle while this manager is alive. */
    handleClassName?: string | null;
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
    #handles: HTMLElement[] = [];
    #options: Required<DraggableOptions>;
    #isDragging = false;
    #startX = 0;
    #startY = 0;
    #initialLeft = 0;
    #initialTop = 0;
    #handlers: InternalHandlers = {};
    #previousUserSelect = '';
    #hasUserSelectOverride = false;

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
            restoreOffset: false,
            savePosition: false,
            restorePosition: false,
            fixed: false,
            margin: 10,
            nonDragSelector: DEFAULT_NON_DRAG_SELECTOR,
            handleClassName: null,
            ...options,
        };

        this.#init();
    }

    /**
     * Initialize the drag behavior.
     */
    #init(): void {
        if (typeof this.#options.handle === 'string') {
            this.#handles = Array.from(this.#element.querySelectorAll<HTMLElement>(this.#options.handle));
        } else {
            this.#handles = [this.#options.handle ?? this.#element];
        }

        if (this.#handles.length === 0) {
            Logger.warn('Draggable', 'Handle element not found');
            return;
        }

        if (this.#options.handleClassName) {
            for (const handle of this.#handles) {
                handle.classList.add(this.#options.handleClassName);
            }
        }

        if (this.#options.restorePosition) {
            this.#restorePosition();
        } else if (this.#options.restoreOffset) {
            this.#restoreOffset();
        }

        // Mouse events
        this.#handlers.mousedown = (e: MouseEvent) => this.#onDragStart(e);
        this.#handlers.mousemove = (e: MouseEvent) => this.#onDragmove(e);
        this.#handlers.mouseup = () => this.#onDragEnd();

        // Touch events
        this.#handlers.touchstart = (e: TouchEvent) => this.#onDragStart(e);
        this.#handlers.touchmove = (e: TouchEvent) => this.#onDragmove(e);
        this.#handlers.touchend = () => this.#onDragEnd();

        for (const handle of this.#handles) {
            handle.addEventListener('mousedown', this.#handlers.mousedown);
            handle.addEventListener('touchstart', this.#handlers.touchstart, { passive: false });
        }
    }

    /**
     * Begin a drag.
     */
    #onDragStart(e: MouseEvent | TouchEvent): void {
        if (e instanceof MouseEvent && e.button !== 0) return;
        if (isDragBlockedTarget(e.target, this.#options.nonDragSelector)) return;

        this.#isDragging = true;

        const point = this.#extractPoint(e);
        this.#startX = point.x;
        this.#startY = point.y;

        const initial = this.#materializePosition();
        this.#initialLeft = initial.left;
        this.#initialTop = initial.top;

        this.#element.style.cursor = 'grabbing';
        for (const handle of this.#handles) {
            handle.classList.add('is-dragging');
        }
        this.#previousUserSelect = document.body.style.userSelect;
        this.#hasUserSelectOverride = true;
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
        const dx = point.x - this.#startX;
        const dy = point.y - this.#startY;

        // Compute the new position
        let newLeft = this.#initialLeft + dx;
        let newTop = this.#initialTop + dy;

        ({ left: newLeft, top: newTop } = Position.constrainToViewport(
            newLeft,
            newTop,
            this.#element.offsetWidth,
            this.#element.offsetHeight,
            { fixed: this.#options.fixed, margin: this.#options.margin },
        ));

        this.#writePosition(newLeft, newTop);
    }

    /**
     * Finish a drag.
     */
    #onDragEnd(): void {
        if (!this.#isDragging) return;

        this.#isDragging = false;
        this.#element.style.cursor = ''; // restore the CSS default cursor
        for (const handle of this.#handles) {
            handle.classList.remove('is-dragging');
        }
        if (this.#hasUserSelectOverride) {
            document.body.style.userSelect = this.#previousUserSelect;
            this.#hasUserSelectOverride = false;
        }

        // Detach global listeners
        if (this.#handlers.mousemove) document.removeEventListener('mousemove', this.#handlers.mousemove);
        if (this.#handlers.mouseup) document.removeEventListener('mouseup', this.#handlers.mouseup);
        if (this.#handlers.touchmove) document.removeEventListener('touchmove', this.#handlers.touchmove);
        if (this.#handlers.touchend) document.removeEventListener('touchend', this.#handlers.touchend);

        // Persist the offset
        if (this.#options.saveOffset && this.#options.storageKey) {
            this.#saveOffset();
        }

        if (this.#options.savePosition && this.#options.storageKey) {
            this.#savePosition();
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
        const originalLeft = parseFloat(this.#element.dataset['originalLeft'] ?? '');
        const originalTop = parseFloat(this.#element.dataset['originalTop'] ?? '');

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
     * Restore an offset relative to data-original-left/top from localStorage.
     */
    #restoreOffset(): void {
        if (!this.#options.storageKey) return;
        const originalLeft = parseFloat(this.#element.dataset['originalLeft'] ?? '');
        const originalTop = parseFloat(this.#element.dataset['originalTop'] ?? '');
        if (!Number.isFinite(originalLeft) || !Number.isFinite(originalTop)) return;

        try {
            const raw: unknown = JSON.parse(localStorage.getItem(this.#options.storageKey) || 'null');
            if (!raw || typeof raw !== 'object') return;
            const obj = raw as Record<string, unknown>;
            const dx = typeof obj['dx'] === 'number' ? obj['dx'] : 0;
            const dy = typeof obj['dy'] === 'number' ? obj['dy'] : 0;
            if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;

            const constrained = Position.constrainToViewport(
                originalLeft + dx,
                originalTop + dy,
                this.#element.offsetWidth,
                this.#element.offsetHeight,
                { fixed: this.#options.fixed, margin: this.#options.margin },
            );
            this.#writePosition(constrained.left, constrained.top);
        } catch {
            // Ignore bad localStorage values and keep the anchor-relative placement.
        }
    }

    /**
     * Persist the element's current viewport/document position to localStorage.
     */
    #savePosition(): void {
        if (!this.#options.storageKey) return;
        const finalLeft = parseFloat(this.#element.style.left);
        const finalTop = parseFloat(this.#element.style.top);
        if (!Number.isFinite(finalLeft) || !Number.isFinite(finalTop)) return;
        localStorage.setItem(this.#options.storageKey, JSON.stringify({ left: finalLeft, top: finalTop }));
        Logger.log('Draggable', `Saved position to ${this.#options.storageKey}`);
    }

    /**
     * Restore a previously saved left/top position.
     */
    #restorePosition(): void {
        if (!this.#options.storageKey) return;
        try {
            const raw: unknown = JSON.parse(localStorage.getItem(this.#options.storageKey) || 'null');
            if (!raw || typeof raw !== 'object') return;
            const obj = raw as Record<string, unknown>;
            const left = typeof obj['left'] === 'number' ? obj['left'] : obj['x'];
            const top = typeof obj['top'] === 'number' ? obj['top'] : obj['y'];
            if (typeof left !== 'number' || typeof top !== 'number') return;

            const constrained = Position.constrainToViewport(
                left,
                top,
                this.#element.offsetWidth,
                this.#element.offsetHeight,
                { fixed: this.#options.fixed, margin: this.#options.margin },
            );
            this.#writePosition(constrained.left, constrained.top);
        } catch {
            // Ignore bad localStorage values and fall back to CSS placement.
        }
    }

    /**
     * Convert the element's current rendered rect into explicit left/top CSS.
     */
    #materializePosition(): { left: number; top: number } {
        const rect = this.#element.getBoundingClientRect();
        const scrollX = this.#options.fixed ? 0 : (window.scrollX || window.pageXOffset);
        const scrollY = this.#options.fixed ? 0 : (window.scrollY || window.pageYOffset);
        const styledLeft = parseFloat(this.#element.style.left);
        const styledTop = parseFloat(this.#element.style.top);
        const left = Number.isFinite(styledLeft) ? styledLeft : rect.left + scrollX;
        const top = Number.isFinite(styledTop) ? styledTop : rect.top + scrollY;
        this.#writePosition(left, top);
        return { left, top };
    }

    #writePosition(left: number, top: number): void {
        this.#element.style.position = this.#options.fixed ? 'fixed' : 'absolute';
        this.#element.style.left = `${left}px`;
        this.#element.style.top = `${top}px`;
        this.#element.style.right = 'auto';
        this.#element.style.bottom = 'auto';
        this.#element.style.margin = '0';
        this.#element.style.transform = 'none';
    }

    /**
     * Extract page coordinates from a mouse or touch event.
     */
    #extractPoint(e: MouseEvent | TouchEvent): { x: number; y: number } {
        if (e.type === 'touchstart' || e.type === 'touchmove') {
            const touchEvent = e as TouchEvent;
            const touch = touchEvent.touches[0] ?? touchEvent.changedTouches[0];
            if (!touch) {
                const pos = this.#materializePosition();
                return { x: pos.left, y: pos.top };
            }
            return this.#options.fixed
                ? { x: touch.clientX, y: touch.clientY }
                : { x: touch.pageX, y: touch.pageY };
        }
        const mouse = e as MouseEvent;
        return this.#options.fixed
            ? { x: mouse.clientX, y: mouse.clientY }
            : { x: mouse.pageX, y: mouse.pageY };
    }

    /**
     * Tear down the drag behavior.
     */
    destroy(): void {
        for (const handle of this.#handles) {
            if (this.#handlers.mousedown) handle.removeEventListener('mousedown', this.#handlers.mousedown);
            if (this.#handlers.touchstart) handle.removeEventListener('touchstart', this.#handlers.touchstart);
            if (this.#options.handleClassName) handle.classList.remove(this.#options.handleClassName);
            handle.classList.remove('is-dragging');
        }

        // Detach global listeners if a drag is still active.
        if (this.#isDragging) {
            if (this.#handlers.mousemove) document.removeEventListener('mousemove', this.#handlers.mousemove);
            if (this.#handlers.mouseup) document.removeEventListener('mouseup', this.#handlers.mouseup);
            if (this.#handlers.touchmove) document.removeEventListener('touchmove', this.#handlers.touchmove);
            if (this.#handlers.touchend) document.removeEventListener('touchend', this.#handlers.touchend);
        }

        this.#element.style.cursor = '';
        if (this.#hasUserSelectOverride) {
            document.body.style.userSelect = this.#previousUserSelect;
            this.#hasUserSelectOverride = false;
        }
        Logger.log('Draggable', 'Destroyed');
    }
}
