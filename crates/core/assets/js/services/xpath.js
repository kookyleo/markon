/**
 * XPath service - pure technical, no business logic
 */
import { DOM } from './dom.js';

export const XPath = {
    // Generate simple XPath
    create(node) {
        const parts = [];
        let current = node;
        while (current && current.nodeName !== 'ARTICLE') {
            let index = 1;
            for (let sibling = current.previousSibling; sibling; sibling = sibling.previousSibling) {
                if (sibling.nodeName === current.nodeName && !DOM.shouldSkip(sibling)) index++;
            }
            parts.unshift(`${current.nodeName}[${index}]`);
            current = current.parentNode;
        }
        return parts.length === 0 ? '//article[1]' : `//article[1]/${parts.join('/')}`;
    },

    // Resolve an XPath string back to a DOM node
    resolve(path) {
        const match = path.match(/^\/\/article\[1\](?:\/(.+))?$/);
        if (!match) return null;

        let current = document.querySelector('article.markdown-body');
        if (!current || !match[1]) return current;

        for (const segment of match[1].split('/')) {
            const tagMatch = segment.match(/^([A-Z0-9]+)\[(\d+)\]$/);
            if (!tagMatch) return null;

            const [, tagName, targetIndex] = tagMatch;
            let count = 0, found = null;

            for (const child of current.childNodes) {
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
    getAbsoluteOffset(container, offset) {
        const target = container.nodeType === 3 ? container.parentNode : container;
        let absoluteOffset = 0;

        if (container.nodeType === 3) {
            let node = target.firstChild;
            while (node) {
                if (node === container) {
                    absoluteOffset += offset;
                    break;
                }
                absoluteOffset += node.nodeType === 3 ? node.length : node.textContent.length;
                node = node.nextSibling;
            }
        } else {
            for (let i = 0; i < offset && i < container.childNodes.length; i++) {
                absoluteOffset += container.childNodes[i].textContent.length;
            }
        }
        return absoluteOffset;
    },

    // Find the text node and relative offset from an absolute offset
    findNode(element, absoluteOffset) {
        let currentOffset = 0, targetNode = null, relativeOffset = 0, lastTextNode = null;

        const walk = (node) => {
            if (targetNode) return;
            if (node.nodeType === 3) {
                lastTextNode = node;
                if (currentOffset + node.length >= absoluteOffset) {
                    targetNode = node;
                    relativeOffset = absoluteOffset - currentOffset;
                } else {
                    currentOffset += node.length;
                }
            } else if (node.nodeType === 1) {
                for (let child = node.firstChild; child; child = child.nextSibling) {
                    walk(child);
                    if (targetNode) break;
                }
            }
        };

        walk(element);
        if (!targetNode && lastTextNode && currentOffset === absoluteOffset) {
            targetNode = lastTextNode;
            relativeOffset = lastTextNode.length;
        }
        return { node: targetNode, offset: relativeOffset };
    }
};
