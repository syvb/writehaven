// Settings changes re-score in the background: the old numbers keep serving until the new ones
// swap in; edits are debounced; previews run in a worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Party } from '../lib/party.js';
import { makeClock, quietLog, addUser, typeInto, startApp, client, sleep } from './helpers.js';
import { realProse, MIN } from './sim.js';

function asyncParty(settings = {}) {
  const clock = makeClock();
  const party = new Party({ now: clock.now, log: quietLog, recomputeMinMs: 0, asyncRescore: true, tz: 'UTC' });
  Object.assign(party.state.settings.scoring, { hourLengthMin: 10, targetPerHour: 50, approvalRequired: false, hoursMode: 'personal', ...settings });
  party.rebuildEngine({ sync: true });
  const host = addUser(party, 'host');
  party.start(host.id);
  return { party, clock, host };
}
const until = async (fn, ms = 10_000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timed out');
    await sleep(20);
  }
};

test('a settings change re-scores in the background and swaps in at once; edits are debounced', async () => {
  const { party, clock, host } = asyncParty();
  const w = addUser(party, 'ana');
  party.join(w.id);
  const p = party.newPost(w.id, {});
  typeInto(party, clock, w, p, realProse(40, 0), { cps: 6 });
  clock.advance(2 * MIN);
  const words = party.scoreOf(w.id, { fresh: true }).totals.credit;
  let runs = 0;
  const run = party.runRescore.bind(party);
  party.runRescore = () => { runs++; return run(); };
  party.setSettings(host.id, { unit: 'chars' });
  party.setSettings(host.id, { cutWeight: 0.6 }); // within the debounce: one run for both
  assert.equal(party.rescoring, true);
  assert.equal(party.state.settings.scoring.unit, 'chars', 'saved at once');
  assert.equal(party.S.unit, 'word', 'numbers still from the old settings');
  assert.equal(party.scoreOf(w.id, { fresh: true }).totals.credit, words);
  assert.equal(party.hostView(host.id).rescoring, true);
  await until(() => !party.rescoring);
  assert.equal(runs, 1);
  assert.equal(party.S.unit, 'chars');
  assert.equal(party.S.cutWeight, 0.6);
  const chars = party.scoreOf(w.id, { fresh: true }).totals.credit;
  assert.notEqual(chars, words);
  // Same numbers as a full re-score from scratch.
  const again = new Party({ state: JSON.parse(JSON.stringify(party.state)), now: clock.now, log: quietLog, recomputeMinMs: 0 });
  assert.equal(again.scoreOf(w.id, { fresh: true }).totals.credit, chars);
  // App-only settings apply at once, no re-score.
  party.setSettings(host.id, { missedHourOutcome: 'alert-only' });
  assert.equal(party.rescoring, false);
  assert.equal(party.S.missedHourOutcome, 'alert-only');
});

test('ops that arrive during a background re-score are in the new numbers; judging waits for it', async () => {
  const { party, clock, host } = asyncParty({ hourLengthMin: 60 });
  const ws = ['ana', 'bob', 'cy'].map((n) => addUser(party, n));
  const posts = ws.map((w) => {
    party.join(w.id);
    return party.newPost(w.id, {});
  });
  // A long log, so the re-score takes several slices.
  for (let r = 0; r < 6; r++) for (const [i, w] of ws.entries()) typeInto(party, clock, w, posts[i], ` ${realProse(60, (r * 60 + i * 20) % 400)}`, { cps: 20, perBatch: 50 });
  party.setSettings(host.id, { contextWords: 7 });
  party.rescoreTimer && clearTimeout(party.rescoreTimer);
  const done = party.runRescore();
  let during = 0;
  while (party.rescoring) {
    typeInto(party, clock, ws[0], posts[0], ' and then a few more words arrived', { cps: 20, perBatch: 50 });
    during++;
    party.tick(); // must not judge anything while re-scoring
    await new Promise((r) => setImmediate(r));
  }
  await done;
  assert.ok(during >= 1, 'ops arrived while it ran');
  clock.advance(2 * MIN);
  const live = party.scoreOf(ws[0].id, { fresh: true }).totals;
  const again = new Party({ state: JSON.parse(JSON.stringify(party.state)), now: clock.now, log: quietLog, recomputeMinMs: 0 });
  assert.deepEqual(again.scoreOf(ws[0].id, { fresh: true }).totals, live);
});

test('preview: which hours a change would flip, per writer (in-process)', async () => {
  const { party, clock, host } = asyncParty();
  const w = addUser(party, 'jonah', 'Jonah');
  party.join(w.id);
  const p = party.newPost(w.id, {});
  typeInto(party, clock, w, p, realProse(60, 0), { cps: 6 }); // 60 of 50: met
  clock.set(w.joinedAt + 12 * MIN);
  party.tick();
  // A speed limit of 5 words a minute would take hour 1 below 50.
  const r = await party.previewSettings(host.id, { patch: { speedCapWpm: 5 } });
  assert.deepEqual(r.changes, [{ writerId: w.id, name: 'Jonah', k: 0, hour: 1, from: 'met', to: 'missed' }]);
  assert.deepEqual((await party.previewSettings(host.id, { patch: {} })).changes, []);
  // A target change doesn't flip a judged hour (its target is frozen when judged).
  assert.deepEqual((await party.previewSettings(host.id, { patch: { targetPerHour: 400 } })).changes, []);
  assert.deepEqual((await party.previewSettings(host.id, { writers: [{ id: w.id, targetOverride: 400 }] })).changes, []);
  await assert.rejects(async () => party.previewSettings(host.id, { patch: { targetPerHour: -1 } }), /between/);
  assert.equal(party.rescoring, false, 'a preview changes nothing');
});

test('http: saving settings answers at once while the server keeps serving; the preview runs in a worker', async (t) => {
  const { base, close, app } = await startApp({ log: { error: (...a) => console.error('[server]', ...a), log() {}, warn() {} } });
  t.after(close);
  const host = client(base);
  await host.post('/api/register', { username: 'host', password: 'longpassword', name: 'Host' });
  await host.post('/api/admin/start', {});
  await host.post('/api/admin/settings', { scoring: { hourLengthMin: 0.5, settleSec: 1, settleQuantumSec: 1, targetPerHour: 15 } });
  await until(() => !app.party.rescoring);
  const w = client(base);
  await w.post('/api/register', { username: 'jonah', password: 'longpassword', name: 'Jonah' });
  await w.post('/api/join', {});
  const post = (await w.post('/api/post/new', {})).json.post;
  await w.post('/api/ops', { postId: post.id, pane: 'body', baseVersion: 0, ops: [{ pos: 0, del: 0, ins: `${realProse(20, 0)} ` }] });
  // Wait for hour 1 (30 s) to be judged met: 20 of 15.
  await until(() => app.party.progressOf(Object.values(app.party.state.users).find((u) => u.username === 'jonah').id, { fresh: true }).prog.hours[0]?.status === 'met', 45_000);
  await sleep(1500); // judged (the tick runs every 200 ms in tests)
  let r = await host.post('/api/host/settings/preview', { patch: { speedCapWpm: 2 } });
  assert.equal(r.status, 200);
  assert.equal(r.json.changes.length, 1);
  assert.deepEqual([r.json.changes[0].name, r.json.changes[0].hour, r.json.changes[0].from, r.json.changes[0].to], ['Jonah', 1, 'met', 'missed']);
  assert.ok(Number.isFinite(r.json.ms));
  r = await host.post('/api/admin/settings', { scoring: { speedCapWpm: 2 } });
  assert.equal(r.json.rescoring, true);
  assert.equal((await host.get('/api/host')).json.rescoring, true);
  await until(() => !app.party.rescoring);
  await sleep(500);
  const hv = (await host.get('/api/host')).json;
  assert.equal(hv.rescoring, false);
  const jonah = hv.writers.find((x) => x.username === 'jonah');
  assert.equal(jonah.progress.hours[0].status, 'missed');
  assert.equal(jonah.out, true, 'a re-score that makes a judged hour missed puts the writer out, as any miss');
});

test('http: the preview still answers when no worker thread can start (computed in slices instead)', async (t) => {
  let tries = 0;
  const makeWorker = () => {
    tries++;
    const e = new Error('Worker initialization failure: EAGAIN');
    e.code = 'ERR_WORKER_INIT_FAILED';
    throw e;
  };
  const { base, close, app } = await startApp({ makeWorker });
  t.after(close);
  const host = client(base);
  await host.post('/api/register', { username: 'host', password: 'longpassword', name: 'Host' });
  await host.post('/api/admin/start', {});
  const w = client(base);
  await w.post('/api/register', { username: 'jonah', password: 'longpassword', name: 'Jonah' });
  await w.post('/api/join', {});
  const post = (await w.post('/api/post/new', {})).json.post;
  await w.post('/api/ops', { postId: post.id, pane: 'body', baseVersion: 0, ops: [{ pos: 0, del: 0, ins: `${realProse(20, 0)} ` }] });
  app.party.state.users[Object.keys(app.party.state.users).find((id) => app.party.state.users[id].username === 'jonah')].joinedAt -= 61 * MIN;
  const r = await host.post('/api/host/settings/preview', { patch: { targetPerHour: 15 } });
  assert.equal(r.status, 200);
  assert.equal(tries, 3, 'retried, then computed in-process');
  assert.ok(Array.isArray(r.json.changes));
});
