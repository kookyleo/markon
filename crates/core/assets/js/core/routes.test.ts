import { describe, expect, it } from 'vitest';
import {
    encodePathSegments,
    workspaceChatUrl,
    workspaceChatApiUrl,
    workspaceFileDeleteUrl,
    workspaceFileUrl,
    workspaceFilesDataUrl,
    workspaceInternalUrl,
    workspaceRootUrl,
    workspaceSearchUrl,
} from './routes';

describe('route helpers', () => {
    it('keeps workspace document URLs in the public file namespace', () => {
        expect(workspaceRootUrl('abcd1234')).toBe('/abcd1234/');
        expect(workspaceFileUrl('abcd1234', 'docs/hello world.md')).toBe('/abcd1234/docs/hello%20world.md');
        expect(workspaceFileUrl('abcd1234', '/docs/a#b.md')).toBe('/abcd1234/docs/a%23b.md');
    });

    it('keeps workspace tools under the underscore namespace', () => {
        expect(workspaceInternalUrl('abcd1234', 'git/history')).toBe('/_/abcd1234/git/history');
        expect(workspaceFilesDataUrl('abcd1234')).toBe('/_/abcd1234/files/data');
        expect(workspaceFileDeleteUrl('abcd1234')).toBe('/_/abcd1234/files/delete');
        expect(workspaceChatUrl('abcd1234')).toBe('/_/abcd1234/chat');
        expect(workspaceChatApiUrl('abcd1234')).toBe('/api/chat/abcd1234');
        expect(workspaceChatApiUrl('abcd1234', 'threads/t1')).toBe('/api/chat/abcd1234/threads/t1');
    });

    it('builds the canonical workspace search URL', () => {
        expect(workspaceSearchUrl('abcd1234', 'hello world')).toBe('/_/abcd1234/search?q=hello%20world');
    });

    it('encodes segments without encoding path separators', () => {
        expect(encodePathSegments('a b/c+d/e#f')).toBe('a%20b/c%2Bd/e%23f');
    });
});
