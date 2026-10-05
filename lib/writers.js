// The public list of writers and their personal pages (SPEC §28, §28b), on server.js's route
// hook (attachWriters(app) in main(); tests call it on their app). Anyone may read them, signed
// in or not. Opting in and out is POST /api/me/account { publicProfile } (lib/accounts.js), the
// person's own choice; so is starring their own posts, here.
//
//   GET  /api/writers → { party: { name, phase }, writers: [{ id, name, met, judged, out, left }] }
//   GET  /api/w/<id>  → { party: { name, phase }, id, name, met, judged, out, left,
//                         posts: [{ publicId, title, words, excerpt, starred }] }
//                       (signed posts only, starred first); 404 { error } for an unknown id and for
//                       anyone not on the list: the same answer, so page ids can't be probed.
//   POST /api/me/star { postId | publicId, starred } → { ok, starred, listed, page }
//                       (SPEC §28b) the writer's own post only (404 otherwise); signed in, JSON
//                       with X-WH; before and after the end. `listed`/`page`: whether they're on
//                       the list now, and their page id if so, for the confirmation they see.
//
// The views are lib/party.js's (writersView, writerPageView, setStar). Like /api/live and
// /api/p/<id>, each answer is built at most once a second, or at once after a public change
// (party.publicRev: someone joins or leaves the list, a new display name, a post's privacy, a
// signed post's star, the end), gzipped once, and sent with an ETag (304 when unchanged).

import zlib from 'node:zlib';
import { HttpError } from './party.js';

const FRESH_MS = 1000;
const MAX_PAGES = 500; // personal pages kept built (only ids that exist are kept)
const ID_RE = /^[a-z0-9]{1,40}$/; // page ids are lib/party.js randomId() strings
const BODY_LIMIT = 4096;

const acceptsGzip = (req) => /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
const wantsJson = (req) => String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() === 'application/json' && req.headers['x-wh'] === '1';
function readJson(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] || 0) > BODY_LIMIT) {
      req.resume();
      reject(new HttpError(413, 'Request body too large'));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= BODY_LIMIT) chunks.push(c);
    });
    req.on('end', () => {
      if (size > BODY_LIMIT) return reject(new HttpError(413, 'Request body too large'));
      const text = Buffer.concat(chunks).toString('utf8').trim();
      try {
        const v = text ? JSON.parse(text) : {};
        return v && typeof v === 'object' && !Array.isArray(v) ? resolve(v) : reject(new HttpError(400, 'Body must be a JSON object'));
      } catch {
        return reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// flush: the state file written before a change is answered; meTick: the writer's own pages
// (their other tabs and devices) get the new `me` at once.
export function createWriters({ party, flush = async () => {}, meTick = () => {} }) {
  if (!party) throw new Error('createWriters: party is required');
  let list = null; // { at, rev, phase, json }
  const pages = new Map(); // page id -> the same

  // The cached answer `prev` while fresh, else a new one (keeping prev's ETag if nothing changed).
  function build(prev, make, tag) {
    const t = Date.now();
    if (prev && t - prev.at < FRESH_MS && t >= prev.at && prev.rev === party.publicRev && prev.phase === party.phase) return prev;
    const body = JSON.stringify(make()); // HttpError 404 for a page that isn't public
    const json = prev && prev.json.body === body ? prev.json : { body, buf: Buffer.from(body, 'utf8'), gz: null, etag: `"${tag}${t.toString(36)}-${body.length.toString(36)}"` };
    return { at: t, rev: party.publicRev, phase: party.phase, json };
  }
  function send(req, res, c) {
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

  const routes = [
    {
      method: 'GET',
      match: (p) => (p === '/api/writers' ? {} : null),
      handle: (req, res) => {
        list = build(list, () => party.writersView(), 'w');
        send(req, res, list.json);
      },
    },
    {
      method: 'GET',
      match: (p) => (p.startsWith('/api/w/') ? { raw: p.slice(7) } : null),
      handle: (req, res, h) => {
        let id = '';
        try {
          id = decodeURIComponent(h.params.raw);
        } catch { /* malformed: not found */ }
        if (!ID_RE.test(id)) throw new HttpError(404, 'Not found');
        let c;
        try {
          c = build(pages.get(id), () => party.writerPageView(id), 'v');
        } catch (e) {
          pages.delete(id); // left the list (or never was on it)
          throw e;
        }
        if (!pages.has(id) && pages.size >= MAX_PAGES) pages.clear();
        pages.set(id, c);
        send(req, res, c.json);
      },
    },
    {
      // SPEC §28b: only the writer stars, and only their own posts; there is no host route.
      method: 'POST',
      match: (p) => (p === '/api/me/star' ? {} : null),
      handle: async (req, res, h) => {
        if (!h.ctx.userId) {
          req.resume();
          throw new HttpError(401, 'Please sign in first');
        }
        if (!wantsJson(req)) {
          req.resume();
          throw new HttpError(403, 'Forbidden: JSON with the X-WH header required', { code: 'csrf' });
        }
        const out = party.setStar(h.ctx.userId, await readJson(req));
        await flush();
        meTick();
        h.sendJson(200, { ok: true, ...out });
      },
    },
  ];
  return { routes };
}

export function attachWriters(app) {
  const w = createWriters({ party: app.party, flush: () => app.saver?.flushAsync?.(), meTick: () => app.meTick?.() });
  app.extraRoutes.push(...w.routes);
  app.writers = w;
  return w;
}
