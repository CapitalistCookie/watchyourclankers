// node --test web/termpolicy.test.mjs — the terminal cadence policy (realistic terminal).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { termCommandStep, termOutputTake } from './termpolicy.js';

test('OUTPUT is INSTANT — take the whole pending output, never sliced', () => {
  assert.equal(termOutputTake(500), 500);
  assert.equal(termOutputTake(1), 1);
  assert.equal(termOutputTake(0), 0);
  assert.equal(termOutputTake(99999), 99999);
});

test('termOutputTake tolerates junk', () => {
  assert.equal(termOutputTake(-5), 0);
  assert.equal(termOutputTake(undefined), 0);
  assert.equal(termOutputTake(12.7), 12);
});

test('COMMAND is typed in small groups (a person typing), never a dump', () => {
  // short command: 1 char/step
  assert.equal(termCommandStep(5), 1);
  // medium: grouped but small (<=4)
  const s = termCommandStep(100);
  assert.ok(s >= 1 && s <= 4, `grouped step ${s}`);
  // never exceeds remaining
  assert.equal(termCommandStep(2), Math.min(2, termCommandStep(2)));
  assert.equal(termCommandStep(0), 0);
});

test('command speed multiplier compresses (catch-up), still bounded by remaining', () => {
  assert.equal(termCommandStep(3, { speed: 10 }), 3); // can't exceed remaining
  assert.ok(termCommandStep(100, { speed: 5 }) >= termCommandStep(100, { speed: 1 }));
});
