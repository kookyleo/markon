// Global type augmentations.
// Concrete types are imported from each owning module so we can drop the
// historic `unknown` placeholders and let TS check call sites end-to-end.

import type { MarkonApp } from '../main';
import type { ChatManager } from '../managers/chat-manager';
import type { EditorManager } from '../managers/editor-manager';
import type { UndoManager } from '../managers/undo-manager';
import type { TOCNavigator } from '../navigators/toc-navigator';
import type { AnnotationNavigator } from '../navigators/annotation-navigator';
import type { KeyboardShortcutsManager } from '../managers/keyboard-shortcuts';
import type { SearchManager } from '../managers/search-manager';
import type { SectionViewedManager } from '../viewed';

export {};

declare global {
  /**
   * `__DEV__` is replaced inline by esbuild's `define`:
   *   - `true`  in watch builds (npm run dev)
   *   - `false` in release builds — dead-code-eliminated
   * Used to gate the live-reload EventSource listener in main.ts.
   */
  const __DEV__: boolean;

  interface Window {
    markonApp?: MarkonApp;
    chatManager?: ChatManager;
    editorManager?: EditorManager;
    viewedManager?: SectionViewedManager;
    undoManager?: UndoManager;
    tocNavigator?: TOCNavigator;
    annotationNavigator?: AnnotationNavigator;
    shortcutsManager?: KeyboardShortcutsManager;
    searchManager?: SearchManager;
    isSharedAnnotationMode?: boolean;
    openEditorAtLine?: (line: number) => void;
    clearPageAnnotations?: (event?: Event) => void;

    /** Native WebSocket assigned by main.ts after the ws-manager connects. */
    ws?: WebSocket;

    __MARKON_I18N__?: { t: (key: string, ...args: unknown[]) => string };
    __MARKON_SHORTCUTS__?: Record<string, Partial<Record<string, unknown>>>;

    __markonTocSetSelected?: (id: string) => void;

    mermaid?: {
      run?: (opts: { nodes: NodeListOf<Element> }) => Promise<void> | void;
      init?: (config: undefined, nodes: NodeListOf<Element>) => void;
      initialize: (config: Record<string, unknown>) => void;
    };
    marked?: { parse: (src: string) => string };
  }
}
