/**
 * Keyboard shortcuts for the compare / diff page.
 *
 * The diff page does NOT boot MarkonApp, so it wires its own
 * {@link KeyboardShortcutsManager}: the GLOBAL shortcuts every page shares
 * (Help `?`, Theme `t`) plus the diff-specific ones (toggle Raw⇄Rendered,
 * next/previous change). Because the help panel renders from the manager's live
 * registered set, pressing `?` here shows exactly this page's shortcuts.
 */

import { CONFIG } from './core/config';
import { Logger } from './core/utils';
import { ChatManager } from './managers/chat-manager';
import { CollaborationManager } from './managers/collaboration-manager';
import { KeyboardShortcutsManager } from './managers/keyboard-shortcuts';
import { WebSocketManager } from './managers/websocket-manager';
import { Meta } from './services/dom';

const currentView = (shell: HTMLElement): 'rendered' | 'raw' =>
    shell.getAttribute('data-current-diff-view') === 'rendered' ? 'rendered' : 'raw';

/** Switch Raw⇄Rendered by clicking the other segment button (reusing all of the
 *  page's existing view-activation + preference-persistence logic). */
const toggleView = (shell: HTMLElement): void => {
    const next = currentView(shell) === 'rendered' ? 'raw' : 'rendered';
    document.querySelector<HTMLElement>(`[data-diff-view-seg] [data-view="${next}"]`)?.click();
};

// ── Step through individual changed blocks (BOTH views) ─────────────────────
// Both views mark their changed-block wrappers with the shared `diff-change-block`
// class and their scroll container with `data-diff-scroller`, so this one stepper
// works for Raw and Rendered alike — only the surface DOM differs, not the logic.
const CHANGE_SELECTOR =
    '.diff-change-block.is-modified, .diff-change-block.is-added, .diff-change-block.is-deleted';

const workspaceRouteKey = (): string =>
    `${window.location.pathname}${window.location.search}`;

const initWorkspaceSurfaces = async (): Promise<CollaborationManager | null> => {
    const enableLive = Meta.flag(CONFIG.META_TAGS.ENABLE_LIVE);
    let collaboration: CollaborationManager | null = null;

    if (enableLive) {
        const workspaceId = Meta.get(CONFIG.META_TAGS.WORKSPACE_ID);
        if (!workspaceId) {
            Logger.warn('DiffShortcuts', 'Collaboration enabled without workspace-id; skipping');
            return null;
        }
        const ws = new WebSocketManager(workspaceId, {
            kind: 'surface',
            key: workspaceRouteKey(),
        });
        try {
            await ws.connect();
            const socket = ws.getWebSocket();
            if (socket) window.ws = socket;
            collaboration = new CollaborationManager({ enableLive, ws });
            collaboration.init();
        } catch (error) {
            Logger.warn('DiffShortcuts', 'Workspace live socket unavailable:', error);
        }
    }

    if (Meta.flag(CONFIG.META_TAGS.ENABLE_CHAT)) {
        const chat = new ChatManager(null);
        chat.init();
        window.chatManager = chat;
    }

    return collaboration;
};

/** The active view panel and the element that actually scrolls inside it. */
const activeScroller = (shell: HTMLElement): { panel: HTMLElement; scroller: HTMLElement } | null => {
    const view = currentView(shell);
    const panel = document.querySelector<HTMLElement>(`[data-diff-view-panel="${view}"]`);
    if (!panel || panel.hidden) return null;
    const scroller = panel.matches('[data-diff-scroller]')
        ? panel
        : panel.querySelector<HTMLElement>('[data-diff-scroller]') || panel;
    return { panel, scroller };
};

/** Move focus to the next/previous changed block in the active view, scroll it
 *  under the sticky header, and mark it `.is-focused` (a left accent rail). Only
 *  visible blocks count, so viewed-hidden sections are skipped. */
const stepBlock = (shell: HTMLElement, dir: 1 | -1): void => {
    const ctx = activeScroller(shell);
    if (!ctx) return;
    const { panel, scroller } = ctx;
    const blocks = [...panel.querySelectorAll<HTMLElement>(CHANGE_SELECTOR)].filter(
        (b) => b.offsetParent !== null,
    );
    if (!blocks.length) return;

    const index = blocks.findIndex((b) => b.classList.contains('is-focused'));
    let next: HTMLElement | undefined;
    if (index >= 0) {
        next = blocks[index + dir];
    } else {
        // No current focus: pick the first change just past the sticky header
        // (going down) or just above it (going up).
        const line = scroller.getBoundingClientRect().top + 56;
        if (dir > 0) {
            next = blocks.find((b) => b.getBoundingClientRect().top > line + 4) || blocks[0];
        } else {
            const above = blocks.filter((b) => b.getBoundingClientRect().top < line - 4);
            next = above[above.length - 1] || blocks[blocks.length - 1];
        }
    }
    if (!next) {
        // Boundary of the currently-rendered range — nudge the scroll so the
        // next section virtualizes in; the following press continues from there.
        scroller.scrollBy({ top: dir * scroller.clientHeight * 0.85, behavior: 'smooth' });
        return;
    }
    blocks.forEach((b) => b.classList.remove('is-focused'));
    next.classList.add('is-focused');
    const header = next.closest('.md-diff-file-section')?.querySelector<HTMLElement>('.md-diff-file-header');
    const offset = (header?.offsetHeight || 44) + 10;
    const y = next.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset + scroller.scrollTop;
    scroller.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
};

const init = async (): Promise<void> => {
    const shell = document.querySelector<HTMLElement>('[data-diff-shell]');
    if (!shell) return;
    const collaboration = await initWorkspaceSurfaces();

    const km = new KeyboardShortcutsManager();

    // Click-to-focus: clicking (or interacting) inside a changed block makes it
    // the focused block, so the rail follows clicks — not just j/k. Selecting a
    // file in the sidebar clears the now-stale focus.
    const clearFocus = (): void =>
        document.querySelectorAll<HTMLElement>('.diff-change-block.is-focused')
            .forEach((b) => b.classList.remove('is-focused'));

    // Global (every page).
    km.register('HELP', () => km.showHelp());
    km.register('THEME_PANEL', () => window.MarkonTheme?.togglePanel());
    // Escape: dismiss the help overlay if open, else drop the focused-block rail.
    km.register('ESCAPE', () => {
        const panel = document.querySelector<HTMLElement>('.shortcuts-help-panel');
        if (panel) {
            panel.classList.remove('visible');
            setTimeout(() => panel.remove(), 200);
            return;
        }
        clearFocus();
    });
    // Diff-specific. n/p step through individual changed blocks in BOTH views
    // (the same stepper; only the underlying DOM differs).
    km.register('DIFF_TOGGLE_VIEW', () => toggleView(shell));
    km.register('DIFF_NEXT_FILE', () => stepBlock(shell, 1));
    km.register('DIFF_PREV_FILE', () => stepBlock(shell, -1));
    if (Meta.flag(CONFIG.META_TAGS.ENABLE_LIVE) && collaboration) {
        km.register('TOGGLE_LIVE_ACTIVE', () => collaboration.toggleActiveMode());
        km.register('TOGGLE_LIVE_OFF', () => collaboration.toggleOff());
    }
    if (Meta.flag(CONFIG.META_TAGS.ENABLE_CHAT)) {
        km.register('TOGGLE_CHAT', () => window.chatManager?.openInDefault());
        km.register('TOGGLE_CHAT_ALT', () => window.chatManager?.openInDefault({ invert: true }));
    }

    document.addEventListener('keydown', (e) => km.handle(e));
    document.addEventListener('click', (e) => {
        const target = e.target as Element | null;
        if (!target) return;
        if (target.closest('[data-diff-scroll-path]')) { clearFocus(); return; }
        const block = target.closest<HTMLElement>(CHANGE_SELECTOR);
        if (!block) return;
        const ctx = activeScroller(shell);
        if (!ctx?.panel.contains(block)) return;
        ctx.panel.querySelectorAll<HTMLElement>('.diff-change-block.is-focused')
            .forEach((b) => b.classList.remove('is-focused'));
        block.classList.add('is-focused');
    });

    window.shortcutsManager = km;
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { void init(); }, { once: true });
} else {
    void init();
}
