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
  const bar = el('div', 'mos-bar');
  const layoutSeg = el('div', 'mos-seg');
  const layoutBtns = {};
  for (const ly of [1, 2, 4, 6]) {
    const b = el('button', null, ly + '-up');
    b.title = `layout: ${ly} tiles`;
    b.addEventListener('click', () => { menu.setView({ layout: ly }); menu.setSetting('layout', ly); });
    layoutSeg.append(b); layoutBtns[ly] = b;
  }
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
  bar.append(layoutSeg, modeChip, barSpacer, redactionChip, railToggle, settingsBtn, paletteBtn);

  // --- stage: grid + rail ---
  const stage = el('div', 'mos-stage');
  const grid = el('div', 'mos-grid');
  const rail = el('div', 'mos-rail');
  const railHdr = el('div', 'mos-rail-hdr');
  railHdr.append(el('span', 'accent', 'more'), el('span', 'r-count', ''));
  const railBody = el('div', 'mos-rail-body');
  rail.append(railHdr, railBody);
  stage.append(grid, rail);

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

  root.append(mobileNav, bar, stage, fab);
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
    const cCollapse = ctrlBtn('collapse', '–', 'collapse to rail');

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
      pinned: false, frozen: false, flagged: false,
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
    cCollapse.b.addEventListener('click', () => collapseTile(tile));

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
    if (tile.threadId === threadId) { syncChrome(tile); return; }
    // stop any screen watch tied to the old thread
    stopWatch(tile);
    tile.threadId = threadId;
    tile.frozen = false; // re-binding clears a frozen snapshot intent

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

  // ACTIVE threads = have at least one non-ended session; busy-first then recency.
  function activeThreads() {
    let list = [];
    try { list = store.threadsList() || []; } catch (_) { return []; }
    const act = list.filter((th) => {
      const ss = safeSessions(th.id);
      return ss.some((s) => s && (s.status === 'busy' || s.status === 'idle'));
    });
    act.sort((a, b) => {
      const r = threadStatusRank(a) - threadStatusRank(b);
      if (r) return r;
      return threadRecency(b) - threadRecency(a);
    });
    // if nothing is active (all ended / empty), fall back to most-recent threads
    if (!act.length && list.length) {
      return list.slice(0, 6);
    }
    return act;
  }

  // ================================================================ reflow
  let lastReflowSig = '';
  function reflow(force) {
    const layout = menu.effLayout();
    const mode = menu.effMode();
    const ranked = activeThreads();

    // ---- decide which threads occupy the visible tiles ----
    const slots = layout;
    // pinned tiles keep their thread (if it still exists at all)
    const visible = [];          // thread ids for tiles 0..slots-1
    const usedThreadIds = new Set();

    // 1) honor pins (and frozen snapshots): such a tile holds its current thread
    //    and opts out of auto-rebind so its content isn't clobbered by reflow.
    const pinnedByIdx = new Map();
    tiles.forEach((t, i) => {
      if ((t.pinned || t.frozen) && t.threadId && i < slots) {
        pinnedByIdx.set(i, t.threadId);
        usedThreadIds.add(t.threadId);
      }
    });

    if (mode === 'manual') {
      // manual: keep each tile's existing thread; only fill empties with new actives.
      for (let i = 0; i < slots; i++) {
        const existing = tiles[i] && tiles[i].threadId;
        const held = tiles[i] && (tiles[i].pinned || tiles[i].frozen);
        if (existing && (ranked.some((t) => t.id === existing) || held)) {
          visible[i] = existing; usedThreadIds.add(existing);
        }
      }
      // fill empties with ranked threads not already shown
      let ri = 0;
      for (let i = 0; i < slots; i++) {
        if (visible[i]) continue;
        while (ri < ranked.length && usedThreadIds.has(ranked[ri].id)) ri++;
        if (ri < ranked.length) { visible[i] = ranked[ri].id; usedThreadIds.add(ranked[ri].id); ri++; }
        else visible[i] = null;
      }
    } else if (mode === 'per-tile') {
      // per-tile: keep a tile's thread while it's still active; else rebind to next.
      for (let i = 0; i < slots; i++) {
        if (pinnedByIdx.has(i)) { visible[i] = pinnedByIdx.get(i); continue; }
        const existing = tiles[i] && tiles[i].threadId;
        if (existing && ranked.some((t) => t.id === existing)) { visible[i] = existing; usedThreadIds.add(existing); }
      }
      let ri = 0;
      for (let i = 0; i < slots; i++) {
        if (visible[i] !== undefined && visible[i] !== null) continue;
        while (ri < ranked.length && usedThreadIds.has(ranked[ri].id)) ri++;
        visible[i] = ri < ranked.length ? ranked[ri].id : null;
        if (visible[i]) { usedThreadIds.add(visible[i]); ri++; }
      }
    } else {
      // focus-follows-latest (default): tile 0 = most-recent active (unless pinned),
      // remaining tiles fill by ranked order, skipping pinned threads.
      // If the menu has a focused thread (URL/command), pin it to tile 0 slot.
      const wanted = [];
      const forcedThread = menu.view && menu.view.thread;
      if (forcedThread && ranked.some((t) => t.id === forcedThread)) {
        wanted.push(forcedThread);
      }
      for (const th of ranked) {
        if (wanted.includes(th.id)) continue;
        wanted.push(th.id);
      }
      // place: pinned tiles first keep theirs, then fill the rest from `wanted`.
      let wi = 0;
      for (let i = 0; i < slots; i++) {
        if (pinnedByIdx.has(i)) { visible[i] = pinnedByIdx.get(i); continue; }
        while (wi < wanted.length && usedThreadIds.has(wanted[wi])) wi++;
        visible[i] = wi < wanted.length ? wanted[wi] : null;
        if (visible[i]) { usedThreadIds.add(visible[i]); wi++; }
      }
    }

    // ---- ensure we have exactly `slots` tiles ----
    while (tiles.length < slots) createTile();
    while (tiles.length > slots) {
      const t = tiles.pop();
      if (t) { stopWatch(t); teardownPane(t); t.elTile.remove(); }
    }
    grid.setAttribute('data-layout', String(slots));

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

    // mobile: clamp index + bind the single active tile
    syncMobile(ranked);

    reflectFocusBorders();
    applyMaximize();

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
    railHdr.lastChild.textContent = overflow.length ? ' +' + overflow.length : '';
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
      // cheap structural check: did the visible binding change?
      const layout = menu.effLayout();
      const mode = menu.effMode();
      const ranked = activeThreads();
      // recompute a quick signature of what *would* be visible (top slots).
      // We always reflow because reflow itself is reconciling + cheap, but we
      // short-circuit per-tile live refresh below regardless.
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
      void ranked; void layout; void mode;
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

  // ================================================================ collapse (to rail)
  function collapseTile(tile) {
    // collapsing == unbind the tile + temporarily pin it empty so reflow doesn't
    // immediately refill; simplest honest behavior: clear + let reflow refill from
    // overflow on the next change (operator can re-focus from the rail).
    const tid = tile.threadId;
    bindTile(tile, null);
    if (tid) menu.toast('collapsed — pick it again from the rail');
    // trigger a reflow so the freed slot fills with overflow
    reflow(true);
  }

  // ================================================================ bar sync
  function syncBar() {
    const layout = menu.effLayout();
    const mode = menu.effMode();
    for (const k of Object.keys(layoutBtns)) {
      layoutBtns[k].setAttribute('aria-pressed', String(Number(k) === layout));
    }
    const b = modeChip.querySelector('b');
    if (b) b.textContent = mode === 'focus' ? 'follow-latest' : mode;
  }
  function cycleMode() {
    const order = ['focus', 'per-tile', 'manual'];
    const cur = menu.effMode();
    const next = order[(order.indexOf(cur) + 1) % order.length];
    menu.setSetting('mode', next);
    menu.setView({ mode: null });
  }

  // ================================================================ settings/view appliers
  function applySettings(s) {
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
    resetLayout: () => { maximizedTileIdx = -1; tiles.forEach((t) => { t.pinned = false; t.frozen = false; t.flagged = false; }); reflow(true); },
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
  // register this mosaic; setController pushes settings+view → applySettings (which
  // reflows) + applyView (focus). One initialization path, no redundant reflows.
  menu.setController(controller);

  // initial live paint + subscribe (rAF-batched inside the store)
  onChange();
  const unsub = store.subscribe(onChange);

  return {
    destroy() {
      try { unsub(); } catch (_) {}
      for (const t of tiles) { stopWatch(t); teardownPane(t); }
      tiles.length = 0;
      try { menu.destroy(); } catch (_) {}
      rootEl.innerHTML = '';
    },
  };
}

export default mountMosaic;
