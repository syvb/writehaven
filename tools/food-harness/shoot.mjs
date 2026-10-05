#!/usr/bin/env node
// Screenshots of the food components for review, plus behaviour checks: autosave and the "Saved"
// line, offline and retry, reload keeps answers, a reset elsewhere clears an open form, the
// sheet's Escape/focus return/focus trap, the host card's severe callout, the CSV download before
// a reset, the RESET confirmation, and Copy order list (clipboard and the select-all fallback).
// One Chromium, closed at the end; the harness server runs in this process.
//   node tools/food-harness/shoot.mjs [--port 8220] [--out qa/after] [--only pending]
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
const PORT = Number(arg('port', 8220));
const OUT = path.resolve(ROOT, arg('out', 'qa/after'));
const ONLY = arg('only', '');
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
  if (ONLY && !label.includes(ONLY)) return;
  say(`start ${label}`);
  let timer;
  try {
    await Promise.race([fn(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label}: no progress in 90 s`)), 90_000); })]);
  } catch (e) {
    problems.push(`${label}: ${e.message}`);
    say(`FAIL ${label}: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

const harness = (p, body = {}) => fetch(`${BASE}${p}`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());
const stateNow = () => fetch(`${BASE}/harness/api/state`).then((r) => r.json());

let browser;
const pages = {};
let current = '';
async function pageFor(device, { fresh = false } = {}) {
  if (pages[device] && !fresh) return pages[device];
  if (pages[device]) await pages[device].context().close();
  const ctx = await browser.newContext({ ...DEVICES[device], reducedMotion: 'reduce', acceptDownloads: true });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of (503|409)/.test(m.text())) problems.push(`${current}: console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`${current}: page error: ${e.message}`));
  pages[device] = page;
  return page;
}
async function load(page, query, theme = 'light') {
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await page.goto(`${BASE}/harness/?${query}&theme=${theme}`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === '1' || document.body.dataset.ready === 'error');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
}
async function shot(page, name, opts = {}) {
  const file = path.join(OUT, `food-${name}.png`);
  await page.screenshot({ path: file, ...opts });
  shots.push(path.relative(ROOT, file));
}
const statusText = (page) => page.evaluate(() => document.querySelector('.fd-status')?.textContent || '');
const waitSaved = (page) => page.waitForFunction(() => document.querySelector('.fd-status')?.classList.contains('is-saved'), null, { timeout: 8000 });

// Fill the pending form like a guest would.
async function fillForm(page) {
  await page.click('.fd-part-order .fd-chip:has-text("Yes")');
  await page.click('.fd-part-order .fd-chip:has-text("Normal")');
  await page.click('.fd-opt-pick:has-text("Pizza")');
  await page.click('.fd-opt-pick:has-text("Thai")');
  await page.fill('.fd-pick:nth-child(1) input', 'large margherita, extra basil');
  await page.fill('.fd-pick:nth-child(2) input', 'pad thai, tofu, medium spicy');
  await page.click('.fd-part-prefs .fd-chip:has-text("Vegetarian")');
  await page.click('.fd-quick .fd-chip:has-text("Peanuts")');
  await page.selectOption('.fd-row:nth-child(1) .fd-row-sev', 'severe');
  await page.fill('.fd-row:nth-child(1) .fd-row-note', 'carries an EpiPen');
  await page.click('.fd-quick .fd-chip:has-text("Dairy")');
  await page.selectOption('.fd-row:nth-child(2) .fd-row-sev', 'intolerance');
  await page.click('.fd-spice .fd-chip:has-text("Medium")');
  await page.fill('.fd-part-prefs textarea >> nth=0', 'mushrooms, coriander');
  await page.blur?.('textarea');
}

async function main() {
  const server = createServer();
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  say(`harness on ${BASE}`);
  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none'] });
  try {
    // ---------------------------------------------------------------- the pending screen
    await step('pending', async () => {
      for (const device of ['desktop', 'phone']) {
        for (const theme of ['light', 'dark']) {
          current = `pending-${device}-${theme}`;
          const page = await pageFor(device);
          await load(page, 'view=pending&seed=sample&fresh=1', theme);
          await shot(page, `pending-${device}-${theme}`);
          await shot(page, `pending-${device}-${theme}-full`, { fullPage: true });
        }
      }
    });
    await step('pending-filled', async () => {
      for (const device of ['desktop', 'phone']) {
        current = `pending-filled-${device}`;
        const page = await pageFor(device);
        await load(page, 'view=pending&seed=sample&fresh=1', 'light');
        await fillForm(page);
        await waitSaved(page);
        const st = await stateNow();
        const f = st.me.food;
        check(f && f.diet === 'vegetarian' && f.order.picks.join() === 'pizza,thai' && f.order.lines.pizza === 'large margherita, extra basil', `${device}: the filled form reached the server`);
        check(f && f.allergies[0]?.severity === 'severe' && f.allergies[0]?.note === 'carries an EpiPen', `${device}: the severe allergy row saved`);
        check(/^Saved/.test(await statusText(page)), `${device}: "Saved" shows (${await statusText(page)})`);
        await page.evaluate(() => window.scrollTo(0, 0));
        await shot(page, `pending-filled-${device}-light-full`, { fullPage: true });
        const order = await page.$('.fd-part-order');
        await order.scrollIntoViewIfNeeded();
        await shot(page, `pending-filled-${device}-light`);
        if (device === 'desktop') {
          const rows = await page.$('.fd-rows');
          await rows.scrollIntoViewIfNeeded();
          await page.evaluate(() => window.scrollBy(0, -120));
          await shot(page, 'pending-filled-desktop-light-allergies');
        }
        // A reload brings the answers back from the server.
        await load(page, 'view=pending', 'light');
        const vals = await page.evaluate(() => ({
          line: document.querySelector('.fd-pick input')?.value,
          sev: document.querySelector('.fd-row-sev')?.value,
          veg: document.querySelector('.fd-part-prefs .fd-chip[aria-pressed="true"]')?.textContent,
        }));
        check(vals.line === 'large margherita, extra basil' && vals.sev === 'severe' && vals.veg === 'Vegetarian', `${device}: a reload shows the saved answers ${JSON.stringify(vals)}`);
      }
    });
    await step('pending-offline', async () => {
      current = 'pending-offline';
      const page = await pageFor('desktop');
      await load(page, 'view=pending&seed=sample&fresh=1', 'light');
      await harness('/harness/api/offline', { on: true });
      await page.click('.fd-part-prefs .fd-chip:has-text("Vegan")');
      await page.waitForFunction(() => document.querySelector('.fd-status')?.classList.contains('is-offline'), null, { timeout: 8000 });
      check(/Offline/.test(await statusText(page)), `offline: says so (${await statusText(page)})`);
      const draft = await page.evaluate(() => JSON.parse(localStorage.getItem('wh-food:me') || 'null'));
      check(draft && draft.dirty && draft.food.diet === 'vegan', 'offline: the answer is kept on the device');
      await shot(page, 'pending-offline-desktop-light');
      // A reload while offline keeps the draft.
      await load(page, 'view=pending', 'light');
      check(await page.evaluate(() => document.querySelector('.fd-part-prefs .fd-chip[aria-pressed="true"]')?.textContent) === 'Vegan', 'offline: a reload keeps the unsent answer');
      await harness('/harness/api/offline', { on: false });
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await waitSaved(page);
      check((await stateNow()).me.food?.diet === 'vegan', 'offline: sent when the connection is back');
    });
    await step('pending-reset', async () => {
      current = 'pending-reset';
      const page = await pageFor('desktop');
      await load(page, 'view=pending&seed=sample&fresh=1', 'light');
      await page.click('.fd-part-prefs .fd-chip:has-text("Pescatarian")');
      await waitSaved(page);
      await fetch(`${BASE}/api/host/food/reset`, { method: 'POST', headers: { 'X-WH': '1' }, body: '{}' });
      await page.click('.fd-spice .fd-chip:has-text("Hot")');
      await page.waitForFunction(() => !document.querySelector('.fd-notice')?.hidden, null, { timeout: 8000 });
      const after = await page.evaluate(() => ({ notice: document.querySelector('.fd-notice')?.textContent, pressed: [...document.querySelectorAll('.fd-chip[aria-pressed="true"]')].map((b) => b.textContent) }));
      check(/new food order/.test(after.notice || '') && after.pressed.includes('Pescatarian') && after.pressed.some((t) => /Hot/.test(t)), `reset: the open form keeps the standing answers (and the change being made) and says why ${JSON.stringify(after)}`);
      await waitSaved(page);
      const kept = (await stateNow()).me.food;
      check(kept?.diet === 'pescatarian' && kept?.spice === 'hot' && !kept?.order?.eating, `reset: the server has the kept answers plus the new change, and no order ${JSON.stringify({ diet: kept?.diet, spice: kept?.spice, eating: kept?.order?.eating })}`);
      await shot(page, 'pending-after-reset-desktop-light');
    });

    // ---------------------------------------------------------------- the sheet
    await step('sheet', async () => {
      for (const device of ['desktop', 'phone']) {
        for (const theme of ['light', 'dark']) {
          current = `sheet-${device}-${theme}`;
          const page = await pageFor(device);
          await load(page, 'view=sheet&seed=sample&fresh=1', theme);
          await page.waitForSelector('dialog.fd-sheet.is-open .fd-part');
          await page.waitForTimeout(300);
          await shot(page, `sheet-${device}-${theme}`);
          if (theme === 'light') {
            await page.fill('.fd-part-order input >> nth=0', 'whatever is vegan, maybe the pad thai with tofu');
            await page.waitForSelector('.fd-words:not([hidden])');
            await page.waitForTimeout(200);
            await shot(page, `sheet-${device}-${theme}-counter`);
            await page.evaluate(() => { const s = document.querySelector('.fd-sheet-scroll'); s.scrollTop = s.scrollHeight * 0.42; });
            await page.waitForTimeout(150);
            await shot(page, `sheet-${device}-${theme}-scrolled`);
          }
        }
      }
      // Behaviour: open from a button, Tab stays inside, Escape closes and focus returns.
      current = 'sheet-behaviour';
      const page = await pageFor('desktop');
      await load(page, 'view=lobby&seed=sample', 'light');
      await page.focus('#fh-open');
      await page.keyboard.press('Enter');
      await page.waitForSelector('dialog.fd-sheet.is-open .fd-part');
      const inside = [];
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press('Tab');
        inside.push(await page.evaluate(() => !!document.activeElement?.closest('dialog.fd-sheet')));
      }
      check(!inside.includes(false), 'sheet: Tab stays inside');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      const st = await page.evaluate(() => ({ open: !!document.querySelector('dialog.fd-sheet'), focus: document.activeElement?.id, lock: document.documentElement.classList.contains('fd-open') }));
      check(!st.open && st.focus === 'fh-open' && !st.lock, `sheet: Escape closes, focus returns ${JSON.stringify(st)}`);
      // Done sends what was typed.
      await page.click('#fh-open');
      await page.waitForSelector('dialog.fd-sheet.is-open .fd-part');
      await page.fill('.fd-part-order input >> nth=0', 'something warm');
      await page.click('.fd-sheet-done');
      await page.waitForTimeout(700);
      const me = (await stateNow()).me;
      check(me.food?.order?.lines?.pizza === 'something warm' || me.food?.order?.wish === 'something warm' || JSON.stringify(me.food || {}).includes('something warm'), 'sheet: Done sends the last change');
    });

    // ---------------------------------------------------------------- sharing (SPEC §20d)
    await step('share', async () => {
      current = 'share-checkbox';
      const page = await pageFor('phone');
      await load(page, 'view=sheet&seed=sample&fresh=1', 'light');
      await page.waitForSelector('dialog.fd-sheet.is-open .fd-share');
      await page.fill('.fd-part-prefs textarea >> nth=1', 'Ethiopian, anything with lime'); // a lone tick isn't an answer
      const share = await page.$('.fd-share');
      await share.scrollIntoViewIfNeeded();
      await page.click('.fd-share-label');
      await waitSaved(page);
      check((await stateNow()).me.food?.share === true, 'share: ticking it saves');
      await page.evaluate(() => document.querySelector('.fd-share').scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(200);
      await shot(page, 'share-checkbox-phone-light');
      // The list, from the sheet's own link.
      await page.evaluate(() => document.querySelector('.fd-sheet-scroll').scrollTo(0, 0));
      await page.click('.fd-sheet-switch:not([hidden])');
      await page.waitForSelector('.fd-ev-card');
      const ev = await page.evaluate(() => ({ cards: document.querySelectorAll('.fd-ev-card').length, text: document.querySelector('.fd-ev').textContent }));
      check(ev.cards >= 6, `everyone: ${ev.cards} shared answers`);
      check(!/Ana Ruiz|Felix|Priya|Omar|Chloé|Mei Tanaka|EpiPen|anaphylaxis|Peanuts/.test(ev.text), 'everyone: no names and no allergies');
      await page.waitForTimeout(200);
      await shot(page, 'everyone-phone-light');
      for (const theme of ['dark']) {
        current = `everyone-${theme}`;
        await load(page, 'view=everyone&seed=sample', theme);
        await page.waitForSelector('.fd-ev-card');
        await page.waitForTimeout(250);
        await shot(page, `everyone-phone-${theme}`);
      }
      current = 'everyone-desktop';
      const desk = await pageFor('desktop');
      await load(desk, 'view=everyone&seed=sample', 'light');
      await desk.waitForSelector('.fd-ev-card');
      await desk.waitForTimeout(250);
      await shot(desk, 'everyone-desktop-light');
    });

    // ---------------------------------------------------------------- the host
    await step('host', async () => {
      for (const device of ['desktop', 'phone']) {
        for (const theme of ['light', 'dark']) {
          current = `host-${device}-${theme}`;
          const page = await pageFor(device);
          await load(page, 'view=host&seed=sample', theme);
          await page.waitForSelector('.fd-sum');
          await shot(page, `host-${device}-${theme}`);
          await shot(page, `host-${device}-${theme}-full`, { fullPage: true });
        }
      }
      current = 'host-checks';
      const page = await pageFor('desktop');
      await load(page, 'view=host&seed=sample', 'light');
      await page.waitForSelector('.fd-sum');
      const sev = await page.evaluate(() => document.querySelector('.fd-severe')?.textContent || '');
      check(/Peanuts/.test(sev) && /Ana Ruiz/.test(sev) && /Shellfish/.test(sev) && /Sam Kirby/.test(sev), 'host: severe allergies are on top with names');
      check(await page.evaluate(() => document.querySelector('.fd-sum').firstElementChild.nextElementSibling?.classList.contains('fd-severe')), 'host: the severe callout comes first');
      // The table of individuals.
      await page.click('.fd-people > summary');
      await page.waitForTimeout(200);
      const peopleEl = await page.$('.fd-people');
      await peopleEl.scrollIntoViewIfNeeded();
      await shot(page, 'host-desktop-light-people');
      // Narrow column (a host card beside others).
      current = 'host-narrow';
      await load(page, 'view=host-narrow&seed=sample', 'light');
      await page.waitForSelector('.fd-sum');
      await shot(page, 'host-narrow-desktop-light-full', { fullPage: true });
      // Setup editor.
      current = 'host-setup';
      await load(page, 'view=host&seed=sample', 'light');
      await page.click('.fd-setup-open');
      await page.waitForSelector('.fd-setup');
      await page.click('.fd-setup .fd-add');
      await page.fill('.fd-setup-row:last-child .fd-setup-name', 'Burgers — Honest');
      await page.fill('.fd-setup-row:last-child .fd-setup-url', 'honestburgers.co.uk/menu');
      const setupEl = await page.$('.fd-setup');
      await setupEl.scrollIntoViewIfNeeded();
      await shot(page, 'host-setup-desktop-light');
      await page.click('.fd-setup-actions .btn-primary');
      await page.waitForFunction(() => !document.querySelector('.fd-setup'));
      const setup = (await stateNow()).setup;
      check(setup.options.length === 4 && setup.options[3].menuUrl === 'https://honestburgers.co.uk/menu', 'host: a new option saves (menu link made a web address)');
      // Copy order list: the clipboard, then the select-all fallback.
      current = 'host-copy';
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
      await page.click('.fd-copy');
      await page.waitForTimeout(300);
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      check(/Pizza — Franco Manca \(\d+\)/.test(clip) && /SEVERE ALLERGY: Peanuts \(carries an EpiPen\)/.test(clip), 'host: Copy order list puts the grouped list with flags on the clipboard');
      fs.writeFileSync(path.join(OUT, 'food-order-list.txt'), clip);
      await page.context().clearPermissions();
      await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) }, configurable: true }); });
      await page.click('.fd-copy');
      await page.waitForSelector('.fd-copy-modal textarea');
      const sel = await page.evaluate(() => { const t = document.querySelector('.fd-copy-modal textarea'); return t.selectionStart === 0 && t.selectionEnd === t.value.length && t.value.length > 50; });
      check(sel, 'host: without the clipboard, the list opens selected for copying');
      await shot(page, 'host-copy-fallback-desktop-light');
      await page.keyboard.press('Escape');
      // Reset: the CSV downloads first, then RESET must be typed.
      current = 'host-reset';
      await load(page, 'view=host&seed=sample', 'light');
      await page.waitForSelector('.fd-sum');
      const dl = page.waitForEvent('download', { timeout: 8000 });
      await page.click('.fd-reset');
      const download = await dl;
      const csvPath = path.join(OUT, 'food-before-reset.csv');
      await download.saveAs(csvPath);
      const csv = fs.readFileSync(csvPath, 'utf8');
      check(csv.includes('Ana Ruiz') && csv.includes('carries an EpiPen'), 'host: reset downloads the CSV first');
      await page.waitForSelector('.fd-reset-modal');
      check(await page.evaluate(() => document.getElementById('fd-reset-go').disabled), 'host: Reset is disabled until RESET is typed');
      await page.fill('.fd-reset-in', 'reset');
      await shot(page, 'host-reset-dialog-desktop-light');
      await page.click('#fd-reset-go');
      await page.waitForSelector('.fd-history', { timeout: 8000 });
      const st = await stateNow();
      check(st.resetAt > 0, 'host: the reset reached the server');
      const eating = await page.evaluate(() => document.querySelector('.fd-eating')?.textContent || '');
      check(/0\s*eating with us/.test(eating), `host: the food order answers are cleared (${eating.trim().slice(0, 60)})`);
      const kept = await page.evaluate(() => document.querySelector('.fd-severe')?.textContent || '');
      check(/Peanuts/.test(kept) && /Ana Ruiz/.test(kept), 'host: allergies are kept');
      await page.waitForTimeout(400);
      await shot(page, 'host-after-reset-desktop-light', { fullPage: true });
      // Free-text mode (no options).
      current = 'host-no-options';
      await load(page, 'view=host&seed=no-options', 'light');
      await page.waitForSelector('.fd-sum');
      await shot(page, 'host-no-options-desktop-light', { fullPage: true });
    });
    await step('pending-no-options', async () => {
      current = 'pending-no-options';
      const page = await pageFor('phone');
      await load(page, 'view=pending&seed=no-options&fresh=1', 'light');
      await page.click('.fd-part-order .fd-chip:has-text("Just a snack")');
      const order = await page.$('.fd-part-order');
      await order.scrollIntoViewIfNeeded();
      await shot(page, 'pending-no-options-phone-light');
    });

    // ---------------------------------------------------------------- the drawer
    await step('drawer', async () => {
      for (const theme of ['light', 'dark']) {
        current = `drawer-${theme}`;
        const page = await pageFor('desktop');
        await load(page, 'view=drawer&seed=sample&id=ana', theme);
        await page.waitForSelector('.fd-ans');
        await shot(page, `drawer-desktop-${theme}`);
      }
      const page = await pageFor('phone');
      await load(page, 'view=drawer&seed=sample&id=ana', 'light');
      await page.waitForSelector('.fd-ans');
      await shot(page, 'drawer-phone-light');
    });
  } finally {
    await browser.close().catch(() => {});
    await new Promise((r) => server.close(r));
  }
  console.log(`\n${shots.length} screenshots in ${path.relative(ROOT, OUT)}`);
  if (problems.length) {
    console.log(`\n${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
    process.exitCode = 1;
  } else console.log('no problems');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
