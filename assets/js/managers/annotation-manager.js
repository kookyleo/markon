/**
 * AnnotationManager - 核心注解管理器
 * 负责注解的 CRUD 操作、DOM 应用、XPath 处理
 */

import { CONFIG } from '../core/config.js';
import { Logger } from '../core/utils.js';
import { XPath } from '../services/xpath.js';
import { Text } from '../services/text.js';

export class AnnotationManager {
    #annotations = [];
    #storage;
    #markdownBody;
    #onChange = null;

    constructor(storage, markdownBody) {
        this.#storage = storage;
        this.#markdownBody = markdownBody;
    }

    async load() {
        this.#annotations = await this.#storage.loadAnnotations();
        Logger.log('AnnotationManager', `Loaded ${this.#annotations.length} annotations`);
    }

    getAll() {
        return [...this.#annotations];
    }

    getById(id) {
        return this.#annotations.find(a => a.id === id) || null;
    }

    async add(annotation, skipSave = false) {
        // 检查是否已存在
        const existingIndex = this.#annotations.findIndex(a => a.id === annotation.id);

        if (existingIndex >= 0) {
            // 更新现有注解
            this.#annotations[existingIndex] = annotation;
        } else {
            // 添加新注解
            this.#annotations.push(annotation);
        }

        // 保存到存储（除非是从 WebSocket 接收的）
        if (!skipSave) {
            await this.#storage.saveAnnotation(annotation);
        }

        // 触发变更回调
        this.#triggerChange('add', annotation);

        Logger.log('AnnotationManager', `Added annotation: ${annotation.id}${skipSave ? ' (from remote)' : ''}`);
    }

    async delete(id, skipSave = false) {
        const index = this.#annotations.findIndex(a => a.id === id);
        if (index < 0) {
            Logger.warn('AnnotationManager', `Annotation not found: ${id}`);
            return null;
        }

        const deleted = this.#annotations[index];
        this.#annotations.splice(index, 1);

        // 从存储中删除（除非是从 WebSocket 接收的）
        if (!skipSave) {
            await this.#storage.deleteAnnotation(id);
        }

        // 触发变更回调
        this.#triggerChange('delete', deleted);

        Logger.log('AnnotationManager', `Deleted annotation: ${id}${skipSave ? ' (from remote)' : ''}`);
        return deleted;
    }

    async clear(skipSave = false) {
        const oldAnnotations = [...this.#annotations];
        this.#annotations = [];

        if (!skipSave) {
            await this.#storage.clearAnnotations();
        }

        this.#triggerChange('clear', oldAnnotations);

        Logger.log('AnnotationManager', `Cleared all annotations${skipSave ? ' (from remote)' : ''}`);
    }

    applyToDOM(annotationsToApply = null) {
        const annotations = annotationsToApply || this.#annotations;

        if (annotations.length === 0) {
            return;
        }

        // 按路径和偏移量排序（从后向前应用，避免偏移问题）
        const sorted = [...annotations].sort((a, b) => {
            if (a.startPath !== b.startPath) {
                return a.startPath.localeCompare(b.startPath);
            }
            return b.startOffset - a.startOffset;
        });

        sorted.forEach(anno => this.#applyAnnotation(anno));

        Logger.log('AnnotationManager', `Applied ${sorted.length} annotations to DOM`);
    }

    clearDOM() {
        this.#markdownBody.querySelectorAll('[data-annotation-id]').forEach(el => {
            const parent = el.parentNode;
            while (el.firstChild) {
                parent.insertBefore(el.firstChild, el);
            }
            parent.removeChild(el);
            parent.normalize();
        });

        Logger.log('AnnotationManager', 'Cleared annotations from DOM');
    }

    removeFromDOM(id) {
        const elements = this.#markdownBody.querySelectorAll(`[data-annotation-id="${id}"]`);

        elements.forEach(el => {
            if (el.dataset.annotationId === id) {
                const parent = el.parentNode;

                // 将子元素移出
                while (el.firstChild) {
                    parent.insertBefore(el.firstChild, el);
                }

                // 移除元素
                parent.removeChild(el);
                parent.normalize();
            }
        });

        Logger.log('AnnotationManager', `Removed annotation from DOM: ${id}`);
    }

    createAnnotation(range, type, tagName, note = null) {
        const getPathNode = (container) => {
            return container.nodeType === 3 ? container.parentNode : container;
        };

        const startPath = XPath.create(getPathNode(range.startContainer));
        const endPath = XPath.create(getPathNode(range.endContainer));

        return {
            id: `anno-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type: type,
            tagName: tagName,
            startPath: startPath,
            startOffset: XPath.getAbsoluteOffset(range.startContainer, range.startOffset),
            endPath: endPath,
            endOffset: XPath.getAbsoluteOffset(range.endContainer, range.endOffset),
            text: range.toString(),
            note: note,
            createdAt: Date.now()
        };
    }

    onChange(callback) {
        this.#onChange = callback;
    }

    #applyAnnotation(anno) {
        // 检查是否已存在
        const existing = this.#markdownBody.querySelector(`[data-annotation-id="${anno.id}"]`);
        if (existing) {
            return;  // 已存在，跳过
        }

        const startNode = XPath.resolve(anno.startPath);
        const endNode = XPath.resolve(anno.endPath);

        if (!startNode || !endNode) {
            Logger.warn('AnnotationManager', `XPath nodes not found for annotation: ${anno.id}`);
            return;
        }

        try {
            // 验证偏移量
            if (anno.startOffset > startNode.textContent.length ||
                anno.endOffset > endNode.textContent.length) {
                Logger.warn('AnnotationManager', `Invalid offset for annotation: ${anno.id}`);
                return;
            }

            // 查找文本节点和偏移量
            const start = XPath.findNode(startNode, anno.startOffset);
            const end = XPath.findNode(endNode, anno.endOffset);

            if (!start.node || !end.node) {
                Logger.warn('AnnotationManager', `Text nodes not found for annotation: ${anno.id}`);
                return;
            }

            // 创建范围
            const range = document.createRange();
            range.setStart(start.node, start.offset);
            range.setEnd(end.node, end.offset);

            // 验证文本内容
            const storedText = Text.normalize(anno.text);
            const currentText = Text.normalize(range.toString());

            if (currentText !== storedText) {
                Logger.warn('AnnotationManager', `Text mismatch for annotation ${anno.id}:`, {
                    stored: storedText,
                    current: currentText
                });
                return;
            }

            // 创建元素
            const element = document.createElement(anno.tagName);
            element.className = anno.type;
            element.dataset.annotationId = anno.id;

            if (anno.note) {
                element.dataset.note = anno.note;
                element.classList.add('has-note');
            }

            // 应用到 DOM
            element.appendChild(range.extractContents());
            range.insertNode(element);

        } catch (error) {
            Logger.error('AnnotationManager', `Failed to apply annotation ${anno.id}:`, error);
        }
    }

    #triggerChange(action, data) {
        if (this.#onChange) {
            this.#onChange({
                action,
                data,
                annotations: this.getAll()
            });
        }
    }
}
