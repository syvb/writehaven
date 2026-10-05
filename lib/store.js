// Persistence: the whole state as one JSON file, written via tmp file + rename. The periodic
// save writes and fsyncs off the event loop; flush() (shutdown, host actions) writes at once.

import fs from 'node:fs';
import path from 'node:path';

// Returns the parsed state, or null if the file does not exist. A corrupt file
// is moved aside (never silently overwritten) and null is returned.
export function loadState(file, { log = console } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    const aside = `${file}.corrupt-${Date.now()}`;
    fs.renameSync(file, aside);
    log.error(`[store] ${file} is not valid JSON (${e.message}); moved to ${aside}, starting fresh`);
    return null;
  }
}

// Leftover temp files from a crash mid-save (never the source of truth): removed at boot.
export function cleanTempFiles(file, { log = console } = {}) {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.tmp-`;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    try {
      fs.rmSync(path.join(dir, name), { force: true });
      n++;
    } catch (e) {
      log.error(`[store] couldn't remove ${name}: ${e.message}`);
    }
  }
  return n;
}

let tmpSeq = 0;
export function writeStateSync(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${++tmpSeq}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(state));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

// Debounced saver: schedule() coalesces changes within `delayMs` and saves in the background
// (the JSON is taken at once; writing and fsync run in the thread pool); flushAsync() saves now
// in the background and resolves once the file holds this state; flush() saves synchronously
// (shutdown). Saves land in order: an older save never replaces a newer file. Renames in the
// thread pool can finish in any order, so background saves publish one at a time, and flush()
// takes away the file of a background rename still running before it renames its own.
export function createSaver(file, getState, { delayMs = 300, log = console } = {}) {
  let timer = null;
  let dirty = false;
  let started = 0; // sequence of saves begun
  let landed = 0; // newest save that reached the file
  let periodic = null; // the periodic save in flight (one at a time)
  const waiting = new Set(); // background saves in flight
  let publishing = Promise.resolve(); // background renames, one at a time, in order
  let renaming = null; // the temp file of the background rename running now
  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!dirty) return;
    dirty = false;
    const seq = ++started;
    try {
      // A background rename still running could land after ours: take its file away first (if
      // the rename already happened, ours lands after it anyway).
      if (renaming) try { fs.unlinkSync(renaming); } catch { /* already renamed */ }
      writeStateSync(file, getState());
      landed = Math.max(landed, seq);
    } catch (e) {
      dirty = true;
      log.error(`[store] save failed: ${e.message}`);
    }
  }
  // Take the state now, write it in the background. Resolves when this state (or a newer one)
  // is in the file; on failure the state stays dirty for the next save.
  function saveAsync() {
    if (!dirty) return waiting.size ? Promise.all([...waiting]).then(() => {}) : Promise.resolve();
    dirty = false;
    const seq = ++started;
    let text;
    try {
      text = JSON.stringify(getState());
    } catch (e) {
      dirty = true;
      log.error(`[store] save failed: ${e.message}`);
      return Promise.resolve();
    }
    const tmp = `${file}.tmp-${process.pid}-bg${seq}`;
    const job = (async () => {
      let fh = null;
      try {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        fh = await fs.promises.open(tmp, 'w');
        await fh.writeFile(text);
        await fh.sync();
        await fh.close();
        fh = null;
        const turn = publishing.then(async () => {
          if (seq <= landed) return fs.promises.rm(tmp, { force: true }); // a newer save already landed
          renaming = tmp;
          try {
            await fs.promises.rename(tmp, file);
            landed = Math.max(landed, seq);
          } catch (e) {
            if (!(e.code === 'ENOENT' && landed > seq)) throw e; // else flush() took its place
          } finally {
            renaming = null;
          }
        });
        publishing = turn.catch(() => {});
        await turn;
      } catch (e) {
        dirty = true;
        log.error(`[store] save failed: ${e.message}`);
        if (fh) await fh.close().catch(() => {});
        await fs.promises.rm(tmp, { force: true }).catch(() => {});
      }
    })();
    waiting.add(job);
    job.finally(() => waiting.delete(job));
    return job;
  }
  function flushAsync() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    return saveAsync();
  }
  function onTimer() {
    timer = null;
    if (periodic) {
      periodic.then(() => { if (dirty) schedule(); });
      return;
    }
    periodic = saveAsync().finally(() => { periodic = null; });
  }
  function schedule() {
    dirty = true;
    if (!timer) {
      timer = setTimeout(onTimer, delayMs);
      timer.unref?.(); // never what keeps a process alive (the server does that)
    }
  }
  return { schedule, flush, flushAsync, get pending() { return dirty; }, get busy() { return waiting.size > 0; } };
}
