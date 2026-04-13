/**
 * UndoManager - Undo/Redo stack for annotation operations.
 */

import { CONFIG } from '../core/config.js';
import { Logger } from '../core/utils.js';

export class UndoManager {
    #undoStack = [];
    #redoStack = [];
    #maxStackSize;

    constructor(maxStackSize = CONFIG.UNDO.MAX_STACK_SIZE) {
        this.#maxStackSize = maxStackSize;
    }

    /**
     * Record an operation.
     * @param {Object} operation - { type: string, data: any }
     */
    push(operation) {
        this.#undoStack.push({ ...operation, timestamp: Date.now() });

        if (this.#undoStack.length > this.#maxStackSize) {
            this.#undoStack.shift();
        }

        // New operation invalidates redo history
        this.#redoStack = [];

        Logger.log('UndoManager', `Pushed operation: ${operation.type}`);
    }

    /** @returns {Object|null} The undone operation, or null if stack is empty. */
    undo() {
        if (this.#undoStack.length === 0) return null;
        const operation = this.#undoStack.pop();
        this.#redoStack.push(operation);
        Logger.log('UndoManager', `Undid operation: ${operation.type}`);
        return operation;
    }

    /** @returns {Object|null} The redone operation, or null if stack is empty. */
    redo() {
        if (this.#redoStack.length === 0) return null;
        const operation = this.#redoStack.pop();
        this.#undoStack.push(operation);
        Logger.log('UndoManager', `Redid operation: ${operation.type}`);
        return operation;
    }

    canUndo() { return this.#undoStack.length > 0; }
    canRedo() { return this.#redoStack.length > 0; }

    clear() {
        this.#undoStack = [];
        this.#redoStack = [];
    }

    getUndoStackSize() { return this.#undoStack.length; }
    getRedoStackSize() { return this.#redoStack.length; }
}
