// @ts-check
/**
 * watchyourclankers — store.js
 * In-memory reactive store fed by client.js. THE state seam for all views.
 *
 * ============================================================================
 *  PUBLIC API  (W2/W3 views — ide.js / mosaic.js — code to THIS, not to client.js)
 * ============================================================================
 *
 *   const store = createStore();
 *
 *   // --- wiring (app.js does this once; views never call these) ---
 *   store.connectClient(client)   // hand it the client from client.js; store wires
 *                                 // itself as that client's handlers and owns the socket.
 *                                 // ALSO exposes it as store.client (views resolve it).
 *   //   OR feed events manually (tests):
 *   store.applyHello(msg) / store.applySnapshot(msg) / store.applyActivity(act)
 *   store.applyTerminal(term) / store.applyScreen(scr)
 *   store.applySession(sess) / store.applyThread(th)
 *   store.setStatus('connecting'|'live'|'reconnecting'|'closed')
 *
 *   // --- subscription (views) ---
 *   const unsub = store.subscribe(fn)   // fn(state) on ANY change, rAF-batched
 *                                       // (coalesces a burst into ONE call/frame).
 *                                       // returns an unsubscribe fn.
 *   store.getState()                    // -> the live State object (see SHAPE below).
 *                                       // Treat as READ-ONLY; never mutate it.
 *
 *   // --- selectors (cheap, derive from state) ---
 *   store.threadsList()                 // Thread[]  ordered by updated_at desc
 *   store.sessionsForThread(threadId)   // Session[] in the thread's handoff order
 *                                       //   (thread.session_ids oldest->newest)
 *   store.activitiesForSession(sId)     // Activity[] oldest->newest (bounded ring)
 *   store.terminalForSession(sId)       // TerminalBuf[] one per bash activity seq,
 *                                       //   each {ref_seq, command, chunks[], done,
 *                                       //          exit_code, ts} — see SHAPE.
 *   store.sessionsList()                // Session[] all known, busy-first then name
 *   store.session(sId) / store.thread(tId)   // single lookups, or undefined
 *   store.activity(seq)                 // single Activity by its global seq, or undefined
 *   store.terminalForActivity(sId, refSeq)   // the one TerminalBuf for a bash seq
 *   store.screenForSession(sId)         // latest Screen frame {seq,data,cols,rows,ts} or null
 *                                       //   (only sessions a client is actively watching)
 *
 * ============================================================================
 *  STATE SHAPE  (store.getState())  — plain objects, Maps for keyed collections
 * ============================================================================
 *
 *   State = {
 *     status:   'connecting'|'live'|'reconnecting'|'closed',  // connection status
 *     hello:    { server_ts, protocol, redaction } | null,    // last hello
 *     lastSeq:  number,            // highest server seq applied (gap detector)
 *     serverTs: number,            // last server_ts seen
 *     gaps:     number,            // count of detected seq gaps (debug)
 *     resyncs:  number,            // count of resync requests issued
 *     threads:  Map<id, Thread>,   // schema Thread (contracts/events.schema.json)
 *     sessions: Map<id, Session>,  // schema Session
 *     // per-session bounded ring of recent activities (oldest->newest):
 *     activities: Map<sessionId, Activity[]>,     // capped at RING (default 200)
 *     // global index seq -> Activity (for terminal ref_seq correlation, scroll-to):
 *     activityBySeq: Map<seq, Activity>,          // also capped (RING * sessions-ish)
 *     // per-session terminal buffers, keyed by the bash Activity's seq:
 *     terminals: Map<sessionId, Map<refSeq, TerminalBuf>>,
 *     // latest raw tmux pane frame per watched session (bounded; newest-wins):
 *     screens: Map<sessionId, Screen>,            // capped at SCREEN_MAX
 *   }
 *
 *   Thread / Session / Activity = exactly the schema dataclass shapes
 *     (see contracts/events.schema.json $defs). Stored verbatim from the wire.
 *
 *   TerminalBuf = {                 // one shell command + its (possibly chunked) output
 *     ref_seq:   number,            // == the bash Activity.seq it belongs to
 *     session_id: string,
 *     command:   string|null,       // pulled from the bash Activity.detail (if known)
 *     chunks:    string[],          // ordered output chunks (ANSI may be present)
 *     text:      string,            // chunks joined (convenience for renderers)
 *     stream:    string,            // last chunk's stream (stdout|stderr|mixed)
 *     done:      boolean,           // true once a terminal chunk with done:true arrived
 *     exit_code: number|null,
 *     ts:        number,            // last update ts
 *   }
 *
 * ============================================================================
 *  VIEW MOUNT CONVENTION  (W2/W3 honor this; W1 debug.js is the reference impl)
 * ============================================================================
 *   Each view module default-exports a `mount(el, store)` function:
 *       export function mount(el, store) { ...; return { destroy() {...} }; }
 *   - `el`    : the DOM element to render into (the view owns its subtree only).
 *   - `store` : this store. The view calls store.subscribe(render) and reads via
 *               selectors / getState(); it MUST treat state as read-only.
 *   - render  : MUST be O(1)-ish per change — append-only DOM where possible,
 *               NOT a full re-render (Principle VII). subscribe() is already
 *               rAF-batched, so one render runs per frame regardless of burst.
 *   - returns : an object with destroy() that unsubscribes + removes DOM, so the
 *               mosaic (W3) can swap/unmount tiles cleanly.
 *
 *  app.js (W1) mounts debug.js; W2/W3 swap in ide.js / mosaic.js but keep this
 *  exact shell + store API.
 * ============================================================================
 */

const RING = 200; // per-session bounded activity ring (Principle VI: drop-slow on edits/term)
const SCREEN_MAX = 64; // max sessions we retain a latest-screen frame for (bounded map)
const TERM_BUFS = 64; // per-session bounded terminal-buffer map (newest commands; the
                      // renderer shows only the latest, older are unreachable scrollback)

/** @returns {object} the store */
export function createStore() {
  /** @type {any} */
  const state = {
    status: 'connecting',
    hello: null,
    lastSeq: 0,
    serverTs: 0,
    gaps: 0,
    resyncs: 0,
    threads: new Map(),
    sessions: new Map(),
    activities: new Map(),
    activityBySeq: new Map(),
    terminals: new Map(),
    screens: new Map(),
  };

  /** @type {any} */
  let boundClient = null; // the client.js instance, exposed as store.client for views

  /** @type {Set<Function>} */
  const subs = new Set();
  let rafPending = false;
  let dirty = false;

  // rAF-batch notifications: a burst of events => exactly one render per frame.
  function notify() {
    dirty = true;
    if (rafPending) return;
    rafPending = true;
    const flush = () => {
      rafPending = false;
      if (!dirty) return;
      dirty = false;
      for (const fn of subs) {
        try { fn(state); } catch (e) { console.error('[store] subscriber threw', e); }
      }
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
    else setTimeout(flush, 16);
  }

  // ---- seq bookkeeping (drives gap detection in client.js via onStatus/getState)
  function bumpSeq(seq) {
    if (typeof seq === 'number' && seq > state.lastSeq) state.lastSeq = seq;
  }

  // ---------------------------------------------------------------- ring helpers
  function pushActivity(act) {
    if (!act || typeof act.session_id !== 'string') return;
    // global seq index (capped opportunistically)
    if (typeof act.seq === 'number') {
      state.activityBySeq.set(act.seq, act);
      if (state.activityBySeq.size > RING * 40) {
        // drop the oldest ~10% by insertion order (Map preserves it)
        const drop = Math.floor(state.activityBySeq.size * 0.1);
        let i = 0;
        for (const k of state.activityBySeq.keys()) {
          state.activityBySeq.delete(k);
          if (++i >= drop) break;
        }
      }
    }
    let ring = state.activities.get(act.session_id);
    if (!ring) { ring = []; state.activities.set(act.session_id, ring); }
    // de-dup / status-upgrade: an Activity may arrive twice (start then ok/error)
    // with the same seq; replace in place rather than appending a dup.
    if (typeof act.seq === 'number' && ring.length) {
      const last = ring[ring.length - 1];
      if (last && last.seq === act.seq) { ring[ring.length - 1] = act; return; }
      // rarely out-of-tail update; scan a short window from the end
      for (let i = ring.length - 2; i >= 0 && i >= ring.length - 8; i--) {
        if (ring[i].seq === act.seq) { ring[i] = act; return; }
      }
    }
    ring.push(act);
    if (ring.length > RING) ring.splice(0, ring.length - RING);
  }

  function termBufFor(sessionId, refSeq) {
    let perSession = state.terminals.get(sessionId);
    if (!perSession) { perSession = new Map(); state.terminals.set(sessionId, perSession); }
    let buf = perSession.get(refSeq);
    if (!buf) {
      // command text: best-effort from the bash Activity we already have
      const act = state.activityBySeq.get(refSeq);
      buf = {
        ref_seq: refSeq,
        session_id: sessionId,
        command: act && typeof act.detail === 'string' ? act.detail : null,
        chunks: [],
        text: '',
        stream: 'mixed',
        done: false,
        exit_code: null,
        ts: 0,
      };
      perSession.set(refSeq, buf);
      // BOUND the per-session buffer map (mirrors the activity ring / screen map):
      // keep only the most-recent TERM_BUFS commands. Map preserves insertion order
      // and ref_seq is monotonic, so the front keys are the oldest commands. The
      // renderer shows only the latest, so evicted buffers are unreachable scrollback.
      if (perSession.size > TERM_BUFS) {
        let drop = perSession.size - TERM_BUFS;
        for (const k of perSession.keys()) { perSession.delete(k); if (--drop <= 0) break; }
      }
    }
    return buf;
  }

  // ---------------------------------------------------------------- apply: wire -> state
  function applyHello(m) {
    state.hello = { server_ts: m.server_ts, protocol: m.protocol, redaction: !!m.redaction };
    state.serverTs = m.server_ts || state.serverTs;
    notify();
  }

  // Full re-hydrate. Replaces threads+sessions wholesale; folds in `recent`.
  // Snapshot is authoritative for thread/session membership; we KEEP existing
  // per-session activity rings & terminal buffers (warm) and just merge `recent`.
  function applySnapshot(m) {
    bumpSeq(m.seq);
    state.serverTs = m.server_ts || state.serverTs;

    const threads = new Map();
    for (const t of m.threads || []) threads.set(t.id, t);
    state.threads = threads;

    const sessions = new Map();
    for (const s of m.sessions || []) sessions.set(s.id, s);
    state.sessions = sessions;

    // Fold the warm-start tail. Older snapshots after a resync may resend
    // activities we already have; pushActivity de-dups by seq.
    for (const a of m.recent || []) {
      bumpSeq(a.seq);
      pushActivity(a);
    }
    notify();
  }

  function applyActivity(act) {
    if (!act) return;
    bumpSeq(act.seq);
    pushActivity(act);
    // if this bash activity already has a terminal buffer waiting, backfill command
    if (typeof act.seq === 'number') {
      const per = state.terminals.get(act.session_id);
      const buf = per && per.get(act.seq);
      if (buf && buf.command == null && typeof act.detail === 'string') buf.command = act.detail;
    }
    notify();
  }

  function applyTerminal(term) {
    if (!term || typeof term.session_id !== 'string') return;
    bumpSeq(term.seq);
    const buf = termBufFor(term.session_id, term.ref_seq);
    if (typeof term.data === 'string' && term.data.length) {
      buf.chunks.push(term.data);
      buf.text += term.data;
    }
    if (term.stream) buf.stream = term.stream;
    if (term.done) buf.done = true;
    if (typeof term.exit_code === 'number') buf.exit_code = term.exit_code;
    buf.ts = term.ts || buf.ts;
    notify();
  }

  // Latest raw tmux pane frame per session (newest-wins). We only keep the most
  // recent frame per session (the TUI is a full-screen mirror — older frames are
  // superseded), in a bounded map so a long-lived watcher can't grow unbounded.
  function applyScreen(screen) {
    if (!screen || typeof screen.session_id !== 'string') return;
    bumpSeq(screen.seq);
    const prev = state.screens.get(screen.session_id);
    // ignore out-of-order/duplicate frames (keep the highest seq)
    if (prev && typeof prev.seq === 'number' && typeof screen.seq === 'number'
        && screen.seq < prev.seq) return;
    // re-insert at the tail (Map keeps insertion order) so eviction drops the
    // least-recently-updated session.
    if (prev) state.screens.delete(screen.session_id);
    state.screens.set(screen.session_id, screen);
    if (state.screens.size > SCREEN_MAX) {
      const oldest = state.screens.keys().next().value;
      if (oldest !== undefined) state.screens.delete(oldest);
    }
    notify();
  }

  function applySession(s) {
    if (!s || typeof s.id !== 'string') return;
    state.sessions.set(s.id, s);
    notify();
  }

  function applyThread(th) {
    if (!th || typeof th.id !== 'string') return;
    state.threads.set(th.id, th);
    notify();
  }

  function setStatus(s) {
    if (state.status === s) return;
    state.status = s;
    notify();
  }

  // debug counters (driven by client.js gap/resync detection)
  function noteGap() { state.gaps += 1; notify(); }
  function noteResync() { state.resyncs += 1; notify(); }

  // ---------------------------------------------------------------- client wiring
  // Wire this store as the client's handler bundle. The client owns the socket
  // and gap-recovery; the store just applies typed events + tracks lastSeq.
  // gap detection on the client reads store.getState().lastSeq.
  function connectClient(client) {
    boundClient = client; // expose for views (store.client); see resolution in ide.js/mosaic.js
    client.connect({
      onHello: applyHello,
      onSnapshot: applySnapshot,
      onActivity: applyActivity,
      onTerminal: applyTerminal,
      onScreen: applyScreen,
      onSession: applySession,
      onThread: applyThread,
      onStatus: setStatus,
      onGap: noteGap,
      onResync: noteResync,
    });
    return client;
  }

  // ---------------------------------------------------------------- subscription
  function subscribe(fn) {
    subs.add(fn);
    return () => subs.delete(fn);
  }

  // ---------------------------------------------------------------- selectors
  function threadsList() {
    return [...state.threads.values()].sort(
      (a, b) => (b.updated_at || 0) - (a.updated_at || 0)
    );
  }

  function sessionsForThread(threadId) {
    const th = state.threads.get(threadId);
    if (!th) return [];
    const ids = th.session_ids && th.session_ids.length
      ? th.session_ids
      : [...state.sessions.values()].filter(s => s.thread_id === threadId).map(s => s.id);
    const out = [];
    for (const id of ids) {
      const s = state.sessions.get(id);
      if (s) out.push(s);
    }
    return out; // oldest -> newest (handoff chain order)
  }

  const STATUS_RANK = { busy: 0, idle: 1, ended: 2 };
  function sessionsList() {
    return [...state.sessions.values()].sort((a, b) => {
      const r = (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3);
      if (r) return r;
      return String(a.name || a.id).localeCompare(String(b.name || b.id));
    });
  }

  function activitiesForSession(sessionId) {
    return state.activities.get(sessionId) || [];
  }

  function terminalForSession(sessionId) {
    const per = state.terminals.get(sessionId);
    if (!per) return [];
    return [...per.values()].sort((a, b) => a.ref_seq - b.ref_seq);
  }

  function terminalForActivity(sessionId, refSeq) {
    const per = state.terminals.get(sessionId);
    return per ? per.get(refSeq) : undefined;
  }

  // Latest raw tmux pane frame for a session, or null. Shape: the Screen $def
  // ({seq,ts,session_id,thread_id,data,cols,rows}); views read {seq,data,cols,rows}.
  function screenForSession(sessionId) {
    return state.screens.get(sessionId) || null;
  }

  return {
    // wiring / apply
    connectClient, applyHello, applySnapshot, applyActivity, applyTerminal,
    applyScreen, applySession, applyThread, setStatus, noteGap, noteResync,
    // subscription
    subscribe, getState: () => state,
    // the client.js instance (set by connectClient). Views resolve it as a plain
    // property; ide.js also tolerates a function form, so expose both shapes.
    get client() { return boundClient; },
    // selectors
    threadsList, sessionsForThread, sessionsList, activitiesForSession,
    terminalForSession, terminalForActivity, screenForSession,
    session: (id) => state.sessions.get(id),
    thread: (id) => state.threads.get(id),
    activity: (seq) => state.activityBySeq.get(seq),
  };
}

export default createStore;
