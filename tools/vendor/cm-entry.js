// CodeMirror 6 + Markdown, re-exported as one ES module (public/vendor/cm.js).
export {
  EditorState, EditorSelection, StateField, StateEffect, Annotation, Transaction,
  Compartment, RangeSetBuilder, Prec, Text, ChangeSet,
} from '@codemirror/state';
export {
  EditorView, ViewPlugin, Decoration, WidgetType, keymap, drawSelection, placeholder,
  dropCursor, highlightSpecialChars,
} from '@codemirror/view';
export {
  defaultKeymap, history, historyKeymap, undo, redo, indentWithTab, insertNewlineAndIndent,
} from '@codemirror/commands';
export {
  syntaxTree, HighlightStyle, syntaxHighlighting, indentUnit, ensureSyntaxTree, Language, LanguageSupport,
} from '@codemirror/language';
// Only the Markdown language and its keymap: markdown() would pull in the HTML,
// CSS and JavaScript languages (for code blocks), which a writing party doesn't need.
export { markdownLanguage, markdownKeymap } from '@codemirror/lang-markdown';
export { search, searchKeymap, openSearchPanel } from '@codemirror/search';
export { tags } from '@lezer/highlight';
