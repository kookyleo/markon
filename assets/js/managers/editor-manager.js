/**
 * EditorManager - Markdown source editor
 * Provides minimalist in-browser editing functionality with line numbers
 */

import { CONFIG } from '../core/config.js';
import { Logger } from '../core/utils.js';

export class EditorManager {
    #filePath;
    #editorModal = null;
    #textarea = null;
    #lineNumbers = null;
    #saveButton = null;
    #closeButton = null;
    #isDirty = false;

    constructor(filePath) {
        this.#filePath = filePath;
        Logger.log('EditorManager', 'Initialized for file:', filePath);
    }

    /**
     * Open the editor
     */
    async open() {
        // Fetch current file content
        const content = await this.#fetchCurrentContent();
        if (content === null) {
            Logger.error('EditorManager', 'Failed to fetch file content');
            alert('Failed to load file content. Please ensure edit feature is enabled.');
            return;
        }

        // Create editor UI
        this.#createEditorUI(content);
        this.#setupEventListeners();
        this.#focusEditor();
        this.#updateLineNumbers();

        Logger.log('EditorManager', 'Editor opened');
    }

    /**
     * Close the editor
     */
    close() {
        if (this.#editorModal) {
            // Prompt user if there are unsaved changes
            if (this.#isDirty) {
                const confirmClose = confirm('You have unsaved changes. Close anyway?');
                if (!confirmClose) return;
            }

            // Clean up event listeners
            document.removeEventListener('keydown', this.#handleEscapeKey);

            this.#editorModal.remove();
            this.#editorModal = null;
            this.#textarea = null;
            this.#lineNumbers = null;
            this.#saveButton = null;
            this.#closeButton = null;
            this.#isDirty = false;

            Logger.log('EditorManager', 'Editor closed');
        }
    }

    /**
     * Save the file
     */
    async save() {
        if (!this.#textarea) return;

        const content = this.#textarea.value;
        const success = await this.#saveToServer(content);

        if (success) {
            this.#isDirty = false;
            this.#updateSaveButtonState();

            // Reload page after successful save
            setTimeout(() => {
                window.location.reload();
            }, 500);
        }
    }

    /**
     * Fetch current file content
     * @private
     */
    async #fetchCurrentContent() {
        try {
            // Read from embedded original Markdown script tag in page
            const markdownScript = document.querySelector('script[type="text/markdown"]');
            if (markdownScript) {
                return markdownScript.textContent;
            }

            Logger.warn('EditorManager', 'Original Markdown not found in page');
            return '';
        } catch (error) {
            Logger.error('EditorManager', 'Error fetching content:', error);
            return null;
        }
    }

    /**
     * Save content to server
     * @private
     */
    async #saveToServer(content) {
        try {
            this.#setSaving(true);

            const response = await fetch('/api/save', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    file_path: this.#filePath,
                    content: content,
                }),
            });

            const result = await response.json();

            if (result.success) {
                Logger.log('EditorManager', 'File saved successfully');
                alert('File saved successfully!');
                return true;
            } else {
                Logger.error('EditorManager', 'Save failed:', result.message);
                this.#showErrorAlert(result.message);
                return false;
            }
        } catch (error) {
            Logger.error('EditorManager', 'Save error:', error);
            alert(`Error saving file: ${error.message}`);
            return false;
        } finally {
            this.#setSaving(false);
        }
    }

    /**
     * Show friendly error message
     * @private
     */
    #showErrorAlert(message) {
        if (message.includes('read-only')) {
            alert('Cannot save: File is read-only. Please check file permissions.');
        } else if (message.includes('Access denied')) {
            alert('Cannot save: Access denied. File is outside allowed directory.');
        } else if (message.includes('not enabled')) {
            alert('Edit feature is not enabled. Please start server with --enable-edit.');
        } else if (message.includes('Only Markdown')) {
            alert('Only Markdown files (.md) can be edited.');
        } else {
            alert(`Save failed: ${message}`);
        }
    }

    /**
     * Create editor UI
     * @private
     */
    #createEditorUI(content) {
        const modal = document.createElement('div');
        modal.className = 'editor-modal';
        modal.innerHTML = `
            <div class="editor-header">
                <div class="editor-title">
                    <span class="editor-file-icon">📝</span>
                    <span class="editor-file-name">${this.#escapeHtml(this.#filePath)}</span>
                </div>
                <div class="editor-actions">
                    <button class="editor-close" title="Close (Esc)">✕</button>
                </div>
            </div>
            <div class="editor-body">
                <div class="editor-container">
                    <div class="editor-line-numbers"></div>
                    <textarea class="editor-textarea" spellcheck="false">${this.#escapeHtml(content)}</textarea>
                </div>
            </div>
            <div class="editor-footer">
                <div class="editor-status">
                    <span class="editor-line-count"></span>
                </div>
                <div class="editor-buttons">
                    <button class="editor-save-btn">Save Changes (Ctrl+S)</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        this.#editorModal = modal;
        this.#textarea = modal.querySelector('.editor-textarea');
        this.#lineNumbers = modal.querySelector('.editor-line-numbers');
        this.#saveButton = modal.querySelector('.editor-save-btn');
        this.#closeButton = modal.querySelector('.editor-close');

        this.#updateLineCount();
    }

    /**
     * Setup event listeners
     * @private
     */
    #setupEventListeners() {
        // Close button
        this.#closeButton.addEventListener('click', () => {
            this.close();
        });

        // Save button
        this.#saveButton.addEventListener('click', () => {
            this.save();
        });

        // Ctrl+S / Cmd+S to save
        this.#textarea.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                this.save();
            }
        });

        // Esc to close
        document.addEventListener('keydown', this.#handleEscapeKey);

        // Sync scroll between textarea and line numbers
        this.#textarea.addEventListener('scroll', () => {
            if (this.#lineNumbers) {
                this.#lineNumbers.scrollTop = this.#textarea.scrollTop;
            }
        });

        // Monitor content changes
        this.#textarea.addEventListener('input', () => {
            this.#isDirty = true;
            this.#updateSaveButtonState();
            this.#updateLineCount();
            this.#updateLineNumbers();
        });
    }

    /**
     * Handle Escape key
     * @private
     */
    #handleEscapeKey = (e) => {
        if (e.key === 'Escape' && this.#editorModal) {
            this.close();
        }
    };

    /**
     * Focus the editor
     * @private
     */
    #focusEditor() {
        if (this.#textarea) {
            this.#textarea.focus();
            // Move cursor to beginning
            this.#textarea.setSelectionRange(0, 0);
        }
    }

    /**
     * Update save button state
     * @private
     */
    #updateSaveButtonState() {
        if (this.#saveButton) {
            if (this.#isDirty) {
                this.#saveButton.classList.add('has-changes');
            } else {
                this.#saveButton.classList.remove('has-changes');
            }
        }
    }

    /**
     * Set saving state
     * @private
     */
    #setSaving(isSaving) {
        if (this.#saveButton) {
            this.#saveButton.disabled = isSaving;
            this.#saveButton.textContent = isSaving
                ? 'Saving...'
                : 'Save Changes (Ctrl+S)';
        }
    }

    /**
     * Update line count display
     * @private
     */
    #updateLineCount() {
        if (!this.#textarea) return;

        const lines = this.#textarea.value.split('\n').length;
        const lineCountEl = this.#editorModal.querySelector('.editor-line-count');
        if (lineCountEl) {
            lineCountEl.textContent = `${lines} lines`;
        }
    }

    /**
     * Update line numbers gutter
     * @private
     */
    #updateLineNumbers() {
        if (!this.#textarea || !this.#lineNumbers) return;

        const lines = this.#textarea.value.split('\n').length;
        const lineNumbersHtml = Array.from({ length: lines }, (_, i) => i + 1)
            .map(num => `<div class="editor-line-number">${num}</div>`)
            .join('');

        this.#lineNumbers.innerHTML = lineNumbersHtml;
    }

    /**
     * Escape HTML
     * @private
     */
    #escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}
