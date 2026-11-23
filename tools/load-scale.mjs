#!/usr/bin/env node
// Scale check: many writers typing at full speed (some phones that drop off and replay their
// queue, some pastes), hundreds of public readers on the live stream, viewers polling post
// pages, the projector, and hosts polling the dashboard, for many minutes, with a settings
// re-score in the middle. Reports op round-trip latency, how long new words take to reach a
// reader, the server's event-loop delay, CPU and memory, every interval and overall.
//
// Usage: node tools/load-scale.mjs [--port 8147] [--writers 60] [--readers 500] [--pollers 25]
//        [--projectors 25] [--hosts 2] [--minutes 20] [--rescore-at 10] [--interval 30]
// Prints one JSON line per interval and a summary at the end. Everything runs against a
// fresh server on a temporary state file, removed afterwards.

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? Number(process.argv[i + 1]) : d;
};
const PORT = arg('port', 8147);
const WRITERS = arg('writers', 60);
const READERS = arg('readers', 500);
const POLLERS = arg('pollers', 25);
const PROJECTORS = arg('projectors', 25);
const HOSTS = arg('hosts', 2);
const MINUTES = arg('minutes', 20);
const RESCORE_AT = arg('rescore-at', MINUTES / 2);
const INTERVAL_S = arg('interval', 30);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-scale-'));
const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', WH_PROXY: 'cloudflare', WH_STATE_FILE: path.join(stateDir, 'state.json') }, // CF-Connecting-IP gives each client its address
  stdio: ['ignore', 'ignore', 'pipe'],
});
let serverErr = '';
server.stderr.on('data', (d) => { serverErr = (serverErr + d).slice(-4000); });

// ---------------------------------------------------------------- http helpers
const agent = new http.Agent({ keepAlive: true, maxSockets: 512 });
function request(method, p, { body, headers = {}, cookie } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const h = { ...headers };
    if (cookie) h.Cookie = cookie;
    if (data) Object.assign(h, { 'Content-Type': 'application/json', 'X-WH': '1', 'Content-Length': data.length });
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: h, agent }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, json, headers: res.headers, setCookie: res.headers['set-cookie'] });
      });
      res.on('error', () => resolve({ status: 0 }));
    });
    req.on('error', () => resolve({ status: 0 }));
    req.setTimeout(30_000, () => req.destroy());
    if (data) req.write(data);
    req.end();
  });
}
const cookieOf = (r) => {
  const sc = (r.setCookie || []).find((x) => x.startsWith('wh_sess='));
  return sc ? sc.split(';')[0] : null;
};
// A long-lived event stream; onChunk(text) for probes, byte counting for everyone.
function openStream(p, { headers = {}, cookie, onChunk = null } = {}) {
  const st = { bytes: 0, status: null, open: false, req: null, closed: false };
  const h = { ...headers, Accept: 'text/event-stream' };
  if (cookie) h.Cookie = cookie;
  st.req = http.request({ host: '127.0.0.1', port: PORT, method: 'GET', path: p, headers: h, agent: false }, (res) => {
    st.status = res.statusCode;
    st.open = res.statusCode === 200;
    res.on('data', (c) => {
      st.bytes += c.length;
      if (onChunk) onChunk(c.toString('utf8'));
    });
    res.on('end', () => { st.open = false; });
    res.on('error', () => { st.open = false; });
  });
  st.req.on('error', () => { st.open = false; });
  st.req.end();
  st.close = () => {
    st.closed = true;
    st.req.destroy();
  };
  return st;
}

// ---------------------------------------------------------------- metrics
const lat = []; // op round trips (ms), current interval
const allLat = [];
const delays = []; // stream delays (ms), current interval
const allDelays = [];
const errors = { ops: 0, other: 0, codes: {} };
const q = (a, p) => {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10;
};
function cpuTicks(pid) {
  try {
    const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    return Number(f[11]) + Number(f[12]);
  } catch {
    return 0;
  }
}
function rssMB(pid) {
  try {
    const m = /VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m ? Math.round(Number(m[1]) / 102.4) / 10 : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- text
const C = 'bcdfghklmnprstvwz';
const V = 'aeiou';
let seed = 12345;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const word = () => {
  let w = '';
  const syl = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < syl; i++) w += C[Math.floor(rnd() * C.length)] + V[Math.floor(rnd() * V.length)];
  return w;
};
const FN = ['the', 'and', 'of', 'to', 'a', 'in', 'was', 'it', 'that', 'with'];
const sentence = () => {
  const n = 6 + Math.floor(rnd() * 10);
  const ws = [];
  for (let i = 0; i < n; i++) ws.push(rnd() < 0.35 ? FN[Math.floor(rnd() * FN.length)] : word());
  return `${ws.join(' ')}. `;
};

// ---------------------------------------------------------------- actors
const venue = { 'CF-Connecting-IP': '192.0.2.50' };
let markerN = 0;
const markers = new Map(); // marker -> sent time

class Writer {
  constructor(i) {
    this.i = i;
    this.phone = i % 6 === 5; // every sixth writer is on a phone (word ops, drops off)
    this.ver = 0;
    this.len = 0;
    this.queue = []; // offline ops
    this.offlineUntil = 0;
    this.nextDrop = now() + 60_000 + rnd() * 180_000;
    this.nextPaste = now() + 60_000 + rnd() * 240_000;
    this.buf = '';
    this.seq = 0;
  }
  async setup() {
    const r = await request('POST', '/api/register', { body: { username: `w${this.i}`, password: 'secret-pass', name: `Writer ${this.i}` }, headers: venue });
    this.cookie = cookieOf(r);
    await request('POST', '/api/join', { body: {}, cookie: this.cookie, headers: venue });
    const p = await request('POST', '/api/post/new', { body: { title: `Piece ${this.i}` }, cookie: this.cookie, headers: venue });
    this.post = p.json.post.id;
    this.me = openStream('/api/me/events', { cookie: this.cookie, headers: venue });
  }
  // About 1 s of typing at full speed: ~9 characters (~105 wpm), or 2 words for a phone.
  nextOps(t) {
    const ops = [];
    if (this.buf.length < 40) this.buf += sentence();
    if (this.phone) {
      for (let k = 0; k < 2; k++) {
        const sp = this.buf.indexOf(' ') + 1 || this.buf.length;
        const w = this.buf.slice(0, sp);
        this.buf = this.buf.slice(sp);
        ops.push({ at: t - 500 + k * 400, pos: this.len, del: 0, ins: w, source: rnd() < 0.2 ? 'autocorrect' : 'ime' });
        this.len += w.length;
      }
    } else {
      const n = 8 + Math.floor(rnd() * 3);
      for (let k = 0; k < n; k++) {
        const ch = this.buf[0];
        this.buf = this.buf.slice(1);
        ops.push({ at: t - 1000 + Math.round((k * 1000) / n), pos: this.len, del: 0, ins: ch });
        this.len += 1;
      }
    }
    return ops;
  }
  async send(ops, sentAt, marker = null) {
    const seq = `s${this.i}-${++this.seq}`;
    const t0 = performance.now();
    const r = await request('POST', '/api/ops', { body: { postId: this.post, pane: 'body', baseVersion: this.ver, seq, sentAt, ops }, cookie: this.cookie, headers: venue });
    const ms = performance.now() - t0;
    if (r.status === 200) {
      this.ver = r.json.version;
      lat.push(ms);
      allLat.push(ms);
      if (marker) markers.set(marker, now());
    } else {
      errors.ops++;
      errors.codes[r.status] = (errors.codes[r.status] || 0) + 1;
      if (r.status === 409 && r.json && r.json.code === 'conflict') {
        this.ver = r.json.version;
        this.len = r.json.text.length;
      }
    }
  }
  async step() {
    const t = now();
    if (this.phone && !this.offlineUntil && t > this.nextDrop) {
      this.offlineUntil = t + 30_000 + rnd() * 30_000; // the phone drops off for 30-60 s
      this.me.close();
    }
    if (this.offlineUntil) {
      this.queue.push(...this.nextOps(t));
      if (t < this.offlineUntil) return;
      // Back online: the stream again, then the queue with its original timing.
      this.offlineUntil = 0;
      this.nextDrop = t + 120_000 + rnd() * 120_000;
      this.me = openStream('/api/me/events', { cookie: this.cookie, headers: venue });
      const queued = this.queue;
      this.queue = [];
      await this.send(queued, now());
      return;
    }
    if (t > this.nextPaste) {
      this.nextPaste = t + 180_000 + rnd() * 240_000;
      let text = '';
      while (text.split(' ').length < 60) text += sentence();
      const n = (text.match(/\S+/g) || []).length;
      const op = { at: t, pos: this.len, del: 0, ins: text, paste: { m: '1'.repeat(n), d: 'yes' } };
      this.len += text.length;
      await this.send([op], now());
      return;
    }
    const ops = this.nextOps(t);
    let marker = null;
    if (this.i === 0 && rnd() < 0.3) {
      // A marker word the probe readers watch for: how long until readers see new words.
      marker = `zqx${(++markerN).toString(36)}q`;
      ops.push({ at: t, pos: this.len, del: 0, ins: ` ${marker} ` });
      this.len += marker.length + 2;
    }
    await this.send(ops, now(), marker);
  }
}

async function main() {
  for (let i = 0; i < 100; i++) {
    const r = await request('GET', '/healthz');
    if (r.status === 200) break;
    await sleep(100);
  }
  // Hosts sign in from the venue (so the venue's address gets the venue limits).
  const hosts = [];
  const h0 = await request('POST', '/api/register', { body: { username: 'host', password: 'secret-pass', name: 'Host' }, headers: venue });
  hosts.push(cookieOf(h0));
  for (let i = 1; i < HOSTS; i++) {
    const r = await request('POST', '/api/login', { body: { username: 'host', password: 'secret-pass' }, headers: venue });
    hosts.push(cookieOf(r));
  }
  await request('POST', '/api/admin/start', { body: {}, cookie: hosts[0], headers: venue });
  await request('POST', '/api/admin/settings', { body: { scoring: { approvalRequired: false, hoursMode: 'personal' } }, cookie: hosts[0], headers: venue }); // writers write at once
  const writers = [];
  for (let i = 0; i < WRITERS; i++) {
    const w = new Writer(i);
    await w.setup();
    writers.push(w);
  }
  // Public readers, each from its own address; the first 10 watch for marker words.
  const readers = [];
  let refused = 0;
  const probe = (text) => {
    const m = text.match(/zqx[0-9a-z]+q/g);
    if (!m) return;
    const t = now();
    for (const k of m) {
      const sent = markers.get(k);
      if (sent !== undefined && !probe.seen.has(k)) {
        probe.seen.add(k);
        const d = Math.max(0, t - sent);
        delays.push(d);
        allDelays.push(d);
      }
    }
  };
  probe.seen = new Set();
  const ip = (i) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
  for (let i = 0; i < READERS + PROJECTORS; i++) {
    readers.push(openStream('/api/live/events', { headers: { 'CF-Connecting-IP': ip(i + 1) }, onChunk: i < 10 ? probe : null }));
    if (i % 50 === 49) await sleep(50);
  }
  await sleep(2000);
  refused = readers.filter((r) => r.status === 429).length;

  const t0 = now();
  const end = t0 + MINUTES * 60_000;
  let rescore = null;
  const cpu0 = cpuTicks(server.pid);
  let lastCpu = cpu0;
  let lastAt = now();
  const intervals = [];
  await request('GET', '/api/admin/diag?reset=1', { cookie: hosts[0], headers: venue });
  // Writers: every ~1 s each.
  const loops = writers.map(async (w, i) => {
    await sleep((i * 1000) / WRITERS);
    while (now() < end) {
      const s0 = now();
      await w.step();
      await sleep(Math.max(0, 1000 - (now() - s0)));
    }
  });
  // Post-page viewers: every 5 s, a random public post.
  let publicIds = [];
  const viewerLoops = Array.from({ length: POLLERS }, async (_, i) => {
    await sleep(i * 200);
    while (now() < end) {
      if (!publicIds.length || rnd() < 0.05) {
        const l = await request('GET', '/api/live', { headers: { 'Accept-Encoding': 'gzip', 'CF-Connecting-IP': ip(5000 + i) } });
        if (l.status === 200 && l.json) publicIds = l.json.posts.map((p) => p.id);
      }
      if (publicIds.length) {
        const r = await request('GET', `/api/p/${publicIds[Math.floor(rnd() * publicIds.length)]}`, { headers: { 'Accept-Encoding': 'gzip', 'CF-Connecting-IP': ip(5000 + i) } });
        if (r.status !== 200) { errors.other++; errors.codes[`p${r.status}`] = (errors.codes[`p${r.status}`] || 0) + 1; }
      }
      await sleep(5000);
    }
  });
  // Hosts: the dashboard every 2 s; one re-score in the middle.
  const hostLoops = hosts.map(async (cookie, i) => {
    await sleep(i * 1000);
    while (now() < end) {
      const r = await request('GET', '/api/admin/state', { cookie, headers: venue });
      if (r.status !== 200) { errors.other++; errors.codes[`h${r.status}`] = (errors.codes[`h${r.status}`] || 0) + 1; }
      if (i === 0 && !rescore && now() - t0 > RESCORE_AT * 60_000) {
        rescore = { startedAt: now() };
        const s = await request('POST', '/api/admin/settings', { body: { scoring: { targetPerHour: 401 } }, cookie, headers: venue });
        rescore.requestMs = now() - rescore.startedAt;
        rescore.status = s.status;
      }
      if (rescore && !rescore.doneMs && r.json && r.json.rescoring === false && now() - rescore.startedAt > 700) rescore.doneMs = now() - rescore.startedAt;
      await sleep(2000);
    }
  });
  // Sampler.
  const sampler = (async () => {
    while (now() < end) {
      await sleep(INTERVAL_S * 1000);
      const d = await request('GET', '/api/admin/diag?reset=1', { cookie: hosts[0], headers: venue });
      const c = cpuTicks(server.pid);
      const t = now();
      const row = {
        minute: Math.round(((t - t0) / 60_000) * 10) / 10,
        batches: lat.length,
        opMs: { p50: q(lat, 0.5), p95: q(lat, 0.95), p99: q(lat, 0.99), max: q(lat, 1) },
        streamDelayMs: { n: delays.length, p50: q(delays, 0.5), p95: q(delays, 0.95), max: q(delays, 1) },
        eventLoopMs: d.json ? d.json.eventLoopMs : null,
        cpuPercent: Math.round(((c - lastCpu) / 100 / ((t - lastAt) / 1000)) * 100),
        rssMB: rssMB(server.pid),
        heapMB: d.json ? d.json.heapUsedMB : null,
        ops: d.json ? d.json.ops : null,
        streams: d.json ? d.json.streams : null,
        readersOpen: readers.filter((r) => r.open).length,
        rescoring: d.json ? d.json.rescoring : null,
        errors: { ...errors, codes: { ...errors.codes } },
      };
      lastCpu = c;
      lastAt = t;
      lat.length = 0;
      delays.length = 0;
      intervals.push(row);
      console.log(JSON.stringify(row));
    }
  })();
  await Promise.all([...loops, ...viewerLoops, ...hostLoops, sampler]);
  const secs = (now() - t0) / 1000;
  const loopMax = Math.max(...intervals.map((r) => (r.eventLoopMs ? r.eventLoopMs.max : 0)));
  const summary = {
    writers: WRITERS, readers: READERS, projectors: PROJECTORS, pollers: POLLERS, hosts: HOSTS, minutes: Math.round(secs / 6) / 10,
    readersRefused: refused,
    batches: allLat.length,
    opMs: { p50: q(allLat, 0.5), p95: q(allLat, 0.95), p99: q(allLat, 0.99), max: q(allLat, 1) },
    streamDelayMs: { n: allDelays.length, p50: q(allDelays, 0.5), p95: q(allDelays, 0.95), p99: q(allDelays, 0.99), max: q(allDelays, 1) },
    eventLoopMaxMs: loopMax,
    cpuPercentAvg: Math.round(((cpuTicks(server.pid) - cpu0) / 100 / secs) * 100),
    rssMB: { first: intervals[0] ? intervals[0].rssMB : null, last: intervals.length ? intervals[intervals.length - 1].rssMB : null, max: Math.max(...intervals.map((r) => r.rssMB || 0)) },
    finalOps: intervals.length ? intervals[intervals.length - 1].ops : null,
    rescore,
    errors,
  };
  console.log(`SUMMARY ${JSON.stringify(summary)}`);
  for (const r of readers) r.close();
  for (const w of writers) w.me.close();
}

try {
  await main();
} catch (e) {
  console.error('load-scale failed:', e);
  console.error(serverErr);
} finally {
  server.kill('SIGTERM');
  await sleep(2500);
  try { server.kill('SIGKILL'); } catch { /* gone */ }
  agent.destroy();
  fs.rmSync(stateDir, { recursive: true, force: true });
}
