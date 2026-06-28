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
    /** Grouping category for the help panel — the suffix of a `web.kbd.cat.*`
     *  i18n key (e.g. 'global', 'nav', 'diff'). The panel only lists shortcuts
     *  that are actually registered, grouped by this category; `'global'` marks
     *  the ones available on every page (Help, Theme). */
    cat: string;
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
        // Fallbacks only — the live values are the CSS custom properties
        // --markon-note-width / --markon-rail-edge-gap in layout.html :root,
        // which note-manager reads at layout time. Keep these mirrored so the
        // fallback (jsdom / missing vars) matches the real geometry.
        NOTE_CARD_WIDTH: 280,           // mirrors --markon-note-width
        NOTE_CARD_RIGHT_MARGIN: 40,     // mirrors --markon-rail-edge-gap (clears scrollbar)
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
    },

    // Animation and interaction
    ANIMATION: {
        RESIZE_DEBOUNCE: 150,           // Window resize debounce time
        PANEL_TRANSITION: 200,          // Panel transition animation time
    },

    // Undo/Redo Configuration
    UNDO: {
        MAX_STACK_SIZE: 50,             // Max undo stack size
    },

    // Keyboard shortcuts configuration
    SHORTCUTS: {
        // Global — available on every page (document view, compare/diff, …).
        HELP: { key: '?', ctrl: false, shift: false, desc: _t('web.kbd.help'), cat: 'global' },
        THEME_PANEL: { key: 't', ctrl: false, shift: false, desc: _t('web.kbd.theme'), cat: 'global' },

        // Core functionality
        UNDO: { key: 'z', ctrl: true, shift: false, desc: _t('web.kbd.undo'), cat: 'core' },
        REDO: { key: 'z', ctrl: true, shift: true, desc: _t('web.kbd.redo'), cat: 'core' },
        REDO_ALT: { key: 'y', ctrl: true, shift: false, desc: _t('web.kbd.redo.alt'), cat: 'core' },
        ESCAPE: { key: 'Escape', ctrl: false, shift: false, desc: _t('web.kbd.escape'), cat: 'core' },
        TOGGLE_TOC: { key: '\\', ctrl: true, shift: false, desc: _t('web.kbd.toc'), cat: 'core' },
        SEARCH: { key: '/', ctrl: false, shift: false, desc: _t('web.kbd.search'), cat: 'search' },

        // Navigation
        PREV_HEADING: { key: 'k', ctrl: false, shift: false, desc: _t('web.kbd.prevheading'), cat: 'nav' },
        NEXT_HEADING: { key: 'j', ctrl: false, shift: false, desc: _t('web.kbd.nextheading'), cat: 'nav' },
        PREV_ANNOTATION: { key: 'k', ctrl: true, shift: false, desc: _t('web.kbd.prevanno'), cat: 'nav' },
        NEXT_ANNOTATION: { key: 'j', ctrl: true, shift: false, desc: _t('web.kbd.nextanno'), cat: 'nav' },
        SCROLL_HALF_PAGE_DOWN: { key: ' ', ctrl: false, shift: false, desc: _t('web.kbd.scroll'), cat: 'nav' },

        // Section control
        TOGGLE_SECTION_COLLAPSE: { key: 'o', ctrl: false, shift: false, desc: _t('web.kbd.collapse'), cat: 'viewed' },

        // Viewed functionality (requires enabling)
        TOGGLE_VIEWED: { key: 'v', ctrl: false, shift: false, desc: _t('web.kbd.viewed'), cat: 'viewed' },

        // Edit functionality (requires enabling)
        EDIT: { key: 'e', ctrl: false, shift: false, desc: _t('web.kbd.edit'), cat: 'edit' },

        // Live mode (requires enable_live):
        //   L        — toggle Broadcast ⇄ Follow (even if currently Off, this
        //              enters the cycle directly, never lands on Off).
        //   Shift+L  — toggle Off ⇄ last active mode.
        TOGGLE_LIVE_ACTIVE: { key: 'l', ctrl: false, shift: false, desc: _t('web.kbd.live.active'), cat: 'live' },
        TOGGLE_LIVE_OFF:    { key: 'l', ctrl: false, shift: true,  desc: _t('web.kbd.live.off'), cat: 'live' },

        // Chat (requires enable_chat):
        //   C        — open chat in the user's default surface (in-page panel
        //              or popout window, per Settings → Default chat surface).
        //   Shift+C  — open in the alternate surface for that single press.
        TOGGLE_CHAT:     { key: 'c', ctrl: false, shift: false, desc: _t('web.kbd.chat'), cat: 'chat' },
        TOGGLE_CHAT_ALT: { key: 'c', ctrl: false, shift: true,  desc: _t('web.kbd.chat.alt'), cat: 'chat' },

        // Compare / diff view (rendered ⇄ raw). Registered only on the diff page.
        DIFF_TOGGLE_VIEW: { key: 'v', ctrl: false, shift: false, desc: _t('web.kbd.diff.view'), cat: 'diff' },
        DIFF_NEXT_FILE:   { key: 'j', ctrl: false, shift: false, desc: _t('web.kbd.diff.nextfile'), cat: 'diff' },
        DIFF_PREV_FILE:   { key: 'k', ctrl: false, shift: false, desc: _t('web.kbd.diff.prevfile'), cat: 'diff' },
    } satisfies Record<string, ShortcutDef>,

    // Storage keys
    STORAGE_KEYS: {
        ANNOTATIONS: (filePath: string): string => `markon-annotations-${filePath}`,
        VIEWED: (filePath: string): string => `markon-viewed-${filePath}`,
        LIVE_POS: 'markon-live-pos',
        LIVE_COLOR: 'markon-user-color',
        IDENTITY_NAME: 'markon-user-name',
        LIVE_MODE: 'markon-live-mode',
        CLIENT_ID: 'markon-client-id',
        CHAT_POS: 'markon-chat-pos',
        CHAT_SIZE: 'markon-chat-size',
        POPOVER_OFFSET: 'markon-popover-offset',
    },

    // DOM Selectors
    SELECTORS: {
        MARKDOWN_BODY: '.markdown-body',
        HEADINGS: 'h1, h2, h3, h4, h5, h6',
        TOC_CONTAINER: '#toc-container',
        TOC_ICON: '#toc-icon',

        // Annotation Related
        HIGHLIGHT_CLASSES: '.highlight-orange, .highlight-green, .highlight-yellow, .strikethrough',
    },

    // Elements to skip (during XPath computation).
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
        CHAT_ONLY: 'chat-only',
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
        STRIKETHROUGH: 'strikethrough',
        HAS_NOTE: 'has-note',
    },

    // HTML Tag
    HTML_TAGS: {
        HIGHLIGHT: 'span',
        STRIKETHROUGH: 's',
    },

    // Block-level tags (used when judging selection boundaries).
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

// Freeze the configuration object to prevent accidental mutation.
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
