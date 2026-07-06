import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { VisualZoomManager } from './visual-zoom-manager';
import { KeyboardShortcutsManager } from './keyboard-shortcuts';

function seedMarkdown(html: string): HTMLElement {
    document.body.innerHTML = `<article class="markdown-body"><div id="main-content">${html}</div></article>`;
    return document.querySelector<HTMLElement>('.markdown-body')!;
}

function click(element: Element): void {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
}

function keydown(element: Element | Document, key: string, options: KeyboardEventInit = {}): void {
    element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...options }));
}

function keyup(element: Element | Document, key: string): void {
    element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key }));
}

function pointer(type: string, target: Element, options: PointerEventInit): void {
    const EventCtor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
    target.dispatchEvent(new EventCtor(type, { bubbles: true, cancelable: true, pointerId: 1, ...options }));
}

function wheel(target: Element, options: WheelEventInit): void {
    target.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ...options }));
}

describe('VisualZoomManager', () => {
    let manager: VisualZoomManager;

    beforeEach(() => {
        document.head.innerHTML = '';
        document.body.innerHTML = '';
        delete window.visualZoomManager;
        delete window.shortcutsManager;
    });

    afterEach(() => {
        manager?.dispose();
        document.body.innerHTML = '';
    });

    it('decorates markdown images with a corner trigger and opens only from that trigger', () => {
        const body = seedMarkdown('<p><img src="/assets/diagram.svg" alt="Architecture"></p>');
        manager = new VisualZoomManager(body);
        manager.init();

        const img = document.querySelector<HTMLImageElement>('img')!;
        expect(img.classList.contains('markon-visual-zoomable')).toBe(true);
        expect(img.getAttribute('role')).toBeNull();

        click(img);
        expect(document.querySelector('.markon-visual-zoom-overlay')).toBeNull();

        const trigger = document.querySelector<HTMLButtonElement>('[data-visual-zoom-trigger]')!;
        expect(trigger).not.toBeNull();
        expect(trigger.getAttribute('aria-label')).toBe('Open visual viewer');
        click(trigger);

        expect(document.querySelector('.markon-visual-zoom-overlay')).not.toBeNull();
        expect(document.querySelector('.markon-visual-zoom-content-image img')).not.toBeNull();
        expect(document.querySelector('.markon-visual-zoom-title')).toBeNull();
        expect(document.querySelector('.markon-visual-zoom-scale')?.textContent).toBe('100%');
    });

    it('opens the whole diagram container from the diagram corner trigger', () => {
        const body = seedMarkdown(`
            <div class="markon-diagram" data-diagram-engine="mermaid">
                <div class="markon-diagram-canvas">
                    <svg viewBox="0 0 120 80"><rect width="120" height="80"></rect></svg>
                </div>
            </div>
        `);
        manager = new VisualZoomManager(body);
        manager.init();

        const nestedSvg = document.querySelector<SVGSVGElement>('.markon-diagram svg')!;
        click(nestedSvg);
        expect(document.querySelector('.markon-visual-zoom-overlay')).toBeNull();

        const trigger = document.querySelector<HTMLButtonElement>('.markon-diagram [data-visual-zoom-trigger]')!;
        click(trigger);
        const content = document.querySelector('.markon-visual-zoom-content-diagram');
        expect(content).not.toBeNull();
        expect(content?.querySelector('.markon-diagram-canvas svg')).not.toBeNull();
        expect(document.querySelector('.markon-visual-zoom-title')).toBeNull();
    });

    it('normalizes Mermaid SVG bounds before decorating diagrams', () => {
        const body = seedMarkdown(`
            <div class="markon-diagram" data-diagram-engine="mermaid">
                <div class="markon-diagram-canvas">
                    <svg viewBox="0 0 100 100" width="100" height="100">
                        <g></g>
                    </svg>
                </div>
            </div>
        `);
        const svg = document.querySelector<SVGSVGElement>('.markon-diagram svg')!;
        Object.defineProperty(svg, 'getBBox', {
            configurable: true,
            value: () => ({ x: -10, y: 5, width: 140, height: 120 }),
        });

        manager = new VisualZoomManager(body);
        manager.init();

        expect(svg.getAttribute('viewBox')).toBe('-22 -7 164 144');
        expect(svg.getAttribute('width')).toBe('164');
        expect(svg.getAttribute('height')).toBe('144');
        expect(svg.style.overflow).toBe('visible');
    });

    it('does not normalize non-Mermaid diagram SVG bounds', () => {
        const body = seedMarkdown(`
            <div class="markon-diagram" data-diagram-engine="graphviz">
                <div class="markon-diagram-canvas">
                    <svg viewBox="0 0 100 100" width="100" height="100">
                        <g></g>
                    </svg>
                </div>
            </div>
        `);
        const svg = document.querySelector<SVGSVGElement>('.markon-diagram svg')!;
        Object.defineProperty(svg, 'getBBox', {
            configurable: true,
            value: () => ({ x: -10, y: 5, width: 140, height: 120 }),
        });

        manager = new VisualZoomManager(body);
        manager.init();

        expect(svg.getAttribute('viewBox')).toBe('0 0 100 100');
        expect(svg.getAttribute('width')).toBe('100');
        expect(svg.getAttribute('height')).toBe('100');
    });

    it('supports keyboard open from the corner trigger and Escape close for raw svg visuals', () => {
        const body = seedMarkdown('<svg aria-label="Raw drawing" viewBox="0 0 80 80"><circle cx="40" cy="40" r="20"></circle></svg>');
        manager = new VisualZoomManager(body);
        manager.init();

        const svg = document.querySelector<SVGSVGElement>('svg')!;
        keydown(svg, 'Enter');
        expect(document.querySelector('.markon-visual-zoom-overlay')).toBeNull();

        const trigger = document.querySelector<HTMLButtonElement>('[data-visual-zoom-trigger]')!;
        keydown(trigger, 'Enter');
        expect(document.querySelector('.markon-visual-zoom-content-svg svg')).not.toBeNull();
        keydown(document, 'Escape');
        expect(document.querySelector('.markon-visual-zoom-overlay')).toBeNull();
        expect(document.body.classList.contains('markon-visual-zoom-open')).toBe(false);
    });

    it('ignores decorative alert octicons', () => {
        const body = seedMarkdown(`
            <div class="markdown-alert">
                <svg class="octicon" aria-hidden="true" viewBox="0 0 16 16"></svg>
            </div>
        `);
        manager = new VisualZoomManager(body);
        manager.init();

        const svg = document.querySelector<SVGSVGElement>('svg')!;
        expect(svg.classList.contains('markon-visual-zoomable')).toBe(false);
        click(svg);
        expect(document.querySelector('.markon-visual-zoom-overlay')).toBeNull();
    });

    it('bottom controls reset and the corner close button closes the viewer', () => {
        const body = seedMarkdown('<img src="/assets/diagram.svg" alt="Architecture">');
        manager = new VisualZoomManager(body);
        manager.init();

        click(document.querySelector<HTMLButtonElement>('[data-visual-zoom-trigger]')!);

        keydown(document, '+');
        expect(document.querySelector('.markon-visual-zoom-scale')?.textContent).toBe('120%');

        click(document.querySelector<HTMLButtonElement>('[data-visual-zoom-action="reset"]')!);
        expect(document.querySelector('.markon-visual-zoom-scale')?.textContent).toBe('100%');
        expect(document.querySelector('[data-visual-zoom-action="fit"]')).not.toBeNull();

        click(document.querySelector<HTMLButtonElement>('.markon-visual-zoom-close')!);
        expect(document.querySelector('.markon-visual-zoom-overlay')).toBeNull();
    });

    it('reuses the global shortcuts panel and lets Escape close help before the viewer', () => {
        const body = seedMarkdown('<img src="/assets/diagram.svg" alt="Architecture">');
        const shortcuts = new KeyboardShortcutsManager();
        shortcuts.register('HELP', () => shortcuts.showHelp());
        shortcuts.register('SEARCH', () => {});
        shortcuts.register('EDIT', () => {});
        shortcuts.register('TOGGLE_VIEWED', () => {});
        window.shortcutsManager = shortcuts;

        manager = new VisualZoomManager(body);
        manager.init();

        click(document.querySelector<HTMLButtonElement>('[data-visual-zoom-trigger]')!);
        expect(document.querySelector('.markon-visual-zoom-help')).toBeNull();

        keydown(document, '?');
        const help = document.querySelector<HTMLElement>('.shortcuts-help-panel')!;
        expect(help).not.toBeNull();
        expect(help.textContent).toContain('web.kbd.visual.fit');
        expect(help.textContent).toContain('web.kbd.cat.visual');
        expect(help.textContent).not.toContain('web.kbd.visual.actual');
        expect(help.textContent).not.toContain('web.kbd.search');
        expect(help.textContent).not.toContain('web.kbd.edit');
        expect(help.textContent).not.toContain('web.kbd.viewed');

        keydown(document, 'Meta', { metaKey: true });
        keydown(document, 'Shift', { shiftKey: true });
        keydown(document, 'Tab');
        keydown(document, '4', { metaKey: true, shiftKey: true });
        expect(document.querySelector('.shortcuts-help-panel')).not.toBeNull();

        keydown(document, 'Escape');
        expect(document.querySelector('.shortcuts-help-panel')).toBeNull();
        expect(document.querySelector('.markon-visual-zoom-overlay')).not.toBeNull();

        keydown(document, '+');
        expect(document.querySelector('.markon-visual-zoom-scale')?.textContent).toBe('120%');
        keydown(document, '1', { ctrlKey: true });
        expect(document.querySelector('.markon-visual-zoom-scale')?.textContent).toBe('120%');

        keydown(document, '0', { ctrlKey: true });
        expect(document.querySelector('.markon-visual-zoom-scale')?.textContent).toBe('100%');

        keydown(document, 'Escape');
        expect(document.querySelector('.markon-visual-zoom-overlay')).toBeNull();
    });

    it('uses delta-proportional wheel zoom so trackpad events stay gentle', () => {
        const body = seedMarkdown('<img src="/assets/diagram.svg" alt="Architecture">');
        manager = new VisualZoomManager(body);
        manager.init();

        click(document.querySelector<HTMLButtonElement>('[data-visual-zoom-trigger]')!);
        const stage = document.querySelector<HTMLElement>('.markon-visual-zoom-stage')!;

        wheel(stage, { deltaY: -10, clientX: 120, clientY: 120 });
        expect(document.querySelector('.markon-visual-zoom-scale')?.textContent).toBe('101%');

        wheel(stage, { deltaY: 10, clientX: 120, clientY: 120 });
        expect(document.querySelector('.markon-visual-zoom-scale')?.textContent).toBe('100%');
    });

    it('supports Photoshop-style Z zoom tool with Shift+Z as zoom-out modifier', () => {
        const body = seedMarkdown('<img src="/assets/diagram.svg" alt="Architecture">');
        manager = new VisualZoomManager(body);
        manager.init();

        click(document.querySelector<HTMLButtonElement>('[data-visual-zoom-trigger]')!);
        const stage = document.querySelector<HTMLElement>('.markon-visual-zoom-stage')!;

        keydown(document, 'z');
        expect(document.querySelector('.markon-visual-zoom-overlay')?.classList.contains('is-zoom-tool-active')).toBe(true);
        keyup(document, 'z');
        keydown(document, 'Z', { shiftKey: true });
        expect(document.querySelector('.markon-visual-zoom-overlay')?.classList.contains('is-zoom-out-tool-active')).toBe(true);
        keyup(document, 'z');
        expect(document.querySelector('.markon-visual-zoom-overlay')?.classList.contains('is-zoom-out-tool-active')).toBe(false);

        keydown(document, 'z');

        pointer('pointerdown', stage, { clientX: 120, clientY: 120, button: 0 });
        pointer('pointerup', stage, { clientX: 120, clientY: 120, button: 0 });
        expect(document.querySelector('.markon-visual-zoom-scale')?.textContent).toBe('120%');

        keyup(document, 'z');
        keydown(document, 'Z', { shiftKey: true });
        pointer('pointerdown', stage, { clientX: 120, clientY: 120, button: 0 });
        pointer('pointerup', stage, { clientX: 120, clientY: 120, button: 0 });
        expect(document.querySelector('.markon-visual-zoom-scale')?.textContent).toBe('100%');

        keyup(document, 'z');
        expect(document.querySelector('.markon-visual-zoom-overlay')?.classList.contains('is-zoom-tool-active')).toBe(false);
    });
});
