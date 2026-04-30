import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOCNavigator } from './toc-navigator';

interface TocEntry {
    level: number;
    label: string;
}

function buildToc(entries: TocEntry[]): HTMLElement {
    const container = document.createElement('div');
    container.id = 'toc-container';
    const ul = document.createElement('ul');
    container.appendChild(ul);
    for (const e of entries) {
        const li = document.createElement('li');
        li.className = `toc-item toc-level-${e.level}`;
        const a = document.createElement('a');
        a.href = `#${e.label}`;
        a.textContent = e.label;
        li.appendChild(a);
        ul.appendChild(li);
    }
    document.body.appendChild(container);
    return container;
}

function fireKey(key: string): void {
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
}

function focusedLabel(container: HTMLElement): string | null {
    const a = container.querySelector('a.toc-focused');
    if (!a) return null;
    // The navigator may prepend a `.toc-collapse-indicator` span — exclude it.
    let label = '';
    a.childNodes.forEach((n) => {
        if (n.nodeType === Node.ELEMENT_NODE && (n as Element).classList.contains('toc-collapse-indicator')) return;
        label += n.textContent ?? '';
    });
    return label.trim();
}

describe('TOCNavigator', () => {
    let container: HTMLElement;
    let nav: TOCNavigator;

    beforeEach(() => {
        // jsdom does not implement scrollIntoView.
        Element.prototype.scrollIntoView = vi.fn();
        container = buildToc([
            { level: 1, label: 'A' },
            { level: 2, label: 'A.1' },
            { level: 2, label: 'A.2' },
            { level: 1, label: 'B' },
        ]);
        nav = new TOCNavigator();
    });

    afterEach(() => {
        nav.deactivate();
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    it('activate sets first link as focused and active flag is true', () => {
        nav.activate();
        expect(nav.active).toBe(true);
        expect(focusedLabel(container)).toBe('A');
    });

    it('j moves to next visible link, k moves back', () => {
        nav.activate();
        fireKey('j');
        expect(focusedLabel(container)).toBe('A.1');
        fireKey('j');
        expect(focusedLabel(container)).toBe('A.2');
        fireKey('k');
        expect(focusedLabel(container)).toBe('A.1');
    });

    it('ArrowLeft on a parent collapses children; ArrowRight expands', () => {
        nav.activate();
        // focus is on 'A' (level 1) which has children — ArrowLeft collapses.
        fireKey('ArrowLeft');
        const liA1 = container.querySelectorAll('li')[1] as HTMLElement;
        const liA2 = container.querySelectorAll('li')[2] as HTMLElement;
        expect(liA1.style.display).toBe('none');
        expect(liA2.style.display).toBe('none');

        // ArrowRight on collapsed node expands it again.
        fireKey('ArrowRight');
        expect(liA1.style.display).toBe('');
        expect(liA2.style.display).toBe('');
    });

    it('deactivate clears focus and removes the active class', () => {
        nav.activate();
        expect(container.classList.contains('toc-nav-active')).toBe(true);
        nav.deactivate();
        expect(nav.active).toBe(false);
        expect(focusedLabel(container)).toBeNull();
        expect(container.classList.contains('toc-nav-active')).toBe(false);
    });

    it('Escape closes the navigator', () => {
        nav.activate();
        fireKey('Escape');
        expect(nav.active).toBe(false);
    });
});
