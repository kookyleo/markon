/**
 * StorageManager - Unified storage abstraction layer.
 * Supports local mode (`localStorage`) and shared mode (WebSocket).
 */

import { CONFIG, type WsMessageType } from '../core/config';
import { Logger } from '../core/utils';
import type { Annotation } from './annotation-manager';
import type { WebSocketManager } from './websocket-manager';

/**
 * Generic storage strategy interface. The default `unknown` parameter keeps
 * call sites flexible while still discouraging implicit `any`.
 */
export abstract class StorageStrategy<T = unknown> {
    abstract load(key: string): Promise<T | null>;
    abstract save(key: string, data: T): Promise<void>;
    abstract delete(key: string): Promise<void>;
}

/** localStorage-backed strategy. */
export class LocalStorageStrategy<T = unknown> extends StorageStrategy<T> {
    async load(key: string): Promise<T | null> {
        try {
            const data = localStorage.getItem(key);
            return data ? (JSON.parse(data) as T) : null;
        } catch (error) {
            Logger.error('LocalStorage', 'Failed to load data:', key, error);
            return null;
        }
    }

    async save(key: string, data: T): Promise<void> {
        try {
            localStorage.setItem(key, JSON.stringify(data));
            Logger.log('LocalStorage', 'Saved data:', key);
        } catch (error) {
            Logger.error('LocalStorage', 'Failed to save data:', key, error);
        }
    }

    async delete(key: string): Promise<void> {
        try {
            localStorage.removeItem(key);
            Logger.log('LocalStorage', 'Deleted data:', key);
        } catch (error) {
            Logger.error('LocalStorage', 'Failed to delete data:', key, error);
        }
    }
}

/** WebSocket-backed strategy. Maintains a local cache of pushed values. */
export class SharedStorageStrategy extends StorageStrategy {
    #wsManager: WebSocketManager | null;
    #cache = new Map<string, unknown>();

    constructor(wsManager: WebSocketManager | null) {
        super();
        this.#wsManager = wsManager;
    }

    async load(key: string): Promise<unknown> {
        // In shared mode, data is delivered via WebSocket. Return whatever
        // the cache has been populated with so far.
        return this.#cache.get(key) ?? null;
    }

    async save(key: string, data: unknown): Promise<void> {
        this.#cache.set(key, data);

        if (this.#wsManager && this.#wsManager.isConnected()) {
            const messageType = this.#getMessageType(key, 'save');
            if (messageType === CONFIG.WS_MESSAGE_TYPES.UPDATE_VIEWED_STATE) {
                await this.#wsManager.sendWithOpId({
                    type: 'update_viewed_state',
                    state: data as Record<string, boolean>,
                });
                Logger.log('SharedStorage', 'Saved viewed state via WebSocket');
            }
        } else {
            Logger.warn('SharedStorage', 'WebSocket not connected, data cached locally');
        }
    }

    /**
     * Save a single annotation (shared mode only). Returns the op_id used
     * for the outgoing frame so callers can correlate it with an undo entry
     * (or `null` when nothing was sent — disconnected, etc.).
     */
    async saveSingleAnnotation(annotation: Annotation): Promise<string | null> {
        if (this.#wsManager && this.#wsManager.isConnected()) {
            const opId = await this.#wsManager.sendWithOpId({
                type: 'new_annotation',
                annotation,
            });
            Logger.log('SharedStorage', 'Saved annotation via WebSocket:', annotation.id);
            return opId;
        }
        Logger.warn('SharedStorage', 'WebSocket not connected, annotation not saved');
        return null;
    }

    async delete(key: string): Promise<void> {
        this.#cache.delete(key);

        if (this.#wsManager && this.#wsManager.isConnected()) {
            // `delete` clears the entire bucket (all annotations or all viewed state).
            if (key.includes('annotations')) {
                await this.#wsManager.sendWithOpId({ type: 'clear_annotations' });
                Logger.log('SharedStorage', 'Sent clear annotations via WebSocket');
            } else if (key.includes('viewed')) {
                // Clearing viewed state is modelled as "set state to {}".
                await this.#wsManager.sendWithOpId({
                    type: 'update_viewed_state',
                    state: {},
                });
                Logger.log('SharedStorage', 'Sent clear viewed state via WebSocket');
            }
        }
    }

    /**
     * Delete a single annotation (shared mode only). Returns the op_id used
     * for the outgoing frame (or `null` when nothing was sent).
     */
    async deleteSingleAnnotation(annotationId: string): Promise<string | null> {
        if (this.#wsManager && this.#wsManager.isConnected()) {
            const opId = await this.#wsManager.sendWithOpId({
                type: 'delete_annotation',
                id: annotationId,
            });
            Logger.log('SharedStorage', 'Deleted annotation via WebSocket:', annotationId);
            return opId;
        }
        Logger.warn('SharedStorage', 'WebSocket not connected, annotation not deleted');
        return null;
    }

    /** Update cache (called when WebSocket pushes data). */
    updateCache(key: string, data: unknown): void {
        this.#cache.set(key, data);
        Logger.log('SharedStorage', 'Cache updated:', key);
    }

    /** Clear cache. Pass a key to clear a single entry, or omit to clear all. */
    clearCache(key: string | null = null): void {
        if (key) {
            this.#cache.delete(key);
        } else {
            this.#cache.clear();
        }
    }

    /** Infer the WebSocket message type from a storage key. */
    #getMessageType(key: string, action: 'save' | 'delete' | 'load'): WsMessageType | null {
        if (key.includes('annotations')) {
            if (action === 'save') return CONFIG.WS_MESSAGE_TYPES.NEW_ANNOTATION;
            if (action === 'delete') return CONFIG.WS_MESSAGE_TYPES.DELETE_ANNOTATION;
            return CONFIG.WS_MESSAGE_TYPES.ALL_ANNOTATIONS;
        }
        if (key.includes('viewed')) {
            return CONFIG.WS_MESSAGE_TYPES.UPDATE_VIEWED_STATE;
        }
        return null;
    }
}

/** Storage facade. Picks a strategy based on shared-vs-local mode. */
export class StorageManager {
    #strategy: LocalStorageStrategy | SharedStorageStrategy;
    #filePath: string;
    #isSharedMode: boolean;

    constructor(
        filePath: string,
        isSharedMode = false,
        wsManager: WebSocketManager | null = null,
    ) {
        this.#filePath = filePath;
        this.#isSharedMode = isSharedMode;

        if (isSharedMode && wsManager) {
            this.#strategy = new SharedStorageStrategy(wsManager);
            Logger.log('StorageManager', 'Using shared storage strategy');
        } else {
            this.#strategy = new LocalStorageStrategy();
            Logger.log('StorageManager', 'Using local storage strategy');
        }
    }

    /** Load all annotations for the current file. */
    async loadAnnotations(): Promise<Annotation[]> {
        const key = CONFIG.STORAGE_KEYS.ANNOTATIONS(this.#filePath);
        const data = await this.#strategy.load(key);
        return (data as Annotation[] | null) ?? [];
    }

    /** Save the full annotation list (local mode) or push individually (shared). */
    async saveAnnotations(annotations: Annotation[]): Promise<void> {
        const key = CONFIG.STORAGE_KEYS.ANNOTATIONS(this.#filePath);
        await this.#strategy.save(key, annotations);
    }

    /**
     * Upsert a single annotation. In shared mode returns the op_id of the
     * outgoing WebSocket frame; in local mode returns `null`.
     */
    async saveAnnotation(annotation: Annotation): Promise<string | null> {
        if (this.#isSharedMode && this.#strategy instanceof SharedStorageStrategy) {
            // Shared mode: push the single annotation to the server.
            return this.#strategy.saveSingleAnnotation(annotation);
        }
        // Local mode: rewrite the entire array.
        const annotations = await this.loadAnnotations();
        const index = annotations.findIndex((a) => a.id === annotation.id);

        if (index >= 0) {
            annotations[index] = annotation;
        } else {
            annotations.push(annotation);
        }

        await this.saveAnnotations(annotations);
        return null;
    }

    /** Delete an annotation by id. Returns the outgoing op_id in shared mode. */
    async deleteAnnotation(annotationId: string): Promise<string | null> {
        if (this.#isSharedMode && this.#strategy instanceof SharedStorageStrategy) {
            return this.#strategy.deleteSingleAnnotation(annotationId);
        }
        const annotations = await this.loadAnnotations();
        const filtered = annotations.filter((a) => a.id !== annotationId);
        await this.saveAnnotations(filtered);
        return null;
    }

    /** Clear all annotations for the current file. Returns the outgoing op_id in shared mode. */
    async clearAnnotations(): Promise<string | null> {
        const key = CONFIG.STORAGE_KEYS.ANNOTATIONS(this.#filePath);
        await this.#strategy.delete(key);
        // SharedStorageStrategy.delete() already routes through sendWithOpId,
        // but doesn't surface the id. For now callers that need the id can
        // bypass this and call the WebSocketManager directly; threading it
        // through the strategy is an easy future change.
        return null;
    }

    /** Load viewed state (heading id → checked). */
    async loadViewedState(): Promise<Record<string, boolean>> {
        const key = CONFIG.STORAGE_KEYS.VIEWED(this.#filePath);
        const data = await this.#strategy.load(key);
        return (data as Record<string, boolean> | null) ?? {};
    }

    /** Save viewed state. */
    async saveViewedState(viewedState: Record<string, boolean>): Promise<void> {
        const key = CONFIG.STORAGE_KEYS.VIEWED(this.#filePath);
        await this.#strategy.save(key, viewedState);
    }

    /** Clear viewed state. */
    async clearViewedState(): Promise<void> {
        const key = CONFIG.STORAGE_KEYS.VIEWED(this.#filePath);
        await this.#strategy.delete(key);
    }

    /** Update cache (shared mode only; no-op otherwise). */
    updateCache(key: string, data: unknown): void {
        if (this.#strategy instanceof SharedStorageStrategy) {
            this.#strategy.updateCache(key, data);
        }
    }

    isSharedMode(): boolean {
        return this.#isSharedMode;
    }

    getFilePath(): string {
        return this.#filePath;
    }
}
