// FloatingLayer — shared sphere↔panel morph engine for ToC, Live, and Chat.
//
// Each instance is a fixed-position element that can:
//   • exist as a 40×40 sphere (collapsed) or grow into a panel (expanded)
//   • optionally be dragged by the user (mouse) and persist its home position
//   • automatically push itself away from other registered layers so multiple
//     spheres/panels never overlap (circle/rect collision with shadow gap)
//
// Layers are registered globally; on every state change a layer broadcasts
// to its peers so they re-derive their displayed position. ToC is the
// canonical "passive" peer — fixed, but participates as an obstacle.
//
// Internal coordinate model:
//   • home {x, y}: sphere top-left in screen-space (anchored to the homeAnchor
//     viewport corner conceptually, but normalized to absolute (x, y) here so
//     all math stays in one frame of reference).
//   • displayed: home after collision resolution.
// CSS edges (top/right/bottom/left) are picked at apply-time from the active
// anchor, so persisted positions visually "stick" to the chosen viewport
// corner across resizes.

const REGISTRY: Map<string, FloatingLayer> = new Map();

const SPHERE_SIZE = 40;
const MIN_VISIBLE = 20;
const DEFAULT_GAP = 10;
const DRAG_THRESHOLD_PX = 5;
// Iterative pushAway can ping-pong when a sphere is squeezed between two
// obstacles (push out of A overlaps B, push out of B overlaps A). 8 passes
// give the relaxation enough rounds to converge in practice; the explicit
// post-pass overlap check + spiral fallback in `_avoidObstacles` handles
// the cases where it still hasn't.
const COLLISION_PASSES = 8;
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

/** Viewport corner anchor. */
export type Anchor = 'TL' | 'TR' | 'BL' | 'BR';

/** Obstacle shape for collision math. */
export type ObstacleShape = 'circle' | 'rect';

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

/** Quick rect interface: { left, top, right, bottom }. */
interface EdgeRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

const rectFromBox = (left: number, top: number, w: number, h: number): EdgeRect => ({
    left,
    top,
    right: left + w,
    bottom: top + h,
});

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

    /** Re-apply displayed position on every active layer (e.g. on resize). */
    static refreshAll(): void {
        for (const inst of REGISTRY.values()) inst._applyDisplayed();
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
    private _dragStart: Point | null = null;
    // When set (true|false), all geometry helpers behave as if
    // isExpanded returned this value — used to "what-if" the target
    // panel position before actually morphing into a panel.
    private _simulateExpanded: boolean | null = null;
    // The Web Animation handle for an in-flight sphere↔panel morph,
    // so collapse / mutual-exclusion / re-expand can cancel cleanly.
    private _morphAnim: Animation | null = null;
    private _classObserver: MutationObserver | null = null;

    constructor(opts: FloatingLayerOpts) {
        if (!opts || !opts.name) throw new Error('FloatingLayer: name required');
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

        REGISTRY.set(this.name, this);
    }

    init(): void {
        if (this._passive) {
            this._observeObstacleClass();
            this._notifyOthers();
            return;
        }

        // Both copies start at the loaded position — they only diverge
        // when expand() auto-relocates `_home` for panel fit.
        this._home = this._loadHome();
        this._intentionalHome = { ...this._home };
        this._applyDisplayed();
        this._bindEvents();
        this._notifyOthers();
    }

    destroy(): void {
        REGISTRY.delete(this.name);
        if (this._classObserver) this._classObserver.disconnect();
        if (this._morphAnim) {
            this._morphAnim.cancel();
            this._morphAnim = null;
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
        // fit (panel-fit math via _withSimulatedExpanded). The panel-fit
        // computation seeds from _intentionalHome — the user-declared
        // coordinate — not from _home, because _home may have been
        // auto-modified by a prior cycle that we haven't fully unwound.
        this._applyDisplayed();
        const startRect = this._opts.container.getBoundingClientRect();
        const startPos: Point = { x: startRect.left, y: startRect.top };
        const endPos = this._withSimulatedExpanded(true,
            () => this._clampToViewport(this._avoidObstacles(this._intentionalHome as Point)));

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

        if (this._opts.onExpand) this._opts.onExpand();
        this._notifyOthers();
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
            // Null _morphAnim here so _beginCollapsePhase2's _applyDisplayed
            // sees this layer as idle (priority 2) and computes the *final*
            // resting position — including avoidance of idle peers — as the
            // animation endpoint. Otherwise phase 2 would slide to a
            // priority-1 displayed position (only avoiding passive/operated
            // obstacles) and then snap to the priority-2 position when the
            // animation ended, producing a visible second jump at the end.
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
        // while open. Force simulate=false so the clamp uses *sphere*
        // bounds, not panel — `.expanded` is still on the element here
        // and would otherwise pull _intentionalHome inward to fit a
        // panel we're about to dismiss.
        const targetHome = this._withSimulatedExpanded(false,
            () => this._clampToViewport(this._intentionalHome as Point));
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

        // _applyDisplayed renders at _avoidObstacles(_home), not _home —
        // when peers (e.g. ToC opening simultaneously) push the sphere off
        // its home, the *displayed* position is the real CSS-edge target.
        // Counter-translate must be measured from there or the sphere will
        // appear to fly in from a phantom location instead of from the
        // panel's TL. Compute via simulate=false so it stays a sphere even
        // though `.expanded` was just removed (DOM still in same JS turn).
        const displayed = this._withSimulatedExpanded(false,
            () => this._avoidObstacles(targetHome));
        const dx = visualPos.x - displayed.x;
        const dy = visualPos.y - displayed.y;

        if (Math.hypot(dx, dy) < RELOCATE_THRESHOLD_PX) {
            // Sphere already where it needs to be — no glide.
            if (this._opts.onCollapse) this._opts.onCollapse();
            this._notifyOthers();
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
            this._notifyOthers();
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
        // simulate=false makes the clamp use sphere bounds; `.expanded`
        // is still set so a plain clamp would re-apply panel-fit pull.
        this._home = this._withSimulatedExpanded(false,
            () => this._clampToViewport(this._intentionalHome as Point));

        const c = this._opts.container;
        c.classList.remove(this._expandedClass);
        c.style.width = '';
        c.style.height = '';
        c.style.borderRadius = '';
        c.style.transform = '';
        this._applyDisplayed();

        if (this._opts.onCollapse) this._opts.onCollapse();
        this._notifyOthers();
    }

    private _withSimulatedExpanded<T>(value: boolean, fn: () => T): T {
        const prev = this._simulateExpanded;
        this._simulateExpanded = value;
        try { return fn(); }
        finally { this._simulateExpanded = prev; }
    }

    /** Effective state for geometry math: the simulate override if set,
     *  otherwise the real DOM state. */
    private _effectiveExpanded(): boolean {
        return this._simulateExpanded !== null ? this._simulateExpanded : this.isExpanded;
    }

    /** Re-derive displayed position. Useful when an obstacle moves. */
    refresh(): void {
        if (!this._passive) this._applyDisplayed();
    }

    // ── Obstacle interface (what other layers see) ───────────────────────

    getObstacleRect(): DOMRect | BoxRect | null {
        if (this._opts.getObstacleRect) return this._opts.getObstacleRect();

        // Operating-into-expanded: report the layer's *eventual* panel
        // rect, not its current bbox. Without this, a peer that yields to
        // this layer at the start of the morph (when we're still sphere-
        // sized) would have to keep yielding as we grow — which reads as
        // peer chasing the morph. Reporting the panel rect upfront lets
        // peers settle once and stay put.
        const operatingExpanded = (this.isExpanded || this._morphAnim) && this._opts.panelSize;
        if (operatingExpanded && this._home) {
            const r = this._withSimulatedExpanded(true, () => this._effectiveRectAt(this._home as Point));
            return {
                left: r.left, top: r.top, right: r.right, bottom: r.bottom,
                width: r.right - r.left, height: r.bottom - r.top,
            };
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
            document.addEventListener('click', (e: MouseEvent) => {
                if (!this.isExpanded) return;
                const target = e.target;
                if (target instanceof Node && this._opts.container.contains(target)) return;
                this.collapse();
            });
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
                    const target = e.target;
                    if (
                        this._opts.nonDragSelector
                        && target instanceof Element
                        && target.closest(this._opts.nonDragSelector)
                    ) return;
                    this._beginDrag(e);
                });
            }
        }

        // Re-clamp + re-derive on viewport resize so persisted positions
        // never drift off-screen after a window resize.
        window.addEventListener('resize', () => {
            if (this._passive) return;
            if (this._home) this._home = this._clampToViewport(this._home);
            this._applyDisplayed();
        });
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
        this._classObserver = new MutationObserver(() => this._notifyOthers());
        this._classObserver.observe(this._opts.container, {
            attributes: true,
            attributeFilter: ['class'],
        });
    }

    // ── Drag ─────────────────────────────────────────────────────────────

    private _beginDrag(e: MouseEvent): void {
        e.preventDefault();
        const startPointer: Point = { x: e.clientX, y: e.clientY };
        const startHome: Point = { ...(this._home as Point) };
        let moved = false;

        const onMove = (me: MouseEvent): void => {
            const dx = me.clientX - startPointer.x;
            const dy = me.clientY - startPointer.y;
            if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
            moved = true;
            this._isDragging = true;
            // Drag is the only thing besides initial load that's allowed
            // to update _intentionalHome. Track raw pointer delta
            // (viewport-clamped) into both the working _home and the
            // user-intent _intentionalHome so a collapse after the drag
            // settles at exactly where the user dropped the layer.
            const next = this._clampToViewport({
                x: startHome.x + dx,
                y: startHome.y + dy,
            });
            this._home = next;
            this._intentionalHome = { ...next };
            this._applyDisplayed();
            this._notifyOthers();
        };
        const onUp = (): void => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            if (moved) this._persistHome();
            // Defer clearing isDragging so the synthetic click that follows
            // mouseup is suppressed by the toggle handler above.
            setTimeout(() => { this._isDragging = false; }, 0);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }

    // ── Position storage & math ──────────────────────────────────────────

    private _loadHome(): Point {
        const opts = this._opts;
        if (opts.storageKey) {
            try {
                const raw: unknown = JSON.parse(localStorage.getItem(opts.storageKey) || 'null');
                if (raw && typeof raw === 'object') {
                    const obj = raw as Record<string, unknown>;
                    // New format: { x, y } screen coords.
                    if (typeof obj.x === 'number' && typeof obj.y === 'number') {
                        return this._clampToViewport({ x: obj.x, y: obj.y });
                    }
                    // Legacy format (Live pre-refactor): { right, bottom }.
                    if (typeof obj.right === 'number' || typeof obj.bottom === 'number') {
                        return this._clampToViewport(this._offsetToScreen(obj as InitialOffset));
                    }
                }
            } catch { /* fall through to default */ }
        }
        return this._clampToViewport(this._offsetToScreen(opts.initialOffset || { right: 20, bottom: 20 }));
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

    /** Keep ≥ MIN_VISIBLE of the sphere on screen at all times. When the
     *  layer is expanded, also pull the entire panel back inside an 8px
     *  margin — a sphere alone needs only a corner to remain reachable, but
     *  a panel must keep its content readable. */
    private _clampToViewport({ x, y }: Point): Point {
        const vw = window.innerWidth, vh = window.innerHeight;
        let cx = Math.max(MIN_VISIBLE - SPHERE_SIZE, Math.min(Number(x) || 0, vw - MIN_VISIBLE));
        let cy = Math.max(MIN_VISIBLE - SPHERE_SIZE, Math.min(Number(y) || 0, vh - MIN_VISIBLE));

        if (this._effectiveExpanded() && this._opts.panelSize) {
            const MARGIN = 8;
            const rect = this._effectiveRectAt({ x: cx, y: cy });
            if (rect.right  > vw - MARGIN) cx -= (rect.right  - (vw - MARGIN));
            if (rect.bottom > vh - MARGIN) cy -= (rect.bottom - (vh - MARGIN));
            // Re-apply expanded-rect floors (after the pulls above the rect
            // may now poke off the top/left edge if the panel is bigger than
            // the viewport — rare but possible on tiny windows).
            const rect2 = this._effectiveRectAt({ x: cx, y: cy });
            if (rect2.left < MARGIN) cx += (MARGIN - rect2.left);
            if (rect2.top  < MARGIN) cy += (MARGIN - rect2.top);
        }
        return { x: cx, y: cy };
    }

    /** This layer's effective rect for the given sphere TL position. */
    private _effectiveRectAt({ x, y }: Point): EdgeRect {
        if (!this._effectiveExpanded() || !this._opts.panelSize) {
            return rectFromBox(x, y, SPHERE_SIZE, SPHERE_SIZE);
        }
        const { width: W, height: H } = this._opts.panelSize;
        const a = this._panelAnchor;
        const left = (a === 'TL' || a === 'BL') ? x : x + SPHERE_SIZE - W;
        const top  = (a === 'TL' || a === 'TR') ? y : y + SPHERE_SIZE - H;
        return rectFromBox(left, top, W, H);
    }

    // ── Collision avoidance ──────────────────────────────────────────────

    /** Collision priority. **Lower number = higher priority** (it wins).
     *
     *    0  — passive/fixed (TOC). Pushes everything; yields to nothing.
     *    1  — operated: this layer is being dragged, is expanded, is
     *         mid-morph, or is in a `_withSimulatedExpanded(true, …)`
     *         block (i.e. computing its eventual panel position). Other
     *         movables yield to it; it yields only to passive obstacles.
     *    2  — idle movable. Yields to passive and operated. Yields
     *         mutually with another idle peer so two idle spheres don't
     *         sit on top of each other.
     *
     *  All three states fall out of existing flags — no extra book-
     *  keeping. `_effectiveExpanded()` honors the simulate override, so
     *  the *moment* expand() enters its simulate block to compute endPos,
     *  this layer already reports priority 1 — peers yield to its
     *  eventual panel rect, not its current sphere bbox. */
    private _priority(): 0 | 1 | 2 {
        if (this._passive) return 0;
        if (this._effectiveExpanded() || this._morphAnim || this._isDragging) return 1;
        return 2;
    }

    private _avoidObstacles(home: Point): Point {
        let pos: Point = { ...home };
        const myPriority = this._priority();
        // Re-run a few passes — pushing away from one obstacle may bring
        // this layer into another.
        for (let pass = 0; pass < COLLISION_PASSES; pass++) {
            let changed = false;
            for (const layer of REGISTRY.values()) {
                if (layer === this) continue;
                // Yield only to obstacles of equal or higher priority
                // (lower or equal number). Strictly lower-priority peers
                // yield to *us* via their own _applyDisplayed pass — we
                // don't move out of their way.
                if (layer._priority() > myPriority) continue;

                const rect = layer.getObstacleRect();
                if (!rect) continue;
                const otherShape = layer.getObstacleShape();
                const next = this._pushAway(pos, rect, otherShape);
                if (next.x !== pos.x || next.y !== pos.y) {
                    pos = next;
                    changed = true;
                }
            }
            if (!changed) break;
        }
        pos = this._clampToViewport(pos);

        // Convergence check: when squeezed between two obstacles the
        // iterative pushAway can settle on a position that *still* overlaps
        // one of them (each push lands inside the other). If that's
        // happened, spiral-search for a clear position around the original
        // home — the user-intent home, not the ping-pong endpoint — and
        // pick the closest non-overlapping candidate.
        if (this._collidesWithAny(pos, myPriority)) {
            const fallback = this._searchClearPosition(home, myPriority);
            if (fallback) pos = fallback;
        }
        return pos;
    }

    /** Does `pos` overlap any equal-or-higher-priority peer right now?
     *  Mirrors the shape pairings in `_pushAway` but only computes the
     *  yes/no answer — no displacement vector. */
    private _collidesWithAny(pos: Point, myPriority: number): boolean {
        const my = this._effectiveRectAt(pos);
        const myShape = this._currentSelfShape();
        const gap = this._gap;
        for (const layer of REGISTRY.values()) {
            if (layer === this) continue;
            if (layer._priority() > myPriority) continue;
            const rect = layer.getObstacleRect();
            if (!rect) continue;
            if (this._overlapsRect(my, myShape, rect, layer.getObstacleShape(), gap)) {
                return true;
            }
        }
        return false;
    }

    /** Shape-aware overlap test with `gap` clearance. */
    private _overlapsRect(
        my: EdgeRect, myShape: ObstacleShape,
        other: DOMRect | BoxRect, otherShape: ObstacleShape, gap: number,
    ): boolean {
        if (myShape === 'circle' && otherShape === 'circle') {
            const myR = SPHERE_SIZE / 2;
            const otR = Math.min(other.width, other.height) / 2;
            const myCx = my.left + myR, myCy = my.top + myR;
            const otCx = other.left + other.width / 2;
            const otCy = other.top  + other.height / 2;
            return Math.hypot(myCx - otCx, myCy - otCy) < (myR + otR + gap);
        }
        if (myShape === 'circle') {
            const myR = SPHERE_SIZE / 2;
            const cx = my.left + myR, cy = my.top + myR;
            const closestX = Math.max(other.left, Math.min(cx, other.right));
            const closestY = Math.max(other.top,  Math.min(cy, other.bottom));
            return Math.hypot(cx - closestX, cy - closestY) < (myR + gap);
        }
        if (otherShape === 'circle') {
            const otR = Math.min(other.width, other.height) / 2;
            const otCx = other.left + other.width / 2;
            const otCy = other.top  + other.height / 2;
            const closestX = Math.max(my.left, Math.min(otCx, my.right));
            const closestY = Math.max(my.top,  Math.min(otCy, my.bottom));
            return Math.hypot(otCx - closestX, otCy - closestY) < (otR + gap);
        }
        // rect-rect with gap (no overlap if a gap-wide strip separates the rects on any axis)
        return !(my.right + gap <= other.left || other.right + gap <= my.left
              || my.bottom + gap <= other.top || other.bottom + gap <= my.top);
    }

    /** Spiral-out from `home` looking for a non-colliding position. Returns
     *  the closest clear candidate (Manhattan-ish distance via STEP order),
     *  or null if every candidate within the search range still overlaps —
     *  in which case the caller keeps the (overlapping) iterative result
     *  as a last resort. */
    private _searchClearPosition(home: Point, myPriority: number): Point | null {
        // Concentric ring radii (px). Each ring sweeps 8 cardinal +
        // diagonal directions before widening — finds the closest free
        // slot without enumerating every pixel.
        const STEPS = [50, 80, 120, 180, 260, 360, 500];
        const DIRS: Array<{ dx: number; dy: number }> = [
            { dx:  0, dy: -1 },
            { dx:  1, dy:  0 },
            { dx: -1, dy:  0 },
            { dx:  0, dy:  1 },
            { dx:  1, dy: -1 },
            { dx: -1, dy: -1 },
            { dx:  1, dy:  1 },
            { dx: -1, dy:  1 },
        ];
        for (const step of STEPS) {
            for (const d of DIRS) {
                const cand = this._clampToViewport({
                    x: home.x + d.dx * step,
                    y: home.y + d.dy * step,
                });
                if (!this._collidesWithAny(cand, myPriority)) return cand;
            }
        }
        return null;
    }

    /** Push this layer's effective shape away from `otherRect` if they overlap. */
    private _pushAway(pos: Point, otherRect: DOMRect | BoxRect, otherShape: ObstacleShape): Point {
        const my = this._effectiveRectAt(pos);
        const myShape = this._currentSelfShape();
        const gap = this._gap;

        // Circle ↔ circle: vector push from center to center.
        if (myShape === 'circle' && otherShape === 'circle') {
            const myR = SPHERE_SIZE / 2;
            const otR = Math.min(otherRect.width, otherRect.height) / 2;
            const myCx = my.left + myR, myCy = my.top + myR;
            const otCx = otherRect.left + otherRect.width / 2;
            const otCy = otherRect.top  + otherRect.height / 2;
            const dx = myCx - otCx, dy = myCy - otCy;
            const dist = Math.hypot(dx, dy);
            const minDist = myR + otR + gap;
            if (dist >= minDist) return pos;
            const ux = dist === 0 ? 0  : dx / dist;
            const uy = dist === 0 ? 1  : dy / dist;
            const newCx = otCx + ux * minDist;
            const newCy = otCy + uy * minDist;
            return { x: newCx - myR, y: newCy - myR };
        }

        // Circle ↔ rect (this layer is the circle, other is rect).
        if (myShape === 'circle' && otherShape === 'rect') {
            const myR = SPHERE_SIZE / 2;
            const cx = my.left + myR, cy = my.top + myR;
            return circleAwayFromRect(cx, cy, myR, otherRect, gap, (newCx, newCy) => ({
                x: newCx - myR, y: newCy - myR,
            }));
        }

        // Rect ↔ circle (this layer is the rect, other is circle).
        if (myShape === 'rect' && otherShape === 'circle') {
            const otR = Math.min(otherRect.width, otherRect.height) / 2;
            const otCx = otherRect.left + otherRect.width / 2;
            const otCy = otherRect.top  + otherRect.height / 2;
            // Inflate `my` by otR + gap so the problem reduces to "is the
            // other circle's center inside this expanded rect?". If yes,
            // push along the shortest axis to escape.
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

    /** Shape of this layer right now (collapsed sphere = circle). */
    private _currentSelfShape(): ObstacleShape {
        return this._effectiveExpanded() ? 'rect' : 'circle';
    }

    // ── CSS application ──────────────────────────────────────────────────

    _applyDisplayed(): void {
        if (this._passive) return;
        const home = this._home;
        if (!home) return;
        const displayed = this._avoidObstacles(home);
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

    // ── Peer notification ───────────────────────────────────────────────

    private _notifyOthers(): void {
        for (const layer of REGISTRY.values()) {
            if (layer === this) continue;
            if (layer._passive) continue;
            // Don't disturb a layer that is mid-morph: it has a frozen
            // visual trajectory (panel TL → sphere home) and any external
            // _applyDisplayed during that window would re-anchor mid-flight,
            // making the sphere appear to teleport / fly in from a phantom
            // location. The morph's own onfinish runs _applyDisplayed when
            // it's done, which catches up with whatever obstacle changes
            // happened during the animation.
            if (layer._morphAnim) continue;
            layer._applyDisplayed();
        }
    }
}

// ── Geometry helpers (free functions to keep methods readable) ───────────

/** Push a circle out of a rect with `gap` clearance. `mapCenter` projects
 *  the resulting circle center back to the caller's coord shape. When the
 *  circle's center sits inside the rect, the four edge exits are ranked
 *  first by whether they keep the circle on-screen, then by smallest
 *  displacement — otherwise a Live sphere overlapped by an opening Chat
 *  panel can pop off the right edge of the window when the only on-screen
 *  exit is leftward. */
function circleAwayFromRect(
    cx: number,
    cy: number,
    r: number,
    rect: DOMRect | BoxRect,
    gap: number,
    mapCenter: (newCx: number, newCy: number) => Point,
): Point {
    const closestX = Math.max(rect.left, Math.min(cx, rect.right));
    const closestY = Math.max(rect.top,  Math.min(cy, rect.bottom));
    const dx = cx - closestX;
    const dy = cy - closestY;
    const dist = Math.hypot(dx, dy);
    const minDist = r + gap;

    if (dist === 0) {
        const vw = window.innerWidth, vh = window.innerHeight;
        const fits = (x: number, y: number): boolean =>
            (x - r) >= 0 && (x + r) <= vw && (y - r) >= 0 && (y + r) <= vh;
        const candidates = [
            { newCx: rect.left   - minDist, newCy: cy, mag: cx - rect.left   }, // exit left
            { newCx: rect.right  + minDist, newCy: cy, mag: rect.right - cx  }, // exit right
            { newCx: cx, newCy: rect.top    - minDist, mag: cy - rect.top    }, // exit up
            { newCx: cx, newCy: rect.bottom + minDist, mag: rect.bottom - cy }, // exit down
        ];
        candidates.sort((a, b) => {
            const fa = fits(a.newCx, a.newCy), fb = fits(b.newCx, b.newCy);
            if (fa !== fb) return fa ? -1 : 1;
            return a.mag - b.mag;
        });
        const best = candidates[0];
        return mapCenter(best.newCx, best.newCy);
    }

    if (dist >= minDist) return mapCenter(cx, cy);
    const ux = dx / dist, uy = dy / dist;
    return mapCenter(closestX + ux * minDist, closestY + uy * minDist);
}

/** Push a rect away from a circle (treated as inflated rect with `gap` margin). */
function rectAwayFromCircle(
    myRect: EdgeRect,
    currentSpherePos: Point,
    otCx: number,
    otCy: number,
    expandedRadius: number,
): Point {
    // Compute the closest point on `myRect` to the circle center; if the
    // center is closer than `expandedRadius`, push the whole rect along the
    // shortest axis until it's not.
    const closestX = Math.max(myRect.left, Math.min(otCx, myRect.right));
    const closestY = Math.max(myRect.top,  Math.min(otCy, myRect.bottom));
    const dx = otCx - closestX, dy = otCy - closestY;
    const dist = Math.hypot(dx, dy);
    if (dist >= expandedRadius) return currentSpherePos;

    // Translate the rect by some delta to put the circle outside it. Each
    // candidate is the translation that places one chosen edge exactly at
    // the circle's clearance boundary; we pick the one with the smallest
    // magnitude so the layer is displaced as little as possible.
    const candidates: Array<{ axis: 'x' | 'y'; delta: number }> = [
        { axis: 'x', delta: (otCx - expandedRadius) - myRect.right  }, // push left
        { axis: 'x', delta: (otCx + expandedRadius) - myRect.left   }, // push right
        { axis: 'y', delta: (otCy - expandedRadius) - myRect.bottom }, // push up
        { axis: 'y', delta: (otCy + expandedRadius) - myRect.top    }, // push down
    ];
    candidates.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta));
    const best = candidates[0];
    return {
        x: currentSpherePos.x + (best.axis === 'x' ? best.delta : 0),
        y: currentSpherePos.y + (best.axis === 'y' ? best.delta : 0),
    };
}
