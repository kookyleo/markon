/**
 * MarkonApp - 主应用类
 * 整合所有模块，统一初始化和管理
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
import { TOCNavigator } from './navigators/toc-navigator.js';
import { AnnotationNavigator } from './navigators/annotation-navigator.js';
import { ModalManager, showConfirmDialog } from './components/modal.js';

/**
 * Markon 主应用类
 */
export class MarkonApp {
    // 管理器实例
    #storage;
    #wsManager;
    #annotationManager;
    #noteManager;
    #popoverManager;
    #undoManager;
    #shortcutsManager;
    #tocNavigator;
    #annotationNavigator;

    // DOM 元素
    #markdownBody;
    #filePath;
    #isSharedMode;

    // 滚动控制
    #scrollAnimationId = null;
    #scrollCancelled = false;

    constructor(config = {}) {
        this.#filePath = config.filePath || this.#getFilePathFromMeta();
        this.#isSharedMode = config.isSharedMode || false;
        this.#markdownBody = document.querySelector(CONFIG.SELECTORS.MARKDOWN_BODY);

        if (!this.#markdownBody) {
            Logger.warn('MarkonApp', 'Markdown body not found, skipping initialization');
            return;
        }

        Logger.log('MarkonApp', 'Initializing...', {
            filePath: this.#filePath,
            isSharedMode: this.#isSharedMode
        });
    }

    /**
     * 初始化应用
     */
    async init() {
        if (!this.#markdownBody) return;

        // 1. 初始化存储
        await this.#initStorage();

        // 2. 初始化管理器
        this.#initManagers();

        // 3. 加载数据
        await this.#loadData();

        // 4. 应用到 DOM
        this.#applyToDOM();

        // 5. 设置事件监听器
        this.#setupEventListeners();

        // 6. 注册快捷键
        this.#registerShortcuts();

        // 7. 修复 TOC HTML 实体
        this.#fixTocHtmlEntities();

        // 8. 更新清除按钮文本
        this.#updateClearButtonText();

        Logger.log('MarkonApp', 'Initialization complete');
    }

    /**
     * 初始化存储
     * @private
     */
    async #initStorage() {
        if (this.#isSharedMode) {
            // 共享模式：初始化 WebSocket
            this.#wsManager = new WebSocketManager(this.#filePath);

            try {
                await this.#wsManager.connect();
                Logger.log('MarkonApp', 'WebSocket connected');

                // 暴露原生 WebSocket 对象给 viewed.js 使用
                window.ws = this.#wsManager.getWebSocket();
                Logger.log('MarkonApp', 'Exposed WebSocket to window.ws for viewed.js');

                // 如果 viewedManager 已经存在，更新它的配置
                if (window.viewedManager) {
                    // 更新 isSharedMode（可能在初始化时是 false）
                    if (!window.viewedManager.isSharedMode) {
                        window.viewedManager.isSharedMode = true;
                        Logger.log('MarkonApp', 'Updated viewedManager.isSharedMode to true');
                    }
                    // 更新 WebSocket 连接
                    if (!window.viewedManager.ws) {
                        window.viewedManager.ws = window.ws;
                        window.viewedManager.setupWebSocketListeners();
                        Logger.log('MarkonApp', 'Updated viewedManager with WebSocket connection');
                    }
                }
            } catch (error) {
                Logger.error('MarkonApp', 'WebSocket connection failed:', error);
            }

            // 设置 WebSocket 消息处理器
            this.#setupWebSocketHandlers();
        }

        // 创建存储管理器（自动选择策略）
        this.#storage = new StorageManager(this.#filePath, this.#isSharedMode, this.#wsManager);
    }

    /**
     * 初始化管理器
     * @private
     */
    #initManagers() {
        // 注解管理器
        this.#annotationManager = new AnnotationManager(this.#storage, this.#markdownBody);

        // 笔记管理器
        this.#noteManager = new NoteManager(this.#annotationManager, this.#markdownBody);

        // 弹出框管理器
        this.#popoverManager = new PopoverManager(this.#markdownBody);

        // 撤销管理器
        this.#undoManager = new UndoManager();

        // 快捷键管理器
        this.#shortcutsManager = new KeyboardShortcutsManager();

        // 导航器
        this.#tocNavigator = new TOCNavigator();
        this.#annotationNavigator = new AnnotationNavigator();

        // 设置弹出框动作回调
        this.#popoverManager.onAction((action, data) => {
            this.#handlePopoverAction(action, data);
        });

        Logger.log('MarkonApp', 'Managers initialized');
    }

    /**
     * 加载数据
     * @private
     */
    async #loadData() {
        await this.#annotationManager.load();
        Logger.log('MarkonApp', `Loaded ${this.#annotationManager.getAll().length} annotations`);
    }

    /**
     * 应用到 DOM
     * @private
     */
    #applyToDOM() {
        // 应用注解
        this.#annotationManager.applyToDOM();

        // 渲染笔记卡片
        this.#noteManager.render();
        this.#noteManager.setupResponsiveLayout();
    }

    /**
     * 设置事件监听器
     * @private
     */
    #setupEventListeners() {
        // 选择事件
        document.addEventListener('mouseup', (e) => {
            this.#popoverManager.handleSelection(e);
        });

        document.addEventListener('touchend', (e) => {
            this.#popoverManager.handleSelection(e);
        });

        // 点击高亮元素
        document.addEventListener('click', (e) => {
            const isHighlighted = e.target.closest(CONFIG.SELECTORS.HIGHLIGHT_CLASSES);
            if (isHighlighted) {
                this.#popoverManager.handleHighlightClick(isHighlighted);
            }
        });

        // 笔记卡片点击事件
        this.#setupNoteClickHandlers();

        // TOC 相关事件
        this.#setupTOCEvents();

        // 鼠标点击章节聚焦
        this.#setupHeadingClickFocus();

        // 双击标题切换折叠/展开（viewed 模式启用时）
        if (document.querySelector('meta[name="enable-viewed"]')) {
            this.#setupHeadingDoubleClick();
        }

        // 全局键盘事件
        document.addEventListener('keydown', (e) => {
            this.#shortcutsManager.handle(e);
        });

        // 外部点击隐藏弹出框
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
     * 注册快捷键
     * @private
     */
    #registerShortcuts() {
        // 核心快捷键
        this.#shortcutsManager.register('HELP', () => {
            this.#shortcutsManager.showHelp();
        });

        this.#shortcutsManager.register('ESCAPE', () => {
            this.#handleEscapeKey();
        });

        this.#shortcutsManager.register('TOGGLE_TOC', () => {
            this.#toggleTOC();
        });

        // 撤销/重做
        this.#shortcutsManager.register('UNDO', () => {
            this.#handleUndo();
        });

        this.#shortcutsManager.register('REDO', () => {
            this.#handleRedo();
        });

        this.#shortcutsManager.register('REDO_ALT', () => {
            this.#handleRedo();
        });

        // 导航
        this.#shortcutsManager.register('NEXT_HEADING', () => {
            this.#navigateHeading('next');
        });

        this.#shortcutsManager.register('PREV_HEADING', () => {
            this.#navigateHeading('prev');
        });

        this.#shortcutsManager.register('NEXT_ANNOTATION', () => {
            this.#annotationNavigator.next();
        });

        this.#shortcutsManager.register('PREV_ANNOTATION', () => {
            this.#annotationNavigator.previous();
        });

        this.#shortcutsManager.register('SCROLL_HALF_PAGE_DOWN', () => {
            // 使用自定义滚动，1/3 页，持续时间 500ms
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

        Logger.log('MarkonApp', 'Shortcuts registered');
    }

    /**
     * 处理弹出框动作
     * @private
     */
    async #handlePopoverAction(action, data) {
        const { selection, highlightedElement } = data;

        if (action === 'unhighlight') {
            // 移除高亮
            if (highlightedElement) {
                const annotationId = highlightedElement.dataset.annotationId;
                await this.#annotationManager.delete(annotationId);
                this.#annotationManager.removeFromDOM(annotationId);
                this.#noteManager.render();

                // 记录撤销
                this.#undoManager.push({
                    type: 'delete_annotation',
                    annotation: { id: annotationId }
                });
            }
        } else if (action.startsWith('highlight-')) {
            // 添加高亮
            const annotation = this.#annotationManager.createAnnotation(
                selection,
                action,
                CONFIG.HTML_TAGS.HIGHLIGHT
            );
            await this.#annotationManager.add(annotation);
            this.#annotationManager.applyToDOM([annotation]);

            // 记录撤销
            this.#undoManager.push({
                type: 'add_annotation',
                annotation: annotation
            });
        } else if (action === 'strikethrough') {
            // 添加删除线
            const annotation = this.#annotationManager.createAnnotation(
                selection,
                CONFIG.ANNOTATION_TYPES.STRIKETHROUGH,
                CONFIG.HTML_TAGS.STRIKETHROUGH
            );
            await this.#annotationManager.add(annotation);
            this.#annotationManager.applyToDOM([annotation]);

            // 记录撤销
            this.#undoManager.push({
                type: 'add_annotation',
                annotation: annotation
            });
        } else if (action === 'add-note') {
            // 添加笔记 - 不清除选择，保持选中状态直到模态框关闭
            this.#showNoteInputModal(selection);
            return; // 提前返回，不清除选择
        }

        // 清除选择（add-note 操作除外）
        window.getSelection().removeAllRanges();
    }

    /**
     * 显示笔记输入模态框
     * @private
     */
    #showNoteInputModal(selection, annotation = null) {
        // 创建临时高亮覆盖层来显示选中的文本
        // （不能使用真实的 selection 因为会与 textarea 焦点冲突）
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
                overlay.style.zIndex = '9998'; // 在 modal (9999) 下方，但在内容上方
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

        // 获取选择位置（用于模态框定位）
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
                        // 编辑现有笔记
                        annotation.note = noteText;
                        await this.#annotationManager.add(annotation);
                    } else {
                        // 创建新笔记
                        const newAnnotation = this.#annotationManager.createAnnotation(
                            selection,
                            CONFIG.ANNOTATION_TYPES.HAS_NOTE,
                            CONFIG.HTML_TAGS.HIGHLIGHT,
                            noteText
                        );
                        await this.#annotationManager.add(newAnnotation);
                        this.#annotationManager.applyToDOM([newAnnotation]);

                        // 记录撤销
                        this.#undoManager.push({
                            type: 'add_annotation',
                            annotation: newAnnotation
                        });
                    }

                    // 重新渲染笔记卡片
                    this.#noteManager.render();
                } else if (annotation) {
                    // 删除笔记（如果文本为空）
                    await this.#annotationManager.delete(annotation.id);
                    this.#annotationManager.removeFromDOM(annotation.id);
                    this.#noteManager.render();
                }

                // 保存后清理覆盖层和选择
                cleanupOverlays();
                window.getSelection().removeAllRanges();
            },
            onCancel: () => {
                // 取消时清理覆盖层和选择
                cleanupOverlays();
                window.getSelection().removeAllRanges();
            }
        });
    }

    /**
     * 设置 WebSocket 处理器
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
            // 检查是否已存在（本地刚创建的标注）
            const existingAnnotation = this.#annotationManager.getById(message.annotation.id);
            if (existingAnnotation) {
                // 已存在，说明是本地创建的，跳过处理
                Logger.log('WebSocket', `Annotation ${message.annotation.id} already exists locally, skipping`);
                return;
            }

            // 从远程客户端创建的新标注
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
     * 设置笔记点击处理器
     * @private
     */
    #setupNoteClickHandlers() {
        document.body.addEventListener('click', async (e) => {
            // 编辑按钮
            if (e.target.classList.contains('note-edit')) {
                const annotationId = e.target.dataset.annotationId;
                const annotation = this.#annotationManager.getById(annotationId);
                if (annotation) {
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

            // 删除按钮
            if (e.target.classList.contains('note-delete')) {
                const annotationId = e.target.dataset.annotationId;
                showConfirmDialog('Delete this note?', async () => {
                    await this.#annotationManager.delete(annotationId);
                    this.#annotationManager.removeFromDOM(annotationId);
                    this.#noteManager.render();

                    // 关闭窄屏模式下的笔记弹窗
                    const popup = document.querySelector('.note-popup');
                    if (popup) popup.remove();

                    // 记录撤销
                    this.#undoManager.push({
                        type: 'delete_annotation',
                        annotation: { id: annotationId }
                    });
                }, e.target, 'Delete');
                e.stopPropagation();
                return;
            }

            // 点击笔记元素
            if (e.target.classList.contains('has-note')) {
                const annotationId = e.target.dataset.annotationId;
                e.target.classList.add('highlight-active');

                // 响应式处理
                if (window.innerWidth > CONFIG.BREAKPOINTS.WIDE_SCREEN) {
                    // 宽屏：高亮笔记卡
                    const noteCard = document.querySelector(`.note-card-margin[data-annotation-id="${annotationId}"]`);
                    if (noteCard) {
                        noteCard.classList.add('highlight-active');
                        const noteRect = noteCard.getBoundingClientRect();
                        if (noteRect.top < 0 || noteRect.bottom > window.innerHeight) {
                            noteCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        }
                    }
                } else {
                    // 窄屏：显示弹窗
                    this.#noteManager.showNotePopup(e.target, annotationId);
                }

                e.stopPropagation();
            }
        });
    }

    /**
     * 设置 TOC 事件
     * @private
     */
    #setupTOCEvents() {
        const tocIcon = document.querySelector(CONFIG.SELECTORS.TOC_ICON);
        const tocContainer = document.querySelector(CONFIG.SELECTORS.TOC_CONTAINER);

        if (!tocIcon || !tocContainer) return;

        // 切换 TOC
        const toggleToc = (e) => {
            tocContainer.classList.toggle('active');
            e.stopPropagation();
            e.preventDefault();
        };

        tocIcon.addEventListener('click', toggleToc);
        tocIcon.addEventListener('touchend', toggleToc);

        // 外部点击关闭
        const closeToc = (e) => {
            if (tocContainer.classList.contains('active') && !tocContainer.contains(e.target)) {
                tocContainer.classList.remove('active');
            }
        };

        document.addEventListener('click', closeToc);
        document.addEventListener('touchend', closeToc);

        // TOC 链接点击
        this.#fixTocLinks();
    }

    /**
     * 修复 TOC 链接
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
                    // 移除之前的高亮
                    document.querySelectorAll('.heading-focused').forEach(el => {
                        el.classList.remove('heading-focused');
                    });

                    // 添加高亮
                    targetElement.classList.add('heading-focused');

                    // 智能滚动
                    Position.smartScrollToHeading(targetElement);
                }

                // 移动设备关闭 TOC
                const tocContainer = document.querySelector(CONFIG.SELECTORS.TOC_CONTAINER);
                if (tocContainer && window.innerWidth <= CONFIG.BREAKPOINTS.WIDE_SCREEN) {
                    tocContainer.classList.remove('active');
                }
            });
        });
    }

    /**
     * 修复 TOC HTML 实体
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
     * 更新清除按钮文本（显示 local/shared 模式）
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
     * 设置外部点击处理器
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

            // 隐藏选择弹窗
            if (this.#popoverManager.isVisible()) {
                this.#popoverManager.hide();
                window.getSelection().removeAllRanges();
            }

            // 如果点击在正文区域之外，取消当前焦点章节
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
     * @param {number} duration - 滚动持续时间（毫秒）
     */
    #smoothScrollBy(distance, duration = 800) {
        // 取消之前的滚动
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
     * 取消滚动动画
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
     * 处理 Escape 键
     * @private
     */
    #handleEscapeKey() {
        // 取消滚动动画
        if (this.#cancelScroll()) {
            return;
        }
        // 关闭帮助面板
        const helpPanel = document.querySelector('.shortcuts-help-panel');
        if (helpPanel) {
            helpPanel.classList.remove('visible');
            setTimeout(() => helpPanel.remove(), CONFIG.ANIMATION.PANEL_TRANSITION);
            return;
        }

        // 关闭 TOC
        const tocContainer = document.querySelector(CONFIG.SELECTORS.TOC_CONTAINER);
        if (tocContainer && tocContainer.classList.contains('active')) {
            tocContainer.classList.remove('active');
            return;
        }

        // 隐藏弹出框
        if (this.#popoverManager.isVisible()) {
            this.#popoverManager.hide();
            window.getSelection().removeAllRanges();
            return;
        }

        // 清除选择
        window.getSelection().removeAllRanges();
    }

    /**
     * 切换 TOC
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
     * 处理撤销
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
     * 处理重做
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
     * 检查标题是否在折叠的章节内
     * @private
     */
    #isHeadingInCollapsedSection(heading, allHeadings) {
        const headingIndex = allHeadings.indexOf(heading);
        if (headingIndex <= 0) return false;

        const currentLevel = parseInt(heading.tagName.substring(1));

        // 向前查找，检查是否在某个折叠的父章节内
        for (let i = headingIndex - 1; i >= 0; i--) {
            const prevHeading = allHeadings[i];
            const prevLevel = parseInt(prevHeading.tagName.substring(1));

            // 如果遇到更高级别（父级）的标题
            if (prevLevel < currentLevel) {
                // 如果这个父级标题折叠了，当前标题不可见
                if (prevHeading.classList.contains('section-collapsed')) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * 导航标题
     * @private
     */
    #navigateHeading(direction) {
        const allHeadings = Array.from(document.querySelectorAll(CONFIG.SELECTORS.HEADINGS));

        // 过滤可见的标题：
        // 1. 不在折叠章节内的标题
        // 2. 没有 section-content-hidden 类的标题
        const headings = allHeadings.filter(h => {
            if (h.classList.contains('section-content-hidden')) {
                return false;
            }
            return !this.#isHeadingInCollapsedSection(h, allHeadings);
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
        }
    }

    /**
     * 切换当前章节已读状态
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
     * 切换当前章节折叠/展开状态
     * @private
     */
    #toggleCurrentSectionCollapse() {
        const focusedHeading = document.querySelector('.heading-focused');
        if (!focusedHeading || !focusedHeading.id) return;

        this.#toggleSectionCollapse(focusedHeading);
    }

    /**
     * 切换指定标题的折叠/展开状态
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
     * 设置标题双击事件
     * @private
     */
    #setupHeadingDoubleClick() {
        document.addEventListener('dblclick', (e) => {
            const heading = e.target.closest(CONFIG.SELECTORS.HEADINGS);
            if (!heading) return;

            // 忽略在 checkbox、按钮等交互元素上的双击
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
     * 获取文件路径（从 meta 标签）
     * @private
     */
    #getFilePathFromMeta() {
        const meta = document.querySelector('meta[name="file-path"]');
        return meta ? meta.getAttribute('content') : window.location.pathname;
    }

    /**
     * 清除当前页面的所有注解
     * @param {Event} event - 触发事件（用于定位确认对话框）
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

            // 同时清除已读状态（如果启用）
            if (document.querySelector('meta[name="enable-viewed"]')) {
                await this.#storage.clearViewedState();
                Logger.log('MarkonApp', 'Viewed state cleared from storage');

                // 在共享模式下，需要等待 WebSocket 广播后 viewedManager 会自动更新
                // 在本地模式下，页面会重新加载
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
     * 获取管理器（用于调试）
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

// 应用入口
document.addEventListener('DOMContentLoaded', () => {
    const filePathMeta = document.querySelector('meta[name="file-path"]');
    const sharedAnnotationMeta = document.querySelector('meta[name="shared-annotation"]');
    const isSharedMode = sharedAnnotationMeta?.getAttribute('content') === 'true';

    // 设置全局变量供 viewed.js 使用
    window.isSharedAnnotationMode = isSharedMode;

    // 拦截 TOC 锚点链接点击，使用平滑滚动
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

            // 更新 URL hash 而不触发跳转
            history.pushState(null, '', href);
        }
    });

    const app = new MarkonApp({
        filePath: filePathMeta?.getAttribute('content'),
        isSharedMode: isSharedMode
    });

    app.init();

    // 暴露到全局（用于调试和向后兼容）
    window.markonApp = app;
    window.undoManager = app.getManagers().undoManager;
    window.tocNavigator = app.getManagers().tocNavigator;
    window.annotationNavigator = app.getManagers().annotationNavigator;
    window.shortcutsManager = app.getManagers().shortcutsManager;

    Logger.log('MarkonApp', 'Application started successfully');
});
