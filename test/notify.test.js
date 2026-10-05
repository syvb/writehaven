// Notices (SPEC §22) and co-hosts (SPEC §21): recipient groups from the host view's statuses,
// sign-in / CSRF / host checks, the last-host rule, delivery on the `me` stream, Web Push to a
// local fake push service (never a real one) when no page takes a notice, pruning on 404/410,
// automatic notices with times as templates (SPEC §24), and a restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { startApp, client, readSse, sleep, makeClock, quietLog, typeInto } from './helpers.js';
import { realProse, MIN, T0 } from './sim.js';
import { attachNotify, cleanBody } from '../lib/notify.js';
import { b64u, unb64u, decryptPayload, PUSH_SERVICES } from '../lib/webpush.js';

// The real push services' hosts stay allowed (subscriptions are only stored for them, never
// sent to) plus a local fake one.
const PUSH = { allowHttp: true, allowHosts: ['127.0.0.1', ...PUSH_SERVICES] };

// The first account is the host; `user()` signs up more (each a client with .id).
async function setup({ clock = null, ackWaitMs = 300, adminUsers = null, stateFile = undefined } = {}) {
  const ctx = await startApp({ ...(clock ? { now: clock.now } : {}), ...(adminUsers ? { adminUsers } : {}), ...(stateFile ? { stateFile } : {}) });
  const notify = attachNotify(ctx.app, { dir: path.dirname(ctx.stateFile), log: quietLog, ackWaitMs, autoMs: 3_600_000, warnMs: 3_600_000, push: PUSH });
  const host = client(ctx.base);
  const r = await host.post('/api/register', { username: 'host', password: 'longpassword', name: 'Hanna Host' });
  host.id = r.json?.user?.id;
  async function user(username, name) {
    const c = client(ctx.base);
    const res = await c.post('/api/register', { username, password: 'longpassword', name });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    c.id = res.json.user.id;
    return c;
  }
  return { ...ctx, notify, host, user, party: ctx.app.party };
}
const approvalOn = (party) => {
  party.state.settings.scoring.approvalRequired = true;
  party.S.approvalRequired = true;
};
async function waitFor(fn, ms = 3000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await sleep(20);
  }
  assert.fail('timed out waiting');
  return false;
}
function browserKeys() {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ua, auth, keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) } };
}
async function fakePushService() {
  const got = [];
  const statuses = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      got.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(statuses.length ? statuses.shift() : 201);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { got, statuses, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
const noticesOf = async (c) => (await c.get('/api/me/notices')).json.notices;

test('notify: groups follow the host view (everyone, writers, hosts, at risk, out, not started, waiting, picked)', async () => {
  const clock = makeClock(T0);
  const s = await setup({ clock });
  try {
    const { party, host } = s;
    const ana = await s.user('ana', 'Ana');
    const ben = await s.user('ben', 'Ben');
    const cleo = await s.user('cleo', 'Cleo');
    const dev = await s.user('dev', 'Dev');
    const fay = await s.user('fay', 'Fay');
    assert.equal((await host.post('/api/host/admins', { id: fay.id, isAdmin: true })).status, 200);
    party.state.settings.scoring.targetPerHour = 20;
    party.rebuildEngine({ sync: true });
    approvalOn(party);
    const gus = await s.user('gus', 'Gus'); // waits for approval
    await host.post('/api/admin/start', {});
    for (const c of [ana, ben, cleo]) await c.post('/api/join', {});
    typeInto(party, clock, party.userById(ana.id), party.newPost(ana.id, {}), realProse(40, 0));
    clock.advance(20 * MIN);
    await host.post('/api/admin/writer', { id: cleo.id, out: true });
    const hv = (await host.get('/api/host')).json;
    const st = Object.fromEntries(hv.writers.map((w) => [w.username, w.status]));
    assert.deepEqual([st.ana, st.ben, st.cleo, st.dev, st.gus], ['on-track', 'at-risk', 'out', 'not-started', 'not-started']);
    assert.equal(hv.party.hosts, 2);
    const preview = async (to) => (await host.post('/api/host/notify/preview', { to })).json;
    const want = {
      all: ['Ana', 'Ben', 'Cleo', 'Dev', 'Fay', 'Gus'],
      writers: ['Ana', 'Ben', 'Cleo', 'Dev'], // Fay is a host who doesn't write; the sender is never included
      hosts: ['Fay'],
      'at-risk': ['Ben'],
      out: ['Cleo'],
      'not-started': ['Dev'],
      pending: ['Gus'],
    };
    for (const [kind, names] of Object.entries(want)) {
      const p = await preview({ kind });
      assert.deepEqual(p.recipients, names, kind);
      assert.equal(p.count, names.length);
    }
    const picked = await preview({ kind: 'ids', ids: [ana.id, fay.id, ana.id, 'nobody'] });
    assert.deepEqual(picked.recipients, ['Ana', 'Fay']);
    assert.equal(picked.label, 'Ana and Fay');
    assert.equal((await preview({ kind: 'ids', ids: [ana.id, ben.id, cleo.id, dev.id] })).label, '4 people');
    assert.equal((await preview({ kind: 'ids', ids: [gus.id] })).label, 'Gus');
    const g = (await host.get('/api/host/notify')).json;
    assert.deepEqual(g.groups, Object.fromEntries(Object.entries(want).map(([k, v]) => [k, v.length])));
    assert.deepEqual(g.settings, { approved: true, warning: true, breaks: true, out: true });
    // A pending account gets notices too (the approval card shows them).
    const r = await host.post('/api/host/notify', { to: { kind: 'pending' }, body: 'We see you, Gus. Two minutes!' });
    assert.equal(r.json.recipients, 1);
    assert.equal((await noticesOf(gus))[0].body, 'We see you, Gus. Two minutes!');
    assert.equal((await noticesOf(gus))[0].url, '/write');
  } finally {
    await s.close();
  }
});

test('notify: sign-in, the CSRF header and host checks on every route', async () => {
  const s = await setup();
  try {
    const anon = client(s.base);
    const ana = await s.user('ana', 'Ana');
    let r = await anon.get('/api/me/notices');
    assert.equal(r.status, 401);
    r = await anon.post('/api/me/notices/read', { ids: 'all' });
    assert.equal(r.status, 401);
    r = await ana.post('/api/me/notices/read', { ids: 'all' }, { headers: { 'X-WH': '' } });
    assert.equal(r.status, 403);
    r = await fetch(`${s.base}/api/me/notices/seen`, { method: 'POST', headers: { Cookie: ana.cookie, 'X-WH': '1', 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(r.status, 403, 'JSON only');
    for (const [m, p, b] of [['post', '/api/host/notify', { to: { kind: 'all' }, body: 'hi' }], ['post', '/api/host/notify/preview', { to: { kind: 'all' } }], ['get', '/api/host/notify'], ['post', '/api/host/admins', { id: ana.id, isAdmin: true }], ['post', '/api/admin/notify', { to: { kind: 'all' }, body: 'hi' }]]) {
      assert.equal((await ana[m](p, b)).status, 404, `writer ${p}`);
      assert.equal((await anon[m](p, b)).status, 404, `signed out ${p}`);
    }
    r = await s.host.post('/api/host/notify', { to: { kind: 'all' }, body: 'hi' }, { headers: { 'X-WH': '' } });
    assert.equal(r.status, 403);
    r = await s.host.post('/api/host/notify', { to: { kind: 'all' }, body: '  ​ ' });
    assert.deepEqual([r.status, r.json.code], [400, 'empty']);
    r = await s.host.post('/api/host/notify', { to: { kind: 'friends' }, body: 'hi' });
    assert.deepEqual([r.status, r.json.code], [400, 'bad_to']);
    r = await s.host.post('/api/host/notify', { to: { kind: 'hosts' }, body: 'hi' });
    assert.deepEqual([r.status, r.json.code], [400, 'no_recipients'], 'the only host is the sender');
    r = await s.host.post('/api/host/notify', { to: { kind: 'all' }, body: 'hi', sound: 'loud' });
    assert.equal(r.status, 400);
    r = await s.host.post('/api/admin/notify', { to: { kind: 'all' }, body: 'hi' });
    assert.deepEqual([r.status, r.json.recipients], [200, 1], '/api/admin/ spelling too');
    // Push routes: the key is public; subscribing needs a session and a known push service.
    r = await anon.get('/api/push/key');
    assert.equal(r.status, 200);
    assert.equal(unb64u(r.json.key).length, 65);
    const b = browserKeys();
    r = await anon.post('/api/push/subscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: b.keys } });
    assert.equal(r.status, 401);
    r = await ana.post('/api/push/subscribe', { subscription: { endpoint: 'https://evil.example/x', keys: b.keys } });
    assert.deepEqual([r.status, r.json.code], [400, 'unsupported-service']);
    r = await ana.post('/api/push/subscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'AAAA', auth: 'BBBB' } } });
    assert.deepEqual([r.status, r.json.code], [400, 'bad-subscription']);
    r = await ana.post('/api/push/subscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: b.keys } }, { headers: { 'X-WH': '' } });
    assert.equal(r.status, 403);
    // One person's notices are theirs alone.
    const ben = await s.user('ben', 'Ben');
    await s.host.post('/api/host/notify', { to: { kind: 'ids', ids: [ana.id] }, body: 'Just for Ana' });
    assert.equal((await noticesOf(ana))[0].body, 'Just for Ana');
    assert.ok(!(await noticesOf(ben)).some((n) => n.body === 'Just for Ana'));
    r = await ben.post('/api/me/notices/read', { ids: [(await noticesOf(ana))[0].id] });
    assert.equal((await ana.get('/api/me/notices')).json.unread, 2, 'Ben marking Ana’s notice read changes nothing');
  } finally {
    await s.close();
  }
});

test('notify: co-hosts: the last host stays, promotion approves and is logged, a one-time notice', async () => {
  const s = await setup({ adminUsers: ['boss'] });
  try {
    const { host, party } = s;
    approvalOn(party);
    const ruth = await s.user('ruth', 'Ruth');
    assert.equal((await ruth.get('/api/me')).json.me.approval, 'pending');
    let r = await host.post('/api/host/admins', { id: host.id, isAdmin: false });
    assert.deepEqual([r.status, r.json.code], [409, 'last_host']);
    r = await host.post('/api/host/admins', { id: ruth.id, isAdmin: true });
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.isAdmin, r.json.hosts], [true, 2]);
    let me = (await ruth.get('/api/me')).json.me;
    assert.deepEqual([me.isAdmin, me.approval], [true, 'approved']);
    let hv = (await host.get('/api/host')).json;
    assert.equal(hv.writers.find((w) => w.id === ruth.id).isAdmin, true);
    assert.equal(hv.party.hosts, 2);
    assert.ok(hv.alerts.filter((a) => a.kind === 'approval' && a.userId === ruth.id).every((a) => a.closed), 'her approval request is closed');
    assert.ok(hv.log.some((l) => l.type === 'cohost' && l.userId === ruth.id && l.by === host.id));
    let ns = await noticesOf(ruth);
    assert.equal(ns.length, 1);
    assert.deepEqual([ns[0].kind, ns[0].title, ns[0].url, ns[0].fromName, ns[0].read], ['cohost', 'You’re now a host', '/host', 'Hanna Host', false]);
    // The same request again changes nothing and sends nothing.
    r = await host.post('/api/host/admins', { id: ruth.id, isAdmin: true });
    assert.equal(r.status, 200);
    assert.equal((await noticesOf(ruth)).length, 1);
    // Ruth has every host power: she can remove the first host; then she is the last one.
    assert.equal((await ruth.get('/api/host')).status, 200);
    r = await ruth.post('/api/host/admins', { id: host.id, isAdmin: false });
    assert.deepEqual([r.status, r.json.hosts], [200, 1]);
    assert.equal((await host.get('/api/host')).status, 404);
    r = await ruth.post('/api/host/admins', { id: ruth.id, isAdmin: false });
    assert.deepEqual([r.status, r.json.code], [409, 'last_host'], 'the last host can’t step down');
    hv = (await ruth.get('/api/host')).json;
    assert.ok(hv.log.some((l) => l.type === 'cohost-remove' && l.userId === host.id && l.by === ruth.id));
    // Back the other way: a removed co-host stays approved even with approval on.
    assert.equal((await ruth.post('/api/host/admins', { id: host.id, isAdmin: true })).status, 200);
    assert.equal((await host.post('/api/host/admins', { id: ruth.id, isAdmin: false })).status, 200);
    me = (await ruth.get('/api/me')).json.me;
    assert.deepEqual([me.isAdmin, me.approval], [false, 'approved']);
    // Hosts from WH_ADMIN_USERS are hosts at every sign-in: not removable here.
    const boss = await s.user('boss', 'Boss');
    assert.equal((await boss.get('/api/me')).json.me.isAdmin, true);
    r = await host.post('/api/host/admins', { id: boss.id, isAdmin: false });
    assert.deepEqual([r.status, r.json.code], [409, 'env_host']);
    r = await host.post('/api/host/admins', { id: 'nobody', isAdmin: true });
    assert.equal(r.status, 404);
    r = await host.post('/api/host/admins', { id: ruth.id, isAdmin: 'yes' });
    assert.equal(r.status, 400);
    ns = await noticesOf(host);
    assert.equal(ns.filter((n) => n.kind === 'cohost').length, 1, 'the first host was made a host again by Ruth: one notice');
  } finally {
    await s.close();
  }
});

test('notify: a message reaches an open page as a `notice` event on the me stream; seen and read counts', async () => {
  const s = await setup();
  try {
    const ana = await s.user('ana', 'Ana');
    const ben = await s.user('ben', 'Ben');
    const evP = readSse(`${s.base}/api/me/events`, { cookie: ana.cookie, ms: 3000, until: (evs) => evs.some((e) => e.event === 'notice') });
    await sleep(150);
    const r = await s.host.post('/api/host/notify', { to: { kind: 'writers' }, title: 'Dinner\nis here', body: 'Pizza is in the kitchen.\r\n\r\n\r\nVeggie on the left.\u0007', sound: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.recipients, 2);
    const evs = await evP;
    const n = evs.find((e) => e.event === 'notice').data;
    assert.equal(n.id, r.json.id);
    assert.deepEqual(
      { kind: n.kind, from: n.from, fromName: n.fromName, title: n.title, body: n.body, sound: n.sound, url: n.url, read: n.read, times: n.times },
      { kind: 'message', from: 'host', fromName: 'Hanna Host', title: 'Dinner is here', body: 'Pizza is in the kitchen.\n\nVeggie on the left.', sound: true, url: '/write', read: false, times: null },
    );
    assert.ok(n.exp > n.at, 'a host message is fresh for a while');
    let mine = (await ana.get('/api/me/notices')).json;
    assert.equal(mine.unread, 1);
    assert.equal(mine.notices[0].id, n.id);
    let sent = (await s.host.get('/api/host/notify')).json.sent[0];
    assert.deepEqual([sent.label, sent.recipients, sent.delivered, sent.read, sent.title, sent.byName], ['All writers', 2, 0, 0, 'Dinner is here', 'Hanna Host']);
    assert.deepEqual(sent.names.sort(), ['Ana', 'Ben']);
    await ana.post('/api/me/notices/seen', { ids: [n.id], via: 'banner' });
    sent = (await s.host.get('/api/host/notify')).json.sent[0];
    assert.deepEqual([sent.delivered, sent.read], [1, 0]);
    mine = (await ana.post('/api/me/notices/read', { ids: [n.id] })).json;
    assert.equal(mine.unread, 0);
    await ben.post('/api/me/notices/read', { ids: 'all' });
    sent = (await s.host.get('/api/host/notify')).json.sent[0];
    assert.deepEqual([sent.delivered, sent.read], [2, 2]);
    assert.equal((await noticesOf(ana))[0].read, true);
    const hv = (await s.host.get('/api/host')).json;
    assert.ok(hv.log.some((l) => l.type === 'notify' && l.text === 'sent a message to All writers (2 people): “Dinner is here”'), JSON.stringify(hv.log.slice(-3)));
    // The bell keeps the last 20.
    for (let i = 0; i < 24; i++) await s.host.post('/api/host/notify', { to: { kind: 'ids', ids: [ana.id] }, body: `Note ${i}` });
    const all = (await ana.get('/api/me/notices')).json;
    assert.equal(all.notices.length, 20);
    assert.equal(all.notices[0].body, 'Note 23', 'newest first');
    assert.equal(all.unread, 24);
  } finally {
    await s.close();
  }
});

test('notify: Web Push when no page takes a notice; pruned on 410 and 404; nothing after signing out', async () => {
  const svc = await fakePushService();
  const s = await setup({ ackWaitMs: 400 });
  try {
    const ana = await s.user('ana', 'Ana');
    const b = browserKeys();
    const subscribe = () => ana.post('/api/push/subscribe', { subscription: { endpoint: `${svc.base}/push/ana`, keys: b.keys, expirationTime: null }, device: 'Pixel · Chrome' });
    let r = await subscribe();
    assert.deepEqual([r.status, r.json.devices], [200, 1]);
    const send = (body) => s.host.post('/api/host/notify', { to: { kind: 'ids', ids: [ana.id] }, body });
    const read = (i) => JSON.parse(decryptPayload(svc.got[i].body, { uaPrivate: b.ua.getPrivateKey(), auth: b.auth }).toString('utf8'));

    // 1. No page open: pushed at once, encrypted for this device, no secrets inside.
    r = await send('Dinner is here');
    await waitFor(() => svc.got.length === 1);
    const p = read(0);
    assert.deepEqual([p.id, p.body, p.from, p.fromName, p.url, p.kind, p.sound], [r.json.id, 'Dinner is here', 'host', 'Hanna Host', '/write', 'message', true]);
    assert.deepEqual(Object.keys(p).sort(), ['at', 'body', 'from', 'fromName', 'id', 'kind', 'sound', 'tag', 'times', 'title', 'url']);
    assert.equal(svc.got[0].headers.urgency, 'high');
    const ttl = Number(svc.got[0].headers.ttl);
    assert.ok(ttl > 3600 && ttl <= 6 * 3600, `TTL ${ttl}`);
    assert.match(svc.got[0].headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/);
    await waitFor(async () => (await s.host.get('/api/host/notify')).json.sent[0].delivered === 1);

    // 2. A page is open but never shows it (hidden tab without permission, dead stream): pushed after the wait.
    const quiet = readSse(`${s.base}/api/me/events`, { cookie: ana.cookie, ms: 1200 });
    await sleep(150);
    await send('Second');
    await sleep(120);
    assert.equal(svc.got.length, 1, 'the page gets its chance first');
    await waitFor(() => svc.got.length === 2);
    assert.equal(read(1).body, 'Second');
    await quiet;

    // 3. A page that shows it says so: no push.
    const shown = readSse(`${s.base}/api/me/events`, { cookie: ana.cookie, ms: 3000, until: (evs) => evs.some((e) => e.event === 'notice') });
    await sleep(150);
    await send('Third');
    const n = (await shown).find((e) => e.event === 'notice').data;
    await ana.post('/api/me/notices/seen', { ids: [n.id], via: 'banner' });
    await sleep(500);
    assert.equal(svc.got.length, 2);

    // 4. Gone (410, then 404 after subscribing again): the subscription is pruned.
    svc.statuses.push(410);
    await send('Fourth');
    await waitFor(() => !s.notify.store.subs[ana.id]);
    assert.equal(svc.got.length, 3);
    await subscribe();
    svc.statuses.push(404);
    await send('Fifth');
    await waitFor(() => !s.notify.store.subs[ana.id]);
    // A busy service (5xx) is retried later, not pruned.
    await subscribe();
    svc.statuses.push(503);
    await send('Sixth');
    await waitFor(() => svc.got.length === 5);
    assert.equal(s.notify.store.subs[ana.id].length, 1);

    // 5. The same device signs in as Ben: it's his now. Then he signs out: nothing reaches it.
    const ben = await s.user('ben', 'Ben');
    r = await ben.post('/api/push/subscribe', { subscription: { endpoint: `${svc.base}/push/ana`, keys: b.keys }, device: 'Pixel · Chrome' });
    assert.equal(r.status, 200);
    assert.ok(!s.notify.store.subs[ana.id], 'moved to Ben');
    await ben.post('/api/logout', {});
    const before = svc.got.length;
    await s.host.post('/api/host/notify', { to: { kind: 'ids', ids: [ben.id] }, body: 'Seventh' });
    await sleep(400);
    assert.equal(svc.got.length, before, 'a signed-out device gets nothing');
    assert.ok(!s.notify.store.subs[ben.id], 'and is forgotten');
    // Unsubscribe removes a device.
    await subscribe();
    r = await ana.post('/api/push/unsubscribe', { endpoint: `${svc.base}/push/ana` });
    assert.deepEqual([r.status, r.json.devices], [200, 0]);
  } finally {
    await s.close();
    await svc.close();
  }
});

test('notify: automatic notices (approved, breaks, the 15-minute warning, out) are switchable; times are templates', async () => {
  const clock = makeClock(T0);
  const s = await setup({ clock });
  try {
    const { party, notify, host } = s;
    const ana = await s.user('ana', 'Ana');
    const ben = await s.user('ben', 'Ben');
    approvalOn(party);
    const ruth = await s.user('ruth', 'Ruth');
    const sam = await s.user('sam', 'Sam');
    const noClock = (n) => assert.ok(!/\b\d{1,2}[:.]\d{2}\b/.test(`${n.title} ${n.body}`), `no clock time in “${n.title} ${n.body}” (SPEC §24)`);

    // Approved (in the lobby).
    await host.post('/api/host/approve', { id: ruth.id });
    notify.autoTick();
    notify.autoTick();
    let ns = await noticesOf(ruth);
    assert.equal(ns.length, 1, 'once');
    assert.deepEqual([ns[0].kind, ns[0].from, ns[0].title], ['approved', 'system', 'You’re approved — come and write']);
    assert.match(ns[0].body, /hasn’t started yet/);
    let r = await host.post('/api/host/settings', { scoring: { 'notify.approved': false } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    await host.post('/api/host/approve', { id: sam.id });
    notify.autoTick();
    assert.equal((await noticesOf(sam)).length, 0, 'switched off');
    assert.equal((await host.get('/api/host/notify')).json.settings.approved, false);
    assert.ok((await host.get('/api/host')).json.log.some((l) => l.type === 'settings' && /Tell people when they’re approved: on → off/.test(l.text)));

    // A break (pause): start and end, for every writer, with the end time as {t}.
    await host.post('/api/admin/start', {});
    await ana.post('/api/join', {});
    r = await host.post('/api/host/breaks', { name: 'Dinner break', minutes: 30, mode: 'pause' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const brk = r.json.break;
    notify.autoTick();
    for (const c of [ana, ben, ruth, sam]) {
      const b = (await noticesOf(c)).find((n) => n.kind === 'break');
      assert.ok(b, 'every writer hears about the break');
      assert.equal(b.title, 'Dinner break');
      assert.equal(b.body, 'Your hour is paused until {t}. Keep writing if you like; nothing is required until then.');
      assert.deepEqual(b.times, { t: brk.endAt });
      noClock(b);
    }
    assert.ok(!(await noticesOf(host)).some((n) => n.kind === 'break'), 'not the host who doesn’t write');
    clock.advance(31 * MIN);
    notify.autoTick();
    notify.autoTick();
    let ends = (await noticesOf(ana)).filter((n) => n.kind === 'break-end');
    assert.equal(ends.length, 1);
    assert.match(ends[0].body, /^The clock runs again\. Hour 1 runs until \{t\}: \d+ of 400 so far\.$/);
    assert.ok(ends[0].times.t > clock.now());
    noClock(ends[0]);
    assert.equal((await noticesOf(ben)).find((n) => n.kind === 'break-end').body, 'The hour clocks run again.', 'not started: no hour numbers');
    assert.equal(ends[0].title, 'Dinner break is over');

    // The 15-minute warning, when behind (Ana typed a little; her hour ends 90 minutes after she started).
    typeInto(party, clock, party.userById(ana.id), party.newPost(ana.id, {}), realProse(30, 0));
    const hourEnd = party.progressOf(ana.id).prog.current.endAt;
    clock.set(hourEnd - 20 * MIN);
    notify.warnTick();
    assert.ok(!(await noticesOf(ana)).some((n) => n.kind === 'warning'), 'not yet at 20 minutes');
    clock.set(hourEnd - 14 * MIN);
    notify.warnTick();
    notify.warnTick();
    const warn = (await noticesOf(ana)).filter((n) => n.kind === 'warning');
    assert.equal(warn.length, 1, 'once per hour');
    assert.equal(warn[0].title, '14 minutes left in hour 1');
    assert.match(warn[0].body, /^You’re at \d+ of 400\. About \d+ words a minute until \{t\} gets you there\. Or take this hour off: you have 1 free hour left\.$/);
    assert.deepEqual(warn[0].times, { t: hourEnd });
    assert.equal(warn[0].exp, hourEnd, 'stale after the hour ends');
    noClock(warn[0]);

    // Out (missed hour 1): kind words, no clock times.
    clock.set(hourEnd + 3 * MIN);
    party.tick();
    assert.equal(party.userById(ana.id).out, true);
    notify.autoTick();
    const out = (await noticesOf(ana)).filter((n) => n.kind === 'out');
    assert.equal(out.length, 1);
    assert.match(out[0].title, /^Hour 1 ended at \d+ of 400$/);
    // The wording may change; what it must say: out, keep writing, posts still go out, the host can bring you back.
    assert.match(out[0].body, /^So you’re out of the challenge, but nothing else changes: keep writing, your posts still stream and go in the anthology\. The host can bring you back in\b/);
    noClock(out[0]);
    // The host's "Mark as out" can be undone for 2 minutes: the notice waits for that.
    await ben.post('/api/join', {});
    await host.post('/api/admin/writer', { id: ben.id, out: true });
    notify.autoTick();
    assert.ok(!(await noticesOf(ben)).some((n) => n.kind === 'out'), 'not during the undo window');
    clock.advance(2 * MIN + 10_000);
    notify.autoTick();
    assert.equal((await noticesOf(ben)).find((n) => n.kind === 'out').title, 'The host marked you out');
    // Switched off: no out notice, no warning, no break notices.
    await host.post('/api/host/settings', { scoring: { 'notify.out': false, 'notify.warning': false, 'notify.breaks': false } });
    await host.post('/api/admin/writer', { id: ruth.id, out: true });
    clock.advance(3 * MIN);
    await host.post('/api/host/breaks', { name: 'Tea', minutes: 10 });
    notify.autoTick();
    notify.warnTick();
    assert.ok(!(await noticesOf(ruth)).some((n) => n.kind === 'out' || n.title === 'Tea'));
    assert.deepEqual((await host.get('/api/host/notify')).json.settings, { approved: false, warning: false, breaks: false, out: false });
  } finally {
    await s.close();
  }
});

test('notify: notices, read state and push subscriptions survive a restart; the VAPID key stays (mode 600)', async () => {
  const s = await setup();
  const dir = path.dirname(s.stateFile);
  let s2 = null;
  let closed = false;
  try {
    const ana = await s.user('ana', 'Ana');
    const b = browserKeys();
    await ana.post('/api/push/subscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/ana', keys: b.keys }, device: 'Phone' });
    const key = (await ana.get('/api/push/key')).json.key;
    await s.host.post('/api/host/notify', { to: { kind: 'all' }, body: 'One' });
    await s.host.post('/api/host/notify', { to: { kind: 'all' }, body: 'Two' });
    const [two] = await noticesOf(ana);
    await ana.post('/api/me/notices/read', { ids: [two.id] });
    s.notify.store.subs[ana.id][0].sid = null; // sessions don't survive in this test's new client
    await s.close();
    closed = true;
    assert.equal(fs.statSync(path.join(dir, 'vapid.json')).mode & 0o777, 0o600);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'notify.json'), 'utf8'));
    assert.equal(saved.notices[ana.id].length, 2);

    s2 = await setup({ stateFile: s.stateFile });
    const ana2 = client(s2.base);
    assert.equal((await ana2.post('/api/login', { username: 'ana', password: 'longpassword' })).status, 200);
    const mine = (await ana2.get('/api/me/notices')).json;
    assert.deepEqual(mine.notices.map((n) => [n.body, n.read]), [['Two', true], ['One', false]]);
    assert.equal(mine.unread, 1);
    assert.equal((await ana2.get('/api/push/key')).json.key, key);
    assert.equal(s2.notify.store.subs[Object.keys(s2.notify.store.subs)[0]][0].device, 'Phone');
    assert.equal((await s2.host.post('/api/login', { username: 'host', password: 'longpassword' })).status, 200);
    assert.equal((await s2.host.get('/api/host/notify')).json.sent.length, 2);
  } finally {
    if (!closed) await s.close();
    if (s2) await s2.close();
  }
});

test('notify: message text is cleaned (controls, invisible characters, line breaks, length)', () => {
  assert.equal(cleanBody('  Dinner​ is\r\nhere\u0000  '), 'Dinner is\nhere');
  assert.equal(cleanBody('a\n\n\n\nb'), 'a\n\nb');
  assert.equal(cleanBody('x'.repeat(400)).length, 300);
  assert.equal([...cleanBody('🍕'.repeat(400))].length, 300, 'characters, not UTF-16 units');
  assert.equal(cleanBody(42), null);
});
