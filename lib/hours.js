// Hour windows. A writer's hour clock runs from joinedAt and pauses during breaks
// for everyone: hour k covers active time [k*L, (k+1)*L), where active time is
// real time since joinedAt minus any break time in between. Pure functions.

// Breaks: [{ startAt, endAt }] -> sorted, merged, non-empty intervals.
export function normalizeBreaks(breaks) {
  const list = (breaks || [])
    .filter((b) => b && Number.isFinite(b.startAt) && Number.isFinite(b.endAt) && b.endAt > b.startAt)
    .map((b) => ({ startAt: b.startAt, endAt: b.endAt }))
    .sort((a, b) => a.startAt - b.startAt);
  const out = [];
  for (const b of list) {
    const last = out[out.length - 1];
    if (last && b.startAt <= last.endAt) last.endAt = Math.max(last.endAt, b.endAt);
    else out.push(b);
  }
  return out;
}

// Active (clock-running) milliseconds between joinedAt and t.
export function activeMs(t, joinedAt, breaks) {
  if (!(t > joinedAt)) return 0;
  let a = t - joinedAt;
  for (const b of breaks) {
    const s = Math.max(b.startAt, joinedAt);
    const e = Math.min(b.endAt, t);
    if (e > s) a -= e - s;
  }
  return a;
}

// Earliest real time at which the active clock reaches `a` ms.
export function realTimeForActive(a, joinedAt, breaks) {
  let t = joinedAt;
  let remaining = a;
  for (const b of breaks) {
    if (b.endAt <= t) continue;
    if (b.startAt > t) {
      const seg = b.startAt - t;
      if (remaining <= seg) return t + remaining;
      remaining -= seg;
    }
    t = b.endAt;
  }
  return t + remaining;
}

export function hourIndex(t, joinedAt, breaks, hourMs) {
  return Math.max(0, Math.floor(activeMs(t, joinedAt, breaks) / hourMs));
}

export function hourWindow(k, joinedAt, breaks, hourMs) {
  return {
    startAt: realTimeForActive(k * hourMs, joinedAt, breaks),
    endAt: realTimeForActive((k + 1) * hourMs, joinedAt, breaks),
  };
}

// Is a break running at time t? Returns the (unmerged) break object or null.
export function breakAt(t, rawBreaks) {
  for (const b of rawBreaks || []) if (b.startAt <= t && t < b.endAt) return b;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Breaks (SPEC §19) have a mode: 'pause' stops every hour clock (later windows shift, as above);
// 'reduce' leaves the windows alone and lowers the target of each hour it overlaps.
export const breakModeOf = (b) => (b && b.mode === 'reduce' ? 'reduce' : 'pause');
export function pauseBreaks(breaks) {
  return normalizeBreaks((breaks || []).filter((b) => breakModeOf(b) === 'pause'));
}
export function reduceBreaks(breaks) {
  return (breaks || []).filter((b) => b && breakModeOf(b) === 'reduce' && Number.isFinite(b.startAt) && Number.isFinite(b.endAt) && b.endAt > b.startAt);
}

// ---------------------------------------------------------------------------------------------
// Synced hours (SPEC §17, §17b). The party's hour grid starts at the last :MM boundary (MM =
// syncMinute, on the party clock) at or before the start; window j covers active time
// [j·H, (j+1)·H) from there (pause-breaks shift every window together). A writer's hour 1 starts
// at their first editor open: with at least minFirstHourMin left in the current window it is the
// rest of that window with a pro-rated target; otherwise it runs on to the end of the NEXT
// window with the full target ("extended"). Nobody waits. Personal mode: hour 1 starts at the
// first editor open and every hour is H long, as before.

const offsetCache = new Map(); // tz -> Intl formatter
// Minutes the party clock is ahead of UTC within the hour (0 for whole-hour zones).
function minuteOffset(ms, tz) {
  let f = offsetCache.get(tz || '');
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-GB', { minute: '2-digit', ...(tz ? { timeZone: tz } : {}) });
    } catch {
      f = new Intl.DateTimeFormat('en-GB', { minute: '2-digit' });
    }
    offsetCache.set(tz || '', f);
  }
  const local = Number(f.format(ms));
  const utc = new Date(ms).getUTCMinutes();
  return Number.isFinite(local) ? (local - utc + 60) % 60 : 0;
}

// The start of the party's hour grid: the last :MM boundary at or before `startedAt`.
export function gridAnchor(startedAt, syncMinute = 0, tz = null) {
  const minute = Math.floor(startedAt / 60_000) * 60_000;
  const local = (new Date(minute).getUTCMinutes() + minuteOffset(startedAt, tz)) % 60;
  return minute - ((local - (syncMinute % 60) + 60) % 60) * 60_000;
}

// { mode, anchor, firstHourAt, firstTarget, extended, creditFrom } for a writer who first opened
// the editor at `joinedAt`. Hour k ≥ 1 is the window anchor + k·H (active time); hour 1 runs
// from firstHourAt to the end of window anchor + H. firstTarget: the pro-rated target of a short
// hour 1, or null for the full target.
export function planFor({ joinedAt, settings: S, startedAt, breaks, tz = null }) {
  if (!Number.isFinite(joinedAt)) return null;
  if (S.hoursMode !== 'synced' || !Number.isFinite(startedAt)) {
    return { mode: 'personal', anchor: joinedAt, firstHourAt: joinedAt, firstTarget: null, extended: false, creditFrom: null };
  }
  return syncedPlan({ joinedAt, settings: S, startedAt, breaks, tz });
}
function syncedPlan({ joinedAt, settings: S, startedAt, breaks, tz }) {
  const pb = pauseBreaks(breaks);
  const H = S.hourLengthMin * 60_000;
  const A = gridAnchor(startedAt, S.syncMinute ?? 0, tz);
  const a = activeMs(joinedAt, A, pb);
  const j = Math.floor(a / H);
  const remaining = (j + 1) * H - a;
  if (remaining >= (S.minFirstHourMin ?? 20) * 60_000) {
    const anchor = realTimeForActive(j * H, A, pb);
    const firstTarget = remaining < H ? Math.round(S.targetPerHour * (remaining / H)) : null;
    return { mode: 'synced', anchor, firstHourAt: joinedAt, firstTarget, extended: false, creditFrom: null };
  }
  // A short first window joins the next one: hour 1 = first open → end of the next window.
  return { mode: 'synced', anchor: realTimeForActive((j + 1) * H, A, pb), firstHourAt: joinedAt, firstTarget: null, extended: true, creditFrom: null };
}

// Real start and end of hour k for a plan: hour 1 runs from the first editor open (inside its
// window when pro-rated, before it when extended) to the end of window 1.
export function hourSpan(k, plan, breaks, hourMs) {
  const w = hourWindow(k, plan.anchor, pauseBreaks(breaks), hourMs);
  return { startAt: k === 0 ? plan.firstHourAt : w.startAt, endAt: w.endAt };
}

// The target of hour k: `base` (already the pro-rated or overridden one) lowered by the share
// of the hour's active time that reduce-breaks cover. { target, baseTarget, reducedBy }.
export function reducedTarget(k, plan, base, breaks, hourMs) {
  const red = reduceBreaks(breaks);
  if (!plan || !red.length) return { target: base, baseTarget: base, reducedBy: [] };
  const pb = pauseBreaks(breaks);
  const { startAt, endAt } = hourSpan(k, plan, breaks, hourMs);
  const duration = activeMs(endAt, startAt, pb);
  let overlap = 0;
  const reducedBy = [];
  for (const b of red) {
    const o = Math.max(0, Math.min(endAt, b.endAt) - Math.max(startAt, b.startAt));
    if (o > 0) {
      overlap += o;
      reducedBy.push({ breakId: b.id ?? null, minutes: Math.round(o / 60_000) });
    }
  }
  if (!overlap || !(duration > 0)) return { target: base, baseTarget: base, reducedBy };
  return { target: Math.round(base * (Math.max(0, duration - overlap) / duration)), baseTarget: base, reducedBy };
}
// Hours a plan's reduce-breaks touch (for the scorer's per-hour targets).
export function reducedHours(plan, breaks, hourMs) {
  const out = new Set();
  if (!plan) return out;
  const pb = pauseBreaks(breaks);
  for (const b of reduceBreaks(breaks)) {
    if (b.endAt <= plan.firstHourAt) continue;
    const k1 = hourIndex(Math.max(b.startAt, plan.firstHourAt), plan.anchor, pb, hourMs);
    const k2 = hourIndex(Math.max(b.endAt - 1, plan.firstHourAt), plan.anchor, pb, hourMs);
    for (let k = k1; k <= k2 && k - k1 < 48; k++) out.add(k);
  }
  return out;
}

// Start of the next synced window after `now` (null in personal mode or before the start).
export function nextWindowStart(now, { settings: S, startedAt, breaks, tz = null }) {
  if (S.hoursMode !== 'synced' || !Number.isFinite(startedAt)) return null;
  const pb = pauseBreaks(breaks);
  const H = S.hourLengthMin * 60_000;
  const A = gridAnchor(startedAt, S.syncMinute ?? 0, tz);
  return realTimeForActive((Math.floor(activeMs(now, A, pb) / H) + 1) * H, A, pb);
}

// The target of hour k: one rule for the scorer and the dashboard. A target frozen when the hour
// was judged (later setting or override changes don't flip judged hours); else the host's
// override for the writer, else a pro-rated first hour, else the default (× the personal factor
// after hour 1 when personal targets are on); then lowered by reduce-breaks.
// -> { target, baseTarget, reducedBy }
// resume: { k: share } from leaveHours: the hour a writer came back in, pro-rated like a first
// hour (the host's override, as for a first hour, isn't).
export function hourTarget(k, { plan, override = null, targetPerHour, factor = 1, personal = false, frozen = null, breaks, hourMs, resume = null }) {
  if (frozen && Number.isFinite(frozen[k])) return { target: frozen[k], baseTarget: frozen[k], reducedBy: [] };
  let base;
  if (Number.isFinite(override) && override >= 0) base = override;
  else if (k === 0 && plan && Number.isFinite(plan.firstTarget)) base = plan.firstTarget;
  else if (personal && k >= 1) base = Math.round(targetPerHour * (factor ?? 1));
  else base = targetPerHour;
  if (!(Number.isFinite(override) && override >= 0) && resume && Number.isFinite(resume[k])) base = Math.round(base * resume[k]);
  return plan ? reducedTarget(k, plan, base, breaks, hourMs) : { target: base, baseTarget: base, reducedBy: [] };
}

// ---------------------------------------------------------------------------------------------
// Leaving the party (SPEC §33). A writer's leaves: u.leaves (closed: { at, backAt }) and u.leftAt
// (away now). From the hour they leave in, no hour is judged until they're back; coming back
// resumes like a first arrival: with minFirstHourMin or more left in that hour, it counts with a
// pro-rated target, else judging starts at the next hour. As of `now` (a leave or a return later
// than that hasn't happened yet). -> { ranges: [{ from, to }] (hour indices, `to` exclusive,
// Infinity while away), resume: { k: share of the hour's target } }
export function leavePeriods(u) {
  const out = [];
  for (const p of (u && Array.isArray(u.leaves) ? u.leaves : [])) if (p && Number.isFinite(p.at)) out.push({ at: p.at, backAt: Number.isFinite(p.backAt) ? p.backAt : null });
  if (u && Number.isFinite(u.leftAt)) out.push({ at: u.leftAt, backAt: null });
  return out;
}
export function leaveHours(periods, plan, { S, breaks, now = Infinity }) {
  const out = { ranges: [], resume: {} };
  if (!plan || !periods || !periods.length) return out;
  const pb = pauseBreaks(breaks);
  const H = S.hourLengthMin * 60_000;
  const minMs = (S.minFirstHourMin ?? 20) * 60_000;
  for (const p of periods) {
    if (!(p.at <= now)) continue;
    const from = hourIndex(Math.max(p.at, plan.firstHourAt), plan.anchor, pb, H);
    let to = Infinity;
    if (Number.isFinite(p.backAt) && p.backAt <= now) {
      const k = hourIndex(Math.max(p.backAt, plan.firstHourAt), plan.anchor, pb, H);
      const span = hourSpan(k, plan, breaks, H);
      const left = activeMs(span.endAt, Math.max(p.backAt, span.startAt), pb);
      const length = activeMs(span.endAt, span.startAt, pb);
      if (left >= minMs && length > 0) {
        to = k;
        const share = Math.min(1, left / length);
        if (share < 1) out.resume[k] = Math.min(out.resume[k] ?? 1, share);
      } else to = k + 1;
    }
    if (to > from) out.ranges.push({ from, to });
  }
  return out;
}
export const inLeave = (lv, k) => !!lv && lv.ranges.some((r) => k >= r.from && k < r.to);

// Per-hour targets for the scorer where they differ from its plain target (ctx.target = the
// override, else the default): a pro-rated first hour, hours a reduce-break overlaps, judged
// hours' frozen targets. Undefined when there's nothing special.
export function planTargets(plan, { override = null, targetPerHour, breaks, hourMs, frozen = null, resume = null }) {
  if (!plan) return undefined;
  const ks = new Set(reducedHours(plan, breaks, hourMs));
  if (Number.isFinite(plan.firstTarget)) ks.add(0);
  for (const k of Object.keys(frozen || {})) if (Number.isFinite(frozen[k])) ks.add(Number(k));
  for (const k of Object.keys(resume || {})) ks.add(Number(k)); // a return mid-hour (SPEC §33)
  const out = {};
  for (const k of ks) out[k] = hourTarget(k, { plan, override, targetPerHour, frozen, breaks, hourMs, resume }).target;
  return Object.keys(out).length ? out : undefined;
}
// A user's frozen targets ({ k: target }) from what was recorded when their hours were judged.
export const frozenTargets = (u) => {
  if (!u || !u.judged) return null;
  const out = {};
  for (const [k, j] of Object.entries(u.judged)) if (j && Number.isFinite(j.target)) out[k] = j.target;
  return out;
};
