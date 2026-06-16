// @ts-check
/**
 * watchyourclankers — mosaic.js  (W3 dynamic tiling mosaic)
 *
 * Default export: mountMosaic(el, store) -> { destroy() }
 *
 * A dynamic tiling grid: ONE tile per ACTIVE thread (busy first), overflow into a
 * 'more' rail. Layouts 1 / 2 / 4 / 6. Reflows as threads appear/disappear.
 *
 * FAN-OUT: when a tile's lead session has sub-agents (Session.subagents non-empty)
 * a collapsible fan-out strip of child sub-tiles renders above the pane so you can
 * watch parallel agents; it auto-collapses when the sub-agents finish.
 *
 * Each tile COMPOSES the W2 IDE pane:
 *     import mountIdePane from './ide.js'
 *     const pane = mountIdePane(paneEl, store, { threadId, getToken })
 *     // -> { destroy(), setThread(id) }
 * ide.js is imported lazily; if it isn't available at runtime the tile degrades
 * to a lightweight surface (session name + current file + last activity + busy dot)
 * so the mosaic works standalone.
 *
 * Per-tile controls: maximize, pin (opt out of auto-switch), freeze (snapshot —
 * STUB), flag (STUB), pop-out (window.open cloning styles), collapse, and an
 * IDE-vs-raw-screen toggle (pass-through to the pane / show the screen mirror).
 *
 * AUTO-SWITCH modes (settings via menu.js):
 *   focus  = focus-follows-latest (default) — most-recently-active thread bound to
 *            tile 0; others fill by busy-then-recency. Pinned tiles never re-bind.
 *   per-tile = each tile keeps its bound thread unless empty.
 *   manual = no auto re-bind at all (operator drives via palette / cycle).
 *
 * Performance (Principle VII): tiles are reconciled (reused + rebound via
 * pane.setThread), not torn down on every change. store.subscribe is rAF-batched.
 */

import mountMenu from './menu.js';
import { attachDrag, makeGutter, loadSizes, saveSizes, clamp } from './resize.js';
import { assignSlots } from './assign.js';

// persisted pane-size store key (separate from menu.js's settings blob). Holds
// per-grid track sizes + the rail width + the chosen watch-count (watchN).
const LAYOUT_KEY = 'wyc.mosaic.layout.v1';
// every track clamps to this fraction of the grid so none can collapse to 0.
const TRACK_MIN_FRAC = 0.12;
const RAIL_MIN = 140, RAIL_MAX = 420;

// ---- watch-count → grid arrangement -----------------------------------------
// The watch dropdown chooses HOW MANY sessions to tile (1..MAX_WATCH) or 'auto'
// (fit as many as comfortably display). Orientation is INDEPENDENT of count and
// AUTO-DETECTED (portrait → stack into more rows, landscape → more columns).
const MIN_WATCH = 1, MAX_WATCH = 8;
const WATCH_AUTO = 'auto';
// in 'auto' mode, the max tiles we'll show without getting cramped (per orient).
const AUTO_MAX_LANDSCAPE = 6, AUTO_MAX_PORTRAIT = 4;

/**
 * Arrange N tiles into a near-square grid, biased to more COLUMNS in landscape
 * and more ROWS in portrait. Handles ARBITRARY N (not just powers of two):
 * sensible specials — n=3 landscape→3×1, n=3 portrait→1×3, n=5→3×2 (one empty),
 * n=7→4×2 (one empty), etc. cols*rows is always ≥ n (the slack cell stays empty).
 * @param {number} n      tile count (clamped to ≥1)
 * @param {boolean} portrait  viewport taller than wide
 * @returns {{cols:number, rows:number}}
 */
export function tilesToGrid(n, portrait) {
  n = Math.max(1, Math.floor(n) || 1);
  if (n === 1) return { cols: 1, rows: 1 };
  if (n === 2) return portrait ? { cols: 1, rows: 2 } : { cols: 2, rows: 1 };
  if (n === 3) return portrait ? { cols: 1, rows: 3 } : { cols: 3, rows: 1 };
  // Search every column count 1..n for the (cols, rows=ceil(n/cols)) pair that
  // best balances FULLNESS (few empty cells) and SQUARENESS (small |cols-rows|).
  // The weighting (empties*5 + skew*2) is tuned so a near-square with a partial
  // empty row beats an elongated strip (n=5 → 3×2, not 5×1) while a fuller layout
  // still wins over an emptier squarer one where it matters (n=7 → 4×2, not 3×3).
  // Yields: 2×2 (n=4), 3×2 (n=5,6), 4×2 (n=7,8). Orientation bias applied after.
  let best = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const empties = cols * rows - n;
    const skew = Math.abs(cols - rows);
    const score = empties * 5 + skew * 2;
    if (!best || score < best.score) best = { cols, rows, score };
  }
  let { cols, rows } = best;
  // orientation bias: portrait wants the longer side as ROWS, landscape as COLS.
  if (portrait ? cols > rows : rows > cols) { const t = cols; cols = rows; rows = t; }
  return { cols, rows };
}

// lazily-loaded ide.js mount fn (or null if unavailable)
let _ideMod = undefined; // undefined = not tried, null = unavailable, fn = loaded
/** @returns {Promise<Function|null>} */
function loadIde() {
  if (_ideMod !== undefined) return Promise.resolve(_ideMod);
  return import('./ide.js')
    .then((mod) => {
      const fn = (mod && (mod.default || mod.mountIdePane || mod.mount)) || null;
      _ideMod = typeof fn === 'function' ? fn : null;
      return _ideMod;
    })
    .catch(() => { _ideMod = null; return null; });
}

// ----------------------------------------------------------------- tiny utils
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function baseName(p) {
  if (!p) return '';
  const s = String(p);
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}
function fmtTime(ts) {
  if (!ts) return '--:--:--';
  const d = new Date(ts * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function shorten(s, n) {
  if (!s) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
const ANSI_RE = /\x1b[\[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PRZcf-nqry=><]/g;
function stripAnsi(s) { return s ? String(s).replace(ANSI_RE, '') : ''; }

// busy-first thread ranking by lead session status, then recency.
const STATUS_RANK = { busy: 0, idle: 1, ended: 2 };
// activity kinds that mean "code is being generated" (drive the editing signal).
const EDIT_KINDS = { edit: 1, write: 1 };
// a thread counts as "actively editing" only if its newest edit/write is this
// fresh (seconds). Older edits still rank above plain-busy via recency, but the
// fewer-but-larger / ✎-emphasis only fires while an edit is genuinely recent.
const EDIT_ACTIVE_WINDOW_S = 45;

// ================================================================ main
/**
 * @param {HTMLElement} rootEl
 * @param {object} store
 * @returns {{destroy():void}}
 */
export function mountMosaic(rootEl, store) {
  rootEl.innerHTML = '';
  const root = el('div', 'mosaic');
  root.tabIndex = -1;

  // --- mobile nav (only visible <820px via CSS) ---
  const mobileNav = el('div', 'mos-mobile-nav');
  const mnPrev = el('button', 'mn-arrow', '‹'); mnPrev.title = 'previous thread';
  const mnLabel = el('div', 'mn-label');
  const mnTitle = el('div', 'mn-title', '');
  const mnPager = el('div', 'mn-pager', '');
  mnLabel.append(mnTitle, mnPager);
  const mnNext = el('button', 'mn-arrow', '›'); mnNext.title = 'next thread';
  mobileNav.append(mnPrev, mnLabel, mnNext);

  // --- control bar (desktop) ---
  // Rendered into the shared header toolbar slot (#wyc-toolbar) so the brand row
  // and these controls live on ONE top bar. Falls back to mounting in the mosaic
  // root if the slot is absent (e.g. tests / standalone mount).
  const bar = el('div', 'mos-bar');

  // watch-count dropdown: "Watch [N|Auto]". Replaces the old 1/2/4/6/vert
  // segmented buttons — arbitrary N, orientation auto-detected (no vert entry).
  const watchWrap = el('label', 'mos-watch');
  watchWrap.append(el('span', 'mos-watch-lbl', 'Watch'));
  const watchSel = /** @type {HTMLSelectElement} */ (el('select', 'mos-watch-sel'));
  watchSel.title = 'how many sessions to tile (Auto fits as many as comfortably display)';
  {
    const optAuto = /** @type {HTMLOptionElement} */ (el('option', null, 'Auto'));
    optAuto.value = WATCH_AUTO;
    watchSel.append(optAuto);
    for (let n = MIN_WATCH; n <= MAX_WATCH; n++) {
      const o = /** @type {HTMLOptionElement} */ (el('option', null, String(n)));
      o.value = String(n);
      watchSel.append(o);
    }
  }
  watchSel.addEventListener('change', () => setWatch(watchSel.value));
  watchWrap.append(watchSel);

  const modeChip = el('div', 'mos-mode');
  modeChip.append(document.createTextNode('auto-switch '), el('b', null, ''));
  modeChip.style.cursor = 'pointer';
  modeChip.title = 'cycle auto-switch mode';
  modeChip.addEventListener('click', cycleMode);
  const barSpacer = el('div', 'mos-bar-spacer');
  const redactionChip = el('div', 'mos-redaction');
  redactionChip.append(el('span', 'dot'), el('span', 'rlabel', 'redaction'));
  const railToggle = el('button', 'mos-iconbtn', '☰');
  railToggle.title = 'toggle overflow rail';
  railToggle.addEventListener('click', () => menu.setSetting('showRail', !menu.settings.showRail));
  const settingsBtn = el('button', 'mos-iconbtn', '⚙');
  settingsBtn.title = 'settings';
  settingsBtn.addEventListener('click', () => menu.openSettings());
  const paletteBtn = el('button', 'mos-iconbtn', '⌘K');
  paletteBtn.title = 'command palette (⌘K)';
  paletteBtn.addEventListener('click', () => menu.open());
  bar.append(watchWrap, modeChip, barSpacer, redactionChip, railToggle, settingsBtn, paletteBtn);

  // --- stage: grid + (rail gutter) + rail ---
  const stage = el('div', 'mos-stage');
  const grid = el('div', 'mos-grid');
  const rail = el('div', 'mos-rail');
  const railHdr = el('div', 'mos-rail-hdr');
  // explicit collapse chevron on the rail header (parity with the gutter-drag
  // collapse + the per-tile chevron). › collapses the rail to a thin rib.
  const railChevron = el('button', 'mos-rail-chevron', '›');
  railChevron.title = 'collapse rail';
  railChevron.addEventListener('click', () => setRailCollapsed(true));
  const railCount = el('span', 'r-count', '');
  railHdr.append(el('span', 'accent', 'more'), railCount, railChevron);
  const railBody = el('div', 'mos-rail-body');
  // thin re-open rib, shown only while the rail is collapsed (the header — and its
  // chevron — are hidden at rib width, so the rib carries the expand affordance).
  const railRib = el('button', 'mos-rail-rib', '‹');
  railRib.title = 'expand rail';
  railRib.addEventListener('click', () => setRailCollapsed(false));
  rail.append(railHdr, railBody, railRib);
  // vertical gutter between the tile grid and the overflow rail (resizes rail width)
  const railGutter = makeGutter('x');
  railGutter.classList.add('mos-rail-gutter');
  railGutter.title = 'drag to resize rail · double-click to reset';
  stage.append(grid, railGutter, rail);

  // --- mobile FAB ---
  const fab = el('div', 'mos-fab');
  const fabSettings = el('button', 'fab-btn', '⚙'); fabSettings.title = 'settings';
  const fabPin = el('button', 'fab-btn', '📌'); fabPin.title = 'pin';
  const fabFreeze = el('button', 'fab-btn', '❄'); fabFreeze.title = 'freeze';
  const fabPop = el('button', 'fab-btn', '⧉'); fabPop.title = 'pop out';
  const fabRaw = el('button', 'fab-btn', '▦'); fabRaw.title = 'raw screen';
  fab.append(fabSettings, fabPin, fabFreeze, fabPop, fabRaw);
  fabSettings.addEventListener('click', () => menu.openSettings());
  fabPin.addEventListener('click', () => annotateFocused('pin'));
  fabFreeze.addEventListener('click', () => annotateFocused('freeze'));
  fabPop.addEventListener('click', () => popOutFocused());
  fabRaw.addEventListener('click', () => toggleRaw());

  // ONE-BAR consolidation: render the desktop control bar into the shared header
  // toolbar slot (created by app.js) so brand · controls · live-status sit on a
  // single top bar. If the slot is missing (standalone mount), keep the legacy
  // behaviour and place the bar at the top of the mosaic root.
  const toolbarSlot = (typeof document !== 'undefined')
    ? document.getElementById('wyc-toolbar') : null;
  if (toolbarSlot) {
    toolbarSlot.innerHTML = '';
    bar.classList.add('mos-bar-in-header');
    toolbarSlot.append(bar);
    root.append(mobileNav, stage, fab);
  } else {
    root.append(mobileNav, bar, stage, fab);
  }
  rootEl.append(root);

  // ================================================================ tile model
  /**
   * @typedef {object} Tile
   * @property {HTMLElement} elTile
   * @property {HTMLElement} chrome
   * @property {HTMLElement} titleEl
   * @property {HTMLElement} subEl
   * @property {HTMLElement} dotEl
   * @property {HTMLElement} fanoutEl
   * @property {HTMLElement} bodyEl
   * @property {HTMLElement} paneEl
   * @property {object|null} pane         ide.js pane instance ({destroy,setThread}) or null (fallback)
   * @property {boolean} usingIde
   * @property {string|null} threadId
   * @property {boolean} pinned
   * @property {boolean} frozen
   * @property {boolean} flagged
   * @property {boolean} collapsed       // body hidden; only the chrome header strip shows
   * @property {('ide'|'raw')} viewMode
   * @property {boolean} watchingScreen   // currently subscribed to a screen feed
   * @property {string|null} watchSession // session id we asked to watch
   * @property {object} ctrls             // control button refs
   * @property {object} fb                // fallback surface refs
   * @property {Map<string,HTMLElement>} subEls  // subagent id -> chip
   */

  /** @type {Tile[]} */
  const tiles = [];
  let maximizedTileIdx = -1;     // -1 = none
  let focusedTileIdx = 0;        // which tile has keyboard/command focus
  let mobileIdx = 0;            // which active-thread index is shown on mobile

  // ================================================================ pane sizing
  // Persisted layout sizes (separate localStorage blob, NOT menu.js settings):
  //   { watchN?: number|'auto', railW?: number, grid2x2:{cols,rows}, grid3x2:{...}, ... }
  // cols/rows are arrays of fr weights (one per track) keyed by the CURRENT grid
  // dims signature. Restored on mount, re-applied whenever the grid re-gutters.
  /** @type {{watchN?:number|string, railW?:number, [k:string]:any}} */
  let sizes = loadSizes(LAYOUT_KEY) || {};
  let railCollapsed = !!sizes.railCollapsed; // rail collapsed shut (gutter or chevron); persisted
  /** @type {HTMLElement[]} */
  let trackGutters = [];         // gutters currently overlaid on the grid
  let lastGutterKey = '';        // dims+orientation signature the gutters were built for

  // ---- watch-count (how many tiles to show) ----
  // The chosen count lives in our own LAYOUT_KEY blob (menu.js only knows its
  // legacy numeric `layout` setting). 'auto' fits as many tiles as comfortably
  // display for the current orientation. Default 'auto' on first run.
  // A ?watch=N URL param is a SESSION override (used by pop-out to force a single
  // tile) that wins over the persisted choice WITHOUT writing localStorage — so a
  // popped window can't bleed its count back into the main window's shared blob.
  let _watchUrlOverride = readWatchFromUrl();
  function readWatchFromUrl() {
    try {
      if (typeof location === 'undefined' || !location.search) return null;
      const raw = new URLSearchParams(location.search).get('watch');
      if (raw == null) return null;
      if (raw === WATCH_AUTO) return WATCH_AUTO;
      const n = Number(raw);
      return (n >= MIN_WATCH && n <= MAX_WATCH) ? n : null;
    } catch (_) { return null; }
  }
  /** @returns {number|string} */
  function watchChoice() {
    if (_watchUrlOverride != null) return _watchUrlOverride;
    const w = sizes.watchN;
    if (w === WATCH_AUTO) return WATCH_AUTO;
    const n = Number(w);
    return (n >= MIN_WATCH && n <= MAX_WATCH) ? n : WATCH_AUTO;
  }
  function setWatchChoice(v) {
    // an explicit pick from the dropdown/palette drops any URL session override.
    _watchUrlOverride = null;
    const next = v === WATCH_AUTO ? WATCH_AUTO : clamp(Number(v) || MIN_WATCH, MIN_WATCH, MAX_WATCH);
    if (sizes.watchN === next) return;
    sizes.watchN = next;
    saveSizes(LAYOUT_KEY, sizes);
  }
  // resolve the watch choice to a concrete tile count for the current viewport.
  function watchCount() {
    const w = watchChoice();
    if (w !== WATCH_AUTO) return w;
    return autoWatchCount();
  }
  // 'auto': as many tiles as comfortably fit — capped per orientation, and never
  // more than the number of active threads (so we don't show a wall of empties).
  function autoWatchCount() {
    const cap = isPortrait() ? AUTO_MAX_PORTRAIT : AUTO_MAX_LANDSCAPE;
    let active = 0;
    try { active = activeThreads().length; } catch (_) { active = 0; }
    return clamp(active || 1, MIN_WATCH, cap);
  }

  // ---- collapsed tile state (keyed by THREAD id so it survives reflows/reloads) ----
  // Persisted in the same LAYOUT_KEY blob as `collapsedThreads:[ids]`. A tile reads
  // its collapsed flag from this set whenever a thread is bound to it, so a collapsed
  // thread that scrolls out of the visible set and later returns stays collapsed.
  /** @type {Set<string>} */
  const collapsedThreads = new Set(Array.isArray(sizes.collapsedThreads) ? sizes.collapsedThreads : []);
  function isThreadCollapsed(tid) { return !!tid && collapsedThreads.has(tid); }
  function setThreadCollapsed(tid, on) {
    if (!tid) return;
    if (on === collapsedThreads.has(tid)) return;
    if (on) collapsedThreads.add(tid); else collapsedThreads.delete(tid);
    sizes.collapsedThreads = Array.from(collapsedThreads);
    saveSizes(LAYOUT_KEY, sizes);
  }

  // is the viewport portrait (taller than wide)? AUTO-DETECTED — drives the
  // landscape(more-cols) ↔ portrait(more-rows) arrangement in tilesToGrid. Uses
  // matchMedia('(orientation:portrait)') when available, with a dimensions check
  // as a fallback / cross-check (some embeds report a stale media query).
  function isPortrait() {
    try {
      if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        const mq = window.matchMedia('(orientation: portrait)');
        if (typeof mq.matches === 'boolean') return mq.matches;
      }
    } catch (_) {}
    try { return window.innerHeight > window.innerWidth; } catch (_) { return false; }
  }

  // A stable signature for the CURRENT arrangement (count + orientation), used for
  // the data-layout attribute, the track-storage key, and the gutter-rebuild key.
  // Replaces the old numeric/'vert' layout id. e.g. 'n4', or 'auto' when the
  // count is auto-resolved (the concrete dims still come from effDims()).
  function activeLayoutId() {
    const w = watchChoice();
    return w === WATCH_AUTO ? 'auto' : ('n' + w);
  }

  // effective cols×rows for the current watch-count, oriented by auto-detection.
  function effDims() {
    return tilesToGrid(watchCount(), isPortrait());
  }

  // number of tiles the grid shows (cols*rows ≥ watchCount; the slack cell, if any,
  // renders as an empty tile).
  function effSlots() {
    const d = effDims();
    return d.cols * d.rows;
  }

  // storage key for this arrangement's track sizes — keyed by the concrete dims +
  // orientation so each cols×rows shape (portrait/landscape) keeps independent
  // splits and they don't collide as the count changes.
  function trackKey() {
    const d = effDims();
    return 'grid' + d.cols + 'x' + d.rows + (isPortrait() ? 'P' : '');
  }

  // normalize a weight array to N tracks (default = equal fr), clamped each ≥ min.
  function normTracks(arr, n) {
    let a = Array.isArray(arr) && arr.length === n ? arr.slice() : null;
    if (!a) a = new Array(n).fill(1);
    const min = TRACK_MIN_FRAC * a.reduce((s, x) => s + (x > 0 ? x : 0), 0) / n;
    return a.map((x) => (x > min ? x : (min || 1)));
  }

  // which grid rows have EVERY one of their (existing) tiles collapsed? Such a row
  // shrinks to header height (min-content) so its space is handed to sibling rows.
  // Tiles fill the grid row-major: tile i sits at row floor(i/cols). A row counts
  // as fully-collapsed only if it has ≥1 tile AND all its tiles are collapsed.
  function fullyCollapsedRows(cols, rows) {
    const out = new Array(rows).fill(false);
    for (let r = 0; r < rows; r++) {
      let any = false, allCollapsed = true;
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (i >= tiles.length) continue;
        any = true;
        if (!tiles[i].collapsed) { allCollapsed = false; break; }
      }
      out[r] = any && allCollapsed;
    }
    return out;
  }

  // build the grid-template-{columns,rows} strings from persisted (or default) fr
  // weights and apply them inline (overriding the data-layout CSS defaults). Rows
  // whose tiles are all collapsed are pinned to min-content (header strip only); the
  // remaining fr weights stretch to fill the freed height.
  function applyGridTemplate() {
    const d = effDims();
    const k = trackKey();
    const store_ = sizes[k] || {};
    const colW = normTracks(store_.cols, d.cols);
    const rowW = normTracks(store_.rows, d.rows);
    grid.style.gridTemplateColumns = colW.map((w) => w + 'fr').join(' ');
    const collapsedRow = fullyCollapsedRows(d.cols, d.rows);
    grid.style.gridTemplateRows = rowW
      .map((w, r) => (collapsedRow[r] ? 'min-content' : w + 'fr'))
      .join(' ');
  }

  // read the live pixel sizes of the grid's tracks (used as drag baselines).
  function trackPx(which) {
    try {
      const cs = getComputedStyle(grid);
      return (which === 'cols' ? cs.gridTemplateColumns : cs.gridTemplateRows)
        .split(' ').map(parseFloat).filter((x) => !isNaN(x));
    } catch (_) { return []; }
  }

  // remove any existing track gutters from the grid.
  function clearTrackGutters() {
    for (const g of trackGutters) { try { g.remove(); } catch (_) {} }
    trackGutters = [];
  }

  // (re)create the internal track gutters for the current dims. Vertical gutters
  // sit on each column boundary, horizontal gutters on each row boundary. They are
  // absolutely-positioned overlays (so they don't perturb the tile grid items or
  // the .mos-tile counting / :not(.is-max) selectors).
  function buildTrackGutters() {
    clearTrackGutters();
    const d = effDims();
    // no internal boundaries to drag when maximized or single-track each way.
    if (maximizedTileIdx >= 0) { lastGutterKey = ''; return; }
    // column boundaries: between track i and i+1 (i = 0..cols-2)
    for (let i = 0; i < d.cols - 1; i++) {
      const g = makeGutter('x');
      g.classList.add('mos-track-gutter', 'mos-track-col');
      g.dataset.boundary = String(i);
      grid.appendChild(g);
      wireColGutter(g, i);
      trackGutters.push(g);
    }
    // row boundaries
    for (let j = 0; j < d.rows - 1; j++) {
      const g = makeGutter('y');
      g.classList.add('mos-track-gutter', 'mos-track-row');
      g.dataset.boundary = String(j);
      grid.appendChild(g);
      wireRowGutter(g, j);
      trackGutters.push(g);
    }
    positionTrackGutters();
    lastGutterKey = gutterKey();
  }

  // signature that determines when gutters must be rebuilt (dims + orientation + max)
  function gutterKey() {
    const d = effDims();
    return activeLayoutId() + ':' + d.cols + 'x' + d.rows + ':' + (maximizedTileIdx >= 0 ? 'max' : '-');
  }

  // place each overlay gutter at its track boundary using live track pixel sizes.
  function positionTrackGutters() {
    if (!trackGutters.length) return;
    const cols = trackPx('cols');
    const rows = trackPx('rows');
    let gap = 0;
    try { gap = parseFloat(getComputedStyle(grid).gap) || 0; } catch (_) {}
    for (const g of trackGutters) {
      const i = Number(g.dataset.boundary);
      if (g.classList.contains('mos-track-col')) {
        // x position = sum of col widths 0..i + gaps + half the gap gutter sits in
        let x = 0;
        for (let k = 0; k <= i; k++) x += (cols[k] || 0) + (k < i ? gap : 0);
        g.style.left = (x + gap / 2) + 'px';
        g.style.top = '0';
      } else {
        let y = 0;
        for (let k = 0; k <= i; k++) y += (rows[k] || 0) + (k < i ? gap : 0);
        g.style.top = (y + gap / 2) + 'px';
        g.style.left = '0';
      }
    }
  }

  // wire a column-boundary gutter: shift fr weight between track i and i+1.
  function wireColGutter(g, i) {
    let baseW = [], totalPx = 0, totalFr = 0;
    attachDrag(g, {
      axis: 'x',
      onStart: () => {
        baseW = trackPx('cols');
        totalPx = baseW.reduce((s, x) => s + x, 0) || 1;
        const k = trackKey();
        totalFr = normTracks((sizes[k] || {}).cols, baseW.length).reduce((s, x) => s + x, 0) || baseW.length;
      },
      onDelta: (dx) => {
        const a = baseW[i], b = baseW[i + 1];
        if (a == null || b == null) return;
        const minPx = TRACK_MIN_FRAC * totalPx;
        const na = clamp(a + dx, minPx, a + b - minPx);
        const nb = a + b - na;
        // convert the two adjusted px widths back to fr (px→fr via totalFr/totalPx)
        const k2px2fr = totalFr / totalPx;
        const next = baseW.map((w, idx) => (idx === i ? na : idx === i + 1 ? nb : w) * k2px2fr);
        grid.style.gridTemplateColumns = next.map((w) => w + 'fr').join(' ');
        positionTrackGutters();
      },
      onEnd: () => persistTracks('cols'),
    });
    g.addEventListener('dblclick', () => resetTracks());
  }

  // wire a row-boundary gutter: shift fr weight between row j and j+1.
  function wireRowGutter(g, j) {
    let baseH = [], totalPx = 0, totalFr = 0;
    attachDrag(g, {
      axis: 'y',
      onStart: () => {
        baseH = trackPx('rows');
        totalPx = baseH.reduce((s, x) => s + x, 0) || 1;
        const k = trackKey();
        totalFr = normTracks((sizes[k] || {}).rows, baseH.length).reduce((s, x) => s + x, 0) || baseH.length;
      },
      onDelta: (dx, dy) => {  // y-axis gutter → vertical delta is the SECOND arg (H9; same class as the ide.js terminal-drag bug)
        const a = baseH[j], b = baseH[j + 1];
        if (a == null || b == null) return;
        const minPx = TRACK_MIN_FRAC * totalPx;
        const na = clamp(a + dy, minPx, a + b - minPx);
        const nb = a + b - na;
        const px2fr = totalFr / totalPx;
        const next = baseH.map((w, idx) => (idx === j ? na : idx === j + 1 ? nb : w) * px2fr);
        grid.style.gridTemplateRows = next.map((w) => w + 'fr').join(' ');
        positionTrackGutters();
      },
      onEnd: () => persistTracks('rows'),
    });
    g.addEventListener('dblclick', () => resetTracks());
  }

  // persist current live track fr weights for the active layout's track key.
  function persistTracks(which) {
    const k = trackKey();
    const cur = sizes[k] || {};
    if (which === 'cols' || which == null) {
      const px = trackPx('cols'); const tot = px.reduce((s, x) => s + x, 0) || 1;
      cur.cols = px.map((w) => (w / tot) * px.length);
    }
    if (which === 'rows' || which == null) {
      const d = effDims();
      const collapsedRow = fullyCollapsedRows(d.cols, d.rows);
      const px = trackPx('rows'); const tot = px.reduce((s, x) => s + x, 0) || 1;
      const prev = normTracks(cur.rows, px.length);
      // keep a collapsed row's stored fr (its live px is just the header strip and
      // would otherwise be saved as a near-zero weight, corrupting the expand layout).
      cur.rows = px.map((w, r) => (collapsedRow[r] ? prev[r] : (w / tot) * px.length));
    }
    sizes[k] = cur;
    saveSizes(LAYOUT_KEY, sizes);
  }

  // double-click reset: drop this layout's persisted tracks back to equal fr.
  function resetTracks() {
    const k = trackKey();
    delete sizes[k];
    saveSizes(LAYOUT_KEY, sizes);
    applyGridTemplate();
    positionTrackGutters();
  }

  // ---- rail width gutter ----
  function applyRailWidth() {
    if (railCollapsed) {
      // settled-collapsed: drop inline width so the CSS rib width (a thin re-open
      // strip) wins; the header/body hide and only .mos-rail-rib shows.
      rail.style.width = '';
      rail.classList.add('mos-rail-collapsed');
      rail.classList.remove('mos-rail-collapsing');
      return;
    }
    rail.classList.remove('mos-rail-collapsed');
    const w = sizes.railW;
    if (typeof w === 'number') rail.style.width = clamp(w, RAIL_MIN, RAIL_MAX) + 'px';
    else rail.style.width = '';
  }
  // explicit collapse/expand (rail header chevron + rib). Persists the choice.
  function setRailCollapsed(on) {
    if (railCollapsed === !!on) return;
    railCollapsed = !!on;
    if (railCollapsed) sizes.railCollapsed = true; else delete sizes.railCollapsed;
    saveSizes(LAYOUT_KEY, sizes);
    applyRailWidth();
  }
  (function wireRailGutter() {
    let startW = 0;
    attachDrag(railGutter, {
      axis: 'x',
      onStart: () => { startW = rail.getBoundingClientRect().width || RAIL_MIN; railCollapsed = false; },
      onDelta: (dx) => {
        // rail is to the RIGHT of the gutter: dragging left (dx<0) widens it.
        const raw = startW - dx;
        if (raw < RAIL_MIN * 0.6) { rail.style.width = '0px'; rail.classList.add('mos-rail-collapsing'); return; }
        rail.classList.remove('mos-rail-collapsing');
        rail.style.width = clamp(raw, RAIL_MIN, RAIL_MAX) + 'px';
      },
      onEnd: () => {
        const w = rail.getBoundingClientRect().width;
        if (w < RAIL_MIN * 0.6) { railCollapsed = true; sizes.railW = RAIL_MIN; sizes.railCollapsed = true; rail.classList.add('mos-rail-collapsed'); }
        else { railCollapsed = false; delete sizes.railCollapsed; sizes.railW = clamp(w, RAIL_MIN, RAIL_MAX); }
        rail.classList.remove('mos-rail-collapsing');
        saveSizes(LAYOUT_KEY, sizes);
        applyRailWidth();
      },
    });
    railGutter.addEventListener('dblclick', () => {
      railCollapsed = false; delete sizes.railCollapsed; delete sizes.railW; saveSizes(LAYOUT_KEY, sizes); applyRailWidth();
    });
  })();

  // rebuild gutters + re-apply templates when the layout/orientation changes.
  function syncGutters() {
    applyGridTemplate();
    if (gutterKey() !== lastGutterKey) buildTrackGutters();
    else positionTrackGutters();
    // the rail gutter only matters when the rail is visible.
    railGutter.style.display = rail.classList.contains('hidden') ? 'none' : '';
    applyRailWidth();
  }

  // viewport resize: re-evaluate orientation + auto tile-count, then re-arrange.
  let _roTimer = null;
  function onViewportResize() {
    if (_roTimer) clearTimeout(_roTimer);
    _roTimer = setTimeout(() => { _roTimer = null; reflow(true); }, 120);
  }

  // ---------------------------------------------------------------- create a tile
  function createTile() {
    const elTile = el('div', 'mos-tile');
    const chrome = el('div', 'mos-tile-chrome');
    const dotEl = el('span', 't-dot');
    const titleEl = el('span', 't-title', '—');
    const subEl = el('span', 't-sub', '');
    const spacer = el('span', 't-spacer');
    const ctrlsWrap = el('span', 'mos-tile-ctrls');

    // IDE/raw toggle pill
    const viewtoggle = el('span', 'mos-viewtoggle');
    const vbIde = el('button', null, 'ide'); vbIde.title = 'IDE surface';
    const vbRaw = el('button', null, 'raw'); vbRaw.title = 'raw tmux screen';
    viewtoggle.append(vbIde, vbRaw);

    const cMax = ctrlBtn('max', '⛶', 'maximize / restore');
    const cPin = ctrlBtn('pin', '📌', 'pin (opt out of auto-switch)');
    const cFreeze = ctrlBtn('freeze', '❄', 'freeze (snapshot — stub)');
    const cFlag = ctrlBtn('flag', '⚑', 'flag (stub)');
    const cPop = ctrlBtn('popout', '⧉', 'pop out to new window');
    const cCollapse = ctrlBtn('collapse', '▾', 'collapse / expand this tile');

    ctrlsWrap.append(viewtoggle, cPin.b, cFreeze.b, cFlag.b, cPop.b, cMax.b, cCollapse.b);
    chrome.append(dotEl, titleEl, subEl, spacer, ctrlsWrap);

    const bodyEl = el('div', 'mos-tile-body');
    const fanoutEl = el('div', 'mos-fanout collapsed');
    const paneEl = el('div', 'mos-tile-pane');
    bodyEl.append(fanoutEl, paneEl);

    elTile.append(chrome, bodyEl);
    grid.append(elTile);

    /** @type {Tile} */
    const tile = {
      elTile, chrome, titleEl, subEl, dotEl, fanoutEl, bodyEl, paneEl,
      pane: null, usingIde: false,
      threadId: null,
      pinned: false, frozen: false, flagged: false, collapsed: false,
      viewMode: menu ? menu.effDefaultView() : 'ide',
      watchingScreen: false, watchSession: null,
      ctrls: { vbIde, vbRaw, cMax, cPin, cFreeze, cFlag, cPop, cCollapse },
      fb: null,
      subEls: new Map(),
    };

    const idx = () => tiles.indexOf(tile);
    elTile.addEventListener('mousedown', () => { focusedTileIdx = idx(); reflectFocusBorders(); }, true);
    vbIde.addEventListener('click', () => setTileView(tile, 'ide'));
    vbRaw.addEventListener('click', () => setTileView(tile, 'raw'));
    cMax.b.addEventListener('click', () => toggleMaximizeTile(idx()));
    cPin.b.addEventListener('click', () => { tile.pinned = !tile.pinned; annotate(tile, tile.pinned ? 'pin' : 'unpin'); syncChrome(tile); });
    cFreeze.b.addEventListener('click', () => { tile.frozen = !tile.frozen; annotate(tile, tile.frozen ? 'freeze' : 'unfreeze'); syncChrome(tile); });
    cFlag.b.addEventListener('click', () => { tile.flagged = !tile.flagged; annotate(tile, tile.flagged ? 'flag' : 'unflag'); syncChrome(tile); });
    cPop.b.addEventListener('click', () => popOutThread(tile.threadId));
    cCollapse.b.addEventListener('click', () => toggleCollapse(tile));

    tiles.push(tile);
    return tile;
  }

  function ctrlBtn(kind, glyph, title) {
    const b = el('button', 'mos-ctrl ' + kind, glyph);
    b.title = title;
    return { b };
  }

  // ---------------------------------------------------------------- bind a thread to a tile
  function bindTile(tile, threadId) {
    if (tile.threadId === threadId) {
      // same thread re-bound: keep collapsed state in sync with the persisted set
      // (e.g. it was collapsed elsewhere) without disturbing the surface.
      tile.collapsed = isThreadCollapsed(threadId);
      syncChrome(tile);
      return;
    }
    // stop any screen watch tied to the old thread
    stopWatch(tile);
    tile.threadId = threadId;
    tile.frozen = false; // re-binding clears a frozen snapshot intent
    // restore collapsed state for the newly-bound thread (a collapsed thread that
    // left the visible set and returns stays collapsed; empty tiles are expanded).
    tile.collapsed = isThreadCollapsed(threadId);

    if (threadId == null) {
      teardownPane(tile);
      tile.paneEl.innerHTML = '';
      tile.paneEl.append(el('div', 'mos-tile-empty', 'no active thread'));
      syncChrome(tile);
      return;
    }

    // (re)build the surface for the current viewMode
    rebuildSurface(tile);
    syncChrome(tile);
  }

  // build whichever surface matches tile.viewMode: ide-pane (or fallback) vs raw screen
  function rebuildSurface(tile) {
    if (tile.threadId == null) return;
    if (tile.viewMode === 'raw') {
      teardownPane(tile);
      stopWatch(tile); // will restart against the (possibly new) lead session
      mountRawScreen(tile);
    } else {
      stopWatch(tile);
      mountIde(tile);
    }
  }

  // mount (or rebind) the IDE pane. Lazy-loads ide.js; falls back if unavailable.
  function mountIde(tile) {
    const threadId = tile.threadId;
    if (tile.pane && tile.usingIde && typeof tile.pane.setThread === 'function') {
      // reuse the existing ide pane — just retarget it (cheap, no teardown).
      try { tile.pane.setThread(threadId); } catch (e) { console.error('[mosaic] setThread threw', e); }
      ensurePaneVisible(tile);
      return;
    }
    // need a fresh pane area
    teardownPane(tile);
    tile.paneEl.innerHTML = '';
    // optimistic fallback first so something paints immediately, then upgrade.
    mountFallback(tile);
    loadIde().then((mountIdePane) => {
      if (tile.threadId !== threadId || tile.viewMode !== 'ide') return; // re-bound meanwhile
      if (!mountIdePane) return; // stay on fallback
      // swap fallback -> ide
      teardownPane(tile);
      tile.paneEl.innerHTML = '';
      let inst = null;
      try {
        inst = mountIdePane(tile.paneEl, store, { threadId, getToken });
      } catch (e) {
        console.error('[mosaic] mountIdePane threw; staying on fallback', e);
        mountFallback(tile);
        return;
      }
      if (inst && (typeof inst.destroy === 'function' || typeof inst.setThread === 'function')) {
        tile.pane = inst; tile.usingIde = true;
      } else {
        // ide.js returned something unexpected; fall back.
        mountFallback(tile);
      }
    });
  }

  function ensurePaneVisible(tile) {
    // when reusing an ide pane that was hidden by a raw-screen swap (defensive)
    if (tile.usingIde && tile.pane && tile.paneEl.childElementCount === 0) {
      // pane lost its DOM somehow; rebuild
      tile.pane = null; tile.usingIde = false; mountIde(tile);
    }
  }

  // ---- lightweight fallback surface (standalone, no ide.js) ----
  function mountFallback(tile) {
    teardownPane(tile);
    tile.usingIde = false;
    tile.paneEl.innerHTML = '';
    const wrap = el('div', 'mos-fallback');
    const fileLine = el('div', 'fb-file');
    const fbSurface = el('span', 'fb-surface', '');
    const fbFile = el('span', 'fb-fname', '');
    fileLine.append(fbSurface, fbFile);
    const busy = el('div', 'fb-busy');
    busy.append(el('span', 'dot'), el('span', 'fb-busy-label', ''));
    const acts = el('div', 'fb-acts');
    wrap.append(fileLine, busy, acts);
    tile.paneEl.append(wrap);
    tile.fb = { wrap, fbSurface, fbFile, busy, busyLabel: busy.lastChild, acts, rows: new Map() };
    renderFallback(tile);
  }

  function renderFallback(tile) {
    if (!tile.fb || tile.usingIde || tile.viewMode !== 'ide' || tile.threadId == null) return;
    const lead = leadSession(tile.threadId);
    if (!lead) {
      tile.fb.fbSurface.textContent = '';
      tile.fb.fbFile.textContent = '(no live session)';
      tile.fb.busy.style.display = 'none';
      return;
    }
    tile.fb.fbSurface.textContent = lead.current_surface || '';
    tile.fb.fbFile.textContent = lead.current_file ? baseName(lead.current_file) : (lead.name || '');
    tile.fb.fbFile.title = lead.current_file || '';
    const isBusy = lead.status === 'busy';
    tile.fb.busy.style.display = isBusy ? '' : 'none';
    tile.fb.busyLabel.textContent = isBusy ? 'working…' : '';
    // last few activities
    let ring = [];
    try { ring = store.activitiesForSession(lead.id) || []; } catch (_) {}
    const tail = ring.slice(-12);
    const acts = tile.fb.acts;
    // simple append-reconcile by seq
    const have = tile.fb.rows;
    for (const a of tail) {
      if (have.has(String(a.seq))) continue;
      const row = el('div', 'fb-act');
      row.append(el('span', 'fb-ts', fmtTime(a.ts)));
      row.append(el('span', 'fb-tool', a.tool || a.kind || '?'));
      const det = a.file_path ? baseName(a.file_path) : (a.detail ? shorten(a.detail, 48) : '');
      if (det) row.append(el('span', 'fb-det', det));
      acts.append(row);
      have.set(String(a.seq), row);
    }
    while (acts.childElementCount > 12 && acts.firstElementChild) {
      const first = acts.firstElementChild;
      for (const [k, v] of have) if (v === first) { have.delete(k); break; }
      first.remove();
    }
    acts.scrollTop = acts.scrollHeight;
  }

  // ---- raw tmux screen mirror ----
  function mountRawScreen(tile) {
    teardownPane(tile);
    tile.usingIde = false;
    tile.paneEl.innerHTML = '';
    const pre = el('pre', 'mos-screen waiting', 'raw screen — requesting frames…');
    tile.paneEl.append(pre);
    tile.fb = null;
    startWatch(tile);
    renderScreen(tile);
  }

  // start streaming the raw tmux screen for this tile's lead session.
  // Prefer the client.watchScreen(sid) helper (ide.js + parent convention); fall
  // back to the raw {t:'watch_screen'} envelope from the schema if absent.
  function startWatch(tile) {
    const lead = leadSession(tile.threadId);
    const sid = lead && lead.id;
    if (!sid) return;
    tile.watchSession = sid;
    tile.watchingScreen = true;
    const client = getClient();
    if (!client) return;
    if (typeof client.watchScreen === 'function') { try { client.watchScreen(sid); return; } catch (_) {} }
    if (typeof client.send === 'function') { try { client.send({ t: 'watch_screen', session_id: sid }); } catch (_) {} }
  }
  function stopWatch(tile) {
    if (!tile.watchingScreen) return;
    const sid = tile.watchSession;
    tile.watchingScreen = false;
    tile.watchSession = null;
    const client = getClient();
    if (!client || !sid) return;
    if (typeof client.unwatchScreen === 'function') { try { client.unwatchScreen(sid); return; } catch (_) {} }
    if (typeof client.send === 'function') { try { client.send({ t: 'unwatch_screen', session_id: sid }); } catch (_) {} }
  }

  // Render the latest screen frame for the watched session, if the store carries
  // one. The store (slice-1) does not yet index Screen events; we read defensively
  // from a few likely locations so this lights up the moment the store/ide adds it.
  function renderScreen(tile) {
    if (tile.viewMode !== 'raw') return;
    const pre = tile.paneEl.querySelector('.mos-screen');
    if (!pre) return;
    const sid = tile.watchSession || (leadSession(tile.threadId) || {}).id;
    const frame = latestScreenFrame(sid);
    if (frame && typeof frame.data === 'string') {
      pre.classList.remove('waiting');
      const txt = stripAnsi(frame.data);
      if (pre.textContent !== txt) pre.textContent = txt;
    } else if (!pre.classList.contains('waiting')) {
      // keep last frame; do nothing
    } else {
      pre.textContent = sid
        ? 'raw screen — watching ' + sid.slice(0, 8) + ' (no frames yet)'
        : 'raw screen — no live session';
    }
  }

  // best-effort: find the most recent Screen frame for a session in the store.
  // Primary source is the selector ide.js + the parent code to:
  //   store.screenForSession(sessionId) -> latest Screen frame (or undefined).
  // We also probe a couple of plausible state-map shapes for forward-compat so
  // this lights up regardless of how the parent lands screen indexing.
  function latestScreenFrame(sid) {
    if (!sid) return null;
    if (typeof store.screenForSession === 'function') {
      try { const v = store.screenForSession(sid); if (v) return v; } catch (_) {}
    }
    let st;
    try { st = store.getState(); } catch (_) { return null; }
    if (!st) return null;
    //   st.screens / st.screen: Map<sessionId, {data,...}> (latest frame per session)
    const m = st.screens || st.screen;
    if (m && typeof m.get === 'function') {
      const v = m.get(sid);
      if (v) return v;
    }
    return null;
  }

  function teardownPane(tile) {
    if (tile.pane && typeof tile.pane.destroy === 'function') {
      try { tile.pane.destroy(); } catch (e) { console.error('[mosaic] pane.destroy threw', e); }
    }
    tile.pane = null;
    tile.usingIde = false;
    tile.fb = null;
  }

  // ---------------------------------------------------------------- per-tile view toggle
  function setTileView(tile, mode) {
    if (tile.viewMode === mode) return;
    tile.viewMode = mode;
    // try to delegate to the ide pane if it supports a raw toggle (forward-compat),
    // otherwise we own the swap.
    if (mode === 'raw') {
      // if ide pane exposes a setView/raw, prefer it; else mount our mirror.
      if (tile.usingIde && tile.pane && typeof tile.pane.setView === 'function') {
        try { tile.pane.setView('raw'); syncChrome(tile); return; } catch (_) {}
      }
      mountRawScreen(tile);
    } else {
      if (tile.usingIde && tile.pane && typeof tile.pane.setView === 'function') {
        try { tile.pane.setView('ide'); syncChrome(tile); return; } catch (_) {}
      }
      // leaving raw → release the screen watch we held, then (re)mount the IDE.
      stopWatch(tile);
      mountIde(tile);
    }
    // reflect focused-tile view to URL when it's the focused tile
    if (tiles.indexOf(tile) === focusedTileIdx) menu.setView({ view: mode });
    syncChrome(tile);
  }

  // ---------------------------------------------------------------- chrome sync
  function syncChrome(tile) {
    const th = tile.threadId && store.thread(tile.threadId);
    const ss = tile.threadId ? safeSessions(tile.threadId) : [];
    const lead = leadSession(tile.threadId);
    const status = lead ? lead.status : 'ended';
    tile.dotEl.className = 't-dot ' + (status || 'ended');
    tile.titleEl.textContent = th ? (th.title || th.id) : '—';
    tile.titleEl.title = th ? (th.title || th.id) : '';
    // subline: project · current surface/file · chain
    const proj = (th && th.project) || (lead && lead.project) || '';
    const file = lead && lead.current_file ? baseName(lead.current_file) : '';
    const surf = lead && lead.current_surface ? lead.current_surface : '';
    const parts = [];
    if (proj) parts.push(proj);
    if (surf || file) parts.push((surf ? surf + ' ' : '') + file);
    tile.subEl.innerHTML = '';
    tile.subEl.append(document.createTextNode(parts.join(' · ')));
    if (ss.length > 1) {
      const chain = ss.map((s) => s && (s.name || (s.id || '').slice(0, 6))).filter(Boolean).join('→');
      const c = el('span', 't-chain', '  ' + chain);
      tile.subEl.append(c);
    }
    // control states
    tile.ctrls.cPin.b.classList.toggle('on', tile.pinned);
    tile.ctrls.cFreeze.b.classList.toggle('on', tile.frozen);
    tile.ctrls.cFlag.b.classList.toggle('on', tile.flagged);
    tile.ctrls.vbIde.setAttribute('aria-pressed', String(tile.viewMode === 'ide'));
    tile.ctrls.vbRaw.setAttribute('aria-pressed', String(tile.viewMode === 'raw'));
    tile.elTile.classList.toggle('is-pinned', tile.pinned);
    tile.elTile.classList.toggle('is-frozen', tile.frozen);
    tile.elTile.classList.toggle('is-flagged', tile.flagged);
    // collapsed: hide the body (CSS), flip the chevron glyph (▾ open / ▸ shut).
    tile.elTile.classList.toggle('is-collapsed', tile.collapsed);
    const col = tile.ctrls.cCollapse.b;
    col.classList.toggle('on', tile.collapsed);
    col.textContent = tile.collapsed ? '▸' : '▾';
    col.title = tile.collapsed ? 'expand this tile' : 'collapse this tile';
  }

  // ---------------------------------------------------------------- fan-out strip
  function renderFanout(tile) {
    const lead = leadSession(tile.threadId);
    const subs = (lead && Array.isArray(lead.subagents)) ? lead.subagents : [];
    const fo = tile.fanoutEl;
    if (!subs.length) {
      // auto-collapse when no active sub-agents
      if (!fo.classList.contains('collapsed')) { fo.classList.add('collapsed'); fo.innerHTML = ''; tile.subEls.clear(); }
      return;
    }
    fo.classList.remove('collapsed');
    // header label (built once)
    if (!fo.firstChild || !fo.querySelector('.fo-label')) {
      fo.innerHTML = '';
      tile.subEls.clear();
      const lab = el('span', 'fo-label');
      lab.append(document.createTextNode('fan-out '), el('b', null, ''));
      fo.append(lab);
    }
    const labCount = fo.querySelector('.fo-label b');
    if (labCount) labCount.textContent = '×' + subs.length;

    // reconcile chips by subagent id
    const present = new Set(subs);
    // mark removed (done) as faded, then drop after they've been seen idle once
    for (const [id, chip] of tile.subEls) {
      if (!present.has(id)) {
        chip.classList.add('done');
        // remove fully on the next pass to give a brief "done" flash
        if (chip.dataset.seenDone === '1') { chip.remove(); tile.subEls.delete(id); }
        else chip.dataset.seenDone = '1';
      }
    }
    for (const id of subs) {
      let chip = tile.subEls.get(id);
      if (!chip) {
        chip = el('div', 'mos-subtile');
        chip.append(el('span', 'sa-dot'));
        chip.append(el('span', 'sa-id', shorten(id, 14)));
        chip.append(el('span', 'sa-act', ''));
        fo.append(chip);
        tile.subEls.set(id, chip);
      } else {
        chip.classList.remove('done');
        delete chip.dataset.seenDone;
      }
      // best-effort: show the sub-agent's most recent activity detail
      const act = latestSubActivity(lead.id, id);
      const actEl = chip.querySelector('.sa-act');
      if (actEl) {
        const txt = act ? (act.tool || act.kind || '') + (act.file_path ? ' ' + baseName(act.file_path) : (act.detail ? ' ' + shorten(act.detail, 30) : '')) : '';
        if (actEl.textContent !== txt) actEl.textContent = txt;
      }
    }
  }

  // most recent activity attributed to a given sub-agent id within a session ring
  function latestSubActivity(sessionId, agentId) {
    let ring = [];
    try { ring = store.activitiesForSession(sessionId) || []; } catch (_) { return null; }
    for (let i = ring.length - 1; i >= 0; i--) {
      if (ring[i].agent_id === agentId) return ring[i];
    }
    return null;
  }

  // ================================================================ thread selection
  // The lead session of a thread (or its newest known session).
  function leadSession(threadId) {
    if (!threadId) return null;
    const th = store.thread(threadId);
    if (!th) return null;
    if (th.lead_session_id) {
      const s = store.session(th.lead_session_id);
      if (s) return s;
    }
    const ss = safeSessions(threadId);
    return ss.length ? ss[ss.length - 1] : null;
  }
  function safeSessions(threadId) {
    try { return store.sessionsForThread(threadId) || []; } catch (_) { return []; }
  }

  // recency for a thread (max updated_at across thread + its lead session)
  function threadRecency(th) {
    let r = th.updated_at || 0;
    const lead = leadSession(th.id);
    if (lead && lead.updated_at) r = Math.max(r, lead.updated_at);
    return r;
  }
  function threadStatusRank(th) {
    const lead = leadSession(th.id);
    return STATUS_RANK[lead && lead.status] ?? 3;
  }

  // ---- actively-editing signal ----------------------------------------------
  // The recency (ts, seconds) of a thread's lead session's NEWEST edit/write
  // activity — i.e. when it last GENERATED CODE. 0 = never. We scan the lead
  // session's bounded activity ring from the tail (newest first). Memoized per
  // reflow generation so the several activeThreads()/ranking calls per change
  // don't re-walk rings (Principle VII).
  let _editGen = 0;                 // bumped each onChange/reflow pass
  const _editMemo = new Map();      // threadId -> { gen, ts }
  function bumpEditGen() { _editGen++; }
  function threadEditRecency(th) {
    if (!th) return 0;
    const memo = _editMemo.get(th.id);
    if (memo && memo.gen === _editGen) return memo.ts;
    const lead = leadSession(th.id);
    let ts = 0;
    if (lead) {
      let ring = [];
      try { ring = store.activitiesForSession(lead.id) || []; } catch (_) { ring = []; }
      for (let i = ring.length - 1; i >= 0; i--) {
        const a = ring[i];
        if (a && EDIT_KINDS[a.kind]) { ts = a.ts || 0; break; }
      }
    }
    _editMemo.set(th.id, { gen: _editGen, ts });
    return ts;
  }
  // is this thread editing code RIGHT NOW (newest edit/write within the window)?
  function isActivelyEditing(th) {
    const ts = threadEditRecency(th);
    if (!ts) return false;
    return (nowS() - ts) <= EDIT_ACTIVE_WINDOW_S;
  }
  function nowS() { return Date.now() / 1000; }
  // 3-tier activity rank: actively-editing (0) > busy (1) > idle/ended (2).
  function threadActivityRank(th) {
    if (isActivelyEditing(th)) return 0;
    return threadStatusRank(th) === 0 ? 1 : 2; // busy=1, idle/ended=2
  }

  // ACTIVE threads = have at least one non-ended session. Ranking (requirement):
  // actively-editing recency desc → busy>idle>ended → recency desc. So when more
  // threads are active than the layout shows cleanly, the one(s) GENERATING CODE
  // win the visible grid slots and the rest overflow to the rail.
  function activeThreads() {
    let list = [];
    try { list = store.threadsList() || []; } catch (_) { return []; }
    const act = list.filter((th) => {
      const ss = safeSessions(th.id);
      return ss.some((s) => s && (s.status === 'busy' || s.status === 'idle'));
    });
    act.sort((a, b) => {
      // 1) actively-editing recency desc (a fresh edit/write outranks plain-busy).
      const ea = threadEditRecency(a), eb = threadEditRecency(b);
      const aAct = (nowS() - ea) <= EDIT_ACTIVE_WINDOW_S && ea > 0;
      const bAct = (nowS() - eb) <= EDIT_ACTIVE_WINDOW_S && eb > 0;
      if (aAct !== bAct) return aAct ? -1 : 1;        // any active-editor first
      if (aAct && bAct && eb !== ea) return eb - ea;  // freshest edit first
      // 2) busy > idle > ended
      const r = threadStatusRank(a) - threadStatusRank(b);
      if (r) return r;
      // 3) recency
      return threadRecency(b) - threadRecency(a);
    });
    // if nothing is active (all ended / empty), fall back to most-recent threads
    if (!act.length && list.length) {
      return list.slice(0, 6);
    }
    return act;
  }

  // The single thread that should hold the primary/largest slot in follow-latest:
  // the actively-editing thread with the freshest edit. null if none is editing.
  function primaryEditingThread(ranked) {
    let best = null, bestTs = 0;
    for (const th of ranked) {
      const ts = threadEditRecency(th);
      if (ts && (nowS() - ts) <= EDIT_ACTIVE_WINDOW_S && ts > bestTs) { best = th; bestTs = ts; }
    }
    return best;
  }

  // ================================================================ reflow
  let lastReflowSig = '';
  function reflow(force) {
    bumpEditGen();                 // invalidate the per-pass edit-recency memo
    const layout = activeLayoutId();
    const mode = menu.effMode();
    const ranked = activeThreads();

    // ---- decide which threads occupy the visible tiles ----
    // The decision is a PURE function (web/assign.js), unit-tested headless via
    // `node --test web/assign.test.mjs` — Principle VII (bounded render: result is
    // always ≤ slots) + Principle IX (behavior gated, not just syntax). KEY RULE:
    // AUTO-assignment shows each PROJECT at most once ("one panel per project");
    // explicit pins/frozen and operator-driven manual bindings may repeat.
    const slots = effSlots();
    const editLead = primaryEditingThread(ranked);
    const { visible, usedThreadIds: _usedList } = assignSlots({
      slots,
      mode,
      ranked,
      tiles: tiles.map((t) => ({ threadId: t.threadId, pinned: t.pinned, frozen: t.frozen })),
      forcedThread: (menu.view && menu.view.thread) || null,
      editLeadId: editLead ? editLead.id : null,
    });
    const usedThreadIds = new Set(_usedList);

    // ---- ensure we have exactly `slots` tiles ----
    while (tiles.length < slots) createTile();
    while (tiles.length > slots) {
      const t = tiles.pop();
      if (t) { stopWatch(t); teardownPane(t); t.elTile.remove(); }
    }
    // data-layout reflects the arrangement signature ('n4' / 'auto'); data-cols/-rows
    // give the concrete (orientation-detected) track counts the CSS fallback uses
    // before JS writes inline fr weights.
    const dims = effDims();
    grid.setAttribute('data-layout', String(layout));
    grid.setAttribute('data-cols', String(dims.cols));
    grid.setAttribute('data-rows', String(dims.rows));

    // ---- bind tiles to chosen threads (reconcile, minimal churn) ----
    for (let i = 0; i < slots; i++) {
      const tile = tiles[i];
      const want = visible[i] != null ? visible[i] : null;
      bindTile(tile, want);
    }

    // ---- overflow rail: active threads not shown in a tile ----
    const overflow = ranked.filter((th) => !usedThreadIds.has(th.id));
    renderRail(overflow);

    // clamp focus/maximize indices
    if (focusedTileIdx >= slots) focusedTileIdx = 0;
    if (maximizedTileIdx >= slots) maximizedTileIdx = -1;

    // ---- fewer-but-larger: emphasise the actively-edited tile ----
    // Mark which visible tiles are GENERATING CODE (drives the ✎ accent), and in
    // follow-latest mode auto-focus the sole active editor so it gets the primary/
    // largest treatment when we can't show every active thread cleanly. This is
    // subordinate to an explicit maximize (we never move focus while maximized) and
    // only runs in 'focus' mode (manual/per-tile leave operator focus alone).
    applyEditingEmphasis(mode, ranked);

    // mobile: clamp index + bind the single active tile
    syncMobile(ranked);

    reflectFocusBorders();
    applyMaximize();

    // size tracks + (re)build internal track gutters for the current dims, then the
    // rail gutter / rail width. applyMaximize ran first so gutterKey sees max state.
    syncGutters();

    lastReflowSig = sigOf(visible, layout, mode);
  }

  function sigOf(visible, layout, mode) {
    return layout + '|' + mode + '|' + visible.join(',');
  }

  // ---------------------------------------------------------------- overflow rail
  function renderRail(overflow) {
    const show = menu.settings.showRail && overflow.length > 0;
    rail.classList.toggle('hidden', !show);
    railToggle.setAttribute('aria-pressed', String(menu.settings.showRail));
    railCount.textContent = overflow.length ? ' +' + overflow.length : '';
    if (!show) { railBody.innerHTML = ''; return; }
    // simple rebuild (small list); reconcile would be overkill for the rail.
    railBody.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const th of overflow) {
      const lead = leadSession(th.id);
      const item = el('div', 'mos-rail-item');
      item.title = 'click to focus this thread';
      const dot = el('span', 'r-dot ' + ((lead && lead.status) || 'ended'));
      const name = el('span', 'r-name', th.title || th.id);
      const meta = el('span', 'r-meta', (lead && lead.project) || '');
      item.append(dot, name, meta);
      item.addEventListener('click', () => focusThread(th.id));
      frag.append(item);
    }
    railBody.append(frag);
  }

  // ================================================================ live updates
  // On every store change: refresh chrome/fanout/fallback/screen for visible tiles,
  // and reflow if the active-thread set changed.
  let pending = false;
  function onChange() {
    if (pending) return;
    pending = true;
    Promise.resolve().then(() => {
      pending = false;
      // reflow is itself reconciling + cheap, so we always run it; the per-tile
      // live refresh below then repaints chrome/fanout/fallback/screen.
      reflow();
      for (let i = 0; i < tiles.length; i++) {
        const tile = tiles[i];
        if (tile.frozen) continue;       // frozen tiles stop updating (stub semantics)
        syncChrome(tile);
        renderFanout(tile);
        if (tile.viewMode === 'raw') renderScreen(tile);
        else if (!tile.usingIde) renderFallback(tile); // ide pane self-updates via store
      }
      updateRedactionChip();
      syncBar();
    });
  }

  function updateRedactionChip() {
    let st;
    try { st = store.getState(); } catch (_) { st = null; }
    const show = menu.settings.redactionIndicator;
    redactionChip.classList.toggle('hidden', !show);
    if (!show) return;
    const red = st && st.hello && st.hello.redaction;
    redactionChip.classList.toggle('on', !!red);
    redactionChip.classList.toggle('off', st && st.hello && !red);
    const lab = redactionChip.querySelector('.rlabel');
    if (lab) lab.textContent = red ? 'redacted' : (st && st.hello ? 'NOT redacted' : 'redaction');
  }

  // ================================================================ maximize / focus
  function toggleMaximizeTile(idx) {
    if (idx < 0 || idx >= tiles.length) return;
    maximizedTileIdx = (maximizedTileIdx === idx) ? -1 : idx;
    if (maximizedTileIdx >= 0) focusedTileIdx = maximizedTileIdx;
    applyMaximize();
    // maximizing hides internal gutters; restoring re-applies the saved tracks.
    syncGutters();
    reflectFocusBorders();
  }
  function applyMaximize() {
    const has = maximizedTileIdx >= 0 && maximizedTileIdx < tiles.length;
    grid.classList.toggle('has-max', has);
    tiles.forEach((t, i) => {
      t.elTile.classList.toggle('is-max', has && i === maximizedTileIdx);
      const max = t.ctrls.cMax.b;
      max.classList.toggle('on', has && i === maximizedTileIdx);
      max.textContent = (has && i === maximizedTileIdx) ? '◱' : '⛶';
    });
  }
  function reflectFocusBorders() {
    tiles.forEach((t, i) => t.elTile.classList.toggle('is-focused', i === focusedTileIdx));
    // mirror focused tile's thread to the URL (replace; don't spam history)
    const ft = tiles[focusedTileIdx];
    if (ft && ft.threadId) menu.setView({ thread: ft.threadId }, { replace: true, silent: true });
  }

  // Toggle the `is-editing` accent on every visible tile whose bound thread is
  // generating code right now, and (follow-latest only, not maximized) auto-focus
  // the sole active editor so the layout favours fewer-but-larger — the eye on the
  // window where code is being written. Pinned/frozen tiles keep their accent state
  // but are never auto-focused/replaced (reflow already preserves their binding).
  function applyEditingEmphasis(mode, ranked) {
    let editingIdx = -1, editingCount = 0;
    tiles.forEach((t, i) => {
      const editing = !!t.threadId && isActivelyEditing(store.thread(t.threadId));
      t.elTile.classList.toggle('is-editing', editing);
      if (editing) { editingCount++; if (editingIdx < 0) editingIdx = i; }
    });
    // fewer-but-larger auto-emphasis: exactly one visible thread is editing while
    // the rest are merely busy/idle → put focus on it (primary/largest slot).
    // Subordinate to an explicit maximize; only in follow-latest mode.
    if (mode === 'focus' && maximizedTileIdx < 0 && editingCount === 1 && editingIdx >= 0) {
      focusedTileIdx = editingIdx;
    }
    void ranked;
  }

  function focusTileN(n) {
    if (n < 0 || n >= tiles.length) return;
    focusedTileIdx = n;
    if (maximizedTileIdx >= 0) { maximizedTileIdx = n; applyMaximize(); }
    reflectFocusBorders();
  }

  // ================================================================ thread focus / cycle
  function focusThread(threadId) {
    if (!threadId) return;
    // if it's already in a tile, just focus that tile.
    const at = tiles.findIndex((t) => t.threadId === threadId);
    if (at >= 0) { focusTileN(at); return; }
    // else bind it into the focused tile (manual/per-tile keep it; focus mode too).
    const tile = tiles[focusedTileIdx] || tiles[0];
    if (!tile) return;
    bindTile(tile, threadId);
    syncChrome(tile); renderFanout(tile);
    // reflect to URL but don't re-enter applyView (we've already bound + focused).
    menu.setView({ thread: threadId }, { silent: true });
    reflectFocusBorders();
  }

  function cycleThread(dir) {
    const ranked = activeThreads();
    if (!ranked.length) return;
    const cur = tiles[focusedTileIdx] && tiles[focusedTileIdx].threadId;
    let idx = ranked.findIndex((t) => t.id === cur);
    if (idx < 0) idx = 0;
    else idx = (idx + dir + ranked.length) % ranked.length;
    focusThread(ranked[idx].id);
  }

  // ================================================================ mobile
  function syncMobile(ranked) {
    const list = ranked && ranked.length ? ranked : activeThreads();
    if (!list.length) {
      mnTitle.textContent = '—'; mnPager.textContent = '';
      tiles.forEach((t) => t.elTile.classList.remove('is-mobile-active'));
      return;
    }
    if (mobileIdx >= list.length) mobileIdx = list.length - 1;
    if (mobileIdx < 0) mobileIdx = 0;
    const th = list[mobileIdx];
    // bind tile 0 to the mobile-selected thread so the single visible pane matches
    const tile0 = tiles[0];
    if (tile0 && tile0.threadId !== th.id) { bindTile(tile0, th.id); }
    tiles.forEach((t, i) => t.elTile.classList.toggle('is-mobile-active', i === 0));
    mnTitle.textContent = th.title || th.id;
    mnPager.innerHTML = '';
    mnPager.append(el('span', 'mn-dot', String(mobileIdx + 1)), document.createTextNode(' / ' + list.length));
  }
  function mobileStep(dir) {
    const list = activeThreads();
    if (!list.length) return;
    mobileIdx = (mobileIdx + dir + list.length) % list.length;
    focusedTileIdx = 0;
    syncMobile(list);
    syncChrome(tiles[0]); renderFanout(tiles[0]);
    if (tiles[0] && tiles[0].viewMode === 'raw') renderScreen(tiles[0]);
    else if (tiles[0] && !tiles[0].usingIde) renderFallback(tiles[0]);
    menu.setView({ thread: list[mobileIdx].id });
  }
  mnPrev.addEventListener('click', () => mobileStep(-1));
  mnNext.addEventListener('click', () => mobileStep(1));

  // touch swipe on the grid (mobile thread switch)
  let touchX = null, touchY = null;
  grid.addEventListener('touchstart', (e) => {
    if (!e.touches || e.touches.length !== 1) { touchX = null; return; }
    touchX = e.touches[0].clientX; touchY = e.touches[0].clientY;
  }, { passive: true });
  grid.addEventListener('touchend', (e) => {
    if (touchX == null || !e.changedTouches || !e.changedTouches.length) return;
    const dx = e.changedTouches[0].clientX - touchX;
    const dy = e.changedTouches[0].clientY - touchY;
    touchX = null;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.4) return; // not a horizontal swipe
    mobileStep(dx < 0 ? 1 : -1); // swipe left -> next
  }, { passive: true });

  // ================================================================ annotate seam
  function getClient() {
    return (typeof window !== 'undefined' && window.wyc && window.wyc.client) || null;
  }
  function getToken() {
    try {
      if (typeof window !== 'undefined' && window.wyc && window.wyc.client
          && typeof window.wyc.client.token === 'function') return window.wyc.client.token();
    } catch (_) {}
    try { return localStorage.getItem('wyc.token') || ''; } catch (_) { return ''; }
  }
  // send {t:'annotate',v:1,action,target} via menu (which falls back to client/send)
  function annotate(tile, action) {
    const lead = leadSession(tile.threadId);
    const target = { thread_id: tile.threadId };
    if (lead) target.session_id = lead.id;
    const ok = menu.annotate(action, target);
    if (!ok) menu.toast(action + ': write path not available (stub)');
    else menu.toast(action + (action.startsWith('un') ? '' : ' set'));
  }
  function annotateFocused(action) {
    const tile = tiles[focusedTileIdx] || tiles[0];
    if (!tile || !tile.threadId) { menu.toast('no focused thread'); return; }
    if (action === 'pin') { tile.pinned = !tile.pinned; annotate(tile, tile.pinned ? 'pin' : 'unpin'); }
    else if (action === 'freeze') { tile.frozen = !tile.frozen; annotate(tile, tile.frozen ? 'freeze' : 'unfreeze'); }
    else if (action === 'flag') { tile.flagged = !tile.flagged; annotate(tile, tile.flagged ? 'flag' : 'unflag'); }
    else annotate(tile, action);
    syncChrome(tile);
  }

  // ================================================================ pop-out
  function popOutThread(threadId) {
    if (!threadId || typeof window === 'undefined' || !window.open) return;
    try {
      const u = new URL(window.location.href);
      u.searchParams.set('thread', threadId);
      // force the popped window to a single tile via the session ?watch override
      // (does NOT write the shared localStorage count, so the parent window keeps
      // its own choice). 'layout' is kept for back-compat with menu.js URL state.
      u.searchParams.set('watch', '1');
      u.searchParams.set('layout', '1');
      u.searchParams.set('view', (tiles[focusedTileIdx] && tiles[focusedTileIdx].viewMode) || 'ide');
      // keep token so the popped window authenticates the same way
      const tok = getToken();
      if (tok) u.searchParams.set('token', tok);
      const w = window.open(u.toString(), '_blank', 'noopener,width=900,height=700');
      if (!w) menu.toast('pop-out blocked by browser');
    } catch (e) { console.error('[mosaic] popout failed', e); }
  }
  function popOutFocused() {
    const tile = tiles[focusedTileIdx] || tiles[0];
    if (tile && tile.threadId) popOutThread(tile.threadId);
    else menu.toast('no focused thread');
  }

  // ================================================================ collapse (tile body)
  // Collapse a tile to JUST its chrome header strip (body hidden) so the other tiles
  // in its row/column reclaim the space. State is keyed by THREAD id and persisted, so
  // a collapsed thread stays collapsed across reflows/reload and when it leaves and
  // re-enters the visible set. A collapsed tile still updates its header live.
  function toggleCollapse(tile) {
    if (!tile) return;
    tile.collapsed = !tile.collapsed;
    setThreadCollapsed(tile.threadId, tile.collapsed); // persist (no-op for empty tiles)
    syncChrome(tile);
    // re-evaluate row templates (a fully-collapsed row shrinks to header height) and
    // reposition the overlay track gutters against the new live track sizes.
    syncGutters();
  }

  // ================================================================ bar sync
  function syncBar() {
    const mode = menu.effMode();
    // reflect the watch choice into the dropdown ('auto' or the number).
    const w = watchChoice();
    const wv = w === WATCH_AUTO ? WATCH_AUTO : String(w);
    if (watchSel.value !== wv) watchSel.value = wv;
    const b = modeChip.querySelector('b');
    if (b) b.textContent = mode === 'focus' ? 'follow-latest' : mode;
  }

  // choose how many sessions to watch from the dropdown. Persists the choice in
  // our LAYOUT_KEY blob and reflows; orientation stays auto-detected independently.
  function setWatch(v) {
    setWatchChoice(v);
    reflow(true);
    syncBar();
  }
  function cycleMode() {
    const order = ['focus', 'per-tile', 'manual'];
    const cur = menu.effMode();
    const next = order[(order.indexOf(cur) + 1) % order.length];
    menu.setSetting('mode', next);
    menu.setView({ mode: null });
  }

  // ================================================================ settings/view appliers
  // The grid count is now owned by our watchN dropdown, but menu.js's palette still
  // offers legacy "Set layout: N-up" commands (it can't know about watchN). Bridge
  // them: when menu's numeric `layout` setting CHANGES, mirror it into watchN so the
  // palette command takes effect. Plain settings churn (density/accent/…) doesn't
  // touch the count because we only act on an actual layout delta.
  let _lastMenuLayout; // undefined until the first applySettings (adopt silently)
  function applySettings(s) {
    if (s && s.layout != null) {
      const ly = Number(s.layout);
      // first call adopts the current value WITHOUT clobbering the watchN default;
      // only a subsequent CHANGE (a palette "N-up" pick) mirrors into watchN.
      if (_lastMenuLayout !== undefined && ly !== _lastMenuLayout) setWatchChoice(ly);
      _lastMenuLayout = ly;
    }
    root.setAttribute('data-density', s.density);
    root.setAttribute('data-accent', s.accent);
    syncBar();
    // a settings change can affect layout / rail / terminal visibility — reflow.
    reflow(true);
    // propagate showTerminal to ide panes if they expose it (forward-compat)
    for (const t of tiles) {
      if (t.usingIde && t.pane && typeof t.pane.setShowTerminal === 'function') {
        try { t.pane.setShowTerminal(s.showTerminal); } catch (_) {}
      }
    }
    updateRedactionChip();
  }
  function applyView(v) {
    // a URL/Back-forward view change: re-focus the named thread + apply layout/view.
    syncBar();
    reflow(true);
    if (v.thread) {
      const at = tiles.findIndex((t) => t.threadId === v.thread);
      if (at >= 0) { focusedTileIdx = at; reflectFocusBorders(); }
      else focusThread(v.thread);
    }
    if (v.view) {
      const tile = tiles[focusedTileIdx] || tiles[0];
      if (tile && tile.viewMode !== v.view) setTileView(tile, v.view);
    }
  }

  // ================================================================ controller (for menu.js)
  const controller = {
    rootEl: root,
    // imperative ops the palette + keybinds call
    toggleMaximize: () => toggleMaximizeTile(focusedTileIdx),
    toggleRaw: () => {
      const tile = tiles[focusedTileIdx] || tiles[0];
      if (tile && tile.threadId) setTileView(tile, tile.viewMode === 'raw' ? 'ide' : 'raw');
    },
    focusTileN,
    focusThread,
    cycleThread,
    annotateFocused,
    popOutFocused,
    resetLayout: () => {
      maximizedTileIdx = -1;
      tiles.forEach((t) => { t.pinned = false; t.frozen = false; t.flagged = false; t.collapsed = false; });
      // also clear persisted pane sizes (track splits + rail width + watch count)
      // and every collapsed-tile flag (in-memory set + persisted list).
      sizes = {}; railCollapsed = false; collapsedThreads.clear(); saveSizes(LAYOUT_KEY, sizes);
      rail.style.width = ''; lastGutterKey = '';
      reflow(true);
    },
    focusedThreadId: () => (tiles[focusedTileIdx] && tiles[focusedTileIdx].threadId) || null,
    // menu pushes settings/view changes here (single-writer pattern)
    onSettings: applySettings,
    onView: applyView,
  };

  // ================================================================ boot
  // create the menu (control plane), register this mosaic as its controller.
  const menu = mountMenu(store, { getToken, client: getClient() });
  // NOTE: tiles created lazily in reflow(); menu must exist first because tile
  // construction reads menu.effDefaultView(). (mountMenu above runs before reflow.)

  // set density/accent on the root before the first reflow so tiles paint right.
  root.setAttribute('data-density', menu.settings.density);
  root.setAttribute('data-accent', menu.settings.accent);

  // Watch-count defaults to 'auto' (watchChoice() returns WATCH_AUTO when unset)
  // and orientation is auto-detected — so there is NO boot-time layout pick to do;
  // the first reflow arranges tiles for the current count + orientation.

  // register this mosaic; setController pushes settings+view → applySettings (which
  // reflows) + applyView (focus). One initialization path, no redundant reflows.
  menu.setController(controller);

  // re-evaluate orientation (portrait↔landscape) + auto tile-count on viewport
  // changes, then re-arrange the grid.
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', onViewportResize);
    if (typeof window.matchMedia === 'function') {
      try { window.matchMedia('(orientation: portrait)').addEventListener('change', onViewportResize); } catch (_) {}
    }
  }
  // one rAF correction so the auto tile-count + gutter positions use real laid-out sizes.
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => reflow(true));

  // initial live paint + subscribe (rAF-batched inside the store)
  onChange();
  const unsub = store.subscribe(onChange);

  return {
    destroy() {
      try { unsub(); } catch (_) {}
      if (typeof window !== 'undefined') {
        window.removeEventListener('resize', onViewportResize);
        if (typeof window.matchMedia === 'function') {
          try { window.matchMedia('(orientation: portrait)').removeEventListener('change', onViewportResize); } catch (_) {}
        }
      }
      if (_roTimer) clearTimeout(_roTimer);
      clearTrackGutters();
      for (const t of tiles) { stopWatch(t); teardownPane(t); }
      tiles.length = 0;
      try { menu.destroy(); } catch (_) {}
      rootEl.innerHTML = '';
    },
  };
}

export default mountMosaic;
