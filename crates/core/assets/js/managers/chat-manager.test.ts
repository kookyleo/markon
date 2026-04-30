import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    ChatManager,
    escapeHtml,
    extractMentionContext,
    hydrateMessage,
    parseCitation,
    renderInline,
    renderMarkdown,
    type ChatSSEEvent,
    type MessageBlock,
    type ServerMessage,
} from './chat-manager';

// ────────────────────────────────────────────────────────────────────────────
// Pure helper functions — bulk of the coverage. No DOM needed.
// ────────────────────────────────────────────────────────────────────────────

describe('ChatManager — pure helpers', () => {
    describe('escapeHtml', () => {
        it('escapes HTML-significant characters', () => {
            expect(escapeHtml('<script>alert("x")</script>'))
                .toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
        });

        it('escapes ampersands and apostrophes', () => {
            expect(escapeHtml(`Tom & Jerry's`)).toBe('Tom &amp; Jerry&#39;s');
        });

        it('passes through plain text untouched', () => {
            expect(escapeHtml('hello world 123')).toBe('hello world 123');
        });
    });

    describe('renderInline', () => {
        it('escapes raw HTML before applying inline markdown', () => {
            expect(renderInline('<b>x</b>')).toBe('&lt;b&gt;x&lt;/b&gt;');
        });

        it('renders inline code as a <code> element', () => {
            expect(renderInline('use `foo()` here'))
                .toBe('use <code>foo()</code> here');
        });

        it('renders **bold** as <strong>', () => {
            expect(renderInline('**bold** word')).toBe('<strong>bold</strong> word');
        });

        it('renders *italic* as <em>', () => {
            expect(renderInline('an *italic* word')).toBe('an <em>italic</em> word');
        });

        it('renders [text](url) as an <a> with rel="noopener noreferrer"', () => {
            const out = renderInline('see [docs](https://example.com)');
            expect(out).toContain('<a href="https://example.com"');
            expect(out).toContain('target="_blank"');
            expect(out).toContain('rel="noopener noreferrer"');
            expect(out).toContain('>docs</a>');
        });

        it('strips javascript: URLs in links', () => {
            // Should drop the link and keep the label as plain text.
            const out = renderInline('[click](javascript:alert(1))');
            expect(out).not.toContain('<a ');
            expect(out).toContain('click');
        });

        it('keeps backtick code verbatim — no emphasis inside it', () => {
            const out = renderInline('text `**still code**` here');
            // The text inside the backticks must NOT have become <strong>.
            expect(out).toContain('<code>**still code**</code>');
        });

        it('escapes HTML inside inline code (double-escaped — preserves legacy renderer behavior)', () => {
            // The legacy renderer escapes once up-front, stashes the (already
            // escaped) code span, then re-escapes on restore. We migrate the
            // behavior 1:1 — double-escaping is preserved so output bytes
            // match the pre-migration JS exactly.
            const out = renderInline('use `<div>` tag');
            expect(out).toBe('use <code>&amp;lt;div&amp;gt;</code> tag');
        });
    });

    describe('renderMarkdown (block-level fallback)', () => {
        beforeEach(() => {
            // Make sure window.marked isn't around — we want the fallback path.
            (window as unknown as { marked?: unknown }).marked = undefined;
        });

        it('wraps plain text in <p>', () => {
            expect(renderMarkdown('hello')).toBe('<p>hello</p>');
        });

        it('renders fenced code as <pre><code> with HTML-escaped contents', () => {
            const src = '```\nlet a = "<x>";\n```';
            const out = renderMarkdown(src);
            expect(out).toContain('<pre><code>');
            expect(out).toContain('let a = &quot;&lt;x&gt;&quot;;');
            expect(out).toContain('</code></pre>');
        });

        it('renders bullet lists into <ul><li>…</li></ul>', () => {
            const out = renderMarkdown('- one\n- two\n- three');
            expect(out).toBe('<ul><li>one</li><li>two</li><li>three</li></ul>');
        });

        it('renders numbered lists into <ol><li>…</li></ol>', () => {
            const out = renderMarkdown('1. first\n2. second');
            expect(out).toBe('<ol><li>first</li><li>second</li></ol>');
        });

        it('returns empty string for empty/falsy input', () => {
            expect(renderMarkdown('')).toBe('');
            expect(renderMarkdown(null)).toBe('');
            expect(renderMarkdown(undefined)).toBe('');
        });
    });

    describe('extractMentionContext', () => {
        it('returns null when there is no @ before the caret', () => {
            expect(extractMentionContext('plain text', 5)).toBeNull();
        });

        it('returns null when @ has non-whitespace immediately before it', () => {
            // looks like an email — should NOT trigger the mention popup
            expect(extractMentionContext('me@example.com', 14)).toBeNull();
        });

        it('captures an @ at start-of-string with empty token', () => {
            expect(extractMentionContext('@', 1)).toEqual({ token: '', anchor: 0 });
        });

        it('captures the prefix typed after @', () => {
            expect(extractMentionContext('hello @doc', 10))
                .toEqual({ token: 'doc', anchor: 6 });
        });

        it('only captures the segment closest to the caret (no whitespace)', () => {
            expect(extractMentionContext('@a hello @b', 11))
                .toEqual({ token: 'b', anchor: 9 });
        });

        it('returns null if a whitespace exists between @ and caret', () => {
            expect(extractMentionContext('@a hello', 8)).toBeNull();
        });
    });

    describe('parseCitation', () => {
        it('parses path:line', () => {
            expect(parseCitation('src/main.rs:42')).toEqual({
                path: 'src/main.rs',
                line: 42,
                lineEnd: null,
                anchor: null,
            });
        });

        it('parses path:line-line', () => {
            expect(parseCitation('docs/readme.md:10-20')).toEqual({
                path: 'docs/readme.md',
                line: 10,
                lineEnd: 20,
                anchor: null,
            });
        });

        it('parses path#anchor', () => {
            expect(parseCitation('docs/readme.md#intro')).toEqual({
                path: 'docs/readme.md',
                line: null,
                lineEnd: null,
                anchor: 'intro',
            });
        });

        it('returns null for unsupported extensions', () => {
            expect(parseCitation('image.png:5')).toBeNull();
        });

        it('returns null for non-citation strings', () => {
            expect(parseCitation('not a citation')).toBeNull();
            expect(parseCitation('foo()')).toBeNull();
        });
    });

    describe('hydrateMessage', () => {
        it('keeps array content as-is and assigns id from seq', () => {
            const m: ServerMessage = {
                seq: 7,
                role: 'user',
                content: [{ type: 'text', text: 'hi' }],
            };
            const out = hydrateMessage(m);
            expect(out.id).toBe('m7');
            expect(out.role).toBe('user');
            expect(out.blocks).toEqual([{ type: 'text', text: 'hi' }]);
            expect(out.seq).toBe(7);
            expect(out.error).toBeNull();
            expect(out.mentions).toEqual([]);
        });

        it('wraps string content in a single text block', () => {
            const m: ServerMessage = {
                seq: 1,
                role: 'assistant',
                content: 'plain reply' as unknown as MessageBlock['blocks'],
            };
            const out = hydrateMessage(m);
            expect(out.blocks).toEqual([{ type: 'text', text: 'plain reply' }]);
        });

        it('flattens mention objects to path strings and drops empty entries', () => {
            const m: ServerMessage = {
                seq: 2,
                role: 'user',
                content: [{ type: 'text', text: 'see @a/b.md' }],
                mentions: ['a/b.md', { path: 'c/d.md' }, { path: '' }, 'e/f.md'],
            };
            const out = hydrateMessage(m);
            expect(out.mentions).toEqual(['a/b.md', 'c/d.md', 'e/f.md']);
        });

        it('synthesizes a stable-ish id when seq is missing', () => {
            const m: ServerMessage = {
                role: 'user',
                content: [{ type: 'text', text: 'no seq' }],
            };
            const out = hydrateMessage(m);
            expect(out.id).toMatch(/^m/);
            expect(out.seq).toBeNull();
        });
    });
});

// ────────────────────────────────────────────────────────────────────────────
// SSE event handler — exercised through the public ChatManager class via the
// `_test*` seams. We don't mount the panel; we only assert that `#handleEvent`
// transitions the message-block / threads state correctly.
// ────────────────────────────────────────────────────────────────────────────

describe('ChatManager — SSE event handling', () => {
    /** Build a fresh empty assistant message — what `#submit()` would create
     *  just before opening the SSE stream. */
    function newAssistantMsg(): MessageBlock {
        return {
            id: 'local-a-test',
            role: 'assistant',
            blocks: [{ type: 'text', text: '' }],
            streaming: true,
        };
    }

    beforeEach(() => {
        // Ensure ChatManager constructor returns deterministic workspace id.
        document.head.innerHTML = '<meta name="workspace-id" content="ws-test">';
        document.body.innerHTML = '';
        localStorage.clear();
    });

    it('thread_assigned: migrates __pending__ to the assigned thread id', () => {
        const mgr = new ChatManager(null);
        // Set up: simulate #submit() creating a __pending__ list.
        const m1 = newAssistantMsg();
        mgr._testMessagesByThread.set('__pending__', [m1]);

        mgr._testHandleEvent({ type: 'thread_assigned', thread_id: 't1', title: 'My Thread' }, m1);

        expect(mgr._testCurrentThreadId).toBe('t1');
        expect(mgr._testMessagesByThread.has('__pending__')).toBe(false);
        expect(mgr._testMessagesByThread.get('t1')).toEqual([m1]);
        // Thread metadata is prepended for the menu.
        expect(mgr._testThreads.some((t) => t.id === 't1' && t.title === 'My Thread')).toBe(true);
    });

    it('text: appends a delta to the trailing text block', () => {
        const mgr = new ChatManager(null);
        const msg = newAssistantMsg();
        mgr._testHandleEvent({ type: 'text', delta: 'Hel' }, msg);
        mgr._testHandleEvent({ type: 'text', delta: 'lo!' }, msg);
        expect(msg.blocks).toEqual([{ type: 'text', text: 'Hello!' }]);
    });

    it('text after tool: starts a fresh text block', () => {
        const mgr = new ChatManager(null);
        const msg: MessageBlock = {
            id: 'local-a-test',
            role: 'assistant',
            // simulate a previous tool_use ended a text block
            blocks: [
                { type: 'text', text: 'before' },
                { type: 'tool_use', name: 'read_file', input: { path: 'x' } },
            ],
            streaming: true,
        };
        mgr._testHandleEvent({ type: 'text', delta: 'after' }, msg);
        expect(msg.blocks).toHaveLength(3);
        expect(msg.blocks[2]).toEqual({ type: 'text', text: 'after' });
    });

    it('tool_start + tool_end: pushes tool_use then tool_result blocks', () => {
        const mgr = new ChatManager(null);
        const msg = newAssistantMsg();
        mgr._testHandleEvent(
            { type: 'tool_start', id: 'tu_1', name: 'read_file', input: { path: 'a.md' } },
            msg,
        );
        mgr._testHandleEvent(
            { type: 'tool_end', id: 'tu_1', output: 'file contents', is_error: false },
            msg,
        );
        // The original empty-text block stays at index 0; tool_use at 1; tool_result at 2.
        expect(msg.blocks).toHaveLength(3);
        const tool = msg.blocks[1];
        expect(tool && tool.type).toBe('tool_use');
        if (tool && tool.type === 'tool_use') {
            expect(tool.name).toBe('read_file');
            expect(tool.input).toEqual({ path: 'a.md' });
        }
        const result = msg.blocks[2];
        expect(result && result.type).toBe('tool_result');
        if (result && result.type === 'tool_result') {
            expect(result.content).toBe('file contents');
            expect(result.is_error).toBe(false);
        }
    });

    it('done: clears streaming flag', () => {
        const mgr = new ChatManager(null);
        const msg = newAssistantMsg();
        expect(msg.streaming).toBe(true);
        mgr._testHandleEvent({ type: 'done' }, msg);
        expect(msg.streaming).toBe(false);
    });

    it('error: copies message onto the assistant msg', () => {
        const mgr = new ChatManager(null);
        const msg = newAssistantMsg();
        mgr._testHandleEvent({ type: 'error', message: 'rate-limited' }, msg);
        expect(msg.error).toBe('rate-limited');
    });

    it('turn_end: is a no-op (no field reads, no error)', () => {
        const mgr = new ChatManager(null);
        const msg = newAssistantMsg();
        // Should not throw; should not mutate msg.
        mgr._testHandleEvent({ type: 'turn_end', stop_reason: 'end_turn' }, msg);
        expect(msg.blocks).toEqual([{ type: 'text', text: '' }]);
        expect(msg.error).toBeUndefined();
    });
});

// ────────────────────────────────────────────────────────────────────────────
// SSE consumer — verifies the ReadableStream → JSON parse → handler pipeline
// works end-to-end. We feed pre-encoded SSE frames into the typed consumer.
// ────────────────────────────────────────────────────────────────────────────

describe('ChatManager — SSE stream consumption', () => {
    /** Encode a list of frames into one Uint8Array (SSE: blank-line separated). */
    function encodeFrames(events: ChatSSEEvent[]): Uint8Array {
        const enc = new TextEncoder();
        const body = events
            .map((e) => `data: ${JSON.stringify(e)}\n\n`)
            .join('');
        return enc.encode(body);
    }

    /** Build a ReadableStream that yields one byte chunk then closes. */
    function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
        return new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(bytes);
                controller.close();
            },
        });
    }

    beforeEach(() => {
        document.head.innerHTML = '<meta name="workspace-id" content="ws-test">';
        document.body.innerHTML = '';
        localStorage.clear();
    });

    it('parses multiple frames and dispatches events in order', async () => {
        const mgr = new ChatManager(null);
        const msg: MessageBlock = {
            id: 'local-a-test',
            role: 'assistant',
            blocks: [{ type: 'text', text: '' }],
            streaming: true,
        };

        const events: ChatSSEEvent[] = [
            { type: 'thread_assigned', thread_id: 'tid', title: 'Hi' },
            { type: 'text', delta: 'Hello' },
            { type: 'text', delta: ' world' },
            { type: 'done' },
        ];
        const bytes = encodeFrames(events);
        const stream = streamOf(bytes);

        await mgr._testConsumeSSE(stream, msg);

        // After consuming, the assistant message should hold the joined text.
        expect(msg.blocks).toEqual([{ type: 'text', text: 'Hello world' }]);
        expect(msg.streaming).toBe(false);
        // Thread state migrated.
        expect(mgr._testCurrentThreadId).toBe('tid');
    });

    it('ignores a malformed SSE frame and continues processing valid ones', async () => {
        const mgr = new ChatManager(null);
        const msg: MessageBlock = {
            id: 'local-a-test',
            role: 'assistant',
            blocks: [{ type: 'text', text: '' }],
            streaming: true,
        };

        const enc = new TextEncoder();
        const body =
            'data: {not json\n\n' +
            `data: ${JSON.stringify({ type: 'text', delta: 'ok' })}\n\n` +
            `data: ${JSON.stringify({ type: 'done' })}\n\n`;
        // Silence the warn output the malformed frame would emit.
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const stream = streamOf(enc.encode(body));

        await mgr._testConsumeSSE(stream, msg);

        expect(msg.blocks).toEqual([{ type: 'text', text: 'ok' }]);
        expect(msg.streaming).toBe(false);
        warnSpy.mockRestore();
    });

    it('handles an SSE frame split across two chunks', async () => {
        // The decode buffer must reassemble bytes that arrive mid-frame.
        const mgr = new ChatManager(null);
        const msg: MessageBlock = {
            id: 'local-a-test',
            role: 'assistant',
            blocks: [{ type: 'text', text: '' }],
            streaming: true,
        };

        const enc = new TextEncoder();
        // Split the frame at an arbitrary byte boundary.
        const fullFrame = `data: ${JSON.stringify({ type: 'text', delta: 'split-payload' })}\n\n` +
                          `data: ${JSON.stringify({ type: 'done' })}\n\n`;
        const halfPoint = Math.floor(fullFrame.length / 2);
        const part1 = enc.encode(fullFrame.slice(0, halfPoint));
        const part2 = enc.encode(fullFrame.slice(halfPoint));

        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(part1);
                controller.enqueue(part2);
                controller.close();
            },
        });

        await mgr._testConsumeSSE(stream, msg);
        expect(msg.blocks).toEqual([{ type: 'text', text: 'split-payload' }]);
    });
});

// ────────────────────────────────────────────────────────────────────────────
// Integration smoke — verifies the post-refactor header markup is preserved.
// ────────────────────────────────────────────────────────────────────────────

describe('ChatManager — header markup invariants', () => {
    beforeEach(() => {
        document.head.innerHTML = `
            <meta name="workspace-id" content="ws-test">
            <meta name="enable-chat" content="true">
        `;
        document.body.innerHTML = '';
        localStorage.clear();
    });

    it('keeps ICON_EDIT, the rename button, and the title-as-span structure', () => {
        // Mount a real chat panel (init wires FloatingLayer; jsdom is fine
        // with the registry side-effect in a single-test process).
        const mgr = new ChatManager(null);
        try {
            mgr.init();
        } catch {
            // Some animation APIs are unavailable in jsdom; init may throw
            // late, but the DOM has been built by then.
        }
        const container = document.getElementById('markon-chat-container');
        expect(container).not.toBeNull();

        const title = container?.querySelector('.markon-chat-thread-title');
        const rename = container?.querySelector('.markon-chat-rename');
        const switcher = container?.querySelector('.markon-chat-thread-switcher');

        // Title must NOT be a button anymore — it's a plain <span> that only
        // becomes editable when the rename button is clicked.
        expect(title?.tagName).toBe('SPAN');
        // Pencil rename button exists and contains the inline ICON_EDIT SVG.
        expect(rename?.tagName).toBe('BUTTON');
        expect(rename?.innerHTML ?? '').toContain('<svg');
        // Switcher is still a button (chevron); it's unaffected by the rename
        // refactor.
        expect(switcher?.tagName).toBe('BUTTON');

        // Title-group hosts title → rename (centered as a unit). Action-group
        // hosts the switcher → new pair, anchored to the right edge of the
        // header. Asserting the local sibling order is enough — the visual
        // position is owned by CSS (see chat.css:.markon-chat-header).
        expect(rename?.previousElementSibling).toBe(title);
        expect(rename?.parentElement?.classList.contains('markon-chat-header-titlebar')).toBe(true);
        expect(switcher?.parentElement?.classList.contains('markon-chat-header-actions')).toBe(true);
    });
});
