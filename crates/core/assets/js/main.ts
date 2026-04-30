/**
 * MarkonApp - Main application class.
 *
 * Wires every manager / navigator / component together, owns the document-
 * level event listeners and the reload-on-config WebSocket. ESM module —
 * loaded via `<script type="module">` from layout.html.
 */

import { CONFIG } from './core/config';
import { Logger } from './core/utils';
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
import { SearchManager } from './managers/search-manager';
import { HighlightManager } from './managers/highlight-manager';
import { EditorManager } from './managers/editor-manager';
import { CollaborationManager } from './managers/collaboration-manager';
import { ChatManager } from './managers/chat-manager';
import { TOCNavigator } from './navigators/toc-navigator';
import { AnnotationNavigator } from './navigators/annotation-navigator';
import { ModalManager, showConfirmDialog } from './components/modal';
import { FloatingLayer } from './components/floating-layer';

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
    undoManager: UndoManager | null;
    shortcutsManager: KeyboardShortcutsManager | null;
    searchManager: SearchManager | null;
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
    #undoManager: UndoManager | null = null;
    #shortcutsManager: KeyboardShortcutsManager | null = null;
    #searchManager: SearchManager | null = null;
    #editorManager: EditorManager | null = null;
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
        this.#markdownBody = document.querySelector<HTMLElement>(CONFIG.SELECTORS.MARKDOWN_BODY);

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
        this.#initSearch();
        this.#initKeyboardShortcuts();

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

                window.ws = this.#wsManager.getWebSocket() ?? undefined;

                if (window.viewedManager) {
                    if (this.#isSharedMode && !window.viewedManager.isSharedMode) {
                        window.viewedManager.isSharedMode = true;
                    }
                    if (!window.viewedManager.ws) {
                        window.viewedManager.ws = window.ws ?? null;
                        window.viewedManager.setupWebSocketListeners();
                    }
                }
            } catch (error) {
                Logger.error('MarkonApp', 'WebSocket connection failed:', error);
            }

            // Shared-annotation message handlers only when that feature is on.
            if (this.#isSharedMode) {
                this.#setupWebSocketHandlers();
            }

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

        this.#annotationManager = new AnnotationManager(
            // StorageManager satisfies the AnnotationStorage shape (loadAnnotations / saveAnnotation / …).
            this.#storage as unknown as ConstructorParameters<typeof AnnotationManager>[0],
            this.#markdownBody,
        );

        this.#noteManager = new NoteManager(this.#annotationManager, this.#markdownBody);

        this.#popoverManager = new PopoverManager(this.#markdownBody, {
            enableEdit: this.#enableEdit,
            enableChat: Meta.flag(CONFIG.META_TAGS.ENABLE_CHAT),
        });

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
            const markdownBody = target.closest('.markdown-body');
            if (!markdownBody) return;

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

            let heading: HTMLElement | null = target.closest<HTMLElement>('h1, h2, h3, h4, h5, h6');

            if (!heading) {
                const allHeadings = Array.from(
                    document.querySelectorAll<HTMLElement>(
                        '.markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4, .markdown-body h5, .markdown-body h6',
                    ),
                );
                const clickY = e.clientY + window.scrollY;

                for (let i = allHeadings.length - 1; i >= 0; i--) {
                    const h = allHeadings[i];
                    const hY = h.getBoundingClientRect().top + window.scrollY;
                    if (hY <= clickY) {
                        heading = h;
                        break;
                    }
                }
            }

            if (heading) {
                document.querySelectorAll('.heading-focused').forEach((el) => {
                    el.classList.remove('heading-focused');
                });
                heading.classList.add('heading-focused');
            }
        });
    }

    /** Register keyboard shortcuts. @private */
    #registerShortcuts(): void {
        const shortcuts = this.#shortcutsManager;
        if (!shortcuts) return;

        shortcuts.register('HELP', () => {
            shortcuts.showHelp();
        });

        if (this.#searchManager) {
            shortcuts.register('SEARCH', () => {
                this.#searchManager?.toggle();
            });
        }

        shortcuts.register('ESCAPE', () => {
            this.#handleEscapeKey();
        });

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
                const annotationId = highlightedElement.dataset.annotationId;
                if (annotationId) {
                    await annotationManager.delete(annotationId);
                    annotationManager.removeFromDOM(annotationId);
                    noteManager.render();

                    undoManager.push({
                        type: 'delete_annotation',
                        annotation: { id: annotationId } as Annotation,
                    });
                }
            }
        } else if (action.startsWith('highlight-')) {
            if (!selection) return;
            const annotation = annotationManager.createAnnotation(
                selection,
                action as Annotation['type'],
                CONFIG.HTML_TAGS.HIGHLIGHT as Annotation['tagName'],
            );
            await annotationManager.add(annotation);
            annotationManager.applyToDOM([annotation]);

            undoManager.push({
                type: 'add_annotation',
                annotation,
            });
        } else if (action === 'strikethrough') {
            if (!selection) return;
            const annotation = annotationManager.createAnnotation(
                selection,
                CONFIG.ANNOTATION_TYPES.STRIKETHROUGH as Annotation['type'],
                CONFIG.HTML_TAGS.STRIKETHROUGH as Annotation['tagName'],
            );
            await annotationManager.add(annotation);
            annotationManager.applyToDOM([annotation]);

            undoManager.push({
                type: 'add_annotation',
                annotation,
            });
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
            onSave: async (noteText: string) => {
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
                        await annotationManager.add(newAnnotation);
                        annotationManager.applyToDOM([newAnnotation]);

                        undoManager.push({
                            type: 'add_annotation',
                            annotation: newAnnotation,
                        });
                    }

                    noteManager.render();
                } else if (annotation) {
                    await annotationManager.delete(annotation.id);
                    annotationManager.removeFromDOM(annotation.id);
                    noteManager.render();
                }

                cleanupOverlays();
                window.getSelection()?.removeAllRanges();
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

        ws.on('all_annotations', (message) => {
            if (!annotationManager || !noteManager) return;
            annotationManager.clearDOM();
            const annotations = (message.annotations ?? []) as Annotation[];
            annotations.forEach((anno) => {
                void annotationManager.add(anno, true); // skipSave=true: from remote
            });
            annotationManager.applyToDOM();
            noteManager.render();
        });

        ws.on('new_annotation', (message) => {
            if (!annotationManager || !noteManager) return;
            const incoming = message.annotation as Annotation;
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
            void annotationManager.delete(message.id, true);
            annotationManager.removeFromDOM(message.id);
            noteManager.render();
        });

        ws.on('clear_annotations', () => {
            if (!annotationManager || !noteManager) return;
            Logger.log('MarkonApp', 'Received CLEAR_ANNOTATIONS broadcast from server');
            void annotationManager.clear(true);
            annotationManager.clearDOM();
            noteManager.clear();
            Logger.log('MarkonApp', 'Cleared annotations from broadcast, no reload needed');
        });
    }

    /** Setup note click handlers. @private */
    #setupNoteClickHandlers(): void {
        document.body.addEventListener('click', async (e) => {
            const target = e.target as HTMLElement | null;
            if (!target || !this.#annotationManager || !this.#noteManager || !this.#undoManager) return;

            // Edit button
            if (target.classList.contains('note-edit')) {
                const annotationId = target.dataset.annotationId;
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
            if (target.classList.contains('note-delete')) {
                const annotationId = target.dataset.annotationId;
                if (!annotationId) return;
                showConfirmDialog(
                    'Delete this note?',
                    async () => {
                        if (!this.#annotationManager || !this.#noteManager || !this.#undoManager) return;
                        await this.#annotationManager.delete(annotationId);
                        this.#annotationManager.removeFromDOM(annotationId);
                        this.#noteManager.render();

                        document.querySelector('.note-popup')?.remove();

                        this.#undoManager.push({
                            type: 'delete_annotation',
                            annotation: { id: annotationId } as Annotation,
                        });
                    },
                    target,
                    'Delete',
                );
                e.stopPropagation();
                return;
            }

            // Click on a note element
            if (target.classList.contains('has-note')) {
                const annotationId = target.dataset.annotationId;
                if (!annotationId) return;
                target.classList.add('highlight-active');

                if (window.innerWidth > CONFIG.BREAKPOINTS.WIDE_SCREEN) {
                    // Wide screen: highlight margin note card
                    const noteCard = document.querySelector<HTMLElement>(
                        `.note-card-margin[data-annotation-id="${annotationId}"]`,
                    );
                    if (noteCard) {
                        noteCard.classList.add('highlight-active');
                        const noteRect = noteCard.getBoundingClientRect();
                        if (noteRect.top < 0 || noteRect.bottom > window.innerHeight) {
                            noteCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        }
                    }
                } else {
                    // Narrow screen: show popup
                    this.#noteManager.showNotePopup(target, annotationId);
                }

                e.stopPropagation();
            }
        });
    }

    /** Setup TOC events. @private */
    #setupTOCEvents(): void {
        const tocIcon = document.querySelector<HTMLElement>(CONFIG.SELECTORS.TOC_ICON);
        const tocContainer = document.querySelector<HTMLElement>(CONFIG.SELECTORS.TOC_CONTAINER);

        if (!tocIcon || !tocContainer) return;

        // Mutual exclusion: collapse other floating layers before opening ToC.
        const toggleToc = (e: Event): void => {
            const willOpen = !tocContainer.classList.contains('active');
            if (willOpen) {
                for (const peer of FloatingLayer.all()) {
                    if (peer.name !== 'toc' && peer.isExpanded) peer.collapse();
                }
            }
            tocContainer.classList.toggle('active');
            e.stopPropagation();
            e.preventDefault();
        };

        tocIcon.addEventListener('click', toggleToc);
        tocIcon.addEventListener('touchend', toggleToc);

        // External click closes ToC.
        const closeToc = (e: Event): void => {
            const target = e.target as Node | null;
            if (tocContainer.classList.contains('active') && target && !tocContainer.contains(target)) {
                tocContainer.classList.remove('active');
            }
        };

        document.addEventListener('click', closeToc);
        document.addEventListener('touchend', closeToc);

        // Register ToC as a passive obstacle so Live/Chat avoid it.
        const tocLayer = new FloatingLayer({
            name: 'toc',
            container: tocContainer,
            passive: true,
            expandedClass: 'active',
            getObstacleRect: () => {
                const active = tocContainer.classList.contains('active');
                const target = active ? tocContainer.querySelector('.toc') : tocIcon;
                if (!target) return null;
                const r = (target as HTMLElement).getBoundingClientRect();
                return r.width === 0 || r.height === 0 ? null : r;
            },
            collapseExpanded: () => tocContainer.classList.remove('active'),
        });
        tocLayer.init();

        this.#fixTocLinks();
    }

    /** Fix TOC links — intercept anchor navigation, smart-scroll, sync TOC. @private */
    #fixTocLinks(): void {
        const tocItems = document.querySelectorAll<HTMLAnchorElement>('.toc-item a');
        tocItems.forEach((item) => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();

                const href = item.getAttribute('href');
                if (!href) return;
                history.pushState(null, '', href);

                const targetId = href.substring(1);
                const targetElement = document.getElementById(targetId);
                if (targetElement) {
                    document.querySelectorAll('.heading-focused').forEach((el) => {
                        el.classList.remove('heading-focused');
                    });

                    targetElement.classList.add('heading-focused');

                    Position.smartScrollToHeading(targetElement);
                }

                const tocContainer = document.querySelector(CONFIG.SELECTORS.TOC_CONTAINER);
                if (tocContainer && window.innerWidth <= CONFIG.BREAKPOINTS.WIDE_SCREEN) {
                    tocContainer.classList.remove('active');
                }
            });
        });
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

            if (this.#popoverManager?.isVisible()) {
                this.#popoverManager.hide();
                window.getSelection()?.removeAllRanges();
            }

            // Click outside .markdown-body cancels the focused heading.
            if (!target.closest('.markdown-body')) {
                const focusedHeadings = document.querySelectorAll('.heading-focused');
                if (focusedHeadings.length > 0) {
                    focusedHeadings.forEach((el) => {
                        el.classList.remove('heading-focused');
                    });
                    Logger.log('MarkonApp', 'Cleared heading focus (clicked outside markdown-body)');
                }
            }
        };

        document.addEventListener('mousedown', hideOnOutsideClick);
        document.addEventListener('touchstart', hideOnOutsideClick, { passive: true });
    }

    /**
     * Cancellable smooth scroll.
     * @private
     */
    #smoothScrollBy(distance: number, duration: number = 800): void {
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
        if (!operation || !this.#annotationManager || !this.#noteManager) return;
        const annotation = operation.annotation as Annotation;

        switch (operation.type) {
            case 'add_annotation':
                await this.#annotationManager.delete(annotation.id);
                this.#annotationManager.removeFromDOM(annotation.id);
                this.#noteManager.render();
                break;
            case 'delete_annotation':
                await this.#annotationManager.add(annotation);
                this.#annotationManager.applyToDOM([annotation]);
                this.#noteManager.render();
                break;
        }
    }

    /** Handle Redo. @private */
    async #handleRedo(): Promise<void> {
        const operation: UndoOperation | null = this.#undoManager?.redo() ?? null;
        if (!operation || !this.#annotationManager || !this.#noteManager) return;
        const annotation = operation.annotation as Annotation;

        switch (operation.type) {
            case 'add_annotation':
                await this.#annotationManager.add(annotation);
                this.#annotationManager.applyToDOM([annotation]);
                this.#noteManager.render();
                break;
            case 'delete_annotation':
                await this.#annotationManager.delete(annotation.id);
                this.#annotationManager.removeFromDOM(annotation.id);
                this.#noteManager.render();
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
            document.querySelectorAll('.heading-focused').forEach((el) => {
                el.classList.remove('heading-focused');
            });
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
        if (!focusedHeading || !focusedHeading.id) return;

        this.#toggleSectionCollapse(focusedHeading);
    }

    /** Toggle the given heading's section collapse state. @private */
    #toggleSectionCollapse(heading: HTMLElement | null): void {
        if (!heading || !heading.id) return;

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

    /** Initialize search. @private */
    #initSearch(): void {
        if (this.#enableSearch) {
            this.#searchManager = new SearchManager();
            window.searchManager = this.#searchManager;
            Logger.log('MarkonApp', 'SearchManager initialized');
        }

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

    /** Manager snapshot — used for window globals + debug. */
    getManagers(): ManagerSnapshot {
        return {
            storage: this.#storage,
            wsManager: this.#wsManager,
            annotationManager: this.#annotationManager,
            noteManager: this.#noteManager,
            popoverManager: this.#popoverManager,
            undoManager: this.#undoManager,
            shortcutsManager: this.#shortcutsManager,
            searchManager: this.#searchManager,
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
    // Chat-only page: served by `/{ws}/_/chat` (template `chat.html`), opened
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

    const app = new MarkonApp({
        filePath: Meta.get(CONFIG.META_TAGS.FILE_PATH) ?? undefined,
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
        window.undoManager = managers.undoManager ?? undefined;
        window.tocNavigator = managers.tocNavigator ?? undefined;
        window.annotationNavigator = managers.annotationNavigator ?? undefined;
        window.shortcutsManager = managers.shortcutsManager ?? undefined;
        Logger.log('MarkonApp', 'Application started successfully');
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
                const delay = Math.min(30000, 1000 * 2 ** attempt++);
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
