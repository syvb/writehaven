// Router: one page shell, a screen per path.

import { h, fill, clear, applyTheme, toast, helpLink } from './ui.js';
import { api, stream, forgetSession } from './net.js';

applyTheme();

async function main() {
  const root = document.getElementById('app');
  let session = { user: null, party: null };
  try {
    session = await api('/api/session');
  } catch {
    fill(root, h('div', { class: 'l-page' }, h('h1', { class: 'l-name' }, 'Writehaven'), h('p', { class: 'l-status' }, 'Can’t reach the server. Check your connection; this page will retry.')));
    setTimeout(() => location.reload(), 5000);
    return;
  }
  const path = location.pathname.replace(/\/+$/, '') || '/';
  if (session.user) import('./owncss.js').then((m) => m.applyOwnCss(session, path)).catch(() => {}); // SPEC §32: their own CSS, own screens only
  // A new build deployed while this page is open (update.js): a notice, or the live page reloads.
  import('./update.js').then((m) => m.watchBuild({ session, path })).catch(() => {});
  if (session.user) signedInExtras(session);
  document.body.dataset.screen = '';
  const screen = (name) => { document.body.dataset.screen = name; };
  if (path === '/login' || path === '/register') {
    if (session.user) return location.replace(session.user.isAdmin ? '/host' : '/write');
    screen('auth');
    return mountAuth(root, session, path === '/register' ? 'register' : 'login');
  }
  if (path === '/host') {
    screen('host');
    const { mountHost } = await import('./host.js');
    return mountHost(root, { session });
  }
  if (path.startsWith('/p/')) {
    screen('public');
    const { mountPost } = await import('./live.js');
    return mountPost(root, { id: decodeURIComponent(path.slice(3)), session });
  }
  // The public list of writers who chose to be on it, and each one's page (SPEC §28).
  if (path === '/writers' || path.startsWith('/w/')) {
    screen('public');
    const pages = await import('./writers.js');
    if (path === '/writers') return pages.mountWriters(root, { session });
    let id = '';
    try {
      id = decodeURIComponent(path.slice(3));
    } catch { /* a malformed address: not found */ }
    return pages.mountProfile(root, { id, session });
  }
  if (path === '/live' || path === '/archive' || (path === '/' && !session.user)) {
    screen('public');
    const live = await import('./live.js');
    if (session.party?.phase === 'ended') return live.mountArchive(root, { session });
    return live.mountLive(root, { session });
  }
  if (path === '/' && session.user?.isAdmin) return location.replace('/host');
  if (path === '/' || path === '/write') {
    if (!session.user) return location.replace('/login');
    // New accounts may wait for the host's approval (SPEC §15): until then, a waiting card.
    // A missing `approval` (older server, offline) counts as approved.
    const writerP = import('./write.js');
    let approval = session.user.approval;
    let meView = null;
    if (approval === undefined && !session.user.isAdmin && !session.offline) {
      meView = await api('/api/me').catch(() => null);
      approval = meView?.me?.approval;
    }
    if (approval === 'pending' || approval === 'declined') {
      // The message and the host's note come with the full `me` view.
      if (!meView) meView = await api('/api/me').catch(() => null);
      screen('approval');
      return mountApproval(root, session, meView?.me || { ...session.user, approval }, async () => {
        screen('write');
        const { mountWriter } = await writerP;
        return mountWriter(root, session);
      });
    }
    screen('write');
    const { mountWriter } = await writerP;
    return mountWriter(root, session);
  }
  screen('public');
  fill(root, h('div', { class: 'l-page' }, h('h1', { class: 'l-name' }, 'Not found'), h('p', null, h('a', { href: '/' }, 'Go to the party'))));
  return undefined;
}

// Signed-in pages: the "Add to Home Screen" hint (SPEC §23; install.js shows it once, on phones,
// and must load early to catch the browser's install offer). Optional: a missing module is fine.
function signedInExtras(session) {
  import('./install.js')
    // Not in the first moments (sign-up, approval, the first words): half a minute in.
    .then((m) => m.maybeShowInstallHint?.({ delayMs: 30_000 }))
    .catch(() => {});
  // Notices (SPEC §22): the banner, the bell and notifications, on every signed-in page.
  import('./notify.js').then((m) => m.initNotices({ session })).catch(() => {});
}

// Sign in / join. Hints stay visible under the fields; problems show on the field itself.
// The display-name and username rules are names.js's (shared with the server and account.js),
// loaded with this page only: signing up needs the network anyway, and without the module the
// server still checks everything.
async function mountAuth(root, session, mode) {
  const rules = await import('./names.js').catch(() => null);
  // The email check before a sign-up (SPEC §25b) lives in account.js: fetched now, so it's ready.
  const accountP = import('./account.js').then((m) => { m.preloadAccount?.(); return m; }).catch(() => null);
  const partyName = session.party?.name || 'Writehaven';
  // The organiser's setup link (/register?setup=<token>): the first account needs it when the server
  // has a setup token. Kept across the Sign in / New writer switch.
  const setup = new URLSearchParams(location.search).get('setup') || '';
  const firstAccount = session.party?.needsSetup === true; // the organiser, setting up: the host account
  const approvalOn = session.party?.approvalRequired === true && !firstAccount;
  // What to know before joining, right above the button: where the writing goes, and the challenge
  // with this party's numbers (generic words if the server didn't send them).
  const keyFacts = () => {
    const r = session.party?.rules || {};
    const target = Number.isFinite(r.targetPerHour) && r.targetPerHour > 0 ? Math.round(r.targetPerHour).toLocaleString('en-GB') : null;
    const mins = Number.isFinite(r.hourLengthMin) ? r.hourLengthMin : 60;
    const per = mins === 60 ? 'an hour' : `every ${mins} minutes`;
    const goal = target ? `${target} new words ${per}` : `a set number of new words ${per}`;
    const miss = r.missedHourOutcome === 'alert-only' ? 'miss one and the host hears about it (you carry on writing)'
      : 'miss one and you’re out of the challenge (you can keep writing)';
    return h('div', { class: 'auth-facts' },
      h('p', null, h('b', null, 'Your writing appears on the public live page as you type'), ', without your name unless you sign the post.'),
      h('p', null, h('b', null, 'The challenge: '), `${goal}; ${miss}.`));
  };
  const err = h('p', { class: 'auth-err', role: 'alert' });
  const form = h('form', { class: 'auth-form', novalidate: true });
  let fields = {};
  const setErr = (key, msg) => {
    const f = fields[key];
    if (!f) return;
    f.ferr.textContent = msg;
    if (msg) f.input.setAttribute('aria-invalid', 'true');
    else f.input.removeAttribute('aria-invalid');
  };
  const field = (key, label, attrs, hint = null) => {
    const id = `auth-${key}`;
    const hintEl = hint ? h('span', { class: 'auth-hint', id: `${id}-hint` }, hint) : null;
    const ferr = h('span', { class: 'auth-ferr', id: `${id}-err` });
    const input = h('input', { id, name: key, ...attrs, 'aria-describedby': [hint ? `${id}-hint` : null, `${id}-err`].filter(Boolean).join(' ') });
    input.addEventListener('input', () => {
      setErr(key, '');
      err.textContent = '';
    });
    fields[key] = { input, ferr };
    return h('div', { class: 'auth-field' }, h('label', { for: id }, label), input, hintEl, ferr);
  };
  const render = () => {
    const reg = mode === 'register';
    const keep = Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, f.input.value]));
    fields = {};
    document.title = `${partyName}: ${reg ? 'join as a writer' : 'sign in'}`;
    err.textContent = '';
    fill(form,
      h('div', { class: 'auth-switch', role: 'tablist' },
        h('button', { type: 'button', role: 'tab', class: reg ? '' : 'is-on', 'aria-selected': String(!reg), onClick: () => { mode = 'login'; history.replaceState(null, '', '/login'); render(); } }, 'Sign in'),
        h('button', { type: 'button', role: 'tab', class: reg ? 'is-on' : '', 'aria-selected': String(reg), onClick: () => { mode = 'register'; history.replaceState(null, '', setup ? `/register?setup=${encodeURIComponent(setup)}` : '/register'); render(); } }, 'New writer')),
      reg ? field('name', 'Display name', { autocomplete: 'name', required: true, maxlength: 40 }, 'Shown on the posts you choose to sign, and on the public list of writers if you join it. Not your email.') : null,
      reg ? field('email', 'Email', { type: 'email', inputmode: 'email', autocomplete: 'email', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', required: true, maxlength: 254 },
        'So the hosts can reach you after the party. Never shown publicly.') : null,
      field('username', 'Username', { autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', required: true, maxlength: 40 },
        reg ? 'For signing in; never shown publicly. Lowercase letters, numbers, dots, dashes or underscores, no spaces.' : null),
      field('password', 'Password', { type: 'password', autocomplete: reg ? 'new-password' : 'current-password', required: true },
        reg ? 'At least 6 characters.' : 'Forgot it? The host can set a new one for you.'),
      reg ? h('p', { class: 'auth-note' }, 'For each post you can choose instead: signed with your name, kept separate and published at the end, or private and never published. Published posts stay in the anthology afterwards.') : null,
      reg ? keyFacts() : null,
      err,
      h('button', { class: 'btn btn-primary auth-go', type: 'submit' }, reg ? (firstAccount ? 'Create the host account' : approvalOn ? 'Create account and request entry' : 'Join the party') : 'Sign in'),
      reg && approvalOn ? h('p', { class: 'auth-note auth-approve' }, 'The host will approve you before you can write.') : null);
    for (const [k, v] of Object.entries(keep)) if (fields[k] && v) fields[k].input.value = v;
    // An email typed as the display name is pointed out as soon as they leave the field.
    fields.name?.input.addEventListener('blur', () => {
      const val = fields.name.input.value;
      if (rules?.hasEmail(val)) setErr('name', rules.displayNameError(val));
    });
    fields.email?.input.addEventListener('blur', () => {
      const val = fields.email.input.value;
      if (val.trim() && rules?.emailProblem(val)) setErr('email', rules.emailProblem(val));
    });
    form.querySelector('input')?.focus();
  };
  const check = () => {
    const reg = mode === 'register';
    const v = (k) => fields[k]?.input.value ?? '';
    const problems = {};
    const nameErr = !reg ? '' : rules ? rules.displayNameError(v('name')) : v('name').trim() ? '' : 'Add a display name.';
    if (nameErr) problems.name = nameErr;
    const emailErr = !reg ? '' : rules ? rules.emailProblem(v('email')) : v('email').trim() ? '' : 'Add your email address.';
    if (emailErr) problems.email = emailErr;
    const u = reg ? (rules ? rules.usernameProblem(v('username')) : '') : (v('username').trim() ? '' : 'Enter your username.');
    if (u) problems.username = u;
    if (reg && v('password').length < 6) problems.password = v('password').length ? `At least 6 characters (this one has ${v('password').length}).` : 'Choose a password of at least 6 characters.';
    if (!reg && !v('password')) problems.password = 'Enter your password.';
    for (const k of Object.keys(fields)) setErr(k, problems[k] || '');
    const firstBad = Object.keys(fields).find((k) => problems[k]);
    if (firstBad) fields[firstBad].input.focus();
    return !firstBad;
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    if (!check()) return;
    const reg = mode === 'register';
    const body = Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, k === 'username' ? f.input.value.trim().toLowerCase() : f.input.value]));
    if (reg) {
      // "Is this your email?" (SPEC §25b): the address shown back, large, before the account exists.
      const acc = await accountP;
      if (acc?.confirmEmail) {
        const r = await acc.confirmEmail(body.email);
        body.email = r.email;
        fields.email.input.value = r.email;
        if (!r.ok) {
          fields.email.input.focus();
          return;
        }
      }
    }
    const btn = form.querySelector('.auth-go');
    btn.disabled = true;
    try {
      if (reg && setup) body.setup = setup;
      // A busy server (many sign-ins at once) asks to come back in a moment: done for them, quietly.
      const send = async (tries = 0) => {
        try {
          return await api(reg ? '/api/register' : '/api/login', body);
        } catch (ex) {
          if (ex.status !== 503 || ex.data?.code !== 'busy' || tries >= 4) throw ex;
          err.textContent = reg ? 'Lots of people are joining right now. One moment…' : 'Lots of people are signing in right now. One moment…';
          await new Promise((res) => setTimeout(res, Math.max(1, Number(ex.data.retryAfter) || 2) * (1000 + Math.random() * 500)));
          err.textContent = '';
          return send(tries + 1);
        }
      };
      const r = await send();
      location.replace(r.user?.isAdmin ? '/host' : '/write');
    } catch (ex) {
      btn.disabled = false;
      const code = ex.data?.code;
      const msg = ex.message || 'Something went wrong. Try again.';
      if (!reg && ex.status === 401) {
        setErr('password', 'That username and password don’t match. Check for a typo, or ask the host to reset it.');
        fields.password.input.select();
      } else if (reg && ex.status === 409) {
        setErr('username', `That username is taken. Try another, like “${body.username.slice(0, 21)}${Math.floor(Math.random() * 90 + 10)}”.`);
        fields.username.input.focus();
      } else if (reg && ex.data?.field && fields[ex.data.field]) {
        setErr(ex.data.field, msg);
        fields[ex.data.field].input.focus();
      }
      else if (reg && ex.status === 400 && /^username/i.test(msg)) setErr('username', 'Use 2–24 lowercase letters, numbers, dots, dashes or underscores.');
      else if (reg && ex.status === 400 && /password/i.test(msg)) setErr('password', msg);
      else if (reg && ex.status === 400 && /name/i.test(msg)) setErr('name', 'Add a display name. It’s shown on the posts you choose to sign, and on the writers list if you join it.');
      else if (code === 'setup_required') err.textContent = 'This party isn’t set up yet: the first account needs the organiser’s setup link.';
      else if (code === 'closed') err.textContent = 'Sign-ups are closed right now. Ask the host to open them.';
      else if (code === 'full') err.textContent = 'The party is full. Ask the host if there’s room for one more.';
      else if (ex.network) err.textContent = 'Can’t reach the party’s server. Check your connection and try again.';
      else err.textContent = msg;
    }
  });
  render();
  fill(root, h('div', { class: 'auth' },
    h('div', { class: 'auth-card' },
      h('h1', { class: 'auth-title' }, partyName),
      h('p', { class: 'auth-lede' }, 'A live writing party. Your words stream anonymously to the live page unless you choose otherwise.'),
      form),
    h('p', { class: 'auth-foot' }, h('a', { href: '/live' }, 'Watch the live page'), helpLink(undefined, { className: 'auth-help' }))));
}

// Waiting for the host's approval (or declined): a calm card with a message to the host.
// The `me` stream flips it to the lobby or editor the moment the host approves.
function mountApproval(root, session, me, onApproved) {
  const partyName = session.party?.name || 'Writehaven';
  let state = { approval: me.approval, message: me.approvalMessage || '', messageAt: me.approvalMessageAt || null, note: me.approvalNote || null };
  let editing = !state.message || state.approval === 'declined';
  let sending = false;
  let es = null;
  const card = h('div', { class: 'ap-card', role: 'main' });
  // While they wait: food preferences (SPEC §18), in a sheet of its own under the card, so the
  // card's updates never touch the form. Optional: it stays away if food.js can't load.
  const food = h('section', { class: 'ap-food', 'aria-label': 'Food preferences', hidden: true });
  fill(root, h('div', { class: 'ap' }, card, food));
  let foodForm = null;
  import('./food.js').then((m) => {
    if (typeof m.renderFoodForm !== 'function' || !food.isConnected) return;
    foodForm = m.renderFoodForm(food, { title: state.approval === 'approved' ? 'Food preferences' : 'While you wait: food preferences', lede: 'So the hosts can feed everyone well. Only the hosts see your answers, unless you choose to share them below (never your allergies).' });
    food.hidden = false;
  }).catch(() => food.remove());
  let name = session.user?.name || me.name || '';
  let username = session.user?.username || me.username || '';
  // An account from before emails were asked for gets a quiet line in the card (SPEC §25b).
  let hasEmail = me.hasEmail ?? session.user?.hasEmail ?? true;
  // Your account (SPEC §25): name, username and password can change while you wait.
  const openAccount = (focus = null) => import('./account.js').then((m) => m.openAccount({
    returnFocus: card.querySelector('.acc-entry'),
    focus,
    onSaved: (u) => {
      ({ name, username } = u);
      if (u.email) hasEmail = true;
      render();
      card.querySelector('.acc-entry')?.focus({ preventScroll: true });
    },
  }), () => toast('You seem to be offline. Try again when you’re back.', { kind: 'warn' }));

  // Approved: the card says so and waits for their click; nothing else on the page changes. Their first hour starts when they first open the
  // editor (§17b), so waiting loses nothing. The click saves the food form first (food.js).
  let starting = false;
  function renderApproved() {
    document.title = `${partyName}: you’re approved`;
    const go = h('button', { class: 'btn btn-primary ap-go', type: 'button', disabled: starting }, starting ? 'Opening…' : 'Start writing →');
    go.addEventListener('click', async () => {
      if (starting) return;
      starting = true;
      go.disabled = true;
      go.textContent = 'Opening…';
      es?.close();
      await Promise.resolve(foodForm?.approved?.()).catch(() => {});
      onApproved();
    });
    fill(card,
      h('p', { class: 'ap-kicker' }, partyName),
      h('h1', { class: 'ap-title' }, 'You’re approved'),
      h('p', { class: 'ap-lede' }, 'Your first hour starts when you start writing.'),
      h('p', { class: 'ap-go-row' }, go),
      h('p', { class: 'ap-foot' },
        h('a', { href: '/live' }, 'Watch the live page'),
        helpLink('approval', { className: 'ap-help' }),
        h('button', { class: 'btn-link ap-signout', type: 'button', onClick: async () => { await api('/api/logout', {}).catch(() => {}); forgetSession(); location.replace('/login'); } }, 'Sign out')));
  }
  // Change the page without moving the food form under someone filling it in: the field they're
  // in (else the form's body) stays where it is on screen. Someone looking at the card instead
  // (the food card's top in the lower half of the screen, nothing focused in it) sees the card stay.
  function keepFoodInPlace(fn) {
    const html = document.documentElement;
    const shown = food.isConnected && !food.hidden;
    const typing = shown && food.contains(document.activeElement);
    const pin = typing ? document.activeElement : shown && food.getBoundingClientRect().top < window.innerHeight / 2 ? food.querySelector('.fd-body') || food : null;
    const before = pin ? pin.getBoundingClientRect().top : null;
    const anchor = html.style.overflowAnchor;
    html.style.overflowAnchor = 'none'; // this compensation only, not the browser's as well
    fn();
    if (before !== null) {
      const delta = pin.getBoundingClientRect().top - before;
      if (delta) window.scrollBy(0, delta);
    }
    requestAnimationFrame(() => { html.style.overflowAnchor = anchor; });
  }

  function render() {
    if (state.approval === 'approved') return renderApproved();
    const draft = card.querySelector('textarea')?.value; // keep what they're typing across updates
    const declined = state.approval === 'declined';
    document.title = `${partyName}: ${declined ? 'not approved' : 'waiting for approval'}`;
    const box = h('textarea', { id: 'ap-msg', class: 'ap-input', rows: 3, maxlength: 500, placeholder: 'e.g. how the host knows you', 'aria-describedby': 'ap-count ap-err' });
    box.value = draft ?? state.message;
    const count = h('span', { class: 'ap-count', id: 'ap-count' }, `${box.value.length} / 500`);
    const err = h('p', { class: 'ap-err', id: 'ap-err', role: 'alert' });
    const send = h('button', { class: 'btn btn-primary', type: 'submit', disabled: sending }, declined ? 'Send and ask again' : state.messageAt ? 'Save' : 'Send');
    box.addEventListener('input', () => {
      count.textContent = `${box.value.length} / 500`;
      err.textContent = '';
    });
    const form = h('form', { class: 'ap-form' },
      h('label', { class: 'ap-label', for: 'ap-msg' }, declined ? 'Message to the host' : 'Message to the host (optional)'),
      box,
      h('div', { class: 'ap-row' }, count, h('div', { class: 'ap-actions' },
        state.messageAt && !declined ? h('button', { class: 'btn btn-quiet', type: 'button', onClick: () => { editing = false; render(); } }, 'Cancel') : null,
        send)),
      err);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const message = box.value.trim();
      if (!message) {
        err.textContent = declined ? 'Write a line to the host, then send it to ask again.' : 'Write a line first, or just wait: the message is optional.';
        box.focus();
        return;
      }
      sending = true;
      send.disabled = true;
      try {
        const r = await api('/api/me/approval-message', { message });
        state = { ...state, message, messageAt: r?.approvalMessageAt || Date.now(), approval: declined ? 'pending' : state.approval };
        editing = false;
        sending = false;
        render();
      } catch (ex) {
        sending = false;
        send.disabled = false;
        if (ex.status === 429) {
          const s = Math.max(1, Math.ceil((ex.data?.retryAfterMs || 10000) / 1000));
          err.textContent = `One moment: you can change your message again in ${s} second${s === 1 ? '' : 's'}.`;
        } else if (ex.status === 404) err.textContent = 'Messages to the host aren’t switched on here. Just wait; the host can still approve you.';
        else if (ex.network) err.textContent = 'You seem to be offline. Your message is still here; send it when you’re back.';
        else err.textContent = ex.message || 'Couldn’t send that. Try again.';
      }
    });
    const sent = state.message && !editing
      ? h('div', { class: 'ap-sent' },
        h('p', { class: 'ap-label' }, 'Your message to the host'),
        h('blockquote', { class: 'ap-quote' }, state.message),
        h('p', { class: 'ap-sent-row' }, h('span', { class: 'ap-ok' }, 'Sent ✓'), ' · ',
          h('button', { class: 'btn-link', type: 'button', onClick: () => { editing = true; render(); card.querySelector('textarea')?.focus(); } }, 'Edit')))
      : null;
    fill(card,
      h('p', { class: 'ap-kicker' }, partyName),
      h('h1', { class: 'ap-title' }, declined ? 'The host didn’t approve this account' : 'Your request is with the host'),
      declined
        ? h('p', { class: 'ap-lede' }, `You signed up as ${name}${username ? ` (@${username})` : ''}. If you think that’s a mistake, send the host a line below: it asks them again.`)
        : h('p', { class: 'ap-lede' }, `You’re signed up as ${name}${username ? ` (@${username})` : ''}. You can leave this page open. It continues by itself.`),
      declined && state.note ? h('figure', { class: 'ap-note' }, h('figcaption', null, 'Note from the host'), h('blockquote', null, state.note)) : null,
      sent || form,
      hasEmail === false ? h('p', { class: 'ap-email' }, 'Add your email so the hosts can reach you; only they see it. ',
        h('button', { class: 'btn-link', type: 'button', onClick: () => openAccount('email') }, 'Add email')) : null,
      h('p', { class: 'ap-foot' },
        h('a', { href: '/live' }, 'Watch the live page'),
        helpLink('approval', { className: 'ap-help' }),
        h('button', { class: 'btn-link acc-entry', type: 'button', onClick: () => openAccount() }, 'Your account'),
        h('button', { class: 'btn-link ap-signout', type: 'button', onClick: async () => { await api('/api/logout', {}).catch(() => {}); forgetSession(); location.replace('/login'); } }, 'Sign out')));
    if (editing && !sent) {
      const ta = card.querySelector('textarea');
      if (ta && document.activeElement === document.body) ta.focus({ preventScroll: true });
    }
  }
  render();
  es = stream('/api/me/events', {
    me: (v) => {
      const m = v?.me;
      if (!m) return;
      if (m.approval === undefined || m.approval === 'approved') {
        // Approved: the card changes and waits for their click; the food form stays as it is.
        if (state.approval !== 'approved') {
          state = { ...state, approval: 'approved' };
          keepFoodInPlace(() => {
            render();
            const t = food.querySelector('.fd-title'); // no longer "While you wait"; the form isn't touched
            if (t) t.textContent = 'Food preferences';
          });
        }
        return;
      }
      let changed = m.approval !== state.approval || (m.approvalNote || null) !== state.note;
      if (typeof m.hasEmail === 'boolean' && m.hasEmail !== hasEmail) {
        hasEmail = m.hasEmail;
        changed = true;
      }
      if (m.name && (m.name !== name || (m.username && m.username !== username))) {
        ({ name } = m); // a host fixed it, or another tab did
        username = m.username || username;
        changed = true;
      }
      if (m.approval === 'declined' && state.approval !== 'declined') editing = true;
      state = { ...state, approval: m.approval, note: m.approvalNote || null };
      if (!editing && m.approvalMessage !== undefined) {
        state.message = m.approvalMessage || '';
        state.messageAt = m.approvalMessageAt || state.messageAt;
      }
      if (changed) render();
    },
  });
}

window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
  if (e.reason && e.reason.message && !e.reason.network) toast(e.reason.message, { kind: 'error' });
});
main();
