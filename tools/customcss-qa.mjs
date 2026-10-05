#!/usr/bin/env node
// Browser check of custom CSS (SPEC §32), desktop and phone. It applies on the person's own
// screens only (writer page, host dashboard for hosts, their own post and writer pages), as the
// last element of <head>, also after stylesheets added later. It does not apply on anyone else's
// pages, /live, the projector, signed out, or with ?nocss. The account dialog previews while
// typing, Cancel reverts, and "Turn off custom CSS" works. No request leaves: a server on another
// port (another origin) counts what reaches it, and a control page without the CSP shows the
// counter works. Screenshots go to qa/after/customcss-*.png.
//   timeout 300 node tools/customcss-qa.mjs [--port 8236] [--leak-port 8238] [--dir <scratch dir>] [--out qa/after]
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createApp } from '../server.js';
import { attachAccounts } from '../lib/accounts.js';
import { attachWriters } from '../lib/writers.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const CHROME = process.env.CHROME_PATH || undefined; // unset: Playwright's own Chromium
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const PORT = Number(arg('port', 8236));
const LEAK_PORT = Number(arg('leak-port', 8238));
const OUT = path.resolve(ROOT, arg('out', 'qa/after'));
const DIR = path.resolve(arg('dir', os.tmpdir()));
fs.mkdirSync(DIR, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const STATE = path.join(fs.mkdtempSync(path.join(DIR, 'wh-customcss-qa-')), 'state.json');
const BASE = `http://127.0.0.1:${PORT}`;
const LEAK = `http://127.0.0.1:${LEAK_PORT}`;

const problems = [];
const shots = [];
const blocked = []; // CSP refusals seen in the console: the CSS tried, the browser said no
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

// ---------------------------------------------------------------- the "outside" server
const leakHits = [];
const leak = http.createServer((req, res) => {
  leakHits.push(req.url);
  if (req.url === '/control.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<!doctype html><title>control</title><img src="/control-pixel.png">');
  }
  res.writeHead(204);
  return res.end();
});
await new Promise((r) => leak.listen(LEAK_PORT, '127.0.0.1', r));

// ---------------------------------------------------------------- the party
const quiet = { error: (...a) => console.error('[server]', ...a), log() {}, warn() {} };
const app = createApp({ stateFile: STATE, log: quiet, tz: 'Europe/London', fsync: false });
attachAccounts(app);
attachWriters(app);
await app.start(PORT);
const P = app.party;
async function post(cookie, p, body = {}) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WH': '1', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  const json = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${p}: ${r.status} ${JSON.stringify(json)}`);
  return { json, cookie: sc ? /wh_sess=[^;]*/.exec(sc)[0] : cookie };
}
async function register(username, name) {
  const r = await post(null, '/api/register', { username, name, password: 'longpassword', email: `${username}@example.org` });
  return { id: r.json.user.id, cookie: r.cookie };
}
const host = await register('robin', 'Robin');
await post(host.cookie, '/api/admin/settings', { scoring: { approvalRequired: false, hoursMode: 'personal' } });
await post(host.cookie, '/api/admin/party', { name: 'Sunday Writing Party' });
await post(host.cookie, '/api/admin/start', {});
const ruth = await register('ruth', 'Ruth Ames');
const ben = await register('ben', 'Ben Okafor');
const ins = (cookie, id, text, seq) => post(cookie, '/api/ops', { postId: id, pane: 'body', baseVersion: 0, seq, sentAt: Date.now(), ops: [{ at: Date.now(), pos: 0, del: 0, ins: text }] });
async function signedPost(u, title, text, seq) {
  await post(u.cookie, '/api/join', {});
  const p = (await post(u.cookie, '/api/post/new', { title })).json.post;
  await post(u.cookie, '/api/post/update', { id: p.id, privacy: 'named' });
  await ins(u.cookie, p.id, text, seq);
  return p;
}
await signedPost(ruth, 'The lighthouse keeper', 'Every night the lamp turned, and every night the sea answered with the same grey patience. She counted the turns the way other people count sheep.', 'r1');
await signedPost(ben, 'Bus stop', 'The 38 came twice and I let it go twice, because the conversation behind me was better than anywhere it could take me.', 'b1');
for (const u of [ruth, ben]) await post(u.cookie, '/api/me/account', { publicProfile: true });

// Ruth's room: warm paper, a rust accent, a roomier editor. Plus three tries at loading from
// elsewhere, which the CSP must refuse: @import, a background image and a web font.
const THEME = `@import url(${LEAK}/leak.css);
/* My writing room */
:root, :root[data-theme] {
  --paper: #efe5cf; --sheet: #f8f1e2; --ink: #2a2118; --ink-2: #5b4936; --ink-3: #8a7560;
  --rule: #d8c8aa; --rule-2: #e7dbc3; --accent: #9a4519; --accent-wet: #b85a26; --accent-fill: #9a4519;
  --accent-wash: rgba(154, 69, 25, 0.1); --caret: #9a4519;
}
body { background-image: url(${LEAK}/leak-bg.png); }
@font-face { font-family: LeakFont; src: url(${LEAK}/leak-font.woff2); }
.w-save, .h-phase { font-family: LeakFont, var(--sans); }
.w-title { letter-spacing: -0.025em; }
.cm-content { font-size: 1.22rem; line-height: 1.8; }
`;
const HOST_CSS = `:root, :root[data-theme] { --paper: #e9eef0; --sheet: #f6f9fa; --accent: #1f5f73; --accent-fill: #1f5f73; }`;
await post(ruth.cookie, '/api/me/account', { customCss: THEME });
await post(host.cookie, '/api/me/account', { customCss: HOST_CSS });
const me = async (cookie) => (await fetch(`${BASE}/api/me`, { headers: { Cookie: cookie } }).then((r) => r.json()));
const ruthMe = await me(ruth.cookie);
const benMe = await me(ben.cookie);
const ruthPost = ruthMe.posts.find((p) => p.publicId).publicId;
const benPost = benMe.posts.find((p) => p.publicId).publicId;
const ruthPage = ruthMe.me.page;
const benPage = benMe.me.page;
if (!ruthPage || !benPage) throw new Error('writer pages missing');

// ---------------------------------------------------------------- browser
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const DEVICES = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};
async function pageFor(device = 'desktop', cookie = null) {
  const ctx = await browser.newContext({ ...DEVICES[device], reducedMotion: 'reduce', colorScheme: 'light' });
  if (cookie) {
    const [k, v] = cookie.split('=');
    await ctx.addCookies([{ name: k, value: v, url: BASE }]);
  }
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  page.on('console', (m) => {
    if (/Content Security Policy/.test(m.text())) blocked.push(m.text());
    else if (m.type() === 'error' && !/status of (40[0-9]|429)/.test(m.text())) problems.push(`${device}: console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`${device}: page error: ${e.message}`));
  return page;
}
async function shot(page, name) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  const file = path.join(OUT, `customcss-${name}.png`);
  await page.screenshot({ path: file });
  shots.push(path.relative(ROOT, file));
}
// What the page's own CSS element says: { has, last, text }.
const own = (page) => page.evaluate(() => {
  const s = document.getElementById('wh-own-css');
  return { has: !!s, last: !!s && document.head.lastElementChild === s, text: s?.textContent ?? null };
});
// Let a page settle (it applies after the session, and for /p and /w after its own `me`).
async function visit(page, url, ready) {
  await page.goto(BASE + url, { waitUntil: 'load' });
  if (ready) await page.locator(ready).first().waitFor();
  await page.waitForTimeout(900);
}

await step('ruth’s own screens get her CSS, as the last element of <head>, as text', async () => {
  const page = await pageFor('desktop', ruth.cookie);
  await visit(page, '/write', '.w-me');
  let o = await own(page);
  check(o.has && o.text === THEME, 'writer page: her CSS, exactly as saved');
  check(o.last, 'writer page: the last element of <head>');
  check(await page.evaluate(() => getComputedStyle(document.body).backgroundColor) === 'rgb(239, 229, 207)', 'the theme shows (paper colour)');
  // A stylesheet added later (the writer page loads more as it goes) must not get after it.
  await page.evaluate(() => document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: '/css/print.css', media: 'print' })));
  await page.waitForTimeout(300);
  check((await own(page)).last, 'still last after a stylesheet is added');
  await shot(page, 'writer-desktop');
  await visit(page, `/p/${encodeURIComponent(ruthPost)}`, 'h1, .p-title, article');
  check((await own(page)).has, 'her own post page: applied');
  await visit(page, `/w/${encodeURIComponent(ruthPage)}`, 'h1');
  check((await own(page)).has, 'her own writer page: applied');
  await shot(page, 'own-page-desktop');
  await visit(page, `/p/${encodeURIComponent(benPost)}`, 'h1, .p-title, article');
  check(!(await own(page)).has, 'someone else’s post page: not applied');
  await visit(page, `/w/${encodeURIComponent(benPage)}`, 'h1');
  check(!(await own(page)).has, 'someone else’s writer page: not applied');
  await visit(page, '/live', '.l-name, h1');
  check(!(await own(page)).has, '/live: not applied');
  await visit(page, '/live?wall', 'body');
  check(!(await own(page)).has, 'the projector (/live?wall): not applied');
  await visit(page, '/writers', 'h1');
  check(!(await own(page)).has, 'the list of writers: not applied');
  await visit(page, '/write?nocss', '.w-me');
  check(!(await own(page)).has, '?nocss: not applied');
  await page.context().close();
});

await step('phone: ruth’s writer page and the Appearance settings', async () => {
  const page = await pageFor('phone', ruth.cookie);
  await visit(page, '/write', '.w-me');
  check((await own(page)).has, 'phone: applied');
  await page.locator('.ih.is-open .ih-x').click({ timeout: 3000 }).catch(() => {});
  await shot(page, 'writer-phone');
  await page.locator('.w-me').click();
  await page.getByRole('menuitem', { name: /Your account…/ }).click();
  await page.locator('dialog.modal-account[open]').waitFor();
  await page.locator('dialog.modal-account[open] .acc-css-off').scrollIntoViewIfNeeded();
  await shot(page, 'settings-phone');
  await page.context().close();
});

await step('signed out, and other people: never her CSS', async () => {
  const anon = await pageFor('desktop');
  await visit(anon, `/p/${encodeURIComponent(ruthPost)}`, 'h1, .p-title, article');
  check(!(await own(anon)).has, 'signed out, her post: not applied');
  await visit(anon, `/w/${encodeURIComponent(ruthPage)}`, 'h1');
  check(!(await own(anon)).has, 'signed out, her page: not applied');
  await anon.context().close();
  const b = await pageFor('desktop', ben.cookie);
  await visit(b, `/p/${encodeURIComponent(ruthPost)}`, 'h1, .p-title, article');
  check(!(await own(b)).has, 'Ben on her post: not applied');
  await visit(b, '/write', '.w-me');
  check(!(await own(b)).has, 'Ben’s own writer page (no CSS of his): nothing');
  await b.context().close();
});

await step('the host: their CSS on the dashboard, never on the projector', async () => {
  const page = await pageFor('desktop', host.cookie);
  await visit(page, '/host', '.h-top');
  const o = await own(page);
  check(o.has && o.text === HOST_CSS && o.last, 'host dashboard: the host’s own CSS');
  await shot(page, 'host-desktop');
  await visit(page, '/live?wall', 'body');
  check(!(await own(page)).has, 'host on the projector: not applied');
  await page.context().close();
});

await step('Your account: preview while typing, Cancel reverts, Turn off works', async () => {
  const page = await pageFor('desktop', ruth.cookie);
  await visit(page, '/write', '.w-me');
  await page.locator('.w-me').click();
  await page.getByRole('menuitem', { name: /Your account…/ }).click();
  const dlg = page.locator('dialog.modal-account[open]');
  await dlg.waitFor();
  check(await dlg.locator('details.acc-css').evaluate((d) => d.open), 'Appearance is open when CSS is set');
  check(/Applies only to your own screens\. Add \?nocss to the address to turn it off for a page\./.test(await dlg.locator('#acc-customCss-hint').textContent()), 'the hint');
  check((await page.locator('#acc-customCss').evaluate((t) => getComputedStyle(t).fontFamily)).match(/mono|Menlo|Consolas|SF Mono/i) !== null, 'the field is monospace');
  await dlg.locator('.acc-css-off').scrollIntoViewIfNeeded();
  await shot(page, 'settings-desktop');
  await page.locator('#acc-customCss').fill(`${THEME}\n.w-top { background: #2a2118; } .w-top * { color: #f8f1e2 !important; }`);
  await page.waitForTimeout(400);
  check(/\.w-top \{ background: #2a2118; \}/.test((await own(page)).text || ''), 'the page previews it while typing');
  await shot(page, 'preview-desktop');
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await dlg.waitFor({ state: 'detached' });
  check((await own(page)).text === THEME, 'Cancel puts back what was saved');
  await page.locator('.w-me').click();
  await page.getByRole('menuitem', { name: /Your account…/ }).click();
  await dlg.waitFor();
  await dlg.getByRole('button', { name: 'Turn off custom CSS' }).click();
  await page.locator('.toast', { hasText: 'Custom CSS is off.' }).waitFor();
  check(!(await own(page)).has && !P.userById(ruth.id).customCss, 'Turn off removes it here and on the account');
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  check(!(await own(page)).has, 'and Cancel after that keeps it off');
  // Too big: refused on the field.
  await page.locator('.w-me').click();
  await page.getByRole('menuitem', { name: /Your account…/ }).click();
  await dlg.waitFor();
  await dlg.locator('details.acc-css summary').click();
  await page.locator('#acc-customCss').fill(`/* ${'x'.repeat(21 * 1024)} */`);
  check(/of 20 KB/.test(await dlg.locator('.acc-css-size').textContent()) && await dlg.locator('.acc-css-size.is-over').count() === 1, 'the size shows, over the limit in red');
  await dlg.getByRole('button', { name: 'Save' }).click();
  check(/at most 20 KB/.test(await page.locator('#acc-customCss-err').textContent()), 'over 20 KB is refused before sending');
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await page.context().close();
  await post(ruth.cookie, '/api/me/account', { customCss: THEME }); // back on, for anything after
});

await step('nothing leaves: the CSS’s outside loads are refused, and the counter works', async () => {
  check(leakHits.length === 0, `no request reached the outside server (${leakHits.length}: ${leakHits.join(', ')})`);
  check(blocked.some((m) => /leak\.css/.test(m)) && blocked.some((m) => /leak-bg\.png/.test(m)), `the browser refused them under the CSP (${blocked.length} refusals)`);
  const page = await pageFor('desktop');
  await page.goto(`${LEAK}/control.html`, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  check(leakHits.includes('/control-pixel.png'), 'control: a page without the CSP does reach it, so the counter works');
  await page.context().close();
});

await browser.close();
await app.stop();
leak.close();
console.log(`\n${shots.length} screenshots:\n${shots.map((s) => `  ${s}`).join('\n')}`);
if (problems.length) {
  console.log(`\n${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('\nAll checks passed.');
process.exit(0);
