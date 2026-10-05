// Harness for the food form, sheet, host card and drawer (dev only). A static server:
//   /harness/   -> tools/food-harness/
//   /           -> public/ (the app's own CSS, fonts and modules)
// plus a small in-memory food API built on lib/food.js itself (validation, tallies, CSV), seeded
// with sample guests. Same CSP as the app.
//   node tools/food-harness/serve.mjs [--port 8220]   then open /harness/?view=pending|sheet|host|drawer
// POST /harness/api/reset {seed: 'sample'|'empty'|'no-options'} reseeds; POST /harness/api/offline {on}
// makes the food API answer 503 (an offline server).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanFood, cleanSetup, blankSetup, summarize, toCsv, sharedAnswers, resetOrders, readFood, LIMITS } from '../../lib/food.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const MOUNTS = [['/harness/', here], ['/', path.join(root, 'public')]];
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml',
};
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "font-src 'self' data:",
  "img-src 'self' data: blob:", "connect-src 'self'", "object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'",
].join('; ');

const T = Date.now();
const OPTIONS = [
  { id: 'pizza', name: 'Pizza — Franco Manca', note: 'Sourdough; vegan cheese on request', menuUrl: 'https://www.francomanca.co.uk/menu/' },
  { id: 'thai', name: 'Thai — Busaba', note: 'Most dishes can be made vegan', menuUrl: 'https://www.busaba.com/menu' },
  { id: 'sushi', name: 'Sushi — Itsu', note: '', menuUrl: '' },
];
const SAMPLE = [
  ['me', 'Ines Duarte', 'ines', 'pending', null],
  ['ana', 'Ana Ruiz', 'ana', 'approved', { diet: 'vegetarian', allergies: [{ item: 'Peanuts', severity: 'severe', note: 'carries an EpiPen' }, { item: 'Dairy / lactose', severity: 'intolerance', note: 'a little butter is fine' }], avoid: 'mushrooms', love: 'Ethiopian, anything with lime', spice: 'medium', drinks: 'ginger beer', order: { eating: 'yes', hunger: 'very', picks: ['pizza', 'thai'], lines: { pizza: 'large margherita, extra basil', thai: 'pad thai, tofu, medium spicy' }, drinks: 'sparkling water', payment: 'happy to chip in £15' } }],
  ['sam', 'Sam Kirby', 'samk', 'approved', { diet: 'omnivore', allergies: [{ item: 'Shellfish', severity: 'severe', note: 'anaphylaxis' }], spice: 'hot', order: { eating: 'yes', hunger: 'normal', picks: ['thai', 'sushi'], lines: { thai: 'green curry with chicken' }, drinks: 'a Coke Zero' } }],
  ['felix', 'Felix Hartmann', 'felix', 'approved', { diet: 'vegan', allergies: [{ item: 'peanut', severity: 'allergy', note: 'traces are OK' }], love: 'Thai, Sichuan', spice: 'very-hot', order: { eating: 'yes', hunger: 'very', picks: ['thai'], lines: { thai: 'massaman curry, tofu, extra rice' } } }],
  ['chloe', 'Chloé Martin', 'chloe.m', 'approved', { diet: 'pescatarian', allergies: [{ item: 'Gluten / wheat', severity: 'intolerance', note: 'coeliac-ish, no bread please' }], avoid: 'coriander', spice: 'mild', order: { eating: 'snack', hunger: 'light', picks: ['sushi', 'thai'], lines: { sushi: 'salmon avocado roll' } } }],
  ['jonah', 'Jonah Weiss', 'jonah', 'approved', { diet: 'omnivore', spice: 'medium', notes: 'I’ll bring my own dessert.', noAllergies: true, order: { eating: 'yes', hunger: 'normal', picks: ['pizza'], lines: { pizza: 'funghi' }, drinks: 'lemonade' } }],
  ['priya', 'Priya Nair', 'priya', 'approved', { diet: 'vegetarian', allergies: [{ item: 'Sesame', severity: 'allergy', note: '' }], love: 'South Indian, dosa', spice: 'hot', order: { eating: 'yes', hunger: 'normal', picks: ['pizza', 'sushi'], lines: { pizza: 'Neapolitan, no garlic' } } }],
  ['omar', 'Omar Haddad', 'omar', 'approved', { diet: 'omnivore', spice: 'hot', noAllergies: true, order: { eating: 'yes', hunger: 'very', picks: ['thai', 'pizza'], lines: { thai: 'chicken satay and jasmine rice' }, drinks: 'mango juice' } }],
  ['gus', 'Gus Lindqvist', 'gus', 'approved', null],
  ['mei', 'Mei Tanaka', 'mei', 'approved', { diet: 'flexitarian', allergies: [{ item: 'kiwi', severity: 'preference', note: '' }], spice: 'none', drinks: 'oat flat white', order: { eating: 'no' } }],
  ['rhys', 'Rhys Morgan', 'rhys', 'approved', { diet: 'other', dietOther: 'low FODMAP', order: { eating: 'yes', wish: 'whatever’s plainest' } }],
  ['host', 'Robin', 'robin', 'host', { diet: 'omnivore', spice: 'medium', order: { eating: 'yes', hunger: 'normal', picks: ['pizza'], lines: { pizza: 'diavola' } } }],
];

let state;
function seed(kind = 'sample') {
  const options = kind === 'no-options' ? [] : OPTIONS;
  state = {
    setup: kind === 'empty' ? blankSetup() : { options, deadline: '18:30', note: kind === 'no-options' ? '' : 'We’ll order at 18:30 and split the bill. Pay Robin back on the night.' },
    resetAt: null,
    offline: false,
    people: SAMPLE.map(([id, name, username, role, food], i) => {
      const f = kind === 'empty' || !food ? null : cleanFood({ ...food, share: ['ana', 'felix', 'priya', 'omar', 'chloe', 'mei'].includes(id) });
      return { id, name, username, approval: role === 'host' ? 'approved' : role, isHost: role === 'host', food: f, updatedAt: f ? T - (i + 1) * 431_000 : null, leftAt: id === 'mei' ? T - 900_000 : null }; // Mei has left the party (SPEC §33)
    }),
  };
}
seed();

const me = () => state.people.find((p) => p.id === 'me');
const hostData = () => ({ serverNow: Date.now(), limits: LIMITS, resetAt: state.resetAt, historyCount: state.people.reduce((n, x) => n + (x.history?.length || 0), 0), order: state.setup, people: [...state.people].sort((a, b) => a.name.localeCompare(b.name)), summary: summarize(state.people, state.setup) });

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve(null);
      }
    });
  });
}
const send = (res, status, obj) => res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(obj));

async function api(req, res, p, url) {
  if (p === '/harness/api/reset') {
    const b = await readBody(req);
    seed(b?.seed || 'sample');
    return send(res, 200, { ok: true });
  }
  if (p === '/harness/api/offline') {
    const b = await readBody(req);
    state.offline = !!b?.on;
    return send(res, 200, { ok: true });
  }
  if (p === '/harness/api/state') return send(res, 200, { me: me(), setup: state.setup, resetAt: state.resetAt });
  if (p === '/harness/api/me') {
    const b = await readBody(req);
    me().approval = b?.approval === 'approved' ? 'approved' : 'pending';
    return send(res, 200, { ok: true });
  }
  if (p === '/api/food/shared') {
    if (me().approval !== 'approved') return send(res, 404, { error: 'Not found' });
    const users = Object.fromEntries(state.people.map((x) => [x.id, { ...x }]));
    return send(res, 200, { answers: sharedAnswers({ state: { users, party: { foodOrder: state.setup } }, isApproved: (u) => u.approval === 'approved' }) });
  }
  if (state.offline && p.startsWith('/api/')) return send(res, 503, { error: 'offline' });
  if (p === '/api/me/food' && req.method === 'GET') {
    const m = me();
    return send(res, 200, { userId: m.id, food: m.food, updatedAt: m.updatedAt, resetAt: state.resetAt, order: state.setup, limits: LIMITS, serverNow: Date.now(), firstHour: true, sharedOk: m.approval === 'approved' });
  }
  if (p === '/api/me/food' && req.method === 'PUT') {
    if (req.headers['x-wh'] !== '1') return send(res, 403, { error: 'Forbidden', code: 'csrf' });
    const b = await readBody(req);
    if (!b) return send(res, 400, { error: 'Invalid JSON' });
    if (state.resetAt && b.resetAt !== state.resetAt) return send(res, 409, { error: 'reset', code: 'reset', resetAt: state.resetAt, food: me().food, updatedAt: me().updatedAt });
    try {
      const f = cleanFood(b);
      const m = me();
      m.food = f;
      m.updatedAt = f ? Date.now() : null;
      return send(res, 200, { ok: true, food: f, updatedAt: m.updatedAt, resetAt: state.resetAt });
    } catch (e) {
      return send(res, e.status || 500, { error: e.message, code: e.code, field: e.field });
    }
  }
  if (p === '/api/host/food' && req.method === 'GET') {
    const id = url.searchParams.get('id');
    if (id) {
      const person = state.people.find((x) => x.id === id);
      return person ? send(res, 200, { person, order: state.setup }) : send(res, 404, { error: 'No such writer' });
    }
    return send(res, 200, hostData());
  }
  if (p === '/api/host/food.csv') {
    const csv = toCsv([...state.people].sort((a, b) => a.name.localeCompare(b.name)), state.setup, {});
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="writehaven-food-harness.csv"', 'Cache-Control': 'no-store' });
    return res.end(csv);
  }
  if (p === '/api/host/food/options' && req.method === 'PUT') {
    const b = await readBody(req);
    try {
      state.setup = cleanSetup(b || {});
      return send(res, 200, { ok: true, order: state.setup });
    } catch (e) {
      return send(res, e.status || 500, { error: e.message, code: e.code, field: e.field });
    }
  }
  if (p === '/api/host/food/reset' && req.method === 'POST') {
    // The server's own reset: the food order answers only; everyone's answers into the history.
    state.resetAt = Date.now();
    const users = state.people.map((x) => ({ x, food: x.food ? { ...x.food, updatedAt: x.updatedAt } : null, foodHistory: x.history || [] }));
    const cleared = resetOrders(users, state.resetAt, state.setup);
    for (const u of users) {
      const { food, updatedAt } = readFood(u);
      Object.assign(u.x, { food, updatedAt: food ? updatedAt : null, history: u.foodHistory });
    }
    return send(res, 200, { ok: true, cleared, resetAt: state.resetAt });
  }
  if (p === '/api/host/food-history.csv') {
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="writehaven-food-history-harness.csv"', 'Cache-Control': 'no-store' });
    return res.end('harness');
  }
  if (p === '/api/me') return send(res, 200, { me: { id: 'me', name: 'Ines Duarte', username: 'ines', approval: 'pending' } });
  return send(res, 404, { error: 'not in the harness' });
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('Cache-Control', 'no-store');
    if (pathname.startsWith('/api/') || pathname.startsWith('/harness/api/')) return api(req, res, pathname, url);
    const [prefix, base] = MOUNTS.find(([p]) => pathname.startsWith(p));
    let file = path.join(base, pathname.slice(prefix.length));
    if (!file.startsWith(base)) return res.writeHead(403).end('forbidden');
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      return res.end(data);
    });
    return undefined;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--port');
  const port = Number((i > 0 && process.argv[i + 1]) || 8220);
  createServer().listen(port, '127.0.0.1', () => console.log(`food harness on http://127.0.0.1:${port}/harness/ (pid ${process.pid})`));
}
