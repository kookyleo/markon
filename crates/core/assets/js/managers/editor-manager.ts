/**
 * EditorManager - Markdown source editor
 * Provides a CodeMirror-powered in-browser Markdown editor
 */

import type { Text as CodeMirrorText } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { CreateMarkdownEditor } from '../editor-codemirror';
import { CONFIG, i18n } from '../core/config';
import { Logger } from '../core/utils';
import { Meta } from '../services/dom';
import { Text } from '../services/text';
import { downloadTextFile, toMarkdownFilename } from '../core/download';
import { copyText, flashText } from '../core/clipboard';

const _t = (key: string, ...args: unknown[]): string => i18n.t(key, ...args);

const SPLIT_KEY = 'markon.editor.split';
const LAYOUT_KEY = 'markon.editor.layout'; // 'split' | 'full'

/** Layout mode for the split-pane editor. */
export type EditorLayout = 'split' | 'full';

/** Narrow-screen tab state. */
export type EditorTab = 'edit' | 'preview';

/**
 * Editor mode:
 *  - `edit`   — bound to the source file; Save writes back to the server.
 *  - `export` — ephemeral buffer seeded from a string (notes export);
 *               Save downloads a local `.md`, plus a Copy button, and closing
 *               does not reload the page or write to the server.
 */
export type EditorMode = 'edit' | 'export';

/** Optional configuration accepted by `EditorManager.open()`. */
export interface EditorOpenOptions {
    /** Text to find and select in editor. */
    selectedText?: string;
    /** Line number to jump to (1-based). */
    line?: number;
    /** Editor mode (defaults to `edit`). */
    mode?: EditorMode;
    /** Initial content for `export` mode (used instead of fetching the file). */
    content?: string;
    /** Editable first-line + default download filename for `export` mode. */
    exportFileName?: string;
    /** Optional callback for a caller-owned "Back" action in `export` mode. */
    onBack?: () => void;
}

/** Request body sent to POST /api/save. */
export interface EditorSaveRequest {
    workspace_id: string;
    file_path: string;
    content: string;
}

/** Response shape from POST /api/save. */
export interface EditorSaveResponse {
    success: boolean;
    message?: string;
}

/** Request body sent to POST /api/preview. */
export interface EditorPreviewRequest {
    workspace_id: string;
    content: string;
}

/** Response shape from POST /api/preview. */
export interface EditorPreviewResponse {
    html: string;
    has_math?: boolean;
}

export class EditorManager {
    #filePath: string;
    #editorModal: HTMLElement | null = null;
    #editorView: EditorView | null = null;
    #saveButton: HTMLButtonElement | null = null;
    #closeButton: HTMLButtonElement | null = null;
    #isDirty = false;
    /** Last-saved (or initially loaded) persistent document for dirty comparison. */
    #baselineDoc: CodeMirrorText | null = null;
    #previewPane: HTMLElement | null = null;
    #previewDebounceId: ReturnType<typeof setTimeout> | null = null;
    #previewAbort: AbortController | null = null;
    #previewRevision = 0;
    #mathRendererPromise: Promise<void> | null = null;
    /** narrow-screen tab state */
    #activeTab: EditorTab = 'edit';
    #layout: EditorLayout = 'split';
    #isSyncingScroll = false;
    /** function to remove scroll listeners */
    #scrollSyncCleanup: (() => void) | null = null;
    /** Current mode — `export` repurposes Save as a local download. */
    #mode: EditorMode = 'edit';
    /** Default download filename and fallback when the editable first line is blank. */
    #exportFileName = 'notes.md';
    /** Optional back callback in export mode. */
    #onBack: (() => void) | null = null;
    /** Aborts the document/window listeners installed while the modal is open. */
    #listenerAbort: AbortController | null = null;
    /** Coalesces callers while the lazy editor runtime is loading. */
    #openingPromise: Promise<void> | null = null;
    /** Prevents overlapping writes from completing out of order. */
    #savePromise: Promise<void> | null = null;
    /** Invalidates async work when an editor session closes or is superseded. */
    #sessionId = 0;

    #listenerOptions(extra: AddEventListenerOptions = {}): AddEventListenerOptions {
        const signal = this.#listenerAbort?.signal;
        return signal ? { ...extra, signal } : extra;
    }

    constructor(filePath: string) {
        this.#filePath = filePath;
        Logger.log('EditorManager', 'Initialized for file:', filePath);
    }

    /** Has the buffer diverged from the last-saved baseline? */
    isDirty(): boolean {
        return this.#isDirty;
    }

    /** Is the editor open or still loading its lazy runtime? */
    isOpen(): boolean {
        return this.#editorModal !== null || this.#openingPromise !== null;
    }

    /**
     * Open the editor.
     */
    async open(options: EditorOpenOptions = {}): Promise<void> {
        if (this.#editorModal) {
            this.#applyOpenTarget(options);
            return;
        }

        const pendingOpen = this.#openingPromise;
        if (pendingOpen) {
            await pendingOpen;
            if (this.#editorModal) this.#applyOpenTarget(options);
            return;
        }

        const sessionId = ++this.#sessionId;
        const openingPromise = this.#openSession(options, sessionId);
        this.#openingPromise = openingPromise;
        try {
            await openingPromise;
        } finally {
            if (this.#openingPromise === openingPromise) {
                this.#openingPromise = null;
            }
        }
    }

    async #openSession(options: EditorOpenOptions, sessionId: number): Promise<void> {
        this.#mode = options.mode ?? 'edit';
        this.#onBack = options.onBack ?? null;
        this.#activeTab = 'edit';

        let content: string | null;
        if (this.#mode === 'export') {
            // Ephemeral buffer: seed from the supplied string, never touch the
            // file or the `#original-markdown-data` blob. The filename lives
            // on the first line so selecting/copying the whole editor includes
            // both the source name and its exported notes.
            this.#exportFileName = toMarkdownFilename(options.exportFileName);
            content = `${this.#exportFileName}\n\n${options.content ?? ''}`;
        } else {
            content = await this.#fetchCurrentContent();
            if (sessionId !== this.#sessionId) return;
            if (content === null) {
                Logger.error('EditorManager', 'Failed to fetch file content');
                alert('Failed to load file content. Please ensure edit feature is enabled.');
                return;
            }
        }

        // CodeMirror is intentionally a lazy chunk so read-only page loads do
        // not pay the editor engine's download/parse cost.
        let createMarkdownEditor: CreateMarkdownEditor;
        try {
            ({ createMarkdownEditor } = await import('../editor-codemirror'));
        } catch (error) {
            if (sessionId !== this.#sessionId) return;
            Logger.error('EditorManager', 'Failed to load editor runtime:', error);
            alert('Failed to initialize the Markdown editor.');
            return;
        }
        if (sessionId !== this.#sessionId) return;

        // Create editor UI
        this.#createEditorUI(content, createMarkdownEditor);
        this.#setupEventListeners();
        // Lock the background page so the wheel can't scroll it behind the
        // full-screen editor.
        document.documentElement.classList.add('markon-scroll-lock');

        this.#applyOpenTarget(options);

        Logger.log('EditorManager', `Editor opened (${this.#mode} mode)`);
    }

    #applyOpenTarget(options: EditorOpenOptions): void {
        if (options.line && options.line > 0) {
            this.#gotoLine(options.line);
        } else if (options.selectedText?.trim()) {
            this.#selectText(options.selectedText.trim());
        } else {
            this.#focusEditor();
        }
    }

    /**
     * Close the editor.
     */
    close(): void {
        if (!this.#editorModal) {
            if (this.#openingPromise) {
                ++this.#sessionId;
                this.#openingPromise = null;
            }
            return;
        }

        // In `edit` mode, unsaved changes risk data loss → confirm. In
        // `export` mode the buffer is a throwaway copy, so just close.
        if (this.#mode === 'edit' && this.#isDirty) {
            const confirmClose = confirm('You have unsaved changes. Close anyway?');
            if (!confirmClose) return;
        }

        ++this.#sessionId;
        this.#openingPromise = null;
        this.#savePromise = null;
        this.#previewAbort?.abort();
        this.#previewAbort = null;
        ++this.#previewRevision;

        // Clean up event listeners
        document.removeEventListener('keydown', this.#handleEscapeKey);
        if (this.#scrollSyncCleanup) {
            this.#scrollSyncCleanup();
            this.#scrollSyncCleanup = null;
        }
        // Remove the document/window listeners (divider drag, resize
        // handlers) installed by the editor UI.
        this.#listenerAbort?.abort();
        this.#listenerAbort = null;
        // Closing mid-drag aborts the mouseup listener that would have
        // restored these — reset them here so the page stays usable.
        document.body.style.cursor = '';
        document.body.style.userSelect = '';

        if (this.#previewDebounceId !== null) {
            clearTimeout(this.#previewDebounceId);
            this.#previewDebounceId = null;
        }
        const wasExport = this.#mode === 'export';
        this.#editorView?.destroy();
        this.#editorView = null;
        this.#editorModal.remove();
        this.#editorModal = null;
        document.documentElement.classList.remove('markon-scroll-lock');
        this.#saveButton = null;
        this.#closeButton = null;
        this.#previewPane = null;
        this.#isDirty = false;
        this.#baselineDoc = null;
        this.#activeTab = 'edit';
        this.#onBack = null;

        // Edit mode reloads to re-render the just-saved file; export mode
        // is a non-destructive overlay, so leave the page as-is.
        if (!wasExport) {
            window.location.reload();
        }

        Logger.log('EditorManager', 'Editor closed');
    }

    /**
     * Save the file.
     */
    async save(): Promise<void> {
        const editorView = this.#editorView;
        if (!editorView) return;

        const savedDoc = editorView.state.doc;
        const content = savedDoc.toString();

        // Export mode: "Save" means download a local .md, never hit the server.
        if (this.#mode === 'export') {
            const exported = this.#readExportDocument(content);
            downloadTextFile(exported.fileName, exported.content);
            if (this.#saveButton) flashText(this.#saveButton, _t('web.export.downloaded'));
            this.#baselineDoc = savedDoc;
            this.#isDirty = false;
            return;
        }

        const pendingSave = this.#savePromise;
        if (pendingSave) {
            await pendingSave;
            return;
        }

        const sessionId = this.#sessionId;
        const savePromise = this.#savePersistentDocument(content, savedDoc, sessionId);
        this.#savePromise = savePromise;
        try {
            await savePromise;
        } finally {
            if (this.#savePromise === savePromise) {
                this.#savePromise = null;
            }
        }
    }

    async #savePersistentDocument(
        content: string,
        savedDoc: CodeMirrorText,
        sessionId: number,
    ): Promise<void> {
        this.#setSaving(true);
        try {
            const success = await this.#saveToServer(content);
            if (!success || sessionId !== this.#sessionId) return;

            const editorView = this.#editorView;
            if (!editorView) return;

            // Only the document sent to the server becomes the baseline. Edits
            // made while the request was in flight must remain visibly dirty.
            this.#baselineDoc = savedDoc;
            this.#isDirty = !editorView.state.doc.eq(savedDoc);
            this.#updateSaveButtonState();
            this.#updateTitleDirtyIndicator();
        } finally {
            if (sessionId === this.#sessionId) {
                this.#setSaving(false);
            }
        }
    }

    async #fetchCurrentContent(): Promise<string | null> {
        try {
            const el = document.getElementById('original-markdown-data');
            if (el) {
                return JSON.parse(el.textContent ?? '""') as string;
            }

            Logger.warn('EditorManager', 'Original Markdown not found in page');
            return '';
        } catch (error) {
            Logger.error('EditorManager', 'Error fetching content:', error);
            return null;
        }
    }

    async #saveToServer(content: string): Promise<boolean> {
        try {
            const workspaceId = Meta.get(CONFIG.META_TAGS.WORKSPACE_ID) ?? '';
            const token = Meta.get('save-token') ?? '';
            const body: EditorSaveRequest = {
                workspace_id: workspaceId,
                file_path: this.#filePath,
                content,
            };
            const response = await fetch('/api/save', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Markon-Token': token,
                },
                body: JSON.stringify(body),
            });

            if (!response.ok) {
                const text = await response.text();
                Logger.error('EditorManager', 'Save failed:', response.status, text);
                this.#showErrorAlert(text || `Server error (${response.status})`);
                return false;
            }

            const result = (await response.json()) as EditorSaveResponse;

            if (result.success) {
                Logger.log('EditorManager', 'File saved successfully');
                return true;
            } else {
                Logger.error('EditorManager', 'Save failed:', result.message);
                this.#showErrorAlert(result.message ?? '');
                return false;
            }
        } catch (error) {
            Logger.error('EditorManager', 'Save error:', error);
            const message = error instanceof Error ? error.message : String(error);
            alert(`Error saving file: ${message}`);
            return false;
        }
    }

    #showErrorAlert(message: string): void {
        if (message.includes('read-only')) {
            alert(_t('web.editor.err.readonly'));
        } else if (message.includes('Access denied')) {
            alert(_t('web.editor.err.denied'));
        } else if (message.includes('not enabled')) {
            alert(_t('web.editor.err.disabled'));
        } else if (message.includes('Only Markdown')) {
            alert(_t('web.editor.err.notmd'));
        } else {
            alert(`${_t('web.editor.err.save')}${message}`);
        }
    }

    #createEditorUI(content: string, createMarkdownEditor: CreateMarkdownEditor): void {
        const isExport = this.#mode === 'export';
        // Export mode swaps the file-bound Save for a Copy + Download pair and
        // can show a Back button when a caller supplies one.
        const backBtn = isExport && this.#onBack
            ? `<button class="editor-back-btn">${_t('web.export.back')}</button>`
            : '';
        const copyBtn = isExport
            ? `<button class="editor-copy-btn">${_t('web.export.copytext')}</button>`
            : '';
        const saveBtn = isExport
            ? `<button class="editor-save-btn editor-download-btn">${_t('web.export.download')}</button>`
            : `<button class="editor-save-btn" style="display: none;">${_t('web.editor.save')}</button>`;
        const headerTitle = isExport ? _t('web.export.label') : this.#filePath;

        const modal = document.createElement('div');
        modal.className = isExport ? 'editor-modal editor-modal-export' : 'editor-modal';
        modal.innerHTML = `
            <div class="editor-header">
                <button class="editor-close" title="${_t('web.editor.close.tip')}">✕</button>
                ${backBtn}
                <span class="editor-file-name">${Text.escape(headerTitle)}</span>
                <div class="editor-tab-bar">
                    <button class="editor-tab editor-tab-edit active" data-tab="edit">Edit</button>
                    <button class="editor-tab editor-tab-preview" data-tab="preview">Preview</button>
                </div>
                <div class="editor-layout-toggle" title="Toggle layout">
                    <button class="editor-layout-btn" data-layout="split" title="Split view">
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                            <rect x="1" y="2" width="6" height="12" rx="1" stroke="currentColor" stroke-width="1.5"/>
                            <rect x="9" y="2" width="6" height="12" rx="1" stroke="currentColor" stroke-width="1.5"/>
                        </svg>
                    </button>
                    <button class="editor-layout-btn" data-layout="full" title="Full-width editor">
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                            <rect x="1" y="2" width="14" height="12" rx="1" stroke="currentColor" stroke-width="1.5"/>
                        </svg>
                    </button>
                </div>
                ${copyBtn}
                ${saveBtn}
            </div>
            <div class="editor-body">
                <div class="editor-split">
                    <div class="editor-pane editor-pane-source">
                        <div class="editor-codemirror"></div>
                    </div>
                    <div class="editor-split-divider" title="Drag to resize"></div>
                    <div class="editor-pane editor-pane-preview">
                        <div class="editor-preview-content markdown-body"></div>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        this.#editorModal = modal;
        this.#saveButton = modal.querySelector<HTMLButtonElement>('.editor-save-btn');
        this.#closeButton = modal.querySelector<HTMLButtonElement>('.editor-close');
        this.#previewPane = modal.querySelector<HTMLElement>('.editor-preview-content');

        const editorHost = modal.querySelector<HTMLElement>('.editor-codemirror');
        if (editorHost) {
            this.#editorView = createMarkdownEditor(editorHost, content, {
                onDocumentChanged: doc => this.#handleDocumentChanged(doc),
                onSave: () => { void this.save(); },
                onSelectionChanged: () => this.#refreshCopyLabel(),
            });
            this.#baselineDoc = this.#editorView.state.doc;
        }

        // Restore saved split position
        this.#restoreSplit();

        // Scopes all document/window listeners below to the modal's lifetime
        this.#listenerAbort = new AbortController();

        // Setup draggable divider
        this.#setupDivider();

        // Setup narrow-screen tabs
        this.#setupTabs();

        // Initial preview render
        this.#schedulePreviewUpdate(0);

        // Restore layout preference and setup toggle
        this.#restoreLayout();
        this.#setupLayoutToggle();
        // Setup proportional scroll sync (split mode only)
        this.#setupScrollSync();
    }

    #setupEventListeners(): void {
        // Close button
        this.#closeButton?.addEventListener('click', () => {
            this.close();
        });

        // Save button (in export mode this downloads a local .md)
        this.#saveButton?.addEventListener('click', () => {
            void this.save();
        });

        // Export-mode Copy button. Label + payload follow the editor
        // selection: nothing selected → "Copy text" copies the whole buffer;
        // a selection → "Copy selection" copies just that range.
        const copyBtn = this.#editorModal?.querySelector<HTMLButtonElement>('.editor-copy-btn');
        copyBtn?.addEventListener('click', () => {
            const view = this.#editorView;
            if (!view || !copyBtn) return;
            const selection = view.state.selection.main;
            const content = selection.empty
                ? view.state.doc.toString()
                : view.state.sliceDoc(selection.from, selection.to);
            void copyText(content).then(ok => {
                copyBtn.textContent = _t(ok ? 'web.export.copied' : 'web.export.failed');
                copyBtn.classList.add('is-flashing');
                window.setTimeout(() => {
                    copyBtn.classList.remove('is-flashing');
                    this.#refreshCopyLabel();
                }, 1500);
            });
        });
        this.#refreshCopyLabel();

        // Export-mode Back button: close this overlay and return to the caller.
        this.#editorModal
            ?.querySelector<HTMLButtonElement>('.editor-back-btn')
            ?.addEventListener('click', () => {
                const back = this.#onBack;
                this.close();
                back?.();
            });

        // Esc to close
        document.addEventListener('keydown', this.#handleEscapeKey);
    }

    #handleEscapeKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape' && this.#editorModal) {
            this.close();
        }
    };

    #handleDocumentChanged(doc: CodeMirrorText): void {
        // Text.eq compares CodeMirror's persistent tree directly, avoiding a
        // full document string allocation on every keystroke.
        this.#isDirty = this.#baselineDoc === null || !doc.eq(this.#baselineDoc);
        this.#updateSaveButtonState();
        this.#updateTitleDirtyIndicator();
        this.#schedulePreviewUpdate(150);
    }

    #refreshCopyLabel(): void {
        const copyBtn = this.#editorModal?.querySelector<HTMLButtonElement>('.editor-copy-btn');
        const selection = this.#editorView?.state.selection.main;
        if (copyBtn) {
            copyBtn.textContent = _t(selection && !selection.empty
                ? 'web.export.copyselection'
                : 'web.export.copytext');
        }
    }

    /**
     * Read the editable export document. Its first line doubles as the
     * download filename and visible Markdown content, so copying, previewing,
     * and downloading all operate on the exact same buffer.
     */
    #readExportDocument(source: string): { fileName: string; content: string } {
        const firstLineEnd = source.indexOf('\n');
        const rawFileName = firstLineEnd === -1 ? source : source.slice(0, firstLineEnd);
        const fallback = this.#exportFileName.replace(/\.md$/i, '') || 'notes';
        const fileName = toMarkdownFilename(rawFileName, fallback);
        return { fileName, content: source };
    }

    #focusEditor(): void {
        if (this.#editorView) {
            this.#editorView.focus();
            this.#editorView.dispatch({ selection: { anchor: 0 } });
        }
    }

    #updateSaveButtonState(): void {
        // Export mode keeps the Download button permanently visible.
        if (this.#mode === 'export') return;
        if (this.#saveButton) {
            if (this.#isDirty) {
                this.#saveButton.style.display = 'block';
                this.#saveButton.classList.add('has-changes');
            } else {
                this.#saveButton.style.display = 'none';
                this.#saveButton.classList.remove('has-changes');
            }
        }
    }

    #updateTitleDirtyIndicator(): void {
        // Export mode shows a download filename, not the live source path.
        if (this.#mode === 'export') return;
        const fileNameElement = this.#editorModal?.querySelector('.editor-file-name');
        if (!fileNameElement) return;

        const cleanFileName = this.#filePath.replace(/\*$/, ''); // Remove existing asterisk
        if (this.#isDirty) {
            fileNameElement.textContent = cleanFileName + '*';
        } else {
            fileNameElement.textContent = cleanFileName;
        }
    }

    #setSaving(isSaving: boolean): void {
        if (this.#saveButton) {
            this.#saveButton.disabled = isSaving;
            this.#saveButton.textContent = isSaving
                ? 'Saving...'
                : _t('web.editor.save.tip');
        }
    }

    /**
     * Find and select text in the editor with fuzzy matching for Markdown syntax
     */
    #selectText(searchText: string): void {
        if (!this.#editorView) return;

        const content = this.#editorView.state.doc.toString();

        // Try multiple search strategies
        const result = this.#findTextInSource(content, searchText);

        if (result !== -1) {
            // Found the text, select it
            // Find the actual length in source (may include Markdown syntax)
            const actualLength = this.#findActualLength(content, result, searchText);
            this.#editorView.focus();
            this.#editorView.dispatch({
                selection: { anchor: result, head: result + actualLength },
                scrollIntoView: true,
            });

            const lineNumber = this.#editorView.state.doc.lineAt(result).number;
            Logger.log('EditorManager', `Selected text at index ${result}, line ${lineNumber}`);
        } else {
            // Text not found, just focus at the beginning
            Logger.warn('EditorManager', `Text not found: "${searchText}"`);
            this.#focusEditor();
            window.alert(_t('web.editor.selection_not_found'));
        }
    }

    /**
     * Jump to a specific line number in the editor
     */
    #gotoLine(lineNum: number): void {
        if (!this.#editorView) return;
        const doc = this.#editorView.state.doc;
        const targetLine = Math.min(lineNum, doc.lines);
        const line = doc.line(targetLine);

        this.#editorView.focus();
        this.#editorView.dispatch({
            selection: { anchor: line.from, head: line.to },
            scrollIntoView: true,
        });
        Logger.log('EditorManager', `Jumped to line ${targetLine}`);
    }

    /**
     * Find text in source with multiple strategies
     */
    #findTextInSource(content: string, searchText: string): number {
        // Strategy 1: Exact match
        let index = content.indexOf(searchText);
        if (index !== -1) return index;

        // Strategy 2: Try to find by building regex patterns that account for common Markdown syntax
        // This creates a pattern that allows Markdown syntax between words
        const words = searchText.split(/\s+/).filter(w => w.length > 0);
        if (words.length > 1) {
            // Build a flexible regex pattern
            // Allow Markdown syntax between words: `, **, __, *, _, [, ], (, ), etc.
            const pattern = words
                .map(word => Text.escapeRegex(word))
                .join('[\\s`*_\\[\\]()]*');

            const regex = new RegExp(pattern, 'i');
            const match = content.match(regex);
            if (match) {
                return content.indexOf(match[0]);
            }
        }

        // Strategy 3: Try removing common Markdown syntax from search text
        const cleaned = searchText
            .replace(/`/g, '')  // Remove backticks
            .replace(/\*\*/g, '')  // Remove bold markers
            .replace(/__/g, '')  // Remove bold markers (alternative)
            .replace(/\*/g, '')  // Remove italic markers
            .replace(/_/g, '')  // Remove italic markers (alternative)
            .trim();

        if (cleaned !== searchText) {
            index = content.indexOf(cleaned);
            if (index !== -1) return index;
        }

        return -1;
    }

    /**
     * Find the actual length of text in source (including Markdown syntax)
     */
    #findActualLength(content: string, startIndex: number, originalText: string): number {
        // Try exact match first
        const exactMatch = content.substring(startIndex, startIndex + originalText.length);
        if (exactMatch === originalText) {
            return originalText.length;
        }

        // Normalize original text for comparison
        const normalizedOriginal = Text.normalize(originalText);
        const originalLength = normalizedOriginal.length;

        // Search window: allow up to 3x the original length for Markdown syntax
        const maxLength = originalText.length * 3;
        const searchWindow = content.substring(startIndex, startIndex + maxLength);

        // Build "rendered" version by skipping Markdown syntax
        let rendered = '';
        let sourceLength = 0;
        let inCodeBacktick = false;
        let inLink = false;

        for (let i = 0; i < searchWindow.length; i++) {
            const char = searchWindow[i];
            const nextChar = searchWindow[i + 1];

            // Track backtick state for inline code
            if (char === '`') {
                inCodeBacktick = !inCodeBacktick;
                sourceLength++;
                continue;
            }

            // Track link/image syntax
            if (char === '[') {
                inLink = true;
                sourceLength++;
                continue;
            }

            if (inLink) {
                if (char === ']' && (nextChar === '(' || nextChar === '[')) {
                    sourceLength++;
                    continue;
                }
                if (char === ')' && searchWindow.substring(Math.max(0, i - 10), i).includes('](')) {
                    inLink = false;
                    sourceLength++;
                    continue;
                }
            }

            // Skip common Markdown syntax markers (when not in code)
            if (!inCodeBacktick && (char === '*' || char === '_')) {
                // Check if it's likely a bold/italic marker (repeated or followed by non-whitespace)
                if (char === nextChar || (nextChar && nextChar !== ' ' && nextChar !== '\n')) {
                    sourceLength++;
                    continue;
                }
            }

            // Add character to rendered version
            rendered += char ?? '';
            sourceLength++;

            // Check if we've matched the original text
            const normalizedRendered = Text.normalize(rendered);

            // Exact match on normalized text
            if (normalizedRendered === normalizedOriginal) {
                return sourceLength;
            }

            // Stop if we've gone too far
            if (normalizedRendered.length > originalLength * 1.5) {
                break;
            }
        }

        // Fallback: conservative estimate
        return Math.min(originalText.length, searchWindow.length);
    }

    /**
     * Schedule a preview pane update with debounce
     */
    #schedulePreviewUpdate(delay = 150): void {
        // A document change makes any in-flight render stale immediately,
        // even before the replacement request leaves the debounce window.
        this.#previewAbort?.abort();
        this.#previewAbort = null;
        ++this.#previewRevision;
        if (this.#previewDebounceId !== null) {
            clearTimeout(this.#previewDebounceId);
        }
        this.#previewDebounceId = setTimeout(() => {
            this.#previewDebounceId = null;
            void this.#updatePreview();
        }, delay);
    }

    /**
     * Update the preview pane by calling /api/preview
     */
    async #updatePreview(): Promise<void> {
        const previewPane = this.#previewPane;
        const editorView = this.#editorView;
        if (!previewPane || !editorView) return;

        const source = editorView.state.doc.toString();
        const content = this.#mode === 'export'
            ? this.#readExportDocument(source).content
            : source;
        const workspaceId = Meta.get(CONFIG.META_TAGS.WORKSPACE_ID) ?? '';
        const token = Meta.get('preview-token') ?? '';
        const sessionId = this.#sessionId;
        const revision = ++this.#previewRevision;
        this.#previewAbort?.abort();
        const abort = new AbortController();
        this.#previewAbort = abort;
        const body: EditorPreviewRequest = {
            workspace_id: workspaceId,
            content,
        };
        try {
            const response = await fetch('/api/preview', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Markon-Token': token,
                },
                body: JSON.stringify(body),
                signal: abort.signal,
            });
            if (!response.ok) return;
            const result = (await response.json()) as EditorPreviewResponse;
            if (
                abort.signal.aborted
                || revision !== this.#previewRevision
                || sessionId !== this.#sessionId
                || previewPane !== this.#previewPane
            ) return;
            previewPane.innerHTML = result.html;

            if (result.has_math) {
                this.#renderMath(previewPane, sessionId);
            }
        } catch (err) {
            if (abort.signal.aborted) return;
            Logger.warn('EditorManager', 'Preview update failed:', err);
        } finally {
            if (this.#previewAbort === abort) {
                this.#previewAbort = null;
            }
        }
    }

    #renderMath(previewPane: HTMLElement, sessionId: number): void {
        if (window.markonRenderMath) {
            window.markonRenderMath(previewPane);
            return;
        }
        void this.#loadMathRenderer().then(() => {
            if (sessionId === this.#sessionId && previewPane === this.#previewPane) {
                window.markonRenderMath?.(previewPane);
            }
        });
    }

    #loadMathRenderer(): Promise<void> {
        if (window.markonRenderMath) return Promise.resolve();
        if (this.#mathRendererPromise) return this.#mathRendererPromise;

        this.#ensureStylesheet('/_/js/katex/katex.min.css');
        this.#mathRendererPromise = this.#loadScript('/_/js/katex/katex.min.js')
            .then(() => this.#loadScript('/_/js/math-render.js'))
            .catch((err: unknown) => {
                this.#mathRendererPromise = null;
                Logger.warn('EditorManager', 'Math renderer failed to load:', err);
            });
        return this.#mathRendererPromise;
    }

    #ensureStylesheet(href: string): void {
        if (document.querySelector(`link[rel="stylesheet"][href="${href}"]`)) return;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        document.head.appendChild(link);
    }

    #loadScript(src: string): Promise<void> {
        if (document.querySelector(`script[src="${src}"]`)) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error(`Failed to load ${src}`));
            document.head.appendChild(script);
        });
    }

    /**
     * Restore saved split ratio from localStorage
     */
    #restoreSplit(): void {
        const split = this.#editorModal?.querySelector<HTMLElement>('.editor-split');
        if (!split) return;
        const saved = localStorage.getItem(SPLIT_KEY);
        const pct = saved ? parseFloat(saved) : 50;
        const clamped = Math.min(80, Math.max(20, pct));
        split.style.setProperty('--editor-split-left', `${clamped}%`);
    }

    /**
     * Setup draggable split divider
     */
    #setupDivider(): void {
        const divider = this.#editorModal?.querySelector<HTMLElement>('.editor-split-divider');
        const split = this.#editorModal?.querySelector<HTMLElement>('.editor-split');
        if (!divider || !split) return;

        let dragging = false;

        const onMove = (clientX: number): void => {
            if (!dragging) return;
            const rect = split.getBoundingClientRect();
            let pct = ((clientX - rect.left) / rect.width) * 100;
            pct = Math.min(80, Math.max(20, pct));
            split.style.setProperty('--editor-split-left', `${pct}%`);
            localStorage.setItem(SPLIT_KEY, pct.toString());
        };

        divider.addEventListener('mousedown', (e: MouseEvent) => {
            dragging = true;
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e: MouseEvent) => onMove(e.clientX), this.#listenerOptions());
        document.addEventListener('mouseup', () => {
            if (dragging) {
                dragging = false;
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            }
        }, this.#listenerOptions());

        // Touch support
        divider.addEventListener('touchstart', (e: TouchEvent) => {
            dragging = true;
            e.preventDefault();
        }, { passive: false });
        document.addEventListener('touchmove', (e: TouchEvent) => {
            const touch = e.touches[0];
            if (dragging && touch) onMove(touch.clientX);
        }, this.#listenerOptions({ passive: true }));
        document.addEventListener('touchend', () => { dragging = false; }, this.#listenerOptions());
    }

    /**
     * Setup narrow-screen tab switching
     */
    #setupTabs(): void {
        const tabs = this.#editorModal?.querySelectorAll<HTMLElement>('.editor-tab');
        const sourcePane = this.#editorModal?.querySelector<HTMLElement>('.editor-pane-source');
        const previewPane = this.#editorModal?.querySelector<HTMLElement>('.editor-pane-preview');
        if (!tabs || !sourcePane || !previewPane) return;

        // Set initial narrow-screen state: source visible, preview hidden
        if (window.innerWidth <= 768) {
            sourcePane.style.display = 'flex';
            previewPane.style.display = 'none';
        }

        // Clear inline display overrides when resizing to wide screen
        window.addEventListener('resize', () => {
            if (window.innerWidth > 768) {
                sourcePane.style.display = '';
                previewPane.style.display = '';
            } else if (this.#activeTab === 'edit') {
                sourcePane.style.display = 'flex';
                previewPane.style.display = 'none';
            } else {
                sourcePane.style.display = 'none';
                previewPane.style.display = 'flex';
            }
        }, this.#listenerOptions());

        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const nextTab = tab.dataset['tab'] as EditorTab | undefined;
                if (nextTab !== 'edit' && nextTab !== 'preview') return;
                this.#activeTab = nextTab;
                tabs.forEach(t => t.classList.toggle('active', t.dataset['tab'] === this.#activeTab));
                if (window.innerWidth <= 768) {
                    if (this.#activeTab === 'edit') {
                        sourcePane.style.display = 'flex';
                        previewPane.style.display = 'none';
                        this.#editorView?.requestMeasure();
                    } else {
                        sourcePane.style.display = 'none';
                        previewPane.style.display = 'flex';
                        this.#schedulePreviewUpdate(0);
                    }
                }
            });
        });
    }

    /**
     * Restore saved layout preference from localStorage
     */
    #restoreLayout(): void {
        const saved = localStorage.getItem(LAYOUT_KEY);
        this.#layout = (saved === 'full') ? 'full' : 'split';
        this.#applyLayout(this.#layout);
    }

    /**
     * Apply layout mode to the editor DOM
     */
    #applyLayout(mode: EditorLayout): void {
        if (!this.#editorModal) return;
        const split = this.#editorModal.querySelector<HTMLElement>('.editor-split');
        const divider = this.#editorModal.querySelector<HTMLElement>('.editor-split-divider');
        const previewPane = this.#editorModal.querySelector<HTMLElement>('.editor-pane-preview');
        const sourcePane = this.#editorModal.querySelector<HTMLElement>('.editor-pane-source');

        if (mode === 'full') {
            if (split) split.classList.add('editor-layout-full');
            // On wide screens, hide preview + divider; on narrow screens, CSS handles it
            if (window.innerWidth > 768) {
                if (divider) divider.style.display = 'none';
                if (previewPane) previewPane.style.display = 'none';
                if (sourcePane) sourcePane.style.width = '100%';
            }
        } else {
            if (split) split.classList.remove('editor-layout-full');
            if (window.innerWidth > 768) {
                if (divider) divider.style.display = '';
                if (previewPane) previewPane.style.display = '';
                if (sourcePane) sourcePane.style.width = '';
            }
        }

        // Sync toggle button active state
        this.#editorModal.querySelectorAll<HTMLElement>('.editor-layout-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset['layout'] === mode);
        });
        this.#editorView?.requestMeasure();
    }

    /**
     * Setup layout toggle buttons
     */
    #setupLayoutToggle(): void {
        const btns = this.#editorModal?.querySelectorAll<HTMLElement>('.editor-layout-btn');
        if (!btns) return;
        btns.forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset['layout'] as EditorLayout | undefined;
                if (mode !== 'split' && mode !== 'full') return;
                if (mode === this.#layout) return;
                this.#layout = mode;
                localStorage.setItem(LAYOUT_KEY, mode);
                this.#applyLayout(mode);
                // Re-attach scroll sync (only active in split mode)
                this.#setupScrollSync();
                // Trigger preview refresh when switching to split so pane is up-to-date
                if (mode === 'split') {
                    this.#schedulePreviewUpdate(0);
                }
            });
        });

        // Re-apply on resize (handles crossing the 768px breakpoint)
        window.addEventListener('resize', () => {
            this.#applyLayout(this.#layout);
            // Re-attach/remove scroll sync when crossing the breakpoint
            this.#setupScrollSync();
        }, this.#listenerOptions());
    }

    /**
     * Setup proportional scroll sync between source and preview panes.
     * Only active in split mode on wide screens (>768 px).
     * Anti-loop mechanism: sets #isSyncingScroll = true before programmatic
     * scrollTo, clears it in the next requestAnimationFrame so the responding
     * listener can detect and bail out.
     */
    #setupScrollSync(): void {
        // Tear down any previous listeners first
        if (this.#scrollSyncCleanup) {
            this.#scrollSyncCleanup();
            this.#scrollSyncCleanup = null;
        }

        // Only run in split mode on wide screens
        if (this.#layout !== 'split' || window.innerWidth <= 768) return;

        // CodeMirror owns the source scroll container; preview scrolls on its pane.
        const sourceEl = this.#editorView?.scrollDOM;
        const previewPane = this.#editorModal?.querySelector<HTMLElement>('.editor-pane-preview');
        if (!sourceEl || !previewPane) return;

        const syncFrom = (from: HTMLElement, to: HTMLElement): void => {
            if (this.#isSyncingScroll) return;
            const fromMax = from.scrollHeight - from.clientHeight;
            if (fromMax <= 0) return;
            const ratio = from.scrollTop / fromMax;
            const toMax = to.scrollHeight - to.clientHeight;
            if (toMax <= 0) return;
            this.#isSyncingScroll = true;
            to.scrollTop = ratio * toMax;
            requestAnimationFrame(() => { this.#isSyncingScroll = false; });
        };

        const onSourceScroll = (): void => syncFrom(sourceEl, previewPane);
        const onPreviewScroll = (): void => syncFrom(previewPane, sourceEl);

        sourceEl.addEventListener('scroll', onSourceScroll, { passive: true });
        previewPane.addEventListener('scroll', onPreviewScroll, { passive: true });

        this.#scrollSyncCleanup = (): void => {
            sourceEl.removeEventListener('scroll', onSourceScroll);
            previewPane.removeEventListener('scroll', onPreviewScroll);
        };
    }
}
