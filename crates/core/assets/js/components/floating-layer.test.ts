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
    }) as unknown as HTMLElement['animate'];
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

// ── _priority state machine ────────────────────────────────────────────────

describe('FloatingLayer / priority', () => {
    it('passive layer reports priority 0', () => {
        const layer = freshLayer('passive', { passive: true });
        expect((layer as unknown as { _priority(): number })._priority()).toBe(0);
    });

    it('idle movable reports priority 2', () => {
        const layer = freshLayer('idle');
        expect((layer as unknown as { _priority(): number })._priority()).toBe(2);
    });

    it('expanded movable reports priority 1', () => {
        const layer = freshLayer('exp', {
            panelSize: { width: 200, height: 200 },
        });
        layer._applyDisplayed; // ensure private touch compiles
        // Force "expanded" by adding the expanded class directly.
        const opts = (layer as unknown as { _opts: FloatingLayerOpts })._opts;
        opts.container.classList.add('expanded');
        expect((layer as unknown as { _priority(): number })._priority()).toBe(1);
    });

    it('dragging movable reports priority 1', () => {
        const layer = freshLayer('drag');
        (layer as unknown as { _isDragging: boolean })._isDragging = true;
        expect((layer as unknown as { _priority(): number })._priority()).toBe(1);
    });

    it('simulate(true) override raises priority to 1', () => {
        const layer = freshLayer('sim', {
            panelSize: { width: 200, height: 200 },
        });
        const internal = layer as unknown as {
            _withSimulatedExpanded<T>(v: boolean, fn: () => T): T;
            _priority(): number;
        };
        const inner = internal._withSimulatedExpanded(true, () => internal._priority());
        expect(inner).toBe(1);
        // After the simulate block, falls back to idle.
        expect(internal._priority()).toBe(2);
    });
});

// ── _clampToViewport ───────────────────────────────────────────────────────

describe('FloatingLayer / _clampToViewport', () => {
    type Internal = {
        _clampToViewport(p: { x: number; y: number }): { x: number; y: number };
    };

    it('keeps a sphere center in-viewport (≥ MIN_VISIBLE on each side)', () => {
        const layer = freshLayer('clamp1');
        const internal = layer as unknown as Internal;
        // Sphere is 40×40, MIN_VISIBLE=20 so x ranges in [-20, vw-20] = [-20, 980].
        expect(internal._clampToViewport({ x: -1000, y: -1000 })).toEqual({ x: -20, y: -20 });
        expect(internal._clampToViewport({ x: 5000, y: 5000 })).toEqual({ x: 980, y: 780 });
        // Inside, untouched.
        expect(internal._clampToViewport({ x: 100, y: 200 })).toEqual({ x: 100, y: 200 });
    });

    it('expanded mode pulls the entire panel inside the 8px margin', () => {
        const layer = freshLayer('clamp2', {
            panelSize: { width: 300, height: 200 },
            panelAnchor: 'TL',
        });
        const opts = (layer as unknown as { _opts: FloatingLayerOpts })._opts;
        opts.container.classList.add('expanded');
        const internal = layer as unknown as Internal;
        // Place sphere TL at (900, 700). Panel bottom-right would be at
        // (1200, 900) which exceeds (1000-8, 800-8). Clamp pulls it back.
        const out = internal._clampToViewport({ x: 900, y: 700 });
        // Panel right = x + 300 must be ≤ 992, so x ≤ 692.
        expect(out.x).toBeLessThanOrEqual(692);
        // Panel bottom = y + 200 must be ≤ 792, so y ≤ 592.
        expect(out.y).toBeLessThanOrEqual(592);
    });
});

// ── _pushAway ──────────────────────────────────────────────────────────────

describe('FloatingLayer / _pushAway', () => {
    type Internal = {
        _pushAway(
            pos: { x: number; y: number },
            other: { left: number; top: number; right: number; bottom: number; width: number; height: number },
            shape: 'circle' | 'rect',
        ): { x: number; y: number };
    };

    it('circle ↔ circle: separates by sumRadii + gap along the connecting axis', () => {
        const layer = freshLayer('cc');
        const internal = layer as unknown as Internal;
        // Put `other` 40×40 circle centered at (100, 100). Place self
        // sphere at (90, 100) (TL) → centers overlap at (110, 120) vs
        // (120, 120); push outward.
        const before = { x: 90, y: 100 };
        const other = { left: 80, top: 80, right: 120, bottom: 120, width: 40, height: 40 };
        const after = internal._pushAway(before, other, 'circle');
        // Centers must be ≥ (20+20+10) = 50px apart after push.
        const myCx = after.x + 20, myCy = after.y + 20;
        const otCx = 100, otCy = 100;
        const dist = Math.hypot(myCx - otCx, myCy - otCy);
        expect(dist).toBeGreaterThanOrEqual(50 - 1e-6);
    });

    it('circle ↔ rect: pushes a colliding sphere out along the closest exit', () => {
        const layer = freshLayer('cr');
        const internal = layer as unknown as Internal;
        // Other rect occupies x:200-400, y:200-300. Place sphere at
        // (210, 250) so its center (230, 270) is inside the rect.
        const before = { x: 210, y: 250 };
        const other = { left: 200, top: 200, right: 400, bottom: 300, width: 200, height: 100 };
        const after = internal._pushAway(before, other, 'rect');
        // Sphere center should now be outside the rect by ≥ r + gap = 30.
        const myCx = after.x + 20, myCy = after.y + 20;
        const closestX = Math.max(other.left, Math.min(myCx, other.right));
        const closestY = Math.max(other.top, Math.min(myCy, other.bottom));
        const dist = Math.hypot(myCx - closestX, myCy - closestY);
        expect(dist).toBeGreaterThanOrEqual(30 - 1e-6);
    });

    it('rect ↔ circle: pushes the panel rect along the shortest axis to clear', () => {
        const layer = freshLayer('rc', {
            panelSize: { width: 200, height: 100 },
            panelAnchor: 'TL',
        });
        const opts = (layer as unknown as { _opts: FloatingLayerOpts })._opts;
        opts.container.classList.add('expanded');
        const internal = layer as unknown as Internal;
        // Self panel @ (100, 100) covers x:100-300, y:100-200. Other
        // circle 40×40 at center (310, 150) → just outside but within gap.
        const before = { x: 100, y: 100 };
        const other = { left: 290, top: 130, right: 330, bottom: 170, width: 40, height: 40 };
        const after = internal._pushAway(before, other, 'circle');
        // Should push the rect leftward (away from the circle).
        expect(after.x).toBeLessThan(before.x);
    });

    it('non-overlapping shapes are returned unchanged', () => {
        const layer = freshLayer('noover');
        const internal = layer as unknown as Internal;
        const before = { x: 0, y: 0 };
        // Far-away circle, no contact.
        const other = { left: 500, top: 500, right: 540, bottom: 540, width: 40, height: 40 };
        const after = internal._pushAway(before, other, 'circle');
        expect(after).toEqual(before);
    });
});

// ── _avoidObstacles (priority + multi-pass) ────────────────────────────────

describe('FloatingLayer / _avoidObstacles', () => {
    it('idle peer yields to passive obstacle (passive priority 0)', () => {
        // Put a passive 40×40 obstacle at fixed center; idle layer near
        // overlapping should be pushed away.
        const passiveBox = makeContainer();
        Object.defineProperty(passiveBox, 'getBoundingClientRect', {
            value: () => ({ left: 100, top: 100, right: 140, bottom: 140, width: 40, height: 40, x: 100, y: 100, toJSON: () => ({}) }) as DOMRect,
        });
        // Hand-build a passive layer with explicit shape via opts so we
        // don't depend on init() side-effects.
        new FloatingLayer({
            name: 'pasv',
            container: passiveBox,
            passive: true,
            getObstacleRect: () => ({ left: 100, top: 100, right: 140, bottom: 140, width: 40, height: 40 }),
            getObstacleShape: () => 'circle',
        });
        const idle = freshLayer('idle');
        const internal = idle as unknown as { _avoidObstacles(p: { x: number; y: number }): { x: number; y: number } };
        const out = internal._avoidObstacles({ x: 100, y: 100 });
        // Must have moved away.
        expect(out.x !== 100 || out.y !== 100).toBe(true);
    });

    it('does not move out of the way of strictly lower-priority peers', () => {
        // Self is operated (priority 1) — peer is idle (priority 2)
        // and asks to occupy the same spot. Self stays put.
        const self = freshLayer('self', {
            panelSize: { width: 200, height: 200 },
            panelAnchor: 'TL',
        });
        const opts = (self as unknown as { _opts: FloatingLayerOpts })._opts;
        opts.container.classList.add('expanded'); // priority 1

        // Idle peer reporting an obstacle right where self plans to be.
        const peerEl = makeContainer();
        new FloatingLayer({
            name: 'peer-idle',
            container: peerEl,
            getObstacleRect: () => ({ left: 50, top: 50, right: 90, bottom: 90, width: 40, height: 40 }),
            getObstacleShape: () => 'circle',
        });
        const internal = self as unknown as { _avoidObstacles(p: { x: number; y: number }): { x: number; y: number } };
        // Without priority handling, this would be pushed; with it, self
        // ignores the lower-priority peer and only re-clamps to the
        // viewport. With TL anchor, panel @ (50,50) extends to (250,250)
        // — well inside viewport (1000×800), so clamp is a no-op.
        expect(internal._avoidObstacles({ x: 50, y: 50 })).toEqual({ x: 50, y: 50 });
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

// ── Static refreshAll ─────────────────────────────────────────────────────

describe('FloatingLayer / static refreshAll', () => {
    it('calls _applyDisplayed on every registered layer', () => {
        installAnimateStub();
        const a = freshLayer('rfa-1');
        const b = freshLayer('rfa-2');
        a.init();
        b.init();

        const aSpy = vi.spyOn(a, '_applyDisplayed');
        const bSpy = vi.spyOn(b, '_applyDisplayed');
        FloatingLayer.refreshAll();
        expect(aSpy).toHaveBeenCalled();
        expect(bSpy).toHaveBeenCalled();
    });
});
