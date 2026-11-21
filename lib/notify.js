// Notices to people, groups or everyone (SPEC §22), and co-hosts (SPEC §21), registered
// through the route hook like lib/uploads.js (each handler does its own auth, CSRF and
// host checks). A notice reaches its recipient three ways:
//   1. at once on every open `me` event stream as `event: notice` (server.js meSend);
//   2. as a Web Push (lib/webpush.js) to the devices they allowed, when no page took it: a
//      page acknowledges a notice it showed (POST /api/me/notices/seen); with no page open, or
//      no acknowledgement within ackWaitMs (a hidden tab without permission, a dead stream),
//      the push goes out;
//   3. in GET /api/me/notices (the bell: the last 20), with read state per notice.
// Automatic notices, each off with the setting `notify.<kind>` = false: approved (while
// away), the 15-minute warning when behind, break start and end, and "you're out".
// Times inside a notice's title or body are templates ({t}) with epoch ms in `times`
// (SPEC §24): the browser and the service worker format them in the device's time.
//
// State: <state dir>/notify.json (notices, sent messages, push subscriptions, which automatic
// notices went out), written atomically (temp file, fsync, rename) by lib/store.js's saver;
// VAPID keys in <state dir>/vapid.json (mode 600).

import crypto from 'node:crypto';
import path from 'node:path';
import { HttpError, cleanLine } from './party.js';
import { loadState, createSaver, cleanTempFiles } from './store.js';
import { sanitizeText } from './sanitize.js';
import { loadVapidKeys, createPusher, checkSubscription, PushError } from './webpush.js';
import { setHost } from './cohosts.js';

export const GROUPS = Object.freeze({
  all: 'Everyone',
  writers: 'All writers',
  hosts: 'Hosts',
  'at-risk': 'At risk',
  out: 'Out',
  'not-started': 'Not started',
  pending: 'Waiting for approval',
});
export const AUTO_KINDS = Object.freeze(['approved', 'warning', 'breaks', 'out']);
const KEEP_PER_USER = 30; // notices kept per person (the bell shows 20)
const SHOW = 20;
const KEEP_SENT = 200;
const SUBS_PER_USER = 10;
const MAX_TITLE = 80;
const MAX_BODY = 300;
const MESSAGE_FRESH_MS = 6 * 3600_000; // a host message shows as a banner / is pushed this long
const AUTO_FRESH_MS = 10 * 60_000; // an approval or "out" older than this is not announced
const BREAK_FRESH_MS = 5 * 60_000;
const UNDO_MS = 2 * 60_000 + 5_000; // "Mark as out" and "Don't count" can be undone for 2 minutes
const PUSH_CONCURRENCY = 6;

const isPlainObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const nid = () => `n${crypto.randomBytes(9).toString('base64url')}`;
const sid = (token) => crypto.createHash('sha256').update(String(token)).digest('base64url').slice(0, 22);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// A message body: control and invisible characters out (lib/sanitize.js), single line breaks
// kept (at most one blank line), trimmed, at most `max` characters.
export function cleanBody(s, max = MAX_BODY) {
  if (typeof s !== 'string') return null;
  const v = sanitizeText(s.replace(/\r\n?/g, '\n')).replace(/[\t\v\f]/g, ' ').replace(/[  ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return [...v].slice(0, max).join('');
}

function readJson(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] || 0) > limit) {
      req.resume();
      reject(new HttpError(413, 'Request body too large'));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on('end', () => {
      if (size > limit) return reject(new HttpError(413, 'Request body too large'));
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        const v = JSON.parse(text);
        if (!isPlainObject(v)) return reject(new HttpError(400, 'Body must be a JSON object'));
        return resolve(v);
      } catch {
        return reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// party: lib/party.js. meSend(uid, event, data) -> number of streams written (server.js);
// meTick(): push fresh `me` views now. flushParty(): the state file on disk (host decisions).
// push: { allowHosts, allowHttp } (tests with a local fake push service only).
export function createNotify({
  dir, party, meSend = null, meTick = null, flushParty = null, log = console,
  ackWaitMs = 10_000, autoMs = 2_000, warnMs = 10_000, push = {}, subject = null,
} = {}) {
  if (!dir || !party) throw new Error('createNotify: dir and party are required');
  const now = () => party.now();
  const file = path.join(dir, 'notify.json');
  cleanTempFiles(file, { log });
  const raw = loadState(file, { log });
  const store = {
    v: 1,
    since: Number.isFinite(raw?.since) ? raw.since : now(),
    notices: isPlainObject(raw?.notices) ? raw.notices : {},
    sent: Array.isArray(raw?.sent) ? raw.sent : [],
    subs: isPlainObject(raw?.subs) ? raw.subs : {},
    auto: isPlainObject(raw?.auto) ? raw.auto : {},
  };
  const saver = createSaver(file, () => store, { delayMs: 300, log });
  if (!raw) saver.schedule();
  let keys = null;
  let pusher = null;
  try {
    keys = loadVapidKeys(path.join(dir, 'vapid.json'), { log });
    pusher = createPusher({ keys, subject: subject || party.publicUrl || 'https://writehaven.example.org', allowHosts: push.allowHosts || null, allowHttp: !!push.allowHttp });
  } catch (e) {
    log.error(`[notify] Web Push is off: ${e.message}`);
  }
  const waits = new Map(); // `${uid}|${id}` -> timer: push unless a page acknowledges first
  const timers = [];
  const queue = [];
  let active = 0;
  let stopped = false;

  const setting = (kind) => party.state.settings.scoring[`notify.${kind}`] !== false;
  const listOf = (uid) => (Array.isArray(store.notices[uid]) ? store.notices[uid] : (store.notices[uid] = []));
  const findNotice = (uid, id) => (store.notices[uid] || []).find((n) => n.id === id) || null;
  const sentById = (id) => store.sent.find((s) => s.id === id) || null;
  const urlFor = (u) => (u && u.isAdmin ? '/host' : '/write');

  // What the browser gets (stream, GET, push): no ids of other people, no delivery details.
  function view(n) {
    return {
      id: n.id, at: n.at, kind: n.kind, from: n.from, fromName: n.fromName ?? null,
      title: n.title || '', body: n.body || '', times: n.times || null, url: n.url || '/',
      sound: !!n.sound, exp: n.exp ?? null, read: !!n.read, tag: n.tag || n.id,
    };
  }

  // ------------------------------------------------------------ delivery
  // spec: { kind, from, fromName?, title, body, times?, url?, sound, exp?, urgent?, msg?, id? }
  function deliver(uid, spec) {
    const u = party.userById(uid);
    if (!u || stopped) return null;
    const n = { id: spec.id || nid(), at: now(), url: urlFor(u), ...spec };
    delete n.urgent;
    const list = listOf(uid);
    list.push(n);
    if (list.length > KEEP_PER_USER) list.splice(0, list.length - KEEP_PER_USER);
    saver.schedule();
    let streams = 0;
    try {
      streams = typeof meSend === 'function' ? meSend(uid, 'notice', view(n)) || 0 : 0;
    } catch (e) {
      log.error('[notify] stream write failed:', e && e.message);
    }
    const job = { urgent: !!spec.urgent };
    if (streams > 0) armFallback(uid, n, job);
    else pushNotice(uid, n, job);
    return n;
  }
  function armFallback(uid, n, job) {
    const key = `${uid}|${n.id}`;
    clearTimeout(waits.get(key));
    const t = setTimeout(() => {
      waits.delete(key);
      const cur = findNotice(uid, n.id);
      if (cur && !cur.seen && !cur.read) pushNotice(uid, cur, job);
    }, ackWaitMs);
    t.unref?.();
    waits.set(key, t);
  }
  function cancelFallback(uid, id) {
    const key = `${uid}|${id}`;
    clearTimeout(waits.get(key));
    waits.delete(key);
  }

  // Subscriptions whose browser session still exists (signing out there stops its pushes).
  function liveSubs(uid) {
    const list = store.subs[uid];
    if (!Array.isArray(list) || !list.length) return [];
    const live = new Set();
    for (const [t, s] of Object.entries(party.state.sessions)) if (s && s.userId === uid && party.sessionUserId(t) === uid) live.add(sid(t));
    const keep = list.filter((s) => !s.sid || live.has(s.sid));
    if (keep.length !== list.length) {
      if (keep.length) store.subs[uid] = keep;
      else delete store.subs[uid];
      saver.schedule();
    }
    return keep;
  }
  function pushNotice(uid, n, { urgent = false } = {}) {
    if (!pusher || stopped) return 0;
    const t = now();
    if (n.exp && n.exp <= t) return 0;
    const subs = liveSubs(uid);
    if (!subs.length) return 0;
    // No secrets: what the notification shows, its times, and where a tap goes.
    const payload = { id: n.id, at: n.at, kind: n.kind, from: n.from, fromName: n.fromName ?? null, title: n.title, body: n.body, times: n.times || null, url: n.url, sound: !!n.sound, tag: n.tag || n.id };
    for (const s of subs) enqueue({ uid, id: n.id, endpoint: s.endpoint, payload, urgency: urgent ? 'high' : 'normal', tries: 0, exp: n.exp || t + MESSAGE_FRESH_MS });
    return subs.length;
  }
  function enqueue(job) {
    queue.push(job);
    pump();
  }
  function pump() {
    while (!stopped && active < PUSH_CONCURRENCY && queue.length) {
      const job = queue.shift();
      const sub = (store.subs[job.uid] || []).find((s) => s.endpoint === job.endpoint);
      if (!sub) continue; // pruned meanwhile
      active++;
      pusher.send({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, job.payload, { ttl: Math.max(60, Math.round((job.exp - now()) / 1000)), urgency: job.urgency })
        .then((r) => onPushResult(job, r))
        .catch((e) => log.error('[notify] push failed:', e && e.message))
        .finally(() => {
          active--;
          pump();
        });
    }
  }
  function onPushResult(job, r) {
    const list = store.subs[job.uid] || [];
    const sub = list.find((s) => s.endpoint === job.endpoint);
    if (r.ok) {
      if (sub) Object.assign(sub, { okAt: now(), fails: 0, lastError: null });
      const n = findNotice(job.uid, job.id);
      if (n && !n.pushed) {
        n.pushed = now();
        if (n.msg) markIn(n.msg, 'delivered', job.uid);
      }
      saver.schedule();
      return;
    }
    if (r.gone) {
      removeSub(job.uid, job.endpoint);
      return;
    }
    if (sub) Object.assign(sub, { fails: (sub.fails || 0) + 1, lastError: `${r.status || ''} ${r.error || ''}`.trim().slice(0, 200) });
    saver.schedule();
    // Refused for good (bad key, our credentials): drop it after a few tries.
    if ((r.status === 401 || r.status === 403 || r.code === 'unsupported-service' || r.code === 'bad-subscription') && sub && sub.fails >= 3) {
      removeSub(job.uid, job.endpoint);
      return;
    }
    // Busy or down (429, 5xx, network): retry twice while the notice is fresh.
    const transient = r.status === 0 || r.status === 429 || r.status >= 500;
    if (transient && !r.code && job.tries < 2 && job.exp > now() + 30_000) {
      const wait = Math.min(120, r.retryAfter ?? (job.tries ? 30 : 5)) * 1000;
      job.tries++;
      const t = setTimeout(() => enqueue(job), wait);
      t.unref?.();
      timers.push(t);
    } else if (r.status !== 0 || job.tries >= 2) {
      log.error(`[notify] push refused (${r.status} ${r.error || ''}) for ${job.uid}`);
    }
  }
  function removeSub(uid, endpoint) {
    const list = store.subs[uid];
    if (!Array.isArray(list)) return;
    store.subs[uid] = list.filter((s) => s.endpoint !== endpoint);
    if (!store.subs[uid].length) delete store.subs[uid];
    saver.schedule();
  }
  function markIn(msgId, field, uid) {
    const s = sentById(msgId);
    if (!s) return;
    if (!Array.isArray(s[field])) s[field] = [];
    if (!s[field].includes(uid)) s[field].push(uid);
  }

  // ------------------------------------------------------------ groups (the host view's status data)
  function groupRows(hostId) {
    const v = party.hostView(hostId);
    const ws = v.writers.filter((w) => w.id !== hostId);
    const approved = (w) => w.approval === 'approved';
    const writer = (w) => approved(w) && (!w.isAdmin || !!w.joinedAt); // a host who never writes isn't a writer
    return {
      all: ws.filter((w) => w.approval !== 'declined'),
      writers: ws.filter(writer),
      hosts: ws.filter((w) => w.isAdmin),
      'at-risk': ws.filter((w) => writer(w) && w.status === 'at-risk'),
      out: ws.filter((w) => writer(w) && w.out),
      'not-started': ws.filter((w) => writer(w) && w.status === 'not-started'),
      pending: ws.filter((w) => w.approval === 'pending'),
    };
  }
  // to: { kind, ids? } -> { kind, ids, label }
  function resolveTo(hostId, to) {
    if (!isPlainObject(to)) throw new HttpError(400, 'Choose who gets the message', { code: 'bad_to' });
    if (to.kind === 'ids') {
      if (!Array.isArray(to.ids)) throw new HttpError(400, 'Choose who gets the message', { code: 'bad_to' });
      const ids = [...new Set(to.ids.filter((x) => typeof x === 'string'))].slice(0, 1000).filter((id) => party.userById(id));
      const names = ids.map((id) => party.userById(id).name);
      const label = names.length <= 3 ? names.join(', ').replace(/, ([^,]*)$/, ' and $1') : `${names.length} people`;
      return { kind: 'ids', ids, label };
    }
    if (!Object.hasOwn(GROUPS, to.kind)) throw new HttpError(400, 'Choose who gets the message', { code: 'bad_to' });
    return { kind: to.kind, ids: groupRows(hostId)[to.kind].map((w) => w.id), label: GROUPS[to.kind] };
  }
  const pushPeople = (ids) => ids.filter((id) => liveSubs(id).length > 0).length;
  const byName = (a, b) => a.localeCompare(b);

  // ------------------------------------------------------------ automatic notices
  // Who gets the break notices (they're about hours: not someone who left the party, SPEC §33).
  function writersNow() {
    return Object.values(party.state.users).filter((u) => party.isApproved(u) && party.inRound(u) && (!u.isAdmin || u.joinedAt) && !Number.isFinite(u.leftAt)); // this round's (lib/rounds.js)
  }
  function once(key) {
    if (store.auto[key]) return false;
    store.auto[key] = now();
    saver.schedule();
    return true;
  }
  function autoTick() {
    const t = now();
    const users = Object.values(party.state.users);
    // Approved (SPEC §22: "You're approved — come and write").
    for (const u of users) {
      if (u.isAdmin || u.approval !== 'approved' || !Number.isFinite(u.approvalAt)) continue;
      if (u.approvalAt < store.since || t - u.approvalAt > AUTO_FRESH_MS) continue;
      if (!once(`approved:${u.id}:${u.approvalAt}`) || !setting('approved') || party.phase === 'ended') continue;
      deliver(u.id, {
        kind: 'approved', from: 'system', sound: true, urgent: true, exp: t + 12 * 3600_000,
        title: 'You’re approved — come and write',
        body: party.phase === 'lobby' ? 'The host let you in. The party hasn’t started yet; your page opens for writing when it does.' : 'The host let you in. Your first hour starts when you open the editor.',
      });
    }
    // Out (gently): at once for a missed hour; after the undo window for the host's own actions.
    for (const u of users) {
      if (!u.out || !Number.isFinite(u.outAt) || u.outAt < store.since || t - u.outAt > AUTO_FRESH_MS + UNDO_MS) continue;
      if ((u.outVia === 'host' || u.outVia === 'reject') && t - u.outAt < UNDO_MS) continue;
      if (!once(`out:${u.id}:${u.outAt}`) || !setting('out') || !party.isApproved(u) || party.phase !== 'running') continue;
      deliver(u.id, { kind: 'out', from: 'system', sound: true, urgent: false, exp: t + 12 * 3600_000, ...outText(u) });
    }
    // Breaks: start and end (each break's mode decides the wording, SPEC §19).
    if (party.phase === 'running') {
      for (const b of party.breaksView(t)) {
        if (b.startAt <= t && t < b.endAt && t - b.startAt < BREAK_FRESH_MS && once(`break-start:${b.id}`) && setting('breaks')) {
          for (const u of writersNow()) deliver(u.id, { kind: 'break', from: 'system', sound: true, urgent: false, exp: b.endAt, tag: `break-${b.id}`, ...breakText(u, b, 'start', t) });
        }
        if (b.endAt <= t && b.startAt < b.endAt && t - b.endAt < BREAK_FRESH_MS && once(`break-end:${b.id}`) && setting('breaks')) {
          for (const u of writersNow()) deliver(u.id, { kind: 'break-end', from: 'system', sound: true, urgent: false, exp: t + 20 * 60_000, tag: `break-${b.id}`, ...breakText(u, b, 'end', t) });
        }
      }
    }
    // Forget dedupe keys after two days.
    for (const [k, at] of Object.entries(store.auto)) if (t - at > 48 * 3600_000) delete store.auto[k];
  }
  function outText(u) {
    const keep = 'but nothing else changes: keep writing, your posts still stream and go in the anthology. The host can bring you back in, but only for a very good reason.';
    if (u.outVia === 'host') return { title: 'The host marked you out', body: `You’re out of the challenge, ${keep}` };
    const k = Number.isInteger(u.outAuto) ? u.outAuto : null;
    let h = null;
    try {
      h = k === null ? null : party.progressOf(u.id)?.prog.hours.find((x) => x.k === k) || null;
    } catch { /* numbers are a nicety */ }
    if (u.outVia === 'reject') return { title: k === null ? 'An hour didn’t count after review' : `Hour ${k + 1} didn’t count after review`, body: `So you’re out of the challenge, ${keep}` };
    const title = h ? `Hour ${k + 1} ended at ${Math.round(h.credited)} of ${h.target}` : 'You missed an hour';
    return { title, body: `So you’re out of the challenge, ${keep}` };
  }
  function current(u, t) {
    if (!u.joinedAt) return null;
    try {
      const p = party.progressOf(u.id, { now: t });
      return p ? { cur: p.prog.current, passesLeft: p.prog.passesLeft } : null;
    } catch {
      return null;
    }
  }
  function breakText(u, b, edge, t) {
    const label = b.label || 'Break';
    const c = current(u, t);
    const cur = c && c.cur;
    if (edge === 'start') {
      if (b.mode === 'reduce') {
        const less = cur && Number.isFinite(cur.target) && Number.isFinite(cur.baseTarget) && cur.target < cur.baseTarget
          ? ` This hour needs ${cur.target} words instead of ${cur.baseTarget}.` : ' This hour needs fewer words.';
        return { title: label, body: `Until {t}.${less} Keep writing if you like.`, times: { t: b.endAt } };
      }
      return { title: label, body: 'Your hour is paused until {t}. Keep writing if you like; nothing is required until then.', times: { t: b.endAt } };
    }
    const again = b.mode === 'reduce' ? '' : 'The clock runs again. ';
    if (cur && !cur.free) {
      const have = Math.round((cur.credited || 0) + (cur.pending || 0));
      return { title: `${label} is over`, body: `${again}Hour ${cur.k + 1} runs until {t}: ${have} of ${cur.target} so far.`, times: { t: cur.endAt } };
    }
    return { title: `${label} is over`, body: b.mode === 'reduce' ? 'Back to the usual targets.' : 'The hour clocks run again.' };
  }
  function warnTick() {
    if (party.phase !== 'running' || !setting('warning')) return;
    const t = now();
    const hourMs = (party.S.hourLengthMin || 60) * 60_000;
    const mark = Math.min(15 * 60_000, hourMs / 4); // 15 minutes (shorter test hours: a quarter)
    const floor = Math.min(5 * 60_000, mark / 3);
    for (const u of party.writers()) {
      if (u.out) continue;
      const c = current(u, t);
      const cur = c && c.cur;
      if (!cur || cur.free || !cur.behind || cur.inBreak) continue;
      const left = cur.endAt - t;
      if (left > mark || left <= floor) continue;
      if (!once(`warn:${u.id}:${cur.k}`)) continue;
      const have = Math.round((cur.credited || 0) + (cur.pending || 0));
      const need = Math.max(0, Math.ceil(cur.target - have));
      const mins = Math.max(1, Math.round(left / 60_000));
      const pass = c.passesLeft > 0 ? ` Or take this hour off: you have ${c.passesLeft === 1 ? '1 free hour' : `${c.passesLeft} free hours`} left.` : '';
      deliver(u.id, {
        kind: 'warning', from: 'system', sound: true, urgent: true, exp: cur.endAt,
        title: `${plural(mins, 'minute')} left in hour ${cur.k + 1}`,
        body: `You’re at ${have} of ${cur.target}. About ${Math.ceil(need / mins)} words a minute until {t} gets you there.${pass}`,
        times: { t: cur.endAt },
      });
    }
  }
  const guard = (name, fn) => () => {
    try {
      fn();
    } catch (e) {
      log.error(`[notify] ${name}:`, e);
    }
  };

  // ------------------------------------------------------------ routes
  const hostPath = (p, rest) => p === `/api/host/${rest}` || p === `/api/admin/${rest}`;
  const json = (h, status, obj) => h.sendJson(status, obj);
  function csrfOk(req) {
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    return ct === 'application/json' && req.headers['x-wh'] === '1';
  }
  // A POST route: { who: 'user' | 'host' }; handler(body, h, req) -> object for { ok: true, ... }.
  function post(match, who, handler) {
    return {
      method: 'POST',
      match,
      async handle(req, res, h) {
        const u = h.ctx.user;
        if (who === 'host' && !u?.isAdmin) {
          req.resume();
          return json(h, 404, { error: 'Not found' });
        }
        if (!csrfOk(req)) {
          req.resume();
          return json(h, 403, { error: 'Forbidden: JSON with the X-WH header required', code: 'csrf' });
        }
        if (!u) {
          req.resume();
          return json(h, 401, { error: 'Please sign in first', code: 'auth' });
        }
        const body = await readJson(req);
        const out = await handler(body, h, req);
        return json(h, 200, { ok: true, ...(out || {}) });
      },
    };
  }
  function get(match, who, handler) {
    return {
      method: 'GET',
      match,
      handle(req, res, h) {
        const u = h.ctx.user;
        if (who === 'host' && !u?.isAdmin) return json(h, 404, { error: 'Not found' });
        if (who !== 'none' && !u) return json(h, 401, { error: 'Please sign in first', code: 'auth' });
        return json(h, 200, handler(h));
      },
    };
  }
  const idsOf = (body) => (body.ids === 'all' ? 'all' : Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string').slice(0, 100) : []);

  const routes = [
    // ---- the person's own notices
    get((p) => (p === '/api/me/notices' ? {} : null), 'user', (h) => {
      const list = store.notices[h.ctx.userId] || [];
      return { notices: list.slice(-SHOW).reverse().map(view), unread: list.filter((n) => !n.read).length, serverNow: now() };
    }),
    post((p) => (p === '/api/me/notices/read' ? {} : null), 'user', (body, h) => {
      const uid = h.ctx.userId;
      const ids = idsOf(body);
      const t = now();
      for (const n of store.notices[uid] || []) {
        if (ids !== 'all' && !ids.includes(n.id)) continue;
        if (!n.read) n.read = t;
        if (!n.seen) n.seen = t;
        cancelFallback(uid, n.id);
        if (n.msg) {
          markIn(n.msg, 'delivered', uid);
          markIn(n.msg, 'read', uid);
        }
      }
      saver.schedule();
      return { unread: (store.notices[uid] || []).filter((n) => !n.read).length };
    }),
    // A page (or the service worker) showed these: no push needed for them.
    post((p) => (p === '/api/me/notices/seen' ? {} : null), 'user', (body, h) => {
      const uid = h.ctx.userId;
      const ids = idsOf(body);
      const via = ['banner', 'system', 'bell', 'push', 'page'].includes(body.via) ? body.via : 'page';
      const t = now();
      for (const n of store.notices[uid] || []) {
        if (ids !== 'all' && !ids.includes(n.id)) continue;
        cancelFallback(uid, n.id);
        if (n.seen) continue;
        n.seen = t;
        n.via = via;
        if (n.msg) markIn(n.msg, 'delivered', uid);
      }
      saver.schedule();
      return {};
    }),

    // ---- Web Push subscriptions (per person and device)
    get((p) => (p === '/api/push/key' ? {} : null), 'none', () => ({ key: pusher ? pusher.publicKey : null })),
    post((p) => (p === '/api/push/subscribe' ? {} : null), 'user', (body, h) => {
      if (!pusher) throw new HttpError(503, 'Notifications aren’t available on this server right now', { code: 'push_off' });
      let clean;
      try {
        clean = checkSubscription(body.subscription, { allowHosts: push.allowHosts || null, allowHttp: !!push.allowHttp });
      } catch (e) {
        if (e instanceof PushError) throw new HttpError(400, e.message, { code: e.code });
        throw e;
      }
      const uid = h.ctx.userId;
      // A device belongs to whoever signed in there last.
      for (const [other, list] of Object.entries(store.subs)) {
        if (!Array.isArray(list)) continue;
        const keep = list.filter((s) => s.endpoint !== clean.endpoint);
        if (keep.length !== list.length) {
          if (keep.length) store.subs[other] = keep;
          else delete store.subs[other];
        }
      }
      const list = Array.isArray(store.subs[uid]) ? store.subs[uid] : (store.subs[uid] = []);
      list.push({ ...clean, device: cleanLine(body.device, 80) || 'A device', at: now(), sid: h.ctx.token ? sid(h.ctx.token) : null });
      if (list.length > SUBS_PER_USER) list.splice(0, list.length - SUBS_PER_USER);
      saver.schedule();
      return { devices: list.length };
    }),
    post((p) => (p === '/api/push/unsubscribe' ? {} : null), 'user', (body, h) => {
      const uid = h.ctx.userId;
      const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
      if (endpoint) removeSub(uid, endpoint);
      return { devices: (store.subs[uid] || []).length };
    }),

    // ---- the host's composer
    post((p) => (hostPath(p, 'notify/preview') ? {} : null), 'host', (body, h) => {
      const r = resolveTo(h.ctx.userId, body.to);
      const names = r.ids.map((id) => party.userById(id).name).sort(byName);
      return { label: r.label, count: r.ids.length, recipients: names, push: pushPeople(r.ids) };
    }),
    post((p) => (hostPath(p, 'notify') ? {} : null), 'host', (body, h) => {
      const host = h.ctx.user;
      const title = body.title === undefined || body.title === null ? '' : cleanLine(body.title, MAX_TITLE);
      if (title === null) throw new HttpError(400, 'The title must be text');
      const text = cleanBody(body.body);
      if (!text) throw new HttpError(400, 'Write a message first', { code: 'empty' });
      if (body.sound !== undefined && typeof body.sound !== 'boolean') throw new HttpError(400, 'sound must be true or false');
      const r = resolveTo(host.id, body.to);
      if (!r.ids.length) throw new HttpError(400, 'Nobody is in that group right now', { code: 'no_recipients' });
      const id = nid();
      const t = now();
      const sound = body.sound !== false;
      store.sent.push({
        id, at: t, by: host.id, to: r.kind === 'ids' ? { kind: 'ids', ids: r.ids } : { kind: r.kind }, label: r.label,
        title, body: text, sound, recipients: r.ids, delivered: [], read: [],
      });
      if (store.sent.length > KEEP_SENT) store.sent.splice(0, store.sent.length - KEEP_SENT);
      for (const uid of r.ids) {
        deliver(uid, { id, msg: id, kind: 'message', from: 'host', fromName: host.name, title, body: text, sound, urgent: true, exp: t + MESSAGE_FRESH_MS });
      }
      party.addLog('notify', { by: host.id, text: `sent a message to ${r.kind === 'ids' ? r.label : `${r.label} (${plural(r.ids.length, 'person', 'people')})`}${title ? `: “${title}”` : ''}` });
      party.touch();
      saver.schedule();
      return { id, recipients: r.ids.length };
    }),
    get((p) => (hostPath(p, 'notify') ? {} : null), 'host', (h) => {
      const rows = groupRows(h.ctx.userId);
      const groups = Object.fromEntries(Object.keys(GROUPS).map((k) => [k, rows[k].length]));
      const name = (id) => party.userById(id)?.name || '?';
      const devices = Object.values(store.subs).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0);
      return {
        serverNow: now(),
        groups,
        labels: { ...GROUPS },
        settings: Object.fromEntries(AUTO_KINDS.map((k) => [k, setting(k)])),
        push: { available: !!pusher, devices, people: Object.keys(store.subs).filter((uid) => (store.subs[uid] || []).length).length },
        sent: store.sent.slice(-50).reverse().map((s) => ({
          id: s.id, at: s.at, by: s.by, byName: name(s.by), to: s.to, label: s.label, title: s.title, body: s.body, sound: s.sound,
          recipients: s.recipients.length, delivered: (s.delivered || []).length, read: (s.read || []).length,
          names: s.recipients.slice(0, 12).map(name),
        })),
      };
    }),

    // ---- co-hosts (SPEC §21)
    post((p) => (hostPath(p, 'admins') ? {} : null), 'host', async (body, h) => {
      const r = setHost(party, h.ctx.userId, body);
      if (r.changed && r.isAdmin) {
        deliver(r.user.id, {
          kind: 'cohost', from: 'host', fromName: h.ctx.user.name, sound: true, urgent: true, exp: now() + 12 * 3600_000, url: '/host',
          title: 'You’re now a host',
          body: `${h.ctx.user.name} made you a co-host: approvals, reviews, breaks and messages are yours too. The host dashboard has them all.`,
        });
      }
      if (r.changed) {
        try {
          meTick?.();
        } catch { /* the next tick sends it */ }
        if (flushParty) await flushParty();
      }
      return { isAdmin: r.isAdmin, hosts: r.hosts };
    }),
  ];

  function start() {
    if (timers.length) return;
    const a = setInterval(guard('auto', autoTick), autoMs);
    const w = setInterval(guard('warning', warnTick), warnMs);
    a.unref?.();
    w.unref?.();
    timers.push(a, w);
  }
  function stop() {
    stopped = true;
    for (const t of timers) {
      clearInterval(t);
      clearTimeout(t);
    }
    timers.length = 0;
    for (const t of waits.values()) clearTimeout(t);
    waits.clear();
    queue.length = 0;
    pusher?.close();
    // Written now, synchronously, even if a background save is still in flight (the process
    // may exit right after; a later-landing older save is discarded by the saver's order).
    saver.schedule();
    saver.flush();
  }

  return {
    routes, start, stop, deliver, autoTick, warnTick,
    flush: () => saver.flushAsync(),
    get publicKey() { return keys ? keys.publicKey : null; },
    get pending() { return active + queue.length; },
    store, file,
  };
}

// Wire it into a server.js app: routes on the hook, timers, its file saved when the app stops.
export function attachNotify(app, opts = {}) {
  const meSend = typeof app.meSend === 'function' ? app.meSend : null;
  if (!meSend) (opts.log || console).error('[notify] this server has no meSend: notices reach pages on their next load or by push');
  const n = createNotify({ party: app.party, meSend, meTick: app.meTick, flushParty: () => app.saver.flushAsync(), ...opts });
  app.extraRoutes.push(...n.routes);
  n.start();
  const stop = app.stop;
  app.stop = async () => {
    n.stop();
    return stop();
  };
  app.notify = n;
  return n;
}
