#!/usr/bin/env node
// Browser check: open pages learn of a deploy (public/js/update.js). A writer's page (desktop),
// another writer's page (phone, dark), a writer waiting for approval, the host's page and the
// projector (/live?wall) open on build A; then a deploy: a file of the app changes and the server
// restarts on the same state file, serving build B. Checked:
//   - the writers' and the host's pages show "Writehaven was updated. Reload when you reach a
//     pause." with Reload, in the page's flow (under the writer's header, the editor below it,
//     nothing covered, notify.js's banner below it), without taking the focus; on the approval
//     card it sits above the card and follows into the writer's page when the host approves;
//   - Reload, clicked straight after typing (words still queued), sends them first and keeps
//     every word, and the page comes back on build B without the notice;
//   - the projector reloads by itself (5–30 s), stays a projector (?wall), is on build B, and
//     doesn't reload again.
// The server runs as a child process from a scratch copy of the app (server.js, lib/, public/),
// so the deploy never touches the working tree. One Chromium, closed at the end; screenshots go
// to --out (update-*.png).
//   timeout 300 node tools/update-qa.mjs [--port 8311] [--dir <scratch dir>] [--out qa/after]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const CHROME = process.env.CHROME_PATH || undefined; // unset: Playwright's own Chromium
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const PORT = Number(arg('port', 8311));
const OUT = path.resolve(ROOT, arg('out', 'qa/after'));
const DIR = fs.mkdtempSync(path.join(path.resolve(arg('dir', os.tmpdir())), 'wh-update-qa-'));
const BASE = `http://127.0.0.1:${PORT}`;
const APP = path.join(DIR, 'app');
const STATE = path.join(DIR, 'data', 'state.json');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.dirname(STATE), { recursive: true });

const EDITOR = '.w-editor:not([hidden]):not(.w-editor-notes) .cm-content';
const NOTICE = 'Writehaven was updated. Reload when you reach a pause.';
const problems = [];
const t0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const check = (ok, msg) => {
  if (!ok) problems.push(msg);
  say(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  return ok;
};
async function step(label, fn, ms = 90_000) {
  say(`start ${label}`);
  let timer;
  try {
    await Promise.race([fn(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`no progress in ${ms / 1000} s`)), ms); })]);
  } catch (e) {
    problems.push(`${label}: ${e.message}`);
    say(`FAIL ${label}: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- the server (a child process)
for (const part of ['server.js', 'package.json', 'lib', 'public']) fs.cpSync(path.join(ROOT, part), path.join(APP, part), { recursive: true });
let server = null;
const serverLog = [];
process.on('exit', () => {
  if (server && server.exitCode === null) server.kill('SIGKILL'); // never left running
});
process.on('unhandledRejection', (e) => problems.push(`unhandled: ${e?.message || e}`));
async function startServer() {
  const answers = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false);
  if (answers) throw new Error(`something already answers on port ${PORT}`);
  const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', WH_STATE_FILE: STATE, WH_FSYNC: '0' };
  for (const k of ['WH_SETUP_TOKEN', 'WH_ADMIN_USERS', 'WH_PUBLIC_URL']) delete env[k];
  server = spawn(process.execPath, ['server.js'], { cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => serverLog.push(String(d)));
  server.stderr.on('data', (d) => serverLog.push(String(d)));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch { /* not yet */ }
    await sleep(100);
  }
  throw new Error(`the server didn't start:\n${serverLog.join('')}`);
}
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const done = new Promise((r) => server.once('exit', r));
  server.kill('SIGTERM'); // saves and exits (server.js main)
  await Promise.race([done, sleep(5000)]);
  if (server.exitCode === null) server.kill('SIGKILL');
}
const buildNow = async () => (await (await fetch(`${BASE}/api/build`)).json()).build;

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
    const m = /wh_sess=([^;]*)/.exec(r.headers.get('set-cookie') || '');
    if (m) this.cookie = `wh_sess=${m[1]}`;
    const json = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`${p}: ${r.status} ${JSON.stringify(json)}`);
    return json;
  }
  get token() {
    return this.cookie.replace(/^wh_sess=/, '');
  }
}

// ---------------------------------------------------------------- page helpers
async function bodyText(page) {
  return page.evaluate(async () => {
    const { EditorView } = await import('/vendor/cm.js');
    const host = [...document.querySelectorAll('.w-editor:not(.w-editor-notes)')].find((x) => !x.hidden);
    const ed = host && host.querySelector('.cm-editor');
    const v = ed && EditorView.findFromDOM(ed);
    return v ? v.state.doc.toString() : null;
  });
}
const pageBuild = (page) => page.evaluate(() => (/[?&]v=([\w-]+)/.exec(document.querySelector('script[src*="/js/app.js"]')?.getAttribute('src') || '') || [])[1] || null);
async function serverText(c) {
  const { posts } = await c.req('/api/posts');
  return posts[0] ? (await c.req(`/api/post?id=${encodeURIComponent(posts[0].id)}&pane=body`)).text : null;
}
async function shot(page, name) {
  const file = path.join(OUT, `update-${name}.png`);
  await page.screenshot({ path: file });
  say(`screenshot ${path.relative(ROOT, file)}`);
}
// Where the notice sits: in the flow, under the writer's header and above the editor.
const layout = (page) => page.evaluate(() => {
  const r = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { top: b.top, bottom: b.bottom, height: b.height };
  };
  const note = document.querySelector('.up-note');
  // Nothing on top of Reload (notify.js's floating banner, say): the button itself is hit.
  const btn = note?.querySelector('button');
  const bb = btn?.getBoundingClientRect();
  const hit = bb ? document.elementFromPoint(bb.left + bb.width / 2, bb.top + bb.height / 2) : null;
  return {
    note: r('.up-note'),
    reachable: !!btn && (hit === btn || btn.contains(hit)),
    ntBanner: r('.nt-banner.is-in'),
    text: note?.querySelector('.up-note-t')?.textContent || null,
    button: note?.querySelector('button')?.textContent || null,
    top: r('.w-top'), main: r('.w-main'), foot: r('.w-foot'), hostApp: r('.h-app'),
    inGrid: !!note && note.parentElement?.classList.contains('w-app') && note.parentElement.classList.contains('has-up-note'),
    beforeApp: !!note && note.nextElementSibling === document.getElementById('app'),
    focusInEditor: !!document.activeElement?.closest?.('.cm-content'),
    focusInNote: !!note && note.contains(document.activeElement),
    viewport: innerHeight,
  };
});

let browser;
try {
  say('server on build A');
  await startServer();
  const host = new Client();
  const ana = new Client();
  const ben = new Client();
  const cleo = new Client(); // still waiting for approval when the deploy happens
  let cleoId = null;
  await step('accounts, party started', async () => {
    // (With emails: the one-time "Add your email" toast is another matter.)
    await host.req('/api/register', { username: 'host', name: 'Robin', email: 'host@example.com', password: 'party-password' }); // the first account is the host
    for (const [c, u, n] of [[ana, 'ana', 'Ana Ilić'], [ben, 'ben', 'Ben Okafor'], [cleo, 'cleo', 'Cleo Marsh']]) {
      const r = await c.req('/api/register', { username: u, name: n, email: `${u}@example.com`, password: 'party-password' });
      if (c === cleo) {
        cleoId = r.user.id;
        check(r.user.approval === 'pending', 'cleo waits for approval');
        continue;
      }
      if (r.user?.approval === 'pending') await host.req('/api/admin/approve', { id: r.user.id });
      await c.req('/api/join', {});
    }
    await host.req('/api/admin/start', {});
  });
  const buildA = await buildNow();
  check(/^[0-9a-f]{10}$/.test(buildA), `build A: ${buildA}`);

  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const ctx = async (c, opts) => {
    const x = await browser.newContext(opts);
    if (c) await x.addCookies([{ name: 'wh_sess', value: c.token, url: BASE }]);
    return x;
  };
  const desk = { viewport: { width: 1280, height: 860 } };
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' };
  const pages = {
    ana: await (await ctx(ana, desk)).newPage(),
    ben: await (await ctx(ben, phone)).newPage(),
    cleo: await (await ctx(cleo, desk)).newPage(),
    host: await (await ctx(host, { viewport: { width: 1440, height: 900 } })).newPage(),
    wall: await (await ctx(null, { viewport: { width: 1600, height: 900 } })).newPage(),
  };
  for (const [k, p] of Object.entries(pages)) {
    p.on('pageerror', (e) => problems.push(`${k}: page error: ${e.message}`));
    p.on('dialog', (d) => d.accept().catch(() => {}));
  }
  const first = 'Before the deploy, these words were typed and saved.';
  await step('pages open on build A', async () => {
    await pages.ana.goto(`${BASE}/write`);
    await pages.ana.waitForSelector(EDITOR);
    await pages.ana.click(EDITOR);
    await pages.ana.keyboard.type(first, { delay: 15 });
    await pages.ben.goto(`${BASE}/write`);
    await pages.ben.waitForSelector(EDITOR);
    await pages.cleo.goto(`${BASE}/write`);
    await pages.cleo.waitForSelector('.ap-card');
    await pages.host.goto(`${BASE}/host`);
    await pages.host.waitForSelector('.h-app');
    await pages.wall.goto(`${BASE}/live?wall`);
    await pages.wall.waitForSelector('.pj');
    await pages.wall.evaluate(() => { window.qaMark = 'A'; });
    for (let i = 0; i < 50 && (await serverText(ana)) !== first; i++) await sleep(200);
    check((await serverText(ana)) === first, 'the writer’s first words are on the server');
    for (const [k, p] of Object.entries(pages)) check((await pageBuild(p)) === buildA, `${k} runs build A`);
    check(!(await pages.ana.$('.up-note')), 'no notice before the deploy');
  });

  await step('deploy: a file changes and the server restarts', async () => {
    fs.appendFileSync(path.join(APP, 'public', 'css', 'print.css'), '\n/* deployed */\n');
    await stopServer();
    await sleep(1500); // a restart takes a moment: the streams drop and retry
    await startServer();
  });
  const buildB = await buildNow();
  check(buildB && buildB !== buildA, `build B: ${buildB} (was ${buildA})`);

  await step('the writer’s page shows the notice, in its flow, focus untouched', async () => {
    await pages.ana.waitForSelector('.up-note', { timeout: 45_000 });
    await sleep(400);
    const l = await layout(pages.ana);
    check(`${l.text}` === NOTICE, `notice text: “${l.text}”`);
    check(l.button === 'Reload', `button: ${l.button}`);
    check(l.inGrid, 'a grid row of the writer’s page (.w-app.has-up-note)');
    check(l.note && l.top && l.note.top >= l.top.bottom - 0.5, 'under the header');
    check(l.note && l.main && l.main.top >= l.note.bottom - 0.5, 'the editor starts below it: nothing covered');
    check(l.foot && l.foot.bottom <= l.viewport + 0.5, 'the footer still fits on the screen');
    check(l.focusInEditor && !l.focusInNote, 'the focus stayed in the editor');
    check(l.reachable, 'nothing covers Reload');
    if (l.ntBanner) check(l.ntBanner.top >= l.note.bottom - 0.5, 'notify.js’s banner ("You’re approved") moved below the notice');
    check((await pageBuild(pages.ana)) === buildA, 'it did not reload by itself');
    await shot(pages.ana, 'writer-desktop');
  });

  await step('the phone writer’s page and the host’s page show it too', async () => {
    await pages.ben.waitForSelector('.up-note', { timeout: 45_000 });
    const lb = await layout(pages.ben);
    check(lb.inGrid && lb.main && lb.note && lb.main.top >= lb.note.bottom - 0.5, 'phone: in the grid, above the editor');
    check(lb.foot && lb.foot.bottom <= lb.viewport + 0.5, 'phone: the footer still fits');
    check(lb.reachable, 'phone: nothing covers Reload');
    await shot(pages.ben, 'writer-phone');
    await pages.host.waitForSelector('.up-note', { timeout: 45_000 });
    const lh = await layout(pages.host);
    check(lh.text === NOTICE && lh.beforeApp, 'host: the notice sits above the dashboard');
    check(lh.reachable, 'host: nothing covers Reload');
    check(lh.hostApp && lh.note && lh.hostApp.top >= lh.note.bottom - 0.5, 'host: the dashboard starts below it');
    check((await pageBuild(pages.host)) === buildA, 'host: no reload by itself');
    await shot(pages.host, 'host');
  });

  await step('waiting for approval: the notice is above the card, then follows into the writer’s page', async () => {
    const p = pages.cleo;
    await p.waitForSelector('.up-note', { timeout: 45_000 });
    const before = await layout(p);
    check(before.beforeApp && before.text === NOTICE && before.reachable, 'approval card: the notice sits above it');
    await host.req('/api/admin/approve', { id: cleoId });
    await p.waitForSelector('.w-app > .up-note', { timeout: 20_000 });
    await p.waitForSelector(EDITOR, { timeout: 20_000 });
    const after = await layout(p);
    check(after.inGrid && after.main && after.main.top >= after.note.bottom - 0.5, 'approved: the notice moved into the writer’s page, above the editor');
    check(await p.evaluate(() => document.querySelectorAll('.up-note').length === 1), 'one notice, not two');
    check((await pageBuild(p)) === buildA, 'approval flipped the page in place: still build A, so the notice stays');
    await shot(p, 'approved');
  });

  const second = ' And these, typed just before Reload.';
  await step('Reload straight after typing keeps every word', async () => {
    const p = pages.ana;
    await p.click(EDITOR);
    await p.keyboard.press('Control+End');
    await p.keyboard.type(second, { delay: 5 });
    const queued = await p.evaluate(() => [...(globalThis.__whSyncManagers || [])].reduce((n, m) => n + m.pendingCount(), 0));
    say(`ops still queued when Reload is clicked: ${queued}`);
    let atReload = null;
    p.on('request', (req) => {
      if (req.isNavigationRequest() && req.frame() === p.mainFrame() && atReload === null) atReload = serverText(ana).catch(() => null);
    });
    await Promise.all([p.waitForNavigation({ timeout: 15_000 }), p.click('.up-note-go', { timeout: 5000 })]);
    await p.waitForSelector(EDITOR);
    const want = first + second;
    check((await atReload) === want, 'the server had every word when the page reloaded (the queue was sent first)');
    let text = null;
    for (let i = 0; i < 25 && (text = await bodyText(p)) !== want; i++) await sleep(200);
    check(text === want, `after the reload the editor has every word: “${text}”`);
    let saved = null;
    for (let i = 0; i < 25 && (saved = await serverText(ana)) !== want; i++) await sleep(200);
    check(saved === want, 'and so does the server');
    check((await pageBuild(p)) === buildB, 'the page is on build B now');
    await sleep(1500);
    check(!(await p.$('.up-note')), 'no notice after the reload');
  });

  await step('the projector reloads by itself, once, and stays a projector', async () => {
    const p = pages.wall;
    let mark = 'A';
    for (let i = 0; i < 150 && mark === 'A'; i++) {
      await sleep(300);
      mark = await p.evaluate(() => window.qaMark ?? null).catch(() => 'A'); // mid-navigation: try again
    }
    check(mark !== 'A', 'the projector reloaded by itself');
    await p.waitForSelector('.pj', { timeout: 15_000 });
    check(new URL(p.url()).search === '?wall', `same address: ${p.url()}`);
    check(await p.evaluate(() => document.body.classList.contains('is-projector')), 'still the projector view');
    check((await pageBuild(p)) === buildB, 'the projector is on build B now');
    await p.evaluate(() => { window.qaMark = 'B'; });
    await sleep(8000);
    check((await p.evaluate(() => window.qaMark ?? null).catch(() => null)) === 'B', 'no second reload');
    await shot(p, 'projector-after');
  }, 120_000);
} catch (e) {
  problems.push(`run: ${e.stack || e.message}`);
} finally {
  await browser?.close().catch(() => {});
  await stopServer();
}

if (problems.length) {
  console.log(`\n${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  const errs = serverLog.join('').split('\n').filter((l) => /error|uncaught|unhandled/i.test(l));
  if (errs.length) console.log(`server log:\n${errs.slice(-20).join('\n')}`);
} else console.log('\nall checks passed');
fs.rmSync(DIR, { recursive: true, force: true });
process.exit(problems.length ? 1 : 0);
