// Carryforward (lib/progress.js): words over an hour's target count toward the next hour, up
// to S.carryOverMax.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writerProgress } from '../lib/progress.js';
import { makeParty, addUser, typeInto } from './helpers.js';
import { realProse, MIN, SEC, T0 } from './sim.js';

const HOUR = 60 * MIN;
const S0 = { hourLengthMin: 60, settleSec: 90, settleQuantumSec: 5, targetPerHour: 400, carryOverMax: 200, freePassesPerWriter: 1 };
// Hours of a writer who joined at T0, `now` inside the last hour given (the earlier ones judged).
function prog(credits, { S = {}, user = {}, at = 10 * MIN } = {}) {
  const hours = credits.map((c, k) => (typeof c === 'number' ? { k, credit: c, flaggedCredit: 0 } : { k, flaggedCredit: 0, ...c }));
  const now = T0 + (credits.length - 1) * HOUR + at;
  return writerProgress({ result: { hours, pending: 0 }, user: { joinedAt: T0, ...user }, S: { ...S0, ...S }, breaks: [], now, party: { phase: 'running' } });
}
const pick = (p, key) => p.hours.map((h) => h[key]);

test('extra words carry to the next hour, up to the cap, and can carry again', () => {
  const p = prog([520, 300, 450, 1000, 0]);
  assert.deepEqual(pick(p, 'status'), ['met', 'met', 'met', 'met', 'current']);
  assert.deepEqual(pick(p, 'carriedIn'), [0, 120, 20, 70, 200]); // 1000 + 70 - 400 = 670, capped at 200
  assert.deepEqual(pick(p, 'credited'), [520, 420, 470, 1070, 200]);
  assert.equal(p.current.carriedIn, 200);
  assert.equal(p.current.credited, 200);
  assert.equal(p.met, 4);
});

test('a missed hour carries nothing; carried words that fall short are lost', () => {
  const p = prog([500, 250, 900, 0]);
  assert.deepEqual(pick(p, 'status'), ['met', 'missed', 'met', 'current']);
  assert.deepEqual(pick(p, 'carriedIn'), [0, 100, 0, 200]);
  assert.deepEqual(pick(p, 'carriedOut'), [100, 0, 200, 0]);
});

test('0 turns carryforward off', () => {
  const p = prog([900, 300, 0], { S: { carryOverMax: 0 } });
  assert.deepEqual(pick(p, 'status'), ['met', 'missed', 'current']);
  assert.deepEqual(pick(p, 'carriedIn'), [0, 0, 0]);
  assert.equal(p.current.carryNext, 0);
});

test('flagged words carry only once the host counts them, and never reach review on the next hour', () => {
  // Hour 1: 600 with 250 flagged: 350 for sure, short of 400: review. Nothing carries while it waits.
  const waiting = prog([{ credit: 600, flaggedCredit: 250 }, 350, 0]);
  assert.deepEqual(pick(waiting, 'status'), ['review', 'missed', 'current']);
  assert.deepEqual(pick(waiting, 'carriedIn'), [0, 0, 0]);
  // Counted: all 600, so 200 carry and hour 2 is met.
  const counted = prog([{ credit: 600, flaggedCredit: 250 }, 350, 0], { user: { reviews: { 0: 'accept' } } });
  assert.deepEqual(pick(counted, 'status'), ['met', 'met', 'current']);
  assert.deepEqual(pick(counted, 'carriedIn'), [0, 200, 150]);
  // Excluded: missed, nothing carries.
  const excluded = prog([{ credit: 600, flaggedCredit: 250 }, 350, 0], { user: { reviews: { 0: 'reject' } } });
  assert.deepEqual(pick(excluded, 'status'), ['missed', 'missed', 'current']);
  // A met hour's flagged words don't carry: 700 with 200 flagged is met by the 500 that count for sure.
  const met = prog([{ credit: 700, flaggedCredit: 200 }, 0]);
  assert.equal(met.hours[0].status, 'met');
  assert.equal(met.hours[1].carriedIn, 100);
  // Carried words are never flagged: hour 2 with 200 carried in and 200 of its 400 flagged has
  // 400 for sure, so it's met (and nothing is over the target to carry on).
  const next = prog([700, { credit: 400, flaggedCredit: 200 }, 0]);
  assert.deepEqual(pick(next, 'status'), ['met', 'met', 'current']);
  assert.deepEqual(pick(next, 'carriedIn'), [0, 200, 0]);
});

test('a free hour carries what goes over its target; an hour away from the party takes and gives nothing', () => {
  const free = prog([600, 650, 0], { user: { freeHours: [{ k: 1, by: 'pass' }] } });
  assert.deepEqual(pick(free, 'status'), ['met', 'free', 'current']);
  assert.deepEqual(pick(free, 'carriedIn'), [0, 200, 200]);
  // Left during hour 2 (SPEC §33), back in hour 3: hour 2 isn't judged and nothing crosses it.
  const leaves = [{ at: T0 + HOUR + 5 * MIN, backAt: T0 + 2 * HOUR + 5 * MIN }];
  const away = prog([600, 900, 100, 0], { user: { leaves } });
  assert.equal(away.hours[1].status, 'left');
  assert.deepEqual(pick(away, 'carriedIn'), [0, 0, 0, 0]);
});

test('the hour in progress: carried words count from its first minute, not as pace; carryNext previews', () => {
  const p = prog([600, 300], { at: 30 * MIN });
  const c = p.current;
  assert.equal(c.carriedIn, 200);
  assert.equal(c.credited, 500);
  assert.equal(c.carryNext, 100);
  // Pace: 300 words in 30 minutes, so about 600 by the end, plus the 200 carried in.
  assert.equal(c.projected, 800);
  assert.equal(c.behind, false);
  // Behind is judged on everything that counts: 200 carried + 50 written by half-time projects 300 < 400.
  const slow = prog([600, 50], { at: 30 * MIN }).current;
  assert.equal(slow.projected, 300);
  assert.equal(slow.behind, true);
  // Still settling: the next hour gets the provisional carry.
  const settling = prog([600, 0], { at: 30 * SEC });
  assert.deepEqual(pick(settling, 'status'), ['settling', 'current']);
  assert.equal(settling.current.carriedIn, 200);
});

// The party: hour 1 over the target keeps the writer in through a short hour 2.
function partyWith(carryOverMax, hour2 = 35) {
  const { party, clock } = makeParty({ settings: { hourLengthMin: 10, targetPerHour: 50, carryOverMax } });
  const host = addUser(party, 'host');
  party.start(host.id);
  const w = addUser(party, 'ana', 'Ana');
  party.join(w.id);
  const p = party.newPost(w.id, {});
  typeInto(party, clock, w, p, realProse(80, 100), { cps: 4 }); // ~80 words in hour 1
  clock.set(w.joinedAt + 10 * MIN + 10 * SEC);
  typeInto(party, clock, w, p, ` ${realProse(hour2, 300)}`, { cps: 4 }); // ~35 in hour 2
  clock.set(w.joinedAt + 20 * MIN + 2 * MIN);
  party.tick();
  return { party, clock, host, w };
}
const statuses = (party, uid) => party.progressOf(uid, { fresh: true }).prog.hours.map((h) => h.status);

test('party: carried words meet a short hour; without carryforward the writer is out', () => {
  const on = partyWith(200);
  const hrs = on.party.progressOf(on.w.id, { fresh: true }).prog.hours;
  assert.deepEqual(hrs.map((h) => h.status), ['met', 'met', 'current']);
  assert.ok(hrs[1].carriedIn >= 25 && hrs[1].carriedIn <= 35, `carried ${hrs[1].carriedIn}`);
  assert.equal(on.w.out, false);
  assert.equal(on.party.state.alerts.length, 0);
  // Writers and hosts see it.
  const me = on.party.meView(on.w.id);
  assert.equal(me.settings.carryOverMax, 200);
  assert.equal(me.progress.hours[1].carriedIn, hrs[1].carriedIn);
  const row = on.party.hostView(on.host.id).writers.find((x) => x.id === on.w.id);
  assert.equal(row.progress.hours[1].carriedIn, hrs[1].carriedIn);
  // Word totals are what was written: carried words aren't counted twice.
  assert.ok(Math.abs(me.progress.totals.credit - (hrs[0].credit + hrs[1].credit + hrs[2].credit)) < 0.01);

  const off = partyWith(0);
  assert.deepEqual(statuses(off.party, off.w.id), ['met', 'missed', 'current']);
  assert.equal(off.w.out, true);
});

test('party: turning carryforward on re-judges finished hours and brings the writer back in', () => {
  const { party, host, w } = partyWith(0);
  assert.equal(w.out, true);
  party.setSettings(host.id, { carryOverMax: 200 });
  party.tick();
  assert.deepEqual(statuses(party, w.id), ['met', 'met', 'current']);
  assert.equal(w.out, false);
  assert.equal(party.state.judged, undefined);
  assert.equal(w.judged[1].status, 'met');
  assert.ok(party.state.alerts.every((a) => a.ack));
});

test('party: a missed hour with carried words says so in the log and the alert', () => {
  const { party, host, w } = partyWith(200, 5); // ~30 carried + ~5 written < 50
  assert.deepEqual(statuses(party, w.id), ['met', 'missed', 'current']);
  assert.equal(w.out, true);
  const al = party.state.alerts.find((a) => a.kind === 'missed');
  const h2 = party.progressOf(w.id, { fresh: true }).prog.hours[1];
  assert.equal(al.carriedWords, Math.round(h2.carriedIn));
  assert.equal(al.countedWords, Math.round(h2.credited));
  const text = party.hostView(host.id).alerts.find((a) => a.id === al.id).text;
  assert.match(text, new RegExp(`missed hour 2 \\(${al.countedWords} of 50, ${al.carriedWords} carried over\\)`));
});

test('a writer’s own carryover limit replaces the setting for them only', () => {
  const own = prog([1000, 300, 0], { user: { carryOverride: 600 } });
  assert.deepEqual(pick(own, 'carriedIn'), [0, 600, 500]); // 1000 - 400; then 600 + 300 - 400
  assert.deepEqual(pick(own, 'status'), ['met', 'met', 'current']);
  // 0 turns it off for them; null (or nothing) is the setting.
  assert.deepEqual(pick(prog([1000, 300, 0], { user: { carryOverride: 0 } }), 'carriedIn'), [0, 0, 0]);
  assert.deepEqual(pick(prog([1000, 300, 0], { user: { carryOverride: null } }), 'carriedIn'), [0, 200, 100]);
  // A limit for one writer works even with the setting off.
  assert.deepEqual(pick(prog([1000, 0], { S: { carryOverMax: 0 }, user: { carryOverride: 600 } }), 'carriedIn'), [0, 600]);
});

test('party: the host sets one writer’s carryover limit; previews, views, log and validation', async () => {
  const { party, clock } = makeParty({ settings: { hourLengthMin: 10, targetPerHour: 50, carryOverMax: 10 } });
  const host = addUser(party, 'host');
  party.start(host.id);
  const mk = (name, from) => {
    const w = addUser(party, name);
    party.join(w.id);
    const p = party.newPost(w.id, {});
    typeInto(party, clock, w, p, realProse(80, from), { cps: 4 }); // ~80 words: ~30 over the target
    return { w, p };
  };
  const ana = mk('ana', 0);
  const bob = mk('bob', 80);
  // Hours are personal here: each writer's hour 2 starts 10 minutes after they joined.
  clock.set(ana.w.joinedAt + 10 * MIN + 10 * SEC);
  typeInto(party, clock, ana.w, ana.p, ` ${realProse(30, 170)}`, { cps: 4 }); // ~30 in hour 2
  clock.set(Math.max(clock.now(), bob.w.joinedAt + 10 * MIN + 10 * SEC));
  typeInto(party, clock, bob.w, bob.p, ` ${realProse(30, 210)}`, { cps: 4 });
  clock.set(bob.w.joinedAt + 22 * MIN); // both hour 2s judged, both hour 3s running
  party.tick();
  // With the setting (10), 30 + 10 < 50: both miss hour 2 and are out.
  assert.deepEqual(statuses(party, ana.w.id), ['met', 'missed', 'current']);
  assert.equal(ana.w.out, true);
  assert.equal(bob.w.out, true);
  // The preview says what Ana's own limit of 600 would change, and only for her.
  const pv = await party.previewSettings(host.id, { writers: [{ id: ana.w.id, carryOverride: 600 }] });
  assert.deepEqual(pv.changes.map((c) => [c.writerId, c.hour, c.from, c.to]), [[ana.w.id, 2, 'missed', 'met']]);
  assert.throws(() => party.adminWriter(host.id, { id: ana.w.id, carryOverride: 'lots' }), /whole number/);
  assert.throws(() => party.adminWriter(host.id, { id: ana.w.id, carryOverride: -1 }), /whole number/);
  assert.throws(() => party.adminWriter(ana.w.id, { id: ana.w.id, carryOverride: 600 }));
  party.adminWriter(host.id, { id: ana.w.id, carryOverride: 600 });
  party.tick();
  assert.equal(ana.w.carryOverride, 600);
  assert.deepEqual(statuses(party, ana.w.id), ['met', 'met', 'current']);
  assert.equal(ana.w.out, false, 'back in: the hour that put her out is met now');
  assert.equal(bob.w.out, true, 'Bob keeps the setting');
  assert.deepEqual(statuses(party, bob.w.id), ['met', 'missed', 'current']);
  // Ana's views and the host's say so; the log too.
  assert.equal(party.meView(ana.w.id).settings.carryOverMax, 600);
  assert.equal(party.meView(bob.w.id).settings.carryOverMax, 10);
  const rows = party.hostView(host.id).writers;
  assert.equal(rows.find((x) => x.id === ana.w.id).carryOverride, 600);
  assert.equal(rows.find((x) => x.id === bob.w.id).carryOverride, null);
  assert.ok(party.state.log.some((l) => l.type === 'carry' && l.userId === ana.w.id && /600/.test(l.text)));
  // Empty: back to the setting.
  party.adminWriter(host.id, { id: ana.w.id, carryOverride: '' });
  assert.equal(ana.w.carryOverride, null);
  assert.equal(party.meView(ana.w.id).settings.carryOverMax, 10);
});
