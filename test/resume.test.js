// Resuming the latest party after it ended (Party#resume): the time it was over becomes a pause,
// edits made meanwhile count like writing during a break, and it all survives a restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeParty, addUser, typeInto, startApp, client, sleep } from './helpers.js';
import { realProse, MIN, SEC } from './sim.js';
import { HttpError } from '../lib/party.js';

let n = 0;
const batch = (p, pane, ops) => ({ postId: p.id, pane, baseVersion: p.ver[pane], seq: `r${++n}`, ops });
const words = (count, tag) => Array.from({ length: count }, (_, i) => `${tag}${i + 1}`).join(' ');
const hours = (party, uid) => party.progressOf(uid, { fresh: true }).prog.hours.map((h) => [h.k + 1, h.status, Math.round(h.credited)]);

test('resume: the time it was over is a pause, edits made meanwhile count like writing on a break, and writing goes on in the same posts', () => {
  const { party, clock } = makeParty({ settings: { hourLengthMin: 10, targetPerHour: 50, carryOverMax: 0 } });
  const host = addUser(party, 'host');
  party.start(host.id);
  const w = addUser(party, 'ana', 'Ana');
  party.join(w.id);
  const p = party.newPost(w.id, { title: 'Harbour' });
  typeInto(party, clock, w, p, realProse(60, 0), { cps: 4 }); // hour 1: met
  clock.set(w.joinedAt + 11 * MIN);
  typeInto(party, clock, w, p, ` ${realProse(20, 100)}`, { cps: 4 }); // hour 2: 20 so far
  clock.advance(2 * MIN); // settled
  party.tick();
  // An open review alert, to see the end close it and the resume open it again.
  const al = party.pushAlert({ kind: 'review', t: clock.now(), userId: w.id, k: 1 });
  party.end(host.id);
  const endedAt = party.state.party.endedAt;
  assert.equal(al.closedBy, 'end');
  // After the end: a quiet edit (never counted while it's over) and a new post.
  clock.advance(MIN);
  party.applyOps(w.id, batch(p, 'body', [{ pos: p.body.length, del: 0, ins: ` ${words(15, 'late')}` }]));
  const q = party.newPost(w.id, { title: 'Afterthought' });
  party.applyOps(w.id, batch(q, 'body', [{ pos: 0, del: 0, ins: words(10, 'after') }]));
  assert.equal(party.publicPost(p.publicId).edited, true);
  assert.equal(hours(party, w.id)[0][1], 'met');
  assert.ok(['partial', 'settling'].includes(hours(party, w.id)[1][1]), 'hour 2 stopped at the end');
  const before = hours(party, w.id)[1][2];

  clock.advance(30 * MIN);
  assert.throws(() => party.resume(w.id), (e) => e instanceof HttpError && e.status === 404, 'hosts only');
  const r = party.resume(host.id);
  const at = clock.now();
  assert.deepEqual(r, { resumedAt: at, pauseFrom: endedAt });
  assert.equal(party.phase, 'running');
  assert.equal(party.state.party.endedAt, null);
  assert.equal(party.state.party.archiveOrder, null);
  assert.equal(party.state.party.endWords, undefined);
  assert.deepEqual(party.state.party.resumed, [{ endedAt, at }]);
  const br = party.state.breaks.find((b) => b.resumed);
  assert.deepEqual([br.startAt, br.endAt, br.mode], [endedAt, at, 'pause']);
  assert.throws(() => party.resume(host.id), (e) => e.status === 409 && e.extra.code === 'not-ended');
  assert.ok(party.state.log.some((l) => l.type === 'resume' && l.by === host.id));
  assert.equal(al.ack, false, 'the alert the end closed is open again');
  // Hour 2 picks up where it stopped (not missed for the pause), with the words written meanwhile.
  const h2 = hours(party, w.id)[1];
  assert.equal(h2[1], 'current');
  assert.equal(h2[2], before + 15 + 10, 'edits made while it was over count, like writing on a break');
  assert.equal(w.out, false);
  // The posts are ordinary posts again, and writing goes on in them (the scorer is in step).
  assert.equal(party.publicPost(p.publicId).edited, undefined);
  assert.equal(party.meView(w.id).posts.find((x) => x.id === q.id).added, undefined);
  typeInto(party, clock, w, p, ` ${realProse(20, 200)}`, { cps: 4 });
  clock.advance(2 * MIN);
  assert.ok(hours(party, w.id)[1][2] >= before + 25 + 15, 'new writing counts');
  // The hour ends 10 minutes of clock after it started, not counting the pause: then it's judged.
  const span = party.progressOf(w.id, { fresh: true }).prog.hours[1];
  assert.equal(span.endAt - span.startAt, 10 * MIN + (at - endedAt));
  clock.set(span.endAt + 2 * MIN);
  party.tick();
  assert.deepEqual(hours(party, w.id).map((h) => h[1]).slice(0, 2), ['met', 'met']);
  // A full re-score agrees.
  const now = JSON.stringify(hours(party, w.id));
  party.rebuildEngine({ sync: true });
  assert.equal(JSON.stringify(hours(party, w.id)), now);

  // Ending again works as before: edits after this end don't count.
  party.end(host.id);
  const ended2 = JSON.stringify(party.scoreOf(w.id, { fresh: true }).totals);
  clock.advance(MIN);
  party.applyOps(w.id, batch(p, 'body', [{ pos: p.body.length, del: 0, ins: ` ${words(30, 'final')}` }]));
  assert.equal(JSON.stringify(party.scoreOf(w.id, { fresh: true }).totals), ended2);
  assert.equal(party.publicPost(p.publicId).edited, true);
  assert.ok(party.archiveView().posts.length >= 1);
});

test('resume over HTTP: hosts only; text, hours and the pause survive a restart, before and after a second end', async (t) => {
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
  await host.post('/api/admin/settings', { scoring: { settleSec: 1, settleQuantumSec: 1 } });
  const w = client(first.base);
  await w.post('/api/register', { username: 'wren', password: 'longpassword', name: 'Wren' });
  await w.post('/api/join', {});
  const post = (await w.post('/api/post/new', { title: 'Harbour' })).json.post;
  let ver = 0;
  const send = async (ins, c = w) => {
    const text = (await c.get(`/api/post?id=${post.id}&pane=body`)).json.text;
    const r = await c.post('/api/ops', { postId: post.id, pane: 'body', baseVersion: ver, seq: `h${++n}`, sentAt: Date.now(), ops: [{ at: Date.now(), pos: text.length, del: 0, ins }] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    ver = r.json.version;
  };
  await send('The harbour lights went out one by one while the ferry waited.');
  await sleep(1500);
  assert.equal((await w.post('/api/admin/resume', {})).status, 404, 'writers can’t');
  assert.equal((await host.post('/api/admin/resume', {})).status, 409, 'not ended yet');
  await host.post('/api/admin/end', {});
  await send(' Written after the end.');
  const r = await host.post('/api/admin/resume', {});
  assert.equal(r.status, 200);
  assert.ok(Number.isFinite(r.json.resumedAt));
  assert.equal((await client(first.base).get('/api/session')).json.party.phase, 'running');
  await send(' And after the resume.');
  await sleep(3000); // every word settled (settleSec 1 on a 1 s grid)
  const snap = async (c) => ({ text: (await c.get(`/api/post?id=${post.id}&pane=body`)).json.text, progress: (await c.get('/api/me')).json.progress.hours.map((h) => [h.k, h.status, Math.round(h.credited), h.endAt - h.startAt]) });
  const s1 = await snap(w);
  assert.match(s1.text, /Written after the end\. And after the resume\.$/);
  await sleep(100);
  await first.close();

  const second = await boot({ stateFile: first.stateFile });
  const w2 = client(second.base);
  await w2.post('/api/login', { username: 'wren', password: 'longpassword' });
  const s2 = await snap(w2);
  assert.deepEqual(s2, s1, 'the same text and hours after a restart');
  assert.equal(second.app.party.phase, 'running');
  assert.equal(second.app.party.state.breaks.filter((b) => b.resumed).length, 1);
  // Writing goes on after the restart, then a second end: its edits are after the party again.
  const host2 = client(second.base);
  await host2.post('/api/login', { username: 'hostuser', password: 'longpassword' });
  await send(' Once more.', w2);
  await host2.post('/api/admin/end', {});
  await send(' The very end.', w2);
  await sleep(3000);
  const s3 = await snap(w2);
  await sleep(100);
  await second.close();
  const third = await boot({ stateFile: first.stateFile });
  const w3 = client(third.base);
  await w3.post('/api/login', { username: 'wren', password: 'longpassword' });
  assert.deepEqual(await snap(w3), s3, 'and after a second end and another restart');
  assert.match(s3.text, /Once more\. The very end\.$/);
});
