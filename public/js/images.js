// Images for the editor (SPEC §14): shrink and re-encode on the device, then upload.
//
// processImage(file) -> { blob, type, ext, w, h }
//   Decodes the picture (EXIF orientation applied), scales it to at most 1600 px on its longest
//   side and re-encodes it as WebP (JPEG where the browser can't write WebP), quality 0.85.
//   Re-encoding through a canvas keeps only pixels, so EXIF/GPS and every other kind of metadata
//   is gone before anything leaves the device. Small GIFs go up as they are (animation kept;
//   GIFs carry no EXIF, and the server strips comments). Runs in a worker where the browser can
//   (OffscreenCanvas), so typing never waits for it.
// uploadBlob(blob, { onProgress }) -> Promise<{ url, name, type, w, h, ... }>
//   POST /api/uploads with the session cookie and the X-WH header; rejects with
//   { status, code, message, network } on failure.

export const MAX_SIDE = 1600;
export const QUALITY = 0.85;
const MAX_GIF_BYTES = 4 * 1024 * 1024;
const MAX_UPLOAD = 8 * 1024 * 1024;
const EXT = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif' };

export class ImageError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const hasOffscreen = typeof OffscreenCanvas === 'function';
const inWorker = typeof document === 'undefined';

function makeCanvas(w, h) {
  if (hasOffscreen) return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function encode(canvas, type, quality) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type, quality }).catch(() => null);
  return new Promise((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), type, quality);
    } catch {
      resolve(null);
    }
  });
}

async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (e) {
      if (inWorker) throw e;
    }
  }
  if (inWorker) throw new ImageError('Can’t read images here', 'unsupported');
  // Fallback: an <img> (it applies EXIF orientation too).
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

// GIF: width and height from the header.
async function gifInfo(file) {
  const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  const sig = String.fromCharCode(...head.slice(0, 6));
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null;
  return { w: head[6] | (head[7] << 8), h: head[8] | (head[9] << 8) };
}

export async function processImage(file) {
  if (!file || (file.type && !/^image\//.test(file.type))) throw new ImageError('That isn’t an image.', 'type');
  const gif = await gifInfo(file).catch(() => null);
  if (gif && gif.w && gif.h && Math.max(gif.w, gif.h) <= MAX_SIDE && file.size <= MAX_GIF_BYTES) {
    return { blob: file, type: 'image/gif', ext: 'gif', w: gif.w, h: gif.h, passthrough: true };
  }
  let src;
  try {
    src = await decode(file);
  } catch (e) {
    if (e instanceof ImageError) throw e;
    throw new ImageError('This image couldn’t be read. Try a JPEG or PNG.', 'decode');
  }
  const w0 = src.width || src.naturalWidth;
  const h0 = src.height || src.naturalHeight;
  if (!w0 || !h0) throw new ImageError('This image couldn’t be read. Try a JPEG or PNG.', 'decode');
  const scale = Math.min(1, MAX_SIDE / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));
  // Halve in steps while more than twice the target: one big jump looks jagged.
  let cur = src;
  let cw = w0;
  let ch = h0;
  const temps = [];
  while (cw / 2 >= w && ch / 2 >= h) {
    const nw = Math.max(w, Math.round(cw / 2));
    const nh = Math.max(h, Math.round(ch / 2));
    const c = makeCanvas(nw, nh);
    const cx = c.getContext('2d');
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(cur, 0, 0, nw, nh);
    temps.push(c);
    cur = c;
    cw = nw;
    ch = nh;
  }
  const out = makeCanvas(w, h);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, w, h);
  if (typeof src.close === 'function') src.close();
  for (const c of temps) c.width = c.height = 0;
  let blob = await encode(out, 'image/webp', QUALITY);
  if (!blob || blob.type !== 'image/webp') {
    // No WebP encoder (Safari): JPEG, on white, since JPEG has no transparency.
    const flat = makeCanvas(w, h);
    const fx = flat.getContext('2d');
    fx.fillStyle = '#ffffff';
    fx.fillRect(0, 0, w, h);
    fx.drawImage(out, 0, 0);
    blob = await encode(flat, 'image/jpeg', QUALITY);
    flat.width = flat.height = 0;
  }
  out.width = out.height = 0;
  if (!blob) throw new ImageError('This image couldn’t be prepared for upload.', 'encode');
  if (blob.size > MAX_UPLOAD) throw new ImageError('That image is too large to upload.', 'size');
  return { blob, type: blob.type, ext: EXT[blob.type] || 'img', w, h };
}

// ---------------------------------------------------------------- off the main thread
let worker = null;
let workerBroken = false;
let seq = 0;
const waiting = new Map();
function getWorker() {
  if (worker || workerBroken || inWorker) return worker;
  if (typeof Worker !== 'function' || !hasOffscreen || typeof createImageBitmap !== 'function') {
    workerBroken = true;
    return null;
  }
  try {
    worker = new Worker(new URL('./image-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const { id, ok, result, error, code } = e.data || {};
      const w = waiting.get(id);
      if (!w) return;
      waiting.delete(id);
      clearTimeout(w.timer);
      if (ok) w.resolve(result);
      else w.reject(Object.assign(new ImageError(error || 'This image couldn’t be read.', code || 'decode'), { fromWorker: true }));
    };
    worker.onerror = () => {
      workerBroken = true;
      worker = null;
      for (const [, w] of waiting) w.fallback();
      waiting.clear();
    };
  } catch {
    workerBroken = true;
    worker = null;
  }
  return worker;
}

// processImage in a worker when possible, else here.
export function prepareImage(file) {
  const w = getWorker();
  if (!w) return processImage(file);
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const fallback = () => {
      waiting.delete(id);
      processImage(file).then(resolve, reject);
    };
    const timer = setTimeout(fallback, 45_000);
    waiting.set(id, {
      resolve,
      timer,
      fallback,
      // A browser that can't decode or encode in a worker (older Safari, unusual formats) tries
      // here instead, where an <img> can still read it.
      reject: (e) => (e.code === 'type' || e.code === 'size' ? reject(e) : fallback()),
    });
    try {
      w.postMessage({ id, file });
    } catch {
      clearTimeout(timer);
      fallback();
    }
  });
}

// ---------------------------------------------------------------- upload
export function uploadBlob(blob, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/uploads');
    xhr.setRequestHeader('X-WH', '1');
    xhr.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
    xhr.timeout = 180_000;
    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total) onProgress(e.loaded / e.total);
      };
    }
    xhr.onload = () => {
      let body = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300 && body && body.url) {
        resolve(body);
        return;
      }
      const err = new Error((body && body.error) || `Upload failed (${xhr.status})`);
      err.status = xhr.status;
      err.code = body && body.code;
      reject(err);
    };
    const netFail = () => reject(Object.assign(new Error('No connection'), { network: true, status: 0 }));
    xhr.onerror = netFail;
    xhr.ontimeout = netFail;
    xhr.onabort = netFail;
    xhr.send(blob);
  });
}

// What a failed upload means for the writer, and whether trying again can help.
export function describeUploadError(e) {
  if (e instanceof ImageError) return { text: e.message, retry: false };
  if (e.network || e.status === 0) return { text: 'Will upload when you’re back online.', retry: true, offline: true };
  if (e.status === 401) return { text: 'You’re signed out. Sign in again in another tab, then retry.', retry: true };
  if (e.code === 'pending_approval') return { text: 'Images can be added once the host approves your account.', retry: true };
  if (e.status >= 500 || e.status === 408 || e.status === 429) return { text: 'The upload didn’t go through. Retrying…', retry: true, auto: true };
  return { text: e.message || 'This image couldn’t be uploaded.', retry: false };
}
