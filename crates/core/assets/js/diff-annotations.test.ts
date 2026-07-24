import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import type { Annotation } from './managers/annotation-manager';

const annotation = (
    id: string,
    exact: string,
    prefix: string,
    suffix: string,
    note: string,
): Annotation => ({
    id,
    type: 'has-note',
    tagName: 'span',
    anchor: { position: prefix.length, exact, prefix, suffix },
    text: exact,
    note,
    createdAt: 1,
});

describe('diff annotation coordinator init', () => {
    beforeEach(() => {
        vi.resetModules();
        document.body.innerHTML = '';
        document.head.innerHTML = '';
        localStorage.clear();
        delete window.markonDiffAnnotations;
        vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(() => {});
        Object.defineProperty(window, 'innerWidth', {
            value: 1600,
            configurable: true,
            writable: true,
        });
    });

    afterEach(() => {
        document.querySelector<HTMLButtonElement>('.editor-close-btn')?.click();
        document.querySelectorAll<HTMLElement>('.cm-editor').forEach(dom => {
            EditorView.findFromDOM(dom)?.destroy();
        });
        delete window.markonDiffAnnotations;
        vi.restoreAllMocks();
    });

    it('starts on rendered compare pages even when the diff is not HEAD...worktree', async () => {
        document.head.innerHTML = '<meta name="is-worktree-diff" content="false">';
        document.body.innerHTML = '<article data-md-diff-content></article>';

        await import('./diff-annotations');

        expect(window.markonDiffAnnotations).toBeTruthy();
        expect(typeof window.markonDiffAnnotations?.exportNotes).toBe('function');
        expect(typeof window.markonDiffAnnotations?.notesCount).toBe('function');
    });

    it('exports every file through the shared context-aware Markdown formatter', async () => {
        document.head.innerHTML = `
            <meta name="workspace-id" content="ws-1">
            <meta name="can-manage" content="true">
        `;
        document.body.innerHTML = `
            <article data-md-diff-content>
                <section class="md-diff-file-section"
                    data-abs-path="/abs/alpha.md" data-file-path="docs/alpha.md">
                    <div class="md-diff-file-body">
                        <p>The quick brown fox jumps.</p>
                    </div>
                </section>
                <section class="md-diff-file-section"
                    data-abs-path="/abs/beta.md" data-file-path="docs/beta.md">
                    <div class="md-diff-file-body">
                        <p>Delta echo foxtrot.</p>
                    </div>
                </section>
            </article>
        `;

        const byPath = new Map<string, Annotation[]>([
            ['/abs/alpha.md', [
                annotation('alpha-note', 'brown fox', 'The quick ', ' jumps.', 'alpha note'),
            ]],
            ['/abs/beta.md', [
                annotation('beta-note', 'echo', 'Delta ', ' foxtrot.', 'beta note'),
            ]],
        ]);
        vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
            const url = new URL(String(input), 'http://markon.test');
            if (url.pathname.includes('/document-state')) {
                return {
                    ok: true,
                    status: 200,
                    text: async () => '',
                    json: async () => ({
                        annotations: byPath.get(url.searchParams.get('path') ?? '') ?? [],
                        viewed_state: {},
                    }),
                };
            }
            return {
                ok: true,
                status: 200,
                text: async () => '',
                json: async () => ({ html: '' }),
            };
        }));

        await import('./diff-annotations');

        await expect(window.markonDiffAnnotations?.exportNotes()).resolves.toBe(true);
        const editorDom = document.querySelector<HTMLElement>('.cm-editor');
        expect(editorDom).toBeTruthy();
        const content = editorDom
            ? EditorView.findFromDOM(editorDom)?.state.doc.toString()
            : null;
        expect(content).toBe(
            'notes.md\n\n'
            + '# docs/alpha.md\n\n'
            + '> The quick *brown fox* jumps.\n\n'
            + 'alpha note\n\n'
            + '# docs/beta.md\n\n'
            + '> Delta *echo* foxtrot.\n\n'
            + 'beta note\n',
        );
    });
});
