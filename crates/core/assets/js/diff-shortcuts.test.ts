import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('diff shortcut availability', () => {
    beforeEach(() => {
        vi.resetModules();
        document.head.innerHTML = '';
        document.body.innerHTML = '<div data-diff-shell data-current-diff-view="rendered"></div>';
        delete window.shortcutsManager;
    });

    afterEach(() => {
        delete window.markonDiffAnnotations;
        delete window.shortcutsManager;
        document.body.innerHTML = '';
    });

    it.each([[true, false], [false, true], [false, false]])(
        'lists and invokes personal Notes export independently of management and Share (admin=%s, Share=%s)',
        async (admin, shared) => {
            for (const [name, value] of [['can-manage', admin], ['shared-annotation', shared]]) {
                const meta = document.createElement('meta');
                meta.name = String(name);
                meta.content = String(value);
                document.head.appendChild(meta);
            }
            const exportNotes = vi.fn().mockResolvedValue(true);
            // A read-only page also exposes an exporter stub, so method presence
            // alone must not grant this action.
            window.markonDiffAnnotations = {
                exportNotes,
                notesCount: async () => 0,
                onBodyRendered: () => {},
                onContentRendered: () => {},
            };
            await import('./diff-shortcuts');
            document.dispatchEvent(new Event('DOMContentLoaded'));
            await Promise.resolve();

            const manager = window.shortcutsManager!;
            manager.showHelp();
            expect(document.querySelector('[data-shortcut-name="EXPORT_NOTES"]') !== null).toBe(true);
            expect(manager.run('EXPORT_NOTES')).toBe(true);
            expect(exportNotes).toHaveBeenCalledTimes(1);
        },
    );

    it('does not fall back to management or Share when annotation capability is explicitly denied', async () => {
        addMeta('can-manage', true);
        addMeta('shared-annotation', true);
        addMeta('can-annotate', false);
        await bootDiff();
        expect(window.shortcutsManager?.run('EXPORT_NOTES')).toBe(false);
    });
});

class MockConfigSocket {
    static instances: MockConfigSocket[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: (() => void) | null = null;
    close = vi.fn();
    constructor(readonly url: string) { MockConfigSocket.instances.push(this); }
    receive(data: unknown): void { this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent); }
    disconnect(): void { this.onclose?.(); }
}

const surfaces = vi.hoisted(() => ({
    connect: vi.fn<() => Promise<void>>(),
    chatInit: vi.fn(),
    liveInit: vi.fn(),
    liveActive: vi.fn(),
    liveOff: vi.fn(),
}));
vi.mock('./managers/websocket-manager', () => ({
    WebSocketManager: class {
        connect = surfaces.connect;
        getWebSocket(): null { return null; }
    },
}));
vi.mock('./managers/collaboration-manager', () => ({
    CollaborationManager: class {
        init = surfaces.liveInit;
        toggleActiveMode = surfaces.liveActive;
        toggleOff = surfaces.liveOff;
    },
}));
vi.mock('./managers/chat-manager', () => ({
    ChatManager: class {
        init = surfaces.chatInit;
        openInDefault = vi.fn();
    },
}));

const addMeta = (name: string, value: string | boolean): void => {
    const meta = document.createElement('meta');
    meta.name = name;
    meta.content = String(value);
    document.head.appendChild(meta);
};

async function bootDiff(): Promise<void> {
    await import('./diff-shortcuts');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await Promise.resolve();
}

describe('diff workspace configuration subscription', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.useFakeTimers();
        surfaces.connect.mockResolvedValue(undefined);
        MockConfigSocket.instances = [];
        vi.stubGlobal('WebSocket', MockConfigSocket);
        document.head.innerHTML = '';
        document.body.innerHTML = '<div data-diff-shell data-current-diff-view="rendered"></div>';
        delete window.shortcutsManager;
        delete window.chatManager;
    });
    afterEach(() => {
        window.dispatchEvent(new Event('beforeunload'));
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.unstubAllGlobals();
        delete window.shortcutsManager;
        delete window.chatManager;
        delete window.markonDiffAnnotations;
    });

    it.each(['enable-edit', 'enable-chat', 'enable-live', 'shared-annotation'])(
        'subscribes independently of %s and the other advanced switches', async feature => {
            addMeta('workspace-id', 'workspace-1');
            for (const key of ['enable-edit', 'enable-chat', 'enable-live', 'shared-annotation']) {
                addMeta(key, key === feature);
            }
            await bootDiff();
            expect(MockConfigSocket.instances).toHaveLength(1);
            expect(MockConfigSocket.instances[0]?.url).toMatch(/\/_\/ws\/workspace-1$/);
            const { startWorkspaceConfigWatcher } = await import('./core/workspace-config');
            startWorkspaceConfigWatcher('workspace-1');
            expect(MockConfigSocket.instances).toHaveLength(1);
        },
    );

    it('keeps the config channel when every advanced switch is off', async () => {
        addMeta('workspace-id', 'workspace-1');
        await bootDiff();
        expect(MockConfigSocket.instances).toHaveLength(1);
        expect(surfaces.connect).not.toHaveBeenCalled();
        expect(surfaces.chatInit).not.toHaveBeenCalled();
    });

    it.each(['edit', 'chat', 'live', 'shared'])(
        'requests fresh server scope and UI when %s changes', async feature => {
            const { startWorkspaceConfigWatcher } = await import('./core/workspace-config');
            const reload = vi.fn();
            const stop = startWorkspaceConfigWatcher('workspace-1', reload);
            MockConfigSocket.instances[0]?.receive({ [feature]: true });
            expect(reload).toHaveBeenCalledOnce();
            stop();
        },
    );

    it('reconnects with bounded backoff and resets delay after a successful open', async () => {
        const { startWorkspaceConfigWatcher } = await import('./core/workspace-config');
        const { CONFIG } = await import('./core/config');
        const stop = startWorkspaceConfigWatcher('workspace-1', vi.fn());
        const first = MockConfigSocket.instances[0]!;
        first.disconnect();
        first.disconnect();
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(CONFIG.WEBSOCKET.INITIAL_RECONNECT_DELAY);
        const second = MockConfigSocket.instances[1]!;
        expect(MockConfigSocket.instances).toHaveLength(2);
        second.disconnect();
        await vi.advanceTimersByTimeAsync(CONFIG.WEBSOCKET.INITIAL_RECONNECT_DELAY * 2);
        const third = MockConfigSocket.instances[2]!;
        third.onopen?.();
        third.disconnect();
        await vi.advanceTimersByTimeAsync(CONFIG.WEBSOCKET.INITIAL_RECONNECT_DELAY);
        expect(MockConfigSocket.instances).toHaveLength(4);
        stop();
    });

    it('caps reconnection delay at the configured maximum', async () => {
        const { startWorkspaceConfigWatcher } = await import('./core/workspace-config');
        const { CONFIG } = await import('./core/config');
        const stop = startWorkspaceConfigWatcher('workspace-1', vi.fn());
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const socket = MockConfigSocket.instances[attempt]!;
            socket.disconnect();
            const delay = Math.min(CONFIG.WEBSOCKET.MAX_RECONNECT_DELAY,
                CONFIG.WEBSOCKET.INITIAL_RECONNECT_DELAY * 2 ** attempt);
            await vi.advanceTimersByTimeAsync(delay - 1);
            expect(MockConfigSocket.instances).toHaveLength(attempt + 1);
            await vi.advanceTimersByTimeAsync(1);
            expect(MockConfigSocket.instances).toHaveLength(attempt + 2);
        }
        stop();
    });

    it('closes the active socket and cancels reconnection on unload', async () => {
        const { startWorkspaceConfigWatcher } = await import('./core/workspace-config');
        const reload = vi.fn();
        startWorkspaceConfigWatcher('workspace-1', reload);
        const socket = MockConfigSocket.instances[0]!;
        window.dispatchEvent(new Event('beforeunload'));
        expect(socket.close).toHaveBeenCalledOnce();
        socket.receive({ shared: true });
        socket.disconnect();
        await vi.advanceTimersByTimeAsync(60000);
        expect(reload).not.toHaveBeenCalled();
        expect(MockConfigSocket.instances).toHaveLength(1);

        startWorkspaceConfigWatcher('workspace-1', reload);
        MockConfigSocket.instances[1]!.disconnect();
        window.dispatchEvent(new Event('beforeunload'));
        await vi.advanceTimersByTimeAsync(60000);
        expect(MockConfigSocket.instances).toHaveLength(2);
    });

    it('initializes Chat, help, and export while the Live handshake is stalled', async () => {
        let resolveLive!: () => void;
        surfaces.connect.mockImplementation(() => new Promise<void>(resolve => { resolveLive = resolve; }));
        addMeta('workspace-id', 'workspace-1');
        addMeta('enable-live', true);
        addMeta('enable-chat', true);
        addMeta('can-annotate', true);
        const exportNotes = vi.fn().mockResolvedValue(true);
        window.markonDiffAnnotations = {
            exportNotes, notesCount: async () => 1,
            onBodyRendered: () => {}, onContentRendered: () => {},
        };
        await bootDiff();
        expect(surfaces.chatInit).toHaveBeenCalledOnce();
        expect(window.chatManager).toBeDefined();
        const shortcuts = window.shortcutsManager!;
        expect(shortcuts.run('HELP')).toBe(true);
        expect(shortcuts.run('EXPORT_NOTES')).toBe(true);
        expect(exportNotes).toHaveBeenCalledOnce();
        expect(shortcuts.run('TOGGLE_LIVE_ACTIVE')).toBe(true);
        expect(surfaces.liveActive).not.toHaveBeenCalled();
        resolveLive();
        await Promise.resolve();
        expect(surfaces.liveInit).toHaveBeenCalledOnce();
        shortcuts.run('TOGGLE_LIVE_ACTIVE');
        expect(surfaces.liveActive).toHaveBeenCalledOnce();
    });

    it('does not lose Chat or basic actions if Live has no workspace id', async () => {
        addMeta('enable-live', true);
        addMeta('enable-chat', true);
        await bootDiff();
        expect(surfaces.chatInit).toHaveBeenCalledOnce();
        expect(window.shortcutsManager?.run('HELP')).toBe(true);
        expect(surfaces.connect).not.toHaveBeenCalled();
    });
});
