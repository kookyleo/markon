import { describe, expect, it } from 'vitest';
import { mergeAnnotationSnapshots } from './annotation-sync';
import type { Annotation } from '../managers/annotation-manager';

function makeAnnotation(id: string, position: number, text = id): Annotation {
    return {
        id,
        type: 'highlight-yellow',
        tagName: 'span',
        anchor: { position, exact: text, prefix: '', suffix: '' },
        text,
        note: null,
        createdAt: position,
    };
}

describe('mergeAnnotationSnapshots', () => {
    it('keeps local-only annotations and reports them for shared seeding', () => {
        const localOnly = makeAnnotation('anno-local', 10);
        const shared = makeAnnotation('anno-shared', 20);

        const result = mergeAnnotationSnapshots([localOnly], [shared]);

        expect(result.merged.map(a => a.id)).toEqual(['anno-local', 'anno-shared']);
        expect(result.missingFromShared).toEqual([localOnly]);
    });

    it('lets the shared snapshot win when ids overlap', () => {
        const local = makeAnnotation('anno-same', 10, 'local');
        const shared = makeAnnotation('anno-same', 10, 'shared');

        const result = mergeAnnotationSnapshots([local], [shared]);

        expect(result.merged).toEqual([shared]);
        expect(result.missingFromShared).toEqual([]);
    });

    it('sorts the merged result by document position', () => {
        const local = makeAnnotation('anno-local', 30);
        const shared = makeAnnotation('anno-shared', 5);

        const result = mergeAnnotationSnapshots([local], [shared]);

        expect(result.merged.map(a => a.id)).toEqual(['anno-shared', 'anno-local']);
        expect(result.missingFromShared.map(a => a.id)).toEqual(['anno-local']);
    });

    it('ignores malformed anchors in both snapshots without replacing a valid local annotation', () => {
        const local = makeAnnotation('anno-local', 10);
        const shared = makeAnnotation('anno-shared', 5);
        const missingAnchor = { ...local, anchor: undefined } as unknown as Annotation;
        const nullAnchor = { ...local, id: 'anno-null', anchor: null } as unknown as Annotation;
        const invalidPosition = { ...shared, id: 'anno-invalid', anchor: { position: '0' } } as unknown as Annotation;

        const incompleteQuote = { ...shared, anchor: { position: 5, exact: shared.text } } as unknown as Annotation;
        const malformedFragments = { ...local, anchor: { ...local.anchor, version: 2, fragments: [null] } } as unknown as Annotation;
        const result = mergeAnnotationSnapshots(
            [nullAnchor, local, invalidPosition, malformedFragments],
            [missingAnchor, shared, invalidPosition, incompleteQuote],
        );

        expect(result.merged).toEqual([shared, local]);
        expect(result.missingFromShared).toEqual([local]);
    });
});
