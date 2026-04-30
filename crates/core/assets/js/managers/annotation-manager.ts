/**
 * AnnotationManager - Core annotation manager
 * Handles CRUD operations, DOM application, and XPath handling for annotations.
 *
 * The `Annotation` interface declared here is the canonical schema consumed
 * downstream by storage-manager, popover-manager, and the collaboration layer.
 */

import { Ids, Logger } from '../core/utils';
import { XPath } from '../services/xpath';
import { Text } from '../services/text';

/**
 * Annotation type union, matching the values produced by `main.js`:
 *  - `highlight-orange | highlight-green | highlight-yellow` — standard highlights
 *  - `strikethrough` — strikethrough mark
 *  - `has-note` — highlight with an attached note (still a span tag)
 *
 * These literals match `CONFIG.ANNOTATION_TYPES`.
 */
export type AnnotationType =
    | 'highlight-orange'
    | 'highlight-green'
    | 'highlight-yellow'
    | 'strikethrough'
    | 'has-note';

/**
 * Tag names used to wrap annotation ranges:
 *  - `span` for highlights / notes
 *  - `s`    for strikethrough
 *
 * Matches `CONFIG.HTML_TAGS`.
 */
export type AnnotationTagName = 'span' | 's';

/**
 * Canonical Annotation schema. Persisted by storage-manager,
 * round-tripped through WebSocket, and consumed by note-manager,
 * popover-manager, and collaboration-manager.
 */
export interface Annotation {
    /** Stable ID, prefixed `anno-`. */
    id: string;
    /** Visual / semantic type — see `AnnotationType`. */
    type: AnnotationType;
    /** HTML tag used to wrap the range. */
    tagName: AnnotationTagName;
    /** XPath of the start container's parent element. */
    startPath: string;
    /** Absolute character offset within `startPath`'s element. */
    startOffset: number;
    /** XPath of the end container's parent element. */
    endPath: string;
    /** Absolute character offset within `endPath`'s element. */
    endOffset: number;
    /** Original selected text (used for drift detection). */
    text: string;
    /** Optional attached note body. `null` when absent. */
    note: string | null;
    /** Creation timestamp (ms since epoch). */
    createdAt: number;
}

/** Storage strategy contract used by AnnotationManager. */
export interface AnnotationStorage {
    loadAnnotations(): Promise<Annotation[]>;
    saveAnnotation(annotation: Annotation): Promise<void>;
    deleteAnnotation(id: string): Promise<void>;
    clearAnnotations(): Promise<void>;
}

/** Action emitted via the `onChange` callback. */
export type AnnotationChangeAction = 'add' | 'delete' | 'clear';

/** Payload sent to the `onChange` callback. */
export interface AnnotationChangeEvent {
    action: AnnotationChangeAction;
    /** For `add`/`delete`: the affected annotation. For `clear`: the prior list. */
    data: Annotation | Annotation[];
    /** Snapshot of all annotations after the change. */
    annotations: Annotation[];
}

export type AnnotationChangeCallback = (event: AnnotationChangeEvent) => void;

export class AnnotationManager {
    #annotations: Annotation[] = [];
    #storage: AnnotationStorage;
    #markdownBody: HTMLElement;
    #onChange: AnnotationChangeCallback | null = null;

    constructor(storage: AnnotationStorage, markdownBody: HTMLElement) {
        this.#storage = storage;
        this.#markdownBody = markdownBody;
    }

    async load(): Promise<void> {
        this.#annotations = await this.#storage.loadAnnotations();
        Logger.log('AnnotationManager', `Loaded ${this.#annotations.length} annotations`);
    }

    getAll(): Annotation[] {
        return [...this.#annotations];
    }

    getById(id: string): Annotation | null {
        return this.#annotations.find(a => a.id === id) ?? null;
    }

    async add(annotation: Annotation, skipSave: boolean = false): Promise<void> {
        // Check是否已存在
        const existingIndex = this.#annotations.findIndex(a => a.id === annotation.id);

        if (existingIndex >= 0) {
            // Update现有注解
            this.#annotations[existingIndex] = annotation;
        } else {
            // 添加新注解
            this.#annotations.push(annotation);
        }

        // Save到Storage（除非是从 WebSocket 接收的）
        if (!skipSave) {
            await this.#storage.saveAnnotation(annotation);
        }

        // Trigger变更Callback
        this.#triggerChange('add', annotation);

        Logger.log('AnnotationManager', `Added annotation: ${annotation.id}${skipSave ? ' (from remote)' : ''}`);
    }

    async delete(id: string, skipSave: boolean = false): Promise<Annotation | null> {
        const index = this.#annotations.findIndex(a => a.id === id);
        if (index < 0) {
            Logger.warn('AnnotationManager', `Annotation not found: ${id}`);
            return null;
        }

        const deleted = this.#annotations[index];
        this.#annotations.splice(index, 1);

        // 从Storage中Delete（除非是从 WebSocket 接收的）
        if (!skipSave) {
            await this.#storage.deleteAnnotation(id);
        }

        // Trigger变更Callback
        this.#triggerChange('delete', deleted);

        Logger.log('AnnotationManager', `Deleted annotation: ${id}${skipSave ? ' (from remote)' : ''}`);
        return deleted;
    }

    async clear(skipSave: boolean = false): Promise<void> {
        const oldAnnotations = [...this.#annotations];
        this.#annotations = [];

        if (!skipSave) {
            await this.#storage.clearAnnotations();
        }

        this.#triggerChange('clear', oldAnnotations);

        Logger.log('AnnotationManager', `Cleared all annotations${skipSave ? ' (from remote)' : ''}`);
    }

    applyToDOM(annotationsToApply: Annotation[] | null = null): void {
        const annotations = annotationsToApply ?? this.#annotations;

        if (annotations.length === 0) {
            return;
        }

        // 按Path和偏移量Sort（从后向前Apply，避免偏移问题）
        const sorted = [...annotations].sort((a, b) => {
            if (a.startPath !== b.startPath) {
                return a.startPath.localeCompare(b.startPath);
            }
            return b.startOffset - a.startOffset;
        });

        sorted.forEach(anno => this.#applyAnnotation(anno));

        Logger.log('AnnotationManager', `Applied ${sorted.length} annotations to DOM`);
    }

    clearDOM(): void {
        this.#markdownBody.querySelectorAll<HTMLElement>('[data-annotation-id]').forEach(el => {
            const parent = el.parentNode;
            if (!parent) return;
            while (el.firstChild) {
                parent.insertBefore(el.firstChild, el);
            }
            parent.removeChild(el);
            (parent as Element).normalize?.();
        });

        Logger.log('AnnotationManager', 'Cleared annotations from DOM');
    }

    removeFromDOM(id: string): void {
        const elements = this.#markdownBody.querySelectorAll<HTMLElement>(`[data-annotation-id="${id}"]`);

        elements.forEach(el => {
            if (el.dataset.annotationId === id) {
                const parent = el.parentNode;
                if (!parent) return;

                // 将子Element移出
                while (el.firstChild) {
                    parent.insertBefore(el.firstChild, el);
                }

                // 移除Element
                parent.removeChild(el);
                (parent as Element).normalize?.();
            }
        });

        Logger.log('AnnotationManager', `Removed annotation from DOM: ${id}`);
    }

    createAnnotation(
        range: Range,
        type: AnnotationType,
        tagName: AnnotationTagName,
        note: string | null = null,
    ): Annotation {
        const getPathNode = (container: Node): Node => {
            return container.nodeType === 3 ? (container.parentNode as Node) : container;
        };

        const startPath = XPath.create(getPathNode(range.startContainer));
        const endPath = XPath.create(getPathNode(range.endContainer));

        return {
            id: `anno-${Ids.uuid()}`,
            type,
            tagName,
            startPath,
            startOffset: XPath.getAbsoluteOffset(range.startContainer, range.startOffset),
            endPath,
            endOffset: XPath.getAbsoluteOffset(range.endContainer, range.endOffset),
            text: range.toString(),
            note,
            createdAt: Date.now(),
        };
    }

    onChange(callback: AnnotationChangeCallback): void {
        this.#onChange = callback;
    }

    #applyAnnotation(anno: Annotation): void {
        // Check是否已存在
        const existing = this.#markdownBody.querySelector(`[data-annotation-id="${anno.id}"]`);
        if (existing) {
            return;  // 已存在，Skip
        }

        const startNode = XPath.resolve(anno.startPath);
        const endNode = XPath.resolve(anno.endPath);

        if (!startNode || !endNode) {
            Logger.warn('AnnotationManager', `XPath nodes not found for annotation: ${anno.id}`);
            return;
        }

        try {
            // Validate偏移量
            const startTextLen = (startNode.textContent ?? '').length;
            const endTextLen = (endNode.textContent ?? '').length;
            if (anno.startOffset > startTextLen || anno.endOffset > endTextLen) {
                Logger.warn('AnnotationManager', `Invalid offset for annotation: ${anno.id}`);
                return;
            }

            // FindTextNode和偏移量
            const start = XPath.findNode(startNode, anno.startOffset);
            const end = XPath.findNode(endNode, anno.endOffset);

            if (!start.node || !end.node) {
                Logger.warn('AnnotationManager', `Text nodes not found for annotation: ${anno.id}`);
                return;
            }

            // Create范围
            const range = document.createRange();
            range.setStart(start.node, start.offset);
            range.setEnd(end.node, end.offset);

            // ValidateTextContent
            const storedText = Text.normalize(anno.text);
            const currentText = Text.normalize(range.toString());

            if (currentText !== storedText) {
                Logger.warn('AnnotationManager', `Text mismatch for annotation ${anno.id}:`, {
                    stored: storedText,
                    current: currentText,
                });
                return;
            }

            // CreateElement
            const element = document.createElement(anno.tagName);
            element.className = anno.type;
            element.dataset.annotationId = anno.id;

            if (anno.note) {
                element.dataset.note = anno.note;
                element.classList.add('has-note');
            }

            // Apply到 DOM
            element.appendChild(range.extractContents());
            range.insertNode(element);

        } catch (error) {
            Logger.error('AnnotationManager', `Failed to apply annotation ${anno.id}:`, error);
        }
    }

    #triggerChange(action: AnnotationChangeAction, data: Annotation | Annotation[]): void {
        if (this.#onChange) {
            this.#onChange({
                action,
                data,
                annotations: this.getAll(),
            });
        }
    }
}
