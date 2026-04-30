import { describe, it, expect, beforeEach } from 'vitest';
import { Position } from './position.js';

beforeEach(() => {
    document.body.innerHTML = '';
    Object.defineProperty(window, 'scrollX', { configurable: true, value: 0 });
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
});

describe('Position.getAbsolute', () => {
    it('adds page scroll offsets to client rect', () => {
        const el = document.createElement('div');
        document.body.appendChild(el);
        Object.defineProperty(window, 'scrollX', { configurable: true, value: 50 });
        Object.defineProperty(window, 'scrollY', { configurable: true, value: 100 });
        el.getBoundingClientRect = () =>
            ({ left: 10, top: 20, right: 30, bottom: 40, width: 20, height: 20, x: 10, y: 20, toJSON: () => ({}) }) as DOMRect;
        expect(Position.getAbsolute(el)).toEqual({ left: 60, top: 120, right: 80, bottom: 140 });
    });
});

describe('Position.constrainToViewport', () => {
    it('does not move a rect already inside the viewport', () => {
        const r = Position.constrainToViewport(100, 100, 200, 100);
        expect(r).toEqual({ left: 100, top: 100 });
    });

    it('clamps a rect overflowing the right/bottom edges', () => {
        const r = Position.constrainToViewport(950, 750, 200, 100, { margin: 10 });
        // right clamp: innerWidth(1000) + scroll(0) - width(200) - margin(10) = 790
        // bottom clamp: innerHeight(800) - 100 - 10 = 690
        expect(r).toEqual({ left: 790, top: 690 });
    });

    it('clamps a rect overflowing the left/top edges', () => {
        const r = Position.constrainToViewport(-50, -50, 100, 50, { margin: 10 });
        expect(r).toEqual({ left: 10, top: 10 });
    });

    it('honors fixed=true (ignores scroll offset)', () => {
        Object.defineProperty(window, 'scrollX', { configurable: true, value: 500 });
        Object.defineProperty(window, 'scrollY', { configurable: true, value: 500 });
        // With fixed=true, scroll is treated as 0 inside the algorithm
        const r = Position.constrainToViewport(0, 0, 100, 50, { fixed: true, margin: 10 });
        expect(r).toEqual({ left: 10, top: 10 });
    });

    it('respects custom margin', () => {
        const r = Position.constrainToViewport(0, 0, 100, 50, { margin: 25 });
        expect(r).toEqual({ left: 25, top: 25 });
    });
});

describe('Position.smartScrollToHeading', () => {
    it('invokes window.scrollTo with smooth behavior when section fits viewport', () => {
        const heading = document.createElement('h2');
        heading.className = 'heading-section';
        document.body.appendChild(heading);
        Object.defineProperty(heading, 'offsetHeight', { configurable: true, value: 100 });
        heading.getBoundingClientRect = () =>
            ({ left: 0, top: 200, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
        const calls: Array<ScrollToOptions | undefined> = [];
        window.scrollTo = ((opts?: ScrollToOptions) => { calls.push(opts); }) as typeof window.scrollTo;

        Position.smartScrollToHeading(heading);
        expect(calls.length).toBe(1);
        expect(calls[0]?.behavior).toBe('smooth');
        // top = 200 + scrollY(0) - HEADING_TOP_MARGIN(64)
        expect(calls[0]?.top).toBe(200 - 64);
    });

    it('uses tight margin when section is taller than viewport', () => {
        const heading = document.createElement('h2');
        heading.className = 'heading-section';
        document.body.appendChild(heading);
        Object.defineProperty(heading, 'offsetHeight', { configurable: true, value: 5000 });
        heading.getBoundingClientRect = () =>
            ({ left: 0, top: 300, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
        const calls: Array<ScrollToOptions | undefined> = [];
        window.scrollTo = ((opts?: ScrollToOptions) => { calls.push(opts); }) as typeof window.scrollTo;

        Position.smartScrollToHeading(heading);
        // top = 300 + 0 - HEADING_TOP_MARGIN_TIGHT(5)
        expect(calls[0]?.top).toBe(295);
    });
});
