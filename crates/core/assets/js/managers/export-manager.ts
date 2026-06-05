/**
 * ExportManager — two-step note export wizard.
 *
 * Step 1: a full-screen overlay listing every note on the page, grouped by
 *         heading, each selectable. Bulk select/clear lives in the single
 *         header row, which mirrors the step-2 editor bar.
 * Step 2: the chosen notes are rendered to Markdown and handed to the editor
 *         in `export` mode (see EditorManager), where the user can edit, copy
 *         to clipboard, or download a local `.md`.
 */

import { Logger } from '../core/utils';
import { Text } from '../services/text';
import {
    type AnnotationGroup,
    type AnnotationManager,
} from './annotation-manager';
import { EditorManager } from './editor-manager';

const _t: (key: string, ...args: unknown[]) => string =
    (typeof window !== 'undefined' && window.__MARKON_I18N__ && window.__MARKON_I18N__.t) ||
    ((k: string) => k);

export interface ExportManagerDeps {
    annotationManager: AnnotationManager;
    /** Document title used for the export heading + default download filename. */
    getDocumentTitle: () => string;
    /** Source file path (only used to construct the editor instance). */
    getFilePath: () => string;
}

export class ExportManager {
    #deps: ExportManagerDeps;
    #overlay: HTMLElement | null = null;
    #groups: AnnotationGroup[] = [];
    #selected = new Set<string>();
    #editor: EditorManager | null = null;

    constructor(deps: ExportManagerDeps) {
        this.#deps = deps;
    }

    /** Currently mounted (step 1 overlay visible)? */
    isOpen(): boolean {
        return this.#overlay !== null;
    }

    /**
     * Enter the wizard fresh from the toolbar: rebuild the grouped model
     * (notes only) and select everything by default. Returns false (without
     * opening) when the page has no notes, so the caller can flash the
     * "empty" hint.
     */
    open(): boolean {
        this.#groups = this.#notesGroups();
        const all = this.#allIds();
        if (all.length === 0) return false;
        this.#selected = new Set(all);
        this.#renderStep1();
        return true;
    }

    /** Tear down the step-1 overlay (without exporting). */
    close(): void {
        document.removeEventListener('keydown', this.#onKeydown);
        this.#overlay?.remove();
        this.#overlay = null;
        document.documentElement.classList.remove('markon-scroll-lock');
    }

    // ── internals ──────────────────────────────────────────────────────────

    /** Grouped model with empty (note-less) annotations and groups dropped. */
    #notesGroups(): AnnotationGroup[] {
        return this.#deps.annotationManager.getGroupedByHeading()
            .map(g => ({ ...g, items: g.items.filter(a => !!a.note && a.note.trim() !== '') }))
            .filter(g => g.items.length > 0);
    }

    #allIds(): string[] {
        return this.#groups.flatMap(g => g.items.map(a => a.id));
    }

    #onKeydown = (e: KeyboardEvent): void => {
        if (e.key === 'Escape' && this.#overlay) {
            e.preventDefault();
            this.close();
        }
    };

    #renderStep1(): void {
        // Re-render in place: drop any existing overlay + listener first so a
        // repeated render never stacks duplicate Esc handlers.
        document.removeEventListener('keydown', this.#onKeydown);
        this.#overlay?.remove();

        const overlay = document.createElement('div');
        overlay.className = 'export-modal';

        // One header bar mirrors the step-2 editor: close on the left, title,
        // selection tools, then the count + primary Next on the right.
        overlay.innerHTML = `
            <div class="export-header">
                <button class="export-close" data-export-action="cancel" title="${_t('web.editor.close.tip')}" aria-label="${_t('web.export.cancel')}">✕</button>
                <h2 class="export-title">${_t('web.export.wizard.title')}</h2>
                <button class="export-selectall" data-export-action="selectall">${_t('web.export.selectall')}</button>
                <button class="export-selectnone" data-export-action="selectnone">${_t('web.export.selectnone')}</button>
                <span class="export-count"></span>
                <button class="export-next" data-export-action="next">${_t('web.export.next')}</button>
            </div>
            <div class="export-body">${this.#groupsHtml()}</div>
        `;

        document.body.appendChild(overlay);
        this.#overlay = overlay;
        // Lock the background page so the wheel can't scroll it behind the modal.
        document.documentElement.classList.add('markon-scroll-lock');
        this.#bindStep1(overlay);
        this.#syncUI();
        document.addEventListener('keydown', this.#onKeydown);
        Logger.log('ExportManager', `Step 1 rendered (${this.#allIds().length} notes)`);
    }

    #groupsHtml(): string {
        return this.#groups.map((group, gi) => {
            const headingText = group.heading
                ? Text.escape(group.heading.text)
                : _t('web.export.nosection');
            const items = group.items.map(a => {
                const quote = a.text && a.text.trim()
                    ? `<span class="export-item-quote">${Text.escape(a.text.trim())}</span>`
                    : '';
                return `
                    <label class="export-item">
                        <input type="checkbox" class="export-item-check" data-export-id="${a.id}">
                        <span class="export-item-body">
                            <span class="export-item-note">${Text.escape((a.note ?? '').trim())}</span>
                            ${quote}
                        </span>
                    </label>`;
            }).join('');
            return `
                <section class="export-group" data-export-group="${gi}">
                    <label class="export-group-head">
                        <input type="checkbox" class="export-group-check" data-export-group="${gi}">
                        <span class="export-group-title">${headingText}</span>
                    </label>
                    <div class="export-group-items">${items}</div>
                </section>`;
        }).join('');
    }

    #bindStep1(overlay: HTMLElement): void {
        overlay.addEventListener('click', (e) => {
            const el = e.target as HTMLElement | null;
            const action = el?.closest<HTMLElement>('[data-export-action]')?.dataset.exportAction;
            if (!action) return;
            if (action === 'cancel') this.close();
            else if (action === 'next') this.#toStep2();
            else if (action === 'selectall') this.#selectAll(true);
            else if (action === 'selectnone') this.#selectAll(false);
        });

        overlay.addEventListener('change', (e) => {
            const el = e.target as HTMLElement | null;
            if (el?.classList.contains('export-item-check')) {
                const id = (el as HTMLInputElement).dataset.exportId;
                if (id) this.#toggleItem(id, (el as HTMLInputElement).checked);
            } else if (el?.classList.contains('export-group-check')) {
                const gi = Number((el as HTMLInputElement).dataset.exportGroup);
                this.#toggleGroup(gi, (el as HTMLInputElement).checked);
            }
        });
    }

    #selectAll(on: boolean): void {
        if (on) this.#selected = new Set(this.#allIds());
        else this.#selected.clear();
        this.#syncUI();
    }

    #toggleItem(id: string, on: boolean): void {
        if (on) this.#selected.add(id);
        else this.#selected.delete(id);
        this.#syncUI();
    }

    #toggleGroup(gi: number, on: boolean): void {
        this.#groups[gi]?.items.forEach(a => {
            if (on) this.#selected.add(a.id);
            else this.#selected.delete(a.id);
        });
        this.#syncUI();
    }

    /** Reflect `#selected` across item/group checkboxes, count, and Next. */
    #syncUI(): void {
        const overlay = this.#overlay;
        if (!overlay) return;

        overlay.querySelectorAll<HTMLInputElement>('.export-item-check').forEach(cb => {
            cb.checked = this.#selected.has(cb.dataset.exportId ?? '');
        });

        this.#groups.forEach((group, gi) => {
            const cb = overlay.querySelector<HTMLInputElement>(
                `.export-group-check[data-export-group="${gi}"]`,
            );
            if (!cb) return;
            const total = group.items.length;
            const on = group.items.filter(a => this.#selected.has(a.id)).length;
            cb.checked = on === total && total > 0;
            cb.indeterminate = on > 0 && on < total;
        });

        const total = this.#allIds().length;
        const selected = this.#selected.size;
        const countText = `${selected} / ${total} ${_t('web.export.selected')}`;
        overlay.querySelectorAll<HTMLElement>('.export-count').forEach(el => {
            el.textContent = countText;
        });
        overlay.querySelectorAll<HTMLButtonElement>('.export-next').forEach(btn => {
            btn.disabled = selected === 0;
        });
    }

    #toStep2(): void {
        if (this.#selected.size === 0) return;
        const title = this.#deps.getDocumentTitle();
        const markdown = this.#deps.annotationManager.formatAsMarkdown({
            ids: this.#selected,
        });

        // Drop the step-1 overlay but keep `#selected` / `#groups` so Back can
        // re-render the exact same selection.
        this.close();

        if (!this.#editor) {
            this.#editor = new EditorManager(this.#deps.getFilePath());
        }
        void this.#editor.open({
            mode: 'export',
            content: markdown,
            exportFileName: title || 'notes',
            onBack: () => this.#renderStep1(),
        });
        Logger.log('ExportManager', `Step 2 opened with ${this.#selected.size} notes`);
    }
}
