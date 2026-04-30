/**
 * XPath service - pure technical, no business logic
 */
import { DOM } from './dom.js';

export interface FoundNode {
    /** Resolved text node, or `null` if the offset cannot be located. */
    node: Text | null;
    /** Offset within `node`. Meaningful only when `node` is non-null. */
    offset: number;
}

export const XPath = {
    // Generate simple XPath
    create(node: Node): string {
        const parts: string[] = [];
        let current: Node | null = node;
        while (current && current.nodeName !== 'ARTICLE') {
            let index = 1;
            for (let sibling: Node | null = current.previousSibling; sibling; sibling = sibling.previousSibling) {
                if (sibling.nodeName === current.nodeName && !DOM.shouldSkip(sibling)) index++;
            }
            parts.unshift(`${current.nodeName}[${index}]`);
            current = current.parentNode;
        }
        return parts.length === 0 ? '//article[1]' : `//article[1]/${parts.join('/')}`;
    },

    // Resolve an XPath string back to a DOM node
    resolve(path: string): Node | null {
        const match = path.match(/^\/\/article\[1\](?:\/(.+))?$/);
        if (!match) return null;

        let current: Node | null = document.querySelector('article.markdown-body');
        if (!current || !match[1]) return current;

        for (const segment of match[1].split('/')) {
            const tagMatch = segment.match(/^([A-Z0-9]+)\[(\d+)\]$/);
            if (!tagMatch) return null;

            const [, tagName, targetIndex] = tagMatch;
            let count = 0;
            let found: Node | null = null;

            for (const child of Array.from(current.childNodes)) {
                if (child.nodeName === tagName && !DOM.shouldSkip(child) && ++count === parseInt(targetIndex)) {
                    found = child;
                    break;
                }
            }
            if (!found) return null;
            current = found;
        }
        return current;
    },

    // Calculate absolute text offset within a parent element
    getAbsoluteOffset(container: Node, offset: number): number {
        const target: Node = container.nodeType === 3 ? (container.parentNode as Node) : container;
        let absoluteOffset = 0;

        if (container.nodeType === 3) {
            let node: Node | null = target.firstChild;
            while (node) {
                if (node === container) {
                    absoluteOffset += offset;
                    break;
                }
                absoluteOffset += node.nodeType === 3 ? (node as Text).length : (node.textContent ?? '').length;
                node = node.nextSibling;
            }
        } else {
            for (let i = 0; i < offset && i < container.childNodes.length; i++) {
                absoluteOffset += (container.childNodes[i].textContent ?? '').length;
            }
        }
        return absoluteOffset;
    },

    // Find the text node and relative offset from an absolute offset
    findNode(element: Node, absoluteOffset: number): FoundNode {
        let currentOffset = 0;
        let targetNode: Text | null = null;
        let relativeOffset = 0;
        let lastTextNode: Text | null = null;

        const walk = (node: Node): void => {
            if (targetNode) return;
            if (node.nodeType === 3) {
                const t = node as Text;
                lastTextNode = t;
                if (currentOffset + t.length >= absoluteOffset) {
                    targetNode = t;
                    relativeOffset = absoluteOffset - currentOffset;
                } else {
                    currentOffset += t.length;
                }
            } else if (node.nodeType === 1) {
                for (let child: Node | null = node.firstChild; child; child = child.nextSibling) {
                    walk(child);
                    if (targetNode) break;
                }
            }
        };

        walk(element);
        if (!targetNode && lastTextNode && currentOffset === absoluteOffset) {
            targetNode = lastTextNode;
            relativeOffset = (lastTextNode as Text).length;
        }
        return { node: targetNode, offset: relativeOffset };
    }
};
