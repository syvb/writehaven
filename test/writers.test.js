// SPEC §28: the opt-in public list of writers (GET /api/writers) and personal pages
// (GET /api/w/<id>): off by default, the person's own choice, signed posts only, nothing that
// identifies an account or links its other posts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeParty, addUser, typeInto, startApp, client, readSse } from './helpers.js';
import { realProse, MIN, SEC, T0 } from './sim.js';
import { attachAccounts } from '../lib/accounts.js';
import { attachWriters } from '../lib/writers.js';

const JUDGED = 2 * MIN; // an hour's words have settled (settleSec 2) well within this
// Synced 10-minute hours on the clock from the start (T0 = 17:00 UTC), 20 words to meet one.
const SYNCED = { hoursMode: 'synced', hourLengthMin: 10, targetPerHour: 20, minFirstHourMin: 0, settleSec: 2, settleQuantumSec: 1 };

function setup(settings = SYNCED) {
  const { party, clock } = makeParty({ settings });
  const host = addUser(party, 'host', 'Hostess');
  party.start(host.id);
  return { party, clock, host };
}
// None of `needles` ([what, text]) may appear anywhere in the payload.
function assertAbsent(label, payload, needles) {
  const flat = JSON.stringify(payload);
  for (const [what, needle] of needles) assert.ok(!flat.includes(needle), `${label} contains ${what} (${needle})`);
}
const ids = (v) => v.writers.map((w) => w.id);

test('off by default: nobody is listed and no page answers until the writer opts in', () => {
  const { party, clock } = setup();
  const w = addUser(party, 'wren', 'Wren Hollow');
  party.join(w.id);
  const p = party.newPost(w.id, { title: 'Signed but not listed' });
  party.updatePost(w.id, { id: p.id, privacy: 'named' });
  typeInto(party, clock, w, p, realProse(12), { cps: 20 });
  assert.equal(w.publicProfile, undefined, 'no setting, no page id');
  assert.deepEqual(party.writersView().writers, []);
  assert.equal(party.publicPost(p.publicId).profile, null, 'the signed post links nowhere');
  // Turning it off when it was never on makes no page id either.
  assert.equal(party.setPublicProfile(w.id, false), null);
  assert.equal(w.publicProfile, undefined);
  assert.throws(() => party.writerPageView('anything'), (e) => e.status === 404);
});

test('opting in lists the writer by name with hours met of hours judged, and out of the challenge', () => {
  const { party, clock, host } = setup();
  const w = addUser(party, 'wren', 'Wren Hollow');
  const v = addUser(party, 'avery', 'avery');
  party.join(w.id);
  party.join(v.id);
  const pp = party.setPublicProfile(w.id, true);
  party.setPublicProfile(v.id, true);
  assert.match(pp.id, /^[a-z2-9]{12}$/, 'a random 12-character id');
  assert.deepEqual(party.writersView().writers.map((x) => [x.name, x.met, x.judged, x.out]), [['avery', 0, 0, false], ['Wren Hollow', 0, 0, false]], 'by name, case-insensitively');
  // Hour 1 (17:00–17:10): Wren writes 30 words of 20; Avery nothing.
  const p = party.newPost(w.id, { title: 'Hour one' });
  typeInto(party, clock, w, p, realProse(30, 40), { cps: 5 });
  clock.set(T0 + 10 * MIN + JUDGED);
  party.tick();
  let rows = Object.fromEntries(party.writersView().writers.map((x) => [x.name, x]));
  assert.deepEqual([rows['Wren Hollow'].met, rows['Wren Hollow'].judged, rows['Wren Hollow'].out], [1, 1, false]);
  assert.deepEqual([rows.avery.met, rows.avery.judged, rows.avery.out], [0, 1, true], 'a missed hour puts Avery out, shown honestly');
  // Hour 2: nobody writes.
  clock.set(T0 + 20 * MIN + JUDGED);
  party.tick();
  rows = Object.fromEntries(party.writersView().writers.map((x) => [x.name, x]));
  assert.deepEqual([rows['Wren Hollow'].met, rows['Wren Hollow'].judged, rows['Wren Hollow'].out], [1, 2, true]);
  assert.deepEqual(Object.keys(rows['Wren Hollow']).sort(), ['id', 'judged', 'left', 'met', 'name', 'out'], 'nothing else per writer'); // left: SPEC §33
  // A free hour is neither met nor missed: the host waives Avery's hour 3 (17:20–17:30).
  party.adminWriter(host.id, { id: v.id, freeHour: 'current' });
  clock.set(T0 + 30 * MIN + JUDGED);
  party.tick();
  rows = Object.fromEntries(party.writersView().writers.map((x) => [x.name, x]));
  assert.deepEqual([rows.avery.met, rows.avery.judged], [0, 2], 'hour 3 was free: still 2 judged');
  assert.equal(rows['Wren Hollow'].judged, 3);
});

test('a personal page lists only the posts signed with the name: never anonymous, separate, private, hidden or empty ones, before or after the end', () => {
  const { party, clock, host } = setup();
  const w = addUser(party, 'wren', 'Wren Hollow');
  w.email = 'wren.hollow@example.org';
  w.food = { love: 'quinceflummery', notes: 'no coriander please' };
  party.join(w.id);
  const mk = (title, privacy, text, { notes = null } = {}) => {
    const p = party.newPost(w.id, { title });
    if (privacy !== 'live') party.updatePost(w.id, { id: p.id, privacy });
    if (text) typeInto(party, clock, w, p, text, { cps: 40 });
    if (notes) typeInto(party, clock, w, p, notes, { pane: 'notes', cps: 40 });
    return party.state.posts[p.id];
  };
  const first = mk('Signed lanterns', 'named', 'the lanterns swung over the quay all night', { notes: 'a planning note about gulls' });
  clock.advance(MIN);
  const second = mk('Signed tide tables', 'named', 'the tide tables lied about the morning');
  const anon = mk('Anonymous harbour', 'live', 'an unsigned harbour of rust and tar');
  const sep = mk('Separate orchard', 'separate', 'a separate orchard of quiet pears');
  const priv = mk('Private ledger', 'private', 'a private ledger nobody may read');
  const hidden = mk('Hidden signed', 'named', 'a signed piece the host hid');
  const empty = mk('Empty signed', 'named', '');
  party.adminPost(host.id, { id: hidden.id, unlisted: true });
  const pp = party.setPublicProfile(w.id, true);
  const others = [anon, sep, priv, hidden, empty];
  const needles = [
    ...others.flatMap((p) => [['a title', p.title], ['a post id', p.id], ['a public id', p.publicId]]),
    ['anonymous text', 'unsigned harbour'], ['separate text', 'quiet pears'], ['private text', 'private ledger'], ['hidden text', 'host hid'],
    ['notes', 'planning note'], ['the username', 'wren"'], ['the email', 'wren.hollow@example.org'], ['the user id', w.id],
    ['food', 'quinceflummery'], ['food', 'coriander'], ['post ids', first.id], ['post ids', second.id],
  ];
  const check = (label) => {
    const page = party.writerPageView(pp.id);
    assert.deepEqual(page.posts.map((p) => p.title), ['Signed tide tables', 'Signed lanterns'], `${label}: signed posts, newest first`);
    assert.deepEqual(Object.keys(page.posts[0]).sort(), ['excerpt', 'publicId', 'starred', 'title', 'words']);
    assert.equal(page.posts[1].publicId, first.publicId);
    assert.equal(page.posts[1].words, 8);
    assert.match(page.posts[1].excerpt, /^the lanterns swung/);
    assert.deepEqual([page.id, page.name], [pp.id, 'Wren Hollow']);
    assertAbsent(label, page, needles);
    assertAbsent(`${label} (list)`, party.writersView(), needles);
    // The signed post's page links back; no unsigned post ever carries the page id.
    assert.equal(party.publicPost(first.publicId).profile, pp.id);
    assertAbsent(`${label}: the live view`, party.liveView(), [['the page id', pp.id]]);
    assertAbsent(`${label}: the archive`, party.archiveView(), [['the page id', pp.id]]);
  };
  check('running');
  party.end(host.id);
  assert.ok(party.archiveView().posts.some((p) => p.title === 'Separate orchard'), 'the separate post is published after the end...');
  check('after the end'); // ...but never on the personal page
  const anonPage = party.publicPost(party.state.posts[anon.id].publicId);
  assert.equal(anonPage.profile, null);
  assert.equal(party.publicPost(party.state.posts[sep.id].publicId).profile, null);
});

test('a signed post taken anonymous or private leaves the page at once; a new name and an email name show in public form', () => {
  const { party, clock } = setup();
  const w = addUser(party, 'wren', 'Wren Hollow');
  party.join(w.id);
  const p = party.newPost(w.id, { title: 'Was signed' });
  party.updatePost(w.id, { id: p.id, privacy: 'named' });
  typeInto(party, clock, w, p, 'words that were signed for a while', { cps: 40 });
  const { id } = party.setPublicProfile(w.id, true);
  const signedId = party.state.posts[p.id].publicId;
  assert.deepEqual(party.writerPageView(id).posts.map((x) => x.publicId), [signedId]);
  party.updatePost(w.id, { id: p.id, privacy: 'live' });
  assert.deepEqual(party.writerPageView(id).posts, [], 'unsigned: gone from the page');
  assertAbsent('the page', party.writerPageView(id), [['the new public id', party.state.posts[p.id].publicId], ['the title', 'Was signed']]);
  party.updatePost(w.id, { id: p.id, privacy: 'named' });
  assert.equal(party.writerPageView(id).posts.length, 1);
  party.updatePost(w.id, { id: p.id, privacy: 'private' });
  assert.deepEqual(party.writerPageView(id).posts, []);
  // An older stored name with an address shows only the part before "@".
  w.name = 'wren.hollow@example.com';
  assert.equal(party.writersView().writers[0].name, 'wren.hollow');
  assert.equal(party.writerPageView(id).name, 'wren.hollow');
  assert.ok(!JSON.stringify(party.writersView()).includes('example.com'));
});

test('the page id is random, unguessable and stable: kept across leaving and rejoining, never derived from the account', () => {
  const { party } = setup();
  const a = addUser(party, 'wren', 'Wren Hollow');
  const b = addUser(party, 'wrenn', 'Wren Hollow');
  const ida = party.setPublicProfile(a.id, true).id;
  const idb = party.setPublicProfile(b.id, true).id;
  assert.notEqual(ida, idb, 'two people with the same name get different pages');
  for (const id of [ida, idb]) {
    assert.match(id, /^[a-z2-9]{12}$/);
    for (const s of ['wren', 'hollow', a.id, b.id, a.id.slice(1, 7), b.id.slice(1, 7)]) assert.ok(!id.includes(s.toLowerCase()), `${id} vs ${s}`);
  }
  const before = party.publicRev;
  party.setPublicProfile(a.id, false);
  assert.ok(party.publicRev > before, 'leaving the list is a public change (caches rebuild)');
  assert.deepEqual(ids(party.writersView()), [idb]);
  assert.throws(() => party.writerPageView(ida), (e) => e.status === 404, 'left: the page answers 404');
  assert.equal(party.meView(a.id).me.page, null, 'off the list: no page in their own view ("My page" offers the list)');
  assert.equal(party.setPublicProfile(a.id, true).id, ida, 'back on the list: the same page');
  assert.equal(party.meView(a.id).me.page, ida, 'their own view carries it, for "My page" (SPEC §28b)');
  assert.equal(party.meView(b.id).me.page, idb);
  assert.deepEqual(ids(party.writersView()).sort(), [ida, idb].sort());
  assert.ok(party.state.log.some((l) => l.type === 'public-list' && l.userId === a.id && /left the public list/.test(l.text)));
});

test('before the start: listed with no hours yet, and no posts (nothing is public in the lobby)', () => {
  const { party } = makeParty({ settings: SYNCED });
  addUser(party, 'host', 'Hostess');
  const w = addUser(party, 'wren', 'Wren Hollow');
  const { id } = party.setPublicProfile(w.id, true);
  assert.deepEqual(party.writersView(), { party: { name: 'Writehaven', phase: 'lobby' }, writers: [{ id, name: 'Wren Hollow', met: 0, judged: 0, out: false, left: false }] });
  assert.deepEqual(party.writerPageView(id).posts, []);
});

test('pending and declined accounts are never listed, even when they opted in', () => {
  const { party, host } = setup({ ...SYNCED, approvalRequired: true });
  const w = addUser(party, 'wren', 'Wren Hollow');
  assert.equal(party.approvalOf(w), 'pending');
  const { id } = party.setPublicProfile(w.id, true); // their own choice, kept while they wait
  assert.equal(party.meView(w.id).me.page, null, 'not listed while waiting: no page yet');
  assert.deepEqual(party.writersView().writers, []);
  assert.throws(() => party.writerPageView(id), (e) => e.status === 404);
  party.approve(host.id, { id: w.id });
  assert.deepEqual(ids(party.writersView()), [id]);
  party.decline(host.id, { id: w.id });
  assert.deepEqual(party.writersView().writers, []);
  assert.throws(() => party.writerPageView(id), (e) => e.status === 404);
});

test('personal hours: the public numbers move only on the hour (party clock), so they never show when someone started', () => {
  const { party, clock, host } = setup({ hoursMode: 'personal', hourLengthMin: 10, targetPerHour: 20, settleSec: 2, settleQuantumSec: 1 });
  clock.set(T0 + 7 * MIN);
  const w = addUser(party, 'wren', 'Wren Hollow');
  party.join(w.id); // 17:07: hours end at 17:17, 17:27...
  const { id } = party.setPublicProfile(w.id, true);
  clock.set(T0 + 17 * MIN + JUDGED);
  party.tick();
  assert.equal(w.out, true, 'hour 1 missed at 17:17');
  assert.deepEqual(party.progressOf(w.id).prog.missed, 1);
  const row = () => party.writersView().writers[0];
  assert.deepEqual([row().judged, row().out], [0, false], 'still as of 17:00');
  assert.equal(party.writerPageView(id).out, false);
  clock.set(T0 + 59 * MIN);
  party.tick();
  assert.deepEqual([row().judged, row().out], [0, false]);
  clock.set(T0 + 60 * MIN);
  party.tick();
  assert.deepEqual([row().met, row().judged, row().out], [0, 5, true], '18:00: the hours that ended by then (17:17, :27, :37, :47, :57)');
  // After the end, once every hour has settled, the final numbers.
  clock.set(T0 + 75 * MIN);
  party.tick();
  party.end(host.id);
  assert.equal(row().judged, 5, 'just after the end (18:15): still as of 18:00');
  clock.advance(2 * MIN);
  party.tick();
  assert.equal(row().judged, 6, 'once every hour has settled: the hour that ended at 18:07 too (18:17 came after the end)');
});

// ------------------------------------------------------------------ over HTTP
async function app(opts = {}) {
  const a = await startApp(opts);
  attachAccounts(a.app);
  attachWriters(a.app);
  return a;
}
async function signUp(base, username, name) {
  const c = client(base);
  const r = await c.post('/api/register', { username, password: 'longpassword', name, email: `${username}@example.org` });
  assert.equal(r.status, 200, r.text);
  return { c, id: r.json.user.id };
}

test('HTTP: opting in and out from Your account; hosts can’t do it for anyone; the list and pages follow at once', async () => {
  const { base, app: a, close } = await app();
  try {
    const host = await signUp(base, 'host', 'Hostess');
    const wren = await signUp(base, 'wren', 'Wren Hollow');
    assert.equal((await host.c.post('/api/admin/start')).status, 200);
    await wren.c.post('/api/join');
    const np = await wren.c.post('/api/post/new', { title: 'A signed piece' });
    await wren.c.post('/api/post/update', { id: np.json.post.id, privacy: 'named' });
    await wren.c.post('/api/ops', { postId: np.json.post.id, pane: 'body', baseVersion: 0, seq: 's1', sentAt: Date.now(), ops: [{ at: Date.now(), pos: 0, del: 0, ins: 'Every night the lamp turned over the water.' }] });
    const signedPublicId = a.party.state.posts[np.json.post.id].publicId;

    let acc = await wren.c.get('/api/me/account');
    assert.deepEqual(acc.json.publicProfile, { on: false, id: null }, 'off by default');
    assert.deepEqual((await wren.c.get('/api/writers')).json.writers, []);

    // Hosts can't set it for anyone, either way.
    for (const v of [true, false]) {
      const r = await host.c.post('/api/host/account', { id: wren.id, publicProfile: v });
      assert.equal(r.status, 403);
      assert.equal(r.json.code, 'self_only');
    }
    assert.equal(a.party.userById(wren.id).publicProfile, undefined);
    assert.equal((await wren.c.post('/api/me/account', { publicProfile: 'yes' })).status, 400);

    const on = await wren.c.post('/api/me/account', { publicProfile: true });
    assert.equal(on.status, 200, on.text);
    assert.deepEqual(on.json.changed, ['publicProfile']);
    assert.equal(on.json.publicProfile.on, true);
    const pid = on.json.publicProfile.id;
    acc = await wren.c.get('/api/me/account');
    assert.deepEqual(acc.json.publicProfile, { on: true, id: pid });
    const list = await client(base).get('/api/writers'); // anyone, signed out
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.writers, [{ id: pid, name: 'Wren Hollow', met: 0, judged: 0, out: false, left: false }]);
    assert.deepEqual(list.json.party, { name: 'Writehaven', phase: 'running' });
    const page = await client(base).get(`/api/w/${pid}`);
    assert.equal(page.status, 200);
    assert.deepEqual(page.json.posts.map((p) => [p.publicId, p.title]), [[signedPublicId, 'A signed piece']]);
    assert.equal((await client(base).get(`/api/p/${signedPublicId}`)).json.profile, pid);
    assert.ok(!a.party.state.log.some((l) => l.type === 'account' && l.userId === wren.id), 'no empty "changed their" line');
    assert.ok(a.party.state.log.some((l) => l.type === 'public-list' && l.userId === wren.id));

    // Signing in as the host and editing their own account is their own choice.
    const self = await host.c.post('/api/host/account', { id: host.id, publicProfile: true });
    assert.equal(self.status, 200, self.text);
    assert.equal((await client(base).get('/api/writers')).json.writers.length, 2);
    await host.c.post('/api/me/account', { publicProfile: false });

    // Off: gone from the list and the page at once (the cached answers rebuild), and the post
    // page stops linking.
    await client(base).get('/api/writers'); // warm the cache
    const off = await wren.c.post('/api/me/account', { publicProfile: false });
    assert.deepEqual(off.json.publicProfile, { on: false, id: null });
    assert.deepEqual((await client(base).get('/api/writers')).json.writers, []);
    assert.equal((await client(base).get(`/api/w/${pid}`)).status, 404);
    assert.equal((await client(base).get(`/api/p/${signedPublicId}`)).json.profile, null);
    // Back on: the same page.
    assert.equal((await wren.c.post('/api/me/account', { publicProfile: true })).json.publicProfile.id, pid);
    // A new display name shows at once.
    await wren.c.post('/api/me/account', { name: 'Wren H.' });
    assert.equal((await client(base).get('/api/writers')).json.writers[0].name, 'Wren H.');
  } finally {
    await close();
  }
});

test('HTTP: an unknown, malformed or withdrawn page id is the same 404; answers carry an ETag and revalidate', async () => {
  const { base, app: a, close } = await app();
  try {
    const host = await signUp(base, 'host', 'Hostess');
    const wren = await signUp(base, 'wren', 'Wren Hollow');
    await host.c.post('/api/admin/start');
    const pid = (await wren.c.post('/api/me/account', { publicProfile: true })).json.publicProfile.id;
    const anon = client(base);
    const unknown = await anon.get('/api/w/abcdefghijkm');
    assert.equal(unknown.status, 404);
    for (const p of ['/api/w/%E0%A4%A', '/api/w/..%2Fwriters', '/api/w/', `/api/w/${pid.toUpperCase()}`, `/api/w/${pid}x`]) {
      const r = await anon.get(p);
      assert.equal(r.status, 404, p);
      assert.deepEqual(r.json, unknown.json, `${p}: the same answer`);
    }
    for (const path of ['/api/writers', `/api/w/${pid}`]) {
      const r1 = await anon.get(path);
      const tag = r1.headers.get('etag');
      assert.ok(tag, `${path}: ETag`);
      assert.equal(r1.headers.get('cache-control'), 'no-cache');
      const r2 = await anon.get(path, { headers: { 'If-None-Match': tag } });
      assert.equal(r2.status, 304, `${path}: unchanged → 304`);
      const head = await fetch(base + path, { method: 'HEAD' });
      assert.equal(head.status, 200);
    }
    await wren.c.post('/api/me/account', { publicProfile: false });
    const gone = await anon.get(`/api/w/${pid}`);
    assert.equal(gone.status, 404);
    assert.deepEqual(gone.json, unknown.json, 'withdrawn looks like never existed');
    assert.equal(a.party.userById(wren.id).publicProfile.id, pid, 'the id is kept for a return');
  } finally {
    await close();
  }
});

test('HTTP: no email, username, user id, food or notes anywhere in the list, the pages or a signed post page', async () => {
  const { base, app: a, close } = await app();
  try {
    const host = await signUp(base, 'host', 'Hostess');
    const wren = await signUp(base, 'wrenhollow', 'Wren Hollow');
    const ben = await signUp(base, 'benokafor', 'Ben Okafor');
    await host.c.post('/api/admin/start');
    for (const u of [wren, ben]) {
      await u.c.post('/api/join');
      await u.c.post('/api/me/account', { publicProfile: true });
      a.party.userById(u.id).food = { love: `favourite-${u.id}`, notes: 'secret-food-note' };
    }
    const np = await wren.c.post('/api/post/new', { title: 'Signed' });
    await wren.c.post('/api/post/update', { id: np.json.post.id, privacy: 'named' });
    const now = Date.now();
    await wren.c.post('/api/ops', { postId: np.json.post.id, pane: 'body', baseVersion: 0, seq: 'b1', sentAt: now, ops: [{ at: now, pos: 0, del: 0, ins: 'A signed paragraph about the sea.' }] });
    await wren.c.post('/api/ops', { postId: np.json.post.id, pane: 'notes', baseVersion: 0, seq: 'n1', sentAt: now, ops: [{ at: now, pos: 0, del: 0, ins: 'secret planning notes' }] });
    const payloads = [];
    const list = await client(base).get('/api/writers');
    payloads.push(['/api/writers', list.text]);
    for (const w of list.json.writers) payloads.push([`/api/w/${w.id}`, (await client(base).get(`/api/w/${w.id}`)).text]);
    payloads.push(['/api/p', (await client(base).get(`/api/p/${a.party.state.posts[np.json.post.id].publicId}`)).text]);
    assert.equal(payloads.length, 4);
    for (const [label, text] of payloads) {
      for (const needle of ['wrenhollow', 'benokafor', '@example.org', 'example', wren.id, ben.id, host.id, 'secret', 'favourite', np.json.post.id, '"username"', '"email"', '"userId"', 'joinedAt', 'credit']) {
        assert.ok(!text.includes(needle), `${label} contains ${needle}`);
      }
    }
  } finally {
    await close();
  }
});

// ------------------------------------------------------------------ stars (SPEC §28b)
test('stars: only the writer stars their own posts; starred signed posts lead their page; unsigned stars are kept but never shown', () => {
  const { party, clock, host } = setup();
  const w = addUser(party, 'wren', 'Wren Hollow');
  const o = addUser(party, 'otto', 'Otto Lind');
  party.join(w.id);
  party.join(o.id);
  const mk = (who, title, privacy, text) => {
    const p = party.newPost(who.id, { title });
    if (privacy !== 'live') party.updatePost(who.id, { id: p.id, privacy });
    typeInto(party, clock, who, p, text, { cps: 40 });
    clock.advance(MIN);
    return party.state.posts[p.id];
  };
  const a = mk(w, 'Oldest signed', 'named', 'the oldest signed piece of the evening');
  const b = mk(w, 'Middle signed', 'named', 'a middle signed piece about rain');
  const c = mk(w, 'Newest signed', 'named', 'the newest signed piece so far');
  const d = mk(w, 'Anonymous starred', 'live', 'an unsigned piece the writer liked');
  const e = mk(w, 'Separate starred', 'separate', 'a separate piece the writer liked');
  const f = mk(w, 'Private starred', 'private', 'a private piece the writer liked');
  const theirs = mk(o, 'Otto signed', 'named', 'a signed piece by someone else');
  const { id } = party.setPublicProfile(w.id, true);
  const page = () => party.writerPageView(id).posts.map((x) => [x.title, x.starred]);
  assert.deepEqual(page(), [['Newest signed', false], ['Middle signed', false], ['Oldest signed', false]], 'no stars: newest first');

  // Only the writer, only their own posts: someone else's (a host's included) is "no such post".
  for (const who of [o, host]) assert.throws(() => party.setStar(who.id, { postId: a.id, starred: true }), (x) => x.status === 404, `${who.username} can't star Wren's post`);
  assert.throws(() => party.setStar(w.id, { postId: theirs.id, starred: true }), (x) => x.status === 404);
  assert.throws(() => party.setStar(w.id, { publicId: theirs.publicId, starred: true }), (x) => x.status === 404, 'nor by its public id');
  for (const bad of [{ postId: a.id }, { postId: a.id, starred: 'yes' }, null, []]) assert.throws(() => party.setStar(w.id, bad), (x) => x.status === 400);
  assert.equal(a.starred, undefined, 'nothing changed');

  const before = party.publicRev;
  assert.deepEqual(party.setStar(w.id, { postId: a.id, starred: true }), { starred: true, listed: true, page: id });
  assert.ok(party.publicRev > before, 'a signed post’s star rebuilds the page at once');
  assert.deepEqual(page(), [['Oldest signed', true], ['Newest signed', false], ['Middle signed', false]], 'starred first');
  party.setStar(w.id, { publicId: b.publicId, starred: true }); // from the page: by its public id
  assert.deepEqual(page(), [['Middle signed', true], ['Oldest signed', true], ['Newest signed', false]], 'starred ones newest first, then the rest');
  assert.deepEqual(party.setStar(w.id, { postId: a.id, starred: true }).starred, true, 'starring twice is harmless');

  // Unsigned posts keep their star but it shows nowhere.
  const rev = party.publicRev;
  for (const x of [d, e, f]) assert.equal(party.setStar(w.id, { postId: x.id, starred: true }).starred, true);
  assert.equal(party.publicRev, rev, 'unsigned stars change nothing public');
  const titles = () => party.writerPageView(id).posts.map((x) => x.title);
  assert.deepEqual(titles(), ['Middle signed', 'Oldest signed', 'Newest signed']);
  assert.deepEqual(party.meView(w.id).posts.filter((x) => x.starred).map((x) => x.title).sort(), ['Anonymous starred', 'Middle signed', 'Oldest signed', 'Private starred', 'Separate starred'], 'the writer sees their own stars');
  // Signed later, a starred post joins the page under Starred; unsigned again, it leaves, star kept.
  party.updatePost(w.id, { id: d.id, privacy: 'named' });
  assert.deepEqual(page()[0], ['Anonymous starred', true]);
  party.updatePost(w.id, { id: d.id, privacy: 'live' });
  assert.ok(!titles().includes('Anonymous starred'));
  assert.equal(party.state.posts[d.id].starred, true);
  party.setStar(w.id, { postId: a.id, starred: false });
  assert.equal(party.state.posts[a.id].starred, undefined, 'unstarred: no flag left behind');
  assert.deepEqual(page(), [['Middle signed', true], ['Newest signed', false], ['Oldest signed', false]]);

  // After the end: still the writer's to change (not an edit of the post).
  party.end(host.id);
  party.setStar(w.id, { postId: c.id, starred: true });
  assert.deepEqual(page(), [['Newest signed', true], ['Middle signed', true], ['Oldest signed', false]]);
  assert.ok(party.archiveView().posts.some((x) => x.title === 'Separate starred'), 'the separate post is in the anthology...');
  assert.ok(!titles().includes('Separate starred'), '...but never on the page');
});

test('stars: no public payload but the personal page carries them (live, post pages, the archive, the list, the export)', () => {
  const { party, clock, host } = setup();
  const w = addUser(party, 'wren', 'Wren Hollow');
  party.join(w.id);
  const signed = party.newPost(w.id, { title: 'Signed' });
  party.updatePost(w.id, { id: signed.id, privacy: 'named' });
  typeInto(party, clock, w, signed, 'a signed piece with a star on it', { cps: 40 });
  const anon = party.newPost(w.id, { title: 'Unsigned' });
  typeInto(party, clock, w, anon, 'an unsigned piece with a star on it', { cps: 40 });
  party.setPublicProfile(w.id, true);
  const shapes = () => ({
    live: party.liveView().posts.map((p) => Object.keys(p).sort()),
    post: Object.keys(party.publicPost(party.state.posts[signed.id].publicId)).sort(),
    list: party.writersView().writers.map((x) => Object.keys(x).sort()),
  });
  const plain = shapes();
  for (const p of [signed, anon]) party.setStar(w.id, { postId: p.id, starred: true });
  assert.deepEqual(shapes(), plain, 'the same fields as before any star');
  const check = (label) => {
    for (const [what, payload] of [['the live view', party.liveView()], ['the signed post page', party.publicPost(party.state.posts[signed.id].publicId)],
      ['the unsigned post page', party.publicPost(party.state.posts[anon.id].publicId)], ['the archive\'s pieces', party.archiveView().posts], ['the list', party.writersView()], ['the export', party.exportMarkdown(host.id)]]) {
      assert.ok(!JSON.stringify(payload).includes('starred'), `${label}: ${what} says nothing of stars`);
    }
    // The anthology may only say that starred signed pieces come first (SPEC §28b), never which.
    assert.deepEqual(Object.keys(party.archiveView()).filter((k) => /star/i.test(k)), party.phase === 'ended' ? ['starredFirst'] : []);
  };
  check('running');
  assert.deepEqual(party.writerPageView(party.userById(w.id).publicProfile.id).posts.map((p) => [p.title, p.starred]), [['Signed', true]]);
  party.end(host.id);
  check('after the end');
});

test('the anthology lists the signed pieces their writers starred first, each group in its shuffled order; unsigned stars never move a piece; which ones are starred is never sent', () => {
  const { party, clock, host } = setup();
  const w = addUser(party, 'wren', 'Wren Hollow');
  const v = addUser(party, 'vera', 'Vera Lind');
  party.join(w.id);
  party.join(v.id);
  const posts = [];
  for (let i = 0; i < 8; i++) {
    const owner = i % 2 ? v : w;
    const p = party.newPost(owner.id, { title: `Piece ${i}` });
    if (i % 3 === 0) party.updatePost(owner.id, { id: p.id, privacy: 'named' }); // signed and unsigned alike
    typeInto(party, clock, owner, p, `the words of piece number ${i}`, { cps: 40 });
    posts.push([owner, p]);
  }
  party.setStar(w.id, { postId: posts[0][1].id, starred: true }); // starred during the party: kept
  party.end(host.id);
  const ids = () => party.archiveView().posts.map((x) => x.id);
  party.setStar(w.id, { postId: posts[0][1].id, starred: false });
  const shuffled = ids(); // no stars: the order shuffled at the end
  assert.equal(party.archiveView().starredFirst, undefined);
  // A star on an unsigned piece never moves it: next to its writer's signed pieces it would tie
  // them together. Nothing public changes.
  let rev = party.publicRev;
  party.setStar(v.id, { postId: posts[1][1].id, starred: true });
  assert.equal(party.publicRev, rev, 'an unsigned star changes nothing public');
  assert.deepEqual(ids(), shuffled);
  assert.equal(party.archiveView().starredFirst, undefined);
  // Starred signed pieces come first, in their shuffled order; then the rest, in theirs.
  const starred = [posts[3], posts[6]]; // signed (i % 3 === 0)
  for (const [o, p] of starred) party.setStar(o.id, { postId: p.id, starred: true });
  assert.ok(party.publicRev > rev, 'a signed star reorders the anthology at once');
  const sids = new Set(starred.map(([, p]) => p.publicId));
  const got = ids();
  assert.deepEqual(got.slice(0, 2), shuffled.filter((id) => sids.has(id)), 'starred signed pieces first, in their shuffled order');
  assert.deepEqual(got.slice(2), shuffled.filter((id) => !sids.has(id)), 'then the rest (the starred unsigned one too), in theirs');
  const view = party.archiveView();
  assert.equal(view.starredFirst, true, 'the page can say so');
  for (const row of view.posts) assert.deepEqual(Object.keys(row).filter((k) => /star/i.test(k)), [], 'no star on any piece');
  assert.doesNotMatch(JSON.stringify(view.posts), /star/i);
  assert.deepEqual(Object.keys(view).filter((k) => /star/i.test(k)), ['starredFirst']);
  for (const [, p] of posts) assert.doesNotMatch(JSON.stringify(party.publicPost(p.publicId)), /star/i, 'nor on its page');
  // A star taken off: back among the rest, in its place.
  rev = party.publicRev;
  party.setStar(v.id, { postId: posts[3][1].id, starred: false });
  assert.ok(party.publicRev > rev);
  sids.delete(posts[3][1].publicId);
  assert.deepEqual(ids(), [...shuffled.filter((id) => sids.has(id)), ...shuffled.filter((id) => !sids.has(id))]);
  // Every piece starred: only the signed ones lead.
  for (const [o, p] of posts) party.setStar(o.id, { postId: p.id, starred: true });
  const signed = new Set([posts[0], posts[3], posts[6]].map(([, p]) => p.publicId));
  assert.deepEqual(ids(), [...shuffled.filter((id) => signed.has(id)), ...shuffled.filter((id) => !signed.has(id))]);
  assert.equal(party.archiveView().starredFirst, true);
});

test('HTTP: POST /api/me/star: signed in, the header, your own posts; the page follows at once, the stream never mentions it', async () => {
  const { base, app: a, close } = await app();
  try {
    const host = await signUp(base, 'host', 'Hostess');
    const wren = await signUp(base, 'wren', 'Wren Hollow');
    const otto = await signUp(base, 'otto', 'Otto Lind');
    await host.c.post('/api/admin/start');
    await wren.c.post('/api/join');
    const mk = async (title, privacy) => {
      const np = (await wren.c.post('/api/post/new', { title })).json.post;
      if (privacy !== 'live') await wren.c.post('/api/post/update', { id: np.id, privacy });
      await wren.c.post('/api/ops', { postId: np.id, pane: 'body', baseVersion: 0, seq: `s-${np.id}`, sentAt: Date.now(), ops: [{ at: Date.now(), pos: 0, del: 0, ins: `The words of ${title.toLowerCase()} on the page.` }] });
      return np;
    };
    const first = await mk('First signed', 'named');
    a.party.state.posts[first.id].createdAt -= 60_000; // older
    const second = await mk('Second signed', 'named');
    const hidden = await mk('Unsigned', 'live');
    const pid = (await wren.c.post('/api/me/account', { publicProfile: true })).json.publicProfile.id;
    const order = async () => (await client(base).get(`/api/w/${pid}`)).json.posts.map((p) => [p.title, p.starred]);
    assert.deepEqual(await order(), [['Second signed', false], ['First signed', false]]);

    assert.equal((await client(base).post('/api/me/star', { postId: first.id, starred: true })).status, 401, 'signed out');
    assert.equal((await wren.c.post('/api/me/star', { postId: first.id, starred: true }, { headers: { 'X-WH': '0' } })).status, 403, 'no header');
    for (const who of [otto, host]) {
      const r = await who.c.post('/api/me/star', { postId: first.id, starred: true });
      assert.equal(r.status, 404, `${who.id}: not their post`);
    }
    assert.equal((await host.c.post('/api/host/star', { postId: first.id, starred: true })).status, 404, 'no host route');
    assert.equal((await wren.c.post('/api/me/star', { postId: first.id, starred: 1 })).status, 400);

    await client(base).get(`/api/w/${pid}`); // warm the cache
    const r = await wren.c.post('/api/me/star', { postId: first.id, starred: true });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { ok: true, starred: true, listed: true, page: pid });
    assert.deepEqual(await order(), [['First signed', true], ['Second signed', false]], 'at once');
    const me = await wren.c.get('/api/me');
    assert.equal(me.json.posts.find((p) => p.id === first.id).starred, true, 'the writer’s own view knows');
    assert.equal((await wren.c.post('/api/me/star', { publicId: a.party.state.posts[second.id].publicId, starred: true })).status, 200, 'by public id, from the page');
    assert.equal((await wren.c.post('/api/me/star', { postId: hidden.id, starred: true })).json.starred, true);

    // Nothing public but the page mentions stars: the live page and its stream, post pages, the list.
    const events = await readSse(`${base}/api/live/events?v=2`, { ms: 400 });
    assert.ok(events.length && !events.some((x) => x.raw.includes('starred')), 'the live stream');
    for (const path of ['/api/live', `/api/p/${a.party.state.posts[first.id].publicId}`, `/api/p/${a.party.state.posts[hidden.id].publicId}`, '/api/writers']) {
      const res = await client(base).get(path);
      assert.equal(res.status, 200, path);
      assert.ok(!res.text.includes('starred'), `${path} says nothing of stars`);
    }
    // After the end: still allowed, still only on the page.
    assert.equal((await host.c.post('/api/admin/end')).status, 200);
    assert.equal((await wren.c.post('/api/me/star', { postId: first.id, starred: false })).status, 200, 'after the end');
    assert.deepEqual(await order(), [['Second signed', true], ['First signed', false]]);
    // The anthology lists the starred signed piece first (the starred unsigned one stays among the
    // rest: moving it would tie it to its writer) and says so, but no piece carries a star (SPEC §28b).
    const arch = (await client(base).get('/api/archive')).json;
    assert.equal(arch.posts[0].title, 'Second signed', 'the anthology: the starred signed piece first');
    assert.deepEqual(arch.posts.slice(1).map((x) => x.title).sort(), ['First signed', 'Unsigned'], 'then the rest');
    assert.equal(arch.starredFirst, true);
    assert.doesNotMatch(JSON.stringify(arch.posts), /star/i, 'the anthology: no star on any piece');
  } finally {
    await close();
  }
});

test('a writer stars their signed, unsigned and separate pieces: only the signed one moves, so the others stay untied to them', () => {
  const { party, clock, host } = setup();
  const x = addUser(party, 'xena', 'Xena Star');
  const z = addUser(party, 'zed', 'Zed Other');
  party.join(x.id);
  party.join(z.id);
  const mk = (owner, title, privacy) => {
    const p = party.newPost(owner.id, { title });
    if (privacy !== 'live') party.updatePost(owner.id, { id: p.id, privacy });
    typeInto(party, clock, owner, p, `the words of ${title}`, { cps: 40 });
    return p;
  };
  const sig = mk(x, 'X signed', 'named');
  const uns = mk(x, 'X unsigned', 'live');
  const sep = mk(x, 'X separate', 'separate');
  for (let i = 0; i < 4; i++) mk(z, `Z ${i}`, 'live');
  party.end(host.id);
  const before = party.archiveView().posts.map((r) => r.title);
  assert.ok(before.includes('X separate') && before.includes('X unsigned'));
  for (const p of [sig, uns, sep]) party.setStar(x.id, { postId: p.id, starred: true });
  const after = party.archiveView().posts.map((r) => r.title);
  assert.equal(after[0], 'X signed');
  assert.deepEqual(after.slice(1), before.filter((t) => t !== 'X signed'), 'the unsigned and separate pieces keep their places');
});
