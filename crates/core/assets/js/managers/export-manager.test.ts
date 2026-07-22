import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
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
    let activeManagers: ExportManager[];

    beforeEach(() => {
        activeManagers = [];
        document.body.innerHTML = '';
        document.head.innerHTML = '';
        localStorage.clear();
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        // Export tests assert buffer/content behavior, not focus. Prevent
        // CodeMirror from scheduling its hard-coded delayed focus update after
        // this short test has already torn down jsdom (a full-suite race).
        vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(() => {});
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            status: 200,
            text: async () => '',
            json: async () => ({ html: '' }),
        })));
        Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true, writable: true });
    });

    afterEach(() => {
        activeManagers.forEach(manager => manager.close());
        document.querySelectorAll<HTMLElement>('.cm-editor').forEach(dom => {
            EditorView.findFromDOM(dom)?.destroy();
        });
        logSpy.mockRestore();
        vi.restoreAllMocks();
    });

    it('opens the editable Markdown export directly without the selection step', async () => {
        const note = annotation('with-note', 'keep me');
        const plain = annotation('highlight-only', null);
        const manager = makeManager([note, plain]);
        const exportManager = new ExportManager({
            annotationManager: manager,
            getDocumentTitle: () => 'Review notes',
            getFilePath: () => '/tmp/review.md',
        });
        activeManagers.push(exportManager);

        expect(exportManager.open()).toBe(true);

        expect(document.querySelector('.export-modal')).toBeNull();
        await vi.waitFor(() => {
            expect(document.querySelector('.editor-modal-export')).toBeTruthy();
        });
        expect(document.querySelector('.editor-back-btn')).toBeNull();
        const editorDom = document.querySelector<HTMLElement>('.cm-editor');
        expect(editorDom).toBeTruthy();
        expect(editorDom ? EditorView.findFromDOM(editorDom)?.state.doc.toString() : null)
            .toBe('Review-notes.md\n\n"quoted"\n> note\n');
        expect(document.querySelector('.editor-file-name')?.textContent).toBe('web.export.label');

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
        activeManagers.push(exportManager);

        expect(exportManager.open()).toBe(false);
        expect(document.querySelector('.export-modal')).toBeNull();
        expect(document.querySelector('.editor-modal-export')).toBeNull();
        expect(manager.formatAsMarkdown).not.toHaveBeenCalled();
    });

    it('exports only notes inside the requested heading section', async () => {
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
        activeManagers.push(exportManager);

        expect(exportManager.open('section-a')).toBe(true);
        await vi.waitFor(() => {
            expect(document.querySelector('.editor-modal-export')).toBeTruthy();
        });

        expect(getAllInSection).toHaveBeenCalledWith('section-a');
        expect(manager.getAllInDocumentOrder).not.toHaveBeenCalled();
        const format = manager.formatAsMarkdown as unknown as ReturnType<typeof vi.fn>;
        expect(Array.from(itemAt(format.mock.calls, 0)[0].ids)).toEqual([
            'parent-note',
            'child-note',
        ]);
    });
});
