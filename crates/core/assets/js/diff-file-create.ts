/**
 * Inline "new file / new folder" affordances for the compare/diff sidebar tree.
 *
 * Active only when `diff-editable` is set (the comparison targets the writable
 * worktree AND the workspace permits editing). Each folder row (and a root
 * affordance) gets a hover/▸right-click "+" that offers New file / New folder;
 * choosing one drops an inline name input. New files open in the editor; new
 * folders are inserted into the tree so they're visible and can host children
 * (they won't otherwise appear — the diff tree only lists *changed* files).
 *
 * Classic (IIFE) bundle, loaded as a non-module <script> on git-diff.html.
 */

import { Meta } from './services/dom';

type Kind = 'file' | 'folder';
interface CreateUrls { file: string; folder: string; }

const PLUS_SVG =
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M8 2.75a.75.75 0 0 1 .75.75v3.75h3.75a.75.75 0 0 1 0 1.5H8.75v3.75a.75.75 0 0 1-1.5 0V8.75H3.5a.75.75 0 0 1 0-1.5h3.75V3.5A.75.75 0 0 1 8 2.75Z"/></svg>';

/** Inner markup of a folder row: chevron twist + folder octicon + name. Matches
 *  the server-rendered GitHub-style tree so created folders look identical. */
const folderRowInner = (): string =>
    '<span class="git-nav-twist" aria-hidden="true"><svg class="git-nav-chevron" viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"/></svg></span>' +
    '<span class="git-nav-main"><span class="git-nav-icon git-nav-folder" aria-hidden="true"><svg viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1Z"/></svg></span>' +
    '<span class="git-nav-name"></span></span>';

/** Inner markup of the workspace-root row: a folder-with-badge workspace icon +
 *  the project name (NOT "/", which reads like the filesystem root). No chevron. */
const rootRowInner = (): string =>
    '<span class="git-nav-twist" aria-hidden="true"></span>' +
    '<span class="git-nav-main"><span class="git-nav-icon git-nav-folder" aria-hidden="true"><svg viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1Z"/><circle class="git-ws-badge-cut" cx="12" cy="11.4" r="3.4"/><circle class="git-ws-badge-dot" cx="12" cy="11.4" r="2.1"/></svg></span>' +
    '<span class="git-nav-name"></span></span>';

/** The project/workspace display name (last path segment), for the root row. */
const projectName = (): string => {
    const p = document.querySelector('.git-diff-ws-path')?.textContent?.trim() || '';
    const name = p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || '';
    return name || 'Workspace root';
};

const workspaceId = (): string =>
    document.querySelector('meta[name="workspace-id"]')?.getAttribute('content') || '';

const fileRoute = (path: string): string =>
    `/${workspaceId()}/${path.split('/').map(encodeURIComponent).join('/')}`;

function closeMenus(): void {
    document.querySelectorAll('.git-nav-add-menu').forEach((m) => m.remove());
}

async function create(kind: Kind, path: string, urls: CreateUrls): Promise<{ ok: boolean; url?: string }> {
    const url = kind === 'file' ? urls.file : urls.folder;
    try {
        const resp = await fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(kind === 'file' ? { path, content: '' } : { path }),
        });
        const text = await resp.text();
        let data: { success?: boolean; message?: string; url?: string } = {};
        try { data = text ? JSON.parse(text) : {}; } catch { /* ignore */ }
        if (!resp.ok || data.success === false) {
            window.alert(data.message || text || resp.statusText);
            return { ok: false };
        }
        return { ok: true, url: data.url || undefined };
    } catch (err) {
        window.alert(err instanceof Error ? err.message : String(err));
        return { ok: false };
    }
}

/** Build a dir `<li>` matching the server-rendered tree, with its own "+". */
function buildFolderRow(path: string, depth: number, urls: CreateUrls): HTMLLIElement {
    const li = document.createElement('li');
    li.setAttribute('data-diff-nav-entry', '');
    li.setAttribute('data-diff-kind', 'dir');
    li.setAttribute('data-diff-path', path);
    const row = document.createElement('div');
    row.className = 'git-nav-entry is-dir';
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.setAttribute('aria-expanded', 'true');
    row.setAttribute('data-diff-dir-toggle', '');
    row.style.setProperty('--depth', String(depth));
    const name = path.split('/').pop() || path;
    row.innerHTML = folderRowInner();
    row.querySelector('.git-nav-name')!.textContent = name;
    li.appendChild(row);
    mountFolderAffordance(row, path, urls);
    return li;
}

/** The 1-based nesting depth a folder row uses for its `--depth` indent. */
function rowDepth(row: HTMLElement): number {
    const v = parseInt(row.style.getPropertyValue('--depth') || '0', 10);
    return Number.isFinite(v) ? v : 0;
}

/** Drop an inline name input under `anchorLi`, indented one level past `depth`. */
function startInlineCreate(
    parentPath: string,
    kind: Kind,
    depth: number,
    anchorLi: HTMLElement,
    list: HTMLElement,
    urls: CreateUrls,
): void {
    list.querySelectorAll('.git-nav-input-row').forEach((r) => r.remove());
    const li = document.createElement('li');
    li.className = 'git-nav-input-row';
    const input = document.createElement('input');
    input.className = 'git-nav-input';
    input.type = 'text';
    input.placeholder = kind === 'file' ? 'name.md' : 'folder name';
    input.style.marginLeft = `${(depth + 1) * 14 + 18}px`;
    li.appendChild(input);
    anchorLi.after(li);
    input.focus();

    let done = false;
    const cancel = (): void => { if (!done) { done = true; li.remove(); } };
    const submit = async (): Promise<void> => {
        if (done) return;
        const name = input.value.trim().replace(/^\/+|\/+$/g, '');
        if (!name) { cancel(); return; }
        done = true;
        input.disabled = true;
        const path = parentPath ? `${parentPath}/${name}` : name;
        const res = await create(kind, path, urls);
        li.remove();
        if (!res.ok) return;
        if (kind === 'file') {
            // Open the freshly-created (empty) file straight into the editor.
            window.open((res.url || fileRoute(path)) + '?edit=1', '_blank', 'noopener');
        } else {
            // Surface the new folder in the tree so it can host children.
            anchorLi.after(buildFolderRow(path, depth + 1, urls));
        }
    };
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); void submit(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    input.addEventListener('blur', () => { window.setTimeout(() => { if (!input.value.trim()) cancel(); }, 120); });
}

function openCreateMenu(
    anchorBtn: HTMLElement,
    parentPath: string,
    depth: number,
    anchorLi: HTMLElement,
    list: HTMLElement,
    urls: CreateUrls,
): void {
    closeMenus();
    const menu = document.createElement('div');
    menu.className = 'git-nav-add-menu';
    const item = (label: string, kind: Kind): HTMLButtonElement => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'git-nav-add-item';
        b.textContent = label;
        b.addEventListener('click', () => {
            closeMenus();
            startInlineCreate(parentPath, kind, depth, anchorLi, list, urls);
        });
        return b;
    };
    menu.append(item('New file', 'file'), item('New folder', 'folder'));
    document.body.appendChild(menu);
    const r = anchorBtn.getBoundingClientRect();
    menu.style.left = `${Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)}px`;
    menu.style.top = `${r.bottom + 4}px`;

    const onDoc = (e: MouseEvent): void => {
        if (!menu.contains(e.target as Node)) { closeMenus(); document.removeEventListener('mousedown', onDoc, true); }
    };
    document.addEventListener('mousedown', onDoc, true);
}

function mountFolderAffordance(row: HTMLElement, folderPath: string, urls: CreateUrls): void {
    if (row.querySelector(':scope > .git-nav-add')) return;
    const li = row.closest<HTMLElement>('[data-diff-nav-entry]');
    if (!li) return;
    // The workspace root (empty path) hosts children at depth 0, so its create
    // depth is -1; a real folder's children sit one level past its own depth.
    const createDepth = (): number => (folderPath === '' ? -1 : rowDepth(row));
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'git-nav-add';
    btn.title = 'New file or folder here';
    btn.setAttribute('aria-label', 'New file or folder here');
    btn.innerHTML = PLUS_SVG;
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openCreateMenu(btn, folderPath, createDepth(), li, li.parentElement as HTMLElement, urls);
    });
    row.appendChild(btn);
    // Right-click anywhere on the folder row opens the same menu.
    row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openCreateMenu(btn, folderPath, createDepth(), li, li.parentElement as HTMLElement, urls);
    });
}

const init = (): void => {
    if (!Meta.flag('diff-editable')) return;
    const list = document.querySelector<HTMLElement>('[data-diff-file-list]');
    if (!list) return;
    const urls: CreateUrls = {
        file: list.getAttribute('data-create-file-url') || '',
        folder: list.getAttribute('data-create-folder-url') || '',
    };
    if (!urls.file || !urls.folder) return;

    // Workspace root: a row at the top of the tree carrying the same
    // hover/right-click "+" affordance as folders (no special always-on button).
    // Labelled with the project name + a repo icon so it reads as the workspace
    // root, not the filesystem "/".
    const rootLi = document.createElement('li');
    rootLi.setAttribute('data-diff-nav-entry', '');
    rootLi.setAttribute('data-diff-kind', 'dir');
    rootLi.setAttribute('data-diff-path', '');
    const rootRow = document.createElement('div');
    rootRow.className = 'git-nav-entry is-dir is-root';
    rootRow.style.setProperty('--depth', '0');
    rootRow.innerHTML = rootRowInner();
    // Trailing "/" marks it as the workspace scope/root.
    rootRow.querySelector('.git-nav-name')!.textContent = `${projectName()}/`;
    rootRow.title = 'Workspace root';
    rootLi.appendChild(rootRow);
    list.prepend(rootLi);
    mountFolderAffordance(rootRow, '', urls);

    // Per-folder affordances.
    list.querySelectorAll<HTMLElement>('.git-nav-entry.is-dir').forEach((row) => {
        const li = row.closest<HTMLElement>('[data-diff-nav-entry]');
        mountFolderAffordance(row, li?.getAttribute('data-diff-path') || '', urls);
    });
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}

export {};
