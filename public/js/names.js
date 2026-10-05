// Display names and usernames (SPEC §25): the rules shared by the sign-up form, the account
// dialog (account.js) and the server (lib/party.js, lib/accounts.js). Pure: no DOM, no Node.

export const NAME_MAX = 40; // characters, after the server's clean-up (lib/party.js cleanLine)
export const USERNAME_RE = /^[a-z0-9_.-]{2,24}$/; // the server's rule (lib/party.js)

// An email address anywhere in a string: local@domain.tld. Matched on NFKC-folded text, so
// look-alikes such as the full-width ＠ and ．count too.
const EMAIL = /[\p{L}\p{N}\p{M}!#$%&'*+\/=?^_`{|}~.-]+@(?:[\p{L}\p{N}\p{M}-]+\.)+(?:xn--[a-z0-9-]{2,}|[\p{L}\p{M}]{2,})(?![\p{L}\p{N}\p{M}-])/giu;
const fold = (s) => String(s ?? '').slice(0, 500).normalize('NFKC');

export function hasEmail(s) {
  EMAIL.lastIndex = 0;
  return EMAIL.test(fold(s));
}

// A name to suggest instead: the words around the address, else the address's local part
// ("ruth.smith@…" → "Ruth Smith"). '' when nothing sensible is left.
function suggestion(s) {
  const t = fold(s);
  const rest = t.replace(EMAIL, ' ').replace(/\bmailto:?/gi, ' ').replace(/[()<>[\]{},;:|"]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\p{L}/u.test(rest)) return [...rest].slice(0, NAME_MAX).join('');
  EMAIL.lastIndex = 0;
  const m = EMAIL.exec(t);
  if (!m) return '';
  const words = m[0].slice(0, m[0].indexOf('@')).replace(/\+.*$/, '').split(/[._-]+/)
    .map((w) => w.replace(/[^\p{L}]/gu, '')).filter((w) => w.length >= 2).slice(0, 3);
  return words.map((w) => w[0].toLocaleUpperCase() + w.slice(1)).join(' ').slice(0, NAME_MAX);
}

// Why a display name can't be used, or '' if it can. `who`: 'you' (the person themself) or
// 'they' (a host editing someone else). Length and trimming are the server's (cleanLine).
export function displayNameError(name, { who = 'you' } = {}) {
  const s = String(name ?? '').trim();
  if (!s) return who === 'you' ? 'Add a display name. It’s shown on the posts you choose to sign, and on the writers list if you join it.' : 'Add a display name.';
  if (!hasEmail(s)) return '';
  const sug = suggestion(s);
  const posts = who === 'you' ? 'the posts you sign' : 'the posts they sign';
  return `That looks like an email address. Display names are shown on ${posts}, so use a name instead${sug ? `, like “${sug}”` : ''}.`;
}

// How a stored name appears on public pages: any email address in it shows only the part
// before "@" (accounts named before emails were refused). Names without one are unchanged.
export function publicDisplayName(name) {
  if (typeof name !== 'string' || !name) return null;
  if (!hasEmail(name)) return name;
  const out = fold(name).replace(EMAIL, (m) => m.slice(0, m.indexOf('@'))).replace(/\s+/g, ' ').trim();
  return out || null;
}

// ---------------------------------------------------------------- email (SPEC §25b)
// Private: hosts see it, nothing public ever does. One address, kept as typed but folded (NFKC:
// a full-width ＠ is an @) and trimmed, with the domain lowercased.
export const EMAIL_MAX = 254;
const ATOM = "[\\p{L}\\p{N}\\p{M}!#$%&'*+/=?^_`{|}~-]+";
const LABEL = '[\\p{L}\\p{N}\\p{M}](?:[\\p{L}\\p{N}\\p{M}-]{0,61}[\\p{L}\\p{N}\\p{M}])?';
const EMAIL_FULL = new RegExp(`^${ATOM}(?:\\.${ATOM})*@(?:${LABEL}\\.)+(?:xn--[a-z0-9-]{2,}|[\\p{L}\\p{M}]{2,})$`, 'u');

export function cleanEmail(raw) {
  const s = String(raw ?? '').slice(0, 1000).normalize('NFKC').trim();
  const at = s.lastIndexOf('@');
  return at < 0 ? s : `${s.slice(0, at)}@${s.slice(at + 1).toLowerCase()}`;
}

// Why an email address can't be used, or ''. An empty one is a problem only when `required`.
export function emailProblem(raw, { required = true } = {}) {
  const s = cleanEmail(raw);
  if (!s) return required ? 'Add your email address.' : '';
  if (/\s/.test(s)) return 'An email address can’t contain spaces.';
  const ats = (s.match(/@/g) || []).length;
  if (!ats) return 'That’s missing the “@”: an address looks like name@example.com.';
  if (ats > 1) return 'That has more than one “@”. Enter one address.';
  if (s.length > EMAIL_MAX || s.indexOf('@') > 64) return 'That address is too long.';
  if (EMAIL_FULL.test(s)) return '';
  if (!new RegExp(`^${ATOM}(?:\\.${ATOM})*@`, 'u').test(s)) return 'Check the part before the “@”: it can’t start or end with a dot, or have two dots in a row.';
  return 'That doesn’t look like a complete address. Check the part after the “@”, like example.com.';
}

// A likely typo in a common provider's name ("gmial.com", "gmail.con"), as the corrected address,
// or null. Only a suggestion: the person decides.
const PROVIDERS = ['gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'outlook.fr', 'live.com',
  'live.co.uk', 'live.ca', 'msn.com', 'yahoo.com', 'yahoo.co.uk', 'icloud.com', 'me.com', 'mac.com', 'proton.me', 'pm.me',
  'protonmail.com', 'protonmail.ch', 'aol.com', 'btinternet.com', 'sky.com', 'virginmedia.com', 'gmx.com', 'gmx.net',
  'gmx.de', 'web.de', 'yandex.ru', 'mail.ru', 'fastmail.com', 'hey.com', 'zoho.com'];
function distance(a, b) { // optimal string alignment: a swap of two neighbours counts once
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}
export function emailSuggestion(raw) {
  const s = cleanEmail(raw);
  const at = s.lastIndexOf('@');
  if (at < 1 || emailProblem(s)) return null;
  const local = s.slice(0, at);
  const dom = s.slice(at + 1);
  if (PROVIDERS.includes(dom)) return null;
  let best = null;
  let bestD = Infinity;
  for (const p of PROVIDERS) {
    if (Math.abs(p.length - dom.length) > 2) continue;
    const dd = distance(dom, p);
    if (dd < bestD) [best, bestD] = [p, dd];
  }
  if (best && bestD <= (dom.length >= 9 ? 2 : 1)) return `${local}@${best}`;
  const fixed = dom.replace(/\.(con|cmo|ocm|comm|vom|xom|cpm|om)$/, '.com').replace(/\.co\.(uj|ul|k|ik)$/, '.co.uk').replace(/\.(ogr|ork)$/, '.org').replace(/\.(nte|ner)$/, '.net');
  return fixed !== dom ? `${local}@${fixed}` : null;
}

// Why a username can't be used, or ''. Usernames are lowercased and trimmed before this.
export function usernameProblem(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return 'Choose a username.';
  if (/\s/.test(v)) {
    const words = v.split(/\s+/).map((w) => w.replace(/[^a-z0-9_.-]/g, '')).filter(Boolean);
    const a = words[0] || 'ruth';
    const b = words.length > 1 ? words.join('.') : `${a}.writes`;
    return `Usernames can’t contain spaces. Try “${a.slice(0, 24)}” or “${b.slice(0, 24)}”.`;
  }
  if (v.length < 2) return 'At least 2 characters.';
  if (v.length > 24) return 'At most 24 characters.';
  if (!USERNAME_RE.test(v)) return 'Use only lowercase letters, numbers, dots, dashes or underscores.';
  return '';
}
