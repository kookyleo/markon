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
import type { WorkspaceSpotlight } from '../components/workspace-spotlight';
import type { VisualZoomManager } from '../managers/visual-zoom-manager';
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
    workspaceSpotlight?: WorkspaceSpotlight;
    visualZoomManager?: VisualZoomManager;
    markonSourceDiff?: {
      load: () => void;
      scrollToPath: (path: string) => void;
      selectPath: (path?: string | null) => void;
      topAnchor: () => { path: string; line: number | null } | null;
      anchorTo: (anchor: { path: string; line: number | null } | null) => void;
      /** Switch the Raw view between two-column 'split' and single-column
       *  'unified' layouts, preserving scroll position. */
      setLayout: (mode: 'split' | 'unified') => void;
    };
    markonMarkdownDiff?: {
      load: () => void;
      selectPath: (path?: string | null) => void;
      scrollToPath: (path: string) => void;
      topAnchor: () => { path: string; line: number | null } | null;
      anchorTo: (anchor: { path: string; line: number | null } | null) => void;
    };
    /** Rendered-diff annotation coordinator (diff-annotations.ts). Present only
     *  on the compare page when annotations are active (worktree diff). The
     *  rendered view calls these as file bodies (re)render. */
    markonDiffAnnotations?: {
      onBodyRendered: (body: HTMLElement) => void;
      onContentRendered: () => void;
      exportNotes: (anchor?: HTMLElement | null) => Promise<boolean>;
      notesCount: () => Promise<number>;
    };
    isSharedAnnotationMode?: boolean;
    openEditorAtLine?: (line: number) => void;
    clearPageAnnotations?: (event?: Event) => void;
    markonExportNotes?: (anchor?: HTMLElement | null, headingId?: string | null) => void;
    markonNotesCount?: (headingId?: string | null) => number;

    /** Native WebSocket assigned by main.ts after the ws-manager connects. */
    ws?: WebSocket;

    __MARKON_I18N__?: { t: (key: string, ...args: unknown[]) => string };
    __MARKON_SHORTCUTS__?: Record<string, Partial<Record<string, unknown>>>;
    MarkonTheme?: {
      storageKey: string;
      getMode: () => string;
      getResolved: () => 'light' | 'dark';
      setMode: (mode: string) => void;
      openPanel: (anchor?: Element | null) => void;
      togglePanel: (anchor?: Element | null) => void;
      closePanel: () => void;
      apply: () => void;
      applyStylesheetMedia: () => void;
    };

    __markonTocSetSelected?: (id: string) => void;

    marked?: { parse: (src: string) => string };
  }
}
