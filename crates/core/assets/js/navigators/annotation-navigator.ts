/**
 * AnnotationNavigator - Annotation navigator
 * Provides navigation between annotations (Ctrl+j/k)
 */

import { CONFIG } from '../core/config';
import { PlatformUtils, Logger } from '../core/utils';

/**
 * Minimal shape used by this navigator. The full Annotation model lives
 * elsewhere (annotation-manager) — this only captures fields we need.
 */
export interface NavAnnotation {
    /** The DOM element representing the annotation. */
    element: HTMLElement;
    /** Either a colored highlight/strikethrough or a noted span. */
    type: 'highlight' | 'note';
    /** Document-coordinate Y of the element's top edge. */
    position: number;
}

/**
 * Annotation navigator类
 */
export class AnnotationNavigator {
    #currentIndex = -1;
    #annotations: NavAnnotation[] = [];

    /**
     * Get所有注解（Highlight + Note）按Document顺序
     */
    #getAllAnnotations(): NavAnnotation[] {
        const markdownBody = document.querySelector(CONFIG.SELECTORS.MARKDOWN_BODY) as HTMLElement | null;
        if (!markdownBody) return [];

        const annotations: NavAnnotation[] = [];

        // Get所有Highlight（排除Note，因为Note单独Handle）
        const highlights = markdownBody.querySelectorAll(CONFIG.SELECTORS.HIGHLIGHT_CLASSES);
        highlights.forEach((el) => {
            const htmlEl = el as HTMLElement;
            if (!htmlEl.classList.contains('has-note')) {
                annotations.push({
                    element: htmlEl,
                    type: 'highlight',
                    position: htmlEl.getBoundingClientRect().top + window.scrollY,
                });
            }
        });

        // Get所有Note（仅最外层的 has-note Element）
        const notes = markdownBody.querySelectorAll('.has-note[data-annotation-id]');
        notes.forEach((el) => {
            const htmlEl = el as HTMLElement;
            // 仅包含最外层 has-note Element
            let parent: HTMLElement | null = htmlEl.parentElement;
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
                    element: htmlEl,
                    type: 'note',
                    position: htmlEl.getBoundingClientRect().top + window.scrollY,
                });
            }
        });

        // 按Document位置Sort
        annotations.sort((a, b) => a.position - b.position);

        return annotations;
    }

    /**
     * Navigation到下一个注解
     */
    next(): void {
        this.#annotations = this.#getAllAnnotations();
        if (this.#annotations.length === 0) {
            Logger.log('AnnotationNavigator', 'No annotations found');
            return;
        }

        // move到下一个
        this.#currentIndex = (this.#currentIndex + 1) % this.#annotations.length;
        this.#focusAnnotation(this.#annotations[this.#currentIndex]);
    }

    /**
     * Navigation到上一个注解
     */
    previous(): void {
        this.#annotations = this.#getAllAnnotations();
        if (this.#annotations.length === 0) {
            Logger.log('AnnotationNavigator', 'No annotations found');
            return;
        }

        // move到上一个
        this.#currentIndex = this.#currentIndex <= 0 ? this.#annotations.length - 1 : this.#currentIndex - 1;
        this.#focusAnnotation(this.#annotations[this.#currentIndex]);
    }

    /**
     * 聚焦注解并提供视觉反馈
     */
    #focusAnnotation(annotation: NavAnnotation): void {
        // Clear之前的焦点
        this.#clearFocus();

        const { element, type } = annotation;

        // 滚动到可见
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });

        if (type === 'highlight') {
            // Highlight：添加轮廓
            element.classList.add('annotation-focused');
        } else if (type === 'note') {
            const isNarrowScreen = PlatformUtils.isNarrowScreen();

            if (isNarrowScreen) {
                // 窄屏：ShowModal（不自动聚焦）
                let scrollEndTimer: ReturnType<typeof setTimeout> | undefined;
                const handleScrollEnd = (): void => {
                    if (scrollEndTimer !== undefined) clearTimeout(scrollEndTimer);
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
                // 宽屏：HighlightNoteElement和Note卡
                element.classList.add('annotation-focused');

                // Find并Highlight对应的Note卡
                const annotationId = element.dataset.annotationId;
                if (annotationId) {
                    const noteCard = document.querySelector(
                        `.note-card-margin[data-annotation-id="${annotationId}"]`,
                    ) as HTMLElement | null;
                    if (noteCard) {
                        noteCard.classList.add('highlight-active');

                        // 如果需要，滚动Note卡到可见
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
     * Clear所有焦点指示器
     */
    #clearFocus(): void {
        // Clear注解焦点
        document.querySelectorAll('.annotation-focused').forEach((el) => {
            el.classList.remove('annotation-focused');
        });

        // ClearNote卡Highlight
        document.querySelectorAll('.note-card-margin.highlight-active').forEach((el) => {
            el.classList.remove('highlight-active');
        });

        // CloseOpen的NoteModal（窄屏）
        const existingPopup = document.querySelector('.note-popup');
        if (existingPopup) {
            existingPopup.remove();
        }

        // ClearNoteElement的 highlight-active
        document.querySelectorAll('.has-note.highlight-active').forEach((el) => {
            el.classList.remove('highlight-active');
        });
    }
}
