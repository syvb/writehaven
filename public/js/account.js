// Account details (SPEC §25). openAccount(): "Your account", for everyone signed in (writers,
// people waiting for approval, hosts): display name, username and password; a new password
// needs the current one; and whether you're on the public list of writers (SPEC §28). openAccountEditor(person): a host changing someone else's display name,
// username or password, from the writer drawer and the approval queue (co-hosts can't change
// hosts'; the server says so and the dialog explains). Both are one dialog, loaded on demand.

import { h, fill, modal, toast } from './ui.js';
import { api } from './net.js';
import { setOwnCss, currentOwnCss, nocss } from './owncss.js';
import { NAME_MAX, EMAIL_MAX, displayNameError, usernameProblem, hasEmail, publicDisplayName, cleanEmail, emailProblem, emailSuggestion } from './names.js';

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'them';

// The dialog's styles (public/css/account.css, with app.css's build version). Resolves once they
// load, or after a moment: a slow stylesheet never holds the dialog back.
let stylesP = null;
function loadStyles() {
  stylesP ||= new Promise((resolve) => {
    const app = document.querySelector('link[href*="/css/app.css"]');
    const v = (/[?&]v=([\w-]+)/.exec(app?.getAttribute('href') || '') || [])[1];
    const link = h('link', { rel: 'stylesheet', href: `/css/account.css${v ? `?v=${v}` : ''}`, 'data-acc': '' });
    link.addEventListener('load', () => resolve(), { once: true });
    link.addEventListener('error', () => resolve(), { once: true });
    setTimeout(resolve, 1500);
    document.head.append(link);
  });
  return stylesP;
}

function loadError(e) {
  if (e.network) return 'You seem to be offline. Account details need a connection.';
  if (e.status === 401) return 'You’ve been signed out. Sign in again to change your details.';
  if (e.status === 404 && !e.data?.code) return 'Account details can’t be changed on this server.';
  return e.message || 'Couldn’t open your account details. Try again.';
}

// Your own details. returnFocus: where focus goes when it closes; onSaved(user) after a change;
// focus: a field to start in ('email' from the prompt to add one).
export async function openAccount({ returnFocus = document.activeElement, onSaved = null, focus = null } = {}) {
  let data;
  try {
    [data] = await Promise.all([api('/api/me/account'), loadStyles()]);
  } catch (e) {
    toast(loadError(e), { kind: 'error' });
    return null;
  }
  return accountDialog({ self: true, user: data.user, usernameLocked: !!data.usernameLocked, returnFocus, onSaved, focus, publicProfile: data.publicProfile, customCss: data.customCss });
}

// Someone else's details, for hosts. person: { id, name?, self? } (a writers[] or pending[] row;
// `self: true` for the host's own account, which always gets the Your account dialog).
export async function openAccountEditor(person, { returnFocus = document.activeElement, onSaved = null } = {}) {
  if (person.self) return openAccount({ returnFocus, onSaved });
  let data;
  try {
    [data] = await Promise.all([api(`/api/host/account?id=${encodeURIComponent(person.id)}`), loadStyles()]);
  } catch (e) {
    toast(loadError(e), { kind: 'error' });
    return null;
  }
  if (data.self) return openAccount({ returnFocus, onSaved });
  if (!data.canEdit) {
    return modal({
      title: 'Account details',
      className: 'modal-confirm modal-account',
      body: h('div', { class: 'modal-body' }, h('p', null, data.reason || 'You can’t change this account’s details.')),
      actions: [{ label: 'OK', primary: true }],
      onClose: () => returnFocus?.focus?.({ preventScroll: true }),
    });
  }
  return accountDialog({ self: false, user: data.user, usernameLocked: !data.canEditUsername, returnFocus, onSaved });
}

// publicProfile: { on, id } (SPEC §28), your own dialog only; undefined on a server without it.
// customCss: your own saved CSS (SPEC §32), your own dialog only; undefined on a server without it.
function accountDialog({ self, user, usernameLocked, returnFocus, onSaved, focus = null, publicProfile = undefined, customCss = undefined }) {
  const who = self ? 'you' : 'they';
  const first = firstName(user.name);
  const fields = {};
  let saving = false;
  const err = h('p', { class: 'auth-err acc-err', role: 'alert' });
  const setErr = (key, msg) => {
    const f = fields[key];
    if (!f) return;
    f.ferr.textContent = msg;
    if (msg) f.input.setAttribute('aria-invalid', 'true');
    else f.input.removeAttribute('aria-invalid');
  };
  const field = (key, label, attrs, hint) => {
    const id = `acc-${key}`;
    const ferr = h('span', { class: 'auth-ferr', id: `${id}-err` });
    const hintEl = hint ? h('span', { class: 'auth-hint', id: `${id}-hint` }, hint) : null;
    const input = h('input', { id, name: key, ...attrs, 'aria-describedby': [hint ? `${id}-hint` : null, `${id}-err`].filter(Boolean).join(' ') });
    input.addEventListener('input', () => {
      setErr(key, '');
      err.textContent = '';
    });
    fields[key] = { input, ferr };
    return h('div', { class: 'auth-field' }, h('label', { for: id }, label), input, hintEl, ferr);
  };

  const nameField = field('name', 'Display name', { autocomplete: self ? 'nickname' : 'off', maxlength: NAME_MAX, spellcheck: 'false', value: user.name },
    self ? 'Shown on the posts you choose to sign, and on the public list of writers if you join it. Not your email.' : 'Shown on the posts they choose to sign, and on the writers list if they join it. Never an email.');
  // Email (SPEC §25b): private. Hosts see it; it's never shown on posts or public pages.
  const emailField = field('email', 'Email', {
    type: 'email', inputmode: 'email', autocomplete: self ? 'email' : 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false',
    maxlength: EMAIL_MAX, value: user.email || '', placeholder: user.email ? null : 'name@example.com',
  }, self ? 'Private: only the hosts see it. Never shown on your posts.' : 'Private: only hosts see it. Never shown on their posts.');
  fields.email.input.addEventListener('blur', () => {
    const v = fields.email.input.value;
    if (v.trim() && emailProblem(v)) setErr('email', emailProblem(v));
  });
  const userField = field('username', 'Username', {
    autocomplete: self ? 'username' : 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', maxlength: 40, value: user.username,
    readonly: usernameLocked || null,
  }, usernameLocked ? 'Set in the server’s configuration, so it can’t change here.'
    : self ? 'For signing in. Lowercase letters, numbers, dots, dashes or underscores.' : 'They sign in with it. Tell them if you change it.');

  // The password: yours behind "Change your password" (it needs the current one); a host sets a
  // new one directly, visible, to tell them in person.
  let pwBox = null;
  if (self) {
    pwBox = h('details', { class: 'acc-pw' },
      h('summary', null, 'Change your password'),
      field('currentPassword', 'Current password', { type: 'password', autocomplete: 'current-password' }, null),
      field('password', 'New password', { type: 'password', autocomplete: 'new-password', minlength: 6 }, 'At least 6 characters. Your other devices are signed out; this one stays signed in.'));
  } else {
    pwBox = h('div', { class: 'acc-pw is-host' },
      field('password', 'New password (optional)', { type: 'text', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', minlength: 6, placeholder: 'Leave empty to keep theirs' },
        `Signs ${first} out everywhere. Tell them the new one in person.`));
  }

  // The public list of writers (SPEC §28): off until you turn it on; no one else can. It shows
  // what it shows, nothing else, and your page's address once you're on it.
  let listBox = null;
  let listField = null;
  if (self && publicProfile && typeof publicProfile === 'object') {
    const pageUrl = publicProfile.on && publicProfile.id ? `/w/${encodeURIComponent(publicProfile.id)}` : null;
    listBox = h('input', { type: 'checkbox', id: 'acc-list', class: 'acc-list-box', 'aria-describedby': 'acc-list-help' });
    listBox.checked = !!publicProfile.on;
    listField = h('div', { class: 'acc-list' },
      listBox,
      h('label', { for: 'acc-list', class: 'acc-list-label' }, 'Show me on the public list of writers'),
      h('p', { class: 'acc-list-help', id: 'acc-list-help' },
        'Shows your display name, how many hours you’ve met (and if you’re out of the challenge), and the posts you signed with your name. Never your anonymous, separate or private posts.',
        user.approval && user.approval !== 'approved' ? ' You’ll appear once the host approves your account.' : ''),
      pageUrl ? h('p', { class: 'acc-list-page' }, 'Your page: ', h('a', { href: pageUrl, target: '_blank', rel: 'noopener' }, `${location.host}${pageUrl}`)) : null);
  }

  // Appearance (SPEC §32): your own CSS, for your own screens. It shows on this page as you type
  // (unless ?nocss), and goes back to what it was if you cancel.
  let cssBox = null;
  let cssIn = null;
  let savedCss = typeof customCss === 'string' ? customCss : '';
  let shownBefore = '';
  let previewed = false;
  if (self && typeof customCss === 'string') {
    shownBefore = currentOwnCss();
    const size = h('span', { class: 'acc-css-size' });
    const off = h('button', { class: 'btn acc-css-off', type: 'button', hidden: !savedCss }, 'Turn off custom CSS');
    cssIn = h('textarea', {
      id: 'acc-customCss', name: 'customCss', class: 'acc-css-in', rows: 8, spellcheck: 'false', autocapitalize: 'none', autocorrect: 'off',
      placeholder: 'body { background: #fdf6e3; }', 'aria-describedby': 'acc-customCss-hint acc-customCss-err',
    });
    cssIn.value = savedCss;
    const ferr = h('span', { class: 'auth-ferr', id: 'acc-customCss-err' });
    fields.customCss = { input: cssIn, ferr };
    const paintSize = () => {
      const kb = new TextEncoder().encode(cssIn.value).length / 1024;
      size.textContent = `${kb < 0.05 && kb > 0 ? '0.1' : kb.toFixed(1)} of 20 KB`;
      size.classList.toggle('is-over', kb > 20);
    };
    let timer = 0;
    cssIn.addEventListener('input', () => {
      setErr('customCss', '');
      err.textContent = '';
      paintSize();
      clearTimeout(timer);
      if (nocss()) return;
      timer = setTimeout(() => {
        previewed = true;
        setOwnCss(cssIn.value);
      }, 150);
    });
    off.addEventListener('click', async () => {
      off.disabled = true;
      try {
        await api('/api/me/account', { customCss: '' });
        savedCss = '';
        shownBefore = '';
        cssIn.value = '';
        paintSize();
        setOwnCss('');
        off.hidden = true;
        toast('Custom CSS is off.');
        api('/api/session').catch(() => {});
      } catch (ex) {
        setErr('customCss', ex.network ? 'You seem to be offline. Try again when you’re back.' : ex.message || 'Couldn’t turn it off. Try again.');
      } finally {
        off.disabled = false;
      }
    });
    paintSize();
    cssBox = h('details', { class: 'acc-css', open: !!savedCss || focus === 'customCss' },
      h('summary', null, 'Appearance'),
      h('div', { class: 'auth-field' },
        h('label', { for: 'acc-customCss' }, 'Custom CSS'),
        cssIn,
        h('span', { class: 'auth-hint', id: 'acc-customCss-hint' },
          'Applies only to your own screens. Add ?nocss to the address to turn it off for a page. ', size),
        ferr),
      off);
  }

  const askEmail = self && !user.email
    ? h('p', { class: 'acc-note is-ask' }, 'Add your email so the hosts can reach you. Only they see it.')
    : null;
  const emailNote = hasEmail(user.name)
    ? h('p', { class: 'acc-note' }, self
      ? `Your display name is an email address. Posts you sign show only “${publicDisplayName(user.name)}”; a name would be better.`
      : `This display name contains an email address. Public pages show only “${publicDisplayName(user.name)}”.`)
    : null;
  const sub = self ? null : h('p', { class: 'acc-sub' }, `${user.name} · @${user.username}${user.isAdmin ? ' · host' : user.approval && user.approval !== 'approved' ? ` · ${user.approval === 'pending' ? 'waiting for approval' : 'not approved'}` : ''}`);

  const cancel = h('button', { class: 'btn btn-quiet', type: 'button' }, 'Cancel');
  const save = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save');
  const form = h('form', { class: 'acc', novalidate: true },
    h('div', { class: 'acc-body' }, sub, askEmail, emailNote, nameField, emailField, userField, listField, pwBox, cssBox, err),
    h('div', { class: 'modal-actions' }, cancel, save));

  const dlg = modal({
    title: self ? 'Your account' : 'Edit account details',
    className: 'modal-account',
    body: form,
    onClose: (res) => {
      // Not saved: the page shows again what it showed before the preview.
      if (previewed && !(res?.changed || []).includes('customCss')) setOwnCss(shownBefore);
      returnFocus?.focus?.({ preventScroll: true });
    },
  });
  cancel.addEventListener('click', () => dlg.close(null));
  if (focus && fields[focus]) fields[focus].input.focus({ preventScroll: true });

  const value = (k) => fields[k]?.input.value ?? '';
  // What changed, after the same checks the server makes; null if something is wrong.
  function collect() {
    const body = {};
    const problems = {};
    const name = value('name').replace(/\s+/g, ' ').trim();
    const nameErr = displayNameError(name, { who });
    if (nameErr) problems.name = nameErr;
    else if (name !== user.name) body.name = name;
    // An email can be added or corrected, never removed (the sign-up form requires one).
    const em = cleanEmail(value('email'));
    if (em || user.email) {
      const emErr = emailProblem(em, { required: !!user.email });
      if (emErr) problems.email = emErr;
      else if (em !== (user.email || '')) body.email = em;
    }
    if (!usernameLocked) {
      const un = value('username').trim().toLowerCase();
      const unErr = un === user.username ? '' : usernameProblem(un);
      if (unErr) problems.username = unErr;
      else if (un !== user.username) body.username = un;
    }
    if (listBox && listBox.checked !== !!publicProfile.on) body.publicProfile = listBox.checked;
    if (cssIn && cssIn.value !== savedCss) {
      const kb = new TextEncoder().encode(cssIn.value).length / 1024;
      if (kb > 20) problems.customCss = `Custom CSS can be at most 20 KB (this is ${kb.toFixed(1)} KB).`;
      else body.customCss = cssIn.value;
    }
    const pw = value('password');
    if (pw) {
      if (pw.length < 6) problems.password = `At least 6 characters (this one has ${pw.length}).`;
      else body.password = pw;
      if (self && !value('currentPassword')) problems.currentPassword = 'Enter your current password to set a new one.';
      else if (self) body.currentPassword = value('currentPassword');
    } else if (self && value('currentPassword') && pwBox.open) {
      problems.password = 'Enter the new password, or close “Change your password”.';
    }
    for (const k of Object.keys(fields)) setErr(k, problems[k] || '');
    const bad = Object.keys(fields).find((k) => problems[k]);
    if (bad) {
      if ((bad === 'password' || bad === 'currentPassword') && self) pwBox.open = true;
      if (bad === 'customCss' && cssBox) cssBox.open = true;
      fields[bad].input.focus();
      return null;
    }
    return body;
  }

  function doneMessage(res) {
    const c = new Set(res.changed || []);
    const out = [];
    const u = res.user;
    if (self) {
      if (c.has('name')) out.push(`Posts you sign now show “${res.publicName || u.name}”.`);
      if (c.has('email')) out.push('Email saved: only the hosts see it.');
      if (c.has('username')) out.push(`Sign in as ${u.username} from now on.`);
      if (c.has('password')) out.push(res.signedOut ? 'Password changed. Your other devices are signed out.' : 'Password changed.');
      if (c.has('publicProfile')) out.push(res.publicProfile?.on ? 'You’re on the public list of writers.' : 'You’re off the public list of writers.');
      if (c.has('customCss')) out.push(res.customCss ? 'Your custom CSS is on.' : 'Custom CSS is off.');
    } else {
      const f = firstName(u.name);
      if (c.has('name')) out.push(`Display name: “${u.name}”.`);
      if (c.has('email')) out.push('Email saved.');
      if (c.has('username')) out.push(`${f} signs in as ${u.username} now: tell them.`);
      if (c.has('password')) out.push(`New password set: ${f} is signed out everywhere. Tell them in person.`);
    }
    return out.length ? `Saved. ${out.join(' ')}` : 'Saved.';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saving) return;
    err.textContent = '';
    const body = collect();
    if (!body) return;
    if (!Object.keys(body).filter((k) => k !== 'currentPassword').length) {
      dlg.close(null);
      return;
    }
    saving = true;
    save.disabled = true;
    save.textContent = 'Saving…';
    try {
      const res = await api(self ? '/api/me/account' : '/api/host/account', self ? body : { id: user.id, ...body });
      dlg.close(res);
      if (self && (res.changed || []).includes('customCss') && !nocss()) setOwnCss(res.customCss || ''); // what was saved, to the last key
      // Just joined the public list of writers: the way to their page, in a new tab.
      const joined = self && res.publicProfile?.on && res.publicProfile.id && (res.changed || []).includes('publicProfile');
      toast(doneMessage(res), joined
        ? { ms: 9000, action: { label: 'See your page', onClick: () => window.open(`/w/${encodeURIComponent(res.publicProfile.id)}`, '_blank', 'noopener') } }
        : { ms: 6000 });
      if (self) api('/api/session').catch(() => {}); // the copy kept on this device for offline starts
      onSaved?.(res.user, res);
    } catch (ex) {
      saving = false;
      save.disabled = false;
      save.textContent = 'Save';
      const f = ex.data?.field;
      if (f && fields[f]) {
        if ((f === 'password' || f === 'currentPassword') && self) pwBox.open = true;
        if (f === 'customCss' && cssBox) cssBox.open = true;
        setErr(f, f === 'username' && ex.data.code === 'username_taken' ? `That username is taken. Try another, like “${String(body.username || '').slice(0, 21)}${Math.floor(Math.random() * 90 + 10)}”.` : ex.message);
        fields[f].input.focus();
        if (f === 'currentPassword') fields[f].input.select();
      } else if (ex.network) err.textContent = 'You seem to be offline. Nothing was saved; try again when you’re back.';
      else if (ex.status === 401) err.textContent = 'You’ve been signed out. Sign in again to change your details.';
      else err.textContent = ex.message || 'Couldn’t save that. Try again.';
    }
  });
  return dlg;
}

// ---------------------------------------------------------------- email (SPEC §25b)
// Sign-up shows the address back before the account is made: "Is this your email?". No mail is
// ever sent, so this look is the only check. Resolves { ok, email }: ok = "Yes, that's right";
// email may be a suggested correction they took ("gmial.com" → "gmail.com").
export function preloadAccount() {
  return loadStyles();
}
export async function confirmEmail(raw) {
  await loadStyles();
  return new Promise((resolve) => {
    let email = cleanEmail(raw);
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve({ ok, email });
    };
    const addr = h('p', { class: 'em-addr', translate: 'no' });
    const sug = h('p', { class: 'em-sug', 'aria-live': 'polite' });
    const paint = () => {
      addr.textContent = email;
      const s = emailSuggestion(email);
      sug.hidden = !s;
      fill(sug, s ? ['Did you mean ', h('b', { translate: 'no' }, s), '? ', h('button', {
        class: 'btn-link', type: 'button',
        onClick: () => {
          email = s;
          paint();
          dlg.el.querySelector('.modal-actions .btn-primary')?.focus();
        },
      }, 'Use that')] : null);
    };
    const dlg = modal({
      title: 'Is this your email?',
      className: 'modal-email',
      body: h('div', { class: 'modal-body' }, addr, sug,
        h('p', { class: 'em-note' }, 'Check it letter by letter: we don’t send a confirmation email.'),
        h('p', { class: 'em-note' }, 'So the hosts can reach you after the party; it’s never shown publicly.')),
      actions: [
        { label: 'Edit', quiet: true, onClick: () => finish(false) },
        { label: 'Yes, that’s right', primary: true, onClick: () => finish(true) },
      ],
      onClose: () => finish(false),
    });
    paint();
  });
}
