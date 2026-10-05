// Image descriptions count (SPEC §14b): an image's alt text counts like any other words, its
// address never does; a description typed in the "Describe the image" form arrives as typing
// (one op per keystroke at the description's place in the text, as richtext.js sends it) and a
// pasted one as a paste. Also: the Markdown scan stays linear on hostile lines, and an image with
// no description isn't a word in the post's word count.
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { score, markupSpans, inSpans } from '../lib/score.js';
import { wordDelta } from '../lib/party.js';
import { countWords } from '../public/js/text.js';
import { makeParty, addUser } from './helpers.js';

const SEC = 1000;
const MIN = 60 * SEC;
const IMG = '![](/u/3f9c2a7b0d4e5f6a7b8c9d0e1f2a3b4c.webp#w=1600&h=1067)';
const ALT = 'The lighthouse keeper waving from the gallery at dusk tonight'; // 10 words, none one letter
const PROSE = 'Every evening the keeper climbed the hundred steps and counted them aloud, because the counting was the only conversation he had left.';

// Scorer-level ops: { t, post, pane, pos, del, ins, source, confirm }.
class Ops {
  constructor() {
    this.t = 0;
    this.text = '';
    this.list = [];
  }
  op(pos, del, ins, source = 'type', extra = {}) {
    this.list.push({ t: this.t, post: 'p', pane: 'body', pos, del, ins, source, ...extra });
    this.text = this.text.slice(0, pos) + ins + this.text.slice(pos + del);
    return this;
  }
  wait(ms) {
    this.t += ms;
    return this;
  }
  // Human typing: a key every 110-260 ms, a longer pause between some words.
  type(str, pos = this.text.length) {
    let i = 0;
    for (const ch of str) {
      this.op(pos++, 0, ch);
      this.t += 110 + ((i * 37) % 150) + (ch === ' ' && i % 3 === 0 ? 600 : 0);
      i++;
    }
    return this;
  }
}
const altPos = (text, nth = 0) => {
  let i = -1;
  for (let k = 0; k <= nth; k++) i = text.indexOf('![', i + 1);
  return i + 2;
};

test('§14b markupSpans: image descriptions are words, image and link addresses are not', () => {
  const line = `Look: ![a grey cat asleep](/u/abc123.webp#w=10&h=20) and [the essay](https://example.com/x) or https://example.org/y.`;
  const spans = markupSpans(line);
  const words = (s) => [...line.matchAll(/[\p{L}\p{N}]+/gu)].filter((m) => s(inSpans(spans, m.index, m.index + m[0].length))).map((m) => m[0]);
  assert.deepEqual(words((x) => !x), ['Look', 'a', 'grey', 'cat', 'asleep', 'and', 'the', 'essay', 'or']);
  assert.deepEqual(words((x) => x), ['u', 'abc123', 'webp', 'w', '10', 'h', '20', 'https', 'example', 'com', 'x', 'https', 'example', 'org', 'y']);
  // Sorted and merged.
  for (let i = 1; i < spans.length; i++) assert.ok(spans[i][0] > spans[i - 1][1]);
});

test('§14b markupSpans stays linear on hostile lines (30k+ characters, under 20 ms)', () => {
  const lines = {
    'repeated ![a': '![a'.repeat(11000),
    'repeated ![': '!['.repeat(16000),
    'repeated ](': ']('.repeat(16000),
    'repeated ](x ': '](x '.repeat(8000),
    'repeated http://': 'http://'.repeat(5000),
    'repeated www.': 'www.'.repeat(8000),
    'repeated [x](': '[x]('.repeat(8000),
  };
  for (const [name, line] of Object.entries(lines)) {
    assert.ok(line.length >= 30000, name);
    let best = Infinity;
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      markupSpans(line);
      best = Math.min(best, performance.now() - t0);
    }
    assert.ok(best < 20, `${name}: ${best.toFixed(1)} ms`);
  }
  // Scoring a post holding such a line stays quick too (each token looks up its span).
  const o = new Ops().op(0, 0, '![a '.repeat(8000), 'type');
  const t0 = performance.now();
  score(o.list, {}, { joinedAt: 0, now: 3 * MIN });
  assert.ok(performance.now() - t0 < 2000, `score: ${(performance.now() - t0).toFixed(0)} ms`);
});

test('§14b a 10-word description typed in the form counts 10 once settled, with no review flag', () => {
  const o = new Ops();
  o.type(`${PROSE} `);
  // The image goes in as a paragraph of its own (one op, as the editor inserts it)...
  o.wait(4 * SEC).op(o.text.length, 0, `\n\n${IMG}`);
  const base = score(o.list, {}, { joinedAt: 0, now: o.t + 2 * MIN }).hours[0];
  // ...then the writer describes it: one op per keystroke at the description's place.
  o.wait(6 * SEC).type(ALT, altPos(o.text));
  assert.ok(o.text.endsWith(`![${ALT}](/u/3f9c2a7b0d4e5f6a7b8c9d0e1f2a3b4c.webp#w=1600&h=1067)`));
  // Not before it has settled...
  const early = score(o.list, {}, { joinedAt: 0, now: o.t + 10 * SEC }).hours[0];
  assert.ok(early.written - base.written < 10);
  // ...then all ten words, as written (typed) words, and nothing for the address.
  const r = score(o.list, {}, { joinedAt: 0, now: o.t + 2 * MIN }).hours[0];
  assert.equal(r.written - base.written, 10);
  assert.equal(r.pasted, 0);
  assert.deepEqual(r.flags.map((f) => f.type), []);
  assert.equal(r.notCounted.overSpeed, 0);
});

test('§14b a pasted description follows the paste rules', () => {
  const setup = () => {
    const o = new Ops();
    o.type(`${PROSE} `).wait(4 * SEC).op(o.text.length, 0, `\n\n${IMG}`).wait(5 * SEC);
    return o;
  };
  // A short paste (12 words or fewer) counts like typing, as pasted words.
  let o = setup();
  o.op(altPos(o.text), 0, ALT, 'paste', { confirm: 'none' });
  let r = score(o.list, {}, { joinedAt: 0, now: o.t + 2 * MIN }).hours[0];
  assert.equal(r.pasted, 10);
  assert.equal(r.written, score(setup().list, {}, { joinedAt: 0, now: o.t + 2 * MIN }).hours[0].written);
  // A longer one counts only the words the writer confirmed.
  const long = 'A wide grey harbour at dusk with three fishing boats tied up along the old stone wall and gulls on every post';
  o = setup();
  o.op(altPos(o.text), 0, long, 'paste', { confirm: 'none' });
  r = score(o.list, {}, { joinedAt: 0, now: o.t + 2 * MIN }).hours[0];
  assert.equal(r.pasted, 0);
  assert.ok(r.notCounted.unconfirmedPaste > 0);
  o = setup();
  o.op(altPos(o.text), 0, long, 'paste', { confirm: 'all' });
  r = score(o.list, {}, { joinedAt: 0, now: o.t + 2 * MIN }).hours[0];
  assert.ok(r.pasted > 20, String(r.pasted));
});

// Through the party, with the ops exactly as the editor sends them.
function partyWithPost() {
  const { party, clock } = makeParty({ settings: { hourLengthMin: 60, targetPerHour: 50 } });
  const host = addUser(party, 'host');
  party.start(host.id);
  const w = addUser(party, 'ana');
  party.join(w.id);
  const p = party.newPost(w.id, { title: 'The ledger' });
  let seq = 0;
  const send = (ops) => {
    const post = party.state.posts[p.id];
    party.applyOps(w.id, { postId: p.id, pane: 'body', baseVersion: post.ver.body, seq: `s${++seq}`, sentAt: clock.now(), ops });
  };
  // Typing: one op per key, sent in batches like the editor's sync (every ~5 keys here).
  const type = (str, pos = party.state.posts[p.id].body.length) => {
    let batch = [];
    let i = 0;
    for (const ch of str) {
      batch.push({ at: clock.now(), pos: pos++, del: 0, ins: ch });
      clock.advance(120 + ((i * 41) % 140));
      if (batch.length === 5) {
        send(batch);
        batch = [];
      }
      i++;
    }
    if (batch.length) send(batch);
  };
  const body = () => party.state.posts[p.id].body;
  const hour = () => party.progressOf(w.id, { fresh: true }).prog.hours[0];
  return { party, clock, w, p, send, type, body, hour };
}

test('§14b party: a description typed in the form is credited as typing, words and all', () => {
  const s = partyWithPost();
  s.type(`${PROSE} `);
  s.clock.advance(4 * SEC);
  s.send([{ at: s.clock.now(), pos: s.body().length, del: 0, ins: `\n\n${IMG}` }]);
  assert.equal(countWords(s.body()), countWords(PROSE), 'an image with no description adds no word to the post');
  assert.equal(s.party.state.posts[s.p.id].words, countWords(PROSE));
  s.clock.advance(2 * MIN);
  const before = s.hour();
  s.type(ALT, altPos(s.body()));
  s.clock.advance(2 * MIN);
  const h = s.hour();
  assert.equal(h.written - before.written, 10);
  assert.equal(h.pasted, 0);
  assert.deepEqual(h.flags.map((f) => f.type), []);
  assert.notEqual(h.status, 'review');
  // The post's word count (and the live page's "words today") includes the description.
  assert.equal(s.party.state.posts[s.p.id].words, countWords(PROSE) + 10);
  assert.equal(countWords(s.body()), countWords(PROSE) + 10);
});

test('§14b party: a pasted description is a paste (asked about, own words never twice)', () => {
  const s = partyWithPost();
  s.type(`${PROSE} `);
  s.clock.advance(4 * SEC);
  s.send([{ at: s.clock.now(), pos: s.body().length, del: 0, ins: `\n\n${IMG}\n\n${IMG}\n\n${IMG}` }]);
  s.clock.advance(5 * SEC);
  // A short paste (no question asked): counts like typing, but as pasted words.
  const zeros = (t) => '0'.repeat(t.split(/\s+/).filter(Boolean).length);
  s.send([{ at: s.clock.now(), pos: altPos(s.body(), 0), del: 0, ins: ALT, paste: { m: zeros(ALT), d: 'short' } }]);
  s.clock.advance(2 * MIN);
  let h = s.hour();
  assert.equal(h.pasted, 10);
  // The same words pasted into the next image: already written, nothing more.
  s.send([{ at: s.clock.now(), pos: altPos(s.body(), 1), del: 0, ins: ALT, paste: { m: zeros(ALT), d: 'short' } }]);
  s.clock.advance(2 * MIN);
  h = s.hour();
  assert.equal(h.pasted, 10);
  // A long description the writer said they didn't write today: nothing.
  const long = 'A wide grey harbour at dusk with three fishing boats tied up along the old stone wall and gulls on every post';
  s.send([{ at: s.clock.now(), pos: altPos(s.body(), 2), del: 0, ins: long, paste: { m: zeros(long), d: 'no' } }]);
  s.clock.advance(2 * MIN);
  h = s.hour();
  assert.equal(h.pasted, 10);
  assert.ok(h.notCounted.unconfirmedPaste > 0);
});

test('§14b word counts: descriptions count, an image with none is no word, deltas match full recounts', () => {
  assert.equal(countWords(IMG), 0);
  assert.equal(countWords(`![](/u/x.webp)`), 0);
  assert.equal(countWords(`![${ALT}](/u/x.webp#w=1&h=2)`), 10);
  assert.equal(countWords(`![Gull](/u/x.webp)`), 1);
  assert.equal(countWords(`word${IMG}`), 1, 'a word glued to an image still counts');
  assert.equal(countWords(`${IMG}word`), 1);
  assert.equal(countWords(`${IMG}.`), 0);
  assert.equal(countWords('[the essay](https://example.com/x)'), 2, 'link text counts');
  // Random edits around images and links: the delta around each edit equals the full recount.
  let text = `Start ${IMG} middle ![a cat](/u/k.webp) [link](https://x.y/z) end.\n\n${IMG}\n`;
  let seed = 7;
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const bits = [' ', 'a', '!', '[', ']', '(', ')', '![](/u/q.webp)', 'word ', '\n', '](', '![', 'x'];
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
