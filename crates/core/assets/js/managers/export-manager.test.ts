import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportManager } from './export-manager';
import type { Annotation, AnnotationManager } from './annotation-manager';

const annotation = (id: string, note: string | null): Annotation => ({
    id,
    type: note ? 'has-note' : 'highlight-yellow',
    tagName: 'span',
    anchor: { position: 0, exact: id, prefix: '', suffix: '' },
    text: id,
    note,
    createdAt: 1,
});

const makeManager = (items: Annotation[], markdown = '"quoted"\n> note\n'): AnnotationManager => ({
    getAllInDocumentOrder: vi.fn(() => items),
    getAllInSection: vi.fn(() => items),
    formatAsMarkdown: vi.fn(() => markdown),
} as unknown as AnnotationManager);

function itemAt<T>(items: ArrayLike<T>, index: number): T {
    const item = items[index];
    expect(item).toBeDefined();
    if (item === undefined) throw new Error(`Missing item at index ${index}`);
    return item;
}

describe('ExportManager', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        document.body.innerHTML = '';
        document.head.innerHTML = '';
        localStorage.clear();
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            status: 200,
            text: async () => '',
            json: async () => ({ html: '' }),
        })));
        Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true, writable: true });
    });

    afterEach(() => {
        logSpy.mockRestore();
        vi.restoreAllMocks();
    });

    it('opens the editable Markdown export directly without the selection step', () => {
        const note = annotation('with-note', 'keep me');
        const plain = annotation('highlight-only', null);
        const manager = makeManager([note, plain]);
        const exportManager = new ExportManager({
            annotationManager: manager,
            getDocumentTitle: () => 'Review notes',
            getFilePath: () => '/tmp/review.md',
        });

        expect(exportManager.open()).toBe(true);

        expect(document.querySelector('.export-modal')).toBeNull();
        expect(document.querySelector('.editor-modal-export')).toBeTruthy();
        expect(document.querySelector('.editor-back-btn')).toBeNull();
        expect(document.querySelector<HTMLTextAreaElement>('.editor-textarea')?.value)
            .toBe('"quoted"\n> note\n');

        const format = manager.formatAsMarkdown as unknown as ReturnType<typeof vi.fn>;
        expect(format).toHaveBeenCalledTimes(1);
        expect(Array.from(itemAt(format.mock.calls, 0)[0].ids)).toEqual(['with-note']);
    });

    it('does not open when there are no notes', () => {
        const manager = makeManager([annotation('highlight-only', null)]);
        const exportManager = new ExportManager({
            annotationManager: manager,
            getDocumentTitle: () => 'Review notes',
            getFilePath: () => '/tmp/review.md',
        });

        expect(exportManager.open()).toBe(false);
        expect(document.querySelector('.export-modal')).toBeNull();
        expect(document.querySelector('.editor-modal-export')).toBeNull();
        expect(manager.formatAsMarkdown).not.toHaveBeenCalled();
    });

    it('exports only notes inside the requested heading section', () => {
        const parentNote = annotation('parent-note', 'keep me');
        const childNote = annotation('child-note', 'keep me too');
        const outsideNote = annotation('outside-note', 'leave out');
        const highlight = annotation('highlight-only', null);
        const manager = makeManager([outsideNote]);
        const getAllInSection = manager.getAllInSection as unknown as ReturnType<typeof vi.fn>;
        getAllInSection.mockReturnValue([parentNote, highlight, childNote]);
        const exportManager = new ExportManager({
            annotationManager: manager,
            getDocumentTitle: () => 'Review notes',
            getFilePath: () => '/tmp/review.md',
        });

        expect(exportManager.open('section-a')).toBe(true);

        expect(getAllInSection).toHaveBeenCalledWith('section-a');
        expect(manager.getAllInDocumentOrder).not.toHaveBeenCalled();
        const format = manager.formatAsMarkdown as unknown as ReturnType<typeof vi.fn>;
        expect(Array.from(itemAt(format.mock.calls, 0)[0].ids)).toEqual([
            'parent-note',
            'child-note',
        ]);
    });
});
