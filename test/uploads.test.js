// Image uploads (SPEC §14): type sniffing, metadata stripping, quota, auth/CSRF, serving, path
// safety and host removal. Fixtures are tiny real images made with Pillow, each carrying
// metadata that must not survive: EXIF with GPS, XMP, IPTC, comments, text chunks, trailers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApp, client, sleep } from './helpers.js';
import { createUploads, sniff, stripMetadata, imageSize, normalizeName, LIMITS, REMOVED_SVG } from '../lib/uploads.js';

const FX = {
  // 24x16 baseline JPEG: APP13 (IPTC), EXIF (maker, model, GPS), COM and a "motion photo" trailer.
  jpeg: '/9j/7QAsUGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAABBJUFRDLXNlY3JldC1jaXR5/+AAEEpGSUYAAQEAAAEAAQAA/+EAvkV4aWYAAE1NACoAAAAIAAMBDwACAAAAEQAAADIBEAACAAAADAAAAESIJQAEAAAAAQAAAFAAAAAAU2VjcmV0UGhvbmVNYWtlcgAAU2VjcmV0TW9kZWwAAAQAAQACAAAAAk4AAAAAAgAFAAAAAwAAAIYAAwACAAAAAlcAAAAABAAFAAAAAwAAAJ4AAAAAAAAAMwAAAAEAAAAeAAAAAQAAABkAAAACAAAAAAAAAAEAAAAHAAAAAQAAACcAAAAB//4AFHNlY3JldC1jb21tZW50LXh5ev/bAEMABgQFBgUEBgYFBgcHBggKEAoKCQkKFA4PDBAXFBgYFxQWFhodJR8aGyMcFhYgLCAjJicpKikZHy0wLSgwJSgpKP/bAEMBBwcHCggKEwoKEygaFhooKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKP/AABEIABAAGAMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgv/xAC1EAACAQMDAgQDBQUEBAAAAX0BAgMABBEFEiExQQYTUWEHInEUMoGRoQgjQrHBFVLR8CQzYnKCCQoWFxgZGiUmJygpKjQ1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4eLj5OXm5+jp6vHy8/T19vf4+fr/xAAfAQADAQEBAQEBAQEBAAAAAAAAAQIDBAUGBwgJCgv/xAC1EQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/APIrHw70+T9K6Gx8O9Pkr0Ox8O9Pk/SuisfDvT5P0rtxOeeZ4+R8R7annlj4d6fJ+lFeyWPh3p8n6UV4dTPPe3P1TBcR/ulqf//ZTU9USU9OUEhPVE8tdHJhaWxlci1zZWNyZXQtbXA0',
  // 24x16 progressive JPEG with EXIF (GPS).
  jpegProgressive: '/9j/4AAQSkZJRgABAQAAAQABAAD/4QC+RXhpZgAATU0AKgAAAAgAAwEPAAIAAAARAAAAMgEQAAIAAAAMAAAARIglAAQAAAABAAAAUAAAAABTZWNyZXRQaG9uZU1ha2VyAABTZWNyZXRNb2RlbAAABAABAAIAAAACTgAAAAACAAUAAAADAAAAhgADAAIAAAACVwAAAAAEAAUAAAADAAAAngAAAAAAAAAzAAAAAQAAAB4AAAABAAAAGQAAAAIAAAAAAAAAAQAAAAcAAAABAAAAJwAAAAH/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wgARCAAQABgDASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAABgAF/8QAFgEBAQEAAAAAAAAAAAAAAAAABAMG/9oADAMBAAIQAxAAAAEhoodGwz0yg6r/xAAWEAADAAAAAAAAAAAAAAAAAAAAAgT/2gAIAQEAAQUCScScScScScSc/8QAGBEAAgMAAAAAAAAAAAAAAAAAAAUDBCL/2gAIAQMBAT8BosSFjk//xAAYEQACAwAAAAAAAAAAAAAAAAAABAIDIf/aAAgBAgEBPwGx4k9p/8QAFBABAAAAAAAAAAAAAAAAAAAAIP/aAAgBAQAGPwJf/8QAFRABAQAAAAAAAAAAAAAAAAAAAGH/2gAIAQEAAT8hmmmmmm//2gAMAwEAAgADAAAAELgv/8QAFhEBAQEAAAAAAAAAAAAAAAAAIQAx/9oACAEDAQE/EMWO3//EABYRAQEBAAAAAAAAAAAAAAAAAABRYf/aAAgBAgEBPxDZQ//EABYQAQEBAAAAAAAAAAAAAAAAAAAxwf/aAAgBAQABPxCGUGGUMoZQy//Z',
  // 20x12 RGBA PNG: tIME, tEXt, zTXt, iTXt, eXIf, and bytes after IEND.
  png: 'iVBORw0KGgoAAAANSUhEUgAAABQAAAAMCAYAAABiDJ37AAAAB3RJTUUH6goECR4AZUkZ4gAAABl0RVh0Q29tbWVudABzZWNyZXQtdGV4dC1jaHVuawYxrncAAAAjelRYdExvY2F0aW9uAAB4nCtOTS5KLdGtKqko0U3OKM3LBgA9lAbUv9Bv0wAAACRpVFh0QXV0aG9yAAAAZW4AQXV0aG9yAHNlY3JldC1pdHh0LWNodW5rLhJ+awAAALZlWElmTU0AKgAAAAgAAwEPAAIAAAARAAAAMgEQAAIAAAAMAAAARIglAAQAAAABAAAAUAAAAABTZWNyZXRQaG9uZU1ha2VyAABTZWNyZXRNb2RlbAAABAABAAIAAAACTgAAAAACAAUAAAADAAAAhgADAAIAAAACVwAAAAAEAAUAAAADAAAAngAAAAAAAAAzAAAAAQAAAB4AAAABAAAAGQAAAAIAAAAAAAAAAQAAAAcAAAABAAAAJwAAAAE3m2teAAAAKklEQVR4nGNkYGg4wcPAwMCLhCnhszCIMlAVDAUDxaht4OD38mgYDjoDAVz8A1FgUTGMAAAAAElFTkSuQmCCVFJBSUxJTkctc2VjcmV0',
  // 20x14 lossy WebP (VP8X) with EXIF and XMP chunks.
  webp: 'UklGRowBAABXRUJQVlA4WAoAAAAMAAAAEwAADQAAVlA4IGoAAAAwBACdASoUAA4APm00k0akIyGhMAgAgA2JbACdMoRwL8AAqO/lS7RKGoAA/vwDy7n2zcksKPpwIGEl5f9sEo/EwVk2j/Tfus9Z41pPX/Wnr/BtklHloAr/4yMmpeLVFP02Aszy4KRJmAAARVhJRrYAAABNTQAqAAAACAADAQ8AAgAAABEAAAAyARAAAgAAAAwAAABEiCUABAAAAAEAAABQAAAAAFNlY3JldFBob25lTWFrZXIAAFNlY3JldE1vZGVsAAAEAAEAAgAAAAJOAAAAAAIABQAAAAMAAACGAAMAAgAAAAJXAAAAAAQABQAAAAMAAACeAAAAAAAAADMAAAABAAAAHgAAAAEAAAAZAAAAAgAAAAAAAAABAAAABwAAAAEAAAAnAAAAAVhNUCA+AAAAPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyI+c2VjcmV0LXhtcC1ncHM8L3g6eG1wbWV0YT4=',
  // 10x6 lossless WebP with alpha and EXIF.
  webpLossless: 'UklGRgwBAABXRUJQVlA4WAoAAAAYAAAACQAABQAAVlA4TDAAAAAvCUABEJkyRPQ/NhHR/4CCtm0Y4+n4Q7wMBAIpTOMHcJIJJmmq7RgWpn0A3cLA8wBFWElGtgAAAE1NACoAAAAIAAMBDwACAAAAEQAAADIBEAACAAAADAAAAESIJQAEAAAAAQAAAFAAAAAAU2VjcmV0UGhvbmVNYWtlcgAAU2VjcmV0TW9kZWwAAAQAAQACAAAAAk4AAAAAAgAFAAAAAwAAAIYAAwACAAAAAlcAAAAABAAFAAAAAwAAAJ4AAAAAAAAAMwAAAAEAAAAeAAAAAQAAABkAAAACAAAAAAAAAAEAAAAHAAAAAQAAACcAAAAB',
  // 12x8 animated GIF (2 frames, looping) with a comment and an XMP application extension.
  gif: 'R0lGODlhDAAIAIUAAAAAZjMAZmYAZpkAZswAZv8AZgAzZjMzZmYzZpkzZswzZv8zZgBmZjNmZmZmZplmZsxmZv9mZgCZZjOZZmaZZpmZZsyZZgDMZjPMZmbMZpnMZszMZgAAmTMAmWYAmZkAmcwAmf8AmQAzmTMzmWYzmZkzmcwzmQBmmTNmmWZmmZlmmcxmmf9mmQCZmTOZmWaZmZmZmcyZmf+ZmQDMmTPMmWbMmZnMmczMmf//mQAAAAAAAAAAAAAAAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh/hJzZWNyZXQtZ2lmLWNvbW1lbnQAIfkEAAoAAAAh/wtYTVAgRGF0YVhNUA5zZWNyZXQtZ2lmLXhtcAAsAAAAAAwACAAACGkAOQDoEMCDAA8DPhAAUcBAhwMdEJAYUGKACQUhRBgYcYCExAQlFJhYwOBEAxQOUjxQ8WAFBBYnJqCYkIJCigowIMSIIKHFBBcUXlCAYSGGBRkzLtDAUCODDQ02NtzYoBQDjQxNn07FERAAIfkEAQoANwAsAAAAAAwACACFAABmMwBmZgBmmQBmzABmADNmMzNmZjNmmTNmzDNmAGZmM2ZmZmZmmWZmzGZmAJlmM5lmZplmmZlmzJlm/5lmAMxmM8xmZsxmmcxmzMxm/8xmAACZMwCZZgCZmQCZzACZ/wCZMzOZZjOZmTOZzDOZ/zOZAGaZM2aZZmaZmWaZzGaZ/2aZAJmZM5mZZpmZmZmZzJmZAMyZM8yZZsyZmcyZzMyZAP+ZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACGcAQRD4MMDDjRsCOATYACDBhwQeEIwQICJAiAIbSiQgIfHggRAGLjpQ4SBFgxQMUCw4ocDEigkqJKQ4GKHFAhYKKMCY8ELCixsuILR4wKJGhhoYaNyYcUGGhRgVNBilkXSpBRkVbAQEADs=',
};
const fx = (k) => Buffer.from(FX[k], 'base64');
const KIND_OF = { jpeg: 'jpeg', jpegProgressive: 'jpeg', png: 'png', webp: 'webp', webpLossless: 'webp', gif: 'gif' };
const SIZE_OF = { jpeg: [24, 16], jpegProgressive: [24, 16], png: [20, 12], webp: [20, 14], webpLossless: [10, 6], gif: [12, 8] };
// Words that only exist in the metadata the fixtures carry.
const LEAKS = ['secret', 'Secret', 'Exif', 'GPS', 'IPTC', 'Photoshop', 'xmp', 'XMP', 'MOTION', 'TRAILING', 'tIME', 'tEXt', 'zTXt', 'iTXt', 'eXIf', 'EXIF'];
const leaksIn = (buf) => LEAKS.filter((w) => buf.toString('latin1').includes(w));

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-up-'));
  process.on('exit', () => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

// An app with the upload routes; the first account is the host, then a writer.
async function setup({ limits, approvalRequired = false, dir = tmpDir() } = {}) {
  const uploads = createUploads({ dir, limits, log: { error() {}, log() {}, warn() {} } });
  const ctx = await startApp({ routes: uploads.routes, approvalRequired });
  const host = client(ctx.base);
  await host.post('/api/register', { username: 'host', password: 'longpassword', name: 'Host' });
  const ana = client(ctx.base);
  const r = await ana.post('/api/register', { username: 'ana', password: 'longpassword', name: 'Ana' });
  return { ...ctx, uploads, dir, host, ana, anaId: r.json.user.id };
}

// POST raw bytes like the editor does (XHR with the X-WH header and the cookie).
async function upload(base, who, bytes, { headers = {} } = {}) {
  const h = { 'Content-Type': 'image/webp', 'X-WH': '1', ...headers };
  if (who && who.cookie) h.Cookie = who.cookie;
  for (const [k, v] of Object.entries(h)) if (v === null) delete h[k];
  const res = await fetch(`${base}/api/uploads`, { method: 'POST', headers: h, body: bytes });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, headers: res.headers };
}

test('uploads: limits are the spec’s (8 MB, 40 files, 60 MB)', () => {
  assert.equal(LIMITS.maxBytes, 8 * 1024 * 1024);
  assert.equal(LIMITS.maxFiles, 40);
  assert.equal(LIMITS.maxTotalBytes, 60 * 1024 * 1024);
});

test('uploads: magic-byte sniffing accepts PNG, JPEG, WebP and GIF only', () => {
  for (const k of Object.keys(FX)) assert.equal(sniff(fx(k)), KIND_OF[k], k);
  const no = [
    Buffer.from('<!doctype html><html><script>alert(1)</script></html>'),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'),
    Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj'),
    Buffer.from('PK\x03\x04\x14\x00\x00\x00\x08\x00rest-of-a-zip', 'latin1'),
    Buffer.from('RIFF\x10\x00\x00\x00WAVEfmt ', 'latin1'), // RIFF, but not WebP
    Buffer.from('GIF88a............', 'latin1'),
    Buffer.from([0x89, 0x50, 0x4e]), // too short
    Buffer.alloc(0),
  ];
  for (const b of no) assert.equal(sniff(b), null, b.toString('latin1').slice(0, 12));
});

test('uploads: metadata is stripped and the image itself is untouched', () => {
  for (const k of Object.keys(FX)) {
    const input = fx(k);
    assert.ok(leaksIn(input).length > 0, `${k} fixture carries metadata`);
    const out = stripMetadata(input, KIND_OF[k]);
    assert.deepEqual(leaksIn(out), [], `${k}: nothing identifying survives`);
    assert.equal(sniff(out), KIND_OF[k], `${k}: still the same type`);
    const [w, h] = SIZE_OF[k];
    assert.deepEqual(imageSize(out, KIND_OF[k]), { w, h }, `${k}: size readable`);
    assert.ok(out.length < input.length, `${k}: smaller`);
  }
  // JPEG: kept JFIF and every scan; dropped APP1, APP13, COM and the trailer after EOI.
  const jpg = stripMetadata(fx('jpeg'), 'jpeg');
  assert.deepEqual([...jpg.subarray(-2)], [0xff, 0xd9]);
  assert.ok(jpg.includes(Buffer.from('JFIF')));
  assert.ok(!jpg.includes(Buffer.from([0xff, 0xe1])) && !jpg.includes(Buffer.from([0xff, 0xed])) && !jpg.includes(Buffer.from([0xff, 0xfe])));
  // The entropy-coded data is copied byte for byte: the scan is the tail of the input up to EOI.
  const inJ = fx('jpeg');
  const sos = inJ.lastIndexOf(Buffer.from([0xff, 0xda]));
  const eoi = inJ.lastIndexOf(Buffer.from([0xff, 0xd9]));
  assert.ok(jpg.includes(inJ.subarray(sos, eoi + 2)));
  // PNG: ends at IEND; no text or time chunks.
  const png = stripMetadata(fx('png'), 'png');
  assert.equal(png.toString('latin1', png.length - 8, png.length - 4), 'IEND');
  // WebP: RIFF size matches, VP8X no longer claims EXIF/XMP.
  for (const k of ['webp', 'webpLossless']) {
    const wp = stripMetadata(fx(k), 'webp');
    assert.equal(wp.readUInt32LE(4), wp.length - 8);
    assert.equal(wp.toString('latin1', 12, 16), 'VP8X');
    assert.equal(wp[20] & 0x0c, 0, 'EXIF and XMP flags cleared');
  }
  // GIF: both frames and the looping extension stay; it ends with the trailer.
  const gif = stripMetadata(fx('gif'), 'gif');
  assert.ok(gif.includes(Buffer.from('NETSCAPE2.0')));
  assert.equal(gif[gif.length - 1], 0x3b);
  assert.equal(gif.toString('latin1').split('\x2c\x00\x00\x00\x00').length - 1, 2, 'two frames');
});

test('uploads: damaged files are refused', () => {
  const png = fx('png');
  assert.throws(() => stripMetadata(png.subarray(0, 40), 'png'));
  assert.throws(() => stripMetadata(Buffer.concat([png.subarray(0, 8), Buffer.from('garbage-chunk-data')]), 'png'));
  assert.throws(() => stripMetadata(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff]), 'jpeg'));
  assert.throws(() => stripMetadata(fx('gif').subarray(0, 30), 'gif'));
  assert.throws(() => stripMetadata(fx('webp').subarray(0, 40), 'webp'));
});

test('uploads: names from paths, URLs and fragments; nothing else', () => {
  const hex = 'a'.repeat(32);
  assert.equal(normalizeName(`${hex}.webp`), hex);
  assert.equal(normalizeName(`/u/${hex}.jpg#w=1200&h=800`), hex);
  assert.equal(normalizeName(`https://writehaven.example/u/${hex}.png?x=1`), hex);
  assert.equal(normalizeName(`/u/hotlink-ok/${hex}.webp#w=10&h=20`), hex);
  assert.equal(normalizeName(`https://writehaven.example/u/hotlink-ok/${hex}.png`), hex);
  assert.equal(normalizeName(hex), hex);
  for (const bad of ['', null, '../state.json', `/u/../${hex}.png`, `${hex}.svg`, `${hex.toUpperCase()}.png`, 'index.json', `${hex}.png/../x`]) {
    assert.equal(normalizeName(bad), null, String(bad));
  }
});

test('http uploads: auth, CSRF, type, size; served with the sniffed type and long cache', async (t) => {
  const s = await setup({ limits: { maxBytes: 64 * 1024 } });
  t.after(s.close);
  // Signed out: 401. No X-WH: 403. Not an image: 415. Too big: 413. Empty: 400.
  assert.equal((await upload(s.base, null, fx('jpeg'))).status, 401);
  assert.equal((await upload(s.base, s.ana, fx('jpeg'), { headers: { 'X-WH': null } })).status, 403);
  let r = await upload(s.base, s.ana, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
  assert.equal(r.status, 415);
  assert.equal(r.json.code, 'type');
  assert.match(r.json.error, /PNG, JPEG, WebP and GIF/);
  r = await upload(s.base, s.ana, Buffer.concat([fx('png'), Buffer.alloc(70 * 1024)]));
  assert.equal(r.status, 413);
  assert.equal(r.json.code, 'too-large');
  r = await upload(s.base, s.ana, Buffer.concat([fx('png').subarray(0, 8), Buffer.from('broken')]));
  assert.equal(r.status, 415);
  assert.equal(r.json.code, 'damaged');
  assert.equal((await upload(s.base, s.ana, Buffer.alloc(0))).status, 400);

  // A JPEG sent as "image/webp": stored and served as what it is.
  r = await upload(s.base, s.ana, fx('jpeg'));
  assert.equal(r.status, 200);
  assert.match(r.json.url, /^\/u\/[0-9a-f]{32}\.jpg$/);
  assert.equal(r.json.type, 'image/jpeg');
  assert.deepEqual([r.json.w, r.json.h], [24, 16]);
  assert.deepEqual(r.json.used, { files: 1, bytes: r.json.bytes });
  const url = r.json.url;
  const res = await fetch(s.base + url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const body = Buffer.from(await res.arrayBuffer());
  assert.deepEqual(body, stripMetadata(fx('jpeg'), 'jpeg'));
  assert.deepEqual(leaksIn(body), []);
  // HEAD and conditional GET.
  const head = await fetch(s.base + url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(body.length));
  const etag = res.headers.get('etag');
  assert.equal((await fetch(s.base + url, { headers: { 'If-None-Match': etag } })).status, 304);
  // Anyone with the address can load it (readers of the live page aren't signed in).
  assert.equal((await fetch(s.base + url, { headers: {} })).status, 200);
  // The address copies and exports use (/u/hotlink-ok/…) serves the same bytes, and other sites
  // may show or fetch it.
  const alias = await fetch(s.base + url.replace('/u/', '/u/hotlink-ok/'));
  assert.equal(alias.status, 200);
  assert.deepEqual(Buffer.from(await alias.arrayBuffer()), body);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin');
  assert.equal((await fetch(s.base + url.replace('/u/', '/u/hotlink-ok/x/'))).status, 404);

  // Every type comes back with its own Content-Type, whatever the request said.
  for (const [k, mime, ext] of [['png', 'image/png', 'png'], ['webp', 'image/webp', 'webp'], ['gif', 'image/gif', 'gif']]) {
    r = await upload(s.base, s.ana, fx(k), { headers: { 'Content-Type': 'image/jpeg' } });
    assert.equal(r.status, 200, k);
    assert.ok(r.json.url.endsWith(`.${ext}`), k);
    const g = await fetch(s.base + r.json.url);
    assert.equal(g.headers.get('content-type'), mime, k);
    assert.deepEqual(leaksIn(Buffer.from(await g.arrayBuffer())), [], k);
  }
});

test('http uploads: path safety (only stored names are ever served)', async (t) => {
  const s = await setup();
  t.after(s.close);
  const r = await upload(s.base, s.ana, fx('png'));
  const name = r.json.name;
  const hex = name.split('.')[0];
  const http = await import('node:http');
  const { port } = new URL(s.base);
  // fetch() normalises "..": send the path as written over a raw request.
  const raw = (p) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
  const ok = await raw(`/u/${name}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.type, 'image/png');
  const index = fs.readFileSync(path.join(s.dir, 'index.json'));
  for (const p of [
    '/u/index.json', `/u/${hex}.jpg`, `/u/${hex}.svg`, `/u/${hex.toUpperCase()}.png`, `/u/${hex}`, `/u/${'0'.repeat(32)}.png`,
    '/u/../data/state.json', '/u/..%2fstate.json', `/u/%2e%2e/${name}`, `/u/${name}/..`, `/u/${name}%00.png`,
    `/u/${name}.png`, `/uploads/${name}`, `/u/sub/${name}`, `/u/${hex}.png?download=1`.replace('?', '%3f'),
  ]) {
    const got = await raw(p);
    // Either refused, or (paths without a file extension) the app's own page: never a stored file.
    assert.ok(got.status !== 200 || /^text\/html/.test(got.type), `${p}: ${got.status} ${got.type}`);
    assert.ok(!got.body.equals(ok.body) && !got.body.includes(index), p);
  }
  // The index and temp files never leave the server, and the store holds only what we expect.
  const files = fs.readdirSync(s.dir).sort();
  assert.deepEqual(files, ['index.json', name].sort());
});

test('http uploads: per-writer quota (files and bytes), also under concurrent uploads', async (t) => {
  const s = await setup({ limits: { maxFiles: 3, maxTotalBytes: 1000 } });
  t.after(s.close);
  // Five at once: exactly three land.
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => upload(s.base, s.ana, fx('webpLossless'))));
  const ok = results.filter((x) => x.status === 200);
  const refused = results.filter((x) => x.status === 403);
  assert.equal(ok.length, 3);
  assert.equal(refused.length, 2);
  assert.equal(refused[0].json.code, 'quota');
  assert.match(refused[0].json.error, /all 3 image uploads/);
  // Another writer has their own quota; bytes count too.
  const ben = client(s.base);
  await ben.post('/api/register', { username: 'ben', password: 'longpassword', name: 'Ben' });
  assert.equal((await upload(s.base, ben, fx('png'))).status, 200); // ~100 bytes
  const big = await upload(s.base, ben, fx('jpeg')); // ~700 bytes: 800 < 1000, fine
  assert.equal(big.status, 200);
  const over = await upload(s.base, ben, fx('jpeg'));
  assert.equal(over.status, 403);
  assert.match(over.json.error, /image space/);
  // The quota survives a restart (the index is on disk).
  await s.uploads.flush();
  const again = createUploads({ dir: s.dir, limits: { maxFiles: 3 } });
  assert.equal(again.usage(s.anaId).files, 3);
  assert.equal(again.list(s.anaId).length, 3);
});

test('http uploads: writers waiting for approval can’t upload', async (t) => {
  const s = await setup({ approvalRequired: true });
  t.after(s.close);
  const r = await upload(s.base, s.ana, fx('png'));
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'pending_approval');
  assert.equal((await s.host.post('/api/host/approve', { id: s.anaId })).status, 200);
  assert.equal((await upload(s.base, s.ana, fx('png'))).status, 200);
});

test('http uploads: the host removes an image (placeholder at the same address), lists them', async (t) => {
  const s = await setup();
  t.after(s.close);
  const r = await upload(s.base, s.ana, fx('webp'));
  const { url, name } = r.json;
  // Writers can't remove (404, like other host routes); the host needs the CSRF header.
  assert.equal((await s.ana.post('/api/host/uploads/remove', { name })).status, 404);
  assert.equal((await s.host.post('/api/host/uploads/remove', { name }, { headers: { 'X-WH': '' } })).status, 403);
  assert.equal((await s.host.post('/api/host/uploads/remove', { name: 'f'.repeat(32) })).status, 404);
  let list = await s.host.get(`/api/host/uploads?uid=${s.anaId}`);
  assert.equal(list.status, 200);
  assert.equal(list.json.uploads.length, 1);
  assert.equal(list.json.uploads[0].removed, false);
  assert.equal((await s.ana.get('/api/host/uploads')).status, 404);
  // Remove by the address as written in the text (with its size fragment).
  const del = await s.host.post('/api/host/uploads/remove', { name: `${url}#w=20&h=14` });
  assert.equal(del.status, 200);
  assert.equal(del.json.removed, true);
  const g = await fetch(s.base + url);
  assert.equal(g.status, 200);
  assert.equal(g.headers.get('content-type'), 'image/svg+xml');
  const svg = await g.text();
  assert.equal(svg, REMOVED_SVG);
  assert.match(svg, /Image removed by the host/);
  assert.doesNotMatch(svg, /<script|onload|href/i);
  // Idempotent, and the /api/admin/ spelling works too.
  assert.equal((await s.host.post('/api/admin/uploads/remove', { name })).status, 200);
  list = await s.host.get('/api/admin/uploads');
  assert.equal(list.json.uploads[0].removed, true);
  // The host's log says so, without the writer's text.
  const st = await s.host.get('/api/host/state');
  assert.ok(st.json.log.some((l) => /removed an image/.test(l.text)));
  // The original bytes are gone from the disk.
  assert.equal(fs.readFileSync(path.join(s.dir, name), 'utf8'), REMOVED_SVG);
  await sleep(10);
});
