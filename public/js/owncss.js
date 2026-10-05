// Custom CSS (SPEC §32): the signed-in person's own CSS, on their own screens only: the writer
// page (and the waiting screen), the host dashboard for hosts, and their own writer page and post
// pages. Never on anyone else's view, the live page, the projector or a page viewed signed out.
// ?nocss in the address skips it for that page load. It comes from the person's own session
// (/api/session), is set as a <style> element's text (never parsed as HTML) and is kept the last
// element of <head>, so it wins over stylesheets added later. The CSP lets it load nothing from
// elsewhere (img-src and font-src 'self' data:).

import { api } from './net.js';

const ID = 'wh-own-css';
let watcher = null;

export function nocss() {
  try {
    return new URLSearchParams(location.search).has('nocss');
  } catch {
    return false;
  }
}

// The CSS on this page now ('' if none).
export function currentOwnCss() {
  return document.getElementById(ID)?.textContent || '';
}

// Show `css` on this page ('' removes it). Also the account dialog's live preview.
export function setOwnCss(css) {
  let el = document.getElementById(ID);
  if (!css) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('style');
    el.id = ID;
  }
  if (el.textContent !== css) el.textContent = css;
  if (document.head.lastElementChild !== el) document.head.append(el);
  if (!watcher && typeof MutationObserver === 'function') {
    watcher = new MutationObserver(() => {
      const s = document.getElementById(ID);
      if (s && document.head.lastElementChild !== s) document.head.append(s);
    });
    watcher.observe(document.head, { childList: true });
  }
}

// Is `path` one of the signed-in person's own screens?
export async function isOwnPage(session, path) {
  const u = session?.user;
  if (!u) return false;
  if (path === '/write' || (path === '/' && !u.isAdmin)) return true;
  if (path === '/host') return !!u.isAdmin;
  const m = /^\/(p|w)\/([^/]+)$/.exec(path);
  if (!m) return false;
  let id = '';
  try {
    id = decodeURIComponent(m[2]);
  } catch {
    return false;
  }
  // Their own writer page, or a post of theirs: known from their own `me` view.
  const me = await api('/api/me').catch(() => null);
  if (!me) return false;
  if (m[1] === 'w') return !!me.me?.page && me.me.page === id;
  return (me.posts || []).some((p) => p.publicId && p.publicId === id);
}

export async function applyOwnCss(session, path = location.pathname.replace(/\/+$/, '') || '/') {
  const css = typeof session?.user?.customCss === 'string' ? session.user.customCss : '';
  if (!css || nocss()) return false;
  if (!(await isOwnPage(session, path))) return false;
  setOwnCss(css);
  return true;
}
