/**
 * Shared DOM policy for annotation targets.
 *
 * Browser selections remain native and unrestricted. These helpers only decide
 * which parts of a selection may participate in a Markon annotation.
 */

import type { RejectFn } from './text-anchor';
import { DOM } from './dom';

const ANNOTATION_CHROME_SELECTOR = [
    '.selection-popover',
    '.note-input-modal',
    '.note-card-margin',
    '.note-popup',
    '.confirm-dialog',
    '.md-diff-ui',
    '.viewed-checkbox',
    '.viewed-checkbox-label',
    '.viewed-text',
    '.viewed-toolbar',
    '.section-toggle-btn',
    '.section-actions',
    '.section-action',
    '.section-action-separator',
    '.section-collapsed-placeholder',
].join(',');

function elementOf(node: Node): Element | null {
    return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

/** Markon-injected controls that must never become part of an annotation. */
export const ANNOTATION_CHROME_REJECT: RejectFn = (node) =>
    !!elementOf(node)?.closest(ANNOTATION_CHROME_SELECTOR);

/** Compose content filters without making callers branch on optional policies. */
export function combineRejects(...predicates: readonly (RejectFn | undefined)[]): RejectFn {
    const active = predicates.filter((predicate): predicate is RejectFn => !!predicate);
    return (node) => active.some((predicate) => predicate(node));
}

/** Every selected text node, in document order. */
function selectedTextNodes(range: Range): Text[] {
    const common = range.commonAncestorContainer;
    if (common.nodeType === Node.TEXT_NODE) {
        return range.toString() ? [common as Text] : [];
    }

    const selected: Text[] = [];
    const walker = document.createTreeWalker(common, NodeFilter.SHOW_TEXT);
    let node: Node | null = walker.nextNode();
    while (node) {
        if (range.intersectsNode(node)) selected.push(node as Text);
        node = walker.nextNode();
    }
    return selected;
}

/**
 * Surface-specific rejection is stricter than content filtering: if a range
 * touches old/deleted diff content, no Markon action is available. The browser
 * selection itself is deliberately left untouched.
 */
export function rangeIntersectsRejected(range: Range, reject?: RejectFn): boolean {
    if (!reject) return false;
    return selectedTextNodes(range).some((node) => reject(node));
}

/** Structural block used to split one contiguous range into anchor fragments. */
export function annotationBlockFor(node: Node, root: Node): Element | null {
    return DOM.getBlockParent(node, root) ?? (root.nodeType === Node.ELEMENT_NODE ? (root as Element) : null);
}
