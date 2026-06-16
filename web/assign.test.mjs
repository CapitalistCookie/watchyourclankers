// node --test web/assign.test.mjs
// Behavioral spec for the pure slot-assignment (web/assign.js). This is the
// enforcer for Constitution VII (bounded render) and the operator rule
// "one panel per project", and the proof that R05 is fixed (LESSONS L1/L5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignSlots, projectKey } from './assign.js';

// helpers
const T = (id, project) => ({ id, project });
const projectsOf = (visible, ranked) => {
  const by = new Map(ranked.map((t) => [t.id, t]));
  return visible.filter(Boolean).map((id) => projectKey(by.get(id)));
};
const noDupProjects = (visible, ranked) => {
  const ps = projectsOf(visible, ranked);
  return new Set(ps).size === ps.length;
};

test('ONE PANEL PER PROJECT: focus auto never shows the same project twice', () => {
  // two threads of project "yon", two distinct projects
  const ranked = [T('a', 'yon'), T('b', 'yon'), T('c', 'cotton'), T('d', 'comms')];
  const { visible } = assignSlots({ slots: 4, mode: 'focus', ranked });
  assert.ok(noDupProjects(visible, ranked), `dup project in ${JSON.stringify(visible)}`);
  // exactly one of the two "yon" threads is shown
  const yon = visible.filter((id) => id === 'a' || id === 'b');
  assert.equal(yon.length, 1, 'exactly one yon thread visible');
  // the three distinct projects are all shown (4 slots, 3 projects → 3 filled, 1 empty)
  assert.deepEqual(new Set(projectsOf(visible, ranked)), new Set(['p:yon', 'p:cotton', 'p:comms']));
});

test('the OTHER same-project threads overflow (not in usedThreadIds)', () => {
  const ranked = [T('a', 'yon'), T('b', 'yon'), T('c', 'yon')];
  const { visible, usedThreadIds } = assignSlots({ slots: 4, mode: 'focus', ranked });
  assert.equal(visible.filter(Boolean).length, 1, 'only one yon tile');
  // the two deduped-out threads are NOT used -> the caller routes them to the rail
  const overflow = ranked.filter((t) => !usedThreadIds.includes(t.id));
  assert.equal(overflow.length, 2);
});

test('Principle VII bounded render: never more than `slots`, regardless of thread count', () => {
  const ranked = Array.from({ length: 100 }, (_, i) => T('t' + i, 'proj' + i));
  for (const slots of [1, 2, 3, 4, 6, 8]) {
    const { visible } = assignSlots({ slots, mode: 'focus', ranked });
    assert.equal(visible.length, slots);
    assert.ok(visible.filter(Boolean).length <= slots);
    assert.equal(visible.filter(Boolean).length, slots, 'all slots filled when projects ≥ slots');
    assert.ok(noDupProjects(visible, ranked));
  }
});

test('fewer distinct projects than slots → trailing empties, no dups', () => {
  const ranked = [T('a', 'yon'), T('b', 'yon'), T('c', 'cotton')];
  const { visible } = assignSlots({ slots: 6, mode: 'focus', ranked });
  assert.equal(visible.filter(Boolean).length, 2, 'only 2 distinct projects → 2 tiles');
  assert.ok(noDupProjects(visible, ranked));
});

test('no thread id appears in two slots', () => {
  const ranked = [T('a', 'yon'), T('b', 'cotton'), T('c', 'comms')];
  const { visible } = assignSlots({ slots: 6, mode: 'focus', ranked });
  const ids = visible.filter(Boolean);
  assert.equal(new Set(ids).size, ids.length);
});

test('unknown/empty-project threads stay DISTINCT (not collapsed)', () => {
  const ranked = [T('a', null), T('b', ''), T('c', undefined)];
  const { visible } = assignSlots({ slots: 4, mode: 'focus', ranked });
  // all three have no real project → keyed by id → all three can show
  assert.equal(visible.filter(Boolean).length, 3);
});

test('forced thread takes tile 0 (when active)', () => {
  const ranked = [T('a', 'yon'), T('b', 'cotton'), T('c', 'comms')];
  const { visible } = assignSlots({ slots: 3, mode: 'focus', ranked, forcedThread: 'c' });
  assert.equal(visible[0], 'c');
});

test('editLead takes tile 0 when no forced thread', () => {
  const ranked = [T('a', 'yon'), T('b', 'cotton'), T('c', 'comms')];
  const { visible } = assignSlots({ slots: 3, mode: 'focus', ranked, editLeadId: 'b' });
  assert.equal(visible[0], 'b');
});

test('EXPLICIT pins may repeat a project (intent wins over dedup)', () => {
  // operator pinned two tiles to two different threads of the same project
  const ranked = [T('a', 'yon'), T('b', 'yon'), T('c', 'cotton')];
  const tiles = [
    { threadId: 'a', pinned: true },
    { threadId: 'b', pinned: true },
    { threadId: null },
  ];
  const { visible } = assignSlots({ slots: 3, mode: 'focus', ranked, tiles });
  assert.equal(visible[0], 'a');
  assert.equal(visible[1], 'b'); // both yon pins honored
  assert.equal(visible[2], 'c'); // auto-fill picks the distinct project
});

test('a pinned project blocks an AUTO tile from duplicating it', () => {
  const ranked = [T('a', 'yon'), T('b', 'yon'), T('c', 'cotton')];
  const tiles = [{ threadId: 'a', pinned: true }, { threadId: null }, { threadId: null }];
  const { visible } = assignSlots({ slots: 3, mode: 'focus', ranked, tiles });
  assert.equal(visible[0], 'a');
  // tile 1/2 must NOT show 'b' (same project as pinned 'a'); only 'cotton' remains
  assert.ok(!visible.includes('b'), 'auto tile must not duplicate the pinned yon project');
  assert.ok(visible.includes('c'));
});

test('manual mode KEEPS operator bindings even if a project repeats', () => {
  const ranked = [T('a', 'yon'), T('b', 'yon')];
  const tiles = [{ threadId: 'a' }, { threadId: 'b' }];
  const { visible } = assignSlots({ slots: 2, mode: 'manual', ranked, tiles });
  assert.deepEqual(visible, ['a', 'b']); // operator drove both; both kept
});

test('per-tile mode DEDUPS a kept binding whose project is already shown', () => {
  const ranked = [T('a', 'yon'), T('b', 'yon'), T('c', 'cotton')];
  const tiles = [{ threadId: 'a' }, { threadId: 'b' }, { threadId: null }];
  const { visible } = assignSlots({ slots: 3, mode: 'per-tile', ranked, tiles });
  assert.equal(visible[0], 'a');
  assert.ok(!visible.includes('b'), 'per-tile drops the second yon');
  assert.ok(visible.includes('c'));
});
