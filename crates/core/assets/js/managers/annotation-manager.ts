/**
 * AnnotationManager - Core annotation manager
 * Handles CRUD operations and DOM application for annotations.
 *
 * Annotations are anchored to the rendered **text content** (see text-anchor):
 * the stored anchor re-finds its quote on every apply, so it survives DOM
 * re-renders and moderate edits instead of breaking when the DOM shifts.
 *
 * The `Annotation` interface declared here is the canonical schema consumed
 * downstream by storage-manager, popover-manager, and the collaboration layer.
 */

import { Ids, Logger } from '../core/utils';
import { Identity, type Author } from '../core/identity';
import { TextAnchoring, type TextAnchor, type RejectFn } from '../services/text-anchor';
import {
    ANNOTATION_CHROME_REJECT,
    annotationBlockFor,
    combineRejects,
} from '../services/annotation-target';

/**
 * Annotation type union, matching the values produced by `main.js`:
 *  - `highlight-orange | highlight-green | highlight-yellow` — standard highlights
 *  - `strikethrough` — strikethrough mark
 *  - `has-note` — highlight with an attached note (still a span tag)
 *
 * These literals match `CONFIG.ANNOTATION_TYPES`.
 */
export type AnnotationType =
    | 'highlight-orange'
    | 'highlight-green'
    | 'highlight-yellow'
    | 'strikethrough'
    | 'has-note';

/**
 * Tag names used to wrap annotation ranges:
 *  - `span` for highlights / notes
 *  - `s`    for strikethrough
 *
 * Matches `CONFIG.HTML_TAGS`.
 */
export type AnnotationTagName = 'span' | 's';

/** A heading reference resolved for an annotation. */
export interface AnnotationHeading {
    level: number;
    text: string;
}

/** One section group: a heading (or null for pre-heading content) and its annotations. */
export interface AnnotationGroup {
    heading: AnnotationHeading | null;
    items: Annotation[];
}

interface ExportTextSegment {
    node: Text;
    start: number;
}

interface ExportSelectionInterval {
    start: number;
    end: number;
}

const EXPORT_SENTENCE_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'sentence' });

/**
 * Canonical Annotation schema. Persisted by storage-manager,
 * round-tripped through WebSocket, and consumed by note-manager,
 * popover-manager, and collaboration-manager.
 */
export interface Annotation {
    /** Stable ID, prefixed `anno-`. */
    id: string;
    /** Visual / semantic type — see `AnnotationType`. */
    type: AnnotationType;
    /** HTML tag used to wrap the range. */
    tagName: AnnotationTagName;
    /** Content anchor — re-finds the quoted text in the rendered body. Version
     *  2 carries ordered structural fragments while retaining the original flat
     *  selector for backward compatibility. */
    anchor: TextAnchor;
    /** Original selected text for display/export. Cross-block selections insert
     *  line breaks between structural fragments. */
    text: string;
    /** Optional attached note body. `null` when absent. */
    note: string | null;
    /** Creation timestamp (ms since epoch). */
    createdAt: number;
    /** Author stamp (colour + optional nickname), snapshotted at creation.
     *  Absent on annotations created before authorship existed → render
     *  anonymously (neutral). */
    author?: Author;
}

/** Storage strategy contract used by AnnotationManager.
 *
 * Mutating methods return the op_id used for the outgoing WebSocket frame
 * (when one was sent) — useful so callers can stash it on an undo entry for
 * correlation. Local-mode strategies return `null`.
 */
export interface AnnotationStorage {
    loadAnnotations(): Promise<Annotation[]>;
    saveAnnotation(annotation: Annotation): Promise<string | null>;
    deleteAnnotation(id: string): Promise<string | null>;
    clearAnnotations(): Promise<string | null>;
}

/** Action emitted via the `onChange` callback. */
export type AnnotationChangeAction = 'add' | 'delete' | 'clear' | 'replace';

/** Payload sent to the `onChange` callback. */
export interface AnnotationChangeEvent {
    action: AnnotationChangeAction;
    /** For `add`/`delete`: the affected annotation. For `clear`: the prior list. */
    data: Annotation | Annotation[];
    /** Snapshot of all annotations after the change. */
    annotations: Annotation[];
}

export type AnnotationChangeCallback = (event: AnnotationChangeEvent) => void;

export class AnnotationManager {
    #annotations: Annotation[] = [];
    #storage: AnnotationStorage;
    #markdownBody: HTMLElement;
    #onChange: AnnotationChangeCallback | null = null;
    /** Optional surface boundary, such as the new side of a rendered diff. */
    #surfaceReject: RejectFn | undefined;
    /** New anchors additionally omit Markon-injected controls from their text
     *  stream. Legacy anchors keep their original stream for compatibility. */
    #contentReject: RejectFn;

    /**
     * @param storage      annotation persistence strategy
     * @param markdownBody the live root (rendered body) anchoring runs against;
     *                     rebind after a DOM rebuild via {@link setRoot}
     * @param reject       optional scoping predicate (e.g. `NEW_SIDE_REJECT`).
     *                     When supplied, re-anchoring also down-weights the
     *                     position tiebreak so quotes re-find across views.
     */
    constructor(storage: AnnotationStorage, markdownBody: HTMLElement, reject?: RejectFn) {
        this.#storage = storage;
        this.#markdownBody = markdownBody;
        this.#surfaceReject = reject;
        this.#contentReject = combineRejects(ANNOTATION_CHROME_REJECT, reject);
    }

    /** Rebind the root after a DOM rebuild (the diff view rebuilds the whole
     *  tree on every view switch, leaving the previous body detached). */
    setRoot(newRoot: HTMLElement): void {
        this.#markdownBody = newRoot;
    }

    async load(): Promise<void> {
        this.#annotations = await this.#storage.loadAnnotations();
        Logger.log('AnnotationManager', `Loaded ${this.#annotations.length} annotations`);
    }

    getAll(): Annotation[] {
        return [...this.#annotations];
    }

    getById(id: string): Annotation | null {
        return this.#annotations.find(a => a.id === id) ?? null;
    }

    /**
     * Replace the in-memory annotation snapshot without writing to storage.
     *
     * Shared mode uses this after reconciling the initial SQLite snapshot with
     * a broadcast snapshot. Persistence is handled explicitly by the caller.
     */
    replaceAll(annotations: Annotation[]): void {
        this.#annotations = [...annotations];
        this.#triggerChange('replace', annotations);
        Logger.log('AnnotationManager', `Replaced annotations in memory: ${annotations.length}`);
    }

    /**
     * Return annotations sorted by their current position in the document,
     * derived from the rendered `[data-annotation-id]` wrappers. An
     * annotation can be split across multiple wrappers (per-text-node split
     * in #wrapRange) — we use the first wrapper as the anchor for ordering.
     * Annotations with no wrapper (drift, not yet rendered) fall to the end.
     */
    getAllInDocumentOrder(): Annotation[] {
        const positions = new Map<string, number>();
        let i = 0;
        this.#markdownBody
            .querySelectorAll<HTMLElement>('[data-annotation-id]')
            .forEach((el) => {
                const id = el.dataset['annotationId'];
                if (id && !positions.has(id)) positions.set(id, i++);
            });
        return [...this.#annotations].sort((a, b) => {
            const ai = positions.get(a.id) ?? Number.POSITIVE_INFINITY;
            const bi = positions.get(b.id) ?? Number.POSITIVE_INFINITY;
            if (ai !== bi) return ai - bi;
            const ap = typeof a.anchor.position === 'number' ? a.anchor.position : Number.POSITIVE_INFINITY;
            const bp = typeof b.anchor.position === 'number' ? b.anchor.position : Number.POSITIVE_INFINITY;
            if (ap !== bp) return ap - bp;
            return a.createdAt - b.createdAt;
        });
    }

    /**
     * Return annotations rendered inside one heading section. The renderer
     * nests child `.heading-section` elements, so a parent heading includes
     * its subsections while same-level and higher-level siblings stay out.
     */
    getAllInSection(headingId: string): Annotation[] {
        const heading = Array.from(
            this.#markdownBody.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'),
        ).find(candidate => candidate.id === headingId);
        const section = heading?.closest<HTMLElement>('.heading-section');
        if (!section || !this.#markdownBody.contains(section)) return [];

        const ids = new Set<string>();
        section.querySelectorAll<HTMLElement>('[data-annotation-id]').forEach((element) => {
            const id = element.dataset['annotationId'];
            if (id) ids.add(id);
        });

        return this.getAllInDocumentOrder().filter(annotation => ids.has(annotation.id));
    }

    /**
     * Find the nearest heading ancestor for an annotation (so the export can
     * group annotations by section). Returns null if the annotation isn't
     * rendered or sits before the first heading.
     */
    headingForAnnotation(id: string): AnnotationHeading | null {
        const wrapper = this.#markdownBody.querySelector<HTMLElement>(
            `[data-annotation-id="${id}"]`,
        );
        if (!wrapper) return null;
        // Walk previous siblings (and ancestors' previous siblings) looking
        // for the closest preceding h1..h6 — that's the section the
        // annotation lives under.
        let node: Element | null = wrapper;
        while (node) {
            let prev: Element | null = node.previousElementSibling;
            while (prev) {
                if (/^H[1-6]$/.test(prev.tagName)) {
                    // Strip the toolbar/checkbox label clones the viewed
                    // feature injects into headings.
                    const clone = prev.cloneNode(true) as HTMLElement;
                    clone.querySelectorAll(
                        '.viewed-checkbox-label, .viewed-toolbar, .section-actions, .section-action, .section-action-separator',
                    ).forEach((el) => el.remove());
                    return {
                        level: parseInt(prev.tagName.substring(1), 10),
                        text: (clone.textContent ?? '').trim(),
                    };
                }
                prev = prev.previousElementSibling;
            }
            node = node.parentElement;
            if (node === this.#markdownBody) break;
        }
        return null;
    }

    /**
     * Group annotations (in document order) by their containing heading.
     * When `ids` is given, only those annotations are included (preserving
     * document order). Consecutive annotations under the same heading share a
     * group; content before the first heading lands in a `heading: null` group.
     */
    getGroupedByHeading(ids?: Iterable<string>): AnnotationGroup[] {
        const filter = ids ? new Set(ids) : null;
        const annotations = this.getAllInDocumentOrder()
            .filter(a => !filter || filter.has(a.id));

        const groups: AnnotationGroup[] = [];
        let lastKey: string | null = null;
        annotations.forEach(a => {
            const heading = this.headingForAnnotation(a.id);
            const key = heading ? `${heading.level}|${heading.text}` : '\0none';
            if (key !== lastKey) {
                groups.push({ heading, items: [] });
                lastKey = key;
            }
            const group = groups[groups.length - 1];
            if (group) group.items.push(a);
        });
        return groups;
    }

    /**
     * Format annotations on the page as Markdown suitable for pasting into an
     * AI tool. This is the sole public annotation-to-Markdown path: quick copy
     * passes one ID, while Export notes passes its selected set. Annotations
     * are listed in document order. When `ids` is omitted, the whole page is
     * formatted.
     */
    formatAsMarkdown(opts: { ids?: Iterable<string> } = {}): string {
        const filter = opts.ids ? new Set(opts.ids) : null;
        const annotations = this.getAllInDocumentOrder()
            .filter(a => !filter || filter.has(a.id));
        return this.#formatAnnotations(annotations);
    }

    #formatAnnotations(annotations: Annotation[]): string {
        if (annotations.length === 0) return '';

        // No preamble, no headings, no list numbering. Each note starts with
        // the smallest useful live context (one sentence, or one table row),
        // with the actual selection emphasized. Orphaned anchors retain the
        // historical selection-only representation as a safe fallback.
        const lines: string[] = [];
        annotations.forEach((a) => {
            const contextLines = this.#exportContextLines(a);
            if (contextLines.length) {
                contextLines.forEach(line => lines.push(`> ${line}`));
            } else {
                lines.push(`> *${this.#escapeExportMarkdown(a.text.trim())}*`);
            }
            if (a.note && a.note.trim()) {
                lines.push('', a.note.trim());
            }
            lines.push('');
        });

        return lines.join('\n').trimEnd() + '\n';
    }

    /** Resolve the selection against the live document and return one
     * context line per structural unit. Paragraph-like content is cropped to
     * the sentence(s) intersecting the selection; table selections keep the
     * complete row so a term and its definition remain connected. */
    #exportContextLines(annotation: Annotation): string[] {
        const ranges = this.rangesForAnnotation(annotation);
        if (!ranges.length) return [];

        const grouped = new Map<Element, Range[]>();
        ranges.forEach((range) => {
            const container = this.#exportContextContainer(range);
            if (!container) return;
            const group = grouped.get(container) ?? [];
            group.push(range);
            grouped.set(container, group);
        });

        return [...grouped.entries()]
            .map(([container, selectedRanges]) =>
                this.#formatExportContext(container, selectedRanges),
            )
            .filter((line): line is string => !!line);
    }

    #exportContextContainer(range: Range): Element | null {
        const startElement = range.startContainer.nodeType === Node.ELEMENT_NODE
            ? range.startContainer as Element
            : range.startContainer.parentElement;
        const tableRow = startElement?.closest('td, th')?.closest('tr');
        if (tableRow && this.#markdownBody.contains(tableRow)) return tableRow;
        return annotationBlockFor(range.startContainer, this.#markdownBody);
    }

    #formatExportContext(container: Element, ranges: readonly Range[]): string | null {
        const { text, segments } = this.#collectExportText(container);
        if (!text || !segments.length) return null;

        const intervals = ranges
            .map((range): ExportSelectionInterval | null => {
                const start = this.#exportOffset(segments, range.startContainer, range.startOffset);
                const end = this.#exportOffset(segments, range.endContainer, range.endOffset);
                return start !== null && end !== null && start < end ? { start, end } : null;
            })
            .filter((interval): interval is ExportSelectionInterval => !!interval)
            .sort((a, b) => a.start - b.start);
        if (!intervals.length) return null;

        const merged: ExportSelectionInterval[] = [];
        intervals.forEach((interval) => {
            const previous = merged.at(-1);
            if (previous && interval.start <= previous.end) {
                previous.end = Math.max(previous.end, interval.end);
            } else {
                merged.push({ ...interval });
            }
        });

        const first = merged[0];
        const last = merged.at(-1);
        if (!first || !last) return null;
        const [contextStart, contextEnd] = container.tagName === 'TR'
            ? [0, text.length]
            : this.#sentenceBounds(text, first.start, last.end);

        const parts: string[] = [];
        let cursor = contextStart;
        merged.forEach((interval) => {
            const start = Math.max(contextStart, interval.start);
            const end = Math.min(contextEnd, interval.end);
            if (start >= end) return;
            parts.push(this.#escapeExportMarkdown(text.slice(cursor, start)));
            parts.push(`*${this.#escapeExportMarkdown(text.slice(start, end))}*`);
            cursor = end;
        });
        parts.push(this.#escapeExportMarkdown(text.slice(cursor, contextEnd)));
        return parts.join('').replace(/\s+/g, ' ').trim() || null;
    }

    #collectExportText(container: Element): { text: string; segments: ExportTextSegment[] } {
        const segments: ExportTextSegment[] = [];
        let text = '';
        let previousCell: Element | null = null;
        const isTableRow = container.tagName === 'TR';
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
        let current: Node | null = walker.nextNode();
        while (current) {
            const node = current as Text;
            if (node.data && !this.#contentReject(node)) {
                const block = annotationBlockFor(node, this.#markdownBody);
                if (isTableRow || block === container) {
                    if (isTableRow) {
                        const cell = node.parentElement?.closest('td, th') ?? null;
                        if (previousCell && cell && cell !== previousCell) text += ' | ';
                        if (cell) previousCell = cell;
                    }
                    segments.push({ node, start: text.length });
                    text += node.data;
                }
            }
            current = walker.nextNode();
        }
        return { text, segments };
    }

    #exportOffset(
        segments: readonly ExportTextSegment[],
        container: Node,
        offset: number,
    ): number | null {
        if (container.nodeType !== Node.TEXT_NODE) return null;
        const segment = segments.find(candidate => candidate.node === container);
        return segment ? segment.start + offset : null;
    }

    #sentenceBounds(text: string, selectionStart: number, selectionEnd: number): [number, number] {
        const sentences = [...EXPORT_SENTENCE_SEGMENTER.segment(text)];
        const matching = sentences.filter((sentence) => {
            const start = sentence.index;
            const end = start + sentence.segment.length;
            return start < selectionEnd && end > selectionStart;
        });
        const first = matching[0];
        const last = matching.at(-1);
        return first && last
            ? [first.index, last.index + last.segment.length]
            : [0, text.length];
    }

    #escapeExportMarkdown(text: string): string {
        return text.replace(/\\/g, '\\\\').replace(/\*/g, '\\*');
    }

    /**
     * Add or upsert an annotation. Returns the op_id of the outgoing
     * WebSocket frame (when in shared mode), or `null` in local-only mode
     * and for remote-originating updates (`skipSave === true`).
     */
    async add(annotation: Annotation, skipSave = false): Promise<string | null> {
        // Commit before publishing the in-memory change. A failed SQLite write
        // must leave the rendered page and the manager snapshot untouched.
        let opId: string | null = null;
        if (!skipSave) {
            opId = await this.#storage.saveAnnotation(annotation);
        }

        const existingIndex = this.#annotations.findIndex(a => a.id === annotation.id);
        if (existingIndex >= 0) {
            this.#annotations[existingIndex] = annotation;
        } else {
            this.#annotations.push(annotation);
        }

        // Fire the change callback.
        this.#triggerChange('add', annotation);

        Logger.log('AnnotationManager', `Added annotation: ${annotation.id}${skipSave ? ' (from remote)' : ''}`);
        return opId;
    }

    async delete(id: string, skipSave = false): Promise<Annotation | null> {
        const index = this.#annotations.findIndex(a => a.id === id);
        if (index < 0) {
            Logger.warn('AnnotationManager', `Annotation not found: ${id}`);
            return null;
        }

        const deleted = this.#annotations[index];
        if (!deleted) return null;

        // Commit before publishing the in-memory change.
        if (!skipSave) {
            await this.#storage.deleteAnnotation(id);
        }

        this.#annotations.splice(index, 1);

        // Fire the change callback.
        this.#triggerChange('delete', deleted);

        Logger.log('AnnotationManager', `Deleted annotation: ${id}${skipSave ? ' (from remote)' : ''}`);
        return deleted;
    }

    async clear(skipSave = false): Promise<void> {
        const oldAnnotations = [...this.#annotations];

        if (!skipSave) {
            await this.#storage.clearAnnotations();
        }

        this.#annotations = [];
        this.#triggerChange('clear', oldAnnotations);

        Logger.log('AnnotationManager', `Cleared all annotations${skipSave ? ' (from remote)' : ''}`);
    }

    applyToDOM(annotationsToApply: Annotation[] | null = null): void {
        const annotations = annotationsToApply ?? this.#annotations;

        if (annotations.length === 0) {
            return;
        }

        // Each annotation re-anchors independently against the live DOM, and
        // wrapping preserves text content, so application order doesn't affect
        // correctness. Sort by anchor position for deterministic ordering.
        const sorted = [...annotations].sort(
            (a, b) => a.anchor.position - b.anchor.position,
        );

        sorted.forEach(anno => this.#applyAnnotation(anno));

        Logger.log('AnnotationManager', `Applied ${sorted.length} annotations to DOM`);
    }

    clearDOM(): void {
        this.#markdownBody
            .querySelectorAll<HTMLElement>('[data-annotation-id]')
            .forEach(el => this.#unwrap(el));

        Logger.log('AnnotationManager', 'Cleared annotations from DOM');
    }

    removeFromDOM(id: string): void {
        this.#markdownBody
            .querySelectorAll<HTMLElement>(`[data-annotation-id="${id}"]`)
            .forEach(el => this.#unwrap(el));

        Logger.log('AnnotationManager', `Removed annotation from DOM: ${id}`);
    }

    /** Lift a wrapper's children out, remove the now-empty wrapper, and
     *  re-merge the surrounding text nodes. */
    #unwrap(el: HTMLElement): void {
        const parent = el.parentNode;
        if (!parent) return;
        while (el.firstChild) {
            parent.insertBefore(el.firstChild, el);
        }
        parent.removeChild(el);
        (parent as Element).normalize?.();
    }

    createAnnotation(
        range: Range,
        type: AnnotationType,
        tagName: AnnotationTagName,
        note: string | null = null,
    ): Annotation {
        const anchor = this.#anchorForRange(range);

        return {
            id: `anno-${Ids.uuid()}`,
            type,
            tagName,
            anchor,
            text: TextAnchoring.quote(anchor),
            note,
            createdAt: Date.now(),
            author: Identity.author(),
        };
    }

    /** Clean, structure-aware text for Edit/Chat and other range consumers.
     *  Markon-injected controls are omitted and block boundaries become line
     *  breaks, matching the annotation's persisted display text. */
    textForRange(range: Range): string {
        return TextAnchoring.quote(this.#anchorForRange(range));
    }

    #anchorForRange(range: Range): TextAnchor {
        // Preserve the original flat text selector as a compatibility fallback
        // for older clients, then add the clean per-block selectors used by
        // current clients. No database migration is needed: `anchor` is stored
        // inside the existing annotation JSON blob.
        return {
            ...TextAnchoring.describe(this.#markdownBody, range, this.#surfaceReject),
            version: 2,
            fragments: this.#describeFragments(range),
        };
    }

    #describeFragments(range: Range) {
        return TextAnchoring.describeFragments(
            this.#markdownBody,
            range,
            this.#contentReject,
            (node) => annotationBlockFor(node, this.#markdownBody),
        );
    }

    #rejectForAnnotation(anno: Annotation): RejectFn | undefined {
        return anno.anchor.version === 2 && anno.anchor.fragments?.length
            ? this.#contentReject
            : this.#surfaceReject;
    }

    #anchorOptions() {
        return {
            ignorePosition: !!this.#surfaceReject,
            blockFor: (node: Node) => annotationBlockFor(node, this.#markdownBody),
        };
    }

    onChange(callback: AnnotationChangeCallback): void {
        this.#onChange = callback;
    }

    /** Resolve every independently anchored structural fragment. */
    rangesForAnnotation(anno: Annotation): Range[] {
        return TextAnchoring.ranges(
            this.#markdownBody,
            anno.anchor,
            this.#rejectForAnnotation(anno),
            this.#anchorOptions(),
        );
    }

    /** Resolve an annotation's complete live range, including all structural
     *  fragments. Used for editing a cross-block note from any one of its
     *  wrappers; DOM application uses the independent ranges above. */
    rangeForAnnotation(anno: Annotation): Range | null {
        const ranges = this.rangesForAnnotation(anno);
        const first = ranges[0];
        const last = ranges.at(-1);
        if (!first || !last) return null;
        const combined = document.createRange();
        combined.setStart(first.startContainer, first.startOffset);
        combined.setEnd(last.endContainer, last.endOffset);
        return combined;
    }

    #applyAnnotation(anno: Annotation): void {
        // Skip if the annotation is already present in the DOM.
        const existing = this.#markdownBody.querySelector(`[data-annotation-id="${anno.id}"]`);
        if (existing) {
            return;  // already present, skip
        }

        // Re-find the anchor against the live DOM. This both locates the range
        // and validates it: anchor() only returns a range whose text equals the
        // stored quote, so a null result means the quoted text is gone
        // (orphaned) — no separate drift check needed.
        // In scoped (diff new-side) mode the absolute char offset of a quote
        // differs from the full-document position captured elsewhere, so ignore
        // the position tiebreak — context alone disambiguates across views.
        const reject = this.#rejectForAnnotation(anno);
        const ranges = this.rangesForAnnotation(anno);
        if (ranges.length === 0) {
            Logger.warn('AnnotationManager', `Anchor text not found (orphaned): ${anno.id}`);
            return;
        }

        try {
            // Wrap each intersecting text node individually instead of
            // calling extractContents() + insertNode(), which would slice
            // inline elements (e.g. <code>) at the range boundary and leave
            // empty shells behind after unwrap. See #wrapRange.
            // Apply from the end so splitText/wrapper insertion never disturbs
            // a later fragment's yet-to-be-used boundaries.
            for (const range of ranges.reverse()) {
                this.#wrapRange(range, anno, reject);
            }
        } catch (error) {
            Logger.error('AnnotationManager', `Failed to apply annotation ${anno.id}:`, error);
        }
    }

    /**
     * Apply an annotation by wrapping each text node that intersects the
     * range with its own wrapper element. Inspired by mark.js: keeps inline
     * elements (`<code>`, `<em>`, …) intact because splitText only ever
     * splits text nodes, never element nodes.
     *
     * For a range that crosses inline boundaries this produces multiple
     * sibling wrappers that share the same `data-annotation-id` — that's
     * fine: `removeFromDOM` / `clearDOM` already query by id and unwrap
     * every match.
     */
    #wrapRange(range: Range, anno: Annotation, reject?: RejectFn): void {
        // Snapshot endpoints up front: splitText below mutates the tree, and
        // we don't want `range.startContainer` shifting under us.
        const startContainer = range.startContainer;
        const endContainer = range.endContainer;
        const startOffset = range.startOffset;
        const endOffset = range.endOffset;

        const ancestor = range.commonAncestorContainer;
        const root = ancestor.nodeType === 3 ? (ancestor.parentNode as Node) : ancestor;
        if (!root) return;

        // Collect (textNode, start, end) tuples for every text node that
        // intersects the range. Doing the collection before any mutation
        // means splitText-induced new siblings don't sneak into the walker.
        // The walker honours the same `reject` predicate as anchoring: a Range
        // can geometrically span an interleaved old/deleted text node (which the
        // anchor stream skipped), and wrapping it would pull deleted text into
        // the highlight and corrupt the tree on unwrap. Skipping it here keeps
        // the wrap confined to the new side.
        const targets: { node: Text; start: number; end: number }[] = [];
        const walker = document.createTreeWalker(
            root,
            NodeFilter.SHOW_TEXT,
            reject
                ? { acceptNode: (n) => (reject(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) }
                : null,
        );
        let cursor: Node | null = walker.nextNode();
        while (cursor) {
            const text = cursor as Text;
            if (range.intersectsNode(text)) {
                const start = text === startContainer ? startOffset : 0;
                const end = text === endContainer ? endOffset : text.length;
                if (start < end) {
                    targets.push({ node: text, start, end });
                }
            }
            cursor = walker.nextNode();
        }

        if (targets.length === 0) return;

        for (const { node, start, end } of targets) {
            // Slice the text node down to [start, end). Tail first so the
            // head split doesn't invalidate `end`. splitText only splits the
            // text node itself — surrounding inline elements stay intact.
            let target = node;
            if (end < target.length) {
                target.splitText(end);
            }
            if (start > 0) {
                target = target.splitText(start);
            }

            const wrapper = document.createElement(anno.tagName);
            wrapper.className = anno.type;
            wrapper.dataset['annotationId'] = anno.id;
            // Author colour drives the left identity line / strikethrough colour
            // in CSS; absent (anonymous) falls back to a neutral token. Name +
            // time are mirrored onto data attrs so the selection popover can show
            // attribution without a manager lookup.
            if (anno.author?.color) {
                wrapper.style.setProperty('--anno-author', anno.author.color);
            }
            if (anno.author?.name) {
                wrapper.dataset['authorName'] = anno.author.name;
            }
            wrapper.dataset['authorTime'] = String(anno.createdAt);
            if (anno.note) {
                wrapper.dataset['note'] = anno.note;
                wrapper.classList.add('has-note');
            }

            const parent = target.parentNode;
            if (!parent) continue;
            parent.insertBefore(wrapper, target);
            wrapper.appendChild(target);
        }
    }

    #triggerChange(action: AnnotationChangeAction, data: Annotation | Annotation[]): void {
        if (this.#onChange) {
            this.#onChange({
                action,
                data,
                annotations: this.getAll(),
            });
        }
    }
}
