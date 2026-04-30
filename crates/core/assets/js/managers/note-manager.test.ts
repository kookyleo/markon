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
        startPath: '//article[1]/P[1]',
        endPath: '//article[1]/P[1]',
        startOffset: 0,
        endOffset: 1,
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

describe('NoteManager', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        document.body.innerHTML = '';
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        // Default to wide-screen so layout uses physical layout.
        Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true, writable: true });
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
        expect(cards[0].getAttribute('data-annotation-id')).toBe('anno-1');
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
        expect(popup!.dataset.annotationId).toBe('a');
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
        expect(cards[0].getAttribute('data-annotation-id')).toBe('a');
    });
});
