// @ts-check
/**
 * watchyourclankers — cmreveal.js
 * PURE plan for revealing a freshly-landed hunk INTO CodeMirror char-by-char
 * (Spec 004 increment 3) instead of snapping the whole doc in. Mirrors the
 * fallback reveal by REUSING reveal.js (char frames) + revealpolicy.js (char-vs-
 * line granularity). No DOM, no timers, no CM symbols referenced → fully
 * unit-testable (node --test web/cmreveal.test.mjs). The timed CM dispatch that
 * CONSUMES this plan is the DOM/IO layer (covered live by ci/cm_smoke.mjs).
 *
 * The plan shows the ENTIRE document with the hunk's line-range emptied, then
 * grows that region back to its full text in steps. ide.js applies it as:
 *   view.setState(EditorState.create({ doc: plan.initialDoc, ... }));
 *   let prev = 0;
 *   for (const s of plan.steps) {
 *     view.dispatch({ changes: { from: plan.from, to: plan.from + prev, insert: s } });
 *     prev = s.length;
 *   }
 * which leaves the document EXACTLY equal to fullDoc (asserted in the tests).
 */
import { revealFrames } from './reveal.js';
import { revealByLine } from './revealpolicy.js';

const clampInt = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(n)));

/**
 * @param {string} fullDoc   the complete file content (the final state)
 * @param {number} startLine 1-based first line of the hunk
 * @param {number} endLine   1-based last line of the hunk (>= startLine)
 * @returns {{from:number, to:number, hunkText:string, initialDoc:string, steps:string[]}}
 */
export function cmRevealPlan(fullDoc, startLine, endLine) {
  const doc = fullDoc == null ? '' : String(fullDoc);
  const lines = doc.split('\n');
  const n = lines.length;
  const s = clampInt((startLine || 1) - 1, 0, Math.max(0, n - 1));
  const e = clampInt((endLine || startLine || 1) - 1, s, Math.max(0, n - 1));

  // char offset of the start of line s = sum of preceding line lengths + their \n
  let from = 0;
  for (let i = 0; i < s; i++) from += lines[i].length + 1;
  const hunkText = lines.slice(s, e + 1).join('\n');
  const to = from + hunkText.length;
  const initialDoc = doc.slice(0, from) + doc.slice(to);

  if (!hunkText) return { from, to, hunkText, initialDoc, steps: [] };

  let steps;
  if (revealByLine(hunkText.length)) {
    // TRULY massive hunk: grow one whole LINE per step (bounded), never per-char.
    const hl = hunkText.split('\n');
    steps = [];
    let acc = '';
    for (let i = 0; i < hl.length; i++) { acc += (i ? '\n' : '') + hl[i]; steps.push(acc); }
  } else {
    // char-by-char from empty; drop the leading '' frame (initialDoc is already
    // empty in the region), so each step is the growing hunk prefix.
    steps = revealFrames('', hunkText).slice(1);
  }
  if (!steps.length) steps = [hunkText];
  return { from, to, hunkText, initialDoc, steps };
}
