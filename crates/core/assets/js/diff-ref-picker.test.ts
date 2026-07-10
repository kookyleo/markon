import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initCompareRefPicker } from './diff-ref-picker';

const option = (
    value: string,
    label: string,
    kind: 'worktree' | 'head' | 'branch',
    selected = false,
) => ({
    value,
    label,
    alias: '',
    kind,
    subject: kind === 'worktree' ? 'Uncommitted working-tree files' : 'Latest commit',
    detail: '',
    date: '',
    selected,
    disabled: false,
});

function mountPicker(): HTMLButtonElement {
    const data = {
        base: [option('HEAD', 'HEAD', 'head', true), option('main', 'main', 'branch')],
        compare: [option('worktree', 'Worktree', 'worktree', true), option('HEAD', 'HEAD', 'head')],
        baseValue: 'HEAD',
        compareValue: 'worktree',
    };
    document.body.innerHTML = `
        <main data-diff-shell data-current-diff-view="rendered"></main>
        <div data-compare-control data-compare-path-base="/_/ws/compare" data-compare-status-url="">
            <button type="button" data-compare-trigger aria-expanded="false">
                <span data-compare-base-label></span>
                <span data-compare-compare-label></span>
            </button>
            <div data-compare-quick></div>
            <script type="application/json" data-compare-picker>${JSON.stringify(data)}</script>
        </div>
    `;
    initCompareRefPicker();
    return document.querySelector<HTMLButtonElement>('[data-compare-trigger]')!;
}

describe('compare ref picker modal', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = '';
    });

    afterEach(() => {
        document.body.innerHTML = '';
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('uses the standard modal frame and standard close behavior', () => {
        const trigger = mountPicker();

        trigger.click();
        const modal = document.querySelector<HTMLElement>('.git-compare-panel');
        expect(modal).not.toBeNull();
        expect(modal?.classList.contains('markon-modal-frame')).toBe(true);
        expect(modal?.getAttribute('role')).toBe('dialog');
        expect(modal?.getAttribute('aria-modal')).toBe('true');
        expect(trigger.getAttribute('aria-expanded')).toBe('true');

        vi.runOnlyPendingTimers();
        expect(document.activeElement).toBe(modal?.querySelector('.git-compare-search'));

        document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
        }));
        expect(document.querySelector('.git-compare-panel')).toBeNull();
        expect(trigger.getAttribute('aria-expanded')).toBe('false');

        trigger.click();
        vi.runOnlyPendingTimers();
        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(document.querySelector('.git-compare-panel')).toBeNull();
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
    });
});
