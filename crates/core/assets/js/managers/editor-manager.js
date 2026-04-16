/**
 * EditorManager - Markdown source editor
 * Provides minimalist in-browser editing functionality with line numbers
 */

import { CONFIG } from '../core/config.js';
import { Logger } from '../core/utils.js';
import { Meta } from '../services/dom.js';
import { Text } from '../services/text.js';

const _t = (window.__MARKON_I18N__ && window.__MARKON_I18N__.t) || (k => k);

export class EditorManager {
    #filePath;
    #editorModal = null;
    #textarea = null;
    #lineNumbers = null;
    #highlightLayer = null;
    #saveButton = null;
    #closeButton = null;
    #isDirty = false;

    constructor(filePath) {
        this.#filePath = filePath;
        Logger.log('EditorManager', 'Initialized for file:', filePath);
    }

    /**
     * Open the editor
     * @param {Object} options - Optional configuration
     * @param {string} options.selectedText - Text to find and select in editor
     */
    async open(options = {}) {
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
        this.#updateLineNumbers();

        // If selectedText provided, find and select it
        if (options.selectedText && options.selectedText.trim()) {
            this.#selectText(options.selectedText.trim());
        } else {
            this.#focusEditor();
        }

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

            // Reload page to return to view mode
            window.location.reload();

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
            this.#updateTitleDirtyIndicator();
        }
    }

    /**
     * Fetch current file content
     * @private
     */
    async #fetchCurrentContent() {
        try {
            const el = document.getElementById('original-markdown-data');
            if (el) {
                return JSON.parse(el.textContent);
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

            const workspaceId = Meta.get(CONFIG.META_TAGS.WORKSPACE_ID) ?? '';
            const response = await fetch('/api/save', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    workspace_id: workspaceId,
                    file_path: this.#filePath,
                    content: content,
                }),
            });

            const result = await response.json();

            if (result.success) {
                Logger.log('EditorManager', 'File saved successfully');
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

    /**
     * Create editor UI
     * @private
     */
    #createEditorUI(content) {
        const modal = document.createElement('div');
        modal.className = 'editor-modal';
        modal.innerHTML = `
            <div class="editor-header">
                <button class="editor-close" title="${_t('web.editor.close.tip')}">✕</button>
                <span class="editor-file-name">${Text.escape(this.#filePath)}</span>
                <button class="editor-save-btn" style="display: none;">${_t('web.editor.save')}</button>
            </div>
            <div class="editor-body">
                <div class="editor-container">
                    <div class="editor-line-numbers"></div>
                    <div class="editor-text-container">
                        <pre class="editor-highlight-layer"><code></code></pre>
                        <textarea class="editor-textarea" spellcheck="false"></textarea>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        this.#editorModal = modal;
        this.#textarea = modal.querySelector('.editor-textarea');
        this.#lineNumbers = modal.querySelector('.editor-line-numbers');
        this.#highlightLayer = modal.querySelector('.editor-highlight-layer code');
        this.#saveButton = modal.querySelector('.editor-save-btn');
        this.#closeButton = modal.querySelector('.editor-close');

        // Set textarea content (no HTML escaping needed for textarea.value)
        this.#textarea.value = content;

        // Initialize syntax highlighting
        this.#updateSyntaxHighlight();
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

        // Sync scroll between textarea, line numbers, and highlight layer
        this.#textarea.addEventListener('scroll', () => {
            if (this.#lineNumbers) {
                this.#lineNumbers.scrollTop = this.#textarea.scrollTop;
            }
            if (this.#highlightLayer) {
                this.#highlightLayer.parentElement.scrollTop = this.#textarea.scrollTop;
                this.#highlightLayer.parentElement.scrollLeft = this.#textarea.scrollLeft;
            }
        });

        // Coalesce expensive updates to one per animation frame: typing-storm
        // inputs fire 5-10× per frame, but we only need to repaint once.
        let rafId = null;
        let lastLineCount = -1;
        this.#textarea.addEventListener('input', () => {
            this.#isDirty = true;
            this.#updateSaveButtonState();
            this.#updateTitleDirtyIndicator();
            if (rafId !== null) return;
            rafId = requestAnimationFrame(() => {
                rafId = null;
                const lines = this.#textarea.value.split('\n').length;
                if (lines !== lastLineCount) {
                    lastLineCount = lines;
                    this.#updateLineNumbers();
                }
                this.#updateSyntaxHighlight();
            });
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
                this.#saveButton.style.display = 'block';
                this.#saveButton.classList.add('has-changes');
            } else {
                this.#saveButton.style.display = 'none';
                this.#saveButton.classList.remove('has-changes');
            }
        }
    }

    /**
     * Update title dirty indicator (add/remove asterisk)
     * @private
     */
    #updateTitleDirtyIndicator() {
        const fileNameElement = this.#editorModal?.querySelector('.editor-file-name');
        if (!fileNameElement) return;

        const cleanFileName = this.#filePath.replace(/\*$/, ''); // Remove existing asterisk
        if (this.#isDirty) {
            fileNameElement.textContent = cleanFileName + '*';
        } else {
            fileNameElement.textContent = cleanFileName;
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
                : _t('web.editor.save.tip');
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
     * Find and select text in the editor with fuzzy matching for Markdown syntax
     * @private
     */
    #selectText(searchText) {
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
     * Find text in source with multiple strategies
     * @private
     */
    #findTextInSource(content, searchText) {
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
     * @private
     */
    #findActualLength(content, startIndex, originalText) {
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

    #escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * Update syntax highlighting
     * @private
     */
    #updateSyntaxHighlight() {
        if (!this.#textarea || !this.#highlightLayer) return;

        const text = this.#textarea.value;
        const highlighted = this.#highlightMarkdown(text);
        this.#highlightLayer.innerHTML = highlighted + '\n';
    }

    /**
     * Simple Markdown syntax highlighting
     * @private
     */
    #highlightMarkdown(text) {
        // Escape HTML first
        text = Text.escape(text);

        // Apply syntax highlighting (order matters!)
        text = text
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

        return text;
    }

}
