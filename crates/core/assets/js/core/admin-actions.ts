const t = (key: string): string => window.__MARKON_I18N__?.t(key) ?? key;

export class AdminSessionExpiredError extends Error {
    constructor() {
        super('Administrator session expired');
        this.name = 'AdminSessionExpiredError';
    }
}

/** Convert a rejected administrator action into a clear alert. */
export function requireActiveAdminSession(response: Response): Response {
    if (response.status !== 403) return response;

    window.alert(`${t('web.admin.session_expired.title')}\n\n${t('web.admin.session_expired')}`);
    throw new AdminSessionExpiredError();
}

export function isAdminSessionExpiredError(error: unknown): error is AdminSessionExpiredError {
    return error instanceof AdminSessionExpiredError;
}

/** Show an administrator-action failure without duplicating expiry feedback. */
export function showAdminActionError(error: unknown, fallback: string): void {
    if (isAdminSessionExpiredError(error)) return;
    const message = error instanceof Error && error.message ? error.message : fallback;
    window.alert(message);
}
