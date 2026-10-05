// Tiny static server for the interop QA harness (dev only).
//   /            -> public/
//   /qa/         -> tools/interop-qa/
//   /qa-out/     -> qa/interop/ (exports saved by the test run)
//   /u/          -> tools/interop-qa/fixtures/uploads/ (stand-ins for uploaded images)
// Sends the same CSP as the app. Port: --port N or env PORT (default 8111). Writes its PID to
// .server-<port>.pid (removed on exit), so runs on different ports don't clash.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const portArg = process.argv.indexOf('--port');
const PORT = Number((portArg > 0 && process.argv[portArg + 1]) || process.env.PORT || 8111);
const PID_FILE = path.join(here, '.server-' + PORT + '.pid');
const MOUNTS = [
  ['/qa-out/', path.join(root, 'qa/interop')],
  ['/u/hotlink-ok/', path.join(here, 'fixtures/uploads')], // the address copies and exports use
  ['/u/', path.join(here, 'fixtures/uploads')],
  ['/qa/', here],
  ['/', path.join(root, 'public')],
];
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.xhtml': 'application/xhtml+xml; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
};
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "media-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

// /u/ files are typed from their bytes, as the app serves uploads (a host-removed image is an SVG
// placeholder under the original name).
function sniffImage(b) {
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/.test(b.toString('utf8', 0, 200))) return 'image/svg+xml';
  return null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  const mount = MOUNTS.find(([prefix]) => pathname.startsWith(prefix));
  const base = mount[1];
  let file = path.join(base, pathname.slice(mount[0].length));
  if (!file.startsWith(base)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, data) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    const type = mount[0].startsWith('/u/') ? sniffImage(data) : TYPES[path.extname(file).toLowerCase()];
    res.writeHead(200, { 'Content-Type': type || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  fs.writeFileSync(PID_FILE, String(process.pid));
  console.log('interop-qa server on http://127.0.0.1:' + PORT + ' pid ' + process.pid);
});
const stop = () => {
  try {
    fs.unlinkSync(PID_FILE);
  } catch (err) {
    /* already gone */
  }
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
