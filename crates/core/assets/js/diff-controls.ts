/**
 * Compare/diff page controls: the file-list filter (+ a GitHub-style "Viewed
 * files" toggle) and the Raw⇄Rendered view switcher (segment toggle, file
 * selection, history/hash sync, stored view preference).
 *
 * Built as a CLASSIC (IIFE) bundle and loaded as a non-module `<script>` at the
 * same point in `git-diff.html` where these used to live inline — so it still
 * runs DURING parse, before the deferred diff-view ES modules
 * (workspace-diff / markdown-diff) initialise. The view APIs it calls
 * (`window.markonMarkdownDiff` / `markonSourceDiff`) may not exist yet at that
 * point; every call is guarded, exactly as the original inline code was.
 */

import {
    loadViewedSet,
    loadShowViewed,
    persistShowViewed,
    VIEWED_CHANGED_EVENT,
    SHOW_VIEWED_EVENT,
} from './diff-file-header';

type View = 'rendered' | 'raw';
type CleanupMenu = HTMLElement & { __cleanup?: (() => void) | null };

// ── File-list filter + "Viewed files" toggle ────────────────────────────────
function initFilter(): void {
    const filter = document.querySelector<HTMLInputElement>('[data-diff-filter]');
    const entries = Array.from(document.querySelectorAll<HTMLElement>('[data-diff-nav-entry]'));
    const filterBtn = document.querySelector<HTMLElement>('[data-diff-filter-toggle]');
    const filterMenu = document.querySelector<CleanupMenu>('[data-diff-filter-menu]');
    const showViewedInput = document.querySelector<HTMLInputElement>('[data-diff-show-viewed]');
    // Same data URL the content views key their Viewed set on (shell attr).
    const dataUrl = document.querySelector('[data-diff-shell]')?.getAttribute('data-diff-data-url') || '';

    let viewedSet = loadViewedSet(dataUrl);
    let showViewed = loadShowViewed(dataUrl);

    // Collapsed folder paths (session-only, like GitHub's tree). A descendant is
    // hidden when any ancestor folder is collapsed.
    const collapsed = new Set<string>();
    const underCollapsed = (path: string): boolean => {
        for (const c of collapsed) {
            if (path !== c && path.indexOf(c + '/') === 0) return true;
        }
        return false;
    };

    const fileVisible = (path: string, query: string): boolean => {
        if (!showViewed && viewedSet.has(path)) return false;
        if (query && path.toLowerCase().indexOf(query) === -1) return false;
        return true;
    };
    const applyFilter = (): void => {
        const query = ((filter && filter.value) || '').trim().toLowerCase();
        const filtering = !!query || !showViewed;
        const visibleFiles = entries.filter(
            (entry) =>
                entry.getAttribute('data-diff-kind') === 'file' &&
                fileVisible(entry.getAttribute('data-diff-path') || '', query),
        );
        entries.forEach((entry) => {
            const kind = entry.getAttribute('data-diff-kind');
            const path = entry.getAttribute('data-diff-path') || '';
            let visible: boolean;
            if (kind === 'file') {
                visible = fileVisible(path, query);
            } else {
                visible =
                    !filtering ||
                    visibleFiles.some((file) => (file.getAttribute('data-diff-path') || '').indexOf(path + '/') === 0);
            }
            // A text query reveals matches regardless of collapse (GitHub does the
            // same); otherwise honour collapsed ancestors.
            if (visible && !query && underCollapsed(path)) visible = false;
            entry.style.display = visible ? '' : 'none';
        });
        if (filterBtn) filterBtn.classList.toggle('is-active', !showViewed);
    };
    if (filter) filter.addEventListener('input', applyFilter);

    // Folder rows toggle their subtree open/closed (click or Enter/Space). The
    // inline "+" create button stops propagation, so it never triggers a toggle.
    const list = document.querySelector<HTMLElement>('[data-diff-file-list]');
    const toggleDir = (dir: HTMLElement): void => {
        const li = dir.closest<HTMLElement>('[data-diff-nav-entry]');
        const path = li?.getAttribute('data-diff-path') || '';
        if (!path) return; // root affordance row has no subtree to fold
        if (collapsed.has(path)) collapsed.delete(path);
        else collapsed.add(path);
        dir.setAttribute('aria-expanded', collapsed.has(path) ? 'false' : 'true');
        applyFilter();
    };
    if (list) {
        list.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;
            if (target.closest('.git-nav-add')) return;
            const dir = target.closest<HTMLElement>('[data-diff-dir-toggle]');
            if (dir) toggleDir(dir);
        });
        list.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const dir = (e.target as HTMLElement).closest<HTMLElement>('[data-diff-dir-toggle]');
            if (dir) {
                e.preventDefault();
                toggleDir(dir);
            }
        });
    }

    // "Viewed files" toggle: hide/show viewed files in the sidebar, and broadcast
    // so the content view hides/shows their sections too.
    if (showViewedInput) {
        showViewedInput.checked = showViewed;
        showViewedInput.addEventListener('change', () => {
            showViewed = showViewedInput.checked;
            persistShowViewed(dataUrl, showViewed);
            applyFilter();
            document.dispatchEvent(new CustomEvent(SHOW_VIEWED_EVENT, { detail: { showViewed } }));
        });
    }
    // Content view toggled a file's Viewed state → re-evaluate the sidebar.
    document.addEventListener(VIEWED_CHANGED_EVENT, (e) => {
        const detail = (e as CustomEvent).detail;
        viewedSet = detail && Array.isArray(detail.viewed) ? new Set<string>(detail.viewed) : loadViewedSet(dataUrl);
        applyFilter();
    });

    const setMenuOpen = (open: boolean): void => {
        if (!filterMenu || !filterBtn) return;
        filterMenu.hidden = !open;
        filterBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) {
            const onDoc = (e: MouseEvent): void => {
                if (!filterMenu.contains(e.target as Node) && e.target !== filterBtn) setMenuOpen(false);
            };
            const onKey = (e: KeyboardEvent): void => {
                if (e.key === 'Escape') setMenuOpen(false);
            };
            filterMenu.__cleanup = (): void => {
                document.removeEventListener('mousedown', onDoc, true);
                document.removeEventListener('keydown', onKey, true);
            };
            document.addEventListener('mousedown', onDoc, true);
            document.addEventListener('keydown', onKey, true);
        } else if (filterMenu.__cleanup) {
            filterMenu.__cleanup();
            filterMenu.__cleanup = null;
        }
    };
    if (filterBtn) filterBtn.addEventListener('click', () => setMenuOpen(!!filterMenu && !!filterMenu.hidden));
    applyFilter();
}

// ── Raw⇄Rendered view switcher + file selection + compare form ──────────────
function initViewSwitcher(): void {
    const shell = document.querySelector<HTMLElement>('[data-diff-shell]');
    if (!shell) return;
    const viewInput = document.querySelector<HTMLInputElement>('[data-diff-view-input]');
    const segButtons = Array.from(document.querySelectorAll<HTMLElement>('[data-diff-view-seg] [data-view]'));
    const compareForm = document.querySelector<HTMLFormElement>('[data-compare-form]');
    // Raw/Rendered is remembered PER WORKSPACE: the key carries the workspace id
    // so each workspace keeps its own preference (a doc-heavy repo can default to
    // Rendered while a code repo stays on Raw). Falls back to a shared key when
    // the id is somehow absent.
    const wsId = document.querySelector('meta[name="workspace-id"]')?.getAttribute('content') || '';
    const VIEW_PREF_KEY = wsId ? `markon:diff:view:${wsId}` : 'markon:diff:view';

    const storedViewPref = (): View | null => {
        try {
            const v = window.localStorage.getItem(VIEW_PREF_KEY);
            return v === 'raw' || v === 'rendered' ? v : null;
        } catch { return null; }
    };
    const persistViewPref = (view: View): void => {
        try { window.localStorage.setItem(VIEW_PREF_KEY, view); } catch { /* ignore */ }
    };
    const normalizeView = (value: string | null): View => (value === 'rendered' ? 'rendered' : 'raw');
    const currentRelativeUrl = (): string =>
        window.location.pathname + window.location.search + window.location.hash;
    const viewFromLocation = (): View => {
        try {
            return normalizeView(new URL(window.location.href).searchParams.get('view'));
        } catch { return 'raw'; }
    };
    const selectedPathFromLocation = (): string => {
        try {
            const h = window.location.hash || '';
            return h ? decodeURIComponent(h.slice(1)) : '';
        } catch { return ''; }
    };
    const defaultSelectedPath = (): string => shell.getAttribute('data-default-diff-path') || '';
    const effectivePathForView = (view: string): string => {
        const path = selectedPathFromLocation();
        return path || (normalizeView(view) === 'rendered' ? defaultSelectedPath() : '');
    };
    const encodeQueryPath = (value: string): string =>
        encodeURIComponent(String(value || '')).replace(/%2F/gi, '/');
    const urlWithViewAndFile = (baseUrl: string | null, view: string, path: string): string => {
        try {
            const url = new URL(baseUrl || window.location.href, window.location.origin);
            url.searchParams.set('view', normalizeView(view));
            url.searchParams.delete('f');
            // The selected file rides in the hash anchor, not a query param.
            url.hash = path ? encodeQueryPath(path) : '';
            return url.pathname + url.search + url.hash;
        } catch {
            return baseUrl || currentRelativeUrl();
        }
    };
    const urlForView = (view: View): string => {
        const base = view === 'rendered' ? shell.getAttribute('data-markdown-url') : shell.getAttribute('data-source-url');
        return urlWithViewAndFile(base, view, effectivePathForView(view));
    };
    const setActiveFile = (path: string): void => {
        document.querySelectorAll<HTMLElement>('[data-diff-scroll-path]').forEach((button) => {
            const active = Boolean(path) && button.getAttribute('data-diff-scroll-path') === path;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
    };
    const applySelectedPath = (path: string): void => {
        path = path || '';
        if (!path && normalizeView(shell.getAttribute('data-current-diff-view')) === 'rendered') {
            path = defaultSelectedPath();
        }
        setActiveFile(path);
        if (normalizeView(shell.getAttribute('data-current-diff-view')) === 'rendered') {
            window.markonMarkdownDiff?.selectPath?.(path || null);
        } else {
            window.markonSourceDiff?.selectPath?.(path || null);
        }
    };
    const pushSelectedPath = (path: string): void => {
        const view = normalizeView(shell.getAttribute('data-current-diff-view'));
        if (!path && view === 'rendered') path = defaultSelectedPath();
        const nextUrl = urlWithViewAndFile(window.location.href, view, path || '');
        if (nextUrl !== currentRelativeUrl()) {
            history.pushState({ markonDiffView: view, markonDiffPath: path || null }, '', nextUrl);
        }
    };
    const selectPath = (path: string, updateHistory: boolean): void => {
        path = path || '';
        if (updateHistory && path && selectedPathFromLocation() === path) path = '';
        if (updateHistory) pushSelectedPath(path);
        applySelectedPath(path);
    };
    const diffApi = (view: View): typeof window.markonMarkdownDiff =>
        view === 'rendered' ? window.markonMarkdownDiff : window.markonSourceDiff;
    const activate = (view: View, updateHistory: boolean): void => {
        view = normalizeView(view);
        // Carry the current file + line over so switching modes keeps the same
        // content in view instead of jumping back to the top.
        const prevView = normalizeView(shell.getAttribute('data-current-diff-view'));
        let anchor = null;
        if (prevView !== view) {
            const prevApi = diffApi(prevView);
            if (prevApi && prevApi.topAnchor) { try { anchor = prevApi.topAnchor(); } catch { /* ignore */ } }
        }
        shell.setAttribute('data-current-diff-view', view);
        document.querySelectorAll<HTMLElement>('[data-diff-view-panel]').forEach((panel) => {
            const active = panel.getAttribute('data-diff-view-panel') === view;
            panel.hidden = !active;
        });
        segButtons.forEach((button) => {
            button.setAttribute('aria-pressed', button.getAttribute('data-view') === view ? 'true' : 'false');
        });
        if (viewInput) {
            viewInput.value = view;
            viewInput.disabled = false;
        }
        const url = urlForView(view);
        if (updateHistory && url && url !== currentRelativeUrl()) {
            history.pushState({ markonDiffView: view }, '', url);
        } else if (!updateHistory && view === 'rendered' && !selectedPathFromLocation() && defaultSelectedPath()) {
            history.replaceState({ markonDiffView: view, markonDiffPath: defaultSelectedPath() }, '', url);
        }
        // Apply file selection FIRST (it may re-render), then load with the
        // carried-over anchor LAST so the final render lands on the right spot.
        applySelectedPath(effectivePathForView(view));
        const api = diffApi(view);
        if (api) {
            if (anchor && api.anchorTo) api.anchorTo(anchor);
            if (api.load) api.load();
        }
        document.dispatchEvent(new CustomEvent('markon:diff-view-change', { detail: { view } }));
    };

    document.querySelectorAll<HTMLElement>('[data-diff-scroll-path]').forEach((button) => {
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopImmediatePropagation();
            selectPath(button.getAttribute('data-diff-scroll-path') || '', true);
        });
    });
    segButtons.forEach((button) => {
        button.addEventListener('click', () => {
            const view = normalizeView(button.getAttribute('data-view'));
            persistViewPref(view);
            activate(view, true);
        });
    });

    const encodeRefForPath = (value: string): string =>
        String(value || '').split('/').map(encodeURIComponent).join('/');
    const navigateCompare = (): void => {
        if (!compareForm) return;
        const data = new FormData(compareForm);
        const base = String(data.get('base') || '');
        const compare = String(data.get('compare') || '');
        const pathBase = compareForm.getAttribute('data-compare-path-base') || '';
        if (!base || !compare || !pathBase) return;
        const view = normalizeView(shell.getAttribute('data-current-diff-view'));
        const url = urlWithViewAndFile(
            pathBase + '/' + encodeRefForPath(base) + '...' + encodeRefForPath(compare),
            view,
            selectedPathFromLocation(),
        );
        if (url !== currentRelativeUrl()) {
            window.location.href = url;
        }
    };
    const applyCompareOptionStatus = (
        selectName: string,
        statuses: Array<{ value?: unknown; disabled?: unknown }>,
    ): void => {
        if (!compareForm || !Array.isArray(statuses)) return;
        const select = compareForm.querySelector<HTMLSelectElement>('select[name="' + selectName + '"]');
        if (!select) return;
        const selected = select.value;
        const byValue = new Map<string, boolean>();
        statuses.forEach((status) => {
            if (status && typeof status.value === 'string') byValue.set(status.value, Boolean(status.disabled));
        });
        Array.prototype.forEach.call(select.options, (option: HTMLOptionElement) => {
            if (option.value === selected) {
                option.disabled = false;
                return;
            }
            if (byValue.has(option.value)) option.disabled = byValue.get(option.value)!;
        });
    };
    const hydrateCompareOptionStatus = (): void => {
        if (!compareForm || !window.fetch) return;
        const statusUrl = compareForm.getAttribute('data-compare-options-status-url');
        if (!statusUrl) return;
        const data = new FormData(compareForm);
        const base = String(data.get('base') || '');
        const compare = String(data.get('compare') || '');
        if (!base || !compare) return;
        const url = statusUrl + '?base=' + encodeURIComponent(base) + '&compare=' + encodeURIComponent(compare);
        fetch(url, { headers: { Accept: 'application/json' } })
            .then((response) => (response.ok ? response.json() : null))
            .then((status) => {
                if (!status) return;
                applyCompareOptionStatus('base', status.base);
                applyCompareOptionStatus('compare', status.compare);
            })
            .catch(() => { /* ignore */ });
    };
    if (compareForm) {
        compareForm.addEventListener('submit', (event) => {
            event.preventDefault();
            navigateCompare();
        });
        compareForm.querySelectorAll<HTMLSelectElement>('select').forEach((select) => {
            select.addEventListener('change', navigateCompare);
        });
        hydrateCompareOptionStatus();
    }

    window.addEventListener('popstate', () => {
        activate(viewFromLocation(), false);
    });
    // Direct hash navigation (manual edit, or a #file link): scroll to that file.
    window.addEventListener('hashchange', () => {
        applySelectedPath(selectedPathFromLocation());
    });

    // The Raw/Rendered choice is a global preference: apply the stored value on
    // every diff page (not just the current document). If it differs from the
    // URL's view, rewrite the URL so reloads/bookmarks stay consistent.
    const pageView = normalizeView(shell.getAttribute('data-current-diff-view') || viewFromLocation());
    const pref = storedViewPref();
    const initial = pref || pageView;
    if (pref && pref !== viewFromLocation()) {
        const url = urlForView(initial);
        if (url && url !== currentRelativeUrl()) history.replaceState({ markonDiffView: initial }, '', url);
    }
    activate(initial, false);
}

initFilter();
initViewSwitcher();

export {};
