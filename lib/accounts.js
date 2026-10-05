// Account details (SPEC §25). Everyone edits their own display name, username and password
// ("Your account": writers, people waiting for approval, hosts); hosts edit other people's from
// the dashboard. Co-hosts edit writers; only an original host edits other hosts. Registered
// through the route hook (attachAccounts(app)) like lib/notify.js: every handler does its own
// sign-in, CSRF (JSON + X-WH) and rate checks.
//
//   GET  /api/me/account                  → { user, publicName, nameHasEmail, usernameLocked, publicProfile, customCss }
//   POST /api/me/account { name?, email?, username?, password?, currentPassword?, publicProfile?, customCss? }
//                                         → { ok, user, publicName, changed: [...], publicProfile, customCss }
// customCss (SPEC §32): the person's own CSS for their own screens, at most 20 KB, stored as given;
// only they can set it, and only they ever get it back (here and in their own /api/session).
// publicProfile (SPEC §28): { on, id } on the public list of writers, the person's own choice
// (a boolean in the POST; a host sending it for someone else gets 403 self_only).
//   GET  /api/host/account?id=<id>        → { user, self, canEdit, canEditUsername, reason, code,
//                                             publicName, nameHasEmail }
//   POST /api/host/account { id, name?, email?, username?, password? } → as POST /api/me/account
// `user` carries the email (SPEC §25b): only the person themself and hosts ever get it.
//   (/api/admin/account is the same as /api/host/account.)
//
// Changes are kept like every other account change: on the user record in the state file
// (saved before the answer), with a host log line. A new display name shows at once on the
// posts the writer signed (the live page, post pages, the anthology, exports) and nowhere else:
// anonymous and separate posts never carry a name. Sessions stay valid across a username change.
// A password change by the person themself signs out their other devices and keeps this one;
// one set by a host signs them out everywhere (as the host's password reset always has).

import { HttpError, cleanLine, validatePassword } from './party.js';
import { hashPassword, verifyPassword } from './auth.js';
import { NAME_MAX, USERNAME_RE, displayNameError, publicDisplayName, hasEmail, cleanEmail, emailProblem } from '../public/js/names.js';

const BODY_LIMIT = 64 * 1024; // room for 20 KB of custom CSS, escaped
export const CSS_MAX_BYTES = 20 * 1024;
const WINDOW_MS = 10 * 60_000;
const SELF_EDITS = 30; // changes (and attempts) per account per 10 minutes
const HOST_EDITS = 200; // per host per 10 minutes
const PASSWORD_TRIES = 5; // wrong current passwords per account per 10 minutes

const isPlainObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// Sliding-window counter: wait(key) → seconds until another event is allowed (0 = now).
class Window {
  constructor(max, ms, now) {
    Object.assign(this, { max, ms, now, hits: new Map() });
  }
  recent(key) {
    const t = this.now();
    const list = (this.hits.get(key) || []).filter((x) => t - x < this.ms);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }
  wait(key) {
    const list = this.recent(key);
    return list.length >= this.max ? Math.max(1, Math.ceil((list[list.length - this.max] + this.ms - this.now()) / 1000)) : 0;
  }
  hit(key) {
    const t = this.now();
    this.hits.set(key, [...this.recent(key), t]);
    return t;
  }
  undo(key, t) {
    const list = this.recent(key);
    const i = list.indexOf(t);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) this.hits.delete(key);
  }
}

function readJson(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] || 0) > limit) {
      req.resume();
      reject(new HttpError(413, 'Request body too large'));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on('end', () => {
      if (size > limit) return reject(new HttpError(413, 'Request body too large'));
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        const v = JSON.parse(text);
        return isPlainObject(v) ? resolve(v) : reject(new HttpError(400, 'Body must be a JSON object'));
      } catch {
        return reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}
const wantsJson = (req) => String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() === 'application/json' && req.headers['x-wh'] === '1';

// ------------------------------------------------------------------ who may edit whom
// Hosts named in WH_ADMIN_USERS: their username is the configuration, so it can't change (a
// freed configured name could be claimed by someone else), and no one can take one.
export const configuredName = (party, username) => !!party.adminUsers?.has(String(username || '').toLowerCase());

// The original host(s): the account that set the party up (flagged `originalHost` at sign-up;
// for a party from before the flag, the first account, if it's still a host), and hosts named
// in WH_ADMIN_USERS. Everyone else with host powers is a co-host (SPEC §21).
export function isOriginalHost(party, u) {
  if (!u || !u.isAdmin) return false;
  if (configuredName(party, u.username)) return true;
  const users = Object.values(party.state.users);
  if (users.some((x) => x.originalHost)) return !!u.originalHost;
  let first = null;
  for (const x of users) if (!first || (x.createdAt ?? Infinity) < (first.createdAt ?? Infinity)) first = x;
  return !!first && first.id === u.id;
}
export function originalHosts(party) {
  return Object.values(party.state.users).filter((u) => isOriginalHost(party, u));
}

// What `actor` may do to `target`'s account: { canEdit, canEditUsername, self, code, reason }.
export function editRights(party, actor, target) {
  if (!actor || !target) return { canEdit: false, canEditUsername: false, self: false, code: 'not_found', reason: 'No such account.' };
  const canEditUsername = !configuredName(party, target.username);
  if (actor.id === target.id) return { canEdit: true, canEditUsername, self: true, code: null, reason: null };
  if (!actor.isAdmin) return { canEdit: false, canEditUsername: false, self: false, code: 'forbidden', reason: 'Only hosts can change other people’s details.' };
  if (target.isAdmin && !isOriginalHost(party, actor)) {
    const names = originalHosts(party).map((u) => u.name);
    const who = names.length ? `the original host (${names.join(', ')})` : 'the original host';
    return { canEdit: false, canEditUsername: false, self: false, code: 'host_only', reason: `${target.name} is a host. Only ${who} can change another host’s details.` };
  }
  return { canEdit: true, canEditUsername, self: false, code: null, reason: null };
}

const accountView = (party, u) => ({ id: u.id, name: u.name, email: u.email ?? null, username: u.username, isAdmin: !!u.isAdmin, approval: party.approvalOf(u) });
// SPEC §28, for the person themself only: on the public list of writers or not, and their page
// id while on it.
const publicProfileView = (u) => ({ on: u.publicProfile?.on === true, id: u.publicProfile?.on === true ? u.publicProfile.id : null });

// ------------------------------------------------------------------ the change itself
// Validate a change (synchronously; called again after the password work, so nothing that
// happened meanwhile, e.g. someone taking the username, can slip through).
function planChange(party, target, body, { self }) {
  const patch = {};
  if (body.name !== undefined && body.name !== null) {
    if (typeof body.name !== 'string') throw new HttpError(400, 'The display name must be text', { code: 'name', field: 'name' });
    const n = cleanLine(body.name, NAME_MAX);
    const err = displayNameError(n, { who: self ? 'you' : 'they' });
    if (err) throw new HttpError(400, err, { code: n ? 'name_email' : 'name_empty', field: 'name' });
    if (n !== target.name) patch.name = n;
  }
  if (body.username !== undefined && body.username !== null) {
    if (typeof body.username !== 'string') throw new HttpError(400, 'The username must be text', { code: 'username', field: 'username' });
    const un = body.username.trim().toLowerCase();
    if (!USERNAME_RE.test(un)) throw new HttpError(400, 'Username: 2–24 characters, letters, digits, _ . or -', { code: 'username', field: 'username' });
    if (un !== target.username) {
      if (configuredName(party, target.username)) {
        throw new HttpError(409, 'This username is set in the server’s configuration, so it can’t change.', { code: 'username_locked', field: 'username' });
      }
      if (configuredName(party, un)) throw new HttpError(409, 'That username is reserved', { code: 'username_reserved', field: 'username' });
      const other = party.byUsername.get(un);
      if (other && other !== target) throw new HttpError(409, 'That username is taken', { code: 'username_taken', field: 'username' });
      patch.username = un;
    }
  }
  if (body.email !== undefined && body.email !== null) {
    if (typeof body.email !== 'string') throw new HttpError(400, 'The email must be text', { code: 'email', field: 'email' });
    const em = cleanEmail(body.email);
    // An address can be corrected, never removed (the sign-up form requires one).
    if (!em && target.email) throw new HttpError(400, self ? 'Add your email address. Only the hosts see it.' : 'Add an email address.', { code: 'email', field: 'email' });
    const err = em ? emailProblem(em) : '';
    if (err) throw new HttpError(400, err, { code: 'email', field: 'email' });
    if (em && em !== target.email) patch.email = em;
  }
  if (body.publicProfile !== undefined && body.publicProfile !== null) {
    // SPEC §28: being on the public list of writers is the person's own choice. A host can't
    // put anyone on it, or take them off: only from their own Your account.
    if (!self) throw new HttpError(403, 'Only the writer can choose to be on the public list of writers.', { code: 'self_only', field: 'publicProfile' });
    if (typeof body.publicProfile !== 'boolean') throw new HttpError(400, 'publicProfile must be true or false', { code: 'publicProfile', field: 'publicProfile' });
    if (body.publicProfile !== (target.publicProfile?.on === true)) patch.publicProfile = body.publicProfile;
  }
  if (body.customCss !== undefined && body.customCss !== null) {
    // SPEC §32: custom CSS is the person's own; a host can't set anyone's, nor see it.
    if (!self) throw new HttpError(403, 'Only the person themself can set their custom CSS.', { code: 'self_only', field: 'customCss' });
    if (typeof body.customCss !== 'string') throw new HttpError(400, 'Custom CSS must be text', { code: 'customCss', field: 'customCss' });
    const bytes = Buffer.byteLength(body.customCss, 'utf8');
    if (bytes > CSS_MAX_BYTES) throw new HttpError(400, `Custom CSS can be at most 20 KB (this is ${(bytes / 1024).toFixed(1)} KB).`, { code: 'css_too_big', field: 'customCss' });
    if (body.customCss !== (target.customCss || '')) patch.customCss = body.customCss; // '' turns it off
  }
  if (body.password !== undefined && body.password !== null && body.password !== '') {
    try {
      validatePassword(body.password);
    } catch (e) {
      throw new HttpError(e.status || 400, e.message, { code: 'password', field: 'password' });
    }
    patch.password = body.password;
  }
  return patch;
}

const listText = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

// gate: server.js's hash gate (lib/hashgate.js), so these checks share its bounds with sign-ins.
export function createAccounts({ app, party = app?.party, hash = hashPassword, verify = verifyPassword, flush = () => app?.saver?.flushAsync?.(), meTick = () => app?.meTick?.(), onSignedOut = null, gate = app?.hashGate } = {}) {
  if (!party) throw new Error('createAccounts: party is required');
  const now = () => party.now();
  const selfEdits = new Window(SELF_EDITS, WINDOW_MS, now);
  const hostEdits = new Window(HOST_EDITS, WINDOW_MS, now);
  const wrongPasswords = new Window(PASSWORD_TRIES, WINDOW_MS, now);

  const rate = (wait, msg) => new HttpError(429, msg.replace('{s}', String(wait)), { code: 'rate', retryAfter: wait });

  // actor changes target's details. `token`: the actor's session (kept on a self password change).
  async function change(actor, target, body, { token = null, ip = '?' } = {}) {
    const gated = (fn) => (gate ? gate.run(ip, fn, { host: !!actor.isAdmin }) : fn());
    const rights = editRights(party, actor, target);
    if (!rights.canEdit) throw new HttpError(rights.code === 'not_found' ? 404 : 403, rights.reason, { code: rights.code });
    const self = rights.self;
    const limiter = self ? selfEdits : hostEdits;
    const wait = limiter.wait(actor.id);
    if (wait) throw rate(wait, 'Too many changes in a row. Try again in {s} s.');
    limiter.hit(actor.id);
    let patch = planChange(party, target, body, { self });
    let passHash = null;
    if (patch.password !== undefined) {
      if (self) {
        // A new password needs the current one. The try is counted before the (slow) check, so
        // parallel guesses can't get past the limit.
        const w = wrongPasswords.wait(target.id);
        if (w) throw rate(w, 'Too many wrong passwords. Try again in {s} s.');
        if (typeof body.currentPassword !== 'string' || !body.currentPassword) {
          throw new HttpError(400, 'Enter your current password to set a new one.', { code: 'current_password', field: 'currentPassword' });
        }
        const t = wrongPasswords.hit(target.id);
        let right;
        try {
          right = await gated(() => verify(body.currentPassword.slice(0, 200), target.passHash));
        } catch (e) {
          wrongPasswords.undo(target.id, t); // busy, not wrong
          throw e;
        }
        if (!right) {
          throw new HttpError(403, 'That isn’t your current password.', { code: 'wrong_password', field: 'currentPassword' });
        }
        wrongPasswords.undo(target.id, t);
      }
      passHash = await gated(() => hash(patch.password));
    }
    // The account may have changed while the password was being checked: decide again.
    if (!party.userById(target.id)) throw new HttpError(404, 'No such account', { code: 'not_found' });
    const again = editRights(party, actor, target);
    if (!again.canEdit) throw new HttpError(403, again.reason, { code: again.code });
    patch = { ...planChange(party, target, { ...body, password: undefined }, { self }), ...(passHash ? { password: true } : {}) };

    const before = { name: target.name, username: target.username, email: target.email ?? null };
    const changed = [];
    if (patch.username) {
      if (party.byUsername.get(target.username) === target) party.byUsername.delete(target.username);
      target.username = patch.username;
      party.byUsername.set(target.username, target);
      changed.push('username');
    }
    if (patch.name) {
      target.name = patch.name;
      party.publicRev++; // signed posts show the new name: live, post pages and anthology caches
      changed.push('name');
    }
    if (patch.email) {
      target.email = patch.email; // private: no public page changes
      changed.push('email');
    }
    if (patch.publicProfile !== undefined) {
      party.setPublicProfile(target.id, patch.publicProfile); // logged on its own; the list updates at once
      changed.push('publicProfile');
    }
    if (patch.customCss !== undefined) {
      if (patch.customCss) target.customCss = patch.customCss; // as given: applied as a style element's text, never parsed as HTML
      else delete target.customCss;
      changed.push('customCss'); // not logged: it's nobody else's business
    }
    let signedOut = 0;
    if (passHash) {
      const mine = Object.keys(party.state.sessions).filter((t) => party.state.sessions[t].userId === target.id);
      const keep = self && token && party.state.sessions[token]?.userId === target.id ? party.state.sessions[token] : null;
      party.setPasswordHash(target.id, passHash); // signs the account out everywhere...
      if (keep) party.state.sessions[token] = keep; // ...except, for your own change, here
      signedOut = mine.filter((t) => t !== token || !keep).length;
      changed.push('password');
    }
    if (changed.length) {
      const items = [];
      if (patch.name) items.push(`display name (was “${before.name}”)`);
      if (patch.email) items.push(before.email ? 'email' : 'email (added)');
      if (patch.username) items.push(`username (was @${before.username})`);
      if (passHash) items.push('password');
      const onlyAdded = items.length === 1 && items[0] === 'email (added)';
      if (items.length) party.addLog('account', self
        ? { userId: target.id, text: onlyAdded ? 'added their email' : `changed their ${listText(items)}` }
        : { userId: target.id, by: actor.id, text: onlyAdded ? 'had an email added' : `had their ${listText(items)} changed` });
      party.touch();
      // On disk before the answer, like every other account change (server.js).
      await flush();
      meTick(); // their own pages (writer, waiting screen) update now; signed-out streams close
      if (passHash) onSignedOut?.(target.id);
    }
    return { user: accountView(party, target), publicName: publicDisplayName(target.name), changed, signedOut, ...(self ? { publicProfile: publicProfileView(target), customCss: target.customCss || '' } : {}) };
  }

  // ---------------------------------------------------------------- routes
  const isHostPath = (p) => p === '/api/host/account' || p === '/api/admin/account';
  async function guard(req, h, { host = false } = {}) {
    const u = h.ctx.user;
    if (!u) throw new HttpError(401, 'Please sign in first');
    if (host && !u.isAdmin) throw new HttpError(404, 'Not found');
    if (req.method !== 'GET') {
      if (!wantsJson(req)) {
        req.resume();
        throw new HttpError(403, 'Forbidden: JSON with the X-WH header required', { code: 'csrf' });
      }
      return { u, body: await readJson(req) };
    }
    return { u, body: null };
  }
  const routes = [
    {
      method: 'GET',
      match: (p) => (p === '/api/me/account' ? {} : null),
      handle: async (req, res, h) => {
        const { u } = await guard(req, h);
        h.sendJson(200, { user: accountView(party, u), publicName: publicDisplayName(u.name), nameHasEmail: hasEmail(u.name), usernameLocked: configuredName(party, u.username), publicProfile: publicProfileView(u), customCss: u.customCss || '' });
      },
    },
    {
      method: 'POST',
      match: (p) => (p === '/api/me/account' ? {} : null),
      handle: async (req, res, h) => {
        const { u, body } = await guard(req, h);
        const out = await change(u, u, body, { token: h.ctx.token, ip: h.clientIp });
        h.sendJson(200, { ok: true, ...out });
      },
    },
    {
      method: 'GET',
      match: (p) => (isHostPath(p) ? {} : null),
      handle: async (req, res, h) => {
        const { u } = await guard(req, h, { host: true });
        const t = party.userById(h.url.searchParams.get('id'));
        if (!t) throw new HttpError(404, 'No such writer', { code: 'not_found' });
        const r = editRights(party, u, t);
        h.sendJson(200, { user: accountView(party, t), ...r, publicName: publicDisplayName(t.name), nameHasEmail: hasEmail(t.name) });
      },
    },
    {
      method: 'POST',
      match: (p) => (isHostPath(p) ? {} : null),
      handle: async (req, res, h) => {
        const { u, body } = await guard(req, h, { host: true });
        const t = party.userById(typeof body.id === 'string' ? body.id : null);
        if (!t) throw new HttpError(404, 'No such writer', { code: 'not_found' });
        const out = await change(u, t, body, { token: h.ctx.token, ip: h.clientIp });
        h.sendJson(200, { ok: true, ...out });
      },
    },
  ];
  return { routes, change, editRights: (a, t) => editRights(party, a, t) };
}

// Wire it into a server.js app (server.js main(); tests call it on their app).
export function attachAccounts(app, opts = {}) {
  const a = createAccounts({ app, onSignedOut: (uid) => app.closeStreamsOf?.(uid), ...opts });
  app.extraRoutes.push(...a.routes);
  app.accounts = a;
  return a;
}
