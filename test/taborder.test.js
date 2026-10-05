// The order of a writer's tabs (SPEC §29): POST /api/me/tab-order (lib/taborder.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startApp, client, readSse } from './helpers.js';
import { attachTabOrder } from '../lib/taborder.js';

async function app(opts = {}) {
  const a = await startApp(opts);
  attachTabOrder(a.app);
  return a;
}
async function signUp(base, username) {
  const c = client(base);
  const r = await c.post('/api/register', { username, password: 'longpassword', name: username });
  assert.equal(r.status, 200, r.text);
  return c;
}
async function newPosts(c, titles) {
  const ids = [];
  for (const title of titles) ids.push((await c.post('/api/post/new', { title })).json.post.id);
  return ids;
}
const order = async (c) => (await c.get('/api/posts')).json.posts.map((p) => p.title);

test('tab order: own posts only, unknown ids ignored, closed posts keep their place, other devices follow, survives a restart', async (t) => {
  const one = await app();
  let oneOpen = true;
  t.after(() => (oneOpen ? one.close() : undefined));
  const host = await signUp(one.base, 'host');
  assert.equal((await host.post('/api/admin/start', {})).status, 200);
  const ana = await signUp(one.base, 'ana');
  const ben = await signUp(one.base, 'ben');
  await ana.post('/api/join', {});
  await ben.post('/api/join', {});
  const [a1, a2, a3, a4] = await newPosts(ana, ['A1', 'A2', 'A3', 'A4']);
  const [b1, b2] = await newPosts(ben, ['B1', 'B2']);
  assert.deepEqual(await order(ana), ['A1', 'A2', 'A3', 'A4']);

  // Signed out, without the CSRF header, or with a body that isn't a list: refused.
  assert.equal((await client(one.base).post('/api/me/tab-order', { ids: [a2, a1] })).status, 401);
  assert.equal((await ana.post('/api/me/tab-order', { ids: [a2, a1] }, { headers: { 'X-WH': '0' } })).status, 403);
  assert.equal((await ana.post('/api/me/tab-order', { ids: a1 })).status, 400);
  assert.equal((await ana.post('/api/me/tab-order', { ids: [a1, 7] })).status, 400);
  assert.deepEqual(await order(ana), ['A1', 'A2', 'A3', 'A4'], 'nothing changed');

  // Another writer's ids, unknown ids and repeats are ignored; posts left out follow in their order.
  let r = await ana.post('/api/me/tab-order', { ids: [a3, b1, 'p-nope', a1, a3] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.ids, [a3, a1, a2, a4]);
  assert.deepEqual(await order(ana), ['A3', 'A1', 'A2', 'A4']);
  assert.deepEqual(await order(ben), ['B1', 'B2'], 'the other writer’s order is untouched');
  // Ben can't move Ana's posts.
  r = await ben.post('/api/me/tab-order', { ids: [a4, b2, b1] });
  assert.deepEqual(r.json.ids, [b2, b1]);
  assert.deepEqual(await order(ana), ['A3', 'A1', 'A2', 'A4']);

  // Closed posts keep their place among the closed: the open tabs are sent, the closed follow.
  await ana.post('/api/post/update', { id: a2, closed: true });
  await ana.post('/api/post/update', { id: a3, closed: true });
  r = await ana.post('/api/me/tab-order', { ids: [a4, a1] });
  assert.deepEqual(await order(ana), ['A4', 'A1', 'A3', 'A2'], 'A3 still before A2');

  // The writer's other devices get it on their `me` stream.
  r = await ana.post('/api/me/tab-order', { ids: [a1, a4, a2, a3] });
  const events = await readSse(`${one.base}/api/me/events`, { cookie: ana.cookie, ms: 1500, until: (ev) => ev.some((e) => e.event === 'me') });
  const me = events.find((e) => e.event === 'me');
  assert.ok(me, 'a me event');
  assert.deepEqual(me.data.posts.map((p) => p.id), [a1, a4, a2, a3]);

  // A new post goes after the others.
  const [a5] = await newPosts(ana, ['A5']);
  assert.deepEqual((await ana.get('/api/posts')).json.posts.map((p) => p.id), [a1, a4, a2, a3, a5]);

  // Kept across a restart.
  oneOpen = false;
  await one.close();
  const stateFile = `${one.stateFile}.copy`;
  fs.copyFileSync(one.stateFile, stateFile);
  const two = await app({ stateFile });
  t.after(two.close);
  const ana2 = client(two.base);
  assert.equal((await ana2.post('/api/login', { username: 'ana', password: 'longpassword' })).status, 200);
  assert.deepEqual(await order(ana2), ['A1', 'A4', 'A2', 'A3', 'A5']);
  const ben2 = client(two.base);
  assert.equal((await ben2.post('/api/login', { username: 'ben', password: 'longpassword' })).status, 200);
  assert.deepEqual(await order(ben2), ['B2', 'B1']);
});

test('tab order: nothing public changes', async (t) => {
  const { base, close, app: a } = await app();
  t.after(close);
  const host = await signUp(base, 'host');
  await host.post('/api/admin/start', {});
  const ana = await signUp(base, 'ana');
  await ana.post('/api/join', {});
  const [a1, a2] = await newPosts(ana, ['First', 'Second']);
  const rev = a.party.publicRev;
  const r = await ana.post('/api/me/tab-order', { ids: [a2, a1] });
  assert.deepEqual(r.json.ids, [a2, a1]);
  assert.equal(a.party.publicRev, rev, 'no public change');
  // The same order again is no change at all.
  assert.deepEqual((await ana.post('/api/me/tab-order', { ids: [a2, a1] })).json.ids, [a2, a1]);
});
