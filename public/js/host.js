// Host dashboard (/host), in the order a host needs it through the night: the party's name
// and phase with Start / End; alerts and hours waiting for review, each button saying what it
// does; a status line that filters; one compact row per writer, most urgent first, with a
// drawer per writer; and the controls: inviting writers (link, QR, sign-ups), breaks, scoring
// and the log. Data: GET /api/admin/state every 2 s.

import * as ui from './ui.js';
import { api } from './net.js';
import { renderMarkdown } from './md-render.js';

const { h, fill, clear, toast, modal, menu, fmtInt, fmtDur, plural } = ui;

// Writer statuses (server `status`): pill label, class, urgency rank, summary chip text.
const STATUS = {
  out: ['Out of the challenge', 'st-out', 0, (n) => `${n} out of the challenge`],
  review: ['To review', 'st-review', 1, (n) => `${n} to review`],
  // The running hour reaches its target only with flagged words: it will wait for your check.
  check: ['Needs your check', 'st-review', 1, (n) => `${n} to check this hour`],
  'at-risk': ['At risk', 'st-risk', 2, (n) => `${n} at risk`],
  'not-started': ['Not started', 'st-idle', 3, (n) => `${n} not started`],
  'on-track': ['On track', 'st-ok', 4, (n) => `${n} on track`],
  break: ['Paused (break)', 'st-break', 4, (n) => `${n} paused for the break`],
  free: ['Free hour', 'st-free', 5, (n) => (n === 1 ? '1 free hour' : `${n} free hours`)],
  // Left the party (SPEC §33): neutral, never "out"; their hours aren't judged until they're back.
  left: ['Left the party', 'st-ended', 5, (n) => `${n} left the party`],
  ended: ['Finished', 'st-ended', 6, (n) => `${n} finished`],
};
const CHIPS = ['on-track', 'break', 'at-risk', 'out', 'free', 'left', 'review', 'check', 'not-started'];
const SUMMARY_KEY = { 'not-started': 'notStarted', 'on-track': 'onTrack', 'at-risk': 'atRisk', out: 'out', free: 'free', break: 'break', review: 'review', check: 'check', left: 'left', ended: 'ended' };

// Scoring flags: a short label for the table, and what it means (writer drawer).
const FLAG = {
  gibberish: ['Keyboard mash', 'Letters that look like keyboard mashing.'],
  lorem: ['Placeholder text', 'Lorem ipsum placeholder text.'],
  wordSalad: ['Word salad', 'Words with almost none of the small words (the, of, and) that real sentences need.'],
  repetitive: ['Repetitive text', 'The same words over and over.'],
  bulkInsert: ['Text appeared at once', 'A block of 25 or more words arrived in one go without a paste, as from a text expander or a macro.'],
  steadyTyping: ['Machine-steady typing', '300 or more words typed with almost no pauses, as by an auto-typer or someone copying out a text.'],
  mostlyDeleted: ['Mostly deleted', 'Most of the hour’s counted words were deleted within 15 minutes.'],
  reusingWords: ['Reshuffled words', 'Many typed words re-use words they had deleted.'],
  bigPaste: ['Big paste', '100 or more pasted words that they said they wrote today.'],
  lateWork: ['Late offline work', 'Words written offline that reached the server after their hour had ended.'],
  otherWriter: ['Another writer’s text', 'Text matching another writer’s posts. It doesn’t count.'],
  speedCap: ['Over the speed limit', 'Typing faster than the speed limit; the excess doesn’t count.'],
  sustainedSpeed: ['Very fast for minutes', 'Very fast typing kept up for several minutes.'],
  recycledPhrases: ['Recycled phrases', 'Phrases recycled from their own earlier writing.'],
};
const QUIET = new Set(['speedCap', 'sustainedSpeed']); // information only: drawer, not table

// Words that don't count, for the drawer ("quick changes" cost nothing, so they're left out).
const NOT_COUNTED = {
  repeat: 'repeats of their own words', reused: 'retyped just-deleted words', wordEdits: 'edits inside words',
  otherWriter: 'another writer’s text', unconfirmedPaste: 'pastes they didn’t claim',
  shortPaste: 'short pastes', overSpeed: 'over the speed limit', overCutCap: 'over the cut limit', overPasteCap: 'over the paste limit',
};
const HOUR_WORD = {
  met: 'met', missed: 'missed', free: 'free hour', review: 'waits for your review', current: 'in progress',
  settling: 'just ended (settling)', partial: 'unfinished when the party ended', 'upcoming-free': 'free (coming up)',
  left: 'not judged (left)',
};

// Scoring settings: the three a host needs, then "Fine-tune scoring" with a plain line each.
// Hour length and personal targets aren't shown (testing / not recommended).
const MAIN = [
  { k: 'targetPerHour', label: 'Target per hour', unit: 'words', type: 'int', help: 'New words each writer needs every hour.' },
  { k: 'freePassesPerWriter', label: 'Free hours per writer', unit: 'each', type: 'int', help: 'Hours a writer can take off themselves (“Take this hour off”).' },
  { k: 'carryOverMax', label: 'Carry extra words to the next hour, up to', unit: 'words', type: 'int', optional: true, help: 'Words over an hour’s target count toward the next hour too (flagged words only once you count them). 0: nothing carries.' },
  { k: 'missedHourOutcome', label: 'When a writer misses an hour', type: 'enum', options: [['out', 'They’re out, and you get an alert'], ['alert-only', 'You get an alert; nobody is out']] },
  // Synced hours (SPEC §17): shown once the server reports the setting; options and help are filled in from the settings.
  { k: 'hoursMode', label: 'Hours', type: 'enum', optional: true, options: [['synced', 'Synced to the clock'], ['personal', 'Personal']] },
];
const FINE = [
  { k: 'settleSec', label: 'A word counts after', unit: 'seconds', type: 'num', help: 'How long a word must stay on the page, so typos and autocorrect never matter.' },
  { k: 'pasteAskOverWords', label: 'Ask about pastes longer than', unit: 'words', type: 'int', help: 'Longer pastes ask “Did you write this today?”. Shorter ones count like typing.' },
  { k: 'bigPaste', label: 'Review an hour that needs', unit: 'pasted words', type: 'num?', placeholder: 'never', help: 'An hour that reaches the target only with this many pasted words waits for your review. Empty: never.' },
  { k: 'cutWeight', label: 'Cutting old text earns', unit: 'per word cut', type: 'num', help: '0.5 is half a word per word cut. It’s taken back if the text returns.' },
  { k: 'cutMatureMin', label: 'Only text older than', unit: 'minutes', type: 'num', help: 'Cutting newer text earns nothing.' },
  { k: 'cutCapPerHour', label: 'Cut credit per hour, at most', unit: 'words', type: 'num?', placeholder: 'half the target', help: 'Empty: half the target.' },
  { k: 'contextWords', label: 'Repeat check', unit: 'words in a row', type: 'int', help: 'A run this long that a writer was already credited for doesn’t count again.' },
  { k: 'reuseWindowMin', label: 'Retyping deleted words earns nothing for', unit: 'minutes', type: 'num', help: 'Words deleted and typed again within this time count once.' },
  { k: 'ownCutWindowMin', label: 'Pasting back cut text earns nothing for', unit: 'minutes', type: 'num', help: 'Pasting words they cut within this time adds nothing.' },
  { k: 'pasteCapPerHour', label: 'Pasted words per hour, at most', unit: 'words', type: 'num?', placeholder: 'no limit', help: 'Empty: no limit.' },
  { k: 'speedCapWpm', label: 'Typing speed limit', unit: 'words a minute', type: 'num', help: 'Typing faster than this doesn’t count. Pastes are exempt.' },
  { k: 'dictationCapWpm', label: 'Dictation speed limit', unit: 'words a minute', type: 'num', help: 'The same for dictation, which inserts whole words quickly.' },
  { k: 'shortPastesCount', label: 'Short pastes count like typing', type: 'bool', help: 'Off: pastes too short to ask about count nothing.' },
  { k: 'syncMinute', label: 'Synced hours start at', unit: 'minutes past the hour', type: 'int', optional: true, help: '0: hours run 19:00–20:00. 30: 19:30–20:30.' },
  { k: 'minFirstHourMin', label: 'Shortest first hour', unit: 'minutes', type: 'int', optional: true, help: 'A writer who arrives with less of the hour left gets the next hour added to their first one; a shorter first hour has a pro-rated target.' },
  { k: 'maxUsers', label: 'Sign-ups allowed', unit: 'writers', type: 'int', help: 'New sign-ups are refused beyond this number.' },
];
const SETTING_LABEL = Object.fromEntries([...MAIN, ...FINE].map((f) => [f.k, f.label]));

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'They';
const hourCount = (n) => (n === 1 ? '1 hour' : `${fmtInt(n)} hours`);
const postsGo = (n) => (n === 1 ? '1 post goes' : `${fmtInt(n)} posts go`);

export async function mountHost(root, { session }) {
  if (!session?.user?.isAdmin) {
    fill(root, h('div', { class: 'l-page' }, h('h1', null, 'Not found'), h('p', null, h('a', { href: '/' }, 'Back'))));
    return;
  }
  let v = null;
  let skew = 0;
  let firstLoad = true;
  const myId = session.user.id;
  let offline = false;
  let filter = null; // a status key: the table shows only those writers
  let detailId = null; // the writer whose drawer is open
  let detail = null; // GET /api/admin/writer for that writer
  let detailAt = 0;
  let detailFrom = null; // focus returns here when the drawer closes
  let detailCheck = null; // the hour whose check the drawer was opened at (scrolled to once it's drawn)
  let draft = null; // unsaved scoring settings
  let lastUndo = null; // { id, until, userId, kind } of the last undoable action
  let setupOpen = null; // the setup card's open state once the party runs (null: closed)
  let qr = null; // ./qr.js once loaded (false: unavailable)
  let help = null; // ./help.js (SPEC §16) once loaded; the Help link shows only then
  let notifyMod = null; // ./notify.js (SPEC §22) once loaded: the composer and row checkboxes
  let foodMod = null; // ./food.js (SPEC §18, §20) once loaded: the Food card and drawer answers
  let foodAt = 0;
  let foodPerson = null; // { id, at, person } for the open drawer
  let uploadsOf = null; // { id, at, list } the open drawer's writer's images (GET /api/host/uploads)
  const picked = new Set(); // writer ids ticked in the table ("Selected" in the composer)
  // Open/closed state of collapsible parts, kept across re-renders (writers type, data changes).
  const opened = new Set();
  const sticky = (el, id) => {
    if (opened.has(id)) el.open = true;
    el.addEventListener('toggle', () => (el.open ? opened.add(id) : opened.delete(id)));
    return el;
  };
  const seen = new Set();
  const seenEarly = new Set(); // "will need your check" items already chimed for (writer:hour)
  const brk = { label: 'Dinner break', len: '30', at: '' };
  let breakModes = null; // does the server keep a mode per break (SPEC §19)? null: not known yet
  const now = () => Date.now() + skew;

  // ---------------------------------------------------------------- times (SPEC §24)
  // Every time on screen is the browser's local time (en-GB, 24 h) from epoch ms. The party's
  // zone (WH_TZ) is used only to line synced hours up with the clock, as the server does.
  const localTime = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const clock = (ms) => (Number.isFinite(ms) ? localTime.format(ms) : '');
  // Server text that mentions a time carries a placeholder and the time as epoch ms (SPEC §24):
  // statusReason "first hour until {t}" + statusReasonAt. An
  // object form { text, t, … } is read too. Plain strings pass through.
  function txt(x, at = null) {
    if (x === null || x === undefined) return '';
    if (typeof x !== 'object') {
      const str = String(x);
      return Number.isFinite(at) ? str.replace(/\{t\}/g, clock(at)) : str;
    }
    const text = String(x.text ?? x.template ?? '');
    const vals = { ...(x.args || {}), ...(x.params || {}), ...(x.values || {}), ...(x.times || {}), ...x };
    return text.replace(/\{(\w+)\}/g, (m, k) => {
      const val = vals[k];
      if (Number.isFinite(val) && val > 1e11) return clock(val); // epoch ms
      return val === undefined || val === null ? m : String(val);
    });
  }
  const zoneFmts = new Map();
  // Synced windows follow the party's clock; the host view no longer names its zone (SPEC §24), so
  // this is the browser's own zone, which lines up whenever both zones are whole hours from UTC.
  function zoneParts(ms) {
    const tz = v?.party?.tz || undefined;
    let f = zoneFmts.get(tz || '');
    if (!f) {
      const opts = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' };
      try {
        f = new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: tz });
      } catch {
        f = new Intl.DateTimeFormat('en-GB', opts);
      }
      zoneFmts.set(tz || '', f);
    }
    const o = {};
    for (const p of f.formatToParts(ms)) o[p.type] = Number(p.value);
    return o;
  }
  const zoneOffset = (ms) => {
    const p = zoneParts(ms);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
  };
  // "HH:MM" typed into a time box, in the browser's local time -> ms (today, or tomorrow if that
  // was more than 6 hours ago).
  // A start time from a time input: its next occurrence (later today, else tomorrow).
  function startToMs(hhmm) {
    const [hh, mm] = String(hhmm || '').split(':').map(Number);
    if (!Number.isInteger(hh) || !Number.isInteger(mm)) return null;
    const n = now();
    const d = new Date(n);
    d.setHours(hh, mm, 0, 0);
    if (d.getTime() <= n) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  // "12:00", "tomorrow at 12:00" or "Mon 23 Nov at 12:00", in this browser's days.
  function dayClock(ms) {
    const day = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
    const days = Math.round((day(ms) - day(now())) / 86_400_000);
    if (days === 0) return clock(ms);
    if (days === 1) return `tomorrow at ${clock(ms)}`;
    return `${new Date(ms).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} at ${clock(ms)}`;
  }
  function clockToMs(hhmm) {
    const [hh, mm] = String(hhmm || '').split(':').map(Number);
    if (!Number.isInteger(hh) || !Number.isInteger(mm)) return null;
    const n = now();
    const d = new Date(n);
    d.setHours(hh, mm, 0, 0);
    if (d.getTime() < n - 6 * 3600_000) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  // ---------------------------------------------------------------- data helpers
  const phase = () => v.party.phase;
  const writerById = (id) => v.writers.find((w) => w.id === id);
  // Account approval (SPEC §15): `pending` lists writers waiting for
  // the host ('pending') and recently declined ones. Absent until the server supports it.
  const queue = () => (Array.isArray(v?.pending) ? v.pending : []);
  const isWaiting = (p) => (p.approval || 'pending') === 'pending';
  const waitingList = () => (phase() === 'ended' ? [] : queue().filter(isWaiting));
  const queued = (id) => queue().some((p) => p.id === id);
  const signUps = () => v.writers.filter((w) => !w.isAdmin && !queued(w.id)).length;

  // Synced hours (SPEC §17): option labels and the one-line rule come
  // from the live settings. Without `hoursMode` from the server, hours are personal.
  const synced = () => v.settings.hoursMode === 'synced';
  // The minute synced hours turn over, on this browser's clock (the party's :MM in local time).
  const mm = () => `:${String(new Date(slotStart(now())).getMinutes()).padStart(2, '0')}`;
  const hoursOptions = () => [['synced', `Synced to the clock (everyone ${mm()}–${mm()})`], ['personal', 'Personal (each writer’s hour starts when they open the editor)']];
  function hoursRule(mode = v.settings.hoursMode) {
    if (mode !== 'synced') return 'Each writer’s hours start when they first open the editor, so late arrivals simply start later.';
    const s = v.settings;
    return `Everyone’s hours run ${mm()} to ${mm()} on the clock, and everyone writes from the moment they arrive. A first hour with at least ${s.minFirstHourMin ?? 20} minutes left is shorter, with a pro-rated target (half an hour: ${fmtInt(Math.round(s.targetPerHour / 2))} words); with fewer, the next hour is added to it.`;
  }
  // The shared hour windows in synced mode: clock hours from the party start, shifted by breaks
  // (the same arithmetic as lib/hours.js). Hour 1 is the window writing began in.
  const HOUR = 3600_000;
  function mergedBreaks() {
    const out = [];
    // Only breaks that pause the clock shift the windows (SPEC §19: 'reduce' keeps them on :MM).
    for (const b of breaks().filter((x) => x.endAt > x.startAt && modeOf(x) === 'pause')) {
      const last = out[out.length - 1];
      if (last && b.startAt <= last.endAt) last.endAt = Math.max(last.endAt, b.endAt);
      else out.push({ startAt: b.startAt, endAt: b.endAt });
    }
    return out;
  }
  function activeSince(t, from, nb) {
    if (!(t > from)) return 0;
    let a = t - from;
    for (const b of nb) {
      const s0 = Math.max(b.startAt, from);
      const e0 = Math.min(b.endAt, t);
      if (e0 > s0) a -= e0 - s0;
    }
    return a;
  }
  function realAt(a, from, nb) {
    let t = from;
    let rem = a;
    for (const b of nb) {
      if (b.endAt <= t) continue;
      if (b.startAt > t) {
        if (rem <= b.startAt - t) return t + rem;
        rem -= b.startAt - t;
      }
      t = b.endAt;
    }
    return t + rem;
  }
  // HH:MM (MM = syncMinute) at or before t, on the party clock.
  function slotStart(t) {
    const p = zoneParts(t);
    const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, v.settings.syncMinute ?? 0);
    const x = wall - zoneOffset(wall);
    return x > t ? x - HOUR : x;
  }
  // Window length: an hour, unless a test server compresses hours (hourLengthMin).
  const winMs = () => (v.settings.hourLengthMin || 60) * 60_000;
  // A first hour starting at `st` (SPEC §17b): the rest of its window, pro-rated, or, with fewer
  // than minFirstHourMin left, that rest plus the whole next window at the normal target.
  function firstWindow(st) {
    const H = winMs();
    const A = slotStart(st);
    const j = Math.floor((st - A) / H);
    const end = A + (j + 1) * H;
    const short = end - st >= (v.settings.minFirstHourMin ?? 20) * 60_000;
    return { end: short ? end : end + H, left: end - st, prorated: short && end - st < H };
  }
  // The party's shared hour now: hour 1 runs from the start; later hours are whole windows.
  function sharedHour(t = now()) {
    if (!synced() || !v.party.startedAt) return null;
    const st = v.party.startedAt;
    const nb = mergedBreaks();
    const origin = slotStart(st);
    const H = winMs();
    const a0 = activeSince(st, origin, nb);
    const k0 = Math.floor(a0 / H);
    const firstEnd = (k0 + 1) * H - a0 >= (v.settings.minFirstHourMin ?? 20) * 60_000 ? k0 + 1 : k0 + 2;
    const k = Math.floor(activeSince(t, origin, nb) / H);
    if (k < firstEnd) return { n: 1, startAt: st, endAt: realAt(firstEnd * H, origin, nb) };
    const out = { n: k - firstEnd + 2, startAt: realAt(k * H, origin, nb), endAt: realAt((k + 1) * H, origin, nb) };
    // The server's own next window start wins if this browser's zone is off by part of an hour.
    const d = Number.isFinite(v.party.nextHourAt) ? v.party.nextHourAt - out.endAt : 0;
    if (Math.abs(d) > 60_000 && Math.abs(d) < H) {
      out.startAt += d;
      out.endAt += d;
    }
    return out;
  }
  const breaks = () => (v.party.breaks || v.breaks || []).slice().sort((a, b) => a.startAt - b.startAt);
  const activeBreak = () => breaks().find((b) => b.status === 'active' || (b.startAt <= now() && now() < b.endAt && b.status !== 'ended'));
  const nextBreak = () => breaks().find((b) => b.startAt > now());
  // Break modes (SPEC §19): 'reduce' keeps the clock and lowers the
  // target of the hours it overlaps; 'pause' stops the clock. A break without a mode pauses.
  const BREAK_MODES = {
    reduce: ['Keep the clock, lower the target', () => (synced() ? `Hours stay on ${mm()}; this hour needs fewer words.` : 'Hours keep running; the hour it overlaps needs fewer words.')],
    pause: ['Pause the clock', () => 'Hours stop and resume after; later hours start later.'],
  };
  const modeOf = (b) => (b && b.mode === 'reduce' ? 'reduce' : 'pause');
  const defaultBreakMode = () => (synced() ? 'reduce' : 'pause');
  // This shared hour's target with the overlap of 'reduce' breaks taken off (synced hours): the
  // server's own number when writers carry it, else the same arithmetic as lib/hours.js.
  function reducedTarget(sh) {
    const seen = new Map();
    for (const w of v.writers) {
      const cur = w.progress?.current;
      if (!cur || w.targetOverride != null || Math.abs((cur.endAt || 0) - sh.endAt) > 60_000) continue;
      seen.set(cur.target, (seen.get(cur.target) || 0) + 1);
    }
    if (seen.size) return [...seen.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const H = winMs();
    let overlap = 0;
    for (const b of breaks()) if (modeOf(b) === 'reduce') overlap += Math.max(0, Math.min(b.endAt, sh.endAt) - Math.max(b.startAt, sh.startAt));
    return Math.max(0, Math.round(v.settings.targetPerHour * (H - overlap) / H));
  }
  const joinUrl = () => v.party.joinUrl || location.origin;
  const shownUrl = (u) => (qr?.displayUrl ? qr.displayUrl(u) : String(u).replace(/^https?:\/\//, '').replace(/\/$/, ''));
  const lastMiss = (id) => {
    const l = v.alerts.filter((a) => a.userId === id && a.kind === 'missed');
    return l[l.length - 1] || null;
  };

  // The status a row shows: the server's, except the host (not on the clock) and after the end.
  function statusView(w) {
    if (w.isAdmin && !w.joinedAt) return { key: 'host', label: 'Host', cls: 'st-host', reason: w.id === myId ? 'You. Not on the clock unless you write.' : 'Co-host. Not on the clock unless they write.' };
    if (phase() === 'ended') {
      const p = w.progress || {};
      // Hours that closed but still wait for the host's decision (they can be decided after the end).
      const rev = (p.hours || []).filter((x) => x.status === 'review').map((x) => x.k + 1);
      const revText = rev.length ? `${rev.length === 1 ? `Hour ${rev[0]}` : `Hours ${rev.slice(0, -1).join(', ')} and ${rev[rev.length - 1]}`} waiting for your review`
        : p.review ? `${hourCount(p.review)} waiting for your review` : '';
      if (w.out) {
        const why = w.outReason ? `${txt(w.outReason, w.outReasonAt).replace(/^./, (c) => c.toUpperCase())}.` : '';
        return { key: 'out', label: 'Out of the challenge', cls: 'st-out', reason: [why, revText ? `${revText}.` : ''].filter(Boolean).join(' ') };
      }
      if (!w.joinedAt) return { key: 'not-started', label: 'Didn’t start', cls: 'st-idle', reason: 'Never opened the editor.' };
      if (w.leftAt) {
        const done = [p.met ? `${hourCount(p.met)} met` : '', p.missed ? `${p.missed} missed` : '', p.free ? `${p.free} free` : ''].filter(Boolean).join(', ');
        return { key: 'left', label: 'Left the party', cls: 'st-ended', reason: `Left at ${clock(w.leftAt)}${done ? `, after ${done}` : ''}.${revText ? ` ${revText}.` : ''}` };
      }
      if (!p.met && !p.missed && !p.free) {
        if (revText) return { key: 'review', label: 'To review', cls: 'st-review', reason: `${revText}.` };
        return { key: 'ended', label: 'Finished', cls: 'st-ended', reason: 'Their first hour hadn’t finished when the party ended.' };
      }
      const bits = [`${hourCount(p.met || 0)} met`];
      if (p.missed) bits.push(`${p.missed} missed`);
      if (p.free) bits.push(`${p.free} free`);
      if (revText) bits.push(revText.replace(/^H/, 'h'));
      const every = !p.missed && !revText && p.met > 0;
      if (revText) return { key: 'review', label: 'To review', cls: 'st-review', reason: `${bits.join(', ')}.` };
      return { key: 'ended', label: every ? 'Every hour met' : 'Finished', cls: every ? 'st-ok' : 'st-ended', reason: `${bits.join(', ')}.` };
    }
    const eff = effStatus(w);
    if (eff === 'left') return { key: 'left', label: `Left at ${clock(w.leftAt)}`, cls: 'st-ended', reason: txt(w.statusReason, w.statusReasonAt) };
    const s = STATUS[eff] || [String(eff || '').replace(/^./, (c) => c.toUpperCase()).replace(/-/g, ' '), 'st-idle'];
    // A break that keeps the clock (SPEC §19) doesn't pause anyone.
    const keeps = eff === 'break' && modeOf(activeBreak()) === 'reduce';
    // The pill already says "Out of the challenge": the reason starts with the hour.
    let reason = txt(w.statusReason, w.statusReasonAt);
    if (w.status === 'out') reason = reason.replace(/^Out:\s*/, '').replace(/^./, (c) => c.toUpperCase());
    const n = hourNow(w);
    // Our own words when we judge differently from the server, or flagged words are in play.
    if (n && ['on-track', 'at-risk', 'check'].includes(eff) && (eff !== w.status || n.flagged >= 1)) reason = hourReason(n, eff);
    // During a break, "At risk" (or "Needs your check") stays visible next to it.
    const ak = alsoKey(w);
    const also = ak ? { key: ak, label: STATUS[ak][0], cls: STATUS[ak][1] } : null;
    if (also) reason = `${reason} ${ak === 'check' ? hourReason(n, 'check') : behindText(n, true)}`;
    return { key: eff, label: keeps ? 'On the break' : s[0], cls: keeps ? 'st-onbreak' : s[1], reason, also };
  }
  function rank(w) {
    if (w.isAdmin && !w.joinedAt) return 99;
    const ak = alsoKey(w); // on the break, but at risk or with a check coming: ranked with those
    return (STATUS[ak || effStatus(w)] || [0, 0, 4])[2];
  }

  // ---- the running hour, judged on the words that count for sure
  // The server's status counts flagged words in (a big paste looked "on track" all hour, then
  // the hour waited for review). Here: words that count for sure = counted words that aren't
  // flagged, plus words counting soon; flagged words count only after your check.
  const flagNoun = (types) => {
    const t = (types || []).filter((x) => !QUIET.has(x));
    if (t.length === 1 && t[0] === 'bigPaste') return ['pasted word', 'pasted words'];
    if (t.length === 1 && t[0] === 'lorem') return ['placeholder word', 'placeholder words'];
    if (t.length === 1 && t[0] === 'gibberish') return ['keyboard-mash word', 'keyboard-mash words'];
    return ['flagged word', 'flagged words'];
  };
  function hourNow(w) {
    if (phase() !== 'running') return null;
    const cur = w.progress?.current;
    if (!cur || cur.free) return null;
    const row = (w.progress.hours || []).find((x) => x.k === cur.k) || {};
    const { counted, soon, have } = hourWords(w, cur);
    // The hour's flagged words, and those still waiting for your check: none once your decision
    // applies (counted: they count; excluded: the server's counted words already leave them out).
    // An early decision stops applying when 5 or more words are flagged after it (staleDecision).
    const decision = row.decision || null;
    const allFlagged = Math.max(0, Math.round(row.flagged || 0));
    const flagged = decision ? 0 : Math.min(allFlagged, counted);
    const sure = Math.max(0, have - flagged);
    const need = cur.target;
    const left = Math.max(0, Math.ceil(need - sure));
    const pace = w.pace || null;
    const minutesLeft = Number.isFinite(pace?.minutesLeft) ? pace.minutesLeft : Math.max(0, (cur.endAt - now()) / 60_000);
    const writingMin = Number.isFinite(pace?.writingMinutesLeft) ? pace.writingMinutesLeft : minutesLeft;
    const perMin = left === 0 ? 0 : writingMin > 0 ? left / writingMin : null;
    const usual = Number.isFinite(pace?.usualPerMinute) ? pace.usualPerMinute : null;
    // The server's at-risk rule, on the sure words.
    const behind = left > 0 && (perMin === null || perMin > Math.max(12, 1.3 * (usual || 0)));
    const idle = pace?.idleMin ?? 0;
    const idleBehind = !behind && idle >= 15 && sure < 0.75 * need;
    return {
      w, cur, k: cur.k, need, counted, soon, have, flagged, allFlagged, decision, stale: row.staleDecision || null, since: row.flaggedSince || 0, seen: row.seen ?? null,
      evidence: row.evidence || [], types: row.flags || [], sure, left, minutesLeft, writingMin, perMin, usual, behind, idle, idleBehind,
    };
  }
  // The status we show while the party runs: the server's, re-judged on the sure words.
  function effStatus(w) {
    if (phase() !== 'running' || !['on-track', 'at-risk'].includes(w.status)) return w.status;
    const n = hourNow(w);
    if (!n) return w.status;
    if (needsCheck(n)) return 'check';
    if (n.behind || n.idleBehind) return 'at-risk';
    return n.flagged >= 1 ? 'on-track' : w.status;
  }
  // The hour reaches its target only with its flagged words: it will wait for your check.
  const needsCheck = (n) => !!n && n.flagged >= 1 && n.sure < n.need && n.have >= n.need;
  // A writer on a break whose hour still needs attention: 'check' or 'at-risk' (else null).
  function alsoKey(w) {
    if (w.out || effStatus(w) !== 'break') return null;
    const n = hourNow(w);
    if (!n) return null;
    if (needsCheck(n)) return 'check';
    return n.behind || n.idleBehind ? 'at-risk' : null;
  }
  const minutesText = (m) => `${Math.max(0, Math.round(m))} minute${Math.round(m) === 1 ? '' : 's'}`;
  function behindText(n, inBreak = false) {
    if (n.idleBehind && !n.behind) return `Idle for ${n.idle} minutes, ${fmtInt(n.sure)} of ${fmtInt(n.need)} so far.`;
    const usual = n.usual !== null ? `usually writes ${Math.round(n.usual)}` : 'no usual pace yet';
    if (n.writingMin < 0.5) return `Behind: ${fmtInt(n.left)} to go and no writing time left this hour.`;
    return `Behind: ${fmtInt(n.left)} to go in ${minutesText(n.writingMin)}${inBreak ? ' of writing time after the break' : ''}, ${Math.ceil(n.perMin)} a minute (${usual}).`;
  }
  function hourReason(n, eff) {
    const [one, many] = flagNoun(n.types);
    const fl = n.flagged >= 1 ? plural(n.flagged, one, many) : '';
    const again = fl && n.stale && n.since >= 1 ? `${plural(n.since, 'more word')} flagged since your decision. ` : '';
    if (eff === 'check') return `${again}${fl} count only if you say so (you can check them now). Without them: ${fmtInt(n.sure)} of ${fmtInt(n.need)}, ${minutesText(n.minutesLeft)} left.`;
    if (eff === 'at-risk') return `${again}${behindText(n)}${fl ? ` Not counting ${fl} that need your check.` : ''}`;
    if (n.sure >= n.need) return `${again}Hour ${n.k + 1} done: ${fmtInt(n.sure)} of ${fmtInt(n.need)}${fl ? `, without ${fl} (flagged, not needed)` : ''}.`;
    return `${again}${fmtInt(n.sure)} of ${fmtInt(n.need)}, ${minutesText(n.minutesLeft)} left${fl ? `; ${fl} count only if you say so` : ''}.`;
  }
  // The hour whose flagged words a row's "check" buttons open: the running one with words to
  // check, else the first hour waiting for review (null when there's nothing to check).
  function checkK(w) {
    const n = hourNow(w);
    if (n && n.flagged >= 1) return n.k;
    const r = (v.reviews || []).find((x) => x.userId === w.id);
    return r ? r.k : null;
  }
  function sortedWriters() {
    const byName = (a, b) => a.name.localeCompare(b.name);
    if (phase() !== 'running') return v.writers.slice().sort((a, b) => (a.isAdmin && !a.joinedAt) - (b.isAdmin && !b.joinedAt) || byName(a, b));
    return v.writers.slice().sort((a, b) => rank(a) - rank(b)
      || (rank(a) === 2 && rank(b) === 2 ? (hourNow(b)?.perMin ?? 0) - (hourNow(a)?.perMin ?? 0) : 0)
      || byName(a, b));
  }
  function localSummary() {
    const s = { writers: 0 };
    for (const w of v.writers) {
      if ((w.isAdmin && !w.joinedAt) || queued(w.id)) continue;
      s.writers++;
      for (const key of [effStatus(w), alsoKey(w)]) {
        const k = SUMMARY_KEY[key];
        if (k) s[k] = (s[k] || 0) + 1;
      }
    }
    return s;
  }
  const flagLabel = (t) => (FLAG[t] ? FLAG[t][0] : v.flagLabels?.[t] || t);

  // ---------------------------------------------------------------- dialogs, toasts, actions
  // A confirm dialog: ui.confirmDialog when present, else one built from ui.modal.
  function ask(opts) {
    if (typeof ui.confirmDialog === 'function') return ui.confirmDialog(opts);
    return new Promise((resolve) => {
      let done = false;
      const fin = (x) => {
        if (!done) {
          done = true;
          resolve(x);
        }
      };
      const paras = (x) => (x instanceof Node ? x : h('div', { class: 'modal-body' }, (Array.isArray(x) ? x : [x]).filter(Boolean).map((t) => (t instanceof Node ? t : h('p', null, t)))));
      modal({
        title: opts.title, body: opts.body ? paras(opts.body) : null, className: `modal-confirm ${opts.className || ''}`, onClose: () => fin(false),
        actions: [
          { label: opts.cancelLabel || 'Cancel', quiet: true, onClick: () => fin(false) },
          { label: opts.confirmLabel || 'OK', primary: !opts.danger, danger: !!opts.danger, onClick: () => fin(true) },
        ],
      });
    });
  }
  function undoToast(msg, res, userId, kind) {
    if (res?.undoId) lastUndo = { id: res.undoId, until: res.undoUntil || now() + 120_000, userId, kind };
    toast(msg, res?.undoId ? { action: { label: 'Undo', onClick: () => doUndo(res.undoId) }, ms: 12_000 } : {});
  }
  async function doUndo(id) {
    try {
      const r = await api('/api/host/undo', { id });
      if (lastUndo?.id === id) lastUndo = null;
      toast(r.undone === 'review-reject' ? 'Undone. The hour is back in your review queue.' : 'Undone. They’re back in.');
    } catch (e) {
      toast(e.status === 410 ? 'Too late to undo: it can be undone for 2 minutes.' : e.status === 404 ? 'There’s nothing to undo.' : e.message, { kind: 'error' });
    }
    await load();
  }
  async function act(path, body, okMsg) {
    try {
      const r = await api(path, body);
      if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg);
      await load();
      if (detailId) fetchDetail();
      return r;
    } catch (e) {
      toast(e.message, { kind: 'error' });
      return null;
    }
  }
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = h('textarea', { style: { position: 'fixed', top: '0', opacity: '0' } }, text);
      document.body.append(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch { /* no clipboard */ }
      ta.remove();
      return ok;
    }
  }

  // ---------------------------------------------------------------- layout
  const top = h('header', { class: 'h-top' });
  const endEl = h('section', { class: 'h-card h-endcard', hidden: true, 'aria-label': 'The party is over' });
  const needsEl = h('section', { class: 'h-needs', hidden: true, 'aria-label': 'Alerts' });
  const setupEl = h('section', { class: 'h-card h-setup', 'aria-label': 'Invite writers' });
  const summaryEl = h('div', { class: 'h-summary' });
  const tableWrap = h('div', { class: 'h-table-wrap' });
  const writersEl = h('section', { class: 'h-card h-writers', 'aria-label': 'Writers' },
    h('div', { class: 'h-writers-head' }, h('h2', null, 'Writers'), summaryEl), tableWrap);
  const breaksEl = h('section', { class: 'h-card h-breaks', 'aria-label': 'Breaks' });
  const settingsEl = h('section', { class: 'h-card h-settings', 'aria-label': 'Scoring' });
  const logEl = h('section', { class: 'h-card h-log', 'aria-label': 'Log' });
  const foodEl = h('section', { class: 'h-card h-food', hidden: true, 'aria-label': 'Food' });
  const mainCol = h('div', { class: 'h-main' }, writersEl, foodEl);
  const notifyEl = h('section', { class: 'h-card h-notify', hidden: true, 'aria-label': 'Send a message' });
  const sideCol = h('div', { class: 'h-col' }, notifyEl, breaksEl, settingsEl, logEl);
  const scrim = h('div', { class: 'h-scrim', hidden: true, onClick: () => closeDetail() });
  const drawer = h('aside', { class: 'h-drawer', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Writer details', tabindex: '-1' });
  const approvalEl = h('section', { class: 'h-approval', hidden: true, 'aria-label': 'Waiting for approval' });
  const app = h('div', { class: 'h-app' }, top, approvalEl, endEl, needsEl, h('div', { class: 'h-grid' }, mainCol, sideCol), scrim, drawer);
  fill(root, app);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && detailId && !document.querySelector('dialog[open]')) closeDetail();
  });

  const memo = new WeakMap();
  // Re-render a section only when what it shows changed, and never while the host types in it.
  function update(el, key, build) {
    const a = document.activeElement;
    if (a && el.contains(a) && a.matches('input, select, textarea')) return;
    if (memo.get(el) === key) return;
    memo.set(el, key);
    build();
  }

  async function load() {
    try {
      v = await api('/api/admin/state');
      skew = v.serverNow - Date.now();
      offline = false;
      render();
    } catch (e) {
      if (e.status === 401 || e.status === 403 || e.status === 404) {
        location.href = '/';
        return;
      }
      offline = true;
      if (v) renderTop();
    }
  }

  function render() {
    // The lobby is laid out around the invite card; once the party runs, the table is full width.
    app.className = `h-app is-${phase()}`;
    const open = v.alerts.filter((a) => !a.closed && !a.ack && !(a.kind === 'approval' && Array.isArray(v.pending))).length + waitingList().length;
    document.title = `${open ? `(${open}) ` : ''}Host: ${v.party.name}`;
    renderTop();
    renderApproval();
    renderEnd();
    renderNeeds();
    renderSetup();
    renderSummary();
    renderTable();
    renderBreaks();
    renderSettings();
    renderLog();
    renderFood();
    renderNotify();
    if (detailId) {
      renderDrawer();
      if (Date.now() - detailAt > 8000) fetchDetail();
    }
    firstLoad = false;
  }

  // ---------------------------------------------------------------- header
  function renderTop() {
    const p = v.party;
    const br = activeBreak();
    const nb = nextBreak();
    const perm = 'Notification' in window ? Notification.permission : 'na';
    const sh = p.phase === 'running' && (!br || modeOf(br) === 'reduce') ? sharedHour() : null;
    update(top, JSON.stringify([needsEmail(), p.name, p.phase, p.startedAt, p.endedAt, p.plannedEnd, p.plannedStart, Math.floor(now() / 3_600_000), br && [br.label, br.endAt, modeOf(br)], nb && [nb.label, nb.startAt], signUps(), waitingList().length, perm, offline, !!help, sh && [sh.n, sh.startAt, sh.endAt, Math.floor(now() / 60_000)], p.round, p.rounds?.length, v.returning]), () => {
      const nameIn = h('input', { class: 'h-name', value: p.name, 'aria-label': 'Party name (click to rename)', maxlength: 80, spellcheck: 'false' });
      nameIn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') nameIn.blur();
        if (e.key === 'Escape') {
          nameIn.value = p.name;
          nameIn.blur();
        }
      });
      nameIn.addEventListener('change', () => {
        const name = nameIn.value.trim();
        if (!name || name === p.name) {
          nameIn.value = p.name;
          return;
        }
        act('/api/admin/party', { name }, 'Party name saved');
      });
      let line;
      if (p.phase === 'lobby') line = [h('b', null, Number.isFinite(p.plannedStart) ? `Starts ${dayClock(p.plannedStart)}` : 'Not started'), ` · ${plural(signUps(), 'writer')} signed up`, waitingList().length ? ` · ${waitingList().length} waiting for approval` : ''];
      // The next round opens from the server (lib/rounds.js): this round's anthology stays.
      else if (p.phase === 'ended') {
        line = [h('b', null, `Ended at ${clock(p.endedAt)}`), ' · ', h('button', { class: 'btn-link', type: 'button', onClick: resumeParty }, 'Resume the party…'),
          ' · for the next round, stop the server and run ', h('code', null, 'node server.js --new-round')];
      }
      else if (br) {
        // "Dinner break until 19:00 · this hour's target 200" or "… · hours paused" (SPEC §19).
        const extra = modeOf(br) === 'pause' ? ' · hours paused' : sh ? ` · this hour’s target ${fmtInt(reducedTarget(sh))}` : ' · targets lowered for the break';
        line = [h('b', null, `${br.label} until ${clock(br.endAt)}`), extra];
      }
      else {
        // Synced hours: the shared clock first ("Hour 2 · 19:00–20:00 · 23 min left").
        line = sh ? [h('b', null, `Hour ${sh.n} · ${clock(sh.startAt)}–${clock(sh.endAt)} · ${fmtDur(sh.endAt - now())} left`), ` · running since ${clock(p.startedAt)}`]
          : [h('b', null, `Running since ${clock(p.startedAt)}`)];
        if (p.plannedEnd) line.push(` · planned end ${clock(p.plannedEnd)}`);
        if (nb) line.push(` · ${nb.label} at ${clock(nb.startAt)}`);
      }
      // Accounts from earlier rounds aren't in this one until they sign in and join it (lib/rounds.js).
      if (p.phase !== 'ended' && v.returning) line.push(` · ${plural(v.returning, 'writer')} from earlier rounds can join by signing in`);
      if (p.round > 1 || p.rounds?.length) line.unshift(h('b', null, `Round ${p.round}`), ' · '); // lib/rounds.js
      const phaseCls = br && p.phase === 'running' ? (modeOf(br) === 'reduce' ? 'phase-onbreak' : 'phase-break') : `phase-${p.phase}`;
      let primary = null;
      if (p.phase === 'lobby') primary = h('button', { class: 'btn btn-primary h-go', type: 'button', onClick: startParty }, 'Start the party…');
      else if (p.phase === 'running') primary = h('button', { class: 'btn h-end', type: 'button', onClick: endParty }, 'End the party…');
      else primary = h('a', { class: 'btn btn-primary h-go', href: '/archive', target: '_blank', rel: 'noopener' }, 'Read the anthology');
      const links = [
        p.phase !== 'ended' ? { label: 'Live page', href: '/live', blank: true } : null,
        { label: 'Projector', href: '/live?wall', blank: true },
        { label: 'Write', href: '/write' },
        // Earlier rounds (lib/rounds.js): their anthologies, and your own posts from them.
        p.rounds?.length ? { label: 'Earlier rounds', href: `/archive/${p.rounds[p.rounds.length - 1].n}`, blank: true } : null,
        p.rounds?.length ? { label: 'My earlier rounds', href: '/past', blank: true } : null,
        { label: 'Export everything (JSON)', href: '/api/admin/export.json', menuOnly: true },
        // Published posts only (the server leaves out separate-identity posts until the end).
        { label: 'Export published posts (Markdown)', href: '/api/admin/export.md', menuOnly: true },
        // The public site as plain HTML to host anywhere (lib/static-site.js): once a party has ended.
        p.phase === 'ended' || p.rounds?.length ? { label: 'Export the public site (static website, .zip)', href: '/api/admin/static-site.zip', menuOnly: true } : null,
        perm === 'default' && p.phase !== 'ended' ? { label: 'Turn on notifications', onClick: enableNotifications } : null,
        // Help opens at its host section ("Running the party"), with this page's settings.
        help ? { label: 'Help', onClick: () => help.openHelp('host', { settings: v.settings, role: 'host', partyName: v.party.name }), last: true } : null,
        // Hosts eat too (SPEC §18): their own answers, in the same sheet as everyone's.
        { label: 'Your food preferences…', onClick: () => import('./food.js').then((m) => m.openFoodSheet(), () => toast('You seem to be offline. Try again when you’re back.', { kind: 'warn' })), last: true },
        { label: needsEmail() ? 'Your account · add email' : 'Your account', onClick: () => editAccount({ id: myId, self: true }), last: true }, // SPEC §25, §25b
      ].filter(Boolean);
      const linkEl = (l) => (l.href
        ? h('a', { class: 'btn btn-quiet', href: l.href, ...(l.blank ? { target: '_blank', rel: 'noopener' } : {}) }, l.label)
        : h('button', { class: 'btn btn-quiet', type: 'button', onClick: l.onClick }, l.label));
      const exportBtn = h('button', { class: 'btn btn-quiet', type: 'button', 'aria-haspopup': 'menu' }, 'Export');
      exportBtn.addEventListener('click', () => menu(exportBtn, links.filter((l) => l.menuOnly).map((l) => ({ label: l.label, onClick: () => { location.href = l.href; } })), { align: 'right' }));
      const more = h('button', { class: 'btn btn-quiet h-more', type: 'button', 'aria-haspopup': 'menu' }, 'More');
      more.addEventListener('click', () => menu(more, links.map((l) => ({
        label: l.label,
        onClick: () => {
          if (l.onClick) l.onClick();
          else if (l.blank) window.open(l.href, '_blank', 'noopener');
          else location.href = l.href;
        },
      })), { align: 'right' }));
      fill(top,
        h('div', { class: 'h-top-left' }, nameIn,
          h('p', { class: `h-phase ${phaseCls}` }, ...line, offline ? h('span', { class: 'h-offline' }, ' · Can’t reach the server; retrying…') : null)),
        h('div', { class: 'h-top-right' }, primary,
          h('div', { class: 'h-top-links' }, links.filter((l) => !l.menuOnly && !l.last).map(linkEl), exportBtn, links.filter((l) => l.last).map(linkEl)),
          more));
    });
  }
  async function enableNotifications() {
    try {
      await Notification.requestPermission();
    } catch { /* not supported */ }
    memo.delete(top);
    renderTop();
  }

  async function startParty() {
    const n = signUps();
    let when = ['Each writer’s first hour starts when they open the editor, so late arrivals simply start later. Anyone with the page open starts now.'];
    if (synced()) {
      // Synced hours (SPEC §17b): writing starts now; say until when everyone's first hour runs.
      const { end, prorated } = firstWindow(now());
      const min = v.settings.minFirstHourMin ?? 20;
      when = [
        prorated
          ? `Writing starts now. Everyone’s first hour runs until ${clock(end)}, a shorter hour with a pro-rated target of ${plural(Math.round(v.settings.targetPerHour * ((end - now()) / winMs())), 'word')}. After that, hours run ${mm()} to ${mm()}.`
          : `Writing starts now. Everyone’s first hour runs until ${clock(end)}${end - now() > winMs() ? ` (fewer than ${min} minutes remain in this hour, so the next hour is added to it)` : ''}, with the usual target of ${plural(v.settings.targetPerHour, 'word')}.`,
        `Anyone who arrives later writes at once too: their first hour is the rest of the current one, or with fewer than ${min} minutes left, that plus the next hour.`,
      ];
    }
    const ok = await ask({
      title: 'Start the party?',
      body: [
        n ? `${plural(n, 'writer')} ${n === 1 ? 'has' : 'have'} signed up.` : 'Nobody has signed up yet.',
        Number.isFinite(v.party.plannedStart) ? `It’s set to start by itself ${dayClock(v.party.plannedStart)}; this starts it now instead.` : null,
        ...when,
        v.party.registrationOpen ? `Sign-ups stay open at ${shownUrl(joinUrl())}.` : 'Sign-ups are closed. You can open them again under “Invite writers”.',
      ],
      confirmLabel: 'Start now',
    });
    if (ok) act('/api/admin/start', {}, 'The party has started.');
  }
  // Take back the end (lib/party.js resume): the party runs again from now.
  async function resumeParty() {
    const gap = Math.max(0, now() - (v.party.endedAt || now()));
    const ok = await ask({
      title: 'Resume the party?',
      body: [
        `It runs again from now, with the same writers, posts and hours. The time since it ended (${fmtDur(gap)}) counts as a pause: no hour is missed in it, and each writer’s hour picks up where it stopped.`,
        'Edits writers made since the end count like writing during a break.',
        'The anthology closes again until you end the party.',
      ],
      confirmLabel: 'Resume the party',
    });
    if (ok) act('/api/admin/resume', {}, 'The party is back on.');
  }
  async function endParty() {
    const started = v.writers.filter((w) => w.joinedAt).length;
    const separate = v.writers.reduce((s, w) => s + (w.separate || 0), 0);
    const posts = (v.counters?.posts || 0) + separate;
    // What ending leaves open: hours waiting for your check stay unjudged until you decide them
    // (you can, after the end); running hours with flagged words end with the party, unjudged.
    const reviews = v.reviews || [];
    const checks = v.writers.filter((w) => !w.out && needsCheck(hourNow(w))).map(hourNow);
    // Alerts close at the end (they stay in the log); a review's own alert is the review above.
    const openAlerts = v.alerts.filter((a) => !a.closed && !a.ack && a.kind !== 'approval' && !(a.kind === 'review' && reviews.some((r) => r.userId === a.userId && r.k === a.k)));
    const names = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0] || '');
    const pending = [];
    if (reviews.length) {
      pending.push(h('p', { class: 'h-end-open' }, h('b', null, `${reviews.length === 1 ? '1 hour still waits' : `${reviews.length} hours still wait`} for your check: `),
        names(reviews.map((r) => `${r.name}, hour ${r.k + 1} (${plural(Math.round(r.flagged), 'flagged word')})`)),
        `. If you end now, ${reviews.length === 1 ? 'it stays' : 'they stay'} unjudged until you count or exclude the words, which you can still do after the end.`));
    }
    if (checks.length) pending.push(`${names(checks.map((n) => n.w.name))} ${checks.length === 1 ? 'has' : 'have'} flagged words in the hour that’s running. That hour ends with the party and isn’t judged.`);
    if (openAlerts.length) {
      const what = (a) => (a.kind === 'missed' ? `${a.name} missed hour ${a.k + 1}` : a.kind === 'review' ? `${a.name}, hour ${a.k + 1} to review` : a.name);
      pending.push(`${openAlerts.length === 1 ? 'An alert is' : `${openAlerts.length} alerts are`} still open (${names(openAlerts.slice(0, 6).map(what))}${openAlerts.length > 6 ? ', …' : ''}). ${openAlerts.length === 1 ? 'It closes' : 'They close'} at the end and ${openAlerts.length === 1 ? 'stays' : 'stay'} in the log.`);
    }
    const ok = await ask({
      title: started ? `End the party for all ${plural(started, 'writer')}?` : 'End the party?',
      cancelLabel: reviews.length ? 'Check them first' : 'Cancel',
      body: [
        ...pending,
        'Typing stops now for everyone. Hours in progress don’t count as missed.',
        posts
          ? `${postsGo(posts)} into the anthology${separate ? `, including ${plural(separate, 'separate-identity post')} that ${separate === 1 ? 'appears' : 'appear'} now, unlinked` : ''}. Anonymous posts stay anonymous.`
          : 'The anthology opens; there are no posts in it yet.',
        'This can’t be undone.',
      ],
      confirmLabel: reviews.length ? 'End the party anyway' : 'End the party', danger: true,
    });
    if (ok) act('/api/admin/end', {}, 'The party has ended. The anthology is open.');
    else if (reviews.length) needsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---------------------------------------------------------------- after the end
  function renderEnd() {
    const ended = phase() === 'ended';
    endEl.hidden = !ended;
    if (!ended) return;
    const ws = v.writers.filter((w) => w.joinedAt);
    const sum = (f) => ws.reduce((s, w) => s + (f(w) || 0), 0);
    const words = sum((w) => w.totals?.credit);
    const met = sum((w) => w.progress?.met);
    const missed = sum((w) => w.progress?.missed);
    const free = sum((w) => w.progress?.free);
    const review = sum((w) => w.progress?.review);
    const leftParty = ws.filter((w) => w.leftAt).length; // SPEC §33: left, not missed
    const posts = v.counters?.posts || 0;
    const dur = Math.max(0, (v.party.endedAt || 0) - (v.party.startedAt || 0));
    update(endEl, JSON.stringify([ws.length, words, met, missed, free, review, leftParty, posts, dur, v.party.totals?.wordsToday]), () => {
      const hours = [`${hourCount(met)} met`];
      if (missed) hours.push(`${missed} missed`);
      if (free) hours.push(`${free} free`);
      if (review) hours.push(`${review} waiting for your review (below)`);
      fill(endEl,
        h('h2', null, 'That’s the party.'),
        h('p', { class: 'h-end-lede' }, `The party ran for ${fmtDur(dur)}. ${plural(ws.length, 'writer')}${leftParty ? ` (${leftParty} left early)` : ''}: ${plural(words, 'word')} counted toward the hourly targets, ${hours.join(', ')}. ${posts === 1 ? '1 post is' : `${fmtInt(posts)} posts are`} in the anthology.`),
        Number.isFinite(v.party.totals?.wordsToday) ? h('p', { class: 'h-sub h-end-note' }, `The projector’s “words today” is a different count: the words on the pages it shows, counted toward the targets or not. On every page, hidden ones too: ${plural(v.party.totals.wordsToday, 'word')}.`) : null,
        h('div', { class: 'h-end-actions' },
          h('a', { class: 'btn btn-primary', href: '/archive', target: '_blank', rel: 'noopener' }, 'Read the anthology'),
          h('a', { class: 'btn', href: '/api/admin/static-site.zip' }, 'Download the public site (static website)'),
          h('a', { class: 'btn btn-quiet', href: '/api/admin/export.md' }, 'Download published posts (Markdown)'),
          h('a', { class: 'btn btn-quiet', href: '/api/admin/export.json' }, 'Download everything (JSON)')));
    });
  }

  // ---------------------------------------------------------------- alerts and reviews
  function notify(fresh) {
    chime();
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    for (const a of fresh) {
      try {
        const title = a.kind === 'review' ? `${a.name}: hour ${a.k + 1} needs your review`
          : a.kind === 'approval' ? `${a.name} is waiting for your approval` : `${a.name} missed hour ${a.k + 1}`;
        new Notification(title, { body: a.kind === 'approval' ? a.message || '' : txt(a.text) });
      } catch { /* not allowed here */ }
    }
  }
  function chime() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const t = ctx.currentTime;
      for (const [i, f] of [660, 880].entries()) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = f;
        o.type = 'sine';
        g.gain.setValueAtTime(0.0001, t + i * 0.18);
        g.gain.exponentialRampToValueAtTime(0.25, t + i * 0.18 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.18 + 0.5);
        o.connect(g).connect(ctx.destination);
        o.start(t + i * 0.18);
        o.stop(t + i * 0.18 + 0.55);
      }
      setTimeout(() => ctx.close().catch(() => {}), 1500);
    } catch { /* no audio */ }
  }

  function renderNeeds() {
    const running = phase() !== 'ended';
    // Approval requests are announced and shown by the approval card when the server lists them.
    const isOpen = (a) => !a.closed && !a.ack && !(a.kind === 'approval' && Array.isArray(v.pending));
    const fresh = v.alerts.filter((a) => isOpen(a) && !seen.has(a.id));
    for (const a of v.alerts) seen.add(a.id);
    if (fresh.length && !firstLoad && running) notify(fresh);
    const reviews = v.reviews || []; // hours left in review can still be decided after the end
    const open = running ? v.alerts.filter((a) => isOpen(a) && !(a.kind === 'review' && reviews.some((r) => r.userId === a.userId && r.k === a.k))) : [];
    // Hours still running that would wait for your check if they ended now: raised in the last
    // 15 minutes (around :45), so there's time to act; a chime the first time.
    // Also at once when more words were flagged after an early decision (asked again).
    const early = running ? v.writers.filter((w) => {
      const n = hourNow(w);
      return !w.out && needsCheck(n) && (n.minutesLeft <= 15 || (n.stale && n.since >= 1));
    }).map(hourNow) : [];
    const earlyKey = (n) => `${n.w.id}:${n.k}:${n.stale ? n.seen : ''}`;
    const freshEarly = early.filter((n) => !seenEarly.has(earlyKey(n)));
    for (const n of early) seenEarly.add(earlyKey(n));
    if (freshEarly.length && !firstLoad) {
      chime();
      if ('Notification' in window && Notification.permission === 'granted') {
        for (const n of freshEarly) {
          try {
            new Notification(n.stale ? `${n.w.name}: ${plural(n.since, 'more word')} flagged since your decision` : `${n.w.name}’s hour ${n.k + 1} will need your check`, { body: `${plural(n.flagged, ...flagNoun(n.types))} count only if you say so. Without them: ${fmtInt(n.sure)} of ${fmtInt(n.need)}.` });
          } catch { /* not allowed here */ }
        }
      }
    }
    needsEl.hidden = !open.length && !reviews.length && !early.length;
    if (needsEl.hidden) {
      memo.delete(needsEl);
      clear(needsEl);
      return;
    }
    const t = now();
    const key = JSON.stringify([
      open.map((a) => [a.id, txt(a.text), !!(a.undoId && a.undoUntil > t), !!writerById(a.userId)?.out]),
      reviews.map((r) => [r.userId, r.k, r.credit, r.flagged, r.target, r.bonus, r.flags.map((f) => f.type), (r.evidence || []).length, !!writerById(r.userId)?.out, pastesOf(r.userId)?.at || 0, r.flaggedSince || 0]),
      early.map((n) => [n.w.id, n.k, n.flagged, n.sure, n.need, Math.round(n.minutesLeft), n.stale, n.since]),
      v.settings.missedHourOutcome,
    ]);
    update(needsEl, key, () => {
      const head = [];
      if (open.length) head.push(open.length === 1 ? '1 alert' : `${open.length} alerts`);
      if (reviews.length) head.push(reviews.length === 1 ? '1 hour to review' : `${reviews.length} hours to review`);
      if (early.length) head.push(early.length === 1 ? '1 check coming up' : `${early.length} checks coming up`);
      fill(needsEl,
        h('div', { class: 'h-needs-head' },
          h('h2', null, 'Needs you'), h('span', { class: 'h-needs-count' }, head.join(' · ')),
          open.length > 1 ? h('button', { class: 'btn btn-quiet', type: 'button', onClick: () => act('/api/admin/alert/ack', { id: 'all' }) }, 'Dismiss all alerts') : null),
        open.length || early.length ? h('ul', { class: 'h-alert-list' }, open.map(alertItem), early.map(earlyItem)) : null,
        reviews.map(reviewItem));
    });
  }
  function alertItem(a) {
    const w = writerById(a.userId);
    const first = firstName(a.name);
    const undo = a.undoId && a.undoUntil > now();
    const text = a.kind === 'approval' ? `${a.name} is waiting for your approval${a.message ? `: “${a.message}”` : '.'}`
      : txt(a.text) || (a.kind === 'review' ? `${a.name}: hour ${a.k + 1} needs your review.` : `${a.name} missed hour ${a.k + 1} (${fmtInt(a.credited)} of ${fmtInt(a.target)}).`);
    let meaning = null;
    if (a.kind !== 'review' && w?.out) meaning = `Out means ${first} keeps writing and streaming, but is no longer in the challenge.`;
    else if (a.kind !== 'review' && v.settings.missedHourOutcome === 'alert-only') meaning = 'Nobody is put out: missed hours only alert you.';
    return h('li', { class: `h-alert ${a.kind === 'review' ? 'is-review' : 'is-missed'}` },
      h('div', { class: 'h-alert-body' },
        h('p', { class: 'h-alert-text' }, text),
        h('p', { class: 'h-alert-meta' }, clock(a.t), meaning ? ` · ${meaning}` : '')),
      h('div', { class: 'h-alert-actions' },
        undo ? h('button', { class: 'btn', type: 'button', onClick: () => doUndo(a.undoId) }, 'Undo “Exclude”') : null,
        !undo && w?.out ? h('button', { class: 'btn', type: 'button', onClick: () => letBackIn(w) }, 'Let back in…') : null,
        h('button', { class: 'btn btn-quiet', type: 'button', onClick: () => openDetail(a.userId) }, 'Details'),
        h('button', { class: 'btn btn-quiet', type: 'button', onClick: () => act('/api/admin/alert/ack', { id: a.id }) }, 'Dismiss alert')));
  }
  // A running hour that will wait for your check when it ends (raised about 15 minutes before).
  function earlyItem(n) {
    const first = firstName(n.w.name);
    const words = plural(n.flagged, ...flagNoun(n.types));
    return h('li', { class: 'h-alert is-review is-early' },
      h('div', { class: 'h-alert-body' },
        h('p', { class: 'h-alert-text' }, n.stale
          ? `${n.w.name}’s hour ${n.k + 1}: ${plural(n.since, 'more word')} flagged since your decision (${words} to check now).`
          : `${n.w.name}’s hour ${n.k + 1} will need your check at ${clock(n.cur.endAt)}: ${words}.`),
        h('p', { class: 'h-alert-meta' }, `Without them: ${fmtInt(n.sure)} of ${fmtInt(n.need)}, ${minutesText(n.minutesLeft)} left. You can decide now. If 5 or more words get flagged after your decision, you’ll be asked again. If ${first} writes ${fmtInt(n.left)} more words first, no check is needed.`)),
      h('div', { class: 'h-alert-actions' },
        h('button', { class: 'btn', type: 'button', onClick: (e) => openDetail(n.w.id, e.currentTarget, { check: n.k }) }, `Check ${plural(n.flagged, 'word')}…`)));
  }
  // The full pastes behind a review, with the words the writer claimed highlighted, come from the
  // writer's details (GET /api/admin/writer: each paste's text and claim mask); fetched once a minute.
  const pasteCache = new Map(); // writer id -> { at, pastes }
  const pastesOf = (id) => pasteCache.get(id) || null;
  function wantPastes(id) {
    const c = pasteCache.get(id);
    if (c && (c.loading || Date.now() - c.at < 60_000)) return;
    pasteCache.set(id, { ...(c || { at: 0, pastes: null }), loading: true });
    api(`/api/admin/writer?id=${encodeURIComponent(id)}`)
      .then((d) => pasteCache.set(id, { at: Date.now(), pastes: Array.isArray(d.pastes) ? d.pastes : [] }))
      .catch(() => pasteCache.set(id, { at: Date.now(), pastes: (c && c.pastes) || null }))
      .finally(() => {
        renderNeeds();
        if (detailId === id) renderDrawer();
      });
  }
  // What excluding does, in one sentence (the card and the confirm dialog say the same).
  function reviewConsequence(r) {
    const w = writerById(r.userId);
    const first = firstName(r.name);
    const ended = phase() === 'ended';
    const out = v.settings.missedHourOutcome === 'out' && !w?.out && !ended;
    if (out) return `Excluding these words marks hour ${r.k + 1} missed and takes ${first} out of the challenge (${first} can keep writing). Counting them meets hour ${r.k + 1}.`;
    if (ended) return `The party is over, so this only settles ${first}’s results: excluding these words marks hour ${r.k + 1} missed, counting them meets it. Nobody is taken out after the end.`;
    return `Excluding these words marks hour ${r.k + 1} missed${w?.out ? `; ${first} is already out of the challenge` : ''}. Counting them meets hour ${r.k + 1}.`;
  }
  // What a check looks at: whole pastes in the hour (the claimed words highlighted) when the writer's
  // details are in, else the server's samples; and samples for flags that aren't pastes.
  function evidenceBlock({ userId, first, startAt, endAt, types, evidence = [], pastes = null }) {
    if (!pastes) {
      const pc = pastesOf(userId);
      if (types.includes('bigPaste') || evidence.some((e) => e.kind === 'paste')) wantPastes(userId);
      pastes = pc && pc.pastes ? pc.pastes : null;
    }
    const inHour = pastes ? pastes.filter((x) => x.t >= startAt && x.t < endAt && !x.short) : null;
    const rest = evidence.filter((e) => !(inHour && inHour.length && e.kind === 'paste')).slice(0, 3);
    return [
      inHour && inHour.length ? h('div', { class: 'h-review-pastes' }, inHour.map((x) => h('figure', null,
        h('figcaption', null, `Pasted at ${clock(x.t)}`, x.pane === 'notes' ? ' into the planning notes' : '', ` · highlighted: the words ${first} said they wrote today`),
        pasteText(x)))) : null,
      rest.length ? h('div', { class: 'h-evidence' }, rest.map((e) => h('figure', null,
        h('figcaption', null, e.kind === 'paste' ? 'Pasted (the start)' : e.kind === 'insert' ? 'Inserted at once (the start)' : `${flagLabel(e.kind)}: a sample`),
        h('blockquote', null, e.text)))) : null,
    ];
  }
  function reviewItem(r, { inDrawer = false } = {}) {
    const first = firstName(r.name);
    const types = [...new Set(r.flags.map((f) => f.type))];
    // One number for the flagged words, everywhere on the card.
    // (the parts add up to the server's "N written": without = written - flagged)
    const flagged = Math.round(r.flagged);
    const carried = Math.round(r.carriedIn || 0); // extra words from the hour before: never flagged
    const without = Math.max(0, Math.round(r.credit + carried) - flagged);
    const bonus = Math.round(r.bonus || 0);
    const n = plural(flagged, 'word');
    // Both answers carry equal weight; the consequence of excluding is spelled out above them.
    const accept = h('button', { class: 'btn', type: 'button', onClick: () => decide(r, 'accept') }, `Count ${n}`);
    const reject = h('button', { class: 'btn h-exclude', type: 'button', onClick: () => decide(r, 'reject') }, `Exclude ${n}…`);
    const since = Math.round(r.flaggedSince || 0);
    return h('article', { class: 'h-review' },
      h('header', { class: 'h-review-head' },
        h('h3', null, `${r.name}: hour ${r.k + 1} waits for your check`, h('span', { class: 'h-review-when' }, ` ${clock(r.startAt)}–${clock(r.endAt)}`)),
        h('div', { class: 'h-flags' }, types.map((t) => h('span', { class: `flag ${QUIET.has(t) ? '' : 'flag-warn'}`, title: FLAG[t]?.[1] || '' }, flagLabel(t))))),
      since >= 1 ? h('p', { class: 'h-check-again' }, `${plural(since, 'more word')} flagged since your decision${Number.isFinite(r.seen) ? ` (you had ${r.staleDecision === 'reject' ? 'excluded' : 'counted'} ${fmtInt(r.seen)})` : ''}: decide again for all ${fmtInt(flagged)}.`) : null,
      h('p', { class: 'h-review-sum' },
        `Hour ${r.k + 1} needs ${fmtInt(r.target)} words. ${first} has ${fmtInt(without)} that count for sure; the ${n} flagged by the checks count only if you say so (with them: ${fmtInt(without + flagged)}).`),
      bonus >= 1 ? h('p', { class: 'fd-review-food' }, `Food form: ${plural(bonus, 'word')}, counted outside the checks (they’re part of the ${fmtInt(without)}).`) : null,
      carried >= 1 ? h('p', { class: 'fd-review-food' }, `Carried over from hour ${r.k}: ${plural(carried, 'extra word')} (part of the ${fmtInt(without)}).`) : null,
      evidenceBlock({ userId: r.userId, first, startAt: r.startAt, endAt: r.endAt, types, evidence: r.evidence || [], pastes: inDrawer && detail && detail.id === r.userId ? detail.pastes : null }),
      h('p', { class: 'h-review-consequence' }, reviewConsequence(r)),
      h('div', { class: 'h-review-actions' }, accept, reject,
        inDrawer ? null : h('button', { class: 'btn btn-quiet', type: 'button', onClick: (e) => openDetail(r.userId, e.currentTarget, { check: r.k }) }, `${first}’s details`)));
  }
  // A running hour's flagged words, in the writer's drawer: decide now (an early check), or change
  // that decision. It covers the words shown; 5 or more flagged after it and you're asked again.
  function runningCheck(w, n) {
    const first = firstName(w.name);
    const [one, many] = flagNoun(n.types);
    const pending = n.flagged; // waiting for your check
    const shown = pending >= 1 ? pending : n.allFlagged;
    const words = plural(shown, one, many);
    const r = { userId: w.id, name: w.name, k: n.k, flagged: shown, running: true, n };
    const types = [...new Set(n.types)];
    const head = n.decision
      ? `Hour ${n.k + 1}: you ${n.decision === 'accept' ? 'counted' : 'excluded'} the ${words} flagged so far`
      : `Hour ${n.k + 1}: ${words} to check`;
    const actions = !n.decision
      ? [h('button', { class: 'btn', type: 'button', onClick: () => decide(r, 'accept') }, `Count ${plural(shown, 'word')}`),
        h('button', { class: 'btn h-exclude', type: 'button', onClick: () => decide(r, 'reject') }, `Exclude ${plural(shown, 'word')}…`)]
      : n.decision === 'accept'
        ? [h('button', { class: 'btn h-exclude', type: 'button', onClick: () => decide(r, 'reject') }, `Exclude ${plural(shown, 'word')} instead…`)]
        : [h('button', { class: 'btn', type: 'button', onClick: () => decide(r, 'accept') }, `Count ${plural(shown, 'word')} instead`)];
    return h('section', { class: 'h-dsec h-dcheck', 'data-check': String(n.k) },
      h('article', { class: 'h-review is-now' },
        h('header', { class: 'h-review-head' },
          h('h3', null, head, h('span', { class: 'h-review-when' }, ` ${clock(n.cur.startAt)}–${clock(n.cur.endAt)}, running`)),
          h('div', { class: 'h-flags' }, types.filter((t) => !QUIET.has(t)).map((t) => h('span', { class: 'flag flag-warn', title: FLAG[t]?.[1] || '' }, flagLabel(t))))),
        n.stale && n.since >= 1 ? h('p', { class: 'h-check-again' }, `${plural(n.since, 'more word')} flagged since your decision (you had ${n.stale === 'reject' ? 'excluded' : 'counted'} ${fmtInt(n.seen)}): decide again for all ${fmtInt(pending)}.`) : null,
        h('p', { class: 'h-review-sum' }, n.decision
          ? (n.decision === 'accept' ? `They count: ${first} has ${fmtInt(n.sure)} of ${fmtInt(n.need)} so far, ${minutesText(n.minutesLeft)} left.` : `They don’t count: ${first} has ${fmtInt(n.sure)} of ${fmtInt(n.need)} so far without them, ${minutesText(n.minutesLeft)} left.`)
          : `Hour ${n.k + 1} needs ${fmtInt(n.need)} words by ${clock(n.cur.endAt)}. ${first} has ${fmtInt(n.sure)} that count for sure; the ${words} flagged by the checks count only if you say so (with them: ${fmtInt(n.sure + pending)}).`),
        h('p', { class: 'h-check-note' }, 'You can decide now. If 5 or more words get flagged after your decision, you’ll be asked again.'),
        evidenceBlock({ userId: w.id, first, startAt: n.cur.startAt, endAt: n.cur.endAt, types, evidence: n.evidence || [], pastes: detail && detail.id === w.id ? detail.pastes : null }),
        h('div', { class: 'h-review-actions' }, actions)));
  }
  // What counting or excluding a running hour's flagged words does, said before it happens.
  function runningConsequence(r) {
    const n = r.n;
    const first = firstName(r.name);
    // (once counted, the words that count for sure include them)
    const without = n.decision === 'accept' ? Math.max(0, n.sure - n.allFlagged) : n.sure;
    return `Excluding them: they don’t count toward hour ${n.k + 1}; without them ${first} has ${fmtInt(without)} of ${fmtInt(n.need)}, with ${minutesText(n.minutesLeft)} left. Counting them: ${fmtInt(without + Math.round(r.flagged))} of ${fmtInt(n.need)}.`;
  }
  async function decide(r, decision) {
    const first = firstName(r.name);
    const flagged = Math.round(r.flagged);
    if (decision === 'reject') {
      const ok = await ask({
        title: `Exclude ${first}’s ${plural(flagged, 'flagged word')}?`,
        body: r.running
          ? [runningConsequence(r), 'You can decide now. If 5 or more words get flagged after your decision, you’ll be asked again.', 'You can undo this for 2 minutes.']
          : [reviewConsequence(r), 'You can undo this for 2 minutes.'],
        confirmLabel: `Exclude ${plural(flagged, 'word')}`, danger: true,
      });
      if (!ok) return;
    }
    let res;
    try {
      // seen: the flagged words you were shown (a decision on a running hour covers those).
      res = await api('/api/admin/review', { id: r.userId, k: r.k, decision, seen: flagged });
    } catch (e) {
      toast(e.message, { kind: 'error' });
      return;
    }
    await load();
    if (r.running) {
      if (decision === 'accept') toast(`Counted: ${first}’s ${plural(flagged, 'flagged word')} count in hour ${r.k + 1}. If more get flagged, you’ll be asked again.`);
      else undoToast(`Excluded: ${first}’s ${plural(flagged, 'flagged word')} don’t count in hour ${r.k + 1}.`, res, r.userId, 'review-reject');
      return;
    }
    if (decision === 'accept') toast(`Counted: ${first}’s hour ${r.k + 1} is met.`);
    else undoToast(`Excluded: ${first} missed hour ${r.k + 1}${writerById(r.userId)?.out ? ' and is out of the challenge' : ''}.`, res, r.userId, 'review-reject');
  }
  async function letBackIn(w) {
    const first = firstName(w.name);
    const miss = lastMiss(w.id);
    const byHost = !miss || txt(w.outReason) === 'marked out by the host';
    const ok = await ask({
      title: `Let ${w.name} back in?`,
      body: [
        byHost ? `${first} is back in the challenge from now on.` : `Hour ${miss.k + 1} stays missed (${fmtInt(miss.countedWords ?? miss.credited)} of ${fmtInt(miss.target)}), but ${first} is back in the challenge.`,
        `From now on ${first}’s hours count as usual; missing another one puts ${first} out again.`,
      ],
      confirmLabel: 'Let back in',
    });
    if (ok) act('/api/admin/writer', { id: w.id, out: false }, `${first} is back in.`);
  }
  // SPEC §33: someone who leaves isn't out; their hours just stop being judged until they're back.
  async function setLeft(w, left) {
    const first = firstName(w.name);
    if (left) {
      const min = v.settings.minFirstHourMin ?? 20;
      const ok = await ask({
        title: `Mark ${w.name} as left the party?`,
        body: [`From this hour on, ${first}’s hours aren’t judged: no missed hours, no alerts, and ${first} isn’t out of the challenge. Hours already judged keep their result, and ${first}’s posts stay as they are.`,
          `If ${first} comes back, choose “Back at the party”: with ${min} minutes or more left in that hour, it counts with a smaller target; otherwise judging starts with the next hour.`],
        confirmLabel: 'Mark as left',
      });
      if (!ok) return;
    }
    await act('/api/host/writer/left', { id: w.id, left }, left ? `${first} has left the party.` : `${first} is back at the party.`);
  }
  async function markOut(w) {
    const first = firstName(w.name);
    const ok = await ask({
      title: `Mark ${w.name} as out?`,
      body: [`${first} can keep writing (posts still stream and go in the anthology) but is out of the challenge until you let ${first} back in.`, 'You can undo this for 2 minutes.'],
      confirmLabel: 'Mark as out', danger: true,
    });
    if (!ok) return;
    try {
      const res = await api('/api/admin/writer', { id: w.id, out: true });
      await load();
      undoToast(`${first} is out.`, res, w.id, 'mark-out');
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  }

  // Make or remove a co-host (SPEC §21): full host powers, auto-approved.
  async function setHost(w, isAdmin) {
    const first = firstName(w.name);
    const self = w.id === myId;
    const ok = await ask(isAdmin ? {
      title: `Make ${w.name} a co-host?`,
      body: [`${first} gets every host power: approving writers, reviews, letting people back in, breaks, settings and ending the party. ${first}’s account is approved if it wasn’t.`, `${first} sees a one-time “You’re now a host” notice.`],
      confirmLabel: 'Make co-host',
    } : {
      title: self ? 'Stop being a host?' : `Remove ${w.name} as a co-host?`,
      body: [self ? 'You lose this dashboard straight away and keep writing as a normal writer.' : `${first} loses the host dashboard and keeps writing as a normal writer.`],
      confirmLabel: self ? 'Stop being a host' : 'Remove co-host', danger: true,
    });
    if (!ok) return;
    try {
      await api('/api/host/admins', { id: w.id, isAdmin });
    } catch (e) {
      const last = e.status === 409 || e.data?.code === 'last_host' || e.data?.error === 'last_host';
      toast(last ? `${self ? 'You’re' : `${first} is`} the only host, so ${self ? 'you' : first} can’t be removed. Make someone else a host first.` : e.message, { kind: 'error' });
      return;
    }
    if (self && !isAdmin) {
      location.href = '/';
      return;
    }
    toast(isAdmin ? `${first} is now a co-host.` : `${first} is no longer a host.`);
    await load();
    if (detailId) fetchDetail();
  }

  // ---------------------------------------------------------------- approval queue (SPEC §15)
  const seenAsks = new Map(); // waiting writer id -> the messageAt last announced
  function ago(ms) {
    const d = Math.max(0, now() - ms);
    if (d < 45_000) return 'just now';
    const m = Math.round(d / 60_000);
    return m < 90 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`;
  }
  // A new request or an edited message is announced like an alert: chime and notification.
  function noticeAsks() {
    const fresh = [];
    for (const p of waitingList()) {
      const key = String(p.messageAt || 0);
      const old = seenAsks.get(p.id);
      if (!firstLoad && old !== key) fresh.push([p, old !== undefined]);
      seenAsks.set(p.id, key);
    }
    if (!fresh.length) return;
    chime();
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    for (const [p, edited] of fresh) {
      try {
        new Notification(edited ? `${p.name} edited their message` : `${p.name} is waiting for your approval`, { body: p.message || 'No message.' });
      } catch { /* not allowed here */ }
    }
  }
  function renderApproval() {
    noticeAsks();
    const list = waitingList();
    approvalEl.hidden = !list.length;
    if (!list.length) {
      memo.delete(approvalEl);
      clear(approvalEl);
      return;
    }
    const declined = queue().filter((p) => p.approval === 'declined');
    const tick = Math.floor(now() / 30_000); // "edited 2 min ago" stays current
    update(approvalEl, JSON.stringify([list, declined.map((p) => [p.id, p.name, p.messageAt]), tick, phase()]), () => {
      fill(approvalEl,
        h('div', { class: 'h-approval-head' },
          h('h2', null, 'Waiting for approval'),
          h('span', { class: 'h-needs-count' }, list.length === 1 ? '1 new writer' : `${list.length} new writers`),
          list.length > 1 ? h('button', { class: 'btn', type: 'button', onClick: approveAll }, `Approve all ${list.length}`) : null),
        h('p', { class: 'h-card-lede' }, phase() !== 'running' ? 'They’ve signed up and can’t write until you approve them.'
          : synced() ? 'They’ve signed up and can’t write until you approve them. Then they write at once, on the shared clock.'
            : 'They’ve signed up and can’t write until you approve them. Their hours start when they open the editor after that.'),
        h('ul', { class: 'h-ask-list' }, list.map(askRow)),
        declined.length ? sticky(h('details', { class: 'h-declined' },
          h('summary', null, `Recently declined (${declined.length})`),
          h('ul', { class: 'h-ask-list' }, declined.map(askRow))), 'declined') : null);
    });
  }
  function askRow(p) {
    const declined = p.approval === 'declined';
    return h('li', { class: `h-ask ${declined ? 'is-declined' : ''}` },
      h('div', { class: 'h-ask-who' },
        h('b', null, p.name),
        h('span', { class: 'h-ask-meta' }, ` @${p.username}`, p.registeredAt ? ` · signed up ${clock(p.registeredAt)}` : ''),
        p.email ? h('span', { class: 'h-ask-email', translate: 'no' }, p.email) : null, // SPEC §25b: hosts only
        h('button', { class: 'btn-link acc-edit', type: 'button', onClick: (e) => editAccount(p, e.currentTarget) }, 'Edit details')),
      h('div', { class: 'h-ask-body' },
        p.message
          ? h('p', { class: 'h-ask-msg' }, h('q', null, p.message), p.messageAt ? h('span', { class: 'h-ask-when' }, ` edited ${ago(p.messageAt)}`) : null)
          : h('p', { class: 'h-ask-msg is-empty' }, declined ? 'Declined. No new message.' : 'No message yet.'),
        declined && p.note ? h('p', { class: 'h-ask-note' }, 'Your note: ', h('q', null, p.note)) : null),
      h('div', { class: 'h-ask-actions' },
        h('button', { class: `btn ${declined ? '' : 'btn-primary'}`, type: 'button', onClick: () => approve(p) }, declined ? 'Approve after all' : 'Approve'),
        declined ? null : h('button', { class: 'btn', type: 'button', onClick: () => decline(p) }, 'Decline…')));
  }
  function approve(p) {
    return act('/api/host/approve', { id: p.id }, phase() === 'running' ? `${p.name} is approved and can start writing.` : `${p.name} is approved and can write once the party starts.`);
  }
  async function decline(p) {
    const first = firstName(p.name);
    const note = h('textarea', { class: 'h-note', rows: 3, maxlength: 300, 'aria-label': `Note to ${p.name} (optional)` });
    const asked = ask({
      title: `Decline ${p.name}?`,
      body: h('div', { class: 'modal-body' },
        h('p', null, `${first} stays signed in but can’t write, and sees that you didn’t approve the account. If ${first} sends you a new message, the request comes back here.`),
        h('label', { class: 'h-note-label' }, h('span', null, `Note to ${first} (optional, shown on their screen)`), note)),
      confirmLabel: 'Decline', danger: true,
    });
    note.focus();
    if (!(await asked)) return;
    const text = note.value.trim().slice(0, 300);
    act('/api/host/decline', { id: p.id, ...(text ? { note: text } : {}) }, `${p.name} is declined.`);
  }
  async function approveAll() {
    const list = waitingList();
    const ok = await ask({
      title: `Approve all ${list.length} waiting writers?`,
      body: [list.map((p) => p.name).join(', ').replace(/, ([^,]*)$/, ' and $1') + '.',
        phase() === 'running' ? 'They can start writing straight away.' : 'They can write once the party starts.'],
      confirmLabel: `Approve ${list.length}`,
    });
    if (ok) act('/api/host/approve-all', {}, (r) => `${plural(r?.count ?? list.length, 'writer')} approved.`);
  }

  // ---------------------------------------------------------------- invite writers (setup)
  function renderSetup() {
    const p = phase();
    setupEl.hidden = p === 'ended';
    if (p === 'ended') return;
    const want = p === 'lobby' ? mainCol : sideCol;
    if (setupEl.parentNode !== want) {
      want.prepend(setupEl);
      memo.delete(setupEl);
    }
    if (qr === null) {
      qr = false;
      import('./qr.js').then((m) => { qr = m; memo.delete(setupEl); renderSetup(); }).catch(() => { qr = false; });
    }
    const s = v.settings;
    const waiting = waitingList().length;
    const declined = queue().filter((x) => x.approval === 'declined');
    const key = JSON.stringify([p, joinUrl(), signUps(), v.party.registrationOpen, v.party.plannedEnd, v.party.plannedStart, Math.floor(now() / 3_600_000), s.targetPerHour, s.freePassesPerWriter, s.carryOverMax, s.missedHourOutcome, s.approvalRequired, s.hoursMode, s.syncMinute, s.minFirstHourMin, waiting, declined.map((x) => x.id), setupOpen, !!qr, v.writers.filter((x) => x.isAdmin).map((x) => x.name), v.party.hosts]);
    update(setupEl, key, () => {
      const url = joinUrl();
      const n = signUps();
      const regOpen = v.party.registrationOpen !== false;
      const sw = h('input', { type: 'checkbox', role: 'switch', checked: regOpen, 'aria-describedby': 'h-reg-hint' });
      sw.addEventListener('change', () => act('/api/host/registration', { open: sw.checked }, sw.checked ? 'Sign-ups are open.' : 'Sign-ups are closed. Everyone who signed up can still sign in.'));
      // Hours (SPEC §17): synced to the clock or personal; shown once the server reports it.
      let hoursCtl = null;
      if (typeof s.hoursMode === 'string') {
        const sel = h('select', { 'aria-describedby': 'h-hours-hint' }, hoursOptions().map(([x, t]) => h('option', { value: x, selected: s.hoursMode === x }, t)));
        sel.addEventListener('change', async () => {
          if (!(await commitSettings({ hoursMode: sel.value }))) sel.value = s.hoursMode;
        });
        hoursCtl = h('div', { class: 'h-hours-mode' },
          h('label', null, h('span', null, 'Hours'), sel),
          h('p', { class: 'h-sub', id: 'h-hours-hint' }, hoursRule()));
      }
      // The hosts (SPEC §21).
      const hosts = v.writers.filter((x) => x.isAdmin);
      const hostLine = hosts.length ? h('p', { class: 'h-sub h-hosts' }, `${hosts.length === 1 ? 'Host' : 'Hosts'}: `,
        hosts.map((x, i) => [i ? ', ' : '', x.id === myId ? `${x.name} (you)` : x.name]),
        typeof v.party.hosts === 'number' ? '. Make a writer a co-host from their details.' : '.') : null;
      // Approval (SPEC §15): shown once the server reports the setting.
      let approval = null;
      if (typeof s.approvalRequired === 'boolean') {
        const ap = h('input', { type: 'checkbox', role: 'switch', checked: s.approvalRequired, 'aria-describedby': 'h-appr-hint' });
        ap.addEventListener('change', () => act('/api/admin/settings', { scoring: { approvalRequired: ap.checked } },
          ap.checked ? 'Approval is on: new writers wait for you.' : 'Approval is off: new writers can write straight away.'));
        approval = [
          h('label', { class: 'h-switch h-switch-appr' }, ap, h('span', null, `Approval: ${s.approvalRequired ? 'on' : 'off'}`)),
          h('p', { class: 'h-sub', id: 'h-appr-hint' }, 'New writers wait for you to approve them before they can write.'),
          declined.length && !waiting ? h('p', { class: 'h-sub h-declined-line' }, 'Declined recently: ',
            declined.map((x, i) => [i ? ', ' : '', x.name, ' ', h('button', { class: 'btn-link', type: 'button', onClick: () => approve(x) }, 'approve')])) : null,
        ];
      }
      const qrBox = qr?.qrSvg ? h('button', { class: 'h-qr', type: 'button', title: 'Show the QR code full screen', onClick: () => bigQr(url) }, qr.qrSvg(url, { label: `QR code for ${shownUrl(url)}` })) : null;
      const end = h('input', { type: 'time', value: v.party.plannedEnd ? clock(v.party.plannedEnd) : '', 'aria-label': 'Planned end time' });
      end.addEventListener('change', () => {
        const t = end.value ? clockToMs(end.value) : null;
        act('/api/admin/party', { plannedEnd: t }, t ? `Planned end: ${clock(t)}.` : 'Planned end cleared.');
      });
      // The planned start (lobby only): the party starts by itself then (lib/party.js startIfDue).
      const startIn = h('input', { type: 'time', value: Number.isFinite(v.party.plannedStart) ? clock(v.party.plannedStart) : '', 'aria-label': 'Start the party at' });
      startIn.addEventListener('change', () => {
        const t = startIn.value ? startToMs(startIn.value) : null;
        act('/api/admin/party', { plannedStart: t }, t ? `The party will start by itself ${dayClock(t)}.` : 'Planned start cleared: start it yourself.');
      });
      const passes = s.freePassesPerWriter ?? 1;
      const carry = s.carryOverMax ?? 0;
      const rules = [
        `Everyone writes ${fmtInt(s.targetPerHour)} new words an hour${carry > 0 ? `; up to ${fmtInt(carry)} words over the target carry on to the next hour` : ''}.`,
        synced() ? `Everyone writes on the same clock, ${mm()} to ${mm()}, from the moment they arrive; a late arrival’s first hour is shorter, or has the next hour added.` : hoursRule(),
        s.missedHourOutcome === 'alert-only'
          ? 'A missed hour alerts you; nobody is put out.'
          : 'Miss an hour and you’re out: you keep writing and streaming, but leave the challenge. You get an alert and can let them back in.',
        passes > 0
          ? `Everyone has ${passes === 1 ? '1 free hour' : `${passes} free hours`} to take off; you can give more, or call a break for everyone.`
          : 'There are no free hours to take; you can give one to anyone, or call a break for everyone.',
      ];
      const body = [
        h('div', { class: 'h-join' },
          h('div', { class: 'h-join-text' },
            h('p', { class: 'h-join-label' }, 'Writers sign up at'),
            h('p', { class: 'h-join-url' }, shownUrl(url)),
            h('div', { class: 'h-join-actions' },
              h('button', { class: 'btn', type: 'button', onClick: async () => toast((await copyText(url)) ? 'Link copied.' : 'Couldn’t copy; the link is on screen.') }, 'Copy link'),
              qrBox ? h('button', { class: 'btn btn-quiet', type: 'button', onClick: () => bigQr(url) }, 'Show QR full screen') : null),
            h('p', { class: 'h-join-count' }, h('strong', null, fmtInt(n)), n === 1 ? ' writer signed up' : ' writers signed up', waiting ? `, ${waiting} waiting for your approval` : ''),
            h('label', { class: 'h-switch' }, sw, h('span', null, regOpen ? 'Sign-ups open' : 'Sign-ups closed')),
            h('p', { class: 'h-sub', id: 'h-reg-hint' }, regOpen ? 'Close them to stop new accounts; everyone who signed up can still sign in.' : 'New accounts are refused; everyone who signed up can still sign in.'),
            approval,
            hostLine),
          qrBox),
        hoursCtl,
        h('h3', null, 'The rules, in four lines'),
        h('ol', { class: 'h-rules' }, rules.map((x) => h('li', null, x))),
        p === 'lobby' ? h('div', { class: 'h-plan' },
          h('label', null, h('span', null, 'Start at'), startIn),
          h('p', { class: 'h-sub' }, Number.isFinite(v.party.plannedStart)
            ? `The party starts by itself ${dayClock(v.party.plannedStart)}. You can still start it sooner; clear the time to cancel.`
            : 'Optional. The party starts by itself at this time; writers and the live page see it.')) : null,
        h('div', { class: 'h-plan' },
          h('label', null, h('span', null, 'Planned end'), end),
          h('p', { class: 'h-sub' }, 'Optional. The live page shows it; ending is always your call.')),
      ];
      if (p === 'lobby') {
        fill(setupEl, h('h2', null, 'Invite writers'), ...body);
        return;
      }
      const det = h('details', { class: 'h-setup-det', open: !!setupOpen },
        h('summary', null, h('span', { class: 'h-setup-sum' }, h('b', null, 'Invite writers'),
          ` · ${shownUrl(url)} · ${n} signed up · sign-ups ${regOpen ? 'open' : 'closed'}${typeof s.approvalRequired === 'boolean' ? ` · approval ${s.approvalRequired ? 'on' : 'off'}` : ''}`)),
        ...body);
      det.addEventListener('toggle', () => { setupOpen = det.open; memo.delete(setupEl); });
      fill(setupEl, det);
    });
  }
  function bigQr(url) {
    if (!qr?.qrSvg) return;
    modal({
      title: null, className: 'modal-qr',
      body: h('div', { class: 'h-bigqr' }, qr.qrSvg(url, { label: `QR code for ${shownUrl(url)}`, className: 'h-bigqr-svg' }), h('p', { class: 'h-bigqr-url' }, shownUrl(url)), h('p', { class: 'h-sub' }, 'Point a phone camera at the code to sign up.')),
      actions: [{ label: 'Close', primary: true }],
    });
  }

  // ---------------------------------------------------------------- status summary
  function renderSummary() {
    const p = phase();
    const s = localSummary(); // counted from the same rows the table shows
    const br = activeBreak();
    update(summaryEl, JSON.stringify([p, s, filter, v.rescoring, br && [br.endAt, modeOf(br)], synced()]), () => {
      if (p === 'lobby') {
        fill(summaryEl, signUps() ? h('p', { class: 'h-summary-note' }, `${plural(signUps(), 'writer')} signed up. ${synced() ? `Once you start, everyone’s hours run on the clock, ${mm()} to ${mm()}.` : 'Each writer’s clock starts when they open the editor after you start.'}`) : null);
        return;
      }
      if (p === 'ended') {
        fill(summaryEl, h('p', { class: 'h-summary-note' }, 'Final results. Hours in progress at the end didn’t count as missed.'));
        return;
      }
      const chips = CHIPS.filter((k) => s[SUMMARY_KEY[k]] > 0).map((k) => {
        const on = filter === k;
        const n = s[SUMMARY_KEY[k]];
        const text = k === 'break' && br && modeOf(br) === 'reduce' ? `${n} on the break` : STATUS[k][3](n);
        return h('button', { class: `h-chip ${on ? 'is-on' : ''}`, type: 'button', 'aria-pressed': String(on), title: on ? 'Show everyone' : `Show only: ${STATUS[k][0].toLowerCase()}`, onClick: () => { filter = on ? null : k; render(); } },
          h('i', { class: `st-dot ${k === 'break' && br && modeOf(br) === 'reduce' ? 'st-onbreak' : STATUS[k][1]}` }), text);
      });
      if (filter && !chips.some((c) => c.classList.contains('is-on'))) filter = null;
      const notes = [];
      if (v.rescoring) notes.push(h('span', { class: 'h-rescoring' }, 'Re-scoring with the new settings; numbers update in a moment.'));
      if (br) notes.push(modeOf(br) === 'pause' ? `Everyone’s clock is paused until ${clock(br.endAt)}.` : `${br.label} until ${clock(br.endAt)}: hours keep running, and this hour needs fewer words.`);
      else if (s.notStarted) notes.push(synced() ? 'Not started: they haven’t opened the editor yet.' : 'Not started: their first hour begins when they open the editor.');
      if (filter) notes.push(h('button', { class: 'btn-link', type: 'button', onClick: () => { filter = null; render(); } }, 'Show everyone'));
      fill(summaryEl,
        h('div', { class: 'h-chips', role: 'group', 'aria-label': 'Filter writers by status' }, chips),
        notes.length ? h('p', { class: 'h-summary-note' }, notes.flatMap((x, i) => (i ? [' ', x] : [x]))) : null);
    });
  }

  // ---------------------------------------------------------------- writers table
  const table = h('table', { class: 'h-table' });
  const thead = h('thead');
  const tbody = h('tbody');
  table.append(thead, tbody);
  const emptyEl = h('p', { class: 'h-empty' });
  const rows = new Map(); // writer id -> { key, el }
  let headKey = '';

  function columns() {
    const pick = notifyMod && phase() !== 'ended' ? [['c-pick', '']] : [];
    return [...pick, ...baseColumns()];
  }
  function baseColumns() {
    if (phase() === 'lobby') return [['c-who', 'Writer'], ['c-signed', 'Signed up']];
    if (phase() === 'ended') return [['c-who', 'Writer'], ['c-status', 'Result'], ['c-hours', 'Hours'], ['c-words', 'Counted toward targets']];
    const flagged = v.writers.some((w) => Object.keys(w.flags?.scoring || {}).some((t) => !QUIET.has(t)));
    return [['c-who', 'Writer'], ['c-status', 'Status'], ['c-hour', 'Words this hour'], ['c-hours', 'Hours'], flagged ? ['c-flags', 'Flags'] : null].filter(Boolean);
  }
  function renderTable() {
    const cols = columns();
    const hk = JSON.stringify(cols);
    if (hk !== headKey) {
      headKey = hk;
      fill(thead, h('tr', null, cols.map(([c, label]) => h('th', { scope: 'col', class: c, title: c === 'c-hour' ? 'Words so far this hour (counted, plus words counting soon) out of the hour’s target' : null }, c === 'c-pick' ? pickAllBox() : label))));
      table.classList.toggle('has-pick', cols.some(([c]) => c === 'c-pick'));
      rows.clear();
      clear(tbody);
    }
    let list = sortedWriters();
    if (phase() === 'lobby') list = list.filter((w) => !w.isAdmin);
    list = list.filter((w) => !queued(w.id)); // waiting or declined: in the approval card, not here
    const shown = filter ? list.filter((w) => (effStatus(w) === filter || alsoKey(w) === filter) && !(w.isAdmin && !w.joinedAt)) : list;
    if (!shown.length) {
      emptyEl.textContent = phase() === 'lobby'
        ? `Nobody has signed up yet. Writers sign up at ${shownUrl(joinUrl())}; they appear here as they do.`
        : 'Nobody here right now.';
      if (tableWrap.firstChild !== emptyEl) fill(tableWrap, emptyEl);
      return;
    }
    if (tableWrap.firstChild !== table) fill(tableWrap, table);
    const ids = shown.map((w) => w.id);
    const pickKey = JSON.stringify([ids, ids.filter((id) => picked.has(id))]);
    lastShown = ids;
    if (cols.some(([c]) => c === 'c-pick') && thead.__pickKey !== pickKey) {
      thead.__pickKey = pickKey;
      const th = thead.querySelector('th.c-pick');
      if (th) fill(th, pickAllBox());
    }
    const signed = signupTimes();
    const want = shown.map((w) => {
      const vm = rowModel(w, signed);
      const key = JSON.stringify(vm);
      const old = rows.get(w.id);
      if (old && (old.key === key || old.el.contains(document.activeElement))) return old.el;
      const el = buildRow(w, vm, cols);
      rows.set(w.id, { key, el });
      return el;
    });
    want.forEach((el, i) => {
      if (tbody.children[i] !== el) tbody.insertBefore(el, tbody.children[i] || null);
    });
    while (tbody.children.length > want.length) tbody.lastChild.remove();
  }
  // "Select all" for the rows shown (after any filter); ticks persist across filters.
  function pickAllBox() {
    const ids = shownIds();
    const all = ids.length > 0 && ids.every((id) => picked.has(id));
    const box = h('input', { type: 'checkbox', checked: all, 'aria-label': all ? 'Unselect the writers shown' : 'Select the writers shown' });
    box.indeterminate = !all && ids.some((id) => picked.has(id));
    box.addEventListener('change', () => {
      for (const id of ids) (box.checked ? picked.add(id) : picked.delete(id));
      headKey = '';
      renderTable();
      notifyChanged();
    });
    return box;
  }
  let lastShown = [];
  const shownIds = () => lastShown;
  // The composer reads the ticked rows through this getter (and hears when they change).
  const selectedIds = () => [...picked].filter((id) => v.writers.some((w) => w.id === id));
  let onPickChange = null;
  const notifyChanged = () => { try { onPickChange?.(selectedIds()); } catch { /* the composer's problem */ } };

  function signupTimes() {
    const m = new Map();
    for (const l of v.log) if (l.type === 'register' && l.userId) m.set(l.userId, l.t);
    return m;
  }
  // Everything a row shows, as plain data (rows re-render only when this changes).
  function rowModel(w, signed) {
    const st = statusView(w);
    const cur = w.progress?.current || null;
    const flags = Object.entries(w.flags?.scoring || {}).filter(([t]) => !QUIET.has(t)).map(([t, e]) => [t, e.count || 1]);
    return {
      phase: phase(), name: w.name, user: w.username, joinedAt: w.joinedAt, host: !!w.isAdmin, out: !!w.out, picked: picked.has(w.id),
      st: [st.key, st.label, st.cls, st.reason, st.also ? st.also.label : null, st.also ? st.also.key : null],
      signed: signed.get(w.id) || null,
      hour: cur ? [cur.k, Math.round(cur.credited), Math.round(cur.pending || 0), cur.target, !!cur.free, !!cur.inBreak, hourNow(w)?.flagged || 0, w.pace?.have ?? null, hourNow(w)?.allFlagged || 0, hourNow(w)?.decision || null] : null,
      ck: phase() === 'ended' ? null : checkK(w),
      strip: stripModel(w),
      target: [w.targetOverride ?? null, v.settings.targetPerHour],
      carry: [w.carryOverride ?? null, v.settings.carryOverMax ?? null],
      trust: w.trustPastes ?? null,
      flags,
      words: Math.round(w.totals?.credit || 0),
      met: w.progress ? [w.progress.met, w.progress.missed, w.progress.free, w.progress.review] : null,
    };
  }
  function buildRow(w, vm, cols) {
    const cells = {
      'c-pick': () => {
        const box = h('input', { type: 'checkbox', checked: picked.has(w.id), 'aria-label': `Select ${w.name}` });
        box.addEventListener('change', () => {
          if (box.checked) picked.add(w.id);
          else picked.delete(w.id);
          renderTable();
          notifyChanged();
        });
        return h('td', { class: 'c-pick' }, box);
      },
      'c-who': () => h('td', { class: 'c-who' },
        h('button', { class: 'h-who', type: 'button', onClick: (e) => openDetail(w.id, e.currentTarget) },
          h('span', { class: 'h-who-name' }, w.name),
          h('span', { class: 'h-who-meta' }, ` @${w.username}${w.joinedAt ? ` · since ${clock(w.joinedAt)}` : ''}${w.isAdmin ? ' · host' : ''}`))),
      'c-signed': () => h('td', { class: 'c-signed' }, vm.signed ? clock(vm.signed) : ''),
      'c-status': () => h('td', { class: 'c-status' },
        // "Needs your check" / "To review" open the drawer at the words to check.
        vm.ck !== null && ['check', 'review'].includes(vm.st[0])
          ? h('button', { class: `st ${vm.st[2]} h-st-btn`, type: 'button', title: 'See the flagged words and decide', onClick: (e) => openDetail(w.id, e.currentTarget, { check: vm.ck }) }, vm.st[1])
          : h('span', { class: `st ${vm.st[2]}` }, vm.st[1]),
        vm.st[4] && vm.st[5] === 'check' && vm.ck !== null
          ? h('button', { class: `st ${STATUS.check[1]} h-st-also h-st-btn`, type: 'button', title: 'See the flagged words and decide', onClick: (e) => openDetail(w.id, e.currentTarget, { check: vm.ck }) }, vm.st[4])
          : vm.st[4] ? h('span', { class: `st ${STATUS[vm.st[5]]?.[1] || 'st-risk'} h-st-also` }, vm.st[4]) : null,
        h('span', { class: 'h-reason', title: vm.st[3] }, vm.st[3])),
      'c-hour': () => hourCell(w),
      'c-hours': () => h('td', { class: 'c-hours', title: vm.met ? `${vm.met[0]} met, ${vm.met[1]} missed${vm.met[2] ? `, ${vm.met[2]} free` : ''}${vm.met[3] ? `, ${vm.met[3]} to review` : ''}` : '' },
        vm.strip.length ? h('span', { class: 'w-strip' }, vm.strip.map(([cls, title]) => h('i', { class: `seg ${cls}`, title }))) : h('span', { class: 'muted' }, '—')),
      'c-flags': () => {
        const f = vm.flags;
        return h('td', { class: 'c-flags' }, f.length ? h('div', { class: 'h-flags' },
          f.slice(0, 2).map(([t, n]) => h('span', { class: 'flag flag-warn', title: FLAG[t]?.[1] || '' }, `${flagLabel(t)}${n > 1 ? ` ${n}×` : ''}`)),
          f.length > 2 ? h('span', { class: 'flag', title: f.slice(2).map(([t]) => flagLabel(t)).join(', ') }, `+${f.length - 2}`) : null) : null);
      },
      'c-words': () => h('td', { class: 'c-words num' }, w.joinedAt ? fmtInt(vm.words) : ''),
    };
    const tr = h('tr', { class: `k-${vm.st[0]} ${w.isAdmin && !w.joinedAt ? 'is-host' : ''} ${vm.st[0] === 'out' ? 'is-out' : vm.st[0] === 'at-risk' || vm.st[5] === 'at-risk' ? 'is-risk' : ['review', 'check'].includes(vm.st[0]) || vm.st[5] === 'check' ? 'is-review' : ''}` },
      cols.map(([c]) => cells[c]()));
    tr.addEventListener('click', (e) => {
      if (!e.target.closest('input, button, a, select')) openDetail(w.id, tr.querySelector('.h-who'));
    });
    return tr;
  }
  // Words this hour: counted (settled), counting soon, and the two together (the server's pace.have).
  function hourWords(w, cur) {
    const counted = Math.round(cur.credited || 0);
    const have = Number.isFinite(w.pace?.have) ? w.pace.have : Math.round((cur.credited || 0) + Math.max(0, cur.pending || 0));
    return { counted, soon: Math.max(0, have - counted), have: Math.max(have, counted) };
  }
  function hourCell(w) {
    const cur = w.progress?.current;
    // Left the party (SPEC §33): this hour's words still count; no target, not judged.
    const away = !cur && phase() === 'running' ? w.progress?.leftNow : null;
    if (away) {
      const { counted, soon, have } = hourWords(w, away);
      const tip = [`Hour ${away.k + 1}: ${plural(have, 'word')} so far, not judged (they left the party).`];
      if (soon >= 1) tip.push(`${fmtInt(counted)} counted and ${fmtInt(soon)} counting soon.`);
      return h('td', { class: 'c-hour', title: tip.join('\n') },
        h('span', { class: 'h-hour-num' }, `${soon >= 1 ? '≈ ' : ''}${plural(have, 'word')}`),
        h('span', { class: 'h-hour-sub' }, 'left · not judged'));
    }
    if (!cur) return h('td', { class: 'c-hour' }, h('span', { class: 'muted' }, w.joinedAt && w.status === 'out' ? '' : '—'));
    // One number for the hour: words that count for sure so far (counted, minus flagged words, plus
    // words counting soon), the same number as the status text. Flagged words show apart; they
    // count only after your check. The bar shows counted and counting-soon parts.
    const { counted, soon, have } = hourWords(w, cur);
    const n = hourNow(w);
    const flagged = n ? n.flagged : 0;
    const sure = Math.max(0, have - flagged);
    const pct = cur.target > 0 ? Math.min(1, Math.max(0, counted - flagged) / cur.target) : 0;
    const pend = cur.target > 0 ? Math.max(0, Math.min(1 - pct, soon / cur.target)) : 0;
    const usualTarget = w.targetOverride ?? v.settings.targetPerHour;
    const tip = [`Hour ${cur.k + 1}: ${fmtInt(sure)} of ${fmtInt(cur.target)} words so far.`];
    if (soon >= 1) tip.push(`${fmtInt(counted - flagged)} counted and ${fmtInt(soon)} counting soon (a word counts once it has stayed ${v.settings.settleSec ?? 90} seconds).`);
    if (cur.carriedIn >= 1) tip.push(`Includes ${fmtInt(cur.carriedIn)} extra words carried over from hour ${cur.k}.`);
    if (flagged >= 1) tip.push(`Plus ${fmtInt(flagged)} flagged words that count only if you say so.`);
    if (cur.target !== usualTarget) tip.push(`This hour’s target is ${fmtInt(cur.target)}${cur.prorated ? ' (a shorter first hour)' : cur.extended ? ' (a longer first hour)' : (cur.reducedBy || []).length ? ' (lowered for a break)' : ''}; the usual one is ${fmtInt(usualTarget)}.`);
    if (cur.free) tip.push('A free hour: nothing is required.');
    if (cur.inBreak) tip.push(modeOf(activeBreak()) === 'reduce' ? 'On the break: the clock keeps running and the target is lower.' : 'Paused for the break.');
    return h('td', { class: 'c-hour', title: tip.join('\n') },
      h('span', { class: `w-bar ${cur.free ? 'is-free' : ''} ${pct >= 1 ? 'is-done' : ''}` },
        h('span', { class: 'w-bar-pending', style: { left: `${(pct * 100).toFixed(1)}%`, width: `${(pend * 100).toFixed(1)}%` } }),
        h('span', { class: 'w-bar-fill', style: { width: `${(pct * 100).toFixed(1)}%` } })),
      h('span', { class: 'h-hour-num' }, cur.free ? 'free' : `${fmtInt(sure)} / ${fmtInt(cur.target)}`),
      !cur.free && (flagged >= 1 || (n && n.allFlagged >= 1 && n.decision) || cur.target !== usualTarget) ? h('span', { class: 'h-hour-sub' },
        flagged >= 1
          ? h('button', { class: 'h-hour-check', type: 'button', title: 'See the flagged words and decide (you can, while the hour runs)', onClick: (e) => openDetail(w.id, e.currentTarget, { check: cur.k }) }, `+${fmtInt(flagged)} to check`)
          : n && n.allFlagged >= 1 && n.decision
            ? h('button', { class: 'h-hour-checked', type: 'button', title: 'Your decision on the flagged words (open to change it)', onClick: (e) => openDetail(w.id, e.currentTarget, { check: cur.k }) }, `${fmtInt(n.allFlagged)} flagged · ${n.decision === 'accept' ? 'counted' : 'excluded'}`)
            : null,
        (flagged >= 1 || (n && n.allFlagged >= 1 && n.decision)) && cur.target !== usualTarget ? ' · ' : null,
        // Why this hour's target isn't the usual one (the tooltip has both numbers).
        cur.target !== usualTarget ? (cur.prorated ? 'short first hour' : cur.extended ? 'long first hour' : (cur.reducedBy || []).length ? 'lowered for the break' : `this hour: ${fmtInt(cur.target)}`) : null) : null);
  }
  // "46 of 320 counted (+338 to check)": an hour's flagged words apart while they wait for your check.
  function hourNums(x, tail = '') {
    const fl = !x.decision && ['current', 'settling', 'review'].includes(x.status) ? Math.round(x.flagged || 0) : 0;
    const carried = Math.round(x.carriedIn || 0);
    return `${fmtInt(Math.max(0, Math.round(x.credited) - fl))} of ${fmtInt(x.target)}${tail}${carried >= 1 ? ` (${fmtInt(carried)} carried over)` : ''}${fl >= 1 ? ` (+${fmtInt(fl)} to check)` : ''}`;
  }
  // Hours (met / missed / free / current) with the breaks between them, as writers see it.
  function stripModel(w) {
    const pr = w.progress;
    if (!pr) return [];
    const t = now();
    const items = pr.hours.map((x) => {
      const nums = ['met', 'missed', 'current', 'review', 'settling', 'partial'].includes(x.status) ? `: ${hourNums(x, x.status === 'current' || x.status === 'settling' ? ' counted so far' : '')}`
        : x.status === 'left' ? `: ${plural(Math.round(x.credited || 0), 'word')} counted` : '';
      const dec = x.decision ? ` (flagged words ${x.decision === 'accept' ? 'counted' : 'not counted'})` : '';
      return [x.startAt, `seg-${x.status}`, `Hour ${x.k + 1}, ${clock(x.startAt)}–${clock(x.endAt)}: ${HOUR_WORD[x.status] || x.status}${dec}${nums}`];
    });
    for (const b of breaks()) {
      if (b.endAt > (w.joinedAt || Infinity) && b.startAt < t + 3600_000) items.push([b.startAt, 'seg-break', `${b.label}, ${clock(b.startAt)}–${clock(b.endAt)}`]);
    }
    return items.sort((a, b) => a[0] - b[0]).map(([, cls, title]) => [cls, title]);
  }
  // A per-writer target, previewed first while the party runs (the preview's `writers`).
  async function changeTarget(w, raw, revert) {
    const def = v.settings.targetPerHour;
    const s = String(raw).trim();
    const next = s === '' ? null : Number(s);
    if (next !== null && (!Number.isInteger(next) || next < 0)) {
      toast('A target is a whole number of words.', { kind: 'error' });
      revert();
      return;
    }
    const want = next === def && (w.targetOverride ?? null) === null ? null : next;
    if (want === (w.targetOverride ?? null)) {
      revert();
      return;
    }
    const first = firstName(w.name);
    if (phase() === 'running' && w.joinedAt) {
      let res;
      try {
        res = await api('/api/host/settings/preview', { writers: [{ id: w.id, targetOverride: want }] });
      } catch (e) {
        toast(e.message, { kind: 'error' });
        revert();
        return;
      }
      const n = hourNow(w);
      const lines = [`Target: ${fmtInt(w.targetOverride ?? def)} → ${fmtInt(want ?? def)} words an hour${want === null ? ' (the default)' : ''}, from ${n ? `hour ${n.k + 1}, the one in progress (${fmtInt(n.sure)} words so far),` : 'the hour in progress'} on.`];
      const ok = await previewDialog({ title: `Change ${w.name}’s target to ${fmtInt(want ?? def)}?`, lines, changes: res.changes, confirmLabel: 'Change the target and re-score', plainLabel: 'Change the target' });
      if (!ok) {
        revert();
        return;
      }
    }
    act('/api/admin/writer', { id: w.id, targetOverride: want }, want === null ? `${first} is back on the default target.` : `${first}’s target is ${fmtInt(want)}.`);
  }
  // A per-writer carryforward limit (lib/progress.js carryCap): it moves words between all of
  // their hours, so while the party runs, finished hours it would change are shown first.
  async function changeCarry(w, raw, revert) {
    const def = v.settings.carryOverMax ?? 0;
    const s = String(raw).trim();
    const next = s === '' ? null : Number(s);
    if (next !== null && (!Number.isInteger(next) || next < 0)) {
      toast('A carryover limit is a whole number of words.', { kind: 'error' });
      revert();
      return;
    }
    const want = next === def && (w.carryOverride ?? null) === null ? null : next;
    if (want === (w.carryOverride ?? null)) {
      revert();
      return;
    }
    const first = firstName(w.name);
    if (phase() === 'running' && w.joinedAt) {
      let res;
      try {
        res = await api('/api/host/settings/preview', { writers: [{ id: w.id, carryOverride: want }] });
      } catch (e) {
        toast(e.message, { kind: 'error' });
        revert();
        return;
      }
      const lines = [`Words over the target that carry to the next hour, at most: ${fmtInt(w.carryOverride ?? def)} → ${fmtInt(want ?? def)}${want === null ? ' (the default)' : ''}, for all of ${first}’s hours.`];
      const ok = await previewDialog({ title: `Change ${w.name}’s carryover limit to ${fmtInt(want ?? def)}?`, lines, changes: res.changes, confirmLabel: 'Change the limit and re-judge', plainLabel: 'Change the limit' });
      if (!ok) {
        revert();
        return;
      }
    }
    act('/api/admin/writer', { id: w.id, carryOverride: want }, want === null ? `${first} is back on the default carryover limit.` : `${first} can carry up to ${fmtInt(want)} words to the next hour.`);
  }

  // What re-scoring completed hours does, said first: which completed hours change and who goes
  // out of the challenge, comes back in, or gets an hour to check; then the details by writer.
  // The server reconciles after a re-score: a completed hour that becomes missed
  // puts its writer out (unless missed hours only alert you), one that becomes reviewable waits
  // for your check, and a writer whose missed hour becomes met comes back in. Completed hours
  // keep the targets they had.
  function previewDialog({ title, lines = [], changes = [], confirmLabel = 'Apply and re-score', plainLabel = 'Apply' }) {
    const word = (st) => ({ met: 'met', missed: 'missed', review: 'waiting for your check', free: 'free' }[st] || st);
    const count = (to) => changes.filter((c) => c.to === to).length;
    const groups = new Map();
    for (const c of changes) {
      if (!groups.has(c.writerId)) groups.set(c.writerId, { id: c.writerId, name: c.name, list: [] });
      groups.get(c.writerId).list.push(c);
    }
    const outRule = v.settings.missedHourOutcome !== 'alert-only' && phase() !== 'ended'; // nobody goes out after the end
    const newlyOut = [];
    const alertOnly = [];
    const backIn = [];
    const toCheck = [];
    for (const g of groups.values()) {
      const w = writerById(g.id);
      const status = new Map((w?.progress?.hours || []).map((x) => [x.k, x.status]));
      for (const c of g.list) status.set(c.k, c.to);
      if (!w?.out && g.list.some((c) => c.to === 'missed')) (outRule ? newlyOut : alertOnly).push(g.name);
      const m = /missed hour (\d+)/.exec(txt(w?.outReason) || '');
      if (w?.out && m) {
        const k = Number(m[1]) - 1;
        if (['met', 'free'].includes(status.get(k)) && ![...status.entries()].some(([kk, st]) => kk > k && st === 'missed')) backIn.push(g.name);
      }
      if (g.list.some((c) => c.to === 'review')) toCheck.push(g.name);
    }
    const list = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0] || '');
    const head = [];
    if (count('missed')) head.push(`${count('missed') === 1 ? '1 completed hour' : `${count('missed')} completed hours`} would become missed.`);
    if (count('met')) head.push(`${count('met') === 1 ? '1 completed hour' : `${count('met')} completed hours`} would become met.`);
    if (count('review')) head.push(`${count('review') === 1 ? '1 completed hour' : `${count('review')} completed hours`} would wait for your check.`);
    if (count('free')) head.push(`${count('free') === 1 ? '1 completed hour' : `${count('free')} completed hours`} would become free.`);
    const who = [];
    if (newlyOut.length) who.push(h('p', { class: 'h-preview-out' }, `${list(newlyOut)} would be out of the challenge.`));
    if (alertOnly.length) who.push(h('p', null, `${list(alertOnly)} would get a missed-hour alert and stay in (missed hours only alert you).`));
    if (backIn.length) who.push(h('p', null, `${list(backIn)} would come back into the challenge.`));
    if (toCheck.length) who.push(h('p', null, `${list(toCheck)} would have an hour waiting for your check.`));
    if (changes.length && !newlyOut.length && !backIn.length) who.push(h('p', null, 'Nobody goes out of the challenge or comes back in.'));
    const body = h('div', { class: 'modal-body h-preview' },
      changes.length
        ? [h('div', { class: 'h-preview-headline' }, head.map((x) => h('p', null, x)), who),
          lines.map((x) => h('p', { class: 'h-sub' }, x)),
          h('p', { class: 'h-sub' }, 'This re-scores hours that have already finished. They keep the targets they had.'),
          h('ul', { class: 'h-preview-list' }, [...groups.values()].slice(0, 40).map((g) => h('li', null,
            h('b', null, g.name), ': ',
            g.list.map((c, i) => [i ? ', ' : '', `hour ${c.hour} ${word(c.from)} → `, h('b', { class: `to-${c.to}` }, word(c.to))])))),
          groups.size > 40 ? h('p', { class: 'h-sub' }, `…and ${groups.size - 40} more writers.`) : null]
        : [lines.map((x) => h('p', null, x)), h('p', { class: 'h-preview-none' }, 'No completed hour changes, so nobody goes out of the challenge or comes back in. Completed hours keep their targets; the hour in progress uses the new numbers.')]);
    return ask({ title, body, confirmLabel: changes.length ? confirmLabel : plainLabel, danger: newlyOut.length > 0 });
  }

  // ---------------------------------------------------------------- writer drawer
  async function openDetail(id, from, { check = null } = {}) {
    detailFrom = from || document.activeElement;
    if (detailId !== id) detail = null;
    detailId = id;
    detailCheck = Number.isInteger(check) ? check : null;
    drawer.hidden = false;
    scrim.hidden = false;
    document.body.classList.add('h-drawer-open');
    memo.delete(drawer);
    renderDrawer();
    drawer.querySelector('.h-drawer-close')?.focus({ preventScroll: true });
    if (foodMod && (!foodPerson || foodPerson.id !== id || Date.now() - foodPerson.at > 30_000)) fetchFoodPerson(id);
    fetchUploads(id);
    await fetchDetail();
    showCheck(); // again once the pastes are in
    detailCheck = null;
  }
  // Scroll the drawer to the check it was opened at.
  function showCheck(k = detailCheck) {
    if (k === null || drawer.hidden) return;
    const sec = drawer.querySelector(`.h-dcheck[data-check="${k}"]`);
    if (sec) drawer.scrollTop += sec.getBoundingClientRect().top - drawer.getBoundingClientRect().top - 8;
  }
  function closeDetail() {
    detailId = null;
    detail = null;
    drawer.hidden = true;
    scrim.hidden = true;
    document.body.classList.remove('h-drawer-open');
    if (detailFrom?.isConnected) detailFrom.focus({ preventScroll: true });
  }
  async function fetchDetail() {
    const id = detailId;
    if (!id) return;
    detailAt = Date.now();
    try {
      const d = await api(`/api/admin/writer?id=${encodeURIComponent(id)}`);
      if (detailId === id) {
        detail = d;
        renderDrawer();
      }
    } catch { /* the next refresh tries again */ }
  }
  function renderDrawer() {
    const w = detailId && writerById(detailId);
    if (!w) {
      if (detailId && v) closeDetail();
      return;
    }
    const undo = lastUndo && lastUndo.userId === w.id && lastUndo.until > now() ? lastUndo : null;
    const key = JSON.stringify([rowModel(w, new Map()), w.statusReason, w.totals, w.passesLeft, w.extraPasses, w.posts, w.separate, w.flags, detail, !!undo, v.settings.targetPerHour, phase(), v.party.hosts, foodPerson && foodPerson.id === w.id ? foodPerson.at : 0, uploadsOf && uploadsOf.id === w.id ? uploadsOf.at : 0,
      v.log.filter((l) => l.userId === w.id).length,
      // the checks: the running hour's flagged words and hours waiting for review
      (w.progress?.hours || []).map((x) => [x.k, x.flagged, x.decision, x.seen, x.staleDecision, (x.evidence || []).length]),
      (v.reviews || []).filter((r) => r.userId === w.id).map((r) => [r.k, r.flagged, r.flaggedSince, (r.evidence || []).length]), pastesOf(w.id)?.at || 0]);
    update(drawer, key, () => {
      const scroll = drawer.scrollTop;
      fill(drawer, ...drawerContent(w, undo));
      drawer.scrollTop = scroll;
      showCheck();
    });
  }
  function drawerContent(w, undo) {
    const first = firstName(w.name);
    const st = statusView(w);
    const cur = w.progress?.current;
    const running = phase() === 'running';
    const def = v.settings.targetPerHour;
    const out = [];
    out.push(h('div', { class: 'h-drawer-head' },
      h('div', null,
        h('h2', { id: 'h-drawer-title' }, w.name),
        h('p', { class: 'h-drawer-meta' }, `@${w.username}`, w.email ? h('span', { class: 'h-drawer-email', translate: 'no' }, ` · ${w.email}`) : null, w.joinedAt ? (synced() ? ` · joined ${clock(w.joinedAt)}` : ` · hours from ${clock(w.joinedAt)}`) : ' · not started', w.isAdmin ? ' · host' : '')),
      h('button', { class: 'btn-icon h-drawer-close', type: 'button', 'aria-label': 'Close', onClick: closeDetail }, '×')));
    drawer.setAttribute('aria-labelledby', 'h-drawer-title');

    // Status now
    const now0 = [h('p', { class: 'h-drawer-status' }, h('span', { class: `st ${st.cls}` }, st.label), ' ', st.reason)];
    if (cur && running) {
      const { counted, soon, have } = hourWords(w, cur);
      const hn = hourNow(w);
      const flagged = hn ? hn.flagged : 0;
      const pct = cur.target > 0 ? Math.min(1, Math.max(0, counted - flagged) / cur.target) : 0;
      const pend = cur.target > 0 ? Math.max(0, Math.min(1 - pct, soon / cur.target)) : 0;
      const bits = [cur.free ? `Hour ${cur.k + 1} is free`
        : `Hour ${cur.k + 1}: ${fmtInt(have - flagged)} of ${fmtInt(cur.target)} words so far${soon >= 1 ? ` (${fmtInt(counted - flagged)} counted, ${fmtInt(soon)} counting soon)` : ''}`];
      if (cur.inBreak) bits.push(modeOf(activeBreak()) === 'reduce' ? 'on the break; the clock keeps running' : 'paused for the break');
      else if (w.pace && Number.isFinite(w.pace.minutesLeft)) bits.push(`${Math.max(0, Math.round(w.pace.minutesLeft))} minutes left`);
      now0.push(h('div', { class: 'h-drawer-hour' },
        h('span', { class: `w-bar ${cur.free ? 'is-free' : ''}` },
          h('span', { class: 'w-bar-pending', style: { left: `${(pct * 100).toFixed(1)}%`, width: `${(pend * 100).toFixed(1)}%` } }),
          h('span', { class: 'w-bar-fill', style: { width: `${(pct * 100).toFixed(1)}%` } })),
        h('span', null, bits.join(' · '),
          flagged >= 1 ? [' · ', h('button', { class: 'h-hour-check', type: 'button', onClick: () => showCheck(cur.k) }, `+${fmtInt(flagged)} to check`)] : null)));
    } else if (running && w.progress?.leftNow) {
      // Left the party (SPEC §33): this hour's words still count; it isn't judged.
      const away = w.progress.leftNow;
      const { counted, soon, have } = hourWords(w, away);
      now0.push(h('div', { class: 'h-drawer-hour' }, h('span', null,
        `Hour ${away.k + 1}: ${plural(have, 'word')} so far${soon >= 1 ? ` (${fmtInt(counted)} counted, ${fmtInt(soon)} counting soon)` : ''} · not judged (left)`)));
    }
    if (undo) now0.push(h('p', { class: 'h-drawer-undo' }, undo.kind === 'mark-out' ? 'You took them out of the challenge just now. ' : 'You excluded their flagged words just now. ', h('button', { class: 'btn', type: 'button', onClick: () => doUndo(undo.id) }, 'Undo')));
    out.push(h('section', { class: 'h-dsec' }, now0));

    // Flagged words to check: the running hour's (decide now), then hours waiting for review.
    const nCheck = running ? hourNow(w) : null;
    if (nCheck && nCheck.allFlagged >= 1) out.push(runningCheck(w, nCheck));
    for (const r of (v.reviews || []).filter((x) => x.userId === w.id)) {
      out.push(h('section', { class: 'h-dsec h-dcheck', 'data-check': String(r.k) }, reviewItem(r, { inDrawer: true })));
    }

    // Hours
    if (w.progress?.hours?.length) {
      out.push(h('section', { class: 'h-dsec' }, h('h3', null, 'Hours'),
        h('ol', { class: 'h-hours' }, w.progress.hours.map((x) => h('li', { class: `is-${x.status}` },
          h('i', { class: `seg seg-${x.status}` }),
          h('span', { class: 'h-hours-k' }, `Hour ${x.k + 1}`),
          h('span', { class: 'h-hours-when' }, `${clock(x.startAt)}–${clock(x.endAt)}`),
          h('span', { class: 'h-hours-st' }, HOUR_WORD[x.status] || x.status, ['free', 'upcoming-free'].includes(x.status) && freeOf(x.k) ? ` · ${freeFrom(freeOf(x.k))}` : '', x.decision ? ` (flagged words ${x.decision === 'accept' ? 'counted' : 'not counted'})` : x.staleDecision && x.flaggedSince >= 1 ? ` (${plural(x.flaggedSince, 'more word')} flagged since your decision)` : '',
            x.status === 'missed' && running ? [' · ', h('button', { class: 'btn-link', type: 'button', onClick: () => giveFree(w, x.k) }, 'Make it a free hour…')] : null),
          ['met', 'missed', 'current', 'review', 'settling', 'partial'].includes(x.status) ? h('span', { class: 'h-hours-n' }, hourNums(x, x.status === 'current' || x.status === 'settling' ? ' counted' : ''))
            : x.status === 'left' ? h('span', { class: 'h-hours-n' }, `${plural(Math.round(x.credited || 0), 'word')} counted`) : null,
          x.bonus >= 0.5 ? h('span', { class: 'fd-hours-food' }, `Food form: ${plural(Math.round(x.bonus), 'word')}`) : null)))));
    }

    // Words so far
    if (w.totals) {
      const t = w.totals;
      // Flagged words still waiting for your check (running hours and hours in review).
      const toCheck = (w.progress?.hours || []).reduce((sum, x) => sum + (!x.decision && ['current', 'settling', 'review'].includes(x.status) ? Math.round(x.flagged || 0) : 0), 0);
      const nc = Object.entries(t.nc || {}).filter(([k, x]) => k !== 'quick' && x >= 0.5).sort((a, b) => b[1] - a[1]);
      const ncSum = nc.reduce((s, [, x]) => s + x, 0);
      out.push(h('section', { class: 'h-dsec' }, h('h3', null, 'Words so far'),
        h('dl', { class: 'h-nums' },
          h('div', null, h('dt', null, 'Counted'), h('dd', null, fmtInt(t.credit))),
          h('div', null, h('dt', null, 'Written'), h('dd', null, fmtInt(t.written))),
          h('div', null, h('dt', null, 'Pasted'), h('dd', null, fmtInt(t.pasted))),
          h('div', null, h('dt', null, 'Cut'), h('dd', null, fmtInt(t.cut))),
          h('div', null, h('dt', null, 'Not counted'), h('dd', null, fmtInt(ncSum)))),
        nc.length ? h('p', { class: 'h-sub' }, 'Not counted: ', nc.map(([k, x]) => `${NOT_COUNTED[k] || k} ${fmtInt(x)}`).join(', '), '. Typos fixed before they settled cost nothing and aren’t listed.') : null,
        toCheck >= 1 ? h('p', { class: 'h-sub' }, `“Counted” includes ${plural(toCheck, 'flagged word')} that count only if you say so.`) : null));
    }

    // Flags, explained
    const flags = Object.entries(w.flags?.scoring || {});
    const sepNote = w.flags?.separateOveruse && (w.posts || 0) >= 3;
    if (flags.length || sepNote) {
      out.push(h('section', { class: 'h-dsec' }, h('h3', null, 'Flags'),
        h('ul', { class: 'h-flaglist' },
          flags.map(([t, e]) => h('li', null, h('b', null, v.flagLabels?.[t] || flagLabel(t)), e.count > 1 ? ` (${e.count}×)` : '', `: ${FLAG[t]?.[1] || ''}`)),
          sepNote ? h('li', null, h('b', null, 'Mostly separate identity'), `: ${w.separate} of ${w.posts} posts use it. Those aren’t streamed and are published at the end with no link to ${first}; it’s meant for the odd post.`) : null),
        h('p', { class: 'h-sub' }, 'Flagged words never meet an hour by themselves: such an hour waits for your review.')));
    }

    // Target
    const own = w.targetOverride ?? null;
    const tIn = h('input', { class: 'h-target-in', type: 'text', inputmode: 'numeric', value: String(own ?? def), size: 5, 'aria-label': `Target for ${w.name}, words an hour` });
    tIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') tIn.blur(); });
    tIn.addEventListener('change', () => changeTarget(w, tIn.value, () => { tIn.value = String(own ?? def); }));
    out.push(h('section', { class: 'h-dsec' }, h('h3', null, 'Target'),
      h('p', { class: 'h-drawer-target' }, tIn, ` words an hour ${own === null ? '(the default)' : `(their own; the default is ${fmtInt(def)})`}`),
      cur && !cur.free && cur.target !== (own ?? def) ? h('p', { class: 'h-sub' }, `This hour’s target is ${fmtInt(cur.target)}${cur.prorated ? ' (a shorter first hour)' : cur.extended ? ' (a longer first hour)' : (cur.reducedBy || []).length ? ' (lowered for a break)' : ''}.`) : null,
      h('p', { class: 'h-sub' }, own === null ? 'Change it for this writer only (you’ll see what it changes first). Empty it later to go back to the default.' : 'Empty the box to go back to the default.')));

    // Pastes: a writer whose pastes the host trusts is never flagged for a big paste (lib/score.js).
    if (typeof w.trustPastes === 'boolean') {
      const tSw = h('input', { type: 'checkbox', role: 'switch', checked: w.trustPastes, 'aria-describedby': `h-trust-${w.id}` });
      tSw.addEventListener('change', () => act('/api/admin/writer', { id: w.id, trustPastes: tSw.checked }, tSw.checked
        ? `${first}’s pastes are trusted: no more big-paste checks.`
        : `${first}’s pastes are checked again like everyone’s.`));
      out.push(h('section', { class: 'h-dsec' }, h('h3', null, 'Pastes'),
        h('label', { class: 'h-switch' }, tSw, h('span', null, w.trustPastes ? 'Their pastes are trusted' : 'Trust their pastes')),
        h('p', { class: 'h-sub', id: `h-trust-${w.id}` }, w.trustPastes
          ? `${first}’s pasted words are never flagged as a big paste, so an hour that needs them doesn’t wait for your check. Other checks still apply. Switch it off to check their pastes again.`
          : `For a writer who writes elsewhere and pastes it in: their pasted words are never flagged as a big paste, including hours already waiting for your check. Other checks (keyboard mash, lorem ipsum, late offline work) still apply.`)));
    }

    // Carryover (lib/progress.js carryCap): shown once the server reports the setting.
    if (v.settings.carryOverMax !== undefined) {
      const cdef = v.settings.carryOverMax ?? 0;
      const cown = w.carryOverride ?? null;
      const cIn = h('input', { class: 'h-target-in', type: 'text', inputmode: 'numeric', value: String(cown ?? cdef), size: 5, 'aria-label': `Carryover limit for ${w.name}, words` });
      cIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') cIn.blur(); });
      cIn.addEventListener('change', () => changeCarry(w, cIn.value, () => { cIn.value = String(cown ?? cdef); }));
      out.push(h('section', { class: 'h-dsec' }, h('h3', null, 'Carryover'),
        h('p', { class: 'h-drawer-target' }, cIn, ` words over the target can carry to the next hour ${cown === null ? '(the default)' : `(their own; the default is ${fmtInt(cdef)})`}`),
        h('p', { class: 'h-sub' }, cown === null ? 'Change it for this writer only (you’ll see what it changes first). Empty it later to go back to the default.' : 'Empty the box to go back to the default.')));
    }

    // Actions, each saying what it does; "Mark as out" last
    const acts = [];
    if (running && w.joinedAt) {
      const curFree = !!cur?.free;
      acts.push(h('button', { class: 'btn', type: 'button', disabled: curFree, onClick: () => giveFree(w, 'current') }, curFree ? `Hour ${cur.k + 1} is already free` : 'Free hour now…'));
      const nextFree = !!cur && detail?.id === w.id && (detail.freeHours || []).some((f) => f.k === cur.k + 1);
      acts.push(h('button', { class: 'btn', type: 'button', disabled: nextFree, onClick: () => giveFree(w, 'next') }, nextFree ? `Hour ${cur.k + 2} is already free` : 'Free hour next…'));
    }
    if (phase() !== 'ended') {
      const left = w.passesLeft ?? ((v.settings.freePassesPerWriter ?? 1) + (w.extraPasses || 0));
      acts.push(h('button', { class: 'btn', type: 'button', onClick: () => act('/api/admin/writer', { id: w.id, extraPasses: 1 }, `${first} has ${left + 1 === 1 ? '1 pass' : `${left + 1} passes`} now.`) }, `Give an extra pass (they have ${left})`));
      if (w.joinedAt) acts.push(h('button', { class: 'btn', type: 'button', onClick: () => editJoined(w) }, 'Change when their hours start…'));
    }
    // Co-hosts (SPEC §21): once the server reports the host count.
    if (typeof v.party.hosts === 'number') {
      const lastHost = w.isAdmin && v.party.hosts <= 1;
      acts.push(w.isAdmin
        ? h('button', { class: 'btn', type: 'button', disabled: lastHost, title: lastHost ? 'The only host can’t be removed. Make someone else a host first.' : null, onClick: () => setHost(w, false) }, w.id === myId ? 'Stop being a host…' : 'Remove co-host…')
        : h('button', { class: 'btn', type: 'button', onClick: () => setHost(w, true) }, 'Make co-host…'));
    }
    acts.push(h('button', { class: 'btn', type: 'button', onClick: (e) => editAccount(w, e.currentTarget) }, 'Edit name, username or password…'));
    if (running && !(w.isAdmin && !w.joinedAt)) {
      acts.push(w.leftAt
        ? h('button', { class: 'btn', type: 'button', onClick: () => setLeft(w, false) }, 'Back at the party')
        : h('button', { class: 'btn', type: 'button', onClick: () => setLeft(w, true) }, 'Mark as left the party…'));
      acts.push(w.out
        ? h('button', { class: 'btn h-letin', type: 'button', onClick: () => letBackIn(w) }, 'Let back in…')
        : h('button', { class: 'btn h-markout', type: 'button', onClick: () => markOut(w) }, 'Mark as out…'));
    }
    out.push(h('section', { class: 'h-dsec' }, h('h3', null, 'Actions'), h('div', { class: 'h-actions' }, acts)));

    // Food (SPEC §18): their answers, once food.js is loaded.
    if (foodMod) {
      const fp = foodPerson && foodPerson.id === w.id ? foodPerson : null;
      out.push(h('section', { class: 'h-dsec' }, h('h3', null, 'Food'), fp ? foodPersonView(fp.person, fp.order) : h('p', { class: 'h-sub' }, 'Loading their answers…')));
    }

    // Images they uploaded, each removable (GET /api/host/uploads, POST …/uploads/remove).
    const ups = uploadsOf && uploadsOf.id === w.id ? uploadsOf.list : [];
    if (ups.length) {
      out.push(h('section', { class: 'h-dsec' }, h('h3', null, 'Images'),
        h('ul', { class: 'h-uploads' }, ups.map((u) => h('li', { class: `h-upload ${u.removed ? 'is-removed' : ''}` },
          u.removed ? h('span', { class: 'h-upload-gone' }, 'Removed') : h('a', { href: u.url, target: '_blank', rel: 'noopener', class: 'h-upload-img' }, h('img', { src: u.url, alt: '', loading: 'lazy' })),
          h('span', { class: 'h-upload-meta' }, [clock(u.at), u.w && u.h ? `${u.w}×${u.h}` : null].filter(Boolean).join(' · ')),
          u.removed ? null : h('button', { class: 'btn btn-quiet h-upload-rm', type: 'button', onClick: () => removeUpload(w, u) }, 'Remove…')))),
        h('p', { class: 'h-sub' }, 'Removing an image swaps it for “Image removed by the host” wherever it appears.')));
    }

    // Posts and pastes
    const d = detail;
    if (!d) out.push(h('p', { class: 'h-sub' }, 'Loading posts…'));
    else {
      out.push(h('section', { class: 'h-dsec' }, h('h3', null, 'Posts'),
        d.posts.length ? h('div', { class: 'h-posts' }, d.posts.map((p) => sticky(h('details', { class: 'h-post' },
          h('summary', null,
            h('span', { class: 'h-post-title' }, p.title || 'Untitled'),
            h('span', { class: 'muted' }, ` ${({ live: 'streamed, anonymous', named: 'streamed, signed', separate: 'separate identity: published at the end', private: 'never published' })[p.privacy] || p.privacy} · ${plural(p.words, 'word')}${p.notesWords ? ` · notes ${fmtInt(p.notesWords)}` : ''}${p.closed ? ' · closed' : ''}`),
            p.privacy === 'private' ? h('span', { class: 'flag flag-private', title: 'The writer keeps this post private: it’s never published. Hosts can read it.' }, 'Private') : null,
            p.unlisted ? h('span', { class: 'flag flag-out' }, 'Hidden') : null,
            p.added ? h('span', { class: 'flag' }, 'Added after the party') : p.after?.length ? h('span', { class: 'flag' }, 'Changed after the party') : null),
          // SPEC §30: changes after the end: each edit session (with a reason only if it had one),
          // each large deletion with its size and reason, each privacy change with its reason.
          p.after?.length ? h('ul', { class: 'h-post-after' }, p.after.map((e) => h('li', null, h('strong', null, clock(e.at)),
            e.kind === 'added' ? ' started it after the party'
              : e.kind === 'edit' ? (e.reason ? ' edited it: ' : ' edited it after the party')
              : e.kind === 'cut' ? ` removed about ${plural(e.words, 'word')}: `
                : ` ${({ live: 'public, no name', named: 'public, signed', separate: 'separate identity', private: 'private' })[e.from] || e.from} → ${({ live: 'public, no name', named: 'public, signed', separate: 'separate identity', private: 'private' })[e.to] || e.to}: `,
            e.reason ? `“${e.reason}”` : ''))) : null,
          h('div', { class: 'h-post-actions' },
            // A private post is never public: nothing to hide (the button comes back if it goes public).
            p.privacy === 'private' ? null : h('button', { class: 'btn btn-quiet', type: 'button', onClick: () => act('/api/admin/post', { id: p.id, unlisted: !p.unlisted }, p.unlisted ? 'The post is public again.' : 'The post is hidden from the live page and the anthology.') },
              p.unlisted ? 'Show on the live page and in the anthology' : 'Hide from the live page and the anthology')),
          h('div', { class: 'h-post-body prose' }, renderMarkdown(p.body || '(empty)')),
          p.notes ? h('div', { class: 'h-post-notes' }, h('h4', null, 'Planning notes (private)'), h('div', { class: 'prose' }, renderMarkdown(p.notes))) : null), `post:${p.id}`))) : h('p', { class: 'muted' }, 'No posts yet.')));
      if (d.pastes.length) {
        out.push(h('section', { class: 'h-dsec' }, h('h3', null, 'Pastes'),
          h('ul', { class: 'h-pastes' }, d.pastes.slice().reverse().map((x) => h('li', null,
            h('p', null, h('strong', null, clock(x.t)), ` into “${x.postTitle}”${x.pane === 'notes' ? ' (notes)' : ''}: `,
              { no: 'said none of it was theirs', yes: 'chose what was theirs', short: v.settings.shortPastesCount === false ? 'a short paste (not asked; short pastes count nothing)' : 'a short paste (not asked; it counts like typing)', auto: 'already counted, not asked', file: 'opened a file', move: 'moved text by dragging' }[x.decision] || x.decision,
              `. ${plural(x.words, 'word')}`, x.short ? '' : `, ${fmtInt(x.selected)} claimed`, '.'),
            pasteText(x))))));
      }
      const fh = (d.freeHours || []).slice().sort((a, b) => a.k - b.k);
      const passes = Math.max(0, w.passesLeft ?? 0);
      if (fh.length) {
        out.push(h('section', { class: 'h-dsec' }, h('h3', null, 'Free hours'),
          h('ul', { class: 'h-freehours' }, fh.map((f) => h('li', null,
            h('b', null, `Hour ${f.k + 1}`), `: ${freeFrom(f)}`,
            f.by !== 'pass' && passes > 0 ? [' · ', h('button', { class: 'btn-link', type: 'button', onClick: () => countAsPass(w, f.k) }, 'Count it as their free hour')] : null))),
          h('p', { class: 'h-sub' }, `${first} has ${passes === 1 ? '1 free hour' : `${passes} free hours`} of their own left.`)));
      }
    }
    const hist = v.log.filter((l) => l.userId === w.id).slice(-12).reverse();
    if (hist.length) {
      out.push(h('section', { class: 'h-dsec' }, h('h3', null, 'History'),
        h('ol', { class: 'h-loglist' }, hist.map((l) => h('li', null, h('time', null, clock(l.t)), ' ', logLine(l))))));
    }
    return out;
  }
  async function fetchUploads(id) {
    try {
      const r = await api(`/api/host/uploads?uid=${encodeURIComponent(id)}`);
      if (detailId === id) {
        uploadsOf = { id, at: Date.now(), list: Array.isArray(r.uploads) ? r.uploads : [] };
        renderDrawer();
      }
    } catch { /* no uploads on this server, or not now: the section stays hidden */ }
  }
  async function removeUpload(w, u) {
    const ok = await ask({
      title: 'Remove this image?',
      body: [`Readers of ${firstName(w.name)}’s posts see “Image removed by the host” in its place, on the live page, post pages and the anthology. The text keeps the image’s address.`, 'This can’t be undone.'],
      confirmLabel: 'Remove image', danger: true,
    });
    if (!ok) return;
    try {
      await api('/api/host/uploads/remove', { name: u.name });
      toast('Image removed.');
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
    fetchUploads(w.id);
  }
  function pasteText(x) {
    const box = h('div', { class: 'h-paste-text' });
    const re = /\S+/g;
    let m;
    let last = 0;
    let i = 0;
    const text = x.text.length > 4000 ? x.text.slice(0, 4000) : x.text;
    const clsOf = (k) => (x.m[k] === '1' ? 'pw-on' : 'pw-off');
    while ((m = re.exec(text))) {
      const gap = text.slice(last, m.index);
      // The space between two claimed words is highlighted too, so claims read as runs.
      if (gap && i > 0 && clsOf(i - 1) === 'pw-on' && clsOf(i) === 'pw-on' && !gap.includes('\n')) box.append(h('span', { class: 'pw-on' }, gap));
      else box.append(gap);
      box.append(h('span', { class: clsOf(i) }, m[0]));
      last = m.index + m[0].length;
      i++;
    }
    if (x.text.length > 4000) box.append(' …');
    return box;
  }
  // Where a writer's free hour came from (the drawer's details carry each one's origin).
  const freeOf = (k) => (detail && detail.id === detailId ? (detail.freeHours || []).find((f) => f.k === k) : null) || null;
  const freeFrom = (f) => (f.by === 'pass' ? 'their free hour' : 'given by a host');
  // A free hour from the host: it uses the writer's own free hour (their pass) when they have one
  // left; an extra hour that doesn't is the quieter choice, and the only one once theirs are used.
  // which: 'current', 'next', or the number of a missed hour that has ended (made free afterwards).
  async function giveFree(w, which) {
    const first = firstName(w.name);
    const cur = w.progress?.current;
    const past = Number.isInteger(which);
    const k = past ? which : cur ? cur.k + (which === 'next' ? 1 : 0) : null;
    const left = Math.max(0, w.passesLeft ?? 0);
    const own = (v.settings.freePassesPerWriter ?? 1) + (w.extraPasses || 0);
    // A missed hour made free: if it's the one that put them out, they're back in, unless a later hour was missed too.
    const outFor = past && w.out && txt(w.outReason) === `missed hour ${k + 1}`;
    const laterMiss = past ? (w.progress?.hours || []).find((x) => x.k > k && x.status === 'missed') : null;
    const hourLine = past
      ? `Hour ${k + 1} stops counting as missed.${outFor ? (laterMiss ? ` ${first} stays out of the challenge: hour ${laterMiss.k + 1} was missed too.` : ` ${first} is back in the challenge.`) : ''}`
      : k !== null ? `Hour ${k + 1} won’t be required. Anything ${first} writes still counts and streams.` : 'That hour won’t be required.';
    const body = left > 0
      ? [hourLine, `This uses ${first}’s free hour (they have ${left}; ${left - 1} after this).`, `Or give an extra hour off that doesn’t use it.`]
      : [hourLine, own === 0 ? `${first} has no free hours of their own, so this is an extra hour off.` : `${first} has used ${own === 1 ? 'their free hour' : 'all their free hours'}, so this is an extra hour off.`];
    const choice = await new Promise((resolve) => {
      let done = false;
      const fin = (x) => {
        if (!done) {
          done = true;
          resolve(x);
        }
      };
      modal({
        title: past ? `Make hour ${k + 1} a free hour for ${w.name}?` : which === 'next' ? `Give ${w.name} the next hour off?` : `Give ${w.name} this hour off?`,
        className: 'modal-confirm h-free-confirm', onClose: () => fin(null),
        body: h('div', { class: 'modal-body' }, body.map((x) => h('p', null, x))),
        actions: left > 0
          ? [{ label: 'Cancel', quiet: true, onClick: () => fin(null) },
            { label: 'Give an extra hour', quiet: true, onClick: () => fin('extra') },
            { label: 'Use their free hour', primary: true, onClick: () => fin('pass') }]
          : [{ label: 'Cancel', quiet: true, onClick: () => fin(null) },
            { label: 'Give an extra hour off', primary: true, onClick: () => fin('extra') }],
      });
    });
    if (!choice) return;
    const hourName = k !== null ? `Hour ${k + 1}` : 'That hour';
    const backIn = outFor && !laterMiss ? ` ${first} is back in.` : '';
    act('/api/admin/writer', { id: w.id, freeHour: which, ...(choice === 'pass' ? { usePass: true } : {}) }, choice === 'pass'
      ? `${hourName} is free for ${first}, using their free hour (${left - 1} left).${backIn}`
      : `${hourName} is free for ${first}: an extra hour, not their own free hour.${backIn}`);
  }
  // A free hour a host gave, counted as the writer's own free hour instead (their pass).
  async function countAsPass(w, k) {
    const first = firstName(w.name);
    const left = Math.max(0, w.passesLeft ?? 0);
    const ok = await ask({
      title: `Count hour ${k + 1} as ${first}’s free hour?`,
      body: [`Hour ${k + 1} stays free. It uses ${first}’s free hour (they have ${left}; ${left - 1} after this).`],
      confirmLabel: 'Count it as their free hour',
    });
    if (ok) act('/api/admin/writer', { id: w.id, passForHour: k }, `Hour ${k + 1} now uses ${first}’s free hour (${left - 1} left).`);
  }
  function editJoined(w) {
    const input = h('input', { type: 'time', value: clock(w.joinedAt || now()), 'aria-label': 'Start time' });
    modal({
      title: `When do ${w.name}’s hours start?`,
      body: h('div', { class: 'modal-body' },
        h('p', null, synced()
          ? `Their first hour starts at this time (now ${clock(w.joinedAt)}), then follows the shared clock. Use it if ${firstName(w.name)} arrived but couldn’t open the editor.`
          : `Their hours are counted from this time (now ${clock(w.joinedAt)}). Use it if ${firstName(w.name)} arrived but couldn’t open the editor.`),
        h('p', { class: 'h-sub' }, 'Hours already judged keep their result.'),
        input),
      actions: [{ label: 'Cancel', quiet: true }, {
        label: 'Save', primary: true,
        onClick: () => {
          const t = clockToMs(input.value);
          if (t === null) return false;
          act('/api/admin/writer', { id: w.id, joinedAt: Math.min(t, now()) }, 'Start time saved.');
          return undefined;
        },
      }],
    });
  }
  // Account details (SPEC §25): display name, username and a new password, in account.js's dialog
  // (your own row opens "Your account"; co-hosts are told that hosts' details are the original host's).
  // The host's own account lacks an email (SPEC §25b): the top bar's "Your account" says so.
  function needsEmail() {
    const mine = v?.writers?.find((w) => w.id === myId);
    return !!mine && !mine.email;
  }
  function editAccount(w, from = document.activeElement) {
    import('./account.js').then((m) => m.openAccountEditor(w, { returnFocus: from, onSaved: () => load() }), () => toast('Can’t reach the server. Try again in a moment.', { kind: 'error' }));
  }

  // ---------------------------------------------------------------- breaks
  function renderBreaks() {
    const p = phase();
    breaksEl.hidden = p === 'ended';
    if (p === 'ended') return;
    const bs = breaks();
    const active = activeBreak();
    if (bs.some((b) => typeof b.mode === 'string')) breakModes = true;
    update(breaksEl, JSON.stringify([p, bs.map((b) => [b.id, b.label, b.startAt, b.endAt, b.status, b.mode]), !!active, synced(), v.settings.syncMinute, breakModes]), () => {
      const sched = bs.filter((b) => b.status === 'scheduled' || (b.startAt > now() && b.status !== 'ended'));
      const past = bs.filter((b) => b.status === 'ended');
      const label = h('input', { type: 'text', value: brk.label, maxlength: 60, 'aria-label': 'Break name' });
      const len = h('input', { type: 'number', value: brk.len, min: 1, max: 600, inputmode: 'numeric', 'aria-label': 'Length in minutes' });
      const at = h('input', { type: 'time', value: brk.at, 'aria-label': 'Start time (empty: now)' });
      const go = h('button', { class: 'btn', type: 'button' });
      const goLabel = () => {
        go.textContent = active ? 'Schedule another break…' : at.value ? 'Schedule break…' : p === 'lobby' ? 'Schedule break…' : 'Start a break now…';
      };
      goLabel();
      label.addEventListener('input', () => { brk.label = label.value; });
      len.addEventListener('input', () => { brk.len = len.value; });
      at.addEventListener('input', () => { brk.at = at.value; goLabel(); });
      // What the break does (SPEC §19); the default follows the hours mode.
      const chosen = brk.mode || defaultBreakMode();
      const modes = breakModes === false ? null : h('fieldset', { class: 'h-break-modes' },
        h('legend', null, 'During the break'),
        Object.entries(BREAK_MODES).map(([k, [title, desc]]) => {
          const r = h('input', { type: 'radio', name: 'h-break-mode', value: k, checked: chosen === k });
          r.addEventListener('change', () => { if (r.checked) brk.mode = k; });
          return h('label', { class: 'h-radio' }, r, h('span', null, h('b', null, title), h('small', null, desc())));
        }));
      go.addEventListener('click', async () => {
        const minutes = Number(len.value);
        if (!Number.isFinite(minutes) || minutes < 1 || minutes > 600) return toast('A break lasts 1 to 600 minutes.', { kind: 'error' });
        let startAt = null;
        if (at.value) startAt = clockToMs(at.value);
        else if (active || p === 'lobby') return toast(active ? 'Pick a start time for the next break.' : 'Pick a start time: the party hasn’t started yet.', { kind: 'error' });
        const name = label.value.trim() || 'Break';
        const picked = brk.mode || defaultBreakMode();
        // Say what it does first, with who would fall short.
        const from = startAt ?? now();
        const choice = await breakDialog({ name, startAt: from, endAt: from + minutes * 60_000, mode: breakModes === false ? 'pause' : picked, startsNow: startAt === null });
        if (!choice) return undefined;
        const mode = choice === 'pause' ? 'pause' : picked;
        const r = await act('/api/admin/break', { label: name, lengthMin: minutes, startAt, mode }, (x) => {
          if (x.break && typeof x.break.mode !== 'string') {
            breakModes = false; // this server only pauses: say so rather than pretend
            return `${name} ${startAt ? `scheduled for ${clock(x.break.startAt)}` : 'started'}. This server always pauses the clock during breaks.`;
          }
          if (startAt) return `${name} scheduled for ${clock(x.break?.startAt ?? startAt)}.`;
          return modeOf(x.break || { mode }) === 'reduce' ? `${name} started: hours keep running; this hour needs fewer words.` : `${name} started: everyone’s clock is paused until ${clock(x.break?.endAt)}.`;
        });
        if (r) {
          brk.at = '';
          memo.delete(breaksEl);
          renderBreaks();
        }
        return undefined;
      });
      const cancel = async (b, running) => {
        const m = modeOf(b);
        const title = running ? `End the ${b.label} now?` : `Cancel the ${b.label}?`;
        const line = running
          ? (m === 'reduce' ? 'Targets go back to normal from now; the hours never stopped.' : 'Everyone’s hour clock runs again from now.')
          : (m === 'reduce' ? 'The hour it falls in keeps its full target.' : `Hours won’t pause at ${clock(b.startAt)}.`);
        const changes = await previewBreak({ id: b.id, cancel: true });
        const ok = changes && changes.length
          ? await previewDialog({ title, lines: [line], changes, confirmLabel: running ? 'End the break and recalculate' : 'Cancel the break and recalculate' })
          : await ask({ title, body: [line], confirmLabel: running ? 'End the break now' : 'Cancel the break', cancelLabel: 'Keep it' });
        if (ok) act(`/api/host/breaks/${encodeURIComponent(b.id)}/cancel`, {}, running ? `${b.label} ended.` : `${b.label} cancelled.`);
      };
      // The mode of a break can change while it's scheduled or running, once the server has modes.
      const modeCtl = (b) => {
        if (typeof b.mode !== 'string') return null;
        const sel = h('select', { class: 'h-break-mode-sel', 'aria-label': `What the ${b.label} does` },
          Object.entries(BREAK_MODES).map(([k, [title]]) => h('option', { value: k, selected: modeOf(b) === k }, title)));
        sel.addEventListener('change', async () => {
          if (!(await changeBreakMode(b, sel.value))) sel.value = modeOf(b);
          sel.blur();
        });
        return sel;
      };
      const row = (b, running) => h('li', { class: `h-break ${running ? 'is-now' : ''}` },
        h('div', { class: 'h-break-what' },
          h('p', null, h('b', null, b.label), running ? ` now, until ${clock(b.endAt)}` : ` ${clock(b.startAt)}–${clock(b.endAt)}`),
          modeCtl(b) || h('p', { class: 'h-sub' }, BREAK_MODES[modeOf(b)][0])),
        h('button', { class: `btn ${running ? '' : 'btn-quiet'}`, type: 'button', onClick: () => cancel(b, running) }, running ? 'End break now' : 'Cancel'));
      fill(breaksEl,
        h('h2', null, 'Breaks'),
        h('p', { class: 'h-card-lede' }, 'A break for everyone either keeps the clock and lowers that hour’s target, or pauses the clock. The live page shows it.'),
        active || sched.length ? h('ul', { class: 'h-break-list', 'aria-label': 'Breaks now and later' }, active ? row(active, true) : null, sched.map((b) => row(b, false))) : null,
        past.length ? h('p', { class: 'h-sub' }, `Earlier: ${past.map((b) => `${b.label} ${clock(b.startAt)}–${clock(b.endAt)}`).join(', ')}.`) : null,
        h('div', { class: 'h-form-row' },
          h('label', { class: 'h-f-name' }, h('span', null, 'Name'), label),
          h('label', { class: 'h-f-len' }, h('span', null, 'Minutes'), len),
          h('label', { class: 'h-f-at' }, h('span', null, 'Starts at'), at)),
        modes,
        h('div', { class: 'h-form-row h-break-go' }, go),
        h('p', { class: 'h-sub' }, p === 'lobby' ? 'Pick a start time; breaks happen while the party runs.' : 'Leave “Starts at” empty to start the break now.'));
    });
  }
  // The synced grid's next turnover at or after t, where hours end (null with personal hours).
  function gridEnd(t) {
    if (!synced()) return null;
    const H = winMs();
    const nb = mergedBreaks();
    const origin = v.party.startedAt ? slotStart(v.party.startedAt) : slotStart(t);
    return realAt(Math.ceil(activeSince(t, origin, nb) / H) * H, origin, nb);
  }
  // A new break that keeps the clock lowers the target of the hour it falls in, but the rest of the
  // words still have to come in the minutes outside it: who would need more than their usual pace
  // (the at-risk rule, on the words that count for sure)? A break that pauses the clock takes no
  // writing time from anyone.
  function breakShort({ startAt, endAt, mode }) {
    const out = [];
    if (mode !== 'reduce' || phase() !== 'running') return out;
    const pb = mergedBreaks();
    for (const w of v.writers) {
      if (w.out || queued(w.id)) continue;
      const n = hourNow(w);
      if (!n) continue;
      const cur = n.cur;
      if (!(startAt < cur.endAt && endAt > Math.max(now(), cur.startAt))) continue; // not this hour
      const D = activeSince(cur.endAt, cur.startAt, pb);
      if (!(D > 0)) continue;
      let had = 0;
      for (const b of breaks()) if (modeOf(b) === 'reduce') had += Math.max(0, Math.min(cur.endAt, b.endAt) - Math.max(cur.startAt, b.startAt));
      const o = Math.max(0, Math.min(cur.endAt, endAt) - Math.max(cur.startAt, startAt));
      const base = Number.isFinite(cur.baseTarget) ? cur.baseTarget : n.need;
      const need = Math.round(base * Math.max(0, D - had - o) / D);
      const left = Math.max(0, Math.ceil(need - n.sure));
      if (!left) continue;
      const lost = Math.max(0, Math.min(cur.endAt, endAt) - Math.max(now(), startAt)) / 60_000;
      const writeMin = Math.max(0, n.writingMin - lost);
      const perMin = writeMin >= 0.5 ? left / writeMin : null;
      if (perMin === null || perMin > Math.max(12, 1.3 * (n.usual || 0))) out.push({ w, k: n.k, need, left, writeMin, perMin, usual: n.usual, already: n.behind || n.idleBehind });
    }
    return out.sort((a, b) => (b.perMin ?? Infinity) - (a.perMin ?? Infinity) || a.w.name.localeCompare(b.w.name));
  }
  // Starting or scheduling a break, said before it happens. Resolves 'go', 'pause' (the same break,
  // pausing the clock instead) or null. Suggests pausing when a break that keeps the clock ends
  // within 15 minutes of the hours turning over, runs past it, or leaves someone short.
  function breakDialog({ name, startAt, endAt, mode, startsNow }) {
    const len = Math.round((endAt - startAt) / 60_000);
    const when = startsNow ? `now until ${clock(endAt)}` : `${clock(startAt)}–${clock(endAt)}`;
    const title = startsNow ? `Start the ${name} now?` : `Schedule the ${name} for ${clock(startAt)}?`;
    const body = [];
    let risky = false;
    if (mode === 'reduce') {
      body.push(h('p', null, `${name}, ${when} (${plural(len, 'minute')}): the clock keeps running, and the hour it falls in needs fewer words.`));
      const turn = gridEnd(startAt + 1);
      if (turn !== null && turn <= endAt) {
        risky = true;
        body.push(h('p', { class: 'h-break-warn' }, `It runs past ${clock(turn)}, when the hours turn over: the hour ending then loses its last ${plural(Math.round((turn - Math.max(startAt, now())) / 60_000), 'minute')} of writing time, and its words have to be in before the break.`));
      } else if (turn !== null && turn - endAt < 15 * 60_000) {
        risky = true;
        const gap = Math.round((turn - endAt) / 60_000);
        body.push(h('p', { class: 'h-break-warn' }, `It ends ${gap < 1 ? 'right as' : `${plural(gap, 'minute')} before`} the hours turn over at ${clock(turn)}: ${gap < 1 ? 'no time after it' : `only ${plural(gap, 'minute')} after it`} to finish the hour, so whatever someone still owes is due before the break${gap < 1 ? '' : ' or in those minutes'}.`));
      }
      const short = breakShort({ startAt, endAt, mode });
      if (short.length) {
        risky = true;
        const line = (x) => {
          const usual = x.usual !== null ? `usually ${Math.round(x.usual)}` : 'no usual pace yet';
          const what = x.perMin === null ? `${fmtInt(x.left)} to go and no writing time left in hour ${x.k + 1}` : `${fmtInt(x.left)} to go in ${minutesText(x.writeMin)} of writing time, ${Math.ceil(x.perMin)} a minute (${usual})`;
          return h('li', null, h('b', null, x.w.name), `: ${what}${x.already ? '; already behind' : ''}.`);
        };
        body.push(h('p', null, `${short.length === 1 ? '1 writer' : `${short.length} writers`} would fall short of their hour, counting only the words that count for sure:`),
          h('ul', { class: 'h-break-short' }, short.slice(0, 8).map(line)),
          short.length > 8 ? h('p', { class: 'h-sub' }, `…and ${short.length - 8} more.`) : null);
      } else if (phase() === 'running' && startAt < (sharedHour()?.endAt ?? Infinity)) {
        body.push(h('p', { class: 'h-sub' }, 'Nobody would fall short of this hour with it, at the pace they usually write.'));
      }
      if (risky) {
        const after = turn !== null ? ` The hours then turn over ${plural(len, 'minute')} later (${clock(turn + len * 60_000)} instead of ${clock(turn)}, and so on).` : '';
        body.push(h('p', null, h('b', null, 'Pausing the clock instead'), ` stops everyone’s hour for the break, so nobody loses writing time.${after}`));
      }
    } else {
      const turn = gridEnd(startAt + 1);
      body.push(h('p', null, `${name}, ${when} (${plural(len, 'minute')}): everyone’s hour clock stops and starts again after it, so the hour it falls in ends ${plural(len, 'minute')} later and nobody loses writing time.${turn !== null ? ` The hours then turn over at ${clock(turn + len * 60_000)} instead of ${clock(turn)}, and so on.` : ''}`));
    }
    return new Promise((resolve) => {
      let done = false;
      const fin = (x) => {
        if (!done) {
          done = true;
          resolve(x);
        }
      };
      const goText = startsNow ? (risky ? 'Start it anyway' : 'Start the break') : (risky ? 'Schedule it anyway' : 'Schedule the break');
      modal({
        title, className: 'modal-confirm h-break-confirm', onClose: () => fin(null),
        body: h('div', { class: 'modal-body' }, body),
        actions: [
          { label: 'Cancel', quiet: true, onClick: () => fin(null) },
          risky ? { label: 'Pause the clock instead', primary: true, onClick: () => fin('pause') } : null,
          { label: goText, primary: !risky, onClick: () => fin('go') },
        ].filter(Boolean),
      });
    });
  }
  // Change what a break does; while the party runs, show whose hours it changes first.
  // What a break change does to finished hours (the settings preview takes
  // breaks: [{ id, mode?, cancel? }]); null when this server can't tell.
  async function previewBreak(change) {
    if (phase() !== 'running') return [];
    try {
      return (await api('/api/host/settings/preview', { breaks: [change] })).changes || [];
    } catch {
      return null;
    }
  }
  async function changeBreakMode(b, mode) {
    const title = `${BREAK_MODES[mode][0]} for the ${b.label}?`;
    const changes = await previewBreak({ id: b.id, mode });
    const ok = changes
      ? await previewDialog({ title, lines: [BREAK_MODES[mode][1]()], changes, confirmLabel: 'Change the break and recalculate' })
      : await ask({ title, body: [BREAK_MODES[mode][1](), 'Everyone is re-scored with it, so hours that overlap the break can change.'], confirmLabel: 'Change the break' });
    if (!ok) return false;
    return !!(await act(`/api/host/breaks/${encodeURIComponent(b.id)}`, { mode }, `${b.label}: ${BREAK_MODES[mode][0].toLowerCase()}.`));
  }

  // ---------------------------------------------------------------- scoring settings
  function renderSettings() {
    const p = phase();
    settingsEl.hidden = p === 'ended';
    if (p === 'ended') return;
    const s = v.settings;
    update(settingsEl, JSON.stringify([p, s, draft ? 1 : 0, v.rescoring]), () => {
      const val = (k) => {
        if (draft && k in draft) return draft[k];
        if (k === 'bigPaste') return s.reviewBigPastes === false ? '' : String(s.bigPasteWords ?? '');
        const x = s[k];
        return typeof x === 'boolean' ? x : x === null || x === undefined ? '' : String(x);
      };
      const save = h('button', { class: 'btn btn-primary', type: 'button', disabled: !draft }, p === 'running' ? 'Review and save…' : 'Save settings');
      const discard = h('button', { class: 'btn btn-quiet', type: 'button', hidden: !draft }, 'Discard changes');
      const touched = (k, x) => {
        draft = { ...(draft || {}), [k]: x };
        save.disabled = false;
        discard.hidden = false;
      };
      const field = (f) => {
        if (f.optional && s[f.k] === undefined) return null; // the server doesn't have it (yet)
        if (f.type === 'enum') {
          const hours = f.k === 'hoursMode';
          const el = h('select', { 'aria-describedby': `hs-${f.k}` }, (hours ? hoursOptions() : f.options).map(([x, t]) => h('option', { value: x, selected: val(f.k) === x }, t)));
          const help = hours ? h('small', { class: 'h-field-help', id: `hs-${f.k}` }, hoursRule(val(f.k))) : null;
          el.addEventListener('change', () => {
            touched(f.k, el.value);
            if (help) help.textContent = hoursRule(el.value);
          });
          return h('label', { class: 'h-field h-field-wide' }, h('span', { class: 'h-field-label' }, f.label), el, help);
        }
        if (f.type === 'bool') {
          const el = h('input', { type: 'checkbox', checked: !!val(f.k) });
          el.addEventListener('change', () => touched(f.k, el.checked));
          return h('label', { class: 'h-check' }, el, h('span', null, h('span', { class: 'h-field-label' }, f.label), h('small', { class: 'h-field-help' }, f.help)));
        }
        const el = h('input', { type: 'text', inputmode: f.type === 'int' ? 'numeric' : 'decimal', value: val(f.k), placeholder: f.placeholder || null, size: 6, 'aria-describedby': `hs-${f.k}` });
        el.addEventListener('input', () => touched(f.k, el.value));
        return h('label', { class: 'h-field' },
          h('span', { class: 'h-field-label' }, f.label),
          h('span', { class: 'h-field-in' }, el, f.unit ? h('small', null, f.unit) : null),
          f.help ? h('small', { class: 'h-field-help', id: `hs-${f.k}` }, f.help) : null);
      };
      save.addEventListener('click', saveSettings);
      discard.addEventListener('click', () => {
        draft = null;
        memo.delete(settingsEl);
        renderSettings();
      });
      const fine = sticky(h('details', { class: 'h-fine' },
        h('summary', null, 'Fine-tune scoring (the defaults are tested)'),
        h('div', { class: 'h-fields' }, FINE.map(field))), 'fine');
      fill(settingsEl,
        h('h2', null, 'Scoring'),
        v.rescoring
          ? h('p', { class: 'h-card-lede h-rescoring' }, 'Re-scoring everyone with the new settings… The numbers update in a moment.')
          : h('p', { class: 'h-card-lede' }, p === 'running' ? 'A change re-scores everyone from their full history. You see who it affects before it’s saved.' : 'A change re-scores everyone from their full history.'),
        h('div', { class: 'h-fields h-fields-main' }, MAIN.map(field)),
        fine,
        h('div', { class: 'h-form-row h-settings-save' }, save, discard));
    });
  }
  function settingsPatch() {
    const s = v.settings;
    const patch = {};
    for (const [k, raw] of Object.entries(draft || {})) {
      const f = [...MAIN, ...FINE].find((x) => x.k === k);
      if (!f) continue;
      if (f.type === 'bool' || f.type === 'enum') {
        if (raw !== s[k]) patch[k] = raw;
        continue;
      }
      const t = String(raw).trim();
      if (k === 'bigPaste') {
        if (t === '' || t === '0') {
          if (s.reviewBigPastes !== false) patch.reviewBigPastes = false;
        } else {
          const n = Number(t);
          if (!Number.isInteger(n) || n < 1) throw new Error(`Check “${f.label}”: a whole number of words, or empty for never.`);
          if (s.reviewBigPastes === false) patch.reviewBigPastes = true;
          if (n !== s.bigPasteWords) patch.bigPasteWords = n;
        }
        continue;
      }
      if (t === '' && f.type === 'num?') {
        if (s[k] !== null) patch[k] = null;
        continue;
      }
      const n = Number(t);
      if (t === '' || !Number.isFinite(n) || n < 0 || (f.type === 'int' && !Number.isInteger(n))) throw new Error(`Check “${f.label}”: ${f.type === 'int' ? 'a whole number' : 'a number'}${f.type === 'num?' ? ', or empty' : ''}.`);
      if (n !== s[k]) patch[k] = n;
    }
    return patch;
  }
  async function saveSettings() {
    let patch;
    try {
      patch = settingsPatch();
    } catch (e) {
      toast(e.message, { kind: 'error' });
      return;
    }
    if (!Object.keys(patch).length) {
      draft = null;
      memo.delete(settingsEl);
      renderSettings();
      return;
    }
    await commitSettings(patch, () => {
      draft = null;
      memo.delete(settingsEl);
    });
  }
  // What a settings patch changes, in words ("Target per hour: 400 → 450.").
  function describePatch(patch) {
    const s = v.settings;
    const show = (k, x) => {
      if (x === null || x === undefined) return k === 'cutCapPerHour' ? 'half the target' : 'no limit';
      if (typeof x === 'boolean') return x ? 'on' : 'off';
      if (k === 'missedHourOutcome') return x === 'out' ? 'they’re out' : 'alert only';
      if (k === 'hoursMode') return x === 'synced' ? 'synced to the clock' : 'personal';
      return Number.isInteger(x) ? fmtInt(x) : String(x);
    };
    return Object.entries(patch).map(([k, x]) => {
      if (k === 'reviewBigPastes') return `Review big pastes: ${x ? 'on' : 'off'}.`;
      if (k === 'bigPasteWords') return `Review an hour that needs: ${fmtInt(s.bigPasteWords)} → ${fmtInt(x)} pasted words.`;
      return `${SETTING_LABEL[k] || v.settingLabels?.[k] || k}: ${show(k, s[k])} → ${show(k, x)}.`;
    });
  }
  // Save a settings patch; while the party runs, first show whose hours it changes.
  async function commitSettings(patch, onSaved = null) {
    if (phase() === 'running') {
      let res;
      try {
        res = await api('/api/host/settings/preview', { patch });
      } catch (e) {
        toast(e.message, { kind: 'error' });
        return false;
      }
      const title = Object.keys(patch).length === 1 && patch.targetPerHour !== undefined
        ? `Change the target to ${fmtInt(patch.targetPerHour)} words an hour?`
        : 'Re-score completed hours with these settings?';
      const ok = await previewDialog({ title, lines: describePatch(patch), changes: res.changes });
      if (!ok) return false;
    }
    let r;
    try {
      r = await api('/api/admin/settings', { scoring: patch });
    } catch (e) {
      toast(e.message, { kind: 'error' });
      return false;
    }
    onSaved?.();
    toast(r?.rescoring ? 'Saved. Everyone is being re-scored; the numbers update in a moment.' : 'Settings saved.');
    await load();
    return true;
  }

  // ---------------------------------------------------------------- messages (SPEC §22)
  // notify.js draws the composer (recipients, preview count, sent list); it reads the rows ticked
  // in the table through getSelected. Dormant until notify.js is loaded.
  let composer = null;
  function renderNotify() {
    if (!notifyMod || typeof notifyMod.renderNotifyComposer !== 'function') return;
    notifyEl.hidden = false;
    if (!composer) {
      const body = h('div', { class: 'h-notify-body' });
      fill(notifyEl, h('h2', null, 'Send a message'), body);
      try {
        composer = notifyMod.renderNotifyComposer(body, v, {
          getSelected: selectedIds,
          onSelectionChange: (fn) => { onPickChange = fn; },
        }) || {};
      } catch (e) {
        composer = {};
        fill(body, h('p', { class: 'h-sub' }, `The message composer failed to load: ${e.message}`));
      }
      headKey = ''; // the table gains its checkbox column
      renderTable();
      return;
    }
    try {
      composer.update?.(v);
    } catch { /* the composer keeps its last view */ }
  }

  // ---------------------------------------------------------------- food (SPEC §18, §20)
  // A collapsible card under the writers table. food.js draws and refreshes the body (tallies,
  // severe allergies first, the CSV, the reset; never redrawn while the host edits in it); the
  // summary line counts answers and severe allergies. Dormant until food.js is loaded.
  const foodSum = h('span', { class: 'h-food-sum' });
  const foodBody = h('div', { class: 'h-food-body' });
  let foodCard = null;
  function mountFoodBody() {
    if (foodCard) return;
    if (typeof foodMod.mountFoodCard === 'function') foodCard = foodMod.mountFoodCard(foodBody, { heading: false }); // our summary says "Food"
    else if (typeof foodMod.renderFoodSummary === 'function') {
      foodCard = {};
      api('/api/host/food').then((data) => foodMod.renderFoodSummary(foodBody, data)).catch((e) => fill(foodBody, h('p', { class: 'h-sub' }, `Couldn’t load the food answers: ${e.message}`)));
    }
  }
  function renderFood() {
    if (!foodMod) return;
    foodEl.hidden = false;
    if (!foodEl.firstChild) {
      const det = sticky(h('details', { class: 'h-food-det' },
        h('summary', null, h('b', null, 'Food'), foodSum), foodBody), 'food');
      det.addEventListener('toggle', () => { if (det.open) mountFoodBody(); });
      fill(foodEl, det);
      if (det.open) mountFoodBody();
    }
    refreshFoodLine();
  }
  async function refreshFoodLine() {
    if (Date.now() - foodAt < 60_000) return;
    foodAt = Date.now();
    let data;
    try {
      data = await api('/api/host/food');
    } catch {
      return;
    }
    const s = data.summary || {};
    const severe = Array.isArray(s.severe) ? s.severe.length : 0;
    fill(foodSum, Number.isFinite(s.people) ? ` · ${fmtInt(s.answered || 0)} of ${fmtInt(s.people)} answered` : '',
      severe ? h('span', { class: 'h-food-severe' }, ` · ${severe === 1 ? '1 severe allergy' : `${severe} severe allergies`}`) : null);
  }
  async function fetchFoodPerson(id) {
    if (!foodMod) return;
    try {
      const r = await api(`/api/host/food?id=${encodeURIComponent(id)}`);
      if (detailId === id) {
        foodPerson = { id, at: Date.now(), person: r.person || null, order: r.order || null };
        renderDrawer();
      }
    } catch { /* the drawer keeps saying it's loading; the next open tries again */ }
  }
  // One person's answers for the drawer: food.js's renderer when it has one, else a plain list.
  function foodPersonView(person, order) {
    if (typeof foodMod?.renderFoodAnswers === 'function') {
      const box = h('div', { class: 'h-food-person' });
      try {
        foodMod.renderFoodAnswers(box, person, order);
        return box;
      } catch { /* fall through */ }
    }
    const f = person?.food;
    if (!person?.answered || !f) return h('p', { class: 'h-sub' }, 'No food answers yet.');
    const rows = [];
    const add = (label, value) => { if (value) rows.push(h('div', null, h('dt', null, label), h('dd', null, value))); };
    add('Diet', [f.diet === 'other' ? f.dietOther : f.diet].filter(Boolean).join(''));
    add('Rules', [...(f.rules || []).filter((r) => r !== 'other'), f.rulesOther].filter(Boolean).join(', '));
    if (f.allergies?.length) {
      rows.push(h('div', null, h('dt', null, 'Allergies'), h('dd', null, f.allergies.map((a, i) => [i ? ', ' : '',
        h(a.severity === 'severe' ? 'strong' : 'span', { class: a.severity === 'severe' ? 'h-food-severe' : '' }, `${a.item}${a.severity ? ` (${a.severity === 'severe' ? 'severe allergy' : a.severity})` : ''}${a.note ? `: ${a.note}` : ''}`)]))));
    } else if (f.noAllergies) add('Allergies', 'None');
    add('Avoid', f.avoid);
    add('Loves', f.love);
    add('Spice', f.spice);
    add('Drinks', [f.alcohol ? `alcohol: ${f.alcohol}` : '', f.caffeine ? `caffeine: ${f.caffeine}` : '', f.drinks].filter(Boolean).join('; '));
    add('Anything else', f.notes);
    return rows.length ? h('dl', { class: 'h-food-dl' }, rows) : h('p', { class: 'h-sub' }, 'No food answers yet.');
  }

  // ---------------------------------------------------------------- log
  // One entry as a sentence that says who did what to whom: "Mira approved Grace’s account", not
  // "Grace approved the account (by Mira)". Entries this doesn't know keep the server's text.
  function logLine(l) {
    const t = txt(l.text) || l.type;
    const who = l.name ? h('strong', null, l.name) : null;
    if (!l.byName || l.by === l.userId) return [who, who ? ' ' : '', t];
    const by = h('strong', null, l.byName);
    if (!l.userId) return [by, ' ', t]; // "Mira started the party"
    const of = () => [h('strong', null, l.name), '’s'];
    const m = (re) => re.exec(t);
    let x;
    switch (l.type) {
      case 'approve': return [by, ' approved ', ...of(), ' account'];
      case 'decline': if (t.startsWith('declined the account')) return [by, ' declined ', ...of(), ' account', t.slice('declined the account'.length)]; break;
      case 'target':
        if ((x = m(/^target set to (\d+)$/))) return [by, ' set ', ...of(), ` target to ${x[1]} words an hour`];
        if (t === 'target: default') return [by, ' set ', ...of(), ' target back to the default'];
        break;
      case 'joined': if ((x = m(/^start time set to (.+)$/))) return [by, ' set ', ...of(), ` start time to ${x[1]}`]; break;
      case 'mark-out': return [by, ' marked ', who, ' out of the challenge'];
      case 'reinstate':
        if (t === 'reinstated') return [by, ' brought ', who, ' back into the challenge'];
        if ((x = m(/^back in: (.+)$/))) return [by, ' brought ', who, ` back in: ${x[1]}`];
        break;
      case 'passes':
        if ((x = m(/^gave (\d+ pass(?:es)?)$/))) return [by, ' gave ', who, ` ${x[1]}`];
        if ((x = m(/^removed (\d+ pass(?:es)?)$/))) return [by, ` took ${x[1]} from `, who];
        break;
      case 'free-hour': if ((x = m(/\(hour (\d+)\)/))) return [by, ' gave ', who, ` an extra free hour (hour ${x[1]})`]; break;
      case 'pass':
        if ((x = m(/^gave a free hour \(hour (\d+)\), using their pass$/))) return [by, ' gave ', who, ` hour ${x[1]} off, using their own free hour`];
        if ((x = m(/^hour (\d+): counted against their free pass$/))) return [by, ' counted hour ', x[1], ' as ', ...of(), ' own free hour'];
        break;
      case 'undo':
        if ((x = m(/^hour (\d+):/))) return [by, ' undid “Exclude” on ', ...of(), ` hour ${x[1]}; it’s back in review`];
        return [by, ' undid “Mark as out” for ', who];
      case 'review-accept': if ((x = m(/^hour (\d+)/))) return [by, ' counted ', ...of(), ` flagged words in hour ${x[1]}`]; break;
      case 'review-reject': if ((x = m(/^hour (\d+)/))) return [by, ' excluded ', ...of(), ` flagged words in hour ${x[1]}`]; break;
      case 'review-undo': if ((x = m(/^hour (\d+)/))) return [by, ' undid the decision on ', ...of(), ` hour ${x[1]}`]; break;
      case 'cohost': return [by, ' made ', who, ' a co-host'];
      case 'cohost-remove': return [by, ' removed ', who, ' as a co-host'];
      case 'upload-remove': return [by, ' removed one of ', ...of(), ' images'];
      case 'unlist': case 'relist': if ((x = m(/^(unlisted|relisted) (.+)$/))) return [by, ` ${x[1]} `, ...of(), ` ${x[2]}`]; break;
      case 'account':
        if (t === 'had an email added') return [by, ' added an email to ', ...of(), ' account'];
        if ((x = m(/^had their (.+) changed$/))) return [by, ' changed ', ...of(), ` ${x[1]}`];
        break;
      case 'missed': case 'out': return [who, ` ${t}, after `, by, '’s decision'];
      default: break;
    }
    return [who, ` ${t} (by `, by, ')'];
  }
  function renderLog() {
    const items = v.log.slice(-150).reverse();
    update(logEl, JSON.stringify([items.length, items[0]?.t, items[0]?.text]), () => {
      fill(logEl, h('h2', null, 'Log'),
        items.length ? h('ol', { class: 'h-loglist' }, items.map((l) => h('li', null, h('time', null, clock(l.t)), ' ', logLine(l)))) : h('p', { class: 'muted' }, 'Nothing yet.'));
    });
  }

  // Food (SPEC §18, §20): the Food card and the drawer's answers come from food.js.
  import('./food.js').then((m) => {
    if (typeof m.mountFoodCard !== 'function' && typeof m.renderFoodSummary !== 'function') return;
    foodMod = m;
    if (v) render();
  }).catch(() => {});

  // Messages (SPEC §22): the composer card and the table's checkboxes come with notify.js.
  import('./notify.js').then((m) => {
    if (typeof m.renderNotifyComposer !== 'function') return;
    notifyMod = m;
    if (v) render();
  }).catch(() => {});

  // Help (SPEC §16) lives in another module; the Help link appears only once it loads.
  import('./help.js').then((m) => {
    if (typeof m.openHelp !== 'function') return;
    help = m;
    if (v) {
      memo.delete(top);
      renderTop();
    }
  }).catch(() => {});

  await load();
  setInterval(load, 2000);
}
