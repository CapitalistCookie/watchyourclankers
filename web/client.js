// @ts-check
/**
 * watchyourclankers — client.js
 * The WebSocket client. Implements SNAPSHOT-THEN-STREAM + seq-gap recovery
 * (constitution Principle VI) and exponential-backoff reconnect.
 *
 * Wire protocol: contracts/events.schema.json (mirrored in wyc/contract.py).
 *   server -> client : hello, snapshot, activity, terminal, session_update, thread_update
 *   client -> server : subscribe, resync, annotate, thread_override
 *
 * SEQ LOCATIONS (important — seq lives in different places per message type):
 *   snapshot        -> m.seq            (top-level)
 *   session_update  -> m.seq            (top-level)
 *   thread_update   -> m.seq            (top-level)
 *   activity        -> m.activity.seq   (nested)
 *   terminal        -> m.terminal.seq   (nested)
 *   hello           -> (no seq)
 *
 * GAP RECOVERY: we track lastSeq = highest server seq applied. For any streamed
 * message whose seq > lastSeq + 1 we have missed events -> send
 * {t:'resync', v:1, since:lastSeq}; the server replies with a fresh snapshot
 * (re-hydrate). On socket close we exponential-backoff reconnect and the server
 * sends hello + snapshot afresh, so reconnect == re-hydrate. We DROP NOTHING on
 * the client (the server drop-slows high-rate surfaces per Principle VI).
 *
 * PUBLIC API:
 *   const client = createClient({ url?, token?, protocolVersion? });
 *   client.connect({ onHello, onSnapshot, onActivity, onTerminal, onSession,
 *                    onThread, onStatus, onGap?, onResync? });   // begins connecting
 *     onGap({from,to,missed})  fired when a forward seq gap is detected (debug counter)
 *     onResync({since})        fired when a resync request is issued (debug counter)
 *   client.send(obj)              // raw client->server envelope (adds v if absent)
 *   client.subscribe(scope)       // {t:'subscribe', scope}  ('all'|thread:<id>|session:<id>)
 *   client.resync()               // force a resync from current lastSeq
 *   client.annotate(action,target)// stub write path (server-side stub in slice 1)
 *   client.threadOverride(op,args)// operator stitch correction
 *   client.close()                // stop reconnecting + close socket
 *   client.lastSeq()              // current highest applied seq
 *   client.status()               // 'connecting'|'live'|'reconnecting'|'closed'
 *
 * onStatus(s) receives: 'connecting' | 'live' | 'reconnecting' | 'closed'.
 */

import { PROTOCOL_VERSION, resolveToken, wsUrl } from './app-config.js';

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 15000;

/**
 * @param {{url?:string, token?:string, protocolVersion?:number}} [opts]
 */
export function createClient(opts = {}) {
  const protocolVersion = opts.protocolVersion || PROTOCOL_VERSION;
  let token = opts.token != null ? opts.token : resolveToken();
  let url = opts.url || wsUrl(token);

  /** @type {WebSocket|null} */
  let ws = null;
  /** @type {any} */
  let h = {};
  let lastSeq = 0;
  let status = 'connecting';
  let backoff = BACKOFF_BASE_MS;
  let reconnectTimer = null;
  let closedByUser = false;
  let resyncInFlight = false;

  function setStatus(s) {
    if (status === s) return;
    status = s;
    if (typeof h.onStatus === 'function') {
      try { h.onStatus(s); } catch (e) { console.error('[client] onStatus threw', e); }
    }
  }

  function callHandler(name, arg) {
    const fn = h[name];
    if (typeof fn === 'function') {
      try { fn(arg); } catch (e) { console.error(`[client] ${name} threw`, e); }
    }
  }

  // ---- gap detection ---------------------------------------------------------
  // Returns true if a streamed seq is contiguous OR a (harmless) replay (<= lastSeq);
  // returns false (and triggers resync) when there's a forward gap.
  function checkSeq(seq) {
    if (typeof seq !== 'number') return true; // hello etc.
    if (seq <= lastSeq) return true;          // duplicate/replay — fine, idempotent appliers
    if (seq === lastSeq + 1) { lastSeq = seq; return true; } // contiguous
    // forward gap: missed [lastSeq+1 .. seq-1]
    callHandler('onGap', { from: lastSeq, to: seq, missed: seq - lastSeq - 1 });
    requestResync();
    // still advance + apply this message (snapshot-then-stream stays self-healing:
    // the resync snapshot will reconcile membership; appliers are idempotent).
    lastSeq = seq;
    return false;
  }

  function requestResync() {
    if (resyncInFlight) return;
    resyncInFlight = true;
    callHandler('onResync', { since: lastSeq });
    send({ t: 'resync', since: lastSeq });
    // clear the in-flight guard once a fresh snapshot lands (see onmessage),
    // or after a short timeout so we can re-ask if it never arrives.
    setTimeout(() => { resyncInFlight = false; }, 4000);
  }

  // ---- socket lifecycle ------------------------------------------------------
  function open() {
    if (closedByUser) return;
    setStatus(lastSeq > 0 ? 'reconnecting' : 'connecting');
    try {
      ws = new WebSocket(url);
    } catch (e) {
      console.error('[client] WebSocket ctor failed', e);
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      backoff = BACKOFF_BASE_MS;
      // subscribe to everything by default; the server will send hello + snapshot.
      send({ t: 'subscribe', scope: 'all' });
      // If we're reconnecting with prior state, proactively ask for a resync so
      // we re-hydrate even if the server's auto-snapshot races our subscribe.
      if (lastSeq > 0) send({ t: 'resync', since: lastSeq });
    };

    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) {
        console.error('[client] bad JSON', e);
        return;
      }
      if (!m || typeof m.t !== 'string') return;
      route(m);
    };

    ws.onerror = (e) => {
      // onclose follows; just log.
      console.warn('[client] socket error', e && e.message ? e.message : e);
    };

    ws.onclose = () => {
      ws = null;
      if (closedByUser) { setStatus('closed'); return; }
      scheduleReconnect();
    };
  }

  function route(m) {
    switch (m.t) {
      case 'hello':
        callHandler('onHello', m);
        setStatus('live');
        break;
      case 'snapshot':
        // snapshot is the hydration point: adopt its seq as our baseline.
        if (typeof m.seq === 'number') lastSeq = Math.max(lastSeq, m.seq);
        resyncInFlight = false; // a snapshot satisfies any pending resync
        callHandler('onSnapshot', m);
        setStatus('live');
        break;
      case 'activity':
        if (m.activity) { checkSeq(m.activity.seq); callHandler('onActivity', m.activity); }
        break;
      case 'terminal':
        if (m.terminal) { checkSeq(m.terminal.seq); callHandler('onTerminal', m.terminal); }
        break;
      case 'session_update':
        checkSeq(m.seq); callHandler('onSession', m.session);
        break;
      case 'thread_update':
        checkSeq(m.seq); callHandler('onThread', m.thread);
        break;
      default:
        // unknown server message type: ignore but don't crash (forward-compat).
        console.debug('[client] unknown message t=', m.t);
    }
  }

  function scheduleReconnect() {
    setStatus('reconnecting');
    if (reconnectTimer) return;
    const wait = Math.min(backoff, BACKOFF_MAX_MS);
    const jitter = Math.floor(Math.random() * 250);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      open();
    }, wait + jitter);
  }

  // ---- send ------------------------------------------------------------------
  function send(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const env = obj && obj.v != null ? obj : { ...obj, v: protocolVersion };
    try { ws.send(JSON.stringify(env)); return true; }
    catch (e) { console.error('[client] send failed', e); return false; }
  }

  // ---- public API ------------------------------------------------------------
  function connect(handlers) {
    h = handlers || {};
    closedByUser = false;
    open();
    return client;
  }

  function close() {
    closedByUser = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) { try { ws.close(); } catch (_) {} ws = null; }
    setStatus('closed');
  }

  const client = {
    connect,
    close,
    send,
    subscribe: (scope) => send({ t: 'subscribe', scope: scope || 'all' }),
    resync: () => { resyncInFlight = false; requestResync(); },
    annotate: (action, target) => send({ t: 'annotate', action, target: target || {} }),
    threadOverride: (op, args) => send({ t: 'thread_override', op, args: args || {} }),
    lastSeq: () => lastSeq,
    status: () => status,
    // for tests / introspection:
    _setUrl: (u) => { url = u; },
    _setToken: (t) => { token = t; url = wsUrl(t); },
  };
  return client;
}

export default createClient;
