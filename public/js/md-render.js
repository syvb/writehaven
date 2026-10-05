// Light Markdown -> DOM for public pages (no innerHTML, so nothing a writer
// types can become markup). Line breaks are kept as written.
//
// renderBlocks(text, { base, fresh, caret }) -> { blocks: [{ start, end, el }], ink, caretEl }
//   One entry per top-level block with its source range (absolute offsets: base + local),
//   so a live card can re-render only the blocks an edit touched. `fresh` ({ from, to },
//   absolute) is the newest chunk of text: it gets the drying-ink class (one span, split
//   only where markup splits it); `caret` (absolute) places a caret. `ink` and `caretEl`
//   are the elements made for them, so the caller can retire them on the next update.
// renderMarkdown(text, opts) -> a DocumentFragment of the same blocks (base 0).
//
// Images: ![alt](/u/<name>.<ext>) (uploads, same origin) become <img>, lazy-loaded; a line
// holding only an image becomes a <figure> with the alt text as its caption. A size in
// the address fragment (#w=1200&h=800) reserves the image's shape before it loads.
// Any other image address renders as a plain link. Links: http(s) and mailto only;
// bare http(s) addresses become links too.
//
// Footnotes (SPEC §31, footnotes.js): "[^1]" becomes a superscript number linking to its note,
// numbered by first use; a reference without a note stays text. Options: `notes` is
// footnotes(fullText) when `text` is a slice of a longer text (offsets absolute, as `base`);
// `noteDefs: 'list'` (default) leaves note lines out of the flow, for renderNotes(notes) to list
// at the end; 'inline' shows them in place as quiet notes (live cards). `idPrefix` names the
// anchors (default "fn": #fn-1 and #fnref-1).
// renderNotes(notes, { links, idPrefix }) -> <section class="footnotes"> or null.

import { footnotes, FN_DEF } from './footnotes.js';

const HEADING = /^(#{1,6})\s+(.*)$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const FENCE = /^ {0,3}(```|~~~)/;
const ORDERED = /^\s*\d/;
const isBlockStart = (t) => HEADING.test(t) || QUOTE.test(t) || LIST.test(t) || FENCE.test(t) || HR.test(t) || FN_DEF.test(t);

export function renderMarkdown(text, opts = {}) {
  const frag = document.createDocumentFragment();
  const notes = opts.notes || footnotes(text);
  for (const b of renderBlocks(text, { ...opts, notes }).blocks) frag.append(b.el);
  if (opts.noteDefs !== 'inline') {
    const sec = renderNotes(notes, opts);
    if (sec) frag.append(sec);
  }
  return frag;
}

// Spoilers (LessWrong's ">!" lines): `spoilers: 'details'` (default) renders a closed
// <details> ("Spoiler · tap to reveal"); 'hide' (inside a link, e.g. a live card) shows only
// a quiet "Spoiler" placeholder and never the text.
const SPOILER = /^ {0,3}>!/;
// `links: false` (inside a link, e.g. a live card) sets links as styled text, never nested <a>.
export function renderBlocks(text, { base = 0, fresh = null, caret = null, spoilers = 'details', links = true, notes = null, noteDefs = 'list', idPrefix = 'fn' } = {}) {
  const lines = [];
  let off = base;
  for (const l of text.split('\n')) {
    lines.push({ text: l, start: off });
    off += l.length + 1;
  }
  const hasCaret = caret !== null && caret !== undefined;
  const fn = notes || footnotes(text);
  const noteLine = notes ? (s) => fn.noteLines.has(s) : (s) => fn.noteLines.has(s - base);
  const ctx = { fresh: fresh && fresh.to > fresh.from ? fresh : null, caret: hasCaret ? caret : null, caretDone: !hasCaret, ink: [], caretEl: null, links, fn, idPrefix, refIds: new Set() };
  const blocks = [];
  const lineEnd = (k) => lines[k].start + lines[k].text.length;
  let i = 0;
  while (i < lines.length) {
    const L = lines[i];
    if (!L.text.trim()) {
      i++;
      continue;
    }
    const first = i;
    let last = i;
    let el;
    let m;
    if (fn.noteLines.size && noteLine(L.start) && (m = FN_DEF.exec(L.text))) {
      // A footnote's note (and its indented lines): listed at the end, or shown here as a quiet
      // note (live cards).
      if (noteDefs !== 'inline') {
        i++;
        while (i < lines.length && noteLine(lines[i].start) && !FN_DEF.test(lines[i].text)) i++;
        continue;
      }
      el = document.createElement('p');
      el.className = 'fn-def';
      const num = fn.order.get(m[1]);
      const sup = document.createElement('sup');
      sup.className = 'fn-num';
      sup.textContent = num ? String(num) : m[1];
      el.append(sup, ' ');
      inline(el, L.text.slice(m[0].length), L.start + m[0].length, ctx);
      i++;
      while (i < lines.length && noteLine(lines[i].start) && !FN_DEF.test(lines[i].text)) {
        const t = lines[i].text;
        if (t.trim()) {
          const content = t.replace(/^\s+/, '');
          el.append(document.createElement('br'));
          inline(el, content, lines[i].start + t.length - content.length, ctx);
        }
        last = i;
        i++;
      }
    } else if (FENCE.test(L.text)) {
      const fence = L.text.trim().slice(0, 3);
      el = document.createElement('pre');
      const code = document.createElement('code');
      el.append(code);
      i++;
      const body = [];
      while (i < lines.length && !lines[i].text.trim().startsWith(fence)) body.push(lines[i++]);
      last = Math.min(i, lines.length - 1);
      i++;
      body.forEach((b, k) => {
        emit(code, b.text, b.start, ctx);
        if (k < body.length - 1) code.append('\n');
      });
    } else if (HR.test(L.text)) {
      el = document.createElement('hr');
      i++;
    } else if ((m = HEADING.exec(L.text))) {
      el = document.createElement(`h${Math.min(6, m[1].length + 1)}`);
      inline(el, m[2], L.start + L.text.indexOf(m[2], m[1].length), ctx);
      i++;
    } else if (SPOILER.test(L.text)) {
      // Consecutive ">!" (or plain ">") lines after a ">!" line form one spoiler.
      const hidden = spoilers === 'hide';
      const body = document.createElement('div');
      body.className = 'spoiler-body';
      let p = null;
      let caretHere = false;
      while (i < lines.length && QUOTE.test(lines[i].text)) {
        const t = lines[i].text;
        const content = t.replace(/^ {0,3}>!? ?/, '');
        const start = lineEnd(i) - content.length;
        if (!ctx.caretDone && ctx.caret >= lines[i].start && ctx.caret <= lineEnd(i)) caretHere = true;
        if (!hidden) {
          if (!content.trim()) p = null;
          else {
            if (!p) {
              p = document.createElement('p');
              body.append(p);
            } else p.append(document.createElement('br'));
            inline(p, content, start, ctx);
          }
        }
        last = i;
        i++;
      }
      if (hidden) {
        el = document.createElement('p');
        el.className = 'spoiler is-hidden';
        el.append('Spoiler');
        if (caretHere) el.append(caretEl(ctx));
      } else {
        el = document.createElement('details');
        el.className = 'spoiler';
        const sum = document.createElement('summary');
        sum.append('Spoiler · tap to reveal');
        el.append(sum, body);
      }
    } else if (QUOTE.test(L.text)) {
      el = document.createElement('blockquote');
      let p = null;
      while (i < lines.length && (m = QUOTE.exec(lines[i].text))) {
        const content = m[1];
        const start = lineEnd(i) - content.length;
        if (!content.trim()) {
          p = null;
        } else {
          if (!p) {
            p = document.createElement('p');
            el.append(p);
          } else p.append(document.createElement('br'));
          inline(p, content, start, ctx);
        }
        last = i;
        i++;
      }
    } else if (LIST.test(L.text)) {
      // One list for consecutive items of one kind, also across blank lines (so "1." "2."
      // separated by empty lines stay one numbered list); numbering starts at the first marker.
      const ordered = ORDERED.test(L.text);
      el = document.createElement(ordered ? 'ol' : 'ul');
      if (ordered) {
        const n = parseInt(L.text.trim(), 10);
        if (Number.isFinite(n) && n !== 1) el.start = n;
      }
      let li = null;
      while (i < lines.length) {
        const t = lines[i].text;
        const mm = LIST.exec(t);
        if (mm) {
          if (ORDERED.test(t) !== ordered) break;
          li = document.createElement('li');
          const depth = Math.min(4, Math.floor(mm[1].replace(/\t/g, '    ').length / 2));
          if (depth) li.style.marginLeft = `${depth * 1.2}em`;
          inline(li, mm[3], lineEnd(i) - mm[3].length, ctx);
          el.append(li);
          last = i;
          i++;
          continue;
        }
        if (!t.trim()) {
          let j = i;
          while (j < lines.length && !lines[j].text.trim()) j++;
          if (j < lines.length && LIST.test(lines[j].text) && ORDERED.test(lines[j].text) === ordered) {
            i = j;
            continue;
          }
          break;
        }
        // An indented line right under an item continues that item.
        if (li && i === last + 1 && /^(?: {2,}|\t)/.test(t) && !isBlockStart(t)) {
          const content = t.trim();
          li.append(document.createElement('br'));
          inline(li, content, lines[i].start + t.indexOf(content), ctx);
          last = i;
          i++;
          continue;
        }
        break;
      }
    } else if (lines[i].text.trim() && (m = IMAGE_LINE.exec(lines[i].text)) && isUpload(m[2])) {
      // A line holding only an uploaded image: a figure, captioned with its alt text.
      el = document.createElement('figure');
      const altStart = L.start + L.text.indexOf('![') + 2;
      el.append(imageEl(m[2], m[1]));
      if (m[1].trim()) {
        const cap = document.createElement('figcaption');
        cap.setAttribute('aria-hidden', 'true'); // the alt text already says it
        emit(cap, m[1], altStart, ctx, false);
        el.append(cap);
      } else if (!ctx.caretDone && ctx.caret >= L.start && ctx.caret <= lineEnd(i)) el.append(caretEl(ctx));
      i++;
    } else {
      // Paragraph: consecutive plain lines, line breaks kept. Its first line is always taken: a
      // line that reaches here is plain text, even one that looks like a block start (a note
      // nobody refers to, say), and a paragraph that took none would loop here forever.
      el = document.createElement('p');
      let firstLine = true;
      while (i < lines.length && lines[i].text.trim() && (firstLine || !isBlockStart(lines[i].text))) {
        if (!firstLine) el.append(document.createElement('br'));
        inline(el, lines[i].text, lines[i].start, ctx);
        firstLine = false;
        last = i;
        i++;
      }
    }
    if (i <= first) i = first + 1; // every block moves past its first line
    blocks.push({ start: lines[first].start, end: lineEnd(last), el });
  }
  if (!ctx.caretDone) {
    if (!blocks.length) blocks.push({ start: base, end: base, el: document.createElement('p') });
    const lastEl = blocks[blocks.length - 1].el;
    const target = lastEl.tagName === 'HR' ? lastEl.parentNode || lastEl : deepestLast(lastEl);
    if (target !== lastEl || lastEl.tagName !== 'HR') target.append(caretEl(ctx));
  }
  return { blocks, ink: ctx.ink, caretEl: ctx.caretEl };
}

function deepestLast(el) {
  let e = el;
  while (e.lastElementChild && !['BR', 'HR'].includes(e.lastElementChild.tagName)
    && !e.lastElementChild.classList.contains('ink') && !e.lastElementChild.classList.contains('caps')) e = e.lastElementChild;
  return e;
}
function caretEl(ctx) {
  const c = document.createElement('span');
  c.className = 'caret';
  c.setAttribute('aria-hidden', 'true');
  ctx.caretEl = c;
  ctx.caretDone = true;
  return c;
}

// Inline: `code`, **strong**, *em* / _em_, ~~strike~~, ![alt](src), [text](url), bare URLs.
// No lookbehind (Safari before 16.4 can't parse it): "_em_" and bare links check the character
// before them in inline() instead.
const INLINE = /(`+)([^`]+?)\1|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__|\*(?=\S)([^*]*?\S)\*|_(?=\S)([^_]*?\S)_(?![\p{L}\p{N}])|~~(?=\S)([\s\S]*?\S)~~|!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(https?:\/\/[^\s<>()\[\]]*[^\s<>()\[\].,;:!?'"’”*_~])|\[\^([^\]\s^[]{1,40})\]/u;
const IMAGE_LINE = /^\s*!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/;
const UPLOAD = /^\/u\/(?:hotlink-ok\/)?[A-Za-z0-9_-]{6,80}\.(?:webp|png|jpe?g|gif)(?:#[^\s]*)?$/i;
// Same-origin uploads, also written as a full address (https://<this site>/u/...).
const isUpload = (src) => UPLOAD.test(src) || (typeof location !== 'undefined' && src.startsWith(`${location.origin}/u/`) && UPLOAD.test(src.slice(location.origin.length)));
const safeHref = (url) => /^(https?:|mailto:)/i.test(url);
function imageEl(src, alt) {
  const [path, frag = ''] = (typeof location !== 'undefined' && src.startsWith(location.origin) ? src.slice(location.origin.length) : src).split('#');
  const img = document.createElement('img');
  // By the /u/hotlink-ok/ address (see lib/uploads.js), so a reader's copy of the page pastes
  // into other sites' editors with its images.
  img.src = UPLOAD.test(path) && !path.startsWith('/u/hotlink-ok/') ? `/u/hotlink-ok/${path.slice(3)}` : path;
  img.alt = alt.trim() || 'Image';
  img.loading = 'lazy';
  img.decoding = 'async';
  const q = new URLSearchParams(frag);
  const w = Number(q.get('w'));
  const hgt = Number(q.get('h'));
  if (w > 0 && hgt > 0 && w < 20000 && hgt < 20000) {
    img.width = Math.round(w);
    img.height = Math.round(hgt);
    img.style.aspectRatio = `${Math.round(w)} / ${Math.round(hgt)}`;
  }
  return img;
}

function inline(parent, s, start, ctx) {
  let rest = s;
  let base = start;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      emit(parent, rest, base, ctx);
      return;
    }
    // "_em_" never follows a letter or digit, and a bare link never follows one or "/".
    if ((m[6] !== undefined || m[12] !== undefined) && m.index > 0) {
      const prev = [...rest.slice(Math.max(0, m.index - 2), m.index)].pop();
      if ((m[12] !== undefined ? /[\p{L}\p{N}/]/u : /[\p{L}\p{N}]/u).test(prev)) {
        emit(parent, rest.slice(0, m.index + 1), base, ctx);
        base += m.index + 1;
        rest = rest.slice(m.index + 1);
        continue;
      }
    }
    if (m.index) emit(parent, rest.slice(0, m.index), base, ctx);
    const at = base + m.index;
    let el;
    if (m[1]) {
      el = document.createElement('code');
      emit(el, m[2], at + m[1].length, ctx, false);
      parent.append(el);
    } else if (m[9] !== undefined) {
      // ![alt](src): an upload becomes an image; anything else a plain link (or text).
      const src = m[9];
      if (isUpload(src)) {
        el = imageEl(src, m[8]);
        if (!ctx.caretDone && ctx.caret >= at && ctx.caret <= at + m[0].length) {
          parent.append(el);
          el = caretEl(ctx);
        }
        parent.append(el);
      } else {
        el = safeHref(src) ? linkEl(src, ctx) : document.createElement('span');
        if (m[8].trim()) inline(el, m[8], at + 2, ctx);
        else el.append(src.replace(/^https?:\/\//i, ''));
        parent.append(el);
      }
    } else if (m[10] !== undefined) {
      const url = m[11];
      el = safeHref(url) ? linkEl(url, ctx) : document.createElement('span');
      inline(el, m[10], at + 1, ctx);
      parent.append(el);
    } else if (m[12] !== undefined) {
      el = linkEl(m[12], ctx);
      emit(el, m[12], at, ctx, false);
      parent.append(el);
    } else if (m[13] !== undefined) {
      // A footnote reference: its number, or the text as written when it has no note.
      const num = ctx.fn ? ctx.fn.order.get(m[13]) : undefined;
      if (num) {
        parent.append(noteRef(num, ctx));
        if (!ctx.caretDone && ctx.caret > at && ctx.caret < at + m[0].length) parent.append(caretEl(ctx));
      } else emit(parent, m[0], at, ctx, false);
    } else {
      const kinds = [[3, 'strong', 2], [4, 'strong', 2], [5, 'em', 1], [6, 'em', 1], [7, 's', 2]];
      for (const [g, tag, w] of kinds) {
        if (m[g] !== undefined) {
          el = document.createElement(tag);
          inline(el, m[g], at + w, ctx);
          parent.append(el);
          break;
        }
      }
    }
    base = at + m[0].length;
    rest = rest.slice(m.index + m[0].length);
  }
}

// "<sup><a href="#fn-2" id="fnref-2">2</a></sup>" (the id on its first use only); a plain
// superscript where links can't be (inside a live card's link).
function noteRef(num, ctx) {
  const sup = document.createElement('sup');
  sup.className = 'fn-ref';
  let target = sup;
  if (ctx.links !== false) {
    const a = document.createElement('a');
    a.href = `#${ctx.idPrefix}-${num}`;
    if (!ctx.noIds && !ctx.refIds.has(num)) {
      ctx.refIds.add(num);
      a.id = `${ctx.idPrefix}ref-${num}`;
    }
    a.setAttribute('aria-label', `Note ${num}`);
    sup.append(a);
    target = a;
  }
  target.append(String(num));
  return sup;
}

// The notes, numbered by first use, each with a link back to where it's first referred to.
export function renderNotes(notes, { links = true, idPrefix = 'fn' } = {}) {
  if (!notes || !notes.order.size) return null;
  const ctx = { fresh: null, caret: null, caretDone: true, ink: [], caretEl: null, links, fn: notes, idPrefix, refIds: new Set(), noIds: true };
  const sec = document.createElement('section');
  sec.className = 'footnotes';
  sec.setAttribute('aria-label', 'Notes');
  const head = document.createElement('h2');
  head.className = 'fn-h';
  head.textContent = 'Notes';
  const ol = document.createElement('ol');
  for (const [label, num] of notes.order) {
    const d = notes.defs.get(label);
    const li = document.createElement('li');
    if (links) li.id = `${idPrefix}-${num}`;
    d.body.split('\n').forEach((t, k) => {
      if (k) li.append(document.createElement('br'));
      inline(li, t, 0, ctx);
    });
    if (links) {
      const back = document.createElement('a');
      back.className = 'fn-back';
      back.href = `#${idPrefix}ref-${num}`;
      back.setAttribute('aria-label', `Back to the text of note ${num}`);
      back.textContent = '\u21A9\uFE0E';
      li.append(' ', back);
    }
    ol.append(li);
  }
  sec.append(head, ol);
  return sec;
}

function linkEl(url, ctx) {
  if (ctx && ctx.links === false) {
    const span = document.createElement('span');
    span.className = 'link';
    return span;
  }
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'nofollow noopener noreferrer';
  a.target = '_blank';
  return a;
}

// Emit plain text whose first char is at source offset `start`, splitting out the
// fresh range (drying ink), the caret and runs of capitals.
function emit(parent, str, start, ctx, caps = true) {
  if (!str) return;
  if (!ctx.caretDone && ctx.caret < start) parent.append(caretEl(ctx)); // the caret sat in hidden markup
  const end = start + str.length;
  const f = ctx.fresh;
  const pts = [start];
  if (f && f.to > start && f.from < end) {
    if (f.from > start) pts.push(f.from);
    if (f.to < end) pts.push(f.to);
  }
  if (!ctx.caretDone && ctx.caret > start && ctx.caret < end) pts.push(ctx.caret);
  pts.sort((a, b) => a - b);
  pts.push(end);
  for (let k = 0; k < pts.length; k++) {
    const a = pts[k];
    if (!ctx.caretDone && ctx.caret === a) parent.append(caretEl(ctx));
    if (k === pts.length - 1) break;
    const b = pts[k + 1];
    if (b <= a) continue;
    const piece = str.slice(a - start, b - start);
    if (f && f.from <= a && f.to >= b) {
      const span = document.createElement('span');
      span.className = 'ink';
      text(span, piece, caps);
      parent.append(span);
      ctx.ink.push(span);
    } else text(parent, piece, caps);
  }
}

// Runs of capitals (two or more letters, e.g. "DO NOT ENTER", "NASA") get .caps, so
// they can be set as letter-spaced small capitals instead of shouting.
const CAPS = /\p{Lu}{2,}(?:(?:[ \u00a0]+|[-'’/&])\p{Lu}{2,})*(?!\p{Ll})/gu;
function text(parent, s, caps) {
  if (!caps || !/\p{Lu}\p{Lu}/u.test(s)) {
    parent.append(s);
    return;
  }
  let last = 0;
  CAPS.lastIndex = 0;
  let m;
  while ((m = CAPS.exec(s))) {
    // Not the tail of a word in mixed case ("McDONALD"): the run must start a word.
    if (m.index > 0 && /[\p{L}\p{N}]/u.test(s[m.index - 1])) continue;
    if (m.index > last) parent.append(s.slice(last, m.index));
    const span = document.createElement('span');
    span.className = 'caps';
    span.textContent = m[0];
    parent.append(span);
    last = m.index + m[0].length;
  }
  if (last < s.length) parent.append(s.slice(last));
}

// Words, as the server counts them (runs of non-space characters holding a letter or a
// digit), leaving out images, link addresses and bare URLs. Nothing here spans a line,
// so counting line by line adds up (live cards recount only the lines an edit touched).
const NOT_WORDS = /!\[[^\]\n]*\]\([^)\s]*(?:\s+"[^"]*")?\)|\]\([^)\s]*(?:\s+"[^"]*")?\)|\bhttps?:\/\/\S+/gi;
export function wordsIn(text) {
  const t = text.replace(NOT_WORDS, (x) => (x[0] === ']' ? '] ' : ' '));
  let n = 0;
  const re = /\S+/g;
  let m;
  while ((m = re.exec(t))) if (/[\p{L}\p{N}]/u.test(m[0])) n++;
  return n;
}
