/**
 * EditorManager - Markdown source editor
 * Provides minimalist in-browser editing functionality with line numbers
 */

import { CONFIG } from '../core/config';
import { Logger } from '../core/utils';
import { Meta } from '../services/dom';
import { Text } from '../services/text';

const _t: (key: string, ...args: unknown[]) => string =
    (typeof window !== 'undefined' && window.__MARKON_I18N__ && window.__MARKON_I18N__.t) ||
    ((k: string) => k);

const SPLIT_KEY = 'markon.editor.split';
const LAYOUT_KEY = 'markon.editor.layout'; // 'split' | 'full'

/** Layout mode for the split-pane editor. */
export type EditorLayout = 'split' | 'full';

/** Narrow-screen tab state. */
export type EditorTab = 'edit' | 'preview';

/** Optional configuration accepted by `EditorManager.open()`. */
export interface EditorOpenOptions {
    /** Text to find and select in editor. */
    selectedText?: string;
    /** Line number to jump to (1-based). */
    line?: number;
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

/** Response shape from POST /api/preview. */
export interface EditorPreviewResponse {
    html: string;
    has_mermaid?: boolean;
}

export class EditorManager {
    #filePath: string;
    #editorModal: HTMLElement | null = null;
    #textarea: HTMLTextAreaElement | null = null;
    #lineNumbers: HTMLElement | null = null;
    #highlightLayer: HTMLElement | null = null;
    #saveButton: HTMLButtonElement | null = null;
    #closeButton: HTMLButtonElement | null = null;
    #isDirty = false;
    /** last-saved (or initially loaded) content for dirty comparison */
    #baselineContent = '';
    #previewPane: HTMLElement | null = null;
    #previewDebounceId: ReturnType<typeof setTimeout> | null = null;
    /** narrow-screen tab state */
    #activeTab: EditorTab = 'edit';
    #layout: EditorLayout = 'split';
    #isSyncingScroll = false;
    /** function to remove scroll listeners */
    #scrollSyncCleanup: (() => void) | null = null;

    constructor(filePath: string) {
        this.#filePath = filePath;
        Logger.log('EditorManager', 'Initialized for file:', filePath);
    }

    /** Has the buffer diverged from the last-saved baseline? */
    isDirty(): boolean {
        return this.#isDirty;
    }

    /** Is the editor modal currently open (DOM mounted)? */
    isOpen(): boolean {
        return this.#editorModal !== null;
    }

    /**
     * Open the editor.
     */
    async open(options: EditorOpenOptions = {}): Promise<void> {
        // Fetch current file content
        const content = await this.#fetchCurrentContent();
        if (content === null) {
            Logger.error('EditorManager', 'Failed to fetch file content');
            alert('Failed to load file content. Please ensure edit feature is enabled.');
            return;
        }

        // Capture the loaded content as the dirty-comparison baseline
        this.#baselineContent = content;

        // Create editor UI
        this.#createEditorUI(content);
        this.#setupEventListeners();
        this.#updateLineNumbers();

        // If line number provided, jump to that line
        if (options.line && options.line > 0) {
            this.#gotoLine(options.line);
        } else if (options.selectedText && options.selectedText.trim()) {
            this.#selectText(options.selectedText.trim());
        } else {
            this.#focusEditor();
        }

        Logger.log('EditorManager', 'Editor opened');
    }

    /**
     * Close the editor.
     */
    close(): void {
        if (this.#editorModal) {
            // Prompt user if there are unsaved changes
            if (this.#isDirty) {
                const confirmClose = confirm('You have unsaved changes. Close anyway?');
                if (!confirmClose) return;
            }

            // Clean up event listeners
            document.removeEventListener('keydown', this.#handleEscapeKey);
            if (this.#scrollSyncCleanup) {
                this.#scrollSyncCleanup();
                this.#scrollSyncCleanup = null;
            }

            if (this.#previewDebounceId !== null) {
                clearTimeout(this.#previewDebounceId);
                this.#previewDebounceId = null;
            }
            this.#editorModal.remove();
            this.#editorModal = null;
            this.#textarea = null;
            this.#lineNumbers = null;
            this.#saveButton = null;
            this.#closeButton = null;
            this.#previewPane = null;
            this.#isDirty = false;
            this.#baselineContent = '';

            // Reload page to return to view mode
            window.location.reload();

            Logger.log('EditorManager', 'Editor closed');
        }
    }

    /**
     * Save the file.
     */
    async save(): Promise<void> {
        if (!this.#textarea) return;

        const content = this.#textarea.value;
        const success = await this.#saveToServer(content);

        if (success) {
            // Saved content becomes the new baseline; further edits compare against it
            this.#baselineContent = content;
            this.#isDirty = false;
            this.#updateSaveButtonState();
            this.#updateTitleDirtyIndicator();
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
            this.#setSaving(true);

            const workspaceId = Meta.get(CONFIG.META_TAGS.WORKSPACE_ID) ?? '';
            const token = Meta.get('mgmt-token') ?? '';
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
        } finally {
            this.#setSaving(false);
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

    #createEditorUI(content: string): void {
        const modal = document.createElement('div');
        modal.className = 'editor-modal';
        modal.innerHTML = `
            <div class="editor-header">
                <button class="editor-close" title="${_t('web.editor.close.tip')}">✕</button>
                <span class="editor-file-name">${Text.escape(this.#filePath)}</span>
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
                <button class="editor-save-btn" style="display: none;">${_t('web.editor.save')}</button>
            </div>
            <div class="editor-body">
                <div class="editor-split">
                    <div class="editor-pane editor-pane-source">
                        <div class="editor-container">
                            <div class="editor-line-numbers"></div>
                            <div class="editor-text-container">
                                <pre class="editor-highlight-layer"><code></code></pre>
                                <textarea class="editor-textarea" spellcheck="false"></textarea>
                            </div>
                        </div>
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
        this.#textarea = modal.querySelector<HTMLTextAreaElement>('.editor-textarea');
        this.#lineNumbers = modal.querySelector<HTMLElement>('.editor-line-numbers');
        this.#highlightLayer = modal.querySelector<HTMLElement>('.editor-highlight-layer code');
        this.#saveButton = modal.querySelector<HTMLButtonElement>('.editor-save-btn');
        this.#closeButton = modal.querySelector<HTMLButtonElement>('.editor-close');
        this.#previewPane = modal.querySelector<HTMLElement>('.editor-preview-content');

        // Set textarea content (no HTML escaping needed for textarea.value)
        if (this.#textarea) {
            this.#textarea.value = content;
        }

        // Restore saved split position
        this.#restoreSplit();

        // Setup draggable divider
        this.#setupDivider();

        // Setup narrow-screen tabs
        this.#setupTabs();

        // Initialize syntax highlighting
        this.#updateSyntaxHighlight();

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

        // Save button
        this.#saveButton?.addEventListener('click', () => {
            void this.save();
        });

        if (!this.#textarea) return;
        const textarea = this.#textarea;

        // Ctrl+S / Cmd+S to save
        textarea.addEventListener('keydown', (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                void this.save();
            }
        });

        // Esc to close
        document.addEventListener('keydown', this.#handleEscapeKey);

        // Sync scroll between textarea, line numbers, and highlight layer
        textarea.addEventListener('scroll', () => {
            if (this.#lineNumbers) {
                this.#lineNumbers.scrollTop = textarea.scrollTop;
            }
            if (this.#highlightLayer && this.#highlightLayer.parentElement) {
                this.#highlightLayer.parentElement.scrollTop = textarea.scrollTop;
                this.#highlightLayer.parentElement.scrollLeft = textarea.scrollLeft;
            }
        });

        // Coalesce expensive updates to one per animation frame: typing-storm
        // inputs fire 5-10× per frame, but we only need to repaint once.
        let rafId: number | null = null;
        let lastLineCount = -1;
        textarea.addEventListener('input', () => {
            // Compare against baseline so reverting edits clears the dirty state
            this.#isDirty = textarea.value !== this.#baselineContent;
            this.#updateSaveButtonState();
            this.#updateTitleDirtyIndicator();
            if (rafId !== null) return;
            rafId = requestAnimationFrame(() => {
                rafId = null;
                const lines = textarea.value.split('\n').length;
                if (lines !== lastLineCount) {
                    lastLineCount = lines;
                    this.#updateLineNumbers();
                }
                this.#updateSyntaxHighlight();
            });
            // Schedule preview update with debounce
            this.#schedulePreviewUpdate(150);
        });
    }

    #handleEscapeKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape' && this.#editorModal) {
            this.close();
        }
    };

    #focusEditor(): void {
        if (this.#textarea) {
            this.#textarea.focus();
            // Move cursor to beginning
            this.#textarea.setSelectionRange(0, 0);
        }
    }

    #updateSaveButtonState(): void {
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

    #updateLineNumbers(): void {
        if (!this.#textarea || !this.#lineNumbers) return;

        const lines = this.#textarea.value.split('\n').length;
        const lineNumbersHtml = Array.from({ length: lines }, (_, i) => i + 1)
            .map(num => `<div class="editor-line-number">${num}</div>`)
            .join('');

        this.#lineNumbers.innerHTML = lineNumbersHtml;
    }

    /**
     * Find and select text in the editor with fuzzy matching for Markdown syntax
     */
    #selectText(searchText: string): void {
        if (!this.#textarea) return;

        const content = this.#textarea.value;

        // Try multiple search strategies
        const result = this.#findTextInSource(content, searchText);

        if (result !== -1) {
            // Found the text, select it
            this.#textarea.focus();

            // Find the actual length in source (may include Markdown syntax)
            const actualLength = this.#findActualLength(content, result, searchText);
            this.#textarea.setSelectionRange(result, result + actualLength);

            // Scroll to the selection
            const beforeText = content.substring(0, result);
            const lineNumber = beforeText.split('\n').length;
            const lineHeight = 22.4;
            const scrollTop = (lineNumber - 3) * lineHeight;

            this.#textarea.scrollTop = Math.max(0, scrollTop);

            if (this.#lineNumbers) {
                this.#lineNumbers.scrollTop = this.#textarea.scrollTop;
            }

            Logger.log('EditorManager', `Selected text at index ${result}, line ${lineNumber}`);
        } else {
            // Text not found, just focus at the beginning
            Logger.warn('EditorManager', `Text not found: "${searchText}"`);
            this.#focusEditor();

            // Show a subtle notification
            const notification = document.createElement('div');
            notification.textContent = 'Selected text not found in source';
            notification.style.cssText = `
                position: fixed;
                top: 80px;
                left: 50%;
                transform: translateX(-50%);
                background: rgba(0, 0, 0, 0.8);
                color: white;
                padding: 10px 20px;
                border-radius: 4px;
                z-index: 10001;
                font-size: 14px;
            `;
            document.body.appendChild(notification);

            setTimeout(() => {
                notification.remove();
            }, 3000);
        }
    }

    /**
     * Jump to a specific line number in the editor
     */
    #gotoLine(lineNum: number): void {
        if (!this.#textarea) return;
        const lines = this.#textarea.value.split('\n');
        const targetLine = Math.min(lineNum, lines.length);
        const pos = lines.slice(0, targetLine - 1).reduce((sum, l) => sum + l.length + 1, 0);
        const endPos = pos + (lines[targetLine - 1] || '').length;

        this.#textarea.focus();
        this.#textarea.setSelectionRange(pos, endPos);

        const lineHeight = 22.4;
        this.#textarea.scrollTop = Math.max(0, (targetLine - 3) * lineHeight);
        if (this.#lineNumbers) {
            this.#lineNumbers.scrollTop = this.#textarea.scrollTop;
        }
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
                .map(word => this.#escapeRegex(word))
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
            rendered += char;
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

    #escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * Schedule a preview pane update with debounce
     */
    #schedulePreviewUpdate(delay = 150): void {
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
        if (!this.#previewPane || !this.#textarea) return;

        const content = this.#textarea.value;
        try {
            const response = await fetch('/api/preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content }),
            });
            if (!response.ok) return;
            const result = (await response.json()) as EditorPreviewResponse;
            this.#previewPane.innerHTML = result.html;

            // Re-run Mermaid if diagrams present
            if (result.has_mermaid) {
                this.#renderMermaid();
            }
        } catch (err) {
            Logger.warn('EditorManager', 'Preview update failed:', err);
        }
    }

    /**
     * Render mermaid diagrams in the preview pane
     */
    #renderMermaid(): void {
        if (!this.#previewPane) return;
        const m = window.mermaid;
        if (!m) return;
        try {
            // run() is the modern API; older bundled mermaid versions only
            // expose init() — if run() throws (or is missing), fall through.
            void m.run!({ nodes: this.#previewPane.querySelectorAll('.language-mermaid') });
        } catch {
            try {
                m.init!(undefined, this.#previewPane.querySelectorAll('.language-mermaid'));
            } catch { /* ignore */ }
        }
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

        document.addEventListener('mousemove', (e: MouseEvent) => onMove(e.clientX));
        document.addEventListener('mouseup', () => {
            if (dragging) {
                dragging = false;
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            }
        });

        // Touch support
        divider.addEventListener('touchstart', (e: TouchEvent) => {
            dragging = true;
            e.preventDefault();
        }, { passive: false });
        document.addEventListener('touchmove', (e: TouchEvent) => {
            if (dragging && e.touches.length > 0) onMove(e.touches[0].clientX);
        }, { passive: true });
        document.addEventListener('touchend', () => { dragging = false; });
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
        });

        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const nextTab = tab.dataset.tab as EditorTab | undefined;
                if (nextTab !== 'edit' && nextTab !== 'preview') return;
                this.#activeTab = nextTab;
                tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === this.#activeTab));
                if (window.innerWidth <= 768) {
                    if (this.#activeTab === 'edit') {
                        sourcePane.style.display = 'flex';
                        previewPane.style.display = 'none';
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
            btn.classList.toggle('active', btn.dataset.layout === mode);
        });
    }

    /**
     * Setup layout toggle buttons
     */
    #setupLayoutToggle(): void {
        const btns = this.#editorModal?.querySelectorAll<HTMLElement>('.editor-layout-btn');
        if (!btns) return;
        btns.forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.layout as EditorLayout | undefined;
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
        });
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

        // Source side scrolls on the textarea itself, not on .editor-pane-source
        // (which is overflow:hidden). Preview side scrolls on .editor-pane-preview.
        const sourceEl = this.#textarea;
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

    /**
     * Update syntax highlighting
     */
    #updateSyntaxHighlight(): void {
        if (!this.#textarea || !this.#highlightLayer) return;

        const text = this.#textarea.value;
        const highlighted = this.#highlightMarkdown(text);
        this.#highlightLayer.innerHTML = highlighted + '\n';
    }

    /**
     * Simple Markdown syntax highlighting
     */
    #highlightMarkdown(text: string): string {
        // Escape HTML first
        let out = Text.escape(text);

        // Apply syntax highlighting (order matters!)
        out = out
            // Headers (h1-h6)
            .replace(/^(#{1,6})\s+(.+)$/gm, '<span class="md-header">$1</span> <span class="md-header-text">$2</span>')
            // Bold **text** or __text__
            .replace(/(\*\*|__)(.*?)\1/g, '<span class="md-bold">$1$2$1</span>')
            // Italic *text* or _text_
            .replace(/(\*|_)(.*?)\1/g, '<span class="md-italic">$1$2$1</span>')
            // Inline code `code`
            .replace(/`([^`]+)`/g, '<span class="md-code">`$1`</span>')
            // Links [text](url)
            .replace(/\[([^\]]+)\]\(([^\)]+)\)/g, '<span class="md-link">[$1]($2)</span>')
            // Images ![alt](url)
            .replace(/!\[([^\]]*)\]\(([^\)]+)\)/g, '<span class="md-image">![$1]($2)</span>')
            // Blockquotes
            .replace(/^(&gt;+)\s+(.+)$/gm, '<span class="md-quote">$1 $2</span>')
            // Unordered lists
            .replace(/^([\s]*)([-*+])\s+(.+)$/gm, '$1<span class="md-list">$2</span> $3')
            // Ordered lists
            .replace(/^([\s]*)(\d+\.)\s+(.+)$/gm, '$1<span class="md-list">$2</span> $3')
            // Horizontal rules
            .replace(/^([-*_]{3,})$/gm, '<span class="md-hr">$1</span>')
            // Code blocks ```
            .replace(/^```(\w*)$/gm, '<span class="md-code-fence">```$1</span>');

        return out;
    }
}
