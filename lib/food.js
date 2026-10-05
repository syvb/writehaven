// Food preferences (SPEC §18) and the food order (SPEC §18b). Zero dependencies.
//
//   GET  /api/me/food             your answers, the food order's setup and the limits. Any signed-in
//                                 account: pending, declined and approved alike.
//   PUT  /api/me/food             replace your answers (JSON with the X-WH: 1 header)
//   GET  /api/host/food           hosts: everyone's answers, the tallies and the order setup;
//                                 ?id=<userId> answers { person } for the writer drawer
//   GET  /api/host/food.csv       hosts: one row per person
//   PUT  /api/host/food/options   hosts: the food order's setup { options, deadline, note } (X-WH)
//   POST /api/host/food/reset     hosts: clear the food order answers (SPEC §20; the standing answers,
//                                 the options and the deadline stay; the old answers go to the history) (X-WH)
//   GET  /api/host/food-history.csv   hosts: everyone's answers as they were before each reset
// Every /api/host/ path also answers as /api/admin/. Anyone but a host gets 404 there.
//
// Storage: a person's answers are `user.food` on their record in the state file, so the party's
// saver keeps them and the host's all-data export (which copies user records) includes them. No
// other view copies user records: nothing here reaches the live page, the anthology, post pages,
// the posts export or another writer. The order setup is `state.party.foodOrder` and the time of
// the last reset `state.party.foodResetAt` (the public party views pick their fields by name).
// A form loaded before a reset sends that reset's time (`resetAt`) with each save; a stale one is
// refused (409 `reset`), so an open form can't bring cleared answers back.

import crypto from 'node:crypto';
import { sanitizeText } from './sanitize.js';
import { countWords } from '../public/js/text.js';

export const LIMITS = { text: 300, name: 80, url: 500, allergies: 12, picks: 3, options: 12, bodyBytes: 64 * 1024 };

export const CHOICES = {
  diet: ['omnivore', 'flexitarian', 'pescatarian', 'vegetarian', 'vegan', 'other'],
  severity: ['preference', 'intolerance', 'allergy', 'severe'],
  spice: ['none', 'mild', 'medium', 'hot', 'very-hot'],
  eating: ['yes', 'snack', 'no'],
  hunger: ['light', 'normal', 'very'],
};

export const LABELS = {
  diet: { omnivore: 'Omnivore', flexitarian: 'Flexitarian', pescatarian: 'Pescatarian', vegetarian: 'Vegetarian', vegan: 'Vegan', other: 'Other' },
  severity: { preference: 'Preference', intolerance: 'Intolerance', allergy: 'Allergy', severe: 'Severe allergy' },
  spice: { none: 'None', mild: 'Mild', medium: 'Medium', hot: 'Hot', 'very-hot': 'Very hot' },
  eating: { yes: 'Eating with us', snack: 'Just a snack', no: 'Not eating' },
  hunger: { light: 'Light', normal: 'Normal', very: 'Very hungry' },
};

// The suggestions in the form, and the spellings folded into each when grouping.
export const ALLERGENS = [
  ['peanuts', 'Peanuts', ['peanut', 'groundnut', 'groundnuts', 'peanut allergy']],
  ['tree-nuts', 'Tree nuts', ['tree nut', 'treenut', 'treenuts']],
  ['gluten', 'Gluten / wheat', ['gluten', 'wheat', 'gluten wheat', 'coeliac', 'celiac', 'coeliac disease', 'celiac disease', 'gluten free']],
  ['dairy', 'Dairy / lactose', ['dairy', 'lactose', 'milk', 'dairy lactose', 'lactose intolerance', 'lactose intolerant', 'cow s milk', 'cows milk', 'dairy free']],
  ['eggs', 'Eggs', ['egg']],
  ['soy', 'Soy', ['soya', 'soybean', 'soybeans', 'soy beans']],
  ['fish', 'Fish', []],
  ['shellfish', 'Shellfish', ['crustacean', 'crustaceans']],
  ['sesame', 'Sesame', ['sesame seed', 'sesame seeds']],
  ['mustard', 'Mustard', []],
  ['celery', 'Celery', ['celeriac']],
  ['lupin', 'Lupin', ['lupine', 'lupins']],
  ['sulphites', 'Sulphites', ['sulfites', 'sulphite', 'sulfite', 'sulphur dioxide', 'sulfur dioxide']],
  ['molluscs', 'Molluscs', ['mollusc', 'mollusk', 'mollusks']],
];

const SEVERITY_RANK = { severe: 4, allergy: 3, intolerance: 2, preference: 1 };
// Questions no longer asked (SPEC §20b): ignored when sent, cleared from stored answers.
export const LEGACY_KEYS = ['rules', 'rulesOther', 'alcohol', 'caffeine'];
const ID_RE = /^[a-z0-9]{1,24}$/;
const DEADLINE_RE = /^(\d{1,2})[:.h](\d{2})$/;

export class FoodError extends Error {
  constructor(status, message, code = 'invalid', field = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
  }
}
const bad = (message, field = null, code = 'invalid') => new FoodError(400, message, code, field);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => (isObj(o) && Object.hasOwn(o, k) ? o[k] : undefined);

// ------------------------------------------------------------------ cleaning
// Control and invisible characters go (lib/sanitize.js), tabs become spaces, runs of spaces
// collapse; one-line fields lose their line breaks. At most `max` characters (code points).
export function cleanText(v, { multiline = false, max = LIMITS.text, field = 'text' } = {}) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw bad(`${field} must be text`, field);
  let s = sanitizeText(v).replace(/\t/g, ' ');
  s = multiline
    ? s.replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n')
    : s.replace(/\s+/g, ' ');
  s = s.trim();
  const cps = [...s];
  return cps.length > max ? cps.slice(0, max).join('').trimEnd() : s;
}

function choice(v, field) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !CHOICES[field].includes(v)) throw bad(`${field} isn’t one of the choices`, field);
  return v;
}

export function blankOrder() {
  return { eating: null, hunger: null, picks: [], lines: {}, wish: '', drinks: '', payment: '' };
}
export function blankFood() {
  return {
    diet: null, dietOther: '', allergies: [], noAllergies: false,
    avoid: '', love: '', spice: null, drinks: '', notes: '',
    order: blankOrder(),
    share: false, // SPEC §20d: shown to other writers, without names or allergies
  };
}

function cleanOrder(v) {
  const o = blankOrder();
  if (v === undefined || v === null) return o;
  if (!isObj(v)) throw bad('order must be an object', 'order');
  o.eating = choice(v.eating, 'eating');
  o.hunger = choice(v.hunger, 'hunger');
  if (v.picks !== undefined && v.picks !== null) {
    if (!Array.isArray(v.picks) || v.picks.length > 20) throw bad('picks must be a list', 'picks');
    for (const id of v.picks) {
      if (typeof id !== 'string' || !ID_RE.test(id)) throw bad('picks: not an option', 'picks');
      if (!o.picks.includes(id)) o.picks.push(id);
    }
    if (o.picks.length > LIMITS.picks) throw bad(`Pick at most ${LIMITS.picks} options`, 'picks', 'too_many');
  }
  if (v.lines !== undefined && v.lines !== null) {
    if (!isObj(v.lines)) throw bad('lines must be an object', 'lines');
    for (const id of o.picks) {
      const s = cleanText(own(v.lines, id), { field: 'Your order' });
      if (s) o.lines[id] = s;
    }
  }
  o.wish = cleanText(v.wish, { field: 'What you’d like' });
  o.drinks = cleanText(v.drinks, { field: 'Drinks for the order' });
  o.payment = cleanText(v.payment, { field: 'Payment note' });
  return o;
}

const orderBlank = (o) => !o.eating && !o.hunger && !o.picks.length && !Object.keys(o.lines).length && !o.wish && !o.drinks && !o.payment;
export function isBlank(f) {
  if (!f) return true;
  return !f.diet && !f.dietOther && !f.allergies.length && !f.noAllergies
    && !f.avoid && !f.love && !f.spice && !f.drinks && !f.notes && orderBlank(f.order);
}

// A person's answers, validated and cleaned: the full shape, or null when nothing is answered.
// Wrong types and unknown choices are 400s; long text is cut to the limit; unknown keys are ignored.
export function cleanFood(input) {
  if (input === undefined || input === null) return null;
  if (!isObj(input)) throw bad('Answers must be an object', 'food');
  const t = (k, opts) => cleanText(input[k], { field: k, ...opts });
  const f = blankFood();
  f.diet = choice(input.diet, 'diet');
  f.dietOther = f.diet === 'other' ? t('dietOther') : '';
  if (input.allergies !== undefined && input.allergies !== null) {
    if (!Array.isArray(input.allergies)) throw bad('allergies must be a list', 'allergies');
    if (input.allergies.length > LIMITS.allergies) throw bad(`At most ${LIMITS.allergies} allergies or intolerances`, 'allergies', 'too_many');
    for (const row of input.allergies) {
      if (!isObj(row)) throw bad('Each allergy must be an object', 'allergies');
      const r = {
        item: cleanText(row.item, { field: 'item' }),
        severity: choice(row.severity, 'severity'),
        note: cleanText(row.note, { field: 'note' }),
      };
      if (r.item || r.severity || r.note) f.allergies.push(r);
    }
  }
  f.noAllergies = input.noAllergies === true && f.allergies.length === 0;
  f.avoid = t('avoid', { multiline: true });
  f.love = t('love', { multiline: true });
  f.spice = choice(input.spice, 'spice');
  f.drinks = t('drinks');
  f.notes = t('notes', { multiline: true });
  f.order = cleanOrder(input.order);
  f.share = input.share === true;
  return isBlank(f) ? null : f;
}

// What's stored, read back defensively (a hand-edited state file can't break the host's view).
export function readFood(u) {
  if (!u || !isObj(u.food)) return { food: null, updatedAt: null };
  try {
    const food = cleanFood(u.food);
    return { food, updatedAt: food && Number.isFinite(u.food.updatedAt) ? u.food.updatedAt : null };
  } catch {
    return { food: null, updatedAt: null };
  }
}

// ------------------------------------------------------------------ food words (SPEC §20c)
// Words in the free-text answers only: foods you love, things to avoid, favourite drinks,
// anything else, and the food order (what you'd like, your order lines, drinks). Choices, the
// diet's "other" text, allergy rows and the payment note don't count. public/js/food.js counts
// the same fields for the form's live counter.
export function foodWords(food) {
  if (!isObj(food)) return 0;
  const o = isObj(food.order) ? food.order : {};
  const texts = [food.love, food.avoid, food.drinks, food.notes, o.wish, o.drinks, ...(isObj(o.lines) ? Object.values(o.lines) : [])];
  let n = 0;
  for (const t of texts) if (typeof t === 'string' && t) n += countWords(t);
  return n;
}
// Cached per stored answer set: a save stores a new object and a reset stores null, so the
// party's totals never count words again for answers that haven't changed.
const wordsCache = new WeakMap();
export function foodWordsOf(food) {
  if (!isObj(food)) return 0;
  let n = wordsCache.get(food);
  if (n === undefined) wordsCache.set(food, (n = foodWords(food)));
  return n;
}
// Food words already credited to this writer's hours (a high-water mark, never taken back).
export function foodCreditOf(u) {
  return (Array.isArray(u?.bonusCredit) ? u.bonusCredit : []).reduce((sum, b) => sum + (b && b.source === 'food' && b.words > 0 ? b.words : 0), 0);
}
// The high-water mark the next save is measured against: the most food words counted (lowered by
// the order words a host reset clears), or, for answers saved before it was kept, all the credit so far.
export function foodMarkOf(u) {
  return Number.isFinite(u?.foodMark) ? u.foodMark : foodCreditOf(u);
}
// After a save: credit the words above the high-water mark (no cap, SPEC §30) to the hour of the
// save; before the writer's first hour that's hour 1 (lib/score.js hourOf).
export function creditFood(party, u, at) {
  const words = foodWordsOf(u.food);
  const mark = foodMarkOf(u);
  if (words - mark >= 1 && typeof party?.addBonusCredit === 'function') party.addBonusCredit(u.id, { at, words: words - mark, source: 'food' });
  u.foodMark = Math.max(mark, words);
}

// A host reset (SPEC §20) clears the food order answers only: eating, hunger, picks, the order lines,
// what they'd like, drinks for the order and the payment note. Diet, allergies, dislikes,
// favourites, spice, drinks, notes and sharing stay. Everyone's full answers go to
// user.foodHistory first ({ resetAt, updatedAt, food, options: the picked options' names }), kept
// for good. Credit is never taken back; the mark drops by the cleared order words, so a new order
// counts while kept words never count twice. → how many people's order answers were cleared.
export function resetOrders(users, at, setup = blankSetup()) {
  const names = new Map(setup.options.map((o) => [o.id, o.name]));
  let cleared = 0;
  for (const u of users) {
    const { food, updatedAt } = readFood(u);
    if (!food) continue;
    const options = Object.fromEntries(food.order.picks.filter((id) => names.has(id)).map((id) => [id, names.get(id)]));
    u.foodHistory = [...(Array.isArray(u.foodHistory) ? u.foodHistory : []), { resetAt: at, updatedAt, food, options }];
    if (orderBlank(food.order)) continue;
    cleared++;
    const mark = foodMarkOf(u);
    const kept = { ...food, order: blankOrder() };
    u.food = isBlank(kept) ? null : { ...kept, updatedAt };
    u.foodMark = Math.max(0, mark - foodWords({ order: food.order }));
  }
  return cleared;
}
// Every earlier set of answers, one row per person and reset (for the history CSV).
export function historyRows(party) {
  const rows = [];
  for (const p of peopleOf(party)) {
    const u = party.userById(p.id);
    for (const x of Array.isArray(u?.foodHistory) ? u.foodHistory : []) {
      let food = null;
      try {
        food = cleanFood(x?.food);
      } catch { /* an unreadable entry: the row says so */ }
      rows.push({ ...p, food, answered: !!food, updatedAt: x?.updatedAt ?? null, resetAt: x?.resetAt ?? null, options: x?.options || {} });
    }
  }
  return rows.sort((a, b) => (a.resetAt || 0) - (b.resetAt || 0) || a.name.localeCompare(b.name));
}

// ------------------------------------------------------------------ the food order's setup
export function blankSetup() {
  return { options: [], deadline: null, note: '' };
}

function cleanUrl(v) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw bad('Menu link must be text', 'menuUrl');
  let s = sanitizeText(v).trim();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s.replace(/^\/+/, '')}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw bad('That menu link doesn’t look like a web address', 'menuUrl', 'url');
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname.includes('.') || u.username || u.password) {
    throw bad('Menu links must be web addresses, like https://example.com/menu', 'menuUrl', 'url');
  }
  if (u.href.length > LIMITS.url) throw bad('That menu link is too long', 'menuUrl', 'url');
  return u.href;
}

export function cleanDeadline(v) {
  if (v === undefined || v === null || v === '') return null;
  const m = typeof v === 'string' ? DEADLINE_RE.exec(v.trim()) : null;
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw bad('The deadline must be a time like 18:30', 'deadline', 'deadline');
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

// { options: [{ id?, name, note?, menuUrl? }], deadline?: 'HH:MM' | null, note? }. Options keep
// their ids (votes point at them); new ones get a fresh id. A row with no name, note or link is
// dropped; a row with a note or link but no name is a 400.
export function cleanSetup(input) {
  if (!isObj(input)) throw bad('Bad request', 'order');
  const raw = input.options ?? [];
  if (!Array.isArray(raw)) throw bad('options must be a list', 'options');
  if (raw.length > LIMITS.options) throw bad(`At most ${LIMITS.options} options`, 'options', 'too_many');
  const options = [];
  const ids = new Set();
  for (const o of raw) {
    if (!isObj(o)) throw bad('Each option must be an object', 'options');
    const name = cleanText(o.name, { field: 'name', max: LIMITS.name });
    const note = cleanText(o.note, { field: 'note' });
    const menuUrl = cleanUrl(o.menuUrl);
    if (!name) {
      if (!note && !menuUrl) continue;
      throw bad('Each option needs a name', 'name', 'name');
    }
    let id = typeof o.id === 'string' && ID_RE.test(o.id) && !ids.has(o.id) ? o.id : null;
    while (!id || ids.has(id)) id = crypto.randomBytes(4).toString('hex');
    ids.add(id);
    options.push({ id, name, note, menuUrl });
  }
  return { options, deadline: cleanDeadline(input.deadline), note: cleanText(input.note, { field: 'note', multiline: true }) };
}

export function readSetup(party) {
  const raw = party?.state?.party?.foodOrder;
  if (!isObj(raw)) return { ...blankSetup(), updatedAt: null };
  try {
    return { ...cleanSetup(raw), updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : null };
  } catch {
    return { ...blankSetup(), updatedAt: null };
  }
}

// ------------------------------------------------------------------ the host's view
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const ALLERGEN_OF = new Map();
for (const [key, label, more] of ALLERGENS) for (const v of [key.replace('-', ' '), label, ...more]) ALLERGEN_OF.set(norm(v), { key, label });

// Groups spellings of one thing: the suggested allergens and their usual names, and otherwise
// the same words in any case, punctuation or plural.
export function allergenKey(item) {
  const n = norm(item);
  if (!n) return { key: '', label: 'Not specified' };
  const hit = ALLERGEN_OF.get(n) || ALLERGEN_OF.get(n.replace(/s$/, ''));
  if (hit) return hit;
  return { key: `x:${n.replace(/(\p{L}{3,})s$/u, '$1')}`, label: null };
}
const capital = (s) => (s ? s[0].toLocaleUpperCase() + s.slice(1) : s);

export function personOf(u, party) {
  const { food, updatedAt } = readFood(u);
  const approval = typeof party?.approvalOf === 'function' ? party.approvalOf(u) : u.approval || 'approved';
  return {
    id: u.id, name: u.name, username: u.username, email: u.email ?? null, approval, isHost: !!u.isAdmin, answered: !!food, updatedAt, food, // email: hosts only (SPEC §25b)
    leftAt: Number.isFinite(u.leftAt) ? u.leftAt : null, // left the party (SPEC §33): hosts only
  };
}
export function peopleOf(party) {
  return Object.values(party.state.users).map((u) => personOf(u, party))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.username.localeCompare(b.username));
}

// Tallies over everyone expected to eat (declined accounts are left out; they're still in the
// people list and the CSV, marked as declined).
export function summarize(people, setup = blankSetup()) {
  const counted = people.filter((p) => p.approval !== 'declined');
  // People who have left the party (SPEC §33) need no food: every count, list and the
  // order here are of the people still at the party; those who left are listed apart, and they're
  // counted again as soon as they're back. (The people list and the CSV keep everyone.)
  const here = counted.filter((p) => !Number.isFinite(p.leftAt));
  const answered = here.filter((p) => p.food);
  const zero = (k) => Object.fromEntries(CHOICES[k].map((c) => [c, 0]));
  const s = {
    people: here.length,
    answered: answered.length,
    notAnswered: here.filter((p) => !p.food).map(({ id, name, username, approval, isHost }) => ({ id, name, username, approval, isHost })),
    left: counted.filter((p) => Number.isFinite(p.leftAt)).map(({ id, name, username, leftAt }) => ({ id, name, username, leftAt })),
    diet: zero('diet'), dietOther: [],
    allergies: [], severe: [], noAllergies: 0,
    spice: zero('spice'),
    avoid: [], love: [], drinks: [], notes: [],
    order: { eating: { ...zero('eating'), unanswered: 0 }, hunger: zero('hunger'), votes: [], wishes: [], drinks: [], payment: [], removedPicks: 0 },
  };
  const groups = new Map();
  const votes = new Map(setup.options.map((o, i) => [o.id, { id: o.id, name: o.name, points: 0, first: 0, second: 0, third: 0, count: 0, at: i }]));
  for (const p of answered) {
    const f = p.food;
    const who = { id: p.id, name: p.name };
    if (f.diet) s.diet[f.diet]++;
    if (f.dietOther) s.dietOther.push({ ...who, text: f.dietOther });
    if (f.noAllergies) s.noAllergies++;
    for (const a of f.allergies) {
      const { key, label } = allergenKey(a.item);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { key, label: label || capital(a.item), count: 0, maxSeverity: null, people: [] }));
      g.count++;
      g.people.push({ ...who, item: a.item, severity: a.severity, note: a.note });
      if ((SEVERITY_RANK[a.severity] || 0) > (SEVERITY_RANK[g.maxSeverity] || 0)) g.maxSeverity = a.severity;
      if (a.severity === 'severe') s.severe.push({ ...who, item: a.item, label: g.label, note: a.note });
    }
    if (f.spice) s.spice[f.spice]++;
    for (const k of ['avoid', 'love', 'drinks', 'notes']) if (f[k]) s[k].push({ ...who, text: f[k] });
    const o = f.order;
    if (o.eating) s.order.eating[o.eating]++;
    if (o.eating === 'no') continue;
    if (o.hunger) s.order.hunger[o.hunger]++;
    o.picks.forEach((id, i) => {
      const v = votes.get(id);
      if (!v) {
        s.order.removedPicks++;
        return;
      }
      v.points += LIMITS.picks - i;
      v[['first', 'second', 'third'][i]]++;
      v.count++;
    });
    if (o.wish) s.order.wishes.push({ ...who, text: o.wish });
    if (o.drinks) s.order.drinks.push({ ...who, text: o.drinks });
    if (o.payment) s.order.payment.push({ ...who, text: o.payment });
  }
  const e = s.order.eating;
  e.unanswered = here.length - e.yes - e.snack - e.no;
  s.allergies = [...groups.values()].sort((a, b) => (SEVERITY_RANK[b.maxSeverity] || 0) - (SEVERITY_RANK[a.maxSeverity] || 0)
    || b.count - a.count || (a.key === '') - (b.key === '') || a.label.localeCompare(b.label));
  s.order.votes = [...votes.values()].sort((a, b) => b.points - a.points || b.count - a.count || a.at - b.at).map(({ at, ...v }) => v);
  return s;
}

// ------------------------------------------------------------------ shared answers (SPEC §20d)
// Approved writers and hosts can read what others chose to share; nobody else (404).
export function canSeeShared(u, party) {
  return !!u && (!!u.isAdmin || typeof party?.isApproved !== 'function' || party.isApproved(u));
}
// The opted-in answers of approved accounts: the diet choice and the free-text answers (loves,
// avoids, the specific order, drinks, notes). Never names, ids, times or allergies (nor the diet's
// own "other" text). Read fresh each time, so unticking takes them out at once; shuffled.
export function sharedAnswers(party) {
  const optName = new Map(readSetup(party).options.map((o) => [o.id, o.name]));
  const out = [];
  for (const u of Object.values(party.state.users)) {
    if (typeof party.isApproved === 'function' && !party.isApproved(u)) continue;
    const { food } = readFood(u);
    if (!food || !food.share) continue;
    const o = food.order;
    const order = o.picks.filter((id) => o.lines[id]).map((id) => (optName.has(id) ? `${optName.get(id)}: ${o.lines[id]}` : o.lines[id]));
    if (o.wish) order.push(o.wish);
    const a = { diet: food.diet ? LABELS.diet[food.diet] : null, love: food.love, avoid: food.avoid, order, orderDrinks: o.drinks, drinks: food.drinks, notes: food.notes };
    if (a.diet || a.love || a.avoid || order.length || a.orderDrinks || a.drinks || a.notes) out.push(a);
  }
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function hostData(party, now = Date.now()) {
  const people = peopleOf(party);
  const order = readSetup(party);
  const historyCount = Object.values(party.state.users).reduce((n, u) => n + (Array.isArray(u.foodHistory) ? u.foodHistory.length : 0), 0);
  return { serverNow: now, limits: LIMITS, resetAt: resetAtOf(party), historyCount, order, people, summary: summarize(people, order) };
}

// ------------------------------------------------------------------ CSV
// Spreadsheet apps run a cell that starts with = + - @ (or a tab or carriage return) as a
// formula; such cells get a leading apostrophe. Every cell is quoted.
const FORMULA_START = /^[\s ]*[=+\-@\t\r＝＋－＠]/;
export function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (FORMULA_START.test(s) || /^[\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function stampIn(ms, tz) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(tz ? { timeZone: tz } : {}),
    }).formatToParts(ms).map((p) => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  }
}

export const allergyText = (a) => {
  const sev = a.severity ? LABELS.severity[a.severity].toLowerCase() : '';
  const bits = [sev, a.note].filter(Boolean).join(', ');
  return `${a.item || 'Not specified'}${bits ? ` (${bits})` : ''}`;
};

export function toCsv(people, setup = blankSetup(), { tz = null, lead = [] } = {}) {
  const optName = new Map(setup.options.map((o) => [o.id, o.name]));
  let row = null; // the person being written: a history row carries its own option names
  const pickName = (id) => (id ? row?.options?.[id] || optName.get(id) || 'Removed option' : '');
  const L = (k, v) => (v ? LABELS[k][v] : '');
  const cols = [
    ...lead,
    ['Name', (p) => p.name],
    ['Username', (p) => p.username],
    ['Account', (p) => (p.isHost ? 'host' : p.approval)],
    ['Answered', (p) => (p.food ? 'yes' : 'no')],
    ['Updated', (p) => (p.updatedAt ? stampIn(p.updatedAt, tz) : '')],
    ['Left the party', (p) => (Number.isFinite(p.leftAt) ? stampIn(p.leftAt, tz) : '')], // SPEC §33: no food needed
    ['Eating with us', (p, f) => L('eating', f.order.eating)],
    ['Hunger', (p, f) => L('hunger', f.order.hunger)],
    ['1st choice', (p, f) => pickName(f.order.picks[0])],
    ['2nd choice', (p, f) => pickName(f.order.picks[1])],
    ['3rd choice', (p, f) => pickName(f.order.picks[2])],
    ['Order', (p, f) => f.order.picks.filter((id) => f.order.lines[id]).map((id) => `${pickName(id)}: ${f.order.lines[id]}`).join('; ')],
    ['What they’d like (free text)', (p, f) => f.order.wish],
    ['Drinks for the order', (p, f) => f.order.drinks],
    ['Payment note', (p, f) => f.order.payment],
    ['Diet', (p, f) => (f.diet === 'other' && f.dietOther ? `Other: ${f.dietOther}` : L('diet', f.diet))],
    ['Severe allergies', (p, f) => f.allergies.filter((a) => a.severity === 'severe').map((a) => a.item || 'Not specified').join('; ')],
    ['Allergies and intolerances', (p, f) => (f.allergies.length ? f.allergies.map(allergyText).join('; ') : f.noAllergies ? 'None' : '')],
    ['Avoid or dislike', (p, f) => f.avoid],
    ['Loves', (p, f) => f.love],
    ['Spice', (p, f) => L('spice', f.spice)],
    ['Favourite non-alcoholic drinks', (p, f) => f.drinks],
    ['Anything else', (p, f) => f.notes],
    ['Shared with other writers', (p, f) => (f.share ? 'yes' : 'no')], // SPEC §20d
    ['Email', (p) => p.email || ''], // SPEC §25b: private, hosts only
  ];
  const blank = blankFood();
  const rows = [cols.map(([head]) => csvCell(head)).join(',')];
  for (const p of people) {
    row = p;
    rows.push(cols.map(([, get]) => csvCell(get(p, p.food || blank))).join(','));
  }
  return `﻿${rows.join('\r\n')}\r\n`;
}

// ------------------------------------------------------------------ HTTP
function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) {
      req.resume();
      reject(new FoodError(413, 'That’s too much text to save at once', 'too_large'));
      return;
    }
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) tooBig = true;
      else chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return reject(new FoodError(413, 'That’s too much text to save at once', 'too_large'));
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      let v;
      try {
        v = JSON.parse(text);
      } catch {
        return reject(bad('Invalid JSON'));
      }
      if (!isObj(v)) return reject(bad('Body must be a JSON object'));
      return resolve(v);
    });
    req.on('error', reject);
  });
}

export function createFood({ now = Date.now, log = console, burst = 30, perSecond = 2 } = {}) {
  // Autosave sends at most a couple of saves a second; this only stops a runaway client.
  const buckets = new Map(); // userId -> { tokens, at }
  function take(uid) {
    const t = now();
    const b = buckets.get(uid) || { tokens: burst, at: t };
    b.tokens = Math.min(burst, b.tokens + ((t - b.at) / 1000) * perSecond);
    b.at = t;
    buckets.set(uid, b);
    if (buckets.size > 5000) buckets.clear();
    if (b.tokens < 1) return Math.ceil(((1 - b.tokens) / perSecond) * 1000);
    b.tokens -= 1;
    return 0;
  }

  const json = (h, status, obj) => h.sendJson(status, obj);
  const fail = (h, e) => {
    if (e instanceof FoodError) return json(h, e.status, { error: e.message, code: e.code, ...(e.field ? { field: e.field } : {}) });
    return h.sendError(e);
  };
  const isHostPath = (p, rest) => p === `/api/host/${rest}` || p === `/api/admin/${rest}`;
  const wantsJson = (req) => String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() === 'application/json' && req.headers['x-wh'] === '1';
  const csrf = (req, h) => {
    req.resume();
    return json(h, 403, { error: 'Forbidden: JSON with the X-WH header required', code: 'csrf' });
  };
  const touch = (party) => {
    if (typeof party.touch === 'function') party.touch();
  };
  // SPEC §20b: answers saved before the rules, alcohol and caffeine questions were removed lose
  // them on the stored record too (the host's all-data export copies records as stored). Every
  // view already reads answers through cleanFood, which never returns them. Once per process.
  let scrubbed = false;
  function scrubLegacy(party) {
    if (scrubbed || !isObj(party?.state?.users)) return;
    scrubbed = true;
    let n = 0;
    for (const u of Object.values(party.state.users)) {
      if (!isObj(u.food)) continue;
      for (const k of LEGACY_KEYS) {
        if (Object.hasOwn(u.food, k)) {
          delete u.food[k];
          n++;
        }
      }
    }
    if (n) touch(party);
  }

  const routes = [
    {
      // SPEC §20d: the answers people chose to share, for approved writers and hosts only.
      method: 'GET',
      match: (p) => (p === '/api/food/shared' ? {} : null),
      handle(req, res, h) {
        if (!canSeeShared(h.ctx.user, h.party)) return json(h, 404, { error: 'Not found' });
        return json(h, 200, { answers: sharedAnswers(h.party) });
      },
    },
    {
      method: 'GET',
      match: (p) => (p === '/api/me/food' ? {} : null),
      handle(req, res, h) {
        const u = h.ctx.user;
        if (!u) return json(h, 401, { error: 'Please sign in first', code: 'auth' });
        const { food, updatedAt } = readFood(u);
        return json(h, 200, { userId: u.id, food, updatedAt, resetAt: resetAtOf(h.party), order: readSetup(h.party), limits: LIMITS, serverNow: now(), words: foodWordsOf(u.food), credited: foodCreditOf(u),
          firstHour: !(u.joinedAt && (typeof h.party.isApproved !== 'function' || h.party.isApproved(u))), sharedOk: canSeeShared(u, h.party) });
      },
    },
    {
      method: 'PUT',
      match: (p) => (p === '/api/me/food' ? {} : null),
      async handle(req, res, h) {
        if (!wantsJson(req)) return csrf(req, h);
        const u = h.ctx.user;
        if (!u) {
          req.resume();
          return json(h, 401, { error: 'Please sign in first', code: 'auth' });
        }
        const wait = take(u.id);
        if (wait) {
          req.resume();
          res.setHeader('Retry-After', String(Math.ceil(wait / 1000)));
          return json(h, 429, { error: 'Saving too often; trying again in a moment', code: 'too_fast', retryAfterMs: wait });
        }
        try {
          const body = await readJsonBody(req, LIMITS.bodyBytes);
          const resetAt = resetAtOf(h.party);
          // A form opened before the host's last reset: its answers were cleared on purpose.
          if (resetAt && body.resetAt !== resetAt) {
            const kept = readFood(u);
            return json(h, 409, { error: 'The hosts cleared the food order answers; your other answers are kept.', code: 'reset', resetAt, food: kept.food, updatedAt: kept.updatedAt });
          }
          const food = cleanFood(body);
          const at = now();
          u.food = food ? { ...food, updatedAt: at } : null;
          creditFood(h.party, u, at);
          touch(h.party);
          return json(h, 200, { ok: true, food, updatedAt: food ? at : null, resetAt, words: foodWordsOf(u.food), credited: foodCreditOf(u) });
        } catch (e) {
          return fail(h, e);
        }
      },
    },
    {
      method: 'GET',
      match: (p) => (isHostPath(p, 'food') ? {} : null),
      handle(req, res, h) {
        if (!h.ctx.user?.isAdmin) return json(h, 404, { error: 'Not found' });
        const id = h.url.searchParams.get('id');
        if (id !== null) {
          const u = h.party.userById(id);
          if (!u) return json(h, 404, { error: 'No such writer' });
          return json(h, 200, { person: personOf(u, h.party), order: readSetup(h.party), serverNow: now() });
        }
        return json(h, 200, hostData(h.party, now()));
      },
    },
    {
      method: 'GET',
      match: (p) => (isHostPath(p, 'food.csv') ? {} : null),
      handle(req, res, h) {
        if (!h.ctx.user?.isAdmin) return json(h, 404, { error: 'Not found' });
        const tz = h.party.tz || null;
        const csv = Buffer.from(toCsv(peopleOf(h.party), readSetup(h.party), { tz }), 'utf8');
        const stamp = stampIn(now(), tz).replace(/[ :]/g, '-');
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="writehaven-food-${stamp}.csv"`,
          'Content-Length': csv.length,
          'Cache-Control': 'no-store',
        });
        res.end(req.method === 'HEAD' ? undefined : csv);
        return undefined;
      },
    },
    {
      method: 'GET',
      match: (p) => (isHostPath(p, 'food-history.csv') ? {} : null),
      handle(req, res, h) {
        if (!h.ctx.user?.isAdmin) return json(h, 404, { error: 'Not found' });
        const tz = h.party.tz || null;
        const csv = Buffer.from(toCsv(historyRows(h.party), readSetup(h.party), { tz, lead: [['Reset at', (p) => (p.resetAt ? stampIn(p.resetAt, tz) : '')]] }), 'utf8');
        const stamp = stampIn(now(), tz).replace(/[ :]/g, '-');
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="writehaven-food-history-${stamp}.csv"`,
          'Content-Length': csv.length,
          'Cache-Control': 'no-store',
        });
        res.end(req.method === 'HEAD' ? undefined : csv);
        return undefined;
      },
    },
    {
      method: 'PUT',
      match: (p) => (isHostPath(p, 'food/options') ? {} : null),
      async handle(req, res, h) {
        if (!h.ctx.user?.isAdmin) {
          req.resume();
          return json(h, 404, { error: 'Not found' });
        }
        if (!wantsJson(req)) return csrf(req, h);
        try {
          const setup = cleanSetup(await readJsonBody(req, LIMITS.bodyBytes));
          const at = now();
          h.party.state.party.foodOrder = { ...setup, updatedAt: at };
          if (typeof h.party.addLog === 'function') {
            const n = setup.options.length;
            const what = n ? `${n} option${n === 1 ? '' : 's'}` : 'no options (free text)';
            h.party.addLog('food-order', { by: h.ctx.userId, text: `set up the food order: ${what}${setup.deadline ? `, orders close ${setup.deadline}` : ''}` });
          }
          touch(h.party);
          return json(h, 200, { ok: true, order: { ...setup, updatedAt: at } });
        } catch (e) {
          return fail(h, e);
        }
      },
    },
    {
      method: 'POST',
      match: (p) => (isHostPath(p, 'food/reset') ? {} : null),
      async handle(req, res, h) {
        if (!h.ctx.user?.isAdmin) {
          req.resume();
          return json(h, 404, { error: 'Not found' });
        }
        if (!wantsJson(req)) return csrf(req, h);
        try {
          await readJsonBody(req, LIMITS.bodyBytes);
          const at = Math.max(now(), (resetAtOf(h.party) || 0) + 1);
          const cleared = resetOrders(Object.values(h.party.state.users), at, readSetup(h.party));
          h.party.state.party.foodResetAt = at;
          if (typeof h.party.addLog === 'function') {
            h.party.addLog('food-reset', { by: h.ctx.userId, text: `cleared the food order answers (${cleared} ${cleared === 1 ? 'person' : 'people'} had them); everything else kept, and everyone’s answers saved in the food history` });
          }
          touch(h.party);
          return json(h, 200, { ok: true, cleared, resetAt: at });
        } catch (e) {
          return fail(h, e);
        }
      },
    },
  ];
  for (const r of routes) {
    const inner = r.handle;
    r.handle = (req, res, h) => {
      scrubLegacy(h.party);
      return inner(req, res, h);
    };
  }
  void log;
  return { routes };
}

export function resetAtOf(party) {
  const v = party?.state?.party?.foodResetAt;
  return Number.isFinite(v) ? v : null;
}
