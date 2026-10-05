// Sign-in hardening: who becomes a host, parallel guesses and bounded password hashing, signed-in
// live streams that end with their session (and a per-person cap). Plus the sign-up page's party
// facts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client, sleep } from './helpers.js';
import { attachAccounts } from '../lib/accounts.js';
import { createHashGate } from '../lib/hashgate.js';

const reg = (c, username, extra = {}) => c.post('/api/register', { username, password: 'longpassword', name: username.toUpperCase(), ...extra });

test('with a setup token, the first account needs the setup link; configured host names can’t be claimed', async (t) => {
  const { base, close, app } = await startApp({ adminUsers: ['carol', 'dora'], setupToken: 's3tup-token' });
  t.after(close);
  let r = await client(base).get('/api/session');
  assert.equal(r.json.party.needsSetup, true);
  r = await reg(client(base), 'host');
  assert.deepEqual([r.status, r.json.code], [403, 'setup_required']);
  r = await reg(client(base), 'host', { setup: 's3tup-tokeN' });
  assert.deepEqual([r.status, r.json.code], [403, 'setup_required']);
  const h = client(base);
  r = await reg(h, 'host', { setup: 's3tup-token' });
  assert.deepEqual([r.status, r.json.user.isAdmin], [200, true]);
  assert.equal((await client(base).get('/api/session')).json.party.needsSetup, undefined);
  // An unclaimed WH_ADMIN_USERS name: refused to everyone, sign-ups open or closed.
  r = await reg(client(base), 'carol');
  assert.deepEqual([r.status, r.json.code, r.json.field], [409, 'username_reserved', 'username']);
  await h.post('/api/admin/registration', { open: false });
  r = await reg(client(base), 'Carol', { setup: 's3tup-token' });
  assert.equal(r.status, 409);
  assert.equal(app.party.userByUsername('carol'), null);
  // ...but an account that already exists under such a name is a host at its next sign-in.
  const dora = app.party.register(app.party.validateRegistration({ username: 'dora', password: 'x'.repeat(8), name: 'Dora' }, { ignoreCap: true }), app.party.userByUsername('host').passHash);
  dora.isAdmin = false;
  r = await client(base).post('/api/login', { username: 'dora', password: 'longpassword' });
  assert.deepEqual([r.status, r.json.user.isAdmin], [200, true]);
});

test('without a setup token, the first account is the host and configured host names sign up as hosts', async (t) => {
  const { base, close } = await startApp({ adminUsers: ['carol'] });
  t.after(close);
  let r = await reg(client(base), 'host');
  assert.equal(r.json.user.isAdmin, true);
  r = await reg(client(base), 'carol');
  assert.equal(r.json.user.isAdmin, true);
  assert.equal((await client(base).get('/api/session')).json.party.needsSetup, undefined);
});

test('parallel wrong passwords can’t get past the failed-login limit', async (t) => {
  const { base, close } = await startApp({ hashLimits: { running: 2, queued: 100, perIp: 100 } });
  t.after(close);
  await reg(client(base), 'host');
  await reg(client(base), 'ana');
  const res = await Promise.all(Array.from({ length: 40 }, (_, i) => client(base).post('/api/login', { username: 'ana', password: `guess-${i}` })));
  const n = (s) => res.filter((r) => r.status === s).length;
  assert.equal(n(401), 10, 'ten tries per address and username, however parallel');
  assert.equal(n(429), 30);
  assert.equal((await client(base).post('/api/login', { username: 'ana', password: 'longpassword' })).status, 429);
  // Another username from the same venue isn't affected.
  assert.equal((await client(base).post('/api/login', { username: 'host', password: 'longpassword' })).status, 200);
});

test('password hashing is bounded; past the bound a quick 503 with Retry-After, not counted as a wrong guess', async (t) => {
  const { base, close } = await startApp({ hashLimits: { running: 1, queued: 3, perIp: 1 } });
  t.after(close);
  await reg(client(base), 'host');
  await reg(client(base), 'ben');
  const res = await Promise.all(Array.from({ length: 12 }, (_, i) => client(base).post('/api/login', { username: 'ben', password: `guess-${i}` })));
  const busy = res.filter((r) => r.status === 503);
  assert.ok(busy.length >= 10, `refused at once: ${busy.length}`);
  assert.equal(busy[0].json.code, 'busy');
  assert.equal(busy[0].headers.get('retry-after'), '2');
  assert.equal(res.filter((r) => r.status === 401).length + busy.length, 12);
  // The busy ones weren't counted: nine more wrong tries are still allowed, then the limit.
  const wrongSoFar = res.filter((r) => r.status === 401).length;
  for (let i = 0; i < 10 - wrongSoFar; i++) assert.equal((await client(base).post('/api/login', { username: 'ben', password: `again-${i}` })).status, 401);
  assert.equal((await client(base).post('/api/login', { username: 'ben', password: 'again-x' })).status, 429);
  // The server stays responsive.
  const t0 = performance.now();
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.ok(performance.now() - t0 < 500);
});

test('the hash gate itself (global queue, per address, a host network)', async () => {
  const g = createHashGate({ running: 1, queued: 2, perIp: 2, perHostIp: 3 });
  let release;
  const slow = () => new Promise((r) => { release = r; });
  const p1 = g.run('a', slow);
  const p2 = g.run('a', () => 2);
  await assert.rejects(g.run('a', () => 3), (e) => e.status === 503 && e.extra.code === 'busy');
  const p3 = g.run('h', () => 'host', { host: true });
  await assert.rejects(g.run('b', () => 4), (e) => e.status === 503, 'the queue is full');
  assert.deepEqual(g.stats, { running: 1, queued: 2, addresses: 2 });
  release(1);
  assert.deepEqual(await Promise.all([p1, p2, p3]), [1, 2, 'host']);
  assert.deepEqual(g.stats, { running: 0, queued: 0, addresses: 0 });
});

async function openLive(base, cookie, ctrl) {
  fetch(`${base}/api/live/events`, { headers: cookie ? { Cookie: cookie } : {}, signal: ctrl.signal }).catch(() => {});
}
// Generous: the full suite runs many servers in parallel, and opening streams can lag under load.
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(50);
  }
  return fn();
}

test('signed-in live streams end with their session, and one person has at most 8', async (t) => {
  const { base, close, app } = await startApp();
  attachAccounts(app);
  t.after(close);
  const ctrl = new AbortController();
  t.after(() => ctrl.abort());
  const ana = client(base);
  await reg(ana, 'ana');
  for (let i = 0; i < 3; i++) openLive(base, ana.cookie, ctrl);
  assert.ok(await until(() => app.streams().live === 3));
  // Twelve newer sign-ins evict that session: its streams close within a second.
  const others = [];
  for (let i = 0; i < 12; i++) {
    const c = client(base);
    await c.post('/api/login', { username: 'ana', password: 'longpassword' });
    others.push(c);
  }
  assert.ok(await until(() => app.streams().live === 0), `still open: ${app.streams().live}`);
  // A per-person cap across sessions (each session alone allows 4).
  for (const c of others) for (let i = 0; i < 4; i++) openLive(base, c.cookie, ctrl);
  await sleep(600);
  assert.ok(await until(() => app.streams().live <= 8), `open: ${app.streams().live}`);
  // Signing out ends that session's streams at once; a password change ends the other sessions'.
  const last = others[others.length - 1];
  await last.post('/api/logout', {});
  const before = app.streams().live;
  const keep = others[0];
  const r = await keep.post('/api/me/account', { password: 'new-password-1', currentPassword: 'longpassword' });
  assert.equal(r.status, 200);
  assert.ok(await until(() => app.streams().live === [...app.liveClientsForTest].filter((x) => x.token && keep.cookie.endsWith(x.token)).length), `left: ${app.streams().live} (was ${before})`);
  // Anonymous readers are untouched.
  openLive(base, '', ctrl);
  assert.ok(await until(() => [...app.liveClientsForTest].some((x) => !x.token)));
});

test('the sign-up page knows whether new accounts need approval, and the challenge’s numbers', async (t) => {
  const { base, close, app } = await startApp({ approvalRequired: true });
  t.after(close);
  const party = (await client(base).get('/api/session')).json.party;
  assert.equal(party.approvalRequired, true);
  assert.deepEqual([party.rules.targetPerHour, party.rules.hourLengthMin, party.rules.missedHourOutcome], [app.party.S.targetPerHour, app.party.S.hourLengthMin, app.party.S.missedHourOutcome]);
  assert.deepEqual(party.rules, (await client(base).get('/api/live')).json.party.rules, 'the same public rules as the live page');
});
