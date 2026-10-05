// Start-up failures reported by browsers (public/js/boot.js): POST /api/client-error.
// No sign-in (a page that can't start can't sign in), but the same JSON + X-WH header
// as every other POST, a per-address rate limit and a size limit. Each report is one
// JSON line in client-errors.log in the state directory (capped at a few MB).
import fs from 'node:fs';
import path from 'node:path';

const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, n);

export function createClientErrors({ dir, now = Date.now, perMinute = 6, maxBodyBytes = 4096, maxFileBytes = 5 * 1024 * 1024, log = console } = {}) {
  const file = path.join(dir, 'client-errors.log');
  const hits = new Map(); // address -> recent report times
  let written = null; // bytes in the file (read once)

  function allowed(ip, t) {
    const recent = (hits.get(ip) || []).filter((x) => t - x < 60_000);
    if (recent.length >= perMinute) return false;
    recent.push(t);
    hits.set(ip, recent);
    if (hits.size > 10_000) hits.clear();
    return true;
  }

  function readBody(req) {
    return new Promise((resolve) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > maxBodyBytes) {
          resolve(null);
          req.resume();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(size > maxBodyBytes ? null : Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => resolve(null));
    });
  }

  const routes = [{
    method: 'POST',
    match: (p) => (p === '/api/client-error' ? {} : null),
    async handle(req, res, h) {
      const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (ct !== 'application/json' || req.headers['x-wh'] !== '1') {
        req.resume();
        return h.sendJson(403, { error: 'Forbidden: JSON with the X-WH header required' });
      }
      const t = now();
      if (!allowed(h.clientIp || '?', t)) {
        req.resume();
        return h.sendJson(429, { error: 'Too many reports' });
      }
      const body = await readBody(req);
      if (body === null) return h.sendJson(413, { error: 'Report too large' });
      let d;
      try {
        d = JSON.parse(body);
      } catch {
        return h.sendJson(400, { error: 'Bad JSON' });
      }
      if (!d || typeof d !== 'object') return h.sendJson(400, { error: 'Bad report' });
      const rec = {
        t: new Date(t).toISOString(),
        kind: clean(d.kind, 40),
        message: clean(d.message, 500),
        source: clean(d.source, 300),
        line: Number.isFinite(Number(d.line)) ? Number(d.line) : null,
        col: Number.isFinite(Number(d.col)) ? Number(d.col) : null,
        path: clean(d.path, 200),
        scripts: clean(d.scripts, 300),
        online: d.online === true,
        ua: clean(req.headers['user-agent'], 300),
        user: h.ctx?.userId || null, // signed in, if they got that far
      };
      try {
        if (written === null) {
          try {
            written = fs.statSync(file).size;
          } catch {
            written = 0;
          }
        }
        if (written > maxFileBytes) return h.sendJson(200, { ok: true, kept: false });
        const line = `${JSON.stringify(rec)}\n`;
        written += Buffer.byteLength(line);
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFile(file, line, (e) => { if (e) log.error('[client-error] could not write the log:', e.message); });
      } catch (e) {
        log.error('[client-error]', e.message);
      }
      return h.sendJson(200, { ok: true });
    },
  }];
  return { routes, file };
}
