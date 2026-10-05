#!/usr/bin/env node
// Notices (SPEC §22) in a real browser, one Chromium at a time: the banner (desktop, phone,
// dark), the bell and its panel, a break notice whose time is a template shown in the device's
// own time (SPEC §24), the notifications ask (dialog, the card after the first words, the
// iPhone Home Screen step), the bell on the host and live pages, and the host's composer
// (groups with counts, "Selected" from the table's ticked rows, preview, send, sent list with
// delivered and read counts, automatic messages), all as app.js and host.js mount them.
// Screenshots: qa/after/notify-*.png. No push service is contacted.
// Usage: timeout 300 node tools/notify-qa.mjs [--port 8225] [--tmp <dir>] [--out qa/after]

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
const PORT = Number(arg('port', 8225));
const OUT = path.resolve(ROOT, arg('out', 'qa/after'));
const TMP = arg('tmp', os.tmpdir());
const BASE = `http://127.0.0.1:${PORT}`;
const TZ = 'Europe/London';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[notify ${new Date().toISOString().slice(11, 19)}]`, ...a);
fs.mkdirSync(OUT, { recursive: true });

try {
  await fetch(`${BASE}/healthz`);
  console.error(`Port ${PORT} is already in use; pick another with --port.`);
  process.exit(2);
} catch { /* free */ }
const stateDir = fs.mkdtempSync(path.join(TMP, 'wh-notify-qa-'));
const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), WH_STATE_FILE: path.join(stateDir, 'state.json'), WH_FSYNC: '0', WH_TZ: TZ },
  stdio: ['ignore', 'pipe', 'pipe'],
});
fs.writeFileSync(path.join(stateDir, 'server.pid'), String(server.pid));
const serverLog = [];
server.stdout.on('data', (d) => serverLog.push(String(d)));
server.stderr.on('data', (d) => serverLog.push(String(d)));
let browser = null;
const serverGone = new Promise((r) => server.once('exit', r));
process.on('exit', () => {
  try {
    server.kill('SIGKILL'); // only if it outlived the orderly stop below
  } catch { /* gone */ }
  try {
    fs.rmSync(stateDir, { recursive: true, force: true });
  } catch { /* removed below */ }
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
const within = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: timed out after ${ms} ms`)), ms))]);

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

const PROSE = 'Every evening the keeper climbed the hundred and twelve steps and counted them aloud, because the counting was the only conversation he had left. The lamp did not need him any more; it had been automatic for eleven years. But someone had to notice when the fog came in.';

async function main() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch { /* starting */ }
    await sleep(100);
  }
  // ---- the party: a host, four writers (one out), one waiting for approval
  const host = new Client();
  await host.req('/api/register', { username: 'robin', password: 'longpassword', name: 'Robin' });
  await host.req('/api/admin/settings', { scoring: { hoursMode: 'personal' } });
  const people = {};
  for (const [u, name] of [['ana', 'Ana Ilić'], ['ben', 'Ben Okafor'], ['cleo', 'Cleo Marsh'], ['dev', 'Devika Rao'], ['eli', 'Eli Brandt']]) {
    const c = new Client();
    const r = await c.req('/api/register', { username: u, password: 'longpassword', name });
    c.id = r.user.id;
    await host.req('/api/host/approve', { id: c.id });
    people[u] = c;
  }
  const gus = new Client();
  gus.id = (await gus.req('/api/register', { username: 'gus', password: 'longpassword', name: 'Gus Lindqvist' })).user.id;
  await gus.req('/api/me/approval-message', { message: 'Hi, it’s Gus from the Thursday group.' });
  await host.req('/api/admin/start', {});
  for (const u of ['ana', 'ben', 'cleo']) {
    const c = people[u];
    await c.req('/api/join', {});
    const p = await c.req('/api/post/new', { title: u === 'ana' ? 'The lighthouse keeper' : 'Notes from the ferry' });
    await c.req('/api/ops', { postId: p.post.id, pane: 'body', baseVersion: 0, ops: [{ pos: 0, del: 0, ins: PROSE }] });
  }
  await host.req('/api/admin/writer', { id: people.ben.id, out: true });
  // The server tells each of them "You're approved" (they were away): wait for it.
  for (let i = 0; i < 60 && !(await people.ana.req('/api/me/notices')).notices.some((n) => n.kind === 'approved'); i++) await sleep(100);
  log('party ready');

  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36';
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };
  const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: ANDROID };
  async function open(who, url, opts = {}, init = null) {
    const ctx = await browser.newContext({ timezoneId: TZ, colorScheme: 'light', ...opts });
    await ctx.addCookies([{ name: 'wh_sess', value: who.token, url: BASE }]);
    if (init) await ctx.addInitScript(init);
    // The install hint (SPEC §23) is the PWA module's: keep it out of these pictures.
    await ctx.addInitScript(() => {
      try {
        for (const k of ['wh-install-hint', 'wh-install-dismissed', 'wh-ih-seen']) localStorage.setItem(k, String(Date.now()));
      } catch { /* none */ }
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(15_000);
    page.on('pageerror', (e) => problems.push(`page error (${url}): ${e.message}`));
    await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
    return { ctx, page };
  }
  // app.js mounts the notices on every signed-in page: the bell shows that it did.
  const mounted = (page) => page.waitForSelector('.nt-bell', { timeout: 10_000 });
  const shot = (page, name, opts = {}) => page.screenshot({ path: path.join(OUT, `notify-${name}.png`), ...opts });
  const banner = async (page) => {
    await page.waitForSelector('.nt-banner:not(.nt-ask)', { timeout: 8000 });
    await sleep(350); // the slide-in
  };
  const bannerTitled = async (page, title) => {
    await page.waitForFunction((t) => document.querySelector('.nt-banner:not(.nt-ask) .nt-title')?.textContent === t, title, { timeout: 8000 });
    await sleep(350);
  };
  const send = (body) => host.req('/api/host/notify', body);
  const localClock = (ms) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: TZ }).format(ms);

  // ---- 1. The writer on a laptop: a message arrives as a banner; the bell; its panel
  {
    const { ctx, page } = await open(people.ana, '/write', DESKTOP);
    await page.waitForSelector('.w-top .w-me');
    await mounted(page);
    await page.waitForSelector('.w-top .nt-bell');
    check(await page.evaluate(() => document.querySelector('.w-top .nt-bell').nextElementSibling?.classList.contains('w-me')), 'bell sits before the name menu in the writer’s top bar');
    // The automatic "approved" notice is waiting from earlier: it shows first.
    await sleep(400);
    const r = await send({ to: { kind: 'writers' }, title: 'Dinner is here', body: 'Pizza in the kitchen: veggie on the left, everything else on the right. Take a plate back to your desk if you like.', sound: true });
    check(r.recipients === 5, 'message to all writers reaches all 5', String(r.recipients));
    await bannerTitled(page, 'Dinner is here');
    const kicker = await page.textContent('.nt-banner .nt-kicker');
    check(/^From Robin · \d\d:\d\d$/.test(kicker), 'banner says who it’s from and when (local time)', kicker);
    check(await page.evaluate(() => document.querySelector('.nt-bell-n')?.textContent === '2'), 'bell counts 2 unread (approved + message)');
    await shot(page, 'banner-desktop');
    await page.click('.nt-bell');
    await page.waitForSelector('.nt-panel .nt-item');
    await page.waitForSelector('.nt-panel .nt-push:not([hidden])', { timeout: 15_000 }).catch(() => {});
    await sleep(300);
    const items = await page.$$eval('.nt-panel .nt-item .nt-title', (els) => els.map((e) => e.textContent));
    check(items[0] === 'Dinner is here' && items.includes('You’re approved — come and write'), 'panel lists the messages, newest first', JSON.stringify(items));
    await sleep(250);
    check(await page.evaluate(() => document.querySelector('.nt-bell-n').hidden), 'opening the bell reads them (count gone)');
    await shot(page, 'panel-desktop');
    // Push only where the app's worker shows pushes (public/sw.js imports sw-push.js).
    const swImports = /importScripts\([^)]*sw-push\.js/.test(await (await fetch(`${BASE}/sw.js`)).text());
    await page.waitForFunction(() => typeof globalThis.__whNotices?.push?.handler === 'boolean', null, { timeout: 15_000 }).catch(() => {});
    const st = await page.getAttribute('.nt-panel .nt-push', 'data-state');
    check(st === (swImports ? 'ask' : 'ask-page'), `push offered only if sw.js loads the push handler (sw.js ${swImports ? 'does' : 'doesn’t yet'})`, st);
    await page.keyboard.press('Escape');
    check(!(await page.$('.nt-panel')), 'Escape closes the panel');
    check(await page.evaluate(() => document.activeElement?.classList.contains('nt-bell')), 'focus returns to the bell');
    // Delivered and read counts reach the host.
    await sleep(500);
    const sent = (await host.req('/api/host/notify')).sent[0];
    check(sent.delivered >= 1 && sent.read >= 1, 'the host sees it delivered and read', JSON.stringify([sent.delivered, sent.read]));

    // A break while Dev watches the live page: there it's a banner, its end time a template shown in
    // this device's time; the writer's page has its own break banner, so the notice goes to the bell.
    const live = await open(people.dev, '/live', DESKTOP);
    await live.page.waitForSelector('.l-mast-nav');
    await mounted(live.page);
    await live.page.waitForSelector('.l-mast-nav .nt-bell');
    check(true, 'live page: the bell is in the masthead');
    const b = (await host.req('/api/host/breaks', { name: 'Dinner break', minutes: 30, mode: 'pause' })).break;
    await bannerTitled(live.page, 'Dinner break');
    const body = await live.page.textContent('.nt-banner .nt-body');
    check(body === `Your hour is paused until ${localClock(b.endAt)}. Keep writing if you like; nothing is required until then.`, 'break banner shows the end in local time', body);
    await shot(live.page, 'break-live');
    await live.ctx.close();
    await page.waitForSelector('.w-banner.banner-break', { timeout: 8000 });
    await sleep(2500);
    check(!(await page.$('.nt-banner')), 'writer page: no second break banner over its own');
    await page.click('.nt-bell');
    await page.waitForSelector('.nt-panel .nt-item');
    await sleep(300);
    check((await page.textContent('.nt-panel .nt-item .nt-title')) === 'Dinner break', 'the break notice is in the bell');
    await shot(page, 'break-desktop');
    await page.keyboard.press('Escape');

    // The ask, from the writer menu: a dialog with the reasons.
    await page.evaluate(() => import('/js/notify.js').then((m) => { m.askPushPermission('menu'); }));
    await page.waitForSelector('.nt-ask-modal');
    await sleep(250);
    check((await page.textContent('.nt-ask-modal .btn-primary')) === 'Turn on notifications', 'the ask offers “Turn on notifications”');
    await shot(page, 'ask-dialog');
    await page.keyboard.press('Escape');
    await ctx.close();
  }

  // ---- 2. The writer on a phone: banner, panel as a sheet, the card after the first words
  {
    // The ask's calm moment, shortened for the test (normally a minute after load, 20 s after typing).
    const { ctx, page } = await open(people.cleo, '/write', PHONE, () => { window.__whNoticeTiming = { afterLoadMs: 1000, quietMs: 800 }; });
    await page.waitForSelector('.w-top .w-me');
    await mounted(page);
    await banner(page); // the newest unread waiting for her (the break itself goes to the bell here)
    await send({ to: { kind: 'writers' }, body: 'Last hour starts at nine. Coffee’s fresh.', sound: true });
    await page.waitForFunction(() => /Coffee/.test(document.querySelector('.nt-banner:not(.nt-ask) .nt-body')?.textContent || ''), null, { timeout: 8000 });
    await sleep(350);
    const gap = await page.evaluate(() => document.querySelector('.nt-banner').getBoundingClientRect().top - document.querySelector('.w-banner').getBoundingClientRect().bottom);
    check(gap >= 0, 'phone: the banner sits under the page’s own break banner (in the flow)', String(gap));
    check(!(await page.$('.nt-banner .nt-title')), 'a message without a title has no empty title line');
    const box = await page.$eval('.nt-banner', (el) => { const r = el.getBoundingClientRect(); return [r.left, r.right, window.innerWidth]; });
    check(box[0] >= 4 && box[1] <= box[2] - 4, 'banner fits the phone screen', JSON.stringify(box));
    await shot(page, 'banner-phone');
    // Dismissed: the next unread message takes its place, then the banner goes.
    await page.tap('.nt-banner .nt-x');
    await bannerTitled(page, 'Dinner is here');
    check(true, 'dismissing shows the next unread message');
    await page.tap('.nt-banner .nt-x');
    await bannerTitled(page, 'You’re approved — come and write');
    await page.tap('.nt-banner .nt-x');
    await page.waitForSelector('.nt-banner', { state: 'detached', timeout: 4000 }).catch(() => {});
    check(!(await page.$('.nt-banner')), 'the last one dismissed: no banner');
    await page.tap('.nt-bell');
    await page.waitForSelector('.nt-panel.is-sheet');
    await sleep(300);
    await shot(page, 'panel-phone');
    await page.tap('.nt-panel .nt-x');
    await page.evaluate(() => import('/js/notify.js').then((m) => m.askPushPermission('words')));
    await page.waitForSelector('.nt-ask', { timeout: 10_000 }); // at the next calm moment (short test timings)
    await sleep(350);
    await shot(page, 'ask-phone');
    await page.tap('.nt-ask .btn-quiet');
    await ctx.close();
  }

  // ---- 3. Dark: phone and laptop
  {
    const { ctx, page } = await open(people.dev, '/write', { ...PHONE, colorScheme: 'dark' });
    await page.waitForSelector('.w-top .w-me');
    await mounted(page);
    await send({ to: { kind: 'ids', ids: [people.dev.id] }, title: 'Your table is ready', body: 'Devika, the quiet room upstairs is free now if you want it.', sound: false });
    await bannerTitled(page, 'Your table is ready');
    await shot(page, 'banner-phone-dark');
    await page.tap('.nt-bell');
    await page.waitForSelector('.nt-panel');
    await sleep(300);
    await shot(page, 'panel-phone-dark');
    await ctx.close();
  }
  {
    const { ctx, page } = await open(people.ana, '/write', { ...DESKTOP, colorScheme: 'dark' });
    await page.waitForSelector('.w-top .w-me');
    await mounted(page);
    await send({ to: { kind: 'ids', ids: [people.ana.id] }, title: 'Twenty minutes to go', body: 'Then we read a few pieces aloud, if you’d like yours to be one.' });
    await bannerTitled(page, 'Twenty minutes to go');
    await shot(page, 'banner-desktop-dark');
    await ctx.close();
  }

  // ---- 4. iPhone in Safari (not on the Home Screen): the Home Screen step
  {
    const noPush = () => {
      delete window.PushManager;
      delete window.Notification;
    };
    const { ctx, page } = await open(people.cleo, '/write', { ...PHONE, userAgent: IPHONE }, noPush);
    await page.waitForSelector('.w-top .w-me');
    await mounted(page);
    await page.tap('.nt-bell');
    await page.waitForSelector('.nt-panel .nt-push[data-state="ios-install"]');
    await sleep(300);
    check(/Home Screen/.test(await page.textContent('.nt-panel .nt-push')), 'iPhone: the panel explains the Home Screen step');
    await shot(page, 'panel-iphone');
    await ctx.close();
  }

  // ---- 4b. A worker with the push handler (sw-push.js on its own): push is offered
  {
    const { ctx, page } = await open(people.eli, '/live', DESKTOP);
    await page.waitForSelector('.l-mast-nav');
    await mounted(page);
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw-push.js', { scope: '/' });
      await navigator.serviceWorker.ready;
    });
    await page.click('.nt-bell');
    await page.waitForFunction(() => globalThis.__whNotices?.push?.handler === true, null, { timeout: 10_000 }).catch(() => {});
    await sleep(200);
    const st = await page.getAttribute('.nt-panel .nt-push', 'data-state');
    check(st === 'ask', 'a worker that answers the push ping: notifications on offer', st);
    check(/even when Writehaven is closed/.test(await page.textContent('.nt-panel .nt-push')), 'and the panel says they work with the app closed');
    await ctx.close();
  }

  // ---- 5. The host: the bell in the top bar, the composer in the dashboard
  // host.js mounts the composer in its "Send a message" card and ticks rows through getSelected.
  async function composer(page, { tick = [] } = {}) {
    await page.waitForSelector('.h-top-right');
    await mounted(page);
    await page.waitForSelector('.h-notify .nt-chip-n', { timeout: 10_000 });
    await page.evaluate(() => { document.querySelector('.h-notify').id = 'qa-composer'; });
    for (const name of tick) await page.check(`input[aria-label="Select ${name}"]`);
    await page.waitForFunction(() => !/Counting/.test(document.querySelector('#qa-composer .nt-preview')?.textContent || 'Counting'), null, { timeout: 8000 });
  }
  const card = (page) => page.$eval('#qa-composer', (el) => { const r = el.getBoundingClientRect(); return { x: Math.max(0, r.x - 16), y: r.y - 16 + window.scrollY, width: r.width + 32, height: r.height + 32 }; });
  {
    const { ctx, page } = await open(host, '/host', DESKTOP);
    await composer(page, { tick: ['Ana Ilić', 'Cleo Marsh'] });
    check(!!(await page.$('.h-top-right .nt-bell')), 'host: the bell is in the top bar');
    check((await page.$$eval('#qa-composer h2', (els) => els.length)) === 1, 'one heading in the card');
    await page.waitForFunction(() => /Selected2/.test(document.querySelector('#qa-composer .nt-chips')?.textContent.replace(/\s+/g, '') || ''), null, { timeout: 5000 });
    const chips = await page.$$eval('#qa-composer .nt-chip', (els) => els.map((e) => e.textContent.replace(/\s+/g, '').trim()));
    check(chips.join('|') === 'Everyone6|Allwriters5|Hosts0|Atrisk0|Out1|Notstarted1|Waitingforapproval1|Selected2|Oneperson', 'composer groups and counts (Selected from the table)', chips.join('|'));
    check(/^To 6 people: Ana Ilić, Ben Okafor, Cleo Marsh and 3 more\./.test(await page.textContent('#qa-composer .nt-preview')), 'preview names the recipients', await page.textContent('#qa-composer .nt-preview'));
    await page.click('#qa-composer [data-kind="selected"]');
    await page.waitForFunction(() => /^To 2 people: Ana Ilić and Cleo Marsh/.test(document.querySelector('#qa-composer .nt-preview')?.textContent || ''), null, { timeout: 5000 });
    await page.fill('#qa-composer #nt-title', 'Reading at ten');
    await page.fill('#qa-composer #nt-body', 'You two wrote my favourite pieces tonight. Would you read a page each at ten? No pressure at all.');
    check(await page.textContent('#qa-composer .nt-send') === 'Send to 2 people', 'send button says how many');
    await shot(page, 'composer-desktop', { clip: await card(page), fullPage: true });
    await page.click('#qa-composer .nt-send');
    await page.waitForFunction(() => document.querySelector('#qa-composer .nt-sent-title')?.textContent === 'Reading at ten', null, { timeout: 8000 });
    check((await page.inputValue('#qa-composer #nt-body')) === '', 'sending clears the message');
    await page.click('#qa-composer .nt-auto summary');
    await shot(page, 'composer-sent', { clip: await card(page), fullPage: true });
    await shot(page, 'host-desktop');
    // An automatic message switched off from the composer is the host setting.
    await page.click('#qa-composer .nt-auto-item[data-k="breaks"] input');
    await sleep(600);
    check((await host.req('/api/host/notify')).settings.breaks === false, 'switching “Breaks” off saves notify.breaks');
    await page.click('#qa-composer .nt-auto-item[data-k="breaks"] input');
    await sleep(600);
    // "One person": a picker.
    await page.click('#qa-composer [data-kind="one"]');
    await page.selectOption('#qa-composer .nt-one', people.dev.id);
    await page.waitForFunction(() => /^To Devika Rao/.test(document.querySelector('#qa-composer .nt-preview')?.textContent || ''), null, { timeout: 5000 });
    check(await page.isDisabled('#qa-composer .nt-send'), 'no message yet: Send waits', await page.textContent('#qa-composer .nt-send'));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(host, '/host', { ...DESKTOP, colorScheme: 'dark' });
    await composer(page);
    await page.fill('#qa-composer #nt-body', 'Doors close at eleven. Thank you all for coming.');
    await shot(page, 'composer-dark', { clip: await card(page), fullPage: true });
    await ctx.close();
  }
  {
    const { ctx, page } = await open(host, '/host', PHONE);
    await composer(page);
    await page.$eval('#qa-composer', (el) => el.scrollIntoView());
    await page.fill('#qa-composer #nt-body', 'Ten minutes left in this hour.');
    await shot(page, 'composer-phone', { fullPage: false });
    await ctx.close();
  }
  // ---- 6. The live page on a phone, signed in: a message arrives on the page's own stream
  {
    const { ctx, page } = await open(people.ana, '/live', PHONE);
    await page.waitForSelector('.l-mast-nav');
    await mounted(page);
    await send({ to: { kind: 'ids', ids: [people.ana.id] }, body: 'You can watch everyone writing here; your words are on it too.' });
    await page.waitForFunction(() => /watch everyone/.test(document.querySelector('.nt-banner:not(.nt-ask) .nt-body')?.textContent || ''), null, { timeout: 8000 });
    await sleep(350);
    check(true, 'live page: a message arrives on its own stream');
    await shot(page, 'live-phone');
    await ctx.close();
  }
}

try {
  await within(main(), 240_000, 'notify-qa');
} catch (e) {
  problems.push(`run: ${e.message}`);
  console.error(e);
} finally {
  if (browser) await browser.close().catch(() => {});
  try {
    server.kill('SIGTERM'); // it saves and exits; its state dir goes after that
  } catch { /* gone */ }
  await Promise.race([serverGone, sleep(5000)]);
  fs.rmSync(stateDir, { recursive: true, force: true });
}
const errs = serverLog.join('').split('\n').filter((l) => /error|uncaught|unhandled/i.test(l));
if (errs.length) problems.push(...errs.slice(0, 5).map((l) => `server: ${l}`));
log(`${passed.length} passed, ${problems.length} problems`);
for (const p of problems) log('problem:', p);
process.exit(problems.length ? 1 : 0);
