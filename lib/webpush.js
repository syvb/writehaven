// Web Push with Node's crypto only (SPEC §22), no dependencies:
//   - VAPID (RFC 8292): a P-256 key pair made once and kept in the state dir (mode 600). Every
//     request carries `Authorization: vapid t=<ES256 JWT>, k=<public key>`.
//   - Message encryption (RFC 8291): ECDH with the subscription's key, HKDF-SHA-256, then
//     AES-128-GCM in the aes128gcm content coding (RFC 8188) as one record.
//   - Delivery (RFC 8030): POST to the subscription's endpoint with TTL and Urgency. 404 and 410
//     mean the subscription has gone; the caller prunes it.
// Only endpoints of the known push services are accepted (a subscription is user input, and
// the server must never be made to POST to arbitrary hosts).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';

export const b64u = (buf) => Buffer.from(buf).toString('base64url');
// base64url (or base64) to bytes; whitespace (as in the RFC examples) is ignored.
export const unb64u = (s) => Buffer.from(String(s ?? '').replace(/\s+/g, ''), 'base64url');

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const ONE = Buffer.from([1]);
const KEY_INFO = Buffer.from('WebPush: info\0', 'latin1');
const CEK_INFO = Buffer.from('Content-Encoding: aes128gcm\0', 'latin1');
const NONCE_INFO = Buffer.from('Content-Encoding: nonce\0', 'latin1');
export const RECORD_SIZE = 4096;
// Push services take at most 4096 bytes of body: 86 of header, 16 of tag, 1 delimiter.
export const MAX_PAYLOAD = 3993;

// The browser push services a subscription may point at (suffix match on the host name).
export const PUSH_SERVICES = Object.freeze([
  'fcm.googleapis.com', // Chrome, Edge on Android, Samsung Internet, Opera, Brave
  'android.googleapis.com', // older Chrome
  'push.services.mozilla.com', // Firefox (updates.push.services.mozilla.com)
  'push.apple.com', // Safari on macOS and iOS 16.4+ (web.push.apple.com)
  'notify.windows.com', // Edge on Windows (*.notify.windows.com)
]);

export class PushError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// ------------------------------------------------------------------ VAPID keys (RFC 8292)
export function rawPublicKey(jwk) {
  return Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]);
}
const jwkOfRaw = (raw) => ({ kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33, 65)) });

export function generateVapidKeys() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  return { jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d }, publicKey: b64u(rawPublicKey(jwk)) };
}

// A stored key set, checked: { jwk, publicKey, keyObject }. Throws if it isn't a P-256 key pair.
function readyKeys(raw) {
  const jwk = raw && raw.jwk;
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.x || !jwk.y) throw new Error('not a P-256 key');
  const keyObject = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d }, format: 'jwk' });
  const pub = crypto.createPublicKey(keyObject).export({ format: 'jwk' });
  if (pub.x !== jwk.x || pub.y !== jwk.y) throw new Error('public key does not match the private key');
  return { jwk, publicKey: b64u(rawPublicKey(jwk)), keyObject, createdAt: raw.createdAt ?? null };
}

// Written once, readable only by this user (mode 600), via a temp file, fsync and rename.
function writePrivateFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmp, 0o600); // whatever the umask
  fs.renameSync(tmp, file);
}

// The server's VAPID keys: read from `file`, or made and stored there the first time. A file
// that exists but can't be read as a key pair is moved aside (never silently overwritten).
export function loadVapidKeys(file, { log = console } = {}) {
  let text = null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e; // unreadable: don't replace keys every subscription depends on
  }
  if (text !== null) {
    try {
      const keys = readyKeys(JSON.parse(text));
      if ((fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
      return keys;
    } catch (e) {
      const aside = `${file}.bad-${Date.now()}`;
      fs.renameSync(file, aside);
      log.error(`[push] ${file} isn't a usable key pair (${e.message}); moved to ${aside}, made new keys (devices subscribe again)`);
    }
  }
  const made = { v: 1, ...generateVapidKeys(), createdAt: Date.now() };
  writePrivateFile(file, `${JSON.stringify(made, null, 1)}\n`);
  return readyKeys(made);
}

// An ES256 JWT for the push service at `audience` (its origin), valid until `exp` (seconds).
export function vapidJwt({ audience, subject, keyObject, exp }) {
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud: audience, exp, sub: subject }));
  const data = `${head}.${body}`;
  const sig = crypto.sign('sha256', Buffer.from(data), { key: keyObject, dsaEncoding: 'ieee-p1363' });
  return `${data}.${b64u(sig)}`;
}

// Checks a JWT's ES256 signature against a raw (65-byte, base64url) public key; returns its claims or null.
export function verifyVapidJwt(jwt, publicKey) {
  const parts = String(jwt).split('.');
  if (parts.length !== 3) return null;
  const raw = unb64u(publicKey);
  if (raw.length !== 65 || raw[0] !== 4) return null;
  const key = crypto.createPublicKey({ key: jwkOfRaw(raw), format: 'jwk' });
  const ok = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: 'ieee-p1363' }, unb64u(parts[2]));
  if (!ok) return null;
  try {
    const head = JSON.parse(unb64u(parts[0]).toString('utf8'));
    if (head.alg !== 'ES256') return null;
    return JSON.parse(unb64u(parts[1]).toString('utf8'));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ encryption (RFC 8291)
// The key schedule of RFC 8291 §3.3–3.4 (each step is HKDF with SHA-256, one block long), with
// every intermediate value so tests can check them against the RFC's Appendix A.
//   uaPublic: the subscription's p256dh (65 bytes); authSecret: its auth (16 bytes);
//   asPrivate: the sender's ephemeral private key (random unless given); salt: 16 random bytes.
export function deriveKeys({ uaPublic, authSecret, asPrivate = null, salt }) {
  const ecdh = crypto.createECDH('prime256v1');
  if (asPrivate) ecdh.setPrivateKey(asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey(null, 'uncompressed');
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, ecdhSecret); // HKDF-Extract(auth_secret, ecdh_secret)
  const keyInfo = Buffer.concat([KEY_INFO, uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, ONE])); // HKDF-Expand(PRK_key, key_info, 32)
  const prk = hmac(salt, ikm); // HKDF-Extract(salt, IKM)
  const cek = hmac(prk, Buffer.concat([CEK_INFO, ONE])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([NONCE_INFO, ONE])).subarray(0, 12);
  return { asPublic, ecdhSecret, prkKey, keyInfo, ikm, prk, cek, nonce };
}

// The aes128gcm body for one push message: header (salt, record size, sender key) + ciphertext.
export function encryptPayload(plaintext, { p256dh, auth }, { salt = crypto.randomBytes(16), asPrivate = null, rs = RECORD_SIZE } = {}) {
  const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
  if (data.length > MAX_PAYLOAD) throw new PushError(`Push payload too large (${data.length} bytes)`, 'too-large');
  const uaPublic = Buffer.isBuffer(p256dh) ? p256dh : unb64u(p256dh);
  const authSecret = Buffer.isBuffer(auth) ? auth : unb64u(auth);
  const k = deriveKeys({ uaPublic, authSecret, asPrivate, salt });
  const cipher = crypto.createCipheriv('aes-128-gcm', k.cek, k.nonce);
  // One record, the last one: the plaintext, then the 0x02 delimiter (no further padding).
  const ct = Buffer.concat([cipher.update(data), cipher.update(Buffer.from([2])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(rs, 16);
  header[20] = k.asPublic.length;
  return { body: Buffer.concat([header, k.asPublic, ct]), ...k };
}

// The receiving side (tests, and the fake push service in them): the plaintext of an
// aes128gcm body for the subscription whose private key is `uaPrivate`.
export function decryptPayload(body, { uaPrivate, auth }) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.isBuffer(uaPrivate) ? uaPrivate : unb64u(uaPrivate));
  const uaPublic = ecdh.getPublicKey(null, 'uncompressed');
  const authSecret = Buffer.isBuffer(auth) ? auth : unb64u(auth);
  const ecdhSecret = ecdh.computeSecret(asPublic);
  const prkKey = hmac(authSecret, ecdhSecret);
  const ikm = hmac(prkKey, Buffer.concat([KEY_INFO, uaPublic, asPublic, ONE]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([CEK_INFO, ONE])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([NONCE_INFO, ONE])).subarray(0, 12);
  const rec = body.subarray(21 + idlen);
  if (rec.length > rs) throw new Error('more than one record');
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(rec.subarray(rec.length - 16));
  const plain = Buffer.concat([decipher.update(rec.subarray(0, rec.length - 16)), decipher.final()]);
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  if (end < 0 || plain[end] !== 2) throw new Error('bad padding delimiter');
  return plain.subarray(0, end);
}

// ------------------------------------------------------------------ subscriptions
const isPlainObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

export function allowedPushHost(host, list = PUSH_SERVICES) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  return list.some((d) => h === d || h.endsWith(`.${d}`));
}

// A browser's PushSubscription (its toJSON()), checked: { endpoint, p256dh, auth } or a PushError.
// allowHosts / allowHttp: for tests with a local fake push service only.
export function checkSubscription(sub, { allowHosts = null, allowHttp = false } = {}) {
  if (!isPlainObject(sub)) throw new PushError('Missing subscription', 'bad-subscription');
  const endpoint = typeof sub.endpoint === 'string' ? sub.endpoint.trim() : '';
  if (!endpoint || endpoint.length > 2048) throw new PushError('Bad push endpoint', 'bad-subscription');
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new PushError('Bad push endpoint', 'bad-subscription');
  }
  const local = allowHttp && url.protocol === 'http:';
  if ((url.protocol !== 'https:' && !local) || url.username || url.password) throw new PushError('Bad push endpoint', 'bad-subscription');
  if ((url.port && url.port !== '443' && !local) || !allowedPushHost(url.hostname, allowHosts || PUSH_SERVICES)) {
    throw new PushError('This browser’s push service isn’t supported here', 'unsupported-service');
  }
  const keys = isPlainObject(sub.keys) ? sub.keys : {};
  const p256dh = unb64u(keys.p256dh);
  const auth = unb64u(keys.auth);
  if (p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) throw new PushError('Bad subscription keys', 'bad-subscription');
  try {
    const probe = crypto.createECDH('prime256v1');
    probe.generateKeys();
    probe.computeSecret(p256dh); // throws unless it's a point on P-256
  } catch {
    throw new PushError('Bad subscription keys', 'bad-subscription');
  }
  return { endpoint, p256dh: b64u(p256dh), auth: b64u(auth) };
}

// ------------------------------------------------------------------ delivery (RFC 8030)
// A sender bound to the server's keys. send() resolves (never rejects) with
//   { status, ok, gone, retryAfter, error? }: ok for 2xx (push services answer 201), gone for 404
//   and 410 (prune the subscription), status 0 for a network error or timeout.
export function createPusher({ keys, subject, allowHosts = null, allowHttp = false, timeoutMs = 15_000, jwtTtlSec = 12 * 3600, now = Date.now } = {}) {
  if (!keys || !keys.keyObject) throw new Error('createPusher: keys required');
  const agents = { 'https:': new https.Agent({ keepAlive: true, maxSockets: 8 }), 'http:': new http.Agent({ keepAlive: true, maxSockets: 8 }) };
  const jwts = new Map(); // audience -> { header, until }

  function authHeader(audience) {
    const t = Math.floor(now() / 1000);
    const hit = jwts.get(audience);
    if (hit && hit.until > t) return hit.header;
    const exp = t + jwtTtlSec;
    const jwt = vapidJwt({ audience, subject, keyObject: keys.keyObject, exp });
    const header = `vapid t=${jwt}, k=${keys.publicKey}`;
    jwts.set(audience, { header, until: exp - 3600 }); // signed again an hour before it expires
    return header;
  }

  function send(sub, payload, { ttl = 3600, urgency = 'normal', topic = null } = {}) {
    return new Promise((resolve) => {
      let clean;
      let body;
      try {
        clean = checkSubscription(sub, { allowHosts, allowHttp });
        const text = typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload);
        body = encryptPayload(text, clean).body;
      } catch (e) {
        resolve({ status: 0, ok: false, gone: false, retryAfter: null, error: e.message, code: e.code || 'bad' });
        return;
      }
      const url = new URL(clean.endpoint);
      const headers = {
        TTL: String(Math.max(0, Math.min(2_419_200, Math.round(ttl)))),
        Urgency: ['very-low', 'low', 'normal', 'high'].includes(urgency) ? urgency : 'normal',
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'Content-Length': body.length,
        Authorization: authHeader(`${url.protocol}//${url.host}`),
      };
      if (topic && /^[A-Za-z0-9_-]{1,32}$/.test(topic)) headers.Topic = topic;
      const lib = url.protocol === 'http:' ? http : https;
      let done = false;
      const finish = (r) => {
        if (done) return;
        done = true;
        resolve(r);
      };
      const req = lib.request(url, { method: 'POST', headers, agent: agents[url.protocol] }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size <= 2048) chunks.push(c);
        });
        res.on('end', () => {
          const status = res.statusCode;
          const ra = Number(res.headers['retry-after']);
          finish({
            status, ok: status >= 200 && status < 300, gone: status === 404 || status === 410,
            retryAfter: Number.isFinite(ra) && ra >= 0 ? ra : null,
            error: status >= 300 ? Buffer.concat(chunks).toString('utf8').slice(0, 300) || `HTTP ${status}` : undefined,
          });
        });
        res.on('error', (e) => finish({ status: 0, ok: false, gone: false, retryAfter: null, error: e.message }));
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error('timed out')));
      req.on('error', (e) => finish({ status: 0, ok: false, gone: false, retryAfter: null, error: e.message }));
      req.end(body);
    });
  }

  return {
    publicKey: keys.publicKey,
    send,
    close() {
      agents['https:'].destroy();
      agents['http:'].destroy();
    },
  };
}
