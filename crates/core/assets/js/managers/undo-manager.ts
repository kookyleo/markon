/**
 * UndoManager - Undo/Redo stack for annotation operations.
 */

import { CONFIG } from '../core/config.js';
import { Logger } from '../core/utils.js';

/**
 * Caller-supplied operation payload. Shape is intentionally permissive:
 * the manager only requires `type`; everything else is opaque domain data
 * that the caller round-trips through the stack.
 */
export interface UndoOperationInput {
    type: string;
    [key: string]: unknown;
}

/**
 * Stored stack entry. Equivalent to the input plus a `timestamp` stamped
 * by `push()`.
 */
export interface UndoOperation extends UndoOperationInput {
    timestamp: number;
}

export class UndoManager {
    #undoStack: UndoOperation[] = [];
    #redoStack: UndoOperation[] = [];
    #maxStackSize: number;

    constructor(maxStackSize: number = CONFIG.UNDO.MAX_STACK_SIZE) {
        this.#maxStackSize = maxStackSize;
    }

    /** Record an operation. Stamps a `timestamp` and clears redo history. */
    push(operation: UndoOperationInput): void {
        this.#undoStack.push({ ...operation, timestamp: Date.now() });

        if (this.#undoStack.length > this.#maxStackSize) {
            this.#undoStack.shift();
        }

        // New operation invalidates redo history
        this.#redoStack = [];

        Logger.log('UndoManager', `Pushed operation: ${operation.type}`);
    }

    /** @returns The undone operation, or null if stack is empty. */
    undo(): UndoOperation | null {
        if (this.#undoStack.length === 0) return null;
        const operation = this.#undoStack.pop() as UndoOperation;
        this.#redoStack.push(operation);
        Logger.log('UndoManager', `Undid operation: ${operation.type}`);
        return operation;
    }

    /** @returns The redone operation, or null if stack is empty. */
    redo(): UndoOperation | null {
        if (this.#redoStack.length === 0) return null;
        const operation = this.#redoStack.pop() as UndoOperation;
        this.#undoStack.push(operation);
        Logger.log('UndoManager', `Redid operation: ${operation.type}`);
        return operation;
    }

    canUndo(): boolean { return this.#undoStack.length > 0; }
    canRedo(): boolean { return this.#redoStack.length > 0; }

    clear(): void {
        this.#undoStack = [];
        this.#redoStack = [];
    }

    getUndoStackSize(): number { return this.#undoStack.length; }
    getRedoStackSize(): number { return this.#redoStack.length; }
}
