import { describe, it, expect, beforeEach } from 'vitest';
import { XPath } from './xpath.js';

beforeEach(() => {
    document.body.innerHTML = '';
});

describe('XPath.create', () => {
    it('builds an absolute path indexed by tag among siblings', () => {
        document.body.innerHTML =
            '<article class="markdown-body">' +
                '<p>first</p>' +
                '<p>second <span>x</span></p>' +
                '<p>third</p>' +
            '</article>';
        const span = document.querySelector('span')!;
        // span is inside the 2nd <p>
        expect(XPath.create(span)).toBe('//article[1]/P[2]/SPAN[1]');
    });

    it('returns //article[1] when called on the article itself', () => {
        document.body.innerHTML = '<article class="markdown-body"><p>hi</p></article>';
        const article = document.querySelector('article')!;
        expect(XPath.create(article)).toBe('//article[1]');
    });

    it('skipped siblings (toc, popovers) do not bump the index', () => {
        document.body.innerHTML =
            '<article class="markdown-body">' +
                '<div class="toc">toc</div>' +
                '<p>real first</p>' +
                '<p>real second</p>' +
            '</article>';
        const second = document.querySelectorAll('p')[1]!;
        // skipped sibling .toc shouldn't count
        expect(XPath.create(second)).toBe('//article[1]/P[2]');
    });
});

describe('XPath.resolve', () => {
    it('round-trips with create()', () => {
        document.body.innerHTML =
            '<article class="markdown-body">' +
                '<h2>title</h2>' +
                '<p>one</p>' +
                '<p>two <em>em</em></p>' +
            '</article>';
        const em = document.querySelector('em')!;
        const xpath = XPath.create(em);
        expect(XPath.resolve(xpath)).toBe(em);
    });

    it('returns null on malformed paths', () => {
        document.body.innerHTML = '<article class="markdown-body"><p>x</p></article>';
        expect(XPath.resolve('not-an-xpath')).toBeNull();
        expect(XPath.resolve('//article[1]/P[2]/garbage')).toBeNull();
    });

    it('returns null when no matching child exists', () => {
        document.body.innerHTML = '<article class="markdown-body"><p>x</p></article>';
        expect(XPath.resolve('//article[1]/P[5]')).toBeNull();
    });
});

describe('XPath.getAbsoluteOffset', () => {
    it('measures offset from a text-node container including preceding siblings', () => {
        document.body.innerHTML = '<p>hello <b>bold</b> world</p>';
        const p = document.querySelector('p')!;
        // Children: text "hello ", <b>bold</b>, text " world"
        const trailing = p.lastChild as Text;
        expect(trailing.nodeType).toBe(3);
        // offset 3 inside " world" -> "hello "(6) + "bold"(4) + 3 = 13
        expect(XPath.getAbsoluteOffset(trailing, 3)).toBe(13);
    });

    it('measures offset across element children when given an element container', () => {
        document.body.innerHTML = '<p>hello <b>bold</b> world</p>';
        const p = document.querySelector('p')!;
        // first 2 children full text length: "hello "(6) + "bold"(4) = 10
        expect(XPath.getAbsoluteOffset(p, 2)).toBe(10);
    });
});

describe('XPath.findNode', () => {
    it('locates the text node containing the absolute offset', () => {
        document.body.innerHTML = '<p>hello <b>bold</b> world</p>';
        const p = document.querySelector('p')!;
        // offset 8 -> inside <b>bold</b> at relative 2
        const r = XPath.findNode(p, 8);
        expect(r.node?.nodeValue).toBe('bold');
        expect(r.offset).toBe(2);
    });

    it('returns the last text node when offset equals total length', () => {
        document.body.innerHTML = '<p>hello <b>bold</b></p>';
        const p = document.querySelector('p')!;
        // total length: 6 + 4 = 10
        const r = XPath.findNode(p, 10);
        expect(r.node?.nodeValue).toBe('bold');
        expect(r.offset).toBe(4);
    });

    it('returns {node:null} for impossible offsets in empty subtree', () => {
        document.body.innerHTML = '<p></p>';
        const p = document.querySelector('p')!;
        const r = XPath.findNode(p, 5);
        expect(r.node).toBeNull();
    });
});
