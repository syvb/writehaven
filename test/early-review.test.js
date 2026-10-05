// A host's decision on flagged words while the hour still runs (an "early" check): it covers
// the flagged words the host saw (user.reviewSeen); 5 or more flagged after it and it no longer
// applies, so the hour waits for the host again. Decisions on judged hours behave as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeParty, addUser, pasteInto } from './helpers.js';
import { realProse, MIN, SEC } from './sim.js';

function setup(settings = {}) {
  const { party, clock } = makeParty({ settings: { hourLengthMin: 10, targetPerHour: 150, ...settings } });
  const host = addUser(party, 'host');
  party.start(host.id);
  const w = addUser(party, 'sam', 'Sam');
  party.join(w.id);
  const p = party.newPost(w.id, {});
  return { party, clock, host, w, p };
}
const hour = (party, host, w, k = 0) => party.hostView(host.id).writers.find((x) => x.id === w.id).progress.hours.find((h) => h.k === k);
const endHour = (party, clock, w) => {
  clock.set(w.joinedAt + 10 * MIN + 2 * MIN);
  party.tick();
};

test('an early "Count" covers the flagged words the host saw: the hour is met when it ends', () => {
  const { party, clock, host, w, p } = setup();
  clock.advance(MIN);
  pasteInto(party, w, p, realProse(190, 0), 'all'); // the hour needs these pasted words: flagged
  clock.advance(2 * MIN);
  const h0 = hour(party, host, w);
  assert.equal(h0.status, 'current');
  assert.ok(h0.flagged >= 150, `flagged ${h0.flagged}`);
  assert.equal(h0.decision, null);
  const res = party.adminReview(host.id, { id: w.id, k: 0, decision: 'accept' });
  assert.equal(res.status, 'current');
  assert.equal(w.reviewSeen[0], h0.flagged, 'the decision records the flagged words it covers');
  const h1 = hour(party, host, w);
  assert.equal(h1.decision, 'accept');
  assert.equal(h1.seen, h0.flagged);
  assert.equal(h1.staleDecision, null);
  assert.equal(h1.flaggedSince, 0);
  assert.ok(Array.isArray(h1.evidence) && h1.evidence.some((e) => e.kind === 'paste'), 'a running hour with flagged words carries its evidence');
  // Up to 4 more flagged words: the decision still applies.
  clock.advance(MIN);
  pasteInto(party, w, p, ' sun sea sky', 'all');
  clock.advance(2 * MIN);
  assert.ok(hour(party, host, w).flagged > h0.flagged, 'more words flagged');
  assert.equal(hour(party, host, w).decision, 'accept');
  endHour(party, clock, w);
  const h2 = hour(party, host, w);
  assert.equal(h2.status, 'met');
  const hv = party.hostView(host.id);
  assert.equal(hv.reviews.length, 0, 'nothing waits for review');
  assert.ok(!hv.alerts.some((a) => a.kind === 'review'), 'no review alert');
  assert.equal(w.out, false);
});

test('more flagged words after an early decision re-open the check; at the end the hour waits for review, saying how many', () => {
  const { party, clock, host, w, p } = setup();
  clock.advance(MIN);
  pasteInto(party, w, p, realProse(190, 0), 'all');
  clock.advance(2 * MIN); // words count (and are flagged) once they have settled
  const seen = hour(party, host, w).flagged;
  // The host was shown fewer words than there are by now: the decision covers what they saw.
  party.adminReview(host.id, { id: w.id, k: 0, decision: 'accept', seen: seen - 2 });
  assert.equal(w.reviewSeen[0], seen - 2, 'at most what the host was shown');
  clock.advance(MIN);
  pasteInto(party, w, p, ` ${realProse(30, 400)}`, 'all'); // 30 more pasted words, flagged too
  clock.advance(2 * MIN);
  const h = hour(party, host, w);
  assert.equal(h.decision, null, 'the early decision no longer applies');
  assert.equal(h.staleDecision, 'accept');
  assert.ok(h.flaggedSince >= 30, `since ${h.flaggedSince}`);
  assert.equal(h.flagged - h.seen, h.flaggedSince);
  endHour(party, clock, w);
  assert.equal(hour(party, host, w).status, 'review', 'never met by words the host hasn’t seen');
  const hv = party.hostView(host.id);
  const rv = hv.reviews.find((r) => r.userId === w.id && r.k === 0);
  assert.equal(rv.staleDecision, 'accept');
  assert.equal(rv.flaggedSince, h.flaggedSince);
  const al = hv.alerts.find((a) => a.kind === 'review' && a.userId === w.id);
  assert.ok(al.text.endsWith(` ${h.flaggedSince} more words flagged since your decision.`), al.text);
  assert.match(hv.writers.find((x) => x.id === w.id).statusReason, new RegExp(`; ${h.flaggedSince} more words flagged since your decision\\.$`));
  assert.ok(party.state.log.some((l) => l.type === 'review' && l.text.includes(`${h.flaggedSince} more words flagged since your decision`)));
  // Deciding now (the hour is judged) covers the hour, as before.
  party.adminReview(host.id, { id: w.id, k: 0, decision: 'accept' });
  assert.equal(w.reviewSeen[0], undefined, 'a decision on a judged hour covers all of it');
  assert.equal(hour(party, host, w).status, 'met');
  assert.equal(party.hostView(host.id).reviews.length, 0);
});

test('an early "Exclude" works: the flagged words don’t count, the hour is missed when it ends; it can be undone', () => {
  const { party, clock, host, w, p } = setup();
  clock.advance(MIN);
  pasteInto(party, w, p, realProse(190, 0), 'all');
  clock.advance(2 * MIN); // words count (and are flagged) once they have settled
  const before = hour(party, host, w);
  const res = party.adminReview(host.id, { id: w.id, k: 0, decision: 'reject' });
  assert.ok(res.undoId, 'Exclude can be undone');
  let h = hour(party, host, w);
  assert.equal(h.decision, 'reject');
  assert.equal(h.credited, before.credited - before.flagged, 'the flagged words don’t count');
  // Undo: undecided again, nothing recorded.
  assert.deepEqual(party.undo(host.id, { id: res.undoId }), { undone: 'review-reject' });
  h = hour(party, host, w);
  assert.equal(h.decision, null);
  assert.equal(w.reviews[0], undefined);
  assert.equal(w.reviewSeen?.[0], undefined);
  // Exclude again, and the hour ends: missed, out.
  party.adminReview(host.id, { id: w.id, k: 0, decision: 'reject' });
  endHour(party, clock, w);
  assert.equal(hour(party, host, w).status, 'missed');
  assert.equal(w.out, true);
  assert.ok(party.state.alerts.some((a) => a.kind === 'missed' && a.userId === w.id));
});

test('undo of an early "Exclude" restores an earlier early "Count" with what it covered', () => {
  const { party, clock, host, w, p } = setup();
  clock.advance(MIN);
  pasteInto(party, w, p, realProse(190, 0), 'all');
  clock.advance(2 * MIN); // words count (and are flagged) once they have settled
  party.adminReview(host.id, { id: w.id, k: 0, decision: 'accept' });
  const seen = w.reviewSeen[0];
  const res = party.adminReview(host.id, { id: w.id, k: 0, decision: 'reject' });
  party.undo(host.id, { id: res.undoId });
  assert.equal(w.reviews[0], 'accept');
  assert.equal(w.reviewSeen[0], seen);
  endHour(party, clock, w);
  assert.equal(hour(party, host, w).status, 'met');
});

test('a re-score keeps what an early decision covered', () => {
  const { party, clock, host, w, p } = setup();
  clock.advance(MIN);
  pasteInto(party, w, p, realProse(190, 0), 'all');
  clock.advance(2 * MIN); // words count (and are flagged) once they have settled
  party.adminReview(host.id, { id: w.id, k: 0, decision: 'accept' });
  const seen = w.reviewSeen[0];
  party.setSettings(host.id, { cutWeight: 0.5 }); // a scoring setting: everyone is re-scored
  party.rebuildEngine({ sync: true });
  assert.equal(w.reviewSeen[0], seen, 'kept');
  assert.equal(hour(party, host, w).decision, 'accept');
  // The settings preview (a re-score of its own) reads it too: nothing changes for this hour.
  clock.advance(MIN);
  pasteInto(party, w, p, ` ${realProse(30, 400)}`, 'all');
  clock.advance(2 * MIN);
  party.rebuildEngine({ sync: true });
  assert.equal(hour(party, host, w).staleDecision, 'accept', 'more flagged words after it still re-open the check');
  endHour(party, clock, w);
  assert.equal(hour(party, host, w).status, 'review');
});

test('a decision on an hour that is already judged covers it whole, as before', () => {
  const { party, clock, host, w, p } = setup();
  clock.advance(MIN);
  pasteInto(party, w, p, realProse(190, 0), 'all');
  endHour(party, clock, w);
  assert.equal(hour(party, host, w).status, 'review');
  party.adminReview(host.id, { id: w.id, k: 0, decision: 'accept', seen: 3 });
  assert.equal(w.reviewSeen?.[0], undefined, 'no reach recorded: it covers the hour');
  assert.equal(hour(party, host, w).status, 'met');
  assert.equal(hour(party, host, w).decision, 'accept');
  // And the old ways still hold: a bad decision is refused.
  assert.throws(() => party.adminReview(host.id, { id: w.id, k: 0, decision: 'maybe' }), /decision/);
});

test('the settings preview uses what early decisions covered', async () => {
  // A paste cap keeps 30 of the 190 pasted words from counting, so the early "Count" covers 160.
  const { party, clock, host, w, p } = setup({ pasteCapPerHour: 160 });
  clock.advance(MIN);
  pasteInto(party, w, p, realProse(190, 0), 'all');
  clock.advance(2 * MIN);
  party.adminReview(host.id, { id: w.id, k: 0, decision: 'accept' });
  assert.ok(w.reviewSeen[0] >= 155 && w.reviewSeen[0] <= 160, `seen ${w.reviewSeen[0]}`);
  endHour(party, clock, w);
  assert.equal(hour(party, host, w).status, 'met');
  clock.advance(30 * SEC);
  // A change that leaves the flagged words alone leaves the hour met in the preview too.
  let pv = await party.previewSettings(host.id, { patch: { cutWeight: 0.5 } });
  assert.ok(!pv.changes.some((c) => c.writerId === w.id && c.k === 0), JSON.stringify(pv.changes));
  // Without the cap, about 30 more words would be flagged, which the host never saw: the hour would wait for review.
  pv = await party.previewSettings(host.id, { patch: { pasteCapPerHour: null } });
  assert.ok(pv.changes.some((c) => c.writerId === w.id && c.k === 0 && c.from === 'met' && c.to === 'review'), JSON.stringify(pv.changes));
});
