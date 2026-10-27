/** Workspace capability changes use an always-on channel, separate from Live
 *  and shared review updates, so disabled capabilities can still be enabled. */
import { CONFIG } from './config';
import { Logger } from './utils';

const subscriptions = new Map<string, () => void>();

/** Subscribe once per workspace for this page. Reloading re-resolves review
 *  scope, permissions, and all capability-dependent UI from server metadata. */
export function startWorkspaceConfigWatcher(
    workspaceId: string,
    onChange: () => void = () => window.location.reload(),
): () => void {
    const existing = subscriptions.get(workspaceId);
    if (existing) return existing;

    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let stopped = false;

    const reconnect = (): void => {
        if (stopped || retryTimer !== null) return;
        const delay = Math.min(
            CONFIG.WEBSOCKET.MAX_RECONNECT_DELAY,
            CONFIG.WEBSOCKET.INITIAL_RECONNECT_DELAY * 2 ** attempt++,
        );
        retryTimer = setTimeout(() => {
            retryTimer = null;
            connect();
        }, delay);
    };
    const connect = (): void => {
        if (stopped || socket) return;
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        try {
            // This legacy configuration channel is distinct from the review /
            // presentation channel at /_/{workspace_id}/ws.
            const current = new WebSocket(
                `${protocol}//${window.location.host}/_/ws/${encodeURIComponent(workspaceId)}`,
            );
            socket = current;
            current.onopen = () => { attempt = 0; };
            current.onmessage = () => {
                if (!stopped && socket === current) onChange();
            };
            current.onclose = () => {
                if (stopped || socket !== current) return;
                socket = null;
                reconnect();
            };
        } catch (error) {
            Logger.warn('WorkspaceConfig', 'Configuration socket unavailable:', error);
            reconnect();
        }
    };
    const stop = (): void => {
        if (stopped) return;
        stopped = true;
        if (retryTimer !== null) clearTimeout(retryTimer);
        retryTimer = null;
        const current = socket;
        socket = null;
        if (current) current.close();
        subscriptions.delete(workspaceId);
        window.removeEventListener('beforeunload', stop);
    };
    subscriptions.set(workspaceId, stop);
    window.addEventListener('beforeunload', stop);
    connect();
    return stop;
}
