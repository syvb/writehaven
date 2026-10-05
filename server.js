#!/usr/bin/env node
// Writehaven: a live writing party. HTTP server, static files, JSON API, SSE.
// Zero runtime dependencies (Node 20 built-ins only).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { Worker } from 'node:worker_threads';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Party, HttpError, validatePassword, DEFAULT_TZ } from './lib/party.js';
import { loadState, createSaver, writeStateSync, cleanTempFiles } from './lib/store.js';
import { Journal } from './lib/journal.js';
import { computePreviewChunked } from './lib/preview.js';
import { createUploads } from './lib/uploads.js';
import { createFood } from './lib/food.js';
import { createClientErrors } from './lib/client-errors.js';
import { attachNotify } from './lib/notify.js';
import { attachTabOrder } from './lib/taborder.js';
import { attachAccounts, editRights } from './lib/accounts.js';
import { attachWriters } from './lib/writers.js';
import { createHashGate } from './lib/hashgate.js';
import {
  hashPassword, verifyPassword, newSessionToken, LoginLimiter, parseCookies, sessionCookie,
} from './lib/auth.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BODY_LIMIT = 16 * 1024;
const BIG_BODY_LIMIT = 4 * 1024 * 1024; // op batches (a long offline queue) and paste checks

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.md', '.webmanifest']);

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // CodeMirror injects its own <style> elements
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "media-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "manifest-src 'self'",
].join('; ');

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Frame-Options', 'DENY');
}

function acceptsGzip(req) {
  return /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
}

function sendBody(req, res, status, body, type, extra = {}) {
  if (res.headersSent) return;
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const headers = { 'Content-Type': type, ...extra };
  if (buf.length > 1024 && acceptsGzip(req)) {
    buf = zlib.gzipSync(buf, { level: 6 });
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  }
  headers['Content-Length'] = buf.length;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : buf);
}
function sendJson(req, res, status, obj) {
  sendBody(req, res, status, JSON.stringify(obj), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });
}
function sendText(res, status, text, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) {
      req.resume();
      reject(new HttpError(413, 'Request body too large'));
      return;
    }
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) tooBig = true;
      else chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return reject(new HttpError(413, 'Request body too large'));
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      let v;
      try {
        v = JSON.parse(text);
      } catch {
        return reject(new HttpError(400, 'Invalid JSON'));
      }
      if (v === null || typeof v !== 'object' || Array.isArray(v)) return reject(new HttpError(400, 'Body must be a JSON object'));
      resolve(v);
    });
    req.on('error', reject);
  });
}

// The client's address. Forwarded headers are believed only from loopback (a reverse proxy or
// tunnel on this machine); anyone else could put anything in them.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export function clientIp(req) {
  const peer = req.socket.remoteAddress || '?';
  if (!LOOPBACK.has(peer)) return peer;
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim().slice(0, 64);
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim().slice(0, 64);
  return peer;
}

// Sign-ups per address. A whole room signs up from one address (the venue's Wi-Fi), so
// successful sign-ups are limited only against floods: `max` per `windowMs` (200 from a network
// a host is signed in from). Failed attempts (bad input, taken usernames) are limited more
// tightly: `failMax` per window. The host's "Registration open" switch is the real control.
export class RegLimiter {
  constructor({ max = 60, hostMax = 200, failMax = 30, hostFailMax = 100, windowMs = 10 * 60_000, now = Date.now } = {}) {
    Object.assign(this, { max, hostMax, failMax, hostFailMax, windowMs, now });
    this.hits = new Map(); // ip -> [t...] successful sign-ups
    this.fails = new Map(); // ip -> [t...] failed attempts
    this.hostIps = new Map(); // ip -> last time a host was seen there
  }
  noteHost(ip) {
    this.hostIps.set(ip, this.now());
  }
  isHostNetwork(ip) {
    const h = this.hostIps.get(ip);
    return h !== undefined && this.now() - h < 12 * 3600_000;
  }
  limitFor(ip) {
    return this.isHostNetwork(ip) ? this.hostMax : this.max;
  }
  // Seconds until enough of the `limit` recent events leave the window, or 0.
  wait(map, ip, limit) {
    const t = this.now();
    const list = (map.get(ip) || []).filter((x) => t - x < this.windowMs);
    map.set(ip, list);
    return list.length >= limit ? Math.max(1, Math.ceil((list[list.length - limit] + this.windowMs - t) / 1000)) : 0;
  }
  // Seconds to wait before a sign-up from `ip` is accepted, or 0 (nothing is counted here).
  check(ip) {
    const host = this.isHostNetwork(ip);
    return Math.max(this.wait(this.fails, ip, host ? this.hostFailMax : this.failMax), this.wait(this.hits, ip, host ? this.hostMax : this.max));
  }
  success(ip) {
    (this.hits.get(ip) || this.hits.set(ip, []).get(ip)).push(this.now());
  }
  fail(ip) {
    (this.fails.get(ip) || this.fails.set(ip, []).get(ip)).push(this.now());
  }
  // check() then success() in one go.
  take(ip) {
    const w = this.check(ip);
    if (!w) this.success(ip);
    return w;
  }
  sweep() {
    const t = this.now();
    for (const map of [this.hits, this.fails]) for (const [ip, list] of map) if (!list.some((x) => t - x < this.windowMs)) map.delete(ip);
    for (const [ip, h] of this.hostIps) if (t - h > 12 * 3600_000) this.hostIps.delete(ip);
  }
}
function isHttps(req) {
  const p = req.headers['x-forwarded-proto'];
  return typeof p === 'string' && p.split(',')[0].trim().toLowerCase() === 'https';
}

function journalLegacy(journal, party, uid, ops) {
  for (const o of ops) {
    const p = party.state.posts[o[1]];
    const pane = o[2] === 'n' ? 'notes' : 'body';
    journal.append(uid, [o[1], o[2], p ? p.ver[pane] : 0, [o.length > 6 ? [o[0], o[3], o[4], o[5], o[6]] : [o[0], o[3], o[4], o[5]]]]);
  }
}

// Smallest single splice turning a into b: [from, deleteCount, insert].
export function textDiff(a, b) {
  let p = 0;
  const max = Math.min(a.length, b.length);
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  return [p, a.length - p - s, b.slice(p, b.length - s)];
}

export function createApp({
  stateFile,
  publicDir = path.join(ROOT, 'public'),
  adminUsers = [],
  now = Date.now,
  log = console,
  tickMs = 2000,
  pingMs = 20_000,
  liveMs = 250, // public stream tick: a batch reaches readers within this long...
  // ...while each post updates about once a second at most (SPEC §4: editors send a batch about
  // once a second; a full 1000 ms spacing would beat against that and delay words by up to 1.25 s)
  livePostMinMs = 750,
  liveMetaMinMs = 1000, // order and counters at most once a second
  saveMs = 1000,
  recomputeMinMs = undefined,
  publicUrl = undefined, // env WH_PUBLIC_URL: the join link shown on the projector and host screens
  tz = null, // env WH_TZ: the party clock's time zone (Europe/London when unset)
  testKnobs = false, // env WH_TEST_KNOBS=1: the host may change test-only settings
  hourLengthMin = null, // env WH_HOUR_MIN: compressed hours for QA runs
  regLimits = {}, // { max, hostMax, windowMs }: sign-ups per address (env WH_REG_PER_IP, WH_REG_PER_HOST_IP)
  // Event streams: anonymous live-page ones per address, and live-page ones in all (anonymous ones
  // are refused past either); signed-in ones per session and per person (the oldest closes).
  // env WH_SSE_PER_IP, WH_SSE_PER_SESSION, WH_SSE_MAX.
  sseLimits = {},
  maxConnections = 2000, // env WH_MAX_CONNECTIONS
  fsync = true, // flush each op batch to disk before acking it (env WH_FSYNC=0 turns it off)
  makeWorker = (url, opts) => new Worker(url, opts), // tests simulate a machine out of threads
  fsyncWaitMs = 100, // an op batch's ack waits at most this long for its flush to disk
  writeWaitMs = 10_000, // ...and this long for its journal write (else 503: the client retries)
  routes = [], // extra routes (see extraRoutes below)
  setupToken = null, // env WH_SETUP_TOKEN: the first account (the host) needs it (/register?setup=<token>)
  hashLimits = {}, // { running, queued, perIp, perHostIp }: password hashing at once (lib/hashgate.js)
} = {}) {
  // Streams. Signed-in ones (a writer's own stream, the live page in a signed-in tab) are keyed
  // by session: 4 of each per session, the oldest closes, never refused. Anonymous live streams:
  // 200 per address (the venue's guests and projector share one). Past 2,000 live-page streams in
  // all (signed-in ones count too, but are never refused), new anonymous ones are refused.
  const SSE = { perIp: 200, perSession: 4, perUser: 8, liveMax: 2000, ...sseLimits }; // perUser: signed-in streams of each kind
  // A public reader that falls this far behind gets frames dropped, then one fresh snapshot
  // when its buffer drains (instead of every frame it missed); far behind or for long: dropped.
  const LAG = { high: 512 * 1024, low: 16 * 1024, max: 16 * 1024 * 1024, maxMs: 120_000 };
  const raw = loadState(stateFile, { log });
  cleanTempFiles(stateFile, { log });
  const journal = new Journal(`${stateFile}.ops`, { log, fsync });
  // Made at the first boot, so from then on a writer with no journal file is a writer with no
  // journaled words (a crash before their first line: lib/party.js drops the unacknowledged text).
  const journalFresh = !fs.existsSync(journal.dir);
  fs.mkdirSync(journal.dir, { recursive: true });
  const recs = journal.readAll();
  // A state file from before the journal existed carries its ops inline: keep them.
  const legacy = raw && raw.ops && Object.keys(raw.ops).length && !Object.keys(recs).length;
  const party = new Party({
    state: raw, journal: legacy ? null : recs, journalFresh, now, adminUsers, log, publicUrl, tz, testKnobs, asyncRescore: true,
    overrides: Number.isFinite(hourLengthMin) && hourLengthMin > 0 ? { hourLengthMin } : null,
    ...(recomputeMinMs !== undefined ? { recomputeMinMs } : {}),
  });
  if (legacy) for (const [uid, ops] of Object.entries(party.state.ops)) journalLegacy(journal, party, uid, ops);
  party.onBatch = (uid, rec) => journal.append(uid, rec);
  // Settings previews run in a worker thread that reads the journal itself, one at a time.
  let previewChain = Promise.resolve();
  party.previewer = (job) => {
    const run = () => new Promise((resolve, reject) => {
      const w = makeWorker(new URL('./lib/rescore-worker.js', import.meta.url), { workerData: { ...job, journalDir: `${stateFile}.ops` } });
      const timer = setTimeout(() => {
        w.terminate();
        reject(new HttpError(503, 'The preview took too long'));
      }, 120_000);
      w.once('message', (m) => {
        clearTimeout(timer);
        w.terminate();
        if (m && m.ok) resolve({ changes: m.changes, ms: m.ms });
        else reject(new Error(`preview worker: ${m && m.error}`));
      });
      w.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    // A worker can fail to start when the machine is short of threads (EAGAIN): retry briefly,
    // then compute here, in slices that yield to requests. A thread that can't start is never an error.
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    const attempt = async () => {
      for (const wait of [0, 200, 600]) {
        if (wait) await pause(wait);
        try {
          return await run();
        } catch (e) {
          if (e instanceof HttpError) throw e; // it ran too long: computing again here won't help
          log.error('[preview] worker failed:', e && e.message);
        }
      }
      const t0 = performance.now();
      const changes = await computePreviewChunked({ ...job, opsByUser: party.state.ops });
      return { changes, ms: Math.round(performance.now() - t0), inProcess: true };
    };
    const p = previewChain.then(attempt, attempt);
    previewChain = p.catch(() => {});
    return p;
  };
  const saver = createSaver(stateFile, () => party.snapshot(), { delayMs: saveMs, log });
  const limiter = new LoginLimiter({ now });
  const hashGate = createHashGate(hashLimits); // bounded scrypt work, 503 busy past it
  // A login try is counted before its (slow) check, so parallel guesses can't all get through;
  // one refused as busy is taken back.
  const unreserve = (key) => {
    const l = limiter.fails.get(key);
    if (l) l.pop();
    if (l && !l.length) limiter.fails.delete(key);
  };
  const sameSecret = (given, want) => typeof given === 'string' && given.length > 0
    && crypto.timingSafeEqual(crypto.createHash('sha256').update(given).digest(), crypto.createHash('sha256').update(String(want)).digest());
  const regLimiter = new RegLimiter({ now, ...regLimits });
  const publicRoot = path.resolve(publicDir);
  const timers = [];
  party.onChange = () => saver.schedule();
  if (!raw) saver.schedule();

  // ------------------------------------------------------------- realtime
  const liveClients = new Set(); // public page viewers
  const meClients = new Set(); // writers' own streams
  const pub = { party: null, counters: null, posts: new Map(), order: [], snapshot: null, view: null, json: null, rev: 0, countersAt: 0, orderAt: 0 };
  const liveByIp = new Map(); // address -> open anonymous public streams
  const loopDelay = monitorEventLoopDelay({ resolution: 10 }); // GET /api/admin/diag
  const bootAt = Date.now();
  const enc = (str) => Buffer.from(str, 'utf8');

  // Writers' own streams: small per-writer frames.
  function writeClient(cl, chunk) {
    if (cl.res.destroyed || cl.res.writableEnded) return;
    if (cl.res.writableLength > 4 * 1024 * 1024) {
      cl.res.destroy(); // hopelessly slow client; it will reconnect
      return;
    }
    cl.res.write(chunk);
  }
  // Public readers: the same Buffer goes to every reader (serialised once per tick). A reader
  // whose socket can't keep up skips frames and is resynced with one snapshot once it drains.
  function writeLive(cl, buf, t) {
    const res = cl.res;
    if (res.destroyed || res.writableEnded) return;
    const queued = res.writableLength;
    if (cl.lagSince) {
      if (queued > LAG.max || t - cl.lagSince > LAG.maxMs) {
        res.destroy(); // it will reconnect and start from a snapshot
        return;
      }
      if (queued > LAG.low) return;
      cl.lagSince = 0;
      res.write(liveSnapshotBuf()); // everything it missed, in one piece
      return;
    }
    if (queued > LAG.high) {
      cl.lagSince = t;
      return;
    }
    res.write(buf);
  }
  const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  // One pass of the public stream: diff the live view against what was sent, then send it as
  // one Buffer per format to every reader: separate events (v1), or one `tick` frame (v2).
  function liveTick() {
    const t = Date.now();
    const v = party.liveView();
    pub.view = { at: t, rev: party.publicRev, v };
    let out = '';
    const frame = {};
    const pj = JSON.stringify(v.party);
    if (pj !== JSON.stringify(pub.party)) {
      pub.party = v.party;
      out += `event: party\ndata: ${pj}\n\n`;
      frame.party = v.party;
    }
    const cj = JSON.stringify(v.counters);
    if (cj !== JSON.stringify(pub.counters) && t - pub.countersAt >= liveMetaMinMs) {
      pub.counters = v.counters;
      pub.countersAt = t;
      out += `event: counters\ndata: ${cj}\n\n`;
      frame.counters = v.counters;
    }
    const seen = new Set();
    const posts = [];
    for (const p of v.posts) {
      seen.add(p.id);
      const prev = pub.posts.get(p.id);
      let rec = null;
      if (!prev) {
        rec = { id: p.id, title: p.title, name: p.name, text: p.text, active: p.active, rev: 1 };
        pub.posts.set(p.id, { ...rec, sentAt: t });
      } else if ((prev.text !== p.text || prev.title !== p.title || prev.name !== p.name || prev.active !== p.active) && t - prev.sentAt >= livePostMinMs) {
        const d = prev.text === p.text ? null : textDiff(prev.text, p.text);
        prev.sentAt = t;
        prev.rev++;
        prev.text = p.text;
        prev.title = p.title;
        prev.name = p.name;
        prev.active = p.active;
        rec = { id: p.id, rev: prev.rev, title: p.title, name: p.name, active: p.active, d };
      }
      if (rec) {
        out += sse('post', rec);
        posts.push(rec);
      }
    }
    if (posts.length) frame.posts = posts;
    const removed = [];
    for (const id of [...pub.posts.keys()]) {
      if (!seen.has(id)) {
        pub.posts.delete(id);
        out += sse('remove', { id });
        removed.push(id);
      }
    }
    if (removed.length) frame.remove = removed;
    const order = v.posts.map((p) => p.id);
    if (order.join() !== pub.order.join() && t - pub.orderAt >= liveMetaMinMs) {
      pub.order = order;
      pub.orderAt = t;
      out += sse('order', order);
      frame.order = order;
    }
    if (!out) return;
    pub.rev++;
    pub.snapshot = null; // rebuilt once, on the next new reader or resync
    const v1 = enc(out);
    const v2 = enc(`event: tick\ndata: ${JSON.stringify(frame)}\n\n`);
    for (const cl of liveClients) writeLive(cl, cl.v2 ? v2 : v1, t);
  }
  // The snapshot a new or resynced reader starts with: built once per change, shared. It carries
  // the build id, so a page reconnecting after a deploy learns of it (public/js/update.js).
  function liveSnapshotBuf() {
    if (!pub.party) liveTick();
    const build = buildVersion();
    if (!pub.snapshot || pub.snapshotBuild !== build) {
      pub.snapshot = enc(sse('snapshot', { ...liveSnapshot(), build }));
      pub.snapshotBuild = build;
    }
    return pub.snapshot;
  }
  // GET /api/live: one JSON (and its gzip) per second or per public change, with an ETag.
  function liveJson() {
    const t = Date.now();
    let view = pub.view;
    if (!view || t - view.at >= 1000 || t < view.at || view.rev !== party.publicRev) {
      view = { at: t, rev: party.publicRev, v: party.liveView() };
      pub.view = view;
    }
    if (!pub.json || pub.json.view !== view) {
      const body = JSON.stringify(view.v);
      if (pub.json && pub.json.body === body) pub.json.view = view;
      else pub.json = { view, body, buf: enc(body), gz: null, etag: `"l${t.toString(36)}-${body.length.toString(36)}"` };
    }
    return pub.json;
  }
  // GET /api/archive: built at most once a second (or per public change), gzipped once, with an
  // ETag. When the party ends, every open live page asks for it in the same moment (and costs
  // tens of ms each to build: word counts and excerpts of every post).
  let archiveCache = null;
  function archiveJson() {
    const t = Date.now();
    const c = archiveCache;
    if (c && t - c.at < 1000 && t >= c.at && c.rev === party.publicRev && c.phase === party.phase) return c.json;
    const body = JSON.stringify(party.archiveView());
    const json = c && c.json.body === body ? c.json : { body, buf: enc(body), gz: null, etag: `"a${t.toString(36)}-${body.length.toString(36)}"` };
    archiveCache = { at: t, rev: party.publicRev, phase: party.phase, json };
    return json;
  }
  function sendCachedJson(req, res, c) {
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', ETag: c.etag, Vary: 'Accept-Encoding' };
    if (req.headers['if-none-match'] === c.etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    let buf = c.buf;
    if (buf.length > 1024 && acceptsGzip(req)) {
      if (!c.gz) c.gz = zlib.gzipSync(c.buf, { level: 6 });
      buf = c.gz;
      headers['Content-Encoding'] = 'gzip';
    }
    headers['Content-Length'] = buf.length;
    res.writeHead(200, headers);
    return res.end(req.method === 'HEAD' ? undefined : buf);
  }
  // GET /api/p/<id>: cached per post for a second (or until a public change).
  const postCache = new Map(); // publicId -> { at, rev, json-like cache }
  function publicPostJson(id) {
    const t = Date.now();
    const c = postCache.get(id);
    if (c && t - c.at < 1000 && t >= c.at && c.rev === party.publicRev) return c.json;
    const body = JSON.stringify(party.publicPost(id)); // throws 404 for posts that aren't public
    const json = c && c.json.body === body ? c.json : { body, buf: enc(body), gz: null, etag: `"p${t.toString(36)}-${body.length.toString(36)}"` };
    if (postCache.size > 5000) postCache.clear();
    postCache.set(id, { at: t, rev: party.publicRev, json });
    return json;
  }
  function liveSnapshot() {
    // Posts in the last order sent, then any newer ones (their order follows within a second).
    const ids = [...pub.order.filter((id) => pub.posts.has(id)), ...[...pub.posts.keys()].filter((id) => !pub.order.includes(id))];
    return {
      party: pub.party,
      counters: pub.counters,
      posts: ids.map((id) => {
        const { sentAt, ...rec } = pub.posts.get(id);
        return rec;
      }),
    };
  }

  // Signed-in live streams end with their session (signed out, evicted by newer sign-ins, or a
  // password change elsewhere). The reader reconnects as a public one.
  function closeStreamsOf() {
    for (const cl of liveClients) if (cl.token && party.sessionUserId(cl.token) !== cl.userId) cl.res.end();
    for (const cl of meClients) if (party.sessionUserId(cl.token) !== cl.userId) cl.res.end();
  }
  function meTick() {
    for (const cl of liveClients) if (cl.token && party.sessionUserId(cl.token) !== cl.userId) cl.res.end();
    const cache = new Map();
    for (const cl of meClients) {
      if (!party.userById(cl.userId) || party.sessionUserId(cl.token) !== cl.userId) {
        cl.res.end();
        continue;
      }
      let data = cache.get(cl.userId);
      if (!data) {
        const v = party.meView(cl.userId);
        v.serverNow = 0;
        const key = JSON.stringify(v);
        cache.set(cl.userId, (data = { key, v }));
      }
      if (data.key === cl.lastKey) continue;
      cl.lastKey = data.key;
      data.v.serverNow = party.now();
      writeClient(cl, sse('me', data.v));
    }
  }
  // Another event on a writer's own streams, now (lib/notify.js: `notice`). Returns how many
  // streams it was written to (0: no page of theirs is open).
  function meSend(userId, event, data) {
    let n = 0;
    for (const cl of meClients) {
      if (cl.userId !== userId || cl.res.destroyed || cl.res.writableEnded) continue;
      writeClient(cl, sse(event, data));
      n++;
    }
    return n;
  }

  function openSse(req, res, set, cl, first, onClose = null) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    if (req.method === 'HEAD') return res.end();
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true, 30_000);
    cl.res = res;
    set.add(cl);
    res.write('retry: 2000\n\n');
    writeClient(cl, first);
    let closed = false;
    const done = () => {
      set.delete(cl);
      if (!closed) {
        closed = true;
        onClose?.();
      }
    };
    req.on('close', done);
    res.on('close', done);
    res.on('error', done);
    return undefined;
  }

  // ------------------------------------------------------------------ api
  function ctxOf(req) {
    if (req.whCtx) return req.whCtx;
    const token = parseCookies(req.headers.cookie).wh_sess || null;
    const userId = party.sessionUserId(token);
    // Any request with a valid session shows that device was online now (offline back-dating).
    if (userId) party.seen(token);
    req.whCtx = { token: userId ? token : null, userId, user: party.userById(userId) };
    if (req.whCtx.user?.isAdmin) regLimiter.noteHost(clientIp(req));
    return req.whCtx;
  }
  function startSession(c, userId) {
    const token = newSessionToken();
    party.createSession(userId, token);
    c.res.setHeader('Set-Cookie', sessionCookie(token, { secure: isHttps(c.req) }));
  }
  const sessionView = (u) => (u ? { id: u.id, username: u.username, name: u.name, isAdmin: !!u.isAdmin, hasEmail: !!u.email, customCss: u.customCss || null, ...party.approvalView(u) } : null); // only ever the requester's own account
  const needUser = (c) => {
    if (!c.userId) throw new HttpError(401, 'Please sign in first');
    return c.userId;
  };

  // Written in the thread pool, never on the event loop: an op batch's ack waits until its
  // record is in the kernel (a crash of this process can't lose it), normally well under 1 ms; on
  // a congested disk only this writer waits. Past writeWaitMs the client is told to retry (the
  // record stays queued and lands in order; the retry waits for it as a duplicate).
  async function waitDurable(durable) {
    if (durable.written) {
      let late = null;
      const ok = await Promise.race([durable.written.then(() => true), new Promise((r) => { late = setTimeout(r, writeWaitMs, false); })]);
      clearTimeout(late);
      if (!ok) throw new HttpError(503, 'Saving is slow right now; your words are kept and will be retried.');
    }
    // Then the flush to disk (power cuts): normally ~2 ms, at most fsyncWaitMs on a busy disk.
    await Promise.race([durable.catch(() => {}), new Promise((r) => setTimeout(r, fsyncWaitMs))]);
  }
  const POST = {
    '/api/register': async (c) => {
      const wait = regLimiter.check(c.ip);
      if (wait) {
        c.res.setHeader('Retry-After', String(wait));
        throw new HttpError(429, `Too many sign-ups from this network; try again in ${wait} s.`, { code: 'rate', retryAfter: wait });
      }
      // Sign-ups from the venue (a network a host is signed in from) are never turned away by
      // the account cap, so a flood from elsewhere can't lock the room out.
      const venue = regLimiter.isHostNetwork(c.ip);
      let clean;
      try {
        // With WH_SETUP_TOKEN set, the first account (the host) needs the setup link's
        // token, and no one can claim a name listed in WH_ADMIN_USERS by signing up (those names
        // only promote accounts that already exist, at sign-in).
        if (setupToken) {
          const first = !Object.keys(party.state.users).length;
          if (first && !sameSecret(c.body.setup, setupToken)) throw new HttpError(403, 'This party isn’t set up yet: the first account needs the organiser’s setup link.', { code: 'setup_required' });
          if (!first && party.adminUsers.has(String(c.body.username ?? '').trim().toLowerCase())) throw new HttpError(409, 'That username is reserved', { code: 'username_reserved', field: 'username' });
        }
        clean = party.validateRegistration(c.body, { ignoreCap: venue });
      } catch (e) {
        if (e instanceof HttpError && (e.status === 400 || e.status === 409)) regLimiter.fail(c.ip);
        throw e;
      }
      regLimiter.success(c.ip); // counted before the (slow) hash, so a burst can't overshoot
      const hash = await hashGate.run(c.ip, () => hashPassword(c.body.password), { host: venue });
      const u = party.register(clean, hash, { ignoreCap: venue });
      startSession(c, u.id);
      return { user: sessionView(u) };
    },
    '/api/login': async (c) => {
      const b = c.body;
      const username = typeof b.username === 'string' ? b.username.trim().toLowerCase() : '';
      const password = typeof b.password === 'string' ? b.password : '';
      if (!username || !password) throw new HttpError(400, 'Enter your username and password');
      const key = `${c.ip}|${username}`;
      if (limiter.blocked(key)) throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.');
      limiter.fail(key); // reserved now, cleared by the right password
      const found = party.userByUsername(username);
      let good;
      try {
        good = await hashGate.run(c.ip, () => verifyPassword(password.slice(0, 200), found?.passHash), { host: regLimiter.isHostNetwork(c.ip) });
      } catch (e) {
        unreserve(key);
        throw e;
      }
      if (!found || !good) throw new HttpError(401, 'Wrong username or password');
      limiter.success(key);
      party.noteLogin(found);
      startSession(c, found.id);
      return { user: sessionView(found) };
    },
    '/api/logout': (c) => {
      if (c.token) {
        party.deleteSession(c.token);
        for (const cl of meClients) if (cl.token === c.token) cl.res.end();
        for (const cl of liveClients) if (cl.token === c.token) cl.res.end();
      }
      c.res.setHeader('Set-Cookie', sessionCookie('', { secure: isHttps(c.req), clear: true }));
      return {};
    },
    '/api/join': (c) => ({ joinedAt: party.join(needUser(c)) }),
    '/api/post/new': (c) => {
      const p = party.newPost(needUser(c), c.body);
      return { post: { id: p.id, title: p.title, privacy: p.privacy, closed: p.closed, unlisted: p.unlisted, ver: p.ver, body: '', notes: '' } };
    },
    '/api/post/update': (c) => {
      const p = party.updatePost(needUser(c), c.body);
      return { post: { id: p.id, title: p.title, privacy: p.privacy, closed: p.closed } };
    },
    // SPEC §30: { id, reason } opens an edit after the party; { id, done: true } ends it.
    '/api/post/after-party': (c) => party.openAfterEdit(needUser(c), c.body),
    '/api/ops': async (c) => {
      let out;
      try {
        out = party.applyOps(needUser(c), c.body, { token: c.token });
      } catch (e) {
        // A known batch id that other batches followed (409 duplicate) tells the client its words
        // are in: like the plain duplicate, answered once the pane's journal lines have landed.
        const durable = party.pendingDurable;
        party.pendingDurable = null;
        if (durable && e && e.extra && e.extra.duplicate) await waitDurable(durable);
        throw e;
      }
      const durable = party.pendingDurable;
      party.pendingDurable = null;
      if (durable) {
        durable.catch((e) => log.error('[journal] flush to disk failed:', e && e.message));
        await waitDurable(durable);
      }
      return out;
    },
    '/api/paste/check': (c) => party.pasteCheck(needUser(c), c.body.text),
    '/api/pass': (c) => party.takePass(needUser(c), c.body),
    '/api/me/approval-message': (c) => {
      const out = party.setApprovalMessage(needUser(c), c.body.message);
      meTick(); // the writer's other tabs
      return out;
    },
    // SPEC §33: "I'm leaving the party" / "Back at the party" ({ left: true | false }).
    '/api/me/left': (c) => {
      const out = party.setLeft(needUser(c), c.userId, c.body.left);
      meTick();
      return out;
    },
  };
  const ADMIN = {
    '/api/admin/start': (c) => { party.start(c.userId); return {}; },
    '/api/admin/end': (c) => { party.end(c.userId); return {}; },
    '/api/admin/party': (c) => {
      if (c.body.name !== undefined) party.setPartyName(c.userId, c.body.name);
      if (c.body.plannedEnd !== undefined) party.setPlannedEnd(c.userId, c.body.plannedEnd);
      return { party: party.partyMeta() };
    },
    '/api/admin/settings': (c) => ({ settings: party.setSettings(c.userId, c.body.scoring || c.body), rescoring: party.rescoring }),
    '/api/admin/settings/preview': (c) => party.previewSettings(c.userId, c.body),
    '/api/admin/writer': (c) => ({ ...(party.adminWriter(c.userId, c.body).undo || {}) }),
    // SPEC §33: mark a writer as left the party, or back ({ id, left: true | false }).
    '/api/admin/writer/left': (c) => {
      const out = party.setLeft(c.userId, typeof c.body.id === 'string' ? c.body.id : '', c.body.left);
      meTick();
      return out;
    },
    '/api/admin/post': (c) => { party.adminPost(c.userId, c.body); return {}; },
    '/api/admin/break': (c) => ({ break: party.addBreak(c.userId, c.body) }),
    '/api/admin/breaks': (c) => ({ break: party.addBreak(c.userId, c.body) }), // { name, minutes, startsAt?, mode? }
    '/api/admin/break/end': (c) => { party.endBreak(c.userId, c.body); return {}; },
    '/api/admin/break/mode': (c) => party.setBreakMode(c.userId, c.body), // POST /api/host/breaks/:id { mode }
    '/api/admin/alert/ack': (c) => ({ acked: party.ackAlert(c.userId, c.body) }),
    '/api/admin/review': (c) => party.adminReview(c.userId, c.body),
    '/api/admin/undo': (c) => party.undo(c.userId, c.body),
    // SPEC §15: the writer's page flips the moment the host decides (their stream gets it now).
    '/api/admin/approve': (c) => { const out = party.approve(c.userId, c.body); meTick(); return out; },
    '/api/admin/decline': (c) => { const out = party.decline(c.userId, c.body); meTick(); return out; },
    '/api/admin/approve-all': (c) => { const out = party.approveAll(c.userId); meTick(); return out; },
    '/api/admin/registration': (c) => party.setRegistration(c.userId, c.body.open),
    '/api/admin/password': async (c) => {
      validatePassword(c.body.password);
      if (!party.userById(c.body.id)) throw new HttpError(404, 'No such writer');
      const may = editRights(party, c.user, party.userById(c.body.id)); // SPEC §25: co-hosts don't reset hosts; your own needs the current one
      if (!may.canEdit || may.self) throw new HttpError(403, may.self ? 'Change your own password from Your account: it asks for the current one.' : may.reason, { code: may.self ? 'use_account' : may.code });
      party.setPasswordHash(c.body.id, await hashGate.run(c.ip, () => hashPassword(c.body.password), { host: true }));
      return {};
    },
  };
  const BIG = new Set(['/api/ops', '/api/paste/check']);
  // Requests that change nothing worth an immediate save (op batches are in the fsynced journal).
  const NO_SYNC_SAVE = new Set(['/api/ops', '/api/paste/check', '/api/admin/settings/preview']);

  function handleError(req, res, p, e) {
    if (e instanceof HttpError) {
      if (Number(e.extra?.retryAfter) > 0 && !res.headersSent) res.setHeader('Retry-After', String(Math.ceil(e.extra.retryAfter)));
      return sendJson(req, res, e.status, { error: e.message, ...(e.extra || {}) });
    }
    log.error('[api]', p, e);
    return sendJson(req, res, 500, { error: 'Server error' });
  }

  async function handleGet(req, res, p, url) {
    const c = ctxOf(req);
    try {
      switch (p) {
        // `build`: the build id on every module URL (?v=); an open page compares it with its own
        // to learn that a new build was deployed (public/js/update.js).
        case '/api/session':
          return sendJson(req, res, 200, { user: sessionView(c.user), party: { ...party.partyInfo(), rules: party.publicRules(), ...(setupToken && !Object.keys(party.state.users).length ? { needsSetup: true } : {}) }, build: buildVersion() });
        case '/api/build':
          return sendJson(req, res, 200, { build: buildVersion() });
        case '/api/live':
          return sendCachedJson(req, res, liveJson());
        case '/api/live/events': {
          if (req.method === 'HEAD') return openSse(req, res, liveClients, {}, '');
          const cl = { v2: url.searchParams.get('v') === '2', lagSince: 0, token: c.token, userId: c.userId };
          if (c.token) {
            // A signed-in tab: per session, the oldest closes (a writer is never refused); also per
            // person across sessions.
            const mine = [...liveClients].filter((x) => x.token === c.token);
            for (const old of mine.slice(0, Math.max(0, mine.length - SSE.perSession + 1))) old.res.end();
            const theirs = [...liveClients].filter((x) => x.userId === c.userId && !x.res.writableEnded);
            for (const old of theirs.slice(0, Math.max(0, theirs.length - SSE.perUser + 1))) old.res.end();
            return openSse(req, res, liveClients, cl, liveSnapshotBuf());
          }
          const ip = clientIp(req);
          const n = liveByIp.get(ip) || 0;
          if (liveClients.size >= SSE.liveMax || n >= SSE.perIp) {
            res.setHeader('Retry-After', '30');
            return sendJson(req, res, 429, { error: 'The live page is very busy right now; it will catch up by itself.', code: 'busy' });
          }
          liveByIp.set(ip, n + 1);
          return openSse(req, res, liveClients, cl, liveSnapshotBuf(), () => {
            const m = (liveByIp.get(ip) || 1) - 1;
            if (m > 0) liveByIp.set(ip, m);
            else liveByIp.delete(ip);
          });
        }
        case '/api/archive':
          return sendCachedJson(req, res, archiveJson());
        case '/api/me':
          return sendJson(req, res, 200, party.meView(needUser(c)));
        case '/api/me/events': {
          const uid = needUser(c);
          // A writer's own streams are never refused; past 4 per session the oldest closes.
          const mine = [...meClients].filter((x) => x.token === c.token);
          for (const old of mine.slice(0, Math.max(0, mine.length - SSE.perSession + 1))) old.res.end();
          const theirs = [...meClients].filter((x) => x.userId === uid && !x.res.writableEnded);
          for (const old of theirs.slice(0, Math.max(0, theirs.length - SSE.perUser + 1))) old.res.end();
          const v = party.meView(uid);
          const cl = { token: c.token, userId: uid, lastKey: JSON.stringify({ ...v, serverNow: 0 }) };
          // The first frame carries the build id (a page reconnecting after a deploy learns of it here).
          return openSse(req, res, meClients, cl, sse('me', { ...v, build: buildVersion() }));
        }
        case '/api/posts':
          return sendJson(req, res, 200, { posts: party.postsWithText(needUser(c)) });
        case '/api/post':
          return sendJson(req, res, 200, party.postText(needUser(c), url.searchParams.get('id'), url.searchParams.get('pane') || 'body'));
        default:
          break;
      }
      if (p.startsWith('/api/p/')) {
        let id;
        try {
          id = decodeURIComponent(p.slice(7));
        } catch {
          return sendJson(req, res, 404, { error: 'Not found' });
        }
        return sendCachedJson(req, res, publicPostJson(id));
      }
      if (p.startsWith('/api/admin/') && c.user?.isAdmin) {
        if (p === '/api/admin/state') return sendJson(req, res, 200, party.hostView(c.userId));
        if (p === '/api/admin/writer') return sendJson(req, res, 200, party.hostWriter(c.userId, url.searchParams.get('id')));
        if (p === '/api/admin/diag') {
          // Health while it runs: event-loop delay since the last reset, memory, streams.
          // The histogram samples every 10 ms; report the delay beyond that period.
          const ms = (ns) => Math.max(0, Math.round((ns - 10e6) / 1e4) / 100);
          const mem = process.memoryUsage();
          const out = {
            uptimeS: Math.round((Date.now() - bootAt) / 1000),
            eventLoopMs: { max: ms(loopDelay.max), p99: ms(loopDelay.percentile(99)), p50: ms(loopDelay.percentile(50)), mean: ms(loopDelay.mean) },
            rssMB: Math.round(mem.rss / 1e5) / 10, heapUsedMB: Math.round(mem.heapUsed / 1e5) / 10,
            streams: { live: liveClients.size, me: meClients.size, lagging: [...liveClients].filter((x) => x.lagSince).length },
            ops: Object.values(party.state.ops).reduce((n, l) => n + l.length, 0),
            rescoring: party.rescoring, lastRescore: party.lastRescore || null,
          };
          if (url.searchParams.get('reset') === '1') loopDelay.reset();
          return sendJson(req, res, 200, out);
        }
        const stamp = party.localStamp(party.now()).slice(0, 16).replace(/[:T]/g, '-'); // on the party clock
        if (p === '/api/admin/export.json') return await streamExportJson(req, res, party.exportJson(c.userId), stamp);
        if (p === '/api/admin/export.md') {
          return sendBody(req, res, 200, party.exportMarkdown(c.userId), 'text/markdown; charset=utf-8', {
            'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="writehaven-archive-${stamp}.md"`,
          });
        }
        if (Object.hasOwn(ADMIN, p)) return sendJson(req, res, 405, { error: 'Use POST' });
      }
      if (Object.hasOwn(POST, p)) return sendJson(req, res, 405, { error: 'Use POST' });
      return sendJson(req, res, 404, { error: 'Not found' });
    } catch (e) {
      return handleError(req, res, p, e);
    }
  }

  // /api/host/<x> is an alias of /api/admin/<x>; GET /api/host is the host view.
  // GET /api/admin/export.json: everything, every op included (tens of MB later in the party;
  // serialising it at once took ~0.4 s and gzipping it ~1.1 s at an hour of 60 fast writers).
  // Written piece by piece (5,000 ops at a time) and gzipped in the thread pool, so writers and
  // readers keep being served while the host downloads it.
  async function streamExportJson(req, res, data, stamp) {
    const gz = acceptsGzip(req);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="writehaven-${stamp}.json"`,
      ...(gz ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}),
    });
    if (req.method === 'HEAD') return res.end();
    const out = gz ? zlib.createGzip({ level: 6 }) : res;
    if (gz) out.pipe(res);
    let gone = false;
    res.on('close', () => { gone = true; });
    const drained = () => new Promise((resolve) => {
      const done = () => {
        out.off('drain', done);
        res.off('close', done);
        resolve();
      };
      out.on('drain', done);
      res.on('close', done);
    });
    const put = async (str) => {
      if (gone) return;
      if (!out.write(str)) await drained();
      await new Promise((r) => setImmediate(r)); // let requests in between pieces
    };
    const { ops, ...rest } = data;
    const head = JSON.stringify(rest, null, 1); // "{\n ...\n}"
    await put(`${head.slice(0, -2)},\n "ops": {`);
    let first = true;
    for (const [uid, list] of Object.entries(ops || {})) {
      await put(`${first ? '' : ','}\n  ${JSON.stringify(uid)}: [`);
      first = false;
      for (let i = 0; i < list.length; i += 5000) await put((i ? ',' : '') + JSON.stringify(list.slice(i, i + 5000)).slice(1, -1));
      await put(']');
    }
    await put('\n }\n}\n');
    if (!gone) out.end();
    return undefined;
  }

  function canonicalPath(p) {
    if (p === '/api/host') return '/api/admin/state';
    if (p.startsWith('/api/host/')) return `/api/admin/${p.slice(10)}`;
    return p;
  }
  const BREAK_ROUTE = /^\/api\/admin\/breaks\/([A-Za-z0-9]{1,32})(\/cancel)?$/;

  async function handleApi(req, res, p0, url) {
    let p = canonicalPath(p0);
    // POST /api/admin/breaks/:id/cancel -> the break-end route with the id.
    let pathParams = null;
    const bm = req.method === 'POST' ? BREAK_ROUTE.exec(p) : null;
    if (bm) {
      pathParams = { id: bm[1] };
      p = bm[2] ? '/api/admin/break/end' : '/api/admin/break/mode';
    }
    if (req.method === 'GET' || req.method === 'HEAD') return handleGet(req, res, p, url);
    if (req.method !== 'POST') return sendJson(req, res, 405, { error: 'Method not allowed' });
    const isAdminRoute = Object.hasOwn(ADMIN, p);
    const route = Object.hasOwn(POST, p) ? POST[p] : isAdminRoute && ctxOf(req).user?.isAdmin ? ADMIN[p] : null;
    if (!route) {
      req.resume();
      return sendJson(req, res, 404, { error: 'Not found' });
    }
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/json' || req.headers['x-wh'] !== '1') {
      req.resume();
      return sendJson(req, res, 403, { error: 'Forbidden: JSON with the X-WH header required' });
    }
    let body;
    try {
      body = await readJson(req, BIG.has(p) ? BIG_BODY_LIMIT : BODY_LIMIT);
    } catch (e) {
      return handleError(req, res, p, e);
    }
    if (pathParams) body = { ...body, ...pathParams };
    const c = { ...ctxOf(req), body, req, res, ip: clientIp(req) };
    if (isAdminRoute && !c.user?.isAdmin) return sendJson(req, res, 404, { error: 'Not found' });
    try {
      const out = await route(c);
      // Accounts, sessions, starts and ends, posts, privacy and every host decision are on
      // disk before the answer (the debounced save could lose the last second in a crash);
      // written in the background, so the event loop never waits for the disk.
      if (!NO_SYNC_SAVE.has(p)) await saver.flushAsync();
      sendJson(req, res, 200, { ok: true, ...(out || {}) });
    } catch (e) {
      handleError(req, res, p, e);
    }
    return undefined;
  }

  // --------------------------------------------------------------- static
  let versionCache = { at: 0, v: 'dev' };
  function buildVersion() {
    const t = Date.now();
    if (t - versionCache.at < 1000) return versionCache.v;
    const parts = [];
    const walk = (dir, rel) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), r);
        else if (/\.(js|css)$/.test(e.name)) {
          try {
            const st = fs.statSync(path.join(dir, e.name));
            parts.push(`${r}:${st.mtimeMs}:${st.size}`);
          } catch { /* vanished */ }
        }
      }
    };
    walk(publicRoot, '');
    parts.sort();
    versionCache = { at: t, v: crypto.createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 10) };
    return versionCache.v;
  }

  async function serveIndex(req, res) {
    let html;
    try {
      html = await fs.promises.readFile(path.join(publicRoot, 'index.html'), 'utf8');
    } catch {
      return sendText(res, 404, 'index.html not found', { 'Cache-Control': 'no-store' });
    }
    return sendBody(req, res, 200, html.replaceAll('__V__', buildVersion()), MIME['.html'], { 'Cache-Control': 'no-store' });
  }

  const gzCache = new Map(); // full path -> { key, buf }
  // Every module the app loads gets the build version in its URL: when serving our own .js,
  // relative or /js/ and /vendor/ specifiers in import/export/import()/new URL()/new Worker()
  // gain ?v=<build>. A deploy then changes every module URL at once, so no browser or CDN
  // cache (Cloudflare rewrites no-cache to a 4-hour browser TTL) can mix old and new modules.
  const IMPORT_SPEC = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bnew\s+URL\s*\(\s*|\bnew\s+Worker\s*\(\s*)(['"])((?:\.{1,2}\/|\/(?:js|vendor)\/)[^'"?#\s]+\.m?js)\2/g;
  const versionImports = (src, v) => src.replace(IMPORT_SPEC, (all, pre, q, spec) => `${pre}${q}${spec}?v=${v}${q}`);
  const jsCache = new Map(); // full path -> { key, buf, gz }
  let realRoot = null;
  async function serveStatic(req, res, pathname, url) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return sendText(res, 400, 'Bad request');
    }
    if (rel.includes('\0') || rel.includes('\\')) return sendText(res, 400, 'Bad request');
    const segs = rel.split('/').filter(Boolean);
    if (segs.some((s) => s === '..' || s === '.' || s.startsWith('.'))) return sendText(res, 404, 'Not found');
    if (!segs.length || (segs.length === 1 && segs[0] === 'index.html')) return serveIndex(req, res);
    const full = path.join(publicRoot, ...segs);
    if (!full.startsWith(publicRoot + path.sep)) return sendText(res, 404, 'Not found');
    let st = null;
    try {
      st = await fs.promises.stat(full);
      if (!realRoot) realRoot = await fs.promises.realpath(publicRoot);
      const real = await fs.promises.realpath(full);
      if (!real.startsWith(realRoot + path.sep)) st = null;
    } catch {
      st = null;
    }
    const ext = path.extname(full).toLowerCase();
    if (st && st.isFile()) {
      // Versioned URLs (?v=...) and fonts/vendor bundles are immutable; the rest revalidates.
      const immutable = url.searchParams.has('v') || segs[0] === 'fonts';
      const cache = immutable ? 'public, max-age=31536000, immutable' : 'no-cache';
      const type = MIME[ext] || 'application/octet-stream';
      if (ext === '.js' && segs[0] === 'js') {
        // Our own modules: served with versioned import specifiers (see versionImports).
        const v = buildVersion();
        const key = `${st.mtimeMs}:${st.size}:${v}`;
        let ent = jsCache.get(full);
        if (!ent || ent.key !== key) {
          const buf = Buffer.from(versionImports(await fs.promises.readFile(full, 'utf8'), v));
          ent = { key, buf, gz: buf.length > 1024 ? zlib.gzipSync(buf, { level: 9 }) : null };
          jsCache.set(full, ent);
        }
        const jsTag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}-${v}"`;
        res.setHeader('ETag', jsTag);
        if (req.headers['if-none-match'] === jsTag) {
          res.writeHead(304, { 'Cache-Control': cache });
          return res.end();
        }
        const gz = ent.gz && acceptsGzip(req);
        const body = gz ? ent.gz : ent.buf;
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': cache, ...(gz ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}) });
        return res.end(req.method === 'HEAD' ? undefined : body);
      }
      const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
      res.setHeader('ETag', etag);
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { 'Cache-Control': cache });
        return res.end();
      }
      if (COMPRESSIBLE.has(ext) && acceptsGzip(req) && st.size > 1024) {
        const key = `${st.mtimeMs}:${st.size}`;
        let ent = gzCache.get(full);
        if (!ent || ent.key !== key) {
          const buf = zlib.gzipSync(await fs.promises.readFile(full), { level: 9 });
          gzCache.set(full, (ent = { key, buf }));
        }
        res.writeHead(200, { 'Content-Type': type, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Content-Length': ent.buf.length, 'Cache-Control': cache });
        return res.end(req.method === 'HEAD' ? undefined : ent.buf);
      }
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': cache });
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(full);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
      return undefined;
    }
    // Missing files with an extension are real 404s; every other path is an app route.
    if (ext && ext !== '.html') return sendText(res, 404, 'Not found', { 'Cache-Control': 'no-store' });
    return serveIndex(req, res);
  }

  // --------------------------------------------------------------- server
  // Extension point: other modules (e.g. lib/uploads.js) add routes here without touching the
  // routing below, via createApp({ routes }) or app.extraRoutes.push(route). A route is
  //   { method: 'GET' | 'POST' | ..., match(pathname) -> params object or null, handle(req, res, h) }
  // and is tried first, before /api and static files (GET routes also answer HEAD). A handler
  // owns its body, auth and CSRF checks; h = { url, params, ctx (signed-in user, from ctxOf),
  // clientIp, party, sendJson(status, obj), sendError(err), HttpError }. Thrown HttpErrors become
  // JSON errors.
  const extraRoutes = [...routes];
  async function tryExtraRoute(req, res, p, url) {
    for (const r of extraRoutes) {
      if (r.method && r.method !== req.method && !(r.method === 'GET' && req.method === 'HEAD')) continue;
      const params = r.match(p);
      if (!params) continue;
      const h = {
        url, params, ctx: ctxOf(req), clientIp: clientIp(req), party, HttpError,
        sendJson: (status, obj) => sendJson(req, res, status, obj),
        sendError: (e) => handleError(req, res, p, e),
      };
      try {
        await r.handle(req, res, h);
      } catch (e) {
        if (!res.headersSent) handleError(req, res, p, e);
        else res.destroy();
      }
      return true;
    }
    return false;
  }

  async function handle(req, res) {
    setSecurityHeaders(res);
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return sendText(res, 400, 'Bad request');
    }
    const p = url.pathname;
    if (extraRoutes.length && (await tryExtraRoute(req, res, p, url))) return undefined;
    if (p === '/healthz') return sendText(res, 200, 'ok', { 'Cache-Control': 'no-store' });
    if (p === '/api' || p.startsWith('/api/')) return handleApi(req, res, p, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed');
    return serveStatic(req, res, p, url);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log.error('[http]', e);
      if (!res.headersSent) sendJson(req, res, 500, { error: 'Server error' });
      else res.destroy();
    });
  });
  server.keepAliveTimeout = 65_000;
  server.maxConnections = maxConnections;
  server.headersTimeout = 70_000;

  const guard = (name, fn) => () => {
    try {
      fn();
    } catch (e) {
      log.error(`[${name}]`, e);
    }
  };

  function start(port, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        loopDelay.enable();
        timers.push(setInterval(guard('tick', () => party.tick()), tickMs));
        timers.push(setInterval(guard('live', liveTick), liveMs));
        timers.push(setInterval(guard('me', meTick), 1000));
        timers.push(setInterval(() => {
          for (const cl of liveClients) writeClient(cl, ': ping\n\n');
          for (const cl of meClients) writeClient(cl, ': ping\n\n');
        }, pingMs));
        timers.push(setInterval(() => {
          limiter.sweep();
          regLimiter.sweep();
        }, 60_000));
        resolve(server.address());
      });
    });
  }

  async function stop() {
    loopDelay.disable();
    for (const t of timers) clearInterval(t);
    clearTimeout(party.rescoreTimer);
    party.rescoreGen++; // a background re-score in progress stops
    timers.length = 0;
    for (const cl of liveClients) cl.res.end();
    for (const cl of meClients) cl.res.end();
    liveClients.clear();
    meClients.clear();
    saver.flush();
    await journal.drain(); // writes in flight land first, in order
    journal.close();
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  // Open event streams (tests and diagnostics).
  const streams = () => ({ live: liveClients.size, me: meClients.size, meOf: (uid) => [...meClients].filter((x) => x.userId === uid).length });
  return { server, party, saver, start, stop, liveTick, meTick, meSend, streams, extraRoutes, liveClientsForTest: liveClients, hashGate, closeStreamsOf };
}

// ----------------------------------------------------------------------- CLI
function stateFilePath() {
  return path.resolve(process.env.WH_STATE_FILE || path.join(ROOT, 'data', 'state.json'));
}

function makeAdminCli(username) {
  const file = stateFilePath();
  const raw = loadState(file);
  if (!raw) {
    console.error(`No state file at ${file}`);
    return 1;
  }
  const name = String(username || '').trim().toLowerCase();
  const u = Object.values(raw.users || {}).find((x) => x.username === name);
  if (!u) {
    console.error(`No user "${username}" in ${file}`);
    return 1;
  }
  u.isAdmin = true;
  writeStateSync(file, raw);
  console.log(`${u.username} is now an admin. Restart the server, or it will overwrite this change.`);
  return 0;
}

async function main(argv) {
  const i = argv.indexOf('--make-admin');
  if (i >= 0) process.exit(makeAdminCli(argv[i + 1]));
  const port = Number(process.env.PORT || 8110);
  const host = process.env.HOST || '127.0.0.1';
  const adminUsers = String(process.env.WH_ADMIN_USERS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const hourMin = Number(process.env.WH_HOUR_MIN);
  const envInt = (k) => {
    const v = Number(process.env[k]);
    return Number.isInteger(v) && v > 0 ? v : undefined;
  };
  const sseLimits = Object.fromEntries(Object.entries({ perIp: envInt('WH_SSE_PER_IP'), perSession: envInt('WH_SSE_PER_SESSION'), liveMax: envInt('WH_SSE_MAX') }).filter(([, v]) => v));
  const regMax = Number(process.env.WH_REG_PER_IP);
  const regHostMax = Number(process.env.WH_REG_PER_HOST_IP);
  const regFailMax = Number(process.env.WH_REG_FAILS_PER_IP);
  const app = createApp({
    stateFile: stateFilePath(), adminUsers,
    setupToken: process.env.WH_SETUP_TOKEN || null,
    regLimits: { ...(regMax > 0 ? { max: regMax } : {}), ...(regHostMax > 0 ? { hostMax: regHostMax } : {}), ...(regFailMax > 0 ? { failMax: regFailMax } : {}) },
    sseLimits,
    maxConnections: envInt('WH_MAX_CONNECTIONS') ?? 2000,
    fsync: process.env.WH_FSYNC !== '0',
    publicUrl: process.env.WH_PUBLIC_URL || undefined,
    tz: process.env.WH_TZ || DEFAULT_TZ,
    testKnobs: process.env.WH_TEST_KNOBS === '1',
    hourLengthMin: Number.isFinite(hourMin) && hourMin > 0 ? hourMin : null,
    routes: [
      ...createUploads({ dir: path.join(path.dirname(stateFilePath()), 'uploads') }).routes, // SPEC §14 images
      ...createFood().routes, // SPEC §18, §18b, §20 food preferences and tonight's order
      ...createClientErrors({ dir: path.dirname(stateFilePath()) }).routes, // start-up failures reported by public/js/boot.js
    ],
  });
  attachNotify(app, { dir: path.dirname(stateFilePath()) }); // SPEC §21–22: co-hosts, notices, Web Push
  attachTabOrder(app); // SPEC §29: the order of a writer's tabs
  attachAccounts(app); // SPEC §25: Your account, and hosts editing account details
  attachWriters(app); // SPEC §28: the public list of writers and their pages
  process.on('uncaughtException', (e) => console.error('[uncaught]', e));
  process.on('unhandledRejection', (e) => console.error('[unhandled]', e));
  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`[writehaven] ${sig}: saving and shutting down`);
    try {
      await Promise.race([app.stop(), new Promise((r) => setTimeout(r, 2000))]);
    } finally {
      app.saver.flush();
      process.exit(0);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  const addr = await app.start(port, host);
  console.log(`[writehaven] http://${addr.address}:${addr.port} · state ${stateFilePath()} · phase ${app.party.phase}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
