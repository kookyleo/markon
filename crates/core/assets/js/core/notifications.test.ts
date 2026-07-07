import { afterEach, describe, expect, it, vi } from 'vitest';
import { showNotification } from './notifications';

describe('notifications', () => {
    afterEach(() => {
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    it('does not create a notification for an empty message', () => {
        const handle = showNotification('   ');

        expect(handle).toBeNull();
        expect(document.querySelector('.markon-notification-stack')).toBeNull();
    });

    it('renders page notifications in a shared top-right stack', () => {
        const first = showNotification('First message', { title: 'Markon', variant: 'success', duration: 0 });
        const second = showNotification('Second message', { variant: 'warning', duration: 0 });

        const stack = document.querySelector('.markon-notification-stack');
        const items = document.querySelectorAll('.markon-notification');

        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        expect(stack).not.toBeNull();
        expect(items).toHaveLength(2);
        expect(items[0]?.textContent).toContain('First message');
        expect(items[0]?.textContent).toContain('Markon');
        expect(items[0]?.classList.contains('is-success')).toBe(true);
        expect(items[1]?.classList.contains('is-warning')).toBe(true);
    });

    it('dismisses a notification and removes the stack when empty', () => {
        vi.useFakeTimers();
        const handle = showNotification('Dismiss me', { duration: 0 });
        expect(document.querySelectorAll('.markon-notification')).toHaveLength(1);

        handle?.dismiss();
        vi.advanceTimersByTime(300);

        expect(document.querySelector('.markon-notification')).toBeNull();
        expect(document.querySelector('.markon-notification-stack')).toBeNull();
    });

    it('auto-dismisses after the configured duration', () => {
        vi.useFakeTimers();
        showNotification('Auto dismiss', { duration: 100 });

        expect(document.querySelectorAll('.markon-notification')).toHaveLength(1);
        vi.advanceTimersByTime(100);
        vi.advanceTimersByTime(300);

        expect(document.querySelector('.markon-notification')).toBeNull();
    });
});
