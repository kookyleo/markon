/**
 * Section Viewed Feature
 * Adds GitHub PR-style "Viewed" checkboxes to section headings
 * - Collapse/expand sections
 * - Persist state to LocalStorage (local mode) or SQLite (shared mode)
 * - Click collapsed heading to expand
 * - Phase 3: Batch operations, TOC highlighting, smart jump
 */

class SectionViewedManager {
    constructor(isSharedMode, ws) {
        this.isSharedMode = isSharedMode;
        this.ws = ws;
        // Use meta file-path to ensure consistency with editor.js clear function
        const filePathMeta = document.querySelector('meta[name="file-path"]');
        this.filePath = filePathMeta ? filePathMeta.getAttribute('content') : window.location.pathname;
        this.viewedState = {};
        this.stateLoaded = false;

        if (this.isSharedMode && this.ws) {
            this.setupWebSocketListeners();
        }

        this.init();
    }

    async init() {
        // 1. Load saved state (async for shared mode)
        await this.loadState();

        // 2. Inject checkboxes to all headings (h2-h6)
        this.injectCheckboxes();

        // 3. Create toolbar for batch operations
        this.createToolbar();

        // 4. Apply saved viewed state
        this.applyViewedState();

        // 5. Setup event listeners
        this.setupEventListeners();

        // 6. Auto-jump to first unviewed section (if any)
        this.autoJumpToNext();
    }

    setupWebSocketListeners() {
        if (!this.ws) return;

        // Listen for viewed state updates from other clients
        this.ws.addEventListener('message', (event) => {
            try {
                const data = JSON.parse(event.data);

                if (data.type === 'viewed_state') {
                    // Received viewed state from server (initial load or update from other client)
                    this.viewedState = data.state || {};
                    this.stateLoaded = true;

                    // If checkboxes are already injected, update their state
                    if (document.querySelector('.viewed-checkbox')) {
                        this.updateCheckboxes();
                        this.applyViewedState();
                    }
                }
            } catch (e) {
                // Not a viewed message, ignore
            }
        });
    }

    updateCheckboxes() {
        // Update checkbox states based on viewedState
        document.querySelectorAll('.viewed-checkbox').forEach(checkbox => {
            const headingId = checkbox.dataset.headingId;
            checkbox.checked = !!this.viewedState[headingId];
        });
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

        this.updateTocHighlights();
        this.saveState();
    }

    async loadState() {
        if (this.isSharedMode) {
            // In shared mode, state will be received via WebSocket
            // Wait a bit for the initial state message
            return new Promise((resolve) => {
                if (this.stateLoaded) {
                    resolve();
                    return;
                }

                const timeout = setTimeout(() => {
                    // If no state received after 500ms, use empty state
                    this.viewedState = {};
                    this.stateLoaded = true;
                    resolve();
                }, 500);

                // Listen for state to be loaded
                const checkInterval = setInterval(() => {
                    if (this.stateLoaded) {
                        clearTimeout(timeout);
                        clearInterval(checkInterval);
                        resolve();
                    }
                }, 50);
            });
        } else {
            // Local mode: use LocalStorage
            const key = `markon-viewed-${this.filePath}`;
            const saved = localStorage.getItem(key);
            this.viewedState = saved ? JSON.parse(saved) : {};
            this.stateLoaded = true;
        }
    }

    saveState() {
        if (this.isSharedMode && this.ws && this.ws.readyState === WebSocket.OPEN) {
            // Shared mode: send to server via WebSocket
            this.ws.send(JSON.stringify({
                type: 'update_viewed_state',
                state: this.viewedState
            }));
        } else if (!this.isSharedMode) {
            // Local mode: save to LocalStorage
            const key = `markon-viewed-${this.filePath}`;
            localStorage.setItem(key, JSON.stringify(this.viewedState));
        }
    }

    applyViewedState() {
        // Get all headings that have checkboxes
        const allHeadingIds = Array.from(document.querySelectorAll('.viewed-checkbox')).map(
            cb => cb.dataset.headingId
        );

        allHeadingIds.forEach(headingId => {
            if (this.viewedState[headingId]) {
                this.collapseSection(headingId);
            } else {
                this.expandSection(headingId);
            }
        });

        this.updateTocHighlights();
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

    // ============================================================
    // Phase 3: Toolbar and Batch Operations
    // ============================================================

    createToolbar() {
        // Find first H1 element in markdown-body
        const h1 = document.querySelector('.markdown-body h1');
        if (!h1) return; // No H1, don't create toolbar

        // Create toolbar element
        const toolbar = document.createElement('div');
        toolbar.className = 'viewed-toolbar';
        toolbar.innerHTML = `
            <span class="viewed-toolbar-label">Viewed:</span>
            <a class="btn-jump-next">Jump to Next</a>
            <span class="viewed-toolbar-separator">|</span>
            <a class="btn-expand-all">Expand All</a>
            <span class="viewed-toolbar-separator">|</span>
            <a class="btn-collapse-all">Collapse All</a>
            <span class="viewed-toolbar-separator">|</span>
            <a class="btn-clear-viewed">Clear</a>
        `;

        // Insert after H1
        h1.parentNode.insertBefore(toolbar, h1.nextSibling);

        // Setup toolbar link listeners
        toolbar.querySelector('.btn-jump-next').addEventListener('click', () => this.jumpToNext());
        toolbar.querySelector('.btn-expand-all').addEventListener('click', () => this.expandAll());
        toolbar.querySelector('.btn-collapse-all').addEventListener('click', () => this.collapseAll());
        toolbar.querySelector('.btn-clear-viewed').addEventListener('click', () => this.clearViewed());
    }

    jumpToNext() {
        // Find first unviewed section
        const allHeadings = Array.from(
            document.querySelectorAll('.markdown-body h2, .markdown-body h3, .markdown-body h4, .markdown-body h5, .markdown-body h6')
        );

        for (const heading of allHeadings) {
            if (!this.viewedState[heading.id]) {
                // Found first unviewed section
                window.scrollTo({
                    top: heading.offsetTop - 20,
                    behavior: 'smooth'
                });
                heading.style.transition = 'background-color 0.5s';
                heading.style.backgroundColor = 'rgba(9, 105, 218, 0.15)';
                setTimeout(() => {
                    heading.style.backgroundColor = '';
                }, 1500);
                return;
            }
        }

        // All sections viewed
        alert('✅ All sections have been viewed!');
    }

    expandAll() {
        // Uncheck all checkboxes and expand all sections
        const allHeadingIds = Array.from(document.querySelectorAll('.viewed-checkbox')).map(
            cb => cb.dataset.headingId
        );

        allHeadingIds.forEach(headingId => {
            this.viewedState[headingId] = false;
            this.expandSection(headingId);
        });

        this.updateCheckboxes();
        this.updateTocHighlights();
        this.saveState();
    }

    collapseAll() {
        // Check all checkboxes and collapse all sections
        const allHeadingIds = Array.from(document.querySelectorAll('.viewed-checkbox')).map(
            cb => cb.dataset.headingId
        );

        allHeadingIds.forEach(headingId => {
            this.viewedState[headingId] = true;
            this.collapseSection(headingId);
        });

        this.updateCheckboxes();
        this.updateTocHighlights();
        this.saveState();
    }

    clearViewed() {
        if (!confirm('Clear all viewed state for this page?')) {
            return;
        }

        // Clear all viewed state
        this.viewedState = {};

        // Update UI
        this.updateCheckboxes();
        this.applyViewedState();
        this.updateTocHighlights();
        this.saveState();
    }

    autoJumpToNext() {
        // Auto-jump on page load if there are unviewed sections
        const hasUnviewed = Array.from(
            document.querySelectorAll('.markdown-body h2, .markdown-body h3, .markdown-body h4, .markdown-body h5, .markdown-body h6')
        ).some(heading => !this.viewedState[heading.id]);

        if (hasUnviewed) {
            // Wait a bit for page to settle, then jump
            setTimeout(() => {
                this.jumpToNext();
            }, 300);
        }
    }

    // ============================================================
    // Phase 3: TOC Highlighting
    // ============================================================

    updateTocHighlights() {
        // Update TOC items based on viewed state
        const tocItems = document.querySelectorAll('.toc-item');

        tocItems.forEach(item => {
            const link = item.querySelector('a');
            if (!link) return;

            const href = link.getAttribute('href');
            if (!href || !href.startsWith('#')) return;

            const headingId = href.substring(1);

            if (this.viewedState[headingId]) {
                item.classList.add('viewed');
            } else {
                item.classList.remove('viewed');
            }
        });
    }
}

// Initialize when document is ready
function initViewedFeature() {
    // Only initialize if we're viewing a markdown file (not directory listing)
    if (document.querySelector('.markdown-body')) {
        // Check if we're in shared annotation mode
        const isSharedMode = window.isSharedAnnotationMode || false;
        const ws = window.ws || null;

        // eslint-disable-next-line no-new
        new SectionViewedManager(isSharedMode, ws);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initViewedFeature);
} else {
    initViewedFeature();
}
