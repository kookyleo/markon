/**
 * EditorManager - Markdown 源码编辑器
 * 提供极简的浏览器内编辑功能
 */

import { CONFIG } from '../core/config.js';
import { Logger } from '../core/utils.js';

export class EditorManager {
    #filePath;
    #editorModal = null;
    #textarea = null;
    #saveButton = null;
    #closeButton = null;
    #isDirty = false;

    constructor(filePath) {
        this.#filePath = filePath;
        Logger.log('EditorManager', 'Initialized for file:', filePath);
    }

    /**
     * 打开编辑器
     */
    async open() {
        // 获取当前文件内容
        const content = await this.#fetchCurrentContent();
        if (content === null) {
            Logger.error('EditorManager', 'Failed to fetch file content');
            alert('无法加载文件内容，请确保启用了编辑功能。');
            return;
        }

        // 创建编辑器 UI
        this.#createEditorUI(content);
        this.#setupEventListeners();
        this.#focusEditor();

        Logger.log('EditorManager', 'Editor opened');
    }

    /**
     * 关闭编辑器
     */
    close() {
        if (this.#editorModal) {
            // 如果有未保存的改动，提示用户
            if (this.#isDirty) {
                const confirmClose = confirm('有未保存的改动，确定要关闭吗？');
                if (!confirmClose) return;
            }

            this.#editorModal.remove();
            this.#editorModal = null;
            this.#textarea = null;
            this.#saveButton = null;
            this.#closeButton = null;
            this.#isDirty = false;

            Logger.log('EditorManager', 'Editor closed');
        }
    }

    /**
     * 保存文件
     */
    async save() {
        if (!this.#textarea) return;

        const content = this.#textarea.value;
        const success = await this.#saveToServer(content);

        if (success) {
            this.#isDirty = false;
            this.#updateSaveButtonState();

            // 保存成功后刷新页面
            setTimeout(() => {
                window.location.reload();
            }, 500);
        }
    }

    /**
     * 获取当前文件内容
     * @private
     */
    async #fetchCurrentContent() {
        try {
            // 从页面中嵌入的原始 Markdown 脚本标签读取
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
     * 保存内容到服务器
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
                alert('文件保存成功！');
                return true;
            } else {
                Logger.error('EditorManager', 'Save failed:', result.message);
                this.#showErrorAlert(result.message);
                return false;
            }
        } catch (error) {
            Logger.error('EditorManager', 'Save error:', error);
            alert(`保存文件时出错：${error.message}`);
            return false;
        } finally {
            this.#setSaving(false);
        }
    }

    /**
     * 显示友好的错误信息
     * @private
     */
    #showErrorAlert(message) {
        if (message.includes('read-only')) {
            alert('无法保存：文件是只读的，请检查文件权限。');
        } else if (message.includes('Access denied')) {
            alert('无法保存：访问被拒绝，文件在允许的目录之外。');
        } else if (message.includes('not enabled')) {
            alert('编辑功能未启用，请使用 --enable-edit 参数启动服务器。');
        } else if (message.includes('Only Markdown')) {
            alert('只能编辑 Markdown 文件（.md）。');
        } else {
            alert(`保存失败：${message}`);
        }
    }

    /**
     * 创建编辑器 UI
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
                    <button class="editor-close" title="关闭 (Esc)">✕</button>
                </div>
            </div>
            <div class="editor-body">
                <textarea class="editor-textarea" spellcheck="false">${this.#escapeHtml(content)}</textarea>
            </div>
            <div class="editor-footer">
                <div class="editor-status">
                    <span class="editor-line-count"></span>
                </div>
                <div class="editor-buttons">
                    <button class="editor-save-btn">保存 (Ctrl+S)</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        this.#editorModal = modal;
        this.#textarea = modal.querySelector('.editor-textarea');
        this.#saveButton = modal.querySelector('.editor-save-btn');
        this.#closeButton = modal.querySelector('.editor-close');

        this.#updateLineCount();
    }

    /**
     * 设置事件监听器
     * @private
     */
    #setupEventListeners() {
        // 关闭按钮
        this.#closeButton.addEventListener('click', () => {
            this.close();
        });

        // 保存按钮
        this.#saveButton.addEventListener('click', () => {
            this.save();
        });

        // Ctrl+S / Cmd+S 保存
        this.#textarea.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                this.save();
            }
        });

        // Esc 关闭
        document.addEventListener('keydown', this.#handleEscapeKey);

        // 监听内容变化
        this.#textarea.addEventListener('input', () => {
            this.#isDirty = true;
            this.#updateSaveButtonState();
            this.#updateLineCount();
        });
    }

    /**
     * 处理 Escape 键
     * @private
     */
    #handleEscapeKey = (e) => {
        if (e.key === 'Escape' && this.#editorModal) {
            this.close();
        }
    };

    /**
     * 聚焦编辑器
     * @private
     */
    #focusEditor() {
        if (this.#textarea) {
            this.#textarea.focus();
            // 移动光标到开头
            this.#textarea.setSelectionRange(0, 0);
        }
    }

    /**
     * 更新保存按钮状态
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
     * 设置保存状态
     * @private
     */
    #setSaving(isSaving) {
        if (this.#saveButton) {
            this.#saveButton.disabled = isSaving;
            this.#saveButton.textContent = isSaving
                ? '保存中...'
                : '保存 (Ctrl+S)';
        }
    }

    /**
     * 更新行数显示
     * @private
     */
    #updateLineCount() {
        if (!this.#textarea) return;

        const lines = this.#textarea.value.split('\n').length;
        const lineCountEl = this.#editorModal.querySelector('.editor-line-count');
        if (lineCountEl) {
            lineCountEl.textContent = `${lines} 行`;
        }
    }

    /**
     * HTML 转义
     * @private
     */
    #escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}
