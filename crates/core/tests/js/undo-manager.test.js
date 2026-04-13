import { describe, it, expect, beforeEach } from 'vitest';

// UndoManager imports CONFIG which reads window.__MARKON_I18N__ — set up globals
globalThis.window = globalThis.window || globalThis;
window.__MARKON_I18N__ = { t: (k) => k };
window.__MARKON_SHORTCUTS__ = undefined;

const { UndoManager } = await import('../../assets/js/managers/undo-manager.js');

describe('UndoManager', () => {
  let mgr;

  beforeEach(() => {
    mgr = new UndoManager(5);
  });

  it('starts empty', () => {
    expect(mgr.canUndo()).toBe(false);
    expect(mgr.canRedo()).toBe(false);
    expect(mgr.getUndoStackSize()).toBe(0);
    expect(mgr.getRedoStackSize()).toBe(0);
  });

  it('push makes canUndo true', () => {
    mgr.push({ type: 'add', data: 'a' });
    expect(mgr.canUndo()).toBe(true);
    expect(mgr.canRedo()).toBe(false);
    expect(mgr.getUndoStackSize()).toBe(1);
  });

  it('undo returns the pushed operation', () => {
    mgr.push({ type: 'add', data: 'a' });
    const op = mgr.undo();
    expect(op.type).toBe('add');
    expect(op.data).toBe('a');
    expect(op.timestamp).toBeTypeOf('number');
  });

  it('undo on empty returns null', () => {
    expect(mgr.undo()).toBeNull();
  });

  it('redo on empty returns null', () => {
    expect(mgr.redo()).toBeNull();
  });

  it('undo then redo round-trips', () => {
    mgr.push({ type: 'del', data: 'x' });
    mgr.undo();
    expect(mgr.canRedo()).toBe(true);
    const op = mgr.redo();
    expect(op.type).toBe('del');
    expect(mgr.canUndo()).toBe(true);
    expect(mgr.canRedo()).toBe(false);
  });

  it('push clears redo stack', () => {
    mgr.push({ type: 'a', data: 1 });
    mgr.undo();
    expect(mgr.canRedo()).toBe(true);
    mgr.push({ type: 'b', data: 2 });
    expect(mgr.canRedo()).toBe(false);
  });

  it('respects max stack size', () => {
    for (let i = 0; i < 10; i++) {
      mgr.push({ type: 'op', data: i });
    }
    expect(mgr.getUndoStackSize()).toBe(5);
    // Oldest items are dropped, newest is the last pushed
    const op = mgr.undo();
    expect(op.data).toBe(9);
  });

  it('clear empties both stacks', () => {
    mgr.push({ type: 'a', data: 1 });
    mgr.push({ type: 'b', data: 2 });
    mgr.undo();
    mgr.clear();
    expect(mgr.canUndo()).toBe(false);
    expect(mgr.canRedo()).toBe(false);
    expect(mgr.getUndoStackSize()).toBe(0);
    expect(mgr.getRedoStackSize()).toBe(0);
  });

  it('multiple undo/redo cycle', () => {
    mgr.push({ type: 'a', data: 1 });
    mgr.push({ type: 'b', data: 2 });
    mgr.push({ type: 'c', data: 3 });

    expect(mgr.undo().data).toBe(3);
    expect(mgr.undo().data).toBe(2);
    expect(mgr.redo().data).toBe(2);
    expect(mgr.redo().data).toBe(3);
    expect(mgr.canRedo()).toBe(false);
  });
});
