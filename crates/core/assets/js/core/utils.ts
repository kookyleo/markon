/**
 * Utility functions - simple and common utilities
 */
import { CONFIG } from './config.js';

/** Generic callable signature used by `debounce`. */
type AnyFn = (...args: never[]) => unknown;

/** A debounced function: same signature as the input, plus a `cancel` method. */
export type Debounced<F extends AnyFn> = ((...args: Parameters<F>) => void) & {
    cancel(): void;
};

// Platform detection
export class PlatformUtils {
    static isMac(): boolean {
        return navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    }

    static isNarrowScreen(): boolean {
        return window.innerWidth <= CONFIG.BREAKPOINTS.WIDE_SCREEN;
    }

    static isWideScreen(): boolean {
        return window.innerWidth > CONFIG.BREAKPOINTS.WIDE_SCREEN;
    }
}

/**
 * Simple trailing-edge debounce. The returned function preserves the
 * argument types of `func`, and exposes `.cancel()` for callers that need
 * to abort a pending invocation (e.g. on unmount).
 */
export function debounce<F extends AnyFn>(func: F, wait: number): Debounced<F> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const debounced = ((...args: Parameters<F>): void => {
        if (timeout !== undefined) clearTimeout(timeout);
        timeout = setTimeout(() => {
            timeout = undefined;
            func(...(args as unknown as never[]));
        }, wait);
    }) as Debounced<F>;
    debounced.cancel = () => {
        if (timeout !== undefined) {
            clearTimeout(timeout);
            timeout = undefined;
        }
    };
    return debounced;
}

// Identifier generation. Prefers crypto.randomUUID (all modern browsers);
// falls back for non-HTTPS contexts where randomUUID is unavailable.
export const Ids = {
    uuid(): string {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
        return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
    },
    short(): string {
        return Math.random().toString(36).slice(2, 11);
    },
    /** Alias kept for callers that prefer the verb form. */
    generate(): string {
        return this.uuid();
    },
} as const;

// Log
export class Logger {
    static #enabled = true;

    static enable(): void { Logger.#enabled = true; }
    static disable(): void { Logger.#enabled = false; }

    static log(category: string, message: unknown, ...args: unknown[]): void {
        if (Logger.#enabled) console.log(`[${category}]`, message, ...args);
    }

    static warn(category: string, message: unknown, ...args: unknown[]): void {
        if (Logger.#enabled) console.warn(`[${category}]`, message, ...args);
    }

    static error(category: string, message: unknown, ...args: unknown[]): void {
        console.error(`[${category}]`, message, ...args);
    }
}
