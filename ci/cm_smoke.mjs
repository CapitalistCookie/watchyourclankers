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
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
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
                  revealGrew: false, revealFinalOk: false, error: null };
    try {
      const m = await import('/static/vendor/codemirror.bundle.js');
      out.imported = true;
      const need = ['EditorState', 'EditorView', 'Compartment', 'lineNumbers',
                    'syntaxHighlighting', 'defaultHighlightStyle', 'oneDark',
                    'javascript', 'python'];
      out.exportsOk = need.every((k) => m[k] != null);
      if (!out.exportsOk) { out.error = 'missing exports: ' + need.filter((k) => m[k] == null).join(','); return out; }

      // MOUNT: a read-only editor that renders a doc (the static-view claim).
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:-9999px;width:600px;height:400px';
      document.body.appendChild(host);
      const startDoc = 'line one\nline two\n';
      const view = new m.EditorView({
        parent: host,
        state: m.EditorState.create({
          doc: startDoc,
          extensions: [m.lineNumbers(), m.EditorView.editable.of(false), m.EditorState.readOnly.of(true)],
        }),
      });
      const txt = () => host.querySelector('.cm-content')?.textContent ?? '';
      out.mountedText = txt();
      out.mounted = txt().includes('line one') && txt().includes('line two');

      // REVEAL: append a hunk ONE CHAR at a time via transactions on the read-only
      // doc (programmatic dispatch is allowed even when editable:false). The
      // rendered text must GROW monotonically and end with the full hunk — i.e. CM
      // TYPES instead of snapping the block in.
      const hunk = 'def hi():\n    return 42\n';
      let prevLen = txt().length;
      let grew = true;
      for (const ch of hunk) {
        const end = view.state.doc.length;
        view.dispatch({ changes: { from: end, insert: ch } });
        const now = txt().length;
        if (now < prevLen) grew = false;       // never shrinks
        prevLen = now;
      }
      out.revealGrew = grew && prevLen > out.mountedText.length;
      out.revealFinalOk = txt().includes('def hi():') && txt().includes('return 42');
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
  if (!result.revealGrew) fail('char-by-char dispatch did not grow .cm-content monotonically (CM snapped?)');
  if (!result.revealFinalOk) fail('reveal did not end with the full hunk text');

  // surface unexpected console errors (the bundle eval / CM mount must be clean)
  if (errors.length) fail(`console errors during CM mount: ${errors.slice(0, 3).join(' | ')}`);

  if (!failed) {
    console.log(`[cm-smoke] OK: vendored CM imported + mounted (rendered doc) + revealed a hunk char-by-char on-box (0 console errors)`);
  }
} catch (e) {
  fail(String(e && e.stack || e));
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
