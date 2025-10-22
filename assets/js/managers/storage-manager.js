/**
 * StorageManager - Unified storage abstraction layer
 * Supports local mode (localStorage) and shared mode (WebSocket)
 */

import { CONFIG } from '../core/config.js';
import { Logger } from '../core/utils.js';

/**
 * StorageStrategy接口
 */
class StorageStrategy {
    async load(key) {
        throw new Error('StorageStrategy.load must be implemented');
    }

    async save(key, data) {
        throw new Error('StorageStrategy.save must be implemented');
    }

    async delete(key) {
        throw new Error('StorageStrategy.delete must be implemented');
    }
}

/**
 * LocalStorageStrategy（localStorage）
 */
class LocalStorageStrategy extends StorageStrategy {
    async load(key) {
        try {
            const data = localStorage.getItem(key);
            return data ? JSON.parse(data) : null;
        } catch (error) {
            Logger.error('LocalStorage', 'Failed to load data:', key, error);
            return null;
        }
    }

    async save(key, data) {
        try {
            localStorage.setItem(key, JSON.stringify(data));
            Logger.log('LocalStorage', 'Saved data:', key);
        } catch (error) {
            Logger.error('LocalStorage', 'Failed to save data:', key, error);
        }
    }

    async delete(key) {
        try {
            localStorage.removeItem(key);
            Logger.log('LocalStorage', 'Deleted data:', key);
        } catch (error) {
            Logger.error('LocalStorage', 'Failed to delete data:', key, error);
        }
    }
}

/**
 * SharedStorageStrategy（WebSocket）
 */
class SharedStorageStrategy extends StorageStrategy {
    #wsManager;
    #cache = new Map();  // Local缓存，减少网络请求

    constructor(wsManager) {
        super();
        this.#wsManager = wsManager;
    }

    async load(key) {
        // SharedMode下，Data通过 WebSocket Message接收
        // 这里Return缓存的Data
        return this.#cache.get(key) || null;
    }

    async save(key, data) {
        // UpdateLocal缓存
        this.#cache.set(key, data);

        // 发送到服务器（仅用于非注解Data，如 viewed state）
        if (this.#wsManager && this.#wsManager.isConnected()) {
            // 根据 key Type发送不同的Message
            const messageType = this.#getMessageType(key, 'save');
            if (messageType === CONFIG.WS_MESSAGE_TYPES.UPDATE_VIEWED_STATE) {
                await this.#wsManager.send({
                    type: messageType,
                    state: data
                });
                Logger.log('SharedStorage', 'Saved viewed state via WebSocket');
            }
        } else {
            Logger.warn('SharedStorage', 'WebSocket not connected, data cached locally');
        }
    }

    /**
     * Save单个注解（SharedMode专用）
     * @param {Object} annotation - 注解Object
     */
    async saveSingleAnnotation(annotation) {
        if (this.#wsManager && this.#wsManager.isConnected()) {
            await this.#wsManager.send({
                type: CONFIG.WS_MESSAGE_TYPES.NEW_ANNOTATION,
                annotation: annotation
            });
            Logger.log('SharedStorage', 'Saved annotation via WebSocket:', annotation.id);
        } else {
            Logger.warn('SharedStorage', 'WebSocket not connected, annotation not saved');
        }
    }

    async delete(key) {
        // 从缓存中Delete
        this.#cache.delete(key);

        // 发送Delete请求到服务器
        if (this.#wsManager && this.#wsManager.isConnected()) {
            // delete 用于Clear所有Data（annotations 或 viewed state）
            if (key.includes('annotations')) {
                await this.#wsManager.send({
                    type: CONFIG.WS_MESSAGE_TYPES.CLEAR_ANNOTATIONS
                });
                Logger.log('SharedStorage', 'Sent clear annotations via WebSocket');
            }
            // viewed state 的Clear通过Update为空Object实现
            else if (key.includes('viewed')) {
                await this.#wsManager.send({
                    type: CONFIG.WS_MESSAGE_TYPES.UPDATE_VIEWED_STATE,
                    state: {}
                });
                Logger.log('SharedStorage', 'Sent clear viewed state via WebSocket');
            }
        }
    }

    /**
     * Delete单个注解（SharedMode专用）
     * @param {string} annotationId - 注解 ID
     */
    async deleteSingleAnnotation(annotationId) {
        if (this.#wsManager && this.#wsManager.isConnected()) {
            await this.#wsManager.send({
                type: CONFIG.WS_MESSAGE_TYPES.DELETE_ANNOTATION,
                id: annotationId
            });
            Logger.log('SharedStorage', 'Deleted annotation via WebSocket:', annotationId);
        } else {
            Logger.warn('SharedStorage', 'WebSocket not connected, annotation not deleted');
        }
    }

    /**
     * Update缓存（当从 WebSocket 接收到Data时调用）
     * @param {string} key - 键名
     * @param {*} data - Data
     */
    updateCache(key, data) {
        this.#cache.set(key, data);
        Logger.log('SharedStorage', 'Cache updated:', key);
    }

    /**
     * Clear缓存
     * @param {string} key - 键名（可选，不传则Clear全部）
     */
    clearCache(key = null) {
        if (key) {
            this.#cache.delete(key);
        } else {
            this.#cache.clear();
        }
    }

    /**
     * 根据 key 推断Message types
     * @private
     */
    #getMessageType(key, action) {
        if (key.includes('annotations')) {
            return action === 'save' ? CONFIG.WS_MESSAGE_TYPES.NEW_ANNOTATION :
                action === 'delete' ? CONFIG.WS_MESSAGE_TYPES.DELETE_ANNOTATION :
                    CONFIG.WS_MESSAGE_TYPES.ALL_ANNOTATIONS;
        } else if (key.includes('viewed')) {
            return CONFIG.WS_MESSAGE_TYPES.UPDATE_VIEWED_STATE;
        }
        return 'unknown';
    }
}

/**
 * StorageManagement器
 * 根据Mode自动SelectStorageStrategy
 */
export class StorageManager {
    #strategy;
    #filePath;
    #isSharedMode;

    constructor(filePath, isSharedMode = false, wsManager = null) {
        this.#filePath = filePath;
        this.#isSharedMode = isSharedMode;

        // SelectStorageStrategy
        if (isSharedMode && wsManager) {
            this.#strategy = new SharedStorageStrategy(wsManager);
            Logger.log('StorageManager', 'Using shared storage strategy');
        } else {
            this.#strategy = new LocalStorageStrategy();
            Logger.log('StorageManager', 'Using local storage strategy');
        }
    }

    /**
     * Load注解Data
     * @returns {Promise<Array>}
     */
    async loadAnnotations() {
        const key = CONFIG.STORAGE_KEYS.ANNOTATIONS(this.#filePath);
        const data = await this.#strategy.load(key);
        return data || [];
    }

    /**
     * Save注解Data
     * @param {Array} annotations - 注解数Group
     */
    async saveAnnotations(annotations) {
        const key = CONFIG.STORAGE_KEYS.ANNOTATIONS(this.#filePath);
        await this.#strategy.save(key, annotations);
    }

    /**
     * Save单个注解
     * @param {Object} annotation - 注解Object
     */
    async saveAnnotation(annotation) {
        // SharedMode：直接发送单个注解到服务器
        if (this.#isSharedMode && this.#strategy instanceof SharedStorageStrategy) {
            await this.#strategy.saveSingleAnnotation(annotation);
        } else {
            // LocalMode：Update整个数Group
            const annotations = await this.loadAnnotations();
            const index = annotations.findIndex(a => a.id === annotation.id);

            if (index >= 0) {
                annotations[index] = annotation;
            } else {
                annotations.push(annotation);
            }

            await this.saveAnnotations(annotations);
        }
    }

    /**
     * Delete注解
     * @param {string} annotationId - 注解 ID
     */
    async deleteAnnotation(annotationId) {
        // SharedMode：直接发送Delete请求到服务器
        if (this.#isSharedMode && this.#strategy instanceof SharedStorageStrategy) {
            await this.#strategy.deleteSingleAnnotation(annotationId);
        } else {
            // LocalMode：Update整个数Group
            const annotations = await this.loadAnnotations();
            const filtered = annotations.filter(a => a.id !== annotationId);
            await this.saveAnnotations(filtered);
        }
    }

    /**
     * Clear所有注解
     */
    async clearAnnotations() {
        const key = CONFIG.STORAGE_KEYS.ANNOTATIONS(this.#filePath);
        await this.#strategy.delete(key);
    }

    /**
     * Load已读State
     * @returns {Promise<Object>}
     */
    async loadViewedState() {
        const key = CONFIG.STORAGE_KEYS.VIEWED(this.#filePath);
        const data = await this.#strategy.load(key);
        return data || {};
    }

    /**
     * Save已读State
     * @param {Object} viewedState - 已读StateObject
     */
    async saveViewedState(viewedState) {
        const key = CONFIG.STORAGE_KEYS.VIEWED(this.#filePath);
        await this.#strategy.save(key, viewedState);
    }

    /**
     * Clear已读State
     */
    async clearViewedState() {
        const key = CONFIG.STORAGE_KEYS.VIEWED(this.#filePath);
        await this.#strategy.delete(key);
    }

    /**
     * Update缓存（仅SharedMode有效）
     * @param {string} key - 键名
     * @param {*} data - Data
     */
    updateCache(key, data) {
        if (this.#strategy instanceof SharedStorageStrategy) {
            this.#strategy.updateCache(key, data);
        }
    }

    /**
     * Check是否为SharedMode
     * @returns {boolean}
     */
    isSharedMode() {
        return this.#isSharedMode;
    }

    /**
     * GetFilePath
     * @returns {string}
     */
    getFilePath() {
        return this.#filePath;
    }
}
