import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    StorageManager,
    LocalStorageStrategy,
} from './storage-manager.js';
import type { Annotation } from './annotation-manager.js';
import type { WebSocketManager } from './websocket-manager.js';

/** Minimal WebSocketManager fake for HTTP-broadcast op-id correlation. */
function makeFakeWs(connected: boolean) {
    const fake = {
        isConnected: () => connected,
        recordOutgoing: vi.fn(),
        isOwnEcho: vi.fn(() => false),
    };
    return { fake: fake as unknown as WebSocketManager };
}

/** Build a fully-shaped Annotation for storage round-trip tests; only `id`
 * and any explicitly-overridden fields matter to these tests. */
function makeAnno(overrides: Partial<Annotation> & { id: string }): Annotation {
    return {
        type: 'highlight-yellow',
        tagName: 'span',
        anchor: { position: 0, exact: '', prefix: '', suffix: '' },
        text: '',
        note: null,
        createdAt: 0,
        ...overrides,
    };
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
        vi.unstubAllGlobals();
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

    describe('StorageManager facade', () => {
        it('selects LocalStorageStrategy when not in shared mode', async () => {
            const m = new StorageManager('foo.md', false);
            expect(m.isSharedMode()).toBe(false);
            expect(m.getFilePath()).toBe('foo.md');

            const a = makeAnno({ id: 'a' });
            const b = makeAnno({ id: 'b' });
            await m.saveAnnotations([a, b]);
            expect(await m.loadAnnotations()).toEqual([a, b]);
        });

        it('persists through HTTP and records the shared broadcast op id', async () => {
            const { fake } = makeFakeWs(true);
            const fetchMock = vi.fn(async () => ({
                ok: true,
                status: 204,
                text: async () => '',
            }));
            vi.stubGlobal('fetch', fetchMock);
            const m = new StorageManager('foo.md', true, fake, 'abc123');
            expect(m.isSharedMode()).toBe(true);

            const anno = makeAnno({ id: 'x1' });
            const opId = await m.saveAnnotation(anno);
            expect(opId).toMatch(/^[0-9a-f]{16}$/);
            expect(fake.recordOutgoing).toHaveBeenCalledWith(opId);
            const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
            expect(JSON.parse(init.body as string)).toMatchObject({
                action: 'save_annotation',
                path: 'foo.md',
                annotation: anno,
                op_id: opId,
            });
        });

        it('merges legacy local annotations into SQLite then removes the origin copy', async () => {
            const localOnly = makeAnno({ id: 'anno-local' });
            const persisted = makeAnno({ id: 'anno-server' });
            await StorageManager.saveLocalAnnotations('/docs/foo.md', [localOnly]);
            const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
                if (!init?.method) {
                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({ annotations: [persisted], viewed_state: {} }),
                    };
                }
                return { ok: true, status: 204, text: async () => '' };
            });
            vi.stubGlobal('fetch', fetchMock);
            const m = new StorageManager('/docs/foo.md', false, null, 'abc123');
            expect(await m.loadAnnotations()).toEqual([persisted, localOnly]);
            expect(fetchMock).toHaveBeenCalledTimes(2);
            expect(localStorage.getItem('markon-annotations-/docs/foo.md')).toBeNull();
        });

        it('serializes SQLite mutations so a slow older viewed state cannot win', async () => {
            let releaseFirst!: () => void;
            const firstResponse = new Promise<void>((resolve) => { releaseFirst = resolve; });
            const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
                if (fetchMock.mock.calls.length === 1) await firstResponse;
                return { ok: true, status: 204, text: async () => '' };
            });
            vi.stubGlobal('fetch', fetchMock);
            const m = new StorageManager('/docs/foo.md', false, null, 'abc123');

            const older = m.saveViewedState({ section: false });
            await Promise.resolve();
            const newer = m.saveViewedState({ section: true });
            await Promise.resolve();
            expect(fetchMock).toHaveBeenCalledTimes(1);

            releaseFirst();
            await older;
            await newer;
            expect(fetchMock).toHaveBeenCalledTimes(2);
            const bodies = fetchMock.mock.calls.map(([, init]) => {
                const parsed = JSON.parse(init?.body as string) as unknown;
                return parsed as { state: Record<string, boolean> };
            });
            expect(bodies.map(body => body.state)).toEqual([
                { section: false },
                { section: true },
            ]);
        });

        it('local mode upserts and removes annotations through the array', async () => {
            const m = new StorageManager('foo.md', false);
            const a1 = makeAnno({ id: 'a', text: '1' });
            const b = makeAnno({ id: 'b', text: '2' });
            const a2 = makeAnno({ id: 'a', text: '99' }); // update existing
            await m.saveAnnotation(a1);
            await m.saveAnnotation(b);
            await m.saveAnnotation(a2);

            let annos = await m.loadAnnotations();
            expect(annos).toEqual([a2, b]);

            await m.deleteAnnotation('a');
            annos = await m.loadAnnotations();
            expect(annos).toEqual([b]);
        });

        it('round-trips version 2 fragment anchors without a schema migration', async () => {
            const m = new StorageManager('cross-block.md', false);
            const annotation = makeAnno({
                id: 'cross',
                text: 'Heading\nBody',
                anchor: {
                    position: 0,
                    exact: 'HeadingBody',
                    prefix: '',
                    suffix: '',
                    version: 2,
                    fragments: [
                        {
                            position: 0,
                            exact: 'Heading',
                            prefix: '',
                            suffix: 'Body',
                            blockTag: 'H2',
                        },
                        {
                            position: 7,
                            exact: 'Body',
                            prefix: 'Heading',
                            suffix: '',
                            blockTag: 'P',
                        },
                    ],
                },
            });

            await m.saveAnnotation(annotation);
            expect(await m.loadAnnotations()).toEqual([annotation]);
            expect(JSON.parse(localStorage.getItem('markon-annotations-cross-block.md')!)).toEqual([
                annotation,
            ]);
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
            m.updateCache('markon-annotations-foo.md', [makeAnno({ id: 'a' })]);
            expect(localStorage.getItem('markon-annotations-foo.md')).toBeNull();
        });

        it('loads and saves the local annotation mirror independent of mode', async () => {
            const a = makeAnno({ id: 'a' });
            await StorageManager.saveLocalAnnotations('foo.md', [a]);
            expect(await StorageManager.loadLocalAnnotations('foo.md')).toEqual([a]);
        });

        it('falls back to LocalStorageStrategy when shared mode is requested but ws is null', () => {
            const m = new StorageManager('foo.md', true, null);
            const a = makeAnno({ id: 'a' });
            // No ws supplied: facade should silently degrade to local mode storage.
            // We assert behaviour by writing and reading; localStorage should be hit.
            return m.saveAnnotations([a]).then(async () => {
                const raw = localStorage.getItem('markon-annotations-foo.md');
                expect(raw).not.toBeNull();
                expect(JSON.parse(raw as string)).toEqual([a]);
            });
        });
    });
});
