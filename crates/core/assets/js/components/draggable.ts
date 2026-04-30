/**
 * DraggableManager - Unified drag-and-drop manager
 * Eliminate makePopoverDraggable 和 makeDraggable betweencode duplication
 */

import { Logger } from '../core/utils';
import { Position } from '../services/position';

/**
 * Callback fired when dragging starts. Receives the originating event.
 */
export type DragStartCallback = (e: MouseEvent | TouchEvent) => void;

/**
 * Callback fired during a drag, with delta from the drag origin.
 */
export type DragMoveCallback = (dx: number, dy: number) => void;

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
    /** Called when the drag starts. */
    onDragStart?: DragStartCallback | null;
    /** Called repeatedly during drag with delta from the drag origin. */
    onDragmove?: DragMoveCallback | null;
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

type Required<T> = { [K in keyof T]-?: T[K] };

/**
 * 拖拽Management器类
 */
export class DraggableManager {
    #element: HTMLElement;
    #options: Required<DraggableOptions>;
    #isDragging = false;
    #startX = 0;
    #startY = 0;
    #initialLeft = 0;
    #initialTop = 0;
    #handlers: InternalHandlers = {};

    /**
     * @param element - 要使其可拖拽的Element
     * @param options - ConfigurationOptions
     */
    constructor(element: HTMLElement, options: DraggableOptions = {}) {
        this.#element = element;
        this.#options = {
            storageKey: null,
            handle: null,
            onDragStart: null,
            onDragmove: null,
            onDragEnd: null,
            saveOffset: false,
            ...options,
        };

        this.#init();
    }

    /**
     * Initialize拖拽功能
     */
    #init(): void {
        const handle: HTMLElement | null = this.#options.handle
            ? (this.#element.querySelector(this.#options.handle) as HTMLElement | null)
            : this.#element;

        if (!handle) {
            Logger.warn('Draggable', 'Handle element not found');
            return;
        }

        // 不Settings cursor，使用 CSS 中的默认样式（grab）

        // 鼠标Event
        this.#handlers.mousedown = (e: MouseEvent) => this.#onDragStart(e);
        this.#handlers.mousemove = (e: MouseEvent) => this.#onDragmove(e);
        this.#handlers.mouseup = () => this.#onDragEnd();

        // 触摸Event
        this.#handlers.touchstart = (e: TouchEvent) => this.#onDragStart(e);
        this.#handlers.touchmove = (e: TouchEvent) => this.#onDragmove(e);
        this.#handlers.touchend = () => this.#onDragEnd();

        handle.addEventListener('mousedown', this.#handlers.mousedown);
        handle.addEventListener('touchstart', this.#handlers.touchstart, { passive: false });
    }

    /**
     * Start拖拽
     */
    #onDragStart(e: MouseEvent | TouchEvent): void {
        // 如果点击的是Button，不进行拖拽
        const target = e.target as Element | null;
        if (target && (target.tagName === 'BUTTON' || target.tagName === 'INPUT')) {
            return;
        }

        this.#isDragging = true;

        const point = this.#extractPoint(e, 'start');
        this.#startX = point.pageX;
        this.#startY = point.pageY;

        // 从 style.left/top Parse位置，因为我们使用绝对定位
        this.#initialLeft = parseFloat(this.#element.style.left) || 0;
        this.#initialTop = parseFloat(this.#element.style.top) || 0;

        this.#element.style.cursor = 'grabbing';
        document.body.style.userSelect = 'none';

        // 添加全局Listen器
        if (this.#handlers.mousemove) document.addEventListener('mousemove', this.#handlers.mousemove);
        if (this.#handlers.mouseup) document.addEventListener('mouseup', this.#handlers.mouseup);
        if (this.#handlers.touchmove) document.addEventListener('touchmove', this.#handlers.touchmove, { passive: false });
        if (this.#handlers.touchend) document.addEventListener('touchend', this.#handlers.touchend);

        e.preventDefault();

        // TriggerCallback
        if (this.#options.onDragStart) {
            this.#options.onDragStart(e);
        }
    }

    /**
     * 拖拽中
     */
    #onDragmove(e: MouseEvent | TouchEvent): void {
        if (!this.#isDragging) return;

        const point = this.#extractPoint(e, 'move');
        const dx = point.pageX - this.#startX;
        const dy = point.pageY - this.#startY;

        // Calculate新位置
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

        // TriggerCallback
        if (this.#options.onDragmove) {
            this.#options.onDragmove(dx, dy);
        }
    }

    /**
     * End拖拽
     */
    #onDragEnd(): void {
        if (!this.#isDragging) return;

        this.#isDragging = false;
        this.#element.style.cursor = ''; // Reset回 CSS 默认样式
        document.body.style.userSelect = '';

        // 移除全局Listen器
        if (this.#handlers.mousemove) document.removeEventListener('mousemove', this.#handlers.mousemove);
        if (this.#handlers.mouseup) document.removeEventListener('mouseup', this.#handlers.mouseup);
        if (this.#handlers.touchmove) document.removeEventListener('touchmove', this.#handlers.touchmove);
        if (this.#handlers.touchend) document.removeEventListener('touchend', this.#handlers.touchend);

        // Save偏移量
        if (this.#options.saveOffset && this.#options.storageKey) {
            this.#saveOffset();
        }

        // TriggerCallback
        if (this.#options.onDragEnd) {
            const finalLeft = parseFloat(this.#element.style.left) || 0;
            const finalTop = parseFloat(this.#element.style.top) || 0;
            this.#options.onDragEnd(finalLeft, finalTop);
        }
    }

    /**
     * Save偏移量到 localStorage
     */
    #saveOffset(): void {
        // 使用 style.left/top 而不是 offsetLeft/Top，因为我们使用的是绝对定位
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
    #extractPoint(e: MouseEvent | TouchEvent, phase: 'start' | 'move'): { pageX: number; pageY: number } {
        if (e.type === 'touchstart' || e.type === 'touchmove') {
            const touch = (e as TouchEvent).touches[0];
            return { pageX: touch.pageX, pageY: touch.pageY };
        }
        const mouse = e as MouseEvent;
        // phase is unused at runtime but keeps semantic parity with original code paths
        void phase;
        return { pageX: mouse.pageX, pageY: mouse.pageY };
    }

    /**
     * 销毁拖拽功能
     */
    destroy(): void {
        const handle: HTMLElement | null = this.#options.handle
            ? (this.#element.querySelector(this.#options.handle) as HTMLElement | null)
            : this.#element;

        if (handle) {
            if (this.#handlers.mousedown) handle.removeEventListener('mousedown', this.#handlers.mousedown);
            if (this.#handlers.touchstart) handle.removeEventListener('touchstart', this.#handlers.touchstart);
        }

        // 移除全局Listen器（如果正在拖拽）
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

/**
 * 快捷函数：使Element可拖拽
 */
export function makeDraggable(element: HTMLElement, options: DraggableOptions = {}): DraggableManager {
    return new DraggableManager(element, options);
}
