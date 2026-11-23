// Serving HTTPS without a proxy, with a certificate from Let's Encrypt (certbot) or any other CA.
// The HTTPS server re-reads its certificate and key files every minute and switches to them when
// they change, so a renewal needs no restart. Until they exist (the first certbot run needs the
// HTTP listener below to be up already), handshakes fail and the server keeps waiting for them.
// The HTTP listener answers ACME HTTP-01 challenges from a webroot (certbot certonly --webroot
// -w <dir>) and redirects everything else to HTTPS.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

// Loads the files into `server` (an https.Server) now, then checks them every `everyMs`.
// Returns the interval. A pair that can't be loaded (missing, half-written, or a cert and key
// that don't match) is logged once and the last good one stays in use.
export async function watchCertificate(server, { certFile, keyFile, everyMs = 60_000, log = console }) {
  let loaded = null;
  let lastError = '';
  const check = async () => {
    try {
      const [cert, key] = await Promise.all([fs.promises.readFile(certFile), fs.promises.readFile(keyFile)]);
      if (loaded && loaded.cert.equals(cert) && loaded.key.equals(key)) return;
      server.setSecureContext({ cert, key });
      loaded = { cert, key };
      lastError = '';
      log.log(`[tls] certificate loaded from ${certFile}, valid until ${new crypto.X509Certificate(cert).validTo}`);
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg !== lastError) log.error(`[tls] ${msg} (${loaded ? 'still using the certificate loaded before' : 'HTTPS answers nothing until this is fixed'})`);
      lastError = msg;
    }
  };
  await check();
  return setInterval(check, everyMs);
}

const CHALLENGE = /^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]+)$/;
const HOSTNAME = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])$/;

// Plain HTTP: GET /.well-known/acme-challenge/<token> is <webroot>/.well-known/acme-challenge/<token>;
// every other request is redirected to the same host and path on HTTPS port `httpsPort`.
// serverOptions: http.createServer's (the app's connection checking, server.js guardServer).
export function createAcmeServer({ webroot, httpsPort = 443, serverOptions = {} }) {
  return http.createServer(serverOptions, async (req, res) => {
    const url = String(req.url || '/');
    const m = CHALLENGE.exec(url.split('?')[0]);
    if (m) {
      let body = null;
      try {
        body = await fs.promises.readFile(path.join(webroot, '.well-known', 'acme-challenge', m[1]));
      } catch { /* not one of ours */ }
      res.writeHead(body ? 200 : 404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      return res.end(body ?? 'Not found');
    }
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    if (!HOSTNAME.test(host)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('Bad request');
    }
    res.writeHead(301, { Location: `https://${host}${httpsPort === 443 ? '' : `:${httpsPort}`}${url.startsWith('/') ? url : '/'}` });
    return res.end();
  });
}
