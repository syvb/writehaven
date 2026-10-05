// Image uploads (SPEC §14). Zero dependencies.
//   POST /api/uploads                  raw image bytes; signed-in, approved writer; X-WH: 1; ≤ 8 MB
//   GET  /u/<name>.<ext>               the file, typed from its sniffed content, cached for a year
//   GET  /u/hotlink-ok/<name>.<ext>    the same file: the address copies and exports use, because
//                                      Cloudflare's hotlink protection refuses images that other
//                                      sites' editors (LessWrong, WordPress) load from /u/ but
//                                      exempts any path with a hotlink-ok directory
//   POST /api/host/uploads/remove      { name }: the host swaps the file for a "removed" placeholder
//   GET  /api/host/uploads[?uid=<id>]  the host's list (per writer)
// Files live in <state dir>/uploads/ under random 16-byte hex names. Only PNG, JPEG, WebP and GIF
// are accepted (by their magic bytes, never by name or header), and metadata that can identify
// a person or place (EXIF/GPS, XMP, IPTC, comments, text chunks, trailers) is removed before the
// file is stored. The client already re-encodes images (which drops metadata); this is the net.
// uploads/index.json records who uploaded what, for the per-writer quota and host removal.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const KINDS = {
  png: { mime: 'image/png', ext: 'png' },
  jpeg: { mime: 'image/jpeg', ext: 'jpg' },
  webp: { mime: 'image/webp', ext: 'webp' },
  gif: { mime: 'image/gif', ext: 'gif' },
  svg: { mime: 'image/svg+xml', ext: null }, // only ever the host's "removed" placeholder
};
const EXT_KIND = { png: 'png', jpg: 'jpeg', webp: 'webp', gif: 'gif' };
export const LIMITS = { maxBytes: 8 * 1024 * 1024, maxFiles: 40, maxTotalBytes: 60 * 1024 * 1024, maxSide: 6000, maxPixels: 30e6 };
const NAME_RE = /^([0-9a-f]{32})\.(png|jpg|webp|gif)$/;
const URL_RE = /^\/u\/(?:hotlink-ok\/)?([0-9a-f]{32})\.(png|jpg|webp|gif)$/;

class BadImage extends Error {}

// ------------------------------------------------------------------ sniffing
export function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 8) === 'PNG\r\n\x1a\n') return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  const g = buf.toString('latin1', 0, 6);
  if (g === 'GIF87a' || g === 'GIF89a') return 'gif';
  return null;
}

// ------------------------------------------------------------------ metadata stripping
// Each stripper walks the container's own structure and keeps only what draws the image
// (and its colour profile); anything after the image's end marker is dropped too (phone
// "motion photos" and vendor trailers carry a video or metadata there). Malformed files throw.

// JPEG: drop APP1 (EXIF, XMP), APP3–APP13 (incl. APP13 IPTC/Photoshop), APP15 and COM.
// Kept: APP0 (JFIF), APP2 (ICC profile), APP14 (Adobe: needed to decode CMYK/YCCK).
function stripJpeg(buf) {
  const out = [buf.subarray(0, 2)];
  let i = 2;
  const n = buf.length;
  let sawSos = false;
  while (i < n) {
    if (buf[i] !== 0xff) throw new BadImage('JPEG: expected a marker');
    while (i + 1 < n && buf[i + 1] === 0xff) i++; // fill bytes
    if (i + 1 >= n) break;
    const marker = buf[i + 1];
    const at = i;
    i += 2;
    if (marker === 0xd9) { // EOI: the end, whatever follows is dropped
      out.push(buf.subarray(at, i));
      return Buffer.concat(out);
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.push(buf.subarray(at, i));
      continue;
    }
    if (i + 2 > n) throw new BadImage('JPEG: truncated segment');
    const len = buf.readUInt16BE(i);
    if (len < 2 || i + len > n) throw new BadImage('JPEG: bad segment length');
    const drop = marker === 0xe1 || (marker >= 0xe3 && marker <= 0xed) || marker === 0xef || marker === 0xfe;
    if (!drop) out.push(buf.subarray(at, i + len));
    i += len;
    if (marker === 0xda) {
      sawSos = true;
      // Entropy-coded data runs to the next marker that isn't byte stuffing (FF 00) or a restart.
      const start = i;
      while (i < n) {
        if (buf[i] === 0xff && i + 1 < n) {
          const m = buf[i + 1];
          if (m === 0x00 || (m >= 0xd0 && m <= 0xd7)) {
            i += 2;
            continue;
          }
          if (m === 0xff) {
            i++;
            continue;
          }
          break;
        }
        i++;
      }
      out.push(buf.subarray(start, i));
    }
  }
  if (!sawSos) throw new BadImage('JPEG: no image data');
  out.push(Buffer.from([0xff, 0xd9])); // truncated file: close it
  return Buffer.concat(out);
}

// PNG: keep only chunks that draw the image or describe its colours (and APNG animation).
// Dropped among others: tEXt, zTXt, iTXt, eXIf, tIME and private chunks.
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'pHYs', 'hIST', 'acTL', 'fcTL', 'fdAT', 'cICP', 'mDCv', 'cLLi']);
function stripPng(buf) {
  const out = [buf.subarray(0, 8)];
  let i = 8;
  let first = true;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    const end = i + 12 + len;
    if (len > 0x7fffffff || end > buf.length) throw new BadImage('PNG: truncated chunk');
    if (first && type !== 'IHDR') throw new BadImage('PNG: IHDR must come first');
    first = false;
    if (PNG_KEEP.has(type)) out.push(buf.subarray(i, end));
    i = end;
    if (type === 'IEND') return Buffer.concat(out);
  }
  throw new BadImage('PNG: no IEND');
}

// WebP (RIFF): drop EXIF, XMP and unknown chunks; clear the EXIF/XMP flags in VP8X.
const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);
function stripWebp(buf) {
  const riffEnd = Math.min(buf.length, 8 + buf.readUInt32LE(4));
  const chunks = [];
  let i = 12;
  let image = false;
  while (i + 8 <= riffEnd) {
    const fourcc = buf.toString('latin1', i, i + 4);
    const len = buf.readUInt32LE(i + 4);
    const end = i + 8 + len + (len & 1);
    if (i + 8 + len > riffEnd) throw new BadImage('WebP: truncated chunk');
    if (WEBP_KEEP.has(fourcc)) {
      let c = buf.subarray(i, Math.min(end, riffEnd));
      if (fourcc === 'VP8X') {
        c = Buffer.from(c);
        c[8] &= ~(0x08 | 0x04); // no EXIF, no XMP
      }
      if (c.length < end - i) c = Buffer.concat([c, Buffer.alloc(end - i - c.length)]);
      chunks.push(c);
      if (fourcc === 'VP8 ' || fourcc === 'VP8L' || fourcc === 'ANMF') image = true;
    }
    i = end;
  }
  if (!image) throw new BadImage('WebP: no image data');
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + body.length, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

// GIF: drop comment extensions, application extensions other than looping (XMP lives in one)
// and unknown extensions.
function stripGif(buf) {
  const n = buf.length;
  if (n < 13) throw new BadImage('GIF: too short');
  const packed = buf[10];
  let i = 13 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0);
  if (i > n) throw new BadImage('GIF: truncated colour table');
  const out = [buf.subarray(0, i)];
  const skipBlocks = (j) => {
    while (j < n) {
      const size = buf[j];
      j += 1 + size;
      if (size === 0) return j;
    }
    throw new BadImage('GIF: truncated data');
  };
  let frames = 0;
  while (i < n) {
    const b = buf[i];
    if (b === 0x3b) {
      out.push(buf.subarray(i, i + 1));
      if (!frames) throw new BadImage('GIF: no image data');
      return Buffer.concat(out);
    }
    if (b === 0x2c) {
      if (i + 10 > n) throw new BadImage('GIF: truncated frame');
      const p = buf[i + 9];
      let j = i + 10 + (p & 0x80 ? 3 * 2 ** ((p & 7) + 1) : 0);
      j = skipBlocks(j + 1); // LZW minimum code size, then the data sub-blocks
      out.push(buf.subarray(i, j));
      frames++;
      i = j;
    } else if (b === 0x21) {
      if (i + 2 > n) throw new BadImage('GIF: truncated extension');
      const label = buf[i + 1];
      const j = skipBlocks(i + 2);
      let keep = label === 0xf9 || label === 0x01; // graphic control, plain text
      if (label === 0xff) {
        const id = buf.toString('latin1', i + 3, i + 14);
        keep = buf[i + 2] === 11 && (id === 'NETSCAPE2.0' || id === 'ANIMEXTS1.0');
      }
      if (keep) out.push(buf.subarray(i, j));
      i = j;
    } else throw new BadImage('GIF: unknown block');
  }
  if (!frames) throw new BadImage('GIF: no image data');
  out.push(Buffer.from([0x3b]));
  return Buffer.concat(out);
}

export function stripMetadata(buf, kind) {
  if (kind === 'jpeg') return stripJpeg(buf);
  if (kind === 'png') return stripPng(buf);
  if (kind === 'webp') return stripWebp(buf);
  if (kind === 'gif') return stripGif(buf);
  throw new BadImage('unknown kind');
}

// Pixel size from the container header (null when it can't be read).
export function imageSize(buf, kind) {
  try {
    if (kind === 'png') return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (kind === 'gif') return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    if (kind === 'webp') {
      for (let i = 12; i + 8 <= buf.length;) {
        const fourcc = buf.toString('latin1', i, i + 4);
        const len = buf.readUInt32LE(i + 4);
        const d = i + 8;
        if (fourcc === 'VP8X') return { w: 1 + buf.readUIntLE(d + 4, 3), h: 1 + buf.readUIntLE(d + 7, 3) };
        if (fourcc === 'VP8 ') return { w: buf.readUInt16LE(d + 6) & 0x3fff, h: buf.readUInt16LE(d + 8) & 0x3fff };
        if (fourcc === 'VP8L') {
          const b = buf.readUInt32LE(d + 1);
          return { w: (b & 0x3fff) + 1, h: ((b >>> 14) & 0x3fff) + 1 };
        }
        i = d + len + (len & 1);
      }
      return null;
    }
    if (kind === 'jpeg') {
      for (let i = 2; i + 9 < buf.length;) {
        if (buf[i] !== 0xff) return null;
        const m = buf[i + 1];
        if (m === 0xff) {
          i++;
          continue;
        }
        if ((m >= 0xd0 && m <= 0xd9) || m === 0x01) {
          i += 2;
          continue;
        }
        // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC)
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
        if (m === 0xda) return null;
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch { /* fall through */ }
  return null;
}

// The host's placeholder: fills whatever box the reader reserved for the original image.
export const REMOVED_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675" preserveAspectRatio="xMidYMid slice">
<style>rect{fill:#ecece6}text{fill:#7c8288;font:italic 400 44px Newsreader,'Iowan Old Style',Georgia,serif}
@media (prefers-color-scheme:dark){rect{fill:#24282d}text{fill:#868b90}}</style>
<rect width="1200" height="675"/><text x="600" y="352" text-anchor="middle">Image removed by the host</text></svg>
`;

// Accepts "<hex>.<ext>", "/u/<hex>.<ext>", a full URL to it (with or without #w=…&h=…) or "<hex>".
export function normalizeName(input) {
  let s = String(input ?? '').trim();
  if (!s) return null;
  try {
    if (/^https?:\/\//i.test(s)) s = new URL(s).pathname;
  } catch {
    return null;
  }
  s = s.split('#')[0].split('?')[0];
  if (s.startsWith('/u/hotlink-ok/')) s = s.slice(14);
  else if (s.startsWith('/u/')) s = s.slice(3);
  if (/^[0-9a-f]{32}$/.test(s)) return s;
  const m = NAME_RE.exec(s);
  return m ? m[1] : null;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) {
      req.resume();
      reject(Object.assign(new Error('too big'), { tooBig: true }));
      return;
    }
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) tooBig = true;
      else chunks.push(c);
    });
    req.on('end', () => (tooBig ? reject(Object.assign(new Error('too big'), { tooBig: true })) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

const mb = (bytes) => `${Math.round(bytes / 1048576)} MB`;

// ------------------------------------------------------------------ the store + routes
export function createUploads({ dir, limits = {}, log = console, now = Date.now } = {}) {
  const L = { ...LIMITS, ...limits };
  const root = path.resolve(dir);
  const indexFile = path.join(root, 'index.json');
  fs.mkdirSync(root, { recursive: true });
  let index = { v: 1, files: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    if (raw && typeof raw.files === 'object') index = { v: 1, files: raw.files };
  } catch (e) {
    if (e.code !== 'ENOENT') log.error(`[uploads] index unreadable (${e.message}); starting a new one`);
  }
  // Leftovers of a crash mid-write.
  for (const f of fs.readdirSync(root)) if (f.includes('.tmp-')) fs.rmSync(path.join(root, f), { force: true });

  const reserved = new Map(); // uid -> { files, bytes } of uploads being written
  let saving = Promise.resolve();
  let tmpSeq = 0;

  async function writeAtomic(file, data) {
    const tmp = `${file}.tmp-${process.pid}-${++tmpSeq}`;
    let fh = null;
    try {
      fh = await fs.promises.open(tmp, 'w');
      await fh.writeFile(data);
      await fh.sync();
      await fh.close();
      fh = null;
      await fs.promises.rename(tmp, file);
    } catch (e) {
      if (fh) await fh.close().catch(() => {});
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }
  function saveIndex() {
    const text = JSON.stringify(index);
    saving = saving.then(() => writeAtomic(indexFile, text)).catch((e) => log.error(`[uploads] index save failed: ${e.message}`));
    return saving;
  }

  function usage(uid) {
    let files = 0;
    let bytes = 0;
    for (const r of Object.values(index.files)) {
      if (r.uid !== uid) continue;
      files++;
      bytes += r.removed ? 0 : r.bytes;
    }
    const res = reserved.get(uid);
    return { files: files + (res ? res.files : 0), bytes: bytes + (res ? res.bytes : 0) };
  }
  const fileOf = (name) => path.join(root, name);

  async function store(uid, raw) {
    const kind = sniff(raw);
    if (!kind) throw new UploadError(415, 'Only PNG, JPEG, WebP and GIF images can be uploaded.', 'type');
    let buf;
    try {
      buf = stripMetadata(raw, kind);
    } catch (e) {
      if (e instanceof BadImage) throw new UploadError(415, 'That image file looks damaged. Try saving it again or take a new screenshot.', 'damaged');
      throw e;
    }
    const size = imageSize(buf, kind);
    if (!size || !size.w || !size.h) throw new UploadError(415, 'That image file looks damaged. Try saving it again or take a new screenshot.', 'damaged');
    if (size.w > L.maxSide || size.h > L.maxSide || size.w * size.h > L.maxPixels) {
      throw new UploadError(413, `That image is too large (${size.w} × ${size.h} pixels).`, 'dimensions');
    }
    const used = usage(uid);
    if (used.files + 1 > L.maxFiles) throw new UploadError(403, `You’ve used all ${L.maxFiles} image uploads for this party.`, 'quota');
    if (used.bytes + buf.length > L.maxTotalBytes) throw new UploadError(403, `You’ve used your ${mb(L.maxTotalBytes)} of image space for this party.`, 'quota');
    const r0 = reserved.get(uid) || { files: 0, bytes: 0 };
    reserved.set(uid, { files: r0.files + 1, bytes: r0.bytes + buf.length });
    try {
      const name = `${crypto.randomBytes(16).toString('hex')}.${KINDS[kind].ext}`;
      await writeAtomic(fileOf(name), buf);
      index.files[name] = { uid, kind, bytes: buf.length, w: size.w, h: size.h, at: now() };
      await saveIndex();
      return { name, kind, bytes: buf.length, ...size };
    } finally {
      const r = reserved.get(uid);
      if (r) {
        r.files--;
        r.bytes -= buf.length;
        if (r.files <= 0) reserved.delete(uid);
      }
    }
  }

  async function remove(input, by = null) {
    const hex = normalizeName(input);
    const name = hex && Object.keys(index.files).find((k) => k.startsWith(`${hex}.`));
    if (!name) throw new UploadError(404, 'No such image', 'not-found');
    const rec = index.files[name];
    if (!rec.removed) {
      await writeAtomic(fileOf(name), Buffer.from(REMOVED_SVG, 'utf8'));
      rec.removed = { at: now(), by, kind: rec.kind, bytes: rec.bytes };
      await saveIndex();
    }
    return { name, rec };
  }

  function list(uid = null) {
    return Object.entries(index.files)
      .filter(([, r]) => !uid || r.uid === uid)
      .map(([name, r]) => ({ name, url: `/u/${name}`, uid: r.uid, type: KINDS[r.kind].mime, bytes: r.bytes, w: r.w, h: r.h, at: r.at, removed: !!r.removed }))
      .sort((a, b) => b.at - a.at);
  }

  async function serve(req, res, name) {
    const rec = index.files[name];
    if (!rec) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : 'Not found');
      return;
    }
    let st;
    try {
      st = await fs.promises.stat(fileOf(name));
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : 'Not found');
      return;
    }
    const kind = rec.removed ? 'svg' : rec.kind;
    const etag = `"${rec.removed ? 'r' : 'i'}${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const headers = {
      'Content-Type': KINDS[kind].mime,
      'Cache-Control': 'public, max-age=31536000, immutable',
      // Cloudflare keeps its edge copy only briefly, so a host removal reaches new readers fast.
      'Cloudflare-CDN-Cache-Control': 'max-age=60',
      'X-Content-Type-Options': 'nosniff',
      // Other sites' editors show (and some fetch, to re-host) the images in a pasted copy.
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      ETag: etag,
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const s = fs.createReadStream(fileOf(name));
    s.on('error', () => res.destroy());
    s.pipe(res);
  }

  const json = (h, status, obj) => h.sendJson(status, obj);
  const fail = (h, e) => {
    if (e instanceof UploadError) return json(h, e.status, { error: e.message, code: e.code });
    return h.sendError(e);
  };
  const isHostPath = (p, rest) => p === `/api/host/${rest}` || p === `/api/admin/${rest}`;

  const routes = [
    {
      method: 'POST',
      match: (p) => (p === '/api/uploads' ? {} : null),
      async handle(req, res, h) {
        if (req.headers['x-wh'] !== '1') {
          req.resume();
          return json(h, 403, { error: 'Forbidden: the X-WH header is required', code: 'csrf' });
        }
        const uid = h.ctx.userId;
        if (!uid) {
          req.resume();
          return json(h, 401, { error: 'Please sign in first', code: 'auth' });
        }
        try {
          if (typeof h.party.requireApproved === 'function') h.party.requireApproved(uid);
        } catch (e) {
          req.resume();
          return h.sendError(e);
        }
        let raw;
        try {
          raw = await readBody(req, L.maxBytes);
        } catch (e) {
          if (e.tooBig) return json(h, 413, { error: `That image is over ${mb(L.maxBytes)}.`, code: 'too-large' });
          throw e;
        }
        if (!raw.length) return json(h, 400, { error: 'No image in the request', code: 'empty' });
        try {
          const out = await store(uid, raw);
          const used = usage(uid);
          return json(h, 200, {
            ok: true,
            url: `/u/${out.name}`,
            name: out.name,
            type: KINDS[out.kind].mime,
            bytes: out.bytes,
            w: out.w,
            h: out.h,
            used,
            limits: { files: L.maxFiles, bytes: L.maxTotalBytes },
          });
        } catch (e) {
          return fail(h, e);
        }
      },
    },
    {
      method: 'GET',
      match: (p) => {
        const m = URL_RE.exec(p);
        return m ? { name: `${m[1]}.${m[2]}` } : null;
      },
      handle: (req, res, h) => serve(req, res, h.params.name),
    },
    {
      method: 'POST',
      match: (p) => (isHostPath(p, 'uploads/remove') ? {} : null),
      async handle(req, res, h) {
        if (!h.ctx.user?.isAdmin) {
          req.resume();
          return json(h, 404, { error: 'Not found' });
        }
        const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (ct !== 'application/json' || req.headers['x-wh'] !== '1') {
          req.resume();
          return json(h, 403, { error: 'Forbidden: JSON with the X-WH header required', code: 'csrf' });
        }
        let body;
        try {
          body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8') || '{}');
        } catch {
          return json(h, 400, { error: 'Invalid JSON' });
        }
        try {
          const { name, rec } = await remove(body && body.name, h.ctx.userId);
          if (typeof h.party.addLog === 'function') {
            h.party.addLog('upload-remove', { userId: rec.uid, by: h.ctx.userId, text: 'removed an image' });
            h.party.touch?.();
          }
          return json(h, 200, { ok: true, name, url: `/u/${name}`, removed: true });
        } catch (e) {
          return fail(h, e);
        }
      },
    },
    {
      method: 'GET',
      match: (p) => (isHostPath(p, 'uploads') ? {} : null),
      handle(req, res, h) {
        if (!h.ctx.user?.isAdmin) return json(h, 404, { error: 'Not found' });
        const uid = h.url.searchParams.get('uid') || null;
        return json(h, 200, { uploads: list(uid), limits: { files: L.maxFiles, bytes: L.maxTotalBytes } });
      },
    },
  ];

  return { routes, store, remove, list, usage, dir: root, limits: L, flush: () => saving };
}

export class UploadError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
