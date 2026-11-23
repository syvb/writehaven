// The party engine: users, sessions, posts, the op log, phases, breaks, free
// hours, alerts, reviews, and every view (writer, host, public). In-memory state
// that the server persists as one JSON file plus an op journal. Scoring rules
// live behind lib/scoring.js.

import crypto from 'node:crypto';
import { createEngine, DEFAULT_SCORING, NOT_COUNTED, SOURCES, FLAG_LABELS, flagLabel, APP_KEYS } from './scoring.js';
import { lateAfterMs } from './score.js';
import { writerProgress, passHour, passesLeft, editShare, median, personalFactor, carryCap } from './progress.js';
import { normalizeBreaks, hourIndex, breakAt, activeMs, planFor, nextWindowStart, pauseBreaks, reduceBreaks, breakModeOf, hourSpan, planTargets, frozenTargets, leavePeriods, leaveHours, gridAnchor, reducedTarget } from './hours.js';
import { rawWords, countWords, wordsRemoved, cutsOf, BIG_CUT_WORDS, wordSpan } from '../public/js/text.js';
import { foodWordsOf } from './food.js';
import { displayNameError, publicDisplayName, cleanEmail, emailProblem } from '../public/js/names.js';
import { sanitizeText, sanitizeWithMap, PhantomMap, remapMask } from './sanitize.js';
import { opsFromJournalRecs, computePreview, afterEndTest } from './preview.js';

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const USERNAME_RE = /^[a-z0-9_.-]{2,24}$/;
const MAX_POSTS = 60;
const MAX_PANE_CHARS = 500_000;
const MAX_OPS_PER_BATCH = 2000;
const MAX_INS = 300_000;
const MAX_BACKDATE_MS = 2 * 3600_000; // queued offline ops keep their timing up to this far back
// "Online time follows the server": per session (browser), the server remembers when it saw
// requests. A claimed op time older than receipt - ONLINE_SLACK_MS is kept only inside a gap of
// >= GAP_MS without requests (or the slack before it: the batch in flight when the line dropped).
export const GAP_MS = 20_000;
export const ONLINE_SLACK_MS = 15_000;
const GAP_KEEP_MS = MAX_BACKDATE_MS + 15 * 60_000;
const MAX_GAPS = 200;
// Recent batches per pane, kept in memory so a version conflict can carry what a 3-way merge
// needs (the text at the client's base version and the batches since). Batch ids are kept for
// the whole party (this.seqs), not just these.
const RING_BATCHES = 200;
const RING_CHARS = 2_000_000;
const SESSION_TTL_MS = 30 * 24 * 3600_000;
const MAX_SESSIONS_PER_USER = 12;
const RECOMPUTE_MIN_MS = 1000; // results are cached this long (they depend on the clock)
const PANES = { body: 'b', notes: 'n' };
const UNDO_MS = 2 * 60_000; // "Don't count" and "Mark as out" can be undone this long
const RESCORE_DELAY_MS = 600; // settings edits are debounced this long before re-scoring
const RESCORE_SLICE_MS = 20; // the background re-score yields to requests this often
const APP_KEY_SET = new Set(APP_KEYS);
export const DEFAULT_PUBLIC_URL = 'https://writehaven.example.org';
// The party clock (env WH_TZ): every time the server writes out (status lines, alerts, the log,
// synced hour windows, export stamps) is on it, daylight saving included.
export const DEFAULT_TZ = 'Europe/London';
// Settings the host form can't change: test knobs (an unchanged value in a form is ignored).
const TEST_ONLY = new Set(['hourLengthMin']);
// Human names of settings, for the log and the host form (the key is shown for the rest).
export const SETTING_LABELS = Object.freeze({
  targetPerHour: 'Target per hour', freePassesPerWriter: 'Free hours per writer', missedHourOutcome: 'When an hour is missed',
  carryOverMax: 'Extra words carried to the next hour, at most',
  settleSec: 'A word counts after (seconds)', contextWords: 'Already-written window (words)', reuseWindowMin: 'Re-used words window (minutes)',
  cutWeight: 'Cut credit per word', cutMatureMin: 'Cut text must be older than (minutes)', cutCapPerHour: 'Cut credit cap per hour',
  pasteAskOverWords: 'Ask about pastes over (words)', shortPastesCount: 'Short pastes count like typing', ownCutWindowMin: 'Pasted own words: cut within (minutes)',
  bigPasteWords: 'Big paste (review) from (words)', reviewBigPastes: 'Hours that need 100+ pasted words go to review', pasteCapPerHour: 'Paste credit cap per hour',
  speedCapWpm: 'Speed limit, typing (words a minute)', dictationCapWpm: 'Speed limit, dictation (words a minute)', personalTargets: 'Personal targets',
  unit: 'Count', maxUsers: 'Most accounts', approvalRequired: 'New accounts need approval', hourLengthMin: 'Hour length (test only)',
  hoursMode: 'Hours', syncMinute: 'Hours start at minute', minFirstHourMin: 'Shortest first hour (minutes)',
  'notify.approved': 'Tell people when they’re approved', 'notify.warning': 'Warn writers 15 minutes before a missed hour',
  'notify.breaks': 'Announce breaks', 'notify.out': 'Tell writers when they’re out',
});
const settingName = (k) => SETTING_LABELS[k] || k;
const PRIVACY = new Set(['live', 'separate', 'named', 'private']); // private: never published (SPEC §26)
// After the party (SPEC §30): a post's edit session, opened by its first change after the end,
// closes after this long without changes; its ops carry x.e and never reach the scorer (unless
// the host resumed the party after them: Party#resume, lib/preview.js afterEndTest).
const AFTER_EDIT_IDLE_MS = 30 * 60_000;
const STATIC_NOTE_MAX = 20_000; // characters in the static site's front-page note
// The public pages' note on a post changed after the party (SPEC §30): started after it, or edited.
const afterNote = (p) => (p.after?.added ? { added: true } : p.after?.edited ? { edited: true } : {});
// The same note on a post of an earlier round (lib/rounds.js keeps it as a flag).
const pastNote = (p) => (p.added ? { added: true } : p.edited ? { edited: true } : {});

// A user's extra-credit entries (SPEC §20c), valid ones only, as copies.
function bonusEntries(u) {
  return Array.isArray(u?.bonusCredit) ? u.bonusCredit.filter((b) => b && Number.isFinite(b.at) && b.words > 0).map((b) => ({ ...b })) : [];
}

export function cleanLine(s, max) {
  if (typeof s !== 'string') return null;
  const v = sanitizeText(s.replace(/[\t\n\r\v\f]/g, ' ')).replace(/\s+/g, ' ').trim();
  return [...v].slice(0, max).join('');
}

export function validatePassword(p) {
  if (typeof p !== 'string' || p.length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
  if (p.length > 200) throw new HttpError(400, 'Password is too long');
  return p;
}

const B32 = 'abcdefghijkmnpqrstuvwxyz23456789';
export function randomId(len = 12) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += B32[bytes[i] % 32];
  return s;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const isPlainObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// Settings: [type, min, max] or an enum list. 'num?' also accepts null (empty).
const RULE_OVERRIDES = {
  targetPerHour: ['int', 0, 100000],
  hourLengthMin: ['num', 0.5, 1440],
  unit: [['word', 'chars']],
  oneLetterWord: ['num', 0, 1],
  charsPerWord: ['num', 1, 20],
  maxTokenWords: ['num', 1, 20],
  settleSec: ['num', 0, 3600],
  settleQuantumSec: ['num', 1, 60],
  contextWords: ['int', 3, 30],
  reuseWeight: ['num', 0, 1],
  cutCapPerHour: ['num?', 0, 100000],
  pasteCapPerHour: ['num?', 0, 100000],
  pasteAskOverWords: ['int', 0, 10000],
  speedCapWpm: ['num', 1, 100000],
  dictationCapWpm: ['num', 1, 100000],
  missedHourOutcome: [['out', 'alert-only']],
  freePassesPerWriter: ['int', 0, 100],
  carryOverMax: ['int', 0, 100000],
  maxUsers: ['int', 1, 1000],
  hoursMode: [['synced', 'personal']],
  syncMinute: ['int', 0, 59],
  minFirstHourMin: ['int', 0, 59],
};
const HOUR_KEYS = new Set(['hoursMode', 'syncMinute', 'minFirstHourMin', 'hourLengthMin']);
export const SETTING_RULES = Object.fromEntries(Object.entries(DEFAULT_SCORING).map(([k, v]) => [k,
  RULE_OVERRIDES[k] || (typeof v === 'boolean' ? ['bool'] : v === null ? ['num?', 0, 1e6] : ['num', 0, 1e6])]));

// Note a request from a session (or the stand-in record of a writer without one) at `now`:
// a silence of GAP_MS or more since the previous request becomes a gap [last, now].
export function notePresence(rec, now, fallback = null) {
  let last = rec.seen;
  if (!Number.isFinite(last)) last = Number.isFinite(fallback) ? Math.max(fallback, rec.createdAt ?? -Infinity) : rec.createdAt;
  if (Number.isFinite(last) && now - last >= GAP_MS) {
    const gaps = Array.isArray(rec.gaps) ? rec.gaps : (rec.gaps = []);
    gaps.push([last, now]);
    const keep = now - GAP_KEEP_MS;
    while (gaps.length && (gaps.length > MAX_GAPS || gaps[0][1] < keep)) gaps.shift();
  }
  if (!Number.isFinite(rec.seen) || now > rec.seen) rec.seen = now;
}

// The time an op claimed to be typed at `c` may be credited to: `c` itself if it's recent, or
// inside a gap in the session's requests (or before the session existed: signed in again on a
// device that was offline). Otherwise the next time that is allowed.
export function allowedTime(rec, c, now) {
  if (c >= now - ONLINE_SLACK_MS) return c;
  if (Number.isFinite(rec.createdAt) && c <= rec.createdAt) return c;
  for (const [gs, ge] of rec.gaps || []) {
    if (c < gs - ONLINE_SLACK_MS) return gs - ONLINE_SLACK_MS;
    if (c <= ge) return c;
  }
  return now - ONLINE_SLACK_MS;
}

// How many words (raw words with a letter or digit) replacing text[pos, pos+del) with `ins`
// adds or removes, looking only at the words around the change (text.js wordSpan: at most 200
// characters each way).
export function wordDelta(text, pos, del, ins) {
  const [a, b] = wordSpan(text, pos, pos + del);
  return countWords(text.slice(a, pos) + ins + text.slice(pos + del, b)) - countWords(text.slice(a, b));
}

export function freshState() {
  return {
    v: 1,
    party: { name: 'Writehaven', phase: 'lobby', startedAt: null, endedAt: null, archiveOrder: null, registrationOpen: true, plannedEnd: null, plannedStart: null },
    settings: { scoring: { ...DEFAULT_SCORING } },
    users: {},
    sessions: {},
    posts: {},
    ops: {},
    breaks: [],
    alerts: [],
    log: [],
  };
}

export class Party {
  // journal: { userId: [[postId, paneCode, versionAfter, [[t, pos, del, ins, paste?]...]], ...] }
  // (lib/journal.js). When given, the op log comes from it rather than from state.ops.
  // testKnobs: the host may change test-only settings (hourLengthMin); env WH_TEST_KNOBS=1.
  // overrides: settings forced at start (env WH_HOUR_MIN). publicUrl / tz: party meta (env).
  // asyncRescore: settings changes re-score in the background (the server); tests re-score at once.
  // journal: { userId: [records] } read at boot (null: ops come inline in the state). journalFresh:
  // the journal directory didn't exist before this boot (see the text restore below).
  // pastRounds: the closed rounds' records (lib/rounds.js loadRounds), oldest first.
  constructor({ state = null, journal = null, journalFresh = false, now = Date.now, adminUsers = [], log = console, recomputeMinMs = RECOMPUTE_MIN_MS,
    testKnobs = false, overrides = null, publicUrl = DEFAULT_PUBLIC_URL, tz = null, asyncRescore = false, pastRounds = [] } = {}) {
    this.now = now;
    this.setPastRounds(pastRounds);
    this.asyncRescore = !!asyncRescore;
    this.rescoring = false; // a background re-score is running (the host sees it)
    this.rescoreGen = 0;
    this.rescoreTimer = null;
    this.nextEngine = null; // the engine being built in the background
    this.previewer = null; // (job) => Promise<{ changes, ms }>: the server runs it in a worker
    this.testKnobs = !!testKnobs;
    this.publicUrl = publicUrl || DEFAULT_PUBLIC_URL;
    this.tz = tz || DEFAULT_TZ;
    this.undos = new Map(); // undoId -> what a host action changed, for 2 minutes
    this.recomputeMinMs = recomputeMinMs;
    this.logger = log;
    this.adminUsers = new Set(adminUsers.map((u) => String(u).trim().toLowerCase()).filter(Boolean));
    const base = freshState();
    this.state = state ? { ...base, ...state } : base;
    const st = this.state;
    st.party = { ...base.party, ...(st.party || {}) };
    st.settings = { scoring: { ...DEFAULT_SCORING, ...((st.settings && st.settings.scoring) || {}), ...(overrides || {}) } };
    for (const k of ['users', 'sessions', 'posts', 'ops']) if (!isPlainObject(st[k])) st[k] = {};
    for (const k of ['breaks', 'alerts', 'log']) if (!Array.isArray(st[k])) st[k] = [];
    this.byUsername = new Map();
    for (const u of Object.values(st.users)) this.byUsername.set(u.username, u);
    this.onChange = () => {};
    this.publicRev = 0; // bumped by changes to what the public may see (not by typing)
    this.engineRev = 0;
    this.engine = null; // lib/scoring.js: the whole party's scoring state
    this.cache = new Map(); // userId -> { key, result }
    this.onBatch = null; // (userId, journalRecord) => void; throws to refuse the batch
    this.pseudo = new Map(); // userId -> presence record, for applyOps calls without a session
    this.ring = new Map(); // `${postId}|${pane}` -> { batches: [{ v, seq, ops: [[pos, del, ins, deleted]] }], chars }
    // `${postId}|${pane}` -> Map(seq -> the version that batch produced): every batch id applied
    // this party, restored from the journal at boot, so a retried batch is never applied twice
    // however many batches followed it or restarts came between (~100 bytes a batch).
    this.seqs = new Map();
    this.lastWrite = new Map(); // `${postId}|${pane}` -> the journal promise of its last batch, until written
    this.bootSavedAt = Number.isFinite(st.savedAt) ? st.savedAt : null; // last save before this boot
    if (journal) {
      st.ops = {};
      // The journal is the source of truth for versions and batch ids too: the state file can be
      // saved after a batch was applied but before its journal line landed (it's written in the
      // background), and a crash then must not leave a version or batch id with no ops behind it.
      const last = new Map(); // `${postId}|${pane}` -> { ver, seq }
      for (const [uid, recs] of Object.entries(journal)) {
        for (const rec of recs) {
          if (!Array.isArray(rec) || rec.length < 4 || !Array.isArray(rec[3])) continue;
          const [postId, code, ver, , seq] = rec;
          const pane = code === 'n' ? 'notes' : 'body';
          const key = `${postId}|${pane}`;
          if (Number.isInteger(ver) && ver > (last.get(key)?.ver ?? -1)) last.set(key, { ver, seq: typeof seq === 'string' ? seq : null });
          if (typeof seq === 'string' && Number.isInteger(ver)) this.seqMap(key).set(seq, ver);
        }
        st.ops[uid] = opsFromJournalRecs(recs);
      }
      // A writer with no journal lines has no words yet, whatever the state file says: it can be
      // saved after their first batch was applied but before its line landed (a crash then), and
      // that batch was never acknowledged (acks wait for the journal), so it comes again. Only a
      // journal directory new at this boot (a state file moved without it) keeps stored texts.
      for (const post of Object.values(st.posts)) {
        if (!post.ver || (journalFresh && !Object.hasOwn(journal, post.ownerId))) continue;
        if (!post.seq) post.seq = { body: null, notes: null };
        for (const pane of Object.keys(PANES)) {
          const l = last.get(`${post.id}|${pane}`);
          post.ver[pane] = l ? l.ver : 0;
          post.seq[pane] = l ? l.seq : null;
        }
      }
    }
    for (const u of Object.values(st.users)) if (!isPlainObject(u.reviews)) u.reviews = {};
    this.rebuildEngine({ sync: true });
    // The op log is the source of truth for post texts. (The state file is written
    // a moment after the journal, so after a crash it can lag behind it.)
    for (const p of Object.values(st.posts)) {
      const hasOps = (st.ops[p.ownerId] || []).length > 0;
      const journaled = journal && !(journalFresh && !Object.hasOwn(journal, p.ownerId));
      for (const [pane, code] of Object.entries(PANES)) {
        if (!hasOps && !journaled) {
          if (p[pane]) this.logger.error(`[party] post ${p.id} ${pane}: no op log for its writer; keeping the stored text`);
          continue;
        }
        const t = this.withAfterEnd(p, code, this.engine.text(p.ownerId, p.id, code)); // + edits after the party (SPEC §30)
        if (t !== (p[pane] || '')) {
          if (!journal) this.logger.error(`[party] post ${p.id} ${pane}: stored text differs from the op log replay; using the replay`);
          else if (!hasOps) this.logger.error(`[party] post ${p.id} ${pane}: text that never reached the journal dropped (never acknowledged: the writer's device sends it again)`);
          p[pane] = t;
        }
      }
      // Words on the page now (kept up to date by every op batch; for the "words today" total).
      p.words = countWords(p.body || '');
    }
  }

  // Score everything again from the op log: after a settings change, a new start
  // time or a break (scoring is a pure function of ops + settings + writers' clocks).
  engineCtx(uid, S = this.S) {
    const u = this.userById(uid);
    const plan = u ? this.planOf(u, S) : null;
    return {
      joinedAt: plan ? plan.anchor : undefined,
      breaks: pauseBreaks(this.state.breaks), // reduce-breaks don't move hours (SPEC §19)
      target: u && Number.isFinite(u.targetOverride) ? u.targetOverride : undefined,
      targets: u ? this.scorerTargets(u, plan, S) : undefined,
      bonus: u ? bonusEntries(u) : undefined, // SPEC §20c: food-form words, by save time
      trustPastes: !!u?.trustPastes, // a host trusts their pastes: never flagged as big pastes
      shareable: (post, pane) => this.isSharedText(post, pane),
      timeline: true, // words per minute, for the host's "usually writes N a minute"
    };
  }
  // Text other writers' work is compared with: the body of a public post ('live' or 'named', not
  // hidden). Separate-identity posts, and any privacy added later (SPEC §26 private), stay out.
  isSharedText(postId, pane) {
    if (pane !== 'body') return false;
    const p = typeof postId === 'string' && Object.hasOwn(this.state.posts, postId) ? this.state.posts[postId] : null;
    return !!p && (p.privacy === 'live' || p.privacy === 'named') && !p.unlisted;
  }
  // Pro-rated first hours and hours lowered by reduce-breaks, for the scorer (cut caps, reviews).
  scorerTargets(u, plan, S = this.S) {
    const resume = plan ? leaveHours(leavePeriods(u), plan, { S, breaks: this.state.breaks }).resume : null; // a return mid-hour (SPEC §33)
    return planTargets(plan, { override: u.targetOverride, targetPerHour: S.targetPerHour, breaks: this.state.breaks, hourMs: S.hourLengthMin * 60_000, frozen: frozenTargets(u), resume });
  }
  // A writer's hours (SPEC §17): where hour 1 starts, when they start, a pro-rated first target.
  planOf(u, S = this.S) {
    if (!u || !Number.isFinite(u.joinedAt)) return null;
    return planFor({ joinedAt: u.joinedAt, settings: S, startedAt: this.state.party.startedAt, breaks: this.state.breaks, tz: this.tz });
  }
  anchorOf(u) {
    const p = this.planOf(u);
    return p ? p.anchor : u.joinedAt;
  }
  // Point the scoring engine(s) at a writer's plan; false if a full re-score is needed. Each
  // engine gets the plan under its own settings: the one being built in the background may have
  // other hours (a switch to synced hours) than the one serving now.
  applyPlan(u) {
    let ok = true;
    for (const [eng, S] of [[this.engine, this.S], [this.nextEngine, this.nextSettings]]) {
      if (!eng) continue;
      const plan = this.planOf(u, S);
      if (!plan) continue;
      if (eng.anchorOf(u.id) !== plan.anchor && !eng.setJoinedAt(u.id, plan.anchor)) ok = false;
      else eng.setCtx(u.id, { targets: this.scorerTargets(u, plan, S) });
    }
    return ok;
  }
  // Extra credit from outside the op log (SPEC §20c: food-form words): { at, words, source } is
  // kept on the user (so restarts and re-scores keep it) and counts in the hour containing `at`.
  addBonusCredit(userId, { at = this.now(), words, source }) {
    const u = this.requireUser(userId);
    const w = Math.round(Number(words));
    if (!(w > 0) || !Number.isFinite(at)) return;
    u.bonusCredit = [...bonusEntries(u), { at, words: w, source: String(source || 'other') }];
    for (const eng of [this.engine, this.nextEngine]) eng?.setCtx(u.id, { bonus: bonusEntries(u) });
    this.cache.delete(u.id);
    this.totalsCache = null;
    this.touch();
  }
  // A full re-score from the op log. With asyncRescore it runs in the background (see
  // requestRescore); { sync: true } (boot) builds it right here.
  rebuildEngine({ sync = false } = {}) {
    if (this.asyncRescore && !sync) {
      this.requestRescore({ delay: 0 });
      return;
    }
    const t0 = performance.now();
    this.active = { ...this.state.settings.scoring };
    this.engine = createEngine(this.active, (uid) => this.engineCtx(uid));
    const all = [];
    for (const [uid, ops] of Object.entries(this.state.ops)) ops.forEach((o, i) => { if (!this.isAfterEnd(o)) all.push([uid, o, i]); }); // edits after the party never count
    all.sort((a, b) => a[1][0] - b[1][0] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) || a[2] - b[2]);
    const failed = new Set();
    for (const [uid, o] of all) {
      if (failed.has(uid)) continue;
      try {
        this.engine.apply(uid, this.opFromStored(o));
      } catch (e) {
        failed.add(uid);
        this.logger.error(`[party] scoring replay stopped for ${uid}: ${e.message}`);
      }
    }
    this.engine.advance(this.now());
    this.engineRev++;
    this.cache.clear();
    this.totalsCache = null;
    this.needsReconcile = true; // judged hours may read differently now (see reconcileJudged)
    const ms = performance.now() - t0;
    if (ms > 1000) this.logger.log?.(`[party] re-scored ${all.length} ops in ${Math.round(ms)} ms`);
  }

  // Re-score everyone in the background: the current numbers keep serving until the new
  // engine has replayed the whole log (in slices that yield to requests), then it swaps in at
  // once. Edits within `delay` of each other are coalesced; a newer edit restarts the run.
  requestRescore({ delay = RESCORE_DELAY_MS } = {}) {
    if (!this.asyncRescore) {
      this.rebuildEngine({ sync: true });
      return;
    }
    this.rescoring = true;
    this.rescoreGen++; // a run in progress stops at its next slice
    clearTimeout(this.rescoreTimer);
    this.rescoreTimer = setTimeout(() => {
      this.rescoreTimer = null;
      this.runRescore().catch((e) => {
        this.logger.error(`[party] background re-score failed (${e && e.message}); re-scoring at once`);
        this.nextEngine = null;
        this.rebuildEngine({ sync: true });
        this.rescoring = false;
        this.touch();
      });
    }, delay);
    this.rescoreTimer.unref?.();
  }
  async runRescore() {
    const gen = ++this.rescoreGen;
    this.rescoring = true;
    const t0 = performance.now();
    const settings = { ...this.state.settings.scoring };
    const engine = createEngine(settings, (uid) => this.engineCtx(uid, settings));
    this.nextEngine = engine;
    this.nextSettings = settings;
    const cursors = new Map(); // userId -> index of the next op to replay
    const failed = new Set();
    let n = 0;
    let until = performance.now() + RESCORE_SLICE_MS;
    const yieldNow = () => performance.now() > until;
    const pause = async () => {
      await new Promise((r) => setImmediate(r));
      until = performance.now() + RESCORE_SLICE_MS;
    };
    const stop = () => gen !== this.rescoreGen; // superseded by a newer change
    // Replay the ops beyond the cursors in global time order (ties: writer id, then log order),
    // like rebuildEngine, in slices. False if superseded.
    const replay = async () => {
      for (;;) {
        if (stop()) return false;
        for (const uid of Object.keys(this.state.ops)) if (!cursors.has(uid)) cursors.set(uid, 0);
        for (;;) {
          let bu = null;
          let bo = null;
          for (const [uid, i] of cursors) {
            const ops = this.state.ops[uid];
            if (!ops || i >= ops.length) continue;
            const o = ops[i];
            if (bo === null || o[0] < bo[0] || (o[0] === bo[0] && uid < bu)) {
              bu = uid;
              bo = o;
            }
          }
          if (bu === null) return true;
          cursors.set(bu, cursors.get(bu) + 1);
          if (!failed.has(bu) && !this.isAfterEnd(bo)) { // edits after the party never count
            const op = this.opFromStored(bo);
            // Words this op's time makes due are settled in slices first (a burst of ops with
            // one timestamp can make thousands due at once), so apply() itself stays quick.
            if (engine.due(op.t)) {
              await engine.advanceAsync(op.t, { yieldNow, pause, stop });
              if (stop()) return false;
            }
            try {
              engine.apply(bu, op);
            } catch (e) {
              failed.add(bu);
              this.logger.error(`[party] scoring replay stopped for ${bu}: ${e.message}`);
            }
          }
          if ((++n & 127) === 0 && yieldNow()) break;
        }
        await pause();
      }
    };
    const pendingOps = () => {
      for (const [uid, ops] of Object.entries(this.state.ops)) if ((cursors.get(uid) || 0) < ops.length) return true;
      return false;
    };
    for (;;) {
      if (!(await replay())) return;
      // Settle what's due by now, in slices as well: a log of bursts can hold a lot of it.
      await engine.advanceAsync(this.now(), { yieldNow, pause, stop });
      if (stop()) return;
      if (!pendingOps()) break; // ops that came in meanwhile: replay them too
    }
    // From here on it's synchronous, so nothing can arrive before the swap; what's left to
    // settle is at most the last moments.
    engine.advance(this.now());
    this.engine = engine;
    this.nextEngine = null;
    this.active = settings;
    this.engineRev++;
    this.cache.clear();
    this.totalsCache = null;
    this.needsReconcile = true;
    this.rescoring = false;
    this.lastRescore = { ops: n, ms: Math.round(performance.now() - t0), at: this.now() };
    this.logger.log?.(`[party] re-scored ${n} ops in ${this.lastRescore.ms} ms (background)`);
    this.touch();
    this.tick(); // judge hours with the new numbers
  }

  // What a settings patch (and per-writer target overrides) would change: Promise<{ changes, ms }>.
  previewSettings(adminId, body) {
    this.requireAdmin(adminId);
    if (!isPlainObject(body)) throw new HttpError(400, 'Bad request');
    const { next } = this.validateSettings(body.patch ?? {});
    const overrides = new Map();
    const carryOverrides = new Map();
    for (const w of Array.isArray(body.writers) ? body.writers.slice(0, 1000) : []) {
      if (!isPlainObject(w) || !this.userById(w.id)) throw new HttpError(404, 'No such writer');
      if (w.targetOverride !== undefined) {
        const v = w.targetOverride;
        if (v === null || v === '') overrides.set(w.id, null);
        else if (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 100000) overrides.set(w.id, Number(v));
        else throw new HttpError(400, 'Target must be a whole number');
      }
      if (w.carryOverride !== undefined) carryOverrides.set(w.id, Party.carryValue(w.carryOverride));
    }
    const users = Object.values(this.state.users).map((u) => ({
      id: u.id, name: u.name, joinedAt: u.joinedAt, freeHours: u.freeHours || [], reviews: u.reviews || {}, reviewSeen: u.reviewSeen || null,
      targetOverride: u.targetOverride ?? null, carryOverride: u.carryOverride ?? null, trustPastes: !!u.trustPastes, extraPasses: u.extraPasses || 0, judged: u.judged || null, bonusCredit: bonusEntries(u),
      leftAt: Number.isFinite(u.leftAt) ? u.leftAt : null, leaves: u.leaves || [], // SPEC §33
    }));
    const usersAfter = users.map((u) => ({
      ...u,
      ...(overrides.has(u.id) ? { targetOverride: overrides.get(u.id) } : {}),
      ...(carryOverrides.has(u.id) ? { carryOverride: carryOverrides.get(u.id) } : {}),
    }));
    // Breaks as they would be: { id, mode?, cancel? } per changed break (SPEC §19).
    let breaksAfter = null;
    if (Array.isArray(body.breaks) && body.breaks.length) {
      const now = this.now();
      breaksAfter = this.state.breaks.map((b) => ({ id: b.id, startAt: b.startAt, endAt: b.endAt, mode: breakModeOf(b) }));
      for (const ch of body.breaks.slice(0, 50)) {
        const b = isPlainObject(ch) ? breaksAfter.find((x) => x.id === ch.id) : null;
        if (!b) throw new HttpError(404, 'No such break');
        if (ch.mode !== undefined) {
          if (ch.mode !== 'pause' && ch.mode !== 'reduce') throw new HttpError(400, 'mode must be pause or reduce');
          b.mode = ch.mode;
        }
        if (ch.cancel === true) {
          if (b.startAt >= now) b.endAt = b.startAt; // a scheduled break goes away
          else b.endAt = Math.min(b.endAt, now); // a running one ends now
        }
      }
      breaksAfter = breaksAfter.filter((b) => b.endAt > b.startAt);
    }
    const job = {
      settingsBefore: { ...this.S }, settingsAfter: next, users, usersAfter,
      breaks: this.state.breaks.map((b) => ({ id: b.id, startAt: b.startAt, endAt: b.endAt, mode: breakModeOf(b) })),
      breaksAfter,
      privatePosts: Object.values(this.state.posts).filter((p) => !this.isSharedText(p.id, 'body')).map((p) => p.id),
      party: { phase: this.phase, endedAt: this.state.party.endedAt, startedAt: this.state.party.startedAt, tz: this.tz, resumed: this.state.party.resumed || [] }, now: this.now(),
    };
    if (this.previewer) return this.previewer(job);
    const t0 = performance.now();
    const changes = computePreview({ ...job, opsByUser: this.state.ops });
    return Promise.resolve({ changes, ms: Math.round(performance.now() - t0) });
  }

  // A break changed from time `from` on. If no op is later than that, no word moves
  // to another hour and the clocks are updated in place; otherwise re-score.
  // windowsMoved: a pause-break changed (hours after it shift); a reduce-break only changes targets.
  updateEngineBreaks(from, { windowsMoved = true } = {}) {
    let last = -Infinity;
    for (const u of Object.values(this.state.users)) if (u.lastOpAt > last) last = u.lastOpAt;
    let moved = windowsMoved && last > from;
    if (!moved) {
      this.engine.setBreaks(pauseBreaks(this.state.breaks));
      this.nextEngine?.setBreaks(pauseBreaks(this.state.breaks));
      // Targets (reduce-breaks) and, in synced hours, a writer's hour 1 may change too.
      for (const u of Object.values(this.state.users)) if (this.planOf(u) && !this.applyPlan(u)) moved = true;
    }
    if (moved) this.rebuildEngine();
    this.cache.clear();
    this.totalsCache = null;
  }
  // Hours moved (settings or a break's mode): judging carries on from now under the new windows.
  // Hours no longer over lose their frozen target; hours now over count as judged (their record
  // is filled in, without alerts, once the re-score is in: see reconcileJudged).
  resetJudging(now = this.now(), S = this.S) {
    const pb = pauseBreaks(this.state.breaks);
    for (const u of Object.values(this.state.users)) {
      const plan = this.planOf(u, S);
      if (!plan) continue;
      u.evaluatedThrough = Math.max(-1, hourIndex(now, plan.anchor, pb, S.hourLengthMin * 60_000) - 1);
      u.judged ||= {};
      for (const k of Object.keys(u.judged)) if (Number(k) > u.evaluatedThrough) delete u.judged[k];
      for (let k = 0; k <= u.evaluatedThrough; k++) if (!u.judged[k]) u.judged[k] = { pending: true };
    }
    this.needsReconcile = true;
  }

  // What goes into the JSON state file (the op log lives in the journal when there is one).
  snapshot({ withOps = false } = {}) {
    this.state.savedAt = this.now();
    if (withOps) return this.state;
    const { ops, ...rest } = this.state;
    return rest;
  }

  // The settings every number shown was computed with. While a background re-score runs, the
  // saved settings (state.settings.scoring) can be ahead of these; app-only settings (missed-hour
  // outcome, passes, personal targets, user cap) apply at once.
  get S() {
    return this.active;
  }
  get phase() {
    return this.state.party.phase;
  }
  // Which round of the party this is: 1, then one more after each --new-round (lib/rounds.js).
  get round() {
    const r = this.state.party.round;
    return Number.isInteger(r) && r > 0 ? r : 1;
  }

  touch() {
    this.onChange();
  }

  addLog(type, { userId = null, by = null, text = '' } = {}) {
    this.state.log.push({ t: this.now(), type, userId, by, text });
    if (this.state.log.length > 5000) this.state.log.splice(0, this.state.log.length - 5000);
  }

  // ------------------------------------------------------------ users
  userById(id) {
    return id && Object.hasOwn(this.state.users, id) ? this.state.users[id] : null;
  }
  userByUsername(name) {
    if (typeof name !== 'string') return null;
    return this.byUsername.get(name.trim().toLowerCase()) || null;
  }
  requireUser(id) {
    const u = this.userById(id);
    if (!u) throw new HttpError(401, 'Please sign in first');
    return u;
  }
  requireAdmin(id) {
    const u = this.requireUser(id);
    if (!u.isAdmin) throw new HttpError(404, 'Not found');
    return u;
  }

  // opts.ignoreCap: a sign-up from the venue (server.js) isn't refused by the account cap.
  // ------------------------------------------------------------ approval (SPEC §15)
  // The state that counts: admins, accounts from before the field existed and everyone while
  // approval is off are approved.
  approvalOf(u) {
    if (!u) return null;
    if (u.isAdmin || !this.S.approvalRequired) return 'approved';
    return u.approval === 'pending' || u.approval === 'declined' ? u.approval : 'approved';
  }
  isApproved(u) {
    return this.approvalOf(u) === 'approved';
  }
  // Writer endpoints: refused until the host approves the account, and until it's in this round.
  requireApproved(userId) {
    const u = this.requireUser(userId);
    if (!this.isApproved(u)) throw new HttpError(403, 'pending_approval', { code: 'pending_approval', approval: this.approvalOf(u) });
    if (!this.inRound(u)) throw new HttpError(403, 'not_in_round', { code: 'not_in_round', round: this.round });
    return u;
  }
  // Rounds (lib/rounds.js): an account takes part in the round it signed up in, and in a later
  // round once it joins it (POST /api/round/join, from the card a returning writer sees when they
  // sign in). Until then it isn't one of this round's writers: not on the list of writers, the
  // host's table, message groups, break notices or the food lists, and it can't write. Hosts keep
  // their host powers either way. Accounts from before rounds existed belong to round 1.
  inRound(u) {
    return !!u && (Number.isInteger(u.round) ? u.round : 1) === this.round;
  }
  joinRound(userId) {
    const u = this.requireUser(userId);
    if (!this.inRound(u)) {
      u.round = this.round;
      this.publicRev++; // the list of writers
      this.addLog('round-join', { userId: u.id, text: `joined round ${this.round}` });
      this.touch();
    }
    return { round: this.round, inRound: true };
  }
  setApprovalMessage(userId, message) {
    const u = this.requireUser(userId);
    const now = this.now();
    if (typeof message !== 'string') throw new HttpError(400, 'Message must be text');
    const m = [...sanitizeText(message).trim()].slice(0, 500).join('');
    if (!m) throw new HttpError(400, 'Message can’t be empty');
    if (Number.isFinite(u.approvalMessageAt) && now - u.approvalMessageAt < 10_000) {
      throw new HttpError(429, 'too_fast', { code: 'too_fast', retryAfterMs: 10_000 - (now - u.approvalMessageAt) });
    }
    u.approvalMessage = m;
    u.approvalMessageAt = now;
    const state = this.approvalOf(u);
    if (state !== 'approved') {
      if (u.approval === 'declined') u.approval = 'pending'; // a new message puts the request back in the queue
      // A fresh alert for the host (the old one, if any, is replaced).
      for (const al of this.state.alerts) if (al.userId === u.id && al.kind === 'approval' && !al.ack) Object.assign(al, { ack: true, replaced: true });
      this.pushAlert({ kind: 'approval', t: now, userId: u.id, message: m });
    }
    this.addLog('approval-message', { userId: u.id, text: state === 'declined' ? 'asked again for approval' : 'sent the host a message' });
    this.touch();
    return { approvalMessageAt: now };
  }
  decideApproval(adminId, userId, decision, note = null) {
    const a = this.requireAdmin(adminId);
    const u = this.userById(userId);
    if (!u) throw new HttpError(404, 'No such writer');
    if (u.isAdmin) throw new HttpError(409, 'Hosts are always approved');
    const now = this.now();
    u.approval = decision;
    u.approvalAt = now;
    u.approvalBy = a.id;
    if (decision === 'declined') {
      if (note !== null && note !== undefined && typeof note !== 'string') throw new HttpError(400, 'Note must be text');
      const n = note ? [...sanitizeText(note).trim()].slice(0, 300).join('') : '';
      u.approvalNote = n || null;
    } else u.approvalNote = null;
    for (const al of this.state.alerts) if (al.userId === u.id && al.kind === 'approval' && !al.ack) Object.assign(al, { ack: true, ackBy: a.id });
    this.addLog(decision === 'approved' ? 'approve' : 'decline', { userId: u.id, by: a.id, text: decision === 'approved' ? 'approved the account' : `declined the account${u.approvalNote ? ` (note: “${u.approvalNote}”)` : ''}` });
    this.publicRev++;
    this.cache.delete(u.id);
    this.totalsCache = null;
    this.touch();
  }
  approve(adminId, body) {
    this.decideApproval(adminId, isPlainObject(body) ? body.id : null, 'approved');
    return {};
  }
  decline(adminId, body) {
    this.decideApproval(adminId, isPlainObject(body) ? body.id : null, 'declined', isPlainObject(body) ? body.note ?? null : null);
    return {};
  }
  approveAll(adminId) {
    this.requireAdmin(adminId);
    let count = 0;
    for (const u of Object.values(this.state.users)) {
      if (u.isAdmin || u.approval !== 'pending') continue;
      this.decideApproval(adminId, u.id, 'approved');
      count++;
    }
    return { count };
  }

  validateRegistration(body, { ignoreCap = false } = {}) {
    if (!isPlainObject(body)) throw new HttpError(400, 'Bad request');
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    if (!USERNAME_RE.test(username)) throw new HttpError(400, 'Username: 2–24 characters, letters, digits, _ . or -');
    validatePassword(body.password);
    const name = cleanLine(body.name, 40);
    if (!name) throw new HttpError(400, 'Please enter your name');
    if (displayNameError(name)) throw new HttpError(400, displayNameError(name), { code: 'name_email', field: 'name' }); // SPEC §25
    const email = cleanEmail(typeof body.email === 'string' ? body.email : '') || null; // SPEC §25b: private; the form requires it
    if (email && emailProblem(email)) throw new HttpError(400, emailProblem(email), { code: 'email', field: 'email' });
    if (this.byUsername.has(username)) throw new HttpError(409, 'That username is taken');
    // The first account (the host) and WH_ADMIN_USERS can always register.
    const exempt = Object.keys(this.state.users).length === 0 || this.adminUsers.has(username);
    if (!exempt && this.state.party.registrationOpen === false) throw new HttpError(403, 'Registration is closed. Ask the host to open it.', { code: 'closed' });
    if (!exempt && !ignoreCap && Object.keys(this.state.users).length >= this.S.maxUsers) throw new HttpError(403, 'Registration is full', { code: 'full' });
    return { username, name, email };
  }

  register(clean, passHash, opts = {}) {
    const c = this.validateRegistration({ ...clean, password: 'xxxxxxxx' }, opts);
    const first = Object.keys(this.state.users).length === 0;
    const admin = first || this.adminUsers.has(c.username);
    const u = {
      id: `u${randomId(11)}`,
      username: c.username,
      name: c.name,
      email: c.email, // SPEC §25b: hosts only, never public
      passHash,
      isAdmin: admin,
      createdAt: this.now(),
      round: this.round, // signed up in this round: one of its writers (lib/rounds.js)
      // SPEC §15: new accounts wait for the host while approval is on (the host is approved).
      approval: admin || !this.S.approvalRequired ? 'approved' : 'pending',
      approvalMessage: null,
      approvalMessageAt: null,
      approvalNote: null,
      joinedAt: null,
      targetOverride: null,
      carryOverride: null, // their own carryforward limit (lib/progress.js carryCap), else the setting
      trustPastes: false, // a host trusts their pastes: never flagged as big pastes (lib/score.js)
      out: false,
      outAt: null,
      outReason: null,
      extraPasses: 0,
      freeHours: [],
      reviews: {},
      evaluatedThrough: -1,
      lastOpAt: null,
    };
    this.state.users[u.id] = u;
    this.byUsername.set(u.username, u);
    this.addLog('register', { userId: u.id, text: u.isAdmin ? 'registered (admin)' : u.approval === 'pending' ? 'registered, waiting for approval' : 'registered' });
    if (u.approval === 'pending') this.pushAlert({ kind: 'approval', t: this.now(), userId: u.id, message: null });
    this.touch();
    return u;
  }

  noteLogin(u) {
    if (!u.isAdmin && this.adminUsers.has(u.username)) {
      u.isAdmin = true;
      this.touch();
    }
  }

  createSession(userId, token) {
    this.requireUser(userId);
    const now = this.now();
    this.state.sessions[token] = { userId, createdAt: now, seen: now };
    const mine = Object.entries(this.state.sessions).filter(([, s]) => s.userId === userId);
    if (mine.length > MAX_SESSIONS_PER_USER) {
      mine.sort((a, b) => a[1].createdAt - b[1].createdAt);
      for (const [t] of mine.slice(0, mine.length - MAX_SESSIONS_PER_USER)) delete this.state.sessions[t];
    }
    this.touch();
  }
  sessionUserId(token) {
    if (!token || typeof token !== 'string' || !Object.hasOwn(this.state.sessions, token)) return null;
    const s = this.state.sessions[token];
    if (this.now() - s.createdAt > SESSION_TTL_MS || !this.userById(s.userId)) return null;
    return s.userId;
  }
  deleteSession(token) {
    if (token && Object.hasOwn(this.state.sessions, token)) {
      delete this.state.sessions[token];
      this.touch();
    }
  }
  // Every request with a valid session (server.js) is evidence the device was online.
  seen(token, now = this.now()) {
    if (token && typeof token === 'string' && Object.hasOwn(this.state.sessions, token)) notePresence(this.state.sessions[token], now, this.bootSavedAt);
  }
  // The presence record an ops batch is judged by (noting this request too).
  presence(token, u, now = this.now()) {
    let rec = token && typeof token === 'string' && Object.hasOwn(this.state.sessions, token) ? this.state.sessions[token] : null;
    if (!rec) {
      rec = this.pseudo.get(u.id);
      if (!rec) this.pseudo.set(u.id, (rec = { createdAt: u.createdAt ?? now, seen: u.joinedAt ?? u.createdAt ?? now }));
    }
    notePresence(rec, now, this.bootSavedAt);
    return rec;
  }
  setPasswordHash(userId, hash) {
    this.requireUser(userId).passHash = hash;
    // Sign out everywhere else.
    for (const [t, s] of Object.entries(this.state.sessions)) if (s.userId === userId) delete this.state.sessions[t];
    this.touch();
  }

  // ------------------------------------------------------------ party phases
  start(adminId) {
    const a = this.requireAdmin(adminId);
    if (this.phase !== 'lobby') throw new HttpError(409, 'The party has already started');
    this.begin({ by: a.id, text: 'started the party' });
  }
  begin({ by = null, text }) {
    this.state.party.phase = 'running';
    this.state.party.startedAt = this.now();
    this.state.party.plannedStart = null; // done (the log keeps it)
    this.publicRev++;
    this.addLog('start', { by, text });
    this.touch();
  }
  // A planned start (the host's "Start at"): the party starts by itself at that time, from tick().
  setPlannedStart(adminId, v) {
    const a = this.requireAdmin(adminId);
    if (this.phase !== 'lobby') throw new HttpError(409, 'The party has already started');
    const now = this.now();
    if (v === null || v === '') this.state.party.plannedStart = null;
    else if (Number.isFinite(v) && v > now && v < now + 7 * 24 * 3600_000) this.state.party.plannedStart = Math.round(v);
    else throw new HttpError(400, 'The start must be a time in the next 7 days, or empty');
    this.publicRev++;
    this.addLog('planned-start', { by: a.id, text: this.state.party.plannedStart ? `planned start set to ${this.fmtClock(this.state.party.plannedStart)}` : 'planned start cleared' });
    this.touch();
  }
  // Starts the party if its planned start has come (a server that was down then starts it late).
  startIfDue(now = this.now()) {
    const at = this.state.party.plannedStart;
    if (this.phase !== 'lobby' || !Number.isFinite(at) || now < at) return false;
    this.begin({ text: `The party started at its planned time, ${this.fmtClock(at)}` });
    return true;
  }
  end(adminId) {
    const a = this.requireAdmin(adminId);
    if (this.phase !== 'running') throw new HttpError(409, 'The party is not running');
    this.state.party.phase = 'ended';
    this.state.party.endedAt = this.now();
    this.publicRev++;
    this.state.party.archiveOrder = shuffle(Object.values(this.state.posts).map((p) => p.publicId));
    // "Words today" stops here: edits after the party (with a reason, SPEC §30) never move it.
    this.state.party.endWords = { pub: this.wordsTodayNow(false), all: this.wordsTodayNow(true) };
    // Alerts stay for the record, closed: nothing needs the host's attention after the end.
    for (const al of this.state.alerts) if (!al.ack) Object.assign(al, { ack: true, closedAt: this.state.party.endedAt, closedBy: 'end' });
    this.addLog('end', { by: a.id, text: 'ended the party' });
    this.touch();
  }
  // Is this stored op an edit after the party (never scored)? See lib/preview.js afterEndTest.
  isAfterEnd(o) {
    const r = this.state.party.resumed;
    if (!this.afterEndOp || this.afterEndFor !== r) {
      this.afterEndFor = r;
      this.afterEndOp = afterEndTest(this.state.party);
    }
    return this.afterEndOp(o);
  }
  // The host takes back the end of this round's party (the latest one: earlier rounds are closed).
  // The party runs again from now. The time it was over becomes a pause break, so no hour is
  // judged in it and each writer's hour picks up where it stopped; edits made meanwhile count
  // like writing during a break (party.resumed). The anthology closes until the next end, and
  // alerts the end closed open again.
  resume(adminId) {
    const a = this.requireAdmin(adminId);
    if (this.phase !== 'ended') throw new HttpError(409, 'The party hasn’t ended', { code: 'not-ended' });
    const st = this.state.party;
    const now = this.now();
    const endedAt = Number.isFinite(st.endedAt) ? st.endedAt : now;
    if (now > endedAt) this.state.breaks.push({ id: randomId(8), startAt: endedAt, endAt: now, label: 'Pause', mode: 'pause', resumed: true });
    st.resumed = [...(Array.isArray(st.resumed) ? st.resumed : []), { endedAt, at: now }];
    // Posts changed meanwhile are ordinary posts again: no session, no "after the party" notes.
    for (const p of Object.values(this.state.posts)) {
      if (p.after) Object.assign(p.after, { until: null, reason: null, noted: false, panes: {}, edited: false, added: false });
    }
    Object.assign(st, { phase: 'running', endedAt: null, archiveOrder: null });
    delete st.endWords;
    for (const al of this.state.alerts) {
      if (al.closedBy === 'end' && al.closedAt === endedAt) {
        al.ack = false;
        delete al.closedAt;
        delete al.closedBy;
      }
    }
    this.publicRev++;
    this.addLog('resume', { by: a.id, text: `resumed the party (it had ended at ${this.fmtClock(endedAt)}); the time in between counts as a pause` });
    // Score again now, with the edits made meanwhile: a background run in progress stops (it
    // started without them) and the engine is rebuilt at once, so every pane is in step.
    this.rescoreGen++;
    this.nextEngine = null;
    this.rescoring = false;
    this.rebuildEngine({ sync: true });
    this.cache.clear();
    this.totalsCache = null;
    this.needsReconcile = true;
    this.touch();
    return { resumedAt: now, pauseFrom: endedAt };
  }
  // The note on the static site's front page (lib/static-site.js), Markdown: saved for the next
  // download too. Empty clears it.
  setStaticNote(adminId, note) {
    const a = this.requireAdmin(adminId);
    if (note !== null && typeof note !== 'string') throw new HttpError(400, 'The note must be text');
    const v = sanitizeText(String(note ?? '').replace(/\r\n?/g, '\n')).trim();
    if ([...v].length > STATIC_NOTE_MAX) throw new HttpError(400, `The note can be at most ${STATIC_NOTE_MAX.toLocaleString('en-GB')} characters`);
    const was = this.state.party.staticNote || null;
    this.state.party.staticNote = v || null;
    if ((v || null) !== was) this.addLog('static-note', { by: a.id, text: v ? 'set the static site’s front-page note' : 'cleared the static site’s front-page note' });
    this.touch();
    return { note: this.state.party.staticNote || '' };
  }
  setPartyName(adminId, name) {
    this.requireAdmin(adminId);
    const n = cleanLine(name, 80);
    if (!n) throw new HttpError(400, 'Party name can’t be empty');
    this.state.party.name = n;
    this.publicRev++;
    this.touch();
  }
  // Validate a settings patch against the saved settings: { next, changed: ['k: a → b', ...] }.
  validateSettings(patch) {
    if (!isPlainObject(patch)) throw new HttpError(400, 'Bad request');
    const next = { ...this.state.settings.scoring };
    const changed = [];
    for (const [k, v] of Object.entries(patch)) {
      const rule = SETTING_RULES[k];
      if (!rule) throw new HttpError(400, `Unknown setting: ${k}`);
      let val = v;
      if (Array.isArray(rule[0])) {
        if (!rule[0].includes(v)) throw new HttpError(400, `${k} must be one of ${rule[0].join(', ')}`);
      } else if (rule[0] === 'bool') {
        if (typeof v !== 'boolean') throw new HttpError(400, `${k} must be true or false`);
      } else if (rule[0] === 'num?' && (v === null || v === '')) {
        val = null;
      } else {
        val = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
        if (typeof val !== 'number' || !Number.isFinite(val)) throw new HttpError(400, `${k} must be a number`);
        if (rule[0] === 'int' && !Number.isInteger(val)) throw new HttpError(400, `${k} must be a whole number`);
        if (val < rule[1] || val > rule[2]) throw new HttpError(400, `${k} must be between ${rule[1]} and ${rule[2]}`);
      }
      if (next[k] === val) continue;
      if (TEST_ONLY.has(k) && !this.testKnobs) throw new HttpError(400, `${k} is a test setting; the host can't change it`);
      const show = (x) => (x === null ? 'none' : x === true ? 'on' : x === false ? 'off' : x);
      changed.push(`${settingName(k)}: ${show(next[k])} → ${show(val)}`);
      next[k] = val;
    }
    return { next, changed };
  }
  setSettings(adminId, patch) {
    const a = this.requireAdmin(adminId);
    const { next, changed } = this.validateSettings(patch);
    this.state.settings.scoring = next;
    // Hours moved: judging carries on from now under the new plan, never back over past hours.
    if (changed.length && Object.keys(patch).some((k) => HOUR_KEYS.has(k) && patch[k] !== undefined)) this.resetJudging(this.now(), next);
    if (changed.length) {
      this.addLog('settings', { by: a.id, text: changed.join(', ') });
      // Carryforward moves words between hours: judged hours are brought in line, like after a re-score.
      if (next.carryOverMax !== this.active.carryOverMax) {
        this.needsReconcile = true;
        this.totalsCache = null;
      }
      for (const k of APP_KEYS) this.active[k] = next[k];
      if (Object.keys(next).some((k) => !APP_KEY_SET.has(k) && next[k] !== this.active[k])) this.requestRescore();
    }
    this.touch();
    return next;
  }

  // ------------------------------------------------------------ writers
  join(userId) {
    const u = this.requireApproved(userId); // no clock before approval
    if (this.phase === 'running' && !u.joinedAt) {
      u.joinedAt = this.now();
      if (!this.applyPlan(u)) this.rebuildEngine();
      const plan = this.planOf(u);
      const end1 = hourSpan(0, plan, this.state.breaks, this.S.hourLengthMin * 60_000).endAt;
      this.addLog('join', { userId: u.id, text: plan.extended || Number.isFinite(plan.firstTarget) ? `opened the editor; first hour until ${this.fmtClock(end1)}${Number.isFinite(plan.firstTarget) ? `, target ${plan.firstTarget}` : ''}` : 'opened the editor; their hours start now' });
      this.touch();
    }
    return u.joinedAt;
  }

  postsOf(userId) {
    return Object.values(this.state.posts).filter((p) => p.ownerId === userId).sort((a, b) => a.order - b.order);
  }
  requirePost(userId, postId) {
    const p = typeof postId === 'string' && Object.hasOwn(this.state.posts, postId) ? this.state.posts[postId] : null;
    if (!p || p.ownerId !== userId) throw new HttpError(404, 'No such post');
    return p;
  }
  // A new post: while the party runs, or after it (SPEC §30: feedback, say). One started after the
  // end is private until its writer chooses to publish it (a privacy change, with a reason), and
  // nothing in it ever counts; its pages say "Added after the party".
  newPost(userId, body = {}) {
    const u = this.requireApproved(userId);
    if (this.phase === 'lobby') throw new HttpError(409, 'The party hasn’t started yet', { code: 'not-started' });
    const added = this.phase === 'ended';
    const mine = this.postsOf(userId);
    if (mine.length >= MAX_POSTS) throw new HttpError(409, `You can have up to ${MAX_POSTS} posts`);
    const title = cleanLine(body.title, 200) || '';
    let publicId = randomId(10);
    while (this.pastByPublicId.has(publicId)) publicId = randomId(10); // /p/<id> finds posts of every round
    const p = {
      id: `p${randomId(11)}`,
      ownerId: u.id,
      publicId,
      title,
      privacy: added ? 'private' : 'live',
      unlisted: false,
      closed: false,
      createdAt: this.now(),
      order: mine.length ? Math.max(...mine.map((x) => x.order)) + 1 : 0,
      body: '',
      notes: '',
      words: 0, // words in the body now
      ver: { body: 0, notes: 0 },
      seq: { body: null, notes: null },
      activeAt: null,
    };
    this.state.posts[p.id] = p;
    if (added) {
      const a = this.afterLog(p);
      a.added = true;
      a.log.push({ at: p.createdAt, kind: 'added' });
      this.addLog('after-new', { userId: u.id, text: 'started a new post after the party (private)' });
    }
    this.touch();
    return p;
  }

  updatePost(userId, body) {
    this.requireApproved(userId);
    if (!isPlainObject(body)) throw new HttpError(400, 'Bad request');
    const p = this.requirePost(userId, body.id);
    // After the end (SPEC §30): a new title is an edit after the party like any other (no
    // reason), a privacy change needs a reason of its own; nothing else changes. Recorded for the
    // hosts once applied.
    const after = this.phase === 'ended' ? this.checkAfterEnd(p, body) : null;
    if (body.title !== undefined) {
      const t = cleanLine(body.title, 200);
      if (t === null) throw new HttpError(400, 'Bad title');
      p.title = t;
    }
    if (body.privacy !== undefined) {
      if (!PRIVACY.has(body.privacy)) throw new HttpError(400, 'Bad privacy setting');
      const wasSeparate = p.privacy === 'separate';
      const isSeparate = body.privacy === 'separate';
      // A fresh public id whenever the post moves between identities (streamed vs
      // separate, or signed vs unsigned), so the versions can't be linked by id. Live and
      // private (SPEC §26) share one: both unsigned, and a private post's id is never public.
      if (wasSeparate !== isSeparate || (p.privacy === 'named') !== (body.privacy === 'named')) p.publicId = randomId(10);
      p.privacy = body.privacy;
    }
    if (body.closed !== undefined) {
      if (typeof body.closed !== 'boolean') throw new HttpError(400, 'Bad request');
      p.closed = body.closed;
    }
    if (after) this.noteAfterEnd(p, after);
    this.publicRev++;
    this.touch();
    return p;
  }

  // ------------------------------------------------------------ after the party (SPEC §30)
  // After the end, posts stay freely editable, with no reason asked for anything: the first change
  // (text or title) opens the post's edit session, quietly, and it lasts while changes keep coming,
  // closing after 30 idle minutes; the next change opens a new, quiet one. One op that takes 50 or
  // more words out of the post (BIG_CUT_WORDS) goes in at once and leaves a line in the post's
  // history for the hosts. A reason is optional: pages from before reasons became optional may
  // still send one (POST /api/post/after-party, or with a privacy change), and hosts see it.
  // Edits after the end never count: their ops are journaled (x.e) and replayed into the text,
  // never into the scorer, so no hour gains or loses a word.
  // A post started after the end (`added`) is all after-party text: it needs no reason for a
  // large cut, and its history has the start, not each session.
  // post.after = { log: [{ at, kind: 'added' | 'edit' | 'cut' | 'privacy', reason (null: a quiet
  //   session), words? (cut: the words it took out), from?, to? (privacy) }], until (the open
  //   session's end), reason (the open session's, or null), noted (its line is in the log),
  //   panes: { body?, notes? } (edited after the end), edited (the public text or title changed:
  //   "Edited after the party"), added (started after the end: "Added after the party") }.
  afterLog(p) {
    return (p.after ||= { log: [], until: null, panes: {}, edited: false });
  }
  editOpen(p, now = this.now()) {
    return this.phase === 'ended' && Number.isFinite(p.after?.until) && now < p.after.until;
  }
  // The post's session as its writer's views show it (SPEC §30).
  afterSession(p, now = this.now()) {
    const editing = this.editOpen(p, now);
    return { editing, reasoned: editing && !!p.after.reason };
  }
  cleanReason(reason) {
    const r = typeof reason === 'string' ? cleanLine(reason, 200) : null;
    if (!r || [...r].length < 3) throw new HttpError(400, 'Say in a few words why (3 to 200 characters). The hosts see it.', { code: 'reason', field: 'reason' });
    return r;
  }
  // POST /api/post/after-party { id, reason }: the post's session carries this reason from now
  // on (opened now if none is open), so a change that removes 50+ words can go in. It's written in
  // the post's history with the changes it covers. { id, done: true } ends the session (the
  // "Done" of pages loaded before sessions became quiet).
  openAfterEdit(userId, body) {
    this.requireApproved(userId);
    if (!isPlainObject(body)) throw new HttpError(400, 'Bad request');
    const p = this.requirePost(userId, body.id);
    if (this.phase !== 'ended') throw new HttpError(409, 'Until the party ends, edits need no reason', { code: 'running' });
    const a = this.afterLog(p);
    const now = this.now();
    if (body.done === true) {
      a.until = null;
    } else {
      const reason = this.cleanReason(body.reason);
      if (!this.editOpen(p, now)) a.noted = false; // a new session
      a.reason = reason;
      a.until = now + AFTER_EDIT_IDLE_MS;
    }
    this.touch();
    return this.afterSession(p, now);
  }
  // An update after the end: what may change, checked before anything does. (Closing or reopening
  // a post's tab is no change to the post: allowed, and never an edit after the party.)
  checkAfterEnd(p, body) {
    const now = this.now();
    const title = body.title !== undefined && cleanLine(body.title, 200) !== p.title;
    if (body.privacy === undefined || body.privacy === p.privacy) return { now, title, privacy: null };
    if (!PRIVACY.has(body.privacy)) throw new HttpError(400, 'Bad privacy setting');
    const reason = typeof body.reason === 'string' ? cleanLine(body.reason, 200) : ''; // optional (older pages ask for one)
    return { now, title, privacy: { from: p.privacy, to: body.privacy, reason: reason || null } };
  }
  noteAfterEnd(p, { now, title, privacy }) {
    if (title) this.afterChange(p, now, { changed: true });
    if (privacy) {
      const a = this.afterLog(p);
      a.log.push({ at: now, reason: privacy.reason, kind: 'privacy', from: privacy.from, to: privacy.to });
      const name = { live: 'public, no name', named: 'public, signed', separate: 'separate identity', private: 'private' };
      this.addLog('after-privacy', { userId: p.ownerId, text: `changed “${p.title || 'Untitled'}” after the party from ${name[privacy.from]} to ${name[privacy.to]}${privacy.reason ? `: “${privacy.reason}”` : ''}` });
    }
  }
  // A change after the end went in (a batch of ops on `pane`, or a new title): the post's session
  // goes on, or opens now, quiet. Each session leaves one line in the post's history and the host
  // log, with its reason if it has one, unless its first change removes 50+ words: each such op
  // (`cuts`: the words each took out) leaves a line of its own (with the session's reason, if any).
  // `changed`: the public text or the title changed, so the post's page says "Edited after the
  // party".
  afterChange(p, now, { pane = null, changed = false, cuts = [] } = {}) {
    const a = this.afterLog(p);
    if (!this.editOpen(p, now)) Object.assign(a, { reason: null, noted: false }); // a new session: quiet
    a.until = now + AFTER_EDIT_IDLE_MS;
    if (pane) a.panes[pane] = 1;
    const title = p.title || 'Untitled';
    for (const words of cuts) {
      a.log.push({ at: now, kind: 'cut', reason: a.reason, words });
      this.addLog('after-cut', { userId: p.ownerId, text: `removed about ${words} words from “${title}” after the party${a.reason ? `: “${a.reason}”` : ''}` });
    }
    if (!a.noted && !cuts.length && !a.added) {
      a.log.push({ at: now, kind: 'edit', reason: a.reason || null });
      this.addLog('after-edit', { userId: p.ownerId, text: `edited “${title}” after the party${a.reason ? `: “${a.reason}”` : ''}` });
    }
    a.noted = true;
    if (changed && !a.edited) {
      a.edited = true;
      this.publicRev++; // "Edited after the party" shows at once
    }
  }
  // A pane's text at boot: the scorer's copy (it stops at the end) plus the edits after the party.
  withAfterEnd(p, code, text) {
    if (!this.bootAfterOps) {
      this.bootAfterOps = new Map(); // `${postId}|${code}` -> ops in log order
      for (const ops of Object.values(this.state.ops)) {
        for (const o of ops) {
          if (!this.isAfterEnd(o)) continue;
          const k = `${o[1]}|${o[2]}`;
          if (!this.bootAfterOps.has(k)) this.bootAfterOps.set(k, []);
          this.bootAfterOps.get(k).push(o);
        }
      }
    }
    const list = this.bootAfterOps.get(`${p.id}|${code}`);
    if (!list) return text;
    let t = text;
    for (const o of list) t = t.slice(0, o[3]) + o[5] + t.slice(o[3] + o[4]);
    const a = this.afterLog(p); // (the state file can lag behind the journal)
    a.panes[code === 'n' ? 'notes' : 'body'] = 1;
    if (code === 'b' && t !== text) a.edited = true;
    return t;
  }

  // Apply a batch of editor operations to one pane of one post.
  // body: { postId, pane: 'body'|'notes', baseVersion, seq, sentAt,
  //         ops: [{ at, pos, del, ins, source?, paste?: { m, d } }] }
  // opts.token: the session the batch came with (its request history decides back-dating).
  applyOps(userId, body, { token = null } = {}) {
    const u = this.requireApproved(userId);
    if (!isPlainObject(body)) throw new HttpError(400, 'Bad request');
    const p = this.requirePost(userId, body.postId);
    const pane = body.pane;
    if (!Object.hasOwn(PANES, pane)) throw new HttpError(400, 'Bad pane');
    const seq = typeof body.seq === 'string' ? body.seq.slice(0, 64) : null;
    this.pendingDurable = null;
    const applied = seq ? this.seqs.get(`${p.id}|${pane}`)?.get(seq) : undefined;
    if (seq && (p.seq[pane] === seq || applied !== undefined)) {
      // A lost response retried: never applied twice. Answered once the pane's journal lines
      // have landed (server.js waits for pendingDurable, on the 409 below too).
      this.pendingDurable = this.lastWrite.get(`${p.id}|${pane}`) || null;
      if (p.seq[pane] === seq || applied === p.ver[pane]) {
        // The pane's last batch. If it was cleaned (or we can't tell), resend the text.
        const last = this.ring.get(`${p.id}|${pane}`)?.batches.at(-1);
        const clean = last && last.seq === seq && !last.sanitized;
        return clean ? { version: p.ver[pane], duplicate: true } : { version: p.ver[pane], duplicate: true, sanitized: true, text: p[pane] };
      }
      // Applied earlier, and another tab or device wrote since: merge data from that version.
      throw this.conflict(p, pane, applied, { duplicate: true, appliedVersion: applied });
    }
    if (!Number.isInteger(body.baseVersion)) throw new HttpError(400, 'baseVersion required');
    const ops = body.ops;
    if (!Array.isArray(ops) || ops.length === 0 || ops.length > MAX_OPS_PER_BATCH) throw new HttpError(400, 'Bad ops');
    if (this.phase === 'lobby') throw new HttpError(409, 'The party hasn’t started yet', { code: 'not-started' });
    if (body.baseVersion !== p.ver[pane]) throw this.conflict(p, pane, body.baseVersion);
    // The client's copy of this version has a different length (it missed a canonical text,
    // e.g. after characters were removed): positions would land in the wrong place.
    if (Number.isInteger(body.baseLen) && body.baseLen !== p[pane].length) throw this.conflict(p, pane, p.ver[pane], { lengthMismatch: true });
    // Validate against a scratch copy first: all or nothing.
    const now = this.now();
    const pres = this.presence(token, u, now);
    const ended = this.phase === 'ended';
    const lateAfter = lateAfterMs(this.S);
    const sentAt = Number.isFinite(body.sentAt) ? body.sentAt : null;
    const userOps = this.state.ops[u.id] || [];
    const lastT = userOps.length ? userOps[userOps.length - 1][0] : -Infinity;
    let floor = Math.max(lastT, now - MAX_BACKDATE_MS, u.joinedAt || -Infinity);
    let text = p[pane];
    // Invisible and control characters are dropped from inserts (lib/sanitize.js). The client's
    // later ops in this batch still count them, so their positions are mapped onto our text.
    const phantoms = new PhantomMap();
    let sanitized = false;
    let wordsDelta = 0;
    const prepared = [];
    for (const o of ops) {
      if (!isPlainObject(o)) throw new HttpError(400, 'Bad op');
      const rawPos = o.pos;
      const rawDel = o.del ?? 0;
      const rawIns = o.ins ?? '';
      if (!Number.isInteger(rawPos) || !Number.isInteger(rawDel) || typeof rawIns !== 'string') throw new HttpError(400, 'Bad op');
      if (rawPos < 0 || rawDel < 0 || rawPos + rawDel > text.length + phantoms.size) throw new HttpError(400, 'Op out of range', { code: 'range' });
      if (rawIns.length > MAX_INS) throw new HttpError(413, 'Insert too large');
      const { text: ins, removed } = sanitizeWithMap(rawIns);
      let pos = rawPos;
      let del = rawDel;
      if (phantoms.size) {
        pos = phantoms.toCanonical(rawPos);
        del = phantoms.toCanonical(rawPos + rawDel) - pos;
      }
      if (removed || phantoms.size) phantoms.apply(rawPos, rawDel, rawIns.length, removed);
      if (removed) sanitized = true;
      if (!del && !ins) continue;
      const deleted = del ? text.slice(pos, pos + del) : '';
      // Server time for the op: the client's relative timing within the batch, kept only
      // across a gap in this session's requests (an offline spell), and clamped.
      let t = now;
      if (sentAt !== null && Number.isFinite(o.at)) t = allowedTime(pres, now - Math.min(Math.max(0, sentAt - o.at), MAX_BACKDATE_MS), now);
      t = Math.min(now, Math.max(floor, t));
      floor = t;
      // Extra facts about the op: the editor's input source, and for pastes the
      // writer's answer to "did you write this today?" (one flag per word).
      let x = null;
      if (o.paste !== undefined && o.paste !== null) {
        if (!isPlainObject(o.paste) || !rawIns) throw new HttpError(400, 'Bad paste');
        const n = rawWords(rawIns).length;
        let m = typeof o.paste.m === 'string' && o.paste.m.length === n && /^[01]*$/.test(o.paste.m) ? o.paste.m : '0'.repeat(n);
        m = remapMask(rawIns, removed, m, rawWords);
        const d = ['no', 'yes', 'short', 'auto', 'file', 'move'].includes(o.paste.d) ? o.paste.d : 'invalid';
        x = { s: 'paste', m, d };
      } else if (typeof o.source === 'string' && o.source !== 'type' && o.source !== 'paste' && SOURCES.includes(o.source)) {
        x = { s: o.source };
      }
      // Received well after it was typed: remember when, so late work can't heal a closed hour.
      if (now - t > lateAfter) x = { ...(x || {}), r: now };
      if (pane === 'body') wordsDelta += wordDelta(text, pos, del, ins);
      // After the end: the words this op takes out of the pane (SPEC §30, a reason from 50).
      const cut = ended && del ? wordsRemoved(text, pos, del) : 0;
      text = text.slice(0, pos) + ins + text.slice(pos + del);
      if (text.length > MAX_PANE_CHARS) throw new HttpError(413, 'This post is too long (500,000 characters max)');
      prepared.push({ t, pos, del, ins, x, deleted, cut });
    }
    // After the end (SPEC §30). Late work typed before it goes in as usual and is scored, unless
    // the pane has been edited since the end (its scorer copy stops there) or a session is open.
    // Anything else is an edit after the party: the post's session goes on or opens (quiet), its
    // ops are stamped now (outside every hour) and never scored; an op that takes 50+ words out
    // goes in like any other and is noted in the post's history for the hosts.
    let afterEdit = false;
    let cuts = [];
    if (ended) {
      const open = this.editOpen(p, now);
      // (A post started after the end takes no late work: nothing in it was typed before.)
      afterEdit = open || !!p.after?.panes?.[pane] || !!p.after?.added || prepared.some((o) => o.t > this.state.party.endedAt);
      if (afterEdit) {
        if (!p.after?.added) cuts = cutsOf(prepared).filter((n) => n >= BIG_CUT_WORDS); // noted for the hosts, never refused
        for (const o of prepared) Object.assign(o, { t: now, x: { e: 1 } });
      }
    }
    // The scorer's copy of the pane must be this text, or the ops land elsewhere there and the
    // journal gets lines that no later boot can replay: refuse instead (never expected).
    if (!afterEdit && this.engine.text(u.id, p.id, PANES[pane]).length !== p[pane].length) {
      this.logger.error(`[party] post ${p.id} ${pane}: the scorer's text is out of step with the post; batch refused`);
      throw new HttpError(500, 'This post can’t be saved right now. Your words are kept on this device; please tell the host.', { code: 'out-of-step' });
    }
    if (!u.joinedAt) this.join(u.id);
    // Journal first (throws if the disk refuses), then commit in memory.
    const code0 = PANES[pane];
    this.pendingDurable = null;
    if (this.onBatch) {
      // Every batch, even one that changed nothing, so the journal holds every version and id.
      const rec = [p.id, code0, p.ver[pane] + 1, prepared.map((o) => (o.x ? [o.t, o.pos, o.del, o.ins, o.x] : [o.t, o.pos, o.del, o.ins]))];
      if (seq) rec.push(seq);
      // Queued here (it throws for a bad id); written and flushed in the background:
      // server.js waits for pendingDurable (its `written`, then a bounded flush) before the ack.
      const d = this.onBatch(u.id, rec) || null;
      this.pendingDurable = d;
      const key = `${p.id}|${pane}`;
      if (d && d.written) {
        this.lastWrite.set(key, d);
        d.written.then(() => { if (this.lastWrite.get(key) === d) this.lastWrite.delete(key); });
      }
    }
    if (!this.state.ops[u.id]) this.state.ops[u.id] = [];
    const code = PANES[pane];
    for (const o of prepared) {
      const stored = [o.t, p.id, code, o.pos, o.del, o.ins];
      if (o.x) stored.push(o.x);
      this.state.ops[u.id].push(stored);
      if (!afterEdit) this.engine.apply(u.id, { t: o.t, post: p.id, pane: code, pos: o.pos, del: o.del, ins: o.ins, x: o.x || undefined });
    }
    if (pane === 'body') p.words = (Number.isFinite(p.words) ? p.words : countWords(p[pane])) + wordsDelta;
    // A post appearing on (or leaving) the public page is a public change: caches refresh at once.
    if (pane === 'body' && !p[pane].trim() !== !text.trim()) this.publicRev++;
    if (afterEdit && prepared.length) this.afterChange(p, now, { pane, changed: pane === 'body' && text !== p[pane], cuts });
    p[pane] = text;
    p.ver[pane] += 1;
    p.seq[pane] = seq;
    if (seq) this.seqMap(`${p.id}|${pane}`).set(seq, p.ver[pane]);
    this.ringPush(p, pane, { v: p.ver[pane], seq, sanitized, ops: prepared.map((o) => [o.pos, o.del, o.ins, o.deleted]) });
    if (prepared.length) {
      const lt = prepared[prepared.length - 1].t;
      u.lastOpAt = lt;
      if (pane === 'body') p.activeAt = lt;
    }
    this.touch();
    // The client's copy differs from ours where characters were dropped: send the canonical text.
    return sanitized ? { version: p.ver[pane], sanitized: true, text: p[pane] } : { version: p.ver[pane] };
  }

  ringPush(p, pane, batch) {
    const key = `${p.id}|${pane}`;
    let R = this.ring.get(key);
    if (!R) this.ring.set(key, (R = { batches: [], chars: 0 }));
    const size = (b) => b.ops.reduce((n, o) => n + o[2].length + o[3].length, 0) + 16;
    R.batches.push(batch);
    R.chars += size(batch);
    while (R.batches.length > RING_BATCHES || (R.chars > RING_CHARS && R.batches.length > 1)) R.chars -= size(R.batches.shift());
  }
  // A pane's batch ids (seq -> the version each produced).
  seqMap(key) {
    let m = this.seqs.get(key);
    if (!m) this.seqs.set(key, (m = new Map()));
    return m;
  }
  // A 409 with what a client needs to merge: the current text, and when the batches since
  // `fromVersion` are still in memory, the text at that version plus those batches.
  conflict(p, pane, fromVersion, extra = {}) {
    const cur = p.ver[pane];
    let base = null;
    let since = null;
    const R = this.ring.get(`${p.id}|${pane}`);
    if (Number.isInteger(fromVersion) && fromVersion <= cur && fromVersion >= 0) {
      const later = R ? R.batches.filter((b) => b.v > fromVersion) : [];
      const covered = fromVersion === cur || (later.length === cur - fromVersion && later[0].v === fromVersion + 1);
      if (covered) {
        let t = p[pane];
        for (let i = later.length - 1; i >= 0; i--) {
          const ops = later[i].ops;
          for (let j = ops.length - 1; j >= 0; j--) {
            const [pos, , ins, deleted] = ops[j];
            t = t.slice(0, pos) + deleted + t.slice(pos + ins.length);
          }
        }
        base = { version: fromVersion, text: t };
        since = later.map((b) => ({ version: b.v, ops: b.ops.map(([pos, del, ins]) => [pos, del, ins]) }));
      }
    }
    return new HttpError(409, 'Version conflict', { code: 'conflict', version: cur, text: p[pane], base, since, ...extra });
  }

  opFromStored(o) {
    return { t: o[0], post: o[1], pane: o[2], pos: o[3], del: o[4], ins: o[5], x: o[6] || undefined };
  }

  // ------------------------------------------------------------ scoring
  // A writer's scoring result now (words settle with time, so it depends on the clock).
  scoreOf(userId, { fresh = false } = {}) {
    const u = this.userById(userId);
    if (!u) return null;
    const now = this.now();
    // At most one computation per writer per second (with recomputeMinMs > 0): the live page,
    // the writer's stream and the host view share it. Words take settleSec seconds to settle anyway.
    const slot = this.recomputeMinMs > 0 ? Math.floor(now / this.recomputeMinMs) : now;
    const key = this.recomputeMinMs > 0 ? `${this.engineRev}|${slot}` : `${this.engineRev}|${this.engine.size(userId)}|${slot}`;
    const c = this.cache.get(userId);
    if (c && c.key === key && !fresh) return c.result;
    const result = this.engine.result(userId, now);
    this.cache.set(userId, { key, result });
    return result;
  }
  // Writers on the clock: started, and approved (pending or declined accounts never count).
  writers() {
    return Object.values(this.state.users).filter((u) => u.joinedAt && this.isApproved(u));
  }
  // Personal-target factor per writer (1 unless personal targets are on).
  factors(now = this.now()) {
    const out = new Map();
    if (!this.S.personalTargets) return out;
    const hourMs = this.S.hourLengthMin * 60_000;
    const nb = pauseBreaks(this.state.breaks);
    const shares = new Map();
    for (const u of this.writers()) {
      const closed = hourIndex(now, this.anchorOf(u), nb, hourMs) >= 1;
      shares.set(u.id, editShare(this.scoreOf(u.id), closed));
    }
    const med = median([...shares.values()].filter((x) => x !== null));
    for (const [id, s] of shares) out.set(id, personalFactor(s, med));
    return out;
  }
  progressOf(userId, { now = this.now(), factors = null, fresh = false } = {}) {
    const u = this.userById(userId);
    if (!u || !u.joinedAt) return null;
    const result = this.scoreOf(userId, { fresh });
    const f = (factors || this.factors(now)).get(userId) ?? 1;
    const prog = writerProgress({ result, user: u, S: this.S, breaks: this.state.breaks, now, party: this.state.party, factor: f, plan: this.planOf(u) });
    return { prog, result, factor: f };
  }

  // Judge hours whose words have all settled: missed -> out (or alert only),
  // review -> host alert and review queue (never out on its own).
  tick() {
    if (this.phase === 'lobby' && !this.startIfDue()) return;
    const now = this.now();
    this.engine.advance(now);
    // While a re-score runs, the numbers are about to change: judge once the new ones are in.
    if (this.rescoring) return;
    if (this.needsReconcile) {
      this.needsReconcile = false;
      this.reconcileJudged(now);
    }
    let factors = null;
    const settleMs = ((this.S.settleSec || 0) + (this.S.settleQuantumSec || 0)) * 1000;
    for (const u of this.writers()) {
      if (!factors) factors = this.factors(now);
      const { prog } = this.progressOf(u.id, { now, factors, fresh: true }); // judge with every op in
      let changed = false;
      for (const h of prog.hours) {
        if (h.k <= u.evaluatedThrough) continue;
        // An hour while they had left the party (SPEC §33): passed over once it's over, unjudged.
        if (h.status === 'left') {
          if (now < h.endAt + settleMs) break;
          u.evaluatedThrough = h.k;
          changed = true;
          continue;
        }
        if (!['met', 'missed', 'free', 'review'].includes(h.status)) break;
        u.evaluatedThrough = h.k;
        // Its target is frozen from now on (later setting or override changes don't flip it).
        (u.judged ||= {})[h.k] = { target: h.target, status: h.status };
        changed = true;
        if (h.status === 'missed') this.onMissed(u, h, now);
        else if (h.status === 'review') this.onReview(u, h, now);
      }
      if (changed) this.touch();
    }
    this.healLateWork(now, factors);
  }

  // After a re-score: judged hours keep their (frozen) targets, but other settings can still
  // change their credit. Bring the out/alert state in line with what they are now: a newly
  // missed hour alerts (and puts the writer out, if that's the rule), a newly reviewable hour
  // alerts; a missed hour now met is resolved by healLateWork (alerts closed, back in).
  reconcileJudged(now = this.now()) {
    for (const u of this.writers()) {
      if (!u.judged) continue;
      const { prog } = this.progressOf(u.id, { now, fresh: true });
      let changed = false;
      for (const h of prog.hours) {
        const j = u.judged[h.k];
        if (j && j.pending && h.k <= u.evaluatedThrough) {
          u.judged[h.k] = { target: h.target, status: h.status }; // judged by a change of hours: recorded, no alert
          changed = true;
          continue;
        }
        if (!j || h.k > u.evaluatedThrough || j.status === h.status || !['met', 'missed', 'free', 'review'].includes(h.status)) continue;
        this.addLog('rescored', { userId: u.id, text: `hour ${h.k + 1}: ${j.status} → ${h.status} after a re-score` });
        j.status = h.status;
        changed = true;
        if (h.status === 'missed') this.onMissed(u, h, now);
        else if (h.status === 'review') this.onReview(u, h, now);
      }
      if (changed) this.touch();
    }
  }

  pushAlert(a) {
    const al = { id: randomId(8), ack: false, ...a };
    // After the end nothing needs the host's attention any more: record it, already closed.
    if (this.phase === 'ended') Object.assign(al, { ack: true, closedAt: this.now(), closedBy: 'end' });
    this.state.alerts.push(al);
    return al;
  }
  // Numbers an alert carries about an hour: what was written, what counts, what the host didn't count.
  hourNumbers(h) {
    const types = [...new Set((h.flags || []).map((f) => f.type))];
    const written = Math.round(h.credit || 0);
    const carried = Math.round(h.carriedIn || 0); // extra words from the hour before (lib/progress.js), part of `counted`
    const counted = Math.round(h.credited ?? h.credit ?? 0);
    return {
      credited: h.status === 'review' ? written + carried : counted, target: h.target, flagged: Math.round(h.flagged || 0), flags: types,
      typedWords: written, countedWords: counted, notCountedWords: h.decision === 'reject' ? Math.max(0, written + carried - counted) : 0,
      ...(carried ? { carriedWords: carried } : {}),
    };
  }
  // A per-writer carryforward limit from a request: null (the default) or whole words.
  static carryValue(v) {
    if (v === null || v === '') return null;
    const n = Number(v);
    if (Number.isInteger(n) && n >= 0 && n <= 100000) return n;
    throw new HttpError(400, 'A carryover limit is a whole number of words');
  }
  // "108 of 400", or after a "Don't count": "32 of 400 counted; 412 written, 380 not counted after review (big paste)".
  static countText(n) {
    const labels = (n.flags || []).filter((t) => t !== 'speedCap' && t !== 'sustainedSpeed').map((t) => flagLabel(t).toLowerCase()).join(', ');
    const carried = n.carriedWords ? `, ${n.carriedWords} carried over` : '';
    if (n.notCountedWords) return `${n.countedWords} of ${n.target} counted${carried}; ${n.typedWords} written, ${n.notCountedWords} not counted after review${labels ? ` (${labels})` : ''}`;
    return `${n.countedWords} of ${n.target}${carried}`;
  }
  static missedText(k, n) {
    return n.notCountedWords ? `missed hour ${k + 1}: ${Party.countText(n)}` : `missed hour ${k + 1} (${Party.countText(n)})`;
  }
  onMissed(u, h, now, { by = null } = {}) {
    const n = this.hourNumbers(h);
    this.addLog('missed', { userId: u.id, by, text: Party.missedText(h.k, n) });
    if (u.out) return null;
    const out = this.S.missedHourOutcome === 'out' && this.phase !== 'ended';
    const al = this.pushAlert({ kind: 'missed', t: now, userId: u.id, k: h.k, ...n, madeOut: out });
    if (out) {
      u.out = true;
      u.outAt = now;
      u.outAuto = h.k;
      u.outVia = h.decision === 'reject' ? 'reject' : 'miss';
      u.outReason = `missed hour ${h.k + 1}`;
      this.addLog('out', { userId: u.id, by, text: `is out (missed hour ${h.k + 1})` });
    }
    return al;
  }
  static reviewText(n) {
    const labels = (n.flags || []).filter((t) => t !== 'speedCap' && t !== 'sustainedSpeed').map((t) => flagLabel(t).toLowerCase()).join(', ');
    return `${n.typedWords} written${n.carriedWords ? ` and ${n.carriedWords} carried over` : ''}, ${n.flagged} of them flagged${labels ? ` (${labels})` : ''}; the hour is met only if they count (target ${n.target})`;
  }
  onReview(u, h, now) {
    const n = this.hourNumbers(h);
    const since = Party.flaggedSince(h);
    this.addLog('review', { userId: u.id, text: `hour ${h.k + 1} needs review: ${Party.reviewText(n)}${since ? `; ${since} more words flagged since your decision` : ''}` });
    return this.pushAlert({ kind: 'review', t: now, userId: u.id, k: h.k, ...n, ...(since ? { flaggedSince: since } : {}) });
  }
  // Words flagged after an early decision that no longer applies because of them (else 0).
  static flaggedSince(h) {
    return h && h.staleDecision && Number.isFinite(h.seen) ? Math.max(0, Math.round(h.flagged || 0) - h.seen) : 0;
  }

  // Work queued offline can reach the server after its hour was judged. It can't meet a closed
  // hour by itself (late work goes to review, see lib/score.js), so a missed hour that now needs
  // late words becomes a review for the host. A missed hour that is met after all (a re-score,
  // a host decision) resolves its alert and may bring the writer back in.
  healLateWork(now, factors = null) {
    for (const u of this.writers()) {
      const alerts = this.state.alerts.filter((a) => !a.ack && a.userId === u.id);
      const autoOut = u.out && Number.isInteger(u.outAuto);
      if (!alerts.length && !autoOut) continue;
      if (!factors) factors = this.factors(now);
      const { prog } = this.progressOf(u.id, { now, factors });
      let changed = false;
      for (const a of alerts) {
        const h = prog.hours.find((x) => x.k === a.k);
        const st = h?.status;
        if (st === 'met' || st === 'free') {
          a.ack = true;
          a.autoResolved = true;
          this.addLog('alert-resolved', { userId: u.id, text: `hour ${a.k + 1} is ${st === 'free' ? 'a free hour' : 'met'} after all` });
          changed = true;
        } else if (a.kind !== 'review' && st === 'review') {
          const n = this.hourNumbers(h);
          Object.assign(a, { kind: 'review', ...n, wasMissed: true });
          this.addLog('review', { userId: u.id, text: `hour ${a.k + 1} now needs review: ${Party.reviewText(n)}` });
          changed = true;
        }
      }
      if (this.reconsiderOut(u, prog, now)) changed = true;
      if (changed) this.touch();
    }
  }

  // A judged hour the host made free afterwards: its record says free (target kept), its alerts
  // close, and if it was the hour that put the writer out, they're back in (see reconsiderOut).
  freedAfterEnd(u, k, now, by) {
    if (u.judged && u.judged[k]) u.judged[k].status = 'free';
    for (const al of this.state.alerts) {
      if (al.userId === u.id && al.k === k && !al.ack) Object.assign(al, { ack: true, autoResolved: true });
    }
    const { prog } = this.progressOf(u.id, { now, fresh: true });
    this.reconsiderOut(u, prog, now, by);
    this.touch();
  }

  // The hour that put a writer out automatically isn't missed any more (met after a re-score,
  // accepted by the host, or made free): back in, unless a later judged hour was missed too.
  // An hour in review (late offline work, say) keeps them out until the host decides.
  reconsiderOut(u, prog, now, by = null) {
    if (!u.out || !Number.isInteger(u.outAuto)) return false;
    const k = u.outAuto;
    const st = prog.hours.find((x) => x.k === k)?.status;
    if (st !== 'met' && st !== 'free') return false;
    const later = prog.hours.find((x) => x.k > k && x.k <= u.evaluatedThrough && x.status === 'missed');
    if (later) {
      u.outAuto = later.k;
      u.outReason = `missed hour ${later.k + 1}`;
      if (!this.state.alerts.some((a) => a.userId === u.id && a.k === later.k)) {
        this.pushAlert({ kind: 'missed', t: now, userId: u.id, k: later.k, ...this.hourNumbers(later), madeOut: true });
      }
      this.addLog('out', { userId: u.id, by, text: `is still out (missed hour ${later.k + 1})` });
    } else {
      u.out = false;
      u.outAuto = null;
      u.outReason = null;
      this.addLog('reinstate', { userId: u.id, by, text: by ? (st === 'free' ? `back in: hour ${k + 1} is a free hour` : `back in: hour ${k + 1} counts`) : `back in automatically: hour ${k + 1} is ${st === 'free' ? 'a free hour' : 'met'} after all` });
    }
    return true;
  }

  // Host decision on an hour in review: 'accept' counts its flagged words,
  // 'reject' doesn't (and the hour may then be missed), null undoes the decision.
  adminReview(adminId, body) {
    const a = this.requireAdmin(adminId);
    if (!isPlainObject(body)) throw new HttpError(400, 'Bad request');
    const u = this.userById(body.id);
    if (!u || !u.joinedAt) throw new HttpError(404, 'No such writer');
    const k = body.k;
    if (!Number.isInteger(k) || k < 0 || k > 1000) throw new HttpError(400, 'Bad hour');
    if (![null, 'accept', 'reject'].includes(body.decision)) throw new HttpError(400, 'decision must be accept, reject or null');
    const now = this.now();
    const before = this.undoSnapshot(u, k);
    // A decision on an hour that isn't judged yet (it may still be running) covers the flagged
    // words the host has seen: the ones they were shown (body.seen), at most as many as there are
    // now. If 5 or more are flagged after it, it stops applying (lib/progress.js) and the host is
    // asked again. A decision on a judged hour covers the hour, as before.
    let seen = null;
    if (body.decision && k > u.evaluatedThrough) {
      const cur = this.progressOf(u.id, { now })?.prog.hours.find((x) => x.k === k);
      seen = Math.round(cur ? cur.flagged : 0);
      if (Number.isFinite(body.seen) && body.seen >= 0) seen = Math.min(seen, Math.round(body.seen));
    }
    if (body.decision) u.reviews[k] = body.decision;
    else delete u.reviews[k];
    if (seen !== null) (u.reviewSeen ||= {})[k] = seen;
    else if (u.reviewSeen) delete u.reviewSeen[k];
    this.addLog(body.decision ? `review-${body.decision}` : 'review-undo', {
      userId: u.id, by: a.id,
      text: body.decision === 'accept' ? `hour ${k + 1}: flagged words accepted` : body.decision === 'reject' ? `hour ${k + 1}: flagged words not counted` : `hour ${k + 1}: review decision undone`,
    });
    for (const al of this.state.alerts) {
      if (al.userId === u.id && al.k === k && al.kind === 'review' && !al.ack) {
        al.ack = true;
        al.ackBy = a.id;
        before.acked.push(al.id);
      }
    }
    this.cache.delete(u.id);
    const { prog } = this.progressOf(u.id, { now });
    const h = prog.hours.find((x) => x.k === k);
    if (h && u.judged && u.judged[k]) u.judged[k].status = h.status;
    if (h && k <= u.evaluatedThrough) {
      if (h.status === 'missed') this.onMissed(u, h, now, { by: a.id });
      else if (h.status === 'review' && u.out && u.outAuto === k && u.outVia === 'reject') {
        // The host took back a "Don't count": the hour is back in review, which never puts anyone out.
        u.out = false;
        u.outAuto = null;
        u.outReason = null;
        this.addLog('reinstate', { userId: u.id, by: a.id, text: `back in: hour ${k + 1} is back in review` });
      } else this.reconsiderOut(u, prog, now, a.id);
    }
    this.touch();
    const out = { status: h ? h.status : null };
    if (body.decision === 'reject') Object.assign(out, this.recordUndo('review-reject', u, k, before));
    return out;
  }

  takePass(userId, body = {}) {
    const u = this.requireApproved(userId);
    if (this.phase !== 'running') throw new HttpError(409, 'Passes can be used while the party is running');
    if (!u.joinedAt) throw new HttpError(409, 'Open the editor first');
    if (Number.isFinite(u.leftAt)) throw new HttpError(409, 'You’ve left the party: your hours aren’t judged, so there’s no hour to take off', { code: 'left' });
    if (passesLeft(u, this.S) <= 0) throw new HttpError(409, 'You have no passes left');
    // SPEC §34: this hour (the default, at any point in it) or the next one.
    const which = body.which ?? 'current';
    if (which !== 'current' && which !== 'next') throw new HttpError(400, 'which must be current or next');
    const ph = this.passOf(u);
    const k = which === 'next' ? ph.next : ph.current;
    // The hour the writer was shown (body.k) must still be that one.
    if (Number.isInteger(body.k) && body.k !== k) throw new HttpError(409, 'The hour changed; please try again', { code: 'stale' });
    if ((u.freeHours || []).some((f) => f.k === k)) throw new HttpError(409, `Hour ${k + 1} is already free`, { code: 'already-free' });
    if (Number.isInteger(u.evaluatedThrough) && k <= u.evaluatedThrough) throw new HttpError(409, `Hour ${k + 1} has already been judged`, { code: 'judged' });
    u.freeHours.push({ k, by: 'pass', at: this.now() });
    this.addLog('pass', { userId: u.id, text: `took hour ${k + 1} off (${which === 'next' ? 'the next hour' : 'the current hour'}; a pass)` });
    this.touch();
    return { k, which };
  }
  // The pass dialog: the current hour (k, startAt, endAt, already: as before) and, SPEC §34, both
  // choices with whether each is free or judged already.
  passPreview(userId) {
    const u = this.requireUser(userId);
    if (!u.joinedAt || this.phase !== 'running') return null;
    const ph = this.passOf(u);
    const plan = this.planOf(u);
    const hour = (k) => {
      const w = hourSpan(k, plan, this.state.breaks, this.S.hourLengthMin * 60_000);
      return { k, startAt: w.startAt, endAt: w.endAt, already: (u.freeHours || []).some((f) => f.k === k), judged: Number.isInteger(u.evaluatedThrough) && k <= u.evaluatedThrough };
    };
    const current = hour(ph.current);
    return { k: current.k, startAt: current.startAt, endAt: current.endAt, left: passesLeft(u, this.S), already: current.already, current, next: hour(ph.next) };
  }

  // ------------------------------------------------------------ leaving the party (SPEC §33)
  // A writer who leaves stops being judged from the hour they leave in: no "out", no alerts, no
  // warnings; their posts stay and they may still write. Coming back resumes judging like a first
  // arrival (lib/hours.js leaveHours). byId: the writer themself, or a host for anyone.
  setLeft(byId, userId, left) {
    const by = this.requireUser(byId);
    const u = this.userById(userId);
    if (!u) throw new HttpError(404, 'No such writer');
    const self = by.id === u.id;
    if (!self && !by.isAdmin) throw new HttpError(404, 'Not found');
    if (self) this.requireApproved(u.id);
    if (typeof left !== 'boolean') throw new HttpError(400, 'left must be true or false');
    if (this.phase !== 'running') throw new HttpError(409, 'Only while the party is running', { code: 'not-running' });
    const now = this.now();
    if (left && !Number.isFinite(u.leftAt)) {
      u.leftAt = now;
      u.leftBy = by.id;
      this.addLog('left', { userId: u.id, by: self ? null : by.id, text: `${self ? 'left the party' : 'marked as left the party'}: their hours aren’t judged from now on` });
    } else if (!left && Number.isFinite(u.leftAt)) {
      (u.leaves ||= []).push({ at: u.leftAt, by: u.leftBy ?? null, backAt: now, backBy: by.id });
      u.leftAt = null;
      u.leftBy = null;
      this.addLog('back', { userId: u.id, by: self ? null : by.id, text: `back at the party: ${this.resumeText(u, now)}` });
    } else return this.leftView(u);
    this.applyPlan(u); // the scorer's targets (a return mid-hour is pro-rated)
    this.cache.delete(u.id);
    this.totalsCache = null;
    this.publicRev++; // the public list of writers
    this.touch();
    return this.leftView(u);
  }
  leftView(u) {
    return { left: Number.isFinite(u.leftAt), leftAt: Number.isFinite(u.leftAt) ? u.leftAt : null };
  }
  // Where judging picks up again after a return at `now`, for the log.
  resumeText(u, now) {
    const plan = this.planOf(u);
    if (!plan) return 'their hours start when they open the editor';
    const hourMs = this.S.hourLengthMin * 60_000;
    const k = hourIndex(now, plan.anchor, pauseBreaks(this.state.breaks), hourMs);
    const lv = leaveHours(leavePeriods(u), plan, { S: this.S, breaks: this.state.breaks });
    if (!lv.ranges.some((r) => k >= r.from && k < r.to)) return `hour ${k + 1} counts from now, with a smaller target`;
    return `judging starts again with hour ${k + 2} at ${this.fmtClock(hourSpan(k + 1, plan, this.state.breaks, hourMs).startAt)}`;
  }

  // The hour a pass would waive now (hour 1 starts at the first open).
  passOf(u) {
    const plan = this.planOf(u);
    return passHour({ user: u, breaks: this.state.breaks, now: this.now(), S: this.S, anchor: plan ? plan.anchor : u.joinedAt, firstAt: plan ? plan.firstHourAt : u.joinedAt });
  }

  // Paste dialog: which words are already counted for me / match another writer.
  pasteCheck(userId, text) {
    this.requireApproved(userId);
    if (typeof text !== 'string' || text.length > MAX_INS) throw new HttpError(400, 'Bad text');
    const now = this.now();
    this.engine.advance(now);
    // Only text anyone can read on the public page may show up as "another writer's text":
    // never notes, separate-identity or hidden posts (the dialog must not become an oracle).
    const visible = (e) => {
      if (e.pane !== 'body') return false;
      const p = typeof e.post === 'string' && Object.hasOwn(this.state.posts, e.post) ? this.state.posts[e.post] : null;
      return !!p && p.ownerId === e.w && !p.unlisted && (this.isSharedText(p.id, 'body') || (p.privacy === 'separate' && this.phase === 'ended')) && this.isApproved(this.userById(e.w));
    };
    return this.engine.pasteCheck(userId, text, now, visible);
  }

  // ------------------------------------------------------------ host actions
  adminWriter(adminId, body) {
    const a = this.requireAdmin(adminId);
    if (!isPlainObject(body)) throw new HttpError(400, 'Bad request');
    const u = this.userById(body.id);
    if (!u) throw new HttpError(404, 'No such writer');
    const now = this.now();
    const result = { user: u, undo: null };
    if (body.targetOverride !== undefined) {
      const v = body.targetOverride;
      if (v === null || v === '') u.targetOverride = null;
      else if (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 100000) u.targetOverride = Number(v);
      else throw new HttpError(400, 'Target must be a whole number');
      this.engine.setTarget(u.id, u.targetOverride ?? undefined);
      this.nextEngine?.setTarget(u.id, u.targetOverride ?? undefined);
      this.applyPlan(u); // per-hour targets (pro-rated, break-lowered) follow the override too
      this.cache.delete(u.id);
      this.addLog('target', { userId: u.id, by: a.id, text: u.targetOverride === null ? 'target: default' : `target set to ${u.targetOverride}` });
    }
    if (body.trustPastes !== undefined) {
      if (typeof body.trustPastes !== 'boolean') throw new HttpError(400, 'trustPastes must be true or false');
      if (body.trustPastes !== !!u.trustPastes) {
        u.trustPastes = body.trustPastes;
        // Read when results are computed (lib/score.js), so no re-score: hours waiting only on a
        // big paste are met from now on, and judged hours are brought in line (tick).
        for (const eng of [this.engine, this.nextEngine]) eng?.setCtx(u.id, { trustPastes: u.trustPastes });
        this.cache.delete(u.id);
        this.needsReconcile = true;
        this.totalsCache = null;
        this.addLog('trust-pastes', { userId: u.id, by: a.id, text: u.trustPastes ? 'pastes trusted: never flagged as big pastes' : 'pastes checked again like everyone’s' });
      }
    }
    if (body.carryOverride !== undefined) {
      const v = Party.carryValue(body.carryOverride);
      if (v !== (u.carryOverride ?? null)) {
        u.carryOverride = v;
        // Carried words move between this writer's hours: judged hours are brought in line (tick).
        this.needsReconcile = true;
        this.totalsCache = null;
        this.addLog('carry', { userId: u.id, by: a.id, text: v === null ? 'carryover limit: default' : `carryover limit set to ${v} words` });
      }
    }
    if (body.joinedAt !== undefined) {
      if (!Number.isFinite(body.joinedAt) || body.joinedAt > now + 24 * 3600_000) throw new HttpError(400, 'Bad start time');
      u.joinedAt = Math.round(body.joinedAt);
      const nb = pauseBreaks(this.state.breaks);
      u.evaluatedThrough = hourIndex(now, this.anchorOf(u), nb, this.S.hourLengthMin * 60_000) - 1;
      if (!this.applyPlan(u)) this.rebuildEngine();
      this.addLog('joined', { userId: u.id, by: a.id, text: `start time set to ${this.fmtClock(u.joinedAt)}` });
    }
    if (body.out !== undefined) {
      if (typeof body.out !== 'boolean') throw new HttpError(400, 'Bad request');
      if (body.out && !u.out) {
        const before = this.undoSnapshot(u, null);
        u.out = true;
        u.outAt = now;
        u.outAuto = null;
        u.outVia = 'host';
        u.outReason = 'marked out by the host';
        this.addLog('mark-out', { userId: u.id, by: a.id, text: 'marked out by the host' });
        result.undo = this.recordUndo('mark-out', u, null, before);
      } else if (!body.out && u.out) {
        u.out = false;
        u.outAuto = null;
        u.outReason = null;
        this.addLog('reinstate', { userId: u.id, by: a.id, text: 'reinstated' });
        for (const al of this.state.alerts) if (al.userId === u.id && !al.ack) al.ack = true;
      }
    }
    if (body.extraPasses !== undefined) {
      const d = Number(body.extraPasses);
      if (!Number.isInteger(d) || d < -100 || d > 100) throw new HttpError(400, 'Bad pass count');
      u.extraPasses = Math.max(0, (u.extraPasses || 0) + d);
      this.addLog('passes', { userId: u.id, by: a.id, text: `${d >= 0 ? 'gave' : 'removed'} ${Math.abs(d)} pass${Math.abs(d) === 1 ? '' : 'es'}` });
    }
    if (body.freeHour !== undefined) {
      // A number: an hour that has ended and was judged missed (or waits for review) becomes free after the fact.
      const past = Number.isInteger(body.freeHour);
      if (!past && !['current', 'next'].includes(body.freeHour)) throw new HttpError(400, 'freeHour must be current, next or an hour that has ended');
      if (!u.joinedAt) throw new HttpError(409, 'This writer hasn’t started yet');
      const nb = pauseBreaks(this.state.breaks);
      const curK = hourIndex(now, this.anchorOf(u), nb, this.S.hourLengthMin * 60_000);
      const k = past ? body.freeHour : curK + (body.freeHour === 'next' ? 1 : 0);
      if ((u.freeHours || []).some((f) => f.k === k)) throw new HttpError(409, `Hour ${k + 1} is already free`, { code: 'already-free' });
      if (past) {
        if (k < 0 || k >= curK || !Number.isInteger(u.evaluatedThrough) || k > u.evaluatedThrough) throw new HttpError(409, `Hour ${k + 1} hasn’t ended and been judged yet`, { code: 'not-judged' });
        const st = this.progressOf(u.id, { now, fresh: true })?.prog.hours.find((x) => x.k === k)?.status;
        if (st !== 'missed' && st !== 'review') throw new HttpError(409, `Hour ${k + 1} wasn’t missed`, { code: 'not-missed' });
      }
      // usePass: true counts it against the writer's own free pass(es), as if they had taken it.
      const usePass = body.usePass === true;
      if (usePass && passesLeft(u, this.S) <= 0) throw new HttpError(409, 'They have no passes left', { code: 'no-passes' });
      (u.freeHours ||= []).push({ k, by: usePass ? 'pass' : 'host', at: now, ...(usePass ? { grantedBy: a.id } : {}), ...(past ? { afterEnd: true } : {}) });
      this.cache.delete(u.id);
      const what = past ? `made hour ${k + 1} a free hour after it ended` : `gave a free hour (hour ${k + 1})`;
      this.addLog(usePass ? 'pass' : 'free-hour', { userId: u.id, by: a.id, text: usePass ? `${what}, using their pass` : what });
      if (past) this.freedAfterEnd(u, k, now, a.id);
    }
    // passForHour: k counts an hour the host already made free against the writer's pass.
    if (body.passForHour !== undefined) {
      const k = body.passForHour;
      if (!Number.isInteger(k) || k < 0 || k > 1000) throw new HttpError(400, 'Bad hour');
      const f = (u.freeHours || []).find((x) => x.k === k);
      if (!f) throw new HttpError(409, `Hour ${k + 1} isn’t a free hour`, { code: 'not-free' });
      if (f.by === 'pass') throw new HttpError(409, `Hour ${k + 1} already used their pass`, { code: 'already-pass' });
      if (passesLeft(u, this.S) <= 0) throw new HttpError(409, 'They have no passes left', { code: 'no-passes' });
      Object.assign(f, { by: 'pass', grantedBy: a.id, passAt: now });
      this.cache.delete(u.id);
      this.addLog('pass', { userId: u.id, by: a.id, text: `hour ${k + 1}: counted against their free pass` });
    }
    if (body.name !== undefined) {
      const n = cleanLine(body.name, 40);
      if (!n) throw new HttpError(400, 'Bad name');
      if (displayNameError(n, { who: 'they' })) throw new HttpError(400, displayNameError(n, { who: 'they' }), { code: 'name_email', field: 'name' }); // SPEC §25
      u.name = n;
      this.publicRev++;
    }
    this.touch();
    return result;
  }

  // ------------------------------------------------------------ undo (2 minutes)
  undoSnapshot(u, k) {
    const alertIds = new Set(this.state.alerts.map((al) => al.id));
    return {
      decision: k === null ? undefined : u.reviews[k],
      seen: k === null || !u.reviewSeen ? undefined : u.reviewSeen[k],
      out: { out: !!u.out, outAt: u.outAt ?? null, outAuto: u.outAuto ?? null, outReason: u.outReason ?? null, outVia: u.outVia ?? null },
      alertIds, acked: [],
    };
  }
  recordUndo(kind, u, k, before) {
    const now = this.now();
    for (const [id, x] of this.undos) if (x.until < now) this.undos.delete(id);
    const id = randomId(10);
    const raised = this.state.alerts.filter((al) => !before.alertIds.has(al.id)).map((al) => al.id);
    const until = now + UNDO_MS;
    this.undos.set(id, { id, kind, userId: u.id, k, at: now, until, prev: { decision: before.decision, seen: before.seen, out: before.out }, raised, acked: before.acked });
    return { undoId: id, undoUntil: until };
  }
  undo(adminId, body) {
    const a = this.requireAdmin(adminId);
    const id = isPlainObject(body) && typeof body.id === 'string' ? body.id : '';
    const un = this.undos.get(id);
    if (!un) throw new HttpError(404, 'Nothing to undo');
    this.undos.delete(id);
    if (this.now() > un.until) throw new HttpError(410, 'Too late to undo (it can be undone for 2 minutes)');
    const u = this.userById(un.userId);
    if (!u) throw new HttpError(404, 'No such writer');
    if (un.kind === 'review-reject') {
      if (un.prev.decision) u.reviews[un.k] = un.prev.decision;
      else delete u.reviews[un.k];
      if (Number.isFinite(un.prev.seen)) (u.reviewSeen ||= {})[un.k] = un.prev.seen;
      else if (u.reviewSeen) delete u.reviewSeen[un.k];
    }
    Object.assign(u, un.prev.out);
    for (const al of this.state.alerts) {
      if (un.raised.includes(al.id)) Object.assign(al, { ack: true, undone: true });
      if (un.acked.includes(al.id)) Object.assign(al, { ack: false, ackBy: undefined });
    }
    this.cache.delete(u.id);
    this.addLog('undo', { userId: u.id, by: a.id, text: un.kind === 'review-reject' ? `hour ${un.k + 1}: “Don’t count” undone; back in review` : '“Mark as out” undone' });
    this.touch();
    return { undone: un.kind };
  }
  undoFor(alertId, now = this.now()) {
    for (const x of this.undos.values()) if (x.until >= now && x.raised.includes(alertId)) return x;
    return null;
  }

  // ------------------------------------------------------------ party meta
  setRegistration(adminId, open) {
    const a = this.requireAdmin(adminId);
    if (typeof open !== 'boolean') throw new HttpError(400, 'open must be true or false');
    this.state.party.registrationOpen = open;
    this.addLog('registration', { by: a.id, text: open ? 'opened registration' : 'closed registration' });
    this.touch();
    return { registrationOpen: open };
  }
  setPlannedEnd(adminId, v) {
    const a = this.requireAdmin(adminId);
    const now = this.now();
    if (v === null || v === '') this.state.party.plannedEnd = null;
    else if (Number.isFinite(v) && v > now - 24 * 3600_000 && v < now + 48 * 3600_000) this.state.party.plannedEnd = Math.round(v);
    else throw new HttpError(400, 'Planned end must be a time today, or empty');
    this.addLog('planned-end', { by: a.id, text: this.state.party.plannedEnd ? `planned end set to ${this.fmtClock(this.state.party.plannedEnd)}` : 'planned end cleared' });
    this.touch();
  }

  adminPost(adminId, body) {
    const a = this.requireAdmin(adminId);
    const p = isPlainObject(body) && typeof body.id === 'string' && Object.hasOwn(this.state.posts, body.id) ? this.state.posts[body.id] : null;
    if (!p) throw new HttpError(404, 'No such post');
    if (body.unlisted !== undefined) {
      if (typeof body.unlisted !== 'boolean') throw new HttpError(400, 'Bad request');
      p.unlisted = body.unlisted;
      this.addLog(p.unlisted ? 'unlist' : 'relist', { userId: p.ownerId, by: a.id, text: `${p.unlisted ? 'unlisted' : 'relisted'} “${p.title || 'Untitled'}”` });
    }
    this.publicRev++;
    this.touch();
    return p;
  }

  // The mode a new break gets when the host doesn't choose (SPEC §19).
  defaultBreakMode() {
    return this.S.hoursMode === 'synced' ? 'reduce' : 'pause';
  }
  // body: { label | name, lengthMin | minutes, startAt | startsAt, mode? }
  addBreak(adminId, body) {
    const a = this.requireAdmin(adminId);
    if (!isPlainObject(body)) throw new HttpError(400, 'Bad request');
    const now = this.now();
    const sa = body.startAt ?? body.startsAt;
    const startAt = sa === undefined || sa === null ? now : Number(sa);
    const len = Number(body.lengthMin ?? body.minutes);
    if (!Number.isFinite(startAt) || startAt < now - 60_000 || startAt > now + 24 * 3600_000) throw new HttpError(400, 'Start time must be now or later today');
    if (!Number.isFinite(len) || len < 1 || len > 600) throw new HttpError(400, 'Length must be 1–600 minutes');
    const mode = body.mode === undefined || body.mode === null ? this.defaultBreakMode() : body.mode;
    if (mode !== 'pause' && mode !== 'reduce') throw new HttpError(400, 'mode must be pause or reduce');
    const label = cleanLine(body.label ?? body.name, 60) || 'Break';
    const b = { id: randomId(8), startAt: Math.round(startAt), endAt: Math.round(startAt + len * 60_000), label, mode };
    this.state.breaks.push(b);
    this.publicRev++;
    this.updateEngineBreaks(b.startAt, { windowsMoved: mode === 'pause' });
    this.addLog('break', { by: a.id, text: `${label}: ${len} min (${mode === 'reduce' ? 'the clock keeps running, targets lowered' : 'clocks paused'})` });
    this.touch();
    return b;
  }
  endBreak(adminId, body) {
    const a = this.requireAdmin(adminId);
    const b = this.state.breaks.find((x) => isPlainObject(body) && x.id === body.id);
    if (!b) throw new HttpError(404, 'No such break');
    const now = this.now();
    if (b.startAt >= now) this.state.breaks = this.state.breaks.filter((x) => x !== b);
    else b.endAt = Math.min(b.endAt, now);
    this.publicRev++;
    this.updateEngineBreaks(now, { windowsMoved: breakModeOf(b) === 'pause' });
    this.addLog('break-end', { by: a.id, text: `${b.label}: ${b.startAt >= now ? 'cancelled' : 'ended'}` });
    this.touch();
  }
  // Change a scheduled or running break between 'pause' and 'reduce' (re-scores; SPEC §19).
  setBreakMode(adminId, body) {
    const a = this.requireAdmin(adminId);
    const b = this.state.breaks.find((x) => isPlainObject(body) && x.id === body.id);
    if (!b) throw new HttpError(404, 'No such break');
    const mode = isPlainObject(body) ? body.mode : null;
    if (mode !== 'pause' && mode !== 'reduce') throw new HttpError(400, 'mode must be pause or reduce');
    const now = this.now();
    if (b.endAt <= now) throw new HttpError(409, 'That break is over');
    if (breakModeOf(b) !== mode) {
      b.mode = mode;
      this.publicRev++;
      this.updateEngineBreaks(b.startAt, { windowsMoved: true });
      this.resetJudging(now);
      this.addLog('break-mode', { by: a.id, text: `${b.label}: ${mode === 'reduce' ? 'the clock keeps running, targets lowered' : 'clocks paused'}` });
      this.touch();
    }
    return { break: this.breaksView(now).find((x) => x.id === b.id) };
  }
  ackAlert(adminId, body) {
    const a = this.requireAdmin(adminId);
    let n = 0;
    for (const al of this.state.alerts) {
      if (!al.ack && (body.id === 'all' || al.id === body.id)) {
        al.ack = true;
        al.ackBy = a.id;
        n++;
      }
    }
    if (n) this.touch();
    return n;
  }

  // ------------------------------------------------------------ views
  partyInfo() {
    const { name, phase, startedAt, endedAt } = this.state.party;
    return { name, phase, startedAt, endedAt, plannedStart: this.plannedStart(), approvalRequired: !!this.S.approvalRequired, round: this.round, rounds: this.roundsList() }; // the sign-up form says so
  }
  // The planned start while the party is still in the lobby (else null).
  plannedStart() {
    const at = this.state.party.plannedStart;
    return this.phase === 'lobby' && Number.isFinite(at) ? at : null;
  }
  breaksView(now = this.now()) {
    return this.state.breaks.map((b) => ({
      id: b.id, startAt: b.startAt, endAt: b.endAt, label: b.label, mode: breakModeOf(b),
      status: now < b.startAt ? 'scheduled' : now < b.endAt ? 'active' : 'ended',
    }));
  }
  // "HH:MM" on the party clock.
  fmtClock(ms) {
    if (!Number.isFinite(ms)) return '';
    return this.clockFormat('clock', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
  }
  // "2026-10-04T09:13:00+01:00": an exact time on the party clock (exports, file names).
  localStamp(ms) {
    const parts = Object.fromEntries(this.clockFormat('stamp', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
    }).formatToParts(ms).map((x) => [x.type, x.value]));
    const off = String(parts.timeZoneName || '').replace(/^GMT/, '') || '+00:00';
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${off}`;
  }
  clockFormat(kind, opts) {
    this.formats ||= new Map();
    const key = `${kind}|${this.tz}`;
    let f = this.formats.get(key);
    if (!f) {
      try {
        f = new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: this.tz });
      } catch {
        this.logger.error(`[party] unknown time zone ${this.tz}; using ${DEFAULT_TZ}`);
        f = new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: DEFAULT_TZ });
      }
      this.formats.set(key, f);
    }
    return f;
  }
  partyMeta(now = this.now()) {
    const { name, phase, startedAt, endedAt, plannedEnd, registrationOpen } = this.state.party;
    return {
      name, phase, startedAt, endedAt, joinUrl: this.publicUrl, plannedEnd: plannedEnd ?? null, plannedStart: this.plannedStart(),
      registrationOpen: registrationOpen !== false, now, breaks: this.breaksView(now),
      ...this.hourMeta(now),
      hosts: Object.values(this.state.users).filter((u) => u.isAdmin).length, // SPEC §21
      round: this.round, rounds: this.roundsList(), // lib/rounds.js
    };
  }
  // Credit and not-counted words of an hour (or of the whole party so far).
  breakdown(row) {
    if (!row) return null;
    const nc = {};
    for (const r of NOT_COUNTED) nc[r] = row.notCounted ? row.notCounted[r] || 0 : 0;
    return {
      written: row.written || 0, pasted: row.pasted || 0, cut: row.cut || 0, clawback: row.clawback || 0,
      credit: row.credit || 0, flagged: row.flaggedCredit ?? row.flagged ?? 0, nc, bonus: row.bonus || 0,
      ...(row.carriedIn ? { carried: row.carriedIn } : {}), // words carried in from the hour before (lib/progress.js)
    };
  }

  // The writer's own app state (no post texts; those come from postsWithText).
  meView(userId) {
    const u = this.requireUser(userId);
    const now = this.now();
    const p = u.joinedAt ? this.progressOf(u.id, { now }) : null;
    const posts = this.postsOf(u.id).map((x) => ({
      id: x.id, title: x.title, privacy: x.privacy, closed: x.closed, unlisted: x.unlisted, ver: x.ver,
      starred: !!x.starred, // SPEC §28b: their own star, for the post's menu (shown publicly only on their page)
      publicId: x.privacy === 'private' ? null : x.privacy !== 'separate' || this.phase === 'ended' ? x.publicId : null, // private: no public page
      ...this.afterSession(x, now), // editing, reasoned: the post's session after the party (SPEC §30)
      ...(x.after?.added ? { added: true } : {}), // started after the end (SPEC §30)
    }));
    let progress = null;
    if (p) {
      const cur = p.prog.current || p.prog.leftNow; // left the party: this hour's words, not judged (SPEC §33)
      const curRow = cur ? p.prog.hours.find((h) => h.k === cur.k) : null;
      progress = {
        hours: p.prog.hours.map((h) => ({ k: h.k, startAt: h.startAt, endAt: h.endAt, status: h.status, credited: h.credited, target: h.target, carriedIn: h.carriedIn || 0, carriedOut: h.carriedOut || 0 })),
        current: p.prog.current,
        leftNow: p.prog.leftNow,
        currentBreakdown: this.breakdown(curRow && { ...curRow, bonus: p.result.hours[curRow.k]?.bonus || 0 }),
        totals: this.breakdown(p.result.totals),
        met: p.prog.met,
        missed: p.prog.missed,
        free: p.prog.free,
        review: p.prog.review,
        passesLeft: p.prog.passesLeft,
        personalFactor: this.S.personalTargets ? p.factor : null,
      };
    }
    return {
      serverNow: now,
      me: {
        id: u.id, username: u.username, name: u.name, isAdmin: !!u.isAdmin, joinedAt: u.joinedAt,
        hasEmail: !!u.email, // SPEC §25b: the account areas say "Add your email" until there is one
        out: !!u.out, outReason: u.outReason, targetOverride: u.targetOverride,
        leftAt: Number.isFinite(u.leftAt) ? u.leftAt : null, // SPEC §33: left the party (their hours aren't judged)
        ...this.approvalView(u),
        page: this.profileIdOf(u), // SPEC §28b: their own page while they're on the list of writers (else null), for "My page"
        pastPosts: this.pastRounds.reduce((n, r) => n + r.posts.filter((x) => x.ownerId === u.id).length, 0), // earlier rounds (/past)
        ...this.hourView(u, p ? p.prog.current : null),
      },
      party: this.partyInfo(),
      settings: {
        pasteAskOverWords: this.S.pasteAskOverWords, settleSec: this.S.settleSec,
        targetPerHour: this.S.targetPerHour, hourLengthMin: this.S.hourLengthMin,
        freePassesPerWriter: this.S.freePassesPerWriter, personalTargets: this.S.personalTargets, carryOverMax: carryCap(this.S, u), // their own limit, if a host set one
        missedHourOutcome: this.S.missedHourOutcome, cutWeight: this.S.cutWeight, cutMatureMin: this.S.cutMatureMin,
        shortPastesCount: this.S.shortPastesCount,
        hoursMode: this.S.hoursMode, syncMinute: this.S.syncMinute, minFirstHourMin: this.S.minFirstHourMin,
      },
      breaks: this.breaksView(),
      posts,
      progress,
      pass: this.passPreview(u.id),
    };
  }

  // SPEC §17b/§19: me.hour = { index, startAt, endAt, target, baseTarget, reducedBy, prorated, extended }
  hourView(u, cur) {
    const plan = this.planOf(u);
    return {
      hour: cur ? {
        index: cur.k, startAt: cur.startAt, endAt: cur.endAt, target: cur.target, baseTarget: cur.baseTarget, reducedBy: cur.reducedBy,
        prorated: !!cur.prorated, extended: !!cur.extended,
      } : null,
      firstHourAt: plan ? plan.firstHourAt : null,
    };
  }
  // Public party clock facts for synced hours.
  hourMeta(now = this.now()) {
    const ctx = { settings: this.S, startedAt: this.state.party.startedAt, breaks: this.state.breaks, tz: this.tz };
    const meta = { hoursMode: this.S.hoursMode, nextHourAt: this.phase === 'running' ? nextWindowStart(now, ctx) : null };
    // The party's current synced hour, for the projector's pacing strip: its number, span and target
    // (lowered by keep-the-clock breaks, as the scorer does).
    if (this.phase === 'running' && this.S.hoursMode === 'synced' && Number.isFinite(ctx.startedAt)) {
      try {
        const hourMs = this.S.hourLengthMin * 60_000;
        const A = gridAnchor(ctx.startedAt, this.S.syncMinute ?? 0, this.tz);
        const k = hourIndex(now, A, pauseBreaks(this.state.breaks), hourMs);
        const plan = { anchor: A, firstHourAt: A };
        const span = hourSpan(k, plan, this.state.breaks, hourMs);
        meta.hour = { n: k + 1, startAt: span.startAt, endAt: span.endAt, target: reducedTarget(k, plan, this.S.targetPerHour, this.state.breaks, hourMs).target };
      } catch {
        // No pacing strip rather than a broken live view.
      }
    }
    return meta;
  }
  approvalView(u) { // (and whether they're in this round: lib/rounds.js)
    return {
      approval: this.approvalOf(u),
      approvalMessage: u.approvalMessage ?? null,
      approvalMessageAt: u.approvalMessageAt ?? null,
      approvalNote: this.approvalOf(u) === 'declined' ? u.approvalNote ?? null : null,
      inRound: this.inRound(u), round: this.round,
    };
  }

  postsWithText(userId) {
    this.requireUser(userId);
    return this.postsOf(userId).map((p) => ({
      id: p.id, title: p.title, privacy: p.privacy, closed: p.closed, unlisted: p.unlisted,
      ver: p.ver, body: p.body, notes: p.notes, ...this.afterSession(p), ...(p.after?.added ? { added: true } : {}),
    }));
  }
  postText(userId, postId, pane) {
    const p = this.requirePost(userId, postId);
    if (!Object.hasOwn(PANES, pane)) throw new HttpError(400, 'Bad pane');
    return { id: p.id, pane, text: p[pane], version: p.ver[pane] };
  }

  // Median credited words per active minute so far (the scorer's per-minute timeline), or null.
  static usualPace(result, now) {
    const tl = result && result.timeline;
    if (!tl || !tl.length) return null;
    const cur = Math.floor(now / 60_000);
    const xs = tl.filter(([m, v]) => m < cur && v >= 1).map(([, v]) => v);
    return xs.length >= 3 ? Math.round(median(xs) * 10) / 10 : null;
  }
  // The current hour's arithmetic for the host: what's left and the pace it needs.
  paceOf(u, prog, result, now) {
    const cur = prog && prog.current;
    if (!cur || cur.free || this.phase !== 'running') return null;
    const nb = pauseBreaks(this.state.breaks);
    const from = Math.max(now, cur.startAt);
    const left = activeMs(cur.endAt, from, nb); // clock time left (pause-breaks stop the clock)
    // Writing time left: reduce-breaks keep the clock running but lowered the target for it.
    let breakLeft = 0;
    for (const b of reduceBreaks(this.state.breaks)) breakLeft += Math.max(0, Math.min(cur.endAt, b.endAt) - Math.max(from, b.startAt));
    const minutesLeft = Math.max(0, left / 60_000);
    const writingMin = Math.max(0, (left - breakLeft) / 60_000);
    const have = (cur.credited || 0) + (cur.pending || 0);
    const need = cur.target; // after pro-rating and reduce-breaks
    const wordsLeft = Math.max(0, Math.ceil(need - have - 1e-9));
    const perMinuteNeeded = wordsLeft === 0 ? 0 : writingMin > 0 ? Math.round((wordsLeft / writingMin) * 10) / 10 : null;
    // Idle time, not counting any break.
    const last = Math.max(u.lastOpAt || 0, u.joinedAt || 0);
    const idleMin = Math.max(0, Math.floor(activeMs(now, Math.min(now, last), normalizeBreaks(this.state.breaks)) / 60_000));
    return { need, have: Math.round(have), wordsLeft, minutesLeft: Math.round(minutesLeft * 10) / 10, writingMinutesLeft: Math.round(writingMin * 10) / 10, perMinuteNeeded, usualPerMinute: Party.usualPace(result, now), idleMin };
  }
  // Host table status: the first rule that applies.
  statusOf(u, prog, result, now) {
    if (this.phase === 'ended') return { status: 'ended', statusReason: 'The party has ended.', pace: null };
    if (this.phase === 'lobby') return { status: 'not-started', statusReason: 'Waiting for the party to start.', pace: null };
    const appr = this.approvalOf(u);
    if (appr === 'pending') return { status: 'not-started', statusReason: 'Waiting for your approval.', pace: null };
    if (appr === 'declined') return { status: 'not-started', statusReason: 'Not approved.', pace: null };
    // SPEC §33: neutral, never "out"; nothing about their hours is judged until they're back.
    if (Number.isFinite(u.leftAt)) return { status: 'left', statusReason: `Left the party at {t}. Their hours aren’t judged until they’re back.${u.out ? ' They were out of the challenge before that.' : ''}`, statusReasonAt: u.leftAt, pace: null };
    if (!u.joinedAt || !prog) return { status: 'not-started', statusReason: 'Clock not started: hasn’t opened the editor since the start.', pace: null };
    const pace = this.paceOf(u, prog, result, now);
    if (u.out) {
      const h = Number.isInteger(u.outAuto) ? prog.hours.find((x) => x.k === u.outAuto) : null;
      const why = h ? Party.missedText(h.k, this.hourNumbers(h)) : u.outReason || 'marked out by the host';
      return { status: 'out', statusReason: `Out: ${why}.`, pace };
    }
    const rv = prog.hours.filter((h) => h.status === 'review');
    if (rv.length) {
      const h = rv[0];
      const more = rv.length > 1 ? ` (and ${rv.length - 1} more)` : '';
      const since = Party.flaggedSince(h);
      return { status: 'review', statusReason: `Hour ${h.k + 1} waits for your review${more}: ${Party.reviewText(this.hourNumbers(h))}${since ? `; ${since} more words flagged since your decision` : ''}.`, pace };
    }
    const br = breakAt(now, this.state.breaks);
    if (br) {
      // Times go out as epoch ms: '{t}' in the text is statusReasonAt in the reader's local time (SPEC §24).
      const statusReason = breakModeOf(br) === 'reduce'
        ? `${br.label} until {t}; this hour's target is ${prog.current ? prog.current.target : this.S.targetPerHour}.`
        : `Paused for the ${br.label} until {t}.`;
      return { status: 'break', statusReason, statusReasonAt: br.endAt, pace };
    }
    const cur = prog.current;
    if (cur && cur.free) {
      const f = (u.freeHours || []).find((x) => x.k === cur.k);
      return { status: 'free', statusReason: `Hour ${cur.k + 1} is a free hour (${f && f.by === 'pass' ? 'their pass' : 'given by the host'}).`, pace };
    }
    if (pace) {
      const X = Math.max(12, 1.3 * (pace.usualPerMinute || 0));
      const usual = pace.usualPerMinute !== null ? `usually writes ${Math.round(pace.usualPerMinute)}` : 'no usual pace yet';
      if (pace.wordsLeft > 0 && (pace.perMinuteNeeded === null || pace.perMinuteNeeded > X)) {
        const mins = Math.max(1, Math.round(pace.minutesLeft));
        return { status: 'at-risk', statusReason: `${pace.wordsLeft} words to go in ${mins} minute${mins === 1 ? '' : 's'}: needs ${Math.ceil(pace.perMinuteNeeded ?? pace.wordsLeft)} a minute (${usual}).`, pace };
      }
      if (pace.idleMin >= 15 && pace.have < 0.75 * pace.need) {
        return { status: 'at-risk', statusReason: `Idle for ${pace.idleMin} minutes, ${pace.have} of ${pace.need} so far.`, pace };
      }
      if (pace.wordsLeft === 0) return { status: 'on-track', statusReason: `Hour ${cur.k + 1} done: ${pace.have} of ${pace.need}.`, pace };
      if (cur.k === 0 && (cur.extended || cur.prorated)) return { status: 'on-track', statusReason: `${pace.have} of ${pace.need}, first hour until {t}.`, statusReasonAt: cur.endAt, pace };
      return { status: 'on-track', statusReason: `${pace.have} of ${pace.need}, ${Math.round(pace.minutesLeft)} minutes left.`, pace };
    }
    return { status: 'on-track', statusReason: 'Writing.', pace };
  }
  alertText(a, name) {
    if (a.kind === 'approval') return `${name} is waiting for approval${a.message ? `: “${a.message}”` : '.'}`;
    const n = {
      countedWords: a.countedWords ?? a.credited ?? 0, typedWords: a.typedWords ?? a.credited ?? 0, notCountedWords: a.notCountedWords || 0,
      target: a.target, flags: a.flags || [], flagged: a.flagged ?? 0, carriedWords: a.carriedWords || 0,
    };
    if (a.kind === 'review') return `${name}: hour ${a.k + 1} needs your review: ${Party.reviewText(n)}.${a.flaggedSince ? ` ${a.flaggedSince} more words flagged since your decision.` : ''}`;
    if (n.notCountedWords) return `${name} missed hour ${a.k + 1}${a.madeOut ? ' and is out' : ''}: ${Party.countText(n)}.`;
    return `${name} missed hour ${a.k + 1} (${Party.countText(n)})${a.madeOut ? ' and is out' : ''}.`;
  }

  hostView(adminId) {
    this.requireAdmin(adminId);
    const now = this.now();
    const factors = this.factors(now);
    // This round's accounts and the hosts; accounts from earlier rounds only as a count until they join.
    const all = Object.values(this.state.users);
    const users = all.filter((u) => this.inRound(u) || u.isAdmin).sort((a, b) => a.name.localeCompare(b.name));
    const reviews = [];
    const summary = { writers: 0, notStarted: 0, onTrack: 0, atRisk: 0, out: 0, free: 0, break: 0, review: 0, left: 0, ended: 0, writingNow: 0, alertsOpen: 0, reviewsOpen: 0, pendingApproval: 0 };
    const KEY = { 'not-started': 'notStarted', 'on-track': 'onTrack', 'at-risk': 'atRisk', out: 'out', free: 'free', break: 'break', review: 'review', left: 'left', ended: 'ended' };
    const writers = users.map((u) => {
      const posts = this.postsOf(u.id);
      const base = {
        id: u.id, name: u.name, username: u.username, isAdmin: !!u.isAdmin, joinedAt: u.joinedAt,
        out: !!u.out, outReason: u.outReason, targetOverride: u.targetOverride, carryOverride: u.carryOverride ?? null, trustPastes: !!u.trustPastes, extraPasses: u.extraPasses || 0,
        posts: posts.length, separate: posts.filter((p) => p.privacy === 'separate').length,
        lastOpAt: u.lastOpAt, approval: this.approvalOf(u), email: u.email ?? null, inRound: this.inRound(u),
        leftAt: Number.isFinite(u.leftAt) ? u.leftAt : null, leftBy: Number.isFinite(u.leftAt) ? u.leftBy ?? null : null, // SPEC §33
      };
      if (base.approval === 'pending') summary.pendingApproval++;
      const counted = (!u.isAdmin || !!u.joinedAt) && base.approval === 'approved'; // a host who never writes isn't a writer
      if (u.lastOpAt && now - u.lastOpAt < 120_000 && this.phase === 'running') summary.writingNow++;
      if (!u.joinedAt) {
        const st = { statusReasonAt: null, ...this.statusOf(u, null, null, now) };
        if (counted) {
          summary.writers++;
          summary[KEY[st.status]]++;
        }
        return { ...base, ...st, progress: null };
      }
      const { prog, result, factor } = this.progressOf(u.id, { now, factors });
      const st = { statusReasonAt: null, ...this.statusOf(u, prog, result, now) };
      summary.writers++;
      summary[KEY[st.status]]++;
      const cur = prog.current;
      const inBreak = !!breakAt(now, this.state.breaks);
      const idleMs = this.phase === 'running' && !inBreak ? now - (u.lastOpAt || u.joinedAt) : 0;
      // Scoring flags across the writer's hours: { type: { count, words } }.
      const scoring = {};
      for (const f of result.flags || []) {
        const e = (scoring[f.type] ||= { count: 0, words: 0 });
        e.count += f.count || 1;
        e.words += f.words || 0;
      }
      for (const h of prog.hours) {
        if (h.status !== 'review') continue;
        reviews.push({
          userId: u.id, name: u.name, k: h.k, startAt: h.startAt, endAt: h.endAt, target: h.target,
          credit: h.credit, flagged: h.flagged, flags: h.flags, evidence: this.hourEvidence(u, h), bonus: result.hours[h.k]?.bonus || 0, carriedIn: h.carriedIn || 0,
          staleDecision: h.staleDecision || null, seen: h.seen ?? null, flaggedSince: Party.flaggedSince(h),
        });
      }
      return {
        ...base,
        ...st,
        factor: this.S.personalTargets ? factor : null,
        passesLeft: prog.passesLeft,
        progress: {
          current: cur,
          leftNow: prog.leftNow, // SPEC §33: left the party: this hour's words (no target, not judged)
          // flagged: credit that counts only after the host's check (also while the hour runs); flags: their types.
          // decision: the one that applies; seen: the flagged words an early decision covers; staleDecision: an early
          // decision that no longer applies (more words flagged since); evidence: what a running hour's check looks at.
          hours: prog.hours.map((h) => ({
            k: h.k, status: h.status, credited: h.credited, target: h.target, startAt: h.startAt, endAt: h.endAt, decision: h.decision, bonus: result.hours[h.k]?.bonus || 0,
            carriedIn: h.carriedIn || 0, carriedOut: h.carriedOut || 0,
            flagged: Math.round(h.flagged || 0), flags: [...new Set((h.flags || []).map((f) => f.type))],
            seen: h.seen ?? null, staleDecision: h.staleDecision || null, flaggedSince: Party.flaggedSince(h),
            ...(h.status === 'current' && h.flagged >= 0.5 ? { evidence: this.hourEvidence(u, h) } : {}),
          })),
          met: prog.met, missed: prog.missed, free: prog.free, review: prog.review,
        },
        totals: this.breakdown(result.totals),
        flags: {
          scoring,
          separateOveruse: posts.length > 0 && posts.filter((p) => p.privacy === 'separate').length * 2 > posts.length,
          idleMs,
          idle: idleMs > 10 * 60_000,
          atRisk: st.status === 'at-risk',
          review: prog.review,
        },
      };
    });
    const names = new Map(users.map((u) => [u.id, u.name]));
    const alerts = this.state.alerts.map((a) => {
      const name = names.get(a.userId) || '?';
      const un = this.undoFor(a.id, now);
      return {
        ...a, name, closed: !!a.ack || !!a.closedAt, text: this.alertText(a, name),
        typedWords: a.typedWords ?? a.credited ?? 0, countedWords: a.countedWords ?? a.credited ?? 0, notCountedWords: a.notCountedWords || 0,
        ...(un ? { undoId: un.id, undoUntil: un.until } : {}),
      };
    });
    summary.alertsOpen = alerts.filter((a) => !a.closed).length;
    summary.reviewsOpen = reviews.length;
    // SPEC §15: the approval queue, waiting first (oldest first), then declined (latest first).
    const pv = (u) => ({ id: u.id, name: u.name, username: u.username, message: u.approvalMessage ?? null, registeredAt: u.createdAt, messageAt: u.approvalMessageAt ?? null, approval: this.approvalOf(u), note: u.approvalNote ?? null, email: u.email ?? null });
    const waiting = users.filter((u) => this.approvalOf(u) === 'pending').sort((a, b) => a.createdAt - b.createdAt);
    const declined = users.filter((u) => this.approvalOf(u) === 'declined').sort((a, b) => (b.approvalAt || 0) - (a.approvalAt || 0));
    const pending = [...waiting, ...declined].map(pv);
    return {
      serverNow: now,
      rescoring: !!this.rescoring,
      party: { ...this.partyMeta(now), totals: this.totals(now, { credited: true }) },
      settings: { ...this.state.settings.scoring },
      staticNote: this.state.party.staticNote || '', // the static site's front-page note (hosts only)
      flagLabels: { ...FLAG_LABELS },
      settingLabels: { ...SETTING_LABELS },
      breaks: this.breaksView(now),
      summary,
      returning: all.filter((u) => !this.inRound(u) && !u.isAdmin).length, // accounts from earlier rounds that haven't joined this one
      pending,
      writers,
      reviews,
      alerts,
      log: this.state.log.slice(-300).map((l) => ({ ...l, name: l.userId ? names.get(l.userId) || '?' : null, byName: l.by ? names.get(l.by) || '?' : null })),
      counters: this.counters(now),
    };
  }

  hostWriter(adminId, userId) {
    this.requireAdmin(adminId);
    const u = this.userById(userId);
    if (!u) throw new HttpError(404, 'No such writer');
    const titles = new Map(this.postsOf(u.id).map((p) => [p.id, p.title || 'Untitled']));
    // Paste decisions, from the op log: what was pasted and which words the writer claimed.
    const pastes = [];
    for (const o of this.state.ops[u.id] || []) {
      const x = o[6];
      if (!x || typeof x.m !== 'string' || !o[5]) continue;
      const words = rawWords(o[5]);
      const wordy = words.map((w) => /[\p{L}\p{N}]/u.test(w.text));
      pastes.push({
        t: o[0], postTitle: titles.get(o[1]) || '?', pane: o[2] === 'n' ? 'notes' : 'body', decision: x.d,
        words: wordy.filter(Boolean).length,
        selected: words.filter((_, i) => wordy[i] && x.m[i] === '1').length,
        short: wordy.filter(Boolean).length <= this.S.pasteAskOverWords,
        text: o[5].length > 6000 ? o[5].slice(0, 6000) : o[5],
        m: x.m,
      });
    }
    return {
      id: u.id, name: u.name, username: u.username,
      freeHours: u.freeHours,
      posts: this.postsOf(u.id).map((p) => ({
        id: p.id, title: p.title, privacy: p.privacy, unlisted: p.unlisted, closed: p.closed, publicId: p.publicId,
        after: p.after ? p.after.log : [], // changes after the party, with their reasons (SPEC §30)
        added: !!p.after?.added, // started after the end
        body: p.body, notes: p.notes, words: countWords(p.body), notesWords: countWords(p.notes),
      })),
      pastes,
    };
  }

  // What the host looks at for an hour in review: big pastes and macro-sized
  // inserts in that hour, plus samples the text checks quoted.
  hourEvidence(u, h) {
    const out = [];
    for (const f of h.flags || []) if (f.sample) out.push({ kind: f.type, text: f.sample });
    for (const o of this.state.ops[u.id] || []) {
      if (o[0] < h.startAt || o[0] >= h.endAt || !o[5] || this.isAfterEnd(o)) continue;
      const x = o[6];
      if (x && x.s === 'move') continue; // a note moved into its place (SPEC §31): not new text
      const words = countWords(o[5]);
      const isPaste = !!(x && typeof x.m === 'string');
      if ((isPaste && words > this.S.pasteAskOverWords) || (!isPaste && words >= this.S.bulkInsertWords)) {
        out.push({ kind: isPaste ? 'paste' : 'insert', words, text: o[5].length > 600 ? `${o[5].slice(0, 600)}…` : o[5] });
      }
      if (out.length >= 6) break;
    }
    return out;
  }

  counters(now = this.now()) {
    let writing = 0;
    let wordsThisHour = 0;
    const nb = pauseBreaks(this.state.breaks);
    const hourMs = this.S.hourLengthMin * 60_000;
    for (const u of this.writers()) {
      if (u.lastOpAt && now - u.lastOpAt < 120_000) writing++;
      const r = this.scoreOf(u.id);
      if (!r) continue;
      const k = hourIndex(this.phase === 'ended' ? this.state.party.endedAt : now, this.anchorOf(u), nb, hourMs);
      if (r.hours[k]) wordsThisHour += r.hours[k].credit;
    }
    return { writing: this.phase === 'running' ? writing : 0, wordsThisHour: Math.round(wordsThisHour), posts: this.publicPosts().length };
  }

  // Posts the public may see right now (internal objects; never sent as is). Never a private
  // post (SPEC §26), at any time: the live page and its stream, post pages, the archive, the
  // Markdown export and the public totals all come from here.
  publicPosts() {
    const phase = this.phase;
    if (phase === 'lobby') return [];
    const all = Object.values(this.state.posts).filter((p) => p.privacy !== 'private' && !p.unlisted && this.isApproved(this.userById(p.ownerId)) && p.body.trim());
    if (phase === 'running') return all.filter((p) => p.privacy !== 'separate');
    return all;
  }
  publicName(p) {
    return p.privacy === 'named' ? publicDisplayName(this.userById(p.ownerId)?.name) || null : null; // never an email (SPEC §25)
  }
  // Group totals for the projector (cached briefly: the public stream asks every second).
  // wordsToday: the words on the page now (kept per post as ops arrive, so this is a cheap sum),
  // less the words from pastes the writer didn't confirm as written today (SPEC §13b: kept per
  // pane by the scorer, from each character's origin).
  // Public pages count only the posts they show (live and signed ones while it runs, everything
  // published after), so the total never moves with hidden writing; hosts get every post.
  // creditedToday (host only): words that have counted.
  // After the end: the total as it stood when the party ended (frozen in end()).
  wordsTodayNow(all) {
    let n = 0;
    for (const p of all ? Object.values(this.state.posts) : this.publicPosts()) {
      if (p.words > 0 && this.isApproved(this.userById(p.ownerId))) n += Math.max(0, p.words - this.engine.unconfirmedWords(p.ownerId, p.id, 'b'));
    }
    // SPEC §20c. foodBase: words their answers already had when this round opened (lib/rounds.js).
    for (const u of Object.values(this.state.users)) if (u.food && this.isApproved(u) && (this.inRound(u) || u.isAdmin)) n += Math.max(0, foodWordsOf(u.food) - (Number.isFinite(u.foodBase) ? u.foodBase : 0));
    return n;
  }
  totals(now = this.now(), { credited = false } = {}) {
    const ew = this.phase === 'ended' ? this.state.party.endWords : null;
    const wordsToday = ew ? (credited ? ew.all : ew.pub) : this.wordsTodayNow(credited);
    let c = this.totalsCache;
    if (!(c && c.rev === this.engineRev && now - c.at < 2000 && now >= c.at)) {
      let words = 0;
      let met = 0;
      let writing = 0;
      for (const u of this.writers()) {
        if (u.lastOpAt && now - u.lastOpAt < 120_000) writing++;
        const pr = this.progressOf(u.id, { now });
        if (!pr) continue;
        words += pr.result.totals.credit || 0;
        met += pr.prog.met;
      }
      c = this.totalsCache = { at: now, rev: this.engineRev, credited: Math.round(words), met, writing };
    }
    const v = { wordsToday, hoursMetToday: c.met, writingNow: this.phase === 'running' ? c.writing : 0 };
    return credited ? { ...v, creditedToday: c.credited } : v;
  }
  // The challenge's rules as help and the lobby describe them, for visitors who aren't signed in
  // (writers see the same numbers in their own view). Rules only: no people, no counts.
  publicRules() {
    const keys = ['targetPerHour', 'hourLengthMin', 'settleSec', 'pasteAskOverWords', 'shortPastesCount', 'freePassesPerWriter', 'carryOverMax',
      'missedHourOutcome', 'hoursMode', 'syncMinute', 'minFirstHourMin', 'bigPasteWords', 'reviewBigPastes', 'cutWeight',
      'cutMatureMin', 'cutCapPerHour', 'ownCutWindowMin', 'speedCapWpm', 'dictationCapWpm', 'contextWords', 'reuseWindowMin',
      'approvalRequired', 'personalTargets'];
    const out = {};
    for (const k of keys) if (this.S[k] !== undefined) out[k] = this.S[k];
    return out;
  }
  // Live page: posts newest activity first. No ids, timestamps or names beyond the opt-ins.
  liveView() {
    const now = this.now();
    const posts = this.phase === 'running'
      ? this.publicPosts().sort((a, b) => (b.activeAt || 0) - (a.activeAt || 0))
      : [];
    const br = breakAt(now, this.state.breaks);
    const next = this.state.breaks.filter((b) => b.startAt > now).sort((a, b) => a.startAt - b.startAt)[0] || null;
    const pb = (b) => (b ? { label: b.label, startAt: b.startAt, endAt: b.endAt, mode: breakModeOf(b) } : null);
    return {
      party: {
        name: this.state.party.name, phase: this.phase, break: br ? { label: br.label, endAt: br.endAt, mode: breakModeOf(br) } : null,
        joinUrl: this.publicUrl, plannedEnd: this.state.party.plannedEnd ?? null, plannedStart: this.plannedStart(),
        breaks: { active: pb(br), next: pb(next) },
        totals: this.totals(now),
        ...this.hourMeta(now),
        rules: this.publicRules(),
      },
      // No credited-words count here: it includes notes and unpublished posts (SPEC §26).
      counters: (({ wordsThisHour, ...c }) => c)(this.counters(now)),
      posts: posts.map((p) => ({
        id: p.publicId, title: p.title, name: this.publicName(p), text: p.body,
        active: !!p.activeAt && now - p.activeAt < 8000,
      })),
    };
  }
  // After the end: every published post, in a random order fixed at the end, no timestamps.
  archiveView() {
    if (this.phase !== 'ended') return { party: { name: this.state.party.name, phase: this.phase, round: this.round }, rounds: this.roundNames(), posts: [] };
    const { name, archiveOrder } = this.state.party;
    return this.anthology(this.publicPosts(), archiveOrder, this.participants(), { name, phase: this.phase, round: this.round }, (p) => countWords(p.body), afterNote);
  }
  // An anthology's contents: `posts` (the published ones) in the order fixed at the end.
  anthology(posts, archiveOrder, participants, party, wordsOf, noteOf, excerptOf = (p) => excerpt(p.body)) {
    const order = new Map((archiveOrder || []).map((id, i) => [id, i]));
    // Signed pieces their writers starred first (SPEC §28b), each group in the order shuffled at the
    // end (posts published later after it). Only signed posts: a star on an unsigned or separate
    // post moving it next to its writer's signed ones would tie them to that writer. Which ones are
    // starred is never sent: only the order shows.
    const lead = (p) => (p.starred && p.privacy === 'named' ? 1 : 0);
    posts.sort((a, b) => lead(b) - lead(a) || (order.get(a.publicId) ?? 1e9) - (order.get(b.publicId) ?? 1e9) || (a.publicId < b.publicId ? -1 : 1));
    const nStarred = posts.filter(lead).length;
    const rows = posts.map((p) => ({ id: p.publicId, title: p.title, name: this.publicName(p), words: wordsOf(p), excerpt: excerptOf(p), ...noteOf(p) }));
    return {
      party,
      rounds: this.roundNames(), // the earlier rounds' anthologies (lib/rounds.js); their times are in /api/session
      // Some pieces (not all) were starred, so they come first: the page says so.
      ...(nStarred && nStarred < posts.length ? { starredFirst: true } : {}),
      // Everyone approved who wrote anything (not the number of distinct authors of these posts,
      // which in a small party could tie posts together). `writers` is the same number.
      // Fewer than three writers: no count (it would all but name them).
      counters: { posts: posts.length, participants: participants >= 3 ? participants : null, writers: participants >= 3 ? participants : null, words: rows.reduce((s, r) => s + r.words, 0) },
      posts: rows,
    };
  }
  participants() {
    // (Writing after the end doesn't make someone a writer of the party.)
    return Object.values(this.state.users).filter((u) => this.isApproved(u) && (this.state.ops[u.id] || []).some((o) => !this.isAfterEnd(o))).length;
  }
  publicPost(publicId) {
    const p = this.publicPosts().find((x) => x.publicId === publicId);
    if (!p) {
      // A post of an earlier round keeps its address (lib/rounds.js).
      const hit = typeof publicId === 'string' ? this.pastByPublicId.get(publicId) : null;
      if (!hit || !this.isPastPublic(hit.p)) throw new HttpError(404, 'This post isn’t public (yet)');
      const { r, p: x } = hit;
      const profile = x.privacy === 'named' ? this.profileIdOf(this.userById(x.ownerId)) : null;
      return { id: x.publicId, title: x.title, name: this.publicName(x), text: x.body, words: x.words, phase: 'ended', party: r.name, round: r.n, past: true, profile, ...pastNote(x) };
    }
    // profile: a signed post's writer's page, when they're on the public list (SPEC §28); never
    // for an unsigned post.
    const profile = p.privacy === 'named' ? this.profileIdOf(this.userById(p.ownerId)) : null;
    return { id: p.publicId, title: p.title, name: this.publicName(p), text: p.body, words: countWords(p.body), phase: this.phase, party: this.state.party.name, round: this.round, profile, ...afterNote(p) };
  }

  // ------------------------------------------------------------ earlier rounds (lib/rounds.js)
  // Closed rounds are read-only: their posts' final texts, served by the same rules as an ended
  // party's (never private or hidden posts, nor those of an account that isn't approved now), with
  // names as their writers have them now (a signed post follows its writer's display name).
  setPastRounds(list) {
    this.pastRounds = (Array.isArray(list) ? list : []).map((r) => ({
      ...r,
      posts: r.posts.filter((p) => p && typeof p.id === 'string' && typeof p.publicId === 'string')
        .map((p) => ({ ...p, body: String(p.body || ''), notes: String(p.notes || ''), title: String(p.title || ''), words: countWords(String(p.body || '')) })),
      excerpts: new Map(), // publicId -> excerpt, made on first use
    }));
    this.pastByPublicId = new Map();
    for (const r of this.pastRounds) for (const p of r.posts) this.pastByPublicId.set(p.publicId, { r, p });
  }
  isPastPublic(p) {
    return p.privacy !== 'private' && !p.unlisted && this.isApproved(this.userById(p.ownerId)) && !!p.body.trim();
  }
  pastRound(n) {
    return this.pastRounds.find((r) => r.n === n) || null;
  }
  // The earlier rounds, oldest first, for links to their anthologies: with their times (the
  // session and host views, like the current party's), or without (the anthology carries no times).
  roundsList() {
    return this.pastRounds.map((r) => ({ n: r.n, name: r.name, startedAt: r.startedAt ?? null, endedAt: r.endedAt ?? null }));
  }
  roundNames() {
    return this.pastRounds.map((r) => ({ n: r.n, name: r.name }));
  }
  // GET /api/archive?round=<n>: an earlier round's anthology, the same shape as archiveView().
  pastArchiveView(n) {
    const r = this.pastRound(n);
    if (!r) throw new HttpError(404, 'No such round');
    const posts = r.posts.filter((p) => this.isPastPublic(p));
    const excerptOf = (p) => {
      let e = r.excerpts.get(p.publicId);
      if (e === undefined) r.excerpts.set(p.publicId, (e = excerpt(p.body)));
      return e;
    };
    return this.anthology(posts, r.archiveOrder, r.participants, { name: r.name, phase: 'ended', round: r.n, past: true },
      (p) => p.words, pastNote, excerptOf);
  }
  // A writer's signed, published pieces from earlier rounds, newest round first (their page).
  pastSigned(u) {
    return this.pastRounds.slice().reverse().map((r) => ({
      round: r.n, name: r.name,
      posts: r.posts.filter((p) => p.ownerId === u.id && p.privacy === 'named' && this.isPastPublic(p))
        .sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0) || (b.createdAt ?? 0) - (a.createdAt ?? 0) || (b.order ?? 0) - (a.order ?? 0))
        .map((p) => ({ publicId: p.publicId, title: p.title, words: p.words, excerpt: excerpt(p.body), starred: !!p.starred })),
    })).filter((g) => g.posts.length);
  }
  // GET /api/me/past: your own posts from earlier rounds (every one, private included), newest round first.
  myPast(userId) {
    const u = this.requireUser(userId);
    return {
      round: this.round,
      rounds: this.pastRounds.slice().reverse().map((r) => ({
        n: r.n, name: r.name, startedAt: r.startedAt ?? null, endedAt: r.endedAt ?? null,
        posts: r.posts.filter((p) => p.ownerId === u.id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.createdAt ?? 0) - (b.createdAt ?? 0))
          .map((p) => ({ id: p.id, title: p.title, privacy: p.privacy, words: p.words, hasNotes: !!p.notes.trim(), publicId: this.isPastPublic(p) ? p.publicId : null, ...pastNote(p) })),
      })).filter((g) => g.posts.length),
    };
  }
  // GET /api/me/past/post?round=<n>&id=<post id>: one of them in full (404 unless it's yours).
  myPastPost(userId, n, postId) {
    const u = this.requireUser(userId);
    const r = this.pastRound(n);
    const p = r && r.posts.find((x) => x.id === postId && x.ownerId === u.id);
    if (!p) throw new HttpError(404, 'No such post');
    return { round: r.n, roundName: r.name, id: p.id, title: p.title, body: p.body, notes: p.notes, privacy: p.privacy, words: p.words, publicId: this.isPastPublic(p) ? p.publicId : null, ...pastNote(p) };
  }

  // ------------------------------------------------------------ the public list of writers (SPEC §28)
  // Opt-in, by the person themself (Your account, lib/accounts.js), off by default; hosts can't
  // set it for anyone. A writer on it has a page id: random (not derived from the account, the
  // name or anything else), made at the first opt-in and kept, so a link they shared works again
  // if they come back. Shown: the public form of the display name, hours met of hours judged,
  // and whether they're out; on their page, also the posts they signed. Never usernames, emails,
  // food, notes, per-hour numbers, or anything about their anonymous, separate or private posts.
  profileIdOf(u) {
    const pp = u && isPlainObject(u.publicProfile) ? u.publicProfile : null;
    return pp && pp.on === true && typeof pp.id === 'string' && this.isApproved(u) && publicDisplayName(u.name) ? pp.id : null;
  }
  // SPEC §28b: a writer stars their own post so it comes first on their personal page. Any post
  // may carry a star, kept through privacy changes; only a signed, published post of a writer on
  // the list ever shows it, and only on that page. Not an edit of the post: it works before and
  // after the end, and only the writer sets it (by `postId`, or `publicId` from their page).
  setStar(userId, body) {
    const u = this.requireUser(userId);
    if (!isPlainObject(body) || typeof body.starred !== 'boolean') throw new HttpError(400, 'starred must be true or false', { code: 'starred' });
    let p = null;
    if (typeof body.postId === 'string') p = this.requirePost(userId, body.postId);
    else if (typeof body.publicId === 'string' && body.publicId) p = this.postsOf(userId).find((x) => x.publicId === body.publicId) || null;
    if (!p) throw new HttpError(404, 'No such post');
    if (!!p.starred !== body.starred) {
      if (body.starred) p.starred = true;
      else delete p.starred;
      // A signed post's page (and after the end the anthology's order, SPEC §28b) changes at once;
      // a star on any other post shows nowhere public.
      if (p.privacy === 'named') this.publicRev++;
      this.touch();
    }
    const page = this.profileIdOf(u);
    return { starred: !!p.starred, listed: !!page, page };
  }
  setPublicProfile(userId, on) {
    const u = this.requireUser(userId);
    if (typeof on !== 'boolean') throw new HttpError(400, 'Bad request');
    const cur = isPlainObject(u.publicProfile) ? u.publicProfile : null;
    if ((cur?.on === true) === on) return cur;
    let id = typeof cur?.id === 'string' ? cur.id : null;
    while (!id || Object.values(this.state.users).some((x) => x !== u && x.publicProfile?.id === id)) id = randomId(12);
    u.publicProfile = { on, id };
    this.publicRev++; // the list, the pages and signed post pages rebuild at once
    this.addLog('public-list', { userId: u.id, text: on ? 'joined the public list of writers' : 'left the public list of writers' });
    this.touch();
    return u.publicProfile;
  }
  // When the public numbers are read. With synced hours everyone's hours end together, on the
  // clock grid: now. With personal hours each writer's hours end at minutes of their own, and
  // numbers moving at those minutes would show when each one started writing (and so which new
  // anonymous post on the live page was theirs), so they're read as of the last full hour on
  // the party clock; after the end, once every hour has settled, as of now.
  publicAsOf(now = this.now()) {
    const { startedAt, endedAt } = this.state.party;
    if (this.S.hoursMode === 'synced' || !Number.isFinite(startedAt)) return now;
    const settleMs = ((this.S.settleSec || 0) + (this.S.settleQuantumSec || 0)) * 1000;
    if (this.phase === 'ended' && Number.isFinite(endedAt) && now >= endedAt + settleMs + 60_000) return now;
    return Math.min(now, Math.max(startedAt, gridAnchor(now, 0, this.tz)));
  }
  // { id, name, met, judged, out, left }: hours met of the hours judged (met or missed: free hours and
  // hours still waiting for the host's review are neither), as of `asOf`.
  writerSummary(u, asOf, factors) {
    const pr = u.joinedAt ? this.progressOf(u.id, { now: asOf, factors }) : null;
    const met = pr ? pr.prog.met : 0;
    const out = !!u.out && (Number.isFinite(u.outAt) ? u.outAt <= asOf : true);
    const left = leavePeriods(u).some((p) => p.at <= asOf && !(Number.isFinite(p.backAt) && p.backAt <= asOf)); // SPEC §33, as of the same time
    return { id: u.publicProfile.id, name: publicDisplayName(u.name), met, judged: met + (pr ? pr.prog.missed : 0), out, left };
  }
  // GET /api/writers: everyone on the list (approved accounts only), by name.
  writersView(now = this.now()) {
    const asOf = this.publicAsOf(now);
    const factors = this.factors(asOf);
    const writers = Object.values(this.state.users).filter((u) => this.profileIdOf(u) && this.inRound(u)).map((u) => this.writerSummary(u, asOf, factors)); // this round's writers only
    writers.sort((a, b) => NAME_ORDER.compare(a.name, b.name) || (a.id < b.id ? -1 : 1));
    return { party: { name: this.state.party.name, phase: this.phase }, writers };
  }
  // GET /api/w/<id>: one writer's line plus the posts they signed that are published now (the
  // same filters as every public page: never hidden, private or unpublished): the ones they
  // starred first (SPEC §28b), each group newest first.
  // 404, the same answer, for an unknown id and for someone who isn't on the list (left it, or
  // isn't approved), so a page id can't be probed.
  writerPageView(profileId, now = this.now()) {
    const u = typeof profileId === 'string' && profileId ? Object.values(this.state.users).find((x) => x.publicProfile?.id === profileId) : null;
    if (!u || this.profileIdOf(u) !== profileId) throw new HttpError(404, 'Not found');
    const asOf = this.publicAsOf(now);
    const posts = this.publicPosts().filter((p) => p.ownerId === u.id && p.privacy === 'named')
      .sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0) || (b.createdAt ?? 0) - (a.createdAt ?? 0) || (b.order ?? 0) - (a.order ?? 0)); // starred first (SPEC §28b)
    return {
      party: { name: this.state.party.name, phase: this.phase, round: this.round },
      ...this.writerSummary(u, asOf, this.factors(asOf)),
      inRound: this.inRound(u), // not writing in this round: their page shows their earlier pieces only
      posts: posts.map((p) => ({ publicId: p.publicId, title: p.title, words: countWords(p.body), excerpt: excerpt(p.body), starred: !!p.starred })),
      past: this.pastSigned(u), // earlier rounds (lib/rounds.js): [{ round, name, posts }]
    };
  }

  // ------------------------------------------------------------ export
  exportJson(adminId) {
    this.requireAdmin(adminId);
    const st = this.state;
    const users = Object.values(st.users).map(({ passHash, customCss, ...u }) => { // custom CSS is the person's own (SPEC §32)
      const r = u.joinedAt ? this.scoreOf(u.id, { fresh: true }) : null;
      return { ...u, score: r ? { totals: r.totals, hours: r.hours, flags: r.flags } : null };
    });
    return {
      exportedAt: this.localStamp(this.now()),
      tz: this.tz,
      party: st.party,
      settings: st.settings,
      users,
      posts: Object.values(st.posts),
      breaks: st.breaks,
      alerts: st.alerts,
      log: st.log,
      ops: st.ops,
    };
  }
  exportMarkdown(adminId) {
    this.requireAdmin(adminId);
    const st = this.state;
    const order = new Map((st.party.archiveOrder || []).map((id, i) => [id, i]));
    // Published posts only: separate-identity posts once the party has ended, never before.
    const posts = this.publicPosts();
    posts.sort((a, b) => (order.get(a.publicId) ?? 1e9) - (order.get(b.publicId) ?? 1e9) || (a.publicId < b.publicId ? -1 : 1));
    let md = `# ${st.party.name}\n\n${posts.length} posts.\n`;
    for (const p of posts) {
      md += `\n---\n\n## ${p.title || 'Untitled'}\n\n`;
      const name = this.publicName(p);
      if (name) md += `*by ${name}*\n\n`;
      md += `${p.body.trim()}\n`;
    }
    return md;
  }
}

// The public list of writers is in name order, whatever the case and accents (SPEC §28).
const NAME_ORDER = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

function excerpt(text, max = 320) {
  // Headings dropped; a line break inside running text shows as " / " (as when quoting verse).
  let plain = '';
  for (const raw of text.slice(0, 4000).split('\n')) {
    if (/^\s*#{1,6}\s/.test(raw)) continue;
    const l = raw.replace(/^\s*>\s?/, '').replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/[*_~`]+/g, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[\^[^\]\s]+\]:?/g, '').trim();
    if (!l) continue;
    if (!plain) plain = l;
    else plain += /[.!?…:;,"”’)]$/.test(plain) ? ` ${l}` : ` / ${l}`;
    if (plain.length > max + 40) break;
  }
  plain = plain.replace(/\s+/g, ' ');
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 40)).replace(/[\s.…,;:]+$/, '')}…`;
}
