// Shared GitHub-PR-style file header used by BOTH the rendered (AST) diff and
// the raw diff views, so the two stay visually and behaviourally identical:
// chevron · path · copy-path  |  +adds -dels + diffstat bars · Viewed · ⋯ menu.

import { workspaceFileDeleteUrl, workspaceFileUrl } from './core/routes';

export interface DiffFileHeaderOpts {
    path: string;
    oldPath?: string | null;
    status: string;
    additions: number;
    deletions: number;
    /** Whether the file body is folded. Driven by the chevron ONLY — folding is
     *  a pure reading affordance and never touches the "Viewed" mark. */
    collapsed: boolean;
    /** Whether the file is marked "Viewed" (the checkbox). Independent of the
     *  fold state: a viewed file can be expanded for re-reading and stays viewed. */
    viewed: boolean;
    /** Toggle the fold (chevron). The caller owns the actual collapse. */
    onToggleCollapse: () => void;
    /** Toggle the "Viewed" mark (checkbox). The caller owns the side effects. */
    onToggleViewed: () => void;
    /** Called after the file is successfully deleted on disk. */
    onDeleted?: () => void;
}

type MenuEl = HTMLElement & { __cleanup?: (() => void) | undefined };

/** The file currently at the top of a diff scroll container (the one whose
 *  sticky header is stuck), used to keep the same file in view when switching
 *  between the raw and rendered modes. Both views use `.md-diff-file-section`. */
export const topFileInScroller = (scrollEl: HTMLElement | null): string | null => {
    if (!scrollEl) return null;
    const viewportTop = scrollEl.getBoundingClientRect().top;
    const sections = scrollEl.querySelectorAll<HTMLElement>('.md-diff-file-section[data-file-path]');
    let candidate: string | null = null;
    for (const section of sections) {
        if (section.getBoundingClientRect().top <= viewportTop + 4) {
            candidate = section.dataset['filePath'] || candidate;
        } else {
            break;
        }
    }
    const firstSection = sections[0];
    if (!candidate && firstSection) candidate = firstSection.dataset['filePath'] || null;
    return candidate;
};

const stickyOffset = (sectionEl: HTMLElement): number => {
    const header = sectionEl.querySelector<HTMLElement>('.md-diff-file-header');
    return header ? header.offsetHeight : 48;
};

const lineSpan = (el: HTMLElement): { start: number; end: number } | null => {
    const start = parseInt(el.dataset['line'] || '', 10);
    if (Number.isNaN(start)) return null;
    const end = parseInt(el.dataset['lineEnd'] || '', 10);
    return { start, end: Number.isNaN(end) ? start : Math.max(start, end) };
};

/** The (possibly fractional) source line at the top of the viewport. The AST
 *  rendering is block-level, so a tall block is interpolated by how far the
 *  viewport top is through it — giving a precise line that the line-level raw
 *  view (and vice-versa) can land on. */
export const lineAtTop = (scrollEl: HTMLElement, sectionEl: HTMLElement): number | null => {
    const threshold = scrollEl.getBoundingClientRect().top + stickyOffset(sectionEl) + 1;
    let result: number | null = null;
    sectionEl.querySelectorAll<HTMLElement>('[data-line]').forEach((el) => {
        if (result !== null) return;
        const rect = el.getBoundingClientRect();
        if (rect.bottom <= threshold) return;
        const span = lineSpan(el);
        if (!span) return;
        const frac = rect.height > 0 ? Math.min(1, Math.max(0, (threshold - rect.top) / rect.height)) : 0;
        result = span.start + frac * (span.end - span.start);
    });
    return result;
};

/** Scroll so `line` sits just below the sticky header. Within a tall block the
 *  fractional part picks the right offset inside it. Callers must have rendered
 *  every section above `sectionEl` so the measured offsets are real. */
export const scrollSectionToLine = (
    scrollEl: HTMLElement,
    sectionEl: HTMLElement,
    line: number | null,
): void => {
    let refTop: number | null = null;
    if (line !== null) {
        const elements = sectionEl.querySelectorAll<HTMLElement>('[data-line]');
        for (const el of elements) {
            const span = lineSpan(el);
            if (!span) continue;
            if (span.start > line) break;
            const rect = el.getBoundingClientRect();
            if (line <= span.end) {
                // Inside this block — interpolate by line position.
                const frac = span.end > span.start ? (line - span.start) / (span.end - span.start) : 0;
                refTop = rect.top + frac * rect.height;
            } else {
                // Block ends before `line` — anchor to its bottom for now; a later
                // block may refine it.
                refTop = rect.bottom;
            }
        }
    }
    const base = refTop ?? sectionEl.getBoundingClientRect().top;
    const delta = base - scrollEl.getBoundingClientRect().top - stickyOffset(sectionEl);
    scrollEl.scrollTop = Math.max(0, scrollEl.scrollTop + delta);
};

/** localStorage key for a diff's collapsed/"viewed" file set, keyed on the
 *  compare path only (no query) so the raw and rendered views share state. */
export const collapseStorageKey = (dataUrl?: string | null): string | null => {
    if (!dataUrl) return null;
    try {
        const url = new URL(dataUrl, window.location.origin);
        return `markon:diff:collapsed:${url.pathname}`;
    } catch {
        return `markon:diff:collapsed:${dataUrl}`;
    }
};

export const loadCollapsedSet = (dataUrl?: string | null): Set<string> => {
    const key = collapseStorageKey(dataUrl);
    if (!key) return new Set();
    try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return new Set();
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed)
            ? new Set(parsed.filter((x): x is string => typeof x === 'string'))
            : new Set();
    } catch {
        return new Set();
    }
};

export const persistCollapsedSet = (dataUrl: string | null | undefined, set: Set<string>): void => {
    const key = collapseStorageKey(dataUrl);
    if (!key) return;
    try {
        window.localStorage.setItem(key, JSON.stringify([...set]));
    } catch {
        /* ignore quota/availability */
    }
};

/** localStorage key for a diff's "Viewed" file set — separate from the fold
 *  set so marking viewed and folding are independent. */
export const viewedStorageKey = (dataUrl?: string | null): string | null => {
    if (!dataUrl) return null;
    try {
        const url = new URL(dataUrl, window.location.origin);
        return `markon:diff:viewed:${url.pathname}`;
    } catch {
        return `markon:diff:viewed:${dataUrl}`;
    }
};

export const loadViewedSet = (dataUrl?: string | null): Set<string> => {
    const key = viewedStorageKey(dataUrl);
    if (!key) return new Set();
    try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return new Set();
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed)
            ? new Set(parsed.filter((x): x is string => typeof x === 'string'))
            : new Set();
    } catch {
        return new Set();
    }
};

export const persistViewedSet = (dataUrl: string | null | undefined, set: Set<string>): void => {
    const key = viewedStorageKey(dataUrl);
    if (!key) return;
    try {
        window.localStorage.setItem(key, JSON.stringify([...set]));
    } catch {
        /* ignore quota/availability */
    }
};

/** Whether "Viewed" files are shown (GitHub-style filter). Persisted per diff;
 *  defaults to false. When false, viewed files are hidden from the sidebar list
 *  AND their sections are hidden in the content. */
const showViewedStorageKey = (dataUrl?: string | null): string | null => {
    if (!dataUrl) return null;
    try {
        const url = new URL(dataUrl, window.location.origin);
        return `markon:diff:showviewed:${url.pathname}`;
    } catch {
        return `markon:diff:showviewed:${dataUrl}`;
    }
};

export const loadShowViewed = (dataUrl?: string | null): boolean => {
    const key = showViewedStorageKey(dataUrl);
    if (!key) return false;
    try {
        const raw = window.localStorage.getItem(key);
        if (raw === null) return false;
        return raw !== '0';
    } catch {
        return false;
    }
};

export const persistShowViewed = (dataUrl: string | null | undefined, show: boolean): void => {
    const key = showViewedStorageKey(dataUrl);
    if (!key) return;
    try {
        window.localStorage.setItem(key, show ? '1' : '0');
    } catch {
        /* ignore quota/availability */
    }
};

/** Event the content view dispatches when its Viewed set changes, so the sidebar
 *  filter can re-evaluate. detail.viewed = the current viewed file paths. */
export const VIEWED_CHANGED_EVENT = 'markon:diff-viewed-changed';
/** Event the sidebar funnel dispatches when the "show viewed" filter toggles. */
export const SHOW_VIEWED_EVENT = 'markon:diff-showviewed';

const SVG_CHEVRON =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12.78 6.22a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L3.22 7.28a.75.75 0 0 1 1.06-1.06L8 9.94l3.72-3.72a.75.75 0 0 1 1.06 0Z"/></svg>';
const SVG_COPY =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path fill="currentColor" d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>';
const SVG_KEBAB =
    '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM1.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm13 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/></svg>';
// Pure diagonal up-right arrow (octicon arrow-up-right) — "open in new window".
// Slightly smaller than the copy icon's 14px so the diagonal glyph reads as the
// same optical size next to it.
const SVG_OPEN_EXTERNAL =
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M5.22 14.78a.75.75 0 0 1 0-1.06L12.44 6.5H7.75a.75.75 0 0 1 0-1.5h6.5a.75.75 0 0 1 .75.75v6.5a.75.75 0 0 1-1.5 0V7.56l-7.22 7.22a.75.75 0 0 1-1.06 0Z"/></svg>';

const workspaceId = (): string =>
    document.querySelector('meta[name="workspace-id"]')?.getAttribute('content') || '';

const headerDisplay = (path: string, oldPath?: string | null): string =>
    oldPath && oldPath !== path ? `${oldPath} -> ${path}` : path;

const fileUrl = (path: string, edit: boolean, line?: number | null): string => {
    const base = workspaceFileUrl(workspaceId(), path);
    if (!edit) return base;
    // `?edit=1` opens the normal file view's editor (main.ts), optionally jumping
    // to a 1-based line so editing a file from the diff lands where the reviewer
    // was looking instead of at the top.
    const lineQuery = line && line > 0 ? `&line=${line}` : '';
    return `${base}?edit=1${lineQuery}`;
};

const openFile = (path: string, edit: boolean, line?: number | null): void => {
    if (!workspaceId()) return;
    window.open(fileUrl(path, edit, line), '_blank', 'noopener');
};

/** The 1-based source line currently at the top of this file's section in the
 *  diff viewport, so "Edit file" can open the editor at the same spot. Returns
 *  undefined when the file is collapsed / no line can be resolved (→ top). */
const currentEditLine = (menu: HTMLElement): number | undefined => {
    const section = menu.closest<HTMLElement>('.md-diff-file-section');
    if (!section) return undefined;
    // Find the actual scroll container (rendered panel, or the raw view's
    // own scroller) by walking up to the nearest overflow-scrolling ancestor.
    let scrollEl: HTMLElement | null = section.parentElement;
    while (scrollEl && scrollEl.scrollHeight <= scrollEl.clientHeight + 1) {
        scrollEl = scrollEl.parentElement;
    }
    if (!scrollEl) return undefined;
    const line = lineAtTop(scrollEl, section);
    return line != null ? Math.max(1, Math.round(line)) : undefined;
};

const copyPath = async (path: string, button: HTMLElement): Promise<void> => {
    try {
        await navigator.clipboard.writeText(path);
        button.classList.add('is-copied');
        window.setTimeout(() => button.classList.remove('is-copied'), 1100);
    } catch {
        /* clipboard unavailable */
    }
};

const deleteFile = async (path: string, onDeleted?: () => void): Promise<void> => {
    const ws = workspaceId();
    if (!ws) return;
    if (!window.confirm(`Delete ${path}?\nThis removes the file from disk and cannot be undone.`)) {
        return;
    }
    try {
        const response = await fetch(workspaceFileDeleteUrl(ws), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ path }),
        });
        const result: unknown = await response.json().catch(() => null);
        const ok = response.ok && !!result && (result as { success?: boolean }).success === true;
        if (!ok) {
            const msg = (result as { message?: string } | null)?.message || 'Delete failed';
            window.alert(`Could not delete ${path}: ${msg}`);
            return;
        }
        onDeleted?.();
    } catch (error) {
        window.alert(`Could not delete ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
};

const buildDiffstat = (additions: number, deletions: number): HTMLElement => {
    const stat = document.createElement('span');
    stat.className = 'md-diff-stat';
    const add = document.createElement('span');
    add.className = 'md-diff-stat-add';
    add.textContent = `+${additions}`;
    const del = document.createElement('span');
    del.className = 'md-diff-stat-del';
    del.textContent = `-${deletions}`;
    const bars = document.createElement('span');
    bars.className = 'md-diff-stat-bars';
    bars.setAttribute('aria-hidden', 'true');
    // 5 squares filled green/red proportionally (GitHub-style), >=1 if nonzero.
    const total = additions + deletions;
    let green = 0;
    let red = 0;
    if (total > 0) {
        green = additions > 0 ? Math.max(1, Math.round((additions / total) * 5)) : 0;
        red = deletions > 0 ? Math.max(1, Math.round((deletions / total) * 5)) : 0;
        while (green + red > 5) {
            if (green >= red) green -= 1;
            else red -= 1;
        }
    }
    for (let i = 0; i < 5; i += 1) {
        const box = document.createElement('span');
        box.className =
            i < green ? 'md-diff-bar is-add' : i < green + red ? 'md-diff-bar is-del' : 'md-diff-bar';
        bars.appendChild(box);
    }
    stat.append(add, del, bars);
    return stat;
};

/** Lift the menu's own file header above the sibling sticky headers while the
 *  popup is open. Every `.md-diff-file-header` is `position:sticky; z-index:3`,
 *  so each is its own stacking context; without this the *next* file's header
 *  (also z-index:3, later in the DOM) paints over the dropdown. */
const setMenuHeaderRaised = (menu: HTMLElement, raised: boolean): void => {
    const header = menu.closest<HTMLElement>('.md-diff-file-header');
    if (header) header.style.zIndex = raised ? '6' : '';
};

const closeMenu = (menu: HTMLElement, button: HTMLElement): void => {
    const pop = menu.querySelector<HTMLElement>('.md-diff-menu-pop');
    if (pop) pop.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    menu.classList.remove('is-open');
    setMenuHeaderRaised(menu, false);
    (menu as MenuEl).__cleanup?.();
    (menu as MenuEl).__cleanup = undefined;
};

const buildMenu = (opts: DiffFileHeaderOpts): HTMLElement => {
    const menu = document.createElement('div');
    menu.className = 'md-diff-menu';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'md-diff-menu-btn';
    button.setAttribute('aria-label', 'File actions');
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML = SVG_KEBAB;

    const pop = document.createElement('div');
    pop.className = 'md-diff-menu-pop';
    pop.setAttribute('role', 'menu');
    pop.hidden = true;

    // "View file" now lives next to the copy-path button in the header; the menu
    // keeps the less-frequent Edit / Delete actions.
    const items: { label: string; action: () => void; danger?: boolean }[] = [
        { label: 'Edit file', action: () => openFile(opts.path, true, currentEditLine(menu)) },
        { label: 'Delete file', action: () => void deleteFile(opts.path, opts.onDeleted), danger: true },
    ];
    for (const item of items) {
        const entry = document.createElement('button');
        entry.type = 'button';
        entry.className = 'md-diff-menu-item' + (item.danger ? ' is-danger' : '');
        entry.setAttribute('role', 'menuitem');
        entry.textContent = item.label;
        entry.addEventListener('click', () => {
            closeMenu(menu, button);
            item.action();
        });
        pop.appendChild(entry);
    }

    const toggle = (open: boolean) => {
        pop.hidden = !open;
        button.setAttribute('aria-expanded', open ? 'true' : 'false');
        menu.classList.toggle('is-open', open);
        setMenuHeaderRaised(menu, open);
        if (open) {
            const onDoc = (e: MouseEvent) => {
                if (!menu.contains(e.target as Node)) closeMenu(menu, button);
            };
            const onKey = (e: KeyboardEvent) => {
                if (e.key === 'Escape') closeMenu(menu, button);
            };
            (menu as MenuEl).__cleanup = () => {
                document.removeEventListener('mousedown', onDoc, true);
                document.removeEventListener('keydown', onKey, true);
            };
            document.addEventListener('mousedown', onDoc, true);
            document.addEventListener('keydown', onKey, true);
        } else {
            (menu as MenuEl).__cleanup?.();
            (menu as MenuEl).__cleanup = undefined;
        }
    };
    button.addEventListener('click', () => toggle(!menu.classList.contains('is-open')));

    menu.append(button, pop);
    return menu;
};

/** Build the unified file header element shared by both diff views. */
export function createDiffFileHeader(opts: DiffFileHeaderOpts): HTMLElement {
    const header = document.createElement('header');
    header.className = 'md-diff-file-header md-diff-ui';
    header.classList.toggle('is-collapsed', opts.collapsed);

    // ── Left: collapse chevron · path · copy-path ──────────────────────────────
    const left = document.createElement('div');
    left.className = 'md-diff-file-left';

    const chevron = document.createElement('button');
    chevron.type = 'button';
    chevron.className = 'md-diff-chevron';
    chevron.setAttribute('aria-label', opts.collapsed ? 'Expand file' : 'Collapse file');
    chevron.innerHTML = SVG_CHEVRON;
    chevron.addEventListener('click', () => opts.onToggleCollapse());

    const title = document.createElement('span');
    title.className = 'md-diff-file-title';
    title.textContent = headerDisplay(opts.path, opts.oldPath);

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'md-diff-file-copy';
    copy.title = 'Copy path';
    copy.setAttribute('aria-label', 'Copy path');
    copy.innerHTML = SVG_COPY;
    copy.addEventListener('click', () => void copyPath(opts.path, copy));

    // Open the file's reading view in a new window (was "View file" in the menu).
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'md-diff-file-open';
    open.title = 'Open file in new window';
    open.setAttribute('aria-label', 'Open file in new window');
    open.innerHTML = SVG_OPEN_EXTERNAL;
    open.addEventListener('click', () => openFile(opts.path, false));

    left.append(chevron, title, copy, open);

    // ── Right: diffstat · Viewed · kebab menu ──────────────────────────────────
    const right = document.createElement('div');
    right.className = 'md-diff-file-right';

    const check = document.createElement('label');
    check.className = 'md-diff-file-check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = opts.viewed;
    input.addEventListener('change', () => opts.onToggleViewed());
    const checkText = document.createElement('span');
    checkText.textContent = 'Viewed';
    check.append(input, checkText);

    // A pure rename (path moved, byte-identical content → 0/0) shows nothing in
    // the diffstat slot: the "renamed/moved, no content changes" hint lives in
    // the fold line in the body, and the header's old→new path already conveys
    // the move. Other files get the usual +adds -dels diffstat.
    const pureRename = opts.status === 'renamed' && !(opts.additions || 0) && !(opts.deletions || 0);
    if (!pureRename) right.append(buildDiffstat(opts.additions || 0, opts.deletions || 0));
    right.append(check, buildMenu(opts));

    header.append(left, right);

    // Double-click anywhere on the bar's empty space folds/unfolds the file —
    // a pure fold toggle (like the chevron), never touching "Viewed". Clicks on
    // the interactive controls (chevron, copy, checkbox, menu) are excluded so a
    // stray second click on them doesn't also fold the file.
    header.addEventListener('dblclick', (e) => {
        const target = e.target as Element | null;
        if (
            target?.closest(
                '.md-diff-chevron, .md-diff-file-copy, .md-diff-file-check, .md-diff-menu',
            )
        ) {
            return;
        }
        // Don't leave a text selection behind from the double-click.
        window.getSelection()?.removeAllRanges();
        opts.onToggleCollapse();
    });

    return header;
}
