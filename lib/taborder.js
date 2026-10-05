// The order of a writer's tabs (SPEC §29), on server.js's route hook (attachTabOrder(app) in
// main(); tests call it on their app). The order is each post's `order` field, which
// lib/party.js's postsOf() already sorts by, so GET /api/posts and the writer's `me` stream
// (its `posts` list) carry it to every device. It only arranges the writer's own tabs: nothing
// public, no score and no export for anyone else reads it.
//
//   POST /api/me/tab-order { ids: [postId, ...] } → { ids }      (signed in; JSON + X-WH)
//     ids: the writer's posts in the order wanted, open and closed. Ids that aren't theirs, or
//     don't exist, are ignored; a repeat counts once; posts left out keep their order after the
//     ones given (so closed posts keep their place among the closed). Answers with the whole
//     order as stored. Any phase; nothing changes for a pending account, which has no posts.

import { HttpError } from './party.js';

const MAX_IDS = 500;
const ID_MAX_LEN = 64;
const BODY_LIMIT = 32 * 1024;

function readJson(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] || 0) > limit) {
      req.resume();
      reject(new HttpError(413, 'Request body too large'));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on('end', () => {
      if (size > limit) return reject(new HttpError(413, 'Request body too large'));
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        return v && typeof v === 'object' && !Array.isArray(v) ? resolve(v) : reject(new HttpError(400, 'Body must be a JSON object'));
      } catch {
        return reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}
const wantsJson = (req) => String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() === 'application/json' && req.headers['x-wh'] === '1';

export function createTabOrder({ party, meTick = () => {} }) {
  if (!party) throw new Error('createTabOrder: party is required');

  // The writer's posts in the order given (their own only), then the rest as they were.
  function setOrder(userId, ids) {
    const mine = party.postsOf(userId); // in the stored order
    const byId = new Map(mine.map((p) => [p.id, p]));
    const seen = new Set();
    const next = [];
    for (const id of ids) {
      const p = typeof id === 'string' ? byId.get(id) : undefined;
      if (!p || seen.has(id)) continue;
      seen.add(id);
      next.push(p);
    }
    for (const p of mine) if (!seen.has(p.id)) next.push(p);
    let changed = false;
    next.forEach((p, i) => {
      if (p.order !== i) {
        p.order = i;
        changed = true;
      }
    });
    if (changed) {
      party.touch(); // saved with the state
      meTick(); // the writer's other tabs and devices get the new order on their `me` stream
    }
    return next.map((p) => p.id);
  }

  const routes = [{
    method: 'POST',
    match: (p) => (p === '/api/me/tab-order' ? {} : null),
    handle: async (req, res, h) => {
      const u = h.ctx.user;
      if (!u) {
        req.resume();
        throw new HttpError(401, 'Please sign in first');
      }
      if (!wantsJson(req)) {
        req.resume();
        throw new HttpError(403, 'Forbidden: JSON with the X-WH header required', { code: 'csrf' });
      }
      const body = await readJson(req);
      const ids = body.ids;
      if (!Array.isArray(ids) || ids.length > MAX_IDS || ids.some((x) => typeof x !== 'string' || x.length > ID_MAX_LEN)) {
        throw new HttpError(400, 'ids must be a list of post ids');
      }
      h.sendJson(200, { ids: setOrder(u.id, ids) });
    },
  }];
  return { routes, setOrder };
}

export function attachTabOrder(app) {
  const t = createTabOrder({ party: app.party, meTick: () => app.meTick?.() });
  app.extraRoutes.push(...t.routes);
  app.tabOrder = t;
  return t;
}
