// Small DOM and formatting helpers shared by every screen.

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, kids);
  return el;
}
function append(el, kids) {
  for (const k of kids) {
    if (k === null || k === undefined || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

const nf = new Intl.NumberFormat('en-GB');
export const fmtInt = (x) => nf.format(Math.round(x || 0));
// Times are shown in the viewer's own time zone, 24-hour (SPEC §24).
const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function fmtTime(ms) {
  return timeFmt.format(ms);
}
// A time that may not be today: "12:00", "tomorrow at 12:00" or "Sun 22 Nov at 12:00".
export function fmtWhen(ms, nowMs = Date.now()) {
  const day = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const days = Math.round((day(ms) - day(nowMs)) / 86_400_000);
  if (days === 0) return timeFmt.format(ms);
  if (days === 1) return `tomorrow at ${timeFmt.format(ms)}`;
  return `${new Date(ms).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} at ${timeFmt.format(ms)}`;
}
export function fmtDur(ms) {
  if (ms < 60_000) return 'under a minute';
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const hh = Math.floor(m / 60);
  return `${hh} h ${String(m % 60).padStart(2, '0')} min`;
}
export function fmtClock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
export function plural(n, one, many = `${one}s`) {
  return `${fmtInt(n)} ${Math.round(n) === 1 ? one : many}`;
}

// ---- theme: system (default), light, dark
export function getTheme() {
  try {
    return localStorage.getItem('wh-theme') || 'system';
  } catch {
    return 'system';
  }
}
export function applyTheme(t = getTheme()) {
  const root = document.documentElement;
  if (t === 'light' || t === 'dark') root.dataset.theme = t;
  else delete root.dataset.theme;
}
export function setTheme(t) {
  try {
    localStorage.setItem('wh-theme', t);
  } catch { /* private mode */ }
  applyTheme(t);
}

// ---- toasts
// toast(msg, { kind, ms, action: { label, onClick } }) -> { el, close }.
// With an action (e.g. Undo) the toast takes clicks and stays up longer.
let toastHost = null;
export function toast(msg, { kind = 'info', ms, action = null } = {}) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const el = h('div', { class: `toast toast-${kind}${action ? ' has-action' : ''}` }, h('span', { class: 'toast-msg' }, msg));
  let timer = null;
  const close = () => {
    clearTimeout(timer);
    if (!el.isConnected || el.classList.contains('toast-out')) return;
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 300);
  };
  if (action) {
    el.append(h('button', {
      class: 'toast-act', type: 'button',
      onClick: () => {
        close();
        action.onClick?.();
      },
    }, action.label));
  }
  toastHost.append(el);
  timer = setTimeout(close, ms ?? (action ? 10000 : 3200));
  return { el, close };
}

// ---- modal (focus-trapped dialog element)
export function modal({ title, body, actions = [], onClose, className = '', dismissable = true }) {
  const dlg = h('dialog', { class: `modal ${className}`, 'aria-label': title || 'Dialog' });
  const close = (v) => {
    if (!dlg.open) return;
    dlg.close();
    dlg.remove();
    if (onClose) onClose(v);
  };
  const head = title ? h('h2', { class: 'modal-title' }, title) : null;
  const foot = actions.length ? h('div', { class: 'modal-actions' }, actions.map((a) => {
    const b = h('button', { class: `btn ${a.danger ? 'btn-danger' : a.primary ? 'btn-primary' : a.quiet ? 'btn-quiet' : ''}`, type: 'button' }, a.label);
    b.addEventListener('click', () => {
      const r = a.onClick ? a.onClick(close) : undefined;
      if (r !== false && !a.keepOpen) close(a.value);
    });
    if (a.id) b.id = a.id;
    return b;
  })) : null;
  // Focus lands on the dialog itself, not on its first button.
  dlg.append(h('div', { class: 'modal-inner', tabindex: '-1', autofocus: true }, head, body, foot));
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    if (dismissable) close(null);
  });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg && dismissable) close(null);
  });
  document.body.append(dlg);
  dlg.showModal();
  return { el: dlg, close };
}

// confirmDialog({ title, body, confirmLabel, cancelLabel, danger }) -> Promise<boolean>.
// body: a string (one paragraph), an array of strings (paragraphs) or a Node.
// Esc, the backdrop and Cancel resolve false; the confirm button resolves true.
export function confirmDialog({ title, body = null, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false, className = '' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const paras = (x) => (x instanceof Node ? x : h('div', { class: 'modal-body' }, (Array.isArray(x) ? x : [x]).filter(Boolean).map((t) => (t instanceof Node ? t : h('p', null, t)))));
    modal({
      title,
      className: `modal-confirm ${className}`,
      body: body === null ? null : paras(body),
      onClose: () => finish(false),
      actions: [
        { label: cancelLabel, quiet: true, onClick: () => finish(false) },
        { label: confirmLabel, primary: !danger, danger, onClick: () => finish(true) },
      ],
    });
  });
}

// A popover menu anchored to a button.
export function menu(anchor, items, { align = 'left', className = '', onClose = null } = {}) {
  const old = document.querySelector('.menu-pop');
  if (old) {
    const same = old.__anchor === anchor;
    old.__close();
    if (same) return null;
  }
  const pop = h('div', { class: `menu-pop ${className}`, role: 'menu' });
  pop.__anchor = anchor;
  for (const it of items) {
    if (!it) continue;
    if (it === '-') {
      pop.append(h('div', { class: 'menu-sep', role: 'separator' }));
      continue;
    }
    if (it.heading) {
      pop.append(h('div', { class: 'menu-heading' }, it.heading));
      continue;
    }
    if (it.node) {
      pop.append(it.node);
      continue;
    }
    const b = h('button', { class: `menu-item ${it.checked ? 'is-checked' : ''} ${it.danger ? 'is-danger' : ''}`, role: 'menuitem', type: 'button', disabled: it.disabled },
      h('span', { class: 'menu-label' }, it.label),
      it.hint ? h('span', { class: 'menu-hint' }, it.hint) : null);
    b.addEventListener('click', () => {
      close(true);
      it.onClick?.();
    });
    pop.append(b);
  }
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth;
  let left = align === 'right' ? r.right - pw : r.left;
  left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
  const below = r.bottom + 6;
  const ph = pop.offsetHeight;
  const top = below + ph > window.innerHeight - 8 && r.top - ph - 6 > 8 ? r.top - ph - 6 : below;
  pop.style.left = `${left}px`;
  pop.style.top = `${Math.max(8, top)}px`;
  anchor.setAttribute('aria-expanded', 'true');
  const onDoc = (e) => {
    if (!pop.contains(e.target) && !anchor.contains(e.target)) close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      close();
      if (!onClose) anchor.focus();
    }
  };
  function close(chose = false) {
    if (!pop.isConnected) return;
    pop.remove();
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
    onClose?.(chose);
  }
  pop.__close = close;
  setTimeout(() => {
    document.addEventListener('pointerdown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
  });
  pop.querySelector('.menu-item:not([disabled])')?.focus({ preventScroll: true });
  return { el: pop, close };
}

// A "How it works" link that opens the help sheet (help.js, loaded when idle). Stays hidden
// if help.js can't be loaded, so no dead link ever shows.
let helpMod = null;
export function helpLink(section = undefined, { label = 'How it works', className = 'help-link' } = {}) {
  const b = h('button', { class: `btn-link ${className}`, type: 'button', hidden: true }, label);
  const load = () => {
    helpMod ||= import('./help.js');
    helpMod.then((m) => {
      if (typeof m.openHelp !== 'function') return;
      b.hidden = false;
      b.addEventListener('click', () => m.openHelp(section));
    }).catch(() => { helpMod = null; });
  };
  if ('requestIdleCallback' in window) requestIdleCallback(load, { timeout: 2500 });
  else setTimeout(load, 800);
  return b;
}

export function debounce(fn, ms) {
  let t = null;
  const d = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  d.flush = (...a) => {
    clearTimeout(t);
    fn(...a);
  };
  return d;
}

// Replace an element's children (null / false children are skipped).
export function fill(el, ...kids) {
  clear(el);
  append(el, kids);
  return el;
}
