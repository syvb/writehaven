#!/usr/bin/env node
// The caret around links in the editor, in a real browser: desktop Chromium, a Pixel 7 (Chrome
// on Android's input path) and an iPhone (WebKit's input path emulated in Chromium). A link's
// hidden Markup ("[", "](address)", "<" and ">") is one step for ← and →, with a stop just inside
// and just outside the text at each end (the text lit while the caret is inside); typing at
// either stop goes in or out of the link; Shift+arrows, Home/End, word jumps (Ctrl+arrows) and
// word deletion cross the Markup without a wasted press; Backspace and Delete next to it take
// the next visible character and never part of the Markup; a selection that covers part of a
// link, deleted, cut or typed over, keeps the Markup (or takes the link whole when none of its
// text is left). Footnote numbers and images are one step too. Native caret moves (a phone
// keyboard's cursor control) never leave the caret inside hidden Markup.
// Screenshots: qa/after/linkcaret-*.png.
// Usage: timeout 300 node tools/linkcaret-qa.mjs [--port 8204] [--out <dir>]

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
const PORT = Number(arg('port', 8204));
const OUT = path.resolve(ROOT, arg('out', 'qa/after'));
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[lc ${new Date().toISOString().slice(11, 19)}]`, ...a);
fs.mkdirSync(OUT, { recursive: true });

try {
  await fetch(`${BASE}/healthz`);
  console.error(`Port ${PORT} is already in use; pick another with --port.`);
  process.exit(2);
} catch { /* free */ }
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-lc-'));
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
  } catch { /* removed below */ }
});

const problems = [];
const passed = [];
process.on('unhandledRejection', (e) => problems.push(`unhandled: ${e && e.message}`));
process.on('uncaughtException', (e) => {
  console.error('[lc] uncaught:', e);
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
async function settle(page, ms = 40) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await sleep(ms);
}
async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  log('screenshot', path.relative(ROOT, file));
}

// The text: two links and an address on line 1, a line that starts with a link and a one-letter
// link on line 2, a footnote, an image.
const L1 = 'Read the [harbour notes](https://example.com/harbour) today, then <https://example.org/x> later.';
const L2 = '[Start link](https://example.com/a) begins, [a](https://example.com/b) is short, it ends with [the end](https://example.com/c)';
const L3 = 'Ships came in[^1] at dawn.';
const L4 = '![A gull](/u/abcdefgh.webp#w=40&h=30)';
const L5 = '[^1]: The ledger says so.';
const TEXT = [L1, L2, L3, '', L4, '', L5].join('\n');
const at = (needle, off = 0) => {
  const i = TEXT.indexOf(needle);
  if (i < 0) throw new Error(`not in the text: ${needle}`);
  return i + off;
};
// Line 1's link: f..tf "[", text tf..T, T..E "](https://example.com/harbour)".
const f1 = at('[harbour');
const tf1 = f1 + 1;
const T1 = at('](https://example.com/harbour)');
const E1 = T1 + '](https://example.com/harbour)'.length;
// Line 1's address: "<" fa, text tfa..Ta, ">" Ta..Ea.
const fa = at('<https');
const tfa = fa + 1;
const Ta = at('> later');
const Ea = Ta + 1;
const line2 = at('[Start link');
const tf2 = line2 + 1;
const fA = at('[a](');
const EA = fA + '[a](https://example.com/b)'.length;
const note = at('[^1]: ');
const noteText = note + '[^1]: '.length;
const img = at('![A gull]');
const imgEnd = img + L4.length;
// Hidden ranges on line 1 (the caret's line), for the walk.
const HIDDEN1 = [[f1, tf1], [T1, E1], [fa, tfa], [Ta, Ea]];

async function setup(page, caret) {
  await cm(page, (v, [text, p]) => {
    v.focus();
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, selection: { anchor: p }, scrollIntoView: true });
  }, [TEXT, caret]);
  await settle(page);
}
async function caretAt(page, anchor, head = anchor) {
  await cm(page, (v, [a, h]) => {
    v.focus();
    v.dispatch({ selection: { anchor: a, head: h }, scrollIntoView: true });
  }, [anchor, head]);
  await settle(page);
}
const st = (page) => cm(page, (v) => {
  const s = v.state.selection.main;
  const lit = [...v.dom.querySelectorAll('.rt-link-in')].map((e) => e.textContent).join('|');
  return { head: s.head, anchor: s.anchor, doc: v.state.doc.toString(), lit, shown: window.getSelection().toString() };
});
async function press(page, keys, pause) {
  for (const k of [].concat(keys)) {
    await page.keyboard.press(k);
    await settle(page, pause);
  }
}
const line1 = (doc) => doc.split('\n')[0];
const line2Of = (doc) => doc.split('\n')[1];

// ← and →: one step across the Markup, a stop just inside and just outside the text.
async function arrows(page, who, pause) {
  await setup(page, E1);
  await press(page, 'ArrowLeft', pause);
  let s = await st(page);
  check(s.head === T1 && s.lit === 'harbour notes', `${who}: ← just after a link goes into it (the end of its text, lit)`, JSON.stringify({ head: s.head, T1, lit: s.lit }));
  await press(page, 'ArrowLeft', pause);
  s = await st(page);
  check(s.head === T1 - 1, `${who}: ← again moves over the last letter`, `${s.head}`);
  await caretAt(page, T1);
  await press(page, 'ArrowRight', pause);
  s = await st(page);
  check(s.head === E1 && s.lit === '', `${who}: → at the end of a link's text goes out past ")" (not lit)`, JSON.stringify({ head: s.head, E1, lit: s.lit }));
  await press(page, 'ArrowRight', pause);
  s = await st(page);
  check(s.head === E1 + 1, `${who}: → again moves over the next letter`, `${s.head}`);
  await caretAt(page, tf1);
  await press(page, 'ArrowLeft', pause);
  s = await st(page);
  check(s.head === f1 && s.lit === '', `${who}: ← at the start of a link's text goes out before "["`, JSON.stringify({ head: s.head, f1, lit: s.lit }));
  await press(page, 'ArrowLeft', pause);
  s = await st(page);
  check(s.head === f1 - 1, `${who}: ← again moves over the space before the link`, `${s.head}`);
  await caretAt(page, f1);
  await press(page, 'ArrowRight', pause);
  s = await st(page);
  check(s.head === tf1 && s.lit === 'harbour notes', `${who}: → just before a link goes into it (the start of its text, lit)`, JSON.stringify({ head: s.head, tf1, lit: s.lit }));
  // The address <https://…>: the same.
  await caretAt(page, Ea);
  await press(page, 'ArrowLeft', pause);
  s = await st(page);
  check(s.head === Ta && s.lit === 'https://example.org/x', `${who}: ← just after an address goes into it`, JSON.stringify({ head: s.head, Ta, lit: s.lit }));
  await press(page, 'ArrowRight', pause);
  s = await st(page);
  check(s.head === Ea && s.lit === '', `${who}: → at its end goes out past ">"`, `${s.head}`);
}

// The whole line by → and back by ←: every press moves; the caret never stops inside hidden
// Markup; a link costs its letters plus one press per hidden part (the inside/outside stop).
async function walk(page, who, pause) {
  const visible = L1.length - HIDDEN1.reduce((n, [a, b]) => n + b - a, 0);
  const inside = (p) => HIDDEN1.some(([a, b]) => p > a && p < b);
  for (const dir of ['ArrowRight', 'ArrowLeft']) {
    await setup(page, dir === 'ArrowRight' ? 0 : L1.length);
    const heads = [];
    let prev = dir === 'ArrowRight' ? 0 : L1.length;
    let stuck = 0;
    for (let k = 0; k < L1.length + 10; k++) {
      await page.keyboard.press(dir);
      if (pause > 40) await settle(page, pause);
      const h = await cm(page, (v) => v.state.selection.main.head);
      if (h === prev) stuck++;
      heads.push(h);
      prev = h;
      if (dir === 'ArrowRight' ? h >= L1.length : h <= 0) break;
    }
    const bad = heads.filter(inside);
    check(!bad.length && !stuck, `${who}: ${dir === 'ArrowRight' ? '→' : '←'} across line 1 never stops inside hidden Markup and every press moves`, JSON.stringify({ bad, stuck }));
    check(heads.length === visible + HIDDEN1.length, `${who}: ${dir === 'ArrowRight' ? '→' : '←'} crosses line 1 in ${visible + HIDDEN1.length} presses (${visible} letters, ${HIDDEN1.length} hidden parts; it took ${L1.length} before)`, `${heads.length}`);
  }
}

// Typing at the stops: inside extends the link, outside doesn't.
async function typing(page, who, pause) {
  await setup(page, E1);
  await press(page, 'ArrowLeft', pause);
  await page.keyboard.type('X', { delay: 30 });
  await settle(page, pause);
  let s = await st(page);
  check(line1(s.doc).includes('[harbour notesX](https://example.com/harbour)'), `${who}: typing at the end of a link's text extends the link`, line1(s.doc));
  await setup(page, T1);
  await press(page, 'ArrowRight', pause);
  await page.keyboard.type('Y', { delay: 30 });
  await settle(page, pause);
  s = await st(page);
  check(line1(s.doc).includes('harbour)Y today'), `${who}: typing after → out of a link goes after it`, line1(s.doc));
  await setup(page, tf1);
  await press(page, 'ArrowLeft', pause);
  await page.keyboard.type('Z', { delay: 30 });
  await settle(page, pause);
  s = await st(page);
  check(line1(s.doc).includes('the Z[harbour notes]'), `${who}: typing after ← out of a link's start goes before it`, line1(s.doc));
  await setup(page, f1);
  await press(page, 'ArrowRight', pause);
  await page.keyboard.type('W', { delay: 30 });
  await settle(page, pause);
  s = await st(page);
  check(line1(s.doc).includes('[Wharbour notes]'), `${who}: typing after → into a link's start goes into its text`, line1(s.doc));
}

// Backspace and Delete next to the Markup.
async function deleting(page, who, pause) {
  await setup(page, E1);
  await press(page, 'Backspace', pause);
  let s = await st(page);
  check(line1(s.doc) === L1.replace('notes]', 'note]') && s.head === T1 - 1 && s.lit === 'harbour note', `${who}: Backspace just after a link takes the last letter of its text (the caret now inside)`, JSON.stringify({ l: line1(s.doc), head: s.head, lit: s.lit }));
  await press(page, 'Backspace', pause);
  s = await st(page);
  check(line1(s.doc) === L1.replace('notes]', 'not]'), `${who}: and the next Backspace the one before`, line1(s.doc));
  await setup(page, tf1);
  await press(page, 'Backspace', pause);
  s = await st(page);
  check(line1(s.doc) === L1.replace('the [', 'the['), `${who}: Backspace at the start of a link's text takes the space before the link, never "["`, line1(s.doc));
  await setup(page, T1);
  await press(page, 'Delete', pause);
  s = await st(page);
  check(line1(s.doc) === L1.replace('harbour) today', 'harbour)today'), `${who}: Delete at the end of a link's text takes the space after the link, never "]("`, line1(s.doc));
  await setup(page, f1);
  await press(page, 'Delete', pause);
  s = await st(page);
  check(line1(s.doc) === L1.replace('[harbour', '[arbour') && s.head === tf1, `${who}: Delete just before a link takes the first letter of its text`, JSON.stringify({ l: line1(s.doc), head: s.head }));
  await setup(page, EA);
  await press(page, 'Backspace', pause);
  s = await st(page);
  check(line2Of(s.doc) === L2.replace('[a](https://example.com/b)', ''), `${who}: Backspace after a one-letter link takes the whole link`, line2Of(s.doc));
  await setup(page, Ea);
  await press(page, 'Backspace', pause);
  s = await st(page);
  check(line1(s.doc).includes('<https://example.org/> later'), `${who}: Backspace after an address takes its last character, "<" and ">" stay`, line1(s.doc));
}

async function desktop(browser, writer) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addCookies([{ name: 'wh_sess', value: writer.token, url: BASE }]);
  const page = await ctx.newPage();
  onPage(page, 'desktop');
  await page.goto(`${BASE}/write`);
  await page.waitForSelector(ED);
  await page.waitForFunction(() => !!document.querySelector('link[data-rt]'), null, { timeout: 10000 });
  await settle(page, 400);
  await page.click(ED);
  const who = 'desktop';
  await arrows(page, who, 0);
  await walk(page, who, 0);
  await typing(page, who, 0);
  await deleting(page, who, 0);
  let s;
  await popover(page, who, false);
  await formatting(page, who);
  await setup(page, f1 - 4);
  await caretAt(page, f1 - 4, tf1 + 3);
  await page.waitForSelector('.rt-float:not([hidden]) .rt-btn-bold', { timeout: 4000 });
  await page.click('.rt-float .rt-btn-bold');
  await settle(page);
  s = await st(page);
  check(line1(s.doc) === L1.replace(`the ${LINK1}`, `**the ${LINK1}**`), 'desktop: the floating bar’s Bold does the same', line1(s.doc));

  // Shift+arrows: the Markup goes with the next visible letter; what's shown selected is what goes.
  await setup(page, f1);
  await press(page, 'Shift+ArrowRight');
  s = await st(page);
  check(s.anchor === f1 && s.head === tf1 + 1 && s.shown === 'h', 'desktop: Shift+→ before a link selects "[" with its first letter (no wasted press)', JSON.stringify({ a: s.anchor, h: s.head, shown: s.shown }));
  for (let k = 0; k < 12; k++) await press(page, 'Shift+ArrowRight');
  s = await st(page);
  check(s.head === T1 && s.shown === 'harbour notes', 'desktop: Shift+→ through the link text, a letter a press', JSON.stringify({ h: s.head, shown: s.shown }));
  await press(page, 'Shift+ArrowRight');
  s = await st(page);
  check(s.head === E1 + 1 && s.shown === 'harbour notes ', 'desktop: Shift+→ at the end of the text takes the hidden address with the next space', JSON.stringify({ h: s.head, shown: s.shown }));
  await press(page, 'Backspace');
  s = await st(page);
  check(line1(s.doc) === L1.replace('[harbour notes](https://example.com/harbour) ', ''), 'desktop: deleting a selection over the whole link takes it all', line1(s.doc));
  await setup(page, E1);
  await press(page, 'Shift+ArrowLeft');
  s = await st(page);
  check(s.head === T1 - 1 && s.shown === 's', 'desktop: Shift+← just after a link selects its last letter', JSON.stringify({ h: s.head, shown: s.shown }));
  // Partly covered links keep their Markup.
  await setup(page, f1 - 2);
  await press(page, ['Shift+ArrowRight', 'Shift+ArrowRight', 'Shift+ArrowRight', 'Shift+ArrowRight', 'Shift+ArrowRight']);
  s = await st(page);
  check(s.shown === 'e har', 'desktop: a selection from before a link into it shows the letters only', JSON.stringify(s.shown));
  await press(page, 'Backspace');
  s = await st(page);
  check(line1(s.doc) === L1.replace('the [harbour', 'th[bour') && s.head === f1 - 2, 'desktop: deleting it keeps "[" (the link keeps the rest of its text)', JSON.stringify({ l: line1(s.doc), head: s.head }));
  await press(page, 'Control+z');
  s = await st(page);
  check(line1(s.doc) === L1, 'desktop: Undo brings it all back', line1(s.doc));
  await setup(page, T1 - 3);
  await press(page, ['Shift+ArrowRight', 'Shift+ArrowRight', 'Shift+ArrowRight', 'Shift+ArrowRight', 'Shift+ArrowRight', 'Shift+ArrowRight']);
  s = await st(page);
  check(s.shown === 'tes to', 'desktop: a selection from inside a link out of it', JSON.stringify(s.shown));
  await page.keyboard.type('Q', { delay: 20 });
  await settle(page);
  s = await st(page);
  check(line1(s.doc) === L1.replace('notes](https://example.com/harbour) today', 'noQ](https://example.com/harbour)day'), 'desktop: typing over it keeps "](address)" (the typed letter joins the link, where the selection began)', line1(s.doc));
  await setup(page, f1 - 1);
  for (let k = 0; k < 14; k++) await press(page, 'Shift+ArrowRight');
  s = await st(page);
  check(s.shown === ' harbour notes' && s.head === T1, 'desktop: a selection of the space before a link and all its text', JSON.stringify({ shown: s.shown, h: s.head }));
  await page.keyboard.type('Q', { delay: 20 });
  await settle(page);
  s = await st(page);
  check(line1(s.doc) === L1.replace(' [harbour notes](https://example.com/harbour)', 'Q'), 'desktop: typing over it replaces the whole link (none of its text is left)', line1(s.doc));
  await setup(page, tf1);
  await caretAt(page, tf1, T1);
  await page.keyboard.type('Docks', { delay: 20 });
  await settle(page);
  s = await st(page);
  check(line1(s.doc).includes('[Docks](https://example.com/harbour)') && s.head === tf1 + 5, 'desktop: typing over exactly a link’s text keeps the link (the caret after the typed word)', JSON.stringify({ l: line1(s.doc), h: s.head }));
  await setup(page, f1 - 2);
  await caretAt(page, f1 - 2, tf1 + 3);
  await page.keyboard.type('Pier ', { delay: 20 });
  await settle(page);
  s = await st(page);
  check(line1(s.doc) === L1.replace('the [harbour', 'thPier [bour'), 'desktop: typing a word over a selection into a link: the word goes where the selection began', line1(s.doc));
  // Cut of a partly covered link.
  await setup(page, f1 - 2);
  await caretAt(page, f1 - 2, tf1 + 3);
  await press(page, 'Control+x');
  s = await st(page);
  check(line1(s.doc) === L1.replace('the [harbour', 'th[bour'), 'desktop: cutting a selection into a link keeps "["', line1(s.doc));

  // Home/End.
  await setup(page, tf1 + 3);
  await press(page, 'End');
  s = await st(page);
  check(s.head === L1.length, 'desktop: End from inside a link goes to the end of the line', `${s.head}`);
  await press(page, 'Home');
  s = await st(page);
  check(s.head === 0, 'desktop: Home goes to its start', `${s.head}`);
  await caretAt(page, tf2 + 2);
  await press(page, 'Home');
  s = await st(page);
  check(s.head === line2 && s.lit === '', 'desktop: Home in a line that starts with a link goes before the link', JSON.stringify({ h: s.head, line2, lit: s.lit }));
  await press(page, 'Shift+End');
  s = await st(page);
  check(s.anchor === line2 && s.head === line2 + L2.length, 'desktop: Shift+End selects to the end of the line', JSON.stringify({ a: s.anchor, h: s.head }));
  await caretAt(page, line2 + 3);
  await press(page, 'End');
  s = await st(page);
  check(s.head === line2 + L2.length && s.lit === '', 'desktop: End in a line that ends with a link goes after the link', JSON.stringify({ h: s.head, want: line2 + L2.length, lit: s.lit }));
  await page.keyboard.type('.', { delay: 20 });
  await settle(page);
  s = await st(page);
  check(line2Of(s.doc).endsWith('[the end](https://example.com/c).'), 'desktop: typing after End goes after the link', line2Of(s.doc));
  // However the caret gets there, it never rests inside hidden Markup (the highlighter splits
  // "](address)" into pieces the caret could otherwise land between).
  const endLink = line2 + L2.lastIndexOf('](');
  await setup(page, 0);
  const far = await cm(page, (v, p) => {
    const c = v.coordsAtPos(p, -1);
    const r = v.contentDOM.getBoundingClientRect();
    return { x: r.right - 4, y: (c.top + c.bottom) / 2 };
  }, line2 + L2.length);
  await page.mouse.click(far.x, far.y);
  await settle(page, 200);
  s = await st(page);
  check(s.head === endLink || s.head === line2 + L2.length, 'desktop: a click past the end of a line that ends with a link puts the caret at an edge of its hidden Markup', JSON.stringify({ h: s.head, endLink, end: line2 + L2.length }));
  await page.keyboard.type('!', { delay: 20 });
  await settle(page);
  s = await st(page);
  check(/\[the end!?\]\(https:\/\/example\.com\/c\)!?$/.test(line2Of(s.doc)), 'desktop: typing there keeps the link whole', line2Of(s.doc).slice(-40));
  await setup(page, L1.length);
  await press(page, 'ArrowDown');
  s = await st(page);
  const hidden2 = [[line2, line2 + 1], [endLink, line2 + L2.length]];
  check(!hidden2.some(([a, b]) => s.head > a && s.head < b) && s.head > line2, 'desktop: ↓ into a line that ends with a link never stops inside its hidden Markup', JSON.stringify({ h: s.head, endLink, end: line2 + L2.length }));
  await page.keyboard.type('?', { delay: 20 });
  await settle(page);
  s = await st(page);
  const l2 = line2Of(s.doc);
  const q = l2.indexOf('?');
  const hiddenIn2 = [...L2.matchAll(/\[([^\]]*)\]\([^)]*\)/g)].flatMap((m) => [[m.index, m.index + 1], [m.index + 1 + m[1].length, m.index + m[0].length]]);
  check(l2.replace('?', '') === L2 && !hiddenIn2.some(([a, b]) => q > a && q < b), 'desktop: typing there keeps every link whole', l2);
  await setup(page, line2 + 3);
  await cm(page, (v, p) => v.dispatch({ selection: { anchor: p }, userEvent: 'select' }), endLink + 2);
  await settle(page);
  s = await st(page);
  check(s.head === line2 + L2.length, 'desktop: a caret put inside hidden Markup goes to its edge', JSON.stringify({ h: s.head }));
  await caretAt(page, line2 + 3);
  await press(page, 'Home');
  await page.keyboard.type('>', { delay: 20 });
  await settle(page);
  s = await st(page);
  check(line2Of(s.doc).startsWith('>[Start link]'), 'desktop: typing after Home goes before the link', line2Of(s.doc).slice(0, 20));

  // Word jumps and word deletion.
  await setup(page, E1);
  await press(page, 'Control+ArrowLeft');
  s = await st(page);
  check(s.head === T1 - 'notes'.length, 'desktop: Ctrl+← just after a link goes to the start of its last word', `${s.head} want ${T1 - 5}`);
  await caretAt(page, T1);
  await press(page, 'Control+ArrowRight');
  s = await st(page);
  check(s.head === E1 + ' today'.length, 'desktop: Ctrl+→ at the end of a link’s text goes to the end of the next word', `${s.head} want ${E1 + 6}`);
  await caretAt(page, tf1);
  await press(page, 'Control+ArrowLeft');
  s = await st(page);
  check(s.head === f1 - 'the '.length, 'desktop: Ctrl+← at the start of a link’s text goes to the start of the word before', `${s.head}`);
  await caretAt(page, f1);
  await press(page, 'Control+ArrowRight');
  s = await st(page);
  check(s.head === tf1 + 'harbour'.length, 'desktop: Ctrl+→ just before a link goes to the end of its first word', `${s.head}`);
  await caretAt(page, E1);
  await press(page, 'Control+Shift+ArrowLeft');
  s = await st(page);
  check(s.anchor === E1 && s.head === T1 - 5 && s.shown === 'notes', 'desktop: Ctrl+Shift+← just after a link selects its last word', JSON.stringify({ a: s.anchor, h: s.head, shown: s.shown }));
  await setup(page, E1);
  await press(page, 'Control+Backspace');
  s = await st(page);
  check(line1(s.doc) === L1.replace('harbour notes]', 'harbour ]'), 'desktop: Ctrl+Backspace just after a link deletes its last word', line1(s.doc));
  await setup(page, T1);
  await press(page, 'Control+Delete');
  s = await st(page);
  check(line1(s.doc) === L1.replace('harbour) today,', 'harbour),'), 'desktop: Ctrl+Delete at the end of a link’s text deletes the next word', line1(s.doc));

  // Footnote numbers and images: one step.
  await setup(page, noteText);
  await press(page, 'ArrowLeft');
  s = await st(page);
  const fnShown = await page.locator(`${ED} .rt-fn-num`).count();
  check(s.head === note && fnShown === 1, 'desktop: ← at the start of a note’s text crosses its number in one step (still shown as a number)', JSON.stringify({ h: s.head, note, fnShown }));
  await press(page, 'ArrowLeft');
  s = await st(page);
  check(s.head === note - 1, 'desktop: ← again goes to the line before', `${s.head}`);
  await caretAt(page, note);
  await press(page, 'ArrowRight');
  s = await st(page);
  check(s.head === noteText, 'desktop: → before a note’s number crosses it in one step', `${s.head} want ${noteText}`);
  await caretAt(page, imgEnd);
  await press(page, 'ArrowLeft');
  s = await st(page);
  check(s.head === img, 'desktop: ← after an image crosses it in one step', `${s.head} want ${img}`);

  // The look: the caret inside a link (lit), on screen.
  await setup(page, T1 - 4);
  await settle(page, 200);
  await page.locator(`${ED} .cm-line`).first().screenshot({ path: path.join(OUT, 'linkcaret-desktop-inside.png') });
  await press(page, ['End']);
  await caretAt(page, E1);
  await settle(page, 200);
  await page.locator(`${ED} .cm-line`).first().screenshot({ path: path.join(OUT, 'linkcaret-desktop-outside.png') });
  log('screenshots linkcaret-desktop-inside.png, linkcaret-desktop-outside.png');
  await page.close();
  await ctx.close();
}

// Bold, Italic and Link over a selection that runs into a link (or out of one) take the whole
// link, so the Markdown never breaks; one with only a link's hidden end at its edge leaves it out.
const LINK1 = '[harbour notes](https://example.com/harbour)';
async function formatting(page, who) {
  const run = async (anchor, head, keys) => {
    await setup(page, anchor);
    await caretAt(page, anchor, head);
    await press(page, keys);
    return st(page);
  };
  let s = await run(f1 - 4, tf1 + 3, 'Control+b');
  check(line1(s.doc) === L1.replace(`the ${LINK1}`, `**the ${LINK1}**`) && s.shown === 'the harbour notes', `${who}: Bold over a selection from before a link into its text bolds the whole link`, JSON.stringify({ l: line1(s.doc), shown: s.shown }));
  await press(page, 'Control+b');
  s = await st(page);
  check(line1(s.doc) === L1, `${who}: Bold again takes it off`, line1(s.doc));
  s = await run(E1 + 3, T1 - 3, 'Control+i');
  check(line1(s.doc) === L1.replace(`${LINK1} today`, `*${LINK1} to*day`) && s.head < s.anchor, `${who}: Italic over a selection from inside a link out of it (made right to left) italicises the whole link`, JSON.stringify({ l: line1(s.doc), a: s.anchor, h: s.head }));
  s = await run(T1, E1 + 6, 'Control+b');
  check(line1(s.doc) === L1.replace(`${LINK1} today`, `${LINK1} **today**`), `${who}: Bold over a selection with only a link’s hidden end at its start leaves the link out`, line1(s.doc));
  s = await run(tf1, tf1 + 7, 'Control+b');
  check(line1(s.doc) === L1.replace('[harbour notes]', '[**harbour** notes]'), `${who}: Bold inside a link’s text stays inside it`, line1(s.doc));
  s = await run(tfa + 8, tfa + 15, 'Control+b');
  check(line1(s.doc).includes('**<https://example.org/x>**'), `${who}: Bold over part of an address takes the whole address`, line1(s.doc));
  // The Link button: the whole link gives way to the new one, the words untouched.
  await setup(page, f1 - 4);
  await caretAt(page, f1 - 4, tf1 + 3);
  await press(page, 'Control+k');
  await page.waitForSelector('.rt-pop-link-form input[type=url]');
  await page.keyboard.type('example.org/new', { delay: 4 });
  await press(page, 'Enter');
  s = await st(page);
  check(line1(s.doc) === L1.replace(`the ${LINK1}`, '[the harbour notes](https://example.org/new)'), `${who}: Link over a selection from before a link into it links the whole (no link inside a link)`, line1(s.doc));
  await press(page, 'Control+z');
  s = await st(page);
  check(line1(s.doc) === L1, `${who}: Undo brings the old link back`, line1(s.doc));
  await setup(page, T1 - 3);
  await caretAt(page, T1 - 3, E1 + 6);
  await press(page, 'Control+k');
  await page.waitForSelector('.rt-pop-link-form input[type=url]');
  await page.keyboard.type('example.org/new', { delay: 4 });
  await press(page, 'Enter');
  s = await st(page);
  check(line1(s.doc) === L1.replace(`${LINK1} today`, '[harbour notes today](https://example.org/new)'), `${who}: Link over a selection from inside a link out of it`, line1(s.doc));
  await setup(page, f1);
  await caretAt(page, f1, T1);
  await press(page, 'Control+k');
  await page.waitForSelector('.rt-pop-link-form input[type=url]');
  const val = await page.inputValue('.rt-pop-link-form input[type=url]');
  const title = await page.textContent('.rt-pop-link-form .rt-form-title');
  check(val === 'https://example.com/harbour' && /Edit/.test(title), `${who}: Link over a whole link (its hidden "[" and all its text) edits that link`, JSON.stringify({ val, title }));
  await press(page, 'Escape');
  await cm(page, (v) => v.focus());
  // An address pasted over a selection running into a link.
  await setup(page, f1 - 4);
  await caretAt(page, f1 - 4, tf1 + 3);
  await cm(page, (v, url) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', url);
    v.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, 'https://example.org/pasted');
  await settle(page);
  s = await st(page);
  check(line1(s.doc) === L1.replace(`the ${LINK1}`, '[the harbour notes](https://example.org/pasted)'), `${who}: an address pasted over a selection running into a link links the whole`, line1(s.doc));
}

// A click or tap in a link's text still opens its popover (the lit text waits for the click).
async function popover(page, who, touch) {
  await setup(page, 0);
  await settle(page, 100);
  const pt = await cm(page, (v, p) => {
    const c = v.coordsAtPos(p);
    return { x: c.left + 1, y: (c.top + c.bottom) / 2 };
  }, tf1 + 3);
  if (touch) await page.touchscreen.tap(pt.x, pt.y);
  else await page.mouse.click(pt.x, pt.y);
  const shown = await page.waitForSelector('.rt-pop-link .rt-pop-url', { timeout: 4000 }).then(() => true, () => false);
  await settle(page, 150);
  const s = await st(page);
  check(shown && s.lit === 'harbour notes', `${who}: a ${touch ? 'tap' : 'click'} in a link’s text opens its popover, and the text is lit`, JSON.stringify({ shown, lit: s.lit, h: s.head }));
  await cm(page, (v) => v.focus());
}

// Native caret moves (a phone keyboard's cursor control, a tap): never inside hidden Markup.
async function nativeMoves(page, who) {
  await setup(page, E1);
  const heads = [];
  for (let k = 0; k < 3; k++) {
    await page.evaluate(() => window.getSelection().modify('move', 'backward', 'character'));
    await settle(page, 120);
    heads.push(await cm(page, (v) => v.state.selection.main.head));
  }
  const inside = (p) => HIDDEN1.some(([a, b]) => p > a && p < b);
  check(!heads.some(inside) && heads[heads.length - 1] < T1, `${who}: the keyboard’s own caret moves never stop inside hidden Markup`, JSON.stringify({ heads, T1, E1 }));
  await setup(page, tf1);
  const fwd = [];
  for (let k = 0; k < 3; k++) {
    await page.evaluate(() => window.getSelection().modify('move', 'backward', 'character'));
    await settle(page, 120);
    fwd.push(await cm(page, (v) => v.state.selection.main.head));
  }
  check(!fwd.some(inside) && fwd[fwd.length - 1] < f1, `${who}: …nor going out of a link’s start`, JSON.stringify({ fwd, f1 }));
}

const PIXEL7 = {
  viewport: { width: 412, height: 839 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
};
const IPHONE = {
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};
async function phone(browser, writer, who, device, ios) {
  const ctx = await browser.newContext(device);
  await ctx.addCookies([{ name: 'wh_sess', value: writer.token, url: BASE }]);
  // CodeMirror takes the iOS input path (keys handled after the DOM changes) for Apple's browser.
  if (ios) await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, 'vendor', { get: () => 'Apple Computer, Inc.' }));
  const page = await ctx.newPage();
  onPage(page, who);
  await page.goto(`${BASE}/write`);
  await page.waitForSelector(ED);
  await page.waitForFunction(() => !!document.querySelector('link[data-rt]'), null, { timeout: 10000 });
  await settle(page, 400);
  const path_ = await page.evaluate(async () => {
    const { EditorView } = await import('/vendor/cm.js');
    const v = EditorView.findFromDOM(document.querySelector('.w-editor:not([hidden]):not(.w-editor-notes) .cm-editor'));
    return { android: /Android/.test(navigator.userAgent), vendor: navigator.vendor, ok: !!v };
  });
  log(who, JSON.stringify(path_));
  await page.tap(ED);
  await settle(page, 200);
  await arrows(page, who, 160);
  await typing(page, who, 160);
  await deleting(page, who, 160);
  await nativeMoves(page, who);
  await popover(page, who, true);
  if (!ios) {
    await setup(page, T1 - 3);
    await caretAt(page, T1 - 3, E1 + 3);
    await page.waitForSelector('.rt-dock:not([hidden]) .rt-btn-bold', { timeout: 5000 });
    await page.tap('.rt-dock .rt-btn-bold');
    await settle(page, 200);
    const s = await st(page);
    check(line1(s.doc) === L1.replace(`${LINK1} today`, `**${LINK1} to**day`), `${who}: the docked bar’s Bold over a selection out of a link bolds the whole link`, line1(s.doc));
  }
  // A tap at the end of the link text: the caret lands at one of its stops.
  await setup(page, 0);
  const box = await cm(page, (v, p) => {
    const c = v.coordsAtPos(p, -1);
    return c && { x: c.left - 2, y: (c.top + c.bottom) / 2 };
  }, T1);
  if (box) {
    await page.touchscreen.tap(box.x, box.y);
    await settle(page, 300);
    const s = await st(page);
    check(s.head === T1 || s.head === E1 || s.head === T1 - 1, `${who}: a tap at the end of a link’s text puts the caret at its end`, JSON.stringify({ h: s.head, T1, E1 }));
  }
  if (!ios) {
    await setup(page, T1 - 4);
    await settle(page, 200);
    await shot(page, 'linkcaret-phone');
  }
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
  const host = new Client();
  await host.req('/api/register', { username: 'host', name: 'Host', password: 'party-password' });
  await host.req('/api/admin/settings', { scoring: { approvalRequired: false, hoursMode: 'personal' } }).catch(() => {});
  await host.req('/api/admin/start', {});
  const writer = new Client();
  await writer.req('/api/register', { username: 'ana', name: 'Ana', password: 'party-password' });
  await writer.req('/api/join', {});
  const { post } = await writer.req('/api/post/new', {});
  await writer.req('/api/post/update', { id: post.id, title: 'Harbour' });
  for (let k = 0; k < 8 && !browser; k++) {
    try {
      browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
    } catch (e) {
      log('browser launch failed, retrying:', String(e.message).split('\n')[0]);
      await sleep(3000 * (k + 1));
    }
  }
  if (!browser) throw new Error('could not launch the browser');
  await desktop(browser, writer);
  await phone(browser, writer, 'pixel7', PIXEL7, false);
  await phone(browser, writer, 'iphone', IPHONE, true);
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
