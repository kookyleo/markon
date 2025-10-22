/**
 * UndoManager - 撤销/重做管理器
 * 支持注解操作的撤销和重做
 */

import { CONFIG } from '../core/config.js';
import { Logger } from '../core/utils.js';

/**
 * 撤销管理器类
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
     * @param {Object} operation - 操作对象
     * @param {string} operation.type - 操作类型（add_annotation、delete_annotation、clear_annotations）
     * @param {*} operation.data - 操作数据
     */
    push(operation) {
        this.#undoStack.push({
            ...operation,
            timestamp: Date.now()
        });

        // 限制栈大小
        if (this.#undoStack.length > this.#maxStackSize) {
            this.#undoStack.shift();
        }

        // 清除重做栈（新操作后不能再重做）
        this.#redoStack = [];

        Logger.log('UndoManager', `Pushed operation: ${operation.type}`);
    }

    /**
     * 撤销上一个操作
     * @returns {Object|null} 被撤销的操作
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
     * 重做上一个撤销的操作
     * @returns {Object|null} 被重做的操作
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
     * 检查是否可以撤销
     * @returns {boolean}
     */
    canUndo() {
        return this.#undoStack.length > 0;
    }

    /**
     * 检查是否可以重做
     * @returns {boolean}
     */
    canRedo() {
        return this.#redoStack.length > 0;
    }

    /**
     * 清除所有栈
     */
    clear() {
        this.#undoStack = [];
        this.#redoStack = [];
        Logger.log('UndoManager', 'Cleared all stacks');
    }

    /**
     * 获取撤销栈大小
     * @returns {number}
     */
    getUndoStackSize() {
        return this.#undoStack.length;
    }

    /**
     * 获取重做栈大小
     * @returns {number}
     */
    getRedoStackSize() {
        return this.#redoStack.length;
    }
}
