/**
 * TOCNavigator - 目录导航器
 * 提供键盘导航目录的功能（j/k 上下移动，Enter 跳转，折叠/展开等）
 */

import { CONFIG } from '../core/config.js';
import { Logger } from '../core/utils.js';

/**
 * TOC 导航器类
 */
export class TOCNavigator {
    #active = false;
    #focusedIndex = -1;
    #links = [];
    #keydownHandler = null;
    #collapsedItems = new Set(); // 按索引跟踪折叠的项

    /**
     * 激活导航器
     */
    activate() {
        // 获取所有 TOC 链接
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

        // 恢复之前的焦点位置，或查找当前活动链接，或默认第一个
        if (this.#focusedIndex < 0 || this.#focusedIndex >= this.#links.length) {
            const activeLink = tocContainer.querySelector('.toc-item a.active');
            this.#focusedIndex = activeLink ? this.#links.indexOf(activeLink) : 0;
        }

        // 初始化折叠指示器
        this.#links.forEach((link, index) => {
            this.#updateCollapseIndicator(index);
        });

        // 设置初始焦点
        this.#setFocus(this.#focusedIndex);

        // 设置键盘处理器
        this.#active = true;
        this.#setupKeyboardHandler();

        // 添加视觉边框表示活动导航
        tocContainer.classList.add('toc-nav-active');

        Logger.log('TOCNavigator', 'Activated');
    }

    /**
     * 停用导航器
     */
    deactivate() {
        this.#active = false;
        this.#clearFocus();
        this.#removeKeyboardHandler();

        // 移除视觉边框
        const tocContainer = document.querySelector(CONFIG.SELECTORS.TOC_CONTAINER);
        if (tocContainer) {
            tocContainer.classList.remove('toc-nav-active');
        }

        Logger.log('TOCNavigator', 'Deactivated');
    }

    /**
     * 检查是否活动
     * @returns {boolean}
     */
    get active() {
        return this.#active;
    }

    /**
     * 设置键盘处理器
     * @private
     */
    #setupKeyboardHandler() {
        if (this.#keydownHandler) {
            this.#removeKeyboardHandler();
        }

        this.#keydownHandler = (e) => {
            if (!this.#active) return;

            // 仅在非输入框时处理按键
            const target = e.target;
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
                this.#expandOrMoveToChild();
                handled = true;
                break;

            case 'ArrowLeft':
                e.preventDefault();
                this.#collapseOrMoveToParent();
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

        // 使用捕获阶段以高优先级添加
        document.addEventListener('keydown', this.#keydownHandler, true);
    }

    /**
     * 移除键盘处理器
     * @private
     */
    #removeKeyboardHandler() {
        if (this.#keydownHandler) {
            document.removeEventListener('keydown', this.#keydownHandler, true);
            this.#keydownHandler = null;
        }
    }

    /**
     * 设置焦点
     * @private
     */
    #setFocus(index) {
        if (index < 0 || index >= this.#links.length) {
            return;
        }

        // 清除之前的焦点
        this.#clearFocus();

        // 设置新焦点
        this.#focusedIndex = index;
        const link = this.#links[index];
        link.classList.add('toc-focused');

        // 滚动到可见
        link.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    /**
     * 清除焦点
     * @private
     */
    #clearFocus() {
        this.#links.forEach(link => link.classList.remove('toc-focused'));
    }

    /**
     * 移动到下一个
     * @private
     */
    #moveNext() {
        for (let i = this.#focusedIndex + 1; i < this.#links.length; i++) {
            if (this.#isVisible(i)) {
                this.#setFocus(i);
                return;
            }
        }
    }

    /**
     * 移动到上一个
     * @private
     */
    #movePrevious() {
        for (let i = this.#focusedIndex - 1; i >= 0; i--) {
            if (this.#isVisible(i)) {
                this.#setFocus(i);
                return;
            }
        }
    }

    /**
     * 展开或移动到子项
     * @private
     */
    #expandOrMoveToChild() {
        const children = this.#getChildren(this.#focusedIndex);

        if (children.length === 0) {
            return;
        }

        if (this.#collapsedItems.has(this.#focusedIndex)) {
            // 已折叠，展开
            this.#collapsedItems.delete(this.#focusedIndex);
            this.#updateVisibility();
            this.#updateCollapseIndicator(this.#focusedIndex);
        } else {
            // 已展开，移动到第一个子项
            this.#setFocus(children[0]);
        }
    }

    /**
     * 折叠或移动到父项
     * @private
     */
    #collapseOrMoveToParent() {
        const children = this.#getChildren(this.#focusedIndex);

        if (children.length > 0 && !this.#collapsedItems.has(this.#focusedIndex)) {
            // 有可见子项，折叠
            this.#collapsedItems.add(this.#focusedIndex);
            this.#updateVisibility();
            this.#updateCollapseIndicator(this.#focusedIndex);
        } else {
            // 已折叠或无子项，移动到父项
            const parentIndex = this.#getParentIndex(this.#focusedIndex);
            if (parentIndex !== -1) {
                this.#setFocus(parentIndex);
            }
        }
    }

    /**
     * 检查是否有子项
     * @private
     */
    #hasChildren(index) {
        return this.#getChildren(index).length > 0;
    }

    /**
     * 获取子项
     * @private
     */
    #getChildren(index) {
        if (index < 0 || index >= this.#links.length) {
            return [];
        }

        const currentLevel = this.#getLevel(index);
        const children = [];

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
     * 获取父项索引
     * @private
     */
    #getParentIndex(index) {
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
     * 获取级别
     * @private
     */
    #getLevel(index) {
        if (index < 0 || index >= this.#links.length) {
            return 0;
        }

        const link = this.#links[index];
        const li = link.closest('li');
        const levelClass = Array.from(li.classList).find(c => c.startsWith('toc-level-'));
        return levelClass ? parseInt(levelClass.split('-')[2]) : 0;
    }

    /**
     * 检查是否可见
     * @private
     */
    #isVisible(index) {
        const currentLevel = this.#getLevel(index);

        for (let i = index - 1; i >= 0; i--) {
            const level = this.#getLevel(i);

            if (level < currentLevel) {
                if (this.#collapsedItems.has(i)) {
                    const children = this.#getAllDescendants(i);
                    if (children.includes(index)) {
                        return false;
                    }
                }
            }
        }

        return true;
    }

    /**
     * 获取所有后代
     * @private
     */
    #getAllDescendants(index) {
        if (index < 0 || index >= this.#links.length) {
            return [];
        }

        const currentLevel = this.#getLevel(index);
        const descendants = [];

        for (let i = index + 1; i < this.#links.length; i++) {
            const level = this.#getLevel(i);
            if (level <= currentLevel) {
                break;
            }
            descendants.push(i);
        }

        return descendants;
    }

    /**
     * 更新可见性
     * @private
     */
    #updateVisibility() {
        this.#links.forEach((link, index) => {
            const li = link.closest('li');
            li.style.display = this.#isVisible(index) ? '' : 'none';
        });
    }

    /**
     * 更新折叠指示器
     * @private
     */
    #updateCollapseIndicator(index) {
        if (index < 0 || index >= this.#links.length) {
            return;
        }

        const link = this.#links[index];
        const hasChildren = this.#hasChildren(index);

        if (!hasChildren) {
            // 移除指示器
            const existing = link.querySelector('.toc-collapse-indicator');
            if (existing) {
                existing.remove();
            }
            return;
        }

        // 添加或更新指示器
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
     * 导航到当前焦点项
     * @private
     */
    #navigate() {
        if (this.#focusedIndex >= 0 && this.#focusedIndex < this.#links.length) {
            const link = this.#links[this.#focusedIndex];
            link.click();
            this.#close();
        }
    }

    /**
     * 关闭导航器
     * @private
     */
    #close() {
        const tocContainer = document.querySelector(CONFIG.SELECTORS.TOC_CONTAINER);
        if (tocContainer) {
            tocContainer.classList.remove('active');
        }
        this.deactivate();
    }
}
