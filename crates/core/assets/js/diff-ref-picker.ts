/**
 * Custom Base↔Compare revision picker for the compare page.
 *
 * Replaces the two native <select>s with one trigger ("Base → Compare") that
 * opens a rich panel: quick presets, plus a Base column and a Compare column of
 * ref rows (kind badge, name/short-hash, commit subject, relative date) with
 * per-column search. Picking both + "Compare" navigates to the new range.
 * Rows that would produce no Markdown changes (relative to the other pending
 * side) are greyed via the compare-options status endpoint.
 *
 * Reads its data from the `[data-compare-picker]` JSON the server renders.
 */

interface RefOption {
    value: string;
    label: string;
    alias: string;
    kind: string; // worktree | head | branch | tag | commit
    subject: string;
    detail: string; // short hash / "current" / ""
    date: string; // relative time / ""
    selected: boolean;
    disabled: boolean;
}
interface PickerData {
    base: RefOption[];
    compare: RefOption[];
    baseValue: string;
    compareValue: string;
}
type RefStatus = { value?: unknown; disabled?: unknown };

const isRefOption = (value: unknown): value is RefOption => {
    if (!value || typeof value !== 'object') return false;
    const obj = value as Record<string, unknown>;
    return typeof obj['value'] === 'string'
        && typeof obj['label'] === 'string'
        && typeof obj['kind'] === 'string';
};

const readPickerData = (value: unknown): PickerData | null => {
    if (!value || typeof value !== 'object') return null;
    const obj = value as Record<string, unknown>;
    const base = Array.isArray(obj['base']) ? obj['base'].filter(isRefOption) : [];
    const compare = Array.isArray(obj['compare']) ? obj['compare'].filter(isRefOption) : [];
    return {
        base,
        compare,
        baseValue: typeof obj['baseValue'] === 'string' ? obj['baseValue'] : '',
        compareValue: typeof obj['compareValue'] === 'string' ? obj['compareValue'] : '',
    };
};

const readStatus = (value: unknown): { base?: RefStatus[]; compare?: RefStatus[] } | null => {
    if (!value || typeof value !== 'object') return null;
    const obj = value as Record<string, unknown>;
    const status: { base?: RefStatus[]; compare?: RefStatus[] } = {};
    if (Array.isArray(obj['base'])) status.base = obj['base'] as RefStatus[];
    if (Array.isArray(obj['compare'])) status.compare = obj['compare'] as RefStatus[];
    return status;
};

const KIND_ORDER = ['worktree', 'head', 'branch', 'tag', 'commit'];
const KIND_GROUP: Record<string, string> = {
    worktree: 'Working tree', head: 'HEAD', branch: 'Branches', tag: 'Tags', commit: 'Commits',
};
const KIND_BADGE: Record<string, string> = {
    worktree: 'WT', head: 'HEAD', branch: 'BR', tag: 'TAG', commit: '#',
};

const shortValue = (opts: RefOption[], value: string): string => {
    const o = opts.find((x) => x.value === value);
    if (!o) return value;
    if (o.kind === 'commit') return o.detail || o.label;
    return o.label.replace(' (current)', '');
};

function init(): void {
    const control = document.querySelector<HTMLElement>('[data-compare-control]');
    const dataEl = document.querySelector<HTMLElement>('[data-compare-picker]');
    const trigger = document.querySelector<HTMLButtonElement>('[data-compare-trigger]');
    if (!control || !dataEl || !trigger) return;
    let data: PickerData | null;
    try { data = readPickerData(JSON.parse(dataEl.textContent || '{}') as unknown); } catch { return; }
    if (!data) return;

    const pathBase = control.getAttribute('data-compare-path-base') || '';
    const statusUrl = control.getAttribute('data-compare-status-url') || '';

    let pendingBase = data.baseValue;
    let pendingCompare = data.compareValue;
    let panel: HTMLElement | null = null;

    const baseLabelEl = trigger.querySelector<HTMLElement>('[data-compare-base-label]');
    const compareLabelEl = trigger.querySelector<HTMLElement>('[data-compare-compare-label]');
    const updateTrigger = (): void => {
        if (baseLabelEl) baseLabelEl.textContent = shortValue(data.base, pendingBase);
        if (compareLabelEl) compareLabelEl.textContent = shortValue(data.compare, pendingCompare);
    };
    updateTrigger();

    const currentView = (): string =>
        document.querySelector('[data-diff-shell]')?.getAttribute('data-current-diff-view') === 'rendered'
            ? 'rendered' : 'raw';
    const encodeRef = (v: string): string => v.split('/').map(encodeURIComponent).join('/');
    const currentRelUrl = (): string => location.pathname + location.search + location.hash;
    const navigate = (base: string, compare: string): void => {
        if (!base || !compare || !pathBase || base === compare) return;
        let url = `${pathBase}/${encodeRef(base)}...${encodeRef(compare)}?view=${currentView()}`;
        try { if (location.hash) url += location.hash; } catch { /* ignore */ }
        if (url !== currentRelUrl()) location.href = url;
    };

    // Quick-preset links, rendered INLINE under the trigger (not in the popover).
    const renderPresets = (): void => {
        const host = control.querySelector<HTMLElement>('[data-compare-quick]');
        if (!host) return;
        host.replaceChildren();
        const add = (label: string, base: string, compare: string): void => {
            if (!data.base.some((o) => o.value === base) && base !== 'HEAD') return;
            if (!data.compare.some((o) => o.value === compare)) return;
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'git-compare-preset';
            b.textContent = label;
            b.addEventListener('click', () => navigate(base, compare));
            host.appendChild(b);
        };
        if (data.compare.some((o) => o.kind === 'worktree')) add('Uncommitted changes', 'HEAD', 'worktree');
        const commits = data.base.filter((o) => o.kind === 'commit');
        const latestCommit = commits[1];
        if (latestCommit) add('Latest commit', latestCommit.value, 'HEAD');
    };
    renderPresets();

    // ── Panel ───────────────────────────────────────────────────────────────
    const close = (): void => {
        panel?.remove();
        panel = null;
        trigger.setAttribute('aria-expanded', 'false');
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('mousedown', onDoc, true);
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(); };
    const onDoc = (e: MouseEvent): void => {
        const t = e.target as Node;
        if (panel && !panel.contains(t) && !trigger.contains(t)) close();
    };

    /** Render one column's rows (grouped by kind), honouring the search query. */
    const renderColumn = (
        listEl: HTMLElement,
        opts: RefOption[],
        side: 'base' | 'compare',
        query: string,
    ): void => {
        const q = query.trim().toLowerCase();
        const match = (o: RefOption) =>
            !q || `${o.label} ${o.alias || ''} ${o.subject} ${o.value}`.toLowerCase().includes(q);
        const pending = side === 'base' ? pendingBase : pendingCompare;
        listEl.replaceChildren();
        for (const kind of KIND_ORDER) {
            const group = opts.filter((o) => o.kind === kind && match(o));
            if (!group.length) continue;
            const gh = document.createElement('div');
            gh.className = 'git-compare-group';
            gh.textContent = KIND_GROUP[kind] || kind;
            listEl.appendChild(gh);
            for (const o of group) {
                const row = document.createElement('button');
                row.type = 'button';
                row.className = 'git-compare-row';
                row.dataset['value'] = o.value;
                row.classList.toggle('is-selected', o.value === pending);
                if (o.disabled) row.classList.add('is-disabled');
                const badge = `<span class="git-compare-badge git-compare-badge-${o.kind}">${KIND_BADGE[o.kind] || ''}</span>`;
                const name = o.kind === 'commit' ? (o.detail || '') : o.label.replace(' (current)', '');
                const alias = o.alias ? `<span class="git-compare-row-alias">${escapeHtml(o.alias)}</span>` : '';
                const sub = o.subject ? `<span class="git-compare-row-sub">${escapeHtml(o.subject)}</span>` : '';
                const detail = o.kind === 'commit' && o.detail ? '' : (o.detail ? `<span class="git-compare-row-detail">${escapeHtml(o.detail)}</span>` : '');
                const date = o.date ? `<span class="git-compare-row-date">${escapeHtml(o.date)}</span>` : '';
                row.innerHTML =
                    `${badge}<span class="git-compare-row-main"><span class="git-compare-row-name"><span class="git-compare-row-name-text">${escapeHtml(name)}</span>${alias}</span>${sub}</span>${detail}${date}`;
                row.addEventListener('click', () => {
                    if (row.classList.contains('is-disabled')) return;
                    if (side === 'base') pendingBase = o.value; else pendingCompare = o.value;
                    syncSelection();
                    // Auto-submit: once both sides are chosen, picking either one
                    // navigates straight to the range (no separate Compare button).
                    // navigate() is a no-op when the URL is unchanged or
                    // base === compare, so the panel stays open in those cases and
                    // we refresh the grey-out status instead.
                    if (pendingBase && pendingCompare && pendingBase !== pendingCompare) {
                        navigate(pendingBase, pendingCompare);
                    } else {
                        void refreshStatus();
                    }
                });
                listEl.appendChild(row);
            }
        }
        if (!listEl.childElementCount) {
            const empty = document.createElement('div');
            empty.className = 'git-compare-empty';
            empty.textContent = 'No matches';
            listEl.appendChild(empty);
        }
    };

    let baseListEl: HTMLElement;
    let compareListEl: HTMLElement;
    let baseSearch: HTMLInputElement;
    let compareSearch: HTMLInputElement;

    const syncSelection = (): void => {
        baseListEl.querySelectorAll<HTMLElement>('.git-compare-row').forEach((r) =>
            r.classList.toggle('is-selected', r.dataset['value'] === pendingBase));
        compareListEl.querySelectorAll<HTMLElement>('.git-compare-row').forEach((r) =>
            r.classList.toggle('is-selected', r.dataset['value'] === pendingCompare));
    };

    /** Grey rows that produce no Markdown changes vs the other pending side. */
    const refreshStatus = async (): Promise<void> => {
        if (!statusUrl || !pendingBase || !pendingCompare) return;
        try {
            const url = `${statusUrl}?base=${encodeURIComponent(pendingBase)}&compare=${encodeURIComponent(pendingCompare)}`;
            const resp = await fetch(url, { headers: { Accept: 'application/json' } });
            if (!resp.ok) return;
            const status = readStatus(await resp.json() as unknown);
            const apply = (listEl: HTMLElement, statuses: RefStatus[] | undefined, pending: string) => {
                if (!Array.isArray(statuses)) return;
                const byVal = new Map(statuses.filter((s) => typeof s.value === 'string').map((s) => [s.value, Boolean(s.disabled)]));
                listEl.querySelectorAll<HTMLElement>('.git-compare-row').forEach((r) => {
                    const v = r.dataset['value'] || '';
                    if (v === pending) { r.classList.remove('is-disabled'); return; }
                    if (byVal.has(v)) r.classList.toggle('is-disabled', !!byVal.get(v));
                });
            };
            if (panel && status) {
                apply(baseListEl, status.base, pendingBase);
                apply(compareListEl, status.compare, pendingCompare);
            }
        } catch { /* ignore */ }
    };

    const buildPanel = (): HTMLElement => {
        const p = document.createElement('div');
        p.className = 'git-compare-panel';
        p.setAttribute('role', 'dialog');
        p.setAttribute('aria-label', 'Choose compared revisions');

        // Two columns.
        const cols = document.createElement('div');
        cols.className = 'git-compare-cols';
        const makeCol = (title: string): { col: HTMLElement; list: HTMLElement; search: HTMLInputElement } => {
            const col = document.createElement('div');
            col.className = 'git-compare-col';
            const h = document.createElement('div');
            h.className = 'git-compare-col-title';
            h.textContent = title;
            const search = document.createElement('input');
            search.type = 'search';
            search.className = 'git-compare-search';
            search.placeholder = 'Filter…';
            const list = document.createElement('div');
            list.className = 'git-compare-list';
            col.append(h, search, list);
            return { col, list, search };
        };
        const baseCol = makeCol('Base');
        const compareCol = makeCol('Compare');
        baseListEl = baseCol.list; compareListEl = compareCol.list;
        baseSearch = baseCol.search; compareSearch = compareCol.search;
        baseSearch.addEventListener('input', () => renderColumn(baseListEl, data.base, 'base', baseSearch.value));
        compareSearch.addEventListener('input', () => renderColumn(compareListEl, data.compare, 'compare', compareSearch.value));
        cols.append(baseCol.col, compareCol.col);
        // The columns live in their own bordered surface; presets sit outside it
        // (above) as plain links — the panel itself is just a transparent wrapper.
        const surface = document.createElement('div');
        surface.className = 'git-compare-surface';
        surface.appendChild(cols);
        p.appendChild(surface);

        renderColumn(baseListEl, data.base, 'base', '');
        renderColumn(compareListEl, data.compare, 'compare', '');
        syncSelection();
        return p;
    };

    const positionPanel = (p: HTMLElement, anchor: HTMLElement): void => {
        const r = anchor.getBoundingClientRect();
        const width = Math.min(720, window.innerWidth - 16);
        p.style.width = `${width}px`;
        let left = r.left;
        if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
        p.style.left = `${Math.max(8, left)}px`;
        p.style.top = `${r.bottom + 6}px`;
    };

    const open = (): void => {
        if (panel) { close(); return; }
        // Reset pending to the live selection each open.
        pendingBase = data.baseValue;
        pendingCompare = data.compareValue;
        panel = buildPanel();
        document.body.appendChild(panel);
        positionPanel(panel, trigger);
        trigger.setAttribute('aria-expanded', 'true');
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('mousedown', onDoc, true);
        void refreshStatus();
        baseSearch.focus();
    };
    trigger.addEventListener('click', (e) => { e.preventDefault(); open(); });
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}

export {};
