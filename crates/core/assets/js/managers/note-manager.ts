/**
 * NoteManager - Note card manager
 * Handles note rendering, layout, and responsive handling
 */

import { CONFIG, i18n } from '../core/config';
import { PlatformUtils, Logger } from '../core/utils';
import { LayoutEngine } from '../services/layout';
import { Text } from '../services/text';
import type { AnnotationManager, Annotation } from './annotation-manager';

const _t = (key: string, ...args: unknown[]): string => i18n.t(key, ...args);

const SVG_NS = 'http://www.w3.org/2000/svg';

/* Flat line icons for the note-card actions — stroked, no fill, sized by the
   button's font-size via `width/height: 1em`. The delete glyph is a trash can,
   deliberately distinct from a close "×". */
const ICON_ATTRS =
    'viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const ICON_COPY =
    `<svg ${ICON_ATTRS}><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/>` +
    `<path d="M3.5 10.5H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h6.5a1 1 0 0 1 1 1v.5"/></svg>`;
const ICON_LINK_ATTRS =
    'viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const ICON_LINK =
    `<svg ${ICON_LINK_ATTRS}><path d="M6.4 9.6l3.2-3.2"/>` +
    `<path d="M9 4.2l.7-.7a2.45 2.45 0 1 1 3.5 3.5l-1.55 1.55a2.45 2.45 0 0 1-3.4.08"/>` +
    `<path d="M7 11.8l-.7.7a2.45 2.45 0 1 1-3.5-3.5l1.55-1.55a2.45 2.45 0 0 1 3.4-.08"/></svg>`;
const ICON_EDIT =
    `<svg ${ICON_ATTRS}><path d="M2.5 13.5l1-3.2 7.3-7.3a1.3 1.3 0 0 1 1.8 1.8l-7.3 7.3z"/>` +
    `<path d="M9.5 4.5l2 2"/></svg>`;
const ICON_DELETE =
    `<svg ${ICON_ATTRS}><path d="M3 4.5h10"/>` +
    `<path d="M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5"/>` +
    `<path d="M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8"/>` +
    `<path d="M6.8 7v4M9.2 7v4"/></svg>`;

function splitTrailingUrlPunctuation(url: string): { core: string; tail: string } {
    let core = url;
    let tail = '';
    while (/[.,;:!?)]$/.test(core)) {
        tail = core.slice(-1) + tail;
        core = core.slice(0, -1);
    }
    return { core, tail };
}

function renderNoteContent(note: string): string {
    const pattern = /\bhttps?:\/\/[^\s<>"'`]+/gi;
    const parts: string[] = [];
    let lastIndex = 0;
    for (const match of note.matchAll(pattern)) {
        const raw = match[0] ?? '';
        const index = match.index ?? 0;
        const { core, tail } = splitTrailingUrlPunctuation(raw);
        if (!core) continue;
        try {
            const parsed = new URL(core);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
        } catch {
            continue;
        }
        parts.push(Text.escape(note.slice(lastIndex, index)));
        const safeUrl = Text.escape(core);
        parts.push(`<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>`);
        parts.push(Text.escape(tail));
        lastIndex = index + raw.length;
    }
    parts.push(Text.escape(note.slice(lastIndex)));
    return parts.join('');
}

/**
 * Internal in-memory record kept per rendered note card. Exposed via
 * `getNoteCardsData()` (currently only consumed by unit tests).
 */
export interface NoteCard {
    /** The floating `.note-card-margin` element appended to `<body>`. */
    element: HTMLDivElement;
    /** ID of the underlying annotation. */
    highlightId: string;
    /** The in-document highlight element this card anchors to. */
    highlightElement: Element;
    /** Mirrored from the annotation's `note` field (always non-empty here). */
    note: string;
}

/** NoteManager construction options. */
export interface NoteManagerOptions {
    /** Render margin note cards in the right gutter with the physics layout +
     *  connector (the normal single-document view). When `false`, notes are
     *  popup-only: `render()` still tracks note data so a click opens the note
     *  popup, but no gutter cards are appended or laid out. Used by the rendered
     *  compare diff, whose multi-column layout reserves no gutter and whose inner
     *  scroll container breaks body-absolute card positioning. Defaults to `true`. */
    marginCards?: boolean;
}

export interface NoteActiveChangeEvent {
    annotationId: string | null;
    previousAnnotationId: string | null;
    sourceElement: Element | null;
}

export class NoteManager {
    #annotationManager: AnnotationManager;
    #markdownBody: HTMLElement;
    #noteCardsData: NoteCard[] = [];
    #layoutEngine: LayoutEngine;
    #activeAnnotationId: string | null = null;
    #connectorSvg: SVGSVGElement | null = null;
    #connectorPath: SVGPathElement | null = null;
    #viewportLayoutFrame: number | null = null;
    #responsiveLayoutSetup = false;
    #marginCards: boolean;
    #activeChangeHandler: ((event: NoteActiveChangeEvent) => void) | null = null;

    constructor(annotationManager: AnnotationManager, markdownBody: HTMLElement, options: NoteManagerOptions = {}) {
        this.#annotationManager = annotationManager;
        this.#markdownBody = markdownBody;
        this.#layoutEngine = new LayoutEngine();
        this.#marginCards = options.marginCards ?? true;
    }

    /** Rebind the body notes are tracked against (the diff rebuilds it on view
     *  switch / virtualization). */
    setMarkdownBody(body: HTMLElement): void {
        this.#markdownBody = body;
    }

    render(): void {
        // Remove any existing margin notes.
        this.clear();

        // Gather every annotated highlight element (outermost only).
        const allHighlightElements = this.#markdownBody.querySelectorAll<HTMLElement>(
            '.has-note[data-annotation-id]',
        );
        const outermostElements = this.#filterOutermost(allHighlightElements);

        if (outermostElements.length === 0) {
            return;
        }

        // Fetch annotation data.
        const annotations = this.#annotationManager.getAll();
        const annotationsMap = new Map<string, Annotation>(annotations.map(a => [a.id, a]));

        // Build note cards.
        outermostElements.forEach(highlightElement => {
            const annoId = highlightElement.dataset['annotationId'];
            if (!annoId) return;
            const anno = annotationsMap.get(annoId);

            if (!anno?.note) {
                return;
            }

            const noteCard = this.#createNoteCard(anno);
            // Popup-only mode (diff): keep the card element for the data record so
            // showNotePopup can look notes up, but never mount it in the gutter.
            if (this.#marginCards) document.body.appendChild(noteCard);

            this.#noteCardsData.push({
                element: noteCard,
                highlightId: anno.id,
                highlightElement,
                note: anno.note,
            });
        });

        // Popup-only mode renders nothing in the gutter — no layout, connector,
        // or active-card restoration (a click opens showNotePopup instead).
        if (!this.#marginCards) {
            Logger.log('NoteManager', `Tracked ${this.#noteCardsData.length} notes (popup-only)`);
            return;
        }

        // Lay out the notes.
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

    onActiveChange(handler: ((event: NoteActiveChangeEvent) => void) | null): void {
        this.#activeChangeHandler = handler;
    }

    setupResponsiveLayout(): void {
        if (this.#responsiveLayoutSetup) {
            this.#scheduleStableLayout();
            return;
        }
        this.#responsiveLayoutSetup = true;

        const onViewportChange = (): void => this.#scheduleViewportLayout();
        window.addEventListener('scroll', onViewportChange, { passive: true });
        window.addEventListener('resize', () => {
            this.#scheduleViewportLayout();
            if (PlatformUtils.isNarrowScreen()) {
                document.querySelector('.note-popup')?.remove();
            }
        });
        document.addEventListener('markon:viewed-ready', () => this.#scheduleViewportLayout(), { once: true });
        this.#scheduleStableLayout();

        Logger.log('NoteManager', 'Responsive layout setup complete');
    }

    #scheduleViewportLayout(): void {
        if (this.#viewportLayoutFrame !== null) return;
        this.#viewportLayoutFrame = window.requestAnimationFrame(() => {
            this.#viewportLayoutFrame = null;
            this.#layout();
            this.#drawConnector();
        });
    }

    #scheduleStableLayout(): void {
        this.#scheduleViewportLayout();
        window.requestAnimationFrame(() => this.#scheduleViewportLayout());
        void window.viewedManager?.ready.then(() => {
            this.#scheduleViewportLayout();
        }).catch(() => { /* viewed state failures are handled by main.ts */ });
        if (typeof document !== 'undefined' && document.fonts) {
            void document.fonts.ready.then(() => {
                this.#scheduleViewportLayout();
            }).catch(() => { /* font load failures are non-fatal */ });
        }
    }

    /** Author attribution footer for a note card (shared workspaces only):
     *  colour dot + nickname + compact time. Colour validated to a hex literal
     *  so a peer's value can't inject CSS; nickname HTML-escaped. */
    #noteAuthorLine(anno: Annotation): string {
        if (!document.body.classList.contains('markon-shared') || !anno.author) return '';
        const raw = (anno.author.color || '').trim();
        const color = /^#[0-9a-f]{3,8}$/i.test(raw) ? raw : 'var(--markon-fg-muted)';
        const name = anno.author.name || _t('web.author.anon');
        const d = new Date(anno.createdAt);
        const p = (n: number): string => String(n).padStart(2, '0');
        const time = `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
        return (
            '<div class="note-author">' +
            `<span class="note-author-dot" style="background:${color}"></span>` +
            `<span class="note-author-name">${Text.escape(name)}</span>` +
            `<span class="note-author-time">${time}</span>` +
            '</div>'
        );
    }

    #filterOutermost(elements: NodeListOf<HTMLElement>): HTMLElement[] {
        const outermostMap = new Map<string, HTMLElement>();

        elements.forEach(element => {
            const annoId = element.dataset['annotationId'];
            if (!annoId) return;

            // Detect whether this highlight is nested inside another .has-note element.
            let isNested = false;
            let parent: HTMLElement | null = element.parentElement;

            while (parent && parent !== this.#markdownBody) {
                if (parent.classList && parent.classList.contains('has-note')) {
                    isNested = true;
                    break;
                }
                parent = parent.parentElement;
            }

            // Keep the un-nested fragment (or the first one we encountered).
            if (!outermostMap.has(annoId)) {
                outermostMap.set(annoId, element);
            } else if (!isNested) {
                outermostMap.set(annoId, element);
            }
        });

        return Array.from(outermostMap.values());
    }

    /** Copy/edit/delete action-button block shared by the margin cards and
     *  the narrow-screen popup. */
    #noteActionsHtml(annotationId: string): string {
        const editLabel = _t('web.note.edit');
        const deleteLabel = _t('web.note.delete');
        const copyLabel = _t('web.export.copyitem');
        const linkLabel = _t('web.note.copylink');
        return `
            <div class="note-actions">
                <button class="note-copy" data-annotation-id="${annotationId}" title="${copyLabel}" aria-label="${copyLabel}">${ICON_COPY}</button>
                <button class="note-link" data-annotation-id="${annotationId}" title="${linkLabel}" aria-label="${linkLabel}">${ICON_LINK}</button>
                <button class="note-edit" data-annotation-id="${annotationId}" title="${editLabel}" aria-label="${editLabel}">${ICON_EDIT}</button>
                <button class="note-delete" data-annotation-id="${annotationId}" title="${deleteLabel}" aria-label="${deleteLabel}">${ICON_DELETE}</button>
            </div>
        `;
    }

    #createNoteCard(annotation: Annotation): HTMLDivElement {
        const noteCard = document.createElement('div');
        noteCard.className = 'note-card-margin';
        noteCard.dataset['annotationId'] = annotation.id;

        noteCard.innerHTML = `
            ${this.#noteActionsHtml(annotation.id)}
            <div class="note-content">${renderNoteContent(annotation.note ?? '')}</div>
            ${this.#noteAuthorLine(annotation)}
        `;

        noteCard.style.position = 'absolute';

        return noteCard;
    }

    #layout(): void {
        if (this.#noteCardsData.length === 0) {
            return;
        }

        if (PlatformUtils.isWideScreen()) {
            // Wide-screen layout uses the physics-based placement.
            this.#layoutWideScreen();
        } else {
            // Narrow-screen layout hides all cards (a click opens a popup instead).
            this.#layoutNarrowScreen();
        }
    }

    #layoutWideScreen(): void {
        // Force a reflow so offsetHeight is reliable.
        void document.body.offsetHeight;

        // Compute positions through the physics engine.
        const notes = this.#layoutEngine.calculate(this.#noteCardsData);

        // Compute the horizontal position (right-aligned). Card width and the
        // edge gap come from the same CSS custom properties that drive the
        // content's right reserve (layout.html :root), so the cards land
        // exactly inside the gutter reserved for them — no parallel constants
        // to keep in sync. CONFIG.DIMENSIONS only acts as a fallback when the
        // vars are absent (e.g. jsdom in unit tests).
        const root = getComputedStyle(document.documentElement);
        const noteWidth =
            parseFloat(root.getPropertyValue('--markon-note-width')) ||
            CONFIG.DIMENSIONS.NOTE_CARD_WIDTH;
        const edgeGap =
            parseFloat(root.getPropertyValue('--markon-rail-edge-gap')) ||
            CONFIG.DIMENSIONS.NOTE_CARD_RIGHT_MARGIN;
        // Use the layout viewport width (scrollbar excluded) so the cards share
        // the same coordinate system as the body's CSS margins; window.innerWidth
        // would include the scrollbar and push the cards ~15px further right than
        // the reserved gutter, breaking symmetry with the left rail.
        const viewportWidth =
            document.documentElement.clientWidth || window.innerWidth;
        const rightEdge = viewportWidth - noteWidth - edgeGap;

        // Apply the computed positions.
        notes.forEach(note => {
            if (!note.visible) {
                note.element.style.display = 'none';
                return;
            }
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

        const previousAnnotationId = this.#activeAnnotationId;
        const sourceElement = this.#sourceElementFor(annotationId);
        this.#clearActiveClasses();
        this.#activeAnnotationId = annotationId;
        this.#emitActiveChange(annotationId, previousAnnotationId, sourceElement);
        this.#applyActiveClasses(annotationId);
        this.#drawConnector();
    }

    clearActive(): void {
        const previousAnnotationId = this.#activeAnnotationId;
        this.#clearActiveClasses();
        this.#activeAnnotationId = null;
        if (previousAnnotationId) {
            this.#emitActiveChange(null, previousAnnotationId, null);
        }
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

    #sourceElementFor(annotationId: string): Element | null {
        return this.#noteCardsData.find(n => n.highlightId === annotationId)?.highlightElement ?? null;
    }

    #emitActiveChange(
        annotationId: string | null,
        previousAnnotationId: string | null,
        sourceElement: Element | null,
    ): void {
        this.#activeChangeHandler?.({
            annotationId,
            previousAnnotationId,
            sourceElement,
        });
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

        const sourceRect = this.#sourceRectForConnector(annotationId, noteData);
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

    #sourceRectForConnector(annotationId: string, noteData: NoteCard): DOMRect | null {
        const anchorElement = this.#layoutEngine.anchorElementFor(noteData);
        if (anchorElement !== noteData.highlightElement) {
            return anchorElement.getBoundingClientRect();
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
            if (!last) return;
            if (!sourceRect || last.bottom > sourceRect.bottom) {
                sourceRect = last;
            }
        });
        return sourceRect;
    }

    #hideConnector(): void {
        this.#connectorPath?.classList.remove('is-visible');
    }

    showNotePopup(highlightElement: HTMLElement, annotationId: string): void {
        // Remove any existing popup.
        const existingPopup = document.querySelector('.note-popup');
        if (existingPopup) existingPopup.remove();

        // Look up the note data.
        const noteData = this.#noteCardsData.find(n => n.highlightId === annotationId);
        if (!noteData) return;

        // Build the popup DOM.
        const popup = document.createElement('div');
        popup.className = 'note-popup markon-modal-frame';
        popup.dataset['annotationId'] = annotationId;
        popup.innerHTML = `
            ${this.#noteActionsHtml(annotationId)}
            <div class="note-content">${renderNoteContent(noteData.note)}</div>
        `;

        // Position the popup below the highlight.
        const rect = highlightElement.getBoundingClientRect();
        popup.style.position = 'absolute';
        popup.style.left = `${rect.left + window.scrollX}px`;
        popup.style.top = `${rect.bottom + window.scrollY + 10}px`;

        document.body.appendChild(popup);

        // Close the popup when the user clicks outside of it.
        const closeHandler = (e: MouseEvent): void => {
            const target = e.target as Node | null;
            if (!popup.contains(target) && !noteData.highlightElement.contains(target)) {
                popup.remove();
                document.removeEventListener('click', closeHandler);
                Logger.log('NoteManager', 'Note popup closed by clicking outside');
            }
        };
        // Defer attaching the listener so the opening click does not immediately close it.
        setTimeout(() => {
            document.addEventListener('click', closeHandler);
        }, 0);

        // Adjust the position so the popup stays inside the viewport.
        // An absolutely-positioned element with `left: X` and `width: auto`
        // is shrink-to-fit against its containing block's right edge — on a
        // narrow viewport that compresses the popup (the user perceives this
        // as "deformation"), and the `right > innerWidth` test below would
        // never fire because the browser already capped it. Detect both
        // genuine overflow and the shrink-to-fit case by checking if the
        // popup reaches the viewport edge, then re-anchor by `right` so the
        // popup recovers its natural width with a small inset.
        const edgeMargin = 10;
        let popupRect = popup.getBoundingClientRect();
        if (popupRect.right >= window.innerWidth) {
            popup.style.left = 'auto';
            popup.style.right = `${edgeMargin}px`;
            popupRect = popup.getBoundingClientRect();
        }
        if (popupRect.bottom > window.innerHeight) {
            popup.style.top = `${rect.top + window.scrollY - popupRect.height - edgeMargin}px`;
        }

        Logger.log('NoteManager', `Showed note popup for annotation: ${annotationId}`);
    }
}
