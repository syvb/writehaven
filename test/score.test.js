// Tests for lib/score.js, "settled new words" (SPEC §11), with its paste rules (SPEC §12).
// Self-contained: a tiny editor simulator below produces op logs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { score, createScorer, scoreParty, createParty, DEFAULT_SETTINGS, textFeatures, classifyBlock } from '../lib/score.js';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

const PROSE = [
  'Most of the walking I do in a city is not really walking. It is a way of getting from one appointment to the next while my mind stays somewhere else.',
  'I started keeping a notebook because I kept losing small ideas. They would arrive on the bus or in the shower, feel enormous for a minute, and then dissolve before I could use them.',
  'There is something honest about trains. A plane pretends that the distance does not exist, and a car makes you fight for every mile of it.',
  'Learning a language as an adult is mostly an exercise in tolerating embarrassment. You say the wrong word for butter in a shop, the shopkeeper smiles, and you carry that smile home like a small bruise.',
  'Attention behaves like money in one important way: it is easy to spend without noticing. A minute here, a notification there, and by evening the account is empty.',
  'Cooking for friends is the opposite of cooking for a restaurant. Nobody cares if the sauce is perfect. They care that the kitchen is warm and that the bread arrives before they get hungry.',
  'Old maps are wonderful precisely because they are wrong. Rivers bend in places they never bent, islands appear where there is only water, and the edges fill with guesses.',
  'My grandmother kept every photograph, even the blurry ones. When I asked her why, she said that a bad picture of a good afternoon was still better than a perfect memory of nothing.',
];
const wordsOf = (s) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
// Expected credit of a text under the word unit: 1 per word, 0.5 per one-letter word.
const value = (s) => wordsOf(s).reduce((a, w) => a + (w.replace(/[^\p{L}\p{N}]/gu, '').length === 1 ? 0.5 : 1), 0);

class Ed {
  constructor({ t0 = 0, post = 'p', pane = 'body' } = {}) {
    this.t = t0;
    this.post = post;
    this.pane = pane;
    this.docs = new Map();
    this.ops = [];
  }
  get key() {
    return `${this.post}|${this.pane}`;
  }
  get text() {
    return this.docs.get(this.key) || '';
  }
  use(post, pane = 'body') {
    this.post = post;
    this.pane = pane;
    return this;
  }
  wait(ms) {
    this.t += ms;
    return this;
  }
  op(pos, del, ins, source = 'type', extra = {}) {
    const s = this.text;
    assert.ok(pos >= 0 && pos + del <= s.length, 'op in range');
    this.ops.push({ t: this.t, post: this.post, pane: this.pane, pos, del, ins, source, ...extra });
    this.docs.set(this.key, s.slice(0, pos) + ins + s.slice(pos + del));
    return this;
  }
  // type at `pos` (default: end), one op per char, `cps` chars per second
  type(str, { pos = this.text.length, cps = 6, source = 'type' } = {}) {
    for (const ch of str) {
      this.op(pos++, 0, ch, source);
      this.t += 1000 / cps;
    }
    return this;
  }
  backspace(n, { cps = 8 } = {}) {
    for (let i = 0; i < n; i++) {
      this.op(this.text.length - 1, 1, '');
      this.t += 1000 / cps;
    }
    return this;
  }
  del(pos, n) {
    return this.op(pos, n, '');
  }
  paste(pos, str, confirm = 'all') {
    return this.op(pos, 0, str, 'paste', { confirm });
  }
  // Prose typed in bursts with human pauses (a pause >= 2 s every ~8 words).
  write(text, { cps = 6 } = {}) {
    const words = text.split(' ');
    for (let i = 0; i < words.length; i++) {
      this.type(words[i] + (i < words.length - 1 ? ' ' : ''), { cps });
      if (i % 8 === 7) this.wait(2500);
    }
    return this.type(' ', { cps });
  }
}
const run = (ed, settings = {}, ctx = {}) => score(ed.ops, settings, { joinedAt: 0, ...ctx });
const close = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('plain typing counts one per word once it has stayed 90 s', () => {
  const ed = new Ed().write(PROSE[0]);
  const r = run(ed);
  close(r.hours[0].written, value(PROSE[0]));
  // before 90 s nothing is final yet: it is pending
  const early = score(ed.ops, {}, { joinedAt: 0, now: ed.t + 10 * SEC });
  assert.ok(early.pending > 0);
  assert.ok(early.hours[0].credit < value(PROSE[0]));
});

test('typos fixed while typing cost nothing and earn nothing', () => {
  const ed = new Ed();
  ed.type('Most of the wakl').backspace(2).type('lking I do in a city is not really walking. ');
  close(run(ed).hours[0].written, value('Most of the walking I do in a city is not really walking.'));
});

test('A, backspace, A, backspace ... earns nothing', () => {
  const ed = new Ed();
  for (let i = 0; i < 3000; i++) ed.type('a').backspace(1);
  const r = run(ed);
  assert.equal(r.hours[0].credit, 0);
});

test('autocorrect, predictive text and Android-style composition count as normal typing', () => {
  const ed = new Ed();
  const words = 'Learning a language as an adult is mostly an exercise in tolerating embarrassment.'.split(' ');
  for (const w of words) {
    const start = ed.text.length;
    if (w === 'exercise') {
      // typed with a typo, then autocorrect replaces the whole word on space
      ed.op(start, 0, 'exercsie', 'ime').wait(300).op(start, 8, 'exercise ', 'autocorrect');
    } else if (w.length > 5) {
      // composition: every key rewrites the composing word, then a predictive tap finishes it
      let cur = '';
      for (const ch of w.slice(0, 3)) {
        ed.op(start, cur.length, cur + ch, 'ime').wait(250);
        cur += ch;
      }
      ed.op(start, cur.length, w + ' ', 'autocorrect').wait(400);
    } else if (w === 'a') {
      ed.op(start, 0, 'a', 'ime').wait(200).op(start + 1, 0, ' ').wait(300);
    } else {
      ed.op(start, 0, w + ' ', 'type').wait(1300); // swipe: one op per word
    }
  }
  const r = run(ed);
  close(r.hours[0].written, value(words.join(' ')));
  assert.equal(r.hours[0].notCounted.repeat, 0);
});

test('dictation partial results that rewrite the utterance count once', () => {
  const ed = new Ed();
  const final = 'There is something honest about trains. A plane pretends that the distance does not exist.';
  ed.op(0, 0, 'There is something', 'dictation').wait(1500);
  ed.op(0, 18, 'There is something honest about rains', 'dictation').wait(1500);
  ed.op(0, 37, 'There is something honest about trains. A plane pretends that', 'dictation').wait(1500);
  ed.op(0, ed.text.length, final + ' ', 'dictation');
  const r = run(ed);
  close(r.hours[0].written, value(final));
  assert.equal(r.hours[0].flags.length, 0);
});

test('retyping a deleted sentence earns nothing extra', () => {
  const ed = new Ed().write(PROSE[2]);
  ed.wait(3 * MIN);
  const once = value(PROSE[2]);
  ed.del(0, ed.text.length).wait(5 * SEC).write(PROSE[2]);
  const r = run(ed);
  close(r.hours[0].credit, once);
  assert.ok(r.hours[0].notCounted.repeat > 0);
});

test('text deleted before it settles never counted, so a fresh version counts in full', () => {
  const ed = new Ed().write(PROSE[3]);
  ed.wait(20 * SEC).del(0, ed.text.length).write(PROSE[4]);
  close(run(ed).hours[0].written, value(PROSE[4]));
});

test('retyping your own paragraph an hour later, elsewhere, earns nothing', () => {
  const ed = new Ed().write(PROSE[1]);
  ed.wait(HOUR).use('other').write(PROSE[1]);
  const r = run(ed);
  assert.ok(r.hours[1].credit <= 6, `hour 2 credit ${r.hours[1].credit}`); // at most the first words before a 6-word window matches
});

test('moving a paragraph to another post earns nothing and its cut credit is taken back', () => {
  const ed = new Ed().use('A').write(PROSE[0]).write(PROSE[1]);
  const before = run(ed).totals.credit;
  ed.wait(15 * MIN);
  const para = PROSE[0] + ' ';
  ed.del(0, para.length).wait(3 * SEC).use('B').paste(0, para, 'all');
  const r = run(ed);
  close(r.totals.credit, before);
  assert.equal(r.totals.cut, 0);
});

test('copying your own text into another post earns nothing', () => {
  const ed = new Ed().use('A').write(PROSE[5]);
  const before = run(ed).totals.credit;
  ed.wait(10 * MIN).use('B').paste(0, PROSE[5], 'all');
  close(run(ed).totals.credit, before);
});

test('paste: confirm all / none / some; short pastes count like typing (§12)', () => {
  const p = PROSE[6];
  close(run(new Ed().paste(0, p, 'all')).hours[0].pasted, value(p));
  assert.equal(run(new Ed().paste(0, p, 'none')).hours[0].credit, 0);
  const firstSentence = p.indexOf('.') + 1;
  close(run(new Ed().paste(0, p, [[0, firstSentence]])).hours[0].pasted, value(p.slice(0, firstSentence)));
  // No dialog for short pastes, so whatever the client sends as a mask, they count.
  const phrase = 'a short phrase of seven words here';
  for (const confirm of ['all', 'none', []]) {
    const short = run(new Ed().paste(0, phrase, confirm));
    close(short.hours[0].credit, value(phrase));
    close(short.hours[0].pasted, value(phrase));
  }
  // The old rule is still available as a setting.
  assert.equal(run(new Ed().paste(0, phrase, 'all'), { shortPastesCount: false }).hours[0].credit, 0);
});

test('§12 pasted words that repeat your own text never count: in a post now, cut lately, pasted before', () => {
  // In one of your posts now: copying five of your words into another post.
  const ed = new Ed().write(PROSE[0]).wait(2 * MIN);
  const five = PROSE[0].split(' ').slice(10, 15).join(' ');
  const before = run(ed).totals.credit;
  ed.use('q').paste(0, `${five} `, 'all');
  let r = run(ed);
  close(r.totals.credit, before);
  assert.ok(r.totals.notCounted.repeat >= 4.5, 'shown as already written');
  // Cut in the last hour: a four-word chunk cut and pasted elsewhere.
  const ed2 = new Ed().write(PROSE[1]).wait(15 * MIN);
  const words = ed2.text.split(' ');
  const at = words.slice(0, 8).join(' ').length + 1;
  const chunk = words.slice(8, 12).join(' ') + ' ';
  const before2 = run(ed2).totals.credit;
  ed2.del(at, chunk.length).wait(2000).paste(0, chunk, 'all');
  r = run(ed2);
  assert.ok(r.totals.credit <= before2 + 0.01, `moving a chunk earned ${r.totals.credit - before2}`);
  assert.equal(r.totals.pasted, 0);
  // Pasted before: an outside paragraph pasted, deleted, and pasted again two hours later.
  const ed3 = new Ed().paste(0, PROSE[2], 'all').wait(5 * MIN).del(0, PROSE[2].length).wait(2 * 60 * MIN).paste(0, PROSE[2], 'all');
  r = run(ed3);
  close(r.totals.pasted, value(PROSE[2]));
  close(r.hours[2].pasted, 0);
  // A one-word paste of a word that's already in your text doesn't count either.
  const ed4 = new Ed().write(PROSE[3]).wait(2 * MIN);
  const one = run(ed4).totals.credit;
  ed4.paste(ed4.text.length, 'embarrassment', 'all');
  close(run(ed4).totals.credit, one);
  // Pairs of common function words alone don't make a match: new text pasted later counts.
  const ed5 = new Ed().write(PROSE[4]).wait(2 * MIN);
  const c5 = run(ed5).totals.credit;
  ed5.paste(ed5.text.length, ` ${PROSE[5]}`, 'all');
  close(run(ed5).totals.credit, c5 + value(PROSE[5]), 1.01);
});

test('§12 Ctrl+V spam and cut/paste shuffling earn about nothing', () => {
  const spam = new Ed().write(PROSE[0]).wait(2 * MIN);
  const base = run(spam).totals.credit;
  const clip = `${PROSE[0].split(' ').slice(10, 15).join(' ')} `;
  for (let i = 0; i < 200; i++) spam.paste(spam.text.length, clip, 'all').wait(120);
  close(run(spam).totals.credit, base, 0.01);
  const shuf = new Ed().write(`${PROSE[1]} ${PROSE[2]} ${PROSE[3]}`).wait(15 * MIN);
  const base2 = run(shuf).totals.credit;
  for (let i = 0; i < 40; i++) {
    const ws = shuf.text.split(' ');
    const a = ws.slice(0, 3 + (i % 20)).join(' ').length + 1;
    const n = 3 + (i % 3);
    const chunk = ws.slice(3 + (i % 20), 3 + (i % 20) + n).join(' ') + ' ';
    shuf.del(a, chunk.length).wait(1200);
    const ws2 = shuf.text.split(' ');
    shuf.paste(ws2.slice(0, 40 - (i % 30)).join(' ').length + 1, chunk, 'all').wait(2500);
  }
  const r = run(shuf);
  assert.ok(r.totals.credit - base2 <= 3, `shuffling earned ${r.totals.credit - base2}`);
});

test('§12 an hour that needs 100+ pasted words (short ones too) goes to review', () => {
  // Pasting an outside article 12 words at a time, every 5 s.
  const article = Array.from({ length: 120 }, (_, i) => `Report ${i} says the ${i * 7 % 97}th survey of district ${i} found nothing new.`).join(' ');
  const words = article.split(' ');
  const ed = new Ed();
  for (let i = 0; i + 12 <= words.length && ed.t < 50 * MIN; i += 12) ed.paste(ed.text.length, words.slice(i, i + 12).join(' ') + ' ', 'none').wait(5000);
  const r = run(ed, {}, { now: 62 * MIN });
  assert.ok(r.hours[0].pasted >= 400, `pasted ${r.hours[0].pasted}`);
  assert.equal(r.hours[0].status, 'review');
  assert.ok(r.hours[0].flags.some((f) => f.type === 'bigPaste'));
  // A writer who meets the target by typing and pastes a little on top is simply met.
  const ok = new Ed();
  for (const p of [...PROSE, ...PROSE.map((x) => x.split(' ').reverse().join(' '))]) ok.write(p);
  ok.paste(ok.text.length, ` ${PROSE[7].split(' ').slice(0, 30).join(' ')}`, 'all');
  const r2 = run(ok, { targetPerHour: 200 }, { now: 62 * MIN });
  assert.equal(r2.hours[0].status, 'met');
});

test('pasting the same outside paragraph twice counts once', () => {
  const ed = new Ed().paste(0, PROSE[7], 'all').wait(5 * MIN);
  ed.paste(ed.text.length, '\n\n' + PROSE[7], 'all');
  close(run(ed).hours[0].pasted, value(PROSE[7]));
});

test('§30 a typed quote line of new words counts once it has settled, like any other line', () => {
  const ed = new Ed().write(`> ${PROSE[2]}`).type('\n');
  const r = run(ed, {}, { now: ed.t + 2 * MIN });
  close(r.hours[0].written, value(PROSE[2]));
  assert.equal(r.hours[0].notCounted.quote, undefined, 'no "quote" reason any more');
  // Like any words, the last ones count only once they've settled.
  assert.ok(run(ed, {}, { now: ed.t + 10 * SEC }).hours[0].written < value(PROSE[2]));
  // Quoting a settled line, or un-quoting it, earns nothing more.
  ed.wait(MIN).op(0, 2, '', 'type').wait(2 * MIN).op(0, 0, '> ', 'type');
  close(run(ed, {}, { now: ed.t + 2 * MIN }).hours[0].written, value(PROSE[2]));
});

test('§30 a pasted quote follows the paste rules; a quote repeating your own words is a repeat', () => {
  const yes = new Ed().paste(0, `> ${PROSE[3]}`, 'all');
  close(run(yes, {}, { now: yes.t + 2 * MIN }).hours[0].pasted, value(PROSE[3]));
  const no = new Ed().paste(0, `> ${PROSE[3]}`, []);
  const rn = run(no, {}, { now: no.t + 2 * MIN }).hours[0];
  assert.equal(rn.credit, 0);
  close(rn.notCounted.unconfirmedPaste, value(PROSE[3]));
  // Your own paragraph typed again as a quote: already counted.
  const own = new Ed().write(PROSE[4]).wait(5 * MIN).type('\n> ').write(PROSE[4]);
  const ro = run(own, {}, { now: own.t + 2 * MIN }).hours[0];
  close(ro.written, value(PROSE[4]));
  assert.ok(ro.notCounted.repeat >= value(PROSE[4]) - 6, `repeat ${ro.notCounted.repeat}`);
});

test('§30 a quote line matching another writer’s text earns nothing and is flagged', () => {
  const a = new Ed();
  for (const p of PROSE.slice(4, 7)) a.write(p);
  const b = new Ed({ t0: 15 * MIN });
  b.write(PROSE[0]).type('\n> ').write(PROSE[5]);
  const r = scoreParty({ a: a.ops, b: b.ops }, {}, { a: { joinedAt: 0 }, b: { joinedAt: 0 } }, b.t + 2 * MIN);
  const h = r.b.hours[0];
  close(h.written, value(PROSE[0]), 6); // the quoted words earn nothing (bar the first few: no 6-word window yet)
  assert.ok(h.notCounted.otherWriter >= value(PROSE[5]) - 6, `otherWriter ${h.notCounted.otherWriter}`);
  assert.ok(r.b.flags.some((f) => f.type === 'otherWriter'));
});

test('§14 link and image addresses, bare URLs and list markers never count; link text, image descriptions (§14b) and headings do', () => {
  const S = { targetPerHour: 50 };
  const credit = (text, how = 'type') => {
    const ed = new Ed();
    if (how === 'paste') ed.paste(0, text, 'all');
    else ed.type(text, { cps: 8 });
    return run(ed, S, { now: ed.t + 2 * MIN });
  };
  let r = credit('Read [the long essay about ferries](https://example.com/essays/ferries-and-harbours?id=42) tonight. ');
  close(r.totals.written, value('Read the long essay about ferries tonight.'));
  assert.ok(r.totals.notCounted.markup >= 6, `markup ${r.totals.notCounted.markup}`);
  r = credit('Before the picture. ![a grey cat asleep on the windowsill](/u/k3j9x2.webp) After it. ');
  close(r.totals.written, value('Before the picture. a grey cat asleep on the windowsill After it.'));
  r = credit('See https://www.lesswrong.com/posts/abc123/some-long-title and www.example.org/page for more. ');
  close(r.totals.written, value('See and for more.'));
  r = credit('# A heading here\n\n1. First item here\n2. Second item here\n- [x] done task\n- plain bullet\n');
  close(r.totals.written, value('A heading here First item here Second item here done task plain bullet'));
  // Pasted links are judged the same way.
  r = credit('The full report is at https://example.org/reports/2026/annual-summary-final.pdf if you want it, along with the appendix.', 'paste');
  close(r.totals.pasted, value('The full report is at if you want it, along with the appendix.'));
});

test('planning notes count like the body', () => {
  const ed = new Ed().use('story', 'notes').write('Mara finds the letter behind the radiator and decides not to open it yet.');
  close(run(ed).hours[0].written, value('Mara finds the letter behind the radiator and decides not to open it yet.'));
});

test('rewriting an old paragraph: new words count, removed words earn half, re-used words nothing', () => {
  const old = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango.';
  const ed = new Ed().write(old);
  ed.wait(15 * MIN);
  const base = run(ed).hours[0].credit;
  // select the paragraph and type a version with 10 new words and 10 of the old ones
  const neu = 'uniform alpha victor bravo whiskey charlie xray delta yankee echo zulu foxtrot amber golf basil hotel cedar india dahlia juliet.';
  const len = ed.text.length;
  ed.op(0, len, neu[0]).wait(200);
  ed.type(neu.slice(1), { pos: 1 });
  const r = run(ed);
  close(r.hours[0].credit - base, 10 + 0.5 * 10);
});

test('swapping a word back and forth only earns the first swap', () => {
  const ed = new Ed().write(PROSE[0]);
  const base = run(ed).hours[0].credit;
  ed.wait(12 * MIN);
  for (let i = 0; i < 30; i++) {
    const s = ed.text;
    const from = i % 2 === 0 ? 'city' : 'town';
    const to = i % 2 === 0 ? 'town' : 'city';
    const at = s.indexOf(from);
    ed.op(at, from.length, to[0]).type(to.slice(1), { pos: at + 1 }).wait(95 * SEC);
  }
  const r = run(ed);
  const gain = r.totals.credit - base;
  assert.ok(gain <= 2, `gain ${gain}`);
});

test('shuffling the word order of old sentences earns nothing', () => {
  const ed = new Ed().write(PROSE[1]).write(PROSE[2]);
  ed.wait(12 * MIN);
  const base = run(ed).totals.credit;
  for (let i = 0; i < 6; i++) {
    const s = ed.text;
    const end = s.indexOf('.') + 1;
    const shuffled = s.slice(0, end - 1).split(' ').reverse().join(' ') + '.';
    ed.op(0, end, shuffled[0]).type(shuffled.slice(1), { pos: 1 }).wait(2 * MIN);
  }
  const gain = run(ed).totals.credit - base;
  assert.ok(gain <= 3, `gain ${gain}`);
});

test('changing letters inside a word that already counted earns nothing', () => {
  const ed = new Ed().write(PROSE[4]);
  const base = run(ed).totals.credit;
  ed.wait(5 * MIN);
  for (let i = 0; i < 40; i++) {
    const s = ed.text;
    const at = s.indexOf('money') + 1;
    ed.op(at, 1, 'aeiou'[i % 5]).wait(100 * SEC);
  }
  close(run(ed).totals.credit, base);
});

test('whitespace and punctuation edits earn nothing', () => {
  const ed = new Ed().write(PROSE[6]);
  const base = run(ed).totals.credit;
  ed.wait(12 * MIN);
  for (let i = 0; i < 2000; i++) ed.op(ed.text.length, 0, i % 3 ? ' ' : '\n').wait(40);
  for (let i = 0; i < 50; i++) {
    const s = ed.text;
    const at = s.indexOf(',') >= 0 ? s.indexOf(',') : s.indexOf(';');
    ed.op(at, 1, s[at] === ',' ? ';' : ',').wait(20 * SEC);
  }
  close(run(ed).totals.credit, base);
});

test('undo/redo loops earn nothing', () => {
  const ed = new Ed().write(PROSE[3]);
  ed.wait(12 * MIN);
  const base = run(ed).totals.credit;
  for (let i = 0; i < 40; i++) {
    const chunk = ed.text.slice(0, 40);
    ed.del(0, 40).wait(800).op(0, 0, chunk, 'paste', { confirm: 'all' }).wait(95 * SEC);
  }
  close(run(ed).totals.credit, base);
});

test('cutting old text earns half a word per word, capped, and comes back off if restored', () => {
  const ed = new Ed();
  for (const p of PROSE) ed.write(p);
  ed.wait(20 * MIN);
  const words = value(PROSE[0]);
  const base = run(ed).totals.credit;
  ed.del(0, PROSE[0].length + 1);
  close(run(ed).totals.credit - base, 0.5 * words);
  // restoring it (paste back) takes the cut credit away again
  ed.wait(4 * MIN).paste(0, PROSE[0] + ' ', 'all');
  close(run(ed).totals.credit, base);
  // the cap: cutting everything at once earns at most cutCapPerHour
  const big = new Ed();
  let a = 12345;
  const syl = () => 'bdfgklmnprstvz'[(a = (a * 48271) % 2147483647) % 14] + 'aeiou'[(a = (a * 48271) % 2147483647) % 5];
  const fresh = Array.from({ length: 700 }, () => syl() + syl() + syl()).join(' ');
  big.write(fresh);
  big.wait(15 * MIN);
  const b0 = run(big);
  big.del(0, big.text.length);
  const b1 = run(big);
  const gained = b1.totals.credit - b0.totals.credit;
  const cap = DEFAULT_SETTINGS.targetPerHour / 2; // cutCapPerHour: null = half the target
  assert.ok(gained <= cap + 0.01, `gained ${gained}`);
  assert.ok(gained > cap - 1);
});

test('text deleted soon after it was typed earns no cut credit', () => {
  const ed = new Ed().write(PROSE[5]);
  ed.wait(3 * MIN);
  const base = run(ed).totals.credit;
  ed.del(0, ed.text.length);
  close(run(ed).totals.credit, base);
});

test('speed cap; dictation gets a higher allowance; macro-sized inserts go to review', () => {
  const big = PROSE.join(' ');
  const typed = run(new Ed().op(0, 0, big, 'type'), { targetPerHour: 50 }, { now: HOUR + 2 * MIN });
  assert.ok(typed.hours[0].credit <= DEFAULT_SETTINGS.speedCapWpm + 0.01);
  assert.ok(typed.hours[0].flags.some((f) => f.type === 'bulkInsert'));
  assert.equal(typed.hours[0].status, 'review');
  const dict = run(new Ed().op(0, 0, PROSE[3] + ' ' + PROSE[4] + ' ', 'dictation'));
  close(dict.hours[0].credit, value(PROSE[3]) + value(PROSE[4]));
  assert.ok(!dict.hours[0].flags.some((f) => f.type === 'bulkInsert'));
});

test('pasting in chunks labelled as typing (each under 25 words) is caught by the run-level check', () => {
  const text = `${PROSE[0]} ${PROSE[1]} ${PROSE[2]}`;
  const words = text.split(' ');
  const ed = new Ed();
  for (let i = 0; i < words.length; i += 14) {
    ed.op(ed.text.length, 0, `${words.slice(i, i + 14).join(' ')} `, 'type');
    ed.wait(1000);
  }
  const r = run(ed, { targetPerHour: 50 }, { now: HOUR + 2 * MIN });
  const f = r.hours[0].flags.find((x) => x.type === 'bulkInsert');
  assert.ok(f && f.run, 'run-level bulkInsert flag');
  assert.equal(f.count || 1, 1, 'one flag per burst, not per op');
  assert.ok(r.hours[0].flaggedCredit >= value(text) - 1, `flagged ${r.hours[0].flaggedCredit}`);
  assert.equal(r.hours[0].status, 'review');
});

test('fast honest dictation in sentence bursts (180 wpm) and fast typing stay unflagged', () => {
  // Dictation: 5-word chunks every 1.67 s for a minute, a short breath between sentences.
  const words = `${PROSE[3]} ${PROSE[4]} ${PROSE[5]} ${PROSE[6]}`.split(' ');
  const d = new Ed();
  for (let i = 0; i < Math.min(words.length, 180); i += 5) {
    d.op(d.text.length, 0, `${words.slice(i, i + 5).join(' ')} `, 'dictation');
    d.wait(i % 20 === 15 ? 2500 : 1667);
  }
  const rd = run(d, { targetPerHour: 50 });
  assert.ok(!rd.hours[0].flags.some((x) => x.type === 'bulkInsert'), JSON.stringify(rd.hours[0].flags));
  // Typing at 100 wpm (10 chars a second) for a minute.
  const ty = new Ed().type(`${PROSE[0]} ${PROSE[1]} ${PROSE[7]}`, { cps: 10 });
  assert.ok(!run(ty).hours[0].flags.some((x) => x.type === 'bulkInsert'));
});

test('keyboard mash, lorem ipsum and word salad are flagged and go to review', () => {
  const S = { targetPerHour: 100 };
  const mash = new Ed();
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  while (mash.t < 20 * MIN) {
    let w = '';
    const n = 2 + Math.floor(rnd() * 6);
    for (let i = 0; i < n; i++) w += 'asdfghjklqwrtzxcvbnm'[Math.floor(rnd() * 20)];
    mash.type(w + ' ', { cps: 8 }).wait(rnd() < 0.2 ? 3000 : 0);
  }
  const rm = run(mash, S, { now: HOUR + 2 * MIN });
  assert.equal(rm.hours[0].status, 'review');
  assert.ok(rm.hours[0].flags.some((f) => f.type === 'gibberish'));
  const lorem = new Ed();
  for (let i = 0; i < 20; i++) lorem.write('Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ' + i + '.');
  const rl = run(lorem, S, { now: HOUR + 2 * MIN });
  assert.ok(rl.hours[0].flags.some((f) => f.type === 'lorem'));
  const salad = new Ed();
  const vocab = 'window river kitchen paper garden silence evening answer promise letter harbour season corner shadow journey pattern habit moment question balance distance surface weather reason picture market station notebook island orange yellow purple running jumping'.split(' ');
  for (let i = 0; i < 200; i++) salad.type(vocab[Math.floor(rnd() * vocab.length)] + ' ', { cps: 7 }).wait(i % 9 === 8 ? 2500 : 0);
  const rs = run(salad, { targetPerHour: 50 }, { now: HOUR + 2 * MIN });
  assert.ok(rs.hours[0].flags.some((f) => f.type === 'wordSalad'), JSON.stringify(rs.hours[0].flags));
  assert.equal(rs.hours[0].status, 'review');
});

test('word salad and repetition in planning notes are flagged too (terse honest notes are not)', () => {
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const vocab = 'window river kitchen paper garden silence evening answer promise letter harbour season corner shadow journey pattern habit moment question balance distance surface weather reason picture market station notebook island orange yellow purple running jumping'.split(' ');
  const salad = new Ed({ pane: 'notes' });
  for (let i = 0; i < 120; i++) salad.type(vocab[Math.floor(rnd() * vocab.length)] + ' ', { cps: 7 }).wait(i % 9 === 8 ? 2500 : 0);
  const rs = run(salad, { targetPerHour: 50 }, { now: HOUR + 2 * MIN });
  assert.ok(rs.hours[0].flags.some((f) => f.type === 'wordSalad'), JSON.stringify(rs.hours[0].flags));
  assert.equal(rs.hours[0].status, 'review');
  // Four words in a random order: new 6-word windows (so they earn), but the same few words.
  const rep = new Ed({ pane: 'notes' });
  const four = ['the', 'ferry', 'and', 'letter'];
  for (let i = 0; i < 120; i++) rep.type(four[Math.floor(rnd() * 4)] + ' ', { cps: 7 }).wait(i % 9 === 8 ? 2500 : 0);
  const rr = run(rep, { targetPerHour: 50 }, { now: HOUR + 2 * MIN });
  assert.ok(rr.hours[0].flags.some((f) => f.type === 'repetitive'), JSON.stringify(rr.hours[0].flags));
  // Terse, honest notes (lists, names, fragments) stay unflagged.
  const notes = new Ed({ pane: 'notes' });
  for (const l of ['- Mara: 34, translator, back in the town after mum\'s funeral', '- Tomas: younger brother, stayed, resents her leaving',
    '- the letter: hidden behind radiator, no signature, pressed flower', '- old man at harbour = knew mum? keep it ambiguous',
    '- lighthouse automated before Mara born, the line in guest book is ironic', '- theme: staying vs leaving, choices that were not choices',
    '- scene order: find letter / argument at dinner / harbour / open letter / ferry / museum / walk home',
    '- rain at start, clear sky at the end, do not overdo the symbolism', '- Tomas holds mug with both hands, childhood habit, show not tell']) notes.write(l + '\n');
  const rn = run(notes, { targetPerHour: 50 }, { now: HOUR + 2 * MIN });
  assert.deepEqual(rn.flags.map((f) => f.type), []);
});

test('ordinary prose, dialogue and terse notes raise no text flags', () => {
  const ed = new Ed();
  for (const p of PROSE) ed.write(p);
  ed.write('"You should open it," Tomas said from the kitchen doorway. "If it was important, she would have kept it somewhere better," Mara said.');
  ed.use('p', 'notes');
  for (const l of ['- Mara: 34, translator, back after funeral', '- Tomas: brother, stayed, resents her', '- letter behind radiator, no signature, flower', '- harbour scene: tea, coffee, ferry Thursday']) ed.write(l + '\n');
  const r = run(ed, { targetPerHour: 100 }, { now: HOUR + 2 * MIN });
  assert.deepEqual(r.flags.map((f) => f.type), []);
  assert.equal(r.hours[0].status, 'met');
  for (const p of PROSE) assert.equal(classifyBlock(textFeatures(wordsOf(p).map((w) => w.toLowerCase().replace(/[^a-z]/g, '')))), null);
});

test('steady machine-like typing goes to review; bursty human typing does not', () => {
  const bot = new Ed();
  for (let i = 0; i < 3; i++) for (const p of PROSE) bot.type(p + ' ', { cps: 5 });
  const rb = run(bot, { targetPerHour: 100 }, { now: HOUR + 2 * MIN });
  assert.ok(rb.hours[0].flags.some((f) => f.type === 'steadyTyping'));
  assert.equal(rb.hours[0].status, 'review');
  const human = new Ed();
  for (const p of PROSE) human.write(p).wait(20 * SEC);
  const rh = run(human, { targetPerHour: 100 }, { now: HOUR + 2 * MIN });
  assert.ok(!rh.hours[0].flags.some((f) => f.type === 'steadyTyping'));
});

test('typing text and deleting it soon after, over and over, goes to review', () => {
  const ed = new Ed();
  for (let i = 0; i < 8; i++) {
    const start = ed.text.length;
    ed.write(PROSE[i]).wait(2 * MIN);
    ed.del(start, ed.text.length - start);
  }
  const r = run(ed, { targetPerHour: 100 }, { now: HOUR + 2 * MIN });
  assert.ok(r.hours[0].flags.some((f) => f.type === 'mostlyDeleted'));
  assert.equal(r.hours[0].status, 'review');
});

test("another writer's text, pasted or retyped, earns nothing and is flagged", () => {
  const a = new Ed();
  for (const p of PROSE.slice(0, 4)) a.write(p);
  const b = new Ed({ t0: 15 * MIN });
  b.paste(0, PROSE[0] + ' ' + PROSE[1], 'all').wait(MIN);
  b.write(PROSE[2]);
  const r = scoreParty({ a: a.ops, b: b.ops }, {}, { a: { joinedAt: 0 }, b: { joinedAt: 0 } });
  assert.ok(r.b.totals.credit <= 6, `b credit ${r.b.totals.credit}`);
  assert.ok(r.b.flags.some((f) => f.type === 'otherWriter'));
  assert.ok(r.a.totals.credit > 100);
  // the paste dialog helper marks the other writer's words
  const party = createParty({}, { a: { joinedAt: 0 }, b: { joinedAt: 0 } });
  for (const op of a.ops) party.apply('a', op);
  party.advance(a.t + 2 * MIN);
  const marks = party.scorer('b').pasteCheck(PROSE[1]);
  assert.ok(marks.every((m) => m.other));
  assert.ok(party.scorer('a').pasteCheck(PROSE[1]).every((m) => m.own));
});

test('hour windows: late joiners and breaks', () => {
  const ed = new Ed({ t0: 40 * MIN }).write(PROSE[0]).wait(54 * MIN).write(PROSE[1]);
  const late = run(ed, {}, { joinedAt: 30 * MIN });
  close(late.hours[0].written, value(PROSE[0]));
  close(late.hours[1].written, value(PROSE[1]));
  // a 30-minute break pauses the clock: 100 min of real time = 70 active minutes = hour 1
  const br = new Ed({ t0: 100 * MIN }).write(PROSE[2]);
  const rb = run(br, {}, { joinedAt: 0, breaks: [{ startAt: 60 * MIN, endAt: 90 * MIN }] });
  close(rb.hours[1].written, value(PROSE[2]));
  assert.equal(rb.hours[1].endAt, 150 * MIN);
});

test('text typed at the end of an hour counts for that hour; the hour stays open until it settles', () => {
  const ed = new Ed({ t0: HOUR - 20 * SEC }).type('Writing at the very end of the hour. ', { cps: 8 });
  const mid = run(ed, { targetPerHour: 5 }, { now: HOUR + 30 * SEC });
  assert.equal(mid.hours[0].status, 'open');
  const fin = run(ed, { targetPerHour: 5 }, { now: HOUR + 2 * MIN });
  close(fin.hours[0].written, value('Writing at the very end of the hour.'));
  assert.equal(fin.hours[0].status, 'met');
  const free = run(new Ed(), {}, { now: HOUR + 2 * MIN, freeHours: [0] });
  assert.equal(free.hours[0].status, 'free');
});

test('late work (received after its hour ended) meets the hour only through review', () => {
  // 20 words typed live, then 40 words typed in minutes 5-8 that only reach the server at minute 12.
  const ed = new Ed({ t0: MIN }).write(PROSE[0].split(' ').slice(0, 20).join(' '));
  const live = ed.ops.length;
  ed.t = 5 * MIN;
  ed.write(PROSE[1].split(' ').slice(0, 25).join(' ') + ' ' + PROSE[2].split(' ').slice(0, 15).join(' '));
  const late = ed.ops.map((o, i) => (i < live ? o : { ...o, r: 12 * MIN }));
  const S = { targetPerHour: 50, hourLengthMin: 10 };
  const r = score(late, S, { joinedAt: 0, now: 15 * MIN });
  const h = r.hours[0];
  assert.ok(h.credit >= 50, `credit ${h.credit}`);
  assert.equal(h.status, 'review');
  const f = h.flags.find((x) => x.type === 'lateWork');
  assert.ok(f && f.words >= 35, `late words ${f && f.words}`);
  assert.ok(f.from >= 5 * MIN && f.to < 10 * MIN && f.receivedAt === 12 * MIN);
  // The same words arriving a few seconds after they were typed are ordinary work.
  const onTime = ed.ops.map((o, i) => (i < live ? o : { ...o, r: o.t + 3 * SEC }));
  const r2 = score(onTime, S, { joinedAt: 0, now: 15 * MIN });
  assert.equal(r2.hours[0].status, 'met');
  assert.ok(!r2.hours[0].flags.some((x) => x.type === 'lateWork'));
  // Late work into the hour still running is not late.
  const cur = ed.ops.map((o, i) => (i < live ? o : { ...o, r: 9 * MIN + 30 * SEC }));
  assert.ok(!score(cur, S, { joinedAt: 0, now: 15 * MIN }).hours[0].flags.some((x) => x.type === 'lateWork'));
});

test('incremental scoring equals batch scoring; settings changes re-score deterministically', () => {
  const ed = new Ed();
  for (const p of PROSE) ed.write(p).wait(30 * SEC);
  ed.wait(12 * MIN).del(0, 40).wait(MIN).paste(ed.text.length, PROSE[0], 'all');
  const batch = run(ed);
  const sc = createScorer({}, { joinedAt: 0 });
  let i = 0;
  for (const op of ed.ops) {
    if (i++ % 37 === 0) sc.advance(op.t - 1);
    sc.apply(op);
  }
  assert.deepEqual(sc.result(batch.now), batch);
  // polling result() mid-way (a live dashboard) must not change the final result
  const polled = createScorer({}, { joinedAt: 0 });
  let j = 0;
  for (const op of ed.ops) {
    polled.apply(op);
    if (j++ % 50 === 0) polled.result(op.t);
  }
  assert.deepEqual(polled.result(batch.now), batch);
  const salad = new Ed();
  const vocab = 'window river kitchen paper garden silence evening answer promise letter harbour season corner shadow journey pattern habit moment question balance'.split(' ');
  for (let k = 0; k < 120; k++) salad.type(vocab[(k * 7) % vocab.length] + ' ', { cps: 7 }).wait(k % 9 === 8 ? 2500 : 0);
  const sb = run(salad, {}, { now: HOUR + 2 * MIN });
  const sp = createScorer({}, { joinedAt: 0 });
  for (const op of salad.ops) {
    sp.apply(op);
    sp.result(op.t);
  }
  assert.deepEqual(sp.result(HOUR + 2 * MIN), sb);
  const again = run(ed);
  assert.deepEqual(again, batch);
  const lower = run(ed, { targetPerHour: 10 }, { now: HOUR + 2 * MIN });
  const higher = run(ed, { targetPerHour: 1000 }, { now: HOUR + 2 * MIN });
  assert.equal(lower.hours[0].credit, higher.hours[0].credit);
  assert.equal(lower.hours[0].status, 'met');
  assert.equal(higher.hours[0].status, 'missed');
});

test('CJK text counts per character', () => {
  const ed = new Ed().type('我今天在咖啡馆里写了一篇关于城市散步的文章。', { cps: 3 });
  const r = run(ed);
  close(r.hours[0].written, 21 * DEFAULT_SETTINGS.cjkCharWords);
});

test('fast enough: a 10,000-word post and 20,000 keystrokes', () => {
  const t0 = Date.now();
  const sc = createScorer({}, { joinedAt: 0 });
  // ~10,000 words in paragraphs
  const long = Array.from({ length: 330 }, (_, i) => PROSE[i % PROSE.length].replace(/\./g, ` ${i}.`)).join('\n\n');
  let t = 0;
  sc.apply({ t, post: 'p', pane: 'body', pos: 0, del: 0, ins: long, source: 'type' });
  let len = long.length;
  for (let i = 0; i < 20000; i++) {
    t += 150;
    const middle = i % 3 === 0;
    const pos = middle ? Math.floor(len / 2) : len;
    sc.apply({ t, post: 'p', pane: 'body', pos, del: 0, ins: 'abcdefgh '[i % 9], source: 'type' });
    len++;
  }
  const r = sc.result(t + 2 * MIN);
  assert.ok(r.totals.credit > 0);
  const ms = Date.now() - t0;
  assert.ok(ms < 6000, `took ${ms} ms`);
});
