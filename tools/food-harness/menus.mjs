#!/usr/bin/env node
// The food entry points in the real app (SPEC §18): the writer menu's "Food preferences…", the
// one-time "Food" row on the writer page (lobby and writing), and the host's "Your food
// preferences…". Starts its own server on a temporary state file (stopped and removed at the
// end), one Chromium. Screenshots go to qa/after/food-*.png; behaviour checks print ok/FAIL.
//   node tools/food-harness/menus.mjs [--port 8221] [--out qa/after]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const CHROME = process.env.CHROME_PATH || undefined; // unset: Playwright's own Chromium
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const PORT = Number(arg('port', 8221));
const OUT = path.resolve(ROOT, arg('out', 'qa/after'));
const BASE = `http://127.0.0.1:${PORT}`;
fs.mkdirSync(OUT, { recursive: true });
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-food-menus-'));
const problems = [];
const t0 = Date.now();
const say = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const check = (ok, msg) => {
  if (!ok) problems.push(msg);
  say(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
};

const put = (who, body) => who.req('/api/me/food', body, 'PUT');
// A cookie-keeping API client.
function client() {
  let cookie = '';
  return {
    get token() { return /wh_sess=([^;]*)/.exec(cookie)?.[1] || ''; },
    async req(p, body, method = body === undefined ? 'GET' : 'POST') {
      const headers = { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json', 'X-WH': '1' } : {}) };
      const res = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const sc = res.headers.get('set-cookie');
      if (sc && /wh_sess=/.test(sc)) cookie = sc.split(';')[0];
      const text = await res.text();
      if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${text.slice(0, 200)}`);
      try { return JSON.parse(text); } catch { return text; }
    },
  };
}

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(PORT), WH_STATE_FILE: path.join(stateDir, 'state.json'), WH_FSYNC: '0' },
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
const stopServer = () => new Promise((resolve) => {
  if (server.exitCode !== null) return resolve();
  const hard = setTimeout(() => server.kill('SIGKILL'), 5000);
  server.once('exit', () => { clearTimeout(hard); resolve(); });
  server.kill('SIGTERM');
});

async function main() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  say(`server pid ${server.pid} on ${BASE}`);
  const host = client();
  await host.req('/api/register', { username: 'robin', password: 'longpassword', name: 'Robin' });
  await host.req('/api/host/food/options', {
    options: [{ name: 'Pizza — Franco Manca', note: 'Sourdough; vegan cheese on request', menuUrl: 'https://www.francomanca.co.uk/menu/' }, { name: 'Thai — Busaba' }],
    deadline: '18:30', note: 'We’ll order at 18:30 and split the bill.',
  }, 'PUT');
  const mk = async (username, name) => {
    const c = client();
    const r = await c.req('/api/register', { username, password: 'longpassword', name });
    await host.req('/api/host/approve', { id: r.user.id });
    return { c, id: r.user.id };
  };
  const ana = await mk('ana', 'Ana Ruiz');
  const bo = await mk('bo', 'Bo Lindqvist');
  const cy = await mk('cy', 'Cy Quill');

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none'] });
  const contexts = [];
  const open = async (who, device, theme = 'light') => {
    const ctx = await browser.newContext(device === 'phone'
      ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: 'reduce' }
      : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    contexts.push(ctx);
    await ctx.addCookies([{ name: 'wh_sess', value: who.token, url: BASE }]);
    const page = await ctx.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon|status of 40[14]|navigator\.vibrate/.test(m.text())) problems.push(`console: ${m.text()}`); });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    return page;
  };
  // Another module's notices ("You're approved") float over the top of the page: close them first.
  // They arrive over the event stream a moment after load: wait for one (once per page).
  const cleared = new WeakSet();
  const closeNotices = async (page) => {
    if (!cleared.has(page)) {
      cleared.add(page);
      await page.waitForSelector('.nt-banner .nt-x', { timeout: 4000 }).catch(() => {});
    }
    for (const x of await page.$$('.nt-banner .nt-x')) await x.click().catch(() => {});
    await page.waitForTimeout(250);
  };
  const shot = async (page, name, opts = {}) => {
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(OUT, `food-${name}.png`), ...opts });
    say(`  shot food-${name}.png`);
  };
  try {
    // ---- the lobby (before the start), on a phone: the row, then the menu item
    const w1 = await open(ana.c, 'phone');
    await w1.goto(`${BASE}/write`, { waitUntil: 'load' });
    await w1.waitForSelector('.fd-nudge', { timeout: 10000 });
    await closeNotices(w1);
    const lay = await w1.evaluate(() => {
      const n = document.querySelector('.fd-nudge').getBoundingClientRect();
      const m = document.querySelector('.w-main').getBoundingClientRect();
      return { nudgeBottom: n.bottom, mainTop: m.top, grid: document.querySelector('.w-app').classList.contains('has-fd-nudge') };
    });
    check(lay.grid && lay.mainTop >= lay.nudgeBottom - 1, `lobby: the row sits above the page, covering nothing ${JSON.stringify(lay)}`);
    await shot(w1, 'nudge-lobby-phone-light');
    await closeNotices(w1);
    await w1.click('.w-me');
    await w1.waitForSelector('.menu-pop');
    const items = await w1.$$eval('.menu-pop .menu-item .menu-label', (els) => els.map((e) => e.textContent));
    check(items.includes('Food preferences…'), `writer menu has "Food preferences…" (${items.length} items)`);
    await shot(w1, 'writer-menu-phone-light');
    await w1.click('.menu-pop .menu-item:has-text("Food preferences…")');
    await w1.waitForSelector('dialog.fd-sheet.is-open .fd-part');
    await w1.waitForTimeout(300);
    await shot(w1, 'writer-menu-sheet-phone-light');
    // Answering in the sheet makes the row go away for good.
    await w1.click('.fd-part-order .fd-chip:has-text("Yes")');
    await w1.waitForFunction(() => document.querySelector('.fd-status')?.classList.contains('is-saved'), null, { timeout: 8000 });
    await w1.click('.fd-sheet-done');
    await w1.waitForTimeout(600);
    check(!(await w1.$('.fd-nudge')), 'answered: the row is gone');
    await w1.reload({ waitUntil: 'load' });
    await w1.waitForTimeout(2500);
    check(!(await w1.$('.fd-nudge')), 'answered: it doesn’t come back after a reload');

    // ---- writing (after the start), on a desktop: never while typing, never takes the focus
    await host.req('/api/admin/start', {});
    const w2 = await open(bo.c, 'desktop');
    // Hold the food answer back until the writer is typing, so the row becomes due mid-typing.
    let release;
    const gate = new Promise((r) => { release = r; });
    await w2.route('**/api/me/food', async (route) => {
      await gate;
      await route.continue();
    });
    await w2.goto(`${BASE}/write`, { waitUntil: 'load' });
    const start = await w2.$('.w-empty button.btn-primary');
    if (start) await start.click();
    await w2.waitForSelector('.cm-content');
    await closeNotices(w2);
    await w2.click('.w-sheet .cm-content');
    let seenWhileTyping = false;
    for (let i = 0; i < 12; i++) {
      await w2.keyboard.type('word ', { delay: 40 });
      if (i === 1) release();
      if (await w2.$('.fd-nudge')) seenWhileTyping = true;
      await w2.waitForTimeout(250);
    }
    check(!seenWhileTyping, 'writing: the row never appears while typing (it was due after the 2nd word)');
    await w2.waitForSelector('.fd-nudge', { timeout: 8000 });
    const focus = await w2.evaluate(() => !!document.activeElement?.closest('.cm-editor'));
    check(focus, 'writing: it appears after a pause, and the editor keeps the focus');
    await closeNotices(w2);
    await shot(w2, 'nudge-writing-desktop-light');
    // Dismissed: gone, and stays gone.
    await w2.click('.fd-nudge-x');
    check(!(await w2.$('.fd-nudge')) && !(await w2.evaluate(() => document.querySelector('.w-app').classList.contains('has-fd-nudge'))), 'dismissed: gone, and the page has its row back');
    await w2.reload({ waitUntil: 'load' });
    await w2.waitForTimeout(3500);
    check(!(await w2.$('.fd-nudge')), 'dismissed: it doesn’t come back after a reload');
    // Dark, on a phone, while writing.
    const w3 = await open(cy.c, 'phone', 'dark');
    await w3.goto(`${BASE}/write`, { waitUntil: 'load' });
    const start3 = await w3.$('.w-empty button.btn-primary');
    if (start3) await start3.click();
    await w3.waitForSelector('.fd-nudge', { timeout: 10000 });
    await closeNotices(w3);
    await shot(w3, 'nudge-writing-phone-dark');

    // ---- "Out of ideas? Read everyone's food answers" under the brainstorm hint (SPEC §20d)
    await put(ana.c, { share: true, love: 'Ethiopian, anything with lime', order: { eating: 'yes', wish: 'whatever is vegan' } });
    await w2.click('.w-controls button:has-text("Planning notes")');
    await w2.waitForSelector('.w-notes-hint .fd-ideas-link', { timeout: 8000 });
    await w2.evaluate(() => { document.querySelector('.w-notes-hint').open = true; });
    await w2.waitForTimeout(200);
    await shot(w2, 'ideas-link-desktop-light');
    await w2.click('.w-notes-hint .fd-ideas-link');
    await w2.waitForSelector('dialog.fd-sheet.is-open .fd-ev-card', { timeout: 8000 });
    const evText = await w2.evaluate(() => document.querySelector('.fd-ev').textContent);
    check(/Ethiopian/.test(evText) && !/Ana Ruiz/.test(evText), 'ideas link: opens Everyone’s food, without names');
    await w2.waitForTimeout(300);
    await shot(w2, 'ideas-everyone-desktop-light');
    await w2.keyboard.press('Escape');
    await w2.waitForTimeout(500);

    // ---- the host's own menu
    const hd = await open(host, 'desktop');
    await hd.goto(`${BASE}/host`, { waitUntil: 'load' });
    await hd.waitForSelector('.h-top-links');
    const links = await hd.$$eval('.h-top-links .btn', (els) => els.map((e) => e.textContent));
    check(links.includes('Your food preferences…'), `host header has "Your food preferences…" (${links.join(' | ')})`);
    await shot(hd, 'host-menu-desktop-light', { clip: { x: 0, y: 0, width: 1440, height: 260 } });
    await hd.click('.h-top-links .btn:has-text("Your food preferences…")');
    await hd.waitForSelector('dialog.fd-sheet.is-open .fd-part');
    await hd.waitForTimeout(300);
    await shot(hd, 'host-menu-sheet-desktop-light');
    const hp = await open(host, 'phone');
    await hp.goto(`${BASE}/host`, { waitUntil: 'load' });
    await hp.waitForSelector('.h-more');
    await hp.click('.h-more');
    await hp.waitForSelector('.menu-pop');
    const more = await hp.$$eval('.menu-pop .menu-item .menu-label', (els) => els.map((e) => e.textContent));
    check(more.includes('Your food preferences…'), `host phone menu has "Your food preferences…" (${more.join(' | ')})`);
    await shot(hp, 'host-menu-phone-light');
  } finally {
    for (const c of contexts) await c.close().catch(() => {});
    await browser.close().catch(() => {});
    await stopServer();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  if (problems.length) {
    console.log(`\n${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
    if (/error/i.test(serverLog)) console.log(`server log:\n${serverLog.slice(-2000)}`);
    process.exitCode = 1;
  } else console.log('\nno problems');
}

main().catch(async (e) => {
  console.error(e);
  await stopServer();
  fs.rmSync(stateDir, { recursive: true, force: true });
  process.exit(1);
});
