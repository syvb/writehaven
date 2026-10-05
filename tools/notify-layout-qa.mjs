#!/usr/bin/env node
// Notices never cover the page (SPEC §22): the scenarios where they could, measured. On the
// writer's page a notice and the notifications ask must lie wholly above the editor area
// (.w-main) and below the header and the page's own banner, clicks on the title row must land,
// and the ask may come only at a calm moment (not in the first minute after load, not while
// typing) and never again after "Not now". On the phone waiting screen the bell must sit inside
// the card's header line. The projector shows none.
// Shots: qa/after/notify-fix-<tag>-*.png (--tag names the run, e.g. before and after a change).
// The ask's timings are shortened for the test through window.__whNoticeTiming (set before the
// page loads); one check uses the real ones.
// Usage: timeout 300 node tools/notify-layout-qa.mjs [--port 8226] [--tag after] [--tmp <dir>]

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
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const PORT = Number(arg('port', 8226));
const TAG = arg('tag', 'after');
const OUT = path.resolve(ROOT, arg('out', 'qa/after'));
const TMP = arg('tmp', os.tmpdir());
const BASE = `http://127.0.0.1:${PORT}`;
const TZ = 'Europe/London';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[layout ${new Date().toISOString().slice(11, 19)}]`, ...a);
fs.mkdirSync(OUT, { recursive: true });

try {
  await fetch(`${BASE}/healthz`);
  console.error(`Port ${PORT} is already in use; pick another with --port.`);
  process.exit(2);
} catch { /* free */ }
const stateDir = fs.mkdtempSync(path.join(TMP, 'wh-layout-qa-'));
const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), WH_STATE_FILE: path.join(stateDir, 'state.json'), WH_FSYNC: '0', WH_TZ: TZ },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverGone = new Promise((r) => server.once('exit', r));
const serverLog = [];
server.stdout.on('data', (d) => serverLog.push(String(d)));
server.stderr.on('data', (d) => serverLog.push(String(d)));
process.on('exit', () => {
  try {
    server.kill('SIGKILL'); // only if it outlived the orderly stop below
  } catch { /* gone */ }
});
const problems = [];
const passed = [];
process.on('unhandledRejection', (e) => problems.push(`unhandled: ${e && e.message}`));
function check(cond, what, detail = '') {
  if (cond) passed.push(what);
  else problems.push(`${what}${detail ? `: ${detail}` : ''}`);
  log(cond ? 'ok  ' : 'FAIL', what, cond ? '' : detail);
  return !!cond;
}
// A step that may fail: recorded, and the run goes on.
async function step(what, fn) {
  try {
    return await fn();
  } catch (e) {
    check(false, what, e.message.split('\n')[0]);
    return null;
  }
}

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
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch { /* not json */ }
    if (!r.ok) throw new Error(`${p} ${r.status} ${text.slice(0, 200)}`);
    return json;
  }
  get token() {
    return this.cookie.replace('wh_sess=', '');
  }
}

const PROSE = 'Okay. I said I would write about the allotment, so: the allotment. Plot 14, which I share with a man called Vernon who grows only leeks and does not believe in conversation. Every Saturday we nod at each other across the bean frames and that is the whole of it, and I have come to love him for it.';
const PROSE2 = 'Back after a long lunch and a longer chat at the snack table. Where was I. Vernon and the leeks. Vernon has won the village show four years running and keeps the rosettes in a biscuit tin in his shed, which I know because he showed me once, in total silence, and then put the lid back on.';
const LONG = 'Pizza and Thai arrive around 14:00. We’ll stop for a 30-minute break then and eat together in the kitchen. Vegetarian boxes are marked with a green sticker, the gluten-free ones with a blue one, and there is fruit and cake on the side table for anyone who would rather keep writing through it.';

async function main() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch { /* starting */ }
    await sleep(100);
  }
  const host = new Client();
  await host.req('/api/register', { username: 'mira', password: 'longpassword', name: 'Mira Okafor' });
  const people = {};
  const join = async (u, name, { approve = true } = {}) => {
    const c = new Client();
    c.id = (await c.req('/api/register', { username: u, password: 'longpassword', name })).user.id;
    if (approve) await host.req('/api/host/approve', { id: c.id });
    people[u] = c;
    return c;
  };
  for (const [u, name] of [['nadia', 'Nadia Haddad'], ['ruth', 'Ruth Adeyemi'], ['sam', 'Sam Ortiz'], ['priya', 'Priya Nair'], ['lena', 'Lena Park']]) await join(u, name);
  await join('gus', 'Gus Lindqvist', { approve: false });
  await host.req('/api/admin/start', {});
  // Sam and Priya and Lena have written; Sam is out.
  for (const u of ['sam', 'priya', 'lena']) {
    const c = people[u];
    const p = await c.req('/api/post/new', { title: u === 'sam' ? 'The allotment' : u === 'priya' ? 'Notes on a ferry' : 'The lighthouse I keep drawing' });
    await c.req('/api/ops', { postId: p.post.id, pane: 'body', baseVersion: 0, ops: [{ pos: 0, del: 0, ins: `${PROSE}\n\n${PROSE2}` }] });
  }
  await host.req('/api/admin/writer', { id: people.sam.id, out: true });
  // Mira's messages (everyone), and Ruth's approval notice comes from the server.
  await host.req('/api/host/notify', { to: { kind: 'all' }, title: 'Welcome in', body: 'Tea and coffee are in the kitchen. Shout if you need a charger.' });
  await host.req('/api/host/notify', { to: { kind: 'all' }, title: 'Food is ordered', body: LONG });
  for (let i = 0; i < 60 && !(await people.ruth.req('/api/me/notices')).notices.some((n) => n.kind === 'approved'); i++) await sleep(100);
  // Ruth's approval is the newest thing waiting for her alone.
  await people.ruth.req('/api/me/notices/read', { ids: (await people.ruth.req('/api/me/notices')).notices.filter((n) => n.kind !== 'approved').map((n) => n.id) });
  log('party ready');

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };
  const PHONE = {
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
  };
  async function open(who, url, opts = {}, { timing = null } = {}) {
    const ctx = await browser.newContext({ timezoneId: TZ, colorScheme: 'light', ...opts });
    await ctx.addCookies([{ name: 'wh_sess', value: who.token, url: BASE }]);
    await ctx.addInitScript((t) => {
      if (t) window.__whNoticeTiming = t;
      try {
        // Other modules' one-time hints stay out of these pictures.
        for (const k of ['wh-install-hint', 'wh-install-dismissed', 'wh-ih-seen']) localStorage.setItem(k, String(Date.now()));
      } catch { /* none */ }
    }, timing);
    const page = await ctx.newPage();
    page.setDefaultTimeout(10_000);
    page.on('pageerror', (e) => problems.push(`page error (${url}): ${e.message}`));
    await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
    return { ctx, page };
  }
  const shot = (page, name) => page.screenshot({ path: path.join(OUT, `notify-fix-${TAG}-${name}.png`) });
  const rect = (page, sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el || !el.isConnected) return null;
    const r = el.getBoundingClientRect();
    return r.width && r.height ? { top: r.top, bottom: r.bottom, left: r.left, right: r.right } : null;
  }, sel);
  const NOTICE = '.nt-banner';
  // The notice (or ask) lies above the editor area and below the header and the page's banner.
  async function clearOfEditor(page, sel, what) {
    const n = await rect(page, sel);
    const main = await rect(page, '.w-main');
    const top = await rect(page, '.w-top');
    const own = await rect(page, '.w-banner:not([hidden])');
    if (!check(!!n && !!main, `${what}: shown`, JSON.stringify({ n, main }))) return;
    check(n.bottom <= main.top + 0.5, `${what}: wholly above the editor area`, `notice bottom ${Math.round(n.bottom)}, editor top ${Math.round(main.top)}`);
    check(n.top >= (top?.bottom ?? 0) - 0.5, `${what}: below the header`, `${Math.round(n.top)} vs ${Math.round(top?.bottom ?? 0)}`);
    if (own) check(n.top >= own.bottom - 0.5, `${what}: below the page’s own banner`, `${Math.round(n.top)} vs ${Math.round(own.bottom)}`);
  }
  // A click on the post's privacy chip lands (its menu opens) while the notice is up.
  async function chipClickLands(page, what) {
    await step(`${what}: a click on the privacy chip lands`, async () => {
      await page.click('.w-head .w-controls .w-chip', { timeout: 4000 });
      await page.waitForSelector('.menu-pop', { timeout: 3000 });
      check(true, `${what}: a click on the privacy chip lands`);
      await page.keyboard.press('Escape');
    });
  }

  // ---- 1. Nadia's first open: two unread host messages
  for (const scheme of ['light', 'dark']) {
    const { ctx, page } = await open(people.nadia, '/write', { ...DESKTOP, colorScheme: scheme });
    await page.waitForSelector('.w-top .w-me');
    await step(`Nadia (${scheme}): the message shows`, () => page.waitForSelector(NOTICE, { timeout: 8000 }));
    await sleep(500);
    await clearOfEditor(page, NOTICE, `Nadia (${scheme}): first-open message`);
    await shot(page, `first-open-desktop-${scheme}`);
    if (scheme === 'light') await chipClickLands(page, 'Nadia');
    await ctx.close();
  }
  // ---- 2. Ruth's first open: "You're approved"
  {
    const { ctx, page } = await open(people.ruth, '/write', DESKTOP);
    await page.waitForSelector('.w-top .w-me');
    await step('Ruth: the approval notice shows', () => page.waitForSelector(NOTICE, { timeout: 8000 }));
    await sleep(500);
    await clearOfEditor(page, NOTICE, 'Ruth: approval notice');
    await shot(page, 'first-open-ruth-desktop');
    await ctx.close();
  }
  // ---- 3. Sam, out, with a message
  {
    const { ctx, page } = await open(people.sam, '/write', DESKTOP);
    await page.waitForSelector('.w-top .w-me');
    await step('Sam: the message shows', () => page.waitForSelector(NOTICE, { timeout: 8000 }));
    await page.waitForSelector('.w-banner.banner-out', { timeout: 8000 }).catch(() => {});
    await sleep(500);
    await clearOfEditor(page, NOTICE, 'Sam: message under the out strip');
    await chipClickLands(page, 'Sam');
    await shot(page, 'out-banner-desktop');
    await ctx.close();
  }
  // ---- 4. The ask, real timings: not within the first seconds with 50+ words. Her
  // messages are read already, so none of them stands in its way.
  await people.priya.req('/api/me/notices/read', { ids: 'all' });
  {
    const { ctx, page } = await open(people.priya, '/write', DESKTOP);
    await page.waitForSelector('.w-top .w-me');
    await sleep(6000);
    check(!(await page.$('.nt-ask')), 'Priya, 50+ words: no notifications ask in the first 6 s after load');
    await ctx.close();
  }
  // ---- 5. The ask, short test timings: calm moment, clear of the editor, clicks land, one dismiss
  const fast = { afterLoadMs: 2500, quietMs: 1500 };
  {
    const { ctx, page } = await open(people.priya, '/write', DESKTOP, { timing: fast });
    await page.waitForSelector('.w-top .w-me');
    await page.click('.cm-content');
    await page.keyboard.press('Control+End');
    // Typing on for 5 s: no ask while she types.
    const until = Date.now() + 5000;
    while (Date.now() < until) await page.keyboard.type(' and', { delay: 120 });
    check(!(await page.$('.nt-ask')), 'Priya, typing: no ask while typing');
    await step('Priya: the ask comes after a pause', () => page.waitForSelector('.nt-ask', { timeout: 8000 }));
    await sleep(500);
    await clearOfEditor(page, '.nt-ask', 'Priya: the ask');
    await shot(page, 'ask-desktop');
    await chipClickLands(page, 'Priya, with the ask up');
    await step('Priya: “Not now” puts it away', async () => {
      await page.click('.nt-ask .btn-quiet', { timeout: 3000 });
      await page.waitForSelector('.nt-ask', { state: 'detached', timeout: 3000 });
      check(true, 'Priya: “Not now” puts it away');
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.w-top .w-me');
    await sleep(6000);
    check(!(await page.$('.nt-ask')), 'Priya: after “Not now” it stays away (reload, past the timings)');
    await ctx.close();
  }
  // ---- 6. Lena's phone: a message and the ask
  {
    const { ctx, page } = await open(people.lena, '/write', PHONE, { timing: fast });
    await page.waitForSelector('.w-top .w-me');
    await step('Lena (phone): the message shows', () => page.waitForSelector(NOTICE, { timeout: 8000 }));
    await sleep(500);
    await clearOfEditor(page, NOTICE, 'Lena (phone): message');
    await shot(page, 'editor-phone-message');
    await step('Lena (phone): dismiss', async () => {
      for (let i = 0; i < 4 && (await page.$(`${NOTICE}:not(.nt-ask) .nt-x`)); i++) {
        await page.tap(`${NOTICE}:not(.nt-ask) .nt-x`);
        await sleep(400);
      }
    });
    await step('Lena (phone): the ask comes at a calm moment', () => page.waitForSelector('.nt-ask', { timeout: 10_000 }));
    await sleep(500);
    await clearOfEditor(page, '.nt-ask', 'Lena (phone): the ask');
    await shot(page, 'ask-phone');
    await ctx.close();
  }
  // ---- 7. Gus waits for approval on a phone: the bell stays inside the card
  {
    await host.req('/api/host/notify', { to: { kind: 'pending' }, body: 'Hi Gus, one moment: we’re letting people in as they arrive.' });
    const { ctx, page } = await open(people.gus, '/', PHONE);
    await page.waitForSelector('.ap-card');
    await step('Gus: the bell is placed', () => page.waitForSelector('.nt-bell', { timeout: 8000 }));
    await sleep(3000); // a floating bell came after 2.5 s
    const bell = await rect(page, '.nt-bell');
    const card = await rect(page, '.ap-card');
    const title = await rect(page, '.ap-title');
    const inside = bell && card && bell.left >= card.left && bell.right <= card.right && bell.top >= card.top && bell.bottom <= card.bottom;
    check(!!inside, 'Gus (phone): the bell sits inside the card', JSON.stringify({ bell, card }));
    check(!!bell && !!title && bell.bottom <= title.top, 'Gus (phone): the bell is clear of the card’s title', JSON.stringify({ bell, title }));
    const n = await rect(page, NOTICE);
    if (n) check(n.bottom <= card.top + 0.5, 'Gus (phone): the message is above the card, not over it', JSON.stringify({ n, card }));
    await shot(page, 'waiting-phone');
    await page.evaluate(() => window.scrollTo(0, 300));
    await sleep(300);
    const bell2 = await rect(page, '.nt-bell');
    const card2 = await rect(page, '.ap-card');
    check(!bell2 || (bell2.top >= card2.top && bell2.bottom <= card2.bottom), 'Gus (phone): scrolled, the bell moves with the card', JSON.stringify({ bell2, card2 }));
    await shot(page, 'waiting-phone-scrolled');
    await ctx.close();
  }
  // ---- 8. The projector: no notices, no bell
  {
    await host.req('/api/host/notify', { to: { kind: 'hosts' }, body: 'x' }).catch(() => null); // no other host: refused, fine
    const fay = await join('fay', 'Fay Cohen');
    await host.req('/api/host/admins', { id: fay.id, isAdmin: true });
    await fay.req('/api/host/notify', { to: { kind: 'hosts' }, title: 'Private', body: 'Only for the hosts.' });
    const { ctx, page } = await open(host, '/live?wall', { viewport: { width: 1920, height: 1080 } });
    await page.waitForSelector('body.is-projector');
    await sleep(3500);
    check(!(await page.$('.nt-banner')), 'Projector: no notice on the big screen');
    check(!(await page.$('.nt-bell')), 'Projector: no bell');
    await shot(page, 'projector');
    await ctx.close();
  }
  await browser.close();
}

try {
  await Promise.race([main(), new Promise((_, rej) => setTimeout(() => rej(new Error('timed out after 240 s')), 240_000))]);
} catch (e) {
  problems.push(`run: ${e.message}`);
  console.error(e);
} finally {
  try {
    server.kill('SIGTERM');
  } catch { /* gone */ }
  await Promise.race([serverGone, sleep(5000)]);
  fs.rmSync(stateDir, { recursive: true, force: true });
}
const errs = serverLog.join('').split('\n').filter((l) => /error|uncaught|unhandled/i.test(l));
if (errs.length) problems.push(...errs.slice(0, 5).map((l) => `server: ${l}`));
log(`${TAG}: ${passed.length} passed, ${problems.length} problems`);
for (const p of problems) log('problem:', p);
process.exit(problems.length ? 1 : 0);
