// The build id (server.js buildVersion(), the ?v= on every module URL) reaches open pages, so they
// can tell that a new build was deployed (public/js/update.js): with the session, from
// GET /api/build, and in the first event of the live stream and of a writer's own stream.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApp, client, readSse, sleep } from './helpers.js';

test('build: /api/session carries the build id that the page’s module URLs carry', async (t) => {
  const { base, close } = await startApp();
  t.after(close);
  const c = client(base);
  const s = await c.get('/api/session');
  assert.equal(s.status, 200);
  assert.equal(s.headers.get('cache-control'), 'no-store');
  assert.match(s.json.build, /^[0-9a-f]{10}$/);
  const html = await (await fetch(`${base}/`)).text();
  assert.ok(html.includes(`/js/app.js?v=${s.json.build}`), 'index.html loads app.js with the same build');
  const b = await c.get('/api/build');
  assert.equal(b.status, 200);
  assert.equal(b.headers.get('cache-control'), 'no-store');
  assert.deepEqual(b.json, { build: s.json.build });
  // Signed in, the same.
  assert.equal((await c.post('/api/register', { username: 'ana', password: 'longpassword', name: 'Ana' })).status, 200);
  const s2 = await c.get('/api/session');
  assert.equal(s2.json.user.username, 'ana');
  assert.equal(s2.json.build, s.json.build);
});

test('build: the first event of the live stream (v1 and v2) and of the writer’s own stream carry it', async (t) => {
  const { base, close } = await startApp();
  t.after(close);
  const c = client(base);
  await c.post('/api/register', { username: 'ana', password: 'longpassword', name: 'Ana' });
  const { build } = (await c.get('/api/build')).json;
  for (const url of ['/api/live/events', '/api/live/events?v=2']) {
    const ev = await readSse(base + url, { ms: 2000, until: (e) => e.length >= 1 });
    assert.equal(ev[0]?.event, 'snapshot', url);
    assert.equal(ev[0].data.build, build, url);
    assert.ok(ev[0].data.party, `${url}: the snapshot is otherwise as before`);
  }
  const me = await readSse(`${base}/api/me/events`, { cookie: c.cookie, ms: 2000, until: (e) => e.length >= 1 });
  assert.equal(me[0]?.event, 'me');
  assert.equal(me[0].data.build, build);
  assert.equal(me[0].data.me.username, 'ana', 'the me view is otherwise as before');
});

test('build: changed files make a new build id, seen by the session, new streams and the page at once', async (t) => {
  // A small public folder of its own: a deploy swaps files, which changes their mtime and size.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-build-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'js'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!DOCTYPE html><script type="module" src="/js/app.js?v=__V__"></script>');
  fs.writeFileSync(path.join(dir, 'js', 'app.js'), "import './net.js';\n");
  fs.writeFileSync(path.join(dir, 'js', 'net.js'), 'export {};\n');
  const { base, close } = await startApp({ publicDir: dir });
  t.after(close);
  const c = client(base);
  const a = (await c.get('/api/session')).json.build;
  const snapA = (await readSse(`${base}/api/live/events`, { ms: 2000, until: (e) => e.length >= 1 }))[0];
  assert.equal(snapA.data.build, a);
  assert.match(await (await fetch(`${base}/js/app.js?v=${a}`)).text(), new RegExp(`net\\.js\\?v=${a}`));

  fs.writeFileSync(path.join(dir, 'js', 'net.js'), 'export const deployed = true;\n');
  await sleep(1100); // the build id is worked out at most once a second
  const b = (await c.get('/api/session')).json.build;
  assert.match(b, /^[0-9a-f]{10}$/);
  assert.notEqual(b, a, 'a changed file is a new build');
  assert.equal((await c.get('/api/build')).json.build, b);
  assert.ok((await (await fetch(`${base}/`)).text()).includes(`/js/app.js?v=${b}`));
  // The live snapshot is rebuilt for the new build even though nothing public changed.
  const snapB = (await readSse(`${base}/api/live/events?v=2`, { ms: 2000, until: (e) => e.length >= 1 }))[0];
  assert.equal(snapB.event, 'snapshot');
  assert.equal(snapB.data.build, b);
});
