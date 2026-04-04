/**
 * NoteManager - Note card manager
 * Handles note rendering, layout, and responsive handling
 */

import { CONFIG } from '../core/config.js';
import { PlatformUtils, Logger } from '../core/utils.js';
import { LayoutEngine } from '../services/layout.js';
import { Text } from '../services/text.js';

export class NoteManager {
    #annotationManager;
    #markdownBody;
    #noteCardsData = [];
    #layoutEngine;

    constructor(annotationManager, markdownBody) {
        this.#annotationManager = annotationManager;
        this.#markdownBody = markdownBody;
        this.#layoutEngine = new LayoutEngine();
    }

    render() {
        // 移除现有的边距Note
        this.clear();

        // Get所有带Note的HighlightElement（仅最外层）
        const allHighlightElements = this.#markdownBody.querySelectorAll('.has-note[data-annotation-id]');
        const outermostElements = this.#filterOutermost(allHighlightElements);

        if (outermostElements.length === 0) {
            return;
        }

        // Get注解Data
        const annotations = this.#annotationManager.getAll();
        const annotationsMap = new Map(annotations.map(a => [a.id, a]));

        // CreateNote卡片
        outermostElements.forEach(highlightElement => {
            const annoId = highlightElement.dataset.annotationId;
            const anno = annotationsMap.get(annoId);

            if (!anno || !anno.note) {
                return;
            }

            const noteCard = this.#createNoteCard(anno);
            document.body.appendChild(noteCard);

            this.#noteCardsData.push({
                element: noteCard,
                highlightId: anno.id,
                highlightElement: highlightElement,
                text: anno.text,
                note: anno.note
            });
        });

        // 布局Note
        this.#layout();

        Logger.log('NoteManager', `Rendered ${this.#noteCardsData.length} note cards`);
    }

    clear() {
        document.querySelectorAll('.note-card-margin').forEach(el => el.remove());
        this.#noteCardsData = [];
    }

    getNoteCardsData() {
        return [...this.#noteCardsData];
    }

    setupResponsiveLayout() {
        let resizeTimeout;

        window.addEventListener('resize', () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                this.#layout();

                // Close弹出Window（窄屏Mode）
                if (PlatformUtils.isNarrowScreen()) {
                    const existingPopup = document.querySelector('.note-popup');
                    if (existingPopup) {
                        existingPopup.remove();
                    }
                }
            }, CONFIG.ANIMATION.RESIZE_DEBOUNCE);
        });

        Logger.log('NoteManager', 'Responsive layout setup complete');
    }

    #filterOutermost(elements) {
        const outermostMap = new Map();

        elements.forEach(element => {
            const annoId = element.dataset.annotationId;

            // Check是否嵌套在另一个 .has-note 中
            let isNested = false;
            let parent = element.parentElement;

            while (parent && parent !== this.#markdownBody) {
                if (parent.classList && parent.classList.contains('has-note')) {
                    isNested = true;
                    break;
                }
                parent = parent.parentElement;
            }

            // 只保留未嵌套的或首次遇到的
            if (!outermostMap.has(annoId)) {
                outermostMap.set(annoId, element);
            } else if (!isNested) {
                outermostMap.set(annoId, element);
            }
        });

        return Array.from(outermostMap.values());
    }

    #createNoteCard(annotation) {
        const noteCard = document.createElement('div');
        noteCard.className = 'note-card-margin';
        noteCard.dataset.annotationId = annotation.id;

        noteCard.innerHTML = `
            <div class="note-actions">
                <button class="note-edit" data-annotation-id="${annotation.id}" title="Edit note">✎</button>
                <button class="note-delete" data-annotation-id="${annotation.id}" title="Delete note">×</button>
            </div>
            <div class="note-content">${Text.escape(annotation.note)}</div>
        `;

        noteCard.style.position = 'absolute';

        return noteCard;
    }

    #layout() {
        if (this.#noteCardsData.length === 0) {
            return;
        }

        if (PlatformUtils.isWideScreen()) {
            // 宽屏：使用物理布局
            this.#layoutWideScreen();
        } else {
            // 窄屏：Hide所有Note卡片（点击ShowModal）
            this.#layoutNarrowScreen();
        }
    }

    #layoutWideScreen() {
        // 强制重排以确保 offsetHeight Calculate准确
        document.body.offsetHeight;

        // 使用物理引擎Calculate位置
        const notes = this.#layoutEngine.calculate(this.#noteCardsData);

        // Calculate水平位置（右对齐）
        const rightEdge = window.innerWidth - CONFIG.DIMENSIONS.NOTE_CARD_WIDTH - CONFIG.DIMENSIONS.NOTE_CARD_RIGHT_MARGIN;

        // Apply位置
        notes.forEach(note => {
            note.element.style.left = `${rightEdge}px`;
            note.element.style.top = `${note.currentTop}px`;
            note.element.style.display = 'block';
        });

        Logger.log('NoteManager', `Wide screen layout applied to ${notes.length} notes`);
    }

    #layoutNarrowScreen() {
        this.#noteCardsData.forEach(noteData => {
            noteData.element.style.display = 'none';
        });

        Logger.log('NoteManager', 'Narrow screen layout applied (cards hidden)');
    }

    showNotePopup(highlightElement, annotationId) {
        // 移除已存在的Modal
        const existingPopup = document.querySelector('.note-popup');
        if (existingPopup) existingPopup.remove();

        // FindNoteData
        const noteData = this.#noteCardsData.find(n => n.highlightId === annotationId);
        if (!noteData) return;

        // CreateModal
        const popup = document.createElement('div');
        popup.className = 'note-popup';
        popup.dataset.annotationId = annotationId;
        popup.innerHTML = `
            <div class="note-actions">
                <button class="note-edit" data-annotation-id="${annotationId}" title="Edit note">✎</button>
                <button class="note-delete" data-annotation-id="${annotationId}" title="Delete note">×</button>
            </div>
            <div class="note-content">${Text.escape(noteData.note)}</div>
        `;

        // 定位
        const rect = highlightElement.getBoundingClientRect();
        popup.style.position = 'absolute';
        popup.style.left = `${rect.left + window.scrollX}px`;
        popup.style.top = `${rect.bottom + window.scrollY + 10}px`;

        document.body.appendChild(popup);

        // 添加点击外部关闭功能
        const closeHandler = (e) => {
            if (!popup.contains(e.target) && !noteData.highlightElement.contains(e.target)) {
                popup.remove();
                document.removeEventListener('click', closeHandler);
                Logger.log('NoteManager', 'Note popup closed by clicking outside');
            }
        };
        // 延迟添加事件监听器，避免立即触发
        setTimeout(() => {
            document.addEventListener('click', closeHandler);
        }, 0);

        // 调整位置以保持在视口内
        const popupRect = popup.getBoundingClientRect();
        if (popupRect.right > window.innerWidth) {
            popup.style.left = `${rect.left + window.scrollX - (popupRect.right - window.innerWidth) - 10}px`;
        }
        if (popupRect.bottom > window.innerHeight) {
            popup.style.top = `${rect.top + window.scrollY - popupRect.height - 10}px`;
        }

        Logger.log('NoteManager', `Showed note popup for annotation: ${annotationId}`);
    }
}
