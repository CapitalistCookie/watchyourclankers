// node --test web/reveal.test.mjs
// Behavioral spec for the char-level reveal-with-deletions engine (R08).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffEdit, revealFrames, revealStepCount } from './reveal.js';

test('diffEdit invariant: prefix+deleted+suffix===old, prefix+inserted+suffix===new', () => {
  const cases = [
    ['', 'hello'],
    ['hello', ''],
    ['abc', 'abc'],
    ['const x = 1', 'const y = 2'],
    ['abXc', 'abYc'],
    ['function foo()', 'function foobar()'],
    ['  return a;', '  return ab;'],
    ['hello world', 'hello brave world'],
  ];
  for (const [o, n] of cases) {
    const d = diffEdit(o, n);
    assert.equal(d.prefix + d.deleted + d.suffix, o, `old reconstruct for ${o}->${n}`);
    assert.equal(d.prefix + d.inserted + d.suffix, n, `new reconstruct for ${o}->${n}`);
  }
});

test('pure append: nothing deleted', () => {
  const d = diffEdit('abc', 'abcdef');
  assert.equal(d.deleted, '');
  assert.equal(d.inserted, 'def');
});

test('pure deletion: nothing inserted', () => {
  const d = diffEdit('abcdef', 'abc');
  assert.equal(d.deleted, 'def');
  assert.equal(d.inserted, '');
});

test('replace is MINIMAL: shares a coincidental trailing char', () => {
  // 'let total = 0' -> 'let total = 100' shares the trailing '0', so the minimal
  // edit inserts '10' before it (NOT delete '0' + insert '100').
  const d = diffEdit('let total = 0', 'let total = 100');
  assert.equal(d.deleted, '');
  assert.equal(d.inserted, '10');
  assert.equal(d.prefix + d.deleted + d.suffix, 'let total = 0');
  assert.equal(d.prefix + d.inserted + d.suffix, 'let total = 100');
});

test('clean single-char replace (no suffix coincidence)', () => {
  const d = diffEdit('let total = 0', 'let total = 9');
  assert.equal(d.deleted, '0');
  assert.equal(d.inserted, '9');
});

test('revealFrames starts at old, ends at new', () => {
  const frames = revealFrames('const x = 1', 'const y = 2');
  assert.equal(frames[0], 'const x = 1');
  assert.equal(frames[frames.length - 1], 'const y = 2');
});

test('revealFrames moves one char at a time (deterministic typist)', () => {
  const frames = revealFrames('color: red;', 'color: blue;');
  for (let i = 1; i < frames.length; i++) {
    assert.equal(Math.abs(frames[i].length - frames[i - 1].length), 1,
      `frame ${i} must differ by exactly one char`);
  }
});

test('revealFrames passes through prefix+suffix (deletions THEN insertions)', () => {
  // 'abXYc' -> 'abZc': delete 'XY' (2 backspaces) then type 'Z' (1) → through 'abc'
  const frames = revealFrames('abXYc', 'abZc');
  assert.ok(frames.includes('abc'), 'must reach the deleted-down state prefix+suffix');
  assert.equal(frames[0], 'abXYc');
  assert.equal(frames[frames.length - 1], 'abZc');
});

test('identical strings → single frame, zero steps', () => {
  assert.deepEqual(revealFrames('same', 'same'), ['same']);
  assert.equal(revealStepCount('same', 'same'), 0);
});

test('step count = deletions + insertions', () => {
  assert.equal(revealStepCount('abc', 'abcdef'), 3); // +def
  assert.equal(revealStepCount('abcdef', 'abc'), 3); // -def
  assert.equal(revealStepCount('abXc', 'abYc'), 2);  // -X +Y
});

test('null/undefined tolerated', () => {
  assert.equal(revealFrames(null, 'hi').pop(), 'hi');
  assert.equal(revealFrames('hi', null)[0], 'hi');
});
