import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { VisualZoomManager } from './visual-zoom-manager';

function seedMarkdown(html: string): HTMLElement {
    document.body.innerHTML = `<article class="markdown-body"><div id="main-content">${html}</div></article>`;
    return document.querySelector<HTMLElement>('.markdown-body')!;
}

function click(element: Element): void {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
}

function keydown(element: Element | Document, key: string): void {
    element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key }));
}

describe('VisualZoomManager', () => {
    let manager: VisualZoomManager;

    beforeEach(() => {
        document.head.innerHTML = '';
        document.body.innerHTML = '';
        delete window.visualZoomManager;
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
        expect(document.querySelector('.markon-visual-zoom-title')?.textContent).toBe('Architecture');
        expect(document.querySelector('.markon-visual-zoom-scale')?.textContent).toBe('150%');
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
        expect(document.querySelector('.markon-visual-zoom-title')?.textContent).toBe('Diagram: mermaid');
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

    it('toolbar buttons zoom and close the viewer', () => {
        const body = seedMarkdown('<img src="/assets/diagram.svg" alt="Architecture">');
        manager = new VisualZoomManager(body);
        manager.init();

        click(document.querySelector<HTMLButtonElement>('[data-visual-zoom-trigger]')!);

        click(document.querySelector<HTMLButtonElement>('[data-visual-zoom-action="in"]')!);
        expect(document.querySelector('.markon-visual-zoom-scale')?.textContent).toBe('180%');

        click(document.querySelector<HTMLButtonElement>('[data-visual-zoom-action="reset"]')!);
        expect(document.querySelector('.markon-visual-zoom-scale')?.textContent).toBe('150%');

        click(document.querySelector<HTMLButtonElement>('[data-visual-zoom-action="close"]')!);
        expect(document.querySelector('.markon-visual-zoom-overlay')).toBeNull();
    });
});
