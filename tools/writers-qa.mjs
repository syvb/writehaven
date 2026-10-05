#!/usr/bin/env node
// Browser check of the public list of writers and personal pages (SPEC §28), desktop and phone,
// light and dark: the live page's and the anthology's "Writers" links; /writers (who's listed,
// in what order, with what line, and who isn't: a pending account and someone who never opted
// in); /w/<id> (signed pieces only, newest first; an empty page; one that was left); signed post
// pages linking "More by <name>" (and unsigned ones never); "Your account" turning it on and off;
// no username, email or account id in any public page. Screenshots go to qa/after/writers-*.png.
// One Chromium, closed at the end; the server runs in this process on a scratch state file with
// its own clock, so four hours of the party are written in seconds.
//   timeout 300 node tools/writers-qa.mjs [--port 8301] [--dir <scratch dir>] [--out qa/after]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createApp } from '../server.js';
import { attachAccounts } from '../lib/accounts.js';
import { attachWriters } from '../lib/writers.js';
import { newSessionToken } from '../lib/auth.js';
import { PARAGRAPHS } from '../test/sim.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const CHROME = process.env.CHROME_PATH || undefined; // unset: Playwright's own Chromium
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const PORT = Number(arg('port', 8301));
const OUT = path.resolve(ROOT, arg('out', 'qa/after'));
const DIR = path.resolve(arg('dir', os.tmpdir()));
fs.mkdirSync(DIR, { recursive: true });
const STATE = path.join(fs.mkdtempSync(path.join(DIR, 'wh-writers-qa-')), 'state.json');
const BASE = `http://127.0.0.1:${PORT}`;
fs.mkdirSync(OUT, { recursive: true });

const DEVICES = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};
const problems = [];
const shots = [];
const t0 = Date.now();
const say = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const check = (ok, msg) => {
  if (!ok) problems.push(msg);
  say(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
};
async function step(label, fn) {
  say(`start ${label}`);
  let timer;
  try {
    await Promise.race([fn(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label}: no progress in 60 s`)), 60_000); })]);
  } catch (e) {
    problems.push(`${label}: ${e.message}`);
    say(`FAIL ${label}: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- the party, on its own clock
// Sunday 4 October 2026, 18:00 in London. The clock runs at real speed from there plus whatever
// the simulated typing and waiting add.
const H0 = Date.UTC(2026, 9, 4, 17, 0, 0);
const HOUR = 3600_000;
const MIN = 60_000;
let off = H0 - Date.now();
const now = () => Date.now() + off;
const setClock = (t) => { off = Math.max(off, t - Date.now()); };
const advance = (ms) => { off += ms; };

const quiet = { error: (...a) => console.error('[server]', ...a), log() {}, warn() {} };
const app = createApp({ stateFile: STATE, log: quiet, now, testKnobs: true, tz: 'Europe/London', fsync: false });
attachAccounts(app);
attachWriters(app);
await app.start(PORT);
say(`server ${BASE}, state ${STATE}`);
const P = app.party;
Object.assign(P.state.settings.scoring, { hoursMode: 'synced', targetPerHour: 10, approvalRequired: true });
P.rebuildEngine({ sync: true });

const people = {};
function person(key, username, name, { approve = true } = {}) {
  const u = P.register(P.validateRegistration({ username, password: 'longpassword', name, email: `${username}@example.org` }), 'scrypt$fake');
  if (approve && people.host) P.approve(people.host.id, { id: u.id });
  const token = newSessionToken();
  P.createSession(u.id, token);
  people[key] = { id: u.id, username, name, cookie: `wh_sess=${token}`, u };
  return people[key];
}
person('host', 'robin', 'Robin');
P.setPartyName(people.host.id, 'Sunday Writing Party');
person('ada', 'abrennan', 'Ada Brennan');
person('ben', 'bokafor', 'Ben Okafor');
person('cora', 'clind', 'Cora Lind');
person('dev', 'draman', 'Dev Raman');
person('elodie', 'emarchetti', 'Élodie Marchetti');
person('farah', 'fhaddad', 'Farah Haddad');
person('mira', 'msato', 'Mira Sato'); // never opts in
person('ines', 'iduarte', 'Ines Duarte', { approve: false }); // opts in, but waits for approval

// Typing, a character at a time with an uneven rhythm (about 4 a second).
function type(who, post, text) {
  let pending = [];
  const flush = () => {
    if (!pending.length) return;
    const p = P.state.posts[post.id];
    P.applyOps(who.id, { postId: post.id, pane: 'body', baseVersion: p.ver.body, seq: crypto.randomUUID().slice(0, 12), ops: pending });
    pending = [];
  };
  let len = P.state.posts[post.id].body.length;
  for (const ch of text) {
    pending.push({ pos: len, del: 0, ins: ch });
    len += ch.length;
    if (pending.length >= 6) flush();
    advance(250 * (0.6 + Math.random() * 0.8));
  }
  flush();
}
function post(who, title, privacy = 'live') {
  const p = P.newPost(who.id, { title });
  if (privacy !== 'live') P.updatePost(who.id, { id: p.id, privacy });
  return p;
}
// Distinct stretches of real prose for unsigned writing (no two writers share a sentence).
const WORDS = PARAGRAPHS.join(' ').split(' ');
let cursor = 0;
const prose = (n) => {
  const s = WORDS.slice(cursor, cursor + n).join(' ');
  cursor += n;
  return s;
};

const SIGNED = {
  lighthouse: 'Every night the lamp turned, and every night the sea answered with the same grey patience. The keeper kept a ledger of ships that never came: their names, their cargo, the weather they would have met. By spring the ledger was thicker than the Bible on the shelf, and he had begun to worry that the ships were real and simply late.',
  salt: 'My grandmother wrote letters she never posted. She folded them into the salt jar, one a week, so that every pinch of salt for forty years came with a sentence nobody would read. When we emptied the kitchen we found them all, soft as moths, and read them aloud at the table, seasoning nothing.',
  bus: 'The night bus runs until dawn, and after two in the morning it belongs to nurses, bakers and one man who reads the same paperback every shift. Nobody talks. The driver plays the radio low, and when the song is good the whole bus leans a little towards the front, as if the music were warmer there.',
  light: 'I meant to write about the sea, but the window shows only the car park, so this is about the car park: four puddles, a trolley on its side, and one gull that has decided it owns all of it.',
  drawer: 'Three rubber bands, a birthday candle shaped like a seven, the key to a bicycle lock we threw away years ago, a menu for a restaurant that is now a launderette, and a pencil sharpened at both ends by someone in this house who refuses to confess.',
  map: 'At four in the morning the city is a map with the names rubbed off. You find your way by the bakeries, which are already lit, and by the foxes, which are still not sure whether the day has started.',
};

const { ada, ben, cora, dev, elodie, farah, mira, ines, host } = people;
const posts = {};
setClock(H0);
P.start(host.id);
// Hour 1 (18:00–19:00 London).
setClock(H0 + MIN);
for (const w of [ada, ben, cora, mira]) P.join(w.id);
setClock(H0 + 5 * MIN);
posts.lighthouse = post(ada, 'The lighthouse keeper', 'named');
type(ada, posts.lighthouse, SIGNED.lighthouse);
posts.bus = post(ben, 'Notes from the night bus', 'named');
type(ben, posts.bus, SIGNED.bus);
posts.light = post(cora, 'First light', 'named');
type(cora, posts.light, SIGNED.light);
posts.miraAnon = post(mira, 'Weather for one');
type(mira, posts.miraAnon, prose(16));
// Hour 2: Ben misses it (and the host brings him back in); Cora stops writing.
setClock(H0 + HOUR + 3 * MIN);
P.tick();
setClock(H0 + HOUR + 5 * MIN);
posts.adaAnon = post(ada, 'Harbour, unsigned');
type(ada, posts.adaAnon, prose(16));
posts.map = post(mira, 'A map of small hours', 'named');
type(mira, posts.map, SIGNED.map);
type(ben, (posts.benAnon = post(ben, 'Ferry crossing')), prose(4));
// Hour 3: Élodie arrives; once Ben's missed hour has settled and put him out, the host brings him back.
setClock(H0 + 2 * HOUR + 3 * MIN);
P.tick();
check(P.userById(ben.id).out === true, 'seed: Ben missed hour 2');
P.adminWriter(host.id, { id: ben.id, out: false });
P.join(elodie.id);
setClock(H0 + 2 * HOUR + 5 * MIN);
posts.salt = post(ada, 'Salt and paper', 'named');
type(ada, posts.salt, SIGNED.salt);
type(ben, posts.benAnon, ` ${prose(16)}`);
posts.drawer = post(elodie, 'Inventory of a kitchen drawer', 'named');
type(elodie, posts.drawer, SIGNED.drawer);
type(mira, posts.map, ` ${prose(14)}`);
// Hour 4: Dev arrives.
setClock(H0 + 3 * HOUR + 3 * MIN);
P.tick();
P.join(dev.id);
setClock(H0 + 3 * HOUR + 5 * MIN);
type(ada, posts.adaAnon, ` ${prose(16)}`);
type(ben, posts.benAnon, ` ${prose(16)}`);
posts.devAnon = post(dev, 'Untitled draft');
type(dev, posts.devAnon, prose(16));
posts.elodieAnon = post(elodie, 'Second thoughts');
type(elodie, posts.elodieAnon, prose(16));
// Hour 5 under way: Farah arrives and starts.
setClock(H0 + 4 * HOUR + 3 * MIN);
P.tick();
P.join(farah.id);
setClock(H0 + 4 * HOUR + 5 * MIN);
posts.farahAnon = post(farah, 'Small hours');
type(farah, posts.farahAnon, prose(10));
setClock(H0 + 4 * HOUR + 8 * MIN);
P.tick();
// Everyone but Mira opts in (Ines while still waiting for approval).
for (const w of [ada, ben, cora, dev, elodie, farah, ines]) if (w !== dev) P.setPublicProfile(w.id, true);
const pid = (w) => P.userById(w.id).publicProfile?.id;
for (const w of [ada, ben, cora, elodie, farah]) {
  const pr = P.progressOf(w.id, { fresh: true });
  say(`${w.name}: ${pr ? pr.prog.hours.map((x) => x.status).join(' ') : 'not started'}; out ${!!P.userById(w.id).out}`);
}

// ---------------------------------------------------------------- browser
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
async function pageFor(device, cookie = null, theme = 'light') {
  const ctx = await browser.newContext({ ...DEVICES[device], reducedMotion: 'reduce', colorScheme: theme });
  if (cookie) {
    const [k, v] = cookie.split('=');
    await ctx.addCookies([{ name: k, value: v, url: BASE }]);
  }
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of (40[0-9]|409|429)/.test(m.text())) problems.push(`${device}: console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`${device}: page error: ${e.message}`));
  return page;
}
async function shot(page, name, { full = false } = {}) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  const file = path.join(OUT, `writers-${name}.png`);
  await page.screenshot({ path: file, fullPage: full });
  shots.push(path.relative(ROOT, file));
}
// Nothing that identifies an account on any public page (usernames, emails, account ids), and
// on the list and the writers' pages, nothing of their unsigned posts either (whose titles are
// public, without a name, on the live page and in the anthology).
const ACCOUNT = [...Object.values(people).flatMap((w) => [w.username, `${w.username}@example.org`, w.id]), '@example.org'];
const UNSIGNED = ['Harbour, unsigned', 'Ferry crossing', 'Weather for one', 'Untitled draft', 'Second thoughts', 'Small hours'];
async function noSecrets(page, label, { unsigned = true } = {}) {
  const html = await page.content();
  const leaks = [...ACCOUNT, ...(unsigned ? UNSIGNED : [])].filter((s) => html.includes(s));
  check(!leaks.length, `${label}: no username, email or account id${unsigned ? ', nor any unsigned title,' : ''} in the page${leaks.length ? ` (found ${leaks.join(', ')})` : ''}`);
}
const rowsOf = (page) => page.locator('.wr-row').evaluateAll((els) => els.map((el) => [el.querySelector('.wr-name').textContent, el.querySelector('.wr-rate').textContent]));
const EXPECTED = [
  ['Ada Brennan', '4 of 4 hours met'],
  ['Ben Okafor', '3 of 4 hours met'],
  ['Cora Lind', '1 of 4 hours met · out of the challenge'],
  ['Élodie Marchetti', '2 of 2 hours met'],
  ['Farah Haddad', 'No hours judged yet'],
];

await step('the live page links to the writers (desktop and phone)', async () => {
  for (const device of ['desktop', 'phone']) {
    const page = await pageFor(device);
    await page.goto(`${BASE}/live`, { waitUntil: 'load' });
    const link = page.locator('.l-mast-nav a[href="/writers"]');
    await link.waitFor();
    check(await link.isVisible() && (await link.textContent()) === 'Writers', `${device}: “Writers” in the live page's header`);
    await page.locator('.l-card').first().waitFor();
    await shot(page, `live-header-${device}`);
    await noSecrets(page, `${device}: the live page`, { unsigned: false });
    await page.context().close();
  }
});

await step('/writers: who is listed, in what order, with what line', async () => {
  for (const [device, theme] of [['desktop', 'light'], ['phone', 'light'], ['phone', 'dark'], ['desktop', 'dark']]) {
    const page = await pageFor(device, null, theme);
    await page.goto(`${BASE}/writers`, { waitUntil: 'load' });
    await page.locator('.wr-row').first().waitFor();
    const rows = await rowsOf(page);
    if (theme === 'light') {
      check(JSON.stringify(rows) === JSON.stringify(EXPECTED), `${device}: the list, by name: ${JSON.stringify(rows)}`);
      check(!rows.some(([n]) => /Ines|Mira|Dev/.test(n)), `${device}: not listed: Ines (waiting for approval, opted in), Mira (never opted in), Dev (not yet)`);
      check((await page.title()) === 'Sunday Writing Party: the writers', `${device}: the tab title`);
      check(await page.locator('.wr-row a').first().getAttribute('href') === `/w/${pid(ada)}`, `${device}: each name links to its page`);
      await noSecrets(page, `${device}: /writers`);
    }
    await shot(page, `list-${device}${theme === 'dark' ? '-dark' : ''}`, { full: true });
    await page.context().close();
  }
});

await step('/writers updates by itself: someone leaving disappears from an open page', async () => {
  const page = await pageFor('desktop');
  await page.goto(`${BASE}/writers`, { waitUntil: 'load' });
  await page.locator('.wr-row', { hasText: 'Farah Haddad' }).waitFor();
  const t = Date.now();
  P.setPublicProfile(farah.id, false);
  await page.locator('.wr-row', { hasText: 'Farah Haddad' }).waitFor({ state: 'detached', timeout: 25_000 });
  check(true, `desktop: gone from the open list after ${((Date.now() - t) / 1000).toFixed(1)} s, with no reload`);
  P.setPublicProfile(farah.id, true);
  await page.context().close();
});

await step('/w/<id>: a writer’s page holds only the pieces they signed', async () => {
  for (const [device, theme] of [['desktop', 'light'], ['phone', 'light'], ['desktop', 'dark']]) {
    const page = await pageFor(device, null, theme);
    await page.goto(`${BASE}/w/${pid(ada)}`, { waitUntil: 'load' });
    await page.locator('.wp-entry').first().waitFor();
    if (theme === 'light') {
      check((await page.locator('.wp-name').textContent()) === 'Ada Brennan', `${device}: the name`);
      check((await page.locator('.wp-rate').textContent()) === '4 of 4 hours met', `${device}: the hours line`);
      const titles = await page.locator('.wp-entry .a-entry-title').allTextContents();
      check(JSON.stringify(titles) === JSON.stringify(['Salt and paper', 'The lighthouse keeper']), `${device}: signed pieces, newest first (${titles.join(', ')})`);
      check(await page.locator('.wp-entry a').first().getAttribute('href') === `/p/${P.state.posts[posts.salt.id].publicId}`, `${device}: each links to its post page`);
      check((await page.title()) === 'Ada Brennan: Sunday Writing Party', `${device}: the tab title`);
      await noSecrets(page, `${device}: Ada's page`);
    }
    await shot(page, `page-${device}${theme === 'dark' ? '-dark' : ''}`, { full: true });
    await page.context().close();
  }
  const page = await pageFor('phone');
  await page.goto(`${BASE}/w/${pid(farah)}`, { waitUntil: 'load' });
  await page.locator('.wr-none').waitFor();
  check((await page.locator('.wr-none').textContent()) === 'No signed pieces yet.', 'phone: a page with nothing signed says so');
  await shot(page, 'page-empty-phone', { full: true });
  await page.goto(`${BASE}/w/${pid(cora)}`, { waitUntil: 'load' });
  await page.locator('.wp-entry').first().waitFor();
  check((await page.locator('.wp-rate').textContent()) === '1 of 4 hours met · out of the challenge', 'phone: out of the challenge, shown honestly');
  await shot(page, 'page-out-phone', { full: true });
  for (const bad of [`${BASE}/w/${pid(ines)}`, `${BASE}/w/notarealpage`]) {
    await page.goto(bad, { waitUntil: 'load' });
    await page.locator('.p-missing').waitFor();
    check(/no public page at this address/.test(await page.locator('.p-missing').textContent()), `phone: ${bad.slice(BASE.length)} is not here (pending, unknown)`);
  }
  await shot(page, 'page-unknown-phone');
  await page.context().close();
});

await step('stars (SPEC §28b): from the editor’s tab menu; the page leads with them; nothing else shows one', async () => {
  const tabOf = (page, p) => page.locator(`.w-tab[data-id="${p.id}"] .w-tab-btn`);
  const editor = await pageFor('desktop', ada.cookie);
  await editor.goto(`${BASE}/write`, { waitUntil: 'load' });
  await tabOf(editor, posts.lighthouse).waitFor();
  await tabOf(editor, posts.lighthouse).click({ button: 'right' });
  const item = editor.locator('.menu-tab .menu-item', { hasText: 'Star on my page' });
  await item.waitFor();
  check(!(await item.locator('.menu-hint').count()), 'desktop: a signed post’s menu offers “Star on my page”');
  await shot(editor, 'stars-menu-desktop');
  await item.click();
  await editor.locator('.toast', { hasText: 'Starred: it comes first on your page.' }).waitFor();
  check(P.state.posts[posts.lighthouse.id].starred === true, 'desktop: starred on the server');
  await shot(editor, 'stars-menu-done-desktop');
  await tabOf(editor, posts.lighthouse).click({ button: 'right' });
  check(await editor.locator('.menu-tab .menu-item', { hasText: 'Unstar' }).count() === 1, 'desktop: the menu now offers “Unstar”');
  await editor.keyboard.press('Escape');
  await tabOf(editor, posts.adaAnon).click({ button: 'right' });
  const anonItem = editor.locator('.menu-tab .menu-item', { hasText: 'Star on my page' });
  await anonItem.waitFor();
  check((await anonItem.locator('.menu-hint').textContent()) === 'shows once signed', 'desktop: an unsigned post’s item says it shows once signed');
  await shot(editor, 'stars-menu-unsigned-desktop');
  await anonItem.click();
  await editor.locator('.toast', { hasText: 'only once the post is signed' }).waitFor();
  check(P.state.posts[posts.adaAnon.id].starred === true, 'desktop: the unsigned post keeps its star');
  await editor.context().close();
  const phoneEditor = await pageFor('phone', ada.cookie);
  await phoneEditor.goto(`${BASE}/write`, { waitUntil: 'load' });
  await tabOf(phoneEditor, posts.lighthouse).waitFor();
  await tabOf(phoneEditor, posts.lighthouse).click({ button: 'right' }); // the long-press menu
  await phoneEditor.locator('.menu-tab .menu-item', { hasText: 'Unstar' }).waitFor();
  check(true, 'phone: the tab’s menu shows “Unstar” for the starred post');
  await shot(phoneEditor, 'stars-menu-phone');
  await phoneEditor.context().close();

  const order = ['The lighthouse keeper', 'Salt and paper'];
  for (const device of ['desktop', 'phone']) {
    const page = await pageFor(device);
    await page.goto(`${BASE}/w/${pid(ada)}`, { waitUntil: 'load' });
    await page.locator('#wp-starred-h').waitFor();
    const groups = await page.locator('.wp-group').evaluateAll((els) => els.map((g) => [g.querySelector('h2').textContent, [...g.querySelectorAll('.a-entry-title')].map((t) => t.textContent)]));
    check(JSON.stringify(groups) === JSON.stringify([['Starred', [order[0]]], ['More pieces', [order[1]]]]), `${device}: “Starred” first, then “More pieces” (${JSON.stringify(groups)})`);
    check(!(await page.locator('.wp-star').count()), `${device}: no star toggles for visitors`);
    await noSecrets(page, `${device}: Ada’s page with stars`);
    await shot(page, `stars-page-${device}`, { full: true });
    await page.context().close();
  }

  const own = await pageFor('phone', ada.cookie);
  await own.goto(`${BASE}/w/${pid(ada)}`, { waitUntil: 'load' });
  await own.locator('.wp-star').first().waitFor();
  const pressed = await own.locator('.wp-star').evaluateAll((els) => els.map((b) => [b.closest('.wp-entry').querySelector('.a-entry-title').textContent, b.getAttribute('aria-pressed')]));
  check(JSON.stringify(pressed) === JSON.stringify([[order[0], 'true'], [order[1], 'false']]), `phone: her own page has a toggle on each piece (${JSON.stringify(pressed)})`);
  await shot(own, 'stars-own-phone', { full: true });
  await own.locator('.wp-entry', { hasText: 'Salt and paper' }).locator('.wp-star').click();
  await own.waitForFunction(() => document.querySelectorAll('#wp-starred-h ~ ol .wp-entry').length === 2);
  check(P.state.posts[posts.salt.id].starred === true && !(await own.locator('#wp-rest-h').count()), 'phone: starring from her page moves it under Starred at once');
  check(await own.evaluate(() => document.activeElement?.classList.contains('wp-star')), 'phone: the focus stays on the star');
  await shot(own, 'stars-own-both-phone', { full: true });
  await own.locator('.wp-entry', { hasText: 'Salt and paper' }).locator('.wp-star').click();
  await own.locator('#wp-rest-h').waitFor();
  check(!P.state.posts[posts.salt.id].starred, 'phone: and unstarring moves it back');
  await own.context().close();
  const ownDesk = await pageFor('desktop', ada.cookie);
  await ownDesk.goto(`${BASE}/w/${pid(ada)}`, { waitUntil: 'load' });
  await ownDesk.locator('.wp-star').first().waitFor();
  await shot(ownDesk, 'stars-own-desktop', { full: true });
  await ownDesk.context().close();

  // Nowhere else: the live page, its data, the post pages.
  const live = await pageFor('desktop');
  await live.goto(`${BASE}/live`, { waitUntil: 'load' });
  await live.locator('.l-card').first().waitFor();
  check(!(await live.content()).includes('Starred') && !(await live.locator('svg.wp-mark, .wp-star').count()), 'desktop: the live page shows no stars');
  for (const p of ['/api/live', `/api/p/${P.state.posts[posts.lighthouse.id].publicId}`, `/api/p/${P.state.posts[posts.adaAnon.id].publicId}`, '/api/writers']) {
    check(!(await fetch(BASE + p).then((r) => r.text())).includes('starred'), `${p} says nothing of stars`);
  }
  await live.goto(`${BASE}/p/${P.state.posts[posts.lighthouse.id].publicId}`, { waitUntil: 'load' });
  await live.locator('.p-title').waitFor();
  check(!(await live.content()).includes('Starred'), 'desktop: a starred post’s own page shows no star');
  await live.context().close();
});

await step('stars: “My page” in the writer’s menu opens the page where you star (or the way onto the list)', async () => {
  for (const device of ['desktop', 'phone']) {
    const page = await pageFor(device, ada.cookie);
    await page.goto(`${BASE}/write`, { waitUntil: 'load' });
    await page.locator('.w-me').click();
    const item = page.locator('.menu-item', { hasText: 'My page' });
    await item.waitFor();
    check((await item.locator('.menu-label').textContent()) === 'My page' && (await item.locator('.menu-hint').textContent()) === 'star posts there', `${device}: on the list, the menu has “My page”`);
    check(!(await page.locator('.w-star').count()), `${device}: no star button in the editor's header`);
    await shot(page, `mypage-menu-${device}`);
    const [popup] = await Promise.all([page.context().waitForEvent('page'), item.click()]);
    await popup.waitForURL(new RegExp(`/w/${pid(ada)}$`));
    await popup.locator('.wp-star').first().waitFor();
    check(true, `${device}: it opens her page, with a star on each piece`);
    await page.context().close();
  }
  const page = await pageFor('desktop', mira.cookie);
  await page.goto(`${BASE}/write`, { waitUntil: 'load' });
  await page.locator('.w-me').click();
  const join = page.locator('.menu-item', { hasText: 'My page (join the writers list first)' });
  await join.waitFor();
  check(true, 'desktop: off the list, it reads “My page (join the writers list first)”');
  await shot(page, 'mypage-join-desktop');
  await join.click();
  const dlg = page.locator('dialog.modal-account[open]');
  await dlg.waitFor();
  check(await dlg.locator('#acc-list').count() === 1 && !(await dlg.locator('#acc-list').isChecked()), 'desktop: and opens Your account at the list switch');
  await page.context().close();
});

await step('signed post pages link “More by”; unsigned and unlisted ones never do', async () => {
  for (const device of ['desktop', 'phone']) {
    const page = await pageFor(device);
    await page.goto(`${BASE}/p/${P.state.posts[posts.lighthouse.id].publicId}`, { waitUntil: 'load' });
    await page.locator('.p-more a').waitFor();
    check((await page.locator('.p-more a').textContent()) === 'More by Ada Brennan' && await page.locator('.p-more a').getAttribute('href') === `/w/${pid(ada)}`, `${device}: “More by Ada Brennan” → her page`);
    check(await page.locator('.p-by a').getAttribute('href') === `/w/${pid(ada)}`, `${device}: the byline links there too`);
    await page.locator('.p-more').scrollIntoViewIfNeeded();
    await shot(page, `post-${device}`, { full: device === 'phone' });
    await page.context().close();
  }
  const page = await pageFor('desktop');
  await page.goto(`${BASE}/p/${P.state.posts[posts.map.id].publicId}`, { waitUntil: 'load' });
  await page.locator('.p-by').waitFor();
  check(await page.locator('.p-more').isHidden() && !(await page.locator('.p-by a').count()), 'desktop: Mira (not on the list): signed, but no link');
  await page.goto(`${BASE}/p/${P.state.posts[posts.adaAnon.id].publicId}`, { waitUntil: 'load' });
  await page.locator('.p-title').waitFor();
  await page.waitForTimeout(300);
  check(await page.locator('.p-by').isHidden() && await page.locator('.p-more').isHidden(), 'desktop: Ada’s anonymous post: no name, no link');
  await noSecrets(page, 'desktop: an anonymous post page', { unsigned: false });
  check(!(await page.content()).includes(pid(ada)), 'desktop: the anonymous post page doesn’t carry her page id');
  await page.context().close();
});

await step('Your account: Dev turns it on from /writers; the list follows', async () => {
  const page = await pageFor('desktop', dev.cookie);
  await page.goto(`${BASE}/writers`, { waitUntil: 'load' });
  await page.locator('.wr-mine button').waitFor();
  check(/Want to be listed\?/.test(await page.locator('.wr-mine').textContent()), 'desktop: signed in and not listed: “Want to be listed?”');
  await page.locator('.wr-mine button').click();
  const dlg = page.locator('dialog.modal-account[open]');
  await dlg.waitFor();
  const box = dlg.locator('#acc-list');
  check(!(await box.isChecked()), 'desktop: the switch starts off');
  check((await dlg.locator('label[for="acc-list"]').textContent()) === 'Show me on the public list of writers', 'desktop: labelled as specified');
  check(/display name, how many hours you’ve met.*the posts you signed/.test(await dlg.locator('#acc-list-help').textContent()), 'desktop: one line on what it shows');
  await dlg.locator('.acc-list').scrollIntoViewIfNeeded();
  await shot(page, 'account-off-desktop');
  await box.check();
  await shot(page, 'account-ticked-desktop');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await dlg.waitFor({ state: 'detached' });
  await page.locator('.toast', { hasText: 'You’re on the public list of writers.' }).waitFor();
  check(await page.locator('.toast .toast-act', { hasText: 'See your page' }).count() === 1, 'desktop: the toast offers “See your page”');
  await page.locator('.wr-row', { hasText: 'Dev Raman' }).waitFor({ timeout: 5000 });
  check(true, 'desktop: Dev appears in the list at once');
  check(/You’re on this list/.test(await page.locator('.wr-mine').textContent()), 'desktop: the footer says so');
  await shot(page, 'account-saved-desktop', { full: true });
  check(P.userById(dev.id).publicProfile?.on === true, 'desktop: saved on the account');
  await page.context().close();
});

await step('Your account: Ada leaves from her own page; it closes, and she can come back to the same address', async () => {
  const page = await pageFor('phone', ada.cookie);
  await page.goto(`${BASE}/w/${pid(ada)}`, { waitUntil: 'load' });
  await page.locator('.wp-mine button').waitFor();
  check(/This is your page/.test(await page.locator('.wp-mine').textContent()), 'phone: her own page tells her so');
  await shot(page, 'page-own-phone', { full: true });
  await page.locator('.wp-mine button').click();
  const dlg = page.locator('dialog.modal-account[open]');
  await dlg.waitFor();
  check(await dlg.locator('#acc-list').isChecked(), 'phone: the switch shows she is on the list');
  check((await dlg.locator('.acc-list-page a').getAttribute('href')) === `/w/${pid(ada)}`, 'phone: and her page’s address');
  await dlg.locator('.acc-list').scrollIntoViewIfNeeded();
  await shot(page, 'account-on-phone');
  const id = pid(ada);
  await dlg.locator('#acc-list').uncheck();
  await dlg.getByRole('button', { name: 'Save' }).click();
  await dlg.waitFor({ state: 'detached' });
  await page.locator('.p-missing').waitFor({ timeout: 6000 });
  check(/isn’t public any more/.test(await page.locator('.p-missing').textContent()), 'phone: her open page closes at once');
  await shot(page, 'page-left-phone');
  const list = await fetch(`${BASE}/api/writers`).then((r) => r.json());
  check(!list.writers.some((w) => w.name === 'Ada Brennan'), 'phone: off the list at once');
  check((await fetch(`${BASE}/api/w/${id}`)).status === 404, 'phone: her page answers 404');
  check((await fetch(`${BASE}/api/p/${P.state.posts[posts.lighthouse.id].publicId}`).then((r) => r.json())).profile === null, 'phone: her signed post stops linking');
  P.setPublicProfile(ada.id, true);
  check(pid(ada) === id, 'phone: back on the list, the same page id');
  await page.context().close();
});

await step('after the end: the anthology links to the writers; the list and pages stay', async () => {
  setClock(now() + 2 * MIN);
  P.end(host.id);
  const page = await pageFor('desktop');
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.locator('.a-title').waitFor();
  const link = page.locator('.l-mast-nav a[href="/writers"]');
  check(await link.isVisible() && (await link.textContent()) === 'The writers', 'desktop: “The writers” in the anthology’s header');
  check(!(await page.content()).includes('Starred') && !(await fetch(`${BASE}/api/archive`).then((r) => r.text())).includes('starred'), 'desktop: the anthology shows no stars (SPEC §28b)');
  await shot(page, 'anthology-desktop');
  await page.goto(`${BASE}/writers`, { waitUntil: 'load' });
  await page.locator('.wr-row').first().waitFor();
  check(/the anthology/.test(await page.locator('.wr-party').textContent()), 'desktop: the list leads back to the anthology');
  check((await rowsOf(page)).some(([n]) => n === 'Dev Raman'), 'desktop: Dev, who joined from Your account, is listed');
  await noSecrets(page, 'desktop: /writers after the end');
  await shot(page, 'list-ended-desktop', { full: true });
  await page.goto(`${BASE}/p/${P.state.posts[posts.bus.id].publicId}`, { waitUntil: 'load' });
  await page.locator('.p-next').waitFor();
  check((await page.locator('.p-after .p-more a').textContent()) === 'More by Ben Okafor', 'desktop: after the end, the post page’s ending links “More by Ben Okafor”');
  await page.locator('.p-after').scrollIntoViewIfNeeded();
  await shot(page, 'post-ended-desktop');
  await page.context().close();
  const phone = await pageFor('phone');
  await phone.goto(`${BASE}/w/${pid(ben)}`, { waitUntil: 'load' });
  await phone.locator('.wp-entry').first().waitFor();
  check(JSON.stringify(await phone.locator('.wp-entry .a-entry-title').allTextContents()) === JSON.stringify(['Notes from the night bus']), 'phone: Ben’s page after the end: his signed piece only (his unsigned one is in the anthology, not here)');
  await noSecrets(phone, 'phone: Ben’s page after the end');
  await shot(phone, 'page-ended-phone', { full: true });
  await phone.context().close();
  // Starring still works after the end (it isn't an edit of the post): Ben, on his own page.
  const ended = await pageFor('desktop', ben.cookie);
  await ended.goto(`${BASE}/w/${pid(ben)}`, { waitUntil: 'load' });
  const star = ended.locator('.wp-entry', { hasText: 'Notes from the night bus' }).locator('.wp-star');
  await star.waitFor();
  check((await star.getAttribute('aria-pressed')) === 'false', 'desktop: after the end his page has a star toggle, off');
  await star.click();
  await ended.locator('#wp-starred-h').waitFor();
  check(P.state.posts[posts.bus.id].starred === true, 'desktop: starring after the end works, with no reason asked');
  await shot(ended, 'stars-own-ended-desktop', { full: true });
  await ended.context().close();
});

await browser.close();
await app.stop();
console.log(`\n${shots.length} screenshots:\n${shots.map((s) => `  ${s}`).join('\n')}`);
if (problems.length) {
  console.log(`\n${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('\nAll checks passed.');
process.exit(0);
