/**
 * MarkonApp - Main application class
 * Integrates all modules with unified initialization and management
 */

import { CONFIG } from './core/config.js';
import { Logger } from './core/utils.js';
import { Position } from './services/position.js';
import { Text } from './services/text.js';
import { StorageManager } from './managers/storage-manager.js';
import { WebSocketManager } from './managers/websocket-manager.js';
import { AnnotationManager } from './managers/annotation-manager.js';
import { NoteManager } from './managers/note-manager.js';
import { PopoverManager } from './managers/popover-manager.js';
import { UndoManager } from './managers/undo-manager.js';
import { KeyboardShortcutsManager } from './managers/keyboard-shortcuts.js';
import { SearchManager } from './managers/search-manager.js';
import { HighlightManager } from './managers/highlight-manager.js';
import { EditorManager } from './managers/editor-manager.js';
import { CollaborationManager } from './managers/collaboration-manager.js';
import { TOCNavigator } from './navigators/toc-navigator.js';
import { AnnotationNavigator } from './navigators/annotation-navigator.js';
import { ModalManager, showConfirmDialog } from './components/modal.js';

/**
 * Markon Main application class
 */
export class MarkonApp {
    // Manager instances
    #storage;
    #wsManager;
    #annotationManager;
    #noteManager;
    #popoverManager;
    #undoManager;
    #shortcutsManager;
    #searchManager;
    #editorManager;
    #collaboration;
    #tocNavigator;
    #annotationNavigator;

    // DOM elements
    #markdownBody;
    #filePath;
    #isSharedMode;
    #enableSearch;
    #enableEdit;
    #enableLive;

    // Scroll control
    #scrollAnimationId = null;
    #scrollCancelled = false;

    constructor(config = {}) {
        this.#filePath = config.filePath || this.#getFilePathFromMeta();
        this.#isSharedMode = config.isSharedMode || false;
        this.#enableSearch = config.enableSearch || false;
        this.#enableEdit = config.enableEdit || false;
        this.#markdownBody = document.querySelector(CONFIG.SELECTORS.MARKDOWN_BODY);

        if (!this.#markdownBody) {
            Logger.warn('MarkonApp', 'Markdown body not found, will initialize minimal features');
        } else {
            Logger.log('MarkonApp', 'Initializing...', {
                filePath: this.#filePath,
                isSharedMode: this.#isSharedMode
            });
        }
    }

    /**
     * Initialize application
     */
    async init() {
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

        // 6. Initialize search
        this.#initSearch();

        // 7. Register keyboard shortcuts
        this.#registerShortcuts();

        // 8. Fix TOC HTML entities
        this.#fixTocHtmlEntities();

        // 9. Update clear button text
        this.#updateClearButtonText();

        // 10. Start collaboration
        this.#collaboration.init();

        Logger.log('MarkonApp', 'Initialization complete');
    }

    /**
     * Initialize storage
     * @private
     */
    async #initStorage() {
        if (this.#isSharedMode) {
            // Shared mode: initialize WebSocket
            this.#wsManager = new WebSocketManager(this.#filePath);

            try {
                await this.#wsManager.connect();
                Logger.log('MarkonApp', 'WebSocket connected');

                // Expose native WebSocket object for viewed.js
                window.ws = this.#wsManager.getWebSocket();
                Logger.log('MarkonApp', 'Exposed WebSocket to window.ws for viewed.js');

                // If viewedManager already exists, update its configuration
                if (window.viewedManager) {
                    // Update isSharedMode (may be false during initialization)
                    if (!window.viewedManager.isSharedMode) {
                        window.viewedManager.isSharedMode = true;
                        Logger.log('MarkonApp', 'Updated viewedManager.isSharedMode to true');
                    }
                    // Update WebSocket connection
                    if (!window.viewedManager.ws) {
                        window.viewedManager.ws = window.ws;
                        window.viewedManager.setupWebSocketListeners();
                        Logger.log('MarkonApp', 'Updated viewedManager with WebSocket connection');
                    }
                }
            } catch (error) {
                Logger.error('MarkonApp', 'WebSocket connection failed:', error);
            }

            // Setup WebSocket message handlers
            this.#setupWebSocketHandlers();
        }

        // Create storage manager (auto-select strategy)
        this.#storage = new StorageManager(this.#filePath, this.#isSharedMode, this.#wsManager);
    }

    /**
     * Initialize managers
     * @private
     */
    #initManagers() {
        // Annotation manager
        this.#annotationManager = new AnnotationManager(this.#storage, this.#markdownBody);

        // Note manager
        this.#noteManager = new NoteManager(this.#annotationManager, this.#markdownBody);

        // Popover manager
        this.#popoverManager = new PopoverManager(this.#markdownBody, { enableEdit: this.#enableEdit });

        // Undo manager
        this.#undoManager = new UndoManager();

        // Navigators
        this.#tocNavigator = new TOCNavigator();
        this.#annotationNavigator = new AnnotationNavigator();

        // Collaboration
        this.#collaboration = new CollaborationManager(this);

        // Setup popover action callbacks
        this.#popoverManager.onAction((action, data) => {
            this.#handlePopoverAction(action, data);
        });

        Logger.log('MarkonApp', 'Managers initialized');
    }

    /**
     * Initialize keyboard shortcuts (works without markdown body)
     * @private
     */
    #initKeyboardShortcuts() {
        if (!this.#shortcutsManager) {
            this.#shortcutsManager = new KeyboardShortcutsManager();
            Logger.log('MarkonApp', 'KeyboardShortcutsManager initialized');
        }
    }

    /**
     * Load data
     * @private
     */
    async #loadData() {
        await this.#annotationManager.load();
        Logger.log('MarkonApp', `Loaded ${this.#annotationManager.getAll().length} annotations`);
    }

    /**
     * Apply to DOM
     * @private
     */
    #applyToDOM() {
        // Apply annotations
        this.#annotationManager.applyToDOM();

        // Render note cards
        this.#noteManager.render();
        this.#noteManager.setupResponsiveLayout();
    }

    /**
     * Setup keyboard event listener (used in both directory and document modes)
     * @private
     */
    #setupKeyboardEventListener() {
        document.addEventListener('keydown', (e) => {
            this.#shortcutsManager.handle(e);
        });
        Logger.log('MarkonApp', 'Keyboard event listener setup complete');
    }

    /**
     * Setup event listeners
     * @private
     */
    #setupEventListeners() {
        // SelectEvent
        document.addEventListener('mouseup', (e) => {
            this.#popoverManager.handleSelection(e);
        });

        document.addEventListener('touchend', (e) => {
            this.#popoverManager.handleSelection(e);
        });

        // Click on highlighted element
        document.addEventListener('click', (e) => {
            const isHighlighted = e.target.closest(CONFIG.SELECTORS.HIGHLIGHT_CLASSES);
            if (isHighlighted) {
                this.#popoverManager.handleHighlightClick(isHighlighted);
            }
        });

        // Note card click event
        this.#setupNoteClickHandlers();

        // TOC RelatedEvent
        this.#setupTOCEvents();

        // 鼠标点击章节聚焦
        this.#setupHeadingClickFocus();

        // 双击HeadingToggle折叠/展开（viewed Mode启用时）
        if (document.querySelector('meta[name="enable-viewed"]')) {
            this.#setupHeadingDoubleClick();
        }

        // 全局键盘Event
        this.#setupKeyboardEventListener();

        // 外部点击Hide弹出框
        this.#setupOutsideClickHandler();

        Logger.log('MarkonApp', 'Event listeners setup complete');
    }

    #setupHeadingClickFocus() {
        document.addEventListener('click', (e) => {
            const markdownBody = e.target.closest('.markdown-body');
            if (!markdownBody) return;

            const target = e.target;
            if (target.tagName === 'A' ||
                target.tagName === 'BUTTON' ||
                target.tagName === 'INPUT' ||
                target.tagName === 'TEXTAREA' ||
                target.closest('.selection-popover') ||
                target.closest('.note-input-modal') ||
                target.closest('.note-card-margin') ||
                target.closest('.note-popup')) {
                return;
            }

            let heading = target.closest('h1, h2, h3, h4, h5, h6');

            if (!heading) {
                const allHeadings = Array.from(document.querySelectorAll('.markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4, .markdown-body h5, .markdown-body h6'));
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
                document.querySelectorAll('.heading-focused').forEach(el => {
                    el.classList.remove('heading-focused');
                });
                heading.classList.add('heading-focused');
            }
        });
    }

    /**
     * Register keyboard shortcuts
     * @private
     */
    #registerShortcuts() {
        // 核心快捷键
        this.#shortcutsManager.register('HELP', () => {
            this.#shortcutsManager.showHelp();
        });

        if (this.#searchManager) {
            this.#shortcutsManager.register('SEARCH', () => {
                this.#searchManager.toggle();
            });
        }

        this.#shortcutsManager.register('ESCAPE', () => {
            this.#handleEscapeKey();
        });

        this.#shortcutsManager.register('TOGGLE_TOC', () => {
            this.#toggleTOC();
        });

        // Undo/Redo
        this.#shortcutsManager.register('UNDO', () => {
            this.#handleUndo();
        });

        this.#shortcutsManager.register('REDO', () => {
            this.#handleRedo();
        });

        this.#shortcutsManager.register('REDO_ALT', () => {
            this.#handleRedo();
        });

        // Navigation
        this.#shortcutsManager.register('NEXT_HEADING', () => {
            Logger.log('MarkonApp', 'NEXT_HEADING triggered');
            this.#navigateHeading('next');
        });

        this.#shortcutsManager.register('PREV_HEADING', () => {
            Logger.log('MarkonApp', 'PREV_HEADING triggered');
            this.#navigateHeading('prev');
        });

        this.#shortcutsManager.register('NEXT_ANNOTATION', () => {
            this.#annotationNavigator.next();
        });

        this.#shortcutsManager.register('PREV_ANNOTATION', () => {
            this.#annotationNavigator.previous();
        });

        this.#shortcutsManager.register('SCROLL_HALF_PAGE_DOWN', () => {
            // 使用自定义滚动，1/3 页，持续Time 500ms
            this.#smoothScrollBy(window.innerHeight / 3, 500);
        });

        // Viewed 快捷键（如果启用）
        if (document.querySelector('meta[name="enable-viewed"]')) {
            this.#shortcutsManager.register('TOGGLE_VIEWED', () => {
                this.#toggleCurrentSectionViewed();
            });

            this.#shortcutsManager.register('TOGGLE_SECTION_COLLAPSE', () => {
                this.#toggleCurrentSectionCollapse();
            });
        }

        // Edit shortcuts (if enabled)
        if (this.#enableEdit) {
            this.#shortcutsManager.register('EDIT', () => {
                this.#openEditor();
            });
        }

        Logger.log('MarkonApp', 'Shortcuts registered');
    }

    /**
     * Handle弹出框动作
     * @private
     */
    async #handlePopoverAction(action, data) {
        const { selection, highlightedElement } = data;

        if (action === 'unhighlight') {
            // 移除Highlight
            if (highlightedElement) {
                const annotationId = highlightedElement.dataset.annotationId;
                await this.#annotationManager.delete(annotationId);
                this.#annotationManager.removeFromDOM(annotationId);
                this.#noteManager.render();

                // 记录Undo
                this.#undoManager.push({
                    type: 'delete_annotation',
                    annotation: { id: annotationId }
                });
            }
        } else if (action.startsWith('highlight-')) {
            // 添加Highlight
            const annotation = this.#annotationManager.createAnnotation(
                selection,
                action,
                CONFIG.HTML_TAGS.HIGHLIGHT
            );
            await this.#annotationManager.add(annotation);
            this.#annotationManager.applyToDOM([annotation]);

            // 记录Undo
            this.#undoManager.push({
                type: 'add_annotation',
                annotation: annotation
            });
        } else if (action === 'strikethrough') {
            // 添加Delete线
            const annotation = this.#annotationManager.createAnnotation(
                selection,
                CONFIG.ANNOTATION_TYPES.STRIKETHROUGH,
                CONFIG.HTML_TAGS.STRIKETHROUGH
            );
            await this.#annotationManager.add(annotation);
            this.#annotationManager.applyToDOM([annotation]);

            // 记录Undo
            this.#undoManager.push({
                type: 'add_annotation',
                annotation: annotation
            });
        } else if (action === 'add-note') {
            // 添加Note - 不ClearSelect，保持选中State直到模态框Close
            this.#showNoteInputModal(selection);
            return; // 提前Return，不ClearSelect
        } else if (action === 'edit') {
            // Open editor with selected text
            const selectedText = selection.toString().trim();
            if (!this.#editorManager) {
                this.#editorManager = new EditorManager(this.#filePath);
            }
            this.#editorManager.open({ selectedText: selectedText });
            return; // Don't clear selection until editor opens
        }

        // ClearSelect（add-note 和 edit 操作除外）
        window.getSelection().removeAllRanges();
    }

    /**
     * ShowNoteInput模态框
     * @private
     */
    #showNoteInputModal(selection, annotation = null) {
        // Create临时Highlight覆盖层来Show选中的Text
        // （不能使用真实的 selection 因为会与 textarea 焦点Conflict）
        const createSelectionOverlay = () => {
            const rects = selection.getClientRects();
            const overlays = [];

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
                overlay.style.zIndex = '9998'; // 在 modal (9999) 下方，但在Content上方
                document.body.appendChild(overlay);
                overlays.push(overlay);
            }
            return overlays;
        };

        const selectionOverlays = createSelectionOverlay();

        // 清理覆盖层的辅助函数
        const cleanupOverlays = () => {
            selectionOverlays.forEach(overlay => overlay.remove());
        };

        // GetSelect位置（用于模态框定位）
        const rect = selection.getBoundingClientRect();
        const anchorElement = {
            getBoundingClientRect: () => rect
        };

        const modal = ModalManager.showNoteInput({
            anchorElement,
            initialValue: annotation ? annotation.note : '',
            onSave: async (noteText) => {
                if (noteText) {
                    if (annotation) {
                        // Edit现有Note
                        annotation.note = noteText;
                        await this.#annotationManager.add(annotation);
                    } else {
                        // Create新Note
                        const newAnnotation = this.#annotationManager.createAnnotation(
                            selection,
                            CONFIG.ANNOTATION_TYPES.HAS_NOTE,
                            CONFIG.HTML_TAGS.HIGHLIGHT,
                            noteText
                        );
                        await this.#annotationManager.add(newAnnotation);
                        this.#annotationManager.applyToDOM([newAnnotation]);

                        // 记录Undo
                        this.#undoManager.push({
                            type: 'add_annotation',
                            annotation: newAnnotation
                        });
                    }

                    // 重新Render note cards
                    this.#noteManager.render();
                } else if (annotation) {
                    // DeleteNote（如果Text为空）
                    await this.#annotationManager.delete(annotation.id);
                    this.#annotationManager.removeFromDOM(annotation.id);
                    this.#noteManager.render();
                }

                // Save后清理覆盖层和Select
                cleanupOverlays();
                window.getSelection().removeAllRanges();
            },
            onCancel: () => {
                // Cancel时清理覆盖层和Select
                cleanupOverlays();
                window.getSelection().removeAllRanges();
            }
        });
    }

    /**
     * Settings WebSocket Handle器
     * @private
     */
    #setupWebSocketHandlers() {
        if (!this.#wsManager) return;

        this.#wsManager.on(CONFIG.WS_MESSAGE_TYPES.ALL_ANNOTATIONS, (message) => {
            this.#annotationManager.clearDOM();
            const annotations = message.annotations || [];
            annotations.forEach(anno => {
                this.#annotationManager.add(anno, true); // skipSave=true: from remote
            });
            this.#annotationManager.applyToDOM();
            this.#noteManager.render();
        });

        this.#wsManager.on(CONFIG.WS_MESSAGE_TYPES.NEW_ANNOTATION, (message) => {
            // Check是否已存在（Local刚Create的标注）
            const existingAnnotation = this.#annotationManager.getById(message.annotation.id);
            if (existingAnnotation) {
                // 已存在，说明是LocalCreate的，SkipHandle
                Logger.log('WebSocket', `Annotation ${message.annotation.id} already exists locally, skipping`);
                return;
            }

            // 从远程客户端Create的新标注
            this.#annotationManager.add(message.annotation, true); // skipSave=true: from remote
            this.#annotationManager.applyToDOM([message.annotation]);
            this.#noteManager.render();
        });

        this.#wsManager.on(CONFIG.WS_MESSAGE_TYPES.DELETE_ANNOTATION, (message) => {
            this.#annotationManager.delete(message.id, true); // skipSave=true: from remote
            this.#annotationManager.removeFromDOM(message.id);
            this.#noteManager.render();
        });

        this.#wsManager.on(CONFIG.WS_MESSAGE_TYPES.CLEAR_ANNOTATIONS, () => {
            Logger.log('MarkonApp', 'Received CLEAR_ANNOTATIONS broadcast from server');
            this.#annotationManager.clear(true); // skipSave=true: from remote
            this.#annotationManager.clearDOM();
            this.#noteManager.clear();
            Logger.log('MarkonApp', 'Cleared annotations from broadcast, no reload needed');
        });
    }

    /**
     * SettingsNote点击Handle器
     * @private
     */
    #setupNoteClickHandlers() {
        document.body.addEventListener('click', async (e) => {
            // EditButton
            if (e.target.classList.contains('note-edit')) {
                const annotationId = e.target.dataset.annotationId;
                const annotation = this.#annotationManager.getById(annotationId);
                if (annotation) {
                    // 关闭 note-popup
                    const popup = document.querySelector('.note-popup');
                    if (popup) popup.remove();

                    const highlightElement = this.#markdownBody.querySelector(`[data-annotation-id="${annotationId}"]`);
                    if (highlightElement) {
                        const range = document.createRange();
                        range.selectNodeContents(highlightElement);
                        this.#showNoteInputModal(range, annotation);
                    }
                }
                e.stopPropagation();
                return;
            }

            // DeleteButton
            if (e.target.classList.contains('note-delete')) {
                const annotationId = e.target.dataset.annotationId;
                showConfirmDialog('Delete this note?', async () => {
                    await this.#annotationManager.delete(annotationId);
                    this.#annotationManager.removeFromDOM(annotationId);
                    this.#noteManager.render();

                    // Close窄屏Mode下的NoteModal
                    const popup = document.querySelector('.note-popup');
                    if (popup) popup.remove();

                    // 记录Undo
                    this.#undoManager.push({
                        type: 'delete_annotation',
                        annotation: { id: annotationId }
                    });
                }, e.target, 'Delete');
                e.stopPropagation();
                return;
            }

            // 点击NoteElement
            if (e.target.classList.contains('has-note')) {
                const annotationId = e.target.dataset.annotationId;
                e.target.classList.add('highlight-active');

                // 响应式Handle
                if (window.innerWidth > CONFIG.BREAKPOINTS.WIDE_SCREEN) {
                    // 宽屏：HighlightNote卡
                    const noteCard = document.querySelector(`.note-card-margin[data-annotation-id="${annotationId}"]`);
                    if (noteCard) {
                        noteCard.classList.add('highlight-active');
                        const noteRect = noteCard.getBoundingClientRect();
                        if (noteRect.top < 0 || noteRect.bottom > window.innerHeight) {
                            noteCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        }
                    }
                } else {
                    // 窄屏：ShowModal
                    this.#noteManager.showNotePopup(e.target, annotationId);
                }

                e.stopPropagation();
            }
        });
    }

    /**
     * Settings TOC Event
     * @private
     */
    #setupTOCEvents() {
        const tocIcon = document.querySelector(CONFIG.SELECTORS.TOC_ICON);
        const tocContainer = document.querySelector(CONFIG.SELECTORS.TOC_CONTAINER);

        if (!tocIcon || !tocContainer) return;

        // Toggle TOC
        const toggleToc = (e) => {
            tocContainer.classList.toggle('active');
            e.stopPropagation();
            e.preventDefault();
        };

        tocIcon.addEventListener('click', toggleToc);
        tocIcon.addEventListener('touchend', toggleToc);

        // 外部点击Close
        const closeToc = (e) => {
            if (tocContainer.classList.contains('active') && !tocContainer.contains(e.target)) {
                tocContainer.classList.remove('active');
            }
        };

        document.addEventListener('click', closeToc);
        document.addEventListener('touchend', closeToc);

        // TOC Link点击
        this.#fixTocLinks();
    }

    /**
     * 修复 TOC Link
     * @private
     */
    #fixTocLinks() {
        const tocItems = document.querySelectorAll('.toc-item a');
        tocItems.forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();

                const href = item.getAttribute('href');
                history.pushState(null, '', href);

                const targetId = href.substring(1);
                const targetElement = document.getElementById(targetId);
                if (targetElement) {
                    // 移除之前的Highlight
                    document.querySelectorAll('.heading-focused').forEach(el => {
                        el.classList.remove('heading-focused');
                    });

                    // 添加Highlight
                    targetElement.classList.add('heading-focused');

                    // 智能滚动
                    Position.smartScrollToHeading(targetElement);
                }

                // move设备Close TOC
                const tocContainer = document.querySelector(CONFIG.SELECTORS.TOC_CONTAINER);
                if (tocContainer && window.innerWidth <= CONFIG.BREAKPOINTS.WIDE_SCREEN) {
                    tocContainer.classList.remove('active');
                }
            });
        });
    }

    /**
     * Fix TOC HTML entities
     * @private
     */
    #fixTocHtmlEntities() {
        const toc = document.querySelector('.toc');
        if (!toc) return;

        const tocItems = toc.querySelectorAll('.toc-item a');
        tocItems.forEach(item => {
            const text = item.textContent;
            const decoded = Text.decodeEntities(text);
            if (text !== decoded) {
                item.textContent = decoded;
            }
        });
    }

    /**
     * Update clear button text（Show local/shared Mode）
     * @private
     */
    #updateClearButtonText() {
        const clearButton = document.querySelector('.footer-clear-link');
        if (clearButton) {
            const mode = this.#isSharedMode ? 'shared' : 'local';
            clearButton.textContent = `Clear Annotations(${mode}) in this page`;
        }
    }

    /**
     * Settings外部点击Handle器
     * @private
     */
    #setupOutsideClickHandler() {
        const hideOnOutsideClick = (e) => {
            if (e.target.closest('.selection-popover') ||
                e.target.closest('#toc-container') ||
                e.target.closest('.note-card-margin') ||
                e.target.closest('.note-popup') ||
                e.target.closest('.note-input-modal')) {
                return;
            }

            // HideSelectModal
            if (this.#popoverManager.isVisible()) {
                this.#popoverManager.hide();
                window.getSelection().removeAllRanges();
            }

            // 如果点击在正文区域之外，Cancel当前焦点章节
            if (!e.target.closest('.markdown-body')) {
                const focusedHeadings = document.querySelectorAll('.heading-focused');
                if (focusedHeadings.length > 0) {
                    focusedHeadings.forEach(el => {
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
     * 可中断的平滑滚动
     * @private
     * @param {number} distance - 滚动距离（像素）
     * @param {number} duration - 滚动持续Time（毫秒）
     */
    #smoothScrollBy(distance, duration = 800) {
        // Cancel之前的滚动
        if (this.#scrollAnimationId) {
            cancelAnimationFrame(this.#scrollAnimationId);
            this.#scrollAnimationId = null;
        }

        this.#scrollCancelled = false;
        const startPosition = window.pageYOffset;
        const startTime = performance.now();

        const easeInOutCubic = (t) => {
            return t < 0.5
                ? 4 * t * t * t
                : 1 - Math.pow(-2 * t + 2, 3) / 2;
        };

        const scroll = (currentTime) => {
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

    /**
     * Cancel滚动动画
     * @private
     */
    #cancelScroll() {
        if (this.#scrollAnimationId) {
            this.#scrollCancelled = true;
            cancelAnimationFrame(this.#scrollAnimationId);
            this.#scrollAnimationId = null;
            return true;
        }
        return false;
    }

    /**
     * Handle Escape 键
     * @private
     */
    #handleEscapeKey() {
        // Cancel滚动动画
        if (this.#cancelScroll()) {
            return;
        }
        // CloseHelpPanel
        const helpPanel = document.querySelector('.shortcuts-help-panel');
        if (helpPanel) {
            helpPanel.classList.remove('visible');
            setTimeout(() => helpPanel.remove(), CONFIG.ANIMATION.PANEL_TRANSITION);
            return;
        }

        // Close TOC
        const tocContainer = document.querySelector(CONFIG.SELECTORS.TOC_CONTAINER);
        if (tocContainer && tocContainer.classList.contains('active')) {
            tocContainer.classList.remove('active');
            return;
        }

        // Hide弹出框
        if (this.#popoverManager.isVisible()) {
            this.#popoverManager.hide();
            window.getSelection().removeAllRanges();
            return;
        }

        // ClearSelect
        window.getSelection().removeAllRanges();
    }

    /**
     * Toggle TOC
     * @private
     */
    #toggleTOC() {
        const tocContainer = document.querySelector(CONFIG.SELECTORS.TOC_CONTAINER);
        if (!tocContainer) return;

        const isNarrowScreen = window.innerWidth <= CONFIG.BREAKPOINTS.WIDE_SCREEN;
        const tocVisible = tocContainer.classList.contains('active') || !isNarrowScreen;
        const navActive = this.#tocNavigator.active;

        if (navActive) {
            this.#tocNavigator.deactivate();
            if (isNarrowScreen) {
                tocContainer.classList.remove('active');
            }
        } else {
            if (isNarrowScreen && !tocVisible) {
                tocContainer.classList.add('active');
            }
            this.#tocNavigator.activate();
        }
    }

    /**
     * HandleUndo
     * @private
     */
    async #handleUndo() {
        const operation = this.#undoManager.undo();
        if (!operation) return;

        switch (operation.type) {
        case 'add_annotation':
            await this.#annotationManager.delete(operation.annotation.id);
            this.#annotationManager.removeFromDOM(operation.annotation.id);
            this.#noteManager.render();
            break;
        case 'delete_annotation':
            await this.#annotationManager.add(operation.annotation);
            this.#annotationManager.applyToDOM([operation.annotation]);
            this.#noteManager.render();
            break;
        }
    }

    /**
     * HandleRedo
     * @private
     */
    async #handleRedo() {
        const operation = this.#undoManager.redo();
        if (!operation) return;

        switch (operation.type) {
        case 'add_annotation':
            await this.#annotationManager.add(operation.annotation);
            this.#annotationManager.applyToDOM([operation.annotation]);
            this.#noteManager.render();
            break;
        case 'delete_annotation':
            await this.#annotationManager.delete(operation.annotation.id);
            this.#annotationManager.removeFromDOM(operation.annotation.id);
            this.#noteManager.render();
            break;
        }
    }

    /**
     * CheckHeading是否在折叠的章节内
     * @private
     */
    #isHeadingInCollapsedSection(heading, allHeadings) {
        const headingIndex = allHeadings.indexOf(heading);
        if (headingIndex <= 0) return false;

        const currentLevel = parseInt(heading.tagName.substring(1));

        // 向前Find，Check是否在某个折叠的父章节内
        for (let i = headingIndex - 1; i >= 0; i--) {
            const prevHeading = allHeadings[i];
            const prevLevel = parseInt(prevHeading.tagName.substring(1));

            // 如果遇到更高级别（父级）的Heading
            if (prevLevel < currentLevel) {
                // 如果这个父级Heading折叠了，当前Heading不可见
                if (prevHeading.classList.contains('section-collapsed')) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * NavigationHeading
     * @private
     */
    #navigateHeading(direction) {
        const allHeadings = Array.from(document.querySelectorAll(CONFIG.SELECTORS.HEADINGS));

        // Filter可见的Heading：
        // 1. 不在折叠章节内的Heading
        // 2. 没有 section-content-hidden 类的Heading
        const headings = allHeadings.filter(h => {
            if (h.classList.contains('section-content-hidden')) {
                return false;
            }
            const inCollapsed = this.#isHeadingInCollapsedSection(h, allHeadings);
            return !inCollapsed;
        });

        if (headings.length === 0) return;

        const currentFocused = document.querySelector('.heading-focused');
        let targetHeading;

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
            document.querySelectorAll('.heading-focused').forEach(el => {
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

    /**
     * Toggle当前章节已读State
     * @private
     */
    #toggleCurrentSectionViewed() {
        const focusedHeading = document.querySelector('.heading-focused');
        if (!focusedHeading) return;

        const checkbox = focusedHeading.querySelector('.viewed-checkbox');
        if (checkbox) {
            checkbox.click();
        }
    }

    /**
     * Toggle当前章节折叠/展开State
     * @private
     */
    #toggleCurrentSectionCollapse() {
        const focusedHeading = document.querySelector('.heading-focused');
        if (!focusedHeading || !focusedHeading.id) return;

        this.#toggleSectionCollapse(focusedHeading);
    }

    /**
     * Toggle指定Heading的折叠/展开State
     * @private
     */
    #toggleSectionCollapse(heading) {
        if (!heading || !heading.id) return;

        // Check if viewed manager is available
        if (!window.viewedManager) return;

        const headingId = heading.id;
        window.viewedManager.toggleCollapse(headingId);
    }

    /**
     * SettingsHeading双击Event
     * @private
     */
    #setupHeadingDoubleClick() {
        document.addEventListener('dblclick', (e) => {
            const heading = e.target.closest(CONFIG.SELECTORS.HEADINGS);
            if (!heading) return;

            // Ignore在 checkbox、Button等交互Element上的双击
            if (e.target.closest('.viewed-checkbox') ||
                e.target.closest('button') ||
                e.target.closest('a') ||
                e.target.closest('.section-expand-toggle')) {
                return;
            }

            this.#toggleSectionCollapse(heading);
        });

        Logger.log('MarkonApp', 'Heading double-click handler registered');
    }

    /**
     * GetFilePath（从 meta Tag）
     * @private
     */
    #getFilePathFromMeta() {
        const meta = document.querySelector('meta[name="file-path"]');
        return meta ? meta.getAttribute('content') : window.location.pathname;
    }

    #getFlagFromMeta(name) {
        const meta = document.querySelector(`meta[name="${name}"]`);
        return meta ? meta.getAttribute('content') === 'true' : false;
    }

    /**
     * Clear当前页面的所有注解
     * @param {Event} event - TriggerEvent（用于定位Confirm对话框）
     */
    async clearAllAnnotations(event = null) {
        const anchorElement = event ? event.target : null;
        Logger.log('MarkonApp', 'clearAllAnnotations called, showing confirm dialog');
        showConfirmDialog('Clear all annotations for this page?', async () => {
            Logger.log('MarkonApp', 'Confirm callback started');
            await this.#annotationManager.clear();
            Logger.log('MarkonApp', 'Annotations cleared from manager');
            this.#annotationManager.clearDOM();
            Logger.log('MarkonApp', 'Annotations cleared from DOM');
            this.#noteManager.clear();
            Logger.log('MarkonApp', 'Notes cleared');

            // 同时Clear已读State（如果启用）
            if (document.querySelector('meta[name="enable-viewed"]')) {
                await this.#storage.clearViewedState();
                Logger.log('MarkonApp', 'Viewed state cleared from storage');

                // 在SharedMode下，需要Waiting WebSocket Broadcast后 viewedManager 会自动Update
                // 在LocalMode下，页面会重新Load
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
        }, anchorElement, 'Clear');
    }

    /**
     * Initialize search
     * @private
     */
    #initSearch() {
        if (this.#enableSearch) {
            this.#searchManager = new SearchManager();
            window.searchManager = this.#searchManager;
            Logger.log('MarkonApp', 'SearchManager initialized');
        }

        // Initialize highlight manager only if markdown body exists
        if (this.#markdownBody) {
            new HighlightManager();
            Logger.log('MarkonApp', 'HighlightManager initialized');
        }
    }

    /**
     * Open the editor
     * @private
     */
    #openEditor() {
        if (!this.#enableEdit) {
            Logger.warn('MarkonApp', 'Edit feature is not enabled');
            return;
        }

        if (!this.#editorManager) {
            this.#editorManager = new EditorManager(this.#filePath);
        }

        this.#editorManager.open();
    }

    /**
     * GetManagement器（用于Debug）
     */
    getManagers() {
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
            annotationNavigator: this.#annotationNavigator
        };
    }
}

// 全局函数（向后兼容）
window.clearPageAnnotations = function(event, ws, isSharedAnnotationMode) {
    if (window.markonApp) {
        window.markonApp.clearAllAnnotations(event);
    }
};

// Apply入口
document.addEventListener('DOMContentLoaded', () => {
    const filePathMeta = document.querySelector('meta[name="file-path"]');
    const sharedAnnotationMeta = document.querySelector('meta[name="shared-annotation"]');
    const enableSearchMeta = document.querySelector('meta[name="enable-search"]');
    const isSharedMode = sharedAnnotationMeta?.getAttribute('content') === 'true';

    // Settings全局变量供 viewed.js 使用
    window.isSharedAnnotationMode = isSharedMode;

    // 拦截 TOC 锚点Link点击，使用平滑滚动
    document.addEventListener('click', (e) => {
        const link = e.target.closest('a[href^="#"]');
        if (!link) return;

        const href = link.getAttribute('href');
        if (!href || href === '#') return;

        const targetId = href.substring(1);
        const targetElement = document.getElementById(targetId);

        if (targetElement) {
            e.preventDefault();
            targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
            history.pushState(null, '', href);
            // Sync TOC selected state
            if (window.__markonTocSetSelected) {
                window.__markonTocSetSelected(targetId);
            }
        }
    });

    const enableEditMeta = document.querySelector('meta[name="enable-edit"]');

    // 暴露到全局（用于Debug和向后兼容）
    window.markonApp = app;
    window.undoManager = app.getManagers().undoManager;
    window.tocNavigator = app.getManagers().tocNavigator;
    window.annotationNavigator = app.getManagers().annotationNavigator;
    window.shortcutsManager = app.getManagers().shortcutsManager;

    Logger.log('MarkonApp', 'Application started successfully');

    // Connect to per-workspace WebSocket — reload page when config flags change.
    const wsId = document.querySelector('meta[name="workspace-id"]')?.content;
    if (wsId) {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const connectConfigWs = () => {
            const sock = new WebSocket(`${proto}//${location.host}/_/ws/${wsId}`);
            sock.onmessage = () => window.location.reload();
            sock.onclose = () => setTimeout(connectConfigWs, 3000); // reconnect on drop
        };
        connectConfigWs();
    }
});
