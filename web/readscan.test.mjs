// node --test web/readscan.test.mjs — behavioral spec for the read-scan schedule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readScanSteps, readRange } from './readscan.js';

test('small range sweeps every line, in order', () => {
  assert.deepEqual(readScanSteps(3, 7), [3, 4, 5, 6, 7]);
});

test('single line → one step', () => {
  assert.deepEqual(readScanSteps(10, 10), [10]);
});

test('reversed/garbage clamps (end >= start >= 1)', () => {
  assert.deepEqual(readScanSteps(8, 2), [8]);
  assert.deepEqual(readScanSteps(0, 0), [1]);
});

test('large range is BOUNDED (~maxSteps) and includes first + last', () => {
  const steps = readScanSteps(1, 1000, { maxSteps: 50 });
  assert.ok(steps.length <= 52, `bounded, got ${steps.length}`);
  assert.equal(steps[0], 1);
  assert.equal(steps[steps.length - 1], 1000);
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i] > steps[i - 1], 'monotonic');
});

test('readRange uses offset/limit when present', () => {
  assert.deepEqual(readRange({ offset: 100, limit: 50 }, 1000), { start: 100, end: 149 });
});

test('readRange offset with no limit → to end of file', () => {
  assert.deepEqual(readRange({ offset: 990 }, 1000), { start: 990, end: 1000 });
});

test('readRange falls back to a window around `line`', () => {
  assert.deepEqual(readRange({ line: 20 }, 1000, { window: 40 }), { start: 20, end: 59 });
});

test('readRange with nothing known → whole (bounded) file', () => {
  assert.deepEqual(readRange({}, 300), { start: 1, end: 300 });
});

test('readRange clamps to the document', () => {
  assert.deepEqual(readRange({ offset: 500, limit: 999 }, 600), { start: 500, end: 600 });
  assert.deepEqual(readRange({ line: 5000 }, 600), { start: 600, end: 600 });
});
