/**
 * UndoManager - Undo/Redo manager
 * Supports undo and redo for annotation operations
 */

import { CONFIG } from '../core/config.js';
import { Logger } from '../core/utils.js';

/**
 * UndoManagement器类
 */
export class UndoManager {
    #undoStack = [];
    #redoStack = [];
    #maxStackSize;

    constructor(maxStackSize = CONFIG.UNDO.MAX_STACK_SIZE) {
        this.#maxStackSize = maxStackSize;
    }

    /**
     * 记录一个操作
     * @param {Object} operation - 操作Object
     * @param {string} operation.type - 操作Type（add_annotation、delete_annotation、clear_annotations）
     * @param {*} operation.data - 操作Data
     */
    push(operation) {
        this.#undoStack.push({
            ...operation,
            timestamp: Date.now()
        });

        // 限制栈Size
        if (this.#undoStack.length > this.#maxStackSize) {
            this.#undoStack.shift();
        }

        // ClearRedo栈（新操作后不能再Redo）
        this.#redoStack = [];

        Logger.log('UndoManager', `Pushed operation: ${operation.type}`);
    }

    /**
     * Undo上一个操作
     * @returns {Object|null} 被Undo的操作
     */
    undo() {
        if (this.#undoStack.length === 0) {
            Logger.log('UndoManager', 'Nothing to undo');
            return null;
        }

        const operation = this.#undoStack.pop();
        this.#redoStack.push(operation);

        Logger.log('UndoManager', `Undid operation: ${operation.type}`);
        return operation;
    }

    /**
     * Redo上一个Undo的操作
     * @returns {Object|null} 被Redo的操作
     */
    redo() {
        if (this.#redoStack.length === 0) {
            Logger.log('UndoManager', 'Nothing to redo');
            return null;
        }

        const operation = this.#redoStack.pop();
        this.#undoStack.push(operation);

        Logger.log('UndoManager', `Redid operation: ${operation.type}`);
        return operation;
    }

    /**
     * Check是否可以Undo
     * @returns {boolean}
     */
    canUndo() {
        return this.#undoStack.length > 0;
    }

    /**
     * Check是否可以Redo
     * @returns {boolean}
     */
    canRedo() {
        return this.#redoStack.length > 0;
    }

    /**
     * Clear所有栈
     */
    clear() {
        this.#undoStack = [];
        this.#redoStack = [];
        Logger.log('UndoManager', 'Cleared all stacks');
    }

    /**
     * GetUndo栈Size
     * @returns {number}
     */
    getUndoStackSize() {
        return this.#undoStack.length;
    }

    /**
     * GetRedo栈Size
     * @returns {number}
     */
    getRedoStackSize() {
        return this.#redoStack.length;
    }
}
