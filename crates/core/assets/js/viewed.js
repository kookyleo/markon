/**
 * Section Viewed Feature
 * Adds GitHub PR-style "Viewed" checkboxes to section headings
 * - Collapse/expand sections
 * - Persist state to LocalStorage (local mode) or SQLite (shared mode)
 * - Click collapsed heading to expand
 * - Phase 3: Batch operations, TOC highlighting
 */

const _t = (window.__MARKON_I18N__ && window.__MARKON_I18N__.t) || (k => k);

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
                        label.title = _t('web.viewed.mark');

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
                        text.textContent = _t('web.viewed');

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
                    printBtn.textContent = _t('web.viewed.print');
                    printBtn.title = _t('web.viewed.print.tip');
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
                    toggleBtn.textContent = _t('web.viewed.collapse');
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

        this.ensureCollapsedPlaceholder(heading, headingId);
    }

    ensureCollapsedPlaceholder(heading, headingId) {
        // Insert a clickable placeholder row right after the collapsed heading
        // so the collapsed section doesn't look like an empty gap.
        const next = heading.nextElementSibling;
        if (next && next.classList && next.classList.contains('section-collapsed-placeholder')) {
            return; // already present
        }
        const placeholder = document.createElement('div');
        placeholder.className = 'section-collapsed-placeholder';
        placeholder.dataset.headingId = headingId;
        placeholder.textContent = _t('web.viewed.collapsed.hint');
        placeholder.addEventListener('click', () => this.toggleTempExpand(headingId));
        heading.insertAdjacentElement('afterend', placeholder);
    }

    removeCollapsedPlaceholder(heading) {
        const next = heading.nextElementSibling;
        if (next && next.classList && next.classList.contains('section-collapsed-placeholder')) {
            next.remove();
        }
    }

    expandSection(headingId) {
        const heading = document.getElementById(headingId);
        if (!heading) return;

        const content = this.getSectionContent(heading);

        heading.classList.remove('section-collapsed');
        this.removeCollapsedPlaceholder(heading);

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
            this.removeCollapsedPlaceholder(heading);
            content.forEach(el => {
                el.classList.remove('section-content-hidden');
                el.classList.add('section-content-temp-visible');
            });
            if (toggleBtn) {
                toggleBtn.textContent = _t('web.viewed.collapse');
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
                toggleBtn.textContent = _t('web.viewed.expand');
            }
            this.tempExpandedState[headingId] = true;
            this.ensureCollapsedPlaceholder(heading, headingId);
        }
    }

    async printSection(headingId) {
        // Detect mobile devices
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

        // Mobile: use new window method (better compatibility than iframe)
        if (isMobile) {
            return this.printSectionInNewWindow(headingId);
        }

        // Desktop: use iframe method (existing implementation)
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

        // Build a cloned container for the target section
        const sectionContainer = document.createElement('div');
        sectionContainer.className = 'markdown-body';

        // Clone the heading (without controls)
        const headingClone = heading.cloneNode(true);
        headingClone.querySelectorAll('.viewed-checkbox-label, .section-action-separator, .section-print-btn, .section-expand-toggle').forEach(el => el.remove());
        sectionContainer.appendChild(headingClone);

        // Clone the section content
        content.forEach(el => {
            const clone = el.cloneNode(true);
            sectionContainer.appendChild(clone);
        });

        // Create a hidden iframe as isolated print sandbox
        // Use actual A4 dimensions but visually hidden for iPad Safari compatibility
        const iframe = document.createElement('iframe');
        iframe.style.position = 'fixed';
        iframe.style.left = '-9999px';  // Move off-screen instead of zero dimensions
        iframe.style.top = '0';
        iframe.style.width = '21cm';    // A4 width - gives Safari proper layout space
        iframe.style.height = '29.7cm'; // A4 height
        iframe.style.border = '0';
        iframe.style.opacity = '0';
        iframe.style.pointerEvents = 'none';
        document.body.appendChild(iframe);

        // Resolve theme for markdown CSS
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        const themeCss = prefersDark ? '/_/css/github-markdown-dark.css' : '/_/css/github-markdown-light.css';

        const doc = iframe.contentDocument;
        doc.open();
        doc.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Print Section</title>
<link rel="stylesheet" href="${themeCss}">
<link rel="stylesheet" href="/_/css/github-print.css">
<style>
  html, body { margin:0; padding:0; background: transparent !important; }
  /* Tweak page margins slightly to avoid leading blank page */
  @page { margin: 1.5cm 1.5cm 1.5cm 1.5cm; }
  .markdown-body { box-sizing: border-box; max-width: 980px; margin: 0 auto; padding: 16px; border: none; }
  /* Strip UI hierarchy boxes from print */
  .markdown-body .section,
  .markdown-body .section-box,
  .markdown-body .section-wrapper,
  .markdown-body .heading-container {
    border: none !important;
    box-shadow: none !important;
    background: transparent !important;
  }
  /* Ensure first element never forces a break */
  .markdown-body > :first-child { page-break-before: auto !important; margin-top: 0 !important; }
  /* Mermaid sizing overrides */
  .mermaid { overflow: visible !important; border: none !important; padding: 0 !important; margin: 12pt 0 !important; page-break-inside: avoid !important; }
  .mermaid svg { display: block; width: 100% !important; height: auto !important; max-width: 100% !important; }
  @media print { body { background: transparent !important; } }
</style>
</head><body><div class="markdown-body" id="root"></div></body></html>`);
        doc.close();

        // Wait a tick to ensure iframe is ready
        await new Promise(r => setTimeout(r, 0));

        // Inject the cloned section
        const root = doc.getElementById('root');
        root.appendChild(doc.importNode(sectionContainer, true));

        // Detect Safari for optimization
        const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

        // Wait two frames to let styles/layout settle more reliably
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);

        // Normalize Mermaid/SVG sizing in iframe to avoid tiny boxes or overflow
        const normalizeIframeSVGs = () => {
            const svgs = Array.from(doc.querySelectorAll('.mermaid svg, svg'));
            svgs.forEach(svg => {
                try {
                    // Remove fixed dimensions to allow CSS scaling
                    svg.removeAttribute('width');
                    svg.removeAttribute('height');
                    svg.style.width = '100%';
                    svg.style.height = 'auto';
                    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
                } catch (_) {}
            });
        };
        normalizeIframeSVGs();

        // Fix marker ids inside iframe to ensure arrows render correctly
        try { this.fixSvgMarkerIds(doc); } catch (_) {}

        // For Safari: load resources with shorter timeout to stay in user gesture context
        const resourceTimeout = isSafari ? 100 : 2000;

        // Ensure all images in iframe are loaded prior to printing
        const waitForImages = async () => {
            const imgs = Array.from(doc.images || []);
            const imagePromises = imgs.map(img => {
                if (img.complete && img.naturalWidth > 0) return Promise.resolve();
                return new Promise(res => {
                    img.onload = img.onerror = () => res();
                    setTimeout(() => res(), resourceTimeout);
                });
            });
            await Promise.all(imagePromises);
        };
        await waitForImages();

        // Ensure fonts are ready (best effort)
        if (doc.fonts && doc.fonts.ready) {
            try {
                await Promise.race([
                    doc.fonts.ready,
                    new Promise(res => setTimeout(res, resourceTimeout))
                ]);
            } catch (_) {}
        }

        // Wait for stylesheets to load (critical for iPad Safari)
        const waitForStylesheets = async () => {
            const links = Array.from(doc.querySelectorAll('link[rel="stylesheet"]'));
            await Promise.all(links.map(link => {
                if (link.sheet) return Promise.resolve();
                return new Promise(res => {
                    link.onload = () => res();
                    link.onerror = () => res(); // Continue even if CSS fails
                    setTimeout(() => res(), resourceTimeout);
                });
            }));
        };
        await waitForStylesheets();

        // Minimal delay for Safari to reduce risk of auto-print blocking
        const finalDelay = isSafari ? 50 : 300;
        await new Promise(res => setTimeout(res, finalDelay));

        // Setup cleanup handler - wait for print dialog to close
        let cleanupDone = false;
        const cleanupIframe = () => {
            if (cleanupDone) return;
            cleanupDone = true;
            try {
                if (iframe.parentNode) {
                    iframe.parentNode.removeChild(iframe);
                }
            } catch (_) {}
            console.log('[ViewedManager] printSection: iframe cleaned up');
        };

        // Listen for afterprint event (when print dialog closes)
        const iframeWindow = iframe.contentWindow;
        if (iframeWindow) {
            iframeWindow.addEventListener('afterprint', cleanupIframe, { once: true });
        }

        // Fallback cleanup after 30 seconds if afterprint doesn't fire
        const fallbackCleanup = setTimeout(cleanupIframe, 30000);

        // Try to trigger print dialog
        try {
            iframeWindow.focus();
            iframeWindow.print();
            console.log('[ViewedManager] printSection: print dialog opened for section', headingId);
        } catch (error) {
            console.warn('[ViewedManager] printSection: print blocked or failed', error);
            // Don't cleanup immediately - offer manual print option
            clearTimeout(fallbackCleanup);

            // Show manual print dialog with retry option
            const retry = confirm(_t('web.viewed.print.blocked'));
            if (retry) {
                try {
                    iframeWindow.print();
                } catch (_) {
                    alert(_t('web.viewed.print.allow'));
                }
            }
            // Cleanup after user interaction
            setTimeout(cleanupIframe, 500);
        }
    }

    async printSectionInNewWindow(headingId) {
        // New window printing method for mobile devices
        // CRITICAL: Open window FIRST in user gesture context to avoid Safari blocking

        const heading = document.getElementById(headingId);
        if (!heading) {
            console.warn('[ViewedManager] printSectionInNewWindow: heading not found:', headingId);
            return;
        }

        const content = this.getSectionContent(heading);
        if (!content || content.length === 0) {
            console.warn('[ViewedManager] printSectionInNewWindow: no content found for heading:', headingId);
            return;
        }

        // STEP 1: Open blank window immediately (synchronously in user gesture context)
        // This prevents Safari popup blocker
        const printWindow = window.open('about:blank', '_blank');

        if (!printWindow) {
            // Popup blocked
            alert(_t('web.viewed.print.popup'));
            return;
        }

        // Show loading message in new window
        printWindow.document.write(`<html><head><title>Loading...</title></head><body style="font-family: system-ui; padding: 40px; text-align: center;"><h2>${_t('web.viewed.print.preparing')}</h2></body></html>`);

        // STEP 2: Prepare content (can be async now that window is already open)
        // Clone heading and remove UI controls
        const headingClone = heading.cloneNode(true);
        headingClone.querySelectorAll('.viewed-checkbox-label, .section-action-separator, .section-print-btn, .section-expand-toggle, .section-action').forEach(el => el.remove());

        // Clone content
        const contentClones = content.map(el => el.cloneNode(true));

        // Build HTML string
        const contentHTML = [headingClone, ...contentClones].map(el => el.outerHTML).join('\n');

        // STEP 3: Fetch and inline CSS styles (async)
        const styles = await this.fetchPrintStyles();

        // STEP 4: Create complete HTML document
        const fullHTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Print Section</title>
    <style>
        /* Inlined styles */
        ${styles}

        /* Additional print-specific styles */
        body {
            margin: 0;
            padding: 20px;
            background: white;
        }
        .markdown-body {
            max-width: 980px;
            margin: 0 auto;
            background: white;
            color: black;
        }
    </style>
</head>
<body>
    <div class="markdown-body">
        ${contentHTML}
    </div>
    <script>
        // Auto-print for all devices after content loads
        window.addEventListener('load', function() {
            // Small delay to ensure styles are applied
            setTimeout(function() {
                window.print();
            }, 300);
        });
    </script>
</body>
</html>`;

        // STEP 5: Write HTML to already-open window
        try {
            printWindow.document.open();
            printWindow.document.write(fullHTML);
            printWindow.document.close();

            console.log('[ViewedManager] printSectionInNewWindow: content written to print window');

        } catch (error) {
            console.error('[ViewedManager] printSectionInNewWindow: failed to write content', error);
            printWindow.close();
            alert(_t('web.viewed.print.failed'));
        }
    }

    async fetchPrintStyles() {
        // Fetch and combine CSS files for printing
        const cssFiles = [
            '/_/css/github-markdown-light.css',  // Always use light theme for printing
            '/_/css/github-print.css'
        ];

        const cssContents = await Promise.all(
            cssFiles.map(async (file) => {
                try {
                    const response = await fetch(file);
                    if (!response.ok) {
                        console.warn(`[ViewedManager] Failed to fetch ${file}`);
                        return '';
                    }
                    return await response.text();
                } catch (error) {
                    console.warn(`[ViewedManager] Error fetching ${file}:`, error);
                    return '';
                }
            })
        );

        return cssContents.join('\n\n');
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
            this.removeCollapsedPlaceholder(heading);
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
            this.ensureCollapsedPlaceholder(heading, headingId);
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
        label.title = _t('web.viewed.all.tip');

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'viewed-checkbox viewed-all-checkbox';
        checkbox.tabIndex = -1;

        const text = document.createElement('span');
        text.className = 'viewed-text';
        text.textContent = _t('web.viewed.all');

        label.appendChild(checkbox);
        label.appendChild(text);
        h1.appendChild(label);

        // Create toolbar element for collapse/expand/print links
        const toolbar = document.createElement('span');
        toolbar.className = 'viewed-toolbar';
        toolbar.innerHTML = `
            <a class="btn-collapse-all">${_t('web.viewed.collapseall')}</a>
            <span class="viewed-toolbar-separator">|</span>
            <a class="btn-expand-all">${_t('web.viewed.expandall')}</a>
            <span class="viewed-toolbar-separator">|</span>
            <a class="btn-print-page">${_t('web.viewed.print')}</a>
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
        toolbar.querySelector('.btn-print-page').addEventListener('click', () => {
            console.log('[ViewedManager] Printing full page');
            window.print();
        });
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


        window.viewedManager = new SectionViewedManager(isSharedMode, ws);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initViewedFeature);
} else {
    initViewedFeature();
}
