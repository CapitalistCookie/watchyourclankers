// @ts-check
/**
 * watchyourclankers — app.js  (entry / integration shell)
 * Bootstraps: resolve token -> create store -> create client -> wire client to
 * store -> expose window.wyc + store.client -> mount the active view -> render a
 * connection-status indicator.
 *
 * VIEW SELECTION: defaults to the W3 mosaic (mosaic.js). A `?view=debug` query
 * param (or localStorage 'wyc.view' === 'debug') mounts the W1 debug view instead
 * — a low-level fallback that needs no CDN and shows the raw event stream. Any
 * other explicit value ('mosaic'/'ide-less'…) maps back to mosaic.
 *
 * The client is exposed on BOTH window.wyc.client and store.client BEFORE the
 * view mounts, because panes (ide.js / mosaic.js + menu.js) resolve the client at
 * mount time (mosaic constructs its menu with client: getClient()).
 */

import { createStore } from './store.js';
import { createClient } from './client.js';
import { resolveToken } from './app-config.js';
import mountMosaic from './mosaic.js';
import { mount as mountDebug } from './debug.js';

// Which view to mount: 'debug' (fallback) vs 'mosaic' (default). Honors
// ?view=debug then localStorage 'wyc.view'.
function resolveView() {
  try {
    if (typeof location !== 'undefined' && location.search) {
      const v = new URLSearchParams(location.search).get('view');
      if (v) return v === 'debug' ? 'debug' : 'mosaic';
    }
  } catch (_) {}
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('wyc.view') === 'debug') {
      return 'debug';
    }
  } catch (_) {}
  return 'mosaic';
}

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

  // wire client -> store (store installs itself as the client's handler bundle
  // AND exposes it as store.client). ide.js resolves the client off store.client.
  store.connectClient(client);

  // expose for console debugging / future hot-swap. MUST be set BEFORE mounting
  // the view: mosaic.js (and its menu.js) resolve the client via window.wyc.client
  // at mount time. `view` is filled in immediately after mounting.
  /** @type {any} */
  const wyc = { store, client, view: null };
  /** @type {any} */ (window).wyc = wyc;

  // mount the active view: mosaic (default) with a debug fallback (?view=debug or
  // localStorage 'wyc.view'='debug').
  const which = resolveView();
  let view;
  try {
    view = which === 'debug' ? mountDebug(viewEl, store) : mountMosaic(viewEl, store);
  } catch (e) {
    console.error(`[app] mounting ${which} view failed; falling back to debug`, e);
    viewEl.innerHTML = '';
    try { view = mountDebug(viewEl, store); } catch (e2) { console.error('[app] debug fallback failed too', e2); }
  }
  wyc.view = view;
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}

export { boot };
