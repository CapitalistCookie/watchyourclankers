// @ts-check
/**
 * watchyourclankers — termpolicy.js
 * PURE terminal reveal-cadence policy, extracted so it's node --tested (the
 * harness rule: cadence is a POLICY, not something to eyeball — LESSONS L5/L7;
 * enforced by the interaction-guard hook).
 *
 * A REAL terminal: the COMMAND is typed (a person types it at the prompt), but
 * the OUTPUT is INSTANT — the program prints it all at once, it is NOT typed out
 * character by character. So: type the command, dump the output.
 */

/**
 * How many chars of the command to reveal this step (typed, lightly grouped so a
 * long command doesn't crawl). `remaining` = chars left to type.
 * @param {number} remaining
 * @param {{speed?:number}} [opts]
 * @returns {number}
 */
export function termCommandStep(remaining, opts = {}) {
  remaining = Math.max(0, Math.floor(remaining || 0));
  if (remaining === 0) return 0;
  const grp = Math.max(1, Math.min(4, Math.ceil(remaining / 28)));
  return Math.min(remaining, grp * Math.max(1, Math.floor(opts.speed || 1)));
}

/**
 * How much pending OUTPUT to take this step. INSTANT by design — a real terminal
 * dumps output, it does not type it. Returns the whole pending length.
 * @param {number} pendingLen
 * @returns {number}
 */
export function termOutputTake(pendingLen) {
  return Math.max(0, Math.floor(pendingLen || 0));
}
