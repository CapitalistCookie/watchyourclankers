// @ts-check
/**
 * watchyourclankers — app.js  (W1 entry / integration shell)
 * Bootstraps: resolve token -> create store -> create client -> wire client to
 * store -> mount the active view (debug.js for W1) -> render a connection-status
 * indicator. W2/W3 swap the mounted view (ide.js / mosaic.js) but KEEP this shell
 * pattern and the store API.
 */

import { createStore } from './store.js';
import { createClient } from './client.js';
import { resolveToken } from './app-config.js';
import { mount as mountDebug } from './debug.js';

const STATUS_TEXT = {
  connecting: 'connecting',
  live: 'live',
  reconnecting: 'reconnecting',
  closed: 'offline',
};

function header() {
  const hdr = document.createElement('header');
  hdr.className = 'wyc-header';

  const brand = document.createElement('div');
  brand.className = 'wyc-brand';
  brand.innerHTML = '<span class="watch">watch</span><span class="clankers">yourclankers</span>';

  const spacer = document.createElement('div');
  spacer.className = 'wyc-spacer';

  const metric = document.createElement('span');
  metric.className = 'wyc-metric';
  metric.id = 'wyc-metric';

  const conn = document.createElement('div');
  conn.className = 'wyc-conn';
  conn.id = 'wyc-conn';
  conn.setAttribute('data-status', 'connecting');
  const dot = document.createElement('span');
  dot.className = 'dot';
  const label = document.createElement('span');
  label.id = 'wyc-conn-label';
  label.textContent = STATUS_TEXT.connecting;
  conn.append(dot, label);

  hdr.append(brand, spacer, metric, conn);
  return { hdr, conn, label, metric };
}

function boot() {
  const appEl = document.getElementById('app');
  if (!appEl) { console.error('[app] #app not found'); return; }

  // shell: header + view mount point
  const { hdr, conn, label, metric } = header();
  const viewEl = document.createElement('div');
  viewEl.id = 'wyc-view';
  viewEl.style.flex = '1 1 auto';
  viewEl.style.minHeight = '0';
  viewEl.style.display = 'flex';
  appEl.append(hdr, viewEl);

  // token -> store -> client
  const token = resolveToken();
  if (!token) console.warn('[app] no token resolved; server will likely reject /ws');

  const store = createStore();
  const client = createClient({ token });

  // connection-status indicator driven off the store's status
  let lastStatus = null;
  store.subscribe((state) => {
    if (state.status === lastStatus) return;
    lastStatus = state.status;
    conn.setAttribute('data-status', state.status);
    label.textContent = STATUS_TEXT[state.status] || state.status;
  });

  // lightweight live metric (seq + counts) in the header
  store.subscribe((state) => {
    const sess = state.sessions.size;
    const thr = state.threads.size;
    metric.textContent = `seq ${state.lastSeq} · ${sess}s/${thr}t`
      + (state.gaps ? ` · ${state.gaps} gaps` : '')
      + (state.resyncs ? ` · ${state.resyncs} resync` : '');
  });

  // wire client -> store (store installs itself as the client's handler bundle)
  store.connectClient(client);

  // mount the active view (W1: debug; W2/W3 replace this line)
  const view = mountDebug(viewEl, store);

  // expose for console debugging / future hot-swap
  /** @type {any} */ (window).wyc = { store, client, view };
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}

export { boot };
