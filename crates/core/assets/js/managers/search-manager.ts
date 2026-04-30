/**
 * SearchManager - Markon workspace search modal.
 *
 * Owns the modal UI elements declared in layout.html and proxies user input
 * through to the workspace search endpoint:
 *
 *   GET /search?ws={workspace_id}&q={query}
 *
 * The endpoint returns an array of {@link SearchResultPayload} objects with
 * snake_case field names. We pass them through unchanged because the rendered
 * <a href> uses `file_path` directly, matching the legacy .js behavior.
 */

import { CONFIG, i18n } from '../core/config';
import { Logger } from '../core/utils';
import { Meta } from '../services/dom';

const _t = (key: string, ...args: unknown[]): string => i18n.t(key, ...args);

/**
 * Raw payload shape returned by `/search`. Field names are snake_case to
 * match the Rust-side serializer; the renderer reads them as-is.
 *
 * TODO(phase-3-typing): once the backend exposes a typed contract (e.g. via
 * generated bindings), drop the snake_case + add a `SearchResult` camelCase
 * facade with explicit conversion at the network boundary.
 */
export interface SearchResultPayload {
    title: string;
    file_path: string;
    snippet: string;
}

export class SearchManager {
    #searchModal: HTMLElement | null;
    #searchInput: HTMLInputElement | null;
    #searchResults: HTMLElement | null;
    #isSearchModalVisible = false;
    #selectedIndex = -1;
    #currentResults: SearchResultPayload[] = [];

    constructor() {
        this.#searchModal = document.getElementById('search-modal');
        this.#searchInput = document.getElementById('search-input') as HTMLInputElement | null;
        this.#searchResults = document.getElementById('search-results');

        if (!this.#searchModal || !this.#searchInput || !this.#searchResults) {
            Logger.error('SearchManager', 'Search UI elements not found');
            return;
        }

        this.#setupEventListeners();
    }

    show(): void {
        if (!this.#searchModal || !this.#searchInput || !this.#searchResults) return;
        this.#searchModal.style.display = 'block';
        this.#searchInput.value = '';
        this.#searchInput.focus();
        this.#searchResults.innerHTML = '';
        this.#selectedIndex = -1;
        this.#currentResults = [];
        this.#isSearchModalVisible = true;
    }

    hide(): void {
        if (!this.#searchModal) return;
        this.#searchModal.style.display = 'none';
        this.#isSearchModalVisible = false;
        this.#selectedIndex = -1;
        this.#currentResults = [];
    }

    toggle(): void {
        if (this.#isSearchModalVisible) {
            this.hide();
        } else {
            this.show();
        }
    }

    #setupEventListeners(): void {
        if (!this.#searchInput) return;

        this.#searchInput.addEventListener('input', () => {
            void this.#handleSearchInput();
        });

        this.#searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
            if (!this.#isSearchModalVisible) return;

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.#moveSelection(1);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                this.#moveSelection(-1);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                this.#selectCurrent();
            }
        });

        document.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Escape' && this.#isSearchModalVisible) {
                this.hide();
            }
        });
    }

    #moveSelection(direction: number): void {
        if (this.#currentResults.length === 0) return;

        const newIndex = this.#selectedIndex + direction;

        if (newIndex < 0) {
            this.#selectedIndex = this.#currentResults.length - 1;
        } else if (newIndex >= this.#currentResults.length) {
            this.#selectedIndex = 0;
        } else {
            this.#selectedIndex = newIndex;
        }

        this.#updateSelection();
    }

    #updateSelection(): void {
        if (!this.#searchResults) return;
        const items = this.#searchResults.querySelectorAll('.search-result-item');
        items.forEach((item, index) => {
            if (index === this.#selectedIndex) {
                item.classList.add('selected');
                (item as HTMLElement).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            } else {
                item.classList.remove('selected');
            }
        });
    }

    #getWorkspaceId(): string {
        return Meta.get(CONFIG.META_TAGS.WORKSPACE_ID) ?? '';
    }

    #selectCurrent(): void {
        if (!this.#searchInput) return;
        if (this.#selectedIndex >= 0 && this.#selectedIndex < this.#currentResults.length) {
            const result = this.#currentResults[this.#selectedIndex];
            const query = this.#searchInput.value;
            const wsId = this.#getWorkspaceId();
            window.location.href = `/${wsId}/${result.file_path}?highlight=${encodeURIComponent(query)}`;
        }
    }

    async #handleSearchInput(): Promise<void> {
        if (!this.#searchInput || !this.#searchResults) return;

        const query = this.#searchInput.value;
        if (query.length < 2) {
            this.#searchResults.innerHTML = '';
            this.#currentResults = [];
            this.#selectedIndex = -1;
            return;
        }

        try {
            const wsId = this.#getWorkspaceId();
            const response = await fetch(
                `/search?ws=${encodeURIComponent(wsId)}&q=${encodeURIComponent(query)}`,
            );
            const raw: unknown = await response.json();
            const results = this.#coerceResults(raw);
            this.#currentResults = results;
            this.#selectedIndex = -1;
            this.#renderResults(results);
        } catch (error) {
            Logger.error('SearchManager', 'Error fetching search results:', error);
        }
    }

    #coerceResults(raw: unknown): SearchResultPayload[] {
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
                out.push({
                    title: String(obj.title ?? ''),
                    file_path: String(obj.file_path ?? ''),
                    snippet: String(obj.snippet ?? ''),
                });
            }
        }
        return out;
    }

    #renderResults(results: SearchResultPayload[]): void {
        if (!this.#searchResults || !this.#searchInput) return;

        if (results.length === 0) {
            this.#searchResults.innerHTML = `<li class="search-result-item no-results">${_t('web.search.noresult')}</li>`;
            return;
        }

        const query = this.#searchInput.value;
        const wsId = this.#getWorkspaceId();
        this.#searchResults.innerHTML = results
            .map(
                (result) => `
                    <li class="search-result-item">
                        <a href="/${wsId}/${result.file_path}?highlight=${encodeURIComponent(query)}">
                            <div class="search-result-title">${result.title}</div>
                            <div class="search-result-path">${result.file_path}</div>
                            <div class="search-result-snippet">${result.snippet}</div>
                        </a>
                    </li>
                `,
            )
            .join('');

        // 添加鼠标点击事件
        const items = this.#searchResults.querySelectorAll('.search-result-item');
        items.forEach((item, index) => {
            item.addEventListener('mouseenter', () => {
                this.#selectedIndex = index;
                this.#updateSelection();
            });
        });
    }
}
