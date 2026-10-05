// Password hashing (scrypt) runs in libuv's thread pool, which the state file and the op journal
// use too: a burst of sign-ins or guesses must never starve them. The gate runs at most `running`
// hashes at once and queues at most `queued` more; one address may have at most `perIp` of them
// running or queued (`perHostIp` from a network a host is signed in from: the venue's Wi-Fi). Past
// that, a request is refused at once with 503 { code: 'busy', retryAfter } (server.js sends the
// Retry-After header), before any work is done.

import { HttpError } from './party.js';

export function createHashGate({ running = 2, queued = 48, perIp = 12, perHostIp = 40, retryAfter = 2 } = {}) {
  let active = 0;
  const waiting = [];
  const byIp = new Map(); // address -> hashes running or queued
  const pump = () => {
    while (active < running && waiting.length) {
      active++;
      waiting.shift()();
    }
  };
  return {
    // fn: () => Promise (the hash or the check). host: the address is a host's network.
    run(ip, fn, { host = false } = {}) {
      const n = byIp.get(ip) || 0;
      if (waiting.length >= queued || n >= (host ? perHostIp : perIp)) {
        return Promise.reject(new HttpError(503, 'Lots of people are signing in right now. Try again in a moment.', { code: 'busy', retryAfter }));
      }
      byIp.set(ip, n + 1);
      return new Promise((resolve, reject) => {
        waiting.push(() => {
          Promise.resolve().then(fn).then(resolve, reject).finally(() => {
            active--;
            const m = (byIp.get(ip) || 1) - 1;
            if (m > 0) byIp.set(ip, m);
            else byIp.delete(ip);
            pump();
          });
        });
        pump();
      });
    },
    get stats() {
      return { running: active, queued: waiting.length, addresses: byIp.size };
    },
  };
}
