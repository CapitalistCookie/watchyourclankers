// ci/cm_smoke.mjs — the CodeMirror ON-BOX gate (Spec 004).
//
// Until 004, CM loaded only from esm.sh, which this box can't reach — so the CM
// path was UNTESTABLE here (every headless run hit the <pre> fallback). Now CM is
// vendored to /static/vendor/codemirror.bundle.js, so for the FIRST time we can
// assert the real CM path headless:
//
//   MOUNT (increment 2): the vendored bundle imports in the browser, exposes the
//     symbols ide.js needs, and a read-only EditorView actually renders its doc to
//     .cm-content — with ZERO console errors.
//   REVEAL (increment 3): dispatching a hunk char-by-char into the read-only doc
//     via CM transactions grows .cm-content incrementally (CM TYPES, not snaps).
//
// This is the harness the spec calls for: CM is DOM-gated, so a broken bundle / a
// missing export / a reveal that snaps FAILS the gate (it can't reach green on a
// pure-logic test — LESSONS L7). Wired into ci/full.sh.
//
// Skips cleanly if Playwright / token / daemon is absent (mirrors interaction.mjs).
// Usage: node ci/cm_smoke.mjs <port>
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const PORT = process.argv[2] || '8900';
const TOKEN_PATH = '/data/clanker/watchyourclankers/.wyc_token';
const PW = ['/home/user/projects/constructionmanagement/node_modules/@playwright/test', '@playwright/test', 'playwright'];

let chromium = null;
for (const c of PW) { try { chromium = require(c).chromium; break; } catch {} }
if (!chromium) { console.log('[cm-smoke] SKIP (no playwright)'); process.exit(0); }
let token = '';
try { token = readFileSync(TOKEN_PATH, 'utf8').trim(); } catch { console.log('[cm-smoke] SKIP (no token)'); process.exit(0); }

const browser = await chromium.launch();
let failed = false;
const fail = (m) => { console.log(`[cm-smoke] FAIL: ${m}`); failed = true; };

try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  // Count REAL script errors only, NOT resource-load failures. The live app fetches
  // /file for whatever the watched sessions edit, and a file outside WYC_FILE_ROOTS is
  // path-jailed to 403 (Principle II) — unrelated app noise, not a CM-mount failure (a
  // bundle/theme load failure surfaces via out.imported / out.error). Counting it made
  // this gate false-fail intermittently (L8: a finicky gate trains bypassing).
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  // Reachability: load the app shell so /static is served + same-origin import works.
  const resp = await page.goto(`http://127.0.0.1:${PORT}/?token=${token}`,
    { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
  if (!resp) { console.log('[cm-smoke] SKIP (daemon not reachable)'); await browser.close(); process.exit(0); }

  // The whole test runs IN the page (same origin), driving the REAL vendored bundle
  // exactly as ide.js does: dynamic import, build a read-only EditorView, then
  // dispatch a hunk char-by-char (the increment-3 reveal shape).
  const result = await page.evaluate(async () => {
    const out = { imported: false, exportsOk: false, mounted: false, mountedText: '',
                  tokenColors: 0, revealGrew: false, revealFinalOk: false, error: null };
    try {
      const m = await import('/static/vendor/codemirror.bundle.js');
      out.imported = true;
      const need = ['EditorState', 'EditorView', 'Compartment', 'lineNumbers',
                    'syntaxHighlighting', 'HighlightStyle', 'tags',
                    'javascript', 'python'];
      out.exportsOk = need.every((k) => m[k] != null);
      if (!out.exportsOk) { out.error = 'missing exports: ' + need.filter((k) => m[k] == null).join(','); return out; }

      // MOUNT with the REAL clanker theme (web/cmtheme.js) built from the bundle's
      // HighlightStyle + lezer tags — this exercises the EXACT tag list ide.js uses,
      // so a typo'd/renamed tag throws HERE (gate fail) instead of silently dropping
      // the live editor to the <pre> fallback. Asserts the doc renders + tokens colour.
      const cmt = await import('/static/cmtheme.js');
      const clankerHighlight = cmt.buildClankerHighlight(m.HighlightStyle, m.tags);
      const py = await m.python();
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:-9999px;width:600px;height:400px';
      document.body.appendChild(host);
      const startDoc = 'def greet(name):\n    return "hi " + name  # c\n';
      const view = new m.EditorView({
        parent: host,
        state: m.EditorState.create({
          doc: startDoc,
          extensions: [m.lineNumbers(), m.syntaxHighlighting(clankerHighlight), py,
                       m.EditorView.theme(cmt.clankerThemeSpec, { dark: true }),
                       m.EditorView.editable.of(false), m.EditorState.readOnly.of(true)],
        }),
      });
      const txt = () => host.querySelector('.cm-content')?.textContent ?? '';
      out.mountedText = txt();
      out.mounted = txt().includes('greet') && txt().includes('return');
      // the clanker highlight actually coloured tokens (>=3 distinct colours)?
      const _cols = [...host.querySelectorAll('.cm-line span')].map((s) => getComputedStyle(s).color);
      out.tokenColors = new Set(_cols.filter(Boolean)).size;

      // REVEAL via the REAL pure plan (web/cmreveal.js) applied through CM
      // transactions EXACTLY as ide.js does: setState(initialDoc), then replace the
      // growing region [from, from+prev] per step. Asserts CM TYPES (doc grows
      // monotonically over >1 step, never snaps) and lands on fullDoc EXACTLY. This
      // DOM-gates increment 3's actual plan code through real CodeMirror.
      const cmr = await import('/static/cmreveal.js');
      out.planImported = true;
      const fullDoc = 'alpha\nbeta\ngamma\ndelta\nepsilon';
      const plan = cmr.cmRevealPlan(fullDoc, 2, 4);   // reveal lines 2..4 (beta..delta)
      view.setState(m.EditorState.create({
        doc: plan.initialDoc,
        extensions: [m.EditorView.editable.of(false), m.EditorState.readOnly.of(true)],
      }));
      let prev = 0, lastDocLen = view.state.doc.length, monotonic = true;
      for (const step of plan.steps) {
        view.dispatch({ changes: { from: plan.from, to: plan.from + prev, insert: step } });
        prev = step.length;
        const dl = view.state.doc.length;
        if (dl < lastDocLen) monotonic = false;       // never shrinks (no snap-then-trim)
        lastDocLen = dl;
      }
      const finalDoc = view.state.doc.toString();
      const domText = (view.contentDOM && view.contentDOM.textContent) || '';
      out.revealGrew = monotonic && plan.steps.length > 1;          // typed, didn't snap
      out.revealFinalOk = finalDoc === fullDoc && domText.includes('beta') && domText.includes('delta');
      view.destroy();
      host.remove();
    } catch (e) {
      out.error = String(e && e.stack || e);
    }
    return out;
  });

  if (result.error) fail(result.error);
  if (!result.imported) fail('vendored bundle did not import in the browser');
  if (!result.exportsOk) fail('bundle missing required CM exports');
  if (!result.mounted) fail(`EditorView did not render its doc (.cm-content="${result.mountedText}")`);
  if (result.tokenColors < 3) fail(`clanker highlight coloured only ${result.tokenColors} distinct token colour(s) — the real tag list may be broken`);
  if (!result.revealGrew) fail('char-by-char dispatch did not grow .cm-content monotonically (CM snapped?)');
  if (!result.revealFinalOk) fail('reveal did not end with the full hunk text');

  // surface unexpected console errors (the bundle eval / CM mount must be clean)
  if (errors.length) fail(`console errors during CM mount: ${errors.slice(0, 3).join(' | ')}`);

  if (!failed) {
    console.log(`[cm-smoke] OK: vendored CM imported + mounted with the real clanker theme (${result.tokenColors} token colours) + revealed a hunk char-by-char on-box (0 console errors)`);
  }
} catch (e) {
  fail(String(e && e.stack || e));
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
