#!/usr/bin/env node
// Rich text check (SPEC §14) in a real browser, desktop and Pixel 7: the formatting bar (floating
// over a selection on desktop, docked above the keyboard on phones, hidden by its chevron but
// shown for a selection), bold/italic/heading/lists/quote/link via the bar and shortcuts, list
// continuation and Backspace out of a list, the link popover, image paste/drop/button -> placeholder
// -> upload -> inline image -> alt text -> shown on the live page, metadata gone from uploads,
// offline queueing and retry. Screenshots: qa/after/rich-*.png.
// Usage: timeout 240 node tools/richtext-qa.mjs [--port 8200] [--only desktop|phone]

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
const PORT = Number(arg('port', 8200));
const ONLY = arg('only', '');
const OUT = path.resolve(ROOT, arg('out', 'qa/after'));
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[rich ${new Date().toISOString().slice(11, 19)}]`, ...a);
fs.mkdirSync(OUT, { recursive: true });

// A 120x80 JPEG stored sideways (EXIF orientation 6) with a maker name and GPS position.
const SIDEWAYS_JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/4QCyRXhpZgAATU0AKgAAAAgAAwEPAAIAAAARAAAAMgESAAMAAAABAAYAAIglAAQAAAABAAAARAAAAABTZWNyZXRQaG9uZU1ha2VyAAAABAABAAIAAAACTgAAAAACAAUAAAADAAAAegADAAIAAAACRQAAAAAEAAUAAAADAAAAkgAAAAAAAAAoAAAAAQAAAAEAAAABAAAAAQAAAAEAAAACAAAAAQAAAAMAAAABAAAABAAAAAH/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCABQAHgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDy6iiivozyAooooAKKKKACvav2b/8AmYv+3f8A9q14rXtX7N//ADMX/bv/AO1a5cd/Al8vzN8P/ER7VRRRXzx6YUUUUAFFFFABRRRQB8V0UUV9WeKFFFFABRRRQAV7V+zf/wAzF/27/wDtWvFa9q/Zv/5mL/t3/wDatcuO/gS+X5m+H/iI9qooor549MKKKKACiiigAooooA+K6KKK+rPFCiiigAooooAK9q/Zv/5mL/t3/wDateK17V+zf/zMX/bv/wC1a5cd/Al8vzN8P/ER7VRRRXzx6YUUUUAFFFFABRRRQB8V0UUV9WeKFFFFABRRRQAV7V+zf/zMX/bv/wC1a8Vr2r9m/wD5mL/t3/8AatcuO/gS+X5m+H/iI9qooor549MKKKKACiiigAooooA+K6KKK+rPFCiiigAooooAK9q/Zv8A+Zi/7d//AGrXite1fs3/APMxf9u//tWuXHfwJfL8zfD/AMRHtVFFFfPHphRRRQAUUUUAFFFFAH//2Q==';

// A server already on the port would answer instead of ours: refuse to run.
try {
  await fetch(`${BASE}/healthz`);
  console.error(`Port ${PORT} is already in use; pick another with --port.`);
  process.exit(2);
} catch { /* free */ }
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-rich-'));
const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), WH_STATE_FILE: path.join(stateDir, 'state.json'), WH_FSYNC: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog = [];
server.stdout.on('data', (d) => serverLog.push(String(d)));
server.stderr.on('data', (d) => serverLog.push(String(d)));
// Whatever happens, the server goes with this process.
process.on('exit', () => {
  try {
    server.kill('SIGTERM');
  } catch { /* gone */ }
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const problems = [];
const passed = [];
process.on('unhandledRejection', (e) => problems.push(`unhandled: ${e && e.message}`));
process.on('uncaughtException', (e) => {
  console.error('[rich] uncaught:', e);
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

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return;
    } catch { /* starting */ }
    await sleep(100);
  }
  throw new Error('server did not start');
}

// ---------------------------------------------------------------- page helpers
const ED = '.w-editor:not([hidden]):not(.w-editor-notes) .cm-content';
function onPage(page, who) {
  page.on('pageerror', (e) => problems.push(`${who}: page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/ERR_INTERNET_DISCONNECTED|Failed to load resource|\/js\/help\.js/.test(m.text())) problems.push(`${who}: console: ${m.text()}`);
  });
}
// Runs fn(view, arg) in the page with the active body editor's EditorView (through a handle:
// the page's CSP allows no eval).
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
const caretToEnd = (page) => cm(page, (v) => {
  v.focus();
  v.dispatch({ selection: { anchor: v.state.doc.length }, scrollIntoView: true });
});
const selectText = (page, str, nth = 0) => cm(page, (v, [s, n]) => {
  const t = v.state.doc.toString();
  let i = -1;
  for (let k = 0; k <= n; k++) i = t.indexOf(s, i + 1);
  if (i < 0) return false;
  v.focus();
  v.dispatch({ selection: { anchor: i, head: i + s.length }, scrollIntoView: true });
  return true;
}, [str, nth]);
// Screen coordinates of a document offset, scrolled into view first (CodeMirror only draws
// what's near the viewport).
async function coordsOf(page, str, offset) {
  await cm(page, (v, [s2, o]) => {
    const i = v.state.doc.toString().indexOf(s2);
    if (i >= 0) v.dispatch({ effects: v.constructor.scrollIntoView(i + o, { y: 'center' }) });
  }, [str, offset]);
  await settle(page, 120);
  return cm(page, (v, [s2, o]) => {
    const i = v.state.doc.toString().indexOf(s2);
    const a = i >= 0 ? v.coordsAtPos(i + o) : null;
    return a && { x: a.left + 1, y: (a.top + a.bottom) / 2 };
  }, [str, offset]);
}
async function dblclickWord(page, word) {
  const box = await coordsOf(page, word, 1);
  await page.mouse.dblclick(box.x + 1, box.y);
}
async function clickText(page, str, offset = 2) {
  const box = await coordsOf(page, str, offset);
  await page.mouse.click(box.x, box.y);
}
async function tapText(page, str, offset = 2) {
  const box = await coordsOf(page, str, offset);
  await page.touchscreen.tap(box.x, box.y);
}

// A 3000x2000 photo drawn in the page (a harbour at dusk) as a JPEG File, a screenshot-like PNG
// and the sideways JPEG, kept on window.__whFiles.
async function makeFiles(sideways) {
  if (window.__whFiles) return;
  const c = document.createElement('canvas');
  c.width = 3000;
  c.height = 2000;
  const x = c.getContext('2d');
  const hz = 1240;
  let g = x.createLinearGradient(0, 0, 0, hz);
  g.addColorStop(0, '#22345c');
  g.addColorStop(0.6, '#c48078');
  g.addColorStop(1, '#eec496');
  x.fillStyle = g;
  x.fillRect(0, 0, 3000, hz);
  g = x.createLinearGradient(0, hz, 0, 2000);
  g.addColorStop(0, '#3a4662');
  g.addColorStop(1, '#1c243a');
  x.fillStyle = g;
  x.fillRect(0, hz, 3000, 760);
  x.fillStyle = '#fad6a8';
  x.beginPath();
  x.arc(1980, hz - 10, 150, Math.PI, 0);
  x.fill();
  x.strokeStyle = 'rgba(236,186,140,0.8)';
  x.lineWidth = 3;
  for (let i = 0; i < 220; i++) {
    const t = i / 220;
    const y = hz + 8 + t * t * 740;
    const w = 40 + (1 - t) * 160 * Math.abs(Math.sin(i * 12.9898));
    const cx = 1980 + Math.sin(i * 78.233) * (60 + t * 240);
    x.beginPath();
    x.moveTo(cx - w / 2, y);
    x.lineTo(cx + w / 2, y);
    x.stroke();
  }
  x.fillStyle = '#1c1e28';
  x.beginPath();
  x.moveTo(0, hz + 10); x.lineTo(380, hz - 70); x.lineTo(720, hz - 40); x.lineTo(980, hz + 10);
  x.fill();
  x.beginPath();
  x.moveTo(494, hz - 60); x.lineTo(546, hz - 60); x.lineTo(536, hz - 330); x.lineTo(504, hz - 330);
  x.fill();
  x.fillStyle = '#fae2aa';
  x.fillRect(496, hz - 370, 48, 40);
  x.fillStyle = '#1c1e28';
  x.beginPath();
  x.moveTo(490, hz - 370); x.lineTo(550, hz - 370); x.lineTo(520, hz - 410);
  x.fill();
  const jpeg = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
  const s = document.createElement('canvas');
  s.width = 1240;
  s.height = 760;
  const y = s.getContext('2d');
  y.fillStyle = '#fbfbf9';
  y.fillRect(0, 0, 1240, 760);
  y.fillStyle = '#f3f3ef';
  y.fillRect(0, 0, 1240, 80);
  ['#e6786e', '#e6be64', '#78be78'].forEach((col, i) => {
    y.fillStyle = col;
    y.beginPath();
    y.arc(40 + i * 36, 40, 11, 0, 7);
    y.fill();
  });
  y.fillStyle = '#c8ced6';
  for (let r = 0; r < 9; r++) y.fillRect(80, 140 + r * 62, 900 - ((r * 37) % 300), 22);
  const png = await new Promise((r) => s.toBlob(r, 'image/png'));
  const bin = Uint8Array.from(atob(sideways), (ch) => ch.charCodeAt(0));
  window.__whFiles = {
    harbour: new File([jpeg], 'IMG_2041.JPG', { type: 'image/jpeg' }),
    screenshot: new File([png], 'Screenshot 2026-10-04 at 10.12.08.png', { type: 'image/png' }),
    sideways: new File([bin], 'sideways.jpg', { type: 'image/jpeg' }),
  };
}
async function pasteImage(page, which) {
  await page.evaluate(makeFiles, SIDEWAYS_JPEG);
  await page.evaluate((w) => {
    const dt = new DataTransfer();
    dt.items.add(window.__whFiles[w]);
    const target = document.querySelector('.w-editor:not([hidden]):not(.w-editor-notes) .cm-content');
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, which);
}
async function dropImage(page, which, x, y) {
  await page.evaluate(makeFiles, SIDEWAYS_JPEG);
  await page.evaluate(([w, cx, cy]) => {
    const dt = new DataTransfer();
    dt.items.add(window.__whFiles[w]);
    const target = document.querySelector('.w-editor:not([hidden]):not(.w-editor-notes) .cm-content');
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
  }, [which, x, y]);
}
async function harbourBytes(page) {
  await page.evaluate(makeFiles, SIDEWAYS_JPEG);
  const b64 = await page.evaluate(async () => {
    const buf = new Uint8Array(await window.__whFiles.harbour.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  });
  return Buffer.from(b64, 'base64');
}
const IMG_RE = /!\[([^\]]*)\]\((\/u\/[0-9a-f]{32}\.(webp|jpg|png|gif))#w=(\d+)&h=(\d+)\)/g;
const images = (text) => [...text.matchAll(IMG_RE)].map((m) => ({ alt: m[1], url: m[2], ext: m[3], w: Number(m[4]), h: Number(m[5]) }));
async function waitImages(page, n, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    const imgs = images(await docText(page));
    if (imgs.length >= n) return imgs;
    if (Date.now() - t0 > ms) return imgs;
    await sleep(150);
  }
}
// Fetches an uploaded file: type, size, pixel size, and whether any metadata words survive.
async function inspectUpload(page, url) {
  return page.evaluate(async (u) => {
    const r = await fetch(u);
    const blob = await r.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const text = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
    const bmp = await createImageBitmap(blob);
    return {
      status: r.status, type: r.headers.get('content-type'), cache: r.headers.get('cache-control'), bytes: bytes.length,
      w: bmp.width, h: bmp.height, leaks: ['Exif', 'GPS', 'Secret', 'XMP'].filter((w) => text.includes(w)),
    };
  }, url);
}
async function shot(page, name, opts = {}) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, ...opts });
  log('screenshot', path.relative(ROOT, file));
}
async function settle(page, ms = 250) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await sleep(ms);
}

// ---------------------------------------------------------------- desktop
async function desktop(browser, writer, post) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addCookies([{ name: 'wh_sess', value: writer.token, url: BASE }]);
  const page = await ctx.newPage();
  onPage(page, 'desktop');
  // Every op the editor sends, to check how image descriptions arrive.
  const opsSeen = [];
  page.on('request', (req) => {
    if (req.method() !== 'POST' || !req.url().endsWith('/api/ops')) return;
    try {
      opsSeen.push(...(JSON.parse(req.postData() || '{}').ops || []));
    } catch { /* not JSON */ }
  });
  await page.goto(`${BASE}/write`);
  await page.waitForSelector(ED);
  await page.waitForFunction(() => !!document.querySelector('link[data-rt]'), null, { timeout: 10000 });
  await settle(page, 400);
  await page.click(ED);
  await caretToEnd(page);
  await page.keyboard.type('Every evening the keeper climbed the hundred steps and counted them aloud. Then he wrote it down.', { delay: 4 });

  // Bold via the floating bar on a double-clicked word.
  await dblclickWord(page, 'hundred');
  await page.waitForSelector('.rt-float:not([hidden])', { timeout: 5000 });
  await settle(page);
  await shot(page, 'rich-desktop-bar');
  const barBox = await page.locator('.rt-float').boundingBox();
  const selTop = await cm(page, (v) => v.coordsAtPos(v.state.selection.main.from).top);
  check(barBox && barBox.y + barBox.height <= selTop, 'desktop: the bar floats above the selection', JSON.stringify({ barBox, selTop }));
  await page.click('.rt-float .rt-btn-bold');
  check((await docText(page)).includes('the **hundred** steps'), 'desktop: Bold button wraps the selection in **');
  check(await page.locator('.rt-float .rt-btn-bold[aria-pressed="true"]').count() === 1, 'desktop: Bold shows as on for bold text');
  // Italic with the shortcut.
  await dblclickWord(page, 'wrote');
  await page.keyboard.press('Control+i');
  check((await docText(page)).includes('he *wrote* it'), 'desktop: Ctrl+I italicises');
  await page.keyboard.press('Control+i');
  check((await docText(page)).includes('he wrote it'), 'desktop: Ctrl+I again removes the italics');
  await page.keyboard.press('Control+i');

  // Lists: Ctrl+Shift+8, continuation on Enter, Enter on an empty item ends the list.
  await caretToEnd(page);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+Shift+8');
  await page.keyboard.type('Gulls, three', { delay: 4 });
  await page.keyboard.press('Enter');
  await page.keyboard.type('Fog from the west', { delay: 4 });
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  let t = await docText(page);
  check(/\n- Gulls, three\n- Fog from the west\n\n$/.test(t), 'desktop: bulleted list via Ctrl+Shift+8, Enter continues it, Enter on an empty item ends it', JSON.stringify(t.slice(-60)));
  await page.keyboard.press('Control+Shift+7');
  await page.keyboard.type('Count the steps', { delay: 4 });
  await page.keyboard.press('Enter');
  await page.keyboard.type('Light the lamp', { delay: 4 });
  await page.keyboard.press('Enter');
  t = await docText(page);
  check(/\n1\. Count the steps\n2\. Light the lamp\n3\. $/.test(t), 'desktop: numbered list via Ctrl+Shift+7 continues with the next number', JSON.stringify(t.slice(-60)));
  await page.keyboard.press('Backspace');
  t = await docText(page);
  check(/2\. Light the lamp\n$/.test(t), 'desktop: Backspace right after a list marker ends the list', JSON.stringify(t.slice(-40)));
  await page.keyboard.press('Enter');
  await page.keyboard.type('Arrival', { delay: 4 });
  await selectText(page, 'Arrival');
  await page.waitForSelector('.rt-float:not([hidden])');
  await page.click('.rt-float .rt-btn-heading');
  check((await docText(page)).includes('\n## Arrival'), 'desktop: Heading button makes an H2');
  await page.click('.rt-float .rt-btn-heading');
  check((await docText(page)).includes('\n### Arrival'), 'desktop: Heading again makes it an H3');
  await page.click('.rt-float .rt-btn-heading');
  check(/\nArrival$/.test(await docText(page)), 'desktop: Heading a third time turns it off');
  await page.click('.rt-float .rt-btn-heading');
  // Bulleted list and quote from the bar.
  await caretToEnd(page);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('A ferry, late, carrying nobody he knew.', { delay: 4 });
  await selectText(page, 'A ferry, late, carrying nobody he knew.');
  await page.click('.rt-float .rt-btn-quote');
  check((await docText(page)).includes('\n> A ferry, late, carrying nobody he knew.'), 'desktop: Quote button quotes the line');
  await page.click('.rt-float .rt-btn-quote');
  check((await docText(page)).includes('\nA ferry, late,'), 'desktop: Quote again unquotes it');
  await page.click('.rt-float .rt-btn-bullet');
  check((await docText(page)).includes('\n- A ferry, late,'), 'desktop: Bulleted list button');
  await page.click('.rt-float .rt-btn-ordered');
  check((await docText(page)).includes('\n1. A ferry, late,'), 'desktop: Numbered list button turns a bullet into a number');
  await page.click('.rt-float .rt-btn-ordered');

  // Bold with nothing selected: type into it, step out of it; a pair left unused goes away.
  await caretToEnd(page);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('A ', { delay: 4 });
  await page.keyboard.press('Control+b');
  await page.keyboard.type('brave', { delay: 4 });
  await page.keyboard.press('Control+b');
  await page.keyboard.type(' end.', { delay: 4 });
  t = await docText(page);
  check(t.endsWith('\nA **brave** end.'), 'desktop: Ctrl+B with no selection types bold, Ctrl+B again steps out', JSON.stringify(t.slice(-30)));
  await page.keyboard.press('Control+b');
  await cm(page, (v) => v.dispatch({ selection: { anchor: 0 } }));
  await settle(page, 100);
  t = await docText(page);
  check(t.endsWith('\nA **brave** end.') && !t.includes('****'), 'desktop: an unused ** pair disappears when the caret leaves it', JSON.stringify(t.slice(-30)));

  // Backspace right after a quote mark ends the quote.
  await caretToEnd(page);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('> ', { delay: 4 });
  await page.keyboard.press('Backspace');
  t = await docText(page);
  check(/\n\n$/.test(t), 'desktop: Backspace after a quote mark ends the quote', JSON.stringify(t.slice(-20)));
  await page.keyboard.press('Backspace');

  // With clipboard access already allowed, the link form starts with a copied address.
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  await page.evaluate(() => navigator.clipboard.writeText('https://example.net/ferry-times'));
  await caretToEnd(page);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Check the ferry times.', { delay: 4 });
  await selectText(page, 'ferry times');
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.rt-pop-link-form input[type=url]');
  await page.waitForFunction(() => document.querySelector('.rt-pop-link-form input[type=url]')?.value, null, { timeout: 3000 }).catch(() => {});
  const pre = await page.inputValue('.rt-pop-link-form input[type=url]');
  check(pre === 'https://example.net/ferry-times', 'desktop: the link form is prefilled from the clipboard when that’s allowed', pre);
  await page.keyboard.press('Enter');
  check((await docText(page)).includes('Check the [ferry times](https://example.net/ferry-times).'), 'desktop: and the link is made from it');
  await ctx.clearPermissions();

  // Links: Ctrl+K on a selection asks for the address.
  await caretToEnd(page);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Read the harbour notes before the tide turns.', { delay: 4 });
  await selectText(page, 'harbour notes');
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.rt-pop-link-form input[type=url]');
  await page.keyboard.type('example.com/harbour', { delay: 4 });
  await settle(page);
  await shot(page, 'rich-desktop-link-form');
  await page.keyboard.press('Enter');
  t = await docText(page);
  check(t.includes('[harbour notes](https://example.com/harbour)'), 'desktop: Ctrl+K makes a link (https:// added)', JSON.stringify(t.slice(-80)));
  check(await page.locator('.cm-content .cm-tok-link').count() > 0, 'desktop: the link renders as a link');
  check(!(await page.locator('.cm-line', { hasText: '](https://example.com/harbour)' }).count()), 'desktop: link syntax hidden while the caret is outside it');
  await caretToEnd(page);
  await clickText(page, 'harbour notes', 3);
  await page.waitForSelector('.rt-pop-link .rt-pop-url', { timeout: 4000 });
  await settle(page);
  const popBtns = await page.locator('.rt-pop-link .rt-pop-btn').allTextContents();
  check(popBtns.join('|') === 'Open|Edit|Remove', 'desktop: clicking a link shows Open · Edit · Remove', popBtns.join('|'));
  await shot(page, 'rich-desktop-link-popover');
  await page.click('.rt-pop-link .rt-pop-btn:has-text("Edit")');
  await page.waitForSelector('.rt-pop-link-form');
  const edVal = await page.inputValue('.rt-pop-link-form input[type=url]');
  check(edVal === 'https://example.com/harbour', 'desktop: Edit opens the link form with its address', edVal);
  await page.fill('.rt-pop-link-form input[type=text]', 'harbour notebook');
  await page.press('.rt-pop-link-form input[type=text]', 'Enter');
  check((await docText(page)).includes('[harbour notebook](https://example.com/harbour)'), 'desktop: editing the link text');
  // Pasting an address over a selection links it.
  await selectText(page, 'tide');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'https://example.org/tide-tables');
    document.querySelector('.w-editor:not([hidden]):not(.w-editor-notes) .cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  check((await docText(page)).includes('[tide](https://example.org/tide-tables)'), 'desktop: pasting a web address over a selection makes a link');
  // Bare addresses render as links.
  await caretToEnd(page);
  await page.keyboard.type(' Charts: https://example.org/charts are online.', { delay: 4 });
  await caretToEnd(page);
  await settle(page, 500);
  check(await page.locator('.cm-content .rt-url').count() === 1, 'desktop: a bare https address renders as a link');
  await clickText(page, 'example.org/charts', 4);
  await page.waitForSelector('.rt-pop-link .rt-pop-url', { timeout: 4000 });
  check(await page.locator('.rt-pop-link .rt-pop-url').textContent() === 'example.org/charts', 'desktop: tapping a bare address shows its popover');
  await page.keyboard.press('Escape');
  await caretToEnd(page);

  // Images: paste a 3000x2000 photo -> placeholder with progress -> uploaded (<= 1600 px, WebP, no metadata) -> inline.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  // Hold the first upload for a moment, so the placeholder can be seen and typed past.
  let gate = null;
  const hold = async (route) => {
    await new Promise((r) => {
      gate = r;
      setTimeout(r, 2500);
    });
    await route.continue().catch(() => {});
  };
  await page.route('**/api/uploads', hold);
  await pasteImage(page, 'harbour');
  await page.waitForSelector('.rt-up', { timeout: 8000 });
  await page.waitForSelector('.rt-up.is-uploading', { timeout: 15000 });
  await page.locator('.rt-up').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await settle(page, 300);
  await shot(page, 'rich-desktop-uploading');
  check(await page.locator('.rt-up .rt-up-text').textContent() === 'Uploading…', 'desktop: a pasted image shows an upload placeholder');
  // Typing never waits for the upload.
  await page.keyboard.type('Typed while it uploads. ', { delay: 4 });
  check((await docText(page)).includes('Typed while it uploads.'), 'desktop: typing goes on while an image uploads');
  gate?.();
  let imgs = await waitImages(page, 1);
  await page.unroute('**/api/uploads', hold);
  check(imgs.length === 1 && imgs[0].ext === 'webp' && imgs[0].w === 1600 && imgs[0].h === 1067, 'desktop: the pasted photo is inserted as ![](/u/<id>.webp#w=1600&h=1067)', JSON.stringify(imgs));
  t = await docText(page);
  check(/\n\n!\[\]\(\/u\/[0-9a-f]{32}\.webp#w=1600&h=1067\)\n\nTyped while it uploads\. $/.test(t), 'desktop: the image is a paragraph of its own, above where the writer kept typing', JSON.stringify(t.slice(-140)));
  await page.waitForSelector('.cm-content .rt-img img[src^="/u/"]');
  await page.waitForFunction(() => [...document.querySelectorAll('.rt-img img')].every((i) => i.complete && i.naturalWidth > 0));
  const up = await inspectUpload(page, imgs[0].url);
  check(up.status === 200 && up.type === 'image/webp' && up.w === 1600 && up.h === 1067, 'desktop: the upload was shrunk to 1600 px and re-encoded as WebP on the device', JSON.stringify(up));
  check(up.cache === 'public, max-age=31536000, immutable', 'desktop: uploads are served with a year’s immutable cache', up.cache);
  await caretToEnd(page);
  await settle(page, 400);
  await shot(page, 'rich-desktop-image');

  // Alt text: click the image and describe it. It goes into the text as it's typed (SPEC §14b:
  // it counts like typing), a key at a time.
  await page.click('.cm-content .rt-img img');
  await page.waitForSelector('.rt-pop-image input');
  await sleep(1500); // ops so far are sent
  const mark = opsSeen.length;
  await page.type('.rt-pop-image input', 'The lighthouse at dusk, the sun', { delay: 30 });
  t = await docText(page);
  check(t.includes('![The lighthouse at dusk, the sun](/u/'), 'desktop: the description goes into the text while it’s typed', JSON.stringify(t.slice(t.indexOf('!['), t.indexOf('![') + 50)));
  await page.type('.rt-pop-image input', ' half set ', { delay: 30 });
  await settle(page);
  await shot(page, 'rich-desktop-alt');
  await page.press('.rt-pop-image input', 'Enter');
  t = await docText(page);
  check(t.includes('![The lighthouse at dusk, the sun half set](/u/'), 'desktop: the image’s description is saved as its alt text (spaces at the ends tidied)');
  await sleep(2500);
  const altOps = opsSeen.slice(mark).filter((o) => o.ins !== undefined);
  check(altOps.length >= 30 && altOps.every((o) => !o.paste && (o.source === undefined || o.source === 'autocorrect')) && altOps.filter((o) => o.ins).every((o) => o.ins.length <= 2),
    'desktop: a typed description is sent as typing, a key at a time (no paste, no dictation)', JSON.stringify(altOps.slice(0, 6).map((o) => [o.ins, o.source, !!o.paste])) + ` n=${altOps.length}`);
  check(await page.locator('.rt-img-cap').first().textContent() === 'The lighthouse at dusk, the sun half set', 'desktop: the description shows as the caption');

  // A photo stored sideways with GPS: upright, and nothing identifying uploaded.
  await caretToEnd(page);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await pasteImage(page, 'sideways');
  imgs = await waitImages(page, 2);
  const side = imgs.find((i) => i.w === 80 && i.h === 120);
  check(!!side, 'desktop: EXIF orientation applied (stored sideways, uploaded upright)', JSON.stringify(imgs));
  if (side) {
    const s2 = await inspectUpload(page, side.url);
    check(s2.leaks.length === 0, 'desktop: no EXIF/GPS/maker data in the uploaded file', JSON.stringify(s2));
    // A description pasted into the form gets the paste question, as in the text.
    const pasteAlt = async (text) => page.evaluate((tx) => {
      const input = document.querySelector('.rt-pop-image input');
      input.focus();
      input.select();
      const dt = new DataTransfer();
      dt.setData('text/plain', tx);
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, text);
    await page.locator(`.cm-content .rt-img img[src="${side.url}"]`).click();
    await page.waitForSelector('.rt-pop-image input');
    await sleep(1500);
    const m2 = opsSeen.length;
    await pasteAlt('A small portrait, half blue');
    await settle(page, 300);
    t = await docText(page);
    check(t.includes(`![A small portrait, half blue](${side.url}`), 'desktop: a short description pasted into the form goes in', JSON.stringify(t.slice(-120)));
    const long = 'A narrow portrait photograph, its upper half a deep blue and its lower half a pale stone colour, taken sideways';
    await pasteAlt(long);
    await page.waitForSelector('dialog[open] button:has-text("Paste without counting")', { timeout: 5000 }).catch(() => {});
    const asked = await page.locator('dialog[open] button:has-text("Paste without counting")').count();
    check(asked === 1, 'desktop: a long description pasted into the form gets the paste question');
    if (asked) {
      await settle(page, 200);
      await shot(page, 'rich-desktop-alt-paste-question');
      await page.click('dialog[open] button:has-text("Paste without counting")');
    }
    await settle(page, 300);
    t = await docText(page);
    check(t.includes(`![${long}](${side.url}`), 'desktop: and goes in once answered (the form stays open)', JSON.stringify(t.slice(-200)));
    check(await page.locator('.rt-pop-image').count() === 1, 'desktop: the description form stays open through the paste question');
    await page.press('.rt-pop-image input', 'Enter');
    await sleep(2500);
    const pasted = opsSeen.slice(m2).filter((o) => o.paste);
    check(pasted.some((o) => o.ins === 'A small portrait, half blue' && o.paste.d === 'short') && pasted.some((o) => o.ins === long && o.paste.d === 'no'),
      'desktop: pasted descriptions are sent as pastes, with the answer', JSON.stringify(pasted.map((o) => [o.ins.slice(0, 20), o.paste.d])));
  }

  // Offline: the upload waits, says so, and goes up when the connection is back.
  await caretToEnd(page);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await ctx.setOffline(true);
  await pasteImage(page, 'screenshot');
  await page.waitForSelector('.rt-up.is-waiting', { timeout: 10000 });
  await page.locator('.rt-up').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const offText = await page.locator('.rt-up .rt-up-text').textContent();
  check(offText === 'Will upload when you’re back online.', 'desktop: offline, the image waits with a clear note', offText);
  await settle(page, 300);
  await shot(page, 'rich-desktop-offline');
  await ctx.setOffline(false);
  imgs = await waitImages(page, 3);
  check(imgs.length === 3, 'desktop: back online, the queued image uploads by itself', String(imgs.length));

  // A failed upload is retried.
  let failed = 0;
  const flaky = async (route) => {
    if (failed++ === 0) await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"busy"}' }).catch(() => {});
    else await route.continue().catch(() => {});
  };
  await page.route('**/api/uploads', flaky);
  await caretToEnd(page);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await pasteImage(page, 'screenshot');
  await page.waitForSelector('.rt-up.is-waiting', { timeout: 8000 });
  const retryText = await page.locator('.rt-up .rt-up-text').textContent();
  imgs = await waitImages(page, 4);
  check(imgs.length === 4 && failed >= 2, 'desktop: a failed upload retries by itself', `${retryText} / ${imgs.length} / ${failed}`);
  await page.unroute('**/api/uploads', flaky);

  // Drop an image at a position.
  const dropAt = await cm(page, (v) => {
    const i = v.state.doc.toString().indexOf('Arrival');
    const a = v.coordsAtPos(i + 3);
    return { x: a.left, y: (a.top + a.bottom) / 2 };
  });
  await dropImage(page, 'screenshot', dropAt.x, dropAt.y);
  imgs = await waitImages(page, 5);
  t = await docText(page);
  check(imgs.length === 5 && /## Arrival\n\n!\[\]\(\/u\//.test(t), 'desktop: a dropped image lands below the line it was dropped on', JSON.stringify(t.slice(t.indexOf('Arrival') - 5, t.indexOf('Arrival') + 70)));

  // Remove an image from its popover; Undo brings it back.
  const before = images(await docText(page)).length;
  await page.locator('.cm-content .rt-img img').last().scrollIntoViewIfNeeded();
  await page.locator('.cm-content .rt-img img').last().click();
  await page.waitForSelector('.rt-pop-image .rt-form-remove');
  await page.click('.rt-pop-image .rt-form-remove');
  check(images(await docText(page)).length === before - 1, 'desktop: Remove image takes it out of the text');
  await page.keyboard.press('Control+z');
  check(images(await docText(page)).length === before, 'desktop: Undo brings it back');
  await selectText(page, 'Every evening');
  await page.waitForSelector('.rt-float:not([hidden])');
  await page.click('.rt-float .rt-btn-italic');
  const withItalic = await docText(page);
  await page.click('.rt-float .rt-btn-undo');
  const undone = await docText(page);
  check(withItalic.includes('*Every evening*') && !undone.includes('*Every evening*'), 'desktop: the Undo button');
  await page.click('.rt-float .rt-btn-redo').catch(() => {});
  check((await docText(page)).includes('*Every evening*'), 'desktop: the Redo button');

  // On an empty line, after a pause, an image button appears in the margin.
  await caretToEnd(page);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.rt-insert:not([hidden])', { timeout: 4000 }).catch(() => {});
  const ins = await page.locator('.rt-insert:not([hidden])').boundingBox();
  const colLeft = await page.locator(ED).evaluate((el) => el.getBoundingClientRect().left);
  check(!!ins && ins.x + ins.width <= colLeft, 'desktop: an empty line shows an image button in the margin', JSON.stringify({ ins, colLeft }));
  if (ins) {
    await settle(page, 200);
    await shot(page, 'rich-desktop-insert');
    const had = images(await docText(page)).length;
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('.rt-insert')]);
    await fc.setFiles({ name: 'sideways.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(SIDEWAYS_JPEG, 'base64') });
    const after = await waitImages(page, had + 1);
    check(after.length === had + 1, 'desktop: the margin button adds an image', `${had} -> ${after.length}`);
  }
  await page.keyboard.type('x', { delay: 4 });
  check(await page.locator('.rt-insert:not([hidden])').count() === 0, 'desktop: the margin button goes once the line has text');
  await page.keyboard.press('Backspace');

  // Dark mode: the bar and an image.
  await page.emulateMedia({ colorScheme: 'dark' });
  await dblclickWord(page, 'keeper');
  await page.waitForSelector('.rt-float:not([hidden])');
  await settle(page, 300);
  await shot(page, 'rich-desktop-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // Wait for the ops to reach the server: the live page and the post's own page show the images
  // (with their descriptions) and the links.
  await sleep(2500);
  const live = await ctx.newPage();
  onPage(live, 'live');
  await live.goto(`${BASE}/live`);
  await live.waitForSelector('.l-card img[src^="/u/"], img[src^="/u/"]', { timeout: 15000 }).catch(() => {});
  check(await live.locator('img[src^="/u/"]').count() >= 1, 'live page: uploaded images render on the card');
  await settle(live, 600);
  await shot(live, 'rich-live-desktop');
  const pub = await (await fetch(`${BASE}/api/live`)).json();
  const mine = (pub.posts || []).find((x) => x.title === post.title || /keeper/.test(x.title || ''));
  if (check(!!mine, 'live page: the post is listed', JSON.stringify((pub.posts || []).map((x) => x.title)))) {
    await live.goto(`${BASE}/p/${mine.id}`);
    await live.waitForSelector('img[src^="/u/"]', { timeout: 15000 }).catch(() => {});
    const alts = await live.locator('img[src^="/u/"]').evaluateAll((els) => els.map((e) => e.alt));
    check(alts.includes('The lighthouse at dusk, the sun half set'), 'post page: the image carries the writer’s description as alt text', JSON.stringify(alts));
    check(await live.locator('a[href="https://example.com/harbour"]').count() >= 1, 'post page: links render as links');
    check(await live.locator('a[href="https://example.org/charts"]').count() >= 1, 'post page: a bare address renders as a link');
    const fig = live.locator('figure:has(img[alt="The lighthouse at dusk, the sun half set"])');
    if (await fig.count()) {
      await fig.first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await live.waitForFunction(() => [...document.querySelectorAll('img[src^="/u/"]')].every((i) => i.complete), null, { timeout: 8000 }).catch(() => {});
      await settle(live, 500);
      await shot(live, 'rich-post-page');
    }
  }
  await live.close();
  const finalText = await docText(page);
  await page.close();
  await ctx.close();
  return finalText;
}

// ---------------------------------------------------------------- phone (Pixel 7)
const PIXEL7 = {
  viewport: { width: 412, height: 839 }, screen: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
};
async function phone(browser, writer) {
  let t = '';
  const ctx = await browser.newContext(PIXEL7);
  await ctx.addCookies([{ name: 'wh_sess', value: writer.token, url: BASE }]);
  const page = await ctx.newPage();
  onPage(page, 'phone');
  await page.goto(`${BASE}/write`);
  await page.waitForSelector(ED);
  await page.waitForFunction(() => !!document.querySelector('link[data-rt]'), null, { timeout: 10000 });
  await page.evaluate(() => {
    try {
      localStorage.removeItem('wh-format-bar');
    } catch { /* none */ }
  });
  await settle(page, 400);
  await page.evaluate(() => document.activeElement?.blur());
  await settle(page, 200);
  check(await page.locator('.rt-dock:not([hidden])').count() === 0, 'phone: no bar while the editor isn’t focused (keyboard down)');
  // The keyboard opens: the visual viewport gets shorter (Android resizes the page).
  await page.setViewportSize({ width: 412, height: 470 });
  await caretToEnd(page);
  await page.keyboard.type('Written on a phone, with the keyboard up and the bar just above it.', { delay: 4 });
  await page.waitForSelector('.rt-dock:not([hidden]):not(.is-collapsed)', { timeout: 5000 });
  await settle(page, 300);
  await shot(page, 'rich-phone-dock');
  const geo = await page.evaluate(async () => {
    const { EditorView } = await import('/vendor/cm.js');
    const view = EditorView.findFromDOM(document.querySelector('.w-editor:not([hidden]):not(.w-editor-notes) .cm-editor'));
    const r = (sel) => document.querySelector(sel)?.getBoundingClientRect().toJSON();
    const caret = view.coordsAtPos(view.state.selection.main.head);
    const btns = [...document.querySelectorAll('.rt-dock .rt-btn, .rt-dock .rt-chev')].map((b) => b.getBoundingClientRect()).map((b) => [b.width, b.height]);
    return { dock: r('.rt-dock'), foot: r('.w-foot'), sheet: r('.w-sheet'), caret: caret && { top: caret.top, bottom: caret.bottom }, btns, vh: window.visualViewport.height };
  });
  check(geo.dock && Math.abs(geo.dock.bottom - geo.vh) < 1.5, 'phone: the bar sits at the bottom of the visible area (just above the keyboard)', JSON.stringify(geo.dock));
  check(geo.foot && geo.dock && geo.foot.bottom <= geo.dock.top + 0.5, 'phone: the bar and the footer don’t overlap (footer above the bar)', JSON.stringify({ foot: geo.foot, dock: geo.dock }));
  check(geo.caret && geo.caret.bottom <= geo.foot.top, 'phone: the caret line is above the footer and the bar', JSON.stringify({ caret: geo.caret, foot: geo.foot }));
  check(geo.btns.every(([w, h2]) => w >= 44 && h2 >= 44), 'phone: every bar button is at least 44 px', JSON.stringify(geo.btns));
  // No layout jump while typing.
  const dockBefore = await page.locator('.rt-dock').boundingBox();
  await page.keyboard.type(' More words, typed fast.', { delay: 4 });
  const dockAfter = await page.locator('.rt-dock').boundingBox();
  check(JSON.stringify(dockBefore) === JSON.stringify(dockAfter), 'phone: the bar doesn’t move while typing');

  // Bold from the bar on a selection.
  await selectText(page, 'keyboard');
  await settle(page);
  await page.tap('.rt-dock .rt-btn-bold');
  check((await docText(page)).includes('the **keyboard** up'), 'phone: Bold from the docked bar');
  // A list from the bar, continued with Enter. (On Android, CodeMirror holds an Enter key for a
  // moment to see what the keyboard does with it, so keys here come at a human pace.)
  const enter = async () => {
    await page.keyboard.press('Enter');
    await sleep(160);
  };
  await caretToEnd(page);
  await enter();
  await enter();
  await page.tap('.rt-dock .rt-btn-bullet');
  await page.keyboard.type('Thumbs', { delay: 4 });
  await enter();
  await page.keyboard.type('Coffee', { delay: 4 });
  t = await docText(page);
  check(/\n- Thumbs\n- Coffee$/.test(t), 'phone: bulleted list from the bar, continued with Enter', JSON.stringify(t.slice(-50)));
  await enter();
  await enter();
  t = await docText(page);
  check(/\n- Coffee\n\n$/.test(t), 'phone: Enter on an empty item ends the list', JSON.stringify(t.slice(-30)));

  // A link from the bar: the address form opens as a sheet above the keyboard.
  await page.keyboard.type('Read the harbour notes first.', { delay: 4 });
  await selectText(page, 'harbour notes');
  await settle(page);
  await page.tap('.rt-dock .rt-btn-link');
  await page.waitForSelector('.rt-pop-link-form.is-sheet input[type=url]');
  await page.keyboard.type('example.com/harbour', { delay: 4 });
  await settle(page, 300);
  await shot(page, 'rich-phone-link-form');
  await page.tap('.rt-pop-link-form button[type=submit]');
  t = await docText(page);
  check(t.includes('Read the [harbour notes](https://example.com/harbour) first.'), 'phone: Link button on a selection makes a link', JSON.stringify(t.slice(-80)));
  await caretToEnd(page);
  await enter();
  await enter();

  // The chevron hides the bar (remembered); a selection shows it anyway.
  await page.tap('.rt-dock .rt-chev');
  await page.waitForSelector('.rt-dock.is-collapsed .rt-chev');
  await settle(page, 300);
  await shot(page, 'rich-phone-collapsed');
  const pref = await page.evaluate(() => localStorage.getItem('wh-format-bar'));
  check(pref === 'hidden', 'phone: hiding the bar is remembered on the device', pref);
  const colGeo = await page.evaluate(() => ({
    tools: document.querySelector('.rt-dock-scroll')?.getBoundingClientRect().height,
    chev: document.querySelector('.rt-chev').getBoundingClientRect().toJSON(),
    foot: document.querySelector('.w-foot').getBoundingClientRect().toJSON(),
    count: document.querySelector('.w-prog-text') && (({ scrollWidth, clientWidth }) => ({ scrollWidth, clientWidth }))(document.querySelector('.w-prog-text')),
  }));
  check(!colGeo.tools, 'phone: hidden, only the chevron is left');
  check(colGeo.chev.bottom <= colGeo.foot.top + 1, 'phone: the chevron sits on the footer’s top edge, not over it', JSON.stringify(colGeo));
  check(!colGeo.count || colGeo.count.scrollWidth <= colGeo.count.clientWidth + 1, 'phone: the footer count isn’t cut short', JSON.stringify(colGeo.count));
  await selectText(page, 'More words');
  await page.waitForSelector('.rt-dock:not(.is-collapsed)', { timeout: 3000 });
  await settle(page, 300);
  await shot(page, 'rich-phone-selection');
  check(true, 'phone: a selection shows the bar even when it was hidden');
  await page.tap('.rt-dock .rt-btn-italic');
  check((await docText(page)).includes('*More words*'), 'phone: Italic on the selection');
  await caretToEnd(page);
  await settle(page, 200);
  check(await page.locator('.rt-dock.is-collapsed').count() === 1, 'phone: without a selection it hides again');
  await page.reload();
  await page.waitForSelector(ED);
  await settle(page, 400);
  await caretToEnd(page);
  await page.waitForSelector('.rt-dock .rt-chev');
  check(await page.locator('.rt-dock.is-collapsed').count() === 1, 'phone: still hidden after a reload');
  await page.tap('.rt-dock .rt-chev');
  await page.waitForSelector('.rt-dock:not(.is-collapsed)');

  // Image from the bar's Image button (file picker; camera allowed by accept="image/*").
  const accept = await page.getAttribute('input[type=file][accept]', 'accept');
  check(accept === 'image/*', 'phone: the picker takes any image (camera or library)', accept);
  await caretToEnd(page);
  const bytes = await harbourBytes(page);
  const had = images(await docText(page)).length;
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.tap('.rt-dock .rt-btn-image')]);
  await chooser.setFiles({ name: 'PXL_20261004_101208.jpg', mimeType: 'image/jpeg', buffer: bytes });
  const imgs = await waitImages(page, had + 1);
  check(imgs.length === had + 1, 'phone: an image added with the Image button uploads and goes in', `${had} -> ${imgs.length}`);
  await page.waitForSelector('.rt-img img[src^="/u/"]');
  await page.setViewportSize({ width: 412, height: 839 }); // keyboard down
  await page.evaluate(() => document.activeElement?.blur());
  await page.locator('.cm-content .rt-img').last().scrollIntoViewIfNeeded();
  await settle(page, 500);
  await shot(page, 'rich-phone-image');
  // Tap the image: describe it in a sheet.
  await page.locator('.cm-content .rt-img img').last().tap();
  await page.waitForSelector('.rt-pop-image.is-sheet');
  await settle(page, 300);
  await shot(page, 'rich-phone-alt');
  await page.fill('.rt-pop-image input', 'A gull on the rail');
  await page.tap('.rt-pop-image button[type=submit]');
  check((await docText(page)).includes('![A gull on the rail](/u/'), 'phone: describing the image from the sheet');
  // Tap a link: its popover.
  await cm(page, (v) => {
    const i = v.state.doc.toString().indexOf('harbour notes');
    v.dispatch({ effects: v.constructor.scrollIntoView(i, { y: 'center' }) });
  });
  await settle(page, 300);
  await tapText(page, 'harbour notes', 3);
  await page.waitForSelector('.rt-pop-link', { timeout: 4000 });
  await settle(page, 300);
  await shot(page, 'rich-phone-link');
  const pb = await page.locator('.rt-pop-link .rt-pop-btn').first().boundingBox();
  check(pb && pb.height >= 44, 'phone: link popover buttons are at least 44 px', JSON.stringify(pb));
  await page.close();
  await ctx.close();
}

// ---------------------------------------------------------------- main
let browser;
try {
  await waitForServer();
  const host = new Client();
  await host.req('/api/register', { username: 'host', name: 'Host', password: 'party-password' });
  // Writers start at once: no approval step, and personal hours (no waiting for a synced hour).
  await host.req('/api/admin/settings', { scoring: { approvalRequired: false, hoursMode: 'personal' } }).catch(() => {});
  await host.req('/api/admin/start', {});
  const writer = new Client();
  await writer.req('/api/register', { username: 'ana', name: 'Ana', password: 'party-password' });
  await writer.req('/api/join', {});
  const { post } = await writer.req('/api/post/new', {});
  await writer.req('/api/post/update', { id: post.id, title: 'The keeper’s ledger' });
  // A busy machine can be short of processes for a moment while other browsers run: retry the launch.
  for (let k = 0; k < 8 && !browser; k++) {
    try {
      browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
    } catch (e) {
      log('browser launch failed, retrying:', String(e.message).split('\n')[0]);
      await sleep(3000 * (k + 1));
    }
  }
  if (!browser) throw new Error('could not launch the browser');
  let finalText = '';
  if (ONLY !== 'phone') finalText = await desktop(browser, writer, post);
  if (ONLY !== 'desktop') await phone(browser, writer);
  // What the server stored is what the editor showed (ops and sync unaffected).
  await sleep(1500);
  const posts = await writer.req('/api/posts');
  const stored = posts.posts.find((p) => p.id === post.id)?.body || '';
  if (finalText) check(stored.includes(finalText.slice(0, 200)), 'server: the post text matches the editor (ops applied)');
  const ok = images(stored).length;
  const want = (ONLY !== 'phone' ? 6 : 0) + (ONLY !== 'desktop' ? 1 : 0);
  check(ok === want, 'server: the images are in the stored text', `${ok} of ${want}`);
} catch (e) {
  problems.push(`run failed: ${e.stack || e.message}`);
  log('ERROR', e.stack || e.message);
} finally {
  await browser?.close().catch(() => {});
  server.kill('SIGTERM');
  await sleep(500);
  fs.rmSync(stateDir, { recursive: true, force: true });
}
log(`${passed.length} passed, ${problems.length} problems`);
for (const p of problems) log('PROBLEM', p);
if (problems.length) {
  const tail = serverLog.join('').split('\n').slice(-15).join('\n');
  if (tail.trim()) log('server log tail:\n', tail);
}
process.exit(problems.length ? 1 : 0);
