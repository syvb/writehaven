// Append-only op journal: one JSONL file per writer, one line per applied batch:
//   [postId, paneCode, versionAfter, [[t, pos, del, ins, paste?], ...]]
// The op log is the only large, ever-growing part of the state, so it is kept
// out of the JSON state file (which is rewritten atomically).
//
// The event loop never touches the disk for it: append() queues the line and returns at once;
// the lines of each file are written in order, in the thread pool, one write at a time (lines
// queued meanwhile go out together), and flushed with fdatasync, one flush covering every line
// written before it started (group commit). append() returns a promise that settles once the
// line is flushed; its `.written` promise settles once the line is in the kernel (from then on a
// crash of this process can't lose it). The server acknowledges a batch only after `.written`,
// and waits for the flush up to a bound (server.js). A write that fails is retried, in order,
// until it succeeds: a line is never dropped while the process lives. On a congested disk a
// write can block for hundreds of ms; then only that writer's acknowledgement waits, not the
// whole server.

import fs from 'node:fs';
import path from 'node:path';

const SAFE = /^[A-Za-z0-9_-]{1,64}$/;
const RETRY_MS = 500;

export class Journal {
  constructor(dir, { log = console, fsync = true } = {}) {
    this.dir = dir;
    this.log = log;
    this.fsync = fsync;
    this.files = new Map(); // userId -> { fd, queue, writing, flushing, written, opening }
    this.closed = false;
  }
  file(userId) {
    if (!SAFE.test(userId)) throw new Error(`bad journal id ${userId}`);
    return path.join(this.dir, `${userId}.jsonl`);
  }
  append(userId, rec) {
    const file = this.file(userId); // throws for a bad id, before anything is queued
    let F = this.files.get(userId);
    if (!F) this.files.set(userId, (F = { file, fd: null, queue: [], writing: false, flushing: false, toFlush: [] }));
    const item = { line: `${JSON.stringify(rec)}\n` };
    const written = new Promise((resolve) => { item.written = resolve; });
    const durable = new Promise((resolve, reject) => {
      item.resolve = resolve;
      item.reject = reject;
    });
    durable.written = written;
    F.queue.push(item);
    if (!F.writing) this.pump(F);
    return durable;
  }
  // Open (or create) a writer's file; never glue a record onto a torn last line (a crash
  // mid-write): end it first. `resume`: a write of ours stopped part-way, and goes on from there.
  async open(F, resume = false) {
    await fs.promises.mkdir(this.dir, { recursive: true });
    const fh = await fs.promises.open(F.file, 'a+');
    try {
      const { size } = await fh.stat();
      if (size > 0 && !resume) {
        const last = Buffer.alloc(1);
        await fh.read(last, 0, 1, size - 1);
        if (last[0] !== 0x0a) await fh.write('\n');
      }
    } catch (e) {
      await fh.close().catch(() => {});
      throw e;
    }
    return fh;
  }
  async pump(F) {
    F.writing = true;
    try {
      while (F.queue.length && !this.closed) {
        const batch = F.queue.splice(0);
        const buf = Buffer.from(batch.map((x) => x.line).join(''), 'utf8');
        let off = 0; // bytes of buf already in the file
        for (let attempt = 0; ; attempt++) {
          try {
            if (!F.fd) F.fd = await this.open(F, off > 0);
            while (off < buf.length) off += (await F.fd.write(buf, off, buf.length - off)).bytesWritten;
            break;
          } catch (e) {
            // A write can fail part-way (a full disk takes what fits, then refuses the rest). The
            // retry goes on from the last byte that went in: starting the batch over would write
            // its first lines twice, and the boot would replay them twice.
            if (attempt === 0 || attempt % 20 === 0) this.log.error(`[journal] write failed (${e && e.message}); retrying`);
            if (F.fd) await F.fd.close().catch(() => {});
            F.fd = null;
            if (this.closed) return;
            await new Promise((r) => setTimeout(r, RETRY_MS));
          }
        }
        for (const x of batch) x.written();
        if (this.fsync) {
          F.toFlush.push(...batch);
          if (!F.flushing) this.flush(F);
        } else for (const x of batch) x.resolve();
      }
    } finally {
      F.writing = false;
    }
  }
  // Group commit per file: one fdatasync covers every line written before it started.
  async flush(F) {
    F.flushing = true;
    try {
      while (F.toFlush.length && F.fd) {
        const batch = F.toFlush.splice(0);
        try {
          await F.fd.datasync();
          for (const x of batch) x.resolve();
        } catch (e) {
          for (const x of batch) x.reject(e);
        }
      }
    } finally {
      F.flushing = false;
    }
  }
  // Everything queued is written and flushed (shutdown).
  async drain() {
    for (let i = 0; i < 200; i++) {
      let busy = false;
      for (const F of this.files.values()) if (F.queue.length || F.writing || F.flushing) busy = true;
      if (!busy) return;
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  // { userId: [rec, ...] }. A torn last line (crash mid-write) is ignored, and cut off the file
  // when `repair` (at boot); readers beside a running server pass repair: false.
  readAll({ repair = true } = {}) {
    const out = {};
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch (e) {
      if (e.code === 'ENOENT') return out;
      throw e;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const uid = name.slice(0, -6);
      if (!SAFE.test(uid)) continue;
      const file = path.join(this.dir, name);
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split('\n');
      const recs = [];
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i]) continue;
        try {
          recs.push(JSON.parse(lines[i]));
        } catch {
          const torn = i === lines.length - 1;
          this.log.error(`[journal] ${name}: unreadable line ${i + 1} skipped${torn ? ` (torn write${repair ? ', removed' : ''})` : ''}`);
          // A torn tail (crash mid-write) is cut off so the next record starts on a clean line.
          if (torn && repair) fs.truncateSync(file, Buffer.byteLength(text) - Buffer.byteLength(lines[i]));
        }
      }
      out[uid] = recs;
    }
    return out;
  }
  // Shutdown: whatever is still queued is written and flushed synchronously, after the writes
  // in flight (call drain() first to let those finish). If a write is still in flight, the
  // queue is left unwritten rather than risk lines out of order: those batches were never
  // acknowledged, so their clients send them again (the boot takes versions from the journal).
  close() {
    this.closed = true;
    for (const F of this.files.values()) {
      try {
        if (F.queue.length && !F.writing) {
          const fd = fs.openSync(F.file, 'a');
          fs.writeSync(fd, F.queue.map((x) => x.line).join(''));
          fs.fdatasyncSync(fd);
          fs.closeSync(fd);
          for (const x of F.queue.splice(0)) {
            x.written();
            x.resolve();
          }
        }
      } catch (e) {
        this.log.error(`[journal] final write failed: ${e && e.message}`);
      }
      if (F.fd) {
        const fh = F.fd;
        F.fd = null;
        try {
          fs.fdatasyncSync(fh.fd);
        } catch { /* closed or unsupported */ }
        fh.close().catch(() => {});
      }
    }
    this.files.clear();
  }
}
