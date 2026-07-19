/**
 * Content-based annotation anchoring over a rendered root, in the spirit of the
 * W3C Web Annotation TextQuoteSelector + TextPositionSelector.
 *
 * Anchors to the visible **text content** — not the DOM structure or the source
 * markup — so an annotation survives re-renders (diagrams, images, collapse /
 * expand) and moderate source edits (the quote is re-found). This replaces the
 * old XPath + offset anchoring, which broke whenever the rendered DOM changed.
 *
 * Model:
 *   describe(root, range) -> TextAnchor   // capture at creation
 *   anchor(root, a)       -> Range | null // re-find later (null = orphaned)
 */

interface TextQuoteAnchor {
    /** Char offset of the selection start within the root's text content. A
     *  disambiguation hint, not the sole anchor. */
    position: number;
    /** The exact selected text. */
    exact: string;
    /** Up to CONTEXT chars immediately before `exact`. */
    prefix: string;
    /** Up to CONTEXT chars immediately after `exact`. */
    suffix: string;
}

/** One structural fragment of a contiguous cross-block selection. */
export interface TextAnchorFragment extends TextQuoteAnchor {
    /** Rendered block tag at capture time, retained as structural metadata. */
    blockTag: string;
}

export interface TextAnchor extends TextQuoteAnchor {
    /** Version 2 adds per-block fragments while retaining the flat selector
     *  above as a compatibility fallback for older clients. */
    version?: 2;
    /** Ordered block fragments. Present on every newly-created annotation. */
    fragments?: TextAnchorFragment[];
}

const CONTEXT = 32;

interface Segment {
    node: Text;
    /** Global char offset of this text node's start within the root. */
    start: number;
}

/** Optional predicate: return `true` for a text node that must NOT take part in
 *  anchoring (it is filtered out of the collected stream). The predicate is
 *  responsible for walking up to whatever ancestor decides rejection. */
export type RejectFn = (node: Node) => boolean;
export type BlockResolver = (node: Node) => Element | null;

/** Concatenate the root's text nodes into one string + a segment index that
 *  maps global char offsets back to (textNode, localOffset).
 *
 *  When `reject` is supplied, text nodes it returns `true` for are skipped, so
 *  the collected stream only covers the relevant subset (e.g. the new side of a
 *  rendered diff). With no `reject` the walk is byte-for-byte the default. */
function collect(root: Node, reject?: RejectFn): { text: string; segments: Segment[] } {
    const segments: Segment[] = [];
    let text = '';
    const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT,
        reject
            ? { acceptNode: (n) => (reject(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) }
            : null,
    );
    let n: Node | null = walker.nextNode();
    while (n) {
        const node = n as Text;
        if (node.data.length > 0) {
            segments.push({ node, start: text.length });
            text += node.data;
        }
        n = walker.nextNode();
    }
    return { text, segments };
}

/** Global text offset of a DOM (container, offset) position within the root. */
function offsetOf(
    segments: Segment[],
    totalLen: number,
    container: Node,
    offset: number,
): number {
    if (container.nodeType === Node.TEXT_NODE) {
        const seg = segments.find((s) => s.node === container);
        return seg ? seg.start + offset : 0;
    }
    // Element container: `offset` is a child index. Resolve to the global offset
    // at the start of the child there (or the end of the container's text).
    const child = container.childNodes[offset] ?? null;
    if (child) {
        for (const s of segments) {
            if (child === s.node || (child.nodeType !== Node.TEXT_NODE && child.contains(s.node))) {
                return s.start;
            }
            if (child.compareDocumentPosition(s.node) & Node.DOCUMENT_POSITION_FOLLOWING) {
                return s.start;
            }
        }
        return totalLen;
    }
    // offset == childCount → end of this container's text.
    const inside = segments.filter((s) => container.contains(s.node));
    const last = inside[inside.length - 1];
    return last ? last.start + last.node.data.length : totalLen;
}

/** Map a global [start, end) offset back to a live DOM Range, or null if the
 *  offsets no longer fall inside the root's text. */
function rangeFromOffsets(segments: Segment[], start: number, end: number): Range | null {
    // At a boundary shared by two adjacent nodes, the start belongs to the
    // following node while the end belongs to the preceding one.
    const lastSegment = segments.at(-1);
    const startSeg =
        segments.find((s) => start >= s.start && start < s.start + s.node.data.length) ??
        (lastSegment && start === lastSegment.start + lastSegment.node.data.length
            ? lastSegment
            : undefined);
    const endSeg =
        segments.find((s) => end > s.start && end <= s.start + s.node.data.length) ??
        (end === 0 ? segments[0] : undefined);
    if (!startSeg || !endSeg) return null;
    const range = document.createRange();
    range.setStart(startSeg.node, start - startSeg.start);
    range.setEnd(endSeg.node, end - endSeg.start);
    return range;
}

function commonSuffixLen(a: string, b: string): number {
    let i = 0;
    while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
    return i;
}
function commonPrefixLen(a: string, b: string): number {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
}

function describeQuote(text: string, start: number, end: number): TextQuoteAnchor {
    return {
        position: start,
        exact: text.slice(start, end),
        prefix: text.slice(Math.max(0, start - CONTEXT), start),
        suffix: text.slice(end, end + CONTEXT),
    };
}

interface QuoteCandidate {
    start: number;
    end: number;
    score: number;
}

function quoteCandidates(
    text: string,
    segments: Segment[],
    quote: TextQuoteAnchor,
    opts?: AnchorOptions,
    expectedBlockTag?: string,
): QuoteCandidate[] {
    if (!quote.exact) return [];
    const positionWeight = opts?.ignorePosition ? 0 : 1;
    const candidates: QuoteCandidate[] = [];
    for (
        let occurrence = text.indexOf(quote.exact);
        occurrence !== -1;
        occurrence = text.indexOf(quote.exact, occurrence + 1)
    ) {
        const prefix = text.slice(Math.max(0, occurrence - quote.prefix.length), occurrence);
        const suffix = text.slice(
            occurrence + quote.exact.length,
            occurrence + quote.exact.length + quote.suffix.length,
        );
        let score =
            commonSuffixLen(prefix, quote.prefix) +
            commonPrefixLen(suffix, quote.suffix) -
            (positionWeight * Math.abs(occurrence - quote.position)) / 10000;

        // Structure is a tiebreaker, not a hard requirement: an annotation
        // should still survive a Markdown edit that changes a paragraph into a
        // list item while keeping the quoted text intact.
        if (expectedBlockTag && opts?.blockFor) {
            const candidateRange = rangeFromOffsets(
                segments,
                occurrence,
                occurrence + quote.exact.length,
            );
            if (candidateRange && opts.blockFor(candidateRange.startContainer)?.tagName === expectedBlockTag) {
                score += 1;
            }
        }

        candidates.push({
            start: occurrence,
            end: occurrence + quote.exact.length,
            score,
        });
    }
    return candidates;
}

function anchorQuote(
    text: string,
    segments: Segment[],
    quote: TextQuoteAnchor,
    opts?: AnchorOptions,
): Range | null {
    const best = quoteCandidates(text, segments, quote, opts)
        .reduce<QuoteCandidate | null>(
            (winner, candidate) => !winner || candidate.score > winner.score ? candidate : winner,
            null,
        );
    return best ? rangeFromOffsets(segments, best.start, best.end) : null;
}

function matchFragments(
    text: string,
    segments: Segment[],
    fragments: readonly TextAnchorFragment[],
    opts?: AnchorOptions,
): QuoteCandidate[] | null {
    interface SequenceState {
        candidate: QuoteCandidate;
        score: number;
        previous: SequenceState | null;
    }

    let states: SequenceState[] = [];
    for (const [index, fragment] of fragments.entries()) {
        const candidates = quoteCandidates(text, segments, fragment, opts, fragment.blockTag);
        if (candidates.length === 0) return null;

        if (index === 0) {
            states = candidates.map(candidate => ({
                candidate,
                score: candidate.score,
                previous: null,
            }));
            continue;
        }

        // Candidates and prior states are in document order. A running best
        // predecessor gives O(total occurrences), even for short repeated
        // fragments such as identical TODO list items.
        const nextStates: SequenceState[] = [];
        let previousIndex = 0;
        let bestPrevious: SequenceState | null = null;
        for (const candidate of candidates) {
            while (previousIndex < states.length) {
                const state = states[previousIndex];
                if (!state || state.candidate.end > candidate.start) break;
                if (!bestPrevious || state.score > bestPrevious.score) bestPrevious = state;
                previousIndex += 1;
            }
            if (bestPrevious) {
                nextStates.push({
                    candidate,
                    score: bestPrevious.score + candidate.score,
                    previous: bestPrevious,
                });
            }
        }
        if (nextStates.length === 0) return null;
        states = nextStates;
    }

    const lastState = states.reduce<SequenceState | null>(
        (winner, state) => !winner || state.score > winner.score ? state : winner,
        null,
    );
    if (!lastState) return null;

    const matched: QuoteCandidate[] = [];
    let state: SequenceState | null = lastState;
    while (state) {
        matched.push(state.candidate);
        state = state.previous;
    }
    return matched.reverse();
}

function rangesFromCollected(
    text: string,
    segments: Segment[],
    anchor: TextAnchor,
    opts?: AnchorOptions,
): Range[] {
    if (anchor.version === 2 && anchor.fragments?.length) {
        const matched = matchFragments(text, segments, anchor.fragments, opts);
        if (!matched) return [];
        const ranges = matched
            .map(candidate => rangeFromOffsets(segments, candidate.start, candidate.end));
        return ranges.every((range): range is Range => range !== null) ? ranges : [];
    }

    const range = anchorQuote(text, segments, anchor, opts);
    return range ? [range] : [];
}

function combineRanges(ranges: readonly Range[]): Range | null {
    const first = ranges[0];
    const last = ranges.at(-1);
    if (!first || !last) return null;
    const combined = document.createRange();
    combined.setStart(first.startContainer, first.startOffset);
    combined.setEnd(last.endContainer, last.endOffset);
    return combined;
}

/** Options for `anchor`'s occurrence scoring. */
export interface AnchorOptions {
    /** Zero out the `position` tiebreak term. The absolute char offset of a
     *  quote shifts between renderings of the same content (e.g. the full
     *  document vs. just the new side of a diff), so when re-finding across
     *  views the position hint is noise — context alone disambiguates. Default
     *  (`false`) keeps the position term, i.e. unchanged behavior. */
    ignorePosition?: boolean;
    /** Resolve a candidate's rendered block. For fragment anchors the captured
     *  block tag is used as a soft occurrence-scoring hint, never as a hard
     *  validity constraint. */
    blockFor?: BlockResolver;
}

export const TextAnchoring = {
    /** Capture a content anchor for `range` within `root`. */
    describe(root: Node, range: Range, reject?: RejectFn): TextAnchor {
        const { text, segments } = collect(root, reject);
        const start = offsetOf(segments, text.length, range.startContainer, range.startOffset);
        const end = offsetOf(segments, text.length, range.endContainer, range.endOffset);
        return describeQuote(text, start, end);
    },

    /**
     * Capture one ordered quote selector per rendered block. The flat selector
     * remains separate so callers can preserve a legacy fallback.
     */
    describeFragments(
        root: Node,
        range: Range,
        reject: RejectFn | undefined,
        blockFor: BlockResolver,
    ): TextAnchorFragment[] {
        const { text, segments } = collect(root, reject);
        const selectionStart = offsetOf(
            segments,
            text.length,
            range.startContainer,
            range.startOffset,
        );
        const selectionEnd = offsetOf(
            segments,
            text.length,
            range.endContainer,
            range.endOffset,
        );
        const groups: { block: Element | null; start: number; end: number }[] = [];

        for (const segment of segments) {
            const start = Math.max(selectionStart, segment.start);
            const end = Math.min(selectionEnd, segment.start + segment.node.data.length);
            if (start >= end) continue;

            const block = blockFor(segment.node);
            const current = groups.at(-1);
            if (current?.block === block) {
                current.end = end;
            } else {
                groups.push({ block, start, end });
            }
        }

        return groups
            .filter(({ start, end }) => text.slice(start, end).trim().length > 0)
            .map(({ block, start, end }) => ({
                ...describeQuote(text, start, end),
                blockTag: block?.tagName ?? '#ROOT',
            }));
    },

    /** Human-readable quote preserving structural fragment boundaries. */
    quote(anchor: TextAnchor): string {
        const fragments = anchor.fragments?.filter((fragment) => fragment.exact.length > 0);
        return fragments?.length
            ? fragments.map((fragment) => fragment.exact).join('\n')
            : anchor.exact;
    },

    /** Re-find every independently anchored structural fragment. Applying
     *  annotations through these ranges avoids absorbing content inserted
     *  between two fragments after the annotation was created. Legacy anchors
     *  return a one-item array. */
    ranges(root: Node, anchor: TextAnchor, reject?: RejectFn, opts?: AnchorOptions): Range[] {
        const { text, segments } = collect(root, reject);
        return rangesFromCollected(text, segments, anchor, opts);
    },

    /** Re-find the anchor in the (possibly changed) `root`. Returns a live Range,
     *  or null when the quoted text is gone (orphaned annotation). Among multiple
     *  occurrences the best context + position match wins. Fragment anchors
     *  return one bounding range for positioning/selection; DOM application
     *  should use {@link ranges} so later inserted content is not included. */
    anchor(root: Node, anchor: TextAnchor, reject?: RejectFn, opts?: AnchorOptions): Range | null {
        const { text, segments } = collect(root, reject);
        return combineRanges(rangesFromCollected(text, segments, anchor, opts));
    },
};
