// Invisible and control characters are removed from writing before it is stored, scored or
// streamed: they can split words for the scorer without changing what a reader sees, reorder
// text on the public page, or hide content.
//
// Removed: C0 controls except \t and \n, DEL and C1 controls, every Unicode format character
// (category Cf: U+00AD, U+200B–U+200F, U+202A–U+202E, U+2060–U+2064, U+2066–U+2069, U+FEFF, ...)
// and lone surrogate halves. Kept: ZWJ (U+200D) between emoji; ZWNJ/ZWJ (U+200C/U+200D) between
// letters of scripts that need joiners (Arabic, Indic, ...); tag characters in an emoji flag
// sequence (U+1F3F4 followed by U+E0020–U+E007F).

const SUSPECT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\p{Cf}\ud800-\udfff]/u; // fast check, code points
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const FORMAT = /\p{Cf}/u;
const PICTO = /\p{Extended_Pictographic}/u;
const EMOJI_MOD = /[\u{1F3FB}-\u{1F3FF}︎️]/u;
const JOINING = /[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Nko}\p{Script=Mongolian}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}]/u;

// Code points of `s` with their UTF-16 offsets: [[cp string, index], ...].
function codePoints(s) {
  const out = [];
  for (let i = 0; i < s.length;) {
    const c = s.codePointAt(i);
    const n = c > 0xffff ? 2 : 1;
    out.push([s.slice(i, i + n), i]);
    i += n;
  }
  return out;
}

function keepFormat(cps, j) {
  const ch = cps[j][0];
  if (ch === '‍' || ch === '‌') {
    const prev = cps[j - 1]?.[0];
    const next = cps[j + 1]?.[0];
    if (!prev || !next) return false;
    if (ch === '‍') {
      // Emoji ZWJ sequence: emoji (+ variation selector or skin tone) ZWJ emoji.
      let p = j - 1;
      if (EMOJI_MOD.test(cps[p][0]) && p > 0) p--;
      if (PICTO.test(cps[p][0]) && PICTO.test(next)) return true;
    }
    return JOINING.test(prev) && JOINING.test(next);
  }
  const cp = ch.codePointAt(0);
  if (cp >= 0xe0020 && cp <= 0xe007f) {
    // Emoji tag sequence (England, Scotland, Wales flags): U+1F3F4 then tags.
    let p = j - 1;
    while (p >= 0 && cps[p][0].codePointAt(0) >= 0xe0020 && cps[p][0].codePointAt(0) <= 0xe007f) p--;
    return p >= 0 && cps[p][0] === '\u{1F3F4}';
  }
  return false;
}

// { text, removed }: the clean text and the UTF-16 offsets (in `s`) of every removed unit.
export function sanitizeWithMap(s) {
  if (typeof s !== 'string' || !SUSPECT.test(s)) return { text: s, removed: null };
  const cps = codePoints(s);
  let text = '';
  const removed = [];
  for (let j = 0; j < cps.length; j++) {
    const [ch, i] = cps[j];
    const lone = ch.length === 1 && ch.charCodeAt(0) >= 0xd800 && ch.charCodeAt(0) <= 0xdfff;
    if (lone || CONTROL.test(ch) || (FORMAT.test(ch) && !keepFormat(cps, j))) {
      for (let k = 0; k < ch.length; k++) removed.push(i + k);
      continue;
    }
    text += ch;
  }
  return { text, removed: removed.length ? removed : null };
}

export function sanitizeText(s) {
  return sanitizeWithMap(s).text;
}

// Positions in a client's text where it still has characters the server removed, so the
// client's later ops in the same batch can be mapped onto the canonical text.
export class PhantomMap {
  constructor() {
    this.at = []; // sorted client positions of removed characters
  }
  get size() {
    return this.at.length;
  }
  // Number of phantoms before client position x.
  before(x) {
    let lo = 0;
    let hi = this.at.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.at[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  toCanonical(x) {
    return x - this.before(x);
  }
  // The client deleted [pos, pos+del) and inserted `rawLen` characters at pos, of which the
  // ones at `removed` (offsets in the insert) were dropped by the server.
  apply(pos, del, rawLen, removed) {
    const a = this.before(pos);
    const b = this.before(pos + del);
    const tail = this.at.slice(b).map((x) => x - del + rawLen);
    const fresh = removed ? removed.map((r) => pos + r) : [];
    this.at = this.at.slice(0, a).concat(fresh, tail);
  }
}

// Paste mask ('0'/'1' per whitespace-separated word of the raw insert) carried over to the
// clean insert: a clean word is chosen if every character of it was in a chosen raw word.
export function remapMask(rawIns, removed, mask, rawWords) {
  if (!removed) return mask;
  const chosen = new Uint8Array(rawIns.length);
  rawWords(rawIns).forEach((w, i) => {
    if (mask[i] === '1') chosen.fill(1, w.start, w.end);
  });
  const drop = new Set(removed);
  let clean = '';
  const flags = [];
  for (let i = 0; i < rawIns.length; i++) {
    if (drop.has(i)) continue;
    clean += rawIns[i];
    flags.push(chosen[i]);
  }
  return rawWords(clean).map((w) => (flags.slice(w.start, w.end).every(Boolean) ? '1' : '0')).join('');
}
