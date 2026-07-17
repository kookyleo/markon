/**
 * Redeem a one-time administrator capability from the final page URL.
 *
 * This is a classic, parser-blocking bundle loaded at the start of every HTML
 * shell. When a bootstrap fragment is present it hides the unauthenticated
 * render before first paint, removes the secret from the address bar, exchanges
 * it for an HttpOnly cookie, then reloads the server-approved target in place.
 */

const BOOTSTRAP_NONCE_KEY = 'bootstrap_nonce';
const LEGACY_BOOTSTRAP_PATH = '/_/admin/bootstrap';
const LEGACY_NONCE_KEY = 'nonce';
const ADMIN_FALLBACK_PATH = '/_/admin';

type BootstrapLocation = Pick<Location, 'hash' | 'pathname' | 'search'>;

export interface AdminSessionBootstrapRuntime {
    location: BootstrapLocation;
    hideDocument: () => void;
    replaceUrl: (url: string) => void;
    reload: () => void;
    exchange: (nonce: string) => Promise<string>;
    openFallback: (url: string) => void;
}

export type AdminSessionBootstrapResult = 'inactive' | 'reloading' | 'fallback';

export function bootstrapNonce(location: BootstrapLocation): string | null {
    if (!location.hash.startsWith('#')) return null;
    const fragment = new URLSearchParams(location.hash.slice(1));
    const nonce = fragment.get(BOOTSTRAP_NONCE_KEY);
    if (nonce) return nonce;
    if (location.pathname === LEGACY_BOOTSTRAP_PATH) {
        return fragment.get(LEGACY_NONCE_KEY) || null;
    }
    return null;
}

function safeRedirect(value: unknown): string {
    if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) {
        throw new Error('invalid admin bootstrap redirect');
    }
    return value;
}

export async function exchangeAdminNonce(
    nonce: string,
    fetchImpl: typeof fetch = window.fetch.bind(window),
): Promise<string> {
    const response = await fetchImpl('/_/admin/session', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce }),
    });
    if (!response.ok) throw new Error(`admin bootstrap exchange failed: ${response.status}`);
    const result = await response.json() as { redirect?: unknown };
    return safeRedirect(result.redirect);
}

export async function runAdminSessionBootstrap(
    runtime: AdminSessionBootstrapRuntime,
): Promise<AdminSessionBootstrapResult> {
    const nonce = bootstrapNonce(runtime.location);
    if (!nonce) return 'inactive';

    runtime.hideDocument();
    // Remove the secret synchronously, before the exchange or any other page
    // script can copy the URL. The server-approved redirect is restored later.
    runtime.replaceUrl(`${runtime.location.pathname}${runtime.location.search}`);

    try {
        const redirect = await runtime.exchange(nonce);
        // replaceState + reload guarantees a real document request even when
        // the redirect only adds a heading fragment to the current URL.
        runtime.replaceUrl(redirect);
        runtime.reload();
        return 'reloading';
    } catch {
        runtime.openFallback(ADMIN_FALLBACK_PATH);
        return 'fallback';
    }
}

const root = document.documentElement;
void runAdminSessionBootstrap({
    location: window.location,
    hideDocument: () => {
        root.style.visibility = 'hidden';
    },
    replaceUrl: (url) => {
        window.history.replaceState(null, '', url);
    },
    reload: () => {
        window.location.reload();
    },
    exchange: (nonce) => exchangeAdminNonce(nonce),
    openFallback: (url) => {
        window.location.replace(url);
    },
});

export {};
