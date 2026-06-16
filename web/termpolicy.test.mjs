// node --test web/termpolicy.test.mjs — the terminal cadence policy (realistic terminal).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { termCommandStep, termOutputTake, latestTerminalBuf } from './termpolicy.js';

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

// ── show-only-the-latest-command (the "terminal repeats the same command over and
// over" bug). store.terminalForSession returns ALL buffers (uncapped); the renderer
// must reconcile ONLY the latest (highest ref_seq), else evicted older buffers look
// "new" each tick and get re-created + re-typed. This pure decision is what the
// renderer drives, so an older buffer is never re-selected.
test('latestTerminalBuf returns the highest-ref_seq buffer (the current command)', () => {
  const bufs = [{ ref_seq: 10, command: 'a' }, { ref_seq: 30, command: 'c' }, { ref_seq: 20, command: 'b' }];
  assert.equal(latestTerminalBuf(bufs).ref_seq, 30);
  assert.equal(latestTerminalBuf(bufs).command, 'c');
});

test('latestTerminalBuf is empty-safe', () => {
  assert.equal(latestTerminalBuf([]), null);
  assert.equal(latestTerminalBuf(null), null);
  assert.equal(latestTerminalBuf(undefined), null);
});

test('latestTerminalBuf is stable + never re-selects an older buffer as the list grows', () => {
  // the bug: re-rendering with the full/growing buf list re-picked older buffers.
  let bufs = [{ ref_seq: 10, command: 'first' }];
  assert.equal(latestTerminalBuf(bufs).ref_seq, 10);
  bufs = [...bufs, { ref_seq: 20, command: 'second' }];
  assert.equal(latestTerminalBuf(bufs).ref_seq, 20);
  // repeated calls with the SAME list are idempotent (no churn back to an older one)
  assert.equal(latestTerminalBuf(bufs).ref_seq, 20);
  assert.equal(latestTerminalBuf(bufs).ref_seq, 20);
  // a brand-new command advances; older ones (10, 20) are never returned again
  bufs = [...bufs, { ref_seq: 33, command: 'third' }];
  for (let i = 0; i < 5; i++) assert.equal(latestTerminalBuf(bufs).ref_seq, 33);
});

test('latestTerminalBuf tolerates a missing ref_seq', () => {
  const bufs = [{ command: 'x' }, { ref_seq: 5, command: 'y' }];
  assert.equal(latestTerminalBuf(bufs).ref_seq, 5);
});
