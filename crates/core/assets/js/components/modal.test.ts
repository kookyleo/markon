import { afterEach, describe, expect, it, vi } from 'vitest';
import { BaseModal, ConfirmModal, ModalManager, NoteInputModal, showConfirmDialog } from './modal';

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
        document.body.innerHTML = '';
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

describe('ModalManager + showConfirmDialog', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('showConfirmDialog returns a ConfirmModal and tracks current', () => {
        const m = showConfirmDialog('hi', () => {});
        expect(m).toBeInstanceOf(ConfirmModal);
        expect(ModalManager.getCurrent()).toBe(m);
        ModalManager.closeCurrent();
        expect(ModalManager.getCurrent()).toBeNull();
    });
});
