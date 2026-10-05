// Invisible and control characters: stripped before storage, positions kept consistent with the
// client, and no re-earning credit with zero-width or look-alike letters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeText, sanitizeWithMap, PhantomMap, remapMask } from '../lib/sanitize.js';
import { score, foldKey } from '../lib/score.js';
import { rawWords } from '../public/js/text.js';
import { makeParty, addUser } from './helpers.js';
import { MIN } from './sim.js';

test('sanitize: drops zero-width, bidi, soft hyphen and control characters; keeps real joiners', () => {
  assert.equal(sanitizeText('sap​phire mer‌id‍ian'), 'sapphire meridian');
  assert.equal(sanitizeText('‮evil‬ ⁦iso⁩ ⁠wj﻿'), 'evil iso wj');
  assert.equal(sanitizeText('soft­hyphen'), 'softhyphen');
  assert.equal(sanitizeText('a\r\nb\u0007c\u0085d\te\nf'), 'a\nbcd\te\nf');
  assert.equal(sanitizeText('lone \ud800 half'), 'lone  half');
  // Kept: emoji ZWJ sequences, the flag of England, Persian and Hindi joiners.
  const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
  const coder = '\u{1F469}\u{1F3FD}‍\u{1F4BB}';
  const heart = '❤️‍\u{1F525}';
  const england = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';
  const persian = 'می‌خواهم';
  const hindi = 'क्‍ष';
  for (const keep of [family, coder, heart, england, persian, hindi]) assert.equal(sanitizeText(keep), keep);
  // ...but a ZWJ between Latin letters goes.
  assert.equal(sanitizeText('a‍b'), 'ab');
  const m = sanitizeWithMap('x​y​z');
  assert.deepEqual(m, { text: 'xyz', removed: [1, 3] });
  assert.deepEqual(sanitizeWithMap('plain text'), { text: 'plain text', removed: null });
});

test('sanitize: client positions map onto the canonical text; paste masks follow the words', () => {
  const ph = new PhantomMap();
  // Client inserts "ab​cd" at 0: the server keeps "abcd"; the phantom sits at client index 2.
  ph.apply(0, 0, 5, [2]);
  assert.equal(ph.toCanonical(5), 4);
  assert.equal(ph.toCanonical(2), 2);
  assert.equal(ph.toCanonical(3), 2);
  // Client deletes [1, 4) ("b​c"): canonical [1, 3); the phantom goes with it.
  ph.apply(1, 3, 0, null);
  assert.equal(ph.size, 0);
  // A word mask for "one t﻿wo three" (U+FEFF splits raw words) carried over to "one two three".
  const raw = 'one t﻿wo three';
  assert.equal(rawWords(raw).length, 4);
  assert.equal(remapMask(raw, [5], '1111', rawWords), '111');
  assert.equal(remapMask(raw, [5], '1101', rawWords), '101', 'a word counts only if all of it was chosen');
});

test('ops: stripped inserts are stored clean, later ops in the batch land right, and the ack carries the text', () => {
  const { party } = makeParty();
  const host = addUser(party, 'host');
  party.start(host.id);
  const w = addUser(party, 'ana');
  const p = party.newPost(w.id, {});
  // The client's text after op 1 is "Hel​lo"; op 2 appends at client position 6.
  const r = party.applyOps(w.id, { postId: p.id, pane: 'body', baseVersion: 0, ops: [
    { pos: 0, del: 0, ins: 'Hel​lo' },
    { pos: 6, del: 0, ins: ' world' },
    { pos: 2, del: 3, ins: 'L' }, // replaces "l​l" (client positions 2..5)
  ] });
  assert.equal(party.state.posts[p.id].body, 'HeLo world');
  assert.deepEqual(r, { version: 1, sanitized: true, text: 'HeLo world' });
  // A clean batch gets the plain ack.
  assert.deepEqual(party.applyOps(w.id, { postId: p.id, pane: 'body', baseVersion: 1, ops: [{ pos: 10, del: 0, ins: '!' }] }), { version: 2 });
  // The op log replays to the same canonical text.
  assert.equal(party.engine.text(w.id, p.id, 'b'), 'HeLo world!');
  // Titles and names are cleaned the same way.
  party.updatePost(w.id, { id: p.id, title: 'T​it‮le' });
  assert.equal(party.state.posts[p.id].title, 'Title');
});

test('scorer: a sentence retyped with zero-width characters or look-alike letters is already written', () => {
  const S = { settleSec: 2, settleQuantumSec: 1 };
  const sent = 'sapphire meridian voyage clarion tessellate umbral quiver nostrum perihelion gavotte brindle thornfield ';
  const ops = [];
  let pos = 0;
  let t = 0;
  const put = (ins) => {
    ops.push({ t, post: 'p', pane: 'body', pos, del: 0, ins, source: 'type' });
    pos += ins.length;
    t += 9000;
  };
  put(sent);
  put(sent.replace(/(\w)(\w)/g, '$1​$2')); // old logs could hold these: one token per word still
  put(sent.replace(/a/g, 'а').replace(/o/g, 'ο').replace(/e/g, 'е')); // Cyrillic а е, Greek ο
  const r = score(ops, S, { joinedAt: 0, now: t + MIN });
  const words = sent.trim().split(' ').length;
  assert.ok(r.totals.written <= words + 1, `written ${r.totals.written} for ${words} distinct words`);
  assert.ok(r.totals.notCounted.repeat >= 2 * words - 2, `repeat ${r.totals.notCounted.repeat}`);
  assert.equal(foldKey('mеridiаn'), 'meridian');
  assert.equal(foldKey('plain'), 'plain');
});
