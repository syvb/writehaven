// Notices in the browser (SPEC §22): a banner at the top of any signed-in page, with a chime
// and a buzz; a bell with the last 20; a system notification while the page is hidden; a
// polite way to turn on Web Push (with the iPhone Home Screen step); and the host's composer.
// The banner and the ask take a row in the page's flow and never lie over it (on the writer's
// page a grid row under the header and its banners, so the editor gets shorter); none of it
// shows on the projector.
//   initNotices({ session })               once per signed-in page (app.js)
//   askPushPermission(reason)              'menu', 'bell': a dialog; 'words': a gentle card at
//                                          the next calm moment (a minute after load, 20 s
//                                          after typing), never again after "Not now".
//   renderNotifyComposer(container, view)  the host's "Send a message" card (host.js)
// Notices come as `notice` events on the person's own `me` stream: net.js re-dispatches them
// on window as `wh:notice` (and `me` frames as `wh:me`) wherever the stream was opened; pages
// without one (the host dashboard, the live page) get one opened here. Times in a notice are
// templates ({t}) with epoch ms in `times`, shown in the device's local time (SPEC §24).

import { h, fill, clear, toast, modal, debounce } from './ui.js';
import { api, stream } from './net.js';

const CLOCK = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const WEEKDAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short' });
export const fmtLocal = (ms) => (Number.isFinite(ms) ? CLOCK.format(ms) : '');
// '{t}' -> '19:30' (device time) for each name in `times`; anything else stays as written.
export function fillTimes(text, times) {
  const s = String(text ?? '');
  if (!times || typeof times !== 'object') return s;
  return s.replace(/\{(\w+)\}/g, (all, k) => (Number.isFinite(times[k]) ? fmtLocal(times[k]) : all));
}
const when = (ms) => (Date.now() - ms > 18 * 3600_000 ? `${WEEKDAY.format(ms)} ${fmtLocal(ms)}` : fmtLocal(ms));
const firstName = (s) => String(s || '').trim().split(/\s+/)[0] || s;

const ls = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, String(v));
    } catch { /* private mode */ }
  },
  del(k) {
    try {
      localStorage.removeItem(k);
    } catch { /* private mode */ }
  },
};

// One state for the page, even if this module is loaded under two URLs (app.js imports it with
// the build version, write.js without).
const N = (globalThis.__whNotices ||= {
  started: false, me: null, list: [], unread: 0, ids: new Set(),
  bell: null, count: null, panel: null, banner: null, bannerId: null, ask: null,
  sawMe: false, ownStream: null, words: 0, observer: null, handled: new Set(),
  row: null, top: null, barOk: false, loadedAt: 0, typedAt: 0, wantsAsk: false, askTimer: null, askAgain: false,
  push: { key: null, reg: null, sub: null, ready: null },
});
const screen = () => document.body.dataset.screen || '';
// The projector (live page ?wall) is a room's big screen: no messages, no bell there.
const projector = () => document.body.classList.contains('is-projector');
// When the ask may come (tests shorten these through window.__whNoticeTiming).
const timing = () => ({ afterLoadMs: 60_000, quietMs: 20_000, ...(globalThis.__whNoticeTiming || {}) });

// ------------------------------------------------------------------ sound and buzz
let audio = null;
function unlockAudio() {
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume().catch(() => {});
  } catch { /* no audio */ }
}
// A soft two-note glass chime; one tab chimes per notice; phones buzz where they can.
function chime(id) {
  if (id) {
    const done = (ls.get('wh-chimed') || '').split(',');
    if (done.includes(id)) return;
    ls.set('wh-chimed', [id, ...done].slice(0, 30).join(','));
  }
  try {
    navigator.vibrate?.([90, 60, 90]);
  } catch { /* not allowed yet */ }
  unlockAudio();
  if (!audio || audio.state !== 'running') return;
  const t = audio.currentTime + 0.02;
  const out = audio.createGain();
  out.gain.value = 0.2;
  out.connect(audio.destination);
  for (const [f, d] of [[659.25, 0], [987.77, 0.13]]) {
    for (const [mult, peak] of [[1, 1], [2.01, 0.16]]) {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = 'sine';
      o.frequency.value = f * mult;
      g.gain.setValueAtTime(0.0001, t + d);
      g.gain.exponentialRampToValueAtTime(peak, t + d + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 1.15);
      o.connect(g).connect(out);
      o.start(t + d);
      o.stop(t + d + 1.2);
    }
  }
}

// ------------------------------------------------------------------ the list
function addNotices(items, { replace = false } = {}) {
  const byId = new Map((replace ? [] : N.list).map((n) => [n.id, n]));
  for (const n of items) if (n && typeof n.id === 'string') byId.set(n.id, { ...byId.get(n.id), ...n });
  N.list = [...byId.values()].sort((a, b) => b.at - a.at).slice(0, 20);
  N.ids = new Set(N.list.map((n) => n.id));
  N.unread = N.list.filter((n) => !n.read).length;
  updateBell();
}
const fresh = (n) => !n.exp || n.exp > Date.now();
// The writer's page shows its own banner for these (write.js): the 15-minute warning, a break
// running, being out. There they go straight to the bell, read.
const ownWarning = (n) => screen() === 'write' && (n.kind === 'warning' || n.kind === 'break' || n.kind === 'out');
function seen(ids, via) {
  if (ids.length) api('/api/me/notices/seen', { ids, via }).catch(() => {});
}
function markRead(ids) {
  const set = new Set(ids);
  let changed = false;
  for (const n of N.list) {
    if (set.has(n.id) && !n.read) {
      n.read = true;
      changed = true;
    }
  }
  if (!changed) return;
  N.unread = N.list.filter((n) => !n.read).length;
  updateBell();
  api('/api/me/notices/read', { ids: [...set] }).catch(() => {});
}
async function refresh({ banner = false } = {}) {
  let r;
  try {
    r = await api('/api/me/notices');
  } catch {
    return;
  }
  if (!r || !Array.isArray(r.notices)) return;
  addNotices(r.notices, { replace: true });
  if (N.panel) renderPanel();
  // Sent while this page's stream was connecting or away: they arrive now, chime and all.
  const late = r.notices.filter((n) => !N.handled.has(n.id) && !n.read && fresh(n) && Date.now() - n.at < 120_000);
  for (const n of late.reverse()) present(n);
  if (banner && document.visibilityState === 'visible' && !projector()) {
    const next = N.list.find((n) => !n.read && fresh(n) && !ownWarning(n));
    if (next && next.id !== N.bannerId) {
      showBanner(next);
      seen([next.id], 'banner');
    } else if (!next && N.banner) hideBanner();
  }
}

function onNotice(n) {
  if (!n || typeof n.id !== 'string' || N.ids.has(n.id)) return;
  addNotices([n]);
  present(n);
}
// Show a notice that has just arrived: in the open bell, as a banner, or (hidden page) as a
// system notification; the server then sends no push for it.
function present(n) {
  N.handled.add(n.id);
  if (projector()) return; // it waits in the list for the person's own screen
  if (N.panel && document.visibilityState === 'visible') {
    N.panel.__newIds.add(n.id);
    renderPanel();
    markRead([n.id]);
    if (n.sound) chime(n.id);
    seen([n.id], 'bell');
    return;
  }
  if (document.visibilityState === 'visible') {
    if (ownWarning(n)) {
      markRead([n.id]);
      return;
    }
    showBanner(n);
    if (n.sound) chime(n.id);
    seen([n.id], 'banner');
    return;
  }
  // Hidden: a system notification if allowed; the banner waits for the page to come back.
  // Without one, the server sends a push to the person's other devices after a few seconds.
  systemNotify(n).then((ok) => { if (ok) seen([n.id], 'system'); });
}

const canNotify = () => 'Notification' in window && Notification.permission === 'granted';
let manifestIcon = null;
function iconUrl() {
  manifestIcon ||= fetch('/manifest.webmanifest').then((r) => (r.ok ? r.json() : {})).then((m) => {
    const any = (Array.isArray(m.icons) ? m.icons : []).filter((i) => i && i.src && !/maskable|monochrome/.test(i.purpose || ''));
    const pick = any.find((i) => /\b192x192\b/.test(i.sizes || '')) || any[0];
    return pick ? new URL(pick.src, location.origin).href : undefined;
  }).catch(() => undefined);
  return manifestIcon;
}
async function systemNotify(n) {
  if (!canNotify()) return false;
  const title = fillTimes(n.title, n.times) || (n.from === 'host' ? `From ${n.fromName || 'the host'}` : 'Writehaven');
  const opts = {
    body: fillTimes(n.body, n.times), tag: `wh-${n.tag || n.id}`, timestamp: n.at, silent: !n.sound,
    data: { id: n.id, url: n.url || '/' }, icon: await iconUrl(),
  };
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration('/') : null;
    if (reg && reg.active) {
      await reg.showNotification(title, opts);
      return true;
    }
    const x = new Notification(title, opts);
    x.onclick = () => {
      window.focus();
      markRead([n.id]);
      x.close();
    };
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ the banner
const KICKER = { approved: 'Writehaven', warning: 'Your hour', break: 'Break', 'break-end': 'Break', out: 'The challenge', cohost: 'Writehaven' };
const fromLabel = (n) => (n.from === 'host' ? `From ${n.fromName || 'the host'}` : KICKER[n.kind] || 'Writehaven');
const goLabel = (url) => (url === '/host' ? 'Open the host dashboard' : url === '/write' || url === '/' ? 'Open the editor' : 'Open');
const goes = (n) => n.url && n.url !== location.pathname && !(n.url === '/write' && location.pathname === '/');
const kicker = (n, extra = null) => h('p', { class: 'nt-kicker' }, extra, fromLabel(n), ' ', h('span', { class: 'nt-dot', 'aria-hidden': 'true' }, '·'), ' ',
  h('time', { datetime: new Date(n.at).toISOString() }, when(n.at)));

function showBanner(n) {
  if (projector()) return;
  N.bannerId = n.id;
  const others = N.list.filter((x) => x.id !== n.id && !x.read && fresh(x) && !ownWarning(x)).length;
  const close = h('button', { class: 'nt-x', type: 'button', 'aria-label': 'Dismiss', title: 'Dismiss' }, '×');
  close.addEventListener('click', () => dismissBanner(n.id));
  const body = n.body ? h('p', { class: 'nt-body' }, fillTimes(n.body, n.times)) : null;
  const all = h('button', { class: 'btn-link nt-readall', type: 'button', hidden: true, 'aria-expanded': 'false' }, 'Read all');
  const go = goes(n) ? h('a', { class: 'nt-go', href: n.url, onClick: () => markRead([n.id]) }, goLabel(n.url)) : null;
  const more = others ? h('button', { class: 'btn-link nt-more', type: 'button', onClick: () => openPanel() }, others === 1 ? '1 more message' : `${others} more messages`) : null;
  const acts = h('p', { class: 'nt-actions', hidden: !go && !more }, all, go, more);
  const el = h('div', { class: `nt-banner nt-k-${n.kind || 'message'}`, role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true', dataset: { id: n.id } },
    h('div', { class: 'nt-banner-in' },
      kicker(n),
      n.title ? h('p', { class: 'nt-title' }, fillTimes(n.title, n.times)) : null,
      body,
      acts),
    close);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') dismissBanner(n.id);
  });
  all.addEventListener('click', () => {
    const open = !el.classList.contains('is-open');
    el.classList.toggle('is-open', open);
    all.textContent = open ? 'Show less' : 'Read all';
    all.setAttribute('aria-expanded', String(open));
  });
  if (N.ask) N.askAgain = true; // the message goes first; the ask comes back at a calm moment
  N.ask = null;
  N.banner = el;
  setRow(el);
  // A long message shows its first lines (CSS); "Read all" opens the rest.
  if (body) {
    requestAnimationFrame(() => {
      if (body.scrollHeight > body.clientHeight + 2) {
        all.hidden = false;
        acts.hidden = false;
      }
    });
  }
}
// The row in the page's flow that holds the banner or the ask. On the writer's page it's a grid
// row after the header, the page's own banner, the update notice and the food row (app.css
// .has-nt-row), so the editor gets shorter and nothing is covered; elsewhere a row above the page.
function placeRow() {
  const row = N.row;
  if (!row) return;
  const app = document.querySelector('#app > .w-app');
  const main = app && app.querySelector(':scope > .w-main');
  for (const el of document.querySelectorAll('.has-nt-row')) if (el !== app || !main) el.classList.remove('has-nt-row');
  if (main) {
    if (row.nextElementSibling !== main) main.before(row);
    app.classList.add('has-nt-row');
    return;
  }
  const root = document.getElementById('app');
  if (!root) return;
  if (row.parentElement === root.parentElement && row.compareDocumentPosition(root) & Node.DOCUMENT_POSITION_FOLLOWING) return;
  root.before(row);
}
function setRow(el) {
  if (!el) {
    if (N.row) {
      N.row.closest('.w-app')?.classList.remove('has-nt-row');
      N.row.remove();
      N.row = null;
    }
    return;
  }
  N.row ||= h('div', { class: 'nt-row' });
  fill(N.row, el);
  placeRow();
}
function hideBanner() {
  N.banner = null;
  N.bannerId = null;
  if (!N.ask) setRow(null);
}
function dismissBanner(id) {
  const back = N.banner && N.banner.contains(document.activeElement);
  markRead([id]);
  const next = N.list.find((n) => n.id !== id && !n.read && fresh(n) && !ownWarning(n));
  if (next) {
    showBanner(next);
    seen([next.id], 'banner');
    if (back) N.banner?.querySelector('.nt-x')?.focus();
  } else hideBanner();
}

// ------------------------------------------------------------------ the bell
function svgIcon(paths, cls) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', cls);
  for (const d of paths) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}
function makeBell() {
  if (N.bell) return N.bell;
  N.count = h('span', { class: 'nt-bell-n', hidden: true });
  N.bell = h('button', { class: 'nt-bell', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
    svgIcon(['M18 15.6V11a6 6 0 0 0-12 0v4.6L4.6 18h14.8Z', 'M9.8 20.4a2.3 2.3 0 0 0 4.4 0'], 'nt-bell-ico'), N.count);
  N.bell.addEventListener('click', () => (N.panel ? closePanel() : openPanel()));
  updateBell();
  return N.bell;
}
function updateBell() {
  if (!N.bell) return;
  const n = N.unread;
  N.count.hidden = !n;
  N.count.textContent = n > 9 ? '9+' : String(n);
  N.bell.classList.toggle('has-new', n > 0);
  N.bell.setAttribute('aria-label', n ? `Messages, ${n} unread` : 'Messages');
  N.bell.title = n ? `${n} unread message${n === 1 ? '' : 's'}` : 'Messages';
}
// Where the bell lives: the writer's top bar (before the name menu), the host's top bar, the
// live page's masthead, the waiting card's header line; elsewhere a slim row of its own above
// the page. Never on the projector.
function slot() {
  const me = document.querySelector('.w-top .w-me');
  if (me) return { parent: me.parentElement, before: me };
  const host = document.querySelector('.h-top-right');
  if (host) return { parent: host, before: null };
  const nav = document.querySelector('.l-mast-nav');
  if (nav) return { parent: nav, before: null };
  const ap = document.querySelector('.ap-card .ap-kicker');
  if (ap) return { parent: ap, before: null };
  return null;
}
function placeBell() {
  const b = makeBell();
  if (projector()) {
    b.remove();
    N.top?.remove();
    return;
  }
  const s = slot();
  if (s) {
    const ok = b.parentElement === s.parent && (s.before ? b.nextElementSibling === s.before : b === s.parent.lastElementChild);
    if (!ok) s.parent.insertBefore(b, s.before);
    if (N.top) {
      N.top.remove();
      N.top = null;
    }
  } else if (N.barOk) {
    // No header to sit in, once the page has had time to draw one.
    N.top ||= h('div', { class: 'nt-top' });
    if (b.parentElement !== N.top) N.top.append(b);
    const root = document.getElementById('app');
    if (!root) return;
    const anchor = N.row && N.row.parentElement === root.parentElement ? N.row : root;
    if (N.top.nextElementSibling !== anchor) anchor.before(N.top);
  }
}
// Pages re-render their headers: put the bell back in the same task, before anything paints.
function keepBell() {
  N.observer?.disconnect();
  const root = document.getElementById('app') || document.body;
  const write = screen() === 'write';
  let top = null;
  let row = null;
  const watchTop = () => {
    const t = document.querySelector('.w-top');
    if (write && t && t !== top) {
      top = t;
      N.observer.observe(t, { childList: true });
    }
    const b = document.querySelector('.w-banner');
    if (write && b && b !== row) {
      row = b;
      N.observer.observe(b, { attributes: true, attributeFilter: ['hidden', 'class'], childList: true });
    }
  };
  N.observer = new MutationObserver(() => {
    const s = slot();
    if (!N.bell.isConnected || (s && N.bell.parentElement !== s.parent) || projector()) placeBell();
    watchTop();
    if (N.row) placeRow();
  });
  // The writer's page is the editor: watch only its frame, never the text being typed.
  if (write) {
    N.observer.observe(root, { childList: true });
    watchTop();
  } else N.observer.observe(root, { childList: true, subtree: true });
}

// ------------------------------------------------------------------ the panel
function openPanel() {
  closeAsk();
  if (N.panel) return;
  N.panel = h('section', { class: 'nt-panel', role: 'dialog', 'aria-labelledby': 'nt-panel-h', tabindex: '-1' });
  N.panel.__newIds = new Set(N.list.filter((n) => !n.read).map((n) => n.id));
  renderPanel();
  document.body.append(N.panel);
  positionPanel();
  N.bell?.setAttribute('aria-expanded', 'true');
  N.panel.focus({ preventScroll: true });
  if (N.panel.__newIds.size) markRead([...N.panel.__newIds]);
  if (N.banner) hideBanner();
  preparePush();
  setTimeout(() => {
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onPanelKey, true);
    window.addEventListener('resize', positionPanel);
  });
}
function closePanel({ focus = true } = {}) {
  if (!N.panel) return;
  N.panel.remove();
  N.panel = null;
  N.bell?.setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onPanelKey, true);
  window.removeEventListener('resize', positionPanel);
  if (focus && N.bell?.isConnected) N.bell.focus({ preventScroll: true });
}
function onOutside(e) {
  if (N.panel && !N.panel.contains(e.target) && !N.bell?.contains(e.target)) closePanel({ focus: false });
}
function onPanelKey(e) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    closePanel();
  }
}
function positionPanel() {
  const p = N.panel;
  if (!p) return;
  if (window.innerWidth < 560 || !N.bell?.isConnected) {
    p.classList.add('is-sheet');
    p.style.left = '';
    p.style.top = '';
    return;
  }
  p.classList.remove('is-sheet');
  const r = N.bell.getBoundingClientRect();
  const w = p.offsetWidth;
  p.style.left = `${Math.max(12, Math.min(r.right - w, window.innerWidth - w - 12))}px`;
  p.style.top = `${Math.round(r.bottom + 8)}px`;
}
function renderPanel() {
  const p = N.panel;
  if (!p) return;
  const isNew = p.__newIds || new Set();
  const items = N.list.map((n) => h('li', { class: `nt-item nt-k-${n.kind || 'message'}${isNew.has(n.id) ? ' is-new' : ''}${fresh(n) ? '' : ' is-old'}` },
    kicker(n, isNew.has(n.id) ? h('span', { class: 'nt-new' }, 'New') : null),
    n.title ? h('p', { class: 'nt-title' }, fillTimes(n.title, n.times)) : null,
    n.body ? h('p', { class: 'nt-body' }, fillTimes(n.body, n.times)) : null,
    goes(n) ? h('a', { class: 'nt-go', href: n.url }, goLabel(n.url)) : null));
  const close = h('button', { class: 'nt-x', type: 'button', 'aria-label': 'Close' }, '×');
  close.addEventListener('click', () => closePanel());
  fill(p,
    h('header', { class: 'nt-panel-head' }, h('h2', { id: 'nt-panel-h' }, 'Messages'), close),
    items.length
      ? h('ol', { class: 'nt-list' }, items)
      : h('div', { class: 'nt-empty' }, h('p', { class: 'nt-title' }, 'Nothing yet.'), h('p', { class: 'nt-body' }, 'Messages from the hosts, and a nudge when an hour is nearly up, arrive here.')),
    pushBlock({ compact: true }));
}

// ------------------------------------------------------------------ Web Push
const isIos = () => /iP(hone|od|ad)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
// ...and the app's service worker shows pushes (it answers a ping once sw.js imports sw-push.js;
// until then, subscribing would make every push the browser's generic notification).
const pushReady = () => pushSupported() && N.push.handler !== false;
function pushHandler(reg) {
  const w = reg && reg.active;
  if (!w || typeof MessageChannel !== 'function') return Promise.resolve(false);
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const t = setTimeout(() => resolve(false), 1500);
    ch.port1.onmessage = (e) => {
      clearTimeout(t);
      resolve(!!(e.data && e.data.type === 'wh-push-pong'));
    };
    try {
      w.postMessage({ type: 'wh-push-ping' }, [ch.port2]);
    } catch {
      clearTimeout(t);
      resolve(false);
    }
  });
}
// ask | ask-page | on | off | page-only | denied | ios-install | unsupported
function pushState() {
  if (isIos() && !standalone() && !pushSupported()) return 'ios-install';
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (pushSupported() && N.push.handler === undefined) return 'checking'; // preparePush() decides
  if (Notification.permission === 'default') return pushReady() ? 'ask' : 'ask-page';
  if (!pushReady()) return 'page-only';
  if (N.push.sub) return 'on';
  return ls.get('wh-push-off') ? 'off' : 'ask';
}
function keyBytes(b64) {
  const s = String(b64).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function sameKey(sub, key) {
  const k = sub?.options?.applicationServerKey;
  if (!k || !key) return true; // can't tell: keep it
  const a = new Uint8Array(k);
  const b = keyBytes(key);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone' : isIos() ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const br = /Edg[A]?\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Firefox|FxiOS/.test(ua) ? 'Firefox'
    : /OPR\//.test(ua) ? 'Opera' : /Chrome|CriOS/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Browser';
  return `${os} · ${br}${standalone() ? ' (Home Screen)' : ''}`;
}
// The app's service worker (public/sw.js, which loads sw-push.js), registered if needed.
async function swRegistration() {
  let reg = await navigator.serviceWorker.getRegistration('/');
  if (!reg) {
    const src = document.querySelector('script[src*="/js/app.js?v="]')?.getAttribute('src') || '';
    const v = (/[?&]v=([\w-]+)/.exec(src) || [])[1];
    if (!v) return null;
    reg = await navigator.serviceWorker.register(`/sw.js?v=${v}`, { scope: '/', updateViaCache: 'none' });
  }
  if (!reg.active) await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(r, 10_000))]);
  return reg.active ? reg : null;
}
// Fetch the server's key and the worker before any button is pressed: Safari only shows its
// permission prompt from a tap, so subscribe() must be the first thing the tap does.
function preparePush() {
  if (!pushSupported()) return Promise.resolve(false);
  if (!N.push.ready) {
    N.push.ready = (async () => {
      const [r, reg] = await Promise.all([N.push.key ? { key: N.push.key } : api('/api/push/key'), swRegistration()]);
      N.push.key = r?.key || null;
      N.push.reg = reg;
      N.push.handler = reg ? await pushHandler(reg) : false;
      if (reg) N.push.sub = await reg.pushManager.getSubscription();
      return !!(N.push.key && N.push.reg && N.push.handler);
    })().catch(() => false);
    N.push.ready.then((ok) => {
      if (!ok) N.push.ready = null; // try again next time
      refreshPushUi();
    });
  }
  return N.push.ready;
}
async function sendSub(sub) {
  await api('/api/push/subscribe', { subscription: sub.toJSON(), device: deviceLabel() });
  N.push.sub = sub;
}
// From a tap. Returns the new state ('on', 'page-only', 'denied', 'ask', 'service', 'failed').
async function enablePush() {
  ls.del('wh-push-off');
  if (!('Notification' in window)) return 'unsupported';
  const p = N.push;
  const opts = () => ({ userVisibleOnly: true, applicationServerKey: keyBytes(p.key) });
  try {
    if (pushSupported() && p.reg && p.key && p.handler === true) {
      const sub = await p.reg.pushManager.subscribe(opts()); // asks for permission where needed
      await sendSub(sub);
      return 'on';
    }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'ask';
    if (!pushSupported() || !(await preparePush())) return 'page-only';
    await sendSub(await p.reg.pushManager.subscribe(opts()));
    return 'on';
  } catch (e) {
    if ('Notification' in window && Notification.permission === 'denied') return 'denied';
    if (e && e.status === 400) return 'service';
    return 'failed';
  }
}
async function disablePush() {
  ls.set('wh-push-off', '1');
  const sub = N.push.sub || (N.push.reg ? await N.push.reg.pushManager.getSubscription().catch(() => null) : null);
  N.push.sub = null;
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => {});
  await api('/api/push/unsubscribe', { endpoint }).catch(() => {});
}
// On every load with permission: keep this device's subscription current on the server (and
// under this sign-in), renewing it if the server's key changed.
async function syncPush() {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  if (!(await preparePush())) return;
  let sub = N.push.sub;
  if (sub && !sameKey(sub, N.push.key)) {
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  if (!sub && !ls.get('wh-push-off')) {
    try {
      sub = await N.push.reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(N.push.key) });
    } catch {
      return;
    }
  }
  if (sub) await sendSub(sub).catch(() => {});
  refreshPushUi();
}

const PUSH_TEXT = {
  ask: 'Get a nudge 15 minutes before your hour ends if you’re behind, and messages from the hosts, even when Writehaven is closed.',
  'ask-page': 'Get messages from the hosts as notifications while Writehaven is open in the background.',
  on: 'Notifications are on for this device.',
  off: 'Notifications are off for this device.',
  'page-only': 'You’ll get notifications while Writehaven is open in the background.',
  denied: 'Notifications are blocked for this site. To get them, allow notifications for this site in your browser’s settings, then reload the page.',
  'ios-install': 'On iPhone and iPad, notifications reach you once Writehaven is on your Home Screen: tap Share, then “Add to Home Screen”, and open it from there. Messages still show here while the page is open.',
  unsupported: 'This browser can’t show notifications. Messages still show here while the page is open.',
  service: 'This browser’s notification service isn’t supported here. Messages still show here while the page is open.',
  failed: 'That didn’t work. Messages still show here while the page is open; try again later.',
};
// Install help from the PWA module, when it's there (SPEC §23).
let installMod = null;
const loadInstall = () => (installMod ||= fetch('/js/install.js', { method: 'HEAD', cache: 'no-cache' })
  .then((r) => (r.ok ? import('./install.js') : null)).catch(() => null));

function pushBlock({ compact = false, state = pushState(), onDone = null } = {}) {
  const box = h('div', { class: `nt-push${compact ? ' is-compact' : ''}`, dataset: { state } });
  if (state === 'checking') {
    box.hidden = true; // nothing said until it's known whether pushes can work here
    return box;
  }
  const say = h('p', { class: 'nt-push-say' }, PUSH_TEXT[state] || '');
  const acts = h('p', { class: 'nt-push-acts' });
  const busy = (b, label) => {
    b.disabled = true;
    b.textContent = label;
  };
  if (state === 'ask' || state === 'ask-page' || state === 'off' || state === 'service' || state === 'failed') {
    const on = h('button', { class: compact ? 'btn btn-quiet nt-push-on' : 'btn btn-primary nt-push-on', type: 'button' }, 'Turn on notifications');
    on.addEventListener('click', async () => {
      const go = enablePush(); // first thing the tap does (Safari)
      busy(on, 'Turning on…');
      const st = await go;
      if (st === 'on') toast('Notifications are on for this device.');
      box.replaceWith(pushBlock({ compact, state: shownState(st), onDone }));
      onDone?.(st);
    });
    acts.append(on);
  } else if (state === 'on') {
    const off = h('button', { class: 'btn-link nt-push-off', type: 'button' }, 'Turn off');
    off.addEventListener('click', async () => {
      busy(off, 'Turning off…');
      await disablePush();
      box.replaceWith(pushBlock({ compact, state: pushState(), onDone }));
      onDone?.('off');
    });
    acts.append(off);
  } else if (state === 'ios-install') {
    const how = h('button', { class: 'btn-link nt-push-how', type: 'button', hidden: true }, 'Show me how');
    loadInstall().then((m) => {
      if (m && typeof m.openInstallHelp === 'function') {
        how.hidden = false;
        how.addEventListener('click', () => {
          closePanel({ focus: false });
          onDone?.('ios-install');
          m.openInstallHelp({ reason: 'notifications' });
        });
      }
    });
    acts.append(how);
  }
  box.append(say);
  if (acts.childNodes.length) box.append(acts);
  return box;
}
// What to show after an attempt: a failure says so; otherwise the device's real state.
const shownState = (st) => (st === 'service' || st === 'failed' ? st : pushState());
function refreshPushUi() {
  const old = N.panel && N.panel.querySelector('.nt-push');
  if (old) old.replaceWith(pushBlock({ compact: true }));
}

// The polite ask. 'words' (after the first 50 words): a card that can wait, at most every 12
// hours on a device; anything else (the writer menu, the bell): a dialog with the reasons.
export async function askPushPermission(reason = 'menu') {
  // A moment to learn whether pushes can work here (the key, the worker), so the words are true.
  await Promise.race([preparePush(), new Promise((r) => setTimeout(r, 1500))]);
  const state = pushState() === 'checking' ? 'ask' : pushState(); // still finding out: the likely case
  if (reason === 'words' || reason === 'auto') {
    wantAsk();
    return state;
  }
  return new Promise((resolve) => {
    let result = state;
    const note = h('p', { class: 'nt-ask-state', hidden: ['ask', 'ask-page'].includes(state) }, PUSH_TEXT[state] || '');
    const body = h('div', { class: 'modal-body nt-ask-body' },
      h('p', null, `Writehaven can tap you on the shoulder: 15 minutes before an hour ends if you’re behind, when a break starts and ends, and when the hosts send a message${pushReady() ? ', even with the app closed' : ', while Writehaven is open (in the background too)'}.`),
      note);
    const show = (st) => {
      note.textContent = PUSH_TEXT[st] || '';
      note.hidden = !note.textContent;
    };
    const actions = [];
    if (['ask', 'ask-page', 'off', 'service', 'failed'].includes(state)) {
      actions.push({ label: 'Not now', quiet: true });
      actions.push({
        label: 'Turn on notifications', primary: true, keepOpen: true,
        onClick: (close) => {
          const go = enablePush(); // first thing the tap does (Safari)
          const btn = dlg.el.querySelector('.modal-actions .btn-primary');
          if (btn) {
            btn.disabled = true;
            btn.textContent = 'Turning on…';
          }
          go.then((st) => {
            result = st;
            refreshPushUi();
            if (st === 'on') {
              toast('Notifications are on for this device.');
              close('on');
              return;
            }
            show(shownState(st));
            if (btn) {
              btn.disabled = st === 'denied' || st === 'page-only';
              btn.textContent = st === 'page-only' ? 'Turned on' : 'Try again';
            }
          });
          return false;
        },
      });
    } else if (state === 'on') {
      actions.push({
        label: 'Turn off', quiet: true, keepOpen: true,
        onClick: (close) => {
          disablePush().then(() => {
            result = 'off';
            refreshPushUi();
            close('off');
          });
          return false;
        },
      });
      actions.push({ label: 'Done', primary: true });
    } else if (state === 'ios-install') {
      actions.push({ label: 'Not now', quiet: true });
      actions.push({
        label: 'Show me how', primary: true,
        onClick: () => {
          loadInstall().then((m) => (m && typeof m.openInstallHelp === 'function' ? m.openInstallHelp({ reason: 'notifications' }) : null));
        },
      });
    } else actions.push({ label: 'OK', primary: true });
    const dlg = modal({ title: 'Notifications', className: 'modal-confirm nt-ask-modal', body, actions, onClose: () => resolve(result) });
  });
}
// After the first 50 words, the gentle ask waits for a calm moment: at least a minute after the
// page loaded, 20 s after the last keystroke, no dialog, menu or message on screen. Shown once
// per 12 hours on a device until answered; "Not now" (or turning them on) ends it for good.
const asked = () => ls.get('wh-push-ask') === 'no';
function wantAsk() {
  if (N.wantsAsk || asked()) return;
  N.wantsAsk = true;
  preparePush();
  N.askTimer = setInterval(calmCheck, 2000);
}
function stopAsk() {
  N.wantsAsk = false;
  clearInterval(N.askTimer);
  N.askTimer = null;
}
function calmCheck() {
  if (!N.wantsAsk || N.ask || N.banner || N.panel || document.visibilityState !== 'visible' || screen() !== 'write' || projector()) return;
  const t = timing();
  const now = Date.now();
  if (now - N.loadedAt < t.afterLoadMs || now - N.typedAt < t.quietMs) return;
  if (document.querySelector('dialog[open], .menu-pop')) return;
  if (asked()) return stopAsk();
  const st = pushState();
  if (st === 'checking') return; // the next check knows
  if (!['ask', 'ask-page', 'ios-install'].includes(st)) return stopAsk();
  if (!N.askAgain && now - Number(ls.get('wh-push-asked') || 0) < 12 * 3600_000) return stopAsk();
  ls.set('wh-push-asked', now);
  N.askAgain = false;
  showAsk(st);
}
function showAsk(state) {
  if (N.banner) {
    N.askAgain = true;
    return;
  }
  const done = () => {
    ls.set('wh-push-ask', 'no');
    stopAsk();
  };
  const later = h('button', { class: 'btn btn-quiet', type: 'button' }, 'Not now');
  const card = h('div', { class: 'nt-banner nt-ask nt-k-ask', role: 'region', 'aria-label': 'Notifications' },
    h('div', { class: 'nt-banner-in' },
      h('p', { class: 'nt-title' }, state === 'ios-install' ? 'Notifications on your iPhone' : 'Turn on notifications?'),
      pushBlock({ state, onDone: () => { done(); setTimeout(closeAsk, 1200); } })));
  later.addEventListener('click', () => {
    done();
    closeAsk();
  });
  const acts = card.querySelector('.nt-push-acts');
  if (acts) acts.append(later);
  else card.querySelector('.nt-push').append(h('p', { class: 'nt-push-acts' }, later));
  N.ask = card;
  setRow(card);
}
function closeAsk() {
  const el = N.ask;
  N.ask = null;
  if (el && !N.banner) setRow(null);
}

// ------------------------------------------------------------------ start
function onMe(v) {
  N.sawMe = true;
  const p = v && v.progress;
  if (!p || screen() !== 'write') return;
  const words = Math.round((p.totals?.credit || 0) + (p.current?.pending || 0));
  if (words >= 50) wantAsk();
  N.words = words;
}
function onSwMessage(e) {
  const m = e.data || {};
  if (m.type === 'wh-open' && typeof m.url === 'string' && m.url.startsWith('/')) location.assign(m.url);
  else if (m.type === 'wh-notice-read' && m.id) {
    markRead([m.id]);
    if (N.bannerId === m.id) dismissBanner(m.id);
  }
}
// Pages without the writer's stream get one here (the writer page and the approval card open
// their own, which net.js relays).
function ensureStream(tries = 0) {
  const sc = screen();
  if (!sc && tries < 40) {
    setTimeout(() => ensureStream(tries + 1), 300);
    return;
  }
  if (N.ownStream || N.sawMe || sc === 'write' || sc === 'approval' || sc === 'auth') return;
  N.ownStream = stream('/api/me/events', { notice: onNotice });
}

export async function initNotices({ session = null } = {}) {
  if (N.started) return;
  N.started = true;
  let s = session;
  if (!s) s = await api('/api/session').catch(() => null);
  if (!s || !s.user) {
    N.started = false;
    return;
  }
  N.me = s.user;
  window.addEventListener('wh:notice', (e) => onNotice(e.detail));
  // Each (re)connection of the person's stream: catch up on what came meanwhile.
  window.addEventListener('wh:me-open', () => refresh({ banner: true }));
  window.addEventListener('wh:me', (e) => onMe(e.detail));
  window.addEventListener('pointerdown', unlockAudio, { capture: true, passive: true, once: true });
  window.addEventListener('keydown', unlockAudio, { capture: true, once: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh({ banner: true });
  });
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', onSwMessage);
  // The approval card turns into the writer's page in place: the bell follows the new header.
  new MutationObserver(() => {
    placeBell();
    keepBell();
  }).observe(document.body, { attributes: true, attributeFilter: ['data-screen'] });
  setTimeout(() => {
    N.barOk = true;
    placeBell();
  }, 2500);
  placeBell();
  keepBell();
  window.addEventListener('wh:layout', () => placeRow()); // update.js's notice came or went
  // Typing: the ask waits until it pauses (cheap: a timestamp per key).
  N.loadedAt = Date.now();
  const typing = () => { N.typedAt = Date.now(); };
  for (const ev of ['keydown', 'beforeinput', 'compositionupdate']) document.addEventListener(ev, typing, { capture: true, passive: true });
  ensureStream();
  await refresh({ banner: true });
  // A safety net for a stream that went quiet (a proxy, a sleeping phone): look now and then.
  setInterval(() => {
    if (document.visibilityState === 'visible') refresh({ banner: !N.banner });
  }, 90_000);
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 2000));
  idle(() => syncPush().catch(() => {}), { timeout: 8000 });
}

// ------------------------------------------------------------------ the host's composer
const GROUP_KINDS = [
  ['all', 'Everyone'], ['writers', 'All writers'], ['hosts', 'Hosts'], ['at-risk', 'At risk'],
  ['out', 'Out'], ['not-started', 'Not started'], ['pending', 'Waiting for approval'],
];
const AUTO = [
  ['approved', 'When someone is approved', '“You’re approved — come and write”, for people who aren’t looking at the page.'],
  ['warning', 'Behind, 15 minutes before the hour ends', 'The words to go and the pace that gets them there.'],
  ['breaks', 'Breaks', 'When a break starts and when it ends.'],
  ['out', 'Out of the challenge', 'A kind note when someone misses an hour.'],
];

// host.js: renderNotifyComposer(el, hostView, { getSelected, onSelectionChange }) where
// getSelected() -> ids of the rows ticked in the writers table, and onSelectionChange(fn)
// registers fn(ids) for when they change. Also accepted: an adapter as the second argument,
// { view: () => hostView, selectedIds: () => ids, onSelectionChange }. Without a selection the
// composer offers "Choose people" (a list to tick) instead of "Selected".
function adapt(x, opts = {}) {
  const o = x || {};
  const view = typeof o.view === 'function' ? o.view : () => (Array.isArray(o.writers) ? o : null);
  const selection = typeof opts.getSelected === 'function' ? opts.getSelected
    : typeof o.selectedIds === 'function' ? o.selectedIds : Array.isArray(o.selectedIds) ? () => o.selectedIds : null;
  const subscribe = typeof opts.onSelectionChange === 'function' ? opts.onSelectionChange
    : typeof o.onSelectionChange === 'function' ? o.onSelectionChange : null;
  return { view, selection, subscribe };
}

export function renderNotifyComposer(container, hostView = {}, opts = {}) {
  let src = adapt(hostView, opts);
  // The host's card may have its own heading already.
  const heading = opts.heading ?? !container.parentElement?.querySelector(':scope > h2, :scope > header h2');
  const st = {
    to: 'all', one: '', chosen: new Set(), sound: true, sending: false, info: null, infoAt: 0,
    preview: null, previewKey: '', showAll: false, dead: false,
  };
  container.classList.add('nt-composer');
  const myId = () => N.me?.id || null;
  const people = () => (src.view()?.writers || []).filter((w) => w.id !== myId());
  const selected = () => (src.selection ? src.selection() : []).filter((id) => id !== myId());

  // ---- static parts (built once, so typing never loses its place)
  const chips = h('div', { class: 'nt-chips', role: 'radiogroup', 'aria-labelledby': 'nt-to-l' });
  const oneSel = h('select', { class: 'nt-one', 'aria-label': 'Who' });
  const chooseBox = h('div', { class: 'nt-choose' });
  const titleIn = h('input', { class: 'nt-in', id: 'nt-title', type: 'text', maxlength: 80, placeholder: 'Dinner is here', autocomplete: 'off' });
  const bodyIn = h('textarea', { class: 'nt-in nt-ta', id: 'nt-body', rows: 3, maxlength: 300, placeholder: 'Pizza in the kitchen. Veggie on the left, the rest on the right.', 'aria-describedby': 'nt-count' });
  const count = h('span', { class: 'nt-count', id: 'nt-count' }, '0 / 300');
  const sound = h('input', { type: 'checkbox', checked: true });
  const previewEl = h('p', { class: 'nt-preview', 'aria-live': 'polite' });
  const err = h('p', { class: 'nt-err', role: 'alert' });
  const send = h('button', { class: 'btn btn-primary nt-send', type: 'button' }, 'Send');
  const sentEl = h('div', { class: 'nt-sent-wrap' });
  const autoEl = h('details', { class: 'nt-auto' });
  const whoRow = h('div', { class: 'nt-who' }, oneSel, chooseBox);

  fill(container,
    heading ? h('h2', null, 'Send a message') : null,
    h('p', { class: 'h-card-lede nt-lede' }, 'It shows at the top of their screen, with a chime, and on their phone if they turned notifications on.'),
    h('div', { class: 'nt-field' }, h('span', { class: 'nt-label', id: 'nt-to-l' }, 'To'), chips, whoRow),
    h('label', { class: 'nt-field', for: 'nt-title' }, h('span', { class: 'nt-label' }, 'Title ', h('span', { class: 'nt-opt' }, 'optional')), titleIn),
    h('div', { class: 'nt-field' }, h('label', { class: 'nt-label', for: 'nt-body' }, 'Message'), bodyIn,
      h('div', { class: 'nt-under' }, h('label', { class: 'nt-sound' }, sound, h('span', null, 'Play a sound')), count)),
    h('div', { class: 'nt-go-row' }, previewEl, send),
    err,
    sentEl,
    autoEl);

  // ---- recipients
  function toPayload() {
    if (st.to === 'selected') return { kind: 'ids', ids: selected() };
    if (st.to === 'choose') return { kind: 'ids', ids: [...st.chosen] };
    if (st.to === 'one') return { kind: 'ids', ids: st.one ? [st.one] : [] };
    return { kind: st.to };
  }
  function kinds() {
    const list = GROUP_KINDS.slice();
    list.push(src.selection ? ['selected', 'Selected'] : ['choose', 'Choose people']);
    list.push(['one', 'One person']);
    return list;
  }
  function countOf(k) {
    if (k === 'selected') return selected().length;
    if (k === 'choose') return st.chosen.size || null;
    if (k === 'one') return null;
    return st.info?.groups?.[k] ?? null;
  }
  function renderChips() {
    const key = JSON.stringify([st.to, kinds().map(([k]) => [k, countOf(k)])]);
    if (chips.__key === key) return;
    chips.__key = key;
    const had = chips.contains(document.activeElement) ? document.activeElement.dataset.kind : null;
    clear(chips);
    for (const [k, label] of kinds()) {
      const n = countOf(k);
      const on = st.to === k;
      const b = h('button', {
        class: `nt-chip${on ? ' is-on' : ''}${n === 0 ? ' is-empty' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(on),
        tabindex: on ? '0' : '-1', dataset: { kind: k },
        title: k === 'selected' && !n ? 'Tick writers in the table to choose them' : null,
      }, h('span', null, label), n !== null ? h('span', { class: 'nt-chip-n' }, String(n)) : null);
      b.addEventListener('click', () => choose(k));
      b.addEventListener('keydown', (e) => {
        const all = [...chips.querySelectorAll('.nt-chip')];
        const i = all.indexOf(b);
        const j = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? i - 1 : null;
        if (j === null) return;
        e.preventDefault();
        const t = all[(j + all.length) % all.length];
        choose(t.dataset.kind);
        chips.querySelector(`[data-kind="${t.dataset.kind}"]`)?.focus();
      });
      chips.append(b);
    }
    if (had) chips.querySelector(`[data-kind="${had}"]`)?.focus();
  }
  function choose(k) {
    st.to = k;
    renderChips();
    renderWho();
    schedulePreview();
    if (k === 'one' && !st.one) oneSel.focus();
  }
  function renderWho() {
    const ps = people().slice().sort((a, b) => a.name.localeCompare(b.name));
    oneSel.hidden = st.to !== 'one';
    chooseBox.hidden = st.to !== 'choose';
    whoRow.hidden = oneSel.hidden && chooseBox.hidden;
    if (!oneSel.hidden) {
      const groups = [
        ['Writers', ps.filter((w) => !w.isAdmin && w.approval !== 'pending' && w.approval !== 'declined')],
        ['Hosts', ps.filter((w) => w.isAdmin)],
        ['Waiting for approval', ps.filter((w) => !w.isAdmin && w.approval === 'pending')],
      ].filter(([, l]) => l.length);
      const key = JSON.stringify([st.one, groups.map(([g, l]) => [g, l.map((w) => [w.id, w.name])])]);
      if (oneSel.__key !== key) {
        oneSel.__key = key;
        fill(oneSel, h('option', { value: '', disabled: true, selected: !st.one }, 'Choose a person…'),
          groups.map(([g, l]) => h('optgroup', { label: g }, l.map((w) => h('option', { value: w.id, selected: w.id === st.one }, `${w.name} · @${w.username}`)))));
      }
    }
    if (!chooseBox.hidden) {
      const key = JSON.stringify(ps.map((w) => [w.id, w.name, st.chosen.has(w.id)]));
      if (chooseBox.__key !== key) {
        chooseBox.__key = key;
        fill(chooseBox, ps.map((w) => {
          const box = h('input', { type: 'checkbox', checked: st.chosen.has(w.id) });
          box.addEventListener('change', () => {
            if (box.checked) st.chosen.add(w.id);
            else st.chosen.delete(w.id);
            renderChips();
            schedulePreview();
          });
          return h('label', { class: 'nt-pick' }, box, h('span', null, w.name), h('small', null, `@${w.username}`));
        }));
      }
    }
  }
  oneSel.addEventListener('change', () => {
    st.one = oneSel.value;
    schedulePreview();
  });

  // ---- preview and send
  const names = (list) => (list.length <= 3 ? list.join(list.length === 2 ? ' and ' : ', ').replace(/, ([^,]*)$/, ' and $1') : `${list.slice(0, 3).join(', ')} and ${list.length - 3} more`);
  function renderPreview() {
    const p = st.preview;
    const needsOne = st.to === 'one' && !st.one;
    const needsPick = (st.to === 'selected' && !selected().length) || (st.to === 'choose' && !st.chosen.size);
    let lead = '';
    let detail = '';
    if (needsOne) lead = 'Choose a person.';
    else if (needsPick) lead = st.to === 'selected' ? 'Tick writers in the table to choose them.' : 'Tick the people to send it to.';
    else if (!p || st.previewKey !== JSON.stringify(toPayload())) lead = 'Counting…';
    else if (!p.count) lead = 'Nobody is in this group right now.';
    else {
      lead = `To ${p.count === 1 ? p.recipients[0] : `${p.count} people`}`;
      detail = p.count === 1 ? '' : `: ${names(p.recipients)}`;
      const push = p.push || 0;
      detail += push ? `. ${push === p.count ? (p.count === 1 ? 'Notifications on' : 'All with notifications on') : `${push} with notifications on`}.` : '.';
    }
    fill(previewEl, h('strong', null, lead), detail);
    const current = p && st.previewKey === JSON.stringify(toPayload());
    const n = current && !needsOne && !needsPick ? p.count : 0;
    send.disabled = st.sending || !n || !bodyIn.value.trim();
    send.textContent = st.sending ? 'Sending…' : n === 1 ? `Send to ${firstName(p.recipients[0])}` : n ? `Send to ${n} people` : 'Send';
  }
  let previewSeq = 0;
  const schedulePreview = debounce(async () => {
    const to = toPayload();
    const key = JSON.stringify(to);
    if ((to.kind === 'ids' && !to.ids.length)) {
      st.preview = null;
      st.previewKey = key;
      renderPreview();
      return;
    }
    const seq = ++previewSeq;
    try {
      const r = await api('/api/host/notify/preview', { to });
      if (seq !== previewSeq) return;
      st.preview = r;
      st.previewKey = key;
    } catch (e) {
      if (seq !== previewSeq) return;
      st.preview = null;
      err.textContent = e.message || 'Couldn’t count the recipients.';
    }
    renderPreview();
  }, 180);
  bodyIn.addEventListener('input', () => {
    count.textContent = `${bodyIn.value.length} / 300`;
    count.classList.toggle('is-near', bodyIn.value.length > 270);
    err.textContent = '';
    renderPreview();
  });
  titleIn.addEventListener('input', () => { err.textContent = ''; });
  bodyIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !send.disabled) {
      e.preventDefault();
      doSend();
    }
  });
  send.addEventListener('click', doSend);
  async function doSend() {
    const body = bodyIn.value.trim();
    if (!body || st.sending) return;
    st.sending = true;
    err.textContent = '';
    renderPreview();
    try {
      const r = await api('/api/host/notify', { to: toPayload(), title: titleIn.value.trim(), body, sound: sound.checked });
      const who = r.recipients === 1 && st.preview?.recipients?.length === 1 ? st.preview.recipients[0] : `${r.recipients} people`;
      toast(`Sent to ${who}.`);
      titleIn.value = '';
      bodyIn.value = '';
      count.textContent = '0 / 300';
      st.sending = false;
      await loadInfo(true);
      schedulePreview();
    } catch (e) {
      st.sending = false;
      err.textContent = e.network ? 'You seem to be offline; nothing was sent. Try again when you’re back.' : e.message || 'Couldn’t send that. Try again.';
    }
    renderPreview();
  }

  // ---- sent list and automatic messages
  function meter(s) {
    const of = Math.max(1, s.recipients);
    return h('span', { class: 'nt-meter', 'aria-hidden': 'true' },
      h('span', { class: 'nt-meter-d', style: { width: `${Math.round((100 * s.delivered) / of)}%` } }),
      h('span', { class: 'nt-meter-r', style: { width: `${Math.round((100 * s.read) / of)}%` } }));
  }
  function renderSent() {
    const list = st.info?.sent || [];
    if (!list.length) {
      fill(sentEl, h('h3', { class: 'nt-h3' }, 'Sent'), h('p', { class: 'nt-none' }, 'Nothing sent yet. Messages you send show here, with how many people got and read them.'));
      return;
    }
    const shown = st.showAll ? list : list.slice(0, 4);
    const more = list.length - shown.length;
    fill(sentEl,
      h('h3', { class: 'nt-h3' }, 'Sent'),
      h('ol', { class: 'nt-sent' }, shown.map((s) => h('li', { class: 'nt-sent-item' },
        h('p', { class: 'nt-sent-meta' }, h('time', { datetime: new Date(s.at).toISOString() }, when(s.at)), h('span', { class: 'nt-dot', 'aria-hidden': 'true' }, '·'),
          `To ${s.label}${s.to?.kind === 'ids' ? '' : ` (${s.recipients})`}`, s.by !== myId() && s.byName ? ` · from ${firstName(s.byName)}` : ''),
        s.title ? h('p', { class: 'nt-sent-title' }, s.title) : null,
        h('p', { class: 'nt-sent-body' }, s.body),
        h('p', { class: 'nt-sent-stats' }, meter(s), h('span', null, `${s.delivered} of ${s.recipients} delivered · ${s.read} read`))))),
      more > 0 || st.showAll ? h('button', { class: 'btn-link nt-sent-all', type: 'button', onClick: () => { st.showAll = !st.showAll; renderSent(); } }, st.showAll ? 'Show fewer' : `Show all ${list.length}`) : null);
  }
  function renderAuto() {
    const s = st.info?.settings;
    autoEl.hidden = !s;
    if (!s) return;
    const key = JSON.stringify(s);
    if (autoEl.__key === key) return;
    autoEl.__key = key;
    const on = AUTO.filter(([k]) => s[k]).length;
    fill(autoEl,
      h('summary', null, 'Automatic messages', h('span', { class: 'nt-auto-n' }, on === AUTO.length ? 'all on' : on ? `${on} of ${AUTO.length} on` : 'all off')),
      h('div', { class: 'nt-auto-list' }, AUTO.map(([k, label, help]) => {
        const box = h('input', { type: 'checkbox', role: 'switch', checked: !!s[k] });
        box.addEventListener('change', async () => {
          box.disabled = true;
          try {
            await api('/api/host/settings', { scoring: { [`notify.${k}`]: box.checked } });
            st.info.settings = { ...st.info.settings, [k]: box.checked };
            toast(`${label}: ${box.checked ? 'on' : 'off'}.`);
          } catch (e) {
            box.checked = !box.checked;
            toast(e.message || 'Couldn’t save that.', { kind: 'error' });
          }
          box.disabled = false;
          autoEl.__key = '';
          const open = autoEl.open;
          renderAuto();
          autoEl.open = open;
          autoEl.querySelector(`[data-k="${k}"] input`)?.focus();
        });
        return h('label', { class: 'h-check nt-auto-item', dataset: { k } }, box, h('span', null, h('span', { class: 'h-field-label' }, label), h('small', { class: 'h-field-help' }, help)));
      })));
  }
  async function loadInfo(force = false) {
    if (st.dead) return;
    if (!force && Date.now() - st.infoAt < 4000) return;
    st.infoAt = Date.now();
    const before = st.info?.groups?.[st.to];
    try {
      st.info = await api('/api/host/notify');
    } catch (e) {
      if (e.status === 404 && !st.info) {
        st.dead = true;
        fill(container, h('h2', null, 'Send a message'), h('p', { class: 'h-card-lede' }, 'Messages aren’t available on this server yet.'));
      }
      return;
    }
    renderChips();
    renderSent();
    renderAuto();
    // The group itself changed (someone fell behind, was let back in): count it again.
    if (st.info?.groups && before !== undefined && st.info.groups[st.to] !== before) schedulePreview();
  }

  // ---- life cycle
  src.subscribe?.(() => {
    chips.__key = '';
    renderChips();
    if (st.to === 'selected') schedulePreview();
  });
  renderChips();
  renderWho();
  renderPreview();
  loadInfo(true);
  schedulePreview();
  const timer = setInterval(() => {
    if (!container.isConnected) return;
    if (document.visibilityState === 'visible') loadInfo();
  }, 12_000);
  return {
    el: container,
    // host.js: after each load of the host view (or with a new adapter).
    update(next) {
      if (next && typeof next === 'object') {
        const a = adapt(next, opts);
        src = {
          view: Array.isArray(next.writers) || typeof next.view === 'function' ? a.view : src.view,
          selection: a.selection || src.selection,
          subscribe: src.subscribe,
        };
      }
      renderWho();
      renderChips();
      loadInfo();
      if (st.to === 'selected' || st.to === 'one') schedulePreview();
    },
    destroy() {
      clearInterval(timer);
      st.dead = true;
    },
  };
}
