/**
 * Section Viewed Feature
 * Adds GitHub PR-style "Viewed" checkboxes to section headings
 * - Collapse/expand sections
 * - Persist state to LocalStorage
 * - Click collapsed heading to expand
 */

class SectionViewedManager {
    constructor() {
        this.filePath = window.location.pathname;
        this.viewedState = {};
        this.init();
    }

    async init() {
        // 1. Load saved state
        this.loadState();

        // 2. Inject checkboxes to all headings (h2-h6)
        this.injectCheckboxes();

        // 3. Apply saved viewed state
        this.applyViewedState();

        // 4. Setup event listeners
        this.setupEventListeners();
    }

    injectCheckboxes() {
        // Only add checkboxes to h2-h6, not h1 (usually the document title)
        const headings = document.querySelectorAll('.markdown-body h2, .markdown-body h3, .markdown-body h4, .markdown-body h5, .markdown-body h6');

        headings.forEach((heading, index) => {
            // Ensure heading has an ID
            if (!heading.id) {
                heading.id = `heading-${index}`;
            }

            const headingId = heading.id;

            // Create checkbox container
            const label = document.createElement('label');
            label.className = 'viewed-checkbox-label';
            label.title = 'Mark as viewed to collapse this section';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'viewed-checkbox';
            checkbox.dataset.headingId = headingId;

            if (this.viewedState[headingId]) {
                checkbox.checked = true;
            }

            const text = document.createElement('span');
            text.className = 'viewed-text';
            text.textContent = 'Viewed';

            label.appendChild(checkbox);
            label.appendChild(text);
            heading.appendChild(label);
        });
    }

    getSectionContent(heading) {
        // Get all content after this heading until the next same-level or higher-level heading
        const level = parseInt(heading.tagName.substring(1)); // h2 -> 2
        const elements = [];
        let next = heading.nextElementSibling;

        while (next) {
            const tagName = next.tagName;
            if (tagName && tagName.match(/^H[1-6]$/)) {
                const nextLevel = parseInt(tagName.substring(1));
                if (nextLevel <= level) {
                    break; // Stop at same or higher level heading
                }
            }
            elements.push(next);
            next = next.nextElementSibling;
        }

        return elements;
    }

    collapseSection(headingId) {
        const heading = document.getElementById(headingId);
        if (!heading) return;

        const content = this.getSectionContent(heading);

        heading.classList.add('section-collapsed');
        content.forEach(el => {
            el.classList.add('section-content-hidden');
        });
    }

    expandSection(headingId) {
        const heading = document.getElementById(headingId);
        if (!heading) return;

        const content = this.getSectionContent(heading);

        heading.classList.remove('section-collapsed');
        content.forEach(el => {
            el.classList.remove('section-content-hidden');
        });
    }

    toggleViewed(headingId, isViewed) {
        this.viewedState[headingId] = isViewed;

        if (isViewed) {
            this.collapseSection(headingId);
        } else {
            this.expandSection(headingId);
        }

        this.saveState();
    }

    loadState() {
        const key = `markon-viewed-${this.filePath}`;
        const saved = localStorage.getItem(key);
        this.viewedState = saved ? JSON.parse(saved) : {};
    }

    saveState() {
        const key = `markon-viewed-${this.filePath}`;
        localStorage.setItem(key, JSON.stringify(this.viewedState));
    }

    applyViewedState() {
        Object.keys(this.viewedState).forEach(headingId => {
            if (this.viewedState[headingId]) {
                this.collapseSection(headingId);
            }
        });
    }

    setupEventListeners() {
        // Checkbox change event
        document.querySelectorAll('.viewed-checkbox').forEach(checkbox => {
            checkbox.addEventListener('change', (e) => {
                const headingId = e.target.dataset.headingId;
                const isViewed = e.target.checked;
                this.toggleViewed(headingId, isViewed);
            });
        });

        // Click collapsed heading to expand
        document.querySelectorAll('.markdown-body h2, .markdown-body h3, .markdown-body h4, .markdown-body h5, .markdown-body h6').forEach(heading => {
            heading.addEventListener('click', (e) => {
                // Don't trigger when clicking checkbox
                if (e.target.closest('.viewed-checkbox-label')) {
                    return;
                }

                if (heading.classList.contains('section-collapsed')) {
                    const checkbox = heading.querySelector('.viewed-checkbox');
                    if (checkbox) {
                        checkbox.checked = false;
                        this.toggleViewed(heading.id, false);
                    }
                }
            });
        });
    }
}

// Initialize when document is ready
function initViewedFeature() {
    // Only initialize if we're viewing a markdown file (not directory listing)
    if (document.querySelector('.markdown-body')) {
        // eslint-disable-next-line no-new
        new SectionViewedManager();
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initViewedFeature);
} else {
    initViewedFeature();
}
