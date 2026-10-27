import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import type { Annotation } from './managers/annotation-manager';

const annotation = (
    id: string,
    exact: string,
    prefix: string,
    suffix: string,
    note: string,
): Annotation => ({
    id,
    type: 'has-note',
    tagName: 'span',
    anchor: { position: prefix.length, exact, prefix, suffix },
    text: exact,
    note,
    createdAt: 1,
});

describe('diff annotation coordinator init', () => {
    beforeEach(() => {
        vi.resetModules();
        document.body.innerHTML = '';
        document.head.innerHTML = '';
        localStorage.clear();
        delete window.markonDiffAnnotations;
        vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(() => {});
        Object.defineProperty(window, 'innerWidth', {
            value: 1600,
            configurable: true,
            writable: true,
        });
    });

    afterEach(() => {
        window.dispatchEvent(new Event('beforeunload'));
        document.querySelector<HTMLButtonElement>('.editor-close-btn')?.click();
        document.querySelectorAll<HTMLElement>('.cm-editor').forEach(dom => {
            EditorView.findFromDOM(dom)?.destroy();
        });
        delete window.markonDiffAnnotations;
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('offers personal review on rendered comparisons without Admin or Share', async () => {
        document.head.innerHTML = '<meta name="is-worktree-diff" content="false">';
        document.body.innerHTML = '<article data-md-diff-content></article>';

        await import('./diff-annotations');

        expect(window.markonDiffAnnotations).toBeTruthy();
        expect(typeof window.markonDiffAnnotations?.exportNotes).toBe('function');
        expect(typeof window.markonDiffAnnotations?.notesCount).toBe('function');
        expect(typeof window.markonDiffAnnotations?.toggleSelectionToolbar).toBe('function');
    });

    it('exports every file through the shared context-aware Markdown formatter', async () => {
        document.head.innerHTML = `
            <meta name="workspace-id" content="ws-1">
            <meta name="can-manage" content="true">
        `;
        document.body.innerHTML = `
            <article data-md-diff-content>
                <section class="md-diff-file-section"
                    data-abs-path="/abs/alpha.md" data-file-path="docs/alpha.md">
                    <div class="md-diff-file-body">
                        <p>The quick brown fox jumps.</p>
                    </div>
                </section>
                <section class="md-diff-file-section"
                    data-abs-path="/abs/beta.md" data-file-path="docs/beta.md">
                    <div class="md-diff-file-body">
                        <p>Delta echo foxtrot.</p>
                    </div>
                </section>
            </article>
        `;

        const byPath = new Map<string, Annotation[]>([
            ['/abs/alpha.md', [
                annotation('alpha-note', 'brown fox', 'The quick ', ' jumps.', 'alpha note'),
            ]],
            ['/abs/beta.md', [
                annotation('beta-note', 'echo', 'Delta ', ' foxtrot.', 'beta note'),
            ]],
        ]);
        vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
            const url = new URL(String(input), 'http://markon.test');
            if (url.pathname.includes('/document-state')) {
                return {
                    ok: true,
                    status: 200,
                    text: async (): Promise<string> => '',
                    json: async () => ({
                        annotations: byPath.get(url.searchParams.get('path') ?? '') ?? [],
                        viewed_state: {},
                    }),
                };
            }
            return {
                ok: true,
                status: 200,
                text: async (): Promise<string> => '',
                json: async () => ({ html: '' }),
            };
        }));

        await import('./diff-annotations');

        expect(typeof window.markonDiffAnnotations?.toggleSelectionToolbar).toBe('function');
        expect(window.markonDiffAnnotations?.toggleSelectionToolbar?.()).toBe(false);
        expect(window.markonDiffAnnotations?.toggleSelectionToolbar?.()).toBe(true);
        await expect(window.markonDiffAnnotations?.exportNotes()).resolves.toBe(true);
        const editorDom = document.querySelector<HTMLElement>('.cm-editor');
        expect(editorDom).toBeTruthy();
        const content = editorDom
            ? EditorView.findFromDOM(editorDom)?.state.doc.toString()
            : null;
        expect(content).toBe(
            'notes.md\n\n'
            + '# docs/alpha.md\n\n'
            + '> The quick *brown fox* jumps.\n\n'
            + 'alpha note\n\n'
            + '# docs/beta.md\n\n'
            + '> Delta *echo* foxtrot.\n\n'
            + 'beta note\n',
        );
    });
});

class ReviewSocket {
    static OPEN = 1;
    static CLOSED = 3;
    static instances: ReviewSocket[] = [];
    static autoOpen = true;
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    sent: string[] = [];
    close = vi.fn(() => { this.readyState = ReviewSocket.CLOSED; });

    constructor(readonly url: string) {
        ReviewSocket.instances.push(this);
        if (ReviewSocket.autoOpen) queueMicrotask(() => this.open());
    }

    open(): void {
        if (this.readyState === ReviewSocket.CLOSED) return;
        this.readyState = ReviewSocket.OPEN;
        this.onopen?.();
    }

    send(payload: string): void { this.sent.push(payload); }
    receive(payload: unknown): void { this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent); }
}

const bodyFor = (path: string): HTMLElement => {
    const section = [...document.querySelectorAll<HTMLElement>('.md-diff-file-section')]
        .find(node => node.dataset['absPath'] === path);
    const body = section?.querySelector<HTMLElement>('.md-diff-file-body');
    if (!body) throw new Error(`Missing body for ${path}`);
    return body;
};

const socketFor = (path: string): ReviewSocket => {
    const socket = ReviewSocket.instances.find(socket =>
        socket.sent.some(frame => (JSON.parse(frame) as { target?: { path?: string } }).target?.path === path));
    if (!socket) throw new Error(`Missing socket for ${path}`);
    return socket;
};

type ReviewWrite = { action: string; path: string; annotation?: Annotation; id?: string; op_id?: string };

async function initSharedDiff(options: {
    shared?: boolean;
    scope?: 'owner' | 'personal' | 'shared';
    live?: boolean;
    chat?: boolean;
    snapshots?: Map<string, Annotation[]>;
    onWrite?: (command: ReviewWrite) => void;
} = {}): Promise<{ writes: ReviewWrite[]; snapshots: Map<string, Annotation[]> }> {
    document.head.innerHTML = `
        <meta name="workspace-id" content="ws-review">
        <meta name="shared-annotation" content="${options.shared ?? true}">
        <meta name="enable-live" content="${options.live ?? false}">
        <meta name="enable-chat" content="${options.chat ?? false}">
    `;
    document.body.innerHTML = `
        <article data-md-diff-content>
            <section class="md-diff-file-section" data-abs-path="/abs/alpha.md" data-file-path="docs/alpha.md">
                <header class="md-diff-file-header"><input class="file-progress" type="checkbox"></header>
                <div class="md-diff-file-body">
                    <div class="md-diff-change-card-old"><p>The quick brown fox jumps.</p></div>
                    <div class="new-side"><p>The quick brown fox jumps.</p></div>
                </div>
            </section>
            <section class="md-diff-file-section" data-abs-path="/abs/beta.md" data-file-path="docs/beta.md">
                <div class="md-diff-file-body"><p>Delta echo foxtrot.</p></div>
            </section>
        </article>
    `;
    const writes: ReviewWrite[] = [];
    const snapshots = new Map(options.snapshots);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input), 'http://markon.test');
        if (!url.pathname.includes('/document-state')) {
            return { ok: true, status: 200, text: async (): Promise<string> => '', json: async () => ({ html: '' }) };
        }
        if (init?.method === 'POST') {
            const command = JSON.parse(String(init.body)) as ReviewWrite;
            writes.push(command);
            options.onWrite?.(command);
            return { ok: true, status: 204, text: async (): Promise<string> => '' };
        }
        return {
            ok: true, status: 200, text: async (): Promise<string> => '',
            json: async () => ({
                annotations: snapshots.get(url.searchParams.get('path') ?? '') ?? [],
                viewed_state: {},
                scope: options.scope ?? (options.shared === false ? 'personal' : 'shared'),
            }),
        };
    }));
    await import('./diff-annotations');
    for (const path of ['/abs/alpha.md', '/abs/beta.md']) {
        window.markonDiffAnnotations?.onBodyRendered(bodyFor(path));
    }
    await window.markonDiffAnnotations?.notesCount();
    await Promise.resolve();
    return { writes, snapshots };
}

async function flushReview(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 0));
}

function selectDiffText(path = '/abs/alpha.md', old = false): void {
    const body = bodyFor(path);
    const paragraph = path === '/abs/alpha.md'
        ? body.querySelector<HTMLElement>(old ? '.md-diff-change-card-old p' : '.new-side p')
        : body.querySelector<HTMLElement>('p');
    const text = paragraph?.firstChild;
    if (!text || !paragraph) throw new Error('Missing selection text');
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, text.textContent?.length ?? 0);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
}

describe('shared diff document synchronization', () => {
    const originalRangeRect = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect');

    beforeEach(() => {
        vi.resetModules();
        document.body.innerHTML = '';
        document.head.innerHTML = '';
        localStorage.clear();
        delete window.markonDiffAnnotations;
        delete window.chatManager;
        ReviewSocket.instances = [];
        ReviewSocket.autoOpen = true;
        vi.stubGlobal('WebSocket', ReviewSocket);
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
            configurable: true,
            value: () => new DOMRect(10, 10, 200, 20),
        });
    });

    afterEach(() => {
        window.dispatchEvent(new Event('beforeunload'));
        window.getSelection()?.removeAllRanges();
        delete window.markonDiffAnnotations;
        delete window.chatManager;
        if (originalRangeRect) Object.defineProperty(Range.prototype, 'getBoundingClientRect', originalRangeRect);
        else Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('subscribes once per canonical file and applies peer upserts, deletes, and clears without persisting again', async () => {
        const { writes, snapshots } = await initSharedDiff();
        expect(ReviewSocket.instances).toHaveLength(2);
        const alpha = socketFor('/abs/alpha.md');
        const beta = socketFor('/abs/beta.md');
        expect(alpha.url).toBe('ws://localhost:3000/_/ws-review/ws');
        expect(JSON.parse(alpha.sent[0]!)).toEqual({ type: 'hello', target: { kind: 'document', path: '/abs/alpha.md' } });
        const first = annotation('anno-alpha', 'brown fox', 'The quick ', ' jumps.', 'first note');
        snapshots.set('/abs/alpha.md', [first]);
        alpha.receive({ type: 'all_annotations', annotations: [first] });
        await flushReview();
        await expect(window.markonDiffAnnotations?.notesCount()).resolves.toBe(1);
        expect(bodyFor('/abs/alpha.md').querySelector('.md-diff-change-card-old [data-annotation-id]')).toBeNull();
        expect(bodyFor('/abs/alpha.md').querySelectorAll('.new-side [data-annotation-id]')).toHaveLength(1);

        alpha.receive({ type: 'new_annotation', annotation: { ...first, note: 'updated note' } });
        bodyFor('/abs/alpha.md').querySelector<HTMLElement>('.new-side .has-note')?.click();
        expect(document.querySelector('.note-popup .note-content')?.textContent).toBe('updated note');
        beta.receive({ type: 'new_annotation', annotation: annotation('anno-beta', 'echo', 'Delta ', ' foxtrot.', 'beta note') });
        await expect(window.markonDiffAnnotations?.notesCount()).resolves.toBe(2);
        alpha.receive({ type: 'delete_annotation', id: 'anno-beta' });
        await expect(window.markonDiffAnnotations?.notesCount()).resolves.toBe(2);
        alpha.receive({ type: 'delete_annotation', id: 'anno-alpha' });
        await expect(window.markonDiffAnnotations?.notesCount()).resolves.toBe(1);
        expect(document.querySelector('.note-popup')).toBeNull();
        expect(bodyFor('/abs/alpha.md').querySelector('[data-annotation-id]')).toBeNull();
        beta.receive({ type: 'clear_annotations' });
        await expect(window.markonDiffAnnotations?.notesCount()).resolves.toBe(0);
        expect(bodyFor('/abs/beta.md').querySelector('[data-annotation-id]')).toBeNull();
        expect(writes).toHaveLength(0);
        expect(alpha.sent).toHaveLength(1); // hello only; review writes never go over WS
    });

    it('reloads current shared state after initial and reconnect snapshots', async () => {
        const http = annotation('anno-http', 'brown fox', 'The quick ', ' jumps.', 'HTTP note');
        const { snapshots } = await initSharedDiff({ snapshots: new Map([['/abs/alpha.md', [http]]]) });
        const alpha = socketFor('/abs/alpha.md');
        const latest = [{ ...http, note: 'server wins' }, annotation('anno-extra', 'quick', 'The ', ' brown fox jumps.', 'extra')];
        snapshots.set('/abs/alpha.md', latest);
        alpha.receive({ type: 'all_annotations', annotations: latest });
        await flushReview();
        await expect(window.markonDiffAnnotations?.notesCount()).resolves.toBe(2);
        expect(bodyFor('/abs/alpha.md').querySelectorAll('.new-side [data-annotation-id]')).toHaveLength(2);
        snapshots.set('/abs/alpha.md', []);
        alpha.receive({ type: 'all_annotations', annotations: [] });
        await flushReview();
        await expect(window.markonDiffAnnotations?.notesCount()).resolves.toBe(0);
        expect(bodyFor('/abs/alpha.md').querySelector('[data-annotation-id]')).toBeNull();
    });

    it('removes HTTP annotations deleted before the first shared socket snapshot', async () => {
        const http = annotation('anno-http-deleted', 'brown fox', 'The quick ', ' jumps.', 'deleted during handshake');
        const { snapshots } = await initSharedDiff({ snapshots: new Map([['/abs/alpha.md', [http]]]) });
        await expect(window.markonDiffAnnotations?.notesCount()).resolves.toBe(1);
        snapshots.set('/abs/alpha.md', []);
        socketFor('/abs/alpha.md').receive({ type: 'all_annotations', annotations: [] });
        await flushReview();
        await expect(window.markonDiffAnnotations?.notesCount()).resolves.toBe(0);
        expect(bodyFor('/abs/alpha.md').querySelector('[data-annotation-id]')).toBeNull();
    });

    it('retains locally committed highlights while removing stale HTTP notes in the first snapshot', async () => {
        const http = annotation('anno-http-deleted', 'brown fox', 'The quick ', ' jumps.', 'stale HTTP note');
        const { writes, snapshots } = await initSharedDiff({ snapshots: new Map([['/abs/alpha.md', [http]]]) });
        selectDiffText('/abs/beta.md');
        document.querySelector<HTMLElement>('[data-action="highlight-yellow"]')?.click();
        await vi.waitFor(() => expect(bodyFor('/abs/beta.md').querySelector('[data-annotation-id]')).not.toBeNull());
        snapshots.set('/abs/alpha.md', []);
        socketFor('/abs/alpha.md').receive({ type: 'all_annotations', annotations: [] });
        await flushReview();
        snapshots.set('/abs/beta.md', writes.flatMap(write => write.annotation ? [write.annotation] : []));
        socketFor('/abs/beta.md').receive({ type: 'all_annotations', annotations: [] });
        await flushReview();
        await expect(window.markonDiffAnnotations?.notesCount()).resolves.toBe(0);
        expect(bodyFor('/abs/alpha.md').querySelector('[data-annotation-id]')).toBeNull();
        expect(bodyFor('/abs/beta.md').querySelector('[data-annotation-id]')?.getAttribute('data-annotation-id')).toBe(writes[0]?.annotation?.id);
    });

    it.each(['personal', 'owner'] as const)('does not connect a review socket for actual %s scope despite stale Share metadata', async scope => {
        await initSharedDiff({ shared: true, scope });
        expect(ReviewSocket.instances).toHaveLength(0);
    });

    it('keeps Live-only personal review on HTTP and does not send review state', async () => {
        const { writes } = await initSharedDiff({ shared: false, live: true });
        selectDiffText();
        document.querySelector<HTMLElement>('[data-action="highlight-yellow"]')?.click();
        await vi.waitFor(() => expect(writes.length).toBeGreaterThan(0));
        expect(writes.map(write => write.action)).toEqual(['save_annotation']);
        expect(writes[0]?.op_id).toBeUndefined();
        expect(ReviewSocket.instances).toHaveLength(0);
    });

    it('renders HTTP annotations and resolves counts while WS handshakes remain pending', async () => {
        ReviewSocket.autoOpen = false;
        const note = annotation('anno-ready', 'brown fox', 'The quick ', ' jumps.', 'loaded from HTTP');
        await initSharedDiff({ snapshots: new Map([['/abs/alpha.md', [note]]]) });
        await expect(window.markonDiffAnnotations?.notesCount()).resolves.toBe(1);
        expect(bodyFor('/abs/alpha.md').querySelector('[data-annotation-id="anno-ready"]')).not.toBeNull();
        expect(ReviewSocket.instances.every(socket => socket.sent.length === 0)).toBe(true);
    });

    it('deduplicates its own committed echo and a later replay without duplicate wrappers or changes', async () => {
        let wrappersDuringCommit = -1;
        const { writes } = await initSharedDiff({ onWrite: command => {
            socketFor(command.path).receive({ type: 'new_annotation', annotation: command.annotation, op_id: command.op_id });
            wrappersDuringCommit = bodyFor(command.path).querySelectorAll('.new-side [data-annotation-id]').length;
        } });
        const changed = vi.fn();
        document.addEventListener('markon:diff-notes-count-changed', changed, { once: true });
        selectDiffText();
        document.querySelector<HTMLElement>('[data-action="highlight-yellow"]')?.click();
        await vi.waitFor(() => expect(writes).toHaveLength(1));
        await vi.waitFor(() => expect(bodyFor('/abs/alpha.md').querySelectorAll('.new-side [data-annotation-id]')).toHaveLength(1));
        expect(wrappersDuringCommit).toBe(0);
        expect(writes[0]?.op_id).toMatch(/^[a-f0-9]{16}$/);
        const beforeReplay = bodyFor('/abs/alpha.md').innerHTML;
        socketFor('/abs/alpha.md').receive({ type: 'new_annotation', annotation: writes[0]?.annotation, op_id: writes[0]?.op_id });
        expect(bodyFor('/abs/alpha.md').innerHTML).toBe(beforeReplay);
        expect(changed).toHaveBeenCalledOnce();
    });

    it('receives section progress without changing local diff file progress', async () => {
        await initSharedDiff();
        localStorage.setItem('diff-local-progress', '{"alpha":false}');
        const progress = vi.fn();
        document.addEventListener('markon:diff-section-progress-changed', progress, { once: true });
        socketFor('/abs/alpha.md').receive({ type: 'viewed_state', state: { section: true } });
        expect(progress).toHaveBeenCalledOnce();
        expect((progress.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ path: '/abs/alpha.md', state: { section: true } });
        expect(document.querySelector<HTMLInputElement>('.file-progress')?.checked).toBe(false);
        expect(localStorage.getItem('diff-local-progress')).toBe('{"alpha":false}');
    });

    it('reuses file contexts across body rerenders and closes removed files and the page once', async () => {
        await initSharedDiff();
        const alpha = socketFor('/abs/alpha.md');
        const beta = socketFor('/abs/beta.md');
        const body = bodyFor('/abs/alpha.md');
        body.innerHTML = '<div class="new-side"><p>The quick brown fox jumps.</p></div>';
        window.markonDiffAnnotations?.onBodyRendered(body);
        window.markonDiffAnnotations?.onBodyRendered(body);
        await window.markonDiffAnnotations?.notesCount();
        expect(ReviewSocket.instances).toHaveLength(2);
        alpha.receive({ type: 'new_annotation', annotation: annotation('anno-new-root', 'brown fox', 'The quick ', ' jumps.', 'fresh') });
        expect(body.querySelectorAll('[data-annotation-id]')).toHaveLength(1);
        bodyFor('/abs/beta.md').closest('section')?.remove();
        window.markonDiffAnnotations?.onContentRendered();
        expect(beta.close).toHaveBeenCalledOnce();
        window.dispatchEvent(new Event('pagehide'));
        window.dispatchEvent(new Event('beforeunload'));
        expect(alpha.close).toHaveBeenCalledOnce();
        expect(beta.close).toHaveBeenCalledOnce();
        expect(alpha.onmessage).toBeNull();
    });

    it.each(['load', 'all_annotations', 'new_annotation'] as const)(
        '%s skips malformed fragments while rendering and exporting valid notes',
        async source => {
            const valid = annotation('anno-valid', 'brown fox', 'The quick ', ' jumps.', 'valid note');
            const invalid = [
                { ...valid.anchor, version: 2, fragments: 'brown fox' },
                { ...valid.anchor, version: 2, fragments: [null] },
                { ...valid.anchor, version: 2, fragments: [{ position: 10, exact: 'brown fox' }] },
                { ...valid.anchor, fragments: [{ ...valid.anchor, exact: null }] },
            ].map((anchor, index) => ({
                ...valid, id: `anno-invalid-${index}`, note: 'invalid note', anchor,
            })) as unknown as Annotation[];
            const { writes, snapshots } = await initSharedDiff({ snapshots: new Map([
                ['/abs/alpha.md', source === 'load' ? [...invalid, valid] : [valid]],
            ]) });
            const alpha = socketFor('/abs/alpha.md');
            if (source === 'all_annotations') {
                snapshots.set('/abs/alpha.md', [...invalid, valid]);
                alpha.receive({ type: source, annotations: [] });
                await flushReview();
            } else if (source === 'new_annotation') {
                for (const note of invalid) alpha.receive({ type: source, annotation: note });
            }
            await expect(window.markonDiffAnnotations?.notesCount()).resolves.toBe(1);
            expect(bodyFor('/abs/alpha.md').querySelectorAll('.new-side [data-annotation-id]')).toHaveLength(1);
            expect(document.querySelector('[data-annotation-id^="anno-invalid-"]')).toBeNull();
            try {
                await expect(window.markonDiffAnnotations?.exportNotes()).resolves.toBe(true);
                const editor = document.querySelector<HTMLElement>('.cm-editor');
                const markdown = editor ? EditorView.findFromDOM(editor)?.state.doc.toString() : undefined;
                expect(markdown).toContain('valid note');
                expect(markdown).not.toContain('invalid note');
                expect(writes).toEqual([]);
            } finally {
                document.querySelector<HTMLButtonElement>('.editor-close-btn')?.click();
                document.querySelectorAll<HTMLElement>('.cm-editor').forEach(dom => EditorView.findFromDOM(dom)?.destroy());
            }
        },
    );

    it('rejects malformed peer records and never opens annotation actions on old-side text', async () => {
        await initSharedDiff();
        const alpha = socketFor('/abs/alpha.md');
        alpha.receive({ type: 'all_annotations', annotations: [{ id: 'anno-valid-shape' }, { ...annotation('anno-bad', 'brown fox', '', '', 'bad'), id: 'anno-"]' }] });
        alpha.receive({ type: 'new_annotation', annotation: null });
        await expect(window.markonDiffAnnotations?.notesCount()).resolves.toBe(0);
        selectDiffText('/abs/alpha.md', true);
        expect(document.querySelector<HTMLElement>('.selection-popover')?.style.display).toBe('none');
        expect(window.getSelection()?.toString()).toBe('The quick brown fox jumps.');
    });

    it('offers Chat selection with the workspace flag and file context while leaving Edit off', async () => {
        await initSharedDiff({ shared: false, chat: true });
        const ask = vi.fn();
        window.chatManager = { openWithSelection: ask } as unknown as NonNullable<typeof window.chatManager>;
        selectDiffText();
        expect(document.querySelector('[data-action="edit"]')).toBeNull();
        const button = document.querySelector<HTMLElement>('[data-action="chat"]');
        expect(button).not.toBeNull();
        button?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
        expect(ask).toHaveBeenCalledWith({ text: 'The quick brown fox jumps.', currentDoc: 'docs/alpha.md', shift: true });
        expect(window.getSelection()?.rangeCount).toBe(0);
    });
});
