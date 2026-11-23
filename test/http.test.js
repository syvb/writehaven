import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { startApp, client, readSse, sleep, tmpStateFile } from './helpers.js';
import { hashPassword, verifyPassword, LoginLimiter, parseCookies, sessionCookie } from '../lib/auth.js';

test('auth primitives: scrypt hash/verify, limiter, cookies', async () => {
  const h = await hashPassword('correct horse');
  assert.match(h, /^scrypt\$/);
  assert.equal(await verifyPassword('correct horse', h), true);
  assert.equal(await verifyPassword('wrong', h), false);
  assert.equal(await verifyPassword('x', null), false);
  let t = 0;
  const lim = new LoginLimiter({ max: 3, windowMs: 1000, now: () => t });
  lim.fail('k'); lim.fail('k');
  assert.equal(lim.blocked('k'), false);
  lim.fail('k');
  assert.equal(lim.blocked('k'), true);
  t = 2000;
  assert.equal(lim.blocked('k'), false);
  assert.deepEqual(parseCookies('a=1; wh_sess=abc%20d; a=2'), { a: '1', wh_sess: 'abc d' });
  const c = sessionCookie('tok', { secure: true });
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Secure/);
});

test('http: register, first account is admin, login/logout, CSRF header, admin-only routes', async (t) => {
  const { base, close, stateFile } = await startApp({ adminUsers: ['carol'] });
  t.after(close);
  const a = client(base);
  let r = await a.post('/api/register', { username: 'Host', password: 'longpassword', name: 'The Host' });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.isAdmin, true);
  assert.equal(r.json.user.username, 'host');
  assert.match(r.headers.get('set-cookie'), /HttpOnly/);
  const b = client(base);
  r = await b.post('/api/register', { username: 'ana', password: 'longpassword', name: 'Ana' });
  assert.equal(r.json.user.isAdmin, false);
  r = await b.post('/api/register', { username: 'ana', password: 'longpassword', name: 'Ana 2' });
  assert.equal(r.status, 409);
  const c = client(base);
  r = await c.post('/api/register', { username: 'carol', password: 'longpassword', name: 'Carol' });
  assert.equal(r.json.user.isAdmin, true, 'WH_ADMIN_USERS grants admin');
  // CSRF: POST without the X-WH header is refused.
  r = await a.post('/api/admin/start', {}, { headers: { 'X-WH': '' } });
  assert.equal(r.status, 403);
  // Non-admins get 404 for admin routes, GET and POST.
  r = await b.post('/api/admin/start', {});
  assert.equal(r.status, 404);
  r = await b.get('/api/admin/state');
  assert.equal(r.status, 404);
  r = await b.get('/api/admin/export.json');
  assert.equal(r.status, 404);
  // Admin starts the party.
  r = await a.post('/api/admin/start', {});
  assert.equal(r.status, 200);
  r = await a.get('/api/admin/state');
  assert.equal(r.json.party.phase, 'running');
  assert.ok(r.json.writers.every((w) => !('passHash' in w)));
  // Login: wrong password, then right one.
  const d = client(base);
  r = await d.post('/api/login', { username: 'ana', password: 'nope-nope' });
  assert.equal(r.status, 401);
  r = await d.post('/api/login', { username: 'ANA', password: 'longpassword' });
  assert.equal(r.status, 200);
  r = await d.get('/api/session');
  assert.equal(r.json.user.name, 'Ana');
  r = await d.post('/api/logout', {});
  r = await d.get('/api/session');
  assert.equal(r.json.user, null);
  r = await d.get('/api/me');
  assert.equal(r.status, 401);
  // Static: security headers, SPA routes, versioned assets.
  r = await d.get('/host');
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(r.text, /<html/);
  assert.ok(!r.text.includes('__V__'));
  r = await d.get('/nope.js');
  assert.equal(r.status, 404);
  r = await d.get('/../server.js');
  assert.notEqual(r.text.includes('createApp'), true);
  // State persisted (atomically) with hashed passwords only.
  await sleep(1200);
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(Object.keys(saved.users).length, 3);
  assert.ok(!JSON.stringify(saved).includes('longpassword'));
});

test('http: login rate limit', async (t) => {
  const { base, close } = await startApp();
  t.after(close);
  const a = client(base);
  await a.post('/api/register', { username: 'host', password: 'longpassword', name: 'Host' });
  const x = client(base);
  let last;
  for (let i = 0; i < 12; i++) last = await x.post('/api/login', { username: 'host', password: `bad-${i}-pass` });
  assert.equal(last.status, 429);
});

test('http: writer flow — join, post, ops, conflict, me stream, pass', async (t) => {
  const { base, close } = await startApp();
  t.after(close);
  const host = client(base);
  await host.post('/api/register', { username: 'host', password: 'longpassword', name: 'Host' });
  const w = client(base);
  await w.post('/api/register', { username: 'ana', password: 'longpassword', name: 'Ana' });
  let r = await w.post('/api/post/new', {});
  assert.equal(r.status, 409, 'no posts before the start');
  await host.post('/api/admin/start', {});
  r = await w.post('/api/join', {});
  assert.ok(r.json.joinedAt > 0);
  r = await w.post('/api/post/new', { title: 'Morning' });
  const post = r.json.post;
  r = await w.post('/api/ops', { postId: post.id, pane: 'body', baseVersion: 0, seq: 's1', sentAt: Date.now(), ops: [{ at: Date.now(), pos: 0, del: 0, ins: 'Hello there' }] });
  assert.equal(r.status, 200);
  assert.equal(r.json.version, 1);
  r = await w.post('/api/ops', { postId: post.id, pane: 'body', baseVersion: 0, seq: 's2', ops: [{ pos: 0, del: 0, ins: 'X' }] });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'conflict');
  assert.equal(r.json.text, 'Hello there');
  r = await w.get(`/api/post?id=${post.id}&pane=body`);
  assert.equal(r.json.text, 'Hello there');
  assert.equal(r.json.version, 1);
  r = await w.post('/api/post/update', { id: post.id, title: 'Morning pages', privacy: 'named' });
  assert.equal(r.json.post.title, 'Morning pages');
  const ev = await readSse(`${base}/api/me/events`, { cookie: w.cookie, ms: 400 });
  assert.equal(ev[0].event, 'me');
  assert.equal(ev[0].data.me.username, 'ana');
  assert.equal(ev[0].data.posts[0].title, 'Morning pages');
  assert.ok(ev[0].data.progress.current);
  r = await w.post('/api/paste/check', { text: 'Hello there general kenobi, nice to meet you today friend' });
  assert.equal(r.status, 200);
  assert.equal(typeof r.json.own, 'string');
  r = await w.post('/api/pass', {});
  assert.equal(r.status, 200);
  r = await w.post('/api/pass', {});
  assert.equal(r.status, 409);
  // Host sees the writer and their posts.
  r = await host.get('/api/admin/state');
  const row = r.json.writers.find((x) => x.username === 'ana');
  assert.equal(row.posts, 1);
  r = await host.get(`/api/admin/writer?id=${row.id}`);
  assert.equal(r.json.posts[0].body, 'Hello there');
  r = await host.get('/api/admin/export.md');
  assert.match(r.headers.get('content-disposition'), /attachment/);
  assert.match(r.text, /Morning pages/);
  r = await host.get('/api/admin/export.json');
  assert.ok(!r.text.includes('passHash'));
  assert.ok(!r.text.includes('scrypt$'));
});

test('http: public live stream sends diffs and order, ≤ 1 update/s per post', async (t) => {
  const { base, close } = await startApp({ liveMs: 1000 });
  t.after(close);
  const host = client(base);
  await host.post('/api/register', { username: 'host', password: 'longpassword', name: 'Host' });
  await host.post('/api/admin/start', {});
  const w = client(base);
  await w.post('/api/register', { username: 'ana', password: 'longpassword', name: 'Ana' });
  const post = (await w.post('/api/post/new', { title: 'Live one' })).json.post;
  let ver = 0;
  const type = async (pos, ins) => {
    const r = await w.post('/api/ops', { postId: post.id, pane: 'body', baseVersion: ver, ops: [{ pos, del: 0, ins }] });
    ver = r.json.version;
  };
  await type(0, 'Once');
  const pending = readSse(`${base}/api/live/events`, { ms: 2600 });
  await sleep(300);
  for (let i = 0; i < 10; i++) {
    await type(4 + i * 2, ' a');
    await sleep(100);
  }
  const events = await pending;
  assert.equal(events[0].event, 'snapshot');
  assert.equal(events[0].data.posts[0].title, 'Live one');
  const updates = events.filter((e) => e.event === 'post');
  assert.ok(updates.length >= 1 && updates.length <= 3, `${updates.length} updates in ~2.5 s`);
  // Applying the diffs to the snapshot gives the current text.
  let text = events[0].data.posts[0].text;
  for (const u of updates) if (u.data.d) text = text.slice(0, u.data.d[0]) + u.data.d[2] + text.slice(u.data.d[0] + u.data.d[1]);
  assert.equal(text, `Once${' a'.repeat(10)}`);
});

test('persistence: restart restores posts, versions and scores from the state file + op journal', async (t) => {
  const open = new Set();
  t.after(async () => { for (const a of open) await a.close(); });
  const startTracked = async (o) => { const a = await startApp(o); open.add(a); const close = a.close; a.close = async () => { open.delete(a); await close(); }; return a; };
  const first = await startTracked({ saveMs: 50 });
  const host = client(first.base);
  await host.post('/api/register', { username: 'host', password: 'longpassword', name: 'Host' });
  await host.post('/api/admin/start', {});
  const w = client(first.base);
  await w.post('/api/register', { username: 'ana', password: 'longpassword', name: 'Ana' });
  const post = (await w.post('/api/post/new', { title: 'Kept' })).json.post;
  let ver = 0;
  const text = 'Words that must survive a restart. ';
  for (let i = 0; i < text.length; i += 5) {
    const r = await w.post('/api/ops', { postId: post.id, pane: 'body', baseVersion: ver, ops: [{ pos: i, del: 0, ins: text.slice(i, i + 5) }] });
    ver = r.json.version;
  }
  await w.post('/api/ops', { postId: post.id, pane: 'notes', baseVersion: 0, ops: [{ pos: 0, del: 0, ins: 'note' }] });
  const before = (await host.get('/api/admin/state')).json.writers.find((x) => x.username === 'ana').totals;
  await sleep(200);
  await first.close();
  // The state file has no ops; the journal has them.
  const saved = JSON.parse(fs.readFileSync(first.stateFile, 'utf8'));
  assert.equal(saved.ops, undefined);
  const jfiles = fs.readdirSync(`${first.stateFile}.ops`);
  assert.equal(jfiles.length, 1);
  // Simulate a crash mid-append: a torn last line is ignored.
  fs.appendFileSync(`${first.stateFile}.ops/${jfiles[0]}`, '["p","b",99,[[1,0,0');
  const second = await startTracked({ stateFile: first.stateFile });
  const w2 = client(second.base);
  await w2.post('/api/login', { username: 'ana', password: 'longpassword' });
  const r = await w2.get(`/api/post?id=${post.id}&pane=body`);
  assert.equal(r.json.text, text);
  assert.equal(r.json.version, ver);
  assert.equal((await w2.get(`/api/post?id=${post.id}&pane=notes`)).json.text, 'note');
  const host2 = client(second.base);
  await host2.post('/api/login', { username: 'host', password: 'longpassword' });
  const after = (await host2.get('/api/admin/state')).json.writers.find((x) => x.username === 'ana').totals;
  assert.deepEqual(after, before);
  // Crash window: the state file lags the journal (it is written a moment later). The journal
  // restores the version AND the last batch id, so the client's retry is recognised.
  const r2 = await w2.post('/api/ops', { postId: post.id, pane: 'body', baseVersion: ver, seq: 'crash-1', ops: [{ pos: text.length, del: 0, ins: 'Kept once. ' }] });
  assert.equal(r2.status, 200);
  await second.close();
  const st = JSON.parse(fs.readFileSync(first.stateFile, 'utf8'));
  st.posts[post.id].ver.body = ver;
  st.posts[post.id].seq.body = null;
  st.posts[post.id].body = text;
  fs.writeFileSync(first.stateFile, JSON.stringify(st));
  const third = await startTracked({ stateFile: first.stateFile });
  const w3 = client(third.base);
  await w3.post('/api/login', { username: 'ana', password: 'longpassword' });
  const retry = await w3.post('/api/ops', { postId: post.id, pane: 'body', baseVersion: ver, seq: 'crash-1', ops: [{ pos: text.length, del: 0, ins: 'Kept once. ' }] });
  assert.equal(retry.status, 200);
  assert.equal(retry.json.duplicate, true);
  assert.equal((await w3.get(`/api/post?id=${post.id}&pane=body`)).json.text, `${text}Kept once. `);
  ver += 1;
  await third.close();
  const fourth = await startTracked({ stateFile: first.stateFile });
  const w4 = client(fourth.base);
  await w4.post('/api/login', { username: 'ana', password: 'longpassword' });
  // Typing continues from the restored version.
  const c = await w4.post('/api/ops', { postId: post.id, pane: 'body', baseVersion: ver, ops: [{ pos: text.length + 11, del: 0, ins: 'More.' }] });
  assert.equal(c.status, 200);
  await fourth.close();
});

test('one shared address (the venue): 30 sign-ups, 30 writers’ streams and 10 anonymous live streams all succeed; an abusive address is refused', async (t) => {
  const { RegLimiter, clientIp } = await import('../server.js');
  const req = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });
  assert.equal(clientIp(req('127.0.0.1', { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '1.2.3.4' })), '127.0.0.1', 'without WH_PROXY no header is read');
  assert.equal(clientIp(req('127.0.0.1', { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '1.2.3.4' }), 'cloudflare'), '203.0.113.9');
  assert.equal(clientIp(req('127.0.0.1', { 'cf-connecting-ip': '2001:db8::7' }), 'cloudflare'), '2001:db8::7');
  assert.equal(clientIp(req('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' }), 'cloudflare'), '127.0.0.1', 'X-Forwarded-For is never read');
  assert.equal(clientIp(req('127.0.0.1', { 'cf-connecting-ip': '203.0.113.9, 1.2.3.4' }), 'cloudflare'), '127.0.0.1', 'only one address counts as one');
  assert.equal(clientIp(req('198.51.100.4', { 'cf-connecting-ip': '203.0.113.9' }), 'cloudflare'), '198.51.100.4', 'only the tunnel on this machine is believed');
  let now = 0;
  const lim = new RegLimiter({ now: () => now });
  for (let i = 0; i < 60; i++) assert.equal(lim.take('203.0.113.1'), 0);
  assert.ok(lim.take('203.0.113.1') > 0, 'the 61st in 10 minutes waits');
  for (let i = 0; i < 30; i++) lim.fail('203.0.113.2');
  assert.ok(lim.check('203.0.113.2') > 0, 'failed attempts are limited more tightly');
  now += 10 * 60_000 + 1;
  assert.equal(lim.take('203.0.113.1'), 0, 'the window passes');

  const { base, close, app } = await startApp({ proxy: 'cloudflare' }); // each client's address is its CF-Connecting-IP
  t.after(close);
  const ctrls = [];
  t.after(() => { for (const c of ctrls) c.abort(); });
  const open = async (path, headers = {}) => {
    const ctrl = new AbortController();
    ctrls.push(ctrl);
    const res = await fetch(base + path, { headers, signal: ctrl.signal });
    if (res.status !== 200) await res.text();
    else (async () => { try { for await (const _ of res.body) { /* drain like a browser */ } } catch { /* aborted */ } })();
    return res.status;
  };
  const host = client(base);
  await host.post('/api/register', { username: 'host', password: 'longpassword', name: 'Host' }); // from elsewhere: the venue isn't known
  // The venue: one address for everyone.
  const venue = { 'CF-Connecting-IP': '192.0.2.50' };
  const writers = [];
  for (let i = 0; i < 30; i++) {
    const w = client(base);
    const r = await w.post('/api/register', { username: `guest${i}`, password: 'longpassword', name: `Guest ${i}` }, { headers: venue });
    assert.equal(r.status, 200, `sign-up ${i}: ${r.text}`);
    writers.push(w);
  }
  for (const w of writers) assert.equal(await open('/api/me/events', { ...venue, Cookie: w.cookie }), 200);
  for (let i = 0; i < 10; i++) assert.equal(await open('/api/live/events', venue), 200, 'anonymous live streams (projector, phones)');
  for (let i = 0; i < 6; i++) assert.equal(await open('/api/live/events', { ...venue, Cookie: writers[0].cookie }), 200, 'a writer’s live tabs are never refused');
  await sleep(150);
  assert.equal(app.streams().me, 30);
  assert.equal(app.streams().live, 10 + 4, 'per session the oldest live tabs close beyond 4');
  // A writer opening many tabs of their own stream: never refused, the oldest close beyond 4.
  for (let i = 0; i < 5; i++) assert.equal(await open('/api/me/events', { ...venue, Cookie: writers[1].cookie }), 200);
  await sleep(150);
  const uid1 = Object.values(app.party.state.users).find((u) => u.username === 'guest1').id;
  assert.equal(app.streams().meOf(uid1), 4);

  // An abusive address: 300 anonymous streams, 300 sign-ups in a minute.
  const bad = { 'CF-Connecting-IP': '203.0.113.66' };
  const st = [];
  for (let i = 0; i < 300; i++) st.push(await open('/api/live/events', bad));
  assert.equal(st.filter((x) => x === 200).length, 200);
  assert.equal(st.filter((x) => x === 429).length, 100);
  let ok = 0;
  let rate = 0;
  let msg = '';
  for (let i = 0; i < 300; i++) {
    const r = await client(base).post('/api/register', { username: `bot${i}`, password: 'longpassword', name: `Bot ${i}` }, { headers: bad });
    if (r.status === 200) ok++;
    if (r.status === 429) {
      rate++;
      msg = r.json.error;
      assert.ok(Number(r.headers.get('retry-after')) > 0);
    }
  }
  assert.equal(ok, 60);
  assert.equal(rate, 240);
  assert.match(msg, /^Too many sign-ups from this network; try again in \d+ s\.$/);
  // Garbage from one address is cut off sooner (30 failures).
  const junk = { 'CF-Connecting-IP': '203.0.113.77' };
  const codes = [];
  for (let i = 0; i < 32; i++) codes.push((await client(base).post('/api/register', { username: 'x', password: 'longpassword', name: 'X' }, { headers: junk })).status);
  assert.deepEqual(codes, [...new Array(30).fill(400), 429, 429]);
  assert.equal(app.server.maxConnections, 2000);
});

test('public stream: one shared frame per tick (v1 events or one v2 tick frame); a lagging reader is resynced with a snapshot', async (t) => {
  const { base, close, app } = await startApp({ liveMs: 100000, livePostMinMs: 0, liveMetaMinMs: 0 }); // ticks driven by hand
  t.after(close);
  const host = client(base);
  await host.post('/api/register', { username: 'host', password: 'longpassword', name: 'Host' });
  await host.post('/api/admin/start', {});
  const w = client(base);
  await w.post('/api/register', { username: 'ana', password: 'longpassword', name: 'Ana' });
  const post = (await w.post('/api/post/new', { title: 'One' })).json.post;
  await w.post('/api/ops', { postId: post.id, pane: 'body', baseVersion: 0, ops: [{ pos: 0, del: 0, ins: 'Hello' }] });
  const v2 = readSse(`${base}/api/live/events?v=2`, { ms: 1500 });
  const v1 = readSse(`${base}/api/live/events`, { ms: 1500 });
  await sleep(300);
  await w.post('/api/ops', { postId: post.id, pane: 'body', baseVersion: 1, ops: [{ pos: 5, del: 0, ins: ' world' }] });
  app.liveTick();
  const [e2, e1] = await Promise.all([v2, v1]);
  assert.equal(e2[0].event, 'snapshot');
  const ticks = e2.filter((e) => e.event === 'tick');
  assert.equal(ticks.length, 1, 'one frame for the tick');
  assert.deepEqual(ticks[0].data.posts.map((p) => p.d), [[5, 0, ' world']]);
  assert.ok(e1.some((e) => e.event === 'post' && e.data.d && e.data.d[2] === ' world'), 'v1 readers get the same change as events');
  // A reader whose buffer is full skips frames, then gets one snapshot when it drains.
  const writes = [];
  let queued = 600 * 1024;
  const fake = { v2: false, lagSince: 0, res: { destroyed: false, writableEnded: false, get writableLength() { return queued; }, write: (b) => writes.push(String(b)), destroy() { this.destroyed = true; }, on() {} } };
  app.liveClientsForTest.add(fake);
  await w.post('/api/ops', { postId: post.id, pane: 'body', baseVersion: 2, ops: [{ pos: 11, del: 0, ins: '!' }] });
  app.liveTick();
  assert.equal(writes.length, 0, 'frame dropped while behind');
  assert.ok(fake.lagSince > 0);
  queued = 0;
  await w.post('/api/ops', { postId: post.id, pane: 'body', baseVersion: 3, ops: [{ pos: 12, del: 0, ins: '?' }] });
  app.liveTick();
  assert.equal(writes.length, 1);
  assert.match(writes[0], /^event: snapshot\n/);
  assert.match(writes[0], /Hello world!\?/);
  app.liveClientsForTest.delete(fake);
});

test('crash windows: account, start, posts, privacy and host decisions are on disk before the answer; acked ops survive', async () => {
  const first = await startApp({ saveMs: 600_000 }); // the debounced save never runs in this test
  const host = client(first.base);
  await host.post('/api/register', { username: 'host', password: 'longpassword', name: 'Host' });
  await host.post('/api/admin/start', {});
  const w = client(first.base);
  await w.post('/api/register', { username: 'ana', password: 'longpassword', name: 'Ana' });
  await w.post('/api/join', {});
  const post = (await w.post('/api/post/new', { title: 'Private one' })).json.post;
  await w.post('/api/post/update', { id: post.id, privacy: 'separate' });
  const r = await w.post('/api/ops', { postId: post.id, pane: 'body', baseVersion: 0, seq: 'k1', ops: [{ pos: 0, del: 0, ins: 'Acked words. ' }] });
  assert.equal(r.status, 200);
  const onDisk = JSON.parse(fs.readFileSync(first.stateFile, 'utf8'));
  assert.equal(onDisk.party.phase, 'running');
  assert.equal(Object.keys(onDisk.users).length, 2);
  assert.equal(onDisk.posts[post.id].privacy, 'separate');
  // Crash: no final save.
  first.app.saver.flush = () => {};
  await first.close();
  const second = await startApp({ stateFile: first.stateFile });
  const w2 = client(second.base);
  assert.equal((await w2.post('/api/login', { username: 'ana', password: 'longpassword' })).status, 200);
  const got = (await w2.get(`/api/post?id=${post.id}&pane=body`)).json;
  assert.equal(got.text, 'Acked words. ');
  const posts = (await w2.get('/api/posts')).json.posts;
  assert.equal(posts.find((p) => p.id === post.id).privacy, 'separate', 'a privacy change is never lost');
  // A retry of the acked batch after the restart is recognised.
  const again = await w2.post('/api/ops', { postId: post.id, pane: 'body', baseVersion: 0, seq: 'k1', ops: [{ pos: 0, del: 0, ins: 'Acked words. ' }] });
  assert.equal(again.json.duplicate, true);
  await second.close();
});

test('state saver: periodic saves run in the background and land in order; flush() writes at once', async () => {
  const { createSaver } = await import('../lib/store.js');
  const file = tmpStateFile();
  let n = 0;
  const saver = createSaver(file, () => ({ n }), { delayMs: 10, log: { error() {} } });
  n = 1;
  saver.schedule();
  await sleep(30); // the background save of n = 1 has started (and may still be writing)
  n = 2;
  saver.schedule();
  saver.flush(); // n = 2 lands synchronously
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).n, 2);
  await sleep(200);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).n, 2, 'the older background save never replaces it');
  n = 3;
  saver.schedule();
  await sleep(200);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).n, 3);
  const dir = path.dirname(file);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')), [], 'no temp files left');
});

test('public stream: a batch reaches readers within about a quarter second; each post updates about once a second at most', async (t) => {
  const { base, close } = await startApp({ liveMs: 250 });
  t.after(close);
  const host = client(base);
  await host.post('/api/register', { username: 'host', password: 'longpassword', name: 'Host' });
  await host.post('/api/admin/start', {});
  const w = client(base);
  await w.post('/api/register', { username: 'ana', password: 'longpassword', name: 'Ana' });
  const post = (await w.post('/api/post/new', { title: 'Fast' })).json.post;
  await w.post('/api/ops', { postId: post.id, pane: 'body', baseVersion: 0, ops: [{ pos: 0, del: 0, ins: 'Start' }] });
  await sleep(1300);
  const seen = [];
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/live/events`, { signal: ctrl.signal });
  let sentAt = 0;
  const reading = (async () => {
    const dec = new TextDecoder();
    try {
      for await (const chunk of res.body) {
        const text = dec.decode(chunk);
        for (const m of text.matchAll(/event: post\ndata: (.*)\n/g)) seen.push({ at: performance.now(), d: JSON.parse(m[1]).d });
      }
    } catch { /* aborted */ }
  })();
  await sleep(300);
  sentAt = performance.now();
  await w.post('/api/ops', { postId: post.id, pane: 'body', baseVersion: 1, ops: [{ pos: 5, del: 0, ins: ' one' }] });
  await sleep(300);
  await w.post('/api/ops', { postId: post.id, pane: 'body', baseVersion: 2, ops: [{ pos: 9, del: 0, ins: ' two' }] });
  await sleep(1600);
  ctrl.abort();
  await reading;
  assert.ok(seen.length >= 2, `${seen.length} updates`);
  assert.ok(seen[0].at - sentAt < 600, `first update after ${Math.round(seen[0].at - sentAt)} ms`);
  assert.deepEqual(seen[0].d, [5, 0, ' one']);
  assert.ok(seen[1].at - seen[0].at >= 700, `second update ${Math.round(seen[1].at - seen[0].at)} ms after the first`);
});

test('boot removes temp files a crash mid-save left behind', async () => {
  const file = tmpStateFile();
  fs.writeFileSync(`${file}.tmp-123-bg4`, '{"half":');
  fs.writeFileSync(`${file}.tmp-99`, '');
  const app = await startApp({ stateFile: file });
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp-')), []);
  await app.close();
});

test('the account cap never turns away sign-ups from the venue (a network a host is signed in from)', async (t) => {
  const { base, close } = await startApp({ proxy: 'cloudflare' });
  t.after(close);
  const venue = { 'CF-Connecting-IP': '192.0.2.50' };
  const host = client(base);
  await host.post('/api/register', { username: 'host', password: 'longpassword', name: 'Host' }, { headers: venue });
  await host.post('/api/admin/settings', { scoring: { maxUsers: 3 } }, { headers: venue });
  for (let i = 0; i < 2; i++) assert.equal((await client(base).post('/api/register', { username: `far${i}`, password: 'longpassword', name: 'Far' }, { headers: { 'CF-Connecting-IP': `198.51.100.${i}` } })).status, 200);
  const full = await client(base).post('/api/register', { username: 'far9', password: 'longpassword', name: 'Far' }, { headers: { 'CF-Connecting-IP': '198.51.100.9' } });
  assert.equal(full.status, 403);
  assert.equal(full.json.code, 'full');
  for (let i = 0; i < 5; i++) assert.equal((await client(base).post('/api/register', { username: `room${i}`, password: 'longpassword', name: 'Room' }, { headers: venue })).status, 200);
});

test('extra routes: registered from outside, tried before /api and static files, errors become JSON', async (t) => {
  const seen = [];
  const routes = [
    { method: 'POST', match: (p) => (p === '/api/uploads' ? {} : null), handle: async (req, res, h) => {
      if (!h.ctx.userId) throw new h.HttpError(401, 'Please sign in first');
      if (req.headers['x-wh'] !== '1') throw new h.HttpError(403, 'Forbidden');
      seen.push(req.headers['content-type']);
      req.resume();
      h.sendJson(200, { ok: true, url: '/u/abc.webp' });
    } },
    { method: 'GET', match: (p) => { const m = /^\/u\/([a-z0-9]+)\.(webp|png)$/.exec(p); return m ? { id: m[1], ext: m[2] } : null; }, handle: async (req, res, h) => {
      res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=31536000, immutable' });
      res.end(`img:${h.params.id}`);
    } },
  ];
  const { base, close, app } = await startApp({ routes });
  t.after(close);
  const w = client(base);
  let r = await fetch(`${base}/api/uploads`, { method: 'POST', headers: { 'Content-Type': 'image/webp', 'X-WH': '1' }, body: 'RIFF' });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, 'Please sign in first');
  await w.post('/api/register', { username: 'host', password: 'longpassword', name: 'Host' });
  r = await fetch(`${base}/api/uploads`, { method: 'POST', headers: { 'Content-Type': 'image/webp', 'X-WH': '1', Cookie: w.cookie }, body: 'RIFF' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, url: '/u/abc.webp' });
  assert.deepEqual(seen, ['image/webp'], 'a binary body reaches the route (no JSON gate)');
  r = await fetch(`${base}/u/abc.webp`);
  assert.equal(await r.text(), 'img:abc');
  assert.equal(r.headers.get('content-security-policy') !== null, true, 'security headers still set');
  assert.equal((await fetch(`${base}/u/nope.exe`)).status, 404);
  app.extraRoutes.push({ method: 'GET', match: (p) => (p === '/api/late' ? {} : null), handle: async (req, res, h) => h.sendJson(200, { late: true }) });
  assert.deepEqual(await (await fetch(`${base}/api/late`)).json(), { late: true });
});

// A raw connection to the app: what came back, and whether it was closed. `from`: the local
// address to connect from. All of 127/8 is this machine, but the server counts only 127.0.0.1
// as loopback, so 127.0.0.2 and 127.0.0.3 stand in for two other clients.
function rawSocket(port, { from = undefined, send = '' } = {}) {
  const c = { got: '', closed: false, error: null };
  c.socket = net.connect({ port, host: '127.0.0.1', localAddress: from }, () => send && c.socket.write(send));
  c.socket.on('data', (d) => { c.got += d; });
  c.socket.on('error', (e) => { c.error = e; });
  c.socket.on('close', () => { c.closed = true; });
  c.status = () => Number(/^HTTP\/1\.1 (\d+)/.exec(c.got)?.[1] ?? 0);
  return c;
}
const GET_HEALTH = 'GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n';
async function eventually(fn, ms = 5000) {
  for (let i = 0; i < ms / 20 && !fn(); i++) await sleep(20);
  return fn();
}

test('connections: one address holds only its share; other addresses and this machine are still served', async (t) => {
  const { networkOf } = await import('../server.js');
  assert.equal(networkOf('203.0.113.9'), '203.0.113.9');
  assert.equal(networkOf('::ffff:203.0.113.9'), '203.0.113.9', 'IPv4 on a listener for both families');
  assert.equal(networkOf('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
  assert.equal(networkOf('2001:db8:1:2::9'), '2001:db8:1:2::/64', 'a whole /64 is one client');
  assert.equal(networkOf('2001:db8:1:3::9'), '2001:db8:1:3::/64');
  assert.equal(networkOf('2001:db8::7'), '2001:db8:0:0::/64');
  assert.equal(networkOf('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.equal(networkOf(undefined), '?');

  const errors = [];
  const { app, close } = await startApp({ maxConnectionsPerIp: 5, log: { error: (...a) => errors.push(a.join(' ')), log() {}, warn() {} } });
  t.after(close);
  const port = app.server.address().port;
  const open = [];
  t.after(() => { for (const c of open) c.socket.destroy(); });
  const conn = (from) => {
    const c = rawSocket(port, { from, send: GET_HEALTH });
    open.push(c);
    return c;
  };
  const settled = (list) => eventually(() => list.every((c) => c.status() || c.closed));
  const first = conn('127.0.0.2');
  await settled([first]);
  if (first.error?.code === 'EADDRNOTAVAIL') {
    t.skip('needs a second loopback address (127.0.0.2)');
    return;
  }
  // Eight kept-alive connections from one address: five are served, the rest closed unanswered.
  const hog = [first, ...Array.from({ length: 7 }, () => conn('127.0.0.2'))];
  await settled(hog);
  assert.equal(hog.filter((c) => c.status() === 200 && !c.closed).length, 5);
  assert.equal(hog.filter((c) => c.closed && !c.got).length, 3);
  assert.equal(errors.filter((e) => /^\[conn\] 127\.0\.0\.2 has 5 connections open/.test(e)).length, 1, 'logged once, not per refusal');
  // Another address is served meanwhile, and so is this machine, past the share (a tunnel or proxy).
  const others = [conn('127.0.0.3'), ...Array.from({ length: 8 }, () => conn('127.0.0.1'))];
  await settled(others);
  assert.deepEqual(others.map((c) => c.status()), new Array(9).fill(200));
  // The share is of connections open now: one closes, the next is served.
  const held = () => new Promise((resolve) => { app.server.getConnections((e, n) => resolve(n)); });
  const n = await held();
  hog.find((c) => !c.closed).socket.destroy();
  for (let i = 0; i < 250 && (await held()) >= n; i++) await sleep(20);
  const again = [conn('127.0.0.2'), conn('127.0.0.2')];
  await settled(again);
  assert.deepEqual(again.map((c) => c.status()).sort(), [0, 200]);
});

test('connections: one that sends no request is closed; idle keep-alive connections and open streams stay', async (t) => {
  const { app, close } = await startApp({ headersTimeoutMs: 300 });
  t.after(close);
  const port = app.server.address().port;
  const silent = rawSocket(port);
  const half = rawSocket(port, { send: 'GET /healthz HT' });
  const idle = rawSocket(port, { send: GET_HEALTH });
  const stream = rawSocket(port, { send: 'GET /api/live/events HTTP/1.1\r\nHost: x\r\n\r\n' });
  t.after(() => { for (const c of [silent, half, idle, stream]) c.socket.destroy(); });
  assert.ok(await eventually(() => silent.closed && half.closed), 'closed by the server');
  assert.equal(silent.status(), 408);
  await sleep(900); // three timeouts later
  assert.equal(idle.closed, false, 'between requests the clock isn’t running');
  assert.equal(stream.closed, false);
  assert.match(stream.got, /text\/event-stream/);
  idle.got = '';
  idle.socket.write(GET_HEALTH);
  assert.ok(await eventually(() => idle.status() === 200), 'the kept-alive connection answers again');
});

test('http: op batches and paste checks are refused before their body is read, unless the caller is an approved writer', async (t) => {
  const { app, base, close } = await startApp({ approvalRequired: true });
  t.after(close);
  const port = app.server.address().port;
  const host = client(base);
  await host.post('/api/register', { username: 'host', password: 'longpassword', name: 'Host' });
  const pending = client(base);
  await pending.post('/api/register', { username: 'ruth', password: 'longpassword', name: 'Ruth' });
  // 4 MB announced and never sent: the answer can't have waited for it.
  const announce = (p, cookie = '') => rawSocket(port, { send: `POST ${p} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nX-WH: 1\r\nContent-Length: 4000000\r\n${cookie ? `Cookie: ${cookie}\r\n` : ''}\r\n{"ops":[` });
  const calls = [announce('/api/ops'), announce('/api/paste/check'), announce('/api/ops', pending.cookie), announce('/api/ops', host.cookie)];
  t.after(() => { for (const c of calls) c.socket.destroy(); });
  await eventually(() => calls.slice(0, 3).every((c) => c.status()), 2000);
  assert.deepEqual(calls.map((c) => c.status()), [401, 401, 403, 0], 'signed out, signed out, waiting for approval; an approved writer’s body is waited for');
  assert.match(calls[2].got, /"error":"pending_approval"/);
});
