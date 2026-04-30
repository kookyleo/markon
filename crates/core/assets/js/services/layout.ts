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
    idealTop: number;
    currentTop: number;
    height: number;
    index: number;
    id: string;
}

export class LayoutEngine {
    calculate(noteCardsData: readonly NoteCardInput[]): LaidOutNote[] {
        if (noteCardsData.length === 0) return [];

        const notes = this.#prepare(noteCardsData);
        const clusters = this.#cluster(notes);
        this.#stack(notes, clusters);
        this.#enforceSpacing(notes);
        return notes;
    }

    #prepare(noteCardsData: readonly NoteCardInput[]): LaidOutNote[] {
        const scrollY = window.scrollY || window.pageYOffset;
        return noteCardsData.map((noteData, index) => {
            const highlightRect = noteData.highlightElement.getBoundingClientRect();
            const idealTop = highlightRect.top + scrollY;
            const height = noteData.element.offsetHeight || 80;
            return {
                element: noteData.element,
                idealTop,
                currentTop: idealTop,
                height,
                index,
                id: noteData.highlightId
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
            if (Math.abs(next.idealTop - curr.idealTop) <= CONFIG.THRESHOLDS.NOTE_CLUSTER) {
                uf.union(curr.idx, next.idx);
            }
        }

        const clusters = new Map<number, number[]>();
        notes.forEach((_note, idx) => {
            const root = uf.find(idx);
            if (!clusters.has(root)) clusters.set(root, []);
            clusters.get(root)!.push(idx);
        });
        return clusters;
    }

    #stack(notes: LaidOutNote[], clusters: Map<number, number[]>): void {
        clusters.forEach((indices) => {
            if (indices.length > 1) {
                const minIdealTop = Math.min(...indices.map(idx => notes[idx].idealTop));
                let currentTop = minIdealTop;
                indices.sort((a, b) => a - b);
                indices.forEach(noteIndex => {
                    notes[noteIndex].currentTop = currentTop;
                    currentTop += notes[noteIndex].height + CONFIG.THRESHOLDS.NOTE_MIN_SPACING;
                });
            }
        });
    }

    #enforceSpacing(notes: LaidOutNote[]): void {
        const threshold = CONFIG.THRESHOLDS.NOTE_CLUSTER;
        for (let i = 1; i < notes.length; i++) {
            const prev = notes[i - 1];
            const curr = notes[i];
            const minAllowedTop = prev.currentTop + prev.height + CONFIG.THRESHOLDS.NOTE_MIN_SPACING;
            if (curr.currentTop < minAllowedTop) {
                curr.currentTop = minAllowedTop;
            }
        }
    }
}
