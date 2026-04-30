/**
 * DOM service - pure technical, no business logic
 */
import { CONFIG } from '../core/config.js';

export interface OutsideClickOptions {
    /** Predicate: when truthy, the click is treated as inside (ignored). */
    ignore?: (target: EventTarget | null) => boolean;
}

export type Disposer = () => void;

export const DOM = {
    // Get block-level parent element
    getBlockParent(node: Node, container: Node): HTMLElement | null {
        let current: HTMLElement | null =
            node.nodeType === 3 ? (node.parentElement as HTMLElement | null) : (node as HTMLElement);
        while (current && current !== container) {
            if (CONFIG.BLOCK_TAGS.includes(current.tagName)) return current;
            current = current.parentElement;
        }
        return null;
    },

    // Find the last non-empty text node in a subtree
    findLastTextNode(element: Node): Text | null {
        let lastText: Text | null = null;
        const walk = (node: Node): void => {
            if (node.nodeType === 3 && (node.textContent ?? '').trim()) {
                lastText = node as Text;
            } else if (node.nodeType === 1) {
                for (const child of (node as Element).childNodes) walk(child);
            }
        };
        walk(element);
        return lastText;
    },

    // Check if element should be skipped (TOC, popovers, etc.)
    shouldSkip(element: Node): boolean {
        if (element.nodeType !== 1) return false;
        const el = element as Element;
        if (el.id && CONFIG.SKIP_ELEMENTS.IDS.has(el.id)) return true;
        if (el.className && typeof el.className === 'string') {
            return el.className.split(' ').some((cls: string) => CONFIG.SKIP_ELEMENTS.CLASSES.has(cls));
        }
        return false;
    },

    // Get element height with fallback
    getHeight(element: HTMLElement, fallback: number = 80): number {
        const height = element.offsetHeight;
        return height > 0 ? height : fallback;
    },

    // Detach-on-outside-click helper. Returns a disposer.
    onOutsideClick(
        element: Node,
        callback: (e: MouseEvent) => void,
        { ignore }: OutsideClickOptions = {}
    ): Disposer {
        const handler = (e: MouseEvent): void => {
            if (element.contains(e.target as Node | null)) return;
            if (ignore && ignore(e.target)) return;
            callback(e);
        };
        const dispose: Disposer = () => document.removeEventListener('click', handler, true);
        document.addEventListener('click', handler, true);
        return dispose;
    }
};

// Read a <meta name="..."> tag inserted into layout.html by the server.
export const Meta = {
    get(name: string): string | null {
        return document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ?? null;
    },
    flag(name: string): boolean {
        return this.get(name) === 'true';
    }
};
