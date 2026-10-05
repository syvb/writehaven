// Host dashboard data: statuses, pace, summary, alert copy, undo, registration, party meta and
// the public totals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeParty, addUser, typeInto, pasteInto, startApp, client, sleep } from './helpers.js';
import { realProse, wordValue, MIN, SEC } from './sim.js';
import { countWords } from '../public/js/text.js';
import { createParty } from '../lib/score.js';

function setup(settings = {}) {
  const { party, clock } = makeParty({ settings: { hourLengthMin: 30, targetPerHour: 60, ...settings } });
  const host = addUser(party, 'host');
  party.start(host.id);
  return { party, clock, host };
}
const row = (party, host, u) => party.hostView(host.id).writers.find((w) => w.id === u.id);

test('host view: one status per writer, a reason, the pace and a summary', () => {
  const { party, clock, host } = setup();
  const t0 = clock.now();
  const [ana, bob, cy, dee, eve, fay] = ['ana', 'bob', 'cy', 'dee', 'eve', 'fay'].map((n) => addUser(party, n, n[0].toUpperCase() + n.slice(1)));
  for (const w of [bob, cy, dee, eve, fay]) party.join(w.id);
  const pb = party.newPost(bob.id, {});
  typeInto(party, clock, bob, pb, realProse(52, 0), { cps: 6 }); // over 75 % of the target: not at risk while idle
  clock.set(t0);
  const pd = party.newPost(dee.id, {});
  typeInto(party, clock, dee, pd, realProse(5, 100), { cps: 6 });
  clock.set(t0 + 12 * MIN);
  party.takePass(eve.id, {});
  clock.set(t0 + 16 * MIN);
  assert.equal(row(party, host, cy).statusReason, 'Idle for 16 minutes, 0 of 60 so far.');
  party.adminWriter(host.id, { id: fay.id, out: true });
  clock.set(t0 + 26 * MIN);
  party.tick();
  const hv = party.hostView(host.id);
  const st = Object.fromEntries(hv.writers.map((w) => [w.username, w.status]));
  assert.deepEqual(st, { ana: 'not-started', bob: 'on-track', cy: 'at-risk', dee: 'at-risk', eve: 'free', fay: 'out', host: 'not-started' });
  const by = Object.fromEntries(hv.writers.map((w) => [w.username, w]));
  assert.match(by.ana.statusReason, /Clock not started/);
  assert.equal(by.cy.statusReason, '60 words to go in 4 minutes: needs 15 a minute (no usual pace yet).');
  assert.match(by.dee.statusReason, /^55 words to go in 4 minutes: needs 14 a minute \(no usual pace yet\)\.$/);
  assert.equal(by.dee.pace.need, 60);
  assert.equal(by.dee.pace.wordsLeft, 55);
  assert.equal(by.dee.pace.minutesLeft, 4);
  assert.equal(by.dee.pace.perMinuteNeeded, 13.8);
  assert.match(by.bob.statusReason, /^(4\d|5\d) of 60, 4 minutes left\.$/);
  assert.match(by.eve.statusReason, /free hour \(their pass\)/);
  assert.equal(by.fay.statusReason, 'Out: marked out by the host.');
  assert.equal(by.cy.flags.atRisk, true, 'flags.atRisk mirrors the status');
  // The host who never writes isn't counted as a writer.
  assert.deepEqual(hv.summary, { writers: 6, notStarted: 1, onTrack: 1, atRisk: 2, out: 1, free: 1, break: 0, review: 0, left: 0, ended: 0, writingNow: 0, alertsOpen: 0, reviewsOpen: 0, pendingApproval: 0 });
  assert.equal(hv.rescoring, false);
  assert.equal(hv.flagLabels.bigPaste, 'Big paste');
  // A break pauses everyone who isn't out.
  const b = party.addBreak(host.id, { lengthMin: 20, label: 'Dinner break' });
  const hb = party.hostView(host.id);
  assert.equal(hb.writers.find((w) => w.username === 'bob').status, 'break');
  const bobRow = hb.writers.find((w) => w.username === 'bob');
  assert.equal(bobRow.statusReason, 'Paused for the Dinner break until {t}.', 'times go out as epoch ms (SPEC §24)');
  assert.equal(bobRow.statusReasonAt, b.endAt);
  assert.equal(hb.writers.find((w) => w.username === 'fay').status, 'out');
  assert.equal(hb.party.breaks.find((x) => x.id === b.id).status, 'active');
  party.endBreak(host.id, { id: b.id });
  // At the end, everyone is "ended".
  party.end(host.id);
  assert.ok(party.hostView(host.id).writers.every((w) => w.status === 'ended'));
});

test('at-risk uses 1.3 × the writer’s usual pace (at least 12 a minute)', () => {
  const { party, clock, host } = setup({ hourLengthMin: 60, targetPerHour: 400 });
  const w = addUser(party, 'fast', 'Fast');
  party.join(w.id);
  const p = party.newPost(w.id, {});
  // About 30 words a minute in minutes 0-8, then a pause.
  for (let m = 0; m < 8; m++) {
    clock.set(w.joinedAt + m * MIN);
    typeInto(party, clock, w, p, ` ${realProse(30, m * 30)}`, { cps: 4, perBatch: 10 });
  }
  clock.set(w.joinedAt + 50 * MIN);
  const r = row(party, host, w);
  assert.ok(r.pace.usualPerMinute >= 25, `usual ${r.pace.usualPerMinute}`);
  // ~160 words left in 10 minutes = 16 a minute: above 12, but below 1.3 × their usual pace.
  assert.ok(r.pace.perMinuteNeeded > 12 && r.pace.perMinuteNeeded < 1.3 * r.pace.usualPerMinute, `needs ${r.pace.perMinuteNeeded}`);
  assert.equal(r.status, 'at-risk', 'idle 42 minutes with under 75 % of the target');
  assert.match(r.statusReason, /^Idle for/);
});

test('alerts: real numbers in the copy; "Don’t count" and "Mark as out" can be undone for 2 minutes', () => {
  const { party, clock, host } = setup({ hourLengthMin: 10, targetPerHour: 150 });
  const w = addUser(party, 'sam', 'Sam');
  party.join(w.id);
  const p = party.newPost(w.id, {});
  const big = realProse(190, 0);
  const n = Math.round(wordValue(big)); // one-letter words count half
  pasteInto(party, w, p, big, 'all'); // the hour needs 150 of these pasted words: review
  clock.set(w.joinedAt + 10 * MIN + 2 * MIN);
  party.tick();
  let hv = party.hostView(host.id);
  const rev = hv.alerts.find((a) => a.kind === 'review');
  assert.equal(rev.text, `Sam: hour 1 needs your review: ${n} written, ${n} of them flagged (big paste); the hour is met only if they count (target 150).`);
  assert.equal(rev.closed, false);
  // Don't count: missed, out, with the real numbers.
  const res = party.adminReview(host.id, { id: w.id, k: 0, decision: 'reject' });
  assert.equal(res.status, 'missed');
  assert.ok(res.undoId && res.undoUntil === clock.now() + 2 * MIN);
  assert.equal(w.out, true);
  hv = party.hostView(host.id);
  const missed = hv.alerts.find((a) => a.kind === 'missed');
  assert.equal(missed.text, `Sam missed hour 1 and is out: 0 of 150 counted; ${n} written, ${n} not counted after review (big paste).`);
  assert.equal(missed.typedWords, n);
  assert.equal(missed.countedWords, 0);
  assert.equal(missed.notCountedWords, n);
  assert.equal(missed.undoId, res.undoId, 'the alert offers the undo');
  assert.equal(hv.writers.find((x) => x.id === w.id).statusReason, `Out: missed hour 1: 0 of 150 counted; ${n} written, ${n} not counted after review (big paste).`);
  assert.ok(party.state.log.some((l) => l.type === 'missed' && l.text.includes('not counted after review (big paste)')));
  // Undo: back in review, back in the challenge.
  assert.deepEqual(party.undo(host.id, { id: res.undoId }), { undone: 'review-reject' });
  assert.equal(w.out, false);
  hv = party.hostView(host.id);
  assert.equal(hv.reviews.length, 1);
  assert.equal(hv.alerts.find((a) => a.kind === 'review').closed, false, 'the review alert is open again');
  assert.equal(hv.alerts.find((a) => a.kind === 'missed').closed, true);
  assert.throws(() => party.undo(host.id, { id: res.undoId }), /Nothing to undo/);
  // Mark as out, undone.
  const mo = party.adminWriter(host.id, { id: w.id, out: true });
  assert.ok(mo.undo.undoId);
  assert.equal(w.out, true);
  party.undo(host.id, { id: mo.undo.undoId });
  assert.equal(w.out, false);
  // After 2 minutes it's too late.
  const mo2 = party.adminWriter(host.id, { id: w.id, out: true });
  clock.advance(2 * MIN + SEC);
  assert.throws(() => party.undo(host.id, { id: mo2.undo.undoId }), (e) => e.status === 410);
  assert.equal(w.out, true);
});

test('alerts stay after the end, closed', () => {
  const { party, clock, host } = setup({ hourLengthMin: 10 });
  const w = addUser(party, 'ana', 'Ana');
  party.join(w.id);
  clock.set(w.joinedAt + 12 * MIN);
  party.tick();
  assert.equal(party.hostView(host.id).alerts.filter((a) => !a.closed).length, 1);
  party.end(host.id);
  const al = party.hostView(host.id).alerts;
  assert.equal(al.length, 1);
  assert.equal(al[0].closed, true);
  assert.equal(al[0].closedBy, 'end');
  assert.match(al[0].text, /^Ana missed hour 1 \(0 of 60\) and is out\.$/);
});

test('registration: the host can close it; the cap is a setting; the host account is exempt', () => {
  const { party } = makeParty();
  addUser(party, 'host');
  addUser(party, 'ana');
  party.setRegistration(party.userByUsername('host').id, false);
  assert.throws(() => addUser(party, 'bob'), (e) => e.status === 403 && e.extra.code === 'closed');
  party.adminUsers.add('carol');
  addUser(party, 'carol'); // WH_ADMIN_USERS can always register
  party.setRegistration(party.userByUsername('host').id, true);
  party.setSettings(party.userByUsername('host').id, { maxUsers: 4 });
  addUser(party, 'bob');
  assert.throws(() => addUser(party, 'dan'), (e) => e.status === 403 && e.extra.code === 'full');
  assert.equal(party.state.party.registrationOpen, true);
  assert.ok(party.state.log.some((l) => l.type === 'registration'));
});

test('settings: hourLengthMin is a test knob; an unchanged value in a full form is ignored', () => {
  const { party, host } = setup();
  party.testKnobs = false;
  party.setSettings(host.id, { ...party.state.settings.scoring, targetPerHour: 70 });
  assert.equal(party.S.targetPerHour, 70);
  assert.throws(() => party.setSettings(host.id, { hourLengthMin: 5 }), /test setting/);
  party.testKnobs = true;
  party.setSettings(host.id, { hourLengthMin: 5 });
  assert.equal(party.S.hourLengthMin, 5);
});

test('public live view: join link, active and next break, group totals; no per-writer data', () => {
  const { party, clock, host } = setup({ hourLengthMin: 10, targetPerHour: 20 });
  party.publicUrl = 'https://example.test';
  const w = addUser(party, 'ana', 'Ana Secret');
  party.join(w.id);
  const p = party.newPost(w.id, { title: 'T' });
  typeInto(party, clock, w, p, realProse(30, 0), { cps: 6 });
  clock.set(w.joinedAt + 12 * MIN);
  party.tick();
  const soon = party.addBreak(host.id, { startAt: clock.now() + 30 * MIN, lengthMin: 15, label: 'Tea' });
  let v = party.liveView();
  assert.equal(v.party.joinUrl, 'https://example.test');
  assert.equal(v.party.breaks.active, null);
  assert.deepEqual(v.party.breaks.next, { label: 'Tea', startAt: soon.startAt, endAt: soon.endAt, mode: 'pause' });
  assert.equal(v.party.totals.hoursMetToday, 1);
  assert.equal(v.party.totals.wordsToday, 30);
  assert.ok(!('clock' in v.party) && !('tz' in v.party), 'no preformatted times on the wire (SPEC §24)');
  assert.ok(!JSON.stringify(v.party).includes('Ana') && !JSON.stringify(v.party).includes(w.id));
  clock.set(soon.startAt + MIN);
  v = party.liveView();
  assert.deepEqual(v.party.breaks.active, { label: 'Tea', startAt: soon.startAt, endAt: soon.endAt, mode: 'pause' });
  assert.equal(v.party.breaks.next, null);
});

test('http: /api/host aliases, planned end, registration toggle, break cancel, undo', async (t) => {
  const { base, close } = await startApp();
  t.after(close);
  const host = client(base);
  await host.post('/api/register', { username: 'host', password: 'longpassword', name: 'Host' });
  await host.post('/api/admin/start', {});
  const w = client(base);
  const ana = (await w.post('/api/register', { username: 'ana', password: 'longpassword', name: 'Ana' })).json.user;
  let r = await host.get('/api/host');
  assert.equal(r.status, 200);
  assert.equal(r.json.party.joinUrl, 'https://writehaven.example.org');
  assert.equal(r.json.party.registrationOpen, true);
  assert.ok(r.json.summary && Array.isArray(r.json.writers));
  r = await host.post('/api/host/registration', { open: false });
  assert.deepEqual(r.json, { ok: true, registrationOpen: false });
  r = await client(base).post('/api/register', { username: 'late', password: 'longpassword', name: 'Late' });
  assert.equal(r.status, 403);
  const end = Date.now() + 3 * 3600_000;
  r = await host.post('/api/host/party', { plannedEnd: end });
  assert.equal(r.json.party.plannedEnd, end);
  r = await host.post('/api/host/break', { startAt: Date.now() + 3600_000, lengthMin: 10, label: 'Tea' });
  const bid = r.json.break.id;
  r = await host.post(`/api/host/breaks/${bid}/cancel`, {});
  assert.equal(r.status, 200);
  assert.equal((await host.get('/api/host/state')).json.party.breaks.length, 0);
  r = await host.post('/api/host/writer', { id: ana.id, out: true });
  assert.ok(r.json.undoId);
  r = await host.post('/api/host/undo', { id: r.json.undoId });
  assert.deepEqual(r.json, { ok: true, undone: 'mark-out' });
  r = await host.post('/api/host/undo', { id: 'nope' });
  assert.equal(r.status, 404);
  // Writers can't use host routes under either name.
  assert.equal((await w.post('/api/host/registration', { open: true })).status, 404);
  assert.equal((await w.get('/api/host')).status, 404);
});

test('words today: the words on the page now across every post body (not notes), kept per post as ops arrive', () => {
  const { party, clock, host } = setup({ hourLengthMin: 60 });
  const a = addUser(party, 'ana');
  const b = addUser(party, 'bob');
  party.join(a.id);
  party.join(b.id);
  const pa = party.newPost(a.id, {});
  const ps = party.newPost(a.id, {});
  party.updatePost(a.id, { id: ps.id, privacy: 'separate' });
  const pb = party.newPost(b.id, {});
  typeInto(party, clock, a, pa, 'one two three four five', { cps: 20 });
  typeInto(party, clock, a, ps, 'six seven eight', { cps: 20 });
  typeInto(party, clock, b, pb, 'nine ten', { cps: 20 });
  typeInto(party, clock, b, pb, 'notes are not counted here', { pane: 'notes', cps: 20 });
  let t = party.liveView().party.totals;
  assert.equal(t.wordsToday, 7, 'at once, no settling; a separate post stays out of the public sum');
  assert.equal(party.hostView(host.id).party.totals.wordsToday, 10, 'hosts see every post in the sum');
  assert.equal(t.creditedToday, undefined, 'the credited total is for the host only');
  assert.equal(party.hostView(host.id).party.totals.creditedToday, 0, 'nothing has settled yet');
  // A deletion lowers it at once.
  const p = party.state.posts[pa.id];
  party.applyOps(a.id, { postId: pa.id, pane: 'body', baseVersion: p.ver.body, ops: [{ pos: 0, del: 8, ins: '' }] }); // "one two "
  t = party.liveView().party.totals;
  assert.equal(t.wordsToday, 5);
  clock.advance(2 * MIN);
  assert.ok(party.hostView(host.id).party.totals.creditedToday > 0);
  // The kept count always equals a full recount, whatever the edits.
  let seed = 3;
  const rnd = (n) => ((seed = (seed * 16807) % 2147483647) % n);
  const pieces = ['word', ' ', '  ', '\n', '—', 'x', 'é', ', ', 'two words', '42', '*', '\t'];
  for (let i = 0; i < 400; i++) {
    const q = party.state.posts[pb.id];
    const len = q.body.length;
    const pos = rnd(len + 1);
    const del = rnd(3) === 0 ? Math.min(len - pos, rnd(6)) : 0;
    party.applyOps(b.id, { postId: pb.id, pane: 'body', baseVersion: q.ver.body, ops: [{ pos, del, ins: rnd(4) === 0 ? '' : pieces[rnd(pieces.length)] }] });
    assert.equal(q.words, countWords(q.body), `after edit ${i}: ${JSON.stringify(q.body)}`);
  }
});

test('words today leaves out pastes the writer didn’t confirm (SPEC §13b), kept as ops arrive', () => {
  const { party, clock, host } = setup({ hourLengthMin: 60 });
  const a = addUser(party, 'ana');
  party.join(a.id);
  const pa = party.newPost(a.id, {});
  const pub = () => party.liveView().party.totals.wordsToday;
  const all = () => party.hostView(host.id).party.totals.wordsToday;
  typeInto(party, clock, a, pa, 'Five words typed by hand. ', { cps: 20 });
  assert.deepEqual([pub(), all()], [5, 5]);
  // 300 pasted words answered "No": neither total moves.
  pasteInto(party, a, pa, `${realProse(300, 11)} `, 'none', { d: 'no' });
  assert.deepEqual([pub(), all()], [5, 5]);
  // Typing still moves it at once.
  typeInto(party, clock, a, pa, 'Two more. ', { cps: 20 });
  assert.deepEqual([pub(), all()], [7, 7]);
  // Deleting half of the unconfirmed paste changes nothing.
  const q = party.state.posts[pa.id];
  const start = q.body.indexOf(realProse(300, 11).slice(0, 20));
  const half = realProse(300, 11).split(' ').slice(0, 150).join(' ').length + 1;
  party.applyOps(a.id, { postId: pa.id, pane: 'body', baseVersion: q.ver.body, ops: [{ pos: start, del: half, ins: '' }] });
  assert.deepEqual([pub(), all()], [7, 7]);
  // A letter typed into a pasted word makes that word the writer's own.
  const w0 = q.body.slice(start).match(/\S+/)[0];
  party.applyOps(a.id, { postId: pa.id, pane: 'body', baseVersion: q.ver.body, ops: [{ pos: start + w0.length, del: 0, ins: 'x' }] });
  assert.deepEqual([pub(), all()], [8, 8]);
  // A confirmed paste counts, and so does a short one.
  pasteInto(party, a, pa, `${realProse(60, 12)} `, 'all', { d: 'yes' });
  assert.deepEqual([pub(), all()], [68, 68]);
  pasteInto(party, a, pa, 'six short pasted words right here ', 'none', { d: 'short' });
  assert.deepEqual([pub(), all()], [74, 74]);
  // A long paste with some words confirmed: only those count. (Words that repeat the writer's own
  // text are the scorer's "repeat", not unconfirmed: moving one's own paragraph keeps the total.)
  const mixed = Array.from({ length: 40 }, (_, i) => `zorvek${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`).join(' ');
  pasteInto(party, a, pa, `${mixed} `, `${'1'.repeat(10)}${'0'.repeat(30)}`, { d: 'yes' });
  assert.deepEqual([pub(), all()], [84, 84]);
});

test('unconfirmed pasted words: the count equals a word-by-word recount from each character’s origin, whatever the edits', () => {
  const sp = createParty({ targetPerHour: 400, hourLengthMin: 60 });
  const P = () => sp.scorer('w').panes.get('p\u0000body');
  const UNCONF = 16; // lib/score.js: the character came from a paste the writer didn't confirm
  const recount = (p) => {
    let n = 0;
    for (const m of p.text.matchAll(/\S+/g)) {
      let letters = 0;
      let all = true;
      let i = m.index;
      for (const ch of m[0]) {
        if (/[\p{L}\p{N}]/u.test(ch)) {
          letters++;
          for (let j = i; j < i + ch.length; j++) if (!(p.meta[j] & UNCONF)) all = false;
        }
        i += ch.length;
      }
      if (letters && all) n++;
    }
    return n;
  };
  let text = '';
  let t = 0;
  const put = (op) => {
    sp.apply('w', { t: (t += 700), post: 'p', pane: 'body', ...op });
    text = text.slice(0, op.pos) + (op.ins || '') + text.slice(op.pos + (op.del || 0));
  };
  let seed = 7;
  const rnd = (n) => ((seed = (seed * 16807) % 2147483647) % n);
  const pieces = ['word', ' ', '\n', 'x', ', ', 'two words', '42', '—', 'é'];
  for (let i = 0; i < 600; i++) {
    const len = text.length;
    const pos = rnd(len + 1);
    const del = rnd(3) === 0 ? Math.min(len - pos, rnd(40)) : 0;
    if (rnd(12) === 0) {
      const ins = `${Array.from({ length: 30 }, (_, j) => `q${i}w${j}`).join(' ')} `;
      const mask = Array.from({ length: 30 }, () => (rnd(3) ? '0' : '1')).join('');
      const confirm = [...ins.matchAll(/\S+/g)].map((m) => [m.index, m.index + m[0].length]).filter((_, j) => mask[j] === '1');
      put({ pos, del, ins, source: 'paste', confirm });
    } else put({ pos, del, ins: rnd(4) === 0 ? '' : pieces[rnd(pieces.length)], source: 'type' });
    const p = P();
    assert.equal(p.text, text);
    assert.equal(p.unconfChars, p.meta.filter((m) => m & UNCONF).length, `characters after edit ${i}`);
    assert.equal(sp.scorer('w').unconfirmedWords('p', 'body'), recount(p), `after edit ${i}`);
  }
  assert.ok(sp.scorer('w').unconfirmedWords('p', 'body') > 0, 'some unconfirmed words are on the page');
});

test('words today without unconfirmed pastes survives a restart (rebuilt from the op log)', async (t) => {
  const first = await startApp({ saveMs: 50 });
  t.after(() => first.close());
  const host = client(first.base);
  await host.post('/api/register', { username: 'host', password: 'longpassword', name: 'Host' });
  await host.post('/api/admin/start', {});
  const w = client(first.base);
  await w.post('/api/register', { username: 'ana', password: 'longpassword', name: 'Ana' });
  const post = (await w.post('/api/post/new', { title: 'T' })).json.post;
  const paste = `${realProse(300, 21)} `;
  const n = (paste.match(/\S+/g) || []).length;
  let r = await w.post('/api/ops', { postId: post.id, pane: 'body', baseVersion: 0, ops: [{ pos: 0, del: 0, ins: 'Typed words first. ' }] });
  r = await w.post('/api/ops', { postId: post.id, pane: 'body', baseVersion: r.json.version, ops: [{ pos: 19, del: 0, ins: paste, paste: { m: '0'.repeat(n), d: 'no' } }] });
  assert.equal(r.status, 200);
  const totals = async (c) => [(await c.get('/api/live')).json.party.totals.wordsToday, (await c.get('/api/host')).json.party.totals.wordsToday];
  assert.deepEqual(await totals(host), [3, 3]);
  await sleep(100);
  await first.close();
  const second = await startApp({ stateFile: first.stateFile });
  t.after(() => second.close());
  const host2 = client(second.base);
  await host2.post('/api/login', { username: 'host', password: 'longpassword' });
  assert.deepEqual(await totals(host2), [3, 3]);
});


test('the party clock is British time by default (daylight saving included): server-only outputs use it; views send epoch ms', async () => {
  const { Party, DEFAULT_TZ } = await import('../lib/party.js');
  const summer = Date.UTC(2026, 9, 4, 8, 13); // 08:13 UTC on 4 October 2026 = 09:13 BST
  const winter = Date.UTC(2026, 11, 1, 8, 13); // 08:13 UTC on 1 December = 08:13 GMT
  let t = summer;
  const party = new Party({ now: () => t, log: { error() {}, log() {} }, recomputeMinMs: 0 });
  assert.equal(DEFAULT_TZ, 'Europe/London');
  assert.equal(party.tz, 'Europe/London');
  assert.equal(party.fmtClock(summer), '09:13');
  assert.equal(party.fmtClock(winter), '08:13');
  assert.equal(party.localStamp(summer), '2026-10-04T09:13:00+01:00');
  assert.equal(party.localStamp(winter), '2026-12-01T08:13:00+00:00');
  assert.ok(!('clock' in party.liveView().party), 'views carry epoch ms only');
  const host = party.register(party.validateRegistration({ username: 'host', password: 'secret-pass', name: 'Host' }), 'x');
  assert.equal(party.exportJson(host.id).exportedAt, '2026-10-04T09:13:00+01:00');
  // A synced hour window on British time: a start at 09:47 BST → first hour until 11:00 BST.
  party.state.settings.scoring.approvalRequired = false;
  party.state.settings.scoring.hoursMode = 'synced';
  party.rebuildEngine({ sync: true });
  t = Date.UTC(2026, 9, 4, 8, 47);
  party.start(host.id);
  const w = party.register(party.validateRegistration({ username: 'ana', password: 'secret-pass', name: 'Ana' }), 'x');
  party.join(w.id);
  const h = party.meView(w.id).me.hour;
  assert.equal(party.fmtClock(h.endAt), '11:00');
  assert.match(party.state.log.find((l) => l.type === 'join').text, /first hour until 11:00$/);
  // An unknown zone falls back to British time rather than failing.
  const odd = new Party({ now: () => summer, log: { error() {}, log() {} }, tz: 'Mars/Olympus' });
  assert.equal(odd.fmtClock(summer), '09:13');
});
