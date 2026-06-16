// @ts-check
/**
 * watchyourclankers — revealpolicy.js
 * PURE editor reveal-GRANULARITY policy. The operator wants CHAR-by-char (a fast,
 * capable human typing), NOT word/line. The old code revealed per-LINE for any hunk
 * over 800 chars (CADENCE.LINE_CHARS) — and Claude writes big blocks, so most edits
 * went line-by-line. This raises the bar dramatically: char-level for everything up
 * to a large cap; only a TRULY massive hunk (a giant generated block) falls back to
 * per-line so we don't schedule tens of thousands of steps. The gap-adaptive reveal
 * duration + accelerate-to-finish keep char-level from lagging on normal edits.
 * (Extracted + node --tested per the interaction-guard discipline; LESSONS L5/L7.)
 */

export const CHAR_CAP = 6000; // chars; at/under this a hunk reveals per CHAR

/** True iff a hunk of `totalChars` should reveal per-LINE instead of char-by-char. */
export function revealByLine(totalChars) {
  return Math.max(0, Math.floor(totalChars || 0)) > CHAR_CAP;
}
