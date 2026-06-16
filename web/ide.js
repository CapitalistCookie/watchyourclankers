// @ts-check
/**
 * watchyourclankers — ide.js  (W2 IDE-spectator pane)
 *
 * Renders ONE thread as a read-only IDE watched over Claude's shoulder:
 *   LEFT    file tree of every file the thread touched (nested, current marked,
 *           a dot on freshly-touched files; click to open/pin a file).
 *   CENTER  tab bar (recent files, cap ~8) + a read-only CodeMirror 6 editor that
 *           AUTO-SWITCHES to whatever file the lead session edits/writes, scrolls
 *           to the hunk line, flash-highlights the changed range, and (briefly)
 *           typewriter-reveals the new hunk. CM language is chosen by extension.
 *   BOTTOM  a live terminal: the lead session's bash commands + streamed output
 *           (ANSI-stripped, autoscroll, exit code) — "watch Claude run shell".
 *   STATUS  "Claude is <surface> <file|detail>" + busy/idle dot + model +
 *           tmux session/group badge, and the RAW-SCREEN toggle.
 *   RAW     a full-bleed mirror of the actual tmux TUI (ANSI->HTML), toggled on.
 *
 * CONTRACT (contracts/events.schema.json) is the seam. Activity carries
 * {kind,tool,file_path,line,hunk_old,hunk_new,detail}; Terminal {ref_seq,data,
 * done,exit_code}; Screen {data,cols,rows}; Session {current_surface,
 * current_file,subagents,model,tmux_session,tmux_group,tmux_pane}; Thread
 * {session_ids,lead_session_id}.
 *
 * STORE (web/store.js) is the only state seam. We subscribe ONCE and update only
 * the surface that changed — no full DOM rebuild per tick (Principle VII).
 *
 * STACK: vanilla JS ES module, NO build step. CodeMirror 6 is dynamically
 * imported from esm.sh (pinned) with a graceful highlighted-<pre> fallback so the
 * editor is never blank if the CDN is unreachable. The editor is read-only.
 *
 * PUBLIC API (W3 mosaic composes this):
 *   import mountIdePane from './ide.js';
 *   const pane = mountIdePane(el, store, { threadId, getToken });
 *   pane.setThread(threadId);   // re-target to another thread
 *   pane.destroy();             // unsubscribe + tear down (incl. unwatch screen)
 *
 * Methods we code to that the PARENT is adding (degrade gracefully if absent):
 *   store.screenForSession(sessionId)   -> latest Screen frame (or undefined)
 *   client.watchScreen(sessionId) / client.unwatchScreen(sessionId)
 *   GET /file?path=<abs>&token=<t> -> {path,content,lines,redacted,truncated}
 */

/* ============================================================ CodeMirror CDN
 * Pinned CodeMirror 6 ESM from esm.sh. `?bundle` collapses each package's own
 * dependency graph into one module (no import waterfall); we pin the shared
 * sub-deps via `external` so state/view aren't duplicated across packages.
 * If ANY of these dynamic imports rejects (offline / CDN down) we fall back to a
 * highlighted <pre>; the pane is never blank. */
const CM_VER = '6.0.1';                 // @codemirror/state + view meta versions
const CM_LANG_VER = '6.10.8';           // @codemirror/language
const CM_THEME_VER = '6.1.2';           // @codemirror/theme-one-dark
const ESM = 'https://esm.sh';
// Keep the shared core singletons un-bundled so every package shares one copy.
const SHARED = 'external=@codemirror/state,@codemirror/view,@codemirror/language,@lezer/highlight,@lezer/common';
const cmUrl = (pkg, ver) => `${ESM}/${pkg}@${ver}?bundle&${SHARED}`;

const CM_IMPORTS = {
  state:   `${ESM}/@codemirror/state@${CM_VER}`,
  view:    `${ESM}/@codemirror/view@${CM_VER}`,
  language:`${ESM}/@codemirror/language@${CM_LANG_VER}`,
  oneDark: `${ESM}/@codemirror/theme-one-dark@${CM_THEME_VER}`,
};
// Language packages, lazily imported per file-extension (pinned majors).
const CM_LANGS = {
  javascript: () => import(cmUrl('@codemirror/lang-javascript', '6.2.4')).then((m) => m.javascript({ jsx: true, typescript: false })),
  typescript: () => import(cmUrl('@codemirror/lang-javascript', '6.2.4')).then((m) => m.javascript({ jsx: true, typescript: true })),
  python:     () => import(cmUrl('@codemirror/lang-python', '6.2.1')).then((m) => m.python()),
  css:        () => import(cmUrl('@codemirror/lang-css', '6.3.1')).then((m) => m.css()),
  html:       () => import(cmUrl('@codemirror/lang-html', '6.4.9')).then((m) => m.html()),
  json:       () => import(cmUrl('@codemirror/lang-json', '6.0.2')).then((m) => m.json()),
  markdown:   () => import(cmUrl('@codemirror/lang-markdown', '6.3.2')).then((m) => m.markdown()),
  rust:       () => import(cmUrl('@codemirror/lang-rust', '6.0.1')).then((m) => m.rust()),
  yaml:       () => import(cmUrl('@codemirror/lang-yaml', '6.1.2')).then((m) => m.yaml()),
};

// extension -> language key
const EXT_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', pyi: 'python',
  css: 'css', scss: 'css', less: 'css',
  html: 'html', htm: 'html', vue: 'html', svelte: 'html',
  json: 'json', jsonc: 'json',
  md: 'markdown', markdown: 'markdown',
  rs: 'rust',
  yml: 'yaml', yaml: 'yaml',
};

/* ============================================================ hljs fallback HL
 * The <pre> fallback (used when the CodeMirror CDN is blocked) is highlighted
 * with the VENDORED highlight.js — it loads from our own /static so it ALWAYS
 * works offline. We inject the UMD bundle + theme once, lazily, on first
 * fallback render, and cache a ready Promise. Degrades to plain text on failure.
 * Per-line highlighting (each .efline independently) keeps the follow-scroll /
 * flash structure intact; multi-line constructs lose cross-line context, which
 * is an accepted trade for keeping offsetTop-per-line meaningful. */
const HLJS_SCRIPT_ID = 'wyc-hljs-script';
const HLJS_THEME_ID = 'wyc-hljs-theme';
const HLJS_SCRIPT_URL = '/static/vendor/highlight.min.js';
const HLJS_THEME_URL = '/static/vendor/hljs-theme.css';

// file-extension -> highlight.js language name. (Distinct from EXT_LANG, which
// maps to CodeMirror lang-package keys; hljs uses its own registry names, e.g.
// `xml` for HTML/SVG, `ini` for TOML.) Unknown/missing -> highlightAuto().
const HLJS_EXT = {
  py: 'python', pyi: 'python',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  json: 'json', jsonc: 'json',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  md: 'markdown', markdown: 'markdown',
  css: 'css', scss: 'css', less: 'css',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  yml: 'yaml', yaml: 'yaml',
  toml: 'ini', ini: 'ini', cfg: 'ini',
  rs: 'rust',
  go: 'go',
  c: 'cpp', h: 'cpp', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  sql: 'sql',
  dockerfile: 'dockerfile',
};
// hljs language name for a path, or '' to fall back to highlightAuto.
function hljsLangFor(path) {
  const ext = extOf(path);
  if (HLJS_EXT[ext]) return HLJS_EXT[ext];
  // extensionless well-known files (e.g. "Dockerfile")
  const base = baseName(path).toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  return '';
}

// Cached ready Promise: resolves to window.hljs once loaded, or null on failure
// (offline / asset missing / parse error). Injected once, guarded by element id.
let _hljsReady = null;
function ensureHljs() {
  if (_hljsReady) return _hljsReady;
  _hljsReady = new Promise((resolve) => {
    try {
      const w = /** @type {any} */ (typeof window !== 'undefined' ? window : null);
      const doc = typeof document !== 'undefined' ? document : null;
      if (!w || !doc || !doc.head) { resolve(null); return; }
      if (w.hljs) { resolve(w.hljs); return; }    // already present somehow
      // theme stylesheet — inject once (failure here is non-fatal: plain tokens)
      if (!doc.getElementById(HLJS_THEME_ID)) {
        const link = doc.createElement('link');
        link.id = HLJS_THEME_ID;
        link.rel = 'stylesheet';
        link.href = HLJS_THEME_URL;
        doc.head.appendChild(link);
      }
      // the UMD bundle — resolve on load, null on error (graceful degrade)
      let script = doc.getElementById(HLJS_SCRIPT_ID);
      if (script) {
        // a previous mount already kicked the load; await its outcome
        if (w.hljs) { resolve(w.hljs); return; }
        script.addEventListener('load', () => resolve(w.hljs || null), { once: true });
        script.addEventListener('error', () => resolve(null), { once: true });
        return;
      }
      script = doc.createElement('script');
      script.id = HLJS_SCRIPT_ID;
      script.src = HLJS_SCRIPT_URL;
      script.async = true;
      script.addEventListener('load', () => resolve(w.hljs || null), { once: true });
      script.addEventListener('error', (e) => { console.warn('[ide] vendored hljs load failed; plain fallback', e); resolve(null); }, { once: true });
      doc.head.appendChild(script);
    } catch (e) {
      console.warn('[ide] hljs inject failed; plain fallback', e);
      resolve(null);
    }
  });
  return _hljsReady;
}

// Highlight one source line to token HTML. Returns null if we should keep the
// caller's plain (escaped) text — empty line, no hljs, or hljs threw.
function hljsLineHtml(hljs, lineText, lang) {
  if (!hljs || lineText === '') return null;   // keep empty lines empty (height)
  try {
    if (lang && typeof hljs.getLanguage === 'function' && hljs.getLanguage(lang)) {
      return hljs.highlight(lineText, { language: lang, ignoreIllegals: true }).value;
    }
    return hljs.highlightAuto(lineText).value;
  } catch (_) {
    return null;   // any hljs throw -> caller's plain escaped text
  }
}

import { attachDrag, makeGutter, loadSizes, saveSizes, clamp } from './resize.js';

const MAX_TABS = 8;
const TYPEWRITER_BUDGET_MS = 600;   // total time we allow the hunk reveal to take
const TYPEWRITER_MAX_CHARS = 400;   // never animate more than this (honesty: edits are hunks)

/* ---- resizer layout (#2): the .ide grid gains explicit gutter tracks so the
 * user can drag tree↔editor (vertical, col-resize) and editor↔terminal
 * (horizontal, row-resize). Persisted to localStorage. Clamp bounds + defaults
 * below; the grid-template is rebuilt from {treeW, termH} on every drag tick. */
const LAYOUT_KEY = 'wyc.ide.layout.v1';
const GUTTER_PX = 6;
const TREE_W_DEFAULT = 150;   // #3: narrower default tree
const TREE_W_MIN = 80;
const TREE_W_MAX = 460;
const TERM_H_DEFAULT = 200;   // bottom terminal default height (px)
const TERM_H_MIN = 60;        // clamp floor
const TERM_FRAC_MAX = 0.60;   // terminal may take at most 60% of grid height

/* ---- collapsible regions (FEATURE A): each region (file tree / editor / bottom
 * terminal) gets a header chevron that collapses its grid track to just its
 * header strip; the OTHER regions absorb the freed space. The tree is a COLUMN
 * (collapses to a narrow vertical rail) and the terminal is a ROW (collapses to
 * its header bar); the editor is the flex middle (collapsing it grows the
 * terminal). Persisted alongside {treeW, termH} in the same LAYOUT_KEY blob. */
const TREE_COLLAPSED_PX = 26;     // collapsed tree column = a thin rail w/ the chevron
const TERM_COLLAPSED_PX = 26;     // collapsed terminal row = just its header strip
const EDITOR_COLLAPSED_PX = 56;   // collapsed editor row = tabbar (32) + meta strip

/* ============================================================ tiny helpers */
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
function dirName(p) {
  if (!p) return '';
  const s = String(p);
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(0, i) : '';
}
function extOf(p) {
  const b = baseName(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i + 1).toLowerCase() : '';
}
function langKeyFor(path) {
  return EXT_LANG[extOf(path)] || null;
}
// Basic ANSI stripping for the terminal feed (matches debug.js baseline).
const ANSI_RE = /\x1b[\[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
function stripAnsi(s) { return s ? String(s).replace(ANSI_RE, '') : ''; }
function isNearBottom(node, slack = 50) {
  return node.scrollHeight - node.scrollTop - node.clientHeight < slack;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  ));
}

/* ANSI SGR -> HTML for the raw-screen mirror. Handles CSI SGR (colors/attrs),
 * strips other CSI/OSC, and renders the visible text with palette-mapped spans.
 * Conservative: unknown sequences are dropped, never echoed. */
function ansiToHtml(input) {
  if (!input) return '';
  const text = String(input);
  let out = '';
  let i = 0;
  // current attribute state
  let fg = null, bg = null;
  const attrs = new Set();
  let spanOpen = false;
  const openSpan = () => {
    const cls = [];
    for (const a of attrs) cls.push('an-' + a);
    if (fg != null) cls.push('fg-' + fg);
    if (bg != null) cls.push('bg-' + bg);
    if (!cls.length) return;
    out += '<span class="' + cls.join(' ') + '">';
    spanOpen = true;
  };
  const closeSpan = () => { if (spanOpen) { out += '</span>'; spanOpen = false; } };
  const flushReopen = () => { closeSpan(); openSpan(); };

  while (i < text.length) {
    const ch = text[i];
    if (ch === '\x1b') {
      const next = text[i + 1];
      if (next === '[') {
        // CSI ... final-byte
        let j = i + 2;
        while (j < text.length && /[0-9;?]/.test(text[j])) j++;
        const final = text[j];
        const params = text.slice(i + 2, j);
        if (final === 'm') {
          applySgr(params, attrs, (f) => { fg = f; }, (b) => { bg = b; }, () => { fg = null; bg = null; attrs.clear(); });
          flushReopen();
        }
        // any other CSI (cursor moves, erase, etc.) — drop
        i = (final ? j + 1 : text.length);
        continue;
      } else if (next === ']') {
        // OSC ... BEL or ST — drop
        let j = i + 2;
        while (j < text.length && text[j] !== '\x07' && !(text[j] === '\x1b' && text[j + 1] === '\\')) j++;
        i = (text[j] === '\x07') ? j + 1 : (text[j] === '\x1b' ? j + 2 : text.length);
        continue;
      } else {
        // other escape (e.g. ESC( charset) — skip ESC + one byte
        i += 2;
        continue;
      }
    }
    if (ch === '\r') { i++; continue; }      // CR: rendered <pre> ignores it
    out += escapeHtml(ch);
    i++;
  }
  closeSpan();
  return out;
}
function applySgr(params, attrs, setFg, setBg, reset) {
  const codes = (params || '0').split(';').map((x) => (x === '' ? 0 : parseInt(x, 10)));
  for (let k = 0; k < codes.length; k++) {
    const c = codes[k];
    if (c === 0) { reset(); }
    else if (c === 1 || c === 3 || c === 4 || c === 7 || c === 9) attrs.add(c);
    else if (c === 22) { attrs.delete(1); }
    else if (c === 23) attrs.delete(3);
    else if (c === 24) attrs.delete(4);
    else if (c === 27) attrs.delete(7);
    else if (c === 29) attrs.delete(9);
    else if (c >= 30 && c <= 37) setFg(c - 30);
    else if (c >= 90 && c <= 97) setFg(c - 90 + 8);
    else if (c === 39) setFg(null);
    else if (c >= 40 && c <= 47) setBg(c - 40);
    else if (c >= 100 && c <= 107) setBg(c - 100); // bright bg -> base bucket
    else if (c === 49) setBg(null);
    else if (c === 38 || c === 48) {
      // extended color: 5;n (256) or 2;r;g;b — collapse to nearest 0..15 bucket
      const isFg = c === 38;
      if (codes[k + 1] === 5) { const n = codes[k + 2]; (isFg ? setFg : setBg)(n == null ? null : (n % 16)); k += 2; }
      else if (codes[k + 1] === 2) { (isFg ? setFg : setBg)(7); k += 4; }
    }
  }
}

/* ============================================================ the view */
/**
 * @param {HTMLElement} mountEl
 * @param {any} store
 * @param {{threadId?:string, getToken?:()=>string}} [opts]
 * @returns {{destroy():void, setThread(threadId:string):void}}
 */
export function mountIdePane(mountEl, store, opts = {}) {
  let threadId = opts.threadId || null;
  const getToken = typeof opts.getToken === 'function' ? opts.getToken : () => '';

  // resolve the client (for watch/unwatch screen). Prefer the store, fall back
  // to the global app wiring; tolerate absence entirely.
  function getClient() {
    if (store && typeof store.client === 'function') { try { return store.client(); } catch (_) {} }
    if (store && store.client && typeof store.client === 'object') return store.client;
    const w = /** @type {any} */ (typeof window !== 'undefined' ? window : {});
    return (w.wyc && w.wyc.client) || null;
  }

  // collapse chevron factory (FEATURE A). One small ▾/▸ button per region header;
  // clicking toggles that region's collapsed state via toggleCollapse (defined in
  // the layout section below — the handler closes over it, so it's resolved by the
  // time a click fires). `region` keys into the `collapsed` map; `label` is for a11y.
  const chevronEls = {};
  function makeChevron(region, label) {
    const b = el('button', 'ide-chevron', '▾');
    b.type = 'button';
    b.dataset.region = region;
    b.setAttribute('aria-label', `collapse ${label}`);
    b.title = `collapse / expand ${label}`;
    b.addEventListener('click', (ev) => { ev.stopPropagation(); toggleCollapse(region); });
    chevronEls[region] = b;
    return b;
  }

  /* -------------------------------------------------- DOM skeleton (built once) */
  mountEl.innerHTML = '';
  const root = el('div', 'ide');

  // --- left: file tree
  const treePane = el('div', 'ide-pane ide-tree');
  const treeHdr = el('div', 'ide-hdr');
  // collapse chevron (FEATURE A) — collapses the tree COLUMN to a thin rail.
  const treeChevron = makeChevron('tree', 'files');
  treeHdr.append(treeChevron, el('span', 'accent', 'files'), el('span', 'count', ''));
  const treeBody = el('div', 'ide-body');
  const treeList = el('div', 'tree-list');
  treeBody.append(treeList);
  treePane.append(treeHdr, treeBody);

  // --- center: tabs + meta + editor
  const editorPane = el('div', 'ide-pane ide-editor');
  const tabbar = el('div', 'tabbar');
  const editorMeta = el('div', 'editor-meta');
  // collapse chevron (FEATURE A) — collapses the editor ROW to its tab+meta
  // strip (grows the terminal). Lives in the meta bar so the tabbar is untouched.
  const editorChevron = makeChevron('editor', 'editor');
  const epath = el('span', 'epath');
  editorMeta.append(editorChevron, epath);
  const editorWrap = el('div', 'editor-wrap');
  const editorEmpty = el('div', 'editor-empty', 'no file open — the editor follows what Claude edits');
  editorWrap.append(editorEmpty);
  editorPane.append(tabbar, editorMeta, editorWrap);

  // --- bottom: terminal
  const termPane = el('div', 'ide-pane ide-terminal');
  const termHdr = el('div', 'ide-hdr');
  // collapse chevron (FEATURE A) — collapses the terminal ROW to its header strip.
  const termChevron = makeChevron('terminal', 'terminal');
  termHdr.append(termChevron, el('span', 'icon', '$'), el('span', 'accent', 'terminal'), el('span', 'count', ''));
  const termBody = el('div', 'ide-body');
  const termFeed = el('div', 'term-feed');
  const termEmpty = el('div', 'terminal-empty', 'no shell commands yet — when Claude runs Bash it shows here');
  termBody.append(termEmpty, termFeed);
  termPane.append(termHdr, termBody);

  // --- raw tmux screen overlay (hidden unless .raw)
  const screenPane = el('div', 'ide-screen');
  const screenHdr = el('div', 'screen-hdr');
  screenHdr.append(el('span', 'accent', 'raw screen'), el('span', 'sname', ''), el('span', 'dims', ''));
  const screenBody = el('div', 'screen-body');
  const screenPre = el('pre', 'screen-pre waiting');
  screenPre.textContent = 'waiting for tmux frames…';
  screenBody.append(screenPre);
  screenPane.append(screenHdr, screenBody);

  // --- status line
  const statusBar = el('div', 'ide-pane ide-status');
  const stDot = el('span', 'st-dot');
  const stClaude = el('span', 'st-claude');
  const stSpacer = el('span', 'st-spacer');
  const stModel = el('span', 'st-badge model');
  const stSub = el('span', 'st-badge sub');
  const stTmux = el('span', 'st-badge tmux');
  const rawBtn = el('button', 'st-raw', 'raw screen');
  rawBtn.type = 'button';
  statusBar.append(stDot, stClaude, stSpacer, stSub, stModel, stTmux, rawBtn);

  // --- resize gutters (#2). They live as real grid children so they occupy the
  // gutter tracks added to grid-template-{columns,rows}. gCol sits between
  // tree|editor (drag x); gRow sits between editor|terminal (drag y).
  // Placement is line-based via the .ide-gutter-col / .ide-gutter-row CSS rules
  // (which agree with the explicit track template JS sets below). We deliberately
  // do NOT set grid-area here: the .ide grid uses numbered tracks, not named
  // areas, so a named grid-area would silently fail to place.
  const gCol = makeGutter('x');
  gCol.classList.add('ide-gutter', 'ide-gutter-col');
  gCol.title = 'drag to resize · double-click to reset';
  const gRow = makeGutter('y');
  gRow.classList.add('ide-gutter', 'ide-gutter-row');
  gRow.title = 'drag to resize · double-click to reset';

  root.append(treePane, gCol, editorPane, gRow, termPane, screenPane, statusBar);
  mountEl.append(root);

  /* -------------------------------------------------- layout (resizer) state */
  // Current layout sizes (px). Restored from localStorage on mount; written back
  // (debounced) on drag end. The grid-template is recomputed from these.
  let treeW = TREE_W_DEFAULT;
  let termH = TERM_H_DEFAULT;
  // collapsed-region flags (FEATURE A), persisted in the same LAYOUT_KEY blob.
  const collapsed = { tree: false, editor: false, terminal: false };
  (function restoreLayout() {
    const s = loadSizes(LAYOUT_KEY);
    if (s && typeof s.treeW === 'number' && isFinite(s.treeW)) treeW = clamp(s.treeW, TREE_W_MIN, TREE_W_MAX);
    if (s && typeof s.termH === 'number' && isFinite(s.termH)) termH = Math.max(TERM_H_MIN, s.termH);
    if (s && s.collapsed && typeof s.collapsed === 'object') {
      collapsed.tree = !!s.collapsed.tree;
      collapsed.editor = !!s.collapsed.editor;
      collapsed.terminal = !!s.collapsed.terminal;
    }
  })();

  // Persist BOTH the drag sizes AND the collapsed flags together (debounced) so a
  // collapse/expand or a resize never drops the other half of the layout state.
  function persistLayout() { saveSizes(LAYOUT_KEY, { treeW, termH, collapsed: { ...collapsed } }); }

  // Build & apply grid-template-columns/rows from the current treeW / termH AND
  // the collapse flags. Collapsing a region shrinks its track to just its header
  // strip; the freed space flows to the remaining flexible region.
  // Layout:  [tree treeW] [gutter 6px] [editor 1fr]   (columns)
  //          [editor 1fr] [gutter 6px] [terminal termH] [status auto]  (rows)
  // Status row spans all 3 columns; raw-screen overlay is absolute so it's free.
  // - tree collapsed  -> col 1 becomes a thin rail (TREE_COLLAPSED_PX)
  // - terminal collapsed -> row 3 becomes its header strip (TERM_COLLAPSED_PX)
  // - editor collapsed -> row 1 becomes its tab+meta strip (EDITOR_COLLAPSED_PX),
  //   handing the flex 1fr to the terminal. If BOTH editor + terminal collapse,
  //   the editor keeps the 1fr (you can't collapse the only flexible region away).
  function applyGridTemplate() {
    const gridH = root.clientHeight || 0;
    // ---- columns: tree | gutter | editor
    const tw = collapsed.tree ? TREE_COLLAPSED_PX : clamp(treeW, TREE_W_MIN, TREE_W_MAX);
    root.style.gridTemplateColumns = `${tw}px ${GUTTER_PX}px minmax(0, 1fr)`;
    // ---- rows: editor | gutter | terminal | status
    let editorRow, termRow;
    if (collapsed.editor && !collapsed.terminal) {
      // editor collapsed -> strip; terminal takes the flexible space
      editorRow = `${EDITOR_COLLAPSED_PX}px`;
      termRow = 'minmax(0, 1fr)';
    } else if (collapsed.terminal) {
      // terminal collapsed -> header strip; editor takes the flexible space
      // (covers terminal-only AND editor+terminal-both-collapsed: editor wins 1fr)
      editorRow = 'minmax(0, 1fr)';
      termRow = `${TERM_COLLAPSED_PX}px`;
    } else {
      // neither collapsed: editor flexes, terminal is its dragged px (60% ceiling)
      const maxTerm = gridH > 0 ? Math.max(TERM_H_MIN, Math.floor(gridH * TERM_FRAC_MAX)) : Infinity;
      editorRow = 'minmax(0, 1fr)';
      termRow = `${clamp(termH, TERM_H_MIN, maxTerm)}px`;
    }
    root.style.gridTemplateRows = `${editorRow} ${GUTTER_PX}px ${termRow} auto`;
  }

  // Toggle / apply collapse for one region. Reflects state to the root (CSS
  // hooks the rail + chevron glyph), rebuilds the grid template, hides the now-
  // inert resize gutter for that boundary, and persists. CM relayout is nudged so
  // it re-measures into the new editor height (no-op for the <pre> fallback).
  function applyCollapsedClasses() {
    root.classList.toggle('tree-collapsed', collapsed.tree);
    root.classList.toggle('editor-collapsed', collapsed.editor);
    root.classList.toggle('terminal-collapsed', collapsed.terminal);
    if (chevronEls.tree)     chevronEls.tree.textContent = collapsed.tree ? '▸' : '▾';
    if (chevronEls.editor)   chevronEls.editor.textContent = collapsed.editor ? '▸' : '▾';
    if (chevronEls.terminal) chevronEls.terminal.textContent = collapsed.terminal ? '▸' : '▾';
    // a collapsed region's resize gutter is inert (hidden): tree gutter when the
    // tree is a rail; the editor↔terminal gutter when either of them is collapsed.
    gCol.classList.toggle('inert', collapsed.tree);
    gRow.classList.toggle('inert', collapsed.editor || collapsed.terminal);
  }
  function toggleCollapse(region, force) {
    if (!(region in collapsed)) return;
    const next = typeof force === 'boolean' ? force : !collapsed[region];
    if (next === collapsed[region]) return;
    collapsed[region] = next;
    applyCollapsedClasses();
    applyGridTemplate();
    persistLayout();
    // let CM re-measure into the resized editor track next frame
    if (cm && cm.view) { try { requestAnimationFrame(() => { if (cm && cm.view) cm.view.requestMeasure(); }); } catch (_) {} }
  }

  applyCollapsedClasses();
  applyGridTemplate();

  // tree ↔ editor (vertical gutter, drag x)
  let dragStartTreeW = treeW;
  attachDrag(gCol, {
    axis: 'x',
    onStart: () => { dragStartTreeW = treePane.getBoundingClientRect().width; },
    onDelta: (dx) => { if (collapsed.tree) return; treeW = clamp(dragStartTreeW + dx, TREE_W_MIN, TREE_W_MAX); applyGridTemplate(); },
    onEnd: () => { persistLayout(); },
  });
  gCol.addEventListener('dblclick', () => {
    treeW = TREE_W_DEFAULT; applyGridTemplate(); persistLayout();
  });

  // editor ↔ terminal (horizontal gutter, drag y). Dragging DOWN grows the
  // editor / shrinks the terminal, so the terminal height moves by -dy.
  let dragStartTermH = termH;
  attachDrag(gRow, {
    axis: 'y',
    onStart: () => { dragStartTermH = termPane.getBoundingClientRect().height; },
    onDelta: (dy) => {
      if (collapsed.editor || collapsed.terminal) return; // gutter inert when collapsed
      const gridH = root.clientHeight || 0;
      const maxTerm = gridH > 0 ? Math.max(TERM_H_MIN, Math.floor(gridH * TERM_FRAC_MAX)) : Infinity;
      termH = clamp(dragStartTermH - dy, TERM_H_MIN, maxTerm);
      applyGridTemplate();
    },
    onEnd: () => { persistLayout(); },
  });
  gRow.addEventListener('dblclick', () => {
    termH = TERM_H_DEFAULT; applyGridTemplate(); persistLayout();
  });

  // Re-clamp the terminal height if the pane is resized (keeps the 60% ceiling
  // honest when the surrounding tile shrinks). Tolerate absence of RO.
  let layoutRO = null;
  if (typeof ResizeObserver !== 'undefined') {
    layoutRO = new ResizeObserver(() => { if (!destroyed) applyGridTemplate(); });
    try { layoutRO.observe(root); } catch (_) { layoutRO = null; }
  }

  /* -------------------------------------------------- mutable view state */
  let destroyed = false;

  // editor: CodeMirror handle (or null while loading / if it failed)
  /** @type {{view:any, EditorState:any, EditorView:any, Compartment:any, langCompartment:any, baseExts:any[], oneDark:any}|null} */
  let cm = null;
  let cmLoading = false;
  let cmFailed = false;
  const langCache = new Map();        // langKey -> resolved CM extension
  let fallbackEl = null;              // <pre> fallback element (if used)
  // bumps on every fallback render so a pending async hljs highlight pass — AND a
  // running typewriter reveal (FEATURE B) — can detect it was superseded (a newer
  // live-edit re-render) and abort instead of painting stale tokens/chunks.
  let fallbackHlGen = 0;
  // FEATURE B: handle for the in-flight hunk-reveal timer (so we can cancel it).
  let fallbackRevealTimer = 0;

  // tabs: ordered most-recent-last; activeTab is the path shown.
  /** @type {string[]} */
  let tabs = [];
  let activeTab = null;
  /** @type {Map<string, HTMLElement>} */
  const tabEls = new Map();           // path -> tab button element
  let pinned = false;                 // operator clicked a file -> pause auto-follow
  let pinnedPath = null;

  // file content cache: path -> {content, lines, redacted, truncated, recon, ts}
  /** @type {Map<string, any>} */
  const fileCache = new Map();
  /** @type {Map<string, Promise<any>>} */
  const fileInflight = new Map();
  // per-path fetch generation: a forced re-fetch bumps it so a slower, EARLIER
  // request can't clobber the cache with stale content after a newer edit landed.
  /** @type {Map<string, number>} */
  const fileGen = new Map();
  let fetchToken = 0;                 // bumps to cancel stale async editor swaps

  // tree: signature-gated rebuild + per-file row reuse
  let treeSig = '';
  /** @type {Map<string, HTMLElement>} */
  const fileRowEls = new Map();       // path -> .tree-node.file
  /** @type {Map<string, HTMLElement>} */
  const dirRowEls = new Map();        // dirpath -> .tree-node.dir
  /** @type {Set<string>} */
  const collapsedDirs = new Set();
  /** @type {Map<string, number>} */
  const touchedAt = new Map();        // path -> last edit/write ts (for the dot)

  // terminal: reconcile blocks by ref_seq
  /** @type {Map<number, {block:HTMLElement, cmdEl:HTMLElement, outEl:HTMLElement, exitEl:HTMLElement, chunks:number, command:(string|null), done:boolean}>} */
  const termBlocks = new Map();
  let termSession = null;             // which session's terminal we're showing

  // auto-switch bookkeeping: the highest edit/write seq we've already reacted to
  let lastEditSeq = 0;

  // ---- follow-lines (#1) state -------------------------------------------
  // When Claude edits the open file we SCROLL TO + FLASH the changed region and
  // keep following each new edit. The user can scroll away to pause; a chip lets
  // them resume. `followPaused` gates auto-scroll (flash still happens).
  let followPaused = false;
  let lastFollowLine = 0;          // last line we auto-scrolled the editor to
  let suppressScrollWatch = false; // ignore scroll events we trigger ourselves
  let followRAF = 0;               // rAF handle for the next follow tick
  let followChip = null;           // the "following paused — click to resume" chip
  // raw screen
  let rawOn = false;
  let watchedScreenSession = null;
  let lastScreenSeq = -1;

  // current lead session (thread-follow)
  let leadId = null;

  /* ==================================================================== editor */
  // Lazy-load CodeMirror once; build a read-only editor in editorWrap. If any
  // import fails, mark cmFailed and use the <pre> fallback for all files.
  async function ensureEditor() {
    if (cm || cmFailed) return cm;
    if (cmLoading) return null;
    cmLoading = true;
    try {
      const [stateMod, viewMod, langMod, themeMod] = await Promise.all([
        import(CM_IMPORTS.state),
        import(CM_IMPORTS.view),
        import(CM_IMPORTS.language),
        import(CM_IMPORTS.oneDark).catch(() => ({ oneDark: [] })), // theme optional
      ]);
      if (destroyed) { cmLoading = false; return null; }
      const { EditorState, Compartment } = stateMod;
      const { EditorView, lineNumbers, highlightActiveLine, drawSelection } = viewMod;
      const { syntaxHighlighting, defaultHighlightStyle, foldGutter, bracketMatching } = langMod;
      const oneDark = themeMod.oneDark || [];
      const langCompartment = new Compartment();
      const baseExts = [
        lineNumbers(),
        foldGutter ? foldGutter() : [],
        drawSelection ? drawSelection() : [],
        bracketMatching ? bracketMatching() : [],
        highlightActiveLine ? highlightActiveLine() : [],
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        EditorView.editable.of(false),  // READ-ONLY (Principle I — observer)
        EditorState.readOnly.of(true),
        EditorView.lineWrapping,
        oneDark,
        EditorView.theme({
          '&': { backgroundColor: 'transparent', color: 'var(--fg)' },
          '.cm-gutters': { backgroundColor: 'var(--bg-1)', border: 'none', color: 'var(--fg-faint)' },
          '.cm-activeLineGutter': { backgroundColor: 'var(--bg-2)' },
        }),
      ];
      const view = new EditorView({
        state: EditorState.create({ doc: '', extensions: [langCompartment.of([]), ...baseExts] }),
      });
      cm = { view, EditorState, EditorView, Compartment, langCompartment, baseExts, oneDark };
      cmLoading = false;
      return cm;
    } catch (e) {
      console.warn('[ide] CodeMirror CDN load failed; using <pre> fallback', e);
      cmFailed = true;
      cmLoading = false;
      return null;
    }
  }

  async function langExtFor(path) {
    const key = langKeyFor(path);
    if (!key) return [];
    if (langCache.has(key)) return langCache.get(key);
    try {
      const ext = await CM_LANGS[key]();
      langCache.set(key, ext);
      return ext;
    } catch (e) {
      console.debug('[ide] lang load failed for', key, e);
      langCache.set(key, []);
      return [];
    }
  }

  // mount the CM view into editorWrap (replacing empty/fallback) lazily
  function attachCmDom() {
    if (!cm || cm.view.dom.parentNode === editorWrap) return;
    if (editorEmpty.parentNode) editorEmpty.remove();
    if (fallbackEl && fallbackEl.parentNode) fallbackEl.remove();
    editorWrap.append(cm.view.dom);
  }

  // render content via the highlighted <pre> fallback (no CM). This path renders
  // headless, so following MUST be correct here: we scroll the fallback's own
  // scroll container to the target line, flash it, and bind a manual-scroll watch.
  // When a live edit lands (`hunkNew` given) we don't snap the changed region in:
  // we typewriter-REVEAL it (FEATURE B) to feel like it's being written.
  function renderFallback(path, content, focusLine, follow, hunkNew) {
    if (editorEmpty.parentNode) editorEmpty.remove();
    if (cm && cm.view.dom.parentNode) cm.view.dom.remove();
    if (!fallbackEl) {
      fallbackEl = el('pre', 'editor-fallback');
      const note = el('div', 'editor-fallback-note', 'editor offline · highlighted plain view');
      editorWrap.append(note, fallbackEl);
      bindFallbackScrollWatch();
    }
    cancelFallbackReveal();          // stop any reveal from a prior render
    const myGen = ++fallbackHlGen;   // invalidate any in-flight highlight pass + reveal
    fallbackEl.innerHTML = '';
    const lines = String(content == null ? '' : content).split('\n');
    // Each source line is its own .efline block (so offsetTop is meaningful for
    // the follow-scroll, and the flash is a per-line block). The line text lives
    // in a child .ef-code span so syntax highlighting (which rewrites .ef-code's
    // innerHTML) never disturbs the .ln gutter or the trailing newline.
    const frag = document.createDocumentFragment();
    /** @type {HTMLElement[]} */
    const codeEls = [];
    for (let i = 0; i < lines.length; i++) {
      const lineEl = el('span', 'efline');
      lineEl.append(el('span', 'ln', String(i + 1)));
      const codeEl = el('span', 'ef-code');
      codeEl.textContent = lines[i];     // plain text first — correct + layout-safe
      lineEl.append(codeEl);
      lineEl.append(document.createTextNode('\n'));
      frag.append(lineEl);
      codeEls.push(codeEl);
    }
    fallbackEl.append(frag);

    // Decide the changed-line REVEAL range (FEATURE B). The reveal is gated to a
    // live follow-edit with a non-empty hunk; a plain tree/tab open just renders +
    // flashes. We reveal [startIdx, endIdx] (0-based) where startIdx is the located
    // hunk line and the span is hunk_new's own line count, clamped to the file.
    let reveal = null;
    if (follow && !followPaused && focusLine && focusLine > 0 && typeof hunkNew === 'string' && hunkNew.trim()) {
      const startIdx = Math.max(0, Math.min(focusLine - 1, lines.length - 1));
      const hunkLineCount = hunkNew.replace(/\n+$/, '').split('\n').length;
      const endIdx = Math.max(startIdx, Math.min(startIdx + hunkLineCount - 1, lines.length - 1));
      reveal = { startIdx, endIdx };
    }

    // Highlight each line once hljs is ready. We tag the rendered content with a
    // gen token so a re-render (live edit re-fetch) that lands while a prior
    // highlight pass is still pending can't paint stale tokens over new text. The
    // reveal range is SKIPPED here (the reveal owns those lines + re-highlights
    // them itself as they settle), so the async pass can't clobber the animation.
    highlightFallbackLines(path, lines, codeEls, myGen, reveal);

    if (focusLine && focusLine > 0) {
      const idx = Math.max(1, Math.min(focusLine, lines.length));
      const target = fallbackEl.children[idx - 1];
      // ALWAYS flash the changed line (re-trigger the animation by reflow)
      if (target) {
        target.classList.remove('wyc-hunk-flash', 'wyc-hunk-line');
        void target.offsetWidth;
        target.classList.add('wyc-hunk-flash', 'wyc-hunk-line');
        setTimeout(() => { target.classList.remove('wyc-hunk-flash'); }, 1600);
        setTimeout(() => { target.classList && target.classList.remove('wyc-hunk-line'); }, 2400);
      }
      // auto-SCROLL the container only when following (honors the pause state)
      if (follow && !followPaused) {
        lastFollowLine = idx;
        scrollFallbackToLine(idx, false);
      }
    }

    // Kick the typewriter reveal LAST (after layout + scroll anchor are set).
    if (reveal) revealHunkInFallback(path, lines, codeEls, reveal, follow, myGen);
  }

  // Apply per-line hljs highlighting to an already-rendered fallback. Async: it
  // awaits the lazily-injected (vendored) hljs, then rewrites each .ef-code span's
  // innerHTML with token markup. Plain escaped text remains if hljs never loads,
  // a line is empty, or hljs throws. `gen` guards against a newer fallback render
  // (live-edit re-fetch) superseding this pass mid-flight. `skip` (a {startIdx,
  // endIdx} range, optional) leaves those lines alone — they're under an active
  // typewriter reveal which re-highlights them itself once each settles.
  function highlightFallbackLines(path, lines, codeEls, gen, skip) {
    ensureHljs().then((hljs) => {
      if (!hljs || destroyed) return;             // graceful degrade -> plain text
      if (gen !== fallbackHlGen || !fallbackEl) return; // superseded by a re-render
      const lang = hljsLangFor(path);
      for (let i = 0; i < codeEls.length; i++) {
        if (skip && i >= skip.startIdx && i <= skip.endIdx) continue; // reveal owns these
        const html = hljsLineHtml(hljs, lines[i], lang);
        if (html != null) codeEls[i].innerHTML = html;  // null -> keep plain text
      }
    });
  }

  // Cancel any in-flight typewriter reveal (FEATURE B). Bumping fallbackHlGen in
  // renderFallback already makes the running reveal's gen check abort on its next
  // tick; this also clears the pending timer immediately so nothing fires after a
  // teardown / file switch.
  function cancelFallbackReveal() {
    if (fallbackRevealTimer) { try { clearTimeout(fallbackRevealTimer); } catch (_) {} fallbackRevealTimer = 0; }
  }

  // FEATURE B — STREAMING / TYPEWRITER REVEAL of a freshly-landed hunk.
  // HONESTY: the transcript carries the WHOLE new hunk, not a sub-hunk character
  // stream — there is nothing real to replay keystroke-by-keystroke. So this is a
  // SIMULATED reveal: we already have the final text; we just unveil the changed
  // region progressively (in small word/char chunks) so the user sees code "being
  // written" instead of snapping in. It only paints text we genuinely received,
  // never invents content, operates on the (read-only) fallback view, and settles
  // to the exact full hljs-highlighted content.
  //
  // Mechanics: clear the changed lines, then walk a flat chunk list across the
  // region (word-ish chunks, ~14ms/step). Follow-scroll tracks the revealing line.
  // We hard-cap total duration (TYPEWRITER_BUDGET_MS) AND total revealed chars
  // (TYPEWRITER_MAX_CHARS): if the hunk is big we reveal a prefix then SNAP the
  // rest so it never lags. A newer render bumps fallbackHlGen and the gen check
  // here aborts (the new render's own reveal takes over).
  function revealHunkInFallback(path, lines, codeEls, range, follow, gen) {
    const { startIdx, endIdx } = range;
    // Build the ordered reveal plan: a list of {li, chunk} where li is the line
    // index and chunk is the next ~word to append. Split on whitespace boundaries
    // (keep the whitespace attached) so it reads like words appearing.
    /** @type {{li:number, chunk:string}[]} */
    const plan = [];
    let totalChars = 0;
    for (let li = startIdx; li <= endIdx && li < codeEls.length; li++) {
      const text = lines[li] || '';
      codeEls[li].textContent = '';                 // start the changed line empty
      // chunk into word-ish pieces: runs of non-space, each trailing run of space.
      const pieces = text.match(/\S+\s*|\s+/g) || (text ? [text] : []);
      for (const p of pieces) { plan.push({ li, chunk: p }); totalChars += p.length; }
    }
    if (!plan.length) return;   // nothing to reveal (all blank lines)

    // running plain text per line (escaped on write); committed lazily.
    const built = new Map();    // li -> string revealed so far
    const ensure = (li) => { if (!built.has(li)) built.set(li, ''); return built.get(li); };

    // Pace so the animated prefix fits inside the time budget, with a per-step
    // floor (snappy) and ceiling (smooth). We cap BOTH dimensions: chars (don't
    // animate more than TYPEWRITER_MAX_CHARS) AND steps-by-time (don't exceed the
    // wall-clock budget even for a hunk of many tiny tokens — budget/MIN_STEP_MS
    // steps max). Whichever cap bites first, the rest of the hunk SNAPS in.
    const MIN_STEP_MS = 8, MAX_STEP_MS = 25;
    const animChars = Math.min(totalChars, TYPEWRITER_MAX_CHARS);
    // step count bounded by the char budget...
    let stepsByChars = plan.length, acc = 0;
    for (let i = 0; i < plan.length; i++) { acc += plan[i].chunk.length; if (acc > animChars) { stepsByChars = i + 1; break; } }
    // ...AND by the time budget (so total animated time can't exceed the budget).
    const stepsByTime = Math.max(1, Math.floor(TYPEWRITER_BUDGET_MS / MIN_STEP_MS));
    const animSteps = Math.min(stepsByChars, stepsByTime);
    const perStep = clamp(Math.floor(TYPEWRITER_BUDGET_MS / Math.max(1, animSteps)), MIN_STEP_MS, MAX_STEP_MS);

    let i = 0;
    const settleLine = (li) => {
      // settle one line to its full text, then hljs-highlight it in place.
      const full = lines[li] || '';
      codeEls[li].textContent = full;
      ensureHljs().then((hljs) => {
        if (!hljs || destroyed || gen !== fallbackHlGen || !fallbackEl) return;
        const html = hljsLineHtml(hljs, full, hljsLangFor(path));
        if (html != null && codeEls[li]) codeEls[li].innerHTML = html;
      });
    };
    const snapRest = () => {
      // reveal everything left instantly (big hunk / over budget): settle every
      // line in the region to its full, highlighted text in one shot.
      for (let li = startIdx; li <= endIdx && li < codeEls.length; li++) settleLine(li);
      if (follow && !followPaused) { lastFollowLine = Math.min(endIdx + 1, lines.length); scrollFallbackToLine(lastFollowLine, false); }
      fallbackRevealTimer = 0;
    };

    const tick = () => {
      // aborted by a newer render / teardown / file-switch?
      if (destroyed || gen !== fallbackHlGen || !fallbackEl) { fallbackRevealTimer = 0; return; }
      if (i >= animSteps) { snapRest(); return; }    // animated prefix done -> snap remainder
      const { li, chunk } = plan[i];
      const next = ensure(li) + chunk;
      built.set(li, next);
      if (codeEls[li]) codeEls[li].textContent = next;   // plain text while typing (escaped via textContent)
      // when this step completes a line (next plan entry is a new line, or end),
      // settle + highlight the finished line so revealed code colorizes as it lands.
      const isLineEnd = (i + 1 >= plan.length) || plan[i + 1].li !== li;
      if (isLineEnd) settleLine(li);
      // follow the revealing line (1-based), honoring the pause state
      if (follow && !followPaused) {
        lastFollowLine = li + 1;
        scrollFallbackToLine(li + 1, false);
      }
      i++;
      fallbackRevealTimer = setTimeout(tick, perStep);
    };
    cancelFallbackReveal();
    fallbackRevealTimer = setTimeout(tick, perStep);
  }

  // Scroll the fallback container so `line` (1-based) is vertically centered.
  // We compute the offset directly (scrollIntoView on a child can scroll the
  // whole page) so this is exercised correctly headless.
  function scrollFallbackToLine(line, forceUnpause) {
    if (!fallbackEl) return;
    const idx = Math.max(1, Math.min(line, fallbackEl.children.length));
    const target = fallbackEl.children[idx - 1];
    if (!target) return;
    if (forceUnpause) followPaused = false;
    suppressScrollWatch = true;
    try {
      const want = target.offsetTop - (fallbackEl.clientHeight / 2) + (target.offsetHeight / 2);
      fallbackEl.scrollTop = Math.max(0, want);
    } catch (_) {}
    setTimeout(() => { suppressScrollWatch = false; }, 120);
  }

  // Manual-scroll watch for the fallback: pause follow when the latest edit line
  // scrolls out of view, resume when it returns near the center.
  let fallbackScrollBound = false;
  function bindFallbackScrollWatch() {
    if (fallbackScrollBound || !fallbackEl) return;
    fallbackScrollBound = true;
    fallbackEl.addEventListener('scroll', () => {
      if (suppressScrollWatch || destroyed || !fallbackEl) return;
      onUserScroll(() => {
        if (!lastFollowLine) return true;
        const idx = Math.max(1, Math.min(lastFollowLine, fallbackEl.children.length));
        const target = fallbackEl.children[idx - 1];
        if (!target) return true;
        const top = fallbackEl.scrollTop;
        const vh = fallbackEl.clientHeight;
        return target.offsetTop >= top - 40 && (target.offsetTop + target.offsetHeight) <= top + vh + 40;
      });
    }, { passive: true });
  }

  // ---- locate-by-hunk (#1) ------------------------------------------------
  // The backend usually leaves Activity.line null, so we LOCATE the edit in the
  // freshly-fetched content ourselves: take the first substantive (non-blank)
  // line of hunk_new, trimmed, and string-match it in `content`. Prefer the
  // occurrence NEAREST to the hint line (Activity.line), else the LAST occurrence
  // (a write/append edit's new content is usually toward the end of the file).
  // Returns a 1-based line number, or the hint (or 1) if we can't find it.
  function locateHunkLine(content, hunkNew, hint) {
    const hintLine = (typeof hint === 'number' && hint > 0) ? hint : 0;
    if (typeof content !== 'string' || !content) return hintLine || 1;
    const lines = content.split('\n');
    // first substantive line of the new hunk
    let needle = '';
    if (typeof hunkNew === 'string' && hunkNew) {
      for (const raw of hunkNew.split('\n')) {
        const t = raw.trim();
        if (t) { needle = t; break; }
      }
    }
    if (!needle) return hintLine || 1;
    // collect every line index whose trimmed text contains the needle (cheap,
    // robust to leading-indent differences between hunk + file).
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      const lt = lines[i].trim();
      if (lt && (lt === needle || lt.indexOf(needle) >= 0)) hits.push(i + 1);
    }
    if (!hits.length) return hintLine || 1;
    if (hits.length === 1) return hits[0];
    // multiple matches: pick the one nearest the hint if we have one, else last.
    if (hintLine) {
      let best = hits[0], bestD = Math.abs(hits[0] - hintLine);
      for (const h of hits) { const d = Math.abs(h - hintLine); if (d < bestD) { bestD = d; best = h; } }
      return best;
    }
    return hits[hits.length - 1];
  }

  // Set the editor's document to `content` for `path`, choose the language, then
  // (optionally) scroll-to + flash the hunk line, and typewriter-reveal newHunk.
  async function showFileInEditor(path, content, focusLine, hunkNew, follow) {
    const myToken = ++fetchToken;
    const doc = String(content == null ? '' : content);
    // LOCATE the change ourselves (Activity.line is usually null): match the
    // first substantive line of hunk_new in the freshly-fetched content. The
    // passed focusLine is only a hint.
    const targetLine = (hunkNew != null)
      ? locateHunkLine(doc, hunkNew, focusLine)
      : (focusLine && focusLine > 0 ? focusLine : 0);

    await ensureEditor();
    if (destroyed || myToken !== fetchToken) return; // a newer swap superseded us

    if (cmFailed || !cm) {
      renderFallback(path, doc, targetLine, follow, hunkNew);
      return;
    }
    attachCmDom();
    bindCmScrollWatch();
    const langExt = await langExtFor(path);
    if (destroyed || myToken !== fetchToken) return;

    const { view, EditorState, langCompartment, baseExts } = cm;
    // full reset of doc + language (cheap; we only do this on a file switch / re-edit)
    view.setState(EditorState.create({ doc, extensions: [langCompartment.of(langExt), ...baseExts] }));

    // scroll to + flash the changed line (auto-follow honors the pause state)
    if (targetLine && targetLine > 0) {
      flashAndScrollCm(targetLine, hunkNew, follow);
    }
  }

  // Scroll to a line in CM (when following), and add a transient flash
  // decoration on the changed line. We ALWAYS flash so the eye catches the edit
  // even while follow is paused; we only auto-SCROLL when follow is active.
  function flashAndScrollCm(line, hunkNew, follow) {
    if (!cm) return;
    const { view } = cm;
    try {
      const total = view.state.doc.lines;
      const ln = Math.max(1, Math.min(line, total));
      const pos = view.state.doc.line(ln).from;
      if (follow && !followPaused) {
        lastFollowLine = ln;
        suppressScrollWatch = true;            // ignore the scroll we cause
        view.dispatch({ effects: cm.EditorView.scrollIntoView(pos, { y: 'center' }) });
        // release the self-scroll guard after CM settles (covers the rAF + layout)
        setTimeout(() => { suppressScrollWatch = false; }, 120);
      }
      // flash the line via a DOM class on the rendered .cm-line (simple + dep-free)
      requestAnimationFrame(() => {
        let lineBlock, dom;
        try { lineBlock = view.lineBlockAt(pos); dom = view.domAtPos(lineBlock.from); }
        catch (_) { return; }                  // line not in viewport (paused, far away)
        let node = dom && dom.node;
        while (node && node.nodeType === 3) node = node.parentNode;
        while (node && !(node.classList && node.classList.contains('cm-line'))) node = node.parentNode;
        if (node && node.classList) {
          node.classList.add('wyc-hunk-flash', 'wyc-hunk-line');
          setTimeout(() => { node.classList.remove('wyc-hunk-flash'); }, 1600);
          setTimeout(() => { node.classList && node.classList.remove('wyc-hunk-line'); }, 2400);
        }
      });
    } catch (e) { console.debug('[ide] flash/scroll failed', e); }
    // NOTE: a true keystroke replay would be dishonest — an Edit is a hunk, not
    // typed input. The reveal is a brief illustrative flourish, not a fabrication
    // of typing; we cap it hard and it operates only on the highlight, not by
    // inserting characters into the (read-only) doc.
  }

  // ---- manual-override chip (#1) -----------------------------------------
  // Show/hide a small "following paused — click to resume" chip in the editor.
  function showFollowChip() {
    if (followChip) { followChip.classList.add('on'); return; }
    followChip = el('button', 'wyc-follow-chip on', 'following paused — click to resume');
    followChip.type = 'button';
    followChip.title = 'resume auto-follow of Claude’s edits';
    followChip.addEventListener('click', (e) => { e.stopPropagation(); resumeFollow(true); });
    editorWrap.append(followChip);
  }
  function hideFollowChip() { if (followChip) followChip.classList.remove('on'); }

  function pauseFollow() {
    if (followPaused) return;
    followPaused = true;
    showFollowChip();
  }
  // Resume following. If `jump` and we know the last edit line, scroll back to it.
  function resumeFollow(jump) {
    followPaused = false;
    hideFollowChip();
    if (jump && lastFollowLine > 0) {
      if (cm && cm.view && cm.view.dom.parentNode === editorWrap) {
        try {
          const total = cm.view.state.doc.lines;
          const ln = Math.max(1, Math.min(lastFollowLine, total));
          const pos = cm.view.state.doc.line(ln).from;
          suppressScrollWatch = true;
          cm.view.dispatch({ effects: cm.EditorView.scrollIntoView(pos, { y: 'center' }) });
          setTimeout(() => { suppressScrollWatch = false; }, 120);
        } catch (_) {}
      } else if (fallbackEl && fallbackEl.parentNode) {
        scrollFallbackToLine(lastFollowLine, true);
      }
    }
  }

  // Watch the CM scroller for a MANUAL scroll: if the user drifts away from the
  // latest edit line, pause follow; if they scroll back near it, auto-resume.
  let cmScrollBound = false;
  function bindCmScrollWatch() {
    if (cmScrollBound || !cm || !cm.view) return;
    const scroller = cm.view.scrollDOM;
    if (!scroller) return;
    cmScrollBound = true;
    scroller.addEventListener('scroll', () => {
      if (suppressScrollWatch || destroyed || !cm) return;
      onUserScroll(() => {
        // is the last-followed line still roughly centered/visible?
        if (!lastFollowLine) return true;
        try {
          const ln = Math.max(1, Math.min(lastFollowLine, cm.view.state.doc.lines));
          const block = cm.view.lineBlockAt(cm.view.state.doc.line(ln).from);
          const top = cm.view.scrollDOM.scrollTop;
          const vh = cm.view.scrollDOM.clientHeight;
          return block.top >= top - 40 && block.bottom <= top + vh + 40;
        } catch (_) { return true; }
      });
    }, { passive: true });
  }

  // Common manual-scroll handler: pause when the edit scrolls out of view,
  // resume (no jump) when it comes back near. `isLatestVisible` returns bool.
  function onUserScroll(isLatestVisible) {
    const visible = isLatestVisible();
    if (!visible && !followPaused) pauseFollow();
    else if (visible && followPaused) resumeFollow(false);
  }

  /* ==================================================================== files */
  function fileUrl(path, bust) {
    const t = getToken();
    // On a forced re-fetch (live edit) add a cache-buster so the browser/proxy
    // can't hand us a stale copy of the file we just saw change.
    const b = bust ? `&_=${Date.now()}` : '';
    return `/file?path=${encodeURIComponent(path)}${t ? `&token=${encodeURIComponent(t)}` : ''}${b}`;
  }

  // fetch (with cache + de-dup). force=true bypasses cache + cache-busts the URL
  // (re-edit of the open file). A forced fetch also overrides any inflight cached
  // fetch so we don't reuse a request issued before the edit landed.
  function fetchFile(path, force) {
    if (!force && fileCache.has(path)) return Promise.resolve(fileCache.get(path));
    if (!force && fileInflight.has(path)) return fileInflight.get(path);
    // bump this path's generation; only the LATEST generation may write the cache,
    // so a slow earlier fetch that resolves after a newer forced one can't clobber
    // fresh content with stale (the live-follow re-fetch path depends on this).
    const gen = (fileGen.get(path) || 0) + 1;
    fileGen.set(path, gen);
    const isLatest = () => fileGen.get(path) === gen;
    const p = fetch(fileUrl(path, force), { cache: force ? 'no-store' : 'default', headers: { Accept: 'application/json' } })
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((j) => {
        const rec = {
          content: typeof j.content === 'string' ? j.content : '',
          lines: typeof j.lines === 'number' ? j.lines : null,
          redacted: !!j.redacted,
          truncated: !!j.truncated,
          recon: false,
          ts: Date.now(),
        };
        if (isLatest()) { fileCache.set(path, rec); fileInflight.delete(path); }
        return rec;
      })
      .catch((e) => {
        if (isLatest()) fileInflight.delete(path);
        // fall back to reconstructing from activity hunks, else a placeholder
        const rec = reconstructFromHunks(path) || {
          content: `// ${baseName(path)}\n// (could not load file: ${e && e.message ? e.message : e})\n// ${path}`,
          lines: null, redacted: false, truncated: false, recon: true, ts: Date.now(),
        };
        if (isLatest()) fileCache.set(path, rec);
        return rec;
      });
    fileInflight.set(path, p);
    return p;
  }

  // Best-effort: stitch the latest known hunk_new for `path` across the thread's
  // sessions into a placeholder document so the editor is never blank on a 404.
  function reconstructFromHunks(path) {
    const acts = activitiesForThread().filter(
      (a) => a.file_path === path && (a.kind === 'edit' || a.kind === 'write') && typeof a.hunk_new === 'string'
    );
    if (!acts.length) return null;
    acts.sort((a, b) => a.seq - b.seq);
    const latest = acts[acts.length - 1];
    let body;
    if (latest.kind === 'write') {
      body = latest.hunk_new;
    } else {
      // edits are partial: show the most recent new hunk, framed honestly
      body = latest.hunk_new;
    }
    const header =
      `// ${baseName(path)} — reconstructed from observed ${latest.kind} hunk (file not directly readable)\n` +
      `// ${path}\n` +
      (latest.kind === 'edit' ? `// NOTE: this is the changed hunk only, not the whole file.\n` : '') +
      `\n`;
    return { content: header + body, lines: null, redacted: false, truncated: latest.kind === 'edit', recon: true, ts: Date.now() };
  }

  // Open a file in the editor (used by both auto-switch and manual tree clicks).
  // opts2.follow = this is a LIVE edit we should auto-scroll to (auto-switch);
  // a manual tree/tab click opens without forcing a follow-scroll.
  function openFile(path, focusLine, opts2 = {}) {
    if (!path) return;
    // Switching to a different file resets the follow anchor (the old line# is
    // meaningless in the new file) and clears any stale "paused" chip. A
    // follow-driven open re-establishes the anchor below.
    if (path !== activeTab) { lastFollowLine = 0; followPaused = false; hideFollowChip(); }
    addTab(path, !!opts2.flash);
    setActiveTab(path);
    updateEditorMeta(path);
    const force = !!opts2.force;
    const hunkNew = opts2.hunkNew || null;
    const follow = !!opts2.follow;
    fetchFile(path, force).then((rec) => {
      if (destroyed || activeTab !== path) return; // user/auto moved on
      updateEditorMeta(path, rec);
      showFileInEditor(path, rec.content, focusLine, hunkNew, follow);
    });
  }

  function updateEditorMeta(path, rec) {
    epath.textContent = path || '';
    epath.title = path || '';
    // drop old badges
    for (const b of [...editorMeta.querySelectorAll('.badge')]) b.remove();
    if (!rec) return;
    if (rec.recon)     editorMeta.append(el('span', 'badge recon', 'reconstructed'));
    if (rec.redacted)  editorMeta.append(el('span', 'badge redacted', 'redacted'));
    if (rec.truncated) editorMeta.append(el('span', 'badge truncated', 'truncated'));
  }

  /* ==================================================================== tabs */
  function addTab(path, flash) {
    if (tabs.includes(path)) {
      if (flash) {
        const t = tabEls.get(path);
        if (t) { t.classList.remove('flash'); void t.offsetWidth; t.classList.add('flash'); }
      }
      return;
    }
    tabs.push(path);
    const t = buildTab(path);
    tabbar.append(t);
    tabEls.set(path, t);
    if (flash) { void t.offsetWidth; t.classList.add('flash'); }
    // cap: evict the oldest non-active tab
    while (tabs.length > MAX_TABS) {
      const victim = tabs[0] === activeTab ? tabs[1] : tabs[0];
      closeTab(victim, true);
    }
  }

  function buildTab(path) {
    const t = el('button', 'tab');
    t.type = 'button';
    t.dataset.path = path;
    const lk = langKeyFor(path);
    t.append(el('span', 'tab-icon', iconForLang(lk)));
    t.append(el('span', 'tab-name', baseName(path)));
    const d = baseName(dirName(path));
    if (d) t.append(el('span', 'tab-dir', d));
    t.append(el('span', 'tab-pin', '📌'));
    const close = el('span', 'tab-close', '×');
    close.title = 'close tab';
    t.append(close);
    t.title = path;
    t.addEventListener('click', (ev) => {
      if (ev.target === close) { ev.stopPropagation(); closeTab(path); return; }
      // manual selection pins (pauses auto-follow) until the same file is edited
      pinned = true; pinnedPath = path;
      openFile(path);
    });
    return t;
  }

  function iconForLang(lk) {
    switch (lk) {
      case 'javascript': return 'JS';
      case 'typescript': return 'TS';
      case 'python': return 'PY';
      case 'css': return '#';
      case 'html': return '<>';
      case 'json': return '{}';
      case 'markdown': return 'MD';
      case 'rust': return 'RS';
      case 'yaml': return 'YML';
      default: return '·';
    }
  }

  function setActiveTab(path) {
    activeTab = path;
    for (const [p, t] of tabEls) {
      const on = p === path;
      t.classList.toggle('active', on);
      t.classList.toggle('pinned', pinned && p === pinnedPath && on);
    }
    markCurrentInTree(path);
  }

  function closeTab(path, silent) {
    const idx = tabs.indexOf(path);
    if (idx < 0) return;
    tabs.splice(idx, 1);
    const t = tabEls.get(path);
    if (t && t.parentNode) t.remove();
    tabEls.delete(path);
    if (pinnedPath === path) { pinned = false; pinnedPath = null; }
    if (activeTab === path && !silent) {
      const nxt = tabs[idx] || tabs[idx - 1] || tabs[tabs.length - 1] || null;
      if (nxt) openFile(nxt);
      else { activeTab = null; clearEditor(); }
    } else if (activeTab === path) {
      activeTab = null;
    }
  }

  function clearEditor() {
    epath.textContent = '';
    for (const b of [...editorMeta.querySelectorAll('.badge')]) b.remove();
    cancelFallbackReveal();          // stop any in-flight typewriter reveal (FEATURE B)
    if (cm && cm.view.dom.parentNode) cm.view.dom.remove();
    if (fallbackEl && fallbackEl.parentNode) { fallbackEl.remove(); fallbackEl = null; fallbackScrollBound = false; }
    if (!editorEmpty.parentNode) editorWrap.append(editorEmpty);
    // reset follow state (no file = nothing to follow)
    followPaused = false; lastFollowLine = 0; hideFollowChip();
  }

  /* ==================================================================== thread helpers */
  function currentThread() {
    return threadId ? store.thread(threadId) : null;
  }
  function leadSessionId() {
    const th = currentThread();
    if (th && th.lead_session_id) return th.lead_session_id;
    // fall back to the newest session in the chain
    const ss = threadId ? store.sessionsForThread(threadId) : [];
    return ss.length ? ss[ss.length - 1].id : null;
  }
  function leadSession() {
    const id = leadSessionId();
    return id ? store.session(id) : null;
  }
  // all activities across the thread's sessions, in seq order
  function activitiesForThread() {
    if (!threadId) return [];
    const ss = store.sessionsForThread(threadId);
    const out = [];
    for (const s of ss) {
      const ring = store.activitiesForSession(s.id);
      for (const a of ring) out.push(a);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  /* ==================================================================== file tree */
  // Build the set of distinct touched files across the thread, nested by path.
  function renderTree() {
    const acts = activitiesForThread();
    // distinct file_path with most-recent touch ts and whether it's an edit/write
    const files = new Map(); // path -> {ts, edited}
    for (const a of acts) {
      if (!a.file_path) continue;
      const edited = a.kind === 'edit' || a.kind === 'write';
      const prev = files.get(a.file_path);
      if (!prev || a.ts > prev.ts) files.set(a.file_path, { ts: a.ts, edited: edited || (prev && prev.edited) });
      else if (edited) prev.edited = true;
      if (edited) touchedAt.set(a.file_path, Math.max(touchedAt.get(a.file_path) || 0, a.ts));
    }
    const paths = [...files.keys()].sort();
    treeHdr.lastChild.textContent = `${paths.length} file${paths.length === 1 ? '' : 's'}`;

    // signature: which paths exist (membership). Recently-touched dots + current
    // marker are applied separately so we don't rebuild on every tick.
    const sig = paths.join('');
    if (sig !== treeSig) {
      treeSig = sig;
      buildTreeDom(paths);
    }
    // refresh the touched dots (fade old ones) cheaply
    const now = Date.now() / 1000;
    for (const [path, row] of fileRowEls) {
      const tt = touchedAt.get(path) || 0;
      const recent = tt && (now - tt) < 12;       // dot bright for 12s after a touch
      row.classList.toggle('touched', !!tt);
      row.classList.toggle('fade', !!tt && !recent);
    }
    markCurrentInTree(activeTab);
  }

  // Build a nested tree DOM from a flat sorted path list (common-prefix folding).
  function buildTreeDom(paths) {
    treeList.innerHTML = '';
    fileRowEls.clear();
    dirRowEls.clear();
    if (!paths.length) {
      treeList.append(el('div', 'editor-empty', 'no files touched yet'));
      return;
    }
    // collapse to a common root so we don't render endless single-child dirs
    const root = commonPrefix(paths);
    // build a nested object tree
    const tree = {};
    for (const p of paths) {
      const rel = root ? p.slice(root.length).replace(/^\//, '') : p.replace(/^\//, '');
      const parts = rel.split('/');
      let node = tree;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const isFile = i === parts.length - 1;
        if (isFile) {
          node[part] = { __file: p };
        } else {
          node[part] = node[part] || { __dir: true, __children: {} };
          node = node[part].__children;
        }
      }
    }
    if (root) {
      const rootRow = el('div', 'tree-node dir');
      rootRow.append(el('span', 'tw-twist', '▾'), el('span', 'tw-icon', '▣'),
        el('span', 'tw-name', root + '/'));
      rootRow.title = root;
      treeList.append(rootRow);
    }
    renderTreeLevel(tree, root ? 1 : 0, treeList, root);
  }

  function renderTreeLevel(node, depth, container, prefix) {
    // dirs first, then files; alpha within each
    const dirNames = Object.keys(node).filter((k) => node[k].__dir).sort();
    const fileNames = Object.keys(node).filter((k) => node[k].__file).sort();
    for (const name of dirNames) {
      const dpath = prefix ? prefix + '/' + name : name;
      const row = el('div', 'tree-node dir');
      row.style.paddingLeft = (6 + depth * 10) + 'px';   // #3: smaller indent step
      row.append(el('span', 'tw-twist', '▾'), el('span', 'tw-icon', '▸'), el('span', 'tw-name', name));
      row.title = dpath;
      const childWrap = el('div', 'tree-children');
      row.addEventListener('click', () => {
        const collapsed = childWrap.style.display === 'none';
        childWrap.style.display = collapsed ? '' : 'none';
        row.classList.toggle('collapsed', !collapsed);
        if (collapsed) collapsedDirs.delete(dpath); else collapsedDirs.add(dpath);
      });
      dirRowEls.set(dpath, row);
      container.append(row, childWrap);
      renderTreeLevel(node[name].__children, depth + 1, childWrap, dpath);
      if (collapsedDirs.has(dpath)) { childWrap.style.display = 'none'; row.classList.add('collapsed'); }
    }
    for (const name of fileNames) {
      const full = node[name].__file;
      const row = el('div', 'tree-node file');
      row.style.paddingLeft = (6 + depth * 10) + 'px';   // #3: smaller indent step
      row.append(el('span', 'tw-twist', ''), el('span', 'tw-icon', iconGlyph(full)),
        el('span', 'tw-name', name), el('span', 'tw-dot'));
      row.title = full;
      row.addEventListener('click', () => {
        pinned = true; pinnedPath = full;
        openFile(full);
      });
      fileRowEls.set(full, row);
      container.append(row);
    }
  }

  function iconGlyph(path) {
    const lk = langKeyFor(path);
    return lk ? '▪' : '▫';
  }

  function markCurrentInTree(path) {
    for (const [p, row] of fileRowEls) row.classList.toggle('current', p === path);
  }

  /* ==================================================================== terminal */
  function renderTerminal() {
    const lead = leadSessionId();
    if (lead !== termSession) {
      // lead changed (handoff or re-target): reset the terminal feed
      termSession = lead;
      termBlocks.clear();
      termFeed.innerHTML = '';
      if (!termEmpty.parentNode) termBody.insertBefore(termEmpty, termFeed);
    }
    if (!lead) return;
    const bufs = store.terminalForSession(lead) || [];
    if (bufs.length && termEmpty.parentNode) termEmpty.remove();

    const stick = isNearBottom(termBody);
    for (const buf of bufs) {
      let b = termBlocks.get(buf.ref_seq);
      if (!b) {
        const block = el('div', 'term-block flash');
        const cmd = el('div', 'term-cmd');
        cmd.append(el('span', 'prompt', '$'));
        const cmdEl = el('span', 'cmd');
        cmd.append(cmdEl);
        const exitEl = el('span', 'exit run', '…');
        cmd.append(exitEl);
        const outEl = el('pre', 'term-out');
        block.append(cmd, outEl);
        termFeed.append(block);
        b = { block, cmdEl, outEl, exitEl, chunks: 0, command: null, done: false };
        termBlocks.set(buf.ref_seq, b);
      }
      const cmdText = buf.command != null ? buf.command : '(command pending)';
      if (b.command !== cmdText) { b.cmdEl.textContent = cmdText; b.command = cmdText; }
      if (buf.chunks.length > b.chunks) {
        let added = '';
        for (let i = b.chunks; i < buf.chunks.length; i++) added += buf.chunks[i];
        b.outEl.append(document.createTextNode(stripAnsi(added)));
        b.chunks = buf.chunks.length;
      }
      if (buf.done && !b.done) {
        b.done = true;
        const code = buf.exit_code;
        if (code === 0 || code == null) { b.exitEl.className = 'exit ok'; b.exitEl.textContent = code === 0 ? 'exit 0' : 'done'; }
        else { b.exitEl.className = 'exit bad'; b.exitEl.textContent = 'exit ' + code; }
      }
    }
    termHdr.lastChild.textContent = `${termBlocks.size} cmd${termBlocks.size === 1 ? '' : 's'}`;
    if (stick) termBody.scrollTop = termBody.scrollHeight;
  }

  /* ==================================================================== status */
  function renderStatus() {
    const s = leadSession();
    if (!s) {
      stDot.className = 'st-dot ended';
      stClaude.textContent = threadId ? 'no live session in this thread' : 'no thread selected';
      stModel.textContent = ''; stModel.hidden = true;
      stTmux.textContent = ''; stTmux.hidden = true;
      stSub.textContent = ''; stSub.hidden = true;
      rawBtn.hidden = true;
      return;
    }
    stDot.className = 'st-dot ' + (s.status || 'ended');
    stDot.title = s.status || '';
    // "Claude is <surface> <file|detail>"
    const surface = s.current_surface || (s.status === 'busy' ? 'working' : 'idle');
    const obj = s.current_file ? baseName(s.current_file) : '';
    stClaude.innerHTML = '';
    stClaude.append(document.createTextNode('Claude is '));
    stClaude.append(el('span', 'verb', surface));
    if (obj) { stClaude.append(document.createTextNode(' ')); stClaude.append(el('span', 'obj', obj)); }
    stClaude.title = s.current_file || '';

    if (s.model) { stModel.hidden = false; stModel.textContent = s.model; }
    else { stModel.hidden = true; }

    const subN = Array.isArray(s.subagents) ? s.subagents.length : 0;
    if (subN) { stSub.hidden = false; stSub.textContent = `↳ ${subN} sub-agent${subN === 1 ? '' : 's'}`; }
    else { stSub.hidden = true; }

    const tmux = s.tmux_session
      ? (s.tmux_session + (s.tmux_group && s.tmux_group !== s.tmux_session ? ' · ' + s.tmux_group : '')
         + (s.tmux_pane ? ' [' + s.tmux_pane + ']' : ''))
      : '';
    if (tmux) { stTmux.hidden = false; stTmux.textContent = tmux; }
    else { stTmux.hidden = true; }

    // raw-screen toggle is only meaningful if the client supports it
    const client = getClient();
    const canScreen = !!(client && typeof client.watchScreen === 'function');
    rawBtn.hidden = !canScreen;
    if (!canScreen && rawOn) toggleRaw(false); // client lost capability -> exit raw
  }

  /* ==================================================================== raw screen */
  function toggleRaw(force) {
    const next = typeof force === 'boolean' ? force : !rawOn;
    if (next === rawOn) return;
    rawOn = next;
    root.classList.toggle('raw', rawOn);
    rawBtn.textContent = rawOn ? 'exit raw' : 'raw screen';
    const client = getClient();
    const lead = leadSessionId();
    if (rawOn) {
      lastScreenSeq = -1;
      screenPre.className = 'screen-pre waiting';
      screenPre.textContent = 'waiting for tmux frames…';
      const sname = leadSession();
      screenHdr.querySelector('.sname').textContent = sname && sname.name ? sname.name : (lead ? lead.slice(0, 8) : '');
      if (client && typeof client.watchScreen === 'function' && lead) {
        try { client.watchScreen(lead); watchedScreenSession = lead; } catch (e) { console.debug('[ide] watchScreen failed', e); }
      }
      renderScreen(); // paint whatever's already buffered
    } else {
      if (client && typeof client.unwatchScreen === 'function' && watchedScreenSession) {
        try { client.unwatchScreen(watchedScreenSession); } catch (e) { console.debug('[ide] unwatchScreen failed', e); }
      }
      watchedScreenSession = null;
    }
  }

  // If the lead session changed while raw is on, re-point the watch.
  function syncScreenWatch() {
    if (!rawOn) return;
    const lead = leadSessionId();
    if (lead === watchedScreenSession) return;
    const client = getClient();
    if (client && typeof client.unwatchScreen === 'function' && watchedScreenSession) {
      try { client.unwatchScreen(watchedScreenSession); } catch (_) {}
    }
    if (client && typeof client.watchScreen === 'function' && lead) {
      try { client.watchScreen(lead); } catch (_) {}
    }
    watchedScreenSession = lead;
    lastScreenSeq = -1;
    const sname = leadSession();
    screenHdr.querySelector('.sname').textContent = sname && sname.name ? sname.name : (lead ? lead.slice(0, 8) : '');
  }

  function renderScreen() {
    if (!rawOn) return;
    const lead = leadSessionId();
    if (!lead || typeof store.screenForSession !== 'function') return;
    const frame = store.screenForSession(lead);
    if (!frame) return;
    if (typeof frame.seq === 'number' && frame.seq === lastScreenSeq) return; // no change
    lastScreenSeq = typeof frame.seq === 'number' ? frame.seq : lastScreenSeq;
    screenPre.className = 'screen-pre';
    screenPre.innerHTML = ansiToHtml(frame.data || '');
    const dims = (frame.cols && frame.rows) ? `${frame.cols}×${frame.rows}` : '';
    screenHdr.querySelector('.dims').textContent = dims;
  }

  /* ==================================================================== auto-switch */
  // React to the lead session's newest edit/write: switch tab, scroll, flash.
  function handleAutoSwitch() {
    const lead = leadSessionId();
    if (!lead) return;
    const ring = store.activitiesForSession(lead);
    if (!ring || !ring.length) return;
    // find the newest edit/write with a file_path that we haven't reacted to
    let target = null;
    for (let i = ring.length - 1; i >= 0; i--) {
      const a = ring[i];
      if (typeof a.seq !== 'number' || a.seq <= lastEditSeq) break; // ring is seq-ordered
      if ((a.kind === 'edit' || a.kind === 'write') && a.file_path) { target = a; break; }
    }
    // advance the watermark past everything currently in the ring tail so we only
    // ever react to genuinely-new edits (even if `target` is null this tick)
    const newest = ring[ring.length - 1];
    if (newest && typeof newest.seq === 'number') lastEditSeq = Math.max(lastEditSeq, newest.seq);
    if (!target) return;

    // If the operator pinned a different file, resume auto-follow once Claude
    // edits a file again (pin yields to live activity, per spec: "pins until
    // auto-follow resumes").
    pinned = false; pinnedPath = null;
    // A genuinely-new live edit re-engages follow: snap back to the live edit
    // even if the user had scrolled away (clears the manual-override pause).
    followPaused = false; hideFollowChip();

    const path = target.file_path;
    const line = (typeof target.line === 'number' && target.line > 0) ? target.line : 0; // hint only
    // a new edit to a file we've shown means its cached content is stale: re-fetch
    // (cache-bust). For a file we've never opened, the first fetch is fine.
    const force = fileCache.has(path);
    openFile(path, line, { flash: true, force, hunkNew: target.hunk_new, follow: true });
  }

  /* ==================================================================== render loop */
  // One subscriber. Each surface decides for itself what (if anything) changed;
  // none does a full rebuild per tick (Principle VII).
  function render() {
    if (destroyed) return;
    const newLead = leadSessionId();
    if (newLead !== leadId) {
      leadId = newLead;            // handoff: keep showing the same thread, new lead
      syncScreenWatch();
    }
    renderTree();
    handleAutoSwitch();
    renderTerminal();
    renderStatus();
    renderScreen();
  }

  /* ==================================================================== wire up */
  rawBtn.addEventListener('click', () => toggleRaw());

  // initial paint + single subscription (rAF-batched by the store)
  render();
  const unsub = store.subscribe(render);

  /* ==================================================================== public */
  function setThread(id) {
    if (id === threadId) return;
    // tear down screen watch for the old thread's lead
    if (rawOn) toggleRaw(false);
    threadId = id;
    // reset per-thread view state
    leadId = null;
    lastEditSeq = 0;
    treeSig = '';
    pinned = false; pinnedPath = null;
    followPaused = false; lastFollowLine = 0; hideFollowChip();
    activeTab = null;
    tabs = [];
    tabEls.clear();
    tabbar.innerHTML = '';
    fileCache.clear();
    fileInflight.clear();
    fileGen.clear();
    touchedAt.clear();
    collapsedDirs.clear();
    termBlocks.clear();
    termFeed.innerHTML = '';
    termSession = null;
    if (!termEmpty.parentNode) termBody.insertBefore(termEmpty, termFeed);
    clearEditor();
    render();
  }

  function destroy() {
    destroyed = true;
    try { unsub(); } catch (_) {}
    if (layoutRO) { try { layoutRO.disconnect(); } catch (_) {} layoutRO = null; }
    if (followRAF) { try { cancelAnimationFrame(followRAF); } catch (_) {} followRAF = 0; }
    cancelFallbackReveal();          // stop any in-flight typewriter reveal (FEATURE B)
    if (rawOn) {
      const client = getClient();
      if (client && typeof client.unwatchScreen === 'function' && watchedScreenSession) {
        try { client.unwatchScreen(watchedScreenSession); } catch (_) {}
      }
    }
    if (cm && cm.view) { try { cm.view.destroy(); } catch (_) {} }
    cm = null;
    tabEls.clear();
    fileRowEls.clear();
    dirRowEls.clear();
    termBlocks.clear();
    fileCache.clear();
    fileInflight.clear();
    fileGen.clear();
    mountEl.innerHTML = '';
  }

  return { destroy, setThread };
}

/* ---------------------------------------------------------------- utilities */
// longest common DIRECTORY prefix of a set of absolute paths (no trailing slash)
function commonPrefix(paths) {
  if (!paths.length) return '';
  if (paths.length === 1) return dirName(paths[0]);
  let prefix = paths[0];
  for (let i = 1; i < paths.length; i++) {
    while (prefix && paths[i].indexOf(prefix) !== 0) {
      prefix = prefix.slice(0, prefix.lastIndexOf('/'));
    }
    if (!prefix) break;
  }
  // ensure it's a directory boundary
  if (prefix && !prefix.endsWith('/')) {
    const i = prefix.lastIndexOf('/');
    // if the prefix lands mid-filename, back up to the dir
    if (!paths.every((p) => p.charAt(prefix.length) === '/' || p === prefix)) {
      prefix = i >= 0 ? prefix.slice(0, i) : '';
    }
  }
  return prefix.replace(/\/$/, '');
}

export default mountIdePane;
