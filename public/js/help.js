// "How it works": the help sheet (SPEC §16, §17, §17b, §19). A side sheet with a scrim on desktop, a
// full-height sheet on phones; sections in an accordion; every number from the party's settings.
//
//   openHelp(section?, opts?) -> { close }
//     section  an id from helpSections ('counting', 'pasting', 'approval', 'host', ...). Unknown
//              ids open the sheet at the top. Calling it while the sheet is open jumps there.
//     opts     all optional; without them the sheet asks the server itself (GET /api/me, plus
//              /api/admin/state for hosts) and falls back to the party defaults:
//                settings     the settings object of /api/me or the host view
//                me           /api/me's `me` (isAdmin, approval, targetOverride)
//                breaks       /api/me's `breaks` (the running or next break's mode is described)
//                phase        the party's phase ('ended' opens "After the party" first)
//                role         'host' | 'writer' | 'guest'
//                partyName    shown above the title
//                returnFocus  element to focus on close (default: whatever had focus before)
//                onClose      called after the sheet has closed
//   helpSections              [{ id, title, only? }] in display order
//   howTonightWorks(settings) six short lines (strings): the goal, the clock, counting and pasting
//   setBrainstormOpener(fn)   the writer page's "Before you start" panel (SPEC §17b–c), offered in help
//
// The words follow the code that implements each rule (lib/score.js, lib/party.js, lib/hours.js,
// public/js/write.js, paste.js, editor.js, richtext.js, sync.js) and, for the first-hour rule of
// SPEC §17b and the break modes of §19, the spec. Change a rule, change its words here.

import { h, fill, fmtInt, fmtTime } from './ui.js';
import { api } from './net.js';

// The party's defaults (lib/score.js, lib/scoring.js), for any setting the page doesn't have.
const DEFAULTS = Object.freeze({
  targetPerHour: 400, hourLengthMin: 60, settleSec: 90, contextWords: 6, reuseWindowMin: 10,
  cutWeight: 0.5, cutMatureMin: 10, cutCapPerHour: null, pasteAskOverWords: 12, shortPastesCount: true,
  ownCutWindowMin: 60, speedCapWpm: 90, dictationCapWpm: 180, bigPasteWords: 100, reviewBigPastes: true,
  missedHourOutcome: 'out', freePassesPerWriter: 1, carryOverMax: 200, personalTargets: false, approvalRequired: true,
  syncMinute: 0, minFirstHourMin: 20, // hoursMode: no default here, see hoursModeOf()
});

export const helpSections = Object.freeze([
  { id: 'goal', title: 'The goal' },
  { id: 'hours', title: 'When your hours start' },
  { id: 'counting', title: 'How words count' },
  { id: 'pasting', title: 'Pasting' },
  { id: 'formatting', title: 'Formatting' },
  { id: 'privacy', title: 'Who sees what' },
  { id: 'missed', title: 'Missed hours and breaks' },
  { id: 'offline', title: 'Offline and devices' },
  { id: 'after', title: 'After the party' },
  { id: 'approval', title: 'Waiting for approval', only: 'new accounts and the sign-up page' },
  { id: 'host', title: 'Running the party', only: 'hosts' },
].map((s) => Object.freeze(s)));

const ALIASES = {
  start: 'hours', clock: 'hours', synced: 'hours', count: 'counting', words: 'counting', score: 'counting',
  paste: 'pasting', format: 'formatting', toolbar: 'formatting', markdown: 'formatting', anonymity: 'privacy',
  anonymous: 'privacy', out: 'missed', 'missing-an-hour': 'missed', free: 'missed', breaks: 'missed',
  sync: 'offline', devices: 'offline', export: 'after', anthology: 'after', end: 'after', waiting: 'approval',
  hosting: 'host', 'running-the-party': 'host', admin: 'host',
};
const idOf = (s) => {
  if (typeof s !== 'string' || !s) return null;
  const k = s.trim().toLowerCase().replace(/^#?help[-/]?/, '');
  return helpSections.some((x) => x.id === k) ? k : ALIASES[k] || null;
};

// ------------------------------------------------------------------------------- words
const n = (x) => fmtInt(x);
const plural = (x, one, many = `${one}s`) => `${n(x)} ${Math.round(x) === 1 ? one : many}`;
const mm = (m) => `:${String(((Math.round(m) % 60) + 60) % 60).padStart(2, '0')}`;
function share(w) {
  const named = { 0.25: 'a quarter of a word', 0.5: 'half a word', 0.75: 'three quarters of a word', 1: 'a whole word' };
  return named[w] || `${w} of a word`;
}
const P = (...k) => h('p', null, ...k);
const B = (...k) => h('b', null, ...k);
const keys = (...ks) => h('span', { class: 'hp-keys-k' }, ks.map((k) => h('kbd', null, k)));
const isMac = () => /Mac|iPhone|iPad|iPod/.test(navigator.platform || '') || /Mac OS X/.test(navigator.userAgent || '');
const coarse = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

// Synced hours exist only on servers that send hoursMode (SPEC §17). Settings from a server
// without it mean personal hours; no settings at all (signed out) means we can't know.
function hoursModeOf(settings, fromServer) {
  const m = settings && settings.hoursMode;
  if (m === 'synced' || m === 'personal') return m;
  return fromServer ? 'personal' : null;
}

// Everything the sections need, from a context { settings, me, role, partyName, phase, fromServer }.
function derive(ctx) {
  const raw = ctx.settings || {};
  const S = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) if (v !== undefined) S[k] = v;
  const num = (k) => (Number.isFinite(Number(S[k])) && S[k] !== null && S[k] !== '' ? Number(S[k]) : DEFAULTS[k]);
  const me = ctx.me || null;
  const role = ctx.role || (me ? (me.isAdmin ? 'host' : 'writer') : 'guest');
  const target = num('targetPerHour');
  const hourMin = num('hourLengthMin');
  const cutCap = Number.isFinite(S.cutCapPerHour) && S.cutCapPerHour !== null ? Number(S.cutCapPerHour) : target / 2;
  const own = me && Number.isFinite(me.targetOverride) && me.targetOverride !== null ? me.targetOverride : null;
  return {
    role, host: role === 'host', guest: role === 'guest', signedIn: role !== 'guest',
    approval: me ? me.approval || 'approved' : null,
    approvalOn: typeof S.approvalRequired === 'boolean' ? S.approvalRequired : true,
    approvalKnown: role === 'host' && typeof raw.approvalRequired === 'boolean',
    fromServer: !!ctx.fromServer, partyName: ctx.partyName || '', phase: ctx.phase || null,
    target, ownTarget: own, hourMin, settle: num('settleSec'), ask: num('pasteAskOverWords'),
    shortCount: S.shortPastesCount !== false, passes: num('freePassesPerWriter'), carry: num('carryOverMax'),
    out: S.missedHourOutcome !== 'alert-only', cutW: num('cutWeight'), cutMin: num('cutMatureMin'), cutCap,
    ctxWords: num('contextWords'), reuseMin: num('reuseWindowMin'), ownCutMin: num('ownCutWindowMin'), speed: num('speedCapWpm'), dictation: num('dictationCapWpm'),
    bigPaste: num('bigPasteWords'), reviewBig: S.reviewBigPastes !== false && Number.isFinite(Number(S.bigPasteWords ?? DEFAULTS.bigPasteWords)),
    personalTargets: S.personalTargets === true,
    mode: hoursModeOf(raw, ctx.fromServer), syncMin: num('syncMinute'), minFirst: num('minFirstHourMin'),
    brk: breakInView(ctx.breaks), canBrainstorm: !!brainstormOpener && role === 'writer',
    hourNow: me && me.hour && typeof me.hour === 'object' ? me.hour : null,
  };
}

// The break running now, else the next one, if its mode is known (SPEC §19): { label, startAt, endAt, mode, now }.
function breakInView(breaks) {
  const t = Date.now();
  const list = (Array.isArray(breaks) ? breaks : []).filter((b) => b && Number.isFinite(b.startAt) && Number.isFinite(b.endAt) && b.endAt > t && b.status !== 'ended');
  list.sort((a, b) => a.startAt - b.startAt);
  const b = list[0];
  if (!b || (b.mode !== 'pause' && b.mode !== 'reduce')) return null;
  return { label: String(b.label || 'Break'), startAt: b.startAt, endAt: b.endAt, mode: b.mode, now: b.startAt <= t };
}

// SPEC §17b: the writer page registers how to reopen its "Before you start" panel; help offers it.
let brainstormOpener = null;
export function setBrainstormOpener(fn) {
  brainstormOpener = typeof fn === 'function' ? fn : null;
}

// "about 7 words a minute"; "hours of 60 minutes" only matters on test parties.
const hourWord = (c) => (c.hourMin === 60 ? 'hour' : `hour (${plural(c.hourMin, 'minute')} at this party)`);

// ------------------------------------------------------------------------------- sections
// Each: { id, title, when(c), teaser(c), body(c) -> nodes }. Short paragraphs; a "why" where
// a rule might feel unfair.

// This writer's current hour, when it differs from the usual one (me.hour: SPEC §17, §17b, §19).
function hourNow(c) {
  const hr = c.hourNow;
  if (!hr || !Number.isFinite(hr.target) || !Number.isFinite(hr.endAt) || hr.endAt < Date.now()) return null;
  const until = fmtTime(hr.endAt);
  if (Array.isArray(hr.reducedBy) && hr.reducedBy.length && Number.isFinite(hr.baseTarget) && hr.target < hr.baseTarget) {
    return P(`This hour asks for ${plural(hr.target, 'word')} instead of ${n(hr.baseTarget)}, because a break takes part of it. It runs until ${until}.`);
  }
  if (hr.index === 0 && hr.extended) return P(`Your first hour runs until ${until}: the minutes before the hour joined it, and it asks for the usual ${n(hr.target)}.`);
  if (hr.index === 0 && hr.prorated) return P(`Your first hour started part-way through, so it asks for ${plural(hr.target, 'word')}, until ${until}.`);
  return null;
}

function goal(c) {
  return [
    P('The challenge is ', B(`${n(c.target)} new words`), ` every ${hourWord(c)}. Words in all your posts add up, and so do the words in their planning notes.`),
    c.ownTarget !== null ? P(`The host has set your own target to ${plural(c.ownTarget, 'word')} an hour.`) : null,
    hourNow(c),
    c.personalTargets ? P(`After your first hour, your target is tuned between 80% and 125% of ${n(c.target)}, depending on how much you cut and rework compared with everyone else. Your progress always shows it.`) : null,
    c.hourMin === 60 ? P(`That’s about ${n(c.target / 60)} words a minute, spread over the hour.`) : null,
    c.carry > 0 ? P(B('Extra words carry over. '), `Write more than your target in an hour and the extra, up to ${plural(c.carry, 'word')}, counts toward your next hour as well. Carried words can carry again, but no hour starts with more than ${n(c.carry)}. Nothing carries from a missed hour, and words flagged by the checks carry only if the host counts them.`) : null,
    c.signedIn
      ? P('Your footer keeps score: the bar fills as your words count, and the small blocks beside it are your hours so far. Tap it for the details.')
      : P('Once you’re writing, the footer at the bottom of the page keeps score: a bar for this hour, and a small block for each hour so far.'),
  ];
}

// "18:47" on a 24-hour clock, from minutes after midnight (for examples only).
const hm = (mins) => {
  const m = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
// A link to another section of the sheet.
const xref = (id, label) => h('button', { class: 'btn-link hp-xref', type: 'button', onClick: () => sheet?.reveal(id, { focus: true }) }, label);

// SPEC §17b–c: three questions, quietly above the planning notes, and an optional brainstorm.
function brainstorm(c) {
  const q = (t) => h('li', null, h('i', null, t));
  return [
    P(B('Before you start, '), 'three questions are worth a minute:'),
    h('ul', { class: 'hp-ticks' },
      q('What do you want to achieve today?'), q('What can you experiment with?'), q('What would help you become a better writer?')),
    P('They sit quietly at the top of your planning notes. To answer them, open the short, optional brainstorm: it’s offered the first time you open the editor, and “Brainstorm…” in your menu brings it back. Your answers go into your planning notes, so they count towards your first hour; the questions themselves never do.',
      c.canBrainstorm ? [' ', h('button', { class: 'btn-link hp-xref', type: 'button', onClick: () => { const go = brainstormOpener; sheet?.close({ keepFocus: true }); go?.(); } }, 'Open it now')] : null),
  ];
}

function hours(c) {
  const H = mm(c.syncMin);
  const breaksLine = P('Breaks either lower an hour’s target or pause the clock: see ', xref('missed', 'Missed hours and breaks'), '.');
  if (c.mode === 'synced') {
    const b = 19 * 60 + c.syncMin; // an hour boundary, for the examples
    const longLeft = c.minFirst <= 30 ? 30 : Math.min(59, c.minFirst + 5); // enough left: a short first hour
    const shortLeft = Math.min(13, c.minFirst - 1); // too little left: it joins the next hour
    const examples = c.hourMin === 60;
    return [
      P('Hours run on the clock, the same for everyone: from ', B(`${H} to ${H}`), '. You can start writing the moment you open the editor.'),
      P(B('Arriving mid-hour? '), c.minFirst > 0 ? `If at least ${plural(c.minFirst, 'minute')} of the hour ${c.minFirst === 1 ? 'is' : 'are'} left, your first hour is the rest of it, with a target cut to fit.` : 'Your first hour is the rest of the current one, with a target cut to fit.',
        examples ? ` Open the editor at ${hm(b - longLeft)} and your first hour asks for ${plural(Math.round((c.target * longLeft) / 60), 'word')} by ${hm(b)}.` : ''),
      shortLeft >= 1
        ? P(`With fewer than ${plural(c.minFirst, 'minute')} left, those minutes join your first full hour instead, so it’s never a race against the clock.`,
          examples ? ` Open the editor at ${hm(b - shortLeft)} and your first hour runs until ${hm(b + 60)}, with the usual ${n(c.target)}.` : '',
          ' Every word you write from the moment you arrive counts.')
        : null,
      shortLeft >= 1 ? P(`The same goes for everyone when the party starts late in an hour${examples ? `: a start at ${hm(b - shortLeft)} means a first hour until ${hm(b + 60)}` : ''}.`) : null,
      brainstorm(c),
      breaksLine,
    ];
  }
  if (c.mode === 'personal') {
    return [
      P('Your first hour starts the moment you first open the editor after the party begins. Each hour after that follows on from it, so arriving late is fine: you simply start later.'),
      brainstorm(c),
      breaksLine,
    ];
  }
  return [
    P('The host picks one of two ways, and either way you can start writing as soon as you arrive:'),
    h('ul', { class: 'hp-ticks' },
      h('li', null, B('On the clock. '), `Everyone’s hours run from ${H} to ${H}. With at least ${plural(c.minFirst, 'minute')} of an hour left, your first hour is the rest of it, on a smaller target; with less, those minutes join your first full hour.`),
      h('li', null, B('Your own clock. '), 'Your first hour starts when you first open the editor, and each hour follows on from it.')),
    brainstorm(c),
  ];
}

function meter(c) {
  const counted = Math.round(c.target * 0.45);
  const shown = Math.round(c.target * 0.53);
  return h('figure', { class: 'hp-meter' },
    h('div', { class: 'hp-meter-row' },
      h('span', { class: 'hp-meter-bar', 'aria-hidden': 'true' },
        h('span', { class: 'hp-meter-soon', style: { left: '45%', width: '8%' } }),
        h('span', { class: 'hp-meter-solid', style: { width: '45%' } })),
      h('span', { class: 'hp-meter-n' }, `≈ ${n(shown)} / ${n(c.target)} this hour`)),
    h('figcaption', null,
      h('span', { class: 'hp-key' }, h('i', { class: 'hp-sw hp-sw-solid' }), `counted (${n(counted)})`),
      h('span', { class: 'hp-key' }, h('i', { class: 'hp-sw hp-sw-soon' }), 'counting soon')));
}

function counting(c) {
  const cutting = c.cutW > 0 && c.cutCap > 0;
  return [
    meter(c),
    P('The number in your footer moves as you type. It’s marked ≈ because part of it is an estimate: the words that have counted, plus the ones about to. ', B(`A word counts once it has stayed on the page for ${plural(c.settle, 'second')}.`)),
    P(B('Why the wait? '), `It makes typos, autocorrect and second thoughts free: whatever you change within ${plural(c.settle, 'second')} never counted, so it costs you nothing. It also means typing something and deleting it can’t earn anything.`),
    P(`Words you type in the last ${plural(c.settle, 'second')} of an hour still count towards it. Whether an hour is met is decided on the words that have counted, never on the estimate. For the exact number, turn on “Show exact count” in your menu, or tap the footer.`),
    h('h4', { class: 'hp-sub-h' }, 'Each word counts once'),
    P('New words count; repeats don’t. Moving text, retyping it or pasting it again adds nothing, because you were already credited for those words. Saying it differently counts in full: new words are new.'),
    h('dl', { class: 'hp-eg' },
      h('div', null, h('dt', null, 'Cut a paragraph, paste it lower down'), h('dd', null, 'adds nothing')),
      h('div', null, h('dt', null, 'Delete a sentence, type it again'), h('dd', null, 'adds nothing')),
      h('div', null, h('dt', null, 'Rewrite it in new words'), h('dd', { class: 'is-yes' }, 'the new words count'))),
    P(`Phrases you use a lot are fine (“on the other hand”). A repeat is a run of ${n(c.ctxWords)} or more words you’ve already been credited for, or words you deleted in the last ${plural(c.reuseMin, 'minute')} and type again.`),
    P('Once a word has counted, it stays counted, even if you delete it later. Fixing letters inside a counted word adds nothing and costs nothing.'),
    cutting
      ? P(B('Cutting counts a little. '), `Deleting words that counted and have been on the page for at least ${plural(c.cutMin, 'minute')} earns ${share(c.cutW)} for each word cut, up to ${n(c.cutCap)} an hour. Cutting is real editing, so it earns something; the cap keeps it from standing in for writing. If the text comes back, by undo, paste or retyping, that credit goes again.`)
      : null,
    h('h4', { class: 'hp-sub-h' }, 'Never counts'),
    h('ul', { class: 'hp-ticks hp-ticks-no' },
      h('li', null, 'Link and image addresses. A link’s own text and an image’s description count.'),
      h('li', null, 'Text that matches another writer’s.'),
      h('li', null, `Typing beyond ${n(c.speed)} words a minute (${n(c.dictation)} when dictating). That’s far above the pace of writing; it stops text expanders and auto-typers.`)),
    P('One-letter words, like “a” and “I”, count as half a word.'),
    P(B('Quotes count when they’re your own words. '), 'A quote line (starting with ', h('code', null, '>'), ') counts like any other line you write. Copied text doesn’t count, quoted or not: pasted words count only when you say they’re yours, and text that matches another writer’s never counts.'),
    P(B('Anything unusual goes to the host, never silently removed. '), 'If an hour reaches the target only thanks to something odd (a lot of pasted text, text appearing faster than anyone types, keyboard mashing, most of the hour’s writing deleted soon after), the host takes a look and decides. Waiting for that never puts you out.'),
  ];
}

function pasting(c) {
  const mineAgain = c.ownCutMin === 60 ? 'text you cut in the last hour' : `text you cut in the last ${plural(c.ownCutMin, 'minute')}`;
  return [
    c.shortCount
      ? P(B(`Short pastes, up to ${plural(c.ask, 'word')}, count like typing.`))
      : P(B(`Short pastes, up to ${plural(c.ask, 'word')}, don’t count`), ' at this party.'),
    P(`Paste more than ${plural(c.ask, 'word')} and you’ll be asked: “Did you write any of this today, for this party?” If you didn’t, it goes in without counting. If you did, pick the parts that are yours: tap a sentence to switch it on or off, drag across words, or use the button beside each paragraph. A counter shows how many words will count.`),
    P('Some words can’t be picked, and the dialog marks them: words you’ve already been credited for, and words that match another writer’s text. If none of it could count, it goes straight in without asking.'),
    P(B('Pasting your own words again never counts'), `, whatever the length: text in any of your posts or notes, ${mineAgain}, or anything you’ve pasted before.`),
    P(B('Why ask at all? '), 'The party is about writing done today, so pasted text counts only when you say it’s yours, from today.'),
    c.reviewBig ? P(`If an hour needs ${n(c.bigPaste)} or more pasted words to reach the target, the host takes a quick look before it counts as met.`) : null,
    P('Formatting comes with you: pasting from Google Docs, Word, Notion, Apple Notes or a web page keeps headings, bold, italic, links and lists. Opening a file (.md, .txt, .docx, .html) or dropping one in asks the same question as a paste.'),
  ];
}

function formatting(c) {
  const mod = isMac() ? '⌘' : 'Ctrl';
  const shift = isMac() ? '⇧' : 'Shift';
  const alt = isMac() ? '⌥' : 'Alt';
  const redo = isMac() ? keys('⌘', '⇧', 'Z') : keys('Ctrl', 'Y');
  const md = (code, out) => h('div', { class: 'hp-md-row' }, h('code', null, code), h('span', { class: 'hp-md-out' }, out));
  const toolbarDesk = P(B('On a computer, '), 'select some text and a small toolbar appears above it: bold, italic, heading, lists, quote, link, image, footnote, undo and redo.');
  const toolbarPhone = P(B('On a phone, '), 'the toolbar sits just above the keyboard. Hide it with the arrow at its end; it comes back whenever you select text.');
  return [
    P('Your writing is formatted as you go: headings, bold, italic, lists, quotes and links look like the finished thing. The marks behind them (like ', h('code', null, '**'), ' or ', h('code', null, '#'), ') show only on the line you’re editing.'),
    ...(coarse() ? [toolbarPhone, toolbarDesk] : [toolbarDesk, toolbarPhone]),
    ...(coarse() ? [P(B('With a keyboard, '), 'the usual shortcuts work: ', keys(mod, 'B'), ' bold, ', keys(mod, 'I'), ' italic, ', keys(mod, 'K'), ' link.')] : [
    h('h4', { class: 'hp-sub-h' }, 'Shortcuts'),
    h('dl', { class: 'hp-keys' },
      h('div', null, h('dt', null, 'Bold'), h('dd', null, keys(mod, 'B'))),
      h('div', null, h('dt', null, 'Italic'), h('dd', null, keys(mod, 'I'))),
      h('div', null, h('dt', null, 'Link'), h('dd', null, keys(mod, 'K'))),
      h('div', null, h('dt', null, 'Footnote'), h('dd', null, keys(mod, alt, 'F'))),
      h('div', null, h('dt', null, 'Bulleted list'), h('dd', null, keys(mod, shift, '8'))),
      h('div', null, h('dt', null, 'Numbered list'), h('dd', null, keys(mod, shift, '7'))),
      h('div', null, h('dt', null, 'Undo'), h('dd', null, keys(mod, 'Z'))),
      h('div', null, h('dt', null, 'Redo'), h('dd', null, redo)),
      h('div', null, h('dt', null, 'Find'), h('dd', null, keys(mod, 'F'))))]),
    h('h4', { class: 'hp-sub-h' }, 'Or type it'),
    h('div', { class: 'hp-md' },
      md('# Title', h('span', { class: 'hp-md-h' }, 'Heading')),
      md('## Section', h('span', { class: 'hp-md-h2' }, 'Smaller heading')),
      md('- item', h('span', null, '• Bulleted list')),
      md('1. item', h('span', null, '1. Numbered list')),
      md('**bold**', h('b', null, 'bold')),
      md('*italic*', h('i', null, 'italic')),
      md('[text](https://…)', h('span', { class: 'hp-md-a' }, 'a link')),
      md('> quote', h('span', { class: 'hp-md-q' }, 'A quote')),
      md(['word[^1]', h('br'), '[^1]: the note'], h('span', null, 'word', h('sup', null, '1'), ', and note 1 at the end')),
      md('---', h('span', { class: 'hp-md-hr', role: 'img', 'aria-label': 'a dividing line' }))),
    P('Press Enter on an empty list item to end the list.'),
    P(B('Smart punctuation: '), 'quotes curl as you type, two hyphens make a dash (—) and three dots an ellipsis (…). You can switch it off in your menu.'),
    P(B('Links: '), 'paste or type a web address and it becomes a link; tap a link to open, edit or remove it. Addresses never count as words.'),
    P(B('Footnotes: '), 'put the caret where the note belongs and press the footnote button (or ', keys(mod, alt, 'F'), '): a small number goes into the text and its note to the end of the post, ready to type. Press Enter in a note to keep writing it on the next line; Enter on that line while it’s empty ends the note, and Shift+Enter starts a new paragraph in it.'),
    P(B('Images: '), 'paste one, drop one in, or use the Image button (on a phone, that includes the camera). Before they’re stored, images are shrunk and stripped of hidden details such as where the photo was taken, which matters for anonymous posts. Tap an image to describe it for readers who can’t see it: the description counts like your other words (the image itself doesn’t). You can add up to 40 images (60 MB) in all.'),
  ];
}

function privacy(c) {
  const mode = (dot, name, desc) => h('li', null, h('span', { class: `w-dot dot-${dot}`, 'aria-hidden': 'true' }), h('b', { class: 'hp-mode-name' }, name), h('span', { class: 'hp-mode-desc' }, desc));
  return [
    P('Each post has its own setting, in the label under its title. You can change it while the party runs; after it ends, a change needs a short reason, which the hosts see.'),
    h('ul', { class: 'hp-modes' },
      mode('live', 'Public live · no name', 'Every new post starts here. It appears on the live page as you write, with no name on it. Its address is random, but someone watching closely could connect your posts by when they change; for a post you want kept apart, choose “At the end · separate identity”.'),
      mode('named', 'Public live · signed', 'It appears live as you write, with your name on it.'),
      mode('separate', 'At the end · separate identity', 'Not streamed. Published when the party ends, with nothing linking it to your other posts. Choose it before you start writing: text already shown live can still be recognised.'),
      mode('private', 'Private · never published', 'Never published, not even after the party, and it still counts for the challenge. Hosts can read it if they check your hours.')),
    P('Titles are public along with their posts. ', B('Planning notes are never streamed or published.')),
    P(B('The public list of writers'), ' is off unless you turn it on in Your account. It shows your display name, how many hours you’ve met (and if you’re out of the challenge) and the posts you signed with your name; never your other posts. Posts you star come first there: open My page from your menu and star them there (a tab’s menu has Star on my page too).'),
    P(B('The hosts see everything: '), 'your name, all your posts in every mode, your planning notes and what you pasted. Hosts can also hide a post from the public pages.'),
    P('Closing a post only tidies your tabs: it still counts, and it’s still published (unless it’s private).'),
    P('Each tab has a menu: its ⋯ button, or right-click the tab (Control-click on a Mac); on a phone, tap ⋯ or press and hold the tab. To reorder your tabs, drag one, use Move left / Move right in that menu, or Alt+Shift+← / →. The order follows you to your other devices.'),
  ];
}

function breakModes(c) {
  const reduced = Math.round((c.target * 30) / 60);
  const item = (name, desc) => h('li', null, h('b', { class: 'hp-mode-name' }, name), h('span', { class: 'hp-mode-desc' }, desc));
  return h('ul', { class: 'hp-modes hp-modes-plain' },
    item('Keep the clock, lower the target', `Hours stay where they are, and any hour the break overlaps asks for fewer words, in proportion: a 30-minute dinner makes that hour’s target ${n(reduced)} instead of ${n(c.target)}.`),
    item('Pause the clock', `Your hour stops for the break and picks up where it left off afterwards, so later hours start later${c.mode === 'synced' ? ', for everyone at once' : ''}.`));
}
function breakNow(c) {
  const b = c.brk;
  if (!b) return null;
  const when = `${fmtTime(b.startAt)}–${fmtTime(b.endAt)}`;
  const mins = Math.round((b.endAt - b.startAt) / 60000);
  const what = b.mode === 'reduce'
    ? `the clock keeps running, and the hour it falls in asks for fewer words${mins > 0 && mins < 60 && c.hourMin === 60 ? `: in a full hour, ${mins} minutes of break take ${n(c.target)} down to ${n(Math.round((c.target * (60 - mins)) / 60))}` : ''}. A break that spans two hours lowers each by its part.`
    : 'your hour pauses for it and picks up where it left off.';
  return h('p', { class: 'hp-callout' }, B(`${b.label}, ${when}${b.now ? ' (now)' : ''}: `), what);
}

function missed(c) {
  const seg = (cls, label) => h('li', null, h('i', { class: `seg seg-${cls}`, 'aria-hidden': 'true' }), label);
  return [
    c.out
      ? P(B('If an hour ends below your target, you’re out of the challenge.'), ' You can keep writing: your posts still stream and go in the anthology. The host can let you back in, but only for a very good reason.')
      : P(B('If an hour ends below your target, the host is told.'), ' Nobody is put out of the challenge.'),
    P('If you’re falling behind, you’ll get a gentle warning with 15 and with 5 minutes to go.'),
    c.passes > 0
      ? P(B('Free hours. '), `You have ${c.passes === 1 ? 'one free hour' : `${n(c.passes)} free hours`}. “Take this hour off”, in your menu, in the details or in the warning, excuses this hour, at any point in it, or the next one if you choose. What you write still counts and is published. The host can give you more.`)
      : P(B('Free hours. '), 'There are none to take at this party, but the host can give you one.'),
    P('An hour waiting for the host’s review never puts you out by itself, and an hour cut short by the end of the party never counts as missed.'),
    h('h4', { class: 'hp-sub-h' }, 'Breaks'),
    P('The host can call a break for everyone, say for dinner. Writing is never blocked, and words written during a break still count. A break works in one of two ways:'),
    breakModes(c),
    breakNow(c) || P('The host picks one for each break, and the live page shows when you’re back.'),
    h('h4', { class: 'hp-sub-h' }, 'Your hours, in the footer'),
    h('ul', { class: 'hp-legend' },
      seg('met', 'met'), seg('missed', 'missed'), seg('free', 'free'), seg('break', 'break'), seg('current', 'this hour'), seg('review', 'waiting for the host’s check')),
  ];
}

function offline() {
  return [
    P(B('If the connection drops, keep writing.'), ' Every change is kept on this device and sent when you’re back; meanwhile the footer says “Offline”.'),
    P('Closing the tab is safe too: your words wait on this device and go out the next time you open Writehaven on it. Once you’ve opened Writehaven on a device, it can even open there without a connection.'),
    P('Words written offline count for the time you wrote them. If they reach the server after their hour has ended, and that hour needs them to reach the target, the host takes a quick look first, so a late upload can’t quietly change a finished hour.'),
    P(B('Several tabs or devices are fine,'), ' a laptop and a phone at once included. If two of them change the same post, both sets of words are kept.'),
  ];
}

function after() {
  return [
    P('When the host ends the party, the hours stop for everyone and ', B('the anthology'), ' opens: every published post, separate-identity ones included, in a random order with no times on them, so nothing links one post to another. Anonymous posts stay anonymous; private posts, empty posts and posts the host hid are left out.'),
    P(B('Changed your mind about a post? '), 'You can still edit it: changes save as you type, they don’t count for the challenge, and the post’s page says “Edited after the party”. Removing a large part at once (50 words or more) asks for a short reason, which the hosts see, and so does changing who sees a post (the label under its title).'),
    P(B('Something to add? '), 'You can start a new post after the party too (feedback, say). It’s private unless you choose to publish it, and it doesn’t count for the challenge; if you publish it, its page says “Added after the party”.'),
    P(B('Your posts are yours to keep.'), ' From your menu, export one post or all of them, any time: Markdown, plain text, a web page, Word (.docx), PDF (via Print), or an e-book (.epub) of everything.'),
    P('“Copy for LessWrong, Substack or Google Docs” copies a post with its formatting, ready to paste.'),
  ];
}

function approval(c) {
  if (c.approval === 'declined') {
    return [
      P('The host didn’t approve this account. If they left a note, it’s on your screen.'),
      P('You can still watch the live page. If you think it’s a mistake, send the host a short message: sending one asks again.'),
      P('Accounts that aren’t approved never appear on the public pages.'),
    ];
  }
  return [
    P(c.guest ? 'If the host has approval switched on, new accounts wait for the host to approve them before they can write.' : 'New accounts wait for the host to approve them before they can write.',
      ' The host does it by hand, so it can take a few minutes.'),
    P('Meanwhile you can watch the live page, and send the host a short message, like “Hi, it’s Ruth from the book club”. You can edit it any time.'),
    P('Leave the page open: it moves on by itself the moment you’re approved. Your hours don’t start before that.'),
    P('If the host declines, you’ll see their note, if they left one, and sending a new message asks again.'),
    P('Accounts waiting for approval never appear on the public pages.'),
  ];
}

function hostSection(c) {
  const item = (lead, ...rest) => h('li', null, B(lead), ' ', ...rest);
  const approvalState = c.approvalKnown ? ` Approval is ${c.approvalOn ? 'on' : 'off'}; switch it under “Invite writers”.` : ' Switch approval on or off under “Invite writers”.';
  return [
    P('Your dashboard shows what needs you at the top, then every writer, by urgency.'),
    h('ul', { class: 'hp-host' },
      item('Approvals.', `New sign-ups wait in “Waiting for approval”: Approve, Decline (with an optional note they’ll see) or Approve all. Each new request, and each edited message, chimes.${approvalState}`),
      item('Reviews.', `An hour that reaches the target only with flagged words (a big paste, text that appeared at once, keyboard mashing, late offline work…) waits under “Needs you”, with the text and the words at stake. “Count these words” meets the hour; “Don’t count” misses it${c.out ? ', which puts the writer out' : ''}. You can undo a “Don’t count” for 2 minutes.`),
      c.out
        ? item('Out and back in.', 'A missed hour puts the writer out and alerts you with a chime (and a browser notification, once you turn them on). “Let back in…” is on the alert and in their details, next to “Mark as out…”, which you can undo for 2 minutes.')
        : item('Missed hours.', 'They alert you with a chime (and a browser notification, once you turn them on); nobody is put out. You can still mark someone as out from their details.'),
      item('Free hours.', `${c.passes > 0 ? `Everyone has ${c.passes === 1 ? 'one free hour' : `${n(c.passes)} free hours`} of their own. ` : ''}In a writer’s details you can give them this hour or the next one off${c.passes > 0 ? ' (without using theirs)' : ''}, or an extra pass.`),
      item('Breaks.', 'Give the break a name, minutes and a start time (empty starts it now), and choose what it does: “Keep the clock, lower the target” or “Pause the clock” (both are explained under ', xref('missed', 'Missed hours and breaks'), `).${c.mode === 'synced' ? ' With hours on the clock, the form starts on “Keep the clock”.' : c.mode === 'personal' ? ' With personal hours, the form starts on “Pause the clock”.' : ''} Writing is never blocked. Later you can change a break’s mode (with a preview of the hours that change), end it early or cancel a planned one.`),
      c.mode === 'synced' && c.minFirst > 0 ? item('Late arrivals.', `Writers start the moment they open the editor. With fewer than ${plural(c.minFirst, 'minute')} left in an hour, those minutes join their first full hour; with more, their first hour is the rest of this one, on a smaller target.`) : null,
      item('Settings.', 'While the party runs, changing a setting or a writer’s target shows a preview first: which finished hours would change. Saving re-scores everyone in the background.'),
      item('Writers.', 'Click a name for everything: their posts in every mode, planning notes and pastes, plus actions such as a new start time, a new password or hiding a post.'),
      item('Ending.', '“End the party…” stops typing for everyone. Hours in progress don’t count as missed, separate-identity posts are published, unlinked, and the anthology opens. It can’t be undone.')),
  ];
}

const SECTIONS = [
  { id: 'goal', when: () => true, teaser: (c) => `${n(c.target)} new words an hour`, body: goal },
  {
    id: 'hours', when: () => true, body: hours,
    teaser: (c) => (c.mode === 'synced' ? `On the clock, ${mm(c.syncMin)} to ${mm(c.syncMin)}` : c.mode === 'personal' ? 'From when you first open the editor' : 'On the clock, or from when you start'),
  },
  { id: 'counting', when: () => true, teaser: (c) => `A word counts after ${plural(c.settle, 'second')}`, body: counting },
  { id: 'pasting', when: () => true, teaser: (c) => `Over ${plural(c.ask, 'word')}? You’ll be asked`, body: pasting },
  { id: 'formatting', when: () => true, teaser: () => 'Toolbar, shortcuts and Markdown', body: formatting },
  { id: 'privacy', when: () => true, teaser: () => 'You choose, post by post', body: privacy },
  { id: 'missed', when: () => true, teaser: (c) => (c.out ? 'Miss one and you’re out; you keep writing' : 'The host is told; nobody is out'), body: missed },
  { id: 'offline', when: () => true, teaser: () => 'Keep writing; it catches up', body: offline },
  { id: 'after', when: () => true, teaser: () => 'The anthology, and your own copies', body: after },
  {
    id: 'approval', when: (c) => (c.guest ? true : !c.host && c.approval !== 'approved'), body: approval,
    teaser: (c) => (c.approval === 'declined' ? 'What you can do now' : c.guest ? 'Why new accounts may wait' : 'Why you’re waiting'),
  },
  { id: 'host', when: (c) => c.host, teaser: () => 'Approvals, reviews, breaks, the end', body: hostSection },
].map((s) => ({ ...s, title: helpSections.find((x) => x.id === s.id).title }));

function lede(c) {
  if (c.guest) return `A live writing party: everyone writes ${n(c.target)} new words an hour, and the writing streams to the live page as it happens, anonymously unless you choose otherwise.`;
  return `Write ${n(c.target)} new words an hour, in as many posts as you like. Everything else is detail, and it’s all here.`;
}
function footNote(c) {
  if (c.fromServer) return 'Every number here is this party’s current setting.';
  return 'These are the usual numbers; once you’re signed in, this page shows the party’s own.';
}

// ------------------------------------------------------------------------------- waiting room
// Six short lines for the waiting room (SPEC §17): the goal, the clock, counting and pasting.
export function howTonightWorks(settings = {}) {
  const c = derive({ settings: settings || {}, fromServer: true, role: 'writer' });
  const H = mm(c.syncMin);
  // Callers pick lines by position (live.js: 0, 1, 2 and 5), so the order and count stay fixed.
  const lines = [`Write ${n(c.target)} new words each ${hourWord(c)}. Posts and planning notes both count.${c.carry > 0 ? ` Up to ${plural(c.carry, 'word')} over the target carry on to your next hour.` : ''}`];
  if (c.mode === 'synced') {
    lines.push(c.minFirst > 0
      ? `Hours run on the clock, ${H} to ${H}, and you can start writing now. With ${plural(c.minFirst, 'minute')} or more left, your first hour is the rest of this one, on a smaller target; with less, those minutes join your first full hour.`
      : `Hours run on the clock, ${H} to ${H}, and you can start writing now: your first hour is the rest of this one, on a smaller target.`);
  } else lines.push('Your first hour starts when you first open the editor; each hour follows on from it.');
  lines.push(`A word counts once it has stayed on the page for ${plural(c.settle, 'second')}, so typos and quick changes never cost you.`);
  lines.push('Each word counts once: rewriting counts, but moving, retyping or re-pasting your own words doesn’t.');
  lines.push(`${c.shortCount ? `Pastes of up to ${plural(c.ask, 'word')} count like typing; longer` : `Pastes of up to ${plural(c.ask, 'word')} don’t count; longer`} ones ask which words you wrote today.`);
  lines.push(`${c.out ? 'Miss an hour and you’re out, though you can keep writing' : 'A missed hour is flagged to the host'}${c.passes > 0 ? `; you have ${c.passes === 1 ? 'one free hour' : `${n(c.passes)} free hours`}.` : '.'}`);
  return lines;
}

// ------------------------------------------------------------------------------- context
const STORE_KEY = 'wh-help-settings';
function remember(settings) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(settings || {}));
  } catch { /* private mode */ }
}
function recall() {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}
// The signed-in user this device remembers (net.js keeps it for offline starts), for a first guess.
function rememberedUser() {
  try {
    const v = JSON.parse(localStorage.getItem('wh-session') || 'null');
    return v && v.user ? v.user : null;
  } catch {
    return null;
  }
}

let lastCtx = null;
async function loadContext() {
  // Signed out: the usual numbers, without asking the server for an account it would refuse.
  if (!rememberedUser()) throw new Error('signed out');
  try {
    const v = await api('/api/me', undefined, { timeoutMs: 8000 });
    const ctx = { settings: { ...(v.settings || {}) }, me: v.me || null, partyName: v.party?.name || '', phase: v.party?.phase || null, breaks: v.breaks || null, fromServer: true };
    if (v.me && v.me.isAdmin) {
      const hv = await api('/api/admin/state', undefined, { timeoutMs: 8000 }).catch(() => null);
      if (hv && hv.settings) Object.assign(ctx.settings, hv.settings);
      if (hv && hv.party && Array.isArray(hv.party.breaks)) ctx.breaks = hv.party.breaks;
    }
    remember(ctx.settings);
    return ctx;
  } catch (e) {
    if (e && e.status === 401) return { me: null, settings: {}, fromServer: false };
    // Offline or a server hiccup: what this device knows.
    const stored = recall();
    const user = rememberedUser();
    return { me: user, settings: stored || {}, fromServer: !!stored };
  }
}
function guessContext() {
  if (lastCtx) return lastCtx;
  const stored = recall();
  const user = rememberedUser();
  return { me: user, settings: stored || {}, fromServer: !!(stored && user) };
}

// ------------------------------------------------------------------------------- focus
// Recently focused elements, newest last: the opener when a menu item (already gone) opened us.
const focusTrail = [];
if (typeof document !== 'undefined') {
  document.addEventListener('focusin', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement) || t.closest('.hp')) return;
    const i = focusTrail.indexOf(t);
    if (i >= 0) focusTrail.splice(i, 1);
    focusTrail.push(t);
    if (focusTrail.length > 8) focusTrail.shift();
  }, true);
}
function openerNow() {
  const a = document.activeElement;
  if (a && a !== document.body && a instanceof HTMLElement && a.isConnected && !a.closest('.hp')) return a;
  for (let i = focusTrail.length - 1; i >= 0; i--) if (focusTrail[i].isConnected) return focusTrail[i];
  return null;
}
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';
function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => {
    if (!el.getClientRects().length) return false;
    if (typeof el.checkVisibility === 'function') return el.checkVisibility({ visibilityProperty: true });
    return getComputedStyle(el).visibility !== 'hidden';
  });
}
const onHostPage = () => typeof location !== 'undefined' && location.pathname.replace(/\/+$/, '') === '/host';
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// ------------------------------------------------------------------------------- the sheet
let sheet = null;

export function openHelp(section, opts = {}) {
  const want = idOf(section);
  if (sheet && !sheet.closing) {
    sheet.reveal(want, { focus: true });
    return { close: sheet.close };
  }
  if (sheet) sheet.finish();
  sheet = createSheet(want, opts || {});
  return { close: sheet.close };
}

function createSheet(want, opts) {
  const given = opts.settings || opts.me || opts.role;
  let ctx = given
    ? { settings: opts.settings || {}, me: opts.me || null, role: opts.role, partyName: opts.partyName || '', phase: opts.phase || null, breaks: opts.breaks || null, fromServer: !!opts.settings }
    : guessContext();
  if (opts.partyName) ctx = { ...ctx, partyName: opts.partyName };
  const opener = opts.returnFocus || openerNow();

  const title = h('h2', { class: 'hp-title', id: 'hp-title', tabindex: '-1' }, 'How it works');
  const kicker = h('p', { class: 'hp-kicker' });
  const xBtn = h('button', { class: 'btn-icon hp-x', type: 'button', 'aria-label': 'Close' }, '×');
  const head = h('header', { class: 'hp-head' }, h('div', null, kicker, title), xBtn);
  const ledeEl = h('p', { class: 'hp-lede' });
  const allBtn = h('button', { class: 'btn-link hp-all', type: 'button' }, 'Open all');
  const list = h('ol', { class: 'hp-list' });
  const note = h('p', { class: 'hp-note' });
  const scroller = h('div', { class: 'hp-scroll' }, ledeEl, h('div', { class: 'hp-tools' }, allBtn), list, note);
  const doneBtn = h('button', { class: 'btn hp-done', type: 'button' }, 'Close');
  const foot = h('div', { class: 'hp-foot' }, doneBtn);
  const dlg = h('dialog', { class: 'hp is-instant', 'aria-labelledby': 'hp-title' }, h('div', { class: 'hp-in' }, head, scroller, foot));

  const secs = new Map(); // id -> { li, btn, sub, text, open }
  let openIds = new Set();
  let pending = want; // a requested section that may only appear once the context is known
  let pendingFocus = !!want; // asked for by the caller: its button takes the focus
  let renderedKey = '';
  const self = { closing: false, finished: false };

  function sectionEl(def) {
    const btnId = `hp-t-${def.id}`;
    const bodyId = `hp-b-${def.id}`;
    const num = h('span', { class: 'hp-n', 'aria-hidden': 'true' });
    const sub = h('span', { class: 'hp-teaser' });
    const btn = h('button', { class: 'hp-tog', type: 'button', id: btnId, 'aria-expanded': 'false', 'aria-controls': bodyId },
      num, h('span', { class: 'hp-t' }, def.title, def.id === 'host' ? h('span', { class: 'hp-tag' }, 'Host') : null),
      h('span', { class: 'hp-chev', 'aria-hidden': 'true' }), sub);
    const text = h('div', { class: 'hp-text' });
    const body = h('div', { class: 'hp-body', id: bodyId }, h('div', { class: 'hp-clip' }, text));
    const li = h('li', { class: `hp-sec hp-sec-${def.id}`, 'data-id': def.id }, h('h3', { class: 'hp-h' }, btn), body);
    const s = { li, btn, sub, text, num, open: false };
    btn.addEventListener('click', () => {
      setOpen(def.id, !s.open);
      syncAll();
    });
    return s;
  }
  function setOpen(id, open) {
    const s = secs.get(id);
    if (!s) return;
    s.open = open;
    if (open) openIds.add(id);
    else openIds.delete(id);
    s.li.classList.toggle('is-open', open);
    s.btn.setAttribute('aria-expanded', String(open));
  }
  const visibleIds = () => [...list.children].map((li) => li.dataset.id);
  function syncAll() {
    const ids = visibleIds();
    const all = ids.length > 0 && ids.every((id) => secs.get(id)?.open);
    allBtn.textContent = all ? 'Close all' : 'Open all';
    allBtn.setAttribute('aria-pressed', String(all));
  }
  allBtn.addEventListener('click', () => {
    const ids = visibleIds();
    const all = ids.every((id) => secs.get(id)?.open);
    for (const id of ids) setOpen(id, !all);
    syncAll();
  });

  function render() {
    const c = derive(ctx);
    const key = JSON.stringify([c, isMac(), coarse()]);
    if (key === renderedKey) return;
    renderedKey = key;
    kicker.textContent = c.partyName || 'Writehaven';
    ledeEl.textContent = lede(c);
    note.textContent = footNote(c);
    const shown = SECTIONS.filter((d) => d.when(c));
    // On the host dashboard, the host's own section comes first.
    if (c.host && onHostPage()) shown.sort((a, b) => (b.id === 'host') - (a.id === 'host'));
    for (const [id, s] of secs) if (!shown.some((d) => d.id === id)) s.li.remove();
    shown.forEach((def, i) => {
      let s = secs.get(def.id);
      if (!s) {
        s = sectionEl(def);
        secs.set(def.id, s);
        if (openIds.has(def.id)) setOpen(def.id, true);
      }
      s.num.textContent = String(i + 1);
      s.sub.textContent = def.teaser(c);
      fill(s.text, ...def.body(c));
      // Move a section only if it's out of place: moving the one holding the focus would drop it.
      if (list.children[i] !== s.li) list.insertBefore(s.li, list.children[i] || null);
    });
    syncAll();
  }

  function reveal(id, { focus = false, instant = false } = {}) {
    const s = id && secs.get(id);
    if (!s || !s.li.isConnected) return false;
    if (instant) dlg.classList.add('is-instant');
    setOpen(id, true);
    syncAll();
    const y = Math.max(0, s.li.offsetTop - 8);
    scroller.scrollTop = y;
    if (focus) s.btn.focus({ preventScroll: true });
    if (instant) requestAnimationFrame(() => requestAnimationFrame(() => dlg.classList.remove('is-instant')));
    return true;
  }
  self.reveal = (id, o) => {
    if (reveal(id, o)) return;
    pending = id;
    pendingFocus = true;
  };

  // A first section: the one asked for, else what matters most right now.
  const defaultFirst = (c) => (onHostPage() ? 'host' : c.approval === 'pending' || c.approval === 'declined' ? 'approval' : c.phase === 'ended' ? 'after' : 'goal');
  const first = want || defaultFirst(derive(ctx));
  openIds = new Set([first]);
  render();
  if (!secs.has(first)) {
    if (given) setOpen(defaultFirst(derive(ctx)), true); // asked for a section this viewer doesn't have
    else pending = first; // it may appear once the server has answered
  }

  // ---- open
  document.body.append(dlg);
  document.documentElement.classList.add('hp-open');
  dlg.showModal();
  if (want && reveal(want, { focus: true })) pending = null;
  else title.focus({ preventScroll: true });
  dlg.getBoundingClientRect(); // start the slide from off-screen
  dlg.classList.add('is-open');
  requestAnimationFrame(() => requestAnimationFrame(() => dlg.classList.remove('is-instant')));

  // ---- the server's numbers (unless the caller gave them)
  if (!given) {
    loadContext().catch(() => guessContext()).then((fresh) => {
      if (self.finished) return;
      lastCtx = fresh;
      ctx = opts.partyName ? { ...fresh, partyName: opts.partyName } : fresh;
      render();
      if (pending && !reveal(pending, { focus: pendingFocus && document.activeElement === title }) && !openIds.size) {
        setOpen(defaultFirst(derive(ctx)), true);
        syncAll();
      }
      pending = null;
    });
  }

  // ---- close
  function finish() {
    if (self.finished) return;
    self.finished = true;
    self.closing = true;
    if (dlg.open) dlg.close();
    dlg.remove();
    document.documentElement.classList.remove('hp-open');
    if (sheet === self) sheet = null;
    const back = !self.keepFocus && opener && opener.isConnected ? opener : null;
    if (back) {
      try {
        back.focus({ preventScroll: true });
      } catch { /* not focusable any more */ }
    }
    try {
      opts.onClose?.();
    } catch (e) {
      console.error(e);
    }
  }
  // keepFocus: something else takes the focus next (an action started from the sheet).
  function close({ keepFocus = false } = {}) {
    if (self.closing) return;
    self.closing = true;
    self.keepFocus = keepFocus;
    dlg.classList.remove('is-open');
    if (reducedMotion()) {
      finish();
      return;
    }
    const onEnd = (e) => {
      if (e.target === dlg && e.propertyName === 'transform') finish();
    };
    dlg.addEventListener('transitionend', onEnd);
    setTimeout(finish, 420); // no transition (or no transitionend): close anyway
  }
  self.close = close;
  self.finish = finish;

  xBtn.addEventListener('click', () => close());
  doneBtn.addEventListener('click', () => close());
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  dlg.addEventListener('close', finish); // closed by the browser (a second Escape)
  let downOutside = false;
  dlg.addEventListener('pointerdown', (e) => {
    downOutside = e.target === dlg;
  });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg && downOutside) close();
    downOutside = false;
  });
  // Tab and Shift+Tab stay inside the sheet.
  dlg.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const f = focusables(dlg);
    if (!f.length) return;
    const a = document.activeElement;
    const i = f.indexOf(a);
    if (e.shiftKey && i <= 0) {
      e.preventDefault();
      f[f.length - 1].focus();
    } else if (!e.shiftKey && (i === f.length - 1 || i === -1) && a !== title) {
      e.preventDefault();
      f[0].focus();
    }
  });
  scroller.addEventListener('scroll', () => head.classList.toggle('is-scrolled', scroller.scrollTop > 2), { passive: true });

  return self;
}
