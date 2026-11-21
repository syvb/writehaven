import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { startApp, sleep } from './helpers.js';
import { createAcmeServer } from '../lib/tls.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wh-tls-'));

function request(mod, port, p, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = mod.request({ host: '127.0.0.1', port, path: p, method, headers, agent: false, rejectUnauthorized: false }, (res) => {
      const fp = res.socket.getPeerX509Certificate?.()?.fingerprint256;
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, fp }));
    });
    r.on('error', reject);
    r.end(body);
  });
}

test('tls: the HTTP listener answers ACME challenges and redirects the rest to HTTPS', async (t) => {
  const webroot = tmpDir();
  fs.mkdirSync(path.join(webroot, '.well-known', 'acme-challenge'), { recursive: true });
  fs.writeFileSync(path.join(webroot, '.well-known', 'acme-challenge', 'Tok-en_1'), 'Tok-en_1.thumb');
  fs.writeFileSync(path.join(webroot, 'secret.txt'), 'not public');
  const srv = createAcmeServer({ webroot, httpsPort: 8443 });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const port = srv.address().port;

  let r = await request(http, port, '/.well-known/acme-challenge/Tok-en_1', { headers: { Host: 'party.example' } });
  assert.equal(r.status, 200);
  assert.equal(r.text, 'Tok-en_1.thumb');
  r = await request(http, port, '/.well-known/acme-challenge/other');
  assert.equal(r.status, 404);
  r = await request(http, port, '/.well-known/acme-challenge/..%2F..%2Fsecret.txt', { headers: { Host: 'party.example' } });
  assert.notEqual(r.text, 'not public');

  r = await request(http, port, '/write?post=a1', { headers: { Host: 'party.example:80' } });
  assert.equal(r.status, 301);
  assert.equal(r.headers.location, 'https://party.example:8443/write?post=a1');
  r = await request(http, port, '/', { headers: { Host: 'evil.example/x?' } });
  assert.equal(r.status, 400);

  const srv443 = createAcmeServer({ webroot });
  await new Promise((res) => srv443.listen(0, '127.0.0.1', res));
  t.after(() => srv443.close());
  r = await request(http, srv443.address().port, '/live', { headers: { Host: '[2001:db8::1]:80' } });
  assert.equal(r.headers.location, 'https://[2001:db8::1]/live');
});

test('tls: HTTPS waits for the certificate, serves with Secure cookies, and picks up a renewed one', async (t) => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
  } catch {
    t.skip('needs openssl to make test certificates');
    return;
  }
  const dir = tmpDir();
  const make = (name) => {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '2',
      '-subj', '/CN=localhost', '-keyout', path.join(dir, `${name}.key`), '-out', path.join(dir, `${name}.crt`)], { stdio: 'ignore' });
    const cert = fs.readFileSync(path.join(dir, `${name}.crt`));
    return { cert, key: fs.readFileSync(path.join(dir, `${name}.key`)), fp: new crypto.X509Certificate(cert).fingerprint256 };
  };
  const a = make('a');
  const b = make('b');
  const certFile = path.join(dir, 'live', 'fullchain.pem');
  const keyFile = path.join(dir, 'live', 'privkey.pem');
  const install = (cert, key) => {
    fs.mkdirSync(path.dirname(certFile), { recursive: true });
    fs.writeFileSync(certFile, cert);
    fs.writeFileSync(keyFile, key);
  };
  const { app, close } = await startApp({ tls: { certFile, keyFile, everyMs: 50 } });
  t.after(close);
  const port = app.server.address().port;
  const servedFp = async () => {
    try {
      return (await request(https, port, '/healthz')).fp;
    } catch {
      return null; // no certificate: the handshake fails
    }
  };
  const waitFor = async (fp) => {
    for (let i = 0; i < 100 && (await servedFp()) !== fp; i++) await sleep(20);
    return servedFp();
  };

  assert.equal(await servedFp(), null);
  install(a.cert, a.key);
  assert.equal(await waitFor(a.fp), a.fp);

  const r = await request(https, port, '/api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WH': '1' },
    body: JSON.stringify({ username: 'host', password: 'longpassword', name: 'Host' }),
  });
  assert.equal(r.status, 200);
  assert.match(String(r.headers['set-cookie']), /wh_sess=[^;]+;.*Secure/);

  // A renewal caught half-written (the new certificate, the old key) keeps the old pair...
  install(b.cert, a.key);
  await sleep(200);
  assert.equal(await servedFp(), a.fp);
  // ...until both files are new.
  install(b.cert, b.key);
  assert.equal(await waitFor(b.fp), b.fp);
});
