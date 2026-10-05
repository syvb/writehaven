// Food preferences and the food order (SPEC §18, §18b, §20): validation, auth and CSRF, the host's
// tallies, CSV escaping (formula injection), reset, persistence, and privacy (no food or order
// data in any public payload or another writer's).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startApp, client, readSse, sleep, tmpStateFile, makeParty, addUser, typeInto } from './helpers.js';
import { realProse, MIN } from './sim.js';
import {
  createFood, cleanFood, cleanSetup, cleanText, csvCell, toCsv, summarize, allergenKey, blankSetup, LIMITS, CHOICES, LABELS, LEGACY_KEYS,
  foodWords, foodWordsOf, foodCreditOf, creditFood, resetOrders,
} from '../lib/food.js';
import { foodWords as clientFoodWords, foodAnswered, foodComplete, orderList } from '../public/js/food.js';

// PUT with the session cookie (the helpers' client speaks GET and POST).
async function put(base, who, p, body, { headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', 'X-WH': '1', ...headers };
  if (who?.cookie) h.Cookie = who.cookie;
  for (const [k, v] of Object.entries(h)) if (v === null) delete h[k];
  const res = await fetch(base + p, { method: 'PUT', headers: h, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}

async function setup({ approvalRequired = false, food = {} } = {}) {
  const f = createFood(food);
  const ctx = await startApp({ routes: f.routes, approvalRequired });
  const host = client(ctx.base);
  await host.post('/api/register', { username: 'host', password: 'longpassword', name: 'Hosting Person' });
  const mk = async (username, name) => {
    const c = client(ctx.base);
    const r = await c.post('/api/register', { username, password: 'longpassword', name });
    return { c, id: r.json.user.id, username, name };
  };
  return { ...ctx, host, mk };
}

const ANSWERS = {
  diet: 'vegetarian',
  allergies: [{ item: 'Peanuts', severity: 'severe', note: 'carries an EpiPen' }, { item: 'lactose', severity: 'intolerance', note: '' }],
  avoid: 'mushrooms',
  love: 'Ethiopian, Thai',
  spice: 'medium',
  drinks: 'ginger beer',
  notes: 'I’ll bring my own fork',
  order: { eating: 'yes', hunger: 'very', picks: [], lines: {}, wish: 'pizza or Thai', drinks: 'sparkling water', payment: 'happy to chip in £15' },
};

// ------------------------------------------------------------------ validation
test('food: enums, text limits, allergy rows and control characters', () => {
  assert.equal(cleanFood({}), null, 'nothing answered is null');
  assert.equal(cleanFood({ order: {}, allergies: [] }), null);
  const f = cleanFood({ ...ANSWERS, unknownKey: 'ignored' });
  assert.equal(f.diet, 'vegetarian');
  assert.equal(f.allergies.length, 2);
  assert.equal(f.order.eating, 'yes');
  assert.ok(!('unknownKey' in f));
  for (const [k, v] of [['diet', 'carnivore'], ['spice', 'volcanic']]) {
    assert.throws(() => cleanFood({ [k]: v }), (e) => e.status === 400 && e.field === k, k);
  }
  assert.throws(() => cleanFood({ allergies: [{ item: 'x', severity: 'deadly' }] }), (e) => e.status === 400);
  assert.throws(() => cleanFood({ order: { eating: 'maybe' } }), (e) => e.status === 400);
  assert.throws(() => cleanFood({ order: { hunger: 'starving' } }), (e) => e.status === 400);
  assert.throws(() => cleanFood('vegan'), (e) => e.status === 400);
  assert.throws(() => cleanFood({ avoid: 42 }), (e) => e.status === 400);
  // ≤ 300 characters per text field (code points), cut rather than refused.
  const long = 'é'.repeat(1000);
  const cut = cleanFood({ avoid: long, notes: long, drinks: long, allergies: [{ item: long, note: long }], order: { wish: long, picks: ['a1'], lines: { a1: long } } });
  for (const v of [cut.avoid, cut.notes, cut.drinks, cut.allergies[0].item, cut.allergies[0].note, cut.order.wish, cut.order.lines.a1]) assert.equal([...v].length, LIMITS.text);
  // ≤ 12 allergy rows.
  assert.equal(cleanFood({ allergies: Array.from({ length: 12 }, (_, i) => ({ item: `thing ${i}` })) }).allergies.length, 12);
  assert.throws(() => cleanFood({ allergies: Array.from({ length: 13 }, (_, i) => ({ item: `thing ${i}` })) }), (e) => e.status === 400 && e.code === 'too_many');
  // Control and invisible characters go; one-line fields lose line breaks; notes keep one blank line.
  const c = cleanFood({ drinks: 'oat\u0000 milk‮​ latte\r\n', notes: 'one\n\n\n\n two\u0007', allergies: [{ item: 'pea\u0085nuts\n', note: '\u001btraces OK' }] });
  assert.equal(c.drinks, 'oat milk latte');
  assert.equal(c.notes, 'one\n\ntwo');
  assert.equal(c.allergies[0].item, 'peanuts');
  assert.equal(c.allergies[0].note, 'traces OK');
  assert.equal(cleanText('a\tb  c'), 'a b c');
  // Empty rows are dropped; "none" is only true without rows; "other" text only with "other".
  const r = cleanFood({ allergies: [{ item: '', severity: null, note: '' }, { item: '', severity: 'allergy' }], noAllergies: true, diet: 'vegan', dietOther: 'stale' });
  assert.deepEqual(r.allergies, [{ item: '', severity: 'allergy', note: '' }]);
  assert.equal(r.noAllergies, false);
  assert.equal(r.dietOther, '');
  assert.equal(cleanFood({ noAllergies: true }).noAllergies, true);
  // Picks: at most 3, no repeats, ids only; order lines only for picks.
  const o = cleanFood({ order: { picks: ['a', 'b', 'a', 'c'], lines: { a: 'margherita', z: 'not picked', constructor: 'x' } } }).order;
  assert.deepEqual(o.picks, ['a', 'b', 'c']);
  assert.deepEqual(o.lines, { a: 'margherita' });
  assert.throws(() => cleanFood({ order: { picks: ['a', 'b', 'c', 'd'] } }), (e) => e.code === 'too_many');
  assert.throws(() => cleanFood({ order: { picks: ['<script>'] } }), (e) => e.status === 400);
  // Labels exist for every choice (the client and the CSV use them).
  for (const [k, list] of Object.entries(CHOICES)) for (const v of list) assert.ok(LABELS[k][v], `${k}.${v}`);
});

test('food: the order setup (options, menu links, deadline)', () => {
  const s = cleanSetup({
    options: [
      { name: '  Pizza — Franco Manca ', note: 'Sourdough; vegan cheese', menuUrl: 'francomanca.co.uk/menu' },
      { id: 'thai01', name: 'Thai — Busaba', menuUrl: 'https://busaba.com/menu' },
      { name: '', note: '', menuUrl: '' },
    ],
    deadline: '6.30',
    note: 'We order at 18:30.',
  });
  assert.equal(s.options.length, 2);
  assert.equal(s.options[0].name, 'Pizza — Franco Manca');
  assert.equal(s.options[0].menuUrl, 'https://francomanca.co.uk/menu');
  assert.match(s.options[0].id, /^[a-z0-9]{1,24}$/);
  assert.equal(s.options[1].id, 'thai01', 'ids are kept, so votes keep pointing at them');
  assert.equal(s.deadline, '06:30');
  assert.equal(cleanSetup({ options: [], deadline: '' }).deadline, null);
  for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://example.com/menu', 'https://user:pw@example.com', 'pizza']) {
    assert.throws(() => cleanSetup({ options: [{ name: 'x', menuUrl: url }] }), (e) => e.status === 400 && e.field === 'menuUrl', url);
  }
  for (const d of ['25:00', '18:61', 'soon', 1830]) assert.throws(() => cleanSetup({ deadline: d }), (e) => e.field === 'deadline', String(d));
  assert.throws(() => cleanSetup({ options: [{ name: '', menuUrl: 'https://example.com' }] }), (e) => e.code === 'name');
  assert.throws(() => cleanSetup({ options: Array.from({ length: 13 }, (_, i) => ({ name: `o${i}` })) }), (e) => e.code === 'too_many');
  const dup = cleanSetup({ options: [{ id: 'same', name: 'a' }, { id: 'same', name: 'b' }] });
  assert.notEqual(dup.options[0].id, dup.options[1].id);
});

test('food: the removed questions (rules, alcohol, caffeine) are ignored when sent (SPEC §20b)', () => {
  // An open form from before the change still sends them, even with odd values: no 400, just gone.
  const f = cleanFood({ ...ANSWERS, rules: ['halal', 'paleo'], rulesOther: 'x', alcohol: true, caffeine: 'decaf' });
  for (const k of LEGACY_KEYS) assert.ok(!(k in f), k);
  assert.equal(f.diet, 'vegetarian');
  assert.equal(cleanFood({ rules: ['kosher'], rulesOther: 'x', alcohol: 'no', caffeine: 'yes' }), null, 'only removed questions: nothing answered');
  assert.ok(!('rules' in CHOICES) && !('alcohol' in CHOICES) && !('caffeine' in CHOICES));
  const people = [{ id: 'a', name: 'Ana', username: 'ana', approval: 'approved', isHost: false, updatedAt: 1, food: cleanFood({ diet: 'vegan', rules: ['halal'], alcohol: 'no' }) }];
  const s = summarize(people, blankSetup());
  for (const k of ['rules', 'rulesOther', 'alcohol', 'caffeine']) assert.ok(!(k in s), `summary.${k}`);
  const head = toCsv(people, blankSetup()).split('\r\n')[0];
  for (const col of ['Religious', 'rules', 'Alcohol', 'Caffeine']) assert.ok(!head.includes(col), col);
  assert.ok(head.includes('"Favourite non-alcoholic drinks"'), 'drinks stay');
});

test('food: allergens group by item across spellings', () => {
  assert.equal(allergenKey('Peanut').key, 'peanuts');
  assert.equal(allergenKey('PEANUTS!').key, 'peanuts');
  assert.equal(allergenKey('gluten/wheat').key, 'gluten');
  assert.equal(allergenKey('Coeliac').key, 'gluten');
  assert.equal(allergenKey('lactose').key, 'dairy');
  assert.equal(allergenKey('Sulfites').key, 'sulphites');
  assert.equal(allergenKey('almonds').key, allergenKey('Almond').key);
  assert.notEqual(allergenKey('almonds').key, 'tree-nuts');
  assert.equal(allergenKey('  ').key, '');
});

test('food: tallies, weighted votes and the severe list', () => {
  const setup = { ...blankSetup(), options: [{ id: 'p', name: 'Pizza' }, { id: 't', name: 'Thai' }, { id: 's', name: 'Sushi' }] };
  const person = (id, name, food, approval = 'approved') => ({ id, name, username: id, approval, isHost: false, food: food && cleanFood(food), updatedAt: food ? 1 : null });
  const people = [
    person('a', 'Ana', { diet: 'vegan', allergies: [{ item: 'Peanuts', severity: 'severe', note: 'EpiPen' }], order: { eating: 'yes', picks: ['p', 't'] } }),
    person('b', 'Bo', { diet: 'vegan', allergies: [{ item: 'peanut', severity: 'intolerance' }], order: { eating: 'snack', picks: ['t', 'p', 's'] } }),
    person('c', 'Cy', { diet: 'omnivore', order: { eating: 'no', picks: ['s'] } }),
    person('d', 'Di', null),
    person('e', 'Ed', { diet: 'omnivore', order: { picks: ['gone'] } }, 'declined'),
    person('f', 'Fi', { spice: 'hot', noAllergies: true, order: { eating: 'yes', picks: ['gone', 'p'], wish: 'anything' } }),
  ];
  const s = summarize(people, setup);
  assert.equal(s.people, 5, 'declined accounts are left out');
  assert.equal(s.answered, 4);
  assert.deepEqual(s.notAnswered.map((p) => p.name), ['Di']);
  assert.equal(s.diet.vegan, 2);
  assert.equal(s.diet.omnivore, 1);
  assert.equal(s.noAllergies, 1);
  assert.equal(s.allergies[0].key, 'peanuts');
  assert.equal(s.allergies[0].count, 2);
  assert.equal(s.allergies[0].maxSeverity, 'severe');
  assert.deepEqual(s.severe.map((x) => [x.name, x.label, x.note]), [['Ana', 'Peanuts', 'EpiPen']]);
  assert.deepEqual(s.order.eating, { yes: 2, snack: 1, no: 1, unanswered: 1 });
  // Pizza: Ana 1st (3) + Bo 2nd (2) + Fi 2nd (2) = 7; Thai: Ana 2nd (2) + Bo 1st (3) = 5; Sushi: Bo 3rd (1); Cy isn't eating.
  const v = Object.fromEntries(s.order.votes.map((x) => [x.id, x]));
  assert.equal(v.p.points, 7);
  assert.equal(v.p.count, 3);
  assert.equal(v.p.first, 1);
  assert.equal(v.t.points, 5);
  assert.equal(v.s.points, 1);
  assert.deepEqual(s.order.votes.map((x) => x.id), ['p', 't', 's']);
  assert.equal(s.order.removedPicks, 1);
  assert.deepEqual(s.order.wishes.map((x) => x.text), ['anything']);
});

test('food: CSV cells are quoted and formula-safe', () => {
  assert.equal(csvCell('plain'), '"plain"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('a,b\nc'), '"a,b\nc"');
  for (const s of ['=HYPERLINK("http://x","y")', '+1', '-2+3', '@SUM(A1:A2)', '\t=1', '\r=1', ' =1+1', '＝1+1']) {
    assert.ok(csvCell(s).startsWith(`"'`), `${JSON.stringify(s)} gets an apostrophe`);
  }
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell('e-mail me'), '"e-mail me"', 'only a leading sign counts');
  const setup = { ...blankSetup(), options: [{ id: 'p', name: '=Pizza' }] };
  const people = [
    { id: 'a', name: '=cmd|"/c calc"!A1', username: 'ana', approval: 'approved', isHost: false, updatedAt: Date.UTC(2026, 9, 4, 18, 42), food: cleanFood({ diet: 'vegan', avoid: '-mushrooms', allergies: [{ item: '@peanuts', severity: 'severe', note: 'EpiPen' }], order: { eating: 'yes', picks: ['p'], lines: { p: '+margherita' } } }) },
    { id: 'b', name: 'Bo', username: 'bo', approval: 'pending', isHost: false, updatedAt: null, food: null },
  ];
  const csv = toCsv(people, setup, { tz: 'UTC' });
  assert.ok(csv.startsWith('﻿"Name","Username"'), 'BOM and a header');
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines.length, 4, 'header, one row per person, final newline');
  assert.ok(lines[1].startsWith(`"'=cmd|""/c calc""!A1","ana","approved","yes","2026-10-04 18:42"`));
  assert.ok(lines[1].includes(`"'=Pizza"`));
  assert.ok(lines[1].includes(`"'=Pizza: +margherita"`));
  assert.ok(lines[1].includes(`"'-mushrooms"`));
  assert.ok(lines[1].includes(`"'@peanuts"`), 'severe column');
  assert.ok(lines[1].includes(`"'@peanuts (severe allergy, EpiPen)"`));
  assert.ok(lines[2].startsWith('"Bo","bo","pending","no",""'));
  // No unescaped cell anywhere starts a formula.
  for (const line of lines.filter(Boolean)) {
    for (const cell of line.match(/"(?:[^"]|"")*"/g)) assert.ok(!/^"[=+\-@\t\r]/.test(cell), cell);
  }
});

// ------------------------------------------------------------------ HTTP
test('food: sign-in, CSRF and the 300-character limit over HTTP', async (t) => {
  const { base, close, mk } = await setup();
  t.after(close);
  const anon = client(base);
  assert.equal((await anon.get('/api/me/food')).status, 401);
  assert.equal((await put(base, anon, '/api/me/food', { diet: 'vegan' })).status, 401);
  const ana = await mk('ana', 'Ana Ruiz');
  assert.equal((await put(base, ana.c, '/api/me/food', { diet: 'vegan' }, { headers: { 'X-WH': null } })).status, 403, 'no X-WH');
  assert.equal((await put(base, ana.c, '/api/me/food', { diet: 'vegan' }, { headers: { 'X-WH': '0' } })).status, 403);
  assert.equal((await put(base, ana.c, '/api/me/food', 'diet=vegan', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 403, 'a form post');
  assert.equal((await put(base, ana.c, '/api/me/food', '{not json')).status, 400);
  assert.equal((await put(base, ana.c, '/api/me/food', '[1,2]')).status, 400);
  assert.equal((await put(base, ana.c, '/api/me/food', { diet: 'carnivore' })).json.field, 'diet');
  assert.equal((await put(base, ana.c, '/api/me/food', { notes: 'x'.repeat(70 * 1024) })).status, 413);
  const empty = (await ana.c.get('/api/me/food')).json;
  assert.equal(empty.food, null);
  assert.equal(empty.updatedAt, null);
  assert.equal(empty.userId, ana.id);
  assert.deepEqual(empty.order.options, []);
  assert.equal(empty.limits.text, 300);
  const r = await put(base, ana.c, '/api/me/food', { ...ANSWERS, avoid: 'x'.repeat(400) });
  assert.equal(r.status, 200);
  assert.equal(r.json.food.avoid.length, 300);
  assert.ok(r.json.updatedAt > 0);
  const back = (await ana.c.get('/api/me/food')).json;
  assert.equal(back.food.diet, 'vegetarian');
  assert.equal(back.food.allergies[0].severity, 'severe');
  assert.equal(back.food.order.payment, 'happy to chip in £15');
  // Clearing everything stores nothing.
  assert.equal((await put(base, ana.c, '/api/me/food', {})).json.food, null);
  assert.equal((await ana.c.get('/api/me/food')).json.food, null);
  // Other methods aren't routes.
  assert.equal((await ana.c.post('/api/me/food', { diet: 'vegan' })).status, 404);
});

test('food: pending, declined and approved writers can all answer, and edit after approval (§20)', async (t) => {
  const { base, close, host, mk } = await setup({ approvalRequired: true });
  t.after(close);
  const pen = await mk('pen', 'Penny Pending');
  const dec = await mk('dec', 'Declan Declined');
  assert.equal((await host.post('/api/host/decline', { id: dec.id, note: 'Who is this?' })).status, 200);
  for (const w of [pen, dec]) {
    assert.equal((await w.c.get('/api/me')).json.me.approval, w === pen ? 'pending' : 'declined');
    assert.equal((await put(base, w.c, '/api/me/food', { diet: 'vegan', order: { eating: 'yes' } })).status, 200, w.username);
    assert.equal((await w.c.get('/api/me/food')).json.food.diet, 'vegan');
  }
  assert.equal((await host.post('/api/host/approve', { id: pen.id })).status, 200);
  assert.equal((await pen.c.get('/api/me')).json.me.approval, 'approved');
  const edited = await put(base, pen.c, '/api/me/food', { diet: 'pescatarian', order: { eating: 'snack' } });
  assert.equal(edited.status, 200);
  const now = (await pen.c.get('/api/me/food')).json.food;
  assert.equal(now.diet, 'pescatarian');
  assert.equal(now.order.eating, 'snack');
  // The host's own answers work too (hosts eat).
  assert.equal((await put(base, host, '/api/me/food', { diet: 'omnivore' })).status, 200);
});

test('food: host routes are hosts-only; the summary, one person, options and the CSV', async (t) => {
  const { base, close, host, mk, app } = await setup();
  t.after(close);
  const ana = await mk('ana', 'Ana Ruiz');
  const bob = await mk('bob', 'Bob Stone');
  const cy = await mk('cy', 'Cy Quill');
  for (const who of [client(base), ana.c]) {
    for (const p of ['/api/host/food', '/api/admin/food', '/api/host/food.csv', '/api/admin/food.csv', `/api/host/food?id=${ana.id}`]) {
      assert.equal((await who.get(p)).status, 404, p);
    }
    assert.equal((await put(base, who, '/api/host/food/options', { options: [{ name: 'Pizza' }] })).status, 404);
    assert.equal((await who.post('/api/host/food/reset', {})).status, 404);
  }
  // Options: CSRF and validation, then visible to writers in their form.
  assert.equal((await put(base, host, '/api/host/food/options', { options: [] }, { headers: { 'X-WH': null } })).status, 403);
  assert.equal((await put(base, host, '/api/host/food/options', { options: [{ name: 'x', menuUrl: 'javascript:alert(1)' }] })).status, 400);
  const o = await put(base, host, '/api/admin/food/options', {
    options: [{ name: 'Pizza — Franco Manca', menuUrl: 'https://francomanca.co.uk/menu', note: 'Vegan cheese on request' }, { name: 'Thai — Busaba' }],
    deadline: '18:30', note: 'We order at 18:30.',
  });
  assert.equal(o.status, 200);
  const [pizza, thai] = o.json.order.options;
  const seen = (await ana.c.get('/api/me/food')).json.order;
  assert.equal(seen.deadline, '18:30');
  assert.equal(seen.options[0].menuUrl, 'https://francomanca.co.uk/menu');
  assert.ok(app.party.state.log.some((l) => l.type === 'food-order'), 'logged');
  await put(base, ana.c, '/api/me/food', { ...ANSWERS, order: { eating: 'yes', hunger: 'normal', picks: [pizza.id, thai.id], lines: { [pizza.id]: 'margherita' } } });
  await put(base, bob.c, '/api/me/food', { diet: 'vegan', allergies: [{ item: 'peanut', severity: 'allergy' }], order: { eating: 'snack', picks: [thai.id] } });
  const d = (await host.get('/api/host/food')).json;
  assert.deepEqual(d.people.map((p) => p.name), ['Ana Ruiz', 'Bob Stone', 'Cy Quill', 'Hosting Person']);
  assert.equal(d.summary.people, 4);
  assert.equal(d.summary.answered, 2);
  assert.deepEqual(d.summary.notAnswered.map((p) => p.name), ['Cy Quill', 'Hosting Person']);
  assert.equal(d.summary.severe[0].name, 'Ana Ruiz');
  assert.equal(d.summary.allergies[0].key, 'peanuts');
  assert.equal(d.summary.allergies[0].count, 2);
  assert.equal(d.summary.order.votes[0].id, thai.id, 'Thai: 2 (Ana 2nd) + 3 (Bob 1st) = 5 beats Pizza: 3');
  assert.equal(d.summary.order.votes[0].points, 5);
  assert.deepEqual({ yes: d.summary.order.eating.yes, snack: d.summary.order.eating.snack }, { yes: 1, snack: 1 });
  assert.equal(d.order.options.length, 2);
  const one = (await host.get(`/api/host/food?id=${ana.id}`)).json;
  assert.equal(one.person.name, 'Ana Ruiz');
  assert.equal(one.person.food.order.lines[pizza.id], 'margherita');
  assert.equal((await host.get('/api/host/food?id=nobody')).status, 404);
  void cy;
  // The CSV: a download, one row per person.
  const res = await host.get('/api/host/food.csv', { raw: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/csv/);
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="writehaven-food-[\d-]+\.csv"$/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const csv = await res.text();
  assert.equal(csv.trim().split('\r\n').length, 5);
  assert.ok(csv.includes('"Pizza — Franco Manca: margherita"'));
  assert.ok(csv.includes('"Peanuts (severe allergy, carries an EpiPen); lactose (intolerance)"'));
});

test('food: a writer whose answers look like formulas stays harmless in the CSV', async (t) => {
  const { base, close, host, mk } = await setup();
  t.after(close);
  const eve = await mk('eve', '=HYPERLINK("http://x.example","hi")'); // names are cut at 40
  await put(base, eve.c, '/api/me/food', { avoid: '=1+1', love: '+cmd', drinks: '-2', notes: '@SUM(A1)', allergies: [{ item: '=peanuts', note: '\t=x' }], order: { wish: '=WEBSERVICE("http://x")', drinks: '@x', payment: '+44 7700 900000' } });
  const csv = await (await host.get('/api/host/food.csv', { raw: true })).text();
  for (const cell of csv.match(/"(?:[^"]|"")*"/g)) assert.ok(!/^"[=+\-@\t\r]/.test(cell), cell);
  assert.ok(csv.includes(`"'=HYPERLINK(""http://x.example"",""hi"")"`));
  assert.ok(csv.includes(`"'+44 7700 900000"`));
});

test('food: a reset clears the food order only, keeps everything else, saves the old answers in the history, is logged, and stale forms learn what was kept (§20)', async (t) => {
  const { base, close, host, mk, app } = await setup();
  t.after(close);
  const ana = await mk('ana', 'Ana Ruiz');
  const bob = await mk('bob', 'Bob Stone');
  await put(base, host, '/api/host/food/options', { options: [{ name: 'Pizza — Franco Manca' }], deadline: '18:30' });
  const pizza = (await host.get('/api/host/food')).json.order.options[0].id;
  const anaAnswers = { ...ANSWERS, noAllergies: false, share: true, order: { ...ANSWERS.order, picks: [pizza], lines: { [pizza]: 'large margherita' } } };
  await put(base, ana.c, '/api/me/food', anaAnswers);
  await put(base, bob.c, '/api/me/food', { diet: 'vegan', noAllergies: true });
  const before = (await ana.c.get('/api/me/food')).json;
  assert.equal((await host.post('/api/host/food/reset', {}, { headers: { 'X-WH': '0' } })).status, 403, 'CSRF');
  assert.equal((await ana.c.get('/api/me/food')).json.food.order.eating, 'yes', 'nothing cleared without the header');
  const r = await host.post('/api/host/food/reset', {});
  assert.equal(r.status, 200);
  assert.equal(r.json.cleared, 1, 'only Ana had order answers');
  assert.ok(r.json.resetAt > 0);
  // Ana: the order is cleared; diet, allergies, dislikes, favourites, spice, drinks, notes and sharing stay.
  const a = app.party.userById(ana.id).food;
  assert.deepEqual(a.order, { eating: null, hunger: null, picks: [], lines: {}, wish: '', drinks: '', payment: '' });
  for (const k of ['diet', 'avoid', 'love', 'spice', 'drinks', 'notes']) assert.deepEqual(a[k], before.food[k], k);
  assert.deepEqual(a.allergies, before.food.allergies, 'allergies kept');
  assert.equal(a.share, true, 'sharing kept');
  assert.equal(a.updatedAt, before.updatedAt, 'the kept answers keep their time');
  // Bob had no order: unchanged, "none that I know of" included.
  assert.equal(app.party.userById(bob.id).food.diet, 'vegan');
  assert.equal(app.party.userById(bob.id).food.noAllergies, true);
  // The history holds everyone's full answers from before, with the reset time.
  const hist = app.party.userById(ana.id).foodHistory;
  assert.equal(hist.length, 1);
  assert.equal(hist[0].resetAt, r.json.resetAt);
  assert.equal(hist[0].updatedAt, before.updatedAt);
  assert.deepEqual(hist[0].food, before.food, 'the full set, order included');
  assert.deepEqual(hist[0].options, { [pizza]: 'Pizza — Franco Manca' }, 'with the names of the places picked');
  assert.equal(app.party.userById(bob.id).foodHistory.length, 1);
  const host1 = (await host.get('/api/host/food')).json;
  assert.equal(host1.historyCount, 2);
  assert.equal(host1.summary.answered, 2, 'both still count as answered');
  assert.equal(host1.summary.order.eating.yes, 0, 'nobody is down as eating any more');
  assert.equal(host1.summary.severe[0].name, 'Ana Ruiz', 'the severe allergy is still on top');
  assert.equal(host1.order.options[0].name, 'Pizza — Franco Manca', 'the options stay');
  assert.equal(host1.order.deadline, '18:30', 'the deadline stays');
  assert.ok(app.party.state.log.some((l) => l.type === 'food-reset' && /order answers \(1 person/.test(l.text)), 'logged');
  // A second reset adds to the history; it never replaces it.
  await put(base, ana.c, '/api/me/food', { ...anaAnswers, resetAt: r.json.resetAt, order: { eating: 'snack', wish: 'just chips' } });
  const r2 = await host.post('/api/host/food/reset', {});
  assert.equal(r2.json.cleared, 1);
  const hist2 = app.party.userById(ana.id).foodHistory;
  assert.deepEqual(hist2.map((x) => x.food.order.eating), ['yes', 'snack']);
  assert.ok(r2.json.resetAt > r.json.resetAt);
  // The form opens with the kept answers; one opened before the reset learns what was kept.
  const fresh = (await ana.c.get('/api/me/food')).json;
  assert.equal(fresh.food.diet, 'vegetarian');
  assert.equal(fresh.food.order.eating, null);
  assert.equal(fresh.resetAt, r2.json.resetAt);
  const stale = await put(base, ana.c, '/api/me/food', { ...anaAnswers, resetAt: r.json.resetAt });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'reset');
  assert.equal(stale.json.resetAt, r2.json.resetAt);
  assert.equal(stale.json.food.diet, 'vegetarian', 'the 409 carries the kept answers');
  assert.equal(stale.json.food.order.eating, null);
  assert.equal(app.party.userById(ana.id).food.order.eating, null, 'the stale order didn’t come back');
  const ok = await put(base, ana.c, '/api/me/food', { ...fresh.food, order: { eating: 'yes', wish: 'pad thai' }, resetAt: fresh.resetAt });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.food.allergies[0].item, 'Peanuts');
});

test('food: the history is in the host’s all-data export and the history CSV, never anywhere public', async (t) => {
  const { base, close, host, mk } = await setup();
  t.after(close);
  await put(base, host, '/api/host/food/options', { options: [{ name: 'Thai — Busaba' }] });
  const thai = (await host.get('/api/host/food')).json.order.options[0].id;
  await host.post('/api/admin/start', {});
  const ana = await mk('ana', 'Ana Ruiz');
  const bob = await mk('bob', 'Bob Stone');
  await put(base, ana.c, '/api/me/food', { love: 'HISTLOVEZ', order: { eating: 'yes', picks: [thai], lines: { [thai]: 'HISTORDERZ green curry' }, payment: 'HISTPAYZ' } });
  await ana.c.post('/api/join', {});
  const post = (await ana.c.post('/api/post/new', { title: 'A page' })).json.post;
  await ana.c.post('/api/ops', { postId: post.id, pane: 'body', baseVersion: 0, sentAt: Date.now(), ops: [{ at: Date.now(), pos: 0, del: 0, ins: 'Words on the live page.' }] });
  const r = await host.post('/api/host/food/reset', {});
  // Ana's order answers are gone from her current answers, but kept in the history.
  assert.ok(!(await host.get('/api/host/food.csv', { raw: true }).then((x) => x.text())).includes('HISTORDERZ'), 'not in the current CSV');
  const exp = (await host.get('/api/admin/export.json')).json;
  const hist = exp.users.find((u) => u.username === 'ana').foodHistory;
  assert.equal(hist[0].food.order.lines[thai], 'HISTORDERZ green curry', 'in the all-data export');
  assert.equal(hist[0].resetAt, r.json.resetAt);
  const res = await host.get('/api/host/food-history.csv', { raw: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="writehaven-food-history-[\d-]+\.csv"$/);
  const csv = await res.text();
  const lines = csv.replace(/^\ufeff/, '').split('\r\n'); // (fetch drops the byte-order mark)
  assert.ok(lines[0].startsWith('"Reset at","Name"'), 'a reset time first, then the usual columns');
  const anaRow = lines.find((l) => l.includes('"Ana Ruiz"'));
  assert.ok(anaRow.includes('"Thai — Busaba: HISTORDERZ green curry"'), 'with the place’s name as it was');
  assert.ok(anaRow.includes('"HISTPAYZ"'));
  for (const who of [client(base), ana.c, bob.c]) assert.equal((await who.get('/api/host/food-history.csv')).status, 404, 'hosts only');
  // Never public, never another writer's: no history text anywhere.
  const anon = client(base);
  const views = [];
  for (const p of ['/api/live', '/api/session', '/api/archive']) views.push((await anon.get(p)).text);
  for (const p of ['/api/me', '/api/me/food', '/api/session', '/api/food/shared', '/api/live']) views.push((await bob.c.get(p)).text);
  for (const pp of (await anon.get('/api/live')).json.posts) views.push((await anon.get(`/api/p/${pp.id}`)).text);
  for (const v of views) assert.ok(!/HISTORDERZ|HISTPAYZ/.test(v), 'no history in a public or other-writer view');
  assert.ok(!(await ana.c.get('/api/me/food')).text.includes('HISTORDERZ'), 'nor in her own form (it starts a new order)');
});

test('food credit: after a reset, a new order counts and kept words never count twice', () => {
  const { party, clock } = makeParty({ settings: { hourLengthMin: 60 } });
  const host = addUser(party, 'host');
  party.start(host.id);
  const ana = addUser(party, 'ana');
  party.join(ana.id);
  const u = party.userById(ana.id);
  const credit = () => foodCreditOf(u);
  const love = words(10, 0);
  save(party, clock, ana, { love, order: { eating: 'yes', wish: words(6, 100) } });
  assert.equal(credit(), 16);
  resetOrders([u], clock.now());
  assert.equal(credit(), 16, 'a reset never takes credit back');
  assert.equal(u.food.love, love, 'the favourites stay');
  save(party, clock, ana, { love, order: { eating: 'yes', wish: words(6, 200) } });
  assert.equal(credit(), 22, 'the new order’s words count');
  save(party, clock, ana, { love, order: { eating: 'yes', wish: words(6, 200) } });
  assert.equal(credit(), 22, 'saved again: nothing');
  save(party, clock, ana, { order: { eating: 'yes', wish: words(6, 200) } }); // favourites deleted…
  save(party, clock, ana, { love, order: { eating: 'yes', wish: words(6, 200) } }); // …and typed back
  assert.equal(credit(), 22, 'kept words never count twice');
});

test('food: answers saved before §20b lose the removed questions everywhere, the export included', async (t) => {
  const { base, close, host, mk, app } = await setup();
  t.after(close);
  const ana = await mk('ana', 'Ana Ruiz');
  // As stored by the earlier version, before any food route has run in this process.
  app.party.state.users[ana.id].food = {
    ...cleanFood(ANSWERS), rules: ['halal', 'other'], rulesOther: 'OLDRULESZ', alcohol: 'sometimes', caffeine: 'not-after-6pm', updatedAt: Date.now(),
  };
  const mine = await ana.c.get('/api/me/food');
  assert.equal(mine.json.food.diet, 'vegetarian', 'the rest of the answers stay');
  assert.equal(mine.json.food.drinks, 'ginger beer');
  const views = [mine.text, (await host.get('/api/host/food')).text, (await host.get(`/api/host/food?id=${ana.id}`)).text,
    await (await host.get('/api/host/food.csv', { raw: true })).text(), (await host.get('/api/admin/export.json')).text];
  for (const v of views) {
    assert.ok(!v.includes('OLDRULESZ'), 'no old rules text');
    assert.ok(!/"(rules|rulesOther|alcohol|caffeine)"/.test(v), 'no removed keys');
  }
  const stored = app.party.state.users[ana.id].food;
  for (const k of LEGACY_KEYS) assert.ok(!(k in stored), `stored ${k} cleared`);
  assert.equal(stored.diet, 'vegetarian');
  // An old form still sending them saves fine; they're dropped.
  const r = await put(base, ana.c, '/api/me/food', { ...ANSWERS, rules: ['kosher'], alcohol: 'yes', caffeine: 'no' });
  assert.equal(r.status, 200);
  for (const k of LEGACY_KEYS) assert.ok(!(k in r.json.food) && !(k in app.party.state.users[ana.id].food), k);
});

test('food: a runaway client is slowed down (429 with a retry time)', async (t) => {
  const { base, close, mk } = await setup({ food: { burst: 3, perSecond: 1 } });
  t.after(close);
  const ana = await mk('ana', 'Ana');
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await put(base, ana.c, '/api/me/food', { diet: 'vegan' })).status);
  assert.deepEqual(codes.slice(0, 3), [200, 200, 200]);
  assert.equal(codes[4], 429);
  const r = await put(base, ana.c, '/api/me/food', { diet: 'vegan' });
  assert.equal(r.json.code, 'too_fast');
  assert.ok(r.json.retryAfterMs > 0 && r.json.retryAfterMs <= 1000);
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
});

test('food: answers survive a restart and are in the host’s all-data export only', async (t) => {
  const stateFile = tmpStateFile();
  const one = await setup();
  const ana = await one.mk('ana', 'Ana Ruiz');
  await put(one.base, ana.c, '/api/me/food', ANSWERS);
  await put(one.base, one.host, '/api/host/food/options', { options: [{ name: 'Pizza' }], note: 'We order at 18:30.' });
  const json = (await one.host.get('/api/admin/export.json')).json;
  assert.equal(json.users.find((u) => u.username === 'ana').food.diet, 'vegetarian', 'in the all-data export');
  assert.equal(json.party.foodOrder.options[0].name, 'Pizza');
  const md = (await one.host.get('/api/admin/export.md')).text;
  assert.ok(!md.includes('mushrooms') && !md.includes('EpiPen') && !md.includes('Pizza'), 'never in the posts export');
  // Restart from the saved state.
  await one.close();
  fs.copyFileSync(one.stateFile, stateFile);
  const two = await startApp({ stateFile, routes: createFood().routes });
  t.after(two.close);
  const ana2 = client(two.base);
  assert.equal((await ana2.post('/api/login', { username: 'ana', password: 'longpassword' })).status, 200);
  const back = (await ana2.get('/api/me/food')).json;
  assert.equal(back.food.allergies[0].note, 'carries an EpiPen');
  assert.equal(back.order.options[0].name, 'Pizza');
});

test('food: no food or order data in any public payload or another writer’s', async (t) => {
  const { base, close, host, mk, app } = await setup();
  t.after(close);
  // Every field carries a marker that appears nowhere else.
  const M = (k) => `FOODLEAK${k}Z`;
  const marked = {
    diet: 'other', dietOther: M('dietother'),
    allergies: [{ item: M('item'), severity: 'severe', note: M('note') }],
    avoid: M('avoid'), love: M('love'), spice: 'very-hot', drinks: M('drinks'), notes: M('notes'),
  };
  // The order setup is the menu every guest's form shows, so it may reach signed-in people's
  // own food view, but never a public page.
  const S = (k) => `ORDERSETUP${k}Z`;
  await put(base, host, '/api/host/food/options', { options: [{ name: S('optname'), note: S('optnote'), menuUrl: 'https://leakmenu.example/menu' }], deadline: '18:30', note: S('instruction') });
  const opt = (await host.get('/api/host/food')).json.order.options[0];
  await host.post('/api/admin/start', {});
  const ana = await mk('ana', 'Ana Ruiz');
  const bob = await mk('bob', 'Bob Stone');
  const anaAnswers = { ...marked, order: { eating: 'yes', hunger: 'very', picks: [opt.id], lines: { [opt.id]: M('line') }, wish: M('wish'), drinks: M('odrinks'), payment: M('payment') } };
  await put(base, ana.c, '/api/me/food', anaAnswers);
  await put(base, host, '/api/me/food', { notes: M('hostnotes') });
  // Some public writing, so the live page, post pages and the archive have content.
  for (const w of [ana, bob]) {
    await w.c.post('/api/join', {});
    const p = (await w.c.post('/api/post/new', { title: `${w.name}’s page` })).json.post;
    await w.c.post('/api/ops', { postId: p.id, pane: 'body', baseVersion: 0, sentAt: Date.now(), ops: [{ at: Date.now(), pos: 0, del: 0, ins: `Words by ${w.username} on the live page.` }] });
  }
  const streamP = readSse(`${base}/api/live/events`, { ms: 1500 });
  const bobStreamP = readSse(`${base}/api/me/events`, { ms: 1500, cookie: bob.c.cookie });
  await sleep(300);
  await put(base, ana.c, '/api/me/food', { ...anaAnswers, avoid: M('avoid2') }); // a change while the streams are open
  const anon = client(base);
  const payloads = [];
  const grab = async (who, label, p) => payloads.push([`${label} ${p}`, (await who.get(p)).text]);
  for (const p of ['/api/live', '/api/session', '/api/archive']) await grab(anon, 'anon', p);
  for (const p of ['/api/me', '/api/session', '/api/posts', '/api/live', '/api/archive', '/api/me/food']) await grab(bob.c, 'bob', p);
  for (const p of ['/api/host/food', '/api/host/food.csv', '/api/admin/food', `/api/host/food?id=${ana.id}`]) await grab(bob.c, 'bob', p);
  const live = (await anon.get('/api/live')).json;
  assert.ok(live.posts.length >= 2, 'the live page has posts');
  for (const p of live.posts) await grab(anon, 'anon', `/api/p/${p.id}`);
  await host.post('/api/admin/end', {});
  await sleep(200);
  for (const p of ['/api/live', '/api/archive']) await grab(anon, 'anon after end', p);
  const arch = (await anon.get('/api/archive')).json;
  assert.ok(arch.posts.length >= 2, 'the archive has posts');
  for (const p of arch.posts) await grab(anon, 'anon after end', `/api/p/${p.id}`);
  await grab(host, 'host', '/api/admin/export.md');
  payloads.push(['live stream', JSON.stringify(await streamP)]);
  payloads.push(['bob’s me stream', JSON.stringify(await bobStreamP)]);
  for (const [label, text] of payloads) {
    assert.ok(!/FOODLEAK/.test(text), `${label} leaks food data: ${text.match(/FOODLEAK\w+/)?.[0]}`);
    if (label === 'bob /api/me/food') continue; // the order setup is meant for his form
    assert.ok(!/ORDERSETUP|leakmenu\.example/.test(text), `${label} leaks the order setup`);
  }
  // Bob's own food view has the party's order setup (meant for every guest) but nothing of Ana's.
  const bobFood = (await bob.c.get('/api/me/food')).json;
  assert.equal(bobFood.food, null);
  assert.equal(bobFood.userId, bob.id);
  assert.equal(bobFood.order.options[0].name, S('optname'));
  // Sanity: the host does see it all.
  const hostView = (await host.get('/api/host/food')).text;
  for (const k of ['dietother', 'item', 'note', 'avoid2', 'line', 'wish', 'payment', 'hostnotes']) assert.ok(hostView.includes(M(k)), k);
  assert.ok(app.party.state.users[ana.id].food, 'stored on the user record');
});

// ------------------------------------------------------------------ SPEC §20c: food words count
// n words of real prose from word `from` of the test corpus, wrapping round at its end.
const CORPUS = (() => { let n = 0; while (realProse(1, n)) n++; return n; })();
const words = (n, from = 0) => Array.from({ length: n }, (_, i) => realProse(1, (from + i) % CORPUS)).join(' ');
// Save answers the way PUT /api/me/food does (store, then credit), at the party's clock.
function save(party, clock, user, answers) {
  const u = party.userById(user.id);
  const food = cleanFood(answers);
  u.food = food ? { ...food, updatedAt: clock.now() } : null;
  creditFood(party, u, clock.now());
  return food ? foodWords(food) : 0;
}
const hours = (party, user) => party.scoreOf(user.id, { fresh: true }).hours;

test('food words: free-text answers only, the same count on the server and in the form', () => {
  const f = cleanFood({
    diet: 'other', dietOther: 'low FODMAP diet please', allergies: [{ item: 'peanuts and tree nuts', severity: 'severe', note: 'carries an EpiPen always' }],
    love: 'Ethiopian injera', avoid: 'mushrooms', drinks: 'ginger beer', notes: 'I bring dessert',
    order: { eating: 'yes', picks: ['a', 'b'], lines: { a: 'large margherita', b: 'pad thai tofu' }, wish: 'pizza or Thai', drinks: 'sparkling water', payment: 'happy to chip in fifteen pounds' },
  });
  // love 2 + avoid 1 + drinks 2 + notes 3 + lines 2+3 + wish 3 + order drinks 2 = 18; not diet text, allergy rows or the payment note
  assert.equal(foodWords(f), 18);
  assert.equal(clientFoodWords(f), 18, 'the form counts the same words');
  assert.equal(foodWordsOf(f), 18);
  assert.equal(foodWordsOf(null), 0);
});

test('food credit: a save in hour 2 adds exactly its words to hour 2, and can meet it', () => {
  const { party, clock } = makeParty({ settings: { hourLengthMin: 30, targetPerHour: 60 } });
  const host = addUser(party, 'host');
  party.start(host.id);
  const ana = addUser(party, 'ana');
  party.join(ana.id);
  const t0 = clock.now();
  clock.set(t0 + 31 * MIN); // hour 2
  const post = party.newPost(ana.id, {});
  typeInto(party, clock, ana, post, words(40, 3), { cps: 5 });
  clock.advance(2 * MIN);
  const before = hours(party, ana);
  const n = save(party, clock, ana, { love: words(30, 200), avoid: 'mushrooms and coriander' });
  assert.ok(n >= 30, `${n} food words`);
  const after = hours(party, ana);
  assert.equal(after[1].bonus, n, 'credited to hour 2');
  assert.equal(after[1].credit - before[1].credit, n, 'exactly its words');
  assert.equal(after[0].bonus, 0, 'hour 1 untouched');
  assert.ok(before[1].credit < 60 && after[1].credit >= 60, `hour 2 had ${before[1].credit}, now ${after[1].credit}`);
  assert.equal(after[1].flaggedCredit, before[1].flaggedCredit, 'never flagged');
  clock.set(t0 + 62 * MIN);
  party.tick();
  const prog = party.progressOf(ana.id).prog;
  assert.equal(prog.hours[1].status, 'met', 'the food words complete hour 2');
  const me = party.meView(ana.id);
  assert.equal(me.progress.totals.bonus, n, 'the writer sees it in today’s total');
  const hv = party.hostView(host.id).writers.find((w) => w.id === ana.id);
  assert.equal(hv.progress.hours[1].bonus, n, 'the host sees it in the hour’s details');
});

test('food credit: a pending writer’s food words land in hour 1', () => {
  const { party, clock } = makeParty({ settings: { hourLengthMin: 30, targetPerHour: 60, approvalRequired: true } });
  const host = addUser(party, 'host');
  party.start(host.id);
  const pen = addUser(party, 'pen');
  assert.equal(party.approvalOf(party.userById(pen.id)), 'pending');
  const n = save(party, clock, pen, { notes: words(25, 40) });
  clock.advance(45 * MIN); // approved and started much later
  party.approve(host.id, { id: pen.id });
  party.join(pen.id);
  clock.advance(5 * MIN);
  const hs = hours(party, pen);
  assert.equal(hs[0].bonus, n);
  assert.equal(hs[0].credit, n, 'counts towards hour 1');
  assert.equal(party.meView(pen.id).progress.current.k, 0);
});

test('food credit: a high-water mark (re-saving and editing never count twice, editing down and a reset never take it back)', () => {
  const { party, clock } = makeParty({ settings: { hourLengthMin: 60 } });
  const host = addUser(party, 'host');
  party.start(host.id);
  const ana = addUser(party, 'ana');
  party.join(ana.id);
  const u = party.userById(ana.id);
  const credit = () => hours(party, ana).reduce((s, x) => s + x.bonus, 0);
  const a = save(party, clock, ana, { love: words(20, 0) });
  assert.equal(credit(), a);
  save(party, clock, ana, { love: words(20, 0) }); // the same again
  save(party, clock, ana, { love: words(20, 300) }); // different words, as many
  assert.equal(credit(), a, 'no double counting');
  const b = save(party, clock, ana, { love: words(35, 0) });
  assert.equal(credit(), b, 'only the new words');
  save(party, clock, ana, { love: words(5, 0) }); // edited down
  assert.equal(credit(), b, 'never taken back');
  u.food = null; // a host reset
  assert.equal(credit(), b);
  save(party, clock, ana, { love: words(30, 0) });
  assert.equal(credit(), b, 'answering again after a reset adds nothing below the mark');
  assert.equal(foodCreditOf(u), b);
  assert.deepEqual(u.bonusCredit.map((x) => x.source), ['food', 'food']);
});

test('food credit: no cap (SPEC §30): long answers count in full, still once', () => {
  const { party, clock } = makeParty({ settings: { hourLengthMin: 60 } });
  const host = addUser(party, 'host');
  party.start(host.id);
  const ana = addUser(party, 'ana');
  party.join(ana.id);
  const big = { love: words(60, 0), avoid: words(60, 100), notes: words(60, 200) };
  const n = save(party, clock, ana, big);
  assert.ok(n > 150, `${n} words`);
  const total = () => hours(party, ana).reduce((s, x) => s + x.bonus, 0);
  assert.equal(total(), n, 'all of them, past the old 100');
  clock.advance(70 * MIN);
  const m = save(party, clock, ana, { ...big, drinks: words(50, 400) });
  assert.equal(m, n + 50);
  assert.equal(total(), m, 'only the new words, in the next hour');
  assert.equal(hours(party, ana)[1].bonus, 50);
  save(party, clock, ana, big);
  assert.equal(total(), m, 'still a high-water mark');
  assert.equal(party.totals().wordsToday, n, 'the party’s words today follow the current answers, uncapped');
});

test('food credit: kept by a full re-score and in settings previews', async () => {
  const { party, clock } = makeParty({ settings: { hourLengthMin: 30, targetPerHour: 60 } });
  const host = addUser(party, 'host');
  party.start(host.id);
  const ana = addUser(party, 'ana');
  party.join(ana.id);
  const post = party.newPost(ana.id, {});
  typeInto(party, clock, ana, post, words(40, 7), { cps: 5 });
  const n = save(party, clock, ana, { love: words(30, 500) });
  clock.set(party.userById(ana.id).joinedAt + 32 * MIN);
  party.tick();
  assert.equal(party.progressOf(ana.id).prog.hours[0].status, 'met', 'met thanks to the food words');
  party.rebuildEngine({ sync: true });
  assert.equal(hours(party, ana)[0].bonus, n, 'a re-score keeps it');
  assert.equal(party.progressOf(ana.id, { fresh: true }).prog.hours[0].status, 'met');
  const pv = await party.previewSettings(host.id, { patch: { targetPerHour: 60 } });
  assert.deepEqual(pv.changes, [], 'a preview sees the same met hour');
});

test('food words: the party’s words today (public and host) follow saves, edits and resets; pending accounts wait for approval', async (t) => {
  const { base, close, host, mk, app } = await setup({ approvalRequired: true });
  t.after(close);
  const party = app.party;
  const ana = await mk('ana', 'Ana Ruiz');
  const bob = await mk('bob', 'Bob Stone');
  await host.post('/api/host/approve', { id: ana.id });
  const totals = () => [party.totals().wordsToday, party.totals(undefined, { credited: true }).wordsToday];
  const [pub0, host0] = totals();
  const answers = { love: words(12, 0), order: { wish: 'pizza or Thai please' } };
  const n = foodWords(cleanFood(answers));
  assert.equal((await put(base, ana.c, '/api/me/food', answers)).json.words, n);
  assert.deepEqual(totals(), [pub0 + n, host0 + n], 'saving raises both totals by the counted words');
  const hostView = (await host.get('/api/admin/state')).json;
  assert.equal(hostView.party.totals.wordsToday, host0 + n, 'the host view too');
  const m = foodWords(cleanFood({ love: words(5, 0) }));
  await put(base, ana.c, '/api/me/food', { love: words(5, 0) });
  assert.deepEqual(totals(), [pub0 + m, host0 + m], 'editing down lowers them');
  const b = foodWords(cleanFood({ notes: words(9, 50) }));
  await put(base, bob.c, '/api/me/food', { notes: words(9, 50) });
  assert.deepEqual(totals(), [pub0 + m, host0 + m], 'a pending account isn’t counted');
  await host.post('/api/host/approve', { id: bob.id });
  assert.deepEqual(totals(), [pub0 + m + b, host0 + m + b], 'until approved');
  const credited = foodCreditOf(party.userById(ana.id));
  assert.equal(credited, n, 'the hour keeps the high-water mark');
  const o = foodWords(cleanFood({ order: { wish: 'pizza or Thai please' } }));
  await put(base, ana.c, '/api/me/food', { love: words(5, 0), order: { wish: 'pizza or Thai please' } });
  assert.deepEqual(totals(), [pub0 + m + o + b, host0 + m + o + b]);
  assert.equal((await host.post('/api/host/food/reset', {})).status, 200);
  assert.deepEqual(totals(), [pub0 + m + b, host0 + m + b], 'a reset takes out the order’s words only');
  assert.equal(foodCreditOf(party.userById(ana.id)), credited, 'and the hour’s credit stays');
  const me = (await ana.c.get('/api/me/food')).json;
  assert.equal(me.credited, n);
  assert.ok(!('cap' in me), 'no cap any more (SPEC §30)');
  assert.equal(me.firstHour, true, 'not started yet: the form says “your first hour”');
});

test('food credit: survives a restart and a background re-score', async (t) => {
  const stateFile = tmpStateFile();
  const one = await setup();
  const ana = await one.mk('ana', 'Ana Ruiz');
  await ana.c.post('/api/join', {});
  const n = (await put(one.base, ana.c, '/api/me/food', { love: words(15, 0), notes: words(10, 90) })).json.words;
  assert.equal(n, 25);
  assert.equal(one.app.party.scoreOf(ana.id, { fresh: true }).hours[0].bonus, n);
  await one.close();
  fs.copyFileSync(one.stateFile, stateFile);
  const two = await startApp({ stateFile, routes: createFood().routes });
  t.after(two.close);
  assert.equal(two.app.party.scoreOf(ana.id, { fresh: true }).hours[0].bonus, n, 'after a restart');
  const host2 = client(two.base);
  assert.equal((await host2.post('/api/login', { username: 'host', password: 'longpassword' })).status, 200);
  assert.equal((await host2.post('/api/admin/settings', { scoring: { targetPerHour: 450 } })).status, 200);
  for (let i = 0; i < 100 && two.app.party.rescoring; i++) await sleep(50);
  assert.equal(two.app.party.rescoring, false);
  assert.equal(two.app.party.scoreOf(ana.id, { fresh: true }).hours[0].bonus, n, 'after a background re-score');
});

// ------------------------------------------------------------------ SPEC §20d: sharing answers
test('shared answers: approved writers and hosts only; no names, ids, times or allergies; unticking takes them out', async (t) => {
  const { base, close, host, mk, app } = await setup({ approvalRequired: true });
  t.after(close);
  await put(base, host, '/api/host/food/options', { options: [{ name: 'Pizza — Franco Manca' }] });
  const pizza = (await host.get('/api/host/food')).json.order.options[0].id;
  const ana = await mk('ana', 'Anastasia Quill');
  const bob = await mk('bob', 'Bartholomew Ink');
  const pen = await mk('pen', 'Penelope Pending');
  const dec = await mk('dec', 'Declan Declined');
  await host.post('/api/host/approve', { id: ana.id });
  await host.post('/api/host/approve', { id: bob.id });
  await host.post('/api/host/decline', { id: dec.id });
  const anaAnswers = {
    share: true, diet: 'other', dietOther: 'SECRETDIETOTHER', love: 'Ethiopian injera', avoid: 'coriander', drinks: 'ginger beer', notes: 'I bring dessert',
    allergies: [{ item: 'SECRETALLERGY peanuts', severity: 'severe', note: 'SECRETNOTE EpiPen' }],
    order: { eating: 'yes', picks: [pizza], lines: { [pizza]: 'large margherita' }, drinks: 'sparkling water', payment: 'SECRETPAYMENT' },
  };
  assert.equal((await put(base, ana.c, '/api/me/food', anaAnswers)).status, 200);
  await put(base, bob.c, '/api/me/food', { diet: 'vegan', love: 'BOB-NOT-SHARED' }); // not ticked
  await put(base, pen.c, '/api/me/food', { share: true, love: 'PENDING-SHARED' }); // ticked, but not approved
  // Who may read it.
  assert.equal((await client(base).get('/api/food/shared')).status, 404, 'signed out');
  assert.equal((await pen.c.get('/api/food/shared')).status, 404, 'pending');
  assert.equal((await dec.c.get('/api/food/shared')).status, 404, 'declined');
  assert.equal((await pen.c.get('/api/me/food')).json.sharedOk, false);
  assert.equal((await bob.c.get('/api/me/food')).json.sharedOk, true);
  const r = await bob.c.get('/api/food/shared');
  assert.equal(r.status, 200);
  assert.equal((await host.get('/api/food/shared')).status, 200, 'hosts too');
  // What it holds: Ana's opted-in answers only, without anything that identifies her.
  assert.deepEqual(r.json.answers, [{
    diet: 'Other', love: 'Ethiopian injera', avoid: 'coriander', drinks: 'ginger beer', notes: 'I bring dessert',
    order: ['Pizza — Franco Manca: large margherita'], orderDrinks: 'sparkling water',
  }]);
  for (const bad of ['SECRET', 'Anastasia', 'anastasia', 'Quill', ana.id, '"ana"', 'BOB-NOT-SHARED', 'PENDING-SHARED', 'updatedAt', 'EpiPen', 'peanuts']) {
    assert.ok(!r.text.includes(bad), `the shared list leaks ${bad}`);
  }
  // Unticking takes them out at once.
  await put(base, ana.c, '/api/me/food', { ...anaAnswers, share: false });
  assert.deepEqual((await bob.c.get('/api/food/shared')).json.answers, []);
  assert.equal(app.party.userById(ana.id).food.share, false);
  // A lone tick isn't an answer.
  assert.equal((await put(base, bob.c, '/api/me/food', { share: true })).json.food, null);
});

test('shared answers: shuffled per request', async (t) => {
  const { base, close, mk } = await setup();
  t.after(close);
  const people = [];
  for (let i = 0; i < 6; i++) {
    const w = await mk(`w${i}`, `Writer ${i}`);
    await put(base, w.c, '/api/me/food', { share: true, love: `dish number ${i}` });
    people.push(w);
  }
  const seen = new Set();
  for (let i = 0; i < 12; i++) seen.add((await people[0].c.get('/api/food/shared')).json.answers.map((a) => a.love).join('|'));
  assert.ok(seen.size > 1, 'the order changes between requests');
  for (const order of seen) assert.equal(order.split('|').length, 6);
});

// ------------------------------------------------------------------ SPEC §20e: the moment of approval
test('the approval notice: unanswered, not complete, or complete (whether they eat, and what they’d like)', () => {
  assert.equal(foodAnswered(null), false);
  assert.equal(foodAnswered({ share: true }), false, 'a lone tick isn’t an answer');
  assert.equal(foodAnswered({ avoid: 'mushrooms' }), true);
  assert.equal(foodComplete({ avoid: 'mushrooms' }), false, 'the order part is the main part');
  assert.equal(foodComplete({ order: { eating: 'yes' } }), false, 'eating, but nothing chosen');
  assert.equal(foodComplete({ order: { eating: 'yes', picks: ['p'] } }), true);
  assert.equal(foodComplete({ order: { eating: 'snack', wish: 'pizza or Thai' } }), true);
  assert.equal(foodComplete({ order: { eating: 'no' } }), true, 'not eating: nothing to choose');
  assert.equal(foodComplete({ order: { picks: ['p'] } }), false, 'picked, but didn’t say whether they’re eating');
});

// ------------------------------------------------------------------ SPEC §33: people who left the party
test('food: people who left the party are marked in the CSV and left out of the order, the tallies, “not answered” and the severe banner; back, they count again', async (t) => {
  const { base, close, host, mk, app } = await setup();
  t.after(close);
  await put(base, host, '/api/host/food/options', { options: [{ name: 'Pizza — Franco Manca' }] });
  const pizza = (await host.get('/api/host/food')).json.order.options[0].id;
  await host.post('/api/admin/start', {});
  const ana = await mk('ana', 'Ana Ruiz');
  const bob = await mk('bob', 'Bob Stone');
  const cy = await mk('cy', 'Cy Quill');
  await put(base, ana.c, '/api/me/food', { allergies: [{ item: 'Peanuts', severity: 'severe' }], order: { eating: 'yes', picks: [pizza], lines: { [pizza]: 'margherita' } } });
  await put(base, bob.c, '/api/me/food', { order: { eating: 'yes', picks: [pizza], lines: { [pizza]: 'diavola' } } });
  // cy never answers
  const before = (await host.get('/api/host/food')).json;
  assert.equal(before.summary.order.votes[0].points, 6);
  assert.deepEqual(before.summary.notAnswered.map((p) => p.name).sort(), ['Cy Quill', 'Hosting Person']);
  // Ana leaves; so does Cy (who never answered).
  assert.equal((await host.post('/api/admin/writer/left', { id: ana.id, left: true })).status, 200);
  assert.equal((await cy.c.post('/api/me/left', { left: true })).status, 200);
  const left = (await host.get('/api/host/food')).json;
  const anaRow = left.people.find((p) => p.id === ana.id);
  assert.ok(anaRow.leftAt > 0, 'hosts get leftAt per person');
  assert.equal(left.summary.order.votes[0].points, 3, 'only Bob’s vote is left');
  assert.equal(left.summary.order.eating.yes, 1);
  assert.deepEqual(left.summary.severe, [], 'the severe banner is for people still here');
  assert.deepEqual(left.summary.notAnswered.map((p) => p.name), ['Hosting Person'], 'Cy left: not “hasn’t answered”');
  assert.deepEqual(left.summary.left.map((p) => p.name).sort(), ['Ana Ruiz', 'Cy Quill']);
  const list = orderList(left.people, left.order);
  assert.deepEqual(list.groups[0].lines.map((l) => l.name), ['Bob Stone'], 'the order list leaves Ana out');
  assert.ok(!list.text.includes('Ana Ruiz'), 'so does the copied text');
  // The CSV keeps everyone, with the time they left.
  const csv = (await (await host.get('/api/host/food.csv', { raw: true })).text()).replace(/^\ufeff/, '');
  const rows = csv.split('\r\n');
  const head = rows[0].split('","');
  const col = head.indexOf('Left the party');
  assert.ok(col > 0, 'a “Left the party” column');
  const cell = (name) => rows.find((r) => r.startsWith(`"${name}"`)).split('","')[col];
  assert.match(cell('Ana Ruiz'), /^\d{4}-\d\d-\d\d \d\d:\d\d$/, 'the local time they left');
  assert.equal(cell('Bob Stone'), '', 'empty for people still here');
  // Back at the party: counted again, at once.
  assert.equal((await host.post('/api/admin/writer/left', { id: ana.id, left: false })).status, 200);
  const back = (await host.get('/api/host/food')).json;
  assert.equal(back.summary.order.votes[0].points, 6);
  assert.equal(back.summary.severe[0].name, 'Ana Ruiz');
  assert.ok(orderList(back.people, back.order).groups[0].lines.some((l) => l.name === 'Ana Ruiz'));
  assert.deepEqual(back.summary.left.map((p) => p.name), ['Cy Quill']);
  // Nothing new anywhere else: no leftAt in the writers' own food views or the shared answers.
  for (const v of [(await bob.c.get('/api/me/food')).text, (await bob.c.get('/api/food/shared')).text, (await client(base).get('/api/live')).text]) {
    assert.ok(!v.includes('leftAt') || !v.includes(String(anaRow.leftAt)), 'no food-side leftAt outside the host’s food view');
  }
  assert.equal((await bob.c.get('/api/host/food')).status, 404);
  void app;
});
