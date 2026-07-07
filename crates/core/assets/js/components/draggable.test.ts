import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DraggableManager } from './draggable';

function makeMouseEvent(type: string, pageX: number, pageY: number, target?: Element): MouseEvent {
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'pageX', { value: pageX });
    Object.defineProperty(ev, 'pageY', { value: pageY });
    Object.defineProperty(ev, 'clientX', { value: pageX });
    Object.defineProperty(ev, 'clientY', { value: pageY });
    if (target) Object.defineProperty(ev, 'target', { value: target });
    return ev;
}

function itemAt<T>(items: ArrayLike<T>, index: number): T {
    const item = items[index];
    expect(item).toBeDefined();
    if (item === undefined) throw new Error(`Missing item at index ${index}`);
    return item;
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

    it('moves the element with the drag and fires onDragEnd with final position', () => {
        const onDragEnd = vi.fn();

        new DraggableManager(element, { onDragEnd });

        // mousedown to start
        element.dispatchEvent(makeMouseEvent('mousedown', 50, 60));

        // mousemove on document is what the manager actually listens to
        document.dispatchEvent(makeMouseEvent('mousemove', 70, 90));
        // initialLeft (100) + dx 20 == 120; initialTop (100) + dy 30 == 130
        expect(element.style.left).toBe('120px');
        expect(element.style.top).toBe('130px');

        // mouseup ends
        document.dispatchEvent(makeMouseEvent('mouseup', 70, 90));
        expect(onDragEnd).toHaveBeenCalledTimes(1);
        const [finalLeft, finalTop] = itemAt(onDragEnd.mock.calls, 0);
        expect(finalLeft).toBe(120);
        expect(finalTop).toBe(130);
    });

    it('ignores drag start on BUTTON / INPUT targets (drag threshold)', () => {
        new DraggableManager(element, {});

        const btn = document.createElement('button');
        element.appendChild(btn);
        // mousedown on button → handler returns early, no drag begins
        element.dispatchEvent(makeMouseEvent('mousedown', 50, 50, btn));

        // Even moves afterwards must NOT move the element (manager not in dragging state).
        document.dispatchEvent(makeMouseEvent('mousemove', 80, 80));
        expect(element.style.left).toBe('100px');
        expect(element.style.top).toBe('100px');
    });

    it('binds every element matched by a handle selector', () => {
        const topHandle = document.createElement('span');
        const bottomHandle = document.createElement('span');
        topHandle.className = 'edge-handle';
        bottomHandle.className = 'edge-handle';
        element.append(topHandle, bottomHandle);

        new DraggableManager(element, { handle: '.edge-handle' });

        bottomHandle.dispatchEvent(makeMouseEvent('mousedown', 20, 20, bottomHandle));
        document.dispatchEvent(makeMouseEvent('mousemove', 35, 50));

        expect(element.style.left).toBe('115px');
        expect(element.style.top).toBe('130px');
    });

    it('persists offset to localStorage when saveOffset + storageKey are set', () => {
        element.dataset['originalLeft'] = '50';
        element.dataset['originalTop'] = '50';

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

    it('restores offset relative to the original element position', () => {
        element.dataset['originalLeft'] = '50';
        element.dataset['originalTop'] = '60';
        localStorage.setItem('offset-key', JSON.stringify({ dx: 15, dy: -10 }));

        new DraggableManager(element, {
            fixed: true,
            restoreOffset: true,
            storageKey: 'offset-key',
        });

        expect(element.style.position).toBe('fixed');
        expect(element.style.left).toBe('65px');
        expect(element.style.top).toBe('50px');
    });

    it('restores and persists fixed window position', () => {
        localStorage.setItem('modal-pos', JSON.stringify({ left: 300, top: 400 }));

        new DraggableManager(element, {
            storageKey: 'modal-pos',
            fixed: true,
            restorePosition: true,
            savePosition: true,
        });

        expect(element.style.position).toBe('fixed');
        expect(element.style.left).toBe('300px');
        expect(element.style.top).toBe('400px');

        element.dispatchEvent(makeMouseEvent('mousedown', 310, 410));
        document.dispatchEvent(makeMouseEvent('mousemove', 330, 450));
        document.dispatchEvent(makeMouseEvent('mouseup', 330, 450));

        const stored = localStorage.getItem('modal-pos');
        expect(stored).not.toBeNull();
        expect(JSON.parse(stored!)).toEqual({ left: 320, top: 440 });
    });

    it('destroy removes event listeners so further mousedown does nothing', () => {
        const m = new DraggableManager(element, {});
        m.destroy();

        element.dispatchEvent(makeMouseEvent('mousedown', 10, 10));
        document.dispatchEvent(makeMouseEvent('mousemove', 40, 40));
        expect(element.style.left).toBe('100px');
        expect(element.style.top).toBe('100px');
    });
});
