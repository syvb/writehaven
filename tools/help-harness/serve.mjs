// Static server for the help-sheet harness (dev only, no API):
//   /           -> public/   (the app's own CSS, fonts and modules, help.js included)
//   /harness/   -> tools/help-harness/
// Same CSP as the app, so the sheet is checked under the real policy.
// Usage: node tools/help-harness/serve.mjs [--port 8210]   (then open /harness/)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const MOUNTS = [['/harness/', here], ['/', path.join(root, 'public')]];
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml',
};
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "font-src 'self' data:",
  "img-src 'self' data: blob:", "connect-src 'self'", "object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'",
].join('; ');

export function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('Cache-Control', 'no-store');
    if (pathname.startsWith('/api/')) {
      // No API: the harness passes settings to openHelp, except as a guest, where the sheet asks
      // GET /api/me and must take the 401 of a signed-out visitor in its stride.
      const status = pathname === '/api/me' ? 401 : 404;
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: status === 401 ? 'Please sign in first' : 'no API in the harness' }));
      return;
    }
    const [prefix, base] = MOUNTS.find(([p]) => pathname.startsWith(p));
    let file = path.join(base, pathname.slice(prefix.length));
    if (!file.startsWith(base)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--port');
  const port = Number((i > 0 && process.argv[i + 1]) || 8210);
  createServer().listen(port, '127.0.0.1', () => console.log(`help harness on http://127.0.0.1:${port}/harness/ (pid ${process.pid})`));
}
