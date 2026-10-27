/**
 * Section Viewed Feature
 *
 * Adds GitHub PR-style "Viewed" checkboxes to section headings.
 *  - Collapse / expand sections
 *  - Persist personal or shared progress to SQLite
 *  - Click collapsed heading to expand
 *  - Phase 3: Batch operations + TOC highlighting
 *
 * This module is bundled in IIFE format. Type imports below are erased at
 * compile time, so the bundled file remains import-free.
 */

import type { StorageManager } from './managers/storage-manager';
import type { WebSocketManager, WsHandler } from './managers/websocket-manager';

const _t = (window.__MARKON_I18N__?.t) || ((k: string): string => k);

const exportNotesLabel = (count: number): string => `${_t('web.export.label')} (${count})`;

const runtimeTheme = (): 'light' | 'dark' => {
    const resolved = window.MarkonTheme?.getResolved?.() || document.documentElement.getAttribute('data-theme');
    return resolved === 'dark' ? 'dark' : 'light';
};

const runtimeMarkdownCss = (): string => `/_/css/github-markdown-${runtimeTheme()}.css`;

/**
 * All section headings (h2-h6) inside the rendered markdown body. The
 * selector literal lives here (not in core/config.ts) by design, because
 * this IIFE bundle is import-free.
 */
const SECTION_HEADINGS_SELECTOR =
    '.markdown-body h2, .markdown-body h3, .markdown-body h4, .markdown-body h5, .markdown-body h6';

/** Section headings sorted by level — h6 first when `deepestFirst`, else h2 first. */
function sectionHeadingsByLevel(deepestFirst: boolean): HTMLElement[] {
    const headings = Array.from(document.querySelectorAll<HTMLElement>(SECTION_HEADINGS_SELECTOR));
    headings.sort((a, b) => {
        const levelA = parseInt(a.tagName.substring(1));
        const levelB = parseInt(b.tagName.substring(1));
        return deepestFirst ? levelB - levelA : levelA - levelB;
    });
    return headings;
}

const collapsedStorageKey = (filePath: string): string => `markon-collapsed-${filePath}`;

/** Map of `headingId → viewed?`. */
type ViewedState = Record<string, boolean>;
/** Map of `headingId → collapsed?`, independent from viewed state. */
type CollapsedState = Record<string, boolean>;

type RevealContentOptions = {
    animate?: boolean;
};

type NoteFocusReveal = {
    annotationId: string;
    token: string;
    headings: {
        id: string;
        wasCollapsed: boolean;
    }[];
};

/**
 * SectionViewedManager — owns viewed checkboxes, collapsed sections, the
 * "All Viewed" toolbar and the (optional) shared-mode WebSocket sync.
 */
export class SectionViewedManager {
    isSharedMode: boolean;
    ws: WebSocket | null;
    /**
     * Reconnect-aware review transport. Own commit echoes update the canonical
     * state without overriding a newer local click or independent folding.
     */
    wsManager: WebSocketManager | null;
    filePath: string;
    viewedState: ViewedState;
    collapsedState: CollapsedState;
    stateLoaded: boolean;
    enableViewed: boolean;
    allViewedCheckbox: HTMLInputElement | null;
    updatingAllViewedCheckbox: boolean;
    revealSeq: number;
    private noteFocusReveal: NoteFocusReveal | null;
    private noteFocusRevealSeq: number;
    private preserveExpansionOnNextSharedState: boolean;
    private storageManager: StorageManager | null;
    private storageReady = false;
    private confirmedState: ViewedState = {};
    private serverStateGeneration = 0;
    private inFlightOperations = new Map<string, { observed: boolean }>();
    private changeRevision = 0;
    private pendingChanges = new Map<string, { value: boolean; revision: number }>();
    private subscribedManager: WebSocketManager | null = null;
    private nativeListenerSocket: WebSocket | null = null;
    private managedStateHandler: WsHandler<'viewed_state'> | null = null;
    private expansionFrames = new Map<string, number>();

    /** Latest WS handler — kept so we can detach it before re-attaching. */
    private _wsMessageHandler: ((event: MessageEvent) => void) | null;
    /** Resolves once the constructor-spawned `init()` has finished — handy for tests. */
    readonly ready: Promise<void>;

    constructor(isSharedMode: boolean, ws: WebSocket | null) {
        this.isSharedMode = isSharedMode;
        this.ws = ws;
        this.wsManager = null;
        // Use meta file-path to ensure consistency with annotation manager
        const filePathMeta = document.querySelector('meta[name="file-path"]');
        this.filePath = filePathMeta ? filePathMeta.getAttribute('content') ?? window.location.pathname : window.location.pathname;
        this.viewedState = {};
        this.collapsedState = {};
        this.stateLoaded = false;
        this.allViewedCheckbox = null;
        this.updatingAllViewedCheckbox = false;
        this._wsMessageHandler = null;
        this.noteFocusReveal = null;
        this.noteFocusRevealSeq = 0;
        this.preserveExpansionOnNextSharedState = false;
        this.storageManager = null;

        // Progress is essential for every admitted reader. The service selects
        // their personal or shared dataset without exposing another reader's data.
        this.enableViewed = document.querySelector('meta[name="can-annotate"]')?.getAttribute('content') !== 'false';
        this.revealSeq = 0;

        if (this.isSharedMode && this.ws) {
            this.setupWebSocketListeners();
        }

        this.ready = this.init();
    }

    async init(): Promise<void> {
        this.loadCollapsedState();

        // 1. SQLite attaches immediately after MarkonApp starts. Until then,
        // viewed state is empty; browser storage is never a persistence source.
        if (this.enableViewed) {
            await this.loadState();
        }

        // 2. Inject action buttons to all headings (h2-h6)
        this.injectCheckboxes();
        this.updateExportNotesButtons();
        document.addEventListener('markon:notes-count-changed', () => this.updateExportNotesButtons());

        // 3. Page actions remain available independently of Viewed permissions.
        this.createToolbar();

        // 4. Apply saved section expansion state. Viewed state supplies the
        // default collapsed posture; explicit collapse/expand choices override it.
        this.applyViewedState();

        // 5. Setup event listeners
        this.setupEventListeners();
    }

    /** Attach SQLite without letting its initial snapshot undo early clicks. */
    async attachStorage(storage: StorageManager, wsManager: WebSocketManager | null): Promise<void> {
        await this.ready;
        this.storageManager = storage;
        this.wsManager = wsManager;
        const generation = this.serverStateGeneration;
        this.setupWebSocketListeners();
        const snapshot = await storage.loadViewedState();
        if (generation === this.serverStateGeneration) this.confirmedState = { ...snapshot };
        this.storageReady = true;
        this.stateLoaded = true;
        this.viewedState = this.withPendingChanges(this.confirmedState);
        this.updateCheckboxes();
        this.applyViewedState();
        // Clicks made before or during hydration are submitted after the loaded
        // scope is known, rather than discarded or written as an empty snapshot.
        this.saveState();
    }

    private withPendingChanges(state: ViewedState): ViewedState {
        const next = { ...state };
        this.pendingChanges.forEach(({ value }, id) => { next[id] = value; });
        return next;
    }

    private receiveViewedState: WsHandler<'viewed_state'> = (data): void => {
        const ownEcho = this.wsManager?.isOwnEcho(data.op_id) ?? false;
        if (data.op_id) {
            const operation = this.inFlightOperations.get(data.op_id);
            if (operation) operation.observed = true;
        }
        this.confirmedState = { ...(data.state ?? {}) };
        this.serverStateGeneration++;
        this.viewedState = this.withPendingChanges(this.confirmedState);
        this.stateLoaded = true;
        if (!document.querySelector('.viewed-checkbox')) return;
        this.updateCheckboxes();
        if (ownEcho || this.preserveExpansionOnNextSharedState) {
            this.preserveExpansionOnNextSharedState = false;
            this.updateTocHighlights();
            this.updateAllViewedCheckbox();
        } else {
            this.applyViewedState();
        }
    };

    setupWebSocketListeners(): void {
        // The manager survives reconnects and replays snapshots received before
        // attachment. Listening only to its first native socket loses both.
        if (this.subscribedManager && this.subscribedManager !== this.wsManager) {
            if (this.managedStateHandler) this.subscribedManager.off('viewed_state', this.managedStateHandler);
            this.subscribedManager = null;
        }
        if (this.nativeListenerSocket && this._wsMessageHandler) {
            this.nativeListenerSocket.removeEventListener('message', this._wsMessageHandler);
            this.nativeListenerSocket = null;
        }
        if (this.wsManager) {
            if (this.subscribedManager === this.wsManager) return;
            this.managedStateHandler ??= this.receiveViewedState;
            this.subscribedManager = this.wsManager;
            this.wsManager.on('viewed_state', this.managedStateHandler);
            return;
        }
        if (!this.ws) return;
        // Preserve compatibility with callers supplying a raw WebSocket only.
        this._wsMessageHandler = (event: MessageEvent): void => {
            try {
                const data = JSON.parse(event.data as string) as Parameters<WsHandler<'viewed_state'>>[0];
                if (data.type === 'viewed_state') this.receiveViewedState(data);
            } catch { /* Ignore frames unrelated to review state. */ }
        };
        this.nativeListenerSocket = this.ws;
        this.ws.addEventListener('message', this._wsMessageHandler);
    }

    updateCheckboxes(): void {
        const checkboxes = document.querySelectorAll<HTMLInputElement>('.viewed-checkbox');
        checkboxes.forEach((checkbox) => {
            const headingId = checkbox.dataset['headingId'];
            if (headingId) {
                checkbox.checked = !!this.viewedState[headingId];
                const label = checkbox.closest<HTMLLabelElement>('.viewed-checkbox-label');
                if (label) label.title = _t(checkbox.checked ? 'web.viewed.unmark' : 'web.viewed.mark');
            }
        });
    }

    injectCheckboxes(): void {
        // Only add checkboxes to h2-h6, not h1 (usually the document title).
        const headings = document.querySelectorAll<HTMLElement>(SECTION_HEADINGS_SELECTOR);

        headings.forEach((heading, index) => {
            if (!heading.id) {
                heading.id = `heading-${index}`;
            }

            const headingId = heading.id;

            const actions: { type: string; create: () => HTMLElement }[] = [];

            // 1. Progress marker (requires access to document state)
            if (this.enableViewed) {
                actions.push({
                    type: 'viewed',
                    create: () => {
                        const label = document.createElement('label');
                        label.className = 'viewed-checkbox-label';
                        label.title = _t(this.viewedState[headingId] ? 'web.viewed.unmark' : 'web.viewed.mark');

                        const checkbox = document.createElement('input');
                        checkbox.type = 'checkbox';
                        checkbox.className = 'viewed-checkbox';
                        checkbox.dataset['headingId'] = headingId;
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
                    printBtn.dataset['headingId'] = headingId;
                    return printBtn;
                },
            });

            // 3. Export notes in this heading section (always enabled)
            actions.push({
                type: 'export-notes',
                create: () => {
                    const exportBtn = document.createElement('span');
                    exportBtn.className = 'section-action section-export-notes';
                    exportBtn.textContent = exportNotesLabel(0);
                    exportBtn.title = _t('web.export.section.tip');
                    exportBtn.dataset['headingId'] = headingId;
                    return exportBtn;
                },
            });

            // 4. Expand/collapse toggle (always enabled)
            actions.push({
                type: 'toggle',
                create: () => {
                    const toggleBtn = document.createElement('span');
                    toggleBtn.className = 'section-action section-expand-toggle';
                    // Default: section is expanded → label is "Collapse".
                    toggleBtn.textContent = _t('web.viewed.collapse');
                    toggleBtn.dataset['headingId'] = headingId;
                    return toggleBtn;
                },
            });

            const actionsContainer = document.createElement('span');
            actionsContainer.className = 'section-actions';

            actions.forEach((action, idx) => {
                if (idx > 0) {
                    const separator = document.createElement('span');
                    separator.className = 'section-action-separator';
                    separator.textContent = ' | ';
                    actionsContainer.appendChild(separator);
                }

                const element = action.create();
                actionsContainer.appendChild(element);
            });

            heading.appendChild(actionsContainer);
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

    preserveExpansionForNextSharedState(): void {
        this.preserveExpansionOnNextSharedState = true;
    }

    private hasCollapsedState(headingId: string): boolean {
        return Object.prototype.hasOwnProperty.call(this.collapsedState, headingId);
    }

    private shouldCollapse(headingId: string): boolean {
        if (this.hasCollapsedState(headingId)) {
            return !!this.collapsedState[headingId];
        }
        return !!this.viewedState[headingId];
    }

    private setCollapsedState(headingId: string, isCollapsed: boolean): void {
        this.collapsedState[headingId] = isCollapsed;
        this.saveCollapsedState();
    }

    revealNoteSource(annotationId: string, sourceElement: Element): void {
        if (this.noteFocusReveal?.annotationId === annotationId) {
            return;
        }

        this.clearNoteSourceReveal();

        const collapsedHeadings = this.collapsedHeadingsContaining(sourceElement);
        if (collapsedHeadings.length === 0) {
            return;
        }

        const token = String(++this.noteFocusRevealSeq);
        this.noteFocusReveal = {
            annotationId,
            token,
            headings: collapsedHeadings.map((heading) => ({
                id: heading.id,
                wasCollapsed: heading.classList.contains('section-collapsed'),
            })),
        };

        collapsedHeadings.forEach((heading) => {
            heading.dataset['markonNoteFocusReveal'] = token;
            this.expandSection(heading.id, { animate: false });
        });
    }

    clearNoteSourceReveal(annotationId?: string | null): void {
        const reveal = this.noteFocusReveal;
        if (!reveal) return;
        if (annotationId && reveal.annotationId !== annotationId) return;

        this.noteFocusReveal = null;
        [...reveal.headings].reverse().forEach(({ id, wasCollapsed }) => {
            const heading = document.getElementById(id);
            if (!heading || heading.dataset['markonNoteFocusReveal'] !== reveal.token) {
                return;
            }

            delete heading.dataset['markonNoteFocusReveal'];
            if (wasCollapsed) {
                this.collapseSection(id);
            }
        });
    }

    private collapsedHeadingsContaining(sourceElement: Element): HTMLElement[] {
        return Array.from(document.querySelectorAll<HTMLElement>(SECTION_HEADINGS_SELECTOR))
            .filter((heading) => {
                if (!heading.id || !heading.classList.contains('section-collapsed')) return false;
                return this.getSectionContent(heading).some(el => el === sourceElement || el.contains(sourceElement));
            });
    }

    private cancelNoteSourceRevealForHeading(headingId: string): void {
        const reveal = this.noteFocusReveal;
        if (!reveal || !reveal.headings.some(heading => heading.id === headingId)) return;

        reveal.headings.forEach(({ id }) => {
            const heading = document.getElementById(id);
            if (heading?.dataset['markonNoteFocusReveal'] === reveal.token) {
                delete heading.dataset['markonNoteFocusReveal'];
            }
        });
        this.noteFocusReveal = null;
    }

    private cancelNoteSourceReveal(): void {
        const reveal = this.noteFocusReveal;
        if (!reveal) return;
        reveal.headings.forEach(({ id }) => {
            const heading = document.getElementById(id);
            if (heading?.dataset['markonNoteFocusReveal'] === reveal.token) {
                delete heading.dataset['markonNoteFocusReveal'];
            }
        });
        this.noteFocusReveal = null;
    }

    collapseSection(headingId: string): void {
        const pendingFrame = this.expansionFrames.get(headingId);
        if (pendingFrame !== undefined) {
            cancelAnimationFrame(pendingFrame);
            this.expansionFrames.delete(headingId);
        }
        const heading = document.getElementById(headingId);
        if (!heading) return;

        const content = this.getSectionContent(heading);

        heading.classList.add('section-collapsed');
        content.forEach((el) => {
            // The hint placeholder sits right after the heading, so a second
            // collapse of the same section picks it up as section content.
            // Hiding it would leave the section collapsed with no hint — the
            // exact symptom after a reload, where applyViewedState() runs once
            // during init() and again from attachStorage().
            if (el.classList.contains('section-collapsed-placeholder')) return;
            el.classList.add('section-content-hidden');
            el.classList.remove('section-content-temp-visible');
        });

        this.ensureCollapsedPlaceholder(heading, headingId);
        this.syncToggleBtn(heading, true);
    }

    syncToggleBtn(heading: HTMLElement, isCollapsed: boolean): void {
        const toggleBtn = heading.querySelector<HTMLElement>('.section-expand-toggle');
        if (!toggleBtn) return;
        toggleBtn.textContent = _t(isCollapsed ? 'web.viewed.expand' : 'web.viewed.collapse');
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
        placeholder.dataset['headingId'] = headingId;
        placeholder.textContent = _t('web.viewed.collapsed.hint');
        placeholder.addEventListener('click', () => {
            this.cancelNoteSourceRevealForHeading(headingId);
            this.toggleTempExpand(headingId);
        });
        heading.insertAdjacentElement('afterend', placeholder);
    }

    removeCollapsedPlaceholder(heading: HTMLElement): void {
        const next = heading.nextElementSibling;
        if (next && next.classList && next.classList.contains('section-collapsed-placeholder')) {
            next.remove();
        }
    }

    expandSection(headingId: string, options: RevealContentOptions = {}): void {
        const heading = document.getElementById(headingId);
        if (!heading) return;

        const pendingFrame = this.expansionFrames.get(headingId);
        if (pendingFrame !== undefined) cancelAnimationFrame(pendingFrame);
        this.expansionFrames.delete(headingId);
        const content = this.getSectionContent(heading);

        heading.classList.remove('section-collapsed');
        this.removeCollapsedPlaceholder(heading);

        if (options.animate === false) {
            this.revealContent(content, { animate: false });
        } else {
            // Make sure elements start hidden so the transition fires.
            content.forEach((el) => {
                if (!el.classList.contains('section-content-hidden')) {
                    el.classList.add('section-content-hidden');
                }
            });

            // Force reflow.
            content.forEach((el) => void el.offsetHeight);

            // Trigger expand animation.
            const frame = requestAnimationFrame(() => {
                if (this.expansionFrames.get(headingId) !== frame) return;
                this.expansionFrames.delete(headingId);
                if (heading.isConnected && !heading.classList.contains('section-collapsed')) {
                    this.revealContent(content);
                }
            });
            this.expansionFrames.set(headingId, frame);
        }

        this.syncToggleBtn(heading, false);
    }

    toggleTempExpand(headingId: string): void {
        this.toggleCollapse(headingId);
    }

    revealContent(content: HTMLElement[], options: RevealContentOptions = {}): void {
        if (options.animate === false) {
            content.forEach((el) => {
                el.classList.remove('section-content-hidden');
                el.classList.remove('section-content-temp-visible');
                delete el.dataset['markonRevealToken'];
            });
            return;
        }

        content.forEach((el) => {
            const token = String(++this.revealSeq);
            el.dataset['markonRevealToken'] = token;
            el.classList.remove('section-content-hidden');
            el.classList.add('section-content-temp-visible');

            let done = false;
            const cleanup = (e?: TransitionEvent): void => {
                if (done) return;
                if (e && e.target !== el) return;
                if (e && e.propertyName !== 'opacity') return;
                done = true;
                if (el.dataset['markonRevealToken'] === token) {
                    el.classList.remove('section-content-temp-visible');
                    delete el.dataset['markonRevealToken'];
                }
                el.removeEventListener('transitionend', cleanup);
                window.clearTimeout(fallback);
            };

            el.addEventListener('transitionend', cleanup);
            const fallback = window.setTimeout(() => cleanup(), 450);
        });
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
            .querySelectorAll('.section-actions, .viewed-checkbox-label, .section-action-separator, .section-print-btn, .section-expand-toggle')
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

        const themeCss = runtimeMarkdownCss();

        const doc = iframe.contentDocument;
        if (!doc) {
            console.warn('[ViewedManager] printSection: iframe contentDocument unavailable');
            return;
        }
        doc.open();
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- Intentional write into a temporary print iframe.
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
  /* Diagram sizing overrides */
  .markon-diagram { overflow: visible !important; border: none !important; padding: 0 !important; margin: 12pt 0 !important; page-break-inside: avoid !important; }
  .markon-diagram svg { display: block; width: 100% !important; height: auto !important; max-width: 100% !important; }
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

        // Normalize SVG sizing in iframe.
        const normalizeIframeSVGs = (): void => {
            const svgs = Array.from(doc.querySelectorAll<SVGElement>('.markon-diagram svg, svg'));
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

        if (doc.fonts) {
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
        };

        const iframeWindow = iframe.contentWindow;
        if (iframeWindow) {
            iframeWindow.addEventListener('afterprint', cleanupIframe, { once: true });
        }

        const fallbackCleanup = setTimeout(cleanupIframe, 30000);

        try {
            iframeWindow?.focus();
            iframeWindow?.print();
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

        // eslint-disable-next-line @typescript-eslint/no-deprecated -- Intentional write into a newly opened print window.
        printWindow.document.write(
            `<html><head><title>Loading...</title></head><body style="font-family: system-ui; padding: 40px; text-align: center;"><h2>${_t('web.viewed.print.preparing')}</h2></body></html>`,
        );

        // STEP 2: prepare content (async OK — window is already open).
        const headingClone = heading.cloneNode(true) as HTMLElement;
        headingClone
            .querySelectorAll('.section-actions, .viewed-checkbox-label, .section-action-separator, .section-print-btn, .section-expand-toggle, .section-action')
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
            // eslint-disable-next-line @typescript-eslint/no-deprecated -- Intentional write into a newly opened print window.
            printWindow.document.write(fullHTML);
            printWindow.document.close();

        } catch (error) {
            console.error('[ViewedManager] printSectionInNewWindow: failed to write content', error);
            printWindow.close();
            alert(_t('web.viewed.print.failed'));
        }
    }

    async fetchPrintStyles(): Promise<string> {
        const cssFiles = [runtimeMarkdownCss(), '/_/css/github-print.css'];

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
        this.cancelNoteSourceRevealForHeading(headingId);
        const heading = document.getElementById(headingId);
        if (!heading) return;

        if (heading.classList.contains('section-collapsed')) {
            const content = this.getSectionContent(heading);
            heading.classList.remove('section-collapsed');
            this.removeCollapsedPlaceholder(heading);
            this.revealContent(content);
            this.syncToggleBtn(heading, false);
            this.setCollapsedState(headingId, false);
        } else {
            this.collapseSection(headingId);
            this.setCollapsedState(headingId, true);
        }
    }

    toggleViewed(headingId: string, isViewed: boolean): void {
        this.cancelNoteSourceRevealForHeading(headingId);
        this.viewedState[headingId] = isViewed;
        this.collapsedState[headingId] = isViewed;

        if (isViewed) {
            this.collapseSection(headingId);

            // Drop any in-flight reveal styling when marking as viewed.
            const heading = document.getElementById(headingId);
            if (heading) {
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
        this.saveState({ [headingId]: isViewed });
        this.saveCollapsedState();

        this.updateAllViewedCheckbox();
    }

    private sectionHeadingIds(): string[] {
        return Array.from(document.querySelectorAll<HTMLElement>(SECTION_HEADINGS_SELECTOR))
            .map((heading) => heading.id)
            .filter((id): id is string => Boolean(id));
    }

    /** Heading IDs of all per-section viewed checkboxes currently in the DOM. */
    private headingIds(): string[] {
        return Array.from(document.querySelectorAll<HTMLInputElement>('.viewed-checkbox'))
            .map((cb) => cb.dataset['headingId'])
            .filter((id): id is string => Boolean(id));
    }

    updateAllViewedCheckbox(): void {
        const allHeadingIds = this.headingIds();
        const allViewed = allHeadingIds.length > 0 && allHeadingIds.every((id) => this.viewedState[id]);

        if (this.allViewedCheckbox) {
            // Recursion guard.
            this.updatingAllViewedCheckbox = true;
            this.allViewedCheckbox.checked = allViewed;
            const label = this.allViewedCheckbox.closest<HTMLLabelElement>('.viewed-all-label');
            if (label) label.title = _t(allViewed ? 'web.viewed.all.unmark.tip' : 'web.viewed.all.tip');
            this.updatingAllViewedCheckbox = false;
        }
    }

    async loadState(): Promise<void> {
        this.viewedState = {};
        this.stateLoaded = true;
    }

    loadCollapsedState(): void {
        try {
            const saved = localStorage.getItem(collapsedStorageKey(this.filePath));
            this.collapsedState = saved ? (JSON.parse(saved) as CollapsedState) : {};
        } catch {
            this.collapsedState = {};
        }
    }

    saveCollapsedState(): void {
        localStorage.setItem(collapsedStorageKey(this.filePath), JSON.stringify(this.collapsedState));
    }

    saveState(changes?: ViewedState): void {
        if (changes) {
            const revision = ++this.changeRevision;
            Object.entries(changes).forEach(([id, value]) => {
                this.pendingChanges.set(id, { value, revision });
            });
        }
        if (!this.storageManager || !this.storageReady || !this.pendingChanges.size) return;
        const entries = new Map([...this.pendingChanges].filter(([id]) => !changes || id in changes));
        const patch = Object.fromEntries([...entries].map(([id, entry]) => [id, entry.value]));
        if (!entries.size) return;
        const operation = { observed: false };
        let opId: string | null = null;
        void this.storageManager.patchViewedState(patch, (preparedId) => {
            opId = preparedId;
            if (opId) this.inFlightOperations.set(opId, operation);
        }).then(() => {
            // Once our own commit was observed, a later canonical WS state
            // can include another reader's newer change and stays authoritative.
            if (!operation.observed) {
                this.confirmedState = { ...this.confirmedState, ...patch };
            }
            entries.forEach((entry, id) => {
                if (this.pendingChanges.get(id)?.revision === entry.revision) this.pendingChanges.delete(id);
            });
            this.viewedState = this.withPendingChanges(this.confirmedState);
            this.updateCheckboxes();
            this.updateTocHighlights();
            this.updateAllViewedCheckbox();
        }).catch((error: unknown) => {
            let reverted = false;
            entries.forEach((entry, id) => {
                // Failure of an older request must never undo a newer click.
                if (this.pendingChanges.get(id)?.revision !== entry.revision) return;
                this.pendingChanges.delete(id);
                this.collapsedState[id] = !!this.confirmedState[id];
                reverted = true;
            });
            if (!reverted) return;
            this.viewedState = this.withPendingChanges(this.confirmedState);
            this.updateCheckboxes();
            this.applyViewedState();
            this.saveCollapsedState();
            alert(error instanceof Error ? error.message : String(error));
        }).finally(() => {
            if (opId) this.inFlightOperations.delete(opId);
        });
    }

    applyViewedState(): void {
        this.sectionHeadingIds().forEach((headingId) => {
            if (this.shouldCollapse(headingId)) {
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
                const headingId = target.dataset['headingId'];
                if (!headingId) return;
                this.cancelNoteSourceRevealForHeading(headingId);
                this.toggleViewed(headingId, target.checked);
            });
        });

        // Toggle button click — independent of viewed state.
        document.querySelectorAll<HTMLElement>('.section-expand-toggle').forEach((toggleBtn) => {
            toggleBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const target = e.target as HTMLElement;
                const headingId = target.dataset['headingId'];
                if (!headingId) return;
                this.cancelNoteSourceRevealForHeading(headingId);
                this.toggleTempExpand(headingId);
            });
        });

        // Print button click.
        document.querySelectorAll<HTMLElement>('.section-print-btn').forEach((printBtn) => {
            printBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const target = e.target as HTMLElement;
                const headingId = target.dataset['headingId'];
                if (!headingId) return;
                void this.printSection(headingId);
            });
        });

        // Section notes export.
        document.querySelectorAll<HTMLElement>('.section-export-notes').forEach((exportBtn) => {
            exportBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const target = e.currentTarget as HTMLElement;
                if (target.getAttribute('aria-disabled') === 'true') return;
                const headingId = target.dataset['headingId'];
                if (!headingId) return;
                window.markonExportNotes?.(target, headingId);
            });
        });
    }

    // ============================================================
    // Phase 3: Toolbar and Batch Operations
    // ============================================================

    createToolbar(): void {
        const h1 = document.querySelector<HTMLElement>('.markdown-body h1');
        if (!h1) return;

        const hasSections = document.querySelector(SECTION_HEADINGS_SELECTOR) !== null;

        const toolbar = document.createElement('span');
        toolbar.className = 'viewed-toolbar';

        if (this.enableViewed && hasSections) {
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

            toolbar.appendChild(label);

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
        }

        // Keep the same action order as section rows: Viewed, Print, Notes,
        // then folding. Each separator stays attached to its following action.
        const actions = [
            { className: 'btn-print-page', label: _t('web.viewed.print') },
            { className: 'btn-export-notes', label: _t('web.export.label'), title: _t('web.export.tip') },
            ...(hasSections ? [
                { className: 'btn-collapse-all', label: _t('web.viewed.collapseall') },
                { className: 'btn-expand-all', label: _t('web.viewed.expandall') },
            ] : []),
        ];
        for (const action of actions) {
            const item = document.createElement('span');
            item.className = 'viewed-toolbar-item';
            if (toolbar.childElementCount > 0) {
                const separator = document.createElement('span');
                separator.className = 'viewed-toolbar-separator';
                separator.textContent = '|';
                item.appendChild(separator);
            }
            const link = document.createElement('a');
            link.className = action.className;
            link.textContent = action.label;
            if ('title' in action && action.title) link.title = action.title;
            item.appendChild(link);
            toolbar.append(' ', item);
        }

        h1.appendChild(toolbar);

        toolbar.querySelector<HTMLElement>('.btn-collapse-all')?.addEventListener('click', () => this.collapseAll());
        toolbar.querySelector<HTMLElement>('.btn-expand-all')?.addEventListener('click', () => this.expandAll());
        toolbar.querySelector<HTMLElement>('.btn-print-page')?.addEventListener('click', () => {
            window.print();
        });
        toolbar.querySelector<HTMLElement>('.btn-export-notes')?.addEventListener(
            'click',
            (e) => {
                const link = e.currentTarget as HTMLElement;
                if (link.getAttribute('aria-disabled') === 'true') {
                    e.preventDefault();
                    return;
                }
                window.markonExportNotes?.(link);
            },
        );
        this.updateExportNotesButtons();
    }

    updateExportNotesButtons(): void {
        const link = document.querySelector<HTMLElement>('.btn-export-notes');
        if (link) {
            const count = Math.max(0, window.markonNotesCount?.() ?? 0);
            link.textContent = exportNotesLabel(count);
            const disabled = count === 0;
            link.classList.toggle('is-disabled', disabled);
            link.setAttribute('aria-disabled', disabled ? 'true' : 'false');
            if (disabled) link.setAttribute('tabindex', '-1');
            else link.removeAttribute('tabindex');
        }

        document.querySelectorAll<HTMLElement>('.section-export-notes').forEach((button) => {
            const headingId = button.dataset['headingId'];
            const count = Math.max(0, headingId ? window.markonNotesCount?.(headingId) ?? 0 : 0);
            button.textContent = exportNotesLabel(count);
            const disabled = count === 0;
            button.classList.toggle('is-disabled', disabled);
            button.setAttribute('aria-disabled', disabled ? 'true' : 'false');
            if (disabled) button.setAttribute('tabindex', '-1');
            else button.removeAttribute('tabindex');
        });
    }

    markAllViewed(): void {
        this.cancelNoteSourceReveal();
        this.sectionHeadingIds().forEach((headingId) => {
            this.viewedState[headingId] = true;
            this.collapsedState[headingId] = true;
            this.collapseSection(headingId);
        });

        this.updateCheckboxes();
        this.updateTocHighlights();
        this.saveState(Object.fromEntries(this.sectionHeadingIds().map(id => [id, true])));
        this.saveCollapsedState();

        this.updateAllViewedCheckbox();
    }

    markAllUnviewed(): void {
        this.cancelNoteSourceReveal();
        this.viewedState = {};
        this.sectionHeadingIds().forEach((headingId) => {
            this.collapsedState[headingId] = false;
        });

        this.updateCheckboxes();
        // applyViewedState() ends with updateAllViewedCheckbox(), which
        // unchecks the All-Viewed box against the freshly emptied state.
        this.applyViewedState();
        this.updateTocHighlights();
        this.saveState(Object.fromEntries(this.sectionHeadingIds().map(id => [id, false])));
        this.saveCollapsedState();
    }

    collapseAll(): void {
        this.cancelNoteSourceReveal();
        // Process h6 → h2 to handle nested sections correctly.
        sectionHeadingsByLevel(true).forEach((heading) => {
            if (heading.id) {
                this.collapsedState[heading.id] = true;
                this.collapseSection(heading.id);
            }
        });
        this.saveCollapsedState();
    }

    expandAll(): void {
        this.cancelNoteSourceReveal();
        // Process h2 → h6 to handle nested sections correctly.
        sectionHeadingsByLevel(false).forEach((heading) => {
            if (heading.id) {
                this.collapsedState[heading.id] = false;
                heading.classList.remove('section-collapsed');
                this.removeCollapsedPlaceholder(heading);
                this.syncToggleBtn(heading, false);
            }
        });

        document
            .querySelectorAll<HTMLElement>(
                '.markdown-body .section-content-hidden, .markdown-body .section-content-temp-visible',
            )
            .forEach((el) => {
                el.classList.remove('section-content-hidden');
                el.classList.remove('section-content-temp-visible');
                delete el.dataset['markonRevealToken'];
            });
        this.saveCollapsedState();
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
            if (!href?.startsWith('#')) return;

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
        const dispatchReady = (): void => {
            document.dispatchEvent(new CustomEvent('markon:viewed-ready'));
        };
        void window.viewedManager.ready.then(dispatchReady, dispatchReady);
    }
}

if (document.querySelector('.markdown-body')) {
    initViewedFeature();
} else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initViewedFeature);
} else {
    initViewedFeature();
}
