// SPEC §26: a private post is never published, anywhere, at any time. It still counts for the
// challenge, its text stays out of the cross-writer comparison and the paste check, and hosts
// read it where they read every other post.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeParty, addUser, typeInto, pasteInto, startApp, client, readSse, sleep } from './helpers.js';
import { realProse, wordValue, MIN, SEC } from './sim.js';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.01, `${msg || 'value'}: ${a} vs ${b}`);
// `needles`: [[what, text]]; none may appear anywhere in the payload.
function assertAbsent(label, payload, needles) {
  const flat = JSON.stringify(payload);
  for (const [what, needle] of needles) assert.ok(!flat.includes(needle), `${label} contains the private post's ${what}`);
}
function setup(settings = {}) {
  const { party, clock } = makeParty({ settings });
  const host = addUser(party, 'host');
  party.start(host.id);
  return { party, clock, host };
}

test('private is a per-post choice that no public view shows, at any time; hosts still read the post', () => {
  const { party, clock, host } = setup({ settleSec: 2, settleQuantumSec: 1 });
  const w = addUser(party, 'wren', 'Wren Hollow');
  party.join(w.id);
  const open = party.newPost(w.id, { title: 'An open window' });
  const priv = party.newPost(w.id, { title: 'Lantern ledger' });
  assert.equal(priv.privacy, 'live', 'new posts still start public');
  assert.equal(party.updatePost(w.id, { id: priv.id, privacy: 'private' }).privacy, 'private');
  assert.throws(() => party.updatePost(w.id, { id: priv.id, privacy: 'secret' }), /privacy/);
  typeInto(party, clock, w, open, 'the harbour lights went out one by one', { cps: 50 });
  typeInto(party, clock, w, priv, 'a mothwing confession that nobody else should ever read', { cps: 50 });
  typeInto(party, clock, w, priv, 'planning the confession', { pane: 'notes', cps: 50 });
  clock.advance(10 * SEC);
  const needles = [['title', 'Lantern ledger'], ['text', 'mothwing'], ['public id', priv.publicId], ['post id', priv.id]];

  const live = party.liveView();
  assert.deepEqual(live.posts.map((p) => p.title), ['An open window']);
  assert.equal(live.counters.posts, 1);
  assertAbsent('the live view', live, needles);
  assert.throws(() => party.publicPost(priv.publicId), (e) => e.status === 404, 'no post page');
  assert.equal(party.meView(w.id).posts.find((p) => p.id === priv.id).publicId, null, 'the writer is given no public address');
  assert.doesNotMatch(party.exportMarkdown(host.id), /Lantern ledger|mothwing/, 'not among the published posts');

  // Hosts read it where they read every post: the writer's drawer and the all-data export.
  const drawer = () => party.hostWriter(host.id, w.id).posts.find((p) => p.id === priv.id);
  assert.equal(drawer().privacy, 'private');
  assert.match(drawer().body, /mothwing confession/);
  assert.match(drawer().notes, /planning the confession/);
  assert.ok(party.exportJson(host.id).posts.some((p) => p.id === priv.id && /mothwing/.test(p.body)));

  // After the end: the anthology, post pages and the export still leave it out.
  party.end(host.id);
  const archive = party.archiveView();
  assert.deepEqual(archive.posts.map((p) => p.title), ['An open window']);
  assert.equal(archive.counters.posts, 1);
  assertAbsent('the archive', archive, needles);
  assertAbsent('the live view after the end', party.liveView(), needles);
  assert.throws(() => party.publicPost(priv.publicId), (e) => e.status === 404, 'no post page after the end');
  assert.doesNotMatch(party.exportMarkdown(host.id), /Lantern ledger|mothwing/);
  assert.equal(party.meView(w.id).posts.find((p) => p.id === priv.id).publicId, null);
  assert.match(drawer().body, /mothwing/, 'hosts still read it after the end');
  assert.throws(() => party.updatePost(w.id, { id: priv.id, privacy: 'live' }), (e) => e.status === 400 && e.extra?.code === 'reason', 'publishing it after the end needs a reason (SPEC §30)');
  assert.equal(party.publicPosts().length, 1);
});

test('after the end a privacy change needs a reason: private takes a post out of the anthology, its page and the export at once; titles and closing stay locked', () => {
  const { party, clock, host } = setup();
  const w = addUser(party, 'wren');
  party.join(w.id);
  const live = party.newPost(w.id, { title: 'Regretted' });
  const named = party.newPost(w.id, { title: 'Signed regret' });
  const sep = party.newPost(w.id, { title: 'Separate regret' });
  const keep = party.newPost(w.id, { title: 'Kept' });
  party.updatePost(w.id, { id: named.id, privacy: 'named' });
  party.updatePost(w.id, { id: sep.id, privacy: 'separate' });
  for (const p of [live, named, sep, keep]) typeInto(party, clock, w, p, `the words of ${p.title.toLowerCase()} here`, { cps: 20 });
  clock.advance(2 * MIN); // the words settle before the end
  party.end(host.id);
  const titles = () => party.archiveView().posts.map((p) => p.title).sort();
  assert.deepEqual(titles(), ['Kept', 'Regretted', 'Separate regret', 'Signed regret']);
  const published = [live, named, sep].map((p) => p.publicId);
  for (const id of published) assert.ok(party.publicPost(id).title, 'published before');
  const rev = party.publicRev;
  const reason = (e) => e.status === 400 && e.extra?.code === 'reason';
  assert.throws(() => party.updatePost(w.id, { id: live.id, privacy: 'private' }), reason, 'no reason, no change (SPEC §30)');
  assert.throws(() => party.updatePost(w.id, { id: live.id, privacy: 'private', reason: ' o ' }), reason, 'a reason has a few characters');
  assert.equal(live.privacy, 'live');
  for (const p of [live, named, sep]) assert.equal(party.updatePost(w.id, { id: p.id, privacy: 'private', reason: 'too personal' }).privacy, 'private');
  assert.ok(party.publicRev > rev, 'a public change: the archive and post-page caches rebuild at once');
  assert.deepEqual(titles(), ['Kept']);
  assert.equal(party.archiveView().counters.posts, 1);
  for (const id of published) assert.throws(() => party.publicPost(id), (e) => e.status === 404, 'its page is gone');
  assert.doesNotMatch(party.exportMarkdown(host.id), /regret/i);
  assert.ok(party.meView(w.id).posts.filter((p) => p.privacy === 'private').every((p) => p.publicId === null));
  // The way back needs its own reason, like any privacy change after the end.
  assert.throws(() => party.updatePost(w.id, { id: live.id, privacy: 'live' }), reason, 'private → live');
  assert.throws(() => party.updatePost(w.id, { id: keep.id, privacy: 'named' }), reason, 'live → named');
  // Closing never changes after the end. A new title needs no reason (SPEC §30), but nothing
  // rides along with a privacy change that has none.
  const ended = (e) => e.status === 409 && e.extra?.code === 'ended';
  assert.throws(() => party.updatePost(w.id, { id: keep.id, closed: true }), ended, 'closing');
  assert.throws(() => party.updatePost(w.id, { id: keep.id, privacy: 'private', title: 'Renamed' }), reason, 'nothing rides along with private');
  assert.equal(keep.title, 'Kept');
  assert.equal(keep.privacy, 'live');
  assert.equal(live.privacy, 'private');
  assert.deepEqual(titles(), ['Kept']);
  assert.equal(party.updatePost(w.id, { id: live.id, privacy: 'private' }).privacy, 'private', 'asking again is harmless');
  // With a reason, a private post comes back to the anthology (usual rules), and hosts see why.
  assert.equal(party.updatePost(w.id, { id: sep.id, privacy: 'named', reason: 'proud of it after all' }).privacy, 'named');
  assert.deepEqual(titles(), ['Kept', 'Separate regret']);
  assert.equal(party.archiveView().posts.find((p) => p.title === 'Separate regret').name, 'WREN');
  const hist = party.hostWriter(host.id, w.id).posts.find((p) => p.id === sep.id).after;
  assert.deepEqual(hist.map((e) => [e.kind, e.from, e.to, e.reason]), [['privacy', 'separate', 'private', 'too personal'], ['privacy', 'private', 'named', 'proud of it after all']]);
  assert.ok(party.state.log.some((l) => l.type === 'after-privacy' && /proud of it after all/.test(l.text)), 'the host log has the reason');
  assert.doesNotMatch(JSON.stringify([party.archiveView(), party.liveView()]), /too personal|proud of it/, 'reasons never go public');
  // It still counts, and hosts still read it.
  assert.ok(party.scoreOf(w.id, { fresh: true }).totals.credit > 0);
  assert.match(party.hostWriter(host.id, w.id).posts.find((p) => p.id === live.id).body, /regretted/);
});

test('switching: live → private leaves the public views at once, back to public publishes it from then on; the public id stays unsigned', () => {
  const { party, clock } = setup();
  const w = addUser(party, 'wren');
  party.join(w.id);
  const p = party.newPost(w.id, { title: 'Second thoughts' });
  typeInto(party, clock, w, p, 'words the writer later keeps to herself', { cps: 20 });
  const id = p.publicId;
  const titles = () => party.liveView().posts.map((x) => x.title);
  assert.deepEqual(titles(), ['Second thoughts']);
  const rev = party.publicRev;
  party.updatePost(w.id, { id: p.id, privacy: 'private' });
  assert.ok(party.publicRev > rev, 'a public change: the live and archive caches rebuild at once');
  assert.deepEqual(titles(), []);
  assert.equal(party.liveView().counters.posts, 0);
  assert.throws(() => party.publicPost(id), (e) => e.status === 404);
  assert.equal(p.publicId, id, 'live and private share the unsigned id');
  party.updatePost(w.id, { id: p.id, privacy: 'live' });
  assert.deepEqual(titles(), ['Second thoughts']);
  assert.equal(party.publicPost(id).title, 'Second thoughts');
  // Signed or separate versions never share an id with the private one.
  party.updatePost(w.id, { id: p.id, privacy: 'private' });
  party.updatePost(w.id, { id: p.id, privacy: 'named' });
  const named = p.publicId;
  assert.notEqual(named, id);
  party.updatePost(w.id, { id: p.id, privacy: 'private' });
  assert.notEqual(p.publicId, named);
  const priv = p.publicId;
  party.updatePost(w.id, { id: p.id, privacy: 'separate' });
  assert.notEqual(p.publicId, priv);
});

test('a private post counts for the challenge like any other writing, and a switch changes no score', () => {
  const { party, clock, host } = setup({ hourLengthMin: 10, targetPerHour: 20 });
  const w = addUser(party, 'ana');
  party.join(w.id);
  const p = party.newPost(w.id, {});
  party.updatePost(w.id, { id: p.id, privacy: 'private' });
  const text = realProse(25, 300);
  typeInto(party, clock, w, p, text, { cps: 6 });
  clock.advance(2 * MIN);
  near(party.scoreOf(w.id, { fresh: true }).totals.credit, wordValue(text), 'credit');
  near(party.meView(w.id).progress.totals.credit, wordValue(text), 'the writer’s own total');
  // A second post typed live and then made private keeps its credit, re-score included.
  const q = party.newPost(w.id, {});
  const more = realProse(25, 600);
  typeInto(party, clock, w, q, more, { cps: 6 });
  clock.advance(2 * MIN);
  const before = party.scoreOf(w.id, { fresh: true }).totals.credit;
  near(before, wordValue(text) + wordValue(more), 'both posts');
  party.updatePost(w.id, { id: q.id, privacy: 'private' });
  near(party.scoreOf(w.id, { fresh: true }).totals.credit, before, 'after the switch');
  party.rebuildEngine({ sync: true });
  near(party.scoreOf(w.id, { fresh: true }).totals.credit, before, 'after a full re-score');
  // The hour is judged on it like any other.
  clock.set(w.joinedAt + 10 * MIN + 2 * MIN);
  party.tick();
  assert.equal(party.progressOf(w.id, { fresh: true }).prog.hours[0].status, 'met');
  assert.equal(party.hostView(host.id).writers.find((x) => x.id === w.id).progress.hours[0].status, 'met');
});

test('writing in a private post never moves the public word totals; the host’s totals include it', () => {
  const { party, clock, host } = setup();
  const w = addUser(party, 'wren');
  party.join(w.id);
  const open = party.newPost(w.id, {});
  const priv = party.newPost(w.id, {});
  party.updatePost(w.id, { id: priv.id, privacy: 'private' });
  const pub = () => party.liveView().party.totals.wordsToday;
  const all = () => party.hostView(host.id).party.totals.wordsToday;
  typeInto(party, clock, w, open, 'one two three four five', { cps: 20 });
  assert.equal(pub(), 5);
  typeInto(party, clock, w, priv, 'six seven eight nine ten eleven twelve', { cps: 20 });
  assert.equal(pub(), 5, 'private words don’t move the public total');
  assert.equal(all(), 12, 'the host’s total has every post');
  // Published from then on when it goes public; out again at once when it goes back.
  party.updatePost(w.id, { id: priv.id, privacy: 'named' });
  assert.equal(pub(), 12);
  party.updatePost(w.id, { id: priv.id, privacy: 'private' });
  assert.equal(pub(), 5);
  typeInto(party, clock, w, priv, ' thirteen fourteen', { cps: 20 });
  assert.equal(pub(), 5);
  assert.equal(all(), 14);
  party.end(host.id);
  assert.equal(party.liveView().party.totals.wordsToday, 5, 'after the end too');
  assert.equal(party.archiveView().counters.words, 5);
});

test('private text stays out of the cross-writer comparison and the paste check', async () => {
  const { party, clock, host } = setup({ settleSec: 2, settleQuantumSec: 1 });
  const alice = addUser(party, 'alice');
  const bob = addUser(party, 'bob');
  party.join(alice.id);
  party.join(bob.id);
  const secret = 'a private letter about the lighthouse keeper and his violin collection';
  const open = 'the harbour lights went out one by one while the ferry waited for nobody';
  const ap = party.newPost(alice.id, {});
  party.updatePost(alice.id, { id: ap.id, privacy: 'private' });
  const al = party.newPost(alice.id, {});
  typeInto(party, clock, alice, ap, secret, { cps: 50 });
  typeInto(party, clock, alice, al, open, { cps: 50 });
  clock.advance(10 * SEC); // everything settles
  assert.equal(party.isSharedText(ap.id, 'body'), false);
  assert.equal(party.isSharedText(al.id, 'body'), true);
  assert.ok(!party.pasteCheck(bob.id, secret).other.includes('1'), 'the paste check never reveals private text');
  assert.ok(party.pasteCheck(bob.id, open).other.includes('1'), 'public text still shows as another writer’s');
  // A guess at it, typed or pasted, isn't reported as another writer's text either.
  const bp = party.newPost(bob.id, {});
  typeInto(party, clock, bob, bp, secret, { cps: 50 });
  pasteInto(party, bob, bp, ` ${secret}`, 'all');
  clock.advance(10 * SEC);
  assert.equal(party.meView(bob.id).progress.totals.nc.otherWriter, 0);
  // A post made private leaves the paste check at once.
  party.updatePost(alice.id, { id: al.id, privacy: 'private' });
  assert.ok(!party.pasteCheck(bob.id, open).other.includes('1'));
  // The settings preview replays with the same rule.
  let job = null;
  party.previewer = (j) => {
    job = j;
    return Promise.resolve({ changes: [], ms: 0 });
  };
  await party.previewSettings(host.id, { patch: {} });
  assert.ok(job.privatePosts.includes(ap.id) && job.privatePosts.includes(al.id));
});

test('hosts read a private post when they check hours: the review queue shows its flagged text', () => {
  const { party, clock, host } = setup({ hourLengthMin: 10, targetPerHour: 150 });
  const w = addUser(party, 'ana', 'Ana');
  party.join(w.id);
  const p = party.newPost(w.id, { title: 'Kept to myself' });
  party.updatePost(w.id, { id: p.id, privacy: 'private' });
  const big = realProse(190, 0); // pasted and claimed: the hour needs 150 of them, so it goes to review
  pasteInto(party, w, p, big, 'all');
  clock.set(w.joinedAt + 10 * MIN + 2 * MIN);
  party.tick();
  const hv = party.hostView(host.id);
  assert.equal(hv.reviews.length, 1);
  assert.ok(hv.reviews[0].evidence.some((e) => e.kind === 'paste' && e.text.startsWith(big.slice(0, 30))));
  assert.equal(party.liveView().posts.length, 0, 'still nowhere public');
});

test('over HTTP: a private post is never in /api/live, the stream, /api/p, the archive or export.md; a switch takes a post off at once', async (t) => {
  const { app, base, close } = await startApp({ liveMs: 100 });
  t.after(close);
  const host = client(base);
  await host.post('/api/register', { username: 'hostuser', password: 'longpassword', name: 'Hosting Person' });
  await host.post('/api/admin/start', {});
  const w = client(base);
  const reg = await w.post('/api/register', { username: 'wrenuser', password: 'longpassword', name: 'Wren Writer' });
  await w.post('/api/join', {});
  const make = async (title, privacy, body) => {
    const p = (await w.post('/api/post/new', { title })).json.post;
    if (privacy !== 'live') {
      const r = await w.post('/api/post/update', { id: p.id, privacy });
      assert.equal(r.status, 200);
      assert.equal(r.json.post.privacy, privacy);
    }
    const r = await w.post('/api/ops', { postId: p.id, pane: 'body', baseVersion: 0, seq: `s-${p.id}`, sentAt: Date.now(), ops: [{ at: Date.now(), pos: 0, del: 0, ins: body }] });
    assert.equal(r.status, 200);
    return { ...p, publicId: app.party.state.posts[p.id].publicId };
  };
  assert.equal((await w.post('/api/post/update', { id: 'nope', privacy: 'private' })).status, 404);
  const anon = client(base);
  const streamP = readSse(`${base}/api/live/events`, { ms: 2500 });
  await sleep(200);
  const open = await make('Open window', 'live', 'Streaming words anyone may read.');
  const priv = await make('Lantern ledger', 'private', 'PRIVATE mothwing text that nobody else reads.');
  const moving = await make('Second thoughts', 'live', 'Words the writer later keeps to herself.');
  const needles = [['title', 'Lantern ledger'], ['text', 'mothwing'], ['public id', priv.publicId], ['post id', priv.id]];
  const titles = async () => (await anon.get('/api/live')).json.posts.map((p) => p.title).sort();
  assert.deepEqual(await titles(), ['Open window', 'Second thoughts']);
  assertAbsent('/api/live', (await anon.get('/api/live')).json, needles);
  assert.equal((await anon.get(`/api/p/${priv.publicId}`)).status, 404);
  assert.equal((await anon.get(`/api/p/${moving.publicId}`)).status, 200);
  await sleep(400); // the stream carries the moving post first

  // Live → private: gone from /api/live and its post page in the very next request.
  assert.equal((await w.post('/api/post/update', { id: moving.id, privacy: 'private' })).status, 200);
  assert.deepEqual(await titles(), ['Open window']);
  assert.equal((await anon.get(`/api/p/${moving.publicId}`)).status, 404);
  assert.equal((await anon.get('/api/live')).json.counters.posts, 1);
  await sleep(400);
  // Back to live: published again from then on, under the same unsigned id.
  assert.equal((await w.post('/api/post/update', { id: moving.id, privacy: 'live' })).status, 200);
  assert.deepEqual(await titles(), ['Open window', 'Second thoughts']);
  assert.equal((await anon.get(`/api/p/${moving.publicId}`)).json.title, 'Second thoughts');
  const stream = await streamP;
  assert.ok(stream.some((e) => e.event === 'post' && e.data.id === moving.publicId), 'the stream showed the post');
  const removed = stream.findIndex((e) => e.event === 'remove' && e.data.id === moving.publicId);
  assert.ok(removed >= 0, 'the stream removed the post when it became private');
  assert.ok(stream.slice(removed).some((e) => e.event === 'post' && e.data.id === moving.publicId && e.data.text), 'and sent it again when it went back to live');
  assertAbsent('the live stream', stream.map((e) => e.data), needles);

  // Hosts read it in the drawer; the all-data export has it, the published-posts export doesn't.
  const drawer = (await host.get(`/api/admin/writer?id=${reg.json.user.id}`)).json;
  const row = drawer.posts.find((p) => p.id === priv.id);
  assert.equal(row.privacy, 'private');
  assert.match(row.body, /mothwing/);
  assert.match((await host.get('/api/admin/export.json')).text, /mothwing/);
  assert.doesNotMatch((await host.get('/api/admin/export.md')).text, /Lantern ledger|mothwing/);

  // After the end: not in the anthology, no post page, not in the published-posts export.
  await host.post('/api/admin/end', {});
  const archive = (await anon.get('/api/archive')).json;
  assert.deepEqual(archive.posts.map((p) => p.title).sort(), ['Open window', 'Second thoughts']);
  assertAbsent('/api/archive after the end', archive, needles);
  assert.equal((await anon.get(`/api/p/${priv.publicId}`)).status, 404);
  assertAbsent('/api/live after the end', (await anon.get('/api/live')).json, needles);
  assert.doesNotMatch((await host.get('/api/admin/export.md')).text, /Lantern ledger|mothwing/);
  assert.match((await host.get(`/api/admin/writer?id=${reg.json.user.id}`)).json.posts.find((p) => p.id === priv.id).body, /mothwing/);

  // Still after the end: live → private takes a published post out of the archive, its page and
  // export.md in the very next request; private → live is refused.
  assert.match((await host.get('/api/admin/export.md')).text, /Open window/);
  assert.equal((await w.post('/api/post/update', { id: open.id, privacy: 'private' })).json.code, 'reason', 'a reason is asked for (SPEC §30)');
  const r = await w.post('/api/post/update', { id: open.id, privacy: 'private', reason: 'changed my mind' });
  assert.equal(r.status, 200);
  assert.equal(r.json.post.privacy, 'private');
  assert.deepEqual((await anon.get('/api/archive')).json.posts.map((p) => p.title), ['Second thoughts']);
  assert.equal((await anon.get(`/api/p/${open.publicId}`)).status, 404);
  assert.doesNotMatch((await host.get('/api/admin/export.md')).text, /Open window|Streaming words/);
  const back = await w.post('/api/post/update', { id: open.id, privacy: 'live' });
  assert.equal(back.status, 400, 'private → live without a reason');
  assert.equal(back.json.code, 'reason');
  // A new title needs no reason after the end (SPEC §30): the anthology shows it at once.
  assert.equal((await w.post('/api/post/update', { id: moving.id, title: 'Renamed' })).status, 200, 'a title needs no reason');
  assert.deepEqual((await anon.get('/api/archive')).json.posts.map((p) => p.title), ['Renamed']);
  assert.equal((await anon.get(`/api/p/${open.publicId}`)).status, 404);
});
