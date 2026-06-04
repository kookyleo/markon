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
