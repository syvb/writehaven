// Writehaven scoring: "settled new words" (SPEC §11). Pure, deterministic, zero dependencies.
// Paste rules (SPEC §12):
//   - short pastes (<= pasteAskOverWords words) count like typing (no dialog), subject to
//     settling and each-word-counts-once;
//   - pasted words that duplicate the writer's own text never count, whatever the paste's
//     length: text in any of their posts or notes now, text they cut in the last
//     ownCutWindowMin minutes, or text they pasted before (runs of 2+ words, or the word
//     itself for a one-word paste; pairs of common function words alone don't match);
//   - an hour that needs >= bigPasteWords pasted words to reach its target goes to review;
//   - target 400 words an hour.
//
// The rule, as writers see it:
//   Your bar counts the new words you write. A word counts once it has stayed on the
//   page for 90 seconds, so typos, autocorrect and quick changes cost nothing. Each piece
//   of writing counts once: retyping, re-pasting, moving or shuffling words you have
//   already been credited for adds nothing (rewording does: new words are new). Cutting
//   text that has been there 10+ minutes earns half a word per word (at most half the
//   hour's target), unless it comes back. Pasted text counts only if you confirm you wrote it today.
//   Quote lines count like any other text (SPEC §30); notes count like the post. Anything odd
//   is shown to the host, never silently removed.
//
// API
//   score(ops, settings?, ctx?)            -> Result   one writer, whole log
//   createScorer(settings?, ctx?)          -> Scorer   one writer, incremental:
//       .apply(op)         ops in non-decreasing time (earlier times are clamped)
//       .advance(t)        settle everything due by t (call on a timer for live bars)
//       .result(now?)      per-hour credit, breakdown, flags, status
//       .pasteCheck(text)  per raw word: { own, other } for the paste dialog
//   createParty(settings?, ctxByWriter?)   -> { apply(writer, op), advance(t), result(writer, now?) }
//       all writers settle in lockstep, needed for "matches another writer's text"
//   scoreParty(opsByWriter, settings?, ctxByWriter?, now?) -> { [writer]: Result }
//
// Op: { t: ms, post, pane: 'body'|'notes'|..., pos, del: chars deleted at pos, ins: string,
//       source: 'type'|'ime'|'autocorrect'|'dictation'|'paste',
//       confirm?: 'all'|'none'|[[from,to),...],    (paste ops: char ranges of `ins` the writer
//                                                    marked "I wrote this today, for this party")
//       r?: ms }  when the server received the op, if that was later than `t` (offline queues).
//       Credit that lands in an hour which had already ended (by more than LATE_GRACE_MS) when
//       it was received is "late": an hour met only thanks to late credit goes to review
//       (flag lateWork), so offline back-dating can never heal a closed hour silently.
//   Send drag-and-drop moves as source 'paste'; send undo/redo as 'type' (a redo labelled
//   'paste' would turn a quickly undone short sentence into an uncounted short paste).
//   source 'move' (footnotes put in order, SPEC §31): text moved inside a pane, as two ops in a
//   row, the text inserted where it goes, then the same text deleted where it was. The moved
//   characters keep what the scorer knows of them (credit, settling, marks), so a move earns and
//   costs nothing (_moveIn, _moveOut). Any other op marked 'move' is plain typing, and an insert
//   that no such delete follows never counts.
// ctx: { joinedAt?: ms (default first op), breaks?: [{startAt,endAt}], target?: number,
//        shareable?: (post, pane) => bool (may this text be matched by other writers?),
//        targets?: {hourIndex: number}, freeHours?: [hourIndex], timeline?: bool,
//        creditFrom?: ms (text inserted before this never counts: synced hours, SPEC §17) }
// op.noCredit: the insert never counts (ideas moved into planning notes, SPEC §17).
//
// Result: { now, hours: [{ k, startAt, endAt, target, status: 'open'|'met'|'review'|'missed'|'free',
//           credit, written, pasted, cut, clawback, flaggedCredit, notCounted: {...}, flags: [...] }],
//           totals, pending, flags }
//   'review' = the hour reaches the target only thanks to credit the host should look at
//   (gibberish, lorem, word salad, repetition, macro-sized inserts, steady machine-like
//   typing, mostly deleted typing, mostly re-used words, big confirmed pastes).

export const DEFAULT_SETTINGS = Object.freeze({
  targetPerHour: 400, // words of new writing per hour (SPEC §11)
  hourLengthMin: 60, // test knob to compress hours
  unit: 'word', // 'word': each new word = 1 (one-letter words 0.5) | 'chars': (letters+1)/charsPerWord
  oneLetterWord: 0.5,
  charsPerWord: 6,
  maxTokenWords: 2,
  cjkCharWords: 0.6, // Han/Kana characters: words per character
  settleSec: 90, // text must stay this long to count
  settleQuantumSec: 5, // settling is evaluated on this time grid (deterministic, cheap)
  contextWords: 6, // "already written" = a 6-word window already credited to you
  reuseWindowMin: 10, // re-typing words deleted in the last 10 min (or deleting words just re-typed)...
  reuseWeight: 0, // ...earns this fraction (0: each word counts once)
  cutWeight: 0.5, // cutting credited text: this per word removed...
  cutMatureMin: 10, // ...if it had been on the page this long...
  cutCapPerHour: null, // ...up to this much per hour (null: half the hour's target)
  pasteAskOverWords: 12, // longer pastes ask "did you write this today?"; shorter ones don't ask...
  shortPastesCount: true, // ...and count like typing (SPEC §12); false: short pastes count nothing
  ownCutWindowMin: 60, // pasted words that match text cut this recently (or in the posts now, or pasted before) earn 0
  speedCapWpm: 90, // credited typing per rolling 60 s
  dictationCapWpm: 180,
  // flags for the host
  flagBlockWords: 50,
  bulkInsertWords: 25, // one non-paste op inserting this many words (text expansion, macro)
  bulkDictationWords: 80,
  // ...or a contiguous run at one place (no cursor jump) growing by this many words within
  // burstWindowSec, not counting the run's first op in the window: pasting in chunks labelled
  // as typing. Tuned on simulated sessions (honest phone and dictation profiles stay well below).
  burstWindowSec: 20,
  burstTypingWords: 40,
  burstDictationWords: 90,
  bigPasteWords: 100,
  reviewBigPastes: true, // an hour that needs >= bigPasteWords pasted words (confirmed or short) to meet its target goes to review
  pasteCapPerHour: null, // optional: confirmed paste credit per hour at most this (null = no cap)
  otherWriterFlagWords: 10,
  sustainedWindowMin: 5,
  sustainedWpm: 60,
  steadyMinWords: 300, // typing with almost no pauses >= 2 s looks like transcription or a macro
  steadyPauseSec: 2,
  steadyPausesPer100: 2,
  reuseFlagShare: 0.4,
  reuseReviewShare: 0.6,
  reuseFlagMinWords: 60,
  recycleFlagShare: 0.4,
  recycleFlagMinWords: 100,
  discardWindowMin: 15, // credited words deleted within this long of being written...
  discardFlagShare: 0.75, // ...making up more than this share of the hour's writing
  discardFlagMinWords: 100,
});

const FN_EN = 'the of and to a in is it that was for on are as with his they i at be this have from or one had by but not what all were we when your can there an each which she do how their if will up other about out many then them these so some her would make like him into has two more no way could my than been who its now did get come made may over me you he our us am any just very also only even because through much before after those where why too here still should own both few most such off again while being under until against between once does nor same ever every never yet though although upon without within during whether might must shall myself itself himself herself themselves dont im thats isnt didnt wasnt cant wont ive youre theyre theres whats lets oh yes said got went back'.split(' ');
const FN_OTHER = (
  'der die das und ist nicht ein eine zu den von mit sich des auf für im dem es ich sie er wir auch als an aber wie ' +
  'le la les de des du et est un une en que qui dans pour pas sur au avec il elle je nous vous ce ne se ' +
  'el los las del y por con para su al lo como más pero sus ya ' +
  'lo gli di che è per non si da della nel ma ' +
  'o os as do da em um uma não no na mais mas ' +
  'het een van dat te zijn op voor niet aan er ook maar ' +
  'и в не на я что он с как а то это по но из у за от так же к вы мы она они'
).split(' ');
export const FUNCTION_WORDS = new Set([...FN_EN, ...FN_OTHER]);
const COMMON = new Set(FN_EN); // never matched by the pane-wide re-use bag (they recur in any text)
const LOREM = new Set(('lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum perspiciatis unde omnis iste natus error voluptatem accusantium doloremque laudantium totam rem aperiam eaque ipsa quae ab illo inventore veritatis quasi architecto beatae vitae dicta explicabo nemo ipsam quia voluptas aspernatur aut odit fugit consequuntur magni dolores eos ratione sequi nesciunt neque porro quisquam dolorem adipisci numquam eius modi tempora incidunt magnam quaerat').split(' '));

// Format characters (zero-width etc.) are word characters here, so a word with one inside is one
// token; the server strips them before storage anyway (lib/sanitize.js), this covers old logs.
const WORDCH_RE = /[\p{L}\p{N}\p{M}\p{Cf}]/u;
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const NONALNUM_RE = /[^\p{L}\p{N}]+/gu;

function isWordCh(c) {
  if (c === undefined) return false;
  const k = c.charCodeAt(0);
  if (k < 128) return (k >= 48 && k <= 57) || (k >= 65 && k <= 90) || (k >= 97 && k <= 122);
  return WORDCH_RE.test(c);
}
function isCJK(c) {
  return c !== undefined && c.charCodeAt(0) >= 0x3040 && CJK_RE.test(c);
}
function isApos(c) {
  return c === "'" || c === '’';
}
export function normalizeToken(s) {
  return s.normalize('NFKC').toLowerCase().replace(NONALNUM_RE, '');
}
// Look-alike Cyrillic and Greek letters (and a few Latin variants) folded to Latin, for the
// "already written" keys only: a word retyped with a homoglyph is still the same word. The
// text checks (word salad etc.) and the stored text never see this folding.
const FOLD = new Map(Object.entries({
  а: 'a', в: 'b', е: 'e', ё: 'e', з: '3', і: 'i', ї: 'i', ј: 'j', к: 'k', м: 'm', н: 'h', о: 'o', п: 'n', р: 'p', с: 'c',
  т: 't', у: 'y', х: 'x', ѕ: 's', ԁ: 'd', ԛ: 'q', ԝ: 'w', һ: 'h', ӏ: 'l', ь: 'b', г: 'r',
  α: 'a', β: 'b', γ: 'y', ε: 'e', ζ: 'z', η: 'n', ι: 'i', κ: 'k', μ: 'u', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w', ς: 's',
  ı: 'i', ɩ: 'i', ɑ: 'a', ɡ: 'g', ʏ: 'y', ꞵ: 'b',
}));
const PLAIN_KEY = /^[a-z0-9]*$/;
export function foldKey(norm) {
  if (PLAIN_KEY.test(norm)) return norm;
  let out = '';
  for (const ch of norm) out += FOLD.get(ch) ?? ch;
  return out;
}
// Bounds [s, e) of the token containing index i (a word character).
function tokenAt(text, i) {
  if (isCJK(text[i])) return [i, i + 1];
  const plain = (c) => isWordCh(c) && !isCJK(c);
  let s = i;
  while (s > 0) {
    const c = text[s - 1];
    if (plain(c)) s--;
    else if (isApos(c) && plain(text[s - 2])) s--;
    else break;
  }
  let e = i + 1;
  while (e < text.length) {
    const c = text[e];
    if (plain(c)) e++;
    else if (isApos(c) && plain(text[e + 1])) e++;
    else break;
  }
  return [s, e];
}
function tokensIn(text, from, to) {
  const out = [];
  for (let i = from; i < to; ) {
    if (!isWordCh(text[i])) {
      i++;
      continue;
    }
    const [s, e] = tokenAt(text, i);
    out.push([s, e, foldKey(normalizeToken(text.slice(s, e)))]);
    i = e;
  }
  return out;
}
// Normalised tokens before `pos` (oldest first) / from `pos` on: at most n, bounded scan.
function prevTokens(text, pos, n, maxScan = 400) {
  const out = [];
  let j = pos - 1;
  let scanned = 0;
  while (out.length < n && j >= 0 && scanned < maxScan) {
    if (isWordCh(text[j])) {
      const [s, e] = tokenAt(text, j);
      const nt = foldKey(normalizeToken(text.slice(s, e)));
      if (nt) out.push(nt);
      scanned += e - s;
      j = s - 1;
    } else {
      j--;
      scanned++;
    }
  }
  return out.reverse();
}
function nextTokens(text, pos, n, maxScan = 400) {
  const out = [];
  let j = pos;
  let scanned = 0;
  while (out.length < n && j < text.length && scanned < maxScan) {
    if (isWordCh(text[j])) {
      const [s, e] = tokenAt(text, j);
      const nt = foldKey(normalizeToken(text.slice(s, e)));
      if (nt) out.push(nt);
      scanned += e - s;
      j = e;
    } else {
      j++;
      scanned++;
    }
  }
  return out;
}
// Raw words (maximal non-space runs) containing a letter or digit: the paste-dialog unit.
export function rawWords(text) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text))) if (/[\p{L}\p{N}]/u.test(m[0])) out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  return out;
}
export function countWords(text) {
  return rawWords(text).length;
}
// 53-bit string hash (cyrb53).
export function hash53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
const gramKey = (toks, from, to) => hash53(toks.slice(from, to).join(' '));
// A window shorter than the context (a pane's first few words) only matches in the same pane: two
// posts that both open "The quiet" aren't copied writing, nor one's own repeat.
const windowKey = (P, toks, from, to, K) => (to - from < K ? hash53(`${P.key}\u0001${toks.slice(from, to).join(' ')}`) : gramKey(toks, from, to));

// Block features for "does this read like prose?" (flags only, never silent zeroing).
export function textFeatures(norms) {
  let latin = 0;
  let fn = 0;
  let vowelless = 0;
  let consRun = 0;
  let lorem = 0;
  let single = 0;
  let letters = 0;
  const uniq = new Set();
  for (const w of norms) {
    uniq.add(w);
    letters += w.length;
    if (FUNCTION_WORDS.has(w)) fn++;
    if (LOREM.has(w)) lorem++;
    if (/^[a-z]+$/.test(w)) {
      latin++;
      if (w.length >= 2 && !/[aeiouy]/.test(w)) vowelless++;
      if (/[bcdfghjklmnpqrstvwxz]{5,}/.test(w)) consRun++;
      if (w.length === 1 && w !== 'a' && w !== 'i') single++;
    }
  }
  const n = Math.max(1, norms.length);
  const L = Math.max(1, latin);
  return {
    n: norms.length,
    latinShare: latin / n,
    fnShare: fn / n,
    vowellessShare: vowelless / L,
    consRunShare: consRun / L,
    singleShare: single / L,
    loremShare: lorem / n,
    uniqueShare: uniq.size / n,
    meanLen: letters / n,
  };
}
// Thresholds set on a corpus of simulated writing (honest and gamed).
// `contiguous`: the words were written as one run of text (word-salad and repetition rules
// need sentences; scattered single-word edits are only checked for mash and lorem).
// `notes`: planning notes are terse (honest notes in the corpus go down to 10 % function
// words), so word salad there means almost none (< 5 %; generated salad has ~0).
export const NOTES_SALAD_FN_SHARE = 0.05;
export function classifyBlock(f, contiguous = true, notes = false) {
  if (f.n < 20) return null;
  if (f.loremShare >= 0.3) return 'lorem';
  if (f.latinShare >= 0.5 && (f.vowellessShare >= 0.15 || f.consRunShare >= 0.1 || f.singleShare >= 0.25 || f.meanLen < 2.8)) return 'gibberish';
  if (!contiguous) return null;
  if (f.latinShare >= 0.8 && f.fnShare < (notes ? NOTES_SALAD_FN_SHARE : 0.12)) return 'wordSalad';
  if (f.uniqueShare < 0.25) return 'repetitive';
  return null;
}

// ----------------------------------------------------------------------------- hours

function normalizeBreaks(breaks) {
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
function activeMs(t, joinedAt, breaks) {
  if (!(t > joinedAt)) return 0;
  let a = t - joinedAt;
  for (const b of breaks) {
    const s = Math.max(b.startAt, joinedAt);
    const e = Math.min(b.endAt, t);
    if (e > s) a -= e - s;
  }
  return a;
}
function realTimeForActive(a, joinedAt, breaks) {
  let t = joinedAt;
  let rem = a;
  for (const b of breaks) {
    if (b.endAt <= t) continue;
    if (b.startAt > t) {
      const seg = b.startAt - t;
      if (rem <= seg) return t + rem;
      rem -= seg;
    }
    t = b.endAt;
  }
  return t + rem;
}

// ----------------------------------------------------------------------------- scorer

// Ops received this long after their hour ended are late work (see the op format above): 5 s,
// or the settle time if shorter, so late work always starts before the hour can be judged.
export const LATE_GRACE_MS = 5_000;
export const lateAfterMs = (settings) => Math.min(LATE_GRACE_MS, Math.max(0, Number(settings?.settleSec ?? DEFAULT_SETTINGS.settleSec) * 1000));

// Marks on a credited word (see newHour's recs).
const TOK_BULK = 1; // macro-sized insert or a run growing faster than composition
const TOK_LATE = 2; // received after its hour had ended
const TOK_TEXT = 4; // in a block the text checks flagged (mash, lorem, salad, repetition)
const TOK_REUSED = 8; // a re-used word (earns reuseWeight)

const ELIG = 1; // the char counts if it settles (typed, or a confirmed paste)
const SETTLED = 2;
const OWNPASTE = 4; // pasted, and a repeat of the writer's own text (SPEC §12)
const UNCONF = 16; // from a long paste the writer didn't confirm (never a short paste or their own text): SPEC §13b
const FLAGBITS = 32;
const SPACE_RE = /\s/;
const LETTER_RE = /[\p{L}\p{N}]/u;
const EMPTY_IMAGE_RE = /!\[\]\([^)\s]*\)?/g;
// The /\s/ and /[\p{L}\p{N}]/ tests by char code, with the ASCII cases inline (they run per op).
const isSpaceAt = (text, i) => {
  const k = text.charCodeAt(i);
  return k < 128 ? k === 32 || (k >= 9 && k <= 13) : SPACE_RE.test(text[i]);
};
const isLetterCode = (k) => (k < 128 ? (k >= 48 && k <= 57) || (k >= 65 && k <= 90) || (k >= 97 && k <= 122) : LETTER_RE.test(String.fromCodePoint(k)));

function spliceIn(arr, pos, items) {
  if (items.length < 4096) {
    arr.splice(pos, 0, ...items);
    return arr;
  }
  const tail = arr.splice(pos);
  for (const x of items) arr.push(x);
  for (const x of tail) arr.push(x);
  return arr;
}

export const NC_KEYS = ['quick', 'repeat', 'reused', 'wordEdits', 'otherWriter', 'markup', 'unconfirmedPaste', 'shortPaste', 'overSpeed', 'overCutCap'];

// Markdown that isn't words (SPEC §14): link and image addresses ("](url"), bare URLs, footnote
// markers ("[^1]", and "[^1]:" before a note, SPEC §31), and numbered or task-list markers at the
// start of a line. Words there never count; link text and
// an image's description (its alt text, SPEC §14b) do. Spans are [from, to) offsets in the line,
// sorted and merged. Every pattern starts at a fixed marker and is linear in the line (a long
// line of "![" or "](" can't make the scan quadratic).
const LINK_DEST_RE = /\]\([^\s)]*/g;
const BARE_URL_RE = /(?:\b(?:https?|ftp):\/\/|\bwww\.|\bmailto:)[^\s<>"'()[\]]+/gi;
const LIST_MARK_RE = /^\s*(?:>\s*)*(?:\d{1,9}[.)]|[-*+]\s+\[[ xX]\])(?=\s|$)/;
// Footnotes (SPEC §31): references "[^1]" and a note's "[^1]:" label are markup; the note counts.
const FN_REF_RE = /\[\^[^\]\s^[]{1,40}\]/g;
const FN_DEF_RE = /^ {0,3}\[\^[^\]\s^[]{1,40}\]:/;
export function markupSpans(line) {
  const raw = [];
  for (const re of [LINK_DEST_RE, BARE_URL_RE, FN_REF_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line))) {
      raw.push([m.index, m.index + m[0].length]);
      if (!m[0].length) re.lastIndex++;
    }
  }
  const lm = LIST_MARK_RE.exec(line);
  if (lm) raw.push([0, lm[0].length]);
  const fd = FN_DEF_RE.exec(line);
  if (fd) raw.push([0, fd[0].length]);
  raw.sort((p, q) => p[0] - q[0]);
  const out = [];
  for (const s of raw) {
    const last = out[out.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else out.push(s);
  }
  return out;
}
// Was the last word character before `pos` written after time t? (A bounded look: a seam sits
// between notes, a gap and a label away from their words.)
function newerBefore(text, meta, segs, pos, t) {
  for (let i = pos - 1, k = 0; i >= 0 && k < 400; i--, k++) if (isWordCh(text[i])) return segs[Math.floor(meta[i] / FLAGBITS)].t > t;
  return false;
}
// Does [a, b) overlap one of `spans` (sorted, disjoint)? Binary search: the first span ending after a.
export function inSpans(spans, a, b) {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid][1] <= a) lo = mid + 1;
    else hi = mid;
  }
  return lo < spans.length && spans[lo][0] < b;
}

function newHour() {
  const nc = {};
  for (const k of NC_KEYS) nc[k] = 0;
  return {
    written: 0, pasted: 0, cutRaw: 0, cutSameClaw: 0, claw: 0, reusedCredit: 0, reusedLater: 0, nc,
    // One record per credited word: { c: credit, p: pasted, f: marks (TOK_*), d: credit deleted
    // soon after }, so flagged credit is a union (a word flagged twice still counts once).
    recs: [],
    creditedTokens: 0, typedTokens: 0, reusedTokens: 0, recycledTokens: 0, otherWords: 0,
    typedChars: 0, pauses: 0, discarded: 0,
    lateCredit: 0, lateCut: 0, lateFrom: Infinity, lateTo: -Infinity, lateRecv: 0,
    flags: [], flagKeys: new Set(),
  };
}

export function createSharedIndex() {
  const map = new Map(); // key -> { w: writer, t: ms, post, pane }
  return {
    map,
    add(key, w, t, post = null, pane = null) {
      const e = map.get(key);
      if (!e || t < e.t) map.set(key, { w, t, post, pane });
    },
    get(key) {
      return map.get(key);
    },
  };
}

export function createScorer(settings = {}, ctx = {}) {
  return new Scorer(settings, ctx);
}

const takeUnused = (list, from) => {
  if (!list) return null;
  while (list.length && (list[0].used || list[0].t < from)) list.shift();
  for (const e of list) if (!e.used && e.t >= from) return e;
  return null;
};

class Scorer {
  constructor(settings = {}, ctx = {}) {
    const S = { ...DEFAULT_SETTINGS };
    for (const k of Object.keys(settings || {})) if (settings[k] !== undefined && settings[k] !== null) S[k] = settings[k];
    this.S = S;
    this.ctx = ctx || {};
    this.writer = this.ctx.writer ?? 'me';
    this.shared = this.ctx.shared || null;
    this.breaks = normalizeBreaks(this.ctx.breaks);
    this.joinedAt = Number.isFinite(this.ctx.joinedAt) ? this.ctx.joinedAt : null;
    this.hourMs = Math.max(0.05, S.hourLengthMin) * 60_000; // same windows as lib/progress.js (no 1-minute floor)
    this.settleMs = S.settleSec * 1000;
    this.lateAfter = lateAfterMs(S);
    this.quantum = Math.max(1, S.settleQuantumSec * 1000);
    this.reuseMs = S.reuseWindowMin * 60_000;
    this.K = Math.max(2, Math.round(S.contextWords));
    this.panes = new Map();
    this.segs = [];
    this.nextSettle = 0;
    this.settledTo = -Infinity;
    this.lastT = -Infinity;
    this.lastTypedT = -Infinity;
    this.own = new Set(); // k-gram (ending at a credited word) of everything credited
    this.restore = new Map(); // k-gram key of cut text -> cut entry (text that comes back)
    this.recentDels = []; // [{ t, entries }] for the move detector
    this.tri = new Set(); // 3-gram keys of credited words (recycling flag only)
    this.pastedPairs = new Set(); // word pairs of everything ever pasted (SPEC §12)
    this.pastedWords = new Set();
    this.cutLog = []; // [{ t, norms }] text deleted recently, for "pasted own words" (SPEC §12)
    this.hours = [];
    this.speedWin = [];
    this.speedHead = 0;
    this.speedSum = 0;
    this.susWin = [];
    this.susHead = 0;
    this.susSum = 0;
    this.runBlocks = new Map(); // runId -> { toks: [], lastT, total }
    this.scattered = []; // words from short runs (single-word edits etc.)
    this.runCounter = 0;
    this.order = 0;
    this.deferredPanes = new Set();
    this.timeline = this.ctx.timeline ? new Map() : null;
  }

  _tl(t, v) {
    if (!this.timeline || !v) return;
    const m = Math.floor(t / 60_000);
    this.timeline.set(m, (this.timeline.get(m) || 0) + v);
  }
  wordValue(L, cjk) {
    const S = this.S;
    if (cjk) return S.cjkCharWords;
    if (S.unit === 'chars') return Math.min(L + 1, S.charsPerWord * S.maxTokenWords) / S.charsPerWord;
    return L === 1 ? S.oneLetterWord : 1;
  }

  // --- time & hours
  hourOf(t) {
    if (this.joinedAt === null) return 0;
    return Math.max(0, Math.floor(activeMs(t, this.joinedAt, this.breaks) / this.hourMs));
  }
  hourWindow(k) {
    const j = this.joinedAt ?? 0;
    return { startAt: realTimeForActive(k * this.hourMs, j, this.breaks), endAt: realTimeForActive((k + 1) * this.hourMs, j, this.breaks) };
  }
  H(k) {
    while (this.hours.length <= k) this.hours.push(newHour());
    return this.hours[k];
  }
  targetOf(k) {
    const c = this.ctx;
    if (c.targets && Number.isFinite(c.targets[k])) return c.targets[k];
    return Number.isFinite(c.target) ? c.target : this.S.targetPerHour;
  }
  cutCapOf(k) {
    return Number.isFinite(this.S.cutCapPerHour) ? this.S.cutCapPerHour : this.targetOf(k) / 2;
  }
  flag(k, type, detail = {}) {
    const h = this.H(k);
    if (h.flagKeys.has(type)) {
      const f = h.flags.find((x) => x.type === type);
      if (f && detail.words) f.words = (f.words || 0) + detail.words;
      if (f) f.count = (f.count || 1) + 1;
      return;
    }
    h.flagKeys.add(type);
    h.flags.push({ hour: k, type, ...detail });
  }

  pane(post, pane) {
    const key = `${post}\u0000${pane}`;
    let P = this.panes.get(key);
    if (!P) {
      P = { key, post, pane, text: '', meta: [], cr: [], tk: [], delBag: new Map(), typBag: new Map(), region: null, runId: null, runEnd: -1, runStart: 0, runT: -Infinity, burst: null, lo: 0, unconfChars: 0, unconfWords: 0, unconfDirty: false, moving: null, seams: null };
      this.panes.set(key, P);
    }
    return P;
  }

  // --- ops
  apply(op) {
    let t = Number(op.t);
    if (!Number.isFinite(t)) throw new Error('op.t must be a number (ms)');
    if (t < this.lastT) t = this.lastT;
    if (this.joinedAt === null) this.joinedAt = t;
    this.advance(t);
    this.lastT = t;
    const P = this.pane(op.post ?? 'post', op.pane ?? 'body');
    let pos = op.pos | 0;
    let del = op.del | 0;
    let ins = op.ins || '';
    if (pos < 0 || del < 0 || pos + del > P.text.length) throw new Error(`op out of range: pos ${pos} del ${del} len ${P.text.length}`);
    // Moved text (source 'move', see the op format above): only the pane's very next op can
    // complete a move.
    const moving = P.moving;
    P.moving = null;
    if (op.source === 'move') {
      if (ins && !del) return void this._moveIn(P, pos, ins, t);
      if (del && !ins && moving && this._moveOut(P, moving, pos, del)) return;
    }
    const src = op.source && op.source !== 'move' ? op.source : 'type';
    const isPaste = src === 'paste';
    // Typed replacements become the minimal change: autocorrect "teh"->"the" and IME or
    // dictation rewrites of the whole composing region touch only what changed.
    if (!isPaste && del > 0 && ins) {
      const old = P.text.slice(pos, pos + del);
      let a = 0;
      while (a < del && a < ins.length && old[a] === ins[a]) a++;
      let b = 0;
      while (b < del - a && b < ins.length - a && old[del - 1 - b] === ins[ins.length - 1 - b]) b++;
      pos += a;
      del -= a + b;
      ins = ins.slice(a, ins.length - b);
    }
    if (P.seams) this._mapSeams(P, pos, del, ins.length);
    if (!isPaste && src !== 'dictation' && (ins || del)) {
      const k = this.hourOf(t);
      if (t - this.lastTypedT >= this.S.steadyPauseSec * 1000) this.H(k).pauses++;
      this.lastTypedT = t;
    }
    // Received after the hour it belongs to had ended: late work (offline queue or forged time).
    let late = 0;
    if (Number.isFinite(op.r) && op.r > t + this.lateAfter && op.r > this.hourWindow(this.hourOf(t)).endAt + this.lateAfter) late = op.r;
    // Unconfirmed pasted words on the page (SPEC §13b) are recounted when next asked, and only in
    // a pane that holds unconfirmed pasted characters (reading the text here, at every op, would
    // copy it each time: appends leave it in pieces).
    if (P.unconfChars > 0 || (isPaste && ins)) {
      for (let i = pos; i < pos + del; i++) if (P.meta[i] & UNCONF) P.unconfChars--;
      P.unconfDirty = true;
    }
    if (del > 0) this._delete(P, pos, del, t, late);
    if (ins) this._insert(P, pos, ins, t, src, op, late);
  }

  // Words on a pane's page now that came from pastes the writer didn't confirm (SPEC §13b).
  unconfirmedWords(post, pane) {
    const P = this.panes.get(`${post}\u0000${pane}`);
    if (!P || P.unconfChars <= 0) return 0;
    if (P.unconfDirty) {
      P.unconfWords = this._unconfWords(P, 0, P.text.length);
      P.unconfDirty = false;
    }
    return P.unconfWords;
  }
  // Raw words in text[a, b) (as the words-on-the-page count sees them) whose letters and digits
  // all came from unconfirmed pastes: a letter typed into one makes it the writer's own (§13b).
  // Only the words around unconfirmed characters are read.
  _unconfWords(P, a, b) {
    const text = P.text;
    const meta = P.meta;
    let n = 0;
    let i = a;
    while (i < b) {
      if (!(meta[i] & UNCONF) || isSpaceAt(text, i)) {
        i++;
        continue;
      }
      let s = i;
      while (s > a && !isSpaceAt(text, s - 1)) s--;
      let letters = 0;
      let mine = false;
      i = s;
      while (i < b && !isSpaceAt(text, i)) {
        const c = text.codePointAt(i);
        const w = c > 0xffff ? 2 : 1;
        if (!mine && isLetterCode(c)) {
          letters++;
          if (!(meta[i] & UNCONF) || (w === 2 && !(meta[i + 1] & UNCONF))) mine = true;
        }
        i += w;
      }
      if (!letters || mine) continue;
      const word = text.slice(s, i);
      if (!word.includes('![](') || LETTER_RE.test(word.replace(EMPTY_IMAGE_RE, ''))) n++; // an empty image's address isn't a word
    }
    return n;
  }

  _insert(P, pos, ins, t, src, op, late = 0) {
    const S = this.S;
    const isPaste = src === 'paste';
    const words = countWords(ins);
    const segId = this.segs.length;
    const k = this.hourOf(t);
    const seg = { t, src, P, k, bulk: false, paste: isPaste, short: false, region: null, runId: 0, late };
    // Contiguous runs of text (typing that continues where it left off; each paste is one).
    if (!isPaste && P.runId !== null && pos === P.runEnd && t - P.runT <= 60_000) seg.runId = P.runId;
    else {
      seg.runId = ++this.runCounter;
      P.runStart = pos;
    }
    P.runId = isPaste ? null : seg.runId;
    P.runEnd = pos + ins.length;
    P.runT = t;
    // Before the writer's first hour (synced hours) or a system insert: nothing here counts.
    const noCredit = !!op.noCredit || (Number.isFinite(this.ctx.creditFrom) && t < this.ctx.creditFrom);
    const elig = new Array(ins.length).fill(isPaste || noCredit ? 0 : ELIG);
    // Words of a long paste the writer didn't confirm as written today (SPEC §13b), whatever the
    // credit rules say (before a writer's first hour nothing counts either way).
    let unconf = null;
    if (isPaste && words > S.pasteAskOverWords) {
      unconf = new Uint8Array(ins.length).fill(1);
      const c = op.confirm;
      if (c === 'all' || c === true) unconf.fill(0);
      else if (Array.isArray(c)) {
        for (const r of c) {
          const a = Math.max(0, r[0] | 0);
          const b = Math.min(ins.length, r[1] | 0);
          for (let i = a; i < b; i++) unconf[i] = 0;
        }
      }
    }
    if (isPaste) {
      P.region = null;
      if (noCredit) {
        // counts nothing, whatever its length
      } else if (words <= S.pasteAskOverWords) {
        seg.short = true;
        if (S.shortPastesCount) elig.fill(ELIG); // short pastes count like typing (SPEC §12)
      } else {
        const c = op.confirm;
        if (c === 'all' || c === true) elig.fill(ELIG);
        else if (Array.isArray(c)) {
          for (const r of c) {
            const a = Math.max(0, r[0] | 0);
            const b = Math.min(ins.length, r[1] | 0);
            for (let i = a; i < b; i++) elig[i] = ELIG;
          }
        }
      }
      // Pasted words that repeat the writer's own text never count (SPEC §12).
      const toks = tokensIn(ins, 0, ins.length);
      const own = this._ownPasteMask(toks.map((x) => x[2]), t);
      for (let q = 0; q < toks.length; q++) {
        if (!own[q]) continue;
        for (let i = toks[q][0]; i < toks[q][1]; i++) {
          elig[i] = OWNPASTE;
          if (unconf) unconf[i] = 0; // a repeat of their own text, not unconfirmed writing
        }
      }
      this._rememberPaste(toks.map((x) => x[2]));
      this._detectMove(ins, t);
    } else {
      if (P.region && t - P.region.t <= this.reuseMs && pos === P.region.end) {
        seg.region = P.region;
        P.region.end += ins.length;
      } else P.region = null;
      if (src !== 'dictation') this.H(k).typedChars += ins.length;
      if (words >= (src === 'dictation' ? S.bulkDictationWords : S.bulkInsertWords)) {
        seg.bulk = true;
        this.flag(k, 'bulkInsert', { words, source: src });
      }
      this.segs.push(seg);
      this._burst(P, segId, t, src);
    }
    if (isPaste) this.segs.push(seg);
    if (pos < P.lo) P.lo = pos;
    P.text = pos === P.text.length ? P.text + ins : P.text.slice(0, pos) + ins + P.text.slice(pos);
    if (unconf) for (let i = 0; i < unconf.length; i++) if (unconf[i]) P.unconfChars++;
    spliceIn(P.meta, pos, elig.map((e, i) => segId * FLAGBITS + e + (unconf && unconf[i] ? UNCONF : 0)));
    spliceIn(P.cr, pos, new Array(ins.length).fill(0));
    spliceIn(P.tk, pos, new Array(ins.length).fill(null));
  }

  // Moved text, first half: the text where it goes. Until the original is deleted by the next op,
  // it's inert (settled, never eligible): no credit, no typing statistics, no run or burst.
  _moveIn(P, pos, ins, t) {
    const segId = this.segs.length;
    this.segs.push({ t, src: 'move', P, k: this.hourOf(t), bulk: false, paste: false, short: false, region: null, runId: 0, late: 0 });
    if (P.seams) this._mapSeams(P, pos, 0, ins.length);
    P.text = pos === P.text.length ? P.text + ins : P.text.slice(0, pos) + ins + P.text.slice(pos);
    spliceIn(P.meta, pos, new Array(ins.length).fill(segId * FLAGBITS + SETTLED));
    spliceIn(P.cr, pos, new Array(ins.length).fill(0));
    spliceIn(P.tk, pos, new Array(ins.length).fill(null));
    if (pos < P.lo) P.lo = pos;
    P.runId = null;
    P.region = null;
    if (P.unconfChars > 0) P.unconfDirty = true;
    P.moving = { pos, text: ins };
  }

  // Moved text, second half: the original, the same text, elsewhere. Its characters' records
  // (credit, settled or not, flags, unconfirmed paste) go to the copy and the original leaves
  // without the bookkeeping of a deletion: no cut credit, nothing discarded, no re-use bags.
  // Words still settling are then judged where they stand, except that a word written before the
  // move takes no context from across its seams (the copy's two ends, the gap it left) from text
  // written after it: a note written earlier, now just after one still settling, must not make
  // that one's last words look like repeats (the earlier note settles first, and its 6-word
  // windows would reach into them). False if this isn't the original (an ordinary deletion then).
  _moveOut(P, mv, pos, del) {
    const at = mv.pos;
    const n = mv.text.length;
    if (del !== n || (pos < at + n && pos + del > at) || P.text.slice(pos, pos + del) !== mv.text) return false;
    for (let i = 0; i < n; i++) {
      P.meta[at + i] = P.meta[pos + i];
      P.cr[at + i] = P.cr[pos + i];
      P.tk[at + i] = P.tk[pos + i];
    }
    P.text = P.text.slice(0, pos) + P.text.slice(pos + del);
    P.meta.splice(pos, del);
    P.cr.splice(pos, del);
    P.tk.splice(pos, del);
    const to = pos < at ? at - del : at;
    // Everything before P.lo has settled: the copy may hold text still settling.
    P.lo = Math.min(P.lo, pos, to);
    if (P.seams) this._mapSeams(P, pos, del, 0);
    const t = this.lastT;
    (P.seams || (P.seams = [])).push({ pos: to, t }, { pos: to + n, t }, { pos, t });
    return true;
  }
  _mapSeams(P, pos, del, n) {
    for (const sm of P.seams) {
      if (sm.pos > pos + del) sm.pos += n - del;
      else if (sm.pos > pos) sm.pos = pos;
    }
  }

  // Run-level macro check: the run at this place (typing that continues where it left off,
  // backspaces included) grew by burst*Words within burstWindowSec, the window's first op
  // excluded (its words may have been composed before it). Every segment in that window is
  // marked bulk, so its credit is flagged (review if the hour needs it), never removed.
  _burst(P, segId, t, src) {
    const S = this.S;
    let B = P.burst;
    // items[head..]: the window; items[..marked) are already marked bulk (each segment once,
    // so a long run of ops with one timestamp stays linear).
    if (!B || B.runId !== P.runId) B = P.burst = { runId: P.runId, items: [], head: 0, marked: 0, flaggedTo: -Infinity };
    const cum = P.runEnd - P.runStart;
    B.items.push({ t, cum, segId });
    const W = S.burstWindowSec * 1000;
    while (B.head < B.items.length - 1 && B.items[B.head].t < t - W) B.head++;
    if (B.head > 1024 && B.head * 2 > B.items.length) {
      B.items = B.items.slice(B.head);
      B.marked = Math.max(0, B.marked - B.head);
      B.head = 0;
    }
    const first = B.items[B.head];
    const words = (cum - first.cum) / 6;
    if (words < (src === 'dictation' ? S.burstDictationWords : S.burstTypingWords)) return;
    for (let i = Math.max(B.head, B.marked); i < B.items.length; i++) this.segs[B.items[i].segId].bulk = true;
    B.marked = B.items.length;
    // One flag per burst (not per keystroke): again only once the window has moved past it.
    if (first.t > B.flaggedTo) this.flag(this.hourOf(t), 'bulkInsert', { words: Math.round(words), source: src, run: true });
    B.flaggedTo = t;
  }

  // Which tokens of a paste repeat the writer's own text: in any post or notes now, cut
  // in the last ownCutWindowMin minutes, or pasted before. A token matches when it sits in
  // a run of 2+ pasted words found together in that text (except a bare pair of function
  // words like "of the", which is in everyone's text); a one-word paste matches by itself.
  _ownPasteMask(norms, t, prune = true) {
    const n = norms.length;
    const out = new Array(n).fill(false);
    if (!n) return out;
    const pairs = new Set(this.pastedPairs);
    const singles = n === 1 ? new Set(this.pastedWords) : null;
    const addSeq = (seq) => {
      for (let i = 0; i + 1 < seq.length; i++) pairs.add(`${seq[i]} ${seq[i + 1]}`);
      if (singles) for (const x of seq) singles.add(x);
    };
    for (const P of this.panes.values()) addSeq(tokensIn(P.text, 0, P.text.length).map((x) => x[2]));
    const from = t - this.S.ownCutWindowMin * 60_000;
    if (prune) this.cutLog = this.cutLog.filter((c) => c.t >= from);
    for (const c of this.cutLog) if (c.t >= from) addSeq(c.norms);
    if (n === 1) {
      out[0] = !!norms[0] && singles.has(norms[0]);
      return out;
    }
    // Runs of consecutive matching pairs. A two-word run of function words ("of the") is
    // in everyone's text, so it doesn't count as a match on its own.
    for (let i = 0; i + 1 < n; ) {
      if (!norms[i] || !norms[i + 1] || !pairs.has(`${norms[i]} ${norms[i + 1]}`)) {
        i++;
        continue;
      }
      let j = i;
      let content = false;
      while (j + 1 < n && norms[j] && norms[j + 1] && pairs.has(`${norms[j]} ${norms[j + 1]}`)) {
        if (!(COMMON.has(norms[j]) && COMMON.has(norms[j + 1]))) content = true;
        j++;
      }
      if (content || j - i + 1 >= 3) for (let q = i; q <= j; q++) out[q] = true;
      i = j;
    }
    return out;
  }
  _rememberPaste(norms) {
    for (let i = 0; i + 1 < norms.length; i++) this.pastedPairs.add(`${norms[i]} ${norms[i + 1]}`);
    for (const x of norms) if (x) this.pastedWords.add(x);
  }

  // A paste that brings back text cut in the last few minutes is a move: the cut goes.
  _detectMove(ins, t) {
    const toks = tokensIn(ins, 0, ins.length).map((x) => x[2]);
    if (!toks.length) return;
    const from = t - this.reuseMs;
    this.recentDels = this.recentDels.filter((d) => d.t >= from);
    for (let i = this.recentDels.length - 1; i >= 0; i--) {
      const D = this.recentDels[i];
      if (!D.entries.some((e) => !e.used && e.cut > 0)) continue;
      const bag = new Map();
      for (const x of toks) bag.set(x, (bag.get(x) || 0) + 1);
      const hit = [];
      for (const e of D.entries) {
        const n = bag.get(e.norm) || 0;
        if (n > 0) {
          bag.set(e.norm, n - 1);
          hit.push(e);
        }
      }
      if (hit.length >= Math.max(1, 0.6 * Math.min(D.entries.length, toks.length))) {
        for (const e of hit) {
          if (e.used) continue;
          e.used = true;
          this._claw(e, t);
        }
      }
    }
  }

  _delete(P, pos, del, t, late = 0) {
    const S = this.S;
    const end = pos + del;
    const text = P.text;
    const kNow = this.hourOf(t);
    const H = this.H(kNow);
    // Unsettled text never counted, so deleting it is free (typos, autocorrect, IME, toggling).
    // Credited text deleted soon after it was written is tallied for the "mostly deleted" flag.
    const discardBefore = t - S.discardWindowMin * 60_000;
    for (let i = pos; i < end; i++) {
      const m = P.meta[i];
      if (!(m & SETTLED) && m & ELIG && isWordCh(text[i])) H.nc.quick += 1 / 5.5;
      if (P.cr[i] > 0) {
        const seg = this.segs[Math.floor(m / FLAGBITS)];
        if (seg.t >= discardBefore) {
          this.H(seg.k).discarded += P.cr[i];
          if (P.tk[i]) P.tk[i].d += P.cr[i];
        }
      }
    }
    if (P.runId !== null && end === P.runEnd && t - P.runT <= 60_000) {
      P.runEnd = pos;
      P.runT = t;
      if (pos < P.runStart) P.runStart = pos;
    } else P.runId = null;
    // Replacement region: typing that follows this deletion at the same place.
    if (P.region && pos >= P.region.pos && end === P.region.end && t - P.region.t <= this.reuseMs) P.region.end = pos;
    else P.region = { pos, end: pos, t, bag: new Map() };
    const R = P.region;
    // Credited tokens touched by the deletion.
    let s0 = pos;
    while (s0 > 0 && isWordCh(text[s0 - 1])) s0--;
    let e0 = end;
    while (e0 < text.length && isWordCh(text[e0])) e0++;
    const left = prevTokens(text, s0, this.K - 1);
    const toks = tokensIn(text, s0, e0);
    const W = left.concat(toks.map((x) => x[2]));
    const matureBefore = t - S.cutMatureMin * 60_000;
    const info = [];
    const selfSegs = new Set();
    for (let q = 0; q < toks.length; q++) {
      const [s, e, norm] = toks[q];
      const a = Math.max(s, pos);
      const b = Math.min(e, end);
      if (a >= b) continue;
      let credit = 0;
      let mature = 0;
      let maxSeg = -1;
      let settled = 0;
      for (let i = a; i < b; i++) {
        if (P.meta[i] & SETTLED) settled++;
        const c = P.cr[i];
        if (c > 0) {
          credit += c;
          const sid = Math.floor(P.meta[i] / FLAGBITS);
          if (this.segs[sid].t <= matureBefore) mature += c;
          if (sid > maxSeg) maxSeg = sid;
        }
      }
      // Words that never settled were never counted: deleting and retyping them is free.
      // Settled words go into the re-use bags even if they earned nothing themselves
      // (otherwise shuffling the same sentence twice would look like new writing).
      if (!settled) continue;
      info.push({ q, norm, credit, mature, maxSeg, whole: a === s && b === e });
      if (credit > 0) selfSegs.add(maxSeg);
    }
    // Recently typed words that are themselves being deleted are not "re-used".
    for (const x of info) {
      const list = P.typBag.get(x.norm);
      if (list) for (const e of list) if (selfSegs.has(e.seg)) e.used = true;
    }
    const entries = [];
    let cutTotal = 0;
    for (const x of info) {
      let cut = S.cutWeight * x.mature;
      const content = x.whole && x.norm.length >= 2 && !COMMON.has(x.norm);
      if (content && x.credit > 0) {
        // Deleting a word you re-typed elsewhere minutes ago = shuffling: no cut credit, and
        // the re-typed copy drops to the reuse weight.
        const ent = takeUnused(P.typBag.get(x.norm), t - this.reuseMs);
        if (ent) {
          ent.used = true;
          const back = (1 - S.reuseWeight) * ent.credit;
          H.claw += back;
          this._tl(t, -back);
          H.nc.reused += back;
          const ht = this.H(ent.k);
          ht.reusedTokens++;
          ht.reusedLater += ent.credit * S.reuseWeight;
          cut = 0;
        }
      }
      if (!x.whole) continue; // part of a word: a letter edit, no cut credit (like letter edits)
      const entry = { norm: x.norm, t, cut, k: kNow, used: false };
      entries.push(entry);
      if (!R.bag.has(x.norm)) R.bag.set(x.norm, []);
      R.bag.get(x.norm).push(entry);
      if (content) {
        if (!P.delBag.has(x.norm)) P.delBag.set(x.norm, []);
        P.delBag.get(x.norm).push(entry);
      }
      if (cut > 0) {
        const idx = left.length + x.q;
        this.restore.set(windowKey(P, W, Math.max(0, idx - this.K + 1), idx + 1, this.K), entry);
      }
      cutTotal += cut;
    }
    if (entries.length) this.recentDels.push({ t, entries });
    const cutNorms = tokensIn(text, pos, end).map((x) => x[2]).filter(Boolean);
    if (cutNorms.length) this.cutLog.push({ t, norms: cutNorms });
    H.cutRaw += cutTotal;
    if (late && cutTotal > 0) {
      H.lateCut += cutTotal;
      this._lateWindow(H, t, late);
    }
    this._tl(t, cutTotal);
    P.text = text.slice(0, pos) + text.slice(end);
    P.meta.splice(pos, del);
    P.cr.splice(pos, del);
    P.tk.splice(pos, del);
    if (P.lo > pos) P.lo = Math.max(pos, P.lo - del);
  }

  _claw(entry, tNow) {
    if (!(entry.cut > 0)) return;
    const amount = entry.cut;
    entry.cut = 0;
    const kNow = this.hourOf(tNow);
    this._tl(tNow, -amount);
    if (entry.k === kNow) this.H(kNow).cutSameClaw += amount;
    else {
      const hc = this.H(entry.k);
      const net = hc.cutRaw - hc.cutSameClaw;
      const cap = this.cutCapOf(entry.k);
      const f = net > cap && net > 0 ? cap / net : 1;
      this.H(kNow).claw += amount * f;
    }
  }

  _lateWindow(H, t, received) {
    if (t < H.lateFrom) H.lateFrom = t;
    if (t > H.lateTo) H.lateTo = t;
    if (received > H.lateRecv) H.lateRecv = received;
  }

  // --- settling
  advance(now) {
    const Q = Math.floor(now / this.quantum) * this.quantum;
    if (Q <= this.settledTo) return;
    const recs = this._collect(Q);
    this.settledTo = Q;
    if (recs.length) this._process(recs);
  }

  _collect(Q) {
    const segs = this.segs;
    let b = this.nextSettle;
    while (b < segs.length && segs[b].t + this.settleMs <= Q) b++;
    const panes = new Set(this.deferredPanes);
    for (let s = this.nextSettle; s < b; s++) panes.add(segs[s].P);
    this.nextSettle = b;
    if (!panes.size) return [];
    this.deferredPanes.clear();
    const recs = [];
    for (const P of panes) if (this._collectPane(P, Q, recs)) this.deferredPanes.add(P);
    return recs;
  }

  // A token settles as a whole once every unsettled character in it is due; a word still
  // being edited waits. Returns true if something in the pane is still waiting.
  _collectPane(P, Q, recs) {
    const K = this.K;
    const text = P.text;
    const meta = P.meta;
    const segs = this.segs;
    const limitT = Q - this.settleMs;
    const n = meta.length;
    let deferred = false;
    let firstWaiting = n;
    let oldest = Infinity; // when the earliest text still settling here was written (for the seams)
    // Everything before P.lo is settled; back up to a token boundary so tokens are whole.
    let i = Math.min(P.lo, n);
    while (i > 0 && isWordCh(text[i - 1])) i--;
    let lineStart = text.lastIndexOf('\n', i - 1) + 1; // kept current while scanning forward
    let lineScan = i;
    // Links, images, URLs and list markers on the line of [s0, e0).
    let spanLine = -1;
    let spans = null;
    const markupHere = (s0, e0) => {
      for (; lineScan < s0; lineScan++) if (text[lineScan] === '\n') lineStart = lineScan + 1;
      if (spanLine !== lineStart) {
        spanLine = lineStart;
        let le = text.indexOf('\n', lineStart);
        if (le < 0) le = text.length;
        spans = markupSpans(text.slice(lineStart, le));
      }
      return inSpans(spans, s0 - lineStart, e0 - lineStart);
    };
    while (i < n) {
      const m = meta[i];
      if (m & SETTLED) {
        i++;
        continue;
      }
      if (segs[Math.floor(m / FLAGBITS)].t > limitT) {
        deferred = true;
        if (i < firstWaiting) firstWaiting = i;
        if (P.seams && segs[Math.floor(m / FLAGBITS)].t < oldest) oldest = segs[Math.floor(m / FLAGBITS)].t;
        i++;
        continue;
      }
      if (!isWordCh(text[i])) {
        meta[i] = m | SETTLED;
        i++;
        continue;
      }
      const [s, e] = tokenAt(text, i);
      let defer = false;
      for (let j = s; j < e; j++) {
        const mj = meta[j];
        if (!(mj & SETTLED) && segs[Math.floor(mj / FLAGBITS)].t > limitT) {
          defer = true;
          break;
        }
      }
      if (defer) {
        deferred = true;
        if (s < firstWaiting) firstWaiting = s;
        if (P.seams) for (let j = s; j < e; j++) if (!(meta[j] & SETTLED)) oldest = Math.min(oldest, segs[Math.floor(meta[j] / FLAGBITS)].t);
        i = e;
        continue;
      }
      const norm = normalizeToken(text.slice(s, e));
      const key = foldKey(norm);
      let L = 0;
      let oldLetters = 0;
      let dueElig = 0;
      let duePaste = 0;
      let ownPaste = 0;
      let shortPaste = false;
      let tMax = -Infinity;
      let src = 'type';
      let bulk = false;
      let segMax = -1;
      let region = null;
      let runId = 0;
      let late = 0;
      const idx = [];
      for (let j = s; j < e; j++) {
        const mj = meta[j];
        const wasSettled = (mj & SETTLED) !== 0;
        if (!wasSettled) meta[j] = mj | SETTLED;
        if (isApos(text[j])) continue;
        L++;
        if (wasSettled) {
          oldLetters++;
          continue;
        }
        const sid = Math.floor(mj / FLAGBITS);
        const seg = segs[sid];
        if (mj & ELIG) {
          dueElig++;
          idx.push(j);
          if (seg.late > late) late = seg.late;
          if (seg.t > tMax) {
            tMax = seg.t;
            src = seg.src;
          }
          if (seg.bulk) bulk = true;
          if (sid > segMax) {
            segMax = sid;
            region = seg.region;
            runId = seg.runId;
          }
        } else if (seg.paste) {
          duePaste++;
          if (mj & OWNPASTE) ownPaste++;
          if (seg.short) shortPaste = true;
          if (seg.t > tMax) tMax = seg.t;
        }
      }
      i = e;
      if (!norm || (!dueElig && !duePaste) || !L) continue;
      // A word written before a move takes no context from across one of its seams (see _moveOut)
      // that was written after it.
      let lim = 400;
      if (P.seams) {
        for (const sm of P.seams) if (tMax <= sm.t && sm.pos <= s && s - sm.pos < lim && newerBefore(text, meta, segs, sm.pos, tMax)) lim = s - sm.pos;
      }
      const left = prevTokens(text, s, K - 1, lim);
      const right = nextTokens(text, e, K - 1);
      const Wn = left.concat([key], right);
      const at = left.length;
      const keys = [];
      for (let j = Math.max(0, at - K + 1); j <= at; j++) if (j + K <= Wn.length) keys.push(gramKey(Wn, j, j + K));
      recs.push({
        P, norm, key, L, base: this.wordValue(L, isCJK(text[s])), oldLetters, dueElig, duePaste, ownPaste, shortPaste, idx, tMax, src, bulk, segMax, region, runId, late,
        k: this.hourOf(tMax), markup: markupHere(s, e), keys,
        endKey: windowKey(P, Wn, Math.max(0, at - K + 1), at + 1, K),
        endFull: at + 1 >= K,
        triKey: windowKey(P, Wn, Math.max(0, at - 2), at + 1, 3),
        content: key.length >= 2 && !COMMON.has(key),
        order: this.order++,
      });
    }
    P.lo = firstWaiting;
    // A seam is done with once nothing written before it is still settling.
    if (P.seams) {
      P.seams = P.seams.filter((sm) => sm.t >= oldest);
      if (!P.seams.length) P.seams = null;
    }
    return deferred;
  }

  _process(recs) {
    recs.sort((x, y) => x.tMax - y.tMax || x.order - y.order);
    for (const r of recs) this._processOne(r);
    this._finishRuns(this.settledTo - this.settleMs - 60_000);
  }

  _processOne(r) {
    const S = this.S;
    const P = r.P;
    const H = this.H(r.k);
    // Link and image addresses, bare URLs and list markers aren't words (SPEC §14).
    if (r.markup) return void (H.nc.markup += (r.base * (r.dueElig + r.duePaste)) / r.L);
    const potential = (r.base * r.dueElig) / r.L;
    let repeat = this.own.has(r.endKey);
    for (const key of r.keys) if (!repeat && this.own.has(key)) repeat = true;
    let foreign = null;
    if (!repeat && this.shared) {
      for (const key of [...r.keys, r.endKey]) {
        const e = this.shared.get(key);
        if (e && e.w !== this.writer && e.t < r.tMax) {
          foreign = e.w;
          break;
        }
      }
    }
    // Text that was cut and has come back (moved, restored, undone): its cut credit goes.
    if (repeat) for (const key of [r.endKey, ...r.keys]) {
      const ent = this.restore.get(key);
      if (ent && !ent.used) {
        ent.used = true;
        this._claw(ent, r.tMax);
      }
    }
    // Re-typing words deleted minutes ago: in place (any word) or anywhere in the pane
    // (content words). The deletion's cut credit goes and the word earns reuseWeight.
    let reused = false;
    const from = r.tMax - this.reuseMs;
    let ent = r.region ? takeUnused(r.region.bag.get(r.key), from) : null;
    if (!ent && r.content) ent = takeUnused(P.delBag.get(r.key), from);
    if (ent) {
      ent.used = true;
      this._claw(ent, r.tMax);
      reused = true;
    }
    if (!r.dueElig) {
      const v = (r.base * r.duePaste) / r.L;
      if (r.ownPaste) H.nc.repeat += v; // pasted repeat of the writer's own text
      else if (r.shortPaste) H.nc.shortPaste += v;
      else H.nc.unconfirmedPaste += v;
      return;
    }
    if (repeat) return void (H.nc.repeat += potential);
    if (foreign !== null) {
      H.nc.otherWriter += potential;
      H.otherWords++;
      if (H.otherWords >= S.otherWriterFlagWords) this.flag(r.k, 'otherWriter', { words: 1 });
      return;
    }
    // Changing letters inside a word that already counted (typo fixes, "cat" -> "cats",
    // letter swaps) earns nothing: the word was credited when it was written.
    if (r.oldLetters > 0) return void (H.nc.wordEdits += potential);
    let credit = potential;
    if (reused) {
      credit *= S.reuseWeight;
      H.nc.reused += potential - credit;
    }
    if (r.src !== 'paste') {
      const cap = r.src === 'dictation' ? S.dictationCapWpm : S.speedCapWpm;
      while (this.speedHead < this.speedWin.length && this.speedWin[this.speedHead].t <= r.tMax - 60_000) this.speedSum -= this.speedWin[this.speedHead++].a;
      const allowed = Math.max(0, cap - this.speedSum);
      if (credit > allowed + 1e-9) {
        H.nc.overSpeed += credit - allowed;
        this.flag(r.k, 'speedCap', { words: credit - allowed });
        credit = allowed;
      }
      if (credit > 0) {
        this.speedWin.push({ t: r.tMax, a: credit });
        this.speedSum += credit;
      }
      if (this.speedHead > 4096) {
        this.speedWin.splice(0, this.speedHead);
        this.speedHead = 0;
      }
      if (this.susHead > 4096) {
        this.susWin.splice(0, this.susHead);
        this.susHead = 0;
      }
      const winMs = S.sustainedWindowMin * 60_000;
      while (this.susHead < this.susWin.length && this.susWin[this.susHead].t <= r.tMax - winMs) this.susSum -= this.susWin[this.susHead++].a;
      this.susWin.push({ t: r.tMax, a: credit });
      this.susSum += credit;
      if (this.susSum > S.sustainedWpm * S.sustainedWindowMin) this.flag(r.k, 'sustainedSpeed', { wpm: Math.round(this.susSum / S.sustainedWindowMin) });
      H.typedTokens++;
      if (reused) H.reusedTokens++;
    }
    if (credit <= 0) return;
    const rec = { c: credit, p: r.src === 'paste', f: (r.bulk ? TOK_BULK : 0) | (r.late ? TOK_LATE : 0) | (reused ? TOK_REUSED : 0), d: 0 };
    H.recs.push(rec);
    for (const i of r.idx) {
      P.cr[i] += credit / r.idx.length;
      P.tk[i] = rec;
    }
    if (r.src === 'paste') H.pasted += credit;
    else H.written += credit;
    this._tl(r.tMax, credit);
    if (r.late) {
      H.lateCredit += credit;
      this._lateWindow(H, r.tMax, r.late);
    }
    if (reused) H.reusedCredit += credit;
    H.creditedTokens++;
    if (!reused && r.content && r.src !== 'paste') {
      if (!P.typBag.has(r.key)) P.typBag.set(r.key, []);
      P.typBag.get(r.key).push({ t: r.tMax, credit, k: r.k, seg: r.segMax, used: false });
    }
    this.own.add(r.endKey);
    // Only text others may read goes in the cross-writer index (ctx.shareable): a private note or
    // a separate post could otherwise be probed by writing a guess and watching one's own
    // "other writers' text" count.
    if (r.endFull && this.shared && (!this.ctx.shareable || this.ctx.shareable(P.post, P.pane))) this.shared.add(r.endKey, this.writer, r.tMax, P.post, P.pane);
    if (this.tri.has(r.triKey)) H.recycledTokens++;
    else this.tri.add(r.triKey);
    let rb = this.runBlocks.get(r.runId);
    // Planning notes get the same checks, with a word-salad threshold for terse notes.
    if (!rb) this.runBlocks.set(r.runId, (rb = { toks: [], lastT: r.tMax, total: 0, notes: P.pane === 'notes' }));
    rb.toks.push({ norm: r.norm, credit, k: r.k, rec });
    rb.total++;
    rb.lastT = Math.max(rb.lastT, r.tMax);
    if (rb.toks.length >= S.flagBlockWords) this._flushBlock(rb.toks.splice(0), true, rb.notes);
  }

  // Runs with no new words since `before`: leftovers of long runs are checked as text;
  // words from short runs (scattered edits) are pooled and checked for mash/lorem only.
  _finishRuns(before) {
    for (const [id, rb] of this.runBlocks) {
      if (rb.lastT > before) continue;
      this.runBlocks.delete(id);
      if (rb.toks.length >= 20 || (rb.total >= 20 && rb.toks.length >= 10)) this._flushBlock(rb.toks, true, rb.notes);
      else {
        for (const x of rb.toks) this.scattered.push(x);
        if (this.scattered.length >= this.S.flagBlockWords) this._flushBlock(this.scattered.splice(0), false);
      }
    }
  }

  _flushBlock(blk, contiguous, notes = false) {
    if (!blk.length) return;
    const kind = classifyBlock(textFeatures(blk.map((x) => x.norm)), contiguous, notes);
    if (!kind) return;
    const byHour = new Map();
    for (const x of blk) {
      byHour.set(x.k, (byHour.get(x.k) || 0) + x.credit);
      if (x.rec) x.rec.f |= TOK_TEXT;
    }
    for (const [k, c] of byHour) this.flag(k, kind, { words: Math.round(c), sample: blk.slice(0, 8).map((x) => x.norm).join(' ') });
  }

  // Paste dialog helper: per raw word of `text`, already credited to me / to someone else.
  // otherVisible(entry): may this writer learn about that match? (The app reveals matches with
  // public text only, never with someone's notes or separate posts; scoring doesn't care.)
  pasteCheck(text, now, otherVisible = null) {
    const words = rawWords(text);
    const norms = words.map((w) => foldKey(normalizeToken(w.text)));
    const own = this._ownPasteMask(norms, Number.isFinite(now) ? now : this.lastT, false); // read-only
    const other = new Array(words.length).fill(false);
    const K = this.K;
    for (let j = 0; j + K <= norms.length; j++) {
      const key = gramKey(norms, j, j + K);
      const mine = this.own.has(key);
      const e = !mine && this.shared ? this.shared.get(key) : null;
      const theirs = e && e.w !== this.writer && (!otherVisible || otherVisible(e));
      if (mine || theirs) for (let q = j; q < j + K; q++) (mine ? own : other)[q] = true;
    }
    return words.map((w, i) => ({ text: w.text, own: own[i], other: other[i] }));
  }

  // --- results
  result(now) {
    if (now === undefined) now = Number.isFinite(this.lastT) ? this.lastT + this.settleMs + this.quantum : 0;
    this.advance(now);
    const S = this.S;
    // Text checks on words whose run is still open are evaluated on copies, so calling
    // result() (e.g. for a live dashboard) never changes later results.
    const extra = new Map(); // hour -> { flags }
    const vText = new Set(); // words in open runs the text checks would flag (not marked: copies)
    const virtualFlush = (blk, contiguous, notes = false) => {
      const kind = classifyBlock(textFeatures(blk.map((x) => x.norm)), contiguous, notes);
      if (!kind) return;
      const byHour = new Map();
      for (const x of blk) {
        byHour.set(x.k, (byHour.get(x.k) || 0) + x.credit);
        if (x.rec) vText.add(x.rec);
      }
      for (const [k, c] of byHour) {
        if (!extra.has(k)) extra.set(k, { flags: [] });
        extra.get(k).flags.push({ hour: k, type: kind, words: Math.round(c), sample: blk.slice(0, 8).map((x) => x.norm).join(' ') });
      }
    };
    const pool = this.scattered.slice();
    for (const rb of this.runBlocks.values()) {
      if (rb.toks.length >= 20 || (rb.total >= 20 && rb.toks.length >= 10)) virtualFlush(rb.toks, true, rb.notes);
      else pool.push(...rb.toks);
    }
    if (pool.length >= 20) virtualFlush(pool, false);
    let pending = 0;
    for (const P of this.panes.values()) {
      // Everything before P.lo has settled (see _collectPane).
      for (let i = Math.max(0, Math.min(P.lo, P.meta.length)); i < P.meta.length; i++) {
        const m = P.meta[i];
        if (m & ELIG && !(m & SETTLED) && isWordCh(P.text[i])) pending += 1 / 5.5;
      }
    }
    const kNow = this.joinedAt === null ? 0 : this.hourOf(now);
    // Extra credit from outside the op log (SPEC §20c: food-form words), ctx.bonus = [{ at, words }]:
    // each entry counts in the hour containing `at` (hour 1 for anything before it) and is never flagged.
    const bonusOf = new Map();
    for (const b of Array.isArray(this.ctx.bonus) ? this.ctx.bonus : []) {
      if (!b || !Number.isFinite(b.at) || !(b.words > 0) || b.at > now) continue;
      const k = this.hourOf(b.at);
      bonusOf.set(k, (bonusOf.get(k) || 0) + b.words);
    }
    const nH = Math.max(this.hours.length, kNow + 1, ...[...bonusOf.keys()].map((k) => k + 1));
    const free = new Set(this.ctx.freeHours || []);
    const out = [];
    const allFlags = [];
    const totals = { credit: 0, written: 0, pasted: 0, cut: 0, clawback: 0, bonus: 0, flaggedCredit: 0, notCounted: {} };
    for (const x of NC_KEYS) totals.notCounted[x] = 0;
    for (let k = 0; k < nH; k++) {
      const h = this.H(k);
      const cutNet = Math.max(0, h.cutRaw - h.cutSameClaw);
      const cut = Math.min(cutNet, this.cutCapOf(k));
      const nc = { ...h.nc, overCutCap: cutNet - cut, overPasteCap: 0 };
      let pasted = h.pasted;
      if (Number.isFinite(S.pasteCapPerHour) && pasted > S.pasteCapPerHour) {
        nc.overPasteCap = pasted - S.pasteCapPerHour;
        pasted = S.pasteCapPerHour;
      }
      const bonus = bonusOf.get(k) || 0;
      const credit = Math.max(0, h.written + pasted + cut - h.claw) + bonus;
      const win = this.hourWindow(k);
      const target = this.targetOf(k);
      const flags = h.flags.map((f) => ({ ...f }));
      const ex = extra.get(k);
      if (ex) {
        for (const f of ex.flags) {
          const same = flags.find((x) => x.type === f.type);
          if (same) same.words = (same.words || 0) + f.words;
          else flags.push(f);
        }
      }
      const reuseShare = h.typedTokens ? h.reusedTokens / h.typedTokens : 0;
      let reuseReview = false;
      if (h.typedTokens >= S.reuseFlagMinWords && reuseShare > S.reuseFlagShare) {
        flags.push({ hour: k, type: 'reusingWords', share: +reuseShare.toFixed(2) });
        reuseReview = reuseShare > S.reuseReviewShare;
      }
      if (h.creditedTokens >= S.recycleFlagMinWords && h.recycledTokens / h.creditedTokens > S.recycleFlagShare) flags.push({ hour: k, type: 'recycledPhrases', share: +(h.recycledTokens / h.creditedTokens).toFixed(2) });
      const typedWords = h.typedChars / 6;
      let steady = false;
      if (typedWords >= S.steadyMinWords && (h.pauses * 100) / typedWords < S.steadyPausesPer100) {
        flags.push({ hour: k, type: 'steadyTyping', pausesPer100Words: +((h.pauses * 100) / typedWords).toFixed(1) });
        steady = true; // all typed words
      }
      let pasteReview = false;
      if (h.pasted >= S.bigPasteWords) {
        flags.push({ hour: k, type: 'bigPaste', words: Math.round(h.pasted) });
        // Review when the hour needs at least bigPasteWords of its pasted words to make the target.
        pasteReview = S.reviewBigPastes && target - (credit - pasted) >= S.bigPasteWords; // all pasted words
      }
      // Late work (received after this hour had ended) never meets the hour by itself.
      const late = h.lateCredit + Math.min(h.lateCut, cut);
      if (late > 0) flags.push({ hour: k, type: 'lateWork', words: round(late), from: h.lateFrom, to: h.lateTo, receivedAt: h.lateRecv });
      let mostly = false;
      if (h.written + h.pasted >= S.discardFlagMinWords && h.discarded / (h.written + h.pasted) > S.discardFlagShare) {
        flags.push({ hour: k, type: 'mostlyDeleted', share: +(h.discarded / (h.written + h.pasted)).toFixed(2) });
        mostly = true; // the credit of words deleted soon after
      }
      // Flagged credit: each word's credit at most once, whichever flags cover it.
      let flagged = Math.min(h.lateCut, cut) + (reuseReview ? h.reusedLater : 0);
      for (const rec of h.recs) {
        if (rec.f & (TOK_BULK | TOK_LATE | TOK_TEXT) || vText.has(rec) || (steady && !rec.p) || (pasteReview && rec.p) || (reuseReview && rec.f & TOK_REUSED)) flagged += rec.c;
        else if (mostly && rec.d > 0) flagged += Math.min(rec.d, rec.c);
      }
      flagged = Math.min(flagged, credit);
      let status;
      if (now < win.endAt + this.settleMs) status = 'open';
      else if (free.has(k)) status = 'free';
      else if (credit >= target) status = credit - flagged >= target ? 'met' : 'review';
      else status = 'missed';
      out.push({
        k, startAt: win.startAt, endAt: win.endAt, target, status,
        credit: round(credit), written: round(h.written), pasted: round(pasted), cut: round(cut), clawback: round(h.claw), bonus: round(bonus),
        flaggedCredit: round(flagged),
        notCounted: Object.fromEntries([...NC_KEYS, 'overPasteCap'].map((x) => [x, round(nc[x] || 0)])),
        flags,
      });
      allFlags.push(...flags);
      totals.credit += credit;
      totals.written += h.written;
      totals.pasted += pasted;
      totals.cut += cut;
      totals.clawback += h.claw;
      totals.bonus += bonus;
      totals.flaggedCredit += flagged;
      for (const x of NC_KEYS) totals.notCounted[x] += nc[x];
    }
    for (const key of Object.keys(totals)) if (typeof totals[key] === 'number') totals[key] = round(totals[key]);
    for (const x of NC_KEYS) totals.notCounted[x] = round(totals.notCounted[x]);
    const res = { now, hours: out, totals, pending: round(pending), flags: allFlags };
    if (this.timeline) res.timeline = [...this.timeline.entries()].sort((a, b) => a[0] - b[0]);
    return res;
  }
}

const round = (x) => Math.round(x * 100) / 100 + 0; // + 0: never -0

export function score(ops, settings = {}, ctx = {}) {
  const sc = createScorer(settings, ctx);
  for (const op of ops) sc.apply(op);
  return sc.result(ctx.now);
}

// Party (cross-writer) mode: every writer settles in lockstep, so "who wrote it first" is
// decided by time alone, independent of call order.
export function createParty(settings = {}, ctxByWriter = {}) {
  const shared = createSharedIndex();
  const scorers = new Map();
  const get = (w) => {
    let sc = scorers.get(w);
    if (!sc) {
      sc = new Scorer(settings, { ...(ctxByWriter[w] || {}), writer: w, shared });
      scorers.set(w, sc);
    }
    return sc;
  };
  let settledTo = -Infinity;
  const advance = (t) => {
    const all = [...scorers.values()];
    if (!all.length) return;
    const q = all[0].quantum;
    const Q = Math.floor(t / q) * q;
    if (Q <= settledTo) return;
    for (;;) {
      let next = Infinity;
      for (const sc of all) {
        if (sc.nextSettle < sc.segs.length) next = Math.min(next, Math.ceil((sc.segs[sc.nextSettle].t + sc.settleMs) / q) * q);
        if (sc.deferredPanes.size) next = Math.min(next, sc.settledTo + q);
      }
      if (next > Q) break;
      const recs = [];
      for (const sc of all) {
        const r = sc._collect(next);
        sc.settledTo = Math.max(sc.settledTo, next);
        for (const x of r) recs.push([sc, x]);
      }
      recs.sort((x, y) => x[1].tMax - y[1].tMax || String(x[0].writer).localeCompare(String(y[0].writer)) || x[1].order - y[1].order);
      for (const [sc, r] of recs) sc._processOne(r);
    }
    for (const sc of all) sc.settledTo = Math.max(sc.settledTo, Q);
    settledTo = Q;
  };
  // The same as advance(t), in pieces: after each writer's collection and every 64 settled words
  // it asks yieldNow() and, if true, awaits pause(). For an engine no one else reads or writes
  // meanwhile (a background re-score); stop() true abandons it.
  const advanceAsync = async (t, { yieldNow, pause, stop = () => false }) => {
    const all = [...scorers.values()];
    if (!all.length) return;
    const q = all[0].quantum;
    const Q = Math.floor(t / q) * q;
    if (Q <= settledTo) return;
    for (;;) {
      let next = Infinity;
      for (const sc of all) {
        if (sc.nextSettle < sc.segs.length) next = Math.min(next, Math.ceil((sc.segs[sc.nextSettle].t + sc.settleMs) / q) * q);
        if (sc.deferredPanes.size) next = Math.min(next, sc.settledTo + q);
      }
      if (next > Q) break;
      const recs = [];
      for (const sc of all) {
        const r = sc._collect(next);
        sc.settledTo = Math.max(sc.settledTo, next);
        for (const x of r) recs.push([sc, x]);
        if (yieldNow()) {
          await pause();
          if (stop()) return;
        }
      }
      recs.sort((x, y) => x[1].tMax - y[1].tMax || String(x[0].writer).localeCompare(String(y[0].writer)) || x[1].order - y[1].order);
      for (let i = 0; i < recs.length; i++) {
        recs[i][0]._processOne(recs[i][1]);
        if ((i & 63) === 63 && yieldNow()) {
          await pause();
          if (stop()) return;
        }
      }
    }
    for (const sc of all) sc.settledTo = Math.max(sc.settledTo, Q);
    settledTo = Q;
  };
  return {
    shared,
    scorer: get,
    advanceAsync,
    // Would advance(t) settle anything new? (A background replay settles in slices first.)
    due(t) {
      const sc = scorers.values().next().value;
      return !!sc && Math.floor(t / sc.quantum) * sc.quantum > settledTo;
    },
    apply(w, op) {
      get(w);
      advance(op.t);
      get(w).apply(op);
    },
    advance,
    result(w, now) {
      const sc = get(w);
      if (now === undefined) now = Number.isFinite(sc.lastT) ? sc.lastT + sc.settleMs + sc.quantum : 0;
      advance(now);
      return sc.result(now);
    },
  };
}

export function scoreParty(opsByWriter, settings = {}, ctxByWriter = {}, now) {
  const party = createParty(settings, ctxByWriter);
  const all = [];
  for (const [w, ops] of Object.entries(opsByWriter)) {
    party.scorer(w);
    ops.forEach((op, i) => all.push([w, op, i]));
  }
  all.sort((x, y) => x[1].t - y[1].t || x[0].localeCompare(y[0]) || x[2] - y[2]);
  for (const [w, op] of all) party.apply(w, op);
  let end = 0;
  for (const [, op] of all) end = Math.max(end, op.t);
  const out = {};
  for (const w of Object.keys(opsByWriter)) out[w] = party.result(w, now ?? end + 120_000);
  return out;
}
