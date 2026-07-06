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
 * Annotation navigator class.
 */
export class AnnotationNavigator {
    #currentIndex = -1;
    #annotations: NavAnnotation[] = [];

    /**
     * Gather every annotation (highlights + notes) in document order.
     */
    #getAllAnnotations(): NavAnnotation[] {
        const markdownBody =
            (document.querySelector('[data-markon-interactive-body]')) ??
            (document.querySelector(CONFIG.SELECTORS.MARKDOWN_BODY));
        if (!markdownBody) return [];

        const annotations: NavAnnotation[] = [];

        // Collect every highlight (skip noted ones — handled separately below).
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

        // Collect every note (only the outermost has-note element).
        const notes = markdownBody.querySelectorAll('.has-note[data-annotation-id]');
        notes.forEach((el) => {
            const htmlEl = el as HTMLElement;
            // Include only the outermost has-note element.
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

        // Sort by document position.
        annotations.sort((a, b) => a.position - b.position);

        return annotations;
    }

    /**
     * Navigate to the next annotation.
     */
    next(): void {
        this.#annotations = this.#getAllAnnotations();
        if (this.#annotations.length === 0) {
            Logger.log('AnnotationNavigator', 'No annotations found');
            return;
        }

        // Advance the cursor.
        this.#currentIndex = (this.#currentIndex + 1) % this.#annotations.length;
        const annotation = this.#annotations[this.#currentIndex];
        if (annotation) this.#focusAnnotation(annotation);
    }

    /**
     * Navigate to the previous annotation.
     */
    previous(): void {
        this.#annotations = this.#getAllAnnotations();
        if (this.#annotations.length === 0) {
            Logger.log('AnnotationNavigator', 'No annotations found');
            return;
        }

        // Step the cursor backward.
        this.#currentIndex = this.#currentIndex <= 0 ? this.#annotations.length - 1 : this.#currentIndex - 1;
        const annotation = this.#annotations[this.#currentIndex];
        if (annotation) this.#focusAnnotation(annotation);
    }

    /**
     * Focus an annotation and surface visual feedback.
     */
    #focusAnnotation(annotation: NavAnnotation): void {
        // Clear the previous focus indicator.
        this.#clearFocus();

        const { element, type } = annotation;

        // Scroll the element into view.
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });

        if (type === 'highlight') {
            // Highlight: add an outline.
            element.classList.add('annotation-focused');
        } else if (type === 'note') {
            const isNarrowScreen = PlatformUtils.isNarrowScreen();

            if (isNarrowScreen) {
                // Narrow screen: pop the modal (without auto-focusing it).
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

                // Fallback in case the scroll never fires.
                setTimeout(() => {
                    window.removeEventListener('scroll', handleScrollEnd);
                    element.click();
                    element.classList.add('annotation-focused');
                }, 600);
            } else {
                // Wide screen: highlight both the note element and its margin card.
                element.classList.add('annotation-focused');

                // Locate and highlight the matching margin card.
                const annotationId = element.dataset['annotationId'];
                if (annotationId) {
                    const noteCard = document.querySelector(
                        `.note-card-margin[data-annotation-id="${annotationId}"]`,
                    );
                    if (noteCard) {
                        noteCard.classList.add('highlight-active');

                        // Scroll the note card into view if needed.
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
     * Clear every focus indicator.
     */
    #clearFocus(): void {
        // Clear annotation focus.
        document.querySelectorAll('.annotation-focused').forEach((el) => {
            el.classList.remove('annotation-focused');
        });

        // Clear the margin-note card highlight.
        document.querySelectorAll('.note-card-margin.highlight-active').forEach((el) => {
            el.classList.remove('highlight-active');
        });

        // Close the open narrow-screen note popup.
        const existingPopup = document.querySelector('.note-popup');
        if (existingPopup) {
            existingPopup.remove();
        }

        // Clear the highlight-active class on note elements.
        document.querySelectorAll('.has-note.highlight-active').forEach((el) => {
            el.classList.remove('highlight-active');
        });
    }
}
