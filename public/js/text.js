// Text helpers shared by the server (lib/party.js, lib/scoring.js) and the
// browser (paste dialog). Pure functions, no DOM, no Node APIs.

// Raw words: maximal runs of non-whitespace. Paste masks index into this list.
export function rawWords(text) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text))) out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  return out;
}

const WORDY = /[\p{L}\p{N}]/u;
// An image with no description, "![](/u/….webp#w=…&h=…)": its address is not a word (SPEC §14b).
const EMPTY_IMAGE = /!\[\]\([^)\s]*\)?/g;
// Footnote markers "[^1]" and a note's "[^1]:" label aren't words either (SPEC §31).
const FN_MARK = /\[\^[^\]\s^[]{1,40}\]:?/g;
// A raw word counts as a word only if it has a letter or digit ("—" or "*" alone do not).
// Decided by the raw word alone, so counts kept by deltas around edits stay exact.
export function isWordy(w) {
  if (!WORDY.test(w)) return false;
  let t = w;
  if (t.includes('![](')) t = t.replace(EMPTY_IMAGE, '');
  if (t.includes('[^')) t = t.replace(FN_MARK, '');
  return t === w || WORDY.test(t);
}

export function countWords(text) {
  let n = 0;
  for (const w of rawWords(text)) if (isWordy(w.text)) n++;
  return n;
}

// The run of non-space characters around [from, to) of `text`, widened at most WORD_SCAN_MAX
// characters each way: [a, b). Edits are counted on this window alone (the words around them). A
// word longer than that is cut there and counts as one word either way, so real text counts the
// same, and a pane that is one huge "word" can't make every op scan all of it.
export const WORD_SCAN_MAX = 200;
export function wordSpan(text, from, to) {
  let a = from;
  const aMin = Math.max(0, from - WORD_SCAN_MAX);
  while (a > aMin && !/\s/.test(text[a - 1])) a--;
  let b = to;
  const bMax = Math.min(text.length, to + WORD_SCAN_MAX);
  while (b < bMax && !/\s/.test(text[b])) b++;
  return [a, b];
}

// After the party (SPEC §30), one change that takes this many words or more out of a post at once
// needs a short reason. The server refuses such an op without one (lib/party.js); the editor asks
// before the change goes in (editor.js). Both count with the functions below.
export const BIG_CUT_WORDS = 50;
// How many words deleting text[pos, pos + del) takes out of `text`, counted as countWords counts
// a post, before and after, on the words around the cut only: a word cut in two is still one
// word, and two words the cut joins become one.
export function wordsRemoved(text, pos, del) {
  if (!(del > 0)) return 0;
  const [a, b] = wordSpan(text, pos, pos + del);
  return countWords(text.slice(a, b)) - countWords(text.slice(a, pos) + text.slice(pos + del, b));
}
// ops applied one after another, each { del, ins, deleted (the text it took out), cut (its
// wordsRemoved) } -> the words each one takes out of the post. Text that goes straight back
// isn't taken out: an op that puts back what it deleted, or a deletion whose text the op right
// before or after it puts in elsewhere (a move: a paragraph dragged, notes put in order).
export function cutsOf(ops) {
  return ops.map((o, i) => {
    if (!o.cut) return 0;
    const back = (x) => !!x && !x.del && x.ins === o.deleted;
    return (o.ins || '') === o.deleted || back(ops[i - 1]) || back(ops[i + 1]) ? 0 : o.cut;
  });
}
// The same for ops ({ pos, del, ins }) played one after another on `text`.
export function cutsIn(text, ops) {
  let t = text;
  return cutsOf(ops.map((o) => {
    const del = o.del || 0;
    const ins = o.ins || '';
    const r = { del, ins, deleted: t.slice(o.pos, o.pos + del), cut: wordsRemoved(t, o.pos, del) };
    t = t.slice(0, o.pos) + ins + t.slice(o.pos + del);
    return r;
  }));
}

// Is this line a Markdown quote line ("> ...", up to 3 spaces of indent)?
export function isQuoteLine(line) {
  return /^ {0,3}>/.test(line);
}

// Split a paste into paragraphs and sentences over its raw words, for the
// selector. Returns [{ words: [rawWordIndex...], sentences: [[rawWordIndex...]...] }].
export function paragraphsAndSentences(text) {
  const words = rawWords(text);
  const paras = [];
  let para = null;
  let sentence = null;
  let lastEnd = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const gap = text.slice(lastEnd, w.start);
    const newPara = !para || /\n\s*\n/.test(gap) || (/\n/.test(gap) && /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>)/.test(text.slice(w.start, w.start + 7)));
    if (newPara) {
      para = { words: [], sentences: [] };
      paras.push(para);
      sentence = null;
    }
    if (!sentence) {
      sentence = [];
      para.sentences.push(sentence);
    }
    sentence.push(i);
    para.words.push(i);
    // Sentence ends after ., !, ? or … (optionally followed by closing quotes/brackets).
    if (/[.!?…]["'”’)\]*_]*$/.test(w.text) && !/^(?:[A-Z]\.|Mr\.|Mrs\.|Ms\.|Dr\.|St\.|e\.g\.|i\.e\.|etc\.)$/.test(w.text)) sentence = null;
    lastEnd = w.end;
  }
  return paras;
}

// Invisible and control characters: the server removes them from
// every insert, so the editor strips the same set at input and keeps its copy
// identical. Kept: \t and \n; ZWJ between emoji; ZWJ/ZWNJ between letters of
// scripts that need joiners; tag characters inside an emoji flag sequence.
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\p{Cf}]/u;
const JOINING = /[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Nko}\p{Script=Mongolian}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}]/u;
const EMOJI_BEFORE = /[\p{Extended_Pictographic}\p{Emoji_Modifier}️]/u;
const EMOJI = /\p{Extended_Pictographic}/u;
export function hasInvisible(s) {
  return INVISIBLE.test(s);
}
export function stripInvisible(s) {
  s = String(s ?? '');
  if (!INVISIBLE.test(s)) return s;
  const cps = Array.from(s);
  let out = '';
  let inFlag = false;
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i];
    const cp = c.codePointAt(0);
    if (cp === 0x1f3f4) inFlag = true;
    else if (!(cp >= 0xe0020 && cp <= 0xe007f)) inFlag = false;
    if (!INVISIBLE.test(c)) {
      out += c;
      continue;
    }
    if (c === '\t' || c === '\n') {
      out += c;
      continue;
    }
    const prev = cps[i - 1] || '';
    const next = cps[i + 1] || '';
    if (cp === 0x200d && EMOJI_BEFORE.test(prev) && EMOJI.test(next)) out += c;
    else if ((cp === 0x200c || cp === 0x200d) && JOINING.test(prev) && JOINING.test(next)) out += c;
    else if (cp >= 0xe0020 && cp <= 0xe007f && inFlag) out += c;
  }
  return out;
}

// `ops` ({ pos, del, ins, source? }) played one after another on `text` -> { text, back }: the
// new text, and the ops that undo them (each op's inverse, last first; a move's two ops undo as a
// move again: the text inserted where it was, then deleted where it went). Throws on an op out of
// range. The editor sends `back` for the undo of a planned edit (editor.js OpPlan, footnotes put
// in order).
export function replayOps(text, ops) {
  let t = text;
  const back = [];
  for (const o of ops) {
    if (!(o.pos >= 0 && o.del >= 0 && o.pos + o.del <= t.length)) throw new RangeError('op out of range');
    back.unshift({ pos: o.pos, del: o.ins.length, ins: t.slice(o.pos, o.pos + o.del), ...(o.source ? { source: o.source } : {}) });
    t = t.slice(0, o.pos) + o.ins + t.slice(o.pos + o.del);
  }
  return { text: t, back };
}
