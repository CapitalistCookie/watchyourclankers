// node --test web/store.test.mjs — the store's terminal-buffer aggregation must be
// BOUNDED per session (found via the terminal-replay investigation: the renderer
// shows only the latest, but the store kept one TerminalBuf per bash command
// FOREVER — a slow leak on long-lived spectator sessions). Activities + screens are
// already bounded; terminals were not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import createStore from './store.js';

test('terminal buffers are bounded per session (no unbounded growth)', () => {
  const s = createStore();
  const N = 300;
  for (let i = 1; i <= N; i++) {
    s.applyTerminal({ session_id: 'sess', ref_seq: i, data: `out ${i}`, done: true });
  }
  const bufs = s.terminalForSession('sess');
  assert.ok(bufs.length < N, `expected bounded < ${N}, got ${bufs.length}`);
  // the LATEST command always survives (the renderer shows it)
  assert.equal(Math.max(...bufs.map((b) => b.ref_seq)), N, 'latest command must survive');
  // only the most recent window is kept (oldest evicted)
  assert.ok(Math.min(...bufs.map((b) => b.ref_seq)) > 1, 'oldest buffers must be evicted');
});

test('within the cap nothing is dropped + chunks accumulate per command', () => {
  const s = createStore();
  s.applyTerminal({ session_id: 'a', ref_seq: 1, data: 'foo', done: false });
  s.applyTerminal({ session_id: 'a', ref_seq: 1, data: 'bar', done: true });
  s.applyTerminal({ session_id: 'a', ref_seq: 2, data: 'baz', done: true });
  const bufs = s.terminalForSession('a');
  assert.equal(bufs.length, 2, 'two distinct commands retained');
  const first = bufs.find((b) => b.ref_seq === 1);
  assert.equal(first.chunks.join(''), 'foobar', 'chunks for one command accumulate');
  assert.equal(first.done, true);
});

test('bounding is per-session (one busy session does not evict another)', () => {
  const s = createStore();
  for (let i = 1; i <= 300; i++) s.applyTerminal({ session_id: 'busy', ref_seq: i, data: 'x', done: true });
  s.applyTerminal({ session_id: 'quiet', ref_seq: 1, data: 'hi', done: true });
  assert.equal(s.terminalForSession('quiet').length, 1, 'quiet session keeps its command');
});
