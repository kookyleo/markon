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
