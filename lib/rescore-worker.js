// Worker thread for the host's settings preview: reads the op journal itself (so the main
// thread never copies the op log) and computes what the change would do (lib/preview.js).
import { parentPort, workerData } from 'node:worker_threads';
import { Journal } from './journal.js';
import { opsFromJournalRecs, computePreview } from './preview.js';

const job = workerData;
try {
  const t0 = performance.now();
  let opsByUser = job.opsByUser || null;
  if (!opsByUser) {
    // Read only: never repair a journal the server is appending to.
    const recs = new Journal(job.journalDir, { log: { error() {} } }).readAll({ repair: false });
    opsByUser = {};
    for (const [uid, r] of Object.entries(recs)) opsByUser[uid] = opsFromJournalRecs(r);
  }
  const changes = computePreview({ ...job, opsByUser });
  parentPort.postMessage({ ok: true, changes, ms: Math.round(performance.now() - t0) });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String((e && e.message) || e) });
}
