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
 * STACK: vanilla JS ES module, no runtime build. CodeMirror 6 is dynamically
 * imported from our OWN /static (a one-time esbuild vendoring — Spec 004), with a
 * graceful highlighted-<pre> fallback so the editor is never blank if the bundle
 * fails to load. The editor is read-only.
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

/* ===================================================== CodeMirror (vendored)
 * CodeMirror 6 is loaded from our OWN /static — a one-time esbuild VENDORING of
 * the npm packages into web/vendor/codemirror.bundle.js (Spec 004). This box
 * can't reach esm.sh, so the old CDN path was untestable here + always fell back;
 * the vendored bundle loads from disk so CM runs ON-BOX. The single dynamic
 * import is cached by the browser, so the per-language factories below reuse it
 * for free. If the bundle import rejects (defence in depth) we fall back to a
 * highlighted <pre>; the pane is never blank. NOT a runtime build (Principle VII):
 * the browser loads a committed static file. Rebuild: `cd build/codemirror &&
 * npm ci && npm run build`. */
// Self-locating (relative to THIS module's URL) so it resolves under any mount
// prefix — /static/vendor/… standalone, /wyc/static/vendor/… embedded in clanker.
const CM_BUNDLE = new URL('./vendor/codemirror.bundle.js', import.meta.url).href;

// Language extensions, lazily chosen per file-extension. Each reuses the single
// cached bundle import; the factory args match the prior esm.sh behavior exactly.
const CM_LANGS = {
  javascript: () => import(CM_BUNDLE).then((m) => m.javascript({ jsx: true, typescript: false })),
  typescript: () => import(CM_BUNDLE).then((m) => m.javascript({ jsx: true, typescript: true })),
  python:     () => import(CM_BUNDLE).then((m) => m.python()),
  css:        () => import(CM_BUNDLE).then((m) => m.css()),
  html:       () => import(CM_BUNDLE).then((m) => m.html()),
  json:       () => import(CM_BUNDLE).then((m) => m.json()),
  markdown:   () => import(CM_BUNDLE).then((m) => m.markdown()),
  rust:       () => import(CM_BUNDLE).then((m) => m.rust()),
  yaml:       () => import(CM_BUNDLE).then((m) => m.yaml()),
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
 * The <pre> fallback (used if the vendored CodeMirror bundle fails to load) is highlighted
 * with the VENDORED highlight.js — it loads from our own /static so it ALWAYS
 * works offline. We inject the UMD bundle + theme once, lazily, on first
 * fallback render, and cache a ready Promise. Degrades to plain text on failure.
 * Per-line highlighting (each .efline independently) keeps the follow-scroll /
 * flash structure intact; multi-line constructs lose cross-line context, which
 * is an accepted trade for keeping offsetTop-per-line meaningful. */
const HLJS_SCRIPT_ID = 'wyc-hljs-script';
const HLJS_THEME_ID = 'wyc-hljs-theme';
const HLJS_SCRIPT_URL = new URL('./vendor/highlight.min.js', import.meta.url).href;
const HLJS_THEME_URL = new URL('./vendor/hljs-theme.css', import.meta.url).href;

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
import { termHForDrag, clampTermH } from './idegeom.js';
import { revealFrames } from './reveal.js';
import { readScanSteps, readRange } from './readscan.js';
import { termCommandStep, termOutputTake } from './termpolicy.js';
import { revealByLine } from './revealpolicy.js';
import { cmRevealPlan } from './cmreveal.js';
import { apiUrl } from './app-config.js';
import { buildClankerHighlight, clankerThemeSpec } from './cmtheme.js';

const MAX_TABS = 8;

/* ============================================================ CADENCE (FEATURE B)
 * The reveal is a SIMULATED typist: each edit lands as a COMPLETE block (the
 * transcript has no sub-hunk keystroke stream), so we already hold the final text
 * and just unveil it at a human, NON-uniform pace. Two ideas drive the feel:
 *
 *  (a) ORGANIC CADENCE — reveal by word/small-token on a comfortable base delay
 *      with slight per-step JITTER (humans aren't metronomes), a gentle ease
 *      in/out across the block, and MICRO-PAUSES at line breaks + after
 *      punctuation. So it reads like someone typing, not a burst.
 *
 *  (b) RHYTHM-ADAPTIVE DURATION — the REAL rhythm is the gap BETWEEN blocks (the
 *      model thinking between tool calls), often several seconds. We estimate the
 *      recent median inter-edit gap and spend a comfortable FRACTION of it typing,
 *      clamped to [MIN_MS, MAX_MS]. Sparse edits ⇒ leisurely; dense edits ⇒
 *      quicker. We NEVER lag reality: a new edit mid-reveal smoothly speeds the
 *      current block to the finish (cancel-and-continue), then starts the new one.
 *
 * These are deliberately gathered here so the feel is easy to tweak later. All
 * durations are milliseconds. The same tunables pace the TERMINAL reveal too. */
const CADENCE = {
  // ---- per-step base + jitter (the "keystroke" rhythm) ----------------------
  BASE_MS: 34,            // comfortable base delay per reveal step (word/token)
  JITTER: 0.45,           // ±fraction of the step delay applied randomly per step
  STEP_FLOOR_MS: 9,       // never tick faster than this (even when catching up)
  STEP_CEIL_MS: 120,      // never tick slower than this per ordinary step
  // ---- micro-pauses (humans hesitate at structure) --------------------------
  PAUSE_NEWLINE_MS: 130,  // extra dwell after finishing a line (carriage feel)
  PAUSE_SENTENCE_MS: 180, // extra after . ? ! (end-of-statement-ish)
  PAUSE_CLAUSE_MS: 70,    // extra after , ; :
  PAUSE_BRACKET_MS: 55,   // extra after { } ( ) [ ] (block punctuation)
  // ---- ease across the whole block (in then out) ----------------------------
  EASE_IN: 1.18,          // start slightly slower (settling into the block)
  EASE_OUT: 0.78,         // end slightly quicker (winding down to "done")
  // ---- gap-adaptive target duration -----------------------------------------
  GAP_FRACTION: 0.58,     // spend ~58% of the recent inter-edit gap typing
  GAP_SAMPLES: 5,         // look at up to this many recent edit/write timestamps
  MIN_MS: 600,            // floor for a reveal's target duration
  MAX_MS: 6000,           // ceiling for a reveal's target duration (big blocks)
  DEFAULT_MS: 1400,       // target when we can't measure a gap yet (first edits)
  // ---- granularity + terminal caps ------------------------------------------
  LINE_CHARS: 800,        // hunk over this many chars reveals per-LINE (still progressive)
  TERM_MAX_MS: 3500,      // hard cap on a single terminal block's reveal animation
  CARET_MS: 1100,         // blink period for the idle caret (CSS reads this too)
};

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
 * terminal). Persisted alongside {treeW, termH} in the same LAYOUT_KEY blob.
 *
 * ZERO-WASTE COLLAPSE: a collapsed region gives back (nearly) ALL its space —
 * the track shrinks to a slim ~10px clickable RIB (just wide/tall enough for the
 * expand ▸ chevron), NOT a fat 26px empty band, and the adjacent resize gutter
 * track FOLDS to 0 (no leftover 6px gap). The rib carries the relocated chevron
 * so the expand affordance stays obvious + clickable. */
const TREE_COLLAPSED_PX = 10;     // collapsed tree column = a slim clickable rib (chevron)
const TERM_COLLAPSED_PX = 10;     // collapsed terminal row = a slim clickable rib (chevron)
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

/* Median gap (ms) between consecutive ascending timestamps. `tsList` is epoch
 * SECONDS (the wire's Activity.ts unit) oldest->newest; we diff neighbours and
 * take the median (robust to one anomalous long think). Returns 0 when there
 * aren't at least two timestamps to span a gap. Pure — unit-testable. */
function medianGapMs(tsList) {
  if (!Array.isArray(tsList) || tsList.length < 2) return 0;
  const gaps = [];
  for (let i = 1; i < tsList.length; i++) {
    const d = (tsList[i] - tsList[i - 1]) * 1000;   // seconds -> ms
    if (isFinite(d) && d > 0) gaps.push(d);
  }
  if (!gaps.length) return 0;
  gaps.sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  return gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
}

/* The extra micro-pause (ms) a human would take AFTER typing `chunk` — a longer
 * dwell at end-of-statement punctuation, a medium one at clause punctuation, a
 * short one after block brackets. `atLineEnd` adds the carriage-return dwell.
 * Looks only at the last non-space char of the chunk (whitespace travels with the
 * preceding word in our word-split). Pure. */
function microPauseAfter(chunk, atLineEnd, C) {
  let extra = atLineEnd ? C.PAUSE_NEWLINE_MS : 0;
  if (chunk) {
    // last meaningful (non-space) char of the chunk
    let j = chunk.length - 1;
    while (j >= 0 && (chunk[j] === ' ' || chunk[j] === '\t')) j--;
    const ch = j >= 0 ? chunk[j] : '';
    if (ch === '.' || ch === '!' || ch === '?') extra += C.PAUSE_SENTENCE_MS;
    else if (ch === ',' || ch === ';' || ch === ':') extra += C.PAUSE_CLAUSE_MS;
    else if (ch === '{' || ch === '}' || ch === '(' || ch === ')' || ch === '[' || ch === ']') extra += C.PAUSE_BRACKET_MS;
  }
  return extra;
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

  // ZERO-WASTE COLLAPSE rib factory. When a region collapses its track shrinks to a
  // slim ~10px clickable RIB; the region's full header (with padding/label) won't
  // fit there, so we relocate the EXPAND affordance onto this rib. The rib is hidden
  // by CSS while the region is expanded and shown (overlaying the slim track) while
  // collapsed; clicking it expands the region. `axis` 'x' = a vertical rib (tree
  // column), 'y' = a horizontal rib (terminal row). Carries a ▸ chevron glyph.
  const ribEls = {};
  function makeRib(region, label, axis) {
    const r = el('button', `ide-rib ide-rib-${axis}`);
    r.type = 'button';
    r.dataset.region = region;
    r.setAttribute('aria-label', `expand ${label}`);
    r.title = `expand ${label}`;
    r.append(el('span', 'ide-rib-chevron', '▸'));
    r.addEventListener('click', (ev) => { ev.stopPropagation(); toggleCollapse(region, false); });
    ribEls[region] = r;
    return r;
  }

  /* -------------------------------------------------- DOM skeleton (built once) */
  mountEl.innerHTML = '';
  const root = el('div', 'ide');

  // --- left: file tree
  const treePane = el('div', 'ide-pane ide-tree');
  const treeHdr = el('div', 'ide-hdr');
  // collapse chevron (FEATURE A) — collapses the tree COLUMN to a slim rib.
  const treeChevron = makeChevron('tree', 'files');
  treeHdr.append(treeChevron, el('span', 'accent', 'files'), el('span', 'count', ''));
  const treeBody = el('div', 'ide-body');
  const treeList = el('div', 'tree-list');
  treeBody.append(treeList);
  // ZERO-WASTE rib: the relocated expand affordance shown only when collapsed.
  const treeRib = makeRib('tree', 'files', 'x');
  treePane.append(treeHdr, treeBody, treeRib);

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
  // collapse chevron (FEATURE A) — collapses the terminal ROW to a slim rib.
  const termChevron = makeChevron('terminal', 'terminal');
  termHdr.append(termChevron, el('span', 'icon', '$'), el('span', 'accent', 'terminal'), el('span', 'count', ''));
  const termBody = el('div', 'ide-body');
  const termFeed = el('div', 'term-feed');
  const termEmpty = el('div', 'terminal-empty', 'no shell commands yet — when Claude runs Bash it shows here');
  termBody.append(termEmpty, termFeed);
  // ZERO-WASTE rib: the relocated expand affordance shown only when collapsed.
  const termRib = makeRib('terminal', 'terminal', 'y');
  termPane.append(termHdr, termBody, termRib);

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
  // the collapse flags. Collapsing a region shrinks its track to a slim rib and
  // FOLDS its adjacent resize-gutter track to 0 (zero-waste: no leftover 6px gap);
  // the freed space flows to the remaining flexible region.
  // Layout:  [tree treeW] [gutter 6px] [editor 1fr]   (columns)
  //          [editor 1fr] [gutter 6px] [terminal termH] [status auto]  (rows)
  // Status row spans all 3 columns; raw-screen overlay is absolute so it's free.
  // - tree collapsed  -> col 1 becomes a slim rib (TREE_COLLAPSED_PX) + col-gutter -> 0
  // - terminal collapsed -> row 3 becomes a slim rib (TERM_COLLAPSED_PX) + row-gutter -> 0
  // - editor collapsed -> row 1 becomes its tab+meta strip (EDITOR_COLLAPSED_PX) +
  //   row-gutter -> 0, handing the flex 1fr to the terminal. If BOTH editor + terminal
  //   collapse, the editor keeps the 1fr (you can't collapse the only flexible region away).
  function applyGridTemplate() {
    const gridH = root.clientHeight || 0;
    // ---- columns: tree | gutter | editor. The col-gutter folds to 0 when the tree
    // is a rib so the collapsed tree gives back ALL its space (rib only, no gap).
    const tw = collapsed.tree ? TREE_COLLAPSED_PX : clamp(treeW, TREE_W_MIN, TREE_W_MAX);
    const colGutter = collapsed.tree ? 0 : GUTTER_PX;
    root.style.gridTemplateColumns = `${tw}px ${colGutter}px minmax(0, 1fr)`;
    // ---- rows: editor | gutter | terminal | status
    let editorRow, termRow;
    if (collapsed.editor && !collapsed.terminal) {
      // editor collapsed -> strip; terminal takes the flexible space
      editorRow = `${EDITOR_COLLAPSED_PX}px`;
      termRow = 'minmax(0, 1fr)';
    } else if (collapsed.terminal) {
      // terminal collapsed -> slim rib; editor takes the flexible space
      // (covers terminal-only AND editor+terminal-both-collapsed: editor wins 1fr)
      editorRow = 'minmax(0, 1fr)';
      termRow = `${TERM_COLLAPSED_PX}px`;
    } else {
      // neither collapsed: editor flexes, terminal is its dragged px (60% ceiling).
      // SAME clamp as the drag (idegeom.clampTermH) so render + drag never diverge.
      editorRow = 'minmax(0, 1fr)';
      termRow = `${clampTermH(termH, gridH, TERM_H_MIN, TERM_FRAC_MAX)}px`;
    }
    // The row-gutter folds to 0 when EITHER editor or terminal is collapsed (its
    // drag is inert anyway) so the collapsed row leaves no 6px gap.
    const rowGutter = (collapsed.editor || collapsed.terminal) ? 0 : GUTTER_PX;
    root.style.gridTemplateRows = `${editorRow} ${rowGutter}px ${termRow} auto`;
  }

  // Toggle / apply collapse for one region. Reflects state to the root (CSS
  // hooks the rib + chevron glyph + folds the header), rebuilds the grid template,
  // FOLDS the now-inert resize gutter for that boundary, and persists. CM relayout
  // is nudged so it re-measures into the new editor height (no-op for the <pre>
  // fallback). The in-header chevron is the COLLAPSE control (only visible while
  // expanded); the relocated rib is the EXPAND control (only visible collapsed).
  function applyCollapsedClasses() {
    root.classList.toggle('tree-collapsed', collapsed.tree);
    root.classList.toggle('editor-collapsed', collapsed.editor);
    root.classList.toggle('terminal-collapsed', collapsed.terminal);
    // editor keeps its tab+meta strip visible (a 56px collapse, not a rib), so its
    // in-header chevron still shows and just flips glyph; tree/terminal hide their
    // header entirely when ribbed, so the rib owns the expand affordance there.
    if (chevronEls.editor)   chevronEls.editor.textContent = collapsed.editor ? '▸' : '▾';
    if (chevronEls.tree)     chevronEls.tree.textContent = '▾';      // collapse glyph (header hidden when ribbed)
    if (chevronEls.terminal) chevronEls.terminal.textContent = '▾';  // collapse glyph (header hidden when ribbed)
    // a collapsed region's resize gutter is inert AND folded (track -> 0 in
    // applyGridTemplate): tree gutter when the tree is a rib; the editor↔terminal
    // gutter when either of them is collapsed.
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

  // editor ↔ terminal (horizontal gutter, drag y). Dragging DOWN grows the editor
  // / shrinks the terminal (terminal height moves by -dy). The geometry is the
  // pure, unit-tested idegeom.termHForDrag so the direction can never regress to
  // "always goes down" (R06 / LESSONS L5). onStart captures the CLAMPED STATE
  // height — NOT a DOM measurement, which drifts by border/padding + prior
  // clamping and is what made the drag feel "unpredictable".
  let dragStartTermH = termH;
  attachDrag(gRow, {
    axis: 'y',
    onStart: () => { dragStartTermH = clampTermH(termH, root.clientHeight || 0, TERM_H_MIN, TERM_FRAC_MAX); },
    onDelta: (dx, dy) => {
      // attachDrag calls onDelta(dx, dy) = (clientX-startX, clientY-startY). This is
      // the VERTICAL gutter, so the resize delta is dy (the SECOND arg). Binding the
      // first arg as "dy" (the original bug, preserved through R06) fed HORIZONTAL
      // jitter into the height → the terminal never resized / moved unpredictably.
      // A pure-math test can't see this; ci/interaction.mjs (real drag) gates it.
      if (collapsed.editor || collapsed.terminal) return; // gutter inert when collapsed
      termH = termHForDrag({ startH: dragStartTermH, dy, gridH: root.clientHeight || 0, min: TERM_H_MIN, fracMax: TERM_FRAC_MAX });
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
  /** @type {{view:any, EditorState:any, EditorView:any, Compartment:any, langCompartment:any, baseExts:any[]}|null} */
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
  // Spec 004 increment 3: handle for the in-flight CM hunk-reveal timer (the CM
  // analogue of fallbackRevealTimer — CM TYPES the hunk in via transactions
  // instead of snapping the whole doc). Cancelled when a newer render supersedes.
  let cmRevealTimer = 0;
  // FEATURE B (caret): a single reusable blinking-caret span. While a reveal is
  // running it sits inline at the active typing position; when the reveal finishes
  // it stays (blinking) at the last-typed spot so an idle gap looks like a paused
  // typist, not a frozen UI. Hidden when follow is paused / the user scrolls away.
  // Created lazily on first use; re-parented as the active line changes.
  /** @type {HTMLElement|null} */
  let revealCaret = null;
  let caretLine = -1;        // 0-based fallback line the caret currently sits on
  // Adaptive target duration (ms) computed at the START of each reveal from the
  // recent inter-edit gap; the per-step pacing eases around base = target/steps.
  let revealTargetMs = CADENCE.DEFAULT_MS;
  // FIX 1 — stable surrounding render: what the fallback currently has MOUNTED, so a
  // follow-edit on the SAME file can update ONLY the changed line range in place
  // (no whole-file rebuild that flashes the entire screen). `fallbackPath` is the
  // path the live .efline nodes belong to; `fallbackLines` is that doc's line array
  // (kept in lockstep with the DOM); `fallbackCodeEls` is the per-line .ef-code
  // span array. Cleared on file switch / teardown / a full re-render.
  let fallbackPath = null;
  /** @type {string[]} */
  let fallbackLines = [];
  /** @type {HTMLElement[]} */
  let fallbackCodeEls = [];

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

  // terminal: reconcile blocks by ref_seq. Each block reveals NATURALLY (FEATURE B
  // #4): the COMMAND types out, then OUTPUT streams in — driven by one shared timer
  // chain (termRevealTimer), not a dump. Per-block reveal state:
  //   targetCmd  : full command string to type (or null until known)
  //   cmdShown   : chars of the command revealed so far
  //   srcChunks  : count of store chunks already pulled into pendingOut
  //   pendingOut : output text received but not yet streamed onto the screen
  //   exitReady  : the exit pill update, deferred until output finishes streaming
  /** @type {Map<number, {block:HTMLElement, cmdEl:HTMLElement, outEl:HTMLElement, exitEl:HTMLElement, srcChunks:number, targetCmd:(string|null), cmdShown:number, pendingOut:string, exitReady:(null|{code:(number|null)}), done:boolean}>} */
  const termBlocks = new Map();
  let termSession = null;             // which session's terminal we're showing
  // one shared timer + bookkeeping for the natural terminal reveal.
  let termRevealTimer = 0;
  let termCatchUp = 1;                // >1 => compress remaining terminal delays (smooth speed-up)
  let termStartedAt = 0;             // wall-clock when the current drain began (TERM_MAX_MS cap)

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
      // ONE dynamic import of the vendored bundle (browser-cached; the CM_LANGS
      // factories reuse it). It re-exports exactly the symbols we destructure here.
      const mod = await import(CM_BUNDLE);
      if (destroyed) { cmLoading = false; return null; }
      const { EditorState, Compartment } = mod;
      const { EditorView, lineNumbers, highlightActiveLine, drawSelection } = mod;
      const { syntaxHighlighting, HighlightStyle, tags, foldGutter, bracketMatching } = mod;
      const langCompartment = new Compartment();

      // CLANKER-ALIGNED theme (shared cmtheme.js → the exact tag list is gated by
      // ci/cm_smoke.mjs against the real bundle): a Gruvbox-dark HighlightStyle that
      // mirrors the old <pre> fallback (warm, matches the app) + chrome from the app
      // CSS vars — not CodeMirror's cool grey one-dark.
      const clankerHighlight = buildClankerHighlight(HighlightStyle, tags);

      const baseExts = [
        lineNumbers(),
        foldGutter ? foldGutter() : [],
        drawSelection ? drawSelection() : [],
        bracketMatching ? bracketMatching() : [],
        highlightActiveLine ? highlightActiveLine() : [],
        syntaxHighlighting(clankerHighlight),
        EditorView.editable.of(false),  // READ-ONLY (Principle I — observer)
        EditorState.readOnly.of(true),
        EditorView.lineWrapping,
        EditorView.theme(clankerThemeSpec, { dark: true }),  // dark:true → CM dark defaults
      ];
      const view = new EditorView({
        state: EditorState.create({ doc: '', extensions: [langCompartment.of([]), ...baseExts] }),
      });
      cm = { view, EditorState, EditorView, Compartment, langCompartment, baseExts };
      cmLoading = false;
      return cm;
    } catch (e) {
      console.warn('[ide] CodeMirror vendored bundle load failed; using <pre> fallback', e);
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
    if (fallbackEl && fallbackEl.parentNode) {
      fallbackEl.remove();
      // CM owns the surface now: drop fallback in-place reveal tracking so a later
      // fallback render (defensive; CM failure is normally sticky) starts clean.
      cancelFallbackReveal();
      fallbackPath = null; fallbackLines = []; fallbackCodeEls = [];
    }
    editorWrap.append(cm.view.dom);
  }

  // render content via the highlighted <pre> fallback (no CM). This path renders
  // headless, so following MUST be correct here: we scroll the fallback's own
  // scroll container to the target line, flash it, and bind a manual-scroll watch.
  //
  // FIX 1 — DON'T re-render the whole file on every follow-edit. The old code did
  // `fallbackEl.innerHTML=''` + rebuilt every .efline on each edit, so the WHOLE
  // file flashed onto the screen in one frame (then a few lines re-typed) — which
  // read as "type a bit, then the screen fills." Now: a follow-edit on the SAME
  // already-mounted file takes the IN-PLACE path (keep the surrounding document
  // stable, splice only the changed line range, reveal it progressively); only a
  // file switch / fresh open / a doc whose unchanged context actually differs does
  // a full rebuild.
  function renderFallback(path, content, focusLine, follow, hunkNew) {
    ensureFallbackEl();
    const doc = String(content == null ? '' : content);
    const lines = doc.split('\n');

    // Compute the reveal range (0-based) for a live follow-edit with a real hunk.
    let reveal = null;
    if (follow && !followPaused && focusLine && focusLine > 0 && typeof hunkNew === 'string' && hunkNew.trim()) {
      const startIdx = Math.max(0, Math.min(focusLine - 1, lines.length - 1));
      const hunkLineCount = hunkNew.replace(/\n+$/, '').split('\n').length;
      const endIdx = Math.max(startIdx, Math.min(startIdx + hunkLineCount - 1, lines.length - 1));
      reveal = { startIdx, endIdx };
    }

    // IN-PLACE fast path: same file already mounted + a live follow-edit reveal +
    // the surrounding (unchanged) context still matches what's on screen. Then we
    // update ONLY the changed lines in place — the rest of the document stays
    // present and unmoving, so it looks like writing into the file, not a re-fill.
    if (reveal && fallbackPath === path && fallbackEl.firstChild &&
        fallbackCodeEls.length && contextMatches(lines, reveal)) {
      updateFallbackHunkInPlace(path, lines, reveal, follow);
      return;
    }

    // ---- full render (file switch / fresh open / context drift) ----------------
    cancelFallbackReveal();          // stop any reveal from a prior render
    const myGen = ++fallbackHlGen;   // invalidate any in-flight highlight pass + reveal
    fallbackEl.innerHTML = '';
    // Each source line is its own .efline block (so offsetTop is meaningful for
    // the follow-scroll, and the flash is a per-line block). The line text lives
    // in a child .ef-code span so syntax highlighting (which rewrites .ef-code's
    // innerHTML) never disturbs the .ln gutter or the trailing newline.
    const frag = document.createDocumentFragment();
    /** @type {HTMLElement[]} */
    const codeEls = [];
    for (let i = 0; i < lines.length; i++) {
      frag.append(buildEfline(i, lines[i], codeEls));
    }
    fallbackEl.append(frag);
    // remember what's mounted so the next follow-edit can update in place.
    fallbackPath = path;
    fallbackLines = lines.slice();
    fallbackCodeEls = codeEls;

    // Highlight each line once hljs is ready. We tag the rendered content with a
    // gen token so a re-render (live edit re-fetch) that lands while a prior
    // highlight pass is still pending can't paint stale tokens over new text. The
    // reveal range is SKIPPED here (the reveal owns those lines + re-highlights
    // them itself as they settle), so the async pass can't clobber the animation.
    highlightFallbackLines(path, lines, codeEls, myGen, reveal);

    if (focusLine && focusLine > 0) {
      flashFallbackLine(Math.max(1, Math.min(focusLine, lines.length)));
      // auto-SCROLL the container only when following (honors the pause state)
      if (follow && !followPaused) {
        lastFollowLine = Math.max(1, Math.min(focusLine, lines.length));
        scrollFallbackToLine(lastFollowLine, false);
      }
    }

    // Kick the reveal LAST (after layout + scroll anchor are set).
    if (reveal) {
      // full path: type the changed lines from EMPTY (char-level). The in-place path
      // instead leaves the OLD content so the reveal can backspace it (deletions, R08).
      for (let li = reveal.startIdx; li <= reveal.endIdx && li < codeEls.length; li++) {
        if (codeEls[li]) codeEls[li].textContent = '';
      }
      revealHunkInFallback(path, lines, codeEls, reveal, follow, myGen);
    }
  }

  // Ensure the <pre> fallback element exists + is mounted (replacing empty / CM).
  function ensureFallbackEl() {
    if (editorEmpty.parentNode) editorEmpty.remove();
    if (cm && cm.view.dom.parentNode) cm.view.dom.remove();
    if (!fallbackEl) {
      fallbackEl = el('pre', 'editor-fallback');
      const note = el('div', 'editor-fallback-note', 'editor offline · highlighted plain view');
      editorWrap.append(note, fallbackEl);
      bindFallbackScrollWatch();
    }
  }

  // Build one .efline block (gutter + .ef-code span + trailing newline). Pushes the
  // .ef-code span onto `codeEls` (kept index-aligned with the line array).
  function buildEfline(i, text, codeEls) {
    const lineEl = el('span', 'efline');
    lineEl.append(el('span', 'ln', String(i + 1)));
    const codeEl = el('span', 'ef-code');
    codeEl.textContent = text;        // plain text first — correct + layout-safe
    lineEl.append(codeEl);
    lineEl.append(document.createTextNode('\n'));
    if (codeEls) codeEls.push(codeEl);
    return lineEl;
  }

  // Flash (transient bg + persistent gutter accent) one 1-based line of the mounted
  // fallback. Re-triggers the animation by reflow so a repeat edit re-flashes.
  function flashFallbackLine(line1) {
    if (!fallbackEl) return;
    const target = fallbackEl.children[line1 - 1];
    if (!target) return;
    target.classList.remove('wyc-hunk-flash', 'wyc-hunk-line');
    void target.offsetWidth;
    target.classList.add('wyc-hunk-flash', 'wyc-hunk-line');
    setTimeout(() => { target.classList.remove('wyc-hunk-flash'); }, 1600);
    setTimeout(() => { target.classList && target.classList.remove('wyc-hunk-line'); }, 2400);
  }

  // Does the UNCHANGED context around `reveal` still match what's mounted? We only
  // take the in-place path when the document outside the changed range is identical
  // to the live DOM (same length, same surrounding lines) — otherwise an edit that
  // shifted line counts / rewrote distant lines must do a full render to stay
  // honest. Cheap: compare lengths + the two boundary lines just outside the range.
  function contextMatches(lines, reveal) {
    if (lines.length !== fallbackLines.length) return false;
    if (fallbackCodeEls.length !== fallbackLines.length) return false;
    const before = reveal.startIdx - 1;
    const after = reveal.endIdx + 1;
    if (before >= 0 && lines[before] !== fallbackLines[before]) return false;
    if (after < lines.length && lines[after] !== fallbackLines[after]) return false;
    return true;
  }

  // FIX 1 — IN-PLACE hunk update. The surrounding document is already mounted and
  // stays put; we only touch the changed line range, then reveal it progressively.
  // No innerHTML reset, no full rebuild — so nothing "fills the screen."
  function updateFallbackHunkInPlace(path, lines, reveal, follow) {
    cancelFallbackReveal();
    const myGen = ++fallbackHlGen;   // supersede any prior reveal/highlight pass
    // Reconcile any line a PRIOR (now-superseded) reveal left mid-typed/empty but
    // that the NEW reveal won't touch: snap it to its true text so a second edit
    // arriving mid-animation never strands a blank line. This only fixes drifted
    // lines outside the new range (a localized correction, not a screen re-fill).
    for (let li = 0; li < fallbackCodeEls.length && li < lines.length; li++) {
      if (li >= reveal.startIdx && li <= reveal.endIdx) continue;     // new reveal owns these
      const want = lines[li] || '';
      const cur = fallbackCodeEls[li];
      if (cur && cur.textContent !== want && cur.textContent.length < want.length) cur.textContent = want;
    }
    // keep our shadow line array in lockstep (lengths are equal — contextMatches)
    fallbackLines = lines.slice();
    // flash the first changed line so the eye catches the edit even while paused
    flashFallbackLine(Math.max(1, Math.min(reveal.startIdx + 1, lines.length)));
    if (follow && !followPaused) {
      lastFollowLine = Math.max(1, Math.min(reveal.startIdx + 1, lines.length));
      scrollFallbackToLine(lastFollowLine, false);
    }
    // reveal the changed range in place against the persistent surrounding render
    revealHunkInFallback(path, lines, fallbackCodeEls, reveal, follow, myGen);
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

  // ---- gap-adaptive duration (FEATURE B #2) ------------------------------
  // Estimate the recent inter-edit rhythm for the FOLLOWED lead session and turn
  // it into a comfortable target reveal duration. The real cadence is the gap
  // BETWEEN edit/write blocks (the model thinking between tool calls); we spend a
  // fraction of the recent MEDIAN gap typing, clamped to [MIN_MS, MAX_MS]. When we
  // can't yet measure a gap (first edit) we use DEFAULT_MS. This keeps the typing
  // proportional to reality: sparse edits read leisurely, dense edits read quick.
  function adaptiveRevealMs() {
    const lead = leadSessionId();
    let tsList = [];
    if (lead) {
      const ring = store.activitiesForSession(lead) || [];
      // newest GAP_SAMPLES edit/write timestamps, in ascending order
      for (let i = ring.length - 1; i >= 0 && tsList.length < CADENCE.GAP_SAMPLES; i--) {
        const a = ring[i];
        if ((a.kind === 'edit' || a.kind === 'write') && typeof a.ts === 'number') tsList.push(a.ts);
      }
      tsList.reverse();
    }
    const gap = medianGapMs(tsList);
    if (!gap) return CADENCE.DEFAULT_MS;
    return clamp(Math.round(gap * CADENCE.GAP_FRACTION), CADENCE.MIN_MS, CADENCE.MAX_MS);
  }

  // ---- blinking caret (FEATURE B #3) -------------------------------------
  // One reusable caret span, parked inline after the active line's code while
  // typing and left blinking at the last position when idle. We re-parent it (not
  // recreate) so there's only ever one. Hidden when there's no followed position
  // or follow is paused / the user scrolled away.
  function ensureCaret() {
    if (!revealCaret) {
      revealCaret = el('span', 'wyc-caret');
      revealCaret.setAttribute('aria-hidden', 'true');
    }
    return revealCaret;
  }
  // Place the caret at the end of fallback line `li` (0-based). It rides INSIDE the
  // .efline (after .ef-code) so it flows with the text and inherits line geometry.
  function placeCaretAtLine(li) {
    if (followPaused) { hideCaret(); return; }
    if (!fallbackEl || li < 0 || li >= fallbackEl.children.length) { hideCaret(); return; }
    const lineEl = fallbackEl.children[li];
    const codeEl = fallbackCodeEls[li];
    if (!lineEl || !codeEl) { hideCaret(); return; }
    const c = ensureCaret();
    // insert right after the code span (before the trailing "\n" text node)
    if (codeEl.nextSibling !== c) lineEl.insertBefore(c, codeEl.nextSibling);
    c.classList.remove('idle');         // solid while actively typing
    c.style.display = '';
    caretLine = li;
  }
  // Switch the caret to its idle (gentle blink) state at the current position —
  // the "paused typist between blocks" look. No-op if follow is paused.
  function idleCaret() {
    if (followPaused || !revealCaret || !revealCaret.parentNode) { hideCaret(); return; }
    revealCaret.classList.add('idle');
    revealCaret.style.display = '';
  }
  function hideCaret() {
    if (revealCaret) { revealCaret.style.display = 'none'; revealCaret.classList.remove('idle'); }
  }
  function removeCaret() {
    if (revealCaret && revealCaret.parentNode) revealCaret.parentNode.removeChild(revealCaret);
    caretLine = -1;
  }

  // Cancel any in-flight typewriter reveal (FEATURE B). Bumping fallbackHlGen in
  // renderFallback already makes the running reveal's gen check abort on its next
  // tick; this also clears the pending timer immediately so nothing fires after a
  // teardown / file switch. The caret is detached so it never strands mid-document
  // (a continuing reveal re-places it; an idle settle parks it deliberately).
  function cancelFallbackReveal() {
    if (fallbackRevealTimer) { try { clearTimeout(fallbackRevealTimer); } catch (_) {} fallbackRevealTimer = 0; }
    removeCaret();
  }

  // FEATURE B — STREAMING REVEAL of a freshly-landed hunk (FIX 1: natural rhythm,
  // no full-screen dump). HONESTY: the transcript carries the WHOLE new hunk, not a
  // sub-hunk character stream — nothing to replay keystroke-by-keystroke. So this is
  // a SIMULATED reveal: we already have the final text; we just unveil the CHANGED
  // region progressively so it reads like code being written into the file in place.
  // The surrounding document is already mounted and does NOT move (renderFallback /
  // updateFallbackHunkInPlace keep it stable). It only paints text we genuinely
  // received, never invents content, operates on the (read-only) fallback view, and
  // settles to the exact full hljs-highlighted content.
  //
  // ORGANIC pacing — NO "type a prefix then SNAP the rest", and NOT a metronome:
  //  - small/medium hunks reveal per WORD; hunks over CADENCE.LINE_CHARS reveal
  //    per LINE (still progressive, never a dump);
  //  - the TARGET duration adapts to the recent inter-edit gap (adaptiveRevealMs);
  //  - per-step delay = base × ease(in→out) × (1 ± jitter), plus a MICRO-PAUSE at
  //    line breaks / after punctuation — so it reads like a human typing;
  //  - a blinking CARET rides the active position and is left blinking when done.
  // CANCEL-AND-CONTINUE: a newer render bumps fallbackHlGen; the gen check here
  // aborts the old reveal and the newer one takes over. If a new edit arrives while
  // this block is still typing, the caller accelerates US to the finish first
  // (accelerateRevealToFinish) — a smooth speed-up, not a snap/dump.
  function revealHunkInFallback(path, lines, codeEls, range, follow, gen) {
    const { startIdx, endIdx } = range;
    // total chars in the changed region decides word- vs line-granularity.
    let totalChars = 0;
    for (let li = startIdx; li <= endIdx && li < codeEls.length; li++) totalChars += (lines[li] || '').length;
    const byLine = revealByLine(totalChars);   // CHAR-level unless TRULY massive (revealpolicy.js)

    // Build the ordered reveal plan: {li, chunk, lineEnd} steps. Per word for normal
    // hunks (split on whitespace boundaries, whitespace kept attached so words
    // "appear"); per whole line for big hunks (one chunk == the full line) so we
    // move through volume without ever dumping everything at once.
    /** @type {{li:number, text:string, lineEnd:boolean}[]} */
    const plan = [];
    for (let li = startIdx; li <= endIdx && li < codeEls.length; li++) {
      const newText = lines[li] || '';
      // oldText = whatever is shown NOW: the IN-PLACE path left the OLD line here, so
      // we backspace it → diff-aware DELETIONS (R08); the full path cleared it to '',
      // so we type from empty. reveal.js (unit-tested) yields the char-by-char frames.
      const oldText = codeEls[li] ? codeEls[li].textContent : '';
      if (byLine) {
        plan.push({ li, text: newText, lineEnd: true });           // big hunk: settle whole line (perf)
      } else {
        const frames = revealFrames(oldText, newText);             // char-level + deletions-aware
        if (frames.length <= 1) { plan.push({ li, text: newText, lineEnd: true }); }  // identical → settle
        else for (let k = 1; k < frames.length; k++) plan.push({ li, text: frames[k], lineEnd: k === frames.length - 1 });
      }
    }
    if (!plan.length) {                              // nothing to do: snap to final text
      for (let li = startIdx; li <= endIdx && li < codeEls.length; li++) if (codeEls[li]) codeEls[li].textContent = lines[li] || '';
      fallbackRevealTimer = 0;
      removeCaret();
      return;
    }

    // Pace from the ADAPTIVE target: base = target/steps is the average cadence,
    // clamped to a sane per-step band. We modulate it with a gentle ease that
    // starts a touch slower (EASE_IN, settling into the block) and ends a touch
    // quicker (EASE_OUT, winding down to "done"), and add ±JITTER so no two steps
    // are identical (humans aren't constant). Micro-pauses (line break / punctuation)
    // are added on top in tick(). `catchUp` (>1) compresses everything smoothly when
    // a newer edit is waiting — a speed-up, never a snap.
    const steps = plan.length;
    revealTargetMs = adaptiveRevealMs();
    const base = clamp(revealTargetMs / steps, CADENCE.STEP_FLOOR_MS, CADENCE.STEP_CEIL_MS);
    let catchUp = 1;            // >1 => compress remaining delays (smooth speed-up)
    const easeAt = (idx) => {
      const t = steps > 1 ? idx / (steps - 1) : 1;   // 0..1 progress
      // ease in then out: a smooth hump that begins at EASE_IN, dips toward 1 in
      // the middle, and finishes at EASE_OUT — quicker at the tail, never abrupt.
      return CADENCE.EASE_IN + (CADENCE.EASE_OUT - CADENCE.EASE_IN) * t;
    };
    const jitter = () => 1 + (Math.random() * 2 - 1) * CADENCE.JITTER;
    const delayFor = (idx, step) => {
      let d = base * easeAt(idx) * jitter() / catchUp;
      // micro-pause AFTER this step (punctuation / line break) — also scaled by
      // catchUp so accelerate-to-finish stays smooth through pauses too.
      if (step) d += microPauseAfter(step.text ? step.text.slice(-1) : '', step.lineEnd, CADENCE) / catchUp;
      return clamp(Math.round(d), CADENCE.STEP_FLOOR_MS, CADENCE.STEP_CEIL_MS + CADENCE.PAUSE_SENTENCE_MS);
    };

    let i = 0;
    const settleLine = (li) => {
      // settle one line to its full text, then hljs-highlight it in place. We set
      // textContent to the SAME string it already holds before highlighting so the
      // box geometry is identical pre/post — highlighting swaps innerHTML for inline
      // token spans of equal text, so no reflow/flash of the settled line.
      const full = lines[li] || '';
      if (codeEls[li] && codeEls[li].textContent !== full) codeEls[li].textContent = full;
      ensureHljs().then((hljs) => {
        if (!hljs || destroyed || gen !== fallbackHlGen || !fallbackEl) return;
        const html = hljsLineHtml(hljs, full, hljsLangFor(path));
        if (html != null && codeEls[li]) codeEls[li].innerHTML = html;
      });
    };

    const tick = () => {
      // aborted by a newer render / teardown / file-switch? (cancel-and-continue:
      // the newer reveal owns the region now; we just stop. caret is removed by
      // cancelFallbackReveal in that path.)
      if (destroyed || gen !== fallbackHlGen || !fallbackEl) { fallbackRevealTimer = 0; return; }
      if (i >= plan.length) {                        // done — gently, no dump
        if (follow && !followPaused) { lastFollowLine = Math.min(endIdx + 1, lines.length); scrollFallbackToLine(lastFollowLine, false); }
        // park the caret blinking at the last typed line (the "paused typist" look)
        placeCaretAtLine(endIdx);
        idleCaret();
        fallbackRevealTimer = 0;
        return;
      }
      const step = plan[i];
      const { li, text } = step;
      if (codeEls[li]) codeEls[li].textContent = text;   // full frame per step (ghost-free: textContent replace, never node mutation)
      // caret rides the active line (solid while typing)
      placeCaretAtLine(li);
      // when this step completes a line, settle + highlight it so revealed code
      // colorizes as it lands (re-place the caret after, since innerHTML rewrite
      // drops the inserted caret node).
      if (step.lineEnd) { settleLine(li); placeCaretAtLine(li); }
      // follow the revealing line (1-based), honoring the pause state
      if (follow && !followPaused) {
        lastFollowLine = li + 1;
        scrollFallbackToLine(li + 1, false);
      }
      i++;
      fallbackRevealTimer = setTimeout(tick, delayFor(i, plan[i]));
    };

    // Accelerate THIS reveal to its finish smoothly (used when a new edit arrives
    // mid-reveal so we never lag reality). We RAMP the compression instead of
    // snapping: each call increases catchUp, so the remaining steps tighten toward
    // the floor over a few frames rather than dumping in one. Exposed via closure.
    revealHunkInFallback._accelerate = () => { catchUp = Math.min(catchUp * 3.5, 40); };

    cancelFallbackReveal();
    fallbackRevealTimer = setTimeout(tick, delayFor(0, plan[0]));
  }
  // Smoothly speed the in-flight reveal (if any) toward completion — a ramp, not a
  // snap. Called when a newer edit lands while a reveal is mid-flight so the catch-
  // up reads as a quick finish, then the new block starts. Safe if nothing running.
  function accelerateRevealToFinish() {
    if (fallbackRevealTimer && typeof revealHunkInFallback._accelerate === 'function') {
      try { revealHunkInFallback._accelerate(); } catch (_) {}
    }
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
  async function showFileInEditor(path, content, focusLine, hunkNew, follow, scanRead) {
    const myToken = ++fetchToken;
    cancelReadScan();                         // a new render supersedes any read-sweep
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
      if (scanRead) sweepReadFallback(doc, scanRead);
      return;
    }
    attachCmDom();
    bindCmScrollWatch();
    const langExt = await langExtFor(path);
    if (destroyed || myToken !== fetchToken) return;

    const { view, EditorState, langCompartment, baseExts } = cm;
    cancelCmReveal();   // a newer render supersedes any in-flight reveal

    // Spec 004 increment 3: a live FOLLOW-edit with a real hunk TYPES the hunk into
    // CM char-by-char (reveal) instead of snapping the whole doc in. A file switch /
    // paused-follow / no-hunk render snaps (cheap + correct). Same hunk-range math
    // as the fallback path (renderFallback), so both surfaces agree on the region.
    const wantReveal = follow && !followPaused && targetLine > 0 &&
                       typeof hunkNew === 'string' && hunkNew.trim();
    if (wantReveal) {
      const docLines = doc.split('\n');
      const startIdx = Math.max(0, Math.min(targetLine - 1, docLines.length - 1));
      const hunkLineCount = hunkNew.replace(/\n+$/, '').split('\n').length;
      const endIdx = Math.max(startIdx, Math.min(startIdx + hunkLineCount - 1, docLines.length - 1));
      const plan = cmRevealPlan(doc, startIdx + 1, endIdx + 1);   // pure + unit-tested
      if (plan.steps.length) {
        revealHunkInCm(plan, langExt, path, hunkNew, follow, targetLine, myToken);
        return;
      }
    }

    // SNAP: full reset of doc + language (file switch / re-edit / non-follow).
    view.setState(EditorState.create({ doc, extensions: [langCompartment.of(langExt), ...baseExts] }));
    if (targetLine && targetLine > 0) {
      flashAndScrollCm(targetLine, hunkNew, follow);
    }
  }

  // Cancel any in-flight CM hunk-reveal (Spec 004 increment 3). The token check in
  // tick() also aborts it on the next step; this clears the pending timer at once so
  // nothing dispatches into a superseded/destroyed view.
  function cancelCmReveal() {
    if (cmRevealTimer) { try { clearTimeout(cmRevealTimer); } catch (_) {} cmRevealTimer = 0; }
  }

  // TYPE a freshly-landed hunk INTO CodeMirror char-by-char (Spec 004 increment 3),
  // the CM analogue of revealHunkInFallback. The PLAN (which chars, in what order,
  // and the doc-with-region-emptied to start from) is the pure, unit-tested
  // cmRevealPlan; here we only DRIVE it: mount initialDoc, then dispatch each step
  // as a CM transaction on a paced timer (same CADENCE as the fallback). CM accepts
  // programmatic dispatch even though the view is editable:false (Principle I —
  // still observer-only; the user can't type). A newer render cancels via the token.
  function revealHunkInCm(plan, langExt, path, hunkNew, follow, targetLine, myToken) {
    if (!cm) return;
    const { view, EditorState, EditorView, langCompartment, baseExts } = cm;
    // mount the surrounding document with the hunk region EMPTY (+ language), then
    // grow the region back to full text step-by-step so CM types instead of snaps.
    view.setState(EditorState.create({
      doc: plan.initialDoc, extensions: [langCompartment.of(langExt), ...baseExts],
    }));

    const steps = plan.steps;
    const nSteps = steps.length;
    revealTargetMs = adaptiveRevealMs();
    const base = clamp(revealTargetMs / Math.max(1, nSteps), CADENCE.STEP_FLOOR_MS, CADENCE.STEP_CEIL_MS);
    const easeAt = (idx) => {
      const t = nSteps > 1 ? idx / (nSteps - 1) : 1;
      return CADENCE.EASE_IN + (CADENCE.EASE_OUT - CADENCE.EASE_IN) * t;
    };
    const jitter = () => 1 + (Math.random() * 2 - 1) * CADENCE.JITTER;
    const delayFor = (idx, step) => {
      let d = base * easeAt(idx) * jitter();
      if (step) d += microPauseAfter(step.slice(-1), step.endsWith('\n'), CADENCE);
      return clamp(Math.round(d), CADENCE.STEP_FLOOR_MS, CADENCE.STEP_CEIL_MS + CADENCE.PAUSE_SENTENCE_MS);
    };

    let i = 0, prev = 0, lastLine = -1;
    const tick = () => {
      // aborted by a newer render / teardown / file-switch?
      if (destroyed || myToken !== fetchToken || !cm) { cmRevealTimer = 0; return; }
      if (i >= nSteps) {                    // done — settle: flash + scroll the hunk
        cmRevealTimer = 0;
        if (targetLine > 0) flashAndScrollCm(targetLine, hunkNew, follow);
        return;
      }
      const step = steps[i];
      // replace the growing region [from, from+prev] with the next frame
      try { view.dispatch({ changes: { from: plan.from, to: plan.from + prev, insert: step } }); } catch (_) {}
      prev = step.length;
      // FOLLOW the typing — but only re-scroll when the active LINE changes (not per
      // char) so we don't thrash the scroller on a long hunk.
      if (follow && !followPaused) {
        try {
          const endPos = Math.min(plan.from + prev, view.state.doc.length);
          const ln = view.state.doc.lineAt(endPos).number;
          if (ln !== lastLine) {
            lastLine = ln; lastFollowLine = ln;
            suppressScrollWatch = true;
            view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.line(ln).from, { y: 'center' }) });
            setTimeout(() => { suppressScrollWatch = false; }, 60);
          }
        } catch (_) {}
      }
      i++;
      cmRevealTimer = setTimeout(tick, delayFor(i, steps[i]));
    };
    cancelCmReveal();
    cmRevealTimer = setTimeout(tick, delayFor(0, steps[0]));
  }

  // ---- read-scan sweep (fallback only) --------------------------------------
  let readScanTimer = 0;
  function cancelReadScan() {
    if (readScanTimer) { try { clearTimeout(readScanTimer); } catch (_) {} readScanTimer = 0; }
    if (fallbackEl) for (const n of fallbackEl.querySelectorAll('.efline.ef-reading')) n.classList.remove('ef-reading');
  }
  // Sweep a transient "reading" highlight DOWN the read range (readscan.js schedule),
  // scroll-following, then clear. Distinct from the edit reveal: no typing, no caret —
  // it shows Claude reading. Fallback-only (CM isn't loadable on every box).
  function sweepReadFallback(doc, act) {
    cancelReadScan();
    if (!fallbackEl || !fallbackCodeEls.length) return;
    const total = (fallbackLines && fallbackLines.length) || String(doc).split('\n').length;
    const { start, end } = readRange(act, total, { window: 40 });
    const steps = readScanSteps(start, end, { maxSteps: 80 });
    const stepMs = clamp(Math.round(adaptiveRevealMs() / Math.max(1, steps.length)), 16, 90);
    let i = 0;
    const tick = () => {
      if (destroyed || !fallbackEl) { readScanTimer = 0; return; }
      for (const n of fallbackEl.querySelectorAll('.efline.ef-reading')) n.classList.remove('ef-reading');
      const code = fallbackCodeEls[steps[i] - 1];
      const lineEl = code && code.parentNode;
      if (lineEl) {
        lineEl.classList.add('ef-reading');
        if (!followPaused) scrollFallbackToLine(steps[i], false);
      }
      i++;
      if (i < steps.length) readScanTimer = setTimeout(tick, stepMs);
      else readScanTimer = setTimeout(cancelReadScan, 500);   // linger, then clear
    };
    readScanTimer = setTimeout(tick, 0);
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
    hideCaret();                 // a paused/scrolled-away view shouldn't show the caret
  }
  // Resume following. If `jump` and we know the last edit line, scroll back to it.
  function resumeFollow(jump) {
    followPaused = false;
    hideFollowChip();
    // bring the blinking caret back to its last position if the reveal has settled
    // and we're on the fallback view (CM has its own native cursor handling).
    if (!fallbackRevealTimer && fallbackEl && fallbackEl.parentNode && caretLine >= 0) {
      placeCaretAtLine(caretLine); idleCaret();
    }
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
    // apiUrl() prefixes the mount BASE so /file resolves under clanker (/wyc/file).
    return `${apiUrl('file')}?path=${encodeURIComponent(path)}${t ? `&token=${encodeURIComponent(t)}` : ''}${b}`;
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
    const scanRead = opts2.scanRead || null;
    fetchFile(path, force).then((rec) => {
      if (destroyed || activeTab !== path) return; // user/auto moved on
      updateEditorMeta(path, rec);
      showFileInEditor(path, rec.content, focusLine, hunkNew, follow, scanRead);
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
    // drop the in-place reveal tracking (no mounted fallback to update any more)
    fallbackPath = null; fallbackLines = []; fallbackCodeEls = [];
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

  /* ==================================================================== terminal
   * NATURAL REVEAL (FEATURE B #4). The store hands us complete command strings +
   * (possibly chunked) output. We don't dump them: this reconcile QUEUES new
   * content onto each block, and a single shared timer chain (termTick) types the
   * command out then streams the output line/chunk-by-chunk at the same gentle,
   * gap-adaptive cadence — scroll-following the output, capped at TERM_MAX_MS per
   * block, with cancel-and-continue when a newer command lands. The exit pill +
   * styling are preserved (the pill update is deferred until output finishes). */
  function renderTerminal() {
    const lead = leadSessionId();
    if (lead !== termSession) {
      // lead changed (handoff or re-target): reset the terminal feed + reveal
      termSession = lead;
      cancelTermReveal();
      termBlocks.clear();
      termFeed.innerHTML = '';
      if (!termEmpty.parentNode) termBody.insertBefore(termEmpty, termFeed);
    }
    if (!lead) return;
    const bufs = store.terminalForSession(lead) || [];
    if (bufs.length && termEmpty.parentNode) termEmpty.remove();

    let queuedSomething = false;
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
        b = { block, cmdEl, outEl, exitEl, srcChunks: 0, targetCmd: null, cmdShown: 0, pendingOut: '', exitReady: null, done: false };
        termBlocks.set(buf.ref_seq, b);
        // SHOW ONLY THE LATEST command+output (operator): a real terminal shows the
        // current command + its output, not a long scrollback. Evict prior blocks so
        // the last command persists until a NEW one lands.
        for (const [seq, old] of termBlocks) {
          if (seq === buf.ref_seq) continue;
          if (old.block && old.block.parentNode) old.block.remove();
          termBlocks.delete(seq);
        }
        // a brand-new command block: smoothly finish any block still revealing
        // (cancel-and-continue) so we never lag the live shell.
        accelerateTermRevealToFinish();
      }
      // queue the command text (typed out by the ticker, not shown instantly)
      const cmdText = buf.command != null ? buf.command : '(command pending)';
      if (b.targetCmd !== cmdText) {
        // if the command string changed before we finished typing the old one, keep
        // what's shown only if it's still a prefix; otherwise restart cleanly.
        if (b.targetCmd != null && cmdText.indexOf(b.cmdEl.textContent) !== 0) { b.cmdShown = 0; b.cmdEl.textContent = ''; }
        b.targetCmd = cmdText;
        queuedSomething = true;
      }
      // queue newly-arrived output chunks (streamed out by the ticker)
      if (buf.chunks.length > b.srcChunks) {
        let added = '';
        for (let i = b.srcChunks; i < buf.chunks.length; i++) added += buf.chunks[i];
        b.pendingOut += stripAnsi(added);
        b.srcChunks = buf.chunks.length;
        queuedSomething = true;
      }
      // defer the exit pill until this block's output has finished streaming, so the
      // "exit N" pill doesn't pop before its output is on screen.
      if (buf.done && b.exitReady == null && !b.done) {
        b.exitReady = { code: buf.exit_code };
        queuedSomething = true;
      }
    }
    termHdr.lastChild.textContent = `${termBlocks.size} cmd${termBlocks.size === 1 ? '' : 's'}`;
    // kick the shared reveal chain if there's anything to drain and it's idle.
    if (queuedSomething) ensureTermReveal();
  }

  // True if any block still has command chars to type, output to stream, or a
  // deferred exit pill to apply — i.e. the reveal chain has work left.
  function termHasPending() {
    for (const b of termBlocks.values()) {
      if (b.targetCmd != null && b.cmdShown < b.targetCmd.length) return true;
      if (b.pendingOut.length) return true;
      if (b.exitReady != null && !b.done) return true;
    }
    return false;
  }

  // Start the shared terminal reveal chain if it isn't already running.
  function ensureTermReveal() {
    if (termRevealTimer || destroyed) return;
    termCatchUp = 1;
    termStartedAt = Date.now();
    termRevealTimer = setTimeout(termTick, 0);
  }
  function cancelTermReveal() {
    if (termRevealTimer) { try { clearTimeout(termRevealTimer); } catch (_) {} termRevealTimer = 0; }
    termCatchUp = 1; termStartedAt = 0;
  }
  // Smoothly speed the in-flight terminal reveal toward completion (ramp, not snap),
  // used when a newer command lands so the catch-up reads as a quick finish.
  function accelerateTermRevealToFinish() {
    if (termRevealTimer) termCatchUp = Math.min(termCatchUp * 3.5, 60);
  }

  // One step of the shared terminal reveal. Drains blocks in ref_seq order (causal):
  // for the oldest block with pending content we either type the next slice of its
  // command or stream the next slice of its output; once a block is fully revealed
  // we apply its deferred exit pill and move on. A wall-clock cap (TERM_MAX_MS,
  // relaxed by catchUp) keeps a giant output from animating forever — past the cap
  // we flush the remainder in larger slices so it settles quickly but still streams.
  function termTick() {
    if (destroyed) { termRevealTimer = 0; return; }
    // find the oldest (smallest ref_seq) block with work left.
    let key = null, b = null;
    let minSeq = Infinity;
    for (const [seq, blk] of termBlocks) {
      const hasWork = (blk.targetCmd != null && blk.cmdShown < blk.targetCmd.length)
        || blk.pendingOut.length || (blk.exitReady != null && !blk.done);
      if (hasWork && seq < minSeq) { minSeq = seq; key = seq; b = blk; }
    }
    if (!b) { termRevealTimer = 0; termCatchUp = 1; termStartedAt = 0; return; }

    const stick = isNearBottom(termBody);
    // over the time cap? flush in big slices (settle fast, still progressive).
    const overCap = termStartedAt && (Date.now() - termStartedAt) > CADENCE.TERM_MAX_MS;
    const speed = overCap ? 24 : termCatchUp;

    // base per-step delay for the terminal: derive a comfortable cadence adapted to
    // the recent inter-edit gap (shorter when edits are dense), then compress by
    // `speed`. Terminal types/streams a touch quicker than the editor (smaller base).
    const targetMs = Math.max(CADENCE.MIN_MS, Math.round(adaptiveRevealMs() * 0.7));
    let delay;

    // 1) type the command out first (char-grouped: a few chars per step so longer
    //    commands don't crawl), then 2) stream output.
    if (b.targetCmd != null && b.cmdShown < b.targetCmd.length) {
      const remaining = b.targetCmd.length - b.cmdShown;
      // the COMMAND is typed (termpolicy.termCommandStep — grouped, like a person typing).
      const grp = overCap ? remaining : termCommandStep(remaining, { speed: Math.round(speed) });
      b.cmdShown = Math.min(b.targetCmd.length, b.cmdShown + grp);
      b.cmdEl.textContent = b.targetCmd.slice(0, b.cmdShown);
      const perChar = clamp(targetMs / Math.max(28, b.targetCmd.length), CADENCE.STEP_FLOOR_MS, 60);
      delay = clamp(Math.round(perChar * grp / Math.max(1, speed)), CADENCE.STEP_FLOOR_MS, CADENCE.STEP_CEIL_MS);
    } else if (b.pendingOut.length) {
      // OUTPUT IS INSTANT (termpolicy.termOutputTake): a real terminal DUMPS output —
      // the program prints it all at once, it is NOT typed character/line by line
      // (operator: "the results are instant from the terminal"). Take the whole pending
      // output in one step; only the COMMAND above is "typed".
      const take = termOutputTake(b.pendingOut.length);
      const slice = b.pendingOut.slice(0, take);
      b.pendingOut = b.pendingOut.slice(take);
      b.outEl.append(document.createTextNode(slice));
      delay = CADENCE.STEP_FLOOR_MS;   // settle immediately; the chain moves to the next block
    } else if (b.exitReady != null && !b.done) {
      // output fully streamed: NOW apply the deferred exit pill (preserved styling).
      b.done = true;
      const code = b.exitReady.code;
      if (code === 0 || code == null) { b.exitEl.className = 'exit ok'; b.exitEl.textContent = code === 0 ? 'exit 0' : 'done'; }
      else { b.exitEl.className = 'exit bad'; b.exitEl.textContent = 'exit ' + code; }
      delay = CADENCE.STEP_FLOOR_MS;
    } else {
      delay = CADENCE.STEP_FLOOR_MS;
    }

    if (stick) termBody.scrollTop = termBody.scrollHeight;   // scroll-follow the output
    // continue if anything still pending; else stop the chain.
    if (termHasPending()) { termRevealTimer = setTimeout(termTick, delay); }
    else { termRevealTimer = 0; termCatchUp = 1; termStartedAt = 0; }
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
  // read-scan: when nothing is being EDITED, a new READ is worth showing — open the
  // read file and sweep a "reading" highlight through it (a reading indicator, not
  // typing). Reads are frequent, so edits always win (checked first); reads fill the
  // gaps. Pure schedule = readscan.js (node --tested); the sweep is fallback-only.
  let lastReadSeq = 0;
  function maybeScanRead(ring, newest) {
    if (pinned) return;                       // operator pinned a file — don't hijack
    let readT = null;
    for (let i = ring.length - 1; i >= 0; i--) {
      const a = ring[i];
      if (typeof a.seq !== 'number' || a.seq <= lastReadSeq) break;
      if (a.kind === 'read' && a.file_path) { readT = a; break; }
    }
    if (newest && typeof newest.seq === 'number') lastReadSeq = Math.max(lastReadSeq, newest.seq);
    if (!readT) return;
    followPaused = false; hideFollowChip();
    const line = (typeof readT.line === 'number' && readT.line > 0) ? readT.line : 0;
    openFile(readT.file_path, line, { follow: true, scanRead: readT });
  }

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
    if (!target) { maybeScanRead(ring, newest); return; }

    // If the operator pinned a different file, resume auto-follow once Claude
    // edits a file again (pin yields to live activity, per spec: "pins until
    // auto-follow resumes").
    pinned = false; pinnedPath = null;
    // A genuinely-new live edit re-engages follow: snap back to the live edit
    // even if the user had scrolled away (clears the manual-override pause).
    followPaused = false; hideFollowChip();
    // NEVER lag reality (FEATURE B #2): if the previous block is still typing when
    // this new edit lands, smoothly speed it to the finish during the (async) fetch
    // window. The forthcoming render's cancel-and-continue then starts the new block.
    accelerateRevealToFinish();
    accelerateTermRevealToFinish();

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
    cancelTermReveal();
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
    cancelCmReveal();                // stop any in-flight CM hunk-reveal (Spec 004)
    cancelTermReveal();              // stop the terminal reveal chain (FEATURE B #4)
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
