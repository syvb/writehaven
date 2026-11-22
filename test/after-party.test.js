// SPEC §30: after the party ends, posts stay editable with no reason asked: the first change opens
// a quiet edit session, changes save as they come and never count for the challenge, and the
// public page says "Edited after the party". One change that takes 50 or more words out at once
// needs a short reason, which the hosts see (a reason covers the rest of its session); so does a
// privacy change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeParty, addUser, typeInto, pasteInto, startApp, client, sleep } from './helpers.js';
import { realProse, MIN } from './sim.js';
import { wordsRemoved, cutsIn, countWords, BIG_CUT_WORDS } from '../public/js/text.js';

function setup(settings = {}) {
  const { party, clock } = makeParty({ settings: { hourLengthMin: 10, targetPerHour: 20, ...settings } });
  const host = addUser(party, 'host');
  party.start(host.id);
  return { party, clock, host };
}
// Everything scoring says about a writer: totals, every hour that holds anything (credit, flags)
// and each hour's status. (The scorer lists empty hours up to "now", so those are left out.)
function scoreOf(party, uid) {
  const r = party.scoreOf(uid, { fresh: true });
  const prog = party.progressOf(uid, { fresh: true }).prog;
  return JSON.stringify({
    totals: r.totals,
    hours: r.hours.map((h, k) => ({ k, credit: h.credit, flags: h.flags })).filter((h) => h.credit || h.flags.length),
    progress: prog.hours.map((h) => [h.k, h.status, h.credited, h.target]),
    met: prog.met, missed: prog.missed,
  });
}
let n = 0;
const batch = (p, pane, ops) => ({ postId: p.id, pane, baseVersion: p.ver[pane], seq: `t${++n}`, ops });
// n distinct words: "tag1 tag2 …".
const words = (count, tag) => Array.from({ length: count }, (_, i) => `${tag}${i + 1}`).join(' ');
const history = (party, host, w, p) => party.hostWriter(host.id, w.id).posts.find((x) => x.id === p.id).after.map((e) => [e.kind, e.reason ?? null, e.words ?? null]);
const session = (party, w, p) => {
  const m = party.meView(w.id).posts.find((x) => x.id === p.id);
  return [m.editing, m.reasoned];
};

test('the words a cut takes out: counted as the post counts them; moves and text put back take none out', () => {
  assert.equal(BIG_CUT_WORDS, 50);
  const t = 'one two three four five';
  assert.equal(wordsRemoved(t, 4, 4), 1, 'a whole word');
  assert.equal(wordsRemoved(t, 0, t.length), 5);
  assert.equal(wordsRemoved(t, 5, 1), 0, 'a word cut short is still a word');
  assert.equal(wordsRemoved(t, 3, 1), 1, 'two words joined become one');
  assert.equal(wordsRemoved('a [^1] — b', 2, 7), 0, 'markers and dashes are no words');
  const big = `${words(60, 'w')}\n\n${words(10, 'x')}`;
  const para = words(60, 'w');
  assert.deepEqual(cutsIn(big, [{ pos: 0, del: para.length + 2, ins: '' }]), [60], 'a deleted paragraph');
  assert.deepEqual(cutsIn(big, [{ pos: 0, del: big.length, ins: 'X' }]), [70], 'select all and retype');
  assert.deepEqual(cutsIn(big, [{ pos: 0, del: para.length, ins: words(60, 'n') }]), [60], 'a paste over it');
  assert.deepEqual(cutsIn(big, [{ pos: 0, del: para.length, ins: para }]), [0], 'replaced by itself');
  // A move (a paragraph dragged to the end; notes put in order): inserted there, deleted here.
  assert.deepEqual(cutsIn(big, [{ pos: big.length, del: 0, ins: `\n\n${para}` }, { pos: 0, del: para.length + 2, ins: '' }]), [0, 60], 'not the same text: a cut');
  assert.deepEqual(cutsIn(big, [{ pos: big.length, del: 0, ins: para }, { pos: 0, del: para.length, ins: '' }]), [0, 0], 'the same text: a move');
  assert.deepEqual(cutsIn(big, [{ pos: 0, del: para.length, ins: '' }, { pos: 12, del: 0, ins: para }]), [0, 0], 'a move the other way round');
  assert.equal(countWords(big), 70);
});

test('after the party: changes save with no reason, in a quiet session; they never count; one history line per session; "Edited after the party"', () => {
  const { party, clock, host } = setup();
  const w = addUser(party, 'wren', 'Wren');
  party.join(w.id);
  const p = party.newPost(w.id, { title: 'Harbour' });
  const before = realProse(40, 0);
  typeInto(party, clock, w, p, before, { cps: 6 });
  typeInto(party, clock, w, p, 'notes typed during the party', { pane: 'notes', cps: 6 });
  clock.advance(2 * MIN); // everything settles
  party.end(host.id);
  clock.advance(5 * MIN); // the last hour's status is final ("partial")
  party.tick();
  const score = scoreOf(party, w.id);
  const judged = JSON.stringify(w.judged || null);
  assert.deepEqual(session(party, w, p), [false, false], 'no session until something changes');
  assert.equal(party.publicPost(p.publicId).edited, undefined);

  // No reason, no step first: edits, a cut of a few words, notes, a new title.
  const added = ` ${realProse(80, 400)}`;
  party.applyOps(w.id, batch(p, 'body', [{ pos: p.body.length, del: 0, ins: added }]));
  assert.deepEqual(session(party, w, p), [true, false], 'a quiet session');
  assert.equal(party.postsWithText(w.id)[0].editing, true);
  party.applyOps(w.id, batch(p, 'body', [{ pos: 0, del: before.indexOf(' ') + 1, ins: '' }]));
  party.applyOps(w.id, batch(p, 'notes', [{ pos: 0, del: 6, ins: 'edited ' }]));
  party.updatePost(w.id, { id: p.id, title: 'Harbour lights' });
  const text = before.slice(before.indexOf(' ') + 1) + added;
  assert.equal(p.body, text);
  assert.equal(p.title, 'Harbour lights');
  assert.equal(p.notes, 'edited typed during the party');
  clock.advance(5 * MIN);
  party.tick();
  assert.equal(scoreOf(party, w.id), score, 'no credit, no cut credit, no flags, no hour changes');
  assert.equal(JSON.stringify(w.judged || null), judged, 'judged hours stay as they were');
  assert.ok(party.state.alerts.every((a) => a.userId !== w.id), 'nothing raised for the host');
  party.rebuildEngine({ sync: true });
  assert.equal(scoreOf(party, w.id), score, 'a full re-score agrees');
  assert.equal(party.state.ops[w.id].filter((o) => o[6]?.e).length, 3, 'the edits are in the op log, marked');

  // Public: the new text and title, with the note.
  const page = party.publicPost(p.publicId);
  assert.equal(page.text, text);
  assert.equal(page.title, 'Harbour lights');
  assert.equal(page.edited, true);
  assert.equal(party.archiveView().posts[0].edited, true);
  // Hosts: one line for the session, with no reason; the same in the log.
  assert.deepEqual(history(party, host, w, p), [['edit', null, null]]);
  assert.equal(party.state.log.filter((l) => l.type === 'after-edit' && l.userId === w.id).length, 1);
  assert.ok(party.state.log.some((l) => l.type === 'after-edit' && l.text === 'edited “Harbour” after the party'));

  // 30 minutes without a change close the session; the next change opens a new quiet one.
  clock.advance(31 * MIN);
  assert.deepEqual(session(party, w, p), [false, false]);
  party.applyOps(w.id, batch(p, 'body', [{ pos: 0, del: 0, ins: 'So: ' }]));
  assert.deepEqual(session(party, w, p), [true, false]);
  assert.deepEqual(history(party, host, w, p), [['edit', null, null], ['edit', null, null]]);
  // Work typed offline before the end that arrives now goes in too (the pane was edited after the
  // end, so as an edit after the party, stamped now and never scored).
  const end = party.state.party.endedAt;
  party.applyOps(w.id, { ...batch(p, 'body', [{ at: end - MIN, pos: 0, del: 0, ins: 'offline ' }]), sentAt: end - MIN + 500 });
  assert.ok(p.body.startsWith('offline So: '));
  assert.equal(scoreOf(party, w.id), score);
  // Closing a post still isn't a change after the end.
  assert.throws(() => party.updatePost(w.id, { id: p.id, closed: true }), (e) => e.status === 409 && e.extra.code === 'ended');
});

test('after the party, a change that removes 50+ words goes in with no reason; hosts see it in the post’s history; a reason an older page sends is kept for them, never public', () => {
  const { party, clock, host } = setup();
  const w = addUser(party, 'wren', 'Wren');
  party.join(w.id);
  const p = party.newPost(w.id, { title: 'Harbour' });
  const A = words(60, 'alpha');
  const B = words(49, 'beta');
  const C = words(60, 'gamma');
  const D = words(70, 'delta');
  pasteInto(party, w, p, [A, B, C, D].join('\n\n'), 'all');
  clock.advance(5 * MIN);
  party.end(host.id);
  clock.advance(5 * MIN);
  party.tick();
  const score = scoreOf(party, w.id);

  // 49 words at once: a quiet edit.
  party.applyOps(w.id, batch(p, 'body', [{ pos: A.length + 2, del: B.length + 2, ins: '' }]));
  assert.equal(p.body, [A, C, D].join('\n\n'));
  assert.deepEqual(session(party, w, p), [true, false]);
  assert.deepEqual(history(party, host, w, p), [['edit', null, null]]);
  // 60 at once: in at once, nothing asked; the hosts' history notes the cut.
  party.applyOps(w.id, batch(p, 'body', [{ pos: 0, del: A.length + 2, ins: '' }]));
  assert.equal(p.body, [C, D].join('\n\n'));
  assert.deepEqual(history(party, host, w, p), [['edit', null, null], ['cut', null, 60]]);
  assert.ok(party.state.log.some((l) => l.type === 'after-cut' && l.text === 'removed about 60 words from “Harbour” after the party'));
  // Select all and retype, and the planning notes: in too.
  party.applyOps(w.id, batch(p, 'notes', [{ pos: 0, del: 0, ins: words(55, 'note') }]));
  party.applyOps(w.id, batch(p, 'notes', [{ pos: 0, del: p.notes.length, ins: 'X' }]));
  assert.equal(p.notes, 'X');
  // A page from before reasons became optional may still send one: the session carries it and
  // the hosts see it with the next large cut.
  assert.deepEqual(party.openAfterEdit(w.id, { id: p.id, reason: 'cutting the opening' }), { editing: true, reasoned: true });
  party.applyOps(w.id, batch(p, 'body', [{ pos: 0, del: C.length + 2, ins: '' }]));
  assert.equal(p.body, D);
  assert.deepEqual(history(party, host, w, p).at(-1), ['cut', 'cutting the opening', 60]);
  // A new session after the last one closes: still nothing asked.
  clock.advance(31 * MIN);
  assert.deepEqual(session(party, w, p), [false, false]);
  party.applyOps(w.id, batch(p, 'body', [{ pos: 0, del: p.body.length, ins: 'Gone.' }]));
  assert.equal(p.body, 'Gone.');
  assert.deepEqual(session(party, w, p), [true, false]);

  // Never counted; a reason never public.
  assert.equal(scoreOf(party, w.id), score);
  party.rebuildEngine({ sync: true });
  assert.equal(scoreOf(party, w.id), score);
  assert.equal(party.publicPost(p.publicId).edited, true);
  assert.doesNotMatch(JSON.stringify([party.publicPost(p.publicId), party.archiveView(), party.liveView(), party.exportMarkdown(host.id)]), /cutting the opening/);
});

test('after the party, a privacy change needs no reason; one an older page sends is kept for the hosts', () => {
  const { party, clock, host } = setup();
  const w = addUser(party, 'wren');
  party.join(w.id);
  const p = party.newPost(w.id, { title: 'Second thoughts' });
  typeInto(party, clock, w, p, 'words written during the party', { cps: 10 });
  party.end(host.id);
  clock.advance(MIN);
  assert.equal(party.updatePost(w.id, { id: p.id, privacy: 'private' }).privacy, 'private');
  assert.equal(party.updatePost(w.id, { id: p.id, privacy: 'live', title: 'Renamed', reason: 'proud of it after all' }).privacy, 'live');
  assert.equal(p.title, 'Renamed');
  const h = history(party, host, w, p);
  assert.deepEqual(h.filter((e) => e[0] === 'privacy'), [['privacy', null, null], ['privacy', 'proud of it after all', null]]);
  assert.ok(party.state.log.some((l) => l.type === 'after-privacy' && l.text === 'changed “Second thoughts” after the party from public, no name to private'));
  assert.doesNotMatch(JSON.stringify([party.publicPost(p.publicId), party.archiveView()]), /proud of it/);
});

test('during the party nothing changes: no reason for large cuts, none asked or accepted, every change scored', () => {
  const { party, clock } = setup();
  const w = addUser(party, 'xavi');
  party.join(w.id);
  const p = party.newPost(w.id, {});
  pasteInto(party, w, p, `${words(60, 'alpha')}\n\n${words(10, 'beta')}`, 'all');
  clock.advance(MIN);
  party.applyOps(w.id, batch(p, 'body', [{ pos: 0, del: words(60, 'alpha').length + 2, ins: '' }]));
  assert.equal(p.body, words(10, 'beta'));
  assert.equal(p.after, undefined, 'no session, no history');
  assert.ok(party.state.ops[w.id].every((o) => !o[6]?.e), 'scored as usual');
  assert.deepEqual(session(party, w, p), [false, false]);
  assert.throws(() => party.openAfterEdit(w.id, { id: p.id, reason: 'why not' }), (e) => e.status === 409 && e.extra.code === 'running');
});

test('a post nobody edits after the party has no note; only the public text earns one', () => {
  const { party, clock, host } = setup();
  const w = addUser(party, 'wren');
  party.join(w.id);
  const p = party.newPost(w.id, { title: 'Untouched' });
  typeInto(party, clock, w, p, 'words written during the party', { cps: 10 });
  typeInto(party, clock, w, p, 'private planning', { pane: 'notes', cps: 10 });
  clock.advance(2 * MIN);
  party.end(host.id);
  clock.advance(MIN);
  assert.equal(party.publicPost(p.publicId).edited, undefined);
  assert.deepEqual(Object.keys(party.archiveView().posts[0]).sort(), ['excerpt', 'id', 'name', 'title', 'words']);
  // Editing only the planning notes (never public) adds no note either.
  party.applyOps(w.id, batch(p, 'notes', [{ pos: 0, del: 0, ins: 'more ' }]));
  assert.equal(party.publicPost(p.publicId).edited, undefined);
  assert.equal(p.notes, 'more private planning');
  assert.deepEqual(history(party, host, w, p), [['edit', null, null]], 'hosts still see the session');
});

test('over HTTP: edits after the party save with no reason, large cuts and privacy changes too; the note and the history, the score stays; all of it survives a restart', async (t) => {
  const open = new Set();
  t.after(async () => { for (const a of open) await a.close(); });
  const boot = async (o) => {
    const a = await startApp(o);
    open.add(a);
    const close = a.close;
    a.close = async () => { open.delete(a); await close(); };
    return a;
  };
  const first = await boot({ saveMs: 50 });
  const host = client(first.base);
  await host.post('/api/register', { username: 'hostuser', password: 'longpassword', name: 'Host' });
  await host.post('/api/admin/start', {});
  await host.post('/api/admin/settings', { scoring: { settleSec: 1, settleQuantumSec: 1 } }); // words count within a second here
  const w = client(first.base);
  const uid = (await w.post('/api/register', { username: 'wren', password: 'longpassword', name: 'Wren' })).json.user.id;
  await w.post('/api/join', {});
  const post = (await w.post('/api/post/new', { title: 'Harbour' })).json.post;
  const opening = words(55, 'alpha');
  const body = `${opening}\n\nThe harbour lights went out one by one while the ferry waited.`;
  assert.equal((await w.post('/api/ops', { postId: post.id, pane: 'body', baseVersion: 0, seq: 'a1', sentAt: Date.now(), ops: [{ at: Date.now(), pos: 0, del: 0, ins: body }] })).status, 200);
  await sleep(2500); // they settle and count
  await host.post('/api/admin/end', {});
  const publicId = first.app.party.state.posts[post.id].publicId;
  const score0 = JSON.stringify((await w.get('/api/me')).json.progress);
  const mine = async (c) => (await c.get('/api/me')).json.posts.find((p) => p.id === post.id);

  // A small edit: saved at once, no reason.
  let r = await w.post('/api/ops', { postId: post.id, pane: 'body', baseVersion: 1, seq: 'a2', sentAt: Date.now(), ops: [{ at: Date.now(), pos: body.length, del: 0, ins: ' And then.' }] });
  assert.equal(r.status, 200);
  assert.equal(r.json.version, 2);
  const m = await mine(w);
  assert.deepEqual([m.editing, m.reasoned], [true, false]);
  // A large cut: in at once, no reason asked.
  const cut = { postId: post.id, pane: 'body', baseVersion: 2, seq: 'a3', sentAt: Date.now(), ops: [{ at: Date.now(), pos: 0, del: opening.length + 2, ins: '' }] };
  r = await w.post('/api/ops', cut);
  assert.equal(r.status, 200);
  assert.equal(r.json.version, 3);
  const edited1 = `${body} And then.`;
  const edited = edited1.slice(opening.length + 2);
  const check = async (base, label) => {
    const anon = client(base);
    const page = (await anon.get(`/api/p/${publicId}`)).json;
    assert.equal(page.text, edited, label);
    assert.equal(page.edited, true, `${label}: the note`);
    const archive = (await anon.get('/api/archive')).json;
    assert.equal(archive.posts[0].edited, true, `${label}: the anthology's note`);
  };
  await check(first.base, 'first');
  const hostSees = async (c, label) => {
    const d = (await c.get(`/api/admin/writer?id=${uid}`)).json;
    assert.deepEqual(d.posts[0].after.map((e) => [e.kind, e.reason, e.words ?? null]), [['edit', null, null], ['cut', null, 55]], label);
    const log = (await c.get('/api/admin/state')).json.log;
    assert.ok(log.some((l) => l.type === 'after-edit' && /edited “Harbour” after the party/.test(l.text)), `${label}: the host log`);
    assert.ok(log.some((l) => l.type === 'after-cut' && l.text === 'removed about 55 words from “Harbour” after the party'), `${label}: the host log`);
  };
  await hostSees(host, 'first');
  assert.equal(JSON.stringify((await w.get('/api/me')).json.progress), score0, 'the score is unchanged');
  await sleep(100);
  await first.close();

  // A restart: the text, the note, the history and the open session remain.
  const second = await boot({ stateFile: first.stateFile });
  await check(second.base, 'after a restart');
  const host2 = client(second.base);
  await host2.post('/api/login', { username: 'hostuser', password: 'longpassword' });
  await hostSees(host2, 'after a restart');
  const w2 = client(second.base);
  await w2.post('/api/login', { username: 'wren', password: 'longpassword' });
  assert.equal(JSON.stringify((await w2.get('/api/me')).json.progress), score0, 'the score is unchanged after a restart');
  const m2 = await mine(w2);
  assert.deepEqual([m2.editing, m2.reasoned], [true, false], 'the session');
  assert.equal((await w2.get(`/api/post?id=${post.id}&pane=body`)).json.text, edited);
  r = await w2.post('/api/ops', { postId: post.id, pane: 'body', baseVersion: 3, seq: 'a4', sentAt: Date.now(), ops: [{ at: Date.now(), pos: 0, del: 3, ins: 'Our' }] });
  assert.equal(r.status, 200);
  // A privacy change after the end: no reason either.
  r = await w2.post('/api/post/update', { id: post.id, privacy: 'private' });
  assert.equal(r.status, 200);
  assert.equal((await client(second.base).get(`/api/p/${publicId}`)).status, 404);
  assert.deepEqual((await client(second.base).get('/api/archive')).json.posts, []);
  assert.equal(JSON.stringify((await w2.get('/api/me')).json.progress), score0);
  await second.close();
  const third = await boot({ stateFile: first.stateFile });
  const host3 = client(third.base);
  await host3.post('/api/login', { username: 'hostuser', password: 'longpassword' });
  const d = (await host3.get(`/api/admin/writer?id=${uid}`)).json.posts[0];
  assert.equal(d.body, `Our${edited.slice(3)}`, 'the text after two restarts');
  assert.deepEqual(d.after.map((e) => [e.kind, e.reason, e.from ?? null, e.to ?? null]), [['edit', null, null, null], ['cut', null, null, null], ['privacy', null, 'live', 'private']]);
  await third.close();
});

test('after the party a writer can start a new post: private until they publish it, kept out of every public view meanwhile, never counted, no reason to cut; published, it says "Added after the party"', () => {
  const { party, clock, host } = setup();
  const w = addUser(party, 'wren', 'Wren');
  const late = addUser(party, 'lou', 'Lou'); // writes nothing during the party
  party.join(w.id);
  const old = party.newPost(w.id, { title: 'Harbour' });
  typeInto(party, clock, w, old, realProse(40, 0), { cps: 6 });
  clock.advance(2 * MIN);
  party.end(host.id);
  clock.advance(5 * MIN);
  party.tick();
  const score = scoreOf(party, w.id);
  const archive0 = JSON.stringify(party.archiveView());
  const participants = party.participants();
  const words0 = party.state.party.endWords;

  const p = party.newPost(w.id, { title: 'Feedback' });
  assert.equal(p.privacy, 'private', 'private by default');
  assert.equal(party.meView(w.id).posts.find((x) => x.id === p.id).added, true);
  assert.equal(party.postsWithText(w.id).find((x) => x.id === p.id).added, true);
  assert.equal(party.meView(w.id).posts.find((x) => x.id === old.id).added, undefined, 'only the new one');
  const feedback = words(80, 'fb');
  party.applyOps(w.id, batch(p, 'body', [{ pos: 0, del: 0, ins: feedback }]));
  party.applyOps(w.id, batch(p, 'notes', [{ pos: 0, del: 0, ins: 'what to say' }]));
  party.applyOps(w.id, batch(p, 'body', [{ pos: 0, del: words(60, 'fb').length + 1, ins: '' }]), 'no reason to cut what was written after the end');
  assert.equal(p.body, words(80, 'fb').slice(words(60, 'fb').length + 1));
  // Late work can't be slipped into it: anything in it is an edit after the party.
  const end = party.state.party.endedAt;
  party.applyOps(w.id, { ...batch(p, 'body', [{ at: end - MIN, pos: 0, del: 0, ins: 'Early ' }]), sentAt: end - MIN + 500 });
  assert.ok(party.state.ops[w.id].filter((o) => o[1] === p.id).every((o) => o[6]?.e), 'every op in it is marked after the end');
  const lp = party.newPost(late.id, {});
  party.applyOps(late.id, batch(lp, 'body', [{ pos: 0, del: 0, ins: 'Thanks for hosting.' }]));
  clock.advance(5 * MIN);
  party.tick();
  assert.equal(scoreOf(party, w.id), score, 'nothing in it counts');
  party.rebuildEngine({ sync: true });
  assert.equal(scoreOf(party, w.id), score);
  assert.equal(party.participants(), participants, 'writing after the end doesn’t make someone a writer of the party');
  assert.equal(party.state.party.endWords, words0);

  // While private: in no public view (the live page, the anthology, its page, the export).
  assert.equal(JSON.stringify(party.archiveView()), archive0);
  assert.throws(() => party.publicPost(p.publicId), (e) => e.status === 404);
  assert.throws(() => party.publicPost(lp.publicId), (e) => e.status === 404);
  assert.equal(party.liveView().posts.length, 0);
  assert.doesNotMatch(JSON.stringify([party.liveView(), party.exportMarkdown(host.id)]), /fb61|Feedback|Thanks for hosting/);
  // Hosts see it, marked.
  const row = party.hostWriter(host.id, w.id).posts.find((x) => x.id === p.id);
  assert.equal(row.added, true);
  assert.deepEqual(row.after.map((e) => e.kind), ['added'], 'its start, not each session');
  assert.ok(party.state.log.some((l) => l.type === 'after-new' && l.userId === w.id));

  // Published (a reason is optional, as for any privacy change after the end): "Added after the party".
  party.updatePost(w.id, { id: p.id, privacy: 'live', reason: 'sharing my feedback' });
  party.updatePost(w.id, { id: p.id, title: 'Feedback, revised' });
  const page = party.publicPost(p.publicId);
  assert.equal(page.title, 'Feedback, revised');
  assert.equal(page.added, true);
  assert.equal(page.edited, undefined, 'added, not edited');
  const entry = party.archiveView().posts.find((x) => x.id === p.publicId);
  assert.deepEqual([entry.added, entry.edited], [true, undefined]);
  assert.equal(party.archiveView().posts.length, 2);
  assert.doesNotMatch(JSON.stringify([page, party.archiveView()]), /sharing my feedback/);
  assert.deepEqual(party.hostWriter(host.id, w.id).posts.find((x) => x.id === p.id).after.map((e) => [e.kind, e.reason ?? null]), [['added', null], ['privacy', 'sharing my feedback']]);
  assert.equal(scoreOf(party, w.id), score);
});

test('during the party a new post is public live as before; in the lobby none can start', () => {
  const { party: lobby } = makeParty();
  const x = addUser(lobby, 'xavi');
  assert.throws(() => lobby.newPost(x.id, {}), (e) => e.status === 409 && e.extra.code === 'not-started');
  const { party } = setup();
  const w = addUser(party, 'wren');
  const p = party.newPost(w.id, {});
  assert.equal(p.privacy, 'live');
  assert.equal(p.after, undefined);
  assert.equal(party.meView(w.id).posts[0].added, undefined);
});

test('over HTTP: a post started after the end is private, out of the anthology and its page, and marked for its writer', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const host = client(app.base);
  await host.post('/api/register', { username: 'hostuser', password: 'longpassword', name: 'Host' });
  await host.post('/api/admin/start', {});
  const w = client(app.base);
  await w.post('/api/register', { username: 'wren', password: 'longpassword', name: 'Wren' });
  await w.post('/api/join', {});
  await host.post('/api/admin/end', {});
  const r = await w.post('/api/post/new', { title: 'Feedback' });
  assert.equal(r.status, 200);
  assert.equal(r.json.post.privacy, 'private');
  const id = r.json.post.id;
  assert.equal((await w.post('/api/ops', { postId: id, pane: 'body', baseVersion: 0, seq: 'f1', sentAt: Date.now(), ops: [{ at: Date.now(), pos: 0, del: 0, ins: 'The party was lovely.' }] })).status, 200);
  const mine = (await w.get('/api/me')).json.posts.find((p) => p.id === id);
  assert.deepEqual([mine.privacy, mine.added, mine.publicId], ['private', true, null]);
  assert.equal((await w.get('/api/posts')).json.posts.find((p) => p.id === id).added, true);
  const anon = client(app.base);
  assert.deepEqual((await anon.get('/api/archive')).json.posts, []);
  assert.doesNotMatch(JSON.stringify((await anon.get('/api/live')).json), /lovely|Feedback/);
  const publicId = app.app.party.state.posts[id].publicId;
  assert.equal((await anon.get(`/api/p/${publicId}`)).status, 404);
});
