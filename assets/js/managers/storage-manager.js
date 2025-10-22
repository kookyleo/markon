/**
 * StorageManager - 统一的存储抽象层
 * 支持本地模式（localStorage）和共享模式（WebSocket）
 */

import { CONFIG } from '../core/config.js';
import { Logger } from '../core/utils.js';

/**
 * 存储策略接口
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
 * 本地存储策略（localStorage）
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
 * 共享存储策略（WebSocket）
 */
class SharedStorageStrategy extends StorageStrategy {
    #wsManager;
    #cache = new Map();  // 本地缓存，减少网络请求

    constructor(wsManager) {
        super();
        this.#wsManager = wsManager;
    }

    async load(key) {
        // 共享模式下，数据通过 WebSocket 消息接收
        // 这里返回缓存的数据
        return this.#cache.get(key) || null;
    }

    async save(key, data) {
        // 更新本地缓存
        this.#cache.set(key, data);

        // 发送到服务器（仅用于非注解数据，如 viewed state）
        if (this.#wsManager && this.#wsManager.isConnected()) {
            // 根据 key 类型发送不同的消息
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
     * 保存单个注解（共享模式专用）
     * @param {Object} annotation - 注解对象
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
        // 从缓存中删除
        this.#cache.delete(key);

        // 发送删除请求到服务器
        if (this.#wsManager && this.#wsManager.isConnected()) {
            // delete 用于清除所有数据（annotations 或 viewed state）
            if (key.includes('annotations')) {
                await this.#wsManager.send({
                    type: CONFIG.WS_MESSAGE_TYPES.CLEAR_ANNOTATIONS
                });
                Logger.log('SharedStorage', 'Sent clear annotations via WebSocket');
            }
            // viewed state 的清除通过更新为空对象实现
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
     * 删除单个注解（共享模式专用）
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
     * 更新缓存（当从 WebSocket 接收到数据时调用）
     * @param {string} key - 键名
     * @param {*} data - 数据
     */
    updateCache(key, data) {
        this.#cache.set(key, data);
        Logger.log('SharedStorage', 'Cache updated:', key);
    }

    /**
     * 清除缓存
     * @param {string} key - 键名（可选，不传则清除全部）
     */
    clearCache(key = null) {
        if (key) {
            this.#cache.delete(key);
        } else {
            this.#cache.clear();
        }
    }

    /**
     * 根据 key 推断消息类型
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
 * 存储管理器
 * 根据模式自动选择存储策略
 */
export class StorageManager {
    #strategy;
    #filePath;
    #isSharedMode;

    constructor(filePath, isSharedMode = false, wsManager = null) {
        this.#filePath = filePath;
        this.#isSharedMode = isSharedMode;

        // 选择存储策略
        if (isSharedMode && wsManager) {
            this.#strategy = new SharedStorageStrategy(wsManager);
            Logger.log('StorageManager', 'Using shared storage strategy');
        } else {
            this.#strategy = new LocalStorageStrategy();
            Logger.log('StorageManager', 'Using local storage strategy');
        }
    }

    /**
     * 加载注解数据
     * @returns {Promise<Array>}
     */
    async loadAnnotations() {
        const key = CONFIG.STORAGE_KEYS.ANNOTATIONS(this.#filePath);
        const data = await this.#strategy.load(key);
        return data || [];
    }

    /**
     * 保存注解数据
     * @param {Array} annotations - 注解数组
     */
    async saveAnnotations(annotations) {
        const key = CONFIG.STORAGE_KEYS.ANNOTATIONS(this.#filePath);
        await this.#strategy.save(key, annotations);
    }

    /**
     * 保存单个注解
     * @param {Object} annotation - 注解对象
     */
    async saveAnnotation(annotation) {
        // 共享模式：直接发送单个注解到服务器
        if (this.#isSharedMode && this.#strategy instanceof SharedStorageStrategy) {
            await this.#strategy.saveSingleAnnotation(annotation);
        } else {
            // 本地模式：更新整个数组
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
     * 删除注解
     * @param {string} annotationId - 注解 ID
     */
    async deleteAnnotation(annotationId) {
        // 共享模式：直接发送删除请求到服务器
        if (this.#isSharedMode && this.#strategy instanceof SharedStorageStrategy) {
            await this.#strategy.deleteSingleAnnotation(annotationId);
        } else {
            // 本地模式：更新整个数组
            const annotations = await this.loadAnnotations();
            const filtered = annotations.filter(a => a.id !== annotationId);
            await this.saveAnnotations(filtered);
        }
    }

    /**
     * 清除所有注解
     */
    async clearAnnotations() {
        const key = CONFIG.STORAGE_KEYS.ANNOTATIONS(this.#filePath);
        await this.#strategy.delete(key);
    }

    /**
     * 加载已读状态
     * @returns {Promise<Object>}
     */
    async loadViewedState() {
        const key = CONFIG.STORAGE_KEYS.VIEWED(this.#filePath);
        const data = await this.#strategy.load(key);
        return data || {};
    }

    /**
     * 保存已读状态
     * @param {Object} viewedState - 已读状态对象
     */
    async saveViewedState(viewedState) {
        const key = CONFIG.STORAGE_KEYS.VIEWED(this.#filePath);
        await this.#strategy.save(key, viewedState);
    }

    /**
     * 清除已读状态
     */
    async clearViewedState() {
        const key = CONFIG.STORAGE_KEYS.VIEWED(this.#filePath);
        await this.#strategy.delete(key);
    }

    /**
     * 更新缓存（仅共享模式有效）
     * @param {string} key - 键名
     * @param {*} data - 数据
     */
    updateCache(key, data) {
        if (this.#strategy instanceof SharedStorageStrategy) {
            this.#strategy.updateCache(key, data);
        }
    }

    /**
     * 检查是否为共享模式
     * @returns {boolean}
     */
    isSharedMode() {
        return this.#isSharedMode;
    }

    /**
     * 获取文件路径
     * @returns {string}
     */
    getFilePath() {
        return this.#filePath;
    }
}
