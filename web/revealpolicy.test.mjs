// node --test web/revealpolicy.test.mjs — editor reveal granularity (char vs line).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revealByLine, CHAR_CAP } from './revealpolicy.js';

test('char-level for normal AND large hunks (no more line-by-line at 800)', () => {
  assert.equal(revealByLine(50), false);
  assert.equal(revealByLine(800), false);    // the OLD threshold — now char-level
  assert.equal(revealByLine(3000), false);
  assert.equal(revealByLine(CHAR_CAP), false);
});

test('only a TRULY massive hunk falls back to per-line (perf floor)', () => {
  assert.equal(revealByLine(CHAR_CAP + 1), true);
  assert.equal(revealByLine(50000), true);
});

test('junk tolerated', () => {
  assert.equal(revealByLine(0), false);
  assert.equal(revealByLine(-5), false);
  assert.equal(revealByLine(undefined), false);
  assert.equal(revealByLine(null), false);
});
