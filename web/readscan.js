// @ts-check
/**
 * watchyourclankers — readscan.js
 * PURE schedule for the "reading scan" visualization: when Claude READS a file
 * (not edits it), the spectator sweeps a highlight down the read range — a reading
 * indicator distinct from the edit-typing reveal. Extracted + node --tested so the
 * sweep behaves deterministically (the harness rule: interaction logic is pure +
 * tested, the DOM is just I/O — LESSONS L5).
 */

/**
 * Ordered 1-based line indices to highlight while "reading" lines [startLine..endLine].
 * Small ranges sweep every line; a large range STRIDES so the sweep is bounded
 * (~maxSteps steps) yet always includes the first and last line.
 * @param {number} startLine 1-based inclusive
 * @param {number} endLine   1-based inclusive (clamped to >= startLine)
 * @param {{maxSteps?:number}} [opts]
 * @returns {number[]}
 */
export function readScanSteps(startLine, endLine, opts = {}) {
  const maxSteps = Math.max(1, Math.floor(opts.maxSteps || 60));
  const a = Math.max(1, Math.floor(startLine || 1));
  const b = Math.max(a, Math.floor(endLine || a));
  const span = b - a + 1;
  const out = [];
  if (span <= maxSteps) {
    for (let i = a; i <= b; i++) out.push(i);
    return out;
  }
  const stride = Math.ceil(span / maxSteps);
  for (let i = a; i <= b; i += stride) out.push(i);
  if (out[out.length - 1] !== b) out.push(b);
  return out;
}

/**
 * The read range from a read Activity. The Read tool carries offset/limit; until
 * the contract surfaces them, fall back to the whole file (or a window around the
 * activity's `line`). Returns {start,end} 1-based inclusive, clamped to the doc.
 * @param {{line?:number|null, offset?:number|null, limit?:number|null}} act
 * @param {number} totalLines
 * @param {{window?:number}} [opts]
 */
export function readRange(act, totalLines, opts = {}) {
  const total = Math.max(1, Math.floor(totalLines || 1));
  const win = Math.max(1, Math.floor(opts.window || 40));
  let start, end;
  if (act && Number.isFinite(act.offset) && act.offset > 0) {
    start = act.offset;
    end = Number.isFinite(act.limit) && act.limit > 0 ? act.offset + act.limit - 1 : total;
  } else if (act && Number.isFinite(act.line) && act.line > 0) {
    start = act.line;            // a focus line → scan a window around it
    end = act.line + win - 1;
  } else {
    start = 1;
    end = total;                 // unknown → sweep the whole (bounded) file
  }
  start = Math.max(1, Math.min(start, total));
  end = Math.max(start, Math.min(end, total));
  return { start, end };
}
