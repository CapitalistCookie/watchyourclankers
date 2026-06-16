// node --test web/idegeom.test.mjs
// Behavioral spec for the editor↔terminal resize geometry (R06). Locks the
// correct direction so it can never regress to "always goes down".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { termHForDrag, clampTermH, maxTermFor } from './idegeom.js';

const G = { gridH: 1000, min: 60, fracMax: 0.6 }; // maxTerm = 600

test('drag DOWN (dy>0) SHRINKS the terminal', () => {
  const after = termHForDrag({ startH: 200, dy: 50, ...G });
  assert.equal(after, 150);
  assert.ok(after < 200, 'down must shrink');
});

test('drag UP (dy<0) GROWS the terminal', () => {
  const after = termHForDrag({ startH: 200, dy: -50, ...G });
  assert.equal(after, 250);
  assert.ok(after > 200, 'up must grow');
});

test('NOT always-goes-down: opposite drags move opposite ways from the same start', () => {
  const down = termHForDrag({ startH: 300, dy: 80, ...G });
  const up = termHForDrag({ startH: 300, dy: -80, ...G });
  assert.ok(down < 300 && up > 300, `down=${down} up=${up} must straddle 300`);
  assert.notEqual(down, up);
});

test('clamps to the floor (min)', () => {
  assert.equal(termHForDrag({ startH: 200, dy: 1000, ...G }), 60);
});

test('clamps to the ceiling (fracMax of grid)', () => {
  assert.equal(maxTermFor(1000, 60, 0.6), 600);
  assert.equal(termHForDrag({ startH: 500, dy: -1000, ...G }), 600);
});

test('idempotent: dy=0 leaves termH unchanged (within bounds)', () => {
  assert.equal(termHForDrag({ startH: 200, dy: 0, ...G }), 200);
});

test('a re-render (clampTermH) never mutates an in-bounds termH', () => {
  // the invariant that prevents "a re-render clobbers termH"
  assert.equal(clampTermH(200, 1000, 60, 0.6), 200);
  assert.equal(clampTermH(200, 1000, 60, 0.6), 200); // stable across repeated reads
});

test('unknown grid height -> no artificial ceiling (Infinity max), still floored', () => {
  assert.equal(maxTermFor(0, 60, 0.6), Infinity);
  assert.equal(termHForDrag({ startH: 200, dy: -100, gridH: 0, min: 60, fracMax: 0.6 }), 300);
  assert.equal(termHForDrag({ startH: 80, dy: 100, gridH: 0, min: 60, fracMax: 0.6 }), 60);
});
