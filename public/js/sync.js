// Offline-safe op queue. Every editor change becomes an op that is kept on this
// device (IndexedDB) until the server confirms it; batches go out about once a second.
//
// - A batch's id (seq) is written to disk before the batch is sent, and a retry
//   reuses it, so a batch whose response was lost is never applied twice.
// - Each tab keeps its own queue record. A tab that closes (or crashes) with unsent
//   work leaves an orphaned record; the next tab to open, or a tab that is still
//   open, adopts it and sends it with its original batch id and op times.
// - On a version conflict (another tab or device wrote first) the queued ops are
//   rebased onto the server's text with CodeMirror ChangeSets, so both sides'
//   words survive and every op keeps its original time. Only when the history is
//   ambiguous (an old server) does a text-level 3-way merge run, and anything it
//   can't place is kept as a visible "Recovered text" block, never dropped.

import { api } from './net.js';
import { ChangeSet, Text } from '../vendor/cm.js';

// ---------------------------------------------------------------- storage
// One object store ('panes', the original v1 store, so no version upgrade can be
// blocked by an older tab). Keys:
//   q|user:post:pane:tab  queue record   { owner, aliveAt, closedAt, savedAt, snapV, acked, inflight, pending }
//   s|user:post:pane:tab  snapshot       { version, text }  (the base the queue builds on)
//   b|user                boot record    { me, posts, skew, savedAt }  (offline start)
//   user:post:pane        v1 record      { version, baseText, pending } (adopted, then removed)
const DB_NAME = 'writehaven';
const STORE = 'panes';
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, 1);
    } catch {
      resolve(null);
      return;
    }
    const t = setTimeout(() => resolve(null), 4000);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      clearTimeout(t);
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => {
      clearTimeout(t);
      resolve(null);
    };
  });
  return dbPromise;
}

// localStorage stand-in when IndexedDB is unavailable (some private modes).
const ls = {
  get(k) {
    try {
      const v = localStorage.getItem(`wh-pane:${k}`);
      return v ? JSON.parse(v) : undefined;
    } catch {
      return undefined;
    }
  },
  put(k, v) {
    try {
      localStorage.setItem(`wh-pane:${k}`, JSON.stringify(v));
      return true;
    } catch {
      return false;
    }
  },
  del(k) {
    try {
      localStorage.removeItem(`wh-pane:${k}`);
    } catch { /* ignore */ }
  },
  entries(prefix) {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(`wh-pane:${prefix}`)) out.push([k.slice(8), JSON.parse(localStorage.getItem(k))]);
      }
    } catch { /* ignore */ }
    return out;
  },
  range(prefix) {
    return ls.entries(prefix).map(([, v]) => v);
  },
};

function txDone(t, value) {
  return new Promise((resolve) => {
    t.oncomplete = () => resolve(typeof value === 'function' ? value() : value);
    t.onerror = () => resolve(undefined);
    t.onabort = () => resolve(undefined);
  });
}

export const kv = {
  async get(k) {
    const db = await openDb();
    if (!db) return ls.get(k);
    try {
      const t = db.transaction(STORE, 'readonly');
      const r = t.objectStore(STORE).get(k);
      return await txDone(t, () => r.result);
    } catch {
      return undefined;
    }
  },
  // Every value whose key starts with prefix (values carry their own key in `k`).
  async range(prefix) {
    const db = await openDb();
    if (!db) return ls.range(prefix);
    try {
      const t = db.transaction(STORE, 'readonly');
      const r = t.objectStore(STORE).getAll(IDBKeyRange.bound(prefix, `${prefix}￿`));
      return (await txDone(t, () => r.result)) || [];
    } catch {
      return [];
    }
  },
  // [key, value] pairs for keys starting with prefix (for records that don't carry their key).
  async entries(prefix) {
    const db = await openDb();
    if (!db) return ls.entries(prefix);
    try {
      const t = db.transaction(STORE, 'readonly');
      const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
      const ks = t.objectStore(STORE).getAllKeys(range);
      const vs = t.objectStore(STORE).getAll(range);
      return (await txDone(t, () => (ks.result || []).map((k, i) => [k, vs.result[i]]))) || [];
    } catch {
      return [];
    }
  },
  // Puts and deletes in one atomic transaction. Resolves true when committed.
  async write(puts = [], dels = []) {
    const db = await openDb();
    if (!db) {
      let ok = true;
      for (const [k, v] of puts) ok = ls.put(k, v) && ok;
      for (const k of dels) ls.del(k);
      return ok;
    }
    try {
      const t = db.transaction(STORE, 'readwrite');
      const st = t.objectStore(STORE);
      for (const [k, v] of puts) st.put(v, k);
      for (const k of dels) st.delete(k);
      return (await txDone(t, true)) === true;
    } catch {
      return false;
    }
  },
  // One read-modify-write transaction over several keys: fn(values) returns
  // { puts, dels } to apply, or null to change nothing. Resolves with what fn returned
  // once committed (null if fn declined, undefined if the transaction failed).
  async atomic(keys, fn) {
    const db = await openDb();
    if (!db) {
      const out = fn(keys.map((k) => ls.get(k)));
      if (!out) return null;
      let ok = true;
      for (const [k, v] of out.puts || []) ok = ls.put(k, v) && ok;
      for (const k of out.dels || []) ls.del(k);
      return ok ? out : undefined;
    }
    try {
      const t = db.transaction(STORE, 'readwrite');
      const st = t.objectStore(STORE);
      const vals = new Array(keys.length);
      let left = keys.length;
      let out = null;
      const apply = () => {
        out = fn(vals) || null;
        if (!out) return;
        for (const [k, v] of out.puts || []) st.put(v, k);
        for (const k of out.dels || []) st.delete(k);
      };
      if (!left) apply();
      keys.forEach((k, i) => {
        const r = st.get(k);
        r.onsuccess = () => {
          vals[i] = r.result;
          if (--left === 0) apply();
        };
      });
      return (await txDone(t, true)) === true ? out : undefined;
    } catch {
      return undefined;
    }
  },
  // Read-modify-write in one transaction (fn returns the new value, null to delete,
  // undefined to leave it). Resolves with what fn returned once committed.
  async update(k, fn) {
    const db = await openDb();
    if (!db) {
      const next = fn(ls.get(k));
      if (next === null) ls.del(k);
      else if (next !== undefined) ls.put(k, next);
      return next;
    }
    try {
      const t = db.transaction(STORE, 'readwrite');
      const st = t.objectStore(STORE);
      let next;
      const r = st.get(k);
      r.onsuccess = () => {
        next = fn(r.result);
        if (next === null) st.delete(k);
        else if (next !== undefined) st.put(next, k);
      };
      return await txDone(t, () => next);
    } catch {
      return undefined;
    }
  },
};

// ---------------------------------------------------------------- text ops
export function applyOps(text, ops) {
  for (const o of ops) text = text.slice(0, o.pos) + (o.ins || '') + text.slice(o.pos + (o.del || 0));
  return text;
}
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const T = (s) => Text.of(String(s).split('\n'));

// Tokens for diffing prose: words, runs of whitespace, single punctuation marks.
const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
function tokenize(s) {
  const out = [];
  let m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(s))) out.push(m[0]);
  return out;
}
function lines(s) {
  // Each line with its newline (no lookbehind: iOS Safari before 16.4 can't parse it).
  return s.match(/[^\n]*\n|[^\n]+/g) || [''];
}

// Myers' O(ND) diff over two arrays of ids. Returns a list of [op, i, j] steps
// ('=', '-', '+') or null when the edit distance exceeds maxD.
function myers(A, B, maxD) {
  const N = A.length;
  const M = B.length;
  const lim = Math.min(N + M, maxD);
  const off = lim + 1;
  const v = new Int32Array(2 * lim + 3);
  const trace = [];
  for (let d = 0; d <= lim; d++) {
    trace.push(v.slice(off - d, off + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= N && y >= M) {
        // Walk back through the trace. trace[dd] holds v as it was when round dd
        // started, for k in [-dd, dd] at index k + dd.
        const steps = [];
        let cx = N;
        let cy = M;
        for (let dd = d; dd > 0; dd--) {
          const pv = trace[dd];
          const kk = cx - cy;
          const down = kk === -dd || (kk !== dd && pv[kk - 1 + dd] < pv[kk + 1 + dd]);
          const pk = down ? kk + 1 : kk - 1;
          const px = pv[pk + dd];
          const py = px - pk;
          const ex = down ? px : px + 1; // where the move landed, before the snake
          const ey = down ? py + 1 : py;
          while (cx > ex && cy > ey) {
            steps.push(['=', cx - 1, cy - 1]);
            cx--;
            cy--;
          }
          steps.push(down ? ['+', px, py] : ['-', px, py]); // insert B[py] at A[px] / delete A[px]
          cx = px;
          cy = py;
        }
        while (cx > 0 && cy > 0) {
          steps.push(['=', cx - 1, cy - 1]);
          cx--;
          cy--;
        }
        return steps.reverse();
      }
    }
  }
  return null;
}

const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;
// Changes [{ from, to, insert }] (positions in a, sorted, non-overlapping) that turn a into b.
export function diffRanges(a, b, { maxD = 800 } = {}) {
  let p = 0;
  const max = Math.min(a.length, b.length);
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  // Never split a surrogate pair (😀 -> 😁 is one character changed, not half of one).
  if (p > 0 && p < Math.max(a.length, b.length) && isHigh(a.charCodeAt(p - 1))) p--;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  if (s > 0 && (isLow(a.charCodeAt(a.length - s)) && a.length - s - 1 >= p && isHigh(a.charCodeAt(a.length - s - 1)))) s--;
  if (p === a.length && p === b.length) return [];
  const am = a.slice(p, a.length - s);
  const bm = b.slice(p, b.length - s);
  const whole = [{ from: p, to: a.length - s, insert: bm }];
  if (!am || !bm) return whole;
  for (const split of [tokenize, lines]) {
    const ta = split(am);
    const tb = split(bm);
    if (ta.length * tb.length > 4e8 && split === tokenize) continue;
    const ids = new Map();
    const id = (t) => {
      let n = ids.get(t);
      if (n === undefined) ids.set(t, (n = ids.size));
      return n;
    };
    const A = Int32Array.from(ta, id);
    const B = Int32Array.from(tb, id);
    const steps = myers(A, B, maxD);
    if (!steps) continue;
    // Character offsets of each token.
    const offA = new Int32Array(ta.length + 1);
    for (let i = 0; i < ta.length; i++) offA[i + 1] = offA[i] + ta[i].length;
    const out = [];
    let cur = null;
    for (const [op, i, j] of steps) {
      if (op === '=') {
        if (cur) out.push(cur);
        cur = null;
        continue;
      }
      if (!cur) cur = { from: p + offA[i], to: p + offA[i], insert: '' };
      if (op === '-') cur.to = p + offA[i + 1];
      else cur.insert += tb[j];
    }
    if (cur) out.push(cur);
    return out;
  }
  return whole;
}

export function diffChangeSet(a, b) {
  return ChangeSet.of(diffRanges(a, b).map((c) => ({ from: c.from, to: c.to, insert: T(c.insert) })), a.length);
}

// Ops (applied in order) that turn a into b, all stamped at `at`.
export function diffOps(a, b, at = Date.now()) {
  const ch = diffRanges(a, b);
  const ops = [];
  for (let i = ch.length - 1; i >= 0; i--) {
    const c = ch[i];
    ops.push({ at, pos: c.from, del: c.to - c.from, ins: c.insert });
  }
  return ops;
}

// The server's batches since our base, as one ChangeSet over the base text.
export function changeSetFromSince(len, since) {
  let cs = ChangeSet.empty(len);
  for (const b of since) {
    for (const o of b.ops || []) {
      const [pos, del, ins] = Array.isArray(o) ? o : [o.pos, o.del, o.ins];
      cs = cs.compose(ChangeSet.of([{ from: pos, to: pos + (del || 0), insert: T(ins || '') }], cs.newLength));
    }
  }
  return cs;
}

// Rebase our ops (made on the base text) over theirs (base -> server text).
// Every op keeps its time, source and paste answer. Returns the rebased ops and
// theirs mapped over ours (our local text -> the merged text), for the editor.
// Ties (both sides inserting at one point) put their text first, except where our
// op continues our own run of typing (it starts where our previous op ended, or at
// prevEnd, the end of our last op the server already has): then ours stays with
// its run, so two writers' sentences never interleave.
export function rebaseOps(mine, theirs, baseLen, prevEnd = null) {
  let t = theirs;
  let len = baseLen;
  let end = prevEnd;
  const out = [];
  for (const op of mine) {
    const c = ChangeSet.of([{ from: op.pos, to: op.pos + (op.del || 0), insert: T(op.ins || '') }], len);
    const sticky = end !== null && op.pos === end;
    const c2 = c.map(t, sticky);
    t = t.map(c, !sticky);
    len = c.newLength;
    end = op.pos + (op.ins ? op.ins.length : 0);
    const parts = [];
    c2.iterChanges((fromA, toA, _fb, _tb, ins) => parts.push({ pos: fromA, del: toA - fromA, ins: ins.toString() }));
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (!p.del && !p.ins) continue;
      const o = { ...op, pos: p.pos, del: p.del, ins: p.ins };
      if (!p.ins) delete o.paste; // a pure deletion carries no paste answer
      out.push(o);
    }
  }
  return { ops: out, theirsOverMine: t };
}

// Text-level 3-way merge (o = common base, a = theirs, b = mine). Changes both
// sides made identically are taken once; insertions at the same point are both
// kept; a region both sides changed differently keeps theirs, and ours goes to
// `recovered` so the caller can show it.
export function merge3(o, a, b) {
  const da = diffRanges(o, a).map((c) => ({ ...c, side: 'a' }));
  const db = diffRanges(o, b).map((c) => ({ ...c, side: 'b' }));
  const all = [...da, ...db].sort((x, y) => x.from - y.from || x.to - y.to);
  const overlaps = (x, gFrom, gTo) => x.from < gTo || (x.from === gTo && (x.from === x.to || gFrom === gTo)) || x.from === gFrom;
  let out = '';
  let pos = 0;
  const recovered = [];
  let i = 0;
  while (i < all.length) {
    const g = [all[i]];
    let gFrom = all[i].from;
    let gTo = all[i].to;
    i++;
    while (i < all.length && overlaps(all[i], gFrom, gTo)) {
      g.push(all[i]);
      gTo = Math.max(gTo, all[i].to);
      gFrom = Math.min(gFrom, all[i].from);
      i++;
    }
    out += o.slice(pos, gFrom);
    const side = (s) => {
      let r = '';
      let at = gFrom;
      for (const c of g.filter((x) => x.side === s)) {
        r += o.slice(at, c.from) + c.insert;
        at = c.to;
      }
      return r + o.slice(at, gTo);
    };
    const hasA = g.some((x) => x.side === 'a');
    const hasB = g.some((x) => x.side === 'b');
    const ra = side('a');
    const rb = side('b');
    if (!hasB || ra === rb) out += ra;
    else if (!hasA) out += rb;
    else if (rb.startsWith(ra) || rb.endsWith(ra)) out += rb; // one side carries the other's change too
    else if (ra.startsWith(rb) || ra.endsWith(rb)) out += ra;
    else if (gFrom === gTo) out += ra + rb; // both inserted at the same point: both kept, in full
    else {
      out += ra;
      if (rb.trim()) recovered.push(rb.trim());
    }
    pos = gTo;
  }
  out += o.slice(pos);
  return { text: out, recovered };
}

export function recoveredBlock(recovered) {
  if (!recovered.length) return '';
  return `\n\n> Recovered text, kept from another tab or device so that nothing is lost. Keep what you want and delete the rest.\n\n${recovered.join('\n\n')}\n`;
}

const idle = (fn, timeout) => {
  if (typeof requestIdleCallback === 'function') return requestIdleCallback(fn, { timeout });
  return setTimeout(fn, Math.min(timeout, 400));
};

// ---------------------------------------------------------------- one pane
export class PaneSync {
  constructor(mgr, { postId, pane, tab, headless = false }) {
    this.mgr = mgr;
    this.postId = postId;
    this.pane = pane;
    this.tab = tab; // whose record this is (our own tab, or an adopted one)
    this.id = `${mgr.userId}:${postId}:${pane}:${tab}`;
    this.headless = headless;
    this.base = null; // { version, text }; null while unknown (offline, nothing cached)
    this.pending = []; // ops not yet confirmed; the first inflight.n were sent as batch inflight.seq
    this.inflight = null; // { seq, n, baseVersion, uncertain }
    this.acked = []; // batches confirmed since the snapshot (persisted)
    this.snapV = null; // version of the persisted snapshot, null if none
    this.needSnap = false; // the persisted snapshot + acked log no longer reproduce base
    this.state = 'ok'; // ok | offline | closed | reason | error | auth
    this.reasonWords = null; // reason: how many words the refused change removes (SPEC §30)
    this.retryAt = 0;
    this.backoff = 1000;
    this.sending = false;
    this.fetching = false;
    this.persistQueued = false;
    this.lastSnapAt = 0;
    this.lastEnd = null; // where our last confirmed op ended, in base coordinates (for tie-breaks)
    this.onRemote = null; // (changes|null, newLocalText, oldLocalText) => void, set by the editor
  }
  get localText() {
    return this.base ? applyOps(this.base.text, this.pending) : '';
  }
  get busy() {
    return !!(this.pending.length || this.inflight);
  }

  push(op) {
    if (!this.base) return; // read-only until the text is known
    this.pending.push(op);
    this.schedulePersist();
    this.mgr.changed();
    if (this.pending.length > 300) this.mgr.kick();
  }

  // ---- persistence
  schedulePersist() {
    if (this.persistQueued) return;
    this.persistQueued = true;
    idle(() => {
      this.persistQueued = false;
      this.persist();
    }, 1000);
  }
  record({ snapV = this.snapV, acked = this.acked } = {}) {
    return {
      k: `q|${this.id}`, user: this.mgr.userId, post: this.postId, pane: this.pane, tab: this.tab,
      owner: this.mgr.tab, aliveAt: Date.now(), closedAt: this.mgr.closing ? Date.now() : null, savedAt: Date.now(),
      snapV, acked: acked.slice(),
      inflight: this.inflight ? { seq: this.inflight.seq, n: this.inflight.n, baseVersion: this.inflight.baseVersion } : null,
      pending: this.pending.slice(),
      lastEnd: this.lastEnd,
    };
  }
  // A self-contained copy of the unsent work in localStorage, written synchronously
  // when the page is hidden or closing: an IndexedDB write started at pagehide can
  // be cut off, a localStorage write can't. Another tab adopts it from here.
  mirror({ closing = false } = {}) {
    const key = `wh-q:${this.id}`;
    try {
      if (!this.busy || !this.base) {
        localStorage.removeItem(key);
        return;
      }
      const rec = this.record();
      rec.k = `q|${this.id}`;
      rec.closedAt = closing ? Date.now() : null;
      rec.mirror = true;
      rec.base = { version: this.base.version, text: this.base.text };
      rec.snapV = null;
      rec.acked = [];
      rec.lastEnd = this.lastEnd;
      localStorage.setItem(key, JSON.stringify(rec));
    } catch { /* storage full or blocked: the IndexedDB copy stands */ }
  }
  // Write this queue to disk: true when committed, 'stolen' when another tab owns the
  // record now (this one was suspended and its queue adopted), false when the write
  // failed. Every write checks the owner in the same transaction, and nothing in memory
  // claims a snapshot exists until the write has committed.
  // snapshot: write the base text now (else only when the log can't reproduce it).
  // extraDels: records to delete in the same transaction (an adopted orphan's).
  async persist({ snapshot = false, extraDels = [] } = {}) {
    if (!this.base || this.stolen) return this.stolen ? 'stolen' : true;
    if (this.headless && !this.busy) return this.forget();
    const puts = [];
    const dels = [...extraDels];
    const compact = this.acked.length > 40 || (this.acked.length && Date.now() - this.lastSnapAt > 10_000);
    if (!this.busy) this.snapFresh = false;
    const fresh = this.busy && !this.snapFresh;
    const take = this.snapV === null || this.needSnap || snapshot || compact || fresh;
    const nAcked = this.acked.length;
    const snapV = take ? this.base.version : this.snapV;
    let stale = [];
    if (take) {
      puts.push([`s|${this.id}`, { k: `s|${this.id}`, version: this.base.version, text: this.base.text, savedAt: Date.now() }]);
      // Superseded records of tabs that closed with nothing unsent go with it.
      stale = this.mgr.staleFor(this.postId, this.pane, this.base.version, false);
      for (const k of stale) dels.push(`q|${k}`, `s|${k}`, `o|${k}`);
    }
    puts.push([`q|${this.id}`, this.record({ snapV, acked: take ? [] : this.acked })]);
    puts.push([`o|${this.id}`, { k: `o|${this.id}`, owner: this.mgr.tab }]);
    let stolen = false;
    const res = await kv.atomic([`o|${this.id}`, `q|${this.id}`], ([o, q]) => {
      const owner = o?.owner ?? q?.owner;
      if (owner && owner !== this.mgr.tab) {
        stolen = true;
        return null;
      }
      return { puts, dels };
    });
    if (stolen) {
      this.markStolen();
      return 'stolen';
    }
    if (!res) return false;
    if (take) {
      this.snapV = snapV;
      this.acked = this.acked.slice(nAcked); // acks that arrived during the write follow the snapshot
      this.needSnap = false;
      this.lastSnapAt = Date.now();
      if (this.busy) this.snapFresh = true;
      this.mgr.dropStale(this.postId, this.pane, stale);
    }
    return true;
  }
  // Another tab adopted this queue while this page was suspended: it sends the work
  // now, so this copy stops, and the page reloads to show the result.
  markStolen() {
    if (this.stolen) return;
    this.stolen = true;
    this.state = 'error';
    if (this.headless) this.mgr.dropGhost(this);
    else this.mgr.onStolen?.();
  }
  // Headless (adopted) queue that has delivered everything: remove its records.
  async forget() {
    await kv.write([], [`q|${this.id}`, `s|${this.id}`, `o|${this.id}`]);
    this.mgr.dropGhost(this);
    return true;
  }

  // ---- sending
  async send() {
    // A closing page sends nothing more: its records are marked closed, and the
    // next tab adopts them (same batch ids), so nothing can be sent twice.
    if (this.sending || !this.base || this.stolen || this.mgr.closing || this.state === 'closed' || this.state === 'reason' || this.state === 'auth') return;
    if (Date.now() < this.retryAt) return;
    this.sending = true;
    try {
      if (!this.inflight) {
        if (!this.pending.length) return;
        const f = { seq: rid(), n: Math.min(this.pending.length, 1500), baseVersion: this.base.version, uncertain: false };
        this.inflight = f;
        // Write-ahead: the batch id is on disk before the batch can reach the server.
        const ok = await Promise.race([this.persist(), new Promise((r) => setTimeout(() => r(false), 5000))]);
        if (ok === 'stolen') return;
        if (ok !== true) {
          // Not on disk: don't send it yet (a crash after sending would replay it under
          // another id). After a few failures the device's storage is broken: send anyway.
          this.walFailures = (this.walFailures || 0) + 1;
          if (this.walFailures < 3) {
            if (this.inflight === f) this.inflight = null;
            this.retryAt = Date.now() + 1000;
            return;
          }
        } else this.walFailures = 0;
      }
      await this.trySend();
    } finally {
      this.sending = false;
    }
  }
  // Send the in-flight batch, holding the pane's sending state until the request settles.
  sendInflight() {
    if (this.sending) return this.sendingP || Promise.resolve();
    if (!this.inflight) return Promise.resolve();
    this.sending = true;
    this.sendingP = this.trySend().finally(() => {
      this.sending = false;
      this.sendingP = null;
    });
    return this.sendingP;
  }
  async trySend() {
    const f = this.inflight;
    if (!f) return;
    const ops = this.pending.slice(0, f.n);
    try {
      const res = await api('/api/ops', {
        postId: this.postId, pane: this.pane, baseVersion: f.baseVersion, baseLen: this.base.text.length, seq: f.seq, sentAt: Date.now(), ops,
      }, { timeoutMs: 20000 });
      if (this.inflight !== f) return; // this batch was settled by another answer already
      if (!res || !Number.isInteger(res.version)) {
        const err = new Error('Unreadable answer');
        err.network = true; // whether it was applied is unknown
        throw err;
      }
      this.onAck(res, f, ops);
    } catch (e) {
      if (this.inflight !== f) return;
      if (e.network || e.status === 0 || e.status >= 500 || e.status === 429) {
        f.uncertain = true; // it may have reached the server
        this.state = 'offline';
        this.retryAt = Date.now() + this.backoff;
        this.backoff = Math.min(this.backoff * 2, 15000);
      } else if (e.status === 409 && e.data.code === 'conflict') {
        this.onConflict(e.data, f);
      } else if (e.status === 409 && (e.data.code === 'ended' || e.data.code === 'not-started')) {
        this.state = 'closed';
      } else if (e.status === 409 && e.data.code === 'reason-needed') {
        // After the party, a change that removes 50+ words needs a reason (SPEC §30). Nothing was
        // applied: the batch waits here, as it is, until the page has given one and sets the
        // state back to 'ok'; then it goes again under the same id.
        this.state = 'reason';
        this.reasonWords = Number.isFinite(e.data.words) ? e.data.words : null;
        this.mgr.onReasonNeeded?.(this, e.data);
      } else if (e.status === 401) {
        this.state = 'auth';
      } else if (e.status === 400 && e.data.code === 'range') {
        await this.refetchAndMerge(f);
      } else if (e.status === 404) {
        // The post is gone (or was never ours): nothing can be delivered.
        this.state = 'error';
        this.retryAt = Date.now() + 60_000;
      } else {
        this.state = 'error';
        this.retryAt = Date.now() + 10000;
      }
    }
    this.mgr.changed();
  }
  onAck(res, f, ops) {
    const expected = applyOps(this.base.text, ops);
    this.pending.splice(0, f.n);
    this.inflight = null;
    this.state = 'ok';
    this.backoff = 1000;
    this.retryAt = 0;
    // Where this run of typing ended: our next ops continue from here (rebase tie-breaks).
    const last = ops[ops.length - 1];
    if (last) this.lastEnd = last.pos + (last.ins ? last.ins.length : 0);
    if (res.sanitized && typeof res.text === 'string' && res.text !== expected) {
      // The server removed invisible characters: adopt its text, rebase what's queued
      // (the run's end is mapped through the removal with it).
      const local = applyOps(expected, this.pending);
      this.rebaseOnto(res.version, res.text, diffChangeSet(expected, res.text), expected, local);
      this.needSnap = true;
    } else {
      this.base = { version: res.version, text: expected };
      this.acked.push({ seq: f.seq, v: res.version, ops });
    }
    this.mgr.onAck?.(this);
    this.schedulePersist();
    if (this.pending.length) this.mgr.kick();
  }
  // Rebase this.pending (made on `from`) over theirs (from -> serverText).
  rebaseOnto(version, serverText, theirs, from, localBefore) {
    let r;
    // Our run of typing continues from the end of our last confirmed op (stored with the
    // queue, so a restored or adopted queue has it too). With no confirmed op there's no
    // run to continue: a queue never sent (a new tab's) yields to a run already on the
    // server at the same point, so it can't land in the middle of another tab's sentence.
    try {
      r = rebaseOps(this.pending, theirs, from.length, this.lastEnd);
    } catch {
      r = null;
    }
    try {
      this.lastEnd = this.lastEnd === null || !r ? null : theirs.mapPos(this.lastEnd, -1);
    } catch {
      this.lastEnd = null;
    }
    const local = localBefore ?? applyOps(from, this.pending);
    if (!r) {
      // Shouldn't happen; fall back to a text merge so nothing is lost.
      const m = merge3(from, serverText, local);
      const merged = m.text + recoveredBlock(m.recovered);
      this.base = { version, text: serverText };
      this.pending = diffOps(serverText, merged, this.lastAt());
      this.onRemote?.(null, merged, local);
      return;
    }
    this.base = { version, text: serverText };
    this.pending = r.ops;
    const merged = applyOps(serverText, r.ops);
    this.onRemote?.(r.theirsOverMine, merged, local);
  }
  lastAt() {
    return this.pending.length ? this.pending[this.pending.length - 1].at : Date.now();
  }
  // 409: someone else wrote since our base. Merge, never overwrite.
  onConflict(d, f) {
    const local = this.localText;
    let from = this.base.text;
    let dup = d.duplicate && Number.isInteger(d.appliedVersion) && f ? { version: d.appliedVersion, base: d.base } : null;
    let since = Array.isArray(d.since) ? d.since : null;
    if (!dup && f && f.uncertain) {
      // Our batch may have landed (its answer was lost) and the server no longer knows
      // its id. If the server's history since our base is there, look for our batch at
      // its head; with no history, nothing proves either way: a text-level merge, which
      // takes a change both sides made once, instead of replaying it.
      const own = this.pending.slice(0, f.n);
      const same = (a, b) => a.length === b.length && a.every((o, i) => o[0] === b[i].pos && (o[1] || 0) === (b[i].del || 0) && (o[2] || '') === (b[i].ins || ''));
      if (since && d.base && d.base.text === from && since.length && same(since[0].ops || [], own)) {
        dup = { version: since[0].version, base: { version: since[0].version, text: applyOps(from, own) } };
        since = since.slice(1);
      } else if (!since || !d.base) {
        this.mergeText(d, local);
        return this.afterMerge();
      }
    }
    if (dup) {
      // Our batch was applied earlier (as appliedVersion); more came after it.
      const own = this.pending.slice(0, f.n);
      const applied = applyOps(from, own);
      this.pending = this.pending.slice(f.n);
      const last = own[own.length - 1];
      this.lastEnd = last ? last.pos + (last.ins ? last.ins.length : 0) : this.lastEnd;
      from = dup.base && typeof dup.base.text === 'string' ? dup.base.text : applied;
      this.base = { version: dup.version, text: from };
      if (from !== applied) {
        // Shouldn't differ; if it does, carry the difference into our queue.
        const mineLocal = applyOps(applied, this.pending);
        this.pending = diffOps(from, mineLocal, this.lastAt());
      }
    }
    this.inflight = null;
    let theirs = null;
    try {
      const baseOk = dup ? (!dup.base || dup.base.text === from) : (d.base && d.base.version === this.base.version && d.base.text === from);
      if (baseOk && since) {
        theirs = changeSetFromSince(from.length, since);
        if (theirs.newLength !== d.text.length) theirs = null;
      }
    } catch {
      theirs = null;
    }
    if (!theirs) theirs = diffChangeSet(from, d.text);
    this.rebaseOnto(d.version, d.text, theirs, from, local);
    this.needSnap = true;
    return this.afterMerge();
  }
  mergeText(d, local) {
    this.lastEnd = null;
    const m = merge3(this.base.text, d.text, local);
    const merged = m.text + recoveredBlock(m.recovered);
    this.base = { version: d.version, text: d.text };
    this.pending = diffOps(d.text, merged, this.lastAt());
    this.inflight = null;
    this.needSnap = true;
    this.onRemote?.(null, merged, local);
  }
  afterMerge() {
    this.state = 'ok';
    this.retryAt = 0;
    this.backoff = 1000;
    this.persist();
    this.mgr.kick();
  }
  async refetchAndMerge(f) {
    try {
      const r = await api(`/api/post?id=${encodeURIComponent(this.postId)}&pane=${this.pane}`);
      // A range error means the batch was not applied: rebase everything onto the server text.
      this.onConflict({ version: r.version, text: r.text, base: null, since: null }, f && { ...f, uncertain: false });
    } catch {
      this.state = 'error';
      this.retryAt = Date.now() + 5000;
    }
  }
  // The server has a newer version (another window or device wrote).
  async remoteVersion(version) {
    if (this.headless || this.fetching) return;
    if (this.base && (version <= this.base.version || this.inflight || this.sending)) return;
    this.fetching = true;
    try {
      const r = await api(`/api/post?id=${encodeURIComponent(this.postId)}&pane=${this.pane}`);
      if (!this.base) {
        this.base = { version: r.version, text: r.text };
        this.needSnap = true;
        this.onRemote?.(null, r.text, '');
        this.mgr.onBaseKnown?.(this);
        return;
      }
      if (r.version <= this.base.version || this.inflight || this.sending) return;
      const from = this.base.text;
      const local = this.localText;
      // Anything queued here hasn't been sent, so it rebases cleanly.
      this.rebaseOnto(r.version, r.text, diffChangeSet(from, r.text), from, local);
      this.needSnap = true;
      if (this.pending.length) this.mgr.kick();
    } catch { /* next time */ } finally {
      this.fetching = false;
    }
  }
}

// ---------------------------------------------------------------- the manager
// Every SyncManager on this page, for update.js: before the reload a writer asks for after a
// deploy, it settles them without loading this module itself.
const managers = (globalThis.__whSyncManagers ||= new Set());

export class SyncManager {
  constructor({ userId, onStatus }) {
    managers.add(this);
    this.userId = userId;
    this.onStatus = onStatus;
    this.panes = new Map(); // `${postId}:${pane}` -> our own PaneSync
    this.ghosts = new Set(); // adopted queues of closed tabs, sending on their own
    this.lastStatus = '';
    this.closing = false;
    this.tab = rid();
    this.prevTab = null;
    this.storedV = new Map(); // `${postId}:${pane}` -> [{ id, version, busy }] records of other tabs
    this.onBaseKnown = null;
  }

  async init() {
    try {
      this.prevTab = sessionStorage.getItem('wh-tab');
      sessionStorage.setItem('wh-tab', this.tab);
    } catch { /* private mode */ }
    if (navigator.locks?.request) {
      // Held while this page lives, so other tabs can tell it's open (a frozen tab keeps
      // it; a crashed or closed one loses it). Released at pagehide, after the unsent
      // work is copied: a lock held through teardown of a service-worker-controlled page
      // crashed Chromium in testing.
      navigator.locks.request(`wh-tab:${this.tab}`, () => new Promise((resolve) => { this.releaseLock = resolve; })).catch(() => {});
    }
    // v1 records (key user:post:pane), from before per-tab queues.
    this.legacy = new Map();
    for (const [k, v] of await kv.entries(`${this.userId}:`)) if (v && typeof v.baseText === 'string') this.legacy.set(k, v);
    this.held = await heldLocks();
    this.timer = setInterval(() => this.flush(), 1000);
    window.addEventListener('online', () => {
      for (const p of this.allPanes()) p.retryAt = 0;
      this.flush();
      this.adoptOrphans();
    });
    window.addEventListener('pagehide', () => {
      for (const p of this.allPanes()) p.mirror({ closing: true }); // synchronous: it lands
      this.persistAll({ closing: true });
      this.releaseLock?.();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        for (const p of this.allPanes()) p.mirror();
        this.persistAll();
        this.flush();
      } else {
        // Back: the live queues are ours again; their copies in localStorage go.
        for (const p of this.allPanes()) {
          try {
            localStorage.removeItem(`wh-q:${p.id}`);
          } catch { /* ignore */ }
        }
      }
    });
    // A tab that closes writes its copy to localStorage: adopt it at once.
    window.addEventListener('storage', (e) => {
      if (e.key && e.key.startsWith(`wh-q:${this.userId}:`) && e.newValue) setTimeout(() => this.adoptOrphans(), 150);
    });
    try {
      this.bc = new BroadcastChannel('wh-sync');
      this.bc.onmessage = (e) => {
        if (e.data && e.data.type === 'bye' && e.data.user === this.userId) setTimeout(() => this.adoptOrphans(), 300);
      };
    } catch { /* no BroadcastChannel */ }
    this.orphanTimer = setInterval(() => this.adoptOrphans(), 15_000);
    // Without Web Locks (old browsers), liveness falls back to closed marks and a heartbeat.
    if (!navigator.locks?.request) this.beatTimer = setInterval(() => this.heartbeat(), 30_000);
  }

  // Queue records from IndexedDB, with each closed or hidden tab's localStorage copy
  // taking the place of its IndexedDB record when it's newer.
  async queueRecords(prefix) {
    const byId = new Map();
    for (const r of await kv.range(`q|${prefix}`)) if (r && r.k) byId.set(r.k, r);
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(`wh-q:${prefix}`)) continue;
        let m = null;
        try {
          m = JSON.parse(localStorage.getItem(k));
        } catch { /* broken copy */ }
        if (!m || !m.k) continue;
        const cur = byId.get(m.k);
        if (!cur || (m.savedAt || 0) >= (cur.savedAt || 0)) byId.set(m.k, m);
        else if (cur.owner !== m.owner) localStorage.removeItem(k); // someone adopted it since
      }
    } catch { /* no localStorage */ }
    return [...byId.values()];
  }

  // Is the tab that owns this record still open?
  async alive(rec) {
    if (rec.owner === this.tab) return true;
    if (rec.closedAt) return false;
    if (this.held) {
      if (!this.held.has(`wh-tab:${rec.owner}`)) return false;
      if (rec.owner !== this.prevTab) return true;
      // Our own previous page (a reload): give it a moment to let go (once).
      this.prevAlive ??= lockFree(`wh-tab:${rec.owner}`, 1500).then((free) => !free);
      return this.prevAlive;
    }
    return Date.now() - (rec.aliveAt || 0) < 120_000;
  }
  // Take ownership of an orphaned record (atomic compare-and-set in IndexedDB: of
  // two tabs trying at once, one wins). A localStorage copy carries its own text.
  async claim(rec) {
    const id = rec.k.slice(2);
    let base = null;
    let got = null;
    await kv.atomic([`o|${id}`, rec.k], ([o, cur]) => {
      const owner = o?.owner ?? cur?.owner;
      if (owner && owner !== rec.owner) return null; // adopted by someone else already
      if (!rec.mirror && (!cur || cur.savedAt !== rec.savedAt)) return null; // changed since we looked
      if (rec.mirror && cur && (cur.savedAt || 0) > (rec.savedAt || 0)) return null; // the disk copy is newer
      const { base: b, mirror, ...plain } = rec;
      base = b || null;
      got = { ...plain, owner: this.tab, closedAt: null, aliveAt: Date.now(), ...(mirror ? { snapV: null, acked: [] } : {}) };
      return { puts: [[rec.k, got], [`o|${id}`, { k: `o|${id}`, owner: this.tab }]] };
    });
    if (!got) return null;
    try {
      localStorage.removeItem(`wh-q:${rec.k.slice(2)}`);
    } catch { /* ignore */ }
    return base ? { ...got, base } : got;
  }
  // One of our own panes was adopted while this page was suspended: reload once.
  onStolen() {
    if (this.reloading) return;
    this.reloading = true;
    setTimeout(() => location.reload(), 50);
  }
  async loadRecord(q) {
    if (q.base && typeof q.base.text === 'string') {
      return { base: { version: q.base.version, text: q.base.text }, inflight: q.inflight || null, pending: Array.isArray(q.pending) ? q.pending : [], lastEnd: q.lastEnd ?? null };
    }
    const snap = await kv.get(`s|${q.k.slice(2)}`);
    if (!snap || typeof snap.text !== 'string') return null;
    let text = snap.text;
    let version = snap.version;
    if (q.snapV !== null && q.snapV !== undefined && q.snapV !== snap.version) return null;
    try {
      for (const b of q.acked || []) {
        text = applyOps(text, b.ops);
        version = b.v;
      }
    } catch {
      return null;
    }
    return { base: { version, text }, inflight: q.inflight || null, pending: Array.isArray(q.pending) ? q.pending : [], lastEnd: q.lastEnd ?? null };
  }

  // Open one pane at start-up. server = { version, text } (online) or null (offline).
  async openPane({ postId, pane, server }) {
    const key = `${postId}:${pane}`;
    let s = this.panes.get(key);
    if (s) return s;
    s = new PaneSync(this, { postId, pane, tab: this.tab });
    this.panes.set(key, s);
    const recs = await this.queueRecords(`${this.userId}:${postId}:${pane}:`);
    const others = []; // records we only read (and may clean up once superseded, if their tab is gone)
    const orphans = [];
    for (const r of recs) {
      const busy = !!((r.pending && r.pending.length) || r.inflight);
      const alive = await this.alive(r);
      if (busy && !alive) orphans.push(r);
      else others.push({ id: r.k.slice(2), busy, alive, rec: r });
    }
    // Claim orphans with unsent work; the most recent one becomes this tab's queue.
    let primary = null;
    for (const r of orphans.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))) {
      if (!(await this.loadRecord(r))) continue; // can't rebuild its text: leave it be
      const got = await this.claim(r);
      const st = got && (await this.loadRecord(got));
      if (!st) continue;
      if (!primary) primary = { rec: got, st };
      else this.startGhost(got, st);
    }
    // A v1 record (older client): unsent ops with no batch id.
    const v1 = this.legacy.get(`${this.userId}:${postId}:${pane}`);

    if (primary) {
      const { base, inflight, pending } = primary.st;
      s.base = base;
      s.pending = pending;
      s.inflight = inflight ? { ...inflight, uncertain: true } : null;
      s.lastEnd = primary.st.lastEnd ?? null;
      s.needSnap = true;
      // Our own record takes the work and the orphan's goes, in one transaction: a crash
      // can't leave two copies (which would replay twice).
      const oid = primary.rec.k.slice(2);
      await s.persist({ snapshot: true, extraDels: [primary.rec.k, `s|${oid}`, `o|${oid}`] });
      if (server) await this.reconcile(s, server);
    } else if (server) {
      s.base = { version: server.version, text: server.text };
    } else {
      // Offline start: the freshest text any record on this device has.
      let best = null;
      for (const o of others) {
        const st = await this.loadRecord(o.rec);
        if (st && (!best || st.base.version > best.version)) best = st.base;
      }
      s.base = best;
    }
    if (v1 && Array.isArray(v1.pending) && v1.pending.length && typeof v1.baseText === 'string' && s.base) {
      this.adoptV1(s, v1);
      await s.persist();
      await kv.write([], [`${this.userId}:${postId}:${pane}`]);
    } else if (v1) {
      await kv.write([], [`${this.userId}:${postId}:${pane}`]);
    }
    // Remember what closed tabs left behind, so superseded records can be cleaned up later
    // (never an open tab's: it may still need its snapshot).
    this.storedV.set(key, others.filter((o) => !o.busy && !o.alive).map((o) => ({ id: o.id, snapV: o.rec.snapV, acked: (o.rec.acked || []).length })));
    return s;
  }

  // An adopted queue at start-up, while online: send its in-flight batch first
  // (same id), then rebase what's left onto the server's text.
  async reconcile(s, server) {
    if (s.inflight) {
      // Waits at most 6 s for the page; the request itself keeps the pane until it settles.
      await Promise.race([s.sendInflight(), new Promise((r) => setTimeout(r, 6000))]);
    }
    if (!s.inflight && !s.sending && s.base && s.base.version < server.version && s.state !== 'offline') {
      // Not sent yet, so it can't be on the server: rebase onto the server's text.
      s.rebaseOnto(server.version, server.text, diffChangeSet(s.base.text, server.text), s.base.text);
      s.needSnap = true;
    }
  }

  // v1 records (before this version) kept unsent ops without batch ids, and an
  // in-flight batch may have reached the server: merge at text level (dedupes).
  adoptV1(s, v1) {
    const mine = applyOps(v1.baseText, v1.pending);
    const local = s.localText;
    if (v1.version === s.base.version && v1.baseText === s.base.text && !s.pending.length) {
      s.pending = v1.pending.slice();
    } else {
      const m = merge3(v1.baseText, local, mine);
      const merged = m.text + recoveredBlock(m.recovered);
      s.pending = s.pending.concat(diffOps(local, merged, v1.pending[v1.pending.length - 1]?.at || Date.now()));
    }
    s.needSnap = true;
  }

  // Records of other tabs that are older than `version` and hold nothing unsent.
  staleFor(postId, pane, version, consume = true) {
    const key = `${postId}:${pane}`;
    const list = this.storedV.get(key) || [];
    const out = list.filter((o) => o.snapV !== null && o.snapV !== undefined && o.acked === 0 && o.snapV <= version).map((o) => o.id);
    if (consume) this.dropStale(postId, pane, out);
    return out;
  }
  dropStale(postId, pane, ids) {
    if (!ids.length) return;
    const key = `${postId}:${pane}`;
    this.storedV.set(key, (this.storedV.get(key) || []).filter((o) => !ids.includes(o.id)));
  }

  startGhost(rec, st) {
    const tab = rec.tab || rec.k.split(':').pop();
    const g = new PaneSync(this, { postId: rec.post, pane: rec.pane, tab, headless: true });
    g.base = st.base;
    g.pending = st.pending;
    g.inflight = st.inflight ? { ...st.inflight, uncertain: true } : null;
    g.snapV = rec.snapV ?? null;
    g.acked = rec.acked || [];
    g.lastEnd = st.lastEnd ?? null;
    if (g.snapV === null) g.needSnap = true;
    this.ghosts.add(g);
    g.send();
    return g;
  }
  dropGhost(g) {
    this.ghosts.delete(g);
    this.changed();
  }

  // Look for tabs that closed with unsent work, and send it for them.
  async adoptOrphans() {
    if (this.adopting) return;
    this.adopting = true;
    try {
      this.held = await heldLocks();
      const recs = await this.queueRecords(`${this.userId}:`);
      for (const r of recs) {
        if (!r || r.owner === this.tab) continue;
        const busy = !!((r.pending && r.pending.length) || r.inflight);
        if (!busy || (await this.alive(r))) continue;
        if (!(await this.loadRecord(r))) continue; // can't rebuild its text
        const got = await this.claim(r);
        if (!got) continue;
        const st = await this.loadRecord(got);
        if (st) this.startGhost(got, st);
      }
    } finally {
      this.adopting = false;
    }
  }

  async heartbeat() {
    for (const p of this.allPanes()) if (p.busy) p.persist();
  }

  get(postId, pane) {
    return this.panes.get(`${postId}:${pane}`) || null;
  }
  *allPanes() {
    yield* this.panes.values();
    yield* this.ghosts;
  }
  persistAll({ closing = false } = {}) {
    this.closing = closing;
    for (const p of this.allPanes()) {
      if (p.busy || p.needSnap || closing) p.persist({ snapshot: closing && p.base && p.snapV !== p.base.version });
    }
    if (closing) {
      try {
        this.bc?.postMessage({ type: 'bye', user: this.userId, tab: this.tab });
      } catch { /* ignore */ }
    }
  }
  kick() {
    clearTimeout(this.kickTimer);
    this.kickTimer = setTimeout(() => this.flush(), 30);
  }
  flush() {
    for (const p of this.allPanes()) p.send();
    this.changed();
  }
  // Before a reload the writer asked for (update.js, after a deploy): send what's queued now
  // (no waiting out a retry pause), keep it on disk, and wait at most `ms` for the server to
  // confirm it. True when nothing is left to send; anything left stays queued on this device
  // and goes after the reload, as from any closed tab.
  async settle(ms = 3000) {
    const until = Date.now() + ms;
    const unsent = () => [...this.allPanes()].some((p) => p.busy && !p.stolen && p.state !== 'closed' && p.state !== 'reason' && p.state !== 'auth');
    for (const p of this.allPanes()) p.retryAt = 0;
    this.persistAll();
    this.flush();
    while (unsent() && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 100));
      this.flush();
    }
    return !unsent();
  }
  // Ops typed here that the server hasn't confirmed yet (for the immediate word estimate).
  *queuedOps() {
    for (const p of this.panes.values()) yield* p.pending;
  }
  pendingCount() {
    let n = 0;
    for (const p of this.allPanes()) n += p.pending.length;
    return n;
  }
  status() {
    const ps = [...this.allPanes()];
    const pending = this.pendingCount();
    if (ps.some((p) => p.state === 'auth')) return { kind: 'auth', pending };
    if (ps.some((p) => p.state === 'reason' && p.busy)) return { kind: 'reason', pending };
    if (ps.some((p) => p.state === 'closed' && p.pending.length)) return { kind: 'closed', pending };
    if (ps.some((p) => p.state === 'offline')) return { kind: 'offline', pending };
    if (ps.some((p) => p.state === 'error' && p.pending.length)) return { kind: 'error', pending };
    if (pending) return { kind: 'saving', pending };
    return { kind: 'saved', pending: 0 };
  }
  changed() {
    const s = this.status();
    const key = `${s.kind}:${s.pending > 0}`;
    if (key !== this.lastStatus) {
      this.lastStatus = key;
      this.onStatus?.(s);
    }
  }

  // ---- what the writer page needs to open offline
  async saveBoot(data) {
    return kv.write([[`b|${this.userId}`, { k: `b|${this.userId}`, ...data, savedAt: Date.now() }]]);
  }
}

export async function loadBoot(userId) {
  if (!userId) return null;
  return (await kv.get(`b|${userId}`)) || null;
}
export async function clearBoot(userId) {
  if (userId) await kv.write([], [`b|${userId}`]);
}

async function heldLocks() {
  if (!navigator.locks?.query) return null;
  try {
    const s = await navigator.locks.query();
    return new Set([...(s.held || []), ...(s.pending || [])].map((l) => l.name));
  } catch {
    return null;
  }
}
// Resolves true if the lock could be taken (and released) within ms.
async function lockFree(name, ms) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    await navigator.locks.request(name, { signal: ctrl.signal }, () => {});
    clearTimeout(t);
    return true;
  } catch {
    return false;
  }
}

