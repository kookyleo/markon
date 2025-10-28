/**
 * PopoverManager - Selection popover manager
 * Handles selection popover display, positioning, and content updates
 */

import { CONFIG } from '../core/config.js';
import { Logger } from '../core/utils.js';
import { DOM } from '../services/dom.js';
import { DraggableManager } from '../components/draggable.js';
import { Position } from '../services/position.js';

/**
 * 弹出框Management器
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
        // Debug：Print选中的Content
        const selectedText = range.toString();
        Logger.log('PopoverManager', `show() called with text: "${selectedText}" (length: ${selectedText.length}, trimmed: ${selectedText.trim().length})`);
        Logger.log('PopoverManager', `show() highlightedElement: ${!!highlightedElement}${highlightedElement ? `, class: ${highlightedElement.className}` : ''}`);

        this.#currentSelection = range.cloneRange();
        this.#currentHighlightedElement = highlightedElement;

        // UpdateContent - 传递是否有选中文本
        const hasSelection = selectedText.trim().length > 0;
        Logger.log('PopoverManager', `show() hasSelection: ${hasSelection}`);
        this.#updateContent(highlightedElement, hasSelection);

        // 先Show以Get尺寸
        this.#element.style.visibility = 'hidden';
        this.#element.style.display = 'block';

        // 强制重排
        const popoverHeight = this.#element.offsetHeight;
        const popoverWidth = this.#element.offsetWidth;

        // Get选区的绝对位置
        const rect = range.getBoundingClientRect();
        const scrollX = window.pageXOffset || document.documentElement.scrollLeft;
        const scrollY = window.pageYOffset || document.documentElement.scrollTop;

        const offset = CONFIG.DIMENSIONS.POPOVER_OFFSET;

        // 水平居中对齐（绝对坐标）
        let left = rect.left + scrollX + rect.width / 2 - popoverWidth / 2;

        // 默认在下方Show（绝对坐标）
        let top = rect.bottom + scrollY + offset;
        let positionBelow = true;

        // Check下方空间是否足够
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

        // Save原始位置（Apply偏移之前的位置）用于Calculate偏移量
        const originalLeft = left;
        const originalTop = top;

        // ApplySave的偏移量
        const savedOffset = this.#getSavedOffset();
        if (savedOffset) {
            left += savedOffset.dx;
            top += savedOffset.dy;
            Logger.log('PopoverManager', `Applied saved offset: dx=${savedOffset.dx}, dy=${savedOffset.dy}`);

            // Apply偏移后再次Check边界，防止屏幕变小后Utility条超出视口
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

        // Save原始位置（Apply偏移之前）供 DraggableManager Calculate偏移量
        this.#element.dataset.originalLeft = originalLeft;
        this.#element.dataset.originalTop = originalTop;

        this.#element.style.left = `${left}px`;
        this.#element.style.top = `${top}px`;

        // Show
        this.#element.style.visibility = 'visible';

        // Initialize拖拽功能
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
        // Ignore弹出框内的点击
        if (this.#element.contains(event.target)) {
            return;
        }

        const selection = window.getSelection();
        const selectedText = selection.toString().trim();

        // 没有选中任何TextContent，Hide弹出框
        if (selectedText.length === 0) {
            if (!this.#element.contains(event.target)) {
                this.hide();
            }
            return;
        }

        // CheckSelect是否在 markdown body 内
        const range = selection.getRangeAt(0);
        const container = range.commonAncestorContainer;
        const element = container.nodeType === 3 ? container.parentElement : container;

        if (!this.#markdownBody.contains(element)) {
            return;
        }

        // Skip UI Element
        if (this.#shouldSkipElement(element)) {
            return;
        }

        // Check是否跨块级Element
        if (this.#spansMultipleBlocks(range)) {
            Logger.log('PopoverManager', 'Selection spans multiple blocks, trimming to first block');
            const trimmed = this.#trimToFirstBlock(range);
            if (trimmed) {
                // Check trim 后是否有实际TextContent
                const trimmedText = trimmed.toString().trim();
                if (trimmedText.length === 0) {
                    Logger.log('PopoverManager', 'Trimmed selection has no text content, hiding');
                    this.hide();
                    return;
                }

                // Check trim 后的 range 是否在 UI Element内
                // 需要Check range 的起始Node，而不是 commonAncestorContainer
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

                // Check trimmed range 是否在已高亮区域内
                const isHighlightedTrimmed = startElement.closest(CONFIG.SELECTORS.HIGHLIGHT_CLASSES);
                this.show(trimmed, isHighlightedTrimmed);
            }
            return;
        }

        // Check是否已Highlight
        const isHighlighted = element.closest(CONFIG.SELECTORS.HIGHLIGHT_CLASSES);

        this.show(range, isHighlighted);
    }

    handleHighlightClick(highlightedElement) {
        // 如果当前有文本选择，不处理点击事件（让 handleSelection 处理）
        const selection = window.getSelection();
        if (selection && selection.toString().trim().length > 0) {
            Logger.log('PopoverManager', 'handleHighlightClick: ignored due to active selection');
            return;
        }

        this.#currentHighlightedElement = highlightedElement;
        this.#updateContent(highlightedElement, false);

        // 先Show以Get尺寸
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

        // 默认在下方Show（绝对坐标）
        let top = rect.bottom + scrollY + offset;
        let positionBelow = true;

        // Check下方空间是否足够
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

        // Save原始位置（Apply偏移之前的位置）用于Calculate偏移量
        const originalLeft = left;
        const originalTop = top;

        // ApplySave的偏移量
        const savedOffset = this.#getSavedOffset();
        if (savedOffset) {
            left += savedOffset.dx;
            top += savedOffset.dy;
            Logger.log('PopoverManager', `Applied saved offset: dx=${savedOffset.dx}, dy=${savedOffset.dy}`);

            // Apply偏移后再次Check边界，防止屏幕变小后Utility条超出视口
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

        // Save原始位置（Apply偏移之前）供 DraggableManager Calculate偏移量
        this.#element.dataset.originalLeft = originalLeft;
        this.#element.dataset.originalTop = originalTop;

        this.#element.style.left = `${left}px`;
        this.#element.style.top = `${top}px`;
        this.#element.style.visibility = 'visible';

        // Initialize拖拽功能
        this.#initDraggable();

        Logger.log('PopoverManager', `Popover positioned at (${left}, ${top}), ${positionBelow ? 'below' : 'above'} highlight`);
    }

    #createElement() {
        this.#element = document.createElement('div');
        this.#element.className = 'selection-popover';
        this.#updateContent(null);

        document.body.appendChild(this.#element);

        // Settings点击Event
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

    #updateContent(highlightedElement, hasSelection = false) {
        Logger.log('PopoverManager', `#updateContent called: highlightedElement=${!!highlightedElement}, hasSelection=${hasSelection}`);

        if (highlightedElement) {
            if (hasSelection) {
                // 已Highlight但有选中文本：显示 Unhighlight + Note
                Logger.log('PopoverManager', 'Showing: Unhighlight + Note');
                this.#element.innerHTML = `
                    <button data-action="unhighlight">Unhighlight</button>
                    <span class="popover-separator">|</span>
                    <button data-action="add-note">Note</button>
                `;
            } else {
                // 已Highlight且无选中文本（仅点击）：只显示 Unhighlight
                Logger.log('PopoverManager', 'Showing: Unhighlight only');
                this.#element.innerHTML = '<button data-action="unhighlight">Unhighlight</button>';
            }
        } else {
            // 未Highlight：Show注解Button
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
     * Initialize拖拽功能
     * @private
     */
    #initDraggable() {
        // 如果已存在拖拽Instance，先销毁
        if (this.#draggable) {
            this.#draggable.destroy();
        }

        // Create新的拖拽Instance
        this.#draggable = new DraggableManager(this.#element, {
            storageKey: 'markon-popover-offset',
            saveOffset: true,
            onDragEnd: (finalLeft, finalTop) => {
                Logger.log('PopoverManager', `Popover dragged to (${finalLeft}, ${finalTop})`);
            }
        });
    }

    /**
     * GetSave的偏移量
     * @private
     * @returns {Object|null} 偏移量Object {dx, dy} 或 null
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
