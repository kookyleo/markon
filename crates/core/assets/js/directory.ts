/**
 * Directory / workspace landing page controls.
 *
 * i18n label application, the Markdown/all file filter, workspace feature
 * toggles, copy-to-clipboard buttons, the workspace dropdown, branch checkout,
 * the workspace modals (go-to-file, add-file), and the `t` go-to-file shortcut.
 *
 * Built as a CLASSIC (IIFE) bundle and loaded as a non-module `<script>` at the
 * same spot in `directory.html` where this used to live inline — it runs during
 * parse, before the deferred `main.js` / `workspace-diff.js` modules.
 */

type I18nFn = (key: string) => string;

interface GoToFileEntry {
    path: string;
    url: string;
    is_markdown?: boolean;
}

const t: I18nFn = (window.__MARKON_I18N__ && window.__MARKON_I18N__.t) || ((k: string) => k);

// ── Static i18n labels ──────────────────────────────────────────────────────
const heading = document.getElementById('dir-heading');
// Only translate when an i18n key is present; a server-rendered alias has no
// key and must be left as-is (don't fall back to the generic heading).
if (heading && heading.dataset.i18nKey) heading.textContent = t(heading.dataset.i18nKey);
const labelMap: Record<string, string> = {
    'dir-current-label': 'web.dir.current',
    'dir-footer': 'web.footer',
    'dir-feedback-link': 'web.footer.feedback',
    'dir-kbd-link': 'web.kbd.link',
};
for (const id in labelMap) {
    const el = document.getElementById(id);
    if (el) el.textContent = t(labelMap[id]);
}
document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n') || '');
});
document.querySelectorAll<HTMLElement>('[data-i18n-placeholder]').forEach((el) => {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder') || ''));
});

// ── File filter (Markdown / all) ────────────────────────────────────────────
function setFileFilter(mode: string | null): void {
    const next = mode === 'all' ? 'all' : 'markdown';
    document.querySelectorAll<HTMLElement>('.dir-list[data-file-filter]').forEach((list) => {
        list.setAttribute('data-file-filter', next);
    });
    document
        .querySelectorAll<HTMLElement>('[data-file-filter-switch] [data-file-filter-value]')
        .forEach((button) => {
            const active = button.getAttribute('data-file-filter-value') === next;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
}
document.querySelectorAll<HTMLElement>('[data-file-filter-switch]').forEach((group) => {
    group.addEventListener('click', (event) => {
        const target = event.target as Element | null;
        const button = target && target.closest ? target.closest('[data-file-filter-value]') : null;
        if (!button) return;
        event.preventDefault();
        setFileFilter(button.getAttribute('data-file-filter-value'));
    });
});
setFileFilter('markdown');

// ── Workspace feature toggles (live POST) ───────────────────────────────────
function featurePayload(inputs: HTMLInputElement[]): Record<string, boolean> {
    const payload: Record<string, boolean> = {};
    inputs.forEach((input) => {
        payload[input.getAttribute('data-feature-key') || ''] = input.checked;
    });
    return payload;
}
function setFeaturePending(form: HTMLElement, pending: boolean): void {
    const canEdit = form.getAttribute('data-can-edit') === 'true';
    form.querySelectorAll<HTMLInputElement>('input[data-feature-key]').forEach((input) => {
        input.disabled = pending || !canEdit;
        const row = input.closest('.workspace-feature-switch');
        if (row) row.classList.toggle('is-pending', pending);
    });
}
function syncFeatureSwitch(input: HTMLInputElement): void {
    const row = input.closest('.workspace-feature-switch');
    if (row) row.classList.toggle('is-on', input.checked);
}
function setupWorkspaceFeatureForm(): void {
    const form = document.querySelector<HTMLElement>('[data-workspace-feature-form]');
    if (!form) return;
    const inputs = Array.from(form.querySelectorAll<HTMLInputElement>('input[data-feature-key]'));
    inputs.forEach(syncFeatureSwitch);
    if (form.getAttribute('data-can-edit') !== 'true') return;
    inputs.forEach((input) => {
        input.addEventListener('change', () => {
            const previous = !input.checked;
            syncFeatureSwitch(input);
            setFeaturePending(form, true);
            fetch(form.getAttribute('data-update-url') || '', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(featurePayload(inputs)),
            })
                .then((resp) =>
                    resp.text().then((text) => {
                        let data: { success?: boolean; message?: string } = {};
                        try { data = text ? JSON.parse(text) : {}; } catch { /* ignore */ }
                        if (!resp.ok || data.success === false) throw new Error(data.message || text || resp.statusText);
                        setFeaturePending(form, false);
                    }),
                )
                .catch((err) => {
                    input.checked = previous;
                    syncFeatureSwitch(input);
                    setFeaturePending(form, false);
                    window.alert(t('web.ws.feature.update_failed') + ': ' + (err.message || String(err)));
                });
        });
    });
}
setupWorkspaceFeatureForm();

// ── Copy buttons ────────────────────────────────────────────────────────────
function copyText(text: string): Promise<boolean> {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(() => true, () => false);
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', 'readonly');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return Promise.resolve(ok);
}
document.querySelectorAll<HTMLElement>('[data-copy-text]').forEach((button) => {
    button.addEventListener('click', () => {
        const value = button.getAttribute('data-copy-text') || '';
        const original = t(button.getAttribute('data-i18n') || 'web.ws.meta.copy_id');
        copyText(value).then((ok) => {
            button.textContent = t(ok ? 'web.ws.meta.copied' : 'web.ws.meta.copy_failed');
            window.setTimeout(() => { button.textContent = original; }, 1200);
        });
    });
});
document.querySelectorAll<HTMLElement>('[data-copy-current-url]').forEach((button) => {
    button.addEventListener('click', () => {
        const original = button.textContent;
        copyText(window.location.href).then((ok) => {
            button.textContent = t(ok ? 'web.ws.meta.copied' : 'web.ws.meta.copy_failed');
            window.setTimeout(() => { button.textContent = original; }, 1200);
        });
    });
});

// Set/clear the workspace alias (a short display name). Prompt-based — a
// secondary, low-traffic action folded into the menu.
document.querySelectorAll<HTMLElement>('[data-set-alias]').forEach((button) => {
    button.addEventListener('click', () => {
        const url = button.getAttribute('data-alias-url') || '';
        if (!url) return;
        const current = button.getAttribute('data-current-alias') || '';
        const next = window.prompt(t('web.ws.set_alias_prompt'), current);
        if (next === null) return; // cancelled
        fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alias: next.trim() }),
        })
            .then((resp) => { if (resp.ok) window.location.reload(); else window.alert(t('web.ws.set_alias_failed')); })
            .catch(() => window.alert(t('web.ws.set_alias_failed')));
    });
});

// ── Workspace dropdown ──────────────────────────────────────────────────────
document.querySelectorAll<HTMLElement>('[data-workspace-dropdown] > button').forEach((button) => {
    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const menu = button.closest('[data-workspace-dropdown]');
        if (!menu) return;
        const open = menu.classList.contains('is-open');
        document.querySelectorAll('[data-workspace-dropdown].is-open').forEach((other) => {
            if (other !== menu) other.classList.remove('is-open');
        });
        menu.classList.toggle('is-open', !open);
    });
});
document.addEventListener('click', () => {
    document.querySelectorAll('[data-workspace-dropdown].is-open').forEach((menu) => {
        menu.classList.remove('is-open');
    });
});

// ── Branch checkout ─────────────────────────────────────────────────────────
document.querySelectorAll<HTMLButtonElement>('[data-checkout-branch]').forEach((button) => {
    button.addEventListener('click', (event) => {
        event.preventDefault();
        const branch = button.getAttribute('data-checkout-branch') || '';
        const shell = document.querySelector('[data-workspace-workbench]');
        const url = shell && shell.getAttribute('data-checkout-url');
        if (!branch || !url || button.disabled) return;
        fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ branch }),
        })
            .then((resp) =>
                resp.text().then((text) => {
                    let data: { success?: boolean; message?: string } = {};
                    try { data = text ? JSON.parse(text) : {}; } catch { /* ignore */ }
                    if (!resp.ok || data.success === false) throw new Error(data.message || text || resp.statusText);
                    window.location.reload();
                }),
            )
            .catch((err) => {
                window.alert(err.message || String(err));
            });
    });
});

// ── Workspace modals ────────────────────────────────────────────────────────
function openWorkspaceModal(modal: Element | null): void {
    if (!modal) return;
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
    const input = modal.querySelector<HTMLElement>('input, textarea, button');
    if (input) window.setTimeout(() => { input.focus(); }, 0);
}
function closeWorkspaceModals(): void {
    document.querySelectorAll('.workspace-modal.is-open').forEach((modal) => {
        modal.classList.remove('is-open');
        modal.setAttribute('aria-hidden', 'true');
    });
}
document.querySelectorAll<HTMLElement>('[data-close-workspace-modal]').forEach((button) => {
    button.addEventListener('click', closeWorkspaceModals);
});
document.querySelectorAll<HTMLElement>('.workspace-modal').forEach((modal) => {
    modal.addEventListener('click', (event) => {
        if (event.target === modal) closeWorkspaceModals();
    });
});

// ── Go-to-file modal ────────────────────────────────────────────────────────
const goFinder = document.querySelector<HTMLElement>('[data-file-finder]');
const goInput = document.querySelector<HTMLInputElement>('[data-go-to-file-input]');
const goResults = document.querySelector<HTMLElement>('[data-go-to-file-results]');
const goEmpty = document.querySelector<HTMLElement>('[data-go-to-file-empty]');
let goFiles: GoToFileEntry[] | null = null;
function renderGoToFile(): void {
    if (!goResults) return;
    const q = ((goInput && goInput.value) || '').trim().toLowerCase();
    goResults.innerHTML = '';
    const list = (goFiles || []).filter((file) => !q || file.path.toLowerCase().indexOf(q) !== -1).slice(0, 40);
    if (goEmpty) goEmpty.style.display = list.length ? 'none' : '';
    list.forEach((file) => {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = file.url;
        const path = document.createElement('span');
        path.className = 'workspace-file-result-path';
        path.textContent = file.path;
        const badge = document.createElement('span');
        badge.className = 'workspace-file-result-badge';
        badge.textContent = file.is_markdown ? 'MD' : '';
        a.appendChild(path);
        a.appendChild(badge);
        li.appendChild(a);
        goResults.appendChild(li);
    });
}
function loadGoFiles(): void {
    if (goFiles) { renderGoToFile(); return; }
    if (!goFinder) return;
    if (goEmpty) goEmpty.textContent = t('web.ws.go_to_file.loading');
    fetch(goFinder.getAttribute('data-files-data-url') || '', { credentials: 'same-origin' })
        .then((resp) => { if (!resp.ok) throw new Error(resp.statusText); return resp.json(); })
        .then((files: GoToFileEntry[]) => { goFiles = files || []; renderGoToFile(); })
        .catch((err) => {
            goFiles = [];
            if (goEmpty) goEmpty.textContent = err.message || String(err);
            renderGoToFile();
        });
}
function openFinder(): void {
    if (!goFinder) return;
    goFinder.classList.add('is-open');
    loadGoFiles();
}
function closeFinder(): void {
    if (goFinder) goFinder.classList.remove('is-open');
}
function focusFinder(): void {
    if (goInput) { goInput.focus(); goInput.select(); }
    openFinder();
}
if (goInput) {
    goInput.addEventListener('focus', openFinder);
    goInput.addEventListener('input', () => { openFinder(); renderGoToFile(); });
    goInput.addEventListener('blur', () => window.setTimeout(closeFinder, 150));
}
document.addEventListener('click', (event) => {
    const node = event.target as Node | null;
    if (goFinder && node && !goFinder.contains(node)) closeFinder();
});

// ── Add-file modal ──────────────────────────────────────────────────────────
document.querySelectorAll<HTMLElement>('[data-open-add-file]').forEach((button) => {
    button.addEventListener('click', (event) => {
        event.preventDefault();
        openWorkspaceModal(document.querySelector('[data-add-file-modal]'));
    });
});
const addForm = document.querySelector<HTMLFormElement>('[data-add-file-form]');
if (addForm) {
    addForm.addEventListener('submit', (event) => {
        event.preventDefault();
        const modal = document.querySelector('[data-add-file-modal]');
        const pathInput = addForm.querySelector<HTMLInputElement>('[data-add-file-path]');
        const contentInput = addForm.querySelector<HTMLTextAreaElement>('[data-add-file-content]');
        const status = addForm.querySelector<HTMLElement>('[data-add-file-status]');
        let rel = ((pathInput && pathInput.value) || '').trim();
        const last = rel.split('/').pop();
        if (rel && last && last.indexOf('.') === -1) rel += '.md';
        if (!rel) {
            if (status) status.textContent = t('web.ws.create_file.path_required');
            return;
        }
        if (status) status.textContent = t('web.ws.create_file.creating');
        fetch((modal && modal.getAttribute('data-create-file-url')) || '', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: rel, content: contentInput ? contentInput.value : '' }),
        })
            .then((resp) =>
                resp.text().then((text) => {
                    let data: { success?: boolean; message?: string; url?: string } = {};
                    try { data = text ? JSON.parse(text) : {}; } catch { /* ignore */ }
                    if (!resp.ok || data.success === false) throw new Error(data.message || text || resp.statusText);
                    window.location.href = data.url || window.location.href;
                }),
            )
            .catch((err) => {
                if (status) status.textContent = err.message || String(err);
            });
    });
}

// ── Add-folder modal ────────────────────────────────────────────────────────
document.querySelectorAll<HTMLElement>('[data-open-add-folder]').forEach((button) => {
    button.addEventListener('click', (event) => {
        event.preventDefault();
        openWorkspaceModal(document.querySelector('[data-add-folder-modal]'));
    });
});
const addFolderForm = document.querySelector<HTMLFormElement>('[data-add-folder-form]');
if (addFolderForm) {
    addFolderForm.addEventListener('submit', (event) => {
        event.preventDefault();
        const modal = document.querySelector('[data-add-folder-modal]');
        const pathInput = addFolderForm.querySelector<HTMLInputElement>('[data-add-folder-path]');
        const status = addFolderForm.querySelector<HTMLElement>('[data-add-folder-status]');
        const rel = ((pathInput && pathInput.value) || '').trim();
        if (!rel) {
            if (status) status.textContent = t('web.ws.create_folder.path_required');
            return;
        }
        if (status) status.textContent = t('web.ws.create_folder.creating');
        fetch((modal && modal.getAttribute('data-create-folder-url')) || '', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: rel }),
        })
            .then((resp) =>
                resp.text().then((text) => {
                    let data: { success?: boolean; message?: string; url?: string } = {};
                    try { data = text ? JSON.parse(text) : {}; } catch { /* ignore */ }
                    if (!resp.ok || data.success === false) throw new Error(data.message || text || resp.statusText);
                    window.location.href = data.url || window.location.href;
                }),
            )
            .catch((err) => {
                if (status) status.textContent = err.message || String(err);
            });
    });
}

// ── Keyboard: Esc closes modals, `t` opens go-to-file ───────────────────────
document.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null;
    const isTyping = !!target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || '');
    if (event.key === 'Escape') { closeWorkspaceModals(); closeFinder(); if (goInput) goInput.blur(); }
    if (!isTyping && event.key && event.key.toLowerCase() === 't') {
        event.preventDefault();
        focusFinder();
    }
});

// ── Remaining placeholders / title ──────────────────────────────────────────
const si = document.getElementById('search-input') as HTMLInputElement | null;
if (si) si.placeholder = t('web.search.placeholder');
const se = document.getElementById('search-esc-text');
if (se) se.textContent = t('web.search.esc');
const go = document.querySelector<HTMLInputElement>('[data-go-to-file-input]');
if (go) go.placeholder = t('web.ws.go_to_file.placeholder');
const addPath = document.querySelector<HTMLInputElement>('[data-add-file-path]');
if (addPath) addPath.placeholder = t('web.ws.create_file.placeholder');
const addFolderPath = document.querySelector<HTMLInputElement>('[data-add-folder-path]');
if (addFolderPath) addFolderPath.placeholder = t('web.ws.create_folder.placeholder');
document.title = t((heading && heading.dataset.titleKey) || 'web.title.dir');

export {};
