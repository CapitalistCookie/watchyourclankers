// web/resize.js — shared, reusable pane resizer for watchyourclankers.
//
// Self-contained: injects its own gutter CSS on first import (so it can't hit the
// "stylesheet never linked" trap). Used by mosaic.js / ide.js / debug.js to make
// EVERY pane boundary drag-resizable, with debounced localStorage persistence.
//
// Design: a low-level pointer-drag primitive (attachDrag) + tiny persistence
// helpers. Each view owns its layout math — on drag it receives a pixel delta and
// applies it to whatever it controls (grid-template tracks, a width, a flex-basis),
// then persists. Gutters use the clanker palette vars (--border / --accent).
//
// Typical usage (resize two grid columns, e.g. tree | editor):
//   import { attachDrag, makeGutter, loadSizes, saveSizes, clamp } from './resize.js';
//   const g = makeGutter('x'); container.insertBefore(g, editorEl); // between tree & editor
//   let startW;
//   attachDrag(g, {
//     axis: 'x',
//     onStart: () => { startW = treeEl.getBoundingClientRect().width; },
//     onDelta: (dx) => {
//       const w = clamp(startW + dx, 80, 460);
//       container.style.gridTemplateColumns = `${w}px 6px 1fr`; // tree | gutter | rest
//     },
//     onEnd:   () => saveSizes('wyc.ide.layout.v1', { treeW: treeEl.getBoundingClientRect().width }),
//   });
// On mount, restore: const s = loadSizes('wyc.ide.layout.v1'); if (s?.treeW) container.style.gridTemplateColumns = `${s.treeW}px 6px 1fr`;

const STYLE_ID = 'wyc-resize-css';

function injectCss() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
.wyc-gutter{position:relative;flex:0 0 auto;z-index:5;background:transparent;transition:background .12s ease;touch-action:none;}
.wyc-gutter::after{content:"";position:absolute;background:var(--border,#57534E);opacity:.5;transition:opacity .12s ease,background .12s ease;}
.wyc-gutter:hover::after,.wyc-gutter.dragging::after{opacity:1;background:var(--accent,#C2410C);}
/* vertical gutter (drag horizontally; sits between columns) */
.wyc-gutter-x{width:6px;cursor:col-resize;align-self:stretch;}
.wyc-gutter-x::after{top:0;bottom:0;left:50%;width:1px;transform:translateX(-50%);}
.wyc-gutter-x.dragging::after{width:2px;}
/* horizontal gutter (drag vertically; sits between rows) */
.wyc-gutter-y{height:6px;cursor:row-resize;justify-self:stretch;width:100%;}
.wyc-gutter-y::after{left:0;right:0;top:50%;height:1px;transform:translateY(-50%);}
.wyc-gutter-y.dragging::after{height:2px;}
/* while dragging anywhere: kill text selection + keep the resize cursor */
body.wyc-resizing{user-select:none!important;-webkit-user-select:none!important;}
body.wyc-resizing.x{cursor:col-resize!important;}
body.wyc-resizing.y{cursor:row-resize!important;}
body.wyc-resizing *{pointer-events:none!important;}
.wyc-gutter{pointer-events:auto!important;}
`;
  document.head.appendChild(s);
}
injectCss();

export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * Make `gutter` a drag handle. Calls onDelta(dx, dy) with the pixel delta since
 * drag start. Uses pointer capture so the drag survives the cursor leaving the
 * gutter. Returns the gutter element.
 */
export function attachDrag(gutter, { axis = 'x', onStart, onDelta, onEnd } = {}) {
  if (!gutter) return gutter;
  gutter.classList.add('wyc-gutter', axis === 'y' ? 'wyc-gutter-y' : 'wyc-gutter-x');
  let sx = 0, sy = 0, active = false, pid = null;
  const down = (e) => {
    active = true; sx = e.clientX; sy = e.clientY; pid = e.pointerId;
    try { gutter.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    gutter.classList.add('dragging');
    document.body.classList.add('wyc-resizing', axis === 'y' ? 'y' : 'x');
    if (onStart) onStart(e);
    e.preventDefault(); e.stopPropagation();
  };
  const move = (e) => { if (!active) return; if (onDelta) onDelta(e.clientX - sx, e.clientY - sy); e.preventDefault(); };
  const up = (e) => {
    if (!active) return;
    active = false;
    try { gutter.releasePointerCapture(pid); } catch { /* ignore */ }
    gutter.classList.remove('dragging');
    document.body.classList.remove('wyc-resizing', 'x', 'y');
    if (onEnd) onEnd(e);
  };
  gutter.addEventListener('pointerdown', down);
  gutter.addEventListener('pointermove', move);
  gutter.addEventListener('pointerup', up);
  gutter.addEventListener('pointercancel', up);
  // double-click a gutter to reset (view supplies the reset via onEnd reading a flag)
  return gutter;
}

/** Create a gutter <div> (not yet attached). axis 'x' = vertical bar / col-resize. */
export function makeGutter(axis = 'x') {
  const g = document.createElement('div');
  g.className = 'wyc-gutter ' + (axis === 'y' ? 'wyc-gutter-y' : 'wyc-gutter-x');
  return g;
}

/** Load a persisted size object (or null). */
export function loadSizes(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}

const _timers = {};
/** Debounced persist of a size object. */
export function saveSizes(key, obj) {
  clearTimeout(_timers[key]);
  _timers[key] = setTimeout(() => {
    try { localStorage.setItem(key, JSON.stringify(obj)); } catch { /* ignore */ }
  }, 200);
}
