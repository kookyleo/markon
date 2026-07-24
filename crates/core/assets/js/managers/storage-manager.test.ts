import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageManager } from './storage-manager.js';
import type { Annotation } from './annotation-manager.js';
import type { WebSocketManager } from './websocket-manager.js';

function makeFakeWs(connected: boolean) {
    const fake = {
        isConnected: () => connected,
        recordOutgoing: vi.fn(),
        isOwnEcho: vi.fn(() => false),
    };
    return { fake: fake as unknown as WebSocketManager };
}

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

function snapshotResponse(
    annotations: Annotation[] = [],
    viewedState: Record<string, boolean> = {},
) {
    return {
        ok: true,
        status: 200,
        text: async (): Promise<string> => '',
        json: async (): Promise<DocumentSnapshotForTest> => ({
            annotations,
            viewed_state: viewedState,
        }),
    };
}

function emptyResponse() {
    return {
        ok: true,
        status: 204,
        text: async (): Promise<string> => '',
    };
}

type DocumentSnapshotForTest = {
    annotations: Annotation[];
    viewed_state: Record<string, boolean>;
};

describe('StorageManager SQLite-only document state', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        localStorage.clear();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('requires a workspace id instead of silently choosing browser storage', () => {
        expect(() => new StorageManager('foo.md', false, null, '')).toThrow(
            'workspace-id is required',
        );
    });

    it('loads annotations and viewed state from one SQLite snapshot', async () => {
        const annotation = makeAnno({ id: 'a', text: 'hello' });
        const fetchMock = vi.fn(async (_url: string) =>
            snapshotResponse([annotation], { intro: true }),
        );
        vi.stubGlobal('fetch', fetchMock);
        const manager = new StorageManager('/docs/foo.md', false, null, 'abc123');

        expect(await manager.loadAnnotations()).toEqual([annotation]);
        expect(await manager.loadViewedState()).toEqual({ intro: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
            '/_/abc123/data/document-state?path=%2Fdocs%2Ffoo.md',
        );
        expect(localStorage.length).toBe(0);
    });

    it('persists an annotation through HTTP and records its shared broadcast op id', async () => {
        const { fake } = makeFakeWs(true);
        const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
            init?.method === 'POST' ? emptyResponse() : snapshotResponse(),
        );
        vi.stubGlobal('fetch', fetchMock);
        const manager = new StorageManager('foo.md', true, fake, 'abc123');
        const annotation = makeAnno({ id: 'x1' });

        const opId = await manager.saveAnnotation(annotation);

        expect(opId).toMatch(/^[0-9a-f]{16}$/);
        expect(fake.recordOutgoing).toHaveBeenCalledWith(opId);
        const [, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
        expect(JSON.parse(init.body as string)).toMatchObject({
            action: 'save_annotation',
            path: 'foo.md',
            annotation,
            op_id: opId,
        });
        expect(await manager.loadAnnotations()).toEqual([annotation]);
        expect(localStorage.length).toBe(0);
    });

    it('round-trips version 2 fragment anchors without changing the persisted schema', async () => {
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
        const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
            init?.method === 'POST' ? emptyResponse() : snapshotResponse(),
        );
        vi.stubGlobal('fetch', fetchMock);
        const manager = new StorageManager('cross-block.md', false, null, 'abc123');

        await manager.saveAnnotation(annotation);

        const [, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
        expect(JSON.parse(init.body as string).annotation).toEqual(annotation);
        expect(await manager.loadAnnotations()).toEqual([annotation]);
        expect(localStorage.length).toBe(0);
    });

    it('serializes viewed-state writes so an older request cannot win', async () => {
        let releaseFirst!: () => void;
        const firstResponse = new Promise<void>((resolve) => { releaseFirst = resolve; });
        const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
            if (fetchMock.mock.calls.length === 1) await firstResponse;
            return emptyResponse();
        });
        vi.stubGlobal('fetch', fetchMock);
        const manager = new StorageManager('/docs/foo.md', false, null, 'abc123');

        const older = manager.saveViewedState({ section: false });
        await Promise.resolve();
        const newer = manager.saveViewedState({ section: true });
        await Promise.resolve();
        expect(fetchMock).toHaveBeenCalledTimes(1);

        releaseFirst();
        await older;
        await newer;
        const bodies = fetchMock.mock.calls.map(([, init]) =>
            JSON.parse(init?.body as string) as { state: Record<string, boolean> },
        );
        expect(bodies.map(body => body.state)).toEqual([
            { section: false },
            { section: true },
        ]);
    });

    it('deletes and clears annotations only after the service commits them', async () => {
        const a = makeAnno({ id: 'a' });
        const b = makeAnno({ id: 'b' });
        const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
            init?.method === 'POST' ? emptyResponse() : snapshotResponse([a, b]),
        );
        vi.stubGlobal('fetch', fetchMock);
        const manager = new StorageManager('foo.md', false, null, 'abc123');

        await manager.deleteAnnotation('a');
        expect(await manager.loadAnnotations()).toEqual([b]);
        await manager.clearAnnotations();
        expect(await manager.loadAnnotations()).toEqual([]);

        const actions = fetchMock.mock.calls
            .filter(([, init]) => init?.method === 'POST')
            .map(([, init]) =>
                (JSON.parse(init?.body as string) as { action: string }).action,
            );
        expect(actions).toEqual(['delete_annotation', 'clear_annotations']);
        expect(localStorage.length).toBe(0);
    });

    it('propagates service failures without writing an origin-local fallback', async () => {
        localStorage.setItem('unrelated-preference', 'keep');
        const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
            if (init?.method === 'POST') {
                return {
                    ok: false,
                    status: 403,
                    text: async (): Promise<string> => 'Forbidden',
                };
            }
            return snapshotResponse();
        });
        vi.stubGlobal('fetch', fetchMock);
        const manager = new StorageManager('foo.md', false, null, 'abc123');

        await expect(manager.saveAnnotation(makeAnno({ id: 'a' }))).rejects.toThrow(
            'document state save failed (403)',
        );
        await expect(manager.saveViewedState({ h1: true })).rejects.toThrow(
            'document state save failed (403)',
        );
        expect(localStorage.getItem('unrelated-preference')).toBe('keep');
        expect(localStorage.getItem('markon-annotations-foo.md')).toBeNull();
        expect(localStorage.getItem('markon-viewed-foo.md')).toBeNull();
    });
});
