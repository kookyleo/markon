// Shared base for BOTH compare views (rendered AST + raw source). Owns the
// per-file <section> + sticky header + IntersectionObserver virtualization +
// collapse/"Viewed" + cross-mode scroll anchor + the changed-blocks/gap
// segmentation. Subclasses implement only `renderBlock` (and a few small hooks):
// the rendered view emits each block's HTML, the raw view emits its source lines.
//
// Both consume the same `MarkdownDiffData` payload and the same shared expansion
// store, so they show the same regions and stay aligned line-for-line.

import {
    createDiffFileHeader,
    loadCollapsedSet,
    persistCollapsedSet,
    loadViewedSet,
    persistViewedSet,
    viewedStorageKey,
    collapseStorageKey,
    loadShowViewed,
    VIEWED_CHANGED_EVENT,
    SHOW_VIEWED_EVENT,
    topFileInScroller,
    lineAtTop,
    scrollSectionToLine,
} from './diff-file-header';
import {
    type DiffAnchor,
    type MarkdownDiffData,
    type MarkdownDiffFile,
    type MarkdownDiffBlock,
    type ExpansionStore,
    createGap,
    expansionStore,
    isMarkdownDiffData,
    visibleBlockItems,
} from './diff-segments';
import { i18n } from './core/config';

export type { DiffAnchor };

const _t = (key: string, ...args: unknown[]): string => i18n.t(key, ...args);
const exportNotesLabel = (count: number): string => `${_t('web.export.label')} (${count})`;

interface SectionEntry {
    file: MarkdownDiffFile;
    section: HTMLElement;
    body: HTMLElement;
    rendered: boolean;
    estHeight: number;
}

const selectedPathFromLocation = (): string | null => {
    // The selected file is a URL hash anchor (#path), not a server-side filter.
    try {
        const h = window.location.hash;
        return h ? decodeURIComponent(h.slice(1)) || null : null;
    } catch {
        return null;
    }
};

// The diff is always rendered continuously (every changed file). The `?f=`
// param is no longer a server-side filter — it is a scroll target (deep-link /
// sidebar click). So the data URL is always fetched WITHOUT `f`: one full
// payload, shared by both views.
const fullDataUrl = (dataUrl: string): string => {
    try {
        const url = new URL(dataUrl, window.location.origin);
        url.searchParams.delete('f');
        return `${url.pathname}${url.search}${url.hash}`;
    } catch {
        return dataUrl;
    }
};

export abstract class DiffSectionView {
    readonly root: HTMLElement;

    #data: MarkdownDiffData | null = null;
    #files: MarkdownDiffFile[] = [];
    #selectedPath: string | null = null;
    #sections = new Map<string, SectionEntry>();
    #observer: IntersectionObserver | null = null;
    #cleanup: (() => void) | null = null;
    #collapsed = new Set<string>();
    #viewed = new Set<string>();
    /** Whether viewed files are shown (the sidebar "Viewed files" toggle). When
     *  false, viewed files' sections are hidden. */
    #showViewed = true;
    #anchor: DiffAnchor | null = null;
    #expansion: ExpansionStore | null = null;
    #events = new AbortController();
    protected scrollElement: HTMLElement | null = null;

    constructor(root: HTMLElement) {
        this.root = root;
        // The sidebar funnel's "Viewed files" toggle broadcasts here; hide/show
        // viewed files' sections to match.
        document.addEventListener(SHOW_VIEWED_EVENT, (e) => {
            const detail = (e as CustomEvent<{ showViewed?: unknown }>).detail;
            if (detail && typeof detail.showViewed === 'boolean') {
                this.#showViewed = detail.showViewed;
                this.#applyViewedVisibility();
            }
        }, { signal: this.#events.signal });
        document.addEventListener('markon:diff-annotations-ready', () => {
            this.#syncExportNotesButtons();
        }, { signal: this.#events.signal });
        document.addEventListener('markon:diff-notes-count-changed', () => {
            this.#syncExportNotesButtons();
        }, { signal: this.#events.signal });
        document.addEventListener(VIEWED_CHANGED_EVENT, (event) => {
            if (!this.root.isConnected) return;
            const detail = (event as CustomEvent<{
                viewed?: unknown; collapsed?: unknown; storageKey?: unknown;
            }>).detail;
            if (detail?.storageKey !== undefined && detail.storageKey !== viewedStorageKey(this.root.dataset['diffDataUrl'])) return;
            const paths = (value: unknown): Set<string> | null => Array.isArray(value)
                ? new Set(value.filter((path): path is string => typeof path === 'string'))
                : null;
            this.#syncProgressState(
                paths(detail?.viewed) ?? loadViewedSet(this.root.dataset['diffDataUrl'], this.#viewed),
                paths(detail?.collapsed) ?? loadCollapsedSet(this.root.dataset['diffDataUrl'], this.#collapsed),
            );
        }, { signal: this.#events.signal });
        window.addEventListener('storage', (event) => {
            if (!this.root.isConnected) return;
            const url = this.root.dataset['diffDataUrl'];
            const viewedKey = viewedStorageKey(url);
            const collapsedKey = collapseStorageKey(url);
            if (!viewedKey || (event.key !== null && event.key !== viewedKey && event.key !== collapsedKey)) return;
            this.#syncProgressState(loadViewedSet(url, this.#viewed), loadCollapsedSet(url, this.#collapsed));
            this.#emitProgressChanged();
        }, { signal: this.#events.signal });
    }

    // ── Hooks for subclasses ────────────────────────────────────────────────────
    /** CSS selector for the scroll container; null → the root element scrolls. */
    protected abstract get scrollSelector(): string | null;
    /** CSS selector for the content pane that holds the file sections; null →
     *  the root element itself is the pane. */
    protected abstract get paneSelector(): string | null;
    /** Class toggled on the pane while virtualized. */
    protected abstract get virtualizedClass(): string;
    /** Extra class on each file body (e.g. raw uses 'workspace-diff-body'). */
    protected get bodyClass(): string { return ''; }
    /** Render one diff block into a DOM element. THE per-view difference. */
    protected abstract renderBlock(file: MarkdownDiffFile, block: MarkdownDiffBlock, index: number): HTMLElement;
    /** Estimated rendered height of one block (placeholder sizing). */
    protected abstract estimateBlock(block: MarkdownDiffBlock): number;
    /** Optional lead content above a file's blocks (rendered view: diagnostics). */
    protected fileLead(_file: MarkdownDiffFile): Node | null { return null; }
    /** Called once per render with the loaded data (e.g. update engine status). */
    protected onRender(_data: MarkdownDiffData): void { /* no-op */ }
    /** Called at the start of building a fresh file set (reset per-file caches). */
    protected onFiles(_files: MarkdownDiffFile[]): void { /* no-op */ }
    /** Message shown when a file has no blocks to preview. */
    protected get emptyBlocksMessage(): string { return 'No content to preview.'; }
    /** Notify after content rendered (rendered view refreshes annotations). */
    protected afterContentRendered(): void { /* no-op */ }

    // ── Public API ──────────────────────────────────────────────────────────────
    async load(): Promise<void> {
        if (this.#events.signal.aborted) return;
        const url = this.root.dataset['diffDataUrl'] ? fullDataUrl(this.root.dataset['diffDataUrl']) : undefined;
        if (!url) return;
        if (this.#selectedPath === null) this.#selectedPath = selectedPathFromLocation();
        if (this.root.dataset['diffLoadedUrl'] === url) {
            this.#render();
            return;
        }
        if (this.root.dataset['diffLoadingUrl'] === url) return;
        this.root.dataset['diffLoadingUrl'] = url;
        try {
            const response = await fetch(url, { headers: { Accept: 'application/json' } });
            if (!response.ok) throw new Error(await response.text());
            const payload: unknown = await response.json();
            if (this.#events.signal.aborted) return;
            if (!isMarkdownDiffData(payload)) throw new Error('Invalid Markdown diff payload');
            this.#data = payload;
            this.root.dataset['diffLoadedUrl'] = url;
            this.#render();
        } catch (error) {
            if (this.#events.signal.aborted) return;
            delete this.root.dataset['diffLoadedUrl'];
            this.#setMessage(
                `Failed to load diff: ${error instanceof Error ? error.message : String(error)}`,
                true,
            );
        } finally {
            if (!this.#events.signal.aborted) delete this.root.dataset['diffLoadingUrl'];
        }
    }

    /** `?f=` / sidebar click: scroll to the file (no re-filter). */
    selectPath(path?: string | null): void {
        this.#selectedPath = path || null;
        if (this.#sections.size && this.#selectedPath) {
            this.scrollToPath(this.#selectedPath);
        } else if (!this.#data) {
            void this.load();
        }
    }

    scrollToPath(path: string): void {
        this.#sections.get(path)?.section.scrollIntoView({ block: 'start', behavior: 'instant' as ScrollBehavior });
    }

    /** The file + line currently at the top of the viewport, for cross-mode sync. */
    topAnchor(): DiffAnchor | null {
        const path = topFileInScroller(this.scrollElement);
        if (!path || !this.scrollElement) return null;
        const entry = this.#sections.get(path);
        return { path, line: entry ? lineAtTop(this.scrollElement, entry.section) : null };
    }

    /** Stage a content anchor to restore after the next render (view switch). */
    anchorTo(anchor: DiffAnchor | null): void {
        this.#anchor = anchor;
    }

    syncLayout(): void {
        // Native CSS sticky + IntersectionObserver handle resize automatically.
    }

    /** Release cross-view/storage subscriptions when the page replaces this view. */
    destroy(): void {
        this.#events.abort();
        this.#destroyVirtualizer();
        delete this.root.dataset['diffLoadedUrl'];
        delete this.root.dataset['diffLoadingUrl'];
    }

    // ── Render pipeline ─────────────────────────────────────────────────────────
    #render(): void {
        const data = this.#data;
        if (!data) return;
        this.onRender(data);
        if (!data.engine.enabled) {
            this.#setMessage(data.engine.message || 'Markdown engine is not enabled.', true);
            return;
        }
        if (!data.files.length) {
            this.#setMessage('No Markdown files changed in this diff.');
            return;
        }
        this.#renderFiles(data.files);
    }

    #contentPane(): HTMLElement | null {
        return this.paneSelector ? this.root.querySelector<HTMLElement>(this.paneSelector) : this.root;
    }

    #renderFiles(files: MarkdownDiffFile[]): void {
        const pane = this.#contentPane();
        if (!pane) return;
        this.#destroyVirtualizer();
        this.onFiles(files);
        pane.textContent = '';
        pane.classList.add(this.virtualizedClass);

        this.#files = files;
        this.#collapsed = loadCollapsedSet(this.root.dataset['diffDataUrl'], this.#collapsed);
        this.#viewed = loadViewedSet(this.root.dataset['diffDataUrl'], this.#viewed);
        this.#showViewed = loadShowViewed(this.root.dataset['diffDataUrl']);
        this.#expansion = expansionStore(this.root.dataset['diffDataUrl']);
        this.#sections = new Map();

        const scrollElement = (this.scrollSelector
            ? this.root.querySelector<HTMLElement>(this.scrollSelector)
            : this.root) || this.root;
        this.scrollElement = scrollElement;

        const fragment = document.createDocumentFragment();
        for (const file of files) {
            const entry = this.#buildSection(file);
            this.#sections.set(file.path, entry);
            fragment.appendChild(entry.section);
        }
        pane.appendChild(fragment);
        this.#applyViewedVisibility();
        scrollElement.scrollTo({ top: 0, left: 0, behavior: 'instant' });

        if (typeof IntersectionObserver !== 'undefined') {
            const observer = new IntersectionObserver(
                (records) => {
                    for (const record of records) {
                        const path = (record.target as HTMLElement).dataset['filePath'];
                        const entry = path ? this.#sections.get(path) : undefined;
                        if (!entry) continue;
                        if (record.isIntersecting) this.#renderBody(entry);
                        else this.#derenderBody(entry);
                    }
                },
                // Both views scroll inside an overflow-auto element (the rendered
                // panel, or the raw view's own root) — observe against it.
                { root: scrollElement, rootMargin: '1200px 0px' },
            );
            this.#observer = observer;
            for (const entry of this.#sections.values()) observer.observe(entry.section);
        } else {
            for (const entry of this.#sections.values()) this.#renderBody(entry);
        }

        this.#cleanup = () => {
            this.#observer?.disconnect();
            this.#observer = null;
        };

        // Restore the content position carried over from the other view, if any;
        // otherwise honour an initial `?f=` deep-link by scrolling to that file.
        if (this.#anchor) {
            const anchor = this.#anchor;
            this.#anchor = null;
            const target = this.#sections.get(anchor.path);
            if (target) {
                for (const entry of this.#sections.values()) {
                    this.#renderBody(entry);
                    if (entry === target) break;
                }
                scrollSectionToLine(scrollElement, target.section, anchor.line);
            }
        } else if (this.#selectedPath) {
            this.#sections.get(this.#selectedPath)?.section.scrollIntoView({ block: 'start', behavior: 'instant' as ScrollBehavior });
        }
        this.afterContentRendered();
    }

    #buildSection(file: MarkdownDiffFile): SectionEntry {
        const section = document.createElement('section');
        section.className = 'md-diff-file-section';
        section.dataset['filePath'] = file.path;
        // The real per-file annotation key (canonical absolute path of the new
        // side). Present only for worktree diffs where the new side is a live
        // file; `diff-new-side-filter.sectionForNode` keys off this attribute, so
        // a section without it is simply not annotatable (commit…commit diffs).
        if (file.abs_path) section.dataset['absPath'] = file.abs_path;
        // A pure rename (no content change) is just a one-line fold; flag it so the
        // big inter-file gap collapses around it (otherwise the short body looks
        // wildly unbalanced — tiny above the fold, the 108px gap below).
        if (file.status === 'renamed' && !(file.additions || 0) && !(file.deletions || 0)) {
            section.classList.add('is-pure-rename');
        }
        const collapsed = this.#collapsed.has(file.path);
        section.classList.toggle('is-collapsed', collapsed);

        const body = document.createElement('div');
        body.className = `md-diff-file-body${this.bodyClass ? ` ${this.bodyClass}` : ''}`;

        const entry: SectionEntry = { file, section, body, rendered: false, estHeight: this.#estimateBodyHeight(file) };
        section.append(this.#createFileHeader(file), body);
        if (!collapsed) body.style.minHeight = `${entry.estHeight}px`;
        return entry;
    }

    #createFileHeader(file: MarkdownDiffFile): HTMLElement {
        const opts = {
            path: file.path,
            status: file.status,
            additions: file.additions || 0,
            deletions: file.deletions || 0,
            collapsed: this.#collapsed.has(file.path),
            viewed: this.#viewed.has(file.path),
            onToggleCollapse: () => this.#toggleCollapsed(file.path),
            onToggleViewed: (viewed: boolean) => this.#setViewed(file.path, viewed),
            onDeleted: () => {
                const entry = this.#sections.get(file.path);
                entry?.section.remove();
                this.#sections.delete(file.path);
                this.#files = this.#files.filter((f) => f.path !== file.path);
            },
        };
        return createDiffFileHeader(file.old_path === undefined ? opts : { ...opts, oldPath: file.old_path });
    }

    #blockAt(file: MarkdownDiffFile, index: number): MarkdownDiffBlock {
        const block = file.blocks[index];
        if (!block) throw new RangeError(`Diff block index ${index} is outside ${file.path}`);
        return block;
    }

    #renderBody(entry: SectionEntry): void {
        if (entry.rendered || this.#collapsed.has(entry.file.path)) return;
        const file = entry.file;
        const fragment = document.createDocumentFragment();
        const lead = this.fileLead(file);
        if (lead) fragment.appendChild(lead);
        if (!file.blocks.length) {
            fragment.appendChild(this.#message(this.emptyBlocksMessage));
        } else {
            const expanded = this.#expansion;
            for (const item of visibleBlockItems(file.blocks)) {
                if (item.kind === 'block') {
                    fragment.appendChild(this.renderBlock(file, item.block, item.index));
                } else if (expanded?.has(file.path, item.start)) {
                    for (let i = item.start; i < item.start + item.count; i += 1) {
                        fragment.appendChild(this.renderBlock(file, this.#blockAt(file, i), i));
                    }
                } else {
                    fragment.appendChild(this.#createGap(file, item.start, item.count));
                }
            }
        }
        entry.body.replaceChildren(fragment);
        entry.body.style.minHeight = '';
        entry.body.style.height = '';
        entry.rendered = true;
        this.afterBodyRendered(entry.body);
    }

    /** Hook: the section body is now in the DOM and laid out (overlays that need
     *  measured geometry, e.g. the structural-diff guide rails, draw here). */
    protected afterBodyRendered(_body: HTMLElement): void { /* no-op */ }

    #createGap(file: MarkdownDiffFile, start: number, count: number): HTMLElement {
        // A pure rename (renamed, byte-identical) has no changed blocks, so its
        // whole body is this single fold. Fold the "renamed, no content changes"
        // meaning into the fold-line text so it's self-explanatory.
        const pureRename =
            file.status === 'renamed' && !(file.additions || 0) && !(file.deletions || 0);
        const gapOpts = pureRename
            ? { note: 'This file was only renamed or moved — its content is unchanged.', standalone: true }
            : undefined;
        return createGap(count, (gap) => {
            // Remember the expansion so it survives re-renders / view switches.
            this.#expansion?.add(file.path, start);
            const host = gap.parentElement ?? this.root;

            const blocks = document.createDocumentFragment();
            for (let i = start; i < start + count; i += 1) {
                blocks.appendChild(this.renderBlock(file, this.#blockAt(file, i), i));
            }

            const scrollEl = this.scrollElement;
            // Expand UPWARD anchored to the 下文 (the content just below the gap):
            // it must not move. We open the space and re-pin it in ONE synchronous
            // step (no per-frame scrolling — that was the jank), then only the
            // content animates.
            const anchorEl = gap.nextElementSibling;
            const targetTop = anchorEl ? anchorEl.getBoundingClientRect().top : null;
            const pin = () => {
                if (scrollEl && anchorEl && targetTop !== null) {
                    scrollEl.scrollTop += anchorEl.getBoundingClientRect().top - targetTop;
                }
            };

            const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
            if (reduce || typeof requestAnimationFrame !== 'function') {
                gap.replaceWith(blocks);
                pin();
                this.afterBodyRendered(host);
                return;
            }

            // The browser's own scroll-anchoring pins the viewport TOP (the 前文),
            // the opposite of what we want; suspend it for the one frame in which we
            // insert + re-pin, so it can't undo our pin. (Re-enabled next frame; the
            // fade that follows is opacity/transform only and never shifts layout.)
            if (scrollEl) scrollEl.style.overflowAnchor = 'none';

            const reveal = document.createElement('div');
            reveal.className = 'md-diff-reveal';
            reveal.appendChild(blocks); // inserted at full height immediately
            gap.replaceWith(reveal);
            pin(); // 下文 snapped back to exactly where it was — no visible move

            let settled = false;
            const settle = () => {
                if (settled) return;
                settled = true;
                const out = document.createDocumentFragment();
                while (reveal.firstChild) out.appendChild(reveal.firstChild);
                reveal.replaceWith(out); // margin-neutral wrapper → unwraps with no jump
                pin();
                this.afterBodyRendered(host);
            };
            reveal.addEventListener('transitionend', (e) => {
                if (e.propertyName === 'opacity') settle();
            });
            window.setTimeout(settle, 700); // safety net

            requestAnimationFrame(() => {
                if (scrollEl) scrollEl.style.overflowAnchor = '';
                reveal.classList.add('is-open'); // fade + settle the content in
            });
        }, gapOpts);
    }

    #derenderBody(entry: SectionEntry): void {
        if (!entry.rendered || this.#collapsed.has(entry.file.path)) return;
        const measured = entry.body.offsetHeight;
        entry.body.replaceChildren();
        entry.body.style.minHeight = `${measured || entry.estHeight}px`;
        entry.rendered = false;
    }

    #estimateBodyHeight(file: MarkdownDiffFile): number {
        let total = file.diagnostics.length ? 40 : 0;
        if (!file.blocks.length) return total + 58;
        const expanded = this.#expansion;
        for (const item of visibleBlockItems(file.blocks)) {
            if (item.kind === 'block') {
                total += this.estimateBlock(item.block);
            } else if (expanded?.has(file.path, item.start)) {
                for (let i = item.start; i < item.start + item.count; i += 1) total += this.estimateBlock(this.#blockAt(file, i));
            } else {
                total += 30;
            }
        }
        return total;
    }

    #toggleCollapsed(path: string): void {
        const entry = this.#sections.get(path);
        const collapse = entry ? !entry.section.classList.contains('is-collapsed') : !this.#collapsed.has(path);
        this.#setCollapsed(path, collapse);
    }

    #setCollapsed(path: string, collapse: boolean): void {
        // Another loaded mode/tab may have changed a different file. Merge
        // only this file's intent into the latest persisted fold set.
        this.#collapsed = loadCollapsedSet(this.root.dataset['diffDataUrl'], this.#collapsed);
        if (collapse) this.#collapsed.add(path);
        else this.#collapsed.delete(path);
        persistCollapsedSet(this.root.dataset['diffDataUrl'], this.#collapsed);
        const entry = this.#sections.get(path);
        if (entry) this.#applyCollapsedState(entry, collapse);
    }

    #applyCollapsedState(entry: SectionEntry, collapse: boolean): void {
        const scrollEl = this.scrollElement;
        const beforeTop = entry.section.getBoundingClientRect().top;
        entry.section.classList.toggle('is-collapsed', collapse);
        entry.section.firstElementChild?.replaceWith(this.#createFileHeader(entry.file));
        if (collapse) {
            entry.body.replaceChildren();
            entry.body.style.minHeight = '';
            entry.body.style.height = '';
            entry.rendered = false;
        } else {
            entry.body.style.minHeight = `${entry.estHeight}px`;
            this.#renderBody(entry);
        }
        if (scrollEl) {
            const afterTop = entry.section.getBoundingClientRect().top;
            scrollEl.scrollTop += afterTop - beforeTop;
        }
    }

    /** Marking progress folds this file; unmarking expands it. The checkbox's
     * explicit checked intent must not be inverted against a stale view copy. */
    #setViewed(path: string, viewed: boolean): void {
        this.#viewed = loadViewedSet(this.root.dataset['diffDataUrl'], this.#viewed);
        if (viewed) this.#viewed.add(path);
        else this.#viewed.delete(path);
        persistViewedSet(this.root.dataset['diffDataUrl'], this.#viewed);
        this.#setCollapsed(path, viewed);
        this.#applyViewedVisibility();
        this.#emitProgressChanged();
    }

    #emitProgressChanged(): void {
        document.dispatchEvent(new CustomEvent(VIEWED_CHANGED_EVENT, {
            detail: {
                viewed: [...this.#viewed],
                collapsed: [...this.#collapsed],
                storageKey: viewedStorageKey(this.root.dataset['diffDataUrl']),
            },
        }));
    }

    /** Synchronize another mode/tab without persisting again or rebuilding an
     * unchanged header. This keeps native label activation a single action. */
    #syncProgressState(viewed: Set<string>, collapsed: Set<string>): void {
        this.#viewed = viewed;
        this.#collapsed = collapsed;
        for (const [path, entry] of this.#sections) {
            const folded = collapsed.has(path);
            if (entry.section.classList.contains('is-collapsed') !== folded) {
                this.#applyCollapsedState(entry, folded);
            } else {
                const checkbox = entry.section.querySelector<HTMLInputElement>('.md-diff-file-check input');
                if (checkbox) checkbox.checked = viewed.has(path);
                const label = entry.section.querySelector<HTMLElement>('.md-diff-file-check');
                if (label) label.title = _t(viewed.has(path) ? 'web.diff.progress.unmark.tip' : 'web.diff.progress.tip');
            }
        }
        this.#applyViewedVisibility();
    }

    /** Hide sections for viewed files while the "Viewed files" filter is off.
     *  When that hides everything (all changed files are viewed), show a centered
     *  "all done" state with a link to restore the Viewed-files display. */
    #applyViewedVisibility(): void {
        let anyVisible = false;
        for (const [path, entry] of this.#sections) {
            const hidden = !this.#showViewed && this.#viewed.has(path);
            entry.section.hidden = hidden;
            if (!hidden) anyVisible = true;
        }
        const allViewed = this.#sections.size > 0 && [...this.#sections.keys()].every(path => this.#viewed.has(path));
        const pane = this.#contentPane();
        if (!pane) return;
        if (!this.#showViewed && this.#sections.size > 0 && !anyVisible) {
            pane.querySelector('.md-diff-viewed-done')?.remove();
            this.#showViewedCompletion('empty');
        } else {
            pane.querySelector('.md-diff-viewed-empty')?.remove();
            if (this.#showViewed && allViewed) this.#showViewedCompletion('done');
            else pane.querySelector('.md-diff-viewed-done')?.remove();
        }
    }

    #showViewedCompletion(kind: 'empty' | 'done'): void {
        const pane = this.#contentPane();
        const className = kind === 'empty' ? 'md-diff-viewed-empty' : 'md-diff-viewed-done';
        if (!pane) return;
        const existing = pane.querySelector<HTMLElement>(`.${className}`);
        if (existing) {
            this.#syncExportNotesButtons();
            return;
        }
        const el = document.createElement('div');
        el.className = className;
        el.innerHTML = '<div class="md-diff-viewed-empty-emoji">🎉</div>';
        const title = document.createElement('div');
        title.className = 'md-diff-viewed-empty-title';
        title.textContent = _t('web.diff.progress.complete');
        el.appendChild(title);
        const actions = document.createElement('div');
        actions.className = 'md-diff-viewed-empty-actions';
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'md-diff-viewed-empty-link';
        link.textContent = _t(kind === 'empty' ? 'web.diff.progress.show_all' : 'web.diff.progress.hide');
        link.addEventListener('click', () => {
            // The funnel checkbox is phrased as the inverse of showViewed:
            // checked = hide viewed, unchecked = show viewed.
            const cb = document.querySelector<HTMLInputElement>('[data-diff-show-viewed]');
            if (cb) {
                cb.checked = kind === 'done';
                cb.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });
        const exportLink = document.createElement('button');
        exportLink.type = 'button';
        exportLink.className = 'md-diff-viewed-empty-link md-diff-viewed-export-notes';
        exportLink.textContent = exportNotesLabel(0);
        exportLink.addEventListener('click', () => {
            if (exportLink.disabled || exportLink.getAttribute('aria-disabled') === 'true') return;
            const exporter = window.markonDiffAnnotations?.exportNotes;
            if (exporter) void exporter(exportLink);
        });
        actions.append(link, exportLink);
        el.appendChild(actions);
        pane.appendChild(el);
        void this.#syncExportNotesButton(exportLink);
    }

    #syncExportNotesButtons(): void {
        this.root
            .querySelectorAll<HTMLButtonElement>('.md-diff-viewed-export-notes')
            .forEach(button => {
                void this.#syncExportNotesButton(button);
            });
    }

    async #syncExportNotesButton(button: HTMLButtonElement): Promise<void> {
        const count = Math.max(0, await (window.markonDiffAnnotations?.notesCount?.() ?? Promise.resolve(0)));
        if (!button.isConnected) return;
        button.textContent = exportNotesLabel(count);
        const disabled = count === 0;
        button.disabled = disabled;
        button.classList.toggle('is-disabled', disabled);
        button.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    }

    #destroyVirtualizer(): void {
        this.#cleanup?.();
        this.#cleanup = null;
        this.#observer?.disconnect();
        this.#observer = null;
        this.#sections = new Map();
        this.scrollElement = null;
    }

    #message(message: string, isError = false): HTMLElement {
        const element = document.createElement('div');
        element.className = 'md-diff-empty';
        if (isError) element.style.color = 'var(--markon-danger)';
        element.textContent = message;
        return element;
    }

    #setMessage(message: string, isError = false): void {
        this.#destroyVirtualizer();
        const pane = this.#contentPane();
        if (!pane) return;
        pane.classList.remove(this.virtualizedClass);
        pane.textContent = '';
        pane.appendChild(this.#message(message, isError));
    }

    protected text(selector: string, value: string): void {
        const element = this.root.querySelector<HTMLElement>(selector);
        if (element) element.textContent = value;
    }
}
