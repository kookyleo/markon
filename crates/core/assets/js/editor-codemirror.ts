/**
 * Lazily loaded CodeMirror runtime for the Markdown source editor.
 *
 * Keeping this module behind a dynamic import means ordinary document views
 * do not download or parse the editor engine until the user opens Edit.
 */

import { basicSetup } from 'codemirror';
import { indentWithTab } from '@codemirror/commands';
import { indentUnit, syntaxHighlighting } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import {
    EditorState,
    Prec,
    type StateCommand,
    type Text as CodeMirrorText,
} from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { tagHighlighter, tags } from '@lezer/highlight';

export interface MarkdownEditorCallbacks {
    onDocumentChanged: (doc: CodeMirrorText) => void;
    onSave: () => void;
    onSelectionChanged: () => void;
}

const markonMarkdownHighlighter = tagHighlighter([
    { tag: tags.heading, class: 'mk-cm-heading' },
    { tag: tags.strong, class: 'mk-cm-strong' },
    { tag: tags.emphasis, class: 'mk-cm-emphasis' },
    { tag: tags.monospace, class: 'mk-cm-code' },
    { tag: [tags.link, tags.url], class: 'mk-cm-link' },
    { tag: tags.quote, class: 'mk-cm-quote' },
    { tag: tags.list, class: 'mk-cm-list' },
    { tag: tags.contentSeparator, class: 'mk-cm-separator' },
    { tag: [tags.meta, tags.processingInstruction], class: 'mk-cm-meta' },
    { tag: tags.comment, class: 'mk-cm-comment' },
    { tag: tags.invalid, class: 'mk-cm-invalid' },
]);

/**
 * CodeMirror follows the conventional "empty item exits the list" behavior.
 * Markon explicitly allows a marker-only item (#60), so preserve that one
 * product-specific rule as a CodeMirror transaction and let markdownKeymap
 * handle every other Enter case.
 */
const continueEmptyMarkdownList: StateCommand = ({ state, dispatch }) => {
    if (state.selection.ranges.length !== 1) return false;
    const selection = state.selection.main;
    if (!selection.empty) return false;

    const line = state.doc.lineAt(selection.head);
    const beforeCursor = line.text.slice(0, selection.head - line.from);
    const match = beforeCursor.match(
        /^([\t ]*)(?:(\d+)\.|([-+*]))(?:[\t ]+(?:\[([ xX])\][\t ]*)?)?$/,
    );
    if (!match) return false;

    const indent = match[1] ?? '';
    const ordered = match[2];
    const bullet = match[3];
    const task = match[4] === undefined ? '' : '[ ] ';
    const marker = ordered === undefined
        ? bullet
        : `${Number.parseInt(ordered, 10) + 1}.`;
    if (!marker) return false;

    const insert = `\n${indent}${marker} ${task}`;
    dispatch?.(state.update({
        changes: { from: selection.head, insert },
        selection: { anchor: selection.head + insert.length },
        scrollIntoView: true,
        userEvent: 'input',
    }));
    return true;
};

export function createMarkdownEditor(
    parent: HTMLElement,
    doc: string,
    callbacks: MarkdownEditorCallbacks,
): EditorView {
    return new EditorView({
        doc,
        parent,
        extensions: [
            // This binding must precede markdown() at the same high precedence
            // so Markon's marker-only list behavior gets first refusal.
            Prec.high(keymap.of([
                {
                    key: 'Mod-s',
                    run: () => {
                        callbacks.onSave();
                        return true;
                    },
                },
                { key: 'Enter', run: continueEmptyMarkdownList },
                indentWithTab,
            ])),
            basicSetup,
            markdown(),
            EditorView.lineWrapping,
            EditorState.tabSize.of(4),
            indentUnit.of('    '),
            syntaxHighlighting(markonMarkdownHighlighter),
            EditorView.contentAttributes.of({
                spellcheck: 'false',
                autocapitalize: 'off',
            }),
            EditorView.updateListener.of(update => {
                if (update.docChanged) {
                    callbacks.onDocumentChanged(update.state.doc);
                }
                if (update.docChanged || update.selectionSet) {
                    callbacks.onSelectionChanged();
                }
            }),
        ],
    });
}

export type CreateMarkdownEditor = typeof createMarkdownEditor;
