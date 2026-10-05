// Shared test helpers (not a test file itself).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Party } from '../lib/party.js';
import { createApp } from '../server.js';
import { T0 } from './sim.js';

export function makeClock(start = T0) {
  let t = start;
  return {
    now: () => t,
    advance(ms) { t += ms; return t; },
    set(v) { t = v; return t; },
  };
}

export const quietLog = { error() {}, log() {}, warn() {} };

// Account approval (SPEC §15) is off in tests unless a test turns it on.
export function makeParty({ clock = makeClock(), settings = {} } = {}) {
  const party = new Party({ now: clock.now, log: quietLog, recomputeMinMs: 0, tz: 'UTC' }); // tests read clocks in UTC
  Object.assign(party.state.settings.scoring, { approvalRequired: false, hoursMode: 'personal' }, settings);
  party.rebuildEngine({ sync: true }); // the engine and party.S take the test's settings
  return { party, clock };
}

export function addUser(party, username, name = username.toUpperCase()) {
  return party.register(party.validateRegistration({ username, password: 'secret-pass', name }), 'scrypt$fake');
}

// Type text into a post through applyOps, one op per char, `cps` chars/second of server time.
export function typeInto(party, clock, user, post, text, { pane = 'body', cps = 5, perBatch = 5 } = {}) {
  let pending = [];
  const flush = () => {
    if (!pending.length) return;
    const p = party.state.posts[post.id];
    party.applyOps(user.id, { postId: post.id, pane, baseVersion: p.ver[pane], seq: Math.random().toString(36).slice(2), ops: pending });
    pending = [];
  };
  let len = party.state.posts[post.id][pane].length + 0;
  for (const ch of text) {
    pending.push({ pos: len, del: 0, ins: ch });
    len += ch.length;
    if (pending.length >= perBatch) flush();
    clock.advance(1000 / cps);
  }
  flush();
}

export function pasteInto(party, user, post, text, mask, { pane = 'body', d = 'yes' } = {}) {
  const p = party.state.posts[post.id];
  const n = (text.match(/\S+/g) || []).length;
  const m = mask === 'all' ? '1'.repeat(n) : mask === 'none' ? '0'.repeat(n) : mask;
  return party.applyOps(user.id, { postId: post.id, pane, baseVersion: p.ver[pane], ops: [{ pos: p[pane].length, del: 0, ins: text, paste: { m, d } }] });
}

const tmpDirs = [];
process.on('exit', () => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});
export function tmpStateFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-test-'));
  tmpDirs.push(dir);
  return path.join(dir, 'state.json');
}

// A running app on an ephemeral port plus a tiny cookie-aware client.
export async function startApp(opts = {}) {
  const stateFile = opts.stateFile || tmpStateFile();
  const { approvalRequired = false, ...rest } = opts;
  const app = createApp({ stateFile, log: quietLog, liveMs: 100, tickMs: 200, recomputeMinMs: 0, testKnobs: true, tz: 'UTC', ...rest });
  if (!opts.stateFile || !approvalRequired) {
    app.party.state.settings.scoring.approvalRequired = approvalRequired;
    app.party.S.approvalRequired = approvalRequired;
  }
  // Hours start at the first editor open in tests (synced hours have tests of their own).
  if (!opts.stateFile && opts.hoursMode !== 'synced') {
    app.party.state.settings.scoring.hoursMode = 'personal';
    app.party.rebuildEngine({ sync: true });
  }
  const addr = await app.start(0);
  const base = `http://127.0.0.1:${addr.port}`;
  return { app, base, stateFile, close: () => app.stop() };
}

export function client(base) {
  let cookie = '';
  async function req(method, p, body, { headers = {}, raw = false } = {}) {
    const h = { ...headers };
    if (cookie) h.Cookie = cookie;
    if (body !== undefined) {
      h['Content-Type'] = 'application/json';
      if (h['X-WH'] === undefined) h['X-WH'] = '1';
    }
    const res = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie');
    if (sc) {
      const m = /wh_sess=([^;]*)/.exec(sc);
      if (m) cookie = m[1] ? `wh_sess=${m[1]}` : '';
    }
    if (raw) return res;
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  return {
    get: (p, o) => req('GET', p, undefined, o),
    post: (p, b = {}, o) => req('POST', p, b, o),
    get cookie() { return cookie; },
  };
}

// Read an SSE stream for `ms` milliseconds; returns [{event, data}].
export async function readSse(url, { ms = 600, cookie = '', until = null } = {}) {
  const ctrl = new AbortController();
  const res = await fetch(url, { headers: cookie ? { Cookie: cookie } : {}, signal: ctrl.signal });
  const events = [];
  let buf = '';
  const dec = new TextDecoder();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(block);
        const data = /^data: (.*)$/m.exec(block);
        if (ev && data) events.push({ event: ev[1], data: JSON.parse(data[1]), raw: block });
      }
      if (until && until(events)) ctrl.abort();
    }
  } catch { /* aborted */ }
  clearTimeout(timer);
  return events;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
