// Footnotes (SPEC §31): the shared scanner (numbering by first use, notes and their continuation
// lines, references in code, the next number), the scorer (markers and labels are never words, the
// note's text counts like the body), the word count, and linear scans on hostile lines. Notes put in
// order (orderFootnotes: renumbering, the notes at the end in order, Add footnote), and the scorer's
// view of it: a renumber that moves notes changes no credit, cut, flag or paste.
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { footnotes, nextFootnoteNumber, maskCode, orderFootnotes, notesOutOfOrder } from '../public/js/footnotes.js';
import { score, markupSpans, inSpans, scoreParty, createScorer } from '../lib/score.js';
import { wordDelta } from '../lib/party.js';
import { countWords, replayOps } from '../public/js/text.js';
import { makeParty, addUser, typeInto } from './helpers.js';

const SEC = 1000;
const MIN = 60 * SEC;

test('§31 footnotes: numbered by first use; notes, continuation lines, unused and undefined', () => {
  const text = [
    'The keeper counted the steps[^steps] and wrote them down[^1]. Again[^steps].',
    'A guess[^nothere] stays text, and so does `code [^1]`.',
    '',
    '[^1]: The ledger had a green cloth spine.',
    '[^steps]: One hundred and twelve,',
    '  counted aloud every evening.',
    '',
    '  Even in fog.',
    '[^spare]: A note nobody refers to.',
    '',
    '```',
    '[^inside]: in a code block',
    'and [^1] here too',
    '```',
  ].join('\n');
  const f = footnotes(text);
  assert.deepEqual([...f.order], [['steps', 1], ['1', 2]]);
  assert.deepEqual(f.refs.map((r) => r.label), ['steps', '1', 'steps', 'nothere']);
  assert.equal(f.defs.get('steps').body, 'One hundred and twelve,\ncounted aloud every evening.\n\nEven in fog.');
  assert.equal(f.defs.get('1').body, 'The ledger had a green cloth spine.');
  assert.equal(f.defs.get('spare').body, 'A note nobody refers to.');
  assert.ok(!f.defs.has('inside'), 'nothing inside a code block');
  // Listed notes leave the flow: their lines (and only theirs).
  const listed = [...f.noteLines].map((s) => text.slice(s, text.indexOf('\n', s)));
  assert.deepEqual(listed, ['[^1]: The ledger had a green cloth spine.', '[^steps]: One hundred and twelve,', '  counted aloud every evening.', '', '  Even in fog.']);
  // References keep their positions in the text.
  const r0 = f.refs[0];
  assert.equal(text.slice(r0.from, r0.to), '[^steps]');
  // The next number: one more than the largest number used as a label.
  assert.equal(nextFootnoteNumber(f), 2);
  assert.equal(nextFootnoteNumber(footnotes('a[^3] b[^x]\n\n[^3]: c\n[^7]: d')), 8);
  assert.equal(nextFootnoteNumber(footnotes('no notes')), 1);
});

test('§31 footnotes: edge cases (labels, a note at the very start, references inside notes)', () => {
  let f = footnotes('[^a]: Only a note, first line.\nText[^a].');
  assert.deepEqual([...f.order], [['a', 1]]);
  f = footnotes('One[^1]\n[^1]: note with a ref[^2]\n[^2]: second');
  assert.deepEqual([...f.order], [['1', 1], ['2', 2]], 'a reference inside a note counts as a use');
  f = footnotes('x[^1] y[^1]\n\n[^1]: first\n[^1]: second, ignored');
  assert.equal(f.defs.get('1').body, 'first', 'the first note for a label wins');
  f = footnotes('[^ spaced]: no\n[^]: no\n[^a]b]: no\nt[^ok]\n\n   [^ok]: up to three spaces of indent');
  assert.deepEqual([...f.order], [['ok', 1]]);
  assert.equal(maskCode('a `[^1]` b ``[^2] ` x`` [^3]'), `a ${' '.repeat(6)} b ${' '.repeat(12)} [^3]`);
});

test('§31 scorer: markers and labels are never words; the note text counts', () => {
  const spans = markupSpans('Text[^1] and [^long-label] here.');
  const words = (line, s) => [...line.matchAll(/[\p{L}\p{N}]+/gu)].filter((m) => !inSpans(s, m.index, m.index + m[0].length)).map((m) => m[0]);
  assert.deepEqual(words('Text[^1] and [^long-label] here.', spans), ['Text', 'and', 'here']);
  const def = '[^12]: The ledger had a green cloth spine.';
  assert.deepEqual(words(def, markupSpans(def)), ['The', 'ledger', 'had', 'a', 'green', 'cloth', 'spine']);
  // Typed through the editor: the markers earn nothing, the note's words count once settled.
  const ops = [];
  let t = 0;
  let text = '';
  const type = (s, pos = text.length) => {
    for (const ch of s) {
      ops.push({ t, post: 'p', pane: 'body', pos, del: 0, ins: ch, source: 'type' });
      text = text.slice(0, pos) + ch + text.slice(pos);
      pos++;
      t += 140 + ((pos * 31) % 120);
    }
  };
  type('Every evening the keeper climbed the steps');
  const r0 = score(ops, {}, { joinedAt: 0, now: t + 2 * MIN }).hours[0];
  // "Add footnote": the marker and the note's label in one step, then the note typed.
  ops.push({ t, post: 'p', pane: 'body', pos: text.length, del: 0, ins: '[^1]\n\n[^1]: ', source: 'type' });
  text += '[^1]\n\n[^1]: ';
  t += 2000;
  type('There were one hundred and twelve of them.');
  const r = score(ops, {}, { joinedAt: 0, now: t + 2 * MIN }).hours[0];
  assert.equal(r.written - r0.written, 8, 'the note: 8 words, the markers none');
  assert.deepEqual(r.flags.map((f) => f.type), []);
});

test('§31 scorer and footnotes scanner stay linear on hostile lines (30k+ characters)', () => {
  const lines = {
    'repeated [^': '[^'.repeat(16000),
    'repeated [^a': '[^a'.repeat(11000),
    'repeated [^a]': '[^a]'.repeat(8000),
    'repeated [^ab]:': '[^ab]:'.repeat(6000),
    'long label': `[^${'a'.repeat(32000)}]`,
  };
  for (const [name, line] of Object.entries(lines)) {
    assert.ok(line.length >= 30000, name);
    let best = Infinity;
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      markupSpans(line);
      footnotes(line);
      best = Math.min(best, performance.now() - t0);
    }
    assert.ok(best < 25, `${name}: ${best.toFixed(1)} ms`);
  }
});

test('§31 word counts: markers aren\'t words, notes are; deltas match full recounts', () => {
  assert.equal(countWords('Text[^1] and more[^2].'), 3);
  assert.equal(countWords('A word [^1] alone'), 3);
  assert.equal(countWords('[^1]: The note text'), 3);
  assert.equal(countWords('[^long-label]: x'), 1);
  assert.equal(countWords('word[^1]word'), 1);
  let text = 'Start[^1] middle [^a] end.\n\n[^1]: one\n[^a]: two words\n';
  let seed = 11;
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const bits = [' ', 'a', '[', ']', '^', ':', '[^1]', '[^x]: ', 'word ', '\n', '1', '[^'];
  for (let k = 0; k < 4000; k++) {
    const pos = rnd(text.length + 1);
    const del = Math.min(rnd(4), text.length - pos);
    const ins = rnd(3) ? bits[rnd(bits.length)] : '';
    const before = countWords(text);
    const d = wordDelta(text, pos, del, ins);
    text = text.slice(0, pos) + ins + text.slice(pos + del);
    assert.equal(before + d, countWords(text), `edit ${k}`);
    if (text.length > 600) text = text.slice(0, 300);
  }
});

// ---------------------------------------------------------------- notes put in order (SPEC §31)
const applyChanges = (text, changes) => {
  let t = text;
  for (let i = changes.length - 1; i >= 0; i--) t = t.slice(0, changes[i].from) + changes[i].insert + t.slice(changes[i].to);
  return t;
};
// orderFootnotes(text, opts) with what every result holds: its changes and its ops make the same
// text; the changes are sorted and apart; a note that moves is two ops in a row, both 'move', its
// text inserted where it goes and then the same text deleted where it was; the result needs no
// further change.
function inOrder(text, opts) {
  const r = orderFootnotes(text, opts);
  const out = applyChanges(text, r.changes);
  assert.equal(replayOps(text, r.ops).text, out, 'the ops make the same text as the changes');
  r.changes.forEach((c, i) => {
    assert.ok(c.from <= c.to && c.to <= text.length, 'a change within the text');
    if (i) assert.ok(c.from > r.changes[i - 1].to, 'changes sorted and apart');
  });
  let t = text;
  for (let i = 0; i < r.ops.length; i++) {
    const o = r.ops[i];
    t = t.slice(0, o.pos) + o.ins + t.slice(o.pos + o.del);
    if (o.source !== 'move') continue;
    assert.ok(o.ins && !o.del, 'a move starts with its text where it goes');
    const d = r.ops[++i];
    assert.ok(d && d.source === 'move' && !d.ins && d.del === o.ins.length, 'then deletes it where it was');
    assert.equal(t.slice(d.pos, d.pos + d.del), o.ins, 'the same text');
    assert.ok(d.pos + d.del <= o.pos || d.pos >= o.pos + o.ins.length, 'elsewhere');
    t = t.slice(0, d.pos) + t.slice(d.pos + d.del);
  }
  assert.deepEqual(orderFootnotes(out).changes, [], 'in order afterwards');
  return { ...r, out, moved: r.ops.filter((o) => o.source === 'move' && o.ins).map((o) => o.ins) };
}
// The numbers the notes show where they're written (as the editor and live cards list them).
const listedNumbers = (text) => {
  const f = footnotes(text);
  const seen = new Set();
  return f.blocks.filter((b) => !seen.has(b.label) && seen.add(b.label)).map((b) => f.order.get(b.label) || b.label);
};

const LIVE = [
  'The keeper counted the steps[^2] every evening. His daughter checked the sums[^3]. Nobody else climbed to the lamp room[^1].',
  '',
  '[^1]: The storm broke the north window.',
  '[^2]: One hundred and twelve steps.',
  '[^3]: She used a pencil stub tied to a string.',
].join('\n');

test('§31 notes in order: the live shape (references 2, 3, 1; notes 1, 2, 3) shows 3, 1, 2 and is put right', () => {
  assert.deepEqual(listedNumbers(LIVE), [3, 1, 2]);
  assert.equal(notesOutOfOrder(LIVE), LIVE.indexOf('[^1]: '), '"Put notes in order" goes above the notes');
  const r = inOrder(LIVE);
  assert.equal(r.out, [
    'The keeper counted the steps[^1] every evening. His daughter checked the sums[^2]. Nobody else climbed to the lamp room[^3].',
    '',
    '[^1]: One hundred and twelve steps.',
    '[^2]: She used a pencil stub tied to a string.',
    '[^3]: The storm broke the north window.',
  ].join('\n'));
  assert.deepEqual(listedNumbers(r.out), [1, 2, 3]);
  assert.equal(notesOutOfOrder(r.out), -1);
  // The least change: three references and two labels renumbered in place, one note moved.
  const at = (s, k = 0) => LIVE.indexOf(s) + k;
  assert.deepEqual(r.changes, [
    { from: at('steps[^2]', 7), to: at('steps[^2]', 8), insert: '1' },
    { from: at('sums[^3]', 6), to: at('sums[^3]', 7), insert: '2' },
    { from: at('room[^1]', 6), to: at('room[^1]', 7), insert: '3' },
    { from: at('[^1]: The storm'), to: at('[^2]: One'), insert: '' },
    { from: at('[^2]: One', 2), to: at('[^2]: One', 3), insert: '1' },
    { from: at('[^3]: She', 2), to: at('[^3]: She', 3), insert: '2' },
    { from: LIVE.length, to: LIVE.length, insert: '\n[^3]: The storm broke the north window.' },
  ]);
  assert.deepEqual(r.moved, ['[^3]: The storm broke the north window.'], 'the one note that moves is sent as moved');
  assert.equal(r.caret, null);
});

test('§31 notes in order: nothing to change when they already are', () => {
  for (const text of [
    'A[^1] b[^2].\n\n[^1]: One.\n[^2]: Two.',
    'A[^1] b[^2].\n\n[^1]: One.\n\n[^2]: Two.\n',
    'A[^note] b[^2].\n\n[^note]: Named.\n[^2]: Two.',
    'A[^1].\n\n[^1]: One.\n[^9]: Nobody refers to this one.',
    'A[^1].\n\n[^1]: One.\n\nMore text[^2].\n\n[^2]: Two.',
    'Use `[^2]` as written.\n\n```\n[^1]: not a note\n```',
    'Plain text, no notes.',
    '',
  ]) {
    const r = orderFootnotes(text);
    assert.deepEqual(r.changes, [], text);
    assert.deepEqual(r.ops, [], text);
    assert.equal(notesOutOfOrder(text), -1, text);
  }
});

test('§31 notes in order: notes not at the end (text between them) are only renumbered', () => {
  const text = 'First[^2] and second[^1].\n\n[^1]: Note one.\n\nA paragraph between the notes.\n\n[^2]: Note two.';
  assert.equal(notesOutOfOrder(text), -1, 'nothing to offer: they stay where the writer put them');
  const r = inOrder(text);
  assert.equal(r.out, 'First[^1] and second[^2].\n\n[^2]: Note one.\n\nA paragraph between the notes.\n\n[^1]: Note two.');
  assert.deepEqual(r.moved, []);
  assert.equal(r.changes.length, 4);
  assert.ok(r.changes.every((c) => c.to - c.from === 1 && /^\d$/.test(c.insert)), 'labels only');
  // A swap (1 <-> 2) by position, never by replacing text: each note keeps its references.
  const f = footnotes(r.out);
  assert.equal(f.defs.get('1').body, 'Note two.');
  assert.equal(f.defs.get('2').body, 'Note one.');
  // Text after the notes: the same.
  assert.equal(inOrder('A[^2] b[^1].\n\n[^1]: One.\n[^2]: Two.\n\nA last paragraph.').out, 'A[^1] b[^2].\n\n[^2]: One.\n[^1]: Two.\n\nA last paragraph.');
});

test('§31 notes in order: labels that aren\'t numbers stay; their notes take their place', () => {
  let r = inOrder('A[^note] b[^2] c[^1] d[^note].\n\n[^1]: One.\n[^note]: Named.\n[^2]: Two.');
  assert.equal(r.out, 'A[^note] b[^2] c[^3] d[^note].\n\n[^note]: Named.\n[^2]: Two.\n[^3]: One.');
  assert.deepEqual(listedNumbers(r.out), [1, 2, 3]);
  r = inOrder('A[^b] c[^a].\n\n[^a]: Alpha.\n[^b]: Beta.');
  assert.equal(r.out, 'A[^b] c[^a].\n\n[^b]: Beta.\n[^a]: Alpha.', 'moved, never relabelled');
});

test('§31 notes in order: notes nobody refers to follow, as they were; labels never collide', () => {
  let r = inOrder('A[^2] b[^1].\n\n[^7]: Spare seven.\n[^1]: One.\n[^x]: Spare x.\n[^2]: Two.');
  assert.equal(r.out, 'A[^1] b[^2].\n\n[^1]: Two.\n[^2]: One.\n[^7]: Spare seven.\n[^x]: Spare x.');
  // An unused note whose label a new number takes gets a number after the others...
  r = inOrder('A[^5].\n\n[^1]: Spare.\n[^5]: Five.');
  assert.equal(r.out, 'A[^1].\n\n[^1]: Five.\n[^2]: Spare.');
  assert.equal(footnotes(r.out).defs.get('1').body, 'Five.');
  // ...and so does a reference without a note (it stays a reference to nothing).
  r = inOrder('A[^3] b[^1].\n\n[^3]: Three.');
  assert.equal(r.out, 'A[^1] b[^2].\n\n[^1]: Three.');
  assert.deepEqual([...footnotes(r.out).order], [['1', 1]]);
  // A second note for a label stays second (the first one is the note).
  r = inOrder('A[^2] b[^1].\n\n[^1]: First one.\n[^1]: Second one, ignored.\n[^2]: Two.');
  assert.equal(r.out, 'A[^1] b[^2].\n\n[^1]: Two.\n[^2]: First one.\n[^2]: Second one, ignored.');
  assert.equal(footnotes(r.out).defs.get('2').body, 'First one.');
});

test('§31 notes in order: a note moves with its lines; the gaps between notes stay as they were', () => {
  const text = 'Text[^2] and more[^1].\n\n[^1]: First note,\n  continued.\n\n  A second paragraph.\n\n[^2]: Second note.\n  More of it.\n';
  const r = inOrder(text);
  assert.equal(r.out, 'Text[^1] and more[^2].\n\n[^1]: Second note.\n  More of it.\n\n[^2]: First note,\n  continued.\n\n  A second paragraph.\n');
  const f = footnotes(r.out);
  assert.equal(f.defs.get('1').body, 'Second note.\nMore of it.');
  assert.equal(f.defs.get('2').body, 'First note,\ncontinued.\n\nA second paragraph.');
  // One line between notes stays one line; a blank line stays a blank line; the end stays.
  assert.equal(inOrder('x[^3] y[^1] z[^2]\n\n[^1]: a\n[^2]: b\n[^3]: c').out, 'x[^1] y[^2] z[^3]\n\n[^1]: c\n[^2]: a\n[^3]: b');
  assert.equal(inOrder('x[^3] y[^1] z[^2]\n\n[^1]: a\n\n[^2]: b\n\n[^3]: c\n\n').out, 'x[^1] y[^2] z[^3]\n\n[^1]: c\n\n[^2]: a\n\n[^3]: b\n\n');
  assert.equal(inOrder('x[^2] y[^1]\n\n[^1]: a\n\n[^2]: b\n').out, 'x[^1] y[^2]\n\n[^1]: b\n\n[^2]: a\n');
  // A reference inside a note is read where its note ends up.
  assert.equal(inOrder('x[^b] y[^a]\n\n[^a]: see[^d]\n[^b]: see[^c]\n[^c]: C\n[^d]: D').out, 'x[^b] y[^a]\n\n[^b]: see[^c]\n[^a]: see[^d]\n[^c]: C\n[^d]: D');
});

test('§31 Add footnote: the number of its place, later ones up by one, its note in its place', () => {
  let r = inOrder('One two[^1] three.\n\n[^1]: A.', { add: 3 });
  assert.equal(r.out, 'One[^1] two[^2] three.\n\n[^1]: \n[^2]: A.');
  assert.equal(r.caret, r.out.indexOf('[^1]: ') + 6, 'the caret in the new note');
  assert.deepEqual(r.moved, [], 'nothing moved: a note added, a label changed');
  r = inOrder('One two[^1] three.\n\n[^1]: A.', { add: 18 });
  assert.equal(r.out, 'One two[^1] three.[^2]\n\n[^1]: A.\n[^2]: ');
  assert.equal(r.caret, r.out.length);
  // The first one, as before: its note as a paragraph of its own at the end.
  r = inOrder('One two three.', { add: 3 });
  assert.equal(r.out, 'One[^1] two three.\n\n[^1]: ');
  assert.equal(r.caret, r.out.length);
  r = inOrder('', { add: 0 });
  assert.equal(r.out, '[^1]\n\n[^1]: ');
  assert.equal(r.caret, r.out.length);
  // Notes out of order are put in order on the way.
  r = inOrder(LIVE, { add: LIVE.indexOf(' every evening') });
  assert.equal(r.out, [
    'The keeper counted the steps[^1][^2] every evening. His daughter checked the sums[^3]. Nobody else climbed to the lamp room[^4].',
    '',
    '[^1]: One hundred and twelve steps.',
    '[^2]: ',
    '[^3]: She used a pencil stub tied to a string.',
    '[^4]: The storm broke the north window.',
  ].join('\n'));
  assert.equal(r.caret, r.out.indexOf('[^2]: ') + 6);
  assert.deepEqual(r.moved, ['[^4]: The storm broke the north window.']);
  // In a note's text: numbered where that note is read.
  r = inOrder('A[^1].\n\n[^1]: Note text.', { add: 'A[^1].\n\n[^1]: Note text.'.length });
  assert.equal(r.out, 'A[^1].\n\n[^1]: Note text.[^2]\n[^2]: ');
  // Never inside a reference, nor before a note's text.
  r = inOrder('A[^12] b.\n\n[^12]: X.', { add: 3 });
  assert.equal(r.out, 'A[^1][^2] b.\n\n[^1]: X.\n[^2]: ');
  r = inOrder('A[^1].\n\n[^1]: X.', { add: 8 });
  assert.equal(r.out, 'A[^1].\n\n[^1]: [^2]X.\n[^2]: ');
  // Notes not at the end: the new one at the end, as before.
  r = inOrder('A[^1].\n\n[^1]: One.\n\nMore.', { add: 'A[^1].\n\n[^1]: One.\n\nMore.'.length });
  assert.equal(r.out, 'A[^1].\n\n[^1]: One.\n\nMore.[^2]\n\n[^2]: ');
  assert.equal(r.caret, r.out.length);
});

test('§31 notes in order: random texts (notes at the end or not, labels of every kind, Add footnote)', () => {
  let seed = 20261004;
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const pick = (a) => a[rnd(a.length)];
  const LABELS = ['1', '2', '3', '4', '5', '10', '07', 'x', 'note', 'a'];
  const word = () => pick(['the', 'keeper', 'lamp', 'storm', 'ledger', 'green', 'steps', 'night', 'sea']);
  const sentence = () => {
    let s = '';
    for (let i = 0, n = 2 + rnd(5); i < n; i++) s += `${i ? ' ' : ''}${word()}${rnd(4) ? '' : `[^${pick(LABELS)}]`}`;
    return `${s}.${rnd(6) ? '' : ' `[^2]` stays.'}`;
  };
  const note = () => {
    let s = `[^${pick(LABELS)}]: ${sentence()}`;
    if (!rnd(3)) s += `\n  ${sentence()}`;
    if (!rnd(5)) s += `\n\n  ${sentence()}`;
    return s;
  };
  // Text skeleton: labels blanked, so what isn't a label can be compared.
  const skeleton = (t) => {
    const f = footnotes(t);
    const marks = f.refs.map((r) => [r.from + 2, r.to - 1]).concat(f.blocks.map((b) => [t.indexOf('[^', b.start) + 2, t.indexOf(']', t.indexOf('[^', b.start))])).sort((x, y) => y[0] - x[0]);
    for (const [a, b] of marks) t = t.slice(0, a) + '#' + t.slice(b);
    return t;
  };
  const stats = { atEnd: 0, moved: 0, added: 0 };
  for (let k = 0; k < 1500; k++) {
    const body = Array.from({ length: 1 + rnd(3) }, sentence).join(rnd(2) ? ' ' : '\n\n');
    const notes = Array.from({ length: rnd(6) }, note);
    let text = body;
    const shape = rnd(4);
    notes.forEach((n, i) => {
      text += i ? pick(['\n', '\n\n', '\n  \n']) : '\n\n';
      if (shape === 0 && i && !rnd(3)) text += `${sentence()}\n\n`; // notes not at the end
      text += n;
    });
    if (shape === 1 && notes.length) text += `\n\n${sentence()}`;
    if (rnd(3) === 0) text += '\n';
    const before = footnotes(text);
    const opts = rnd(3) ? undefined : { add: rnd(text.length + 1) };
    const r = inOrder(text, opts);
    const after = footnotes(r.out);
    // Labels: a listed note's number when it's a number; other labels as they were.
    for (const [l, n] of after.order) if (/^\d{1,6}$/.test(l)) assert.equal(l, String(n), `${JSON.stringify(text)} -> ${JSON.stringify(r.out)}`);
    const named = (f) => [...new Set(f.refs.map((x) => x.label).concat(f.blocks.map((b) => b.label)))].filter((l) => !/^\d+$/.test(l)).sort();
    assert.deepEqual(named(after), named(before));
    // The notes are the same notes; the rest of the text is the same text.
    assert.equal(after.blocks.length, before.blocks.length + (opts ? 1 : 0));
    if (!opts) {
      const sk = (t, f) => [skeleton(t.slice(0, f.blocks.length ? f.blocks[0].start : t.length)), f.blocks.map((b) => skeleton(t.slice(b.start, b.end))).sort()];
      assert.deepEqual(sk(r.out, after), sk(text, before), JSON.stringify(text));
    } else {
      assert.equal(after.defs.has(r.out.slice(r.out.lastIndexOf('[^', r.caret) + 2, r.out.lastIndexOf(']', r.caret))), true, 'the caret is in the new note');
    }
    // Notes at the end: listed in order, then the notes nobody refers to.
    const atEnd = after.blocks.length > 0 && after.blocks.every((b, i) => !/\S/.test(r.out.slice(b.end, i + 1 < after.blocks.length ? after.blocks[i + 1].start : r.out.length)));
    if (atEnd) {
      const nums = listedNumbers(r.out).map((x) => (typeof x === 'number' ? x : Infinity));
      assert.deepEqual(nums, [...nums].sort((x, y) => x - y), JSON.stringify(r.out));
      assert.equal(notesOutOfOrder(r.out, after), -1);
      stats.atEnd++;
    }
    if (r.ops.some((o) => o.source === 'move')) stats.moved++;
    if (opts) stats.added++;
  }
  assert.ok(stats.atEnd > 300 && stats.moved > 200 && stats.added > 300, JSON.stringify(stats));
});

// ---------------------------------------------------------------- the scorer's view of it
// The editor sends a renumber as orderFootnotes' ops, each { at, ...op } (editor.js OpPlan): the
// labels typed in place, each moved note as two ops with source 'move'. Its undo sends replayOps'
// `back`. Here those exact ops go through the server (lib/party.js applyOps) next to the same
// writing without the renumber.
function writer() {
  const { party, clock } = makeParty();
  const host = addUser(party, 'host');
  party.start(host.id);
  const w = addUser(party, 'ana');
  const p = party.newPost(w.id, {});
  const body = () => party.state.posts[p.id].body;
  let seq = 0;
  const send = (ops) => {
    const post = party.state.posts[p.id];
    const at = clock.now();
    party.applyOps(w.id, { postId: p.id, pane: 'body', baseVersion: post.ver.body, baseLen: post.body.length, seq: `s${++seq}`, sentAt: at, ops: ops.map((o) => ({ at, ...o })) });
  };
  const typeAt = (pos, s) => {
    for (const ch of s) {
      send([{ pos: pos++, del: 0, ins: ch }]);
      clock.advance(160);
    }
  };
  return { party, clock, host, w, p, body, send, typeAt };
}
function story({ renumber, ageMin, retype = false, undo = false, cutLater = false, thenMin = 0.5 }) {
  const x = writer();
  const { clock, body, send, typeAt } = x;
  typeInto(x.party, clock, x.w, x.p, LIVE, { cps: 6 });
  clock.advance(ageMin * MIN);
  // Words of the note that moves, typed elsewhere a few minutes before.
  if (retype) {
    typeAt(body().indexOf('\n\n[^1]:'), ' The window, the lamp, the storm.');
    clock.advance(3 * MIN);
  }
  let plan = null;
  let ordered = null;
  if (renumber) {
    const before = body();
    plan = orderFootnotes(before);
    send(plan.ops);
    ordered = body();
    if (undo) {
      clock.advance(20 * SEC);
      send(replayOps(before, plan.ops).back);
      assert.equal(body(), before, 'undone');
    }
  }
  clock.advance(thenMin * MIN);
  typeAt(body().indexOf('.\n\n[^') + 1, ' Then the fog came in and the bell rang twice.');
  if (cutLater) {
    // The storm note, wherever it is now, cut 12 minutes later.
    clock.advance(12 * MIN);
    const t = body();
    const at = t.indexOf(': The storm broke');
    const from = t.lastIndexOf('\n', at);
    const to = t.indexOf('\n', at) < 0 ? t.length : t.indexOf('\n', at);
    send([{ pos: from, del: to - from, ins: '' }]);
  }
  clock.advance(5 * MIN);
  return { ...x, plan, ordered, res: x.party.engine.result(x.w.id, clock.now()) };
}
// Everything scoring decides. Two tallies of words that never count are left out: label digits
// typed in place settle as "markup", and replacing a digit still settling is a "quick change".
function decided({ party, host, w, p, res }) {
  const nc = (x) => ({ ...x, markup: 0, quick: 0 });
  return {
    hours: res.hours.map((h) => ({ ...h, notCounted: nc(h.notCounted) })),
    totals: { ...res.totals, notCounted: nc(res.totals.notCounted) },
    pending: res.pending,
    pastes: party.hostWriter(host.id, w.id).pastes,
    evidence: res.hours.map((h) => party.hourEvidence(w, h)),
    unconfirmed: party.engine.unconfirmedWords(w.id, p.id, 'b'),
    words: party.state.posts[p.id].words,
  };
}

test('§31 scorer: a renumber that moves notes changes no credit, cut, clawback, flag or paste', () => {
  for (const [name, opts] of [
    ['written 20 minutes before (cutting them would earn)', { ageMin: 20 }],
    ['written 2 minutes before (deleting them would count as discarded)', { ageMin: 2 }],
    ['still settling (typed seconds before; more text once they have settled)', { ageMin: 0.2, thenMin: 2 }],
    ['their words typed elsewhere minutes before', { ageMin: 20, retype: true }],
    ['the moved note cut 12 minutes later', { ageMin: 20, cutLater: true }],
    ['renumbered, then undone', { ageMin: 20, undo: true }],
  ]) {
    const base = story({ ...opts, renumber: false });
    const moved = story({ ...opts, renumber: true });
    assert.ok(moved.plan.ops.some((o) => o.source === 'move'), name);
    assert.ok(moved.party.state.ops[moved.w.id].some((o) => o[6] && o[6].s === 'move'), `${name}: the server keeps them as moves`);
    assert.deepEqual(listedNumbers(moved.ordered), [1, 2, 3], name);
    assert.ok(base.res.totals.credit > 30, name);
    assert.deepEqual(decided(moved), decided(base), name);
    // Those two: at most half a word of markup and a "quick" 1/5.5 per one-digit label replaced.
    const relabels = moved.plan.ops.filter((o) => !o.source && /^\d$/.test(o.ins)).length * (opts.undo ? 2 : 1);
    const more = (k) => moved.res.totals.notCounted[k] - base.res.totals.notCounted[k];
    assert.ok(more('markup') >= 0 && more('markup') <= relabels / 2, `${name}: markup ${more('markup')}`);
    assert.ok(more('quick') >= 0 && more('quick') <= relabels / 5.5 + 0.01, `${name}: quick ${more('quick')}`);
  }
});

test('§31 scorer: "move" ops can\'t earn: an insert no delete follows never counts; a lone delete is a delete', () => {
  const run = (extra) => {
    const x = writer();
    typeInto(x.party, x.clock, x.w, x.p, 'The keeper counted the steps every evening and wrote the number down in the ledger.', { cps: 6 });
    x.clock.advance(20 * MIN);
    extra(x);
    x.clock.advance(5 * MIN);
    return x.party.engine.result(x.w.id, x.clock.now()).totals;
  };
  const base = run(() => {});
  // Inserted as moved, with nothing deleted after it: inert text (no credit, no flags).
  const lone = run((x) => x.send([{ pos: x.body().length, del: 0, ins: ' Twelve brand new words arrive here as if they had been moved from elsewhere.', source: 'move' }]));
  assert.equal(lone.credit, base.credit);
  assert.deepEqual(lone.notCounted, base.notCounted);
  // The same text deleted, but not by the next op: still inert.
  const later = run((x) => {
    x.send([{ pos: x.body().length, del: 0, ins: ' every evening', source: 'move' }]);
    x.send([{ pos: 0, del: 0, ins: 'Yes. ' }]);
    x.send([{ pos: x.body().indexOf(' every evening'), del: 14, ins: '', source: 'move' }]);
  });
  assert.equal(later.credit, run((x) => {
    x.send([{ pos: 0, del: 0, ins: 'Yes. ' }]);
    x.send([{ pos: x.body().indexOf(' every evening'), del: 14, ins: '' }]);
  }).credit, 'the delete is an ordinary one');
  // A delete marked as a move with no move before it: an ordinary delete (cut credit and all).
  const cutMarked = run((x) => x.send([{ pos: 0, del: 30, ins: '', source: 'move' }]));
  const cutTyped = run((x) => x.send([{ pos: 0, del: 30, ins: '' }]));
  assert.deepEqual(cutMarked, cutTyped);
  assert.ok(cutTyped.cut > 0);
});

test('§31 scorer: a move\'s seams hide no repeat (dummy moves all through a retyped sentence)', () => {
  const S = 'The keeper counted the steps every evening and wrote the number down in a ledger with a green spine.';
  const run = (dummies, backwards = false) => {
    const ops = [];
    let t = 0;
    let text = '';
    const op = (pos, del, ins, source = 'type') => {
      ops.push({ t, post: 'p', pane: 'body', pos, del, ins, source });
      text = text.slice(0, pos) + ins + text.slice(pos + del);
    };
    const type = (s, pos = text.length) => {
      for (const ch of s) {
        op(pos++, 0, ch);
        t += 170;
      }
    };
    type(S);
    t += 20 * MIN;
    // The same sentence again, then spaces moved from the end into it every two words: seams.
    type(` ${S}${' '.repeat(12)}`);
    if (dummies) {
      const at = text.indexOf(S, 1);
      const gaps = [];
      for (let i = 0, k = 0; i < S.length; i++) if (S[i] === ' ' && ++k % 2 === 0) gaps.push(at + i);
      let shift = 0;
      for (const g of backwards ? gaps : gaps.reverse()) {
        op(g + shift, 0, ' ', 'move');
        op(text.length - 1, 1, '', 'move');
        if (backwards) shift++;
      }
      assert.equal(text.replace(/\s+/g, ' ').trim(), `${S} ${S}`, 'only spaces moved');
    }
    t += 3 * MIN;
    return score(ops, {}, { joinedAt: 0, now: t }).hours[0];
  };
  const plain = run(false);
  assert.ok(plain.notCounted.repeat >= 18, 'the sentence typed again is a repeat');
  for (const backwards of [false, true]) {
    const r = run(true, backwards);
    assert.equal(r.credit, plain.credit);
    assert.equal(r.written, plain.written);
    assert.equal(r.notCounted.repeat, plain.notCounted.repeat);
  }
});

test('§31 scorer: moves score the same whenever the scorer settles (one pass, lockstep, incremental)', () => {
  // Notes written seconds before a renumber that moves them (still settling), then more writing.
  const ops = [];
  let t = 0;
  let text = '';
  const put = (o) => {
    ops.push({ t, post: 'p', pane: 'body', ...o });
    text = replayOps(text, [o]).text;
  };
  const type = (s, pos = text.length) => {
    for (const ch of s) {
      put({ pos: pos++, del: 0, ins: ch, source: 'type' });
      t += 150;
    }
  };
  type(LIVE);
  t += 15 * SEC;
  for (const o of orderFootnotes(text).ops) put({ source: 'type', ...o });
  t += 40 * SEC;
  type(' Then the fog came in.', text.indexOf('.\n\n[^') + 1);
  t += 50 * SEC;
  type(' And again.', text.indexOf('.\n\n[^') + 1);
  const now = t + 4 * MIN;
  const pick = (r) => r.hours.map((h) => ({ credit: h.credit, written: h.written, notCounted: h.notCounted, flags: h.flags }));
  const once = pick(score(ops, {}, { joinedAt: 0, now }));
  const lockstep = pick(scoreParty({ w: ops }, {}, { w: { joinedAt: 0 } }, now).w);
  const sc = createScorer({}, { joinedAt: 0 });
  ops.forEach((o, i) => {
    sc.apply(o);
    if (i % 7 === 0) sc.result(o.t + (i % 3) * SEC);
  });
  const incremental = pick(sc.result(now));
  assert.deepEqual(lockstep, once);
  assert.deepEqual(incremental, once);
  assert.ok(once[0].credit > 40);
});
