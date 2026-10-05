#!/usr/bin/env node
// Browser check of account details (SPEC §25), desktop and phone: the sign-up form refusing an
// email as the display name; "Your account" from the writer's menu (rename → the menu button,
// the live page's signed post and the host dashboard follow, the anonymous post doesn't); from
// the waiting-for-approval screen (a stored email name is flagged); and from the host's menu;
// the host editing a writer from the drawer and the approval queue; a co-host told that hosts'
// details are the original host's. Screenshots go to qa/after/account-*.png.
// One Chromium, closed at the end; the server runs in this process on a scratch state file.
//   timeout 300 node tools/account-qa.mjs [--port 8231] [--dir <scratch dir>] [--out qa/after]
// The state lives in a fresh directory made inside --dir (default: the system temp dir).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createApp } from '../server.js';
import { attachAccounts } from '../lib/accounts.js';
import { createFood } from '../lib/food.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const CHROME = process.env.CHROME_PATH || undefined; // unset: Playwright's own Chromium
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const PORT = Number(arg('port', 8231));
const OUT = path.resolve(ROOT, arg('out', 'qa/after'));
const DIR = path.resolve(arg('dir', os.tmpdir()));
fs.mkdirSync(DIR, { recursive: true });
const STATE = path.join(fs.mkdtempSync(path.join(DIR, 'wh-account-qa-')), 'state.json');
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

// ---------------------------------------------------------------- server and people
const quiet = { error: (...a) => console.error('[server]', ...a), log() {}, warn() {} };
const app = createApp({ stateFile: STATE, log: quiet, testKnobs: true, tz: 'Europe/London', fsync: false });
attachAccounts(app);
app.extraRoutes.push(...createFood().routes); // as server.js mounts them: the waiting screen's food form
await app.start(PORT);
say(`server ${BASE}, state ${STATE}`);

const P = app.party;
async function post(cookie, p, body = {}) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WH': '1', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  const json = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${p}: ${r.status} ${JSON.stringify(json)}`);
  return { json, cookie: sc ? /wh_sess=[^;]*/.exec(sc)[0] : cookie };
}
async function register(username, name, password = 'longpassword', email = undefined) {
  const r = await post(null, '/api/register', { username, name, password, ...(email ? { email } : {}) });
  return { id: r.json.user.id, cookie: r.cookie, username, password };
}
const host = await register('robin', 'Robin');
await post(host.cookie, '/api/admin/settings', { scoring: { approvalRequired: true, hoursMode: 'personal' } });
await post(host.cookie, '/api/admin/party', { name: 'Sunday Writing Party' });
const cora = await register('cora', 'Cora Lind');
await post(host.cookie, '/api/host/approve', { id: cora.id });
P.userById(cora.id).isAdmin = true; // a co-host (SPEC §21)
const ruth = await register('ruth', 'Ruth');
const ben = await register('ben', 'Ben Okafor');
const ines = await register('ines', 'Ines Duarte', 'longpassword', 'ines.duarte@example.org');
for (const u of [ruth, ben]) await post(host.cookie, '/api/host/approve', { id: u.id });
// An account named before emails were refused, still waiting for approval.
P.userById(ines.id).name = 'ines.duarte@example.com';
P.touch();
await post(host.cookie, '/api/admin/start', {});
// Ruth: one signed post and one anonymous post on the live page.
await post(ruth.cookie, '/api/join', {});
const signed = (await post(ruth.cookie, '/api/post/new', { title: 'The lighthouse keeper' })).json.post;
await post(ruth.cookie, '/api/post/update', { id: signed.id, privacy: 'named' });
const ins = (cookie, id, text, seq) => post(cookie, '/api/ops', { postId: id, pane: 'body', baseVersion: 0, seq, sentAt: Date.now(), ops: [{ at: Date.now(), pos: 0, del: 0, ins: text }] });
await ins(ruth.cookie, signed.id, 'Every night the lamp turned, and every night the sea answered with the same grey patience.', 's1');
const anon = (await post(ruth.cookie, '/api/post/new', { title: 'Untitled draft' })).json.post;
await ins(ruth.cookie, anon.id, 'Nobody knows who wrote this one, and that is the point of it.', 'a1');

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
  await page.waitForTimeout(200);
  const file = path.join(OUT, `account-${name}.png`);
  await page.screenshot({ path: file, fullPage: full });
  shots.push(path.relative(ROOT, file));
}
const dialog = (page) => page.locator('dialog.modal-account[open]');
async function openWriterAccount(page) {
  await page.locator('.w-me').click();
  await page.getByRole('menuitem', { name: 'Your account…' }).click();
  await dialog(page).waitFor();
}
const liveNames = async () => (await fetch(`${BASE}/api/live`).then((r) => r.json())).posts.map((p) => [p.title, p.name]);

for (const device of ['desktop', 'phone']) {
  await step(`${device}: sign-up refuses an email as the display name`, async () => {
    const page = await pageFor(device);
    await page.goto(`${BASE}/register`, { waitUntil: 'load' });
    await page.locator('#auth-name').waitFor();
    check(await page.locator('label[for="auth-name"]').textContent() === 'Display name', `${device}: the field is labelled "Display name"`);
    check(/^Shown on the posts you choose to sign.*Not your email\.$/.test(await page.locator('#auth-name-hint').textContent()), `${device}: the hint says where it shows and that it isn't the email`);
    await page.locator('#auth-name').fill('sam.taylor@example.com');
    await page.locator('#auth-username').click();
    const msg = await page.locator('#auth-name-err').textContent();
    check(/looks like an email address/.test(msg) && /“Sam Taylor”/.test(msg), `${device}: leaving the field flags the email with a suggestion (${msg})`);
    const uname = device === 'desktop' ? 'sam' : 'sam2';
    await page.locator('#auth-username').fill(uname);
    await page.locator('#auth-password').fill('longpassword');
    await shot(page, `signup-email-${device}`);
    await page.locator('.auth-go').click();
    await page.waitForTimeout(400);
    check(page.url().endsWith('/register') && !P.userByUsername(uname), `${device}: no account is made`);
    // SPEC §25b: the email, shown back large before the account exists.
    await page.locator('#auth-name').fill('Sam Taylor');
    check(await page.locator('label[for="auth-email"]').textContent() === 'Email', `${device}: an Email field`);
    check(await page.locator('#auth-email').getAttribute('autocomplete') === 'email' && await page.locator('#auth-email').getAttribute('inputmode') === 'email', `${device}: autocomplete and inputmode are email`);
    check(/^For signing in; never shown publicly\./.test(await page.locator('#auth-username-hint').textContent()), `${device}: the username hint says what it's for`);
    check(/So the hosts can reach you after the party/.test(await page.locator('#auth-email-hint').textContent()), `${device}: the email hint says what it's for`);
    const facts = await page.locator('.auth-facts').textContent();
    check(/Your writing appears on the public live page as you type/.test(facts) && /The challenge: 400 new words an hour; miss one and you’re out of the challenge \(you can keep writing\)\./.test(facts), `${device}: the key facts sit above the button (${facts})`);
    const below = await page.evaluate(() => {
      const f = document.querySelector('.auth-facts').getBoundingClientRect();
      const b = document.querySelector('.auth-go').getBoundingClientRect();
      return b.top - f.bottom;
    });
    check(below >= 0 && below < 80, `${device}: the facts are right above the button (${Math.round(below)} px)`);
    await page.locator('.auth-go').scrollIntoViewIfNeeded();
    await shot(page, `signup-facts-${device}`);
    await page.locator('#auth-email').fill('sam.taylor@example');
    await page.locator('#auth-password').click();
    check(/part after the “@”/.test(await page.locator('#auth-email-err').textContent()), `${device}: an incomplete address is pointed out`);
    await page.locator('#auth-email').fill('wh-test-sam@gmial.com');
    await page.locator('.auth-go').click();
    const check1 = page.locator('dialog.modal-email[open]');
    await check1.waitFor();
    check(/wh-test-sam@gmial\.com/.test(await check1.locator('.em-addr').textContent()), `${device}: "Is this your email?" shows the address`);
    check(/Did you mean wh-test-sam@gmail\.com\?/.test(await check1.locator('.em-sug').textContent()), `${device}: the likely typo is offered a fix`);
    check(!P.userByUsername(uname), `${device}: no account until they confirm`);
    check(/So the hosts can reach you after the party; it’s never shown publicly\./.test(await check1.textContent()), `${device}: the check says what the email is for`);
    await shot(page, `signup-confirm-${device}`);
    if (device === 'desktop') {
      await check1.getByRole('button', { name: 'Edit' }).click();
      await check1.waitFor({ state: 'detached' });
      check(await page.evaluate(() => document.activeElement?.id) === 'auth-email', 'desktop: Edit goes back to the email field');
      await page.locator('.auth-go').click();
      await check1.waitFor();
    }
    await check1.getByRole('button', { name: 'Use that' }).click();
    check((await check1.locator('.em-addr').textContent()) === 'wh-test-sam@gmail.com', `${device}: the fix shows`);
    await shot(page, `signup-confirm-fixed-${device}`);
    await check1.getByRole('button', { name: 'Yes, that’s right' }).click();
    await page.waitForURL(/\/write$/);
    check(P.userByUsername(uname)?.email === 'wh-test-sam@gmail.com', `${device}: the account has the confirmed address`);
    await page.getByText('Your request is with the host').first().waitFor();
    await shot(page, `signup-done-${device}`);
    await page.context().close();
  });
}

await step('desktop: writer renames themself; the menu, the live page and the host dashboard follow', async () => {
  const page = await pageFor('desktop', ruth.cookie);
  const hostPage = await pageFor('desktop', host.cookie);
  await hostPage.goto(`${BASE}/host`, { waitUntil: 'load' });
  await hostPage.locator('.h-who', { hasText: 'Ruth' }).first().waitFor();
  await page.goto(`${BASE}/write`, { waitUntil: 'load' });
  await page.locator('.w-me').waitFor();
  await openWriterAccount(page);
  await shot(page, 'self-desktop');
  // An email first: refused in place.
  await page.locator('#acc-name').fill('ruth@example.org');
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  check(/email address/.test(await page.locator('#acc-name-err').textContent()), 'desktop: the dialog refuses an email');
  await page.locator('#acc-name').fill('Ruth Ames');
  await page.locator('.acc-pw > summary').click();
  await shot(page, 'self-password-desktop');
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await dialog(page).waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.querySelector('.w-me')?.textContent === 'Ruth Ames');
  check(true, 'desktop: the menu button shows the new name');
  await shot(page, 'self-saved-desktop');
  const names = await liveNames();
  check(JSON.stringify(names.find(([t]) => t === 'The lighthouse keeper')) === JSON.stringify(['The lighthouse keeper', 'Ruth Ames']), 'desktop: the signed post shows the new name on /api/live');
  check(names.find(([t]) => t === 'Untitled draft')?.[1] === null, 'desktop: the anonymous post still has no name');
  const live = await pageFor('desktop');
  await live.goto(`${BASE}/live`, { waitUntil: 'load' });
  await live.getByText('by Ruth Ames').first().waitFor();
  check(true, 'desktop: the live page shows “by Ruth Ames”');
  await shot(live, 'live-signed-desktop');
  await live.context().close();
  await hostPage.locator('.h-who', { hasText: 'Ruth Ames' }).first().waitFor({ timeout: 6000 });
  check(true, 'desktop: the host dashboard shows the new name without a reload');
  await hostPage.context().close();
  await page.context().close();
});

await step('phone: an older account without an email: quiet cues in the account areas, never over the page', async () => {
  const page = await pageFor('phone', ben.cookie);
  await page.goto(`${BASE}/write`, { waitUntil: 'load' });
  await page.locator('.w-me.needs-email').waitFor({ timeout: 8000 });
  check(true, 'phone: a quiet dot on the name button');
  await page.waitForTimeout(6000);
  check(!(await page.locator('.toast', { hasText: /email/i }).count()), 'phone: no toast over the page');
  await shot(page, 'email-cue-phone');
  await page.locator('.w-me').click();
  const item = page.getByRole('menuitem', { name: /Your account…/ });
  check(/Add your email/.test(await item.textContent()), 'phone: the menu says "Add your email" on Your account');
  await shot(page, 'email-cue-menu-phone');
  await item.click();
  await dialog(page).waitFor();
  check(await page.evaluate(() => document.activeElement?.id) === 'acc-email', 'phone: the dialog opens at the email field');
  check(/Add your email so the hosts can reach you/.test(await dialog(page).locator('.acc-note').first().textContent()), 'phone: the dialog says why');
  await page.locator('#acc-email').fill('ben@example.org');
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await dialog(page).waitFor({ state: 'detached' });
  check(P.userById(ben.id).email === 'ben@example.org', 'phone: the email is saved');
  await page.locator('.w-me:not(.needs-email)').waitFor({ timeout: 5000 });
  check(true, 'phone: the dot goes away by itself');
  await page.locator('.w-me').click();
  check(!/Add your email/.test(await page.getByRole('menuitem', { name: /Your account…/ }).textContent()), 'phone: the menu hint goes too');
  await page.keyboard.press('Escape');
  await page.context().close();
});

await step('desktop: waiting for approval without an email: a line in the card', async () => {
  const quiet = await register('quinn', 'Quinn Ade');
  const page = await pageFor('desktop', quiet.cookie);
  await page.goto(`${BASE}/write`, { waitUntil: 'load' });
  const line = page.locator('.ap-email');
  await line.waitFor();
  check(/Add your email so the hosts can reach you/.test(await line.textContent()), 'desktop: the waiting card asks quietly');
  await shot(page, 'email-cue-pending-desktop');
  await line.getByRole('button', { name: 'Add email' }).click();
  await dialog(page).waitFor();
  check(await page.evaluate(() => document.activeElement?.id) === 'acc-email', 'desktop: Add email opens the dialog at the field');
  await page.locator('#acc-email').fill('quinn@example.org');
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await dialog(page).waitFor({ state: 'detached' });
  await line.waitFor({ state: 'detached', timeout: 5000 });
  check(true, 'desktop: the line goes once there is an email');
  await page.context().close();
});

await step('phone: writer’s account dialog, password section open, dark too', async () => {
  for (const theme of ['light', 'dark']) {
    const page = await pageFor('phone', ruth.cookie, theme);
    await page.goto(`${BASE}/write`, { waitUntil: 'load' });
    await page.locator('.w-me').waitFor();
    await openWriterAccount(page);
    await shot(page, `self-phone${theme === 'dark' ? '-dark' : ''}`);
    if (theme === 'light') {
      await page.locator('.acc-pw > summary').click();
      await page.locator('#acc-currentPassword').fill('nope-nope');
      await page.locator('#acc-password').fill('a-new-password');
      await dialog(page).getByRole('button', { name: 'Save' }).click();
      await page.locator('#acc-currentPassword-err').filter({ hasText: /current password/ }).waitFor();
      check(true, 'phone: a wrong current password is refused on its field');
      await shot(page, 'self-password-phone');
    }
    await page.context().close();
  }
});

for (const device of ['desktop', 'phone']) {
  await step(`${device}: waiting for approval, a stored email name, then fixed`, async () => {
    const page = await pageFor(device, ines.cookie);
    await page.goto(`${BASE}/write`, { waitUntil: 'load' });
    const entry = page.getByRole('button', { name: 'Your account' });
    await entry.waitFor();
    await shot(page, `pending-${device}`);
    await entry.click();
    await dialog(page).waitFor();
    check(/Posts you sign show only “ines.duarte”/.test(await dialog(page).locator('.acc-note').textContent()), `${device}: the dialog flags the email name`);
    await shot(page, `pending-dialog-${device}`);
    if (device === 'phone') {
      await page.locator('#acc-name').fill('Ines Duarte');
      await dialog(page).getByRole('button', { name: 'Save' }).click();
      await dialog(page).waitFor({ state: 'detached' });
      await page.getByText('You’re signed up as Ines Duarte').waitFor();
      check(true, 'phone: the waiting screen shows the new name');
    }
    await page.context().close();
  });
}

for (const device of ['desktop', 'phone']) {
  await step(`${device}: host edits a writer from the drawer and the queue; their own account from the menu`, async () => {
    const page = await pageFor(device, host.cookie);
    await page.goto(`${BASE}/host`, { waitUntil: 'load' });
    if (device === 'desktop') {
      // The approval queue: a new pending writer.
      const nia = await register(`nia${Date.now() % 1000}`, 'nia@example.org'.replace('@', '-at-'));
      P.userById(nia.id).name = 'nia@example.org';
      await page.locator('.h-ask .acc-edit').first().waitFor({ timeout: 8000 });
      await shot(page, 'host-queue-desktop');
      await page.locator('.h-ask', { hasText: 'nia@example.org' }).locator('.acc-edit').click();
      await dialog(page).waitFor();
      await shot(page, 'host-queue-dialog-desktop');
      await page.locator('#acc-name').fill('Nia');
      await dialog(page).getByRole('button', { name: 'Save' }).click();
      await dialog(page).waitFor({ state: 'detached' });
      await page.locator('.h-ask', { hasText: 'Nia' }).first().waitFor({ timeout: 6000 });
      check(P.userById(nia.id).name === 'Nia', 'desktop: the queue edit saved');
    }
    await page.locator('.h-who', { hasText: 'Ben Okafor' }).first().click();
    await page.getByRole('button', { name: 'Edit name, username or password…' }).click();
    await dialog(page).waitFor();
    await shot(page, `host-edit-${device}`);
    await page.locator('#acc-username').fill(device === 'desktop' ? 'ben.o' : 'benok');
    await page.locator('#acc-password').fill('temporary-1');
    await dialog(page).getByRole('button', { name: 'Save' }).click();
    await dialog(page).waitFor({ state: 'detached' });
    const toastText = await page.locator('.toast').last().textContent();
    check(/signs in as ben/.test(toastText) && /signed out everywhere/.test(toastText), `${device}: the toast says what to tell them (${toastText})`);
    await shot(page, `host-edit-saved-${device}`);
    if (device === 'phone') {
      await page.keyboard.press('Escape');
      await page.locator('.h-drawer-close').click().catch(() => {});
      await page.locator('.h-more').click();
      await page.getByRole('menuitem', { name: 'Your account' }).click();
    } else {
      await page.locator('.h-drawer-close').click();
      await page.locator('.h-top-links').getByRole('button', { name: 'Your account' }).click();
    }
    await dialog(page).waitFor();
    check((await dialog(page).locator('.modal-title').textContent()) === 'Your account', `${device}: the host's own account opens from the menu`);
    if (device === 'desktop') check(!!P.userById(host.id).email || /add email/.test(await page.locator('.h-top-links').textContent()), 'desktop: the host’s top bar says "add email" while there is none');
    await shot(page, `host-own-${device}`);
    await page.context().close();
  });
}

await step('desktop: a co-host is told that hosts’ details are the original host’s', async () => {
  const page = await pageFor('desktop', cora.cookie);
  await page.goto(`${BASE}/host`, { waitUntil: 'load' });
  await page.locator('.h-who', { hasText: 'Robin' }).first().click();
  await page.getByRole('button', { name: 'Edit name, username or password…' }).click();
  await page.locator('dialog.modal-account[open] .modal-body').waitFor();
  const text = await page.locator('dialog.modal-account[open] .modal-body').textContent();
  check(/Only the original host \(Robin\) can change another host’s details/.test(text), `desktop: the co-host sees why (${text})`);
  await shot(page, 'cohost-denied-desktop');
  await page.context().close();
});

await step('desktop: the organiser’s setup link (WH_SETUP_TOKEN): needed for the first account', async () => {
  const app2 = createApp({ stateFile: path.join(fs.mkdtempSync(path.join(DIR, 'wh-account-qa-setup-')), 'state.json'), log: quiet, tz: 'Europe/London', fsync: false, setupToken: 'party-setup-7f3a' });
  attachAccounts(app2);
  await app2.start(PORT + 1);
  const B2 = `http://127.0.0.1:${PORT + 1}`;
  try {
    const page = await pageFor('desktop');
    await page.goto(`${B2}/register`, { waitUntil: 'load' });
    await page.locator('#auth-name').fill('Robin');
    await page.locator('#auth-email').fill('robin@example.org');
    await page.locator('#auth-username').fill('robin');
    await page.locator('#auth-password').fill('longpassword');
    await page.locator('.auth-go').click();
    await page.locator('dialog.modal-email[open]').getByRole('button', { name: 'Yes, that’s right' }).click();
    check(await page.locator('.auth-go').textContent() === 'Create the host account', 'desktop: before setup, the button makes the host account');
    await page.locator('.auth-err', { hasText: 'setup link' }).waitFor();
    check(!app2.party.userByUsername('robin'), 'desktop: without the setup link, no first account');
    await shot(page, 'setup-required-desktop');
    await page.goto(`${B2}/register?setup=party-setup-7f3a`, { waitUntil: 'load' });
    await page.locator('#auth-name').fill('Robin');
    await page.locator('#auth-email').fill('robin@example.org');
    await page.locator('#auth-username').fill('robin');
    await page.locator('#auth-password').fill('longpassword');
    await page.locator('.auth-go').click();
    await page.locator('dialog.modal-email[open]').getByRole('button', { name: 'Yes, that’s right' }).click();
    await page.waitForURL(/\/host$/);
    check(app2.party.userByUsername('robin')?.isAdmin === true, 'desktop: with the setup link, the first account is the host');
    await page.context().close();
  } finally {
    await app2.stop();
  }
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
