// The seam between the party engine (lib/party.js) and the scoring rules
// (lib/score.js, "settled new words", SPEC §11). party.js talks only to this
// module; swapping the rules means re-implementing createEngine() and the
// constants below, nothing else.
//
// Ops are stored compactly by party.js and converted here:
//   stored: { t, post, pane: 'b' | 'n', pos, del, ins, x?: { s?, m?, d?, r? } }
//     s  source claimed by the editor: 'ime' | 'autocorrect' | 'dictation' | 'paste' | 'move' (default 'type')
//     m  paste mask: '0'/'1' per whitespace-separated word, '1' = "I wrote this today"
//     d  the paste dialog's decision: 'no' | 'yes' | 'short' | 'auto' | 'file' | 'move'
//     r  when the server received the op, if well after t (an offline queue): late work
//   engine: { t, post, pane: 'body' | 'notes', pos, del, ins, source, confirm?, r? }

import { createParty, DEFAULT_SETTINGS, NC_KEYS, rawWords as wordyWords } from './score.js';
import { normalizeBreaks } from './hours.js';
import { rawWords } from '../public/js/text.js';

// Settings the scorer doesn't use but the party does (SPEC §10).
// Automatic notices (SPEC §22, lib/notify.js), each with a host switch.
export const NOTIFY_DEFAULTS = Object.freeze({ 'notify.approved': true, 'notify.warning': true, 'notify.breaks': true, 'notify.out': true });
export const APP_DEFAULTS = Object.freeze({ missedHourOutcome: 'out', freePassesPerWriter: 1, personalTargets: false, maxUsers: 120, approvalRequired: true, ...NOTIFY_DEFAULTS });
// App settings that don't change any score (saved and applied at once, no re-score).
export const APP_KEYS = Object.freeze(Object.keys(APP_DEFAULTS));
// How hours run (SPEC §17): changing these moves hour windows, so they re-score like scoring settings.
export const HOUR_DEFAULTS = Object.freeze({ hoursMode: 'synced', syncMinute: 0, minFirstHourMin: 20 });
export const DEFAULT_SCORING = Object.freeze({ ...DEFAULT_SETTINGS, ...APP_DEFAULTS, ...HOUR_DEFAULTS });
// Keys of a result's notCounted breakdown, in display order.
export const NOT_COUNTED = Object.freeze([...NC_KEYS, 'overPasteCap']);
export const SOURCES = Object.freeze(['type', 'ime', 'autocorrect', 'dictation', 'paste', 'move']); // 'move': footnotes put in order (lib/score.js)
// Human labels for scoring flags (host dashboard, alerts and the log never show code names).
export const FLAG_LABELS = Object.freeze({
  gibberish: 'Keyboard mash',
  lorem: 'Placeholder text (lorem ipsum)',
  wordSalad: 'Word salad',
  repetitive: 'Repetitive text',
  bulkInsert: 'Text inserted faster than typing',
  steadyTyping: 'Machine-steady typing',
  mostlyDeleted: 'Mostly deleted soon after typing',
  reusingWords: 'Retyped just-deleted words',
  bigPaste: 'Big paste',
  lateWork: 'Late offline work',
  otherWriter: 'Another writer’s text',
  speedCap: 'Over the speed limit',
  sustainedSpeed: 'Sustained high speed',
  recycledPhrases: 'Recycled phrases',
});
export const flagLabel = (type) => FLAG_LABELS[type] || type;

const PANE_NAME = { b: 'body', n: 'notes' };
const paneName = (code) => PANE_NAME[code] || 'body';

// Paste mask (one flag per whitespace-separated word) -> char ranges of `text`.
export function maskToRanges(text, mask) {
  const words = rawWords(text);
  const out = [];
  for (let i = 0; i < words.length; i++) {
    if (mask[i] !== '1') continue;
    const last = out[out.length - 1];
    if (last && i > 0 && mask[i - 1] === '1') last[1] = words[i].end;
    else out.push([words[i].start, words[i].end]);
  }
  return out;
}

export function toEngineOp(o) {
  const x = o.x || null;
  let source = x && SOURCES.includes(x.s) ? x.s : 'type';
  if (x && typeof x.m === 'string') source = 'paste';
  const op = { t: o.t, post: o.post, pane: paneName(o.pane), pos: o.pos, del: o.del, ins: o.ins, source };
  if (source === 'paste') op.confirm = maskToRanges(o.ins, x && typeof x.m === 'string' ? x.m : '');
  if (x && Number.isFinite(x.r)) op.r = x.r;
  return op;
}

// A scoring engine for the whole party (all writers settle in lockstep, which
// is what makes "matches another writer's text" decidable).
//   ctxOf(writerId) -> { joinedAt, breaks, target? }, asked when a writer is first seen.
export function createEngine(settings, ctxOf) {
  const ctxByWriter = {};
  const party = createParty(settings, ctxByWriter);
  const seen = new Set();
  const sizes = new Map();
  const scorer = (w) => {
    if (!seen.has(w)) {
      ctxByWriter[w] = { ...(ctxOf(w) || {}) };
      seen.add(w);
    }
    return party.scorer(w);
  };
  return {
    // Ops must come in non-decreasing time per writer (party.js guarantees it).
    apply(w, op) {
      scorer(w);
      party.apply(w, toEngineOp(op));
      sizes.set(w, (sizes.get(w) || 0) + 1);
    },
    advance(t) {
      party.advance(t);
    },
    // advance(t) in pieces that yield (lib/score.js createParty.advanceAsync).
    advanceAsync(t, opts) {
      return party.advanceAsync(t, opts);
    },
    due(t) {
      return party.due(t);
    },
    // { now, hours: [{ k, startAt, endAt, target, status, credit, written, pasted, cut,
    //   clawback, flaggedCredit, notCounted, flags }], totals, pending, flags }
    result(w, now) {
      scorer(w);
      return party.result(w, now);
    },
    size(w) {
      return sizes.get(w) || 0;
    },
    // Current text of one pane, as rebuilt from the ops.
    text(w, post, pane) {
      if (!seen.has(w)) return '';
      const P = party.scorer(w).panes.get(`${post}\u0000${paneName(pane)}`);
      return P ? P.text : '';
    },
    // Words on that pane's page now that came from pastes the writer didn't confirm (SPEC §13b).
    unconfirmedWords(w, post, pane) {
      return seen.has(w) ? party.scorer(w).unconfirmedWords(post, paneName(pane)) : 0;
    },
    // Breaks that start now or later (or end early) don't move any past word into
    // another hour, so every writer's clock can be updated in place.
    setBreaks(breaks) {
      const nb = normalizeBreaks(breaks);
      for (const w of seen) {
        party.scorer(w).breaks = nb.map((b) => ({ ...b }));
        ctxByWriter[w].breaks = nb.map((b) => ({ ...b }));
      }
    },
    // A host override of the target also moves the hour's cut cap (half the target).
    setTarget(w, target) {
      scorer(w).ctx.target = Number.isFinite(target) ? target : undefined;
    },
    // Where a writer's hour 1 starts in this engine.
    anchorOf(w) {
      return seen.has(w) ? party.scorer(w).joinedAt : undefined;
    },
    // Per-hour targets (a pro-rated first hour) and when credit starts (synced hours).
    setCtx(w, patch) {
      const sc = scorer(w);
      Object.assign(sc.ctx, patch);
      Object.assign(ctxByWriter[w], patch);
    },
    // Start time of a writer with no ops yet; returns false if a full re-score is needed.
    setJoinedAt(w, t) {
      const sc = scorer(w);
      if (sizes.get(w)) return false;
      sc.joinedAt = t;
      ctxByWriter[w].joinedAt = t;
      return true;
    },
    // Per whitespace-separated word of `text`: already credited to w / to another writer
    // (otherVisible({ w, post, pane }) filters which other writers' text may be revealed).
    pasteCheck(w, text, now, otherVisible = null) {
      const marks = scorer(w).pasteCheck(text, now, otherVisible); // one per word containing a letter or digit
      const wordy = wordyWords(text);
      const all = rawWords(text);
      const index = new Map(all.map((x, i) => [x.start, i]));
      const own = new Array(all.length).fill('0');
      const other = new Array(all.length).fill('0');
      marks.forEach((m, i) => {
        const j = index.get(wordy[i]?.start);
        if (j === undefined) return;
        if (m.own) own[j] = '1';
        if (m.other) other[j] = '1';
      });
      return { own: own.join(''), other: other.join('') };
    },
  };
}
