import { beforeEach, describe, expect, it } from 'vitest';
import { loadShowViewed, persistShowViewed } from './diff-file-header';

describe('diff viewed-file filter preference', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('defaults to hiding viewed files when no preference is stored', () => {
        expect(loadShowViewed('/_/ws/diff/data')).toBe(false);
    });

    it('respects an explicit stored show/hide preference', () => {
        persistShowViewed('/_/ws/diff/data', true);
        expect(loadShowViewed('/_/ws/diff/data')).toBe(true);

        persistShowViewed('/_/ws/diff/data', false);
        expect(loadShowViewed('/_/ws/diff/data')).toBe(false);
    });
});
