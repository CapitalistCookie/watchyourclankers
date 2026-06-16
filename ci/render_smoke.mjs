// Headless render smoke — asserts the web UI actually PAINTS, catching the class
// of bug where the page loads but the JS modules 404 (e.g. a static-path mismatch)
// and the body stays empty. Skips gracefully if Playwright/a browser is absent.
//
// CDN failures (esm.sh / CodeMirror) are TOLERATED: this box can't reach esm.sh,
// and ide.js falls back to a <pre> view — the body still paints. The bodyLen
// guard distinguishes "app.js 404 -> blank" (FAIL) from "CDN blocked -> fallback"
// (PASS, body is large).
//
// Usage: node ci/render_smoke.mjs <port>
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const PORT = process.argv[2] || '8900';
const TOKEN_PATH = '/data/clanker/watchyourclankers/.wyc_token';
const PW_CANDIDATES = [
  '/home/user/projects/constructionmanagement/node_modules/@playwright/test',
  '@playwright/test', 'playwright',
];

let chromium = null;
for (const c of PW_CANDIDATES) { try { chromium = require(c).chromium; break; } catch { /* next */ } }
if (!chromium) { console.log('[render-smoke] SKIP (no playwright available)'); process.exit(0); }

let token = '';
try { token = readFileSync(TOKEN_PATH, 'utf8').trim(); } catch { console.log('[render-smoke] SKIP (no token file)'); process.exit(0); }

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  await page.goto(`http://127.0.0.1:${PORT}/?token=${token}`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(5000);
  const info = await page.evaluate(() => ({
    bodyLen: document.body.innerHTML.length,
    tiles: document.querySelectorAll('[class*="tile"]').length,
  }));
  // Tolerate CDN/resource failures (esm.sh blocked on-box); the bodyLen guard
  // is what catches a genuinely-blank UI.
  const realErrors = errors.filter(e => !/esm\.sh|codemirror|cm-editor|Failed to load resource/i.test(e));
  console.log(`[render-smoke] bodyLen=${info.bodyLen} tiles=${info.tiles} realErrors=${realErrors.length}`);
  if (info.bodyLen < 1000) {
    console.error('[render-smoke] FAIL: body did not paint (<1000 bytes) — static-path/module-load regression?');
    process.exit(1);
  }
  if (realErrors.length) {
    console.error('[render-smoke] FAIL: non-CDN console errors:', JSON.stringify(realErrors.slice(0, 5)));
    process.exit(1);
  }

  // R07 terminal-structure: the terminal must render as ONE CONTINUOUS shell feed
  // (`$ cmd → output → $ cmd`), NOT a boxed/sticky mini-panel per command. Inject a
  // representative subtree and assert the continuous-feed CSS (ide.css) is applied.
  const term = await page.evaluate(() => {
    const root = document.createElement('div');
    root.className = 'ide';
    root.style.cssText = 'position:absolute;left:-9999px;top:0';
    root.innerHTML = '<div class="term-feed"><div class="term-block"><div class="term-cmd">' +
      '<span class="prompt">$</span><span class="cmd">echo hi</span><span class="exit ok">exit 0</span>' +
      '</div><pre class="term-out">hi</pre></div></div>';
    document.body.appendChild(root);
    const cmd = root.querySelector('.term-cmd');
    const block = root.querySelector('.term-block');
    const cs = getComputedStyle(cmd), bs = getComputedStyle(block);
    const r = {
      sticky: cs.position === 'sticky',
      cmdBorder: parseFloat(cs.borderBottomWidth) || 0,
      blockBorder: parseFloat(bs.borderBottomWidth) || 0,
    };
    root.remove();
    return r;
  });
  console.log(`[render-smoke] terminal-structure: sticky=${term.sticky} cmdBorder=${term.cmdBorder} blockBorder=${term.blockBorder}`);
  if (term.sticky || term.cmdBorder > 0 || term.blockBorder > 0) {
    console.error('[render-smoke] FAIL: terminal renders as boxed mini-panels (R07) — must be one continuous feed');
    process.exit(1);
  }

  console.log('[render-smoke] OK');
} finally {
  await browser.close();
}
