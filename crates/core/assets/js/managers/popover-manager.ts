/**
 * PopoverManager - Selection popover manager
 *
 * Owns the floating action toolbar that appears next to a text selection or
 * an existing highlight: positions it relative to the anchor (selection rect
 * or highlight element), drives the drag-to-reposition affordance, and fans
 * action clicks back out via {@link PopoverActionCallback}.
 */

import { CONFIG, i18n } from '../core/config';
import { Logger } from '../core/utils';
import { DOM } from '../services/dom';
import { DraggableManager } from '../components/draggable';
import { Position } from '../services/position';

const _t = (key: string, ...args: unknown[]): string => i18n.t(key, ...args);

/**
 * Payload supplied to the action callback. The selection range and the
 * matched highlight element (when applicable) are included so the consumer
 * can act without re-querying the DOM.
 */
export interface PopoverActionPayload {
    selection: Range | null;
    highlightedElement: Element | null;
    /** Whether Shift was held when the action button was clicked. Most
     *  actions ignore this; the chat action uses it to invert the user's
     *  default chat surface (in-page vs popout) for that single click. */
    shiftKey: boolean;
}

/**
 * Action callback fired when a button inside the popover is clicked.
 * The popover itself hides immediately after dispatch, regardless of
 * what the consumer does.
 */
export type PopoverActionCallback = (action: string, payload: PopoverActionPayload) => void;

/**
 * Construction options for {@link PopoverManager}.
 */
export interface PopoverManagerOptions {
    /** Whether the inline `Edit` button should be rendered when text is selected. */
    enableEdit?: boolean;
    /** Whether the inline `Chat` button should be rendered when text is selected. */
    enableChat?: boolean;
}

interface SavedOffset {
    dx: number;
    dy: number;
}

/**
 * Floating selection-popover manager.
 *
 * TODO(phase-3-typing): once annotation-manager is migrated to TS, the
 * action string set should become a literal-typed union (e.g.
 * `'highlight-orange' | 'add-note' | ...`). For now we keep `action: string`
 * so the .js callers can route freely.
 */
export class PopoverManager {
    #element!: HTMLElement;
    #currentSelection: Range | null = null;
    #currentHighlightedElement: Element | null = null;
    #markdownBody: HTMLElement;
    #onAction: PopoverActionCallback | null = null;
    #draggable: DraggableManager | null = null;
    #enableEdit: boolean;
    #enableChat: boolean;

    constructor(markdownBody: HTMLElement, options: PopoverManagerOptions = {}) {
        this.#markdownBody = markdownBody;
        this.#enableEdit = options.enableEdit ?? false;
        this.#enableChat = options.enableChat ?? false;
        this.#createElement();
    }

    show(range: Range, highlightedElement: Element | null = null): void {
        const selectedText = range.toString();
        this.#currentSelection = range.cloneRange();
        this.#currentHighlightedElement = highlightedElement;

        const hasSelection = selectedText.trim().length > 0;
        this.#updateContent(highlightedElement, hasSelection);

        // Render hidden first to measure final dimensions before placing.
        this.#element.style.visibility = 'hidden';
        this.#element.style.display = 'block';

        const popoverHeight = this.#element.offsetHeight;
        const popoverWidth = this.#element.offsetWidth;

        const rect = range.getBoundingClientRect();
        const scrollX = window.pageXOffset || document.documentElement.scrollLeft;
        const scrollY = window.pageYOffset || document.documentElement.scrollTop;

        const offset = CONFIG.DIMENSIONS.POPOVER_OFFSET;

        let left = rect.left + scrollX + rect.width / 2 - popoverWidth / 2;
        let top = rect.bottom + scrollY + offset;

        const spaceBelow = window.innerHeight - rect.bottom;
        const spaceAbove = rect.top;

        if (spaceBelow < popoverHeight + offset + 20) {
            // Not enough room below; flip above if there's more headroom there.
            if (spaceAbove > spaceBelow || spaceAbove > popoverHeight + offset + 20) {
                top = rect.top + scrollY - popoverHeight - offset;
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

        // Pre-offset coords feed DraggableManager's delta math.
        this.#element.dataset.originalLeft = String(originalLeft);
        this.#element.dataset.originalTop = String(originalTop);

        this.#element.style.left = `${left}px`;
        this.#element.style.top = `${top}px`;
        this.#element.style.visibility = 'visible';

        this.#initDraggable();
    }

    hide(): void {
        this.#element.style.display = 'none';
        this.#currentSelection = null;
        this.#currentHighlightedElement = null;

        if (this.#draggable) {
            this.#draggable.destroy();
            this.#draggable = null;
        }

        Logger.log('PopoverManager', 'Popover hidden');
    }

    isVisible(): boolean {
        return this.#element.style.display !== 'none';
    }

    getCurrentSelection(): Range | null {
        return this.#currentSelection;
    }

    getCurrentHighlightedElement(): Element | null {
        return this.#currentHighlightedElement;
    }

    onAction(callback: PopoverActionCallback): void {
        this.#onAction = callback;
    }

    handleSelection(event: Event): void {
        const target = event.target as Element | null;

        // Ignore弹出框内的点击
        if (target && this.#element.contains(target)) {
            return;
        }
        // Clicks on floating UI widgets (TOC icon/menu, Live sphere/panel)
        // shouldn't re-show the popover on a stale selection left in the
        // article from an earlier interaction.
        if (target && typeof target.closest === 'function' && target.closest('#toc-container, .markon-live-container')) {
            return;
        }
        // When the current selection was applied by Markon Live (follower
        // mirroring the speaker), suppress the annotation toolbar — followers
        // shouldn't see highlight/note options for ranges they didn't make.
        if (document.body.dataset.markonLiveRemote) {
            return;
        }

        const selection = window.getSelection();
        if (!selection) return;
        const selectedText = selection.toString().trim();

        // 没有选中任何TextContent，Hide弹出框
        if (selectedText.length === 0) {
            if (target && !this.#element.contains(target)) {
                this.hide();
            }
            return;
        }

        // CheckSelect是否在 markdown body 内
        const range = selection.getRangeAt(0);
        const container = range.commonAncestorContainer;
        const element: Element | null =
            container.nodeType === 3 ? container.parentElement : (container as Element);

        if (!element || !this.#markdownBody.contains(element)) {
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
                const startElement: Element | null =
                    startContainer.nodeType === 3 ? startContainer.parentElement : (startContainer as Element);
                if (!startElement) {
                    this.hide();
                    return;
                }
                Logger.log(
                    'PopoverManager',
                    `Trimmed start element: ${startElement.tagName}.${startElement.className}`,
                );
                Logger.log(
                    'PopoverManager',
                    `Checking shouldSkipElement: ${this.#shouldSkipElement(startElement)}`,
                );
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

    handleHighlightClick(highlightedElement: Element): void {
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
        this.#element.dataset.originalLeft = String(originalLeft);
        this.#element.dataset.originalTop = String(originalTop);

        this.#element.style.left = `${left}px`;
        this.#element.style.top = `${top}px`;
        this.#element.style.visibility = 'visible';

        // Initialize拖拽功能
        this.#initDraggable();

        Logger.log(
            'PopoverManager',
            `Popover positioned at (${left}, ${top}), ${positionBelow ? 'below' : 'above'} highlight`,
        );
    }

    #createElement(): void {
        this.#element = document.createElement('div');
        this.#element.className = 'selection-popover';
        this.#updateContent(null);

        document.body.appendChild(this.#element);

        // Settings点击Event
        this.#element.addEventListener('click', (e: MouseEvent) => {
            const target = e.target as HTMLElement | null;
            const action = target?.dataset?.action;
            if (!action) return;

            if (this.#onAction) {
                this.#onAction(action, {
                    selection: this.#currentSelection,
                    highlightedElement: this.#currentHighlightedElement,
                    shiftKey: e.shiftKey,
                });
            }

            this.hide();
        });
    }

    #updateContent(highlightedElement: Element | null, hasSelection = false): void {
        Logger.log(
            'PopoverManager',
            `#updateContent called: highlightedElement=${!!highlightedElement}, hasSelection=${hasSelection}`,
        );

        const editButton =
            this.#enableEdit && hasSelection
                ? '<span class="popover-separator">|</span><button data-action="edit">Edit</button>'
                : '';
        // "Chat" only makes sense with text actually selected — otherwise
        // there's no quote to attach. Cluster it with Edit on the right edge.
        const chatButton =
            this.#enableChat && hasSelection
                ? `<span class="popover-separator">|</span><button data-action="chat">${_t('web.chat.discuss')}</button>`
                : '';

        // Drag handle on the left edge — the only region that initiates a drag.
        const dragHandle = '<span class="popover-drag-handle" aria-hidden="true"></span>';

        if (highlightedElement) {
            if (hasSelection) {
                // Highlighted with selection: show Unhighlight + Note + Edit + Chat
                Logger.log('PopoverManager', 'Showing: Unhighlight + Note + Edit + Chat');
                this.#element.innerHTML = `
                    ${dragHandle}
                    <button data-action="unhighlight">${_t('web.annot.unhighlight')}</button>
                    <span class="popover-separator">|</span>
                    <button data-action="add-note">${_t('web.annot.note')}</button>
                    ${editButton}
                    ${chatButton}
                `;
            } else {
                // Highlighted without selection (just click): show only Unhighlight
                Logger.log('PopoverManager', 'Showing: Unhighlight only');
                this.#element.innerHTML = `${dragHandle}<button data-action="unhighlight">${_t('web.annot.unhighlight')}</button>`;
            }
        } else {
            // Not highlighted: show annotation buttons + Edit + Chat
            this.#element.innerHTML = `
                ${dragHandle}
                <button data-action="highlight-orange">${_t('web.annot.orange')}</button>
                <button data-action="highlight-green">${_t('web.annot.green')}</button>
                <button data-action="highlight-yellow">${_t('web.annot.yellow')}</button>
                <button data-action="strikethrough">${_t('web.annot.strike')}</button>
                <span class="popover-separator">|</span>
                <button data-action="add-note">${_t('web.annot.note')}</button>
                ${editButton}
                ${chatButton}
            `;
        }
    }

    #shouldSkipElement(element: Element): boolean {
        if (
            element.closest('.selection-popover') ||
            element.closest('.note-input-modal') ||
            element.closest('.note-card-margin') ||
            element.closest('.note-popup') ||
            element.closest('.confirm-dialog') ||
            element.closest('.viewed-checkbox') ||
            element.closest('.viewed-checkbox-label') ||
            element.closest('.viewed-text') ||
            element.closest('.viewed-toolbar') ||
            element.closest('.section-toggle-btn')
        ) {
            return true;
        }
        return false;
    }

    #spansMultipleBlocks(range: Range): boolean {
        const startBlock = DOM.getBlockParent(range.startContainer, this.#markdownBody);
        const endBlock = DOM.getBlockParent(range.endContainer, this.#markdownBody);

        return startBlock !== endBlock && !!startBlock && !!endBlock;
    }

    #trimToFirstBlock(range: Range): Range | null {
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
     */
    #initDraggable(): void {
        // 如果已存在拖拽Instance，先销毁
        if (this.#draggable) {
            this.#draggable.destroy();
        }

        // Create新的拖拽Instance
        this.#draggable = new DraggableManager(this.#element, {
            storageKey: CONFIG.STORAGE_KEYS.POPOVER_OFFSET,
            handle: '.popover-drag-handle',
            saveOffset: true,
            onDragEnd: (finalLeft, finalTop) => {
                Logger.log('PopoverManager', `Popover dragged to (${finalLeft}, ${finalTop})`);
            },
        });
    }

    /**
     * GetSave的偏移量
     */
    #getSavedOffset(): SavedOffset | null {
        try {
            const saved = localStorage.getItem(CONFIG.STORAGE_KEYS.POPOVER_OFFSET);
            if (saved) {
                const parsed: unknown = JSON.parse(saved);
                if (
                    parsed &&
                    typeof parsed === 'object' &&
                    'dx' in parsed &&
                    'dy' in parsed &&
                    typeof (parsed as { dx: unknown }).dx === 'number' &&
                    typeof (parsed as { dy: unknown }).dy === 'number'
                ) {
                    return parsed as SavedOffset;
                }
            }
        } catch (error) {
            Logger.warn('PopoverManager', 'Failed to load saved offset:', error);
        }
        return null;
    }
}
