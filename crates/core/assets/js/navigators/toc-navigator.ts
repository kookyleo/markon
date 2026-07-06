/**
 * TOCNavigator - TOC navigator
 * Provides keyboard-driven TOC navigation (j/k to move, Enter to jump,
 * arrow-left/right to collapse/expand, etc.).
 */

import { CONFIG } from '../core/config';
import { Logger } from '../core/utils';

/**
 * TOC navigator class.
 */
export class TOCNavigator {
    #active = false;
    #focusedIndex = -1;
    #links: HTMLAnchorElement[] = [];
    #levels: number[] = [];
    #keydownHandler: ((e: KeyboardEvent) => void) | null = null;
    #collapsedItems = new Set<number>(); // tracks collapsed items by index

    /**
     * Activate the navigator.
     */
    activate(): void {
        // Collect every TOC link.
        const tocContainer = document.querySelector(CONFIG.SELECTORS.TOC_CONTAINER);
        if (!tocContainer) {
            Logger.warn('TOCNavigator', 'TOC container not found');
            return;
        }

        this.#links = Array.from(tocContainer.querySelectorAll('.toc-item a'));
        if (this.#links.length === 0) {
            Logger.warn('TOCNavigator', 'No TOC links found');
            return;
        }

        // Cache heading levels once per activation — the TOC structure is
        // static while the navigator is active.
        this.#levels = this.#links.map((link) => {
            const li = link.closest('li');
            if (!li) return 0;
            const levelClass = Array.from(li.classList).find((c) => c.startsWith('toc-level-'));
            return levelClass ? Number.parseInt(levelClass.split('-')[2] ?? '0', 10) : 0;
        });

        // Restore the previous focus, fall back to the active link, then to the first item.
        if (this.#focusedIndex < 0 || this.#focusedIndex >= this.#links.length) {
            const activeLink = (tocContainer.querySelector<HTMLAnchorElement>('.toc-item.viewport a')
                ?? tocContainer.querySelector<HTMLAnchorElement>('.toc-item a.selected'));
            this.#focusedIndex = activeLink ? this.#links.indexOf(activeLink) : 0;
        }

        // Initialize the collapse indicators.
        this.#links.forEach((_link, index) => {
            this.#updateCollapseIndicator(index);
        });

        // Place initial focus.
        this.#setFocus(this.#focusedIndex);

        // Install the keyboard handler.
        this.#active = true;
        this.#setupKeyboardHandler();

        // Add the active-navigation visual border.
        tocContainer.classList.add('toc-nav-active');
        tocContainer.classList.add('markon-modal-layer');
        tocContainer.querySelector('.toc')?.classList.add('markon-modal-frame');

        Logger.log('TOCNavigator', 'Activated');
    }

    /**
     * Deactivate the navigator.
     */
    deactivate(): void {
        this.#active = false;
        this.#clearFocus();
        this.#removeKeyboardHandler();

        // Remove the active-navigation visual border.
        const tocContainer = document.querySelector(CONFIG.SELECTORS.TOC_CONTAINER);
        if (tocContainer) {
            tocContainer.classList.remove('toc-nav-active');
            const keepMobileFrame =
                window.innerWidth <= CONFIG.BREAKPOINTS.WIDE_SCREEN &&
                tocContainer.classList.contains('active');
            if (!keepMobileFrame) {
                tocContainer.classList.remove('markon-modal-layer');
                tocContainer.querySelector('.toc')?.classList.remove('markon-modal-frame');
            }
        }

        Logger.log('TOCNavigator', 'Deactivated');
    }

    /**
     * Whether the navigator is currently active.
     */
    get active(): boolean {
        return this.#active;
    }

    /**
     * Install the keyboard handler.
     */
    #setupKeyboardHandler(): void {
        if (this.#keydownHandler) {
            this.#removeKeyboardHandler();
        }

        this.#keydownHandler = (e: KeyboardEvent) => {
            if (!this.#active) return;

            // Only handle keys when focus is not inside an input field.
            const target = e.target as HTMLElement | null;
            if (!target) return;
            if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
                return;
            }

            let handled = false;

            switch (e.key) {
            case 'j':
            case 'ArrowDown':
                e.preventDefault();
                this.#moveNext();
                handled = true;
                break;

            case 'k':
            case 'ArrowUp':
                e.preventDefault();
                this.#movePrevious();
                handled = true;
                break;

            case 'ArrowRight':
                e.preventDefault();
                this.#expandOrmoveToChild();
                handled = true;
                break;

            case 'ArrowLeft':
                e.preventDefault();
                this.#collapseOrmoveToParent();
                handled = true;
                break;

            case 'Enter':
                e.preventDefault();
                this.#navigate();
                handled = true;
                break;

            case 'Escape':
                e.preventDefault();
                this.#close();
                handled = true;
                break;
            }

            if (handled) {
                e.stopPropagation();
            }
        };

        // Register on the capture phase to claim higher priority.
        document.addEventListener('keydown', this.#keydownHandler, true);
    }

    /**
     * Remove the keyboard handler.
     */
    #removeKeyboardHandler(): void {
        if (this.#keydownHandler) {
            document.removeEventListener('keydown', this.#keydownHandler, true);
            this.#keydownHandler = null;
        }
    }

    /**
     * Set focus on the link at the given index.
     */
    #setFocus(index: number): void {
        if (index < 0 || index >= this.#links.length) {
            return;
        }

        // Clear the previous focus indicator.
        this.#clearFocus();

        // Apply the new focus indicator.
        this.#focusedIndex = index;
        const link = this.#links[index];
        if (!link) return;
        link.classList.add('toc-focused');

        // Scroll the focused link into view.
        link.scrollIntoView({ block: 'nearest' });
    }

    /**
     * Clear focus.
     */
    #clearFocus(): void {
        this.#links.forEach((link) => link.classList.remove('toc-focused'));
    }

    /**
     * Move focus to the next visible item.
     */
    #moveNext(): void {
        for (let i = this.#focusedIndex + 1; i < this.#links.length; i++) {
            if (this.#isVisible(i)) {
                this.#setFocus(i);
                return;
            }
        }
    }

    /**
     * Move focus to the previous visible item.
     */
    #movePrevious(): void {
        for (let i = this.#focusedIndex - 1; i >= 0; i--) {
            if (this.#isVisible(i)) {
                this.#setFocus(i);
                return;
            }
        }
    }

    /**
     * Expand the focused item, or jump to its first child if already expanded.
     */
    #expandOrmoveToChild(): void {
        const children = this.#getChildren(this.#focusedIndex);

        if (children.length === 0) {
            return;
        }

        if (this.#collapsedItems.has(this.#focusedIndex)) {
            // Currently collapsed: expand it.
            this.#collapsedItems.delete(this.#focusedIndex);
            this.#updateVisibility();
            this.#updateCollapseIndicator(this.#focusedIndex);
        } else {
            // Already expanded: jump to the first child.
            const firstChild = children[0];
            if (firstChild !== undefined) this.#setFocus(firstChild);
        }
    }

    /**
     * Collapse the focused item, or jump to its parent if there's nothing to collapse.
     */
    #collapseOrmoveToParent(): void {
        const children = this.#getChildren(this.#focusedIndex);

        if (children.length > 0 && !this.#collapsedItems.has(this.#focusedIndex)) {
            // Visible children present: collapse them.
            this.#collapsedItems.add(this.#focusedIndex);
            this.#updateVisibility();
            this.#updateCollapseIndicator(this.#focusedIndex);
        } else {
            // Already collapsed or leaf node: jump to the parent.
            const parentIndex = this.#getParentIndex(this.#focusedIndex);
            if (parentIndex !== -1) {
                this.#setFocus(parentIndex);
            }
        }
    }

    /**
     * Whether the item has child entries.
     */
    #hasChildren(index: number): boolean {
        return this.#getChildren(index).length > 0;
    }

    /**
     * Return the direct child indices of `index`.
     */
    #getChildren(index: number): number[] {
        if (index < 0 || index >= this.#links.length) {
            return [];
        }

        const currentLevel = this.#getLevel(index);
        const children: number[] = [];

        for (let i = index + 1; i < this.#links.length; i++) {
            const level = this.#getLevel(i);
            if (level <= currentLevel) {
                break;
            }
            if (level === currentLevel + 1) {
                children.push(i);
            }
        }

        return children;
    }

    /**
     * Return the parent index of `index`, or -1 when there's no parent.
     */
    #getParentIndex(index: number): number {
        if (index <= 0 || index >= this.#links.length) {
            return -1;
        }

        const currentLevel = this.#getLevel(index);

        for (let i = index - 1; i >= 0; i--) {
            const level = this.#getLevel(i);
            if (level < currentLevel) {
                return i;
            }
        }

        return -1;
    }

    /**
     * Return the heading level of the item.
     */
    #getLevel(index: number): number {
        if (index < 0 || index >= this.#links.length) {
            return 0;
        }

        return this.#levels[index] ?? 0;
    }

    /**
     * Whether the item is currently visible (not hidden under a collapsed ancestor).
     */
    #isVisible(index: number): boolean {
        for (let i = this.#getParentIndex(index); i !== -1; i = this.#getParentIndex(i)) {
            if (this.#collapsedItems.has(i)) {
                return false;
            }
        }

        return true;
    }

    /**
     * Refresh the visibility of every TOC entry.
     */
    #updateVisibility(): void {
        this.#links.forEach((link, index) => {
            const li = link.closest('li') as HTMLElement | null;
            if (li) {
                li.style.display = this.#isVisible(index) ? '' : 'none';
            }
        });
    }

    /**
     * Refresh the collapse indicator for the item.
     */
    #updateCollapseIndicator(index: number): void {
        if (index < 0 || index >= this.#links.length) {
            return;
        }

        const link = this.#links[index];
        if (!link) return;
        const hasChildren = this.#hasChildren(index);

        if (!hasChildren) {
            // Remove the indicator.
            const existing = link.querySelector('.toc-collapse-indicator');
            if (existing) {
                existing.remove();
            }
            return;
        }

        // Add or update the indicator.
        let indicator = link.querySelector('.toc-collapse-indicator');
        if (!indicator) {
            indicator = document.createElement('span');
            indicator.className = 'toc-collapse-indicator';
            link.insertBefore(indicator, link.firstChild);
        }

        const isCollapsed = this.#collapsedItems.has(index);
        indicator.textContent = isCollapsed ? '▶ ' : '▼ ';
    }

    /**
     * Jump to the currently focused item.
     */
    #navigate(): void {
        if (this.#focusedIndex >= 0 && this.#focusedIndex < this.#links.length) {
            const link = this.#links[this.#focusedIndex];
            if (!link) return;
            link.click();
            this.#close();
        }
    }

    /**
     * Close the navigator.
     */
    #close(): void {
        const tocContainer = document.querySelector(CONFIG.SELECTORS.TOC_CONTAINER);
        if (tocContainer) {
            tocContainer.classList.remove('active');
            tocContainer.classList.remove('markon-modal-layer');
            tocContainer.querySelector('.toc')?.classList.remove('markon-modal-frame');
        }
        this.deactivate();
    }
}
