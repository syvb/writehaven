// Leaving the party without being out (SPEC §33): from the hour a writer leaves in, no hour is
// judged (no alert, no out, no warning); hours already judged keep their result; coming back
// resumes like a first arrival (20+ minutes left: that hour, pro-rated; else the next hour).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeParty, makeClock, addUser, typeInto, startApp, client, sleep, quietLog } from './helpers.js';
import { realProse, MIN, SEC, T0 } from './sim.js';
import { attachNotify } from '../lib/notify.js';

// Personal hours from 17:00: hour 1 is 17:00–18:00, hour 2 18:00–19:00, and so on.
function setup(settings = {}) {
  const { party, clock } = makeParty({ settings: { hourLengthMin: 60, targetPerHour: 50, ...settings } });
  const host = addUser(party, 'host');
  party.start(host.id);
  return { party, clock, host };
}
const statuses = (party, u) => party.progressOf(u.id, { fresh: true }).prog.hours.map((h) => h.status);
const alertsOf = (party, u) => party.state.alerts.filter((a) => a.userId === u.id);
const write = (party, clock, u, words, seed = 0) => typeInto(party, clock, u, party.newPost(u.id, {}), `${realProse(words, seed)} `, { cps: 8 });

test('leaving mid-hour: that hour and every later one are neither met nor missed; no alert, no out; judged hours keep their result', () => {
  const { party, clock, host } = setup();
  const ana = addUser(party, 'ana');
  party.join(ana.id); // 17:00
  write(party, clock, ana, 60);
  clock.set(T0 + 62 * MIN);
  party.tick();
  assert.deepEqual(statuses(party, ana), ['met', 'current']);
  write(party, clock, ana, 8, 100); // a little of hour 2, far behind
  clock.set(T0 + 100 * MIN); // 18:40
  assert.deepEqual(party.setLeft(ana.id, ana.id, true), { left: true, leftAt: T0 + 100 * MIN });
  assert.equal(party.progressOf(ana.id).prog.current, null, 'no running hour to be behind in: no warning');
  assert.equal(party.passPreview(ana.id).k, 1); // (the pass endpoint refuses, below)
  assert.throws(() => party.takePass(ana.id, {}), (e) => e.status === 409 && e.extra.code === 'left');
  // Hours 2 and 3 end and settle: nothing is judged.
  clock.set(T0 + 182 * MIN);
  party.tick();
  assert.deepEqual(statuses(party, ana), ['met', 'left', 'left', 'left']);
  assert.equal(ana.out, false);
  assert.equal(alertsOf(party, ana).length, 0);
  assert.equal(ana.evaluatedThrough, 2, 'passed over, unjudged');
  const p = party.progressOf(ana.id).prog;
  assert.deepEqual([p.met, p.missed], [1, 0]);
  // They may still write: it streams, nothing is judged.
  write(party, clock, ana, 5, 200);
  // The host's table: neutral, never at risk or out.
  const row = party.hostView(host.id).writers.find((w) => w.id === ana.id);
  assert.equal(row.status, 'left');
  assert.equal(row.statusReasonAt, T0 + 100 * MIN);
  assert.match(row.statusReason, /^Left the party at \{t\}\./);
  assert.equal(row.leftAt, T0 + 100 * MIN);
  assert.equal(row.leftBy, ana.id);
  const sum = party.hostView(host.id).summary;
  assert.deepEqual([sum.left, sum.atRisk, sum.out], [1, 0, 0]);
  assert.equal(party.meView(ana.id).me.leftAt, T0 + 100 * MIN);
  assert.ok(party.state.log.some((l) => l.type === 'left' && l.userId === ana.id && l.by === null));
});

test('back with 20+ minutes left: that hour counts, pro-rated; with less: judging starts at the next hour', () => {
  const { party, clock, host } = setup();
  const ana = addUser(party, 'ana'); // back at 18:30: 30 minutes left of hour 2
  const ben = addUser(party, 'ben'); // back at 18:45: 15 minutes left, so hour 3 is his next
  const cal = addUser(party, 'cal'); // back at 18:30 but doesn't write enough: missed, out
  for (const u of [ana, ben, cal]) party.join(u.id);
  clock.set(T0 + 10 * MIN);
  for (const u of [ana, ben, cal]) party.setLeft(host.id, u.id, true); // the host marks them
  clock.set(T0 + 90 * MIN);
  party.setLeft(ana.id, ana.id, false);
  party.setLeft(host.id, cal.id, false);
  clock.set(T0 + 105 * MIN);
  party.setLeft(ben.id, ben.id, false);
  assert.ok(party.state.log.some((l) => l.type === 'back' && l.userId === ana.id && /hour 2 counts from now/.test(l.text)));
  assert.ok(party.state.log.some((l) => l.type === 'back' && l.userId === ben.id && /judging starts again with hour 3 at 19:00/.test(l.text)));
  const cur = (u) => party.progressOf(u.id).prog.current;
  assert.equal(cur(ana).target, 25, 'half an hour left: half the target');
  assert.equal(cur(ben), null, 'not judged until 19:00');
  write(party, clock, ana, 30);
  write(party, clock, cal, 5, 50);
  clock.set(T0 + 122 * MIN);
  party.tick();
  assert.deepEqual(statuses(party, ana), ['left', 'met', 'current']);
  assert.equal(party.progressOf(ana.id).prog.hours[1].target, 25);
  assert.deepEqual(statuses(party, cal), ['left', 'missed', 'current']);
  assert.equal(cal.out, true, 'judged as usual once back');
  assert.equal(alertsOf(party, cal).length, 1);
  assert.deepEqual(statuses(party, ben), ['left', 'left', 'current']);
  assert.equal(cur(ben).target, 50, 'the next hour has the full target');
  assert.equal(ben.out, false);
  // The scorer judges with the same pro-rated target (one target rule).
  assert.equal(party.engine.result(ana.id, clock.now()).hours[1].target, 25);
  // A re-score, and a settings preview, keep all of that.
  const before = [ana, ben, cal].map((u) => statuses(party, u));
  party.setSettings(host.id, { speedCapWpm: 91 });
  clock.advance(5 * SEC);
  party.tick();
  assert.deepEqual([ana, ben, cal].map((u) => statuses(party, u)), before);
  assert.equal(party.progressOf(ana.id).prog.hours[1].target, 25);
  return party.previewSettings(host.id, { patch: { targetPerHour: 60 } }).then((r) => {
    assert.ok(!r.changes.some((c) => c.writerId === ben.id && c.k <= 1), JSON.stringify(r.changes));
    assert.ok(!r.changes.some((c) => c.k === 0), 'left hours stay left in the preview');
  });
});

test('left and back in the same hour with 20+ minutes left: that hour is judged, pro-rated', () => {
  const { party, clock } = setup();
  const ana = addUser(party, 'ana');
  party.join(ana.id);
  clock.set(T0 + 5 * MIN);
  party.setLeft(ana.id, ana.id, true);
  clock.set(T0 + 15 * MIN);
  party.setLeft(ana.id, ana.id, false);
  assert.equal(party.progressOf(ana.id).prog.current.target, 38, '45 of 60 minutes left');
  write(party, clock, ana, 40);
  clock.set(T0 + 62 * MIN);
  party.tick();
  assert.deepEqual(statuses(party, ana), ['met', 'current']);
});

test('the routes: the host marks anyone, a writer only themself; both logged; refused outside the party', async (t) => {
  const { base, app, close } = await startApp();
  t.after(close);
  const host = client(base);
  await host.post('/api/register', { username: 'host', password: 'longpassword', name: 'Host' });
  const ana = client(base);
  const anaId = (await ana.post('/api/register', { username: 'ana', password: 'longpassword', name: 'Ana' })).json.user.id;
  const ben = client(base);
  const benId = (await ben.post('/api/register', { username: 'ben', password: 'longpassword', name: 'Ben' })).json.user.id;
  let r = await ana.post('/api/me/left', { left: true });
  assert.deepEqual([r.status, r.json.code], [409, 'not-running']);
  await host.post('/api/admin/start', {});
  r = await host.post('/api/host/writer/left', { id: anaId, left: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.left, true);
  assert.ok(Number.isFinite(r.json.leftAt));
  assert.equal((await host.post('/api/admin/writer/left', { id: anaId, left: true })).json.leftAt, r.json.leftAt, 'idempotent (and the /api/admin spelling works)');
  assert.equal((await ana.get('/api/me')).json.me.leftAt, r.json.leftAt);
  // A writer can't mark someone else, under either name; no id is a 404 for the host.
  assert.equal((await ben.post('/api/host/writer/left', { id: anaId, left: false })).status, 404);
  assert.equal((await ben.post('/api/admin/writer/left', { id: anaId, left: false })).status, 404);
  assert.equal((await host.post('/api/host/writer/left', { id: 'nobody', left: true })).status, 404);
  assert.equal((await host.post('/api/host/writer/left', { id: anaId, left: 'yes' })).status, 400);
  assert.equal((await ben.post('/api/me/left', { left: 'no' })).status, 400);
  // Back by themself; then Ben leaves by himself.
  r = await ana.post('/api/me/left', { left: false });
  assert.deepEqual(r.json, { ok: true, left: false, leftAt: null });
  assert.equal((await ben.post('/api/me/left', { left: true })).status, 200);
  const v = (await host.get('/api/host')).json;
  assert.equal(v.writers.find((w) => w.id === benId).status, 'left');
  assert.equal(v.writers.find((w) => w.id === anaId).leftAt, null);
  const log = v.log.filter((l) => l.type === 'left' || l.type === 'back').map((l) => [l.type, l.name, l.byName]);
  assert.deepEqual(log, [['left', 'Ana', 'Host'], ['back', 'Ana', null], ['left', 'Ben', null]]);
  assert.equal(app.party.userById(anaId).leaves.length, 1);
  await host.post('/api/admin/end', {});
  assert.equal((await ana.post('/api/me/left', { left: true })).status, 409);
});

test('the public list of writers shows "left", never "out", as of the same time as its numbers', () => {
  for (const hoursMode of ['synced', 'personal']) {
    const { party, clock, host } = setup({ hoursMode });
    const ana = addUser(party, 'ana');
    party.join(ana.id);
    party.setPublicProfile(ana.id, true);
    clock.set(T0 + 40 * MIN); // 17:40, in hour 1: nothing written, but nothing is judged
    party.setLeft(ana.id, ana.id, true);
    const line = () => party.writersView().writers.find((w) => w.name === 'ANA');
    if (hoursMode === 'personal') {
      // Personal hours: public numbers are read as of the last full clock hour (17:00 here).
      assert.equal(line().left, false, 'not before the next full hour');
    }
    clock.set(T0 + 65 * MIN);
    party.tick();
    assert.equal(line().left, true, hoursMode);
    assert.equal(line().out, false, hoursMode);
    assert.equal(ana.out, false);
    assert.equal(party.hostView(host.id).writers.find((w) => w.id === ana.id).status, 'left');
  }
});

test('leaving survives a restart: still left, still unjudged; back after the restart resumes judging', async (t) => {
  let now = T0;
  const first = await startApp({ saveMs: 50, now: () => now });
  t.after(() => first.close());
  const host = client(first.base);
  await host.post('/api/register', { username: 'host', password: 'longpassword', name: 'Host' });
  await host.post('/api/admin/start', {});
  first.app.party.state.settings.scoring.targetPerHour = 50;
  first.app.party.S.targetPerHour = 50;
  const ana = client(first.base);
  const anaId = (await ana.post('/api/register', { username: 'ana', password: 'longpassword', name: 'Ana' })).json.user.id;
  await ana.post('/api/join', {});
  now = T0 + 20 * MIN;
  const leftAt = (await ana.post('/api/me/left', { left: true })).json.leftAt;
  assert.equal(leftAt, T0 + 20 * MIN);
  await sleep(100);
  await first.close();
  now = T0 + 70 * MIN;
  const second = await startApp({ stateFile: first.stateFile, now: () => now });
  t.after(() => second.close());
  const P = second.app.party;
  P.tick();
  const u = P.userById(anaId);
  assert.equal(u.leftAt, leftAt);
  assert.deepEqual(P.progressOf(anaId, { fresh: true }).prog.hours.map((h) => h.status), ['left', 'left']);
  assert.equal(u.out, false);
  const ana2 = client(second.base);
  await ana2.post('/api/login', { username: 'ana', password: 'longpassword' });
  assert.equal((await ana2.post('/api/me/left', { left: false })).status, 200);
  assert.equal(P.progressOf(anaId).prog.current.target, 42, 'back at 18:10: 50 minutes left of hour 2');
  assert.deepEqual(u.leaves.map((x) => [x.at, x.backAt]), [[T0 + 20 * MIN, T0 + 70 * MIN]]);
});

test('notifications: no 15-minute warning, no break notices, no "out" for someone who left', async () => {
  const clock = makeClock(T0);
  const ctx = await startApp({ now: clock.now });
  const notify = attachNotify(ctx.app, { dir: path.dirname(ctx.stateFile), log: quietLog, autoMs: 3_600_000, warnMs: 3_600_000, push: { allowHttp: true, allowHosts: ['127.0.0.1'] } });
  try {
    const party = ctx.app.party;
    const host = client(ctx.base);
    await host.post('/api/register', { username: 'host', password: 'longpassword', name: 'Host' });
    await host.post('/api/admin/start', {});
    const ana = client(ctx.base);
    const anaId = (await ana.post('/api/register', { username: 'ana', password: 'longpassword', name: 'Ana' })).json.user.id;
    await ana.post('/api/join', {});
    typeInto(party, clock, party.userById(anaId), party.newPost(anaId, {}), realProse(10, 0));
    await ana.post('/api/me/left', { left: true });
    const hourEnd = T0 + 60 * MIN;
    clock.set(hourEnd - 14 * MIN);
    notify.warnTick();
    await host.post('/api/admin/break', { name: 'Dinner', minutes: 20 });
    notify.autoTick();
    clock.set(hourEnd + 30 * MIN);
    party.tick();
    notify.autoTick();
    const notices = (await ana.get('/api/me/notices')).json.notices;
    assert.deepEqual(notices.map((n) => n.kind), [], JSON.stringify(notices));
    assert.equal(party.userById(anaId).out, false);
    assert.equal(party.state.alerts.length, 0);
  } finally {
    notify.stop?.();
    await ctx.close();
  }
});

test('a left writer’s words still count and show (me, Details, the host view, words today); only judging stops', () => {
  const { party, clock, host } = setup();
  const ana = addUser(party, 'ana');
  party.join(ana.id);
  clock.set(T0 + 10 * MIN);
  party.setLeft(ana.id, ana.id, true);
  clock.set(T0 + 20 * MIN);
  write(party, clock, ana, 30);
  clock.set(T0 + 25 * MIN); // settled
  const me = party.meView(ana.id);
  assert.equal(me.progress.current, null, 'nothing judged: no target, never behind');
  assert.equal(me.progress.leftNow.k, 0);
  assert.equal(me.progress.leftNow.left, true);
  assert.ok(me.progress.leftNow.credited >= 29, `this hour's words: ${me.progress.leftNow.credited}`);
  assert.ok(me.progress.currentBreakdown.written >= 29, 'Details: this hour as usual');
  assert.ok(me.progress.totals.written >= 29, 'Details: today as usual');
  const row = party.hostView(host.id).writers.find((w) => w.id === ana.id);
  assert.equal(row.status, 'left');
  assert.ok(row.progress.leftNow.credited >= 29);
  assert.ok(row.totals.credit >= 29);
  assert.ok(party.totals().wordsToday >= 30, 'words today');
  // The hour ends: not judged, its words still shown.
  clock.set(T0 + 62 * MIN);
  party.tick();
  const h0 = party.meView(ana.id).progress.hours[0];
  assert.equal(h0.status, 'left');
  assert.ok(h0.credited >= 29);
  assert.ok(party.hostView(host.id).writers.find((w) => w.id === ana.id).progress.hours[0].credited >= 29);
  assert.equal(ana.out, false);
  assert.equal(party.state.alerts.length, 0);
});
