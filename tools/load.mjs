#!/usr/bin/env node
// Load check: N writers with long histories typing at once (batches every second),
// their own event streams, plus public viewers. Reports op latency and server CPU.
// A settings change then re-scores everyone (in the background): reports how long the request
// took, when the new numbers were in, and the longest /healthz stall meanwhile.
// Usage: node tools/load.mjs [--port 8113] [--writers 20] [--viewers 40] [--seconds 60] [--history 15000]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? Number(process.argv[i + 1]) : d;
};
const PORT = arg('port', 8113);
const WRITERS = arg('writers', 20);
const VIEWERS = arg('viewers', 40);
const SECONDS = arg('seconds', 60);
const HISTORY = arg('history', 15000);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-load-'));
const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), WH_STATE_FILE: path.join(stateDir, 'state.json') }, stdio: ['ignore', 'ignore', 'inherit'] });

function client() {
  let cookie = '';
  return async (p, body) => {
    const r = await fetch(BASE + p, {
      method: body ? 'POST' : 'GET',
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json', 'X-WH': '1' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`${p} ${r.status} ${JSON.stringify(j)}`);
    return j;
  };
}
function cpuTicks(pid) {
  const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
  return Number(f[11]) + Number(f[12]);
}
const words = 'the a lighthouse keeper counted every wave twice before supper while gulls argued about the ferry and fog came west over grey water'.split(' ');
const sentence = (i) => {
  let s = '';
  for (let k = 0; k < 12; k++) s += `${words[(i * 7 + k * 13) % words.length]}${(i + k) % 5} `;
  return s;
};

async function main() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* wait */ }
    await sleep(100);
  }
  const host = client();
  await host('/api/register', { username: 'host', password: 'secret-1', name: 'Host' });
  await host('/api/admin/start', {});
  await host('/api/admin/settings', { scoring: { approvalRequired: false, hoursMode: 'personal' } }); // writers sign up and write at once
  const ws = [];
  for (let i = 0; i < WRITERS; i++) {
    const c = client();
    await c('/api/register', { username: `w${i}`, password: 'secret-1', name: `Writer ${i}` });
    await c('/api/join', {});
    const { post } = await c('/api/post/new', { title: `Post ${i}` });
    ws.push({ c, post, ver: 0, len: 0, n: 0 });
  }
  // Build long histories quickly (one op per char, typos included), backdated in the batch.
  console.log(`building ${HISTORY} chars of history for ${WRITERS} writers…`);
  await Promise.all(ws.map(async (w, wi) => {
    let k = 0;
    while (w.len < HISTORY) {
      const ops = [];
      const sentAt = Date.now();
      for (let j = 0; j < 400 && w.len < HISTORY; j++) {
        const s = sentence(wi * 1000 + k++);
        for (const ch of s) { ops.push({ at: sentAt, pos: w.len, del: 0, ins: ch }); w.len++; }
        ops.push({ at: sentAt, pos: w.len, del: 0, ins: 'x' }, { at: sentAt, pos: w.len, del: 1, ins: '' });
        if (ops.length > 1500) break;
      }
      const r = await w.c('/api/ops', { postId: w.post.id, pane: 'body', baseVersion: w.ver, sentAt, ops });
      w.ver = r.version;
    }
  }));
  console.log('history built; letting it settle (words count 90 s after typing)…');
  await sleep(100_000);
  // Streams: writers' own + public viewers.
  const ctrls = [];
  const openStream = async (url, cookie) => {
    const ctrl = new AbortController();
    ctrls.push(ctrl);
    const res = await fetch(url, { headers: cookie ? { Cookie: cookie } : {}, signal: ctrl.signal });
    (async () => { try { for await (const _ of res.body) { /* drain */ } } catch { /* closed */ } })();
  };
  for (let i = 0; i < VIEWERS; i++) await openStream(`${BASE}/api/live/events`);
  const lat = [];
  const t0 = cpuTicks(server.pid);
  const start = Date.now();
  const until = start + SECONDS * 1000;
  await Promise.all(ws.map(async (w, wi) => {
    let k = 0;
    await sleep(Math.random() * 1000);
    while (Date.now() < until) {
      const ops = [];
      const sentAt = Date.now();
      const s = sentence(wi * 77 + k++).slice(0, 8);
      for (const ch of s) { ops.push({ at: sentAt, pos: w.len, del: 0, ins: ch }); w.len++; }
      const t = performance.now();
      const r = await w.c('/api/ops', { postId: w.post.id, pane: 'body', baseVersion: w.ver, sentAt, ops });
      lat.push(performance.now() - t);
      w.ver = r.version;
      if (k % 5 === 0) await w.c('/api/me');
      await sleep(1000);
    }
  }));
  const secs = (Date.now() - start) / 1000;
  const cpu = (cpuTicks(server.pid) - t0) / 100; // clock ticks (USER_HZ = 100)
  lat.sort((a, b) => a - b);
  const q = (p) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))].toFixed(1);
  const hostState = await host('/api/admin/state').then(() => 'ok').catch((e) => e.message);
  // A settings change re-scores everyone from the op log (in the background): probe /healthz
  // until the host view says the new numbers are in.
  let maxStall = 0;
  let probing = true;
  const probe = (async () => {
    while (probing) {
      const t = performance.now();
      await fetch(`${BASE}/healthz`).catch(() => {});
      maxStall = Math.max(maxStall, performance.now() - t);
      await sleep(10);
    }
  })();
  const r0 = performance.now();
  await host('/api/admin/settings', { scoring: { targetPerHour: 301 } });
  const rescoreRequestMs = Math.round(performance.now() - r0);
  while ((await host('/api/admin/state')).rescoring) await sleep(20);
  const rescoreDoneMs = Math.round(performance.now() - r0);
  probing = false;
  await probe;
  console.log(JSON.stringify({
    writers: WRITERS, viewers: VIEWERS, historyChars: HISTORY, seconds: Math.round(secs), batches: lat.length,
    opLatencyMs: { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: lat[lat.length - 1].toFixed(1) },
    serverCpuPercent: Math.round((cpu / secs) * 100),
    stateFileMB: (fs.statSync(path.join(stateDir, 'state.json')).size / 1e6).toFixed(1),
    hostState,
    rescoreRequestMs,
    rescoreDoneMs,
    healthzMaxStallDuringRescoreMs: Math.round(maxStall),
  }, null, 2));
  for (const c of ctrls) c.abort();
}

try {
  await main();
} finally {
  server.kill('SIGTERM');
  await sleep(1500);
  fs.rmSync(stateDir, { recursive: true, force: true });
}
