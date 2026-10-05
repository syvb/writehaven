import test from 'node:test';
import assert from 'node:assert/strict';
import { makeParty, makeClock, addUser, typeInto, pasteInto } from './helpers.js';
import { prose, realProse, wordValue, MIN, SEC, T0 } from './sim.js';
import { HttpError, ONLINE_SLACK_MS } from '../lib/party.js';

function setup(settings = {}) {
  const { party, clock } = makeParty({ settings: { hourLengthMin: 10, targetPerHour: 50, ...settings } });
  const host = addUser(party, 'host');
  party.start(host.id);
  return { party, clock, host };
}
const status = (party, uid) => party.progressOf(uid, { fresh: true }).prog.hours.map((h) => h.status);
// An hour is judged once its last words have settled (90 s, on a 5 s grid).
const JUDGED = 2 * MIN;
const words = (s) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

test('ops: apply, version conflict and idempotent retry', () => {
  const { party, host } = setup();
  const w = addUser(party, 'ana');
  const p = party.newPost(w.id, { title: 'First' });
  const r1 = party.applyOps(w.id, { postId: p.id, pane: 'body', baseVersion: 0, seq: 'a1', ops: [{ pos: 0, del: 0, ins: 'Hello' }, { pos: 5, del: 0, ins: ' world' }] });
  assert.equal(r1.version, 1);
  assert.equal(party.state.posts[p.id].body, 'Hello world');
  // Same batch again (lost response, client retries): not applied twice.
  const again = party.applyOps(w.id, { postId: p.id, pane: 'body', baseVersion: 0, seq: 'a1', ops: [{ pos: 0, del: 0, ins: 'Hello' }] });
  assert.equal(again.duplicate, true);
  assert.equal(party.state.posts[p.id].body, 'Hello world');
  // Stale base version: conflict with the canonical text so the client can resync.
  assert.throws(() => party.applyOps(w.id, { postId: p.id, pane: 'body', baseVersion: 0, seq: 'b1', ops: [{ pos: 0, del: 0, ins: 'X' }] }), (e) => {
    assert.ok(e instanceof HttpError);
    assert.equal(e.status, 409);
    assert.equal(e.extra.code, 'conflict');
    assert.equal(e.extra.text, 'Hello world');
    assert.equal(e.extra.version, 1);
    return true;
  });
  // Resync: the client diffs its text against the canonical one and sends that.
  party.applyOps(w.id, { postId: p.id, pane: 'body', baseVersion: 1, seq: 'b2', ops: [{ pos: 5, del: 6, ins: ', friends' }] });
  assert.equal(party.state.posts[p.id].body, 'Hello, friends');
  // Out of range: whole batch rejected, nothing applied.
  assert.throws(() => party.applyOps(w.id, { postId: p.id, pane: 'body', baseVersion: 2, seq: 'c', ops: [{ pos: 0, del: 0, ins: 'A' }, { pos: 99, del: 1, ins: '' }] }), /range/);
  assert.equal(party.state.posts[p.id].body, 'Hello, friends');
  assert.equal(party.state.posts[p.id].ver.body, 2);
  // Another writer can't touch it.
  const b = addUser(party, 'bob');
  assert.throws(() => party.applyOps(b.id, { postId: p.id, pane: 'body', baseVersion: 2, ops: [{ pos: 0, del: 0, ins: 'x' }] }), /No such post/);
  // Notes are a separate pane.
  party.applyOps(w.id, { postId: p.id, pane: 'notes', baseVersion: 0, ops: [{ pos: 0, del: 0, ins: 'plan' }] });
  assert.equal(party.state.posts[p.id].notes, 'plan');
  // The replayed history equals the canonical text.
  assert.equal(party.engine.text(w.id, p.id, 'b'), 'Hello, friends');
  assert.ok(host);
});

test('ops: a version conflict carries the base text and the batches since, for a 3-way merge', () => {
  const { party } = setup();
  const w = addUser(party, 'ana');
  const p = party.newPost(w.id, {});
  const send = (baseVersion, seq, ops, extra = {}) => party.applyOps(w.id, { postId: p.id, pane: 'body', baseVersion, seq, ops, ...extra });
  send(0, 's1', [{ pos: 0, del: 0, ins: 'The quick brown fox' }]);
  send(1, 's2', [{ pos: 4, del: 5, ins: 'slow' }, { pos: 0, del: 0, ins: '> ' }]);
  send(2, 's3', [{ pos: party.state.posts[p.id].body.length, del: 0, ins: ' jumps' }]);
  // A second tab still at version 1 sends its own change.
  let err;
  try { send(1, 'tabB-1', [{ pos: 19, del: 0, ins: '!' }]); } catch (e) { err = e; }
  assert.equal(err.status, 409);
  const x = err.extra;
  assert.equal(x.code, 'conflict');
  assert.equal(x.version, 3);
  assert.equal(x.text, '> The slow brown fox jumps');
  assert.deepEqual(x.base, { version: 1, text: 'The quick brown fox' });
  assert.deepEqual(x.since.map((b) => b.version), [2, 3]);
  // Replaying `since` on the base gives the current text.
  let t = x.base.text;
  for (const b of x.since) for (const [pos, del, ins] of b.ops) t = t.slice(0, pos) + ins + t.slice(pos + del);
  assert.equal(t, x.text);
  // A batch that was applied (s2) and retried after s3: a duplicate, never applied twice.
  try { send(1, 's2', [{ pos: 4, del: 5, ins: 'slow' }]); } catch (e) { err = e; }
  assert.equal(err.extra.duplicate, true);
  assert.equal(err.extra.appliedVersion, 2);
  assert.equal(err.extra.base.text, '> The slow brown fox');
  assert.equal(party.state.posts[p.id].body, '> The slow brown fox jumps');
  // The last batch retried: the plain duplicate answer.
  assert.deepEqual(send(2, 's3', [{ pos: 0, del: 0, ins: 'x' }]), { version: 3, duplicate: true });
  // A client whose copy of version 3 has another length must resync rather than misplace ops.
  try { send(3, 's4', [{ pos: 0, del: 0, ins: 'x' }], { baseLen: 99 }); } catch (e) { err = e; }
  assert.equal(err.status, 409);
  assert.equal(err.extra.lengthMismatch, true);
  assert.deepEqual(err.extra.base, { version: 3, text: '> The slow brown fox jumps' });
  assert.deepEqual(send(3, 's5', [{ pos: 0, del: 2, ins: '' }], { baseLen: 26 }), { version: 4 });
});

test('ops: lobby and ended phases', () => {
  const { party, clock } = makeParty();
  const host = addUser(party, 'host');
  const w = addUser(party, 'ana');
  assert.throws(() => party.newPost(w.id, {}), /hasn’t started/);
  party.start(host.id);
  const p = party.newPost(w.id, {});
  party.applyOps(w.id, { postId: p.id, pane: 'body', baseVersion: 0, ops: [{ pos: 0, del: 0, ins: 'a' }] });
  clock.advance(5 * SEC);
  party.end(host.id);
  clock.advance(5 * SEC);
  // An offline op typed before the end arrives late: accepted (backdated)…
  const sentAt = 1_000_000;
  party.applyOps(w.id, { postId: p.id, pane: 'body', baseVersion: 1, sentAt, ops: [{ at: sentAt - 8000, pos: 1, del: 0, ins: 'b' }] });
  assert.equal(party.state.posts[p.id].body, 'ab');
  // …and anything typed after the end goes in as an edit after the party, never scored (SPEC §30).
  party.applyOps(w.id, { postId: p.id, pane: 'body', baseVersion: 2, ops: [{ pos: 2, del: 0, ins: 'c' }] });
  assert.equal(party.state.posts[p.id].body, 'abc');
  assert.deepEqual(party.state.ops[w.id].at(-1)[6], { e: 1 });
});

test('offline queue keeps relative timing (backdated, clamped, monotonic)', () => {
  const { party, clock } = setup();
  const w = addUser(party, 'ana');
  party.join(w.id);
  const p = party.newPost(w.id, {});
  clock.advance(20 * MIN);
  const sentAt = 5_000_000; // client clock, unrelated to server clock
  const ops = [];
  for (let i = 0; i < 10; i++) ops.push({ at: sentAt - (10 - i) * 60_000, pos: i, del: 0, ins: 'x' });
  party.applyOps(w.id, { postId: p.id, pane: 'body', baseVersion: 0, sentAt, ops });
  const ts = party.state.ops[w.id].map((o) => o[0]);
  assert.equal(ts[0], clock.now() - 10 * 60_000);
  assert.equal(ts[9], clock.now() - 60_000);
  for (let i = 1; i < ts.length; i++) assert.ok(ts[i] >= ts[i - 1]);
});

test('§10 missed hour: out + alert; reinstate', () => {
  const { party, clock, host } = setup();
  const w = addUser(party, 'ana', 'Ana');
  party.join(w.id);
  const p = party.newPost(w.id, {});
  typeInto(party, clock, w, p, realProse(25)); // 25 words < 50
  clock.set(w.joinedAt + 10 * MIN + 20 * SEC);
  party.tick();
  assert.equal(w.out, false, 'not judged before its words have settled');
  assert.deepEqual(status(party, w.id), ['settling', 'current']);
  clock.set(w.joinedAt + 10 * MIN + JUDGED);
  party.tick();
  assert.equal(w.out, true);
  assert.equal(party.state.alerts.length, 1);
  assert.equal(party.state.alerts[0].userId, w.id);
  assert.equal(party.state.alerts[0].k, 0);
  assert.equal(party.state.alerts[0].kind, 'missed');
  assert.deepEqual(status(party, w.id), ['missed', 'current']);
  const hv = party.hostView(host.id);
  assert.equal(hv.alerts[0].name, 'Ana');
  assert.equal(party.meView(w.id).me.out, true);
  // Writing still works while out.
  typeInto(party, clock, w, p, ' more');
  // Reinstate.
  party.adminWriter(host.id, { id: w.id, out: false });
  assert.equal(w.out, false);
  assert.ok(party.state.log.some((l) => l.type === 'reinstate'));
  // Mark out manually.
  party.adminWriter(host.id, { id: w.id, out: true });
  assert.equal(w.out, true);
  assert.equal(w.outReason, 'marked out by the host');
  // Alerts are acknowledged by the host.
  assert.equal(party.ackAlert(host.id, { id: 'all' }), 0); // reinstating acknowledged it already
});

test('§10 met hour: no alert', () => {
  const { party, clock } = setup();
  const w = addUser(party, 'ana');
  party.join(w.id);
  const p = party.newPost(w.id, {});
  typeInto(party, clock, w, p, realProse(80, 100), { cps: 4 }); // 80 words in under 2 min
  clock.set(w.joinedAt + 10 * MIN + JUDGED);
  party.tick();
  assert.equal(w.out, false);
  assert.equal(party.state.alerts.length, 0);
  assert.deepEqual(status(party, w.id), ['met', 'current']);
});

test('§10 alert-only mode alerts without putting the writer out', () => {
  const { party, clock } = setup({ missedHourOutcome: 'alert-only' });
  const w = addUser(party, 'ana');
  party.join(w.id);
  clock.set(w.joinedAt + 20 * MIN + JUDGED);
  party.tick();
  assert.equal(w.out, false);
  assert.equal(party.state.alerts.length, 2); // hours 1 and 2
});

test('§34 a free pass takes this hour off at any point in it (the default), or the next one', () => {
  const { party, clock, host } = setup({ hourLengthMin: 60 });
  const w = addUser(party, 'ana');
  party.join(w.id);
  party.adminWriter(host.id, { id: w.id, extraPasses: 2 }); // three passes
  // The first minute of hour 1: this hour, by default.
  clock.advance(30 * SEC);
  const pv = party.passPreview(w.id);
  assert.deepEqual([pv.k, pv.current.k, pv.next.k, pv.left], [0, 0, 1, 3]);
  assert.deepEqual([pv.current.startAt, pv.current.endAt, pv.next.startAt, pv.next.endAt], [w.joinedAt, w.joinedAt + 60 * MIN, w.joinedAt + 60 * MIN, w.joinedAt + 120 * MIN]);
  assert.deepEqual(party.takePass(w.id, { k: 0 }), { k: 0, which: 'current' });
  assert.throws(() => party.takePass(w.id, {}), (e) => e.status === 409 && e.extra.code === 'already-free', 'no double use');
  assert.equal(party.passPreview(w.id).current.already, true);
  // The next hour, by choice; the k shown must still be the next hour's.
  assert.throws(() => party.takePass(w.id, { which: 'next', k: 0 }), (e) => e.status === 409 && e.extra.code === 'stale');
  assert.throws(() => party.takePass(w.id, { which: 'later' }), (e) => e.status === 400);
  assert.deepEqual(party.takePass(w.id, { which: 'next', k: 1 }), { k: 1, which: 'next' });
  assert.ok(party.state.log.some((l) => l.type === 'pass' && /took hour 2 off \(the next hour; a pass\)/.test(l.text)));
  assert.ok(party.state.log.some((l) => l.type === 'pass' && /took hour 1 off \(the current hour; a pass\)/.test(l.text)));
  // The last minutes of hour 3: still this hour.
  clock.set(w.joinedAt + 178 * MIN);
  assert.deepEqual(party.takePass(w.id, {}), { k: 2, which: 'current' });
  assert.throws(() => party.takePass(w.id, {}), /no passes left/);
  clock.set(w.joinedAt + 180 * MIN + JUDGED);
  party.tick();
  assert.deepEqual(status(party, w.id).slice(0, 3), ['free', 'free', 'free']);
  assert.equal(w.out, false);
  assert.equal(party.state.alerts.length, 0);
  // A re-score keeps them.
  party.setSettings(host.id, { speedCapWpm: 91 });
  clock.advance(5 * SEC);
  party.tick();
  assert.deepEqual(status(party, w.id).slice(0, 3), ['free', 'free', 'free']);
  // An hour already judged is refused cleanly; so is having left the party.
  const b = addUser(party, 'bo');
  party.join(b.id);
  b.evaluatedThrough = party.passPreview(b.id).current.k; // as if this hour had been judged
  assert.equal(party.passPreview(b.id).current.judged, true);
  assert.throws(() => party.takePass(b.id, {}), (e) => e.status === 409 && e.extra.code === 'judged');
  party.setLeft(b.id, b.id, true);
  assert.throws(() => party.takePass(b.id, { which: 'next' }), (e) => e.status === 409 && e.extra.code === 'left');
});

test('§10 host grants: free hour, extra passes', () => {
  const { party, clock, host } = setup();
  const w = addUser(party, 'ana');
  party.join(w.id);
  party.adminWriter(host.id, { id: w.id, freeHour: 'next' });
  party.adminWriter(host.id, { id: w.id, extraPasses: 2 });
  assert.equal(party.meView(w.id).progress.passesLeft, 3);
  clock.set(w.joinedAt + 10 * MIN + JUDGED); // hour 1 missed
  party.tick();
  assert.equal(w.out, true);
  party.adminWriter(host.id, { id: w.id, out: false });
  clock.set(w.joinedAt + 20 * MIN + JUDGED); // hour 2 was free
  party.tick();
  assert.equal(w.out, false);
  assert.deepEqual(status(party, w.id).slice(0, 2), ['missed', 'free']);
});

test('§10 a host break shifts the hour windows of a late joiner', () => {
  const { party, clock, host } = setup({ hourLengthMin: 60, targetPerHour: 10 });
  clock.advance(30 * MIN);
  const w = addUser(party, 'late');
  party.join(w.id); // joins 30 min after the start
  const joined = w.joinedAt;
  clock.advance(20 * MIN); // 20 min into their hour 1
  const b = party.addBreak(host.id, { lengthMin: 30, label: 'Dinner' });
  assert.equal(b.startAt, clock.now());
  let cur = party.meView(w.id).progress.current;
  assert.equal(cur.endAt, joined + 90 * MIN); // 60 min of clock + 30 min of break
  assert.equal(cur.inBreak, true);
  // At the original end of their hour nothing is judged: the clock was paused.
  clock.set(joined + 61 * MIN);
  party.tick();
  assert.equal(party.state.alerts.length, 0);
  assert.equal(party.meView(w.id).progress.current.k, 0);
  // Hour 2 starts after the shifted end.
  clock.set(joined + 91 * MIN);
  party.tick();
  cur = party.meView(w.id).progress.current;
  assert.equal(cur.k, 1);
  assert.equal(cur.startAt, joined + 90 * MIN);
  assert.equal(party.liveView().party.break, null);
  // The break showed on the public page while it ran.
  clock.set(joined + 30 * MIN);
  assert.deepEqual(party.liveView().party.break, { label: 'Dinner', endAt: b.endAt, mode: 'pause' });
});

test('§10 ending a break early resumes the clock', () => {
  const { party, clock, host } = setup({ hourLengthMin: 60 });
  const w = addUser(party, 'ana');
  party.join(w.id);
  clock.advance(10 * MIN);
  const b = party.addBreak(host.id, { lengthMin: 60, label: 'Lunch' });
  clock.advance(15 * MIN);
  party.endBreak(host.id, { id: b.id });
  assert.equal(party.meView(w.id).progress.current.endAt, w.joinedAt + 75 * MIN);
});

test('§9 pasting another writer\'s text earns 0 and flags it to the host', () => {
  const { party, clock, host } = setup();
  const a = addUser(party, 'ana');
  const b = addUser(party, 'bob');
  party.join(a.id);
  party.join(b.id);
  const pa = party.newPost(a.id, {});
  const sentence = 'The harbour lights went out one by one while the ferry waited for nobody at all.';
  typeInto(party, clock, a, pa, sentence, { cps: 8 });
  clock.advance(2 * MIN); // Ana's words settle and count
  const pb = party.newPost(b.id, {});
  const text = `${realProse(20, 200)} ${sentence}`;
  const check = party.pasteCheck(b.id, text);
  assert.ok(check.other.includes('1'), 'pre-marked as another writer\'s text');
  assert.ok(!check.own.includes('1'));
  assert.equal(check.other.length, text.split(' ').length);
  pasteInto(party, b, pb, text, 'all');
  clock.advance(2 * MIN);
  const r = party.scoreOf(b.id, { fresh: true });
  const total = words(text);
  assert.ok(r.totals.notCounted.otherWriter >= words(sentence) - 1, `otherWriter ${r.totals.notCounted.otherWriter}`);
  assert.ok(r.totals.pasted <= total - words(sentence) + 1, `pasted ${r.totals.pasted}`);
  assert.ok(r.totals.pasted >= 10);
  const row = party.hostView(host.id).writers.find((x) => x.id === b.id);
  assert.ok(row.flags.scoring.otherWriter, 'host sees the flag');
  // Ana pasting her own sentence sees it as already counted.
  assert.ok(party.pasteCheck(a.id, sentence).own.split('').every((c) => c === '1'));
});

test('the paste check reveals matches with public text only: never notes, separate or hidden posts', () => {
  const { party, clock, host } = setup();
  const b = addUser(party, 'bob');
  const a = addUser(party, 'ana');
  party.join(b.id);
  party.join(a.id);
  const secretNotes = 'my unpublished diary entry about the clandestine midnight rendezvous downtown';
  const secretPost = 'a separate identity story about the lighthouse keeper and his violin collection';
  const hidden = 'personal content the host hid about the hospital visit last winter evening';
  const live = 'the harbour lights went out one by one while the ferry waited for nobody';
  const pl = party.newPost(b.id, {});
  const ps = party.newPost(b.id, {});
  const ph = party.newPost(b.id, {});
  party.updatePost(b.id, { id: ps.id, privacy: 'separate' });
  typeInto(party, clock, b, pl, secretNotes, { pane: 'notes', cps: 20 });
  typeInto(party, clock, b, pl, live, { cps: 20 });
  typeInto(party, clock, b, ps, secretPost, { cps: 20 });
  typeInto(party, clock, b, ph, hidden, { cps: 20 });
  party.adminPost(host.id, { id: ph.id, unlisted: true });
  clock.advance(2 * MIN); // everything settles into the shared index
  const other = (t) => party.pasteCheck(a.id, t).other;
  assert.ok(!other(secretNotes).includes('1'), 'notes never show');
  assert.ok(!other(secretPost).includes('1'), 'separate posts never show');
  assert.ok(!other(hidden).includes('1'), 'hidden posts never show');
  assert.ok(other(live).includes('1'), 'public text still shows as another writer’s');
  // Nor does scoring compare with private text (it would show in Ana's own breakdown).
  const pa = party.newPost(a.id, {});
  pasteInto(party, a, pa, secretNotes, 'all');
  clock.advance(2 * MIN);
  const r = party.scoreOf(a.id, { fresh: true });
  assert.equal(r.totals.notCounted.otherWriter, 0);
});

test('personal targets: hour 1 is calibration, then target × clamp(share / median)', () => {
  const { party, clock } = setup({ personalTargets: true, hourLengthMin: 30, targetPerHour: 100 });
  const ws = ['ana', 'bob', 'cy'].map((n) => addUser(party, n));
  for (const w of ws) party.join(w.id);
  const posts = ws.map((w) => party.newPost(w.id, {}));
  // Everyone writes ~78 words; 15 minutes later ana cuts a lot (big cut share), bob a little, cy nothing.
  const t0 = clock.now();
  for (const [i, w] of ws.entries()) {
    clock.set(t0);
    typeInto(party, clock, w, posts[i], realProse(78, 80 * i), { cps: 4, perBatch: 20 });
  }
  clock.set(t0 + 15 * MIN);
  const del = (w, post, n) => {
    const p = party.state.posts[post.id];
    party.applyOps(w.id, { postId: post.id, pane: 'body', baseVersion: p.ver.body, ops: [{ pos: 0, del: n, ins: '' }] });
  };
  del(ws[0], posts[0], 240);
  del(ws[1], posts[1], 60);
  clock.set(t0 + 30 * MIN + JUDGED);
  party.tick();
  const r0 = party.scoreOf(ws[0].id);
  assert.ok(r0.hours[0].cut > 15, `ana cut ${r0.hours[0].cut}`);
  const f = party.factors();
  assert.equal(f.get(ws[0].id), 1.25);
  assert.equal(f.get(ws[1].id), 1);
  assert.equal(f.get(ws[2].id), 0.8);
  const hours = party.meView(ws[0].id).progress.hours;
  assert.equal(hours[0].target, 100);
  assert.equal(hours[1].target, 125);
  // A host override always wins.
  party.adminWriter(party.userByUsername('host').id, { id: ws[0].id, targetOverride: 42 });
  assert.equal(party.meView(ws[0].id).progress.hours[1].target, 42);
});

test('a post gets a fresh public id whenever it changes identity', () => {
  const { party } = setup();
  const w = addUser(party, 'ana');
  const p = party.newPost(w.id, {});
  const id1 = p.publicId;
  party.updatePost(w.id, { id: p.id, privacy: 'live' });
  assert.equal(p.publicId, id1);
  party.updatePost(w.id, { id: p.id, privacy: 'named' });
  const id2 = p.publicId;
  assert.notEqual(id2, id1, 'signing gets a new id');
  party.updatePost(w.id, { id: p.id, privacy: 'separate' });
  assert.notEqual(p.publicId, id2);
  assert.throws(() => party.updatePost(w.id, { id: p.id, privacy: 'public' }), /privacy/);
});

test('settings validation and re-score on change', () => {
  const { party, clock, host } = setup();
  const w = addUser(party, 'ana');
  party.join(w.id);
  const p = party.newPost(w.id, {});
  const text = realProse(25, 300);
  typeInto(party, clock, w, p, text, { cps: 6 });
  clock.advance(2 * MIN);
  near(party.scoreOf(w.id).totals.credit, wordValue(text));
  // Counting characters instead of words: everyone is re-scored from the op log.
  party.setSettings(host.id, { unit: 'chars' });
  const chars = party.scoreOf(w.id).totals.credit;
  assert.ok(Math.abs(chars - wordValue(text)) > 1, `chars unit gives ${chars}`);
  party.setSettings(host.id, { unit: 'word', cutCapPerHour: '' });
  assert.equal(party.S.cutCapPerHour, null);
  assert.throws(() => party.setSettings(host.id, { contextWords: 0 }), /between/);
  assert.throws(() => party.setSettings(host.id, { nope: 1 }), /Unknown/);
  assert.throws(() => party.setSettings(host.id, { missedHourOutcome: 'explode' }), /one of/);
  assert.throws(() => party.setSettings(host.id, { unit: 'letters' }), /one of/);
  assert.throws(() => party.setSettings(w.id, { targetPerHour: 6 }), /Not found/);
});

function near(a, b, eps = 0.01) {
  assert.ok(Math.abs(a - b) < eps, `expected ${b}, got ${a}`);
}

test('state survives a reload (replay equals stored texts)', async () => {
  const { party, clock } = setup();
  const w = addUser(party, 'ana');
  const p = party.newPost(w.id, {});
  typeInto(party, clock, w, p, 'Persistent words here.');
  const { Party } = await import('../lib/party.js');
  const errors = [];
  const again = new Party({ state: JSON.parse(JSON.stringify(party.state)), now: clock.now, log: { error: (m) => errors.push(m) }, recomputeMinMs: 0 });
  assert.deepEqual(errors, []);
  assert.equal(again.engine.text(w.id, p.id, 'b'), 'Persistent words here.');
  clock.advance(2 * MIN);
  near(again.scoreOf(w.id).totals.credit, party.scoreOf(w.id).totals.credit);
  near(again.scoreOf(w.id).totals.credit, 3);
  assert.ok(makeClock && T0);
});

test('archive: excerpts drop headings and mark line breaks; no timestamps', () => {
  const { party, clock, host } = setup();
  const w = addUser(party, 'ana');
  const p = party.newPost(w.id, { title: 'Poem' });
  party.applyOps(w.id, { postId: p.id, pane: 'body', baseVersion: 0, ops: [{ pos: 0, del: 0, ins: '# Heading\n\nfirst line\nsecond line.\n\n> a quoted *line*' }] });
  clock.advance(MIN);
  party.end(host.id);
  const a = party.archiveView();
  assert.equal(a.posts[0].excerpt, 'first line / second line. a quoted line');
  assert.ok(!JSON.stringify(a).match(/"(t|at|startedAt|endedAt|createdAt|activeAt)"/));
});

test('late offline work into a judged missed hour goes to review; the writer stays out until the host decides', () => {
  const { party, clock, host } = setup();
  const w = addUser(party, 'ana');
  party.join(w.id);
  const p = party.newPost(w.id, {});
  typeInto(party, clock, w, p, realProse(12, 400)); // 12 words, then the wifi drops
  // The hour closes and is judged while the writer's queue is stuck offline.
  clock.set(w.joinedAt + 10 * MIN + JUDGED);
  party.tick();
  assert.equal(w.out, true);
  assert.equal(party.state.alerts.length, 1);
  // The queue arrives: 60 words typed during minutes 6-9, back-dated by the client's timing
  // (allowed: the server saw no request from this writer then).
  const sentAt = 9_000_000;
  const typedFrom = w.joinedAt + 6 * MIN;
  const text = ` ${realProse(60, 412)}`;
  const ops = [];
  let pos = party.state.posts[p.id].body.length;
  for (let i = 0; i < text.length; i++) {
    const at = sentAt - (clock.now() - (typedFrom + i * 500));
    ops.push({ at, pos: pos++, del: 0, ins: text[i] });
  }
  party.applyOps(w.id, { postId: p.id, pane: 'body', baseVersion: party.state.posts[p.id].ver.body, sentAt, ops });
  assert.equal(party.state.ops[w.id].at(-1)[0], typedFrom + (text.length - 1) * 500, 'credited when it was written');
  clock.advance(10 * SEC); // the next ticks settle the late words into hour 1
  party.tick();
  assert.equal(status(party, w.id)[0], 'review', 'met only thanks to late work: the host decides');
  assert.equal(w.out, true, 'late work never heals a closed hour silently');
  const al = party.state.alerts.find((a) => a.userId === w.id && a.k === 0);
  assert.equal(al.kind, 'review');
  assert.equal(al.ack, false);
  assert.ok(al.flags.includes('lateWork'));
  assert.ok(!party.state.log.some((l) => l.type === 'reinstate'));
  const rv = party.hostView(host.id).reviews.find((r) => r.userId === w.id && r.k === 0);
  const lf = rv.flags.find((f) => f.type === 'lateWork');
  assert.ok(lf.words >= 50, `late words ${lf.words}`);
  assert.ok(lf.from >= typedFrom && lf.to < w.joinedAt + 10 * MIN, 'the claimed offline window');
  assert.ok(lf.receivedAt > w.joinedAt + 10 * MIN);
  // Accept: met, and back in.
  party.adminReview(host.id, { id: w.id, k: 0, decision: 'accept' });
  assert.equal(status(party, w.id)[0], 'met');
  assert.equal(w.out, false);
  assert.ok(party.state.log.some((l) => l.type === 'reinstate'));
  // Don't count: missed, and out again.
  party.adminReview(host.id, { id: w.id, k: 0, decision: 'reject' });
  assert.equal(status(party, w.id)[0], 'missed');
  assert.equal(w.out, true);
});

test('back-filling an hour right after it ends is judged review, not met (no silent pass)', () => {
  const { party, clock } = setup();
  const w = addUser(party, 'idle');
  party.join(w.id);
  const p = party.newPost(w.id, {});
  // Nothing all hour; 20 s after the hour ends, one batch claims 60 words spread over it.
  clock.set(w.joinedAt + 10 * MIN + 20 * SEC);
  const sentAt = 7_000_000;
  const words = realProse(60, 150).split(' ');
  const ops = [];
  let pos = 0;
  words.forEach((wd, i) => {
    const ins = `${wd} `;
    ops.push({ at: sentAt - (clock.now() - (w.joinedAt + 30 * SEC + i * 8 * SEC)), pos, del: 0, ins });
    pos += ins.length;
  });
  party.applyOps(w.id, { postId: p.id, pane: 'body', baseVersion: 0, sentAt, ops });
  clock.set(w.joinedAt + 10 * MIN + JUDGED);
  party.tick();
  assert.equal(status(party, w.id)[0], 'review');
  assert.equal(w.out, false, 'review never puts anyone out on its own');
  const al = party.state.alerts.find((a) => a.userId === w.id);
  assert.equal(al.kind, 'review');
  assert.ok(al.flags.includes('lateWork'));
});

test('while a session is making requests, back-dated claims move to the receipt time', () => {
  const { party, clock } = setup({ hourLengthMin: 60 });
  const w = addUser(party, 'ana');
  party.createSession(w.id, 'tok-ana');
  party.join(w.id);
  const p = party.newPost(w.id, {});
  for (let i = 0; i < 120; i++) { // online for 10 minutes: a request every 5 s
    clock.advance(5 * SEC);
    party.seen('tok-ana');
  }
  const now = clock.now();
  const sentAt = 3_000_000;
  const ops = [];
  for (let i = 0; i < 10; i++) ops.push({ at: sentAt - (9 * MIN - i * 6 * SEC), pos: i * 6, del: 0, ins: 'words ' });
  party.applyOps(w.id, { postId: p.id, pane: 'body', baseVersion: 0, sentAt, ops }, { token: 'tok-ana' });
  const ts = party.state.ops[w.id].map((o) => o[0]);
  assert.ok(ts.every((t) => t >= now - ONLINE_SLACK_MS && t <= now), `times ${ts.map((t) => t - now)}`);
});

test('an honest offline spell keeps its timing, replayed after a reload and page-load requests', () => {
  const { party, clock } = setup({ hourLengthMin: 60, targetPerHour: 40 });
  const w = addUser(party, 'ana');
  party.createSession(w.id, 'tok-ana');
  party.join(w.id);
  const p = party.newPost(w.id, {});
  for (let i = 0; i < 24; i++) { // online for 2 minutes
    clock.advance(5 * SEC);
    party.seen('tok-ana');
  }
  const dropAt = clock.now();
  clock.advance(6 * MIN); // offline, tab closed; the words wait in the local queue
  party.seen('tok-ana'); // the tab reopens: page-load requests come first
  clock.advance(SEC);
  party.seen('tok-ana');
  clock.advance(2 * SEC);
  // The queue: 3 words typed just before the drop (their batch never arrived), then 50 offline.
  const claimed = [dropAt - 5 * SEC, dropAt - 3 * SEC, dropAt - SEC];
  for (let i = 0; i < 50; i++) claimed.push(dropAt + 10 * SEC + i * 6 * SEC);
  const words = realProse(53, 250).split(' ');
  const sentAt = 5_000_000;
  const ops = [];
  let pos = 0;
  words.forEach((wd, i) => {
    const ins = `${wd} `;
    ops.push({ at: sentAt - (clock.now() - claimed[i]), pos, del: 0, ins });
    pos += ins.length;
  });
  party.applyOps(w.id, { postId: p.id, pane: 'body', baseVersion: 0, sentAt, ops }, { token: 'tok-ana' });
  assert.deepEqual(party.state.ops[w.id].map((o) => o[0]), claimed, 'every op keeps the time it was typed');
  clock.advance(3 * MIN);
  const r = party.scoreOf(w.id, { fresh: true });
  assert.ok(!r.hours[0].flags.some((f) => f.type === 'lateWork'), 'not late: its hour is still open');
  assert.ok(r.hours[0].written >= 45, `written ${r.hours[0].written}`);
  assert.equal(r.hours[0].notCounted.overSpeed, 0);
});

test('§11 an hour met only with flagged credit goes to review: alert, no out; accept / reject', () => {
  const { party, clock, host } = setup({ targetPerHour: 150 });
  const w = addUser(party, 'ana', 'Ana');
  party.join(w.id);
  const p = party.newPost(w.id, {});
  const big = realProse(190, 0); // 190 words pasted and claimed: the hour needs 150 of them (§12: >= 100)
  pasteInto(party, w, p, big, 'all');
  clock.set(w.joinedAt + 10 * MIN + JUDGED);
  party.tick();
  assert.equal(status(party, w.id)[0], 'review');
  assert.equal(w.out, false, 'review never puts a writer out on its own');
  const al = party.state.alerts.find((a) => a.userId === w.id);
  assert.equal(al.kind, 'review');
  assert.ok(al.flags.includes('bigPaste'));
  const hv = party.hostView(host.id);
  assert.equal(hv.reviews.length, 1);
  assert.equal(hv.reviews[0].k, 0);
  assert.ok(hv.reviews[0].evidence.some((e) => e.kind === 'paste' && e.text.startsWith(big.slice(0, 30))));
  // Don't count: the hour is missed, so the writer is out (§10).
  party.adminReview(host.id, { id: w.id, k: 0, decision: 'reject' });
  assert.equal(status(party, w.id)[0], 'missed');
  assert.equal(w.out, true);
  assert.ok(party.state.alerts.some((a) => a.userId === w.id && a.kind === 'missed'));
  assert.equal(party.hostView(host.id).reviews.length, 0);
  // Changing the decision to accept: met, and back in.
  party.adminReview(host.id, { id: w.id, k: 0, decision: 'accept' });
  assert.equal(status(party, w.id)[0], 'met');
  assert.equal(w.out, false);
  assert.ok(party.state.log.some((l) => l.type === 'review-accept'));
  assert.throws(() => party.adminReview(host.id, { id: w.id, k: 0, decision: 'maybe' }), /decision/);
});

test('a break added mid-party scores the same in place as a full re-score', async () => {
  const { party, clock, host } = setup({ hourLengthMin: 10, targetPerHour: 20 });
  const w = addUser(party, 'ana');
  party.join(w.id);
  const p = party.newPost(w.id, {});
  typeInto(party, clock, w, p, realProse(30, 0), { cps: 3 });
  clock.advance(MIN);
  party.addBreak(host.id, { lengthMin: 5, label: 'Tea' }); // in place: no op after now
  clock.advance(6 * MIN);
  typeInto(party, clock, w, p, ` ${realProse(30, 40)}`, { cps: 3 });
  clock.advance(12 * MIN);
  party.tick();
  const live = party.scoreOf(w.id, { fresh: true });
  const { Party } = await import('../lib/party.js');
  const again = new Party({ state: JSON.parse(JSON.stringify(party.state)), now: clock.now, log: { error() {}, log() {} }, recomputeMinMs: 0 });
  const replayed = again.scoreOf(w.id, { fresh: true });
  assert.deepEqual(live.hours.map((h) => [h.k, h.startAt, h.endAt, h.credit]), replayed.hours.map((h) => [h.k, h.startAt, h.endAt, h.credit]));
  assert.equal(live.hours[0].endAt - live.hours[0].startAt, 15 * MIN, 'hour 1 stretched by the 5-minute break');
});
