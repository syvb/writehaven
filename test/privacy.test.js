import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client, readSse, sleep } from './helpers.js';

// Every string and number anywhere inside a JSON value.
function leaves(v, out = []) {
  if (v === null || v === undefined) return out;
  if (typeof v === 'string' || typeof v === 'number') out.push(v);
  else if (Array.isArray(v)) for (const x of v) leaves(x, out);
  else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); leaves(x, out); }
  return out;
}
function assertNoLeak(payloads, forbidden, label) {
  for (const [name, payload] of payloads) {
    const all = leaves(payload);
    const flat = JSON.stringify(payload);
    for (const [what, needle] of forbidden) {
      if (typeof needle === 'number') {
        assert.ok(!all.includes(needle), `${label}: ${name} contains ${what} (${needle})`);
      } else {
        assert.ok(!all.some((x) => typeof x === 'string' && x.includes(needle)), `${label}: ${name} contains ${what}`);
        assert.ok(!flat.includes(needle), `${label}: ${name} contains ${what} (raw)`);
      }
    }
  }
}

test('public payloads never contain user ids, usernames, notes, separate posts, or op timestamps', async (t) => {
  const { app, base, close } = await startApp({ liveMs: 100 });
  t.after(close);
  const host = client(base);
  await host.post('/api/register', { username: 'hostuser', password: 'longpassword', name: 'Hosting Person' });
  await host.post('/api/admin/start', {});
  const mk = async (username, name) => {
    const c = client(base);
    const r = await c.post('/api/register', { username, password: 'longpassword', name });
    await c.post('/api/join', {});
    return { c, id: r.json.user.id, username, name };
  };
  const ana = await mk('anauser', 'Anastasia Quill');
  const bob = await mk('bobuser', 'Bartholomew Ink');
  const cy = await mk('cyuser', 'Cyrene Named');
  const posts = {};
  const write = async (w, key, title, privacy, body, notes) => {
    const p = (await w.c.post('/api/post/new', { title })).json.post;
    await w.c.post('/api/post/update', { id: p.id, privacy });
    await w.c.post('/api/ops', { postId: p.id, pane: 'body', baseVersion: 0, sentAt: Date.now(), ops: [{ at: Date.now(), pos: 0, del: 0, ins: body }] });
    if (notes) await w.c.post('/api/ops', { postId: p.id, pane: 'notes', baseVersion: 0, ops: [{ pos: 0, del: 0, ins: notes }] });
    posts[key] = p;
  };
  const streamP = readSse(`${base}/api/live/events`, { ms: 4000 });
  await sleep(150);
  await write(ana, 'live', 'An open letter', 'live', 'Streaming words from the first writer.', 'NOTES-SECRET-plan-zebra');
  await write(ana, 'sep', 'Hidden heron title', 'separate', 'separate-identity-text-walrus', 'NOTES-SECRET-two');
  await write(bob, 'live2', 'Bob in public', 'live', 'Second writer streaming along.', null);
  await write(bob, 'unl', 'Personal unlisted', 'live', 'UNLISTED-personal-content-otter', null);
  await write(cy, 'named', 'Signed piece', 'named', 'A named post, by choice.', 'NOTES-SECRET-three');
  // Let the stream carry the soon-to-be-hidden post before the host hides it.
  for (let i = 0; i < 50 && !(await client(base).get('/api/live')).json.posts.some((p) => p.title === 'Personal unlisted'); i++) await sleep(100);
  await sleep(400);
  const bobRow = (await host.get('/api/admin/state')).json.writers.find((w) => w.username === 'bobuser');
  const unlId = (await host.get(`/api/admin/writer?id=${bobRow.id}`)).json.posts.find((p) => p.title === 'Personal unlisted').id;
  await host.post('/api/admin/post', { id: unlId, unlisted: true });
  await sleep(400);
  const anon = client(base);
  const live = (await anon.get('/api/live')).json;
  const stream = await streamP;
  const archiveBefore = (await anon.get('/api/archive')).json;
  const session = (await anon.get('/api/session')).json;
  const pubPages = [];
  for (const p of live.posts) pubPages.push([`/api/p/${p.id}`, (await anon.get(`/api/p/${p.id}`)).json]);
  // Sanity: the live posts are there, the named one carries its name.
  const titles = live.posts.map((p) => p.title).sort();
  assert.deepEqual(titles, ['An open letter', 'Bob in public', 'Signed piece']);
  assert.equal(live.posts.find((p) => p.title === 'Signed piece').name, 'Cyrene Named');
  assert.ok(live.posts.filter((p) => p.title !== 'Signed piece').every((p) => p.name === null));
  // The separate post's public id is unreachable before the end.
  const st = app.party.state;
  const sepPost = Object.values(st.posts).find((p) => p.title === 'Hidden heron title');
  assert.equal((await anon.get(`/api/p/${sepPost.publicId}`)).status, 404);

  const opTimes = Object.values(st.ops).flat().map((o) => o[0]);
  const users = Object.values(st.users);
  const forbidden = [
    ...users.map((u) => [`user id of ${u.username}`, u.id]),
    ...users.map((u) => [`username ${u.username}`, u.username]),
    ['name of an anonymous writer', 'Anastasia Quill'],
    ['name of an anonymous writer', 'Bartholomew Ink'],
    ['host name', 'Hosting Person'],
    ['planning notes', 'NOTES-SECRET'],
    ['separate post title', 'Hidden heron'],
    ['separate post text', 'walrus'],
    ['separate post public id', sepPost.publicId],
    ['unlisted text', 'UNLISTED-personal'],
    ['unlisted title', 'Personal unlisted'],
    ...Object.values(st.posts).map((p) => ['internal post id', p.id]),
    ...opTimes.map((tm) => ['op timestamp', tm]),
    ...users.filter((u) => u.joinedAt).map((u) => ['joinedAt', u.joinedAt]),
    ['session cookie', 'wh_sess'],
    ['password hash', 'scrypt'],
  ];
  const payloads = [['/api/live', live], ['/api/archive', archiveBefore], ['/api/session', session], ...pubPages];
  assert.ok(stream.length >= 3, 'stream carried events');
  assertNoLeak(payloads, forbidden, 'running');
  // The stream also carried the unlisted post until the host hid it; then it was removed.
  const unlistedNeedles = new Set(['unlisted text', 'unlisted title']);
  assertNoLeak(stream.map((e, i) => [`SSE ${e.event} #${i}`, e.data]), forbidden.filter(([w]) => !unlistedNeedles.has(w)), 'running stream');
  const unlPublic = stream.find((e) => e.event === 'post' && e.data.title === 'Personal unlisted');
  assert.ok(unlPublic, 'the post was streamed before it was hidden');
  assert.ok(stream.some((e) => e.event === 'remove' && e.data.id === unlPublic.data.id), 'unlisting removes the post from the stream');
  // The named post's author is the only name, and only on that post.
  const named = live.posts.find((p) => p.name);
  assert.deepEqual(Object.keys(named).sort(), ['active', 'id', 'name', 'text', 'title']);

  // After the end: separate posts are published (no timestamps, random order), notes never.
  await host.post('/api/admin/end', {});
  await sleep(250);
  const archive = (await anon.get('/api/archive')).json;
  const atitles = archive.posts.map((p) => p.title).sort();
  assert.deepEqual(atitles, ['An open letter', 'Bob in public', 'Hidden heron title', 'Signed piece']);
  for (const p of archive.posts) assert.deepEqual(Object.keys(p).sort(), ['excerpt', 'id', 'name', 'title', 'words']);
  const sepPage = (await anon.get(`/api/p/${sepPost.publicId}`)).json;
  assert.equal(sepPage.text, 'separate-identity-text-walrus');
  assert.equal(sepPage.name, null);
  const after = [['/api/archive (ended)', archive], ['/api/p separate', sepPage], ['/api/live (ended)', (await anon.get('/api/live')).json]];
  const forbiddenAfter = forbidden.filter(([what]) => !['separate post title', 'separate post text', 'separate post public id'].includes(what));
  assertNoLeak(after, forbiddenAfter, 'ended');
  assert.equal((await anon.get(`/api/p/${posts.unl?.id || 'x'}`)).status, 404);
});
