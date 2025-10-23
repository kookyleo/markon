/**
 * Section Viewed Feature
 * Adds GitHub PR-style "Viewed" checkboxes to section headings
 * - Collapse/expand sections
 * - Persist state to LocalStorage (local mode) or SQLite (shared mode)
 * - Click collapsed heading to expand
 * - Phase 3: Batch operations, TOC highlighting
 */

class SectionViewedManager {
    constructor(isSharedMode, ws) {
        this.isSharedMode = isSharedMode;
        this.ws = ws;
        // Use meta file-path to ensure consistency with annotation manager
        const filePathMeta = document.querySelector('meta[name="file-path"]');
        this.filePath = filePathMeta ? filePathMeta.getAttribute('content') : window.location.pathname;
        this.viewedState = {};
        this.tempExpandedState = {}; // Track temporarily expanded sections (viewed but expanded)
        this.stateLoaded = false;

        // Check if viewed feature is enabled
        const enableViewedMeta = document.querySelector('meta[name="enable-viewed"]');
        this.enableViewed = enableViewedMeta ? enableViewedMeta.getAttribute('content') === 'true' : true;

        if (this.isSharedMode && this.ws) {
            this.setupWebSocketListeners();
        }

        this.init();
    }

    async init() {
        // 1. Load saved state (async for shared mode) - only if viewed is enabled
        if (this.enableViewed) {
            await this.loadState();
        }

        // 2. Inject action buttons to all headings (h2-h6)
        this.injectCheckboxes();

        // 3. Create toolbar for batch operations - only if viewed is enabled
        if (this.enableViewed) {
            this.createToolbar();
        }

        // 4. Apply saved viewed state - only if viewed is enabled
        if (this.enableViewed) {
            this.applyViewedState();
        }

        // 5. Setup event listeners
        this.setupEventListeners();
    }

    setupWebSocketListeners() {
        if (!this.ws) return;

        // Listen for viewed state updates from other clients
        this.ws.addEventListener('message', (event) => {
            try {
                const data = JSON.parse(event.data);

                if (data.type === 'viewed_state') {
                    // Received viewed state from server (initial load or update from other client)
                    console.log('[ViewedManager] Received viewed_state:', JSON.stringify(data.state), 'keys:', Object.keys(data.state || {}).length);
                    this.viewedState = data.state || {};
                    this.stateLoaded = true;

                    // If checkboxes are already injected, update their state
                    if (document.querySelector('.viewed-checkbox')) {
                        console.log('[ViewedManager] Updating checkboxes and applying state');
                        this.updateCheckboxes();
                        this.applyViewedState();
                    } else {
                        console.log('[ViewedManager] No checkboxes found yet');
                    }
                }
            } catch (e) {
                // Not a viewed message, ignore
            }
        });
    }

    updateCheckboxes() {
        // Update checkbox states based on viewedState
        const checkboxes = document.querySelectorAll('.viewed-checkbox');
        console.log('[ViewedManager] updateCheckboxes: found', checkboxes.length, 'checkboxes, viewedState keys:', Object.keys(this.viewedState).length);

        let uncheckedCount = 0;
        checkboxes.forEach(checkbox => {
            const headingId = checkbox.dataset.headingId;
            const shouldBeChecked = !!this.viewedState[headingId];
            if (!shouldBeChecked) uncheckedCount++;
            checkbox.checked = shouldBeChecked;
        });

        console.log('[ViewedManager] updateCheckboxes: unchecked', uncheckedCount, 'checkboxes');
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

            // Define available section actions (features)
            const actions = [];

            // 1. Viewed feature (optional, controlled by config)
            if (this.enableViewed) {
                actions.push({
                    type: 'viewed',
                    create: () => {
                        const label = document.createElement('label');
                        label.className = 'viewed-checkbox-label';
                        label.title = 'Mark as viewed to collapse this section';

                        const checkbox = document.createElement('input');
                        checkbox.type = 'checkbox';
                        checkbox.className = 'viewed-checkbox';
                        checkbox.dataset.headingId = headingId;
                        checkbox.tabIndex = -1; // Prevent keyboard navigation to checkbox

                        if (this.viewedState[headingId]) {
                            checkbox.checked = true;
                        }

                        const text = document.createElement('span');
                        text.className = 'section-action viewed-text';
                        text.textContent = 'Viewed';

                        label.appendChild(checkbox);
                        label.appendChild(text);
                        return label;
                    }
                });
            }

            // 2. Print feature (always enabled)
            actions.push({
                type: 'print',
                create: () => {
                    const printBtn = document.createElement('span');
                    printBtn.className = 'section-action section-print-btn';
                    printBtn.textContent = 'Print';
                    printBtn.title = 'Print this section';
                    printBtn.dataset.headingId = headingId;
                    return printBtn;
                }
            });

            // 3. Expand/collapse toggle (always enabled)
            actions.push({
                type: 'toggle',
                create: () => {
                    const toggleBtn = document.createElement('span');
                    toggleBtn.className = 'section-action section-expand-toggle';
                    // Default state: section is expanded, so show "Collapse"
                    toggleBtn.textContent = 'Collapse';
                    toggleBtn.dataset.headingId = headingId;
                    return toggleBtn;
                }
            });

            // Inject actions with separators
            actions.forEach((action, idx) => {
                // Add separator before action (except first one)
                if (idx > 0) {
                    const separator = document.createElement('span');
                    separator.className = 'section-action-separator';
                    separator.textContent = ' | ';
                    heading.appendChild(separator);
                }

                // Add the action element
                const element = action.create();
                heading.appendChild(element);
            });
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
            el.classList.remove('section-content-temp-visible');
        });
    }

    expandSection(headingId) {
        const heading = document.getElementById(headingId);
        if (!heading) return;

        const content = this.getSectionContent(heading);

        heading.classList.remove('section-collapsed');

        // Ensure elements start in hidden state
        content.forEach(el => {
            if (!el.classList.contains('section-content-hidden')) {
                el.classList.add('section-content-hidden');
            }
        });

        // Force reflow
        content.forEach(el => void el.offsetHeight);

        // Trigger expand animation
        requestAnimationFrame(() => {
            content.forEach(el => {
                el.classList.remove('section-content-hidden');
                el.classList.add('section-content-temp-visible');

                // Listen for animation end to clean up
                const cleanup = (e) => {
                    if (e.target === el && e.propertyName === 'opacity') {
                        el.classList.remove('section-content-temp-visible');
                        el.removeEventListener('transitionend', cleanup);
                    }
                };
                el.addEventListener('transitionend', cleanup);
            });
        });

        // Clear temporary expand state when fully expanding
        delete this.tempExpandedState[headingId];
        heading.classList.remove('section-temp-expanded');
    }

    toggleTempExpand(headingId) {
        // Toggle expand/collapse for any section
        const heading = document.getElementById(headingId);
        if (!heading) return;

        const content = this.getSectionContent(heading);
        const toggleBtn = heading.querySelector('.section-expand-toggle');
        const isCollapsed = heading.classList.contains('section-collapsed');

        if (isCollapsed) {
            // Currently collapsed -> expand it
            heading.classList.remove('section-collapsed');
            content.forEach(el => {
                el.classList.remove('section-content-hidden');
                el.classList.add('section-content-temp-visible');
            });
            if (toggleBtn) {
                toggleBtn.textContent = 'Collapse';
            }
            this.tempExpandedState[headingId] = false;
        } else {
            // Currently expanded -> collapse it
            heading.classList.add('section-collapsed');
            content.forEach(el => {
                el.classList.add('section-content-hidden');
                el.classList.remove('section-content-temp-visible');
            });
            if (toggleBtn) {
                toggleBtn.textContent = 'Expand';
            }
            this.tempExpandedState[headingId] = true;
        }
    }

    printSection(headingId) {
        // Print the specified section
        const heading = document.getElementById(headingId);
        if (!heading) {
            console.warn('[ViewedManager] printSection: heading not found:', headingId);
            return;
        }

        const content = this.getSectionContent(heading);
        if (!content || content.length === 0) {
            console.warn('[ViewedManager] printSection: no content found for heading:', headingId);
            return;
        }

        // Create a temporary container for print content
        const printContainer = document.createElement('div');
        printContainer.className = 'print-section-container';

        // Clone the heading (without controls)
        const headingClone = heading.cloneNode(true);
        // Remove interactive elements
        headingClone.querySelectorAll('.viewed-checkbox-label, .section-action-separator, .section-print-btn, .section-expand-toggle').forEach(el => el.remove());
        printContainer.appendChild(headingClone);

        // Clone the section content
        content.forEach(el => {
            const clone = el.cloneNode(true);
            printContainer.appendChild(clone);
        });

        // Add print container to document
        document.body.appendChild(printContainer);

        // Trigger print dialog
        window.print();

        // Remove print container after printing
        setTimeout(() => {
            document.body.removeChild(printContainer);
        }, 100);

        console.log('[ViewedManager] printSection: printed section', headingId);
    }

    toggleCollapse(headingId) {
        // Toggle collapse/expand for any section (regardless of viewed state)
        const heading = document.getElementById(headingId);
        if (!heading) return;

        const content = this.getSectionContent(heading);
        const isCollapsed = heading.classList.contains('section-collapsed');

        if (isCollapsed) {
            // Currently collapsed -> expand
            heading.classList.remove('section-collapsed');
            content.forEach(el => {
                el.classList.remove('section-content-hidden');
                el.classList.add('section-content-temp-visible');
            });
        } else {
            // Currently expanded -> collapse
            heading.classList.add('section-collapsed');
            content.forEach(el => {
                el.classList.add('section-content-hidden');
                el.classList.remove('section-content-temp-visible');
            });
        }
    }

    toggleViewed(headingId, isViewed) {
        this.viewedState[headingId] = isViewed;

        if (isViewed) {
            this.collapseSection(headingId);

            // Clear temporary expand state when marking as viewed
            delete this.tempExpandedState[headingId];
            const heading = document.getElementById(headingId);
            if (heading) {
                heading.classList.remove('section-temp-expanded');
                const content = this.getSectionContent(heading);
                content.forEach(el => {
                    el.classList.remove('section-content-temp-visible');
                });
            }
        } else {
            this.expandSection(headingId);
        }

        // No cascading - only toggle the selected heading
        this.updateCheckboxes();
        this.updateTocHighlights();
        this.saveState();

        // Update "All Viewed" checkbox state
        this.updateAllViewedCheckbox();
    }

    updateAllViewedCheckbox() {
        // Check if all sections are viewed
        if (!this.allViewedCheckbox) return;

        const allHeadingIds = Array.from(document.querySelectorAll('.viewed-checkbox'))
            .filter(cb => cb.dataset.headingId)
            .map(cb => cb.dataset.headingId);

        const allViewed = allHeadingIds.length > 0 && allHeadingIds.every(id => this.viewedState[id]);

        // Set flag to prevent recursion
        this.updatingAllViewedCheckbox = true;
        this.allViewedCheckbox.checked = allViewed;
        this.updatingAllViewedCheckbox = false;
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
        console.log('[ViewedManager] saveState called:', {
            isSharedMode: this.isSharedMode,
            hasWs: !!this.ws,
            wsState: this.ws?.readyState,
            stateKeys: Object.keys(this.viewedState).length
        });

        if (this.isSharedMode && this.ws && this.ws.readyState === WebSocket.OPEN) {
            // Shared mode: send to server via WebSocket
            console.log('[ViewedManager] Sending viewed state to server:', this.viewedState);
            this.ws.send(JSON.stringify({
                type: 'update_viewed_state',
                state: this.viewedState
            }));
        } else if (!this.isSharedMode) {
            // Local mode: save to LocalStorage
            const key = `markon-viewed-${this.filePath}`;
            localStorage.setItem(key, JSON.stringify(this.viewedState));
            console.log('[ViewedManager] Saved to localStorage:', key);
        } else {
            console.warn('[ViewedManager] Cannot save state - shared mode but no WebSocket connection');
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
        this.updateAllViewedCheckbox();
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

        // Toggle button click event (independent of viewed state)
        document.querySelectorAll('.section-expand-toggle').forEach(toggleBtn => {
            toggleBtn.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent event bubbling
                const headingId = e.target.dataset.headingId;
                this.toggleTempExpand(headingId);
            });
        });

        // Print button click event
        document.querySelectorAll('.section-print-btn').forEach(printBtn => {
            printBtn.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent event bubbling
                const headingId = e.target.dataset.headingId;
                this.printSection(headingId);
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

        // Create checkbox label (similar to other headings)
        const label = document.createElement('label');
        label.className = 'viewed-checkbox-label viewed-all-label';
        label.title = 'Mark all sections as viewed';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'viewed-checkbox viewed-all-checkbox';
        checkbox.tabIndex = -1;

        const text = document.createElement('span');
        text.className = 'viewed-text';
        text.textContent = 'All Viewed';

        label.appendChild(checkbox);
        label.appendChild(text);
        h1.appendChild(label);

        // Create toolbar element for collapse/expand links
        const toolbar = document.createElement('span');
        toolbar.className = 'viewed-toolbar';
        toolbar.innerHTML = `
            <a class="btn-collapse-all">Collapse All</a>
            <span class="viewed-toolbar-separator">|</span>
            <a class="btn-expand-all">Expand All</a>
        `;

        // Append to H1 (inline on the right)
        h1.appendChild(toolbar);

        // Store reference for updating
        this.allViewedCheckbox = checkbox;
        this.updatingAllViewedCheckbox = false; // Flag to prevent recursion

        // Setup checkbox listener
        checkbox.addEventListener('change', (e) => {
            // Prevent recursion when we're programmatically updating the checkbox
            if (this.updatingAllViewedCheckbox) return;

            if (e.target.checked) {
                this.markAllViewed();
            } else {
                this.markAllUnviewed();
            }
        });

        // Setup toolbar link listeners
        toolbar.querySelector('.btn-collapse-all').addEventListener('click', () => this.collapseAll());
        toolbar.querySelector('.btn-expand-all').addEventListener('click', () => this.expandAll());
    }


    markAllViewed() {
        // Check all checkboxes and collapse all sections
        const allHeadingIds = Array.from(document.querySelectorAll('.viewed-checkbox'))
            .filter(cb => cb.dataset.headingId) // Filter out the "All Viewed" checkbox
            .map(cb => cb.dataset.headingId);

        allHeadingIds.forEach(headingId => {
            this.viewedState[headingId] = true;
            this.collapseSection(headingId);
        });

        this.updateCheckboxes();
        this.updateTocHighlights();
        this.saveState();

        // Update "All Viewed" checkbox (with recursion prevention)
        if (this.allViewedCheckbox) {
            this.updatingAllViewedCheckbox = true;
            this.allViewedCheckbox.checked = true;
            this.updatingAllViewedCheckbox = false;
        }
    }

    markAllUnviewed() {
        // Clear all viewed state (uncheck all checkboxes and expand all sections)
        this.viewedState = {};

        // Update UI
        this.updateCheckboxes();
        this.applyViewedState();
        this.updateTocHighlights();
        this.saveState();

        // Update "All Viewed" checkbox (with recursion prevention)
        if (this.allViewedCheckbox) {
            this.updatingAllViewedCheckbox = true;
            this.allViewedCheckbox.checked = false;
            this.updatingAllViewedCheckbox = false;
        }
    }

    collapseAll() {
        // Collapse all sections regardless of viewed state
        // Process in reverse order (h6 -> h5 -> ... -> h2) to handle nested sections correctly
        const allHeadings = document.querySelectorAll('.markdown-body h2, .markdown-body h3, .markdown-body h4, .markdown-body h5, .markdown-body h6');
        const headingsArray = Array.from(allHeadings);

        // Sort by heading level in descending order (h6 first, h2 last)
        headingsArray.sort((a, b) => {
            const levelA = parseInt(a.tagName.substring(1));
            const levelB = parseInt(b.tagName.substring(1));
            return levelB - levelA; // Descending order
        });

        headingsArray.forEach(heading => {
            if (heading.id) {
                this.collapseSection(heading.id);
            }
        });
    }

    expandAll() {
        // Expand all sections regardless of viewed state
        // Process in order (h2 -> h3 -> ... -> h6) to handle nested sections correctly
        const allHeadings = document.querySelectorAll('.markdown-body h2, .markdown-body h3, .markdown-body h4, .markdown-body h5, .markdown-body h6');
        const headingsArray = Array.from(allHeadings);

        // Sort by heading level in ascending order (h2 first, h6 last)
        headingsArray.sort((a, b) => {
            const levelA = parseInt(a.tagName.substring(1));
            const levelB = parseInt(b.tagName.substring(1));
            return levelA - levelB; // Ascending order
        });

        headingsArray.forEach(heading => {
            if (heading.id) {
                this.expandSection(heading.id);
            }
        });
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
        window.viewedManager = new SectionViewedManager(isSharedMode, ws);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initViewedFeature);
} else {
    initViewedFeature();
}
