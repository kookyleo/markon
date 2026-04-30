/**
 * Markon Application configuration
 * Centralized configuration constants to avoid magic numbers scattered in code
 */

const _t: (key: string, ...args: unknown[]) => string =
    (typeof window !== 'undefined' && window.__MARKON_I18N__ && window.__MARKON_I18N__.t) ||
    ((k: string) => k);

/**
 * A single keyboard shortcut definition.
 * `desc` is i18n-resolved at module-load time; runtime callers should treat
 * it as opaque user-facing text.
 */
export interface ShortcutDef {
    key: string;
    ctrl: boolean;
    shift: boolean;
    desc: string;
}

/**
 * Lightweight runtime i18n facade. Always returns a string, falling back to
 * the key itself when `window.__MARKON_I18N__` is unavailable (e.g. during
 * unit tests or early page-load).
 */
export const i18n = {
    t(key: string, ...args: unknown[]): string {
        const fn = (typeof window !== 'undefined' && window.__MARKON_I18N__ && window.__MARKON_I18N__.t) || null;
        return fn ? fn(key, ...args) : key;
    },
} as const;

export const CONFIG = {
    // Responsive breakpoints
    BREAKPOINTS: {
        WIDE_SCREEN: 1400,  // Wide screen threshold (show sidebar notes)
    },

    // Dimension configuration
    DIMENSIONS: {
        NOTE_CARD_WIDTH: 250,           // Note card width
        NOTE_CARD_RIGHT_MARGIN: 70,     // Note card right margin (avoid scrollbar)
        HEADING_TOP_MARGIN: 64,         // Heading top margin (sufficient space)
        HEADING_TOP_MARGIN_TIGHT: 5,    // Heading top margin (tight space)
        POPOVER_OFFSET: 10,             // Popover offset distance
    },

    // Layout thresholds
    THRESHOLDS: {
        NOTE_CLUSTER: 50,               // Note clustering threshold (pixels)
        NOTE_MIN_SPACING: 10,           // Note minimum spacing
        HEADING_SCROLL_THRESHOLD: 40,   // Heading scroll threshold
    },

    // WebSocket Configuration
    WEBSOCKET: {
        INITIAL_RECONNECT_DELAY: 1000,      // Initial reconnect delay (1s)
        MAX_RECONNECT_DELAY: 30000,         // Max reconnect delay (30s)
        STABLE_CONNECTION_THRESHOLD: 5000,  // Stable connection threshold (5s)
        STATE_LOAD_TIMEOUT: 500,            // State load timeout
        STATE_CHECK_INTERVAL: 50,           // State check interval
    },

    // Animation and interaction
    ANIMATION: {
        RESIZE_DEBOUNCE: 150,           // Window resize debounce time
        SCROLL_UPDATE_DEBOUNCE: 100,    // Scroll update debounce time
        PANEL_TRANSITION: 200,          // Panel transition animation time
        OUTSIDE_CLICK_DELAY: 100,       // Outside click detection delay
    },

    // Undo/Redo Configuration
    UNDO: {
        MAX_STACK_SIZE: 50,             // Max undo stack size
    },

    // Keyboard shortcuts configuration
    SHORTCUTS: {
        // Core functionality
        UNDO: { key: 'z', ctrl: true, shift: false, desc: _t('web.kbd.undo') },
        REDO: { key: 'z', ctrl: true, shift: true, desc: _t('web.kbd.redo') },
        REDO_ALT: { key: 'y', ctrl: true, shift: false, desc: _t('web.kbd.redo.alt') },
        ESCAPE: { key: 'Escape', ctrl: false, shift: false, desc: _t('web.kbd.escape') },
        TOGGLE_TOC: { key: '\\', ctrl: true, shift: false, desc: _t('web.kbd.toc') },
        HELP: { key: '?', ctrl: false, shift: false, desc: _t('web.kbd.help') },
        SEARCH: { key: '/', ctrl: false, shift: false, desc: _t('web.kbd.search') },

        // Navigation
        PREV_HEADING: { key: 'k', ctrl: false, shift: false, desc: _t('web.kbd.prevheading') },
        NEXT_HEADING: { key: 'j', ctrl: false, shift: false, desc: _t('web.kbd.nextheading') },
        PREV_ANNOTATION: { key: 'k', ctrl: true, shift: false, desc: _t('web.kbd.prevanno') },
        NEXT_ANNOTATION: { key: 'j', ctrl: true, shift: false, desc: _t('web.kbd.nextanno') },
        SCROLL_HALF_PAGE_DOWN: { key: ' ', ctrl: false, shift: false, desc: _t('web.kbd.scroll') },

        // Section control
        TOGGLE_SECTION_COLLAPSE: { key: 'o', ctrl: false, shift: false, desc: _t('web.kbd.collapse') },

        // Viewed functionality (requires enabling)
        TOGGLE_VIEWED: { key: 'v', ctrl: false, shift: false, desc: _t('web.kbd.viewed') },

        // Edit functionality (requires enabling)
        EDIT: { key: 'e', ctrl: false, shift: false, desc: _t('web.kbd.edit') },

        // Live mode (requires enable_live):
        //   L        — toggle Broadcast ⇄ Follow (even if currently Off, this
        //              enters the cycle directly, never lands on Off).
        //   Shift+L  — toggle Off ⇄ last active mode.
        TOGGLE_LIVE_ACTIVE: { key: 'l', ctrl: false, shift: false, desc: _t('web.kbd.live.active') },
        TOGGLE_LIVE_OFF:    { key: 'l', ctrl: false, shift: true,  desc: _t('web.kbd.live.off') },

        // Chat (requires enable_chat):
        //   C        — open chat in the user's default surface (in-page panel
        //              or popout window, per Settings → 默认 chat 形式).
        //   Shift+C  — open in the alternate surface for that single press.
        TOGGLE_CHAT:     { key: 'c', ctrl: false, shift: false, desc: _t('web.kbd.chat') },
        TOGGLE_CHAT_ALT: { key: 'c', ctrl: false, shift: true,  desc: _t('web.kbd.chat.alt') },
    } satisfies Record<string, ShortcutDef>,

    // Storage keys
    STORAGE_KEYS: {
        ANNOTATIONS: (filePath: string): string => `markon-annotations-${filePath}`,
        VIEWED: (filePath: string): string => `markon-viewed-${filePath}`,
        LIVE_POS: 'markon-live-pos',
        LIVE_COLOR: 'markon-user-color',
        LIVE_MODE: 'markon-live-mode',
        CLIENT_ID: 'markon-client-id',
        CHAT_POS: 'markon-chat-pos',
        CHAT_SIZE: 'markon-chat-size',
    },

    // DOM Selectors
    SELECTORS: {
        MARKDOWN_BODY: '.markdown-body',
        HEADINGS: 'h1, h2, h3, h4, h5, h6',
        HEADINGS_NO_H1: 'h2, h3, h4, h5, h6',
        TOC_CONTAINER: '#toc-container',
        TOC_ICON: '#toc-icon',
        TOC_MENU: '.toc',
        TOC_ITEM: '.toc-item',

        // Annotation Related
        HIGHLIGHT_CLASSES: '.highlight-orange, .highlight-green, .highlight-yellow, .strikethrough',
        HAS_NOTE: '.has-note',
        NOTE_CARD: '.note-card-margin',
        NOTE_POPUP: '.note-popup',

        // UI Element
        SELECTION_POPOVER: '.selection-popover',
        NOTE_INPUT_MODAL: '.note-input-modal',
        CONFIRM_DIALOG: '.confirm-dialog',
        SHORTCUTS_HELP_PANEL: '.shortcuts-help-panel',
        EDITOR_MODAL: '.editor-modal',

        // Viewed Related
        VIEWED_CHECKBOX: '.viewed-checkbox',
        SECTION_COLLAPSED: '.section-collapsed',
        SECTION_CONTENT_HIDDEN: '.section-content-hidden',
    },

    // Skip的Element（XPath Calculate时）
    SKIP_ELEMENTS: {
        IDS: new Set<string>(['toc']),
        CLASSES: new Set<string>(['back-link', 'toc', 'selection-popover', 'note-card-margin', 'note-popup']),
    },

    // Meta Tag names
    META_TAGS: {
        FILE_PATH: 'file-path',
        WORKSPACE_ID: 'workspace-id',
        SHARED_ANNOTATION: 'shared-annotation',
        ENABLE_SEARCH: 'enable-search',
        ENABLE_VIEWED: 'enable-viewed',
        ENABLE_EDIT: 'enable-edit',
        ENABLE_LIVE: 'enable-live',
        ENABLE_CHAT: 'enable-chat',
        DEFAULT_CHAT_MODE: 'default-chat-mode',
    },

    // WebSocket Message types
    WS_MESSAGE_TYPES: {
        ALL_ANNOTATIONS: 'all_annotations',
        NEW_ANNOTATION: 'new_annotation',
        DELETE_ANNOTATION: 'delete_annotation',
        CLEAR_ANNOTATIONS: 'clear_annotations',
        VIEWED_STATE: 'viewed_state',
        UPDATE_VIEWED_STATE: 'update_viewed_state',
        LIVE_ACTION: 'live_action',
        FILE_CHANGED: 'file_changed',
    },

    // Collaboration Configuration — 8 bright, saturated colors. Greys and
    // near-black tones are deliberately excluded so they never collide with
    // the disabled/OFF state's muted ring. Index = user-facing label 1..8.
    COLLABORATION: {
        COLORS: [
            '#3451B2', // 1 Blue
            '#E64560', // 2 Rose
            '#27AE60', // 3 Green
            '#F39C12', // 4 Orange
            '#8E44AD', // 5 Purple
            '#0EA5E9', // 6 Sky
            '#EC4899', // 7 Pink
            '#14B8A6', // 8 Teal
        ],
        SYNC_DEBOUNCE: 100,    // Broadcast debounce
    },

    // Annotation types
    ANNOTATION_TYPES: {
        HIGHLIGHT_ORANGE: 'highlight-orange',
        HIGHLIGHT_GREEN: 'highlight-green',
        HIGHLIGHT_YELLOW: 'highlight-yellow',
        STRIKETHROUGH: 'strikethrough',
        HAS_NOTE: 'has-note',
    },

    // HTML Tag
    HTML_TAGS: {
        HIGHLIGHT: 'span',
        STRIKETHROUGH: 's',
    },

    // 块级Tag（用于Select范围判断）
    BLOCK_TAGS: ['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'TD', 'TH'],
};

/** Convenience alias: the literal-typed shortcut-name union derived from CONFIG. */
export type ShortcutName = keyof typeof CONFIG.SHORTCUTS;

/** WebSocket message-type literal union, matching CONFIG.WS_MESSAGE_TYPES values. */
export type WsMessageType = (typeof CONFIG.WS_MESSAGE_TYPES)[keyof typeof CONFIG.WS_MESSAGE_TYPES];

// Apply user shortcut overrides from Settings (injected as window.__MARKON_SHORTCUTS__).
if (typeof window !== 'undefined' && window.__MARKON_SHORTCUTS__) {
    const entries = Object.entries(window.__MARKON_SHORTCUTS__) as Array<
        [ShortcutName, Partial<ShortcutDef>]
    >;
    for (const [name, override] of entries) {
        if (CONFIG.SHORTCUTS[name]) {
            Object.assign(CONFIG.SHORTCUTS[name], override);
        }
    }
}

// 冻结ConfigurationObject，防止意外修改
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
Object.freeze(CONFIG.COLLABORATION);
Object.freeze(CONFIG.ANNOTATION_TYPES);
Object.freeze(CONFIG.HTML_TAGS);
