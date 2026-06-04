/**
 * Browser-side file download helpers.
 *
 * The project had no local-download capability before the annotation export
 * wizard; this is the single place that turns an in-memory string into a
 * "save to disk" prompt via a transient object URL.
 */

/** Trigger a browser download of `text` as a file named `filename`. */
export function downloadTextFile(
    filename: string,
    text: string,
    mime = 'text/markdown',
): void {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke on the next tick so the click has a chance to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Derive a safe `<base>.md` filename from a document title / file path.
 * Strips any existing extension and collapses characters that are awkward in
 * file names, while keeping Unicode letters/digits (so CJK titles survive).
 */
export function toMarkdownFilename(title: string | undefined, fallback = 'annotations'): string {
    const raw = (title ?? '').trim().replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
    const base = raw
        .replace(/[\s]+/gu, '-')
        .replace(/[^\p{L}\p{N}\-_.]+/gu, '')
        .replace(/^[-.]+|[-.]+$/g, '');
    return `${base || fallback}.md`;
}
