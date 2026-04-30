import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    CollaborationManager,
    LiveMode,
    type CollaborationApp,
    type LiveAction,
} from './collaboration-manager';
import type { WebSocketManager, WsHandler, WsInbound } from './websocket-manager';

/**
 * Minimal WebSocketManager fake — satisfies the slice of the interface
 * collaboration-manager actually touches: typed `on()` registration plus
 * `send()` capture. Anything else is intentionally unimplemented.
 */
function makeFakeWs() {
    const sent: unknown[] = [];
    const liveHandlers: Array<WsHandler<'live_action'>> = [];
    const fake = {
        isConnected: () => true,
        on: vi.fn(<T extends WsInbound['type']>(type: T, handler: WsHandler<T>): void => {
            if (type === 'live_action') {
                liveHandlers.push(handler as unknown as WsHandler<'live_action'>);
            }
        }),
        send: vi.fn(async (msg: unknown) => {
            sent.push(msg);
        }),
    };
    /**
     * Test helper: inject a `live_action` frame as if it had arrived from
     * the server, exercising the handler that init() registered.
     */
    const dispatchLiveAction = (data: LiveAction): void => {
        for (const h of liveHandlers) {
            h({ type: 'live_action', data: data as unknown as { action: string; [k: string]: unknown } });
        }
    };
    return { ws: fake as unknown as WebSocketManager, sent, dispatchLiveAction };
}

/**
 * Mount a fresh `<article class="markdown-body">` with a couple of heading
 * sections inside `document.body`. XPath services in this codebase resolve
 * from `article.markdown-body`, and the live manager itself queries that
 * selector for both focus and selection observers.
 */
function setupArticle(): HTMLElement {
    const article = document.createElement('article');
    article.className = 'markdown-body';
    article.innerHTML = `
        <div class="heading-section">
            <h2 id="intro">Intro</h2>
            <p>Hello world.</p>
        </div>
        <div class="heading-section">
            <h2 id="next">Next</h2>
            <p>Second paragraph.</p>
        </div>
    `;
    document.body.appendChild(article);
    return article;
}

describe('CollaborationManager', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        document.body.innerHTML = '';
        localStorage.clear();
        sessionStorage.clear();
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        // jsdom's window.scrollTo doesn't accept smooth-scroll options;
        // stub it so smartScrollToHeading is a harmless no-op.
        vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    });

    afterEach(() => {
        // Tear down any FloatingLayer registered with the global registry
        // so subsequent tests can re-init under the same name 'live'.
        const w = window as unknown as {
            __TEST_LAYERS__?: Array<{ destroy: () => void }>;
        };
        if (w.__TEST_LAYERS__) {
            for (const l of w.__TEST_LAYERS__) {
                try { l.destroy(); } catch { /* noop */ }
            }
            w.__TEST_LAYERS__ = [];
        }
        document.body.innerHTML = '';
        localStorage.clear();
        sessionStorage.clear();
        vi.restoreAllMocks();
    });

    /** Track the FloatingLayer registered by init() so afterEach can destroy it. */
    function trackLayers(mgr: CollaborationManager): void {
        const w = window as unknown as {
            __TEST_LAYERS__?: Array<{ destroy: () => void }>;
        };
        w.__TEST_LAYERS__ = w.__TEST_LAYERS__ ?? [];
        if (mgr.layer) w.__TEST_LAYERS__.push(mgr.layer);
    }

    it('constructor: generates a sessionStorage clientId and defaults mode to OFF', () => {
        const app: CollaborationApp = { enableLive: false };
        const mgr = new CollaborationManager(app);

        expect(mgr.clientId).toBeTruthy();
        expect(typeof mgr.clientId).toBe('string');
        expect(sessionStorage.getItem('markon-client-id')).toBe(mgr.clientId);
        expect(mgr.mode).toBe(LiveMode.OFF);
        // First default color from CONFIG.COLLABORATION.COLORS.
        expect(mgr.userColor).toBe('#3451B2');
    });

    it('constructor: restores saved color and mode from localStorage', () => {
        localStorage.setItem('markon-user-color', '#27AE60');
        localStorage.setItem('markon-live-mode', 'follow');
        const mgr = new CollaborationManager({ enableLive: false });
        expect(mgr.userColor).toBe('#27AE60');
        expect(mgr.mode).toBe(LiveMode.FOLLOW);
        expect(mgr._hasChosenColor).toBe(true);
    });

    it('setMode: persists to localStorage and ignores invalid / no-op transitions', () => {
        const mgr = new CollaborationManager({ enableLive: false });
        mgr.setMode(LiveMode.BROADCAST);
        expect(mgr.mode).toBe(LiveMode.BROADCAST);
        expect(localStorage.getItem('markon-live-mode')).toBe('broadcast');

        // A no-op transition does not rewrite storage; a bogus mode is
        // rejected outright, leaving state untouched.
        mgr.setMode(LiveMode.BROADCAST);
        mgr.setMode('garbage' as never);
        expect(mgr.mode).toBe(LiveMode.BROADCAST);
        expect(localStorage.getItem('markon-live-mode')).toBe('broadcast');
    });

    it('toggleActiveMode flips Follow ↔ Broadcast; toggleOff restores last-active', () => {
        const mgr = new CollaborationManager({ enableLive: false });
        // Start at OFF (default). toggleActiveMode lands in Follow first.
        mgr.toggleActiveMode();
        expect(mgr.mode).toBe(LiveMode.FOLLOW);
        mgr.toggleActiveMode();
        expect(mgr.mode).toBe(LiveMode.BROADCAST);

        // Shift+L takes us to OFF and remembers Broadcast as last-active;
        // a second Shift+L returns us there.
        mgr.toggleOff();
        expect(mgr.mode).toBe(LiveMode.OFF);
        mgr.toggleOff();
        expect(mgr.mode).toBe(LiveMode.BROADCAST);
    });

    it('handleLiveAction: drops frames whose clientId matches our own', () => {
        const mgr = new CollaborationManager({ enableLive: false });
        mgr.setMode(LiveMode.FOLLOW);
        const before = mgr.activeLeader;
        mgr.handleLiveAction({
            action: 'focus_section',
            clientId: mgr.clientId, // self
            color: '#27AE60',
            xpath: '//article[1]/DIV[1]/H2[1]',
        });
        expect(mgr.activeLeader).toBe(before); // untouched
    });

    it('handleLiveAction: in Follow mode applies focus_section to the matching heading', () => {
        const article = setupArticle();
        const mgr = new CollaborationManager({ enableLive: false });
        mgr.setMode(LiveMode.FOLLOW);

        // XPath of the second h2 inside the second .heading-section.
        const xpath = '//article[1]/DIV[2]/H2[1]';
        mgr.handleLiveAction({
            action: 'focus_section',
            clientId: 'remote-123',
            color: '#E64560',
            xpath,
        });

        const targets = article.querySelectorAll('.heading-focused');
        expect(targets.length).toBe(1);
        expect(targets[0].id).toBe('next');
        // Speaker color is staged onto the section as a CSS variable for
        // the breathing pulse keyframe.
        const section = (targets[0].closest('.heading-section') as HTMLElement)!;
        expect(section.style.getPropertyValue('--live-pulse-color')).toBe('#E64560');
    });

    it('handleLiveAction: a "selection" frame with cleared=true clears the local selection', () => {
        const article = setupArticle();
        const mgr = new CollaborationManager({ enableLive: false });
        mgr.setMode(LiveMode.FOLLOW);

        // Seed a non-empty selection so the cleared frame has something to
        // clear; without this, removeAllRanges() would already be a no-op.
        const p = article.querySelector('p')!;
        const range = document.createRange();
        range.setStart(p.firstChild!, 0);
        range.setEnd(p.firstChild!, 5);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(range);
        expect(sel.rangeCount).toBe(1);

        mgr.handleLiveAction({
            action: 'selection',
            clientId: 'remote-123',
            color: '#3451B2',
            cleared: true,
        });
        expect(window.getSelection()?.rangeCount ?? 0).toBe(0);
    });

    it('color picker click persists the chosen color and updates state', () => {
        setupArticle();
        const { ws } = makeFakeWs();
        const mgr = new CollaborationManager({ enableLive: true, ws });
        mgr.init();
        trackLayers(mgr);

        const dot = mgr.panel!.querySelector<HTMLElement>(
            '.color-dot[data-color="#F39C12"]',
        )!;
        expect(dot).toBeTruthy();
        dot.click();
        expect(mgr.userColor).toBe('#F39C12');
        expect(localStorage.getItem('markon-user-color')).toBe('#F39C12');
        expect(mgr._hasChosenColor).toBe(true);
        // active class follows the picked dot.
        expect(dot.classList.contains('active')).toBe(true);
    });

    it('init in BROADCAST mode + a focus-class change broadcasts focus_section over the WS', async () => {
        const article = setupArticle();
        const { ws, sent } = makeFakeWs();
        // Pre-set BROADCAST so init() comes up live without a click.
        localStorage.setItem('markon-live-mode', 'broadcast');
        const mgr = new CollaborationManager({ enableLive: true, ws });
        mgr.init();
        trackLayers(mgr);

        // Simulate the local navigation flow (j/k or click) marking a
        // heading as focused. The mutation observer should pick it up.
        const target = article.querySelectorAll('h2')[1];
        target.classList.add('heading-focused');

        // MutationObserver callbacks run as microtasks; flush.
        await new Promise<void>((r) => setTimeout(r, 0));

        // Filter to just the live_action sends — init() may emit other
        // frames in the future; this keeps the assertion intent-focused.
        const live = sent.filter(
            (m): m is { type: 'live_action'; data: { action: string; xpath: string; clientId: string } } =>
                !!m && typeof m === 'object' && (m as { type?: string }).type === 'live_action',
        );
        expect(live.length).toBeGreaterThanOrEqual(1);
        const last = live[live.length - 1];
        expect(last.data.action).toBe('focus_section');
        expect(last.data.clientId).toBe(mgr.clientId);
        expect(typeof last.data.xpath).toBe('string');
    });

    it('mode buttons: clicking a button calls setMode (and persists)', () => {
        setupArticle();
        const { ws } = makeFakeWs();
        const mgr = new CollaborationManager({ enableLive: true, ws });
        mgr.init();
        trackLayers(mgr);

        const btn = mgr.panel!.querySelector<HTMLButtonElement>(
            '.mode-btn[data-mode="follow"]',
        )!;
        expect(btn).toBeTruthy();
        btn.click();
        expect(mgr.mode).toBe(LiveMode.FOLLOW);
        expect(localStorage.getItem('markon-live-mode')).toBe('follow');
    });

    it('init() registers a live_action handler and routes incoming frames through handleLiveAction', () => {
        const article = setupArticle();
        const { ws, dispatchLiveAction } = makeFakeWs();
        const mgr = new CollaborationManager({ enableLive: true, ws });
        // Follow so the frame is actually applied (broadcast/off skip).
        localStorage.setItem('markon-live-mode', 'follow');
        mgr.mode = LiveMode.FOLLOW;
        mgr.init();
        trackLayers(mgr);

        dispatchLiveAction({
            action: 'focus_section',
            clientId: 'remote-456',
            color: '#0EA5E9',
            xpath: '//article[1]/DIV[1]/H2[1]',
        });

        const focused = article.querySelector('.heading-focused');
        expect(focused).toBeTruthy();
        expect(focused?.id).toBe('intro');
    });
});
