// The op journal (lib/journal.js): a write that fails part-way is finished on retry, never
// started over, so no line is written twice and the boot never replays a batch twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Journal } from '../lib/journal.js';

const quietLog = { error() {}, log() {}, warn() {} };

// A full disk: write #2 takes only its first `cut` bytes, write #3 fails with ENOSPC, then the
// disk has room again.
async function withShortWrite(cut, fn) {
  const fh = await fs.promises.open(os.devNull, 'r');
  const proto = Object.getPrototypeOf(fh);
  await fh.close();
  const orig = proto.write;
  let call = 0;
  proto.write = async function (buf, off, len, ...rest) {
    if (typeof buf === 'string') return orig.call(this, buf, off, len, ...rest);
    call++;
    if (call === 2) return orig.call(this, buf, off, cut, ...rest);
    if (call === 3) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    return orig.call(this, buf, off, len, ...rest);
  };
  try {
    return await fn();
  } finally {
    proto.write = orig;
  }
}

for (const [name, extra] of [['after a whole line', 0], ['in the middle of a line', 5]]) {
  test(`journal: a write cut short ${name} is finished on retry, no line twice`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-journal-'));
    try {
      const rec = (v, word) => ['post1', 'b', v, [[1000 + v, 0, 0, word]], `seq${v}`];
      const line2 = Buffer.byteLength(`${JSON.stringify(rec(2, 'beta '))}\n`);
      const j = new Journal(dir, { log: quietLog });
      await withShortWrite(line2 + extra, async () => {
        // record 1 goes out alone; records 2 and 3 queue meanwhile and go out together (write #2)
        const ps = [j.append('w1', rec(1, 'alpha ')), j.append('w1', rec(2, 'beta ')), j.append('w1', rec(3, 'gamma '))];
        for (const p of ps) p.catch(() => {});
        await Promise.all(ps.map((p) => p.written));
        await j.drain();
      });
      j.close();
      const recs = new Journal(dir, { log: quietLog }).readAll({ repair: false }).w1;
      assert.deepEqual(recs.map((r) => r[2]), [1, 2, 3]);
      assert.deepEqual(recs.map((r) => r[3][0][3]), ['alpha ', 'beta ', 'gamma ']);
      assert.ok(fs.readFileSync(path.join(dir, 'w1.jsonl'), 'utf8').endsWith('\n'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
