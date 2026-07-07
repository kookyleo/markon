import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../core/config';
import { BaseModal, ConfirmModal, NoteInputModal, showConfirmDialog } from './modal';

class TestModal extends BaseModal {
    public createCalls = 0;
    constructor(opts: { className?: string; closeOnEscape?: boolean; closeOnOutsideClick?: boolean } = {}) {
        super({ className: 'test-modal', ...opts });
    }
    create(): HTMLElement {
        this.createCalls++;
        const el = document.createElement('div');
        el.className = 'test-modal';
        el.innerHTML = '<button class="primary">Hi</button>';
        return el;
    }
}

describe('BaseModal', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('show() appends element to DOM, close() removes it', () => {
        const m = new TestModal();
        m.show();
        expect(document.querySelector('.test-modal')).not.toBeNull();
        expect(m.getElement()).not.toBeNull();
        m.close();
        expect(document.querySelector('.test-modal')).toBeNull();
        expect(m.getElement()).toBeNull();
    });

    it('Escape key closes modal when closeOnEscape is true', () => {
        const m = new TestModal();
        m.show();
        const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        document.dispatchEvent(ev);
        expect(document.querySelector('.test-modal')).toBeNull();
    });

    it('outside click closes modal (click on body, not on modal)', async () => {
        const m = new TestModal();
        m.show();
        // The outside-click listener is attached via setTimeout(..., 0), wait one tick.
        await new Promise((r) => setTimeout(r, 5));

        const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'target', { value: document.body });
        document.dispatchEvent(ev);
        expect(document.querySelector('.test-modal')).toBeNull();
    });

    it('clicking inside the modal does NOT close it', async () => {
        const m = new TestModal();
        m.show();
        await new Promise((r) => setTimeout(r, 5));

        const inside = m.getElement()!.querySelector('.primary')!;
        const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'target', { value: inside });
        document.dispatchEvent(ev);
        expect(document.querySelector('.test-modal')).not.toBeNull();
    });
});

describe('NoteInputModal', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        document.body.innerHTML = '';
        localStorage.clear();
    });

    it('Save button is disabled until textarea has content', () => {
        const onSave = vi.fn();
        const m = new NoteInputModal({ onSave });
        m.show();
        const textarea = m.getElement()!.querySelector('.note-textarea') as HTMLTextAreaElement;
        const saveBtn = m.getElement()!.querySelector('.note-save') as HTMLButtonElement;
        expect(saveBtn.disabled).toBe(true);

        textarea.value = 'hello';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        expect(saveBtn.disabled).toBe(false);

        saveBtn.click();
        expect(onSave).toHaveBeenCalledWith('hello');
    });

    it('Cancel button calls onCancel and closes', () => {
        const onCancel = vi.fn();
        const m = new NoteInputModal({ onCancel });
        m.show();
        const cancelBtn = m.getElement()!.querySelector('.note-cancel') as HTMLButtonElement;
        cancelBtn.click();
        expect(onCancel).toHaveBeenCalled();
        expect(document.querySelector('.note-input-modal')).toBeNull();
    });

    it('renders compact icon actions inside the note input field', () => {
        const m = new NoteInputModal();
        m.show();

        const field = m.getElement()!.querySelector('.note-input-field');
        const cancelBtn = m.getElement()!.querySelector('.note-cancel') as HTMLButtonElement;
        const saveBtn = m.getElement()!.querySelector('.note-save') as HTMLButtonElement;

        expect(field).not.toBeNull();
        expect(field?.contains(cancelBtn)).toBe(true);
        expect(field?.contains(saveBtn)).toBe(true);
        expect(cancelBtn.querySelector('svg path')?.getAttribute('d')).toBe('M6 6l12 12M18 6L6 18');
        expect(saveBtn.querySelector('svg path')?.getAttribute('d')).toBe('M12 19V5M6.5 10.5 12 5l5.5 5.5');
    });

    it('renders edge drag regions around the compact note input', () => {
        const m = new NoteInputModal();
        m.show();

        const modal = m.getElement()!;
        const dragRegions = modal.querySelectorAll('.note-input-drag-region');

        expect(dragRegions).toHaveLength(4);
        expect(modal.querySelector('.note-input-drag-top')).not.toBeNull();
        expect(modal.querySelector('.note-input-drag-right')).not.toBeNull();
        expect(modal.querySelector('.note-input-drag-bottom')).not.toBeNull();
        expect(modal.querySelector('.note-input-drag-left')).not.toBeNull();
    });

    it('restores anchor-relative drag offset', () => {
        const anchor = document.createElement('span');
        Object.defineProperty(anchor, 'getBoundingClientRect', {
            value: () => ({
                left: 100,
                top: 200,
                right: 120,
                bottom: 220,
                width: 20,
                height: 20,
                x: 100,
                y: 200,
                toJSON: () => ({}),
            }),
        });
        document.body.appendChild(anchor);
        localStorage.setItem(CONFIG.STORAGE_KEYS.NOTE_INPUT_OFFSET, JSON.stringify({ dx: 15, dy: -5 }));

        const m = new NoteInputModal();
        m.show(anchor);

        expect(m.getElement()!.style.left).toBe('115px');
        expect(m.getElement()!.style.top).toBe('220px');
    });

    it('restores saved note input size', () => {
        localStorage.setItem(CONFIG.STORAGE_KEYS.NOTE_INPUT_SIZE, JSON.stringify({ width: 420, height: 148 }));

        const m = new NoteInputModal();
        m.show();

        expect(m.getElement()!.style.width).toBe('420px');
        expect(m.getElement()!.style.height).toBe('148px');
    });

    it('persists manually resized note input size', () => {
        vi.useFakeTimers();
        let triggerObserver = (): void => {};
        class ResizeObserverMock {
            #callback: ResizeObserverCallback;
            constructor(callback: ResizeObserverCallback) {
                this.#callback = callback;
                triggerObserver = () => this.#callback([], this as unknown as ResizeObserver);
            }
            observe(): void {}
            disconnect(): void {}
        }
        vi.stubGlobal('ResizeObserver', ResizeObserverMock);

        const m = new NoteInputModal();
        m.show();
        const modal = m.getElement()!;
        Object.defineProperty(modal, 'offsetWidth', { value: 410, configurable: true });
        Object.defineProperty(modal, 'offsetHeight', { value: 142, configurable: true });

        vi.advanceTimersByTime(0);
        triggerObserver();

        expect(JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.NOTE_INPUT_SIZE) || 'null')).toEqual({
            width: 410,
            height: 142,
        });
    });
});

describe('ConfirmModal', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('OK button awaits onConfirm then closes', async () => {
        const onConfirm = vi.fn().mockResolvedValue(undefined);
        const m = new ConfirmModal({ message: 'Are you sure?', onConfirm });
        m.show();
        const okBtn = m.getElement()!.querySelector('.confirm-ok') as HTMLButtonElement;
        okBtn.click();
        await new Promise((r) => setTimeout(r, 0));
        expect(onConfirm).toHaveBeenCalled();
        expect(document.querySelector('.confirm-dialog')).toBeNull();
    });
});

describe('showConfirmDialog', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('showConfirmDialog returns a ConfirmModal', () => {
        const m = showConfirmDialog('hi', () => {});
        expect(m).toBeInstanceOf(ConfirmModal);
    });
});
