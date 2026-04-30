/**
 * Section Viewed Feature
 *
 * Adds GitHub PR-style "Viewed" checkboxes to section headings.
 *  - Collapse / expand sections
 *  - Persist state to LocalStorage (local mode) or SQLite (shared mode)
 *  - Click collapsed heading to expand
 *  - Phase 3: Batch operations + TOC highlighting
 *
 * This module is bundled in IIFE format. Type imports below are erased at
 * compile time, so the bundled file remains import-free.
 */

const _t = (window.__MARKON_I18N__ && window.__MARKON_I18N__.t) || ((k: string): string => k);

/** Map of `headingId → viewed?`. */
type ViewedState = Record<string, boolean>;

/**
 * SectionViewedManager — owns viewed checkboxes, collapsed sections, the
 * "All Viewed" toolbar and the (optional) shared-mode WebSocket sync.
 */
export class SectionViewedManager {
    isSharedMode: boolean;
    ws: WebSocket | null;
    filePath: string;
    viewedState: ViewedState;
    /** Section IDs that are temporarily expanded despite being viewed. */
    tempExpandedState: Record<string, boolean>;
    stateLoaded: boolean;
    enableViewed: boolean;
    allViewedCheckbox: HTMLInputElement | null;
    updatingAllViewedCheckbox: boolean;

    /** Latest WS handler — kept so we can detach it before re-attaching. */
    private _wsMessageHandler: ((event: MessageEvent) => void) | null;
    /** Resolves once the constructor-spawned `init()` has finished — handy for tests. */
    readonly ready: Promise<void>;

    constructor(isSharedMode: boolean, ws: WebSocket | null) {
        this.isSharedMode = isSharedMode;
        this.ws = ws;
        // Use meta file-path to ensure consistency with annotation manager
        const filePathMeta = document.querySelector('meta[name="file-path"]');
        this.filePath = filePathMeta ? filePathMeta.getAttribute('content') ?? window.location.pathname : window.location.pathname;
        this.viewedState = {};
        this.tempExpandedState = {};
        this.stateLoaded = false;
        this.allViewedCheckbox = null;
        this.updatingAllViewedCheckbox = false;
        this._wsMessageHandler = null;

        // Check if viewed feature is enabled
        const enableViewedMeta = document.querySelector('meta[name="enable-viewed"]');
        this.enableViewed = enableViewedMeta ? enableViewedMeta.getAttribute('content') === 'true' : true;

        if (this.isSharedMode && this.ws) {
            this.setupWebSocketListeners();
        }

        this.ready = this.init();
    }

    async init(): Promise<void> {
        // 1. Load saved state (async for shared mode) — only if viewed is enabled.
        if (this.enableViewed) {
            await this.loadState();
        }

        // 2. Inject action buttons to all headings (h2-h6)
        this.injectCheckboxes();

        // 3. Toolbar — only if viewed is enabled.
        if (this.enableViewed) {
            this.createToolbar();
        }

        // 4. Apply saved viewed state — only if viewed is enabled.
        if (this.enableViewed) {
            this.applyViewedState();
        }

        // 5. Setup event listeners
        this.setupEventListeners();
    }

    setupWebSocketListeners(): void {
        if (!this.ws) return;

        if (this._wsMessageHandler) {
            this.ws.removeEventListener('message', this._wsMessageHandler);
        }
        this._wsMessageHandler = (event: MessageEvent): void => {
            try {
                const data = JSON.parse(event.data as string) as { type?: string; state?: ViewedState };
                if (data.type !== 'viewed_state') return;

                this.viewedState = data.state ?? {};
                this.stateLoaded = true;

                if (document.querySelector('.viewed-checkbox')) {
                    this.updateCheckboxes();
                    this.applyViewedState();
                }
            } catch {
                // Not a viewed message, ignore
            }
        };
        this.ws.addEventListener('message', this._wsMessageHandler);
    }

    updateCheckboxes(): void {
        const checkboxes = document.querySelectorAll<HTMLInputElement>('.viewed-checkbox');
        checkboxes.forEach((checkbox) => {
            const headingId = checkbox.dataset.headingId;
            if (headingId) {
                checkbox.checked = !!this.viewedState[headingId];
            }
        });
    }

    injectCheckboxes(): void {
        // Only add checkboxes to h2-h6, not h1 (usually the document title).
        const headings = document.querySelectorAll<HTMLElement>(
            '.markdown-body h2, .markdown-body h3, .markdown-body h4, .markdown-body h5, .markdown-body h6',
        );

        headings.forEach((heading, index) => {
            if (!heading.id) {
                heading.id = `heading-${index}`;
            }

            const headingId = heading.id;

            const actions: { type: string; create: () => HTMLElement }[] = [];

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
                    },
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
                },
            });

            // 3. Expand/collapse toggle (always enabled)
            actions.push({
                type: 'toggle',
                create: () => {
                    const toggleBtn = document.createElement('span');
                    toggleBtn.className = 'section-action section-expand-toggle';
                    // Default: section is expanded → label is "Collapse".
                    toggleBtn.textContent = _t('web.viewed.collapse');
                    toggleBtn.dataset.headingId = headingId;
                    return toggleBtn;
                },
            });

            actions.forEach((action, idx) => {
                if (idx > 0) {
                    const separator = document.createElement('span');
                    separator.className = 'section-action-separator';
                    separator.textContent = ' | ';
                    heading.appendChild(separator);
                }

                const element = action.create();
                heading.appendChild(element);
            });
        });
    }

    getSectionContent(heading: HTMLElement): HTMLElement[] {
        // All siblings after this heading until the next same/higher-level heading.
        const level = parseInt(heading.tagName.substring(1)); // h2 -> 2
        const elements: HTMLElement[] = [];
        let next = heading.nextElementSibling as HTMLElement | null;

        while (next) {
            const tagName = next.tagName;
            if (tagName && /^H[1-6]$/.test(tagName)) {
                const nextLevel = parseInt(tagName.substring(1));
                if (nextLevel <= level) {
                    break;
                }
            }
            elements.push(next);
            next = next.nextElementSibling as HTMLElement | null;
        }

        return elements;
    }

    collapseSection(headingId: string): void {
        const heading = document.getElementById(headingId);
        if (!heading) return;

        const content = this.getSectionContent(heading);

        heading.classList.add('section-collapsed');
        content.forEach((el) => {
            el.classList.add('section-content-hidden');
            el.classList.remove('section-content-temp-visible');
        });

        this.ensureCollapsedPlaceholder(heading, headingId);
    }

    ensureCollapsedPlaceholder(heading: HTMLElement, headingId: string): void {
        // Insert a clickable placeholder right after the collapsed heading so
        // the section doesn't look like an empty gap.
        const next = heading.nextElementSibling;
        if (next && next.classList && next.classList.contains('section-collapsed-placeholder')) {
            return;
        }
        const placeholder = document.createElement('div');
        placeholder.className = 'section-collapsed-placeholder';
        placeholder.dataset.headingId = headingId;
        placeholder.textContent = _t('web.viewed.collapsed.hint');
        placeholder.addEventListener('click', () => this.toggleTempExpand(headingId));
        heading.insertAdjacentElement('afterend', placeholder);
    }

    removeCollapsedPlaceholder(heading: HTMLElement): void {
        const next = heading.nextElementSibling;
        if (next && next.classList && next.classList.contains('section-collapsed-placeholder')) {
            next.remove();
        }
    }

    expandSection(headingId: string): void {
        const heading = document.getElementById(headingId);
        if (!heading) return;

        const content = this.getSectionContent(heading);

        heading.classList.remove('section-collapsed');
        this.removeCollapsedPlaceholder(heading);

        // Make sure elements start hidden so the transition fires.
        content.forEach((el) => {
            if (!el.classList.contains('section-content-hidden')) {
                el.classList.add('section-content-hidden');
            }
        });

        // Force reflow.
        content.forEach((el) => void el.offsetHeight);

        // Trigger expand animation.
        requestAnimationFrame(() => {
            content.forEach((el) => {
                el.classList.remove('section-content-hidden');
                el.classList.add('section-content-temp-visible');

                const cleanup = (e: TransitionEvent): void => {
                    if (e.target === el && e.propertyName === 'opacity') {
                        el.classList.remove('section-content-temp-visible');
                        el.removeEventListener('transitionend', cleanup);
                    }
                };
                el.addEventListener('transitionend', cleanup);
            });
        });

        delete this.tempExpandedState[headingId];
        heading.classList.remove('section-temp-expanded');
    }

    toggleTempExpand(headingId: string): void {
        const heading = document.getElementById(headingId);
        if (!heading) return;

        const content = this.getSectionContent(heading);
        const toggleBtn = heading.querySelector<HTMLElement>('.section-expand-toggle');
        const isCollapsed = heading.classList.contains('section-collapsed');

        if (isCollapsed) {
            heading.classList.remove('section-collapsed');
            this.removeCollapsedPlaceholder(heading);
            content.forEach((el) => {
                el.classList.remove('section-content-hidden');
                el.classList.add('section-content-temp-visible');
            });
            if (toggleBtn) {
                toggleBtn.textContent = _t('web.viewed.collapse');
            }
            this.tempExpandedState[headingId] = false;
        } else {
            heading.classList.add('section-collapsed');
            content.forEach((el) => {
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

    async printSection(headingId: string): Promise<void> {
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

        if (isMobile) {
            return this.printSectionInNewWindow(headingId);
        }

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

        // Build a cloned container for the target section.
        const sectionContainer = document.createElement('div');
        sectionContainer.className = 'markdown-body';

        const headingClone = heading.cloneNode(true) as HTMLElement;
        headingClone
            .querySelectorAll('.viewed-checkbox-label, .section-action-separator, .section-print-btn, .section-expand-toggle')
            .forEach((el) => el.remove());
        sectionContainer.appendChild(headingClone);

        content.forEach((el) => {
            const clone = el.cloneNode(true);
            sectionContainer.appendChild(clone);
        });

        // Hidden iframe as isolated print sandbox; A4 dims for iPad Safari layout.
        const iframe = document.createElement('iframe');
        iframe.style.position = 'fixed';
        iframe.style.left = '-9999px';
        iframe.style.top = '0';
        iframe.style.width = '21cm';
        iframe.style.height = '29.7cm';
        iframe.style.border = '0';
        iframe.style.opacity = '0';
        iframe.style.pointerEvents = 'none';
        document.body.appendChild(iframe);

        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        const themeCss = prefersDark ? '/_/css/github-markdown-dark.css' : '/_/css/github-markdown-light.css';

        const doc = iframe.contentDocument;
        if (!doc) {
            console.warn('[ViewedManager] printSection: iframe contentDocument unavailable');
            return;
        }
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

        // Wait a tick to ensure iframe is ready.
        await new Promise<void>((r) => setTimeout(r, 0));

        const root = doc.getElementById('root');
        if (root) {
            root.appendChild(doc.importNode(sectionContainer, true));
        }

        const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

        await new Promise<number>(requestAnimationFrame);
        await new Promise<number>(requestAnimationFrame);

        // Normalize Mermaid/SVG sizing in iframe.
        const normalizeIframeSVGs = (): void => {
            const svgs = Array.from(doc.querySelectorAll<SVGElement>('.mermaid svg, svg'));
            svgs.forEach((svg) => {
                try {
                    svg.removeAttribute('width');
                    svg.removeAttribute('height');
                    svg.style.width = '100%';
                    svg.style.height = 'auto';
                    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
                } catch {
                    // ignore
                }
            });
        };
        normalizeIframeSVGs();

        // Resource-load timeout — Safari needs to stay in the user-gesture context.
        const resourceTimeout = isSafari ? 100 : 2000;

        const waitForImages = async (): Promise<void> => {
            const imgs = Array.from(doc.images || []);
            const imagePromises = imgs.map((img) => {
                if (img.complete && img.naturalWidth > 0) return Promise.resolve();
                return new Promise<void>((res) => {
                    img.onload = img.onerror = (): void => res();
                    setTimeout(() => res(), resourceTimeout);
                });
            });
            await Promise.all(imagePromises);
        };
        await waitForImages();

        if (doc.fonts && doc.fonts.ready) {
            try {
                await Promise.race([doc.fonts.ready, new Promise<void>((res) => setTimeout(res, resourceTimeout))]);
            } catch {
                // ignore
            }
        }

        const waitForStylesheets = async (): Promise<void> => {
            const links = Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'));
            await Promise.all(
                links.map((link) => {
                    if (link.sheet) return Promise.resolve();
                    return new Promise<void>((res) => {
                        link.onload = (): void => res();
                        link.onerror = (): void => res();
                        setTimeout(() => res(), resourceTimeout);
                    });
                }),
            );
        };
        await waitForStylesheets();

        const finalDelay = isSafari ? 50 : 300;
        await new Promise<void>((res) => setTimeout(res, finalDelay));

        let cleanupDone = false;
        const cleanupIframe = (): void => {
            if (cleanupDone) return;
            cleanupDone = true;
            try {
                if (iframe.parentNode) {
                    iframe.parentNode.removeChild(iframe);
                }
            } catch {
                // ignore
            }
            console.log('[ViewedManager] printSection: iframe cleaned up');
        };

        const iframeWindow = iframe.contentWindow;
        if (iframeWindow) {
            iframeWindow.addEventListener('afterprint', cleanupIframe, { once: true });
        }

        const fallbackCleanup = setTimeout(cleanupIframe, 30000);

        try {
            iframeWindow?.focus();
            iframeWindow?.print();
            console.log('[ViewedManager] printSection: print dialog opened for section', headingId);
        } catch (error) {
            console.warn('[ViewedManager] printSection: print blocked or failed', error);
            clearTimeout(fallbackCleanup);

            const retry = confirm(_t('web.viewed.print.blocked'));
            if (retry) {
                try {
                    iframeWindow?.print();
                } catch {
                    alert(_t('web.viewed.print.allow'));
                }
            }
            setTimeout(cleanupIframe, 500);
        }
    }

    async printSectionInNewWindow(headingId: string): Promise<void> {
        // Mobile path: open the window FIRST in user-gesture context (Safari blocker).
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

        // STEP 1: open blank window synchronously inside the user gesture.
        const printWindow = window.open('about:blank', '_blank');

        if (!printWindow) {
            alert(_t('web.viewed.print.popup'));
            return;
        }

        printWindow.document.write(
            `<html><head><title>Loading...</title></head><body style="font-family: system-ui; padding: 40px; text-align: center;"><h2>${_t('web.viewed.print.preparing')}</h2></body></html>`,
        );

        // STEP 2: prepare content (async OK — window is already open).
        const headingClone = heading.cloneNode(true) as HTMLElement;
        headingClone
            .querySelectorAll('.viewed-checkbox-label, .section-action-separator, .section-print-btn, .section-expand-toggle, .section-action')
            .forEach((el) => el.remove());

        const contentClones = content.map((el) => el.cloneNode(true) as HTMLElement);

        const contentHTML = [headingClone, ...contentClones].map((el) => el.outerHTML).join('\n');

        // STEP 3: fetch + inline CSS.
        const styles = await this.fetchPrintStyles();

        // STEP 4: assemble HTML.
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

        // STEP 5: write into the open window.
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

    async fetchPrintStyles(): Promise<string> {
        const cssFiles = ['/_/css/github-markdown-light.css', '/_/css/github-print.css'];

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
            }),
        );

        return cssContents.join('\n\n');
    }

    toggleCollapse(headingId: string): void {
        // Plain collapse/expand toggle, ignores viewed state.
        const heading = document.getElementById(headingId);
        if (!heading) return;

        const content = this.getSectionContent(heading);
        const isCollapsed = heading.classList.contains('section-collapsed');

        if (isCollapsed) {
            heading.classList.remove('section-collapsed');
            this.removeCollapsedPlaceholder(heading);
            content.forEach((el) => {
                el.classList.remove('section-content-hidden');
                el.classList.add('section-content-temp-visible');
            });
        } else {
            heading.classList.add('section-collapsed');
            content.forEach((el) => {
                el.classList.add('section-content-hidden');
                el.classList.remove('section-content-temp-visible');
            });
            this.ensureCollapsedPlaceholder(heading, headingId);
        }
    }

    toggleViewed(headingId: string, isViewed: boolean): void {
        this.viewedState[headingId] = isViewed;

        if (isViewed) {
            this.collapseSection(headingId);

            // Drop temp-expand state when marking as viewed.
            delete this.tempExpandedState[headingId];
            const heading = document.getElementById(headingId);
            if (heading) {
                heading.classList.remove('section-temp-expanded');
                const content = this.getSectionContent(heading);
                content.forEach((el) => {
                    el.classList.remove('section-content-temp-visible');
                });
            }
        } else {
            this.expandSection(headingId);
        }

        this.updateCheckboxes();
        this.updateTocHighlights();
        this.saveState();

        this.updateAllViewedCheckbox();
    }

    updateAllViewedCheckbox(): void {
        if (!this.allViewedCheckbox) return;

        const allHeadingIds = Array.from(document.querySelectorAll<HTMLInputElement>('.viewed-checkbox'))
            .filter((cb) => cb.dataset.headingId)
            .map((cb) => cb.dataset.headingId as string);

        const allViewed = allHeadingIds.length > 0 && allHeadingIds.every((id) => this.viewedState[id]);

        // Recursion guard.
        this.updatingAllViewedCheckbox = true;
        this.allViewedCheckbox.checked = allViewed;
        this.updatingAllViewedCheckbox = false;
    }

    async loadState(): Promise<void> {
        if (this.isSharedMode) {
            // Shared mode: state arrives via WebSocket.
            return new Promise<void>((resolve) => {
                if (this.stateLoaded) {
                    resolve();
                    return;
                }

                const timeout = setTimeout(() => {
                    // Fall back to empty state after 500ms.
                    this.viewedState = {};
                    this.stateLoaded = true;
                    resolve();
                }, 500);

                const checkInterval = setInterval(() => {
                    if (this.stateLoaded) {
                        clearTimeout(timeout);
                        clearInterval(checkInterval);
                        resolve();
                    }
                }, 50);
            });
        }
        // Local mode: LocalStorage.
        const key = `markon-viewed-${this.filePath}`;
        const saved = localStorage.getItem(key);
        this.viewedState = saved ? (JSON.parse(saved) as ViewedState) : {};
        this.stateLoaded = true;
    }

    saveState(): void {
        if (this.isSharedMode && this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(
                JSON.stringify({
                    type: 'update_viewed_state',
                    state: this.viewedState,
                }),
            );
        } else if (!this.isSharedMode) {
            const key = `markon-viewed-${this.filePath}`;
            localStorage.setItem(key, JSON.stringify(this.viewedState));
        } else {
            console.warn('[ViewedManager] Cannot save state - shared mode but no WebSocket connection');
        }
    }

    applyViewedState(): void {
        const allHeadingIds = Array.from(document.querySelectorAll<HTMLInputElement>('.viewed-checkbox'))
            .map((cb) => cb.dataset.headingId)
            .filter((id): id is string => Boolean(id));

        allHeadingIds.forEach((headingId) => {
            if (this.viewedState[headingId]) {
                this.collapseSection(headingId);
            } else {
                this.expandSection(headingId);
            }
        });

        this.updateTocHighlights();
        this.updateAllViewedCheckbox();
    }

    setupEventListeners(): void {
        // Checkbox change.
        document.querySelectorAll<HTMLInputElement>('.viewed-checkbox').forEach((checkbox) => {
            checkbox.addEventListener('change', (e) => {
                const target = e.target as HTMLInputElement;
                const headingId = target.dataset.headingId;
                if (!headingId) return;
                this.toggleViewed(headingId, target.checked);
            });
        });

        // Toggle button click — independent of viewed state.
        document.querySelectorAll<HTMLElement>('.section-expand-toggle').forEach((toggleBtn) => {
            toggleBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const target = e.target as HTMLElement;
                const headingId = target.dataset.headingId;
                if (!headingId) return;
                this.toggleTempExpand(headingId);
            });
        });

        // Print button click.
        document.querySelectorAll<HTMLElement>('.section-print-btn').forEach((printBtn) => {
            printBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const target = e.target as HTMLElement;
                const headingId = target.dataset.headingId;
                if (!headingId) return;
                void this.printSection(headingId);
            });
        });
    }

    // ============================================================
    // Phase 3: Toolbar and Batch Operations
    // ============================================================

    createToolbar(): void {
        const h1 = document.querySelector<HTMLElement>('.markdown-body h1');
        if (!h1) return;

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

        // Toolbar with collapse/expand/print links.
        const toolbar = document.createElement('span');
        toolbar.className = 'viewed-toolbar';
        toolbar.innerHTML = `
            <a class="btn-collapse-all">${_t('web.viewed.collapseall')}</a>
            <span class="viewed-toolbar-separator">|</span>
            <a class="btn-expand-all">${_t('web.viewed.expandall')}</a>
            <span class="viewed-toolbar-separator">|</span>
            <a class="btn-print-page">${_t('web.viewed.print')}</a>
        `;

        h1.appendChild(toolbar);

        this.allViewedCheckbox = checkbox;
        this.updatingAllViewedCheckbox = false;

        checkbox.addEventListener('change', (e) => {
            // Recursion guard for programmatic updates.
            if (this.updatingAllViewedCheckbox) return;

            const target = e.target as HTMLInputElement;
            if (target.checked) {
                this.markAllViewed();
            } else {
                this.markAllUnviewed();
            }
        });

        toolbar.querySelector<HTMLElement>('.btn-collapse-all')?.addEventListener('click', () => this.collapseAll());
        toolbar.querySelector<HTMLElement>('.btn-expand-all')?.addEventListener('click', () => this.expandAll());
        toolbar.querySelector<HTMLElement>('.btn-print-page')?.addEventListener('click', () => {
            console.log('[ViewedManager] Printing full page');
            window.print();
        });
    }

    markAllViewed(): void {
        const allHeadingIds = Array.from(document.querySelectorAll<HTMLInputElement>('.viewed-checkbox'))
            .filter((cb) => cb.dataset.headingId)
            .map((cb) => cb.dataset.headingId as string);

        allHeadingIds.forEach((headingId) => {
            this.viewedState[headingId] = true;
            this.collapseSection(headingId);
        });

        this.updateCheckboxes();
        this.updateTocHighlights();
        this.saveState();

        if (this.allViewedCheckbox) {
            this.updatingAllViewedCheckbox = true;
            this.allViewedCheckbox.checked = true;
            this.updatingAllViewedCheckbox = false;
        }
    }

    markAllUnviewed(): void {
        this.viewedState = {};

        this.updateCheckboxes();
        this.applyViewedState();
        this.updateTocHighlights();
        this.saveState();

        if (this.allViewedCheckbox) {
            this.updatingAllViewedCheckbox = true;
            this.allViewedCheckbox.checked = false;
            this.updatingAllViewedCheckbox = false;
        }
    }

    collapseAll(): void {
        // Process h6 → h2 to handle nested sections correctly.
        const allHeadings = document.querySelectorAll<HTMLElement>(
            '.markdown-body h2, .markdown-body h3, .markdown-body h4, .markdown-body h5, .markdown-body h6',
        );
        const headingsArray = Array.from(allHeadings);

        headingsArray.sort((a, b) => {
            const levelA = parseInt(a.tagName.substring(1));
            const levelB = parseInt(b.tagName.substring(1));
            return levelB - levelA;
        });

        headingsArray.forEach((heading) => {
            if (heading.id) {
                this.collapseSection(heading.id);
            }
        });
    }

    expandAll(): void {
        // Process h2 → h6 to handle nested sections correctly.
        const allHeadings = document.querySelectorAll<HTMLElement>(
            '.markdown-body h2, .markdown-body h3, .markdown-body h4, .markdown-body h5, .markdown-body h6',
        );
        const headingsArray = Array.from(allHeadings);

        headingsArray.sort((a, b) => {
            const levelA = parseInt(a.tagName.substring(1));
            const levelB = parseInt(b.tagName.substring(1));
            return levelA - levelB;
        });

        headingsArray.forEach((heading) => {
            if (heading.id) {
                this.expandSection(heading.id);
            }
        });
    }

    // ============================================================
    // Phase 3: TOC Highlighting
    // ============================================================

    updateTocHighlights(): void {
        const tocItems = document.querySelectorAll<HTMLElement>('.toc-item');

        tocItems.forEach((item) => {
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

// ── IIFE entry point ──────────────────────────────────────────────────────
// esbuild output is `format: 'iife'`, so the `export class` above is wrapped
// and the module body runs once at load time. We mount on `window` for
// cross-module access (main.ts reads `window.viewedManager`).

function initViewedFeature(): void {
    if (document.querySelector('.markdown-body')) {
        const isSharedMode = window.isSharedAnnotationMode || false;
        const ws = window.ws ?? null;

        window.viewedManager = new SectionViewedManager(isSharedMode, ws);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initViewedFeature);
} else {
    initViewedFeature();
}
