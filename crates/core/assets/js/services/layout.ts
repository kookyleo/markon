/**
 * Physical layout engine - pure technical, no business logic
 */
import { CONFIG } from '../core/config.js';
import { UnionFind } from './union-find.js';

/** Input shape: each card describes the note element + the in-text highlight it anchors to. */
export interface NoteCardInput {
    element: HTMLElement;
    highlightElement: Element;
    highlightId: string;
}

/** Output shape: positioned card with computed `currentTop`. */
export interface LaidOutNote {
    element: HTMLElement;
    anchorElement: Element;
    idealTop: number;
    currentTop: number;
    height: number;
    index: number;
    id: string;
    visible: boolean;
}

interface AnchorResolution {
    element: Element;
    resolved: boolean;
}

const HIDDEN_SECTION_CONTENT_SELECTOR = '.section-content-hidden';
const COLLAPSED_SECTION_HEADING_SELECTOR = [
    'h1.section-collapsed',
    'h2.section-collapsed',
    'h3.section-collapsed',
    'h4.section-collapsed',
    'h5.section-collapsed',
    'h6.section-collapsed',
].join(',');

export class LayoutEngine {
    calculate(noteCardsData: readonly NoteCardInput[]): LaidOutNote[] {
        if (noteCardsData.length === 0) return [];

        const notes = this.#prepare(noteCardsData);
        const visibleNotes = notes.filter(note => note.visible);
        const clusters = this.#cluster(visibleNotes);
        this.#stack(visibleNotes, clusters);
        this.#enforceSpacing(visibleNotes);
        return notes;
    }

    anchorElementFor(noteData: NoteCardInput): Element {
        return this.#resolveAnchor(noteData).element;
    }

    anchorRectFor(noteData: NoteCardInput): DOMRect {
        return this.anchorElementFor(noteData).getBoundingClientRect();
    }

    isAnchorInViewport(noteData: NoteCardInput): boolean {
        const anchor = this.#resolveAnchor(noteData);
        return anchor.resolved && this.#isRectInViewport(anchor.element.getBoundingClientRect());
    }

    #prepare(noteCardsData: readonly NoteCardInput[]): LaidOutNote[] {
        const scrollY = window.scrollY || window.pageYOffset;
        return noteCardsData.map((noteData, index) => {
            const anchor = this.#resolveAnchor(noteData);
            const anchorElement = anchor.element;
            const anchorRect = anchorElement.getBoundingClientRect();
            const idealTop = anchorRect.top + scrollY;
            const height = noteData.element.offsetHeight || 80;
            return {
                element: noteData.element,
                anchorElement,
                idealTop,
                currentTop: idealTop,
                height,
                index,
                id: noteData.highlightId,
                visible: anchor.resolved && this.#isRectInViewport(anchorRect),
            };
        });
    }

    #cluster(notes: LaidOutNote[]): Map<number, number[]> {
        const uf = new UnionFind(notes.length);
        const sorted = notes
            .map((note, idx) => ({ idx, idealTop: note.idealTop }))
            .sort((a, b) => a.idealTop - b.idealTop);

        for (let i = 0; i < sorted.length - 1; i++) {
            const curr = sorted[i];
            const next = sorted[i + 1];
            if (!curr || !next) continue;
            if (Math.abs(next.idealTop - curr.idealTop) <= CONFIG.THRESHOLDS.NOTE_CLUSTER) {
                uf.union(curr.idx, next.idx);
            }
        }

        const clusters = new Map<number, number[]>();
        notes.forEach((_note, idx) => {
            const root = uf.find(idx);
            let cluster = clusters.get(root);
            if (!cluster) {
                cluster = [];
                clusters.set(root, cluster);
            }
            cluster.push(idx);
        });
        return clusters;
    }

    #noteAt(notes: LaidOutNote[], index: number): LaidOutNote {
        const note = notes[index];
        if (!note) throw new RangeError(`Note index ${index} is outside layout input`);
        return note;
    }

    #stack(notes: LaidOutNote[], clusters: Map<number, number[]>): void {
        clusters.forEach((indices) => {
            if (indices.length > 1) {
                const minIdealTop = Math.min(...indices.map(idx => this.#noteAt(notes, idx).idealTop));
                let currentTop = minIdealTop;
                indices.sort((a, b) => a - b);
                indices.forEach(noteIndex => {
                    const note = this.#noteAt(notes, noteIndex);
                    note.currentTop = currentTop;
                    currentTop += note.height + CONFIG.THRESHOLDS.NOTE_MIN_SPACING;
                });
            }
        });
    }

    #enforceSpacing(notes: LaidOutNote[]): void {
        for (let i = 1; i < notes.length; i++) {
            const prev = notes[i - 1];
            const curr = notes[i];
            if (!prev || !curr) continue;
            const minAllowedTop = prev.currentTop + prev.height + CONFIG.THRESHOLDS.NOTE_MIN_SPACING;
            if (curr.currentTop < minAllowedTop) {
                curr.currentTop = minAllowedTop;
            }
        }
    }

    #isRectInViewport(rect: DOMRect): boolean {
        const viewportHeight =
            document.documentElement.clientHeight || window.innerHeight;
        return rect.bottom >= 0 && rect.top <= viewportHeight;
    }

    #resolveAnchor(noteData: NoteCardInput): AnchorResolution {
        if (!this.#isInsideHiddenSection(noteData.highlightElement)) {
            return { element: noteData.highlightElement, resolved: true };
        }

        const heading = this.#visibleCollapsedAncestorHeading(noteData.highlightElement);
        return {
            element: heading ?? noteData.highlightElement,
            resolved: heading !== null,
        };
    }

    #isInsideHiddenSection(element: Element): boolean {
        return element.closest(HIDDEN_SECTION_CONTENT_SELECTOR) !== null;
    }

    #visibleCollapsedAncestorHeading(source: Element): Element | null {
        const root = source.closest('.markdown-body') ?? document.body;
        const candidates = Array.from(root.querySelectorAll(COLLAPSED_SECTION_HEADING_SELECTOR))
            .filter(heading => !heading.closest(HIDDEN_SECTION_CONTENT_SELECTOR))
            .filter(heading => this.#sectionContains(heading, source));

        candidates.sort((a, b) => this.#headingLevel(b) - this.#headingLevel(a));
        return candidates[0] ?? null;
    }

    #sectionContains(heading: Element, source: Element): boolean {
        const headingLevel = this.#headingLevel(heading);
        let next = heading.nextElementSibling;
        while (next) {
            if (this.#headingLevel(next) <= headingLevel) return false;
            if (next === source || next.contains(source)) return true;
            next = next.nextElementSibling;
        }
        return false;
    }

    #headingLevel(element: Element): number {
        const match = /^H([1-6])$/i.exec(element.tagName);
        if (!match?.[1]) return Number.POSITIVE_INFINITY;
        return Number(match[1]);
    }
}
