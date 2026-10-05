#!/usr/bin/env node
// Footnotes in order (SPEC §31) in a real browser: a post whose notes read 3, 1, 2 (references
// [^2], [^3], [^1]; notes [^1], [^2], [^3]) gets "Put notes in order", which fixes the editor, the
// live card and the post page, and Undo brings the original back in one step (Redo again); the
// server gets the moved note as a move (source 'move'). Add footnote before an existing one: the
// numbers by place in the editor, the live card and the post page; one undo step; typing right
// after it is a step of its own. A phone: the button is big enough to tap.
// Screenshots: qa/after/fn-order-*.png.
// Usage: timeout 300 node tools/fn-order-qa.mjs [--port 8231] [--out <dir>]

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
const PORT = Number(arg('port', 8231));
const OUT = path.resolve(ROOT, arg('out', 'qa/after'));
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[fn-order ${new Date().toISOString().slice(11, 19)}]`, ...a);
fs.mkdirSync(OUT, { recursive: true });

try {
  await fetch(`${BASE}/healthz`);
  console.error(`Port ${PORT} is already in use; pick another with --port.`);
  process.exit(2);
} catch { /* free */ }
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-fn-order-'));
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
process.on('uncaughtException', (e) => {
  console.error('[fn-order] uncaught:', e);
  process.exit(1);
});
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
const caretAt = (page, pos) => cm(page, (v, p) => {
  v.focus();
  v.dispatch({ selection: { anchor: p }, scrollIntoView: true });
}, pos);
const head = (page) => cm(page, (v) => v.state.selection.main.head);
const setDoc = (page, text, at) => cm(page, (v, [x, p]) => {
  v.focus();
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: x }, selection: { anchor: p }, scrollIntoView: true });
}, [text, at]);
async function settle(page, ms = 250) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await sleep(ms);
}
async function shot(page, name, opts = {}) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, ...opts });
  log('screenshot', path.relative(ROOT, file));
}
const noteNums = (page) => page.locator(`${ED} .rt-fn-num`).allTextContents();
const refNums = (page) => page.locator(`${ED} .rt-fn-ref`).allTextContents();

const LIVE = [
  'The keeper counted the steps[^2] every evening. His daughter checked the sums[^3]. Nobody else climbed to the lamp room[^1].',
  '',
  '[^1]: The storm broke the north window.',
  '[^2]: One hundred and twelve steps.',
  '[^3]: She used a pencil stub tied to a string.',
].join('\n');
const ORDERED = [
  'The keeper counted the steps[^1] every evening. His daughter checked the sums[^2]. Nobody else climbed to the lamp room[^3].',
  '',
  '[^1]: One hundred and twelve steps.',
  '[^2]: She used a pencil stub tied to a string.',
  '[^3]: The storm broke the north window.',
].join('\n');
const ADD = 'The keeper climbed the steps every evening[^1] and counted them aloud.\n\n[^1]: One hundred and twelve.';
const ADDED = 'The keeper climbed[^1] the steps every evening[^2] and counted them aloud.\n\n[^1]: \n[^2]: One hundred and twelve.';

let writer;
let host;
let post;
async function serverText() {
  const posts = await writer.req('/api/posts');
  return posts.posts.find((x) => x.id === post.id)?.body;
}
async function untilServer(want, what) {
  let got;
  for (let k = 0; k < 60; k++) {
    got = await serverText();
    if (got === want) break;
    await sleep(250);
  }
  return check(got === want, `server: ${what}`, JSON.stringify(got));
}
// The writer's ops as the server keeps them (host export): [t, post, pane, pos, del, ins, x].
async function opsSince(n) {
  const ex = await host.req('/api/admin/export.json');
  return Object.values(ex.ops).flat().filter((o) => o[1] === post.id).slice(n);
}
async function opCount() {
  return (await opsSince(0)).length;
}
// The batch's moved notes: an insert with x.s 'move' and right after it the same text deleted.
function moves(ops, before) {
  const out = [];
  let t = before;
  for (let i = 0; i < ops.length; i++) {
    const [, , , pos, del, ins, x] = ops[i];
    const mv = x && x.s === 'move';
    if (mv && ins && !del) {
      const next = ops[i + 1];
      const after = t.slice(0, pos) + ins + t.slice(pos);
      if (next && next[6]?.s === 'move' && !next[5] && after.slice(next[3], next[3] + next[4]) === ins) out.push(ins);
    }
    t = t.slice(0, pos) + ins + t.slice(pos + del);
  }
  return out;
}
async function liveCard(page) {
  await page.goto(`${BASE}/live`);
  await page.waitForSelector('.fn-def', { timeout: 10000 }).catch(() => {});
  await settle(page, 400);
  return page.evaluate(() => ({
    refs: [...document.querySelectorAll('sup.fn-ref')].map((e) => e.textContent),
    notes: [...document.querySelectorAll('.fn-def')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()),
  }));
}
async function postPage(page) {
  const pub = await (await fetch(`${BASE}/api/live`)).json();
  const mine = (pub.posts || []).find((x) => /keeper/.test(x.title || ''));
  await page.goto(`${BASE}/p/${mine.id}`);
  await page.waitForSelector('.p-body sup.fn-ref', { timeout: 10000 }).catch(() => {});
  await settle(page, 300);
  return page.evaluate(() => ({
    refs: [...document.querySelectorAll('.p-body sup.fn-ref a')].map((e) => e.textContent),
    notes: [...document.querySelectorAll('.p-notes section.footnotes li')].map((e) => e.textContent.replace('↩︎', '').replace(/\s+/g, ' ').trim()),
  }));
}

async function desktop(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addCookies([{ name: 'wh_sess', value: writer.token, url: BASE }]);
  const page = await ctx.newPage();
  onPage(page, 'desktop');
  const other = await ctx.newPage();
  onPage(other, 'public');
  await page.goto(`${BASE}/write`);
  await page.waitForSelector(ED);
  await page.waitForFunction(() => !!document.querySelector('link[data-rt]'), null, { timeout: 10000 });
  await settle(page, 400);

  // ---- the live shape: notes listed 3, 1, 2
  check(await docText(page) === LIVE, 'editor: the post as the server has it');
  await caretAt(page, LIVE.indexOf('\n\n') + 1); // a blank line: the references show as numbers
  await settle(page, 300);
  check(JSON.stringify(await noteNums(page)) === '["3","1","2"]', 'editor: the notes read 3, 1, 2 where they are written', JSON.stringify(await noteNums(page)));
  check(JSON.stringify(await refNums(page)) === '["1","2","3"]', 'editor: the references read 1, 2, 3', JSON.stringify(await refNums(page)));
  const btn = page.locator(`${ED} .rt-fn-order button`);
  check(await btn.count() === 1 && await btn.isVisible(), 'editor: "Put notes in order" above the notes');
  const geo = await page.evaluate(() => {
    const b = document.querySelector('.rt-fn-order button').getBoundingClientRect();
    const line = document.querySelector('.cm-line.rt-fn-first');
    const textTop = line.getBoundingClientRect().top + parseFloat(getComputedStyle(line).paddingTop);
    const content = document.querySelector('.w-editor:not(.w-editor-notes) .cm-content').getBoundingClientRect();
    return { above: b.bottom <= textTop + 1, rightGap: Math.round(content.right - b.right) };
  });
  check(geo.above && geo.rightGap < 40, 'editor: the button sits above the first note, at the right', JSON.stringify(geo));
  await shot(page, 'fn-order-editor-before');
  let card = await liveCard(other);
  check(JSON.stringify(card.notes.map((x) => x.split(' ')[0])) === '["3","1","2"]', 'live card (before): notes in place read 3, 1, 2', JSON.stringify(card));
  await shot(other, 'fn-order-live-before');
  let pp = await postPage(other);
  check(JSON.stringify(pp.refs) === '["1","2","3"]' && /^One hundred/.test(pp.notes[0]), 'post page (before): already listed by number', JSON.stringify(pp));
  await shot(other, 'fn-order-post-before', { fullPage: true });

  // ---- Put notes in order
  const n0 = await opCount();
  await btn.click();
  await settle(page, 300);
  check(await docText(page) === ORDERED, 'editor: Put notes in order renumbers and orders them', JSON.stringify(await docText(page)));
  check(JSON.stringify(await noteNums(page)) === '["1","2","3"]', 'editor: the notes read 1, 2, 3', JSON.stringify(await noteNums(page)));
  check(await page.locator(`${ED} .rt-fn-order`).count() === 0, 'editor: the button is gone once they are in order');
  check(await head(page) === LIVE.indexOf('\n\n') + 1, 'editor: the caret stays where it was');
  await shot(page, 'fn-order-editor-after');
  await untilServer(ORDERED, 'the ordered text');
  const batch = await opsSince(n0);
  check(JSON.stringify(moves(batch, LIVE)) === JSON.stringify(['[^3]: The storm broke the north window.']), 'server: the moved note arrives as a move (two ops, source "move")', JSON.stringify(batch.map((o) => [o[3], o[4], o[5], o[6]])));
  check(batch.every((o) => !(o[6] && typeof o[6].m === 'string')), 'server: nothing in it is a paste');
  card = await liveCard(other);
  check(JSON.stringify(card.notes.map((x) => x.split(' ')[0])) === '["1","2","3"]' && /^1 One hundred/.test(card.notes[0]) && /^3 The storm/.test(card.notes[2]), 'live card (after): notes in place read 1, 2, 3', JSON.stringify(card));
  check(JSON.stringify(card.refs) === '["1","2","3"]', 'live card (after): references 1, 2, 3', JSON.stringify(card.refs));
  await shot(other, 'fn-order-live-after');
  pp = await postPage(other);
  check(JSON.stringify(pp.refs) === '["1","2","3"]' && /^One hundred/.test(pp.notes[0]) && /^She used/.test(pp.notes[1]) && /^The storm/.test(pp.notes[2]), 'post page (after): the same numbers and notes', JSON.stringify(pp));
  await shot(other, 'fn-order-post-after', { fullPage: true });

  // ---- Undo: the original in one step; Redo: in order again (both sent as moves)
  await page.bringToFront();
  const n1 = await opCount();
  await page.keyboard.press('Control+z');
  await settle(page, 300);
  check(await docText(page) === LIVE, 'editor: one Undo restores the original', JSON.stringify(await docText(page)));
  check(JSON.stringify(await noteNums(page)) === '["3","1","2"]' && await page.locator(`${ED} .rt-fn-order button`).count() === 1, 'editor: 3, 1, 2 again, and the button is back');
  await shot(page, 'fn-order-editor-undone');
  await untilServer(LIVE, 'the original text again');
  check(moves(await opsSince(n1), ORDERED).length === 1, 'server: the undo arrives as a move too');
  const n2 = await opCount();
  await page.keyboard.press('Control+Shift+Z'); // a real keyboard's key is "Z" with Shift
  await settle(page, 300);
  check(await docText(page) === ORDERED, 'editor: Redo puts them in order again');
  await untilServer(ORDERED, 'in order after Redo');
  check(moves(await opsSince(n2), LIVE).length === 1, 'server: the redo arrives as a move');

  // ---- Add footnote before an existing one
  await setDoc(page, ADD, ADD.length);
  await settle(page, 300);
  await shot(page, 'fn-order-add-before');
  await caretAt(page, ADD.indexOf(' the steps'));
  await page.keyboard.press('Control+Alt+f');
  await settle(page, 200);
  let t = await docText(page);
  check(t === ADDED, 'editor: Add footnote before [^1] makes it [^1] and the old one [^2], its note first', JSON.stringify(t));
  check(await head(page) === ADDED.indexOf('[^1]: ') + 6, 'editor: the caret in the new note');
  await page.keyboard.press('Control+z');
  await settle(page, 200);
  check(await docText(page) === ADD, 'editor: one Undo takes all of it back', JSON.stringify(await docText(page)));
  await page.keyboard.press('Control+Shift+Z');
  await settle(page, 200);
  check(await docText(page) === ADDED, 'editor: Redo adds it again');
  await caretAt(page, ADDED.indexOf('[^1]: ') + 6);
  await page.keyboard.type('In the dark.', { delay: 2 }); // right away: its own undo step
  await page.keyboard.press('Control+z');
  await settle(page, 200);
  t = await docText(page);
  check(t === ADDED, 'editor: typing right after Add footnote undoes on its own', JSON.stringify(t));
  await page.keyboard.type('In the dark.', { delay: 2 });
  t = await docText(page);
  await caretAt(page, t.indexOf('\n\n') + 1);
  await settle(page, 300);
  check(JSON.stringify(await refNums(page)) === '["1","2"]' && JSON.stringify(await noteNums(page)) === '["1","2"]', 'editor: references and notes in order', JSON.stringify([await refNums(page), await noteNums(page)]));
  await shot(page, 'fn-order-add-after');
  const want = ADDED.replace('[^1]: ', '[^1]: In the dark.');
  await untilServer(want, 'the added footnote');
  card = await liveCard(other);
  check(JSON.stringify(card.refs) === '["1","2"]' && /^1 In the dark\./.test(card.notes[0]) && /^2 One hundred/.test(card.notes[1]), 'live card: the new note is 1, the old one 2', JSON.stringify(card));
  await shot(other, 'fn-order-add-live');
  pp = await postPage(other);
  check(JSON.stringify(pp.refs) === '["1","2"]' && /^In the dark\./.test(pp.notes[0]) && /^One hundred/.test(pp.notes[1]), 'post page: the same', JSON.stringify(pp));
  await shot(other, 'fn-order-add-post', { fullPage: true });
  await page.close();
  await other.close();
  await ctx.close();
}

const PIXEL7 = {
  viewport: { width: 412, height: 839 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
};
async function phone(browser) {
  const ctx = await browser.newContext(PIXEL7);
  await ctx.addCookies([{ name: 'wh_sess', value: writer.token, url: BASE }]);
  const page = await ctx.newPage();
  onPage(page, 'phone');
  await page.goto(`${BASE}/write`);
  await page.waitForSelector(ED);
  await page.waitForFunction(() => !!document.querySelector('link[data-rt]'), null, { timeout: 10000 });
  await settle(page, 300);
  await page.tap(ED);
  await setDoc(page, LIVE, LIVE.indexOf('\n\n') + 1);
  await settle(page, 300);
  const btn = page.locator(`${ED} .rt-fn-order button`);
  await btn.scrollIntoViewIfNeeded();
  const geo = await btn.boundingBox();
  check(geo && geo.height >= 44, 'phone: the button is at least 44 px tall', JSON.stringify(geo));
  await shot(page, 'fn-order-phone-before');
  await btn.tap();
  await settle(page, 300);
  check(await docText(page) === ORDERED, 'phone: a tap puts the notes in order');
  await shot(page, 'fn-order-phone-after');
  await untilServer(ORDERED, 'in order from the phone');
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
  await host.req('/api/admin/settings', { scoring: { approvalRequired: false, hoursMode: 'personal' } }).catch(() => {});
  await host.req('/api/admin/start', {});
  writer = new Client();
  await writer.req('/api/register', { username: 'ana', name: 'Ana', password: 'party-password' });
  await writer.req('/api/join', {});
  ({ post } = await writer.req('/api/post/new', {}));
  await writer.req('/api/post/update', { id: post.id, title: 'The keeper’s ledger' });
  // The live post's shape, as the server has it.
  await writer.req('/api/ops', { postId: post.id, pane: 'body', baseVersion: 0, ops: [{ pos: 0, del: 0, ins: LIVE }] });
  for (let k = 0; k < 8 && !browser; k++) {
    try {
      browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
    } catch (e) {
      log('browser launch failed, retrying:', String(e.message).split('\n')[0]);
      await sleep(3000 * (k + 1));
    }
  }
  if (!browser) throw new Error('could not launch the browser');
  await desktop(browser);
  await phone(browser);
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
