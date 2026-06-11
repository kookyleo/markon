/**
 * WebSocketManager - WebSocket connection manager.
 * Handles connection, reconnection (exponential backoff), and typed
 * message dispatching to per-message-type handlers.
 */

import { CONFIG } from '../core/config';
import { Logger } from '../core/utils';

/** Connection state machine. */
export const WSState = {
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    RECONNECTING: 'reconnecting',
} as const;

export type WSStateValue = (typeof WSState)[keyof typeof WSState];

/**
 * Discriminated union of WebSocket messages received from the server.
 *
 * Annotation payloads are deliberately typed as `unknown` here — the
 * concrete `Annotation` shape is owned by `annotation-manager` and will be
 * tightened in a later phase.
 */
// TODO(phase-3-typing): replace `unknown` annotation/state shapes once
// annotation-manager exports proper `Annotation` and `ViewedState` types.
//
// Mutating variants may carry an opaque `op_id` set by the originating
// client. The server round-trips it verbatim so the originator can recognise
// (and skip) its own echo. Field is optional for back-compat with older
// peers that don't emit it.
export type WsInbound =
    | { type: 'all_annotations'; annotations: unknown[] }
    | { type: 'new_annotation'; annotation: unknown; op_id?: string | null }
    | { type: 'delete_annotation'; id: string; op_id?: string | null }
    | { type: 'clear_annotations'; op_id?: string | null }
    | { type: 'viewed_state'; state: Record<string, boolean>; op_id?: string | null }
    | { type: 'update_viewed_state'; state: Record<string, boolean>; op_id?: string | null }
    | { type: 'live_action'; data: { action: string; [k: string]: unknown } }
    | { type: 'file_changed'; workspace_id: string; path: string };

/**
 * Discriminated union of WebSocket messages sent to the server.
 * Mirrors the call sites in `storage-manager` and `collaboration-manager`.
 *
 * Mutating variants accept an optional `op_id`. Prefer `sendWithOpId()` to
 * have one generated and recorded for echo dedup automatically.
 */
export type WsOutbound =
    | { type: 'new_annotation'; annotation: unknown; op_id?: string }
    | { type: 'delete_annotation'; id: string; op_id?: string }
    | { type: 'clear_annotations'; op_id?: string }
    | { type: 'update_viewed_state'; state: Record<string, boolean>; op_id?: string }
    | { type: 'live_action'; data: { action: string; [k: string]: unknown } };

/** Outbound messages that participate in op_id-based echo dedup. */
export type WsOutboundWithOpId = Exclude<WsOutbound, { type: 'live_action' }>;

/**
 * Generate a 64-bit (16 hex chars) random id, used to tag outgoing mutating
 * frames so the originator can recognise its own echo. The space is plenty
 * for in-session dedup; we don't need cryptographic uniqueness.
 */
export function makeOpId(): string {
    const a = (Math.random() * 0x100000000) >>> 0;
    const b = (Math.random() * 0x100000000) >>> 0;
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** Upper bound on the dedup map. Anything older is pruned lazily. */
const OP_ID_MAX_ENTRIES = 256;
/** TTL for a recorded op_id (ms). A round-trip is sub-second; 30s is safe. */
const OP_ID_TTL_MS = 30_000;
/** Max buffered pre-handler frames per type (only the connect-time burst). */
const PENDING_PER_TYPE_MAX = 16;

/** Type-narrowed handler for a specific inbound message type. */
export type WsHandler<T extends WsInbound['type']> = (
    msg: Extract<WsInbound, { type: T }>,
) => void;

/** Generic state-change observer. */
export type StateChangeCallback = (newState: WSStateValue, oldState: WSStateValue) => void;

export class WebSocketManager {
    #ws: WebSocket | null = null;
    #state: WSStateValue = WSState.DISCONNECTED;
    #filePath: string;
    #reconnectAttempts = 0;
    #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    #stabilityTimer: ReturnType<typeof setTimeout> | null = null;
    #messageHandlers = new Map<string, Array<(msg: WsInbound) => void>>();
    /**
     * Inbound frames that arrived before any handler was registered for their
     * type. The server pushes `all_annotations` (and `viewed_state`) the instant
     * it receives our file-path frame — which can land before the app finishes
     * wiring its handlers right after `connect()` resolves. Without this buffer
     * that initial state was silently dropped and the page looked empty until
     * the next mutation. Flushed (and cleared) the moment a handler for the type
     * registers. Bounded so a never-handled type can't grow without limit.
     */
    #pendingByType = new Map<string, WsInbound[]>();
    #onStateChange: StateChangeCallback | null = null;
    /**
     * Recently-sent op_ids → expiry timestamp (ms since epoch). An entry is
     * consumed (and removed) the first time a matching echo lands so it
     * cannot accidentally re-suppress a future genuine remote op with the
     * same — astronomically unlikely but cheap to be correct about — id.
     */
    #outgoingOpIds: Map<string, number> = new Map();

    constructor(filePath: string) {
        this.#filePath = filePath;
    }

    /** Returns the underlying native WebSocket (kept for back-compat callers). */
    getWebSocket(): WebSocket | null {
        return this.#ws;
    }

    /** Connects to the server. Resolves on `onopen`, rejects on `onerror`. */
    async connect(): Promise<void> {
        if (this.#state === WSState.CONNECTED || this.#state === WSState.CONNECTING) {
            Logger.warn('WebSocket', 'Already connected or connecting');
            return;
        }

        this.#setState(WSState.CONNECTING);

        return new Promise<void>((resolve, reject) => {
            try {
                const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                const wsUrl = `${wsProtocol}//${window.location.host}/_/ws`;

                Logger.log('WebSocket', `Connecting to ${wsUrl}...`);
                this.#ws = new WebSocket(wsUrl);

                this.#ws.onopen = () => {
                    Logger.log('WebSocket', 'Connected successfully');
                    this.#setState(WSState.CONNECTED);

                    // Send the file path as the first frame.
                    if (this.#filePath && this.#ws) {
                        this.#ws.send(this.#filePath);
                        Logger.log('WebSocket', `Sent file path: ${this.#filePath}`);
                    }

                    // Reset reconnect counter once the connection has been
                    // stable for a while.
                    this.#setupStabilityTimer();

                    resolve();
                };

                this.#ws.onmessage = (event: MessageEvent) => {
                    this.#handleMessage(event);
                };

                this.#ws.onclose = (event: CloseEvent) => {
                    this.#handleClose(event);
                };

                this.#ws.onerror = (error: Event) => {
                    Logger.error('WebSocket', 'Error occurred:', error);
                    reject(error);
                };
            } catch (error) {
                Logger.error('WebSocket', 'Failed to create connection:', error);
                this.#setState(WSState.DISCONNECTED);
                reject(error);
            }
        });
    }

    /** Closes the underlying socket and clears all timers. */
    disconnect(): void {
        this.#clearTimers();

        if (this.#ws) {
            // Detach handlers first: the async close event must not reach
            // #handleClose, which would schedule an unwanted reconnect.
            this.#ws.onclose = null;
            this.#ws.onerror = null;
            this.#ws.onmessage = null;
            this.#ws.close();
            this.#ws = null;
        }

        this.#setState(WSState.DISCONNECTED);
        Logger.log('WebSocket', 'Disconnected');
    }

    /** Sends a JSON-encoded outbound message. No-op if not connected. */
    async send(message: WsOutbound): Promise<void> {
        if (!this.isConnected() || !this.#ws) {
            Logger.warn('WebSocket', 'Cannot send message: not connected');
            return;
        }

        try {
            const json = JSON.stringify(message);
            this.#ws.send(json);
            Logger.log('WebSocket', 'Sent message:', message.type);
        } catch (error) {
            Logger.error('WebSocket', 'Failed to send message:', error);
        }
    }

    /**
     * Send a mutating message with an auto-generated `op_id`, recording it
     * for echo dedup. Returns the id so the caller can stash it on an undo
     * entry or otherwise correlate the round-trip.
     */
    async sendWithOpId(message: WsOutboundWithOpId): Promise<string> {
        const opId = makeOpId();
        this.recordOutgoing(opId);
        await this.send({ ...message, op_id: opId } as WsOutbound);
        return opId;
    }

    /**
     * Register an op_id we're about to send. Pruning happens lazily here so
     * the map stays bounded — no background timer needed.
     */
    recordOutgoing(opId: string): void {
        this.#pruneOpIds();
        this.#outgoingOpIds.set(opId, Date.now() + OP_ID_TTL_MS);
    }

    /**
     * Returns true if `opId` matches a previously recorded outgoing op. The
     * entry is consumed on match (single-shot) so a server that erroneously
     * replays the same id later can't suppress a genuine remote frame.
     */
    isOwnEcho(opId: string | null | undefined): boolean {
        if (!opId) return false;
        const expiry = this.#outgoingOpIds.get(opId);
        if (expiry === undefined) return false;
        this.#outgoingOpIds.delete(opId);
        // Treat expired entries as misses — same effect as pruning.
        return expiry > Date.now();
    }

    /**
     * Drop expired entries; if still over the cap, drop oldest insertions
     * (Map preserves insertion order). O(n) but bounded by the cap.
     */
    #pruneOpIds(): void {
        const now = Date.now();
        for (const [id, expiry] of this.#outgoingOpIds) {
            if (expiry <= now) this.#outgoingOpIds.delete(id);
        }
        while (this.#outgoingOpIds.size >= OP_ID_MAX_ENTRIES) {
            const oldest = this.#outgoingOpIds.keys().next().value;
            if (oldest === undefined) break;
            this.#outgoingOpIds.delete(oldest);
        }
    }

    /**
     * Registers a typed handler for a specific inbound message type.
     * The compiler narrows `msg` to the matching variant of `WsInbound`.
     */
    on<T extends WsInbound['type']>(type: T, handler: WsHandler<T>): void {
        const list = this.#messageHandlers.get(type) ?? [];
        list.push(handler as (msg: WsInbound) => void);
        this.#messageHandlers.set(type, list);
        Logger.log('WebSocket', `Registered handler for message type: ${type}`);

        // Replay any frames of this type that arrived before this handler
        // existed (e.g. the server's connect-time `all_annotations` push).
        const pending = this.#pendingByType.get(type);
        if (pending && pending.length) {
            this.#pendingByType.delete(type);
            for (const msg of pending) {
                try {
                    (handler as (m: WsInbound) => void)(msg);
                } catch (error) {
                    Logger.error('WebSocket', `Replay handler error for ${type}:`, error);
                }
            }
        }
    }

    /** Unregisters a previously registered handler. */
    off<T extends WsInbound['type']>(type: T, handler: WsHandler<T>): void {
        const handlers = this.#messageHandlers.get(type);
        if (!handlers) return;
        const index = handlers.indexOf(handler as (msg: WsInbound) => void);
        if (index >= 0) {
            handlers.splice(index, 1);
        }
    }

    /** Registers a single state-change observer (replaces any prior). */
    onStateChange(callback: StateChangeCallback): void {
        this.#onStateChange = callback;
    }

    isConnected(): boolean {
        return (
            this.#state === WSState.CONNECTED &&
            !!this.#ws &&
            this.#ws.readyState === WebSocket.OPEN
        );
    }

    getState(): WSStateValue {
        return this.#state;
    }

    /** Parses an incoming frame and fans it out to registered handlers. */
    #handleMessage(event: MessageEvent): void {
        try {
            const raw = JSON.parse(event.data as string) as unknown;
            if (!raw || typeof raw !== 'object' || !('type' in raw)) return;
            const message = raw as WsInbound;
            const handlers = this.#messageHandlers.get(message.type);
            if (!handlers || handlers.length === 0) {
                // No handler yet — buffer (bounded) so it can be replayed once
                // one registers. Drop the oldest if a never-handled type fills.
                const queue = this.#pendingByType.get(message.type) ?? [];
                queue.push(message);
                if (queue.length > PENDING_PER_TYPE_MAX) queue.shift();
                this.#pendingByType.set(message.type, queue);
                return;
            }
            handlers.forEach((handler) => {
                try {
                    handler(message);
                } catch (error) {
                    Logger.error('WebSocket', `Handler error for ${message.type}:`, error);
                }
            });
        } catch (error) {
            Logger.error('WebSocket', 'Failed to parse message:', error);
        }
    }

    /** Schedules an exponential-backoff reconnect attempt. */
    #handleClose(event: CloseEvent): void {
        this.#clearTimers();
        Logger.log(
            'WebSocket',
            `Connection closed (code: ${event.code}, reason: ${event.reason || 'none'})`,
        );

        this.#setState(WSState.RECONNECTING);

        this.#reconnectAttempts++;
        const delay = Math.min(
            CONFIG.WEBSOCKET.INITIAL_RECONNECT_DELAY * Math.pow(2, this.#reconnectAttempts - 1),
            CONFIG.WEBSOCKET.MAX_RECONNECT_DELAY,
        );

        Logger.log(
            'WebSocket',
            `Reconnecting in ${delay / 1000}s (attempt ${this.#reconnectAttempts})...`,
        );

        this.#reconnectTimer = setTimeout(() => {
            this.connect().catch((error: unknown) => {
                Logger.error('WebSocket', 'Reconnect failed:', error);
            });
        }, delay);
    }

    /** Resets reconnect counter once the connection has stayed up long enough. */
    #setupStabilityTimer(): void {
        this.#clearStabilityTimer();

        this.#stabilityTimer = setTimeout(() => {
            this.#reconnectAttempts = 0;
            Logger.log('WebSocket', 'Connection stable, reset reconnect counter');
        }, CONFIG.WEBSOCKET.STABLE_CONNECTION_THRESHOLD);
    }

    #clearTimers(): void {
        this.#clearReconnectTimer();
        this.#clearStabilityTimer();
    }

    #clearReconnectTimer(): void {
        if (this.#reconnectTimer) {
            clearTimeout(this.#reconnectTimer);
            this.#reconnectTimer = null;
        }
    }

    #clearStabilityTimer(): void {
        if (this.#stabilityTimer) {
            clearTimeout(this.#stabilityTimer);
            this.#stabilityTimer = null;
        }
    }

    #setState(newState: WSStateValue): void {
        const oldState = this.#state;
        this.#state = newState;

        if (this.#onStateChange && oldState !== newState) {
            this.#onStateChange(newState, oldState);
        }
    }
}
