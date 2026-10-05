#!/usr/bin/env node
// Footnotes (SPEC §31) in a real browser, desktop and Pixel 7: the editor (superscript numbers off
// the caret's line, quiet notes, Add footnote from the bar and Ctrl+Alt+F, numbering by first use,
// the way to a note and back, notes over several lines with Enter, the help's entry), the post
// page (superscript links, the Notes list with back-links, an undefined reference left as text),
// the live card, and copies and exports (HTML with real footnotes, plain text with [1], Markdown
// keeping [^1], Word with superscripts).
// Screenshots: qa/after/footnotes-*.png.
// Usage: timeout 300 node tools/footnotes-qa.mjs [--port 8202] [--out <dir>]

import { spawn, execFileSync } from 'node:child_process';
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
const PORT = Number(arg('port', 8202));
const OUT = path.resolve(ROOT, arg('out', 'qa/after'));
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[fn ${new Date().toISOString().slice(11, 19)}]`, ...a);
fs.mkdirSync(OUT, { recursive: true });

try {
  await fetch(`${BASE}/healthz`);
  console.error(`Port ${PORT} is already in use; pick another with --port.`);
  process.exit(2);
} catch { /* free */ }
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-fn-'));
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
  } catch { /* the server may still be writing its last save: removed below */ }
});

const problems = [];
const passed = [];
process.on('unhandledRejection', (e) => problems.push(`unhandled: ${e && e.message}`));
process.on('uncaughtException', (e) => {
  console.error('[fn] uncaught:', e);
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
async function settle(page, ms = 250) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await sleep(ms);
}
async function shot(page, name, opts = {}) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, ...opts });
  log('screenshot', path.relative(ROOT, file));
}

const PARA1 = 'The keeper climbed the hundred and twelve steps every evening and counted them aloud';
const PARA2 = 'He wrote the count in a ledger with a green cloth spine, beside the weather and the ships';

async function desktop(browser, writer, post) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
  await ctx.addCookies([{ name: 'wh_sess', value: writer.token, url: BASE }]);
  const page = await ctx.newPage();
  onPage(page, 'desktop');
  await page.goto(`${BASE}/write`);
  await page.waitForSelector(ED);
  await page.waitForFunction(() => !!document.querySelector('link[data-rt]'), null, { timeout: 10000 });
  await settle(page, 400);
  await page.click(ED);
  await cm(page, (v) => v.dispatch({ selection: { anchor: v.state.doc.length } }));
  await page.keyboard.type(`${PARA1}. ${PARA2}.`, { delay: 3 });
  // Ctrl+Alt+F after "aloud": the reference at the caret, its note at the end, the caret in it.
  let t = await docText(page);
  await caretAt(page, t.indexOf('aloud') + 5);
  await page.keyboard.press('Control+Alt+f');
  t = await docText(page);
  check(t.includes('aloud[^1]. He wrote') && t.endsWith('ships.\n\n[^1]: '), 'editor: Ctrl+Alt+F puts [^1] at the caret and its note at the end', JSON.stringify(t.slice(-60)));
  check(await head(page) === t.length, 'editor: the caret goes to the new note');
  await page.keyboard.type('One hundred and twelve, counted in the dark.', { delay: 3 });
  // A second footnote from the floating bar, on a selection: right under the first note.
  t = await docText(page);
  await cm(page, (v, [a, b]) => {
    v.focus();
    v.dispatch({ selection: { anchor: a, head: b } });
  }, [t.indexOf('green cloth spine'), t.indexOf('green cloth spine') + 'green cloth spine'.length]);
  await page.waitForSelector('.rt-float:not([hidden]) .rt-btn-footnote', { timeout: 5000 });
  await settle(page);
  await shot(page, 'footnotes-desktop-bar');
  await page.click('.rt-float .rt-btn-footnote');
  t = await docText(page);
  check(t.includes('green cloth spine[^2],') && /\n\[\^1\]: One hundred and twelve, counted in the dark\.\n\[\^2\]: $/.test(t), 'editor: the bar’s Add footnote adds [^2] after the selection, its note under the first', JSON.stringify(t.slice(-90)));
  await page.keyboard.type('Bought in the village, 1997.', { delay: 3 });
  // Numbered by first use: a reference to note 2 written before note 1's.
  t = await docText(page);
  await caretAt(page, t.indexOf('steps') + 5);
  await page.keyboard.type('[^2]', { delay: 3 });
  // A reference without a note stays as written.
  t = await docText(page);
  await caretAt(page, t.indexOf('weather') + 7);
  await page.keyboard.type('[^nothere]', { delay: 3 });
  // Off the caret's line: numbers by first use.
  t = await docText(page);
  await caretAt(page, t.length);
  await settle(page, 300);
  const refs = await page.locator(`${ED} .rt-fn-ref`).allTextContents();
  check(JSON.stringify(refs) === '["1","2","1"]', 'editor: references show as superscript numbers, numbered by first use', JSON.stringify(refs));
  check((await page.locator(`${ED} .cm-line`, { hasText: '[^nothere]' }).count()) === 1, 'editor: a reference without a note stays as written');
  const nums = await page.locator(`${ED} .rt-fn-num`).allTextContents();
  check(JSON.stringify(nums) === '["2","1"]', 'editor: notes show their numbers', JSON.stringify(nums));
  check(await page.locator(`${ED} .cm-line.rt-fn-def`).count() === 2 && await page.locator(`${ED} .cm-line.rt-fn-first`).count() === 1, 'editor: notes get the note style, the first one a rule above');
  await shot(page, 'footnotes-desktop-editor');
  // From a note's number back to the text; from a reference to its note.
  await page.locator(`${ED} .rt-fn-num`).first().click();
  t = await docText(page);
  check(await head(page) === t.indexOf('aloud[^1]') + 'aloud[^1]'.length, 'editor: clicking a note’s number goes back to its reference', `${await head(page)}`);
  await caretAt(page, t.length);
  await settle(page);
  // The first superscript is "[^2]" after "steps" (note 1 by first use): its note's line.
  await page.locator(`${ED} .rt-fn-ref`).first().click();
  const noteAt = t.indexOf('\n[^2]: ') + 1;
  const lineEnd = t.indexOf('\n', noteAt) < 0 ? t.length : t.indexOf('\n', noteAt);
  check(await head(page) === lineEnd, 'editor: clicking a reference goes to its note', `${await head(page)} vs ${lineEnd}`);
  // The tool's tooltip names the shortcut.
  const tip = await page.getAttribute('.rt-btn-footnote', 'title').catch(() => null);
  check(/Add footnote \(Ctrl\+Alt\+F\)/.test(tip || ''), 'editor: the button’s tooltip has the shortcut', tip);
  // Dark mode (the caret in the notes, so the text shows its numbers).
  await page.emulateMedia({ colorScheme: 'dark' });
  await caretAt(page, (await docText(page)).length);
  await settle(page, 300);
  await shot(page, 'footnotes-desktop-editor-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // Copies and exports, from the writer's page (interop.js).
  const io = await page.evaluate(async (md) => {
    const x = await import('/js/interop.js');
    return { html: x.markdownToHtml(md), plain: x.markdownToPlain(md), rich: x.richCopyData(md, 'The keeper’s ledger').html, paste: x.htmlToMarkdown('<p>As shown<sup class="reference"><a href="#cite_note-1">[1]</a></sup>.</p><ol class="references"><li id="cite_note-1">A source.</li></ol>') };
  }, await docText(page));
  check(io.html.includes('<sup class="footnote-ref"><a href="#fn-1" id="fnref-1">1</a></sup>') && io.html.includes('<section class="footnotes"><ol><li id="fn-1">'), 'copy: HTML has superscript links and the notes list', io.html.slice(0, 300));
  check(/steps<sup class="footnote-ref"><a href="#fn-1" id="fnref-1">1<\/a><\/sup>/.test(io.html) && /aloud<sup class="footnote-ref"><a href="#fn-2" id="fnref-2">2<\/a><\/sup>/.test(io.html), 'copy: numbered by first use');
  check(io.html.includes('[^nothere]') && !io.html.includes('[^1]'), 'copy: a reference without a note stays text; notes leave the flow');
  check(/<a href="#fnref-1" class="footnote-backref">/.test(io.html), 'copy: notes link back');
  check(/steps\[1\]/.test(io.plain) && /\n\n\[1\] Bought in the village, 1997\.\n\[2\] One hundred and twelve, counted in the dark\.$/.test(io.plain), 'plain text: [1] in the text and the notes at the end', JSON.stringify(io.plain.slice(-160)));
  check(io.rich.includes('class="footnote-ref"') && io.rich.includes('class="footnotes"'), 'rich copy (Google Docs, LessWrong, Substack): real footnotes');
  check(/As shown\s*\[1\]/.test(io.paste), 'paste-in: a footnoted page still comes in with [1]', io.paste);
  // Exports: Markdown keeps [^n]; HTML has real footnotes; Word has superscripts.
  const grab = async (format) => {
    await page.evaluate(async ([f, p]) => {
      const x = await import('/js/interop.js');
      await x.exportPost(p, f);
    }, [format, { title: 'The keeper’s ledger', body: await docText(page) }]).catch(() => {});
    return null;
  };
  const downloads = {};
  for (const fmt of ['md', 'txt', 'html', 'docx']) {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), grab(fmt)]);
    const file = path.join(stateDir, `export.${fmt}`);
    await dl.saveAs(file);
    downloads[fmt] = file;
  }
  const md = fs.readFileSync(downloads.md, 'utf8');
  check(md.includes('aloud[^1]') && md.includes('\n[^1]: One hundred'), 'export: Markdown keeps [^n] and the notes');
  const txt = fs.readFileSync(downloads.txt, 'utf8');
  check(/steps\[1\]/.test(txt) && /\[2\] One hundred and twelve/.test(txt), 'export: plain text has [1] and the notes at the end');
  const html = fs.readFileSync(downloads.html, 'utf8');
  check(html.includes('<sup class="footnote-ref"><a href="#fn-1" id="fnref-1">1</a></sup>') && html.includes('<section class="footnotes">'), 'export: HTML has real footnotes');
  const docxXml = execFileSync('python3', ['-c', 'import sys,zipfile;print(zipfile.ZipFile(sys.argv[1]).read("word/document.xml").decode())', downloads.docx], { encoding: 'utf8' });
  check(/<w:vertAlign w:val="superscript"\/><\/w:rPr><w:t xml:space="preserve">1<\/w:t>/.test(docxXml) && !/↩/.test(docxXml) && docxXml.includes('Bought in the village'), 'export: Word has superscript numbers and the notes, no back-arrows');
  // How the exported HTML reads.
  const view = await ctx.newPage();
  await view.goto(`file://${downloads.html}`);
  await view.locator('section.footnotes').scrollIntoViewIfNeeded();
  await settle(view, 300);
  await shot(view, 'footnotes-export-html');
  await view.close();

  // The public pages: wait until the server has the text.
  const want = await docText(page);
  for (let k = 0; k < 40; k++) {
    const posts = await writer.req('/api/posts');
    if (posts.posts.find((x) => x.id === post.id)?.body === want) break;
    await sleep(250);
  }
  const live = await ctx.newPage();
  onPage(live, 'live');
  const pub = await (await fetch(`${BASE}/api/live`)).json();
  const mine = (pub.posts || []).find((x) => /keeper/.test(x.title || ''));
  check(!!mine, 'live: the post is public');
  await live.goto(`${BASE}/p/${mine.id}`);
  await live.waitForSelector('.p-body sup.fn-ref', { timeout: 10000 }).catch(() => {});
  const supNums = await live.locator('.p-body sup.fn-ref a').allTextContents();
  check(JSON.stringify(supNums) === '["1","2","1"]', 'post page: superscript links numbered by first use', JSON.stringify(supNums));
  const hrefs = await live.locator('.p-body sup.fn-ref a').evaluateAll((els) => els.map((e) => [e.getAttribute('href'), e.id]));
  check(JSON.stringify(hrefs) === '[["#fn-1","fnref-1"],["#fn-2","fnref-2"],["#fn-1",""]]', 'post page: each points at its note; the first use carries the anchor back', JSON.stringify(hrefs));
  const notes = await live.locator('.p-notes section.footnotes li').evaluateAll((els) => els.map((e) => [e.id, e.textContent]));
  check(notes.length === 2 && notes[0][0] === 'fn-1' && notes[0][1].startsWith('Bought in the village, 1997.') && notes[1][1].startsWith('One hundred and twelve'), 'post page: a Notes list at the end, in order of first use', JSON.stringify(notes));
  check(await live.locator('.p-notes .fn-back[href="#fnref-1"]').count() === 1, 'post page: each note links back');
  check((await live.locator('.p-body').textContent()).includes('[^nothere]') && !(await live.locator('.p-body').textContent()).includes('[^1]'), 'post page: an undefined reference stays text; notes aren’t in the flow');
  await live.locator('.p-body sup.fn-ref a').first().click();
  await settle(live, 500);
  check(await live.evaluate(() => location.hash) === '#fn-1', 'post page: a reference jumps to its note');
  await shot(live, 'footnotes-post-page-notes');
  await live.locator('.p-notes .fn-back').first().click();
  await settle(live, 500);
  check(await live.evaluate(() => location.hash) === '#fnref-1', 'post page: the back-link returns to the text');
  await live.evaluate(() => window.scrollTo(0, 0));
  await settle(live, 300);
  await shot(live, 'footnotes-post-page');
  // The live card: numbers in the text, the notes in place, quietly.
  await live.goto(`${BASE}/live`);
  await live.waitForSelector('.l-card sup.fn-ref, sup.fn-ref', { timeout: 10000 }).catch(() => {});
  const card = await live.evaluate(() => ({ refs: [...document.querySelectorAll('sup.fn-ref')].map((e) => e.textContent), defs: [...document.querySelectorAll('.fn-def')].map((e) => e.textContent) }));
  check(card.refs.length >= 1 && card.defs.some((d) => /^1 Bought in the village/.test(d)), 'live card: superscript numbers, notes shown in place', JSON.stringify(card));
  await settle(live, 400);
  await shot(live, 'footnotes-live-card');
  await live.close();
  await page.close();
  await ctx.close();
}

const PIXEL7 = {
  viewport: { width: 412, height: 839 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
};
async function phone(browser, writer) {
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
  await page.setViewportSize({ width: 412, height: 470 }); // the keyboard is up
  let t = await docText(page);
  await caretAt(page, t.indexOf('ships') + 5);
  await page.waitForSelector('.rt-dock:not([hidden]) .rt-btn-footnote', { timeout: 5000 });
  // The bar scrolls: the footnote button is reachable.
  await page.locator('.rt-dock .rt-btn-footnote').scrollIntoViewIfNeeded();
  await page.tap('.rt-dock .rt-btn-footnote');
  t = await docText(page);
  check(t.includes('ships[^3].') && /\n\[\^3\]: $/.test(t), 'phone: the docked bar’s footnote button adds [^3] and its note', JSON.stringify(t.slice(-40)));
  await page.keyboard.type('Ferries, mostly.', { delay: 4 });
  await settle(page, 300);
  await shot(page, 'footnotes-phone-add');
  const geo = await page.evaluate(() => {
    const btn = document.querySelector('.rt-dock .rt-btn-footnote').getBoundingClientRect();
    return { w: btn.width, h: btn.height };
  });
  check(geo.w >= 44 && geo.h >= 44, 'phone: the footnote button is at least 44 px', JSON.stringify(geo));
  // Back to the text: tap the note's number.
  await page.locator(`${ED} .rt-fn-num`).last().tap();
  t = await docText(page);
  check(await head(page) === t.indexOf('ships[^3]') + 'ships[^3]'.length, 'phone: tapping the note’s number goes back to the text', `${await head(page)}`);
  await settle(page, 300);
  await shot(page, 'footnotes-phone-back');
  await page.setViewportSize({ width: 412, height: 839 });
  // The post page on a phone.
  for (let k = 0; k < 40; k++) {
    const posts = await writer.req('/api/posts');
    if (posts.posts.some((x) => (x.body || '').includes('Ferries, mostly.'))) break;
    await sleep(250);
  }
  const pub = await (await fetch(`${BASE}/api/live`)).json();
  const mine = (pub.posts || []).find((x) => /keeper/.test(x.title || ''));
  await page.goto(`${BASE}/p/${mine.id}`);
  await page.waitForSelector('.p-notes section.footnotes', { timeout: 10000 }).catch(() => {});
  check(await page.locator('.p-notes section.footnotes li').count() === 3, 'phone post page: three notes');
  await page.locator('.p-notes section.footnotes').scrollIntoViewIfNeeded();
  await settle(page, 400);
  await shot(page, 'footnotes-phone-post');
  await page.close();
  await ctx.close();
}

// Notes over several lines: Enter in a note continues it on an indented line (styled as the
// note), Enter on that line while it's empty ends the note, Shift+Enter starts a paragraph in it;
// lists, quotes and code keep their own Enter. The help says so.
const ML = [
  'Ships came in[^1] at dawn, and the keeper wrote it down[^2].',
  '',
  '- a list item',
  '> a quote',
  '',
  '```',
  '[^3]: not a note',
  '```',
  '',
  '[^1]: The ledger says so.',
  '[^2]: Second note.',
].join('\n');
async function multiline(browser, writer) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addCookies([{ name: 'wh_sess', value: writer.token, url: BASE }]);
  const page = await ctx.newPage();
  onPage(page, 'multiline');
  await page.goto(`${BASE}/write`);
  await page.waitForSelector(ED);
  await page.waitForFunction(() => !!document.querySelector('link[data-rt]'), null, { timeout: 10000 });
  await settle(page, 300);
  await page.click(ED);
  const setDoc = (text, at) => cm(page, (v, [x, p]) => {
    v.focus();
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: x }, selection: { anchor: p }, scrollIntoView: true });
  }, [text, at]);
  const body = async (label) => page.evaluate(async ([text, l]) => {
    const { footnotes } = await import('/js/footnotes.js');
    const d = footnotes(text).defs.get(l);
    return d ? d.body : null;
  }, [await docText(page), label]);
  const noteEnd = (t, label) => {
    const i = t.indexOf(`[^${label}]: `);
    const j = t.indexOf('\n', i);
    return j < 0 ? t.length : j;
  };
  const styled = (text) => page.locator(`${ED} .cm-line.rt-fn-def`, { hasText: text }).count();
  await setDoc(ML, noteEnd(ML, '1'));
  await page.keyboard.press('Enter');
  let t = await docText(page);
  check(t.includes('[^1]: The ledger says so.\n  \n[^2]') && await head(page) === noteEnd(ML, '1') + 3, 'notes: Enter at the end of a note starts an indented line in it', JSON.stringify(t.slice(-60)));
  await settle(page, 150);
  const emptyStyled = await cm(page, (v) => v.domAtPos(v.state.selection.main.head).node.parentElement?.closest('.cm-line')?.classList.contains('rt-fn-def'));
  check(emptyStyled === true, 'notes: the new line looks like part of the note');
  await page.keyboard.type('It was kept for forty years.', { delay: 3 });
  check(await body('1') === 'The ledger says so.\nIt was kept for forty years.', 'notes: typing there continues the note', JSON.stringify(await body('1')));
  await settle(page, 150);
  check(await styled('It was kept for forty years.') === 1, 'notes: its second line has the note style');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  t = await docText(page);
  check(t.includes('forty years.\n\n[^2]') && await body('1') === 'The ledger says so.\nIt was kept for forty years.', 'notes: Enter on the empty line ends the note (its indentation goes)', JSON.stringify(t.slice(-70)));
  await page.keyboard.type('Back in the text.', { delay: 3 });
  t = await docText(page);
  check(await body('1') === 'The ledger says so.\nIt was kept for forty years.' && t.includes('forty years.\nBack in the text.\n[^2]'), 'notes: what’s typed after that is back in the text', JSON.stringify(t.slice(-80)));
  // Shift+Enter: a new paragraph in the note.
  await setDoc(ML, noteEnd(ML, '2'));
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('A second paragraph.', { delay: 3 });
  check(await body('2') === 'Second note.\n\nA second paragraph.', 'notes: Shift+Enter starts a new paragraph in the note', JSON.stringify(await body('2')));
  await settle(page, 150);
  const blankStyled = await cm(page, (v) => {
    const line = v.state.doc.lineAt(v.state.doc.length).number - 1;
    const el = v.domAtPos(v.state.doc.line(line).from).node;
    return (el.nodeType === 1 ? el : el.parentElement).closest('.cm-line')?.classList.contains('rt-fn-def');
  });
  check(blankStyled === true && await styled('A second paragraph.') === 1, 'notes: the blank line between and the new paragraph look like the note');
  await shot(page, 'footnotes-multiline-editor');
  // Lists, quotes and code keep their own Enter; so does the start of a note's line.
  await setDoc(ML, ML.indexOf('- a list item') + '- a list item'.length);
  await page.keyboard.press('Enter');
  t = await docText(page);
  check(t.includes('- a list item\n- \n> a quote'), 'notes: Enter in a list still continues the list', JSON.stringify(t.slice(60, 110)));
  await setDoc(ML, ML.indexOf('> a quote') + '> a quote'.length);
  await page.keyboard.press('Enter');
  t = await docText(page);
  check(t.includes('> a quote\n> '), 'notes: Enter in a quote still continues the quote', JSON.stringify(t.slice(70, 120)));
  await setDoc(ML, ML.indexOf('[^3]: not a note') + '[^3]: not a note'.length);
  await page.keyboard.press('Enter');
  t = await docText(page);
  check(t.includes('[^3]: not a note\n\n```'), 'notes: Enter in a code block adds no indentation', JSON.stringify(t.slice(90, 140)));
  await setDoc(ML, ML.indexOf('[^1]: '));
  await page.keyboard.press('Enter');
  t = await docText(page);
  check(t.includes('\n\n\n[^1]: The ledger says so.\n[^2]'), 'notes: Enter before a note’s number is an ordinary new line', JSON.stringify(t.slice(-70)));
  // The help: a footnotes entry, the shortcut, a line in the cheat sheet.
  await page.evaluate(async () => (await import('/js/help.js')).openHelp('formatting'));
  await page.waitForSelector('.hp-md', { timeout: 5000 }).catch(() => {});
  await settle(page, 300);
  const help = await page.evaluate(() => {
    const sec = document.querySelector('.hp-sec-formatting') || document;
    return {
      entry: [...sec.querySelectorAll('p')].map((p) => p.textContent).find((x) => x.startsWith('Footnotes:')) || '',
      key: [...sec.querySelectorAll('.hp-keys > div')].map((d) => d.textContent).find((x) => x.startsWith('Footnote')) || '',
      md: [...sec.querySelectorAll('.hp-md-row')].map((d) => d.textContent).find((x) => x.includes('[^1]')) || '',
    };
  });
  check(/footnote button/.test(help.entry) && /Ctrl.*Alt.*F/.test(help.entry) && /Enter in a note/.test(help.entry), 'help: a Footnotes entry (the button, Ctrl+Alt+F, Enter continues a note)', JSON.stringify(help.entry));
  check(/Footnote\s*Ctrl\s*Alt\s*F/.test(help.key) && /word\[\^1\]/.test(help.md), 'help: the shortcut and a line in the cheat sheet', JSON.stringify([help.key, help.md]));
  const helpEl = page.locator('.hp-sec-formatting');
  if (await helpEl.count()) {
    await page.evaluate(() => [...document.querySelectorAll('.hp-sec-formatting p')].find((x) => x.textContent.startsWith('Footnotes:'))?.scrollIntoView({ block: 'center' }));
    await settle(page, 200);
    await shot(page, 'footnotes-help');
  }
  await page.close();
  await ctx.close();
  // A phone: Enter goes through Chrome on Android's own path.
  const pctx = await browser.newContext(PIXEL7);
  await pctx.addCookies([{ name: 'wh_sess', value: writer.token, url: BASE }]);
  const phonePage = await pctx.newPage();
  onPage(phonePage, 'multiline phone');
  await phonePage.goto(`${BASE}/write`);
  await phonePage.waitForSelector(ED);
  await phonePage.waitForFunction(() => !!document.querySelector('link[data-rt]'), null, { timeout: 10000 });
  await settle(phonePage, 300);
  await phonePage.tap(ED);
  await cm(phonePage, (v, [x, p]) => {
    v.focus();
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: x }, selection: { anchor: p }, scrollIntoView: true });
  }, [ML, noteEnd(ML, '1')]);
  await settle(phonePage, 200);
  await phonePage.keyboard.press('Enter');
  await settle(phonePage, 200);
  await phonePage.keyboard.type('Kept forty years.', { delay: 40 });
  await settle(phonePage, 200);
  await phonePage.keyboard.press('Enter');
  await settle(phonePage, 200);
  await phonePage.keyboard.press('Enter');
  await settle(phonePage, 200);
  const pt = await docText(phonePage);
  check(pt.includes('[^1]: The ledger says so.\n  Kept forty years.\n\n[^2]'), 'notes (phone): Enter continues a note, Enter on the empty line ends it', JSON.stringify(pt.slice(-80)));
  await phonePage.close();
  await pctx.close();
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
  await writer.req('/api/post/update', { id: post.id, title: 'The keeper’s ledger' });
  for (let k = 0; k < 8 && !browser; k++) {
    try {
      browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
    } catch (e) {
      log('browser launch failed, retrying:', String(e.message).split('\n')[0]);
      await sleep(3000 * (k + 1));
    }
  }
  if (!browser) throw new Error('could not launch the browser');
  await desktop(browser, writer, post);
  await phone(browser, writer);
  await multiline(browser, writer);
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
