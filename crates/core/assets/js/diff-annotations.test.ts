import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('diff annotation coordinator init', () => {
    beforeEach(() => {
        vi.resetModules();
        document.body.innerHTML = '';
        document.head.innerHTML = '';
        delete window.markonDiffAnnotations;
    });

    afterEach(() => {
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
});
