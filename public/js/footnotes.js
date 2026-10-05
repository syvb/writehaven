// Footnotes (SPEC §31): "[^label]" in the text points at a note written on a line of its own as
// "[^label]: the note"; lines indented under a note continue it (a blank line followed by an
// indented line too). Notes are numbered in the order they're first referred to; a reference
// without a note, and a note nobody refers to, stay plain text. Pure functions shared by the
// editor, the public pages, copies and exports. Works on Safari before 16.4 (no lookbehind, no
// newer built-ins).

export const FN_REF = /\[\^([^\]\s^[]{1,40})\]/g;
export const FN_DEF = /^ {0,3}\[\^([^\]\s^[]{1,40})\]:[ \t]?/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const INDENTED = /^(?: {2,}|\t)\S/;

// Code spans in a line, blanked out (same length), so "`[^1]`" is never a reference.
export function maskCode(line) {
  if (line.indexOf('`') < 0) return line;
  return line.replace(/(`+)[\s\S]*?\1/g, (m) => ' '.repeat(m.length));
}

// footnotes(text) -> {
//   defs: Map(label -> { start, end, textStart, body }): the first note for each label; `body`
//     is its text (continuation lines joined with "\n", their indentation removed);
//   order: Map(label -> n) for notes that are referred to, numbered by first reference;
//   refs: [{ label, from, to }] every reference in the text (also undefined ones), in order;
//   defLines: Set of line starts that belong to any note (its first line and continuations);
//   noteLines: Set of line starts of the notes that are listed (referred to, first of their label):
//     these leave the flow of the text on public pages and in copies;
//   blocks: [{ label, start, end, textStart }] every note (a second one for a label too), in
//     order: from its line's start to the end of its last line }
export function footnotes(text) {
  const defs = new Map();
  const refs = [];
  const defLines = new Set();
  const all = [];
  const n = text.length;
  let pos = 0;
  let fence = '';
  let cur = null; // the note being read, while its continuation lines last
  let pendingBlank = null; // a blank line inside a note, kept only if an indented line follows
  while (pos <= n) {
    let end = text.indexOf('\n', pos);
    if (end < 0) end = n;
    const line = text.slice(pos, end);
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !/\S/.test(line.slice(f[0].length))) fence = '';
      cur = null;
    } else if (f) {
      fence = f[1];
      cur = null;
    } else {
      const d = FN_DEF.exec(line);
      if (d) {
        const label = d[1];
        cur = { start: pos, end, textStart: pos + d[0].length, lines: [line.slice(d[0].length)], lineStarts: [pos], label };
        all.push(cur);
        if (!defs.has(label)) defs.set(label, cur);
        defLines.add(pos);
        pendingBlank = null;
        scanRefs(line.slice(d[0].length), pos + d[0].length, refs);
      } else if (cur && INDENTED.test(line)) {
        if (pendingBlank !== null) {
          cur.lines.push('');
          cur.lineStarts.push(pendingBlank);
          defLines.add(pendingBlank);
          pendingBlank = null;
        }
        cur.lines.push(line.replace(/^\s+/, ''));
        cur.lineStarts.push(pos);
        cur.end = end;
        defLines.add(pos);
        scanRefs(line, pos, refs);
      } else if (cur && !line.trim() && pendingBlank === null) {
        pendingBlank = pos;
      } else {
        cur = null;
        pendingBlank = null;
        scanRefs(line, pos, refs);
      }
    }
    if (end >= n) break;
    pos = end + 1;
  }
  const order = new Map();
  for (const r of refs) if (defs.has(r.label) && !order.has(r.label)) order.set(r.label, order.size + 1);
  const blocks = all.map((b) => ({ label: b.label, start: b.start, end: b.end, textStart: b.textStart }));
  const noteLines = new Set();
  for (const [label, d] of defs) {
    d.body = d.lines.join('\n').replace(/\s+$/, '');
    if (order.has(label)) for (const ls of d.lineStarts) noteLines.add(ls);
    delete d.lines;
    delete d.label;
  }
  return { defs, order, refs, defLines, noteLines, blocks };
}

function scanRefs(line, at, out) {
  if (line.indexOf('[^') < 0) return;
  const masked = maskCode(line);
  FN_REF.lastIndex = 0;
  let m;
  while ((m = FN_REF.exec(masked))) out.push({ label: m[1], from: at + m.index, to: at + m.index + m[0].length });
}

// The number a new footnote gets: one more than the largest number used as a label.
export function nextFootnoteNumber(info) {
  let max = 0;
  const seen = (label) => {
    if (/^\d{1,6}$/.test(label)) max = Math.max(max, Number(label));
  };
  for (const label of info.defs.keys()) seen(label);
  for (const r of info.refs) seen(r.label);
  return max + 1;
}

// Plain-text form of a reference in running text: "[1]" (copies and exports as plain text).
export const plainRef = (n) => `[${n}]`;

// ---------------------------------------------------------------- putting the notes in order
const NUMERIC = /^\d{1,6}$/;
const NEW = ' new'; // the note Add footnote adds (a real label never holds a space)

// Do the notes (each with its indented lines) form one block at the end of the text, with only
// blank lines between and after them?
function trailing(text, blocks) {
  if (!blocks.length) return false;
  for (let i = 0; i + 1 < blocks.length; i++) if (/\S/.test(text.slice(blocks[i].end, blocks[i + 1].start))) return false;
  return !/\S/.test(text.slice(blocks[blocks.length - 1].end));
}

// Where the editor offers "Put notes in order": the start of the notes when they form one block at
// the end and the listed ones don't come in the order of their numbers; else -1.
export function notesOutOfOrder(text, info = footnotes(text)) {
  const { blocks, order } = info;
  if (blocks.length < 2 || !trailing(text, blocks)) return -1;
  const seen = new Set();
  let last = 0;
  for (const b of blocks) {
    if (seen.has(b.label)) continue;
    seen.add(b.label);
    const n = order.get(b.label);
    if (!n) continue;
    if (n < last) return blocks[0].start;
    last = n;
  }
  return -1;
}

// What puts a text's footnotes in order (SPEC §31):
//   - numeric labels become their notes' numbers by first use, in references and notes alike,
//     position by position (so 1 and 2 can swap); other labels ([^note]) stay as they are;
//   - when the notes form one block at the end (only blank lines between them), they go in that
//     order, each with its indented lines and a blank-line gap it brings along; notes nobody refers
//     to follow, in the order they were. Notes elsewhere in the text are only renumbered;
//   - a label of an unused note or of a reference without a note keeps its label unless a new
//     number takes it (it then gets a number after all the others).
// { add: pos } (Add footnote) also adds a reference at pos and its note: in its place among the
// notes, or at the end of the text as before; the reference takes the number of its place.
// -> { changes: [{ from, to, insert }] the least that changes `text` (sorted, apart), [] when it's
//        in order already;
//      ops: [{ pos, del, ins, source? }] the same edit as the editor sends it, one op after
//        another: the labels first, then each note that moves as two ops in a row with source
//        'move', its text inserted where it goes and the same text deleted where it was
//        (lib/score.js carries its credit along), the gap it brings as ordinary ops;
//      caret: with `add`, where the new note's text starts in the new text, else null }
export function orderFootnotes(text, { add = null } = {}) {
  const info = footnotes(text);
  const { blocks } = info;
  const m = blocks.length;
  const noteAt = (p) => {
    for (let i = 0; i < m; i++) if (p >= blocks[i].start && p <= blocks[i].end) return i;
    return -1;
  };
  // The new reference never goes inside another one, nor before a note's text.
  let at = -1;
  if (add !== null && add !== undefined) {
    at = Math.max(0, Math.min(text.length, Math.floor(Number(add)) || 0));
    for (const r of info.refs) if (at > r.from && at < r.to) at = r.to;
    for (const b of blocks) if (at >= b.start && at < b.textStart) at = b.textStart;
  }
  // (A new reference among the notes but outside them would be text after them.)
  let inBlock = trailing(text, blocks) && !(at >= 0 && at >= blocks[0].start && noteAt(at) < 0);
  // Every reference in reading order, the new one too, and the note it's in (-1: the text).
  const refs = info.refs.map((r) => ({ label: r.label, from: r.from, in: inBlock ? noteAt(r.from) : -1 }));
  if (at >= 0) {
    let i = 0;
    while (i < refs.length && refs[i].from < at) i++;
    refs.splice(i, 0, { label: NEW, from: at, in: inBlock ? noteAt(at) : -1 });
  }
  const number = (seq) => {
    const o = new Map();
    for (const r of seq) if ((r.label === NEW || info.defs.has(r.label)) && !o.has(r.label)) o.set(r.label, o.size + 1);
    return o;
  };
  let order = number(refs);
  let arr = null; // the notes in their new order: indices into `blocks`, m for the new one
  if (inBlock) {
    // Reading order is the text, then the notes as listed: a reference inside a note can number
    // differently once the notes move, so this goes round until the numbers hold (once or twice).
    const first = new Map();
    blocks.forEach((b, i) => {
      if (!first.has(b.label)) first.set(b.label, i);
    });
    const text0 = refs.filter((r) => r.in < 0);
    const inside = blocks.map(() => []);
    for (const r of refs) if (r.in >= 0) inside[r.in].push(r);
    const arrange = (o) => {
      const list = [...o.keys()].map((l) => (l === NEW ? m : first.get(l)));
      const listed = new Set(list);
      for (let i = 0; i < m; i++) if (!listed.has(i)) list.push(i);
      return list;
    };
    for (let round = 0; round < 8 && !arr; round++) {
      const next = arrange(order);
      const o = number(text0.concat(...next.map((i) => (i < m ? inside[i] : []))));
      if (o.size === order.size && [...o].every(([l, n]) => order.get(l) === n)) arr = next;
      else order = o;
    }
    if (!arr) {
      inBlock = false;
      order = number(refs);
    }
  }
  // New labels.
  const rename = new Map();
  const taken = new Set();
  for (const [l, n] of order) {
    const to = l === NEW || NUMERIC.test(l) ? String(n) : l;
    if (to !== l) rename.set(l, to);
    taken.add(to);
  }
  const seen = new Set(order.keys());
  const clash = [];
  const others = info.refs.map((r) => [r.from, r.label]).concat(blocks.map((b) => [b.start, b.label])).sort((x, y) => x[0] - y[0]);
  for (const [, l] of others) {
    if (seen.has(l)) continue;
    seen.add(l);
    if (NUMERIC.test(l) && taken.has(l)) clash.push(l);
    else taken.add(l);
  }
  let fresh = 1;
  for (const l of taken) if (NUMERIC.test(l)) fresh = Math.max(fresh, Number(l) + 1);
  for (const l of clash) {
    while (taken.has(String(fresh))) fresh++;
    rename.set(l, String(fresh));
    taken.add(String(fresh));
  }
  const label = at >= 0 ? rename.get(NEW) : null;
  // 1. Labels in place (and the new reference), from the end back: each position is the original.
  const ops = [];
  for (const r of info.refs) if (rename.has(r.label)) ops.push({ pos: r.from + 2, del: r.label.length, ins: rename.get(r.label) });
  for (const b of blocks) if (rename.has(b.label)) ops.push({ pos: text.indexOf('[^', b.start) + 2, del: b.label.length, ins: rename.get(b.label) });
  if (at >= 0) ops.push({ pos: at, del: 0, ins: `[^${label}]` });
  ops.sort((x, y) => y.pos - x.pos);
  let now = text;
  for (const op of ops) now = now.slice(0, op.pos) + op.ins + now.slice(op.pos + op.del);
  let caret = null;
  const push = (op) => {
    ops.push(op);
    now = now.slice(0, op.pos) + op.ins + now.slice(op.pos + op.del);
    if (caret !== null && op.pos < caret) caret = op.pos + op.del <= caret ? caret + op.ins.length - op.del : op.pos;
  };
  // 2. The notes in their order: each one that moves goes after the note before it (or before
  // the first note that stays), bringing the gap that was after it (before it, if it was last).
  const after = inBlock ? footnotes(now).blocks : null;
  if (inBlock && after.length === m) {
    const rank = [];
    arr.forEach((id, k) => {
      if (id < m) rank[id] = k;
    });
    const stays = rising(rank);
    const gaps = [];
    for (let i = 0; i + 1 < m; i++) gaps.push(now.slice(after[i].end, after[i + 1].start));
    const usual = mostCommon(gaps) || '\n';
    const items = [];
    after.forEach((b, i) => {
      if (i) items.push({ gap: gaps[i - 1] });
      items.push({ id: i, t: now.slice(b.start, b.end) });
    });
    const offset = (k) => {
      let p = after[0].start;
      for (let i = 0; i < k; i++) p += (items[i].gap ?? items[i].t).length;
      return p;
    };
    for (let k = 0; k < arr.length; k++) {
      const id = arr[k];
      if (stays.has(id)) continue;
      const old = id < m ? items.find((it) => it.id === id) : null;
      const brought = old ? items[items.indexOf(old) + (items.indexOf(old) + 1 < items.length ? 1 : -1)] : null;
      const gap = brought ? brought.gap : usual;
      const item = { id, t: old ? old.t : `[^${label}]: ` };
      const move = old ? { source: 'move' } : {};
      if (k > 0) {
        const j = items.findIndex((it) => it.id === arr[k - 1]) + 1;
        push({ pos: offset(j), del: 0, ins: gap });
        items.splice(j, 0, { gap });
        push({ pos: offset(j + 1), del: 0, ins: item.t, ...move });
        items.splice(j + 1, 0, item);
      } else {
        const j = items.findIndex((it) => stays.has(it.id));
        push({ pos: offset(j), del: 0, ins: gap });
        items.splice(j, 0, { gap });
        push({ pos: offset(j), del: 0, ins: item.t, ...move });
        items.splice(j, 0, item);
      }
      if (!old) caret = offset(items.indexOf(item)) + item.t.length;
      else {
        push({ pos: offset(items.indexOf(old)), del: old.t.length, ins: '', source: 'move' });
        items.splice(items.indexOf(old), 1);
        push({ pos: offset(items.indexOf(brought)), del: gap.length, ins: '' });
        items.splice(items.indexOf(brought), 1);
      }
    }
  } else if (at >= 0) {
    // At the end, as before: under the last line (a note's: right under it).
    let p = now.length;
    while (p > 0 && /\s/.test(now[p - 1])) p--;
    const lineStart = now.lastIndexOf('\n', p - 1) + 1;
    const lineEnd = now.indexOf('\n', p) < 0 ? now.length : now.indexOf('\n', p);
    const lead = footnotes(now).defLines.has(lineStart) ? '\n' : '\n\n';
    push({ pos: lineEnd, del: 0, ins: `${lead}[^${label}]: ` });
    caret = lineEnd + lead.length + label.length + 5;
  }
  return { changes: changesOf(text, ops), ops, caret };
}

// Indices of a longest run of `seq` whose values rise (the notes that can stay where they are).
function rising(seq) {
  const tails = [];
  const prev = [];
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < seq[i]) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = i;
  }
  const out = new Set();
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) out.add(i);
  return out;
}

function mostCommon(list) {
  const n = new Map();
  let best = null;
  for (const x of list) {
    n.set(x, (n.get(x) || 0) + 1);
    if (best === null || n.get(x) > n.get(best)) best = x;
  }
  return best;
}

// The edit that `ops` make one after another, as the least changes on `text` (sorted, apart).
function changesOf(text, ops) {
  const len = (pc) => (pc.s !== undefined ? pc.s.length : pc.b - pc.a);
  const part = (pc, x, y) => (pc.s !== undefined ? { s: pc.s.slice(x, y) } : { a: pc.a + x, b: pc.a + y });
  let pieces = [{ a: 0, b: text.length }]; // the new text: stretches of the old one and new strings
  for (const op of ops) {
    const out = [];
    const to = op.pos + op.del;
    let p = 0;
    let put = false;
    const place = () => {
      if (!put && op.ins) out.push({ s: op.ins });
      put = true;
    };
    for (const pc of pieces) {
      const s = p;
      const e = p + len(pc);
      p = e;
      if (s < op.pos) out.push(part(pc, 0, Math.min(len(pc), op.pos - s)));
      if (e >= op.pos) place();
      if (e > to) out.push(part(pc, Math.max(0, to - s), len(pc)));
    }
    place();
    pieces = out.filter((pc) => len(pc) > 0);
  }
  const changes = [];
  let o = 0;
  let ins = '';
  const flush = (upTo) => {
    if (upTo > o || ins) {
      // Trimmed to what differs.
      let from = o;
      let to = upTo;
      let a = 0;
      while (from < to && a < ins.length && text[from] === ins[a]) {
        from++;
        a++;
      }
      let b = ins.length;
      while (to > from && b > a && text[to - 1] === ins[b - 1]) {
        to--;
        b--;
      }
      if (to > from || b > a) changes.push({ from, to, insert: ins.slice(a, b) });
    }
    ins = '';
  };
  for (const pc of pieces) {
    if (pc.s !== undefined) {
      ins += pc.s;
      continue;
    }
    flush(pc.a);
    o = pc.b;
  }
  flush(text.length);
  return changes;
}
