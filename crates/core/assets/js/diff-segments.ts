// Shared diff model + segmentation used by BOTH compare views (rendered AST and
// raw source). Both consume the same `MarkdownDiffData` payload, segment it the
// same way (changed blocks + a little context, long unchanged runs collapsed),
// and share one expansion store — so the two views show the same regions and
// stay aligned line-for-line when you switch between them.

export type DiffAnchor = { path: string; line: number | null };

export type MarkdownBlockOutline = { index: number; kind: string; label: string };

export type MarkdownBlockSummary = MarkdownBlockOutline & {
    text: string;
    source: string;
    html: string;
    start_line?: number | null;
    end_line?: number | null;
    digest: string;
};

export type MarkdownDocumentSummary = { block_count: number; blocks: MarkdownBlockOutline[] };

export type MarkdownDiffBlock = {
    kind: 'equal' | 'modified' | 'added' | 'deleted';
    old?: MarkdownBlockSummary | null;
    new?: MarkdownBlockSummary | null;
};

export type MarkdownDiffDiagnostic = {
    side: 'old' | 'new';
    code: string;
    severity: string;
    message: string;
    start_line?: number | null;
    end_line?: number | null;
};

export type MarkdownDiffFile = {
    path: string;
    /** Canonical absolute path of the NEW side (worktree file). Byte-identical
     *  to the normal file view's annotation key, so diff annotations bind to the
     *  same storage bucket as opening the file directly. Empty for non-worktree
     *  diffs (commit…commit), where neither side is a live file. */
    abs_path?: string | null;
    old_path?: string | null;
    status: string;
    old?: MarkdownDocumentSummary | null;
    new?: MarkdownDocumentSummary | null;
    /** Full untruncated source of each side (raw view renders exact lines). */
    old_source?: string | null;
    new_source?: string | null;
    additions: number;
    deletions: number;
    blocks: MarkdownDiffBlock[];
    diagnostics: MarkdownDiffDiagnostic[];
};

export type MarkdownDiffData = {
    title: string;
    subtitle?: string | null;
    engine: { name: string; enabled: boolean; message?: string | null };
    files: MarkdownDiffFile[];
};

export const isMarkdownDiffData = (value: unknown): value is MarkdownDiffData => {
    if (!value || typeof value !== 'object') return false;
    const data = value as Partial<MarkdownDiffData>;
    return Boolean(data.engine) && Array.isArray(data.files);
};

// ── Segmentation: changed blocks + CONTEXT unchanged blocks, gaps for the rest ──

export const CONTEXT_BLOCKS = 3;

export type VisibleItem =
    | { kind: 'block'; block: MarkdownDiffBlock; index: number }
    | { kind: 'gap'; start: number; count: number };

/** Blocks to show as a diff: every changed block plus `context` unchanged blocks
 *  on each side; longer unchanged runs collapse into a `gap` (start + count). */
export function visibleBlockItems(blocks: MarkdownDiffBlock[], context = CONTEXT_BLOCKS): VisibleItem[] {
    const n = blocks.length;
    const show = new Array<boolean>(n).fill(false);
    for (let i = 0; i < n; i += 1) {
        if (blocks[i].kind !== 'equal') {
            for (let j = Math.max(0, i - context); j <= Math.min(n - 1, i + context); j += 1) show[j] = true;
        }
    }
    const items: VisibleItem[] = [];
    let i = 0;
    while (i < n) {
        if (show[i]) {
            items.push({ kind: 'block', block: blocks[i], index: i });
            i += 1;
        } else {
            const start = i;
            let count = 0;
            while (i < n && !show[i]) { count += 1; i += 1; }
            items.push({ kind: 'gap', start, count });
        }
    }
    return items;
}

// ── Expansion store: shared across both views on the same compare page ──────────
// Keyed by the compare data-url pathname (query stripped) so the rendered and raw
// views resolve the SAME store — expand a gap in one, it is expanded in the other.

export class ExpansionStore {
    #byPath = new Map<string, Set<number>>();
    has(path: string, start: number): boolean {
        return this.#byPath.get(path)?.has(start) ?? false;
    }
    add(path: string, start: number): void {
        let set = this.#byPath.get(path);
        if (!set) { set = new Set(); this.#byPath.set(path, set); }
        set.add(start);
    }
}

// The two compare views are separate esbuild bundles, so a module-level Map
// would NOT be shared between them. Anchor the registry on a global so the
// rendered and raw views resolve the SAME store for the same compare page —
// expanding a gap in one view expands it in the other.
const globalStores = (): Map<string, ExpansionStore> => {
    const g = globalThis as unknown as { __markonDiffExpansion__?: Map<string, ExpansionStore> };
    if (!g.__markonDiffExpansion__) g.__markonDiffExpansion__ = new Map();
    return g.__markonDiffExpansion__;
};

export const expansionStoreKey = (dataUrl?: string | null): string => {
    if (!dataUrl) return ':default';
    try {
        return new URL(dataUrl, window.location.origin).pathname;
    } catch {
        return dataUrl;
    }
};

export function expansionStore(dataUrl?: string | null): ExpansionStore {
    const stores = globalStores();
    const key = expansionStoreKey(dataUrl);
    let store = stores.get(key);
    if (!store) { store = new ExpansionStore(); stores.set(key, store); }
    return store;
}

/** A collapsed run of unchanged blocks: a full-width button that expands them.
 *  `onExpand` receives the button so the caller can replace it with the blocks. */
export function createGap(
    count: number,
    onExpand: (gap: HTMLButtonElement) => void,
    note?: string,
): HTMLButtonElement {
    const gap = document.createElement('button');
    gap.type = 'button';
    gap.className = 'md-diff-gap';
    const label = document.createElement('span');
    label.className = 'md-diff-gap-label';
    // Unfold (up+down chevrons) icon, signalling the row expands on click.
    label.innerHTML =
        '<svg class="md-diff-gap-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">' +
        '<path fill="currentColor" d="M8 2.5 11.2 5.7l-1.06 1.06L8 4.62 5.86 6.76 4.8 5.7 8 2.5Z"/>' +
        '<path fill="currentColor" d="M8 13.5 4.8 10.3l1.06-1.06L8 11.38l2.14-2.14 1.06 1.06L8 13.5Z"/></svg>';
    const text = document.createElement('span');
    const showText = count === 1 ? 'Show 1 unchanged block' : `Show ${count} unchanged blocks`;
    // `note` (e.g. a pure-rename hint) is folded into the same fold-line text.
    text.textContent = note ? `${note} · ${showText}` : showText;
    label.appendChild(text);
    gap.appendChild(label);
    gap.addEventListener('click', () => onExpand(gap));
    return gap;
}

// ── Word-level intra-line diff (client-side, for modified blocks) ───────────────

export type WordSeg = { text: string; cls: 'add' | 'del' | null };

// Whitespace runs and ASCII identifier runs stay whole; every other character
// (CJK, punctuation, symbols) is its own token. Splitting CJK per-character is
// essential — it has no spaces, so a whitespace tokenizer would treat a whole
// sentence as one token and light up the entire phrase on any change.
const tokenize = (text: string): string[] => text.match(/\s+|[A-Za-z0-9_]+|[^\s]/gu) ?? [];

/** GitHub-style word diff of two single lines → per-side token segments. Adjacent
 *  same-class tokens are merged. Unchanged tokens carry `cls: null`. */
export function wordDiff(oldText: string, newText: string): { old: WordSeg[]; new: WordSeg[] } {
    const a = tokenize(oldText);
    const b = tokenize(newText);
    // LCS table (token equality).
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i -= 1) {
        for (let j = n - 1; j >= 0; j -= 1) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const oldSeg: WordSeg[] = [];
    const newSeg: WordSeg[] = [];
    const push = (segs: WordSeg[], text: string, cls: 'add' | 'del' | null) => {
        const last = segs[segs.length - 1];
        if (last && last.cls === cls) last.text += text;
        else segs.push({ text, cls });
    };
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
        if (a[i] === b[j]) {
            push(oldSeg, a[i], null);
            push(newSeg, b[j], null);
            i += 1; j += 1;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            push(oldSeg, a[i], 'del');
            i += 1;
        } else {
            push(newSeg, b[j], 'add');
            j += 1;
        }
    }
    while (i < m) { push(oldSeg, a[i], 'del'); i += 1; }
    while (j < n) { push(newSeg, b[j], 'add'); j += 1; }
    return { old: oldSeg, new: newSeg };
}

// ── Line-level diff (LCS) for a modified block's old/new source ─────────────────
// Aligns unchanged lines so only genuinely changed lines get word-diffed (naive
// index pairing turns a single mid-block insert into noise from there on).

export type LineOp =
    | { type: 'equal'; oldIndex: number; newIndex: number }
    | { type: 'replace'; oldIndex: number; newIndex: number }
    | { type: 'del'; oldIndex: number }
    | { type: 'add'; newIndex: number };

export function lineDiff(oldLines: string[], newLines: string[]): LineOp[] {
    const m = oldLines.length;
    const n = newLines.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i -= 1) {
        for (let j = n - 1; j >= 0; j -= 1) {
            dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const ops: LineOp[] = [];
    let i = 0;
    let j = 0;
    const flush = (dels: number[], adds: number[]) => {
        // Pair removed+added lines as `replace` (word-diffed), surplus as pure del/add.
        const pairs = Math.min(dels.length, adds.length);
        for (let p = 0; p < pairs; p += 1) ops.push({ type: 'replace', oldIndex: dels[p], newIndex: adds[p] });
        for (let p = pairs; p < dels.length; p += 1) ops.push({ type: 'del', oldIndex: dels[p] });
        for (let p = pairs; p < adds.length; p += 1) ops.push({ type: 'add', newIndex: adds[p] });
    };
    let dels: number[] = [];
    let adds: number[] = [];
    while (i < m && j < n) {
        if (oldLines[i] === newLines[j]) {
            flush(dels, adds); dels = []; adds = [];
            ops.push({ type: 'equal', oldIndex: i, newIndex: j });
            i += 1; j += 1;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            dels.push(i); i += 1;
        } else {
            adds.push(j); j += 1;
        }
    }
    while (i < m) { dels.push(i); i += 1; }
    while (j < n) { adds.push(j); j += 1; }
    flush(dels, adds);
    return ops;
}

/** Wrap the changed tokens of `segs` (a wordDiff side covering `el`'s text
 *  exactly) in `<span class=markClass>`, walking the element's text nodes. Used
 *  by the rendered view to mark intra-block changes inline on the old/new cards
 *  (the rendered analog of the raw view's per-line word diff). */
export function applyWordHighlights(el: HTMLElement, segs: WordSeg[], markClass: string): void {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let n = walker.nextNode();
    while (n) { textNodes.push(n as Text); n = walker.nextNode(); }
    let si = 0;
    let soff = 0;
    for (const tn of textNodes) {
        let rest = tn.textContent ?? '';
        const parts: Array<{ text: string; marked: boolean }> = [];
        while (rest.length && si < segs.length) {
            const seg = segs[si];
            const take = Math.min(seg.text.length - soff, rest.length);
            parts.push({ text: rest.slice(0, take), marked: seg.cls != null });
            rest = rest.slice(take);
            soff += take;
            if (soff >= seg.text.length) { si += 1; soff = 0; }
        }
        if (rest.length) parts.push({ text: rest, marked: false });
        if (!parts.some((p) => p.marked)) continue;
        const frag = document.createDocumentFragment();
        for (const p of parts) {
            if (p.marked) {
                const span = document.createElement('span');
                span.className = markClass;
                span.textContent = p.text;
                frag.appendChild(span);
            } else {
                frag.appendChild(document.createTextNode(p.text));
            }
        }
        tn.parentNode?.replaceChild(frag, tn);
    }
}

/** Slice 1-based inclusive line range [start,end] out of a source string. */
export function sourceLines(source: string | null | undefined, start?: number | null, end?: number | null): string[] {
    if (!source || start == null) return [];
    const lines = source.split('\n');
    const from = Math.max(1, start);
    const to = Math.max(from, end ?? start);
    return lines.slice(from - 1, to);
}
