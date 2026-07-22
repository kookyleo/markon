/**
 * StorageManager - Unified storage abstraction layer.
 * SQLite is the canonical store whenever the browser has permission to use
 * the workspace document-state endpoint. `localStorage` remains a migration
 * source and an offline/unauthorized fallback. WebSocket is synchronization,
 * not persistence.
 */

import { CONFIG } from '../core/config';
import { workspaceDocumentStateUrl } from '../core/routes';
import { Logger } from '../core/utils';
import type { Annotation } from './annotation-manager';
import { makeOpId, type WebSocketManager } from './websocket-manager';

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

type DocumentSnapshot = {
    annotations: Annotation[];
    viewed_state: Record<string, boolean>;
};

/** SQLite-backed browser strategy. Mutations use HTTP; WS only fans them out. */
export class ServerStorageStrategy extends StorageStrategy {
    #workspaceId: string;
    #filePath: string;
    #shared: boolean;
    #wsManager: WebSocketManager | null;
    #snapshot: Promise<DocumentSnapshot> | null = null;
    #cache = new Map<string, unknown>();
    #writeQueue: Promise<void> = Promise.resolve();

    constructor(
        workspaceId: string,
        filePath: string,
        shared: boolean,
        wsManager: WebSocketManager | null,
    ) {
        super();
        this.#workspaceId = workspaceId;
        this.#filePath = filePath;
        this.#shared = shared;
        this.#wsManager = wsManager;
    }

    async #loadSnapshot(): Promise<DocumentSnapshot> {
        this.#snapshot ??= (async () => {
            const query = new URLSearchParams({ path: this.#filePath });
            const response = await fetch(
                `${workspaceDocumentStateUrl(this.#workspaceId)}?${query.toString()}`,
                { credentials: 'same-origin', cache: 'no-store' },
            );
            if (!response.ok) throw new Error(`document state load failed (${response.status})`);
            const snapshot = await response.json() as DocumentSnapshot;
            this.#cache.set(CONFIG.STORAGE_KEYS.ANNOTATIONS(this.#filePath), snapshot.annotations ?? []);
            this.#cache.set(CONFIG.STORAGE_KEYS.VIEWED(this.#filePath), snapshot.viewed_state ?? {});
            return snapshot;
        })();
        return this.#snapshot;
    }

    async #post(command: Record<string, unknown>): Promise<string | null> {
        let opId: string | null = null;
        if (this.#shared && this.#wsManager?.isConnected()) {
            opId = makeOpId();
            this.#wsManager.recordOutgoing(opId);
            command['op_id'] = opId;
        }

        // Unlike one WebSocket, independent fetches are not ordered. Viewed
        // toggles intentionally fire-and-forget, so a slow earlier request
        // could otherwise overwrite the user's newest state in SQLite. Keep a
        // per-document mutation queue and keep it usable after a failed write.
        const run = async (): Promise<void> => {
            const response = await fetch(workspaceDocumentStateUrl(this.#workspaceId), {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(command),
            });
            if (!response.ok) {
                throw new Error(`document state save failed (${response.status}): ${await response.text()}`);
            }
        };
        const pending = this.#writeQueue.then(run, run);
        this.#writeQueue = pending.catch(() => {});
        await pending;
        return opId;
    }

    async load(key: string): Promise<unknown> {
        await this.#loadSnapshot();
        return this.#cache.get(key) ?? null;
    }

    async save(key: string, data: unknown): Promise<void> {
        this.#cache.set(key, data);
        if (key.includes('viewed')) {
            await this.#post({
                action: 'save_viewed_state',
                path: this.#filePath,
                state: data,
            });
        }
    }

    async saveSingleAnnotation(annotation: Annotation): Promise<string | null> {
        const key = CONFIG.STORAGE_KEYS.ANNOTATIONS(this.#filePath);
        const current = (this.#cache.get(key) as Annotation[] | undefined) ?? [];
        const next = current.filter(item => item.id !== annotation.id);
        next.push(annotation);
        this.#cache.set(key, next);
        return this.#post({ action: 'save_annotation', path: this.#filePath, annotation });
    }

    async deleteSingleAnnotation(annotationId: string): Promise<string | null> {
        const key = CONFIG.STORAGE_KEYS.ANNOTATIONS(this.#filePath);
        const current = (this.#cache.get(key) as Annotation[] | undefined) ?? [];
        this.#cache.set(key, current.filter(item => item.id !== annotationId));
        return this.#post({
            action: 'delete_annotation',
            path: this.#filePath,
            id: annotationId,
        });
    }

    async delete(key: string): Promise<void> {
        if (key.includes('annotations')) {
            this.#cache.set(key, []);
            await this.#post({ action: 'clear_annotations', path: this.#filePath });
        } else if (key.includes('viewed')) {
            this.#cache.set(key, {});
            await this.#post({
                action: 'save_viewed_state',
                path: this.#filePath,
                state: {},
            });
        }
    }

    updateCache(key: string, data: unknown): void {
        this.#cache.set(key, data);
    }
}

/** Storage facade. Prefers SQLite and owns legacy/offline local fallback. */
export class StorageManager {
    #strategy: LocalStorageStrategy | ServerStorageStrategy;
    #local = new LocalStorageStrategy();
    #filePath: string;
    #isSharedMode: boolean;

    constructor(
        filePath: string,
        isSharedMode = false,
        wsManager: WebSocketManager | null = null,
        workspaceId = '',
    ) {
        this.#filePath = filePath;
        this.#isSharedMode = isSharedMode;

        if (workspaceId) {
            this.#strategy = new ServerStorageStrategy(
                workspaceId,
                filePath,
                isSharedMode,
                wsManager,
            );
            Logger.log('StorageManager', 'Using SQLite-backed server storage strategy');
        } else {
            this.#strategy = new LocalStorageStrategy();
            Logger.log('StorageManager', 'Using local storage strategy');
        }
    }

    /** Load a legacy/offline annotation snapshot from the current origin. */
    static async loadLocalAnnotations(filePath: string): Promise<Annotation[]> {
        const storage = new LocalStorageStrategy<Annotation[]>();
        const key = CONFIG.STORAGE_KEYS.ANNOTATIONS(filePath);
        return (await storage.load(key)) ?? [];
    }

    /** Save the browser fallback used when SQLite is unavailable. */
    static async saveLocalAnnotations(filePath: string, annotations: Annotation[]): Promise<void> {
        const storage = new LocalStorageStrategy<Annotation[]>();
        const key = CONFIG.STORAGE_KEYS.ANNOTATIONS(filePath);
        await storage.save(key, annotations);
    }

    static async loadLocalViewedState(filePath: string): Promise<Record<string, boolean>> {
        const storage = new LocalStorageStrategy<Record<string, boolean>>();
        return (await storage.load(CONFIG.STORAGE_KEYS.VIEWED(filePath))) ?? {};
    }

    /** Load all annotations for the current file. */
    async loadAnnotations(): Promise<Annotation[]> {
        const key = CONFIG.STORAGE_KEYS.ANNOTATIONS(this.#filePath);
        if (this.#strategy instanceof LocalStorageStrategy) {
            return ((await this.#strategy.load(key)) as Annotation[] | null) ?? [];
        }
        const local = await StorageManager.loadLocalAnnotations(this.#filePath);
        try {
            const persisted = ((await this.#strategy.load(key)) as Annotation[] | null) ?? [];
            const byId = new Map(persisted.map(annotation => [annotation.id, annotation]));
            const missing = local.filter(annotation => !byId.has(annotation.id));
            for (const annotation of missing) {
                await this.#strategy.saveSingleAnnotation(annotation);
                byId.set(annotation.id, annotation);
            }
            await this.#local.delete(key);
            return [...byId.values()];
        } catch (error) {
            Logger.warn('StorageManager', 'SQLite unavailable; using local annotation fallback', error);
            return local;
        }
    }

    /** Save the full annotation list in browser-fallback mode. */
    async saveAnnotations(annotations: Annotation[]): Promise<void> {
        const key = CONFIG.STORAGE_KEYS.ANNOTATIONS(this.#filePath);
        await this.#strategy.save(key, annotations);
    }

    /**
     * Upsert a single annotation. Shared mode returns the op_id used to dedup
     * the HTTP mutation's WebSocket broadcast; personal mode returns `null`.
     */
    async saveAnnotation(annotation: Annotation): Promise<string | null> {
        if (this.#strategy instanceof ServerStorageStrategy) {
            try {
                return await this.#strategy.saveSingleAnnotation(annotation);
            } catch (error) {
                Logger.warn('StorageManager', 'SQLite save failed; preserving annotation locally', error);
                const local = await StorageManager.loadLocalAnnotations(this.#filePath);
                const next = local.filter(item => item.id !== annotation.id);
                next.push(annotation);
                await StorageManager.saveLocalAnnotations(this.#filePath, next);
                return null;
            }
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
        if (this.#strategy instanceof ServerStorageStrategy) {
            try {
                return await this.#strategy.deleteSingleAnnotation(annotationId);
            } catch (error) {
                Logger.warn('StorageManager', 'SQLite delete failed; updating local fallback', error);
                const local = await StorageManager.loadLocalAnnotations(this.#filePath);
                await StorageManager.saveLocalAnnotations(
                    this.#filePath,
                    local.filter(item => item.id !== annotationId),
                );
                return null;
            }
        }
        const annotations = await this.loadAnnotations();
        const filtered = annotations.filter((a) => a.id !== annotationId);
        await this.saveAnnotations(filtered);
        return null;
    }

    /** Clear all annotations for the current file. Returns the outgoing op_id in shared mode. */
    async clearAnnotations(): Promise<string | null> {
        const key = CONFIG.STORAGE_KEYS.ANNOTATIONS(this.#filePath);
        try {
            await this.#strategy.delete(key);
            await this.#local.delete(key);
        } catch (error) {
            Logger.warn('StorageManager', 'SQLite clear failed; clearing local fallback', error);
            await this.#local.delete(key);
        }
        return null;
    }

    /** Load viewed state (heading id → checked). */
    async loadViewedState(): Promise<Record<string, boolean>> {
        const key = CONFIG.STORAGE_KEYS.VIEWED(this.#filePath);
        if (this.#strategy instanceof LocalStorageStrategy) {
            return ((await this.#strategy.load(key)) as Record<string, boolean> | null) ?? {};
        }
        const local = await StorageManager.loadLocalViewedState(this.#filePath);
        try {
            const persisted = ((await this.#strategy.load(key)) as Record<string, boolean> | null) ?? {};
            const useLocal = Object.keys(persisted).length === 0 && Object.keys(local).length > 0;
            if (useLocal) await this.#strategy.save(key, local);
            await this.#local.delete(key);
            return useLocal ? local : persisted;
        } catch (error) {
            Logger.warn('StorageManager', 'SQLite unavailable; using local viewed fallback', error);
            return local;
        }
    }

    /** Save viewed state. */
    async saveViewedState(viewedState: Record<string, boolean>): Promise<void> {
        const key = CONFIG.STORAGE_KEYS.VIEWED(this.#filePath);
        try {
            await this.#strategy.save(key, viewedState);
        } catch (error) {
            Logger.warn('StorageManager', 'SQLite viewed save failed; preserving state locally', error);
            await this.#local.save(key, viewedState);
        }
    }

    /** Clear viewed state. */
    async clearViewedState(): Promise<void> {
        const key = CONFIG.STORAGE_KEYS.VIEWED(this.#filePath);
        try {
            await this.#strategy.delete(key);
            await this.#local.delete(key);
        } catch (error) {
            Logger.warn('StorageManager', 'SQLite viewed clear failed; clearing local fallback', error);
            await this.#local.delete(key);
        }
    }

    /** Update the SQLite strategy's in-page cache from a shared broadcast. */
    updateCache(key: string, data: unknown): void {
        if (this.#strategy instanceof ServerStorageStrategy) {
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
