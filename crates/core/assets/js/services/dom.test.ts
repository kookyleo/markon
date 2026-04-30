import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DOM, Meta } from './dom.js';

beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
});

describe('DOM.getBlockParent', () => {
    it('returns the nearest block-level ancestor', () => {
        document.body.innerHTML = '<article><p><span><em>x</em></span></p></article>';
        const article = document.querySelector('article')!;
        const em = document.querySelector('em')!;
        expect(DOM.getBlockParent(em, article)?.tagName).toBe('P');
    });

    it('starts from parentElement when given a text node', () => {
        document.body.innerHTML = '<article><p>hello</p></article>';
        const article = document.querySelector('article')!;
        const text = document.querySelector('p')!.firstChild!;
        expect(DOM.getBlockParent(text, article)?.tagName).toBe('P');
    });

    it('returns null when no block ancestor is found before container', () => {
        document.body.innerHTML = '<div id="c"><span><i>x</i></span></div>';
        const c = document.getElementById('c')!;
        const i = document.querySelector('i')!;
        expect(DOM.getBlockParent(i, c)).toBeNull();
    });
});

describe('DOM.findLastTextNode', () => {
    it('returns the last non-empty text node in DFS order', () => {
        document.body.innerHTML = '<div><p>first</p><p>  </p><p>last <b>bold</b></p></div>';
        const div = document.querySelector('div')!;
        const last = DOM.findLastTextNode(div);
        expect(last?.textContent).toBe('bold');
    });

    it('returns null when there are no non-empty text nodes', () => {
        document.body.innerHTML = '<div><p>   </p></div>';
        const div = document.querySelector('div')!;
        expect(DOM.findLastTextNode(div)).toBeNull();
    });
});

describe('DOM.shouldSkip', () => {
    it('returns false for non-element nodes', () => {
        const t = document.createTextNode('x');
        expect(DOM.shouldSkip(t)).toBe(false);
    });

    it('skips elements whose id is in CONFIG.SKIP_ELEMENTS.IDS', () => {
        const div = document.createElement('div');
        div.id = 'toc';
        expect(DOM.shouldSkip(div)).toBe(true);
    });

    it('skips elements whose className matches a skip class', () => {
        const div = document.createElement('div');
        div.className = 'foo selection-popover bar';
        expect(DOM.shouldSkip(div)).toBe(true);
    });

    it('does not skip plain elements', () => {
        const p = document.createElement('p');
        p.className = 'paragraph';
        expect(DOM.shouldSkip(p)).toBe(false);
    });
});

describe('DOM.getHeight', () => {
    it('returns offsetHeight when positive', () => {
        const el = document.createElement('div');
        Object.defineProperty(el, 'offsetHeight', { configurable: true, value: 42 });
        expect(DOM.getHeight(el)).toBe(42);
    });

    it('falls back to default when offsetHeight is 0', () => {
        const el = document.createElement('div');
        Object.defineProperty(el, 'offsetHeight', { configurable: true, value: 0 });
        expect(DOM.getHeight(el)).toBe(80);
        expect(DOM.getHeight(el, 123)).toBe(123);
    });
});

describe('DOM.onOutsideClick', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('fires callback only on outside clicks and dispose stops it', () => {
        document.body.innerHTML = '<div id="inside"><span id="child">c</span></div><div id="outside"></div>';
        const inside = document.getElementById('inside')!;
        const child = document.getElementById('child')!;
        const outside = document.getElementById('outside')!;
        const cb = vi.fn();
        const dispose = DOM.onOutsideClick(inside, cb);

        // click inside (child) – ignored
        child.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(cb).not.toHaveBeenCalled();

        // click outside – fires
        outside.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(cb).toHaveBeenCalledTimes(1);

        dispose();
        outside.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(cb).toHaveBeenCalledTimes(1);
    });

    it('respects ignore predicate', () => {
        document.body.innerHTML = '<div id="inside"></div><div id="ignored" class="ignore-me"></div>';
        const inside = document.getElementById('inside')!;
        const ignored = document.getElementById('ignored')!;
        const cb = vi.fn();
        const dispose = DOM.onOutsideClick(inside, cb, {
            ignore: (target) => target instanceof Element && target.classList.contains('ignore-me'),
        });
        ignored.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(cb).not.toHaveBeenCalled();
        dispose();
    });
});

describe('Meta', () => {
    it('reads <meta name=...> content; missing returns null', () => {
        document.head.innerHTML = '<meta name="enable-search" content="true"><meta name="lang" content="zh">';
        expect(Meta.get('enable-search')).toBe('true');
        expect(Meta.get('lang')).toBe('zh');
        expect(Meta.get('missing')).toBeNull();
    });

    it('flag() returns true only when content === "true"', () => {
        document.head.innerHTML = '<meta name="a" content="true"><meta name="b" content="false"><meta name="c" content="True">';
        expect(Meta.flag('a')).toBe(true);
        expect(Meta.flag('b')).toBe(false);
        expect(Meta.flag('c')).toBe(false);
        expect(Meta.flag('missing')).toBe(false);
    });
});
