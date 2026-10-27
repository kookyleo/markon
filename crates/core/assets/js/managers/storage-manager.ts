/**
 * StorageManager - canonical document-state persistence.
 *
 * Annotations and viewed state always live in the Markon service's SQLite
 * database. WebSocket only broadcasts committed mutations to other tabs; the
 * browser never mirrors, migrates, queues, or falls back to localStorage.
 */

import { workspaceDocumentStateUrl } from '../core/routes';
import { Logger } from '../core/utils';
import type { Annotation } from './annotation-manager';
import { makeOpId, type WebSocketManager } from './websocket-manager';

type DocumentSnapshot = {
    annotations: Annotation[];
    viewed_state: Record<string, boolean>;
    scope?: 'owner' | 'personal' | 'shared';
};

export class StorageManager {
    #workspaceId: string;
    #filePath: string;
    #isSharedMode: boolean;
    #wsManager: WebSocketManager | null;
    #snapshot: Promise<DocumentSnapshot> | null = null;
    #annotations: Annotation[] = [];
    #viewedState: Record<string, boolean> = {};
    #scope: DocumentSnapshot['scope'];
    #writeQueue: Promise<void> = Promise.resolve();

    constructor(
        filePath: string,
        isSharedMode = false,
        wsManager: WebSocketManager | null = null,
        workspaceId = '',
    ) {
        if (!workspaceId.trim()) {
            throw new Error('workspace-id is required for SQLite document state');
        }
        this.#workspaceId = workspaceId;
        this.#filePath = filePath;
        this.#isSharedMode = isSharedMode;
        this.#wsManager = wsManager;
        Logger.log('StorageManager', 'Using SQLite-backed document state');
    }

    async #readSnapshot(): Promise<DocumentSnapshot> {
        const query = new URLSearchParams({ path: this.#filePath });
        const response = await fetch(
            `${workspaceDocumentStateUrl(this.#workspaceId)}?${query.toString()}`,
            { credentials: 'same-origin', cache: 'no-store' },
        );
        if (!response.ok) {
            throw new Error(`document state load failed (${response.status}): ${await response.text()}`);
        }
        return await response.json() as DocumentSnapshot;
    }

    async #loadSnapshot(): Promise<DocumentSnapshot> {
        this.#snapshot ??= (async () => {
            const snapshot = await this.#readSnapshot();
            this.#scope = snapshot.scope;
            this.#annotations = [...(snapshot.annotations ?? [])];
            this.#viewedState = { ...(snapshot.viewed_state ?? {}) };
            return {
                annotations: [...this.#annotations],
                viewed_state: { ...this.#viewedState },
            };
        })();
        return this.#snapshot;
    }

    async #post(command: Record<string, unknown>, onOperation?: (opId: string | null) => void): Promise<string | null> {
        // Resolve the identity and data scope before the first write, including
        // callers that mark progress before explicitly loading annotations.
        await this.#loadSnapshot();
        let opId: string | null = null;
        if (this.#isSharedMode && this.#wsManager?.isConnected()) {
            opId = makeOpId();
            this.#wsManager.recordOutgoing(opId);
            command['op_id'] = opId;
        }

        onOperation?.(opId);

        // Independent fetches are not ordered. Serialize all mutations for one
        // document so a slow earlier viewed-state write cannot overwrite the
        // user's newest state.
        const run = async (): Promise<void> => {
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (this.#scope) headers['X-Markon-Review-Scope'] = this.#scope;
            const response = await fetch(workspaceDocumentStateUrl(this.#workspaceId), {
                method: 'POST',
                credentials: 'same-origin',
                headers,
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

    async loadAnnotations(): Promise<Annotation[]> {
        await this.#loadSnapshot();
        return [...this.#annotations];
    }

    /** Fresh annotations for shared reconnect reconciliation. Do not replace
     * the initialization cache or independently loaded/patched progress. */
    async reloadAnnotations(): Promise<Annotation[]> {
        await this.#loadSnapshot();
        await this.#writeQueue;
        const snapshot = await this.#readSnapshot();
        if (snapshot.scope !== this.#scope) {
            throw new Error('Review scope changed; reload the page before refreshing annotations');
        }
        return [...(snapshot.annotations ?? [])];
    }

    async saveAnnotation(annotation: Annotation): Promise<string | null> {
        await this.#loadSnapshot();
        const opId = await this.#post({
            action: 'save_annotation',
            path: this.#filePath,
            annotation,
        });
        this.#annotations = this.#annotations.filter(item => item.id !== annotation.id);
        this.#annotations.push(annotation);
        return opId;
    }

    async deleteAnnotation(annotationId: string): Promise<string | null> {
        await this.#loadSnapshot();
        const opId = await this.#post({
            action: 'delete_annotation',
            path: this.#filePath,
            id: annotationId,
        });
        this.#annotations = this.#annotations.filter(item => item.id !== annotationId);
        return opId;
    }

    async clearAnnotations(): Promise<string | null> {
        await this.#loadSnapshot();
        const opId = await this.#post({
            action: 'clear_annotations',
            path: this.#filePath,
        });
        this.#annotations = [];
        return opId;
    }

    async loadViewedState(): Promise<Record<string, boolean>> {
        await this.#loadSnapshot();
        return { ...this.#viewedState };
    }

    async saveViewedState(viewedState: Record<string, boolean>): Promise<void> {
        const snapshot = { ...viewedState };
        await this.#post({
            action: 'save_viewed_state',
            path: this.#filePath,
            state: snapshot,
        });
        this.#viewedState = snapshot;
    }

    async patchViewedState(changes: Record<string, boolean>, onOperation?: (opId: string | null) => void): Promise<void> {
        // Capture the click now, before loading or waiting behind older writes.
        const snapshot = { ...changes };
        if (!Object.keys(snapshot).length) return;
        await this.#post({
            action: 'patch_viewed_state',
            path: this.#filePath,
            changes: snapshot,
        }, onOperation);
        this.#viewedState = { ...this.#viewedState, ...snapshot };
    }

    async clearViewedState(): Promise<void> {
        await this.#post({
            action: 'save_viewed_state',
            path: this.#filePath,
            state: {},
        });
        this.#viewedState = {};
    }

    isSharedMode(): boolean {
        return this.#isSharedMode;
    }

    getReviewScope(): DocumentSnapshot['scope'] {
        return this.#scope;
    }

    getFilePath(): string {
        return this.#filePath;
    }
}
