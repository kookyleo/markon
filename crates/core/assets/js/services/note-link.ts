import { workspaceFileUrl } from '../core/routes';

const NOTE_HASH_PREFIX = 'note-';
const VALID_ANNOTATION_ID = /^anno-[A-Za-z0-9-]{1,64}$/;

export function isValidNoteLinkId(id: string): boolean {
    return VALID_ANNOTATION_ID.test(id);
}

export function noteLinkHash(annotationId: string): string {
    if (!isValidNoteLinkId(annotationId)) return '';
    return `${NOTE_HASH_PREFIX}${encodeURIComponent(annotationId)}`;
}

export function noteLinkIdFromHash(hash: string): string | null {
    const raw = hash.replace(/^#/, '');
    if (!raw.startsWith(NOTE_HASH_PREFIX)) return null;
    try {
        const id = decodeURIComponent(raw.slice(NOTE_HASH_PREFIX.length));
        return isValidNoteLinkId(id) ? id : null;
    } catch {
        return null;
    }
}

export function currentPageNoteLink(annotationId: string, href = window.location.href): string {
    const hash = noteLinkHash(annotationId);
    if (!hash) return '';
    const url = new URL(href, window.location.origin);
    url.search = '';
    url.hash = hash;
    return url.toString();
}

export function workspaceFileNoteLink(
    workspaceId: string,
    filePath: string,
    annotationId: string,
): string {
    const hash = noteLinkHash(annotationId);
    if (!hash) return '';
    const url = new URL(workspaceFileUrl(workspaceId, filePath), window.location.origin);
    url.hash = hash;
    return url.toString();
}
