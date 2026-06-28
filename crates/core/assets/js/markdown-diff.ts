// Rendered (AST) compare view: each diff block is shown as rendered Markdown
// HTML (stacked old/new cards for changes). All the section / virtualization /
// anchor / gap machinery lives in the shared `DiffSectionView` base — this
// subclass only knows how to turn a block into rendered HTML.

import { DiffSectionView } from './diff-section-view';
import { applyWordHighlights, lineDiff, wordDiff } from './diff-segments';
import type {
    MarkdownBlockOutline,
    MarkdownBlockSummary,
    MarkdownDiffBlock,
    MarkdownDiffData,
    MarkdownDiffDiagnostic,
    MarkdownDiffFile,
    MarkdownDocumentSummary,
} from './diff-segments';

export class MarkdownDiffPage extends DiffSectionView {
    #sectionDepthCache = new WeakMap<MarkdownDiffFile, { old: Map<number, number>; new: Map<number, number> }>();

    protected get scrollSelector(): string | null { return '[data-diff-view-panel="rendered"]'; }
    protected get paneSelector(): string { return '[data-md-diff-content]'; }
    protected get virtualizedClass(): string { return 'is-virtualized-md-diff'; }
    protected get emptyBlocksMessage(): string { return 'No Markdown blocks to preview.'; }

    protected onRender(data: MarkdownDiffData): void {
        const engineText = data.engine.enabled
            ? `${data.engine.name} enabled`
            : `${data.engine.name} unavailable`;
        this.text('[data-md-engine-status]', data.engine.message ? `${engineText} · ${data.engine.message}` : engineText);
    }

    protected onFiles(_files: MarkdownDiffFile[]): void {
        this.#sectionDepthCache = new WeakMap();
    }

    protected fileLead(file: MarkdownDiffFile): Node | null {
        const diagnostics = [
            ...file.diagnostics.filter((d) => d.side === 'old'),
            ...file.diagnostics.filter((d) => d.side === 'new'),
        ];
        return diagnostics.length ? this.#createDiagnostics(diagnostics) : null;
    }

    // One unified diff-shading style for structural (item-level) diffs: a band
    // overlay per changed item — content-width tint + gutter rail + +/- marker,
    // exactly like the change cards. It is measured against the block (not the
    // indented <li>), so the shading never follows the list's own indentation.
    protected afterBodyRendered(body: HTMLElement): void {
        body.querySelectorAll<HTMLElement>('.md-diff-rendered-structural').forEach((block) => this.#drawItemBands(block));
        // A file body was (re)built — its annotation wrappers were discarded with
        // the old DOM, so let the diff annotation coordinator re-anchor against
        // the fresh new-side content. No-op when annotations are inert (non-
        // worktree diff) or the coordinator script isn't loaded.
        window.markonDiffAnnotations?.onBodyRendered(body);
    }

    #drawItemBands(block: HTMLElement): void {
        block.querySelectorAll(':scope > .md-diff-item-band').forEach((b) => b.remove());
        const top = block.getBoundingClientRect().top;
        for (const item of block.querySelectorAll<HTMLElement>('.md-diff-item-old, .md-diff-item-new')) {
            const r = item.getBoundingClientRect();
            const isOld = item.classList.contains('md-diff-item-old');
            const band = document.createElement('div');
            band.className = `md-diff-item-band ${isOld ? 'md-diff-item-band-old' : 'md-diff-item-band-new'}`;
            band.dataset.diffMarker = isOld ? '-' : '+';
            band.style.top = `${r.top - top}px`;
            band.style.height = `${r.height}px`;
            block.appendChild(band);
        }
    }

    syncLayout(): void {
        // Text rewraps on resize → item heights change → re-measure the bands.
        this.root.querySelectorAll<HTMLElement>('.md-diff-rendered-structural').forEach((block) => this.#drawItemBands(block));
    }

    protected afterContentRendered(): void {
        // The whole file set was rebuilt (initial load / view switch). Per-body
        // re-anchoring already happens in afterBodyRendered as each section's body
        // renders; this signals the coordinator that the pass is complete (note
        // popups / stale-context cleanup). No-op when the coordinator is absent.
        queueMicrotask(() => {
            window.markonDiffAnnotations?.onContentRendered();
            document.dispatchEvent(new CustomEvent('markon:markdown-diff-rendered'));
        });
    }

    protected estimateBlock(block: MarkdownDiffBlock): number {
        const oldBlock = block.old || null;
        const newBlock = block.new || null;
        const lineCount = block.kind === 'modified'
            ? this.#blockLineCount(oldBlock) + this.#blockLineCount(newBlock)
            : Math.max(this.#blockLineCount(oldBlock), this.#blockLineCount(newBlock));
        const charCount = block.kind === 'modified'
            ? (oldBlock?.source?.length || oldBlock?.text?.length || 0) + (newBlock?.source?.length || newBlock?.text?.length || 0)
            : Math.max(oldBlock?.source?.length || oldBlock?.text?.length || 0, newBlock?.source?.length || newBlock?.text?.length || 0);
        const wrappedLines = Math.ceil(charCount / 110);
        const estimatedLines = Math.max(lineCount, wrappedLines);
        const base = block.kind === 'equal' ? 76 : block.kind === 'modified' ? 210 : 132;
        return Math.max(base, 42 + estimatedLines * 21);
    }

    protected renderBlock(file: MarkdownDiffFile, block: MarkdownDiffBlock, rowIndex: number): HTMLElement {
        const row = document.createElement('article');
        row.className = `md-diff-block is-${block.kind}`;
        row.dataset.mdDiffPair = String(rowIndex);
        // Source line span, so the cross-mode anchor can interpolate a precise
        // line WITHIN a tall block (the AST is block-level, not line-level).
        const side = block.new ?? block.old;
        if (side?.start_line != null) {
            row.dataset.line = String(side.start_line);
            row.dataset.lineEnd = String(side.end_line ?? side.start_line);
        }

        if (block.kind === 'equal') {
            const rendered = block.new
                ? this.#createRenderedBlock(block.new, this.#blockSectionDepth(file, 'new', block.new))
                : this.#createRenderedBlock(block.old || null, this.#blockSectionDepth(file, 'old', block.old || null));
            rendered.classList.add('md-diff-rendered-equal');
            row.appendChild(rendered);
            return row;
        }

        if (block.kind === 'modified') {
            // If the block is a list/table where only some items changed, diff its
            // items (same LCS the raw view uses for lines) so unchanged items show
            // once as context and only changed items show old/new.
            const structural = this.#tryStructuralModified(block, file);
            if (structural) {
                row.classList.add('is-structural');
                row.appendChild(structural);
                return row;
            }
            const oldCard = this.#createChangeCard('old', '-', block.old || null, this.#blockSectionDepth(file, 'old', block.old || null));
            const newCard = this.#createChangeCard('new', '+', block.new || null, this.#blockSectionDepth(file, 'new', block.new || null));
            this.#highlightWordChanges(oldCard, newCard);
            row.append(oldCard, newCard);
            return row;
        }

        if (block.kind === 'deleted') {
            row.appendChild(this.#createChangeCard('old', '-', block.old || null, this.#blockSectionDepth(file, 'old', block.old || null)));
        } else {
            row.appendChild(this.#createChangeCard('new', '+', block.new || null, this.#blockSectionDepth(file, 'new', block.new || null)));
        }
        return row;
    }

    // Mark exactly what changed inline on the old/new rendered cards (LCS word
    // diff of their rendered text) — the rendered analog of the raw view's
    // per-line word diff, so unchanged content recedes and changes pop.
    #highlightWordChanges(oldCard: HTMLElement, newCard: HTMLElement): void {
        const oldRendered = oldCard.querySelector<HTMLElement>('.md-diff-rendered');
        const newRendered = newCard.querySelector<HTMLElement>('.md-diff-rendered');
        if (!oldRendered || !newRendered) return;
        const oldText = oldRendered.textContent ?? '';
        const newText = newRendered.textContent ?? '';
        if (!oldText.trim() || !newText.trim()) return;
        const { old, new: nw } = wordDiff(oldText, newText);
        applyWordHighlights(oldRendered, old, 'git-diff-word-del');
        applyWordHighlights(newRendered, nw, 'git-diff-word-add');
    }

    // Sub-block (item-level) diff for a modified list/table, mirroring how the
    // raw view sub-diffs a modified block by line. Unchanged items render once as
    // context; only changed items show old/new with word highlights. Returns null
    // (→ fall back to old/new cards) unless it's a container with shared context.
    #tryStructuralModified(block: MarkdownDiffBlock, file: MarkdownDiffFile): HTMLElement | null {
        const oldHtml = block.old?.html;
        const newHtml = block.new?.html;
        if (!oldHtml || !newHtml) return null;
        const oldC = this.#topContainer(oldHtml);
        const newC = this.#topContainer(newHtml);
        if (!oldC || !newC) return null;
        // requireContext: only worth a structural render when some items are shared.
        const merged = this.#mergeContainer(oldC, newC, true);
        if (!merged) return null;

        const rendered = document.createElement('div');
        rendered.className = 'md-diff-rendered md-diff-rendered-structural';
        const depth = this.#blockSectionDepth(file, 'new', block.new || null);
        rendered.dataset.mdSectionDepth = String(depth);
        if (depth > 0) {
            rendered.classList.add('md-diff-rendered-sectioned');
            rendered.style.setProperty('--md-diff-section-indent', `${depth * 10}px`);
            rendered.style.setProperty('--md-diff-section-indent-wide', `${depth * 14}px`);
        }
        rendered.appendChild(merged);
        return rendered;
    }

    #topContainer(html: string): HTMLElement | null {
        const holder = document.createElement('div');
        holder.innerHTML = html;
        // ol excluded at top level (consecutive old/new items would misnumber);
        // nested ol IS handled (with explicit `value`) via #mergeItem recursion.
        return holder.querySelector<HTMLElement>('ul, table');
    }

    #containerItems(container: HTMLElement): HTMLElement[] {
        return container.tagName === 'TABLE'
            ? [...container.querySelectorAll<HTMLElement>('tr')]
            : [...container.children].filter((c): c is HTMLElement => c.tagName === 'LI');
    }

    // Diff a list/table's items (LCS, like the raw view does for lines): unchanged
    // items render once as context, changed items show old/new. Recurses into a
    // changed item whose own text is unchanged but whose nested list changed.
    #mergeContainer(oldC: HTMLElement, newC: HTMLElement, requireContext: boolean): HTMLElement | null {
        if (oldC.tagName !== newC.tagName) return null;
        const oldItems = this.#containerItems(oldC);
        const newItems = this.#containerItems(newC);
        if (!oldItems.length && !newItems.length) return null;
        const norm = (el: HTMLElement) => (el.textContent ?? '').trim().replace(/\s+/g, ' ');
        const ops = lineDiff(oldItems.map(norm), newItems.map(norm));
        if (requireContext && (!ops.some((op) => op.type === 'equal') || !ops.some((op) => op.type !== 'equal'))) {
            return null;
        }

        const tag = newC.tagName.toLowerCase();
        const out = document.createElement(tag);
        out.className = newC.className;
        const sink = tag === 'table' ? out.appendChild(document.createElement('tbody')) : out;
        const isOl = tag === 'ol';
        const clone = (el: HTMLElement) => el.cloneNode(true) as HTMLElement;
        // Keep ordered-list numbering sane: old/new of the same item share a number.
        const place = (el: HTMLElement, num?: number) => {
            if (isOl && num != null) el.setAttribute('value', String(num));
            sink.appendChild(el);
        };
        let num = 0;
        for (const op of ops) {
            if (op.type === 'equal') {
                num += 1;
                place(clone(newItems[op.newIndex]), num);
            } else if (op.type === 'replace') {
                num += 1;
                const recursed = this.#mergeItem(oldItems[op.oldIndex], newItems[op.newIndex]);
                if (recursed) {
                    place(recursed, num);
                } else {
                    const oldItem = clone(oldItems[op.oldIndex]);
                    const newItem = clone(newItems[op.newIndex]);
                    oldItem.classList.add('md-diff-item-old');
                    newItem.classList.add('md-diff-item-new');
                    const { old, new: nw } = wordDiff(oldItem.textContent ?? '', newItem.textContent ?? '');
                    applyWordHighlights(oldItem, old, 'git-diff-word-del');
                    applyWordHighlights(newItem, nw, 'git-diff-word-add');
                    place(oldItem, num);
                    place(newItem, num);
                }
            } else if (op.type === 'del') {
                const oldItem = clone(oldItems[op.oldIndex]);
                oldItem.classList.add('md-diff-item-old');
                place(oldItem, isOl ? num + 1 : undefined);
            } else {
                num += 1;
                const newItem = clone(newItems[op.newIndex]);
                newItem.classList.add('md-diff-item-new');
                place(newItem, num);
            }
        }
        return out;
    }

    // A changed item whose own (non-nested) content is unchanged and whose only
    // change is a nested list → keep the item, sub-diff the nested list. Else null.
    #mergeItem(oldItem: HTMLElement, newItem: HTMLElement): HTMLElement | null {
        const nestedOf = (item: HTMLElement) =>
            [...item.children].find((c) => c.tagName === 'UL' || c.tagName === 'OL' || c.tagName === 'TABLE') as HTMLElement | undefined;
        const oldNested = nestedOf(oldItem);
        const newNested = nestedOf(newItem);
        if (!oldNested || !newNested || oldNested.tagName !== newNested.tagName) return null;
        const ownText = (item: HTMLElement, nested: HTMLElement) => {
            const c = item.cloneNode(true) as HTMLElement;
            [...c.children].find((x) => x.tagName === nested.tagName)?.remove();
            return (c.textContent ?? '').trim().replace(/\s+/g, ' ');
        };
        if (ownText(oldItem, oldNested) !== ownText(newItem, newNested)) return null;
        const mergedNested = this.#mergeContainer(oldNested, newNested, false);
        if (!mergedNested) return null;
        const merged = newItem.cloneNode(true) as HTMLElement;
        const slot = [...merged.children].find((x) => x.tagName === newNested.tagName);
        if (!slot) return null;
        slot.replaceWith(mergedNested);
        return merged;
    }

    #createChangeCard(
        side: 'old' | 'new',
        marker: '+' | '-',
        block: MarkdownBlockSummary | null,
        sectionDepth: number,
    ): HTMLElement {
        const card = document.createElement('section');
        card.className = `md-diff-change-card md-diff-change-card-${side}`;
        card.dataset.diffMarker = marker;
        if (block) {
            card.title = `${block.kind} · ${this.#formatBlockMeta(block, side)}`;
            card.setAttribute('aria-label', this.#formatBlockMeta(block, side));
        }
        card.appendChild(this.#createRenderedBlock(block, sectionDepth));
        return card;
    }

    #createRenderedBlock(block: MarkdownBlockSummary | null, sectionDepth = 0): HTMLElement {
        const rendered = document.createElement('div');
        rendered.className = 'md-diff-rendered';
        if (!block) {
            const placeholder = document.createElement('div');
            placeholder.className = 'md-diff-placeholder';
            placeholder.setAttribute('aria-hidden', 'true');
            rendered.appendChild(placeholder);
            return rendered;
        }
        rendered.dataset.mdBlockKind = block.kind;
        rendered.dataset.mdSectionDepth = String(sectionDepth);
        if (sectionDepth > 0) {
            rendered.classList.add('md-diff-rendered-sectioned');
            rendered.style.setProperty('--md-diff-section-indent', `${sectionDepth * 10}px`);
            rendered.style.setProperty('--md-diff-section-indent-wide', `${sectionDepth * 14}px`);
        }
        rendered.innerHTML = block.html || '';
        return rendered;
    }

    #createDiagnostics(diagnostics: MarkdownDiffDiagnostic[]): HTMLElement {
        const element = document.createElement('div');
        element.className = 'md-diff-diagnostics';
        element.textContent = diagnostics.map((diagnostic) => diagnostic.message).join(' · ');
        return element;
    }

    #blockSectionDepth(file: MarkdownDiffFile, side: 'old' | 'new', block: MarkdownBlockSummary | null): number {
        if (!block) return 0;
        return this.#sectionDepthsForFile(file)[side].get(block.index) ?? 0;
    }

    #sectionDepthsForFile(file: MarkdownDiffFile): { old: Map<number, number>; new: Map<number, number> } {
        const cached = this.#sectionDepthCache.get(file);
        if (cached) return cached;
        const depths = {
            old: this.#documentSectionDepths(file.old),
            new: this.#documentSectionDepths(file.new),
        };
        this.#sectionDepthCache.set(file, depths);
        return depths;
    }

    #documentSectionDepths(summary: MarkdownDocumentSummary | null | undefined): Map<number, number> {
        const depths = new Map<number, number>();
        const headingStack: number[] = [];
        for (const block of summary?.blocks || []) {
            const level = this.#headingLevel(block);
            if (level !== null) {
                while (headingStack.length && (headingStack[headingStack.length - 1] || 0) >= level) headingStack.pop();
                depths.set(block.index, headingStack.length);
                headingStack.push(level);
            } else {
                depths.set(block.index, headingStack.length);
            }
        }
        return depths;
    }

    #headingLevel(block: MarkdownBlockOutline): number | null {
        if (block.kind !== 'heading') return null;
        const match = /^H([1-6])$/.exec(block.label || '');
        return match ? Number(match[1]) : 1;
    }

    #blockLineCount(block: MarkdownBlockSummary | null): number {
        const text = block?.source || block?.text || '';
        return text ? text.split('\n').length : 1;
    }

    #formatBlockMeta(block: MarkdownBlockSummary, side: 'old' | 'new'): string {
        const range = block.start_line
            ? block.end_line && block.end_line !== block.start_line
                ? `L${block.start_line}-L${block.end_line}`
                : `L${block.start_line}`
            : `#${block.index + 1}`;
        return `${side} · ${range}`;
    }
}

const pages = new WeakMap<HTMLElement, MarkdownDiffPage>();

const getPage = (root: HTMLElement): MarkdownDiffPage => {
    let page = pages.get(root);
    if (!page) { page = new MarkdownDiffPage(root); pages.set(root, page); }
    return page;
};

const loadMarkdownDiff = (root = document.querySelector<HTMLElement>('[data-markdown-diff]')): void => {
    if (!root) return;
    void getPage(root).load();
};

const selectMarkdownPath = (
    path?: string | null,
    root = document.querySelector<HTMLElement>('[data-markdown-diff]'),
): void => {
    if (!root) return;
    getPage(root).selectPath(path || null);
};

const init = (): void => {
    document.querySelectorAll<HTMLElement>('[data-markdown-diff]').forEach((root) => {
        getPage(root);
        if (root.dataset.diffAutoload !== 'false') loadMarkdownDiff(root);
    });
    window.markonMarkdownDiff = {
        load: () => loadMarkdownDiff(),
        selectPath: (path?: string | null) => selectMarkdownPath(path),
        scrollToPath: (path: string) => {
            const root = document.querySelector<HTMLElement>('[data-markdown-diff]');
            if (root) getPage(root).scrollToPath(path);
        },
        topAnchor: () => {
            const root = document.querySelector<HTMLElement>('[data-markdown-diff]');
            return root ? getPage(root).topAnchor() : null;
        },
        anchorTo: (anchor) => {
            const root = document.querySelector<HTMLElement>('[data-markdown-diff]');
            if (root) getPage(root).anchorTo(anchor);
        },
    };
    let resizeTimer: number | null = null;
    window.addEventListener('resize', () => {
        if (resizeTimer !== null) window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => {
            document.querySelectorAll<HTMLElement>('[data-markdown-diff]').forEach((root) => getPage(root).syncLayout());
        }, 120);
    });
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}
