// Account approval (SPEC §15).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeParty, addUser, typeInto, startApp, client, sleep } from './helpers.js';
import { realProse, MIN, SEC, HOUR } from './sim.js';
import { Party } from '../lib/party.js';

function setup() {
  const { party, clock } = makeParty({ settings: { approvalRequired: true, hourLengthMin: 10, targetPerHour: 20 } });
  const host = addUser(party, 'host', 'Host');
  party.start(host.id);
  return { party, clock, host };
}
const refused = (fn) => assert.throws(fn, (e) => e.status === 403 && e.message === 'pending_approval' && e.extra.code === 'pending_approval');

test('approval: new accounts wait; nothing a writer does works until the host approves', () => {
  const { party, clock, host } = setup();
  assert.equal(party.approvalOf(host), 'approved', 'the first account (the host) is approved');
  const ruth = addUser(party, 'ruth', 'Ruth');
  assert.equal(party.approvalOf(ruth), 'pending');
  assert.equal(party.meView(ruth.id).me.approval, 'pending');
  refused(() => party.join(ruth.id));
  assert.equal(ruth.joinedAt, null, 'no clock before approval');
  refused(() => party.newPost(ruth.id, {}));
  refused(() => party.pasteCheck(ruth.id, 'some words'));
  refused(() => party.takePass(ruth.id, {}));
  // The host sees the request (and an alert).
  let hv = party.hostView(host.id);
  assert.deepEqual(hv.pending.map((p) => [p.username, p.approval, p.message]), [['ruth', 'pending', null]]);
  assert.equal(hv.summary.pendingApproval, 1);
  assert.equal(hv.summary.writers, 0, 'pending accounts are not counted as writers');
  assert.equal(hv.writers.find((w) => w.id === ruth.id).statusReason, 'Waiting for your approval.');
  const al = hv.alerts.find((a) => a.kind === 'approval' && a.userId === ruth.id);
  assert.equal(al.text, 'Ruth is waiting for approval.');
  assert.equal(al.closed, false);
  // A message to the host; editing it again within 10 s is too fast.
  const r = party.setApprovalMessage(ruth.id, '  Hi, it’s Ruth from the book club​  ');
  assert.equal(r.approvalMessageAt, clock.now());
  assert.equal(party.meView(ruth.id).me.approvalMessage, 'Hi, it’s Ruth from the book club');
  assert.throws(() => party.setApprovalMessage(ruth.id, 'again'), (e) => e.status === 429 && e.message === 'too_fast' && e.extra.retryAfterMs > 0);
  hv = party.hostView(host.id);
  assert.equal(hv.pending[0].message, 'Hi, it’s Ruth from the book club');
  assert.equal(hv.alerts.filter((a) => a.kind === 'approval' && !a.closed).length, 1, 'the edit replaced the alert');
  assert.match(hv.alerts.find((a) => a.kind === 'approval' && !a.closed).text, /^Ruth is waiting for approval: “Hi, it’s Ruth/);
  // Approve: everything works, the alert closes.
  party.approve(host.id, { id: ruth.id });
  assert.equal(party.approvalOf(ruth), 'approved');
  assert.ok(party.join(ruth.id));
  const p = party.newPost(ruth.id, {});
  typeInto(party, clock, ruth, p, realProse(10, 0));
  hv = party.hostView(host.id);
  assert.equal(hv.pending.length, 0);
  assert.equal(hv.alerts.filter((a) => a.kind === 'approval' && !a.closed).length, 0);
  assert.ok(party.state.log.some((l) => l.type === 'approve' && l.userId === ruth.id));
});

test('approval: decline with a note; a new message asks again; approve all; declined writers vanish from public pages and counts', () => {
  const { party, clock, host } = setup();
  const sam = addUser(party, 'sam', 'Sam');
  party.decline(host.id, { id: sam.id, note: 'Please come and say hi at the desk first.' });
  let me = party.meView(sam.id).me;
  assert.equal(me.approval, 'declined');
  assert.equal(me.approvalNote, 'Please come and say hi at the desk first.');
  refused(() => party.newPost(sam.id, {}));
  assert.deepEqual(party.hostView(host.id).pending.map((p) => [p.username, p.approval]), [['sam', 'declined']]);
  clock.advance(11 * SEC);
  party.setApprovalMessage(sam.id, 'I said hi!');
  me = party.meView(sam.id).me;
  assert.equal(me.approval, 'pending', 'a new message puts the request back in the queue');
  assert.equal(me.approvalNote, null);
  const others = ['a1', 'a2', 'a3'].map((n) => addUser(party, n));
  assert.deepEqual(party.approveAll(host.id), { count: 4 });
  for (const u of [sam, ...others]) assert.equal(party.approvalOf(u), 'approved');
  // An approved writer streams; declined later, their posts and numbers leave the public pages.
  party.join(sam.id);
  const p = party.newPost(sam.id, { title: 'Sam’s piece' });
  typeInto(party, clock, sam, p, realProse(25, 0), { cps: 8 });
  clock.advance(2 * MIN);
  assert.equal(party.liveView().posts.length, 1);
  assert.ok(party.liveView().party.totals.wordsToday > 0);
  party.decline(host.id, { id: sam.id });
  const lv = party.liveView();
  assert.equal(lv.posts.length, 0);
  assert.equal(lv.party.totals.wordsToday, 0);
  assert.equal(lv.counters.posts, 0);
  assert.throws(() => party.decline(host.id, { id: host.id }), /always approved/);
});

test('approval: a waiting account can’t grow the state: its messages rewrite one alert, 10 an hour, and its lines can’t fill the host log', () => {
  const { party, clock, host } = setup();
  const mal = addUser(party, 'mal', 'Mal');
  // A message every 10 seconds for two hours.
  let sent = 0;
  for (let i = 0; i < 720; i++) {
    clock.advance(10 * SEC);
    try {
      party.setApprovalMessage(mal.id, `message ${i}`);
      sent++;
    } catch (e) {
      assert.ok(e.status === 429 && e.message === 'too_fast' && e.extra.retryAfterMs > 0, String(e));
    }
  }
  assert.equal(sent, 20, '10 an hour');
  assert.equal(party.state.alerts.length, 1, 'one alert, rewritten');
  const hv = party.hostView(host.id);
  assert.equal(hv.pending[0].message, 'message 369', 'the host has the latest message');
  assert.deepEqual(hv.alerts.map((a) => [a.userId, a.closed, a.message]), [[mal.id, false, 'message 369']]);
  const own = () => party.state.log.filter((l) => l.userId === mal.id && !l.by);
  assert.deepEqual(own().map((l) => l.type), ['register', 'approval-message'], 'the log has the first message, not each edit');
  // Declined, a new message asks again: that is a new request, with its own alert and log line.
  party.decline(host.id, { id: mal.id });
  clock.advance(HOUR);
  party.setApprovalMessage(mal.id, 'Please?');
  clock.advance(10 * SEC);
  party.setApprovalMessage(mal.id, 'Please!');
  assert.deepEqual(party.hostView(host.id).alerts.map((a) => [a.closed, a.message]), [[true, 'message 369'], [false, 'Please!']]);
  assert.deepEqual(own().map((l) => l.text), ['registered, waiting for approval', 'sent the host a message', 'asked again for approval']);
  // Whatever else it does while it waits, only its newest 20 lines stay in the log...
  for (let i = 0; i < 100; i++) party.setPublicProfile(mal.id, i % 2 === 0);
  assert.equal(own().length, 20);
  assert.equal(own().at(-1).text, 'left the public list of writers', 'the newest are the ones kept');
  assert.ok(party.state.log.some((l) => l.type === 'start') && party.state.log.some((l) => l.type === 'decline'), 'the party’s own lines stay');
  // ...and once a host has approved it, every line stays, like any writer's.
  party.approve(host.id, { id: mal.id });
  for (let i = 0; i < 30; i++) party.setPublicProfile(mal.id, i % 2 === 0);
  assert.equal(own().length, 50);
  // After the end alerts are kept closed, and messages still rewrite the one alert.
  const late = addUser(party, 'late', 'Late');
  party.end(host.id);
  const before = party.state.alerts.length;
  for (const m of ['one', 'two', 'three']) {
    clock.advance(10 * SEC);
    party.setApprovalMessage(late.id, m);
  }
  assert.equal(party.state.alerts.length, before);
  assert.deepEqual(party.hostView(host.id).alerts.filter((a) => a.userId === late.id).map((a) => [a.closed, a.message]), [[true, 'three']]);
});

test('approval: accounts from before, admins, and everyone while approval is off count as approved', () => {
  const { party, host } = setup();
  const old = addUser(party, 'old');
  delete old.approval; // an account from before the setting existed
  assert.equal(party.approvalOf(old), 'approved');
  party.adminUsers.add('carol');
  const carol = addUser(party, 'carol');
  assert.equal(party.approvalOf(carol), 'approved');
  const p = addUser(party, 'pend');
  assert.equal(party.approvalOf(p), 'pending');
  party.setSettings(host.id, { approvalRequired: false });
  assert.equal(party.approvalOf(p), 'approved', 'approval off: nobody waits');
  assert.ok(party.join(p.id));
  const later = addUser(party, 'later');
  assert.equal(later.approval, 'approved');
  // Restored from a state file, the state is kept.
  party.setSettings(host.id, { approvalRequired: true });
  const again = new Party({ state: JSON.parse(JSON.stringify(party.state)), log: { error() {}, log() {} }, recomputeMinMs: 0 });
  assert.equal(again.approvalOf(again.userById(p.id)), 'pending');
  assert.equal(again.approvalOf(again.userById(old.id)), 'approved');
});

test('http: a pending writer is refused (403 pending_approval) and flips to approved over the me stream at once', async (t) => {
  const { base, close } = await startApp({ approvalRequired: true });
  t.after(close);
  const host = client(base);
  await host.post('/api/register', { username: 'host', password: 'longpassword', name: 'Host' });
  await host.post('/api/admin/start', {});
  const w = client(base);
  const reg = await w.post('/api/register', { username: 'ruth', password: 'longpassword', name: 'Ruth' });
  assert.equal(reg.json.user.approval, 'pending');
  assert.equal((await w.get('/api/session')).json.user.approval, 'pending');
  for (const [path, body] of [['/api/join', {}], ['/api/post/new', {}], ['/api/paste/check', { text: 'a b c' }], ['/api/pass', {}]]) {
    const r = await w.post(path, body);
    assert.equal(r.status, 403, path);
    assert.equal(r.json.error, 'pending_approval');
  }
  // Ops on someone else's post are 404; on a post of one's own (none exist) the gate comes first.
  const ops = await w.post('/api/ops', { postId: 'pnope', pane: 'body', baseVersion: 0, ops: [{ pos: 0, del: 0, ins: 'x' }] });
  assert.equal(ops.status, 403);
  assert.equal(ops.json.error, 'pending_approval');
  let r = await w.post('/api/me/approval-message', { message: 'Hi, it’s Ruth' });
  assert.equal(r.status, 200);
  assert.ok(r.json.approvalMessageAt > 0);
  r = await w.post('/api/me/approval-message', { message: 'Hi again' });
  assert.equal(r.status, 429);
  assert.equal(r.json.error, 'too_fast');
  assert.ok(r.json.retryAfterMs > 0);
  const hv = (await host.get('/api/host')).json;
  assert.equal(hv.settings.approvalRequired, true);
  const req = hv.pending.find((p) => p.username === 'ruth');
  assert.deepEqual(Object.keys(req).sort(), ['approval', 'email', 'id', 'message', 'messageAt', 'name', 'note', 'registeredAt', 'username']);
  assert.equal(req.message, 'Hi, it’s Ruth');
  // Nothing about Ruth leaves the host view.
  assert.ok(!JSON.stringify((await client(base).get('/api/live')).json).includes('Ruth'));
  // The flip: the writer's stream gets the new state right away.
  const events = [];
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/me/events`, { headers: { Cookie: w.cookie }, signal: ctrl.signal });
  const reading = (async () => {
    const dec = new TextDecoder();
    try {
      for await (const chunk of res.body) for (const m of dec.decode(chunk).matchAll(/event: me\ndata: (.*)\n/g)) events.push({ at: performance.now(), me: JSON.parse(m[1]).me });
    } catch { /* aborted */ }
  })();
  await sleep(300);
  assert.equal(events[0].me.approval, 'pending');
  const t0 = performance.now();
  assert.equal((await host.post('/api/host/approve', { id: req.id })).status, 200);
  for (let i = 0; i < 50 && !events.some((e) => e.me.approval === 'approved'); i++) await sleep(20);
  ctrl.abort();
  await reading;
  const flip = events.find((e) => e.me.approval === 'approved');
  assert.ok(flip, 'the stream carried the approval');
  assert.ok(flip.at - t0 < 500, `after ${Math.round(flip.at - t0)} ms`);
  // Now writing works.
  assert.equal((await w.post('/api/join', {})).status, 200);
  assert.equal((await w.post('/api/post/new', {})).status, 200);
  // Decline and approve-all over HTTP.
  const x = client(base);
  const xr = (await x.post('/api/register', { username: 'xavier', password: 'longpassword', name: 'Xavier' })).json.user;
  assert.equal((await host.post('/api/host/decline', { id: xr.id, note: 'Not today' })).status, 200);
  assert.equal((await x.get('/api/session')).json.user.approvalNote, 'Not today');
  await x.post('/api/me/approval-message', { message: 'Please?' });
  assert.deepEqual((await host.post('/api/host/approve-all', {})).json, { ok: true, count: 1 });
});

test('the anthology counts participants, not distinct authors; the Markdown export holds only published posts', () => {
  const { party, clock } = makeParty({ settings: { approvalRequired: false } });
  const h = addUser(party, 'host');
  party.start(h.id);
  const ana = addUser(party, 'ana');
  const bob = addUser(party, 'bob');
  const quiet = addUser(party, 'quiet'); // wrote only notes
  for (const u of [ana, bob, quiet]) party.join(u.id);
  const a1 = party.newPost(ana.id, { title: 'Open one' });
  const a2 = party.newPost(ana.id, { title: 'Secret one' });
  party.updatePost(ana.id, { id: a2.id, privacy: 'separate' });
  const b1 = party.newPost(bob.id, { title: 'Bob’s' });
  const q1 = party.newPost(quiet.id, { title: '' });
  typeInto(party, clock, ana, a1, 'Words in the open.');
  typeInto(party, clock, ana, a2, 'Words kept apart.');
  typeInto(party, clock, bob, b1, 'Bob writes too.');
  typeInto(party, clock, quiet, q1, 'just planning', { pane: 'notes' });
  let md = party.exportMarkdown(h.id);
  assert.ok(md.includes('Open one') && md.includes('Bob’s'));
  assert.ok(!md.includes('Secret one') && !md.includes('kept apart'), 'separate posts are not published before the end');
  party.end(h.id);
  md = party.exportMarkdown(h.id);
  assert.ok(md.includes('Secret one'));
  const a = party.archiveView();
  assert.equal(a.counters.posts, 3);
  assert.equal(a.counters.participants, 3, 'ana, bob and the notes-only writer; not the host');
  assert.equal(a.counters.writers, 3);
});
