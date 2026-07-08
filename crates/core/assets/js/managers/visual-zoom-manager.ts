import { CONFIG, i18n, type ShortcutName } from '../core/config';
import { closeShortcutsHelp, openShortcutsHelp } from '../components/shortcuts-help';
import { PlatformUtils } from '../core/utils';

type VisualElement = HTMLElement | HTMLImageElement | SVGSVGElement;

interface Point {
    x: number;
    y: number;
}

interface DragState {
    id: number;
    start: Point;
    pan: Point;
}

interface PinchState {
    distance: number;
    midpoint: Point;
    pan: Point;
    scale: number;
}

interface MarqueeState {
    id: number;
    start: Point;
    current: Point;
    zoomOut: boolean;
}

interface ZoomVisual {
    kind: 'diagram' | 'image' | 'svg';
    element: VisualElement;
    label: string;
    node: Element;
}

const MIN_SCALE = 0.05;
const MAX_SCALE = 12;
const DEFAULT_SCALE = 1;
const ZOOM_STEP = 1.2;
const WHEEL_ZOOM_PER_100PX = 1.12;
const WHEEL_LINE_PX = 16;
const WHEEL_PAGE_PX = 800;
const MARQUEE_MIN_SIZE = 8;
const FIT_RATIO = 0.9;
const SCALE_SLIDER_STEPS = 1000;
const MERMAID_VIEWBOX_PADDING = 12;
const SVG_BOUNDS_EPSILON = 0.5;
const VISUAL_SHORTCUTS: readonly ShortcutName[] = [
    'HELP',
    'VISUAL_ZOOM_IN',
    'VISUAL_ZOOM_IN_ALT',
    'VISUAL_ZOOM_OUT',
    'VISUAL_ZOOM_RESET',
    'VISUAL_ZOOM_RESET_ALT',
    'VISUAL_ZOOM_FIT',
    'VISUAL_ZOOM_FIT_CMD',
    'VISUAL_ZOOM_TOOL',
    'VISUAL_ZOOM_TOOL_OUT',
    'VISUAL_ZOOM_CLOSE',
];

const INTERACTIVE_SELECTOR = [
    'a',
    'button',
    'input',
    'textarea',
    'select',
    '[contenteditable="true"]',
    '.selection-popover',
    '.note-input-modal',
    '.note-card-margin',
    '.note-popup',
    '.markon-chat-container',
].join(',');

function clamp(value: number, min = MIN_SCALE, max = MAX_SCALE): number {
    return Math.min(max, Math.max(min, value));
}

function pointsDistance(a: Point, b: Point): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointsMidpoint(a: Point, b: Point): Point {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function eventPoint(event: PointerEvent | MouseEvent | WheelEvent): Point {
    return { x: event.clientX, y: event.clientY };
}

function normalizedWheelDelta(event: WheelEvent): number {
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * WHEEL_LINE_PX;
    if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * WHEEL_PAGE_PX;
    return event.deltaY;
}

function rectFromPoints(a: Point, b: Point): DOMRect {
    const left = Math.min(a.x, b.x);
    const top = Math.min(a.y, b.y);
    return new DOMRect(left, top, Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function label(key: string, fallback: string): string {
    const value = i18n.t(key);
    return value === key ? fallback : value;
}

function scaleToSliderValue(scale: number): string {
    const min = Math.log(MIN_SCALE);
    const max = Math.log(MAX_SCALE);
    const ratio = (Math.log(clamp(scale)) - min) / (max - min);
    return String(Math.round(ratio * SCALE_SLIDER_STEPS));
}

function sliderValueToScale(value: string): number {
    const min = Math.log(MIN_SCALE);
    const max = Math.log(MAX_SCALE);
    const ratio = Number(value) / SCALE_SLIDER_STEPS;
    return clamp(Math.exp(min + ratio * (max - min)));
}

interface SvgBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

function isFinitePositive(value: number): boolean {
    return Number.isFinite(value) && value > 0;
}

function parseViewBox(value: string | null): SvgBounds | null {
    if (!value) return null;
    const parts = value
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;
    const [x = 0, y = 0, width = 0, height = 0] = parts;
    if (!isFinitePositive(width) || !isFinitePositive(height)) return null;
    return { x, y, width, height };
}

function formatSvgNumber(value: number): string {
    return String(Number(value.toFixed(3)));
}

function containsBounds(outer: SvgBounds, inner: SvgBounds): boolean {
    return (
        outer.x <= inner.x + SVG_BOUNDS_EPSILON &&
        outer.y <= inner.y + SVG_BOUNDS_EPSILON &&
        outer.x + outer.width >= inner.x + inner.width - SVG_BOUNDS_EPSILON &&
        outer.y + outer.height >= inner.y + inner.height - SVG_BOUNDS_EPSILON
    );
}

function paddedSvgBBox(svg: SVGSVGElement): SvgBounds | null {
    let box: DOMRect  ;
    try {
        box = svg.getBBox();
    } catch {
        return null;
    }

    if (!isFinitePositive(box.width) || !isFinitePositive(box.height)) return null;
    return {
        x: box.x - MERMAID_VIEWBOX_PADDING,
        y: box.y - MERMAID_VIEWBOX_PADDING,
        width: box.width + MERMAID_VIEWBOX_PADDING * 2,
        height: box.height + MERMAID_VIEWBOX_PADDING * 2,
    };
}

function normalizeMermaidSvgBounds(svg: SVGSVGElement): boolean {
    const next = paddedSvgBBox(svg);
    if (!next) return false;

    const current = parseViewBox(svg.getAttribute('viewBox'));
    if (current && containsBounds(current, next)) {
        svg.style.overflow = 'visible';
        return false;
    }

    const width = formatSvgNumber(next.width);
    const height = formatSvgNumber(next.height);
    svg.setAttribute(
        'viewBox',
        `${formatSvgNumber(next.x)} ${formatSvgNumber(next.y)} ${width} ${height}`,
    );
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.style.overflow = 'visible';
    return true;
}

function matchesShortcut(event: KeyboardEvent, name: ShortcutName): boolean {
    const shortcut = CONFIG.SHORTCUTS[name];
    if (!shortcut) return false;
    const ctrlPressed = PlatformUtils.isMac() ? event.metaKey : event.ctrlKey;
    if (!shortcut.ctrl && shortcut.key.length === 1 && !(/[a-z]/i.exec(shortcut.key))) {
        return event.key === shortcut.key && !ctrlPressed && !event.altKey;
    }
    return (
        event.key.toLowerCase() === shortcut.key.toLowerCase() &&
        ctrlPressed === shortcut.ctrl &&
        event.shiftKey === shortcut.shift &&
        !event.altKey
    );
}

export class VisualZoomManager {
    #contentRoot: HTMLElement;
    #overlay: HTMLDivElement | null = null;
    #stage: HTMLDivElement | null = null;
    #frame: HTMLDivElement | null = null;
    #content: HTMLDivElement | null = null;
    #scaleLabel: HTMLSpanElement | null = null;
    #scaleInput: HTMLInputElement | null = null;
    #scale = DEFAULT_SCALE;
    #pan: Point = { x: 0, y: 0 };
    #pointers = new Map<number, Point>();
    #drag: DragState | null = null;
    #pinch: PinchState | null = null;
    #marquee: MarqueeState | null = null;
    #marqueeElement: HTMLDivElement | null = null;
    #zoomToolActive = false;
    #zoomOutToolActive = false;
    #initialized = false;

    constructor(markdownBody: HTMLElement) {
        this.#contentRoot = markdownBody.querySelector<HTMLElement>('#main-content') ?? markdownBody;
    }

    init(): void {
        if (this.#initialized) return;
        this.#initialized = true;
        this.refresh();
        this.#contentRoot.addEventListener('click', this.#handleContentClick);
        this.#contentRoot.addEventListener('keydown', this.#handleContentKeydown);
    }

    dispose(): void {
        if (!this.#initialized) return;
        this.#initialized = false;
        this.close();
        this.#contentRoot.removeEventListener('click', this.#handleContentClick);
        this.#contentRoot.removeEventListener('keydown', this.#handleContentKeydown);
    }

    refresh(): void {
        this.#normalizeMermaidDiagrams();

        this.#contentRoot.querySelectorAll<HTMLElement>('.markon-diagram').forEach((diagram) => {
            this.#decorate(diagram, label('web.visual.zoom.open', 'Open visual viewer'));
        });

        this.#contentRoot.querySelectorAll('img, svg').forEach((visual) => {
            if (!this.#isStandaloneVisual(visual)) return;
            this.#decorate(visual as VisualElement, label('web.visual.zoom.open', 'Open visual viewer'));
        });
    }

    #normalizeMermaidDiagrams(): void {
        const normalize = (): void => {
            this.#contentRoot
                .querySelectorAll<SVGSVGElement>('.markon-diagram[data-diagram-engine="mermaid"] svg')
                .forEach((svg) => normalizeMermaidSvgBounds(svg));
        };

        normalize();
        window.requestAnimationFrame?.(normalize);
        void document.fonts?.ready.then(normalize).catch(() => undefined);
    }

    open(element: VisualElement): void {
        const visual = this.#visualFromElement(element);
        if (!visual) return;

        this.close();
        this.#scale = DEFAULT_SCALE;
        this.#pan = { x: 0, y: 0 };

        const overlay = document.createElement('div');
        overlay.className = 'markon-visual-zoom-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', label('web.visual.zoom.title', 'Visual viewer'));

        const chrome = this.#createChrome();
        this.#scaleLabel = chrome.controls.querySelector<HTMLSpanElement>('.markon-visual-zoom-scale');
        this.#scaleInput = chrome.controls.querySelector<HTMLInputElement>('.markon-visual-zoom-slider');

        const stage = document.createElement('div');
        stage.className = 'markon-visual-zoom-stage';

        const frame = document.createElement('div');
        frame.className = 'markon-visual-zoom-frame';

        const content = document.createElement('div');
        content.className = `markon-visual-zoom-content markon-visual-zoom-content-${visual.kind}`;
        content.appendChild(visual.node);

        frame.appendChild(content);
        stage.appendChild(frame);
        overlay.append(stage, chrome.closeButton, chrome.controls);
        document.body.appendChild(overlay);

        this.#overlay = overlay;
        this.#stage = stage;
        this.#frame = frame;
        this.#content = content;
        document.body.classList.add('markon-visual-zoom-open');

        chrome.closeButton.addEventListener('click', this.#handleCloseClick);
        chrome.controls.addEventListener('click', this.#handleControlsClick);
        chrome.controls.addEventListener('input', this.#handleControlsInput);
        overlay.addEventListener('click', this.#handleOverlayClick);
        stage.addEventListener('wheel', this.#handleWheel, { passive: false });
        stage.addEventListener('dblclick', this.#handleDoubleClick);
        stage.addEventListener('pointerdown', this.#handlePointerDown);
        stage.addEventListener('pointermove', this.#handlePointerMove);
        stage.addEventListener('pointerup', this.#handlePointerUp);
        stage.addEventListener('pointercancel', this.#handlePointerUp);
        document.addEventListener('keydown', this.#handleDocumentKeydown, true);
        document.addEventListener('keyup', this.#handleDocumentKeyup, true);

        this.#updateTransform();
        this.#fitSoon(visual.node);
        window.setTimeout(() => {
            chrome.closeButton.focus({
                preventScroll: true,
            });
        }, 0);
    }

    close(): void {
        if (!this.#overlay) return;

        this.#overlay.remove();
        this.#overlay = null;
        this.#stage = null;
        this.#frame = null;
        this.#content = null;
        this.#scaleLabel = null;
        this.#scaleInput = null;
        this.#pointers.clear();
        this.#drag = null;
        this.#pinch = null;
        this.#clearMarquee();
        this.#setZoomToolActive(false);
        this.#setZoomOutToolActive(false);
        closeShortcutsHelp(true);
        document.body.classList.remove('markon-visual-zoom-open');
        document.removeEventListener('keydown', this.#handleDocumentKeydown, true);
        document.removeEventListener('keyup', this.#handleDocumentKeyup, true);
    }

    get isOpen(): boolean {
        return Boolean(this.#overlay);
    }

    #decorate(element: VisualElement, title: string): void {
        element.classList.add('markon-visual-zoomable');
        if (element instanceof HTMLElement && element.classList.contains('markon-diagram')) {
            element.classList.add('markon-visual-zoom-host');
            this.#ensureTrigger(element, title);
            return;
        }

        const shell = this.#ensureVisualShell(element);
        shell.classList.add('markon-visual-zoom-host');
        this.#ensureTrigger(shell, title);
    }

    #handleContentClick = (event: MouseEvent): void => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
            return;
        }
        const button = this.#triggerFromEvent(event.target);
        if (!button) return;
        const element = this.#targetFromTrigger(button);
        if (!element) return;
        event.preventDefault();
        event.stopPropagation();
        this.open(element);
    };

    #handleContentKeydown = (event: KeyboardEvent): void => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const button = this.#triggerFromEvent(event.target);
        if (!button) return;
        const element = this.#targetFromTrigger(button);
        if (!element) return;
        event.preventDefault();
        event.stopPropagation();
        this.open(element);
    };

    #handleOverlayClick = (event: MouseEvent): void => {
        if (event.target === this.#overlay) {
            event.preventDefault();
            this.close();
        }
    };

    #handleCloseClick = (event: MouseEvent): void => {
        event.preventDefault();
        event.stopPropagation();
        this.close();
    };

    #handleControlsClick = (event: MouseEvent): void => {
        const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-visual-zoom-action]');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();

        switch (button.dataset['visualZoomAction']) {
            case 'reset':
                this.#reset();
                break;
            case 'fit':
                this.#fit();
                break;
        }
    };

    #handleControlsInput = (event: Event): void => {
        const input = (event.target as Element | null)?.closest<HTMLInputElement>('.markon-visual-zoom-slider');
        if (!input) return;
        event.preventDefault();
        event.stopPropagation();
        this.#zoomFromCenter(sliderValueToScale(input.value));
    };

    #handleDocumentKeydown = (event: KeyboardEvent): void => {
        if (!this.#overlay) return;
        if (document.querySelector('.shortcuts-help-panel')) {
            if (event.key === 'Escape' || event.key === '?' || (event.key === '/' && event.shiftKey)) {
                event.preventDefault();
                event.stopPropagation();
                closeShortcutsHelp(true);
            }
            return;
        }

        if (matchesShortcut(event, 'VISUAL_ZOOM_CLOSE')) {
            event.preventDefault();
            event.stopPropagation();
            this.close();
            return;
        }

        if (matchesShortcut(event, 'HELP')) {
            event.preventDefault();
            event.stopPropagation();
            this.#showHelp();
            return;
        }

        if (matchesShortcut(event, 'VISUAL_ZOOM_TOOL')) {
            event.preventDefault();
            event.stopPropagation();
            this.#setZoomToolActive(true);
            this.#setZoomOutToolActive(false);
            return;
        }

        if (matchesShortcut(event, 'VISUAL_ZOOM_TOOL_OUT')) {
            event.preventDefault();
            event.stopPropagation();
            this.#setZoomToolActive(true);
            this.#setZoomOutToolActive(true);
            return;
        }

        if (matchesShortcut(event, 'VISUAL_ZOOM_FIT_CMD')) {
            event.preventDefault();
            event.stopPropagation();
            this.#fit();
            return;
        }

        if (matchesShortcut(event, 'VISUAL_ZOOM_IN') || matchesShortcut(event, 'VISUAL_ZOOM_IN_ALT')) {
            event.preventDefault();
            event.stopPropagation();
            this.#zoomFromCenter(this.#scale * ZOOM_STEP);
        } else if (matchesShortcut(event, 'VISUAL_ZOOM_OUT')) {
            event.preventDefault();
            event.stopPropagation();
            this.#zoomFromCenter(this.#scale / ZOOM_STEP);
        } else if (matchesShortcut(event, 'VISUAL_ZOOM_RESET') || matchesShortcut(event, 'VISUAL_ZOOM_RESET_ALT')) {
            event.preventDefault();
            event.stopPropagation();
            this.#reset();
        } else if (matchesShortcut(event, 'VISUAL_ZOOM_FIT')) {
            event.preventDefault();
            event.stopPropagation();
            this.#fit();
        } else if (!event.ctrlKey && !event.metaKey) {
            event.stopPropagation();
        }
    };

    #handleDocumentKeyup = (event: KeyboardEvent): void => {
        if (!this.#overlay) return;
        if (event.key.toLowerCase() !== 'z') return;
        event.preventDefault();
        event.stopPropagation();
        this.#setZoomToolActive(false);
        this.#setZoomOutToolActive(false);
    };

    #handleWheel = (event: WheelEvent): void => {
        if (!this.#stage) return;
        event.preventDefault();
        event.stopPropagation();
        const delta = normalizedWheelDelta(event);
        if (!delta) return;
        const factor = Math.pow(WHEEL_ZOOM_PER_100PX, -delta / 100);
        this.#zoomAt(clamp(this.#scale * factor), eventPoint(event));
    };

    #handleDoubleClick = (event: MouseEvent): void => {
        event.preventDefault();
        this.#reset();
    };

    #handlePointerDown = (event: PointerEvent): void => {
        if (
            (event.pointerType === 'mouse' && event.button !== 0) ||
            (event.target as Element | null)?.closest(
                '.markon-visual-zoom-controls, .markon-visual-zoom-corner-button',
            )
        ) {
            return;
        }
        if (!this.#stage) return;
        event.preventDefault();
        event.stopPropagation();
        this.#stage.setPointerCapture?.(event.pointerId);

        if (this.#zoomToolActive) {
            this.#beginMarquee(event);
            return;
        }

        this.#pointers.set(event.pointerId, eventPoint(event));

        if (this.#pointers.size >= 2) {
            this.#beginPinch();
        } else {
            this.#drag = {
                id: event.pointerId,
                start: eventPoint(event),
                pan: { ...this.#pan },
            };
        }
    };

    #handlePointerMove = (event: PointerEvent): void => {
        if (this.#marquee && this.#marquee.id === event.pointerId) {
            event.preventDefault();
            event.stopPropagation();
            this.#updateMarquee(event);
            return;
        }

        if (!this.#pointers.has(event.pointerId)) return;
        event.preventDefault();
        event.stopPropagation();
        this.#pointers.set(event.pointerId, eventPoint(event));

        if (this.#pointers.size >= 2) {
            this.#updatePinch();
            return;
        }

        if (!this.#drag || this.#drag.id !== event.pointerId) return;
        const point = eventPoint(event);
        this.#pan = {
            x: this.#drag.pan.x + point.x - this.#drag.start.x,
            y: this.#drag.pan.y + point.y - this.#drag.start.y,
        };
        this.#updateTransform();
    };

    #handlePointerUp = (event: PointerEvent): void => {
        if (this.#marquee && this.#marquee.id === event.pointerId) {
            event.preventDefault();
            event.stopPropagation();
            this.#finishMarquee(event);
            return;
        }

        if (!this.#pointers.has(event.pointerId)) return;
        this.#stage?.releasePointerCapture?.(event.pointerId);
        this.#pointers.delete(event.pointerId);
        this.#pinch = null;
        this.#drag = null;

        if (this.#pointers.size >= 2) {
            this.#beginPinch();
        } else if (this.#pointers.size === 1) {
            const first = Array.from(this.#pointers.entries())[0];
            if (!first) return;
            const [id, point] = first;
            this.#drag = { id, start: point, pan: { ...this.#pan } };
        }
    };

    #beginPinch(): void {
        const points = Array.from(this.#pointers.values());
        if (points.length < 2) return;
        const [first, second] = points;
        if (!first || !second) return;
        this.#pinch = {
            distance: Math.max(1, pointsDistance(first, second)),
            midpoint: pointsMidpoint(first, second),
            pan: { ...this.#pan },
            scale: this.#scale,
        };
        this.#drag = null;
    }

    #updatePinch(): void {
        if (!this.#pinch || !this.#stage) return;
        const points = Array.from(this.#pointers.values());
        if (points.length < 2) return;
        const [first, second] = points;
        if (!first || !second) return;

        const midpoint = pointsMidpoint(first, second);
        const distance = Math.max(1, pointsDistance(first, second));
        const nextScale = clamp(this.#pinch.scale * (distance / this.#pinch.distance));
        const stageCenter = this.#stageCenter();
        const contentX = (this.#pinch.midpoint.x - stageCenter.x - this.#pinch.pan.x) / this.#pinch.scale;
        const contentY = (this.#pinch.midpoint.y - stageCenter.y - this.#pinch.pan.y) / this.#pinch.scale;

        this.#scale = nextScale;
        this.#pan = {
            x: midpoint.x - stageCenter.x - contentX * nextScale,
            y: midpoint.y - stageCenter.y - contentY * nextScale,
        };
        this.#updateTransform();
    }

    #ensureVisualShell(element: VisualElement): HTMLElement {
        const link = element.closest<HTMLAnchorElement>('a');
        const target = link && this.#contentRoot.contains(link) ? link : element;
        const existingShell = target.parentElement?.classList.contains('markon-visual-zoom-shell')
            ? target.parentElement
            : null;
        if (existingShell) {
            this.#syncVisualShellSize(existingShell, target, element);
            return existingShell;
        }

        const shell = document.createElement('span');
        shell.className = 'markon-visual-zoom-shell';
        this.#syncVisualShellSize(shell, target, element);
        target.before(shell);
        shell.appendChild(target);
        if (element instanceof HTMLImageElement && !element.complete) {
            element.addEventListener('load', () => this.#syncVisualShellSize(shell, target, element), { once: true });
        }
        return shell;
    }

    #syncVisualShellSize(shell: HTMLElement, target: Element, visual: VisualElement): void {
        const width = this.#visualShellWidth(target, visual);
        if (width > 0) {
            shell.style.width = `${width}px`;
        }
    }

    #visualShellWidth(target: Element, visual: VisualElement): number {
        if (visual instanceof HTMLImageElement) {
            const attrWidth = visual.getAttribute('width');
            const parsedAttrWidth = attrWidth ? Number.parseFloat(attrWidth) : 0;
            if (parsedAttrWidth > 0) return parsedAttrWidth;
            if (this.#isSvgImage(visual) && visual.naturalWidth > 0) return visual.naturalWidth;
        }

        const rectWidth = target.getBoundingClientRect().width;
        if (rectWidth > 0) return rectWidth;

        if (visual instanceof HTMLImageElement) {
            if (visual.naturalWidth > 0) return visual.naturalWidth;
        }

        if (visual instanceof SVGSVGElement) {
            const attrWidth = visual.getAttribute('width');
            const parsedAttrWidth = attrWidth ? Number.parseFloat(attrWidth) : 0;
            if (parsedAttrWidth > 0) return parsedAttrWidth;
            const viewBox = parseViewBox(visual.getAttribute('viewBox'));
            if (viewBox && viewBox.width > 0) return viewBox.width;
        }

        return 0;
    }

    #isSvgImage(image: HTMLImageElement): boolean {
        const source = image.currentSrc || image.src || image.getAttribute('src') || '';
        const path = source.split(/[?#]/, 1)[0]?.toLowerCase() ?? '';
        return path.endsWith('.svg') || source.toLowerCase().startsWith('data:image/svg+xml');
    }

    #ensureTrigger(host: HTMLElement, title: string): void {
        let button = Array.from(host.children).find(
            (child): child is HTMLButtonElement =>
                child instanceof HTMLButtonElement && child.matches('[data-visual-zoom-trigger]'),
        ) ?? null;
        if (!button) {
            button = document.createElement('button');
            button.type = 'button';
            button.className = 'markon-visual-zoom-trigger';
            button.dataset['visualZoomTrigger'] = 'true';
            button.innerHTML = `
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <polyline points="15 3 21 3 21 9"></polyline>
                    <polyline points="9 21 3 21 3 15"></polyline>
                    <line x1="21" y1="3" x2="14" y2="10"></line>
                    <line x1="3" y1="21" x2="10" y2="14"></line>
                </svg>
            `;
            host.appendChild(button);
        }
        button.title = title;
        button.setAttribute('aria-label', title);
    }

    #triggerFromEvent(target: EventTarget | null): HTMLButtonElement | null {
        const element = target instanceof Element ? target : null;
        if (!element || !this.#contentRoot.contains(element)) return null;
        const button = element.closest<HTMLButtonElement>('[data-visual-zoom-trigger]');
        return button && this.#contentRoot.contains(button) ? button : null;
    }

    #targetFromTrigger(button: HTMLButtonElement): VisualElement | null {
        const diagram = button.closest<HTMLElement>('.markon-diagram.markon-visual-zoomable');
        if (diagram && this.#contentRoot.contains(diagram)) return diagram;

        const shell = button.closest<HTMLElement>('.markon-visual-zoom-shell');
        const visual = shell?.querySelector('img.markon-visual-zoomable, svg.markon-visual-zoomable') ?? null;
        if (!visual || !this.#contentRoot.contains(visual) || !this.#isStandaloneVisual(visual)) {
            return null;
        }
        return visual as VisualElement;
    }

    #isStandaloneVisual(element: Element): boolean {
        if (element.closest('.markon-diagram, .markon-visual-zoom-overlay')) return false;
        if (element.closest(INTERACTIVE_SELECTOR) && !element.closest('a')) return false;
        if (element.matches('[data-markon-no-zoom], [aria-hidden="true"], .octicon')) return false;
        if (element.tagName.toLowerCase() === 'svg' && element.closest('.markdown-alert')) return false;
        return element instanceof HTMLImageElement || element instanceof SVGSVGElement;
    }

    #visualFromElement(element: VisualElement): ZoomVisual | null {
        if (element.classList.contains('markon-diagram')) {
            const canvas = element.querySelector<HTMLElement>('.markon-diagram-canvas');
            if (!canvas) return null;
            const clone = canvas.cloneNode(true) as HTMLElement;
            clone.removeAttribute('id');
            return {
                kind: 'diagram',
                element,
                label: this.#diagramLabel(element),
                node: clone,
            };
        }

        if (element instanceof HTMLImageElement) {
            const image = new Image();
            image.src = element.currentSrc || element.src;
            image.alt = element.alt || '';
            image.draggable = false;
            if (element.title) image.title = element.title;
            if (element.naturalWidth > 0) image.width = element.naturalWidth;
            if (element.naturalHeight > 0) image.height = element.naturalHeight;
            return {
                kind: 'image',
                element,
                label: element.alt || element.title || label('web.visual.zoom.image', 'Image'),
                node: image,
            };
        }

        if (element instanceof SVGSVGElement) {
            const clone = element.cloneNode(true) as SVGSVGElement;
            clone.removeAttribute('id');
            return {
                kind: 'svg',
                element,
                label: element.getAttribute('aria-label') || element.querySelector('title')?.textContent || label('web.visual.zoom.svg', 'SVG'),
                node: clone,
            };
        }

        return null;
    }

    #diagramLabel(element: VisualElement): string {
        const engine = element instanceof HTMLElement ? element.dataset['diagramEngine'] : '';
        return engine
            ? `${label('web.visual.zoom.diagram', 'Diagram')}: ${engine}`
            : label('web.visual.zoom.diagram', 'Diagram');
    }

    #zoomFromCenter(nextScale: number): void {
        if (!this.#stage) return;
        this.#zoomAt(clamp(nextScale), this.#stageCenter());
    }

    #beginMarquee(event: PointerEvent): void {
        if (!this.#stage) return;
        const point = eventPoint(event);
        this.#clearMarquee();
        this.#marquee = {
            id: event.pointerId,
            start: point,
            current: point,
            zoomOut: this.#zoomOutToolActive,
        };
        const marqueeElement = document.createElement('div');
        marqueeElement.className = 'markon-visual-zoom-marquee';
        marqueeElement.setAttribute('aria-hidden', 'true');
        this.#stage.appendChild(marqueeElement);
        this.#marqueeElement = marqueeElement;
        this.#updateMarqueeElement();
    }

    #updateMarquee(event: PointerEvent): void {
        if (!this.#marquee) return;
        this.#marquee.current = eventPoint(event);
        this.#marquee.zoomOut = this.#zoomOutToolActive;
        this.#updateMarqueeElement();
    }

    #finishMarquee(event: PointerEvent): void {
        if (!this.#marquee) return;
        this.#updateMarquee(event);
        const { start, current, zoomOut } = this.#marquee;
        const rect = rectFromPoints(start, current);
        this.#stage?.releasePointerCapture?.(event.pointerId);
        this.#clearMarquee();

        if (rect.width < MARQUEE_MIN_SIZE || rect.height < MARQUEE_MIN_SIZE) {
            this.#zoomAt(this.#scale * (zoomOut ? 1 / ZOOM_STEP : ZOOM_STEP), current);
            return;
        }

        this.#zoomToRect(rect);
    }

    #clearMarquee(): void {
        this.#marqueeElement?.remove();
        this.#marqueeElement = null;
        this.#marquee = null;
    }

    #updateMarqueeElement(): void {
        if (!this.#stage || !this.#marqueeElement || !this.#marquee) return;
        const stageRect = this.#stage.getBoundingClientRect();
        const rect = rectFromPoints(this.#marquee.start, this.#marquee.current);
        const left = Math.max(0, rect.left - stageRect.left);
        const top = Math.max(0, rect.top - stageRect.top);
        const right = Math.min(stageRect.width, rect.right - stageRect.left);
        const bottom = Math.min(stageRect.height, rect.bottom - stageRect.top);
        this.#marqueeElement.style.left = `${left}px`;
        this.#marqueeElement.style.top = `${top}px`;
        this.#marqueeElement.style.width = `${Math.max(0, right - left)}px`;
        this.#marqueeElement.style.height = `${Math.max(0, bottom - top)}px`;
    }

    #zoomToRect(rect: DOMRect): void {
        if (!this.#stage) return;
        const stageRect = this.#stage.getBoundingClientRect();
        if (!stageRect.width || !stageRect.height) return;

        const center = this.#stageCenter();
        const selectedCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        const contentCenter = {
            x: (selectedCenter.x - center.x - this.#pan.x) / this.#scale,
            y: (selectedCenter.y - center.y - this.#pan.y) / this.#scale,
        };
        const nextScale = clamp(
            this.#scale * Math.min((stageRect.width * FIT_RATIO) / rect.width, (stageRect.height * FIT_RATIO) / rect.height),
        );
        this.#scale = nextScale;
        this.#pan = {
            x: -contentCenter.x * nextScale,
            y: -contentCenter.y * nextScale,
        };
        this.#updateTransform();
    }

    #zoomAt(nextScale: number, point: Point): void {
        if (!this.#stage) return;
        const previous = this.#scale;
        const next = clamp(nextScale);
        if (previous === next) return;

        const center = this.#stageCenter();
        const ratio = next / previous;
        this.#pan = {
            x: point.x - center.x - (point.x - center.x - this.#pan.x) * ratio,
            y: point.y - center.y - (point.y - center.y - this.#pan.y) * ratio,
        };
        this.#scale = next;
        this.#updateTransform();
    }

    #reset(): void {
        this.#scale = DEFAULT_SCALE;
        this.#pan = { x: 0, y: 0 };
        this.#updateTransform();
    }

    #fit(): void {
        if (!this.#stage || !this.#content) return;
        const stageRect = this.#stage.getBoundingClientRect();
        const contentRect = this.#content.getBoundingClientRect();
        const width = contentRect.width / this.#scale;
        const height = contentRect.height / this.#scale;
        if (!width || !height) {
            this.#reset();
            return;
        }

        this.#scale = clamp(Math.min((stageRect.width * FIT_RATIO) / width, (stageRect.height * FIT_RATIO) / height));
        this.#pan = { x: 0, y: 0 };
        this.#updateTransform();
    }

    #fitSoon(node: Element): void {
        const fit = (): void => this.#fit();
        if (node instanceof HTMLImageElement) {
            if (!node.complete) {
                node.addEventListener('load', fit, { once: true });
            }
            if (typeof node.decode === 'function') {
                void node.decode().then(fit).catch(() => {});
            }
        }
        if (typeof window.requestAnimationFrame === 'function') {
            window.requestAnimationFrame(fit);
        } else {
            window.setTimeout(fit, 0);
        }
    }

    #setZoomToolActive(active: boolean): void {
        this.#zoomToolActive = active;
        this.#overlay?.classList.toggle('is-zoom-tool-active', active);
    }

    #setZoomOutToolActive(active: boolean): void {
        this.#zoomOutToolActive = active;
        this.#overlay?.classList.toggle('is-zoom-out-tool-active', this.#zoomToolActive && active);
    }

    #showHelp(): void {
        openShortcutsHelp(VISUAL_SHORTCUTS, (name) => {
            switch (name) {
                case 'VISUAL_ZOOM_IN':
                case 'VISUAL_ZOOM_IN_ALT':
                    this.#zoomFromCenter(this.#scale * ZOOM_STEP);
                    break;
                case 'VISUAL_ZOOM_OUT':
                    this.#zoomFromCenter(this.#scale / ZOOM_STEP);
                    break;
                case 'VISUAL_ZOOM_RESET':
                case 'VISUAL_ZOOM_RESET_ALT':
                    this.#reset();
                    break;
                case 'VISUAL_ZOOM_FIT':
                case 'VISUAL_ZOOM_FIT_CMD':
                    this.#fit();
                    break;
                case 'VISUAL_ZOOM_TOOL':
                    this.#setZoomToolActive(true);
                    this.#setZoomOutToolActive(false);
                    break;
                case 'VISUAL_ZOOM_TOOL_OUT':
                    this.#setZoomToolActive(true);
                    this.#setZoomOutToolActive(true);
                    break;
                case 'VISUAL_ZOOM_CLOSE':
                    this.close();
                    break;
                case 'HELP':
                    this.#showHelp();
                    break;
            }
        });
    }

    #createChrome(): {
        closeButton: HTMLButtonElement;
        controls: HTMLDivElement;
    } {
        const reset = `${label('web.visual.zoom.reset', 'Reset')} (0/R)`;
        const fit = `${label('web.visual.zoom.fit', 'Fit')} (F, Cmd/Ctrl+0)`;
        const close = `${label('web.visual.zoom.close', 'Close')} (Esc)`;

        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'markon-visual-zoom-corner-button markon-visual-zoom-close';
        closeButton.title = close;
        closeButton.setAttribute('aria-label', close);
        closeButton.innerHTML = `
            <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
                <path d="M2 32c.512 0 1.023-.195 1.414-.586l7.121-7.121v2.128a2 2 0 0 0 4 0v-6.956a2 2 0 0 0-2-2H5.579a2 2 0 0 0 0 4h2.128L.586 28.587A2 2 0 0 0 2 32zM28.586.586l-7.121 7.121V5.58a2 2 0 0 0-4 0v6.956a2 2 0 0 0 2 2h6.956a2 2 0 0 0 0-4h-2.128l7.121-7.122A2 2 0 1 0 28.586.586z"></path>
            </svg>
        `;

        const controls = document.createElement('div');
        controls.className = 'markon-visual-zoom-controls';
        controls.innerHTML = `
            <span class="markon-visual-zoom-scale">100%</span>
            <input
                class="markon-visual-zoom-slider"
                type="range"
                min="0"
                max="${SCALE_SLIDER_STEPS}"
                step="1"
                value="${scaleToSliderValue(DEFAULT_SCALE)}"
                aria-label="${label('web.visual.zoom.slider', 'Zoom scale')}"
            >
            <button class="markon-visual-zoom-icon-action" type="button" data-visual-zoom-action="reset" title="${reset}" aria-label="${reset}">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M4.5 4.5v5h5"></path>
                    <path d="M5.1 9.5a7 7 0 1 1 1.8 6.7"></path>
                </svg>
            </button>
            <button class="markon-visual-zoom-icon-action" type="button" data-visual-zoom-action="fit" title="${fit}" aria-label="${fit}">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M8 3H3v5"></path>
                    <path d="M16 3h5v5"></path>
                    <path d="M8 21H3v-5"></path>
                    <path d="M16 21h5v-5"></path>
                </svg>
            </button>
        `;

        return { closeButton, controls };
    }

    #stageCenter(): Point {
        const rect = this.#stage?.getBoundingClientRect();
        if (!rect) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }

    #updateTransform(): void {
        if (this.#frame) {
            this.#frame.style.transform = `translate(-50%, -50%) translate(${this.#pan.x}px, ${this.#pan.y}px)`;
        }
        if (this.#content) {
            this.#content.style.transform = `scale(${this.#scale})`;
        }
        if (this.#scaleLabel) {
            this.#scaleLabel.textContent = `${Math.round(this.#scale * 100)}%`;
        }
        if (this.#scaleInput) {
            this.#scaleInput.value = scaleToSliderValue(this.#scale);
        }
    }
}
