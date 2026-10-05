// The live cards, post pages and the host's drawer render writing with md-render.js. A block
// that takes no line would loop forever and freeze the page, so each render runs in a worker
// with a time limit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

function render(text, opts = {}, ms = 3000) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./md-render-worker.js', import.meta.url), { workerData: { text, opts } });
    const timer = setTimeout(() => { w.terminate(); reject(new Error(`renderBlocks did not return within ${ms} ms`)); }, ms);
    w.once('message', (m) => { clearTimeout(timer); w.terminate(); resolve(m); });
    w.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

test('a note nobody refers to is plain text and never stalls the renderer (live cards and pages)', async () => {
  const text = 'A sentence with a note.[^1]\n\n[^1]: The note.\n  [^2]: A note nobody refers to.';
  for (const noteDefs of ['inline', 'list']) {
    const blocks = await render(text, { noteDefs, spoilers: 'hide', links: false });
    assert.ok(blocks.some((b) => b.text.includes('A note nobody refers to.')), `${noteDefs}: the unreferenced note shows as text`);
    assert.ok(blocks.every((b) => b.text.trim()), `${noteDefs}: no empty blocks`);
  }
});

test('a note with no reference at all (no listed notes) renders as text', async () => {
  const blocks = await render('Hello there.\n[^1]: a note written before its reference');
  assert.deepEqual(blocks.map((b) => b.text), ['Hello there.', '[^1]: a note written before its reference']);
});
