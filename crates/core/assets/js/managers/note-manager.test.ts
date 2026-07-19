import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NoteManager } from './note-manager';
import type { AnnotationManager, Annotation } from './annotation-manager';

/**
 * NoteManager only consumes a slice of AnnotationManager (`getAll()`).
 * We stub that surface here to avoid dragging in storage / DOM-application.
 */
function fakeAnnotationManager(annos: Annotation[]): AnnotationManager {
    return {
        getAll: () => annos.slice(),
    } as unknown as AnnotationManager;
}

function makeAnno(partial: Partial<Annotation> & { id: string }): Annotation {
    return {
        type: 'has-note',
        tagName: 'span',
        anchor: { position: 0, exact: 'x', prefix: '', suffix: '' },
        text: 'x',
        note: 'a note',
        createdAt: 1,
        ...partial,
    };
}

function setupBody(html: string): HTMLElement {
    const root = document.createElement('div');
    root.className = 'markdown-body';
    root.innerHTML = html;
    document.body.appendChild(root);
    return root;
}

function itemAt<T>(items: ArrayLike<T>, index: number): T {
    const item = items[index];
    expect(item).toBeDefined();
    if (item === undefined) throw new Error(`Missing item at index ${index}`);
    return item;
}

describe('NoteManager', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        document.body.innerHTML = '';
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        // Default to wide-screen so layout uses physical layout.
        Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true, writable: true });
        Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true, writable: true });
        Object.defineProperty(document.documentElement, 'clientHeight', { value: 800, configurable: true });
    });

    afterEach(() => {
        logSpy.mockRestore();
    });

    it('renders one .note-card-margin per outermost has-note element', () => {
        const root = setupBody(`
            <p><span class="has-note" data-annotation-id="anno-1">alpha</span></p>
            <p><span class="has-note" data-annotation-id="anno-2">beta</span></p>
        `);
        const annos: Annotation[] = [
            makeAnno({ id: 'anno-1', text: 'alpha', note: 'first' }),
            makeAnno({ id: 'anno-2', text: 'beta', note: 'second' }),
        ];

        const mgr = new NoteManager(fakeAnnotationManager(annos), root);
        mgr.render();

        const cards = document.querySelectorAll('.note-card-margin');
        expect(cards.length).toBe(2);
        expect(mgr.getNoteCardsData()).toHaveLength(2);
        expect(itemAt(cards, 0).getAttribute('data-annotation-id')).toBe('anno-1');
    });

    it('marginCards:false tracks note data but mounts no gutter cards (diff popup mode)', () => {
        const root = setupBody(`
            <p><span class="has-note" data-annotation-id="anno-1">alpha</span></p>
            <p><span class="has-note" data-annotation-id="anno-2">beta</span></p>
        `);
        const annos: Annotation[] = [
            makeAnno({ id: 'anno-1', text: 'alpha', note: 'first' }),
            makeAnno({ id: 'anno-2', text: 'beta', note: 'second' }),
        ];
        const mgr = new NoteManager(fakeAnnotationManager(annos), root, { marginCards: false });
        mgr.render();

        // No gutter cards mounted...
        expect(document.querySelectorAll('.note-card-margin').length).toBe(0);
        // ...but note data is tracked so showNotePopup can resolve a click.
        expect(mgr.getNoteCardsData()).toHaveLength(2);

        const noteEl = root.querySelector<HTMLElement>('[data-annotation-id="anno-1"]')!;
        mgr.showNotePopup(noteEl, 'anno-1');
        const popup = document.querySelector('.note-popup');
        expect(popup).not.toBeNull();
        expect(popup?.querySelector('.note-content')?.textContent).toBe('first');
    });

    it('deduplicates same-id has-note elements that appear nested + non-nested', () => {
        // When a single annotation gets re-applied and ends up wrapped both
        // inside another .has-note (nested) and as a standalone span, the
        // de-dup logic in #filterOutermost prefers the non-nested instance.
        const root = setupBody(`
            <p>
                <span class="has-note" data-annotation-id="dup">
                    inner
                    <span class="has-note" data-annotation-id="dup">again</span>
                </span>
            </p>
            <p><span class="has-note" data-annotation-id="other">other</span></p>
        `);
        const annos = [
            makeAnno({ id: 'dup', note: 'duplicated' }),
            makeAnno({ id: 'other', note: 'lone' }),
        ];
        const mgr = new NoteManager(fakeAnnotationManager(annos), root);
        mgr.render();

        const cards = document.querySelectorAll('.note-card-margin');
        // One card per unique annotation id.
        expect(cards.length).toBe(2);
        const ids = Array.from(cards).map(c => c.getAttribute('data-annotation-id')).sort();
        expect(ids).toEqual(['dup', 'other']);
    });

    it('renders one note card and activates every fragment of a cross-block note', () => {
        const root = setupBody(`
            <h2><span class="has-note" data-annotation-id="cross">Heading</span></h2>
            <p><span class="has-note" data-annotation-id="cross">Body</span></p>
            <li><span class="has-note" data-annotation-id="cross">Item</span></li>
        `);
        const manager = new NoteManager(
            fakeAnnotationManager([
                makeAnno({ id: 'cross', text: 'Heading\nBody\nItem', note: 'one target' }),
            ]),
            root,
        );

        manager.render();
        expect(document.querySelectorAll('.note-card-margin[data-annotation-id="cross"]')).toHaveLength(1);

        manager.setActive('cross');
        const fragments = root.querySelectorAll<HTMLElement>(
            '.has-note[data-annotation-id="cross"]',
        );
        expect(fragments).toHaveLength(3);
        fragments.forEach(fragment => {
            expect(fragment.classList.contains('highlight-active')).toBe(true);
        });
    });

    it('escapes note HTML so attacker-controlled content cannot inject markup', () => {
        const root = setupBody(`<p><span class="has-note" data-annotation-id="x">y</span></p>`);
        const annos = [makeAnno({ id: 'x', note: '<img src=x onerror=alert(1)>' })];
        const mgr = new NoteManager(fakeAnnotationManager(annos), root);
        mgr.render();

        const card = document.querySelector('.note-card-margin .note-content')!;
        // The escaped content should appear as text, not as a child <img>.
        expect(card.querySelector('img')).toBeNull();
        expect(card.textContent).toContain('<img');
    });

    it('autolinks http(s) URLs in note content without allowing unsafe schemes', () => {
        const root = setupBody(`<p><span class="has-note" data-annotation-id="x">y</span></p>`);
        const annos = [
            makeAnno({
                id: 'x',
                note: 'see https://example.com/a?b=1, not javascript:alert(1)',
            }),
        ];
        const mgr = new NoteManager(fakeAnnotationManager(annos), root);
        mgr.render();

        const card = document.querySelector('.note-card-margin .note-content')!;
        const link = card.querySelector<HTMLAnchorElement>('a');
        expect(link).not.toBeNull();
        expect(link?.href).toBe('https://example.com/a?b=1');
        expect(link?.target).toBe('_blank');
        expect(link?.rel).toContain('noopener');
        expect(link?.rel).toContain('noreferrer');
        expect(card.textContent).toContain('not javascript:alert(1)');
        expect(card.querySelector('a[href^="javascript:"]')).toBeNull();
    });

    it('clear() removes all note cards and resets state', () => {
        const root = setupBody(`<p><span class="has-note" data-annotation-id="a">x</span></p>`);
        const mgr = new NoteManager(
            fakeAnnotationManager([makeAnno({ id: 'a', note: 'n' })]),
            root,
        );
        mgr.render();
        expect(document.querySelectorAll('.note-card-margin').length).toBe(1);
        mgr.clear();
        expect(document.querySelectorAll('.note-card-margin').length).toBe(0);
        expect(mgr.getNoteCardsData()).toHaveLength(0);
    });

    it('layouts cards via the LayoutEngine on wide screens (sets left/top/display)', () => {
        const root = setupBody(`
            <p><span class="has-note" data-annotation-id="anno-1">first</span></p>
            <p><span class="has-note" data-annotation-id="anno-2">second</span></p>
        `);
        const annos = [
            makeAnno({ id: 'anno-1', note: 'one' }),
            makeAnno({ id: 'anno-2', note: 'two' }),
        ];
        const mgr = new NoteManager(fakeAnnotationManager(annos), root);
        mgr.render();

        const cards = document.querySelectorAll<HTMLElement>('.note-card-margin');
        expect(cards.length).toBe(2);
        cards.forEach(card => {
            expect(card.style.display).toBe('block');
            // Right-edge calculation depends on innerWidth - card width - margin.
            // We only assert it was applied (non-empty pixel string).
            expect(card.style.left).toMatch(/px$/);
            expect(card.style.top).toMatch(/px$/);
        });
    });

    it('hides cards on narrow screens', () => {
        Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true, writable: true });
        const root = setupBody(`<p><span class="has-note" data-annotation-id="a">x</span></p>`);
        const mgr = new NoteManager(
            fakeAnnotationManager([makeAnno({ id: 'a', note: 'hidden' })]),
            root,
        );
        mgr.render();
        const card = document.querySelector<HTMLElement>('.note-card-margin')!;
        expect(card.style.display).toBe('none');
    });

    it('hides cards whose source anchor is outside the current viewport', () => {
        const root = setupBody(`
            <p><span class="has-note" data-annotation-id="visible">visible</span></p>
            <p><span class="has-note" data-annotation-id="offscreen">offscreen</span></p>
        `);
        const visible = root.querySelector<HTMLElement>('[data-annotation-id="visible"]')!;
        const offscreen = root.querySelector<HTMLElement>('[data-annotation-id="offscreen"]')!;
        visible.getBoundingClientRect = () =>
            ({ left: 0, top: 100, right: 0, bottom: 120, width: 0, height: 20, x: 0, y: 100, toJSON: () => ({}) });
        offscreen.getBoundingClientRect = () =>
            ({ left: 0, top: 1200, right: 0, bottom: 1220, width: 0, height: 20, x: 0, y: 1200, toJSON: () => ({}) });
        const mgr = new NoteManager(
            fakeAnnotationManager([
                makeAnno({ id: 'visible', note: 'shown' }),
                makeAnno({ id: 'offscreen', note: 'hidden' }),
            ]),
            root,
        );

        mgr.render();

        const visibleCard = document.querySelector<HTMLElement>('[data-annotation-id="visible"].note-card-margin')!;
        const offscreenCard = document.querySelector<HTMLElement>('[data-annotation-id="offscreen"].note-card-margin')!;
        expect(visibleCard.style.display).toBe('block');
        expect(offscreenCard.style.display).toBe('none');
    });

    it('emits active-change events with the source element and prior id', () => {
        const root = setupBody(`<p><span class="has-note" data-annotation-id="a">word</span></p>`);
        const mgr = new NoteManager(
            fakeAnnotationManager([makeAnno({ id: 'a', note: 'body' })]),
            root,
        );
        mgr.render();
        const source = root.querySelector<HTMLElement>('[data-annotation-id="a"]')!;
        const onActiveChange = vi.fn();
        mgr.onActiveChange(onActiveChange);

        mgr.setActive('a');
        expect(onActiveChange).toHaveBeenLastCalledWith({
            annotationId: 'a',
            previousAnnotationId: null,
            sourceElement: source,
        });

        mgr.clearActive();
        expect(onActiveChange).toHaveBeenLastCalledWith({
            annotationId: null,
            previousAnnotationId: 'a',
            sourceElement: null,
        });
    });

    it('showNotePopup creates a positioned .note-popup near the highlight', () => {
        const root = setupBody(`<p><span class="has-note" data-annotation-id="a">word</span></p>`);
        const mgr = new NoteManager(
            fakeAnnotationManager([makeAnno({ id: 'a', note: 'popup body' })]),
            root,
        );
        mgr.render();
        const highlight = root.querySelector<HTMLElement>('[data-annotation-id="a"]')!;
        mgr.showNotePopup(highlight, 'a');
        const popup = document.querySelector<HTMLElement>('.note-popup');
        expect(popup).not.toBeNull();
        expect(popup!.dataset['annotationId']).toBe('a');
        expect(popup!.style.position).toBe('absolute');
        expect(popup!.querySelector('.note-content')?.textContent).toBe('popup body');
    });

    it('skips annotations with no note attached', () => {
        const root = setupBody(`
            <p><span class="has-note" data-annotation-id="a">a</span></p>
            <p><span class="has-note" data-annotation-id="b">b</span></p>
        `);
        const annos: Annotation[] = [
            makeAnno({ id: 'a', note: 'has' }),
            makeAnno({ id: 'b', note: null }), // no note → no card even if class present
        ];
        const mgr = new NoteManager(fakeAnnotationManager(annos), root);
        mgr.render();
        const cards = document.querySelectorAll('.note-card-margin');
        expect(cards.length).toBe(1);
        expect(itemAt(cards, 0).getAttribute('data-annotation-id')).toBe('a');
    });
});
