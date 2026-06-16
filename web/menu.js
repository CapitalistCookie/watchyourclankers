// @ts-check
/**
 * watchyourclankers — menu.js  (W3 command palette + settings + keybinds + state)
 *
 * Owns the *UI control plane* for the mosaic:
 *   - the floating command palette (Cmd/Ctrl-K), fuzzy-filtered
 *   - the settings panel (layout density, auto-switch mode, theme accent,
 *     show/hide terminal, redaction indicator, reset layout)
 *   - global keybinds (f maximize, 1-9 focus tile N, [ ] cycle thread,
 *     r raw-screen toggle, ? help, Esc close)
 *   - the ONE versioned localStorage blob `wyc.settings.v1` (read once at init,
 *     sanitized; written debounced ~250ms + on pagehide)
 *   - view-state reflected to the URL query (?thread=&view=&layout=&mode=) —
 *     shareable + Back/Forward (popstate).
 *
 * It is intentionally decoupled from mosaic.js: the mosaic registers itself as a
 * controller (ctx.mosaic) exposing imperative ops the palette/keys call, and the
 * menu owns + persists settings/view-state and notifies the mosaic on change.
 *
 * EXPORT:
 *   mountMenu(store, ctx) -> { open(), close(), destroy(), settings, ... }
 *
 *   ctx = {
 *     mosaic: <the controller object that mosaic.js passes via setController()>,
 *     getToken?: () => string,        // for pop-out (clone) links
 *     client?:   <client.js client>,  // for annotate(); falls back to window.wyc.client
 *   }
 *
 *  Persistence + view-state are the menu's responsibility; mosaic.js reads them
 *  through ctx (menu.settings / menu.view) and pushes changes back through the
 *  menu API (menu.setSetting / menu.setView) so there is ONE writer.
 */

// ----------------------------------------------------------------- constants
export const SETTINGS_KEY = 'wyc.settings.v1';
const WRITE_DEBOUNCE_MS = 250;

const LAYOUTS = [1, 2, 4, 6];
const MODES = ['focus', 'per-tile', 'manual']; // focus = focus-follows-latest (default)
const DENSITIES = ['compact', 'cozy', 'roomy'];
const ACCENTS = ['cyan', 'purple', 'green', 'amber'];
const VIEWS = ['ide', 'raw']; // per-mosaic default view

const MODE_LABEL = {
  focus: 'focus-follows-latest',
  'per-tile': 'per-tile',
  manual: 'manual',
};

/** Defaults — also the sanitize fallback when a stored value is bad. */
export const DEFAULT_SETTINGS = {
  v: 1,
  layout: 2,            // 1 | 2 | 4 | 6
  density: 'cozy',      // compact | cozy | roomy
  mode: 'focus',        // focus | per-tile | manual
  accent: 'cyan',       // cyan | purple | green | amber
  showTerminal: true,   // show/hide terminal surface (passed to ide pane / fallback)
  redactionIndicator: true,
  defaultView: 'ide',   // ide | raw  (per-tile override lives in view-state/mosaic)
  showRail: true,       // overflow 'more' rail visible
};

/** Volatile view-state (mirrored to URL, NOT to localStorage by default). */
const DEFAULT_VIEW = {
  thread: null,   // focused thread id
  view: null,     // 'ide' | 'raw' override for the focused tile (null = use defaultView)
  layout: null,   // null = use settings.layout; an explicit URL override wins for the session
  mode: null,     // null = use settings.mode
};

// ----------------------------------------------------------------- tiny utils
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function clampPick(val, allowed, fallback) {
  return allowed.includes(val) ? val : fallback;
}
function readStorage(key) {
  if (typeof localStorage === 'undefined') return null;
  try { return localStorage.getItem(key); } catch (_) { return null; }
}
function writeStorage(key, val) {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(key, val); } catch (_) {}
}

/** Sanitize a parsed settings blob into a known-good shape (never trust storage). */
export function sanitizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return s;
  s.layout = clampPick(Number(raw.layout), LAYOUTS, DEFAULT_SETTINGS.layout);
  s.density = clampPick(raw.density, DENSITIES, DEFAULT_SETTINGS.density);
  s.mode = clampPick(raw.mode, MODES, DEFAULT_SETTINGS.mode);
  s.accent = clampPick(raw.accent, ACCENTS, DEFAULT_SETTINGS.accent);
  s.defaultView = clampPick(raw.defaultView, VIEWS, DEFAULT_SETTINGS.defaultView);
  s.showTerminal = typeof raw.showTerminal === 'boolean' ? raw.showTerminal : DEFAULT_SETTINGS.showTerminal;
  s.redactionIndicator = typeof raw.redactionIndicator === 'boolean' ? raw.redactionIndicator : DEFAULT_SETTINGS.redactionIndicator;
  s.showRail = typeof raw.showRail === 'boolean' ? raw.showRail : DEFAULT_SETTINGS.showRail;
  s.v = 1;
  return s;
}

/** Subsequence fuzzy match. Returns {score, ranges:[ [start,end), ...]} or null. */
export function fuzzyMatch(query, text) {
  const q = (query || '').toLowerCase();
  const t = (text || '');
  if (!q) return { score: 0, ranges: [] };
  const tl = t.toLowerCase();
  let qi = 0, ti = 0;
  const idx = [];
  let prevMatch = -2;
  let score = 0;
  while (qi < q.length && ti < tl.length) {
    if (q[qi] === tl[ti]) {
      idx.push(ti);
      score += (ti === prevMatch + 1) ? 3 : 1;   // contiguous run bonus
      if (ti === 0 || /[\s\-_/.:]/.test(tl[ti - 1])) score += 2; // word-boundary bonus
      prevMatch = ti;
      qi++;
    }
    ti++;
  }
  if (qi < q.length) return null;          // not all query chars matched
  score -= (idx[idx.length - 1] - idx[0]); // tighter spans rank higher
  // collapse consecutive indices into [start,end) ranges for highlight
  const ranges = [];
  for (let i = 0; i < idx.length; i++) {
    const start = idx[i];
    let end = start + 1;
    while (i + 1 < idx.length && idx[i + 1] === end) { end++; i++; }
    ranges.push([start, end]);
  }
  return { score, ranges };
}

// ----------------------------------------------------------------- view-state <-> URL
function readViewFromUrl() {
  const v = { ...DEFAULT_VIEW };
  if (typeof window === 'undefined' || !window.location) return v;
  try {
    const u = new URL(window.location.href);
    const q = u.searchParams;
    if (q.get('thread')) v.thread = q.get('thread');
    if (VIEWS.includes(q.get('view') || '')) v.view = q.get('view');
    const ly = Number(q.get('layout'));
    if (LAYOUTS.includes(ly)) v.layout = ly;
    if (MODES.includes(q.get('mode') || '')) v.mode = q.get('mode');
  } catch (_) {}
  return v;
}

// ----------------------------------------------------------------- the controller
/**
 * @param {object} store    the wyc store
 * @param {object} ctx      { mosaic?, getToken?, client? }
 */
export function mountMenu(store, ctx = {}) {
  // -------- state ----------
  const settings = sanitizeSettings(safeParse(readStorage(SETTINGS_KEY)));
  const view = readViewFromUrl();

  /** the mosaic controller; may be set after mount via setController() */
  let mosaic = ctx.mosaic || null;

  // -------- persistence (debounced + pagehide) ----------
  let writeTimer = null;
  function persistSettings() {
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(flushSettings, WRITE_DEBOUNCE_MS);
  }
  function flushSettings() {
    if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
    writeStorage(SETTINGS_KEY, JSON.stringify({ ...settings, v: 1 }));
  }

  // -------- URL reflection ----------
  let urlTimer = null;
  function reflectUrl(replace) {
    if (typeof window === 'undefined' || !window.history || !window.location) return;
    if (urlTimer) clearTimeout(urlTimer);
    urlTimer = setTimeout(() => {
      urlTimer = null;
      try {
        const u = new URL(window.location.href);
        const q = u.searchParams;
        setOrDel(q, 'thread', view.thread);
        setOrDel(q, 'view', view.view);
        setOrDel(q, 'layout', view.layout != null ? String(view.layout) : null);
        setOrDel(q, 'mode', view.mode);
        const next = u.pathname + (q.toString() ? '?' + q.toString() : '') + u.hash;
        if (replace) window.history.replaceState({ wyc: true }, '', next);
        else window.history.pushState({ wyc: true }, '', next);
      } catch (_) {}
    }, 60);
  }
  function setOrDel(q, k, v) { if (v == null || v === '') q.delete(k); else q.set(k, v); }

  // -------- effective getters (settings overlaid by session view-state) ----------
  function effLayout() { return view.layout != null ? view.layout : settings.layout; }
  function effMode() { return view.mode != null ? view.mode : settings.mode; }
  function effDefaultView() { return settings.defaultView; }

  // -------- mutators (the single writer) ----------
  function setSetting(key, val, opts = {}) {
    if (!(key in settings)) return;
    settings[key] = val;
    persistSettings();
    applyAccent();
    if (!opts.silent && mosaic && typeof mosaic.onSettings === 'function') mosaic.onSettings(settings);
    syncSettingsUI();
  }
  function setView(patch, opts = {}) {
    let changed = false;
    for (const k of Object.keys(patch)) {
      if (k in view && view[k] !== patch[k]) { view[k] = patch[k]; changed = true; }
    }
    if (!changed) return;
    reflectUrl(opts.replace);
    if (!opts.silent && mosaic && typeof mosaic.onView === 'function') mosaic.onView(view);
  }

  function applyAccent() {
    if (typeof document === 'undefined') return;
    // accent applies to the mosaic root if present, else <html> (degrade).
    const root = (mosaic && mosaic.rootEl) || document.documentElement;
    root.setAttribute('data-accent', settings.accent);
  }

  // ================================================================ DOM: palette
  const scrim = el('div', 'mos-palette-scrim');
  scrim.hidden = true;
  scrim.setAttribute('role', 'dialog');
  scrim.setAttribute('aria-modal', 'true');
  scrim.setAttribute('aria-label', 'command palette');
  const palette = el('div', 'mos-palette');
  const inputWrap = el('div', 'mos-palette-input');
  inputWrap.append(el('span', 'pi-glyph', '⌘'));
  const input = /** @type {HTMLInputElement} */ (el('input'));
  input.type = 'text';
  input.placeholder = 'Type a command or thread name…';
  input.setAttribute('autocomplete', 'off'); input.setAttribute('spellcheck', 'false');
  inputWrap.append(input, el('span', 'pi-hint', 'esc'));
  const list = el('div', 'mos-palette-list');
  palette.append(inputWrap, list);
  scrim.append(palette);

  // ================================================================ DOM: help
  const helpScrim = el('div', 'mos-help-scrim');
  helpScrim.hidden = true;
  const help = el('div', 'mos-help');
  help.append(el('h3', null, 'keyboard shortcuts'));
  const helpDl = el('dl');
  const KEYS = [
    ['⌘K / Ctrl-K', 'command palette'],
    ['f', 'maximize / restore focused tile'],
    ['1–9', 'focus tile N'],
    ['[  ]', 'cycle focused thread prev / next'],
    ['r', 'toggle IDE ↔ raw-screen on focused tile'],
    ['?', 'this help'],
    ['Esc', 'close palette / help / settings'],
  ];
  for (const [k, d] of KEYS) { helpDl.append(el('dt', null, k), el('dd', null, d)); }
  help.append(helpDl);
  helpScrim.append(help);

  // ================================================================ DOM: settings
  const setScrim = el('div', 'mos-settings-scrim');
  setScrim.hidden = true;
  const panel = el('div', 'mos-settings');
  const sHdr = el('div', 'mos-settings-hdr');
  sHdr.append(el('span', 'accent', 'settings'));
  const sClose = el('button', 'mos-iconbtn s-close', '✕');
  sHdr.append(sClose);
  const sBody = el('div', 'mos-settings-body');
  panel.append(sHdr, sBody);
  setScrim.append(panel);

  // settings fields (built once; values synced via syncSettingsUI)
  /** @type {Record<string, any>} */
  const ui = {};

  function fieldRow(title, sub, control) {
    const f = el('div', 'mos-field');
    const lab = el('div', 'f-label');
    lab.append(el('b', null, title));
    if (sub) lab.append(el('small', null, sub));
    f.append(lab, control);
    return f;
  }
  function segControl(values, labelFn, onPick) {
    const seg = el('div', 'seg');
    const btns = {};
    for (const v of values) {
      const b = el('button', null, labelFn ? labelFn(v) : String(v));
      b.addEventListener('click', () => onPick(v));
      seg.append(b); btns[v] = b;
    }
    return { seg, btns };
  }
  function toggleControl(onChange) {
    const wrap = el('label', 'mos-toggle');
    const inp = /** @type {HTMLInputElement} */ (el('input'));
    inp.type = 'checkbox';
    const track = el('span', 'track');
    const knob = el('span', 'knob');
    wrap.append(inp, track, knob);
    inp.addEventListener('change', () => onChange(inp.checked));
    return { wrap, inp };
  }

  // layout density
  ui.layout = segControl(LAYOUTS, (v) => v + '-up', (v) => setSetting('layout', v));
  sBody.append(fieldRow('Layout', 'tiles shown at once', ui.layout.seg));
  ui.density = segControl(DENSITIES, null, (v) => setSetting('density', v));
  sBody.append(fieldRow('Density', 'tile chrome size', ui.density.seg));
  // auto-switch mode
  ui.mode = segControl(MODES, (v) => (v === 'focus' ? 'follow' : v), (v) => {
    setSetting('mode', v);
    // clearing any per-session URL override so the setting takes effect now
    setView({ mode: null });
  });
  sBody.append(fieldRow('Auto-switch', 'focus-follows-latest, per-tile, or manual', ui.mode.seg));
  // theme accent
  const accentWrap = el('div');
  ui.accentBtns = {};
  for (const a of ACCENTS) {
    const sw = el('span', 'mos-swatch');
    sw.style.background = a === 'cyan' ? 'var(--cyan)'
      : a === 'purple' ? 'var(--purple)'
      : a === 'green' ? 'var(--busy)' : 'var(--idle)';
    sw.title = a;
    sw.addEventListener('click', () => setSetting('accent', a));
    accentWrap.append(sw); ui.accentBtns[a] = sw;
  }
  sBody.append(fieldRow('Accent', 'theme color', accentWrap));
  // default view
  ui.defaultView = segControl(VIEWS, (v) => (v === 'ide' ? 'IDE' : 'raw'), (v) => setSetting('defaultView', v));
  sBody.append(fieldRow('Default surface', 'new tiles show IDE or raw screen', ui.defaultView.seg));
  // show/hide terminal
  ui.showTerminal = toggleControl((on) => setSetting('showTerminal', on));
  sBody.append(fieldRow('Terminal surface', 'show the live shell in tiles', ui.showTerminal.wrap));
  // redaction indicator
  ui.redaction = toggleControl((on) => setSetting('redactionIndicator', on));
  sBody.append(fieldRow('Redaction indicator', 'show secret-redaction status', ui.redaction.wrap));
  // show rail
  ui.showRail = toggleControl((on) => setSetting('showRail', on));
  sBody.append(fieldRow('Overflow rail', 'show the “more threads” rail', ui.showRail.wrap));

  // footer: reset layout
  const foot = el('div', 'mos-settings-foot');
  const resetBtn = el('button', 'mos-btn danger', 'Reset layout & settings');
  resetBtn.addEventListener('click', () => {
    Object.assign(settings, DEFAULT_SETTINGS);
    flushSettings();
    applyAccent();
    setView({ layout: null, mode: null, view: null }, { silent: false });
    if (mosaic && typeof mosaic.onSettings === 'function') mosaic.onSettings(settings);
    if (mosaic && typeof mosaic.resetLayout === 'function') mosaic.resetLayout();
    syncSettingsUI();
    toast('layout reset');
  });
  foot.append(resetBtn);
  panel.append(foot);

  function syncSettingsUI() {
    setSeg(ui.layout.btns, effLayout());
    setSeg(ui.density.btns, settings.density);
    setSeg(ui.mode.btns, effMode());
    setSeg(ui.defaultView.btns, settings.defaultView);
    for (const a of ACCENTS) ui.accentBtns[a].setAttribute('aria-pressed', String(a === settings.accent));
    ui.showTerminal.inp.checked = settings.showTerminal;
    ui.redaction.inp.checked = settings.redactionIndicator;
    ui.showRail.inp.checked = settings.showRail;
  }
  function setSeg(btns, active) {
    for (const k of Object.keys(btns)) btns[k].setAttribute('aria-pressed', String(String(k) === String(active)));
  }

  // ================================================================ toast
  const toastEl = el('div', 'mos-toast');
  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1600);
  }

  // ================================================================ palette commands
  // Static commands + dynamic "focus thread <name>" entries from the store.
  function buildCommands() {
    /** @type {Array<{id,label,group,icon,sub?,key?,run:Function}>} */
    const cmds = [];
    const m = () => mosaic; // late-bound

    cmds.push({ id: 'maximize', group: 'View', icon: '⛶', label: 'Maximize / restore focused tile', key: 'f',
      run: () => m() && m().toggleMaximize && m().toggleMaximize() });
    cmds.push({ id: 'raw', group: 'View', icon: '▦', label: 'Toggle IDE ↔ raw screen (focused)', key: 'r',
      run: () => m() && m().toggleRaw && m().toggleRaw() });
    for (const ly of LAYOUTS) {
      cmds.push({ id: 'layout-' + ly, group: 'Layout', icon: '▣', label: `Set layout: ${ly}-up`,
        run: () => { setView({ layout: ly }); setSetting('layout', ly); } });
    }
    for (const mode of MODES) {
      cmds.push({ id: 'mode-' + mode, group: 'Auto-switch', icon: '⟳', label: `Auto-switch: ${MODE_LABEL[mode]}`,
        run: () => { setSetting('mode', mode); setView({ mode: null }); } });
    }
    cmds.push({ id: 'pin', group: 'Annotate', icon: '📌', label: 'Pin focused tile (opt out of auto-switch)',
      run: () => m() && m().annotateFocused && m().annotateFocused('pin') });
    cmds.push({ id: 'freeze', group: 'Annotate', icon: '❄', label: 'Freeze focused tile (snapshot — stub)',
      run: () => m() && m().annotateFocused && m().annotateFocused('freeze') });
    cmds.push({ id: 'flag', group: 'Annotate', icon: '⚑', label: 'Flag focused tile (stub)',
      run: () => m() && m().annotateFocused && m().annotateFocused('flag') });
    cmds.push({ id: 'popout', group: 'View', icon: '⧉', label: 'Pop out focused thread to a new window',
      run: () => m() && m().popOutFocused && m().popOutFocused() });
    cmds.push({ id: 'handoff', group: 'Thread', icon: '⤳', label: 'Copy thread handoff one-liner',
      run: () => copyHandoff() });
    cmds.push({ id: 'settings', group: 'App', icon: '⚙', label: 'Open settings…',
      run: () => openSettings() });
    cmds.push({ id: 'help', group: 'App', icon: '?', label: 'Keyboard shortcuts', key: '?',
      run: () => openHelp() });

    // dynamic: focus a thread by name
    let threads = [];
    try { threads = store.threadsList(); } catch (_) {}
    for (const th of threads) {
      const ss = safeSessionsForThread(th.id);
      const busy = ss.some((s) => s && s.status === 'busy');
      cmds.push({
        id: 'focus-' + th.id, group: 'Focus thread', icon: busy ? '●' : '○',
        label: 'Focus ' + (th.title || th.id),
        sub: th.project || (ss[0] && ss[0].project) || '',
        run: () => { setView({ thread: th.id }); m() && m().focusThread && m().focusThread(th.id); },
      });
    }
    return cmds;
  }

  function safeSessionsForThread(id) {
    try { return store.sessionsForThread(id) || []; } catch (_) { return []; }
  }

  // copy a thread handoff one-liner to the clipboard. Best-effort, fully local.
  function copyHandoff() {
    const tid = focusedThreadId();
    const th = tid && store.thread(tid);
    if (!th) { toast('no focused thread'); return; }
    const ss = safeSessionsForThread(tid);
    const lead = th.lead_session_id && store.session(th.lead_session_id);
    const cur = lead || ss[ss.length - 1] || null;
    const file = cur && cur.current_file ? cur.current_file : '';
    const chain = ss.map((s) => s && (s.name || (s.id || '').slice(0, 6))).filter(Boolean).join(' → ');
    const proj = th.project || (cur && cur.project) || '';
    const line = `handoff: thread "${th.title || tid}"`
      + (proj ? ` [${proj}]` : '')
      + (chain ? ` — chain ${chain}` : '')
      + (cur && cur.status ? ` — ${cur.status}` : '')
      + (file ? ` @ ${file}` : '');
    const done = (ok) => toast(ok ? 'handoff copied' : 'copy failed — ' + line.slice(0, 40) + '…');
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(line).then(() => done(true), () => done(false));
    } else { done(false); }
  }

  // ----- palette filter + render -----
  let activeIdx = 0;
  let rendered = []; // [{cmd, ranges}]
  function renderList() {
    const q = input.value.trim();
    const cmds = buildCommands();
    let matched;
    if (!q) {
      matched = cmds.map((cmd) => ({ cmd, ranges: [], score: 0 }));
    } else {
      matched = [];
      for (const cmd of cmds) {
        const hay = cmd.label + ' ' + (cmd.sub || '') + ' ' + cmd.group;
        const r = fuzzyMatch(q, cmd.label) || fuzzyMatch(q, hay);
        if (r) matched.push({ cmd, ranges: r.ranges, score: r.score });
      }
      matched.sort((a, b) => b.score - a.score);
    }
    rendered = matched;
    if (activeIdx >= rendered.length) activeIdx = Math.max(0, rendered.length - 1);

    list.innerHTML = '';
    if (!rendered.length) {
      list.append(el('div', 'mos-palette-empty', 'no matches'));
      return;
    }
    let lastGroup = null;
    const frag = document.createDocumentFragment();
    rendered.forEach((row, i) => {
      if (!q && row.cmd.group !== lastGroup) {
        lastGroup = row.cmd.group;
        frag.append(el('div', 'mos-palette-group', row.cmd.group));
      }
      const item = el('div', 'mos-cmd' + (i === activeIdx ? ' active' : ''));
      item.append(el('span', 'pc-icon', row.cmd.icon || '•'));
      const lab = el('span', 'pc-label');
      // highlight only when filtering against the label itself
      const r2 = q ? fuzzyMatch(q, row.cmd.label) : null;
      if (r2 && r2.ranges.length) lab.append(...hlSpans(row.cmd.label, r2.ranges));
      else lab.textContent = row.cmd.label;
      item.append(lab);
      if (row.cmd.sub) item.append(el('span', 'pc-sub', row.cmd.sub));
      if (row.cmd.key) item.append(el('span', 'pc-key', row.cmd.key));
      item.addEventListener('mousemove', () => { if (activeIdx !== i) { activeIdx = i; markActive(); } });
      item.addEventListener('click', () => runActiveAt(i));
      frag.append(item);
    });
    list.append(frag);
  }
  function hlSpans(text, ranges) {
    const out = [];
    let pos = 0;
    for (const [s, e] of ranges) {
      if (s > pos) out.push(document.createTextNode(text.slice(pos, s)));
      out.push(el('span', 'pc-hl', text.slice(s, e)));
      pos = e;
    }
    if (pos < text.length) out.push(document.createTextNode(text.slice(pos)));
    return out;
  }
  function markActive() {
    const items = list.querySelectorAll('.mos-cmd');
    items.forEach((n, i) => n.classList.toggle('active', i === activeIdx));
    const act = items[activeIdx];
    if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest' });
  }
  function runActiveAt(i) {
    const row = rendered[i];
    if (!row) return;
    close();
    try { row.cmd.run(); } catch (e) { console.error('[menu] command threw', e); }
  }

  // ================================================================ open/close
  let openLayer = null; // 'palette' | 'settings' | 'help' | null
  function open() {
    if (openLayer === 'palette') return;
    closeAll(true);
    openLayer = 'palette';
    activeIdx = 0;
    input.value = '';
    renderList();
    scrim.hidden = false;
    setTimeout(() => input.focus(), 0);
  }
  function close() { closeLayer('palette'); }
  function openSettings() { closeAll(true); openLayer = 'settings'; syncSettingsUI(); setScrim.hidden = false; }
  function openHelp() { closeAll(true); openLayer = 'help'; helpScrim.hidden = false; }
  function closeLayer(which) {
    if (which === 'palette') scrim.hidden = true;
    if (which === 'settings') setScrim.hidden = true;
    if (which === 'help') helpScrim.hidden = true;
    if (openLayer === which) openLayer = null;
  }
  function closeAll(quiet) {
    scrim.hidden = true; setScrim.hidden = true; helpScrim.hidden = true;
    openLayer = null;
  }

  // overlay click-to-dismiss
  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(); });
  setScrim.addEventListener('mousedown', (e) => { if (e.target === setScrim) closeLayer('settings'); });
  helpScrim.addEventListener('mousedown', (e) => { if (e.target === helpScrim) closeLayer('help'); });
  sClose.addEventListener('click', () => closeLayer('settings'));

  // palette input keys
  input.addEventListener('input', () => { activeIdx = 0; renderList(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(rendered.length - 1, activeIdx + 1); markActive(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(0, activeIdx - 1); markActive(); }
    else if (e.key === 'Enter') { e.preventDefault(); runActiveAt(activeIdx); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });

  // ================================================================ global keybinds
  function isTypingTarget(t) {
    if (!t) return false;
    const tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
  }
  function onKeyDown(e) {
    // ⌘K / Ctrl-K — toggle palette (works even from inputs)
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (openLayer === 'palette') close(); else open();
      return;
    }
    // Escape closes whatever overlay is open (handled here for settings/help;
    // palette input handles its own Escape above but this is a safety net).
    if (e.key === 'Escape') {
      if (openLayer) { e.preventDefault(); closeAll(true); }
      return;
    }
    // bare shortcuts only when no overlay open and not typing in a field
    if (openLayer || isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;

    const m = mosaic;
    switch (e.key) {
      case 'f': if (m && m.toggleMaximize) { e.preventDefault(); m.toggleMaximize(); } break;
      case 'r': if (m && m.toggleRaw) { e.preventDefault(); m.toggleRaw(); } break;
      case '[': if (m && m.cycleThread) { e.preventDefault(); m.cycleThread(-1); } break;
      case ']': if (m && m.cycleThread) { e.preventDefault(); m.cycleThread(1); } break;
      case '?': e.preventDefault(); openHelp(); break;
      default:
        if (e.key >= '1' && e.key <= '9') {
          if (m && m.focusTileN) { e.preventDefault(); m.focusTileN(Number(e.key) - 1); }
        }
    }
  }

  // ================================================================ annotate seam
  // Send {t:'annotate',v:1,action,target} via the client; no-op if unavailable.
  function annotate(action, target) {
    const client = ctx.client
      || (typeof window !== 'undefined' && window.wyc && window.wyc.client) || null;
    if (client && typeof client.annotate === 'function') {
      try { client.annotate(action, target || {}); return true; } catch (_) {}
    }
    if (client && typeof client.send === 'function') {
      try { client.send({ t: 'annotate', action, target: target || {} }); return true; } catch (_) {}
    }
    return false; // write path not available (slice-1 stub)
  }

  // ================================================================ focus helpers
  function focusedThreadId() {
    if (view.thread) return view.thread;
    if (mosaic && typeof mosaic.focusedThreadId === 'function') return mosaic.focusedThreadId();
    return null;
  }

  // ================================================================ popstate (Back/Fwd)
  function onPopState() {
    const next = readViewFromUrl();
    let changed = false;
    for (const k of Object.keys(DEFAULT_VIEW)) {
      if (view[k] !== next[k]) { view[k] = next[k]; changed = true; }
    }
    if (changed && mosaic && typeof mosaic.onView === 'function') mosaic.onView(view);
  }

  function onPageHide() { flushSettings(); }

  // ================================================================ wiring
  if (typeof document !== 'undefined') {
    document.body.append(scrim, setScrim, helpScrim, toastEl);
    document.addEventListener('keydown', onKeyDown, true);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('popstate', onPopState);
    window.addEventListener('pagehide', onPageHide);
    // pagehide doesn't fire reliably everywhere; visibilitychange hidden is a backup
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushSettings();
    });
  }
  applyAccent();
  reflectUrl(true); // normalize URL once (replace, don't push)

  // ================================================================ public API
  const api = {
    open, close,
    openSettings, openHelp,
    toast,
    // state surface mosaic reads
    settings, view,
    effLayout, effMode, effDefaultView,
    // single-writer mutators
    setSetting, setView,
    // annotate + handoff
    annotate, copyHandoff,
    // late binding: mosaic.js registers itself
    setController(controller) {
      mosaic = controller;
      ctx.mosaic = controller;
      applyAccent();
      // push current settings/view so the mosaic initializes consistently
      if (mosaic && typeof mosaic.onSettings === 'function') mosaic.onSettings(settings);
      if (mosaic && typeof mosaic.onView === 'function') mosaic.onView(view);
    },
    destroy() {
      flushSettings();
      if (typeof document !== 'undefined') {
        document.removeEventListener('keydown', onKeyDown, true);
        for (const n of [scrim, setScrim, helpScrim, toastEl]) if (n && n.parentNode) n.remove();
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('popstate', onPopState);
        window.removeEventListener('pagehide', onPageHide);
      }
      if (writeTimer) clearTimeout(writeTimer);
      if (urlTimer) clearTimeout(urlTimer);
      if (toastTimer) clearTimeout(toastTimer);
    },
  };
  return api;
}

// ----------------------------------------------------------------- helpers
function safeParse(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch (_) { return null; }
}

export default mountMenu;
