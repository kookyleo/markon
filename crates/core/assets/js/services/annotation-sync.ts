import type { Annotation } from '../managers/annotation-manager';

export interface AnnotationMergeResult {
    /** Shared data wins on id conflict; local-only annotations are appended. */
    merged: Annotation[];
    /** Annotations visible locally but absent from the shared snapshot. */
    missingFromShared: Annotation[];
}

const annotationOrder = (a: Annotation, b: Annotation): number => {
    const ap = typeof a.anchor.position === 'number' ? a.anchor.position : Number.POSITIVE_INFINITY;
    const bp = typeof b.anchor.position === 'number' ? b.anchor.position : Number.POSITIVE_INFINITY;
    if (ap !== bp) return ap - bp;
    return a.createdAt - b.createdAt;
};

/**
 * Merge a shared snapshot into the currently visible annotation set.
 *
 * The shared snapshot is authoritative for annotations with the same id, but
 * local-only annotations are retained and reported so callers can seed them
 * into shared storage. This avoids the "toggle shared mode and annotations
 * disappear" failure without inventing conflict UI.
 */
export function mergeAnnotationSnapshots(
    currentLocal: Annotation[],
    sharedSnapshot: Annotation[],
): AnnotationMergeResult {
    const mergedById = new Map<string, Annotation>();
    sharedSnapshot.forEach(annotation => mergedById.set(annotation.id, annotation));

    const missingFromShared: Annotation[] = [];
    currentLocal.forEach((annotation) => {
        if (mergedById.has(annotation.id)) return;
        mergedById.set(annotation.id, annotation);
        missingFromShared.push(annotation);
    });

    return {
        merged: [...mergedById.values()].sort(annotationOrder),
        missingFromShared: missingFromShared.sort(annotationOrder),
    };
}
