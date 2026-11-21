// The writer's room: post tabs, the editor, planning notes, progress.

import { h, fill, $, clear, toast, modal, confirmDialog, menu, fmtInt, fmtDur, fmtWhen, plural, debounce, getTheme, setTheme, helpLink } from './ui.js';
import { api, stream, forgetSession } from './net.js';
import { SyncManager, loadBoot, clearBoot } from './sync.js';
import { createEditor, setSmartPunctuation, smartPunctuation, countedWords, PasteMeta } from './editor.js';
import { attributePaste } from './paste.js';
import { stripInvisible, countWords, rawWords } from './text.js';

// Paste-in / copy-out / export helpers load in the background: the editor never
// waits for them, and still works (plain text) if they fail to load.
let interop = null;
let interopP = null;
function loadInterop() {
  interopP ||= import('./interop.js').then((m) => { interop = m; return m; }).catch((e) => {
    interopP = null;
    throw e;
  });
  return interopP;
}
const plainInterop = {
  isOwnHtml: () => true,
  htmlToMarkdown: () => '',
  normalizePlain: (t) => String(t || '').replace(/\r\n?/g, '\n'),
  fillClipboard: (cd, md) => cd.setData('text/plain', md),
};
async function io() {
  try {
    return await loadInterop();
  } catch {
    return null;
  }
}

// Every time the writer sees: this browser's own time zone, 24-hour (en-GB), from epoch ms.
const TIME_FMT = (() => {
  try {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return null;
  }
})();
function fmtTime(ms) {
  if (!Number.isFinite(ms)) return '';
  if (TIME_FMT) return TIME_FMT.format(new Date(ms));
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Where each post appears. "Public" is said wherever the writer chooses: anonymous isn't private.
// (Labels only: the values and the API are unchanged.)
const PRIVACY = {
  live: { label: 'Public live · no name', short: 'Public live · no name', ended: 'Published · no name', desc: 'On the public live page as you write, without your name.' },
  named: { label: 'Public live · signed', short: 'Public live · signed', ended: 'Published · signed', desc: 'On the public live page as you write, with your name.' },
  separate: { label: 'At the end · separate identity', short: 'At the end · separate', ended: 'Published · separate identity', desc: 'Hidden until the party ends, then published with no link to your other posts.' },
};
// SPEC §26: never on a public page, at any time; the writer and the hosts can read it.
PRIVACY.private = { label: 'Private · never published', short: 'Private · never published', ended: 'Private · never published', desc: 'Never published, not even after the party; the hosts can still read it.' };
// macOS (and an iPad with a trackpad): Control-click is the secondary click, like a right-click.
const IS_MAC = /mac/i.test(navigator.userAgentData?.platform || navigator.platform || '') || /Macintosh|Mac OS X/.test(navigator.userAgent || '');
// Three dots for a tab's ⋯ button, drawn (a font's "⋯" sits differently from face to face).
const MORE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="3.5" cy="8" r="1.35"/><circle cx="8" cy="8" r="1.35"/><circle cx="12.5" cy="8" r="1.35"/></svg>';
// A tab's tooltip: the post, then how to reach its menu and move it.
const TAB_HINT = 'Right-click (Ctrl-click on a Mac) for options · drag to reorder';
const tabTip = (p, words = null) => `${p.title || 'Untitled'}: ${PRIVACY[p.privacy].short}${words === null ? '' : ` · ${plural(words, 'word')}`}\n${TAB_HINT}`;
const REASON_LABELS = {
  quick: ['Quick changes', 'Text removed or changed before it settled (typos, autocorrect): it never counted, so it costs nothing.'],
  repeat: ['Repeats of your own words', 'Words you were already credited for, moved, typed again or pasted again, and pasted words that repeat your own text.'],
  reused: ['Retyped just-deleted words', 'Words typed again within minutes of deleting them, or shuffled around.'],
  wordEdits: ['Edits inside words', 'Changing letters in a word that already counted.'],
  otherWriter: ['Other writers’ text', 'Text that matches what another writer wrote.'],
  unconfirmedPaste: ['Paste not confirmed', 'Pasted words you didn’t mark as written today.'],
  shortPaste: ['Short paste', 'Short pastes don’t count with this party’s settings.'],
  overSpeed: ['Over speed limit', 'Typing beyond the per-minute speed limit.'],
  overCutCap: ['Over cut limit', 'Cut credit beyond half the hour’s target.'],
  overPasteCap: ['Over paste limit', 'Paste credit beyond the hour’s paste limit.'],
};

// The rules in six lines, with the party's numbers (lobby).
export function ruleList(st) {
  const free = st.freePassesPerWriter ?? 1;
  const carry = st.carryOverMax ?? 0;
  return [
    `Write ${fmtInt(st.targetPerHour ?? 400)} new words each hour.`,
    carry > 0 ? `Words over the target, up to ${fmtInt(carry)}, carry on to your next hour.` : null,
    `A word counts once it has stayed on the page for ${Math.round(st.settleSec ?? 90)} seconds, so typos and autocorrect never matter.`,
    'Rewriting counts. Moving, retyping or re-pasting your own words doesn’t.',
    `Paste more than ${st.pasteAskOverWords ?? 12} words and you’ll be asked which you wrote today.`,
    'Quotes (lines starting with >) and planning notes count like the rest when they’re your own words.',
    (st.missedHourOutcome === 'alert-only' ? 'Missing an hour is flagged to the host' : 'Miss an hour and you’re out of the challenge (you can keep writing)')
      + (free > 0 ? `; everyone has ${free === 1 ? '1 free hour' : `${free} free hours`}.` : '.'),
  ].filter(Boolean);
}

export async function mountWriter(root, session) {
  let me;
  let posts;
  let offlineStart = false;
  let skew = 0;
  try {
    [me, { posts }] = await Promise.all([api('/api/me'), api('/api/posts')]);
    skew = me.serverNow - Date.now();
    for (const p of posts) p.textKnown = true;
  } catch (e) {
    if (e.status === 401) {
      location.href = '/login';
      return;
    }
    if (!(e.network || e.status >= 500)) throw e;
    // Offline (or the server is unreachable): open with what this device kept.
    const boot = await loadBoot(session.user?.id);
    if (!boot || !boot.me || !Array.isArray(boot.posts)) {
      fill(root, h('div', { class: 'w-offline-start' },
        h('h1', null, 'You’re offline'),
        h('p', null, 'Writehaven will open as soon as you’re back online. Anything you wrote on this device is kept safe.'),
        h('button', { class: 'btn btn-primary', type: 'button', onClick: () => location.reload() }, 'Try again')));
      window.addEventListener('online', () => location.reload(), { once: true });
      return;
    }
    me = boot.me;
    posts = boot.posts.map((p) => ({ ...p, textKnown: false }));
    skew = boot.skew || 0;
    offlineStart = true;
  }
  const serverNow = () => Date.now() + skew;
  const sync = new SyncManager({ userId: me.me.id, onStatus: renderSave });
  await sync.init();
  let saveBootSoon = () => {};
  let helpMod = null; // help.js, once loaded
  let notifyMod = null; // notify.js (notifications), once loaded
  let installMod = null; // install.js (Add to Home Screen help), once loaded
  let edited = false; // "Saved" appears only once there's something to save
  const markEdited = () => {
    if (edited) return; // every keystroke after the first: one check, nothing else
    edited = true;
    onWritingStarted();
  };
  const editors = new Map(); // postId -> { body, notes, bodyHost, notesHost }
  const titleSavers = new Map();
  let activeId = null;
  try {
    activeId = localStorage.getItem(`wh-active:${me.me.id}`);
  } catch { /* none */ }
  let notesOpen = false;
  try {
    notesOpen = localStorage.getItem('wh-notes-open') === '1';
  } catch { /* none */ }
  const warned = new Set();
  let dismissedOut = false;

  // ---------------------------------------------------------------- layout
  const tabsEl = h('nav', { class: 'w-tabs', role: 'tablist', 'aria-label': 'Your posts' });
  const meBtn = h('button', { class: 'w-me', type: 'button', 'aria-haspopup': 'menu' }, me.me.name);
  const newBtn = h('button', { class: 'w-tab-new', type: 'button', onClick: () => newPost(), title: 'New post', hidden: true }, '+ New post');
  const banner = h('div', { class: 'w-banner', hidden: true, role: 'status' });
  // The title wraps instead of clipping: a one-line textarea that grows with it.
  const titleIn = h('textarea', { class: 'w-title', rows: 1, placeholder: 'Title', 'aria-label': 'Post title', maxlength: 200, spellcheck: 'true', autocapitalize: 'words' });
  const fitTitle = () => {
    titleIn.style.height = 'auto';
    if (titleIn.scrollHeight) titleIn.style.height = `${titleIn.scrollHeight}px`;
  };
  window.addEventListener('resize', debounce(fitTitle, 150));
  const privacyBtn = h('button', { class: 'w-chip', type: 'button', 'aria-haspopup': 'menu' });
  const notesBtn = h('button', { class: 'w-chip', type: 'button', 'aria-pressed': 'false' }, 'Planning notes');
  const bodyWrap = h('div', { class: 'w-body' });
  const endSlot = h('div', { class: 'w-endslot' });
  const sheet = h('section', { class: 'w-sheet' },
    endSlot,
    h('div', { class: 'w-head' }, titleIn, h('div', { class: 'w-controls' }, privacyBtn, notesBtn)),
    bodyWrap);
  const notesWrap = h('div', { class: 'w-notes-body' });
  // Above the notes, always: what to think about before starting. Outside the editor,
  // so it's never part of the text (never saved, never counted). Collapsible per device.
  let hintOpen = true;
  try {
    hintOpen = localStorage.getItem('wh-notes-hint') !== 'closed';
  } catch { /* default open */ }
  const notesHint = h('details', { class: 'w-notes-hint', open: hintOpen },
    h('summary', null, 'Before you start, think about'),
    h('ul', null,
      h('li', null, 'What do you want to achieve today?'),
      h('li', null, 'What can you experiment with?'),
      h('li', null, 'What would help you become a better writer?')),
    h('button', { class: 'btn-link', type: 'button', onClick: () => openBrainstormPanel() }, 'Open the brainstorm'));
  import('./food.js').then((m) => m.mountFoodIdeasLink?.(notesHint)).catch(() => {}); // SPEC §20d
  notesHint.addEventListener('toggle', () => {
    try {
      localStorage.setItem('wh-notes-hint', notesHint.open ? 'open' : 'closed');
    } catch { /* ignore */ }
  });
  const notesPane = h('aside', { class: 'w-notes', hidden: true, 'aria-label': 'Planning notes' },
    h('div', { class: 'w-notes-head' },
      h('div', null, h('h2', null, 'Planning notes'), h('p', null, 'Private: only you and the hosts can read them; never published. Words here count towards your hour.')),
      h('button', { class: 'btn-icon', type: 'button', 'aria-label': 'Close notes', onClick: () => toggleNotes(false) }, '×')),
    notesHint,
    notesWrap);
  const empty = h('div', { class: 'w-empty', hidden: true });

  const progressBtn = h('button', { class: 'w-progress', type: 'button', 'aria-haspopup': 'dialog' });
  const saveEl = h('span', { class: 'w-save', 'aria-live': 'polite' });
  // "?" opens the counting help (help.js, when it's there; hidden otherwise).
  const helpBtn = helpLink('counting', { label: '?', className: 'w-help' });
  helpBtn.setAttribute('aria-label', 'How words are counted');
  helpBtn.title = 'How words are counted';
  const foot = h('footer', { class: 'w-foot' }, h('div', { class: 'w-foot-left' }, progressBtn, helpBtn), saveEl);
  const app = h('div', { class: 'w-app' },
    h('header', { class: 'w-top' },
      h('a', { class: 'w-brand', href: '/live', target: '_blank', title: 'Open the live page' }, me.party.name),
      tabsEl,
      newBtn,
      h('span', { class: 'w-top-gap' }),
      meBtn),
    banner,
    h('main', { class: 'w-main' }, empty, sheet, notesPane),
    foot);
  fill(root, app);
  document.title = `${me.party.name}: writing`;

  // ---------------------------------------------------------------- on-screen keyboard
  // iOS (and older Android) lays the keyboard over the page instead of resizing it:
  // the app follows the visual viewport, so the footer, toasts and dialogs stay above
  // the keyboard, and the caret stays in view when the keyboard opens.
  const vv = window.visualViewport;
  if (vv) {
    const rootEl = document.documentElement;
    let raf = 0;
    let lastH = 0;
    const fit = () => {
      raf = 0;
      if (vv.scale > 1.05) {
        // Pinch-zoomed: leave the layout alone.
        rootEl.style.removeProperty('--app-h');
        rootEl.style.removeProperty('--app-top');
        return;
      }
      const hgt = Math.round(vv.height);
      rootEl.style.setProperty('--app-h', `${hgt}px`);
      rootEl.style.setProperty('--app-top', `${Math.max(0, Math.round(vv.offsetTop))}px`);
      rootEl.classList.toggle('kb-open', window.innerHeight - vv.height > 140 || (lastH && hgt < lastH - 140));
      if (lastH && Math.abs(hgt - lastH) > 40) revealCaret();
      if (!lastH || Math.abs(hgt - lastH) > 40) lastH = hgt;
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(fit);
    };
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    fit();
  }
  function revealCaret() {
    const ed = editors.get(activeId);
    if (!ed) return;
    for (const e of [ed.body, ed.notes]) if (e.view.hasFocus) e.revealCaret();
  }

  // ---------------------------------------------------------------- focus
  // After a dialog or menu closes, typing goes back to the page being written
  // (not to the button that opened the dialog, where a space would reopen it).
  let lastPane = 'body';
  root.addEventListener('focusin', (e) => {
    if (e.target.closest && e.target.closest('.w-editor-notes')) lastPane = 'notes';
    else if (e.target.closest && e.target.closest('.w-editor')) lastPane = 'body';
  });
  function refocus() {
    const p = byId(activeId);
    if (!p || !canWrite()) return;
    setTimeout(() => {
      if (document.querySelector('dialog[open]')) return;
      const ed = editors.get(p.id);
      if (ed) (lastPane === 'notes' && notesOpen ? ed.notes : ed.body).focus();
    }, 0);
  }

  // ---------------------------------------------------------------- posts & editors
  const byId = (id) => posts.find((p) => p.id === id);
  const openPosts = () => posts.filter((p) => !p.closed);
  const writable = () => me.party.phase === 'running';
  // After the end, posts stay editable (SPEC §30): changes save as you type and never count.
  const canWrite = () => writable() || me.party.phase === 'ended';

  // A pane's text is only ever built from the server's copy (or, offline, from
  // what this device kept): never from an empty placeholder.
  async function initPanes(p) {
    for (const pane of ['body', 'notes']) {
      const server = p.textKnown ? { version: p.ver[pane], text: p[pane] ?? '' } : null;
      const s = await sync.openPane({ postId: p.id, pane, server });
      p[pane] = s.localText;
    }
  }
  const paneText = (p, pane) => sync.get(p.id, pane)?.localText ?? p[pane] ?? '';
  function editorsFor(p) {
    let ed = editors.get(p.id);
    if (ed) return ed;
    const bodyHost = h('div', { class: 'w-editor' });
    const notesHost = h('div', { class: 'w-editor w-editor-notes' });
    bodyWrap.insertBefore(bodyHost, bodyWrap.querySelector('.w-postcount'));
    notesWrap.append(notesHost);
    const make = (pane, parent) => {
      const s = sync.get(p.id, pane);
      const ed2 = createEditor({
        parent,
        text: s ? s.localText : '',
        kind: pane,
        placeholder: !s || !s.base ? 'This text isn’t on this device yet. It will appear when you’re back online.' : pane === 'body' ? 'Start writing…' : 'Outlines, plans, notes to self…',
        readOnly: !canWrite() || !s || !s.base,
        askOver: () => me.settings.pasteAskOverWords,
        // After the end, a change that removes 50+ words at once waits for a reason (SPEC §30).
        // (A post started after the end holds no party text: nothing to ask.)
        guardCut: () => (me.party.phase === 'ended' && !p.reasoned && !p.added ? (words) => reasonForCut(p, words) : null),
        onOps: (ops, wd) => {
          if (!s) return;
          markEdited();
          if (wd && wd.counted) {
            editorWords.set(ed2, (editorWords.get(ed2) || 0) + wd.counted);
            localWords += wd.counted;
          }
          if (wd && wd.all) editorAll.set(ed2, (editorAll.get(ed2) || 0) + wd.all);
          for (const op of ops) s.push(op);
          queuePaint();
          if (pane === 'body') queuePostCount();
        },
        onPaste: (req) => handlePaste(req, ed2),
        onFiles: (files, pos) => dropFiles(files, pos, pane),
        onCopy: (md, cd) => (interop || plainInterop).fillClipboard(cd, md),
      });
      recountEditor(ed2);
      if (s) {
        s.onRemote = (changes, text) => {
          ed2.applyRemote(changes, text);
          // Text from elsewhere: recount this editor, and don't call it unconfirmed.
          const before = localWords;
          recountEditor(ed2);
          ackWords += localWords - before;
          if (ackNext !== null) ackNext += localWords - before;
          queuePaint();
          if (pane === 'body') queuePostCount();
        };
        // The editor must show exactly the text the queue builds on.
        if (ed2.text !== s.localText) ed2.setRemoteText(s.localText);
      }
      return ed2;
    };
    ed = { body: make('body', bodyHost), notes: make('notes', notesHost), bodyHost, notesHost };
    editors.set(p.id, ed);
    return ed;
  }

  // A pane can't take text any more (the party ended while a question was open): say so.
  const cannotWrite = (ed) => !ed || ed.view.state.readOnly || !ed.view.dom.isConnected;
  function notAdded(what) {
    toast(canWrite() ? `${what}: this text can’t be edited right now.` : `${what}: writing has ended.`, { kind: 'warn', ms: 5000 });
  }
  // target (from the editor): where the paste goes, kept up to date while we ask; `edited` when
  // the selected text itself changed meanwhile (typed over, or edited in another tab or device).
  async function handlePaste({ text, html, keyboard = false, target = null }, ed = null) {
    const x = (await io()) || plainInterop;
    let md = text || '';
    if (html && !x.isOwnHtml(html)) {
      try {
        md = x.htmlToMarkdown(html) || md;
      } catch {
        md = text || '';
      }
    }
    md = stripInvisible(x.normalizePlain(md));
    if (!md.trim()) return null;
    const r = me.party.phase === 'ended' ? unasked(md) : await attributePaste({
      text: md,
      askOver: me.settings.pasteAskOverWords,
      keyboard,
      check: (t) => api('/api/paste/check', { text: t }),
    });
    if (r?.note) toast(r.note);
    if (!r || !ed) return r;
    // Never guess over changed text: the selection won't be replaced, and the writer decides.
    if (target?.edited && !(await confirmDialog({
      title: 'Your selection changed',
      body: 'While this paste was waiting, the text you had selected was edited (here, or in another tab or on another device). It won’t be replaced: the paste goes in right after it.',
      confirmLabel: 'Paste after it',
      cancelLabel: 'Cancel paste',
    }))) return null;
    if (cannotWrite(ed)) {
      notAdded('Not pasted');
      return null;
    }
    if (target?.edited) {
      // Going in beside a word instead of over it: a space each side keeps the words apart
      // (spaces aren't words, so the attribution mask is unchanged).
      const st = ed.view.state;
      const pre = /\S/.test(st.sliceDoc(target.from - 1, target.from)) && /^\S/.test(r.text) ? ' ' : '';
      const post = /[\p{L}\p{N}]/u.test(st.sliceDoc(target.from, target.from + 1)) && /\S$/.test(r.text) ? ' ' : '';
      if (pre || post) return { ...r, text: `${pre}${r.text}${post}` };
    }
    return r;
  }

  async function dropFiles(files, pos, pane) {
    const p = byId(activeId);
    if (!p || !canWrite()) return;
    const x = await io();
    if (!x) return toast('Couldn’t load the file reader. Check your connection.', { kind: 'error' });
    for (const f of files.slice(0, 5)) {
      let res;
      try {
        res = await x.importFile(f);
      } catch (e) {
        toast(e.message || 'Can’t read that file', { kind: 'error' });
        continue;
      }
      // importFile splits the first heading off as a title: a dropped file keeps it.
      const md = res.title && !/^\s*#/.test(res.markdown || '') ? `# ${res.title}\n\n${res.markdown || ''}` : res.markdown;
      const r = await attributeText(md);
      if (!r) continue;
      const ed = editorsFor(p)[pane];
      if (cannotWrite(ed)) {
        notAdded('Not added');
        return;
      }
      ed.insertAttributed(r.text, r.meta, pos); // pos: the drop point, kept up to date by the editor
    }
  }
  // After the end nothing counts, so a paste or a file goes in without the question (SPEC §30).
  const unasked = (md) => ({ text: md, meta: { m: '0'.repeat(rawWords(md).length), d: 'no' } });
  async function attributeText(text) {
    const md = stripInvisible((interop || plainInterop).normalizePlain(text || ''));
    if (!md.trim()) return null;
    const r = me.party.phase === 'ended' ? unasked(md) : await attributePaste({ text: md, askOver: me.settings.pasteAskOverWords, check: (t) => api('/api/paste/check', { text: t }) });
    if (r?.note) toast(r.note);
    return r ? { ...r, meta: { ...r.meta, d: r.meta.d === 'short' ? 'short' : r.meta.d } } : null;
  }

  function showPost(id) {
    const want = byId(id);
    const p = (want && !want.closed ? want : null) || openPosts()[0] || null;
    activeId = p ? p.id : null;
    try {
      if (activeId) localStorage.setItem(`wh-active:${me.me.id}`, activeId);
    } catch { /* ignore */ }
    for (const [pid, ed] of editors) {
      ed.bodyHost.hidden = pid !== activeId;
      ed.notesHost.hidden = pid !== activeId;
    }
    if (!p) {
      renderTabs();
      renderMain();
      return;
    }
    const ed = editorsFor(p);
    ed.bodyHost.hidden = false;
    ed.notesHost.hidden = false;
    titleIn.value = p.title || '';
    renderTabs();
    tabsEl.querySelector('.w-tab.is-active')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); // a bar that scrolls (phones)
    renderMain();
    renderPrivacy();
    fitTitle();
    queuePostCount();
  }

  // Reordering tabs (SPEC §29), below: a pointer down on a tab (press) becomes a drag; while
  // one runs, the tabs aren't rebuilt (tabsDirty: rebuilt when it ends).
  let press = null;
  let drag = null;
  let tabsDirty = false;
  let tabsKey = '';
  function renderTabs() {
    if (drag) {
      tabsDirty = true;
      return;
    }
    const key = JSON.stringify([activeId, me.party.phase, openPosts().map((p) => [p.id, p.title, p.privacy, p.unlisted])]);
    if (key === tabsKey) return;
    tabsKey = key;
    clear(tabsEl);
    for (const p of openPosts()) {
      const active = p.id === activeId;
      // ⋯ opens the tab's menu, as a right-click or a long-press does. On touch screens it's
      // always there and takes the place of × (Close post is in the menu).
      const more = h('button', {
        class: 'w-tab-more', type: 'button', 'aria-haspopup': 'menu', 'aria-label': `Options for ${p.title || 'Untitled'}`,
        title: 'Options: move, star, close (or right-click the tab)',
        onClick: (e) => { e.stopPropagation(); openTabMenu(p.id, more); },
      });
      more.innerHTML = MORE_ICON;
      const tab = h('div', { class: `w-tab ${active ? 'is-active' : ''} ${writable() ? '' : 'no-close'}`, role: 'presentation', dataset: { id: p.id } },
        h('button', {
          class: 'w-tab-btn', type: 'button', role: 'tab', 'aria-selected': active ? 'true' : 'false',
          onClick: () => { showPost(p.id); editorsFor(p).body.focus(); },
          title: tabTip(p),
        },
        h('span', { class: `w-dot dot-${p.unlisted && p.privacy !== 'private' ? 'hidden' : p.privacy}`, 'aria-hidden': 'true' }), // private: the padlock, hidden or not
        h('span', { class: 'w-tab-title' }, p.title || 'Untitled')),
        more,
        writable() ? h('button', {
          class: 'w-tab-close', type: 'button', 'aria-label': `Close ${p.title || 'Untitled'}`,
          onClick: (e) => { e.stopPropagation(); closePost(p); },
        }, '×') : null);
      tabsEl.append(tab);
    }
    newBtn.hidden = !canWrite(); // after the end too: private until published (SPEC §30)
  }

  // ---------------------------------------------------------------- tab order (SPEC §29)
  // The writer arranges their own tabs: drag one on a desktop; long-press one on a phone (let go
  // for its menu, Move left / Move right, or keep the finger down and slide to drag it);
  // right-click for the same menu; Alt+Shift+←/→ on a focused tab. The order is kept on the
  // server (POST /api/me/tab-order, lib/taborder.js) for every device; other devices take it
  // from their me stream. Closed posts keep their place among the closed (`posts` holds them all).
  const tabAnnounce = h('span', { class: 'w-sr', 'aria-live': 'polite' });
  tabsEl.after(tabAnnounce);
  const marker = h('span', { class: 'w-tab-marker', 'aria-hidden': 'true' });
  const reduceMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let suppressClick = false; // the click that ends a drag or a long-press isn't a tab switch
  function announce(text) {
    tabAnnounce.textContent = '';
    requestAnimationFrame(() => { tabAnnounce.textContent = text; });
  }
  const tabLefts = () => new Map([...tabsEl.querySelectorAll('.w-tab')].map((el) => [el.dataset.id, el.getBoundingClientRect().left]));
  // Each tab glides from where it was (`before`) to its new place.
  function settleTabs(before) {
    if (!before || reduceMotion()) return;
    for (const el of tabsEl.querySelectorAll('.w-tab')) {
      const was = before.get(el.dataset.id);
      const dx = was === undefined ? 0 : was - el.getBoundingClientRect().left;
      if (Math.abs(dx) >= 1) el.animate?.([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 220, easing: 'cubic-bezier(.2,.7,.2,1)' });
    }
  }
  // Moves an open post to place `to` among the open tabs. Returns false when it stays.
  function moveTabTo(id, to, { focus = false, before = null } = {}) {
    const open = openPosts();
    const from = open.findIndex((p) => p.id === id);
    const dest = Math.max(0, Math.min(open.length - 1, to));
    if (from < 0 || dest === from) return false;
    const lefts = before || tabLefts();
    const moving = open[from];
    const rest = open.filter((p) => p !== moving);
    posts.splice(posts.indexOf(moving), 1);
    const next = rest[dest]; // the open tab that now follows it (closed posts stay where they are)
    posts.splice(next ? posts.indexOf(next) : posts.indexOf(rest[rest.length - 1]) + 1, 0, moving);
    renderTabs();
    settleTabs(lefts);
    if (focus) tabsEl.querySelector(`.w-tab[data-id="${id}"] .w-tab-btn`)?.focus({ preventScroll: true });
    tabsEl.querySelector(`.w-tab[data-id="${id}"]`)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    announce(`Moved to position ${dest + 1} of ${open.length}`);
    queueOrderSave();
    return true;
  }

  // Saved after a short pause; offline it's kept here and sent when the network is back. While a
  // save is on its way (and for a moment after), the me stream's order is older than this one.
  let orderTimer = 0;
  let orderSaving = false;
  let orderGraceUntil = 0;
  let serverOrder = null; // the order in the latest me event
  function queueOrderSave(ms = 350) {
    orderSaving = true;
    clearTimeout(orderTimer);
    orderTimer = setTimeout(saveOrder, ms);
  }
  async function saveOrder() {
    orderTimer = 0;
    try {
      await api('/api/me/tab-order', { ids: posts.map((p) => p.id) });
      if (orderTimer) return; // moved again meanwhile: that save follows
      orderSaving = false;
      orderGraceUntil = Date.now() + 2000;
      setTimeout(() => { if (!orderSaving && serverOrder) applyServerOrder(serverOrder); }, 2100);
    } catch (e) {
      if (e.network || e.status >= 500) orderTimer = orderTimer || setTimeout(saveOrder, 5000);
      else orderSaving = false; // refused: the server's order wins at the next update
    }
  }
  window.addEventListener('online', () => {
    if (orderSaving && orderTimer) queueOrderSave(500);
  });
  // The order from the server (another device moved a tab; posts made elsewhere).
  function applyServerOrder(ids) {
    if (drag || orderSaving || Date.now() < orderGraceUntil) return;
    const rank = new Map(ids.map((id, i) => [id, i]));
    const at = new Map(posts.map((p, i) => [p, i]));
    const sorted = posts.slice().sort((a, b) => (rank.get(a.id) ?? 1e6 + at.get(a)) - (rank.get(b.id) ?? 1e6 + at.get(b)));
    if (sorted.every((p, i) => p === posts[i])) return;
    const lefts = tabLefts();
    posts.splice(0, posts.length, ...sorted);
    renderTabs();
    settleTabs(lefts);
  }

  // The tab's own menu (long-press on a phone, right-click or the menu key on a desktop).
  function openTabMenu(id, anchor) {
    const open = openPosts();
    const i = open.findIndex((p) => p.id === id);
    if (i < 0) return;
    const p = open[i];
    const starred = !!me.posts?.find((m) => m.id === p.id)?.starred;
    menu(anchor, [
      { heading: p.title || 'Untitled' },
      { label: 'Move left', disabled: i === 0, onClick: () => moveTabTo(id, i - 1, { focus: true }) },
      { label: 'Move right', disabled: i === open.length - 1, onClick: () => moveTabTo(id, i + 1, { focus: true }) },
      '-',
      { label: starred ? 'Unstar' : 'Star on my page', hint: !starred && p.privacy !== 'named' ? 'shows once signed' : null, onClick: () => starPost(p, !starred) },
      writable() ? { label: 'Close post', onClick: () => closePost(p) } : null,
    ], { className: 'menu-tab', onClose: (chose) => { if (!chose && anchor.isConnected) anchor.focus({ preventScroll: true }); } });
  }
  // SPEC §28b: a star puts a post first on your personal page. Any post can have one (it's
  // kept); it shows only on a signed post, while you're on the public list of writers. Not an
  // edit of the post: it works after the end too.
  let starToast = null; // the last star message: a new one replaces it, so quick toggles don't pile up
  async function starPost(p, starred) {
    const say = (msg, opts) => {
      starToast?.close?.();
      starToast = toast(msg, opts);
    };
    try {
      const r = await api('/api/me/star', { postId: p.id, starred });
      const meta = me.posts?.find((m) => m.id === p.id);
      if (meta) meta.starred = r.starred;
      if (!r.starred) return void say('Unstarred.');
      const signed = p.privacy === 'named';
      if (signed && r.page && !p.unlisted) say('Starred: it comes first on your page.', { action: { label: 'See your page', onClick: () => window.open(`/w/${encodeURIComponent(r.page)}`, '_blank', 'noopener') } });
      else if (signed && !r.listed) say('Starred. It shows on your page once you’re on the public list of writers (Your account).', { ms: 8000 });
      else if (signed) say('Starred. The host has hidden this post, so it isn’t on your page.', { ms: 6000 });
      else say('Starred. It shows on your page only once the post is signed and you’re on the public list of writers.', { ms: 8000 });
    } catch (e) {
      say(e.network ? 'You seem to be offline. Try again when you’re back.' : e.message || 'Couldn’t star this post.', { kind: 'error' });
    }
    return undefined;
  }

  // Pointer: a mouse or pen drags after 6 px. A finger first has to hold still (a moving finger
  // scrolls the tab bar, as ever): after the hold the tab lifts; let go for its menu, or slide.
  const tabOf = (e) => {
    const btn = e.target.closest?.('.w-tab-btn');
    return btn && tabsEl.contains(btn) ? { btn, tab: btn.parentElement } : null;
  };
  function cancelPress() {
    if (!press) return;
    clearTimeout(press.timer);
    press.tab.classList.remove('is-held');
    press = null;
  }
  tabsEl.addEventListener('pointerdown', (e) => {
    suppressClick = false;
    cancelPress();
    const t = tabOf(e);
    if (!t || drag || e.button !== 0 || !e.isPrimary) return; // a right-click (button 2): `contextmenu` below
    // On a Mac, Control-click is the secondary click: the browser sends `contextmenu` for it, and
    // the press itself neither switches tabs nor drags. (Command-click is a plain click.)
    if (IS_MAC && e.ctrlKey) {
      suppressClick = true;
      return;
    }
    press = { id: t.tab.dataset.id, tab: t.tab, btn: t.btn, x: e.clientX, y: e.clientY, pointerId: e.pointerId, type: e.pointerType, held: false, timer: 0 };
    if (e.pointerType === 'touch') {
      press.timer = setTimeout(() => {
        if (!press) return;
        press.held = true;
        press.tab.classList.add('is-held');
      }, 450);
    }
  });
  tabsEl.addEventListener('pointermove', (e) => {
    if (drag) {
      if (e.pointerId === drag.pointerId) dragMove(e);
      return;
    }
    if (!press || e.pointerId !== press.pointerId) return;
    const dx = e.clientX - press.x;
    const dy = e.clientY - press.y;
    if (press.type === 'touch' && !press.held) {
      if (Math.hypot(dx, dy) > 8) cancelPress(); // a scroll
    } else if (Math.abs(dx) > 6) {
      startDrag(e);
    }
  });
  tabsEl.addEventListener('pointerup', (e) => {
    if (drag) {
      if (e.pointerId === drag.pointerId) endDrag(true);
      return;
    }
    if (!press || e.pointerId !== press.pointerId) return;
    const p = press;
    cancelPress();
    if (p.held) {
      suppressClick = true;
      openTabMenu(p.id, p.btn);
    }
  });
  tabsEl.addEventListener('pointercancel', (e) => {
    if (drag && e.pointerId === drag.pointerId) endDrag(false);
    else if (press && e.pointerId === press.pointerId) cancelPress();
  });
  // After the hold, a sliding finger moves the tab instead of scrolling the bar.
  tabsEl.addEventListener('touchmove', (e) => {
    if (press?.held || drag) e.preventDefault();
  }, { passive: false });
  tabsEl.addEventListener('click', (e) => {
    if (!suppressClick && !(IS_MAC && e.ctrlKey && tabOf(e))) return; // a Mac's Control-click is the menu
    suppressClick = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);
  tabsEl.addEventListener('contextmenu', (e) => {
    const tab = e.target.closest?.('.w-tab');
    if (!tab || !tabsEl.contains(tab)) return;
    e.preventDefault();
    if (drag || press?.type === 'touch') return; // a finger's long-press: its menu opens when it lets go
    cancelPress(); // a mouse press (a Mac's Control-click comes as one): this is the menu instead
    suppressClick = true;
    openTabMenu(tab.dataset.id, tab.querySelector('.w-tab-btn'));
  });
  tabsEl.addEventListener('keydown', (e) => {
    const t = tabOf(e);
    if (!t || !e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    const open = openPosts();
    const i = open.findIndex((p) => p.id === t.tab.dataset.id);
    if (!moveTabTo(t.tab.dataset.id, i + (e.key === 'ArrowLeft' ? -1 : 1), { focus: true })) {
      announce(`Already at position ${i + 1} of ${open.length}`);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (drag && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      endDrag(false);
    }
  }, true);

  function startDrag(e) {
    const p = press;
    cancelPress();
    const open = openPosts();
    if (open.length < 2) return;
    const rects = [...tabsEl.querySelectorAll('.w-tab')].map((el) => ({ id: el.dataset.id, r: el.getBoundingClientRect() }));
    drag = { ...p, from: open.findIndex((x) => x.id === p.id), to: null, rects, scroll0: tabsEl.scrollLeft };
    try {
      p.btn.setPointerCapture(e.pointerId);
    } catch { /* already released */ }
    p.tab.classList.add('is-dragging');
    tabsEl.classList.add('is-sorting');
    tabsEl.append(marker);
    suppressClick = true;
    dragMove(e);
  }
  function dragMove(e) {
    const strip = tabsEl.getBoundingClientRect();
    // Near an edge of a bar that scrolls, it scrolls along.
    if (tabsEl.scrollWidth > tabsEl.clientWidth) {
      if (e.clientX < strip.left + 28) tabsEl.scrollLeft -= 10;
      else if (e.clientX > strip.right - 28) tabsEl.scrollLeft += 10;
    }
    const shift = tabsEl.scrollLeft - drag.scroll0; // the rects were measured before any scrolling
    drag.tab.style.transform = `translateX(${e.clientX - drag.x + shift}px)`;
    // The landing place: before the first other tab whose middle is right of the pointer.
    const others = drag.rects.filter((t) => t.id !== drag.id);
    let to = others.length;
    for (let i = 0; i < others.length; i++) {
      if (e.clientX < others[i].r.left - shift + others[i].r.width / 2) {
        to = i;
        break;
      }
    }
    drag.to = to;
    marker.hidden = to === drag.from;
    const gap = to < others.length ? others[to].r.left : others[others.length - 1].r.right;
    marker.style.left = `${gap - shift - strip.left + tabsEl.scrollLeft}px`;
  }
  function endDrag(commit) {
    const d = drag;
    const lefts = tabLefts(); // the dragged tab where it was let go
    drag = null;
    marker.remove();
    tabsEl.classList.remove('is-sorting');
    try {
      d.btn.releasePointerCapture(d.pointerId);
    } catch { /* gone */ }
    d.tab.classList.remove('is-dragging');
    d.tab.style.transform = '';
    const dirty = tabsDirty;
    tabsDirty = false;
    if (commit && d.to !== null && moveTabTo(d.id, d.to, { focus: d.type !== 'touch', before: lefts })) return;
    // Back where it was: the tab glides home.
    if (dirty) renderTabs();
    settleTabs(lefts);
  }

  async function newPost(title = '') {
    try {
      const { post } = await api('/api/post/new', { title });
      post.textKnown = true;
      if (me.party.phase === 'ended') post.added = true; // started after the end: private (SPEC §30)
      posts.push(post);
      await initPanes(post);
      showPost(post.id);
      titleIn.focus();
      return post;
    } catch (e) {
      toast(e.network ? 'Reconnect to start a new post. Your writing so far is safe.' : e.message, { kind: 'error' });
      return null;
    }
  }
  async function closePost(p) {
    try {
      await api('/api/post/update', { id: p.id, closed: true });
      p.closed = true;
      if (activeId === p.id) showPost(openPosts()[0]?.id);
      else renderTabs();
      toast(p.privacy === 'private' ? 'Closed. It still counts and stays private; reopen it from your menu.' : 'Closed. It still counts and publishes; reopen it from your menu.');
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  }
  async function reopenPost(p) {
    try {
      await api('/api/post/update', { id: p.id, closed: false });
      p.closed = false;
      showPost(p.id);
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  }

  const titlePending = new Set(); // posts whose title changed here and isn't saved yet
  titleIn.addEventListener('input', () => {
    if (/[\r\n]/.test(titleIn.value)) titleIn.value = titleIn.value.replace(/\s*[\r\n]+\s*/g, ' ');
    fitTitle();
    const p = byId(activeId);
    if (!p) return;
    p.title = titleIn.value;
    titlePending.add(p.id);
    renderTabs();
    let saver = titleSavers.get(p.id);
    if (!saver) {
      saver = debounce(async (post) => {
        const sent = post.title;
        try {
          await api('/api/post/update', { id: post.id, title: sent });
          if (post.title === sent) titlePending.delete(post.id);
        } catch {
          setTimeout(() => saver(post), 3000);
        }
      }, 600);
      titleSavers.set(p.id, saver);
    }
    saver(p);
  });
  titleIn.addEventListener('blur', () => {
    const p = byId(activeId);
    if (p && titlePending.has(p.id)) titleSavers.get(p.id)?.flush(p);
  });
  titleIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || (e.key === 'ArrowDown' && titleIn.selectionStart === titleIn.value.length)) {
      e.preventDefault();
      const p = byId(activeId);
      if (p) editorsFor(p).body.focus();
    }
  });

  function renderPrivacy() {
    const p = byId(activeId);
    if (!p) return;
    const ended = me.party.phase === 'ended';
    const hidden = p.unlisted && p.privacy !== 'private'; // a private post shows its padlock, hidden or not
    const label = hidden ? 'Hidden by the host' : ended ? PRIVACY[p.privacy].ended : PRIVACY[p.privacy].short;
    fill(privacyBtn, h('span', { class: `w-dot dot-${hidden ? 'hidden' : p.privacy}`, 'aria-hidden': 'true' }), label);
    privacyBtn.disabled = !writable() && !ended; // after the end: a change with a reason (SPEC §30)
  }
  privacyBtn.addEventListener('click', () => {
    const p = byId(activeId);
    if (p && me.party.phase === 'ended') return void endedPrivacyMenu(p);
    if (!p || !writable()) return;
    const sepCount = posts.filter((x) => x.privacy === 'separate').length;
    const items = Object.entries(PRIVACY).map(([k, v]) => ({
      node: h('button', { class: `menu-item menu-rich ${p.privacy === k ? 'is-checked' : ''}`, type: 'button', role: 'menuitemradio', 'aria-checked': p.privacy === k ? 'true' : 'false',
        onClick: () => { document.querySelector('.menu-pop')?.__close(); setPrivacy(p, k); } },
      h('span', { class: 'menu-label' }, h('span', { class: `w-dot dot-${k}`, 'aria-hidden': 'true' }), v.label),
      h('span', { class: 'menu-desc' }, v.desc)),
    }));
    if (posts.length >= 3 && sepCount * 2 > posts.length) items.push('-', { node: h('p', { class: 'menu-warn' }, `${sepCount} of your ${posts.length} posts ${sepCount === 1 ? 'uses' : 'use'} a separate identity. It’s meant for the odd post you want kept apart from the rest.`) });
    if (p.unlisted) items.push('-', { node: h('p', { class: 'menu-note' }, 'The host has hidden this post from the public pages.') });
    // Said plainly, whatever the choice.
    items.push(items[items.length - 1]?.node?.matches?.('.menu-warn, .menu-note') ? null : '-', { node: h('p', { class: 'menu-note' }, 'Hosts can always see which posts are yours.') });
    menu(privacyBtn, items, { className: 'menu-privacy', onClose: refocus });
  });
  async function setPrivacy(p, privacy, confirmed = false) {
    if (p.privacy === privacy) return;
    const was = p.privacy;
    // Leaving private publishes the post from now on (SPEC §26): ask first.
    if (was === 'private' && !confirmed && !p.unlisted && paneText(p, 'body').trim()) {
      modal({
        onClose: refocus,
        title: privacy === 'separate' ? 'Publish this post when the party ends?' : 'Publish this post?',
        body: h('p', null, privacy === 'separate'
          ? 'It stays off the live page and goes in the anthology when the party ends, kept apart from everything else you write today. If it was on the live page before, its text can still be recognised.'
          : `It appears on the public live page from now on, ${privacy === 'named' ? 'with' : 'without'} your name, and goes in the anthology after the party.`),
        actions: [
          { label: 'Keep it private', quiet: true },
          { label: privacy === 'separate' ? 'Publish at the end' : 'Publish', primary: true, onClick: () => { setPrivacy(p, privacy, true); } },
        ],
      });
      return;
    }
    // Text already shown live (or signed) can still be recognised later: say so first.
    if (privacy === 'separate' && !confirmed && !p.unlisted && paneText(p, 'body').trim()) {
      modal({
        onClose: refocus,
        title: 'Switch this post to a separate identity?',
        body: h('div', null,
          h('p', null, 'Text already shown live can still be recognised. Separate identity works best if you choose it before you start writing.'),
          was === 'named' ? h('p', null, 'Your name has been shown on this post on the live page.') : null),
        actions: [
          { label: 'Cancel', quiet: true },
          { label: 'Switch anyway', primary: true, onClick: () => { setPrivacy(p, privacy, true); } },
        ],
      });
      return;
    }
    try {
      await api('/api/post/update', { id: p.id, privacy });
      p.privacy = privacy;
      renderPrivacy();
      renderTabs();
      const seps = posts.filter((x) => x.privacy === 'separate').length;
      if (privacy === 'separate' && posts.length >= 3 && seps * 2 > posts.length) toast('More than half of your posts now use a separate identity.', { kind: 'warn', ms: 5000 });
      else if (privacy === 'separate' && was !== 'separate') toast('This post is no longer streamed. It will be published when the party ends.');
      else if (privacy === 'private') toast('This post is private now: off the live page, and never published.');
      else if (was === 'private' && !p.unlisted) toast('This post is public now: it’s on the live page from here on.');
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  }

  // ---------------------------------------------------------------- after the party (SPEC §30)
  // After the end posts stay editable: changes save as you type and never count (the server opens
  // a quiet edit session with the first one). A change that takes 50 or more words out at once (a
  // deleted paragraph, a cut, select-all and retype, a paste over a big selection, an undo) asks
  // for a short reason first: the editor holds it meanwhile (editor.js guardCut), and Cancel leaves
  // the text as it was. A reason covers the rest of the post's session (p.reasoned, from the
  // server). If the server still asks for one (the change was typed offline or in another tab, or
  // the session closed meanwhile), the change waits in its queue on this device until a reason
  // goes with it. A privacy change asks for a reason of its own.
  const ENDED_DESC = {
    live: 'In the anthology, without your name.',
    named: 'In the anthology, with your name.',
    separate: 'In the anthology, kept apart from everything else you wrote today.',
    private: 'Never published. Hosts can still read it.',
  };
  // A reason of 3 to 200 characters → Promise<string | null>.
  function askReason({ title, lede, confirmLabel, hint = 'A few words, such as “fixing a typo”. The hosts see it; the public never does.' }) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        resolve(v);
      };
      const input = h('textarea', { class: 'w-reason-in', id: 'w-reason', rows: 2, maxlength: 200, autocomplete: 'off', 'aria-describedby': 'w-reason-hint w-reason-err' });
      const err = h('p', { class: 'w-reason-err', id: 'w-reason-err', role: 'alert' });
      const dlg = modal({
        title,
        className: 'modal-reason',
        body: h('div', { class: 'modal-body' }, h('p', null, lede),
          h('label', { class: 'w-reason-label', for: 'w-reason' }, 'Your reason'),
          input,
          h('p', { class: 'w-reason-hint', id: 'w-reason-hint' }, hint),
          err),
        onClose: () => {
          finish(null);
          refocus();
        },
        actions: [
          { label: 'Cancel', quiet: true },
          {
            label: confirmLabel, primary: true,
            onClick: () => {
              const r = input.value.replace(/\s+/g, ' ').trim();
              if ([...r].length < 3) {
                err.textContent = 'Please give a short reason (at least 3 characters).';
                input.focus();
                return false;
              }
              finish(r);
              return undefined;
            },
          },
        ],
      });
      input.addEventListener('input', () => { err.textContent = ''; });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          dlg.el.querySelector('.btn-primary')?.click();
        }
      });
      setTimeout(() => input.focus(), 0);
    });
  }
  const CUT_HINT = 'A few words, such as “cutting a scene that didn’t work”. The public never sees it.';
  const pendingReasons = new Map(); // postId -> a reason given while offline, sent when it can be
  const asking = new Set(); // posts whose reason is being asked for (one question at a time)
  // A change in the editor that removes 50+ words → Promise<boolean>: true when it can go in.
  async function reasonForCut(p, words) {
    if (asking.has(p.id)) return false;
    asking.add(p.id);
    try {
      const reason = await askReason({
        title: 'Remove a large part?',
        lede: `You’re removing about ${plural(words, 'word')}. The hosts see your reason.`,
        confirmLabel: 'Remove it',
        hint: CUT_HINT,
      });
      if (!reason) return false;
      const r = await sendReason(p, reason);
      if (r === 'offline') toast('You seem to be offline. The change is kept on this device and saved, with your reason, once you’re back.', { ms: 6000 });
      else if (r !== 'ok') toast(r, { kind: 'error' });
      return r === 'ok' || r === 'offline';
    } finally {
      asking.delete(p.id);
    }
  }
  // The post's session carries the reason from now on, and what waited for one goes.
  // → 'ok' | 'offline' (kept here, sent later) | an error to show.
  async function sendReason(p, reason) {
    try {
      const r = await api('/api/post/after-party', { id: p.id, reason });
      p.reasoned = !!r.reasoned;
      pendingReasons.delete(p.id);
      releaseReason(p.id);
      return 'ok';
    } catch (e) {
      if (e.network) {
        pendingReasons.set(p.id, reason);
        return 'offline';
      }
      return e.message || 'Your reason couldn’t be saved. Try again.';
    }
  }
  const waitingPane = (postId) => [...sync.allPanes()].find((x) => x.postId === postId && x.state === 'reason' && x.busy) || null;
  function releaseReason(postId) {
    let any = false;
    for (const x of sync.allPanes()) {
      if (x.postId !== postId || x.state !== 'reason') continue;
      x.state = 'ok';
      x.retryAt = 0;
      any = true;
    }
    if (any) sync.flush();
    renderAfterBar();
  }
  // The server refused a queued change for want of a reason: ask (or send the one given offline).
  async function reasonNeeded(postId, words) {
    renderAfterBar();
    const p = byId(postId);
    if (!p || asking.has(postId)) return;
    asking.add(postId);
    try {
      let reason = pendingReasons.get(postId);
      if (!reason) {
        reason = await askReason({
          title: 'Remove a large part?',
          lede: `A change to “${p.title || 'Untitled'}” removes ${words ? `about ${plural(words, 'word')}` : 'a large part'}, so it needs a short reason before it’s saved. The hosts see your reason. Until then it’s kept on this device.`,
          confirmLabel: 'Save it',
          hint: CUT_HINT,
        });
        if (!reason) return;
      }
      const r = await sendReason(p, reason);
      if (r !== 'ok' && r !== 'offline') toast(r, { kind: 'error' });
    } finally {
      asking.delete(postId);
      renderAfterBar();
    }
  }
  sync.onReasonNeeded = (pane, d) => reasonNeeded(pane.postId, d?.words);
  function endedPrivacyMenu(p) {
    const items = Object.entries(PRIVACY).map(([k, v]) => ({
      node: h('button', { class: `menu-item menu-rich ${p.privacy === k ? 'is-checked' : ''}`, type: 'button', role: 'menuitemradio', 'aria-checked': p.privacy === k ? 'true' : 'false',
        onClick: () => { document.querySelector('.menu-pop')?.__close(); if (k !== p.privacy) privacyAfterParty(p, k); } },
      h('span', { class: 'menu-label' }, h('span', { class: `w-dot dot-${k}`, 'aria-hidden': 'true' }), v.ended),
      h('span', { class: 'menu-desc' }, ENDED_DESC[k])),
    }));
    items.push('-', { node: h('p', { class: 'menu-note' }, `${p.unlisted ? 'The host has hidden this post. ' : ''}A change after the party needs a short reason, which the hosts see.`) });
    menu(privacyBtn, items, { className: 'menu-privacy', onClose: refocus });
  }
  async function privacyAfterParty(p, to) {
    const what = {
      live: 'It goes in the anthology without your name',
      named: 'It goes in the anthology with your name',
      separate: 'It goes in the anthology, kept apart from everything else you wrote today',
      private: 'It leaves the anthology and its own page at once',
    }[to];
    const reason = await askReason({
      title: to === 'private' ? 'Make this post private?' : 'Change who sees this post?',
      lede: `From “${PRIVACY[p.privacy].ended}” to “${PRIVACY[to].ended}”. ${what}${p.unlisted && to !== 'private' ? ', once the host shows it again' : ''}.`,
      confirmLabel: to === 'private' ? 'Make it private' : 'Change it',
    });
    if (!reason) return;
    try {
      await api('/api/post/update', { id: p.id, privacy: to, reason });
      p.privacy = to;
      renderPrivacy();
      renderTabs();
      renderAfterBar();
      toast(to === 'private' ? 'This post is private now: out of the anthology.' : 'Changed: the anthology shows it this way now.');
    } catch (e) {
      toast(e.network ? 'You seem to be offline. Try again when you’re back.' : e.message, { kind: 'error' });
    }
  }
  // The line under the title after the end (one, for the open post): what editing now means, or
  // that a change waits for its reason.
  let afterBarEl = null;
  let afterBarKey = '';
  function renderAfterBar() {
    if (!afterBarEl) {
      afterBarEl = h('div', { class: 'w-after', hidden: true });
      sheet.querySelector('.w-head')?.after(afterBarEl);
    }
    const p = byId(activeId);
    const show = me.party.phase === 'ended' && !!p;
    const waiting = show ? waitingPane(p.id) : null;
    const key = show ? `${p.id}|${!!waiting}|${!!p.added}|${p.privacy}` : '';
    if (key === afterBarKey) return;
    afterBarKey = key;
    afterBarEl.hidden = !show;
    afterBarEl.classList.toggle('is-waiting', !!waiting);
    if (!show) return void clear(afterBarEl);
    if (waiting) {
      fill(afterBarEl, h('p', null, h('strong', null, 'Not saved yet: '), 'a change removes a large part (50 or more words), which needs a short reason, shown to the hosts. It’s kept on this device until then.'),
        h('button', { class: 'btn btn-quiet', type: 'button', onClick: () => reasonNeeded(p.id, waitingPane(p.id)?.reasonWords) }, 'Give a reason…'));
    } else if (p.added) {
      fill(afterBarEl, h('p', null, h('strong', null, 'Written after the party: '), p.privacy === 'private'
        ? 'private unless you choose to publish it (the label under the title). Changes save as you type and don’t count for the challenge.'
        : 'published, with “Added after the party” on its page. Changes save as you type and don’t count for the challenge.'));
    } else {
      fill(afterBarEl, h('p', null, h('strong', null, 'Editing after the party: '), 'changes save as you type and don’t count for the challenge. Removing a large part (50+ words at once) asks for a short reason, shown to the hosts.'));
    }
  }
  setInterval(() => {
    // A reason given offline goes as soon as it can, for the change that waits for it.
    for (const id of pendingReasons.keys()) if (!asking.has(id) && waitingPane(id)) reasonNeeded(id, null);
    renderAfterBar();
  }, 3000);

  function toggleNotes(open = !notesOpen) {
    notesOpen = open;
    try {
      localStorage.setItem('wh-notes-open', open ? '1' : '0');
    } catch { /* ignore */ }
    notesPane.hidden = !open;
    notesBtn.setAttribute('aria-pressed', open ? 'true' : 'false');
    app.classList.toggle('notes-open', open);
    const p = byId(activeId);
    if (open && p) editorsFor(p).notes.focus();
  }
  notesBtn.addEventListener('click', () => toggleNotes());

  // ---------------------------------------------------------------- phases
  function renderMain() {
    const phase = me.party.phase;
    const p = byId(activeId);
    if (phase === 'lobby') {
      sheet.hidden = true;
      notesPane.hidden = true;
      empty.hidden = false;
      fill(empty, 
        h('h1', null, me.party.name),
        h('p', { class: 'w-empty-lede' }, Number.isFinite(me.party.plannedStart) ? `The party starts ${fmtWhen(me.party.plannedStart, serverNow())}.` : 'The party hasn’t started yet.'),
        h('p', null, `This page opens for writing the moment ${Number.isFinite(me.party.plannedStart) ? 'it starts' : 'the host starts'}. Your first hour begins when you open it after that, so arriving later is fine.`),
        h('h2', { class: 'w-empty-h' }, 'How it works'),
        h('ol', { class: 'w-rules' }, ruleList(me.settings).map((r) => h('li', null, r))));
      return;
    }
    if (!p) {
      sheet.hidden = true;
      notesPane.hidden = true;
      empty.hidden = false;
      fill(empty, 
        h('h1', null, phase === 'ended' ? 'The party has ended' : 'No open posts'),
        phase === 'ended' ? h('p', null, 'You can still write: a post you start now is private unless you choose to publish it, and it doesn’t count for the challenge.') : null,
        h('button', { class: 'btn btn-primary', type: 'button', onClick: () => newPost() }, 'Start a new post'));
      return;
    }
    empty.hidden = true;
    sheet.hidden = false;
    notesPane.hidden = !notesOpen;
    app.classList.toggle('notes-open', notesOpen);
    titleIn.readOnly = !canWrite();
    notesHint.hidden = !writable(); // "before you start" means nothing once writing has closed
    renderEndCard();
    renderAfterBar();
    for (const [pid, ed] of editors) {
      ed.body.setReadOnly(!canWrite() || !sync.get(pid, 'body')?.base);
      ed.notes.setReadOnly(!canWrite() || !sync.get(pid, 'notes')?.base);
    }
  }

  // ---------------------------------------------------------------- before you start
  // A brainstorm offered the first time the editor opens (and from the menu). The
  // answers are appended to the post's planning notes as ordinary edits, so they count;
  // the heading and the questions go in uncounted (they aren't the writer's words).
  // The offer is one quiet line above the title, aligned with the text: it never pushes the
  // writing down on a phone, never takes the keyboard, and goes by itself once writing
  // begins. What it's for (it counts towards the first hour) is said in the brainstorm.
  const offeredKey = `wh-brainstorm:${me.me.id}`;
  const offer = h('p', { class: 'w-offer', hidden: true },
    h('button', { class: 'w-offer-go', type: 'button', onClick: () => { dismissOffer(); openBrainstormPanel(); } },
      'Before you start, try a short brainstorm', h('span', { class: 'w-offer-arrow', 'aria-hidden': 'true' }, '→')),
    h('button', { class: 'w-offer-x', type: 'button', 'aria-label': 'Not now', title: 'Not now', onClick: () => { dismissOffer(); refocus(); } }, '×'));
  titleIn.before(offer);
  function dismissOffer() {
    offer.hidden = true;
    try {
      localStorage.setItem(offeredKey, '1');
    } catch { /* private mode */ }
  }
  function offerBrainstorm() {
    let seen = false;
    try {
      seen = !!localStorage.getItem(offeredKey);
    } catch { /* show it */ }
    const p = byId(activeId);
    // Writing has already begun (before this page, or on another device): nothing is "before" now.
    const begun = !p || (me.progress?.totals?.credit || 0) >= 1 || !!(paneText(p, 'body').trim() || paneText(p, 'notes').trim());
    offer.hidden = seen || !writable() || begun;
  }
  // The first words typed here: the offer has had its moment, and the footer's number starts
  // moving, so the one-time line about what it counts appears.
  function onWritingStarted() {
    if (!offer.hidden) dismissOffer();
    showCountTip();
  }
  // Help's "Open it now" (SPEC §17c), offered while writing is open.
  function syncBrainstormOpener() {
    helpMod?.setBrainstormOpener?.(writable() ? () => openBrainstormPanel() : null);
  }
  function openBrainstormPanel() {
    import('./brainstorm.js')
      .then((m) => m.openBrainstorm({ onAdd: (answers) => addBrainstorm(answers, m.QUESTIONS) }))
      .then(refocus)
      .catch(() => toast('Couldn’t open the brainstorm. Check your connection.', { kind: 'error' }));
  }
  // false: the answers couldn't go in, so the brainstorm stays open with them.
  function addBrainstorm(answers, questions) {
    const p = byId(activeId);
    const notes = p ? editorsFor(p).notes : null;
    if (!writable() || cannotWrite(notes)) {
      toast(writable() ? 'Your planning notes can’t be edited right now; your answers are still here.' : 'Writing has ended, so these can’t go in your notes.', { kind: 'warn', ms: 5000 });
      return false;
    }
    const v = notes.view;
    const append = (text, counted) => {
      const from = v.state.doc.length;
      if (counted) v.dispatch({ changes: { from, insert: text }, userEvent: 'input.type', scrollIntoView: true });
      else v.dispatch({ changes: { from, insert: text }, annotations: PasteMeta.of({ m: '0'.repeat(rawWords(text).length), d: 'no' }), userEvent: 'input.paste' });
    };
    const before = v.state.doc.toString();
    append(`${before.trim() ? (before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n') : ''}## Before I started\n\n`, false);
    answers.forEach((a, i) => {
      if (!a) return;
      append(`**${questions[i]}**\n`, false);
      append(`${a}\n\n`, true);
    });
    toggleNotes(true);
    toast('Added to your planning notes. They count towards your hour.');
  }

  // After the end: a card at the top of the page instead of a banner.
  function renderEndCard() {
    if (me.party.phase !== 'ended') {
      clear(endSlot);
      return;
    }
    const prog = me.progress;
    const words = prog ? Math.round(prog.totals?.credit || 0) : 0;
    const hours = prog ? prog.hours.filter((x) => ['met', 'missed', 'free', 'review', 'partial'].includes(x.status)).length : 0;
    const hoursTxt = hours ? ` in ${fmtHours(hours)}` : '';
    let verdict = '';
    if (prog && prog.met + prog.missed > 0) verdict = prog.missed === 0 ? ' and met every hour' : ` and met ${prog.met} of ${prog.met + prog.missed} hours`;
    fill(endSlot, h('div', { class: 'w-endcard' },
      h('p', { class: 'w-endcard-title' }, 'That’s the party.'),
      h('p', null, prog ? `You wrote ${plural(words, 'word')}${hoursTxt}${verdict}.` : 'Thank you for writing.'),
      h('div', { class: 'w-endcard-actions' },
        h('a', { class: 'btn btn-primary', href: '/archive' }, 'Read the anthology'),
        posts.length ? h('button', { class: 'btn', type: 'button', onClick: () => exportDialog(true) }, 'Export your posts') : null)));
  }
  // "3½ hours": the writer's time from their start to the end of the party.
  function fmtHours(n) {
    const start = me.me.joinedAt;
    const end = me.party.endedAt;
    let x = n;
    if (start && end && end > start) x = Math.round(((end - start) / ((me.settings.hourLengthMin || 60) * 60_000)) * 2) / 2;
    if (!x) x = n;
    const whole = Math.floor(x);
    const half = x - whole >= 0.5;
    if (!whole && half) return 'half an hour';
    return `${whole}${half ? '½' : ''} ${x === 1 ? 'hour' : 'hours'}`;
  }

  // ---------------------------------------------------------------- banners
  function setBanner(kind, ...content) {
    if (!kind) {
      banner.hidden = true;
      clear(banner);
      return;
    }
    banner.className = `w-banner banner-${kind}`;
    banner.hidden = false;
    fill(banner, h('div', { class: 'w-banner-in' }, ...content));
  }
  // The hours a pass can take off now (SPEC §34): this one, at any point in it, and the next.
  const passChoices = () => (me.pass ? [me.pass.current || me.pass, me.pass.next].filter((x) => x && !x.already && !x.judged) : []);
  const passOffer = () => (me.progress && me.progress.passesLeft > 0 && writable() && passChoices().length && !me.me.leftAt ? me.progress.passesLeft : 0);
  function renderBanner() {
    const phase = me.party.phase;
    const prog = me.progress;
    const nowS = serverNow();
    const br = me.breaks.find((b) => b.startAt <= nowS && nowS < b.endAt);
    if (phase === 'ended') return setBanner(null); // the end card says it
    // SPEC §33: left the party (not "out"): quiet, with the way back.
    if (me.me.leftAt) {
      return setBanner('left', h('p', null, h('strong', null, `You left the party at ${fmtTime(me.me.leftAt)}`), ' · your words still count, but hours aren’t judged.'),
        h('button', { class: 'btn btn-quiet', type: 'button', onClick: () => setLeft(false) }, 'Back at the party'));
    }
    if (me.me.out && !dismissedOut) {
      const missed = /missed hour (\d+)/.exec(me.me.outReason || '');
      const lead = missed ? `You missed hour ${missed[1]}, so you’re out of the challenge.` : me.me.outReason === 'marked out by the host' ? 'The host marked you out of the challenge.' : 'You’re out of the challenge.';
      return setBanner('out', h('p', null, h('strong', null, lead), ' Writing and the live page keep working: your posts still appear there and go in the anthology. The host can bring you back in, but only for a very good reason.'),
        h('button', { class: 'btn btn-quiet', type: 'button', onClick: () => { dismissedOut = true; renderBanner(); refocus(); } }, 'Keep writing'));
    }
    if (br) {
      // Writing never stops for a break; the hour either pauses or asks for less.
      if (br.mode === 'reduce') {
        return setBanner('break', h('p', null, h('em', { class: 'w-banner-label' }, br.label), ` until ${fmtTime(br.endAt)} · this hour’s target is ${fmtInt(hourTarget())}. You can keep writing.`));
      }
      return setBanner('break', h('p', null, h('em', { class: 'w-banner-label' }, br.label), ` · your hour is paused until ${fmtTime(br.endAt)}. You can keep writing; nothing is required until then.`));
    }
    const cur = prog?.current;
    if (cur && !cur.free && cur.behind && !me.me.out) {
      const left = cur.endAt - nowS;
      for (const mark of [5, 15]) {
        const key = `${cur.k}:${mark}`;
        if (left <= mark * 60_000 && left > 0) {
          if (warned.has(key)) break;
          const have = cur.credited + (cur.pending || 0);
          const need = Math.max(0, Math.ceil(cur.target - have));
          const mins = Math.max(1, Math.round(left / 60000));
          const perMin = Math.ceil(need / mins);
          const passes = passOffer();
          const dismiss = () => { warned.add(key); if (mark === 5) warned.add(`${cur.k}:15`); renderBanner(); };
          return setBanner('warn',
            h('p', null, h('strong', null, `${plural(mins, 'minute')} left, ${plural(need, 'word')} to go`), `: about ${fmtInt(perMin)} a minute.`,
              passes ? ` Or take this hour off; you have ${passes === 1 ? '1 free hour' : `${passes} free hours`} left.` : ''),
            passes ? h('button', { class: 'btn btn-quiet', type: 'button', onClick: () => takePass() }, 'Take this hour off…') : null,
            h('button', { class: 'btn btn-quiet', type: 'button', onClick: dismiss }, 'Got it'));
        }
      }
    }
    if (phase === 'running' && sync.status().kind === 'closed') {
      return setBanner('warn', h('p', null, 'Some changes couldn’t be saved because the party ended. Copy them from the editor if you need them.'));
    }
    return setBanner(null);
  }

  // ---------------------------------------------------------------- progress
  // The footer: hour strip, a two-tone bar and a number that moves with every
  // keystroke. Solid = confirmed (settled) words; light = counting soon (settling,
  // plus an estimate of words typed here that the server hasn't seen yet).
  // Warnings, Out and the hour's verdict use the server's numbers only.
  let countEl = null;
  let barFill = null;
  let barSoon = null;
  let shown = null; // the number on screen: rises at once, eases down
  let easing = 0;
  function renderProgress() {
    const prog = me.progress;
    clear(progressBtn);
    countEl = null;
    barFill = null;
    barSoon = null;
    if (!prog || me.party.phase === 'lobby') {
      const planned = me.party.phase === 'lobby' && Number.isFinite(me.party.plannedStart) ? `Starts ${fmtWhen(me.party.plannedStart, serverNow())}` : null;
      progressBtn.append(h('span', { class: 'w-prog-text' }, me.party.phase === 'lobby' ? planned || 'Waiting for the start' : 'Your hour starts when you begin'));
      return;
    }
    // Your hours so far, one box each (labelled; the key is in Details; phones show it only there).
    progressBtn.append(h('span', { class: 'w-strip-label' }, 'Hours'), hourStrip(prog));
    const nowS = serverNow();
    const cur = prog.current;
    if (cur) {
      barSoon = h('span', { class: 'w-bar-pending' });
      barFill = h('span', { class: 'w-bar-fill' });
      const bar = h('span', { class: `w-bar ${cur.free ? 'is-free' : ''}`, role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': cur.target, 'aria-label': 'This hour' }, barSoon, barFill);
      const left = Math.max(0, cur.endAt - nowS);
      countEl = h('span', { class: 'w-count' });
      // "Hour 1 · ≈ 120 of 400 · until 20:00": what the number is, the number, then when it ends
      // (the hour's real window: a first hour can be shorter, pro-rated, or joined to the next).
      // The time comes last: on a narrow phone that's what gives way, never the number.
      const endAt = me.hour?.endAt || cur.endAt;
      let lead;
      let until = null; // ms: the time in the tail
      const br = me.breaks.find((b) => b.startAt <= nowS && nowS < b.endAt);
      if (me.me.out) lead = [h('span', { class: 'w-out' }, 'Out of the challenge'), ' · ']; // no countdown when out
      else if (cur.free) lead = [`Hour ${cur.k + 1} is a free hour · `];
      else if (br && br.mode === 'reduce') [lead, until] = [[`${br.label} · `], br.endAt];
      else if (br) [lead, until] = [[`${br.label} · paused · `], br.endAt];
      else if (cur.inBreak) lead = [`Hour ${cur.k + 1} · paused · `];
      else [lead, until] = [[`Hour ${cur.k + 1} `, firstHourKind(cur) ? h('span', { class: 'w-prog-more' }, `(${firstHourKind(cur)}) `) : null, '· '], endAt];
      const tail = until === null ? null : h('span', { class: 'w-prog-until' },
        ` · ${until === endAt && left <= 15 * 60_000 ? `${fmtDur(left)} left` : `until ${fmtTime(until)}`}`);
      const plain = cur.free || me.me.out; // no target: "≈ 120 words this hour"
      progressBtn.append(bar, h('span', { class: 'w-prog-text' }, ...lead, countEl,
        plain ? h('span', { class: 'w-prog-more' }, ' this hour') : null,
        !plain && cur.carriedIn >= 1 ? h('span', { class: 'w-prog-more' }, ` (${fmtInt(cur.carriedIn)} carried over)`) : null,
        !plain && cur.credited >= cur.target ? h('span', { class: 'w-met' }, ' · hour met') : null,
        reviewNote(prog),
        tail));
      paintCount();
    } else if (me.party.phase === 'ended') {
      progressBtn.append(h('span', { class: 'w-prog-text' }, `${plural(prog.met, 'hour')} met`));
    } else if (prog.leftNow) {
      // SPEC §33: away from the party, the words still count and show; the hour isn't judged.
      countEl = h('span', { class: 'w-count' });
      progressBtn.append(h('span', { class: 'w-prog-text' }, 'Left the party · ', countEl, h('span', { class: 'w-prog-more' }, ' this hour (not judged)')));
      paintCount();
    } else if (me.me.out) {
      progressBtn.append(h('span', { class: 'w-prog-text' }, h('span', { class: 'w-out' }, 'Out of the challenge')));
    }
  }
  // A first hour that isn't 60 minutes (synced hours, SPEC §17b): longer when the writer started
  // with too little of the hour left, shorter (with a smaller target) when they started mid-hour.
  const meHour = () => me.me?.hour ?? null; // the server's facts about this hour (SPEC §17b/§19)
  const firstHourKind = (c) => { const hr = meHour(); return hr && hr.index === c.k ? (hr.extended ? 'a long first hour' : hr.prorated ? 'a short first hour' : null) : null; };
  function firstHourNote(c) {
    const span = `${fmtTime(c.startAt)}–${fmtTime(c.endAt)}`;
    if (meHour()?.extended) return `Your first hour runs ${span}: you started with under ${me.settings.minFirstHourMin ?? 20} minutes left in that hour, so those minutes joined your first full hour.`;
    return `Your first hour runs ${span}, shorter than the others, so its target is ${fmtInt(hourTarget())} instead of ${fmtInt(meHour()?.baseTarget ?? me.settings.targetPerHour)}.`;
  }
  // Carryforward: words carried into this hour, and words over its target that go on to the next.
  function carryNote(c) {
    const cap = me.settings.carryOverMax ?? 0;
    if (!cap || c.left || me.me.out) return null;
    const into = Math.round(c.carriedIn || 0);
    const next = Math.round(c.carryNext || 0);
    const parts = [];
    if (into >= 1) parts.push(`${plural(into, 'word')} carried over from hour ${c.k}.`);
    if (next >= 1) parts.push(`So far ${plural(next, 'extra word')} ${next === 1 ? 'carries' : 'carry'} on to hour ${c.k + 2}${next >= cap ? ' (the most that can)' : ''}.`);
    else if (!c.free) parts.push(`Words over the target, up to ${fmtInt(cap)}, carry on to hour ${c.k + 2}.`);
    return h('p', { class: 'bd-small' }, parts.join(' '));
  }
  // Hours waiting for the host's check (an hour that reached its target only with flagged words).
  function reviewNote(prog) {
    const ks = prog.hours.filter((x) => x.status === 'review').map((x) => x.k + 1);
    return ks.length ? h('span', { class: 'w-prog-review' }, ` · ${ks.length === 1 ? `hour ${ks[0]}` : `hours ${ks.join(', ')}`} waiting for the host’s check`) : null;
  }
  // One box per hour, oldest first, with a pause mark for each break (and each box titled).
  const breaksShown = (nowS) => me.breaks.filter((b) => b.startAt < nowS + 3600_000 && b.endAt > (me.me.joinedAt || 0));
  function hourStrip(prog) {
    const nowS = serverNow();
    const strip = h('span', { class: 'w-strip', 'aria-hidden': 'true' });
    const items = [...prog.hours.map((x) => ({ at: x.startAt, el: h('i', { class: `seg seg-${x.status}`, title: `Hour ${x.k + 1}: ${statusLabel(x.status)}${['met', 'missed', 'review', 'settling'].includes(x.status) ? ` (${fmtInt(x.credited)} / ${fmtInt(x.target)}${x.carriedIn >= 1 ? `, ${fmtInt(x.carriedIn)} carried over` : ''})` : ''}` }) })),
      ...breaksShown(nowS).map((b) => ({ at: b.startAt, el: h('i', { class: 'seg seg-break', title: `${b.label}: ${fmtTime(b.startAt)}–${fmtTime(b.endAt)}` }) }))];
    items.sort((a, b) => a.at - b.at);
    for (const it of items) strip.append(it.el);
    return strip;
  }
  // The key to the boxes: only the kinds on show.
  const SEG_NAMES = { met: 'met', missed: 'missed', free: 'free hour', 'upcoming-free': 'free hour, coming', review: 'waiting for the host’s check', settling: 'still counting', current: 'this hour', partial: 'ended early', break: 'break', left: 'not judged (you left the party)' };
  function stripKey(prog) {
    const kinds = [...new Set(prog.hours.map((x) => x.status))];
    if (breaksShown(serverNow()).length) kinds.push('break');
    return h('ul', { class: 'bd-key', 'aria-hidden': 'true' }, kinds.map((k) => h('li', null, h('i', { class: `seg seg-${k}` }), SEG_NAMES[k] || statusLabel(k))));
  }

  // Words on the page that the server hasn't counted yet: the counted words in the
  // open editors now, minus that count when the server last confirmed an edit. The
  // count is kept per editor and moved by each edit's delta (only the lines it
  // touched are recounted), so a keystroke never rescans the document.
  const editorWords = new Map(); // editor -> counted words in it
  const editorAll = new Map(); // editor -> all words in it (the post's word count)
  let localWords = 0;
  let ackWords = 0;
  let ackNext = null; // the count at the latest ack, applied when the server's next numbers arrive
  function unconfirmedEstimate() {
    return localWords - ackWords;
  }
  function recountEditor(ed2) {
    const text = ed2.text;
    editorAll.set(ed2, countWords(text));
    const n = countedWords(text);
    const was = editorWords.get(ed2) ?? null;
    editorWords.set(ed2, n);
    if (was === null) {
      ackWords += n; // a newly opened editor holds nothing unconfirmed
      if (ackNext !== null) ackNext += n;
    }
    localWords += n - (was ?? 0);
  }
  // An ack means the server has the words; its counts include them from its next
  // progress update on, so that's when they leave the estimate (no dip in between).
  sync.onAck = () => {
    ackNext = localWords;
  };
  let paintQueued = false;
  function queuePaint() {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => {
      paintQueued = false;
      paintCount();
    });
  }
  const goalValue = (cur) => {
    const confirmed = Math.max(0, cur.credited || 0);
    return Math.max(confirmed, confirmed + (cur.pending || 0) + Math.max(0, unconfirmedEstimate()));
  };
  // The hour the footer counts: the running one, or (left the party, SPEC §33) this hour's words.
  const countHour = () => me.progress?.current || me.progress?.leftNow || null;
  function paintCount() {
    const cur = countHour();
    if (!cur || !countEl) return;
    const target = goalValue(cur);
    if (shown === null || target >= shown) {
      shown = target;
      if (easing) cancelAnimationFrame(easing);
      easing = 0;
      drawCount(cur);
    } else if (!easing) {
      easing = requestAnimationFrame(easeStep); // an estimate overshot: ease down, never jump
    }
  }
  function easeStep() {
    easing = 0;
    const cur = countHour();
    if (!cur || !countEl) return;
    const t = goalValue(cur);
    if (t >= shown || shown - t < 0.5) shown = t;
    else {
      shown = t + (shown - t) * 0.86;
      easing = requestAnimationFrame(easeStep);
    }
    drawCount(cur);
  }
  // The hour's target after any break reduction (and pro-rating), from the server.
  const hourTarget = () => me.hour?.target ?? me.progress?.current?.target ?? me.settings.targetPerHour;
  function drawCount(cur) {
    if (!countEl) return;
    const confirmed = Math.max(0, cur.credited || 0);
    const goal = hourTarget() || 0;
    const val = Math.round(shown ?? confirmed);
    const plain = cur.free || me.me.out || cur.left;
    const soon = val > Math.round(confirmed); // some of the number is still counting: "≈"
    const unit = plain ? ` ${val === 1 ? 'word' : 'words'}` : ` of ${fmtInt(goal)}`;
    const text = showExact
      ? (soon ? `${fmtInt(confirmed)} counted · ≈ ${fmtInt(val)}${unit}` : `${fmtInt(val)}${unit} · all counted`)
      : `${soon ? '≈ ' : ''}${fmtInt(val)}${unit}`;
    if (countEl.textContent !== text) countEl.textContent = text;
    if (barFill && goal > 0) {
      const solid = (Math.min(1, confirmed / goal) * 100).toFixed(1);
      const soon = (Math.min(1 - solid / 100, Math.max(0, (shown ?? confirmed) - confirmed) / goal) * 100).toFixed(1);
      const key = `${solid}|${soon}|${val}`;
      if (barFill.dataset.k !== key) {
        // Only when something changed: a style write per keystroke would cost a layout.
        barFill.dataset.k = key;
        barFill.style.width = `${solid}%`;
        barSoon.style.left = `${solid}%`;
        barSoon.style.width = `${soon}%`;
        barFill.parentNode.setAttribute('aria-valuenow', String(val));
        barFill.parentNode.classList.toggle('is-done', confirmed >= goal);
      }
    }
  }
  let showExact = false;
  try {
    showExact = localStorage.getItem('wh-exact') === '1';
  } catch { /* default off */ }

  // Words in the post (like any word counter): under the text and in the tab's tooltip.
  const postCount = h('p', { class: 'w-postcount' });
  bodyWrap.append(postCount); // editors go in before it
  let postCountTimer = null;
  function queuePostCount() {
    if (postCountTimer) return;
    postCountTimer = setTimeout(() => {
      postCountTimer = null;
      const p = byId(activeId);
      const ed = p && editors.get(p.id);
      if (!p || !ed) {
        postCount.textContent = '';
        return;
      }
      const n = Math.max(0, editorAll.get(ed.body) ?? 0); // kept per edit: no rescan of the post
      const text = n ? `Post length: ${plural(n, 'word')}` : '';
      if (postCount.textContent !== text) postCount.textContent = text; // a rewrite costs a style and layout pass
      const tab = tabsEl.querySelector('.w-tab.is-active .w-tab-btn');
      const tip = tab ? tabTip(p, n) : '';
      if (tab && tab.title !== tip) tab.title = tip;
    }, 350);
  }
  // The footer counts the hour; "Post length" counts the post. Once per device, when writing
  // first begins, a line above the footer says what the hour total is (delay from settings).
  let tipShown = false;
  let tipEl = null;
  let tipTimer = 0;
  function closeCountTip() {
    clearTimeout(tipTimer);
    tipEl?.remove();
    tipEl = null;
  }
  function showCountTip() {
    if (tipShown || !me.progress?.current || !writable()) return;
    tipShown = true;
    try {
      if (localStorage.getItem('wh-count-tip')) return;
      localStorage.setItem('wh-count-tip', '1');
    } catch { /* no storage: once on this page */ }
    const secs = Math.round(me.settings.settleSec ?? 90);
    tipEl = h('div', { class: 'w-tip', role: 'status' },
      h('p', null, `Your hour total includes new writing across your posts and planning notes. New words take ${plural(secs, 'second')} to count.`),
      h('button', { class: 'w-tip-ok', type: 'button', onClick: () => { closeCountTip(); refocus(); } }, 'Got it'));
    foot.append(tipEl);
    // The arrow points at the number (measured once, now; nothing per keystroke).
    const c = countEl?.getBoundingClientRect();
    const t = tipEl.getBoundingClientRect();
    if (c && c.width && t.width) tipEl.style.setProperty('--tip-arrow', `${Math.round(Math.min(t.width - 24, Math.max(14, c.left + c.width / 2 - t.left - 5)))}px`);
    tipTimer = setTimeout(closeCountTip, 45_000);
  }
  function statusLabel(s) {
    return { met: 'met', missed: 'missed', free: 'free', review: 'waiting for the host’s check', settling: 'settling', current: 'in progress', partial: 'ended early', 'upcoming-free': 'free (upcoming)', left: 'not judged (you left the party)' }[s] || s;
  }

  progressBtn.addEventListener('click', () => openBreakdown());
  function openBreakdown() {
    const prog = me.progress;
    if (!prog) return;
    closeCountTip();
    const cur = prog.current || prog.leftNow; // away from the party: this hour's words, not judged (SPEC §33)
    const cb = prog.currentBreakdown;
    const tot = prog.totals;
    const ncList = (b) => {
      const rows = Object.entries(REASON_LABELS).filter(([k]) => b && b.nc[k] >= 0.5).map(([k, [label, desc]]) => h('li', null,
        h('span', { class: 'bd-label', title: desc }, label), h('span', { class: 'bd-num' }, fmtInt(b.nc[k])), h('span', { class: 'bd-desc' }, desc)));
      return rows.length ? h('ul', { class: 'bd-nc' }, rows) : h('p', { class: 'bd-none' }, 'Nothing so far.');
    };
    // Zero rows are hidden; negatives get a true minus.
    const num = (v) => (v < -0.5 ? `−${fmtInt(-v)}` : fmtInt(v));
    const row = (label, val, cls = '', always = false) => (always || Math.abs(val || 0) >= 0.5 ? h('div', { class: `bd-row ${cls}` }, h('span', null, label), h('span', { class: 'bd-num' }, num(val))) : null);
    const passBtn = passOffer() && me.party.phase === 'running'
      ? h('button', { class: 'btn btn-quiet', type: 'button', onClick: () => { dlg.close(); takePass(); } }, 'Take this hour off…') : null;
    const credit = (b) => h('div', { class: 'bd-grid' },
      row('Written', b.written, '', true), row('Pasted (yours, today)', b.pasted), row('Cut', b.cut), row('Food form', b.bonus),
      b.carried ? row(`Carried over from hour ${cur.k}`, b.carried) : null);
    const inReview = prog.hours.filter((x) => x.status === 'review');
    // The number the footer shows, and what it's made of: counted, and counting soon.
    const hourStory = (c) => {
      const counted = Math.max(0, Math.round(c.credited || 0));
      const total = Math.max(counted, Math.round(shown ?? goalValue(c)));
      const soon = total - counted;
      const plainHour = c.free || me.me.out || c.left;
      return [
        h('p', { class: 'bd-big' }, h('strong', null, `${soon ? '≈ ' : ''}${fmtInt(total)}`), plainHour ? ` ${total === 1 ? 'word' : 'words'} this hour${c.free ? ' (a free hour)' : c.left ? ' (not judged: you left the party)' : ''}` : ` of ${fmtInt(hourTarget())} this hour`),
        soon ? h('p', { class: 'bd-sum' }, `= ${fmtInt(counted)} counted + ${fmtInt(soon)} counting soon`) : null,
        soon ? h('p', { class: 'bd-small' }, `New words count once they’ve stayed on the page for ${Math.round(me.settings.settleSec)} seconds.`) : null,
        firstHourKind(c) ? h('p', { class: 'bd-small' }, firstHourNote(c)) : null,
        carryNote(c),
      ];
    };
    const body = h('div', { class: 'bd' },
      cur ? h('section', null,
        h('h3', null, `Hour ${cur.k + 1}${firstHourKind(cur) ? ` (${firstHourKind(cur)})` : ''}`, h('span', { class: 'bd-when' }, `${fmtTime(cur.startAt)}–${fmtTime(cur.endAt)}`)),
        ...hourStory(cur),
        cb ? credit(cb) : null,
        h('h4', null, 'Not counted this hour'),
        ncList(cb)) : null,
      h('section', null,
        h('h3', null, 'Today'),
        h('div', { class: 'bd-grid' }, row('Written', tot.written, '', true), row('Pasted (yours, today)', tot.pasted), row('Cut', tot.cut), row('Food form', tot.bonus), row('Total', tot.credit, 'bd-total', true)),
        h('div', { class: 'bd-hours' }, prog.hours.length ? hourStrip(prog) : null,
          h('span', null, `${plural(prog.met, 'hour')} met so far.${prog.review ? ` ${plural(prog.review, 'hour')} waiting for the host’s check.` : ''}`),
          me.me.out ? h('span', { class: 'pill pill-out' }, 'Out of the challenge') : null),
        prog.hours.length ? stripKey(prog) : null,
        me.me.out ? h('p', { class: 'bd-small' }, 'You can keep writing: your posts still appear on the live page and go in the anthology. The host can bring you back in, but only for a very good reason.') : null,
        inReview.length ? h('p', { class: 'bd-small' }, `${inReview.map((x) => `Hour ${x.k + 1}`).join(', ')} ${inReview.length === 1 ? 'is' : 'are'} waiting for the host’s check: ${inReview.length === 1 ? 'it' : 'they'} reached the target only with words the checks flagged (for example a big paste). It doesn’t put you out.`) : null,
        prog.personalFactor ? h('p', { class: 'bd-small' }, `Your target after hour 1 is ${Math.round(prog.personalFactor * 100)}% of the default, based on how much you edit compared with everyone else.`) : null,
        me.me.targetOverride !== null && me.me.targetOverride !== undefined ? h('p', { class: 'bd-small' }, `The host set your target to ${fmtInt(me.me.targetOverride)}.`) : null),
      h('section', { class: 'bd-how' },
        h('h3', null, 'How your words count'),
        h('ol', { class: 'w-rules w-rules-small' }, ruleList(me.settings).map((r) => h('li', null, r)))),
      h('div', { class: 'bd-foot' },
        me.party.phase === 'ended' ? h('span') : h('span', null, prog.passesLeft === 1 ? '1 free hour left' : `${prog.passesLeft} free hours left`),
        passBtn));
    const dlg = modal({ title: 'Details', body, className: 'modal-breakdown', onClose: refocus, actions: [{ label: 'Close', value: null }] });
  }

  // SPEC §33: leaving the party isn't being out: hours stop being judged (words still count) until "Back at the party".
  function setLeft(left) {
    const send = () => api('/api/me/left', { left })
      .then(() => toast(left ? 'You’ve left the party. Come back any time.' : 'Welcome back: your hours are judged again.'))
      .catch((e) => toast(e.message, { kind: 'error' }));
    if (!left) return send();
    const min = me.settings.minFirstHourMin ?? 20;
    modal({
      onClose: refocus,
      title: 'Leave the party?',
      body: h('div', null,
        h('p', null, 'From this hour on, your hours aren’t judged: no hour is met or missed. Your words still count and show, nothing you’ve written changes, and you can come back.'),
        h('p', { class: 'muted' }, `You won’t be out of the challenge. Come back with “Back at the party” in this menu: with ${min} minutes or more left in that hour, it’s judged with a smaller target; otherwise judging starts again with the next hour.`)),
      actions: [
        { label: 'Cancel', quiet: true },
        { label: 'Leave the party', primary: true, onClick: send },
      ],
    });
  }
  // SPEC §34: a pass takes this hour off (the default, at any point in it) or the next one.
  async function takePass() {
    const pv = me.pass;
    if (!pv) return;
    const options = [['current', 'This hour', pv.current || pv], ['next', 'The next hour', pv.next]].filter(([, , x]) => x);
    let pick = (options.find(([, , x]) => !x.already && !x.judged) || [])[0];
    if (!pick) return;
    const radios = options.map(([key, label, x]) => {
      const off = !!(x.already || x.judged);
      const r = h('input', { type: 'radio', name: 'w-pass-hour', value: key, checked: key === pick, disabled: off });
      r.addEventListener('change', () => { if (r.checked) pick = key; });
      return h('label', { class: 'h-radio' }, r, h('span', null, h('b', null, `${label} (${fmtTime(x.startAt)}–${fmtTime(x.endAt)})`),
        h('small', null, off ? (x.already ? 'Already a free hour.' : 'Already judged.') : `Hour ${x.k + 1} won’t be required. ${plural(pv.left, 'free hour')} left; this uses one.`)));
    });
    modal({
      onClose: refocus,
      title: 'Take an hour off?',
      body: h('div', null,
        h('fieldset', { class: 'h-break-modes' }, h('legend', null, 'Which hour?'), radios),
        h('p', { class: 'muted' }, 'Anything you write still counts and publishes.')),
      actions: [
        { label: 'Cancel', quiet: true },
        {
          label: 'Use a pass', primary: true,
          onClick: () => {
            const x = options.find(([key]) => key === pick)[2];
            api('/api/pass', { which: pick, k: x.k }).then(() => toast(`Hour ${x.k + 1} is a free hour.`)).catch((e) => toast(e.message, { kind: 'error' }));
          },
        },
      ],
    });
  }

  // ---------------------------------------------------------------- save status
  // "Saving…" only shows when a save takes a while: flickering every keystroke isn't calm.
  let savingTimer = null;
  function renderSave(s) {
    if (s.kind === 'saving') {
      if (!savingTimer && !saveEl.classList.contains('is-saving')) {
        savingTimer = setTimeout(() => {
          savingTimer = null;
          const now = sync.status();
          if (now.kind === 'saving') paintSave(now);
        }, 2500);
      }
      return;
    }
    clearTimeout(savingTimer);
    savingTimer = null;
    paintSave(s);
  }
  function paintSave(s) {
    const map = {
      saved: ['Saved', 'Saved', 'is-saved'],
      saving: ['Saving…', 'Saving…', 'is-saving'],
      offline: ['Offline. Your writing is kept on this device and will sync when you’re back.', 'Offline', 'is-offline'],
      error: ['Couldn’t save; retrying', 'Retrying', 'is-error'],
      closed: ['Not saved: the party has ended', 'Not saved', 'is-error'],
      reason: ['Not saved yet: removing a large part needs a short reason', 'Needs a reason', 'is-error'],
      auth: ['Signed out: sign in again to save', 'Signed out', 'is-error'],
    };
    const [label, short, cls] = map[s.kind] || map.saved;
    if (s.kind === 'saved' && !edited) {
      clear(saveEl);
      saveEl.className = 'w-save';
      return;
    }
    fill(saveEl, h('span', { class: 'w-save-long' }, label), h('span', { class: 'w-save-short', 'aria-hidden': 'true' }, short));
    saveEl.className = `w-save ${cls}`;
    saveEl.title = label;
    if (s.kind === 'auth') setTimeout(() => { location.href = '/login'; }, 4000);
  }

  // ---------------------------------------------------------------- menu
  meBtn.addEventListener('click', () => {
    const closed = posts.filter((p) => p.closed);
    const p = byId(activeId);
    const theme = getTheme();
    menu(meBtn, [
      helpMod ? { label: 'How it works', onClick: () => helpMod.openHelp() } : null,
      helpMod ? '-' : null,
      { heading: me.me.name },
      { label: 'Your account…', hint: me.me.hasEmail === false ? 'Add your email' : null, onClick: () => import('./account.js').then((m) => m.openAccount({ returnFocus: meBtn, focus: me.me.hasEmail === false ? 'email' : null }), () => toast('You seem to be offline. Try again when you’re back.', { kind: 'warn' })) },
      // SPEC §28b: their personal page, where they star their pieces; off the list, the way on.
      me.me.page === undefined ? null : me.me.page
        ? { label: 'My page', hint: 'star posts there', onClick: () => window.open(`/w/${encodeURIComponent(me.me.page)}`, '_blank', 'noopener') }
        : { label: 'My page (join the writers list first)', onClick: () => import('./account.js').then((m) => m.openAccount({ returnFocus: meBtn }), () => toast('You seem to be offline. Try again when you’re back.', { kind: 'warn' })) },
      p ? { label: 'Copy for LessWrong, Substack or Google Docs', onClick: () => copyForWeb(p) } : null,
      p ? { label: 'Export this post…', onClick: () => exportDialog(false) } : null,
      posts.length ? { label: 'Export all my posts…', onClick: () => exportDialog(true) } : null,
      // Their posts from earlier rounds (lib/rounds.js), to read, copy or download.
      me.me.pastPosts > 0 ? { label: 'My earlier rounds', hint: plural(me.me.pastPosts, 'post'), onClick: () => window.open('/past', '_blank', 'noopener') } : null,
      writable() ? { label: 'Open a file as a new post…', onClick: () => openFile() } : null,
      writable() && p ? { label: 'Brainstorm…', hint: 'before you start', onClick: () => openBrainstormPanel() } : null,
      { label: 'Food preferences…', onClick: () => import('./food.js').then((m) => m.openFoodSheet({ returnFocus: meBtn }), () => toast('You seem to be offline. Try again when you’re back.', { kind: 'warn' })) },
      notifyMod ? { label: 'Notifications…', onClick: () => notifyMod.askPushPermission('menu') } : null,
      installMod && !installMod.isStandalone?.() ? { label: 'Add to Home Screen', onClick: () => installMod.openInstallHelp({ returnFocus: meBtn }) } : null,
      closed.length ? '-' : null,
      closed.length ? { heading: 'Closed posts' } : null,
      ...closed.map((c) => (me.party.phase === 'ended' && c.privacy !== 'private'
        ? { label: c.title || 'Untitled', hint: 'Make private…', onClick: () => privacyAfterParty(c, 'private') } // after the end: with a reason
        : { label: c.title || 'Untitled', hint: 'Reopen', onClick: () => reopenPost(c) })),
      passOffer() ? '-' : null,
      passOffer() ? { heading: 'This hour' } : null,
      passOffer() ? { label: 'Take this hour off…', hint: passOffer() === 1 ? '1 free hour left' : `${passOffer()} free hours left`, onClick: () => takePass() } : null,
      me.party.phase === 'running' ? '-' : null,
      me.party.phase === 'running' ? (me.me.leftAt ? { label: 'Back at the party', onClick: () => setLeft(false) } : { label: 'I’m leaving the party…', onClick: () => setLeft(true) }) : null,
      '-',
      {
        node: h('button', {
          class: 'menu-item menu-rich menu-exact', type: 'button', role: 'menuitemcheckbox', 'aria-checked': showExact ? 'true' : 'false',
          onClick: () => { document.querySelector('.menu-pop')?.__close(); showExact = !showExact; try { localStorage.setItem('wh-exact', showExact ? '1' : '0'); } catch { /* ignore */ } paintCount(); },
        },
        h('span', { class: 'menu-label' }, 'Show exact count', h('span', { class: 'menu-hint' }, showExact ? 'On' : 'Off')),
        h('span', { class: 'menu-desc' }, 'In the footer, the words counted so far too: “33 counted · ≈\u00a0105 of 400”.')),
      },
      { label: 'Smart punctuation', hint: smartPunctuation() ? 'On' : 'Off', onClick: () => { setSmartPunctuation(!smartPunctuation()); toast(`Smart punctuation ${smartPunctuation() ? 'on' : 'off'}`); } },
      { label: 'Theme', hint: { system: 'System', light: 'Light', dark: 'Dark' }[theme], onClick: () => setTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system') },
      '-',
      { label: 'Live page', onClick: () => window.open('/live', '_blank', 'noopener') },
      me.me.isAdmin ? { label: 'Host dashboard', onClick: () => { location.href = '/host'; } } : null,
      { label: 'Sign out', onClick: () => signOut() },
    ], { align: 'right', onClose: refocus });
  });

  async function signOut() {
    if (sync.pendingCount()) {
      sync.flush();
      toast('Saving your last changes first…');
      await new Promise((r) => setTimeout(r, 1500));
      if (sync.pendingCount()) {
        toast('Some changes aren’t saved yet. They stay on this device until you sign in again.', { kind: 'warn', ms: 6000 });
      }
    }
    await api('/api/logout', {}).catch(() => {});
    forgetSession();
    await clearBoot(me.me.id);
    location.href = '/';
  }

  function currentDoc(p) {
    const ed = editors.get(p.id);
    return { title: p.title || 'Untitled', body: ed ? ed.body.text : paneText(p, 'body') };
  }
  // The text only: LessWrong, Substack and Google Docs have their own title field.
  // The ClipboardItem is created inside the click (iOS Safari needs the gesture);
  // its contents follow once the converter has loaded.
  function copyForWeb(p) {
    const d = currentDoc(p);
    const done = (ok) => toast(ok ? 'Copied with formatting. Paste it into LessWrong, Substack or Google Docs; the title goes in their title field.' : 'Couldn’t copy. Select the text and copy it instead.', { kind: ok ? 'info' : 'error', ms: 4500 });
    const fallback = () => io().then((x) => (x ? x.copyRich(d.body) : false)).catch(() => false).then(done);
    if (typeof ClipboardItem === 'function' && navigator.clipboard && typeof navigator.clipboard.write === 'function') {
      try {
        const data = io().then((x) => {
          if (!x) throw new Error('no converter');
          // fillClipboard writes the same rich HTML + Markdown a copy (Ctrl+C) gets.
          const out = {};
          x.fillClipboard({ setData: (type, v) => { out[type] = v; } }, d.body);
          if (!out['text/html']) throw new Error('no html');
          return { html: out['text/html'], plain: out['text/plain'] ?? d.body };
        });
        const item = new ClipboardItem({
          'text/html': data.then((r) => new Blob([r.html], { type: 'text/html' })),
          'text/plain': data.then((r) => new Blob([r.plain], { type: 'text/plain' })),
        });
        navigator.clipboard.write([item]).then(() => done(true), fallback);
        return;
      } catch { /* older browsers: below */ }
    }
    fallback();
  }
  function exportDialog(all) {
    const p = byId(activeId);
    // Six tiles either way (no empty grid cell): the rich copy first for one post, the e-book for all.
    const formats = [...(all ? [] : [['copy', 'Copy for LessWrong, Substack or Google Docs', 'with formatting']]), ['md', 'Markdown', '.md'], ['txt', 'Plain text', '.txt'], ['html', 'Web page', '.html'], ['docx', 'Word', '.docx'], ['pdf', 'PDF (via Print)', '.pdf'], ...(all ? [['epub', 'E-book', '.epub']] : [])];
    const go = async (fmt) => {
      const x = await io();
      if (!x) {
        toast('Couldn’t load the exporter. Check your connection.', { kind: 'error' });
        return;
      }
      try {
        if (all) {
          const list = posts.filter((x) => (editors.get(x.id)?.body.text ?? paneText(x, 'body')).trim()).map((x) => currentDoc(x));
          if (!list.length) {
            toast('Nothing to export yet.');
            return;
          }
          await x.exportAll(list, fmt, `${me.party.name}: ${me.me.name}`);
        } else await x.exportPost(currentDoc(p), fmt);
      } catch (e) {
        toast(e.message || 'Export failed', { kind: 'error' });
      }
    };
    const body = h('div', { class: 'export-grid' }, formats.map(([fmt, label, ext]) => h('button', { class: `export-btn ${fmt === 'copy' ? 'export-copy' : ''}`, type: 'button', onClick: () => { dlg.close(); if (fmt === 'copy') copyForWeb(p); else go(fmt); } },
      h('span', { class: 'export-label' }, label), h('span', { class: 'export-ext' }, ext))));
    const dlg = modal({ title: all ? 'Export all your posts' : `Export “${p?.title || 'Untitled'}”`, body, onClose: refocus, actions: [{ label: 'Cancel', quiet: true }] });
  }
  function openFile() {
    const input = h('input', { type: 'file', accept: '.md,.markdown,.txt,.docx,.html,.htm,text/plain,text/markdown,text/html', hidden: true });
    input.addEventListener('change', async () => {
      const f = input.files && input.files[0];
      input.remove();
      if (!f) return;
      const x = await io();
      let res;
      try {
        if (!x) throw new Error('Couldn’t load the file reader. Check your connection.');
        res = await x.importFile(f);
      } catch (e) {
        toast(e.message || 'Can’t read that file', { kind: 'error' });
        return;
      }
      const r = await attributeText(res.markdown);
      if (!r) return;
      // An untouched, untitled post is reused instead of leaving an empty tab behind.
      const cur = byId(activeId);
      const blank = cur && !cur.title && !(editors.get(cur.id)?.body.text || paneText(cur, 'body'));
      const post = blank ? cur : await newPost(res.title || '');
      if (!post) return;
      if (blank && res.title) {
        api('/api/post/update', { id: post.id, title: res.title }).catch(() => {});
      }
      if (res.title) {
        titleIn.value = res.title;
        post.title = res.title;
        renderTabs();
      }
      editorsFor(post).body.insertAttributed(r.text, { ...r.meta, d: r.meta.d === 'yes' || r.meta.d === 'no' ? r.meta.d : r.meta.d }, 0);
    });
    document.body.append(input);
    input.click();
  }

  // ---------------------------------------------------------------- live updates
  function onMe(v) {
    const was = me.party.phase;
    skew = v.serverNow - Date.now();
    me = v;
    if (meBtn.textContent !== v.me.name) meBtn.textContent = v.me.name; // renamed here or by a host (SPEC §25)
    meBtn.classList.toggle('needs-email', v.me.hasEmail === false); // a quiet dot until there's an email (SPEC §25b)
    if (ackNext !== null) {
      ackWords = ackNext;
      ackNext = null;
    }
    saveBootSoon();
    // Posts changed elsewhere (another window, the host).
    for (const meta of v.posts) {
      const p = byId(meta.id);
      if (!p) continue;
      if (p.privacy !== meta.privacy || p.unlisted !== meta.unlisted || p.closed !== meta.closed) {
        Object.assign(p, { privacy: meta.privacy, unlisted: meta.unlisted, closed: meta.closed });
        if (p.closed && p.id === activeId) showPost(openPosts()[0]?.id);
      }
      p.reasoned = !!meta.reasoned; // after the party: the post's session carries a reason (SPEC §30)
      p.added = !!meta.added; // started after the end
      if (meta.title !== p.title && !titlePending.has(p.id) && !(p.id === activeId && document.activeElement === titleIn)) {
        p.title = meta.title; // renamed in another window
        if (p.id === activeId) titleIn.value = meta.title;
      }
      // Never create a pane from a stream event: only panes opened from the server's text exist.
      for (const pane of ['body', 'notes']) sync.get(p.id, pane)?.remoteVersion(meta.ver[pane]);
    }
    serverOrder = v.posts.map((m) => m.id); // the tab order (SPEC §29): moved on another device
    applyServerOrder(serverOrder);
    const missing = v.posts.filter((m) => !byId(m.id));
    if (missing.length) reloadPosts();
    if (was !== v.party.phase) onPhase(was, v.party.phase);
    renderTabs();
    renderPrivacy();
    renderAfterBar();
    renderProgress();
    renderBanner();
  }
  async function reloadPosts() {
    try {
      const r = await api('/api/posts');
      for (const p of r.posts) {
        if (!byId(p.id)) {
          p.textKnown = true;
          posts.push(p);
          await initPanes(p);
        }
      }
      applyServerOrder(r.posts.map((p) => p.id)); // in the writer's order
      renderTabs();
    } catch { /* later */ }
  }
  async function onPhase(was, now) {
    if (now === 'running') {
      if (!me.me.isAdmin) await api('/api/join', {}).catch(() => {});
      if (!openPosts().length) await newPost();
      else showPost(activeId);
      toast('The party has started. Write well!');
      offerBrainstorm();
    }
    renderMain();
    syncBrainstormOpener();
  }

  // ---------------------------------------------------------------- boot
  loadInterop().catch(() => {});
  for (const p of posts) await initPanes(p);
  if (me.party.phase === 'running' && !offlineStart) {
    // Hosts aren't on the clock until they actually write (their first keystroke starts it).
    if (!me.me.isAdmin) await api('/api/join', {}).catch(() => {});
    if (!openPosts().length) await newPost();
  }
  showPost(activeId);
  renderProgress();
  renderBanner();
  renderSave(sync.status());
  const p0 = byId(activeId);
  if (p0 && writable()) editorsFor(p0).body.focus();
  if (notesOpen) toggleNotes(true);
  sync.onBaseKnown = () => renderMain();
  offerBrainstorm();

  // Live updates start only now that every pane exists with the server's text:
  // a stream event can't race the start-up any more.
  stream('/api/me/events', { me: onMe }, (st) => {
    if (st === 'error') renderSave({ kind: navigator.onLine ? sync.status().kind : 'offline', pending: sync.pendingCount() });
  });
  setInterval(() => {
    renderProgress();
    renderBanner();
  }, 15_000);
  setInterval(() => {
    // Minute-level countdown granularity is enough; keep warnings timely.
    if (me.progress?.current && me.progress.current.endAt - serverNow() < 16 * 60_000) renderBanner();
  }, 5000);

  // What this page needs to open again without a network: kept on the device.
  const bootData = () => ({
    me, skew,
    posts: posts.map((p) => ({ id: p.id, title: p.title, privacy: p.privacy, unlisted: p.unlisted, closed: p.closed, ver: p.ver })),
  });
  let bootTimer = null;
  saveBootSoon = (ms = 20_000) => {
    if (bootTimer) return;
    bootTimer = setTimeout(() => {
      bootTimer = null;
      sync.saveBoot(bootData());
    }, ms);
  };
  if (!offlineStart) saveBootSoon(1500);
  window.addEventListener('pagehide', () => sync.saveBoot(bootData()));
  // A page restored from the back/forward cache reloads: its queue may have been adopted meanwhile.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) location.reload();
  });
  window.addEventListener('beforeunload', (e) => {
    if (sync.pendingCount() && !navigator.onLine) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  registerServiceWorker();
  // Modules that ship separately, loaded once the page is up.
  import('./help.js').then((m) => {
    if (typeof m.openHelp !== 'function') return;
    helpMod = m;
    syncBrainstormOpener();
  }).catch(() => {});
  import('./install.js').then((m) => { if (typeof m.openInstallHelp === 'function') installMod = m; }).catch(() => {});
  import('./notify.js').then((m) => { if (typeof m.askPushPermission === 'function') notifyMod = m; }).catch(() => {}); // the menu's "Notifications…"
  // Food (SPEC §18): a one-time "Food tonight" row for anyone who hasn't answered yet.
  import('./food.js').then((m) => m.mountFoodNudge?.({ after: banner, userId: me.me.id, returnFocus: meBtn, active: () => me.party.phase !== 'ended' })).catch(() => {});
  import('./richtext.js').then((m) => {
    try {
      m?.install?.();
    } catch (e) {
      console.error(e);
    }
  }).catch(() => {});
  return { sync };
}


// The offline app shell (public/sw.js), versioned like every other asset.
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const src = document.querySelector('script[src*="/js/app.js?v="]')?.getAttribute('src') || '';
  const v = (/[?&]v=([\w-]+)/.exec(src) || [])[1];
  if (!v) return;
  const go = () => navigator.serviceWorker.register(`/sw.js?v=${v}`, { scope: '/', updateViaCache: 'none' }).catch(() => {});
  if (typeof requestIdleCallback === 'function') requestIdleCallback(go, { timeout: 8000 });
  else setTimeout(go, 3000);
}
