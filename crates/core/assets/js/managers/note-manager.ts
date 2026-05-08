/**
 * NoteManager - Note card manager
 * Handles note rendering, layout, and responsive handling
 */

import { CONFIG } from '../core/config';
import { PlatformUtils, Logger, debounce } from '../core/utils';
import { LayoutEngine } from '../services/layout';
import { Text } from '../services/text';
import type { AnnotationManager, Annotation } from './annotation-manager';

const _t: (key: string, ...args: unknown[]) => string =
    (typeof window !== 'undefined' && window.__MARKON_I18N__ && window.__MARKON_I18N__.t) ||
    ((k: string) => k);

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Internal in-memory record kept per rendered note card. Exposed via
 * `getNoteCardsData()` so peers (e.g. popover-manager) can locate the
 * card element associated with a highlight.
 */
export interface NoteCard {
    /** The floating `.note-card-margin` element appended to `<body>`. */
    element: HTMLDivElement;
    /** ID of the underlying annotation. */
    highlightId: string;
    /** The in-document highlight element this card anchors to. */
    highlightElement: Element;
    /** Mirrored from the annotation's `text` field. */
    text: string;
    /** Mirrored from the annotation's `note` field (always non-empty here). */
    note: string;
}

export class NoteManager {
    #annotationManager: AnnotationManager;
    #markdownBody: HTMLElement;
    #noteCardsData: NoteCard[] = [];
    #layoutEngine: LayoutEngine;
    #activeAnnotationId: string | null = null;
    #connectorSvg: SVGSVGElement | null = null;
    #connectorPath: SVGPathElement | null = null;
    #resizeObserver: ResizeObserver | null = null;
    #scrollHandler: (() => void) | null = null;

    constructor(annotationManager: AnnotationManager, markdownBody: HTMLElement) {
        this.#annotationManager = annotationManager;
        this.#markdownBody = markdownBody;
        this.#layoutEngine = new LayoutEngine();
    }

    render(): void {
        // 移除现有的边距Note
        this.clear();

        // Get所有带Note的HighlightElement（仅最外层）
        const allHighlightElements = this.#markdownBody.querySelectorAll<HTMLElement>(
            '.has-note[data-annotation-id]',
        );
        const outermostElements = this.#filterOutermost(allHighlightElements);

        if (outermostElements.length === 0) {
            return;
        }

        // Get注解Data
        const annotations = this.#annotationManager.getAll();
        const annotationsMap = new Map<string, Annotation>(annotations.map(a => [a.id, a]));

        // CreateNote卡片
        outermostElements.forEach(highlightElement => {
            const annoId = highlightElement.dataset.annotationId;
            if (!annoId) return;
            const anno = annotationsMap.get(annoId);

            if (!anno || !anno.note) {
                return;
            }

            const noteCard = this.#createNoteCard(anno);
            document.body.appendChild(noteCard);

            this.#noteCardsData.push({
                element: noteCard,
                highlightId: anno.id,
                highlightElement,
                text: anno.text,
                note: anno.note,
            });
        });

        // 布局Note
        this.#layout();

        // Restore the active styling if the previously selected card still exists
        if (this.#activeAnnotationId) {
            const stillExists = this.#noteCardsData.some(
                n => n.highlightId === this.#activeAnnotationId,
            );
            if (stillExists) {
                this.#applyActiveClasses(this.#activeAnnotationId);
                this.#drawConnector();
            } else {
                this.#activeAnnotationId = null;
                this.#hideConnector();
            }
        }

        Logger.log('NoteManager', `Rendered ${this.#noteCardsData.length} note cards`);
    }

    clear(): void {
        document.querySelectorAll('.note-card-margin').forEach(el => el.remove());
        this.#noteCardsData = [];
    }

    getNoteCardsData(): NoteCard[] {
        return [...this.#noteCardsData];
    }

    setupResponsiveLayout(): void {
        const onResize = debounce(() => {
            this.#layout();
            this.#drawConnector();
            // Close弹出Window（窄屏Mode）
            if (PlatformUtils.isNarrowScreen()) {
                document.querySelector('.note-popup')?.remove();
            }
        }, CONFIG.ANIMATION.RESIZE_DEBOUNCE);
        window.addEventListener('resize', onResize);

        // Re-layout on async content changes (mermaid render, font load, images,
        // collapse/expand, etc.) — without this, notes anchor to the page's
        // initial pre-async layout and visibly drift away from their source.
        if (typeof ResizeObserver !== 'undefined') {
            this.#resizeObserver = new ResizeObserver(onResize);
            this.#resizeObserver.observe(this.#markdownBody);
        }

        if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
            document.fonts.ready.then(() => {
                this.#layout();
                this.#drawConnector();
            }).catch(() => { /* font load failures are non-fatal */ });
        }

        // Connector follows the active card while the user scrolls. Cards are
        // absolutely positioned in document coords, so only the SVG dimensions
        // need refreshing — the path itself stays valid.
        this.#scrollHandler = (): void => {
            if (this.#activeAnnotationId) this.#drawConnector();
        };
        window.addEventListener('scroll', this.#scrollHandler, { passive: true });

        Logger.log('NoteManager', 'Responsive layout setup complete');
    }

    #filterOutermost(elements: NodeListOf<HTMLElement>): HTMLElement[] {
        const outermostMap = new Map<string, HTMLElement>();

        elements.forEach(element => {
            const annoId = element.dataset.annotationId;
            if (!annoId) return;

            // Check是否嵌套在另一个 .has-note 中
            let isNested = false;
            let parent: HTMLElement | null = element.parentElement;

            while (parent && parent !== this.#markdownBody) {
                if (parent.classList && parent.classList.contains('has-note')) {
                    isNested = true;
                    break;
                }
                parent = parent.parentElement;
            }

            // 只保留未嵌套的或首次遇到的
            if (!outermostMap.has(annoId)) {
                outermostMap.set(annoId, element);
            } else if (!isNested) {
                outermostMap.set(annoId, element);
            }
        });

        return Array.from(outermostMap.values());
    }

    #createNoteCard(annotation: Annotation): HTMLDivElement {
        const noteCard = document.createElement('div');
        noteCard.className = 'note-card-margin';
        noteCard.dataset.annotationId = annotation.id;

        noteCard.innerHTML = `
            <div class="note-actions">
                <button class="note-edit" data-annotation-id="${annotation.id}" title="${_t('web.note.edit')}">✎</button>
                <button class="note-delete" data-annotation-id="${annotation.id}" title="${_t('web.note.delete')}">×</button>
            </div>
            <div class="note-content">${Text.escape(annotation.note ?? '')}</div>
        `;

        noteCard.style.position = 'absolute';

        return noteCard;
    }

    #layout(): void {
        if (this.#noteCardsData.length === 0) {
            return;
        }

        if (PlatformUtils.isWideScreen()) {
            // 宽屏：使用物理布局
            this.#layoutWideScreen();
        } else {
            // 窄屏：Hide所有Note卡片（点击ShowModal）
            this.#layoutNarrowScreen();
        }
    }

    #layoutWideScreen(): void {
        // 强制重排以确保 offsetHeight Calculate准确
        void document.body.offsetHeight;

        // 使用物理引擎Calculate位置
        const notes = this.#layoutEngine.calculate(this.#noteCardsData);

        // Calculate水平位置（右对齐）
        const rightEdge =
            window.innerWidth -
            CONFIG.DIMENSIONS.NOTE_CARD_WIDTH -
            CONFIG.DIMENSIONS.NOTE_CARD_RIGHT_MARGIN;

        // Apply位置
        notes.forEach(note => {
            note.element.style.left = `${rightEdge}px`;
            note.element.style.top = `${note.currentTop}px`;
            note.element.style.display = 'block';
        });

        Logger.log('NoteManager', `Wide screen layout applied to ${notes.length} notes`);
    }

    #layoutNarrowScreen(): void {
        this.#noteCardsData.forEach(noteData => {
            noteData.element.style.display = 'none';
        });

        Logger.log('NoteManager', 'Narrow screen layout applied (cards hidden)');
    }

    /**
     * Toggle which annotation is the user's currently selected one. Only one
     * card / source pair carries `.highlight-active` at a time, and the
     * connector is redrawn (or hidden) accordingly.
     */
    setActive(annotationId: string): void {
        // Clicking the same annotation again toggles the selection off.
        if (this.#activeAnnotationId === annotationId) {
            this.clearActive();
            return;
        }

        this.#clearActiveClasses();
        this.#activeAnnotationId = annotationId;
        this.#applyActiveClasses(annotationId);
        this.#drawConnector();
    }

    clearActive(): void {
        this.#clearActiveClasses();
        this.#activeAnnotationId = null;
        this.#hideConnector();
    }

    getActiveAnnotationId(): string | null {
        return this.#activeAnnotationId;
    }

    #clearActiveClasses(): void {
        document
            .querySelectorAll('.has-note.highlight-active, .note-card-margin.highlight-active')
            .forEach(el => el.classList.remove('highlight-active'));
    }

    #applyActiveClasses(annotationId: string): void {
        const card = document.querySelector<HTMLElement>(
            `.note-card-margin[data-annotation-id="${annotationId}"]`,
        );
        card?.classList.add('highlight-active');

        // Apply to every fragment of the highlight (a span may be split
        // across blocks), not just the outermost one.
        this.#markdownBody
            .querySelectorAll<HTMLElement>(
                `.has-note[data-annotation-id="${annotationId}"]`,
            )
            .forEach(el => el.classList.add('highlight-active'));
    }

    #ensureConnectorSvg(): SVGSVGElement {
        if (this.#connectorSvg && document.body.contains(this.#connectorSvg)) {
            return this.#connectorSvg;
        }
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.classList.add('note-connector-svg');
        svg.setAttribute('aria-hidden', 'true');
        svg.style.position = 'absolute';
        svg.style.left = '0';
        svg.style.top = '0';
        svg.style.pointerEvents = 'none';
        svg.style.overflow = 'visible';

        const path = document.createElementNS(SVG_NS, 'path');
        path.classList.add('note-connector-path');
        path.setAttribute('fill', 'none');
        svg.appendChild(path);

        document.body.appendChild(svg);
        this.#connectorSvg = svg;
        this.#connectorPath = path;
        return svg;
    }

    #drawConnector(): void {
        const annotationId = this.#activeAnnotationId;
        if (!annotationId || !PlatformUtils.isWideScreen()) {
            this.#hideConnector();
            return;
        }

        const noteData = this.#noteCardsData.find(n => n.highlightId === annotationId);
        if (!noteData) {
            this.#hideConnector();
            return;
        }

        const cardRect = noteData.element.getBoundingClientRect();
        if (cardRect.width === 0 && cardRect.height === 0) {
            this.#hideConnector();
            return;
        }

        // Use the LAST client rect — for a multi-line highlight that's the
        // visual line tail the user would expect the connector to spring from.
        const sourceFragments = this.#markdownBody.querySelectorAll<HTMLElement>(
            `.has-note[data-annotation-id="${annotationId}"]`,
        );
        let sourceRect: DOMRect | null = null;
        sourceFragments.forEach(frag => {
            const rects = frag.getClientRects();
            if (rects.length === 0) return;
            const last = rects[rects.length - 1];
            if (!sourceRect || last.bottom > sourceRect.bottom) {
                sourceRect = last;
            }
        });
        if (!sourceRect) {
            this.#hideConnector();
            return;
        }
        // TS narrows to never inside forEach; restate to the actual type.
        const src: DOMRect = sourceRect;

        const scrollX = window.scrollX || window.pageXOffset;
        const scrollY = window.scrollY || window.pageYOffset;

        const x1 = src.right + scrollX;
        const y1 = src.top + src.height / 2 + scrollY;
        const x2 = cardRect.left + scrollX;
        const y2 = cardRect.top + cardRect.height / 2 + scrollY;

        // Cubic Bezier with horizontal control handles — gives the connector
        // a calm S-curve regardless of vertical offset between source & card.
        const dx = Math.max(40, (x2 - x1) * 0.5);
        const c1x = x1 + dx;
        const c1y = y1;
        const c2x = x2 - dx;
        const c2y = y2;

        const svg = this.#ensureConnectorSvg();
        const docWidth = Math.max(
            document.documentElement.scrollWidth,
            document.body.scrollWidth,
        );
        const docHeight = Math.max(
            document.documentElement.scrollHeight,
            document.body.scrollHeight,
        );
        svg.setAttribute('width', String(docWidth));
        svg.setAttribute('height', String(docHeight));
        svg.setAttribute('viewBox', `0 0 ${docWidth} ${docHeight}`);

        if (this.#connectorPath) {
            this.#connectorPath.setAttribute(
                'd',
                `M ${x1} ${y1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}`,
            );
            this.#connectorPath.classList.add('is-visible');
        }
    }

    #hideConnector(): void {
        this.#connectorPath?.classList.remove('is-visible');
    }

    showNotePopup(highlightElement: HTMLElement, annotationId: string): void {
        // 移除已存在的Modal
        const existingPopup = document.querySelector('.note-popup');
        if (existingPopup) existingPopup.remove();

        // FindNoteData
        const noteData = this.#noteCardsData.find(n => n.highlightId === annotationId);
        if (!noteData) return;

        // CreateModal
        const popup = document.createElement('div');
        popup.className = 'note-popup';
        popup.dataset.annotationId = annotationId;
        popup.innerHTML = `
            <div class="note-actions">
                <button class="note-edit" data-annotation-id="${annotationId}" title="${_t('web.note.edit')}">✎</button>
                <button class="note-delete" data-annotation-id="${annotationId}" title="${_t('web.note.delete')}">×</button>
            </div>
            <div class="note-content">${Text.escape(noteData.note)}</div>
        `;

        // 定位
        const rect = highlightElement.getBoundingClientRect();
        popup.style.position = 'absolute';
        popup.style.left = `${rect.left + window.scrollX}px`;
        popup.style.top = `${rect.bottom + window.scrollY + 10}px`;

        document.body.appendChild(popup);

        // 添加点击外部关闭功能
        const closeHandler = (e: MouseEvent): void => {
            const target = e.target as Node | null;
            if (!popup.contains(target) && !noteData.highlightElement.contains(target)) {
                popup.remove();
                document.removeEventListener('click', closeHandler);
                Logger.log('NoteManager', 'Note popup closed by clicking outside');
            }
        };
        // 延迟添加事件监听器，避免立即触发
        setTimeout(() => {
            document.addEventListener('click', closeHandler);
        }, 0);

        // 调整位置以保持在视口内
        const popupRect = popup.getBoundingClientRect();
        if (popupRect.right > window.innerWidth) {
            popup.style.left = `${rect.left + window.scrollX - (popupRect.right - window.innerWidth) - 10}px`;
        }
        if (popupRect.bottom > window.innerHeight) {
            popup.style.top = `${rect.top + window.scrollY - popupRect.height - 10}px`;
        }

        Logger.log('NoteManager', `Showed note popup for annotation: ${annotationId}`);
    }
}
