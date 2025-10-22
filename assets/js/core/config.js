/**
 * Markon 应用配置
 * 集中管理所有配置常量，避免魔法数字散布在代码中
 */

export const CONFIG = {
    // 响应式断点
    BREAKPOINTS: {
        WIDE_SCREEN: 1400,  // 宽屏模式阈值（显示侧边栏笔记）
    },

    // 尺寸配置
    DIMENSIONS: {
        NOTE_CARD_WIDTH: 250,           // 笔记卡片宽度
        NOTE_CARD_RIGHT_MARGIN: 70,     // 笔记卡片右边距（避免被滚动条遮挡）
        HEADING_TOP_MARGIN: 64,         // 标题顶部边距（充足空间）
        HEADING_TOP_MARGIN_TIGHT: 5,    // 标题顶部边距（紧凑空间）
        POPOVER_OFFSET: 10,             // 弹出框偏移距离
    },

    // 布局阈值
    THRESHOLDS: {
        NOTE_CLUSTER: 50,               // 笔记聚类阈值（像素）
        NOTE_MIN_SPACING: 10,           // 笔记最小间距
        HEADING_SCROLL_THRESHOLD: 40,   // 标题滚动判断阈值
    },

    // WebSocket 配置
    WEBSOCKET: {
        INITIAL_RECONNECT_DELAY: 1000,      // 初始重连延迟（1秒）
        MAX_RECONNECT_DELAY: 30000,         // 最大重连延迟（30秒）
        STABLE_CONNECTION_THRESHOLD: 5000,  // 连接稳定判断时间（5秒）
        STATE_LOAD_TIMEOUT: 500,            // 状态加载超时
        STATE_CHECK_INTERVAL: 50,           // 状态检查间隔
    },

    // 动画和交互
    ANIMATION: {
        RESIZE_DEBOUNCE: 150,           // 窗口调整防抖时间
        SCROLL_UPDATE_DEBOUNCE: 100,    // 滚动更新防抖时间
        PANEL_TRANSITION: 200,          // 面板过渡动画时间
        OUTSIDE_CLICK_DELAY: 100,       // 外部点击检测延迟
    },

    // Undo/Redo 配置
    UNDO: {
        MAX_STACK_SIZE: 50,             // 撤销栈最大大小
    },

    // 快捷键配置
    SHORTCUTS: {
        // 核心功能
        UNDO: { key: 'z', ctrl: true, shift: false, desc: 'Undo last operation' },
        REDO: { key: 'z', ctrl: true, shift: true, desc: 'Redo last undone operation' },
        REDO_ALT: { key: 'y', ctrl: true, shift: false, desc: 'Redo (alternative)' },
        ESCAPE: { key: 'Escape', ctrl: false, shift: false, desc: 'Close popups/Clear selection' },
        TOGGLE_TOC: { key: '\\', ctrl: true, shift: false, desc: 'Toggle/Focus TOC' },
        HELP: { key: '?', ctrl: false, shift: false, desc: 'Show keyboard shortcuts help' },

        // 导航
        PREV_HEADING: { key: 'k', ctrl: false, shift: false, desc: 'Jump to previous heading' },
        NEXT_HEADING: { key: 'j', ctrl: false, shift: false, desc: 'Jump to next heading' },
        PREV_ANNOTATION: { key: 'k', ctrl: true, shift: false, desc: 'Jump to previous annotation' },
        NEXT_ANNOTATION: { key: 'j', ctrl: true, shift: false, desc: 'Jump to next annotation' },
        SCROLL_HALF_PAGE_DOWN: { key: ' ', ctrl: false, shift: false, desc: 'Scroll 1/3 page down (ESC to stop)' },

        // Section control
        TOGGLE_SECTION_COLLAPSE: { key: 'o', ctrl: false, shift: false, desc: 'Toggle current section collapse/expand' },

        // Viewed 功能（需要启用）
        TOGGLE_VIEWED: { key: 'v', ctrl: false, shift: false, desc: 'Toggle current section viewed state' },
    },

    // 存储键名
    STORAGE_KEYS: {
        ANNOTATIONS: (filePath) => `markon-annotations-${filePath}`,
        VIEWED: (filePath) => `markon-viewed-${filePath}`,
    },

    // DOM 选择器
    SELECTORS: {
        MARKDOWN_BODY: '.markdown-body',
        HEADINGS: 'h1, h2, h3, h4, h5, h6',
        HEADINGS_NO_H1: 'h2, h3, h4, h5, h6',
        TOC_CONTAINER: '#toc-container',
        TOC_ICON: '#toc-icon',
        TOC_MENU: '.toc',
        TOC_ITEM: '.toc-item',

        // Annotation 相关
        HIGHLIGHT_CLASSES: '.highlight-orange, .highlight-green, .highlight-yellow, .strikethrough',
        HAS_NOTE: '.has-note',
        NOTE_CARD: '.note-card-margin',
        NOTE_POPUP: '.note-popup',

        // UI 元素
        SELECTION_POPOVER: '.selection-popover',
        NOTE_INPUT_MODAL: '.note-input-modal',
        CONFIRM_DIALOG: '.confirm-dialog',
        SHORTCUTS_HELP_PANEL: '.shortcuts-help-panel',

        // Viewed 相关
        VIEWED_CHECKBOX: '.viewed-checkbox',
        SECTION_COLLAPSED: '.section-collapsed',
        SECTION_CONTENT_HIDDEN: '.section-content-hidden',
    },

    // 跳过的元素（XPath 计算时）
    SKIP_ELEMENTS: {
        IDS: new Set(['toc']),
        CLASSES: new Set(['back-link', 'toc', 'selection-popover', 'note-card-margin', 'note-popup']),
    },

    // Meta 标签名称
    META_TAGS: {
        FILE_PATH: 'file-path',
        SHARED_ANNOTATION: 'shared-annotation',
        ENABLE_VIEWED: 'enable-viewed',
    },

    // WebSocket 消息类型
    WS_MESSAGE_TYPES: {
        ALL_ANNOTATIONS: 'all_annotations',
        NEW_ANNOTATION: 'new_annotation',
        DELETE_ANNOTATION: 'delete_annotation',
        CLEAR_ANNOTATIONS: 'clear_annotations',
        VIEWED_STATE: 'viewed_state',
        UPDATE_VIEWED_STATE: 'update_viewed_state',
    },

    // 注解类型
    ANNOTATION_TYPES: {
        HIGHLIGHT_ORANGE: 'highlight-orange',
        HIGHLIGHT_GREEN: 'highlight-green',
        HIGHLIGHT_YELLOW: 'highlight-yellow',
        STRIKETHROUGH: 'strikethrough',
        HAS_NOTE: 'has-note',
    },

    // HTML 标签
    HTML_TAGS: {
        HIGHLIGHT: 'span',
        STRIKETHROUGH: 's',
    },

    // 块级标签（用于选择范围判断）
    BLOCK_TAGS: ['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'TD', 'TH'],
};

// 冻结配置对象，防止意外修改
Object.freeze(CONFIG);
Object.freeze(CONFIG.BREAKPOINTS);
Object.freeze(CONFIG.DIMENSIONS);
Object.freeze(CONFIG.THRESHOLDS);
Object.freeze(CONFIG.WEBSOCKET);
Object.freeze(CONFIG.ANIMATION);
Object.freeze(CONFIG.UNDO);
Object.freeze(CONFIG.SHORTCUTS);
Object.freeze(CONFIG.SELECTORS);
Object.freeze(CONFIG.SKIP_ELEMENTS);
Object.freeze(CONFIG.META_TAGS);
Object.freeze(CONFIG.WS_MESSAGE_TYPES);
Object.freeze(CONFIG.ANNOTATION_TYPES);
Object.freeze(CONFIG.HTML_TAGS);
