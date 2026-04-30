import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    AnnotationManager,
    type Annotation,
    type AnnotationStorage,
    type AnnotationChangeEvent,
} from './annotation-manager';

/**
 * Build a stub storage that records calls and never throws.
 * The real storage-manager exposes the same shape (load/save/delete/clear).
 */
function makeStorage(initial: Annotation[] = []): AnnotationStorage & {
    saved: Annotation[];
    deleted: string[];
    cleared: number;
} {
    const stub = {
        saved: [] as Annotation[],
        deleted: [] as string[],
        cleared: 0,
        loadAnnotations: vi.fn(async (): Promise<Annotation[]> => [...initial]),
        saveAnnotation: vi.fn(async (a: Annotation): Promise<void> => {
            stub.saved.push(a);
        }),
        deleteAnnotation: vi.fn(async (id: string): Promise<void> => {
            stub.deleted.push(id);
        }),
        clearAnnotations: vi.fn(async (): Promise<void> => {
            stub.cleared++;
        }),
    };
    return stub;
}

/**
 * Mount a fresh `<article class="markdown-body"><p>...</p></article>` in document.body.
 * XPath services in this codebase resolve from `article.markdown-body`, so the
 * `<article>` wrapper is required.
 */
function setupArticle(html: string): HTMLElement {
    const article = document.createElement('article');
    article.className = 'markdown-body';
    article.innerHTML = html;
    document.body.appendChild(article);
    return article;
}

function makeRange(node: Node, start: number, end: number): Range {
    const r = document.createRange();
    r.setStart(node, start);
    r.setEnd(node, end);
    return r;
}

describe('AnnotationManager', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        document.body.innerHTML = '';
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });

    it('createAnnotation builds the canonical schema fields', () => {
        const article = setupArticle('<p>hello world</p>');
        const storage = makeStorage();
        const mgr = new AnnotationManager(storage, article);

        const p = article.querySelector('p')!;
        const textNode = p.firstChild!; // 'hello world'
        const range = makeRange(textNode, 0, 5); // 'hello'

        const anno = mgr.createAnnotation(range, 'highlight-yellow', 'span');

        expect(anno.id).toMatch(/^anno-/);
        expect(anno.type).toBe('highlight-yellow');
        expect(anno.tagName).toBe('span');
        expect(anno.startPath).toContain('//article[1]');
        expect(anno.endPath).toContain('//article[1]');
        expect(anno.startOffset).toBe(0);
        expect(anno.endOffset).toBe(5);
        expect(anno.text).toBe('hello');
        expect(anno.note).toBeNull();
        expect(typeof anno.createdAt).toBe('number');
    });

    it('createAnnotation with a note carries the note string through', () => {
        const article = setupArticle('<p>note me</p>');
        const storage = makeStorage();
        const mgr = new AnnotationManager(storage, article);
        const range = makeRange(article.querySelector('p')!.firstChild!, 0, 4);
        const anno = mgr.createAnnotation(range, 'has-note', 'span', 'remember this');
        expect(anno.note).toBe('remember this');
        expect(anno.type).toBe('has-note');
    });

    it('add() persists to storage, updates getAll(), and emits a change event', async () => {
        const article = setupArticle('<p>aaa</p>');
        const storage = makeStorage();
        const mgr = new AnnotationManager(storage, article);

        const events: AnnotationChangeEvent[] = [];
        mgr.onChange(e => events.push(e));

        const range = makeRange(article.querySelector('p')!.firstChild!, 0, 3);
        const anno = mgr.createAnnotation(range, 'highlight-orange', 'span');
        await mgr.add(anno);

        expect(storage.saveAnnotation).toHaveBeenCalledTimes(1);
        expect(storage.saved[0].id).toBe(anno.id);
        expect(mgr.getAll()).toHaveLength(1);
        expect(mgr.getById(anno.id)?.id).toBe(anno.id);
        expect(events).toHaveLength(1);
        expect(events[0].action).toBe('add');
    });

    it('add() with skipSave=true does not call storage (used for remote echoes)', async () => {
        const article = setupArticle('<p>aaa</p>');
        const storage = makeStorage();
        const mgr = new AnnotationManager(storage, article);
        const range = makeRange(article.querySelector('p')!.firstChild!, 0, 3);
        const anno = mgr.createAnnotation(range, 'highlight-green', 'span');
        await mgr.add(anno, true);
        expect(storage.saveAnnotation).not.toHaveBeenCalled();
        expect(mgr.getAll()).toHaveLength(1);
    });

    it('applyToDOM wraps the range in the configured tag with annotation metadata', () => {
        const article = setupArticle('<p>highlight this</p>');
        const storage = makeStorage();
        const mgr = new AnnotationManager(storage, article);

        const p = article.querySelector('p')!;
        const range = makeRange(p.firstChild!, 0, 9); // 'highlight'
        const anno = mgr.createAnnotation(range, 'highlight-yellow', 'span');
        mgr.applyToDOM([anno]);

        const wrap = article.querySelector<HTMLElement>('[data-annotation-id]');
        expect(wrap).not.toBeNull();
        expect(wrap!.tagName).toBe('SPAN');
        expect(wrap!.className).toBe('highlight-yellow');
        expect(wrap!.dataset.annotationId).toBe(anno.id);
        expect(wrap!.textContent).toBe('highlight');
    });

    it('applyToDOM uses <s> for strikethrough annotations', () => {
        const article = setupArticle('<p>strike me</p>');
        const storage = makeStorage();
        const mgr = new AnnotationManager(storage, article);
        const range = makeRange(article.querySelector('p')!.firstChild!, 0, 6); // 'strike'
        const anno = mgr.createAnnotation(range, 'strikethrough', 's');
        mgr.applyToDOM([anno]);
        const wrap = article.querySelector<HTMLElement>('[data-annotation-id]');
        expect(wrap?.tagName).toBe('S');
        expect(wrap?.className).toBe('strikethrough');
    });

    it('applyToDOM with a note sets data-note and adds has-note class', () => {
        const article = setupArticle('<p>noteworthy</p>');
        const storage = makeStorage();
        const mgr = new AnnotationManager(storage, article);
        const range = makeRange(article.querySelector('p')!.firstChild!, 0, 4); // 'note'
        const anno = mgr.createAnnotation(range, 'has-note', 'span', 'a note');
        mgr.applyToDOM([anno]);
        const wrap = article.querySelector<HTMLElement>('[data-annotation-id]');
        expect(wrap?.classList.contains('has-note')).toBe(true);
        expect(wrap?.dataset.note).toBe('a note');
    });

    it('delete() removes from internal list, calls storage, and emits a change', async () => {
        const article = setupArticle('<p>abcdef</p>');
        const storage = makeStorage();
        const mgr = new AnnotationManager(storage, article);
        const range = makeRange(article.querySelector('p')!.firstChild!, 0, 3);
        const anno = mgr.createAnnotation(range, 'highlight-orange', 'span');
        await mgr.add(anno);

        const events: AnnotationChangeEvent[] = [];
        mgr.onChange(e => events.push(e));

        const removed = await mgr.delete(anno.id);
        expect(removed?.id).toBe(anno.id);
        expect(mgr.getAll()).toHaveLength(0);
        expect(storage.deleteAnnotation).toHaveBeenCalledWith(anno.id);
        expect(events.at(-1)?.action).toBe('delete');
    });

    it('delete() with an unknown id warns and returns null', async () => {
        const article = setupArticle('<p>x</p>');
        const storage = makeStorage();
        const mgr = new AnnotationManager(storage, article);
        const result = await mgr.delete('anno-does-not-exist');
        expect(result).toBeNull();
        expect(warnSpy).toHaveBeenCalled();
    });

    it('removeFromDOM unwraps the annotation element and preserves text', () => {
        const article = setupArticle('<p>wrap me</p>');
        const storage = makeStorage();
        const mgr = new AnnotationManager(storage, article);
        const range = makeRange(article.querySelector('p')!.firstChild!, 0, 4); // 'wrap'
        const anno = mgr.createAnnotation(range, 'highlight-green', 'span');
        mgr.applyToDOM([anno]);

        expect(article.querySelector('[data-annotation-id]')).not.toBeNull();
        mgr.removeFromDOM(anno.id);
        expect(article.querySelector('[data-annotation-id]')).toBeNull();
        expect(article.textContent).toBe('wrap me');
    });

    it('clearDOM unwraps every annotation element in the body', () => {
        const article = setupArticle('<p>one two three</p>');
        const storage = makeStorage();
        const mgr = new AnnotationManager(storage, article);
        const text = article.querySelector('p')!.firstChild!;
        const a1 = mgr.createAnnotation(makeRange(text, 0, 3), 'highlight-orange', 'span');
        mgr.applyToDOM([a1]);
        // After applyToDOM, the original text node is gone — re-fetch a fresh range
        // for the second annotation.
        const remainingText = article.querySelector('p')!.lastChild!;
        const a2 = mgr.createAnnotation(makeRange(remainingText, 1, 4), 'highlight-yellow', 'span');
        mgr.applyToDOM([a2]);

        expect(article.querySelectorAll('[data-annotation-id]').length).toBe(2);
        mgr.clearDOM();
        expect(article.querySelectorAll('[data-annotation-id]').length).toBe(0);
        expect(article.textContent).toBe('one two three');
    });

    it('clear() empties the list, calls storage, and reports the prior list', async () => {
        const article = setupArticle('<p>abcdef</p>');
        const storage = makeStorage();
        const mgr = new AnnotationManager(storage, article);
        const range = makeRange(article.querySelector('p')!.firstChild!, 0, 3);
        const anno = mgr.createAnnotation(range, 'highlight-orange', 'span');
        await mgr.add(anno);

        const events: AnnotationChangeEvent[] = [];
        mgr.onChange(e => events.push(e));

        await mgr.clear();
        expect(mgr.getAll()).toHaveLength(0);
        expect(storage.cleared).toBe(1);
        const last = events.at(-1)!;
        expect(last.action).toBe('clear');
        expect(Array.isArray(last.data)).toBe(true);
        expect((last.data as Annotation[])[0].id).toBe(anno.id);
    });

    it('load() pulls from storage into the in-memory list', async () => {
        const article = setupArticle('<p>x</p>');
        const seed: Annotation = {
            id: 'anno-seed',
            type: 'highlight-orange',
            tagName: 'span',
            startPath: '//article[1]/P[1]',
            endPath: '//article[1]/P[1]',
            startOffset: 0,
            endOffset: 1,
            text: 'x',
            note: null,
            createdAt: 1,
        };
        const storage = makeStorage([seed]);
        const mgr = new AnnotationManager(storage, article);
        await mgr.load();
        expect(mgr.getAll()).toHaveLength(1);
        expect(mgr.getById('anno-seed')).not.toBeNull();
    });
});
