// Hour-by-hour progress for one writer, from a scoring result: targets,
// statuses (met / missed / review / free / current / settling / left), the current
// hour's pace, and host review decisions. Pure functions.
//
// A scoring result's hours carry credit that has settled (stayed settleSec seconds). An hour
// is judged once its last words have settled; until then it's 'current' (the
// hour the writer is in) or 'settling' (just ended).

import { hourIndex, hourWindow, activeMs, breakAt, pauseBreaks, breakModeOf, hourSpan, hourTarget, frozenTargets, leavePeriods, leaveHours, inLeave } from './hours.js';

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function median(xs) {
  const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// Cut share of a writer's calibration hour (hour 1), or null if it isn't judged or is empty.
export function editShare(result, hour0Closed) {
  if (!hour0Closed || !result || !result.hours[0]) return null;
  const h = result.hours[0];
  return h.credit > 0 ? h.cut / h.credit : null;
}

// Personal target factor: clamp(share / median, 0.8, 1.25); 1 when unknown.
export function personalFactor(share, med) {
  if (share === null || share === undefined || med === null || med === undefined) return 1;
  if (med <= 0) return 1;
  return clamp(share / med, 0.8, 1.25);
}

// plan (lib/hours.js planFor): a synced first hour may have a pro-rated target.
export function targetFor(k, { S, user, factor, plan = null }) {
  if (Number.isFinite(user.targetOverride) && user.targetOverride >= 0) return user.targetOverride;
  if (k === 0 && plan && Number.isFinite(plan.firstTarget)) return plan.firstTarget;
  if (S.personalTargets && k >= 1) return Math.round(S.targetPerHour * (factor ?? 1));
  return S.targetPerHour;
}

// The hours a "Take this hour off" pass can waive right now: the current one, at any point in it
// (the default, SPEC §34), or the next one. k: the current hour.
// anchor / firstAt: the writer's hour plan (lib/hours.js planFor); hour 1 starts at firstAt.
export function passHour({ user, breaks, now, S, anchor = user.joinedAt, firstAt = anchor }) {
  const hourMs = S.hourLengthMin * 60_000;
  const nb = pauseBreaks(breaks);
  const k = hourIndex(now, anchor, nb, hourMs);
  const w = hourWindow(k, anchor, nb, hourMs);
  const startAt = k === 0 ? firstAt : w.startAt;
  const age = activeMs(now, startAt, nb);
  return { k, current: k, next: k + 1, startAt, ageMs: age };
}

export function passesLeft(user, S) {
  const used = (user.freeHours || []).filter((f) => f.by === 'pass').length;
  return Math.max(0, S.freePassesPerWriter + (user.extraPasses || 0) - used);
}

const EMPTY = { credit: 0, written: 0, pasted: 0, cut: 0, clawback: 0, flaggedCredit: 0, notCounted: null, flags: [] };

// A decision the host made while the hour was still open covers the flagged words they saw
// (user.reviewSeen[k]); once this many more are flagged, it no longer applies and the hour
// waits for the host again, so words nobody has looked at are never counted by it.
export const REVIEW_REOPEN_WORDS = 5;
export function reviewDecision(user, k, flagged) {
  const decision = user.reviews ? user.reviews[k] : undefined;
  const seen = user.reviewSeen ? user.reviewSeen[k] : undefined;
  if (!decision) return { decision: undefined, stale: null, seen: null };
  if (Number.isFinite(seen) && Math.round(flagged) - seen >= REVIEW_REOPEN_WORDS) return { decision: undefined, stale: decision, seen };
  return { decision, stale: null, seen: Number.isFinite(seen) ? seen : null };
}

// Judge one hour's numbers: free, met, review (met only with flagged credit and
// not decided yet), or missed. decision: 'accept' | 'reject' | undefined.
export function judge({ credit, flagged, target, free, decision }) {
  if (free) return 'free';
  if (credit - flagged >= target) return 'met';
  if (credit >= target) return decision === 'accept' ? 'met' : decision === 'reject' ? 'missed' : 'review';
  return 'missed';
}

// result: a scoring result (lib/scoring.js). party: { phase, endedAt }. plan: the writer's
// hour plan (lib/hours.js planFor); without one, hour 1 starts at joinedAt. Hour windows move
// only with pause-breaks; reduce-breaks lower the targets of the hours they overlap (§19).
export function writerProgress({ result, user, S, breaks, now, party, factor = 1, plan = null }) {
  if (!user.joinedAt) return null;
  const P = plan || { anchor: user.joinedAt, firstHourAt: user.joinedAt, firstTarget: null, extended: false };
  const anchor = P.anchor;
  const hourMs = S.hourLengthMin * 60_000;
  const settleMs = (S.settleSec || 0) * 1000 + (S.settleQuantumSec || 0) * 1000;
  const nb = pauseBreaks(breaks);
  const ended = party.phase === 'ended' && party.endedAt;
  const until = ended ? Math.min(now, party.endedAt) : now;
  const curK = hourIndex(until, anchor, nb, hourMs);
  const free = new Set((user.freeHours || []).map((f) => f.k));
  const hours = [];
  const engineHours = (result && result.hours) || [];
  const maxK = Math.max(curK, engineHours.length - 1);
  const override = Number.isFinite(user.targetOverride) && user.targetOverride >= 0;
  const frozen = frozenTargets(user);
  // Hours while the writer had left the party (SPEC §33): neither met nor missed, unless judged before.
  const lv = leaveHours(leavePeriods(user), P, { S, breaks, now: until });
  for (let k = 0; k <= maxK; k++) {
    if (k > curK) break; // nothing can be credited to the future
    const w = hourSpan(k, P, breaks, hourMs);
    const row = engineHours[k] || EMPTY;
    const t = hourTarget(k, { plan: P, override: user.targetOverride, targetPerHour: S.targetPerHour, factor, personal: !!S.personalTargets, frozen, breaks, hourMs, resume: lv.resume });
    const target = t.target;
    const flagged = Math.min(row.flaggedCredit || 0, row.credit || 0);
    const rd = reviewDecision(user, k, flagged);
    const decision = rd.decision;
    const credited = decision === 'reject' ? (row.credit || 0) - flagged : row.credit || 0;
    const settled = now >= w.endAt + settleMs || (ended && k === curK && now >= party.endedAt + settleMs);
    let status;
    if (ended && k === curK && w.endAt > party.endedAt) status = settled ? 'partial' : 'settling';
    else if (!settled) status = k === curK ? (free.has(k) ? 'free' : 'current') : 'settling';
    else status = judge({ credit: row.credit || 0, flagged, target, free: free.has(k), decision });
    // (A record from a judging before the leave keeps its result: a free hour, say.)
    const j = user.judged && user.judged[k];
    if (inLeave(lv, k) && !(j && !j.pending && j.status !== 'left')) status = 'left';
    hours.push({
      k, startAt: w.startAt, endAt: w.endAt, status, target, baseTarget: t.baseTarget, reducedBy: t.reducedBy, decision: decision || null,
      seen: rd.seen, staleDecision: rd.stale, // an early decision's flagged words, and one that no longer applies
      prorated: k === 0 && Number.isFinite(P.firstTarget) && !override, extended: k === 0 && !!P.extended,
      credited, credit: row.credit || 0, flagged,
      written: row.written || 0, pasted: row.pasted || 0, cut: row.cut || 0, clawback: row.clawback || 0,
      notCounted: row.notCounted, flags: row.flags || [],
    });
  }
  // A waived upcoming hour shows on the strip too.
  for (const f of user.freeHours || []) {
    if (f.k > curK && !hours.some((h) => h.k === f.k)) {
      const w = hourSpan(f.k, P, breaks, hourMs);
      hours.push({ k: f.k, startAt: w.startAt, endAt: w.endAt, status: 'upcoming-free', target: 0, baseTarget: 0, reducedBy: [], credited: 0, credit: 0, flagged: 0, written: 0, pasted: 0, cut: 0, clawback: 0, notCounted: null, flags: [] });
    }
  }
  hours.sort((a, b) => a.k - b.k);
  const cur = hours.find((h) => h.k === curK) || null;
  let current = null;
  if (cur && (cur.status === 'current' || cur.status === 'free')) {
    const pending = Math.max(0, (result && result.pending) || 0);
    const elapsed = Math.max(0, activeMs(until, cur.startAt, nb));
    const remainingMs = Math.max(0, activeMs(cur.endAt, Math.max(until, cur.startAt), nb));
    const soFar = cur.credited + pending;
    const rate = elapsed > Math.min(60_000, hourMs * 0.1) ? soFar / elapsed : 0;
    const projected = soFar + rate * remainingMs;
    const br = breakAt(until, breaks);
    // Coarse (15 s) timing keeps the per-writer stream quiet; clients count down from endAt.
    const q = (ms) => Math.round(ms / 15_000) * 15_000;
    current = {
      k: curK, startAt: cur.startAt, endAt: cur.endAt, credited: cur.credited, pending,
      target: cur.target, baseTarget: cur.baseTarget, reducedBy: cur.reducedBy, prorated: cur.prorated, extended: cur.extended,
      elapsedMs: q(elapsed), remainingMs: q(remainingMs), projected: Math.round(projected), free: cur.status === 'free',
      inBreak: !!br, breakMode: br ? breakModeOf(br) : null,
      // "Behind" only once there's enough of the hour to judge a pace.
      behind: cur.status === 'current' && soFar < cur.target && projected < cur.target && elapsed >= hourMs * 0.2,
    };
  }
  // SPEC §33: away from the party, this hour isn't judged but its words still count and show
  // (no target, never "behind"): leftNow, in place of `current`.
  let leftNow = null;
  if (cur && cur.status === 'left' && !ended) {
    leftNow = { k: curK, startAt: cur.startAt, endAt: cur.endAt, credited: cur.credited, pending: Math.max(0, (result && result.pending) || 0), left: true };
  }
  const judged = hours.filter((h) => ['met', 'missed', 'free', 'review'].includes(h.status));
  return {
    hours,
    current,
    leftNow,
    met: judged.filter((h) => h.status === 'met').length,
    missed: judged.filter((h) => h.status === 'missed').length,
    free: judged.filter((h) => h.status === 'free').length,
    review: judged.filter((h) => h.status === 'review').length,
    passesLeft: passesLeft(user, S),
  };
}
