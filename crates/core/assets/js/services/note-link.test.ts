import { describe, expect, it } from 'vitest';
import {
    currentPageNoteLink,
    noteLinkHash,
    noteLinkIdFromHash,
    workspaceFileNoteLink,
} from './note-link';

describe('note-link', () => {
    it('round-trips note hashes for annotation ids', () => {
        const hash = noteLinkHash('anno-1234-abcd');
        expect(hash).toBe('note-anno-1234-abcd');
        expect(noteLinkIdFromHash(`#${hash}`)).toBe('anno-1234-abcd');
    });

    it('rejects non-annotation note hashes', () => {
        expect(noteLinkHash('bad')).toBe('');
        expect(noteLinkIdFromHash('#note-bad')).toBeNull();
        expect(noteLinkIdFromHash('#section-1')).toBeNull();
    });

    it('builds current page note links without transient query params', () => {
        const link = currentPageNoteLink(
            'anno-abc',
            'http://localhost:1618/9b964b8d/docs/a.md?highlight=x#old',
        );
        expect(link).toBe('http://localhost:1618/9b964b8d/docs/a.md#note-anno-abc');
    });

    it('builds workspace file note links', () => {
        const link = workspaceFileNoteLink('9b964b8d', 'docs/a b.md', 'anno-abc');
        expect(link).toBe(`${window.location.origin}/9b964b8d/docs/a%20b.md#note-anno-abc`);
    });
});
