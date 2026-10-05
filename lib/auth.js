import crypto from 'node:crypto';

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;

function scrypt(password, salt, n = N, r = R, p = P) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEYLEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

// Returns "scrypt$N$r$p$saltHex$hashHex".
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${key.toString('hex')}`;
}

const DUMMY = `scrypt$${N}$${R}$${P}$${'00'.repeat(16)}$${'00'.repeat(KEYLEN)}`;

export async function verifyPassword(password, stored) {
  const parts = String(stored || DUMMY).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltHex, hashHex] = parts;
  const want = Buffer.from(hashHex, 'hex');
  let got;
  try {
    got = await scrypt(String(password), Buffer.from(saltHex, 'hex'), Number(n), Number(r), Number(p));
  } catch {
    return false;
  }
  return stored != null && want.length === got.length && crypto.timingSafeEqual(want, got);
}

export function newSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Failed-login limiter: `max` failures per `windowMs` per key (ip|username).
export class LoginLimiter {
  constructor({ max = 10, windowMs = 5 * 60 * 1000, now = Date.now } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.fails = new Map();
  }
  recent(key) {
    const t = this.now();
    const list = (this.fails.get(key) || []).filter((x) => t - x < this.windowMs);
    if (list.length) this.fails.set(key, list);
    else this.fails.delete(key);
    return list;
  }
  blocked(key) {
    return this.recent(key).length >= this.max;
  }
  fail(key) {
    const list = this.recent(key);
    list.push(this.now());
    this.fails.set(key, list);
  }
  success(key) {
    this.fails.delete(key);
  }
  sweep() {
    for (const k of [...this.fails.keys()]) this.recent(k);
  }
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k || Object.hasOwn(out, k)) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function sessionCookie(token, { secure = false, clear = false } = {}) {
  const parts = [`wh_sess=${clear ? '' : token}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${clear ? 0 : 30 * 24 * 3600}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
