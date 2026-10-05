// Counting the words around an edit looks at most WORD_SCAN_MAX characters each way (text.js
// wordSpan): a pane that is one huge "word" can't make every op scan all of it. A 450,000-character
// post with no whitespace and one batch of 2,000 one-character deletes used to stall the server
// for 30 s. Real text counts exactly as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeParty, addUser } from './helpers.js';
import { PARAGRAPHS } from './sim.js';
import { wordDelta } from '../lib/party.js';
import { countWords, wordsRemoved, wordSpan, WORD_SCAN_MAX } from '../public/js/text.js';

// The counts as they were, scanning to the nearest whitespace however far it is.
function wholeSpan(text, from, to) {
  let a = from;
  while (a > 0 && !/\s/.test(text[a - 1])) a--;
  let b = to;
  while (b < text.length && !/\s/.test(text[b])) b++;
  return [a, b];
}
const refDelta = (text, pos, del, ins) => {
  const [a, b] = wholeSpan(text, pos, pos + del);
  return countWords(text.slice(a, pos) + ins + text.slice(pos + del, b)) - countWords(text.slice(a, b));
};
const refRemoved = (text, pos, del) => {
  if (!(del > 0)) return 0;
  const [a, b] = wholeSpan(text, pos, pos + del);
  return countWords(text.slice(a, b)) - countWords(text.slice(a, pos) + text.slice(pos + del, b));
};

test('one batch of 2,000 one-character deletes in a 450,000-character post with no whitespace: the scans stay short', (t) => {
  const huge = 'a'.repeat(450_000);
  // The scans alone: what used to walk the whole post for every op.
  let t0 = performance.now();
  let sum = 0;
  for (let i = 0; i < 2000; i++) {
    const pos = 1000 + i * 200;
    sum += wordDelta(huge, pos, 1, '') + wordsRemoved(huge, pos, 1);
    const [a, b] = wordSpan(huge, pos, pos + 1);
    assert.ok(pos - a <= WORD_SCAN_MAX && b - pos - 1 <= WORD_SCAN_MAX);
  }
  const scans = performance.now() - t0;
  assert.equal(sum, 0, 'a character out of one long word changes no count');
  t.diagnostic(`2,000 × wordDelta + wordsRemoved on the long word: ${scans.toFixed(1)} ms`);
  assert.ok(scans < 300, `the scans took ${scans.toFixed(0)} ms (they took about 30 s before)`);

  // Through the server, after the end (every op there is scanned twice: the post's word count and
  // the 50-word rule). What's left, about half a second here, is what any batch this size costs
  // on a post this long (each op rebuilds the text), whatever the text.
  const { party, clock } = makeParty({ settings: { hourLengthMin: 60, targetPerHour: 20 } });
  const host = addUser(party, 'host');
  party.start(host.id);
  const w = addUser(party, 'wren');
  party.join(w.id);
  const p = party.newPost(w.id, { title: 'One long word' });
  party.end(host.id);
  for (let at = 0; at < huge.length; at += 225_000) party.applyOps(w.id, { postId: p.id, pane: 'body', baseVersion: p.ver.body, ops: [{ pos: at, del: 0, ins: huge.slice(at, at + 225_000) }] });
  clock.advance(1000);
  t0 = performance.now();
  party.applyOps(w.id, { postId: p.id, pane: 'body', baseVersion: p.ver.body, ops: Array.from({ length: 2000 }, (_, i) => ({ pos: 1000 + i * 200, del: 1, ins: '' })) });
  const long = performance.now() - t0;
  t.diagnostic(`the batch through the server: ${long.toFixed(0)} ms`);
  assert.equal(p.body.length, 448_000);
  assert.equal(p.words, 1);
  assert.ok(long < 3000, `the batch took ${long.toFixed(0)} ms (about 31 s before)`);
});

test('real text counts exactly as before: word counts and the 50-word rule over thousands of random edits', () => {
  // A seeded stream of edits on real prose: typing, backspacing, words and sentences replaced,
  // paragraphs and whole selections deleted, pastes; every count against the unlimited scan.
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const source = PARAGRAPHS.join('\n\n');
  let text = source.repeat(3);
  let words = countWords(text);
  let checked = 0;
  for (let i = 0; i < 6000; i++) {
    const r = rnd();
    let pos;
    let del;
    let ins;
    if (r < 0.35) { // typing a character
      pos = int(0, text.length);
      del = 0;
      ins = source[int(0, source.length - 1)];
    } else if (r < 0.55) { // backspace
      pos = int(1, text.length) - 1;
      del = 1;
      ins = '';
    } else if (r < 0.7) { // a word or two replaced (autocorrect, a fix)
      pos = int(0, text.length);
      del = Math.min(int(1, 15), text.length - pos);
      ins = source.slice(int(0, source.length - 30)).slice(0, int(0, 25));
    } else if (r < 0.85) { // a selection deleted: a phrase to a paragraph or more
      pos = int(0, text.length);
      del = Math.min(int(20, 1500), text.length - pos);
      ins = '';
    } else { // a paste, sometimes over a selection
      pos = int(0, text.length);
      del = rnd() < 0.5 ? Math.min(int(0, 600), text.length - pos) : 0;
      const from = int(0, source.length - 1);
      ins = source.slice(from, from + int(1, 900));
    }
    const d = wordDelta(text, pos, del, ins);
    assert.equal(d, refDelta(text, pos, del, ins), `op ${i}: the word count`);
    assert.equal(wordsRemoved(text, pos, del), refRemoved(text, pos, del), `op ${i}: the words it removes`);
    text = text.slice(0, pos) + ins + text.slice(pos + del);
    words += d;
    checked++;
    if (text.length < 2000) { // cut down to little: more prose
      text += `\n\n${source}`;
      words = countWords(text);
    }
  }
  assert.equal(checked, 6000);
  assert.equal(words, countWords(text), 'kept by deltas, the count matches a full count');
});

test('a word longer than the scan still counts as one word, edited inside or cut whole', () => {
  const long = `start ${'x'.repeat(1000)} end`;
  const mid = 6 + 500;
  assert.equal(wordDelta(long, mid, 1, ''), 0, 'a letter out of it');
  assert.equal(wordDelta(long, mid, 0, 'y'), 0, 'a letter into it');
  assert.equal(wordDelta(long, mid, 0, ' '), 1, 'split in two');
  assert.equal(wordsRemoved(long, 6, 1000), 1, 'cut whole');
  assert.equal(wordsRemoved(long, 0, long.length), 3);
  assert.equal(countWords(long), 3);
});
