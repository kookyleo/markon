import { describe, expect, it, vi } from 'vitest';
import {
    bootstrapNonce,
    exchangeAdminNonce,
    runAdminSessionBootstrap,
    type AdminSessionBootstrapRuntime,
} from './admin-session-boot';

function runtime(
    location: AdminSessionBootstrapRuntime['location'],
    exchange: AdminSessionBootstrapRuntime['exchange'] = vi.fn(async () => '/workspace/file.md'),
): AdminSessionBootstrapRuntime {
    return {
        location,
        hideDocument: vi.fn(),
        replaceUrl: vi.fn(),
        reload: vi.fn(),
        exchange,
        openFallback: vi.fn(),
    };
}

describe('admin session bootstrap', () => {
    it('only recognizes the dedicated fragment key on normal pages', () => {
        expect(bootstrapNonce({
            pathname: '/workspace/file.md',
            search: '',
            hash: '#bootstrap_nonce=abc123',
        })).toBe('abc123');
        expect(bootstrapNonce({
            pathname: '/workspace/file.md',
            search: '',
            hash: '#nonce=document-anchor',
        })).toBeNull();
        expect(bootstrapNonce({
            pathname: '/workspace/file.md',
            search: '',
            hash: '#heading',
        })).toBeNull();
    });

    it('accepts old bootstrap links only on the compatibility route', () => {
        expect(bootstrapNonce({
            pathname: '/_/admin/bootstrap',
            search: '',
            hash: '#nonce=legacy',
        })).toBe('legacy');
        expect(bootstrapNonce({
            pathname: '/_/admin',
            search: '',
            hash: '#nonce=legacy',
        })).toBeNull();
    });

    it('hides and clears the first render before exchanging, then reloads the approved target', async () => {
        const calls: string[] = [];
        const testRuntime = runtime(
            {
                pathname: '/workspace/file.md',
                search: '?mode=preview',
                hash: '#bootstrap_nonce=secret',
            },
            vi.fn(async (nonce: string) => {
                calls.push(`exchange:${nonce}`);
                return '/workspace/file.md?mode=preview#section';
            }),
        );
        testRuntime.hideDocument = vi.fn(() => calls.push('hide'));
        testRuntime.replaceUrl = vi.fn((url: string) => calls.push(`replace:${url}`));
        testRuntime.reload = vi.fn(() => calls.push('reload'));

        await expect(runAdminSessionBootstrap(testRuntime)).resolves.toBe('reloading');
        expect(calls).toEqual([
            'hide',
            'replace:/workspace/file.md?mode=preview',
            'exchange:secret',
            'replace:/workspace/file.md?mode=preview#section',
            'reload',
        ]);
        expect(testRuntime.openFallback).not.toHaveBeenCalled();
    });

    it('does nothing without a bootstrap fragment', async () => {
        const testRuntime = runtime({
            pathname: '/workspace/file.md',
            search: '',
            hash: '#heading',
        });

        await expect(runAdminSessionBootstrap(testRuntime)).resolves.toBe('inactive');
        expect(testRuntime.hideDocument).not.toHaveBeenCalled();
        expect(testRuntime.exchange).not.toHaveBeenCalled();
        expect(testRuntime.reload).not.toHaveBeenCalled();
    });

    it('opens the manual administrator fallback when exchange fails', async () => {
        const testRuntime = runtime(
            {
                pathname: '/workspace/file.md',
                search: '',
                hash: '#bootstrap_nonce=expired',
            },
            vi.fn(async () => {
                throw new Error('expired');
            }),
        );

        await expect(runAdminSessionBootstrap(testRuntime)).resolves.toBe('fallback');
        expect(testRuntime.openFallback).toHaveBeenCalledWith('/_/admin');
        expect(testRuntime.reload).not.toHaveBeenCalled();
    });

    it('posts the nonce and rejects an unsafe redirect', async () => {
        const fetchMock = vi.fn(async () => new Response(
            JSON.stringify({ redirect: '//evil.example/' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));

        await expect(exchangeAdminNonce('secret', fetchMock)).rejects.toThrow(
            'invalid admin bootstrap redirect',
        );
        expect(fetchMock).toHaveBeenCalledWith('/_/admin/session', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nonce: 'secret' }),
        });
    });
});
