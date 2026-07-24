/**
 * Directory / workspace landing page controls.
 *
 * i18n label application, the Markdown/all file filter, workspace feature
 * toggles, copy-to-clipboard buttons, the workspace dropdown, branch checkout,
 * and the workspace modals for adding files/folders.
 *
 * Built as a CLASSIC (IIFE) bundle and loaded as a non-module `<script>` at the
 * same spot in `directory.html` where this used to live inline — it runs during
 * parse, before the deferred `main.js` / `workspace-diff.js` modules.
 */

import {
    isAdminSessionExpiredError,
    requireActiveAdminSession,
    showAdminActionError,
} from './core/admin-actions';

type I18nFn = (key: string) => string;

const t: I18nFn = (window.__MARKON_I18N__?.t) || ((k: string) => k);

// ── Static i18n labels ──────────────────────────────────────────────────────
const heading = document.getElementById('dir-heading');
// Only translate when an i18n key is present; a server-rendered alias has no
// key and must be left as-is (don't fall back to the generic heading).
if (heading?.dataset['i18nKey']) heading.textContent = t(heading.dataset['i18nKey']);
const labelMap: Record<string, string> = {
    'dir-current-label': 'web.dir.current',
    'dir-footer': 'web.footer',
    'dir-feedback-link': 'web.footer.feedback',
    'dir-kbd-link': 'web.kbd.link',
};
for (const [id, key] of Object.entries(labelMap)) {
    const el = document.getElementById(id);
    if (el) el.textContent = t(key);
}
document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n') || '');
});
document.querySelectorAll<HTMLElement>('[data-i18n-placeholder]').forEach((el) => {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder') || ''));
});
document.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((el) => {
    el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria') || ''));
});
document.querySelectorAll<HTMLElement>('[data-workspace-spotlight-trigger]').forEach((trigger) => {
    trigger.setAttribute('aria-label', t('web.wsnav.open'));
    trigger.setAttribute('title', t('web.wsnav.open'));
});

// ── File filter (Markdown / all) ────────────────────────────────────────────
function setFileFilter(mode: string | null): void {
    const next = mode === 'all' ? 'all' : 'markdown';
    document.querySelectorAll<HTMLElement>('.dir-list[data-file-filter]').forEach((list) => {
        list.setAttribute('data-file-filter', next);
    });
    document
        .querySelectorAll<HTMLElement>('[data-file-filter-switch] [data-file-filter-value]')
        .forEach((button) => {
            const active = button.getAttribute('data-file-filter-value') === next;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
}
document.querySelectorAll<HTMLElement>('[data-file-filter-switch]').forEach((group) => {
    group.addEventListener('click', (event) => {
        const target = event.target as Element | null;
        const button = target && target.closest ? target.closest('[data-file-filter-value]') : null;
        if (!button) return;
        event.preventDefault();
        setFileFilter(button.getAttribute('data-file-filter-value'));
    });
});
setFileFilter('markdown');

// ── Workspace feature toggles (live POST) ───────────────────────────────────
function featurePayload(inputs: HTMLInputElement[]): Record<string, boolean> {
    const payload: Record<string, boolean> = {};
    inputs.forEach((input) => {
        payload[input.getAttribute('data-feature-key') || ''] = input.checked;
    });
    return payload;
}
function setFeaturePending(form: HTMLElement, pending: boolean): void {
    const canEdit = form.getAttribute('data-can-edit') === 'true';
    form.querySelectorAll<HTMLInputElement>('input[data-feature-key]').forEach((input) => {
        input.disabled = pending || !canEdit;
        const row = input.closest('.workspace-feature-switch');
        if (row) row.classList.toggle('is-pending', pending);
    });
}
function syncFeatureSwitch(input: HTMLInputElement): void {
    const row = input.closest('.workspace-feature-switch');
    if (row) row.classList.toggle('is-on', input.checked);
}
function setupWorkspaceFeatureForm(): void {
    const form = document.querySelector<HTMLElement>('[data-workspace-feature-form]');
    if (!form) return;
    const inputs = Array.from(form.querySelectorAll<HTMLInputElement>('input[data-feature-key]'));
    inputs.forEach(syncFeatureSwitch);
    if (form.getAttribute('data-can-edit') !== 'true') return;
    inputs.forEach((input) => {
        input.addEventListener('change', () => {
            const previous = !input.checked;
            syncFeatureSwitch(input);
            setFeaturePending(form, true);
            fetch(form.getAttribute('data-update-url') || '', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(featurePayload(inputs)),
            })
                .then((resp) => {
                    requireActiveAdminSession(resp);
                    return resp.text().then((text) => {
                        let data: { success?: boolean; message?: string } = {};
                        try { data = text ? JSON.parse(text) as { success?: boolean; message?: string } : {}; } catch { /* ignore */ }
                        if (!resp.ok || data.success === false) throw new Error(data.message || text || resp.statusText);
                        setFeaturePending(form, false);
                    });
                })
                .catch((err: unknown) => {
                    input.checked = previous;
                    syncFeatureSwitch(input);
                    setFeaturePending(form, false);
                    showAdminActionError(
                        isAdminSessionExpiredError(err)
                            ? err
                            : new Error(`${t('web.ws.feature.update_failed')}: ${errorMessage(err)}`),
                        t('web.ws.feature.update_failed'),
                    );
                });
        });
    });
}
setupWorkspaceFeatureForm();

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

// ── Copy buttons ────────────────────────────────────────────────────────────
function copyText(text: string): Promise<boolean> {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(() => true, () => false);
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', 'readonly');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- Intentional clipboard fallback for non-secure contexts.
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return Promise.resolve(ok);
}
document.querySelectorAll<HTMLElement>('[data-copy-text]').forEach((button) => {
    button.addEventListener('click', () => {
        const value = button.getAttribute('data-copy-text') || '';
        const original = t(button.getAttribute('data-i18n') || 'web.ws.meta.copy_id');
        void copyText(value).then((ok) => {
            button.textContent = t(ok ? 'web.ws.meta.copied' : 'web.ws.meta.copy_failed');
            window.setTimeout(() => { button.textContent = original; }, 1200);
        });
    });
});
document.querySelectorAll<HTMLElement>('[data-copy-current-url]').forEach((button) => {
    button.addEventListener('click', () => {
        const original = button.textContent;
        void copyText(window.location.href).then((ok) => {
            button.textContent = t(ok ? 'web.ws.meta.copied' : 'web.ws.meta.copy_failed');
            window.setTimeout(() => { button.textContent = original; }, 1200);
        });
    });
});

// Set/clear the workspace alias (a short display name). Prompt-based — a
// secondary, low-traffic action folded into the menu.
document.querySelectorAll<HTMLElement>('[data-set-alias]').forEach((button) => {
    button.addEventListener('click', () => {
        const url = button.getAttribute('data-alias-url') || '';
        if (!url) return;
        const current = button.getAttribute('data-current-alias') || '';
        const next = window.prompt(t('web.ws.set_alias_prompt'), current);
        if (next === null) return; // cancelled
        fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alias: next.trim() }),
        })
            .then((resp) => {
                requireActiveAdminSession(resp);
                if (!resp.ok) throw new Error(t('web.ws.set_alias_failed'));
                window.location.reload();
            })
            .catch((error: unknown) => showAdminActionError(error, t('web.ws.set_alias_failed')));
    });
});

// ── Workspace dropdown ──────────────────────────────────────────────────────
document.querySelectorAll<HTMLElement>('[data-workspace-dropdown] > button').forEach((button) => {
    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const menu = button.closest<HTMLElement>('[data-workspace-dropdown]');
        if (!menu) return;
        const open = menu.classList.contains('is-open');
        const toggle = (): void => {
            document.querySelectorAll('[data-workspace-dropdown].is-open').forEach((other) => {
                if (other !== menu) other.classList.remove('is-open');
            });
            menu.classList.toggle('is-open', !open);
            if (!open) {
                const filter = menu.querySelector<HTMLInputElement>('[data-branch-filter]');
                if (filter) window.setTimeout(() => filter.focus(), 0);
            }
        };
        toggle();
    });
});
document.addEventListener('click', () => {
    document.querySelectorAll('[data-workspace-dropdown].is-open').forEach((menu) => {
        menu.classList.remove('is-open');
    });
});

// ── Branch checkout ─────────────────────────────────────────────────────────
document.querySelectorAll<HTMLButtonElement>('[data-checkout-branch]').forEach((button) => {
    button.addEventListener('click', (event) => {
        event.preventDefault();
        const branch = button.getAttribute('data-checkout-branch') || '';
        const shell = document.querySelector('[data-workspace-workbench]');
        const url = shell && shell.getAttribute('data-checkout-url');
        if (!branch || !url || button.disabled) return;
        fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ branch }),
        })
            .then((resp) => {
                requireActiveAdminSession(resp);
                return resp.text().then((text) => {
                    let data: { success?: boolean; message?: string } = {};
                    try { data = text ? JSON.parse(text) as { success?: boolean; message?: string } : {}; } catch { /* ignore */ }
                    if (!resp.ok || data.success === false) throw new Error(data.message || text || resp.statusText);
                    window.location.reload();
                });
            })
            .catch((err: unknown) => {
                showAdminActionError(err, errorMessage(err));
            });
    });
});

// ── Switch branches/tags panel (tabs + filter + close) ──────────────────────
document.querySelectorAll<HTMLElement>('[data-branch-panel]').forEach((panel) => {
    // Keep clicks inside the panel (search, tabs) from bubbling to the document
    // outside-click handler that closes the dropdown. Checkout reloads anyway.
    panel.addEventListener('click', (event) => event.stopPropagation());
    const dropdown = panel.closest('[data-workspace-dropdown]');
    const close = panel.querySelector<HTMLElement>('[data-branch-panel-close]');
    if (close && dropdown) {
        close.addEventListener('click', () => dropdown.classList.remove('is-open'));
    }
    const tabs = Array.from(panel.querySelectorAll<HTMLElement>('[data-branch-tab]'));
    const panes = Array.from(panel.querySelectorAll<HTMLElement>('[data-branch-pane]'));
    const search = panel.querySelector<HTMLElement>('[data-branch-panel-search]');
    tabs.forEach((tab) => {
        tab.addEventListener('click', () => {
            const key = tab.getAttribute('data-branch-tab');
            tabs.forEach((other) => other.classList.toggle('is-active', other === tab));
            panes.forEach((pane) => { pane.hidden = pane.getAttribute('data-branch-pane') !== key; });
            if (search) search.hidden = key !== 'branches';
        });
    });
    const filter = panel.querySelector<HTMLInputElement>('[data-branch-filter]');
    const items = Array.from(panel.querySelectorAll<HTMLElement>('[data-branch-item]'));
    const empty = panel.querySelector<HTMLElement>('[data-branch-empty]');
    if (filter) {
        filter.addEventListener('input', () => {
            const q = filter.value.trim().toLowerCase();
            let shown = 0;
            items.forEach((item) => {
                const name = item.getAttribute('data-branch-name-lower') || '';
                const match = !q || name.includes(q);
                item.hidden = !match;
                if (match) shown += 1;
            });
            if (empty) empty.hidden = shown !== 0;
        });
    }
});

// ── Workspace modals ────────────────────────────────────────────────────────
function openWorkspaceModal(modal: Element | null): void {
    if (!modal) return;
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
    const input = modal.querySelector<HTMLElement>('input, textarea, button');
    if (input) window.setTimeout(() => { input.focus(); }, 0);
}
function closeWorkspaceModals(): void {
    document.querySelectorAll('.workspace-modal.is-open').forEach((modal) => {
        modal.classList.remove('is-open');
        modal.setAttribute('aria-hidden', 'true');
    });
}
document.querySelectorAll<HTMLElement>('[data-close-workspace-modal]').forEach((button) => {
    button.addEventListener('click', closeWorkspaceModals);
});
document.querySelectorAll<HTMLElement>('.workspace-modal').forEach((modal) => {
    modal.addEventListener('click', (event) => {
        if (event.target === modal) closeWorkspaceModals();
    });
});

// ── Inline directory tree (expand a folder row in place) ────────────────────
// Folder rows on the file table expand in place into a lazily-built tree instead
// of navigating to the sub-directory page. Each folder's direct children are
// fetched on first expand from `/_/{id}/files/dir?path=<rel>` — the same shape
// the server renders the top-level table from, so tree rows carry the same
// last-commit metadata and the same three columns (name | commit | time). The
// markdown/all filter is honoured purely via CSS: the `data-file-filter`
// attribute on the `.dir-list` ancestor drives both top-level and tree rows.
interface DirEntry {
    name: string;
    is_dir: boolean;
    is_markdown: boolean;
    is_hidden: boolean;
    show_in_markdown: boolean;
    link: string;
    rel_git_path: string;
    last_commit_subject: string | null;
    last_commit_time: string | null;
}
const dirList = document.querySelector<HTMLElement>('.workspace-repo-file-list[data-dir-data-url]');
const dirDataUrl = (dirList && dirList.getAttribute('data-dir-data-url')) || '';
// Per-directory fetch cache (keyed by rel path) so re-expanding never refetches.
const dirCache = new Map<string, Promise<DirEntry[]>>();
function fetchDir(dirPath: string): Promise<DirEntry[]> {
    const cached = dirCache.get(dirPath);
    if (cached) return cached;
    if (!dirDataUrl) return Promise.resolve([]);
    const url = dirDataUrl + '?path=' + encodeURIComponent(dirPath);
    const req = fetch(url, { credentials: 'same-origin' })
        .then((resp) => { if (!resp.ok) throw new Error(resp.statusText); return resp.json() as Promise<DirEntry[]>; })
        .then((entries) => entries || [])
        .catch((err: unknown) => { dirCache.delete(dirPath); throw err; });
    dirCache.set(dirPath, req);
    return req;
}
function makeIcon(kind: 'folder' | 'file'): HTMLElement {
    const icon = document.createElement('span');
    icon.className = 'dir-icon dir-icon-' + kind;
    icon.setAttribute('aria-hidden', 'true');
    return icon;
}
// Render `entries` into `ul` at the given depth (0 = direct children of the
// expanded top-level folder). Each row is a three-column grid aligned with the
// top-level table; sub-folder rows are themselves toggleable.
function renderTree(ul: HTMLElement, entries: DirEntry[], depth: number): void {
    const pad = `${(depth + 1) * 18 + 5}px`;
    if (!entries.length) {
        const li = document.createElement('li');
        const empty = document.createElement('div');
        empty.className = 'workspace-tree-empty';
        empty.style.paddingLeft = pad;
        empty.textContent = t('web.ws.tree.empty');
        li.appendChild(empty);
        ul.appendChild(li);
        return;
    }
    for (const entry of entries) {
        const li = document.createElement('li');
        li.className = 'workspace-tree-item';
        li.setAttribute('data-entry-path', entry.rel_git_path);
        li.setAttribute('data-filter-visible-markdown', entry.show_in_markdown ? 'true' : 'false');
        const row = document.createElement('div');
        row.className = 'workspace-tree-row';
        const name = document.createElement('div');
        name.className = 'workspace-tree-name';
        name.style.paddingLeft = pad;
        if (entry.is_dir) {
            li.setAttribute('data-tree-dir', '');
            li.setAttribute('data-tree-path', entry.rel_git_path);
            li.dataset['depth'] = String(depth);
            row.setAttribute('role', 'button');
            row.setAttribute('tabindex', '0');
            row.setAttribute('aria-expanded', 'false');
            const label = document.createElement('span');
            label.className = 'workspace-tree-label';
            label.textContent = entry.name + '/';
            name.appendChild(makeIcon('folder'));
            name.appendChild(label);
        } else {
            const a = document.createElement('a');
            a.href = entry.link;
            a.textContent = entry.name;
            name.appendChild(makeIcon('file'));
            name.appendChild(a);
        }
        const commit = document.createElement('div');
        commit.className = 'workspace-entry-commit';
        if (entry.last_commit_subject) {
            commit.textContent = entry.last_commit_subject;
            commit.title = entry.last_commit_subject;
        }
        const time = document.createElement('div');
        time.className = 'workspace-entry-time';
        if (entry.last_commit_time) time.textContent = entry.last_commit_time;
        row.appendChild(name);
        row.appendChild(commit);
        row.appendChild(time);
        li.appendChild(row);
        if (entry.is_dir) {
            const childUl = document.createElement('ul');
            childUl.className = 'workspace-tree is-collapsed';
            li.appendChild(childUl);
        }
        ul.appendChild(li);
    }
}
// ── Opened-folder state ⇄ URL hash ──────────────────────────────────────────
// Expanding a folder is reflected in the address bar as an anchor (e.g.
// "#docs/sub/") so the in-place view is deep-linkable — no navigating off to a
// separate "/{id}/docs/" listing page. replaceState keeps folder toggling out
// of the back-button history.
function currentHashPath(): string {
    const raw = window.location.hash.replace(/^#/, '');
    if (!raw) return '';
    try { return decodeURIComponent(raw).replace(/\/+$/, ''); }
    catch { return raw.replace(/\/+$/, ''); }
}
function writeHashPath(path: string): void {
    const base = window.location.pathname + window.location.search;
    const suffix = path ? '#' + path.split('/').map(encodeURIComponent).join('/') + '/' : '';
    window.history.replaceState(null, '', base + suffix);
}
function noteExpanded(path: string): void {
    if (path) {
        clearWorkspaceTarget();
        writeHashPath(path);
    }
}
function noteCollapsed(path: string): void {
    const cur = currentHashPath();
    if (path && (cur === path || cur.startsWith(path + '/'))) {
        clearWorkspaceTarget();
        writeHashPath('');
    }
}

// Expand a nested tree folder; resolves with its child <ul> once built so the
// restore walker can descend into it.
function expandTreeDir(li: HTMLElement): Promise<HTMLElement | null> {
    const row = li.querySelector<HTMLElement>(':scope > .workspace-tree-row');
    const childUl = li.querySelector<HTMLElement>(':scope > ul.workspace-tree');
    if (!row || !childUl) return Promise.resolve(null);
    row.setAttribute('aria-expanded', 'true');
    if (childUl.getAttribute('data-built')) {
        childUl.classList.remove('is-collapsed');
        return Promise.resolve(childUl);
    }
    const depth = parseInt(li.dataset['depth'] || '0', 10);
    return fetchDir(li.getAttribute('data-tree-path') || '')
        .then((entries) => {
            if (row.getAttribute('aria-expanded') !== 'true') return null; // collapsed while loading
            if (!childUl.getAttribute('data-built')) {
                renderTree(childUl, entries, depth + 1);
                childUl.setAttribute('data-built', '1');
            }
            childUl.classList.remove('is-collapsed');
            return childUl;
        })
        .catch(() => { row.setAttribute('aria-expanded', 'false'); return null; });
}
function toggleTreeDir(li: HTMLElement): void {
    const row = li.querySelector<HTMLElement>(':scope > .workspace-tree-row');
    const childUl = li.querySelector<HTMLElement>(':scope > ul.workspace-tree');
    if (!row || !childUl) return;
    const treePath = li.getAttribute('data-tree-path') || '';
    if (row.getAttribute('aria-expanded') === 'true') {
        childUl.classList.add('is-collapsed');
        row.setAttribute('aria-expanded', 'false');
        noteCollapsed(treePath);
        return;
    }
    noteExpanded(treePath);
    void expandTreeDir(li);
}
function topChildContainer(li: HTMLElement, dirPath: string): HTMLElement | null {
    const sib = li.nextElementSibling as HTMLElement | null;
    return sib && sib.matches('[data-dir-children]') &&
        sib.getAttribute('data-parent') === dirPath ? sib : null;
}
// Expand a top-level folder; resolves with the child <ul> once built.
function expandTopDir(button: HTMLElement): Promise<HTMLElement | null> {
    const li = button.closest<HTMLElement>('[data-entry-kind]');
    if (!li) return Promise.resolve(null);
    const dirPath = button.getAttribute('data-dir-path') || '';
    button.setAttribute('aria-expanded', 'true');
    const existing = topChildContainer(li, dirPath);
    if (existing) {
        existing.classList.remove('is-collapsed');
        return Promise.resolve(existing.querySelector<HTMLElement>(':scope > ul.workspace-tree'));
    }
    return fetchDir(dirPath)
        .then((entries) => {
            // A rapid collapse before the fetch resolved must win.
            if (button.getAttribute('aria-expanded') !== 'true') return null;
            const fresh = topChildContainer(li, dirPath);
            if (fresh) {
                fresh.classList.remove('is-collapsed');
                return fresh.querySelector<HTMLElement>(':scope > ul.workspace-tree');
            }
            const box = document.createElement('li');
            box.className = 'workspace-entry-children';
            box.setAttribute('data-dir-children', '');
            box.setAttribute('data-parent', dirPath);
            box.setAttribute(
                'data-filter-visible-markdown',
                li.getAttribute('data-filter-visible-markdown') || 'false',
            );
            const ul = document.createElement('ul');
            ul.className = 'workspace-tree';
            renderTree(ul, entries, 0);
            box.appendChild(ul);
            if (li.parentNode) li.parentNode.insertBefore(box, li.nextSibling);
            return ul;
        })
        .catch(() => { button.setAttribute('aria-expanded', 'false'); return null; });
}
function toggleTopDir(button: HTMLElement): void {
    const li = button.closest<HTMLElement>('[data-entry-kind]');
    if (!li) return;
    const dirPath = button.getAttribute('data-dir-path') || '';
    if (button.getAttribute('aria-expanded') === 'true') {
        const container = topChildContainer(li, dirPath);
        if (container) container.classList.add('is-collapsed');
        button.setAttribute('aria-expanded', 'false');
        noteCollapsed(dirPath);
        return;
    }
    noteExpanded(dirPath);
    void expandTopDir(button);
}
document.querySelectorAll<HTMLElement>('[data-dir-toggle]').forEach((button) => {
    button.addEventListener('click', (event) => {
        event.preventDefault();
        toggleTopDir(button);
    });
});
// Sub-folder rows inside the tree are wired via delegation (they are built lazily).
document.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    const row = target && target.closest ? target.closest('.workspace-tree-row[role="button"]') : null;
    if (!row) return;
    const li = row.closest<HTMLElement>('[data-tree-dir]');
    if (li) toggleTreeDir(li);
});
document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target as Element | null;
    if (!target?.classList?.contains('workspace-tree-row')) return;
    if (target.getAttribute('role') !== 'button') return;
    const li = target.closest<HTMLElement>('[data-tree-dir]');
    if (li) { event.preventDefault(); toggleTreeDir(li); }
});

// Restore the opened-folder chain encoded in the URL hash (e.g. "#docs/sub/"),
// expanding each level in place and scrolling the deepest folder into view.
// Runs on load and whenever the hash is navigated (link/back/forward).
let restoreToken = 0;
function clearWorkspaceTarget(): void {
    document.querySelectorAll('.is-workspace-target').forEach((el) => {
        el.classList.remove('is-workspace-target');
    });
}
function markWorkspaceTarget(row: HTMLElement | null): boolean {
    if (!row) return false;
    if (row.getAttribute('data-filter-visible-markdown') === 'false') setFileFilter('all');
    clearWorkspaceTarget();
    row.classList.add('is-workspace-target');
    row.scrollIntoView({ block: 'center' });
    return true;
}
function findDirectEntry(ul: HTMLElement | null, path: string): HTMLElement | null {
    if (!ul) return null;
    return Array.from(ul.querySelectorAll<HTMLElement>(':scope > li[data-entry-path]'))
        .find((el) => el.getAttribute('data-entry-path') === path) || null;
}
function findTopEntry(path: string): HTMLElement | null {
    return Array.from(document.querySelectorAll<HTMLElement>('.workspace-repo-file-list > li[data-entry-path]'))
        .find((el) => el.getAttribute('data-entry-path') === path) || null;
}
function restoreOpenFromHash(): void {
    const path = currentHashPath();
    if (!path) { clearWorkspaceTarget(); return; }
    const segments = path.split('/').filter(Boolean);
    if (!segments.length) return;
    const token = ++restoreToken; // a newer hash change supersedes an in-flight walk
    if (markWorkspaceTarget(findTopEntry(path))) return;
    const topBtn = Array.from(document.querySelectorAll<HTMLElement>('[data-dir-toggle]'))
        .find((b) => b.getAttribute('data-dir-path') === segments[0]);
    if (!topBtn) return;
    const bringIntoView = (ul: HTMLElement | null): void => {
        const row = ul ? (ul.closest('[data-dir-children]') || ul)
            .previousElementSibling as HTMLElement | null : null;
        (row || ul)?.scrollIntoView({ block: 'nearest' });
    };
    const descend = (ul: HTMLElement | null, idx: number): void => {
        if (token !== restoreToken || !ul) return;
        if (idx >= segments.length) { bringIntoView(ul); return; }
        const acc = segments.slice(0, idx + 1).join('/');
        const childLi = Array.from(ul.querySelectorAll<HTMLElement>(':scope > li[data-tree-dir]'))
            .find((el) => el.getAttribute('data-tree-path') === acc) || null;
        if (!childLi) {
            if (!markWorkspaceTarget(findDirectEntry(ul, path))) bringIntoView(ul);
            return;
        }
        void expandTreeDir(childLi).then((next) => descend(next, idx + 1));
    };
    void expandTopDir(topBtn).then((ul) => descend(ul, 1));
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', restoreOpenFromHash, { once: true });
} else {
    restoreOpenFromHash();
}
window.addEventListener('hashchange', restoreOpenFromHash);

// ── Resizable file-table columns (name | commit | time) ─────────────────────
// The three-column grid width comes from `--ws-col-name` / `--ws-col-commit`
// CSS variables on the list wrapper; top-level rows and every (deep) tree row
// inherit them, so one drag resizes them all in sync. Widths persist per
// workspace in localStorage. Handles are hidden below the single-column
// breakpoint (see the 720px media query).
(function setupColumnResize(): void {
    const wrap = document.querySelector<HTMLElement>('[data-col-resize]');
    if (!wrap) return;
    const handles = Array.from(wrap.querySelectorAll<HTMLElement>('[data-col-handle]'));
    if (handles.length < 2) return;
    const [nameHandle, commitHandle] = handles;
    if (!nameHandle || !commitHandle) return;
    const resizeWrap: HTMLElement = wrap;
    const nameResizeHandle: HTMLElement = nameHandle;
    const commitResizeHandle: HTMLElement = commitHandle;
    const GAP = 18;      // column-gap in px
    const MIN = 72;      // min width for name / commit columns
    const TIME_MIN = 64; // reserve at least this much for the time column
    const wsId = resizeWrap.getAttribute('data-ws-id') || '';
    const storeKey = 'markon:ws-cols:' + wsId;
    const isNarrow = (): boolean => window.matchMedia('(max-width: 720px)').matches;

    let nameW = 320;
    let commitW = 420;
    try {
        const raw = window.localStorage.getItem(storeKey);
        if (raw) {
            const parsed = JSON.parse(raw) as { name?: unknown; commit?: unknown };
            if (typeof parsed.name === 'number' && parsed.name > 0) nameW = parsed.name;
            if (typeof parsed.commit === 'number' && parsed.commit > 0) commitW = parsed.commit;
        }
    } catch { /* ignore */ }

    function clampWidths(): void {
        const total = resizeWrap.clientWidth || 0;
        if (total <= 0) return;
        const maxName = Math.max(MIN, total - 2 * GAP - commitW - TIME_MIN);
        nameW = Math.max(MIN, Math.min(nameW, maxName));
        const maxCommit = Math.max(MIN, total - 2 * GAP - nameW - TIME_MIN);
        commitW = Math.max(MIN, Math.min(commitW, maxCommit));
    }
    function applyVars(): void {
        resizeWrap.style.setProperty('--ws-col-name', `${nameW}px`);
        resizeWrap.style.setProperty('--ws-col-commit', `${commitW}px`);
    }
    function positionHandles(): void {
        nameResizeHandle.style.left = `${nameW + GAP / 2}px`;
        commitResizeHandle.style.left = `${nameW + GAP + commitW + GAP / 2}px`;
    }
    function save(): void {
        try {
            window.localStorage.setItem(storeKey, JSON.stringify({ name: nameW, commit: commitW }));
        } catch { /* ignore */ }
    }
    function refresh(): void {
        clampWidths();
        applyVars();
        positionHandles();
    }

    // Columns are auto-sized now (the name/tree flexes, the commit subject fits
    // its own content, the time is content-width), so drag-to-resize no longer
    // applies — keep every handle hidden and skip the drag wiring.
    handles.forEach((handle) => { handle.hidden = true; });
    if (handles.length) return;
    handles.forEach((handle, idx) => {
        handle.hidden = false;
        handle.addEventListener('pointerdown', (event: PointerEvent) => {
            if (isNarrow()) return;
            event.preventDefault();
            const startX = event.clientX;
            const startName = nameW;
            const startCommit = commitW;
            const total = resizeWrap.clientWidth || 0;
            handle.classList.add('is-dragging');
            try { handle.setPointerCapture(event.pointerId); } catch { /* ignore */ }
            const onMove = (e: PointerEvent): void => {
                const delta = e.clientX - startX;
                if (idx === 0) {
                    const maxName = Math.max(MIN, total - 2 * GAP - commitW - TIME_MIN);
                    nameW = Math.max(MIN, Math.min(startName + delta, maxName));
                } else {
                    const maxCommit = Math.max(MIN, total - 2 * GAP - nameW - TIME_MIN);
                    commitW = Math.max(MIN, Math.min(startCommit + delta, maxCommit));
                }
                applyVars();
                positionHandles();
            };
            const onUp = (e: PointerEvent): void => {
                handle.classList.remove('is-dragging');
                try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
                handle.removeEventListener('pointermove', onMove);
                handle.removeEventListener('pointerup', onUp);
                handle.removeEventListener('pointercancel', onUp);
                save();
            };
            handle.addEventListener('pointermove', onMove);
            handle.addEventListener('pointerup', onUp);
            handle.addEventListener('pointercancel', onUp);
        });
    });

    // Defer the first measure/clamp until layout is settled — running during
    // script parse reads a not-yet-final `clientWidth` and would wrongly clamp
    // the columns to a tiny width. Apply the stored/default vars immediately so
    // there's no flash, then re-measure once the page has laid out.
    applyVars();
    positionHandles();
    const initialRefresh = (): void => refresh();
    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', () => requestAnimationFrame(initialRefresh), { once: true });
    } else {
        requestAnimationFrame(initialRefresh);
    }
    window.addEventListener('load', initialRefresh, { once: true });
    window.addEventListener('resize', refresh);
})();

// ── Add-file modal ──────────────────────────────────────────────────────────
document.querySelectorAll<HTMLElement>('[data-open-add-file]').forEach((button) => {
    button.addEventListener('click', (event) => {
        event.preventDefault();
        openWorkspaceModal(document.querySelector('[data-add-file-modal]'));
    });
});
const addForm = document.querySelector<HTMLFormElement>('[data-add-file-form]');
if (addForm) {
    addForm.addEventListener('submit', (event) => {
        event.preventDefault();
        const modal = document.querySelector('[data-add-file-modal]');
        const pathInput = addForm.querySelector<HTMLInputElement>('[data-add-file-path]');
        const contentInput = addForm.querySelector<HTMLTextAreaElement>('[data-add-file-content]');
        const status = addForm.querySelector<HTMLElement>('[data-add-file-status]');
        let rel = ((pathInput && pathInput.value) || '').trim();
        const last = rel.split('/').pop();
        if (rel && last && !last.includes('.')) rel += '.md';
        if (!rel) {
            if (status) status.textContent = t('web.ws.create_file.path_required');
            return;
        }
        if (status) status.textContent = t('web.ws.create_file.creating');
        fetch((modal && modal.getAttribute('data-create-file-url')) || '', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: rel, content: contentInput ? contentInput.value : '' }),
        })
            .then((resp) => {
                requireActiveAdminSession(resp);
                return resp.text().then((text) => {
                    let data: { success?: boolean; message?: string; url?: string } = {};
                    try { data = text ? JSON.parse(text) as { success?: boolean; message?: string; url?: string } : {}; } catch { /* ignore */ }
                    if (!resp.ok || data.success === false) throw new Error(data.message || text || resp.statusText);
                    window.location.href = data.url || window.location.href;
                });
            })
            .catch((err: unknown) => {
                if (isAdminSessionExpiredError(err)) {
                    if (status) status.textContent = '';
                    return;
                }
                if (status) status.textContent = errorMessage(err);
            });
    });
}

// ── Add-folder modal ────────────────────────────────────────────────────────
document.querySelectorAll<HTMLElement>('[data-open-add-folder]').forEach((button) => {
    button.addEventListener('click', (event) => {
        event.preventDefault();
        openWorkspaceModal(document.querySelector('[data-add-folder-modal]'));
    });
});
const addFolderForm = document.querySelector<HTMLFormElement>('[data-add-folder-form]');
if (addFolderForm) {
    addFolderForm.addEventListener('submit', (event) => {
        event.preventDefault();
        const modal = document.querySelector('[data-add-folder-modal]');
        const pathInput = addFolderForm.querySelector<HTMLInputElement>('[data-add-folder-path]');
        const status = addFolderForm.querySelector<HTMLElement>('[data-add-folder-status]');
        const rel = ((pathInput && pathInput.value) || '').trim();
        if (!rel) {
            if (status) status.textContent = t('web.ws.create_folder.path_required');
            return;
        }
        if (status) status.textContent = t('web.ws.create_folder.creating');
        fetch((modal && modal.getAttribute('data-create-folder-url')) || '', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: rel }),
        })
            .then((resp) => {
                requireActiveAdminSession(resp);
                return resp.text().then((text) => {
                    let data: { success?: boolean; message?: string; url?: string } = {};
                    try { data = text ? JSON.parse(text) as { success?: boolean; message?: string; url?: string } : {}; } catch { /* ignore */ }
                    if (!resp.ok || data.success === false) throw new Error(data.message || text || resp.statusText);
                    window.location.href = data.url || window.location.href;
                });
            })
            .catch((err: unknown) => {
                if (isAdminSessionExpiredError(err)) {
                    if (status) status.textContent = '';
                    return;
                }
                if (status) status.textContent = errorMessage(err);
            });
    });
}

// ── Keyboard: Esc closes workspace modals ───────────────────────────────────
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeWorkspaceModals();
});

// ── Remaining placeholders / title ──────────────────────────────────────────
const addPath = document.querySelector<HTMLInputElement>('[data-add-file-path]');
if (addPath) addPath.placeholder = t('web.ws.create_file.placeholder');
const addFolderPath = document.querySelector<HTMLInputElement>('[data-add-folder-path]');
if (addFolderPath) addFolderPath.placeholder = t('web.ws.create_folder.placeholder');
document.title = t((heading?.dataset['titleKey']) || 'web.title.dir');

export {};
