/**
 * WebSocketManager - WebSocket connection manager.
 * Handles connection, reconnection (exponential backoff), and typed
 * message dispatching to per-message-type handlers.
 */

import { CONFIG, type WsMessageType } from '../core/config';
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
export type WsInbound =
    | { type: 'all_annotations'; annotations: unknown[] }
    | { type: 'new_annotation'; annotation: unknown }
    | { type: 'delete_annotation'; id: string }
    | { type: 'clear_annotations' }
    | { type: 'viewed_state'; state: Record<string, boolean> }
    | { type: 'update_viewed_state'; state: Record<string, boolean> }
    | { type: 'live_action'; data: { action: string; [k: string]: unknown } }
    | { type: 'file_changed'; workspace_id: string; path: string };

/**
 * Discriminated union of WebSocket messages sent to the server.
 * Mirrors the call sites in `storage-manager` and `collaboration-manager`.
 */
export type WsOutbound =
    | { type: 'new_annotation'; annotation: unknown }
    | { type: 'delete_annotation'; id: string }
    | { type: 'clear_annotations' }
    | { type: 'update_viewed_state'; state: Record<string, boolean> }
    | { type: 'live_action'; data: { action: string; [k: string]: unknown } };

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
    #onStateChange: StateChangeCallback | null = null;

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
     * Registers a typed handler for a specific inbound message type.
     * The compiler narrows `msg` to the matching variant of `WsInbound`.
     */
    on<T extends WsInbound['type']>(type: T, handler: WsHandler<T>): void {
        const list = this.#messageHandlers.get(type) ?? [];
        list.push(handler as (msg: WsInbound) => void);
        this.#messageHandlers.set(type, list);
        Logger.log('WebSocket', `Registered handler for message type: ${type}`);
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
            if (!handlers) return;
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

// Re-export the message-type alias to give downstream callers a single
// import surface (e.g. chat-manager will want `WsMessageType` for routing).
export type { WsMessageType };
