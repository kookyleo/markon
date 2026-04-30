import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlatformUtils, debounce, Ids, Logger } from './utils.js';

describe('debounce', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('delays invocation until wait elapses', () => {
        const fn = vi.fn();
        const d = debounce(fn, 100);
        d();
        expect(fn).not.toHaveBeenCalled();
        vi.advanceTimersByTime(99);
        expect(fn).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('coalesces rapid calls into a single trailing invocation', () => {
        const fn = vi.fn();
        const d = debounce(fn, 50);
        d('a');
        d('b');
        d('c');
        vi.advanceTimersByTime(50);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenCalledWith('c');
    });

    it('forwards typed arguments', () => {
        const fn = vi.fn((_a: number, _b: string) => undefined);
        const d = debounce(fn, 10);
        d(7, 'hi');
        vi.advanceTimersByTime(10);
        expect(fn).toHaveBeenCalledWith(7, 'hi');
    });

    it('cancel() aborts a pending call', () => {
        const fn = vi.fn();
        const d = debounce(fn, 100);
        d();
        d.cancel();
        vi.advanceTimersByTime(500);
        expect(fn).not.toHaveBeenCalled();
    });
});

describe('Ids', () => {
    it('uuid returns a non-empty string', () => {
        const id = Ids.uuid();
        expect(typeof id).toBe('string');
        expect(id.length).toBeGreaterThan(0);
    });

    it('two consecutive uuids differ', () => {
        expect(Ids.uuid()).not.toBe(Ids.uuid());
    });

    it('generate aliases uuid', () => {
        const id = Ids.generate();
        expect(typeof id).toBe('string');
        expect(id.length).toBeGreaterThan(0);
    });

    it('short returns a short string and is usually distinct across calls', () => {
        const a = Ids.short();
        const b = Ids.short();
        expect(typeof a).toBe('string');
        expect(a.length).toBeGreaterThan(0);
        expect(a.length).toBeLessThanOrEqual(9);
        expect(a).not.toBe(b);
    });
});

describe('PlatformUtils.isMac', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it('returns true for MacIntel platform', () => {
        Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
        expect(PlatformUtils.isMac()).toBe(true);
    });

    it('returns false for Win32 platform', () => {
        Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
        expect(PlatformUtils.isMac()).toBe(false);
    });
});

describe('Logger', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        Logger.enable();
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
        Logger.enable();
    });

    it('log() prefixes with [category]', () => {
        Logger.log('Cat', 'hello', 1, 2);
        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(logSpy).toHaveBeenCalledWith('[Cat]', 'hello', 1, 2);
    });

    it('warn() prefixes with [category]', () => {
        Logger.warn('Cat', 'msg');
        expect(warnSpy).toHaveBeenCalledWith('[Cat]', 'msg');
    });

    it('disable() suppresses log/warn but error still goes through', () => {
        Logger.disable();
        Logger.log('Cat', 'hidden');
        Logger.warn('Cat', 'hidden');
        Logger.error('Cat', 'shown');
        expect(logSpy).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledWith('[Cat]', 'shown');
    });
});
