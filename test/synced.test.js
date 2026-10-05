// Synced hours (SPEC §17 as changed by §17b: nobody waits) and break modes (SPEC §19).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeParty, makeClock, addUser, typeInto, startApp, client } from './helpers.js';
import { realProse, MIN, SEC } from './sim.js';

const H18 = Date.UTC(2026, 9, 4, 18, 0, 0); // 18:00 UTC; the party clock (log lines, :MM alignment) is UTC in tests
const at = (min) => H18 + min * MIN;
const JUDGED = 2 * MIN;

function synced({ startMin = 5, settings = {} } = {}) {
  const clock = makeClock(at(startMin));
  const { party } = makeParty({ clock, settings: { hoursMode: 'synced', syncMinute: 0, minFirstHourMin: 20, targetPerHour: 400, ...settings } });
  party.rebuildEngine({ sync: true });
  const host = addUser(party, 'host');
  party.start(host.id);
  return { party, clock, host };
}
const hoursOf = (party, u) => party.progressOf(u.id, { fresh: true }).prog.hours;
const hourOf = (party, u) => party.meView(u.id).me.hour;

test('§17b first opens at :10 and :30 get the rest of the window, pro-rated; at :45 the first hour runs to the end of the next window', () => {
  const { party, clock, host } = synced();
  const w10 = addUser(party, 'w10');
  const w30 = addUser(party, 'w30');
  const w45 = addUser(party, 'w45');
  clock.set(at(10));
  party.join(w10.id);
  clock.set(at(30));
  party.join(w30.id);
  clock.set(at(45));
  party.join(w45.id);
  assert.deepEqual(hourOf(party, w10), { index: 0, startAt: at(10), endAt: at(60), target: 333, baseTarget: 333, reducedBy: [], prorated: true, extended: false });
  assert.deepEqual([hourOf(party, w30).target, hourOf(party, w30).endAt], [200, at(60)]);
  assert.deepEqual(hourOf(party, w45), { index: 0, startAt: at(45), endAt: at(120), target: 400, baseTarget: 400, reducedBy: [], prorated: false, extended: true });
  const me = party.meView(w45.id).me;
  assert.equal(me.waitingUntil, undefined, 'nobody waits');
  assert.equal(me.firstHourAt, at(45));
  // In time order: w10 writes ~350 from 18:11 (meets 333), w30 writes 60 from 18:40 (misses
  // 200), w45 writes 60 from 18:46: they count towards the extended first hour.
  const p10 = party.newPost(w10.id, {});
  const p30 = party.newPost(w30.id, {});
  const p45 = party.newPost(w45.id, {});
  clock.set(at(11));
  for (let i = 0; i < 7; i++) {
    typeInto(party, clock, w10, p10, `${realProse(50, i * 50)} `, { cps: 6, perBatch: 30 });
    clock.advance(20 * SEC);
  }
  clock.set(at(40));
  typeInto(party, clock, w30, p30, realProse(60, 350), { cps: 6, perBatch: 30 }); // each writer's own words
  clock.set(at(46));
  typeInto(party, clock, w45, p45, realProse(60, 410), { cps: 6 });
  clock.set(at(49));
  const row = party.hostView(host.id).writers.find((x) => x.id === w45.id);
  assert.equal(row.status, 'on-track');
  assert.match(row.statusReason, /, first hour until \{t\}\.$/);
  assert.equal(row.statusReasonAt, at(120));
  clock.set(at(60) + JUDGED);
  party.tick();
  assert.equal(hoursOf(party, w10)[0].status, 'met');
  assert.equal(hoursOf(party, w30)[0].status, 'missed');
  assert.equal(hoursOf(party, w30)[0].target, 200);
  const h = hoursOf(party, w45);
  assert.equal(h.length, 1, 'still in hour 1 after 19:00');
  assert.equal(h[0].status, 'current');
  assert.ok(h[0].credited >= 55, `credited ${h[0].credited}`);
  assert.equal(w45.out, false);
  // The extended hour is judged at 20:00.
  clock.set(at(120) + JUDGED);
  party.tick();
  assert.equal(hoursOf(party, w45)[0].status, 'missed', '60 words of 400 by 20:00');
});

test('§17b a host start at :47: everyone’s first hour runs until the next :00 + 60; no countdown', () => {
  const { party, clock } = synced({ startMin: 47 });
  const live = party.liveView().party;
  assert.equal(live.hoursMode, 'synced');
  assert.equal(live.nextHourAt, at(60));
  assert.ok(!('writingStartsAt' in live), 'no "writing starts at" countdown');
  const w = addUser(party, 'ruth');
  clock.set(at(48));
  party.join(w.id);
  assert.deepEqual([hourOf(party, w).startAt, hourOf(party, w).endAt, hourOf(party, w).target, hourOf(party, w).extended], [at(48), at(120), 400, true]);
  const p = party.newPost(w.id, {});
  party.applyOps(w.id, { postId: p.id, pane: 'body', baseVersion: 0, ops: [{ pos: 0, del: 0, ins: 'Writing right away. ' }] });
  assert.equal(party.state.posts[p.id].body, 'Writing right away. ');
});

test('§19 a reduce-break inside one hour lowers its target by the overlap; the windows stay', () => {
  const { party, clock, host } = synced({ startMin: 0 });
  const w = addUser(party, 'ana');
  party.join(w.id);
  clock.set(at(10));
  const b = party.addBreak(host.id, { startAt: at(15), lengthMin: 30, label: 'Dinner' });
  assert.equal(b.mode, 'reduce', 'the default in synced mode');
  const h = hourOf(party, w);
  assert.deepEqual([h.startAt, h.endAt, h.baseTarget, h.target], [at(0), at(60), 400, 200]);
  assert.deepEqual(h.reducedBy, [{ breakId: b.id, minutes: 30 }]);
  // Writing during the break still counts; the next window is unmoved.
  clock.set(at(20));
  const p = party.newPost(w.id, {});
  typeInto(party, clock, w, p, realProse(30, 0), { cps: 6 });
  assert.equal(party.liveView().party.nextHourAt, at(60));
  assert.equal(party.liveView().party.breaks.active.mode, 'reduce');
  const row = party.hostView(host.id).writers.find((x) => x.id === w.id);
  assert.equal(row.status, 'break');
  assert.equal(row.statusReason, 'Dinner until {t}; this hour\'s target is 200.');
  assert.equal(row.statusReasonAt, at(45));
  assert.equal(row.pace.need, 200, 'pace uses the reduced target');
  // After the break: 15 writing minutes left (the target already allows for the break).
  clock.set(at(46));
  const r2 = party.hostView(host.id).writers.find((x) => x.id === w.id);
  assert.equal(r2.pace.minutesLeft, 14);
  assert.ok(r2.pace.perMinuteNeeded > 10, `per minute ${r2.pace.perMinuteNeeded}`);
});

test('§19 a reduce-break spanning two hours lowers both', () => {
  const { party, clock, host } = synced({ startMin: 0 });
  const w = addUser(party, 'ana');
  party.join(w.id);
  party.addBreak(host.id, { startAt: at(45), lengthMin: 30, label: 'Tea', mode: 'reduce' });
  clock.set(at(50));
  assert.deepEqual([hourOf(party, w).index, hourOf(party, w).target], [0, 300]);
  clock.set(at(80));
  assert.deepEqual([hourOf(party, w).index, hourOf(party, w).startAt, hourOf(party, w).target], [1, at(60), 300]);
  // The scorer judges with the same targets: 310 words in hour 1 meet it.
});

test('§19 a pause-break in synced mode shifts the shared windows; a writer arriving after it gets a pro-rated hour', () => {
  const { party, clock, host } = synced({ startMin: 0 });
  const w = addUser(party, 'ana');
  party.join(w.id);
  clock.set(at(20));
  const b = party.addBreak(host.id, { startAt: at(30), lengthMin: 30, label: 'Dinner', mode: 'pause' });
  assert.equal(b.mode, 'pause');
  assert.deepEqual([hourOf(party, w).endAt, hourOf(party, w).target], [at(90), 400]);
  clock.set(at(40));
  assert.equal(party.liveView().party.nextHourAt, at(90));
  const late = addUser(party, 'late');
  clock.set(at(65)); // 35 active minutes into the window: 25 left
  party.join(late.id);
  assert.deepEqual([hourOf(party, late).startAt, hourOf(party, late).endAt, hourOf(party, late).target], [at(65), at(90), 167]);
});

test('§19 changing a break’s mode mid-break re-scores (with preview); cancelling one restores the target', async () => {
  const { party, clock, host } = synced({ startMin: 0 });
  const w = addUser(party, 'ana');
  party.join(w.id);
  const p = party.newPost(w.id, {});
  clock.set(at(1));
  typeInto(party, clock, w, p, realProse(250, 0), { cps: 8, perBatch: 40 }); // ~250 words by 18:10
  clock.set(at(29));
  const b = party.addBreak(host.id, { startAt: at(30), lengthMin: 60, label: 'Dinner' }); // reduce: hour 1 → 200
  clock.set(at(60) + JUDGED);
  party.tick();
  assert.equal(hoursOf(party, w)[0].target, 200);
  assert.equal(hoursOf(party, w)[0].status, 'met');
  // Preview: as a pause-break, hour 1 wouldn't be over yet.
  const pr = await party.previewSettings(host.id, { breaks: [{ id: b.id, mode: 'pause' }] });
  assert.deepEqual(pr.changes.map((c) => [c.hour, c.from, c.to]), [[1, 'met', 'current']]);
  assert.equal(hoursOf(party, w)[0].status, 'met', 'a preview changes nothing');
  // The change itself: hour 1 now ends at 19:30 + 30 = 20:00, full target again.
  party.setBreakMode(host.id, { id: b.id, mode: 'pause' });
  assert.deepEqual([hourOf(party, w).index, hourOf(party, w).endAt, hourOf(party, w).target], [0, at(120), 400]);
  assert.ok(party.state.log.some((l) => l.type === 'break-mode'));
  assert.throws(() => party.setBreakMode(host.id, { id: b.id, mode: 'stop' }), /pause or reduce/);
  // Back to reduce, then cancel the rest of it: the target follows the break as it really was.
  party.setBreakMode(host.id, { id: b.id, mode: 'reduce' });
  assert.equal(hoursOf(party, w)[0].target, 200);
  clock.set(at(70));
  party.endBreak(host.id, { id: b.id }); // ends now: 18:30-19:10
  assert.deepEqual([hourOf(party, w).index, hourOf(party, w).target], [1, 333], 'hour 2 lost 10 minutes to the break');
});

test('§17b + §19 an extended first hour with a break: pause stretches it, reduce lowers its target', () => {
  for (const [mode, endAt, target] of [['pause', at(150), 400], ['reduce', at(120), 240]]) {
    const { party, clock, host } = synced();
    const w = addUser(party, 'ana');
    clock.set(at(45));
    party.join(w.id); // extended: 18:45-20:00
    party.addBreak(host.id, { startAt: at(70), lengthMin: 30, label: 'Dinner', mode });
    clock.set(at(75));
    const h = hourOf(party, w);
    assert.deepEqual([h.index, h.startAt, h.endAt, h.target, h.extended], [0, at(45), endAt, target, true], mode);
  }
});

test('synced vs personal: switching mid-party re-scores and previews; past hours are not judged again', async () => {
  const { party, clock, host } = synced({ settings: { targetPerHour: 50, hoursMode: 'personal' } });
  const w = addUser(party, 'ana');
  clock.set(at(30));
  party.join(w.id); // personal: hour 1 = 18:30-19:30
  const p = party.newPost(w.id, {});
  typeInto(party, clock, w, p, realProse(40, 0), { cps: 6 }); // 40 words < 50
  assert.equal(hourOf(party, w).endAt, at(90));
  clock.set(at(70));
  party.tick();
  const pr = await party.previewSettings(host.id, { patch: { hoursMode: 'synced' } });
  assert.deepEqual(pr.changes.map((c) => [c.hour, c.from, c.to]), [[1, 'current', 'met']]);
  party.setSettings(host.id, { hoursMode: 'synced' });
  assert.deepEqual([hourOf(party, w).index, hourOf(party, w).startAt, hourOf(party, w).endAt], [1, at(60), at(120)]);
  assert.equal(w.evaluatedThrough, 0, 'judging carries on from now');
  clock.set(at(72));
  party.tick();
  assert.equal(party.state.alerts.length, 0, 'no alert for an hour that ended before the switch');
  party.setSettings(host.id, { hoursMode: 'personal' });
  assert.equal(hourOf(party, w).endAt, at(90));
});

test('personal mode is unchanged: hour 1 starts at the first editor open, full target; breaks pause by default', () => {
  const { party, clock, host } = synced({ settings: { hoursMode: 'personal' } });
  const w = addUser(party, 'ana');
  clock.set(at(45));
  party.join(w.id);
  assert.deepEqual([hourOf(party, w).startAt, hourOf(party, w).endAt, hourOf(party, w).target, hourOf(party, w).prorated, hourOf(party, w).extended], [at(45), at(105), 400, false, false]);
  assert.deepEqual([party.liveView().party.hoursMode, party.liveView().party.nextHourAt], ['personal', null]);
  const b = party.addBreak(host.id, { startAt: at(50), lengthMin: 10 });
  assert.equal(b.mode, 'pause');
  assert.equal(hourOf(party, w).endAt, at(115));
});

test('http: synced writers write at once; break routes with mode; no ideas endpoint', async (t) => {
  const { base, close } = await startApp({ hoursMode: 'synced' });
  t.after(close);
  const host = client(base);
  await host.post('/api/register', { username: 'host', password: 'longpassword', name: 'Host' });
  await host.post('/api/admin/start', {});
  const w = client(base);
  await w.post('/api/register', { username: 'ruth', password: 'longpassword', name: 'Ruth' });
  assert.equal((await w.post('/api/join', {})).status, 200);
  const me = (await w.get('/api/me')).json.me;
  assert.ok(me.hour && Number.isFinite(me.hour.target) && typeof me.hour.extended === 'boolean');
  const post = (await w.post('/api/post/new', {})).json.post;
  assert.equal((await w.post('/api/ops', { postId: post.id, pane: 'body', baseVersion: 0, ops: [{ pos: 0, del: 0, ins: 'at once' }] })).status, 200);
  assert.equal((await w.post('/api/me/ideas', { text: 'x' })).status, 404);
  let r = await host.post('/api/host/breaks', { name: 'Dinner', minutes: 30, startsAt: Date.now() + 3600_000 });
  assert.equal(r.json.break.mode, 'reduce');
  r = await host.post(`/api/host/breaks/${r.json.break.id}`, { mode: 'pause' });
  assert.equal(r.status, 200);
  assert.equal(r.json.break.mode, 'pause');
  const hv = (await host.get('/api/host')).json;
  assert.equal(hv.party.breaks[0].mode, 'pause');
  const live = (await client(base).get('/api/live')).json.party;
  assert.equal(live.breaks.next.mode, 'pause');
  assert.ok(live.nextHourAt > Date.now());
  assert.equal((await host.post(`/api/host/breaks/${hv.party.breaks[0].id}/cancel`, {})).status, 200);
});
