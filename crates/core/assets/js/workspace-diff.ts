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

class SourceDiffView extends DiffSectionView {
    protected get scrollSelector(): string | null { return null; } // root scrolls
    protected get paneSelector(): string | null { return null; } // root is the pane
    protected get virtualizedClass(): string { return 'is-virtualized-diff'; }
    protected get bodyClass(): string { return 'workspace-diff-body'; }
    protected get emptyBlocksMessage(): string { return 'No source to preview.'; }

    protected estimateBlock(block: MarkdownDiffBlock): number {
        const oldN = this.#lineCount(block.old);
        const newN = this.#lineCount(block.new);
        const rows = block.kind === 'modified' ? Math.max(oldN, newN)
            : block.kind === 'equal' ? newN || oldN
            : block.kind === 'deleted' ? oldN : newN;
        return Math.max(24, rows * 22);
    }

    protected renderBlock(file: MarkdownDiffFile, block: MarkdownDiffBlock, index: number): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = `workspace-diff-block is-${block.kind}`;
        wrap.dataset.mdDiffPair = String(index);

        const oldLines = sourceLines(file.old_source, block.old?.start_line, block.old?.end_line);
        const newLines = sourceLines(file.new_source, block.new?.start_line, block.new?.end_line);
        const oldStart = block.old?.start_line ?? null;
        const newStart = block.new?.start_line ?? null;

        if (block.kind === 'equal') {
            // Context: pair lines 1:1 (same content on both sides).
            const count = Math.max(oldLines.length, newLines.length);
            for (let i = 0; i < count; i += 1) {
                const text = newLines[i] ?? oldLines[i] ?? '';
                wrap.appendChild(this.#row(
                    { no: oldStart != null ? oldStart + i : null, segs: [{ text, cls: null }], cls: 'git-diff-ctx' },
                    { no: newStart != null ? newStart + i : null, segs: [{ text, cls: null }], cls: 'git-diff-ctx' },
                ));
            }
            return wrap;
        }

        if (block.kind === 'added') {
            newLines.forEach((text, i) => wrap.appendChild(this.#row(
                this.#empty(),
                { no: newStart != null ? newStart + i : null, segs: [{ text, cls: 'add' }], cls: 'git-diff-add' },
            )));
            return wrap;
        }

        if (block.kind === 'deleted') {
            oldLines.forEach((text, i) => wrap.appendChild(this.#row(
                { no: oldStart != null ? oldStart + i : null, segs: [{ text, cls: 'del' }], cls: 'git-diff-del' },
                this.#empty(),
            )));
            return wrap;
        }

        // modified: line-level LCS so unchanged lines in the block stay aligned
        // and only genuinely changed lines get word-diffed (naive index pairing
        // turns a single mid-block insert into highlight noise from there on).
        const oldNo = (i: number) => (oldStart != null ? oldStart + i : null);
        const newNo = (j: number) => (newStart != null ? newStart + j : null);
        for (const op of lineDiff(oldLines, newLines)) {
            if (op.type === 'equal') {
                const text = newLines[op.newIndex];
                wrap.appendChild(this.#row(
                    { no: oldNo(op.oldIndex), segs: [{ text, cls: null }], cls: 'git-diff-ctx' },
                    { no: newNo(op.newIndex), segs: [{ text, cls: null }], cls: 'git-diff-ctx' },
                ));
            } else if (op.type === 'replace') {
                const { old, new: nw } = wordDiff(oldLines[op.oldIndex], newLines[op.newIndex]);
                wrap.appendChild(this.#row(
                    { no: oldNo(op.oldIndex), segs: old, cls: 'git-diff-del' },
                    { no: newNo(op.newIndex), segs: nw, cls: 'git-diff-add' },
                ));
            } else if (op.type === 'del') {
                wrap.appendChild(this.#row(
                    { no: oldNo(op.oldIndex), segs: [{ text: oldLines[op.oldIndex], cls: 'del' }], cls: 'git-diff-del' },
                    this.#empty(),
                ));
            } else {
                wrap.appendChild(this.#row(
                    this.#empty(),
                    { no: newNo(op.newIndex), segs: [{ text: newLines[op.newIndex], cls: 'add' }], cls: 'git-diff-add' },
                ));
            }
        }
        return wrap;
    }

    #empty(): SideLine {
        return { no: null, segs: [], cls: 'git-diff-empty-side' };
    }

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
        const code = document.createElement('code');
        code.className = 'workspace-diff-code';
        for (const seg of side.segs) {
            if (seg.cls) {
                const span = document.createElement('span');
                span.className = seg.cls === 'add' ? 'git-diff-word-add' : 'git-diff-word-del';
                span.textContent = seg.text;
                code.appendChild(span);
            } else {
                code.appendChild(document.createTextNode(seg.text));
            }
        }
        cell.append(gutter, code);
        return cell;
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
    };
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}
