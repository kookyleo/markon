// Raw (source) compare view: each diff block is shown as its exact source
// lines with +/- markers and GitHub-style intra-line word highlighting. It
// consumes the SAME `MarkdownDiffData` payload as the rendered view (full
// per-file source is carried in `old_source`/`new_source`), and shares the
// section/virtualization/anchor/gap machinery via `DiffSectionView` — so the
// two views show the same regions and stay aligned line-for-line.

import { DiffSectionView } from './diff-section-view';
import {
    type MarkdownBlockSummary,
    type MarkdownDiffBlock,
    type MarkdownDiffFile,
    type WordSeg,
    lineDiff,
    sourceLines,
    wordDiff,
} from './diff-segments';

type SideLine = { no: number | null; segs: WordSeg[]; cls: string };
type RowPair = { old: SideLine; new: SideLine };

const EMPTY_CLS = 'git-diff-empty-side';

class SourceDiffView extends DiffSectionView {
    protected get scrollSelector(): string | null { return null; } // root scrolls
    protected get paneSelector(): string | null { return null; } // root is the pane
    protected get virtualizedClass(): string { return 'is-virtualized-diff'; }
    protected get bodyClass(): string { return 'workspace-diff-body'; }
    protected get emptyBlocksMessage(): string { return 'No source to preview.'; }

    /** Single-column 'unified' layout vs the default two-column 'split'. Driven
     *  by a data attribute on the root so a re-`load()` re-renders in the new
     *  mode without any extra state to thread through. */
    #unified(): boolean { return this.root.dataset.rawLayout === 'unified'; }

    protected estimateBlock(block: MarkdownDiffBlock): number {
        const oldN = this.#lineCount(block.old);
        const newN = this.#lineCount(block.new);
        // Unified stacks deletions ABOVE insertions, so a modified block needs
        // roughly old+new rows instead of max(old,new).
        const modifiedRows = this.#unified() ? oldN + newN : Math.max(oldN, newN);
        const rows = block.kind === 'modified' ? modifiedRows
            : block.kind === 'equal' ? newN || oldN
            : block.kind === 'deleted' ? oldN : newN;
        return Math.max(24, rows * 22);
    }

    protected renderBlock(file: MarkdownDiffFile, block: MarkdownDiffBlock, index: number): HTMLElement {
        const wrap = document.createElement('div');
        // `diff-change-block` is the shared marker (see markdown-diff.ts) so j/k
        // stepping + focus rail work identically across both views.
        wrap.className = `diff-change-block workspace-diff-block is-${block.kind}`;
        wrap.dataset.mdDiffPair = String(index);
        const pairs = this.#blockPairs(file, block);
        if (this.#unified()) {
            for (const pair of pairs) this.#appendUnified(wrap, pair);
        } else {
            for (const pair of pairs) wrap.appendChild(this.#row(pair.old, pair.new));
        }
        return wrap;
    }

    /** Old/new line pairing for a block — the shared model both layouts render
     *  from. Split shows each pair as one two-cell row; unified expands a changed
     *  pair into a deletion row followed by an insertion row. */
    #blockPairs(file: MarkdownDiffFile, block: MarkdownDiffBlock): RowPair[] {
        const oldLines = sourceLines(file.old_source, block.old?.start_line, block.old?.end_line);
        const newLines = sourceLines(file.new_source, block.new?.start_line, block.new?.end_line);
        const oldStart = block.old?.start_line ?? null;
        const newStart = block.new?.start_line ?? null;
        const pairs: RowPair[] = [];

        if (block.kind === 'equal') {
            // Context: pair lines 1:1 (same content on both sides).
            const count = Math.max(oldLines.length, newLines.length);
            for (let i = 0; i < count; i += 1) {
                const text = newLines[i] ?? oldLines[i] ?? '';
                pairs.push({
                    old: { no: oldStart != null ? oldStart + i : null, segs: [{ text, cls: null }], cls: 'git-diff-ctx' },
                    new: { no: newStart != null ? newStart + i : null, segs: [{ text, cls: null }], cls: 'git-diff-ctx' },
                });
            }
            return pairs;
        }
        if (block.kind === 'added') {
            newLines.forEach((text, i) => pairs.push({
                old: this.#empty(),
                new: { no: newStart != null ? newStart + i : null, segs: [{ text, cls: 'add' }], cls: 'git-diff-add' },
            }));
            return pairs;
        }
        if (block.kind === 'deleted') {
            oldLines.forEach((text, i) => pairs.push({
                old: { no: oldStart != null ? oldStart + i : null, segs: [{ text, cls: 'del' }], cls: 'git-diff-del' },
                new: this.#empty(),
            }));
            return pairs;
        }

        // modified: line-level LCS so unchanged lines in the block stay aligned
        // and only genuinely changed lines get word-diffed (naive index pairing
        // turns a single mid-block insert into highlight noise from there on).
        const oldNo = (i: number) => (oldStart != null ? oldStart + i : null);
        const newNo = (j: number) => (newStart != null ? newStart + j : null);
        for (const op of lineDiff(oldLines, newLines)) {
            if (op.type === 'equal') {
                const text = newLines[op.newIndex];
                pairs.push({
                    old: { no: oldNo(op.oldIndex), segs: [{ text, cls: null }], cls: 'git-diff-ctx' },
                    new: { no: newNo(op.newIndex), segs: [{ text, cls: null }], cls: 'git-diff-ctx' },
                });
            } else if (op.type === 'replace') {
                const { old, new: nw } = wordDiff(oldLines[op.oldIndex], newLines[op.newIndex]);
                pairs.push({
                    old: { no: oldNo(op.oldIndex), segs: old, cls: 'git-diff-del' },
                    new: { no: newNo(op.newIndex), segs: nw, cls: 'git-diff-add' },
                });
            } else if (op.type === 'del') {
                pairs.push({
                    old: { no: oldNo(op.oldIndex), segs: [{ text: oldLines[op.oldIndex], cls: 'del' }], cls: 'git-diff-del' },
                    new: this.#empty(),
                });
            } else {
                pairs.push({
                    old: this.#empty(),
                    new: { no: newNo(op.newIndex), segs: [{ text: newLines[op.newIndex], cls: 'add' }], cls: 'git-diff-add' },
                });
            }
        }
        return pairs;
    }

    #empty(): SideLine {
        return { no: null, segs: [], cls: EMPTY_CLS };
    }

    // ── Split (two-column) rows ─────────────────────────────────────────────────
    #row(oldSide: SideLine, newSide: SideLine): HTMLElement {
        const line = document.createElement('div');
        line.className = 'workspace-diff-row-line workspace-diff-split-line';
        // Anchor coordinate: the new-side line number (or old for deletions),
        // matching the rendered view's block source line.
        const lineNo = newSide.no ?? oldSide.no;
        if (lineNo != null) line.dataset.line = String(lineNo);
        line.append(this.#cell(oldSide), this.#cell(newSide));
        return line;
    }

    #cell(side: SideLine): HTMLElement {
        const cell = document.createElement('div');
        cell.className = `workspace-diff-split-cell ${side.cls}`;
        const gutter = document.createElement('span');
        gutter.className = 'workspace-diff-line-no';
        gutter.textContent = side.no == null ? '' : String(side.no);
        cell.append(gutter, this.#code(side.segs));
        return cell;
    }

    // ── Unified (single-column) rows ────────────────────────────────────────────
    #appendUnified(wrap: HTMLElement, pair: RowPair): void {
        const oEmpty = pair.old.cls === EMPTY_CLS;
        const nEmpty = pair.new.cls === EMPTY_CLS;
        if (!oEmpty && !nEmpty && pair.old.cls === 'git-diff-ctx') {
            wrap.appendChild(this.#unifiedRow(pair.old.no, pair.new.no, pair.new.segs, 'git-diff-ctx', ' '));
            return;
        }
        // GitHub order: deletions first, then insertions.
        if (!oEmpty) wrap.appendChild(this.#unifiedRow(pair.old.no, null, pair.old.segs, 'git-diff-del', '-'));
        if (!nEmpty) wrap.appendChild(this.#unifiedRow(null, pair.new.no, pair.new.segs, 'git-diff-add', '+'));
    }

    #unifiedRow(oldNo: number | null, newNo: number | null, segs: WordSeg[], cls: string, sign: string): HTMLElement {
        const line = document.createElement('div');
        line.className = `workspace-diff-row-line workspace-diff-unified-line ${cls}`;
        const lineNo = newNo ?? oldNo;
        if (lineNo != null) line.dataset.line = String(lineNo);
        const oldGutter = document.createElement('span');
        oldGutter.className = 'workspace-diff-line-no';
        oldGutter.textContent = oldNo == null ? '' : String(oldNo);
        const newGutter = document.createElement('span');
        newGutter.className = 'workspace-diff-line-no';
        newGutter.textContent = newNo == null ? '' : String(newNo);
        const marker = document.createElement('span');
        marker.className = 'workspace-diff-sign';
        marker.textContent = sign;
        line.append(oldGutter, newGutter, marker, this.#code(segs));
        return line;
    }

    /** A `<code>` element with word-level add/del highlight spans. */
    #code(segs: WordSeg[]): HTMLElement {
        const code = document.createElement('code');
        code.className = 'workspace-diff-code';
        for (const seg of segs) {
            if (seg.cls) {
                const span = document.createElement('span');
                span.className = seg.cls === 'add' ? 'git-diff-word-add' : 'git-diff-word-del';
                span.textContent = seg.text;
                code.appendChild(span);
            } else {
                code.appendChild(document.createTextNode(seg.text));
            }
        }
        return code;
    }

    #lineCount(block: MarkdownBlockSummary | null | undefined): number {
        if (!block || block.start_line == null) return 1;
        return Math.max(1, (block.end_line ?? block.start_line) - block.start_line + 1);
    }
}

const views = new WeakMap<HTMLElement, SourceDiffView>();

const getView = (root: HTMLElement): SourceDiffView => {
    let view = views.get(root);
    if (!view) { view = new SourceDiffView(root); views.set(root, view); }
    return view;
};

const rawRoot = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-virtual-diff]');

const loadSourceDiff = (root = rawRoot()): void => {
    if (!root) return;
    void getView(root).load();
};

const selectSourcePath = (path?: string | null, root = rawRoot()): void => {
    if (!root) return;
    getView(root).selectPath(path || null);
};

const init = (): void => {
    document.querySelectorAll<HTMLElement>('[data-virtual-diff]').forEach((root) => {
        getView(root);
        if (root.dataset.diffAutoload !== 'false') loadSourceDiff(root);
    });
    window.markonSourceDiff = {
        load: () => loadSourceDiff(),
        selectPath: (path?: string | null) => selectSourcePath(path),
        scrollToPath: (path: string) => { const r = rawRoot(); if (r) getView(r).scrollToPath(path); },
        topAnchor: () => { const r = rawRoot(); return r ? getView(r).topAnchor() : null; },
        anchorTo: (anchor) => { const r = rawRoot(); if (r) getView(r).anchorTo(anchor); },
        setLayout: (mode) => {
            const r = rawRoot();
            if (!r) return;
            if (r.dataset.rawLayout === mode) return;
            // Re-render in place, keeping the line currently at the top in view.
            const view = getView(r);
            const anchor = view.topAnchor();
            r.dataset.rawLayout = mode;
            if (anchor) view.anchorTo(anchor);
            void view.load();
        },
    };
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}
