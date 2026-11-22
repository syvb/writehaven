// Rounds: one site, one party after another (round 1, round 2, ...). A round is one party, lobby →
// running → ended. Closing an ended round (`node server.js --new-round`, with the server stopped,
// like --make-admin) freezes it under <state dir>/rounds/<n>/ and opens the next round in a fresh
// lobby, with the same accounts:
//
//   rounds/<n>/round.json        what the site serves from that round from then on: its name and
//                                times, the anthology's order, and every post's final text (the
//                                public pages filter it exactly as they did; a writer reads all
//                                of their own, private ones included, at /past)
//   rounds/<n>/state.json        the whole state as it stood at the close (texts replayed from the
//                                journal), for the record
//   rounds/<n>/state.json.ops/   the round's op journal, as it was
//
// Carried over: accounts (username, display name, password, email, host status, approval, the
// public-list page, custom CSS), sessions (people stay signed in), the scoring settings, the
// party's name, sign-ups open or closed, push subscriptions and notices (notify.json is the
// server's, untouched), and the food answers that stand from party to party: a new round clears
// the food order answers into the food history, as a host's food reset does (lib/food.js
// resetOrders), and the words left in someone's answers don't count again (user.foodBase).
// Started again: posts, the op log, hours, passes, reviews, breaks, alerts and the log.
// Images uploaded in a round stay (its posts link to them) but stop counting towards anyone's
// upload quota (uploads/index.json: `round` on each).
//
// The public side (lib/party.js): /api/archive?round=<n> and /archive/<n> is that round's
// anthology, /p/<id> finds a post in any round, a writer's page lists their signed pieces from
// every round, and /api/me/past is a writer's own posts from earlier rounds.

import fs from 'node:fs';
import path from 'node:path';
import { Party } from './party.js';
import { Journal } from './journal.js';
import { loadState, writeStateSync } from './store.js';
import { resetOrders, readSetup, foodWordsOf } from './food.js';

// Fields of a user record that belong to one round (lib/party.js register() and the writer's
// hours, passes, reviews and leaving): dropped at a new round, then the register() defaults.
export const ROUND_USER_KEYS = Object.freeze([
  'joinedAt', 'targetOverride', 'carryOverride', 'trustPastes', 'out', 'outAt', 'outReason', 'outAuto', 'outVia', 'extraPasses', 'freeHours',
  'reviews', 'reviewSeen', 'evaluatedThrough', 'lastOpAt', 'judged', 'bonusCredit', 'leftAt', 'leftBy', 'leaves',
  'foodMark', 'foodBase',
]);
// Top-level state that belongs to one round. Anything else (a later module's own keys) carries over.
const ROUND_STATE_KEYS = new Set(['party', 'settings', 'users', 'sessions', 'posts', 'ops', 'breaks', 'alerts', 'log', 'savedAt']);

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
export const roundOf = (state) => (Number.isInteger(state?.party?.round) && state.party.round > 0 ? state.party.round : 1);
export const roundsDirOf = (stateFile) => path.join(path.dirname(path.resolve(stateFile)), 'rounds');

// The public note on a post changed after its party ended (lib/party.js afterNote).
const noteOf = (p) => (p.after?.added ? { added: true } : p.after?.edited ? { edited: true } : {});

// round.json for an ended round: `party` built from its state and journal (so texts are final).
export function roundRecord(party, { closedAt }) {
  const st = party.state;
  return {
    v: 1,
    n: roundOf(st),
    name: st.party.name,
    startedAt: st.party.startedAt ?? null,
    endedAt: st.party.endedAt ?? null,
    closedAt,
    endWords: st.party.endWords ?? null,
    participants: party.participants(),
    archiveOrder: Array.isArray(st.party.archiveOrder) ? st.party.archiveOrder : [],
    posts: Object.values(st.posts).map((p) => ({
      id: p.id, publicId: p.publicId, ownerId: p.ownerId, title: p.title || '', body: p.body || '', notes: p.notes || '',
      privacy: p.privacy, unlisted: !!p.unlisted, starred: !!p.starred, createdAt: p.createdAt ?? null, order: p.order ?? 0,
      ...noteOf(p),
    })),
  };
}

// The next round's state from an ended round's (not changed). `at`: the time of the change.
export function nextRoundState(state, { at }) {
  const n = roundOf(state);
  const users = structuredClone(state.users || {});
  // The food order answers go to the history and are cleared (lib/food.js, as a host's reset).
  resetOrders(Object.values(users), at, readSetup({ state }));
  for (const u of Object.values(users)) {
    for (const k of ROUND_USER_KEYS) delete u[k];
    Object.assign(u, {
      joinedAt: null, targetOverride: null, carryOverride: null, trustPastes: false, out: false, outAt: null, outReason: null, extraPasses: 0, freeHours: [],
      reviews: {}, evaluatedThrough: -1, lastOpAt: null,
    });
    // Food words already in their answers were written in an earlier round: neither their hours
    // (the credit mark) nor the words-today total count them again.
    const words = foodWordsOf(u.food);
    if (words > 0) {
      u.foodMark = words;
      u.foodBase = words;
    }
  }
  const next = {};
  for (const [k, v] of Object.entries(state)) if (!ROUND_STATE_KEYS.has(k)) next[k] = structuredClone(v);
  const old = state.party || {};
  Object.assign(next, {
    v: state.v ?? 1,
    party: {
      name: old.name || 'Writehaven', phase: 'lobby', startedAt: null, endedAt: null, archiveOrder: null,
      registrationOpen: old.registrationOpen !== false, plannedEnd: null, round: n + 1,
      ...(isObj(old.foodOrder) ? { foodOrder: structuredClone(old.foodOrder) } : {}),
      foodResetAt: at,
    },
    settings: structuredClone(state.settings || {}),
    users,
    sessions: structuredClone(state.sessions || {}),
    posts: {},
    breaks: [],
    alerts: [],
    log: [{ t: at, type: 'round', userId: null, by: null, text: `opened round ${n + 1}; round ${n} is in the archive` }],
  });
  return next;
}

// Every closed round under `dir`, oldest first, as stored (round.json). A round that can't be
// read is left out, with a line in the log: the rest of the site still works.
export function loadRounds(dir, { log = console } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const name of names) {
    if (!/^[1-9]\d{0,5}$/.test(name)) continue; // rounds/<n>.tmp: a close that didn't finish
    const file = path.join(dir, name, 'round.json');
    try {
      const r = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!isObj(r) || r.n !== Number(name) || !Array.isArray(r.posts)) throw new Error('not a round record');
      out.push(r);
    } catch (e) {
      log.error(`[rounds] ${file}: ${e.message}; round ${name} left out`);
    }
  }
  return out.sort((a, b) => a.n - b.n);
}

function copyDirSync(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, ent.name);
    const b = path.join(to, ent.name);
    if (ent.isDirectory()) copyDirSync(a, b);
    else if (ent.isFile()) {
      fs.copyFileSync(a, b);
      const fd = fs.openSync(b, 'r');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
  }
}
function writeJsonSync(file, value) {
  writeStateSync(file, value); // temp file, fsync, rename
}

// Close the ended round in `stateFile` and open the next one. The server must be stopped (it
// would overwrite the new state). Steps, each safe to stop after:
//   1. rounds/<n>.tmp/ gets round.json, the full state and a copy of the journal; renamed to
//      rounds/<n>/ once complete (the live files are untouched until then);
//   2. the next round's state goes to state.json.next, the journal moves aside to
//      state.json.ops.round-<n> and an empty one takes its place, state.json.next becomes
//      state.json, and the old journal is removed (its copy is in rounds/<n>/);
//   3. the round's images are marked in uploads/index.json.
// Throws (changing nothing) if the party hasn't ended or a close was left half-done.
export function closeRound({ stateFile, now = Date.now, log = console, tz = null }) {
  const file = path.resolve(stateFile);
  const dir = path.dirname(file);
  const opsDir = `${file}.ops`;
  const roundsDir = roundsDirOf(file);
  const raw = loadState(file, { log });
  if (!raw) throw new Error(`No state file at ${file}`);
  const n = roundOf(raw);
  const leftovers = [`${file}.next`, `${opsDir}.round-${n}`, path.join(roundsDir, `${n}.tmp`)].filter((f) => fs.existsSync(f));
  if (leftovers.length) throw new Error(`An earlier --new-round didn't finish; look at ${leftovers.join(', ')} first`);
  if (raw.party?.phase !== 'ended') throw new Error(`Round ${n} is ${raw.party?.phase === 'running' ? 'still running' : 'still in the lobby'}: end it from the host dashboard first`);
  const final = path.join(roundsDir, String(n));
  if (fs.existsSync(final)) throw new Error(`${final} already exists`);

  // The texts as the server would serve them: the state with the journal replayed.
  const journal = new Journal(opsDir, { log, fsync: true });
  const party = new Party({ state: raw, journal: journal.readAll({ repair: false }), journalFresh: !fs.existsSync(opsDir), log, tz });
  const at = Math.max(now(), (party.state.party.endedAt || 0) + 1);
  const record = roundRecord(party, { closedAt: at });
  const closedState = party.snapshot({ withOps: false });

  // 1. The archive of the round, complete before anything live changes.
  const tmp = path.join(roundsDir, `${n}.tmp`);
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  writeJsonSync(path.join(tmp, 'round.json'), record);
  writeJsonSync(path.join(tmp, 'state.json'), closedState);
  if (fs.existsSync(opsDir)) copyDirSync(opsDir, path.join(tmp, 'state.json.ops'));
  fs.renameSync(tmp, final);

  // 2. The next round.
  const next = nextRoundState(closedState, { at });
  writeJsonSync(`${file}.next`, next);
  if (fs.existsSync(opsDir)) fs.renameSync(opsDir, `${opsDir}.round-${n}`);
  fs.mkdirSync(opsDir, { recursive: true, mode: 0o700 });
  fs.renameSync(`${file}.next`, file);
  fs.rmSync(`${opsDir}.round-${n}`, { recursive: true, force: true });

  // 3. This round's images stop counting towards the next round's quotas.
  const indexFile = path.join(dir, 'uploads', 'index.json');
  let images = 0;
  if (fs.existsSync(indexFile)) {
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    for (const r of Object.values(isObj(index.files) ? index.files : {})) {
      if (isObj(r) && !Number.isInteger(r.round)) {
        r.round = n;
        images++;
      }
    }
    writeJsonSync(indexFile, index);
  }
  const shown = record.posts.filter((p) => p.privacy !== 'private' && !p.unlisted && p.body.trim()).length;
  return { closed: n, opened: n + 1, posts: record.posts.length, published: shown, users: Object.keys(next.users).length, images, dir: final };
}
