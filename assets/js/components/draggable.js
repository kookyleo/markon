/**
 * DraggableManager - Unified drag-and-drop manager
 * Eliminate makePopoverDraggable 和 makeDraggable betweencode duplication
 */

import { Logger } from '../core/utils.js';

/**
 * 拖拽Management器类
 */
export class DraggableManager {
    #element;
    #options;
    #isDragging = false;
    #startX = 0;
    #startY = 0;
    #initialLeft = 0;
    #initialTop = 0;
    #handlers = {};

    /**
     * @param {HTMLElement} element - 要使其可拖拽的Element
     * @param {Object} options - ConfigurationOptions
     * @param {string} options.storageKey - localStorage Storage键（可选）
     * @param {string} options.handle - 拖拽手柄Selectors（可选，默认整个Element）
     * @param {Function} options.onDragStart - Start拖拽Callback
     * @param {Function} options.onDragmove - 拖拽中Callback
     * @param {Function} options.onDragEnd - End拖拽Callback
     * @param {boolean} options.saveOffset - 是否Save偏移量（默认 false）
     */
    constructor(element, options = {}) {
        this.#element = element;
        this.#options = {
            storageKey: null,
            handle: null,
            onDragStart: null,
            onDragmove: null,
            onDragEnd: null,
            saveOffset: false,
            ...options
        };

        this.#init();
    }

    /**
     * Initialize拖拽功能
     * @private
     */
    #init() {
        const handle = this.#options.handle
            ? this.#element.querySelector(this.#options.handle)
            : this.#element;

        if (!handle) {
            Logger.warn('Draggable', 'Handle element not found');
            return;
        }

        // 不Settings cursor，使用 CSS 中的默认样式（grab）

        // 鼠标Event
        this.#handlers.mousedown = this.#onDragStart.bind(this);
        this.#handlers.mousemove = this.#onDragmove.bind(this);
        this.#handlers.mouseup = this.#onDragEnd.bind(this);

        // 触摸Event
        this.#handlers.touchstart = this.#onDragStart.bind(this);
        this.#handlers.touchmove = this.#onDragmove.bind(this);
        this.#handlers.touchend = this.#onDragEnd.bind(this);

        handle.addEventListener('mousedown', this.#handlers.mousedown);
        handle.addEventListener('touchstart', this.#handlers.touchstart, { passive: false });
    }

    /**
     * Start拖拽
     * @private
     */
    #onDragStart(e) {
        // 如果点击的是Button，不进行拖拽
        if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') {
            return;
        }

        this.#isDragging = true;

        const { pageX, pageY } = e.type === 'touchstart' ? e.touches[0] : e;
        this.#startX = pageX;
        this.#startY = pageY;

        // 从 style.left/top Parse位置，因为我们使用绝对定位
        this.#initialLeft = parseFloat(this.#element.style.left) || 0;
        this.#initialTop = parseFloat(this.#element.style.top) || 0;

        this.#element.style.cursor = 'grabbing';
        document.body.style.userSelect = 'none';

        // 添加全局Listen器
        document.addEventListener('mousemove', this.#handlers.mousemove);
        document.addEventListener('mouseup', this.#handlers.mouseup);
        document.addEventListener('touchmove', this.#handlers.touchmove, { passive: false });
        document.addEventListener('touchend', this.#handlers.touchend);

        e.preventDefault();

        // TriggerCallback
        if (this.#options.onDragStart) {
            this.#options.onDragStart(e);
        }
    }

    /**
     * 拖拽中
     * @private
     */
    #onDragmove(e) {
        if (!this.#isDragging) return;

        const { pageX, pageY } = e.type === 'touchmove' ? e.touches[0] : e;
        const dx = pageX - this.#startX;
        const dy = pageY - this.#startY;

        // Calculate新位置
        let newLeft = this.#initialLeft + dx;
        let newTop = this.#initialTop + dy;

        // 约束到视口范围内
        const margin = 10;
        const scrollX = window.pageXOffset || document.documentElement.scrollLeft;
        const scrollY = window.pageYOffset || document.documentElement.scrollTop;
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const elementWidth = this.#element.offsetWidth;
        const elementHeight = this.#element.offsetHeight;

        // 限制在视口内（使用Document坐标）
        if (newLeft < scrollX + margin) {
            newLeft = scrollX + margin;
        }
        if (newLeft + elementWidth > scrollX + viewportWidth - margin) {
            newLeft = scrollX + viewportWidth - elementWidth - margin;
        }
        if (newTop < scrollY + margin) {
            newTop = scrollY + margin;
        }
        if (newTop + elementHeight > scrollY + viewportHeight - margin) {
            newTop = scrollY + viewportHeight - elementHeight - margin;
        }

        this.#element.style.left = `${newLeft}px`;
        this.#element.style.top = `${newTop}px`;

        // TriggerCallback
        if (this.#options.onDragmove) {
            this.#options.onDragmove(dx, dy);
        }
    }

    /**
     * End拖拽
     * @private
     */
    #onDragEnd() {
        if (!this.#isDragging) return;

        this.#isDragging = false;
        this.#element.style.cursor = ''; // Reset回 CSS 默认样式
        document.body.style.userSelect = '';

        // 移除全局Listen器
        document.removeEventListener('mousemove', this.#handlers.mousemove);
        document.removeEventListener('mouseup', this.#handlers.mouseup);
        document.removeEventListener('touchmove', this.#handlers.touchmove);
        document.removeEventListener('touchend', this.#handlers.touchend);

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
     * @private
     */
    #saveOffset() {
        // 使用 style.left/top 而不是 offsetLeft/Top，因为我们使用的是绝对定位
        const finalLeft = parseFloat(this.#element.style.left) || 0;
        const finalTop = parseFloat(this.#element.style.top) || 0;
        const originalLeft = parseFloat(this.#element.dataset.originalLeft);
        const originalTop = parseFloat(this.#element.dataset.originalTop);

        if (!isNaN(originalLeft) && !isNaN(originalTop)) {
            const offset = {
                dx: finalLeft - originalLeft,
                dy: finalTop - originalTop,
            };
            localStorage.setItem(this.#options.storageKey, JSON.stringify(offset));
            Logger.log('Draggable', `Saved offset to ${this.#options.storageKey}:`, offset);
        }
    }

    /**
     * 销毁拖拽功能
     */
    destroy() {
        const handle = this.#options.handle
            ? this.#element.querySelector(this.#options.handle)
            : this.#element;

        if (handle) {
            handle.removeEventListener('mousedown', this.#handlers.mousedown);
            handle.removeEventListener('touchstart', this.#handlers.touchstart);
        }

        // 移除全局Listen器（如果正在拖拽）
        if (this.#isDragging) {
            document.removeEventListener('mousemove', this.#handlers.mousemove);
            document.removeEventListener('mouseup', this.#handlers.mouseup);
            document.removeEventListener('touchmove', this.#handlers.touchmove);
            document.removeEventListener('touchend', this.#handlers.touchend);
        }

        this.#element.style.cursor = '';
        Logger.log('Draggable', 'Destroyed');
    }
}

/**
 * 快捷函数：使Element可拖拽
 * @param {HTMLElement} element - Element
 * @param {Object} options - Options
 * @returns {DraggableManager}
 */
export function makeDraggable(element, options = {}) {
    return new DraggableManager(element, options);
}
