/**
 * MarkonApp - Main application class.
 *
 * Wires every manager / navigator / component together, owns the document-
 * level event listeners and the reload-on-config WebSocket. ESM module —
 * loaded via `<script type="module">` from layout.html.
 */

import { CONFIG, i18n } from './core/config';
import { Logger } from './core/utils';
import { copyText, flashBeside, flashCopied } from './core/clipboard';
import { Meta } from './services/dom';
import { Position } from './services/position';
import { Text } from './services/text';
import { StorageManager } from './managers/storage-manager';
import { WebSocketManager } from './managers/websocket-manager';
import { AnnotationManager, type Annotation } from './managers/annotation-manager';
import { NoteManager } from './managers/note-manager';
import { PopoverManager, type PopoverActionPayload } from './managers/popover-manager';
import { UndoManager, type UndoOperation } from './managers/undo-manager';
import { KeyboardShortcutsManager } from './managers/keyboard-shortcuts';
import { WorkspaceSpotlight } from './components/workspace-spotlight';
import { HighlightManager } from './managers/highlight-manager';
import { EditorManager } from './managers/editor-manager';
import { ExportManager } from './managers/export-manager';
import { CollaborationManager } from './managers/collaboration-manager';
import { ChatManager } from './managers/chat-manager';
import { VisualZoomManager } from './managers/visual-zoom-manager';
import { TOCNavigator } from './navigators/toc-navigator';
import { AnnotationNavigator } from './navigators/annotation-navigator';
import { ModalManager, showConfirmDialog } from './components/modal';
import { FloatingLayer } from './components/floating-layer';

const INTERACTIVE_MARKDOWN_BODY_SELECTOR = '[data-markon-interactive-body]';

// ── Public types ───────────────────────────────────────────────────────────

/** Constructor input bag for {@link MarkonApp}. */
export interface MarkonAppConfig {
    filePath?: string;
    isSharedMode?: boolean;
    enableSearch?: boolean;
    enableEdit?: boolean;
    enableLive?: boolean;
}

/** Snapshot of all wired managers. Used for debug + window globals. */
export interface ManagerSnapshot {
    storage: StorageManager | null;
    wsManager: WebSocketManager | null;
    annotationManager: AnnotationManager | null;
    noteManager: NoteManager | null;
    popoverManager: PopoverManager | null;
    visualZoomManager: VisualZoomManager | null;
    undoManager: UndoManager | null;
    shortcutsManager: KeyboardShortcutsManager | null;
    workspaceSpotlight: WorkspaceSpotlight | null;
    tocNavigator: TOCNavigator | null;
    annotationNavigator: AnnotationNavigator | null;
}

/**
 * Markon main application.
 */
export class MarkonApp {
    // Manager instances. Optional fields are gated by Meta flags.
    #storage: StorageManager | null = null;
    #wsManager: WebSocketManager | null = null;
    #annotationManager: AnnotationManager | null = null;
    #noteManager: NoteManager | null = null;
    #popoverManager: PopoverManager | null = null;
    #visualZoomManager: VisualZoomManager | null = null;
    #undoManager: UndoManager | null = null;
    #shortcutsManager: KeyboardShortcutsManager | null = null;
    #workspaceSpotlight: WorkspaceSpotlight | null = null;
    #editorManager: EditorManager | null = null;
    #exportManager: ExportManager | null = null;
    #collaboration: CollaborationManager | null = null;
    #tocNavigator: TOCNavigator | null = null;
    #annotationNavigator: AnnotationNavigator | null = null;

    // DOM elements / config
    #markdownBody: HTMLElement | null;
    #filePath: string;
    #isSharedMode: boolean;
    #enableSearch: boolean;
    #enableEdit: boolean;
    #enableLive: boolean;

    // Public mirrors so peers (CollaborationManager, etc.) can read flags.
    /** Public mirror of `enableLive` so {@link CollaborationManager} can read it. */
    enableLive: boolean;
    /** Public alias for the WebSocket manager (set after `connect()`). */
    ws: WebSocketManager | null = null;

    // Scroll control
    #scrollAnimationId: number | null = null;
    #scrollCancelled = false;

    constructor(config: MarkonAppConfig = {}) {
        this.#filePath = config.filePath || this.#getFilePathFromMeta();
        this.#isSharedMode = config.isSharedMode || false;
        this.#enableSearch = config.enableSearch || false;
        this.#enableEdit = config.enableEdit || false;
        this.#enableLive = config.enableLive || false;
        this.enableLive = this.#enableLive;
        this.#markdownBody = document.querySelector<HTMLElement>(INTERACTIVE_MARKDOWN_BODY_SELECTOR);

        if (!this.#markdownBody) {
            Logger.warn('MarkonApp', 'Markdown body not found, will initialize minimal features');
        } else {
            Logger.log('MarkonApp', 'Initializing...', {
                filePath: this.#filePath,
                isSharedMode: this.#isSharedMode,
            });
        }
    }

    /** Initialize application. */
    async init(): Promise<void> {
        // Always initialize search and keyboard shortcuts (they work without markdown body)
        this.#initKeyboardShortcuts();
        this.#initWorkspaceSpotlight();
        this.#initSearchHighlights();

        if (!this.#markdownBody) {
            // Directory mode: setup keyboard event listeners and register shortcuts
            this.#setupKeyboardEventListener();
            this.#registerShortcuts();
            Logger.log('MarkonApp', 'Minimal initialization complete (directory mode)');
            return;
        }

        // 1. Initialize storage
        await this.#initStorage();

        // 2. Initialize managers
        this.#initManagers();

        // 3. Load data
        await this.#loadData();

        // 3b. Now that managers exist and the (empty) shared load is done, wire
        // the shared-annotation WS handlers. WebSocketManager replays the
        // server's buffered connect-time `all_annotations` into them here.
        if (this.#isSharedMode) {
            this.#setupWebSocketHandlers();
            // Gate annotation author colouring on shared mode — attribution is
            // meaningless for a single local user.
            document.body.classList.add('markon-shared');
        }

        // 4. Apply to DOM
        this.#applyToDOM();

        // 5. Setup event listeners
        this.#setupEventListeners();

        // 6. Register keyboard shortcuts
        this.#registerShortcuts();

        // 7. Fix TOC HTML entities
        this.#fixTocHtmlEntities();

        // 8. Update clear button text
        this.#updateClearButtonText();

        // 9. Start collaboration
        this.#collaboration?.init();

        // 10. Start chat (gated internally on Meta.flag('enable-chat'))
        if (Meta.flag(CONFIG.META_TAGS.ENABLE_CHAT)) {
            const chat = new ChatManager(this);
            chat.init();
            window.chatManager = chat;
        }

        Logger.log('MarkonApp', 'Initialization complete');
    }

    /** Initialize storage. @private */
    async #initStorage(): Promise<void> {
        // WebSocket is needed by either shared-annotation persistence or Live
        // broadcast. Establish one connection in either case.
        if (this.#isSharedMode || this.#enableLive) {
            this.#wsManager = new WebSocketManager(this.#filePath);
            this.ws = this.#wsManager;

            try {
                await this.#wsManager.connect();
                Logger.log('MarkonApp', 'WebSocket connected');

                const ws = this.#wsManager.getWebSocket();
                if (ws) window.ws = ws;
                else delete window.ws;

                if (window.viewedManager) {
                    if (this.#isSharedMode && !window.viewedManager.isSharedMode) {
                        window.viewedManager.isSharedMode = true;
                    }
                    // Always thread the op_id-aware adapter so viewed.ts can
                    // tag outgoing frames and skip its own echoes, even on
                    // tabs where `ws` was already populated by a prior init.
                    window.viewedManager.wsManager = this.#wsManager;
                    if (!window.viewedManager.ws) {
                        window.viewedManager.ws = window.ws ?? null;
                        window.viewedManager.setupWebSocketListeners();
                    }
                }
            } catch (error) {
                Logger.error('MarkonApp', 'WebSocket connection failed:', error);
            }

            // NOTE: shared-annotation message handlers (all_annotations, …) are
            // registered later, after #initManagers + #loadData — they need the
            // managers to exist, and they must run *after* the (empty) shared
            // load so the server's connect-time `all_annotations` push isn't
            // clobbered. The frame is buffered by WebSocketManager until then.

            // External-edit auto-reload: applies to any workspace whose pages
            // hold a WS connection, not just shared-annotation ones.
            this.#setupFileChangedHandler();
        }

        this.#storage = new StorageManager(this.#filePath, this.#isSharedMode, this.#wsManager);
    }

    /**
     * Reload the page when the server reports an external edit to a file
     * inside this workspace. Skipped when the editor is open with unsaved
     * changes — that buffer would be silently destroyed.
     * @private
     */
    #setupFileChangedHandler(): void {
        if (!this.#wsManager) return;
        this.#wsManager.on('file_changed', (message) => {
            const myWs = Meta.get(CONFIG.META_TAGS.WORKSPACE_ID);
            if (!myWs || message.workspace_id !== myWs) return;
            const editor = window.editorManager;
            if (editor && editor.isOpen() && editor.isDirty()) {
                Logger.log('MarkonApp', 'file_changed received but editor is dirty, skipping reload');
                return;
            }
            Logger.log('MarkonApp', `file_changed for ${message.path} → reloading`);
            window.location.reload();
        });
    }

    /** Initialize managers. @private */
    #initManagers(): void {
        if (!this.#markdownBody || !this.#storage) return;

        this.#annotationManager = new AnnotationManager(this.#storage, this.#markdownBody);
        this.#annotationManager.onChange(() => {
            document.dispatchEvent(new CustomEvent('markon:notes-count-changed', {
                detail: { count: this.notesCount() },
            }));
        });

        this.#noteManager = new NoteManager(this.#annotationManager, this.#markdownBody);

        this.#popoverManager = new PopoverManager(this.#markdownBody, {
            enableEdit: this.#enableEdit,
            enableChat: Meta.flag(CONFIG.META_TAGS.ENABLE_CHAT),
        });

        this.#visualZoomManager = new VisualZoomManager(this.#markdownBody);
        this.#visualZoomManager.init();
        window.visualZoomManager = this.#visualZoomManager;

        this.#undoManager = new UndoManager();

        this.#tocNavigator = new TOCNavigator();
        this.#annotationNavigator = new AnnotationNavigator();

        this.#collaboration = new CollaborationManager(this);

        this.#popoverManager.onAction((action, data) => {
            void this.#handlePopoverAction(action, data);
        });

        Logger.log('MarkonApp', 'Managers initialized');
    }

    /** Initialize keyboard shortcuts (works without markdown body). @private */
    #initKeyboardShortcuts(): void {
        if (!this.#shortcutsManager) {
            this.#shortcutsManager = new KeyboardShortcutsManager();
            Logger.log('MarkonApp', 'KeyboardShortcutsManager initialized');
        }
    }

    /** Load data. @private */
    async #loadData(): Promise<void> {
        if (!this.#annotationManager) return;
        await this.#annotationManager.load();
        Logger.log('MarkonApp', `Loaded ${this.#annotationManager.getAll().length} annotations`);
        document.dispatchEvent(new CustomEvent('markon:notes-count-changed', {
            detail: { count: this.notesCount() },
        }));
    }

    /** Apply to DOM. @private */
    #applyToDOM(): void {
        this.#annotationManager?.applyToDOM();
        this.#noteManager?.render();
        this.#noteManager?.setupResponsiveLayout();
    }

    /** Setup keyboard event listener (used in both directory and document modes). @private */
    #setupKeyboardEventListener(): void {
        document.addEventListener('keydown', (e) => {
            this.#shortcutsManager?.handle(e);
        });
        Logger.log('MarkonApp', 'Keyboard event listener setup complete');
    }

    /** Setup event listeners. @private */
    #setupEventListeners(): void {
        // Selection events
        document.addEventListener('mouseup', (e) => {
            this.#popoverManager?.handleSelection(e);
        });

        document.addEventListener('touchend', (e) => {
            this.#popoverManager?.handleSelection(e);
        });

        // Click on highlighted element
        document.addEventListener('click', (e) => {
            const target = e.target as Element | null;
            const isHighlighted = target?.closest(CONFIG.SELECTORS.HIGHLIGHT_CLASSES);
            if (isHighlighted) {
                this.#popoverManager?.handleHighlightClick(isHighlighted);
            }
        });

        // Note card click event
        this.#setupNoteClickHandlers();

        // TOC events
        this.#setupTOCEvents();

        // Heading focus on click
        this.#setupHeadingClickFocus();

        if (Meta.flag(CONFIG.META_TAGS.ENABLE_VIEWED)) {
            this.#setupHeadingDoubleClick();
        }

        // Global keyboard handler
        this.#setupKeyboardEventListener();

        // Outside-click hide
        this.#setupOutsideClickHandler();

        Logger.log('MarkonApp', 'Event listeners setup complete');
    }

    #setupHeadingClickFocus(): void {
        document.addEventListener('click', (e) => {
            const target = e.target as Element | null;
            if (!target) return;
            if (!this.#markdownBody?.contains(target)) return;

            if (
                target.tagName === 'A' ||
                target.tagName === 'BUTTON' ||
                target.tagName === 'INPUT' ||
                target.tagName === 'TEXTAREA' ||
                target.closest('.selection-popover') ||
                target.closest('.note-input-modal') ||
                target.closest('.note-card-margin') ||
                target.closest('.note-popup')
            ) {
                return;
            }

            let heading: HTMLElement | null = target.closest<HTMLElement>(CONFIG.SELECTORS.HEADINGS);

            if (!heading) {
                const allHeadings = Array.from(
                    this.#markdownBody.querySelectorAll<HTMLElement>(CONFIG.SELECTORS.HEADINGS),
                );
                const clickY = e.clientY + window.scrollY;

                for (let i = allHeadings.length - 1; i >= 0; i--) {
                    const h = allHeadings[i];
                    if (!h) continue;
                    const hY = h.getBoundingClientRect().top + window.scrollY;
                    if (hY <= clickY) {
                        heading = h;
                        break;
                    }
                }
            }

            if (heading) {
                this.#clearHeadingFocus();
                heading.classList.add('heading-focused');
            }
        });
    }

    /** Remove `.heading-focused` from every element. Returns the cleared count. @private */
    #clearHeadingFocus(): number {
        const focused = document.querySelectorAll('.heading-focused');
        focused.forEach((el) => {
            el.classList.remove('heading-focused');
        });
        return focused.length;
    }

    /** Register keyboard shortcuts. @private */
    #registerShortcuts(): void {
        const shortcuts = this.#shortcutsManager;
        if (!shortcuts) return;

        // Always available (document view AND directory/workspace landing).
        shortcuts.register('HELP', () => {
            shortcuts.showHelp();
        });

        shortcuts.register('THEME_PANEL', () => {
            window.MarkonTheme?.togglePanel();
        });

        shortcuts.register('ESCAPE', () => {
            this.#handleEscapeKey();
        });

        if (this.#workspaceSpotlight) {
            shortcuts.register('SEARCH', () => {
                this.#workspaceSpotlight?.toggle();
            });
            shortcuts.register('WORKSPACE_NAVIGATOR', () => {
                this.#workspaceSpotlight?.toggle();
            });
        }

        // Directory / workspace landing page: no markdown body, so none of the
        // document-view features below exist here. The shared Workspace
        // Spotlight shortcuts are registered above when a workspace id exists.
        if (!this.#markdownBody) {
            Logger.log('MarkonApp', 'Directory mode: minimal shortcuts registered');
            return;
        }

        // ── Document view only, below ────────────────────────────────────────
        shortcuts.register('TOGGLE_TOC', () => {
            this.#toggleTOC();
        });

        shortcuts.register('UNDO', () => {
            void this.#handleUndo();
        });

        shortcuts.register('REDO', () => {
            void this.#handleRedo();
        });

        shortcuts.register('REDO_ALT', () => {
            void this.#handleRedo();
        });

        shortcuts.register('NEXT_HEADING', () => {
            Logger.log('MarkonApp', 'NEXT_HEADING triggered');
            this.#navigateHeading('next');
        });

        shortcuts.register('PREV_HEADING', () => {
            Logger.log('MarkonApp', 'PREV_HEADING triggered');
            this.#navigateHeading('prev');
        });

        shortcuts.register('NEXT_ANNOTATION', () => {
            this.#annotationNavigator?.next();
        });

        shortcuts.register('PREV_ANNOTATION', () => {
            this.#annotationNavigator?.previous();
        });

        shortcuts.register('SCROLL_HALF_PAGE_DOWN', () => {
            this.#smoothScrollBy(window.innerHeight / 3, 500);
        });

        shortcuts.register('EXPORT_NOTES', () => {
            this.exportNotes();
        });

        if (Meta.flag(CONFIG.META_TAGS.ENABLE_VIEWED)) {
            shortcuts.register('TOGGLE_VIEWED', () => {
                this.#toggleCurrentSectionViewed();
            });

            shortcuts.register('TOGGLE_SECTION_COLLAPSE', () => {
                this.#toggleCurrentSectionCollapse();
            });
        }

        if (this.#enableEdit) {
            shortcuts.register('EDIT', () => {
                this.#openEditor();
            });
        }

        // Live mode (if enabled):
        //   L       — toggle Broadcast ⇄ Follow.
        //   Shift+L — toggle Off ⇄ last active mode.
        if (this.#enableLive && this.#collaboration) {
            shortcuts.register('TOGGLE_LIVE_ACTIVE', () => {
                this.#collaboration?.toggleActiveMode();
            });
            shortcuts.register('TOGGLE_LIVE_OFF', () => {
                this.#collaboration?.toggleOff();
            });
        }

        // Chat (if enabled):
        //   C       — open chat in the user's default surface.
        //   Shift+C — open in the alternate surface (in-page ⇄ popout).
        if (Meta.flag(CONFIG.META_TAGS.ENABLE_CHAT)) {
            shortcuts.register('TOGGLE_CHAT', () => {
                window.chatManager?.openInDefault();
            });
            shortcuts.register('TOGGLE_CHAT_ALT', () => {
                window.chatManager?.openInDefault({ invert: true });
            });
        }

        Logger.log('MarkonApp', 'Shortcuts registered');
    }

    /** Handle popover actions. @private */
    async #handlePopoverAction(action: string, data: PopoverActionPayload): Promise<void> {
        const { selection, highlightedElement } = data;
        const annotationManager = this.#annotationManager;
        const noteManager = this.#noteManager;
        const undoManager = this.#undoManager;
        if (!annotationManager || !noteManager || !undoManager) return;

        if (action === 'unhighlight') {
            if (highlightedElement instanceof HTMLElement) {
                const annotationId = highlightedElement.dataset['annotationId'];
                if (annotationId) {
                    await this.#applyDelete(annotationId, { pushUndo: true });
                }
            }
        } else if (action.startsWith('highlight-') || action === 'strikethrough') {
            if (!selection) return;
            const tagName =
                action === 'strikethrough' ? CONFIG.HTML_TAGS.STRIKETHROUGH : CONFIG.HTML_TAGS.HIGHLIGHT;
            const annotation = annotationManager.createAnnotation(
                selection,
                action as Annotation['type'],
                tagName as Annotation['tagName'],
            );
            // No note re-render here — highlights/strikethroughs carry no note.
            await this.#applyAdd(annotation, { pushUndo: true });
        } else if (action === 'add-note') {
            if (!selection) return;
            // Don't clear the selection — modal stays open until user confirms.
            this.#showNoteInputModal(selection);
            return;
        } else if (action === 'edit') {
            if (!selection) return;
            const selectedText = selection.toString().trim();
            if (!this.#editorManager) {
                this.#editorManager = new EditorManager(this.#filePath);
                window.editorManager = this.#editorManager;
            }
            void this.#editorManager.open({ selectedText });
            return; // Don't clear selection until editor opens
        } else if (action === 'chat') {
            if (!selection) return;
            const selectedText = selection.toString().trim();
            if (window.chatManager && selectedText) {
                window.chatManager.openWithSelection({
                    text: selectedText,
                    currentDoc: this.#filePath,
                    shift: data.shiftKey,
                });
            }
            // Drop the selection after handing it to the chat.
        }

        // Clear selection (except for add-note / edit, which return early).
        window.getSelection()?.removeAllRanges();
    }

    /**
     * Add an annotation and apply it to the DOM. Optionally records the
     * addition on the undo stack and/or re-renders the margin notes.
     * @private
     */
    async #applyAdd(
        annotation: Annotation,
        options: { pushUndo?: boolean; render?: boolean } = {},
    ): Promise<void> {
        if (!this.#annotationManager || !this.#noteManager) return;
        await this.#annotationManager.add(annotation);
        this.#annotationManager.applyToDOM([annotation]);
        if (options.pushUndo) {
            this.#undoManager?.push({ type: 'add_annotation', annotation });
        }
        if (options.render) {
            this.#noteManager.render();
        }
    }

    /**
     * Delete an annotation, detach it from the DOM and re-render the margin
     * notes. Optionally records the deletion on the undo stack.
     * @private
     */
    async #applyDelete(annotationId: string, options: { pushUndo?: boolean } = {}): Promise<void> {
        if (!this.#annotationManager || !this.#noteManager) return;
        await this.#annotationManager.delete(annotationId);
        this.#annotationManager.removeFromDOM(annotationId);
        this.#noteManager.render();
        if (options.pushUndo) {
            this.#undoManager?.push({
                type: 'delete_annotation',
                annotation: { id: annotationId },
            });
        }
    }

    /**
     * Show the note input modal.
     * @private
     */
    #showNoteInputModal(selection: Range, annotation: Annotation | null = null): void {
        // Build temporary highlight overlays — we can't keep the live selection
        // alive while a textarea steals focus.
        const createSelectionOverlay = (): HTMLElement[] => {
            const rects = selection.getClientRects();
            const overlays: HTMLElement[] = [];

            for (let i = 0; i < rects.length; i++) {
                const rect = rects[i];
                if (!rect) continue;
                const overlay = document.createElement('div');
                overlay.className = 'temp-selection-overlay';
                overlay.style.position = 'absolute';
                overlay.style.left = `${rect.left + window.scrollX}px`;
                overlay.style.top = `${rect.top + window.scrollY}px`;
                overlay.style.width = `${rect.width}px`;
                overlay.style.height = `${rect.height}px`;
                overlay.style.backgroundColor = 'rgba(100, 150, 255, 0.3)';
                overlay.style.pointerEvents = 'none';
                overlay.style.zIndex = '9998'; // Below modal (9999), above content
                document.body.appendChild(overlay);
                overlays.push(overlay);
            }
            return overlays;
        };

        const selectionOverlays = createSelectionOverlay();

        const cleanupOverlays = (): void => {
            selectionOverlays.forEach((overlay) => overlay.remove());
        };

        const rect = selection.getBoundingClientRect();
        const anchorElement = {
            getBoundingClientRect: () => rect,
        } as unknown as HTMLElement;

        ModalManager.showNoteInput({
            anchorElement,
            initialValue: annotation ? annotation.note ?? '' : '',
            onSave: (noteText: string) => {
                void (async () => {
                    const annotationManager = this.#annotationManager;
                    const noteManager = this.#noteManager;
                    const undoManager = this.#undoManager;
                    if (!annotationManager || !noteManager || !undoManager) return;

                    if (noteText) {
                        if (annotation) {
                            annotation.note = noteText;
                            await annotationManager.add(annotation);
                        } else {
                            const newAnnotation = annotationManager.createAnnotation(
                                selection,
                                CONFIG.ANNOTATION_TYPES.HAS_NOTE as Annotation['type'],
                                CONFIG.HTML_TAGS.HIGHLIGHT as Annotation['tagName'],
                                noteText,
                            );
                            await this.#applyAdd(newAnnotation, { pushUndo: true });
                        }

                        noteManager.render();
                    } else if (annotation) {
                        await this.#applyDelete(annotation.id);
                    }

                    cleanupOverlays();
                    window.getSelection()?.removeAllRanges();
                })();
            },
            onCancel: () => {
                cleanupOverlays();
                window.getSelection()?.removeAllRanges();
            },
        });
    }

    /** Setup WebSocket message handlers. @private */
    #setupWebSocketHandlers(): void {
        const ws = this.#wsManager;
        if (!ws) return;
        const annotationManager = this.#annotationManager;
        const noteManager = this.#noteManager;

        // Trust boundary for shared-annotation mode: ids from peers flow into
        // querySelector strings and innerHTML attributes downstream. Validate
        // the shape once here (locally minted ids are `anno-<uuid>`) so a
        // crafted id can't break out of a selector or attribute. Reject the
        // whole annotation rather than trying to escape at every sink.
        const validId = (id: unknown): id is string =>
            typeof id === 'string' && /^anno-[A-Za-z0-9-]{1,64}$/.test(id);

        ws.on('all_annotations', (message) => {
            if (!annotationManager || !noteManager) return;
            annotationManager.clearDOM();
            const annotations = (message.annotations ?? []) as Annotation[];
            annotations.forEach((anno) => {
                if (!validId(anno?.id)) {
                    Logger.warn('WebSocket', `Dropped annotation with invalid id: ${String(anno?.id)}`);
                    return;
                }
                void annotationManager.add(anno, true); // skipSave=true: from remote
            });
            annotationManager.applyToDOM();
            noteManager.render();
        });

        ws.on('new_annotation', (message) => {
            if (!annotationManager || !noteManager) return;
            // Protocol-level echo dedup: drop frames originated by this tab.
            if (ws.isOwnEcho(message.op_id)) {
                Logger.log('WebSocket', `Skipped own new_annotation echo (op_id ${message.op_id})`);
                return;
            }
            const incoming = message.annotation as Annotation;
            if (!validId(incoming?.id)) {
                Logger.warn('WebSocket', `Dropped new_annotation with invalid id: ${String(incoming?.id)}`);
                return;
            }
            // Belt-and-braces: a stray dupe (legacy peer, replay) still gets filtered.
            const existingAnnotation = annotationManager.getById(incoming.id);
            if (existingAnnotation) {
                Logger.log('WebSocket', `Annotation ${incoming.id} already exists locally, skipping`);
                return;
            }

            void annotationManager.add(incoming, true);
            annotationManager.applyToDOM([incoming]);
            noteManager.render();
        });

        ws.on('delete_annotation', (message) => {
            if (!annotationManager || !noteManager) return;
            if (ws.isOwnEcho(message.op_id)) {
                Logger.log('WebSocket', `Skipped own delete_annotation echo (op_id ${message.op_id})`);
                return;
            }
            if (!validId(message.id)) {
                Logger.warn('WebSocket', `Dropped delete_annotation with invalid id: ${String(message.id)}`);
                return;
            }
            void annotationManager.delete(message.id, true);
            annotationManager.removeFromDOM(message.id);
            noteManager.render();
        });

        ws.on('clear_annotations', (message) => {
            if (!annotationManager || !noteManager) return;
            if (ws.isOwnEcho(message.op_id)) {
                Logger.log('WebSocket', `Skipped own clear_annotations echo (op_id ${message.op_id})`);
                return;
            }
            Logger.log('MarkonApp', 'Received CLEAR_ANNOTATIONS broadcast from server');
            void annotationManager.clear(true);
            annotationManager.clearDOM();
            noteManager.clear();
            Logger.log('MarkonApp', 'Cleared annotations from broadcast, no reload needed');
        });
    }

    /** Setup note click handlers. @private */
    #setupNoteClickHandlers(): void {
        document.body.addEventListener('click', (e) => {
            void (async () => {
            const target = e.target as HTMLElement | null;
            if (!target || !this.#annotationManager || !this.#noteManager || !this.#undoManager) return;

            // Action buttons carry inline SVG icons, so a click can land on the
            // <svg>/<path> child — resolve the owning button via closest()
            // rather than matching e.target directly (else clicks on the icon
            // strokes silently miss).
            const copyBtn = target.closest<HTMLElement>('.note-copy');
            const editBtn = target.closest<HTMLElement>('.note-edit');
            const deleteBtn = target.closest<HTMLElement>('.note-delete');

            // Quick-copy button (quote + note → clipboard)
            if (copyBtn) {
                const annotationId = copyBtn.dataset['annotationId'];
                if (annotationId) void this.copyAnnotation(annotationId, copyBtn);
                e.stopPropagation();
                return;
            }

            // Edit button
            if (editBtn) {
                const annotationId = editBtn.dataset['annotationId'];
                if (!annotationId) return;
                const annotation = this.#annotationManager.getById(annotationId);
                if (annotation) {
                    document.querySelector('.note-popup')?.remove();

                    const highlightElement = this.#markdownBody?.querySelector<HTMLElement>(
                        `[data-annotation-id="${annotationId}"]`,
                    );
                    if (highlightElement) {
                        const range = document.createRange();
                        range.selectNodeContents(highlightElement);
                        this.#showNoteInputModal(range, annotation);
                    }
                }
                e.stopPropagation();
                return;
            }

            // Delete button
            if (deleteBtn) {
                const annotationId = deleteBtn.dataset['annotationId'];
                if (!annotationId) return;
                showConfirmDialog(
                    'Delete this note?',
                    async () => {
                        if (!this.#annotationManager || !this.#noteManager || !this.#undoManager) return;
                        await this.#applyDelete(annotationId, { pushUndo: true });
                        document.querySelector('.note-popup')?.remove();
                    },
                    deleteBtn,
                    'Delete',
                );
                e.stopPropagation();
                return;
            }

            // Click on a note element — a highlight may wrap inline markup
            // (bold/code/…), so resolve the owning .has-note via closest().
            const noteEl = target.closest<HTMLElement>('.has-note');
            if (noteEl) {
                const annotationId = noteEl.dataset['annotationId'];
                if (!annotationId) return;

                if (window.innerWidth > CONFIG.BREAKPOINTS.WIDE_SCREEN) {
                    this.#noteManager.setActive(annotationId);
                    const noteCard = document.querySelector<HTMLElement>(
                        `.note-card-margin[data-annotation-id="${annotationId}"]`,
                    );
                    if (noteCard) {
                        const noteRect = noteCard.getBoundingClientRect();
                        if (noteRect.top < 0 || noteRect.bottom > window.innerHeight) {
                            noteCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        }
                    }
                } else {
                    // Narrow screen: show popup
                    this.#noteManager.showNotePopup(noteEl, annotationId);
                }

                e.stopPropagation();
                return;
            }

            // Click on a note card itself — make it the active selection so
            // the connector + source highlight light up too.
            const card = target.closest<HTMLElement>('.note-card-margin');
            if (card) {
                const annotationId = card.dataset['annotationId'];
                if (annotationId && window.innerWidth > CONFIG.BREAKPOINTS.WIDE_SCREEN) {
                    this.#noteManager.setActive(annotationId);
                }
                e.stopPropagation();
            }
            })();
        });
    }

    /** Setup TOC events. @private */
    #setupTOCEvents(): void {
        const tocIcon = document.querySelector<HTMLElement>(CONFIG.SELECTORS.TOC_ICON);
        const tocContainer = document.querySelector<HTMLElement>(CONFIG.SELECTORS.TOC_CONTAINER);

        if (!tocIcon || !tocContainer) return;

        const tocPanel = tocContainer.querySelector<HTMLElement>('.toc');
        const syncTocFrame = (): void => {
            const isNarrowScreen = window.innerWidth <= CONFIG.BREAKPOINTS.WIDE_SCREEN;
            const shouldUseFrame =
                tocContainer.classList.contains('toc-nav-active') ||
                (isNarrowScreen && tocContainer.classList.contains('active'));
            tocContainer.classList.toggle('markon-modal-layer', shouldUseFrame);
            tocPanel?.classList.toggle('markon-modal-frame', shouldUseFrame);
        };

        // Mutual exclusion: collapse other floating layers before opening ToC.
        const toggleToc = (e: Event): void => {
            const willOpen = !tocContainer.classList.contains('active');
            if (willOpen) {
                for (const peer of FloatingLayer.all()) {
                    if (peer.name !== 'toc' && peer.isExpanded) peer.collapse();
                }
            }
            tocContainer.classList.toggle('active');
            syncTocFrame();
            e.stopPropagation();
            e.preventDefault();
        };

        syncTocFrame();
        window.addEventListener('resize', syncTocFrame);
        tocIcon.addEventListener('click', toggleToc);
        tocIcon.addEventListener('touchend', toggleToc);

        // External click closes ToC.
        const closeToc = (e: Event): void => {
            const target = e.target as Node | null;
            if (tocContainer.classList.contains('active') && target && !tocContainer.contains(target)) {
                tocContainer.classList.remove('active');
                syncTocFrame();
            }
        };

        document.addEventListener('click', closeToc);
        document.addEventListener('touchend', closeToc);

        // Register ToC as a passive obstacle so Live/Chat avoid it.
        const tocLayer = new FloatingLayer({
            name: 'toc',
            container: tocContainer,
            passive: true,
            // Fixed obstacle: highest priority, pushes everything, yields to none.
            rolePriority: 0,
            expandedClass: 'active',
            getObstacleRect: () => {
                const active = tocContainer.classList.contains('active');
                const target = active ? tocContainer.querySelector('.toc') : tocIcon;
                if (!target) return null;
                const r = (target as HTMLElement).getBoundingClientRect();
                return r.width === 0 || r.height === 0 ? null : r;
            },
            collapseExpanded: () => {
                tocContainer.classList.remove('active');
                syncTocFrame();
            },
        });
        tocLayer.init();
    }

    /** Fix TOC HTML entities. @private */
    #fixTocHtmlEntities(): void {
        const toc = document.querySelector('.toc');
        if (!toc) return;

        const tocItems = toc.querySelectorAll<HTMLAnchorElement>('.toc-item a');
        tocItems.forEach((item) => {
            const text = item.textContent ?? '';
            const decoded = Text.decodeEntities(text);
            if (text !== decoded) {
                item.textContent = decoded;
            }
        });
    }

    /** Update clear-button text to reflect local/shared mode. @private */
    #updateClearButtonText(): void {
        const clearButton = document.querySelector<HTMLElement>('.footer-clear-link');
        if (clearButton) {
            const mode = this.#isSharedMode ? 'shared' : 'local';
            clearButton.textContent = `Clear Annotations(${mode}) in this page`;
        }
    }

    /** Setup outside-click handler. @private */
    #setupOutsideClickHandler(): void {
        const hideOnOutsideClick = (e: Event): void => {
            const target = e.target as Element | null;
            if (!target) return;
            if (
                target.closest('.selection-popover') ||
                target.closest('#toc-container') ||
                target.closest('.note-card-margin') ||
                target.closest('.note-popup') ||
                target.closest('.note-input-modal')
            ) {
                return;
            }

            // Clear an active note unless the click landed on the source
            // highlight itself (that path runs through the click handler and
            // toggles selection there).
            if (!target.closest('.has-note')) {
                this.#noteManager?.clearActive();
            }

            if (this.#popoverManager?.isVisible()) {
                this.#popoverManager.hide();
                window.getSelection()?.removeAllRanges();
            }

            // Click outside .markdown-body cancels the focused heading.
            if (!this.#markdownBody?.contains(target) && this.#clearHeadingFocus() > 0) {
                Logger.log('MarkonApp', 'Cleared heading focus (clicked outside markdown-body)');
            }
        };

        document.addEventListener('mousedown', hideOnOutsideClick);
        document.addEventListener('touchstart', hideOnOutsideClick, { passive: true });
    }

    /**
     * Cancellable smooth scroll.
     * @private
     */
    #smoothScrollBy(distance: number, duration = 800): void {
        if (this.#scrollAnimationId) {
            cancelAnimationFrame(this.#scrollAnimationId);
            this.#scrollAnimationId = null;
        }

        this.#scrollCancelled = false;
        const startPosition = window.pageYOffset;
        const startTime = performance.now();

        const easeInOutCubic = (t: number): number => {
            return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        };

        const scroll = (currentTime: number): void => {
            if (this.#scrollCancelled) {
                this.#scrollAnimationId = null;
                return;
            }

            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const easeProgress = easeInOutCubic(progress);

            window.scrollTo(0, startPosition + distance * easeProgress);

            if (progress < 1) {
                this.#scrollAnimationId = requestAnimationFrame(scroll);
            } else {
                this.#scrollAnimationId = null;
            }
        };

        this.#scrollAnimationId = requestAnimationFrame(scroll);
    }

    /** Cancel scroll animation. @private */
    #cancelScroll(): boolean {
        if (this.#scrollAnimationId) {
            this.#scrollCancelled = true;
            cancelAnimationFrame(this.#scrollAnimationId);
            this.#scrollAnimationId = null;
            return true;
        }
        return false;
    }

    /** Handle Escape key. @private */
    #handleEscapeKey(): void {
        if (this.#cancelScroll()) {
            return;
        }
        const helpPanel = document.querySelector('.shortcuts-help-panel');
        if (helpPanel) {
            helpPanel.classList.remove('visible');
            setTimeout(() => helpPanel.remove(), CONFIG.ANIMATION.PANEL_TRANSITION);
            return;
        }

        if (this.#workspaceSpotlight?.isOpen()) {
            this.#workspaceSpotlight.close();
            return;
        }

        // Close the expanded Live panel if it's open.
        const liveContainer = document.getElementById('markon-live-container');
        if (liveContainer && liveContainer.classList.contains('expanded')) {
            this.#collaboration?.collapse?.();
            return;
        }

        // Close TOC
        const tocContainer = document.querySelector(CONFIG.SELECTORS.TOC_CONTAINER);
        if (tocContainer && tocContainer.classList.contains('active')) {
            tocContainer.classList.remove('active');
            tocContainer.classList.remove('markon-modal-layer');
            tocContainer.querySelector('.toc')?.classList.remove('markon-modal-frame');
            return;
        }

        if (this.#popoverManager?.isVisible()) {
            this.#popoverManager.hide();
            window.getSelection()?.removeAllRanges();
            return;
        }

        window.getSelection()?.removeAllRanges();
    }

    /** Toggle TOC. @private */
    #toggleTOC(): void {
        const tocContainer = document.querySelector<HTMLElement>(CONFIG.SELECTORS.TOC_CONTAINER);
        if (!tocContainer) return;

        const isNarrowScreen = window.innerWidth <= CONFIG.BREAKPOINTS.WIDE_SCREEN;
        const tocVisible = tocContainer.classList.contains('active') || !isNarrowScreen;
        const navActive = this.#tocNavigator?.active ?? false;

        if (navActive) {
            this.#tocNavigator?.deactivate();
            if (isNarrowScreen) {
                tocContainer.classList.remove('active');
                tocContainer.classList.remove('markon-modal-layer');
                tocContainer.querySelector('.toc')?.classList.remove('markon-modal-frame');
            }
        } else {
            if (isNarrowScreen && !tocVisible) {
                tocContainer.classList.add('active');
            }
            this.#tocNavigator?.activate();
        }
    }

    /** Handle Undo. @private */
    async #handleUndo(): Promise<void> {
        const operation: UndoOperation | null = this.#undoManager?.undo() ?? null;
        if (operation) await this.#replayOperation(operation, true);
    }

    /** Handle Redo. @private */
    async #handleRedo(): Promise<void> {
        const operation: UndoOperation | null = this.#undoManager?.redo() ?? null;
        if (operation) await this.#replayOperation(operation, false);
    }

    /**
     * Replay an undo-stack operation. Redo replays it as recorded; undo
     * applies the inverse (an add is undone by a delete and vice versa).
     * Never pushes — UndoManager moves operations between its stacks itself.
     * @private
     */
    async #replayOperation(operation: UndoOperation, invert: boolean): Promise<void> {
        const annotation = operation['annotation'] as Annotation;

        switch (operation.type) {
            case 'add_annotation':
                if (invert) await this.#applyDelete(annotation.id);
                else await this.#applyAdd(annotation, { render: true });
                break;
            case 'delete_annotation':
                if (invert) await this.#applyAdd(annotation, { render: true });
                else await this.#applyDelete(annotation.id);
                break;
        }
    }

    /** Is the heading hidden because an ancestor section is collapsed? @private */
    #isHeadingInCollapsedSection(heading: HTMLElement, allHeadings: HTMLElement[]): boolean {
        const headingIndex = allHeadings.indexOf(heading);
        if (headingIndex <= 0) return false;

        const currentLevel = parseInt(heading.tagName.substring(1));

        for (let i = headingIndex - 1; i >= 0; i--) {
            const prevHeading = allHeadings[i];
            if (!prevHeading) continue;
            const prevLevel = parseInt(prevHeading.tagName.substring(1));

            if (prevLevel < currentLevel) {
                if (prevHeading.classList.contains('section-collapsed')) {
                    return true;
                }
            }
        }

        return false;
    }

    /** Navigate to next/prev heading. @private */
    #navigateHeading(direction: 'next' | 'prev'): void {
        const allHeadings = Array.from(
            document.querySelectorAll<HTMLElement>(CONFIG.SELECTORS.HEADINGS),
        );

        // Visible headings: not in a collapsed section, no `section-content-hidden`.
        const headings = allHeadings.filter((h) => {
            if (h.classList.contains('section-content-hidden')) {
                return false;
            }
            const inCollapsed = this.#isHeadingInCollapsedSection(h, allHeadings);
            return !inCollapsed;
        });

        if (headings.length === 0) return;

        const currentFocused = document.querySelector<HTMLElement>('.heading-focused');
        let targetHeading: HTMLElement | undefined;

        if (currentFocused) {
            const currentIndex = headings.indexOf(currentFocused);
            if (direction === 'next' && currentIndex < headings.length - 1) {
                targetHeading = headings[currentIndex + 1];
            } else if (direction === 'prev' && currentIndex > 0) {
                targetHeading = headings[currentIndex - 1];
            }
        } else {
            targetHeading = headings[0];
        }

        if (targetHeading) {
            this.#clearHeadingFocus();
            targetHeading.classList.add('heading-focused');
            Position.smartScrollToHeading(targetHeading);
            // Sync TOC selected state
            if (targetHeading.id && window.__markonTocSetSelected) {
                window.__markonTocSetSelected(targetHeading.id);
            }
        }
    }

    /** Toggle current section's viewed state. @private */
    #toggleCurrentSectionViewed(): void {
        const focusedHeading = document.querySelector<HTMLElement>('.heading-focused');
        if (!focusedHeading) return;

        const checkbox = focusedHeading.querySelector<HTMLInputElement>('.viewed-checkbox');
        if (checkbox) {
            checkbox.click();
        }
    }

    /** Toggle current section's collapse state. @private */
    #toggleCurrentSectionCollapse(): void {
        const focusedHeading = document.querySelector<HTMLElement>('.heading-focused');
        if (!focusedHeading?.id) return;

        this.#toggleSectionCollapse(focusedHeading);
    }

    /** Toggle the given heading's section collapse state. @private */
    #toggleSectionCollapse(heading: HTMLElement | null): void {
        if (!heading?.id) return;

        if (!window.viewedManager) return;

        const headingId = heading.id;
        window.viewedManager.toggleCollapse(headingId);
    }

    /** Setup heading double-click events. @private */
    #setupHeadingDoubleClick(): void {
        document.addEventListener('dblclick', (e) => {
            const target = e.target as Element | null;
            if (!target) return;
            const heading = target.closest<HTMLElement>(CONFIG.SELECTORS.HEADINGS);
            if (!heading) return;

            // Ignore double-clicks on interactive descendants.
            if (
                target.closest('.viewed-checkbox') ||
                target.closest('button') ||
                target.closest('a') ||
                target.closest('.section-expand-toggle')
            ) {
                return;
            }

            this.#toggleSectionCollapse(heading);
        });

        Logger.log('MarkonApp', 'Heading double-click handler registered');
    }

    /** Get file path from <meta>. @private */
    #getFilePathFromMeta(): string {
        return Meta.get(CONFIG.META_TAGS.FILE_PATH) ?? window.location.pathname;
    }

    /** Clear all annotations on the current page. */
    async clearAllAnnotations(event: Event | null = null): Promise<void> {
        const anchorElement: HTMLElement | null =
            event && event.target instanceof HTMLElement ? event.target : null;
        Logger.log('MarkonApp', 'clearAllAnnotations called, showing confirm dialog');
        showConfirmDialog(
            'Clear all annotations for this page?',
            async () => {
                if (!this.#annotationManager || !this.#noteManager || !this.#storage) return;
                Logger.log('MarkonApp', 'Confirm callback started');
                await this.#annotationManager.clear();
                Logger.log('MarkonApp', 'Annotations cleared from manager');
                this.#annotationManager.clearDOM();
                Logger.log('MarkonApp', 'Annotations cleared from DOM');
                this.#noteManager.clear();
                Logger.log('MarkonApp', 'Notes cleared');

                if (Meta.flag(CONFIG.META_TAGS.ENABLE_VIEWED)) {
                    await this.#storage.clearViewedState();
                    Logger.log('MarkonApp', 'Viewed state cleared from storage');

                    // Shared mode: viewedManager updates via WebSocket broadcast.
                    // Local mode: page reloads.
                    if (this.#isSharedMode && window.viewedManager) {
                        Logger.log('MarkonApp', 'Shared mode: viewedManager will update via WebSocket broadcast');
                    }
                }

                if (!this.#isSharedMode) {
                    Logger.log('MarkonApp', 'Local mode: reloading page');
                    location.reload();
                } else {
                    Logger.log('MarkonApp', 'Shared mode: clear complete, waiting for server sync');
                }
            },
            anchorElement,
            'Clear',
        );
    }

    /**
     * Open the notes export editor. When the page has no notes, flash an inline
     * hint on the toolbar link instead.
     */
    exportNotes(anchor?: HTMLElement | null): void {
        const annotationManager = this.#annotationManager;
        if (!annotationManager) return;
        if (!this.#exportManager) {
            this.#exportManager = new ExportManager({
                annotationManager,
                getDocumentTitle: () => document.title || this.#filePath || '',
                getFilePath: () => this.#filePath,
            });
        }
        const opened = this.#exportManager.open();
        if (!opened && anchor) {
            const original = anchor.textContent ?? '';
            anchor.textContent = i18n.t('web.export.empty');
            anchor.classList.add('is-flashing');
            setTimeout(() => {
                anchor.textContent = original;
                anchor.classList.remove('is-flashing');
            }, 1500);
        }
    }

    notesCount(): number {
        return this.#annotationManager?.getAll()
            .filter(a => !!a.note && a.note.trim() !== '')
            .length ?? 0;
    }

    /**
     * Copy a single annotation (quote + note) to the clipboard as Markdown.
     * Backs the per-annotation quick-copy buttons on note cards and the
     * highlight popover.
     */
    async copyAnnotation(annotationId: string, button?: HTMLElement | null): Promise<void> {
        const annotationManager = this.#annotationManager;
        if (!annotationManager) return;
        const annotation = annotationManager.getById(annotationId);
        if (!annotation) return;
        const markdown = annotationManager.formatAnnotation(annotation);
        const ok = await copyText(markdown);
        if (button) {
            if (ok) flashCopied(button);
            else flashBeside(button, i18n.t('web.export.failed'));
        }
    }

    /** Initialize workspace-wide Spotlight search/navigation. @private */
    #initWorkspaceSpotlight(): void {
        const workspaceId = Meta.get(CONFIG.META_TAGS.WORKSPACE_ID);
        if (!workspaceId) {
            document.querySelectorAll<HTMLElement>('[data-workspace-spotlight-trigger]').forEach((trigger) => {
                trigger.hidden = true;
            });
            return;
        }
        this.#workspaceSpotlight = new WorkspaceSpotlight({
            workspaceId,
            currentPath: this.#filePath,
            enableContentSearch: this.#enableSearch,
        });
        this.#workspaceSpotlight.bindTriggers();
        window.workspaceSpotlight = this.#workspaceSpotlight;
        Logger.log('MarkonApp', 'WorkspaceSpotlight initialized');
    }

    /** Initialize URL highlight handling for document pages. @private */
    #initSearchHighlights(): void {
        if (this.#markdownBody) {
            new HighlightManager();
            Logger.log('MarkonApp', 'HighlightManager initialized');
        }
    }

    /** Open the editor. @private */
    #openEditor(): void {
        if (!this.#enableEdit) {
            Logger.warn('MarkonApp', 'Edit feature is not enabled');
            return;
        }

        if (!this.#editorManager) {
            this.#editorManager = new EditorManager(this.#filePath);
            window.editorManager = this.#editorManager;
        }

        void this.#editorManager.open();
    }

    /** Open the editor and jump to a 1-based line number. */
    openEditorAtLine(line: number): void {
        if (!this.#enableEdit) {
            Logger.warn('MarkonApp', 'Edit feature is not enabled');
            return;
        }
        if (!this.#editorManager) {
            this.#editorManager = new EditorManager(this.#filePath);
            window.editorManager = this.#editorManager;
        }
        void this.#editorManager.open({ line });
    }

    /** Re-apply loaded annotations after a page replaces rendered markdown content. */
    refreshAnnotations(): void {
        if (!this.#annotationManager || !this.#noteManager) return;
        this.#annotationManager.clearDOM();
        this.#annotationManager.applyToDOM();
        this.#noteManager.render();
    }

    /** Manager snapshot — used for window globals + debug. */
    getManagers(): ManagerSnapshot {
        return {
            storage: this.#storage,
            wsManager: this.#wsManager,
            annotationManager: this.#annotationManager,
            noteManager: this.#noteManager,
            popoverManager: this.#popoverManager,
            visualZoomManager: this.#visualZoomManager,
            undoManager: this.#undoManager,
            shortcutsManager: this.#shortcutsManager,
            workspaceSpotlight: this.#workspaceSpotlight,
            tocNavigator: this.#tocNavigator,
            annotationNavigator: this.#annotationNavigator,
        };
    }
}

// Backward-compatible globals.
window.openEditorAtLine = function (line: number): void {
    if (window.markonApp) {
        window.markonApp.openEditorAtLine(line);
    }
};

window.clearPageAnnotations = function (event?: Event): void {
    if (window.markonApp) {
        void window.markonApp.clearAllAnnotations(event ?? null);
    }
};

window.markonExportNotes = function (anchor?: HTMLElement | null): void {
    if (window.markonApp) {
        window.markonApp.exportNotes(anchor ?? null);
    }
};

window.markonNotesCount = function (): number {
    return window.markonApp?.notesCount() ?? 0;
};

// Dev-only auto-reload: esbuild watcher pings /_/dev/reload-trigger after each
// rebuild; the server fans out to this SSE stream. Replaced by `false` in
// release builds, which lets the bundler dead-code-eliminate the whole block.
if (__DEV__) {
    const es = new EventSource('/_/dev/reload-stream');
    es.addEventListener('reload', () => {
        es.close();
        location.reload();
    });
}

document.addEventListener('DOMContentLoaded', () => {
    // Chat-only page: served by `/_/{ws}/chat` (template `chat.html`), opened
    // by ChatManager.#openPopout() into its own browser-level window. The
    // server-rendered HTML carries `<meta name="chat-only" content="1">`,
    // which is our signal to skip MarkonApp entirely (no markdown body, no
    // annotations, no popovers) and boot just the chat panel. The popout-mode
    // CSS in chat.css then grows the chat container to fill the viewport.
    if (Meta.flag(CONFIG.META_TAGS.CHAT_ONLY)) {
        const chat = new ChatManager(null);
        chat.initPopout();
        window.chatManager = chat;
        return;
    }

    const isSharedMode = Meta.flag(CONFIG.META_TAGS.SHARED_ANNOTATION);
    window.isSharedAnnotationMode = isSharedMode;

    // Intercept TOC anchor clicks to apply smooth scroll + history.pushState.
    document.addEventListener('click', (e) => {
        const target = e.target as Element | null;
        const link = target?.closest<HTMLAnchorElement>('a[href^="#"]');
        if (!link) return;

        const href = link.getAttribute('href');
        if (!href || href === '#') return;

        const targetId = href.substring(1);
        const targetElement = document.getElementById(targetId);

        if (targetElement) {
            e.preventDefault();
            targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
            history.pushState(null, '', href);
            if (window.__markonTocSetSelected) {
                window.__markonTocSetSelected(targetId);
            }
        }
    });

    // filePath is intentionally omitted — the constructor falls back to the
    // same meta tag (and then location.pathname) itself.
    const app = new MarkonApp({
        isSharedMode,
        enableSearch: Meta.flag(CONFIG.META_TAGS.ENABLE_SEARCH),
        enableEdit: Meta.flag(CONFIG.META_TAGS.ENABLE_EDIT),
        enableLive: Meta.flag(CONFIG.META_TAGS.ENABLE_LIVE),
    });

    window.markonApp = app;

    // Mount manager globals after init() resolves — `#initManagers()` runs
    // inside the async chain, so synchronous reads of `getManagers()` would
    // miss them.
    void app.init().then(() => {
        const managers = app.getManagers();
        if (managers.undoManager) window.undoManager = managers.undoManager;
        else delete window.undoManager;
        if (managers.tocNavigator) window.tocNavigator = managers.tocNavigator;
        else delete window.tocNavigator;
        if (managers.annotationNavigator) window.annotationNavigator = managers.annotationNavigator;
        else delete window.annotationNavigator;
        if (managers.shortcutsManager) window.shortcutsManager = managers.shortcutsManager;
        else delete window.shortcutsManager;
        Logger.log('MarkonApp', 'Application started successfully');
        // Deep-link into edit mode (e.g. from the diff file menu's "Edit file"),
        // optionally jumping to a 1-based line so editing from the diff lands
        // where the reviewer was looking.
        try {
            const params = new URLSearchParams(window.location.search);
            if (params.get('edit') === '1') {
                const line = parseInt(params.get('line') || '', 10);
                app.openEditorAtLine(Number.isFinite(line) && line > 0 ? line : 1);
            }
        } catch (_) {
            /* ignore malformed URLs */
        }
    });

    // Connect to per-workspace WebSocket — reload page when config flags change.
    const wsId = Meta.get(CONFIG.META_TAGS.WORKSPACE_ID);
    if (wsId) {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
        let attempt = 0;
        let stopped = false;
        const connectConfigWs = (): void => {
            if (stopped) return;
            const sock = new WebSocket(`${proto}//${location.host}/_/ws/${wsId}`);
            sock.onopen = () => {
                attempt = 0;
            };
            sock.onmessage = () => window.location.reload();
            sock.onclose = () => {
                if (stopped) return;
                const delay = Math.min(
                    CONFIG.WEBSOCKET.MAX_RECONNECT_DELAY,
                    CONFIG.WEBSOCKET.INITIAL_RECONNECT_DELAY * 2 ** attempt++,
                );
                reconnectTimer = setTimeout(connectConfigWs, delay);
            };
        };
        connectConfigWs();
        window.addEventListener('beforeunload', () => {
            stopped = true;
            if (reconnectTimer) clearTimeout(reconnectTimer);
        });
    }
});
