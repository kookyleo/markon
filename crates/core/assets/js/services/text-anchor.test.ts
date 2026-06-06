import { describe, it, expect, afterEach } from 'vitest';
import { TextAnchoring } from './text-anchor';

function makeRoot(html: string): HTMLElement {
    const d = document.createElement('div');
    d.innerHTML = html;
    document.body.appendChild(d);
    return d;
}

/** Build a Range over the global text offsets [start, end) within root. */
function rangeAt(root: HTMLElement, start: number, end: number): Range {
    const segs: { node: Text; start: number }[] = [];
    let acc = 0;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n: Node | null = w.nextNode();
    while (n) {
        const t = n as Text;
        segs.push({ node: t, start: acc });
        acc += t.data.length;
        n = w.nextNode();
    }
    const find = (o: number) => segs.find((s) => o >= s.start && o <= s.start + s.node.data.length)!;
    const a = find(start);
    const b = find(end);
    const r = document.createRange();
    r.setStart(a.node, start - a.start);
    r.setEnd(b.node, end - b.start);
    return r;
}

afterEach(() => {
    document.body.innerHTML = '';
});

describe('TextAnchoring', () => {
    it('round-trips a simple selection', () => {
        const root = makeRoot('<p>Alpha beta gamma delta.</p>');
        const a = TextAnchoring.describe(root, rangeAt(root, 6, 16));
        expect(a.exact).toBe('beta gamma');
        expect(TextAnchoring.anchor(root, a)?.toString()).toBe('beta gamma');
    });

    it('survives a DOM re-render that keeps the text content', () => {
        const root = makeRoot('<p>Alpha beta gamma delta.</p>');
        const a = TextAnchoring.describe(root, rangeAt(root, 6, 16));
        // Re-render: same text, very different DOM (inline markup + extra nodes).
        root.innerHTML = '<p>Alpha <em>beta</em> <strong>gamma</strong> <span>delta</span>.</p>';
        expect(TextAnchoring.anchor(root, a)?.toString()).toBe('beta gamma');
    });

    it('disambiguates a repeated quote by context + position', () => {
        const root = makeRoot('<p>foo bar baz. foo bar qux.</p>');
        const second = 'foo bar baz. foo '.length; // start of the 2nd "bar"
        const a = TextAnchoring.describe(root, rangeAt(root, second, second + 3));
        expect(a.suffix.startsWith(' qux')).toBe(true);
        const back = TextAnchoring.anchor(root, a);
        expect(back?.toString()).toBe('bar');
        // It re-anchored the *second* bar: the text right after is " qux".
        const re = TextAnchoring.describe(root, back!);
        expect(re.suffix.startsWith(' qux')).toBe(true);
    });

    it('returns null when the quoted text is gone (orphaned)', () => {
        const root = makeRoot('<p>Alpha beta gamma delta.</p>');
        const a = TextAnchoring.describe(root, rangeAt(root, 6, 16));
        root.innerHTML = '<p>Alpha delta.</p>'; // "beta gamma " removed
        expect(TextAnchoring.anchor(root, a)).toBeNull();
    });
});
