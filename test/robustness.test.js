// Server robustness: one target rule for the scorer and the dashboard, judged hours vs
// re-scores, flagged credit as a union, private text out of the cross-writer index, short
// openings, the state saver's publish order, a crash before a writer's first journal line, and
// batch ids remembered for the whole party.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Party } from '../lib/party.js';
import { score } from '../lib/score.js';
import { makeParty, addUser, typeInto, pasteInto, tmpStateFile, sleep, startApp, client } from './helpers.js';
import { realProse, MIN, SEC } from './sim.js';

const T0 = Date.UTC(2026, 9, 4, 17, 0, 0);

test('a host override is the target in the scorer too (a pro-rated first hour doesn’t win)', () => {
  const { party, clock } = makeParty({ settings: { hoursMode: 'synced', settleSec: 2, settleQuantumSec: 1 } });
  clock.set(T0);
  party.rebuildEngine({ sync: true });
  const host = addUser(party, 'host');
  party.start(host.id);
  const w = addUser(party, 'ana');
  clock.set(T0 + 30 * MIN);
  party.join(w.id); // pro-rated first hour: 200
  assert.equal(party.meView(w.id).me.hour.target, 200);
  party.adminWriter(host.id, { id: w.id, targetOverride: 460 });
  assert.equal(party.meView(w.id).me.hour.target, 460);
  clock.set(T0 + 62 * MIN);
  assert.equal(party.engine.result(w.id, clock.now()).hours[0].target, 460, 'the scorer judges with the same target');
});

test('a target change doesn’t flip a judged hour; a re-score that does change one updates out and alerts', () => {
  const { party, clock, } = makeParty({ settings: { hourLengthMin: 10, targetPerHour: 5 } });
  const host = addUser(party, 'host');
  party.start(host.id);
  const w = addUser(party, 'ana');
  party.join(w.id);
  const p = party.newPost(w.id, {});
  typeInto(party, clock, w, p, realProse(20, 0), { cps: 8 });
  clock.set(w.joinedAt + 12 * MIN);
  party.tick();
  const hour0 = () => party.progressOf(w.id, { fresh: true }).prog.hours[0];
  assert.equal(hour0().status, 'met');
  party.setSettings(host.id, { targetPerHour: 400 });
  clock.advance(5 * SEC);
  party.tick();
  assert.deepEqual([hour0().status, hour0().target], ['met', 5], 'judged at 5, stays met');
  assert.equal(party.meView(w.id).progress.current.target, 400, 'the running hour has the new target');
  // A speed limit of 2 words a minute takes most of hour 1's credit: met → missed, enforced.
  party.setSettings(host.id, { speedCapWpm: 2 });
  clock.advance(5 * SEC);
  party.tick();
  assert.equal(hour0().status, 'missed');
  assert.equal(w.out, true, 'the miss is enforced like any other');
  assert.ok(party.state.alerts.some((a) => a.userId === w.id && a.k === 0 && a.kind === 'missed'));
  assert.ok(party.state.log.some((l) => l.type === 'rescored' && /met → missed/.test(l.text)));
  // And back: met again, back in, alert closed.
  party.setSettings(host.id, { speedCapWpm: 90 });
  clock.advance(5 * SEC);
  party.tick();
  assert.equal(hour0().status, 'met');
  assert.equal(w.out, false);
  assert.ok(party.state.alerts.filter((a) => a.userId === w.id && a.k === 0).every((a) => a.ack));
});

test('flagged credit is a union: a word under two flags is flagged once', () => {
  // 418 honest words typed with pauses, then 80 words of mash in one op: macro-sized insert AND keyboard mash.
  const ops = [];
  let t = 0;
  let pos = 0;
  const put = (ins) => {
    ops.push({ t, post: 'p', pane: 'body', pos, del: 0, ins, source: 'type' });
    pos += ins.length;
  };
  const honest = `${realProse(400, 0)} ${realProse(30, 400)}`.split(' ').slice(0, 418);
  for (let i = 0; i < honest.length; i++) {
    put(`${honest[i]} `);
    t += i % 8 === 7 ? 3000 : 600;
  }
  t += 60_000;
  let seed = 5;
  let mash = '';
  for (let i = 0; i < 80; i++) {
    let w = '';
    for (let j = 0; j < 5; j++) {
      seed = (seed * 16807) % 2147483647;
      w += 'qwrtzxcvbnmlkjhgfdsp'[seed % 20];
    }
    mash += `${w} `;
  }
  put(mash);
  const h = score(ops, { targetPerHour: 400, hourLengthMin: 60 }, { joinedAt: 0, now: 62 * MIN }).hours[0];
  const types = h.flags.map((f) => f.type);
  assert.ok(types.includes('bulkInsert') && types.includes('gibberish'), types.join(','));
  assert.ok(Math.abs(h.flaggedCredit - 80) < 1, `flagged ${h.flaggedCredit} (each mash word once)`);
  assert.ok(h.credit - h.flaggedCredit >= 400, 'the honest words alone meet the hour');
  assert.equal(h.status, 'met');
});

test('private text can’t be probed through one’s own “other writers’ text” count; the paste check needs an approved owner', () => {
  const { party, clock } = makeParty({ settings: { settleSec: 2, settleQuantumSec: 1, hourLengthMin: 60, approvalRequired: true } });
  const host = addUser(party, 'host');
  party.start(host.id);
  const alice = addUser(party, 'alice');
  const bob = addUser(party, 'bob');
  party.approveAll(host.id);
  party.join(alice.id);
  party.join(bob.id);
  const note = 'my private diary entry about the clandestine midnight rendezvous downtown tonight';
  const separate = 'a separate identity story about the lighthouse keeper and his violin collection';
  const hidden = 'personal content the host hid about the hospital visit last winter evening';
  const open = 'the harbour lights went out one by one while the ferry waited for nobody';
  const a1 = party.newPost(alice.id, {});
  const a2 = party.newPost(alice.id, {});
  const a3 = party.newPost(alice.id, {});
  party.updatePost(alice.id, { id: a2.id, privacy: 'separate' });
  typeInto(party, clock, alice, a1, note, { pane: 'notes', cps: 50 });
  typeInto(party, clock, alice, a1, `${open} `, { cps: 50 });
  typeInto(party, clock, alice, a2, separate, { cps: 50 });
  typeInto(party, clock, alice, a3, hidden, { cps: 50 });
  party.adminPost(host.id, { id: a3.id, unlisted: true });
  clock.advance(10 * SEC);
  const b = party.newPost(bob.id, {});
  const other = () => party.meView(bob.id).progress.totals.nc.otherWriter;
  for (const guess of [note, separate, hidden]) {
    typeInto(party, clock, bob, b, ` ${guess}`, { cps: 50 });
    clock.advance(10 * SEC);
    assert.equal(other(), 0, `a guess at private text isn't reported: ${guess.slice(0, 20)}`);
  }
  typeInto(party, clock, bob, b, ` ${open}`, { cps: 50 });
  clock.advance(10 * SEC);
  assert.ok(other() >= 8, `a copy of public text still counts as another writer's (${other()})`);
  assert.ok(party.pasteCheck(bob.id, open).other.includes('1'));
  party.decline(host.id, { id: alice.id });
  assert.ok(!party.pasteCheck(bob.id, open).other.includes('1'), 'a declined writer’s text isn’t revealed');
});

test('a retried batch is never applied twice: however many batches followed it, and after restarts', async (t) => {
  const open = new Set();
  t.after(async () => { for (const a of open) await a.close(); });
  const boot = async (o) => { const a = await startApp(o); open.add(a); const close = a.close; a.close = async () => { open.delete(a); await close(); }; return a; };
  const first = await boot({ saveMs: 50 });
  const host = client(first.base);
  await host.post('/api/register', { username: 'host', password: 'longpassword', name: 'Host' });
  await host.post('/api/admin/start', {});
  const w = client(first.base);
  await w.post('/api/register', { username: 'ana', password: 'longpassword', name: 'Ana' });
  const post = (await w.post('/api/post/new', { title: 'D' })).json.post;
  const S1 = { postId: post.id, pane: 'body', baseVersion: 0, baseLen: 0, seq: 'S1', ops: [{ pos: 0, del: 0, ins: 'hello ' }] };
  assert.equal((await w.post('/api/ops', S1)).json.version, 1); // its answer is "lost"
  let v = 1;
  const other = async (n) => {
    for (let i = 0; i < n; i++) {
      const r = await w.post('/api/ops', { postId: post.id, pane: 'body', baseVersion: v, baseLen: 5 + v, seq: `B${v}`, ops: [{ pos: 5 + v, del: 0, ins: '!' }] });
      assert.equal(r.status, 200);
      v = r.json.version;
    }
  };
  const text = () => `hello ${'!'.repeat(v - 1)}`;
  const check = async (c, label, { base }) => {
    const r = await c.post('/api/ops', S1);
    assert.equal(r.status, 409, label);
    assert.equal(r.json.duplicate, true, label);
    assert.equal(r.json.appliedVersion, 1, label);
    assert.equal(r.json.version, v, label);
    assert.equal(r.json.text, text(), label);
    assert.deepEqual(r.json.base, base, label);
    assert.equal((await c.get(`/api/post?id=${post.id}&pane=body`)).json.text, text(), `${label}: not applied again`);
  };
  await other(64); // the old window remembered 64 batch ids
  await check(w, 'after 64 batches', { base: { version: 1, text: 'hello ' } });
  await other(236); // past the 200 batches kept for merges: still a duplicate, merge from your own copy
  await check(w, 'after 300 batches', { base: null });
  // A duplicate that other batches followed is answered once the pane's journal lines have landed.
  const orig = first.app.party.onBatch;
  let open1;
  const gate = new Promise((r) => { open1 = r; });
  first.app.party.onBatch = (uid, rec) => {
    const d = orig(uid, rec);
    const held = d.then((x) => gate.then(() => x));
    held.written = d.written.then(() => gate);
    return held;
  };
  const next = w.post('/api/ops', { postId: post.id, pane: 'body', baseVersion: v, baseLen: 5 + v, seq: `B${v}`, ops: [{ pos: 5 + v, del: 0, ins: '!' }] });
  await sleep(50);
  let settled = false;
  const retry = w.post('/api/ops', S1).then((r) => { settled = true; return r; });
  await sleep(200);
  assert.equal(settled, false, 'the duplicate waits for the journal');
  open1();
  v = (await next).json.version;
  const r = await retry;
  assert.equal(r.status, 409);
  assert.equal(r.json.duplicate, true);
  first.app.party.onBatch = orig;
  const lastSeq = `B${v - 1}`;
  await sleep(100);
  await first.close();
  // After a restart (the journal restores every batch id): both kinds of duplicate.
  const second = await boot({ stateFile: first.stateFile });
  const w2 = client(second.base);
  await w2.post('/api/login', { username: 'ana', password: 'longpassword' });
  await check(w2, 'after a restart', { base: null });
  const again = await w2.post('/api/ops', { postId: post.id, pane: 'body', baseVersion: v - 1, baseLen: 4 + v, seq: lastSeq, ops: [{ pos: 4 + v, del: 0, ins: '!' }] });
  assert.equal(again.status, 200);
  assert.equal(again.json.duplicate, true);
  assert.equal(again.json.version, v);
  assert.equal(again.json.text, text(), 'after a restart the server can’t tell if it was cleaned: the text comes along');
  await second.close();
  const third = await boot({ stateFile: first.stateFile });
  const w3 = client(third.base);
  await w3.post('/api/login', { username: 'ana', password: 'longpassword' });
  await check(w3, 'after a second restart', { base: null });
  await third.close();
});

test('state saves land in order: an older background save never replaces a newer one, nor a shutdown save', async (t) => {
  const { createSaver } = await import('../lib/store.js');
  const file = tmpStateFile();
  let n = 0;
  const saver = createSaver(file, () => ({ n }), { delayMs: 10_000, log: { error() {} } });
  // The thread pool finishes renames in any order: hold the first save's rename back.
  const rename = fs.promises.rename;
  t.after(() => { fs.promises.rename = rename; });
  let firstCalled = false;
  fs.promises.rename = async (from, to) => {
    if (/-bg1$/.test(from)) {
      firstCalled = true;
      await sleep(150);
    } else for (let i = 0; i < 30 && !firstCalled; i++) await sleep(10);
    return rename(from, to);
  };
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8')).n;
  n = 1;
  saver.schedule();
  const a = saver.flushAsync();
  n = 2;
  saver.schedule();
  const b = saver.flushAsync();
  await Promise.all([a, b]);
  await sleep(200);
  assert.equal(read(), 2, 'the newer of two background saves stays');
  // A background save in flight, then the synchronous shutdown save.
  n = 3;
  saver.schedule();
  const c = saver.flushAsync();
  await sleep(5);
  n = 4;
  saver.schedule();
  saver.flush();
  assert.equal(read(), 4);
  await c;
  await sleep(200);
  assert.equal(read(), 4, 'the shutdown save stays');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp-')), [], 'no temp files left');
});

test('a shared short opening (“The …”) isn’t copied writing: not another writer’s, not a repeat of one’s own other post', () => {
  const { party, clock } = makeParty({ settings: { hourLengthMin: 60 } }); // words settle after 90 s, as at the party
  const host = addUser(party, 'host');
  party.start(host.id);
  const alice = addUser(party, 'alice');
  const bob = addUser(party, 'bob');
  party.join(alice.id);
  party.join(bob.id);
  const nc = (u) => party.meView(u.id).progress.totals.nc;
  typeInto(party, clock, alice, party.newPost(alice.id, {}), 'The quiet rain arrived suddenly before midnight. ', { cps: 6 });
  clock.advance(2 * MIN);
  typeInto(party, clock, bob, party.newPost(bob.id, {}), 'The quiet meal included fresh vegetables and bread. ', { cps: 6 });
  clock.advance(2 * MIN);
  assert.equal(nc(bob).otherWriter, 0, 'two words in common at the start of a post');
  // One's own two posts that open alike.
  typeInto(party, clock, alice, party.newPost(alice.id, {}), 'The quiet garden woke before the birds did. ', { cps: 6 });
  clock.advance(2 * MIN);
  assert.equal(nc(alice).repeat, 0);
  // Six words in common still count as another writer's text.
  typeInto(party, clock, bob, party.newPost(bob.id, {}), 'The quiet rain arrived suddenly before dawn. ', { cps: 6 });
  clock.advance(2 * MIN);
  assert.ok(nc(bob).otherWriter >= 4, `a copied opening (${nc(bob).otherWriter})`);
});

test('cut text that comes back at the start of its pane still gives its cut credit back', () => {
  const ops = [];
  let t = 0;
  const text = 'Silver moths circled the lamp all night long. ';
  for (let i = 0; i < text.length; i++, t += 200) ops.push({ t, post: 'p', pane: 'body', pos: i, del: 0, ins: text[i], source: 'type' });
  const typed = score(ops, { targetPerHour: 400, hourLengthMin: 60 }, { joinedAt: 0, now: 20 * MIN }).hours[0];
  t = 15 * MIN;
  ops.push({ t, post: 'p', pane: 'body', pos: 0, del: text.length, ins: '', source: 'type' }); // cut after it matured
  ops.push({ t: t + 30 * SEC, post: 'p', pane: 'body', pos: 0, del: 0, ins: text, source: 'type' }); // undone
  const back = score(ops, { targetPerHour: 400, hourLengthMin: 60 }, { joinedAt: 0, now: 25 * MIN }).hours[0];
  assert.ok(Math.abs(back.credit - typed.credit) < 0.01, `no gain from cutting and restoring (${typed.credit} → ${back.credit})`);
});

test('a crash before a writer’s first journal line: the unacknowledged batch is sent again and applies; nothing gets out of step', () => {
  for (const variant of ['no file', 'empty file']) {
    const { party, clock } = makeParty();
    const host = addUser(party, 'host');
    party.start(host.id);
    const w = addUser(party, 'ana');
    const post = party.newPost(w.id, {});
    party.applyOps(w.id, { postId: post.id, pane: 'body', baseVersion: 0, seq: 'S1', ops: [{ pos: 0, del: 0, ins: 'hello' }] });
    // The state file was saved with that batch in it; its journal line never landed.
    const state = JSON.parse(JSON.stringify(party.snapshot()));
    const P = new Party({ state, journal: variant === 'no file' ? {} : { [w.id]: [] }, now: clock.now, log: { error() {}, log() {}, warn() {} }, recomputeMinMs: 0, tz: 'UTC' });
    const p = P.state.posts[post.id];
    assert.deepEqual([p.body, p.ver.body, p.words], ['', 0, 0], variant);
    assert.deepEqual(P.applyOps(w.id, { postId: post.id, pane: 'body', baseVersion: 0, baseLen: 0, seq: 'S1', ops: [{ pos: 0, del: 0, ins: 'hello' }] }), { version: 1 }, `${variant}: the retry applies`);
    assert.deepEqual(P.applyOps(w.id, { postId: post.id, pane: 'body', baseVersion: 1, seq: 'S2', ops: [{ pos: 5, del: 0, ins: ' world' }] }), { version: 2 });
    assert.equal(P.engine.text(w.id, post.id, 'b'), 'hello world');
  }
  // A state file moved without its journal directory keeps its texts; a batch that the scorer
  // can't place is refused before anything is journaled.
  const { party, clock } = makeParty();
  const host = addUser(party, 'host');
  party.start(host.id);
  const w = addUser(party, 'ana');
  const post = party.newPost(w.id, {});
  party.applyOps(w.id, { postId: post.id, pane: 'body', baseVersion: 0, seq: 'S1', ops: [{ pos: 0, del: 0, ins: 'kept text' }] });
  const P = new Party({ state: JSON.parse(JSON.stringify(party.snapshot())), journal: {}, journalFresh: true, now: clock.now, log: { error() {}, log() {}, warn() {} }, recomputeMinMs: 0, tz: 'UTC' });
  assert.equal(P.state.posts[post.id].body, 'kept text');
  let journaled = 0;
  P.onBatch = () => { journaled++; return null; };
  assert.throws(() => P.applyOps(w.id, { postId: post.id, pane: 'body', baseVersion: 1, seq: 'S2', ops: [{ pos: 9, del: 0, ins: '!' }] }), (e) => e.status === 500 && e.extra.code === 'out-of-step');
  assert.equal(journaled, 0);
});

test('the journal directory exists from the first boot; a writer whose journal file is missing has no words', async (t) => {
  const first = await startApp({ saveMs: 50 });
  t.after(() => first.close());
  assert.ok(fs.existsSync(`${first.stateFile}.ops`), 'made at boot');
  const host = client(first.base);
  await host.post('/api/register', { username: 'host', password: 'longpassword', name: 'Host' });
  await host.post('/api/admin/start', {});
  const w = client(first.base);
  await w.post('/api/register', { username: 'ana', password: 'longpassword', name: 'Ana' });
  const post = (await w.post('/api/post/new', { title: 'T' })).json.post;
  assert.equal((await w.post('/api/ops', { postId: post.id, pane: 'body', baseVersion: 0, seq: 'S1', ops: [{ pos: 0, del: 0, ins: 'hello' }] })).status, 200);
  await sleep(100);
  await first.close();
  // As if the process had died before that line reached the disk.
  const ana = Object.values(JSON.parse(fs.readFileSync(first.stateFile, 'utf8')).users).find((u) => u.username === 'ana');
  fs.rmSync(`${first.stateFile}.ops/${ana.id}.jsonl`);
  const second = await startApp({ stateFile: first.stateFile });
  t.after(() => second.close());
  const w2 = client(second.base);
  await w2.post('/api/login', { username: 'ana', password: 'longpassword' });
  assert.deepEqual((await w2.get(`/api/post?id=${post.id}&pane=body`)).json, { id: post.id, pane: 'body', text: '', version: 0 });
  const again = await w2.post('/api/ops', { postId: post.id, pane: 'body', baseVersion: 0, baseLen: 0, seq: 'S1', ops: [{ pos: 0, del: 0, ins: 'hello' }] });
  assert.deepEqual([again.status, again.json.version, again.json.duplicate], [200, 1, undefined]);
  assert.equal((await w2.post('/api/ops', { postId: post.id, pane: 'body', baseVersion: 1, seq: 'S2', ops: [{ pos: 5, del: 0, ins: ' world' }] })).status, 200);
  assert.equal((await w2.get(`/api/post?id=${post.id}&pane=body`)).json.text, 'hello world');
});

test('a writer who starts during a background re-score gets the plan of the new settings in the new engine', async () => {
  let now = T0;
  const party = new Party({ now: () => now, log: { error() {}, log() {}, warn() {} }, recomputeMinMs: 0, tz: 'UTC', asyncRescore: true });
  Object.assign(party.state.settings.scoring, { approvalRequired: false, hoursMode: 'personal' });
  party.rebuildEngine({ sync: true });
  const host = addUser(party, 'host');
  party.start(host.id);
  // A long log, so that the re-score yields to requests many times.
  const bulk = addUser(party, 'bulk');
  party.join(bulk.id);
  const bp = party.newPost(bulk.id, {});
  const ops = (party.state.ops[bulk.id] = []);
  for (let i = 0; i < 60_000; i++) ops.push([T0 + i * 40, bp.id, 'b', i, 0, i % 6 === 5 ? ' ' : 'w']);
  now = T0 + 45 * MIN + 30 * SEC;
  party.setSettings(host.id, { hoursMode: 'synced' });
  for (let i = 0; i < 5000 && !party.nextEngine; i++) await new Promise((r) => setTimeout(r, 1));
  assert.ok(party.nextEngine, 'the re-score is running');
  const w = addUser(party, 'ana');
  party.join(w.id); // while the new engine is being built
  for (let i = 0; i < 20_000 && party.rescoring; i++) await new Promise((r) => setImmediate(r));
  assert.equal(party.rescoring, false);
  const u = party.userById(w.id);
  assert.equal(party.engine.anchorOf(w.id), party.planOf(u).anchor, 'the engine has the synced plan');
  assert.notEqual(party.planOf(u).anchor, u.joinedAt);
});
