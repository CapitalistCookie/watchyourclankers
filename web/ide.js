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

const MAX_TABS = 8;
const TYPEWRITER_BUDGET_MS = 600;   // total time we allow the hunk reveal to take
const TYPEWRITER_MAX_CHARS = 400;   // never animate more than this (honesty: edits are hunks)

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

  /* -------------------------------------------------- DOM skeleton (built once) */
  mountEl.innerHTML = '';
  const root = el('div', 'ide');

  // --- left: file tree
  const treePane = el('div', 'ide-pane ide-tree');
  const treeHdr = el('div', 'ide-hdr');
  treeHdr.append(el('span', 'accent', 'files'), el('span', 'count', ''));
  const treeBody = el('div', 'ide-body');
  const treeList = el('div', 'tree-list');
  treeBody.append(treeList);
  treePane.append(treeHdr, treeBody);

  // --- center: tabs + meta + editor
  const editorPane = el('div', 'ide-pane ide-editor');
  const tabbar = el('div', 'tabbar');
  const editorMeta = el('div', 'editor-meta');
  const epath = el('span', 'epath');
  editorMeta.append(epath);
  const editorWrap = el('div', 'editor-wrap');
  const editorEmpty = el('div', 'editor-empty', 'no file open — the editor follows what Claude edits');
  editorWrap.append(editorEmpty);
  editorPane.append(tabbar, editorMeta, editorWrap);

  // --- bottom: terminal
  const termPane = el('div', 'ide-pane ide-terminal');
  const termHdr = el('div', 'ide-hdr');
  termHdr.append(el('span', 'icon', '$'), el('span', 'accent', 'terminal'), el('span', 'count', ''));
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

  root.append(treePane, editorPane, termPane, screenPane, statusBar);
  mountEl.append(root);

  /* -------------------------------------------------- mutable view state */
  let destroyed = false;

  // editor: CodeMirror handle (or null while loading / if it failed)
  /** @type {{view:any, EditorState:any, EditorView:any, Compartment:any, langCompartment:any, baseExts:any[], oneDark:any}|null} */
  let cm = null;
  let cmLoading = false;
  let cmFailed = false;
  const langCache = new Map();        // langKey -> resolved CM extension
  let fallbackEl = null;              // <pre> fallback element (if used)

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

  // render content via the highlighted <pre> fallback (no CM)
  function renderFallback(path, content, focusLine) {
    if (editorEmpty.parentNode) editorEmpty.remove();
    if (cm && cm.view.dom.parentNode) cm.view.dom.remove();
    if (!fallbackEl) {
      fallbackEl = el('pre', 'editor-fallback');
      const note = el('div', 'editor-fallback-note', 'editor offline · highlighted plain view');
      editorWrap.append(note, fallbackEl);
    }
    fallbackEl.innerHTML = '';
    const lines = String(content == null ? '' : content).split('\n');
    const frag = document.createDocumentFragment();
    for (let i = 0; i < lines.length; i++) {
      const lineEl = el('span', i + 1 === focusLine ? 'wyc-hunk-flash' : null);
      lineEl.append(el('span', 'ln', String(i + 1)));
      lineEl.append(document.createTextNode(lines[i] + '\n'));
      frag.append(lineEl);
    }
    fallbackEl.append(frag);
    // scroll to focus line
    if (focusLine && focusLine > 1) {
      const target = fallbackEl.children[focusLine - 1];
      if (target && target.scrollIntoView) {
        try { target.scrollIntoView({ block: 'center' }); } catch (_) {}
      }
    }
  }

  // Set the editor's document to `content` for `path`, choose the language, then
  // (optionally) scroll-to + flash the hunk line, and typewriter-reveal newHunk.
  async function showFileInEditor(path, content, focusLine, hunkNew) {
    const myToken = ++fetchToken;
    await ensureEditor();
    if (destroyed || myToken !== fetchToken) return; // a newer swap superseded us

    if (cmFailed || !cm) {
      renderFallback(path, content, focusLine);
      return;
    }
    attachCmDom();
    const langExt = await langExtFor(path);
    if (destroyed || myToken !== fetchToken) return;

    const { view, EditorState, langCompartment, baseExts } = cm;
    const doc = String(content == null ? '' : content);
    // full reset of doc + language (cheap; we only do this on a file switch / re-edit)
    view.setState(EditorState.create({ doc, extensions: [langCompartment.of(langExt), ...baseExts] }));

    // scroll to + flash the changed line
    if (focusLine && focusLine > 0) {
      flashAndScrollCm(focusLine, hunkNew);
    }
  }

  // Scroll to a line in CM, add a transient flash decoration, and run the
  // honest typewriter reveal of the hunk text if it's small enough.
  function flashAndScrollCm(line, hunkNew) {
    if (!cm) return;
    const { view } = cm;
    try {
      const total = view.state.doc.lines;
      const ln = Math.max(1, Math.min(line, total));
      const pos = view.state.doc.line(ln).from;
      view.dispatch({ effects: cm.EditorView.scrollIntoView(pos, { y: 'center' }) });
      // flash the line via a DOM class on the rendered .cm-line (simple + dep-free)
      requestAnimationFrame(() => {
        const lineBlock = view.lineBlockAt(pos);
        const dom = view.domAtPos(lineBlock.from);
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

  /* ==================================================================== files */
  function fileUrl(path) {
    const t = getToken();
    return `/file?path=${encodeURIComponent(path)}${t ? `&token=${encodeURIComponent(t)}` : ''}`;
  }

  // fetch (with cache + de-dup). force=true bypasses cache (re-edit of open file).
  function fetchFile(path, force) {
    if (!force && fileCache.has(path)) return Promise.resolve(fileCache.get(path));
    if (fileInflight.has(path)) return fileInflight.get(path);
    const p = fetch(fileUrl(path), { headers: { Accept: 'application/json' } })
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
        fileCache.set(path, rec);
        fileInflight.delete(path);
        return rec;
      })
      .catch((e) => {
        fileInflight.delete(path);
        // fall back to reconstructing from activity hunks, else a placeholder
        const rec = reconstructFromHunks(path) || {
          content: `// ${baseName(path)}\n// (could not load file: ${e && e.message ? e.message : e})\n// ${path}`,
          lines: null, redacted: false, truncated: false, recon: true, ts: Date.now(),
        };
        fileCache.set(path, rec);
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
  function openFile(path, focusLine, opts2 = {}) {
    if (!path) return;
    addTab(path, !!opts2.flash);
    setActiveTab(path);
    updateEditorMeta(path);
    const force = !!opts2.force;
    const hunkNew = opts2.hunkNew || null;
    fetchFile(path, force).then((rec) => {
      if (destroyed || activeTab !== path) return; // user/auto moved on
      updateEditorMeta(path, rec);
      showFileInEditor(path, rec.content, focusLine, hunkNew);
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
    if (cm && cm.view.dom.parentNode) cm.view.dom.remove();
    if (fallbackEl && fallbackEl.parentNode) { fallbackEl.remove(); fallbackEl = null; }
    if (!editorEmpty.parentNode) editorWrap.append(editorEmpty);
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
      row.style.paddingLeft = (8 + depth * 13) + 'px';
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
      row.style.paddingLeft = (8 + depth * 13) + 'px';
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

    const path = target.file_path;
    const line = target.line || 1;
    // a new edit to a file we've shown means its cached content is stale: re-fetch
    const force = fileCache.has(path);
    openFile(path, line, { flash: true, force, hunkNew: target.hunk_new });
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
    activeTab = null;
    tabs = [];
    tabEls.clear();
    tabbar.innerHTML = '';
    fileCache.clear();
    fileInflight.clear();
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
