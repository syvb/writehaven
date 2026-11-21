// Rounds (lib/rounds.js): an ended party is closed with --new-round and the next one opens in a
// fresh lobby with the same accounts; the closed round stays readable (its anthology, its post
// pages, the writers' pages, a writer's own posts at /past) and never mixes with the new one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApp, client, tmpStateFile, quietLog, makeParty, addUser, makeClock } from './helpers.js';
import { closeRound, nextRoundState, loadRounds, roundsDirOf, ROUND_USER_KEYS } from '../lib/rounds.js';
import { createUploads } from '../lib/uploads.js';
import { foodWordsOf, peopleOf } from '../lib/food.js';
import { attachAccounts } from '../lib/accounts.js';
import { attachWriters } from '../lib/writers.js';

const PASSWORD = 'longpassword';

// An app on `stateFile` with the routes main() adds (accounts, the writers' pages), closed after
// the test whatever happens (closing twice is fine).
async function start(t, stateFile) {
  const a = await startApp({ stateFile, approvalRequired: false });
  attachAccounts(a.app);
  attachWriters(a.app);
  t.after(() => a.close());
  return a;
}

// One round over HTTP: a host and a writer, three posts (anonymous, signed, private), the end.
async function playRound(base, app, { host, w, tag, onStart = null }) {
  assert.equal((await host.post('/api/admin/start', {})).status, 200);
  if (onStart) await onStart();
  assert.equal((await w.post('/api/join', {})).status, 200);
  const make = async (title, privacy, body) => {
    const p = (await w.post('/api/post/new', { title })).json.post;
    if (privacy !== 'live') assert.equal((await w.post('/api/post/update', { id: p.id, privacy })).status, 200);
    const r = await w.post('/api/ops', { postId: p.id, pane: 'body', baseVersion: 0, seq: `s-${p.id}`, sentAt: Date.now(), ops: [{ at: Date.now(), pos: 0, del: 0, ins: body }] });
    assert.equal(r.status, 200);
    return { ...p, publicId: app.party.state.posts[p.id].publicId };
  };
  const posts = {
    anon: await make(`${tag} anonymous`, 'live', `The ${tag} anonymous piece, with some words in it.`),
    signed: await make(`${tag} signed`, 'named', `The ${tag} signed piece, also with words.`),
    secret: await make(`${tag} private`, 'private', `The ${tag} private piece: nobody else reads this.`),
  };
  const n = await w.post('/api/ops', { postId: posts.secret.id, pane: 'notes', baseVersion: 0, seq: 'notes-1', sentAt: Date.now(), ops: [{ at: Date.now(), pos: 0, del: 0, ins: `${tag} planning notes` }] });
  assert.equal(n.status, 200);
  assert.equal((await host.post('/api/admin/end', {})).status, 200);
  return posts;
}

test('rounds: close an ended round, open the next with the same accounts, and keep the old one readable', async (t) => {
  const stateFile = tmpStateFile();
  const app1 = await start(t, stateFile);
  const host = client(app1.base);
  await host.post('/api/register', { username: 'hostuser', password: PASSWORD, name: 'Hosting Person' });
  const w = client(app1.base);
  const reg = await w.post('/api/register', { username: 'wren', password: PASSWORD, name: 'Wren Writer' });
  const wrenId = reg.json.user.id;
  assert.equal((await w.post('/api/me/account', { publicProfile: true })).status, 200);
  const page = app1.app.party.state.users[wrenId].publicProfile.id;
  const r1 = await playRound(app1.base, app1.app, { host, w, tag: 'R1' });
  const hostCookie = host.cookie;
  const wCookie = w.cookie;
  await app1.close();

  // The party must have ended: a running or waiting round can't be closed.
  const res = closeRound({ stateFile, log: quietLog });
  assert.deepEqual({ closed: res.closed, opened: res.opened, posts: res.posts, published: res.published, users: res.users }, { closed: 1, opened: 2, posts: 3, published: 2, users: 2 });
  const dir1 = path.join(roundsDirOf(stateFile), '1');
  for (const f of ['round.json', 'state.json', 'state.json.ops']) assert.ok(fs.existsSync(path.join(dir1, f)), f);
  assert.deepEqual(fs.readdirSync(`${stateFile}.ops`), [], 'the live journal starts empty');
  assert.throws(() => closeRound({ stateFile, log: quietLog }), /still in the lobby/);

  // Round 2: same accounts and sessions, a fresh lobby.
  const app2 = await start(t, stateFile);
  const b = app2.base;
  const anon = client(b);
  let s = (await anon.get('/api/session')).json;
  assert.equal(s.party.phase, 'lobby');
  assert.equal(s.party.round, 2);
  assert.deepEqual(s.party.rounds.map((r) => r.n), [1]);
  const host2 = client(b);
  const w2 = client(b);
  // Signed-in sessions carry over; so do passwords.
  const me = await fetch(`${b}/api/me`, { headers: { Cookie: wCookie } });
  assert.equal(me.status, 200);
  const meJson = await me.json();
  assert.equal(meJson.me.username, 'wren');
  assert.equal(meJson.me.pastPosts, 3);
  assert.equal(meJson.me.joinedAt, null, 'hours start again');
  assert.equal(meJson.me.inRound, false, 'not in round 2 until they join it');
  assert.equal(meJson.posts.length, 0, 'no posts in the new round');
  assert.equal((await host2.post('/api/login', { username: 'hostuser', password: PASSWORD })).status, 200);
  assert.equal((await w2.post('/api/login', { username: 'wren', password: PASSWORD })).status, 200);
  assert.ok(hostCookie);

  // Round 1's anthology: the published posts, not the private one; its post pages keep their address.
  assert.deepEqual((await anon.get('/api/archive')).json.posts, []);
  const a1 = (await anon.get('/api/archive?round=1')).json;
  assert.equal(a1.party.round, 1);
  assert.equal(a1.party.phase, 'ended');
  assert.equal(a1.party.past, true);
  assert.deepEqual(a1.posts.map((p) => p.title).sort(), ['R1 anonymous', 'R1 signed']);
  assert.equal(a1.posts.find((p) => p.title === 'R1 signed').name, 'Wren Writer');
  assert.equal(a1.posts.find((p) => p.title === 'R1 anonymous').name, null);
  const TIMES = /"(t|at|startedAt|endedAt|createdAt|activeAt|closedAt)"/; // the anthology carries no times
  assert.ok(!TIMES.test(JSON.stringify(a1)));
  assert.ok(!TIMES.test(JSON.stringify((await anon.get('/api/archive')).json)));
  assert.equal((await anon.get('/api/archive?round=9')).status, 404);
  assert.equal((await anon.get('/api/archive?round=x')).status, 404);
  const p1 = (await anon.get(`/api/p/${r1.signed.publicId}`)).json;
  assert.deepEqual([p1.round, p1.past, p1.phase, p1.name, p1.profile], [1, true, 'ended', 'Wren Writer', page]);
  assert.match(p1.text, /R1 signed piece/);
  assert.equal((await anon.get(`/api/p/${r1.secret.publicId}`)).status, 404, 'a private post stays private');
  // The writer's page lists round 1's signed piece under round 1.
  const wp = (await anon.get(`/api/w/${page}`)).json;
  assert.deepEqual(wp.posts, []);
  assert.equal(wp.inRound, false);
  assert.deepEqual(wp.past.map((g) => [g.round, g.posts.map((p) => p.title)]), [[1, ['R1 signed']]]);
  assert.ok(!TIMES.test(JSON.stringify(wp)));
  assert.ok(!TIMES.test(JSON.stringify((await anon.get(`/api/p/${r1.signed.publicId}`)).json)));

  // Their own earlier posts: all of them, private included, and only theirs.
  const past = (await w2.get('/api/me/past')).json;
  assert.equal(past.round, 2);
  assert.deepEqual(past.rounds.map((r) => [r.n, r.posts.map((p) => [p.title, p.privacy, !!p.publicId])]), [[1, [
    ['R1 anonymous', 'live', true], ['R1 signed', 'named', true], ['R1 private', 'private', false],
  ]]]);
  const secret = (await w2.get(`/api/me/past/post?round=1&id=${r1.secret.id}`)).json;
  assert.match(secret.body, /nobody else reads this/);
  assert.equal(secret.notes, 'R1 planning notes');
  assert.equal((await host2.get(`/api/me/past/post?round=1&id=${r1.secret.id}`)).status, 404, 'not someone else’s');
  assert.deepEqual((await host2.get('/api/me/past')).json.rounds, []);
  assert.equal((await anon.get('/api/me/past')).status, 401);

  // Until they join round 2, a returning writer isn't one of its writers: not on the list of
  // writers, not in the host's table or the food lists, and can't write. Their round-1 posts above
  // stayed public all the same.
  assert.equal((await w2.get('/api/session')).json.user.inRound, false);
  assert.deepEqual((await anon.get('/api/writers')).json.writers, []);
  const hostId = app2.app.party.userByUsername('hostuser').id;
  let hv0 = app2.app.party.hostView(hostId);
  assert.deepEqual(hv0.writers.map((x) => x.username), ['hostuser']);
  assert.equal(hv0.returning, 1);
  assert.deepEqual(peopleOf(app2.app.party).map((x) => x.username), ['hostuser']);
  for (const [url, body] of [['/api/join', {}], ['/api/post/new', { title: 'x' }]]) {
    const r = await w2.post(url, body);
    assert.equal(r.status, 403, url);
    assert.equal(r.json.code, 'not_in_round', url);
  }
  // A new account signs up in round 2: in it at once.
  const newbie = client(b);
  assert.equal((await newbie.post('/api/register', { username: 'newbie', password: PASSWORD, name: 'New Person' })).json.user.inRound, true);
  // The returning writer joins: on the list again (they'd opted in), and in the host's table.
  const j = await w2.post('/api/round/join', {});
  assert.equal(j.status, 200);
  assert.deepEqual([j.json.round, j.json.inRound], [2, true]);
  assert.equal((await w2.get('/api/session')).json.user.inRound, true);
  assert.deepEqual((await anon.get('/api/writers')).json.writers.map((x) => x.name), ['Wren Writer']);
  assert.equal((await anon.get(`/api/w/${page}`)).json.inRound, true);
  hv0 = app2.app.party.hostView(hostId);
  assert.deepEqual(hv0.writers.map((x) => x.username).sort(), ['hostuser', 'newbie', 'wren']);
  assert.equal(hv0.returning, 0);
  assert.equal((await w2.post('/api/round/join', {})).status, 200, 'joining twice is fine');

  // Round 2 runs on its own: only its posts go live, and its anthology is its own.
  const r2 = await playRound(b, app2.app, { host: host2, w: w2, tag: 'R2', onStart: async () => {
    const live = (await anon.get('/api/live')).json;
    assert.equal(live.posts.length, 0, 'round 1’s posts are not on round 2’s live page');
    assert.equal(live.party.phase, 'running');
  } });
  assert.ok(!Object.values(r1).some((p) => p.publicId === r2.signed.publicId));
  const a2 = (await anon.get('/api/archive')).json;
  assert.equal(a2.party.round, 2);
  assert.deepEqual(a2.posts.map((p) => p.title).sort(), ['R2 anonymous', 'R2 signed']);
  assert.deepEqual(a2.rounds.map((r) => r.n), [1]);
  assert.deepEqual((await anon.get('/api/archive?round=2')).json.posts.map((p) => p.title).sort(), ['R2 anonymous', 'R2 signed']);
  assert.equal((await anon.get(`/api/p/${r2.signed.publicId}`)).json.round, 2);
  const wp2 = (await anon.get(`/api/w/${page}`)).json;
  assert.deepEqual(wp2.posts.map((p) => p.title), ['R2 signed']);
  assert.deepEqual(wp2.past.map((g) => g.round), [1]);
  // Round 2's hours were judged from round 2 alone (round 1's words don't count in it).
  const hv = app2.app.party.hostView(app2.app.party.userByUsername('hostuser').id);
  assert.equal(hv.party.round, 2);
  assert.deepEqual(hv.party.rounds.map((r) => r.n), [1]);
  await app2.close();

  // A third round: both earlier ones listed and served.
  closeRound({ stateFile, log: quietLog });
  assert.deepEqual(loadRounds(roundsDirOf(stateFile)).map((r) => r.n), [1, 2]);
  const app3 = await start(t, stateFile);
  const c3 = client(app3.base);
  s = (await c3.get('/api/session')).json;
  assert.equal(s.party.round, 3);
  assert.deepEqual(s.party.rounds.map((r) => r.n), [1, 2]);
  assert.deepEqual((await c3.get('/api/archive?round=1')).json.posts.map((p) => p.title).sort(), ['R1 anonymous', 'R1 signed']);
  assert.deepEqual((await c3.get('/api/archive?round=2')).json.posts.map((p) => p.title).sort(), ['R2 anonymous', 'R2 signed']);
  assert.equal((await c3.get(`/api/p/${r1.anon.publicId}`)).json.round, 1);
  assert.equal((await c3.get(`/api/p/${r2.anon.publicId}`)).json.round, 2);
  const w3 = client(app3.base);
  await w3.post('/api/login', { username: 'wren', password: PASSWORD });
  assert.deepEqual((await w3.get('/api/me/past')).json.rounds.map((r) => r.n), [2, 1], 'newest round first');
  // Joining round 2 didn't make them part of round 3.
  assert.equal((await w3.get('/api/session')).json.user.inRound, false);
  assert.deepEqual((await c3.get('/api/writers')).json.writers, []);
});

test('rounds: a round that is running or still in the lobby is not closed, and nothing changes', async (t) => {
  const stateFile = tmpStateFile();
  const app = await start(t, stateFile);
  const host = client(app.base);
  await host.post('/api/register', { username: 'hostuser', password: PASSWORD, name: 'Host' });
  await app.close();
  const before = fs.readFileSync(stateFile, 'utf8');
  assert.throws(() => closeRound({ stateFile, log: quietLog }), /still in the lobby/);
  const app2 = await start(t, stateFile);
  const h2 = client(app2.base);
  await h2.post('/api/login', { username: 'hostuser', password: PASSWORD });
  await h2.post('/api/admin/start', {});
  await app2.close();
  const running = fs.readFileSync(stateFile, 'utf8');
  assert.throws(() => closeRound({ stateFile, log: quietLog }), /still running/);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), running);
  assert.ok(!fs.existsSync(roundsDirOf(stateFile)));
  assert.notEqual(before, running);
});

test('rounds: an earlier close left half-done is refused', async (t) => {
  const stateFile = tmpStateFile();
  const app = await start(t, stateFile);
  const host = client(app.base);
  await host.post('/api/register', { username: 'hostuser', password: PASSWORD, name: 'Host' });
  await host.post('/api/admin/start', {});
  await host.post('/api/admin/end', {});
  await app.close();
  fs.mkdirSync(path.join(roundsDirOf(stateFile), '1.tmp'), { recursive: true });
  assert.throws(() => closeRound({ stateFile, log: quietLog }), /didn't finish/);
  fs.rmSync(path.join(roundsDirOf(stateFile), '1.tmp'), { recursive: true });
  assert.equal(closeRound({ stateFile, log: quietLog }).opened, 2);
});

test('rounds: the next round keeps accounts and resets each writer’s hours, passes, reviews and food order', () => {
  const clock = makeClock();
  const { party } = makeParty({ clock });
  const host = addUser(party, 'hostuser');
  const ana = addUser(party, 'ana');
  party.start(host.id);
  Object.assign(party.state.users[ana.id], {
    out: true, outAt: clock.now(), outReason: 'missed', outVia: 'auto', outAuto: 2, extraPasses: 2, freeHours: [1], reviews: { 1: 'x' }, reviewSeen: 3,
    judged: { 1: 'met' }, targetOverride: 300, leftAt: clock.now(), leftBy: ana.id, leaves: [{ at: 1 }],
    bonusCredit: [{ at: clock.now(), words: 9, source: 'food' }], foodMark: 9,
    food: { diet: 'vegan', love: 'lentil soup with lots of herbs', order: { eating: 'yes', wish: 'a big bowl of noodles please', picks: [], lines: {} }, updatedAt: clock.now() },
    publicProfile: { on: true, id: 'abcdefgh' }, customCss: 'body{}',
  });
  party.end(host.id);
  const state = structuredClone(party.snapshot());
  const at = clock.now() + 1000;
  const next = nextRoundState(state, { at });
  assert.equal(next.party.phase, 'lobby');
  assert.equal(next.party.round, 2);
  assert.equal(next.party.foodResetAt, at);
  assert.deepEqual([next.posts, next.breaks, next.alerts], [{}, [], []]);
  assert.equal(next.log.length, 1);
  assert.deepEqual(next.sessions, state.sessions);
  assert.deepEqual(next.settings, state.settings);
  const u = next.users[ana.id];
  for (const k of ['id', 'username', 'name', 'passHash', 'isAdmin', 'createdAt', 'approval', 'publicProfile', 'customCss']) assert.deepEqual(u[k], state.users[ana.id][k], k);
  assert.deepEqual({ joinedAt: u.joinedAt, out: u.out, outAt: u.outAt, extraPasses: u.extraPasses, freeHours: u.freeHours, reviews: u.reviews, evaluatedThrough: u.evaluatedThrough, targetOverride: u.targetOverride },
    { joinedAt: null, out: false, outAt: null, extraPasses: 0, freeHours: [], reviews: {}, evaluatedThrough: -1, targetOverride: null });
  for (const k of ['outVia', 'outAuto', 'reviewSeen', 'judged', 'leftAt', 'leftBy', 'leaves', 'bonusCredit', 'outReason']) assert.ok(u[k] === undefined || u[k] === null, k);
  assert.ok(ROUND_USER_KEYS.includes('bonusCredit'));
  // The food order answers went to the history; the standing answers stay but don't count again.
  assert.equal(u.food.order.wish, '');
  assert.equal(u.food.love, 'lentil soup with lots of herbs');
  assert.equal(u.foodHistory.length, 1);
  assert.equal(u.foodHistory[0].food.order.wish, 'a big bowl of noodles please');
  assert.equal(u.foodBase, foodWordsOf(u.food));
  assert.equal(u.foodMark, foodWordsOf(u.food));
  // The input isn't changed.
  assert.equal(state.party.phase, 'ended');
  assert.equal(state.users[ana.id].out, true);
});

test('rounds: food answers carried into a new round don’t count in its words today', () => {
  const clock = makeClock();
  const { party } = makeParty({ clock });
  const host = addUser(party, 'hostuser');
  const ana = addUser(party, 'ana');
  party.state.users[ana.id].food = { diet: 'vegan', love: 'lentil soup with lots of herbs', order: { picks: [], lines: {} } };
  const words = foodWordsOf(party.state.users[ana.id].food);
  assert.ok(words > 0);
  assert.equal(party.wordsTodayNow(true), words);
  party.state.users[ana.id].foodBase = words;
  assert.equal(party.wordsTodayNow(true), 0);
  party.state.users[ana.id].food = { ...party.state.users[ana.id].food, notes: 'two more' };
  assert.equal(party.wordsTodayNow(true), 2);
  void host;
});

test('rounds: images from an earlier round stay but don’t count towards the quota', async () => {
  const dir = path.join(path.dirname(tmpStateFile()), 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  const files = {};
  for (let i = 0; i < 5; i++) files[`${String(i).repeat(32)}.png`] = { uid: 'uana', kind: 'png', bytes: 100, w: 1, h: 1, at: 1, ...(i < 4 ? { round: 1 } : {}) };
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ v: 1, files }));
  const up = createUploads({ dir, log: quietLog });
  assert.deepEqual(up.usage('uana'), { files: 1, bytes: 100 });
});

test('rounds: accounts from an earlier round are left out of this round until they join it', () => {
  const clock = makeClock();
  const { party } = makeParty({ clock });
  const host = addUser(party, 'hostuser');
  const ana = addUser(party, 'ana');
  const ben = addUser(party, 'ben');
  for (const u of [host, ana, ben]) party.setPublicProfile(u.id, true);
  for (const u of [ana, ben]) u.food = { diet: 'vegan', love: 'soup', order: { picks: [], lines: {} } };
  assert.deepEqual(party.writersView().writers.map((w) => w.name).sort(), ['ANA', 'BEN', 'HOSTUSER']);
  // As if this were round 2 and all three came from round 1.
  party.state.party.round = 2;
  assert.deepEqual([party.inRound(host), party.inRound(ana)], [false, false]);
  assert.deepEqual(party.writersView().writers, [], 'nobody on round 2’s list of writers yet');
  assert.deepEqual(party.hostView(host.id).writers.map((w) => w.username), ['hostuser'], 'hosts stay in their own dashboard');
  assert.equal(party.hostView(host.id).returning, 2);
  assert.deepEqual(peopleOf(party).map((p) => p.username), ['hostuser'], 'food lists: this round’s people and the hosts');
  assert.equal(party.wordsTodayNow(true), 0);
  assert.throws(() => party.join(ana.id), (e) => e.extra?.code === 'not_in_round');
  assert.equal(party.writerPageView(ana.publicProfile.id).inRound, false, 'their page still opens, without this round’s hours');
  assert.equal(party.approvalView(ana).inRound, false);
  party.joinRound(ana.id);
  assert.equal(party.inRound(ana), true);
  assert.equal(ana.round, 2);
  assert.deepEqual(party.writersView().writers.map((w) => w.name), ['ANA']);
  assert.deepEqual(peopleOf(party).map((p) => p.username).sort(), ['ana', 'hostuser']);
  assert.deepEqual(party.hostView(host.id).writers.map((w) => w.username).sort(), ['ana', 'hostuser']);
  assert.equal(party.state.log.at(-1).type, 'round-join');
  // A host who writes joins like anyone.
  assert.throws(() => party.join(host.id), (e) => e.extra?.code === 'not_in_round');
  party.joinRound(host.id);
  assert.deepEqual(party.writersView().writers.map((w) => w.name).sort(), ['ANA', 'HOSTUSER']);
  // Signing up in round 2 puts an account in it.
  assert.equal(party.inRound(addUser(party, 'cleo')), true);
});
