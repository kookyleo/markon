import { CONFIG } from '../core/config.js';
import { Ids, Logger } from '../core/utils.js';
import { Meta } from '../services/dom.js';
import { Position } from '../services/position.js';
import { XPath } from '../services/xpath.js';

// Three mutually-exclusive states. Identity is just the user's chosen color;
// no hostnames or names anywhere.
export const LiveMode = Object.freeze({ OFF: 'off', BROADCAST: 'broadcast', FOLLOW: 'follow' });
const ACTIVE_MODES = [LiveMode.BROADCAST, LiveMode.FOLLOW];
const MODE_ORDER = [LiveMode.OFF, ...ACTIVE_MODES];

export class CollaborationManager {
    constructor(app) {
        this.app = app;
        this.clientId = this._getOrCreateClientId();
        this.userColor = this._loadSavedColor();
        this._hasChosenColor = localStorage.getItem(CONFIG.STORAGE_KEYS.LIVE_COLOR) !== null;
        this.mode = this._loadSavedMode();
        this.activeLeader = null;
        this.leaderTimer = null;

        this.container = null;
        this.sphere = null;
        this.panel = null;

        this.isDragging = false;
        this.dragStartX = 0;
        this.dragStartY = 0;
    }

    get isBroadcasting() { return this.mode === LiveMode.BROADCAST; }
    get isFollowing()    { return this.mode === LiveMode.FOLLOW; }

    init() {
        const enabled = this.app.enableLive ?? Meta.flag(CONFIG.META_TAGS.ENABLE_LIVE);
        if (!enabled) return;
        if (!this.app.ws) {
            Logger.warn('Live', 'enable_live is on but WebSocket is unavailable');
            return;
        }

        this._createUI();
        this._setupEventListeners();
        this._observeToc();
        // Sync UI to the loaded mode / color — the template's initial
        // attributes are hard-coded placeholders and need to reflect the
        // real state (e.g. aria-disabled on the color row, active classes,
        // --markon-live-user custom property).
        this._updateUIState();

        this.app.ws.on(CONFIG.WS_MESSAGE_TYPES.LIVE_ACTION, (msg) => {
            this.handleLiveAction(msg.data);
        });

        Logger.log('Live', `Initialized (clientId=${this.clientId}, mode=${this.mode})`);
    }

    /** `L` shortcut. Off → Follow; Follow → Broadcast; Broadcast → Follow.
     *  Off is only entered via `Shift+L`, never via this toggle. */
    toggleActiveMode() {
        if (this.mode === LiveMode.FOLLOW) this.setMode(LiveMode.BROADCAST);
        else                                this.setMode(LiveMode.FOLLOW);
    }

    /** `Shift+L` shortcut. Toggles Off ⇄ last active mode. Coming back
     *  from Off restores whatever mode was active before (Broadcast or
     *  Follow), falling back to Follow if there's no history. */
    toggleOff() {
        if (this.mode === LiveMode.OFF) {
            this.setMode(this._lastActiveMode || LiveMode.FOLLOW);
        } else {
            this._lastActiveMode = this.mode;
            this.setMode(LiveMode.OFF);
        }
    }

    setMode(mode) {
        if (!MODE_ORDER.includes(mode) || mode === this.mode) return;
        if (ACTIVE_MODES.includes(mode)) this._lastActiveMode = mode;
        this.mode = mode;
        localStorage.setItem(CONFIG.STORAGE_KEYS.LIVE_MODE, mode);
        this._updateUIState();
    }

    _loadSavedMode() {
        const saved = localStorage.getItem(CONFIG.STORAGE_KEYS.LIVE_MODE);
        return MODE_ORDER.includes(saved) ? saved : LiveMode.OFF;
    }

    // When the TOC menu opens/closes, its bounding rect changes shape (icon
    // circle ⇄ expanded menu rectangle). Re-run collision so the Live sphere
    // is physically pushed out of the way if the expanding menu now overlaps
    // its current position.
    _observeToc() {
        const tocContainer = document.getElementById('toc-container');
        if (!tocContainer) return;
        // On every TOC state change, re-derive displayed from home. Opening
        // the menu pushes Live out; closing lets it return all the way back.
        // Skipped while expanded — in that state the container's anchors
        // belong to _expand (top/left), and writing right/bottom on top of
        // them would pin all four edges at once and visibly stretch the
        // panel. _collapse re-applies on its way back to the sphere state.
        new MutationObserver(() => {
            if (this.container.classList.contains('expanded')) return;
            this._applyDisplayed();
        }).observe(tocContainer, {
            attributes: true,
            attributeFilter: ['class'],
        });
    }

    handleLiveAction(data) {
        if (data.clientId === this.clientId) return;
        if (!this.isFollowing) return;

        this.activeLeader = data;
        this._updateUIState();

        if (this.leaderTimer) clearTimeout(this.leaderTimer);
        this.leaderTimer = setTimeout(() => {
            this.activeLeader = null;
            this._updateUIState();
        }, 3000);

        if (data.action === 'focus_section') {
            this._applyFocusSection(data.xpath, data.color);
        } else if (data.action === 'selection') {
            if (data.cleared) {
                window.getSelection().removeAllRanges();
            } else {
                this._applySelection(data);
            }
        } else if (data.action === 'viewed') {
            this._applyViewed(data);
        }
    }

    _applyViewed(data) {
        if (!data.headingId) return;
        const cb = document.querySelector(
            `.viewed-checkbox[data-heading-id="${CSS.escape(data.headingId)}"]`
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

    _applyFocusSection(xpath, speakerColor) {
        const el = XPath.resolve(xpath);
        if (!el) return;
        this._applyingRemote = true;
        try {
            // Mirror the local j/k navigation exactly: same focus class, same
            // smart-scroll positioning, same TOC selected-state sync. The
            // only "I'm a follower" cue is the breathing pulse below.
            document.querySelectorAll('.heading-focused').forEach(e => e.classList.remove('heading-focused'));
            el.classList.add('heading-focused');
            Position.smartScrollToHeading(el);
            if (el.id && window.__markonTocSetSelected) {
                window.__markonTocSetSelected(el.id);
            }

            // Breathing pulse starts in the speaker's color and fades to the
            // steady focus border color supplied by the base stylesheet.
            const section = el.closest('.heading-section') || el;
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

    _applySelection(data) {
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
            sel.removeAllRanges();
            sel.addRange(range);
            // The only "remote" signal is this data attribute, checked by
            // PopoverManager to skip the annotation toolbar on the follower.
            document.body.dataset.markonLiveRemote = '1';

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

    broadcastAction(action, extraData = {}) {
        if (!this.isBroadcasting || !this.app.ws) return;
        this.app.ws.send({
            type: CONFIG.WS_MESSAGE_TYPES.LIVE_ACTION,
            data: {
                clientId: this.clientId,
                color: this.userColor, // identity is purely the speaker's color
                action,
                ...extraData,
            }
        });
    }

    // Watch for the reader changing the active section (via click or j/k
    // navigation) and broadcast the new section's xpath. This is the primary
    // "where is the speaker" signal — scroll position itself is irrelevant.
    _observeFocusedSection() {
        const article = document.querySelector('article.markdown-body');
        if (!article) return;
        new MutationObserver(() => {
            if (this._applyingRemote) return;
            const focused = article.querySelector('.heading-focused');
            if (!focused) return;
            const xpath = XPath.create(focused);
            if (xpath === this._lastFocusXPath) return;
            this._lastFocusXPath = xpath;
            this.broadcastAction('focus_section', { xpath });
        }).observe(article, {
            subtree: true,
            attributes: true,
            attributeFilter: ['class'],
        });
    }

    // Broadcast the current text selection (range inside the article) so
    // remote peers can mirror what the speaker is pointing at. Debounced to
    // avoid flooding mid-drag.
    _observeSelection() {
        const article = document.querySelector('article.markdown-body');
        if (!article) return;
        let timer;
        document.addEventListener('selectionchange', () => {
            clearTimeout(timer);
            timer = setTimeout(() => this._broadcastSelection(article), 120);
        });
    }

    // Watch user-initiated Viewed-checkbox toggles and broadcast them. The
    // native `change` event only fires on real user interaction, so
    // programmatic `.checked = X` from viewed.js's own batch updates
    // (updateCheckboxes / mark-all, etc.) won't echo back through here.
    _observeViewed() {
        document.addEventListener('change', (e) => {
            if (this._applyingRemote) return;
            const cb = e.target;
            if (!cb || !cb.classList || !cb.classList.contains('viewed-checkbox')) return;
            const id = cb.dataset && cb.dataset.headingId;
            if (!id) return;
            this.broadcastAction('viewed', { headingId: id, checked: cb.checked });
        });
    }

    _broadcastSelection(article) {
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
        const startParent = range.startContainer.nodeType === 3
            ? range.startContainer.parentElement : range.startContainer;
        const endParent = range.endContainer.nodeType === 3
            ? range.endContainer.parentElement : range.endContainer;
        if (!startParent || !endParent) return;
        const payload = {
            startPath: XPath.create(startParent),
            startOffset: XPath.getAbsoluteOffset(range.startContainer, range.startOffset),
            endPath: XPath.create(endParent),
            endOffset: XPath.getAbsoluteOffset(range.endContainer, range.endOffset),
        };
        const key = `${payload.startPath}|${payload.startOffset}|${payload.endPath}|${payload.endOffset}`;
        if (key === this._lastSelectionKey) return;
        this._lastSelectionKey = key;
        this.broadcastAction('selection', payload);
    }

    _createUI() {
        const t = (window.__MARKON_I18N__ && window.__MARKON_I18N__.t) || (k => k);
        const modeLabel = m => ({
            [LiveMode.OFF]:       t('web.live.off'),
            [LiveMode.BROADCAST]: t('web.live.broadcast'),
            [LiveMode.FOLLOW]:    t('web.live.follow'),
        }[m]);
        const colorDots = CONFIG.COLLABORATION.COLORS
            .map((c, i) => `<div class="color-dot ${c === this.userColor ? 'active' : ''}" style="background-color: ${c}; --dot-color: ${c}" data-color="${c}" title="${i + 1}">${i + 1}</div>`)
            .join('');
        const modeButtons = MODE_ORDER
            .map(m => `<button type="button" class="mode-btn ${m === this.mode ? 'active' : ''}" data-mode="${m}">${modeLabel(m)}</button>`)
            .join('');
        const html = `
            <div id="markon-live-container" class="markon-live-container">
                <div class="markon-live-face" title="Markon Live">
                    <svg class="icon-live" viewBox="0 0 24 24" width="22" height="22" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                        <circle cx="12" cy="12" r="2.6" fill="#e74c3c"/>
                        <path d="M7.5 8 Q5.5 12 7.5 16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
                        <path d="M4.5 5.5 Q1.5 12 4.5 18.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
                        <path d="M16.5 8 Q18.5 12 16.5 16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
                        <path d="M19.5 5.5 Q22.5 12 19.5 18.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
                    </svg>
                    <svg class="icon-off" viewBox="0 0 24 24" width="40" height="40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                        <line x1="3.5" y1="3.5" x2="20.5" y2="20.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                    </svg>
                    <svg class="icon-close" viewBox="0 0 24 24" width="20" height="20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                        <path d="M7 7 L17 17 M17 7 L7 17" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
                    </svg>
                    <div class="leader-info"></div>
                </div>
                <div class="markon-live-body">
                    <div class="panel-header">Live</div>
                    <div class="panel-row panel-row-mode">
                        <div class="mode-group">${modeButtons}</div>
                    </div>
                    <div class="panel-row-color" aria-disabled="true">
                        <div class="color-picker">${colorDots}</div>
                        <span class="panel-row-label"></span>
                    </div>
                </div>
            </div>
        `;
        const div = document.createElement('div');
        div.innerHTML = html;
        this.container = div.firstElementChild;
        // Insert before #toc-container (or at body start) so the Live sphere
        // loses the same-z-index DOM-order tie-break against the TOC icon —
        // otherwise M's box-shadow bleeds onto the TOC icon's left edge and
        // the sphere visually appears to sit on top.
        const tocContainer = document.getElementById('toc-container');
        document.body.insertBefore(this.container, tocContainer || document.body.firstChild);

        this.sphere = this.container; // the container itself is now the sphere
        this.panel = this.container.querySelector('.markon-live-body');

        // TOC is a higher-priority, non-movable obstacle. The Live sphere has:
        //   home      — user's intended position (persisted; TOC agnostic).
        //   displayed — what's actually rendered = clamp(home) against TOC.
        // When TOC state changes we re-derive displayed from home, so the
        // sphere is "pushed aside" by an opening menu and "returns" when it
        // closes — no manual snap-back needed.
        this._home = this._clampToViewport(
            JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.LIVE_POS) || '{"right":20,"bottom":20}')
        );
        localStorage.setItem(CONFIG.STORAGE_KEYS.LIVE_POS, JSON.stringify(this._home));
        this.container.style.position = 'fixed';
        this._applyDisplayed();
    }

    _applyDisplayed() {
        const pos = this._avoidTocCollision({ ...this._home });
        this.container.style.right = `${pos.right}px`;
        this.container.style.bottom = `${pos.bottom}px`;
    }

    _beginDragCollapsed(e) {
        this.isDragging = false;
        this.dragStartX = e.clientX;
        this.dragStartY = e.clientY;
        const onMove = (me) => {
            if (Math.abs(me.clientX - this.dragStartX) > 5 || Math.abs(me.clientY - this.dragStartY) > 5) {
                this.isDragging = true;
                // Home tracks raw mouse (viewport-clamped). Displayed adds
                // TOC avoidance — the sphere physically rolls around TOC
                // while the user's intended position keeps advancing.
                this._home = this._clampToViewport({
                    right: window.innerWidth - me.clientX - 20,
                    bottom: window.innerHeight - me.clientY - 20,
                });
                this._applyDisplayed();
            }
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            if (this.isDragging) {
                localStorage.setItem(CONFIG.STORAGE_KEYS.LIVE_POS, JSON.stringify(this._home));
            }
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }

    _beginDragExpanded(e) {
        e.preventDefault();
        const startX = e.clientX;
        const startY = e.clientY;
        const anchor = this._expandedAnchor || { fromTop: false, fromLeft: false };
        const startTop    = parseFloat(this.container.style.top)    || 0;
        const startLeft   = parseFloat(this.container.style.left)   || 0;
        const startRight  = parseFloat(this.container.style.right)  || 0;
        const startBottom = parseFloat(this.container.style.bottom) || 0;
        let moved = false;
        const onMove = (me) => {
            const dx = me.clientX - startX;
            const dy = me.clientY - startY;
            if (!moved && Math.hypot(dx, dy) < 5) return;
            moved = true;
            // Update only the anchor style that's currently active so the
            // panel slides without flipping direction.
            if (anchor.fromTop) this.container.style.top    = `${startTop + dy}px`;
            else                this.container.style.bottom = `${startBottom - dy}px`;
            if (anchor.fromLeft) this.container.style.left  = `${startLeft + dx}px`;
            else                 this.container.style.right = `${startRight - dx}px`;
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            if (!moved) return;
            // Sync home to the sphere's anchor corner of the expanded rect
            // so when collapsed, the sphere re-appears right where that
            // corner was.
            const r = this.container.getBoundingClientRect();
            const cornerCx = anchor.fromLeft ? r.left + 20 : r.right - 20;
            const cornerCy = anchor.fromTop  ? r.top + 20  : r.bottom - 20;
            this._home = this._clampToViewport({
                right: window.innerWidth - cornerCx - 20,
                bottom: window.innerHeight - cornerCy - 20,
            });
            localStorage.setItem(CONFIG.STORAGE_KEYS.LIVE_POS, JSON.stringify(this._home));
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }

    // Viewport bounds only — guarantees ≥ MIN_VISIBLE of the sphere is always
    // on screen. Used to clamp "home" (the user's intent) so persisted drag
    // positions can't drift off-screen after a window resize.
    _clampToViewport({ right, bottom }) {
        const SPHERE_SIZE = 40;
        const MIN_VISIBLE = 20;
        const maxRight = window.innerWidth - MIN_VISIBLE;
        const maxBottom = window.innerHeight - MIN_VISIBLE;
        return {
            right: Math.max(0, Math.min(Number(right) || 0, maxRight - SPHERE_SIZE + MIN_VISIBLE)),
            bottom: Math.max(0, Math.min(Number(bottom) || 0, maxBottom - SPHERE_SIZE + MIN_VISIBLE)),
        };
    }

    // Prevent the Live sphere from overlapping the TOC icon (circle) when
    // collapsed, or the expanded TOC menu (rectangle) when active. A small
    // gap ≥ shadow blur radius keeps the two elements' box-shadows from
    // bleeding into each other, so neither appears stacked on top.
    _avoidTocCollision(pos) {
        const tocContainer = document.getElementById('toc-container');
        if (!tocContainer) return pos;
        const active = tocContainer.classList.contains('active');
        const target = active
            ? tocContainer.querySelector('.toc')
            : document.getElementById('toc-icon');
        if (!target) return pos;
        const rect = target.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return pos;

        const SPHERE = 40;
        const SHADOW_GAP = 10;
        const sphereR = SPHERE / 2;
        const liveCx = window.innerWidth - pos.right - sphereR;
        const liveCy = window.innerHeight - pos.bottom - sphereR;

        // Circle-vs-circle when TOC is collapsed (icon is a 40×40 circle)...
        if (!active) {
            const tocR = Math.min(rect.width, rect.height) / 2;
            const tocCx = rect.left + rect.width / 2;
            const tocCy = rect.top + rect.height / 2;
            const dx = liveCx - tocCx;
            const dy = liveCy - tocCy;
            const dist = Math.hypot(dx, dy);
            const minDist = sphereR + tocR + SHADOW_GAP;
            if (dist >= minDist) return pos;
            const ux = dist === 0 ? 0 : dx / dist;
            const uy = dist === 0 ? 1 : dy / dist;
            const newCx = tocCx + ux * minDist;
            const newCy = tocCy + uy * minDist;
            pos.right = window.innerWidth - newCx - sphereR;
            pos.bottom = window.innerHeight - newCy - sphereR;
            return pos;
        }

        // ...circle-vs-rect when TOC menu is expanded.
        const closestX = Math.max(rect.left, Math.min(liveCx, rect.right));
        const closestY = Math.max(rect.top, Math.min(liveCy, rect.bottom));
        let dx = liveCx - closestX;
        let dy = liveCy - closestY;
        let dist = Math.hypot(dx, dy);
        const minDist = sphereR + SHADOW_GAP;

        // Center is inside the rect: push along the shortest edge normal.
        if (dist === 0) {
            const toLeft = liveCx - rect.left;
            const toRight = rect.right - liveCx;
            const toTop = liveCy - rect.top;
            const toBottom = rect.bottom - liveCy;
            const minEdge = Math.min(toLeft, toRight, toTop, toBottom);
            if (minEdge === toLeft)        { dx = -1; dy = 0; }
            else if (minEdge === toRight)  { dx = 1;  dy = 0; }
            else if (minEdge === toTop)    { dx = 0;  dy = -1; }
            else                           { dx = 0;  dy = 1; }
            // Place the sphere just outside that edge.
            const edgeX = dx < 0 ? rect.left : dx > 0 ? rect.right : liveCx;
            const edgeY = dy < 0 ? rect.top  : dy > 0 ? rect.bottom : liveCy;
            const newCx = edgeX + dx * minDist;
            const newCy = edgeY + dy * minDist;
            pos.right = window.innerWidth - newCx - sphereR;
            pos.bottom = window.innerHeight - newCy - sphereR;
            return pos;
        }

        if (dist >= minDist) return pos;
        const ux = dx / dist;
        const uy = dy / dist;
        const newCx = closestX + ux * minDist;
        const newCy = closestY + uy * minDist;
        pos.right = window.innerWidth - newCx - sphereR;
        pos.bottom = window.innerHeight - newCy - sphereR;
        return pos;
    }

    _setupEventListeners() {
        const face = this.container.querySelector('.markon-live-face');
        const body = this.container.querySelector('.markon-live-body');

        // Face click toggles expand/collapse. In expanded state the face
        // is pinned to the panel's top-left corner showing an X — so clicking
        // at the same screen spot twice is the reverse of the first click.
        face.addEventListener('click', (e) => {
            if (this.isDragging) return;
            e.stopPropagation();
            if (this.container.classList.contains('expanded')) {
                this._collapse();
            } else {
                this._expand();
            }
        });

        // Clicks inside the expanded body stay inside (don't trigger collapse).
        body.addEventListener('click', (e) => e.stopPropagation());

        // Collapse when clicking anywhere outside the expanded panel.
        document.addEventListener('click', () => {
            if (this.container.classList.contains('expanded')) this._collapse();
        });

        this.panel.querySelectorAll('.mode-btn').forEach(btn => {
            btn.addEventListener('click', () => this.setMode(btn.dataset.mode));
        });

        this.panel.querySelectorAll('.color-dot').forEach(dot => {
            dot.addEventListener('click', () => {
                this.userColor = dot.dataset.color;
                this._hasChosenColor = true;
                localStorage.setItem(CONFIG.STORAGE_KEYS.LIVE_COLOR, this.userColor);
                this._updateUIState();
            });
        });

        // Drag on the face (circle) in collapsed state.
        face.addEventListener('mousedown', (e) => {
            if (this.container.classList.contains('expanded')) return;
            this._beginDragCollapsed(e);
        });

        // Drag the expanded panel via its blank space — clicks on rows,
        // switches, or color dots should still fire as normal.
        body.addEventListener('mousedown', (e) => {
            if (!this.container.classList.contains('expanded')) return;
            if (e.target.closest('.panel-row.clickable, .color-dot')) return;
            this._beginDragExpanded(e);
        });

        // Live sync is semantic, not geometric — we track the focused
        // section, the text selection, and viewed-checkbox toggles. Scroll
        // is never broadcast.
        this._observeFocusedSection();
        this._observeSelection();
        this._observeViewed();

        // Any local user input clears the "remote selection" marker so the
        // popover is suppressed only while the rendered selection still
        // represents what the leader sent.
        const clearRemoteMark = () => {
            if (this._applyingRemote) return;
            delete document.body.dataset.markonLiveRemote;
        };
        document.addEventListener('mousedown', clearRemoteMark, true);
        document.addEventListener('touchstart', clearRemoteMark, true);
        document.addEventListener('keydown', clearRemoteMark, true);
    }

    // Expand the sphere into the panel. Anchor is always the sphere's
    // top-left corner (panel grows down-right); the "L" letter in the sphere
    // becomes the "L" of the "Live" title at the panel's top-left. The sphere
    // only physically shifts if the panel would overflow the viewport or
    // overlap the TOC icon — otherwise its top-left stays pixel-identical.
    _expand() {
        if (this.container.classList.contains('expanded')) return;
        const PANEL_W = 260;
        const PANEL_H = 160;
        const MARGIN = 8;
        const SHADOW_GAP = 10;
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        const rect = this.container.getBoundingClientRect();
        let top = rect.top;
        let left = rect.left;

        // Panel would occupy [left, left+PANEL_W] × [top, top+PANEL_H].
        // Shift sphere to satisfy viewport + TOC constraints.
        const shiftToFit = () => {
            if (left + PANEL_W > vw - MARGIN) left = vw - MARGIN - PANEL_W;
            if (top  + PANEL_H > vh - MARGIN) top  = vh - MARGIN - PANEL_H;
            if (left < MARGIN) left = MARGIN;
            if (top  < MARGIN) top  = MARGIN;
        };
        shiftToFit();

        const tocRect = this._tocFootprint();
        if (tocRect) {
            const overlaps = () => {
                const r = left + PANEL_W, b = top + PANEL_H;
                return r > tocRect.left - SHADOW_GAP && left < tocRect.right + SHADOW_GAP
                    && b > tocRect.top  - SHADOW_GAP && top  < tocRect.bottom + SHADOW_GAP;
            };
            if (overlaps()) {
                // Push along the smaller axis so we displace the sphere
                // minimally. Favor the direction that keeps the sphere closer
                // to its original position.
                const pushLeft  = (left + PANEL_W) - (tocRect.left - SHADOW_GAP);
                const pushRight = (tocRect.right + SHADOW_GAP) - left;
                const pushUp    = (top + PANEL_H) - (tocRect.top - SHADOW_GAP);
                const pushDown  = (tocRect.bottom + SHADOW_GAP) - top;
                const candidates = [
                    { axis: 'x', delta: -pushLeft  },
                    { axis: 'x', delta:  pushRight },
                    { axis: 'y', delta: -pushUp    },
                    { axis: 'y', delta:  pushDown  },
                ].filter(c => Math.abs(c.delta) > 0);
                candidates.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta));
                for (const c of candidates) {
                    const tryLeft = c.axis === 'x' ? left + c.delta : left;
                    const tryTop  = c.axis === 'y' ? top  + c.delta : top;
                    if (tryLeft >= MARGIN && tryLeft + PANEL_W <= vw - MARGIN
                     && tryTop  >= MARGIN && tryTop  + PANEL_H <= vh - MARGIN) {
                        left = tryLeft;
                        top  = tryTop;
                        break;
                    }
                }
                shiftToFit();
            }
        }

        // Clear all anchors, re-pin to the (possibly-shifted) top-left corner.
        this.container.style.right = '';
        this.container.style.bottom = '';
        this.container.style.top = `${top}px`;
        this.container.style.left = `${left}px`;
        this._expandedAnchor = { fromTop: true, fromLeft: true };
        this.container.classList.add('expanded');
    }

    _tocFootprint() {
        const tocContainer = document.getElementById('toc-container');
        if (!tocContainer) return null;
        const active = tocContainer.classList.contains('active');
        const target = active
            ? tocContainer.querySelector('.toc')
            : document.getElementById('toc-icon');
        if (!target) return null;
        const r = target.getBoundingClientRect();
        return r.width === 0 || r.height === 0 ? null : r;
    }

    /** Public alias so external callers (e.g. the global Esc handler) can
     *  dismiss the expanded panel without reaching into a private method. */
    collapse() { this._collapse(); }

    _collapse() {
        if (!this.container.classList.contains('expanded')) return;
        this.container.classList.remove('expanded');
        // Clear the expand-time anchors; _applyDisplayed re-derives position
        // from home, so any temporary push during expand is naturally undone.
        this.container.style.top = '';
        this.container.style.left = '';
        this.container.style.right = '';
        this.container.style.bottom = '';
        this._applyDisplayed();
    }

    _updateUIState() {
        // Three visual modes on the container:
        //   .broadcasting — ring in the user's color (speaker)
        //   .live-off     — muted grey ring + slash across the icon
        //   (neither)     — default look (follower)
        this.sphere.classList.toggle('broadcasting', this.isBroadcasting);
        this.sphere.classList.toggle('live-off', this.mode === LiveMode.OFF);
        this.container.style.setProperty('--markon-live-user', this.userColor);

        this.panel.querySelectorAll('.mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === this.mode);
        });

        // Color only matters while broadcasting — dim + disable the picker
        // otherwise to make the attachment relationship obvious.
        const colorRow = this.panel.querySelector('.panel-row-color');
        if (colorRow) colorRow.setAttribute('aria-disabled', this.isBroadcasting ? 'false' : 'true');

        // Label swaps between a prompt (before first pick) and a description
        // of what the chosen color affects (after first pick).
        const label = this.panel.querySelector('.panel-row-label');
        if (label) {
            const t = (window.__MARKON_I18N__ && window.__MARKON_I18N__.t) || (k => k);
            label.textContent = this._hasChosenColor
                ? t('web.live.color.desc')
                : t('web.live.color.prompt');
        }

        this.panel.querySelectorAll('.color-dot').forEach(dot => {
            dot.classList.toggle('active', dot.dataset.color === this.userColor);
        });

        // Following state: a colored dot + "following" hint above the sphere
        // (identity = color, no names). Dot is tinted by the leader's color
        // via inline style; text stays neutral.
        const leaderInfo = this.sphere.querySelector('.leader-info');
        if (this.activeLeader && this.isFollowing) {
            leaderInfo.style.setProperty('--leader-color', this.activeLeader.color || 'currentColor');
            leaderInfo.classList.add('show');
        } else {
            leaderInfo.classList.remove('show');
        }
    }

    _getOrCreateClientId() {
        let id = sessionStorage.getItem(CONFIG.STORAGE_KEYS.CLIENT_ID);
        if (!id) {
            id = Ids.short();
            sessionStorage.setItem(CONFIG.STORAGE_KEYS.CLIENT_ID, id);
        }
        return id;
    }

    _loadSavedColor() {
        const saved = localStorage.getItem(CONFIG.STORAGE_KEYS.LIVE_COLOR);
        return CONFIG.COLLABORATION.COLORS.includes(saved) ? saved : CONFIG.COLLABORATION.COLORS[0];
    }
}
