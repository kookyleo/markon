/**
 * ExportManager — note export entrypoint.
 *
 * Notes are rendered straight into the export editor. Any trimming or omission
 * can be done in that Markdown buffer before copying/downloading.
 */

import { Logger } from '../core/utils';
import {
    type AnnotationManager,
} from './annotation-manager';
import { EditorManager } from './editor-manager';

export interface ExportManagerDeps {
    annotationManager: AnnotationManager;
    /** Document title used for the export heading + default download filename. */
    getDocumentTitle: () => string;
    /** Source file path (only used to construct the editor instance). */
    getFilePath: () => string;
}

export class ExportManager {
    #deps: ExportManagerDeps;
    #editor: EditorManager | null = null;

    constructor(deps: ExportManagerDeps) {
        this.#deps = deps;
    }

    /** Currently mounted? */
    isOpen(): boolean {
        return this.#editor?.isOpen() ?? false;
    }

    /**
     * Open the export editor with all notes on the page. Returns false when the
     * page has no notes, so the caller can flash the "empty" hint.
     */
    open(): boolean {
        const ids = this.#noteIds();
        if (ids.length === 0) return false;
        const title = this.#deps.getDocumentTitle();
        const markdown = this.#deps.annotationManager.formatAsMarkdown({
            ids,
        });
        if (!markdown.trim()) return false;

        if (!this.#editor) {
            this.#editor = new EditorManager(this.#deps.getFilePath());
        }
        void this.#editor.open({
            mode: 'export',
            content: markdown,
            exportFileName: title || 'notes',
        });
        Logger.log('ExportManager', `Export editor opened with ${ids.length} notes`);
        return true;
    }

    close(): void {
        this.#editor?.close();
    }

    #noteIds(): string[] {
        return this.#deps.annotationManager.getAllInDocumentOrder()
            .filter(a => !!a.note && a.note.trim() !== '')
            .map(a => a.id);
    }
}
