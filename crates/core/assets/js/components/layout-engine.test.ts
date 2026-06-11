// @vitest-environment node
//
// Pure-engine tests. No jsdom, no WAAPI stubs, no DOM — the engine is a free
// function over plain data, so these run in the Node environment and exercise
// determinism, convergence, and stability directly.

import { describe, expect, it } from 'vitest';
import {
    SPHERE_SIZE,
    clamp,
    overlaps,
    place,
    rectAt,
    solve,
    type LayoutItem,
    type Obstacle,
    type Point,
    type Scene,
} from './layout-engine';

const VIEWPORT = { width: 1000, height: 800 };
const MARGINS = { minVisible: 20, panelInset: 8 };

/** A 40×40 idle sphere at `home`. */
function sphere(id: string, home: Point, override: Partial<LayoutItem> = {}): LayoutItem {
    return {
        id,
        rolePriority: 2,
        active: false,
        passive: false,
        home,
        homeAnchor: 'BR',
        panelAnchor: 'BR',
        box: { width: SPHERE_SIZE, height: SPHERE_SIZE },
        shape: 'circle',
        gap: 10,
        ...override,
    };
}

/** An active (expanded) panel anchored TL at `home`, growing down-right. */
function panel(
    id: string,
    home: Point,
    size: { width: number; height: number },
    override: Partial<LayoutItem> = {},
): LayoutItem {
    return {
        id,
        rolePriority: 1,
        active: true,
        passive: false,
        home,
        homeAnchor: 'TL',
        panelAnchor: 'TL',
        box: size,
        shape: 'rect',
        gap: 10,
        ...override,
    };
}

/** A fixed passive rect obstacle, placed at `home` with TL anchor so its rect
 *  is exactly the box at home. */
function passiveRect(id: string, r: { left: number; top: number; width: number; height: number }): LayoutItem {
    return {
        id,
        rolePriority: 0,
        active: false,
        passive: true,
        home: { x: r.left, y: r.top },
        homeAnchor: 'TL',
        panelAnchor: 'TL',
        box: { width: r.width, height: r.height },
        shape: 'rect',
        gap: 10,
    };
}

function makeScene(items: LayoutItem[]): Scene {
    return { viewport: VIEWPORT, items, margins: MARGINS };
}

/** Effective rect of a solved item at its placement, for overlap checks. */
function rectFor(item: LayoutItem, pos: Point) {
    return rectAt(item, pos);
}

/** Deterministic shuffle driven by index arithmetic (NOT Math.random) so the
 *  permutation is reproducible across runs. Rotates by `offset`. */
function rotate<T>(arr: T[], offset: number): T[] {
    const n = arr.length;
    return arr.map((_, i) => arr[(i + offset) % n]);
}

// ── 1. Determinism ──────────────────────────────────────────────────────────

describe('layout-engine / determinism', () => {
    it('shuffled input order yields identical solve output', () => {
        const items = [
            sphere('a', { x: 200, y: 200 }),
            sphere('b', { x: 210, y: 205 }), // overlaps a
            sphere('c', { x: 600, y: 400 }),
            passiveRect('toc', { left: 800, top: 600, width: 120, height: 120 }),
        ];
        const baseline = solve(makeScene(items));

        // Every rotation is the same scene with items in a different order.
        for (let offset = 1; offset < items.length; offset++) {
            const shuffled = solve(makeScene(rotate(items, offset)));
            // Sort both by id for a stable comparison (output order follows
            // placement order, but the per-id positions must be identical).
            const byId = (ps: typeof baseline) =>
                [...ps].sort((p, q) => (p.id < q.id ? -1 : 1));
            expect(byId(shuffled)).toEqual(byId(baseline));
        }
    });

    it('solve is idempotent: feeding placements back as homes is a fixed point', () => {
        const items = [sphere('a', { x: 300, y: 300 }), sphere('b', { x: 305, y: 302 })];
        const first = solve(makeScene(items));
        const next = items.map((it) => ({
            ...it,
            home: first.find((p) => p.id === it.id)!.pos,
        }));
        const second = solve(makeScene(next));
        for (const p of first) {
            expect(second.find((q) => q.id === p.id)!.pos).toEqual(p.pos);
        }
    });
});

// ── 2. Symmetric idle peers ──────────────────────────────────────────────────

describe('layout-engine / idle peers', () => {
    it('two same-priority idle peers → id-earlier keeps home, no overlap', () => {
        const a = sphere('a', { x: 300, y: 300 });
        const b = sphere('b', { x: 305, y: 302 }); // overlaps a
        const out = solve(makeScene([a, b]));
        const pa = out.find((p) => p.id === 'a')!.pos;
        const pb = out.find((p) => p.id === 'b')!.pos;

        // a (id-earlier, placed first) keeps its home; b yields.
        expect(pa).toEqual({ x: 300, y: 300 });
        expect(pa).not.toEqual(pb);

        // No residual overlap: centers ≥ sumRadii + gap (= 20+20+10) apart.
        const dist = Math.hypot(pa.x + 20 - (pb.x + 20), pa.y + 20 - (pb.y + 20));
        expect(dist).toBeGreaterThanOrEqual(50 - 1e-6);

        // overlaps() agrees there is no contact.
        expect(overlaps(rectFor(a, pa), 'circle', rectFor(b, pb), 'circle', 10)).toBe(false);
    });
});

// ── 3. Squeezed between two obstacles ────────────────────────────────────────

describe('layout-engine / squeeze convergence', () => {
    it('a sphere wedged between two walls converges with no residual overlap', () => {
        const wallL = passiveRect('wallL', { left: 100, top: 100, width: 200, height: 400 });
        const wallR = passiveRect('wallR', { left: 340, top: 100, width: 200, height: 400 });
        const s = sphere('squeezed', { x: 300, y: 280 }); // wedged near the gap
        const out = solve(makeScene([wallL, wallR, s]));
        const pos = out.find((p) => p.id === 'squeezed')!.pos;

        const cx = pos.x + 20;
        const cy = pos.y + 20;
        const r = 20;
        const gap = 10;
        const clears = (rect: { left: number; top: number; right: number; bottom: number }) => {
            const closestX = Math.max(rect.left, Math.min(cx, rect.right));
            const closestY = Math.max(rect.top, Math.min(cy, rect.bottom));
            return Math.hypot(cx - closestX, cy - closestY) >= r + gap - 1e-6;
        };
        expect(clears({ left: 100, top: 100, right: 300, bottom: 500 })).toBe(true);
        expect(clears({ left: 340, top: 100, right: 540, bottom: 500 })).toBe(true);
    });
});

// ── 4. Expanded panel clamped at a viewport edge ─────────────────────────────

describe('layout-engine / panel clamp', () => {
    it('an overflowing panel is clamped inside, never off-screen, no rebound into obstacle', () => {
        const block = passiveRect('block', { left: 700, top: 600, width: 60, height: 60 });
        const p = panel('panel', { x: 760, y: 600 }, { width: 300, height: 250 });
        const out = solve(makeScene([block, p]));
        const pos = out.find((x) => x.id === 'panel')!.pos;

        // Panel rect at the solved position (TL anchor: sphere TL = panel TL).
        const pr = rectAt(p, pos);
        // On-screen (viewport 1000×800).
        expect(pr.left).toBeGreaterThanOrEqual(-1);
        expect(pr.top).toBeGreaterThanOrEqual(-1);
        expect(pr.right).toBeLessThanOrEqual(1001);
        expect(pr.bottom).toBeLessThanOrEqual(801);

        // Must NOT overlap the passive block after clamping.
        const blockRect = rectAt(block, block.home);
        expect(overlaps(pr, 'rect', blockRect, 'rect', 10)).toBe(false);
    });

    it('clamp keeps a panel inside the panelInset margin', () => {
        const p = panel('p', { x: 900, y: 700 }, { width: 300, height: 200 });
        const out = clamp(p, { x: 900, y: 700 }, { viewport: VIEWPORT, margins: MARGINS });
        const rect = rectAt(p, out);
        // panelInset = 8 → panel right ≤ 992, bottom ≤ 792.
        expect(rect.right).toBeLessThanOrEqual(1000 - MARGINS.panelInset + 1e-6);
        expect(rect.bottom).toBeLessThanOrEqual(800 - MARGINS.panelInset + 1e-6);
    });
});

// ── 5. Stability under a small perturbation ──────────────────────────────────

describe('layout-engine / stability', () => {
    it('moving one item home by δ moves its placement by ~δ (no large jumps)', () => {
        // A lone sphere with no obstacles: its placement equals its home, so a
        // small home delta produces an equal placement delta.
        const obstacles: Obstacle[] = [];
        const base = sphere('s', { x: 400, y: 400 });
        const p0 = place(base, obstacles, { viewport: VIEWPORT, margins: MARGINS });
        for (const delta of [1, 2, 3, 5]) {
            const moved = sphere('s', { x: 400 + delta, y: 400 + delta });
            const p1 = place(moved, obstacles, { viewport: VIEWPORT, margins: MARGINS });
            const jump = Math.hypot(p1.x - p0.x, p1.y - p0.y);
            const moveSize = Math.hypot(delta, delta);
            // Placement moves by approximately the same amount (Lipschitz with
            // a small constant) — never a large discontinuous jump.
            expect(jump).toBeLessThanOrEqual(moveSize + 1e-6);
        }
    });

    it('a non-contacting peer tracks its home 1:1 as it drifts by δ', () => {
        // Two peers far enough apart that neither pushes the other: each one's
        // placement equals its home, so a small home δ yields an equal
        // placement δ — fully Lipschitz across the whole drift.
        const a = sphere('a', { x: 300, y: 300 });
        let prevB: Point | null = null;
        for (let step = 0; step < 6; step++) {
            const b = sphere('b', { x: 500 + step, y: 500 + step });
            const out = solve(makeScene([a, b]));
            const pb = out.find((p) => p.id === 'b')!.pos;
            expect(pb).toEqual({ x: 500 + step, y: 500 + step });
            if (prevB) {
                const jump = Math.hypot(pb.x - prevB.x, pb.y - prevB.y);
                expect(jump).toBeCloseTo(Math.SQRT2, 6); // δ = (1, 1)
            }
            prevB = pb;
        }
    });

    it('static rolePriority means a peer\'s tiny drag never moves the id-earlier item', () => {
        // The key anti-drift guarantee from the design: rolePriority is a
        // static sort key, so nudging the id-later peer (even right up against
        // the id-earlier one) never reorders placement. The id-earlier peer is
        // placed first against an empty obstacle set and therefore stays
        // anchored at its home — rock-stable regardless of the peer's motion.
        const a = sphere('a', { x: 300, y: 300 });
        for (let step = 0; step < 6; step++) {
            const b = sphere('b', { x: 305 + step, y: 302 + step });
            const out = solve(makeScene([a, b]));
            const pa = out.find((p) => p.id === 'a')!.pos;
            expect(pa).toEqual({ x: 300, y: 300 });
        }
    });
});

// ── 6. Property-style invariants (seeded by index arithmetic) ────────────────

describe('layout-engine / properties', () => {
    // A simple deterministic LCG so "randomized" inputs are reproducible
    // without Math.random. Seeded per case from the loop index.
    function lcg(seed: number): () => number {
        let s = (seed * 2654435761) % 2147483647;
        if (s <= 0) s += 2147483646;
        return () => {
            s = (s * 16807) % 2147483647;
            return (s - 1) / 2147483646; // (0, 1)
        };
    }

    it('no two solved items overlap (≤3 movables + a passive obstacle)', () => {
        for (let seed = 1; seed <= 40; seed++) {
            const rnd = lcg(seed);
            const items: LayoutItem[] = [
                passiveRect('toc', {
                    left: Math.floor(rnd() * 600),
                    top: Math.floor(rnd() * 400),
                    width: 80 + Math.floor(rnd() * 80),
                    height: 80 + Math.floor(rnd() * 80),
                }),
                sphere('chat', { x: Math.floor(rnd() * 900), y: Math.floor(rnd() * 700) }, { rolePriority: 1 }),
                sphere('live', { x: Math.floor(rnd() * 900), y: Math.floor(rnd() * 700) }, { rolePriority: 2 }),
            ];
            const out = solve(makeScene(items));
            const byId = new Map(out.map((p) => [p.id, p.pos]));

            // Build the full obstacle set (passive at home + solved movables).
            const placedRects = items.map((it) => {
                const pos = it.passive ? it.home : byId.get(it.id)!;
                return { it, rect: rectAt(it, pos) };
            });

            for (let i = 0; i < placedRects.length; i++) {
                for (let j = i + 1; j < placedRects.length; j++) {
                    const A = placedRects[i];
                    const B = placedRects[j];
                    const gap = Math.min(A.it.gap, B.it.gap);
                    // Allow a 1px tolerance for the tight-scene fallback that
                    // returns the least-overlap on-screen point.
                    const hard = overlaps(A.rect, A.it.shape, B.rect, B.it.shape, gap - 1);
                    expect(hard, `seed ${seed}: ${A.it.id} vs ${B.it.id}`).toBe(false);
                }
            }
        }
    });

    it('every solved placement keeps the item on-screen', () => {
        for (let seed = 1; seed <= 40; seed++) {
            const rnd = lcg(seed);
            const items: LayoutItem[] = [
                passiveRect('toc', {
                    left: Math.floor(rnd() * 700),
                    top: Math.floor(rnd() * 500),
                    width: 100,
                    height: 100,
                }),
                sphere('s1', { x: Math.floor(rnd() * 2000) - 500, y: Math.floor(rnd() * 1600) - 400 }, { rolePriority: 1 }),
                panel('p1', { x: Math.floor(rnd() * 2000) - 500, y: Math.floor(rnd() * 1600) - 400 }, { width: 260, height: 210 }, { rolePriority: 2 }),
            ];
            const out = solve(makeScene(items));
            for (const p of out) {
                const it = items.find((x) => x.id === p.id)!;
                // Sphere TL keeps ≥ minVisible visible on each side.
                expect(p.pos.x, `seed ${seed}: ${p.id} x`).toBeGreaterThanOrEqual(MARGINS.minVisible - SPHERE_SIZE - 1e-6);
                expect(p.pos.x).toBeLessThanOrEqual(VIEWPORT.width - MARGINS.minVisible + 1e-6);
                expect(p.pos.y).toBeGreaterThanOrEqual(MARGINS.minVisible - SPHERE_SIZE - 1e-6);
                expect(p.pos.y).toBeLessThanOrEqual(VIEWPORT.height - MARGINS.minVisible + 1e-6);
                // Active panels stay within the viewport bounds entirely.
                if (it.active && it.shape === 'rect') {
                    const rect = rectAt(it, p.pos);
                    expect(rect.left).toBeGreaterThanOrEqual(-1);
                    expect(rect.top).toBeGreaterThanOrEqual(-1);
                    expect(rect.right).toBeLessThanOrEqual(VIEWPORT.width + 1);
                    expect(rect.bottom).toBeLessThanOrEqual(VIEWPORT.height + 1);
                }
            }
        }
    });
});
