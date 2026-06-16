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
  el_.innerHTML = '';
  const root = el('div', 'dbg');

  // (a) sessions pane
  const sPane = el('div', 'dbg-pane dbg-sessions');
  const sHdr = el('div', 'pane-hdr');
  sHdr.append(el('span', 'accent', 'sessions'), el('span', 'count', ''));
  const sBody = el('div', 'pane-body');
  sPane.append(sHdr, sBody);

  // (b) ticker pane
  const tPane = el('div', 'dbg-pane dbg-ticker');
  const tHdr = el('div', 'pane-hdr');
  tHdr.append(el('span', 'accent', 'activity'), el('span', 'count', ''));
  const tBody = el('div', 'pane-body');
  tPane.append(tHdr, tBody);

  // (c) terminal pane
  const xPane = el('div', 'dbg-pane dbg-terminal');
  const xHdr = el('div', 'pane-hdr');
  xHdr.append(el('span', 'accent', 'terminal'), el('span', 'count', ''));
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

  // current fractions (restored from storage, else defaults)
  const stored = loadSizes(LAYOUT_KEY);
  const layout = {
    col: clampFrac(stored && typeof stored.col === 'number' ? stored.col : DEFAULTS.col),
    row: clampFrac(stored && typeof stored.row === 'number' ? stored.row : DEFAULTS.row),
  };

  function clampFrac(f) { return clamp(f, MIN_FRAC, 1 - MIN_FRAC); }

  // Write the grid templates from the current fractions. The gutter tracks are a
  // fixed 6px; the two content tracks split the remaining space by fraction.
  function applyLayout() {
    root.style.gridTemplateColumns =
      `minmax(0, ${layout.col}fr) ${GUTTER_PX}px minmax(0, ${1 - layout.col}fr)`;
    root.style.gridTemplateRows =
      `minmax(0, ${layout.row}fr) ${GUTTER_PX}px minmax(0, ${1 - layout.row}fr)`;
  }
  applyLayout();

  // Drag math: convert the pixel delta into a fraction of the relevant container
  // dimension (minus the gutter) so dragging tracks the cursor 1:1.
  let startCol = 0, startRow = 0, colSpan = 1, rowSpan = 1;
  attachDrag(colGutter, {
    axis: 'x',
    onStart: () => { startCol = layout.col; colSpan = Math.max(1, root.clientWidth - GUTTER_PX); },
    onDelta: (dx) => { layout.col = clampFrac(startCol + dx / colSpan); applyLayout(); },
    onEnd: () => saveSizes(LAYOUT_KEY, { col: layout.col, row: layout.row }),
  });
  attachDrag(rowGutter, {
    axis: 'y',
    onStart: () => { startRow = layout.row; rowSpan = Math.max(1, root.clientHeight - GUTTER_PX); },
    onDelta: (dy) => { layout.row = clampFrac(startRow + dy / rowSpan); applyLayout(); },
    onEnd: () => saveSizes(LAYOUT_KEY, { col: layout.col, row: layout.row }),
  });

  // Double-click a gutter resets that axis to its default.
  colGutter.addEventListener('dblclick', () => {
    layout.col = DEFAULTS.col; applyLayout(); saveSizes(LAYOUT_KEY, { col: layout.col, row: layout.row });
  });
  rowGutter.addEventListener('dblclick', () => {
    layout.row = DEFAULTS.row; applyLayout(); saveSizes(LAYOUT_KEY, { col: layout.col, row: layout.row });
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
    sHdr.lastChild.textContent = `${sessions.length} session${sessions.length === 1 ? '' : 's'} · ${threads.length} thread${threads.length === 1 ? '' : 's'}`;

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

    tHdr.lastChild.textContent = `seq ${state.lastSeq}` + (state.gaps ? ` · ${state.gaps} gaps` : '');
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

    xHdr.lastChild.textContent = `${termBlocks.size} command${termBlocks.size === 1 ? '' : 's'}`;
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
