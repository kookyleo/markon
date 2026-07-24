import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    AdminSessionExpiredError,
    requireActiveAdminSession,
    showAdminActionError,
} from './admin-actions';

describe('administrator actions', () => {
    afterEach(() => {
        document.body.innerHTML = '';
        delete window.__MARKON_I18N__;
        vi.restoreAllMocks();
    });

    it('turns a 403 into a session-expired alert', () => {
        window.__MARKON_I18N__ = { t: (key: string) => `translated:${key}` };
        const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});

        expect(() => requireActiveAdminSession({ status: 403 } as Response))
            .toThrow(AdminSessionExpiredError);

        expect(alert).toHaveBeenCalledWith(
            'translated:web.admin.session_expired.title\n\ntranslated:web.admin.session_expired',
        );
    });

    it('passes through non-403 responses', () => {
        const response = { status: 409 } as Response;
        expect(requireActiveAdminSession(response)).toBe(response);
    });

    it('does not duplicate the session-expired alert in a catch handler', () => {
        const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
        try {
            requireActiveAdminSession({ status: 403 } as Response);
        } catch (error) {
            showAdminActionError(error, 'Fallback');
        }

        expect(alert).toHaveBeenCalledTimes(1);
    });

    it('keeps ordinary administrator-action failures in a native alert', () => {
        const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
        showAdminActionError(new Error('Delete failed'), 'Fallback');

        expect(alert).toHaveBeenCalledWith('Delete failed');
    });
});
