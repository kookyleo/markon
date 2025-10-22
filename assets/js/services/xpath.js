/**
 * XPath 服务 - 纯技术，无业务逻辑
 */
import { CONFIG } from '../core/config.js';

const shouldSkip = (el) => {
    if (el.nodeType !== 1) return false;
    if (el.id && CONFIG.SKIP_ELEMENTS.IDS.has(el.id)) return true;
    if (el.className && typeof el.className === 'string') {
        return el.className.split(' ').some(cls => CONFIG.SKIP_ELEMENTS.CLASSES.has(cls));
    }
    return false;
};

export const XPath = {
    // 生成简单XPath
    create(node) {
        const parts = [];
        let current = node;
        while (current && current.nodeName !== 'ARTICLE') {
            let index = 1;
            for (let sibling = current.previousSibling; sibling; sibling = sibling.previousSibling) {
                if (sibling.nodeName === current.nodeName && !shouldSkip(sibling)) index++;
            }
            parts.unshift(`${current.nodeName}[${index}]`);
            current = current.parentNode;
        }
        return parts.length === 0 ? '//article[1]' : `//article[1]/${parts.join('/')}`;
    },

    // 通过XPath获取节点
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
                if (child.nodeName === tagName && !shouldSkip(child) && ++count === parseInt(targetIndex)) {
                    found = child;
                    break;
                }
            }
            if (!found) return null;
            current = found;
        }
        return current;
    },

    // 计算绝对偏移
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

    // 从绝对偏移查找节点
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
