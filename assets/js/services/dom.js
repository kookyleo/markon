/**
 * DOM 服务 - 纯技术，无业务逻辑
 */
import { CONFIG } from '../core/config.js';

export const DOM = {
    // 获取块级父元素
    getBlockParent(node, container) {
        let current = node.nodeType === 3 ? node.parentElement : node;
        while (current && current !== container) {
            if (CONFIG.BLOCK_TAGS.includes(current.tagName)) return current;
            current = current.parentElement;
        }
        return null;
    },

    // 查找最后一个文本节点
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

    // 检查元素是否应跳过
    shouldSkip(element) {
        if (element.nodeType !== 1) return false;
        if (element.id && CONFIG.SKIP_ELEMENTS.IDS.has(element.id)) return true;
        if (element.className && typeof element.className === 'string') {
            return element.className.split(' ').some(cls => CONFIG.SKIP_ELEMENTS.CLASSES.has(cls));
        }
        return false;
    },

    // 安全获取高度
    getHeight(element, fallback = 80) {
        const height = element.offsetHeight;
        return height > 0 ? height : fallback;
    }
};
