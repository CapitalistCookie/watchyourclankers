// @ts-check
/**
 * watchyourclankers — cmtheme.js
 * The CLANKER-ALIGNED CodeMirror theme, as a SHARED module so the exact tag list
 * is gate-exercised (ci/cm_smoke.mjs builds it against the real vendored bundle —
 * a typo'd / renamed lezer tag fails the gate instead of silently dropping the
 * editor to the <pre> fallback). It mirrors the old hljs <pre> fallback's
 * Gruvbox-dark palette (warm, matches the app) — NOT CodeMirror's cool grey
 * one-dark — and builds the chrome from the app's own CSS vars.
 *
 * The lezer `tags` object + `HighlightStyle` come from the vendored bundle at
 * RUNTIME, so the highlight is a function OVER them (no CM import here → stays
 * DOM/dep-free and unit-testable with a fake tags object; web/cmtheme.test.mjs).
 */

/**
 * Gruvbox-dark token→colour rules as a HighlightStyle.define() spec.
 * @param {any} t the lezer `tags` object (from the CM bundle)
 */
export function clankerHighlightSpec(t) {
  return [
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: '#665c54', fontStyle: 'italic' },
    { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.moduleKeyword, t.definitionKeyword, t.modifier, t.self], color: '#d3869b' },
    { tag: [t.typeName, t.className, t.namespace], color: '#fabd2f' },
    { tag: [t.heading, t.strong], color: '#fabd2f', fontWeight: 'bold' },
    { tag: [t.string, t.docString, t.character, t.attributeValue, t.inserted], color: '#b8bb26' },
    { tag: [t.number, t.integer, t.float, t.literal, t.bool, t.null, t.atom, t.constant(t.variableName), t.escape, t.color, t.unit], color: '#fe8019' },
    { tag: [t.function(t.variableName), t.function(t.definition(t.variableName)), t.definition(t.function(t.variableName)), t.attributeName, t.propertyName, t.labelName], color: '#83a598' },
    { tag: [t.regexp, t.quote, t.special(t.string)], color: '#8ec07c' },
    { tag: [t.tagName, t.macroName, t.special(t.variableName)], color: '#fb4934' },
    { tag: [t.meta, t.documentMeta, t.annotation, t.processingInstruction], color: '#d65d0e' },
    { tag: [t.emphasis], color: '#d3869b', fontStyle: 'italic' },
    { tag: [t.link, t.url], color: '#fe8019', textDecoration: 'underline' },
    { tag: [t.deleted], color: '#fb4934' },
    { tag: [t.invalid], color: '#fb4934' },
  ];
}

/**
 * Build the HighlightStyle from the bundle's `HighlightStyle` + `tags`.
 * @param {any} HighlightStyle @param {any} tags
 */
export function buildClankerHighlight(HighlightStyle, tags) {
  return HighlightStyle.define(clankerHighlightSpec(tags));
}

/** Chrome theme spec (app CSS vars) — pass to EditorView.theme(spec, {dark:true}). */
export const clankerThemeSpec = {
  '&': { backgroundColor: 'var(--bg-deep)', color: 'var(--fg-dim)' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--bg-surface)' },
  '.cm-gutters': { backgroundColor: 'var(--bg-deep)', border: 'none', color: 'var(--fg-faint)' },
  '.cm-activeLine': { backgroundColor: 'rgba(68,64,60,0.16)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--bg-panel)', color: 'var(--fg-dim)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--bg-panel)', color: 'var(--fg-faint)', border: 'none' },
};
