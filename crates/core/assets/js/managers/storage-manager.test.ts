import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    StorageManager,
    LocalStorageStrategy,
    SharedStorageStrategy,
} from './storage-manager.js';
import type { WebSocketManager } from './websocket-manager.js';
import type { WsOutbound } from './websocket-manager.js';

/** Minimal WebSocketManager fake — just enough for SharedStorageStrategy. */
function makeFakeWs(connected: boolean) {
    const sent: WsOutbound[] = [];
    const fake = {
        isConnected: () => connected,
        send: vi.fn(async (msg: WsOutbound) => {
            sent.push(msg);
        }),
    };
    return { fake: fake as unknown as WebSocketManager, sent };
}

describe('StorageManager', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        localStorage.clear();
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
        localStorage.clear();
    });

    describe('LocalStorageStrategy', () => {
        it('round-trips load/save/delete via localStorage', async () => {
            const s = new LocalStorageStrategy<{ value: number }>();
            await s.save('k', { value: 42 });
            const loaded = await s.load('k');
            expect(loaded).toEqual({ value: 42 });

            await s.delete('k');
            expect(await s.load('k')).toBeNull();
        });

        it('returns null for a missing key', async () => {
            const s = new LocalStorageStrategy();
            expect(await s.load('missing')).toBeNull();
        });

        it('returns null and logs error on malformed JSON', async () => {
            localStorage.setItem('bad', 'not-json{');
            const s = new LocalStorageStrategy();
            expect(await s.load('bad')).toBeNull();
            expect(errorSpy).toHaveBeenCalled();
        });
    });

    describe('SharedStorageStrategy', () => {
        it('caches saved data and pushes viewed-state via WebSocket', async () => {
            const { fake, sent } = makeFakeWs(true);
            const s = new SharedStorageStrategy(fake);

            await s.save('markon-viewed-foo.md', { h1: true });
            expect(sent).toEqual([{ type: 'update_viewed_state', state: { h1: true } }]);

            // Cache should be populated, so load returns the saved value.
            expect(await s.load('markon-viewed-foo.md')).toEqual({ h1: true });
        });

        it('updateCache populates load() without a WS round-trip', async () => {
            const { fake, sent } = makeFakeWs(true);
            const s = new SharedStorageStrategy(fake);

            s.updateCache('markon-annotations-foo.md', [{ id: 'a' }]);
            expect(await s.load('markon-annotations-foo.md')).toEqual([{ id: 'a' }]);
            // No outbound messages should have been emitted.
            expect(sent).toEqual([]);
        });

        it('saveSingleAnnotation emits new_annotation', async () => {
            const { fake, sent } = makeFakeWs(true);
            const s = new SharedStorageStrategy(fake);
            await s.saveSingleAnnotation({ id: 'x1', value: 'hi' });
            expect(sent).toEqual([{ type: 'new_annotation', annotation: { id: 'x1', value: 'hi' } }]);
        });

        it('deleteSingleAnnotation emits delete_annotation', async () => {
            const { fake, sent } = makeFakeWs(true);
            const s = new SharedStorageStrategy(fake);
            await s.deleteSingleAnnotation('x1');
            expect(sent).toEqual([{ type: 'delete_annotation', id: 'x1' }]);
        });

        it('delete() routes annotations vs viewed keys to different ws messages', async () => {
            const { fake, sent } = makeFakeWs(true);
            const s = new SharedStorageStrategy(fake);

            await s.delete('markon-annotations-foo.md');
            await s.delete('markon-viewed-foo.md');

            expect(sent).toEqual([
                { type: 'clear_annotations' },
                { type: 'update_viewed_state', state: {} },
            ]);
        });

        it('save() warns and skips network when ws is disconnected', async () => {
            const { fake, sent } = makeFakeWs(false);
            const s = new SharedStorageStrategy(fake);
            await s.save('markon-viewed-foo.md', { h1: true });
            expect(sent).toEqual([]);
            expect(warnSpy).toHaveBeenCalled();
            // But cache is still updated.
            expect(await s.load('markon-viewed-foo.md')).toEqual({ h1: true });
        });

        it('clearCache(key) removes a single entry; clearCache() removes all', async () => {
            const { fake } = makeFakeWs(true);
            const s = new SharedStorageStrategy(fake);
            s.updateCache('a', 1);
            s.updateCache('b', 2);

            s.clearCache('a');
            expect(await s.load('a')).toBeNull();
            expect(await s.load('b')).toBe(2);

            s.clearCache();
            expect(await s.load('b')).toBeNull();
        });
    });

    describe('StorageManager facade', () => {
        it('selects LocalStorageStrategy when not in shared mode', async () => {
            const m = new StorageManager('foo.md', false);
            expect(m.isSharedMode()).toBe(false);
            expect(m.getFilePath()).toBe('foo.md');

            await m.saveAnnotations([{ id: 'a' }, { id: 'b' }]);
            const annos = await m.loadAnnotations();
            expect(annos).toEqual([{ id: 'a' }, { id: 'b' }]);
        });

        it('selects SharedStorageStrategy when shared mode + ws given', async () => {
            const { fake, sent } = makeFakeWs(true);
            const m = new StorageManager('foo.md', true, fake);
            expect(m.isSharedMode()).toBe(true);

            await m.saveAnnotation({ id: 'x1' });
            expect(sent).toEqual([{ type: 'new_annotation', annotation: { id: 'x1' } }]);
        });

        it('local mode upserts and removes annotations through the array', async () => {
            const m = new StorageManager('foo.md', false);
            await m.saveAnnotation({ id: 'a', v: 1 });
            await m.saveAnnotation({ id: 'b', v: 2 });
            await m.saveAnnotation({ id: 'a', v: 99 }); // update existing

            let annos = await m.loadAnnotations();
            expect(annos).toEqual([
                { id: 'a', v: 99 },
                { id: 'b', v: 2 },
            ]);

            await m.deleteAnnotation('a');
            annos = await m.loadAnnotations();
            expect(annos).toEqual([{ id: 'b', v: 2 }]);
        });

        it('viewed-state save/load/clear round-trip in local mode', async () => {
            const m = new StorageManager('foo.md', false);
            expect(await m.loadViewedState()).toEqual({});
            await m.saveViewedState({ h1: true, h2: false });
            expect(await m.loadViewedState()).toEqual({ h1: true, h2: false });
            await m.clearViewedState();
            expect(await m.loadViewedState()).toEqual({});
        });

        it('updateCache() is a no-op in local mode', async () => {
            const m = new StorageManager('foo.md', false);
            // Should not throw and should not write to localStorage.
            m.updateCache('markon-annotations-foo.md', [{ id: 'a' }]);
            expect(localStorage.getItem('markon-annotations-foo.md')).toBeNull();
        });

        it('falls back to LocalStorageStrategy when shared mode is requested but ws is null', () => {
            const m = new StorageManager('foo.md', true, null);
            // No ws supplied: facade should silently degrade to local mode storage.
            // We assert behaviour by writing and reading; localStorage should be hit.
            return m.saveAnnotations([{ id: 'a' }]).then(async () => {
                const raw = localStorage.getItem('markon-annotations-foo.md');
                expect(raw).not.toBeNull();
                expect(JSON.parse(raw as string)).toEqual([{ id: 'a' }]);
            });
        });
    });
});
