// @ts-check
/**
 * watchyourclankers — app-config.js
 * Shared client configuration: protocol version + local-token resolution + the
 * /ws URL builder. Kept tiny + dependency-free so both client.js and app.js use
 * the same logic (and so it's unit-checkable without a DOM).
 *
 * The server binds 127.0.0.1:8900 and requires a local token (Principle II).
 *
 * TOKEN RESOLUTION ORDER:
 *   1. URL query  ?token=...                       (shareable launch link)
 *   2. injected   <meta name="wyc-token" content>  or window.WYC_TOKEN  (server-injected)
 *   3. localStorage 'wyc.token'                     (remembered from a prior visit)
 *   4. prompt() once, then persist to localStorage  (interactive fallback)
 * A token found in (1) or (2) is persisted to localStorage so refreshes keep working.
 */

export const PROTOCOL_VERSION = 1;
export const TOKEN_STORAGE_KEY = 'wyc.token';

const hasWindow = typeof window !== 'undefined';
const hasDoc = typeof document !== 'undefined';

/**
 * The mount root the app is served under — '/' standalone, '/wyc/' when clanker
 * `add_subapp`'s it (Spec: merge into clanker, keep standalone). Derived from THIS
 * module's own URL (served at `<BASE>static/app-config.js`), so every same-origin
 * URL (ws, /file, …) can be built prefix-correctly without the server rewriting
 * anything. Falls back to '/' under node (file:// import) or if undeterminable.
 * Always ends with '/'.
 */
export const BASE = (() => {
  try {
    const here = new URL('.', import.meta.url).pathname;   // <BASE>static/
    const m = here.match(/^(.*\/)static\/$/);
    if (m) return m[1];                                     // <BASE>
  } catch (_) { /* node file:// or no import.meta — fall through */ }
  if (hasWindow && window.location && typeof window.location.pathname === 'string') {
    return window.location.pathname.replace(/[^/]*$/, '') || '/';  // dir of the doc
  }
  return '/';
})();

/**
 * Build a same-origin HTTP URL for an app route under BASE.
 * @param {string} path e.g. 'file' or 'hook' (leading slash optional)
 */
export function apiUrl(path) {
  return BASE + String(path == null ? '' : path).replace(/^\//, '');
}

function fromQuery() {
  if (!hasWindow || !window.location) return null;
  try {
    const u = new URL(window.location.href);
    return u.searchParams.get('token') || null;
  } catch (_) { return null; }
}

function fromInjected() {
  if (hasWindow && typeof window.WYC_TOKEN === 'string' && window.WYC_TOKEN) {
    return window.WYC_TOKEN;
  }
  if (hasDoc) {
    const meta = document.querySelector('meta[name="wyc-token"]');
    const v = meta && meta.getAttribute('content');
    if (v && v !== '__WYC_TOKEN__') return v; // ignore an un-substituted placeholder
  }
  return null;
}

function fromStorage() {
  if (!hasWindow || !window.localStorage) return null;
  try { return window.localStorage.getItem(TOKEN_STORAGE_KEY) || null; }
  catch (_) { return null; }
}

function persist(token) {
  if (!token || !hasWindow || !window.localStorage) return;
  try { window.localStorage.setItem(TOKEN_STORAGE_KEY, token); } catch (_) {}
}

/**
 * Resolve the local auth token. Side effect: persists a query/injected token.
 * @param {{allowPrompt?:boolean}} [opts] allowPrompt defaults to true.
 * @returns {string} the token (may be '' if unavailable / declined).
 */
export function resolveToken(opts = {}) {
  const allowPrompt = opts.allowPrompt !== false;

  let t = fromQuery();
  if (t) { persist(t); return t; }

  t = fromInjected();
  if (t) { persist(t); return t; }

  t = fromStorage();
  if (t) return t;

  if (allowPrompt && hasWindow && typeof window.prompt === 'function') {
    t = window.prompt('watchyourclankers — local access token:') || '';
    if (t) persist(t);
    return t;
  }
  return '';
}

/**
 * Build the WebSocket URL for /ws on the same host the page was served from.
 * ws:// for http, wss:// for https.
 * @param {string} token
 * @returns {string}
 */
export function wsUrl(token) {
  let host = 'localhost:8900';
  let scheme = 'ws';
  if (hasWindow && window.location && window.location.host) {
    host = window.location.host;
    scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  }
  const q = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${scheme}://${host}${BASE}ws${q}`;
}

export function clearToken() {
  if (hasWindow && window.localStorage) {
    try { window.localStorage.removeItem(TOKEN_STORAGE_KEY); } catch (_) {}
  }
}
