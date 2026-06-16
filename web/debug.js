// @ts-check
/**
 * watchyourclankers — debug.js  (W1 debug view, FR-010)
 * Renders, live, against the store:
 *   (a) SESSION LIST grouped under their THREAD (handoff chain order): name,
 *       project, thread title, status dot (busy/idle/ended), current surface + file.
 *   (b) ACTIVITY TICKER: scrolling log of incoming activities (ts, session, kind
 *       icon, tool, file/detail) — proves total coverage incl. bash/search/task.
 *   (c) TERMINAL panel: for each bash activity, the command then its streamed
 *       output (monospace, newlines preserved, basic ANSI stripping).
 *
 * Honors the mount(el, store) convention (see store.js). Updates are rAF-batched
 * (store.subscribe already coalesces per frame) and append-only / reconciled —
 * NOT full re-render (Principle VII).
 */

import { attachDrag, makeGutter, loadSizes, saveSizes, clamp } from './resize.js';

const KIND_ICON = {
  edit: '✎', write: '✚', read: '👁', bash: '$', search: '🔍',
  task: '⚇', todo: '☑', web: '🌐', other: '•',
};
const STATUS_LABEL = { busy: 'busy', idle: 'idle', ended: 'ended' };

const MAX_TICKER_DOM = 400; // cap rendered ticker rows; trim oldest from the top

// ---- resizable layout (FR-010 panes are user-draggable) --------------------
// The base CSS lays .dbg out via named areas:
//   columns: sessions | (ticker/terminal stack)   rows: ticker / terminal
//     "sessions ticker" / "sessions terminal"
// We override that with explicit line-based placement so we can splice in two
// 6px gutter tracks: a vertical (col-resize) gutter between the sessions pane
// and the right stack, and a horizontal (row-resize) gutter between the ticker
// and terminal panes. Sizes are stored as fractions of the container.
const LAYOUT_KEY = 'wyc.debug.layout.v1';
const GUTTER_PX = 6;
const MIN_FRAC = 0.12;            // no track may collapse below ~12%
const DEFAULTS = { col: 0.44, row: 0.5 }; // col = sessions share of width; row = ticker share of right-stack height
const COLLAPSED_PX = 26;          // a collapsed pane's track shrinks to just its header (~26px)

// ---- collapse-chevron CSS (self-injected, clanker palette) ------------------
// Edited only in debug.js per the parent/agent file matrix, so the collapse UI
// ships its own styles the same way resize.js injects its gutter CSS — no risk of
// the "stylesheet never linked" trap. Idempotent via the id guard.
const DBG_STYLE_ID = 'wyc-debug-collapse-css';
function injectCollapseCss() {
  if (typeof document === 'undefined' || document.getElementById(DBG_STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = DBG_STYLE_ID;
  s.textContent = `
.pane-hdr .pane-collapse{
  cursor:pointer; user-select:none; line-height:1;
  font-size:11px; width:16px; text-align:center; flex:0 0 auto;
  margin-left:8px; color:var(--text-muted,#78716C);
  transition:color .12s ease,transform .12s ease;
}
.pane-hdr .pane-collapse:hover{ color:var(--accent,#C2410C); }
.pane-hdr .pane-collapse:focus-visible{ outline:1px solid var(--accent,#C2410C); outline-offset:1px; }
/* a collapsed pane: hide the body, keep the header (and its live counts) visible */
.dbg-pane.is-collapsed{ overflow:hidden; }
.dbg-pane.is-collapsed > .pane-body{ display:none; }
`;
  document.head.appendChild(s);
}

// ---- helpers ---------------------------------------------------------------
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function fmtTime(ts) {
  if (!ts) return '--:--:--';
  const d = new Date(ts * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function baseName(p) {
  if (!p) return '';
  const s = String(p);
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

// Basic ANSI escape stripping (W1 baseline; W2 may render color via the terminal surface).
const ANSI_RE = /[][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
function stripAnsi(s) { return s ? String(s).replace(ANSI_RE, '') : ''; }

function shorten(s, n) {
  if (!s) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function isNearBottom(node, slack = 40) {
  return node.scrollHeight - node.scrollTop - node.clientHeight < slack;
}

// ---- the view --------------------------------------------------------------
export function mount(el_, store) {
  injectCollapseCss();
  el_.innerHTML = '';
  const root = el('div', 'dbg');

  // A collapse chevron for a pane header (▾ expanded / ▸ collapsed). Clanker-styled
  // via the injected CSS below (--text-muted, hover --accent). The `which` key maps
  // to the layout.collapsed state. Returned so we can sync its glyph on restore.
  function makeChevron(which) {
    const c = el('span', 'pane-collapse', '▾');
    c.setAttribute('role', 'button');
    c.setAttribute('tabindex', '0');
    c.setAttribute('aria-label', 'collapse pane');
    const fire = (e) => { e.preventDefault(); e.stopPropagation(); toggleCollapse(which); };
    c.addEventListener('click', fire);
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fire(e); });
    return c;
  }

  // (a) sessions pane. NOTE: the chevron is appended AFTER .count (far-right, since
  // .count carries margin-left:auto), so we hold an explicit ref to each .count
  // span — the render code must target it directly, not pane-hdr.lastChild (which
  // is now the chevron).
  const sPane = el('div', 'dbg-pane dbg-sessions');
  const sHdr = el('div', 'pane-hdr');
  const sCount = el('span', 'count', '');
  const sChevron = makeChevron('sessions');
  sHdr.append(el('span', 'accent', 'sessions'), sCount, sChevron);
  const sBody = el('div', 'pane-body');
  sPane.append(sHdr, sBody);

  // (b) ticker pane
  const tPane = el('div', 'dbg-pane dbg-ticker');
  const tHdr = el('div', 'pane-hdr');
  const tCount = el('span', 'count', '');
  const tChevron = makeChevron('ticker');
  tHdr.append(el('span', 'accent', 'activity'), tCount, tChevron);
  const tBody = el('div', 'pane-body');
  tPane.append(tHdr, tBody);

  // (c) terminal pane
  const xPane = el('div', 'dbg-pane dbg-terminal');
  const xHdr = el('div', 'pane-hdr');
  const xCount = el('span', 'count', '');
  const xChevron = makeChevron('terminal');
  xHdr.append(el('span', 'accent', 'terminal'), xCount, xChevron);
  const xBody = el('div', 'pane-body term-pane-body');
  xPane.append(xHdr, xBody);

  // ----- resizable gutters -----
  // colGutter sits between sessions (left) and the ticker/terminal stack (right).
  // rowGutter sits between ticker (top-right) and terminal (bottom-right).
  const colGutter = makeGutter('x');
  const rowGutter = makeGutter('y');

  // Explicit line-based placement overrides the named grid-areas so the gutter
  // tracks have somewhere to live. Grid becomes 3 cols × 3 rows:
  //   col 1 = sessions width, col 2 = colGutter, col 3 = right stack
  //   row 1 = ticker height,  row 2 = rowGutter, row 3 = terminal
  sPane.style.gridArea = '1 / 1 / 4 / 2';     // left column, all rows
  colGutter.style.gridArea = '1 / 2 / 4 / 3'; // gutter column, all rows (grab anywhere)
  tPane.style.gridArea = '1 / 3 / 2 / 4';     // right column, top row
  rowGutter.style.gridArea = '2 / 3 / 3 / 4'; // right column, gutter row
  xPane.style.gridArea = '3 / 3 / 4 / 4';     // right column, bottom row

  root.append(sPane, colGutter, tPane, rowGutter, xPane);
  el_.append(root);

  // current fractions + collapsed flags (restored from storage, else defaults)
  const stored = loadSizes(LAYOUT_KEY);
  const sc = (stored && stored.collapsed) || {};
  const layout = {
    col: clampFrac(stored && typeof stored.col === 'number' ? stored.col : DEFAULTS.col),
    row: clampFrac(stored && typeof stored.row === 'number' ? stored.row : DEFAULTS.row),
    collapsed: { sessions: !!sc.sessions, ticker: !!sc.ticker, terminal: !!sc.terminal },
  };
  const chevrons = { sessions: sChevron, ticker: tChevron, terminal: xChevron };
  const panes = { sessions: sPane, ticker: tPane, terminal: xPane };

  function clampFrac(f) { return clamp(f, MIN_FRAC, 1 - MIN_FRAC); }

  // Persist the full layout (fractions + collapsed flags) in one object.
  function persist() {
    saveSizes(LAYOUT_KEY, { col: layout.col, row: layout.row, collapsed: layout.collapsed });
  }

  // Write the grid templates from the current fractions + collapsed flags. The
  // gutter tracks are a fixed 6px; non-collapsed content tracks split the remaining
  // space by fraction. A collapsed track becomes a fixed COLLAPSED_PX (just its
  // header) so the sibling pane reclaims the space.
  //   columns: col1 = sessions | colGutter | col3 = ticker/terminal stack
  //   rows:    row1 = ticker  | rowGutter | row3 = terminal
  // The right column (col3) is never collapsed on the column axis — ticker and
  // terminal collapse along their own rows instead.
  function trackPair(aCollapsed, bCollapsed, aFrac) {
    // Returns CSS sizes for the two content tracks given their collapse flags.
    if (aCollapsed && bCollapsed) return [`${COLLAPSED_PX}px`, `${COLLAPSED_PX}px`];
    if (aCollapsed) return [`${COLLAPSED_PX}px`, 'minmax(0, 1fr)'];
    if (bCollapsed) return ['minmax(0, 1fr)', `${COLLAPSED_PX}px`];
    return [`minmax(0, ${aFrac}fr)`, `minmax(0, ${1 - aFrac}fr)`];
  }
  function applyLayout() {
    // Sessions collapses on the column axis; the right stack column never does.
    const [c1] = trackPair(layout.collapsed.sessions, false, layout.col);
    const c3 = layout.collapsed.sessions ? 'minmax(0, 1fr)' : `minmax(0, ${1 - layout.col}fr)`;
    root.style.gridTemplateColumns = `${c1} ${GUTTER_PX}px ${c3}`;
    // Ticker (row1) and terminal (row3) each collapse on the row axis.
    const [r1, r3] = trackPair(layout.collapsed.ticker, layout.collapsed.terminal, layout.row);
    root.style.gridTemplateRows = `${r1} ${GUTTER_PX}px ${r3}`;
  }

  // Reflect collapsed state onto a pane: hide body via .is-collapsed, swap glyph,
  // update aria. The header (and its live counts) stay visible & keep updating.
  function applyCollapsedClass(which) {
    const on = !!layout.collapsed[which];
    panes[which].classList.toggle('is-collapsed', on);
    const ch = chevrons[which];
    ch.textContent = on ? '▸' : '▾';
    ch.setAttribute('aria-label', on ? 'expand pane' : 'collapse pane');
    ch.setAttribute('aria-expanded', String(!on));
  }
  function syncAllCollapsed() {
    applyCollapsedClass('sessions');
    applyCollapsedClass('ticker');
    applyCollapsedClass('terminal');
  }

  function toggleCollapse(which) {
    layout.collapsed[which] = !layout.collapsed[which];
    applyCollapsedClass(which);
    applyLayout();
    persist();
  }

  syncAllCollapsed();
  applyLayout();

  // Drag math: convert the pixel delta into a fraction of the relevant container
  // dimension (minus the gutter) so dragging tracks the cursor 1:1.
  let startCol = 0, startRow = 0, colSpan = 1, rowSpan = 1;
  attachDrag(colGutter, {
    axis: 'x',
    onStart: () => { startCol = layout.col; colSpan = Math.max(1, root.clientWidth - GUTTER_PX); },
    // Dragging a gutter implicitly re-expands the axis it controls (a collapsed
    // track has no fraction to drag); the sibling reclaims space symmetrically.
    onDelta: (dx) => { layout.collapsed.sessions = false; applyCollapsedClass('sessions'); layout.col = clampFrac(startCol + dx / colSpan); applyLayout(); },
    onEnd: () => persist(),
  });
  attachDrag(rowGutter, {
    axis: 'y',
    onStart: () => { startRow = layout.row; rowSpan = Math.max(1, root.clientHeight - GUTTER_PX); },
    onDelta: (dx, dy) => { layout.collapsed.ticker = false; layout.collapsed.terminal = false; applyCollapsedClass('ticker'); applyCollapsedClass('terminal'); layout.row = clampFrac(startRow + dy / rowSpan); applyLayout(); },  // y-axis: vertical delta is the 2nd arg (H9)
    onEnd: () => persist(),
  });

  // Double-click a gutter resets that axis to its default (and un-collapses it).
  colGutter.addEventListener('dblclick', () => {
    layout.col = DEFAULTS.col; layout.collapsed.sessions = false; applyCollapsedClass('sessions'); applyLayout(); persist();
  });
  rowGutter.addEventListener('dblclick', () => {
    layout.row = DEFAULTS.row; layout.collapsed.ticker = false; layout.collapsed.terminal = false;
    applyCollapsedClass('ticker'); applyCollapsedClass('terminal'); applyLayout(); persist();
  });

  // ----- ticker state: append-only -----
  let tickerMaxSeq = 0;
  const tickerEmpty = el('div', 'empty', 'waiting for activity…');
  tBody.append(tickerEmpty);

  // ----- terminal state: reconcile blocks by ref_seq -----
  /** @type {Map<string, {block:HTMLElement, cmdEl:HTMLElement, outEl:HTMLElement, exitEl:HTMLElement, chunks:number, command:(string|null), done:boolean}>} */
  const termBlocks = new Map(); // key `${session_id}:${ref_seq}`
  const termEmpty = el('div', 'empty', 'no shell commands yet — when Claude runs Bash it shows here');
  xBody.append(termEmpty);

  // ----- session list state: reconcile rows by session id -----
  let sessionSig = ''; // structural signature; rebuild grouping only when it changes
  /** @type {Map<string, any>} */
  const sessionRowEls = new Map(); // id -> {row, dot, name, proj, meta, surface, file}

  // ====================================================================== render
  function renderSessions(state) {
    const threads = store.threadsList();
    const sessions = store.sessionsList();
    sCount.textContent = `${sessions.length} session${sessions.length === 1 ? '' : 's'} · ${threads.length} thread${threads.length === 1 ? '' : 's'}`;

    // Build the desired grouped order: each thread, then its sessions (handoff
    // order); finally any orphan sessions whose thread we don't have.
    const groups = [];
    const seen = new Set();
    for (const th of threads) {
      const ss = store.sessionsForThread(th.id);
      for (const s of ss) seen.add(s.id);
      groups.push({ thread: th, sessions: ss });
    }
    const orphans = sessions.filter((s) => !seen.has(s.id));
    if (orphans.length) groups.push({ thread: null, sessions: orphans });

    // structural signature: thread ids + their ordered session ids
    const sig = groups.map((g) =>
      (g.thread ? g.thread.id + '#' + (g.thread.title || '') : '_orphan') + '=' +
      g.sessions.map((s) => s.id).join(',')
    ).join('|');

    if (sig !== sessionSig) {
      // membership/order changed: rebuild the skeleton, reusing row elements.
      sessionSig = sig;
      sBody.innerHTML = '';
      if (!groups.length || !sessions.length) {
        sBody.append(el('div', 'empty', 'no live sessions detected'));
      }
      for (const g of groups) {
        const grp = el('div', 'thread-group');
        const head = el('div', 'thread-head');
        if (g.thread) {
          head.append(el('span', 'thread-title', g.thread.title || g.thread.id));
          if (g.thread.project) head.append(el('span', 'thread-meta', g.thread.project));
          if (g.sessions.length > 1) {
            const chain = g.sessions.map((s) => s.name || s.id.slice(0, 6)).join(' → ');
            head.append(el('span', 'thread-chain', chain));
          }
        } else {
          head.append(el('span', 'thread-title', '(unthreaded)'));
        }
        grp.append(head);
        for (const s of g.sessions) {
          grp.append(getSessionRow(s.id));
        }
        sBody.append(grp);
      }
    }

    // update every visible row's mutable bits in place (cheap, O(sessions))
    for (const s of sessions) {
      const r = sessionRowEls.get(s.id);
      if (!r) continue;
      r.dot.className = 'sdot ' + (s.status || 'ended');
      r.dot.title = STATUS_LABEL[s.status] || s.status || '';
      r.name.textContent = s.name || s.id.slice(0, 8);
      r.proj.textContent = s.project || '';
      const model = s.model ? ` · ${shorten(s.model, 18)}` : '';
      r.meta.textContent = (s.status || '') + model;
      r.surface.textContent = s.current_surface || '';
      r.file.textContent = baseName(s.current_file);
      r.file.title = s.current_file || '';
    }
  }

  function getSessionRow(id) {
    let r = sessionRowEls.get(id);
    if (r) return r.row;
    const row = el('div', 'session-row');
    const dot = el('span', 'sdot');
    const name = el('span', 'sname');
    const proj = el('span', 'sproj');
    const meta = el('span', 'smeta');
    const cur = el('span', 'scur');
    const surface = el('span', 'surface');
    const file = el('span', 'file');
    cur.append(surface, file);
    row.append(dot, name, proj, meta, cur);
    r = { row, dot, name, proj, meta, surface, file };
    sessionRowEls.set(id, r);
    return row;
  }

  function renderTicker(state) {
    // Append every activity with seq > tickerMaxSeq, in seq order, across all sessions.
    const fresh = [];
    for (const ring of state.activities.values()) {
      for (const a of ring) {
        if (typeof a.seq === 'number' && a.seq > tickerMaxSeq) fresh.push(a);
      }
    }
    if (!fresh.length) return;
    fresh.sort((a, b) => a.seq - b.seq);

    if (tickerEmpty.parentNode) tickerEmpty.remove();
    const stick = isNearBottom(tBody);
    const frag = document.createDocumentFragment();
    for (const a of fresh) {
      tickerMaxSeq = Math.max(tickerMaxSeq, a.seq);
      frag.append(tickerRow(a));
    }
    tBody.append(frag);

    // trim oldest rows to cap DOM size
    while (tBody.childElementCount > MAX_TICKER_DOM) {
      const first = tBody.firstElementChild;
      if (!first) break;
      first.remove();
    }
    if (stick) tBody.scrollTop = tBody.scrollHeight;

    tCount.textContent = `seq ${state.lastSeq}` + (state.gaps ? ` · ${state.gaps} gaps` : '');
  }

  function tickerRow(a) {
    const isErr = a.status === 'error';
    const row = el('div', 'tick-row flash' + (isErr ? ' err' : ''));
    row.append(el('span', 'tick-ts tnum', fmtTime(a.ts)));

    const kind = a.kind || 'other';
    const icon = el('span', 'tick-icon k-' + kind, KIND_ICON[kind] || '•');
    icon.title = a.tool || kind;
    row.append(icon);

    const sess = store.session(a.session_id);
    const label = sess && sess.name ? sess.name : (a.session_id || '').slice(0, 6);
    const sub = a.agent_id ? '↳' : '';
    row.append(el('span', 'tick-sess', sub + label));

    const body = el('span', 'tick-body');
    body.append(el('span', 'tool', a.tool || kind));
    if (a.file_path) {
      const path = el('span', 'path', ' ' + baseName(a.file_path));
      path.title = a.file_path + (a.line ? ':' + a.line : '');
      body.append(path);
    }
    if (a.detail) {
      body.append(el('span', 'detail', '  ' + shorten(a.detail, 90)));
    }
    if (a.status && a.status !== 'start') {
      body.append(el('span', a.status === 'error' ? 'detail' : 'detail', '  [' + a.status + ']'));
    }
    row.append(body);
    return row;
  }

  function renderTerminal(state) {
    // Reconcile one block per (session, ref_seq). Append new output to existing
    // <pre> rather than rebuilding (US2: output streams in).
    let any = false;
    // iterate all sessions' terminal buffers, ordered by ref_seq globally-ish
    const all = [];
    for (const [sid, per] of state.terminals.entries()) {
      for (const buf of per.values()) all.push(buf);
    }
    if (all.length) any = true;
    all.sort((a, b) => a.ref_seq - b.ref_seq);

    if (any && termEmpty.parentNode) termEmpty.remove();

    const stick = isNearBottom(xBody);
    for (const buf of all) {
      const key = buf.session_id + ':' + buf.ref_seq;
      let b = termBlocks.get(key);
      if (!b) {
        const block = el('div', 'term-block');
        const cmd = el('div', 'term-cmd');
        cmd.append(el('span', 'prompt', '$'));
        const cmdEl = el('span', 'cmd');
        cmd.append(cmdEl);
        const sess = store.session(buf.session_id);
        cmd.append(el('span', 'sess', (sess && sess.name ? sess.name : buf.session_id.slice(0, 6))));
        const exitEl = el('span', 'exit run', '…');
        cmd.append(exitEl);
        const outEl = el('pre', 'term-out');
        block.append(cmd, outEl);
        xBody.append(block);
        b = { block, cmdEl, outEl, exitEl, chunks: 0, command: null, done: false };
        termBlocks.set(key, b);
      }
      // command text (may arrive after the first output chunk)
      const cmdText = buf.command != null ? buf.command : '(command pending)';
      if (b.command !== cmdText) { b.cmdEl.textContent = cmdText; b.command = cmdText; }
      // append only new chunks
      if (buf.chunks.length > b.chunks) {
        let added = '';
        for (let i = b.chunks; i < buf.chunks.length; i++) added += buf.chunks[i];
        b.outEl.append(document.createTextNode(stripAnsi(added)));
        b.chunks = buf.chunks.length;
        const out = b.outEl;
        if (isNearBottom(out, 60)) out.scrollTop = out.scrollHeight;
      }
      // exit / done state
      if (buf.done && !b.done) {
        b.done = true;
        const code = buf.exit_code;
        if (code === 0 || code == null) { b.exitEl.className = 'exit ok'; b.exitEl.textContent = code === 0 ? 'exit 0' : 'done'; }
        else { b.exitEl.className = 'exit bad'; b.exitEl.textContent = 'exit ' + code; }
      }
    }

    xCount.textContent = `${termBlocks.size} command${termBlocks.size === 1 ? '' : 's'}`;
    if (stick) xBody.scrollTop = xBody.scrollHeight;
  }

  function render(state) {
    renderSessions(state);
    renderTicker(state);
    renderTerminal(state);
  }

  // initial paint + subscribe (rAF-batched inside the store)
  render(store.getState());
  const unsub = store.subscribe(render);

  return {
    destroy() {
      unsub();
      el_.innerHTML = '';
      termBlocks.clear();
      sessionRowEls.clear();
    },
  };
}

export default mount;
