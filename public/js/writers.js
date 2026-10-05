// The public list of writers and their pages (SPEC §28). /writers lists the writers who chose to
// be on it (Your account → "Show me on the public list of writers"), by name, each with how many
// of their hours so far met the challenge, and "out of the challenge" when they are; /w/<id> is
// one writer's page: the name, that line, and the posts they signed with their name, linking to
// the post pages, the ones they starred first under "Starred" (SPEC §28b). The server sends
// nothing else (no account names, no anonymous, separate or private posts), so nothing here can
// tie a writer to their unsigned writing. On their own page, signed in, a writer gets a star
// toggle on each piece (POST /api/me/star).
//
// Light updates: each page asks again every 20 s while the party runs (a minute before it starts
// and after it ends), never while the tab is hidden, and at once when it shows again. The answers
// are cached on the server and carry ETags, so this costs the live page nothing.

import { h, fill, fmtInt, plural, helpLink, toast } from './ui.js';
import { api } from './net.js';

// A five-pointed star, drawn (the text faces have no matching glyph): filled, or an outline.
const SVG = 'http://www.w3.org/2000/svg';
function starIcon(filled, cls = 'wp-star-i') {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', 'M12 2.8l2.75 5.86 6.42.78-4.73 4.42 1.22 6.36L12 17.07l-5.66 3.15 1.22-6.36-4.73-4.42 6.42-.78z');
  path.setAttribute('stroke-linejoin', 'round');
  if (filled) path.setAttribute('fill', 'currentColor');
  else {
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.6');
  }
  svg.append(path);
  return svg;
}

const POLL_MS = 20_000; // while the party runs
const QUIET_POLL_MS = 60_000; // before the start and after the end
const STALE_MS = 5000; // a tab shown again asks at once if its answer is older than this

// The pages' styles (public/css/writers.css, with app.css's build version): resolves once they
// load, or after a moment, so a slow stylesheet never holds the page back for long.
let stylesP = null;
function loadStyles() {
  stylesP ||= new Promise((resolve) => {
    const app = document.querySelector('link[href*="/css/app.css"]');
    const v = (/[?&]v=([\w-]+)/.exec(app?.getAttribute('href') || '') || [])[1];
    const link = h('link', { rel: 'stylesheet', href: `/css/writers.css${v ? `?v=${v}` : ''}` });
    link.addEventListener('load', () => resolve(), { once: true });
    link.addEventListener('error', () => resolve(), { once: true });
    setTimeout(resolve, 1500);
    document.head.append(link);
  });
  return stylesP;
}

// "3 of 4 hours met": hours met of the hours judged so far (free hours and hours waiting for the
// host's review are neither).
export function rateText({ met, judged }, phase) {
  if (judged > 0) return `${fmtInt(met)} of ${plural(judged, 'hour')} met`;
  if (phase === 'lobby') return 'Hours start with the party';
  return phase === 'ended' ? 'No hours judged' : 'No hours judged yet';
}
const partyLink = (party) => h('a', { class: 'l-link wr-party', href: '/' },
  party.phase === 'ended' ? `${party.name}: the anthology` : party.phase === 'running' ? `${party.name}: live` : party.name);
const userLink = (session) => {
  const u = session?.user;
  if (!u) return h('a', { class: 'l-link', href: '/login' }, 'Sign in');
  return h('a', { class: 'l-link', href: u.isAdmin ? '/host' : '/write' }, u.isAdmin ? 'Host dashboard' : 'Write');
};

// Ask again while the page is open: every POLL_MS while the party runs, never while hidden.
function keepFresh(load, phaseOf) {
  let timer = 0;
  let last = Date.now();
  let busy = false;
  let stopped = false;
  const wait = () => (phaseOf() === 'running' ? POLL_MS : QUIET_POLL_MS);
  const run = async () => {
    if (busy || stopped) return;
    busy = true;
    clearTimeout(timer);
    try {
      await load();
    } finally {
      busy = false;
      last = Date.now();
      schedule();
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    if (!stopped && document.visibilityState === 'visible') timer = setTimeout(run, wait());
  };
  const onVis = () => {
    if (document.visibilityState !== 'visible') clearTimeout(timer);
    else if (Date.now() - last > STALE_MS) run();
    else schedule();
  };
  document.addEventListener('visibilitychange', onVis);
  schedule();
  return {
    now: run,
    stop() {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVis);
    },
  };
}

// Your account, from these pages (signed in only): whether you're on the list, and the switch.
async function myListing(session) {
  if (!session?.user || session.offline) return null;
  try {
    return (await api('/api/me/account')).publicProfile || null;
  } catch {
    return null;
  }
}
function openYourAccount(button, onSaved) {
  import('./account.js')
    .then((m) => m.openAccount({ returnFocus: button, onSaved }))
    .catch(() => {});
}

// ---------------------------------------------------------------- /writers
export async function mountWriters(root, { session } = {}) {
  let v;
  try {
    [v] = await Promise.all([api('/api/writers'), loadStyles()]);
  } catch (e) {
    return failed(root, e);
  }
  let key = '';
  let mine = null;
  const nav = h('nav', { class: 'l-mast-nav' }, helpLink(undefined, { className: 'l-help' }), userLink(session));
  const top = h('div', { class: 'l-mast-top' }, h('span', { class: 'wr-crumb' }), nav);
  const lede = h('p', { class: 'a-lede wr-lede' });
  const listBox = h('div', { class: 'wr-body' });
  const mineBox = h('p', { class: 'wr-mine', hidden: true });
  const page = h('div', { class: 'l-page wr-page' },
    h('header', { class: 'a-head wr-head' }, top, h('h1', { class: 'a-title' }, 'The writers'), lede),
    listBox,
    h('footer', { class: 'wr-foot' },
      h('p', { class: 'a-orn', 'aria-hidden': 'true' }, '⁂'),
      h('p', null, 'Only writers who chose to be here are listed. Their pages show only the pieces they signed; anonymous writing stays anonymous.'),
      mineBox));
  fill(root, page);

  function render() {
    const body = JSON.stringify(v);
    if (body === key) return;
    key = body;
    const { party, writers } = v;
    document.title = `${party.name}: the writers`;
    fill(top.firstChild, partyLink(party));
    lede.textContent = party.phase === 'lobby'
      ? 'Writers who chose to be listed. Once the party starts, this shows how many of their hours met the hourly challenge, and their pages hold the pieces they sign.'
      : `Writers who chose to be listed, and how many of their hours${party.phase === 'ended' ? '' : ' so far'} met the hourly challenge. Their pages hold the pieces they signed.`;
    // Keep the keyboard where it was across an update.
    const focusId = document.activeElement?.closest?.('.wr-row')?.dataset.id || null;
    if (!writers.length) {
      fill(listBox, h('p', { class: 'wr-none' }, party.phase === 'ended' ? 'No one chose to be listed.' : 'No one is listed yet.'));
    } else {
      fill(listBox, h('ul', { class: 'wr-list', 'aria-label': `${plural(writers.length, 'writer')}` }, writers.map((w) => h('li', { class: 'wr-row', 'data-id': w.id },
        h('a', { class: 'wr-link', href: `/w/${encodeURIComponent(w.id)}` },
          h('span', { class: 'wr-name' }, w.name),
          h('span', { class: 'wr-leader', 'aria-hidden': 'true' }),
          h('span', { class: `wr-rate${w.judged > 0 ? '' : ' is-none'}` }, rateText(w, party.phase),
            w.out ? h('span', { class: 'wr-out' }, ' · out of the challenge') : w.left ? h('span', { class: 'wr-out' }, ' · left the party') : null))))));
    }
    if (focusId) listBox.querySelector(`.wr-row[data-id="${CSS.escape(focusId)}"] a`)?.focus({ preventScroll: true });
  }
  function renderMine() {
    if (!mine) {
      mineBox.hidden = true;
      return;
    }
    const button = h('button', { class: 'btn-link', type: 'button' }, 'Your account');
    button.addEventListener('click', () => openYourAccount(button, async () => {
      mine = await myListing(session);
      renderMine();
      fresh.now();
    }));
    fill(mineBox, mine.on ? ['You’re on this list. To leave it, open ', button, '.'] : ['Want to be listed? Turn it on in ', button, '.']);
    mineBox.hidden = false;
  }

  render();
  const fresh = keepFresh(async () => {
    if (!root.contains(page)) return fresh.stop();
    try {
      v = await api('/api/writers');
      render();
    } catch { /* offline: the last list stays, and catches up by itself */ }
    return undefined;
  }, () => v.party.phase);
  mine = await myListing(session);
  renderMine();
  return undefined;
}

// ---------------------------------------------------------------- /w/<id>
export async function mountProfile(root, { id, session } = {}) {
  let v;
  try {
    [v] = await Promise.all([api(`/api/w/${encodeURIComponent(id)}`), loadStyles()]);
  } catch (e) {
    await loadStyles();
    return e.status === 404 ? notHere(root) : failed(root, e);
  }
  let key = '';
  let own = false; // signed in as this writer: a star toggle on each piece (SPEC §28b)
  let refocus = null; // after a star changes: the piece whose toggle gets the focus back
  const top = h('div', { class: 'l-mast-top' },
    h('a', { class: 'l-link wr-crumb', href: '/writers' }, h('span', { 'aria-hidden': 'true' }, '← '), 'The writers'),
    h('nav', { class: 'l-mast-nav' })); // the party's page; signed in, the notices bell joins it
  const name = h('h1', { class: 'wp-name' });
  const rate = h('p', { class: 'wp-rate' });
  const mineBox = h('p', { class: 'wp-mine', hidden: true });
  const listBox = h('div', { class: 'wp-pieces' });
  const end = h('p', { class: 'wp-end' }, 'Only pieces signed with this name appear here.');
  const page = h('div', { class: 'l-page wp-page' },
    h('header', { class: 'wp-head' }, top, name, rate, mineBox),
    listBox,
    h('footer', { class: 'wr-foot' },
      h('p', { class: 'a-orn', 'aria-hidden': 'true' }, '⁂'),
      end,
      h('p', { class: 'wr-all' }, h('a', { href: '/writers' }, 'All the writers'))));
  fill(root, page);

  // One piece: its title, length and opening, linking to its page; on your own page, a star.
  function entry(p) {
    const link = h('a', { href: `/p/${encodeURIComponent(p.publicId)}` },
      h('span', { class: 'a-entry-line' },
        h('span', { class: 'a-entry-title' }, p.title || 'Untitled'),
        h('span', { class: 'a-leader', 'aria-hidden': 'true' }),
        h('span', { class: 'a-entry-words' }, plural(p.words, 'word'))),
      p.excerpt ? h('span', { class: 'a-entry-ex' }, p.excerpt) : null);
    if (!own) return h('li', { class: 'a-entry wp-entry', 'data-id': p.publicId }, link);
    const title = p.title || 'Untitled';
    const btn = h('button', {
      class: 'wp-star', type: 'button', 'aria-pressed': p.starred ? 'true' : 'false',
      'aria-label': p.starred ? `Unstar “${title}”` : `Star “${title}”: it comes first on your page`,
      title: p.starred ? 'Starred. Unstar' : 'Star: first on your page',
    }, starIcon(p.starred));
    btn.addEventListener('click', () => star(p, btn));
    return h('li', { class: 'a-entry wp-entry is-own', 'data-id': p.publicId }, link, btn);
  }
  const group = (hid, label, list, mark = false) => h('section', { class: 'wp-group', 'aria-labelledby': hid },
    h('h2', { class: 'a-contents-h wp-group-h', id: hid }, mark ? starIcon(true, 'wp-mark') : null, label),
    h('ol', { class: 'a-toc wp-list' }, list.map(entry)));

  function render() {
    const body = `${own}${JSON.stringify(v)}`;
    if (body === key) return;
    key = body;
    const { party, posts } = v;
    document.title = `${v.name}: ${party.name}`;
    const nav = top.lastChild;
    const old = nav.querySelector('.wr-party');
    if (old) old.replaceWith(partyLink(party));
    else nav.prepend(partyLink(party));
    name.textContent = v.name;
    fill(rate, rateText(v, party.phase), v.out ? h('span', { class: 'wp-out' }, ' · out of the challenge') : v.left ? h('span', { class: 'wp-out' }, ' · left the party') : null); // SPEC §33: neutral
    // Keep the keyboard where it was across an update (a star moves its piece to the other group).
    const active = document.activeElement;
    const back = refocus || (active?.closest?.('.wp-entry') ? { id: active.closest('.wp-entry').dataset.id, star: active.classList.contains('wp-star') } : null);
    refocus = null;
    // SPEC §28b: the pieces they starred first, under "Starred"; then the rest.
    const starred = posts.filter((p) => p.starred);
    const rest = posts.filter((p) => !p.starred);
    fill(listBox,
      posts.length ? null : h('section', { class: 'wp-group' },
        h('h2', { class: 'a-contents-h wp-group-h' }, 'Signed pieces'),
        h('p', { class: 'wr-none' }, party.phase === 'ended' ? 'No signed pieces.' : own ? 'No signed pieces yet. Posts you sign with your name appear here.' : 'No signed pieces yet.')),
      starred.length ? group('wp-starred-h', 'Starred', starred, true) : null,
      rest.length ? group('wp-rest-h', starred.length ? 'More pieces' : rest.length === 1 ? 'Signed piece' : 'Signed pieces', rest) : null);
    if (back) listBox.querySelector(`.wp-entry[data-id="${CSS.escape(back.id)}"] ${back.star ? '.wp-star' : 'a'}`)?.focus({ preventScroll: true });
  }
  async function reload() {
    try {
      v = await api(`/api/w/${encodeURIComponent(id)}`);
      render();
    } catch (e) {
      if (e.status === 404) { // they left the list: the page closes
        fresh.stop();
        notHere(root, { left: true });
      } // offline: the last page stays, and catches up by itself
    }
  }
  // Star or unstar one of your pieces from your page (SPEC §28b).
  async function star(p, btn) {
    const want = !p.starred;
    btn.disabled = true;
    try {
      await api('/api/me/star', { publicId: p.publicId, starred: want });
      refocus = { id: p.publicId, star: true };
      toast(want ? 'Starred: it comes first on your page.' : 'Unstarred.', { ms: 3000 });
      await reload();
      refocus = null;
    } catch (e) {
      btn.disabled = false;
      toast(e.network ? 'You seem to be offline. Try again when you’re back.' : e.status === 404 ? 'That piece isn’t on your page any more.' : e.message || 'Couldn’t change the star. Try again.', { kind: 'error' });
      if (e.status === 404) reload();
    }
  }
  render();
  const fresh = keepFresh(async () => {
    if (!root.contains(page)) return fresh.stop();
    await reload();
    return undefined;
  }, () => v.party.phase);
  // Your own page: a word on what it shows, a star on each piece, and the way to change it.
  const me = await myListing(session);
  if (me?.on && me.id === id && root.contains(page)) {
    own = true;
    render();
    const button = h('button', { class: 'btn-link', type: 'button' }, 'Your account');
    button.addEventListener('click', () => openYourAccount(button, () => fresh.now()));
    fill(mineBox, 'This is your page: your display name, your hours and the pieces you sign. Star the ones you’d like read first. To leave the list, open ', button, '.');
    mineBox.hidden = false;
  }
  return undefined;
}

// ---------------------------------------------------------------- states
function notHere(root, { left = false } = {}) {
  document.title = 'Not here';
  fill(root, h('div', { class: 'l-page wp-page' },
    h('p', { class: 'p-back' }, h('a', { href: '/writers' }, 'The writers')),
    h('h1', { class: 'p-title' }, 'Not here'),
    h('p', { class: 'p-missing' }, left ? 'This writer’s page isn’t public any more.' : 'There’s no public page at this address. Writers choose whether to have one.')));
}
function failed(root, e) {
  fill(root, h('div', { class: 'l-page wr-page' },
    h('p', { class: 'p-back' }, h('a', { href: '/' }, 'Back to the party')),
    h('p', { class: 'l-status' }, e?.network ? 'Couldn’t reach the party. Check your connection; this page will try again.' : 'Couldn’t load this page. Reload to try again.')));
  if (e?.network) setTimeout(() => location.reload(), 10_000);
}
