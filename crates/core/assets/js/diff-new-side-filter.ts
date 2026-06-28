/**
 * Single source of truth for "what counts as the NEW (worktree) side" of the
 * rendered compare diff. Annotations may only be created on, and re-anchored
 * against, the new side: the old/deleted text isn't a live file, so a quote
 * found there must never become an anchor.
 *
 * `NEW_SIDE_REJECT` is the predicate threaded through text-anchor's `collect`
 * and AnnotationManager's `#wrapRange` walker — it returns `true` for any text
 * node that belongs to old/deleted/structural-context chrome and must be
 * excluded from the anchoring stream.
 */

/**
 * Selectors whose subtree is OLD-side / non-annotatable chrome:
 *  - `.md-diff-change-card-old`   the old half of a modified block's two cards
 *  - `.md-diff-block.is-deleted`  a wholly deleted block (no new content)
 *  - `.md-diff-item-old`          the old item of a structural list/table diff
 *  - `.git-diff-word-del`         an inline deleted word run (NOT `…-word-add`,
 *                                 which is new-side and stays annotatable)
 *  - `.md-diff-gap` / `.md-diff-gap-label`  collapsed-context affordances
 *  - `.md-diff-file-header`       the sticky per-file header chrome
 *  - `.md-diff-diagnostics`       the per-file engine diagnostics lead
 */
const REJECT_SELECTOR = [
    '.md-diff-change-card-old',
    '.md-diff-block.is-deleted',
    '.md-diff-item-old',
    '.git-diff-word-del',
    '.md-diff-gap',
    '.md-diff-gap-label',
    '.md-diff-file-header',
    '.md-diff-diagnostics',
].join(',');

/** Resolve the nearest Element for a node (itself if an Element, else parent). */
function elementOf(node: Node): Element | null {
    return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

/**
 * `true` when `node`'s nearest relevant ancestor is old-side / non-annotatable
 * chrome (see `REJECT_SELECTOR`). Used to keep the old/deleted text out of the
 * anchoring stream and out of the wrap walker.
 */
export function NEW_SIDE_REJECT(node: Node): boolean {
    return !!elementOf(node)?.closest(REJECT_SELECTOR);
}

/**
 * The annotatable root for a file `<section>`: its `.md-diff-file-body`. Falls
 * back to the section itself when the body hasn't been built yet (defensive;
 * callers normally pass a rendered section).
 */
export function newSideRootFor(sectionEl: HTMLElement): HTMLElement {
    return sectionEl.querySelector<HTMLElement>('.md-diff-file-body') ?? sectionEl;
}

/**
 * The file `<section>` a node lives in, identified by a real absolute path
 * (`data-abs-path`). Returns `null` for nodes outside any keyed section (e.g.
 * a not-yet-keyed section or unrelated chrome).
 */
export function sectionForNode(node: Node): HTMLElement | null {
    return elementOf(node)?.closest<HTMLElement>('.md-diff-file-section[data-abs-path]') ?? null;
}
