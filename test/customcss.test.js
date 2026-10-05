// Custom CSS (SPEC §32): only the person sets it, at most 20 KB, stored as given, and it never
// reaches anyone else (public pages, other people's sessions, the host's views and exports).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client } from './helpers.js';
import { attachAccounts, CSS_MAX_BYTES } from '../lib/accounts.js';
import { createFood } from '../lib/food.js';
import { attachWriters } from '../lib/writers.js';
import { CSP } from '../server.js';

const MARK = 'wh-css-marker-7f2c';
const CSS = `/* ${MARK} */ body { background: #fdf6e3; } .x::after { content: "</style><script>alert(1)</script>"; } /* ünïcødé ✓ */`;

async function app(opts = {}) {
  const a = await startApp(opts);
  attachAccounts(a.app);
  attachWriters(a.app); // the public list of writers and their pages, as server.js mounts them
  a.app.extraRoutes.push(...createFood().routes);
  return a;
}
async function signUp(base, username, name = username) {
  const c = client(base);
  const r = await c.post('/api/register', { username, password: 'longpassword', name, email: `${username}@example.org` });
  assert.equal(r.status, 200, r.text);
  return { c, id: r.json.user.id };
}

test('custom CSS: set by the person themself, returned to them as given, turned off with an empty string', async (t) => {
  const { base, close, app: a } = await app();
  t.after(close);
  await signUp(base, 'host', 'Host');
  const ruth = await signUp(base, 'ruth', 'Ruth');
  let r = await ruth.c.get('/api/me/account');
  assert.equal(r.json.customCss, '');
  assert.equal((await ruth.c.get('/api/session')).json.user.customCss, null);
  r = await ruth.c.post('/api/me/account', { customCss: CSS });
  assert.deepEqual([r.status, r.json.changed, r.json.customCss], [200, ['customCss'], CSS]);
  assert.equal(a.party.userById(ruth.id).customCss, CSS, 'stored exactly as given');
  assert.equal((await ruth.c.get('/api/me/account')).json.customCss, CSS);
  assert.equal((await ruth.c.get('/api/session')).json.user.customCss, CSS, 'the page gets it with the session');
  assert.ok(!a.party.state.log.some((l) => l.type === 'account' && l.userId === ruth.id), 'not logged');
  r = await ruth.c.post('/api/me/account', { customCss: CSS });
  assert.deepEqual(r.json.changed, [], 'the same CSS again is no change');
  r = await ruth.c.post('/api/me/account', { customCss: '' });
  assert.deepEqual([r.status, r.json.changed, r.json.customCss], [200, ['customCss'], '']);
  assert.equal(a.party.userById(ruth.id).customCss, undefined);
  assert.equal((await ruth.c.get('/api/session')).json.user.customCss, null);
  r = await ruth.c.post('/api/me/account', { customCss: 42 });
  assert.deepEqual([r.status, r.json.field], [400, 'customCss']);
});

test('custom CSS: at most 20 KB, counted in bytes', async (t) => {
  const { base, close } = await app();
  t.after(close);
  await signUp(base, 'host', 'Host');
  const ruth = await signUp(base, 'ruth', 'Ruth');
  assert.equal(CSS_MAX_BYTES, 20 * 1024);
  let r = await ruth.c.post('/api/me/account', { customCss: 'a'.repeat(CSS_MAX_BYTES) });
  assert.equal(r.status, 200, 'exactly 20 KB is fine');
  r = await ruth.c.post('/api/me/account', { customCss: 'a'.repeat(CSS_MAX_BYTES + 1) });
  assert.deepEqual([r.status, r.json.code, r.json.field], [400, 'css_too_big', 'customCss']);
  assert.match(r.json.error, /at most 20 KB/);
  r = await ruth.c.post('/api/me/account', { customCss: '✓'.repeat(Math.floor(CSS_MAX_BYTES / 3) + 1) }); // 3 bytes each
  assert.equal(r.json.code, 'css_too_big', 'multi-byte characters count as their bytes');
  // An escaped 20 KB still fits the request (JSON doubles quotes and backslashes).
  r = await ruth.c.post('/api/me/account', { customCss: '"'.repeat(CSS_MAX_BYTES) });
  assert.equal(r.status, 200);
});

test('custom CSS: only the person can set it; hosts can neither set nor see someone else’s', async (t) => {
  const { base, close, app: a } = await app();
  t.after(close);
  const host = await signUp(base, 'host', 'Host');
  const ruth = await signUp(base, 'ruth', 'Ruth');
  const ben = await signUp(base, 'ben', 'Ben');
  let r = await host.c.post('/api/host/account', { id: ruth.id, customCss: 'body{display:none}' });
  assert.deepEqual([r.status, r.json.code, r.json.field], [403, 'self_only', 'customCss']);
  assert.equal(a.party.userById(ruth.id).customCss, undefined);
  r = await ben.c.post('/api/host/account', { id: ruth.id, customCss: 'x' });
  assert.equal(r.status, 404, 'writers have no host route');
  r = await host.c.post('/api/host/account', { id: host.id, customCss: 'body{color:#222}' });
  assert.equal(r.status, 200, 'a host sets their own, by their own rules');
  await ruth.c.post('/api/me/account', { customCss: CSS });
  r = await host.c.get(`/api/host/account?id=${ruth.id}`);
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes(MARK) && r.json.customCss === undefined, 'the host’s editor never gets it');
});

test('custom CSS: never in a public payload, another person’s session, or any host view', async (t) => {
  const { base, close } = await app();
  t.after(close);
  const host = await signUp(base, 'host', 'Host');
  await host.c.post('/api/admin/start', {});
  const ruth = await signUp(base, 'ruth', 'Ruth');
  await ruth.c.post('/api/me/account', { customCss: CSS, publicProfile: true });
  await ruth.c.post('/api/join', {});
  const p = (await ruth.c.post('/api/post/new', { title: 'Signed' })).json.post;
  await ruth.c.post('/api/post/update', { id: p.id, privacy: 'named' });
  await ruth.c.post('/api/ops', { postId: p.id, pane: 'body', baseVersion: 0, seq: 'c1', sentAt: Date.now(), ops: [{ at: Date.now(), pos: 0, del: 0, ins: 'Words on a page of my own.' }] });
  const anon = client(base);
  const ben = await signUp(base, 'ben', 'Ben');
  const live = await anon.get('/api/live');
  const seen = [
    ['live', live.text],
    ['post', (await anon.get(`/api/p/${encodeURIComponent(live.json.posts[0].id)}`)).text],
    ['session, signed out', (await anon.get('/api/session')).text],
    ['another writer’s session', (await ben.c.get('/api/session')).text],
    ['another writer’s me', (await ben.c.get('/api/me')).text],
    ['ruth’s own me (sent every second: not carried there)', (await ruth.c.get('/api/me')).text],
    ['host view', (await host.c.get('/api/host')).text],
    ['host: the writer', (await host.c.get(`/api/admin/writer?id=${ruth.id}`)).text],
    ['host: the account editor', (await host.c.get(`/api/host/account?id=${ruth.id}`)).text],
    ['host: JSON export', (await host.c.get('/api/admin/export.json')).text],
    ['host: Markdown export', (await host.c.get('/api/admin/export.md')).text],
    ['host: food', (await host.c.get('/api/host/food')).text],
    ['host: CSV', (await host.c.get('/api/host/food.csv')).text],
  ];
  const pageId = (await ruth.c.get('/api/me/account')).json.publicProfile?.id;
  assert.ok(pageId, 'she is on the public list of writers');
  for (const p2 of ['/api/writers', `/api/w/${encodeURIComponent(pageId)}`]) {
    const r = await anon.get(p2);
    assert.equal(r.status, 200, p2);
    assert.match(r.text, /Ruth/, `${p2} shows her`);
    seen.push([p2, r.text]);
  }
  await host.c.post('/api/admin/end', {});
  seen.push(['archive', (await anon.get('/api/archive')).text]);
  for (const [where, text] of seen) assert.ok(!text.includes(MARK), `custom CSS leaked into: ${where}`);
  assert.ok(seen.length >= 16);
  assert.ok((await ruth.c.get('/api/session')).text.includes(MARK), 'the control: her own session has it');
});

test('custom CSS: the page’s CSP lets CSS load nothing from elsewhere', async (t) => {
  const { base, close } = await app();
  t.after(close);
  const r = await client(base).get('/');
  const csp = r.headers.get('content-security-policy');
  assert.equal(csp, CSP);
  const d = Object.fromEntries(csp.split(';').map((x) => x.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  assert.deepEqual(d['default-src'], ["'self'"]);
  assert.deepEqual(d['img-src'], ["'self'", 'data:', 'blob:']);
  assert.deepEqual(d['font-src'], ["'self'", 'data:']);
  assert.deepEqual(d['style-src'], ["'self'", "'unsafe-inline'"], 'no outside stylesheets (@import), inline style elements allowed');
  assert.deepEqual(d['connect-src'], ["'self'"]);
  assert.doesNotMatch(csp, /https?:|\*/, 'no outside host anywhere');
});
