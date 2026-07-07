/**
 * CollaborationManager — Markon Live: collaborative reading layer.
 *
 * Three mutually-exclusive modes; identity is purely the user-picked color
 * (no hostnames or names anywhere).
 *
 *   off       — no broadcast, no follow.
 *   broadcast — emit `live_action` frames for focus/selection/viewed.
 *   follow    — apply remote `live_action` frames to mirror the speaker.
 *
 * Owns the small floating sphere UI in the bottom-right corner. The sphere
 * itself is a {@link FloatingLayer} — drag, morph, and collision avoidance
 * live in that component, not here.
 */

import { CONFIG, i18n } from '../core/config';
import { Identity } from '../core/identity';
import { Ids, Logger } from '../core/utils';
import { Meta } from '../services/dom';
import { Position } from '../services/position';
import { XPath } from '../services/xpath';
import { FloatingLayer } from '../components/floating-layer';
import type { WebSocketManager } from './websocket-manager';

const _t = (key: string, ...args: unknown[]): string => i18n.t(key, ...args);

// ── Mode constants ─────────────────────────────────────────────────────────

/** Three mutually-exclusive states. */
export const LiveMode = Object.freeze({
    OFF: 'off',
    BROADCAST: 'broadcast',
    FOLLOW: 'follow',
} as const);

export type LiveModeValue = (typeof LiveMode)[keyof typeof LiveMode];

const ACTIVE_MODES: readonly LiveModeValue[] = [LiveMode.BROADCAST, LiveMode.FOLLOW];
const MODE_ORDER: readonly LiveModeValue[] = [LiveMode.OFF, ...ACTIVE_MODES];

const ICON_IDENTITY = `
<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="8" r="3.2"/>
    <path d="M5.5 19a6.6 6.6 0 0 1 13 0"/>
</svg>`;

const ICON_LIVE = `
<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/>
    <path d="M8.5 15.5a5 5 0 0 1 0-7"/>
    <path d="M15.5 8.5a5 5 0 0 1 0 7"/>
    <path d="M5.5 18.5a9.2 9.2 0 0 1 0-13"/>
    <path d="M18.5 5.5a9.2 9.2 0 0 1 0 13"/>
</svg>`;

// ── Live payload discriminated union ───────────────────────────────────────
//
// Three concrete `action` shapes are sent/received over `live_action`. The
// server is a dumb relay — what we send is exactly what followers see.
// Every variant carries `clientId` (origin filter on the receiver) and
// `color` (the speaker's identity); both are stamped by `broadcastAction`.

/** Section-focus broadcast. Sent on j/k navigation and section clicks. */
export interface LiveFocusAction {
    action: 'focus_section';
    clientId: string;
    color: string;
    workspaceId?: string;
    route?: string;
    xpath: string;
}

/** Text-selection broadcast. `cleared` collapses the follower's selection. */
export interface LiveSelectionAction {
    action: 'selection';
    clientId: string;
    color: string;
    workspaceId?: string;
    route?: string;
    cleared?: boolean;
    startPath?: string;
    startOffset?: number;
    endPath?: string;
    endOffset?: number;
}

/** Viewed-checkbox toggle broadcast. */
export interface LiveViewedAction {
    action: 'viewed';
    clientId: string;
    color: string;
    workspaceId?: string;
    route?: string;
    headingId: string;
    checked: boolean;
}

/** Workspace-route broadcast. Sent when a broadcaster enters a page. */
export interface LiveNavigationAction {
    action: 'navigate';
    clientId: string;
    color: string;
    workspaceId?: string;
    route: string;
}

/** Viewport broadcast. Applies to window scrolling and diff-page scroll panes. */
export interface LiveViewportAction {
    action: 'viewport';
    clientId: string;
    color: string;
    workspaceId?: string;
    route?: string;
    scrollX: number;
    scrollY: number;
}

export type LiveAction =
    | LiveFocusAction
    | LiveSelectionAction
    | LiveViewedAction
    | LiveNavigationAction
    | LiveViewportAction;

// ── App surface ────────────────────────────────────────────────────────────

/** Subset of the host MarkonApp that this manager touches. */
export interface CollaborationApp {
    enableLive?: boolean;
    ws?: WebSocketManager | null;
}

// ── Manager ────────────────────────────────────────────────────────────────

/**
 * Live-collaboration manager. Bound to the application's WebSocket and to
 * the rendered article body; reads `enable-live` meta + various
 * localStorage keys to restore prior state.
 */
export class CollaborationManager {
    app: CollaborationApp;
    clientId: string;
    userColor: string;
    workspaceId: string;
    /** Whether Live broadcast/follow is enabled. When false the sphere still
     *  appears (for shared-annotation identity) but the Live mode section is
     *  hidden. */
    liveEnabled = false;
    mode: LiveModeValue;
    activeLeader: LiveAction | null;
    leaderTimer: ReturnType<typeof setTimeout> | null;

    container: HTMLElement | null;
    sphere: HTMLElement | null;
    panel: HTMLElement | null;
    layer: FloatingLayer | null;

    // Internal flags retained as `_field` to mirror the original .js.
    _lastActiveMode?: LiveModeValue;
    _applyingRemote?: boolean;
    _lastFocusXPath?: string;
    _lastSelectionKey?: string | null;
    _lastViewportKey?: string | null;
    // Retained so a future destroy() / reinit cycle can detach without
    // leaking accumulated observers on every call to _observeFocusedSection.
    _focusObserver?: MutationObserver;

    constructor(app: CollaborationApp) {
        this.app = app;
        this.clientId = this._getOrCreateClientId();
        this.workspaceId = Meta.get(CONFIG.META_TAGS.WORKSPACE_ID) || '';
        // Single identity colour source (auto-assigns + persists on first use);
        // shared with annotation authorship.
        this.userColor = Identity.color();
        this.mode = this._loadSavedMode();
        this.activeLeader = null;
        this.leaderTimer = null;

        this.container = null;
        this.sphere = null;
        this.panel = null;
        this.layer = null;
    }

    get isBroadcasting(): boolean { return this.mode === LiveMode.BROADCAST; }
    get isFollowing(): boolean    { return this.mode === LiveMode.FOLLOW; }

    init(): void {
        this.liveEnabled = this.app.enableLive ?? Meta.flag(CONFIG.META_TAGS.ENABLE_LIVE);
        const sharedEnabled = Meta.flag(CONFIG.META_TAGS.SHARED_ANNOTATION);
        // The sphere is the collaboration identity surface: show it whenever the
        // workspace is shared in any way (annotation identity needs a home even
        // without Live). The Live mode section inside is gated on liveEnabled.
        if (!this.liveEnabled && !sharedEnabled) return;
        if (!this.app.ws) {
            Logger.warn('Collab', 'shared/live is on but WebSocket is unavailable');
            return;
        }

        this._createUI();
        this._setupFloatingLayer();
        this._setupEventListeners();
        // Sync UI to the loaded mode / color — the template's initial
        // attributes are hard-coded placeholders and need to reflect the
        // real state (e.g. aria-disabled on the color row, active classes,
        // --markon-live-user custom property).
        this._updateUIState();

        this.app.ws.on('live_action', (msg) => {
            // The wire-level type for `data` is broad (string action); we
            // narrow into our discriminated union via the runtime checks
            // inside `handleLiveAction`.
            this.handleLiveAction(msg.data as unknown as LiveAction);
        });

        if (this.isBroadcasting) {
            this._broadcastNavigation();
            this._broadcastViewport();
        }

        Logger.log('Live', `Initialized (clientId=${this.clientId}, mode=${this.mode})`);
    }

    /** `L` shortcut. Off → Follow; Follow → Broadcast; Broadcast → Follow.
     *  Off is only entered via `Shift+L`, never via this toggle. */
    toggleActiveMode(): void {
        if (this.mode === LiveMode.FOLLOW) this.setMode(LiveMode.BROADCAST);
        else                                this.setMode(LiveMode.FOLLOW);
    }

    /** `Shift+L` shortcut. Toggles Off ⇄ last active mode. Coming back
     *  from Off restores whatever mode was active before (Broadcast or
     *  Follow), falling back to Follow if there's no history. */
    toggleOff(): void {
        if (this.mode === LiveMode.OFF) {
            this.setMode(this._lastActiveMode || LiveMode.FOLLOW);
        } else {
            this._lastActiveMode = this.mode;
            this.setMode(LiveMode.OFF);
        }
    }

    setMode(mode: LiveModeValue): void {
        if (!MODE_ORDER.includes(mode) || mode === this.mode) return;
        if (ACTIVE_MODES.includes(mode)) this._lastActiveMode = mode;
        this.mode = mode;
        localStorage.setItem(CONFIG.STORAGE_KEYS.LIVE_MODE, mode);
        this._updateUIState();
        if (mode === LiveMode.BROADCAST) {
            this._broadcastNavigation();
            this._broadcastViewport();
        }
    }

    _loadSavedMode(): LiveModeValue {
        const saved = localStorage.getItem(CONFIG.STORAGE_KEYS.LIVE_MODE);
        return (MODE_ORDER as readonly string[]).includes(saved ?? '')
            ? (saved as LiveModeValue)
            : LiveMode.OFF;
    }

    handleLiveAction(data: LiveAction): void {
        if (data.clientId === this.clientId) return;
        if (!this.isFollowing) return;
        if (!this._sameWorkspace(data.workspaceId)) return;

        if (data.action === 'navigate') {
            this._applyNavigation(data);
            return;
        }

        if (data.route && !this._isCurrentRoute(data.route)) {
            const nav: LiveNavigationAction = {
                action: 'navigate',
                clientId: data.clientId,
                color: data.color,
                route: data.route,
            };
            if (data.workspaceId) nav.workspaceId = data.workspaceId;
            this._applyNavigation(nav);
            return;
        }

        if (data.action !== 'viewport') {
            this.activeLeader = data;
            this._updateUIState();

            if (this.leaderTimer) clearTimeout(this.leaderTimer);
            this.leaderTimer = setTimeout(() => {
                this.activeLeader = null;
                this._updateUIState();
            }, 3000);
        }

        if (data.action === 'focus_section') {
            this._applyFocusSection(data.xpath, data.color);
        } else if (data.action === 'selection') {
            if (data.cleared) {
                window.getSelection()?.removeAllRanges();
            } else {
                this._applySelection(data);
            }
        } else if (data.action === 'viewed') {
            this._applyViewed(data);
        } else if (data.action === 'viewport') {
            this._applyViewport(data);
        }
    }

    _sameWorkspace(workspaceId: string | undefined): boolean {
        return !workspaceId || !this.workspaceId || workspaceId === this.workspaceId;
    }

    _currentRoute(): string {
        return `${window.location.pathname}${window.location.search}${window.location.hash}`;
    }

    _resolveWorkspaceRoute(route: string): URL | null {
        let url: URL;
        try {
            url = new URL(route, window.location.origin);
        } catch {
            return null;
        }
        if (url.origin !== window.location.origin) return null;
        if (!this.workspaceId) return url;
        const wsRoot = `/${this.workspaceId}`;
        const internalRoot = `/_/${this.workspaceId}`;
        const path = url.pathname;
        if (
            path !== wsRoot &&
            !path.startsWith(`${wsRoot}/`) &&
            path !== internalRoot &&
            !path.startsWith(`${internalRoot}/`)
        ) return null;
        return url;
    }

    _isCurrentRoute(route: string): boolean {
        const url = this._resolveWorkspaceRoute(route);
        if (!url) return true;
        return `${url.pathname}${url.search}${url.hash}` === this._currentRoute();
    }

    _applyNavigation(data: LiveNavigationAction): void {
        const url = this._resolveWorkspaceRoute(data.route);
        if (!url) return;
        const target = `${url.pathname}${url.search}${url.hash}`;
        if (target === this._currentRoute()) return;
        window.location.assign(target);
    }

    _currentScrollTarget(): Window | HTMLElement {
        const diffScroller = document.querySelector<HTMLElement>(
            '[data-diff-view-panel]:not([hidden])[data-diff-scroller], ' +
            '[data-diff-view-panel]:not([hidden]) [data-diff-scroller]',
        );
        return diffScroller || window;
    }

    _readViewport(): { scrollX: number; scrollY: number } {
        const target = this._currentScrollTarget();
        if (target === window) {
            return { scrollX: window.scrollX, scrollY: window.scrollY };
        }
        const el = target as HTMLElement;
        return { scrollX: el.scrollLeft, scrollY: el.scrollTop };
    }

    _applyViewport(data: LiveViewportAction): void {
        const target = this._currentScrollTarget();
        this._applyingRemote = true;
        try {
            if (target === window) {
                window.scrollTo({ left: data.scrollX, top: data.scrollY, behavior: 'smooth' });
            } else {
                target.scrollTo({ left: data.scrollX, top: data.scrollY, behavior: 'smooth' });
            }
        } finally {
            setTimeout(() => { this._applyingRemote = false; }, 250);
        }
    }

    _applyViewed(data: LiveViewedAction): void {
        if (!data.headingId) return;
        const cb = document.querySelector<HTMLInputElement>(
            `.viewed-checkbox[data-heading-id="${CSS.escape(data.headingId)}"]`,
        );
        if (!cb) return;
        const next = !!data.checked;
        if (cb.checked === next) return;
        this._applyingRemote = true;
        try {
            // Route through the native change event so viewed.js runs its
            // usual collapse/expand + localStorage-persist logic on the
            // follower — we don't reimplement any of it.
            cb.checked = next;
            cb.dispatchEvent(new Event('change', { bubbles: true }));
        } finally {
            setTimeout(() => { this._applyingRemote = false; }, 250);
        }
    }

    _applyFocusSection(xpath: string, speakerColor: string | undefined): void {
        const el = XPath.resolve(xpath) as HTMLElement | null;
        if (!el) return;
        this._applyingRemote = true;
        try {
            // Mirror the local j/k navigation exactly: same focus class, same
            // smart-scroll positioning, same TOC selected-state sync. The
            // only "I'm a follower" cue is the breathing pulse below.
            document.querySelectorAll('.heading-focused').forEach((e) =>
                e.classList.remove('heading-focused'),
            );
            el.classList.add('heading-focused');
            Position.smartScrollToHeading(el);
            if (el.id && window.__markonTocSetSelected) {
                window.__markonTocSetSelected(el.id);
            }

            // Breathing pulse starts in the speaker's color and fades to the
            // steady focus border color supplied by the base stylesheet.
            const section =
                (el.closest<HTMLElement>('.heading-section')) ?? el;
            if (speakerColor) {
                section.style.setProperty('--live-pulse-color', speakerColor);
            }
            section.classList.remove('markon-live-focus-pulse');
            void section.offsetWidth;
            section.classList.add('markon-live-focus-pulse');
            setTimeout(() => {
                section.classList.remove('markon-live-focus-pulse');
                section.style.removeProperty('--live-pulse-color');
            }, 1500);
        } finally {
            setTimeout(() => { this._applyingRemote = false; }, 250);
        }
    }

    _applySelection(data: LiveSelectionAction): void {
        if (
            data.startPath === undefined ||
            data.endPath === undefined ||
            data.startOffset === undefined ||
            data.endOffset === undefined
        ) return;

        const startEl = XPath.resolve(data.startPath);
        const endEl = XPath.resolve(data.endPath);
        if (!startEl || !endEl) return;
        const start = XPath.findNode(startEl, data.startOffset);
        const end = XPath.findNode(endEl, data.endOffset);
        if (!start.node || !end.node) return;
        const range = document.createRange();
        try {
            range.setStart(start.node, start.offset);
            range.setEnd(end.node, end.offset);
        } catch {
            return;
        }
        this._applyingRemote = true;
        try {
            // Rendering = native browser selection. No custom color, no
            // overlay element — we just hand the range to the platform so
            // the highlight looks like any text the user picked themselves.
            const sel = window.getSelection();
            if (sel) {
                sel.removeAllRanges();
                sel.addRange(range);
            }
            // The only "remote" signal is this data attribute, checked by
            // PopoverManager to skip the annotation toolbar on the follower.
            document.body.dataset['markonLiveRemote'] = '1';

            // If the remote selection is entirely outside the viewport,
            // scroll the follower so it's visible. Partial overlap is left
            // alone — the user can already see some of it.
            const rect = range.getBoundingClientRect();
            const vh = window.innerHeight;
            const vw = window.innerWidth;
            const visible = rect.bottom > 0 && rect.top < vh
                         && rect.right > 0 && rect.left < vw;
            if (!visible && rect.width + rect.height > 0) {
                const targetY = window.scrollY + rect.top - vh * 0.3;
                window.scrollTo({ top: targetY, behavior: 'smooth' });
            }
        } finally {
            setTimeout(() => { this._applyingRemote = false; }, 250);
        }
    }

    broadcastAction(action: string, extraData: Record<string, unknown> = {}): void {
        if (!this.isBroadcasting || !this.app.ws) return;
        void this.app.ws.send({
            type: 'live_action',
            data: {
                clientId: this.clientId,
                color: this.userColor, // identity is purely the speaker's color
                workspaceId: this.workspaceId,
                route: this._currentRoute(),
                action,
                ...extraData,
            },
        });
    }

    _broadcastNavigation(): void {
        this.broadcastAction('navigate', { route: this._currentRoute() });
    }

    _broadcastViewport(): void {
        const { scrollX, scrollY } = this._readViewport();
        const key = `${this._currentRoute()}|${Math.round(scrollX)}|${Math.round(scrollY)}`;
        if (key === this._lastViewportKey) return;
        this._lastViewportKey = key;
        this.broadcastAction('viewport', { scrollX, scrollY });
    }

    // Watch for the reader changing the active section (via click or j/k
    // navigation) and broadcast the new section's xpath. This is the primary
    // "where is the speaker" signal — scroll position itself is irrelevant.
    _observeFocusedSection(): void {
        const article = document.querySelector('article.markdown-body');
        if (!article) return;
        // Detach any prior observer before installing a new one — calling
        // init() twice (test reload, mode toggle) would otherwise pile up
        // observers that all fire on every class mutation.
        this._focusObserver?.disconnect();
        this._focusObserver = new MutationObserver(() => {
            if (this._applyingRemote) return;
            const focused = article.querySelector('.heading-focused');
            if (!focused) return;
            const xpath = XPath.create(focused);
            if (xpath === this._lastFocusXPath) return;
            this._lastFocusXPath = xpath;
            this.broadcastAction('focus_section', { xpath });
        });
        this._focusObserver.observe(article, {
            subtree: true,
            attributes: true,
            attributeFilter: ['class'],
        });
    }

    // Broadcast the current text selection (range inside the article) so
    // remote peers can mirror what the speaker is pointing at. Debounced to
    // avoid flooding mid-drag.
    _observeSelection(): void {
        const article = document.querySelector('article.markdown-body');
        if (!article) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        document.addEventListener('selectionchange', () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => this._broadcastSelection(article), 120);
        });
    }

    // Watch user-initiated Viewed-checkbox toggles and broadcast them. The
    // native `change` event only fires on real user interaction, so
    // programmatic `.checked = X` from viewed.js's own batch updates
    // (updateCheckboxes / mark-all, etc.) won't echo back through here.
    _observeViewed(): void {
        document.addEventListener('change', (e) => {
            if (this._applyingRemote) return;
            const cb = e.target as HTMLInputElement | null;
            if (!cb?.classList?.contains('viewed-checkbox')) return;
            const id = cb.dataset?.['headingId'];
            if (!id) return;
            this.broadcastAction('viewed', { headingId: id, checked: cb.checked });
        });
    }

    _observeViewport(): void {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const schedule = (): void => {
            if (this._applyingRemote) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => this._broadcastViewport(), 140);
        };
        window.addEventListener('scroll', schedule, { passive: true });
        document.querySelectorAll<HTMLElement>('[data-diff-scroller]').forEach((scroller) => {
            scroller.addEventListener('scroll', schedule, { passive: true });
        });
        window.addEventListener('hashchange', () => {
            if (this.isBroadcasting) this._broadcastNavigation();
        });
    }

    _broadcastSelection(article: Element): void {
        if (this._applyingRemote) return;
        if (!this.isBroadcasting || !this.app.ws) return;
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
            if (this._lastSelectionKey) {
                this._lastSelectionKey = null;
                this.broadcastAction('selection', { cleared: true });
            }
            return;
        }
        const range = sel.getRangeAt(0);
        if (!article.contains(range.commonAncestorContainer)) return;
        const startParent: Node | null =
            range.startContainer.nodeType === 3
                ? (range.startContainer.parentElement)
                : range.startContainer;
        const endParent: Node | null =
            range.endContainer.nodeType === 3
                ? (range.endContainer.parentElement)
                : range.endContainer;
        if (!startParent || !endParent) return;
        const payload = {
            startPath: XPath.create(startParent),
            startOffset: XPath.getAbsoluteOffset(range.startContainer, range.startOffset),
            endPath: XPath.create(endParent),
            endOffset: XPath.getAbsoluteOffset(range.endContainer, range.endOffset),
        };
        const key =
            `${payload.startPath}|${payload.startOffset}|${payload.endPath}|${payload.endOffset}`;
        if (key === this._lastSelectionKey) return;
        this._lastSelectionKey = key;
        this.broadcastAction('selection', payload);
    }

    _createUI(): void {
        const modeLabel = (m: LiveModeValue): string =>
            ({
                [LiveMode.OFF]:       _t('web.live.off'),
                [LiveMode.BROADCAST]: _t('web.live.broadcast'),
                [LiveMode.FOLLOW]:    _t('web.live.follow'),
            } as Record<LiveModeValue, string>)[m];
        const colorDots = CONFIG.COLLABORATION.COLORS
            .map((c, i) =>
                `<div class="color-dot ${c === this.userColor ? 'active' : ''}" style="background-color: ${c}; --dot-color: ${c}" data-color="${c}" title="${i + 1}">${i + 1}</div>`,
            )
            .join('');
        const modeButtons = MODE_ORDER
            .map((m) =>
                `<button type="button" class="mode-btn ${m === this.mode ? 'active' : ''}" data-mode="${m}">${modeLabel(m)}</button>`,
            )
            .join('');
        const liveSection = this.liveEnabled
            ? `
                    <div class="panel-section-label" role="img" aria-label="${_t('web.collab.live')}" title="${_t('web.collab.live')}">${ICON_LIVE}</div>
                    <div class="panel-row panel-row-mode">
                        <div class="mode-group">${modeButtons}</div>
                    </div>`
            : '';
        const html = `
            <div id="markon-live-container" class="markon-live-container">
                <div class="markon-live-face" title="${_t('web.collab.title')}">
                    <svg class="icon-collab" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <circle cx="6" cy="9.2" r="1.9"/>
                        <path d="M2.6 16.6v-.3a3.4 3.4 0 0 1 5-3"/>
                        <circle cx="18" cy="9.2" r="1.9"/>
                        <path d="M21.4 16.6v-.3a3.4 3.4 0 0 0-5-3"/>
                        <circle cx="12" cy="8.2" r="2.5"/>
                        <path d="M7.4 17.2v-.8a4.6 4.6 0 0 1 9.2 0v.8"/>
                    </svg>
                    <svg class="icon-off" viewBox="0 0 24 24" width="40" height="40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                        <line x1="3.5" y1="3.5" x2="20.5" y2="20.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                    </svg>
                    <svg class="icon-close" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
                        <path d="M7 7 L17 17 M17 7 L7 17"/>
                    </svg>
                    <div class="leader-info"></div>
                </div>
                <div class="markon-live-body">
                    <div class="panel-header">${_t('web.collab.title')}</div>
                    <div class="panel-section-label" role="img" aria-label="${_t('web.collab.you')}" title="${_t('web.collab.you')}">${ICON_IDENTITY}</div>
                    <div class="panel-row-color">
                        <div class="color-picker">${colorDots}</div>
                        <input type="text" class="identity-name" maxlength="24" placeholder="${_t('web.collab.nickname')}">
                    </div>${liveSection}
                </div>
            </div>
        `;
        const div = document.createElement('div');
        div.innerHTML = html;
        this.container = div.firstElementChild as HTMLElement;
        // Insert before #toc-container (or at body start) so the Live sphere
        // loses the same-z-index DOM-order tie-break against the TOC icon —
        // otherwise M's box-shadow bleeds onto the TOC icon's left edge and
        // the sphere visually appears to sit on top.
        const tocContainer = document.getElementById('toc-container');
        document.body.insertBefore(this.container, tocContainer || document.body.firstChild);

        this.sphere = this.container; // the container itself is now the sphere
        this.panel = this.container.querySelector('.markon-live-body');
    }

    /** Hand position/drag/morph/collision off to FloatingLayer. The sphere
     *  is the click-and-drag handle; the body is the expanded drag area
     *  (its few interactive elements are excluded via nonDragSelector). */
    _setupFloatingLayer(): void {
        if (!this.container || !this.panel) return;
        this.layer = new FloatingLayer({
            name: 'live',
            container: this.container,
            handle: this.container.querySelector('.markon-live-face') as HTMLElement,
            body: this.panel,
            // Lowest-priority movable: yields to both passive ToC and Chat.
            rolePriority: 2,
            panelSize: { width: 260, height: 210 },
            homeAnchor: 'BR',
            // Panel grows down-right from the sphere's TL — the "L" letter
            // in the sphere becomes the "L" of the "Live" title at the
            // panel's top-left.
            panelAnchor: 'TL',
            initialOffset: { right: 20, bottom: 20 },
            storageKey: CONFIG.STORAGE_KEYS.LIVE_POS,
            nonDragSelector: '.panel-row.clickable, .color-dot, .mode-btn, .identity-name',
        });
        this.layer.init();
    }

    _setupEventListeners(): void {
        if (!this.panel) return;
        this.panel.querySelectorAll<HTMLButtonElement>('.mode-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const next = btn.dataset['mode'];
                if (next) this.setMode(next as LiveModeValue);
            });
        });

        this.panel.querySelectorAll<HTMLElement>('.color-dot').forEach((dot) => {
            dot.addEventListener('click', () => {
                const c = dot.dataset['color'];
                if (!c) return;
                this.userColor = c;
                Identity.setColor(c); // single identity source (shared w/ annotations)
                this._updateUIState();
            });
        });

        // Identity nickname — used by shared-annotation authorship (and shown
        // on author tooltips). Persisted per device; future annotations carry it.
        const nameInput = this.panel.querySelector<HTMLInputElement>('.identity-name');
        if (nameInput) {
            nameInput.value = Identity.name();
            nameInput.addEventListener('change', () => {
                Identity.setName(nameInput.value);
                nameInput.value = Identity.name();
            });
        }

        // Live sync is Workspace-level: route + viewport are available on
        // every page; document pages add section/selection/viewed semantics.
        this._observeFocusedSection();
        this._observeSelection();
        this._observeViewed();
        this._observeViewport();

        // Any local user input clears the "remote selection" marker so the
        // popover is suppressed only while the rendered selection still
        // represents what the leader sent.
        const clearRemoteMark = (): void => {
            if (this._applyingRemote) return;
            delete document.body.dataset['markonLiveRemote'];
        };
        document.addEventListener('mousedown', clearRemoteMark, true);
        document.addEventListener('touchstart', clearRemoteMark, true);
        document.addEventListener('keydown', clearRemoteMark, true);
    }

    /** Public alias so external callers (e.g. the global Esc handler) can
     *  dismiss the expanded panel without reaching into the layer. */
    collapse(): void { this.layer?.collapse(); }

    _updateUIState(): void {
        if (!this.sphere || !this.container || !this.panel) return;
        // Ring colour = your identity colour (always). Broadcasting adds the
        // breathing outer ring; live-off shows the slash — both only when Live
        // is enabled (a shared-annotation-only sphere is neither).
        this.sphere.classList.toggle('broadcasting', this.liveEnabled && this.isBroadcasting);
        this.sphere.classList.toggle('live-off', this.liveEnabled && this.mode === LiveMode.OFF);
        this.container.style.setProperty('--markon-live-user', this.userColor);

        this.panel.querySelectorAll<HTMLButtonElement>('.mode-btn').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset['mode'] === this.mode);
        });

        this.panel.querySelectorAll<HTMLElement>('.color-dot').forEach((dot) => {
            dot.classList.toggle('active', dot.dataset['color'] === this.userColor);
        });

        // Following state: a colored dot + "following" hint above the sphere
        // (identity = color, no names). Dot is tinted by the leader's color
        // via inline style; text stays neutral.
        const leaderInfo = this.sphere.querySelector<HTMLElement>('.leader-info');
        if (!leaderInfo) return;
        if (this.activeLeader && this.isFollowing) {
            leaderInfo.style.setProperty(
                '--leader-color',
                this.activeLeader.color || 'currentColor',
            );
            leaderInfo.classList.add('show');
        } else {
            leaderInfo.classList.remove('show');
        }
    }

    _getOrCreateClientId(): string {
        let id = sessionStorage.getItem(CONFIG.STORAGE_KEYS.CLIENT_ID);
        if (!id) {
            id = Ids.short();
            sessionStorage.setItem(CONFIG.STORAGE_KEYS.CLIENT_ID, id);
        }
        return id;
    }
}
