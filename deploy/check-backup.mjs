#!/usr/bin/env node
// Check that a backup would come back: load it the way the server starts (state file, op journal,
// earlier rounds) and say what's in it, without serving it or sending anything (no port, no
// timers, no Web Push). Exits 1 if anything didn't load cleanly.
//
//   sudo node deploy/check-backup.mjs /var/backups/writehaven/auto-20261122T142024Z.tar.gz
//   node deploy/check-backup.mjs path/to/data          (an unpacked data directory)
//
// It always works on a temporary copy (a .tar.gz unpacked, a directory copied), deleted after:
// loading tidies what it loads (a torn last line of the journal is cut, leftover temporary files
// go, as at a real start), so the backup, or a directory given (even a live one), is never touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node deploy/check-backup.mjs <backup.tar.gz | data directory>');
  process.exit(2);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-check-'));
fs.chmodSync(tmp, 0o700);
const dataDir = path.join(tmp, 'data');
if (/\.(tar\.gz|tgz)$/.test(arg)) execFileSync('tar', ['-xzf', path.resolve(arg), '-C', tmp]);
else fs.cpSync(path.resolve(arg), dataDir, { recursive: true, filter: (f) => !/\.tmp-/.test(path.basename(f)) });
let code = 0;
try {
  const stateFile = path.join(dataDir, 'state.json');
  if (!fs.existsSync(stateFile)) throw new Error(`no state.json in ${dataDir}`);
  const problems = [];
  const log = { log() {}, warn: (...a) => problems.push(a.join(' ')), error: (...a) => problems.push(a.join(' ')) };
  const t0 = Date.now();
  const { createApp } = await import(path.join(root, 'server.js'));
  const app = createApp({ stateFile, log }); // never started: no port, no timers
  const p = app.party;
  const st = p.state;
  const users = Object.values(st.users);
  const stamp = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—');
  const journal = path.join(dataDir, 'state.json.ops');
  const uploads = path.join(dataDir, 'uploads');
  const lines = [
    `party        ${st.party.name} · round ${p.round} · ${p.phase}`,
    `started      ${stamp(st.party.startedAt)} · ended ${stamp(st.party.endedAt)}`,
    `saved        ${stamp(st.savedAt)}`,
    `accounts     ${users.length} (${users.filter((u) => u.isAdmin).length} hosts) · ${p.writers().length} writing this round`,
    `posts        ${Object.keys(st.posts).length} this round · ${p.pastRounds.length} earlier round(s) with ${p.pastRounds.reduce((n, r) => n + r.posts.length, 0)} posts`,
    `edits        ${Object.values(st.ops).reduce((n, x) => n + x.length, 0)} in ${fs.existsSync(journal) ? fs.readdirSync(journal).length : 0} journal file(s)`,
    `uploads      ${fs.existsSync(uploads) ? fs.readdirSync(uploads).filter((f) => /^[0-9a-f]{32}\./.test(f)).length : 0} image(s)`,
    `push keys    ${fs.existsSync(path.join(dataDir, 'vapid.json')) ? 'present (vapid.json)' : 'missing: notifications need everyone to subscribe again'}`,
    `loaded in    ${Date.now() - t0} ms`,
  ];
  console.log(lines.join('\n'));
  if (problems.length) {
    code = 1;
    console.log(`\nProblems while loading:\n${problems.map((x) => `  ${x}`).join('\n')}`);
  } else console.log('\nLoads cleanly.');
} catch (e) {
  code = 1;
  console.error(`Couldn't load it: ${e.message}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(code);
