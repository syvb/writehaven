// Web Push (SPEC §22): RFC 8291 encryption against the RFC's own test vectors (Appendix A),
// RFC 8292 VAPID JWTs (the RFC's example verifies; ours sign and verify), the key file (made
// once, mode 600, reused), the subscription checks, and delivery to a local fake push service
// (TTL, Urgency, Content-Encoding, Authorization, a body the subscriber can decrypt, 404/410 as
// "gone"). No test talks to a real push service.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  b64u, unb64u, deriveKeys, encryptPayload, decryptPayload, vapidJwt, verifyVapidJwt, loadVapidKeys,
  generateVapidKeys, checkSubscription, allowedPushHost, createPusher, MAX_PAYLOAD,
} from '../lib/webpush.js';

// RFC 8291 §5 and Appendix A, verbatim (whitespace as printed is ignored by unb64u).
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV- JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  ecdhSecret: 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs',
  prkKey: 'Snr3JMxaHVDXHWJn5wdC52WjpCtd2EIEGBykDcZW32k',
  keyInfo: 'V2ViUHVzaDogaW5mbwAEJXGyvs3942BVG q8e0PTNNmwR zr5VX4m8t7GGpTM5FzFo7OLr4BhZe9MEebhuPI-OztV3 ylkYfpJGmQ22ggCLDgT-M_SrDepxkU21WCP3O1SUj0Ew bZIHMtu5pZpTKGSCIA5Zent7wmC6HCJ5mFgJkuk5cwAv MBKiiujwa7t45ewP',
  ikm: 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg',
  prk: '09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc',
  cek: 'oIhVW04MRdy2XN9CiKLxTg',
  nonce: '4h_95klXJ5E_qnoN',
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs bI_0LpXMuGvnzQ',
  // §5: the complete message body.
  body: `DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
         mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
         pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`,
};
const eq = (buf, b64) => assert.equal(b64u(buf), b64u(unb64u(b64)));

test('webpush: RFC 8291 Appendix A intermediate values', () => {
  const k = deriveKeys({ uaPublic: unb64u(RFC.uaPublic), authSecret: unb64u(RFC.auth), asPrivate: unb64u(RFC.asPrivate), salt: unb64u(RFC.salt) });
  eq(k.asPublic, RFC.asPublic);
  eq(k.ecdhSecret, RFC.ecdhSecret);
  eq(k.prkKey, RFC.prkKey);
  eq(k.keyInfo, RFC.keyInfo);
  eq(k.ikm, RFC.ikm);
  eq(k.prk, RFC.prk);
  eq(k.cek, RFC.cek);
  eq(k.nonce, RFC.nonce);
});

test('webpush: RFC 8291 §5 example message, byte for byte', () => {
  const plain = unb64u(RFC.plaintext);
  assert.equal(plain.toString('utf8'), 'When I grow up, I want to be a watermelon');
  const { body } = encryptPayload(plain, { p256dh: RFC.uaPublic, auth: RFC.auth }, { salt: unb64u(RFC.salt), asPrivate: unb64u(RFC.asPrivate) });
  const header = unb64u(RFC.header);
  assert.equal(header.length, 86);
  eq(body.subarray(0, 86), RFC.header);
  eq(body.subarray(86), RFC.ciphertext);
  eq(body, RFC.body);
  assert.equal(body.length, 144);
  // The receiving side recovers the text with the user agent's private key.
  assert.equal(decryptPayload(body, { uaPrivate: RFC.uaPrivate, auth: RFC.auth }).toString('utf8'), 'When I grow up, I want to be a watermelon');
});

test('webpush: random keys and salt round-trip; tampering is detected; size limit', () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const sub = { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) };
  const msg = JSON.stringify({ title: 'Dinner is here', body: 'Pizza in the kitchen. Ünïcödé ✓ 🍕' });
  const a = encryptPayload(msg, sub).body;
  const b = encryptPayload(msg, sub).body;
  assert.notEqual(b64u(a), b64u(b), 'fresh salt and sender key each time');
  assert.equal(decryptPayload(a, { uaPrivate: ua.getPrivateKey(), auth }).toString('utf8'), msg);
  const bad = Buffer.from(a);
  bad[bad.length - 20] ^= 1;
  assert.throws(() => decryptPayload(bad, { uaPrivate: ua.getPrivateKey(), auth }));
  assert.throws(() => decryptPayload(a, { uaPrivate: ua.getPrivateKey(), auth: crypto.randomBytes(16) }));
  assert.throws(() => encryptPayload('x'.repeat(MAX_PAYLOAD + 1), sub), /too large/);
  assert.equal(encryptPayload('x'.repeat(MAX_PAYLOAD), sub).body.length, 4096 - 0, 'a full payload fills the 4096-byte limit exactly');
});

test('webpush: RFC 8292 example JWT verifies with its key; ours sign and verify', () => {
  const rfcJwt = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL3B1c2guZXhhbXBsZS5uZXQiLCJleHAiOjE0NTM1MjM3NjgsInN1YiI6Im1haWx0bzpwdXNoQGV4YW1wbGUuY29tIn0.i3CYb7t4xfxCDquptFOepC9GAu_HLGkMlMuCGSK2rpiUfnK9ojFwDXb1JrErtmysazNjjvW2L9OkSSHzvoD1oA';
  const rfcKey = 'BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs';
  // The RFC's JWK (x, y) is the same key as its k= value.
  assert.equal(b64u(unb64u(rfcKey).subarray(1, 33)), 'DUfHPKLVFQzVvnCPGyfucbECzPDa7rWbXriLcysAjEc');
  assert.equal(b64u(unb64u(rfcKey).subarray(33)), 'F6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs');
  assert.deepEqual(verifyVapidJwt(rfcJwt, rfcKey), { aud: 'https://push.example.net', exp: 1453523768, sub: 'mailto:push@example.com' });
  const tampered = rfcJwt.replace('eyJhdWQiOiJodHRwczovL3B1c2guZXhhbXBsZS5uZXQi', 'eyJhdWQiOiJodHRwczovL3B1c2guZXhhbXBsZS5vcmci');
  assert.equal(verifyVapidJwt(tampered, rfcKey), null);

  const keys = generateVapidKeys();
  const keyObject = crypto.createPrivateKey({ key: keys.jwk, format: 'jwk' });
  const jwt = vapidJwt({ audience: 'https://fcm.googleapis.com', subject: 'https://writehaven.example.org', keyObject, exp: 2000000000 });
  const [h] = jwt.split('.');
  assert.deepEqual(JSON.parse(unb64u(h).toString()), { typ: 'JWT', alg: 'ES256' });
  assert.equal(unb64u(jwt.split('.')[2]).length, 64, 'raw r||s signature (IEEE P1363), not DER');
  assert.deepEqual(verifyVapidJwt(jwt, keys.publicKey), { aud: 'https://fcm.googleapis.com', exp: 2000000000, sub: 'https://writehaven.example.org' });
  assert.equal(verifyVapidJwt(jwt, generateVapidKeys().publicKey), null, 'another key does not verify');
  assert.equal(unb64u(keys.publicKey).length, 65);
});

test('webpush: VAPID keys are made once, kept with mode 600 and reused; a bad file is moved aside', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-vapid-'));
  try {
    const file = path.join(dir, 'vapid.json');
    const a = loadVapidKeys(file);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const b = loadVapidKeys(file);
    assert.equal(b.publicKey, a.publicKey);
    fs.chmodSync(file, 0o644);
    loadVapidKeys(file);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'permissions tightened again');
    fs.writeFileSync(file, '{"not": "keys"}');
    const errors = [];
    const c = loadVapidKeys(file, { log: { error: (m) => errors.push(m) } });
    assert.notEqual(c.publicKey, a.publicKey);
    assert.equal(errors.length, 1);
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('vapid.json.bad-')), 'the bad file is kept aside');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function browserKeys() {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ua, auth, keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) } };
}

test('webpush: subscriptions must point at a known push service, over https, with good keys', () => {
  const { keys } = browserKeys();
  const ok = [
    'https://fcm.googleapis.com/fcm/send/abc:def',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
    'https://web.push.apple.com/QGuQyavXutnMH',
    'https://wns2-par02p.notify.windows.com/w/?token=BQYAAA',
  ];
  for (const endpoint of ok) assert.equal(checkSubscription({ endpoint, keys }).endpoint, endpoint);
  const bad = [
    'http://fcm.googleapis.com/fcm/send/x', // not https
    'https://fcm.googleapis.com.evil.example/x',
    'https://evil.example/fcm.googleapis.com',
    'https://127.0.0.1/push',
    'https://localhost/push',
    'https://user:pw@fcm.googleapis.com/x',
    'https://fcm.googleapis.com:8443/x',
    'javascript:alert(1)',
    '',
  ];
  for (const endpoint of bad) assert.throws(() => checkSubscription({ endpoint, keys }), undefined, endpoint);
  assert.throws(() => checkSubscription({ endpoint: ok[0], keys: { ...keys, auth: b64u(crypto.randomBytes(8)) } }), /keys/);
  const notOnCurve = Buffer.alloc(65, 7);
  notOnCurve[0] = 4;
  assert.throws(() => checkSubscription({ endpoint: ok[0], keys: { ...keys, p256dh: b64u(notOnCurve) } }), /keys/);
  assert.throws(() => checkSubscription(null));
  assert.ok(allowedPushHost('fcm.googleapis.com'));
  assert.ok(!allowedPushHost('googleapis.com.example'));
  // Tests may allow a local fake service explicitly.
  assert.ok(checkSubscription({ endpoint: 'http://127.0.0.1:9/p', keys }, { allowHttp: true, allowHosts: ['127.0.0.1'] }));
});

// A fake push service: records requests, answers with the next queued status (201 by default).
async function fakePushService() {
  const got = [];
  const statuses = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      got.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      const s = statuses.length ? statuses.shift() : 201;
      res.writeHead(s, s === 429 ? { 'Retry-After': '7' } : {});
      res.end(s === 201 ? '' : `status ${s}`);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { got, statuses, base, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

test('webpush: delivery to a (fake) push service: headers, VAPID auth, decryptable body, gone on 404/410', async () => {
  const svc = await fakePushService();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-vapid-'));
  const keys = loadVapidKeys(path.join(dir, 'vapid.json'));
  const pusher = createPusher({ keys, subject: 'https://writehaven.example.org', allowHttp: true, allowHosts: ['127.0.0.1'] });
  try {
    const b = browserKeys();
    const sub = { endpoint: `${svc.base}/push/abc`, keys: b.keys };
    const payload = { id: 'n1', title: 'Dinner break', body: 'Until {t}.', times: { t: 1790000000000 }, url: '/write' };
    const r = await pusher.send(sub, payload, { ttl: 900, urgency: 'high', topic: 'break' });
    assert.deepEqual([r.status, r.ok, r.gone], [201, true, false]);
    const req = svc.got[0];
    assert.equal(req.url, '/push/abc');
    assert.equal(req.headers.ttl, '900');
    assert.equal(req.headers.urgency, 'high');
    assert.equal(req.headers.topic, 'break');
    assert.equal(req.headers['content-encoding'], 'aes128gcm');
    assert.equal(req.headers['content-type'], 'application/octet-stream');
    const m = /^vapid t=([^,\s]+), k=([A-Za-z0-9_-]+)$/.exec(req.headers.authorization);
    assert.ok(m, req.headers.authorization);
    assert.equal(m[2], keys.publicKey);
    const claims = verifyVapidJwt(m[1], keys.publicKey);
    assert.equal(claims.aud, svc.base);
    assert.equal(claims.sub, 'https://writehaven.example.org');
    const nowS = Date.now() / 1000;
    assert.ok(claims.exp > nowS + 3600 && claims.exp <= nowS + 24 * 3600, 'expires within a day (RFC 8292)');
    assert.deepEqual(JSON.parse(decryptPayload(req.body, { uaPrivate: b.ua.getPrivateKey(), auth: b.auth })), payload);

    svc.statuses.push(410, 404, 429, 500);
    const gone = await pusher.send(sub, payload);
    assert.deepEqual([gone.status, gone.ok, gone.gone], [410, false, true]);
    const gone2 = await pusher.send(sub, payload);
    assert.deepEqual([gone2.status, gone2.gone], [404, true]);
    const busy = await pusher.send(sub, payload);
    assert.deepEqual([busy.status, busy.gone, busy.retryAfter], [429, false, 7]);
    const err = await pusher.send(sub, payload);
    assert.deepEqual([err.status, err.ok, err.gone], [500, false, false]);
    // The JWT is reused for the same push service (signed once an hour, not per message).
    assert.equal(new Set(svc.got.map((g) => g.headers.authorization)).size, 1);

    // A refused endpoint never leaves the server; a dead one is a network error, not a throw.
    const refused = await pusher.send({ endpoint: 'https://evil.example/x', keys: b.keys }, payload);
    assert.equal(refused.status, 0);
    assert.equal(refused.code, 'unsupported-service');
    const dead = await pusher.send({ endpoint: 'http://127.0.0.1:1/x', keys: b.keys }, payload);
    assert.equal(dead.status, 0);
    assert.ok(dead.error);
    assert.equal(svc.got.length, 5);
  } finally {
    pusher.close();
    await svc.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
