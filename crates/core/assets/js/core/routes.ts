/**
 * Browser-side URL builders.
 *
 * Keep route shape decisions here instead of scattering string templates across
 * page managers. The canonical split is:
 *   - /{workspace_id}/...       user document/file space
 *   - /_/{workspace_id}/...     workspace tools, data, and chrome pages
 *   - /api/...                  programmatic APIs
 */

/** Percent-encode path segments while preserving `/` separators. */
export function encodePathSegments(path: string): string {
    return path
        .split('/')
        .filter((part, index, parts) => part !== '' || (index > 0 && index < parts.length - 1))
        .map(encodeURIComponent)
        .join('/');
}

function cleanWorkspaceId(workspaceId: string): string {
    return encodeURIComponent(workspaceId.trim().replace(/^\/+|\/+$/g, ''));
}

function cleanToolPath(path: string): string {
    return path.trim().replace(/^\/+/, '');
}

export function workspaceRootUrl(workspaceId: string): string {
    const ws = cleanWorkspaceId(workspaceId);
    return ws ? `/${ws}/` : '/';
}

export function workspaceFileUrl(workspaceId: string, path = ''): string {
    const rel = path.trim().replace(/^\/+/, '');
    const root = workspaceRootUrl(workspaceId);
    return rel ? `${root}${encodePathSegments(rel)}` : root;
}

export function workspaceInternalUrl(workspaceId: string, path: string): string {
    const ws = cleanWorkspaceId(workspaceId);
    const rel = cleanToolPath(path);
    return ws ? `/_/${ws}/${rel}` : `/_/${rel}`;
}

export function workspaceSearchUrl(workspaceId: string, query: string): string {
    return `${workspaceInternalUrl(workspaceId, 'search')}?q=${encodeURIComponent(query)}`;
}

export function workspaceFilesDataUrl(workspaceId: string): string {
    return workspaceInternalUrl(workspaceId, 'files/data');
}

export function workspaceDocumentStateUrl(workspaceId: string): string {
    return workspaceInternalUrl(workspaceId, 'data/document-state');
}

export function workspaceFileDeleteUrl(workspaceId: string): string {
    return workspaceInternalUrl(workspaceId, 'files/delete');
}

export function workspaceChatUrl(workspaceId: string): string {
    return workspaceInternalUrl(workspaceId, 'chat');
}

export function workspaceWebSocketUrl(workspaceId: string): string {
    return workspaceInternalUrl(workspaceId, 'ws');
}

export function workspaceChatApiUrl(workspaceId: string, path = ''): string {
    const ws = cleanWorkspaceId(workspaceId);
    const rel = cleanToolPath(path);
    if (!ws) return rel ? `/api/chat/${rel}` : '/api/chat';
    return rel ? `/api/chat/${ws}/${rel}` : `/api/chat/${ws}`;
}
