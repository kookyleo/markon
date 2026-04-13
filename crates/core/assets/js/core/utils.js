/**
 * Utility functions - simple and common utilities
 */
import { CONFIG } from './config.js';

// Platform detection
export class PlatformUtils {
    static isMac() {
        return navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    }

    static isNarrowScreen() {
        return window.innerWidth <= CONFIG.BREAKPOINTS.WIDE_SCREEN;
    }

    static isWideScreen() {
        return window.innerWidth > CONFIG.BREAKPOINTS.WIDE_SCREEN;
    }
}

// 防抖
export function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func(...args), wait);
    };
}

// Log
export class Logger {
    static #enabled = true;

    static enable() { Logger.#enabled = true; }
    static disable() { Logger.#enabled = false; }

    static log(category, message, ...args) {
        if (Logger.#enabled) console.log(`[${category}]`, message, ...args);
    }

    static warn(category, message, ...args) {
        if (Logger.#enabled) console.warn(`[${category}]`, message, ...args);
    }

    static error(category, message, ...args) {
        console.error(`[${category}]`, message, ...args);
    }
}
