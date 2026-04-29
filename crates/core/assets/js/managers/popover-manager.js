/**
 * PopoverManager - Selection popover manager
 * Handles selection popover display, positioning, and content updates
 */

import { CONFIG } from '../core/config.js';
import { Logger } from '../core/utils.js';
import { DOM } from '../services/dom.js';
import { DraggableManager } from '../components/draggable.js';
import { Position } from '../services/position.js';

const _t = (window.__MARKON_I18N__ && window.__MARKON_I18N__.t) || (k => k);

/**
 * Popover manager
 */
export class PopoverManager {
    #element;
    #currentSelection = null;
    #currentHighlightedElement = null;
    #markdownBody;
    #onAction = null;
    #draggable = null;
    #enableEdit;

    constructor(markdownBody, options = {}) {
        this.#markdownBody = markdownBody;
        this.#enableEdit = options.enableEdit || false;
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

        ({ left, top } = Position.constrainToViewport(left, top, popoverWidth, popoverHeight));

        const originalLeft = left;
        const originalTop = top;

        const savedOffset = this.#getSavedOffset();
        if (savedOffset) {
            left += savedOffset.dx;
            top += savedOffset.dy;
            ({ left, top } = Position.constrainToViewport(left, top, popoverWidth, popoverHeight));
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
        // Clicks on floating UI widgets (TOC icon/menu, Live sphere/panel)
        // shouldn't re-show the popover on a stale selection left in the
        // article from an earlier interaction.
        if (event.target && event.target.closest && event.target.closest('#toc-container, .markon-live-container')) {
            return;
        }
        // When the current selection was applied by Markon Live (follower
        // mirroring the speaker), suppress the annotation toolbar — followers
        // shouldn't see highlight/note options for ranges they didn't make.
        if (document.body.dataset.markonLiveRemote) {
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
        // 如果 popover 已经可见，说明 handleSelection 刚刚处理过，不要覆盖
        if (this.isVisible()) {
            Logger.log('PopoverManager', 'handleHighlightClick: ignored because popover is already visible');
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

        ({ left, top } = Position.constrainToViewport(left, top, popoverWidth, popoverHeight));

        const originalLeft = left;
        const originalTop = top;

        const savedOffset = this.#getSavedOffset();
        if (savedOffset) {
            left += savedOffset.dx;
            top += savedOffset.dy;
            ({ left, top } = Position.constrainToViewport(left, top, popoverWidth, popoverHeight));
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

        const editButton = this.#enableEdit && hasSelection
            ? '<span class="popover-separator">|</span><button data-action="edit">Edit</button>'
            : '';

        // Drag handle on the left edge — the only region that initiates a drag.
        const dragHandle = '<span class="popover-drag-handle" aria-hidden="true"></span>';

        if (highlightedElement) {
            if (hasSelection) {
                // Highlighted with selection: show Unhighlight + Note + Edit
                Logger.log('PopoverManager', 'Showing: Unhighlight + Note + Edit');
                this.#element.innerHTML = `
                    ${dragHandle}
                    <button data-action="unhighlight">${_t('web.annot.unhighlight')}</button>
                    <span class="popover-separator">|</span>
                    <button data-action="add-note">${_t('web.annot.note')}</button>
                    ${editButton}
                `;
            } else {
                // Highlighted without selection (just click): show only Unhighlight
                Logger.log('PopoverManager', 'Showing: Unhighlight only');
                this.#element.innerHTML = `${dragHandle}<button data-action="unhighlight">${_t('web.annot.unhighlight')}</button>`;
            }
        } else {
            // Not highlighted: show annotation buttons + Edit
            this.#element.innerHTML = `
                ${dragHandle}
                <button data-action="highlight-orange">${_t('web.annot.orange')}</button>
                <button data-action="highlight-green">${_t('web.annot.green')}</button>
                <button data-action="highlight-yellow">${_t('web.annot.yellow')}</button>
                <button data-action="strikethrough">${_t('web.annot.strike')}</button>
                <span class="popover-separator">|</span>
                <button data-action="add-note">${_t('web.annot.note')}</button>
                ${editButton}
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
            handle: '.popover-drag-handle',
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
