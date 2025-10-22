/**
 * AnnotationNavigator - 注解导航器
 * 提供在注解之间导航的功能（Ctrl+j/k）
 */

import { CONFIG } from '../core/config.js';
import { PlatformUtils, Logger } from '../core/utils.js';

/**
 * 注解导航器类
 */
export class AnnotationNavigator {
    #currentIndex = -1;
    #annotations = [];

    /**
     * 获取所有注解（高亮 + 笔记）按文档顺序
     * @returns {Array}
     */
    #getAllAnnotations() {
        const markdownBody = document.querySelector(CONFIG.SELECTORS.MARKDOWN_BODY);
        if (!markdownBody) return [];

        const annotations = [];

        // 获取所有高亮（排除笔记，因为笔记单独处理）
        const highlights = markdownBody.querySelectorAll(CONFIG.SELECTORS.HIGHLIGHT_CLASSES);
        highlights.forEach(el => {
            if (!el.classList.contains('has-note')) {
                annotations.push({
                    element: el,
                    type: 'highlight',
                    position: el.getBoundingClientRect().top + window.scrollY
                });
            }
        });

        // 获取所有笔记（仅最外层的 has-note 元素）
        const notes = markdownBody.querySelectorAll('.has-note[data-annotation-id]');
        notes.forEach(el => {
            // 仅包含最外层 has-note 元素
            let parent = el.parentElement;
            let isNested = false;
            while (parent && parent !== markdownBody) {
                if (parent.classList && parent.classList.contains('has-note')) {
                    isNested = true;
                    break;
                }
                parent = parent.parentElement;
            }
            if (!isNested) {
                annotations.push({
                    element: el,
                    type: 'note',
                    position: el.getBoundingClientRect().top + window.scrollY
                });
            }
        });

        // 按文档位置排序
        annotations.sort((a, b) => a.position - b.position);

        return annotations;
    }

    /**
     * 导航到下一个注解
     */
    next() {
        this.#annotations = this.#getAllAnnotations();
        if (this.#annotations.length === 0) {
            Logger.log('AnnotationNavigator', 'No annotations found');
            return;
        }

        // 移动到下一个
        this.#currentIndex = (this.#currentIndex + 1) % this.#annotations.length;
        this.#focusAnnotation(this.#annotations[this.#currentIndex]);
    }

    /**
     * 导航到上一个注解
     */
    previous() {
        this.#annotations = this.#getAllAnnotations();
        if (this.#annotations.length === 0) {
            Logger.log('AnnotationNavigator', 'No annotations found');
            return;
        }

        // 移动到上一个
        this.#currentIndex = this.#currentIndex <= 0 ? this.#annotations.length - 1 : this.#currentIndex - 1;
        this.#focusAnnotation(this.#annotations[this.#currentIndex]);
    }

    /**
     * 聚焦注解并提供视觉反馈
     * @private
     */
    #focusAnnotation(annotation) {
        // 清除之前的焦点
        this.#clearFocus();

        const { element, type } = annotation;

        // 滚动到可见
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });

        if (type === 'highlight') {
            // 高亮：添加轮廓
            element.classList.add('annotation-focused');
        } else if (type === 'note') {
            const isNarrowScreen = PlatformUtils.isNarrowScreen();

            if (isNarrowScreen) {
                // 窄屏：显示弹窗（不自动聚焦）
                let scrollEndTimer;
                const handleScrollEnd = () => {
                    clearTimeout(scrollEndTimer);
                    scrollEndTimer = setTimeout(() => {
                        window.removeEventListener('scroll', handleScrollEnd);
                        element.click();
                        element.classList.add('annotation-focused');
                    }, 100);
                };
                window.addEventListener('scroll', handleScrollEnd);

                // 回退（如果滚动未发生）
                setTimeout(() => {
                    window.removeEventListener('scroll', handleScrollEnd);
                    element.click();
                    element.classList.add('annotation-focused');
                }, 600);
            } else {
                // 宽屏：高亮笔记元素和笔记卡
                element.classList.add('annotation-focused');

                // 查找并高亮对应的笔记卡
                const annotationId = element.dataset.annotationId;
                if (annotationId) {
                    const noteCard = document.querySelector(`.note-card-margin[data-annotation-id="${annotationId}"]`);
                    if (noteCard) {
                        noteCard.classList.add('highlight-active');

                        // 如果需要，滚动笔记卡到可见
                        const noteRect = noteCard.getBoundingClientRect();
                        if (noteRect.top < 0 || noteRect.bottom > window.innerHeight) {
                            noteCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        }
                    }
                }
            }
        }

        Logger.log('AnnotationNavigator', `Focused ${type} annotation`);
    }

    /**
     * 清除所有焦点指示器
     * @private
     */
    #clearFocus() {
        // 清除注解焦点
        document.querySelectorAll('.annotation-focused').forEach(el => {
            el.classList.remove('annotation-focused');
        });

        // 清除笔记卡高亮
        document.querySelectorAll('.note-card-margin.highlight-active').forEach(el => {
            el.classList.remove('highlight-active');
        });

        // 关闭打开的笔记弹窗（窄屏）
        const existingPopup = document.querySelector('.note-popup');
        if (existingPopup) {
            existingPopup.remove();
        }

        // 清除笔记元素的 highlight-active
        document.querySelectorAll('.has-note.highlight-active').forEach(el => {
            el.classList.remove('highlight-active');
        });
    }
}
