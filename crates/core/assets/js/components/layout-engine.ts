// layout-engine — pure, DOM-free, synchronous, deterministic layout solver.
//
// This module owns the geometry that decides where each floating layer's
// sphere top-left ends up so multiple spheres/panels never overlap. It is the
// extracted, purified core of FloatingLayer's former `_solveLayout` /
// `_resolveAgainst` / push-away helpers — same math, but de-`this`-ed and
// parameterized: it reads no `window`, no `document`, no `localStorage`, no
// clock, no RNG, and never depends on Map/Set iteration order. Given the same
// {@link Scene} (even with `items` in any order) it returns byte-identical
// {@link Placement}s.
//
// The adapter (FloatingLayer) is responsible for everything impure: reading
// DOM rects / viewport size, choosing the box/shape per item, driving morph
// animations, persisting positions, and writing CSS edges. The engine only
// takes numbers and returns numbers.
//
// Coordinate model: every position is a sphere top-left in screen-space
// absolute coordinates. A panel grows from the sphere's panel-anchor corner,
// so an item's effective rect is derived from its sphere position + box +
// panelAnchor (see {@link rectAt}).

/** Viewport corner anchor. */
export type Anchor = 'TL' | 'TR' | 'BL' | 'BR';

/** Collision shape: a 40×40 sphere is a circle, a panel is a rect. */
export type Shape = 'circle' | 'rect';

/** A 2D point used for sphere top-left coordinates. */
export interface Point {
    x: number;
    y: number;
}

/** Box-shape rect with both edges and dimensions; mirrors {@link DOMRect}. */
export interface BoxRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
}

/** Sphere side length, in px. A box of exactly this size on both axes is a
 *  circle; anything else is a rect. Kept in sync with FloatingLayer. */
export const SPHERE_SIZE = 40;

// Iterative pushAway can ping-pong when an item is squeezed between two
// obstacles (push out of A overlaps B, push out of B overlaps A). 8 passes
// give the relaxation enough rounds to converge in practice; the explicit
// post-pass overlap check + deterministic ring search in {@link place} handle
// the cases where it still hasn't.
const COLLISION_PASSES = 8;

/** A floating item's declarative description (the adapter snapshots one of
 *  these before every solve). Pure data — no methods, no DOM handles. */
export interface LayoutItem {
    /** Stable unique key. Decides the sort tie-break. */
    id: string;
    /** Product role priority, a STATIC constant that does NOT vary with DOM
     *  state. Convention: 0 = ToC (passive) < 1 = Chat < 2 = Live. Lower
     *  number wins (pushes others, yields to none below it). */
    rolePriority: number;
    /** Whether this item is "activated" (expanded / dragging / mid-morph).
     *  Affects which box/shape it occupies, but NOT the sort order. */
    active: boolean;
    /** Fixed obstacle: when true the engine only treats it as an obstacle and
     *  never solves a position for it (ToC). */
    passive: boolean;
    /** The user-declared sphere top-left (screen-space). Ignored for passive
     *  items (use {@link LayoutItem.box} placement via {@link obstacleRect}). */
    home: Point;
    /** Home viewport corner — idle queue direction and panel growth direction. */
    homeAnchor: Anchor;
    /** Corner of the panel where the sphere sits (panel grows from here). */
    panelAnchor: Anchor;
    /** Current occupancy box (sphere = 40×40; expanded = measured panel size).
     *  Snapshotted by the adapter — the engine just consumes the dimensions. */
    box: { width: number; height: number };
    /** Occupancy shape: 40×40 → circle, otherwise rect. Computed by the adapter. */
    shape: Shape;
    /** Minimum clearance between this item and any other obstacle (covers
     *  shadow blur). */
    gap: number;
}

/** Full scene description handed to {@link solve}. */
export interface Scene {
    viewport: { width: number; height: number };
    items: LayoutItem[];
    /** `minVisible`: minimum sphere pixels kept on-screen.
     *  `panelInset`: margin a panel is pulled inside the viewport edges. */
    margins: { minVisible: number; panelInset: number };
}

/** One solved sphere top-left, keyed by item id. */
export interface Placement {
    id: string;
    pos: Point;
}

/** An obstacle the solver places items against. `id` + `rolePriority` give a
 *  STABLE ordering key so the solve never depends on input order. */
export interface Obstacle {
    id: string;
    rolePriority: number;
    rect: BoxRect;
    shape: Shape;
}

const rectFromBox = (left: number, top: number, w: number, h: number): BoxRect => ({
    left,
    top,
    right: left + w,
    bottom: top + h,
    width: w,
    height: h,
});

/** Stable obstacle ordering: highest priority first (lowest number), then by
 *  id. Deterministic regardless of how the list was assembled. */
function sortObstacles(list: Obstacle[]): Obstacle[] {
    return list.sort((a, b) =>
        a.rolePriority - b.rolePriority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

/**
 * The item's effective rect for a given sphere top-left position. A collapsed
 * (sphere) item occupies a 40×40 box at `pos`; an active panel grows from the
 * sphere's {@link LayoutItem.panelAnchor} corner outward, using `item.box`.
 *
 * Pure geometry; the purified form of the former `_effectiveRectAt`.
 */
export function rectAt(item: LayoutItem, pos: Point): BoxRect {
    if (item.shape === 'circle') {
        return rectFromBox(pos.x, pos.y, SPHERE_SIZE, SPHERE_SIZE);
    }
    const { width: W, height: H } = item.box;
    const a = item.panelAnchor;
    const left = a === 'TL' || a === 'BL' ? pos.x : pos.x + SPHERE_SIZE - W;
    const top = a === 'TL' || a === 'TR' ? pos.y : pos.y + SPHERE_SIZE - H;
    return rectFromBox(left, top, W, H);
}

/**
 * Clamp a sphere top-left into the viewport. The sphere always keeps at least
 * `margins.minVisible` px visible on each side; an active panel additionally
 * has its whole rect pulled inside a `margins.panelInset` margin so its
 * content stays readable.
 *
 * The purified form of the former `_clampToViewport`: viewport dimensions and
 * margins are explicit parameters rather than `window.inner*` / `_opts`.
 */
export function clamp(
    item: LayoutItem,
    pos: Point,
    scene: Pick<Scene, 'viewport' | 'margins'>,
): Point {
    const vw = scene.viewport.width;
    const vh = scene.viewport.height;
    const minVisible = scene.margins.minVisible;

    let cx = Math.max(minVisible - SPHERE_SIZE, Math.min(Number(pos.x) || 0, vw - minVisible));
    let cy = Math.max(minVisible - SPHERE_SIZE, Math.min(Number(pos.y) || 0, vh - minVisible));

    if (item.active && item.shape === 'rect') {
        const inset = scene.margins.panelInset;
        const rect = rectAt(item, { x: cx, y: cy });
        if (rect.right > vw - inset) cx -= rect.right - (vw - inset);
        if (rect.bottom > vh - inset) cy -= rect.bottom - (vh - inset);
        // Re-apply top/left floors: after the pulls above, a panel larger than
        // the viewport may now poke off the top/left edge (rare, tiny windows).
        const rect2 = rectAt(item, { x: cx, y: cy });
        if (rect2.left < inset) cx += inset - rect2.left;
        if (rect2.top < inset) cy += inset - rect2.top;
    }
    return { x: cx, y: cy };
}

/**
 * Shape-aware overlap test with `gap` clearance between two effective rects.
 * The purified form of the former `_overlapsRect`.
 */
export function overlaps(
    a: BoxRect,
    aShape: Shape,
    b: BoxRect,
    bShape: Shape,
    gap: number,
): boolean {
    if (aShape === 'circle' && bShape === 'circle') {
        const aR = SPHERE_SIZE / 2;
        const bR = Math.min(b.width, b.height) / 2;
        const aCx = a.left + aR;
        const aCy = a.top + aR;
        const bCx = b.left + b.width / 2;
        const bCy = b.top + b.height / 2;
        return Math.hypot(aCx - bCx, aCy - bCy) < aR + bR + gap;
    }
    if (aShape === 'circle') {
        const aR = SPHERE_SIZE / 2;
        const cx = a.left + aR;
        const cy = a.top + aR;
        const closestX = Math.max(b.left, Math.min(cx, b.right));
        const closestY = Math.max(b.top, Math.min(cy, b.bottom));
        return Math.hypot(cx - closestX, cy - closestY) < aR + gap;
    }
    if (bShape === 'circle') {
        const bR = Math.min(b.width, b.height) / 2;
        const bCx = b.left + b.width / 2;
        const bCy = b.top + b.height / 2;
        const closestX = Math.max(a.left, Math.min(bCx, a.right));
        const closestY = Math.max(a.top, Math.min(bCy, a.bottom));
        return Math.hypot(bCx - closestX, bCy - closestY) < bR + gap;
    }
    // rect-rect with gap (no overlap if a gap-wide strip separates the rects on any axis)
    return !(
        a.right + gap <= b.left ||
        b.right + gap <= a.left ||
        a.bottom + gap <= b.top ||
        b.bottom + gap <= a.top
    );
}

/** Does `pos` overlap any of `obstacles`? Yes/no only — no displacement. */
function overlapsAny(item: LayoutItem, pos: Point, obstacles: ReadonlyArray<Obstacle>): boolean {
    const my = rectAt(item, pos);
    for (const ob of obstacles) {
        if (overlaps(my, item.shape, ob.rect, ob.shape, item.gap)) return true;
    }
    return false;
}

/**
 * Total overlap "area" of `pos` against `obstacles` — used only to pick the
 * least-bad on-screen fallback when no fully-clear slot exists. Approximated
 * as summed AABB intersection area of the effective rects (with `gap` margin).
 * The purified form of the former `_overlapScore`.
 */
function overlapScore(item: LayoutItem, pos: Point, obstacles: ReadonlyArray<Obstacle>): number {
    const my = rectAt(item, pos);
    const gap = item.gap;
    let area = 0;
    for (const ob of obstacles) {
        const ix = Math.min(my.right + gap, ob.rect.right) - Math.max(my.left - gap, ob.rect.left);
        const iy = Math.min(my.bottom + gap, ob.rect.bottom) - Math.max(my.top - gap, ob.rect.top);
        if (ix > 0 && iy > 0) area += ix * iy;
    }
    return area;
}

/** Push a circle out of a rect with `gap` clearance. `mapCenter` projects the
 *  resulting circle center back to the caller's coord shape. When the circle's
 *  center sits inside the rect, the four edge exits are ranked first by whether
 *  they keep the circle on-screen, then by smallest displacement — otherwise a
 *  sphere overlapped by an opening panel can pop off the viewport edge when the
 *  only on-screen exit is leftward.
 *
 *  The purified form of the former free function `circleAwayFromRect`: the
 *  viewport is an explicit parameter rather than `window.inner*`. */
function circleAwayFromRect(
    cx: number,
    cy: number,
    r: number,
    rect: BoxRect,
    gap: number,
    viewport: { width: number; height: number },
    mapCenter: (newCx: number, newCy: number) => Point,
): Point {
    const closestX = Math.max(rect.left, Math.min(cx, rect.right));
    const closestY = Math.max(rect.top, Math.min(cy, rect.bottom));
    const dx = cx - closestX;
    const dy = cy - closestY;
    const dist = Math.hypot(dx, dy);
    const minDist = r + gap;

    if (dist === 0) {
        const vw = viewport.width;
        const vh = viewport.height;
        const fits = (x: number, y: number): boolean =>
            x - r >= 0 && x + r <= vw && y - r >= 0 && y + r <= vh;
        const candidates = [
            { newCx: rect.left - minDist, newCy: cy, mag: cx - rect.left }, // exit left
            { newCx: rect.right + minDist, newCy: cy, mag: rect.right - cx }, // exit right
            { newCx: cx, newCy: rect.top - minDist, mag: cy - rect.top }, // exit up
            { newCx: cx, newCy: rect.bottom + minDist, mag: rect.bottom - cy }, // exit down
        ];
        candidates.sort((a, b) => {
            const fa = fits(a.newCx, a.newCy);
            const fb = fits(b.newCx, b.newCy);
            if (fa !== fb) return fa ? -1 : 1;
            return a.mag - b.mag;
        });
        const best = candidates[0];
        return mapCenter(best.newCx, best.newCy);
    }

    if (dist >= minDist) return mapCenter(cx, cy);
    const ux = dx / dist;
    const uy = dy / dist;
    return mapCenter(closestX + ux * minDist, closestY + uy * minDist);
}

/** Push a rect away from a circle (treated as inflated rect with `gap` margin).
 *  The purified form of the former free function `rectAwayFromCircle` — no
 *  behavior change, no DOM access. */
function rectAwayFromCircle(
    myRect: BoxRect,
    currentSpherePos: Point,
    otCx: number,
    otCy: number,
    expandedRadius: number,
): Point {
    const closestX = Math.max(myRect.left, Math.min(otCx, myRect.right));
    const closestY = Math.max(myRect.top, Math.min(otCy, myRect.bottom));
    const dx = otCx - closestX;
    const dy = otCy - closestY;
    const dist = Math.hypot(dx, dy);
    if (dist >= expandedRadius) return currentSpherePos;

    const candidates: Array<{ axis: 'x' | 'y'; delta: number }> = [
        { axis: 'x', delta: otCx - expandedRadius - myRect.right }, // push left
        { axis: 'x', delta: otCx + expandedRadius - myRect.left }, // push right
        { axis: 'y', delta: otCy - expandedRadius - myRect.bottom }, // push up
        { axis: 'y', delta: otCy + expandedRadius - myRect.top }, // push down
    ];
    candidates.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta));
    const best = candidates[0];
    return {
        x: currentSpherePos.x + (best.axis === 'x' ? best.delta : 0),
        y: currentSpherePos.y + (best.axis === 'y' ? best.delta : 0),
    };
}

/** Push this item's effective shape away from one obstacle if they overlap.
 *  The purified form of the former `_pushAway` — `viewport` is explicit so the
 *  circle-in-rect tie-break can prefer on-screen exits without `window`. */
function pushAway(
    item: LayoutItem,
    pos: Point,
    obstacle: Obstacle,
    viewport: { width: number; height: number },
): Point {
    const my = rectAt(item, pos);
    const myShape = item.shape;
    const otherRect = obstacle.rect;
    const otherShape = obstacle.shape;
    const gap = item.gap;

    // Circle ↔ circle: vector push from center to center.
    if (myShape === 'circle' && otherShape === 'circle') {
        const myR = SPHERE_SIZE / 2;
        const otR = Math.min(otherRect.width, otherRect.height) / 2;
        const myCx = my.left + myR;
        const myCy = my.top + myR;
        const otCx = otherRect.left + otherRect.width / 2;
        const otCy = otherRect.top + otherRect.height / 2;
        const dx = myCx - otCx;
        const dy = myCy - otCy;
        const dist = Math.hypot(dx, dy);
        const minDist = myR + otR + gap;
        if (dist >= minDist) return pos;
        const ux = dist === 0 ? 0 : dx / dist;
        const uy = dist === 0 ? 1 : dy / dist;
        const newCx = otCx + ux * minDist;
        const newCy = otCy + uy * minDist;
        return { x: newCx - myR, y: newCy - myR };
    }

    // Circle ↔ rect (this item is the circle, other is rect).
    if (myShape === 'circle' && otherShape === 'rect') {
        const myR = SPHERE_SIZE / 2;
        const cx = my.left + myR;
        const cy = my.top + myR;
        return circleAwayFromRect(cx, cy, myR, otherRect, gap, viewport, (newCx, newCy) => ({
            x: newCx - myR,
            y: newCy - myR,
        }));
    }

    // Rect ↔ circle (this item is the rect, other is circle).
    if (myShape === 'rect' && otherShape === 'circle') {
        const otR = Math.min(otherRect.width, otherRect.height) / 2;
        const otCx = otherRect.left + otherRect.width / 2;
        const otCy = otherRect.top + otherRect.height / 2;
        // Inflate `my` by otR + gap so the problem reduces to "is the other
        // circle's center inside this expanded rect?". If yes, push along the
        // shortest axis to escape.
        return rectAwayFromCircle(my, pos, otCx, otCy, otR + gap);
    }

    // Rect ↔ rect: AABB push along the shortest axis.
    const overlapX = Math.min(my.right, otherRect.right) - Math.max(my.left, otherRect.left);
    const overlapY = Math.min(my.bottom, otherRect.bottom) - Math.max(my.top, otherRect.top);
    if (overlapX <= -gap || overlapY <= -gap) return pos;
    const needX = overlapX + gap;
    const needY = overlapY + gap;
    if (needX < needY) {
        const myCx = (my.left + my.right) / 2;
        const otCx = (otherRect.left + otherRect.right) / 2;
        return { x: pos.x + (myCx < otCx ? -needX : needX), y: pos.y };
    }
    const myCy = (my.top + my.bottom) / 2;
    const otCy = (otherRect.top + otherRect.bottom) / 2;
    return { x: pos.x, y: pos.y + (myCy < otCy ? -needY : needY) };
}

/** Deterministic outward search from `home` for the closest clear, on-screen
 *  slot avoiding `obstacles`. Sweeps fixed concentric rings × fixed directions
 *  (NOT a random spiral), clamping every candidate into the viewport so no
 *  result is ever off-screen. The first non-colliding candidate wins (rings
 *  widen by distance, so it is the closest). If every ring is blocked —
 *  extremely tight scene — return the on-screen candidate with the *least*
 *  overlap rather than null, so the caller never keeps an arbitrary worse
 *  overlap and never lands off-screen.
 *
 *  The purified form of the former `_searchClearPosition`. */
function searchClearPosition(
    item: LayoutItem,
    home: Point,
    obstacles: ReadonlyArray<Obstacle>,
    scene: Pick<Scene, 'viewport' | 'margins'>,
): Point {
    // Concentric ring radii (px). Each ring sweeps 8 cardinal + diagonal
    // directions before widening. Both lists are fixed and ordered, so the
    // search is fully deterministic.
    const STEPS = [40, 60, 90, 130, 180, 240, 320, 420, 560];
    const DIRS: Array<{ dx: number; dy: number }> = [
        { dx: 0, dy: -1 },
        { dx: 1, dy: 0 },
        { dx: -1, dy: 0 },
        { dx: 0, dy: 1 },
        { dx: 1, dy: -1 },
        { dx: -1, dy: -1 },
        { dx: 1, dy: 1 },
        { dx: -1, dy: 1 },
    ];
    let best: Point | null = null;
    let bestScore = Infinity;
    for (const step of STEPS) {
        for (const d of DIRS) {
            const cand = clamp(item, { x: home.x + d.dx * step, y: home.y + d.dy * step }, scene);
            if (!overlapsAny(item, cand, obstacles)) return cand;
            // Track the least-bad on-screen candidate as a guaranteed fallback
            // (overlap area + distance from home as tie-break).
            const score =
                overlapScore(item, cand, obstacles) +
                Math.hypot(cand.x - home.x, cand.y - home.y) * 1e-3;
            if (score < bestScore) {
                bestScore = score;
                best = cand;
            }
        }
    }
    // Last resort: the clamped home itself is on-screen; compare it too.
    const clampedHome = clamp(item, home, scene);
    const homeScore = overlapScore(item, clampedHome, obstacles);
    if (homeScore < bestScore || best === null) best = clampedHome;
    return best;
}

/**
 * Resolve one item's sphere top-left for its `home`, avoiding `obstacles`.
 * This is the single deterministic placement routine shared by {@link solve}
 * (which feeds freshly-solved peer rects) and any standalone caller (e.g. the
 * adapter previewing a panel's eventual position). The algorithm:
 *
 *   1. Relax: push out of every obstacle, a few bounded passes (a push out of
 *      A may move the item into B).
 *   2. Fold the viewport clamp INTO the result so the position is on-screen.
 *   3. Re-verify: if the clamp shoved the item back into an obstacle (corner
 *      case), deterministically search outward from `home` for the closest
 *      clear, on-screen slot — never a random spiral, never an off-screen
 *      position, never a silently-kept overlap.
 *
 * Same input + same obstacle list ⇒ same output. No input-order dependence.
 * The purified form of the former `_resolveAgainst`.
 */
export function place(
    item: LayoutItem,
    obstacles: ReadonlyArray<Obstacle>,
    scene: Pick<Scene, 'viewport' | 'margins'>,
): Point {
    let pos: Point = { ...item.home };
    // Relax: pushing away from one obstacle may bring this item into another,
    // so iterate a bounded number of passes. Obstacles are visited in the
    // caller's deterministic order.
    for (let pass = 0; pass < COLLISION_PASSES; pass++) {
        let changed = false;
        for (const ob of obstacles) {
            const next = pushAway(item, pos, ob, scene.viewport);
            if (next.x !== pos.x || next.y !== pos.y) {
                pos = next;
                changed = true;
            }
        }
        if (!changed) break;
    }
    // Fold clamp into the solve so the final position is always on-screen.
    pos = clamp(item, pos, scene);

    // Re-verify after clamp: clamping is obstacle-blind, so at a viewport
    // corner it can pull `pos` back into an obstacle. If so, search
    // deterministically for the closest clear slot around the *intended* home
    // (not the ping-pong endpoint). The search always returns an on-screen
    // point, so we never keep a silent overlap and never land off-screen.
    if (overlapsAny(item, pos, obstacles)) {
        pos = searchClearPosition(item, item.home, obstacles, scene);
    }
    return pos;
}

/** Build an obstacle snapshot for an item at a solved position. */
function obstacleAt(item: LayoutItem, pos: Point): Obstacle {
    return {
        id: item.id,
        rolePriority: item.rolePriority,
        rect: rectAt(item, pos),
        shape: item.shape,
    };
}

/**
 * Compute every non-passive item's sphere top-left in ONE deterministic pass.
 *
 * Algorithm (the purified, parameterized form of the former `_solveLayout`):
 *   • FIRST, sort all items by `(rolePriority, id)` so the input array's order
 *     never affects the output.
 *   • Passive items are fixed obstacles — collected once from their boxes.
 *   • Movable items are placed in sorted order. A movable being placed avoids:
 *     all passive obstacles + the *already-solved* rects of equal-or-higher
 *     priority movables placed before it. Lower-priority movables placed later
 *     avoid IT, not the reverse.
 *   • Same-priority idle peers therefore get a stable, symmetric result: the
 *     id-earlier peer keeps its home, the id-later one queues away from it — no
 *     ping-pong, no input-order dependence.
 *
 * Returns one {@link Placement} per non-passive item, in placement order.
 */
export function solve(scene: Scene): Placement[] {
    // Deterministic order is the FIRST thing we establish: a stable sort on
    // (rolePriority, id) means the caller's `items` order is irrelevant.
    const ordered = [...scene.items].sort(
        (a, b) =>
            a.rolePriority - b.rolePriority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );

    // Passive obstacles are fixed; gather them once. Their rect is their box at
    // home (passive items don't get solved, so home doubles as their anchor).
    const passiveObstacles: Obstacle[] = [];
    const movables: LayoutItem[] = [];
    for (const item of ordered) {
        if (item.passive) {
            passiveObstacles.push(obstacleAt(item, item.home));
        } else {
            movables.push(item);
        }
    }

    const placements: Placement[] = [];
    const placed: Obstacle[] = [];
    for (const item of movables) {
        // Avoid all passive obstacles + already-placed equal-or-higher priority
        // movables. `placed` is built in priority order, so a simple priority
        // filter gives exactly that set.
        const obstacles = sortObstacles(
            passiveObstacles
                .concat(placed.filter((p) => p.rolePriority <= item.rolePriority))
                .filter((o) => o.id !== item.id),
        );
        const pos = place(item, obstacles, scene);
        placements.push({ id: item.id, pos });
        placed.push(obstacleAt(item, pos));
    }
    return placements;
}
