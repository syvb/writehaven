#!/usr/bin/env node
// Screenshots of the help sheet for review, plus a few behaviour checks (Escape, focus return,
// the focus trap, the scrim, deep links, no API calls when settings are given). One Chromium at a
// time: one per device, with one page reused across that device's variants.
//   node tools/help-harness/shoot.mjs [--port 8210] [--out qa/after] [--only desktop-light]
// Writes help-<device>-<theme>-00-default.png (as it opens), -01..-NN (all sections open, scrolled
// page by page), help-<device>-light-counting.png (deep link), help-desktop-light-host-*.png and
// help-phone-dark-guest-00-default.png.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from './serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const CHROME = process.env.CHROME_PATH || undefined; // unset: Playwright's own Chromium
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const PORT = Number(arg('port', 8210));
const OUT = path.resolve(ROOT, arg('out', 'qa/after'));
const ONLY = arg('only', '');
const BASE = `http://127.0.0.1:${PORT}/harness/`;
fs.mkdirSync(OUT, { recursive: true });

const DEVICES = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};
const problems = [];
const shots = [];
const t0 = Date.now();
const say = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

// Each step gets 90 s: a stuck browser fails the run with a message instead of hanging it.
async function step(label, fn) {
  say(`start ${label}`);
  let timer;
  try {
    await Promise.race([fn(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label}: no progress in 90 s`)), 90_000); })]);
  } finally {
    clearTimeout(timer);
  }
}

// One page per device. The listeners report against whichever variant is running.
const pages = {};
let current = { name: '', role: '', api: [] };
async function pageFor(browser, device) {
  if (pages[device]) return pages[device];
  const ctx = await browser.newContext({ ...DEVICES[device], reducedMotion: 'no-preference' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  page.on('request', (r) => { if (new URL(r.url()).pathname.startsWith('/api/')) current.api.push(r.url()); });
  page.on('console', (m) => {
    // A signed-out visitor's GET /api/me answers 401: the browser logs it, the sheet takes it in its stride.
    if (m.type() === 'error' && !(current.role === 'guest' && /status of 401/.test(m.text()))) problems.push(`${current.name}: console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`${current.name}: page error: ${e.message}`));
  pages[device] = page;
  return page;
}
async function load(page, url, theme) {
  await page.emulateMedia({ colorScheme: theme });
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 20000 });
  } catch {
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  }
}
const settle = (page, ms = 450) => page.waitForTimeout(ms);
async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  shots.push(path.relative(ROOT, file));
}

async function variant(browser, device, theme, { role = 'writer', tag = '', all = true, extra = '' } = {}) {
  const name = `help-${device}-${theme}${tag ? `-${tag}` : ''}`;
  if (ONLY && !name.includes(ONLY)) return;
  const page = await pageFor(browser, device);
  current = { name, role, api: [] };
  await load(page, `${BASE}?theme=${theme}&role=${role}${extra}`, theme);
  await page.waitForSelector('dialog.hp.is-open');
  await settle(page, 700);
  await shot(page, `${name}-00-default`);
  if (all) {
    await page.click('.hp-all');
    await settle(page, 600);
    const n = await page.evaluate(() => {
      const s = document.querySelector('.hp-scroll');
      s.scrollTop = 0;
      return Math.ceil((s.scrollHeight - s.clientHeight) / Math.max(1, s.clientHeight - 90)) + 1;
    });
    for (let i = 0; i < n; i++) {
      await page.evaluate((k) => {
        const s = document.querySelector('.hp-scroll');
        s.scrollTop = k * (s.clientHeight - 90);
      }, i);
      await settle(page, 150);
      await shot(page, `${name}-${String(i + 1).padStart(2, '0')}`);
    }
    say(`  ${name}: ${n} pages`);
  }
  if (role !== 'guest' && current.api.length) problems.push(`${name}: API calls with settings given: ${current.api.join(', ')}`);
}

async function deepLink(browser, device) {
  const name = `help-${device}-light-counting`;
  if (ONLY && !name.includes(ONLY)) return;
  const page = await pageFor(browser, device);
  current = { name, role: 'writer', api: [] };
  await load(page, `${BASE}?theme=light&section=counting`, 'light');
  await page.waitForSelector('dialog.hp.is-open');
  await settle(page, 700);
  const st = await page.evaluate(() => ({
    open: [...document.querySelectorAll('.hp-sec.is-open')].map((x) => x.dataset.id),
    focus: document.activeElement?.id || document.activeElement?.className,
  }));
  if (st.open.join() !== 'counting' || st.focus !== 'hp-t-counting') problems.push(`${name}: deep link state ${JSON.stringify(st)}`);
  await shot(page, name);
}

// Escape closes and focus goes back to the opener; Tab stays inside; the scrim closes it too.
async function behaviour(browser) {
  if (ONLY) return;
  const page = await pageFor(browser, 'desktop');
  current = { name: 'behaviour', role: 'writer', api: [] };
  await load(page, `${BASE}?open=0`, 'light');
  await page.focus('#hh-open');
  await page.keyboard.press('Enter');
  await page.waitForSelector('dialog.hp.is-open');
  await settle(page, 500);
  const inside = [];
  for (let i = 0; i < 16; i++) {
    await page.keyboard.press('Tab');
    inside.push(await page.evaluate(() => !!document.activeElement?.closest('dialog.hp')));
  }
  if (inside.includes(false)) problems.push(`behaviour: Tab left the sheet (${inside.join(',')})`);
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+Tab');
  if (!(await page.evaluate(() => !!document.activeElement?.closest('dialog.hp')))) problems.push('behaviour: Shift+Tab left the sheet');
  await page.keyboard.press('Escape');
  await settle(page, 600);
  const after = await page.evaluate(() => ({ open: !!document.querySelector('dialog.hp'), focus: document.activeElement?.id, lock: document.documentElement.classList.contains('hp-open') }));
  if (after.open || after.focus !== 'hh-open' || after.lock) problems.push(`behaviour: after Escape ${JSON.stringify(after)}`);
  // The scrim: a click left of the sheet closes it.
  await page.click('#hh-open-counting');
  await page.waitForSelector('dialog.hp.is-open');
  await settle(page, 500);
  await page.mouse.click(200, 450);
  await settle(page, 600);
  if (await page.evaluate(() => !!document.querySelector('dialog.hp'))) problems.push('behaviour: a click on the scrim did not close the sheet');
  // A second openHelp while open jumps to the section instead of stacking sheets.
  await page.evaluate(() => { window.__help.open(); window.__help.open('privacy'); });
  await settle(page, 500);
  const one = await page.evaluate(() => ({ n: document.querySelectorAll('dialog.hp').length, open: [...document.querySelectorAll('.hp-sec.is-open')].map((x) => x.dataset.id) }));
  if (one.n !== 1 || !one.open.includes('privacy')) problems.push(`behaviour: second open ${JSON.stringify(one)}`);
  // The waiting-room lines.
  const lines = await page.evaluate(() => window.__help.howTonightWorks(window.__help.settings));
  console.log(`howTonightWorks:\n  ${lines.join('\n  ')}`);
  if (lines.length < 5 || lines.length > 6) problems.push(`howTonightWorks: ${lines.length} lines`);
}

const server = createServer();
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
// One browser per device, one after the other: a second context in one browser stalled now and
// then on a busy machine, a fresh browser's first context never did.
const runs = {
  desktop: async (browser) => {
    for (const theme of ['light', 'dark']) await step(`desktop ${theme}`, () => variant(browser, 'desktop', theme, { extra: '&break=reduce&brainstorm=1&first=prorated' }));
    await step('desktop deep link', () => deepLink(browser, 'desktop'));
    await step('host', () => variant(browser, 'desktop', 'light', { role: 'host', tag: 'host', extra: '&section=host&break=pause' }));
    await step('behaviour', () => behaviour(browser));
  },
  phone: async (browser) => {
    for (const theme of ['light', 'dark']) await step(`phone ${theme}`, () => variant(browser, 'phone', theme, { extra: '&break=reduce&brainstorm=1&first=extended' }));
    await step('phone deep link', () => deepLink(browser, 'phone'));
    await step('guest', () => variant(browser, 'phone', 'dark', { role: 'guest', tag: 'guest', all: false }));
  },
};
for (const [device, run] of Object.entries(runs)) {
  let browser;
  try {
    browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
    await run(browser);
  } catch (e) {
    problems.push(`${device} run: ${e.stack || e.message}`);
  } finally {
    await Promise.race([browser?.close(), new Promise((r) => setTimeout(r, 10000))]).catch(() => {});
    delete pages[device];
  }
}
server.close();
console.log(`${shots.length} screenshots:\n  ${shots.join('\n  ')}`);
console.log(problems.length ? `PROBLEMS:\n  ${problems.join('\n  ')}` : 'No problems found.');
process.exit(problems.length ? 1 : 0);
