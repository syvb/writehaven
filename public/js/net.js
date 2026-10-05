// JSON API client. POSTs carry the X-WH header (CSRF guard on the server).

export class ApiError extends Error {
  constructor(status, data) {
    super((data && data.error) || `Request failed (${status})`);
    this.status = status;
    this.data = data || {};
  }
}

// The signed-in session is kept on the device so the writer's page can open
// offline (the service worker never caches /api/*).
const SESSION_KEY = 'wh-session';
const unreachable = (status) => status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530);
function cachedSession() {
  try {
    const v = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    return v && v.user ? v : null;
  } catch {
    return null;
  }
}
function rememberSession(data) {
  try {
    if (data && data.user) localStorage.setItem(SESSION_KEY, JSON.stringify({ user: data.user, party: data.party }));
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* private mode */ }
}
export function forgetSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch { /* ignore */ }
}

// Requests that change something (not GETs) still on their way: update.js lets them finish
// before it reloads the page.
let posting = 0;
export const postsInFlight = () => posting;

export async function api(path, body, { method = body === undefined ? 'GET' : 'POST', timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  // The deadline covers the whole exchange, body included: a response whose body stalls
  // is as good as lost (the abort ends a real fetch; the race ends anything else).
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new Error('timeout'));
    }, timeoutMs);
  });
  deadline.catch(() => {});
  const isSession = path === '/api/session' && method === 'GET';
  const offline = () => {
    const err = new ApiError(0, { error: 'You appear to be offline' });
    err.network = true;
    return err;
  };
  const counted = method !== 'GET';
  if (counted) posting++;
  try {
    let res;
    try {
      res = await Promise.race([fetch(path, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-WH': '1' },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
        signal: ctrl.signal,
        cache: 'no-store',
      }), deadline]);
    } catch (e) {
      const cached = isSession && cachedSession();
      if (cached) return { ...cached, offline: true };
      throw offline();
    }
    let data = null;
    let parsed = true;
    try {
      const read = typeof res.text === 'function'
        ? res.text().then((t) => (t ? JSON.parse(t) : null))
        : res.json();
      data = await Promise.race([read, deadline]);
    } catch (e) {
      parsed = false;
      data = null;
      if (e && e.message === 'timeout') throw offline(); // the body never arrived in full
    }
    // A success with a broken body is not a success we can act on: the outcome is unknown.
    if (!parsed && res.ok) {
      const err = offline();
      err.badBody = true;
      throw err;
    }
    if (isSession) {
      if (res.ok) rememberSession(data);
      else if (unreachable(res.status)) {
        const cached = cachedSession();
        if (cached) return { ...cached, offline: true };
      }
    }
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  } finally {
    clearTimeout(timer);
    if (counted) posting--;
  }
}

// Event streams this page keeps open, reconnecting ones included (update.js asks the server for
// its build now and then only on pages without one).
let openStreams = 0;
export const streamsOpen = () => openStreams;

// EventSource with a status callback; reconnects on its own (retry: 2000).
export function stream(path, handlers, onStatus) {
  let es = null;
  let closed = false;
  let backoff = 1000;
  openStreams++;
  function open() {
    es = new EventSource(path);
    es.onopen = () => {
      backoff = 1000;
      onStatus?.('open');
    };
    es.onerror = () => {
      onStatus?.('error');
      if (es.readyState === EventSource.CLOSED && !closed) {
        setTimeout(open, backoff);
        backoff = Math.min(backoff * 2, 15000);
      }
    };
    // A person's own stream also carries `notice` events (SPEC §22): those and its `me` frames
    // are re-dispatched on window as `wh:notice` / `wh:me` for notify.js, whichever page opened it.
    const relay = path.startsWith('/api/me/events');
    const on = (ev, fn) => es.addEventListener(ev, (e) => {
      let data;
      try {
        data = JSON.parse(e.data);
      } catch {
        return;
      }
      // Each (re)connection's first event carries the server's build id (`snapshot` on the live
      // stream, the first `me`): update.js compares it with this page's own.
      if ((ev === 'snapshot' || ev === 'me') && data && typeof data.build === 'string') window.dispatchEvent(new CustomEvent('wh:build', { detail: data.build }));
      fn?.(data);
      if (relay && (ev === 'me' || ev === 'notice')) window.dispatchEvent(new CustomEvent(`wh:${ev}`, { detail: data }));
    });
    for (const [ev, fn] of Object.entries(handlers)) on(ev, fn);
    // (hasOwnProperty, not Object.hasOwn: that one needs iOS 15.4.)
    if (relay) for (const ev of ['me', 'notice']) if (!Object.prototype.hasOwnProperty.call(handlers, ev)) on(ev, null);
    if (relay) es.addEventListener('open', () => window.dispatchEvent(new Event('wh:me-open'))); // catch up on notices
  }
  open();
  return {
    close() {
      if (!closed) openStreams--;
      closed = true;
      es?.close();
    },
  };
}
