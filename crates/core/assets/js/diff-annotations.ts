/**
 * diff-annotations.ts — annotation coordinator for the rendered compare diff.
 *
 * The compare page does NOT boot MarkonApp (no single markdown body, no single
 * file path). Instead this lightweight coordinator runs ONE selection toolbar
 * over the whole rendered pane and fans every action out to a PER-FILE context,
 * keyed by the file's real canonical absolute path (`section.dataset['absPath']`).
 * That key is byte-identical to the normal file view's annotation key, so a
 * highlight made here lands in the same `localStorage` bucket as opening the
 * file directly — annotations are shared between the two surfaces.
 *
 * Scope (per the agreed design): LOCAL storage only — no shared/WebSocket sync
 * on this page. Activated on rendered diffs whose file sections carry a
 * canonical `data-abs-path`; only the NEW side is annotatable —
 * `NEW_SIDE_REJECT` keeps the old/deleted text out of selection, anchoring,
 * and wrapping.
 */

import { CONFIG } from './core/config';
import { copyText } from './core/clipboard';
import { StorageManager } from './managers/storage-manager';
import { AnnotationManager, type Annotation } from './managers/annotation-manager';
import { EditorManager } from './managers/editor-manager';
import { NoteManager } from './managers/note-manager';
import { PopoverManager, type PopoverActionPayload } from './managers/popover-manager';
import { ModalManager, showConfirmDialog } from './components/modal';
import { NEW_SIDE_REJECT, newSideRootFor, sectionForNode } from './diff-new-side-filter';

const PANE_SELECTOR = '[data-md-diff-content]';

const hasNote = (annotation: Annotation): boolean => !!annotation.note && annotation.note.trim() !== '';

const markdownFileHeading = (path: string): string => {
    const text = path.replace(/\r?\n/g, ' ').trim() || 'Untitled file';
    return `# ${text}`;
};

/** Per-file annotation state. One per changed file (keyed by absolute path). */
interface PerFileContext {
    absPath: string;
    storage: StorageManager;
    annotationManager: AnnotationManager;
    noteManager: NoteManager;
    /** Resolves once this file's annotations are loaded from storage. */
    ready: Promise<void>;
}

class DiffAnnotationCoordinator {
    #pane: HTMLElement;
    #popover: PopoverManager;
    #contexts = new Map<string, PerFileContext>();
    #editor: EditorManager | null = null;

    constructor(pane: HTMLElement) {
        this.#pane = pane;
        this.#popover = new PopoverManager(pane, {
            enableEdit: false,
            enableChat: false,
            enableNote: true,
            reject: NEW_SIDE_REJECT,
        });
        this.#popover.onAction((action, data) => {
            void this.#handleAction(action, data);
        });
        this.#wireEvents();
    }

    // ── Render hooks (called from MarkdownDiffPage) ─────────────────────────────
    /** A file body was (re)built — re-anchor that file's annotations onto it. */
    onBodyRendered(body: HTMLElement): void {
        const section = body.closest<HTMLElement>('.md-diff-file-section[data-abs-path]');
        const absPath = section?.dataset['absPath'];
        if (!section || !absPath) return;
        const ctx = this.#contextFor(absPath, section);
        const root = newSideRootFor(section);
        void ctx.ready.then(() => {
            // The body may have been derendered/replaced again while we awaited
            // the (already-resolved) load; bail if this exact node is gone.
            if (!root.isConnected) return;
            ctx.annotationManager.setRoot(root);
            ctx.noteManager.setMarkdownBody(root);
            ctx.annotationManager.applyToDOM();
            ctx.noteManager.render();
        });
    }

    /** The full file set finished (re)rendering. */
    onContentRendered(): void {
        // Per-body re-anchoring already ran; just drop any stale note popup left
        // over from a previous render/view.
        document.querySelector('.note-popup')?.remove();
    }

    /** Export notes from every changed file, grouped under top-level file headings. */
    async exportNotes(_anchor?: HTMLElement | null): Promise<boolean> {
        const files = await this.#collectFileNotes();
        if (!files.length) return false;

        const markdown = files
            .map(file => `${markdownFileHeading(file.path)}\n\n${file.markdown.trimEnd()}`)
            .join('\n\n') + '\n';

        if (!this.#editor) {
            this.#editor = new EditorManager(window.location.pathname || 'notes');
        }
        await this.#editor.open({
            mode: 'export',
            content: markdown,
            exportFileName: 'notes',
        });
        return true;
    }

    async notesCount(): Promise<number> {
        const files = await this.#collectFileNotes();
        return files.reduce((sum, file) => sum + file.count, 0);
    }

    // ── Per-file context ────────────────────────────────────────────────────────
    #contextFor(absPath: string, section: HTMLElement): PerFileContext {
        let ctx = this.#contexts.get(absPath);
        if (ctx) return ctx;
        const storage = new StorageManager(absPath, false, null);
        const root = newSideRootFor(section);
        const annotationManager = new AnnotationManager(storage, root, NEW_SIDE_REJECT);
        const noteManager = new NoteManager(annotationManager, root, { marginCards: false });
        ctx = { absPath, storage, annotationManager, noteManager, ready: annotationManager.load() };
        this.#contexts.set(absPath, ctx);
        return ctx;
    }

    async #collectFileNotes(): Promise<{ path: string; markdown: string; count: number }[]> {
        const sections = [...this.#pane.querySelectorAll<HTMLElement>('.md-diff-file-section[data-abs-path]')];
        const files: { path: string; markdown: string; count: number }[] = [];
        for (const section of sections) {
            const absPath = section.dataset['absPath'];
            if (!absPath) continue;
            const ctx = this.#contextFor(absPath, section);
            await ctx.ready;
            const noteIds = ctx.annotationManager.getAll().filter(hasNote).map(a => a.id);
            if (!noteIds.length) continue;
            const markdown = ctx.annotationManager.formatAsMarkdown({ ids: noteIds });
            if (markdown.trim()) {
                files.push({
                    path: section.dataset['filePath'] || absPath,
                    markdown,
                    count: noteIds.length,
                });
            }
        }
        return files;
    }

    /** Find the context owning an annotation id (popup actions carry only the id). */
    #contextForAnnotationId(id: string): PerFileContext | null {
        for (const ctx of this.#contexts.values()) {
            if (ctx.annotationManager.getById(id)) return ctx;
        }
        return null;
    }

    /** Resolve the per-file context a node lives in (new-side only). */
    #contextForNode(node: Node | null): { ctx: PerFileContext; section: HTMLElement } | null {
        if (!node) return null;
        const section = sectionForNode(node);
        const absPath = section?.dataset['absPath'];
        if (!section || !absPath) return null;
        return { ctx: this.#contextFor(absPath, section), section };
    }

    // ── Actions ───────────────────────────────────────────────────────────────
    async #handleAction(action: string, data: PopoverActionPayload): Promise<void> {
        const { selection, highlightedElement } = data;

        if (action === 'unhighlight') {
            const el = highlightedElement instanceof HTMLElement ? highlightedElement : null;
            const id = el?.dataset['annotationId'];
            const resolved = el ? this.#contextForNode(el) : null;
            if (id && resolved) {
                await resolved.ctx.annotationManager.delete(id);
                resolved.ctx.annotationManager.removeFromDOM(id);
                resolved.ctx.noteManager.render();
                this.#emitNotesChanged();
            }
            window.getSelection()?.removeAllRanges();
            return;
        }

        if (!selection) return;
        const resolved = this.#contextForNode(selection.startContainer);
        if (!resolved) return;
        const { ctx, section } = resolved;

        if (action.startsWith('highlight-') || action === 'strikethrough') {
            const tagName =
                action === 'strikethrough' ? CONFIG.HTML_TAGS.STRIKETHROUGH : CONFIG.HTML_TAGS.HIGHLIGHT;
            const anno = ctx.annotationManager.createAnnotation(
                selection,
                action as Annotation['type'],
                tagName as Annotation['tagName'],
            );
            await this.#applyAdd(ctx, section, anno);
            window.getSelection()?.removeAllRanges();
            return;
        }

        if (action === 'add-note') {
            // Modal stays open until the user confirms; selection is dropped then.
            this.#showNoteInputModal(ctx, section, selection);
            return;
        }
    }

    /** Persist a new annotation and wrap it onto the (current) new-side body. */
    async #applyAdd(ctx: PerFileContext, section: HTMLElement, anno: Annotation): Promise<void> {
        await ctx.annotationManager.add(anno);
        ctx.annotationManager.setRoot(newSideRootFor(section));
        ctx.annotationManager.applyToDOM([anno]);
        ctx.noteManager.setMarkdownBody(newSideRootFor(section));
        ctx.noteManager.render();
        this.#emitNotesChanged();
    }

    #showNoteInputModal(
        ctx: PerFileContext,
        section: HTMLElement,
        selection: Range,
        existing: Annotation | null = null,
    ): void {
        const rect = selection.getBoundingClientRect();
        const anchorElement = { getBoundingClientRect: () => rect } as unknown as HTMLElement;
        ModalManager.showNoteInput({
            anchorElement,
            initialValue: existing ? existing.note ?? '' : '',
            onSave: (noteText: string) => {
                void (async () => {
                    if (noteText) {
                        if (existing) {
                            existing.note = noteText;
                            await ctx.annotationManager.add(existing);
                            ctx.annotationManager.removeFromDOM(existing.id);
                            ctx.annotationManager.setRoot(newSideRootFor(section));
                            ctx.annotationManager.applyToDOM([existing]);
                            ctx.noteManager.setMarkdownBody(newSideRootFor(section));
                            ctx.noteManager.render();
                            this.#emitNotesChanged();
                        } else {
                            const anno = ctx.annotationManager.createAnnotation(
                                selection,
                                CONFIG.ANNOTATION_TYPES.HAS_NOTE as Annotation['type'],
                                CONFIG.HTML_TAGS.HIGHLIGHT as Annotation['tagName'],
                                noteText,
                            );
                            await this.#applyAdd(ctx, section, anno);
                        }
                    } else if (existing) {
                        await ctx.annotationManager.delete(existing.id);
                        ctx.annotationManager.removeFromDOM(existing.id);
                        ctx.noteManager.render();
                        this.#emitNotesChanged();
                    }
                    window.getSelection()?.removeAllRanges();
                })();
            },
            onCancel: () => {
                window.getSelection()?.removeAllRanges();
            },
        });
    }

    // ── Document events ─────────────────────────────────────────────────────────
    #wireEvents(): void {
        document.addEventListener('mouseup', (e) => this.#popover.handleSelection(e));
        document.addEventListener('touchend', (e) => this.#popover.handleSelection(e));

        // Click on a highlight → its action toolbar; click on a note → its popup.
        document.addEventListener('click', (e) => {
            void this.#handleClick(e);
        });

        // Outside-click hides the toolbar and any open note popup.
        const hideOnOutside = (e: Event): void => {
            const target = e.target as Element | null;
            if (
                target?.closest('.selection-popover') ||
                target?.closest('.note-input-modal') ||
                target?.closest('.note-popup') ||
                target?.closest('.confirm-dialog')
            ) {
                return;
            }
            if (this.#popover.isVisible()) {
                this.#popover.hide();
                window.getSelection()?.removeAllRanges();
            }
        };
        document.addEventListener('mousedown', hideOnOutside);
        document.addEventListener('touchstart', hideOnOutside, { passive: true });
    }

    async #handleClick(e: MouseEvent): Promise<void> {
        const target = e.target as HTMLElement | null;
        if (!target) return;

        // Note popup action buttons (carry data-annotation-id).
        const copyBtn = target.closest<HTMLElement>('.note-copy');
        const editBtn = target.closest<HTMLElement>('.note-edit');
        const deleteBtn = target.closest<HTMLElement>('.note-delete');

        if (copyBtn) {
            const id = copyBtn.dataset['annotationId'];
            const ctx = id ? this.#contextForAnnotationId(id) : null;
            const anno = id && ctx ? ctx.annotationManager.getById(id) : null;
            if (anno && ctx) await copyText(ctx.annotationManager.formatAnnotation(anno));
            e.stopPropagation();
            return;
        }

        if (editBtn) {
            const id = editBtn.dataset['annotationId'];
            const ctx = id ? this.#contextForAnnotationId(id) : null;
            const anno = id && ctx ? ctx.annotationManager.getById(id) : null;
            if (id && ctx && anno) {
                document.querySelector('.note-popup')?.remove();
                const el = this.#pane.querySelector<HTMLElement>(`[data-annotation-id="${id}"]`);
                const section = el ? el.closest<HTMLElement>('.md-diff-file-section[data-abs-path]') : null;
                if (el && section) {
                    const range = document.createRange();
                    range.selectNodeContents(el);
                    this.#showNoteInputModal(ctx, section, range, anno);
                }
            }
            e.stopPropagation();
            return;
        }

        if (deleteBtn) {
            const id = deleteBtn.dataset['annotationId'];
            const ctx = id ? this.#contextForAnnotationId(id) : null;
            if (id && ctx) {
                showConfirmDialog(
                    'Delete this note?',
                    async () => {
                        await ctx.annotationManager.delete(id);
                        ctx.annotationManager.removeFromDOM(id);
                        ctx.noteManager.render();
                        document.querySelector('.note-popup')?.remove();
                        this.#emitNotesChanged();
                    },
                    deleteBtn,
                    'Delete',
                );
            }
            e.stopPropagation();
            return;
        }

        // Click on a note highlight → open its popup.
        const noteEl = target.closest<HTMLElement>('.has-note');
        if (noteEl) {
            const id = noteEl.dataset['annotationId'];
            const ctx = id ? this.#contextForAnnotationId(id) : null;
            if (id && ctx) {
                ctx.noteManager.showNotePopup(noteEl, id);
                e.stopPropagation();
            }
            return;
        }

        // Click on a colour highlight / strikethrough → its action toolbar.
        const highlight = target.closest<HTMLElement>(CONFIG.SELECTORS.HIGHLIGHT_CLASSES);
        if (highlight) this.#popover.handleHighlightClick(highlight);
    }

    #emitNotesChanged(): void {
        document.dispatchEvent(new CustomEvent('markon:diff-notes-count-changed'));
    }
}

const init = (): void => {
    const pane = document.querySelector<HTMLElement>(PANE_SELECTOR);
    if (!pane) return;
    const coordinator = new DiffAnnotationCoordinator(pane);
    window.markonDiffAnnotations = {
        onBodyRendered: (body) => coordinator.onBodyRendered(body),
        onContentRendered: () => coordinator.onContentRendered(),
        exportNotes: (anchor) => coordinator.exportNotes(anchor),
        notesCount: () => coordinator.notesCount(),
    };
    document.dispatchEvent(new CustomEvent('markon:diff-annotations-ready'));
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}
