import { CONFIG } from '../core/config.js';
import { Logger } from '../core/utils.js';

export class SearchManager {
    #searchModal;
    #searchInput;
    #searchResults;
    #isSearchModalVisible = false;
    #selectedIndex = -1;
    #currentResults = [];

    constructor() {
        this.#searchModal = document.getElementById('search-modal');
        this.#searchInput = document.getElementById('search-input');
        this.#searchResults = document.getElementById('search-results');

        if (!this.#searchModal || !this.#searchInput || !this.#searchResults) {
            Logger.error('SearchManager', 'Search UI elements not found');
            return;
        }

        this.#setupEventListeners();
    }

    show() {
        if (!this.#searchModal) return;
        this.#searchModal.style.display = 'block';
        this.#searchInput.value = '';
        this.#searchInput.focus();
        this.#searchResults.innerHTML = '';
        this.#selectedIndex = -1;
        this.#currentResults = [];
        this.#isSearchModalVisible = true;
    }

    hide() {
        if (!this.#searchModal) return;
        this.#searchModal.style.display = 'none';
        this.#isSearchModalVisible = false;
        this.#selectedIndex = -1;
        this.#currentResults = [];
    }

    toggle() {
        if (this.#isSearchModalVisible) {
            this.hide();
        } else {
            this.show();
        }
    }

    #setupEventListeners() {
        this.#searchInput.addEventListener('input', this.#handleSearchInput.bind(this));

        this.#searchInput.addEventListener('keydown', (e) => {
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

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.#isSearchModalVisible) {
                this.hide();
            }
        });
    }

    #moveSelection(direction) {
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

    #updateSelection() {
        const items = this.#searchResults.querySelectorAll('.search-result-item');
        items.forEach((item, index) => {
            if (index === this.#selectedIndex) {
                item.classList.add('selected');
                item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            } else {
                item.classList.remove('selected');
            }
        });
    }

    #selectCurrent() {
        if (this.#selectedIndex >= 0 && this.#selectedIndex < this.#currentResults.length) {
            const result = this.#currentResults[this.#selectedIndex];
            const query = this.#searchInput.value;
            // Add search query parameter for highlighting
            window.location.href = `/${result.file_path}?highlight=${encodeURIComponent(query)}`;
        }
    }

    async #handleSearchInput() {
        const query = this.#searchInput.value;
        if (query.length < 2) {
            this.#searchResults.innerHTML = '';
            this.#currentResults = [];
            this.#selectedIndex = -1;
            return;
        }

        try {
            const response = await fetch(`/search?q=${encodeURIComponent(query)}`);
            const results = await response.json();
            this.#currentResults = results;
            this.#selectedIndex = -1;
            this.#renderResults(results);
        } catch (error) {
            Logger.error('SearchManager', 'Error fetching search results:', error);
        }
    }

    #renderResults(results) {
        if (results.length === 0) {
            this.#searchResults.innerHTML = '<li class="search-result-item no-results">No results found</li>';
            return;
        }

        const query = this.#searchInput.value;
        this.#searchResults.innerHTML = results
            .map(
                (result) => `
                    <li class="search-result-item">
                        <a href="/${result.file_path}?highlight=${encodeURIComponent(query)}">
                            <div class="search-result-title">${result.title}</div>
                            <div class="search-result-path">${result.file_path}</div>
                            <div class="search-result-snippet">${result.snippet}</div>
                        </a>
                    </li>
                `
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
