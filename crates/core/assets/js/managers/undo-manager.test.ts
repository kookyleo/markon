import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UndoManager } from './undo-manager.js';

describe('UndoManager', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });
    afterEach(() => { logSpy.mockRestore(); });

    it('push + undo behaves LIFO and stamps a timestamp', () => {
        const m = new UndoManager(10);
        m.push({ type: 'create', payload: 1 });
        m.push({ type: 'delete', payload: 2 });
        expect(m.canUndo()).toBe(true);
        expect(m.canRedo()).toBe(false);

        const last = m.undo();
        expect(last).not.toBeNull();
        expect(last?.type).toBe('delete');
        expect(last?.payload).toBe(2);
        expect(typeof last?.timestamp).toBe('number');

        const first = m.undo();
        expect(first?.type).toBe('create');
        expect(m.canUndo()).toBe(false);
        expect(m.undo()).toBeNull();
    });

    it('redo replays the last undone op', () => {
        const m = new UndoManager();
        m.push({ type: 'edit', value: 'a' });
        m.undo();
        expect(m.canRedo()).toBe(true);
        const redone = m.redo();
        expect(redone?.type).toBe('edit');
        expect(redone?.value).toBe('a');
        expect(m.canRedo()).toBe(false);
        expect(m.canUndo()).toBe(true);
    });

    it('a fresh push clears the redo stack', () => {
        const m = new UndoManager();
        m.push({ type: 'a' });
        m.undo();
        expect(m.canRedo()).toBe(true);
        m.push({ type: 'b' });
        expect(m.canRedo()).toBe(false);
    });

    it('respects the max stack size by dropping the oldest entry', () => {
        const m = new UndoManager(3);
        m.push({ type: 'op', n: 1 });
        m.push({ type: 'op', n: 2 });
        m.push({ type: 'op', n: 3 });
        m.push({ type: 'op', n: 4 });
        expect(m.getUndoStackSize()).toBe(3);

        // Oldest (n=1) should be gone; newest (n=4) at the top.
        const top = m.undo();
        expect(top?.n).toBe(4);
        const next = m.undo();
        expect(next?.n).toBe(3);
        const last = m.undo();
        expect(last?.n).toBe(2);
        expect(m.undo()).toBeNull();
    });

    it('clear() empties both stacks', () => {
        const m = new UndoManager();
        m.push({ type: 'a' });
        m.push({ type: 'b' });
        m.undo();
        expect(m.getUndoStackSize()).toBe(1);
        expect(m.getRedoStackSize()).toBe(1);
        m.clear();
        expect(m.canUndo()).toBe(false);
        expect(m.canRedo()).toBe(false);
        expect(m.getUndoStackSize()).toBe(0);
        expect(m.getRedoStackSize()).toBe(0);
    });
});
