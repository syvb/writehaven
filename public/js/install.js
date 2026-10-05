// "Add Writehaven to your Home Screen" (SPEC §23): a quiet hint, shown once to phone users after
// sign-in, and the same sheet on demand (the writer menu's "Add to Home Screen").
//
//   maybeShowInstallHint({ delayMs }?) -> Promise<boolean>
//       Shows the hint once (true if it did): phones and tablets only, never inside the installed
//       app, never twice (remembered in localStorage), not while a dialog or menu is open. On
//       Android it waits briefly for the browser's install offer and stays quiet without one
//       (already installed, or this browser can't). It doesn't take the focus, and typing
//       anywhere tucks it away.
//   openInstallHelp({ reason, returnFocus }?) -> { close }
//       The sheet as a dialog, on any device; focus returns to the opener. reason
//       'notifications' leads with why it matters on iPhone (Web Push needs the Home Screen app).
//   isStandalone() -> boolean: running as the installed app (the menu item can hide then).
//
// Import it early: it listens for `beforeinstallprompt`, which Chrome fires once, soon after the
// page loads, and the Install button replays that offer.

import { h } from './ui.js';

const KEY = 'wh-install-hint'; // 'shown' | 'dismissed' | 'installed'
let offer = null; // the browser's install offer (beforeinstallprompt), kept for the Install button
let current = null; // the open sheet
let autoShown = false; // once per page even when storage is unavailable
const offerWaiters = new Set();

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // no browser banner: the hint or the menu offers it at a calmer moment
  offer = e;
  for (const fn of offerWaiters) fn();
  offerWaiters.clear();
  current?.refresh();
});
window.addEventListener('appinstalled', () => {
  offer = null;
  remember('installed');
  current?.close({ why: 'installed' });
});

function recall() {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
function remember(v) {
  try {
    if (v === 'shown' && recall()) return;
    localStorage.setItem(KEY, v);
  } catch { /* private mode: the hint may show again on a later visit */ }
}

export function isStandalone() {
  try {
    if (navigator.standalone === true) return true;
    return ['standalone', 'fullscreen', 'minimal-ui'].some((m) => matchMedia(`(display-mode: ${m})`).matches);
  } catch {
    return false;
  }
}

function device() {
  const ua = navigator.userAgent || '';
  const touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1; // iPadOS asks for desktop sites
  const ios = /iPhone|iPad|iPod/.test(ua) || touchMac;
  const android = !ios && /Android/i.test(ua);
  const v = /OS (\d+)_(\d+)/.exec(ua);
  let coarse = false;
  try {
    coarse = matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
  } catch { /* old browser */ }
  return {
    ios,
    ipad: ios && (/iPad/.test(ua) || touchMac),
    iosSafari: ios && !/CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|GSA\/|DuckDuckGo|YaBrowser/.test(ua),
    // Web Push reaches Home Screen apps from iOS 16.4 (newer Safaris report a frozen version).
    iosPush: !v || Number(v[1]) > 16 || (Number(v[1]) === 16 && Number(v[2]) >= 4),
    android,
    firefoxAndroid: android && /Firefox\//.test(ua),
    macSafari: !ios && /Macintosh/.test(ua) && /Version\/[\d.]+.*Safari\//.test(ua) && !/Chrome|Chromium|Edg|OPR|Firefox/.test(ua),
    handheld: ios || android || (coarse && Math.min(screen.width, screen.height) < 820),
  };
}

// ---------------------------------------------------------------- the hint, once

export async function maybeShowInstallHint({ delayMs = 1500 } = {}) {
  const d = device();
  if (!d.handheld || autoShown || recall() || isStandalone() || current) return false;
  await sleep(delayMs);
  // Chrome on Android makes the offer when an install is possible; without one it's already
  // installed or this browser can't, so the hint stays quiet (the menu still explains).
  const needsOffer = d.android && !d.firefoxAndroid;
  if (needsOffer && !offer) await waitForOffer(4000);
  if (needsOffer && !offer) return false;
  if (!(await calm())) return false;
  if (autoShown || recall() || isStandalone() || current) return false;
  autoShown = true;
  remember('shown');
  open({ modal: false });
  return true;
}

export function openInstallHelp({ reason = null, returnFocus = null } = {}) {
  return open({ modal: true, reason, returnFocus });
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
function waitForOffer(ms) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      offerWaiters.delete(done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    offerWaiters.add(done);
  });
}
// Waits (up to 3 minutes) until the page is visible and no dialog or menu is open.
async function calm() {
  const busy = () => document.visibilityState !== 'visible' || !!document.querySelector('.menu-pop')
    || [...document.querySelectorAll('dialog[open]')].some((el) => {
      try {
        return el.matches(':modal');
      } catch {
        return true;
      }
    });
  for (let i = 0; i < 180 && busy(); i++) await sleep(1000);
  return !busy();
}

// ---------------------------------------------------------------- the sheet

// Line glyphs after the system's own buttons (constant markup, 24-unit grid).
const GLYPHS = {
  share: '<path d="M12 14.5V3.6M8.4 7.2 12 3.6l3.6 3.6"/><path d="M9.2 10H7.4a1.8 1.8 0 0 0-1.8 1.8v7.4A1.8 1.8 0 0 0 7.4 21h9.2a1.8 1.8 0 0 0 1.8-1.8v-7.4a1.8 1.8 0 0 0-1.8-1.8h-1.8"/>',
  add: '<rect x="4" y="4" width="16" height="16" rx="3.6"/><path d="M12 8.2v7.6M8.2 12h7.6"/>',
  kebab: '<circle cx="12" cy="5.6" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="18.4" r="1.5"/>',
  install: '<rect x="3.6" y="4.4" width="16.8" height="11.8" rx="2"/><path d="M8.6 20h6.8M12 7.4v5.2M9.6 10.3 12 12.7l2.4-2.4"/>',
  installPhone: '<rect x="6.6" y="2.8" width="10.8" height="18.4" rx="2.4"/><path d="M12 7v6.2M9.5 10.8 12 13.3l2.5-2.5M10.7 18.1h2.6"/>',
};
function glyph(name) {
  const s = h('span', { class: `ih-glyph ih-glyph-${name}`, 'aria-hidden': 'true' });
  const filled = name === 'kebab';
  s.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" ${filled ? 'fill="currentColor" stroke="none"' : 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"'}>${GLYPHS[name]}</svg>`;
  return s;
}
// A system button ("[⬆] Share") and a menu row ("Add to Home Screen [+]"), drawn small.
const button = (name, label) => h('span', { class: 'ih-key' }, name ? glyph(name) : null, label ? h('span', null, label) : null);
const menuRow = (label, name) => h('span', { class: 'ih-row' }, h('span', null, label), glyph(name));
// Numbered steps, one line each: "1  Tap  [⬆ Share]", "2  Choose  [Add to Home Screen +]", "3  Then …".
function steps(...rows) {
  return h('ol', { class: 'ih-steps' }, rows.map(([verb, art], i) => h('li', { class: `ih-step${art ? '' : ' is-text'}` },
    h('span', { class: 'ih-n', 'aria-hidden': 'true' }, String(i + 1)),
    h('span', { class: 'ih-verb' }, verb),
    art || null)));
}

function mode(d) {
  if (isStandalone()) return 'installed';
  if (d.ios) return 'ios';
  if (offer) return 'offer';
  if (d.android) return 'android';
  if (d.macSafari) return 'mac';
  return 'desktop';
}

function content(m, d, reason, act) {
  const reach = 'messages from the hosts reach you even when it’s closed';
  if (m === 'installed') {
    return {
      title: 'Writehaven is on your Home Screen',
      lede: 'You’re using the app right now, so messages from the hosts can reach you here.',
      buttons: [act.done('Got it')],
    };
  }
  if (m === 'ios') {
    // Safari moved Share twice: under ••• in iOS 26's compact bar; in iOS 27's, a touch and hold
    // on the address bar (its ••• became a Tabs button). The version can't be told from here.
    const where = !d.iosSafari
      ? 'Share is in the address bar or the browser’s menu; if it isn’t there, open this page in Safari.'
      : d.ipad
        ? 'Share is at the top of Safari, by the address bar.'
        : 'No Share button in Safari’s bar? Tap ••• (iOS\u00a026), or touch and hold the address bar (iOS\u00a027).';
    return {
      title: 'Add Writehaven to your Home Screen',
      lede: reason === 'notifications' && d.iosPush
        ? `On ${d.ipad ? 'iPad' : 'iPhone'}, messages from the hosts reach you only through the Home Screen app.`
        : d.iosPush ? `It opens like an app, and ${reach}.` : 'It opens full screen, like an app.',
      art: steps(
        ['Tap', button('share', 'Share')],
        ['Choose', menuRow('Add to Home Screen', 'add')],
        ['Tap Add, then open Writehaven from your Home Screen (sign in if it asks).', null]),
      notes: [where],
      buttons: [act.done('Got it')],
    };
  }
  if (m === 'offer') {
    return {
      title: d.handheld ? 'Add Writehaven to your Home Screen' : 'Install Writehaven',
      lede: d.handheld ? `It opens like an app, and ${reach}.` : `It gets its own window, and ${reach}.`,
      buttons: [act.later(), act.install()],
    };
  }
  if (m === 'android') {
    return {
      title: 'Add Writehaven to your Home Screen',
      lede: `It opens like an app, and ${reach}.`,
      art: steps(
        ['Tap', button('kebab', 'Menu')],
        ['Choose', menuRow('Install app', 'installPhone')],
        ['Then open Writehaven from your Home Screen.', null]),
      notes: ['Some browsers call it “Add to Home screen”. Already installed? Open it from your Home Screen.'],
      buttons: [act.done('Got it')],
    };
  }
  if (m === 'mac') {
    return {
      title: 'Add Writehaven to your Dock',
      lede: `It gets its own window, and ${reach}.`,
      art: steps(['Open', button(null, 'File')], ['Choose', menuRow('Add to Dock…', 'add')]),
      notes: ['In Safari’s menu bar (macOS Sonoma or later).'],
      buttons: [act.done('Got it')],
    };
  }
  return {
    title: 'Install Writehaven',
    lede: `It gets its own window, and ${reach}.`,
    art: h('p', { class: 'ih-line' }, 'In Chrome or Edge, click ', button('install', null), ' at the end of the address bar.'),
    notes: ['Or find Install in the browser’s menu. Firefox can’t install web apps; on your phone, use the Share or ⋮ menu.'],
    buttons: [act.done('Got it')],
  };
}

function open({ modal, reason = null, returnFocus = null }) {
  current?.close({ instant: true, why: null });
  const d = device();
  const opener = returnFocus || (document.activeElement && document.activeElement !== document.body ? document.activeElement : null);
  // The quiet hint is a plain region (a <dialog> would take the focus, and with it a phone's
  // keyboard); from the menu it's a real modal dialog.
  const el = modal
    ? h('dialog', { class: 'ih is-modal', 'aria-labelledby': 'ih-title', 'aria-describedby': 'ih-lede' })
    : h('section', { class: 'ih', role: 'dialog', 'aria-labelledby': 'ih-title', 'aria-describedby': 'ih-lede' });
  let closed = false;
  let shown = null;
  let asking = false;

  function close({ instant = false, why = 'dismissed' } = {}) {
    if (closed) return;
    closed = true;
    if (why) remember(why);
    if (current === sheet) current = null;
    document.removeEventListener('beforeinput', onTyping, true);
    const finish = () => {
      if (modal && el.open) el.close();
      el.remove();
      if (modal && opener?.isConnected) opener.focus({ preventScroll: true });
    };
    if (instant) finish();
    else {
      el.classList.remove('is-open');
      setTimeout(finish, 320);
    }
  }

  const act = {
    done: (label) => h('button', { class: 'btn btn-primary', type: 'button', onClick: () => close() }, label),
    later: () => h('button', { class: 'btn btn-quiet', type: 'button', onClick: () => close() }, 'Not now'),
    install: () => h('button', {
      class: 'btn btn-primary ih-install',
      type: 'button',
      onClick: async (e) => {
        const ask = offer;
        if (!ask || asking) return;
        asking = true;
        e.currentTarget.disabled = true;
        offer = null; // an offer can be shown once
        try {
          await ask.prompt();
          const choice = await ask.userChoice;
          close({ why: choice?.outcome === 'accepted' ? 'installed' : 'dismissed' });
        } catch {
          asking = false;
          render(); // the browser said no: show the steps instead
        }
      },
    }, 'Install'),
  };

  function render() {
    const m = mode(d);
    if (m === shown) return;
    shown = m;
    const c = content(m, d, reason, act);
    el.replaceChildren(h('div', { class: 'ih-in' },
      h('div', { class: 'ih-head' },
        h('img', { class: 'ih-icon', src: '/icons/apple-touch-icon-180.png', alt: '', width: 44, height: 44, decoding: 'async' }),
        h('h2', { class: 'ih-title', id: 'ih-title', tabindex: '-1' }, c.title),
        h('button', { class: 'btn-icon ih-x', type: 'button', 'aria-label': 'Close', onClick: () => close() }, '×')),
      h('p', { class: 'ih-lede', id: 'ih-lede' }, c.lede),
      c.art || null,
      c.notes ? h('div', { class: 'ih-notes' }, c.notes.map((t) => h('p', null, t))) : null,
      h('div', { class: 'ih-actions' }, ...c.buttons)));
  }

  // Typing anywhere else tucks the quiet hint away; the menu can bring it back.
  function onTyping(e) {
    if (!el.contains(e.target)) close({ why: 'shown' });
  }

  const sheet = {
    close,
    refresh: () => {
      if (closed || asking) return;
      const hadFocus = el.contains(document.activeElement);
      render();
      if (hadFocus && !el.contains(document.activeElement)) el.querySelector('.ih-title')?.focus({ preventScroll: true });
    },
  };
  current = sheet;
  render();
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  document.body.append(el);
  if (modal) {
    el.addEventListener('cancel', (e) => {
      e.preventDefault();
      close();
    });
    el.addEventListener('click', (e) => { if (e.target === el) close(); });
    el.showModal();
    el.querySelector('.ih-title')?.focus({ preventScroll: true });
  } else {
    document.addEventListener('beforeinput', onTyping, true);
  }
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('is-open')));
  return { close: () => close() };
}
