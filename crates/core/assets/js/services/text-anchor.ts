/**
 * Content-based annotation anchoring over a rendered root, in the spirit of the
 * W3C Web Annotation TextQuoteSelector + TextPositionSelector.
 *
 * Anchors to the visible **text content** — not the DOM structure or the source
 * markup — so an annotation survives re-renders (mermaid, images, collapse /
 * expand) and moderate source edits (the quote is re-found). This replaces the
 * old XPath + offset anchoring, which broke whenever the rendered DOM changed.
 *
 * Model:
 *   describe(root, range) -> TextAnchor   // capture at creation
 *   anchor(root, a)       -> Range | null // re-find later (null = orphaned)
 */

export interface TextAnchor {
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

const CONTEXT = 32;

interface Segment {
    node: Text;
    /** Global char offset of this text node's start within the root. */
    start: number;
}

/** Concatenate the root's text nodes into one string + a segment index that
 *  maps global char offsets back to (textNode, localOffset). */
function collect(root: Node): { text: string; segments: Segment[] } {
    const segments: Segment[] = [];
    let text = '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n: Node | null = walker.nextNode();
    while (n) {
        const node = n as Text;
        segments.push({ node, start: text.length });
        text += node.data;
        n = walker.nextNode();
    }
    return { text, segments };
}

/** Global text offset of a DOM (container, offset) position within the root. */
function offsetOf(
    root: Node,
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
    const find = (off: number): Segment | undefined =>
        segments.find((s) => off >= s.start && off <= s.start + s.node.data.length);
    const startSeg = find(start);
    const endSeg = find(end);
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

export const TextAnchoring = {
    /** Capture a content anchor for `range` within `root`. */
    describe(root: Node, range: Range): TextAnchor {
        const { text, segments } = collect(root);
        const start = offsetOf(root, segments, text.length, range.startContainer, range.startOffset);
        const end = offsetOf(root, segments, text.length, range.endContainer, range.endOffset);
        return {
            position: start,
            exact: text.slice(start, end),
            prefix: text.slice(Math.max(0, start - CONTEXT), start),
            suffix: text.slice(end, end + CONTEXT),
        };
    },

    /** Re-find the anchor in the (possibly changed) `root`. Returns a live Range,
     *  or null when the quoted text is gone (orphaned annotation). Among multiple
     *  occurrences the best context + position match wins. */
    anchor(root: Node, a: TextAnchor): Range | null {
        if (!a.exact) return null;
        const { text, segments } = collect(root);
        const occurrences: number[] = [];
        for (let i = text.indexOf(a.exact); i !== -1; i = text.indexOf(a.exact, i + 1)) {
            occurrences.push(i);
        }
        if (occurrences.length === 0) return null;

        let best = occurrences[0] ?? 0;
        let bestScore = -Infinity;
        for (const c of occurrences) {
            const pre = text.slice(Math.max(0, c - a.prefix.length), c);
            const suf = text.slice(c + a.exact.length, c + a.exact.length + a.suffix.length);
            const score =
                commonSuffixLen(pre, a.prefix) +
                commonPrefixLen(suf, a.suffix) -
                Math.abs(c - a.position) / 10000;
            if (score > bestScore) {
                bestScore = score;
                best = c;
            }
        }
        return rangeFromOffsets(segments, best, best + a.exact.length);
    },
};
