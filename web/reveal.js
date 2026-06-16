// @ts-check
/**
 * watchyourclankers — reveal.js
 * PURE diff→frames engine for the editor's char-level reveal with diff-aware
 * DELETIONS (R08). Extracted + unit-tested (node --test web/reveal.test.mjs) so
 * the "type it like a fast human, backspace what changed, type the new" behavior
 * is deterministic and ghost-free — the feature whose agent-built version timed
 * out unverified and caused ghosting (LESSONS L1). The animation sets the editor
 * text to each successive FULL frame string (no incremental DOM node mutation =
 * no orphan/ghost nodes).
 */

/**
 * Minimal middle diff of two strings: the longest common prefix + suffix
 * (non-overlapping) bracket a single changed middle.
 * @returns {{prefix:string, deleted:string, inserted:string, suffix:string}}
 * Invariant: prefix+deleted+suffix === oldStr ; prefix+inserted+suffix === newStr.
 */
export function diffEdit(oldStr, newStr) {
  oldStr = oldStr == null ? '' : String(oldStr);
  newStr = newStr == null ? '' : String(newStr);
  const max = Math.min(oldStr.length, newStr.length);
  let p = 0;
  while (p < max && oldStr[p] === newStr[p]) p++;
  // common suffix, not overlapping the prefix on either side
  let s = 0;
  while (
    s < (max - p) &&
    oldStr[oldStr.length - 1 - s] === newStr[newStr.length - 1 - s]
  ) s++;
  return {
    prefix: oldStr.slice(0, p),
    deleted: oldStr.slice(p, oldStr.length - s),
    inserted: newStr.slice(p, newStr.length - s),
    suffix: oldStr.slice(oldStr.length - s),
  };
}

/**
 * The ordered list of intermediate FULL strings to display, turning oldStr into
 * newStr by: backspacing the deleted middle one char at a time, then typing the
 * inserted middle one char at a time. First frame === oldStr, last === newStr.
 * Each frame differs from the previous by exactly one character (len ±1).
 * @returns {string[]}
 */
export function revealFrames(oldStr, newStr) {
  const { prefix, deleted, inserted, suffix } = diffEdit(oldStr, newStr);
  const frames = [];
  // start
  frames.push(prefix + deleted + suffix);
  // backspace the deleted middle, char by char (from its end)
  for (let i = deleted.length - 1; i >= 0; i--) {
    frames.push(prefix + deleted.slice(0, i) + suffix);
  }
  // now at prefix+suffix; type the inserted middle, char by char
  for (let i = 1; i <= inserted.length; i++) {
    frames.push(prefix + inserted.slice(0, i) + suffix);
  }
  return frames;
}

/**
 * How many reveal steps oldStr->newStr takes (deletions + insertions). 0 = identical.
 */
export function revealStepCount(oldStr, newStr) {
  const { deleted, inserted } = diffEdit(oldStr, newStr);
  return deleted.length + inserted.length;
}
