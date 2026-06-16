// @ts-check
/**
 * watchyourclankers — idegeom.js
 * PURE editor↔terminal resize geometry, extracted from ide.js so the drag math is
 * unit-tested headless (node --test web/idegeom.test.mjs) and can NEVER silently
 * regress to the "always goes down / unpredictable" bug that forced the f632b4e
 * revert (LESSONS L1/L5; R06).
 *
 * Layout: editor on TOP, terminal on BOTTOM, a gutter between them.
 *   - drag the gutter DOWN  (dy > 0) -> editor grows, terminal SHRINKS
 *   - drag the gutter UP    (dy < 0) -> editor shrinks, terminal GROWS
 * so the terminal height moves by -dy. `dy` is `clientY - startY` (resize.js),
 * i.e. downward-positive.
 *
 * termH is the SINGLE SOURCE OF TRUTH; only drag / double-click-reset / restore
 * write it. Render paths (applyGridTemplate, the ResizeObserver) READ it through
 * clampTermH and never mutate it — that invariant is what prevents the
 * "a re-render clobbers termH" class of bug.
 */

/** Max terminal height: a fraction of the grid, never below `min`. Infinity if grid unknown. */
export function maxTermFor(gridH, min, fracMax) {
  if (!(gridH > 0)) return Infinity;
  return Math.max(min, Math.floor(gridH * fracMax));
}

/** Clamp a desired terminal height to [min, maxTermFor]. The ONE clamp used by both drag + render. */
export function clampTermH(h, gridH, min, fracMax) {
  const max = maxTermFor(gridH, min, fracMax);
  return Math.max(min, Math.min(max, h));
}

/**
 * New terminal height for a drag of `dy` pixels from `startH`.
 * @param {{startH:number, dy:number, gridH:number, min:number, fracMax:number}} o
 * @returns {number}
 */
export function termHForDrag(o) {
  return clampTermH(o.startH - o.dy, o.gridH, o.min, o.fracMax);
}
