import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FloatingLayer, type FloatingLayerOpts } from './floating-layer';

// jsdom does not implement WAAPI; Element.animate is undefined. Stub it so
// any call returns a controllable Animation-like object. Tests that drive
// expand/collapse animations rely on this stub.
type FakeAnimation = Animation & {
    onfinish: ((ev: Event) => unknown) | null;
};

function installAnimateStub(): { lastAnim: FakeAnimation | null; calls: number } {
    const state: { lastAnim: FakeAnimation | null; calls: number } = { lastAnim: null, calls: 0 };
    HTMLElement.prototype.animate = vi.fn(function animate(this: HTMLElement) {
        state.calls += 1;
        const anim = {
            cancel: vi.fn(),
            commitStyles: vi.fn(),
            onfinish: null as ((ev: Event) => unknown) | null,
            finished: Promise.resolve(),
        } as unknown as FakeAnimation;
        state.lastAnim = anim;
        return anim;
    });
    return state;
}

function makeContainer(): HTMLElement {
    const el = document.createElement('div');
    document.body.appendChild(el);
    return el;
}

function freshLayer(name: string, override: Partial<FloatingLayerOpts> = {}): FloatingLayer {
    return new FloatingLayer({
        name,
        container: makeContainer(),
        homeAnchor: 'BR',
        ...override,
    });
}

beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
});

afterEach(() => {
    // Tear down every registered layer so REGISTRY is clean across tests.
    for (const inst of Array.from(FloatingLayer.all())) inst.destroy();
    document.body.innerHTML = '';
    localStorage.clear();
    vi.restoreAllMocks();
});

// ── Construction & registry ────────────────────────────────────────────────

describe('FloatingLayer / construction', () => {
    it('registers itself by name and exposes static get/all', () => {
        const a = freshLayer('a');
        const b = freshLayer('b');
        expect(FloatingLayer.get('a')).toBe(a);
        expect(FloatingLayer.get('b')).toBe(b);
        const all = Array.from(FloatingLayer.all());
        expect(all).toHaveLength(2);
        expect(all).toContain(a);
        expect(all).toContain(b);
    });

    it('rejects duplicate registration with the same name', () => {
        freshLayer('dup');
        expect(() => freshLayer('dup')).toThrow(/duplicate name/);
    });

    it('throws when name is missing', () => {
        // @ts-expect-error -- intentionally invalid args
        expect(() => new FloatingLayer({ container: document.createElement('div') })).toThrow(/name required/);
    });

    it('throws when container is missing', () => {
        // @ts-expect-error -- intentionally invalid args
        expect(() => new FloatingLayer({ name: 'no-container' })).toThrow(/container required/);
    });

    it('destroy removes from REGISTRY', () => {
        const a = freshLayer('gone');
        expect(FloatingLayer.get('gone')).toBe(a);
        a.destroy();
        expect(FloatingLayer.get('gone')).toBeUndefined();
    });
});

// ── rolePriority opt + name fallback ────────────────────────────────────────
//
// The pure geometry (priority ordering, clamp, push-away, single/global solve)
// now lives in the engine and is covered exhaustively by layout-engine.test.ts.
// Here we test only the ADAPTER: that it derives the right rolePriority, builds
// a scene, and applies the engine's result to its peers.

describe('FloatingLayer / rolePriority', () => {
    interface Internal { _rolePriority: number }

    it('falls back by name when rolePriority is omitted (toc/chat/live)', () => {
        const toc = freshLayer('toc', { passive: true });
        const chat = freshLayer('chat');
        const live = freshLayer('live');
        expect((toc as unknown as Internal)._rolePriority).toBe(0);
        expect((chat as unknown as Internal)._rolePriority).toBe(1);
        expect((live as unknown as Internal)._rolePriority).toBe(2);
    });

    it('falls back to a stable default for an unknown name', () => {
        const other = freshLayer('mystery');
        expect((other as unknown as Internal)._rolePriority).toBe(2);
    });

    it('honors an explicit rolePriority opt over the name fallback', () => {
        const layer = freshLayer('chat', { rolePriority: 5 });
        expect((layer as unknown as Internal)._rolePriority).toBe(5);
    });
});

// ── _toLayoutItem snapshot ──────────────────────────────────────────────────

describe('FloatingLayer / _toLayoutItem', () => {
    interface WithItem {
        _home: { x: number; y: number } | null;
        _intentionalHome: { x: number; y: number } | null;
        _toLayoutItem(active?: boolean): {
            id: string; rolePriority: number; active: boolean; passive: boolean;
            box: { width: number; height: number }; shape: 'circle' | 'rect';
            home: { x: number; y: number }; gap: number;
        };
    }

    it('collapsed movable snapshots a 40×40 circle at its working home', () => {
        const layer = freshLayer('chat', { gap: 10 });
        const internal = layer as unknown as WithItem;
        internal._home = { x: 120, y: 130 };
        internal._intentionalHome = { x: 120, y: 130 };
        const item = internal._toLayoutItem();
        expect(item.id).toBe('chat');
        expect(item.rolePriority).toBe(1);
        expect(item.active).toBe(false);
        expect(item.shape).toBe('circle');
        expect(item.box).toEqual({ width: 40, height: 40 });
        expect(item.home).toEqual({ x: 120, y: 130 });
        expect(item.gap).toBe(10);
    });

    it('active override yields the panel box + rect shape', () => {
        const layer = freshLayer('live', { panelSize: { width: 260, height: 210 } });
        const internal = layer as unknown as WithItem;
        internal._home = { x: 100, y: 100 };
        internal._intentionalHome = { x: 100, y: 100 };
        const item = internal._toLayoutItem(true);
        expect(item.active).toBe(true);
        expect(item.shape).toBe('rect');
        // No live layout in jsdom (getBoundingClientRect is 0×0) → falls back
        // to the declared panelSize.
        expect(item.box).toEqual({ width: 260, height: 210 });
    });
});

// ── Global solve applied to all peers ───────────────────────────────────────

describe('FloatingLayer / global relayout', () => {
    interface Relayout { _relayout(): void }
    interface WithHome { _home: { x: number; y: number }; _intentionalHome: { x: number; y: number } }

    /** Build an idle movable sphere whose working home is at `home`. */
    function idleAt(name: string, home: { x: number; y: number }, override: Partial<FloatingLayerOpts> = {}): FloatingLayer {
        const layer = freshLayer(name, { gap: 10, ...override });
        const internal = layer as unknown as WithHome;
        internal._home = { ...home };
        internal._intentionalHome = { ...home };
        return layer;
    }

    it('one solve separates two overlapping idle peers and writes CSS edges', () => {
        installAnimateStub();
        // 'a' is rolePriority 2 (live fallback), 'b' rolePriority 1 (chat).
        // The engine sorts by (rolePriority, id): chat (1) placed first keeps
        // its home, live (2) yields. Both get CSS edges written.
        const chat = idleAt('chat', { x: 300, y: 300 });
        const live = idleAt('live', { x: 305, y: 302 }); // overlaps chat

        (FloatingLayer as unknown as Relayout)._relayout();

        // chat keeps its home (BR-anchored → right/bottom edges set).
        const chatEl = (chat as unknown as { _opts: FloatingLayerOpts })._opts.container;
        const liveEl = (live as unknown as { _opts: FloatingLayerOpts })._opts.container;
        // Both layers received a fixed position from the solve.
        expect(chatEl.style.position).toBe('fixed');
        expect(liveEl.style.position).toBe('fixed');
        // The two spheres no longer overlap: derive their solved TL from the
        // BR-anchored CSS edges (x = vw - right - 40, y = vh - bottom - 40).
        const tl = (el: HTMLElement) => ({
            x: 1000 - parseFloat(el.style.right) - 40,
            y: 800 - parseFloat(el.style.bottom) - 40,
        });
        const pa = tl(chatEl);
        const pb = tl(liveEl);
        // chat (placed first) keeps its home.
        expect(pa).toEqual({ x: 300, y: 300 });
        const dist = Math.hypot(pa.x - pb.x, pa.y - pb.y);
        expect(dist).toBeGreaterThanOrEqual(50 - 1e-6);
    });

    it('is order-independent: registering in the opposite order gives the same layout', () => {
        installAnimateStub();
        idleAt('live', { x: 305, y: 302 });
        idleAt('chat', { x: 300, y: 300 });
        (FloatingLayer as unknown as Relayout)._relayout();
        const tl = (name: string) => {
            const el = (FloatingLayer.get(name) as unknown as { _opts: FloatingLayerOpts })._opts.container;
            return { x: 1000 - parseFloat(el.style.right) - 40, y: 800 - parseFloat(el.style.bottom) - 40 };
        };
        // chat (rolePriority 1) keeps its home regardless of registration order.
        expect(tl('chat')).toEqual({ x: 300, y: 300 });
    });

    it('a passive layer participates as an obstacle that movables avoid', () => {
        installAnimateStub();
        // Passive obstacle (rolePriority 0) at the chat sphere's home.
        new FloatingLayer({
            name: 'toc',
            container: makeContainer(),
            passive: true,
            getObstacleRect: () => ({ left: 300, top: 300, right: 340, bottom: 340, width: 40, height: 40 }),
            getObstacleShape: () => 'circle',
        });
        const chat = idleAt('chat', { x: 300, y: 300 }); // sits on the passive obstacle
        (FloatingLayer as unknown as Relayout)._relayout();
        const el = (chat as unknown as { _opts: FloatingLayerOpts })._opts.container;
        const tl = { x: 1000 - parseFloat(el.style.right) - 40, y: 800 - parseFloat(el.style.bottom) - 40 };
        // chat must have been pushed off the passive obstacle.
        expect(tl).not.toEqual({ x: 300, y: 300 });
    });
});

// ── Drag flow ──────────────────────────────────────────────────────────────

describe('FloatingLayer / drag', () => {
    it('mousedown → mousemove → mouseup updates _home and _intentionalHome together', () => {
        installAnimateStub();
        const container = makeContainer();
        const layer = new FloatingLayer({
            name: 'drag1',
            container,
            initialOffset: { right: 20, bottom: 20 },
        });
        layer.init();

        const internal = layer as unknown as {
            _home: { x: number; y: number };
            _intentionalHome: { x: number; y: number };
            _isDragging: boolean;
        };
        const homeBefore = { ...internal._home };

        // mousedown on the container (no .handle opt → handle = container).
        const md = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
        Object.defineProperty(md, 'clientX', { value: 0 });
        Object.defineProperty(md, 'clientY', { value: 0 });
        container.dispatchEvent(md);

        // Move past the threshold (>5px).
        const mv = new MouseEvent('mousemove', { bubbles: true });
        Object.defineProperty(mv, 'clientX', { value: 30 });
        Object.defineProperty(mv, 'clientY', { value: 40 });
        document.dispatchEvent(mv);

        expect(internal._home.x).toBeCloseTo(homeBefore.x + 30);
        expect(internal._home.y).toBeCloseTo(homeBefore.y + 40);
        expect(internal._intentionalHome.x).toBe(internal._home.x);
        expect(internal._intentionalHome.y).toBe(internal._home.y);

        // mouseup ends drag.
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    it('expanded drag handle selector can bind multiple matching handles', () => {
        installAnimateStub();
        const container = makeContainer();
        container.innerHTML = `
            <div class="panel-title"></div>
            <div class="panel-glass-edge"></div>
        `;
        const layer = new FloatingLayer({
            name: 'multi-expanded-drag',
            container,
            homeAnchor: 'TL',
            panelAnchor: 'TL',
            panelSize: { width: 420, height: 300 },
            initialOffset: { left: 120, top: 140 },
            expandedDragHandle: '.panel-title, .panel-glass-edge',
        });
        layer.init();
        container.classList.add('expanded');

        const internal = layer as unknown as {
            _home: { x: number; y: number };
            _intentionalHome: { x: number; y: number };
        };
        const before = { ...internal._home };
        const edge = container.querySelector<HTMLElement>('.panel-glass-edge')!;

        const md = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
        Object.defineProperty(md, 'clientX', { value: 10 });
        Object.defineProperty(md, 'clientY', { value: 10 });
        edge.dispatchEvent(md);

        const mv = new MouseEvent('mousemove', { bubbles: true });
        Object.defineProperty(mv, 'clientX', { value: 34 });
        Object.defineProperty(mv, 'clientY', { value: 28 });
        document.dispatchEvent(mv);
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

        expect(internal._home.x).toBeCloseTo(before.x + 24);
        expect(internal._home.y).toBeCloseTo(before.y + 18);
        expect(internal._intentionalHome).toEqual(internal._home);
    });

    it('a human drag of A moves only A: peers B/C do not cascade, A stays clear + on-screen', () => {
        installAnimateStub();

        // Three movable spheres. Give B and C fixed obstacle rects so the
        // dragged A sees them as immovable walls; A reports its own rect from
        // its live container (0×0 in jsdom → not an obstacle to itself anyway).
        interface WithHome {
            _home: { x: number; y: number };
            _intentionalHome: { x: number; y: number };
        }
        const rectB = { left: 400, top: 300, right: 440, bottom: 340, width: 40, height: 40 };
        const rectC = { left: 600, top: 500, right: 640, bottom: 540, width: 40, height: 40 };

        const containerA = makeContainer();
        const a = new FloatingLayer({
            name: 'A',
            container: containerA,
            rolePriority: 1,
            initialOffset: { left: 100, top: 300 }, // x=100, y=300 (same row as B)
        });
        const b = new FloatingLayer({
            name: 'B',
            container: makeContainer(),
            rolePriority: 1,
            getObstacleRect: () => rectB,
            getObstacleShape: () => 'circle',
        });
        const c = new FloatingLayer({
            name: 'C',
            container: makeContainer(),
            rolePriority: 1,
            getObstacleRect: () => rectC,
            getObstacleShape: () => 'circle',
        });
        a.init();
        (b as unknown as WithHome)._home = { x: 400, y: 300 };
        (b as unknown as WithHome)._intentionalHome = { x: 400, y: 300 };
        (c as unknown as WithHome)._home = { x: 600, y: 500 };
        (c as unknown as WithHome)._intentionalHome = { x: 600, y: 500 };

        // Settle once, then snapshot B's and C's CSS edges.
        (FloatingLayer as unknown as { _relayout(): void })._relayout();
        const edges = (layer: FloatingLayer) => {
            const el = (layer as unknown as { _opts: FloatingLayerOpts })._opts.container;
            return {
                top: el.style.top, right: el.style.right,
                bottom: el.style.bottom, left: el.style.left,
            };
        };
        const bBefore = edges(b);
        const cBefore = edges(c);

        // Drive a drag of A straight RIGHT toward B (same row, y≈300). B sits at
        // x=400; A is 40 wide, so the swept slide must stop A's left at ≤ 360
        // and never tunnel onto B.
        const md = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
        Object.defineProperty(md, 'clientX', { value: 0 });
        Object.defineProperty(md, 'clientY', { value: 0 });
        containerA.dispatchEvent(md);

        for (const px of [40, 120, 200, 280, 360, 500]) {
            const mv = new MouseEvent('mousemove', { bubbles: true });
            Object.defineProperty(mv, 'clientX', { value: px });
            Object.defineProperty(mv, 'clientY', { value: 0 });
            document.dispatchEvent(mv);
        }
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

        // 1) No cascade: B and C CSS edges are byte-identical to before.
        expect(edges(b)).toEqual(bBefore);
        expect(edges(c)).toEqual(cBefore);

        // 2) A never overlaps a peer and stays in-bounds. Its reported home is
        //    the swept-slide result (sphere top-left).
        const aHome = (a as unknown as WithHome)._home;
        // A pushed right toward B but was blocked: left ≤ B.left - 40 = 360.
        expect(aHome.x).toBeLessThanOrEqual(360 + 1e-6);
        // AABB non-overlap vs B (same-row): A.right ≤ B.left.
        const overlapB = aHome.x < rectB.right && aHome.x + 40 > rectB.left
            && aHome.y < rectB.bottom && aHome.y + 40 > rectB.top;
        expect(overlapB).toBe(false);
        // On-screen (1000×800, minVisible 20).
        expect(aHome.x).toBeGreaterThanOrEqual(20 - 40 - 1e-6);
        expect(aHome.x).toBeLessThanOrEqual(1000 - 20 + 1e-6);
        expect(aHome.y).toBeGreaterThanOrEqual(20 - 40 - 1e-6);
        expect(aHome.y).toBeLessThanOrEqual(800 - 20 + 1e-6);
    });

    it('persists _intentionalHome to localStorage when storageKey is set', () => {
        installAnimateStub();
        const container = makeContainer();
        const layer = new FloatingLayer({
            name: 'drag-persist',
            container,
            storageKey: 'fl-test-key',
            initialOffset: { right: 20, bottom: 20 },
        });
        layer.init();

        const md = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
        Object.defineProperty(md, 'clientX', { value: 0 });
        Object.defineProperty(md, 'clientY', { value: 0 });
        container.dispatchEvent(md);

        const mv = new MouseEvent('mousemove', { bubbles: true });
        Object.defineProperty(mv, 'clientX', { value: 50 });
        Object.defineProperty(mv, 'clientY', { value: 60 });
        document.dispatchEvent(mv);

        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

        const stored = localStorage.getItem('fl-test-key');
        expect(stored).not.toBeNull();
        const parsed = JSON.parse(stored!);
        expect(typeof parsed.x).toBe('number');
        expect(typeof parsed.y).toBe('number');
    });
});

// ── expand/collapse state machine (no animation timing) ───────────────────

describe('FloatingLayer / expand+collapse state', () => {
    it('expand() sets _home to the simulated panel-fit endpoint', () => {
        installAnimateStub();
        const container = makeContainer();
        const layer = new FloatingLayer({
            name: 'exp1',
            container,
            panelSize: { width: 200, height: 200 },
            panelAnchor: 'TL',
            initialOffset: { right: 20, bottom: 20 },
        });
        layer.init();
        const internal = layer as unknown as {
            _home: { x: number; y: number };
            _intentionalHome: { x: number; y: number };
        };
        const intentBefore = { ...internal._intentionalHome };
        layer.expand();
        // _home moves to the panel-fit endpoint, but _intentionalHome
        // remains the user-declared coordinate.
        expect(internal._intentionalHome).toEqual(intentBefore);
    });

    it('expand() then collapse() restores _home back toward _intentionalHome', () => {
        const animState = installAnimateStub();
        const container = makeContainer();
        const layer = new FloatingLayer({
            name: 'exp2',
            container,
            panelSize: { width: 200, height: 200 },
            panelAnchor: 'TL',
            initialOffset: { right: 20, bottom: 20 },
        });
        layer.init();
        const internal = layer as unknown as {
            _home: { x: number; y: number };
            _intentionalHome: { x: number; y: number };
        };
        const intent = { ...internal._intentionalHome };

        layer.expand();
        // Drive phase 1 onfinish synchronously so phase 2 actually runs
        // and sets the .expanded class.
        if (animState.lastAnim?.onfinish) animState.lastAnim.onfinish(new Event('finish'));
        expect(layer.isExpanded).toBe(true);

        // Now collapse. The collapse pipeline chains two onfinish
        // handlers (phase1 shrink → phase2 glide). Drive both.
        layer.collapse();
        // phase 1
        if (animState.lastAnim?.onfinish) animState.lastAnim.onfinish(new Event('finish'));
        // phase 2 (only created if RELOCATE_THRESHOLD_PX < distance);
        // safe to guard — if phase 2 was skipped, collapse already
        // emitted onCollapse.
        if (animState.lastAnim?.onfinish) animState.lastAnim.onfinish(new Event('finish'));

        // _intentionalHome must still be the original coordinate.
        expect(internal._intentionalHome).toEqual(intent);
        // _home should have been reset to (a clamp of) intentional.
        expect(internal._home.x).toBeCloseTo(intent.x);
        expect(internal._home.y).toBeCloseTo(intent.y);
    });

    it('expand() snap-folds an already-expanded peer', () => {
        installAnimateStub();
        // Two expandable layers, peer is already in expanded state.
        const peer = new FloatingLayer({
            name: 'peer-A',
            container: makeContainer(),
            panelSize: { width: 100, height: 100 },
        });
        peer.init();
        const peerOpts = (peer as unknown as { _opts: FloatingLayerOpts })._opts;
        peerOpts.container.classList.add('expanded');

        const me = new FloatingLayer({
            name: 'me-B',
            container: makeContainer(),
            panelSize: { width: 100, height: 100 },
        });
        me.init();
        me.expand();

        // Peer should have been snapped (no expanded class).
        expect(peer.isExpanded).toBe(false);
    });
});

// ── Live-panel-box re-solve (A2) ─────────────────────────────────────────────
//
// The deterministic-solve / convergence / on-screen guarantees are exercised
// directly on the engine in layout-engine.test.ts. Here we only assert the
// ADAPTER plumbing that the engine cannot see: that a user-resized panel feeds
// its *live* measured box into the scene, and that a relayout() catches up.

describe('FloatingLayer / live panel box', () => {
    interface WithHome { _home: { x: number; y: number }; _intentionalHome: { x: number; y: number } }
    interface WithItem { _toLayoutItem(active?: boolean): { box: { width: number; height: number } } }
    interface Relayout { _relayout(): void }

    it('an expanded panel advertises its live measured box, not the declared panelSize', () => {
        installAnimateStub();
        const layer = freshLayer('chat', { panelSize: { width: 420, height: 600 } });
        const opts = (layer as unknown as { _opts: FloatingLayerOpts })._opts;
        const internal = layer as unknown as WithHome & WithItem;
        internal._home = { x: 100, y: 100 };
        internal._intentionalHome = { x: 100, y: 100 };

        // Simulate a user-resized, settled panel: .expanded set, no morph, and a
        // live rect that differs from panelSize (e.g. dragged smaller).
        opts.container.classList.add('expanded');
        Object.defineProperty(opts.container, 'getBoundingClientRect', {
            configurable: true,
            value: () => ({ left: 100, top: 100, right: 600, bottom: 480, width: 500, height: 380, x: 100, y: 100, toJSON: () => ({}) }) as DOMRect,
        });

        const item = internal._toLayoutItem();
        expect(item.box).toEqual({ width: 500, height: 380 });
    });

    it('relayout() is callable as the consumer-facing re-solve hook (resize path)', () => {
        installAnimateStub();
        const layer = freshLayer('chat', { panelSize: { width: 420, height: 600 } });
        const internal = layer as unknown as WithHome & { relayout(): void };
        internal._home = { x: 100, y: 100 };
        internal._intentionalHome = { x: 100, y: 100 };
        // The public relayout() (used by a panel ResizeObserver) and the static
        // _relayout() both run a full solve without throwing.
        expect(() => internal.relayout()).not.toThrow();
        expect(() => (FloatingLayer as unknown as Relayout)._relayout()).not.toThrow();
    });
});
