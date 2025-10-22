/**
 * PopoverManager - 选择弹出框管理器
 * 负责注解选择弹出框的显示、定位、内容更新
 */

import { CONFIG } from '../core/config.js';
import { Logger } from '../core/utils.js';
import { DOM } from '../services/dom.js';
import { DraggableManager } from '../components/draggable.js';
import { Position } from '../services/position.js';

/**
 * 弹出框管理器
 */
export class PopoverManager {
    #element;
    #currentSelection = null;
    #currentHighlightedElement = null;
    #markdownBody;
    #onAction = null;
    #draggable = null;

    constructor(markdownBody) {
        this.#markdownBody = markdownBody;
        this.#createElement();
    }

    show(range, highlightedElement = null) {
        // 调试：打印选中的内容
        const selectedText = range.toString();
        Logger.log('PopoverManager', `show() called with text: "${selectedText}" (length: ${selectedText.length}, trimmed: ${selectedText.trim().length})`);

        this.#currentSelection = range.cloneRange();
        this.#currentHighlightedElement = highlightedElement;

        // 更新内容
        this.#updateContent(highlightedElement);

        // 先显示以获取尺寸
        this.#element.style.visibility = 'hidden';
        this.#element.style.display = 'block';

        // 强制重排
        const popoverHeight = this.#element.offsetHeight;
        const popoverWidth = this.#element.offsetWidth;

        // 获取选区的绝对位置
        const rect = range.getBoundingClientRect();
        const scrollX = window.pageXOffset || document.documentElement.scrollLeft;
        const scrollY = window.pageYOffset || document.documentElement.scrollTop;

        const offset = CONFIG.DIMENSIONS.POPOVER_OFFSET;

        // 水平居中对齐（绝对坐标）
        let left = rect.left + scrollX + rect.width / 2 - popoverWidth / 2;

        // 默认在下方显示（绝对坐标）
        let top = rect.bottom + scrollY + offset;
        let positionBelow = true;

        // 检查下方空间是否足够
        const spaceBelow = window.innerHeight - rect.bottom;
        const spaceAbove = rect.top;

        if (spaceBelow < popoverHeight + offset + 20) {
            // 下方空间不够，尝试上方
            if (spaceAbove > spaceBelow || spaceAbove > popoverHeight + offset + 20) {
                top = rect.top + scrollY - popoverHeight - offset;
                positionBelow = false;
            }
        }

        // 约束到视口内
        const margin = 10;
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        if (left < scrollX + margin) {
            left = scrollX + margin;
        }
        if (left + popoverWidth > scrollX + viewportWidth - margin) {
            left = scrollX + viewportWidth - popoverWidth - margin;
        }
        if (top < scrollY + margin) {
            top = scrollY + margin;
        }
        if (top + popoverHeight > scrollY + viewportHeight - margin) {
            top = scrollY + viewportHeight - popoverHeight - margin;
        }

        // 保存原始位置（应用偏移之前的位置）用于计算偏移量
        const originalLeft = left;
        const originalTop = top;

        // 应用保存的偏移量
        const savedOffset = this.#getSavedOffset();
        if (savedOffset) {
            left += savedOffset.dx;
            top += savedOffset.dy;
            Logger.log('PopoverManager', `Applied saved offset: dx=${savedOffset.dx}, dy=${savedOffset.dy}`);

            // 应用偏移后再次检查边界，防止屏幕变小后工具条超出视口
            if (left < scrollX + margin) {
                left = scrollX + margin;
            }
            if (left + popoverWidth > scrollX + viewportWidth - margin) {
                left = scrollX + viewportWidth - popoverWidth - margin;
            }
            if (top < scrollY + margin) {
                top = scrollY + margin;
            }
            if (top + popoverHeight > scrollY + viewportHeight - margin) {
                top = scrollY + viewportHeight - popoverHeight - margin;
            }
            Logger.log('PopoverManager', `After boundary check: (${Math.round(left)}, ${Math.round(top)})`);
        }

        // 保存原始位置（应用偏移之前）供 DraggableManager 计算偏移量
        this.#element.dataset.originalLeft = originalLeft;
        this.#element.dataset.originalTop = originalTop;

        this.#element.style.left = `${left}px`;
        this.#element.style.top = `${top}px`;

        // 显示
        this.#element.style.visibility = 'visible';

        // 初始化拖拽功能
        this.#initDraggable();

        Logger.log('PopoverManager', `Popover shown at (${Math.round(left)}, ${Math.round(top)}), ${positionBelow ? 'below' : 'above'} selection`);
    }

    hide() {
        this.#element.style.display = 'none';
        this.#currentSelection = null;
        this.#currentHighlightedElement = null;

        // 销毁拖拽功能
        if (this.#draggable) {
            this.#draggable.destroy();
            this.#draggable = null;
        }

        Logger.log('PopoverManager', 'Popover hidden');
    }

    isVisible() {
        return this.#element.style.display !== 'none';
    }

    getCurrentSelection() {
        return this.#currentSelection;
    }

    getCurrentHighlightedElement() {
        return this.#currentHighlightedElement;
    }

    onAction(callback) {
        this.#onAction = callback;
    }

    handleSelection(event) {
        // 忽略弹出框内的点击
        if (this.#element.contains(event.target)) {
            return;
        }

        const selection = window.getSelection();
        const selectedText = selection.toString().trim();

        // 没有选中任何文本内容，隐藏弹出框
        if (selectedText.length === 0) {
            if (!this.#element.contains(event.target)) {
                this.hide();
            }
            return;
        }

        // 检查选择是否在 markdown body 内
        const range = selection.getRangeAt(0);
        const container = range.commonAncestorContainer;
        const element = container.nodeType === 3 ? container.parentElement : container;

        if (!this.#markdownBody.contains(element)) {
            return;
        }

        // 跳过 UI 元素
        if (this.#shouldSkipElement(element)) {
            return;
        }

        // 检查是否跨块级元素
        if (this.#spansMultipleBlocks(range)) {
            Logger.log('PopoverManager', 'Selection spans multiple blocks, trimming to first block');
            const trimmed = this.#trimToFirstBlock(range);
            if (trimmed) {
                // 检查 trim 后是否有实际文本内容
                const trimmedText = trimmed.toString().trim();
                if (trimmedText.length === 0) {
                    Logger.log('PopoverManager', 'Trimmed selection has no text content, hiding');
                    this.hide();
                    return;
                }

                // 检查 trim 后的 range 是否在 UI 元素内
                // 需要检查 range 的起始节点，而不是 commonAncestorContainer
                const startContainer = trimmed.startContainer;
                const startElement = startContainer.nodeType === 3 ? startContainer.parentElement : startContainer;
                Logger.log('PopoverManager', `Trimmed start element: ${startElement.tagName}.${startElement.className}`);
                Logger.log('PopoverManager', `Checking shouldSkipElement: ${this.#shouldSkipElement(startElement)}`);
                if (this.#shouldSkipElement(startElement)) {
                    Logger.log('PopoverManager', 'Trimmed selection starts in UI element, hiding');
                    this.hide();
                    return;
                }

                selection.removeAllRanges();
                selection.addRange(trimmed);
                this.show(trimmed);
            }
            return;
        }

        // 检查是否已高亮
        const isHighlighted = element.closest(CONFIG.SELECTORS.HIGHLIGHT_CLASSES);

        this.show(range, isHighlighted);
    }

    handleHighlightClick(highlightedElement) {
        this.#currentHighlightedElement = highlightedElement;
        this.#updateContent(highlightedElement);

        // 先显示以获取尺寸
        this.#element.style.visibility = 'hidden';
        this.#element.style.display = 'block';

        const rect = highlightedElement.getBoundingClientRect();
        const popoverWidth = this.#element.offsetWidth;
        const popoverHeight = this.#element.offsetHeight;

        const scrollX = window.pageXOffset || document.documentElement.scrollLeft;
        const scrollY = window.pageYOffset || document.documentElement.scrollTop;
        const offset = CONFIG.DIMENSIONS.POPOVER_OFFSET;

        // 水平居中对齐（绝对坐标）
        let left = rect.left + scrollX + rect.width / 2 - popoverWidth / 2;

        // 默认在下方显示（绝对坐标）
        let top = rect.bottom + scrollY + offset;
        let positionBelow = true;

        // 检查下方空间是否足够
        const spaceBelow = window.innerHeight - rect.bottom;
        const spaceAbove = rect.top;

        if (spaceBelow < popoverHeight + offset + 20) {
            // 下方空间不够，尝试上方
            if (spaceAbove > spaceBelow || spaceAbove > popoverHeight + offset + 20) {
                top = rect.top + scrollY - popoverHeight - offset;
                positionBelow = false;
            }
        }

        // 约束到视口内
        const margin = 10;
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        if (left < scrollX + margin) {
            left = scrollX + margin;
        }
        if (left + popoverWidth > scrollX + viewportWidth - margin) {
            left = scrollX + viewportWidth - popoverWidth - margin;
        }
        if (top < scrollY + margin) {
            top = scrollY + margin;
        }
        if (top + popoverHeight > scrollY + viewportHeight - margin) {
            top = scrollY + viewportHeight - popoverHeight - margin;
        }

        // 保存原始位置（应用偏移之前的位置）用于计算偏移量
        const originalLeft = left;
        const originalTop = top;

        // 应用保存的偏移量
        const savedOffset = this.#getSavedOffset();
        if (savedOffset) {
            left += savedOffset.dx;
            top += savedOffset.dy;
            Logger.log('PopoverManager', `Applied saved offset: dx=${savedOffset.dx}, dy=${savedOffset.dy}`);

            // 应用偏移后再次检查边界，防止屏幕变小后工具条超出视口
            if (left < scrollX + margin) {
                left = scrollX + margin;
            }
            if (left + popoverWidth > scrollX + viewportWidth - margin) {
                left = scrollX + viewportWidth - popoverWidth - margin;
            }
            if (top < scrollY + margin) {
                top = scrollY + margin;
            }
            if (top + popoverHeight > scrollY + viewportHeight - margin) {
                top = scrollY + viewportHeight - popoverHeight - margin;
            }
            Logger.log('PopoverManager', `After boundary check: (${Math.round(left)}, ${Math.round(top)})`);
        }

        // 保存原始位置（应用偏移之前）供 DraggableManager 计算偏移量
        this.#element.dataset.originalLeft = originalLeft;
        this.#element.dataset.originalTop = originalTop;

        this.#element.style.left = `${left}px`;
        this.#element.style.top = `${top}px`;
        this.#element.style.visibility = 'visible';

        // 初始化拖拽功能
        this.#initDraggable();

        Logger.log('PopoverManager', `Popover positioned at (${left}, ${top}), ${positionBelow ? 'below' : 'above'} highlight`);
    }

    #createElement() {
        this.#element = document.createElement('div');
        this.#element.className = 'selection-popover';
        this.#updateContent(null);

        document.body.appendChild(this.#element);

        // 设置点击事件
        this.#element.addEventListener('click', (e) => {
            const action = e.target.dataset.action;
            if (!action) return;

            if (this.#onAction) {
                this.#onAction(action, {
                    selection: this.#currentSelection,
                    highlightedElement: this.#currentHighlightedElement
                });
            }

            this.hide();
        });
    }

    #updateContent(highlightedElement) {
        if (highlightedElement) {
            // 已高亮：显示取消高亮按钮
            this.#element.innerHTML = '<button data-action="unhighlight">Unhighlight</button>';
        } else {
            // 未高亮：显示注解按钮
            this.#element.innerHTML = `
                <button data-action="highlight-orange">Orange</button>
                <button data-action="highlight-green">Green</button>
                <button data-action="highlight-yellow">Yellow</button>
                <button data-action="strikethrough">Strike</button>
                <span class="popover-separator">|</span>
                <button data-action="add-note">Note</button>
            `;
        }
    }

    #shouldSkipElement(element) {
        if (element.closest('.selection-popover') ||
            element.closest('.note-input-modal') ||
            element.closest('.note-card-margin') ||
            element.closest('.note-popup') ||
            element.closest('.confirm-dialog') ||
            element.closest('.viewed-checkbox') ||
            element.closest('.viewed-checkbox-label') ||
            element.closest('.viewed-text') ||
            element.closest('.viewed-toolbar') ||
            element.closest('.section-toggle-btn')) {
            return true;
        }
        return false;
    }

    #spansMultipleBlocks(range) {
        const startBlock = DOM.getBlockParent(range.startContainer, this.#markdownBody);
        const endBlock = DOM.getBlockParent(range.endContainer, this.#markdownBody);

        return startBlock !== endBlock && startBlock && endBlock;
    }

    #trimToFirstBlock(range) {
        const startBlock = DOM.getBlockParent(range.startContainer, this.#markdownBody);
        if (!startBlock) return null;

        const lastTextNode = DOM.findLastTextNode(startBlock);
        if (!lastTextNode) return null;

        try {
            const newRange = range.cloneRange();
            newRange.setEnd(lastTextNode, lastTextNode.length);
            return newRange;
        } catch (error) {
            Logger.warn('PopoverManager', 'Failed to trim selection:', error);
            return null;
        }
    }

    /**
     * 初始化拖拽功能
     * @private
     */
    #initDraggable() {
        // 如果已存在拖拽实例，先销毁
        if (this.#draggable) {
            this.#draggable.destroy();
        }

        // 创建新的拖拽实例
        this.#draggable = new DraggableManager(this.#element, {
            storageKey: 'markon-popover-offset',
            saveOffset: true,
            onDragEnd: (finalLeft, finalTop) => {
                Logger.log('PopoverManager', `Popover dragged to (${finalLeft}, ${finalTop})`);
            }
        });
    }

    /**
     * 获取保存的偏移量
     * @private
     * @returns {Object|null} 偏移量对象 {dx, dy} 或 null
     */
    #getSavedOffset() {
        try {
            const saved = localStorage.getItem('markon-popover-offset');
            if (saved) {
                return JSON.parse(saved);
            }
        } catch (error) {
            Logger.warn('PopoverManager', 'Failed to load saved offset:', error);
        }
        return null;
    }
}
