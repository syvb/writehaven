// What a settings change would do to everyone's hours, computed from the op log alone (pure):
// used by the host's "preview before saving" (in a worker thread, lib/rescore-worker.js) and
// by tests in-process.

import { createEngine } from './scoring.js';
import { writerProgress, editShare, median, personalFactor } from './progress.js';
import { hourIndex, planFor, pauseBreaks, planTargets, frozenTargets, leavePeriods, leaveHours } from './hours.js';

// One writer's journal records -> the stored op list party.js keeps:
//   [t, postId, paneCode, pos, del, ins, x?]
export function opsFromJournalRecs(recs) {
  const list = [];
  for (const rec of recs || []) {
    if (!Array.isArray(rec) || rec.length < 4 || !Array.isArray(rec[3])) continue;
    const [postId, code, , ops] = rec;
    for (const o of ops) list.push(o.length > 4 ? [o[0], postId, code, o[1], o[2], o[3], o[4]] : [o[0], postId, code, o[1], o[2], o[3]]);
  }
  return list;
}

export const opFromStored = (o) => ({ t: o[0], post: o[1], pane: o[2], pos: o[3], del: o[4], ins: o[5], x: o[6] || undefined });

// A writer's hour plan under `settings` (lib/hours.js), as party.js computes it.
export function planOfUser(u, settings, breaks, party) {
  if (!u || !Number.isFinite(u.joinedAt)) return null;
  return planFor({ joinedAt: u.joinedAt, settings, startedAt: party && party.startedAt, breaks, tz: party && party.tz });
}
// Scoring context of a writer (the same fields party.js's engineCtx gives). privateSet: post ids
// whose text other writers aren't compared with (separate or hidden; notes never are).
export function ctxOfUser(u, breaks, plan = null, settings = null, privateSet = null) {
  return {
    shareable: (post, pane) => pane === 'body' && !(privateSet && privateSet.has(post)),
    joinedAt: plan ? plan.anchor : u && Number.isFinite(u.joinedAt) ? u.joinedAt : undefined,
    breaks: pauseBreaks(breaks), // reduce-breaks don't move hours
    target: u && Number.isFinite(u.targetOverride) ? u.targetOverride : undefined,
    targets: u && settings ? planTargets(plan, { override: u.targetOverride, targetPerHour: settings.targetPerHour, breaks, hourMs: settings.hourLengthMin * 60_000, frozen: frozenTargets(u), resume: plan ? leaveHours(leavePeriods(u), plan, { S: settings, breaks }).resume : null }) : undefined,
    bonus: u && Array.isArray(u.bonusCredit) ? u.bonusCredit.map((b) => ({ ...b })) : undefined, // SPEC §20c
    timeline: true,
  };
}

// Replay every writer's stored ops into a fresh engine in global time order (ties: writer id,
// then log order), exactly like party.js's full re-score.
export function replay(settings, opsByUser, ctxOf, { onError = null } = {}) {
  const engine = createEngine(settings, ctxOf);
  const all = [];
  for (const [uid, ops] of Object.entries(opsByUser)) ops.forEach((o, i) => { if (!(o[6] && o[6].e)) all.push([uid, o, i]); }); // edits after the party never count
  all.sort((a, b) => a[1][0] - b[1][0] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) || a[2] - b[2]);
  const failed = new Set();
  for (const [uid, o] of all) {
    if (failed.has(uid)) continue;
    try {
      engine.apply(uid, opFromStored(o));
    } catch (e) {
      failed.add(uid);
      if (onError) onError(uid, e);
    }
  }
  return engine;
}

// Hour statuses per writer under `settings`. users: [{ id, name, joinedAt, freeHours, reviews, leftAt, leaves,
// targetOverride }], party: { phase, endedAt }.
export function hourStatuses({ opsByUser, settings, users, breaks, party, now, privatePosts = null }) {
  const byId = new Map(users.map((u) => [u.id, u]));
  const plans = new Map(users.map((u) => [u.id, planOfUser(u, settings, breaks, party)]));
  const priv = new Set(privatePosts || []);
  const engine = replay(settings, opsByUser, (uid) => ctxOfUser(byId.get(uid), breaks, plans.get(uid), settings, priv));
  engine.advance(now);
  const writers = users.filter((u) => Number.isFinite(u.joinedAt));
  const results = new Map(writers.map((u) => [u.id, engine.result(u.id, now)]));
  // Personal targets (off by default): the same calibration as party.js.
  const factors = new Map();
  if (settings.personalTargets) {
    const hourMs = settings.hourLengthMin * 60_000;
    const nb = pauseBreaks(breaks);
    const shares = new Map(writers.map((u) => [u.id, editShare(results.get(u.id), hourIndex(now, u.joinedAt, nb, hourMs) >= 1)]));
    const med = median([...shares.values()].filter((x) => x !== null));
    for (const [id, sh] of shares) factors.set(id, personalFactor(sh, med));
  }
  const out = {};
  for (const u of writers) {
    const prog = writerProgress({ result: results.get(u.id), user: u, S: settings, breaks, now, party, factor: factors.get(u.id) ?? 1, plan: plans.get(u.id) });
    out[u.id] = prog ? prog.hours.map((h) => ({ k: h.k, status: h.status })) : [];
  }
  return out;
}

const JUDGED = new Set(['met', 'missed', 'review', 'free']);

// Hours whose judged status differs: [{ writerId, name, k, hour, from, to }].
export function diffStatuses(before, after, users) {
  const changes = [];
  for (const u of users) {
    const a = new Map((before[u.id] || []).map((h) => [h.k, h.status]));
    for (const h of after[u.id] || []) {
      const from = a.get(h.k);
      if (from === undefined || from === h.status) continue;
      if (!JUDGED.has(from) && !JUDGED.has(h.status)) continue;
      changes.push({ writerId: u.id, name: u.name, k: h.k, hour: h.k + 1, from, to: h.status });
    }
  }
  return changes;
}

// The whole preview: statuses now vs with the patch (and per-writer target overrides).
// breaksAfter: the breaks as they would be (a mode change or a cancellation), if different.
export function computePreview({ opsByUser, settingsBefore, settingsAfter, users, usersAfter, breaks, breaksAfter = null, party, now, privatePosts = null }) {
  const before = hourStatuses({ opsByUser, settings: settingsBefore, users, breaks, party, now, privatePosts });
  const after = hourStatuses({ opsByUser, settings: settingsAfter, users: usersAfter || users, breaks: breaksAfter || breaks, party, now, privatePosts });
  return diffStatuses(before, after, users);
}

// The same, in slices that yield to the event loop (when no worker thread can be started):
// replays merge the writers' logs by time without a big sort. `lengths` caps each log at its
// length when the preview was asked for (the live log keeps growing meanwhile).
const tick = () => new Promise((r) => setImmediate(r));
async function replayChunked(settings, opsByUser, ctxOf, { sliceMs = 15, lengths = null } = {}) {
  const engine = createEngine(settings, ctxOf);
  const cursors = new Map(Object.keys(opsByUser).map((uid) => [uid, 0]));
  const failed = new Set();
  let n = 0;
  let until = performance.now() + sliceMs;
  for (;;) {
    let bu = null;
    let bo = null;
    for (const [uid, i] of cursors) {
      const ops = opsByUser[uid];
      const len = lengths ? (lengths[uid] ?? 0) : ops.length;
      if (i >= len) continue;
      const o = ops[i];
      if (bo === null || o[0] < bo[0] || (o[0] === bo[0] && uid < bu)) {
        bu = uid;
        bo = o;
      }
    }
    if (bu === null) break;
    cursors.set(bu, cursors.get(bu) + 1);
    if (!failed.has(bu) && !(bo[6] && bo[6].e)) { // edits after the party never count
      try {
        engine.apply(bu, opFromStored(bo));
      } catch {
        failed.add(bu);
      }
    }
    if ((++n & 127) === 0 && performance.now() > until) {
      await tick();
      until = performance.now() + sliceMs;
    }
  }
  return engine;
}
async function hourStatusesChunked({ opsByUser, settings, users, breaks, party, now, lengths, privatePosts = null }) {
  const byId = new Map(users.map((u) => [u.id, u]));
  const plans = new Map(users.map((u) => [u.id, planOfUser(u, settings, breaks, party)]));
  const priv = new Set(privatePosts || []);
  const engine = await replayChunked(settings, opsByUser, (uid) => ctxOfUser(byId.get(uid), breaks, plans.get(uid), settings, priv), { lengths });
  engine.advance(now);
  await tick();
  const writers = users.filter((u) => Number.isFinite(u.joinedAt));
  const results = new Map();
  for (const u of writers) {
    results.set(u.id, engine.result(u.id, now));
    await tick();
  }
  const factors = new Map();
  if (settings.personalTargets) {
    const hourMs = settings.hourLengthMin * 60_000;
    const nb = pauseBreaks(breaks);
    const shares = new Map(writers.map((u) => [u.id, editShare(results.get(u.id), hourIndex(now, u.joinedAt, nb, hourMs) >= 1)]));
    const med = median([...shares.values()].filter((x) => x !== null));
    for (const [id, sh] of shares) factors.set(id, personalFactor(sh, med));
  }
  const out = {};
  for (const u of writers) {
    const prog = writerProgress({ result: results.get(u.id), user: u, S: settings, breaks, now, party, factor: factors.get(u.id) ?? 1, plan: plans.get(u.id) });
    out[u.id] = prog ? prog.hours.map((h) => ({ k: h.k, status: h.status })) : [];
  }
  return out;
}
export async function computePreviewChunked({ opsByUser, settingsBefore, settingsAfter, users, usersAfter, breaks, breaksAfter = null, party, now, privatePosts = null }) {
  const lengths = Object.fromEntries(Object.entries(opsByUser).map(([uid, ops]) => [uid, ops.length]));
  const before = await hourStatusesChunked({ opsByUser, settings: settingsBefore, users, breaks, party, now, lengths, privatePosts });
  const after = await hourStatusesChunked({ opsByUser, settings: settingsAfter, users: usersAfter || users, breaks: breaksAfter || breaks, party, now, lengths, privatePosts });
  return diffStatuses(before, after, users);
}
