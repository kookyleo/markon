import { describe, it, expect, afterEach } from 'vitest';
import { TextAnchoring } from './text-anchor';
import {
    ANNOTATION_CHROME_REJECT,
    annotationBlockFor,
} from './annotation-target';

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

    it('captures and re-anchors one ordered fragment per structural block', () => {
        const root = makeRoot(
            '<h2>Heading</h2><p>First <em>body</em>.</p><ul><li>One</li><li>Two</li></ul>',
        );
        const range = rangeAt(root, 0, root.textContent?.length ?? 0);
        const legacy = TextAnchoring.describe(root, range);
        const anchor = {
            ...legacy,
            version: 2 as const,
            fragments: TextAnchoring.describeFragments(
                root,
                range,
                undefined,
                (node) => annotationBlockFor(node, root),
            ),
        };

        expect(anchor.fragments.map(fragment => fragment.exact)).toEqual([
            'Heading',
            'First body.',
            'One',
            'Two',
        ]);
        expect(anchor.fragments.map(fragment => fragment.blockTag)).toEqual([
            'H2',
            'P',
            'LI',
            'LI',
        ]);
        expect(TextAnchoring.quote(anchor)).toBe('Heading\nFirst body.\nOne\nTwo');

        root.innerHTML =
            '<h2><span>Heading</span></h2><p>First <strong>body</strong>.</p>' +
            '<ul><li><em>One</em></li><li>Two</li></ul>';
        const back = TextAnchoring.anchor(root, anchor);
        expect(back?.toString()).toBe('HeadingFirst body.OneTwo');
        expect(back?.startContainer.textContent).toBe('Heading');
        expect(back?.endContainer.textContent).toBe('Two');
    });

    it('omits Markon chrome from cross-block fragments and displayed quote', () => {
        const root = makeRoot(
            '<h2>Heading<span class="section-actions">Print</span></h2><p>Body</p>',
        );
        const range = rangeAt(root, 0, root.textContent?.length ?? 0);
        const fragments = TextAnchoring.describeFragments(
            root,
            range,
            ANNOTATION_CHROME_REJECT,
            (node) => annotationBlockFor(node, root),
        );
        const anchor = {
            ...TextAnchoring.describe(root, range),
            version: 2 as const,
            fragments,
        };

        expect(fragments.map(fragment => fragment.exact)).toEqual(['Heading', 'Body']);
        expect(TextAnchoring.quote(anchor)).toBe('Heading\nBody');
    });

    it('treats a missing middle fragment as an orphaned annotation', () => {
        const root = makeRoot('<p>Alpha</p><p>Beta</p><p>Gamma</p>');
        const range = rangeAt(root, 0, root.textContent?.length ?? 0);
        const anchor = {
            ...TextAnchoring.describe(root, range),
            version: 2 as const,
            fragments: TextAnchoring.describeFragments(
                root,
                range,
                undefined,
                (node) => annotationBlockFor(node, root),
            ),
        };

        root.innerHTML = '<p>Alpha</p><p>Changed</p><p>Gamma</p>';
        expect(TextAnchoring.anchor(root, anchor)).toBeNull();
    });

    it('matches repeated fragments as one ordered sequence', () => {
        const root = makeRoot('<ul><li>TODO</li><li>TODO</li><li>Done</li></ul>');
        const range = rangeAt(root, 0, root.textContent?.length ?? 0);
        const fragments = TextAnchoring.describeFragments(
            root,
            range,
            undefined,
            (node) => annotationBlockFor(node, root),
        ).map(fragment => ({ ...fragment, prefix: '', suffix: '', position: 0 }));
        const anchor = {
            ...TextAnchoring.describe(root, range),
            version: 2 as const,
            fragments,
        };

        // With position/context disabled, independent lookup would resolve both
        // TODO fragments to the first occurrence. Sequence matching must use
        // two distinct, ordered occurrences.
        const back = TextAnchoring.anchor(root, anchor, undefined, {
            ignorePosition: true,
            blockFor: (node) => annotationBlockFor(node, root),
        });
        expect(back?.toString()).toBe('TODOTODODone');
        expect(back?.startContainer).toBe(root.querySelectorAll('li')[0]?.firstChild);
        expect(back?.endContainer).toBe(root.querySelectorAll('li')[2]?.firstChild);
    });
});
