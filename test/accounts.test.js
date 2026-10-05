// Display names and account details (SPEC §25).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeParty, addUser, typeInto, startApp, client, readSse, sleep } from './helpers.js';
import { realProse, MIN } from './sim.js';
import { createApp } from '../server.js';
import { attachAccounts, isOriginalHost, editRights } from '../lib/accounts.js';
import { createFood } from '../lib/food.js';
import { displayNameError, publicDisplayName, hasEmail, usernameProblem, emailProblem, cleanEmail, emailSuggestion } from '../public/js/names.js';

const quiet = { error() {}, log() {}, warn() {} };

async function app(opts = {}) {
  const a = await startApp(opts);
  attachAccounts(a.app);
  return a;
}
async function signUp(base, username, name = username, password = 'longpassword') {
  const c = client(base);
  const r = await c.post('/api/register', { username, password, name });
  assert.equal(r.status, 200, `register ${username}: ${r.text}`);
  return { c, id: r.json.user.id };
}

test('names: emails are refused with a friendly message; public pages show only the part before "@"', () => {
  for (const s of ['ruth@example.com', 'Ruth (ruth.smith@example.com)', 'ruth＠example．com', 'RUTH@EXAMPLE.COM', 'Ruth <r.s@mail.example.org>']) {
    assert.ok(hasEmail(s), s);
    assert.match(displayNameError(s), /looks like an email address/, s);
  }
  for (const s of ['Ruth Smith', 'R@chel', 'Jo @ the book club', 'ruth@home', '@ruth']) assert.equal(displayNameError(s), '', s);
  assert.match(displayNameError('ruth.smith@example.com'), /like “Ruth Smith”/);
  assert.match(displayNameError('ruth@example.com', { who: 'they' }), /the posts they sign/);
  assert.match(displayNameError('  '), /Add a display name/);
  assert.equal(publicDisplayName('ruth.smith@example.com'), 'ruth.smith');
  assert.equal(publicDisplayName('Ruth (ruth@example.com)'), 'Ruth (ruth)');
  assert.equal(publicDisplayName('Ruth Smith'), 'Ruth Smith');
  assert.equal(usernameProblem('Ruth Smith'), 'Usernames can’t contain spaces. Try “ruth” or “ruth.smith”.');
  assert.equal(usernameProblem('ruth'), '');
});

test('names: sign-up and the host rename refuse emails; stored emails never reach a public surface', () => {
  const { party, clock } = makeParty({ settings: { hourLengthMin: 10, targetPerHour: 20 } });
  const host = addUser(party, 'host', 'Host');
  assert.throws(() => addUser(party, 'ruth', 'ruth@example.com'), (e) => e.status === 400 && e.extra.code === 'name_email' && e.extra.field === 'name' && /email address/.test(e.message));
  const ruth = addUser(party, 'ruth', 'Ruth');
  assert.throws(() => party.adminWriter(host.id, { id: ruth.id, name: 'Ruth ruth@example.org' }), (e) => e.status === 400 && e.extra.code === 'name_email');
  // An account named before emails were refused (stored as typed).
  ruth.name = 'ruth.smith@example.com';
  party.start(host.id);
  party.join(ruth.id);
  const signed = party.newPost(ruth.id, { title: 'Signed' });
  party.updatePost(ruth.id, { id: signed.id, privacy: 'named' });
  typeInto(party, clock, ruth, signed, realProse(12, 1));
  const anon = party.newPost(ruth.id, { title: 'Anonymous' });
  typeInto(party, clock, ruth, anon, realProse(12, 2));
  clock.advance(2 * MIN);
  const live = party.liveView().posts;
  assert.deepEqual(live.map((p) => p.name ?? '').sort(), ['', 'ruth.smith']);
  const pub = party.publicPost(live.find((p) => p.name).id);
  assert.equal(pub.name, 'ruth.smith');
  party.end(host.id);
  assert.deepEqual(party.archiveView().posts.map((p) => p.name ?? '').sort(), ['', 'ruth.smith']);
  const md = party.exportMarkdown(host.id);
  assert.match(md, /\*by ruth\.smith\*/);
  assert.doesNotMatch(md, /@example/);
  // Hosts still see the stored value.
  assert.equal(party.hostView(host.id).writers.find((w) => w.id === ruth.id).name, 'ruth.smith@example.com');
});

test('accounts: your own display name, username and password; sessions; the live page and your streams follow', async (t) => {
  const { base, close, app: a } = await app();
  t.after(close);
  const host = await signUp(base, 'host', 'The Host');
  await host.c.post('/api/admin/start', {});
  const ruth = await signUp(base, 'ruth', 'Ruth');
  let r = await ruth.c.get('/api/me/account');
  assert.deepEqual([r.status, r.json.user.name, r.json.user.username, r.json.publicName, r.json.nameHasEmail], [200, 'Ruth', 'ruth', 'Ruth', false]);
  // A signed post and an anonymous one on the live page.
  await ruth.c.post('/api/join', {});
  const signed = (await ruth.c.post('/api/post/new', { title: 'Signed' })).json.post;
  await ruth.c.post('/api/post/update', { id: signed.id, privacy: 'named' });
  await ruth.c.post('/api/ops', { postId: signed.id, pane: 'body', baseVersion: 0, seq: 's1', sentAt: Date.now(), ops: [{ at: Date.now(), pos: 0, del: 0, ins: 'A signed line of writing.' }] });
  const anon = (await ruth.c.post('/api/post/new', { title: 'Anon' })).json.post;
  await ruth.c.post('/api/ops', { postId: anon.id, pane: 'body', baseVersion: 0, seq: 'a1', sentAt: Date.now(), ops: [{ at: Date.now(), pos: 0, del: 0, ins: 'An anonymous line.' }] });
  r = await client(base).get('/api/live');
  assert.deepEqual(r.json.posts.map((p) => p.name ?? '').sort(), ['', 'Ruth']);
  const signedPublicId = r.json.posts.find((p) => p.name).id;
  const anonBefore = JSON.stringify(r.json.posts.find((p) => !p.name));
  // A second device, signed in.
  const phone = client(base);
  assert.equal((await phone.post('/api/login', { username: 'ruth', password: 'longpassword' })).status, 200);
  // The me stream on the phone sees the change at once.
  const events = readSse(`${base}/api/me/events`, { cookie: phone.cookie, ms: 2500, until: (ev) => ev.some((e) => e.event === 'me' && e.data.me.name === 'Ruth Ames') });
  await sleep(150);
  // Display name: emails refused, then a real name.
  r = await ruth.c.post('/api/me/account', { name: 'ruth@example.com' });
  assert.deepEqual([r.status, r.json.code, r.json.field], [400, 'name_email', 'name']);
  assert.match(r.json.error, /email address/);
  r = await ruth.c.post('/api/me/account', { name: '  Ruth   Ames ' });
  assert.deepEqual([r.status, r.json.user.name, r.json.changed], [200, 'Ruth Ames', ['name']]);
  assert.ok((await events).some((e) => e.event === 'me' && e.data.me.name === 'Ruth Ames'), 'the writer’s other page got the new name');
  // Public: the signed post shows it at once (no stale live, post or archive cache); the anonymous one is untouched.
  r = await client(base).get('/api/live');
  assert.equal(r.json.posts.find((p) => p.id === signedPublicId).name, 'Ruth Ames');
  assert.equal(JSON.stringify(r.json.posts.find((p) => !p.name)), anonBefore);
  r = await client(base).get(`/api/p/${encodeURIComponent(signedPublicId)}`);
  assert.equal(r.json.name, 'Ruth Ames');
  // Username: taken, reserved shape, then a new one; the session stays valid.
  await signUp(base, 'sam', 'Sam');
  r = await ruth.c.post('/api/me/account', { username: 'SAM' });
  assert.deepEqual([r.status, r.json.code, r.json.field], [409, 'username_taken', 'username']);
  r = await ruth.c.post('/api/me/account', { username: 'ruth ames' });
  assert.deepEqual([r.status, r.json.field], [400, 'username']);
  r = await ruth.c.post('/api/me/account', { username: ' Ruth.Ames ' });
  assert.deepEqual([r.status, r.json.user.username], [200, 'ruth.ames']);
  assert.equal((await ruth.c.get('/api/session')).json.user.username, 'ruth.ames');
  assert.equal((await phone.get('/api/me')).status, 200, 'other sessions survive a username change');
  assert.equal(a.party.userByUsername('ruth'), null);
  assert.equal(a.party.userByUsername('ruth.ames').id, ruth.id);
  assert.equal((await client(base).post('/api/login', { username: 'ruth', password: 'longpassword' })).status, 401);
  // The freed username can be registered again; the new one can't.
  assert.equal((await client(base).post('/api/register', { username: 'ruth.ames', password: 'longpassword', name: 'X' })).status, 409);
  // Password: needs the current one; signs out the other devices and keeps this one.
  r = await ruth.c.post('/api/me/account', { password: 'new-password-1' });
  assert.deepEqual([r.status, r.json.field], [400, 'currentPassword']);
  r = await ruth.c.post('/api/me/account', { password: 'new-password-1', currentPassword: 'wrong-one' });
  assert.deepEqual([r.status, r.json.code, r.json.field], [403, 'wrong_password', 'currentPassword']);
  r = await ruth.c.post('/api/me/account', { password: 'short', currentPassword: 'longpassword' });
  assert.deepEqual([r.status, r.json.field], [400, 'password']);
  r = await ruth.c.post('/api/me/account', { password: 'new-password-1', currentPassword: 'longpassword' });
  assert.deepEqual([r.status, r.json.changed, r.json.signedOut], [200, ['password'], 1]);
  assert.equal((await ruth.c.get('/api/me')).status, 200, 'this device stays signed in');
  assert.equal((await phone.get('/api/me')).status, 401, 'the other device is signed out');
  assert.equal((await client(base).post('/api/login', { username: 'ruth.ames', password: 'longpassword' })).status, 401);
  assert.equal((await client(base).post('/api/login', { username: 'ruth.ames', password: 'new-password-1' })).status, 200);
  // Nothing changed: nothing logged, still ok.
  r = await ruth.c.post('/api/me/account', { name: 'Ruth Ames', username: 'ruth.ames' });
  assert.deepEqual([r.status, r.json.changed], [200, []]);
  const log = a.party.state.log.filter((l) => l.type === 'account' && l.userId === ruth.id).map((l) => l.text);
  assert.deepEqual(log, ['changed their display name (was “Ruth”)', 'changed their username (was @ruth)', 'changed their password']);
  // CSRF and sign-in.
  r = await ruth.c.post('/api/me/account', { name: 'X' }, { headers: { 'X-WH': '' } });
  assert.equal(r.status, 403);
  r = await client(base).post('/api/me/account', { name: 'X' });
  assert.equal(r.status, 401);
});

test('accounts: someone waiting for approval can edit their details; a host can fix them from the queue', async (t) => {
  const { base, close } = await app({ approvalRequired: true });
  t.after(close);
  const host = await signUp(base, 'host', 'Host');
  const ana = await signUp(base, 'ana', 'Ana');
  assert.equal((await ana.c.get('/api/session')).json.user.approval, 'pending');
  let r = await ana.c.post('/api/me/account', { name: 'Ana Lima', username: 'ana.lima' });
  assert.deepEqual([r.status, r.json.user.name, r.json.user.username, r.json.user.approval], [200, 'Ana Lima', 'ana.lima', 'pending']);
  let hv = (await host.c.get('/api/host')).json;
  assert.deepEqual(hv.pending.map((p) => [p.name, p.username]), [['Ana Lima', 'ana.lima']]);
  r = await host.c.post('/api/host/account', { id: ana.id, name: 'Ana L.' });
  assert.deepEqual([r.status, r.json.user.name], [200, 'Ana L.']);
  hv = (await host.c.get('/api/host')).json;
  assert.equal(hv.pending[0].name, 'Ana L.');
  assert.equal(hv.log.find((l) => l.type === 'account' && l.by === hv.writers.find((w) => w.username === 'host').id).text, 'had their display name (was “Ana Lima”) changed');
});

test('accounts: hosts edit writers; co-hosts can’t edit hosts; writers can’t edit anyone else', async (t) => {
  const { base, close, app: a } = await app();
  t.after(close);
  const owner = await signUp(base, 'owner', 'Robin');
  const co = await signUp(base, 'co', 'Co Host');
  const other = await signUp(base, 'co2', 'Second Co');
  const ruth = await signUp(base, 'ruth', 'Ruth');
  const ben = await signUp(base, 'ben', 'Ben');
  // Co-hosts (SPEC §21): host powers, not the original host.
  for (const id of [co.id, other.id]) a.party.userById(id).isAdmin = true;
  const P = a.party;
  assert.equal(isOriginalHost(P, P.userById(owner.id)), true);
  assert.equal(isOriginalHost(P, P.userById(co.id)), false);
  // A writer: the host routes don't exist for them.
  let r = await ruth.c.post('/api/host/account', { id: ben.id, name: 'Not Ben' });
  assert.equal(r.status, 404);
  r = await ruth.c.get(`/api/host/account?id=${ben.id}`);
  assert.equal(r.status, 404);
  assert.equal(P.userById(ben.id).name, 'Ben');
  // A co-host edits a writer: name, username and a new password (signs them out everywhere).
  r = await co.c.get(`/api/host/account?id=${ben.id}`);
  assert.deepEqual([r.json.canEdit, r.json.canEditUsername, r.json.self], [true, true, false]);
  r = await co.c.post('/api/host/account', { id: ben.id, name: 'Benedict', username: 'benedict', password: 'temporary-pw' });
  assert.deepEqual([r.status, r.json.user.name, r.json.user.username, r.json.changed], [200, 'Benedict', 'benedict', ['username', 'name', 'password']]);
  assert.equal((await ben.c.get('/api/me')).status, 401, 'a host-set password signs them out everywhere');
  assert.equal((await client(base).post('/api/login', { username: 'benedict', password: 'temporary-pw' })).status, 200);
  // ...and is refused emails like everyone else.
  r = await co.c.post('/api/host/account', { id: ben.id, name: 'ben@example.org' });
  assert.deepEqual([r.status, r.json.code], [400, 'name_email']);
  assert.match(r.json.error, /the posts they sign/);
  // A co-host can't edit the original host or another co-host (any route).
  for (const id of [owner.id, other.id]) {
    r = await co.c.get(`/api/host/account?id=${id}`);
    assert.deepEqual([r.status, r.json.canEdit, r.json.code], [200, false, 'host_only']);
    assert.match(r.json.reason, /Only the original host \(Robin\) can change another host’s details\./);
    r = await co.c.post('/api/host/account', { id, name: 'Hacked' });
    assert.deepEqual([r.status, r.json.code], [403, 'host_only']);
    r = await co.c.post('/api/admin/password', { id, password: 'taken-over' });
    assert.deepEqual([r.status, r.json.code], [403, 'host_only']);
  }
  assert.equal(P.userById(owner.id).name, 'Robin');
  // The original host edits co-hosts.
  r = await owner.c.post('/api/host/account', { id: co.id, name: 'Cora' });
  assert.deepEqual([r.status, r.json.user.name], [200, 'Cora']);
  r = await owner.c.post('/api/admin/password', { id: co.id, password: 'a-new-one' });
  assert.equal(r.status, 200);
  // Your own row from the host route: your own rules (the current password is needed).
  r = await owner.c.post('/api/host/account', { id: owner.id, password: 'whatever-new' });
  assert.deepEqual([r.status, r.json.field], [400, 'currentPassword']);
  r = await owner.c.post('/api/admin/password', { id: owner.id, password: 'whatever-new' });
  assert.deepEqual([r.status, r.json.code], [403, 'use_account']);
  // A co-host edits themself.
  r = await other.c.post('/api/me/account', { name: 'Second' });
  assert.equal(r.status, 200);
  // editRights is the one rule.
  assert.equal(editRights(P, P.userById(ruth.id), P.userById(ben.id)).canEdit, false);
});

test('accounts: usernames named in WH_ADMIN_USERS can’t be taken or given up', async (t) => {
  const { base, close } = await app({ adminUsers: ['carol', 'dora'] });
  t.after(close);
  const host = await signUp(base, 'host', 'Host');
  const carol = await signUp(base, 'carol', 'Carol');
  const ruth = await signUp(base, 'ruth', 'Ruth');
  let r = await ruth.c.post('/api/me/account', { username: 'dora' });
  assert.deepEqual([r.status, r.json.code], [409, 'username_reserved']);
  r = await carol.c.post('/api/me/account', { username: 'carol2' });
  assert.deepEqual([r.status, r.json.code], [409, 'username_locked']);
  r = await host.c.get(`/api/host/account?id=${carol.id}`);
  assert.equal(r.json.canEditUsername, false);
  r = await carol.c.post('/api/me/account', { name: 'Carol B.' });
  assert.equal(r.status, 200);
});

test('accounts: wrong current passwords are limited, parallel guesses included', async (t) => {
  const { base, close } = await app();
  t.after(close);
  await signUp(base, 'host', 'Host');
  const ruth = await signUp(base, 'ruth', 'Ruth');
  const tries = await Promise.all(Array.from({ length: 8 }, (_, i) => ruth.c.post('/api/me/account', { password: 'new-password-1', currentPassword: `guess-${i}` })));
  assert.deepEqual(tries.map((r) => r.status).sort(), [403, 403, 403, 403, 403, 429, 429, 429]);
  const limited = tries.find((r) => r.status === 429);
  assert.equal(limited.json.code, 'rate');
  assert.ok(limited.json.retryAfter > 0);
  const r = await ruth.c.post('/api/me/account', { password: 'new-password-1', currentPassword: 'longpassword' });
  assert.equal(r.status, 429, 'even the right one waits');
});

test('accounts: changes survive a restart (state file + journal replay), with the username index rebuilt', async (t) => {
  const first = await app();
  const host = await signUp(first.base, 'host', 'Host');
  await host.c.post('/api/admin/start', {});
  const ruth = await signUp(first.base, 'ruth', 'Ruth');
  await ruth.c.post('/api/join', {});
  const p = (await ruth.c.post('/api/post/new', { title: 'Mine' })).json.post;
  await ruth.c.post('/api/post/update', { id: p.id, privacy: 'named' });
  await ruth.c.post('/api/ops', { postId: p.id, pane: 'body', baseVersion: 0, seq: 'b1', sentAt: Date.now(), ops: [{ at: Date.now(), pos: 0, del: 0, ins: 'Words that stay.' }] });
  let r = await ruth.c.post('/api/me/account', { name: 'Ruth Ames', username: 'ruthie', password: 'new-password-1', currentPassword: 'longpassword' });
  assert.equal(r.status, 200);
  const cookie = ruth.c.cookie;
  await first.close();
  // Boot again from the same state file and op journal.
  const again = createApp({ stateFile: first.stateFile, log: quiet, liveMs: 100, tickMs: 200, recomputeMinMs: 0, tz: 'UTC' });
  attachAccounts(again);
  const addr = await again.start(0);
  t.after(() => again.stop());
  const base = `http://127.0.0.1:${addr.port}`;
  const P = again.party;
  assert.equal(P.userByUsername('ruth'), null);
  assert.equal(P.userByUsername('ruthie').name, 'Ruth Ames');
  assert.equal(P.byUsername.size, Object.keys(P.state.users).length);
  r = await fetch(`${base}/api/session`, { headers: { Cookie: cookie } }).then((x) => x.json());
  assert.equal(r.user.username, 'ruthie', 'the session survived the change and the restart');
  assert.equal((await client(base).post('/api/login', { username: 'ruthie', password: 'new-password-1' })).status, 200);
  assert.equal(P.state.posts[p.id].body, 'Words that stay.', 'the op journal replays under the same account');
  r = await client(base).get('/api/live');
  assert.equal(r.json.posts[0].name, 'Ruth Ames');
  assert.ok(P.state.log.some((l) => l.type === 'account' && /display name \(was “Ruth”\), username \(was @ruth\) and password/.test(l.text)));
});

test('names: an older stored email name shows only its first part on /api/live, the stream, /api/p and /api/archive', async (t) => {
  const { base, close, app: a } = await app();
  t.after(close);
  const host = await signUp(base, 'host', 'Host');
  await host.c.post('/api/admin/start', {});
  const dan = await signUp(base, 'dan', 'Dan');
  a.party.userById(dan.id).name = 'dan.writer@example.com'; // named before emails were refused
  await dan.c.post('/api/join', {});
  const p = (await dan.c.post('/api/post/new', { title: 'Signed' })).json.post;
  await dan.c.post('/api/post/update', { id: p.id, privacy: 'named' });
  await dan.c.post('/api/ops', { postId: p.id, pane: 'body', baseVersion: 0, seq: 'd1', sentAt: Date.now(), ops: [{ at: Date.now(), pos: 0, del: 0, ins: 'A line of signed writing.' }] });
  let r = await client(base).get('/api/live');
  assert.equal(r.json.posts[0].name, 'dan.writer');
  assert.doesNotMatch(r.text, /example\.com/);
  const ev = await readSse(`${base}/api/live/events`, { ms: 3000, until: (e) => e.some((x) => /dan\.writer/.test(x.raw)) });
  assert.ok(ev.length && !ev.some((x) => /example\.com/.test(x.raw)), 'the live stream never carries it');
  assert.ok(ev.some((x) => /dan\.writer/.test(x.raw)));
  r = await client(base).get(`/api/p/${encodeURIComponent(r.json.posts[0].id)}`);
  assert.equal(r.json.name, 'dan.writer');
  assert.doesNotMatch(r.text, /example\.com/);
  await host.c.post('/api/admin/end', {});
  r = await client(base).get('/api/archive');
  assert.equal(r.json.posts[0].name, 'dan.writer');
  assert.doesNotMatch(r.text, /example\.com/);
  r = await host.c.get('/api/admin/export.md');
  assert.match(r.text, /\*by dan\.writer\*/);
  assert.doesNotMatch(r.text, /example\.com/);
});

test('accounts: the server as it runs (node server.js) serves the account routes', async (t) => {
  const { spawn } = await import('node:child_process');
  const { default: fsm } = await import('node:fs');
  const { default: osm } = await import('node:os');
  const { default: pathm } = await import('node:path');
  const dir = fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'wh-accounts-cli-'));
  t.after(() => fsm.rmSync(dir, { recursive: true, force: true }));
  const root = pathm.resolve(pathm.dirname(new URL(import.meta.url).pathname), '..');
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: '0', HOST: '127.0.0.1', WH_STATE_FILE: pathm.join(dir, 'state.json'), WH_FSYNC: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const port = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`no start: ${out}`)), 15000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.on('exit', (code) => reject(new Error(`exited ${code}: ${out}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  let r = await client(base).get('/api/me/account');
  assert.equal(r.status, 401, 'the route exists (it asks for a sign-in instead of 404)');
  const host = await signUp(base, 'host', 'Host');
  r = await host.c.get('/api/me/account');
  assert.deepEqual([r.status, r.json.user.username], [200, 'host']);
  r = await host.c.get(`/api/host/account?id=${host.id}`);
  assert.deepEqual([r.status, r.json.self], [200, true]);
});

// ------------------------------------------------------------------ email (SPEC §25b)
test('email: the rules (format, folding, typo suggestions)', () => {
  for (const ok of ['ruth@example.com', 'Ruth.Smith+party@Mail.Example.ORG', 'ivan@пример.испытание', 'ruth＠example．com', 'a@b.co']) assert.equal(emailProblem(ok), '', ok);
  assert.equal(cleanEmail('  Ruth.Smith@EXAMPLE.COM '), 'Ruth.Smith@example.com', 'the domain is lowercased, the rest kept');
  assert.equal(cleanEmail('ruth＠example．com'), 'ruth@example.com');
  assert.match(emailProblem(''), /Add your email/);
  assert.equal(emailProblem('', { required: false }), '');
  assert.match(emailProblem('ruth example.com'), /spaces/);
  assert.match(emailProblem('ruth.example.com'), /missing the “@”/);
  assert.match(emailProblem('ruth@@example.com'), /more than one/);
  assert.match(emailProblem('ruth@example'), /part after the “@”/);
  assert.match(emailProblem('.ruth@example.com'), /part before the “@”/);
  assert.equal(emailSuggestion('wh-test-ruth@gmial.com'), 'wh-test-ruth@gmail.com');
  assert.equal(emailSuggestion('wh-test-ruth@gmail.con'), 'wh-test-ruth@gmail.com');
  assert.equal(emailSuggestion('wh-test-ruth@yahoo.co.uj'), 'wh-test-ruth@yahoo.co.uk');
  for (const fine of ['wh-test-ruth@gmail.com', 'wh-test-ruth@ox.ac.uk', 'wh-test-ruth@protonmail.ch', 'wh-test-ruth@live.ca']) assert.equal(emailSuggestion(fine), null, fine);
});

test('email: given at sign-up, private to the person and the hosts, never on a public page', async (t) => {
  const { base, close, app: a } = await app({ approvalRequired: true });
  t.after(close);
  a.extraRoutes.push(...createFood().routes); // the hosts' CSV (server.js mounts it the same way)
  const h = client(base);
  let r = await h.post('/api/register', { username: 'host', password: 'longpassword', name: 'Host', email: 'host@example.net' });
  assert.equal(r.json.user.hasEmail, true);
  // A bad address is refused on its field; none at all is accepted (the form requires one; older
  // pages and tools may not send it) and that account is asked later.
  r = await client(base).post('/api/register', { username: 'bad', password: 'longpassword', name: 'Bad', email: 'bad@example' });
  assert.deepEqual([r.status, r.json.code, r.json.field], [400, 'email', 'email']);
  const none = client(base);
  r = await none.post('/api/register', { username: 'nomail', password: 'longpassword', name: 'No Mail' });
  assert.deepEqual([r.status, r.json.user.hasEmail], [200, false]);
  assert.equal((await none.get('/api/session')).json.user.hasEmail, false);
  const ruth = client(base);
  r = await ruth.post('/api/register', { username: 'ruth', password: 'longpassword', name: 'Ruth', email: ' Ruth.Ames@Mail.Example.COM ' });
  const ruthId = r.json.user.id;
  assert.equal(a.party.userById(ruthId).email, 'Ruth.Ames@mail.example.com');
  assert.equal(r.json.user.email, undefined, 'the session view carries only hasEmail');
  // Hosts see it: the approval queue, the writer rows, the account editor, the JSON export, the CSV.
  let hv = (await h.get('/api/host')).json;
  assert.equal(hv.pending.find((p) => p.id === ruthId).email, 'Ruth.Ames@mail.example.com');
  assert.equal(hv.writers.find((w) => w.id === ruthId).email, 'Ruth.Ames@mail.example.com');
  assert.equal((await h.get(`/api/host/account?id=${ruthId}`)).json.user.email, 'Ruth.Ames@mail.example.com');
  assert.match((await h.get('/api/admin/export.json')).text, /Ruth\.Ames@mail\.example\.com/);
  const csv = (await h.get('/api/host/food.csv')).text;
  assert.match(csv.split('\r\n')[0], /"Email"$/);
  assert.match(csv, /"Ruth\.Ames@mail\.example\.com"/);
  // The person sees their own.
  assert.equal((await ruth.get('/api/me/account')).json.user.email, 'Ruth.Ames@mail.example.com');
  // Nothing public carries it: live JSON and stream, post pages, the anthology, the Markdown export.
  await h.post('/api/host/approve', { id: ruthId });
  await h.post('/api/admin/start', {});
  await ruth.post('/api/join', {});
  const p = (await ruth.post('/api/post/new', { title: 'Signed' })).json.post;
  await ruth.post('/api/post/update', { id: p.id, privacy: 'named' });
  await ruth.post('/api/ops', { postId: p.id, pane: 'body', baseVersion: 0, seq: 'e1', sentAt: Date.now(), ops: [{ at: Date.now(), pos: 0, del: 0, ins: 'Signed words for everyone.' }] });
  const pub = [];
  r = await client(base).get('/api/live');
  pub.push(r.text);
  assert.equal(r.json.posts[0].name, 'Ruth');
  pub.push(JSON.stringify(await readSse(`${base}/api/live/events`, { ms: 3000, until: (e) => e.some((x) => /Signed words/.test(x.raw)) })));
  pub.push((await client(base).get(`/api/p/${encodeURIComponent(r.json.posts[0].id)}`)).text);
  pub.push((await client(base).get('/api/session')).text);
  await h.post('/api/admin/end', {});
  pub.push((await client(base).get('/api/archive')).text);
  pub.push((await h.get('/api/admin/export.md')).text);
  for (const text of pub) assert.doesNotMatch(text, /mail\.example|example\.net|@/i);
  hv = (await h.get('/api/host')).json;
  assert.ok(!hv.log.some((l) => /example/.test(l.text)), 'the log names no address');
});

test('email: added, corrected, never removed; hosts edit it by the same rules', async (t) => {
  const { base, close, app: a } = await app();
  t.after(close);
  const owner = await signUp(base, 'owner', 'Owner');
  const co = await signUp(base, 'co', 'Co');
  a.party.userById(co.id).isAdmin = true;
  const ruth = await signUp(base, 'ruth', 'Ruth'); // no email: an older account
  assert.equal((await ruth.c.get('/api/me/account')).json.user.email, null);
  assert.equal((await ruth.c.get('/api/me')).json.me.hasEmail, false, 'the account areas ask for one');
  let r = await ruth.c.post('/api/me/account', { email: '' });
  assert.deepEqual([r.status, r.json.changed], [200, []], 'leaving it empty is no change');
  r = await ruth.c.post('/api/me/account', { email: 'ruth@example' });
  assert.deepEqual([r.status, r.json.field], [400, 'email']);
  r = await ruth.c.post('/api/me/account', { email: 'ruth@example.org' });
  assert.deepEqual([r.status, r.json.changed, r.json.user.email], [200, ['email'], 'ruth@example.org']);
  assert.equal((await ruth.c.get('/api/session')).json.user.hasEmail, true);
  assert.equal((await ruth.c.get('/api/me')).json.me.hasEmail, true);
  assert.equal((await ruth.c.get('/api/me')).json.me.email, undefined, 'the me view carries only hasEmail');
  r = await ruth.c.post('/api/me/account', { email: '   ' });
  assert.deepEqual([r.status, r.json.field], [400, 'email'], 'an address can be corrected, never removed');
  r = await ruth.c.post('/api/me/account', { email: 'Ruth@Example.ORG' });
  assert.deepEqual([r.status, r.json.user.email], [200, 'Ruth@example.org']);
  // Hosts: the same rules; a co-host can't touch a host's.
  r = await co.c.post('/api/host/account', { id: ruth.id, email: 'ruth.ames@example.org' });
  assert.deepEqual([r.status, r.json.user.email], [200, 'ruth.ames@example.org']);
  r = await co.c.post('/api/host/account', { id: owner.id, email: 'taken@example.org' });
  assert.deepEqual([r.status, r.json.code], [403, 'host_only']);
  const log = a.party.state.log.filter((l) => l.type === 'account' && l.userId === ruth.id).map((l) => l.text);
  assert.deepEqual(log, ['added their email', 'changed their email', 'had their email changed']);
});
