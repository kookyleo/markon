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
});
