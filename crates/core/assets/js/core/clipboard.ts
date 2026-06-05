/**
 * Clipboard helpers shared by the annotation export surfaces (toolbar wizard,
 * note-card quick copy, popover quick copy).
 */

/** Copy `text` to the clipboard, falling back to a hidden textarea + execCommand. */
export async function copyText(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // fall through to the legacy path
    }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        ta.style.pointerEvents = 'none';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
    } catch {
        return false;
    }
}

/**
 * Show a small transient feedback bubble next to `anchor` (to its left),
 * without touching the anchor's own content. Used for icon buttons where
 * swapping the label would garble the glyph — e.g. the per-annotation
 * quick-copy button on note cards.
 */
export function flashBeside(anchor: HTMLElement, message: string, ms = 1200): void {
    const tip = document.createElement('span');
    tip.className = 'markon-copy-flash';
    tip.textContent = message;
    document.body.appendChild(tip);

    const r = anchor.getBoundingClientRect();
    tip.style.top = `${r.top + r.height / 2}px`;
    tip.style.left = `${r.left}px`;

    // Fade in next frame, then out, then remove.
    requestAnimationFrame(() => tip.classList.add('is-visible'));
    window.setTimeout(() => {
        tip.classList.remove('is-visible');
        window.setTimeout(() => tip.remove(), 200);
    }, ms);
}

/** Check glyph shown on a successful icon-button copy (matches the stroked
 *  line-icon family used by the note-card actions). */
const CHECK_SVG =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 8.5l3.2 3.2L13 4.5"/></svg>';

/**
 * Flash an icon button green with a check mark, then restore its original
 * icon. Used for the per-annotation quick-copy buttons so the click lands as
 * visible feedback on the control itself. Re-entrant: a rapid second click
 * resets the timer and always restores the true icon (never the check).
 */
export function flashCopied(button: HTMLElement, ms = 1100): void {
    if (button.dataset.copiedOriginal === undefined) {
        button.dataset.copiedOriginal = button.innerHTML;
    }
    if (button.dataset.copiedTimer) {
        window.clearTimeout(Number(button.dataset.copiedTimer));
    }
    button.innerHTML = CHECK_SVG;
    button.classList.add('is-copied');
    const timer = window.setTimeout(() => {
        button.innerHTML = button.dataset.copiedOriginal ?? '';
        button.classList.remove('is-copied');
        delete button.dataset.copiedOriginal;
        delete button.dataset.copiedTimer;
    }, ms);
    button.dataset.copiedTimer = String(timer);
}

/**
 * Briefly swap an element's text to `message`, then restore the original.
 * Used for the inline "✓ Copied" / "Failed" feedback. Re-entrant: a second
 * call before the timer fires restores the true original, not the flashed text.
 */
export function flashText(el: HTMLElement, message: string, ms = 1500): void {
    if (el.dataset.flashOriginal === undefined) {
        el.dataset.flashOriginal = el.textContent ?? '';
    }
    if (el.dataset.flashTimer) {
        window.clearTimeout(Number(el.dataset.flashTimer));
    }
    el.textContent = message;
    el.classList.add('is-flashing');
    const timer = window.setTimeout(() => {
        el.textContent = el.dataset.flashOriginal ?? '';
        el.classList.remove('is-flashing');
        delete el.dataset.flashOriginal;
        delete el.dataset.flashTimer;
    }, ms);
    el.dataset.flashTimer = String(timer);
}
