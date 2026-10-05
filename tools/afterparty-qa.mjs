#!/usr/bin/env node
// Editing after the party (SPEC §30) in a real browser, on a scratch server whose party has ended:
// the editor is writable with no reason asked and typing saves at once; selecting a big paragraph
// and deleting it (or typing over it) asks for a reason first: Cancel keeps the text (on screen
// and on the server), a reason lets the deletion go in and it saves; the post page says "Edited
// after the party"; the hosts see the session and the reason in the post's history. A new post
// started after the end: private (the label and the line under the title say so), saved as you
// type, a paste goes in without the paste question, a big cut needs no reason, and the anthology
// leaves it out. Desktop and a phone (Pixel 7), each as a writer of their own.
// Screenshots: qa/after/afterparty-*-desktop.png and -phone.png.
// Usage: timeout 300 node tools/afterparty-qa.mjs [--port 8247] [--out <dir>] [--tmp <dir for the state file>]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { countWords } from '../public/js/text.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const CHROME = process.env.CHROME_PATH || undefined; // unset: Playwright's own Chromium
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const PORT = Number(arg('port', 8247));
const OUT = path.resolve(ROOT, arg('out', 'qa/after'));
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[afterparty ${new Date().toISOString().slice(11, 19)}]`, ...a);
fs.mkdirSync(OUT, { recursive: true });

try {
  await fetch(`${BASE}/healthz`);
  console.error(`Port ${PORT} is already in use; pick another with --port.`);
  process.exit(2);
} catch { /* free */ }
const stateDir = fs.mkdtempSync(path.join(arg('tmp', os.tmpdir()), 'wh-afterparty-')); // the scratch server's state
const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), WH_STATE_FILE: path.join(stateDir, 'state.json'), WH_FSYNC: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog = [];
server.stdout.on('data', (d) => serverLog.push(String(d)));
server.stderr.on('data', (d) => serverLog.push(String(d)));
process.on('exit', () => {
  try {
    server.kill('SIGTERM');
  } catch { /* gone */ }
  try {
    fs.rmSync(stateDir, { recursive: true, force: true });
  } catch { /* the server may still be writing its last save */ }
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

const ED = '.w-editor:not([hidden]):not(.w-editor-notes) .cm-content';
function onPage(page, who) {
  page.on('pageerror', (e) => problems.push(`${who}: page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(m.text())) problems.push(`${who}: console: ${m.text()}`);
  });
}
async function cm(page, fn, a) {
  const view = await page.evaluateHandle(async () => {
    const { EditorView } = await import('/vendor/cm.js');
    return EditorView.findFromDOM(document.querySelector('.w-editor:not([hidden]):not(.w-editor-notes) .cm-editor'));
  });
  try {
    return await view.evaluate(fn, a);
  } finally {
    await view.dispose();
  }
}
const docText = (page) => cm(page, (v) => v.state.doc.toString());
const select = (page, from, to) => cm(page, (v, [a, b]) => {
  v.focus();
  v.dispatch({ selection: { anchor: a, head: b }, scrollIntoView: true });
}, [from, to]);
const caretAt = (page, pos) => select(page, pos, pos);
async function settle(page, ms = 250) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await sleep(ms);
}
async function shot(page, name, opts = {}) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, ...opts });
  log('screenshot', path.relative(ROOT, file));
}
const dialogOpen = (page) => page.locator('dialog[open]').count().then((k) => k > 0);

const words = (n, tag) => Array.from({ length: n }, (_, i) => `${tag}${i + 1}`).join(' ');
const P1 = 'The harbour lights went out one by one while the ferry waited for nobody at all.';
const BIG = `The keeper wrote it all down: ${words(64, 'tide')} and that was the end of the ledger.`;
const P3 = 'In the morning the gulls came back, and the town forgot the night.';
const BODY = [P1, BIG, P3].join('\n\n');
const REASON = 'cutting a scene that didn’t work';
const BIG_WORDS = countWords(BIG); // 78

let host;
const writers = {}; // desktop, phone -> { client, id, post, title }
let writer; // this run's: its client, user id and post
let writerId;
let post;
let title;
async function serverText() {
  const posts = await writer.req('/api/posts');
  return posts.posts.find((x) => x.id === post.id)?.body;
}
async function untilServer(pred, what) {
  let got;
  for (let k = 0; k < 60; k++) {
    got = await serverText();
    if (pred(got)) break;
    await sleep(250);
  }
  return check(pred(got), `server: ${what}`, JSON.stringify(got).slice(0, 300));
}

async function run(browser, { phone }) {
  const tag = phone ? 'phone' : 'desktop';
  ({ client: writer, id: writerId, post, title } = writers[tag]);
  const ctx = await browser.newContext(phone ? {
    viewport: { width: 412, height: 839 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  } : { viewport: { width: 1280, height: 860 } });
  await ctx.addCookies([{ name: 'wh_sess', value: writer.token, url: BASE }]);
  const page = await ctx.newPage();
  onPage(page, tag);
  await page.goto(`${BASE}/write`);
  await page.waitForSelector(ED);
  await settle(page, 600);
  const start = await docText(page);

  // ---- writable, with the new line under the title and no "Edit after the party…"
  const bar = (await page.locator('.w-after').innerText()).replace(/\s+/g, ' ');
  check(/Editing after the party/.test(bar) && /save as you type/.test(bar) && /50\+ words at once/.test(bar), `${tag}: the line under the title says editing is open`, bar);
  check(await page.getByRole('button', { name: /Edit after the party/ }).count() === 0 && await page.getByRole('button', { name: 'Done' }).count() === 0, `${tag}: no "Edit after the party…" step, no "Done"`);
  check(await page.locator(ED).getAttribute('contenteditable') === 'true', `${tag}: the editor is writable`);

  // ---- typing saves at once, no dialog
  await caretAt(page, start.indexOf(P1) + P1.length);
  const typed = ' Then the tide turned.';
  await page.keyboard.type(typed, { delay: 15 });
  await settle(page, 300);
  check(!(await dialogOpen(page)), `${tag}: typing asks nothing`);
  await untilServer((t) => t && t.includes(`${P1}${typed}`), `${tag}: the typing is saved`);
  const saved = (await page.locator('.w-save').innerText().catch(() => '')).trim();
  check(/Saved/.test(saved), `${tag}: the footer says Saved`, saved);
  await shot(page, `afterparty-typing-${tag}`);

  // ---- a big paragraph: typing over it asks first; Cancel keeps it (screen and server)
  let doc = await docText(page);
  const from = doc.indexOf(BIG);
  await select(page, from, from + BIG.length);
  await settle(page, 150);
  await page.keyboard.type('Z');
  await page.waitForSelector('dialog[open] .w-reason-in', { timeout: 5000 }).catch(() => {});
  const lede = (await page.locator('dialog[open] .modal-body p').first().innerText().catch(() => '')).trim();
  check(lede === `You’re removing about ${BIG_WORDS} words. The hosts see your reason.`, `${tag}: typing over it opens the reason dialog with the count`, lede);
  await shot(page, `afterparty-reason-${tag}`);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await settle(page, 400);
  check(!(await dialogOpen(page)), `${tag}: Cancel closes it`);
  doc = await docText(page);
  check(doc.includes(BIG) && !doc.includes('Z'), `${tag}: Cancel leaves the text as it was`);
  const shown = (await page.locator(ED).innerText()).replace(/\s+/g, ' ');
  check(shown.includes('tide64 and that was the end') && !/\bZ\b/.test(shown), `${tag}: and the screen shows it`, shown.slice(0, 200));
  await untilServer((t) => t && t.includes(BIG), `${tag}: the paragraph is still on the server`);

  // ---- Delete: the dialog again; a reason lets it go in, and it saves
  await select(page, from, from + BIG.length + 2);
  await settle(page, 150);
  await page.keyboard.press(phone ? 'Backspace' : 'Delete');
  await page.waitForSelector('dialog[open] .w-reason-in', { timeout: 5000 }).catch(() => {});
  check(await dialogOpen(page), `${tag}: deleting it opens the dialog`);
  await page.locator('dialog[open] .w-reason-in').fill('no');
  await page.getByRole('button', { name: 'Remove it' }).click();
  await settle(page, 200);
  check(await dialogOpen(page) && /at least 3 characters/.test(await page.locator('dialog[open] .w-reason-err').innerText()), `${tag}: a too-short reason is asked for again`);
  await page.locator('dialog[open] .w-reason-in').fill(REASON);
  await shot(page, `afterparty-reason-filled-${tag}`);
  await page.getByRole('button', { name: 'Remove it' }).click();
  await settle(page, 600);
  check(!(await dialogOpen(page)), `${tag}: the dialog closes`);
  doc = await docText(page);
  check(!doc.includes('tide1 ') && doc.includes(P3), `${tag}: the paragraph is gone from the editor`, doc.slice(0, 200));
  await untilServer((t) => t && !t.includes('tide1 ') && t.includes(P3), `${tag}: the deletion is saved`);
  await shot(page, `afterparty-deleted-${tag}`);

  // ---- the post page and the hosts' history
  const other = await ctx.newPage();
  onPage(other, `${tag} public`);
  const pub = await (await fetch(`${BASE}/api/archive`)).json();
  const mine = (pub.posts || []).find((x) => x.title === title);
  await other.goto(`${BASE}/p/${mine.id}`);
  await other.waitForSelector('.p-edited', { timeout: 10000 }).catch(() => {});
  await settle(other, 300);
  const note = (await other.locator('.p-edited').innerText().catch(() => '')).trim();
  check(/Edited after the party/.test(note), `${tag}: the post page says "Edited after the party"`, note);
  check(!(await other.content()).includes(REASON), `${tag}: never the reason`);
  await shot(other, `afterparty-post-page-${tag}`);
  await other.close();
  const hist = (await host.req(`/api/admin/writer?id=${writerId}`)).posts.find((x) => x.id === post.id).after;
  check(hist.some((e) => e.kind === 'edit' && e.reason === null) && hist.some((e) => e.kind === 'cut' && e.reason === REASON && e.words === BIG_WORDS), `${tag}: the hosts see the session and the reason`, JSON.stringify(hist));

  // ---- a new post after the end: private, saved, no paste question, no reason to cut
  const newBtn = page.locator('.w-tab-new');
  check(await newBtn.isVisible(), `${tag}: "+ New post" is there after the end`);
  const before = (await writer.req('/api/posts')).posts.map((x) => x.id);
  await newBtn.click();
  await page.waitForFunction((n) => document.querySelectorAll('.w-tab').length > n, before.length, { timeout: 5000 }).catch(() => {});
  await settle(page, 400);
  const fresh = (await writer.req('/api/posts')).posts.find((x) => !before.includes(x.id));
  check(fresh && fresh.privacy === 'private' && fresh.added === true, `${tag}: it starts private`, JSON.stringify(fresh && { privacy: fresh.privacy, added: fresh.added }));
  await page.keyboard.type(`Feedback ${tag}`, { delay: 10 });
  await page.keyboard.press('Enter');
  await settle(page, 200);
  const chip = (await page.locator('.w-controls .w-chip').first().innerText()).trim();
  check(/Private · never published/.test(chip), `${tag}: the label says private`, chip);
  const bar2 = (await page.locator('.w-after').innerText()).replace(/\s+/g, ' ');
  check(/Written after the party: private unless you choose to publish it/.test(bar2), `${tag}: the line under the title says so`, bar2);
  const thanks = 'Thank you for hosting. The food was lovely and the quiet room helped.';
  await page.keyboard.type(thanks, { delay: 5 });
  const pasted = words(50, 'paste');
  await page.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', ` ${t}`);
    document.querySelector('.w-editor:not([hidden]):not(.w-editor-notes) .cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, pasted);
  await settle(page, 600);
  check(!(await dialogOpen(page)), `${tag}: a 50-word paste asks nothing after the end`);
  doc = await docText(page);
  check(doc === `${thanks} ${pasted}`, `${tag}: the paste went in`, doc.slice(0, 160));
  const postText = async () => (await writer.req('/api/posts')).posts.find((x) => x.id === fresh.id);
  let got;
  for (let k = 0; k < 40; k++) {
    got = await postText();
    if (got.body === doc && got.title === `Feedback ${tag}`) break;
    await sleep(250);
  }
  check(got.body === doc && got.title === `Feedback ${tag}`, `server: ${tag}: the new post and its title are saved`, JSON.stringify([got.title, got.body.slice(0, 80)]));
  await shot(page, `afterparty-new-post-${tag}`);
  await select(page, 0, doc.length);
  await page.keyboard.press('Backspace');
  await settle(page, 400);
  check(!(await dialogOpen(page)) && await docText(page) === '', `${tag}: deleting all of it (63 words) asks nothing`);
  await page.keyboard.type(thanks, { delay: 5 });
  await settle(page, 300);
  const arch = await (await fetch(`${BASE}/api/archive`)).json();
  check(!JSON.stringify(arch).includes('lovely') && !JSON.stringify(arch).includes(`Feedback ${tag}`), `${tag}: the anthology leaves it out`);
  await page.close();
  await ctx.close();
}

let browser;
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch { /* starting */ }
    await sleep(100);
  }
  host = new Client();
  await host.req('/api/register', { username: 'host', name: 'Host', password: 'party-password' });
  await host.req('/api/admin/settings', { scoring: { approvalRequired: false } }).catch(() => {});
  await host.req('/api/admin/start', {});
  for (const [tag, username, name] of [['desktop', 'ana', 'Ana'], ['phone', 'ben', 'Ben']]) {
    const c = new Client();
    const id = (await c.req('/api/register', { username, name, password: 'party-password' })).user.id;
    await c.req('/api/join', {});
    const { post: np } = await c.req('/api/post/new', {});
    const t = `The keeper’s ledger (${tag})`;
    await c.req('/api/post/update', { id: np.id, title: t });
    await c.req('/api/ops', { postId: np.id, pane: 'body', baseVersion: 0, ops: [{ pos: 0, del: 0, ins: BODY }] });
    writers[tag] = { client: c, id, post: np, title: t };
  }
  await host.req('/api/admin/end', {});
  for (let k = 0; k < 8 && !browser; k++) {
    try {
      browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
    } catch (e) {
      log('browser launch failed, retrying:', String(e.message).split('\n')[0]);
      await sleep(3000 * (k + 1));
    }
  }
  if (!browser) throw new Error('could not launch the browser');
  await run(browser, { phone: false });
  await run(browser, { phone: true });
} catch (e) {
  problems.push(`run failed: ${e.stack || e.message}`);
  log('ERROR', e.stack || e.message);
} finally {
  await browser?.close().catch(() => {});
  server.kill('SIGTERM');
  await sleep(600);
  fs.rmSync(stateDir, { recursive: true, force: true });
}
log(`${passed.length} passed, ${problems.length} problems`);
for (const p of problems) log('PROBLEM', p);
if (problems.length) {
  const tail = serverLog.join('').split('\n').slice(-15).join('\n');
  if (tail.trim()) log('server log tail:\n', tail);
}
process.exit(problems.length ? 1 : 0);
