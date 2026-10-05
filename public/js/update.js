// A new build of Writehaven while this page is open. A deploy swaps the files and restarts the
// server; a page that stays open keeps running the build it loaded, and the modules it loads
// later, or the answers it expects, may no longer match.
//
// The page's own build is the ?v= on its module URLs (server.js buildVersion()); the server's
// comes with /api/session, with the first event of every stream (net.js relays it as
// `wh:build`) and from GET /api/build. They're compared at the start, after every stream
// (re)connection (a restart drops the streams), whenever the page becomes visible again and,
// on a page with no stream open (the anthology, a post page), every two minutes.
//   - The live page and the projector (/live, /live?wall, /archive, and / signed out) reload by
//     themselves after a random 5–30 s, at the same address (so ?wall stays), checking once more
//     first. A page still behind after a reload waits twice as long before the next one.
//   - Every other page (the writer's, the host's) gets a quiet notice in its flow: "Writehaven
//     was updated. Reload when you reach a pause.", with Reload. It waits for a pause in typing,
//     never takes the focus and never covers the text: on the writer's page it is a grid row of
//     its own under the header (the editor gets shorter), elsewhere it sits above the page. Reload
//     first sends the writer's queued words (SyncManager#settle, at most 3 s; anything left stays
//     queued on the device and is sent after the reload), then reloads once the server answers.
// app.js starts it on every page: watchBuild({ session, path }).

import { h } from './ui.js';
import { api, postsInFlight, streamsOpen } from './net.js';

const AUTO_MIN_MS = 5000;
const AUTO_MAX_MS = 30_000;
const AUTO_LONGEST_MS = 10 * 60_000;
const POLL_MS = 120_000;
const SETTLE_MS = 3000;
const PAUSE_MS = 2500; // typing pause before the notice appears
const RELOADS = 'wh-build-reloads'; // sessionStorage: { to: build, n } automatic reloads towards a build

let started = false;
let own = null; // this page's build
let auto = false; // reloads by itself (live page, projector, anthology)
let reloadTimer = 0;
let lastPoll = 0;
let lastInput = 0;
let notice = null; // the notice, once shown
let waiting = false; // the notice waits for a pause in typing

// This page's build: the ?v= of this module's URL (the server adds it to every import), else of
// app.js's script tag. None (a harness page) means nothing to compare.
function ownBuild() {
  const pick = (u) => {
    try {
      const v = new URL(u, location.href).searchParams.get('v');
      return v && v !== '__V__' && /^[\w-]{1,64}$/.test(v) ? v : null;
    } catch {
      return null;
    }
  };
  return pick(import.meta.url) || pick(document.querySelector('script[src*="/js/app.js"]')?.getAttribute('src') || '');
}

export function watchBuild({ session = null, path = location.pathname } = {}) {
  if (started) return;
  own = ownBuild();
  if (!own) return;
  started = true;
  const p = String(path || '/').replace(/\/+$/, '') || '/';
  auto = p === '/live' || p === '/archive' || (p === '/' && !session?.user);
  if (!auto) {
    const typed = () => { lastInput = Date.now(); };
    for (const ev of ['keydown', 'beforeinput', 'compositionupdate']) document.addEventListener(ev, typed, { capture: true, passive: true });
  }
  window.addEventListener('wh:build', (e) => check(e.detail));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') poll();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible' && !streamsOpen()) poll(true);
  }, POLL_MS);
  check(session?.build);
}

// The server's build, from a stream's first event or an answer.
function check(build) {
  if (typeof build !== 'string' || !build) return;
  if (build === own) {
    // Back on this page's build (a deploy rolled back): nothing to do any more.
    cancelReload();
    removeNotice();
    return;
  }
  if (auto) scheduleReload(build);
  else showNotice();
}

async function poll(force = false) {
  const t = Date.now();
  if (!force && t - lastPoll < 10_000) return;
  lastPoll = t;
  try {
    check((await api('/api/build'))?.build);
  } catch { /* offline or restarting: the stream's reconnection will tell */ }
}

// ---------------------------------------------------------------- the live page and projector
function reloadsTowards(build) {
  try {
    const r = JSON.parse(sessionStorage.getItem(RELOADS) || 'null');
    return r && r.to === build ? Number(r.n) || 0 : 0;
  } catch {
    return 0;
  }
}
function scheduleReload(build) {
  if (reloadTimer) return;
  const spread = AUTO_MIN_MS + Math.random() * (AUTO_MAX_MS - AUTO_MIN_MS); // not every screen at once
  const delay = Math.min(spread * 2 ** reloadsTowards(build), AUTO_LONGEST_MS);
  reloadTimer = setTimeout(async () => {
    let now = null;
    try {
      now = (await api('/api/build'))?.build || null;
    } catch { /* restarting or offline */ }
    reloadTimer = 0;
    if (!now) {
      scheduleReload(build); // not reachable: a reload would show an error page, so later
      return;
    }
    if (now === own) return;
    try {
      sessionStorage.setItem(RELOADS, JSON.stringify({ to: now, n: reloadsTowards(now) + 1 }));
    } catch { /* no storage: no back-off either */ }
    location.reload();
  }, delay);
}
function cancelReload() {
  clearTimeout(reloadTimer);
  reloadTimer = 0;
}

// ---------------------------------------------------------------- the notice
function showNotice() {
  if (notice || waiting) return;
  waiting = true;
  const attempt = () => {
    if (!waiting) return; // back on this build meanwhile
    // Never under someone's fingers, nor behind a dialog.
    if (Date.now() - lastInput < PAUSE_MS || document.querySelector('dialog[open]')) {
      setTimeout(attempt, 800);
      return;
    }
    waiting = false;
    const btn = h('button', { type: 'button', class: 'btn up-note-go' }, 'Reload');
    btn.addEventListener('click', () => reloadNow(btn));
    notice = h('div', { class: 'up-note', role: 'status', 'aria-live': 'polite' },
      h('div', { class: 'up-note-in' },
        h('p', { class: 'up-note-t' }, h('b', null, 'Writehaven was updated.'), ' Reload when you reach a pause.'),
        btn));
    place();
    keepPlaced();
  };
  attempt();
}
function removeNotice() {
  waiting = false;
  if (!notice) return;
  notice.parentElement?.classList.remove('has-up-note');
  notice.remove();
  notice = null;
  window.dispatchEvent(new Event('wh:layout'));
}
// In the page's flow: on the writer's page a grid row of its own after the banner row (app.css
// .has-up-note), elsewhere right above the page. notify.js places its floating banner below it
// (`wh:layout`), so that never covers it either.
function place() {
  if (!notice) return;
  const banner = document.querySelector('.w-app > .w-banner');
  const root = document.getElementById('app');
  if (banner) {
    if (notice.previousElementSibling === banner) return;
    notice.parentElement?.classList.remove('has-up-note');
    banner.after(notice);
    banner.parentElement.classList.add('has-up-note');
  } else if (root && notice.nextElementSibling !== root) {
    notice.parentElement?.classList.remove('has-up-note');
    root.before(notice);
  } else return;
  window.dispatchEvent(new Event('wh:layout'));
}
// The page can turn into another in place (the approval card into the writer's page).
let observing = false;
function keepPlaced() {
  const root = document.getElementById('app');
  if (observing || !root || typeof MutationObserver !== 'function') return;
  observing = true;
  const mo = new MutationObserver(() => place());
  mo.observe(root, { childList: true });
  mo.observe(document.body, { attributes: true, attributeFilter: ['data-screen'] });
}

async function reloadNow(btn) {
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'Reloading…';
  try {
    // A field being edited saves when it loses the focus (the post title does): now, then.
    const a = document.activeElement;
    if (a && a !== document.body && !notice?.contains(a) && typeof a.blur === 'function') a.blur();
    await settle();
    // Only to a server that answers: mid-restart a reload would land on an error page.
    if (await reachable(10_000)) {
      location.reload();
      return;
    }
  } catch { /* the page stays as it is: Reload again later */ }
  btn.disabled = false;
  btn.textContent = 'Reload';
}
async function reachable(ms) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      await api('/api/build', undefined, { timeoutMs: 4000 });
      return true;
    } catch {
      if (Date.now() >= until) return false;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// The writer's queued words, sent and confirmed if the server takes them within SETTLE_MS (they
// are kept on this device either way: sync.js copies its queue at pagehide), then any other save
// still on its way (a title saved on blur).
async function settle() {
  const until = Date.now() + SETTLE_MS;
  const managers = [...(globalThis.__whSyncManagers || [])];
  await Promise.race([
    Promise.all(managers.map((m) => Promise.resolve(m.settle?.(SETTLE_MS)).catch(() => false))),
    new Promise((r) => setTimeout(r, SETTLE_MS)),
  ]);
  while (postsInFlight() > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
}
