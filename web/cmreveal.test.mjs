// node --test — behavior of the PURE CodeMirror reveal-plan (Spec 004 increment 3).
// The plan must, when applied exactly as ide.js applies it (setState(initialDoc),
// then replace [from, from+prevLen] with each step), reconstruct fullDoc CHAR-by-
// CHAR — never snap. Red-first per the interaction-guard discipline (LESSONS L5/L7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cmRevealPlan } from './cmreveal.js';

// Simulate ide.js's application of the plan to a plain string (what CM does to the
// doc via transactions: each step replaces the growing region at `from`).
function applyPlan(plan) {
  let doc = plan.initialDoc;
  let prev = 0;
  for (const step of plan.steps) {
    doc = doc.slice(0, plan.from) + step + doc.slice(plan.from + prev);
    prev = step.length;
  }
  return doc;
}

const DOC = 'line0\nline1\nline2\nline3\nline4';

test('initialDoc is the full doc with the hunk region emptied', () => {
  const p = cmRevealPlan(DOC, 2, 3); // lines 1..2 (0-based) = "line1\nline2"
  assert.equal(p.hunkText, 'line1\nline2');
  assert.equal(p.initialDoc, DOC.slice(0, p.from) + DOC.slice(p.to));
  assert.ok(!p.initialDoc.includes('line1\nline2'), 'hunk region must be absent initially');
});

test('applying the plan reconstructs fullDoc EXACTLY (middle hunk)', () => {
  const p = cmRevealPlan(DOC, 2, 3);
  assert.equal(applyPlan(p), DOC);
});

test('reconstructs fullDoc for a hunk at the FIRST line', () => {
  const p = cmRevealPlan(DOC, 1, 1);
  assert.equal(p.from, 0);
  assert.equal(p.hunkText, 'line0');
  assert.equal(applyPlan(p), DOC);
});

test('reconstructs fullDoc for a hunk at the LAST line', () => {
  const p = cmRevealPlan(DOC, 5, 5);
  assert.equal(p.hunkText, 'line4');
  assert.equal(applyPlan(p), DOC);
});

test('reconstructs fullDoc for a single-line hunk in the middle', () => {
  const p = cmRevealPlan(DOC, 3, 3);
  assert.equal(p.hunkText, 'line2');
  assert.equal(applyPlan(p), DOC);
});

test('char mode: steps grow by exactly one char and end at hunkText', () => {
  const p = cmRevealPlan(DOC, 2, 2); // "line1", small -> char mode
  assert.equal(p.steps[p.steps.length - 1], 'line1');
  for (let i = 0; i < p.steps.length; i++) {
    assert.equal(p.steps[i].length, i + 1, 'each step adds exactly one char');
    assert.ok('line1'.startsWith(p.steps[i]), 'each step is a growing prefix of the hunk');
  }
});

test('steps are monotonic non-decreasing in length (never snap-then-shrink)', () => {
  const p = cmRevealPlan(DOC, 2, 4);
  let prev = 0;
  for (const s of p.steps) { assert.ok(s.length >= prev); prev = s.length; }
});

test('huge hunk reveals per-LINE (bounded steps) but still reconstructs', () => {
  // build a hunk well over CHAR_CAP (6000) so revealByLine kicks in
  const big = Array.from({ length: 400 }, (_, i) => 'x'.repeat(20) + i).join('\n');
  const doc = 'head\n' + big + '\ntail';
  const p = cmRevealPlan(doc, 2, 401); // the big block
  assert.ok(p.steps.length <= 400, 'per-line: at most one step per hunk line, not per char');
  assert.ok(p.steps.length < p.hunkText.length, 'far fewer steps than chars (line mode)');
  assert.equal(applyPlan(p), doc);
});

test('empty hunk yields no steps and initialDoc === fullDoc', () => {
  const doc = 'a\n\nb'; // line 2 is empty
  const p = cmRevealPlan(doc, 2, 2);
  assert.equal(p.hunkText, '');
  assert.equal(p.steps.length, 0);
  assert.equal(applyPlan(p), doc);
});

test('out-of-range lines are clamped, still reconstructs', () => {
  const p = cmRevealPlan(DOC, 99, 200);
  assert.equal(applyPlan(p), DOC);
});
