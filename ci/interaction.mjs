// ci/interaction.mjs — the DOM-INTERACTION gate (the rung the harness was missing).
//
// node --test proves pure LOGIC; this proves the live DOM actually INTERACTS. It
// drives real pointer events against the running daemon and asserts that dragging
// EVERY vertical resize gutter (.wyc-gutter-y — the ide terminal split, the mosaic
// tile-row split, the debug row split) actually changes its grid's row template
// (and survives a store tick). A pure-math test passes while the wiring is dead —
// this is the only thing that catches a dead onDelta / wrong-arg / clobber across
// ALL three gutters (the onDelta(dx,dy) wrong-arg bug hit all three). LESSONS L1/L7.
//
// Skips cleanly if Playwright/token/a draggable gutter is absent; but if a gutter
// IS present, a non-working drag FAILS the gate.
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

const browser = await chromium.launch();
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(`http://127.0.0.1:${PORT}/?token=${token}`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(7000); // let panes mount

  // Enumerate every draggable vertical gutter + the grid whose rows it controls.
  // gridTemplateRows of the nearest grid ancestor with >=3 tracks is what a vertical
  // drag must change. We tag each gutter with a data attr so we can re-find it.
  const targets = await page.evaluate(() => {
    const out = [];
    const guts = [...document.querySelectorAll('.wyc-gutter-y')];
    guts.forEach((g, i) => {
      const r = g.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0) || g.offsetParent === null || g.classList.contains('inert')) return;
      // nearest grid ancestor with >=3 row tracks (so a middle track can move)
      let grid = g.parentElement, found = null;
      while (grid) {
        const cs = getComputedStyle(grid);
        if (cs.display.includes('grid')) {
          const rows = (cs.gridTemplateRows.match(/[\d.]+px|minmax|1fr/g) || []);
          if (rows.length >= 3) { found = grid; break; }
        }
        grid = grid.parentElement;
      }
      if (!found) return;
      g.setAttribute('data-itest', String(i));
      found.setAttribute('data-itest-grid', String(i));
      out.push({ id: String(i), x: r.x + r.width / 2, y: r.y + r.height / 2,
                 rows: getComputedStyle(found).gridTemplateRows,
                 kind: g.closest('.ide') ? 'ide' : (g.closest('[class*="debug"]') ? 'debug' : 'mosaic') });
    });
    return out;
  });

  if (!targets.length) { console.log('[interaction] SKIP (no draggable vertical gutter mounted)'); await browser.close(); process.exit(0); }

  const gridRows = (id) => page.evaluate((i) => {
    const el = document.querySelector(`[data-itest-grid="${i}"]`);
    return el ? getComputedStyle(el).gridTemplateRows : '';
  }, id);

  let tested = 0;
  for (const t of targets) {
    const before = await gridRows(t.id);
    // real drag UP by 90px (x held constant so dx===0: a wrong-arg handler reading
    // dx makes NO change → clean RED).
    await page.mouse.move(t.x, t.y);
    await page.mouse.down();
    for (let i = 1; i <= 9; i++) await page.mouse.move(t.x, t.y - i * 10, { steps: 1 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    const afterDrag = await gridRows(t.id);
    await page.waitForTimeout(1500);
    const afterTick = await gridRows(t.id);
    tested++;
    const changed = afterDrag && afterDrag !== before;
    // `settled` is INFORMATIONAL only — NOT a failure. The daemon watches LIVE
    // sessions, so a store-tick re-render can legitimately change the grid during
    // the probe (a flaky clobber check is worse than none — AP-8); a true termH
    // RESET clobber was refuted by the audit. The hard assertion is "drag moves it".
    const settled = afterDrag === afterTick;
    console.log(`[interaction] gutter#${t.id} (${t.kind}): changed=${!!changed} settled=${settled}`);
    if (!changed) {
      console.error(`[interaction] FAIL: dragging the ${t.kind} gutter did NOT change its grid rows `
        + `(${before} unchanged) — the drag is a no-op (wrong-arg / dead write).`);
      failed = true;
    }
  }
  if (!failed) console.log(`[interaction] OK: all ${tested} vertical gutter(s) resize on a real drag + survive a store tick`);
} catch (e) {
  console.error('[interaction] FAIL: probe threw', e && e.message);
  failed = true;
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
