/**
 * WebSocketManager - WebSocket connection manager
 * Handles connection, reconnection, message sending and receiving
 */

import { CONFIG } from '../core/config.js';
import { Logger } from '../core/utils.js';

/**
 * WebSocket State枚举
 */
export const WSState = {
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    RECONNECTING: 'reconnecting',
};

/**
 * WebSocket Management器
 */
export class WebSocketManager {
    #ws = null;
    #state = WSState.DISCONNECTED;
    #filePath;
    #reconnectAttempts = 0;
    #reconnectTimer = null;
    #stabilityTimer = null;
    #messageHandlers = new Map();
    #onStateChange = null;

    constructor(filePath) {
        this.#filePath = filePath;
    }

    /**
     * Get原生 WebSocket Object（用于向后兼容）
     * @returns {WebSocket|null}
     */
    getWebSocket() {
        return this.#ws;
    }

    /**
     * Connection到 WebSocket 服务器
     * @returns {Promise<void>}
     */
    async connect() {
        if (this.#state === WSState.CONNECTED || this.#state === WSState.CONNECTING) {
            Logger.warn('WebSocket', 'Already connected or connecting');
            return;
        }

        this.#setState(WSState.CONNECTING);

        return new Promise((resolve, reject) => {
            try {
                const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                const wsUrl = `${wsProtocol}//${window.location.host}/_/ws`;

                Logger.log('WebSocket', `Connecting to ${wsUrl}...`);
                this.#ws = new WebSocket(wsUrl);

                this.#ws.onopen = () => {
                    Logger.log('WebSocket', 'Connected successfully');
                    this.#setState(WSState.CONNECTED);

                    // 发送FilePath作为第一条Message
                    if (this.#filePath) {
                        this.#ws.send(this.#filePath);
                        Logger.log('WebSocket', `Sent file path: ${this.#filePath}`);
                    }

                    // Settings稳定性检测定时器
                    this.#setupStabilityTimer();

                    resolve();
                };

                this.#ws.onmessage = (event) => {
                    this.#handleMessage(event);
                };

                this.#ws.onclose = (event) => {
                    this.#handleClose(event);
                };

                this.#ws.onerror = (error) => {
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

    /**
     * 断开Connection
     */
    disconnect() {
        this.#clearTimers();

        if (this.#ws) {
            this.#ws.close();
            this.#ws = null;
        }

        this.#setState(WSState.DISCONNECTED);
        Logger.log('WebSocket', 'Disconnected');
    }

    /**
     * 发送Message
     * @param {Object} message - 要发送的MessageObject
     * @returns {Promise<void>}
     */
    async send(message) {
        if (!this.isConnected()) {
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
     * RegisterMessageHandle器
     * @param {string} type - Message types
     * @param {Function} handler - Handle函数
     */
    on(type, handler) {
        if (!this.#messageHandlers.has(type)) {
            this.#messageHandlers.set(type, []);
        }
        this.#messageHandlers.get(type).push(handler);
        Logger.log('WebSocket', `Registered handler for message type: ${type}`);
    }

    /**
     * CancelRegisterMessageHandle器
     * @param {string} type - Message types
     * @param {Function} handler - Handle函数
     */
    off(type, handler) {
        if (this.#messageHandlers.has(type)) {
            const handlers = this.#messageHandlers.get(type);
            const index = handlers.indexOf(handler);
            if (index >= 0) {
                handlers.splice(index, 1);
            }
        }
    }

    /**
     * SettingsState变化Callback
     * @param {Function} callback - Callback函数
     */
    onStateChange(callback) {
        this.#onStateChange = callback;
    }

    /**
     * Check是否已Connection
     * @returns {boolean}
     */
    isConnected() {
        return this.#state === WSState.CONNECTED &&
               this.#ws &&
               this.#ws.readyState === WebSocket.OPEN;
    }

    /**
     * Get当前State
     * @returns {string}
     */
    getState() {
        return this.#state;
    }

    /**
     * Handle收到的Message
     * @private
     */
    #handleMessage(event) {
        try {
            const message = JSON.parse(event.data);
            Logger.log('WebSocket', `Received message: ${message.type}`);

            // Trigger对应的Handle器
            if (this.#messageHandlers.has(message.type)) {
                const handlers = this.#messageHandlers.get(message.type);
                handlers.forEach(handler => {
                    try {
                        handler(message);
                    } catch (error) {
                        Logger.error('WebSocket', `Handler error for ${message.type}:`, error);
                    }
                });
            }
        } catch (error) {
            Logger.error('WebSocket', 'Failed to parse message:', error);
        }
    }

    /**
     * HandleConnectionClose
     * @private
     */
    #handleClose(event) {
        this.#clearTimers();
        Logger.log('WebSocket', `Connection closed (code: ${event.code}, reason: ${event.reason || 'none'})`);

        // Settings为重连State
        this.#setState(WSState.RECONNECTING);

        // Calculate指数退避延迟
        this.#reconnectAttempts++;
        const delay = Math.min(
            CONFIG.WEBSOCKET.INITIAL_RECONNECT_DELAY * Math.pow(2, this.#reconnectAttempts - 1),
            CONFIG.WEBSOCKET.MAX_RECONNECT_DELAY
        );

        Logger.log('WebSocket', `Reconnecting in ${delay / 1000}s (attempt ${this.#reconnectAttempts})...`);

        // Settings重连定时器
        this.#reconnectTimer = setTimeout(() => {
            this.connect().catch(error => {
                Logger.error('WebSocket', 'Reconnect failed:', error);
            });
        }, delay);
    }

    /**
     * Settings稳定性检测定时器
     * 如果Connection稳定一段Time，Reset重连计数器
     * @private
     */
    #setupStabilityTimer() {
        this.#clearStabilityTimer();

        this.#stabilityTimer = setTimeout(() => {
            this.#reconnectAttempts = 0;
            Logger.log('WebSocket', 'Connection stable, reset reconnect counter');
        }, CONFIG.WEBSOCKET.STABLE_CONNECTION_THRESHOLD);
    }

    /**
     * Clear所有定时器
     * @private
     */
    #clearTimers() {
        this.#clearReconnectTimer();
        this.#clearStabilityTimer();
    }

    /**
     * Clear重连定时器
     * @private
     */
    #clearReconnectTimer() {
        if (this.#reconnectTimer) {
            clearTimeout(this.#reconnectTimer);
            this.#reconnectTimer = null;
        }
    }

    /**
     * Clear稳定性定时器
     * @private
     */
    #clearStabilityTimer() {
        if (this.#stabilityTimer) {
            clearTimeout(this.#stabilityTimer);
            this.#stabilityTimer = null;
        }
    }

    /**
     * SettingsState并TriggerCallback
     * @private
     */
    #setState(newState) {
        const oldState = this.#state;
        this.#state = newState;

        if (this.#onStateChange && oldState !== newState) {
            this.#onStateChange(newState, oldState);
        }
    }
}
