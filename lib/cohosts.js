// Co-hosts (SPEC §21): any host can make another account a host or take it back.
//   - Co-hosts have every host power and are approved (and stay approved if later removed).
//   - The last host can't be removed, by anyone (themself included).
//   - Hosts named in WH_ADMIN_USERS are hosts again at every sign-in, so they can't be removed
//     from the dashboard either (409 env_host).
// Every change is logged; lib/notify.js sends the new host a one-time "You're now a host" notice.

import { HttpError } from './party.js';

export const hostCount = (party) => Object.values(party.state.users).filter((u) => u.isAdmin).length;

// body: { id, isAdmin: boolean } -> { user, changed, isAdmin, hosts }
export function setHost(party, adminId, body) {
  const a = party.requireAdmin(adminId);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Bad request');
  if (typeof body.isAdmin !== 'boolean') throw new HttpError(400, 'isAdmin must be true or false');
  const u = party.userById(typeof body.id === 'string' ? body.id : null);
  if (!u) throw new HttpError(404, 'No such writer');
  const changed = !!u.isAdmin !== body.isAdmin;
  if (changed && body.isAdmin) {
    u.isAdmin = true;
    // Hosts are always approved; recorded on the account so it stays approved if removed later.
    u.approval = 'approved';
    u.approvalNote = null;
    for (const al of party.state.alerts) if (al.userId === u.id && al.kind === 'approval' && !al.ack) Object.assign(al, { ack: true, ackBy: a.id });
    party.addLog('cohost', { userId: u.id, by: a.id, text: 'made a co-host' });
  } else if (changed) {
    if (hostCount(party) <= 1) {
      throw new HttpError(409, u.id === a.id ? 'You’re the only host. Make someone else a host first.' : 'The last host can’t be removed.', { code: 'last_host' });
    }
    if (party.adminUsers && party.adminUsers.has(u.username)) {
      throw new HttpError(409, 'This host is set in the server’s configuration, so they stay a host.', { code: 'env_host' });
    }
    u.isAdmin = false;
    u.approval = 'approved';
    party.addLog('cohost-remove', { userId: u.id, by: a.id, text: u.id === a.id ? 'stepped down as a host' : 'removed as a co-host' });
  }
  if (changed) {
    // Approval and host status decide who is public and counted.
    party.publicRev++;
    party.cache?.delete(u.id);
    party.totalsCache = null;
    party.touch();
  }
  return { user: u, changed, isAdmin: !!u.isAdmin, hosts: hostCount(party) };
}
