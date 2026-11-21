// A planned start: the host sets a time in the lobby and the party starts by itself then.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeParty, addUser, startApp, client, sleep } from './helpers.js';
import { MIN } from './sim.js';
import { HttpError } from '../lib/party.js';

const HOUR = 60 * MIN;

test('the party starts by itself at its planned time', () => {
  const { party, clock } = makeParty();
  const host = addUser(party, 'host');
  const ana = addUser(party, 'ana');
  const at = clock.now() + 13 * HOUR;
  // Only a host, only in the future (within a week), and empty clears it.
  assert.throws(() => party.setPlannedStart(ana.id, at), (e) => e instanceof HttpError && e.status === 404);
  assert.throws(() => party.setPlannedStart(host.id, clock.now() - MIN), /next 7 days/);
  assert.throws(() => party.setPlannedStart(host.id, clock.now() + 8 * 24 * HOUR), /next 7 days/);
  assert.throws(() => party.setPlannedStart(host.id, 'noon'), /next 7 days/);
  party.setPlannedStart(host.id, at);
  assert.equal(party.state.party.plannedStart, at);
  // Everyone sees it while the party waits: writers, the host, the live page.
  assert.equal(party.partyInfo().plannedStart, at);
  assert.equal(party.partyMeta().plannedStart, at);
  assert.equal(party.liveView().party.plannedStart, at);
  assert.equal(party.meView(ana.id).party.plannedStart, at);
  assert.ok(party.state.log.some((l) => l.type === 'planned-start' && l.by === host.id));

  // Not yet: still in the lobby.
  clock.set(at - 1000);
  party.tick();
  assert.equal(party.phase, 'lobby');
  // On time: running from now, the plan done.
  clock.set(at + 500);
  party.tick();
  assert.equal(party.phase, 'running');
  assert.equal(party.state.party.startedAt, at + 500);
  assert.equal(party.state.party.plannedStart, null);
  assert.equal(party.partyInfo().plannedStart, null);
  const log = party.state.log.find((l) => l.type === 'start');
  assert.equal(log.by, null);
  assert.match(log.text, /planned time/);
  // Writers can open the editor now, as after a host's start.
  party.join(ana.id);
  assert.ok(ana.joinedAt);
  // Too late to change it.
  assert.throws(() => party.setPlannedStart(host.id, null), (e) => e.status === 409);
});

test('a host can still start sooner, or clear the plan; a server down at the time starts it late', () => {
  const { party, clock } = makeParty();
  const host = addUser(party, 'host');
  party.setPlannedStart(host.id, clock.now() + HOUR);
  party.setPlannedStart(host.id, null);
  clock.advance(2 * HOUR);
  party.tick();
  assert.equal(party.phase, 'lobby', 'cleared: no start');

  party.setPlannedStart(host.id, clock.now() + HOUR);
  party.start(host.id);
  assert.equal(party.phase, 'running');
  assert.equal(party.state.party.plannedStart, null);

  const late = makeParty();
  const h2 = addUser(late.party, 'host');
  late.party.setPlannedStart(h2.id, late.clock.now() + HOUR);
  late.clock.advance(3 * HOUR); // no tick at the time (the server was down)
  late.party.tick();
  assert.equal(late.party.phase, 'running');
});

test('http: setting the start time, and the server starting the party', async (t) => {
  const { base, close, app } = await startApp();
  t.after(close);
  const host = client(base);
  await host.post('/api/register', { username: 'host', password: 'longpassword', name: 'Host' });
  const w = client(base);
  await w.post('/api/register', { username: 'ana', password: 'longpassword', name: 'Ana' });
  let r = await w.post('/api/host/party', { plannedStart: Date.now() + 1000 });
  assert.equal(r.status, 404);
  r = await host.post('/api/host/party', { plannedStart: Date.now() - 1000 });
  assert.equal(r.status, 400);
  const at = Date.now() + 600;
  r = await host.post('/api/host/party', { plannedStart: at });
  assert.equal(r.status, 200);
  assert.equal(r.json.party.plannedStart, at);
  assert.equal((await client(base).get('/api/session')).json.party.plannedStart, at);
  assert.equal((await w.get('/api/me')).json.party.plannedStart, at);
  // The server's tick (every 200 ms in tests) starts it.
  for (let i = 0; i < 40 && app.party.phase === 'lobby'; i++) await sleep(100);
  assert.equal(app.party.phase, 'running');
  r = await w.post('/api/join', {});
  assert.equal(r.status, 200);
  assert.ok(r.json.joinedAt);
});
