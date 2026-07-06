// FloatingLayer — shared sphere↔panel morph engine for ToC, Live, and Chat.
//
// Each instance is a fixed-position element that can:
//   • exist as a 40×40 sphere (collapsed) or grow into a panel (expanded)
//   • optionally be dragged by the user (mouse) and persist its home position
//   • automatically push itself away from other registered layers so multiple
//     spheres/panels never overlap (circle/rect collision with shadow gap)
//
// This class is a thin ADAPTER over the pure layout-engine (./layout-engine):
// it owns everything impure — reading DOM rects / viewport size, choosing the
// box/shape per item, driving morph animations, persisting positions, handling
// drag input, mutual exclusion, and writing CSS edges — while the engine owns
// all geometry (collision avoidance, viewport clamp, panel fit). Every state
// change snapshots the live scene into plain `LayoutItem`s, calls the engine's
// synchronous `solve()` once, and applies each `Placement` to its layer's CSS.
//
// Internal coordinate model:
//   • home {x, y}: sphere top-left in screen-space (anchored to the homeAnchor
//     viewport corner conceptually, but normalized to absolute (x, y) here so
//     all math stays in one frame of reference).
//   • displayed: home after collision resolution.
// CSS edges (top/right/bottom/left) are picked at apply-time from the active
// anchor, so persisted positions visually "stick" to the chosen viewport
// corner across resizes.

import {
    SPHERE_SIZE,
    clamp as clampEngine,
    place,
    rectAt,
    slide,
    solve,
    type Anchor,
    type BoxRect,
    type LayoutItem,
    type Obstacle,
    type Placement,
    type Point,
    type Scene,
    type Shape,
} from './layout-engine';
import { isDragBlockedTarget } from './draggable';

const REGISTRY = new Map<string, FloatingLayer>();

const MIN_VISIBLE = 20;
const PANEL_INSET = 8;
const DEFAULT_GAP = 10;
const DRAG_THRESHOLD_PX = 5;
const PHASE_MS = 60;
const RELOCATE_THRESHOLD_PX = 4;
// Pixel value rather than '50%' on purpose: CSS can't interpolate between
// '%' and 'px', so a mixed-unit keyframe pair would snap mid-animation. On
// a 40×40 sphere, 20px IS a perfect circle (radius = side/2); on the panel
// the same 20px reads as the rounded-rectangle corner. One value, smooth
// interpolation, both endpoints look right.
const SPHERE_BORDER_RADIUS = '20px';
// Sphere↔panel happens in two sequential phases:
//   Phase 1: sphere glides (transform only) to the target position.
//   Phase 2: panel grows (width/height) outward from the sphere's TL — the
//            sphere itself becomes the X close button pinned at TL, while
//            the panel reveals down-right.
// The two phases are deliberately sequential, not simultaneous: simultaneous
// reads as "vague morph"; sequential reads as "go there, then open" — which
// matches the user mental model of the sphere being a draggable handle and
// the panel being its content.

// Fallback role priorities by name when `rolePriority` opt is omitted. Lower
// number wins: ToC (passive obstacle) pushes everything, Chat is the primary
// movable, Live yields the most. Anything else defaults to Chat's tier.
const ROLE_DEFAULTS: Record<string, number> = { toc: 0, chat: 1, live: 2 };
const ROLE_FALLBACK = 2;

// Re-export the shared geometry types so existing consumers/imports keep
// working without reaching into layout-engine directly.
export type { Anchor, BoxRect, Point };

/** Obstacle shape for collision math. */
export type ObstacleShape = Shape;

/** Initial-offset opts (any subset of edges; missing edges default to 0). */
export interface InitialOffset {
    x?: number;
    y?: number;
    top?: number;
    right?: number;
    bottom?: number;
    left?: number;
}

/** Constructor options for {@link FloatingLayer}. */
export interface FloatingLayerOpts {
    /** Registry key. Must be unique. */
    name: string;
    /** Root element. Morphs sphere ↔ panel. */
    container: HTMLElement;
    /** If true: no drag, no morph, CSS untouched. Used by ToC. */
    passive?: boolean;
    /** Allow user drag (collapsed + expanded). */
    draggable?: boolean;
    /** Click handle to expand/collapse. */
    expandable?: boolean;
    /** CSS class applied while expanded. Defaults to 'expanded'. */
    expandedClass?: string;
    /** Viewport corner for the collapsed sphere. Defaults to 'BR'. */
    homeAnchor?: Anchor;
    /** Corner of the panel where the sphere sits. Defaults to homeAnchor. */
    panelAnchor?: Anchor;
    /** Minimum pixel gap between this layer and any other obstacle (covers shadow blur). */
    gap?: number;
    /** Static product-role priority for collision ordering. Lower number wins.
     *  Optional: omitted → name fallback (toc=0, chat=1, live=2, else 2). */
    rolePriority?: number;
    /** Required if expandable. */
    panelSize?: { width: number; height: number };
    /** Default sphere offset from its home anchor (used until storageKey persists). */
    initialOffset?: InitialOffset;
    /** localStorage key for {x, y}. Null = no persistence. */
    storageKey?: string;
    /** Click/drag handle inside container (sphere face). */
    handle?: HTMLElement;
    /** Panel body — used as "draggable blank area" when expanded. */
    body?: HTMLElement;
    /** Element (or CSS selector resolved against the container) that initiates drag while expanded. */
    expandedDragHandle?: string | HTMLElement;
    /** CSS selector for elements inside the drag handle that should NOT initiate drag. */
    nonDragSelector?: string;
    /** Called after the panel begins expanding. */
    onExpand?: () => void;
    /** Called after the panel finishes collapsing. */
    onCollapse?: () => void;
    /**
     * Required for passive layers that participate in mutual exclusion (e.g.
     * ToC's `.active` class). Called by sibling layers when they want to
     * expand and need this passive layer to fold first.
     */
    collapseExpanded?: () => void;
    /** Override how this layer reports its bbox to peers. */
    getObstacleRect?: () => DOMRect | BoxRect | null;
    /** Override how this layer's bbox is treated. Default: 40×40 → circle, else rect. */
    getObstacleShape?: () => ObstacleShape;
}

export class FloatingLayer {
    static get(name: string): FloatingLayer | undefined {
        return REGISTRY.get(name);
    }

    static all(): Iterable<FloatingLayer> {
        return REGISTRY.values();
    }

    name: string;
    private _opts: FloatingLayerOpts;
    private _passive: boolean;
    private _draggable: boolean;
    private _expandable: boolean;
    private _expandedClass: string;
    private _homeAnchor: Anchor;
    private _panelAnchor: Anchor;
    private _gap: number;
    private _rolePriority: number;

    // ── State model ────────────────────────────────────────────────
    //
    // `_intentionalHome` is the user's declared coordinate for this
    //   layer. It is updated by exactly two things:
    //     1. Initial load (default offset or persisted storage).
    //     2. Manual drag (the user explicitly moves this layer).
    //   Nothing else writes to it — not panel-fit relocation, not
    //   peer-collision push, not viewport clamping. Persistence
    //   (localStorage) records this value, not _home.
    //
    // `_home` is the *working* home used by render/collision math.
    //   For idle layers it equals `_intentionalHome`. During an
    //   expand cycle it may be auto-relocated to make room for the
    //   panel. When the cycle ends (collapse phase 2), it's reset
    //   back to `_intentionalHome` so all auto-changes revert.
    //
    // Peers don't have an "intentional/working" split because they
    // never auto-relocate — only their displayed (collision-resolved)
    // position changes, never their home. Their _home == intent.
    private _home: Point | null = null;
    private _intentionalHome: Point | null = null;
    private _isDragging = false;
    // The Web Animation handle for an in-flight sphere↔panel morph,
    // so collapse / mutual-exclusion / re-expand can cancel cleanly.
    private _morphAnim: Animation | null = null;
    private _classObserver: MutationObserver | null = null;
    private _resizeRaf: number | null = null;
    // Named refs for the document/window listeners installed by _bindEvents,
    // so destroy() can detach them.
    private _docClickHandler: ((e: MouseEvent) => void) | null = null;
    private _resizeHandler: (() => void) | null = null;

    constructor(opts: FloatingLayerOpts) {
        if (!opts?.name) throw new Error('FloatingLayer: name required');
        if (!opts.container) throw new Error('FloatingLayer: container required');
        if (REGISTRY.has(opts.name)) throw new Error(`FloatingLayer: duplicate name "${opts.name}"`);

        this.name = opts.name;
        this._opts = opts;
        this._passive = !!opts.passive;
        this._draggable = !this._passive && (opts.draggable !== false);
        this._expandable = !this._passive && (opts.expandable !== false);
        this._expandedClass = opts.expandedClass || 'expanded';
        this._homeAnchor = opts.homeAnchor || 'BR';
        this._panelAnchor = opts.panelAnchor || this._homeAnchor;
        this._gap = opts.gap ?? DEFAULT_GAP;
        this._rolePriority = opts.rolePriority ?? ROLE_DEFAULTS[opts.name] ?? ROLE_FALLBACK;

        REGISTRY.set(this.name, this);
    }

    init(): void {
        if (this._passive) {
            this._observeObstacleClass();
            FloatingLayer._relayout();
            return;
        }

        // Both copies start at the loaded position — they only diverge
        // when expand() auto-relocates `_home` for panel fit.
        this._home = this._loadHome();
        this._intentionalHome = { ...this._home };
        this._applyDisplayed();
        this._bindEvents();
        FloatingLayer._relayout();
    }

    destroy(): void {
        REGISTRY.delete(this.name);
        if (this._classObserver) this._classObserver.disconnect();
        if (this._morphAnim) {
            this._morphAnim.cancel();
            this._morphAnim = null;
        }
        if (this._docClickHandler) {
            document.removeEventListener('click', this._docClickHandler);
            this._docClickHandler = null;
        }
        if (this._resizeHandler) {
            window.removeEventListener('resize', this._resizeHandler);
            this._resizeHandler = null;
        }
        if (this._resizeRaf !== null) {
            cancelAnimationFrame(this._resizeRaf);
            this._resizeRaf = null;
        }
    }

    // ── State ────────────────────────────────────────────────────────────

    get isExpanded(): boolean {
        return this._opts.container.classList.contains(this._expandedClass);
    }

    toggle(): void {
        if (this.isExpanded) this.collapse();
        else this.expand();
    }

    /** Open the panel as TWO sequential animated phases:
     *    Phase 1 — sphere glides to the panel-fit target.
     *    Phase 2 — panel grows from sphere's TL (sphere becomes the X
     *              close button pinned at TL; body reveals down-right).
     *
     *  Mutual exclusion still holds: peer panels are snap-folded before
     *  the new layer's geometry is computed, so the panel-fit math sees a
     *  stable scene. */
    expand(): void {
        if (this._passive || this.isExpanded) return;

        // Snap-fold peers. Their visible jump is acceptable here — user's
        // intent is "switch panels", and animating both at once reads as
        // visual noise.
        for (const peer of REGISTRY.values()) {
            if (peer === this) continue;
            if (peer._passive) {
                if (peer.isExpanded && peer._opts.collapseExpanded) peer._opts.collapseExpanded();
            } else if (peer.isExpanded || peer._morphAnim) {
                peer._snapToSphere();
            }
        }

        // Compute glide endpoints. startPos is where the sphere visually
        // sits right now; endPos is where it must sit so the panel will
        // fit. The panel-fit computation seeds from _intentionalHome — the
        // user-declared coordinate — not from _home, because _home may have
        // been auto-modified by a prior cycle that we haven't fully unwound.
        // We synchronously ask the engine to `place()` an *active* version
        // of this layer (panel-sized box) against the current peers, which
        // preserves the morph pipeline while the engine stays synchronous.
        this._applyDisplayed();
        const startRect = this._opts.container.getBoundingClientRect();
        const startPos: Point = { x: startRect.left, y: startRect.top };
        const endPos = this._placeSelf(true, this._intentionalHome as Point);

        // Working _home moves to the auto-relocated panel position so
        // _applyDisplayed renders the panel there. _intentionalHome is
        // *not* touched — the user's declared coordinate is preserved
        // and will be restored verbatim on collapse.
        this._home = endPos;
        const distance = Math.hypot(endPos.x - startPos.x, endPos.y - startPos.y);

        const c = this._opts.container;
        if (this._morphAnim) {
            this._morphAnim.cancel();
            this._morphAnim = null;
        }

        // ── Phase 1: sphere glide (transform-only) ────────────────────
        // The sphere stays a sphere (no .expanded class) and glides from
        // startPos to endPos. CSS edges are pre-applied at endPos and a
        // counter-translate puts the sphere visually back at startPos for
        // the first frame; the animation slides the translate to zero.
        this._applyDisplayed(); // BR-anchored edges at endPos
        const dx = startPos.x - endPos.x;
        const dy = startPos.y - endPos.y;

        const phase1: Animation | null = (distance < RELOCATE_THRESHOLD_PX)
            ? null
            : c.animate(
                [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
                { duration: PHASE_MS, easing: 'ease', fill: 'none' },
            );

        const startPhase2 = (): void => {
            if (this._morphAnim) {
                this._morphAnim.cancel();
                this._morphAnim = null;
            }
            this._beginExpandPhase2();
        };

        if (phase1) {
            this._morphAnim = phase1;
            phase1.onfinish = startPhase2;
        } else {
            startPhase2();
        }

        FloatingLayer._relayout();
    }

    /** Phase 2 of expand: panel reveals from sphere's TL. Switches the
     *  layer to expanded state (TL-anchored, .expanded class) and then
     *  animates width/height from sphere size to natural panel size. The
     *  sphere face becomes the X close button at TL automatically via
     *  the .expanded CSS rules. */
    private _beginExpandPhase2(): void {
        const c = this._opts.container;

        // Switch to expanded state. Adding the class triggers panel CSS
        // rules (face pinning at TL, icon swap to close-X, body display).
        // _applyDisplayed re-anchors to TL so growth is down-right.
        c.classList.add(this._expandedClass);
        this._applyDisplayed();
        if (this._opts.onExpand) this._opts.onExpand();

        // Read the natural panel size after the class has applied so we
        // pick up Live's `height: auto` resolved value, not opts.panelSize.
        const cs = window.getComputedStyle(c);
        const panelW = cs.width;
        const panelH = cs.height;
        const panelR = cs.borderRadius;

        this._morphAnim = c.animate(
            [
                { width: `${SPHERE_SIZE}px`, height: `${SPHERE_SIZE}px`, borderRadius: SPHERE_BORDER_RADIUS },
                { width: panelW, height: panelH, borderRadius: panelR },
            ],
            { duration: PHASE_MS, easing: 'ease', fill: 'none' },
        );
        // fill:'none' → after the animation, computed reverts to the
        // .expanded CSS underlying — same values as keyframe[1], so no
        // visible snap.
        this._morphAnim.onfinish = () => {
            if (this._morphAnim) {
                this._morphAnim.cancel();
                this._morphAnim = null;
            }
            // The panel has reached its natural size; run one global solve so
            // peers settle against the now-measurable live panel rect and any
            // change that happened during the animation is caught up.
            FloatingLayer._relayout();
        };
    }

    /** Reverse: panel shrinks back to sphere at the panel's TL, then
     *  the sphere glides home. Mirrors expand() in two phases. */
    collapse(): void {
        if (this._passive) return;
        if (!this.isExpanded && !this._morphAnim) return;

        const c = this._opts.container;

        // Cancel anything in flight. commitStyles bakes the current value
        // into inline so cancel doesn't snap to the underlying class style.
        if (this._morphAnim) {
            try { this._morphAnim.commitStyles(); } catch { /* */ }
            this._morphAnim.cancel();
            this._morphAnim = null;
        }

        // ── Phase 1: panel shrink (size only) ──────────────────────────
        // Container stays TL-anchored at endPos with .expanded class
        // active so the X stays pinned at TL during the shrink. Width/
        // height interpolate from current to sphere size.
        const cs = window.getComputedStyle(c);
        const k0 = { width: cs.width, height: cs.height, borderRadius: cs.borderRadius };

        this._morphAnim = c.animate(
            [
                k0,
                { width: `${SPHERE_SIZE}px`, height: `${SPHERE_SIZE}px`, borderRadius: SPHERE_BORDER_RADIUS },
            ],
            { duration: PHASE_MS, easing: 'ease', fill: 'forwards' },
        );

        this._morphAnim.onfinish = () => {
            if (!this._morphAnim) return;
            try { this._morphAnim.commitStyles(); } catch { /* */ }
            this._morphAnim.cancel();
            // Null _morphAnim here so _beginCollapsePhase2's geometry sees
            // this layer as idle and computes the *final* resting position —
            // including avoidance of idle peers — as the animation endpoint.
            // Otherwise phase 2 would slide to an active-priority displayed
            // position (only avoiding passive/operated obstacles) and then
            // snap to the idle position when the animation ended, producing a
            // visible second jump at the end.
            this._morphAnim = null;
            this._beginCollapsePhase2();
        };
    }

    /** Phase 2 of collapse: glide the (now sphere-sized) layer from the
     *  panel's TL position back to the saved home. Switches anchoring
     *  from TL→BR and removes .expanded in the same JS turn so the icon
     *  flips back to the chat-bubble immediately as the slide begins. */
    private _beginCollapsePhase2(): void {
        const c = this._opts.container;

        // Capture where the sphere visually is right now (= panel's TL,
        // since phase 1 shrank in place).
        const rect = c.getBoundingClientRect();
        const visualPos: Point = { x: rect.left, y: rect.top };

        // Restore working _home to the user-declared coordinate. The
        // expand cycle may have auto-relocated _home for panel-fit; the
        // collapse undoes that. Re-clamp in case the viewport changed
        // while open. Force the *sphere* (collapsed) box so the clamp uses
        // sphere bounds, not panel — `.expanded` is still on the element
        // here and would otherwise pull _intentionalHome inward to fit a
        // panel we're about to dismiss.
        const targetHome = this._clampSelf(false, this._intentionalHome as Point);
        this._home = targetHome;

        // Switch out of expanded state in one synchronous block:
        //   - drop class, clear baked size/radius/transform overrides
        //   - re-anchor BR at targetHome
        //   - apply a counter-translate so visual stays at visualPos
        // Browser commits a single first-frame: sphere at visualPos.
        c.classList.remove(this._expandedClass);
        c.style.width = '';
        c.style.height = '';
        c.style.borderRadius = '';
        c.style.transform = '';
        this._applyDisplayed();

        // _applyDisplayed renders at the solved (avoided) position, not _home
        // — when peers (e.g. ToC opening simultaneously) push the sphere off
        // its home, the *displayed* position is the real CSS-edge target.
        // Counter-translate must be measured from there or the sphere will
        // appear to fly in from a phantom location instead of from the
        // panel's TL. Compute as a collapsed sphere even though `.expanded`
        // was just removed (DOM still in same JS turn).
        const displayed = this._placeSelf(false, targetHome);
        const dx = visualPos.x - displayed.x;
        const dy = visualPos.y - displayed.y;

        if (Math.hypot(dx, dy) < RELOCATE_THRESHOLD_PX) {
            // Sphere already where it needs to be — no glide.
            if (this._opts.onCollapse) this._opts.onCollapse();
            FloatingLayer._relayout();
            return;
        }

        // Counter-translate first so the first paint is at visualPos,
        // then animate to zero.
        c.style.transform = `translate(${dx}px, ${dy}px)`;
        this._morphAnim = c.animate(
            [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
            { duration: PHASE_MS, easing: 'ease', fill: 'forwards' },
        );

        this._morphAnim.onfinish = () => {
            if (!this._morphAnim) return;
            try { this._morphAnim.commitStyles(); } catch { /* */ }
            this._morphAnim.cancel();
            this._morphAnim = null;
            // Bake = translate(0,0), same as cleared. Strip inline so the
            // sphere is purely BR-anchored from CSS+inline edges.
            c.style.transform = '';
            if (this._opts.onCollapse) this._opts.onCollapse();
            FloatingLayer._relayout();
        };
    }

    /** Synchronous fold-to-sphere with no animation. Used by mutual
     *  exclusion — when peer B opens, peer A drops its panel instantly so
     *  B's panel-fit math sees stable geometry. Visible jump is acceptable:
     *  the user's intent is "switch panels", and animating both at once
     *  reads as visual noise. */
    private _snapToSphere(): void {
        if (this._passive || (!this.isExpanded && !this._morphAnim)) return;
        if (this._morphAnim) {
            this._morphAnim.cancel();
            this._morphAnim = null;
        }

        // Snap-collapse always reverts to the user-declared home, since
        // any current _home offset is auto-relocation that must unwind.
        // Force the collapsed sphere box so the clamp uses sphere bounds;
        // `.expanded` is still set so a panel clamp would re-apply panel-fit.
        this._home = this._clampSelf(false, this._intentionalHome as Point);

        const c = this._opts.container;
        c.classList.remove(this._expandedClass);
        c.style.width = '';
        c.style.height = '';
        c.style.borderRadius = '';
        c.style.transform = '';
        this._applyDisplayed();

        if (this._opts.onCollapse) this._opts.onCollapse();
        FloatingLayer._relayout();
    }

    // ── Obstacle interface (what other layers see) ───────────────────────

    getObstacleRect(): DOMRect | BoxRect | null {
        if (this._opts.getObstacleRect) return this._opts.getObstacleRect();

        if ((this.isExpanded || this._morphAnim) && this._opts.panelSize && this._home) {
            // Settled-expanded with a real layout: trust the live bounding
            // rect. panelSize is only the *initial* size, so a panel the user
            // resized (or one clamped by max-height on a short viewport) would
            // otherwise advertise a phantom obstacle that no longer matches
            // what's drawn — a dead zone peers can't be dragged into. The live
            // rect always matches the visible panel.
            const live = this._opts.container.getBoundingClientRect();
            if (this.isExpanded && !this._morphAnim && live.width > 0 && live.height > 0) {
                return live;
            }
            // Mid-morph (or before first layout): report the layer's *eventual*
            // panel rect rather than its current sphere-sized bbox, so a peer
            // yields once upfront instead of chasing the growth.
            return rectAt(this._toLayoutItem(true), this._home);
        }

        const r = this._opts.container.getBoundingClientRect();
        return (r.width === 0 || r.height === 0) ? null : r;
    }

    getObstacleShape(): ObstacleShape {
        if (this._opts.getObstacleShape) return this._opts.getObstacleShape();
        // Match getObstacleRect: operated-into-expanded reports as a rect.
        if ((this.isExpanded || this._morphAnim) && this._opts.panelSize) return 'rect';
        const r = this.getObstacleRect();
        if (!r) return 'rect';
        const isSquare40 = Math.abs(r.width - SPHERE_SIZE) < 4 && Math.abs(r.height - SPHERE_SIZE) < 4;
        return isSquare40 ? 'circle' : 'rect';
    }

    // ── Event wiring ─────────────────────────────────────────────────────

    private _bindEvents(): void {
        const handle = this._opts.handle || this._opts.container;

        if (this._expandable) {
            handle.addEventListener('click', (e: MouseEvent) => {
                if (this._isDragging) return;
                // Suppress the handle's own click from also reaching the
                // document outside-collapse listener — without this the
                // toggle call below would expand and the document handler
                // would immediately collapse on the same event.
                e.stopPropagation();
                this.toggle();
            });
            // Outside-click collapse: fires on every document click but
            // only acts when (a) we're expanded and (b) the click landed
            // outside our container. We deliberately don't use body-level
            // stopPropagation — other handlers (e.g. Chat's thread-menu
            // outside-close) need to see panel-internal clicks too.
            this._docClickHandler = (e: MouseEvent) => {
                if (!this.isExpanded) return;
                const target = e.target;
                if (target instanceof Node && this._opts.container.contains(target)) return;
                this.collapse();
            };
            document.addEventListener('click', this._docClickHandler);
        }

        if (this._draggable) {
            handle.addEventListener('mousedown', (e: MouseEvent) => {
                if (this.isExpanded) return;            // expanded uses its own drag area
                if (e.button !== 0) return;
                this._beginDrag(e);
            });
            const dragArea = this._resolveExpandedDragHandle();
            if (dragArea) {
                dragArea.addEventListener('mousedown', (e: MouseEvent) => {
                    if (!this.isExpanded) return;
                    if (e.button !== 0) return;
                    if (isDragBlockedTarget(e.target, this._opts.nonDragSelector ?? null)) return;
                    this._beginDrag(e);
                });
            }
        }

        // Re-clamp + re-derive on viewport resize so persisted positions
        // never drift off-screen after a window resize.
        this._resizeHandler = () => {
            if (this._passive) return;
            if (this._resizeRaf !== null) return;
            this._resizeRaf = requestAnimationFrame(() => {
                this._resizeRaf = null;
                if (this._home) this._home = this._clampSelf(this.isExpanded, this._home);
                // Re-clamp this layer's home, then run ONE global solve so the
                // whole layout stays deterministic and consistent after the
                // viewport changed (not each layer recomputing on its own).
                FloatingLayer._relayout();
            });
        };
        window.addEventListener('resize', this._resizeHandler);
    }

    private _resolveExpandedDragHandle(): HTMLElement | null {
        const h = this._opts.expandedDragHandle;
        if (!h) return this._opts.body || null;
        if (typeof h === 'string') return this._opts.container.querySelector(h);
        return h;
    }

    /** Passive layers don't compute positions but still toggle class names
     *  (e.g. ToC's `.active`) — that changes their obstacle shape, so we
     *  need to nudge peers whenever the class set on the container changes. */
    private _observeObstacleClass(): void {
        this._classObserver = new MutationObserver(() => FloatingLayer._relayout());
        this._classObserver.observe(this._opts.container, {
            attributes: true,
            attributeFilter: ['class'],
        });
    }

    /** Re-solve and re-apply the whole layout. Public-internal so consumers
     *  with their own resize observers (e.g. a user-resizable Chat panel) can
     *  tell the layout to catch up after the live panel box changed. */
    relayout(): void {
        FloatingLayer._relayout();
    }

    // ── Drag ─────────────────────────────────────────────────────────────

    private _beginDrag(e: MouseEvent): void {
        e.preventDefault();
        const startPointer: Point = { x: e.clientX, y: e.clientY };
        const startHome: Point = { ...(this._home as Point) };
        // A HUMAN DRAG must move ONLY this widget — never cascade peers — and
        // track the cursor continuously with no jumps. We achieve that with
        // path-dependent swept sliding (engine.slide): each frame we move the
        // dragged box FROM its previous position TOWARD the cursor, treating
        // every peer + the viewport edge as IMMOVABLE and sliding along walls.
        // `cur` is the running SPHERE top-left, seeded at the drag-start home.
        let cur: Point = { ...startHome };
        let moved = false;

        const onMove = (me: MouseEvent): void => {
            const dx = me.clientX - startPointer.x;
            const dy = me.clientY - startPointer.y;
            if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
            moved = true;
            this._isDragging = true;

            // The dragged item's occupancy box + the offset from its sphere
            // top-left to the box top-left (non-zero only when an expanded
            // panel grows from a non-TL corner). slide() works in box-top-left
            // space; we convert the result back to a sphere position.
            const item = this._toLayoutItem(this.isExpanded);
            const box = item.box;
            const boxRect = rectAt(item, cur);
            const offX = boxRect.left - cur.x;
            const offY = boxRect.top - cur.y;

            // Target = raw pointer delta from the drag-start home, clamped to
            // the viewport BOUNDARY ONLY (no peer avoidance). slide() then caps
            // it against peers/edges. Expressed in box-top-left space.
            const targetSphere = this._clampSelf(this.isExpanded, {
                x: startHome.x + dx,
                y: startHome.y + dy,
            });
            const target: Point = { x: targetSphere.x + offX, y: targetSphere.y + offY };
            const fromBox: Point = { x: cur.x + offX, y: cur.y + offY };

            // Peers are the CURRENT displayed rects of ALL other layers
            // (passive + movable alike — priority is irrelevant during a drag).
            const peerRects = this._collectAllPeerRects();
            const slid = slide(box, fromBox, target, peerRects, FloatingLayer._sceneFrame().viewport, {
                minVisible: MIN_VISIBLE,
                panelInset: PANEL_INSET,
            });

            // Back to sphere top-left and commit. Drag is the only thing
            // besides initial load that updates _intentionalHome, so a collapse
            // after the drag settles exactly where the user dropped the layer.
            cur = { x: slid.x - offX, y: slid.y - offY };
            this._home = cur;
            this._intentionalHome = { ...cur };
            // Write the displayed position DIRECTLY — do NOT route through
            // _placeSelf/peer-avoidance, and do NOT _relayout (no cascade).
            this._writeDisplayed(cur);
        };
        const onUp = (): void => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            this._isDragging = false;
            if (!moved) return;
            // Free placement: keep the sphere/panel exactly where the user
            // dropped it. The swept slide guarantees `cur` is already
            // non-overlapping and on-screen, so there is NO cascade on drop —
            // peers stay put. No snap-to-corner either: an earlier "dock to
            // nearest corner" picked the corner by which viewport half the
            // centre was in, so any drag that didn't cross the midline sprang
            // back (right/down felt stuck).
            this._persistHome();
            // A real drag just ended. The browser synthesises a `click` on
            // mouseup; swallow it once at capture phase on window so NO handler
            // mistakes the drag for a click — not this layer's own toggle, and
            // not foreign handlers (e.g. Chat's capture-phase popout intercept
            // on the same sphere). stopImmediatePropagation kills every
            // remaining listener for that event, capture or bubble, anywhere.
            const swallow = (ev: MouseEvent): void => {
                ev.stopImmediatePropagation();
                ev.preventDefault();
                window.removeEventListener('click', swallow, true);
            };
            window.addEventListener('click', swallow, true);
            // If the gesture produced no click (released off the handle), drop
            // the one-shot next tick so it can't swallow a later real click.
            setTimeout(() => window.removeEventListener('click', swallow, true), 0);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }

    // ── Position storage ──────────────────────────────────────────────────

    private _loadHome(): Point {
        const opts = this._opts;
        if (opts.storageKey) {
            try {
                const raw: unknown = JSON.parse(localStorage.getItem(opts.storageKey) || 'null');
                if (raw && typeof raw === 'object') {
                    const obj = raw as Record<string, unknown>;
                    // New format: { x, y } screen coords.
                    if (typeof obj['x'] === 'number' && typeof obj['y'] === 'number') {
                        return this._clampSelf(false, { x: obj['x'], y: obj['y'] });
                    }
                    // Legacy format (Live pre-refactor): { right, bottom }.
                    if (typeof obj['right'] === 'number' || typeof obj['bottom'] === 'number') {
                        return this._clampSelf(false, this._offsetToScreen(obj));
                    }
                }
            } catch { /* fall through to default */ }
        }
        return this._clampSelf(false, this._offsetToScreen(opts.initialOffset || { right: 20, bottom: 20 }));
    }

    private _persistHome(): void {
        // Persist the user-intent coordinate, not the (possibly
        // auto-relocated) working _home. So if the user clicks expand —
        // panel-fit pushes _home — then refreshes the page, the sphere
        // comes back at where the user dragged it to, not where the
        // panel happened to need it.
        if (!this._opts.storageKey || !this._intentionalHome) return;
        localStorage.setItem(this._opts.storageKey, JSON.stringify(this._intentionalHome));
    }

    /** {top?, right?, bottom?, left?} → {x, y} of sphere top-left. */
    private _offsetToScreen(off: InitialOffset): Point {
        const vw = window.innerWidth, vh = window.innerHeight;
        let x = 0, y = 0;
        if (typeof off.left === 'number')        x = off.left;
        else if (typeof off.right === 'number')  x = vw - off.right - SPHERE_SIZE;
        if (typeof off.top === 'number')         y = off.top;
        else if (typeof off.bottom === 'number') y = vh - off.bottom - SPHERE_SIZE;
        return { x, y };
    }

    // ── Engine bridge (snapshot live DOM/window state → pure LayoutItem) ──

    /** Measure this layer's live panel box: the settled bounding rect when
     *  available (so a user-resized Chat panel informs layout), falling back
     *  to opts.panelSize before the first layout. */
    private _measurePanelBox(): { width: number; height: number } {
        if (this._opts.panelSize) {
            const live = this._opts.container.getBoundingClientRect();
            if (this.isExpanded && !this._morphAnim && live.width > 0 && live.height > 0) {
                return { width: live.width, height: live.height };
            }
            return { ...this._opts.panelSize };
        }
        return { width: SPHERE_SIZE, height: SPHERE_SIZE };
    }

    /** Snapshot this layer's live state into a pure {@link LayoutItem} for the
     *  engine. `activeOverride` forces the active/panel view regardless of the
     *  current DOM state — used to preview a panel's eventual position before
     *  morphing, and to advertise the eventual panel rect mid-morph. */
    private _toLayoutItem(activeOverride?: boolean): LayoutItem {
        const active = activeOverride ?? (this.isExpanded || !!this._morphAnim || this._isDragging);
        // Only panel-bearing layers occupy a larger box when active; a plain
        // draggable sphere stays a 40×40 circle even mid-drag.
        const box = active && this._opts.panelSize
            ? this._measurePanelBox()
            : { width: SPHERE_SIZE, height: SPHERE_SIZE };
        const isSphereBox = box.width === SPHERE_SIZE && box.height === SPHERE_SIZE;
        return {
            id: this.name,
            rolePriority: this._rolePriority,
            active,
            passive: this._passive,
            home: (this._home ?? this._intentionalHome ?? { x: 0, y: 0 }),
            homeAnchor: this._homeAnchor,
            panelAnchor: this._panelAnchor,
            box,
            shape: isSphereBox ? 'circle' : 'rect',
            gap: this._gap,
        };
    }

    /** Engine-backed single-point placement of this layer at `home`, avoiding
     *  the *current* peers (their live obstacle rects). `active` forces the
     *  panel/sphere view. Synchronous — the engine never blocks the morph
     *  pipeline. Mirrors the former `_avoidObstacles` standalone resolve. */
    private _placeSelf(active: boolean, home: Point): Point {
        const item = this._toLayoutItem(active);
        item.home = home;
        const obstacles = this._collectPeerObstacles(item.rolePriority);
        return place(item, obstacles, FloatingLayer._sceneFrame());
    }

    /** Engine-backed clamp of `home` for this layer, forcing the active/sphere
     *  view. Mirrors the former `_clampToViewport` with simulate override. */
    private _clampSelf(active: boolean, home: Point): Point {
        const item = this._toLayoutItem(active);
        item.home = home;
        return clampEngine(item, home, FloatingLayer._sceneFrame());
    }

    /** Current peers' live obstacle rects, as engine {@link Obstacle}s. Only
     *  equal-or-higher priority peers (lower-or-equal rolePriority) are
     *  returned — strictly lower-priority peers yield to us, not the reverse. */
    private _collectPeerObstacles(myPriority: number): Obstacle[] {
        const obstacles: Obstacle[] = [];
        for (const layer of REGISTRY.values()) {
            if (layer === this) continue;
            if (layer._rolePriority > myPriority) continue;
            const rect = layer.getObstacleRect();
            if (!rect) continue;
            obstacles.push({
                id: layer.name,
                rolePriority: layer._rolePriority,
                rect: toBoxRect(rect),
                shape: layer.getObstacleShape(),
            });
        }
        return obstacles;
    }

    /** Current displayed AABB rects of ALL other registered layers (passive +
     *  movable alike). Used ONLY by the human-drag swept slide, where priority
     *  is irrelevant: a manual drag must avoid every other widget equally and
     *  never push any of them. The dragged box is treated as an AABB against
     *  these AABBs, so the slide is jump-free by construction. */
    private _collectAllPeerRects(): BoxRect[] {
        const rects: BoxRect[] = [];
        for (const layer of REGISTRY.values()) {
            if (layer === this) continue;
            const rect = layer.getObstacleRect();
            if (!rect) continue;
            rects.push(toBoxRect(rect));
        }
        return rects;
    }

    // ── CSS application ──────────────────────────────────────────────────

    _applyDisplayed(): void {
        if (this._passive) return;
        const home = this._home;
        if (!home) return;
        this._writeDisplayed(this._placeSelf(this.isExpanded, home));
    }

    /** Write CSS edges for an already-resolved displayed position. Split out
     *  of `_applyDisplayed` so the global solve can apply pre-computed
     *  positions without each layer re-running its own avoidance. */
    private _writeDisplayed(displayed: Point): void {
        if (this._passive) return;
        const c = this._opts.container;

        // Always clear all 4 anchors; re-pick the two that match the active
        // anchor so the layer "sticks" to the right viewport corner across
        // resizes (e.g. BR-anchored Live moves with the bottom-right corner
        // when the window grows).
        c.style.position = 'fixed';
        c.style.top = c.style.right = c.style.bottom = c.style.left = '';

        const anchor = this.isExpanded ? this._panelAnchor : this._homeAnchor;
        const useTop  = (anchor === 'TL' || anchor === 'TR');
        const useLeft = (anchor === 'TL' || anchor === 'BL');

        const vw = window.innerWidth, vh = window.innerHeight;
        const SZ = SPHERE_SIZE;
        // Sphere lives at (displayed.x, displayed.y). The panel anchor
        // determines which corner of the panel the sphere is at — we set
        // CSS edges accordingly.
        if (useTop)  c.style.top    = `${displayed.y}px`;
        else         c.style.bottom = `${vh - displayed.y - SZ}px`;
        if (useLeft) c.style.left   = `${displayed.x}px`;
        else         c.style.right  = `${vw - displayed.x - SZ}px`;
    }

    // ── Global deterministic solve ───────────────────────────────────────

    /** The pure-engine scene frame (viewport + margins) snapshotted from the
     *  live window. Shared by the global solve and single-point placements. */
    private static _sceneFrame(): Pick<Scene, 'viewport' | 'margins'> {
        return {
            viewport: { width: window.innerWidth, height: window.innerHeight },
            margins: { minVisible: MIN_VISIBLE, panelInset: PANEL_INSET },
        };
    }

    /** Snapshot the whole registry into a pure {@link Scene}: a `LayoutItem`
     *  per registered layer (live box/shape/home measured now) plus the live
     *  viewport and margins. The engine consumes only numbers. */
    private static _buildScene(): Scene {
        const items: LayoutItem[] = [];
        for (const layer of REGISTRY.values()) {
            // A passive layer always participates as an obstacle; a movable one
            // only once it has loaded a working home.
            if (!layer._passive && !layer._home) continue;
            const item = layer._toLayoutItem();
            if (layer._passive) {
                // Passive items are fixed obstacles at their reported rect.
                // Drive the box/shape/home off getObstacleRect so the engine's
                // `obstacleAt(item, item.home)` reproduces that exact rect.
                const rect = layer.getObstacleRect();
                if (!rect) continue;
                const box = toBoxRect(rect);
                item.home = { x: box.left, y: box.top };
                item.box = { width: box.width, height: box.height };
                item.shape = layer.getObstacleShape();
                item.panelAnchor = 'TL'; // rect grows from its own TL = box rect
            }
            items.push(item);
        }
        const frame = FloatingLayer._sceneFrame();
        return { viewport: frame.viewport, items, margins: frame.margins };
    }

    /** Any state change runs ONE global engine solve, then applies the solved
     *  position to every non-morph movable. This is the single deterministic
     *  source of truth for the whole layout: the result never depends on who
     *  changed first, on registry order, or on a broadcast cascade. */
    static _relayout(): void {
        const placements: Placement[] = solve(FloatingLayer._buildScene());
        for (const p of placements) {
            const layer = REGISTRY.get(p.id);
            if (!layer || layer._passive) continue;
            // Don't disturb a layer that is mid-morph: it has a frozen visual
            // trajectory (panel TL → sphere home) and any external write during
            // that window would re-anchor mid-flight, making the sphere appear
            // to teleport. The morph's own onfinish re-applies when it's done,
            // catching up with whatever changed meanwhile.
            if (layer._morphAnim) continue;
            layer._writeDisplayed(p.pos);
        }
    }
}

// ── Engine adapters ─────────────────────────────────────────────────────

/** Normalize any DOM/box rect into the engine's {@link BoxRect}. */
function toBoxRect(r: DOMRect | BoxRect): BoxRect {
    return {
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
    };
}
