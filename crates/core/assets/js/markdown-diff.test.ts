import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownDiffPage } from './markdown-diff';

interface TestBlock {
    index: number;
    kind: string;
    label: string;
    text: string;
    source: string;
    html: string;
    start_line: number;
    end_line: number;
    digest: string;
}

function itemAt<T>(items: ArrayLike<T>, index: number): T {
    const item = items[index];
    expect(item).toBeDefined();
    if (item === undefined) throw new Error(`Missing item at index ${index}`);
    return item;
}

const heading = (index: number, text: string, level = 2): TestBlock => ({
    index,
    kind: 'heading',
    label: `H${level}`,
    text,
    source: `${'#'.repeat(level)} ${text}`,
    html: `<div class="heading-section"><h${level} id="${text.toLowerCase()}">${text}</h${level}></div>`,
    start_line: index + 1,
    end_line: index + 1,
    digest: `heading-${index}-${text}`,
});

const paragraph = (index: number, text: string): TestBlock => ({
    index,
    kind: 'paragraph',
    label: 'paragraph',
    text,
    source: text,
    html: `<p>${text}</p>`,
    start_line: index + 1,
    end_line: index + 1,
    digest: `paragraph-${index}-${text}`,
});

function mountRoot(defaultPath = ''): HTMLElement {
    document.body.innerHTML = `
        <main data-markdown-diff data-current-diff-view="rendered" data-diff-data-url="/diff.json" data-default-diff-path="${defaultPath}">
            <section class="git-preview-scroll" data-diff-view-panel="rendered">
                <article class="git-markdown-diff-content markdown-body" data-md-diff-content></article>
            </section>
        </main>
    `;
    const panel = document.querySelector<HTMLElement>('[data-diff-view-panel="rendered"]');
    if (panel) {
        Object.defineProperty(panel, 'clientHeight', { value: 600, configurable: true });
    }
    return document.querySelector<HTMLElement>('[data-markdown-diff]')!;
}

function diffPayload(): unknown {
    const intro = heading(0, 'Intro');
    const body = paragraph(1, 'Body copy');
    const detailsOld = heading(2, 'Details old');
    const detailsNew = heading(2, 'Details new');
    return {
        title: 'Diff',
        engine: { name: 'test', enabled: true },
        files: [
            {
                path: 'doc.md',
                old_path: null,
                status: 'modified',
                old: { block_count: 3, diagnostics: [], blocks: [intro, body, detailsOld] },
                new: { block_count: 3, diagnostics: [], blocks: [intro, body, detailsNew] },
                diagnostics: [],
                blocks: [
                    { kind: 'equal', old: intro, new: intro },
                    { kind: 'equal', old: body, new: body },
                    { kind: 'modified', old: detailsOld, new: detailsNew },
                ],
            },
        ],
    };
}

function keydown(key: string, target: Element = document.body): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
}

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

describe('MarkdownDiffPage rendered diff', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;
    let logSpy: ReturnType<typeof vi.spyOn>;
    let originalScrollTo: typeof HTMLElement.prototype.scrollTo | undefined;

    beforeEach(() => {
        document.body.innerHTML = '';
        document.head.innerHTML = '';
        localStorage.clear();
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        delete (window as { markonDiffAnnotations?: unknown }).markonDiffAnnotations;
        delete (window as { __MARKON_I18N__?: unknown }).__MARKON_I18N__;
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => diffPayload(),
            text: async () => '',
        } as unknown as Response);
        originalScrollTo = HTMLElement.prototype.scrollTo;
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
            configurable: true,
            value(this: HTMLElement, options?: ScrollToOptions | number, y?: number): void {
                if (typeof options === 'number') {
                    this.scrollLeft = options;
                    this.scrollTop = y ?? 0;
                    return;
                }
                this.scrollLeft = options?.left ?? this.scrollLeft;
                this.scrollTop = options?.top ?? this.scrollTop;
            },
        });
    });

    afterEach(() => {
        fetchSpy.mockRestore();
        logSpy.mockRestore();
        if (originalScrollTo) {
            Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
                configurable: true,
                value: originalScrollTo,
            });
        } else {
            delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
        }
        vi.restoreAllMocks();
    });

    it('does not install article-style keyboard or click focus in the rendered diff', async () => {
        const root = mountRoot();
        await new MarkdownDiffPage(root).load();

        const first = keydown('j');
        expect(first.defaultPrevented).toBe(false);
        expect(root.querySelectorAll('.md-diff-row.is-keyboard-focused')).toHaveLength(0);
        expect(root.querySelectorAll('.md-diff-block.is-keyboard-focused')).toHaveLength(0);
        expect(root.querySelectorAll('.heading-focused')).toHaveLength(0);

        const paragraphRow = root.querySelector<HTMLElement>('[data-md-diff-content] .md-diff-block p');
        paragraphRow?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(root.querySelectorAll('.md-diff-row.is-keyboard-focused')).toHaveLength(0);
        expect(root.querySelectorAll('.md-diff-block.is-keyboard-focused')).toHaveLength(0);
        expect(root.querySelectorAll('.heading-focused')).toHaveLength(0);
    });

    it('always fetches the full diff payload (no per-file ?f= filter)', async () => {
        // The diff is rendered continuously; ?f= is a scroll target, not a filter.
        const root = mountRoot('doc.md');
        await new MarkdownDiffPage(root).load();

        expect(fetchSpy).toHaveBeenCalledWith('/diff.json', { headers: { Accept: 'application/json' } });
    });

    it('collapses a file and persists when its "Viewed" checkbox is ticked', async () => {
        localStorage.clear();
        const root = mountRoot();
        await new MarkdownDiffPage(root).load();

        const content = root.querySelector<HTMLElement>('[data-md-diff-content]')!;
        expect(content.querySelectorAll('.md-diff-block').length).toBeGreaterThan(0);

        const checkbox = root.querySelector<HTMLInputElement>(
            '[data-md-diff-content] .md-diff-file-check input',
        )!;
        expect(checkbox).toBeTruthy();
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));

        // Collapsed: the file section stays (header), its body blocks are dropped.
        expect(content.querySelectorAll('.md-diff-block').length).toBe(0);
        expect(content.querySelectorAll('.md-diff-file-section').length).toBe(1);

        // Persisted under a per-diff localStorage key.
        const stored = localStorage.getItem('markon:diff:collapsed:/diff.json');
        expect(stored).toBeTruthy();
        expect(JSON.parse(stored!)).toContain('doc.md');
    });

    it('restores collapsed files from localStorage on load (fold only, not Viewed)', async () => {
        localStorage.clear();
        localStorage.setItem('markon:diff:collapsed:/diff.json', JSON.stringify(['doc.md']));
        const root = mountRoot();
        await new MarkdownDiffPage(root).load();

        const content = root.querySelector<HTMLElement>('[data-md-diff-content]')!;
        // Body is folded...
        expect(content.querySelectorAll('.md-diff-block').length).toBe(0);
        // ...but folding is independent of "Viewed": the checkbox stays unchecked.
        const checkbox = root.querySelector<HTMLInputElement>(
            '[data-md-diff-content] .md-diff-file-check input',
        )!;
        expect(checkbox.checked).toBe(false);
    });

    it('restores the Viewed mark from its own localStorage set (independent of fold)', async () => {
        localStorage.clear();
        localStorage.setItem('markon:diff:viewed:/diff.json', JSON.stringify(['doc.md']));
        localStorage.setItem('markon:diff:showviewed:/diff.json', '1');
        const root = mountRoot();
        await new MarkdownDiffPage(root).load();

        const content = root.querySelector<HTMLElement>('[data-md-diff-content]')!;
        const checkbox = root.querySelector<HTMLInputElement>(
            '[data-md-diff-content] .md-diff-file-check input',
        )!;
        // Marked Viewed drives the checkbox; the fold set is empty so the body
        // is NOT collapsed (a viewed file can stay open for re-reading).
        expect(checkbox.checked).toBe(true);
        expect(content.querySelectorAll('.md-diff-block').length).toBeGreaterThan(0);
    });

    it('offers Export notes in the all-done empty state', async () => {
        localStorage.clear();
        localStorage.setItem('markon:diff:viewed:/diff.json', JSON.stringify(['doc.md']));
        window.__MARKON_I18N__ = {
            t: (key: string) => key === 'web.export.label' ? 'Export notes' : key,
        };
        const exportNotes = vi.fn().mockResolvedValue(true);
        window.markonDiffAnnotations = {
            onBodyRendered: vi.fn(),
            onContentRendered: vi.fn(),
            exportNotes,
            notesCount: vi.fn().mockResolvedValue(4),
        };

        const root = mountRoot();
        await new MarkdownDiffPage(root).load();
        await flushMicrotasks();

        const empty = root.querySelector<HTMLElement>('.md-diff-viewed-empty')!;
        expect(empty).toBeTruthy();
        const buttons = [...empty.querySelectorAll<HTMLButtonElement>('.md-diff-viewed-empty-link')];
        expect(buttons.map(button => button.textContent)).toEqual(['Show all files', 'Export notes (4)']);
        const exportButton = itemAt(buttons, 1);
        expect(exportButton.disabled).toBe(false);

        exportButton.click();
        expect(exportNotes).toHaveBeenCalledWith(exportButton);
    });

    it('adds an all-done tail when viewed files remain visible', async () => {
        localStorage.clear();
        localStorage.setItem('markon:diff:viewed:/diff.json', JSON.stringify(['doc.md']));
        localStorage.setItem('markon:diff:showviewed:/diff.json', '1');
        window.__MARKON_I18N__ = {
            t: (key: string) => key === 'web.export.label' ? 'Export notes' : key,
        };
        const exportNotes = vi.fn().mockResolvedValue(false);
        window.markonDiffAnnotations = {
            onBodyRendered: vi.fn(),
            onContentRendered: vi.fn(),
            exportNotes,
            notesCount: vi.fn().mockResolvedValue(0),
        };

        const root = mountRoot();
        await new MarkdownDiffPage(root).load();
        await flushMicrotasks();

        const content = root.querySelector<HTMLElement>('[data-md-diff-content]')!;
        expect(content.querySelector('.md-diff-viewed-empty')).toBeNull();
        expect(content.querySelectorAll('.md-diff-file-section')).toHaveLength(1);

        const done = content.querySelector<HTMLElement>('.md-diff-viewed-done')!;
        expect(done).toBeTruthy();
        expect(done.compareDocumentPosition(content.querySelector('.md-diff-file-section')!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
        const buttons = [...done.querySelectorAll<HTMLButtonElement>('.md-diff-viewed-empty-link')];
        expect(buttons.map(button => button.textContent)).toEqual(['Hide all Viewed files', 'Export notes (0)']);
        const exportButton = itemAt(buttons, 1);
        expect(exportButton.disabled).toBe(true);
        exportButton.click();
        expect(exportNotes).not.toHaveBeenCalled();
    });

    it('chevron folds without marking Viewed; double-click on the bar folds too', async () => {
        localStorage.clear();
        const root = mountRoot();
        await new MarkdownDiffPage(root).load();
        const content = root.querySelector<HTMLElement>('[data-md-diff-content]')!;
        const header = content.querySelector<HTMLElement>('.md-diff-file-header')!;
        const chevron = header.querySelector<HTMLButtonElement>('.md-diff-chevron')!;
        const checkbox = header.querySelector<HTMLInputElement>('.md-diff-file-check input')!;

        // Chevron folds the body but never touches Viewed.
        chevron.click();
        expect(content.querySelectorAll('.md-diff-block').length).toBe(0);
        expect(
            content.querySelector<HTMLInputElement>('.md-diff-file-check input')!.checked,
        ).toBe(false);
        expect(localStorage.getItem('markon:diff:viewed:/diff.json')).toBeNull();

        // Double-click on the bar's empty space expands it again (pure fold).
        content
            .querySelector<HTMLElement>('.md-diff-file-header')!
            .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        expect(content.querySelectorAll('.md-diff-block').length).toBeGreaterThan(0);
        expect(checkbox).toBeTruthy();
    });

    it('renders modified blocks as stacked overlay layers without extra labels', async () => {
        const root = mountRoot();
        await new MarkdownDiffPage(root).load();

        const modified = root.querySelector<HTMLElement>('.md-diff-block.is-modified');
        const oldCard = modified?.querySelector<HTMLElement>('.md-diff-change-card-old');
        const newCard = modified?.querySelector<HTMLElement>('.md-diff-change-card-new');
        expect(modified).toBeTruthy();
        expect(modified?.querySelector('.md-diff-change-badge')).toBeNull();
        expect(modified?.querySelector('.md-diff-change-header')).toBeNull();
        expect(modified?.querySelector('.md-diff-change-gutter')).toBeNull();
        expect(modified?.querySelector('.md-diff-change-body')).toBeNull();
        expect(modified?.textContent).not.toContain('Before');
        expect(modified?.textContent).not.toContain('After');
        expect(oldCard?.dataset['diffMarker']).toBe('-');
        expect(newCard?.dataset['diffMarker']).toBe('+');
        expect(oldCard?.firstElementChild?.classList.contains('md-diff-rendered')).toBe(true);
        expect(newCard?.firstElementChild?.classList.contains('md-diff-rendered')).toBe(true);
        expect(oldCard?.querySelector('h2')?.textContent).toBe('Details old');
        expect(newCard?.querySelector('h2')?.textContent).toBe('Details new');
    });

    it('keeps the original document section depth for rendered Markdown blocks', async () => {
        const root = mountRoot();
        await new MarkdownDiffPage(root).load();

        const renderedEqual = root.querySelectorAll<HTMLElement>('[data-md-diff-content] .md-diff-block.is-equal .md-diff-rendered');
        const intro = renderedEqual[0];
        const body = renderedEqual[1];

        expect(intro?.dataset['mdBlockKind']).toBe('heading');
        expect(intro?.dataset['mdSectionDepth']).toBe('0');
        expect(intro?.classList.contains('md-diff-rendered-sectioned')).toBe(false);
        expect(body?.dataset['mdBlockKind']).toBe('paragraph');
        expect(body?.dataset['mdSectionDepth']).toBe('1');
        expect(body?.classList.contains('md-diff-rendered-sectioned')).toBe(true);
        expect(body?.style.getPropertyValue('--md-diff-section-indent')).toBe('10px');
        expect(body?.style.getPropertyValue('--md-diff-section-indent-wide')).toBe('14px');
    });

    it('accumulates nested heading section depth like the article renderer', async () => {
        const h1 = heading(0, 'Chapter', 1);
        const h2 = heading(1, 'Topic', 2);
        const h3 = heading(2, 'Detail', 3);
        const body = paragraph(3, 'Nested body');
        const tailOld = paragraph(4, 'Tail old');
        const tailNew = paragraph(4, 'Tail new');
        fetchSpy.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                title: 'Diff',
                engine: { name: 'test', enabled: true },
                files: [
                    {
                        path: 'nested.md',
                        old_path: null,
                        status: 'modified',
                        old: { block_count: 5, diagnostics: [], blocks: [h1, h2, h3, body, tailOld] },
                        new: { block_count: 5, diagnostics: [], blocks: [h1, h2, h3, body, tailNew] },
                        diagnostics: [],
                        blocks: [
                            { kind: 'equal', old: h1, new: h1 },
                            { kind: 'equal', old: h2, new: h2 },
                            { kind: 'equal', old: h3, new: h3 },
                            { kind: 'equal', old: body, new: body },
                            { kind: 'modified', old: tailOld, new: tailNew },
                        ],
                    },
                ],
            }),
            text: async () => '',
        });

        const root = mountRoot();
        await new MarkdownDiffPage(root).load();

        // Expand any collapsed runs so every equal block is rendered.
        root.querySelectorAll<HTMLButtonElement>('[data-md-diff-content] button.md-diff-gap').forEach((b) => b.click());

        const rendered = root.querySelectorAll<HTMLElement>('[data-md-diff-content] .md-diff-block.is-equal .md-diff-rendered');
        const h1Rendered = rendered[0];
        const h2Rendered = rendered[1];
        const h3Rendered = rendered[2];
        const bodyRendered = rendered[3];

        expect(h1Rendered?.dataset['mdSectionDepth']).toBe('0');
        expect(h2Rendered?.dataset['mdSectionDepth']).toBe('1');
        expect(h3Rendered?.dataset['mdSectionDepth']).toBe('2');
        expect(bodyRendered?.dataset['mdSectionDepth']).toBe('3');
        expect(bodyRendered?.style.getPropertyValue('--md-diff-section-indent')).toBe('30px');
        expect(bodyRendered?.style.getPropertyValue('--md-diff-section-indent-wide')).toBe('42px');
    });

    it('collapses long runs of unchanged blocks into an expandable gap', async () => {
        const equals = Array.from({ length: 10 }, (_, i) => paragraph(i, `Para ${i}`));
        const changedOld = paragraph(10, 'Changed old');
        const changedNew = paragraph(10, 'Changed new');
        const allOld = [...equals, changedOld];
        const allNew = [...equals, changedNew];
        fetchSpy.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                title: 'Diff',
                engine: { name: 'test', enabled: true },
                files: [
                    {
                        path: 'long.md',
                        old_path: null,
                        status: 'modified',
                        old: { block_count: allOld.length, diagnostics: [], blocks: allOld },
                        new: { block_count: allNew.length, diagnostics: [], blocks: allNew },
                        diagnostics: [],
                        blocks: [
                            ...equals.map((b) => ({ kind: 'equal', old: b, new: b })),
                            { kind: 'modified', old: changedOld, new: changedNew },
                        ],
                    },
                ],
            }),
            text: async () => '',
        });

        const root = mountRoot();
        await new MarkdownDiffPage(root).load();

        const content = root.querySelector<HTMLElement>('[data-md-diff-content]')!;
        // Leading unchanged blocks (>CONTEXT away from the change) collapse to a gap.
        const gap = content.querySelector<HTMLButtonElement>('button.md-diff-gap');
        expect(gap).toBeTruthy();
        expect(gap?.textContent).toMatch(/Show \d+ unchanged blocks/);
        const collapsedBefore = content.querySelectorAll('.md-diff-block').length;
        expect(collapsedBefore).toBeLessThan(11);

        // Clicking the gap reveals the hidden blocks and removes the button.
        gap?.click();
        expect(content.querySelector('button.md-diff-gap')).toBeNull();
        expect(content.querySelectorAll('.md-diff-block').length).toBeGreaterThan(collapsedBefore);
    });

    it('does not consume navigation keys from form fields', async () => {
        const root = mountRoot();
        await new MarkdownDiffPage(root).load();
        keydown('j');

        const input = document.createElement('input');
        document.body.appendChild(input);
        const ignored = keydown('j', input);

        expect(ignored.defaultPrevented).toBe(false);
        expect(root.querySelectorAll('.md-diff-row.is-keyboard-focused')).toHaveLength(0);
        expect(root.querySelectorAll('.heading-focused')).toHaveLength(0);
    });
});
