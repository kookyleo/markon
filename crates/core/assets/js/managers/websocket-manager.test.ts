import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketManager, WSState, makeOpId, type WsInbound } from './websocket-manager.js';

/**
 * Minimal stub for the global `WebSocket`. Captures sent payloads and lets
 * tests synthesise inbound frames / closures via helper methods.
 */
class MockWS {
    static OPEN = 1;
    static CLOSED = 3;
    static instances: MockWS[] = [];

    url: string;
    readyState = MockWS.OPEN;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;

    constructor(url: string) {
        this.url = url;
        MockWS.instances.push(this);
        // Defer onopen so callers have a chance to attach handlers.
        queueMicrotask(() => {
            if (this.onopen) this.onopen();
        });
    }

    send(payload: string): void {
        this.sent.push(payload);
    }

    close(): void {
        this.readyState = MockWS.CLOSED;
    }

    /** Test helper: deliver a JSON-encoded message to the registered handler. */
    dispatchMessage(data: unknown): void {
        if (!this.onmessage) return;
        const ev = { data: typeof data === 'string' ? data : JSON.stringify(data) } as MessageEvent;
        this.onmessage(ev);
    }

    /** Test helper: simulate the server closing the connection. */
    triggerClose(code = 1006, reason = ''): void {
        this.readyState = MockWS.CLOSED;
        if (this.onclose) {
            this.onclose({ code, reason } as CloseEvent);
        }
    }
}

function itemAt<T>(items: ArrayLike<T>, index: number): T {
    const item = items[index];
    expect(item).toBeDefined();
    if (item === undefined) throw new Error(`Missing item at index ${index}`);
    return item;
}

const documentManager = (path = '/workspace/a.md'): WebSocketManager =>
    new WebSocketManager('abcd1234', { kind: 'document', path });

describe('WebSocketManager', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        MockWS.instances = [];
        // jsdom's window.location is read-only; stubbing the global is enough.
        vi.stubGlobal('WebSocket', MockWS);
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });

    it('connect() resolves on onopen and transitions to CONNECTED', async () => {
        const m = documentManager('/workspace/docs/intro.md');
        const states: string[] = [];
        m.onStateChange((next) => states.push(next));

        await m.connect();

        expect(m.getState()).toBe(WSState.CONNECTED);
        expect(states).toContain(WSState.CONNECTING);
        expect(states).toContain(WSState.CONNECTED);
        expect(m.isConnected()).toBe(true);

        // The URL and first frame both carry the workspace-scoped protocol.
        const ws = itemAt(MockWS.instances, 0);
        expect(ws.url).toBe('ws://localhost:3000/_/abcd1234/ws');
        expect(JSON.parse(itemAt(ws.sent, 0))).toEqual({
            type: 'hello',
            target: { kind: 'document', path: '/workspace/docs/intro.md' },
        });
    });

    it('sends an explicit surface hello on the same scoped route', async () => {
        const m = new WebSocketManager('abcd1234', {
            kind: 'surface',
            key: '/_/abcd1234/compare?base=main#change',
        });
        await m.connect();
        const ws = itemAt(MockWS.instances, 0);
        expect(JSON.parse(itemAt(ws.sent, 0))).toEqual({
            type: 'hello',
            target: {
                kind: 'surface',
                key: '/_/abcd1234/compare?base=main#change',
            },
        });
    });

    it('dispatches inbound messages to the matching handler', async () => {
        const m = documentManager();
        const handler = vi.fn<(msg: Extract<WsInbound, { type: 'new_annotation' }>) => void>();
        m.on('new_annotation', handler);

        await m.connect();
        const ws = itemAt(MockWS.instances, 0);

        ws.dispatchMessage({ type: 'new_annotation', annotation: { id: 'x1' } });

        expect(handler).toHaveBeenCalledTimes(1);
        const arg = itemAt(handler.mock.calls, 0)[0];
        expect(arg.type).toBe('new_annotation');
        expect((arg.annotation as { id: string }).id).toBe('x1');
    });

    it('ignores messages whose type has no registered handler', async () => {
        const m = documentManager();
        const newAnno = vi.fn();
        m.on('new_annotation', newAnno);

        await m.connect();
        const ws = itemAt(MockWS.instances, 0);
        ws.dispatchMessage({ type: 'clear_annotations' });

        expect(newAnno).not.toHaveBeenCalled();
    });

    it('off() unregisters a handler', async () => {
        const m = documentManager();
        const handler = vi.fn();
        m.on('clear_annotations', handler);
        m.off('clear_annotations', handler);

        await m.connect();
        const ws = itemAt(MockWS.instances, 0);
        ws.dispatchMessage({ type: 'clear_annotations' });

        expect(handler).not.toHaveBeenCalled();
    });

    it('send() serialises outbound payload to JSON', async () => {
        const m = documentManager();
        await m.connect();
        const ws = itemAt(MockWS.instances, 0);
        // ws.sent[0] is the hello; subsequent entries are collaboration frames.

        await m.send({ type: 'delete_annotation', id: 'abc' });

        expect(ws.sent.length).toBeGreaterThanOrEqual(2);
        const last = itemAt(ws.sent, ws.sent.length - 1);
        expect(JSON.parse(last)).toEqual({ type: 'delete_annotation', id: 'abc' });
    });

    it('send() is a no-op when not connected', async () => {
        const m = documentManager();
        await m.send({ type: 'clear_annotations' });
        // No socket should have been created — send happens before connect.
        expect(MockWS.instances.length).toBe(0);
        expect(warnSpy).toHaveBeenCalled();
    });

    it('reconnects with exponential backoff after onclose', async () => {
        vi.useFakeTimers();
        const m = documentManager();
        const connectPromise = m.connect();
        // Flush queued microtasks so onopen fires.
        await vi.advanceTimersByTimeAsync(0);
        await connectPromise;

        expect(MockWS.instances.length).toBe(1);
        const first = itemAt(MockWS.instances, 0);
        first.triggerClose(1006, 'lost');

        expect(m.getState()).toBe(WSState.RECONNECTING);
        // Initial reconnect delay is 1000ms in CONFIG.WEBSOCKET.
        await vi.advanceTimersByTimeAsync(1000);
        // A second WebSocket should now have been constructed.
        expect(MockWS.instances.length).toBe(2);
    });

    it('disconnect() clears state and timers without scheduling a reconnect', async () => {
        vi.useFakeTimers();
        const m = documentManager();
        const p = m.connect();
        await vi.advanceTimersByTimeAsync(0);
        await p;

        m.disconnect();
        expect(m.getState()).toBe(WSState.DISCONNECTED);
        expect(m.isConnected()).toBe(false);

        // Advance well past any reconnect window — no new socket should appear.
        await vi.advanceTimersByTimeAsync(60_000);
        expect(MockWS.instances.length).toBe(1);
    });

    // ── op_id echo dedup ──────────────────────────────────────────────────

    it('makeOpId() produces 16-hex-char ids that vary across calls', () => {
        const ids = new Set<string>();
        for (let i = 0; i < 50; i++) {
            const id = makeOpId();
            expect(id).toMatch(/^[0-9a-f]{16}$/);
            ids.add(id);
        }
        // 50 of 2^64 collisions is astronomically unlikely.
        expect(ids.size).toBe(50);
    });

    it('isOwnEcho() returns true exactly once for a recorded op_id', () => {
        const m = documentManager();
        m.recordOutgoing('op-x');
        expect(m.isOwnEcho('op-x')).toBe(true);
        // Second hit is a miss — entry was consumed.
        expect(m.isOwnEcho('op-x')).toBe(false);
    });

    it('isOwnEcho() returns false for null / undefined / unknown ids', () => {
        const m = documentManager();
        expect(m.isOwnEcho(null)).toBe(false);
        expect(m.isOwnEcho(undefined)).toBe(false);
        expect(m.isOwnEcho('never-sent')).toBe(false);
    });

    it('isOwnEcho() prunes entries older than the 30s TTL', () => {
        vi.useFakeTimers();
        const m = documentManager();
        m.recordOutgoing('op-old');
        // Advance just past the 30s TTL.
        vi.advanceTimersByTime(30_001);
        expect(m.isOwnEcho('op-old')).toBe(false);
    });

    it('recordOutgoing() bounds the dedup map to 256 entries', () => {
        const m = documentManager();
        // Insert 300 entries; the oldest should be evicted.
        for (let i = 0; i < 300; i++) {
            m.recordOutgoing(`op-${i}`);
        }
        // Earliest ids must have been dropped to keep the map bounded.
        expect(m.isOwnEcho('op-0')).toBe(false);
        expect(m.isOwnEcho('op-43')).toBe(false);
        // Most recent ids are still recognised.
        expect(m.isOwnEcho('op-299')).toBe(true);
        expect(m.isOwnEcho('op-298')).toBe(true);
    });

    it('sendWithOpId() tags the outgoing frame and records the id', async () => {
        const m = documentManager();
        await m.connect();
        const ws = itemAt(MockWS.instances, 0);

        const opId = await m.sendWithOpId({
            type: 'new_annotation',
            annotation: { id: 'anno-1' },
        });

        expect(opId).toMatch(/^[0-9a-f]{16}$/);
        // ws.sent[0] is the hello; the mutation frame follows.
        const rawFrame = itemAt(ws.sent, ws.sent.length - 1);
        expect(rawFrame).toBeDefined();
        const last = JSON.parse(String(rawFrame)) as Record<string, unknown>;
        expect(last['type']).toBe('new_annotation');
        expect(last['op_id']).toBe(opId);
        // The same op_id is recognised as own echo (single-shot).
        expect(m.isOwnEcho(opId)).toBe(true);
        expect(m.isOwnEcho(opId)).toBe(false);
    });
});
