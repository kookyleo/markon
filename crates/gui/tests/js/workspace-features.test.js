import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const settingsSource = readFileSync('crates/gui/ui/index.html', 'utf8');
const start = settingsSource.indexOf('      // Toggle feature flags');
const end = settingsSource.indexOf('      // "…" more-menu', start);
if (start === -1 || end === -1) throw new Error('Missing workspace feature bindings');
const wireFeatureFlags = new Function(
    'card', 'ws', 'invoke', 'refreshWorkspaces', 'T', 'window', 'workspaceRefresh',
    settingsSource.slice(start, end),
);
const definitionStart = settingsSource.indexOf('      const flagDefs = [');
const definitionEnd = settingsSource.indexOf('      // Single-file workspaces show', definitionStart);
const renderControls = new Function('ws', 'T', 'esc',
    settingsSource.slice(definitionStart, definitionEnd) + 'return flagsHtml + searchStatus;',
);

function workspaceCard(invoke, options = {}, workspaceRefresh = { inFlight: new Set(), pending: false, revision: 0 }) {
    const ws = {
        id: 'workspace-1', enable_search: false, enable_viewed: false,
        enable_edit: true, enable_chat: false, enable_live: true,
        shared_annotation: false, search_ready: true, ...options,
    };
    const card = document.createElement('div');
    card.innerHTML = renderControls(ws, key => key, text => text);
    document.body.appendChild(card);
    const refresh = vi.fn();
    const alert = vi.fn();
    wireFeatureFlags(card, ws, invoke, refresh, key => key, { alert }, workspaceRefresh);
    const checks = [...card.querySelectorAll('input')];
    return { card, checks, refresh, alert, workspaceRefresh };
}

function change(check, value) {
    check.checked = value;
    check.dispatchEvent(new Event('change'));
}

describe('workspace advanced capability controls', () => {
    beforeEach(() => { document.body.replaceChildren(); });

    it('offers only the four advanced toggles in product order', () => {
        const { checks } = workspaceCard(vi.fn());
        expect(checks.map(check => check.dataset.flag)).toEqual(['edit', 'chat', 'live', 'shared']);
        const page = new DOMParser().parseFromString(settingsSource, 'text/html');
        expect([...page.querySelectorAll('input[id^="default_"][type="checkbox"]')].map(el => el.id))
            .toEqual(['default_edit', 'default_chat', 'default_live', 'default_shared']);
    });

    it.each(['en', 'zh_CN', 'ja'])('uses the same short English toggle names in %s', locale => {
        const strings = runInNewContext(`(${readFileSync(`crates/core/i18n/${locale}.json5`, 'utf8')})`);
        const page = new DOMParser().parseFromString(settingsSource, 'text/html');
        const labels = [...page.querySelectorAll('input[id^="default_"][type="checkbox"]')]
            .map(input => input.closest('.pref-row').querySelector('[data-i18n]'));
        expect(labels.map(label => strings[label.dataset.i18n])).toEqual(['Edit', 'Chat', 'Live', 'Share']);
        for (const label of labels) expect(strings[label.dataset.i18nTitle]).toBeTruthy();
        const card = document.createElement('div');
        card.innerHTML = renderControls({}, key => strings[key], text => text);
        expect([...card.querySelectorAll('.ws-flag')].map(label => label.textContent.trim()))
            .toEqual(['Edit', 'Chat', 'Live', 'Share']);
        for (const node of page.querySelectorAll('[data-i18n], [data-i18n-title], [data-i18n-placeholder]')) {
            for (const attr of ['data-i18n', 'data-i18n-title', 'data-i18n-placeholder']) {
                const key = node.getAttribute(attr);
                if (key) expect(strings[key], `${locale}: ${key}`).toBeTruthy();
            }
        }
    });

    it.each([true, false])('shows independent Search status when search_ready is %s', ready => {
        const { card } = workspaceCard(vi.fn(), { search_ready: ready, enable_search: false });
        expect(card.querySelector('[role="status"]').textContent)
            .toBe(ready ? 'ws.flag.search.ready' : 'ws.search.indexing');
        expect(card.querySelector('[role="status"] input')).toBeNull();
    });

    it.each([0, 1, 2, 3])('rolls back a failed toggle at position %i', async index => {
        let rejectSave;
        const invoke = vi.fn(() => new Promise((_resolve, reject) => { rejectSave = reject; }));
        const { checks, refresh, alert } = workspaceCard(invoke);
        const previous = checks.map(check => check.checked);
        change(checks[index], !checks[index].checked);

        expect(checks.every(check => check.disabled)).toBe(true);
        rejectSave(new Error('Unavailable'));
        await vi.waitFor(() => expect(alert).toHaveBeenCalledOnce());

        expect(checks.map(check => check.checked)).toEqual(previous);
        expect(checks.map(check => check.closest('.ws-flag').classList.contains('checked'))).toEqual(previous);
        expect(checks.every(check => !check.disabled)).toBe(true);
        expect(refresh).not.toHaveBeenCalled();
    });

    it('saves by key even when controls move, preserving legacy basic fields', async () => {
        const invoke = vi.fn().mockResolvedValue(undefined);
        const { card, checks, refresh, alert } = workspaceCard(invoke);
        card.prepend(checks[3].closest('.ws-flag'));
        change(checks[1], true);
        await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());

        expect(invoke).toHaveBeenCalledWith('update_workspace', {
            request: {
                id: 'workspace-1', enableSearch: false, enableViewed: false,
                enableEdit: true, enableChat: true, enableLive: true,
                sharedAnnotation: false,
            },
        });
        expect(checks[1].closest('.ws-flag').classList.contains('checked')).toBe(true);
        expect(checks.every(check => !check.disabled)).toBe(true);
        expect(alert).not.toHaveBeenCalled();
    });

    it('blocks a second native toggle while saving', async () => {
        let resolveSave;
        const invoke = vi.fn(() => new Promise(resolve => { resolveSave = resolve; }));
        const { checks, refresh } = workspaceCard(invoke);
        checks[1].click();
        expect(checks[1].checked).toBe(true);
        checks[3].click();
        expect(checks[3].checked).toBe(false);
        expect(invoke).toHaveBeenCalledOnce();
        resolveSave();
        await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
        expect(checks.every(check => !check.disabled)).toBe(true);
    });

    it('defers refreshing until concurrent workspace updates finish, including failure', async () => {
        let finishFirst;
        let rejectSecond;
        const state = { inFlight: new Set(), pending: false, revision: 0 };
        const first = workspaceCard(() => new Promise(resolve => { finishFirst = resolve; }), {}, state);
        const second = workspaceCard(() => new Promise((_resolve, reject) => { rejectSecond = reject; }), { id: 'workspace-2' }, state);
        first.checks[1].click();
        second.checks[3].click();
        expect(state.inFlight.size).toBe(2);
        finishFirst();
        await vi.waitFor(() => expect(state.pending).toBe(true));
        expect(first.refresh).not.toHaveBeenCalled();
        rejectSecond(new Error('Unavailable'));
        await vi.waitFor(() => expect(second.refresh).toHaveBeenCalledOnce());
        expect(state.inFlight.size).toBe(0);
        expect(second.checks[3].checked).toBe(false);
        expect(second.alert).toHaveBeenCalledOnce();
    });

    it.each(['before-fetch', 'during-fetch'])('preserves the current controls when a refresh overlaps a save %s', async phase => {
        const refreshStart = settingsSource.indexOf('  async function refreshWorkspaces() {');
        const refreshEnd = settingsSource.indexOf('    // Single-file (Open-With)', refreshStart);
        const readWorkspaces = new Function('invoke', 'workspaceRefresh', 'applyServerMode',
            settingsSource.slice(refreshStart, refreshEnd) + 'return all; } return refreshWorkspaces;',
        );
        let resolveRead;
        const invoke = vi.fn(() => new Promise(resolve => { resolveRead = resolve; }));
        const state = { inFlight: new Set(), pending: false, revision: 0 };
        if (phase === 'before-fetch') state.inFlight.add('workspace-1');
        const read = readWorkspaces(invoke, state, vi.fn());
        const result = read();
        if (phase === 'during-fetch') {
            expect(invoke).toHaveBeenCalledWith('get_workspaces');
            state.inFlight.add('workspace-1');
            resolveRead([{ id: 'workspace-1' }]);
        } else {
            expect(invoke).not.toHaveBeenCalled();
        }
        expect(await result).toBeUndefined();
        expect(state.pending).toBe(true);
    });

    it('discards a refresh snapshot that predates a completed save', async () => {
        const refreshStart = settingsSource.indexOf('  async function refreshWorkspaces() {');
        const refreshEnd = settingsSource.indexOf('    // Single-file (Open-With)', refreshStart);
        const createRefresh = new Function('invoke', 'workspaceRefresh', 'applyServerMode',
            settingsSource.slice(refreshStart, refreshEnd) + 'return all; } return refreshWorkspaces;',
        );
        let resolveRead;
        const invoke = vi.fn()
            .mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve; }))
            .mockResolvedValueOnce([{ id: 'workspace-1', enable_edit: true }]);
        const state = { inFlight: new Set(), pending: false, revision: 0 };
        const read = createRefresh(invoke, state, vi.fn());
        const result = read();
        // The save starts and finishes before the earlier list request returns.
        state.revision += 1;
        resolveRead([{ id: 'workspace-1', enable_edit: false }]);
        expect(await result).toEqual([{ id: 'workspace-1', enable_edit: true }]);
        expect(invoke).toHaveBeenCalledTimes(2);
    });

    it.each([[false, false], [true, false], [false, true], [true, true]])('retains Search=%s and Progress=%s when saving preferences', (search, viewed) => {
        const collectStart = settingsSource.indexOf('  function collectSettings() {');
        const collectEnd = settingsSource.indexOf('\n  // Tauri commands', collectStart);
        const collect = new Function(
            'document', 'preservedAdvertisedHost', 'preservedBasicDefaults',
            'currentDbPath', 'readDatalistOptions', 'currentWebStyles', 'currentShortcuts',
            settingsSource.slice(collectStart, collectEnd) + 'return collectSettings();',
        );
        const requested = [];
        const dom = {
            getElementById: id => { requested.push(id); return { value: '', checked: false }; },
            querySelector: () => null,
        };
        const settings = collect(dom, '', { default_search: search, default_viewed: viewed }, '', () => [], {}, {});
        expect(settings.default_search).toBe(search);
        expect(settings.default_viewed).toBe(viewed);
        expect(requested).not.toContain('default_search');
        expect(requested).not.toContain('default_viewed');
    });
});
