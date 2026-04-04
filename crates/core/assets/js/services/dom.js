/**
 * DOM service - pure technical, no business logic
 */
import { CONFIG } from '../core/config.js';

export const DOM = {
    // Get block-level parent element
    getBlockParent(node, container) {
        let current = node.nodeType === 3 ? node.parentElement : node;
        while (current && current !== container) {
            if (CONFIG.BLOCK_TAGS.includes(current.tagName)) return current;
            current = current.parentElement;
        }
        return null;
    },

    // Find最后一个TextNode
    findLastTextNode(element) {
        let lastText = null;
        const walk = (node) => {
            if (node.nodeType === 3 && node.textContent.trim()) {
                lastText = node;
            } else if (node.nodeType === 1) {
                for (let child of node.childNodes) walk(child);
            }
        };
        walk(element);
        return lastText;
    },

    // CheckElement是否应Skip
    shouldSkip(element) {
        if (element.nodeType !== 1) return false;
        if (element.id && CONFIG.SKIP_ELEMENTS.IDS.has(element.id)) return true;
        if (element.className && typeof element.className === 'string') {
            return element.className.split(' ').some(cls => CONFIG.SKIP_ELEMENTS.CLASSES.has(cls));
        }
        return false;
    },

    // 安全Get高度
    getHeight(element, fallback = 80) {
        const height = element.offsetHeight;
        return height > 0 ? height : fallback;
    }
};
