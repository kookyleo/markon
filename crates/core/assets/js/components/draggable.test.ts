import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DraggableManager, makeDraggable } from './draggable';

function makeMouseEvent(type: string, pageX: number, pageY: number, target?: Element): MouseEvent {
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'pageX', { value: pageX });
    Object.defineProperty(ev, 'pageY', { value: pageY });
    if (target) Object.defineProperty(ev, 'target', { value: target });
    return ev;
}

describe('DraggableManager', () => {
    let element: HTMLElement;

    beforeEach(() => {
        element = document.createElement('div');
        // Provide a starting position via inline style.
        element.style.position = 'absolute';
        element.style.left = '100px';
        element.style.top = '100px';
        Object.defineProperty(element, 'offsetWidth', { value: 200, configurable: true });
        Object.defineProperty(element, 'offsetHeight', { value: 100, configurable: true });
        document.body.appendChild(element);
        // Generous viewport so constrainToViewport never clamps in these tests.
        Object.defineProperty(window, 'innerWidth', { value: 2000, configurable: true });
        Object.defineProperty(window, 'innerHeight', { value: 2000, configurable: true });
    });

    afterEach(() => {
        document.body.innerHTML = '';
        localStorage.clear();
    });

    it('fires onDragStart / onDragmove / onDragEnd with correct deltas', () => {
        const onDragStart = vi.fn();
        const onDragmove = vi.fn();
        const onDragEnd = vi.fn();

        new DraggableManager(element, { onDragStart, onDragmove, onDragEnd });

        // mousedown to start
        element.dispatchEvent(makeMouseEvent('mousedown', 50, 60));
        expect(onDragStart).toHaveBeenCalledTimes(1);

        // mousemove on document is what the manager actually listens to
        document.dispatchEvent(makeMouseEvent('mousemove', 70, 90));
        expect(onDragmove).toHaveBeenCalledWith(20, 30);

        // mouseup ends
        document.dispatchEvent(makeMouseEvent('mouseup', 70, 90));
        expect(onDragEnd).toHaveBeenCalledTimes(1);
        const [finalLeft, finalTop] = onDragEnd.mock.calls[0];
        // initialLeft (100) + dx 20 == 120; initialTop (100) + dy 30 == 130
        expect(finalLeft).toBe(120);
        expect(finalTop).toBe(130);
    });

    it('ignores drag start on BUTTON / INPUT targets (drag threshold)', () => {
        const onDragStart = vi.fn();
        const onDragmove = vi.fn();
        new DraggableManager(element, { onDragStart, onDragmove });

        const btn = document.createElement('button');
        element.appendChild(btn);
        // mousedown on button → handler returns early, no drag begins
        element.dispatchEvent(makeMouseEvent('mousedown', 50, 50, btn));
        expect(onDragStart).not.toHaveBeenCalled();

        // Even moves afterwards must NOT fire onDragmove (manager not in dragging state).
        document.dispatchEvent(makeMouseEvent('mousemove', 80, 80));
        expect(onDragmove).not.toHaveBeenCalled();
    });

    it('persists offset to localStorage when saveOffset + storageKey are set', () => {
        element.dataset.originalLeft = '50';
        element.dataset.originalTop = '50';

        new DraggableManager(element, { saveOffset: true, storageKey: 'test-key' });

        element.dispatchEvent(makeMouseEvent('mousedown', 0, 0));
        document.dispatchEvent(makeMouseEvent('mousemove', 25, 35));
        document.dispatchEvent(makeMouseEvent('mouseup', 25, 35));

        const stored = localStorage.getItem('test-key');
        expect(stored).not.toBeNull();
        const parsed = JSON.parse(stored!);
        // initialLeft 100 + dx 25 = 125 → offset.dx = 125 - 50 = 75
        expect(parsed.dx).toBe(75);
        expect(parsed.dy).toBe(85);
    });

    it('makeDraggable returns a DraggableManager instance', () => {
        const m = makeDraggable(element);
        expect(m).toBeInstanceOf(DraggableManager);
    });

    it('destroy removes event listeners so further mousedown does nothing', () => {
        const onDragStart = vi.fn();
        const m = new DraggableManager(element, { onDragStart });
        m.destroy();

        element.dispatchEvent(makeMouseEvent('mousedown', 10, 10));
        expect(onDragStart).not.toHaveBeenCalled();
    });
});
