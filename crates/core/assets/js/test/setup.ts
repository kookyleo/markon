function createMemoryStorage(): Storage {
    const items = new Map<string, string>();

    return {
        get length(): number {
            return items.size;
        },
        clear(): void {
            items.clear();
        },
        getItem(key: string): string | null {
            return items.get(String(key)) ?? null;
        },
        key(index: number): string | null {
            return Array.from(items.keys())[index] ?? null;
        },
        removeItem(key: string): void {
            items.delete(String(key));
        },
        setItem(key: string, value: string): void {
            items.set(String(key), String(value));
        },
    };
}

function hasUsableStorage(value: unknown): value is Storage {
    return Boolean(
        value
            && typeof (value as Storage).getItem === 'function'
            && typeof (value as Storage).setItem === 'function'
            && typeof (value as Storage).removeItem === 'function'
            && typeof (value as Storage).clear === 'function',
    );
}

function installStorage(name: 'localStorage' | 'sessionStorage'): void {
    const current = globalThis[name];
    if (hasUsableStorage(current)) return;

    const storage = createMemoryStorage();
    Object.defineProperty(globalThis, name, {
        configurable: true,
        value: storage,
        writable: true,
    });
    if (typeof window !== 'undefined') {
        Object.defineProperty(window, name, {
            configurable: true,
            value: storage,
            writable: true,
        });
    }
}

installStorage('localStorage');
installStorage('sessionStorage');
