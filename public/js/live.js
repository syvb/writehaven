// Public pages: the live wall (every streamed post as it's written), its projector
// view, the anthology after the party, and single post pages.
//
// Cost model (built for 60 posts streaming to phones and a projector laptop):
// - stream events only update a model; one requestAnimationFrame paints what changed;
// - only cards on or near the screen are painted (IntersectionObserver); the rest are
//   marked dirty and painted when they scroll in;
// - a card holds a window of its text around the writer's caret, anchored to the bottom
//   by CSS (no scroll or size reads), and an edit re-renders only the blocks from the
//   edit to the end of that window;
// - only the newest chunk of text carries the ink class (one fading element per card).

import { h, fill, fmtInt, fmtWhen, plural, helpLink } from './ui.js';
import { api, stream } from './net.js';
import { renderBlocks, renderNotes, wordsIn } from './md-render.js';
import { footnotes } from './footnotes.js';
import { WORD_SCAN_MAX } from './text.js';

const ACTIVE_MS = 3 * 60_000; // a post counts as recently written for ordering this long
const REORDER_MS = 10_000; // the grid reorders itself at most this often
const INK_MS = 1600; // a chunk older than this when painted gets no ink
const BACK = 1400; // characters of context kept above the writer's caret
const AFTER = 280; // characters shown after the caret when the writer edits mid-text
const WINDOW_MAX = 3600; // re-window once the rendered text grows past this
const ROTATE_MS = 15_000; // projector: one card changes this often
const DWELL_MS = 40_000; // projector: a card stays at least this long

// ---------------------------------------------------------------- small helpers
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
// Times are shown in the viewer's own time zone, 24-hour (SPEC §24), from epoch ms.
const clockFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const clockAt = (ms) => clockFmt.format(ms);
// Break copy by mode (SPEC §19): 'reduce' keeps the clock and lowers this hour's target (said as
// a number when known), 'pause' (the default) stops every writer's clock until the break ends.
export function breakLine(b, target = null) {
  const at = clockAt(b.endAt);
  if (b.mode !== 'reduce') return `hours resume at ${at}`;
  return Number.isFinite(target) ? `until ${at} · this hour needs ${fmtInt(target)} words` : `until ${at} · this hour needs fewer words`;
}
// The party's shared hour (synced hours only): the server's `party.hour` when it sends one, else
// the window ending at `nextHourAt`, its target lowered by a keep-the-clock break inside it the
// way the scorer lowers it. -> { n (1-based, or null when unknown), endAt, target } | null
function sharedHour(p, now) {
  const r = p?.rules || {};
  if (!p || (p.hoursMode ?? r.hoursMode) !== 'synced') return null;
  const hr = p.hour;
  if (hr && Number.isFinite(hr.endAt)) {
    return { n: Number.isFinite(hr.n) ? hr.n : Number.isFinite(hr.k) ? hr.k + 1 : null, endAt: hr.endAt, target: Number.isFinite(hr.target) ? hr.target : null };
  }
  const endAt = p.nextHourAt;
  if (!Number.isFinite(endAt) || endAt <= now) return null;
  const H = (Number(r.hourLengthMin) > 0 ? Number(r.hourLengthMin) : 60) * 60_000;
  const base = Number(r.targetPerHour) > 0 ? Number(r.targetPerHour) : null;
  if (base === null) return { n: null, endAt, target: null };
  const startAt = endAt - H;
  let overlap = 0;
  for (const b of [p.breaks?.active, p.breaks?.next]) {
    if (b && b.mode === 'reduce') overlap += Math.max(0, Math.min(endAt, b.endAt) - Math.max(startAt, b.startAt));
  }
  return { n: null, endAt, target: Math.round(base * (Math.max(0, H - overlap) / H)) };
}
// help.js's hours line, for before the start: "you can start writing now" isn't true yet, and
// "Hours run on the clock, :00 to :00" reads better as "each starting on the hour".
function lobbyClock(line) {
  const t = line.replace(/, and you can start writing now\b[\s\S]*$/, '.');
  const m = /^Hours run on the clock, :(\d\d) to :\1\.$/.exec(t);
  if (!m) return t;
  const at = Number(m[1]) === 0 ? 'on the hour' : Number(m[1]) === 30 ? 'at half past' : `at :${m[1]}`;
  return `Hours run on the clock, each one starting ${at}, the same for everyone.`;
}
// Four rules for the projector's lobby, in large type: the party's numbers (party.rules) in help.js's
// words, short enough to read from the back of the room. -> [string] | null
async function projectorRules(p) {
  try {
    const m = await import('./help.js');
    if (typeof m.howTonightWorks !== 'function') return null;
    const lines = m.howTonightWorks({ ...(p.rules || {}), ...(p.hoursMode ? { hoursMode: p.hoursMode } : {}) });
    if (!Array.isArray(lines) || lines.length < 6) return null;
    const firstSentence = (s) => (/^[^.!?]*[.!?]/.exec(s) || [s])[0];
    return [firstSentence(lines[0]), lobbyClock(lines[1]), 'Pages appear here as they’re written, without names unless their writer signs them.', lines[5]];
  } catch {
    return null;
  }
}
// An anthology blurb: whole words, a sentence end when one is close, one ellipsis at most (never
// "...…" after text that already ends in one, as the server's excerpt can).
function blurb(s, max = 170) {
  const t = String(s || '').replace(/\s+/g, ' ').trim().replace(/(\.\.\.|[.!?…])\s*…$/u, '$1');
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const m = /^[\s\S]*[.!?…][”’"')\]]*(?=\s)/u.exec(cut);
  if (m && m[0].length >= max * 0.55) return m[0];
  const w = cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 30)).replace(/[\s,;:–—-]+$/u, '');
  return /(\.\.\.|[.!?…])$/u.test(w) ? w : `${w}…`;
}
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const spell = (n) => (n >= 0 && n <= 20 && Number.isInteger(n) ? ONES[n] : fmtInt(n));
const cap1 = (s) => s.charAt(0).toUpperCase() + s.slice(1);
// 3.4 h -> "three and a half hours", 1 h -> "an hour", 0.5 h -> "half an hour".
function spellHours(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 25) return min <= 1 ? 'a minute' : `${spell(min)} minutes`;
  const halves = Math.round(min / 30);
  const whole = Math.floor(halves / 2);
  const half = halves % 2 === 1;
  if (whole === 0) return 'half an hour';
  if (whole === 1) return half ? 'an hour and a half' : 'an hour';
  return `${spell(whole)}${half ? ' and a half' : ''} hours`;
}
function longDate(ms) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).formatToParts(ms);
    const get = (t) => parts.find((p) => p.type === t)?.value || '';
    return `${get('weekday')} ${get('day')} ${get('month')} ${get('year')}`;
  } catch {
    return new Date(ms).toDateString();
  }
}
let qrMod = null;
async function qrFor(url, label) {
  try {
    qrMod ||= import('./qr.js');
    const { qrSvg } = await qrMod;
    return qrSvg(url, { label });
  } catch {
    return null;
  }
}
function displayUrl(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return String(url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  }
}
const isWordCh = (c) => /[\p{L}\p{N}'’-]/u.test(c);
const isSpace = (c) => c === ' ' || c === '\n' || c === '\t' || c === '\r';

// Where a trimmed card's window may start: after a sentence's end or a line break. MARKED_LINE:
// a list item, quote or heading line (a start inside one loses its marker).
const BOUNDARY = /[.!?…][”’"')\]]*\s+(?=\S)|\n+(?=\S)/g;
const MARKED_LINE = /^\s*(?:[-*+]\s|\d+[.)]\s|>|#{1,6}\s)/;
// How many lines a stretch of card text takes at `cpl` characters a line, on the cards' line
// grid: each line of a paragraph wraps on its own, blocks are a blank line apart, an uploaded
// image on a line of its own is a figure (six lines, a seventh for a caption). `lead`: the
// characters put before the first line ("… ").
const FIGURE_LINE = /^\s*!\[([^\]\n]*)\]\((?:https?:\/\/[^/\s)]*)?\/u\/[^)\s]*(?:\s+"[^"]*")?\)\s*$/;
function lineModel(seg, lead = 0) {
  const lens = [];
  let fixed = 0;
  let blocks = 0;
  for (const block of seg.split(/\n[ \t]*\n+/)) {
    const lines = block.split('\n').filter((l) => l.trim());
    if (!lines.length) continue;
    const fig = FIGURE_LINE.exec(lines[0]);
    if (fig) {
      fixed += fig[1].trim() ? 7 : 6;
      lines.shift();
      if (lines.length) blocks++; // lines right after it make a paragraph of their own
    } else if (!blocks && lead) lens.push(lines.shift().trim().length + lead);
    blocks++;
    for (const l of lines) lens.push(l.trim().length);
  }
  return { lens, fixed: fixed + Math.max(0, blocks - 1) };
}
const linesAt = (m, cpl) => m.lens.reduce((s, n) => s + Math.max(1, Math.ceil(n / cpl)), m.fixed);
// The first of `list` for which `ok` holds, when it holds for every later one too (else -1).
function firstOk(list, ok) {
  let a = 0;
  let z = list.length;
  while (a < z) {
    const mid = (a + z) >> 1;
    if (ok(list[mid])) z = mid;
    else a = mid + 1;
  }
  return a < list.length ? a : -1;
}
// A card's new window start when its text overflows: the earliest sentence start (or line start)
// from which the text to the window's end takes at most `maxLines` lines, judged at the
// characters per line that the current render implies (it takes `rendered` lines). A start inside
// a list item, quote or heading line only when no other one is near. Failing all those, the
// earliest word start that fits. -> index before `limit`, or -1
function trimmedStart(text, v, limit, rendered, maxLines) {
  const model = lineModel(text.slice(v.ws, v.we), v.ws > 0 ? 2 : 0);
  let lo = 8;
  let hi = 400;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (linesAt(model, mid) > rendered) lo = mid;
    else hi = mid;
  }
  const fits = (b) => linesAt(lineModel(text.slice(b, v.we), 2), hi) <= maxLines;
  const starts = [];
  BOUNDARY.lastIndex = v.ws + 1;
  let m;
  while ((m = BOUNDARY.exec(text))) {
    const at = m.index + m[0].length;
    if (at >= limit) break;
    if (at <= v.ws) continue;
    const ls = text.lastIndexOf('\n', at - 1) + 1;
    starts.push({ at, marked: text[at - 1] !== '\n' && MARKED_LINE.test(text.slice(ls, ls + 8)) });
  }
  const i = firstOk(starts, (s) => fits(s.at));
  if (i >= 0) {
    const plain = starts.slice(i).find((s) => !s.marked);
    return plain && plain.at - starts[i].at < 80 ? plain.at : starts[i].at;
  }
  const words = [];
  for (let k = v.ws + 1; k < limit; k++) if (isSpace(text[k - 1]) && !isSpace(text[k])) words.push(k);
  const w = firstOk(words, fits);
  return w >= 0 ? words[w] : -1;
}
// The rendered window of a card: from a paragraph start well above the caret to just after it.
function windowStart(text, focus) {
  if (focus <= BACK) return 0;
  const target = focus - BACK;
  let i = text.lastIndexOf('\n\n', target);
  if (i >= 0 && target - i < 2400) return i + 2;
  i = text.lastIndexOf('\n', target);
  if (i >= 0 && target - i < 1200) return i + 1;
  i = text.lastIndexOf(' ', target);
  return i >= 0 ? i + 1 : target;
}
function windowEnd(text, focus) {
  if (focus >= text.length) return text.length;
  let e = text.indexOf('\n', focus);
  if (e < 0) e = text.length;
  if (e - focus > AFTER) {
    e = text.lastIndexOf(' ', focus + AFTER);
    if (e <= focus) e = Math.min(text.length, focus + AFTER);
  }
  return e;
}
// ---------------------------------------------------------------- the live page
// The projector view: only when asked for with ?wall (the host's "Projector" link). A big
// screen alone doesn't switch to it: someone reading at a desk gets the normal page.
function wallQueryParam() {
  const query = new URLSearchParams(location.search);
  return query.has('wall') ? query.get('wall') !== '0' : null;
}
const wallWanted = () => wallQueryParam() ?? false;

export async function mountLive(root, { session, wall: wallOpt } = {}) {
  const wallQuery = wallQueryParam();
  const wall = wallOpt ?? wallQuery ?? false;
  const narrowMQ = matchMedia('(max-width: 760px)');

  const S = { party: null, counters: null, posts: new Map(), order: [], newIds: [], skew: 0, slots: [], shown: new Map() };
  const timers = [];
  const every = (fn, ms) => timers.push(setInterval(fn, ms));
  let es = null;
  let pollTimer = null;
  let raf = 0;
  let dead = false;
  let lastOrderAt = 0;
  let scrolledAway = false;
  const dirty = new Set();

  // ------------------------------------------------ cards (shared by both views)
  const io = wall ? null : new IntersectionObserver((entries) => {
    for (const e of entries) {
      const rec = S.posts.get(e.target.dataset.id);
      if (!rec) continue;
      rec.visible = e.isIntersecting;
      if (rec.visible && dirty.has(rec)) schedule();
    }
  }, { rootMargin: '240px 0px' });

  function newRec(d) {
    const text = d.text || '';
    return {
      id: d.id, title: d.title || '', name: d.name || null, text, rev: d.rev ?? -1, active: !!d.active,
      words: wordsIn(text), caret: null, fresh: null, editFrom: Infinity,
      lastChange: d.active ? performance.now() : performance.now() - ACTIVE_MS, tier: d.active ? 'A' : 'B',
      el: null, parts: null, view: null, visible: !!wall, painted: false,
      need: { title: true, meta: true, text: true }, inkEls: null, caretEl: null,
    };
  }
  // Card sizes arrive from a ResizeObserver (read after layout, never forced). A card whose text
  // overflows its box moves its window's start to a later sentence, so it reads from a sentence
  // start ("…" before it) with a line to spare: worked out from these sizes, applied in the next
  // frame. Until then the newest words stay in view (is-over anchors them at the box's foot).
  const sizeOf = new WeakMap();
  const recOf = new WeakMap();
  const ro = new ResizeObserver((entries) => {
    const touched = new Set();
    for (const e of entries) {
      sizeOf.set(e.target, e.borderBoxSize?.[0]?.blockSize ?? e.contentRect.height);
      const r = recOf.get(e.target);
      if (r) touched.add(r);
    }
    const rows = [];
    for (const r of touched) {
      if (!r.parts) continue;
      const fh = sizeOf.get(r.parts.flow);
      const bh = sizeOf.get(r.parts.body);
      if (fh !== undefined && bh !== undefined) rows.push({ r, fh, bh });
    }
    if (!rows.length) return;
    // One line height for every card, read before any class below changes (so nothing is forced).
    const lineH = parseFloat(getComputedStyle(rows[0].r.parts.body).lineHeight) || 26;
    for (const { r, fh, bh } of rows) {
      const over = fh > bh + 1;
      r.parts.body.classList.toggle('is-over', over);
      if (!over || !r.view || r.trimTo !== null) continue;
      const v = r.view;
      // Whole lines the box holds once trimmed (on a grid card, "Latest passage" then takes one).
      const box = Math.floor(bh / lineH + 0.05) - (v.ws > 0 || wall ? 0 : 1);
      const limit = Math.min(r.text.length, r.caret ?? r.text.length);
      const ws = trimmedStart(r.text, v, limit, Math.round(fh / lineH), box - 1);
      if (ws > v.ws) {
        r.trimTo = ws;
        r.need.text = true;
        markDirty(r);
      }
    }
  });
  function makeCard(rec) {
    const title = h('h2', { class: 'l-title' });
    const by = h('p', { class: 'l-by', hidden: true });
    const cut = h('p', { class: 'l-cut', 'aria-hidden': 'true' }, 'Latest passage');
    const flow = h('div', { class: 'l-flow' });
    const body = h('div', { class: 'l-body prose' }, flow);
    const meta = h('p', { class: 'l-meta' });
    const foot = h('div', { class: 'l-foot' }, meta, wall ? null : h('span', { class: 'l-read', 'aria-hidden': 'true' }, 'Read the whole piece →'));
    rec.el = h('a', { class: 'l-card', href: `/p/${encodeURIComponent(rec.id)}`, 'data-id': rec.id }, title, by, cut, body, foot);
    rec.parts = { title, by, cut, body, flow, meta };
    rec.view = null;
    rec.painted = false;
    rec.inkEls = null;
    rec.caretEl = null;
    rec.trimTo = null;
    rec.need = { title: true, meta: true, text: true };
    io?.observe(rec.el);
    recOf.set(body, rec);
    recOf.set(flow, rec);
    ro.observe(body);
    ro.observe(flow);
    dirty.add(rec);
    return rec.el;
  }
  function forget(rec) {
    if (!rec.parts) return;
    ro.unobserve(rec.parts.body);
    ro.unobserve(rec.parts.flow);
  }
  function dropCard(rec) {
    if (!rec.el) return;
    io?.unobserve(rec.el);
    forget(rec);
    rec.el.remove();
    rec.el = null;
    rec.parts = null;
    rec.view = null;
    rec.visible = !!wall;
    dirty.delete(rec);
  }
  function schedule() {
    if (!raf && !dead) raf = requestAnimationFrame(flush);
  }
  function markDirty(rec) {
    dirty.add(rec);
    if (rec.el && (rec.visible || !rec.painted)) schedule();
  }
  // One frame: paint the dirty cards on screen; first paints of offscreen cards a few at a time.
  function flush() {
    raf = 0;
    const now = performance.now();
    let firstPaints = 0;
    let more = false;
    for (const rec of dirty) {
      if (!rec.el) {
        dirty.delete(rec);
        continue;
      }
      if (!rec.visible && rec.painted) continue; // painted when it scrolls into view
      if (!rec.visible && ++firstPaints > 6) {
        more = true;
        continue;
      }
      paintCard(rec, now);
      dirty.delete(rec);
    }
    if (more) schedule();
  }
  function paintCard(rec, now) {
    const P = rec.parts;
    if (rec.need.title) {
      P.title.textContent = rec.title || 'Untitled';
      P.by.textContent = rec.name ? `by ${rec.name}` : '';
      P.by.hidden = !rec.name;
      rec.need.title = false;
    }
    if (rec.need.text) {
      patchBody(rec, now);
      rec.need.text = false;
    }
    if (rec.need.meta) {
      // Counts are kept per edit; a full recount now and then keeps them exact.
      if (now - (rec.countedAt || 0) > 20_000) {
        rec.words = wordsIn(rec.text);
        rec.countedAt = now;
      }
      rec.el.classList.toggle('is-active', rec.active);
      const t = rec.active ? `${plural(rec.words, 'word')} · writing now` : plural(rec.words, 'word');
      if (P.meta.textContent !== t) P.meta.textContent = t;
      rec.need.meta = false;
    }
    rec.painted = true;
  }
  function patchBody(rec, now) {
    const P = rec.parts;
    const text = rec.text;
    // Retire the previous chunk's ink and the old caret (they may sit in blocks we keep).
    if (rec.inkEls) for (const s of rec.inkEls) if (s.isConnected) s.replaceWith(...s.childNodes);
    rec.inkEls = null;
    rec.caretEl?.remove();
    rec.caretEl = null;
    const focus = Math.max(0, Math.min(text.length, rec.caret ?? text.length));
    const fresh = rec.fresh && now - rec.fresh.at < INK_MS ? rec.fresh : null;
    // Until a diff shows where the writer is, an active page's caret sits at its end.
    const caret = rec.caret !== null ? focus : rec.active ? text.length : null;
    let v = rec.view;
    const we = windowEnd(text, focus);
    const notes = footnotes(text); // SPEC §31: numbered over the whole text, shown in place on a card
    const trim = rec.trimTo !== null && rec.trimTo <= focus ? rec.trimTo : null;
    rec.trimTo = null;
    if (!v || trim !== null || focus < v.ws || focus - v.ws > WINDOW_MAX || rec.editFrom < v.ws) {
      const ws = trim ?? windowStart(text, focus);
      const r = renderBlocks(text.slice(ws, we), { base: ws, fresh, caret, spoilers: 'hide', links: false, notes, noteDefs: 'inline' });
      P.flow.replaceChildren(...r.blocks.map((b) => b.el));
      v = rec.view = { ws, we, blocks: r.blocks };
      rec.inkEls = r.ink;
      rec.caretEl = r.caretEl;
    } else {
      // Keep every block that ends before the edit, less one (an edit can join two blocks).
      const bl = v.blocks;
      let k = bl.findIndex((b) => b.end >= rec.editFrom);
      if (k < 0) k = bl.length;
      k = Math.max(0, k - 1);
      // From the window start when the edit reaches the first block: text before it may have changed.
      const from = k === 0 || !bl.length ? v.ws : bl[k].start;
      for (let j = k; j < bl.length; j++) bl[j].el.remove();
      const r = renderBlocks(text.slice(from, we), { base: from, fresh, caret, spoilers: 'hide', links: false, notes, noteDefs: 'inline' });
      P.flow.append(...r.blocks.map((b) => b.el));
      v.blocks = bl.slice(0, k).concat(r.blocks);
      v.we = we;
      rec.inkEls = r.ink;
      rec.caretEl = r.caretEl;
    }
    rec.editFrom = Infinity;
    // Earlier text left out: "Latest passage" above, "…" before the first words, and a body of
    // fixed height with the newest words at its foot.
    const trimmed = v.ws > 0;
    P.body.classList.toggle('is-trimmed', trimmed);
    P.cut.classList.toggle('is-on', trimmed);
    const first = v.blocks[0]?.el;
    if (first && !first.matches('hr, pre, figure')) {
      const host = first.matches('ul, ol') ? first.querySelector('li') : first.matches('blockquote') ? first.querySelector('p') || first : first;
      const has = !!host?.firstChild?.classList?.contains('l-lead');
      if (trimmed && host && !has) host.prepend(h('span', { class: 'l-lead', 'aria-hidden': 'true' }, '… '));
      if (!trimmed && has) host.firstChild.remove();
    }
  }
  // Apply a server diff to the model: text, word count (recounted around the edit only),
  // the newest chunk (widened to whole words) and the writer's caret.
  function applyDiff(rec, from, del, ins) {
    const old = rec.text;
    if (from < 0 || from + del > old.length) return false;
    const text = old.slice(0, from) + ins + old.slice(from + del);
    // The words around the edit, at most WORD_SCAN_MAX characters each way (a longer "word"
    // counts as one either way; a pane of one huge word can't make every diff scan all of it).
    let a = from;
    const aMin = Math.max(0, from - WORD_SCAN_MAX);
    while (a > aMin && !isSpace(old[a - 1])) a--;
    let bo = from + del;
    const boMax = Math.min(old.length, bo + WORD_SCAN_MAX);
    while (bo < boMax && !isSpace(old[bo])) bo++;
    const bn = bo - del + ins.length;
    rec.words += wordsIn(text.slice(a, bn)) - wordsIn(old.slice(a, bo));
    rec.text = text;
    rec.caret = from + ins.length;
    if (ins.trim()) {
      let fa = from;
      const faMin = Math.max(0, from - WORD_SCAN_MAX);
      while (fa > faMin && isWordCh(text[fa - 1])) fa--;
      let fb = from + ins.length;
      const fbMax = Math.min(text.length, fb + WORD_SCAN_MAX);
      while (fb < fbMax && isWordCh(text[fb])) fb++;
      rec.fresh = { from: fa, to: fb, at: performance.now() };
    } else rec.fresh = null;
    rec.editFrom = Math.min(rec.editFrom, from);
    rec.lastChange = performance.now();
    return true;
  }

  // ------------------------------------------------ stream handlers
  let resyncing = false;
  function resync() {
    if (resyncing || dead) return;
    resyncing = true;
    connect(); // a fresh stream starts with a snapshot carrying revisions
  }
  function onSnapshot(s) {
    resyncing = false;
    const first = !S.party;
    if (s.party) onParty(s.party, true);
    if (dead) return;
    if (s.counters) S.counters = s.counters;
    const seen = new Set();
    const now = performance.now();
    for (const p of s.posts || []) {
      seen.add(p.id);
      let rec = S.posts.get(p.id);
      if (!rec) {
        rec = newRec(p);
        S.posts.set(p.id, rec);
        if (!first) S.newIds.push(p.id);
        continue;
      }
      if (p.text !== undefined && p.text !== rec.text) {
        rec.text = p.text;
        rec.words = wordsIn(p.text);
        rec.view = null;
        rec.fresh = null;
        rec.need.text = rec.need.meta = true;
        rec.lastChange = now;
      }
      rec.rev = p.rev ?? -1;
      if (p.title !== rec.title || (p.name || null) !== rec.name) {
        rec.title = p.title || '';
        rec.name = p.name || null;
        rec.need.title = true;
      }
      if (!!p.active !== rec.active) {
        rec.active = !!p.active;
        rec.need.meta = true;
      }
      markDirty(rec);
    }
    for (const [id, rec] of [...S.posts]) {
      if (!seen.has(id)) {
        dropCard(rec);
        S.posts.delete(id);
      }
    }
    if (first) S.order = (s.posts || []).map((p) => p.id);
    else S.order = S.order.filter((id) => S.posts.has(id));
    view.sync(first);
    renderCounters();
    renderParty();
  }
  function onPost(d) {
    let rec = S.posts.get(d.id);
    if (!rec) {
      if (d.text === undefined) return resync();
      rec = newRec({ ...d, active: true });
      S.posts.set(d.id, rec);
      S.newIds.push(d.id);
      view.added(rec);
      renderParty();
      return undefined;
    }
    if (d.d) {
      if (rec.rev === -1 || d.rev !== rec.rev + 1) return resync();
      if (!applyDiff(rec, d.d[0], d.d[1], d.d[2])) return resync();
      rec.need.text = rec.need.meta = true;
    } else if (d.text !== undefined && d.text !== rec.text) {
      rec.text = d.text;
      rec.words = wordsIn(d.text);
      rec.view = null;
      rec.need.text = rec.need.meta = true;
    }
    if (d.rev !== undefined) rec.rev = d.rev;
    if (d.title !== undefined && d.title !== rec.title) {
      rec.title = d.title;
      rec.need.title = true;
    }
    if (d.name !== undefined && (d.name || null) !== rec.name) {
      rec.name = d.name || null;
      rec.need.title = true;
    }
    if (d.active !== undefined && !!d.active !== rec.active) {
      rec.active = !!d.active;
      rec.need.meta = true;
    }
    markDirty(rec);
    return undefined;
  }
  function onRemove(d) {
    const rec = S.posts.get(d.id);
    if (!rec) return;
    dropCard(rec);
    S.posts.delete(d.id);
    S.order = S.order.filter((x) => x !== d.id);
    S.newIds = S.newIds.filter((x) => x !== d.id);
    view.removed(d.id);
    renderParty();
  }
  function onCounters(c) {
    S.counters = c;
    renderCounters();
  }
  function onParty(p, quiet = false) {
    const prev = S.party;
    S.party = p;
    if (p.phase === 'ended') return toArchive();
    if (!quiet) {
      if (prev && prev.phase !== p.phase) view.rebuild();
      renderParty();
      renderCounters();
    }
    return undefined;
  }
  const handlers = {
    snapshot: onSnapshot,
    post: onPost,
    remove: onRemove,
    counters: onCounters,
    party: (p) => onParty(p),
    order: () => {}, // the page keeps its own calmer order (see desiredOrder)
    tick: (f) => { // one batched frame per server tick (/api/live/events?v=2)
      if (f.party) onParty(f.party);
      if (dead) return;
      if (f.counters) onCounters(f.counters);
      for (const p of f.posts || []) onPost(p);
      for (const id of f.remove || []) onRemove({ id });
    },
  };
  function connect() {
    es?.close();
    es = stream('/api/live/events?v=2', handlers, (st) => {
      page.classList.toggle('is-offline', st === 'error');
      if (st === 'open') {
        clearInterval(pollTimer);
        pollTimer = null;
      } else if (st === 'error' && !pollTimer) {
        // The stream may be refused when the page is very busy: poll until it's back
        // (at once if there's nothing on the page yet).
        pollTimer = setInterval(poll, 10_000);
        if (!S.party) poll();
      }
      renderChip();
    });
  }
  async function poll() {
    try {
      const v = await api('/api/live');
      if (!dead) onSnapshot({ ...v, posts: (v.posts || []).map((p) => ({ ...p, rev: -1 })) });
    } catch { /* keep trying */ }
  }
  async function measureSkew() {
    try {
      const t0 = Date.now();
      const r = await fetch('/healthz', { cache: 'no-store' });
      const t1 = Date.now();
      const d = Date.parse(r.headers.get('Date') || '');
      if (Number.isFinite(d)) S.skew = d + 500 - (t0 + t1) / 2; // Date has whole seconds
    } catch { /* local clock */ }
  }
  const nowServer = () => Date.now() + S.skew;
  // ------------------------------------------------ page shell
  const page = h('div', { class: wall ? 'pj' : 'l-page l-live' });
  fill(root, page);
  document.body.classList.toggle('is-projector', wall);
  const view = wall ? projectorView() : gridView();

  function activeBreak() {
    const b = S.party?.breaks?.active || (S.party?.break ? { label: S.party.break.label, endAt: S.party.break.endAt, mode: S.party.break.mode } : null);
    return b && b.endAt > nowServer() - 5000 ? b : null;
  }
  function nextBreak() {
    return S.party?.breaks?.next || null;
  }
  function renderParty() {
    if (!S.party) return;
    document.title = wall ? `${S.party.name}: projector` : `${S.party.name}: live`;
    view.party();
  }
  function renderCounters() {
    view.counters();
  }
  function renderChip() {
    view.chip?.();
  }

  // ------------------------------------------------ the grid (phones, laptops)
  function gridView() {
    const mast = h('header', { class: 'l-mast' });
    const breakBand = h('div', { class: 'l-break', hidden: true, role: 'status' });
    const status = h('p', { class: 'l-status', role: 'status' });
    const sentinel = h('div', { class: 'l-sentinel', 'aria-hidden': 'true' });
    const pill = h('button', { class: 'l-pill', type: 'button', hidden: true }, 'New writing at the top');
    const grid = h('div', { class: 'l-grid', 'aria-live': 'off' });
    page.append(sentinel, mast, breakBand, status, pill, grid);
    let mastPhase = null;
    let mastStart = null; // the planned start the chip shows (lobby)
    const counterEls = {};
    let chipEl = null;
    let chipReconnect = null;
    let ledeEl = null; // the running masthead's line, which says what the page is showing
    const so = new IntersectionObserver((es2) => {
      scrolledAway = !es2[0].isIntersecting;
      if (!scrolledAway) maybeReorder();
    });
    so.observe(sentinel);
    timers.push({ disconnect: () => so.disconnect() });
    pill.addEventListener('click', () => {
      applyOrder(desiredOrder(), false);
      grid.scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' });
    });

    // Only hosts get the way to the projector view.
    const projLink = () => (session?.user?.isAdmin ? h('a', { class: 'l-link l-projector', href: '/live?wall', title: 'For a big screen: two pages at a time in large type, with a clock' }, 'Projector') : null);
    // SPEC §28: the writers who chose to be listed, with their hours and signed pieces.
    const writersLink = () => h('a', { class: 'l-link l-writers', href: '/writers' }, 'Writers');
    // Earlier rounds' anthologies (lib/rounds.js): the latest one, which links to the rest.
    const pastRounds = Array.isArray(session?.party?.rounds) ? session.party.rounds : [];
    const roundsLink = () => (pastRounds.length && !wall
      ? h('a', { class: 'l-link l-rounds', href: `/archive/${pastRounds[pastRounds.length - 1].n}` }, pastRounds.length === 1 ? `Round ${pastRounds[0].n}` : 'Earlier rounds')
      : null);
    // The lobby's "How the evening works": the rules in a few lines (help.js's wording, with the
    // party's numbers where known: the signed-in writer's settings, else what the public view
    // carries), what's planned tonight, food and links. It fills the poster's empty half.
    const evening = { el: h('section', { class: 'l-evening', 'aria-labelledby': 'l-evening-h', hidden: true }), key: '', settings: null, asked: false };
    async function renderEvening() {
      const p = S.party;
      if (!p || p.phase !== 'lobby' || !evening.el.isConnected) return;
      const signedIn = !!session?.user;
      if (signedIn && !evening.asked) {
        evening.asked = true;
        api('/api/me').then((v) => {
          if (!v?.settings) return;
          evening.settings = v.settings;
          evening.key = '';
          renderEvening();
        }).catch(() => {});
      }
      const settings = evening.settings || { ...(p.rules || {}), ...(p.hoursMode ? { hoursMode: p.hoursMode } : {}) };
      const nb = nextBreak();
      const key = JSON.stringify([settings, nb, p.plannedEnd ?? null, p.plannedStart ?? null, signedIn]);
      if (key === evening.key) return;
      evening.key = key;
      let lines = null;
      try {
        const m = await import('./help.js');
        lines = typeof m.howTonightWorks === 'function' ? m.howTonightWorks(settings) : null;
      } catch { /* no help module: no section */ }
      if (key !== evening.key) return; // a newer render started meanwhile
      if (!Array.isArray(lines) || lines.length < 6) {
        evening.el.hidden = true;
        return;
      }
      const [goal, clock, settle, , , missed] = lines;
      const items = [
        goal,
        lobbyClock(clock),
        'Pages stream here as they’re written, without your name unless you sign them. A page can also stay hidden until the end and be published on its own.',
        settle,
        missed,
      ];
      const tonight = [];
      if (Number.isFinite(p.plannedStart)) tonight.push(`Starting ${fmtWhen(p.plannedStart, nowServer())}`);
      if (Number.isFinite(p.plannedEnd)) tonight.push(`Writing until ${clockAt(p.plannedEnd)}`);
      if (nb && Number.isFinite(nb.startAt)) tonight.push(`${nb.label || 'Break'} at ${clockAt(nb.startAt)}`);
      let food = null;
      if (signedIn) {
        food = h('button', { class: 'btn-link l-evening-act', type: 'button', hidden: true }, 'Your food preferences →');
        import('./food.js').then((m) => {
          if (typeof m.openFoodSheet !== 'function') return;
          food.hidden = false;
          food.addEventListener('click', () => m.openFoodSheet({ returnFocus: food }));
        }).catch(() => {});
      }
      fill(evening.el,
        h('div', { class: 'l-evening-main' },
          h('h2', { class: 'l-evening-h', id: 'l-evening-h' }, 'How it works'),
          h('ol', { class: 'l-evening-list' }, items.map((t) => h('li', null, t)))),
        h('aside', { class: 'l-evening-side' },
          tonight.length ? h('h3', { class: 'l-evening-h' }, 'The plan') : null,
          tonight.length ? h('ul', { class: 'l-tonight' }, tonight.map((t) => h('li', null, t))) : null,
          h('p', { class: 'l-evening-food' }, signedIn ? 'Food: tell the hosts what you’d like to eat.' : 'Food: once you’ve signed up, you can tell the hosts what you’d like to eat.'),
          food,
          h('p', { class: 'l-evening-links' },
            helpLink(undefined, { label: 'How it works, in full', className: 'l-help' }),
            h('a', { class: 'l-link', href: '/writers' }, 'Who’s writing'))));
      evening.el.hidden = false;
    }
    function buildMast() {
      const p = S.party;
      mastPhase = p.phase;
      mastStart = p.plannedStart ?? null;
      const signedIn = !!session?.user;
      const userLink = signedIn
        ? h('a', { class: 'l-link', href: session.user.isAdmin ? '/host' : '/write' }, session.user.isAdmin ? 'Host dashboard' : 'Write')
        : null;
      // Visitors: a clear way in, top right on wide screens and under the title on phones.
      const cta = (where) => (signedIn ? null : h('div', { class: `l-cta ${where}` },
        h('a', { class: 'btn btn-primary l-cta-btn', href: '/register' }, 'Join as a writer', h('span', { class: 'l-cta-arrow', 'aria-hidden': 'true' }, '→')),
        h('a', { class: 'l-link', href: '/login' }, 'Sign in')));
      if (p.phase === 'lobby') {
        // The join address and QR code belong to the projector (people read them off the wall);
        // here, visitors are already at the address: a way in instead.
        chipEl = h('span', { class: 'l-chip is-soon' }, h('i', { 'aria-hidden': 'true' }), Number.isFinite(p.plannedStart) ? `Starts ${fmtWhen(p.plannedStart, nowServer())}` : 'Starting soon');
        chipReconnect = null;
        ledeEl = null;
        fill(mast,
          h('div', { class: 'l-mast-top' }, chipEl, h('nav', { class: 'l-mast-nav' }, helpLink(undefined, { className: 'l-help' }), writersLink(), roundsLink(), projLink(), userLink)),
          h('h1', { class: 'l-name' }, p.name),
          h('p', { class: 'l-lede' }, 'A writing party. Once it starts, pages appear here as they’re written, anonymously unless their writer signs them.'),
          cta('l-cta-lobby'),
          evening.el);
        mast.className = 'l-mast is-poster';
        evening.key = '';
        return;
      }
      chipReconnect = h('span', { class: 'l-reconnect', hidden: true }, ' · reconnecting…');
      chipEl = h('span', { class: 'l-chip is-live' }, h('i', { 'aria-hidden': 'true' }), 'Live', chipReconnect);
      const dl = h('div', { class: 'l-counters' });
      for (const k of ['writing', 'words', 'pieces']) {
        counterEls[k] = { dd: h('span', { class: 'l-n' }), dt: h('span', { class: 'l-k' }) };
        dl.append(h('p', { class: `l-counter is-${k}` }, counterEls[k].dd, ' ', counterEls[k].dt));
      }
      counterEls.box = dl;
      fill(mast,
        h('div', { class: 'l-mast-top' }, chipEl, h('nav', { class: 'l-mast-nav' }, helpLink(undefined, { className: 'l-help' }), writersLink(), roundsLink(), projLink(), signedIn ? userLink : cta('l-cta-top'))),
        h('div', { class: 'l-mast-row' }, h('h1', { class: 'l-name' }, p.name), dl),
        cta('l-cta-row'),
        ledeEl = h('p', { class: 'l-lede' }, 'Every page below is being written right now, anonymously unless its writer signs it.'));
      mast.className = 'l-mast is-compact';
      chip();
    }
    function party() {
      const p = S.party;
      if (mastPhase !== p.phase || mastStart !== (p.plannedStart ?? null)) buildMast();
      if (p.phase === 'lobby') renderEvening();
      const br = p.phase === 'running' ? activeBreak() : null;
      breakBand.hidden = !br;
      if (br) {
        fill(breakBand, h('span', { class: 'l-break-label' }, br.label || 'Break'),
          br.mode === 'reduce' ? ` ${breakLine(br, sharedHour(p, nowServer())?.target)}` : ` · ${breakLine(br)}`);
      }
      counterEls.box?.classList.toggle('is-muted', !!br);
      page.classList.toggle('is-break', !!br);
      if (p.phase === 'lobby') status.textContent = '';
      else if (!S.posts.size) status.textContent = br ? 'No pages yet. They’ll appear here when writing starts again.' : 'No pages yet. The first words will appear here as they’re written.';
      else status.textContent = '';
      status.hidden = !status.textContent;
      counters();
    }
    function counters() {
      if (!counterEls.box || !S.party) return;
      const c = S.counters || {};
      const t = S.party.totals || {};
      const br = activeBreak();
      const writing = br ? null : (t.writingNow ?? c.writing ?? 0);
      const words = t.wordsToday ?? null;
      const set = (k, n, label, hide = false) => {
        const e = counterEls[k];
        e.dd.parentNode.hidden = hide;
        if (hide) return;
        const txt = fmtInt(n);
        if (e.dd.textContent !== txt) e.dd.textContent = txt;
        if (e.dt.textContent !== label) e.dt.textContent = label;
      };
      set('writing', writing ?? 0, 'writing now', writing === null);
      if (words === null) set('words', c.wordsThisHour ?? 0, 'words this hour');
      else set('words', words, 'words today');
      set('pieces', c.posts ?? S.posts.size, (c.posts ?? S.posts.size) === 1 ? 'piece' : 'pieces');
      // "Right now" only while most pages are being written; a break says so too.
      if (ledeEl) {
        const pieces = c.posts ?? S.posts.size;
        const live = t.writingNow ?? c.writing ?? 0;
        const txt = br ? 'Written so far today, anonymously unless their writer signs them.'
          : pieces > 0 && live * 2 < pieces ? 'Pages being written today, anonymously unless their writer signs them.'
            : 'Every page below is being written right now, anonymously unless its writer signs it.';
        if (ledeEl.textContent !== txt) ledeEl.textContent = txt;
      }
    }
    function chip() {
      if (chipReconnect) chipReconnect.hidden = !page.classList.contains('is-offline');
    }

    // Order: recently written posts first, but calm. A post that starts again after a
    // pause moves to the front, a post idle for a few minutes drops behind the busy ones,
    // and nothing else moves. Once the reader has scrolled down the grid never moves under
    // them: a pill offers the new order instead (maybeReorder has the rule for a phone's top).
    function desiredOrder() {
      const now = performance.now();
      const risers = [];
      const stay = [];
      const fallers = [];
      const rest = [];
      const fresh = new Set(S.newIds);
      for (const id of S.order) {
        if (fresh.has(id)) continue;
        const r = S.posts.get(id);
        if (!r) continue;
        const a = now - r.lastChange < ACTIVE_MS;
        if (a) (r.tier === 'A' ? stay : risers).push(id);
        else (r.tier === 'A' ? fallers : rest).push(id);
      }
      risers.sort((x, y) => S.posts.get(y).lastChange - S.posts.get(x).lastChange);
      return [...S.newIds.filter((id) => S.posts.has(id)).reverse(), ...risers, ...stay, ...fallers, ...rest];
    }
    function maybeReorder() {
      if (dead) return;
      let want = desiredOrder();
      const same = want.length === S.order.length && want.every((id, i) => id === S.order[i]);
      if (same) {
        pill.hidden = true;
        return;
      }
      if (scrolledAway) {
        // Reading further down: nothing moves; the pill offers the new order.
        const top = Math.min(3, want.length);
        pill.hidden = want.slice(0, top).every((id, i) => id === S.order[i]);
        return;
      }
      pill.hidden = true; // at the top there's nothing to scroll up to
      if (performance.now() - lastOrderAt < REORDER_MS && S.order.length) return;
      // At the top of a phone the first card is on screen: it keeps its place while it's still
      // being written, and only the cards below it (off screen) take the new order.
      if (narrowMQ.matches && S.order.length) {
        const first = S.order[0];
        const r = S.posts.get(first);
        if (r && performance.now() - r.lastChange < ACTIVE_MS) want = [first, ...want.filter((id) => id !== first)];
        if (want.length === S.order.length && want.every((id, i) => id === S.order[i])) return;
      }
      applyOrder(want, true);
    }
    function applyOrder(order, animate) {
      const first = new Map();
      const motion = animate && !reduceMotion();
      if (motion) {
        for (const id of S.order) {
          const r = S.posts.get(id);
          if (r?.el?.isConnected && r.visible) first.set(id, r.el.getBoundingClientRect());
        }
      }
      const now = performance.now();
      for (const id of order) {
        const r = S.posts.get(id);
        r.tier = now - r.lastChange < ACTIVE_MS ? 'A' : 'B';
      }
      S.newIds = [];
      S.order = order;
      let i = 0;
      for (const id of order) {
        const r = S.posts.get(id);
        const el = r.el || makeCard(r);
        const at = grid.children[i];
        if (at !== el) grid.insertBefore(el, at || null);
        i++;
      }
      if (motion && first.size) {
        for (const id of order) {
          const r = S.posts.get(id);
          const a = first.get(id);
          if (!a || !r.visible) continue;
          const b = r.el.getBoundingClientRect();
          const dx = a.left - b.left;
          const dy = a.top - b.top;
          if (!dx && !dy) continue;
          // Slide within a row; anything changing rows fades in where it lands (no overlaps).
          if (Math.abs(dy) < 4) r.el.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.2,.7,.2,1)' });
          else r.el.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 380, easing: 'ease-out' });
        }
      }
      lastOrderAt = now;
      pill.hidden = true;
      schedule();
    }
    every(maybeReorder, 2000);
    narrowMQ.addEventListener?.('change', maybeReorder);

    return {
      party, counters, chip,
      sync(firstTime) {
        if (firstTime) {
          for (const id of S.order) grid.append(makeCard(S.posts.get(id)));
          lastOrderAt = performance.now();
          schedule();
        } else {
          for (const id of S.order) if (!S.posts.get(id).el) makeCard(S.posts.get(id));
          maybeReorder();
        }
      },
      added(rec) {
        makeCard(rec);
        rec.el.classList.add('is-new');
        grid.append(rec.el);
        S.order.push(rec.id);
        // At the top a new post moves up at once (on a phone, below the card being read);
        // further down it waits for the pill.
        if (!scrolledAway) lastOrderAt = 0;
        maybeReorder();
      },
      removed() {},
      rebuild() {
        mastPhase = null;
      },
    };
  }

  // ------------------------------------------------ the projector (/live?wall)
  function projectorView() {
    // Read from across a room: two pages at a time (three on an ultra-wide), large type.
    const nSlots = innerWidth < 700 ? 1 : innerWidth / innerHeight > 2.1 ? 3 : 2;
    S.slots = new Array(nSlots).fill(null);
    const nameEl = h('h1', { class: 'pj-name' });
    const chipEl = h('span', { class: 'pj-chip' }, h('i', { 'aria-hidden': 'true' }), 'Live');
    const totals = h('div', { class: 'pj-totals' });
    const clockEl = h('p', { class: 'pj-clock' });
    const nextEl = h('p', { class: 'pj-next' });
    const joinEl = h('p', { class: 'pj-joinline' });
    const paceEl = h('p', { class: 'pj-pace' });
    // One baseline grid: the name, the totals and the clock share a baseline; the chip sits above
    // the name; the hour's pace ("Hour 2 · 400 words · 23 min left"), the labels, the next break
    // and the join line share the row below.
    const bar = h('header', { class: 'pj-bar' }, chipEl, nameEl, totals, clockEl, paceEl, h('div', { class: 'pj-sub' }, nextEl, joinEl));
    const slotsEl = h('div', { class: 'pj-grid' });
    const slotBoxes = S.slots.map(() => h('div', { class: 'pj-slot' }));
    slotsEl.append(...slotBoxes);
    const full = h('section', { class: 'pj-full', hidden: true });
    const exit = h('a', { class: 'pj-exit', href: '/live?wall=0' }, 'Leave projector view');
    page.append(bar, slotsEl, full, exit);
    // The way out shows for a few seconds whenever the mouse moves or the screen is touched (and
    // when the view opens), then the wall is clean again, cursor included; Escape leaves too.
    let wake = 0;
    const awake = () => {
      page.classList.add('pj-awake');
      clearTimeout(wake);
      wake = setTimeout(() => page.classList.remove('pj-awake'), 3000);
    };
    page.addEventListener('pointermove', awake, { passive: true });
    page.addEventListener('pointerdown', awake, { passive: true });
    const onKey = (e) => {
      if (e.key === 'Escape') location.href = '/live?wall=0';
    };
    addEventListener('keydown', onKey);
    timers.push({ disconnect: () => { removeEventListener('keydown', onKey); clearTimeout(wake); } });
    awake();
    const totalEls = {};
    for (const k of ['words', 'writing']) {
      totalEls[k] = { dd: h('span', { class: `pj-n pj-n-${k}` }), dt: h('span', { class: `pj-l pj-l-${k}` }) };
      totals.append(h('p', { class: 'pj-total' }, totalEls[k].dd, ' ', totalEls[k].dt));
    }
    let mode = null;
    let fullKey = '';
    let rot = 0;

    function setText(el, t) {
      if (el.textContent !== t) el.textContent = t;
    }
    // "Hour 2 · 400 words · 23 min left" with synced hours, else the target per hour.
    function paceText(now) {
      const p = S.party;
      const r = p?.rules || {};
      const sh = sharedHour(p, now);
      const base = Number(r.targetPerHour) > 0 ? Number(r.targetPerHour) : null;
      if (sh) {
        const left = Math.ceil((sh.endAt - now) / 60_000);
        const target = sh.target ?? base;
        return [sh.n ? `Hour ${sh.n}` : 'This hour', target ? `${fmtInt(target)} words` : null, left <= 1 ? 'under a minute left' : `${left} min left`].filter(Boolean).join(' · ');
      }
      return base ? `${fmtInt(base)} new words an hour` : '';
    }
    function tickClock() {
      if (!S.party) return;
      const now = nowServer();
      setText(clockEl, clockAt(now));
      const nb = nextBreak();
      let next = '';
      if (nb && nb.startAt > now) next = `next: ${nb.label} at ${clockAt(nb.startAt)}`;
      else if (S.party.plannedEnd && S.party.plannedEnd > now) next = `until ${clockAt(S.party.plannedEnd)}`;
      setText(nextEl, next);
      setText(paceEl, paceText(now));
      if (mode === 'break') {
        const br = activeBreak();
        const cd = full.querySelector('.pj-count');
        if (br && cd) {
          const s = Math.max(0, Math.round((br.endAt - now) / 1000));
          setText(cd, `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
        }
        if (!br) party();
      }
      const fc = full.querySelector('.pj-full-clock');
      if (fc) setText(fc, clockAt(now));
    }
    every(tickClock, 1000);

    async function showFull(kind) {
      const p = S.party;
      const url = p.joinUrl || location.origin;
      const br = activeBreak();
      const target = br ? sharedHour(p, nowServer())?.target ?? null : null;
      const startAt = p.plannedStart ?? p.startsAt ?? null; // a planned start, when the server sends one
      const key = JSON.stringify([kind, p.name, url, br?.label, br?.endAt, br?.mode, target, p.rules ?? null, p.hoursMode ?? null, startAt]);
      if (key === fullKey) return;
      fullKey = key;
      const qr = h('div', { class: 'pj-qr' });
      if (kind === 'lobby' || kind === 'empty') {
        // Two columns on one grid: the chip and the clock share a baseline above the name
        // and the join card, so the clock lines up with the card's edge, not the corner.
        const started = kind === 'empty';
        const rulesEl = h('ol', { class: 'pj-rules', hidden: true });
        projectorRules(p).then((lines) => {
          if (!lines || fullKey !== key) return;
          rulesEl.append(...lines.map((t) => h('li', null, t)));
          rulesEl.hidden = false;
        });
        fill(full,
          h('p', { class: `pj-soon${started ? ' is-live' : ''}` }, h('i', { 'aria-hidden': 'true' }), started ? 'Live' : 'Starting soon'),
          h('p', { class: 'pj-full-clock' }),
          h('div', { class: 'pj-full-main' },
            h('h1', { class: 'pj-full-name' }, p.name),
            h('p', { class: 'pj-full-lede' }, started ? 'Writing has started. Pages appear on this wall as they’re written.' : 'A writing party. Pages appear on this wall as they’re written.'),
            !started && Number.isFinite(startAt) ? h('p', { class: 'pj-start' }, `Starts at ${clockAt(startAt)}`) : null,
            rulesEl),
          h('div', { class: 'pj-join' }, qr,
            h('div', { class: 'pj-join-text' }, h('p', { class: 'pj-join-k' }, 'Join as a writer at'), h('p', { class: 'pj-join-url' }, displayUrl(url)),
              h('p', { class: 'pj-join-sub' }, 'Sign up on your phone or laptop.'))));
      } else {
        fill(full,
          h('p', { class: 'pj-full-clock' }),
          h('div', { class: 'pj-full-main' },
            h('p', { class: 'pj-break-label' }, br ? br.label : 'Break'),
            h('p', { class: 'pj-break-back' }, br ? breakLine(br, target) : ''),
            h('p', { class: 'pj-count', 'aria-live': 'off' })),
          h('div', { class: 'pj-join is-small' }, qr,
            h('div', { class: 'pj-join-text' }, h('p', { class: 'pj-join-k' }, 'Join as a writer at'), h('p', { class: 'pj-join-url' }, displayUrl(url)))));
      }
      tickClock();
      const svg = await qrFor(url, `QR code for ${displayUrl(url)}`);
      if (svg && fullKey === key) qr.append(svg);
    }
    function party() {
      const p = S.party;
      setText(nameEl, p.name);
      const br = p.phase === 'running' ? activeBreak() : null;
      const next = p.phase === 'lobby' ? 'lobby' : br ? 'break' : S.posts.size ? 'wall' : 'empty';
      if (next !== mode) {
        mode = next;
        page.dataset.mode = mode;
        full.hidden = mode === 'wall';
        bar.hidden = slotsEl.hidden = mode !== 'wall';
        if (mode === 'wall') {
          fullKey = '';
          fitSoon(); // cards placed while the wall was hidden were never measured
        }
      }
      if (mode !== 'wall') showFull(mode);
      setText(joinEl, `Join as a writer at ${displayUrl(p.joinUrl || location.origin)}`);
      joinEl.hidden = mode !== 'wall';
      counters();
      tickClock();
    }
    function counters() {
      const t = S.party?.totals || {};
      const c = S.counters || {};
      const set = (k, n, label) => {
        setText(totalEls[k].dd, fmtInt(n));
        setText(totalEls[k].dt, label);
      };
      set('words', t.wordsToday ?? c.wordsThisHour ?? 0, t.wordsToday === undefined ? 'words this hour' : 'words today');
      set('writing', t.writingNow ?? c.writing ?? 0, 'writing now');
    }
    function chip() {
      chipEl.classList.toggle('is-offline', page.classList.contains('is-offline'));
    }

    // Slots: each holds one post; one slot changes every ROTATE_MS, to the post that has
    // waited longest for a turn among those written recently. Positions never shuffle.
    function place(i, id) {
      const box = slotBoxes[i];
      const old = S.slots[i] ? S.posts.get(S.slots[i]) : null;
      S.slots[i] = id;
      const rec = id ? S.posts.get(id) : null;
      if (rec) {
        S.shown.set(id, performance.now());
        rec.slotAt = performance.now();
        box.append(makeCard(rec));
        rec.visible = true;
        if (!reduceMotion() && old) rec.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 700, easing: 'ease-out' });
      }
      if (old?.el) {
        const el = old.el;
        forget(old);
        old.el = null;
        old.parts = null;
        old.view = null;
        dirty.delete(old);
        if (reduceMotion()) el.remove();
        else el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 500, easing: 'ease-in' }).finished.then(() => el.remove(), () => el.remove());
      }
      slotsEl.style.setProperty('--n', String(Math.max(1, S.slots.filter(Boolean).length)));
      schedule();
      fitSoon();
    }
    // A projector card's text box holds a whole number of lines, so its top edge never cuts
    // through a line: measured once per placement or resize (not per update).
    let fitRaf = 0;
    function fitSoon() {
      cancelAnimationFrame(fitRaf);
      fitRaf = requestAnimationFrame(() => {
        fitRaf = 0;
        if (mode !== 'wall') return; // hidden: measured when the wall shows
        const bodies = S.slots.map((id) => (id ? S.posts.get(id)?.parts?.body : null)).filter(Boolean);
        for (const b of bodies) b.style.maxHeight = '';
        const reads = bodies.map((b) => {
          const cs = getComputedStyle(b);
          return [b, b.clientHeight, parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.45];
        });
        for (const [b, avail, lh] of reads) b.style.maxHeight = `${Math.max(1, Math.floor((avail + 0.5) / lh)) * lh}px`;
      });
    }
    addEventListener('resize', fitSoon);
    document.fonts?.ready.then(fitSoon);
    function candidates() {
      const now = performance.now();
      const on = new Set(S.slots);
      return [...S.posts.values()].filter((r) => !on.has(r.id))
        .sort((a, b) => {
          const aa = now - a.lastChange < 120_000 ? 0 : 1;
          const bb = now - b.lastChange < 120_000 ? 0 : 1;
          return aa - bb || (S.shown.get(a.id) || 0) - (S.shown.get(b.id) || 0) || b.lastChange - a.lastChange;
        });
    }
    function fillEmpty() {
      for (let i = 0; i < S.slots.length; i++) {
        if (S.slots[i] && S.posts.has(S.slots[i])) continue;
        if (S.slots[i]) S.slots[i] = null;
        const c = candidates()[0];
        if (c) place(i, c.id);
      }
      // Fewer posts than slots: the empty slots fold away and the rest share the width.
      slotBoxes.forEach((b, i) => { b.hidden = !S.slots[i]; });
    }
    function rotate() {
      if (mode !== 'wall' || S.posts.size <= S.slots.length) return;
      const now = performance.now();
      for (let tries = 0; tries < S.slots.length; tries++) {
        const i = rot++ % S.slots.length;
        const cur = S.slots[i] ? S.posts.get(S.slots[i]) : null;
        if (cur && now - (cur.slotAt || 0) < DWELL_MS) continue;
        const c = candidates()[0];
        if (!c) return;
        // Don't swap a busy page for an idle one.
        if (cur && now - cur.lastChange < 30_000 && now - c.lastChange > 120_000) continue;
        place(i, c.id);
        return;
      }
    }
    every(rotate, ROTATE_MS);

    return {
      party, counters, chip,
      sync() {
        fillEmpty();
      },
      added() {
        if (mode === 'empty') party();
        fillEmpty();
      },
      removed(id) {
        const i = S.slots.indexOf(id);
        if (i >= 0) {
          S.slots[i] = null;
          slotBoxes[i].replaceChildren();
        }
        fillEmpty();
      },
      rebuild() {
        mode = null;
      },
    };
  }

  // ------------------------------------------------ teardown and the switch to the anthology
  function teardown() {
    dead = true;
    es?.close();
    clearInterval(pollTimer);
    for (const t of timers) {
      if (typeof t === 'object' && t?.disconnect) t.disconnect();
      else clearInterval(t);
    }
    io?.disconnect();
    if (raf) cancelAnimationFrame(raf);
  }
  function toArchive() {
    if (dead) return;
    teardown();
    mountArchive(root, { session, wall });
  }

  // Drying ink settles even when nothing new arrives (paint drops ink older than INK_MS).
  every(() => {
    const now = performance.now();
    for (const rec of S.posts.values()) {
      if (rec.fresh && now - rec.fresh.at >= INK_MS && rec.inkEls?.length) {
        rec.fresh = null;
        for (const s of rec.inkEls) if (s.isConnected) s.replaceWith(...s.childNodes);
        rec.inkEls = null;
      }
    }
  }, 2000);
  measureSkew();
  every(measureSkew, 5 * 60_000); // a laptop that slept, or a clock that drifted
  connect();
}

// ---------------------------------------------------------------- the anthology
// round: a round's number (/archive/<n>): an earlier round's anthology (lib/rounds.js), or the
// current round's.
export async function mountArchive(root, { session, wall = wallWanted(), round = null } = {}) {
  let v;
  let ses = session;
  try {
    [v, ses] = await Promise.all([api(round ? `/api/archive?round=${encodeURIComponent(round)}` : '/api/archive'), api('/api/session').catch(() => session)]);
  } catch (e) {
    fill(root, h('div', { class: 'l-page' }, e.status === 404
      ? [h('h1', { class: 'l-name' }, 'No such round'), h('p', null, h('a', { href: '/' }, 'Go to the party'))]
      : h('p', { class: 'l-status' }, 'Couldn’t load the anthology. Check your connection and reload.')));
    return undefined;
  }
  if (v.party.phase !== 'ended') return mountLive(root, { session: ses });
  const past = !!v.party.past;
  const wallMode = !!wall && !past; // the projector shows the current round
  document.body.classList.toggle('is-projector', wallMode);
  // This round's times (the anthology carries none): the session's, or an earlier round's from its list.
  const timed = Array.isArray(ses?.party?.rounds) ? ses.party.rounds : [];
  const party = past ? timed.find((r) => r.n === v.party.round) || {} : ses?.party || {};
  const name = v.party.name;
  // Several rounds: each anthology says which round it is, and links to the others.
  const rounds = (Array.isArray(v.rounds) ? v.rounds : []).map((r) => ({ ...r, ...(timed.find((x) => x.n === r.n) || {}) }));
  const multi = rounds.length > 0 || v.party.round > 1;
  const roundName = multi && v.party.round ? `round ${v.party.round}` : '';
  document.title = roundName ? `${name}, ${roundName}: the anthology` : `${name}: the anthology`;
  const current = ses?.party || {};
  const others = multi ? [
    ...rounds.filter((r) => r.n !== v.party.round).map((r) => ({ n: r.n, href: `/archive/${r.n}`, label: `Round ${r.n}${r.startedAt ? `, ${longDate(r.startedAt)}` : ''}` })),
    ...(past && current.round ? [{ n: current.round, href: '/', label: `Round ${current.round}${current.phase === 'running' ? ': live now' : current.phase === 'lobby' ? ': coming up' : ''}` }] : []),
  ].sort((a, b) => a.n - b.n) : [];
  const n = v.counters.posts;
  // Everyone who wrote (not the authors of these pieces, which could tie posts together);
  // a small number would say too much, so it shows from three up.
  const w = Number.isFinite(v.counters.participants) && v.counters.participants >= 3 ? v.counters.participants : null;
  const words = v.counters.words;
  const span = party.startedAt && party.endedAt ? party.endedAt - party.startedAt : null;
  const lede = n
    ? `${cap1(spell(n))} ${n === 1 ? 'piece' : 'pieces'} written${party.startedAt ? ` on ${longDate(party.startedAt)}` : ''}${w ? ` by ${spell(w)} writers` : ''}${span ? ` in ${spellHours(span)}` : ''}. ${plural(words, 'word')}${n < 2 ? '.' : v.starredFirst ? '. Signed pieces their writers starred come first; the rest are in no particular order.' : ', in no particular order.'}` // starred first: SPEC §28b
    : 'Nothing was published.';
  const signedIn = !!ses?.user;
  const toc = h('ol', { class: 'a-toc a-list' }, v.posts.map((p, i) => h('li', { class: 'a-entry a-item' },
    h('a', { href: `/p/${encodeURIComponent(p.id)}` },
      h('span', { class: 'a-num' }, String(i + 1)),
      h('span', { class: 'a-entry-main' },
        h('span', { class: 'a-entry-line' },
          h('span', { class: 'a-entry-title' }, p.title || 'Untitled'),
          h('span', { class: 'a-leader', 'aria-hidden': 'true' }),
          h('span', { class: 'a-entry-words' }, plural(p.words, 'word'))),
        p.name ? h('span', { class: 'a-entry-by' }, p.name) : null,
        p.added || p.edited ? h('span', { class: 'a-entry-edited' }, p.added ? 'Added after the party' : 'Edited after the party') : null, // SPEC §30
        p.excerpt ? h('span', { class: 'a-entry-ex' }, blurb(p.excerpt)) : null)))));
  const colophon = h('footer', { class: 'a-colophon' },
    h('p', { class: 'a-orn', 'aria-hidden': 'true' }, '⁂'),
    h('p', null, `Written at ${name}${roundName ? `, ${roundName}` : ''}${party.startedAt ? `, ${longDate(party.startedAt)}` : ''}, in one sitting, and published as it was written. Set in Newsreader and Instrument Sans.`),
    others.length ? h('nav', { class: 'a-rounds', 'aria-label': 'Other rounds' },
      h('p', null, 'The other rounds: ', ...others.flatMap((o, i) => [i ? ' · ' : null, h('a', { href: o.href }, o.label)]))) : null);
  const head = h('header', { class: 'a-head' },
    h('div', { class: 'l-mast-top' },
      h('span', { class: 'l-chip is-ended' }, roundName ? `${name} · Round ${v.party.round}` : `${name}`),
      h('nav', { class: 'l-mast-nav' },
        h('a', { class: 'l-link', href: '/writers' }, 'The writers'), // SPEC §28
        signedIn ? h('a', { class: 'l-link', href: ses.user.isAdmin ? '/host' : '/write' }, ses.user.isAdmin ? 'Host dashboard' : 'Your posts') : h('a', { class: 'l-link', href: '/login' }, 'Sign in'))),
    h('h1', { class: 'a-title' }, 'The anthology'),
    h('p', { class: 'a-lede' }, lede));
  const book = h('div', { class: 'l-page a-page' }, head,
    n ? h('nav', { class: 'a-contents', 'aria-label': 'Contents' }, h('h2', { class: 'a-contents-h' }, 'Contents'), toc) : null,
    colophon);
  if (!wallMode) {
    fill(root, book);
    return undefined;
  }
  // Projector: a wrap screen first, the contents below it.
  const url = (await api('/api/live').catch(() => null))?.party?.joinUrl || location.origin;
  const qr = h('div', { class: 'pj-qr' });
  fill(root, h('div', { class: 'pj pj-ended' },
    h('section', { class: 'pj-wrap' },
      h('p', { class: 'pj-wrap-kicker' }, name),
      h('h1', { class: 'pj-wrap-title' }, 'That’s a wrap'),
      h('p', { class: 'pj-wrap-sum' }, `${cap1(spell(n))} ${n === 1 ? 'piece' : 'pieces'} published · ${plural(words, 'word')} on the page.`),
      h('div', { class: 'pj-join is-small' }, qr, h('div', { class: 'pj-join-text' }, h('p', { class: 'pj-join-k' }, 'Read the anthology at'), h('p', { class: 'pj-join-url' }, displayUrl(url))))),
    book));
  const svg = await qrFor(url, `QR code for ${displayUrl(url)}`);
  if (svg) qr.append(svg);
  return undefined;
}

// ---------------------------------------------------------------- a single post
export async function mountPost(root, { id, session }) {
  let p;
  try {
    p = await api(`/api/p/${encodeURIComponent(id)}`);
  } catch (e) {
    fill(root, h('div', { class: 'l-page p-page' },
      h('p', { class: 'p-back' }, h('a', { href: '/' }, 'Back to the party')),
      h('h1', { class: 'p-title' }, 'Not here'),
      h('p', { class: 'p-missing' }, e.status === 404 ? 'This page isn’t public, or not yet.' : 'Couldn’t load this page. Check your connection and reload.')));
    return undefined;
  }
  document.title = `${p.title || 'Untitled'}: ${p.party}`;
  const running = p.phase === 'running';
  const body = h('div', { class: 'p-body prose' });
  let blocks = renderBlocks(p.text, { notes: footnotes(p.text) }).blocks;
  const notesBox = h('div', { class: 'p-notes prose' }, renderNotes(footnotes(p.text))); // SPEC §31
  body.append(...blocks.map((b) => b.el));
  const end = h('p', { class: 'p-end' }, running ? `${plural(p.words, 'word')} so far` : plural(p.words, 'word'),
    !running && (p.added || p.edited) ? h('span', { class: 'p-edited' }, p.added ? ' · Added after the party' : ' · Edited after the party') : null); // SPEC §30
  const after = h('nav', { class: 'p-after', 'aria-label': 'More from the anthology' });
  // A signed post links to its writer's page while they're on the public list of writers
  // (SPEC §28: `profile` is only ever set on signed posts).
  const by = h('p', { class: 'p-by', hidden: true });
  const more = h('p', { class: 'p-contents p-more', hidden: true });
  let byKey = null;
  const paintBy = (x) => {
    const key = `${x.name || ''}\n${x.profile || ''}`;
    if (key === byKey) return;
    byKey = key;
    const href = x.name && x.profile ? `/w/${encodeURIComponent(x.profile)}` : null;
    fill(by, x.name ? ['by ', href ? h('a', { href }, x.name) : x.name] : null);
    by.hidden = !x.name;
    fill(more, href ? h('a', { href }, `More by ${x.name}`) : null);
    more.hidden = !href;
  };
  paintBy(p);
  // A post of an earlier round (lib/rounds.js) belongs to that round's anthology.
  const home = p.past ? `/archive/${encodeURIComponent(p.round)}` : '/';
  fill(root, h('article', { class: 'l-page p-page' },
    h('p', { class: 'p-back' }, h('a', { href: home }, running ? `${p.party}: live` : p.past ? `${p.party}, round ${p.round}: the anthology` : `${p.party}: the anthology`)),
    running ? h('p', { class: 'p-chip' }, h('i', { 'aria-hidden': 'true' }), 'Being written now') : null,
    h('h1', { class: 'p-title' }, p.title || 'Untitled'),
    by,
    body,
    notesBox,
    end,
    running ? more : null,
    after));
  if (running) {
    // Keep a live page fresh without a stream of its own.
    setInterval(async () => {
      try {
        const n = await api(`/api/p/${encodeURIComponent(id)}`);
        if (n.phase !== 'running') return location.reload();
        if (n.text !== p.text) {
          // Re-render from the block before the first change (the rest stays, and so does the
          // reader's place on the page).
          let from = 0;
          const max = Math.min(n.text.length, p.text.length);
          while (from < max && n.text.charCodeAt(from) === p.text.charCodeAt(from)) from++;
          let k = blocks.findIndex((b) => b.end >= from);
          if (k < 0) k = blocks.length;
          k = Math.max(0, k - 1);
          const start = k === 0 || !blocks.length ? 0 : blocks[k].start;
          for (let j = k; j < blocks.length; j++) blocks[j].el.remove();
          const notes = footnotes(n.text);
          const r = renderBlocks(n.text.slice(start), { base: start, notes }).blocks;
          fill(notesBox, renderNotes(notes));
          body.append(...r.map((b) => b.el));
          blocks = blocks.slice(0, k).concat(r);
          p = n;
          end.textContent = `${plural(p.words, 'word')} so far`;
        }
        paintBy(n);
      } catch { /* keep the last text */ }
      return undefined;
    }, 5000);
    return undefined;
  }
  // After the party: an ornament, then the next piece in the anthology's order.
  try {
    const a = await api(p.past ? `/api/archive?round=${encodeURIComponent(p.round)}` : '/api/archive');
    const i = a.posts.findIndex((x) => x.id === id);
    const next = i >= 0 ? a.posts[i + 1] : null;
    fill(after,
      h('p', { class: 'a-orn', 'aria-hidden': 'true' }, '⁂'),
      next
        ? h('p', { class: 'p-next' }, h('span', { class: 'p-next-k' }, 'Next'), h('a', { href: `/p/${encodeURIComponent(next.id)}` }, next.title || 'Untitled'))
        : h('p', { class: 'p-next' }, h('span', { class: 'p-next-k' }, 'That’s the last piece')),
      more,
      h('p', { class: 'p-contents' }, h('a', { href: home }, 'All pieces: the contents')));
  } catch {
    if (!more.hidden) fill(after, more); // the end mark, and the writer's page if they have one
  }
  return undefined;
}
