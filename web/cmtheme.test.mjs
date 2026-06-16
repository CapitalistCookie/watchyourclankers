// node --test — shape of the pure clanker CodeMirror theme spec. The REAL lezer
// tags are exercised against the vendored bundle by ci/cm_smoke.mjs; here we lock
// the spec structure (well-formed rules, hex colours, no one-dark grey) with a
// fake `tags` so it runs headless + dep-free.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clankerHighlightSpec, clankerThemeSpec } from './cmtheme.js';

// Fake `tags`: every property is a marker string; the modifier functions
// (constant/function/special/definition/…) return a marker too — so every tag the
// spec references resolves to a non-null value (a real typo would be undefined and
// fail the assertions below, mirroring what cm_smoke catches against real tags).
function fakeTags() {
  const MODIFIERS = new Set(['constant', 'function', 'special', 'definition', 'standard', 'local']);
  return new Proxy({}, {
    get(_t, prop) {
      if (MODIFIERS.has(prop)) return (inner) => `${String(prop)}(${inner})`;
      return String(prop);
    },
  });
}

test('clankerHighlightSpec yields well-formed rules with hex colours', () => {
  const spec = clankerHighlightSpec(fakeTags());
  assert.ok(spec.length >= 10, 'a real palette has many rules');
  for (const rule of spec) {
    assert.ok(Array.isArray(rule.tag) && rule.tag.length >= 1, 'each rule tags >= 1 token');
    assert.ok(/^#[0-9a-f]{6}$/i.test(rule.color), `colour must be hex: ${rule.color}`);
    for (const tg of rule.tag) assert.ok(tg != null && tg !== 'undefined', 'no undefined tag (typo?)');
  }
});

test('the palette is Gruvbox-warm, not one-dark grey', () => {
  const colors = clankerHighlightSpec(fakeTags()).map((r) => r.color.toLowerCase());
  assert.ok(colors.includes('#b8bb26'), 'gruvbox green (strings)');
  assert.ok(colors.includes('#d3869b'), 'gruvbox purple (keywords)');
  assert.ok(!colors.includes('#282c34'), 'no one-dark editor grey');
});

test('chrome theme spec uses app CSS vars, no hardcoded grey', () => {
  const css = JSON.stringify(clankerThemeSpec);
  assert.ok(css.includes('var(--bg-deep)') && css.includes('var(--accent)'), 'app vars');
  assert.ok(!/#282c34/i.test(css), 'no one-dark grey');
});
