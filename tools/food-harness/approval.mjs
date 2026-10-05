#!/usr/bin/env node
// The moment of approval (SPEC §20e), in the real app on a phone: the waiting card says "You're
// approved" and waits for a click on "Start writing" while the food form stays as it is (keystrokes
// keep landing there, nothing moves); the click saves it and opens the editor, which shows one "You're in"
// notice (with "Open food preferences" when the answers aren't complete) that covers nothing,
// takes no focus, replaces the "Food" row and the server's own "You're approved" banner,
// and doesn't come back. Its own server and temporary state (removed at the end), one Chromium.
//   node tools/food-harness/approval.mjs [--port 8222] [--out qa/after]
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
const PORT = Number(arg('port', 8222));
const OUT = path.resolve(ROOT, arg('out', 'qa/after'));
const BASE = `http://127.0.0.1:${PORT}`;
fs.mkdirSync(OUT, { recursive: true });
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-food-approval-'));
const problems = [];
const t0 = Date.now();
const say = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const check = (ok, msg) => {
  if (!ok) problems.push(msg);
  say(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
};

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
  await host.req('/api/register', { username: 'robin', password: 'longpassword', name: 'Robin', email: 'host@example.com' });
  await host.req('/api/host/food/options', { options: [{ name: 'Pizza — Franco Manca' }, { name: 'Thai — Busaba' }], deadline: '18:30' }, 'PUT');
  await host.req('/api/admin/start', {});
  const signUp = async (username, name) => {
    const c = client();
    const r = await c.req('/api/register', { username, password: 'longpassword', name, email: `${username}@example.com` });
    return { c, id: r.user.id };
  };
  const ines = await signUp('ines', 'Ines Duarte');
  const tom = await signUp('tom', 'Tom Okafor');
  const ada = await signUp('ada', 'Ada Brennan');
  check((await ines.c.req('/api/me')).me.approval === 'pending', 'they start out waiting for approval');

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none'] });
  const contexts = [];
  const open = async (who, theme = 'light') => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
    contexts.push(ctx);
    await ctx.addCookies([{ name: 'wh_sess', value: who.token, url: BASE }]);
    const page = await ctx.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon|status of 40[14]|navigator\.vibrate/.test(m.text())) problems.push(`console: ${m.text()}`); });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.goto(`${BASE}/write`, { waitUntil: 'load' });
    await page.waitForSelector('.ap-food .fd-part-prefs textarea');
    await page.evaluate(() => document.fonts.ready);
    return page;
  };
  const shot = async (page, name) => {
    await page.screenshot({ path: path.join(OUT, `food-${name}.png`) });
    say(`  shot food-${name}.png`);
  };
  const afterSwitch = async (page) => {
    await page.waitForSelector('.w-app', { timeout: 10000 });
    await page.waitForSelector('.fd-welcome', { timeout: 10000 });
    await page.waitForTimeout(3200); // the server's own "You're approved" notice comes within ~2 s
    return page.evaluate(() => {
      const n = document.querySelector('.fd-welcome');
      const m = document.querySelector('.w-main').getBoundingClientRect();
      return {
        text: n.textContent,
        open: !!n.querySelector('.fd-welcome-go'),
        rows: document.querySelectorAll('.fd-nudge').length,
        covers: n.getBoundingClientRect().bottom > m.top + 1,
        focusInside: !!document.activeElement?.closest('.fd-welcome'),
        theirs: !!document.querySelector('.nt-banner.nt-k-approved:not(.is-out)'),
      };
    });
  };
  // The waiting card's approved state: still on the waiting page, the food form untouched.
  const approvedCard = async (page) => {
    await page.waitForSelector('.ap-go', { timeout: 10000 });
    return page.evaluate(() => ({
      title: document.querySelector('.ap-title')?.textContent,
      lede: document.querySelector('.ap-lede')?.textContent,
      button: document.querySelector('.ap-go')?.textContent,
      writer: !!document.querySelector('.w-app'),
      food: !!document.querySelector('.ap-food .fd-part'),
      foodTitle: document.querySelector('.ap-food .fd-title')?.textContent,
    }));
  };
  const startWriting = async (page) => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.click('.ap-go');
  };
  try {
    // ---- 1. Approved after typing, before the autosave went out: nothing switches; the click saves.
    const p1 = await open(ines.c);
    await p1.click('.ap-food .fd-part-order .fd-chip:has-text("Yes")');
    await p1.waitForFunction(() => document.querySelector('.ap-food .fd-status')?.classList.contains('is-saved'));
    const TEXT = 'mushrooms, coriander and anything too sweet';
    const avoid = p1.locator('.ap-food .fd-part-prefs textarea').first();
    await avoid.scrollIntoViewIfNeeded();
    await avoid.click();
    await avoid.type(TEXT, { delay: 20 });
    const before = (await ines.c.req('/api/me/food')).food?.avoid || '';
    check(before === '', `typed but not yet saved when the host approves (server had "${before}")`);
    await shot(p1, 'approval-typing-phone-light');
    await host.req('/api/host/approve', { id: ines.id });
    const c1 = await approvedCard(p1);
    check(c1.title === 'You’re approved' && /Your first hour starts when you start writing\./.test(c1.lede) && /Start writing/.test(c1.button), `the card says so, with one button (${JSON.stringify(c1)})`);
    check(c1.foodTitle === 'Food preferences', `the food card is retitled in place ("${c1.foodTitle}")`);
    await p1.waitForTimeout(4000);
    const still = await p1.evaluate(() => ({ writer: !!document.querySelector('.w-app'), value: document.querySelector('.ap-food .fd-part-prefs textarea')?.value, focus: document.activeElement?.tagName }));
    check(!still.writer && still.value === TEXT && still.focus === 'TEXTAREA', `nothing switches by itself; the text and the focus stay put ${JSON.stringify(still)}`);
    await avoid.type(' please', { delay: 20 });
    check(await avoid.inputValue() === `${TEXT} please`, 'they can keep typing in the food form');
    await shot(p1, 'approval-approved-form-phone-light');
    await p1.evaluate(() => window.scrollTo(0, 0));
    await p1.waitForTimeout(200);
    await shot(p1, 'approval-approved-card-phone-light');
    await startWriting(p1);
    const s1 = await afterSwitch(p1);
    const after1 = (await ines.c.req('/api/me/food')).food;
    check(after1?.avoid === `${TEXT} please`, `the click saved it first: avoid = "${after1?.avoid}"`);
    check(/You’re in: writing starts now\./.test(s1.text) && /finish them any time from the menu → Food preferences/.test(s1.text) && s1.open, `not complete: the notice and its button (${s1.text.slice(0, 90)}…)`);
    check(s1.rows === 1, `one notice, no "Food" row too (${s1.rows})`);
    check(!s1.covers, 'it covers nothing (the page starts below it)');
    check(!s1.focusInside, 'it takes no focus');
    check(!s1.theirs, 'the server’s own “You’re approved” banner isn’t shown as well');
    await shot(p1, 'approval-notice-phone-light');
    await p1.click('.fd-welcome-go');
    await p1.waitForSelector('dialog.fd-sheet.is-open .fd-part');
    const kept = await p1.evaluate(() => document.querySelector('dialog.fd-sheet .fd-part-prefs textarea')?.value);
    check(kept === `${TEXT} please`, 'Open food preferences: the sheet has what they typed');
    await p1.keyboard.press('Escape');
    await p1.reload({ waitUntil: 'load' });
    await p1.waitForSelector('.w-app');
    await p1.waitForTimeout(3500);
    check(!(await p1.$('.fd-welcome')) && !(await p1.$('.fd-nudge')), 'once: nothing after a reload');

    // ---- 2. Approved while typing: every keystroke stays in the food form, which doesn't move.
    const p2 = await open(tom.c, 'dark');
    const LONG = 'very spicy things, olives, and anything with a lot of cream in it, honestly most desserts too';
    const field = p2.locator('.ap-food .fd-part-prefs textarea').first();
    await field.scrollIntoViewIfNeeded();
    await field.click();
    const top0 = await field.evaluate((el) => el.getBoundingClientRect().top);
    const typing = field.type(LONG, { delay: 45 });
    await p2.waitForTimeout(1500);
    await host.req('/api/host/approve', { id: tom.id });
    await p2.waitForSelector('.ap-go', { timeout: 10000 });
    const top1 = await field.evaluate((el) => el.getBoundingClientRect().top);
    await typing;
    const v2 = await p2.evaluate(() => ({ value: document.querySelector('.ap-food .fd-part-prefs textarea')?.value, writer: !!document.querySelector('.w-app') }));
    check(v2.value === LONG && !v2.writer, `approved mid-typing: every keystroke landed in the food form (${v2.value.length} of ${LONG.length})`);
    check(Math.abs(top1 - top0) <= 2, `the food form didn't move, retitle included (${Math.round(top0)} → ${Math.round(top1)})`);
    check(await p2.evaluate(() => document.querySelector('.ap-food .fd-title')?.textContent) === 'Food preferences', 'mid-typing: retitled too');
    await shot(p2, 'approval-approved-form-phone-dark');
    await startWriting(p2);
    const s2 = await afterSwitch(p2);
    const stored = (await tom.c.req('/api/me/food')).food?.avoid || '';
    check(stored === LONG, `nothing typed is lost: the server has all of it (${stored.length} of ${LONG.length} characters)`);
    const post = await p2.evaluate(() => document.querySelector('.cm-content')?.textContent || '');
    check(!/cream|desserts|olives/.test(post), `none of it lands in their post ("${post.slice(0, 40)}")`);
    check(/finish them any time/.test(s2.text) && s2.rows === 1, 'the same single notice after the click');
    await shot(p2, 'approval-notice-phone-dark');

    // ---- 3. Everything answered: a plain "You're in" after the click.
    const opts = (await host.req('/api/host/food')).order.options;
    await ada.c.req('/api/me/food', { order: { eating: 'yes', hunger: 'normal', picks: [opts[0].id], lines: { [opts[0].id]: 'margherita' } }, diet: 'vegetarian' }, 'PUT');
    const p3 = await open(ada.c);
    await host.req('/api/host/approve', { id: ada.id });
    await approvedCard(p3);
    await startWriting(p3);
    const s3 = await afterSwitch(p3);
    check(/You’re in: writing starts now\./.test(s3.text) && !s3.open && !/Food preferences/.test(s3.text), `complete: a plain notice (${s3.text})`);
    await shot(p3, 'approval-complete-phone-light');
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
