// ci/interaction.mjs — the DOM-INTERACTION gate (the rung the harness was missing).
//
// node --test proves pure LOGIC; this proves the live DOM actually INTERACTS. It
// drives real pointer events against the running daemon and asserts the editor↔
// terminal gutter drag changes `gridTemplateRows` (and survives a store tick). A
// pure-math test (web/idegeom.test.mjs) passes while the wiring is broken — this is
// the only thing that catches a dead onDelta / wrong-arg / clobber (LESSONS L1 at
// the DOM layer; the R06 "fixed but still broken" failure).
//
// Skips cleanly if Playwright/token/a mounted IDE gutter is absent (like
// render_smoke); but if a gutter IS present, a non-working drag FAILS the gate.
//
// Usage: node ci/interaction.mjs <port>
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const PORT = process.argv[2] || '8900';
const TOKEN_PATH = '/data/clanker/watchyourclankers/.wyc_token';
const PW = ['/home/user/projects/constructionmanagement/node_modules/@playwright/test', '@playwright/test', 'playwright'];

let chromium = null;
for (const c of PW) { try { chromium = require(c).chromium; break; } catch {} }
if (!chromium) { console.log('[interaction] SKIP (no playwright)'); process.exit(0); }
let token = '';
try { token = readFileSync(TOKEN_PATH, 'utf8').trim(); } catch { console.log('[interaction] SKIP (no token)'); process.exit(0); }

const rowsOf = (s) => (String(s).match(/[\d.]+px/g) || []).map(parseFloat); // [editor, gutter, terminal, status]
const termTrack = (s) => { const r = rowsOf(s); return r.length >= 3 ? r[2] : NaN; };

const browser = await chromium.launch();
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(`http://127.0.0.1:${PORT}/?token=${token}`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(7000); // let an IDE pane mount

  const pick = await page.evaluate(() => {
    for (const ide of document.querySelectorAll('.ide')) {
      const g = ide.querySelector('.ide-gutter-row');
      if (!g) continue;
      const r = g.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && g.offsetParent !== null && !g.classList.contains('inert')) {
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, rows: getComputedStyle(ide).gridTemplateRows };
      }
    }
    return null;
  });
  if (!pick) { console.log('[interaction] SKIP (no mounted IDE terminal gutter to drag)'); await browser.close(); process.exit(0); }

  const before = termTrack(pick.rows);
  const readRows = () => page.evaluate(() => {
    const ide = [...document.querySelectorAll('.ide')].find(e => e.querySelector('.ide-gutter-row'));
    return ide ? getComputedStyle(ide).gridTemplateRows : '';
  });

  // DRAG UP by 90px (x held constant so dx===0: a buggy handler reading dx makes NO
  // change → clean RED). Up should GROW the terminal (termH = startH - dy, dy<0).
  await page.mouse.move(pick.x, pick.y);
  await page.mouse.down();
  for (let i = 1; i <= 9; i++) await page.mouse.move(pick.x, pick.y - i * 10, { steps: 1 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const afterUp = termTrack(await readRows());

  // store-tick clobber check
  await page.waitForTimeout(2500);
  const afterTick = termTrack(await readRows());

  console.log(`[interaction] terminal track px: before=${before} afterDragUp=${afterUp} afterTick=${afterTick}`);

  if (!(afterUp > before + 2)) {
    console.error(`[interaction] FAIL: drag UP did not grow the terminal (${before} → ${afterUp}). `
      + `The gutter drag is a no-op — events arrive but onDelta doesn't move termH (wrong-arg / dead write).`);
    failed = true;
  } else if (Math.abs(afterTick - afterUp) > 2) {
    console.error(`[interaction] FAIL: a store tick CLOBBERED the dragged size (${afterUp} → ${afterTick}).`);
    failed = true;
  } else {
    console.log('[interaction] OK: gutter drag resizes the terminal and survives a store tick');
  }
} catch (e) {
  console.error('[interaction] FAIL: probe threw', e && e.message);
  failed = true;
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
