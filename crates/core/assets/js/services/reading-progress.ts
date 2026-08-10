/**
 * Reading progress — bring the reader back to where they stopped.
 *
 * Device-local by design. Progress lives in `localStorage` and is never
 * written to SQLite or pushed over the WebSocket: "where I am in this
 * document" is a property of this reader on this screen, not of the document.
 * Syncing it would let a second device — or a Live peer — yank the page out
 * from under someone who is still reading.
 *
 * What gets stored is an anchor, not a scroll offset: the id of the last
 * heading above the viewport top plus how far below it the reader was. An
 * absolute `scrollY` goes stale the moment the window is resized, the font
 * changes, a section is folded, or a diagram above the reader finishes
 * rendering; a heading-relative offset survives all of those.
 */

import { Logger } from '../core/utils';

/** localStorage key holding one document's reading anchor. */
export const readingProgressKey = (filePath: string): string => `markon-reading-${filePath}`;

/**
 * `id` is the anchor heading; `offset` is the distance in pixels from that
 * heading's top to the viewport top. `id: null` means the reader was above the
 * first heading, and `offset` is then the raw scroll position.
 */
export type ReadingAnchor = {
    id: string | null;
    offset: number;
};

/** Below this the reader is still effectively at the top — nothing to restore. */
const MIN_SCROLL_TO_STORE = 40;

/**
 * A heading counts as "above the reader" once its top passes this far above
 * the viewport top. The slack keeps a heading sitting exactly at the top edge
 * from flip-flopping between two anchors on sub-pixel scroll jitter.
 */
const ANCHOR_SLACK = 8;

/** How long scrolling must stay quiet before the anchor is written. */
const SAVE_DEBOUNCE_MS = 400;

/** Elements collapsed by the fold feature have zero height and no box. */
function isVisible(el: HTMLElement): boolean {
    return el.getClientRects().length > 0;
}

/** Absolute document-space top of an element. */
function absoluteTop(el: HTMLElement): number {
    return el.getBoundingClientRect().top + window.scrollY;
}

/** Visible, id-bearing headings of the rendered document, in document order. */
function anchorHeadings(root: ParentNode): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]'))
        .filter(isVisible);
}

/** Read the reader's current position as a heading-relative anchor. */
export function captureAnchor(root: ParentNode): ReadingAnchor {
    const scrollY = window.scrollY;
    let anchor: HTMLElement | null = null;

    for (const heading of anchorHeadings(root)) {
        if (absoluteTop(heading) <= scrollY + ANCHOR_SLACK) {
            anchor = heading;
        } else {
            break;
        }
    }

    if (!anchor) {
        return { id: null, offset: scrollY };
    }
    return { id: anchor.id, offset: Math.max(0, Math.round(scrollY - absoluteTop(anchor))) };
}

/**
 * Translate a stored anchor back into a scroll position against the current
 * layout. Returns `null` when the anchor no longer resolves — the heading was
 * renamed, deleted, or is hidden inside a collapsed parent section.
 */
export function anchorScrollTop(anchor: ReadingAnchor): number | null {
    if (anchor.id === null) {
        return Math.max(0, anchor.offset);
    }
    const heading = document.getElementById(anchor.id);
    if (!heading || !isVisible(heading)) {
        return null;
    }
    return Math.max(0, absoluteTop(heading) + anchor.offset);
}

/**
 * Persists and restores one document's reading position.
 *
 * Restoring is not a single scroll call. Images, math, and diagrams settle
 * after the first paint and push the anchor heading around, so the tracker
 * keeps re-pinning to the anchor while the document is still growing, and
 * stops the moment the reader takes over — the first wheel, key, or pointer
 * input hands control back to them for good.
 */
export class ReadingProgressTracker {
    #root: HTMLElement;
    #storageKey: string;
    #saveTimer: ReturnType<typeof setTimeout> | undefined;
    #anchor: ReadingAnchor | null = null;
    #userTookOver = false;
    #resizeObserver: ResizeObserver | null = null;
    #listeners: Array<() => void> = [];

    constructor(root: HTMLElement, filePath: string) {
        this.#root = root;
        this.#storageKey = readingProgressKey(filePath);
    }

    /** Stored anchor for this document, or `null` when there is none. */
    read(): ReadingAnchor | null {
        try {
            const raw = localStorage.getItem(this.#storageKey);
            if (!raw) return null;
            const parsed = JSON.parse(raw) as Partial<ReadingAnchor>;
            const offset = typeof parsed.offset === 'number' && Number.isFinite(parsed.offset)
                ? parsed.offset
                : null;
            if (offset === null) return null;
            const id = typeof parsed.id === 'string' ? parsed.id : null;
            return { id, offset };
        } catch {
            return null;
        }
    }

    /** Write the reader's current position, or clear it near the top. */
    save(): void {
        const anchor = captureAnchor(this.#root);
        try {
            if (anchor.id === null && anchor.offset < MIN_SCROLL_TO_STORE) {
                localStorage.removeItem(this.#storageKey);
            } else {
                localStorage.setItem(this.#storageKey, JSON.stringify(anchor));
            }
        } catch (error) {
            // A full or disabled localStorage must not break reading.
            Logger.warn('ReadingProgress', 'Failed to store reading anchor:', error);
        }
    }

    /**
     * Start tracking, and jump to the stored anchor.
     *
     * A `#hash` in the URL wins — the reader asked for a specific section, and
     * that intent is newer than any stored progress.
     */
    start(): void {
        // We restore the position ourselves; letting the browser also restore
        // its own remembered `scrollY` would land the reader in the wrong place
        // whenever folded sections changed the document height.
        if ('scrollRestoration' in history) {
            history.scrollRestoration = 'manual';
        }

        this.#anchor = window.location.hash ? null : this.read();
        if (this.#anchor) {
            this.#applyAnchor();
            this.#watchLayoutSettle();
        }

        this.#on(window, 'scroll', () => this.#scheduleSave(), { passive: true });
        this.#on(document, 'visibilitychange', () => {
            if (document.visibilityState === 'hidden') this.#flush();
        });
        this.#on(window, 'pagehide', () => this.#flush());

        for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const) {
            this.#on(window, event, () => this.#handOverToReader(), { passive: true });
        }
    }

    /** Detach every listener and flush the last known position. */
    stop(): void {
        this.#flush();
        this.#resizeObserver?.disconnect();
        this.#resizeObserver = null;
        this.#listeners.forEach((off) => off());
        this.#listeners = [];
    }

    #applyAnchor(): void {
        const anchor = this.#anchor;
        if (!anchor) return;
        const top = anchorScrollTop(anchor);
        if (top === null) {
            Logger.log('ReadingProgress', `Anchor "${anchor.id ?? '(top)'}" no longer resolves; staying put`);
            this.#anchor = null;
            return;
        }
        window.scrollTo({ top, behavior: 'auto' });
    }

    /**
     * Late-loading images and diagrams change the document height after the
     * first paint. Re-pin to the anchor as the body grows, until the reader
     * scrolls for themselves.
     */
    #watchLayoutSettle(): void {
        if (typeof ResizeObserver === 'undefined') return;
        this.#resizeObserver = new ResizeObserver(() => {
            if (this.#userTookOver) return;
            this.#applyAnchor();
        });
        this.#resizeObserver.observe(this.#root);
    }

    #handOverToReader(): void {
        if (this.#userTookOver) return;
        this.#userTookOver = true;
        this.#resizeObserver?.disconnect();
        this.#resizeObserver = null;
    }

    #scheduleSave(): void {
        if (this.#saveTimer !== undefined) clearTimeout(this.#saveTimer);
        this.#saveTimer = setTimeout(() => {
            this.#saveTimer = undefined;
            this.save();
        }, SAVE_DEBOUNCE_MS);
    }

    /** Write immediately, cancelling any pending debounced write. */
    #flush(): void {
        if (this.#saveTimer !== undefined) {
            clearTimeout(this.#saveTimer);
            this.#saveTimer = undefined;
        }
        this.save();
    }

    #on(
        target: Window | Document,
        event: string,
        handler: () => void,
        options?: AddEventListenerOptions,
    ): void {
        target.addEventListener(event, handler, options);
        this.#listeners.push(() => target.removeEventListener(event, handler, options));
    }
}
