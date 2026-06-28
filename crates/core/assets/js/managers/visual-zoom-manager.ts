import { i18n } from '../core/config';

type VisualElement = HTMLElement | HTMLImageElement | SVGSVGElement;

type Point = {
    x: number;
    y: number;
};

type DragState = {
    id: number;
    start: Point;
    pan: Point;
};

type PinchState = {
    distance: number;
    midpoint: Point;
    pan: Point;
    scale: number;
};

type ZoomVisual = {
    kind: 'diagram' | 'image' | 'svg';
    element: VisualElement;
    label: string;
    node: Element;
};

const MIN_SCALE = 0.1;
const MAX_SCALE = 5;
const DEFAULT_SCALE = 1.5;

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

function label(key: string, fallback: string): string {
    const value = i18n.t(key);
    return value === key ? fallback : value;
}

export class VisualZoomManager {
    #markdownBody: HTMLElement;
    #contentRoot: HTMLElement;
    #overlay: HTMLDivElement | null = null;
    #stage: HTMLDivElement | null = null;
    #frame: HTMLDivElement | null = null;
    #content: HTMLDivElement | null = null;
    #scaleLabel: HTMLSpanElement | null = null;
    #scale = DEFAULT_SCALE;
    #pan: Point = { x: 0, y: 0 };
    #pointers = new Map<number, Point>();
    #drag: DragState | null = null;
    #pinch: PinchState | null = null;
    #initialized = false;

    constructor(markdownBody: HTMLElement) {
        this.#markdownBody = markdownBody;
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
        this.#contentRoot.querySelectorAll<HTMLElement>('.markon-diagram').forEach((diagram) => {
            this.#decorate(diagram, label('web.visual.zoom.open', 'Open visual viewer'));
        });

        this.#contentRoot.querySelectorAll<Element>('img, svg').forEach((visual) => {
            if (!this.#isStandaloneVisual(visual)) return;
            this.#decorate(visual as VisualElement, label('web.visual.zoom.open', 'Open visual viewer'));
        });
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

        const toolbar = document.createElement('div');
        toolbar.className = 'markon-visual-zoom-toolbar';
        toolbar.innerHTML = `
            <span class="markon-visual-zoom-title"></span>
            <button type="button" data-visual-zoom-action="out" title="${label('web.visual.zoom.out', 'Zoom out')}">-</button>
            <span class="markon-visual-zoom-scale">150%</span>
            <button type="button" data-visual-zoom-action="in" title="${label('web.visual.zoom.in', 'Zoom in')}">+</button>
            <button type="button" data-visual-zoom-action="reset">${label('web.visual.zoom.reset', 'Reset')}</button>
            <button type="button" data-visual-zoom-action="fit">${label('web.visual.zoom.fit', 'Fit')}</button>
            <button type="button" data-visual-zoom-action="close">${label('web.visual.zoom.close', 'Close')}</button>
        `;

        const title = toolbar.querySelector<HTMLElement>('.markon-visual-zoom-title');
        if (title) title.textContent = visual.label;
        this.#scaleLabel = toolbar.querySelector<HTMLSpanElement>('.markon-visual-zoom-scale');

        const stage = document.createElement('div');
        stage.className = 'markon-visual-zoom-stage';

        const frame = document.createElement('div');
        frame.className = 'markon-visual-zoom-frame';

        const content = document.createElement('div');
        content.className = `markon-visual-zoom-content markon-visual-zoom-content-${visual.kind}`;
        content.appendChild(visual.node);

        frame.appendChild(content);
        stage.appendChild(frame);
        overlay.append(toolbar, stage);
        document.body.appendChild(overlay);

        this.#overlay = overlay;
        this.#stage = stage;
        this.#frame = frame;
        this.#content = content;
        document.body.classList.add('markon-visual-zoom-open');

        toolbar.addEventListener('click', this.#handleToolbarClick);
        overlay.addEventListener('click', this.#handleOverlayClick);
        stage.addEventListener('wheel', this.#handleWheel, { passive: false });
        stage.addEventListener('dblclick', this.#handleDoubleClick);
        stage.addEventListener('pointerdown', this.#handlePointerDown);
        stage.addEventListener('pointermove', this.#handlePointerMove);
        stage.addEventListener('pointerup', this.#handlePointerUp);
        stage.addEventListener('pointercancel', this.#handlePointerUp);
        document.addEventListener('keydown', this.#handleDocumentKeydown, true);

        this.#updateTransform();
        window.setTimeout(() => {
            toolbar.querySelector<HTMLButtonElement>('[data-visual-zoom-action="close"]')?.focus({
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
        this.#pointers.clear();
        this.#drag = null;
        this.#pinch = null;
        document.body.classList.remove('markon-visual-zoom-open');
        document.removeEventListener('keydown', this.#handleDocumentKeydown, true);
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

    #handleToolbarClick = (event: MouseEvent): void => {
        const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-visual-zoom-action]');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();

        switch (button.dataset.visualZoomAction) {
            case 'in':
                this.#zoomFromCenter(this.#scale * 1.2);
                break;
            case 'out':
                this.#zoomFromCenter(this.#scale / 1.2);
                break;
            case 'reset':
                this.#reset();
                break;
            case 'fit':
                this.#fit();
                break;
            case 'close':
                this.close();
                break;
        }
    };

    #handleDocumentKeydown = (event: KeyboardEvent): void => {
        if (!this.#overlay) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            this.close();
            return;
        }

        if (event.key === '+' || event.key === '=') {
            event.preventDefault();
            this.#zoomFromCenter(this.#scale * 1.2);
        } else if (event.key === '-') {
            event.preventDefault();
            this.#zoomFromCenter(this.#scale / 1.2);
        } else if (event.key === '0') {
            event.preventDefault();
            this.#reset();
        }
    };

    #handleWheel = (event: WheelEvent): void => {
        if (!this.#stage) return;
        event.preventDefault();
        const factor = event.deltaY < 0 ? 1.12 : 0.88;
        this.#zoomAt(clamp(this.#scale * factor), eventPoint(event));
    };

    #handleDoubleClick = (event: MouseEvent): void => {
        event.preventDefault();
        this.#reset();
    };

    #handlePointerDown = (event: PointerEvent): void => {
        if ((event.pointerType === 'mouse' && event.button !== 0) || (event.target as Element | null)?.closest('.markon-visual-zoom-toolbar')) {
            return;
        }
        if (!this.#stage) return;
        event.preventDefault();
        this.#stage.setPointerCapture?.(event.pointerId);
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
        if (!this.#pointers.has(event.pointerId)) return;
        event.preventDefault();
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
        if (!this.#pointers.has(event.pointerId)) return;
        this.#stage?.releasePointerCapture?.(event.pointerId);
        this.#pointers.delete(event.pointerId);
        this.#pinch = null;
        this.#drag = null;

        if (this.#pointers.size >= 2) {
            this.#beginPinch();
        } else if (this.#pointers.size === 1) {
            const [id, point] = Array.from(this.#pointers.entries())[0];
            this.#drag = { id, start: point, pan: { ...this.#pan } };
        }
    };

    #beginPinch(): void {
        const points = Array.from(this.#pointers.values());
        if (points.length < 2) return;
        this.#pinch = {
            distance: Math.max(1, pointsDistance(points[0], points[1])),
            midpoint: pointsMidpoint(points[0], points[1]),
            pan: { ...this.#pan },
            scale: this.#scale,
        };
        this.#drag = null;
    }

    #updatePinch(): void {
        if (!this.#pinch || !this.#stage) return;
        const points = Array.from(this.#pointers.values());
        if (points.length < 2) return;

        const midpoint = pointsMidpoint(points[0], points[1]);
        const distance = Math.max(1, pointsDistance(points[0], points[1]));
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
        if (existingShell) return existingShell;

        const shell = document.createElement('span');
        shell.className = 'markon-visual-zoom-shell';
        target.before(shell);
        shell.appendChild(target);
        return shell;
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
            button.dataset.visualZoomTrigger = 'true';
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
        const visual = shell?.querySelector<Element>('img.markon-visual-zoomable, svg.markon-visual-zoomable') ?? null;
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
        const engine = element instanceof HTMLElement ? element.dataset.diagramEngine : '';
        return engine
            ? `${label('web.visual.zoom.diagram', 'Diagram')}: ${engine}`
            : label('web.visual.zoom.diagram', 'Diagram');
    }

    #zoomFromCenter(nextScale: number): void {
        if (!this.#stage) return;
        this.#zoomAt(clamp(nextScale), this.#stageCenter());
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

        this.#scale = clamp(Math.min((stageRect.width * 0.86) / width, (stageRect.height * 0.86) / height));
        this.#pan = { x: 0, y: 0 };
        this.#updateTransform();
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
    }
}
