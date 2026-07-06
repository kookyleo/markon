/**
 * WorkspaceSpotlight - reusable Spotlight-style workspace search.
 *
 * Reuses the workspace file-list JSON endpoint that powers the directory page's
 * file-list UI, and optionally merges in full-text search results from the
 * workspace search endpoint. The empty state behaves like a file/document
 * switcher; typing turns it into a Spotlight-style search across file names and
 * content.
 */

import { i18n } from '../core/config';
import { workspaceFilesDataUrl, workspaceFileUrl, workspaceSearchUrl } from '../core/routes';

interface WorkspaceFileEntry {
    path: string;
    name?: string;
    url: string;
    is_markdown?: boolean;
}

export interface WorkspaceSpotlightOptions {
    workspaceId: string;
    currentPath?: string | null;
    enableContentSearch?: boolean;
}

interface SearchResultPayload {
    title: string;
    file_path: string;
    snippet: string;
}

const MAX_RESULTS = 80;
const MAX_FILE_RESULTS = 40;
const MAX_CONTENT_RESULTS = 30;
const CONTENT_QUERY_MIN_LENGTH = 2;
const CONTENT_SEARCH_DEBOUNCE_MS = 120;

function currentRoutePath(workspaceId: string): string {
    const raw = window.location.pathname.replace(/^\/+/, '');
    const directPrefix = `${workspaceId}/`;
    const underscoredPrefix = `_/${workspaceId}/`;
    const route = raw.startsWith(directPrefix)
        ? raw.slice(directPrefix.length)
        : raw.startsWith(underscoredPrefix)
            ? raw.slice(underscoredPrefix.length)
            : '';
    try {
        return decodeURIComponent(route);
    } catch {
        return route;
    }
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
    ));
}

function highlightPath(path: string, query: string): string {
    if (!query) return escapeHtml(path);
    const lower = path.toLowerCase();
    const idx = lower.indexOf(query);
    if (idx === -1) return escapeHtml(path);
    return escapeHtml(path.slice(0, idx)) +
        '<strong>' + escapeHtml(path.slice(idx, idx + query.length)) + '</strong>' +
        escapeHtml(path.slice(idx + query.length));
}

export class WorkspaceSpotlight {
    readonly #workspaceId: string;
    readonly #currentPath: string;
    readonly #enableContentSearch: boolean;
    #panel: HTMLElement | null = null;
    #input: HTMLInputElement | null = null;
    #results: HTMLElement | null = null;
    #empty: HTMLElement | null = null;
    #files: WorkspaceFileEntry[] | null = null;
    #filesPromise: Promise<WorkspaceFileEntry[]> | null = null;
    #contentResults: SearchResultPayload[] = [];
    #contentStatus: 'idle' | 'loading' | 'error' = 'idle';
    #contentQuery = '';
    #contentTimer: number | null = null;
    #contentSeq = 0;
    #activeIndex = 0;

    constructor({ workspaceId, currentPath = '', enableContentSearch = false }: WorkspaceSpotlightOptions) {
        this.#workspaceId = workspaceId;
        this.#currentPath = currentRoutePath(workspaceId) || (currentPath || '').replace(/^\/+/, '');
        this.#enableContentSearch = enableContentSearch;
    }

    bindTriggers(root: ParentNode = document): void {
        root.querySelectorAll<HTMLButtonElement>('[data-workspace-spotlight-trigger]').forEach((trigger) => {
            if (trigger.dataset['workspaceSpotlightBound'] === '1') return;
            trigger.dataset['workspaceSpotlightBound'] = '1';
            trigger.addEventListener('click', (event) => {
                event.preventDefault();
                this.toggle();
            });
        });
    }

    isOpen(): boolean {
        return this.#panel?.classList.contains('is-open') ?? false;
    }

    open(): void {
        this.#ensurePanel();
        if (!this.#panel || !this.#input) return;
        this.#panel.classList.add('is-open');
        this.#panel.setAttribute('aria-hidden', 'false');
        document.body.classList.add('workspace-spotlight-open');
        this.#input.value = '';
        this.#contentResults = [];
        this.#contentStatus = 'idle';
        this.#contentQuery = '';
        this.#render();
        this.#loadFiles();
        window.setTimeout(() => {
            this.#input?.focus();
            this.#input?.select();
        }, 0);
    }

    close(): void {
        if (!this.#panel) return;
        this.#panel.classList.remove('is-open');
        this.#panel.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('workspace-spotlight-open');
        if (this.#contentTimer !== null) {
            window.clearTimeout(this.#contentTimer);
            this.#contentTimer = null;
        }
    }

    toggle(): void {
        if (this.isOpen()) this.close();
        else this.open();
    }

    #ensurePanel(): void {
        if (this.#panel) return;

        const panel = document.createElement('div');
        panel.className = 'workspace-spotlight-overlay markon-modal-layer';
        panel.setAttribute('aria-hidden', 'true');
        panel.innerHTML = `
            <div class="workspace-spotlight-scrim markon-modal-backdrop" data-workspace-spotlight-close></div>
            <div class="workspace-spotlight-panel markon-modal-frame" role="dialog" aria-modal="true" aria-label="${escapeHtml(i18n.t('web.wsnav.title'))}">
                <div class="workspace-spotlight-input-wrap">
                    <span class="workspace-spotlight-search-icon" aria-hidden="true"></span>
                    <input class="workspace-spotlight-input" type="search" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="${escapeHtml(i18n.t('web.wsnav.placeholder'))}">
                </div>
                <ul class="workspace-spotlight-results"></ul>
                <div class="workspace-spotlight-empty">${escapeHtml(i18n.t('web.wsnav.loading'))}</div>
            </div>
        `;
        document.body.appendChild(panel);

        this.#panel = panel;
        this.#input = panel.querySelector<HTMLInputElement>('.workspace-spotlight-input');
        this.#results = panel.querySelector<HTMLElement>('.workspace-spotlight-results');
        this.#empty = panel.querySelector<HTMLElement>('.workspace-spotlight-empty');

        panel.querySelector('[data-workspace-spotlight-close]')?.addEventListener('click', () => this.close());
        panel.addEventListener('wheel', (event) => this.#handlePanelWheel(event), { passive: false });
        this.#input?.addEventListener('input', () => this.#handleInputChange());
        this.#input?.addEventListener('keydown', (event) => this.#handleInputKeydown(event));
        this.#results?.addEventListener('mouseover', (event) => {
            const target = event.target as HTMLElement | null;
            const link = target?.closest<HTMLAnchorElement>('.workspace-spotlight-result');
            if (!link || !this.#results) return;
            const links = this.#links();
            const idx = links.indexOf(link);
            if (idx >= 0) this.#setActive(idx, links);
        });
    }

    #handlePanelWheel(event: WheelEvent): void {
        if (!this.#results) return;
        event.stopPropagation();

        const target = event.target instanceof Element ? event.target : null;
        const isInsideResults = target ? this.#results.contains(target) : false;
        const canScroll = this.#results.scrollHeight > this.#results.clientHeight;
        const atTop = this.#results.scrollTop <= 0;
        const atBottom = Math.ceil(this.#results.scrollTop + this.#results.clientHeight) >= this.#results.scrollHeight;

        if (!canScroll) {
            event.preventDefault();
            return;
        }

        if (!isInsideResults) {
            event.preventDefault();
            this.#results.scrollTop += event.deltaY;
            return;
        }

        if ((event.deltaY < 0 && atTop) || (event.deltaY > 0 && atBottom)) {
            event.preventDefault();
        }
    }

    #handleInputKeydown(event: KeyboardEvent): void {
        if (event.key === 'Escape') {
            event.preventDefault();
            this.close();
            return;
        }
        const links = this.#links();
        if (!links.length) return;
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            this.#setActive(this.#activeIndex + 1, links);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            this.#setActive(this.#activeIndex - 1, links);
        } else if (event.key === 'Enter') {
            const current = links[this.#activeIndex];
            if (current) {
                event.preventDefault();
                window.location.href = current.href;
            }
        }
    }

    #links(): HTMLAnchorElement[] {
        return this.#results ? Array.from(this.#results.querySelectorAll<HTMLAnchorElement>('.workspace-spotlight-result')) : [];
    }

    #setActive(index: number, links = this.#links()): void {
        if (!links.length) {
            this.#activeIndex = 0;
            return;
        }
        this.#activeIndex = Math.max(0, Math.min(index, links.length - 1));
        links.forEach((link, i) => {
            link.classList.toggle('is-active', i === this.#activeIndex);
            link.setAttribute('aria-selected', i === this.#activeIndex ? 'true' : 'false');
        });
        const current = links[this.#activeIndex];
        if (current?.scrollIntoView) current.scrollIntoView({ block: 'nearest' });
    }

    #loadFiles(): void {
        if (this.#files) {
            this.#render();
            return;
        }
        if (!this.#empty) return;
        this.#empty.textContent = i18n.t('web.wsnav.loading');
        this.#ensureFiles()
            .then(() => this.#render())
            .catch(() => {
                this.#files = [];
                if (this.#empty) this.#empty.textContent = i18n.t('web.wsnav.error');
                this.#render();
            });
    }

    #ensureFiles(): Promise<WorkspaceFileEntry[]> {
        if (this.#files) return Promise.resolve(this.#files);
        if (this.#filesPromise) return this.#filesPromise;
        const url = workspaceFilesDataUrl(this.#workspaceId);
        this.#filesPromise = fetch(url, { credentials: 'same-origin' })
            .then((response) => {
                if (!response.ok) throw new Error(response.statusText);
                return response.json() as Promise<WorkspaceFileEntry[]>;
            })
            .then((files) => {
                this.#files = (files || []).filter((file) => file.is_markdown);
                return this.#files;
            })
            .catch((error: unknown) => {
                this.#filesPromise = null;
                throw error;
            });
        return this.#filesPromise;
    }

    #handleInputChange(): void {
        this.#render();
        this.#scheduleContentSearch();
    }

    #scheduleContentSearch(): void {
        if (!this.#enableContentSearch) return;
        const query = (this.#input?.value || '').trim();
        if (this.#contentTimer !== null) {
            window.clearTimeout(this.#contentTimer);
            this.#contentTimer = null;
        }
        if (query.length < CONTENT_QUERY_MIN_LENGTH) {
            this.#contentResults = [];
            this.#contentStatus = 'idle';
            this.#contentQuery = '';
            this.#render();
            return;
        }
        if (query !== this.#contentQuery) {
            this.#contentResults = [];
        }
        this.#contentStatus = 'loading';
        this.#contentQuery = query;
        this.#render();
        this.#contentTimer = window.setTimeout(() => {
            this.#contentTimer = null;
            void this.#loadContentResults(query);
        }, CONTENT_SEARCH_DEBOUNCE_MS);
    }

    async #loadContentResults(query: string): Promise<void> {
        const seq = ++this.#contentSeq;
        try {
            const response = await fetch(workspaceSearchUrl(this.#workspaceId, query), { credentials: 'same-origin' });
            if (!response.ok) throw new Error(response.statusText);
            const raw: unknown = await response.json();
            if (seq !== this.#contentSeq || query !== this.#contentQuery) return;
            this.#contentResults = this.#coerceContentResults(raw);
            this.#contentStatus = 'idle';
            this.#render();
        } catch {
            if (seq !== this.#contentSeq) return;
            this.#contentResults = [];
            this.#contentStatus = 'error';
            this.#render();
        }
    }

    #coerceContentResults(raw: unknown): SearchResultPayload[] {
        if (!Array.isArray(raw)) return [];
        const out: SearchResultPayload[] = [];
        for (const item of raw) {
            if (
                item &&
                typeof item === 'object' &&
                'title' in item &&
                'file_path' in item &&
                'snippet' in item
            ) {
                const obj = item as Record<string, unknown>;
                const title = obj['title'];
                const filePath = obj['file_path'];
                const snippet = obj['snippet'];
                out.push({
                    title: typeof title === 'string' ? title : '',
                    file_path: typeof filePath === 'string' ? filePath : '',
                    snippet: typeof snippet === 'string' ? snippet : '',
                });
            }
        }
        return out;
    }

    #render(): void {
        if (!this.#results || !this.#empty) return;
        this.#results.innerHTML = '';
        if (!this.#files) {
            this.#empty.style.display = '';
            this.#empty.textContent = i18n.t('web.wsnav.loading');
            return;
        }

        const query = (this.#input?.value || '').trim().toLowerCase();
        const fileList = this.#files
            .filter((file) => !query || file.path.toLowerCase().includes(query))
            .slice(0, query ? MAX_FILE_RESULTS : MAX_RESULTS);
        const contentList = query.length >= CONTENT_QUERY_MIN_LENGTH
            ? this.#contentResults.slice(0, MAX_CONTENT_RESULTS)
            : [];
        const hasMatches = fileList.length > 0 || contentList.length > 0;

        this.#empty.style.display = hasMatches ? 'none' : '';
        if (!hasMatches) {
            if (this.#contentStatus === 'loading') {
                this.#empty.textContent = i18n.t('web.wsnav.searching');
            } else if (this.#contentStatus === 'error') {
                this.#empty.textContent = i18n.t('web.wsnav.error');
            } else {
                this.#empty.textContent = query ? i18n.t('web.wsnav.no_matches') : i18n.t('web.wsnav.empty');
            }
            this.#activeIndex = 0;
            return;
        }

        const fragment = document.createDocumentFragment();
        if (fileList.length > 0) {
            fragment.appendChild(this.#sectionLabel(i18n.t('web.wsnav.files')));
        }
        for (const file of fileList) {
            const li = document.createElement('li');
            const link = document.createElement('a');
            link.className = 'workspace-spotlight-result workspace-spotlight-result--file';
            link.href = file.url;
            link.setAttribute('role', 'option');
            if (file.path === this.#currentPath) {
                link.classList.add('is-current');
            }
            link.innerHTML = `
                <span class="workspace-spotlight-file-icon" aria-hidden="true"></span>
                <span class="workspace-spotlight-result-path">${highlightPath(file.path, query)}</span>
                <span class="workspace-spotlight-result-badge">${escapeHtml(file.path === this.#currentPath ? i18n.t('web.wsnav.current') : 'MD')}</span>
            `;
            li.appendChild(link);
            fragment.appendChild(li);
        }
        if (contentList.length > 0) {
            fragment.appendChild(this.#sectionLabel(i18n.t('web.wsnav.contents')));
        }
        for (const result of contentList) {
            const li = document.createElement('li');
            const link = document.createElement('a');
            link.className = 'workspace-spotlight-result workspace-spotlight-result--content';
            link.href = `${workspaceFileUrl(this.#workspaceId, result.file_path)}?highlight=${encodeURIComponent(this.#contentQuery)}`;
            link.setAttribute('role', 'option');
            // Tantivy snippet.to_html() escapes source text and wraps hits in <b>.
            link.innerHTML = `
                <span class="workspace-spotlight-file-icon" aria-hidden="true"></span>
                <span class="workspace-spotlight-result-main">
                    <span class="workspace-spotlight-result-title">${escapeHtml(result.title || result.file_path)}</span>
                    <span class="workspace-spotlight-result-path">${highlightPath(result.file_path, query)}</span>
                    <span class="workspace-spotlight-result-snippet">${result.snippet}</span>
                </span>
                <span class="workspace-spotlight-result-badge">${escapeHtml(i18n.t('web.wsnav.content'))}</span>
            `;
            li.appendChild(link);
            fragment.appendChild(li);
        }
        if (this.#contentStatus === 'loading') {
            fragment.appendChild(this.#statusRow(i18n.t('web.wsnav.searching')));
        } else if (this.#contentStatus === 'error') {
            fragment.appendChild(this.#statusRow(i18n.t('web.wsnav.error')));
        }
        this.#results.appendChild(fragment);
        this.#setActive(0);
    }

    #sectionLabel(label: string): HTMLLIElement {
        const li = document.createElement('li');
        li.className = 'workspace-spotlight-section-label';
        li.textContent = label;
        return li;
    }

    #statusRow(label: string): HTMLLIElement {
        const li = document.createElement('li');
        li.className = 'workspace-spotlight-status-row';
        li.textContent = label;
        return li;
    }
}
