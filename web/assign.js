// @ts-check
/**
 * watchyourclankers — assign.js
 * The PURE, DOM-free slot-assignment decision extracted out of mosaic.js::reflow.
 *
 * Why a separate module: interaction/layout bugs live in LOGIC, not the DOM (the
 * DOM is just I/O). Extracting the decision makes it unit-testable headless and
 * deterministic via `node --test web/assign.test.mjs` — closing the "node --check
 * proves syntax, not behavior" hole (LESSONS L1/L5). It also enforces:
 *   - Principle VII (bounded render): the result is always ≤ `slots` tiles,
 *     regardless of how many threads are active.
 *   - The operator rule "ONE PANEL PER PROJECT": AUTO-assignment shows each
 *     project at most once. Two threads of the same repo never fill two auto
 *     tiles. EXPLICIT holds — pinned/frozen tiles, and operator-driven manual
 *     bindings — may still repeat a project (explicit intent wins over dedup).
 *
 * Inputs (all plain data — no DOM, no store):
 *   slots        number of visible tiles to fill
 *   mode         'focus' (follow-latest, default) | 'per-tile' | 'manual'
 *   ranked       ordered [{id, project}, ...] active threads (rank already applied)
 *   tiles        current tiles as [{threadId, pinned, frozen}, ...] (len may ≠ slots)
 *   forcedThread thread id from URL/command to pin to tile 0 (or null)
 *   editLeadId   thread id currently generating code, for tile-0 priority (or null)
 *
 * Returns { visible: (id|null)[len=slots], usedThreadIds: id[], usedProjects: key[] }.
 * `visible` holds the thread id per tile (null = empty tile). Threads in `ranked`
 * but not in `usedThreadIds` are the overflow rail (caller computes it).
 */

/**
 * Dedup key for "same project". A real (non-empty) project name collapses; an
 * unknown/empty project falls back to the thread id so two unknown-project
 * threads stay DISTINCT (never wrongly collapsed into one).
 * @param {{id?:string, project?:string|null}} t
 * @returns {string}
 */
export function projectKey(t) {
  const p = t && t.project != null ? String(t.project).trim() : '';
  return p ? 'p:' + p : 't:' + (t && t.id);
}

/**
 * @param {{slots:number, mode:string, ranked:Array<{id:string, project?:string|null}>,
 *          tiles?:Array<{threadId?:string|null, pinned?:boolean, frozen?:boolean}>,
 *          forcedThread?:string|null, editLeadId?:string|null}} opts
 */
export function assignSlots(opts) {
  const slots = Math.max(0, opts.slots | 0);
  const mode = opts.mode || 'focus';
  const ranked = opts.ranked || [];
  const tiles = opts.tiles || [];
  const forcedThread = opts.forcedThread || null;
  const editLeadId = opts.editLeadId || null;

  const byId = new Map(ranked.map((t) => [t.id, t]));
  const keyOf = (id) => {
    const t = byId.get(id);
    return t ? projectKey(t) : 't:' + id;
  };

  const visible = new Array(slots).fill(null);
  const usedThreadIds = new Set();
  const usedProjects = new Set();

  // claim a slot for a thread, recording BOTH its id and its project as used so
  // later auto-fills dedup against it.
  const claim = (i, id) => {
    visible[i] = id;
    usedThreadIds.add(id);
    usedProjects.add(keyOf(id));
  };
  // a candidate is blocked from AUTO-fill if its thread id OR its project is taken
  const blocked = (id) => usedThreadIds.has(id) || usedProjects.has(keyOf(id));

  // 1) explicit holds first: pinned/frozen tiles keep their thread, UNCONDITIONALLY
  //    (they may repeat a project — explicit intent wins). Claim them so auto-fill
  //    dedups against their projects.
  const pinnedByIdx = new Map();
  tiles.forEach((t, i) => {
    if (t && (t.pinned || t.frozen) && t.threadId && i < slots) {
      pinnedByIdx.set(i, t.threadId);
    }
  });
  for (const [i, id] of pinnedByIdx) claim(i, id);

  // helper: fill still-empty slots from an ordered candidate list, dedup-by-project
  const fillFrom = (ids) => {
    let k = 0;
    for (let i = 0; i < slots; i++) {
      if (visible[i] != null) continue;
      while (k < ids.length && blocked(ids[k])) k++;
      if (k < ids.length) { claim(i, ids[k]); k++; }
    }
  };

  if (mode === 'manual') {
    // operator drives bindings; KEEP each existing binding unconditionally (its
    // project may repeat — operator chose it), then auto-fill empties dedup'd.
    for (let i = 0; i < slots; i++) {
      if (visible[i] != null) continue; // pinned already placed
      const existing = tiles[i] && tiles[i].threadId;
      const held = tiles[i] && (tiles[i].pinned || tiles[i].frozen);
      if (existing && (byId.has(existing) || held) && !usedThreadIds.has(existing)) {
        claim(i, existing);
      }
    }
    fillFrom(ranked.map((t) => t.id));
  } else if (mode === 'per-tile') {
    // each tile keeps its thread while still active — but dedup by project (a
    // follow mode): a kept binding whose project is already shown is dropped and
    // the slot rebinds to a fresh project below.
    for (let i = 0; i < slots; i++) {
      if (visible[i] != null) continue;
      const existing = tiles[i] && tiles[i].threadId;
      if (existing && byId.has(existing) && !blocked(existing)) claim(i, existing);
    }
    fillFrom(ranked.map((t) => t.id));
  } else {
    // focus-follows-latest (default + the operator's "auto latest"): tile 0 is the
    // thread to WATCH — an explicit forced thread wins, else the freshest code-gen
    // (editLead), else the ranked head — then the rest fill by rank. ALL dedup by
    // project, so "auto latest" never shows the same project twice.
    const wanted = [];
    if (forcedThread && byId.has(forcedThread)) wanted.push(forcedThread);
    else if (editLeadId && byId.has(editLeadId)) wanted.push(editLeadId);
    for (const th of ranked) {
      if (!wanted.includes(th.id)) wanted.push(th.id);
    }
    fillFrom(wanted);
  }

  return {
    visible,
    usedThreadIds: [...usedThreadIds],
    usedProjects: [...usedProjects],
  };
}

export default assignSlots;
