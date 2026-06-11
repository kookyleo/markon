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
import { Text } from '../services/text';
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

        this.#placeAt(range.getBoundingClientRect());
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

        // Ignore clicks that originate inside the popover itself.
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

        // Nothing is selected — hide the popover.
        if (selectedText.length === 0) {
            if (target && !this.#element.contains(target)) {
                this.hide();
            }
            return;
        }

        // Confirm the selection lives inside the markdown body.
        const range = selection.getRangeAt(0);
        const container = range.commonAncestorContainer;
        const element: Element | null =
            container.nodeType === 3 ? container.parentElement : (container as Element);

        if (!element || !this.#markdownBody.contains(element)) {
            return;
        }

        // Skip floating UI elements.
        if (this.#shouldSkipElement(element)) {
            return;
        }

        // Detect a selection that spans multiple block-level elements.
        if (this.#spansMultipleBlocks(range)) {
            Logger.log('PopoverManager', 'Selection spans multiple blocks, trimming to first block');
            const trimmed = this.#trimToFirstBlock(range);
            if (trimmed) {
                // Bail out when the trimmed range has no usable text content.
                const trimmedText = trimmed.toString().trim();
                if (trimmedText.length === 0) {
                    Logger.log('PopoverManager', 'Trimmed selection has no text content, hiding');
                    this.hide();
                    return;
                }

                // Re-check whether the trimmed range starts inside a UI element.
                // We inspect the range's start node rather than its commonAncestorContainer.
                const startContainer = trimmed.startContainer;
                const startElement: Element | null =
                    startContainer.nodeType === 3 ? startContainer.parentElement : (startContainer as Element);
                if (!startElement) {
                    this.hide();
                    return;
                }
                if (this.#shouldSkipElement(startElement)) {
                    Logger.log('PopoverManager', 'Trimmed selection starts in UI element, hiding');
                    this.hide();
                    return;
                }

                selection.removeAllRanges();
                selection.addRange(trimmed);

                // Check whether the trimmed range falls inside an existing highlight.
                const isHighlightedTrimmed = startElement.closest(CONFIG.SELECTORS.HIGHLIGHT_CLASSES);
                this.show(trimmed, isHighlightedTrimmed);
            }
            return;
        }

        // Check whether the selection already lies inside a highlight.
        const isHighlighted = element.closest(CONFIG.SELECTORS.HIGHLIGHT_CLASSES);

        this.show(range, isHighlighted);
    }

    handleHighlightClick(highlightedElement: Element): void {
        // If the popover is already visible, handleSelection just placed it — don't overwrite.
        if (this.isVisible()) {
            Logger.log('PopoverManager', 'handleHighlightClick: ignored because popover is already visible');
            return;
        }

        this.#currentHighlightedElement = highlightedElement;
        this.#updateContent(highlightedElement, false);

        this.#placeAt(highlightedElement.getBoundingClientRect());
    }

    /**
     * Place the popover relative to an anchor rect: measure (while hidden),
     * centre horizontally, flip above when below lacks headroom, constrain to
     * the viewport, apply the saved drag offset, then arm dragging.
     */
    #placeAt(rect: DOMRect): void {
        // Render hidden first to measure final dimensions before placing.
        this.#element.style.visibility = 'hidden';
        this.#element.style.display = 'block';

        const popoverHeight = this.#element.offsetHeight;
        const popoverWidth = this.#element.offsetWidth;

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

    #createElement(): void {
        this.#element = document.createElement('div');
        this.#element.className = 'selection-popover';
        this.#updateContent(null);

        document.body.appendChild(this.#element);

        // Wire up the click handler.
        this.#element.addEventListener('click', (e: MouseEvent) => {
            const target = e.target as HTMLElement | null;
            // Resolve the owning [data-action] button via closest() so a click
            // on any child node (icon, nested span) still maps to its action.
            const action = target?.closest<HTMLElement>('[data-action]')?.dataset.action;
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
            // In shared workspaces, merge the author attribution (colour dot +
            // nickname + time) into this menu instead of a separate tooltip.
            const author = this.#authorSegment(highlightedElement);
            if (hasSelection) {
                // Highlighted with selection: [author] Unhighlight + Note + Edit + Chat
                Logger.log('PopoverManager', 'Showing: Unhighlight + Note + Edit + Chat');
                this.#element.innerHTML = `
                    ${dragHandle}
                    ${author}
                    <button data-action="unhighlight">${_t('web.annot.unhighlight')}</button>
                    <span class="popover-separator">|</span>
                    <button data-action="add-note">${_t('web.annot.note')}</button>
                    ${editButton}
                    ${chatButton}
                `;
            } else {
                // Highlighted without selection (just click): [author] Unhighlight
                Logger.log('PopoverManager', 'Showing: Unhighlight');
                this.#element.innerHTML = `${dragHandle}${author}<button data-action="unhighlight">${_t('web.annot.unhighlight')}</button>`;
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

    /** Author attribution segment for the popover (shared workspaces only):
     *  a colour dot + nickname + compact time, read from the element's data
     *  attrs. The colour is validated to a hex literal so a hostile peer's
     *  author colour can't inject CSS into the style attribute; the nickname is
     *  HTML-escaped. */
    #authorSegment(el: Element): string {
        if (!document.body.classList.contains('markon-shared')) return '';
        const he = el as HTMLElement;
        const raw = he.style.getPropertyValue('--anno-author').trim();
        const color = /^#[0-9a-f]{3,8}$/i.test(raw) ? raw : 'var(--markon-fg-muted)';
        const name = he.dataset.authorName || _t('web.author.anon');
        let time = '';
        const ts = Number(he.dataset.authorTime);
        if (ts) {
            const d = new Date(ts);
            const p = (n: number): string => String(n).padStart(2, '0');
            time = `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
        }
        return (
            '<span class="popover-author">' +
            `<span class="popover-author-dot" style="background:${color}"></span>` +
            `<span class="popover-author-name">${Text.escape(name)}</span>` +
            (time ? `<span class="popover-author-time">${time}</span>` : '') +
            '</span><span class="popover-separator">|</span>'
        );
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
     * Initialize the drag behavior.
     */
    #initDraggable(): void {
        // Tear down any previous instance before creating a new one.
        if (this.#draggable) {
            this.#draggable.destroy();
        }

        // Spin up a fresh draggable instance.
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
     * Retrieve the persisted offset from localStorage.
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
