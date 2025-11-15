import { CONFIG } from '../core/config.js';
import { Logger } from '../core/utils.js';

export class SearchManager {
    #searchModal;
    #searchInput;
    #searchResults;
    #isSearchModalVisible = false;

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
        this.#searchInput.focus();
        this.#isSearchModalVisible = true;
    }

    hide() {
        if (!this.#searchModal) return;
        this.#searchModal.style.display = 'none';
        this.#isSearchModalVisible = false;
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
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.#isSearchModalVisible) {
                this.hide();
            }
        });
    }

    async #handleSearchInput() {
        const query = this.#searchInput.value;
        if (query.length < 2) {
            this.#searchResults.innerHTML = '';
            return;
        }

        try {
            const response = await fetch(`/search?q=${encodeURIComponent(query)}`);
            const results = await response.json();
            this.#renderResults(results);
        } catch (error) {
            Logger.error('SearchManager', 'Error fetching search results:', error);
        }
    }

    #renderResults(results) {
        if (results.length === 0) {
            this.#searchResults.innerHTML = '<li class="search-result-item">No results found</li>';
            return;
        }

        this.#searchResults.innerHTML = results
            .map(
                (result) => `
                    <li class="search-result-item">
                        <a href="/${result.file_path}">
                            <div class="search-result-path">${result.file_path}</div>
                            <div class="search-result-snippet">${result.snippet}</div>
                        </a>
                    </li>
                `
            )
            .join('');
    }
}
