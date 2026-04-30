/**
 * ChatManager — floating-sphere AI chat companion.
 *
 * Mirrors the CollaborationManager (the "Live" sphere) shape: a 40×40 sphere
 * pinned to the bottom-right that morphs into a side-drawer panel on click.
 * The panel hosts a message thread + an input footer; messages stream from
 * the backend over Server-Sent Events and are rendered with a tiny inline
 * markdown subset (no external CDN — markon serves all assets locally via
 * rust-embed).
 *
 * Public surface used by other modules:
 *   - new ChatManager(app)
 *   - .init()                                — gated on Meta.flag('enable-chat')
 *   - .open() / .close() / .toggle()
 *   - .openWithSelection({ text, currentDoc })   — quote selection in input
 *   - .prefillInput(text)                          — drop text into the textarea
 */

import { CONFIG } from '../core/config';
import { debounce, Ids, Logger } from '../core/utils';
import { Meta } from '../services/dom';
import { FloatingLayer } from '../components/floating-layer';

// ────────────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────────────

/**
 * Streaming event variants the backend's `agent.rs::AgentEvent` (tagged with
 * `type` + snake_case rename) can produce. Variants below are 1:1 with the
 * backend enum, but with only the fields the frontend `#handleEvent` actually
 * reads — extra fields (e.g. tool_use `id`, ToolEnd `output`, TurnEnd
 * `usage`) are present on the wire but ignored by the renderer.
 */
export type ChatSSEEvent =
    | { type: 'thread_assigned'; thread_id: string; title: string }
    | { type: 'text'; delta: string }
    | { type: 'tool_start'; id?: string; name: string; input?: Record<string, unknown> }
    | { type: 'tool_end'; id?: string; output?: string; is_error?: boolean }
    | { type: 'turn_end'; stop_reason?: string }
    | { type: 'done' }
    | { type: 'error'; message: string };

/** Anthropic-style content block, as persisted by the backend and rendered live. */
export type MessageContentBlock =
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id?: string; name: string; input: Record<string, unknown> }
    | { type: 'tool_result'; tool_use_id?: string; content?: unknown; output?: unknown; is_error?: boolean };

/** A message as we hold it in `#messagesByThread` (post-#hydrateMessage). */
export interface MessageBlock {
    /** Stable client-side id (`m<seq>` or `local-(u|a)-<ts>`). */
    id: string;
    role: 'user' | 'assistant';
    blocks: MessageContentBlock[];
    /** Backend-assigned sequence number (null for local-only messages). */
    seq?: number | null;
    /** Mention paths the user attached to the turn (user role only). */
    mentions?: string[];
    /** Set on the in-flight assistant message during streaming. */
    streaming?: boolean;
    /** Filled when the user aborted the stream. */
    stopped?: boolean;
    /** Filled with a human-readable error string when streaming fails. */
    error?: string | null;
}

/** Backend `ThreadSummary` returned by GET /api/chat/{ws}/threads. */
export interface ChatThread {
    id: string;
    title: string;
    /** Epoch ms (i64 on the backend). */
    created_at: number;
    /** Epoch ms (i64 on the backend). */
    updated_at: number;
    message_count: number;
}

/** Backend `StoredMessage` shape inside GET /api/chat/{ws}/threads/{id}. */
export interface ServerMessage {
    seq?: number;
    role: 'user' | 'assistant';
    content: MessageContentBlock[] | string;
    mentions?: Array<string | { path?: string }>;
}

/** Row returned by /api/chat/{ws}/files for the @-mention popup. */
export interface MentionRow {
    path: string;
    /** Optional fuzzy-match score; not displayed but useful for tests. */
    score?: number;
}

/** Citation anchor parsed out of an inline `<code>` snippet. */
export interface Citation {
    path: string;
    line: number | null;
    lineEnd: number | null;
    anchor: string | null;
}

// ────────────────────────────────────────────────────────────────────────────
// Tiny markdown renderer
// ────────────────────────────────────────────────────────────────────────────
//
// markon ships a server-side markdown renderer for documents but the chat
// stream is rendered client-side, token-by-token, so we need something
// in-process. If the host page exposes `window.marked` we use it (markon does
// not today, but a future task may inject it); otherwise we fall back to this
// minimal subset covering: paragraphs, fenced code, inline code, **bold**,
// *italic*, links [text](url), and ordered/unordered lists. No raw HTML
// support — all input is escaped first so streamed model output cannot inject
// markup into the page.

const HTML_ESCAPE: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};

export function escapeHtml(s: unknown): string {
    return String(s).replace(/[&<>"']/g, (ch) => HTML_ESCAPE[ch] ?? ch);
}

export function renderInline(text: string): string {
    // Escape first so model output can't inject HTML; then re-introduce only
    // the markdown-derived spans we explicitly support. Inline code wins over
    // bold/italic because backticks should suppress emphasis inside them.
    let out = escapeHtml(text);
    // Inline code — replaced with a placeholder, restored last.
    const codeStash: string[] = [];
    out = out.replace(/`([^`]+)`/g, (_match, c: string) => {
        codeStash.push(c);
        return ` CODE${codeStash.length - 1} `;
    });
    // Bold then italic. Use non-greedy and require a non-whitespace boundary
    // so `** ** ` doesn't match.
    out = out.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
    // Links [text](url) — escape url already done, but strip javascript: just in case.
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, url: string) => {
        if (/^javascript:/i.test(url)) return label;
        return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });
    // Restore code spans last so they're rendered verbatim.
    out = out.replace(/ CODE(\d+) /g, (_match, i: string) => `<code>${escapeHtml(codeStash[Number(i)])}</code>`);
    return out;
}

export function renderMarkdown(src: unknown): string {
    if (typeof window !== 'undefined' && window.marked && typeof window.marked.parse === 'function') {
        try {
            return window.marked.parse(String(src ?? ''));
        } catch {
            /* fall through */
        }
    }
    if (!src) return '';
    const lines = String(src).split('\n');
    const out: string[] = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i] ?? '';
        // Fenced code block: ```lang? … ```
        const fence = line.match(/^```(\S*)\s*$/);
        if (fence) {
            const buf: string[] = [];
            i++;
            while (i < lines.length && !/^```\s*$/.test(lines[i] ?? '')) {
                buf.push(lines[i] ?? '');
                i++;
            }
            // Skip the closing ``` if present.
            if (i < lines.length) i++;
            out.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
            continue;
        }
        // Unordered list block
        if (/^\s*[-*+]\s+/.test(line)) {
            const items: string[] = [];
            while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i] ?? '')) {
                items.push(renderInline((lines[i] ?? '').replace(/^\s*[-*+]\s+/, '')));
                i++;
            }
            out.push(`<ul>${items.map((t) => `<li>${t}</li>`).join('')}</ul>`);
            continue;
        }
        // Ordered list block
        if (/^\s*\d+\.\s+/.test(line)) {
            const items: string[] = [];
            while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] ?? '')) {
                items.push(renderInline((lines[i] ?? '').replace(/^\s*\d+\.\s+/, '')));
                i++;
            }
            out.push(`<ol>${items.map((t) => `<li>${t}</li>`).join('')}</ol>`);
            continue;
        }
        // Blank line ⇒ paragraph break.
        if (!line.trim()) {
            i++;
            continue;
        }
        // Paragraph: gather consecutive non-special lines.
        const para: string[] = [line];
        i++;
        while (
            i < lines.length &&
            (lines[i] ?? '').trim() &&
            !/^```/.test(lines[i] ?? '') &&
            !/^\s*[-*+]\s+/.test(lines[i] ?? '') &&
            !/^\s*\d+\.\s+/.test(lines[i] ?? '')
        ) {
            para.push(lines[i] ?? '');
            i++;
        }
        out.push(`<p>${renderInline(para.join('\n'))}</p>`);
    }
    return out.join('');
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers exported for tests
// ────────────────────────────────────────────────────────────────────────────

/**
 * Convert a server-shaped message ({ seq, role, content: [...blocks] }) into
 * the manager's internal flat structure. Pure function — no `this`.
 */
export function hydrateMessage(m: ServerMessage): MessageBlock {
    const blocks: MessageContentBlock[] = Array.isArray(m.content)
        ? m.content
        : [{ type: 'text', text: String(m.content ?? '') }];
    const mentions = Array.isArray(m.mentions)
        ? m.mentions
              .map((x) => (typeof x === 'string' ? x : x?.path ?? ''))
              .filter((p): p is string => !!p)
        : [];
    return {
        id: `m${m.seq ?? Ids.short()}`,
        role: m.role,
        blocks,
        seq: m.seq ?? null,
        error: null,
        mentions,
    };
}

/**
 * Walk backwards from the given caret position in `value` and, if the caret is
 * inside an `@<token>` (no whitespace, `@` either at start or after whitespace),
 * return `{ token, anchor }` where `anchor` is the index of the `@`. Otherwise
 * null.
 *
 * Pure helper extracted so the mention popup logic can be unit-tested without
 * spinning up a DOM textarea.
 */
export function extractMentionContext(
    value: string,
    caret: number,
): { token: string; anchor: number } | null {
    let i = caret - 1;
    let token = '';
    while (i >= 0) {
        const ch = value[i] ?? '';
        if (ch === '@') {
            if (i === 0 || /\s/.test(value[i - 1] ?? '')) {
                return { token, anchor: i };
            }
            return null;
        }
        if (/\s/.test(ch)) return null;
        token = ch + token;
        i--;
    }
    return null;
}

/**
 * Parse an inline citation token. Recognised forms:
 *   - `path/to/file.ext:42`
 *   - `path/to/file.ext:42-58`
 *   - `path/to/file.ext#heading-id`
 *
 * Returns null if the path's extension isn't a recognised text/source type
 * (so we don't mangle real arbitrary code). Pure helper, exported for tests.
 */
export function parseCitation(text: string): Citation | null {
    const EXTS = /\.(md|markdown|mdx|rs|py|js|mjs|cjs|ts|tsx|jsx|vue|svelte|go|java|kt|kts|c|cc|cpp|cxx|h|hpp|hh|m|mm|swift|rb|php|cs|scala|toml|yaml|yml|json|jsonc|html|htm|css|scss|sass|less|txt|sh|bash|zsh|fish|sql|xml|ini|conf|cfg|env|lua|r|dart)$/i;
    let m = text.match(/^([^\s:#]+):(\d+)(?:-(\d+))?$/);
    if (m) {
        const path = m[1] ?? '';
        const dotIdx = path.lastIndexOf('.');
        const ext = dotIdx >= 0 ? path.slice(dotIdx) : '';
        if (!EXTS.test(ext)) return null;
        return {
            path,
            line: Number(m[2]),
            lineEnd: m[3] ? Number(m[3]) : null,
            anchor: null,
        };
    }
    m = text.match(/^([^\s:#]+)#([A-Za-z0-9_\-:.]+)$/);
    if (m) {
        const path = m[1] ?? '';
        const dotIdx = path.lastIndexOf('.');
        const ext = dotIdx >= 0 ? path.slice(dotIdx) : '';
        if (!EXTS.test(ext)) return null;
        return { path, line: null, lineEnd: null, anchor: m[2] ?? null };
    }
    return null;
}

// ────────────────────────────────────────────────────────────────────────────
// SVG icons. Kept inline so we don't ship a separate icon font / sprite.
// ────────────────────────────────────────────────────────────────────────────

// Speech bubble + 3 short text lines — the bubble's body (excluding the
// bottom-left tail) is centered on the viewBox so the icon doesn't look
// top-heavy. Inside, three horizontal lines of decreasing length suggest
// a paragraph of dialogue text, reading as "a conversation about
// content" without leaning on a glyph.
const ICON_CHAT = `
<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M4 4.5 H20 A2 2 0 0 1 22 6.5 V17.5 A2 2 0 0 1 20 19.5 H10 L7 22.5 V19.5 H4 A2 2 0 0 1 2 17.5 V6.5 A2 2 0 0 1 4 4.5 Z"/>
    <path d="M7 9.5 H17 M7 12 H17 M7 14.5 H13"/>
</svg>`;

const ICON_CLOSE = `
<svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M7 7 L17 17 M17 7 L7 17" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
</svg>`;

// Cross-window message protocol between an in-page ChatManager and its popout
// twin. A typo on either side would silently drop the handoff, so all sites
// reference these constants.
const MSG = {
    POPOUT_READY: 'markon-chat-popout-ready',
    SELECTION:    'markon-chat-selection',
    DRAFT:        'markon-chat-draft',
    DOCK_BACK:    'markon-chat-dock-back',
} as const;

const ICON_PLUS = `
<svg viewBox="0 0 24 24" width="16" height="16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M12 5 V19 M5 12 H19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
</svg>`;

const ICON_SEND = `
<svg viewBox="0 0 24 24" width="16" height="16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M12 18 V6 M6 12 L12 6 L18 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const ICON_STOP = `
<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect x="6" y="6" width="12" height="12" rx="2"/>
</svg>`;

const ICON_CHEVRON = `
<svg viewBox="0 0 24 24" width="12" height="12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M9 6 L15 12 L9 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

// Pencil — rename action. Drawn small (14px) so it sits beside the title
// without competing visually; renaming is a low-frequency action.
const ICON_EDIT = `
<svg viewBox="0 0 24 24" width="14" height="14" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M4 20h4L18 10l-4-4L4 16v4Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M14 6l4 4" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
</svg>`;

// "Open in new window" — pops the chat into its own browser-level window
// (no address bar / toolbars). Same family as the standard Lucide /
// external-link icon: a square with an arrow leaving its top-right corner.
const ICON_POPOUT = `
<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M14 4h6v6"/>
    <path d="M10 14 20 4"/>
    <path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>
</svg>`;

// Reverse of ICON_POPOUT — the popout window's "dock back to in-page" action.
// Same box outline; the diagonal points the other way (upper-right → into the
// box) and the L-shaped arrowhead is at the inside corner so it reads as an
// arrow *entering* the box rather than leaving it.
const ICON_DOCK = `
<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>
    <path d="M20 4 14 10"/>
    <path d="M14 4v6h6"/>
</svg>`;

// Open double-quote glyph — leads the quoted-selection chip above the input.
// Derived from Material's `format_quote` (close-quote shape: block on top,
// tails down-left) by flipping both axes: y → 24 − y mirrors block to the
// bottom, then x → 24 − x swings the tails to the upper-right. The result
// reads as the glyph that *opens* a quotation, with the tails pointing into
// the text on the right.
const ICON_QUOTE = `
<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M18 7h-3l-2 4v6h6v-6h-3zm-8 0H7l-2 4v6h6v-6H8z"/>
</svg>`;

// ────────────────────────────────────────────────────────────────────────────
// ChatManager
// ────────────────────────────────────────────────────────────────────────────

/** Minimal i18n-lookup signature; we use the global window facade if present. */
type I18nFn = (key: string, ...args: unknown[]) => string;

export class ChatManager {
    #app: unknown;
    #workspaceId: string;
    #i18n: I18nFn;

    // DOM
    #container: HTMLElement | null = null;          // root: morphs sphere ↔ panel via .expanded class
    #face: HTMLElement | null = null;               // sphere/handle inside container
    #panel: HTMLElement | null = null;              // body inside container
    #layer: FloatingLayer | null = null;            // FloatingLayer — owns position, drag, morph, collision
    #threadTitleEl: HTMLElement | null = null;
    #threadDropdownBtn: HTMLButtonElement | null = null;
    #threadDropdownMenu: HTMLElement | null = null;
    #messageList: HTMLElement | null = null;
    #scrollPill: HTMLButtonElement | null = null;
    #textarea: HTMLTextAreaElement | null = null;
    #sendBtn: HTMLButtonElement | null = null;
    #sendIcon: HTMLElement | null = null;
    #stopIcon: HTMLElement | null = null;
    #quoteChip: HTMLElement | null = null;
    #quoteText: HTMLElement | null = null;
    #quoteDismiss: HTMLButtonElement | null = null;
    #popoutBtn: HTMLButtonElement | null = null;

    // Popout — when the user clicks the maximize icon, the chat moves into
    // its own browser-level window. While that window is alive we route every
    // chat action (selection, sphere click) into it instead of expanding the
    // in-page panel. Polling `closed` is the only reliable cross-window way
    // to detect a user-initiated close — there's no portable 'window closed'
    // event the opener can subscribe to.
    #popoutWindow: Window | null = null;
    #popoutWatcherId: ReturnType<typeof setInterval> | null = null;
    #popoutMode = false;          // true in the popout window itself

    // Default chat surface — read once at init from the `default-chat-mode`
    // meta tag, sourced from AppSettings.default_chat_mode. "in_page" expands
    // the floating panel; "popout" spawns a standalone window. Either choice
    // is inverted for a single click/press by holding Shift on the trigger
    // (sphere click, 聊聊 button, TOGGLE_CHAT shortcut).
    #defaultMode: 'in_page' | 'popout' = 'in_page';

    // Free-resize support — the panel uses CSS `resize: both` for the native
    // BR-corner handle. We persist the user's chosen size into a per-workspace
    // localStorage entry and surface it via a dedicated <style> element so the
    // saved width/height are baked into the .expanded rule (not inline). That
    // keeps sphere mode's 40×40 untouched (inline width would override it),
    // and lets FloatingLayer's collapse-time `style.width = ''` clear path
    // continue to work as written.
    #sizeStyleEl: HTMLStyleElement | null = null;
    #resizeObserver: ResizeObserver | null = null;

    // State
    #threads: ChatThread[] = [];
    #currentThreadId: string | null = null;
    #messagesByThread: Map<string, MessageBlock[]> = new Map();
    #abortController: AbortController | null = null;
    #streaming = false;
    #threadsLoaded = false;     // gates the one-shot threads/restore on first open
    #stickToBottom = true;
    #renderRafId: number | null = null;
    #renderRafTs = 0;
    #pendingAssistant: MessageBlock | null = null;  // The in-flight assistant message (rendered live)
    #pendingSelection: string | null = null;        // selection text queued by Ask-AI before panel opens

    // Mention autocomplete
    #mentions: Set<string> = new Set();             // paths the user has inserted via the popup
    #mentionPopup: HTMLElement | null = null;
    #mentionRows: MentionRow[] = [];
    #mentionActiveIdx = 0;
    #mentionAnchorPos = -1;
    #mentionDebounceId: ReturnType<typeof setTimeout> | null = null;
    #mentionAbortCtrl: AbortController | null = null;
    #mentionOutsideHandler: ((e: MouseEvent) => void) | null = null;

    constructor(app: unknown) {
        this.#app = app;
        this.#workspaceId = Meta.get(CONFIG.META_TAGS.WORKSPACE_ID) || '';
        const tFn = typeof window !== 'undefined' && window.__MARKON_I18N__ && window.__MARKON_I18N__.t;
        this.#i18n = tFn || ((k: string) => k);
        // Suppress "unused" warning: #app is held for parity with the JS API
        // and may be referenced by future hooks (e.g. dispatching commands).
        void this.#app;
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────

    init(): void {
        if (!Meta.flag(CONFIG.META_TAGS.ENABLE_CHAT)) return;
        if (!this.#workspaceId) {
            Logger.warn('Chat', 'enable-chat is on but workspace-id is missing; skipping init');
            return;
        }

        this.#defaultMode = this.#readDefaultMode();

        this.#createContainer();
        this.#setupFloatingLayer();
        this.#wirePopoutMessages();
        this.#applySavedSize();
        this.#observePanelResize();

        Logger.log('Chat', `Initialized (workspace=${this.#workspaceId}, defaultMode=${this.#defaultMode})`);
    }

    /** Read the `default-chat-mode` meta tag (server-rendered from
     *  AppSettings.default_chat_mode). Anything that isn't the literal
     *  string "popout" falls back to in-page — matches the backend's own
     *  normalization in `to_server_config`. */
    #readDefaultMode(): 'in_page' | 'popout' {
        const v = Meta.get(CONFIG.META_TAGS.DEFAULT_CHAT_MODE) || '';
        return v === 'popout' ? 'popout' : 'in_page';
    }

    /** Mode to use for THIS open action. Default mode unless `invert` is
     *  set (Shift-modified click / shortcut), in which case the alternate
     *  surface is selected for that single press. */
    #effectiveMode(invert: boolean): 'in_page' | 'popout' {
        const inverted = this.#defaultMode === 'in_page' ? 'popout' : 'in_page';
        return invert ? inverted : this.#defaultMode;
    }

    /** Bake the user's saved panel size (if any) into a dedicated <style>
     *  element scoped to `.markon-chat-container.expanded`. Same selector as
     *  chat.css's default rule; later in DOM order so it wins by source order
     *  alone — no `!important` needed. The override only applies when the
     *  panel is in expanded mode, so collapsed-sphere geometry (40×40) is
     *  untouched. Skipped in popout mode where the panel IS the window. */
    #applySavedSize(): void {
        if (this.#popoutMode) return;
        if (!this.#sizeStyleEl) {
            this.#sizeStyleEl = document.createElement('style');
            this.#sizeStyleEl.dataset.markon = 'chat-size-override';
            document.head.appendChild(this.#sizeStyleEl);
        }
        const saved = this.#readSavedSize();
        this.#sizeStyleEl.textContent = saved
            ? `.markon-chat-container.expanded { width: ${saved.w}px; height: ${saved.h}px; }`
            : '';
    }

    #readSavedSize(): { w: number; h: number } | null {
        try {
            const raw = localStorage.getItem(`${CONFIG.STORAGE_KEYS.CHAT_SIZE}:${this.#workspaceId}`);
            if (!raw) return null;
            const parsed = JSON.parse(raw) as { w?: unknown; h?: unknown };
            const w = typeof parsed.w === 'number' ? parsed.w : NaN;
            const h = typeof parsed.h === 'number' ? parsed.h : NaN;
            if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
            if (w < 200 || h < 200) return null;       // junk / mid-morph residue
            return { w, h };
        } catch {
            return null;
        }
    }

    /** Watch the container size while it's expanded; debounce-write to
     *  localStorage and refresh the size <style> so the next expand boots at
     *  the new size without a flash. We filter out:
     *   • collapsed (sphere) frames — class check
     *   • mid-morph transient frames — w/h threshold
     *  Skipped in popout mode: the panel IS the window there and OS-level
     *  resize is what we want, not a saved override that would later override
     *  the in-page panel back in the opener. */
    #observePanelResize(): void {
        if (!this.#container || this.#popoutMode) return;
        const persist = debounce((w: number, h: number) => {
            try {
                localStorage.setItem(
                    `${CONFIG.STORAGE_KEYS.CHAT_SIZE}:${this.#workspaceId}`,
                    JSON.stringify({ w, h }),
                );
            } catch { /* quota / disabled — silently skip */ }
            if (this.#sizeStyleEl) {
                this.#sizeStyleEl.textContent =
                    `.markon-chat-container.expanded { width: ${w}px; height: ${h}px; }`;
            }
        }, 200);
        this.#resizeObserver = new ResizeObserver(() => {
            const c = this.#container;
            if (!c || !c.classList.contains('expanded')) return;
            const w = c.offsetWidth;
            const h = c.offsetHeight;
            if (w < 240 || h < 320) return;  // mid-morph or just-snapped sphere
            persist(w, h);
        });
        this.#resizeObserver.observe(this.#container);
    }

    /** Listen for messages the popout window posts to its opener:
     *   • `ready`     — popout finished booting; safe to send the queued
     *                   handoff (pending selection + textarea draft).
     *   • `dock-back` — popout's dock button was clicked; tear down popout
     *                   state and expand the in-page panel so the user lands
     *                   back where they were. */
    #wirePopoutMessages(): void {
        window.addEventListener('message', (e: MessageEvent) => {
            if (e.origin !== location.origin) return;
            // Only trust messages from a popout we actually spawned.
            if (!this.#popoutWindow || e.source !== this.#popoutWindow) return;
            const d = e.data as { type?: string } | null;
            if (!d) return;
            if (d.type === MSG.POPOUT_READY) {
                this.#flushPopoutHandoff();
            } else if (d.type === MSG.DOCK_BACK) {
                this.#popoutWindow = null;
                if (this.#popoutWatcherId) clearInterval(this.#popoutWatcherId);
                this.#popoutWatcherId = null;
                setTimeout(() => this.#layer?.expand(), 0);
            }
        });
    }

    /** Push whatever the in-page chat had queued — pending selection chip and
     *  any unsent textarea draft — over to the popout once it's ready. Without
     *  this, opening the popout while a quote was already attached would
     *  silently drop that context. */
    #flushPopoutHandoff(): void {
        if (!this.#popoutWindow || this.#popoutWindow.closed) return;
        const draft = (this.#textarea?.value ?? '').trim();
        const selection = this.#pendingSelection;
        if (selection) {
            this.#popoutWindow.postMessage(
                { type: MSG.SELECTION, text: selection, currentDoc: null },
                location.origin,
            );
        }
        if (draft) {
            this.#popoutWindow.postMessage(
                { type: MSG.DRAFT, text: draft },
                location.origin,
            );
        }
        // The handoff has been delivered — clear the local state so the
        // in-page panel doesn't double-up on the same context next time it's
        // reopened (e.g. after the popout is closed via dock-back).
        if (selection || draft) {
            this.#pendingSelection = null;
            this.#hideQuoteChip();
            if (this.#textarea) {
                this.#textarea.value = '';
                this.#autoGrowTextarea();
            }
        }
    }

    #dockBackToOpener(): void {
        try {
            const opener = window.opener as Window | null;
            if (opener && !opener.closed) {
                opener.postMessage({ type: MSG.DOCK_BACK }, location.origin);
            }
        } catch {
            /* opener may have navigated away or been closed — fall through to
               window.close() and let the user end up wherever the browser
               default lands them. */
        }
        window.close();
    }

    // ── Public API ─────────────────────────────────────────────────────────

    open(): void   { this.#layer?.expand(); }
    close(): void  { this.#layer?.collapse(); }
    toggle(): void { this.#layer?.toggle(); }

    /** Open the chat in the user's default surface (or its inverse if
     *  `invert` is set). Used by the TOGGLE_CHAT shortcut and any other
     *  generic "open the chat" entry-point that doesn't carry selection. */
    openInDefault({ invert = false }: { invert?: boolean } = {}): void {
        this.#open({ invert });
    }

    /** Quote a chunk of selected text in the input. `shift` inverts the
     *  default surface for this single open (Shift-click on the 聊聊 button).
     *  Selection routing for every (popout-alive / popout-mode / default-mode)
     *  combination is decided in {@link #resolveOpenTarget}. */
    openWithSelection({ text, currentDoc = null, shift = false }: { text?: string; currentDoc?: string | null; shift?: boolean } = {}): void {
        this.#open({ invert: shift, text, currentDoc });
    }

    /** Surface to use for a single open action. Each branch is a leaf the
     *  caller (or the sphere-click intercept) acts on. */
    #resolveOpenTarget({ invert, hasSelection }: { invert: boolean; hasSelection: boolean }):
        | { kind: 'noop' }
        | { kind: 'focus-popout' }
        | { kind: 'prefill-popout' }
        | { kind: 'spawn-popout' }
        | { kind: 'expand-in-page' } {
        if (this.#popoutWindow && !this.#popoutWindow.closed) return { kind: 'focus-popout' };
        if (this.#popoutMode) return hasSelection ? { kind: 'prefill-popout' } : { kind: 'noop' };
        return this.#effectiveMode(invert) === 'popout'
            ? { kind: 'spawn-popout' }
            : { kind: 'expand-in-page' };
    }

    /** Single dispatch for every "open the chat (maybe with selection)"
     *  entry-point. Why setTimeout(0) on the in-page expand: this is
     *  typically called from a click handler on a popover button.
     *  FloatingLayer's outside-click collapse is bound to `document` and
     *  fires later in the same click's bubble chain — synchronously
     *  expanding here would expand-then-collapse on the same gesture.
     *  setTimeout(0) defers past the click dispatch (microtasks aren't
     *  enough; per the HTML spec they run between listener invocations on
     *  the same bubble chain). */
    #open({ invert, text, currentDoc = null }: { invert: boolean; text?: string; currentDoc?: string | null }): void {
        const target = this.#resolveOpenTarget({ invert, hasSelection: !!text });
        switch (target.kind) {
            case 'noop':
                return;
            case 'focus-popout':
                this.#popoutWindow?.focus();
                if (text) this.#popoutWindow?.postMessage(
                    { type: MSG.SELECTION, text, currentDoc },
                    location.origin,
                );
                return;
            case 'prefill-popout':
                this.#prefillSelection(text);
                return;
            case 'spawn-popout':
                this.#prefillSelection(text);     // staged for ready-handshake flush
                this.#openPopout();
                return;
            case 'expand-in-page':
                setTimeout(() => this.#layer?.expand(), 0);
                this.#prefillSelection(text);
                return;
        }
    }

    /** Initialize in popout-window mode: skip FloatingLayer entirely (the
     *  panel IS the window), build the DOM in always-expanded state, and
     *  drive the same lazy thread-load that FloatingLayer's onExpand would.
     *  Called by main.ts when the page boots with `?chat_popout=1`. */
    initPopout(): void {
        if (!this.#workspaceId) {
            Logger.warn('Chat', 'enable-chat is on but workspace-id is missing; skipping popout init');
            return;
        }
        this.#popoutMode = true;
        document.body.classList.add('markon-chat-popout-mode');
        this.#createContainer();
        if (this.#container) {
            // Pre-set the expanded class so the body is shown and the panel
            // CSS rules (chat-popout-mode override) take it to full viewport.
            this.#container.classList.add('expanded', 'popout-mode');
        }

        // The popout-mode header repurposes the popout button as a "dock back
        // to in-page" affordance. Same slot, mirrored icon, opposite action.
        if (this.#popoutBtn) {
            const dockLabel = this.#tt('web.chat.dock', 'Back to in-page chat');
            this.#popoutBtn.innerHTML = ICON_DOCK;
            this.#popoutBtn.title = dockLabel;
            this.#popoutBtn.setAttribute('aria-label', dockLabel);
        }

        // Drive the same lazy initial-load FloatingLayer.onExpand would have.
        void this.#onLayerExpand();

        // Inbound messages from opener: selection chips and draft pre-fills
        // (the latter only sent on initial handoff when the user popped out
        // mid-compose). Ignore foreign origins for sanity.
        window.addEventListener('message', (e: MessageEvent) => {
            if (e.origin !== location.origin) return;
            const d = e.data as
                | { type?: string; text?: string; currentDoc?: string | null }
                | null;
            if (!d) return;
            if (d.type === MSG.SELECTION && typeof d.text === 'string') {
                this.openWithSelection({ text: d.text, currentDoc: d.currentDoc ?? null });
            } else if (d.type === MSG.DRAFT && typeof d.text === 'string') {
                if (this.#textarea) {
                    this.#textarea.value = d.text;
                    this.#textarea.focus();
                    this.#textarea.setSelectionRange(d.text.length, d.text.length);
                    this.#autoGrowTextarea();
                }
            }
        });

        // Tell the opener we're ready to receive the handoff. Posting before
        // the load event would race against the opener's listener wiring
        // (which it does in init()); deferring to load makes the contract
        // explicit. The opener responds by flushing its queued selection + draft.
        const announceReady = (): void => {
            try {
                const opener = window.opener as Window | null;
                opener?.postMessage({ type: MSG.POPOUT_READY }, location.origin);
            } catch {
                /* opener gone — popout still works, just without the handoff. */
            }
        };
        if (document.readyState === 'complete') announceReady();
        else window.addEventListener('load', announceReady, { once: true });
    }

    #openPopout(): void {
        // Re-clicking the popout button when one already exists just refocuses.
        if (this.#popoutWindow && !this.#popoutWindow.closed) {
            this.#popoutWindow.focus();
            return;
        }
        // Standalone chat URL — served by `/{ws}/_/chat` (template chat.html),
        // not the markdown page with a query flag. The popout window therefore
        // doesn't pay the cost of rendering markdown, TOC, annotations, etc.
        const url = `/${encodeURIComponent(this.#workspaceId)}/_/chat`;
        // No address bar / toolbars: the chat's own header IS the chrome.
        // resizable=yes so the user can grow the window if they want.
        const features = 'popup=yes,width=440,height=640,menubar=no,toolbar=no,location=no,status=no,resizable=yes';
        const win = window.open(url, 'markon-chat-popout', features);
        if (!win) {
            Logger.warn('Chat', 'popup blocked — could not open chat window');
            return;
        }
        this.#popoutWindow = win;
        this.close();          // collapse the in-page panel — popout owns the chat now
        this.#startPopoutWatcher();
    }

    /** Poll for popout-window closure. There's no portable 'window closed'
     *  event the opener can subscribe to, so we sample `closed` on a 1Hz
     *  interval; when it flips, we tear down the popout state and the in-page
     *  chat resumes serving subsequent selections. */
    #startPopoutWatcher(): void {
        if (this.#popoutWatcherId) clearInterval(this.#popoutWatcherId);
        this.#popoutWatcherId = setInterval(() => {
            if (!this.#popoutWindow || this.#popoutWindow.closed) {
                this.#popoutWindow = null;
                if (this.#popoutWatcherId) clearInterval(this.#popoutWatcherId);
                this.#popoutWatcherId = null;
            }
        }, 1000);
    }

    /** Drop arbitrary text into the textarea, focus it, and place the caret
     *  at the end. Public because external modules (popover, shortcuts) may
     *  want to seed the input without going through openWithSelection. */
    prefillInput(text: string): void {
        if (!this.#textarea) return;
        this.#textarea.value = text || '';
        this.#textarea.focus();
        this.#textarea.setSelectionRange(this.#textarea.value.length, this.#textarea.value.length);
        this.#autoGrowTextarea();
    }

    // ── Container (sphere ↔ panel morph) ──────────────────────────────────

    #createContainer(): void {
        const tooltip     = this.#tt('web.chat.tooltip', 'AI Chat');
        const newLabel    = this.#tt('web.chat.new',    'New thread');
        const switchLabel = this.#tt('web.chat.switch', 'Switch thread');
        const sendLabel   = this.#tt('web.chat.send',   'Send');
        const placeholder = this.#tt('web.chat.placeholder', 'Ask anything…');
        const titlePh     = this.#tt('web.chat.title.placeholder', 'New chat');

        // Single container morphs between sphere (40×40) and panel (≈420×600).
        // The face is BR-pinned when expanded (becomes the close X), so the
        // sphere "stays put" visually while the panel grows up-left from it.
        // Body holds header + messages + footer; it's hidden when collapsed.
        const wrap = document.createElement('div');
        wrap.innerHTML = `
            <div id="markon-chat-container" class="markon-chat-container" role="dialog" aria-label="AI Chat">
                <div class="markon-chat-face" title="${escapeHtml(tooltip)}" aria-label="${escapeHtml(tooltip)}">
                    <span class="markon-chat-face-icon icon-chat">${ICON_CHAT}</span>
                    <span class="markon-chat-face-icon icon-close">${ICON_CLOSE}</span>
                </div>
                <div class="markon-chat-body">
                    <header class="markon-chat-header">
                        <div class="markon-chat-header-left-actions">
                            <button type="button" class="markon-chat-icon-btn markon-chat-popout" title="${escapeHtml(this.#tt('web.chat.popout', 'Open in new window'))}" aria-label="${escapeHtml(this.#tt('web.chat.popout', 'Open in new window'))}">${ICON_POPOUT}</button>
                        </div>
                        <div class="markon-chat-header-titlebar">
                            <span class="markon-chat-thread-title" data-placeholder="${escapeHtml(titlePh)}"></span>
                            <button type="button" class="markon-chat-icon-btn markon-chat-rename" title="${escapeHtml(this.#tt('web.chat.rename', 'Rename'))}" aria-label="${escapeHtml(this.#tt('web.chat.rename', 'Rename'))}">${ICON_EDIT}</button>
                        </div>
                        <div class="markon-chat-header-actions">
                            <button type="button" class="markon-chat-icon-btn markon-chat-thread-switcher" aria-haspopup="listbox" title="${escapeHtml(switchLabel)}" aria-label="${escapeHtml(switchLabel)}">${ICON_CHEVRON}</button>
                            <button type="button" class="markon-chat-icon-btn markon-chat-new" title="${escapeHtml(newLabel)}" aria-label="${escapeHtml(newLabel)}">${ICON_PLUS}</button>
                        </div>
                        <div class="markon-chat-thread-menu" role="listbox" hidden></div>
                    </header>
                    <div class="markon-chat-messages-wrap">
                        <div class="markon-chat-messages" role="log" aria-live="polite"></div>
                        <button type="button" class="markon-chat-scroll-pill" hidden>${this.#tt('web.chat.scroll.pill', '↓ new messages')}</button>
                    </div>
                    <footer class="markon-chat-footer">
                        <div class="markon-chat-input-group">
                            <div class="markon-chat-quote-chip" hidden>
                                <span class="markon-chat-quote-icon" aria-hidden="true">${ICON_QUOTE}</span>
                                <span class="markon-chat-quote-text"></span>
                                <button type="button" class="markon-chat-quote-dismiss" title="${escapeHtml(this.#tt('web.chat.quote.dismiss', 'Remove quote'))}" aria-label="${escapeHtml(this.#tt('web.chat.quote.dismiss', 'Remove quote'))}">${ICON_CLOSE}</button>
                            </div>
                            <textarea
                                class="markon-chat-input"
                                rows="1"
                                placeholder="${escapeHtml(placeholder)}"
                                spellcheck="true"
                                autocomplete="off"></textarea>
                            <button type="button" class="markon-chat-send" title="${escapeHtml(sendLabel)}" aria-label="${escapeHtml(sendLabel)}">
                                <span class="markon-chat-send-icon">${ICON_SEND}</span>
                                <span class="markon-chat-stop-icon" hidden>${ICON_STOP}</span>
                            </button>
                        </div>
                    </footer>
                </div>
            </div>
        `.trim();
        this.#container = wrap.firstElementChild as HTMLElement;
        document.body.appendChild(this.#container);

        this.#face  = this.#container.querySelector<HTMLElement>('.markon-chat-face');
        this.#panel = this.#container.querySelector<HTMLElement>('.markon-chat-body');

        // Cache the bits we touch on every send/render. Looking these up once
        // (rather than per-event) avoids re-querying the panel subtree.
        if (this.#panel) {
            this.#threadTitleEl      = this.#panel.querySelector<HTMLElement>('.markon-chat-thread-title');
            this.#threadDropdownBtn  = this.#panel.querySelector<HTMLButtonElement>('.markon-chat-thread-switcher');
            this.#threadDropdownMenu = this.#panel.querySelector<HTMLElement>('.markon-chat-thread-menu');
            this.#messageList        = this.#panel.querySelector<HTMLElement>('.markon-chat-messages');
            this.#scrollPill         = this.#panel.querySelector<HTMLButtonElement>('.markon-chat-scroll-pill');
            this.#textarea           = this.#panel.querySelector<HTMLTextAreaElement>('.markon-chat-input');
            this.#sendBtn            = this.#panel.querySelector<HTMLButtonElement>('.markon-chat-send');
            this.#sendIcon           = this.#sendBtn?.querySelector<HTMLElement>('.markon-chat-send-icon') ?? null;
            this.#stopIcon           = this.#sendBtn?.querySelector<HTMLElement>('.markon-chat-stop-icon') ?? null;
            this.#quoteChip          = this.#panel.querySelector<HTMLElement>('.markon-chat-quote-chip');
            this.#quoteText          = this.#panel.querySelector<HTMLElement>('.markon-chat-quote-text');
            this.#quoteDismiss       = this.#panel.querySelector<HTMLButtonElement>('.markon-chat-quote-dismiss');
            this.#popoutBtn          = this.#panel.querySelector<HTMLButtonElement>('.markon-chat-popout');
        }

        this.#wirePanelEvents();
    }

    /** Hand position/drag/morph/collision off to FloatingLayer. Drag is
     *  initiated from the header (the body has scrollable messages and an
     *  input — neither should start a panel drag). */
    #setupFloatingLayer(): void {
        if (!this.#container || !this.#face || !this.#panel) return;
        this.#layer = new FloatingLayer({
            name: 'chat',
            container: this.#container,
            handle: this.#face,
            body: this.#panel,
            panelSize: { width: 420, height: 600 },
            homeAnchor: 'BR',
            // Same morph as the Live panel: the sphere becomes the panel's
            // top-left corner button (X close), and the panel grows
            // down-right from there. If that direction would overflow the
            // viewport, FloatingLayer's clamp shifts both the sphere and
            // the panel up-left until everything fits — clicking the X at
            // the same screen spot then collapses back to the sphere.
            panelAnchor: 'TL',
            initialOffset: { right: 20, bottom: 70 },
            storageKey: CONFIG.STORAGE_KEYS.CHAT_POS,
            expandedDragHandle: '.markon-chat-header',
            // Header drag handle covers buttons too — FloatingLayer's 5px
            // threshold separates click from drag, so a normal click on the
            // thread switcher / rename / new still works while a small drag
            // gesture anywhere in the header bar moves the panel. Only true
            // text-edit surfaces and the open thread listbox are excluded
            // (those would lose focus / selection if drag intercepted).
            nonDragSelector: '[contenteditable="true"], input, textarea, [role="listbox"], [role="listbox"] *',
            onExpand:   () => this.#onLayerExpand(),
            onCollapse: () => { /* keep streams alive — closing only hides UI */ },
        });
        this.#layer.init();
    }

    #wirePanelEvents(): void {
        if (!this.#panel) return;
        // Close lives on the BR sphere/face — clicking it toggles via FloatingLayer.
        this.#panel.querySelector<HTMLButtonElement>('.markon-chat-new')
            ?.addEventListener('click', () => this.#createNewThread());
        this.#panel.querySelector<HTMLButtonElement>('.markon-chat-rename')
            ?.addEventListener('click', (e: MouseEvent) => {
                // Rename is a low-frequency action moved out of the title text
                // itself (no more accidental edits when clicking the dropdown
                // hit area). Pencil icon → enter inline edit mode.
                e.stopPropagation();
                this.#enterTitleEdit();
            });
        // Whole switcher (title text + chevron) toggles the thread dropdown.
        this.#threadDropdownBtn?.addEventListener('click', () => this.#toggleThreadMenu());

        // Quote chip dismiss — drops the queued selection and hides the chip.
        // The textarea body is unaffected (the chip never wrote into it).
        this.#quoteDismiss?.addEventListener('click', (e: MouseEvent) => {
            e.preventDefault();
            this.#hideQuoteChip();
            this.#textarea?.focus();
        });

        // Popout button — wears two hats:
        //   • In-page mode: pops the chat into its own browser-level window.
        //   • Popout mode:  docks back, signaling the opener to expand its
        //                   in-page panel and then closing this window.
        // The icon + tooltip are swapped in #initPopout when we're the popout.
        this.#popoutBtn?.addEventListener('click', (e: MouseEvent) => {
            e.preventDefault();
            if (this.#popoutMode) this.#dockBackToOpener();
            else                  this.#openPopout();
        });

        // Face click intercept (capture phase). FloatingLayer's own
        // bubble-phase listener handles the in-page expand / collapse;
        // we only take over for targets that need a different action
        // (focus an existing popout, spawn a new one).
        this.#face?.addEventListener('click', (e: MouseEvent) => {
            const target = this.#resolveOpenTarget({ invert: e.shiftKey, hasSelection: false });
            if (target.kind === 'focus-popout') {
                e.stopImmediatePropagation();
                e.preventDefault();
                this.#popoutWindow?.focus();
                return;
            }
            // Only the *collapsed* sphere → popout transition. If the panel
            // is already expanded, let FloatingLayer collapse it.
            if (target.kind === 'spawn-popout' && !(this.#layer?.isExpanded)) {
                e.stopImmediatePropagation();
                e.preventDefault();
                this.#openPopout();
            }
        }, { capture: true });

        this.#threadTitleEl?.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') { e.preventDefault(); this.#threadTitleEl?.blur(); }
            if (e.key === 'Escape') { e.preventDefault(); void this.#exitTitleEdit(true); }
        });
        this.#threadTitleEl?.addEventListener('blur', () => { void this.#exitTitleEdit(false); });

        if (this.#textarea) {
            this.#textarea.addEventListener('input', () => {
                this.#autoGrowTextarea();
                this.#pruneMentions();
                this.#onTextareaInputForMentions();
            });
            this.#textarea.addEventListener('keydown', (e: KeyboardEvent) => {
                // Mention popup gets first dibs on nav keys when visible.
                if (this.#mentionPopup && !this.#mentionPopup.hidden) {
                    if (e.key === 'ArrowDown') { e.preventDefault(); this.#moveMentionActive(1); return; }
                    if (e.key === 'ArrowUp')   { e.preventDefault(); this.#moveMentionActive(-1); return; }
                    if (e.key === 'Enter' || e.key === 'Tab') {
                        if (this.#mentionRows.length > 0) {
                            e.preventDefault();
                            this.#commitMentionAt(this.#mentionActiveIdx);
                            return;
                        }
                    }
                    if (e.key === 'Escape') { e.preventDefault(); this.#hideMentionPopup(); return; }
                }
                if (e.key === 'Enter' && !e.shiftKey && !(e as KeyboardEvent & { isComposing?: boolean }).isComposing) {
                    e.preventDefault();
                    void this.#submit();
                }
            });
            this.#textarea.addEventListener('blur', () => {
                // Slight delay so a click on a popup row can fire first.
                setTimeout(() => this.#hideMentionPopup(), 120);
            });
            this.#textarea.addEventListener('click', () => this.#onTextareaInputForMentions());
            this.#textarea.addEventListener('keyup', (e: KeyboardEvent) => {
                // Caret-only keys (arrows, home/end) — re-evaluate mention context.
                if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
                    this.#onTextareaInputForMentions();
                }
            });
        }

        this.#sendBtn?.addEventListener('click', () => {
            if (this.#streaming) this.#abort();
            else                 void this.#submit();
        });

        // Track whether the user is "stuck to bottom". If they've scrolled
        // up while a stream is ongoing we stop auto-scrolling and show the
        // ↓ pill instead — one of the most common annoyances in chat UIs.
        this.#messageList?.addEventListener('scroll', () => {
            const nearBottom = this.#isNearBottom();
            this.#stickToBottom = nearBottom;
            if (nearBottom && this.#scrollPill) this.#scrollPill.hidden = true;
        }, { passive: true });

        this.#scrollPill?.addEventListener('click', () => {
            this.#stickToBottom = true;
            if (this.#scrollPill) this.#scrollPill.hidden = true;
            this.#scrollToBottom();
        });

        // Close the thread dropdown when clicking outside it. Listening on
        // the panel itself (capture) is enough — clicks outside the panel
        // don't matter because the panel is the only host.
        document.addEventListener('click', (e: MouseEvent) => {
            if (!this.#threadDropdownMenu || this.#threadDropdownMenu.hidden) return;
            const target = e.target as Element | null;
            if (target?.closest('.markon-chat-thread-menu')) return;
            if (target?.closest('.markon-chat-thread-switcher')) return;
            this.#threadDropdownMenu.hidden = true;
        });
    }

    // ── Panel open/close ──────────────────────────────────────────────────

    /** Fired by FloatingLayer after the container morphs to expanded. The
     *  layer handles the geometry; we use this hook to focus the input and
     *  lazily fetch threads on the very first open. */
    async #onLayerExpand(): Promise<void> {
        if (!this.#panel) return;
        this.#textarea?.focus();

        if (this.#threadsLoaded) return;
        this.#threadsLoaded = true;
        try {
            await this.#fetchThreads();
            const lastId = localStorage.getItem(this.#lastThreadKey());
            const target = (lastId && this.#threads.find((t) => t.id === lastId)?.id)
                || this.#threads[0]?.id
                || null;
            if (target) await this.#switchThread(target);
            else        this.#renderEmptyState();
        } catch (err) {
            Logger.error('Chat', 'Failed to load threads', err);
            this.#renderEmptyState(this.#tt('web.chat.error.threads', 'Failed to load threads'));
        }
    }

    // ── Threads list ───────────────────────────────────────────────────────

    async #fetchThreads(): Promise<void> {
        const res = await fetch(`/api/chat/${encodeURIComponent(this.#workspaceId)}/threads`);
        if (!res.ok) throw new Error(`threads HTTP ${res.status}`);
        this.#threads = (await res.json()) as ChatThread[];
        this.#renderThreadMenu();
    }

    #renderThreadMenu(): void {
        if (!this.#threadDropdownMenu) return;
        if (this.#threads.length === 0) {
            const empty = this.#tt('web.chat.threads.empty', 'No threads yet');
            this.#threadDropdownMenu.innerHTML = `<div class="markon-chat-thread-empty">${escapeHtml(empty)}</div>`;
            return;
        }
        const deleteLabel = this.#tt('web.chat.thread.delete', 'Delete thread');
        // Last-thread guard: deleting the only remaining thread would leave the
        // panel with no thread to switch into. Drop the delete affordance so the
        // user can't reach the broken state — the [+] button is the path to a
        // fresh thread instead.
        const hideDelete = this.#threads.length <= 1;
        this.#threadDropdownMenu.innerHTML = this.#threads.map((t) => {
            const active = t.id === this.#currentThreadId ? ' active' : '';
            const title = escapeHtml(t.title || this.#tt('web.chat.thread.untitled', 'Untitled'));
            const deleteBtn = hideDelete
                ? ''
                : `<button type="button" class="markon-chat-thread-row-delete" title="${escapeHtml(deleteLabel)}" aria-label="${escapeHtml(deleteLabel)}">${ICON_CLOSE}</button>`;
            return `
                <div class="markon-chat-thread-row${active}" role="option" data-id="${escapeHtml(t.id)}" tabindex="0">
                    <span class="markon-chat-thread-row-title">${title}</span>
                    ${deleteBtn}
                </div>
            `;
        }).join('');

        this.#threadDropdownMenu.querySelectorAll<HTMLElement>('.markon-chat-thread-row').forEach((row) => {
            row.addEventListener('click', (e: MouseEvent) => {
                const target = e.target as Element | null;
                if (target?.closest('.markon-chat-thread-row-delete')) return;
                const id = row.dataset.id;
                if (this.#threadDropdownMenu) this.#threadDropdownMenu.hidden = true;
                if (id) void this.#switchThread(id);
            });
        });
        this.#threadDropdownMenu.querySelectorAll<HTMLButtonElement>('.markon-chat-thread-row-delete').forEach((btn) => {
            btn.addEventListener('click', (e: MouseEvent) => {
                e.stopPropagation();
                const row = btn.closest<HTMLElement>('.markon-chat-thread-row');
                const id = row?.dataset.id;
                if (id) void this.#deleteThread(id);
            });
        });
    }

    #toggleThreadMenu(): void {
        if (!this.#threadDropdownMenu) return;
        this.#renderThreadMenu();
        this.#threadDropdownMenu.hidden = !this.#threadDropdownMenu.hidden;
    }

    async #createNewThread(): Promise<void> {
        try {
            const res = await fetch(`/api/chat/${encodeURIComponent(this.#workspaceId)}/threads`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const thread = (await res.json()) as ChatThread;
            this.#threads.unshift(thread);
            await this.#switchThread(thread.id);
        } catch (err) {
            Logger.error('Chat', 'Failed to create thread', err);
        }
    }

    async #deleteThread(id: string): Promise<void> {
        // Defense in depth: the render path already hides the delete button on
        // the last thread, but a stale handler / programmatic call shouldn't be
        // able to drain the list either.
        if (this.#threads.length <= 1) return;
        try {
            const res = await fetch(
                `/api/chat/${encodeURIComponent(this.#workspaceId)}/threads/${encodeURIComponent(id)}`,
                { method: 'DELETE' },
            );
            if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
        } catch (err) {
            Logger.error('Chat', 'Failed to delete thread', err);
            return;
        }
        this.#threads = this.#threads.filter((t) => t.id !== id);
        this.#messagesByThread.delete(id);
        if (this.#currentThreadId === id) {
            const next = this.#threads[0]?.id;
            if (next) await this.#switchThread(next);
            else { this.#currentThreadId = null; this.#renderEmptyState(); this.#updateTitle(''); }
        }
        this.#renderThreadMenu();
    }

    async #switchThread(id: string): Promise<void> {
        if (!id) return;
        // Don't refetch if we're already on this thread and have a render. New
        // messages from a streaming send already live in #messagesByThread.
        this.#currentThreadId = id;
        localStorage.setItem(this.#lastThreadKey(), id);
        const meta = this.#threads.find((t) => t.id === id);
        this.#updateTitle(meta?.title || '');

        if (this.#messagesByThread.has(id)) {
            this.#renderAllMessages();
            return;
        }

        // Show a transient loading hint so a slow fetch doesn't look frozen.
        if (this.#messageList) {
            this.#messageList.innerHTML = `<div class="markon-chat-empty">${escapeHtml(this.#tt('web.chat.loading', 'Loading…'))}</div>`;
        }
        try {
            const res = await fetch(
                `/api/chat/${encodeURIComponent(this.#workspaceId)}/threads/${encodeURIComponent(id)}`,
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = (await res.json()) as { messages?: ServerMessage[] };
            const messages = (data.messages || []).map((m) => hydrateMessage(m));
            this.#messagesByThread.set(id, messages);
            this.#renderAllMessages();
        } catch (err) {
            Logger.error('Chat', `Failed to load thread ${id}`, err);
            if (this.#messageList) {
                this.#messageList.innerHTML = `<div class="markon-chat-empty">${escapeHtml(this.#tt('web.chat.error.thread', 'Failed to load thread'))}</div>`;
            }
        }
    }

    // ── Title editing ──────────────────────────────────────────────────────

    #updateTitle(title: string): void {
        if (!this.#threadTitleEl) return;
        this.#threadTitleEl.textContent = title || '';
    }

    #enterTitleEdit(): void {
        if (!this.#threadTitleEl) return;
        this.#threadTitleEl.setAttribute('contenteditable', 'true');
        this.#threadTitleEl.focus();
        // Select all so typing replaces.
        const range = document.createRange();
        range.selectNodeContents(this.#threadTitleEl);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
    }

    async #exitTitleEdit(cancelled: boolean): Promise<void> {
        if (!this.#threadTitleEl) return;
        if (this.#threadTitleEl.getAttribute('contenteditable') !== 'true') return;
        this.#threadTitleEl.setAttribute('contenteditable', 'false');
        const meta = this.#threads.find((t) => t.id === this.#currentThreadId);
        if (cancelled) {
            this.#threadTitleEl.textContent = meta?.title || '';
            return;
        }
        const newTitle = (this.#threadTitleEl.textContent || '').trim();
        if (!meta || newTitle === meta.title) return;
        // Persistence: backend doesn't yet expose a PATCH for thread titles
        // (the agreed contract creates titles auto / via POST body). Keep the
        // optimistic update locally; the next backend pass will add a PATCH
        // and we can wire it here.
        meta.title = newTitle;
        this.#renderThreadMenu();
    }

    // ── Rendering ──────────────────────────────────────────────────────────

    #renderEmptyState(message?: string): void {
        if (!this.#messageList) return;
        const greeting = message
            || this.#tt('web.chat.empty', 'Start a new conversation by typing below.');
        this.#messageList.innerHTML = `<div class="markon-chat-empty">${escapeHtml(greeting)}</div>`;
    }

    #renderAllMessages(): void {
        if (!this.#messageList || !this.#currentThreadId) return;
        const list = this.#messagesByThread.get(this.#currentThreadId) || [];
        if (list.length === 0) { this.#renderEmptyState(); return; }
        this.#messageList.innerHTML = '';
        for (const msg of list) {
            this.#messageList.appendChild(this.#renderMessageElement(msg));
        }
        this.#stickToBottom = true;
        this.#scrollToBottom();
    }

    /** Build a fresh DOM tree for one message. We rebuild rather than diff
     *  because messages are tiny and tokens keep streaming — simpler is
     *  better than a virtual DOM here. */
    #renderMessageElement(msg: MessageBlock): HTMLElement {
        const el = document.createElement('div');
        el.className = `markon-chat-message markon-chat-message-${msg.role}`;
        el.dataset.id = msg.id;
        el.appendChild(this.#renderMessageBody(msg));
        return el;
    }

    #renderMessageBody(msg: MessageBlock): HTMLElement {
        const body = document.createElement('div');
        body.className = 'markon-chat-message-body';

        for (const block of msg.blocks) {
            if (block.type === 'text') {
                const span = document.createElement('div');
                span.className = 'markon-chat-text';
                span.innerHTML = renderMarkdown(block.text || '');
                if (msg.role === 'assistant') {
                    this.#decorateCitations(span);
                } else if (msg.role === 'user' && Array.isArray(msg.mentions) && msg.mentions.length > 0) {
                    this.#decorateMentions(span, msg.mentions);
                }
                body.appendChild(span);
            } else if (block.type === 'tool_use') {
                body.appendChild(this.#renderToolUse(block));
            } else if (block.type === 'tool_result') {
                body.appendChild(this.#renderToolResult(block));
            }
        }

        if (msg.error) {
            const err = document.createElement('div');
            err.className = 'markon-chat-error';
            err.textContent = msg.error;
            const retry = document.createElement('button');
            retry.type = 'button';
            retry.className = 'markon-chat-retry';
            retry.textContent = this.#tt('web.chat.retry', 'Retry');
            retry.addEventListener('click', () => this.#retryLast());
            err.appendChild(retry);
            body.appendChild(err);
        }

        if (msg.stopped) {
            const note = document.createElement('div');
            note.className = 'markon-chat-stopped';
            note.textContent = this.#tt('web.chat.stopped', '(stopped)');
            body.appendChild(note);
        }

        return body;
    }

    /** A tool call renders as a collapsed pill that expands to show the input
     *  args. The pill is a <details> so screen readers / keyboard nav work
     *  for free; the open/close affordance is the rotating chevron. */
    #renderToolUse(block: Extract<MessageContentBlock, { type: 'tool_use' }>): HTMLDetailsElement {
        const wrap = document.createElement('details');
        wrap.className = 'markon-chat-tool-call';
        const summary = document.createElement('summary');
        summary.innerHTML = `
            <span class="markon-chat-tool-pill-icon">${ICON_CHEVRON}</span>
            <span class="markon-chat-tool-name">${escapeHtml(block.name || 'tool')}</span>
        `;
        wrap.appendChild(summary);

        const argsBlock = document.createElement('pre');
        argsBlock.className = 'markon-chat-tool-args';
        let argsText = '';
        try { argsText = JSON.stringify(block.input ?? {}, null, 2); }
        catch { argsText = String(block.input ?? ''); }
        argsBlock.textContent = argsText;
        wrap.appendChild(argsBlock);

        return wrap;
    }

    /** Tool results: a code block under the call's pill. Auto-collapse if
     *  the body exceeds 10 lines so a giant grep dump doesn't dominate the
     *  scroll; user can expand to see the rest. */
    #renderToolResult(block: Extract<MessageContentBlock, { type: 'tool_result' }>): HTMLDetailsElement {
        const text = String(block.content ?? block.output ?? '');
        const lines = text.split('\n').length;
        const wrap = document.createElement('details');
        wrap.className = 'markon-chat-tool-result';
        if (block.is_error) wrap.classList.add('markon-chat-tool-result-error');
        // Collapsed by default for any result longer than 10 lines; short
        // results stay open so the reader doesn't have to click.
        if (lines <= 10) wrap.open = true;
        const head = lines > 10
            ? this.#tt('web.chat.tool.result.collapsed', `Result (${lines} lines)`).replace('{lines}', String(lines))
            : this.#tt('web.chat.tool.result', 'Result');
        const summary = document.createElement('summary');
        summary.innerHTML = `<span class="markon-chat-tool-pill-icon">${ICON_CHEVRON}</span> ${escapeHtml(head)}`;
        wrap.appendChild(summary);
        const pre = document.createElement('pre');
        pre.className = 'markon-chat-tool-output';
        pre.textContent = text;
        wrap.appendChild(pre);
        return wrap;
    }

    /** Replace the DOM for one message in place (used during streaming). We
     *  identify it by its `id` data attribute. */
    #rerenderMessage(msg: MessageBlock): void {
        if (!this.#messageList) return;
        const old = this.#messageList.querySelector(`.markon-chat-message[data-id="${CSS.escape(msg.id)}"]`);
        if (!old) {
            this.#messageList.appendChild(this.#renderMessageElement(msg));
        } else {
            old.replaceWith(this.#renderMessageElement(msg));
        }
        if (this.#stickToBottom) this.#scrollToBottom();
        else if (this.#scrollPill) this.#scrollPill.hidden = false;
    }

    /** Coalesce multiple stream chunks into one re-render per animation
     *  frame — typical SSE delivers ~30 token chunks per second and a naive
     *  re-render-per-chunk pattern causes layout thrash on long replies. */
    #scheduleRerender(msg: MessageBlock): void {
        if (this.#renderRafId) return;
        // The 50ms floor is deliberate: rAF alone would run at the display's
        // refresh rate (~60Hz) which is fine for visual smoothness, but
        // re-parsing markdown that often is wasteful. We coalesce to ~20fps.
        this.#renderRafId = requestAnimationFrame((ts: number) => {
            this.#renderRafId = null;
            const elapsed = ts - this.#renderRafTs;
            if (elapsed < 50) {
                // Re-schedule slightly later so we hit the 50ms cadence.
                this.#scheduleRerender(msg);
                return;
            }
            this.#renderRafTs = ts;
            this.#rerenderMessage(msg);
        });
    }

    // ── Scroll helpers ─────────────────────────────────────────────────────

    #isNearBottom(): boolean {
        const el = this.#messageList;
        if (!el) return true;
        return (el.scrollHeight - el.scrollTop - el.clientHeight) < 60;
    }

    #scrollToBottom(): void {
        if (!this.#messageList) return;
        this.#messageList.scrollTop = this.#messageList.scrollHeight;
    }

    // ── Sending / streaming ────────────────────────────────────────────────

    #autoGrowTextarea(): void {
        const ta = this.#textarea;
        if (!ta) return;
        ta.style.height = 'auto';
        // Cap at ~6 lines (line-height ≈ 20px + 16px padding).
        const max = 6 * 20 + 16;
        ta.style.height = Math.min(ta.scrollHeight, max) + 'px';
    }

    async #submit(): Promise<void> {
        if (!this.#textarea || !this.#messageList) return;
        const text = (this.#textarea.value || '').trim();
        if (!text || this.#streaming) return;
        // Snapshot mentions for this turn — only those whose `@<path>` token
        // still appears literally in the text the user is sending.
        this.#pruneMentions();
        const turnMentions = [...this.#mentions].filter((p) => text.includes(`@${p}`));
        // No current thread? Send anyway — the server creates one and tells
        // us its id back via the `thread_assigned` event. Optimistic UI: we
        // render the user's message and a placeholder assistant immediately.
        const userMsg: MessageBlock = {
            id: `local-u-${Date.now()}`,
            role: 'user',
            blocks: [{ type: 'text', text }],
            mentions: turnMentions,
        };
        const assistantMsg: MessageBlock = {
            id: `local-a-${Date.now()}`,
            role: 'assistant',
            blocks: [{ type: 'text', text: '' }],
            streaming: true,
        };
        const list = (this.#currentThreadId && this.#messagesByThread.get(this.#currentThreadId)) || [];
        list.push(userMsg, assistantMsg);
        if (this.#currentThreadId) this.#messagesByThread.set(this.#currentThreadId, list);
        else                       this.#messagesByThread.set('__pending__', list);

        // First send into a thread we haven't rendered yet wipes the empty
        // state and re-renders from scratch. Otherwise we just append.
        const empty = this.#messageList.querySelector('.markon-chat-empty');
        if (empty) this.#messageList.innerHTML = '';
        this.#messageList.appendChild(this.#renderMessageElement(userMsg));
        this.#messageList.appendChild(this.#renderMessageElement(assistantMsg));
        this.#stickToBottom = true;
        this.#scrollToBottom();

        this.#textarea.value = '';
        this.#autoGrowTextarea();
        this.#hideMentionPopup();
        // Selection consumed by this turn — drop the chip. The actual text was
        // already snapshotted into #pendingSelection and is read by #stream.
        if (this.#quoteChip && !this.#quoteChip.hidden) {
            if (this.#quoteChip) this.#quoteChip.hidden = true;
            if (this.#quoteText) this.#quoteText.textContent = '';
        }
        this.#pendingAssistant = assistantMsg;

        await this.#stream(text, assistantMsg, turnMentions);
        // Clear the live set once the request was accepted; the message
        // bubble already keeps a per-message snapshot of mentions for
        // post-render styling.
        this.#mentions.clear();
    }

    async #stream(userText: string, assistantMsg: MessageBlock, mentionPaths: string[] = []): Promise<void> {
        this.#setStreaming(true);
        this.#abortController = new AbortController();
        const focusedHeading = document.querySelector<HTMLElement>('.heading-focused');
        const currentDoc = Meta.get(CONFIG.META_TAGS.FILE_PATH) || null;
        const selection = (this.#pendingSelection || '').trim() || null;
        this.#pendingSelection = null;

        const payload = {
            thread_id: this.#currentThreadId,
            user_message: userText,
            selection,
            current_doc: currentDoc,
            mentions: mentionPaths.map((p) => ({ path: p })),
            heading: focusedHeading?.id || null,
        };

        try {
            const res = await fetch(`/api/chat/${encodeURIComponent(this.#workspaceId)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
                body: JSON.stringify(payload),
                signal: this.#abortController.signal,
            });
            if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
            await this.#consumeSSE(res.body, assistantMsg);
        } catch (err) {
            const e = err as { name?: string; message?: string };
            if (e?.name === 'AbortError') {
                assistantMsg.stopped = true;
            } else {
                Logger.error('Chat', 'stream failed', err);
                assistantMsg.error = e?.message || String(err);
            }
            this.#rerenderMessage(assistantMsg);
        } finally {
            assistantMsg.streaming = false;
            this.#setStreaming(false);
            this.#pendingAssistant = null;
            this.#abortController = null;
        }
    }

    /** Read a fetch ReadableStream byte-by-byte, parse SSE frames, and
     *  dispatch each event to #handleEvent. SSE frames are separated by
     *  blank lines; each frame may have a `data:` payload (we use that
     *  exclusively, since the contract is one JSON object per frame). */
    async #consumeSSE(stream: ReadableStream<Uint8Array>, assistantMsg: MessageBlock): Promise<void> {
        const reader: ReadableStreamDefaultReader<Uint8Array> = stream.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        // One stream = one decode buffer. We accumulate bytes, split on the
        // SSE record terminator (`\n\n`), and parse the data lines from each
        // record. Anything past the last terminator stays in the buffer for
        // the next chunk.
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buf.indexOf('\n\n')) !== -1) {
                const frame = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                const dataLines = frame.split('\n')
                    .filter((l) => l.startsWith('data:'))
                    .map((l) => l.slice(5).trimStart());
                if (dataLines.length === 0) continue;
                const json = dataLines.join('\n');
                try {
                    const event = JSON.parse(json) as ChatSSEEvent;
                    this.#handleEvent(event, assistantMsg);
                } catch {
                    Logger.warn('Chat', 'malformed SSE frame', json);
                }
            }
        }
    }

    #handleEvent(event: ChatSSEEvent, assistantMsg: MessageBlock): void {
        switch (event.type) {
        case 'thread_assigned': {
            const wasPending = !this.#currentThreadId;
            this.#currentThreadId = event.thread_id;
            localStorage.setItem(this.#lastThreadKey(), event.thread_id);
            // If we kept the pending list under '__pending__', migrate it.
            if (wasPending && this.#messagesByThread.has('__pending__')) {
                const pending = this.#messagesByThread.get('__pending__');
                if (pending) this.#messagesByThread.set(event.thread_id, pending);
                this.#messagesByThread.delete('__pending__');
            }
            // Prepend the new thread to the list so it shows up in the menu.
            if (!this.#threads.find((t) => t.id === event.thread_id)) {
                this.#threads.unshift({
                    id: event.thread_id,
                    title: event.title || '',
                    created_at: Date.now(),
                    updated_at: Date.now(),
                    message_count: 0,
                });
            }
            this.#updateTitle(event.title || '');
            this.#renderThreadMenu();
            break;
        }
        case 'text': {
            // Text streams into the last text block; if the assistant just
            // started a tool call, the next text chunk creates a new block.
            const last = assistantMsg.blocks[assistantMsg.blocks.length - 1];
            if (last && last.type === 'text') last.text += (event.delta || '');
            else assistantMsg.blocks.push({ type: 'text', text: event.delta || '' });
            this.#scheduleRerender(assistantMsg);
            break;
        }
        case 'tool_start': {
            assistantMsg.blocks.push({
                type: 'tool_use',
                id: event.id,
                name: event.name,
                input: event.input || {},
            });
            this.#rerenderMessage(assistantMsg);
            break;
        }
        case 'tool_end': {
            assistantMsg.blocks.push({
                type: 'tool_result',
                tool_use_id: event.id,
                content: event.output ?? '',
                is_error: !!event.is_error,
            });
            this.#rerenderMessage(assistantMsg);
            break;
        }
        case 'turn_end':
            // No-op for now — usage info is just metadata. A follow-up may
            // display token counts in the footer.
            break;
        case 'done':
            assistantMsg.streaming = false;
            this.#rerenderMessage(assistantMsg);
            break;
        case 'error':
            assistantMsg.error = event.message || 'unknown error';
            this.#rerenderMessage(assistantMsg);
            break;
        default:
            Logger.warn('Chat', 'unknown SSE event', event);
        }
    }

    #abort(): void {
        if (this.#abortController) this.#abortController.abort();
    }

    #setStreaming(on: boolean): void {
        this.#streaming = on;
        if (!this.#sendBtn) return;
        if (this.#sendIcon) this.#sendIcon.hidden = on;
        if (this.#stopIcon) this.#stopIcon.hidden = !on;
        this.#sendBtn.classList.toggle('streaming', on);
        this.#sendBtn.title = on
            ? this.#tt('web.chat.stop', 'Stop')
            : this.#tt('web.chat.send', 'Send');
    }

    #retryLast(): void {
        if (!this.#textarea || !this.#currentThreadId) return;
        const list = this.#messagesByThread.get(this.#currentThreadId) || [];
        // Find the most recent user message and re-send it.
        for (let i = list.length - 1; i >= 0; i--) {
            const m = list[i];
            if (!m) continue;
            if (m.role === 'user') {
                const textBlock = m.blocks.find((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text');
                const text = (textBlock?.text || '').trim();
                if (text) {
                    // Drop everything after this user msg (failed assistant attempt).
                    list.length = i + 1;
                    this.#messagesByThread.set(this.#currentThreadId, list);
                    this.#renderAllMessages();
                    this.#textarea.value = text;
                    void this.#submit();
                }
                return;
            }
        }
    }

    // ── Selection prefill ──────────────────────────────────────────────────

    /** Surface the quoted selection as a chip above the textarea. The chip is
     *  the *only* user-visible representation of the pending selection — the
     *  textarea body stays clean for the user's actual question, and the next
     *  #submit() picks the stored text up via `#pendingSelection`. */
    #prefillSelection(text?: string): void {
        if (!text) return;
        this.#pendingSelection = text;
        this.#showQuoteChip(text);
        if (this.#textarea) {
            this.#textarea.focus();
            this.#textarea.setSelectionRange(this.#textarea.value.length, this.#textarea.value.length);
        }
    }

    #showQuoteChip(text: string): void {
        if (!this.#quoteChip || !this.#quoteText) return;
        // Quote rendering: collapse internal whitespace + truncate to a single
        // line. The leading icon already signals "this is a quotation", so the
        // text itself stays plain — wrapping it in “…” would just compete with
        // the icon and clutter the chip when the selection itself contains
        // quote characters.
        this.#quoteText.textContent = text.replace(/\s+/g, ' ').trim();
        this.#quoteChip.hidden = false;
    }

    #hideQuoteChip(): void {
        this.#pendingSelection = null;
        if (this.#quoteChip) this.#quoteChip.hidden = true;
        if (this.#quoteText) this.#quoteText.textContent = '';
    }

    // ── Mention autocomplete ───────────────────────────────────────────────

    /** Re-evaluate caret context to decide whether to show/refresh the popup.
     *  Trigger: caret sits inside a token that begins with `@` and contains
     *  no whitespace. The token is the "query" that filters the file list. */
    #onTextareaInputForMentions(): void {
        const ta = this.#textarea;
        if (!ta) return;
        const pos = ta.selectionStart ?? 0;
        const value = ta.value || '';
        const ctx = extractMentionContext(value, pos);
        if (ctx) {
            this.#mentionAnchorPos = ctx.anchor;
            this.#queryMentions(ctx.token);
            return;
        }
        this.#hideMentionPopup();
    }

    #queryMentions(prefix: string): void {
        if (this.#mentionDebounceId) clearTimeout(this.#mentionDebounceId);
        this.#mentionDebounceId = setTimeout(async () => {
            this.#mentionDebounceId = null;
            // Cancel any in-flight previous request.
            if (this.#mentionAbortCtrl) this.#mentionAbortCtrl.abort();
            this.#mentionAbortCtrl = new AbortController();
            try {
                const url = `/api/chat/${encodeURIComponent(this.#workspaceId)}/files`
                    + `?q=${encodeURIComponent(prefix)}&limit=8`;
                const res = await fetch(url, { signal: this.#mentionAbortCtrl.signal });
                if (!res.ok) {
                    // Be quiet on backend hiccups so a 503 doesn't crash chat.
                    this.#hideMentionPopup();
                    return;
                }
                const rows = (await res.json()) as MentionRow[];
                this.#renderMentionPopup(Array.isArray(rows) ? rows : []);
            } catch (err) {
                const e = err as { name?: string };
                if (e?.name === 'AbortError') return;
                Logger.warn('Chat', 'mention query failed', err);
                this.#hideMentionPopup();
            }
        }, 120);
    }

    #ensureMentionPopup(): HTMLElement {
        if (this.#mentionPopup) return this.#mentionPopup;
        const el = document.createElement('div');
        el.className = 'markon-chat-mention-popup';
        el.setAttribute('role', 'listbox');
        el.hidden = true;
        document.body.appendChild(el);
        this.#mentionPopup = el;
        // Outside click closes the popup. Captured globally; attached lazily
        // so we don't bind a listener until the popup actually exists.
        this.#mentionOutsideHandler = (e: MouseEvent) => {
            if (!this.#mentionPopup || this.#mentionPopup.hidden) return;
            const target = e.target as Node | null;
            if (target === this.#textarea) return;
            if (target && this.#mentionPopup.contains(target)) return;
            this.#hideMentionPopup();
        };
        document.addEventListener('mousedown', this.#mentionOutsideHandler, true);
        return el;
    }

    #renderMentionPopup(rows: MentionRow[]): void {
        const popup = this.#ensureMentionPopup();
        this.#mentionRows = rows.slice(0, 8);
        if (this.#mentionRows.length === 0) { this.#hideMentionPopup(); return; }
        if (this.#mentionActiveIdx >= this.#mentionRows.length) this.#mentionActiveIdx = 0;
        if (this.#mentionActiveIdx < 0) this.#mentionActiveIdx = 0;
        popup.innerHTML = this.#mentionRows.map((r, i) => {
            const path = String(r.path || '');
            const slash = path.lastIndexOf('/');
            const name = slash >= 0 ? path.slice(slash + 1) : path;
            const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
            const active = i === this.#mentionActiveIdx ? ' is-active' : '';
            return `
                <div class="markon-chat-mention-row${active}" role="option" data-idx="${i}">
                    <span class="markon-chat-mention-name">${escapeHtml(name)}</span>
                    <span class="markon-chat-mention-dir">${escapeHtml(dir)}</span>
                </div>
            `;
        }).join('');
        popup.querySelectorAll<HTMLElement>('.markon-chat-mention-row').forEach((row) => {
            row.addEventListener('mousedown', (e: MouseEvent) => {
                // mousedown (not click) so the textarea blur doesn't fire first.
                e.preventDefault();
                const idx = Number(row.dataset.idx);
                this.#commitMentionAt(idx);
            });
        });
        this.#positionMentionPopup();
        popup.hidden = false;
    }

    #positionMentionPopup(): void {
        if (!this.#mentionPopup || !this.#textarea) return;
        // Anchor the popup just above the input group (chat input lives at the
        // bottom of the panel — opening upward avoids viewport overflow). We
        // size it to the input-group's bounding rect — not the textarea's —
        // so the popup's edges align with the visible rounded input frame
        // in both in-page and popout modes. position:fixed → use viewport
        // coordinates from getBoundingClientRect.
        const anchor = this.#textarea.closest<HTMLElement>('.markon-chat-input-group') ?? this.#textarea;
        const rect = anchor.getBoundingClientRect();
        const popup = this.#mentionPopup;
        // Render off-screen first to measure height with the final width.
        popup.style.width = `${rect.width}px`;
        popup.style.left = '-9999px';
        popup.style.top = '-9999px';
        popup.style.visibility = 'hidden';
        popup.hidden = false;
        const ph = popup.offsetHeight || 200;
        popup.style.visibility = '';
        const top = Math.max(8, rect.top - ph - 6);
        popup.style.left = `${rect.left}px`;
        popup.style.top = `${top}px`;
    }

    #moveMentionActive(delta: number): void {
        if (!this.#mentionRows || this.#mentionRows.length === 0) return;
        const n = this.#mentionRows.length;
        this.#mentionActiveIdx = ((this.#mentionActiveIdx + delta) % n + n) % n;
        if (!this.#mentionPopup) return;
        const rows = this.#mentionPopup.querySelectorAll<HTMLElement>('.markon-chat-mention-row');
        rows.forEach((r, i) => r.classList.toggle('is-active', i === this.#mentionActiveIdx));
        const active = rows[this.#mentionActiveIdx];
        if (active) active.scrollIntoView({ block: 'nearest' });
    }

    #commitMentionAt(idx: number): void {
        const row = this.#mentionRows[idx];
        if (!row) return;
        const path = String(row.path || '');
        if (!path) return;
        const ta = this.#textarea;
        if (!ta || this.#mentionAnchorPos < 0) return;
        const value = ta.value || '';
        // Replace from the `@` anchor up to the current caret with `@<path> `.
        const caret = ta.selectionStart ?? value.length;
        const before = value.slice(0, this.#mentionAnchorPos);
        const after = value.slice(caret);
        const insertion = `@${path} `;
        ta.value = before + insertion + after;
        const newCaret = before.length + insertion.length;
        ta.setSelectionRange(newCaret, newCaret);
        this.#mentions.add(path);
        this.#hideMentionPopup();
        this.#autoGrowTextarea();
        ta.focus();
    }

    #hideMentionPopup(): void {
        if (this.#mentionPopup) this.#mentionPopup.hidden = true;
        this.#mentionRows = [];
        this.#mentionActiveIdx = 0;
        this.#mentionAnchorPos = -1;
        if (this.#mentionAbortCtrl) { this.#mentionAbortCtrl.abort(); this.#mentionAbortCtrl = null; }
        if (this.#mentionDebounceId) { clearTimeout(this.#mentionDebounceId); this.#mentionDebounceId = null; }
    }

    /** Drop entries from `#mentions` whose `@<path>` no longer appears in
     *  the textarea — keeps the set tight as the user edits/deletes. */
    #pruneMentions(): void {
        if (this.#mentions.size === 0) return;
        const value = this.#textarea?.value || '';
        for (const p of [...this.#mentions]) {
            if (!value.includes(`@${p}`)) this.#mentions.delete(p);
        }
    }

    /** Wrap any `@<path>` substring whose path is in `mentions` with a styled
     *  pill. We walk text nodes (not innerHTML) so we don't disturb already
     *  rendered markup like `<a>`s and `<code>`s. */
    #decorateMentions(rootEl: HTMLElement, mentions: string[]): void {
        if (!rootEl || !mentions || mentions.length === 0) return;
        // Sort by length desc so longer paths win when one is a prefix of another.
        const sorted = [...mentions].sort((a, b) => b.length - a.length);
        const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`@(${sorted.map(escapeRe).join('|')})`, 'g');
        const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
        const targets: Text[] = [];
        let n: Node | null;
        while ((n = walker.nextNode())) {
            // Skip text inside <code> / <pre> — preserves verbatim.
            const parent = (n as Text).parentElement;
            if (parent && parent.closest('code, pre')) continue;
            if (re.test((n as Text).nodeValue ?? '')) {
                re.lastIndex = 0;
                targets.push(n as Text);
            }
        }
        for (const node of targets) {
            const text = node.nodeValue ?? '';
            const frag = document.createDocumentFragment();
            let last = 0;
            re.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = re.exec(text)) !== null) {
                if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
                const path = m[1] ?? '';
                const slash = path.lastIndexOf('/');
                const name = slash >= 0 ? path.slice(slash + 1) : path;
                const pill = document.createElement('span');
                pill.className = 'markon-chat-mention-pill';
                pill.setAttribute('data-path', path);
                pill.title = path;
                pill.textContent = `@${name}`;
                frag.appendChild(pill);
                last = m.index + m[0].length;
            }
            if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
            node.parentNode?.replaceChild(frag, node);
        }
    }

    // ── Citation pills ────────────────────────────────────────────────────

    /** Walk all `<code>` elements inside `rootEl` and replace any whose text
     *  matches a citation pattern with a clickable `<a class="markon-chat-citation">`.
     *  Skips `<pre><code>` — we only want inline code citations, not real
     *  code blocks. */
    #decorateCitations(rootEl: HTMLElement): void {
        if (!rootEl) return;
        const codes = rootEl.querySelectorAll<HTMLElement>('code');
        for (const code of codes) {
            // Skip block code (inside <pre>): those are real source listings.
            if (code.parentElement && code.parentElement.tagName === 'PRE') continue;
            const text = (code.textContent || '').trim();
            if (!text) continue;
            const cite = parseCitation(text);
            if (!cite) continue;
            const a = document.createElement('a');
            a.className = 'markon-chat-citation';
            a.setAttribute('data-path', cite.path);
            if (cite.line)     a.setAttribute('data-line', String(cite.line));
            if (cite.lineEnd)  a.setAttribute('data-line-end', String(cite.lineEnd));
            if (cite.anchor)   a.setAttribute('data-anchor', cite.anchor);
            a.href = this.#citationHref(cite);
            a.textContent = text;
            a.title = text;
            a.addEventListener('click', (e: MouseEvent) => this.#onCitationClick(e, cite));
            code.replaceWith(a);
        }
    }

    #citationHref(cite: Citation): string {
        const ws = encodeURIComponent(this.#workspaceId);
        // Path components must be encoded segment-by-segment so slashes survive.
        const path = cite.path.split('/').map(encodeURIComponent).join('/');
        let url = `/${ws}/${path}`;
        if (cite.anchor)    url += `#${cite.anchor}`;
        else if (cite.line) url += `#L${cite.line}`;
        return url;
    }

    #onCitationClick(e: MouseEvent, cite: Citation): void {
        e.preventDefault();
        const url = this.#citationHref(cite);
        if (e.metaKey || e.ctrlKey) {
            window.open(url, '_blank', 'noopener,noreferrer');
        } else {
            window.location.href = url;
        }
    }

    // ── Misc helpers ───────────────────────────────────────────────────────

    #lastThreadKey(): string {
        return `markon-chat-last-thread-${this.#workspaceId}`;
    }

    /** i18n lookup with a default fallback. The global i18n table doesn't
     *  yet contain chat keys; using a default here lets us ship now and
     *  populate translations later without any code changes. */
    #tt(key: string, fallback: string): string {
        const v = this.#i18n(key);
        return (!v || v === key) ? fallback : v;
    }

    // ── Test seams (tree-shaken in production builds when unused) ─────────
    //
    // ES2022 `#field` privacy is a runtime barrier: tests cannot reach it via
    // bracket access, and we don't want to soften the privacy by switching to
    // `private` keyword (which is a TS-only check). Instead we expose a tiny
    // typed shim that delegates to the private methods. The shim has no
    // runtime cost when callers don't use it, and it keeps the test file from
    // having to monkey-patch Symbol slots.

    /** @internal — test-only: drive the SSE event handler directly. */
    _testHandleEvent(event: ChatSSEEvent, assistantMsg: MessageBlock): void {
        this.#handleEvent(event, assistantMsg);
    }

    /** @internal — test-only: feed a ReadableStream through the SSE parser. */
    _testConsumeSSE(stream: ReadableStream<Uint8Array>, msg: MessageBlock): Promise<void> {
        return this.#consumeSSE(stream, msg);
    }

    /** @internal — test-only: read internal `#messagesByThread`. */
    get _testMessagesByThread(): Map<string, MessageBlock[]> {
        return this.#messagesByThread;
    }

    /** @internal — test-only: read/write the current thread id. */
    get _testCurrentThreadId(): string | null {
        return this.#currentThreadId;
    }

    /** @internal — test-only: read the threads list. */
    get _testThreads(): ChatThread[] {
        return this.#threads;
    }
}
