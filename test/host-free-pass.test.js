// A host's free hour for a writer: it can use the writer's own free hour (their pass, usePass),
// and a free hour the host gave can be counted as theirs later (passForHour).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeParty, addUser, typeInto } from './helpers.js';
import { realProse, MIN } from './sim.js';

function setup() {
  const { party, clock } = makeParty({ settings: { hourLengthMin: 10, targetPerHour: 60, freePassesPerWriter: 1 } });
  const host = addUser(party, 'host');
  party.start(host.id);
  const w = addUser(party, 'grace', 'Grace');
  party.join(w.id);
  return { party, clock, host, w };
}
const row = (party, host, w) => party.hostView(host.id).writers.find((x) => x.id === w.id);
const code = (c) => (e) => e.status === 409 && e.extra?.code === c;

test('a host free hour uses the writer’s own free hour when asked to (usePass); none left: refused, an extra hour still works', () => {
  const { party, host, w } = setup();
  assert.equal(row(party, host, w).passesLeft, 1);
  party.adminWriter(host.id, { id: w.id, freeHour: 'next', usePass: true });
  assert.deepEqual(w.freeHours.map((f) => [f.k, f.by]), [[1, 'pass']]);
  assert.equal(w.freeHours[0].grantedBy, host.id);
  assert.equal(row(party, host, w).passesLeft, 0, 'their pass is used');
  assert.ok(party.state.log.some((l) => l.type === 'pass' && l.by === host.id && l.text === 'gave a free hour (hour 2), using their pass'));
  assert.throws(() => party.adminWriter(host.id, { id: w.id, freeHour: 'current', usePass: true }), code('no-passes'));
  party.adminWriter(host.id, { id: w.id, freeHour: 'current' });
  assert.deepEqual(w.freeHours.map((f) => [f.k, f.by]).sort(), [[0, 'host'], [1, 'pass']]);
  assert.equal(row(party, host, w).progress.current.free, true);
  assert.equal(row(party, host, w).passesLeft, 0, 'an extra hour uses no pass');
});

test('a free hour a host gave can be counted as the writer’s own (passForHour)', () => {
  const { party, host, w } = setup();
  party.adminWriter(host.id, { id: w.id, freeHour: 'current' });
  assert.equal(w.freeHours[0].by, 'host');
  assert.equal(row(party, host, w).passesLeft, 1);
  party.adminWriter(host.id, { id: w.id, passForHour: 0 });
  assert.equal(w.freeHours[0].by, 'pass');
  assert.equal(row(party, host, w).passesLeft, 0);
  assert.equal(row(party, host, w).progress.current.free, true, 'the hour stays free');
  assert.ok(party.state.log.some((l) => l.type === 'pass' && l.text === 'hour 1: counted against their free pass'));
  assert.throws(() => party.adminWriter(host.id, { id: w.id, passForHour: 0 }), code('already-pass'));
  assert.throws(() => party.adminWriter(host.id, { id: w.id, passForHour: 3 }), code('not-free'));
  party.adminWriter(host.id, { id: w.id, freeHour: 'next' });
  assert.throws(() => party.adminWriter(host.id, { id: w.id, passForHour: 1 }), code('no-passes'));
  assert.equal(w.freeHours.find((f) => f.k === 1).by, 'host', 'a refused count changes nothing');
});

test('a host free hour on an hour that is already free is refused and uses nothing', () => {
  const { party, host, w } = setup();
  party.adminWriter(host.id, { id: w.id, freeHour: 'next' });
  const logs = party.state.log.length;
  assert.throws(() => party.adminWriter(host.id, { id: w.id, freeHour: 'next', usePass: true }), code('already-free'));
  assert.throws(() => party.adminWriter(host.id, { id: w.id, freeHour: 'next' }), code('already-free'));
  assert.deepEqual(w.freeHours.map((f) => [f.k, f.by]), [[1, 'host']]);
  assert.equal(row(party, host, w).passesLeft, 1, 'their pass is untouched');
  assert.equal(party.state.log.length, logs, 'nothing logged');
});

test('a free hour with no origin reads as given by the host, as the pass count treats it', () => {
  const { party, host, w } = setup();
  w.freeHours.push({ k: 0, at: 0 });
  party.cache.delete(w.id);
  const r = row(party, host, w);
  assert.equal(r.passesLeft, 1);
  assert.equal(r.statusReason, 'Hour 1 is a free hour (given by the host).');
});

test('a missed hour that has ended can be made free afterwards (their pass): back in, its alert closed, its record free', () => {
  const { party, clock, host, w } = setup();
  clock.set(w.joinedAt + 15 * MIN); // hour 1 ended with nothing written and is judged once settled
  party.tick();
  assert.equal(w.out, true);
  assert.equal(w.judged[0].status, 'missed');
  assert.throws(() => party.adminWriter(host.id, { id: w.id, freeHour: 1 }), code('not-judged'), 'the running hour isn’t judged yet');
  party.adminWriter(host.id, { id: w.id, freeHour: 0, usePass: true });
  assert.deepEqual(w.freeHours.map((f) => [f.k, f.by]), [[0, 'pass']]);
  assert.equal(w.out, false);
  assert.equal(w.judged[0].status, 'free');
  assert.equal(row(party, host, w).passesLeft, 0);
  assert.equal(row(party, host, w).progress.hours.find((x) => x.k === 0).status, 'free');
  assert.ok(party.state.alerts.filter((a) => a.userId === w.id).every((a) => a.ack), 'the missed alert is closed');
  assert.ok(party.state.log.some((l) => l.type === 'pass' && l.text === 'made hour 1 a free hour after it ended, using their pass'));
  assert.ok(party.state.log.some((l) => l.type === 'reinstate' && l.by === host.id && l.text === 'back in: hour 1 is a free hour'));
  party.tick();
  assert.equal(w.out, false, 'later ticks keep them in');
  assert.throws(() => party.adminWriter(host.id, { id: w.id, freeHour: 0 }), code('already-free'));
});

test('a missed hour made free afterwards: a later missed hour keeps them out; a met hour can’t be made free', () => {
  const { party, clock, host, w } = setup();
  clock.set(w.joinedAt + 25 * MIN); // hours 1 and 2 both missed
  party.tick();
  assert.deepEqual([w.out, w.judged[0].status, w.judged[1].status], [true, 'missed', 'missed']);
  party.adminWriter(host.id, { id: w.id, freeHour: 0 }); // an extra hour: their pass stays
  assert.equal(w.out, true, 'hour 2 was missed too');
  assert.equal(w.outReason, 'missed hour 2');
  assert.equal(row(party, host, w).passesLeft, 1);
  party.adminWriter(host.id, { id: w.id, freeHour: 1, usePass: true });
  assert.equal(w.out, false);
  assert.equal(row(party, host, w).passesLeft, 0);

  const s = setup();
  const p = s.party.newPost(s.w.id, {});
  typeInto(s.party, s.clock, s.w, p, realProse(80));
  s.clock.set(s.w.joinedAt + 15 * MIN);
  s.party.tick();
  assert.equal(s.w.judged[0].status, 'met');
  assert.throws(() => s.party.adminWriter(s.host.id, { id: s.w.id, freeHour: 0, usePass: true }), code('not-missed'));
  assert.deepEqual(s.w.freeHours, []);
});
