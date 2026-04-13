import { describe, it, expect, beforeEach } from 'vitest';

// Set up globals before importing modules that read window
globalThis.window = globalThis.window || globalThis;
window.__MARKON_I18N__ = { t: (k) => k };
window.__MARKON_SHORTCUTS__ = undefined;

const { DOM } = await import('../../assets/js/services/dom.js');
const { XPath } = await import('../../assets/js/services/xpath.js');

describe('DOM.shouldSkip', () => {
  it('skips element with toc id', () => {
    const el = document.createElement('div');
    el.id = 'toc';
    expect(DOM.shouldSkip(el)).toBe(true);
  });

  it('skips element with toc class', () => {
    const el = document.createElement('div');
    el.className = 'toc';
    expect(DOM.shouldSkip(el)).toBe(true);
  });

  it('skips element with selection-popover class', () => {
    const el = document.createElement('div');
    el.className = 'selection-popover';
    expect(DOM.shouldSkip(el)).toBe(true);
  });

  it('does not skip plain element', () => {
    const el = document.createElement('p');
    expect(DOM.shouldSkip(el)).toBe(false);
  });

  it('does not skip text nodes', () => {
    const text = document.createTextNode('hello');
    expect(DOM.shouldSkip(text)).toBe(false);
  });
});

describe('DOM.findLastTextNode', () => {
  it('finds the last non-empty text node', () => {
    const div = document.createElement('div');
    div.innerHTML = '<p>first</p><p>second</p>';
    const last = DOM.findLastTextNode(div);
    expect(last.textContent).toBe('second');
  });

  it('skips empty text nodes', () => {
    const div = document.createElement('div');
    div.innerHTML = '<p>content</p>';
    div.appendChild(document.createTextNode('   '));
    const last = DOM.findLastTextNode(div);
    expect(last.textContent).toBe('content');
  });

  it('returns null for empty element', () => {
    const div = document.createElement('div');
    expect(DOM.findLastTextNode(div)).toBeNull();
  });
});

describe('DOM.getBlockParent', () => {
  it('finds block parent for text node', () => {
    const container = document.createElement('div');
    container.innerHTML = '<p><span>text</span></p>';
    const text = container.querySelector('span').firstChild;
    const block = DOM.getBlockParent(text, container);
    expect(block.tagName).toBe('P');
  });

  it('returns null when no block parent in container', () => {
    const container = document.createElement('span');
    container.innerHTML = '<em>text</em>';
    const text = container.querySelector('em').firstChild;
    expect(DOM.getBlockParent(text, container)).toBeNull();
  });
});

describe('DOM.getHeight', () => {
  it('returns fallback when offsetHeight is 0', () => {
    const el = document.createElement('div');
    // jsdom offsetHeight is 0 by default
    expect(DOM.getHeight(el, 100)).toBe(100);
  });
});

describe('XPath.create + resolve round-trip', () => {
  let article;

  beforeEach(() => {
    document.body.innerHTML = '<article class="markdown-body"><p>first</p><p>second</p></article>';
    article = document.querySelector('article');
  });

  it('creates an xpath for a text node', () => {
    const textNode = article.querySelector('p').firstChild;
    const path = XPath.create(textNode);
    expect(path).toMatch(/^\/\/article\[1\]\//);
    expect(path).toContain('#text');
  });

  it('creates an xpath for the article itself', () => {
    const path = XPath.create(article);
    expect(path).toBe('//article[1]');
  });

  it('resolve returns null for invalid path', () => {
    expect(XPath.resolve('invalid')).toBeNull();
  });

  it('resolve returns article for base path', () => {
    const node = XPath.resolve('//article[1]');
    expect(node).toBe(article);
  });

  it('round-trips a paragraph', () => {
    const p = article.querySelectorAll('p')[1];
    const path = XPath.create(p);
    const resolved = XPath.resolve(path);
    expect(resolved).toBe(p);
  });
});

describe('XPath.getAbsoluteOffset + findNode round-trip', () => {
  it('round-trips offset in a simple paragraph', () => {
    document.body.innerHTML = '<article class="markdown-body"><p>hello world</p></article>';
    const p = document.querySelector('p');
    const textNode = p.firstChild;

    const absOffset = XPath.getAbsoluteOffset(textNode, 5);
    expect(absOffset).toBe(5);

    const result = XPath.findNode(p, 5);
    expect(result.node).toBe(textNode);
    expect(result.offset).toBe(5);
  });

  it('handles multiple text nodes in a parent', () => {
    const p = document.createElement('p');
    p.appendChild(document.createTextNode('abc'));
    p.appendChild(document.createTextNode('def'));

    // Offset 3 in second text node
    const absOffset = XPath.getAbsoluteOffset(p.childNodes[1], 2);
    expect(absOffset).toBe(5); // 3 (first node) + 2

    const result = XPath.findNode(p, 5);
    expect(result.node).toBe(p.childNodes[1]);
    expect(result.offset).toBe(2);
  });

  it('handles offset at exact boundary', () => {
    const p = document.createElement('p');
    p.appendChild(document.createTextNode('abc'));
    p.appendChild(document.createTextNode('def'));

    // Offset at end of first node
    const result = XPath.findNode(p, 3);
    expect(result.node).toBe(p.childNodes[0]);
    expect(result.offset).toBe(3);
  });
});
