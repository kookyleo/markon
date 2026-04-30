import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PopoverManager } from './popover-manager';

/**
 * Build a markdown-body container with a paragraph and return both the body
 * and the paragraph's text node so callers can construct ranges over it.
 */
function setupBody(): { body: HTMLElement; paragraph: HTMLParagraphElement; textNode: Text } {
    document.body.innerHTML = '';
    const body = document.createElement('div');
    body.className = 'markdown-body';
    const p = document.createElement('p');
    p.appendChild(document.createTextNode('Hello world this is selectable text.'));
    body.appendChild(p);
    document.body.appendChild(body);

    // Generous viewport so constrainToViewport doesn't clamp.
    Object.defineProperty(window, 'innerWidth', { value: 2000, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 2000, configurable: true });

    return { body, paragraph: p, textNode: p.firstChild as Text };
}

/**
 * Construct a Range over the first N characters of the given text node and
 * stub `getBoundingClientRect` so the popover positioning math has stable
 * input under jsdom (which returns zeroed rects for ranges).
 */
function rangeOver(textNode: Text, length: number): Range {
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, length);
    range.getBoundingClientRect = () =>
        ({
            left: 100,
            right: 200,
            top: 200,
            bottom: 220,
            width: 100,
            height: 20,
            x: 100,
            y: 200,
            toJSON() {
                return this;
            },
        }) as DOMRect;
    return range;
}

describe('PopoverManager', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        localStorage.clear();
    });

    afterEach(() => {
        logSpy.mockRestore();
        document.body.innerHTML = '';
        localStorage.clear();
    });

    it('constructor appends a .selection-popover to <body> with default toolbar', () => {
        const { body } = setupBody();
        const m = new PopoverManager(body);
        const popover = document.querySelector('.selection-popover');
        expect(popover).not.toBeNull();
        // Default annotation toolbar buttons present when nothing is selected/highlighted.
        expect(popover?.querySelector('[data-action="highlight-orange"]')).not.toBeNull();
        // Production CSS sets `display: none` on .selection-popover; under
        // jsdom (no stylesheet) that initial state is achieved by calling hide().
        m.hide();
        expect(m.isVisible()).toBe(false);
    });

    it('show(range) makes the popover visible and positions it near the rect', () => {
        const { body, textNode } = setupBody();
        const m = new PopoverManager(body);
        const range = rangeOver(textNode, 5);

        m.show(range);
        const popover = document.querySelector<HTMLElement>('.selection-popover');
        expect(popover).not.toBeNull();
        expect(m.isVisible()).toBe(true);
        // Position is set as inline style in px.
        expect(popover!.style.left).toMatch(/px$/);
        expect(popover!.style.top).toMatch(/px$/);
        // dataset.originalLeft/Top are seeded for the draggable offset math.
        expect(popover!.dataset.originalLeft).toBeDefined();
        expect(popover!.dataset.originalTop).toBeDefined();
    });

    it('hide() removes the popover from view and clears the selection', () => {
        const { body, textNode } = setupBody();
        const m = new PopoverManager(body);
        m.show(rangeOver(textNode, 5));
        expect(m.isVisible()).toBe(true);

        m.hide();
        expect(m.isVisible()).toBe(false);
        expect(m.getCurrentSelection()).toBeNull();
        expect(m.getCurrentHighlightedElement()).toBeNull();
    });

    it('clicking a button fires onAction with the action name and payload', () => {
        const { body, textNode } = setupBody();
        const m = new PopoverManager(body);
        const cb = vi.fn();
        m.onAction(cb);

        m.show(rangeOver(textNode, 5));
        const orangeBtn = document.querySelector<HTMLElement>(
            '.selection-popover [data-action="highlight-orange"]',
        );
        expect(orangeBtn).not.toBeNull();
        orangeBtn!.click();

        expect(cb).toHaveBeenCalledTimes(1);
        const [action, payload] = cb.mock.calls[0];
        expect(action).toBe('highlight-orange');
        expect(payload.selection).not.toBeNull();
        expect(payload.highlightedElement).toBeNull();
        // popover hides after action dispatch
        expect(m.isVisible()).toBe(false);
    });

    it('handleHighlightClick on a highlight element renders the unhighlight-only toolbar', () => {
        const { body, paragraph } = setupBody();
        const m = new PopoverManager(body);
        // Match production CSS default of display:none so isVisible() is false
        // on the very first interaction.
        m.hide();

        const span = document.createElement('span');
        span.className = 'highlight-yellow';
        span.textContent = 'highlighted';
        paragraph.appendChild(span);
        span.getBoundingClientRect = () =>
            ({
                left: 50,
                right: 150,
                top: 100,
                bottom: 120,
                width: 100,
                height: 20,
                x: 50,
                y: 100,
                toJSON() {
                    return this;
                },
            }) as DOMRect;

        m.handleHighlightClick(span);
        const popover = document.querySelector('.selection-popover');
        expect(m.isVisible()).toBe(true);
        // hasSelection=false + highlighted: only the unhighlight button is rendered.
        expect(popover?.querySelector('[data-action="unhighlight"]')).not.toBeNull();
        expect(popover?.querySelector('[data-action="highlight-orange"]')).toBeNull();
        expect(m.getCurrentHighlightedElement()).toBe(span);
    });

    it('show() with enableEdit + enableChat options renders Edit and Chat buttons', () => {
        const { body, textNode } = setupBody();
        const m = new PopoverManager(body, { enableEdit: true, enableChat: true });
        m.show(rangeOver(textNode, 11)); // "Hello world" — non-empty selection
        const popover = document.querySelector('.selection-popover');
        expect(popover?.querySelector('[data-action="edit"]')).not.toBeNull();
        expect(popover?.querySelector('[data-action="chat"]')).not.toBeNull();
    });

    it('saved offset from localStorage is applied on show()', () => {
        localStorage.setItem('markon-popover-offset', JSON.stringify({ dx: 30, dy: 40 }));
        const { body, textNode } = setupBody();
        const m = new PopoverManager(body);
        m.show(rangeOver(textNode, 5));

        const popover = document.querySelector<HTMLElement>('.selection-popover')!;
        const originalLeft = parseFloat(popover.dataset.originalLeft ?? '0');
        const originalTop = parseFloat(popover.dataset.originalTop ?? '0');
        const left = parseFloat(popover.style.left);
        const top = parseFloat(popover.style.top);
        // Final position == original + saved offset (constrainToViewport is a noop here).
        expect(left).toBeCloseTo(originalLeft + 30, 0);
        expect(top).toBeCloseTo(originalTop + 40, 0);
    });

    it('handleSelection() ignores clicks on TOC / live-container floating widgets', () => {
        const { body } = setupBody();
        const m = new PopoverManager(body);
        const showSpy = vi.spyOn(m, 'show');

        const tocContainer = document.createElement('div');
        tocContainer.id = 'toc-container';
        const inner = document.createElement('span');
        tocContainer.appendChild(inner);
        document.body.appendChild(tocContainer);

        const ev = new MouseEvent('click', { bubbles: true });
        Object.defineProperty(ev, 'target', { value: inner, configurable: true });
        m.handleSelection(ev);
        expect(showSpy).not.toHaveBeenCalled();
    });
});
