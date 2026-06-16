// entry.mjs — the single source bundled (one-time, by esbuild) into
// web/vendor/codemirror.bundle.js for Spec 004 (CodeMirror on-box, no CDN).
//
// It re-exports EXACTLY the symbols web/ide.js consumes today from esm.sh:
//   - @codemirror/state : EditorState, Compartment
//   - @codemirror/view  : EditorView, lineNumbers, highlightActiveLine, drawSelection
//   - @codemirror/language : syntaxHighlighting, defaultHighlightStyle, HighlightStyle, foldGutter, bracketMatching
//   - @lezer/highlight : tags  (to build the clanker/Gruvbox HighlightStyle in ide.js)
//   - the 8 language factories, lazily chosen by file extension
// NOTE: NO theme-one-dark — it ships a cool grey #282c34 that clashes with the app's
// warm stone/terracotta palette. The editor's colours come from a Gruvbox-dark
// HighlightStyle + a theme built in ide.js from the app's own CSS vars (clanker-aligned).
// esbuild collapses the shared core (state/view) into ONE copy automatically, so
// the `external=` singleton trick the esm.sh URLs needed is unnecessary here.
//
// This is NOT a runtime build (Principle VII): the browser loads the committed
// static bundle directly; esbuild only runs once, by a developer, to produce it.
export { EditorState, Compartment } from '@codemirror/state';
export { EditorView, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
export { syntaxHighlighting, defaultHighlightStyle, HighlightStyle, foldGutter, bracketMatching } from '@codemirror/language';
export { tags } from '@lezer/highlight';

export { javascript } from '@codemirror/lang-javascript';
export { python } from '@codemirror/lang-python';
export { css } from '@codemirror/lang-css';
export { html } from '@codemirror/lang-html';
export { json } from '@codemirror/lang-json';
export { markdown } from '@codemirror/lang-markdown';
export { rust } from '@codemirror/lang-rust';
export { yaml } from '@codemirror/lang-yaml';
