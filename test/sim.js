// Test helper (not a test file): simulates an editor producing ops.

export const T0 = Date.UTC(2026, 9, 4, 17, 0, 0);
export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;

// Deterministic, non-repeating prose-ish words (so 6-word windows never repeat by accident).
export function makeWords(n, seed = 1) {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const C = 'bcdfghklmnprstvwz';
  const V = 'aeiou';
  const out = [];
  for (let i = 0; i < n; i++) {
    const syl = 1 + Math.floor(rnd() * 3);
    let w = '';
    for (let s = 0; s < syl; s++) w += C[Math.floor(rnd() * C.length)] + V[Math.floor(rnd() * V.length)];
    out.push(w);
  }
  return out;
}
// Exactly `chars` characters of prose (words + single spaces).
export function prose(chars, seed = 1) {
  const words = makeWords(Math.ceil(chars / 2) + 10, seed);
  let s = '';
  let i = 0;
  while (s.length < chars) s += (s ? ' ' : '') + words[i++];
  return s.slice(0, chars);
}

export class Sim {
  constructor({ t0 = T0, post = 'p1', pane = 'b' } = {}) {
    this.t = t0;
    this.post = post;
    this.pane = pane;
    this.texts = new Map();
    this.cursor = new Map();
    this.ops = [];
  }
  key() { return `${this.post}|${this.pane}`; }
  get text() { return this.texts.get(this.key()) || ''; }
  set text(v) { this.texts.set(this.key(), v); }
  get pos() { return this.cursor.has(this.key()) ? this.cursor.get(this.key()) : this.text.length; }
  set pos(v) { this.cursor.set(this.key(), v); }
  use(post, pane = 'b') { this.post = post; this.pane = pane; return this; }
  wait(ms) { this.t += ms; return this; }
  at(t) { this.t = t; return this; }
  op(pos, del, ins, extra = {}) {
    const text = this.text;
    if (pos < 0 || pos + del > text.length) throw new Error('sim op out of range');
    this.ops.push({ t: this.t, post: this.post, pane: this.pane, pos, del, ins, ...extra });
    this.text = text.slice(0, pos) + ins + text.slice(pos + del);
    this.pos = pos + ins.length;
    return this;
  }
  // Type char by char at `cps` characters per second.
  type(str, { cps = 5 } = {}) {
    for (const ch of str) {
      this.op(this.pos, 0, ch);
      this.t += 1000 / cps;
    }
    return this;
  }
  backspace(n = 1, { cps = 8 } = {}) {
    for (let i = 0; i < n; i++) {
      const p = this.pos;
      if (p <= 0) break;
      this.op(p - 1, 1, '');
      this.t += 1000 / cps;
    }
    return this;
  }
  moveTo(pos) { this.pos = pos; return this; }
  end() { this.pos = this.text.length; return this; }
  // Select [from, to) and delete it in one op (cut / select+delete).
  deleteRange(from, to) { this.op(from, to - from, ''); this.t += 300; return this; }
  // Replace [from, to) with text in one op (autocorrect / predictive text).
  replace(from, to, ins) { this.op(from, to - from, ins); this.t += 100; return this; }
  // Paste text at the cursor. mask: 'all' | 'none' | string of 0/1 per raw word | function(i) -> bool.
  paste(text, mask = 'all', { x = null, d = null } = {}) {
    const words = text.match(/\S+/g) || [];
    let m;
    if (mask === 'all') m = '1'.repeat(words.length);
    else if (mask === 'none') m = '0'.repeat(words.length);
    else if (typeof mask === 'function') m = words.map((_, i) => (mask(i) ? '1' : '0')).join('');
    else m = mask;
    const paste = { m, d: d || (mask === 'none' ? 'no' : 'yes') };
    if (x) paste.x = x;
    this.op(this.pos, 0, text, { paste });
    this.t += 500;
    return this;
  }
}

// Real prose for tests that need text the scorer treats as ordinary writing
// (the syllable soup of prose() reads as word salad to the text checks).
export const PARAGRAPHS = [
  'The ferry left at seven every morning, whether or not anyone was waiting on the pier. Most days the captain made the crossing alone, humming the same three songs and pretending not to notice the gulls that followed him all the way.',
  'My aunt kept a drawer full of keys that no longer opened anything. When I asked her why she never threw them out, she said that a key remembers a door even after the door forgets the key, which did not help at all.',
  'We moved to the coast in the winter of the flood, when the river came up through the floorboards and the whole street smelled of wet paper. For weeks we ate standing up because every chair was drying on the porch.',
  'There is a particular silence in a library just before closing time. The lights hum, the last readers gather their coats, and somewhere a trolley squeaks past the shelves like a small animal looking for a place to sleep.',
  'Learning to cook for one person took me longer than learning to cook for ten. The recipes all assume a crowd, and the leftovers stare at you from the fridge for days, patient and slightly accusing, until you give in.',
  'The old map in the hallway showed an island that does not exist. My grandfather swore he had seen it once from a fishing boat, low and green on the horizon, and that it vanished the moment he reached for his camera.',
  'On the night train the conductor knew everyone by their tickets rather than their faces. He would nod at a stamp from last spring and ask about a sister in another city, and people answered him as if he were family.',
  'I started running because the doctor told me to, and I kept running because nobody can phone you at six in the morning on a muddy path by the canal. The herons are not impressed, but they let me pass.',
  'Every house on our street had a different idea of what a garden should be. One grew only cabbages, one grew only roses, and the house on the corner grew nothing but a sign that said the owner would be back soon.',
  'The museum guard told me that the paintings change when nobody is looking. Not much, he said, just a hand moved here or a cloud there, and he had stopped writing it down after his supervisor asked him to see someone about it.',
  'My first apartment had a window that faced a brick wall so close I could touch it. In the afternoons a strip of sunlight slid down the bricks like honey, and for ten minutes the whole room turned the colour of tea.',
  'When the power went out for three days, the neighbours brought their candles into the stairwell and we told stories until the wax ran out. Nobody remembers the stories now, only that we laughed more than we expected to.',
];
const ALL_WORDS = PARAGRAPHS.join(' ').split(' ');
// `n` words of real prose starting at word `from` (paragraph text, single spaces).
export function realProse(n, from = 0) {
  return ALL_WORDS.slice(from, from + n).join(' ');
}
// Expected credit under the word unit: 1 per word, 0.5 per one-letter word.
export function wordValue(s) {
  return s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w))
    .reduce((a, w) => a + (w.replace(/[^\p{L}\p{N}]/gu, '').length === 1 ? 0.5 : 1), 0);
}
