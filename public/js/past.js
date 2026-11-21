// Your earlier rounds (/past): every post you wrote in a round that has closed (lib/rounds.js),
// private ones included, to read, copy or download. Those rounds are read-only: their posts can't
// be edited any more; their public pages stay where they were.

import { h, fill, plural, toast, helpLink, menu } from './ui.js';
import { api } from './net.js';
import { renderBlocks, renderNotes } from './md-render.js';
import { footnotes } from './footnotes.js';

const PRIVACY = {
  live: 'Published · no name',
  named: 'Published · signed',
  separate: 'Published · separate identity',
  private: 'Private · never published',
};

function longDate(ms) {
  return new Date(ms).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

let interopP = null;
const interop = () => (interopP ||= import('./interop.js'));

export async function mountPast(root, { session }) {
  document.title = 'Your earlier rounds';
  let v;
  try {
    v = await api('/api/me/past');
  } catch (e) {
    if (e.status === 401) return location.replace('/login');
    fill(root, h('div', { class: 'l-page' }, h('p', { class: 'l-status' }, 'Couldn’t load your earlier rounds. Check your connection and reload.')));
    return undefined;
  }
  const back = session.user?.isAdmin ? { href: '/host', label: 'Host dashboard' } : { href: '/write', label: 'Your posts' };
  const total = v.rounds.reduce((n, r) => n + r.posts.length, 0);
  const head = h('header', { class: 'a-head' },
    h('div', { class: 'l-mast-top' },
      h('a', { class: 'l-link', href: back.href }, h('span', { 'aria-hidden': 'true' }, '← '), back.label),
      h('nav', { class: 'l-mast-nav' }, helpLink(undefined, { className: 'l-help' }))),
    h('h1', { class: 'a-title past-title' }, 'Your earlier rounds'),
    h('p', { class: 'a-lede' }, total
      ? `${plural(total, 'post')} you wrote in ${v.rounds.length === 1 ? 'an earlier round' : `${v.rounds.length} earlier rounds`}, private ones included. Those rounds are closed: you can read, copy and download these, but not change them.`
      : 'You didn’t write anything in an earlier round.'));
  const sections = v.rounds.map((r) => h('section', { class: 'past-round', 'aria-labelledby': `past-r${r.n}` },
    h('h2', { class: 'a-contents-h past-round-h', id: `past-r${r.n}` },
      `Round ${r.n}${r.startedAt ? ` · ${longDate(r.startedAt)}` : ''}`,
      ' · ', h('a', { href: `/archive/${encodeURIComponent(r.n)}` }, 'the anthology')),
    h('ol', { class: 'a-toc past-list' }, r.posts.map((p) => entry(r, p)))));
  fill(root, h('div', { class: 'l-page a-page past-page' }, head, ...sections));
  return undefined;
}

// One post: its title, privacy and length; Read opens its text below, with its notes.
function entry(r, p) {
  const title = p.title || 'Untitled';
  const box = h('div', { class: 'past-text', hidden: true });
  const readBtn = h('button', { class: 'btn btn-quiet', type: 'button', 'aria-expanded': 'false' }, 'Read');
  const dlBtn = h('button', { class: 'btn btn-quiet', type: 'button' }, 'Download…');
  const copyBtn = h('button', { class: 'btn btn-quiet', type: 'button' }, 'Copy');
  let full = null;
  const load = async () => {
    if (!full) full = await api(`/api/me/past/post?round=${encodeURIComponent(r.n)}&id=${encodeURIComponent(p.id)}`);
    return full;
  };
  const failed = (e) => toast(e?.network ? 'You seem to be offline. Try again when you’re back.' : 'Couldn’t load that post. Try again.', { kind: 'error' });
  readBtn.addEventListener('click', async () => {
    if (!box.hidden) {
      box.hidden = true;
      readBtn.textContent = 'Read';
      readBtn.setAttribute('aria-expanded', 'false');
      return;
    }
    try {
      const x = await load();
      if (!box.childNodes.length) {
        const notes = footnotes(x.body);
        const body = h('div', { class: 'p-body prose' }, ...renderBlocks(x.body, { notes }).blocks.map((b) => b.el));
        fill(box, body, h('div', { class: 'p-notes prose' }, renderNotes(notes)),
          x.notes.trim() ? h('div', { class: 'past-notes' }, h('h3', { class: 'a-contents-h' }, 'Your notes'), h('p', { class: 'past-notes-text' }, x.notes)) : null);
      }
      box.hidden = false;
      readBtn.textContent = 'Hide';
      readBtn.setAttribute('aria-expanded', 'true');
    } catch (e) {
      failed(e);
    }
  });
  copyBtn.addEventListener('click', async () => {
    try {
      const x = await load();
      const m = await interop();
      if (!(await m.copyRich(x.body, x.title, null))) throw new Error('copy failed');
      toast('Copied, with its formatting.', { ms: 2500 });
    } catch (e) {
      try {
        await navigator.clipboard.writeText((await load()).body);
        toast('Copied as Markdown.', { ms: 2500 });
      } catch {
        failed(e);
      }
    }
  });
  dlBtn.addEventListener('click', () => {
    const as = (format) => async () => {
      try {
        const x = await load();
        await (await interop()).exportPost({ title: x.title, body: x.body }, format);
      } catch (e) {
        failed(e);
      }
    };
    menu(dlBtn, [
      { label: 'Markdown (.md)', onClick: as('md') },
      { label: 'Word (.docx)', onClick: as('docx') },
      { label: 'Plain text (.txt)', onClick: as('txt') },
      { label: 'PDF (print)', onClick: as('pdf') },
    ], { align: 'right' });
  });
  const meta = [PRIVACY[p.privacy] || p.privacy, plural(p.words, 'word'), p.hasNotes ? 'with notes' : null].filter(Boolean).join(' · ');
  return h('li', { class: 'a-entry past-entry' },
    h('div', { class: 'past-row' },
      h('div', { class: 'past-main' },
        h('span', { class: 'a-entry-title' }, p.publicId ? h('a', { href: `/p/${encodeURIComponent(p.publicId)}` }, title) : title),
        h('span', { class: 'past-meta' }, meta, p.added || p.edited ? ` · ${p.added ? 'added' : 'edited'} after the party` : '')),
      h('div', { class: 'past-acts' }, readBtn, copyBtn, dlBtn)),
    box);
}
