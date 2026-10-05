#!/usr/bin/env node
// End-to-end run: 1 host + 4 writers typing in real browsers (a paste, a quote,
// a toggling cheater, a named post, planning notes, a short offline spell),
// a public viewer on desktop and phone, compressed hours, then the archive.
// Screenshots go to qa/. Usage: node tools/qa-e2e.mjs [--port 8111] [--minutes 5]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const CHROME = process.env.CHROME_PATH || undefined; // unset: Playwright's own Chromium
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QA = path.join(ROOT, 'qa');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const PORT = Number(arg('port', 8111));
const MINUTES = Number(arg('minutes', 4.5));
const HOUR_MIN = Number(arg('hour', 1.5));
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[qa ${new Date().toISOString().slice(11, 19)}]`, ...a);
fs.mkdirSync(QA, { recursive: true });

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-qa-'));
const STATE_FILE = path.join(stateDir, 'state.json');
// WH_TEST_KNOBS: the compressed test hours (hourLengthMin) are refused otherwise.
const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), WH_STATE_FILE: STATE_FILE, WH_TEST_KNOBS: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
fs.writeFileSync(path.join(QA, 'server.pid'), String(server.pid));
const serverLog = [];
server.stdout.on('data', (d) => serverLog.push(String(d)));
server.stderr.on('data', (d) => serverLog.push(String(d)));

const problems = [];
const results = {};
let browser;

// Varied, honest-looking prose (a writer who repeats paragraphs is rightly "already counted").
// Each simulated writer has their own phrase bank: real writers rarely share
// six words in a row, and the scorer rightly flags text that matches someone else's.
const BANKS = {
  sea: {
    S: ['the keeper', 'his sister', 'a tired ferryman', 'an old gull', 'the harbour master', 'the boy with the phone', 'a fisherman from the north', 'the lighthouse cat'],
    V: ['counted', 'mended', 'painted', 'remembered', 'wrote down', 'carried', 'watched', 'listened to'],
    O: ['the ledger', 'the broken lamp', 'a map of the bay', 'the smell of tar', 'the long winter', 'a rope of grey wool', 'the tide tables', 'every gull on the rail'],
    P: ['before the fog rolled in', 'on the third landing', 'at the edge of the harbour', 'by lamplight', 'during the storm', 'from the gallery'],
    C: ['and nobody noticed', 'though the sea did not care', 'as the boat went out', 'until the tide turned', 'which the gulls approved of'],
  },
  city: {
    S: ['my landlord', 'the woman next door', 'a tram driver', 'the baker on the corner', 'our old neighbour', 'a student with a cello', 'the night clerk', 'a man selling umbrellas'],
    V: ['forgot', 'borrowed', 'sold', 'misplaced', 'photographed', 'argued about', 'translated', 'pretended to ignore'],
    O: ['a letter from Riga', 'the last tram', 'every spare key', 'a box of matches', 'the rent receipt', 'a bicycle bell', 'the parking ticket', 'a bag of oranges'],
    P: ['outside the station', 'in the rain', 'behind the bakery', 'on a Sunday', 'near the old bridge', 'without telling anyone'],
    C: ['and then laughed about it', 'which surprised no one', 'as if it were a secret', 'because the city asked', 'and the street forgave them'],
  },
  kitchen: {
    S: ['my grandmother', 'the dog', 'a choir of three', 'the inspector', 'my cousin', 'the smoke alarm', 'a nervous guest', 'the oven'],
    V: ['burned', 'salted', 'stirred', 'buried', 'rescued', 'tasted', 'hid', 'blamed'],
    O: ['the onions', 'two loaves of rye', 'a small brass bell', 'the soup', 'a jar of honey', 'the wooden spoon', 'the birthday cake', 'a pot of rice'],
    P: ['before supper', 'while the kettle sulked', 'under the stairs', 'twice on Thursdays', 'at midnight', 'for no good reason'],
    C: ['and wrote it in pencil', 'which was the whole point', 'though it hardly mattered', 'and nobody complained', 'until the guests arrived'],
  },
};
function makeWriter(seed, bank) {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const { S, V, O, P, C } = BANKS[bank];
  const cap = (x) => x[0].toUpperCase() + x.slice(1);
  return () => `${cap(pick(S))} ${pick(V)} ${pick(O)} ${pick(P)}, ${pick(C)}. `;
}
const PROSE = [
  '# Arrival\n\nEvery evening the keeper climbed the hundred and twelve steps and counted them aloud, because the counting was the only conversation he had left. ',
  'The lamp did not need him any more; it had been automatic for eleven years. But someone had to notice when the gulls nested in the gallery, and someone had to write it down. ',
  'He wrote it down in a ledger with a green cloth spine. Gulls, three. Fog from the west. A ferry, late, carrying nobody he knew. ',
  '\n\nOn Thursdays the supply boat came, and with it the boy who never looked up from his phone. ',
];
const PROSE_B = [
  'Notes on leaving a city you love\n\nYou do not leave all at once. First you stop buying the good coffee, because what is the point. Then you notice the trams again, the way you did when you first arrived. ',
  'The bakery on the corner has a new sign. You will not learn what it says. ',
];
const PROSE_D = [
  'Field guide to small kitchen disasters. The first rule is that nothing burns quietly. The second rule is that the smoke alarm is never where you think it is. ',
  'Third: the recipe lied about the onions. It always lies about the onions. ',
];
const LOREM = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo. Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione voluptatem sequi nesciunt.';
const PASTE_TEXT = 'I wrote this paragraph on the train this morning, before the party started, and I am pasting it in now. '
  + 'The second sentence is also mine and was written today for this party. '
  + 'This third sentence was copied from somewhere else and should not count at all. '
  + 'A final sentence that I did write earlier today, sitting by the window.';

async function api(page, p, body) {
  return page.evaluate(async ([p2, b]) => {
    const r = await fetch(p2, { method: b ? 'POST' : 'GET', headers: b ? { 'Content-Type': 'application/json', 'X-WH': '1' } : {}, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, [p, body]);
}

async function register(ctx, username, name) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${username}: page error: ${e.message}`));
  page.on('console', (m) => {
    // Optional modules (help, rich text) are probed and may not be deployed yet: their 404s are expected.
    if (m.type() === 'error' && /\/js\/(help|richtext|food|notify|install)\.js/.test(m.location()?.url || '')) return;
    if (m.type() === 'error' && !/ERR_INTERNET_DISCONNECTED/.test(m.text())) problems.push(`${username}: console: ${m.text()} ${m.location()?.url || ''}`);
  });
  await page.goto(`${BASE}/register`);
  await page.fill('input[name=name]', name);
  await page.fill('input[name=username]', username);
  await page.fill('input[name=password]', 'party-password');
  // Sign-up asks for an email and shows it back for a check (SPEC §25b).
  if (await page.$('input[name=email]')) await page.fill('input[name=email]', `${username}@example.org`);
  await page.click('.auth-go');
  const check = await page.waitForSelector('dialog[open] .modal-actions .btn-primary', { timeout: 5000 }).catch(() => null);
  await Promise.all([page.waitForURL(/\/(write|host)$/), check ? check.click() : Promise.resolve()]);
  return page;
}

async function typeSlow(page, text, cps = 9) {
  for (const ch of text) {
    if (ch === '\n') await page.keyboard.press('Enter');
    else await page.keyboard.type(ch);
    await sleep(1000 / cps * (0.6 + Math.random() * 0.8));
  }
}

// Focus the editor and put the caret at the end (a plain click lands mid-text).
async function focusEnd(page, sel = '.w-editor:not([hidden]) .cm-content') {
  await page.click(sel);
  await page.keyboard.press('Control+End');
}

async function shot(page, name, opts = {}) {
  const file = path.join(QA, `${name}.png`);
  await page.screenshot({ path: file, ...opts });
  log('screenshot', file);
}

// ---------------------------------------------------------------- writer regressions
// Node-side API client with its own cookie (one per account).
class Client {
  constructor() {
    this.cookie = '';
  }
  async req(p, body) {
    const r = await fetch(BASE + p, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(this.cookie ? { Cookie: this.cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json', 'X-WH': '1' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = r.headers.get('set-cookie');
    const m = sc && /wh_sess=([^;]*)/.exec(sc);
    if (m) this.cookie = `wh_sess=${m[1]}`;
    const json = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`${p}: ${r.status} ${JSON.stringify(json)}`);
    return json;
  }
  get token() {
    return this.cookie.replace(/^wh_sess=/, '');
  }
}
async function writerAccount(username) {
  const c = new Client();
  await c.req('/api/register', { username, name: username, password: 'party-password' });
  await c.req('/api/join', {});
  return c;
}
async function contextFor(c, device = null) {
  const opts = device ? { viewport: { width: 412, height: 860 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36' } : { viewport: { width: 1280, height: 860 } };
  const ctx = await browser.newContext(opts);
  await ctx.addCookies([{ name: 'wh_sess', value: c.token, url: BASE }]);
  return ctx;
}
// The editor texts on a page: every pane that has an editor, by host class.
async function editorTexts(page) {
  return page.evaluate(async () => {
    const { EditorView } = await import('/vendor/cm.js');
    return [...document.querySelectorAll('.w-editor')].map((host) => {
      const ed = host.querySelector('.cm-editor');
      const v = ed && EditorView.findFromDOM(ed);
      return { notes: host.classList.contains('w-editor-notes'), hidden: host.hidden, text: v ? v.state.doc.toString() : null };
    });
  });
}
async function activeText(page) {
  return (await editorTexts(page)).find((e) => !e.notes && !e.hidden)?.text ?? null;
}
// Wait until the server answers quickly (a re-score after a settings change can keep it busy).
async function serverReady() {
  for (let i = 0; i < 60; i++) {
    const t = Date.now();
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok && Date.now() - t < 1000) return;
    } catch { /* not yet */ }
    await sleep(500);
  }
}
async function openWriterPage(ctx) {
  await serverReady();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`regression page error: ${e.message}`));
  page.on('dialog', (d) => d.accept().catch(() => {}));
  await page.goto(`${BASE}/write`);
  await page.waitForSelector('.w-editor:not([hidden]):not(.w-editor-notes) .cm-content');
  return page;
}
async function caretEnd(page) {
  await page.click('.w-editor:not([hidden]):not(.w-editor-notes) .cm-content');
  await page.keyboard.press('Control+End');
}
async function typeIn(page, text, delay = 25) {
  await page.keyboard.type(text, { delay });
}
function journalOps(userId) {
  const f = path.join(`${STATE_FILE}.ops`, `${userId}.jsonl`);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).flatMap((b) => b[3] || []);
}

// Pages close first (a normal unload: pagehide runs and the page lets go of its tab
// lock); closing a context with pages still open crashed this Chromium build.
async function closeCtx(ctx) {
  for (const pg of ctx.pages()) await pg.close().catch(() => {});
  await ctx.close().catch(() => {});
}

async function regressions() {
  const reg = {};
  results.regressions = reg;
  // 1. Blank pane: 20 fresh loads; every pane's editor text equals the server's.
  {
    log('regression: blank pane x20');
    const c = await writerAccount('qa-race');
    const seeds = [['First', 'Alpha paragraph one. Alpha paragraph two is here.', 'first notes line'], ['Second', 'Beta poem line one\nBeta poem line two\nBeta poem line three', 'second notes']];
    for (const [title, body, notes] of seeds) {
      const { post } = await c.req('/api/post/new', { title });
      await c.req('/api/ops', { postId: post.id, pane: 'body', baseVersion: 0, seq: `b${title}`, sentAt: Date.now(), ops: [{ at: Date.now(), pos: 0, del: 0, ins: body }] });
      await c.req('/api/ops', { postId: post.id, pane: 'notes', baseVersion: 0, seq: `n${title}`, sentAt: Date.now(), ops: [{ at: Date.now(), pos: 0, del: 0, ins: notes }] });
    }
    const server = (await c.req('/api/posts')).posts;
    const want = new Set(server.flatMap((p) => [p.body, p.notes]));
    let bad = 0;
    const ctx = await contextFor(c);
    for (let i = 0; i < 20; i++) {
      const page = await openWriterPage(ctx);
      await page.waitForTimeout(300);
      await page.click('.w-tab:nth-child(2) .w-tab-btn');
      await page.click('.w-tab:nth-child(1) .w-tab-btn');
      await page.waitForTimeout(150);
      const eds = await editorTexts(page);
      const texts = eds.map((e) => e.text);
      const ok = eds.length === 4 && texts.every((t) => want.has(t));
      if (!ok) {
        bad++;
        problems.push(`blank-pane regression: load ${i + 1} shows ${JSON.stringify(texts)}`);
      }
      await page.close();
    }
    await closeCtx(ctx);
    reg.blankPane = `${20 - bad} of 20 loads showed every pane's server text`;
  }
  // 2. Two tabs of one post, both online, typing at the two ends at once: nothing lost.
  {
    log('regression: two tabs');
    const c = await writerAccount('qa-tabs');
    const ctx = await contextFor(c);
    const A = await openWriterPage(ctx);
    await caretEnd(A);
    await typeIn(A, 'Middle paragraph written first. ');
    await sleep(2500);
    const B = await openWriterPage(ctx);
    await B.click('.w-editor:not([hidden]):not(.w-editor-notes) .cm-content');
    await B.keyboard.press('Control+Home');
    await caretEnd(A);
    const aw = 'alpha bravo charlie delta echo foxtrot golf hotel'.split(' ');
    const bw = 'one two three four five six seven eight'.split(' ');
    for (let i = 0; i < aw.length; i++) {
      await A.bringToFront();
      await A.keyboard.type(`${aw[i]} `, { delay: 20 });
      await B.bringToFront();
      await B.keyboard.type(`${bw[i]} `, { delay: 20 });
      await sleep(500);
    }
    await sleep(5000);
    const server = (await c.req('/api/posts')).posts[0].body;
    const [ta, tb] = [await activeText(A), await activeText(B)];
    const lost = [...aw, ...bw].filter((w) => !server.includes(w));
    reg.twoTabs = { lost, tabsAgree: ta === server && tb === server };
    if (lost.length || ta !== server || tb !== server) problems.push(`two-tab regression: lost ${JSON.stringify(lost)}; server ${JSON.stringify(server)}; A ${JSON.stringify(ta)}; B ${JSON.stringify(tb)}`);
    await closeCtx(ctx);
  }
  // 3. Same account on two devices: the phone types offline while the laptop saves a paragraph.
  {
    log('regression: two devices');
    const c = await writerAccount('qa-devices');
    const phoneCtx = await contextFor(c, 'phone');
    const lapCtx = await contextFor(c);
    const P = await openWriterPage(phoneCtx);
    await caretEnd(P);
    await typeIn(P, 'Shared opening line. ');
    await sleep(2500);
    const L = await openWriterPage(lapCtx);
    await sleep(1000);
    await phoneCtx.setOffline(true);
    await P.bringToFront();
    await caretEnd(P);
    await typeIn(P, 'Phone sentence typed on the bus while offline. ');
    await L.bringToFront();
    await caretEnd(L);
    await typeIn(L, 'Laptop paragraph typed meanwhile, online, and saved. ');
    await sleep(3000);
    await phoneCtx.setOffline(false);
    await sleep(8000);
    const server = (await c.req('/api/posts')).posts[0].body;
    const ok = server.includes('Phone sentence typed on the bus') && server.includes('Laptop paragraph typed meanwhile') && server.includes('Shared opening line');
    const [tp, tl] = [await activeText(P), await activeText(L)];
    reg.twoDevices = { server, phoneAgrees: tp === server, laptopAgrees: tl === server };
    if (!ok || tp !== server || tl !== server) problems.push(`two-device regression: ${JSON.stringify(reg.twoDevices)} phone ${JSON.stringify(tp)} laptop ${JSON.stringify(tl)}`);
    await closeCtx(phoneCtx);
    await closeCtx(lapCtx);
  }
  // 4. Offline replay. (a) A batch reaches the server but its response is lost, the
  //    writer keeps typing offline, closes the tab, reopens online: nothing doubled,
  //    and the offline ops keep their own times (not one op stamped at reconnect).
  {
    log('regression: offline replay');
    const c = await writerAccount('qa-replay');
    const uid = (await c.req('/api/me')).me.id;
    const ctx = await contextFor(c, 'phone');
    let page = await openWriterPage(ctx);
    await caretEnd(page);
    await typeIn(page, 'Online part first. ');
    await sleep(2500);
    let dropped = 0;
    await ctx.route('**/api/ops', async (route) => {
      if (dropped === 0) {
        dropped++;
        await route.fetch().catch(() => {});
        await ctx.setOffline(true);
        return route.abort('internetdisconnected');
      }
      return route.continue();
    });
    await typeIn(page, 'Lost response. ');
    for (let i = 0; i < 50 && !dropped; i++) await sleep(100);
    await sleep(300);
    const t0 = Date.now();
    const offline = 'Then I kept writing on the train with no signal at all, sentence after sentence, about the hills outside. ';
    await typeIn(page, offline, 110);
    const offSecs = (Date.now() - t0) / 1000;
    await sleep(1000);
    const keeper = await ctx.newPage();
    await page.close({ runBeforeUnload: true });
    await sleep(700);
    await ctx.unroute('**/api/ops');
    await ctx.setOffline(false);
    page = keeper;
    page.on('pageerror', (e) => problems.push(`regression page error: ${e.message}`));
    await page.goto(`${BASE}/write`);
    await page.waitForSelector('.w-editor:not([hidden]):not(.w-editor-notes) .cm-content');
    await sleep(6000);
    const server = (await c.req('/api/posts')).posts[0].body;
    const want = `Online part first. Lost response. ${offline}`;
    const ops = journalOps(uid).filter((o) => o[0] >= t0 - 500);
    const span = ops.length ? (Math.max(...ops.map((o) => o[0])) - Math.min(...ops.map((o) => o[0]))) / 1000 : 0;
    const big = ops.filter((o) => (o[3] || '').length > 40).length;
    reg.offlineReplay = { textOk: server === want, editorOk: (await activeText(page)) === server, offlineTypingSecs: Math.round(offSecs), opsForOfflineText: ops.length, serverTimeSpanSecs: +span.toFixed(1), collapsedOps: big };
    if (server !== want) problems.push(`offline-replay regression: server ${JSON.stringify(server)}`);
    if (big || span < offSecs * 0.6) problems.push(`offline-replay regression: offline ops collapsed or re-stamped ${JSON.stringify(reg.offlineReplay)}`);
    await closeCtx(ctx);
  }
  // (b) Two tabs of one post, both offline: tab A types and closes, tab B types; online: both kept.
  {
    log('regression: two offline tabs');
    const c = await writerAccount('qa-offtabs');
    const ctx = await contextFor(c);
    const A = await openWriterPage(ctx);
    await caretEnd(A);
    await typeIn(A, 'Shared start. ');
    await sleep(2500);
    const B = await openWriterPage(ctx);
    await sleep(800);
    await ctx.setOffline(true);
    await A.bringToFront();
    await caretEnd(A);
    await typeIn(A, 'Tab A wrote this offline. ');
    await sleep(800);
    await A.close({ runBeforeUnload: true });
    await B.bringToFront();
    await caretEnd(B);
    await typeIn(B, 'Tab B wrote this offline. ');
    await sleep(800);
    await ctx.setOffline(false);
    await sleep(6000);
    const server = (await c.req('/api/posts')).posts[0].body;
    reg.twoOfflineTabs = { server, hasA: server.includes('Tab A wrote this offline'), hasB: server.includes('Tab B wrote this offline') };
    if (!reg.twoOfflineTabs.hasA || !reg.twoOfflineTabs.hasB) problems.push(`two-offline-tabs regression: ${JSON.stringify(reg.twoOfflineTabs)}`);
    await closeCtx(ctx);
  }
  log('regressions', JSON.stringify(reg));
}

// Pure checks of the writer's merge code (no browser): concurrent typing never interleaves,
// a lost response never doubles text, conflicting rewrites keep both versions.
async function syncUnitChecks() {
  const S = await import(new URL('../public/js/sync.js', import.meta.url).href);
  const out = {};
  const fail = (name, got) => problems.push(`sync unit: ${name}: ${JSON.stringify(got)}`);
  const typing = (text, at) => [...text].map((ch, i) => ({ at: i, pos: at + i, del: 0, ins: ch }));
  const since = (v, ops) => ({ version: v, ops: ops.map((o) => [o.pos, o.del, o.ins]) });
  const base0 = 'Shared start. ';
  const A = typing('Tab A wrote this offline. ', base0.length);
  const B = typing('Tab B wrote this offline. ', base0.length);
  // A's first two characters land, then B (rebased), then the rest of A (its run continues).
  const a1 = A.slice(0, 2);
  const textA = S.applyOps(base0, a1);
  const rb = S.rebaseOps(B, S.changeSetFromSince(base0.length, [since(1, a1)]), base0.length, null);
  let server = S.applyOps(textA, rb.ops);
  const ra = S.rebaseOps(A.slice(2), S.changeSetFromSince(textA.length, [since(2, rb.ops)]), textA.length, a1[1].pos + 1);
  server = S.applyOps(server, ra.ops);
  out.interleave = server;
  if (server !== 'Shared start. Tab A wrote this offline. Tab B wrote this offline. ') fail('two runs at one point interleaved', server);
  // A batch applied but its answer lost: the text-level merge takes the shared change once.
  const m = S.merge3('Online. ', 'Online. Lost response. ', 'Online. Lost response. Kept writing.');
  if (m.text !== 'Online. Lost response. Kept writing.') fail('lost response doubled', m.text);
  // Both sides rewrote one word: theirs stays, ours is kept as recovered text.
  const c = S.merge3('The cat sat.', 'The dog sat.', 'The bird sat.');
  if (c.text !== 'The dog sat.' || c.recovered[0] !== 'bird') fail('conflict lost a side', c);
  // The diff reproduces any edit.
  for (const [a, b] of [['one two three', 'one three four'], ['', 'x'], ['a\nb', 'b\na']]) {
    if (S.applyOps(a, S.diffOps(a, b)) !== b) fail('diff', [a, b]);
  }
  // Edge cases: the run's end survives a sanitised ack; an unknown outcome
  // with no history isn't replayed; a second answer for a settled batch changes nothing;
  // surrogate pairs aren't split; remote changes stay out of the undo history.
  const mk = (text = '', pending = []) => {
    const pn = new S.PaneSync({ userId: 'u', tab: 't', kick() {}, changed() {}, onAck() {} }, { postId: 'p', pane: 'body', tab: 't' });
    pn.base = { version: 0, text };
    pn.pending = pending;
    pn.schedulePersist = () => {};
    pn.persist = async () => true;
    pn.afterMerge = () => {};
    return pn;
  };
  const o1 = (pos, ins) => ({ at: 1, pos, del: 0, ins });
  {
    const pn = mk('', [o1(0, 'A\u200bB'), o1(3, 'C'), o1(4, 'D')]);
    const fl = { n: 1, seq: 's1' };
    pn.inflight = fl;
    pn.onAck({ version: 1, sanitized: true, text: 'AB' }, fl, pn.pending.slice(0, 1));
    pn.onConflict({ version: 2, text: 'ABxy', base: { version: 1, text: 'AB' }, since: [{ version: 2, ops: [[2, 0, 'xy']] }] }, { n: 2, seq: 's2' });
    if (pn.localText !== 'ABCDxy') fail('run end lost on a sanitised ack', pn.localText);
  }
  {
    const pn = mk('', [o1(0, 'hello')]);
    pn.onConflict({ version: 2, text: 'hello!', base: null, since: null }, { n: 1, uncertain: true });
    if (pn.localText !== 'hello!') fail('unknown outcome replayed', pn.localText);
  }
  {
    const pn = mk('', [o1(0, 'A'), o1(1, 'B')]);
    const fl = { n: 1, seq: 's' };
    pn.inflight = fl;
    const sent = pn.pending.slice(0, 1);
    pn.onAck({ version: 1 }, fl, sent);
    if (pn.inflight === fl) pn.onAck({ version: 1, duplicate: true }, fl, sent);
    if (pn.localText !== 'AB') fail('double ack', pn.localText);
  }
  if (S.applyOps('😀', S.diffOps('😀', '😁')) !== '😁' || S.diffRanges('😀', '😁').some((c) => /^[\udc00-\udfff]/.test(c.insert))) fail('surrogate pair split', S.diffRanges('😀', '😁'));
  {
    const cm = await import(new URL('../public/vendor/cm.js', import.meta.url).href);
    const Rm = cm.Annotation.define();
    let st = cm.EditorState.create({ doc: 'A', extensions: [cm.history()] });
    st = st.update({ changes: { from: 1, insert: 'x' } }).state;
    st = st.update({ changes: { from: 2, insert: 'B' }, annotations: [Rm.of(true), cm.Transaction.addToHistory.of(false)] }).state;
    cm.historyKeymap.find((k) => k.key === 'Mod-z').run({ state: st, dispatch: (tr) => { st = tr.state; } });
    if (st.doc.toString() !== 'AB') fail('undo removed a remote change', st.doc.toString());
  }
  results.syncUnit = out;
  log('sync unit checks done');
}

async function main() {
  await syncUnitChecks();
  // Wait for the server.
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) break;
    } catch { /* not yet */ }
    await sleep(100);
  }
  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const desk = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };

  // Host registers first (becomes admin), compresses hours, starts.
  const hostCtx = await browser.newContext({ ...desk, viewport: { width: 1500, height: 1000 } });
  const host = await register(hostCtx, 'host', 'Robin');
  // Writers in this run sign up without waiting for approval (the setting defaults to on).
  // Personal hours: each writer's compressed hour starts when they open the editor (synced hours would hold them in the waiting room).
  let r = await api(host, '/api/admin/settings', { scoring: { hourLengthMin: HOUR_MIN, targetPerHour: 50, approvalRequired: false, hoursMode: 'personal' } });
  if (r.status !== 200) problems.push(`settings: ${JSON.stringify(r.json)}`);
  // Settings apply once the background re-score has finished.
  for (let i = 0; i < 100 && (await api(host, '/api/admin/state')).json?.rescoring; i++) await sleep(100);
  await api(host, '/api/admin/party', { name: 'Writehaven' });

  // Writers.
  const names = [['ana', 'Ana Ilić'], ['ben', 'Ben Okafor'], ['cleo', 'Cleo Marsh'], ['dev', 'Devika Rao']];
  const w = {};
  for (const [u, n] of names) {
    const ctx = await browser.newContext(desk);
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    w[u] = { ctx, page: await register(ctx, u, n) };
  }
  // Lobby screenshot for one writer.
  await w.ana.page.waitForSelector('.w-empty');
  await shot(w.ana.page, '00-writer-lobby');

  // Public viewers.
  const viewDesk = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  const viewPhone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
  const viewDark = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark' })).newPage();
  for (const v of [viewDesk, viewPhone, viewDark]) {
    v.on('pageerror', (e) => problems.push(`viewer: ${e.message}`));
    await v.goto(`${BASE}/live`);
  }

  r = await api(host, '/api/admin/start', {});
  if (r.status !== 200) problems.push(`start: ${JSON.stringify(r.json)}`);
  log('party started');
  for (const u of Object.keys(w)) await w[u].page.waitForSelector('.w-editor:not([hidden]) .cm-content', { timeout: 15000 });
  await host.goto(`${BASE}/host`);

  // Titles and privacy.
  const setTitle = async (page, t) => {
    await page.click('.w-title');
    await page.fill('.w-title', t);
    await page.keyboard.press('Enter');
  };
  await setTitle(w.ana.page, 'The lighthouse keeper');
  await setTitle(w.ben.page, 'Leaving');
  await setTitle(w.cleo.page, 'Untitled thoughts');
  await setTitle(w.dev.page, 'Small kitchen disasters');
  // Devika signs her post.
  await w.dev.page.click('.w-controls .w-chip:first-child');
  await w.dev.page.click('.menu-privacy .menu-item:nth-child(2)');

  const t0 = Date.now();
  const until = t0 + MINUTES * 60_000;

  // Ana: steady prose with a heading and a quote; goes offline for a bit.
  const ana = (async () => {
    const p = w.ana.page;
    const gen = makeWriter(11, 'sea');
    await p.click('.w-editor:not([hidden]) .cm-content');
    let i = 0;
    while (Date.now() < until - 20_000) {
      await typeSlow(p, i < PROSE.length ? PROSE[i] : `${i % 4 === 0 ? '\n\n' : ''}${gen()}${gen()}`, 7);
      if (i === 1) {
        await typeSlow(p, '\n> Light is the only thing that travels for free.\n\n', 8); // Enter twice leaves the quote
      }
      if (i === 2) {
        log('ana offline');
        await w.ana.ctx.setOffline(true);
        await typeSlow(p, 'Written while the network was down, and kept safe. ', 7);
        await sleep(2500);
        await shot(p, '03b-editor-offline');
        await w.ana.ctx.setOffline(false);
        log('ana online');
      }
      i++;
    }
  })();

  // Ben: writes, pastes (two-step attribution), keeps writing.
  const ben = (async () => {
    const p = w.ben.page;
    await p.click('.w-editor:not([hidden]) .cm-content');
    await typeSlow(p, PROSE_B[0], 6);
    await p.evaluate((text) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      const target = document.querySelector('.w-editor:not([hidden]) .cm-content');
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, PASTE_TEXT);
    await p.waitForSelector('#paste-yes');
    await shot(p, '04-paste-dialog-step1');
    await p.click('#paste-yes');
    await p.waitForSelector('.ps-area');
    // Nothing starts selected: select it all, then switch off the third sentence (copied from
    // elsewhere) by tapping a word in it.
    await p.click('.ps-quick .btn-link >> text=Select all');
    const words = await p.$$('.ps-w');
    let target = null;
    for (const el of words) if ((await el.textContent()) === 'copied') target = el;
    if (target) await target.click();
    await sleep(300);
    await shot(p, '05-paste-dialog-step2');
    results.pasteCounter = await p.textContent('.paste-counter');
    await p.click('#paste-count');
    await sleep(500);
    await focusEnd(p);
    const gen = makeWriter(22, 'city');
    await typeSlow(p, PROSE_B[1], 6);
    let i = 0;
    while (Date.now() < until - 20_000) {
      await typeSlow(p, `${i % 3 === 0 ? '\n\n' : ''}${gen()}`, 6);
      i++;
    }
  })();

  // Cleo: the toggling cheater (a / backspace, and a word toggled back and forth).
  const cleo = (async () => {
    const p = w.cleo.page;
    await p.click('.w-editor:not([hidden]) .cm-content');
    await typeSlow(p, 'Hmm. ', 5);
    let pasted = false;
    while (Date.now() < until - 20_000) {
      // In her second hour she pastes a big block of placeholder text and claims all of it:
      // the hour reaches the target only with flagged words, so it goes to the host's review.
      if (!pasted && Date.now() > t0 + HOUR_MIN * 60_000 + 10_000) {
        pasted = true;
        await p.evaluate((text) => {
          const dt = new DataTransfer();
          dt.setData('text/plain', text);
          document.querySelector('.w-editor:not([hidden]) .cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        }, LOREM);
        await p.waitForSelector('#paste-yes');
        await p.click('#paste-yes');
        await p.waitForSelector('#paste-count');
        await p.click('.ps-quick .btn-link >> text=Select all'); // she claims all of it
        await p.click('#paste-count');
        await sleep(500);
        await focusEnd(p);
      }
      for (let k = 0; k < 20; k++) {
        await p.keyboard.type('a');
        await sleep(120);
        await p.keyboard.press('Backspace');
        await sleep(120);
      }
      await p.keyboard.type('big');
      await sleep(400);
      for (let k = 0; k < 3; k++) await p.keyboard.press('Backspace');
      await sleep(300);
    }
  })();

  // Devika: a named post, planning notes, and a separate-identity second post.
  const dev = (async () => {
    const p = w.dev.page;
    await p.click('.w-editor:not([hidden]) .cm-content');
    await typeSlow(p, PROSE_D[0], 7);
    await p.click('.w-controls .w-chip:nth-child(2)'); // planning notes
    await p.click('.w-notes .cm-content');
    await typeSlow(p, 'Plan: three disasters, one recovery, end on the onions. Maybe a list?', 8);
    await shot(p, '06-editor-with-notes');
    await p.click('.w-notes-head .btn-icon');
    await p.click('.w-tab-new');
    await p.waitForTimeout(500);
    await setTitle(p, 'A letter I will not sign');
    await p.click('.w-controls .w-chip:first-child');
    await p.click('.menu-privacy .menu-item:nth-child(3)');
    await p.click('.w-editor:not([hidden]) .cm-content');
    const gen = makeWriter(33, 'kitchen');
    await typeSlow(p, 'Dear you, I kept the key. I never told anyone where the spare one was, and I never will. ', 7);
    while (Date.now() < until - 20_000) await typeSlow(p, gen(), 7);
  })();

  // Screenshots along the way.
  const shots = (async () => {
    await sleep(35_000);
    await shot(w.ana.page, '01-editor');
    await shot(viewDesk, '07-live-desktop');
    await shot(viewPhone, '08-live-phone');
    await shot(viewDark, '08c-live-dark');
    await w.ana.page.click('.w-progress');
    await w.ana.page.waitForSelector('.modal-breakdown');
    await sleep(300);
    await shot(w.ana.page, '02-progress-breakdown');
    await w.ana.page.keyboard.press('Escape');
    await focusEnd(w.ana.page);
    // Hour 1 is judged once its last words have settled (90 s after it ends).
    await sleep(HOUR_MIN * 60_000 + 100_000 - 35_000);
    await shot(host, '09-host-dashboard');
    await shot(w.cleo.page, '10-writer-out');
    await shot(viewDesk, '07b-live-desktop-later');
    await shot(viewPhone, '08b-live-phone-later', { fullPage: false });
  })();

  const done = (name, pr) => pr.then(() => log(`${name} done`), (e) => { log(`${name} failed: ${e.message.split('\n')[0]}`); throw e; });
  await Promise.all([done('ana', ana), done('ben', ben), done('cleo', cleo), done('dev', dev), done('shots', shots)]);
  log('writers done');
  await sleep(3000);

  // Offline, then the tab is closed before the network comes back: the queued
  // ops wait in IndexedDB and are sent when the editor is opened again.
  {
    const p = w.ben.page;
    await focusEnd(p);
    await w.ben.ctx.setOffline(true);
    await typeSlow(p, ' Typed offline, then the tab was closed.', 12);
    await sleep(800); // the queue is persisted within 250 ms
    await p.close();
    await w.ben.ctx.setOffline(false);
    const p2 = await w.ben.ctx.newPage();
    p2.on('pageerror', (e) => problems.push(`ben (reopened): ${e.message}`));
    await p2.goto(`${BASE}/write`);
    await p2.waitForSelector('.w-editor:not([hidden]) .cm-content');
    let restored = false;
    for (let i = 0; i < 20 && !restored; i++) {
      await sleep(500);
      const posts = (await api(p2, '/api/posts')).json.posts;
      restored = posts.some((x) => x.body.includes('Typed offline, then the tab was closed.'));
    }
    results.offlineAfterCloseSaved = restored;
    if (!restored) problems.push('text typed offline before closing the tab was lost');
    w.ben.page = p2;
  }

  // The writer-side regression runs (the party is running, before any break).
  await regressions();

  // Scoring snapshot from the host's view.
  const hv = (await api(host, '/api/admin/state')).json;
  results.writers = hv.writers.filter((x) => x.joinedAt).map((x) => ({
    name: x.name, out: x.out, met: x.progress?.met, missed: x.progress?.missed, review: x.progress?.review,
    written: Math.round(x.totals.written), pasted: Math.round(x.totals.pasted), cut: Math.round(x.totals.cut), credited: Math.round(x.totals.credit),
    nc: Object.fromEntries(Object.entries(x.totals.nc).filter(([, v]) => v >= 0.5).map(([k, v]) => [k, Math.round(v)])),
    flags: Object.keys(x.flags.scoring || {}),
  }));
  results.alerts = hv.alerts.map((a) => `${a.name}: ${a.kind} hour ${a.k + 1} (${a.credited}/${a.target})`);
  // The offline text arrived.
  const anaPosts = (await api(w.ana.page, '/api/posts')).json.posts;
  results.offlineTextSaved = anaPosts.some((p2) => p2.body.includes('Written while the network was down'));
  results.anaBodyStart = anaPosts[0]?.body.slice(0, 700);
  if (!results.offlineTextSaved) problems.push('offline text was not saved');
  const cleoRow = results.writers.find((x) => x.name === 'Cleo Marsh');
  // The toggling earns nothing; her claimed paste counts only if the host accepts it.
  if (cleoRow && cleoRow.written > 5) problems.push(`cheater's typing credited ${cleoRow.written}`);
  // Public payload never names anonymous writers.
  const live = await (await fetch(`${BASE}/api/live`)).text();
  for (const n of ['Ana Ilić', 'Ben Okafor', 'Cleo Marsh', 'ana', 'ben']) if (live.includes(`"${n}"`)) problems.push(`live payload contains ${n}`);
  if (!live.includes('Devika Rao')) problems.push('named post lacks its name');
  if (live.includes('I kept the key')) problems.push('separate-identity post was streamed');
  if (live.includes('three disasters')) problems.push('planning notes were streamed');

  await shot(host, '09b-host-dashboard-end');
  // The review queue: Cleo's second hour (a claimed big paste of placeholder text).
  for (let i = 0; i < 60; i++) {
    const st = (await api(host, '/api/admin/state')).json;
    if (st.reviews && st.reviews.length) {
      results.reviews = st.reviews.map((r) => `${r.name} hour ${r.k + 1}: ${Math.round(r.credit)}/${r.target}, ${Math.round(r.flagged)} flagged (${[...new Set(r.flags.map((f) => f.type))].join(', ')})`);
      break;
    }
    await sleep(2000);
  }
  if (!results.reviews) problems.push('no hour went to review');
  await sleep(2500);
  await host.evaluate(() => document.querySelector('.h-reviews')?.scrollIntoView({ block: 'start' }));
  await shot(host, '09c-host-review');
  await host.evaluate(() => window.scrollTo(0, 0));
  // Host opens a writer's detail (paste decisions).
  try {
    await host.click('.h-table tbody tr:nth-child(2) .h-who', { timeout: 5000 });
    await host.waitForSelector('.h-drawer:not([hidden]) h3', { timeout: 5000 });
    await sleep(500);
    await shot(host, '11-host-writer-detail');
    await host.click('.h-drawer .btn-icon', { timeout: 3000 }).catch(() => host.keyboard.press('Escape'));
  } catch (e) {
    log('host drawer not reachable with the old selectors (host page changed?):', e.message.split('\n')[0]);
  }

  // A break for everyone shows on the live page and pauses every hour clock.
  r = await api(host, '/api/admin/break', { label: 'Dinner break', lengthMin: 30 });
  if (r.status !== 200) problems.push(`break: ${JSON.stringify(r.json)}`);
  await sleep(2500);
  await shot(viewDesk, '07c-live-break');
  await shot(w.ana.page, '03c-writer-break');
  results.breakOnLive = (await (await fetch(`${BASE}/api/live`)).json()).party.break;
  if (!results.breakOnLive) problems.push('break not shown on the live page');

  // End the party (two-step confirm), then the archive.
  // End the party: the host's button if it's where it was, else the API.
  try {
    await host.click('.h-top-right .btn-danger', { timeout: 3000 });
    await host.click('.h-top-right .btn-danger', { timeout: 3000 });
  } catch {
    r = await api(host, '/api/admin/end', {});
    if (r.status !== 200) problems.push(`end: ${JSON.stringify(r.json)}`);
  }
  await sleep(2500);
  await viewDesk.waitForSelector('.a-list', { timeout: 10000 }).catch(() => problems.push('viewer did not switch to the archive'));
  await shot(viewDesk, '12-archive-desktop', { fullPage: true });
  await viewPhone.goto(`${BASE}/`);
  await viewPhone.waitForSelector('.a-list');
  await shot(viewPhone, '13-archive-phone');
  const first = await viewDesk.$('.a-item a');
  if (first) {
    await first.click();
    await viewDesk.waitForSelector('.p-body');
    await shot(viewDesk, '14-post-page');
  }
  await shot(w.ben.page, '15-writer-ended');
  const archive = await (await fetch(`${BASE}/api/archive`)).json();
  results.archiveTitles = archive.posts.map((p2) => p2.title);
  if (!results.archiveTitles.includes('A letter I will not sign')) problems.push('separate post missing from the archive');
  // Dark theme screenshot of the live archive.
  const dark = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })).newPage();
  await dark.goto(`${BASE}/`);
  await dark.waitForSelector('.a-list');
  await shot(dark, '16-archive-dark');
}

let exitCode = 0;
try {
  await main();
} catch (e) {
  exitCode = 1;
  problems.push(`run failed: ${e.stack || e.message}`);
} finally {
  await browser?.close().catch(() => {});
  server.kill('SIGTERM');
  await sleep(800);
  fs.rmSync(path.join(QA, 'server.pid'), { force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
  const errs = serverLog.join('').split('\n').filter((l) => /error|Error|uncaught/.test(l));
  if (errs.length) problems.push(...errs.map((l) => `server: ${l}`));
  fs.writeFileSync(path.join(QA, 'e2e-results.json'), JSON.stringify({ results, problems }, null, 2));
  fs.writeFileSync(path.join(QA, 'e2e-server.log'), serverLog.join(''));
  console.log(JSON.stringify({ results, problems }, null, 2));
  if (problems.length) exitCode = 1;
  process.exit(exitCode);
}
