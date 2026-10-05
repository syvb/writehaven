// Food preferences and the food order (SPEC §18, §18b, §20). Only the person themself and the
// hosts ever see any of it. Server routes: lib/food.js.
//
//   renderFoodForm(container, { compact, statusIn, title })  the form, saving as you go
//       → { el, ready: Promise, flush(), destroy() }
//   openFoodSheet({ returnFocus, onClose }?)                  the form in a side/bottom sheet → { close }
//   renderFoodSummary(container, data, { onReload }?)        the host's Food card body, from
//       GET /api/host/food → { reload() }
//   mountFoodCard(container, { intervalMs }?)                fetches, renders, refreshes → { refresh(), destroy() }
//   renderFoodAnswers(container, person, order)              one person's answers (writer drawer)
//   mountWriterFood(container, userId)                       fetches and renders them → Promise
//   orderList(people, order, chosenIds?)                     the order list, grouped (pure) → { groups, unplaced, text }
//   mountFoodNudge({ after, userId, returnFocus, active })   the writer page's one-time "Food" row
//   openEveryonesFood({ returnFocus }?)                     the sheet, open at "Everyone's food" (SPEC §20d)
//   form.approved()                                          the waiting screen is about to become the writer
//       page (SPEC §20e): saves what's typed, then a "You're in" notice there, once
//   mountFoodIdeasLink(container)                            "Out of ideas? Read everyone's food answers"
// A save that reaches the server fires `wh-food-saved` on window ({ detail: { answered } }).

import { h, fill, toast, modal } from './ui.js';
import { api } from './net.js';
import { countWords } from './text.js';

// ------------------------------------------------------------------ the shape (lib/food.js)
export const LIMITS = { text: 300, allergies: 12, picks: 3, options: 12, name: 80 };
export const CHOICES = {
  diet: ['omnivore', 'flexitarian', 'pescatarian', 'vegetarian', 'vegan', 'other'],
  severity: ['preference', 'intolerance', 'allergy', 'severe'],
  spice: ['none', 'mild', 'medium', 'hot', 'very-hot'],
  eating: ['yes', 'snack', 'no'],
  hunger: ['light', 'normal', 'very'],
};
export const LABELS = {
  diet: { omnivore: 'Omnivore', flexitarian: 'Flexitarian', pescatarian: 'Pescatarian', vegetarian: 'Vegetarian', vegan: 'Vegan', other: 'Other' },
  severity: { preference: 'Preference', intolerance: 'Intolerance', allergy: 'Allergy', severe: 'Severe allergy' },
  spice: { none: 'None', mild: 'Mild', medium: 'Medium', hot: 'Hot', 'very-hot': 'Very hot' },
  eating: { yes: 'Yes', snack: 'Just a snack', no: 'No' },
  hunger: { light: 'Light', normal: 'Normal', very: 'Very hungry' },
};
const EATING_HOST = { yes: 'Eating with us', snack: 'Just a snack', no: 'Not eating' };
const SEVERITY_OPTION = {
  preference: 'Preference: I’d rather not',
  intolerance: 'Intolerance: it upsets me',
  allergy: 'Allergy',
  severe: 'Severe allergy (anaphylaxis)',
};
// SPEC §20c, §30: words in the free-text answers count towards the writer's hour (no cap). The
// same fields as lib/food.js foodWords(): loves, avoid, favourite drinks, anything else, and
// the food order (what you'd like, your order lines, drinks for the order).
export function foodWords(food) {
  if (!isObj(food)) return 0;
  const o = isObj(food.order) ? food.order : {};
  const texts = [food.love, food.avoid, food.drinks, food.notes, o.wish, o.drinks, ...(isObj(o.lines) ? Object.values(o.lines) : [])];
  let n = 0;
  for (const t of texts) if (typeof t === 'string' && t) n += countWords(t);
  return n;
}
export const SUGGESTED_ALLERGENS = ['Peanuts', 'Tree nuts', 'Gluten / wheat', 'Dairy / lactose', 'Eggs', 'Soy', 'Fish', 'Shellfish', 'Sesame', 'Mustard', 'Celery', 'Lupin', 'Sulphites', 'Molluscs'];
const SEVERITY_RANK = { severe: 4, allergy: 3, intolerance: 2, preference: 1 };

export function blankOrder() {
  return { eating: null, hunger: null, picks: [], lines: {}, wish: '', drinks: '', payment: '' };
}
export function blankFood() {
  return {
    diet: null, dietOther: '', allergies: [], noAllergies: false,
    avoid: '', love: '', spice: null, drinks: '', notes: '',
    order: blankOrder(),
    share: false,
  };
}
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');
const pick = (v, list) => (list.includes(v) ? v : null);
// Anything (a server answer, an old draft) into the full shape.
export function normFood(f) {
  const b = blankFood();
  if (!isObj(f)) return b;
  const o = isObj(f.order) ? f.order : {};
  return {
    diet: pick(f.diet, CHOICES.diet), dietOther: str(f.dietOther),
    allergies: Array.isArray(f.allergies) ? f.allergies.filter(isObj).slice(0, LIMITS.allergies).map((a) => ({ item: str(a.item), severity: pick(a.severity, CHOICES.severity), note: str(a.note) })) : [],
    noAllergies: f.noAllergies === true,
    avoid: str(f.avoid), love: str(f.love), spice: pick(f.spice, CHOICES.spice), drinks: str(f.drinks), notes: str(f.notes),
    order: {
      ...b.order,
      eating: pick(o.eating, CHOICES.eating), hunger: pick(o.hunger, CHOICES.hunger),
      picks: Array.isArray(o.picks) ? o.picks.filter((x) => typeof x === 'string').slice(0, LIMITS.picks) : [],
      lines: isObj(o.lines) ? Object.fromEntries(Object.entries(o.lines).filter(([, v]) => typeof v === 'string')) : {},
      wish: str(o.wish), drinks: str(o.drinks), payment: str(o.payment),
    },
    share: f.share === true,
  };
}
export function normSetup(s) {
  const o = isObj(s) ? s : {};
  return {
    options: Array.isArray(o.options) ? o.options.filter((x) => isObj(x) && typeof x.id === 'string').map((x) => ({ id: x.id, name: str(x.name), note: str(x.note), menuUrl: safeUrl(x.menuUrl) })) : [],
    deadline: typeof o.deadline === 'string' && /^\d\d:\d\d$/.test(o.deadline) ? o.deadline : null,
    note: str(o.note),
  };
}
// Menu links come from the hosts and are checked on the server; only web addresses become links.
function safeUrl(v) {
  if (typeof v !== 'string' || !v) return '';
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '';
  } catch {
    return '';
  }
}
// The same characters the server removes, gone while typing (never trimmed mid-word).
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const clean = (v, multiline) => {
  const s = v.replace(INVISIBLE, '');
  return multiline ? s : s.replace(/\n/g, ' ');
};
const hasText = (s) => typeof s === 'string' && s.trim().length > 0;
function deadlinePassed(hhmm, now = new Date()) {
  if (!hhmm) return false;
  const [hh, mm] = hhmm.split(':').map(Number);
  return now.getHours() * 60 + now.getMinutes() >= hh * 60 + mm;
}
const fmtTime = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const ordinal = (i) => ['1st', '2nd', '3rd'][i] || `${i + 1}th`;

// ------------------------------------------------------------------ the person's draft
// Unsent answers are kept on the device, so a reload or a dropped connection loses nothing.
const draftKey = (uid) => `wh-food:${uid}`;
function readDraft(uid) {
  try {
    const v = JSON.parse(localStorage.getItem(draftKey(uid)) || 'null');
    return v && v.v === 1 ? v : null;
  } catch {
    return null;
  }
}
function writeDraft(uid, d) {
  try {
    localStorage.setItem(draftKey(uid), JSON.stringify({ v: 1, ...d }));
  } catch { /* private mode or full */ }
}
function dropDraft(uid) {
  try {
    localStorage.removeItem(draftKey(uid));
  } catch { /* ignore */ }
}
// Who's signed in on this device, for opening the draft while offline: the cached session
// (net.js), else whoever last opened this form here.
function cachedUserId() {
  try {
    return JSON.parse(localStorage.getItem('wh-session') || 'null')?.user?.id || localStorage.getItem('wh-food-user') || null;
  } catch {
    return null;
  }
}
function rememberUser(id) {
  try {
    if (id) localStorage.setItem('wh-food-user', id);
  } catch { /* ignore */ }
}

// ------------------------------------------------------------------ small parts
let uid = 0;
const nextId = (p) => `${p}-${++uid}`;

function grow(ta) {
  if (!ta.isConnected) return;
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight + 2}px`;
}

// A row of pill buttons. Single choice: pressing the chosen one again clears it (everything is
// optional). `mark(v)` adds a small decoration (the spice dots).
function chips({ values, labels, label, isOn, onToggle, mark = null, className = '' }) {
  const wrap = h('div', { class: `fd-chips ${className}`, role: 'group', 'aria-label': label });
  const btns = values.map((v) => {
    const b = h('button', { type: 'button', class: 'fd-chip', 'aria-pressed': String(!!isOn(v)), dataset: { v } },
      mark ? mark(v) : null, h('span', null, labels[v]));
    b.addEventListener('click', () => {
      onToggle(v);
      sync();
    });
    return b;
  });
  function sync() {
    for (const b of btns) b.setAttribute('aria-pressed', String(!!isOn(b.dataset.v)));
  }
  wrap.append(...btns);
  wrap.sync = sync;
  return wrap;
}

function spiceDots(v) {
  const n = CHOICES.spice.indexOf(v);
  return h('span', { class: 'fd-dots', 'aria-hidden': 'true' }, [0, 1, 2, 3].map((i) => h('i', { class: i < n ? 'is-on' : '' })));
}

// ------------------------------------------------------------------ the form
// renderFoodForm(container, { compact, statusIn, title }): the person's own answers, loaded from
// GET /api/me/food and saved with PUT as they go (debounced), kept on the device until the
// server has them, retried when the connection comes back.
export function renderFoodForm(container, { compact = false, statusIn = null, title = null, lede = null } = {}) {
  let st = blankFood();
  let setup = normSetup(null);
  let resetAt = null;
  let userId = null;
  let skew = 0; // server clock - device clock
  let destroyed = false;
  let loaded = false;
  // Saving: every change bumps `changeSeq`; a save sends the whole answer set.
  let changeSeq = 0;
  let savedSeq = 0;
  let inflight = false;
  let again = false;
  let timer = null;
  let retryTimer = null;
  let failures = 0;
  let poll = null;

  const formId = nextId('fd');
  const statusEl = h('p', { class: 'fd-status is-idle', role: 'status', 'aria-live': 'polite' }, 'Saves as you go');
  const counterEl = h('p', { class: 'fd-words', hidden: true });
  const bar = statusIn ? null : h('div', { class: 'fd-bar', hidden: true }, statusEl, counterEl);
  let hourWord = 'this hour'; // "your first hour" until the writer's hours have started
  // SPEC §20c: a speedrun, and the words count.
  const speed = h('p', { class: 'fd-speed' }, h('b', null, 'Speedrun this:'), ' a minute is plenty. The words you write here count towards your hour and the party’s total.');
  const notice = h('p', { class: 'fd-notice', role: 'alert', hidden: true });
  const body = h('div', { class: 'fd-body' });
  const root = h('div', { class: `fd${compact ? ' is-compact' : ''}`, id: formId, 'aria-busy': 'true' });
  if (!compact) {
    root.append(h('header', { class: 'fd-head' },
      h('h2', { class: 'fd-title' }, title || 'While you wait: food preferences'),
      h('p', { class: 'fd-lede' }, lede || 'So the hosts can feed everyone well. Only the hosts see your answers, unless you choose to share them below (never your allergies).'),
      h('p', { class: 'fd-hint' }, 'Everything is optional and saves as you go.')));
  }
  root.append(speed, notice, body);
  if (statusIn) fill(statusIn, statusEl, counterEl);
  else root.append(bar);
  body.append(h('p', { class: 'fd-loading' }, 'Opening your answers…'));
  fill(container, root);

  // ---- status line
  function status(kind, text) {
    statusEl.className = `fd-status is-${kind}`;
    statusEl.textContent = text;
    if (bar) bar.hidden = kind === 'idle' && counterEl.hidden;
  }
  // "38 food words · they count towards this hour" (SPEC §20c), live as they type.
  function paintCount() {
    const n = foodWords(st);
    counterEl.hidden = n === 0;
    if (n) {
      const what = n === 1 ? 'it counts' : 'they count';
      fill(counterEl, h('b', null, String(n)), ` food word${n === 1 ? '' : 's'} · ${what} towards ${hourWord}`);
    }
    if (bar) bar.hidden = statusEl.classList.contains('is-idle') && counterEl.hidden;
  }
  const savedText = (at) => (at ? `Saved · ${fmtTime(at - skew)}` : 'Saved');

  // ---- saving
  function draftNow(dirty) {
    if (userId) writeDraft(userId, { food: st, dirty, at: Date.now(), resetAt, setup });
  }
  function changed(delay = 650) {
    if (!loaded || destroyed) return;
    paintCount();
    changeSeq++;
    draftNow(true);
    status('pending', 'Saving…');
    clearTimeout(timer);
    clearTimeout(retryTimer);
    timer = setTimeout(send, delay);
  }
  let waiters = [];
  const settle = () => {
    const w = waiters;
    waiters = [];
    for (const f of w) f();
  };
  function whenSaved(ms) {
    if (savedSeq === changeSeq) return Promise.resolve();
    return new Promise((resolve) => {
      waiters.push(resolve);
      setTimeout(resolve, ms);
    });
  }
  async function send() {
    clearTimeout(timer);
    timer = null;
    if (inflight) {
      again = true;
      return;
    }
    if (savedSeq === changeSeq) return;
    const seq = changeSeq;
    inflight = true;
    status('saving', 'Saving…');
    try {
      const r = await api('/api/me/food', { ...st, resetAt }, { method: 'PUT' });
      failures = 0;
      savedSeq = seq;
      if (savedSeq === changeSeq) settle();
      try {
        window.dispatchEvent(new CustomEvent('wh-food-saved', { detail: { answered: !!r?.food } }));
      } catch { /* old browser */ }
      if (savedSeq === changeSeq) {
        draftNow(false);
        status('saved', savedText(r?.updatedAt));
      }
    } catch (e) {
      settle(); // nobody waits on a save that failed; it's retried (and kept on the device)
      const code = e.data?.code;
      if (e.status === 409 && code === 'reset') {
        wasReset(e.data.resetAt ?? null, 'food' in e.data ? e.data.food : undefined, e.data.updatedAt ?? null);
      } else if (e.status === 429) {
        retry(Math.max(500, Number(e.data?.retryAfterMs) || 2000));
        status('pending', 'Saving…');
      } else if (e.status === 401) {
        status('error', 'You’re signed out. Your answers are kept on this device; sign in again to send them.');
      } else if (e.status === 400 || e.status === 413) {
        status('error', e.message || 'Couldn’t save that. Check the last thing you changed.');
      } else {
        failures++;
        status('offline', 'Offline. Your answers are kept on this device and send when you’re back.');
        retry(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)));
      }
    } finally {
      inflight = false;
      if (again) {
        again = false;
        send();
      }
    }
  }
  function retry(ms) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (!destroyed && savedSeq !== changeSeq) send();
    }, ms);
  }
  // The page is going away: send what's left without waiting for an answer.
  function beacon() {
    if (!loaded || savedSeq === changeSeq) return;
    try {
      fetch('/api/me/food', {
        method: 'PUT', keepalive: true, credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-WH': '1' },
        body: JSON.stringify({ ...st, resetAt }),
      }).catch(() => {});
    } catch { /* the draft still has it */ }
  }
  const gone = () => {
    if (destroyed) return true;
    if (root.isConnected) return false;
    api_.destroy();
    return true;
  };
  const onOnline = () => {
    if (gone()) return;
    if (savedSeq !== changeSeq) send();
    refreshSetup();
  };
  const onHide = () => {
    if (document.visibilityState === 'hidden') beacon();
    else if (!gone()) refreshSetup();
  };
  window.addEventListener('online', onOnline);
  window.addEventListener('pagehide', beacon);
  document.addEventListener('visibilitychange', onHide);

  // The hosts cleared everyone's answers (SPEC §20): start fresh, say so.
  // The hosts started a new order (SPEC §20): only the food order answers were cleared. The kept
  // answers come from the server; anything being changed here that wasn't saved yet stays (all
  // but the order) and is sent again.
  function wasReset(at, kept = undefined, keptAt = null) {
    resetAt = at;
    const unsaved = savedSeq !== changeSeq;
    st = unsaved || kept === undefined ? normFood({ ...st, order: blankOrder() }) : normFood(kept);
    notice.hidden = false;
    notice.textContent = 'The hosts started a new food order: your order answers are cleared. Your diet, allergies and everything else are kept.';
    renderAll();
    if (unsaved) {
      changed(50);
      return;
    }
    savedSeq = changeSeq;
    draftNow(false);
    status(keptAt ? 'saved' : 'idle', keptAt ? savedText(keptAt) : 'Saves as you go');
  }

  // ---- loading
  async function load() {
    let server = null;
    let err = null;
    try {
      server = await api('/api/me/food');
    } catch (e) {
      err = e;
    }
    if (destroyed) return;
    userId = server?.userId || cachedUserId();
    if (server?.userId) rememberUser(server.userId);
    if (server?.firstHour) hourWord = 'your first hour';
    api_.sharedOk = !!server?.sharedOk;
    const draft = userId ? readDraft(userId) : null;
    if (server) {
      skew = Number.isFinite(server.serverNow) ? server.serverNow - Date.now() : 0;
      setup = normSetup(server.order);
      resetAt = server.resetAt ?? null;
      const usable = draft && draft.dirty && (draft.resetAt ?? null) === resetAt
        && (!server.updatedAt || draft.at + skew >= server.updatedAt - 2000);
      if (usable) {
        st = normFood(draft.food);
        loaded = true;
        renderAll();
        changed(50); // what this device hadn't sent yet goes now
      } else {
        st = normFood(server.food);
        if (draft) dropDraft(userId);
        loaded = true;
        renderAll();
        status(server.updatedAt ? 'saved' : 'idle', server.updatedAt ? savedText(server.updatedAt) : 'Saves as you go');
      }
    } else if (err && err.status === 401) {
      loaded = false;
      fill(body, h('p', { class: 'fd-empty' }, 'Sign in to tell the hosts what you’d like to eat.'));
      status('error', 'Signed out');
    } else {
      // Offline: carry on from this device's copy; it all goes when the connection is back.
      st = normFood(draft?.food);
      setup = normSetup(draft?.setup);
      resetAt = draft?.resetAt ?? null;
      loaded = true;
      renderAll();
      if (draft?.dirty) {
        changeSeq = 1;
        retry(4000);
      }
      status('offline', 'Offline. Your answers are kept on this device and send when you’re back.');
    }
    root.removeAttribute('aria-busy');
    // New options from the hosts, or a reset, show up while the form stays open.
    poll = setInterval(() => {
      if (!gone() && document.visibilityState === 'visible') refreshSetup();
    }, 60_000);
  }

  let deferred = false;
  async function refreshSetup() {
    if (!loaded || destroyed) return;
    let server;
    try {
      server = await api('/api/me/food');
    } catch {
      return;
    }
    if (destroyed) return;
    if ((server.resetAt ?? null) !== resetAt) {
      wasReset(server.resetAt ?? null, server.food ?? null, server.updatedAt ?? null);
      return;
    }
    const next = normSetup(server.order);
    if (JSON.stringify(next) === JSON.stringify(setup)) return;
    setup = next;
    draftNow(savedSeq !== changeSeq);
    // Never pull the field out from under someone typing in it.
    if (orderEl && orderEl.contains(document.activeElement)) {
      if (!deferred) {
        deferred = true;
        orderEl.addEventListener('focusout', function later(e) {
          if (orderEl.contains(e.relatedTarget)) return;
          orderEl.removeEventListener('focusout', later);
          deferred = false;
          renderOrder();
        });
      }
      return;
    }
    renderOrder();
  }

  // ---- fields
  function textField({ get, set, multiline = false, placeholder = '', id = nextId('fd-f'), label = null, rows = 2, className = '' }) {
    const el = multiline
      ? h('textarea', { class: `fd-in fd-ta ${className}`, id, rows, maxlength: LIMITS.text, placeholder, 'aria-label': label })
      : h('input', { class: `fd-in ${className}`, id, type: 'text', maxlength: LIMITS.text, placeholder, autocomplete: 'off', 'aria-label': label });
    el.value = get() || '';
    const count = h('span', { class: 'fd-count', 'aria-hidden': 'true' });
    const paint = () => {
      const n = el.value.length;
      count.textContent = n > LIMITS.text - 60 ? `${n} / ${LIMITS.text}` : '';
    };
    el.addEventListener('input', () => {
      const v = clean(el.value, multiline);
      if (v !== el.value) {
        const at = el.selectionStart;
        el.value = v;
        try {
          el.setSelectionRange(at - 1, at - 1);
        } catch { /* not a text field any more */ }
      }
      set(el.value);
      paint();
      if (multiline) grow(el);
      changed(900);
    });
    el.addEventListener('blur', () => {
      if (timer) send();
    });
    if (multiline) requestAnimationFrame(() => grow(el));
    paint();
    return h('div', { class: 'fd-field' }, el, count);
  }

  function question(labelText, content, { help = null, forId = null, className = '' } = {}) {
    const lab = forId ? h('label', { class: 'fd-q-label', for: forId }, labelText) : h('p', { class: 'fd-q-label' }, labelText);
    return h('div', { class: `fd-q ${className}` }, lab, help ? h('p', { class: 'fd-q-help' }, help) : null, content);
  }

  // ---- the food order
  let orderEl = null;
  function renderOrder() {
    const el = orderPart();
    if (orderEl && orderEl.isConnected) orderEl.replaceWith(el);
    orderEl = el;
    return el;
  }
  function orderPart() {
    const o = st.order;
    const opts = setup.options;
    // Picks of options the hosts have since removed fall away.
    const live = o.picks.filter((id) => opts.some((x) => x.id === id));
    if (live.length !== o.picks.length) {
      o.picks = live;
      for (const k of Object.keys(o.lines)) if (!live.includes(k)) delete o.lines[k];
      if (loaded) queueMicrotask(() => changed());
    }
    const hid = nextId('fd-h');
    const part = h('section', { class: 'fd-part fd-part-order', 'aria-labelledby': hid });
    const passed = deadlinePassed(setup.deadline);
    part.append(h('div', { class: 'fd-part-head' },
      h('h3', { class: 'fd-part-h', id: hid }, 'Food order'),
      setup.deadline ? h('p', { class: `fd-deadline${passed ? ' is-passed' : ''}` }, passed ? `Orders closed at ${setup.deadline}` : `Orders close at ${setup.deadline}`) : null));
    if (hasText(setup.note)) part.append(h('p', { class: 'fd-host-note' }, setup.note));
    if (passed) part.append(h('p', { class: 'fd-soft' }, 'You can still change your answers; tell a host if it’s about this order.'));
    part.append(question('Will you eat with us?', chips({
      values: CHOICES.eating, labels: LABELS.eating, label: 'Will you eat with us?',
      isOn: (v) => o.eating === v,
      onToggle: (v) => {
        o.eating = o.eating === v ? null : v;
        changed(300);
        const wasNo = part.classList.contains('is-not-eating');
        if (wasNo !== (o.eating === 'no')) {
          renderOrder();
          orderEl.querySelector(`.fd-chip[data-v="${v}"]`)?.focus({ preventScroll: true });
        }
      },
    })));
    if (o.eating === 'no') {
      part.classList.add('is-not-eating');
      part.append(h('p', { class: 'fd-soft' }, 'No problem. What you tell us below still helps the hosts plan.'));
      return part;
    }
    part.append(question('How hungry?', chips({
      values: CHOICES.hunger, labels: LABELS.hunger, label: 'How hungry?',
      isOn: (v) => o.hunger === v,
      onToggle: (v) => {
        o.hunger = o.hunger === v ? null : v;
        changed(300);
      },
    })));
    if (opts.length) part.append(optionPicker());
    else {
      const id = nextId('fd-f');
      part.append(question('What would you like?', textField({ id, get: () => o.wish, set: (v) => { o.wish = v; }, placeholder: 'e.g. pizza or Thai' }), { forId: id }));
    }
    const did = nextId('fd-f');
    part.append(question('Drinks for the order', textField({ id: did, get: () => o.drinks, set: (v) => { o.drinks = v; }, placeholder: 'e.g. sparkling water, a ginger beer' }), { forId: did }));
    const pid = nextId('fd-f');
    part.append(question('Budget or payment note', textField({ id: pid, get: () => o.payment, set: (v) => { o.payment = v; }, placeholder: 'e.g. happy to chip in £15' }), { forId: pid, help: 'Optional.' }));
    return part;
  }

  function optionPicker() {
    const o = st.order;
    const opts = setup.options;
    const full = h('p', { class: 'fd-q-help fd-full', role: 'status', 'aria-live': 'polite' });
    const cards = h('div', { class: 'fd-opts' });
    const picksEl = h('ol', { class: 'fd-picks' });
    const paintCards = () => fill(cards, ...opts.map((x) => {
      const rank = o.picks.indexOf(x.id);
      const btn = h('button', { type: 'button', class: 'fd-opt-pick', 'aria-pressed': String(rank >= 0) },
        h('span', { class: 'fd-rank', 'aria-hidden': 'true' }, rank >= 0 ? String(rank + 1) : ''),
        h('span', { class: 'fd-opt-text' },
          h('span', { class: 'fd-opt-name' }, x.name),
          x.note ? h('span', { class: 'fd-opt-note' }, x.note) : null),
        h('span', { class: 'fd-sr' }, rank >= 0 ? ` (your ${ordinal(rank)} choice)` : ''));
      btn.addEventListener('click', () => {
        const i = o.picks.indexOf(x.id);
        if (i >= 0) o.picks.splice(i, 1);
        else if (o.picks.length >= LIMITS.picks) {
          full.textContent = `You’ve picked ${LIMITS.picks}. Remove one to pick another.`;
          return;
        } else o.picks.push(x.id);
        full.textContent = '';
        changed(300);
        paintCards();
        paintPicks();
        cards.querySelectorAll('.fd-opt-pick')[opts.indexOf(x)]?.focus({ preventScroll: true });
      });
      return h('div', { class: `fd-opt${rank >= 0 ? ' is-picked' : ''}` }, btn,
        x.menuUrl ? h('a', { class: 'fd-opt-menu', href: x.menuUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Menu ↗') : null);
    }));
    const paintPicks = () => {
      fill(picksEl, ...o.picks.map((id, i) => {
        const x = opts.find((y) => y.id === id);
        if (!x) return null;
        const lid = nextId('fd-f');
        const up = i > 0 ? h('button', { type: 'button', class: 'btn-icon fd-pick-up', 'aria-label': `Make ${x.name} your ${ordinal(i - 1)} choice`, title: 'Move up' }, '↑') : null;
        up?.addEventListener('click', () => {
          [o.picks[i - 1], o.picks[i]] = [o.picks[i], o.picks[i - 1]];
          changed(300);
          paintCards();
          paintPicks();
          picksEl.querySelectorAll('.fd-pick')[i - 1]?.querySelector('input')?.focus({ preventScroll: true });
        });
        const x2 = h('button', { type: 'button', class: 'btn-icon fd-pick-x', 'aria-label': `Remove ${x.name}`, title: 'Remove' }, '×');
        x2.addEventListener('click', () => {
          o.picks.splice(i, 1);
          changed(300);
          paintCards();
          paintPicks();
        });
        return h('li', { class: 'fd-pick' },
          h('div', { class: 'fd-pick-head' },
            h('span', { class: 'fd-pick-title' },
              h('span', { class: 'fd-pick-rank' }, `${ordinal(i)} choice`),
              h('span', { class: 'fd-pick-name' }, x.name),
              x.menuUrl ? h('a', { class: 'fd-pick-menu', href: x.menuUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Menu ↗') : null),
            h('span', { class: 'fd-pick-tools' }, up, x2)),
          h('label', { class: 'fd-sr', for: lid }, `Your order from ${x.name}`),
          textField({ id: lid, get: () => o.lines[id] || '', set: (v) => { o.lines[id] = v; }, placeholder: i === 0 ? 'Your order, e.g. a margherita' : 'Your order from here' }));
      }));
      picksEl.hidden = !o.picks.length;
    };
    paintCards();
    paintPicks();
    return question('What would you like?', [cards, full, picksEl], { help: `Pick up to ${LIMITS.picks}, in order: your first choice counts most. Then write what you’d order.` });
  }

  // ---- what you eat
  function prefsPart() {
    const hid = nextId('fd-h');
    const part = h('section', { class: 'fd-part fd-part-prefs', 'aria-labelledby': hid },
      h('div', { class: 'fd-part-head' }, h('h3', { class: 'fd-part-h', id: hid }, 'What you eat')));

    // Diet, with "Other" opening a line of its own.
    const dietOther = textField({ get: () => st.dietOther, set: (v) => { st.dietOther = v; }, placeholder: 'Tell us more, e.g. keto', label: 'Other diet' });
    dietOther.classList.add('fd-other');
    dietOther.hidden = st.diet !== 'other';
    part.append(question('Diet', [chips({
      values: CHOICES.diet, labels: LABELS.diet, label: 'Diet',
      isOn: (v) => st.diet === v,
      onToggle: (v) => {
        st.diet = st.diet === v ? null : v;
        dietOther.hidden = st.diet !== 'other';
        if (!dietOther.hidden) dietOther.querySelector('input').focus();
        changed(300);
      },
    }), dietOther]));

    part.append(allergyQuestion());

    const avoidId = nextId('fd-f');
    part.append(question('Avoid or dislike', textField({ id: avoidId, multiline: true, get: () => st.avoid, set: (v) => { st.avoid = v; }, placeholder: 'e.g. mushrooms, coriander, anything too sweet' }), { forId: avoidId }));
    const loveId = nextId('fd-f');
    part.append(question('Love: favourite foods and cuisines', textField({ id: loveId, multiline: true, get: () => st.love, set: (v) => { st.love = v; }, placeholder: 'e.g. Ethiopian, anything with lime' }), { forId: loveId }));
    part.append(question('Spice tolerance', chips({
      values: CHOICES.spice, labels: LABELS.spice, label: 'Spice tolerance', className: 'fd-spice', mark: spiceDots,
      isOn: (v) => st.spice === v,
      onToggle: (v) => {
        st.spice = st.spice === v ? null : v;
        changed(300);
      },
    })));
    const favId = nextId('fd-f');
    part.append(question('Favourite non-alcoholic drinks', textField({ id: favId, get: () => st.drinks, set: (v) => { st.drinks = v; }, placeholder: 'e.g. ginger beer, oat flat white' }), { forId: favId }));
    const notesId = nextId('fd-f');
    part.append(question('Anything else the hosts should know', textField({ id: notesId, multiline: true, rows: 3, get: () => st.notes, set: (v) => { st.notes = v; }, placeholder: 'e.g. I’m fasting until sunset, or I’ll bring my own snacks' }), { forId: notesId }));
    // SPEC §20d: off by default; unticking takes the answers out of the list at once.
    const shareId = nextId('fd-share');
    const box = h('input', { type: 'checkbox', id: shareId, class: 'fd-share-box', 'aria-describedby': `${shareId}-help` });
    box.checked = !!st.share;
    box.addEventListener('change', () => {
      st.share = box.checked;
      changed(150);
    });
    part.append(h('div', { class: 'fd-share' },
      box,
      h('label', { for: shareId, class: 'fd-share-label' }, 'Share my answers with other writers here, in case someone’s out of ideas and wants to write about everyone’s food.'),
      h('p', { class: 'fd-share-help', id: `${shareId}-help` }, 'Without your name, in random order. Allergies stay with the hosts. Untick to take them back at once.')));
    return part;
  }

  // Allergies and intolerances: rows of item + how serious + a note; common ones one tap away.
  function allergyQuestion() {
    const listId = nextId('fd-allergens');
    const datalist = h('datalist', { id: listId }, SUGGESTED_ALLERGENS.map((a) => h('option', { value: a })));
    const rowsEl = h('div', { class: 'fd-rows' });
    const quick = h('div', { class: 'fd-quick', role: 'group', 'aria-label': 'Add a common allergen' });
    const tools = h('div', { class: 'fd-row-tools' });
    const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    const has = (label) => st.allergies.findIndex((a) => norm(a.item) === norm(label) || (norm(a.item) && norm(label).startsWith(norm(a.item)) && norm(a.item).length > 3));

    function rowEl(a, i) {
      const item = h('input', { class: 'fd-in fd-row-item', type: 'text', maxlength: LIMITS.text, list: listId, placeholder: 'e.g. peanuts', autocomplete: 'off', 'aria-label': `Allergy or intolerance ${i + 1}` });
      item.value = a.item;
      const sev = h('select', { class: 'fd-in fd-select fd-row-sev', 'aria-label': `How serious is it${a.item ? `: ${a.item}` : ''}?` },
        h('option', { value: '' }, 'How serious?'),
        CHOICES.severity.map((s) => h('option', { value: s }, SEVERITY_OPTION[s])));
      sev.value = a.severity || '';
      const notePh = (sv) => (sv === 'severe' ? 'Note, e.g. carries an EpiPen' : 'Note, e.g. traces are OK');
      const note = h('input', { class: 'fd-in fd-row-note', type: 'text', maxlength: LIMITS.text, placeholder: notePh(a.severity), autocomplete: 'off', 'aria-label': `Note${a.item ? ` about ${a.item}` : ''}` });
      note.value = a.note;
      const x = h('button', { type: 'button', class: 'btn-icon fd-row-x', 'aria-label': `Remove ${a.item || 'this row'}`, title: 'Remove' }, '×');
      const warn = h('p', { class: 'fd-row-warn', hidden: a.severity !== 'severe' }, 'The hosts see severe allergies first, with your name.');
      const row = h('div', { class: `fd-row${a.severity === 'severe' ? ' is-severe' : ''}` },
        h('div', { class: 'fd-row-main' }, item, sev, x), note, warn);
      item.addEventListener('input', () => {
        a.item = clean(item.value, false);
        if (a.item !== item.value) item.value = a.item;
        x.setAttribute('aria-label', `Remove ${a.item || 'this row'}`);
        paintQuick();
        changed(900);
      });
      sev.addEventListener('change', () => {
        a.severity = sev.value || null;
        row.classList.toggle('is-severe', a.severity === 'severe');
        warn.hidden = a.severity !== 'severe';
        note.placeholder = notePh(a.severity);
        changed(300);
      });
      note.addEventListener('input', () => {
        a.note = clean(note.value, false);
        if (a.note !== note.value) note.value = a.note;
        changed(900);
      });
      for (const el of [item, note]) el.addEventListener('blur', () => { if (timer) send(); });
      x.addEventListener('click', () => {
        st.allergies.splice(st.allergies.indexOf(a), 1);
        changed(300);
        paintRows();
        const rows = rowsEl.querySelectorAll('.fd-row-item');
        (rows[Math.min(i, rows.length - 1)] || addBtn).focus({ preventScroll: true });
      });
      return row;
    }
    const addBtn = h('button', { type: 'button', class: 'btn btn-quiet fd-add' }, '+ Add an allergy or intolerance');
    addBtn.addEventListener('click', () => {
      if (st.allergies.length >= LIMITS.allergies) return;
      st.allergies.push({ item: '', severity: null, note: '' });
      st.noAllergies = false;
      paintRows();
      rowsEl.querySelector('.fd-row:last-child .fd-row-item')?.focus();
    });
    const none = h('button', { type: 'button', class: 'fd-chip fd-none', 'aria-pressed': 'false' }, 'None that I know of');
    none.addEventListener('click', () => {
      st.noAllergies = !st.noAllergies;
      none.setAttribute('aria-pressed', String(st.noAllergies));
      changed(300);
    });
    function paintQuick() {
      fill(quick, h('span', { class: 'fd-quick-l' }, 'Common:'), ...SUGGESTED_ALLERGENS.map((label) => {
        const at = has(label);
        const b = h('button', { type: 'button', class: 'fd-chip fd-chip-sm', 'aria-pressed': String(at >= 0), disabled: at < 0 && st.allergies.length >= LIMITS.allergies },
          h('span', { 'aria-hidden': 'true', class: 'fd-plus' }, at >= 0 ? '✓' : '+'), h('span', null, label));
        b.addEventListener('click', () => {
          const j = has(label);
          if (j >= 0) {
            rowsEl.querySelectorAll('.fd-row-sev')[j]?.focus();
            return;
          }
          if (st.allergies.length >= LIMITS.allergies) return;
          st.allergies.push({ item: label, severity: null, note: '' });
          st.noAllergies = false;
          changed(300);
          paintRows();
          rowsEl.querySelector('.fd-row:last-child .fd-row-sev')?.focus();
        });
        return b;
      }));
    }
    function paintRows() {
      fill(rowsEl, ...st.allergies.map(rowEl));
      rowsEl.hidden = !st.allergies.length;
      none.hidden = st.allergies.length > 0;
      none.setAttribute('aria-pressed', String(st.noAllergies && !st.allergies.length));
      addBtn.disabled = st.allergies.length >= LIMITS.allergies;
      addBtn.textContent = st.allergies.length >= LIMITS.allergies ? `That’s the most (${LIMITS.allergies}); use a note for more`
        : st.allergies.length ? '+ Add another' : '+ Add an allergy or intolerance';
      paintQuick();
    }
    fill(tools, addBtn, none);
    paintRows();
    return question('Allergies and intolerances', [datalist, rowsEl, tools, quick], { help: 'One row each, with how serious it is. Add a note if it helps, like “traces are OK”.' });
  }

  function renderAll() {
    orderEl = null;
    fill(body, renderOrder(), prefsPart());
    paintCount();
  }

  const ready = load();
  const api_ = {
    el: root,
    ready,
    // Send anything unsaved now (closing the sheet).
    flush() {
      if (savedSeq !== changeSeq) {
        if (timer || !inflight) send();
        else again = true;
      }
    },
    destroy() {
      if (destroyed) return;
      if (savedSeq !== changeSeq) beacon();
      destroyed = true;
      clearTimeout(timer);
      clearTimeout(retryTimer);
      clearInterval(poll);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('pagehide', beacon);
      document.removeEventListener('visibilitychange', onHide);
    },
    get answers() {
      return st;
    },
    // SPEC §20e: they clicked "Start writing" after the host approved them, and the waiting screen
    // is about to become the writer page. What's typed is sent first (waiting at most 3 s for the
    // answer; if the connection fails it's retried, then sent on leaving), then the writer page gets
    // one "You're in" notice instead of the "Food" row. → a Promise: switch when it resolves.
    async approved() {
      api_.flush();
      await whenSaved(3000);
      if (userId && loaded) showWelcome(userId, foodAnswered(st) ? (foodComplete(st) ? 'complete' : 'partial') : 'blank');
    },
  };
  return api_;
}

// Has the person answered anything at all? (the same fields as lib/food.js isBlank, inverted)
export function foodAnswered(food) {
  const f = normFood(food);
  const o = f.order;
  return !!(f.diet || hasText(f.dietOther) || f.allergies.some((a) => hasText(a.item) || a.severity || hasText(a.note)) || f.noAllergies
    || hasText(f.avoid) || hasText(f.love) || f.spice || hasText(f.drinks) || hasText(f.notes)
    || o.eating || o.hunger || o.picks.length || Object.values(o.lines).some(hasText) || hasText(o.wish) || hasText(o.drinks) || hasText(o.payment));
}
// Are the main parts there: whether they're eating, and if so what they'd like (a pick or words)?
export function foodComplete(food) {
  const f = normFood(food);
  const o = f.order;
  return foodAnswered(f) && !!o.eating && (o.eating === 'no' || o.picks.length > 0 || hasText(o.wish));
}

// ------------------------------------------------------------------ the moment of approval
// SPEC §20e: one notice on the writer page, in the page's flow under its header (the row the
// "Food" nudge uses, so nothing is covered), never taking the focus. Once per account
// and device. The server's own "You're approved" notice (notify.js) would say the same thing a
// second time, so it's closed (through its own ×) while this one shows.
const keyOn = (k) => {
  try {
    return !!localStorage.getItem(k);
  } catch {
    return false;
  }
};
const keySet = (k) => {
  try {
    localStorage.setItem(k, '1');
  } catch { /* private mode */ }
};
export async function showWelcome(uid, state) {
  const once = `wh-food-welcome:${uid}`;
  if (keyOn(once)) return null;
  keySet(`wh-food-nudge:${uid}`); // this notice replaces the "Food" row
  const phaseP = api('/api/session').then((r) => r?.party?.phase || null, () => null);
  // The writer page mounts a moment after the switch.
  let after = null;
  for (let i = 0; i < 150 && !after; i++) {
    after = document.querySelector('.w-app > .w-banner');
    if (!after) await new Promise((r) => setTimeout(r, 100));
  }
  if (!after || keyOn(once)) return null;
  const phase = await Promise.race([phaseP, new Promise((r) => setTimeout(() => r(null), 3000))]);
  if (!after.isConnected) return null;
  keySet(once);
  const grid = after.parentElement;
  const title = phase === 'lobby' ? 'You’re in. Writing starts when the host starts the party.' : 'You’re in: writing starts now.';
  const body = state === 'complete' ? null
    : state === 'partial' ? 'Your food answers are saved; finish them any time from the menu → Food preferences.'
      : 'Tell the hosts what you’d like to eat any time from the menu → Food preferences.';
  const x = h('button', { type: 'button', class: 'fd-welcome-x', 'aria-label': 'Dismiss', title: 'Dismiss' }, '×');
  const open = body ? h('button', { type: 'button', class: 'btn-link fd-welcome-go' }, 'Open food preferences') : null;
  const el = h('div', { class: 'fd-nudge fd-welcome', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
    h('div', { class: 'fd-welcome-in' },
      h('p', { class: 'fd-welcome-k' }, 'Writehaven'),
      h('p', { class: 'fd-welcome-t' }, title),
      body ? h('p', { class: 'fd-welcome-b' }, body) : null,
      open ? h('p', { class: 'fd-welcome-actions' }, open) : null,
      x));
  let watch = null;
  let stopAt = 0;
  function remove() {
    watch?.disconnect();
    el.remove();
    grid.classList.remove('has-fd-nudge');
  }
  x.addEventListener('click', (e) => {
    remove();
    if (e.detail === 0) document.querySelector('.w-me')?.focus({ preventScroll: true }); // from the keyboard
  });
  open?.addEventListener('click', () => {
    remove();
    openFoodSheet({ returnFocus: document.querySelector('.w-me') });
  });
  after.after(el);
  grid.classList.add('has-fd-nudge');
  // notify.js's "You're approved — come and write", now or in the next few seconds: close it.
  const closeTheirs = () => {
    if (Date.now() > stopAt || !el.isConnected) {
      watch?.disconnect();
      return;
    }
    for (const b of document.querySelectorAll('.nt-banner.nt-k-approved .nt-x')) b.click();
  };
  stopAt = Date.now() + 60_000;
  if (typeof MutationObserver === 'function') {
    watch = new MutationObserver(closeTheirs);
    watch.observe(document.body, { childList: true });
  }
  closeTheirs();
  return { el, remove };
}

// ------------------------------------------------------------------ the sheet
// openFoodSheet(): the form in a side sheet (desktop) or a full-height sheet (phone), for the
// writer menu and the lobby. Escape, the scrim, × and Done close it; anything unsaved is sent.
let sheet = null;
export function openFoodSheet(opts = {}) {
  if (sheet && !sheet.closing) {
    if (opts.view) sheet.showView(opts.view);
    sheet.focus();
    return { close: sheet.close };
  }
  const opener = opts.returnFocus || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const title = h('h2', { class: 'fd-sheet-title', id: 'fd-sheet-title', tabindex: '-1' }, 'Food preferences');
  const xBtn = h('button', { class: 'btn-icon fd-sheet-x', type: 'button', 'aria-label': 'Close' }, '×');
  const kicker = h('p', { class: 'fd-sheet-kicker' });
  const lede = h('p', { class: 'fd-sheet-lede' });
  // SPEC §20d: "Everyone's food", the answers people chose to share, in the same sheet.
  const toEveryone = h('button', { class: 'btn-link fd-sheet-switch', type: 'button', hidden: true }, 'Everyone’s food →');
  const toMine = h('button', { class: 'btn-link fd-sheet-switch', type: 'button', hidden: true }, '← Your answers');
  const head = h('header', { class: 'fd-sheet-head' },
    h('div', null, kicker, title, lede, toEveryone, toMine),
    xBtn);
  const holder = h('div', { class: 'fd-sheet-form' });
  const everyone = h('div', { class: 'fd-ev', hidden: true, 'aria-live': 'polite' });
  const scroller = h('div', { class: 'fd-sheet-scroll' }, holder, everyone);
  const statusSlot = h('div', { class: 'fd-sheet-status' });
  const done = h('button', { class: 'btn btn-primary fd-sheet-done', type: 'button' }, 'Done');
  const foot = h('footer', { class: 'fd-sheet-foot' }, statusSlot, done);
  const dlg = h('dialog', { class: 'fd-sheet', 'aria-labelledby': 'fd-sheet-title' }, h('div', { class: 'fd-sheet-in' }, head, scroller, foot));
  const self = { closing: false };
  document.body.append(dlg);
  document.documentElement.classList.add('fd-open');
  dlg.showModal();
  title.focus({ preventScroll: true });
  dlg.getBoundingClientRect();
  dlg.classList.add('is-open');
  const form = renderFoodForm(holder, { compact: true, statusIn: statusSlot });
  let canSee = false;
  function showView(v) {
    const ev = v === 'everyone';
    holder.hidden = ev;
    everyone.hidden = !ev;
    statusSlot.hidden = ev;
    title.textContent = ev ? 'Everyone’s food' : 'Food preferences';
    kicker.textContent = ev ? 'Shared by writers here, without names' : 'Hosts only, unless you share them';
    lede.textContent = ev
      ? 'What people chose to share, in random order. Out of ideas? There may be a post in here.'
      : 'So the hosts can feed everyone well. Everything is optional and saves as you go.';
    toEveryone.hidden = ev || !canSee;
    toMine.hidden = !ev;
    scroller.scrollTop = 0;
    if (ev) loadEveryone(everyone);
  }
  toEveryone.addEventListener('click', () => {
    showView('everyone');
    toMine.focus({ preventScroll: true });
  });
  toMine.addEventListener('click', () => {
    showView('form');
    title.focus({ preventScroll: true });
  });
  form.ready.then(() => {
    canSee = !!form.sharedOk;
    if (holder.hidden === false) toEveryone.hidden = !canSee;
  });
  self.showView = showView;
  showView(opts.view === 'everyone' ? 'everyone' : 'form');

  function finish() {
    if (self.finished) return;
    self.finished = true;
    form.flush();
    form.destroy();
    if (dlg.open) dlg.close();
    dlg.remove();
    document.documentElement.classList.remove('fd-open');
    if (sheet === self) sheet = null;
    if (opener && opener.isConnected) {
      try {
        opener.focus({ preventScroll: true });
      } catch { /* gone */ }
    }
    try {
      opts.onClose?.();
    } catch (e) {
      console.error(e);
    }
  }
  function close() {
    if (self.closing) return;
    self.closing = true;
    form.flush();
    dlg.classList.remove('is-open');
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      finish();
      return;
    }
    dlg.addEventListener('transitionend', (e) => { if (e.target === dlg) finish(); });
    setTimeout(finish, 420);
  }
  self.close = close;
  self.focus = () => title.focus({ preventScroll: true });
  xBtn.addEventListener('click', close);
  done.addEventListener('click', close);
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  dlg.addEventListener('close', finish);
  let downOutside = false;
  dlg.addEventListener('pointerdown', (e) => { downOutside = e.target === dlg; });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg && downOutside) close();
    downOutside = false;
  });
  // Tab and Shift+Tab stay inside the sheet.
  dlg.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const f = [...dlg.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter((x) => x.offsetParent !== null || x === document.activeElement);
    if (!f.length) return;
    const i = f.indexOf(document.activeElement);
    if (e.shiftKey && i <= 0) {
      e.preventDefault();
      f[f.length - 1].focus();
    } else if (!e.shiftKey && i === f.length - 1) {
      e.preventDefault();
      f[0].focus();
    }
  });
  scroller.addEventListener('scroll', () => head.classList.toggle('is-scrolled', scroller.scrollTop > 2), { passive: true });
  sheet = self;
  return { close };
}

export function openEveryonesFood(opts = {}) {
  return openFoodSheet({ ...opts, view: 'everyone' });
}

// "Out of ideas? Read everyone's food answers": one small link, e.g. under the writer's
// brainstorm hint. Added once per container.
export function mountFoodIdeasLink(container) {
  if (!container || container.querySelector('.fd-ideas-link')) return null;
  const b = h('button', { class: 'btn-link fd-ideas-link', type: 'button' }, 'Out of ideas? Read everyone’s food answers');
  b.addEventListener('click', () => openEveryonesFood({ returnFocus: b }));
  container.append(b);
  return b;
}

// The shared answers, fresh (and freshly shuffled) each time.
async function loadEveryone(el) {
  fill(el, h('p', { class: 'fd-none-yet' }, 'Opening everyone’s answers…'));
  let r;
  try {
    r = await api('/api/food/shared');
  } catch (e) {
    fill(el, h('p', { class: 'fd-none-yet' }, e.status === 404 ? 'These open once the host has approved your account.' : e.network ? 'You seem to be offline. Try again when you’re back.' : 'Couldn’t open everyone’s answers. Try again in a moment.'));
    return;
  }
  const list = Array.isArray(r?.answers) ? r.answers : [];
  if (!list.length) {
    fill(el, h('p', { class: 'fd-none-yet' }, 'Nobody has shared their answers yet. Tick “Share my answers” in yours to be the first.'));
    return;
  }
  const again = list.length > 1 ? h('button', { class: 'btn-link fd-ev-again', type: 'button' }, 'Shuffle') : null;
  again?.addEventListener('click', () => loadEveryone(el));
  const item = (label, text) => (hasText(text) ? h('div', { class: 'fd-ev-row' }, h('dt', null, label), h('dd', null, text)) : null);
  fill(el,
    h('p', { class: 'fd-ev-count' }, `${list.length === 1 ? '1 person has' : `${list.length} people have`} shared their answers. `, again),
    h('ul', { class: 'fd-ev-list' }, list.map((a) => h('li', { class: 'fd-ev-card' },
      a.diet ? h('p', { class: 'fd-ev-diet' }, a.diet) : null,
      h('dl', null,
        item('Loves', a.love),
        item('Avoids', a.avoid),
        item('Order', Array.isArray(a.order) ? a.order.filter(hasText).join('\n') : ''),
        item('Drinks to order', a.orderDrinks),
        item('Favourite drinks', a.drinks),
        item('Also', a.notes))))));
}

// ------------------------------------------------------------------ the host's view
// What to flag next to someone's order line: severe allergies first, then other allergies and
// intolerances, then a diet or rule a kitchen must know.
export function flagsOf(food) {
  if (!food) return [];
  const out = [];
  const rows = [...(food.allergies || [])].sort((a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0));
  for (const a of rows) {
    const item = a.item || 'unspecified';
    if (a.severity === 'severe') out.push({ kind: 'severe', text: `Severe allergy: ${item}`, item, note: a.note || '' });
    else out.push({ kind: a.severity === 'preference' ? 'pref' : 'allergy', text: a.severity ? `${item} (${LABELS.severity[a.severity].toLowerCase()})` : item, note: a.note || '' });
  }
  if (food.diet && !['omnivore', 'flexitarian'].includes(food.diet)) out.push({ kind: 'diet', text: food.diet === 'other' ? food.dietOther || 'other diet' : LABELS.diet[food.diet].toLowerCase() });
  return out;
}
const flagText = (f) => (f.kind === 'severe' ? `SEVERE ALLERGY: ${f.item}${f.note ? ` (${f.note})` : ''}` : f.text);

// The order list: everyone eating, each under the first of their picks among `chosen` (all
// options by default), with their order line and flags; the rest under "not placed".
export function orderList(people, order, chosen = null) {
  const setup = normSetup(order);
  const byId = new Map(setup.options.map((o) => [o.id, o]));
  const use = new Set(chosen ? [...chosen].filter((id) => byId.has(id)) : byId.keys());
  const groups = setup.options.filter((o) => use.has(o.id)).map((o) => ({ option: o, lines: [] }));
  const groupOf = new Map(groups.map((g) => [g.option.id, g]));
  const unplaced = [];
  const drinks = [];
  for (const p of people || []) {
    if (p.approval === 'declined' || !p.food || Number.isFinite(p.leftAt)) continue; // left the party: no food (SPEC §33)
    const f = normFood(p.food);
    const o = f.order;
    if (o.eating === 'no') continue;
    const answeredOrder = o.eating || o.picks.length || hasText(o.wish) || hasText(o.drinks);
    if (!answeredOrder) continue;
    const entry = { id: p.id, name: p.name, eating: o.eating, hunger: o.hunger, flags: flagsOf(f) };
    if (hasText(o.drinks)) drinks.push({ name: p.name, text: o.drinks });
    const at = o.picks.findIndex((id) => use.has(id));
    if (at >= 0) {
      const id = o.picks[at];
      groupOf.get(id).lines.push({ ...entry, rank: at + 1, line: o.lines[id] || '' });
    } else {
      unplaced.push({ ...entry, wish: o.wish, picks: o.picks.map((id) => byId.get(id)?.name).filter(Boolean) });
    }
  }
  const extras = (e) => [e.eating === 'snack' ? 'just a snack' : null, e.hunger === 'very' ? 'very hungry' : e.hunger === 'light' ? 'light appetite' : null].filter(Boolean);
  const lineText = (e, what) => {
    const bits = [...extras(e), ...e.flags.map(flagText)];
    return `- ${e.name}: ${what}${bits.length ? ` · ${bits.join(' · ')}` : ''}`;
  };
  const out = [];
  const used = groups.filter((g) => g.lines.length);
  out.push(used.length ? `Food order: ${used.map((g) => g.option.name).join(', ')}` : 'Food order');
  if (setup.deadline) out.push(`Orders close at ${setup.deadline}`);
  for (const g of groups) {
    if (!g.lines.length) continue;
    out.push('', `${g.option.name} (${g.lines.length})`);
    if (g.option.menuUrl) out.push(`Menu: ${g.option.menuUrl}`);
    for (const e of g.lines) out.push(lineText(e, e.line || '(no order written yet)'));
  }
  if (unplaced.length) {
    out.push('', setup.options.length ? `Not placed yet (${unplaced.length})` : `What people would like (${unplaced.length})`);
    for (const e of unplaced) {
      const what = hasText(e.wish) ? e.wish : e.picks.length ? `picked ${e.picks.join(', ')}` : '(no choice yet)';
      out.push(lineText(e, what));
    }
  }
  if (drinks.length) {
    out.push('', `Drinks (${drinks.length})`);
    for (const d of drinks) out.push(`- ${d.name}: ${d.text}`);
  }
  return { groups, unplaced, drinks, text: `${out.join('\n')}\n` };
}

async function copyText(text, { title = 'Copy the order list' } = {}) {
  // Called straight from the click, so the browser allows the clipboard.
  try {
    if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
    await navigator.clipboard.writeText(text);
    toast('Order list copied');
    return true;
  } catch {
    const ta = h('textarea', { class: 'fd-in fd-copy-ta', readonly: true, rows: 12, 'aria-label': 'The order list' });
    ta.value = text;
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
    const m = modal({
      title, className: 'fd-copy-modal',
      body: h('div', { class: 'modal-body' }, h('p', null, `It’s selected: press ${isMac ? '⌘C' : 'Ctrl+C'} to copy it, or long-press and choose Copy.`), ta),
      actions: [{ label: 'Done', primary: true }],
    });
    requestAnimationFrame(() => {
      ta.focus();
      ta.select();
      try {
        if (document.execCommand('copy')) toast('Order list copied');
      } catch { /* the selection is there to copy by hand */ }
    });
    return m;
  }
}

function downloadCsv() {
  const a = h('a', { href: '/api/host/food.csv', download: '', hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
}

function confirmReset(answered) {
  return new Promise((resolve) => {
    const input = h('input', { class: 'fd-in fd-reset-in', type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', 'aria-describedby': 'fd-reset-help' });
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const m = modal({
      title: 'Reset the food order answers?',
      className: 'modal-confirm fd-reset-modal',
      body: h('div', { class: 'modal-body' },
        h('p', null, h('b', null, 'This clears, for everyone: '), 'whether they’re eating with us, how hungry, their picks, their order, drinks for the order and payment notes', answered ? ` (${answered === 1 ? '1 person has' : `${answered} people have`} order answers now)` : '', '.'),
        h('p', null, h('b', null, 'It keeps: '), 'diet, allergies (and “none that I know of”), dislikes, favourites, spice, favourite drinks, anything else they told you, and sharing. Writers see those already filled in. Your order options and deadline stay too.'),
        h('p', null, 'Everyone’s answers as they are now are saved in the food history first, and a CSV of them is downloading.'),
        h('label', { class: 'fd-reset-label', id: 'fd-reset-help' }, h('span', null, 'Type ', h('b', null, 'RESET'), ' to confirm'), input)),
      onClose: () => finish(false),
      actions: [
        { label: 'Cancel', quiet: true, onClick: () => finish(false) },
        { label: 'Reset order answers', danger: true, id: 'fd-reset-go', onClick: () => (input.value.trim().toUpperCase() === 'RESET' ? finish(true) : false) },
      ],
    });
    const go = m.el.querySelector('#fd-reset-go');
    go.disabled = true;
    input.addEventListener('input', () => { go.disabled = input.value.trim().toUpperCase() !== 'RESET'; });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !go.disabled) go.click();
    });
    requestAnimationFrame(() => input.focus());
  });
}

const pct = (n, max) => `${max ? Math.round((n / max) * 100) : 0}%`;
function tally(entries, { cls = '' } = {}) {
  const max = Math.max(1, ...entries.map((e) => e.n));
  return h('ul', { class: `fd-tally ${cls}` }, entries.map((e) => h('li', { class: `fd-tally-row${e.n ? '' : ' is-zero'}` },
    h('span', { class: 'fd-tally-l' }, e.label),
    h('span', { class: 'fd-tally-bar', 'aria-hidden': 'true' }, h('i', { style: { width: pct(e.n, max) } })),
    h('span', { class: 'fd-tally-n' }, String(e.n)))));
}
function whoSaid(list, { empty = null } = {}) {
  if (!list.length) return empty ? h('p', { class: 'fd-none-yet' }, empty) : null;
  return h('ul', { class: 'fd-said' }, list.map((x) => h('li', null, h('b', null, x.name), h('span', null, x.text))));
}
function flagPills(flags) {
  return flags.map((f) => h('span', { class: `fd-flag fd-flag-${f.kind}`, title: f.note || null }, f.text, f.kind === 'severe' && f.note ? h('span', { class: 'fd-flag-note' }, ` · ${f.note}`) : null));
}
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// renderFoodSummary(container, data): the host's Food card, from GET /api/host/food. Keeps its
// own UI state (open sections, which options are being ordered, the setup editor) across renders.
export function renderFoodSummary(container, data, opts = {}) {
  const heading = opts.heading !== false;
  const ui = (container.__fdSum ||= { chosen: null, peopleOpen: false, setupOpen: false, draft: null, busy: false });
  const reload = opts.onReload || (async () => {
    const fresh = await api('/api/host/food');
    renderFoodSummary(container, fresh, opts);
  });
  ui.reload = reload;
  const s = data.summary;
  const order = normSetup(data.order);
  const people = data.people || [];
  if (!ui.chosen) ui.chosen = new Set(order.options.map((o) => o.id));
  for (const o of order.options) if (!ui.known?.has(o.id)) ui.chosen.add(o.id); // new options start chosen
  ui.known = new Set(order.options.map((o) => o.id));

  const csv = h('a', { class: 'btn fd-csv', href: '/api/host/food.csv', download: '' }, 'Download CSV');
  const head = h('header', { class: `fd-sum-head${heading ? '' : ' is-bare'}` },
    h('div', { class: 'fd-sum-title' },
      heading ? h('h2', null, 'Food') : null,
      h('p', { class: 'fd-sum-sub' }, s.people ? `${s.answered} of ${s.people} answered · hosts only, except what people chose to share` : 'Nobody has signed up yet')),
    h('div', { class: 'fd-sum-actions' }, csv));

  // Severe allergies, by person, at the very top.
  const severe = s.severe.length ? h('section', { class: 'fd-severe', 'aria-label': 'Severe allergies' },
    h('h3', null, h('span', { class: 'fd-severe-mark', 'aria-hidden': 'true' }, '!'), `Severe ${s.severe.length === 1 ? 'allergy' : 'allergies'}`),
    h('ul', null, groupSevere(s.severe).map((g) => h('li', null,
      h('b', { class: 'fd-severe-item' }, g.label),
      h('span', { class: 'fd-severe-who' }, g.people.map((p, i) => [i ? ', ' : '', h('span', { class: 'fd-severe-name' }, p.name), p.note ? h('span', { class: 'fd-severe-note' }, ` (${p.note})`) : null])))))) : null;

  const card = h('div', { class: 'fd-sum' }, head, severe, orderSection(), prefsSection(), missingSection(), peopleSection(), resetSection());
  fill(container, card);
  return { reload };

  // ---- the food order
  function orderSection() {
    const e = s.order.eating;
    const sec = h('section', { class: 'fd-sec fd-sec-order', 'aria-label': 'Food order' });
    const setupBtn = h('button', { type: 'button', class: 'btn-link fd-setup-open', 'aria-expanded': String(ui.setupOpen) }, order.options.length || order.deadline || hasText(order.note) ? 'Change options' : 'Set up options');
    setupBtn.addEventListener('click', () => {
      ui.setupOpen = !ui.setupOpen;
      ui.draft = ui.setupOpen ? JSON.parse(JSON.stringify(order)) : null;
      renderFoodSummary(container, data, opts);
      if (ui.setupOpen) container.querySelector('.fd-setup input')?.focus();
    });
    sec.append(h('div', { class: 'fd-sec-head' },
      h('h3', { class: 'fd-sec-h' }, 'Food order'),
      order.deadline ? h('span', { class: 'fd-sec-meta' }, `Orders close at ${order.deadline}`) : null,
      setupBtn));
    if (ui.setupOpen) sec.append(setupEditor());
    else if (hasText(order.note)) sec.append(h('p', { class: 'fd-host-note' }, order.note));
    sec.append(h('p', { class: 'fd-eating' },
      h('span', null, h('b', null, String(e.yes)), ' eating with us'),
      h('span', null, h('b', null, String(e.snack)), ' snack'),
      h('span', null, h('b', null, String(e.no)), ' not eating'),
      e.unanswered ? h('span', { class: 'is-muted' }, h('b', null, String(e.unanswered)), ' not answered') : null));
    const hu = s.order.hunger;
    if (hu.light + hu.normal + hu.very) sec.append(h('p', { class: 'fd-hunger' }, 'Hunger: ', [`${hu.light} light`, `${hu.normal} normal`, `${hu.very} very hungry`].join(' · ')));
    if (order.options.length && !s.order.votes.some((v) => v.count)) {
      sec.append(h('div', { class: 'fd-votes-wrap' }, h('p', { class: 'fd-mini-h' }, 'Votes'), h('p', { class: 'fd-none-yet' }, 'No votes yet.')));
    } else if (order.options.length) {
      const votes = s.order.votes;
      const max = Math.max(1, ...votes.map((v) => v.points));
      sec.append(h('div', { class: 'fd-votes-wrap' },
        h('p', { class: 'fd-mini-h' }, 'Votes', h('span', { class: 'fd-mini-note' }, ' · 1st choice 3 points, 2nd 2, 3rd 1')),
        h('ol', { class: 'fd-votes' }, votes.map((v) => {
          const opt = order.options.find((o) => o.id === v.id);
          return h('li', { class: 'fd-vote' },
            h('span', { class: 'fd-vote-name' }, v.name, opt?.menuUrl ? h('a', { class: 'fd-vote-menu', href: opt.menuUrl, target: '_blank', rel: 'noopener noreferrer' }, 'menu ↗') : null),
            h('span', { class: 'fd-tally-bar', 'aria-hidden': 'true' }, h('i', { style: { width: pct(v.points, max) } })),
            h('span', { class: 'fd-vote-pts' }, plural(v.points, 'point')),
            h('span', { class: 'fd-vote-raw' }, `${plural(v.count, 'pick')} · ${v.first} first`));
        }))));
    }
    sec.append(orderListBlock());
    if (s.order.payment.length) sec.append(h('div', { class: 'fd-block' }, h('p', { class: 'fd-mini-h' }, 'Payment notes'), whoSaid(s.order.payment)));
    return sec;
  }

  function orderListBlock() {
    const block = h('div', { class: 'fd-block fd-olist-wrap' });
    const paint = () => {
      const list = orderList(people, order, ui.chosen);
      const copy = h('button', { type: 'button', class: 'btn btn-primary fd-copy' }, 'Copy order list');
      copy.addEventListener('click', () => copyText(orderList(people, order, ui.chosen).text));
      const choose = order.options.length > 1 ? h('div', { class: 'fd-choose', role: 'group', 'aria-label': 'Ordering from' },
        h('span', { class: 'fd-choose-l' }, 'Ordering from'),
        order.options.map((o) => {
          const b = h('button', { type: 'button', class: 'fd-chip fd-chip-sm', 'aria-pressed': String(ui.chosen.has(o.id)) }, o.name);
          b.addEventListener('click', () => {
            if (ui.chosen.has(o.id)) ui.chosen.delete(o.id);
            else ui.chosen.add(o.id);
            paint();
            block.querySelectorAll('.fd-choose .fd-chip')[order.options.indexOf(o)]?.focus();
          });
          return b;
        })) : null;
      const empty = !list.groups.some((g) => g.lines.length) && !list.unplaced.length;
      fill(block,
        h('div', { class: 'fd-olist-head' }, h('p', { class: 'fd-mini-h' }, 'Order list'), copy),
        choose,
        empty ? h('p', { class: 'fd-none-yet' }, 'No orders yet. They appear here as people answer.') : null,
        ...(empty ? [] : list.groups).map((g) => h('section', { class: 'fd-ogroup' },
          h('h4', null, g.option.name, h('span', { class: 'fd-ogroup-n' }, ` · ${g.lines.length}`)),
          g.lines.length ? h('ul', null, g.lines.map((e) => h('li', { class: 'fd-oline' },
            h('span', { class: 'fd-oline-who' }, e.name, e.eating === 'snack' ? h('span', { class: 'fd-oline-x' }, ' · snack') : null, e.hunger === 'very' ? h('span', { class: 'fd-oline-x' }, ' · very hungry') : e.hunger === 'light' ? h('span', { class: 'fd-oline-x' }, ' · light') : null),
            h('span', { class: `fd-oline-what${e.line ? '' : ' is-empty'}` }, e.line || 'no order written yet'),
            e.flags.length ? h('span', { class: 'fd-flags' }, flagPills(e.flags)) : null)))
            : h('p', { class: 'fd-none-yet' }, 'Nobody’s first pick yet.'))),
        list.unplaced.length ? h('section', { class: 'fd-ogroup is-unplaced' },
          h('h4', null, order.options.length ? 'Not placed yet' : 'What people would like', h('span', { class: 'fd-ogroup-n' }, ` · ${list.unplaced.length}`)),
          h('ul', null, list.unplaced.map((e) => h('li', { class: 'fd-oline' },
            h('span', { class: 'fd-oline-who' }, e.name, e.eating === 'snack' ? h('span', { class: 'fd-oline-x' }, ' · snack') : null),
            h('span', { class: `fd-oline-what${hasText(e.wish) ? '' : ' is-empty'}` }, hasText(e.wish) ? e.wish : e.picks.length ? `picked ${e.picks.join(', ')}` : 'no choice yet'),
            e.flags.length ? h('span', { class: 'fd-flags' }, flagPills(e.flags)) : null)))) : null,
        list.drinks.length ? h('section', { class: 'fd-ogroup is-drinks' },
          h('h4', null, 'Drinks for the order', h('span', { class: 'fd-ogroup-n' }, ` · ${list.drinks.length}`)),
          whoSaid(list.drinks)) : null,
        s.left?.length ? h('p', { class: 'fd-left' }, 'Left the party, not in this order: ', s.left.map((x) => x.name).join(', ')) : null);
    };
    paint();
    return block;
  }

  // The hosts' options for the order: name, note, menu link; a deadline; a line for everyone.
  function setupEditor() {
    const d = ui.draft;
    const err = h('p', { class: 'fd-err', role: 'alert' });
    const rows = h('div', { class: 'fd-setup-rows' });
    const paintRows = () => fill(rows, ...d.options.map((o, i) => {
      const name = h('input', { class: 'fd-in fd-setup-name', type: 'text', maxlength: LIMITS.name, placeholder: 'e.g. Pizza — Franco Manca', 'aria-label': `Option ${i + 1}: name` });
      name.value = o.name;
      name.addEventListener('input', () => { o.name = name.value; });
      const note = h('input', { class: 'fd-in fd-setup-note', type: 'text', maxlength: LIMITS.text, placeholder: 'Note, e.g. vegan cheese on request', 'aria-label': `Option ${i + 1}: note` });
      note.value = o.note;
      note.addEventListener('input', () => { o.note = note.value; });
      const url = h('input', { class: 'fd-in fd-setup-url', type: 'url', inputmode: 'url', maxlength: 500, placeholder: 'Menu link (https://…)', 'aria-label': `Option ${i + 1}: menu link` });
      url.value = o.menuUrl;
      url.addEventListener('input', () => { o.menuUrl = url.value; });
      const x = h('button', { type: 'button', class: 'btn-icon', 'aria-label': `Remove option ${o.name || i + 1}`, title: 'Remove' }, '×');
      x.addEventListener('click', () => {
        d.options.splice(i, 1);
        paintRows();
        paintAdd();
      });
      return h('div', { class: 'fd-setup-row' }, h('span', { class: 'fd-setup-n', 'aria-hidden': 'true' }, String(i + 1)), name, x, note, url);
    }));
    const add = h('button', { type: 'button', class: 'btn btn-quiet fd-add' }, '+ Add an option');
    const paintAdd = () => { add.disabled = d.options.length >= LIMITS.options; };
    add.addEventListener('click', () => {
      d.options.push({ id: '', name: '', note: '', menuUrl: '' });
      paintRows();
      paintAdd();
      rows.querySelector('.fd-setup-row:last-child input')?.focus();
    });
    const dl = h('input', { class: 'fd-in fd-time', type: 'time', id: 'fd-setup-deadline' });
    dl.value = d.deadline || '';
    dl.addEventListener('input', () => { d.deadline = dl.value || null; });
    const note = h('textarea', { class: 'fd-in fd-ta', rows: 2, maxlength: LIMITS.text, id: 'fd-setup-note', placeholder: 'e.g. We’ll order at 18:30 and split the bill. Pay the host back on the night.' });
    note.value = d.note || '';
    note.addEventListener('input', () => { d.note = note.value; grow(note); });
    const save = h('button', { type: 'button', class: 'btn btn-primary' }, 'Save');
    const cancel = h('button', { type: 'button', class: 'btn btn-quiet' }, 'Cancel');
    cancel.addEventListener('click', () => {
      ui.setupOpen = false;
      ui.draft = null;
      renderFoodSummary(container, data, opts);
    });
    save.addEventListener('click', async () => {
      err.textContent = '';
      save.disabled = true;
      try {
        await api('/api/host/food/options', { options: d.options, deadline: d.deadline || null, note: d.note || '' }, { method: 'PUT' });
        ui.setupOpen = false;
        ui.draft = null;
        toast('Food order options saved');
        await reload();
      } catch (ex) {
        save.disabled = false;
        err.textContent = ex.network ? 'You seem to be offline. Nothing was saved; try again.' : ex.message || 'Couldn’t save that.';
      }
    });
    paintRows();
    paintAdd();
    requestAnimationFrame(() => grow(note));
    return h('div', { class: 'fd-setup' },
      h('p', { class: 'fd-q-help' }, 'Add the places you might order from, and everyone can pick up to 3 and write their order. With no options, people just write what they’d like.'),
      rows, add,
      h('div', { class: 'fd-setup-more' },
        h('label', { class: 'fd-q-label', for: 'fd-setup-deadline' }, h('span', null, 'Orders close at ', h('span', { class: 'fd-opt-l' }, '(optional)')), dl),
        h('label', { class: 'fd-q-label', for: 'fd-setup-note' }, h('span', null, 'A line for everyone ', h('span', { class: 'fd-opt-l' }, '(optional)')), note)),
      err,
      h('div', { class: 'fd-setup-actions' }, cancel, save));
  }

  // ---- what people eat
  function prefsSection() {
    const sec = h('section', { class: 'fd-sec fd-sec-prefs', 'aria-label': 'Diets and allergies' });
    const allergies = s.allergies.length ? h('ul', { class: 'fd-agroups' }, s.allergies.map((g) => h('li', { class: `fd-agroup is-${g.maxSeverity || 'unknown'}` },
      h('div', { class: 'fd-agroup-head' },
        h('span', { class: 'fd-agroup-item' }, g.label),
        g.maxSeverity ? h('span', { class: `fd-sev fd-sev-${g.maxSeverity}` }, LABELS.severity[g.maxSeverity]) : null,
        h('span', { class: 'fd-agroup-n' }, String(g.count))),
      h('ul', { class: 'fd-agroup-people' }, g.people.map((p) => h('li', null,
        h('b', null, p.name),
        h('span', null, [p.severity ? LABELS.severity[p.severity].toLowerCase() : 'severity not given', p.note, norm(p.item) !== norm(g.label) && p.item ? `“${p.item}”` : null].filter(Boolean).join(' · ')))))))) : h('p', { class: 'fd-none-yet' }, 'No allergies or intolerances so far.');
    const dietEntries = CHOICES.diet.map((k) => ({ label: LABELS.diet[k], n: s.diet[k] }));
    fill(sec,
      h('div', { class: 'fd-sec-head' }, h('h3', { class: 'fd-sec-h' }, 'Allergies and intolerances'),
        s.noAllergies ? h('span', { class: 'fd-sec-meta' }, `${s.noAllergies} said none`) : null),
      allergies,
      h('div', { class: 'fd-grid' },
        h('div', { class: 'fd-block' }, h('p', { class: 'fd-mini-h' }, 'Diet'), tally(dietEntries), whoSaid(s.dietOther)),
        h('div', { class: 'fd-block' }, h('p', { class: 'fd-mini-h' }, 'Spice tolerance'), tally(CHOICES.spice.map((k) => ({ label: LABELS.spice[k], n: s.spice[k] })), { cls: 'fd-tally-spice' }))),
      s.avoid.length || s.love.length || s.drinks.length || s.notes.length ? h('div', { class: 'fd-grid' },
        s.avoid.length ? h('div', { class: 'fd-block' }, h('p', { class: 'fd-mini-h' }, 'Avoid or dislike'), whoSaid(s.avoid)) : null,
        s.love.length ? h('div', { class: 'fd-block' }, h('p', { class: 'fd-mini-h' }, 'Loves'), whoSaid(s.love)) : null,
        s.drinks.length ? h('div', { class: 'fd-block' }, h('p', { class: 'fd-mini-h' }, 'Favourite drinks'), whoSaid(s.drinks)) : null,
        s.notes.length ? h('div', { class: 'fd-block' }, h('p', { class: 'fd-mini-h' }, 'Anything else'), whoSaid(s.notes)) : null) : null);
    return sec;
  }

  function missingSection() {
    if (!s.notAnswered.length) return s.people ? h('p', { class: 'fd-all-in' }, 'Everyone has answered.') : null;
    return h('section', { class: 'fd-sec fd-missing', 'aria-label': 'Not answered yet' },
      h('p', null, h('b', null, `Not answered yet (${s.notAnswered.length}): `),
        s.notAnswered.map((p, i) => [i ? ', ' : '', p.name, p.approval === 'pending' ? h('span', { class: 'fd-muted' }, ' (waiting for approval)') : p.isHost ? h('span', { class: 'fd-muted' }, ' (host)') : null])));
  }

  function peopleSection() {
    const det = h('details', { class: 'fd-people', open: ui.peopleOpen });
    det.addEventListener('toggle', () => { ui.peopleOpen = det.open; });
    const optName = new Map(order.options.map((o) => [o.id, o.name]));
    const rows = people.map((p) => {
      const f = p.food ? normFood(p.food) : null;
      const o = f?.order;
      const cell = (v, cls = '') => h('td', { class: cls }, v || h('span', { class: 'fd-muted' }, '—'));
      if (!f) {
        return h('tr', { class: `is-blank${p.approval === 'declined' ? ' is-declined' : ''}` },
          h('th', { scope: 'row' }, p.name, p.approval !== 'approved' ? h('span', { class: 'fd-muted' }, ` · ${p.approval}`) : null, Number.isFinite(p.leftAt) ? h('span', { class: 'fd-muted' }, ' (left)') : null),
          h('td', { colspan: 10, class: 'fd-muted' }, 'Not answered yet'));
      }
      const orderBits = o.picks.map((id, i) => `${i + 1}. ${optName.get(id) || 'removed option'}${o.lines[id] ? `: ${o.lines[id]}` : ''}`);
      if (hasText(o.wish)) orderBits.push(o.wish);
      return h('tr', { class: p.approval === 'declined' ? 'is-declined' : '' },
        h('th', { scope: 'row' }, p.name, p.approval !== 'approved' ? h('span', { class: 'fd-muted' }, ` · ${p.approval}`) : null, Number.isFinite(p.leftAt) ? h('span', { class: 'fd-muted' }, ' (left)') : null),
        cell([o.eating ? EATING_HOST[o.eating] : '', o.hunger ? LABELS.hunger[o.hunger].toLowerCase() : ''].filter(Boolean).join('\n'), 'is-wrap is-eating'),
        cell(orderBits.join('\n'), 'is-wrap is-order'),
        cell(f.diet ? (f.diet === 'other' && f.dietOther ? `Other: ${f.dietOther}` : LABELS.diet[f.diet]) : ''),
        cell(f.allergies.length ? h('span', { class: 'fd-flags' }, flagPills(flagsOf({ allergies: f.allergies }))) : f.noAllergies ? 'None' : '', 'is-wrap'),
        cell(f.avoid, 'is-wrap'),
        cell(f.love, 'is-wrap'),
        cell(f.spice ? LABELS.spice[f.spice] : ''),
        cell([f.drinks, hasText(o.drinks) ? `Order: ${o.drinks}` : ''].filter(Boolean).join('\n'), 'is-wrap'),
        cell([f.notes, hasText(o.payment) ? `Payment: ${o.payment}` : ''].filter(Boolean).join('\n'), 'is-wrap'),
        cell(p.updatedAt ? fmtTime(p.updatedAt) : '', 'fd-num'));
    });
    det.append(h('summary', null, `Everyone’s answers (${people.length})`),
      h('div', { class: 'fd-table-wrap' }, h('table', { class: 'fd-table' },
        h('thead', null, h('tr', null, ['Name', 'Eating', 'Order', 'Diet', 'Allergies', 'Avoid', 'Loves', 'Spice', 'Drinks', 'Anything else', 'Updated'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, rows))));
    return det;
  }

  function resetSection() {
    const btn = h('button', { type: 'button', class: 'btn-link fd-reset' }, 'Reset the food order answers…');
    btn.addEventListener('click', async () => {
      downloadCsv(); // the answers as they are now (the server keeps them in the food history too)
      const withOrder = people.filter((p) => p.food && (p.food.order?.eating || p.food.order?.hunger || p.food.order?.picks?.length || hasText(p.food.order?.wish) || hasText(p.food.order?.drinks) || hasText(p.food.order?.payment))).length;
      const ok = await confirmReset(withOrder);
      if (!ok) return;
      try {
        const r = await api('/api/host/food/reset', {});
        toast(`Cleared ${plural(r?.cleared ?? 0, 'person’s order answers', 'people’s order answers')}. Everything else is kept, and the answers from before are in the food history.`, { ms: 7000 });
        await reload();
      } catch (ex) {
        toast(ex.network ? 'You seem to be offline. Nothing was cleared.' : ex.message || 'Couldn’t reset the answers.', { kind: 'error' });
      }
    });
    return h('footer', { class: 'fd-sum-foot' },
      data.resetAt ? h('span', { class: 'fd-muted' }, `Order answers last reset at ${fmtTime(data.resetAt)}. `) : null,
      btn,
      data.historyCount ? [' · ', h('a', { class: 'btn-link fd-history', href: '/api/host/food-history.csv', download: '' }, 'Download the food history (CSV)')] : null);
  }
}
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
function groupSevere(list) {
  const out = new Map();
  for (const x of list) {
    const key = norm(x.label);
    if (!out.has(key)) out.set(key, { label: x.label || 'Not specified', people: [] });
    out.get(key).people.push(x);
  }
  return [...out.values()];
}

// mountFoodCard(container): fetches GET /api/host/food, renders the card and refreshes it every
// `intervalMs` while the page is visible (never while the host is editing in it).
export function mountFoodCard(container, { intervalMs = 30_000, heading = true } = {}) {
  let stopped = false;
  let timer = null;
  const refresh = async () => {
    if (stopped) return;
    const ui = container.__fdSum;
    if (ui?.setupOpen || container.contains(document.activeElement) && document.activeElement.matches('input, textarea, select')) return;
    if (document.querySelector('.fd-reset-modal, .fd-copy-modal')) return;
    try {
      const data = await api('/api/host/food');
      if (!stopped) renderFoodSummary(container, data, { heading });
    } catch (e) {
      if (!container.__fdSum) fill(container, h('p', { class: 'fd-none-yet' }, e.status === 404 ? 'Food answers are for hosts only.' : 'Couldn’t load the food answers. Retrying…'));
    }
  };
  refresh();
  timer = setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, intervalMs);
  return {
    refresh,
    destroy() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

// ------------------------------------------------------------------ the writer drawer
export function renderFoodAnswers(container, person, order) {
  const setup = normSetup(order);
  if (!person || !person.food) {
    fill(container, h('p', { class: 'fd-none-yet' }, 'No food answers yet.'));
    return;
  }
  const f = normFood(person.food);
  const o = f.order;
  const optName = new Map(setup.options.map((x) => [x.id, x.name]));
  const rows = [];
  const row = (label, ...value) => rows.push(h('div', { class: 'fd-ans-row' }, h('dt', null, label), h('dd', null, ...value)));
  const severe = f.allergies.filter((a) => a.severity === 'severe');
  if (severe.length) {
    rows.push(h('div', { class: 'fd-ans-severe' }, h('span', { class: 'fd-severe-mark', 'aria-hidden': 'true' }, '!'),
      `Severe ${severe.length === 1 ? 'allergy' : 'allergies'}: `, severe.map((a) => `${a.item || 'not specified'}${a.note ? ` (${a.note})` : ''}`).join('; ')));
  }
  const eating = [o.eating ? EATING_HOST[o.eating] : null, o.hunger ? LABELS.hunger[o.hunger].toLowerCase() : null].filter(Boolean).join(' · ');
  if (eating) row('Food', eating);
  if (o.picks.length) {
    row('Order', h('ol', { class: 'fd-ans-picks' }, o.picks.map((id) => h('li', null, h('b', null, optName.get(id) || 'An option that was removed'), o.lines[id] ? `: ${o.lines[id]}` : ''))));
  }
  if (hasText(o.wish)) row('Would like', o.wish);
  if (hasText(o.drinks)) row('Drinks to order', o.drinks);
  if (hasText(o.payment)) row('Payment', o.payment);
  if (f.diet) row('Diet', f.diet === 'other' && f.dietOther ? `Other: ${f.dietOther}` : LABELS.diet[f.diet]);
  if (f.allergies.length) row('Allergies', h('ul', { class: 'fd-ans-list' }, f.allergies.map((a) => h('li', { class: a.severity === 'severe' ? 'is-severe' : '' }, h('b', null, a.item || 'Not specified'), a.severity ? ` · ${LABELS.severity[a.severity].toLowerCase()}` : '', a.note ? ` · ${a.note}` : ''))));
  else if (f.noAllergies) row('Allergies', 'None');
  if (hasText(f.avoid)) row('Avoid', f.avoid);
  if (hasText(f.love)) row('Loves', f.love);
  if (f.spice) row('Spice', LABELS.spice[f.spice]);
  if (hasText(f.drinks)) row('Favourite drinks', f.drinks);
  if (hasText(f.notes)) row('Anything else', f.notes);
  fill(container, h('dl', { class: 'fd-ans' }, rows), person.updatedAt ? h('p', { class: 'fd-ans-when' }, `Updated ${fmtTime(person.updatedAt)}`) : null);
}

// ------------------------------------------------------------------ the writer page's nudge
// mountFoodNudge({ after, userId, returnFocus, active }): for someone approved before they saw
// the form, or who skipped it. A small row under the header (inserted after `after`, the
// writer page's banner): "Food: tell us what you'd like →", which opens the sheet. It
// never takes the focus, waits for a pause in typing (and for any open dialog) before it
// appears, and once dismissed or answered it never comes back on this device. `active()`
// false (e.g. after the party) keeps it away. → Promise<{ el, remove() } | null>
export async function mountFoodNudge({ after, userId = null, returnFocus = null, active = null } = {}) {
  if (!after || !after.parentElement) return null;
  const key = (id) => `wh-food-nudge:${id}`;
  const isDone = (id) => {
    try {
      return !!localStorage.getItem(key(id));
    } catch {
      return false;
    }
  };
  const markDone = (id) => {
    try {
      localStorage.setItem(key(id), '1');
    } catch { /* private mode: it may come back next time */ }
  };
  if (userId && isDone(userId)) return null;
  // Typing just now? Then later: it must never jump in under someone's fingers.
  let lastInput = 0;
  const onInput = () => { lastInput = Date.now(); };
  const evs = ['keydown', 'beforeinput', 'compositionstart', 'compositionupdate'];
  for (const e of evs) document.addEventListener(e, onInput, true);
  const stopWatching = () => { for (const e of evs) document.removeEventListener(e, onInput, true); };
  let r;
  try {
    r = await api('/api/me/food');
  } catch {
    stopWatching();
    return null;
  }
  const uid = r?.userId || userId;
  if (!uid || isDone(uid) || r.food) {
    if (uid && r?.food) markDone(uid);
    stopWatching();
    return null;
  }
  const pause = (ms) => new Promise((res) => setTimeout(res, ms));
  while (Date.now() - lastInput < 2500 || document.querySelector('dialog[open]') || (active && !active())) {
    if (!after.isConnected) {
      stopWatching();
      return null;
    }
    await pause(800);
  }
  stopWatching();
  if (!after.isConnected || isDone(uid)) return null;

  const grid = after.parentElement;
  const go = h('button', { type: 'button', class: 'fd-nudge-go' },
    h('span', { class: 'fd-nudge-k' }, 'Food:'), ' tell us what you’d like', h('span', { class: 'fd-nudge-arrow', 'aria-hidden': 'true' }, ' →'));
  const x = h('button', { type: 'button', class: 'btn-icon fd-nudge-x', 'aria-label': 'Not now', title: 'Not now' }, '×');
  const el = h('div', { class: 'fd-nudge', role: 'region', 'aria-label': 'Food' }, h('div', { class: 'fd-nudge-in' }, go, x));
  function remove() {
    window.removeEventListener('wh-food-saved', onSaved);
    el.remove();
    grid.classList.remove('has-fd-nudge');
  }
  function onSaved(e) {
    if (!e.detail?.answered) return;
    markDone(uid);
    remove();
  }
  window.addEventListener('wh-food-saved', onSaved);
  go.addEventListener('click', () => {
    openFoodSheet({
      returnFocus: go,
      onClose: () => {
        // Answered in the sheet: the row is gone, so the focus goes back to the page.
        if (!el.isConnected && returnFocus && returnFocus.isConnected && document.activeElement === document.body) returnFocus.focus({ preventScroll: true });
      },
    });
  });
  x.addEventListener('click', (e) => {
    markDone(uid);
    remove();
    if (e.detail === 0 && returnFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true }); // dismissed from the keyboard
  });
  after.after(el);
  grid.classList.add('has-fd-nudge');
  return { el, remove };
}

export async function mountWriterFood(container, userId) {
  fill(container, h('p', { class: 'fd-none-yet' }, 'Loading…'));
  try {
    const r = await api(`/api/host/food?id=${encodeURIComponent(userId)}`);
    renderFoodAnswers(container, r.person, r.order);
  } catch (e) {
    fill(container, h('p', { class: 'fd-none-yet' }, e.network ? 'Offline: food answers will show when you’re back.' : 'Couldn’t load their food answers.'));
  }
}
