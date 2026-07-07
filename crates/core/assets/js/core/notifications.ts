/**
 * Page-level notifications.
 *
 * Use this module for non-blocking page/system feedback that is not tied to a
 * specific button and does not require a decision. Button-local feedback should
 * stay local to the control; decisions should use modal/confirm dialogs.
 */

export type NotificationVariant = 'info' | 'success' | 'warning' | 'danger';

export interface NotificationOptions {
    /** Auto-dismiss delay in ms. Use 0 for a persistent notification. */
    duration?: number;
    /** Visual tone. Defaults to neutral/info. */
    variant?: NotificationVariant;
    /** Optional short heading. */
    title?: string;
    /** Whether to show a close button. Defaults to true. */
    dismissible?: boolean;
}

export interface NotificationHandle {
    element: HTMLElement;
    dismiss: () => void;
}

const _t: (key: string, ...args: unknown[]) => string =
    (window.__MARKON_I18N__?.t) || ((k: string) => k);

const DEFAULT_DURATION = 6500;
const EXIT_DURATION = 260;

const ensureStack = (): HTMLElement => {
    let stack = document.querySelector<HTMLElement>('.markon-notification-stack');
    if (stack) return stack;

    stack = document.createElement('div');
    stack.className = 'markon-notification-stack';
    stack.setAttribute('aria-live', 'polite');
    stack.setAttribute('aria-atomic', 'false');
    document.body.appendChild(stack);
    return stack;
};

const removeStackIfEmpty = (): void => {
    const stack = document.querySelector<HTMLElement>('.markon-notification-stack');
    if (stack && stack.children.length === 0) {
        stack.remove();
    }
};

export function showNotification(message: string, options: NotificationOptions = {}): NotificationHandle | null {
    const text = message.trim();
    if (!text) return null;

    const notification = document.createElement('div');
    notification.className = `markon-notification markon-modal-frame is-${options.variant ?? 'info'}`;
    notification.setAttribute('role', 'status');

    const content = document.createElement('div');
    content.className = 'markon-notification-content';

    const dot = document.createElement('span');
    dot.className = 'markon-notification-dot';
    dot.setAttribute('aria-hidden', 'true');

    const body = document.createElement('div');
    body.className = 'markon-notification-body';

    const title = options.title?.trim();
    if (title) {
        const titleEl = document.createElement('div');
        titleEl.className = 'markon-notification-title';
        titleEl.textContent = title;
        body.appendChild(titleEl);
    }

    const messageEl = document.createElement('div');
    messageEl.className = 'markon-notification-message';
    messageEl.textContent = text;
    body.appendChild(messageEl);

    content.append(dot, body);

    const dismissible = options.dismissible ?? true;
    if (dismissible) {
        const close = document.createElement('button');
        close.className = 'markon-notification-close';
        close.type = 'button';
        close.setAttribute('aria-label', _t('web.notification.dismiss'));
        close.textContent = '×';
        content.appendChild(close);
        close.addEventListener('click', () => dismiss());
    }

    notification.appendChild(content);
    ensureStack().appendChild(notification);

    let dismissed = false;
    let dismissTimer: number | null = null;
    const dismiss = (): void => {
        if (dismissed) return;
        dismissed = true;
        if (dismissTimer !== null) {
            window.clearTimeout(dismissTimer);
        }

        notification.style.maxHeight = `${notification.offsetHeight}px`;
        requestAnimationFrame(() => {
            notification.classList.remove('is-visible');
            notification.classList.add('is-leaving');
            notification.style.maxHeight = '0px';
        });

        window.setTimeout(() => {
            notification.remove();
            removeStackIfEmpty();
        }, EXIT_DURATION);
    };

    requestAnimationFrame(() => {
        notification.style.maxHeight = `${notification.scrollHeight}px`;
        notification.classList.add('is-visible');
    });

    const duration = options.duration ?? DEFAULT_DURATION;
    if (duration > 0) {
        dismissTimer = window.setTimeout(dismiss, duration);
    }

    return { element: notification, dismiss };
}
