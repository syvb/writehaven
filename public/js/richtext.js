// Rich text in the writer's editor (SPEC §14). The text stays Markdown: every command here is a
// CodeMirror transaction on the Markdown source, so ops, sync, scoring and exports are unchanged.
//
//   - Formatting: Bold, Italic, Heading (H2 → H3 → off), bulleted and numbered lists, quote, link,
//     image, undo, redo. Desktop: a small bar floats above a selection; Ctrl/Cmd+B, I, K and
//     Ctrl/Cmd+Shift+7/8. Phones: a bar docked just above the on-screen keyboard (below the
//     writer's footer, in its own row of the page grid, so it never covers the text or the
//     footer); hideable with the chevron (remembered on this device) but always shown while text
//     is selected. Backspace right after a list marker ends the list item.
//   - Links render as links (bare http(s) addresses too, as on the public pages); tapping one
//     shows Open · Edit · Remove. Link syntax stays hidden, on the caret's line too: the arrow
//     keys cross it in one step, stopping just inside the link's text (lit while the caret is
//     there, so typing visibly goes into the link) and just outside it; deleting never leaves
//     part of it behind.
//   - Images: paste, drop, or the Image button (camera allowed). Each is shrunk and re-encoded on
//     the device (images.js: no EXIF/GPS leaves it), shown as a placeholder with progress while
//     it uploads (queued while offline, retried on failure, never blocking typing), then
//     inserted as ![alt](/u/<name>.<ext>#w=<w>&h=<h>) and shown inline; tap it to describe it
//     (alt text, shown as its caption) or remove it.
//   - Footnotes (SPEC §31): "[^1]" shows as a small superscript number off the caret's line
//     (numbered by first use; clicking it goes to the note), and "[^1]: …" notes get a quiet
//     style (clicking a note's number goes back to the text). "Add footnote" (Ctrl/Cmd+Alt+F)
//     puts a reference at the caret with the number of its place (later ones go up by one), its
//     note in its place among the notes at the end, and the caret there. Notes at the end that
//     aren't in the order of their numbers get a quiet "Put notes in order" above them.
//     Enter in a note continues it on an indented line; Enter on that line left empty ends the
//     note; Shift+Enter starts a new paragraph in it.
// Loaded by write.js, which calls install() once.

import {
  EditorState, EditorView, EditorSelection, StateField, StateEffect, Decoration, WidgetType, ViewPlugin, keymap, Prec,
  syntaxTree, undo, redo, Transaction, defaultKeymap,
} from '../vendor/cm.js';
import { addEditorExtension, openEditors, PasteMeta, Remote, OpPlan } from './editor.js';
import { countWords } from './text.js';
import { prepareImage, uploadBlob, describeUploadError } from './images.js';
import { footnotes, FN_DEF, FN_REF, maskCode, orderFootnotes, notesOutOfOrder } from './footnotes.js';
import { h, toast } from './ui.js';

// Uploaded images, as the public pages recognise them (md-render.js).
const UPLOAD_SRC = /^\/u\/[A-Za-z0-9_-]{6,80}\.(?:webp|png|jpe?g|gif)(?:#[^\s)]*)?$/i;
const WEB_URL = /^(?:https?:\/\/|mailto:)/i;
const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
const PREF_KEY = 'wh-format-bar';
const ANDROID = typeof navigator !== 'undefined' && /Android\b/.test(navigator.userAgent || '');

// ---------------------------------------------------------------- the shared UI state
const ui = {
  installed: false,
  view: null, // the editor the tools act on (the last one focused)
  phone: false, // touch-first device: docked bar instead of the floating one
  collapsed: false, // phone bar hidden with the chevron
  selecting: false, // a mouse button is down in an editor (desktop): no bar until it's up
  pressing: false, // a mouse button or a finger is down in the text (see linkLit)
  pressTimer: 0,
  pop: null, // the open popover: { kind, view, el, range, close() }
  float: null,
  dock: null,
  fileInput: null,
  pickFor: null,
  pair: null, // an empty ** ** pair waiting for text: { view, pos }
  insert: null, // desktop: the image button beside an empty line
  insertTimer: 0,
  raf: 0,
  kb: false, // on-screen keyboard open (heuristic)
  maxVvH: 0,
  vvW: 0,
};

const isEditable = (view) => !!view && !view.state.readOnly;
const visible = (view) => !!view && view.dom.isConnected && view.dom.getClientRects().length > 0;
// "Mod-Shift-Z" -> "⇧⌘Z" on a Mac (Apple's order: ⌃⌥⇧⌘), "Ctrl+Shift+Z" elsewhere.
const shortcut = (k) => {
  const parts = k.split('-');
  const key = parts.pop();
  if (!MAC) return [...parts.map((p) => (p === 'Mod' ? 'Ctrl' : p)), key].join('+');
  const sym = { Alt: '⌥', Shift: '⇧', Mod: '⌘' };
  return ['Alt', 'Shift', 'Mod'].filter((m) => parts.includes(m)).map((m) => sym[m]).join('') + key;
};

// ---------------------------------------------------------------- Markdown helpers
function nodeOfType(state, pos, name, side = 0) {
  for (let n = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) if (n.name === name) return n;
  return null;
}
// The innermost `name` node whose content holds pos (between its opening and closing marks).
function emphasisAt(state, pos, name) {
  for (const side of [1, -1]) {
    for (let n = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) {
      if (n.name !== name) continue;
      const m = marksOf(n);
      if (m && pos >= m.open.to && pos <= m.close.from) return n;
    }
  }
  return null;
}
function marksOf(node) {
  const a = node.firstChild;
  const b = node.lastChild;
  if (!a || !b || a.name !== 'EmphasisMark' || b.name !== 'EmphasisMark' || a.from === b.from) return null;
  return { open: { from: a.from, to: a.to }, close: { from: b.from, to: b.to } };
}
const WORDISH = /[\p{L}\p{N}\p{M}'’]/u;
function wordAt(state, pos) {
  const line = state.doc.lineAt(pos);
  const t = line.text;
  let a = pos - line.from;
  let b = a;
  while (a > 0 && WORDISH.test(t[a - 1])) a--;
  while (b < t.length && WORDISH.test(t[b])) b++;
  while (a < b && /['’]/.test(t[a])) a++;
  while (b > a && /['’]/.test(t[b - 1])) b--;
  if (a >= b || a === pos - line.from || b === pos - line.from) return null; // the caret must be inside the word
  return { from: line.from + a, to: line.from + b };
}

// A line's block markup: indentation, quote marks, a list marker, heading hashes.
const LINE_RE = /^(\s*)((?:>[ \t]?)*)([ \t]*)(?:([-*+])([ \t]+|$)|(\d{1,9})([.)])([ \t]+|$))?(?:(#{1,6})([ \t]+|$))?/;
export function parseLine(text) {
  const m = LINE_RE.exec(text);
  const indent = m[1].length;
  const afterQuote = indent + m[2].length + m[3].length;
  let pos = afterQuote;
  let bullet = null;
  let ordered = null;
  if (m[4]) bullet = { from: pos, to: (pos += m[4].length + m[5].length) };
  else if (m[6]) ordered = { from: pos, to: (pos += m[6].length + m[7].length + m[8].length), n: Number(m[6]), delim: m[7] };
  let heading = null;
  if (m[9]) heading = { from: pos, to: (pos += m[9].length + m[10].length), level: m[9].length };
  return { indent, quote: m[2] ? { from: indent, to: indent + m[2].length } : null, afterQuote, bullet, ordered, list: bullet || ordered, heading, contentFrom: pos };
}
function selectedLines(state) {
  const nums = new Set();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    let b = state.doc.lineAt(r.to).number;
    if (!r.empty && b > a && state.doc.line(b).from === r.to) b--;
    for (let n = a; n <= b && n - a < 5000; n++) nums.add(n);
  }
  const lines = [...nums].sort((x, y) => x - y).map((n) => state.doc.line(n));
  const filled = lines.filter((l) => l.text.trim());
  return filled.length ? filled : lines.slice(0, 1);
}

function apply(view, spec, userEvent = 'input.format') {
  view.dispatch({ ...spec, userEvent, scrollIntoView: true });
  return true;
}

// ---------------------------------------------------------------- commands
const INLINE = { strong: { name: 'StrongEmphasis', marker: '**' }, em: { name: 'Emphasis', marker: '*' } };

// `**|**` (or `*|*`) around pos, from an earlier tap, with no other asterisks next to it.
function emptyPairAt(state, pos, marker) {
  const len = marker.length;
  if (pos < len || pos + len > state.doc.length) return false;
  if (state.sliceDoc(pos - len, pos + len) !== marker + marker) return false;
  return state.sliceDoc(Math.max(0, pos - len - 1), pos - len) !== '*' && state.sliceDoc(pos + len, pos + len + 1) !== '*';
}

export function toggleInline(view, kind) {
  const { state } = view;
  if (state.readOnly) return false;
  const { name, marker } = INLINE[kind];
  const len = marker.length;
  const sel = state.selection.main;
  if (sel.empty) {
    const pos = sel.head;
    // An empty pair from an earlier tap: tapping again takes it away.
    if (emptyPairAt(state, pos, marker) && !emphasisAt(state, pos, name)) {
      return apply(view, { changes: { from: pos - len, to: pos + len }, selection: { anchor: pos - len } });
    }
    const node = emphasisAt(state, pos, name);
    if (node) {
      const m = marksOf(node);
      // At the end (or start) of bold text: step out, so what's typed next isn't bold.
      if (pos === m.close.from && pos > m.open.to) return apply(view, { selection: { anchor: m.close.to } }, 'select');
      if (pos === m.open.to && pos < m.close.from) return apply(view, { selection: { anchor: m.open.from } }, 'select');
      return apply(view, { changes: [{ from: m.open.from, to: m.open.to }, { from: m.close.from, to: m.close.to }] });
    }
    const w = wordAt(state, pos);
    if (w) return apply(view, { changes: [{ from: w.from, insert: marker }, { from: w.to, insert: marker }], selection: { anchor: pos + len } });
    apply(view, { changes: { from: pos, insert: marker + marker }, selection: { anchor: pos + len } });
    ui.pair = { view, pos: pos + len };
    return true;
  }
  // A selection running into a link (or out of one) takes it whole (see rangeAroundLinks).
  const { from, to } = rangeAroundLinks(state, sel.from, sel.to);
  if (from >= to) return false;
  // Inside (or exactly) one bold span: unbold it.
  for (let n = syntaxTree(state).resolveInner(from, 1); n; n = n.parent) {
    if (n.name === name && n.from <= from && n.to >= to) {
      const m = marksOf(n);
      if (m) return apply(view, { changes: [{ from: m.open.from, to: m.open.to }, { from: m.close.from, to: m.close.to }] });
    }
  }
  const changes = [];
  // Bold spans inside the selection merge into the new one.
  syntaxTree(state).iterate({
    from,
    to,
    enter(n) {
      if (n.name === name && n.from >= from && n.to <= to) {
        const m = marksOf(n.node);
        if (m) changes.push({ from: m.open.from, to: m.open.to }, { from: m.close.from, to: m.close.to });
      }
    },
  });
  // Emphasis can't cross a line break: one span per line, trimmed of spaces.
  const first = state.doc.lineAt(from).number;
  const last = state.doc.lineAt(to).number;
  for (let ln = first; ln <= last; ln++) {
    const line = state.doc.line(ln);
    let a = Math.max(from, line.from + parseLine(line.text).contentFrom);
    let b = Math.min(to, line.to);
    while (a < b && /\s/.test(state.sliceDoc(a, a + 1))) a++;
    while (b > a && /\s/.test(state.sliceDoc(b - 1, b))) b--;
    if (a < b) changes.push({ from: a, insert: marker }, { from: b, insert: marker });
  }
  if (!changes.length) return false;
  const cs = state.changes(changes);
  const back = sel.head < sel.anchor;
  const head = back ? cs.mapPos(from, 1) : cs.mapPos(to, -1);
  const anchor = back ? cs.mapPos(to, -1) : cs.mapPos(from, 1);
  return apply(view, { changes: cs, selection: { anchor, head } });
}

// Bold or italic switched on with nothing typed yet leaves `****`; once the caret moves away from
// it, the empty pair goes (it would show as asterisks). Not an undo step of its own.
function asteriskRun(state, pos) {
  const doc = state.doc;
  let a = pos;
  let b = pos;
  while (a > 0 && doc.sliceString(a - 1, a) === '*') a--;
  while (b < doc.length && doc.sliceString(b, b + 1) === '*') b++;
  return pos - a === b - pos && pos > a ? { from: a, to: b } : null;
}
function checkPair(u) {
  const pp = ui.pair;
  if (!pp || pp.view !== u.view) return;
  if (u.docChanged) pp.pos = u.changes.mapPos(pp.pos, 1);
  const run = asteriskRun(u.state, pp.pos);
  const sel = u.state.selection.main;
  if (!run) {
    ui.pair = null;
    return;
  }
  if (sel.empty && sel.head === pp.pos) return;
  ui.pair = null;
  queueMicrotask(() => {
    const v = pp.view;
    if (!v.dom.isConnected || v.state.readOnly) return;
    const r = asteriskRun(v.state, Math.min(pp.pos, v.state.doc.length));
    if (!r || r.from !== run.from || r.to !== run.to) return;
    const s2 = v.state.selection.main;
    if (s2.from > r.from && s2.from < r.to) return;
    v.dispatch({ changes: { from: r.from, to: r.to }, annotations: Transaction.addToHistory.of(false), userEvent: 'input.format' });
  });
}

// Rewrites each selected line's prefix; `fn(parsed, line, i)` returns { from, to, insert } in
// line offsets, or null to leave the line alone.
function editLines(view, fn) {
  const { state } = view;
  if (state.readOnly) return false;
  const lines = selectedLines(state);
  const changes = [];
  lines.forEach((l, i) => {
    const c = fn(parseLine(l.text), l, i);
    if (c) changes.push({ from: l.from + c.from, to: l.from + c.to, insert: c.insert || '' });
  });
  if (!changes.length) return false;
  const cs = state.changes(changes);
  return apply(view, { changes: cs, selection: state.selection.map(cs, 1) });
}

export function toggleBullet(view) {
  const lines = selectedLines(view.state).map((l) => parseLine(l.text));
  const all = lines.every((p) => p.bullet);
  return editLines(view, (p) => {
    if (all) return { from: p.bullet.from, to: p.bullet.to };
    if (p.bullet) return null;
    return { from: p.afterQuote, to: p.contentFrom, insert: '- ' }; // a numbered item or heading becomes a plain item
  });
}

export function toggleOrdered(view) {
  const { state } = view;
  const lines = selectedLines(state);
  const parsed = lines.map((l) => parseLine(l.text));
  const all = parsed.every((p) => p.ordered);
  // Numbering continues a numbered list right above.
  let n = 1;
  const prevNo = lines[0].number - 1;
  if (!all && prevNo >= 1) {
    const prev = parseLine(state.doc.line(prevNo).text);
    if (prev.ordered && prev.indent === parsed[0].indent) n = prev.ordered.n + 1;
  }
  return editLines(view, (p) => {
    if (all) return { from: p.ordered.from, to: p.ordered.to };
    return { from: p.afterQuote, to: p.contentFrom, insert: `${n++}. ` };
  });
}

export function toggleQuote(view) {
  const lines = selectedLines(view.state).map((l) => parseLine(l.text));
  const all = lines.every((p) => p.quote);
  return editLines(view, (p, l) => {
    if (all) {
      const q = p.quote.from;
      return { from: q, to: q + (l.text[q + 1] === ' ' ? 2 : 1) };
    }
    if (p.quote) return null;
    return { from: 0, to: 0, insert: '> ' };
  });
}

export function cycleHeading(view) {
  const lines = selectedLines(view.state);
  const cur = parseLine(lines[0].text).heading?.level || 0;
  const next = cur === 2 ? 3 : cur === 3 ? 0 : 2;
  return editLines(view, (p) => ({ from: p.afterQuote, to: p.contentFrom, insert: next ? `${'#'.repeat(next)} ` : '' }));
}

// Backspace right after a list marker ends the item (nested items keep CodeMirror's outdent).
// The caret at the start of a link's text that follows the marker counts as right after it.
function backspaceListMarker(view) {
  const { state } = view;
  if (state.readOnly || state.selection.ranges.length !== 1) return false;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  const p = parseLine(line.text);
  if (!p.list || p.indent > 0 || p.quote || p.heading) return false;
  const before = acrossMarkup(state, sel.head, false);
  if ((before >= 0 ? before : sel.head) - line.from !== p.list.to) return false;
  view.dispatch({ changes: { from: line.from + p.list.from, to: line.from + p.list.to }, selection: { anchor: line.from + p.list.from }, userEvent: 'delete.backward', scrollIntoView: true });
  return true;
}

// ---------------------------------------------------------------- links
// The link at pos: [text](url), <url> or a bare http(s) address.
export function linkAt(state, pos) {
  for (const side of [-1, 1]) {
    for (let n = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) {
      if (n.name === 'Image') return null;
      if (n.name === 'Link') {
        const url = n.getChild('URL');
        const marks = n.getChildren('LinkMark');
        if (!url || marks.length < 3) return null;
        return { kind: 'link', from: n.from, to: n.to, textFrom: marks[0].to, textTo: marks[1].from, urlFrom: url.from, urlTo: url.to, url: state.sliceDoc(url.from, url.to) };
      }
      if (n.name === 'Autolink') {
        const url = n.getChild('URL');
        if (!url) return null;
        return { kind: 'auto', from: n.from, to: n.to, textFrom: url.from, textTo: url.to, urlFrom: url.from, urlTo: url.to, url: state.sliceDoc(url.from, url.to) };
      }
      if (n.name === 'URL' && n.parent && !/^(Link|Image|Autolink)$/.test(n.parent.name)) {
        const url = state.sliceDoc(n.from, n.to);
        if (!/^https?:\/\//i.test(url)) return null;
        return { kind: 'bare', from: n.from, to: n.to, textFrom: n.from, textTo: n.to, urlFrom: n.from, urlTo: n.to, url };
      }
    }
  }
  return null;
}

// A web address from what someone typed: "example.com" -> https://example.com; mail addresses
// -> mailto:. Anything else (javascript:, data:, relative paths) is refused.
export function normalizeUrl(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (/^<.*>$/.test(s)) s = s.slice(1, -1).trim();
  if (/^[^\s@/:]+@[^\s@/]+\.[^\s@/]+$/.test(s)) s = `mailto:${s}`;
  else if (/^\/\//.test(s)) s = `https:${s}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(s) && /^[^\s/]+\.[a-z]{2,}(?:[/?#:]|$)/i.test(s)) s = `https://${s}`;
  if (!WEB_URL.test(s)) return null;
  try {
    const u = new URL(s);
    if (!/^(https?|mailto):$/.test(u.protocol)) return null;
  } catch {
    return null;
  }
  // Characters that would end a Markdown link address early.
  return s.replace(/\s/g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/</g, '%3C').replace(/>/g, '%3E');
}
const cleanLinkText = (t) => String(t || '').replace(/\s*\n\s*/g, ' ').replace(/[[\]]/g, '').trim();
const isSingleUrl = (t) => /^\s*(?:https?:\/\/|mailto:)[^\s]+\s*$/i.test(t || '');

// Writes a link with the smallest change to the text: brackets around the words already there
// (they stay exactly as typed, so the scorer sees no new words), or only the part that changed
// when a link is edited. Words typed into the form are new words, as if typed in the text.
function setLink(view, range, text, url, link = null) {
  const { state } = view;
  const t = cleanLinkText(text);
  const label = t || url.replace(/^mailto:/i, '');
  const bareOk = /^https?:/i.test(url) && (!t || t === url);
  let changes;
  if (link && link.kind === 'link') {
    changes = [];
    if (state.sliceDoc(link.textFrom, link.textTo) !== label) changes.push({ from: link.textFrom, to: link.textTo, insert: label });
    if (link.url !== url) changes.push({ from: link.urlFrom, to: link.urlTo, insert: url });
  } else if (link) {
    // A bare (or <>) address: new text makes it [text](address); otherwise only the address changes.
    if (bareOk) changes = link.url === url ? [] : [{ from: link.urlFrom, to: link.urlTo, insert: url }];
    else changes = [{ from: link.from, to: link.to, insert: `[${label}](${url})` }];
  } else {
    let { from, to } = range;
    while (from < to && /\s/.test(state.sliceDoc(from, from + 1))) from++;
    while (to > from && /\s/.test(state.sliceDoc(to - 1, to))) to--;
    // Links inside the range (it was widened over them) give way to the new one: links can't nest.
    // Their words stay as they are; only their Markup goes.
    const inner = from < to ? hiddenLinks(state, from, to).filter((l) => l.from >= from && l.to <= to) : [];
    const words = inner.length ? visibleText(state, from, to) : state.sliceDoc(from, to);
    if (from < to && (!t || t === cleanLinkText(words)) && !/[[\]\n]/.test(words)) {
      changes = [{ from, insert: '[' }, { from: to, insert: `](${url})` }];
      for (const l of inner) changes.push({ from: l.from, to: l.textFrom }, { from: l.textTo, to: l.to });
    } else if (from < to) {
      changes = [{ from, to, insert: `[${label}](${url})` }];
    } else {
      changes = [{ from, insert: bareOk ? url : `[${label}](${url})` }];
    }
  }
  if (!changes.length) return true;
  const cs = state.changes(changes);
  const end = cs.mapPos(link ? link.to : Math.max(range.to, range.from), 1);
  view.dispatch({ changes: cs, selection: { anchor: end }, userEvent: 'input.link', scrollIntoView: true });
  return true;
}
// Unlinks [text](url), keeping the words untouched. A bare address is its own text: removing
// the link removes the address.
function unlink(view, link) {
  if (link.kind === 'link') {
    const changes = view.state.changes([{ from: link.from, to: link.textFrom }, { from: link.textTo, to: link.to }]);
    view.dispatch({ changes, selection: { anchor: changes.mapPos(link.textTo, -1) }, userEvent: 'input.link' });
  } else {
    view.dispatch({ changes: { from: link.from, to: link.to }, selection: { anchor: link.from }, userEvent: 'input.link' });
  }
}
export function openUrl(url) {
  if (!WEB_URL.test(url)) return;
  const w = window.open(url, '_blank', 'noopener,noreferrer');
  if (w) w.opener = null;
}

async function clipboardUrl() {
  try {
    if (!navigator.clipboard?.readText || !navigator.permissions?.query) return null;
    const p = await navigator.permissions.query({ name: 'clipboard-read' });
    if (p.state !== 'granted') return null; // never ask: only when it's already allowed
    const t = (await navigator.clipboard.readText()).trim();
    return isSingleUrl(t) ? t : null;
  } catch {
    return null;
  }
}

// Cmd/Ctrl+K and the Link button.
export function linkCommand(view) {
  if (!isEditable(view)) return false;
  const { state } = view;
  const sel = state.selection.main;
  const existing = linkAt(state, sel.head) || (!sel.empty ? linkAt(state, sel.from) : null);
  if (existing && existing.from <= sel.from && existing.to >= sel.to) {
    openLinkForm(view, { link: existing });
    return true;
  }
  // A link can't cross a line break: a longer selection links its first line. One that runs into
  // a link (or out of one) takes it whole; when that's just the link, it's edited.
  const r = sel.empty ? sel : rangeAroundLinks(state, sel.from, Math.min(sel.to, state.doc.lineAt(sel.from).to));
  const whole = r.to > r.from ? linkAt(state, r.from + 1) : null;
  if (whole && whole.from === r.from && whole.to === r.to) {
    openLinkForm(view, { link: whole });
    return true;
  }
  openLinkForm(view, { from: r.from, to: r.to, text: visibleText(state, r.from, r.to) });
  return true;
}

// ---------------------------------------------------------------- decorations: links
const urlMark = Decoration.mark({ class: 'rt-url' });
const hideMark = Decoration.replace({});
const linkIn = Decoration.mark({ class: 'rt-link-in' });
// A link whose Markup the editor hides: [text](address) and <http(s)://…>. Its text is
// textFrom..textTo; from..textFrom and textTo..to are hidden.
function hiddenLinkOf(state, n) {
  if (n.name === 'Link') {
    const marks = n.getChildren('LinkMark');
    if (marks.length < 3 || !n.getChild('URL')) return null;
    return { from: n.from, to: n.to, textFrom: marks[0].to, textTo: marks[1].from };
  }
  if (n.name === 'Autolink') {
    const url = n.getChild('URL');
    if (!url || !/^https?:/i.test(state.sliceDoc(url.from, Math.min(url.to, url.from + 8)))) return null;
    return { from: n.from, to: n.to, textFrom: url.from, textTo: url.to };
  }
  return null;
}
// The links with hidden Markup that touch from..to.
function hiddenLinks(state, from, to) {
  const out = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter(n) {
      if (n.name === 'Image') return false;
      if (n.name === 'Link' || n.name === 'Autolink') {
        const l = hiddenLinkOf(state, n.node);
        if (l) out.push(l);
        return false;
      }
      return undefined;
    },
  });
  return out;
}
// The other side of the hidden Markup right next to pos in that direction (crossing a run of
// it, e.g. between two links), or -1 when there's none.
function acrossMarkup(state, pos, forward) {
  let at = pos;
  for (let k = 0; k < 4; k++) {
    let next = -1;
    for (const l of hiddenLinks(state, at, at)) {
      if (forward) {
        if (at === l.from && l.textFrom > l.from) next = l.textFrom;
        else if (at === l.textTo && l.to > l.textTo) next = l.to;
      } else if (at === l.to && l.to > l.textTo) next = l.textTo;
      else if (at === l.textFrom && l.textFrom > l.from) next = l.from;
      if (next >= 0) break;
    }
    if (next < 0) break;
    at = next;
  }
  return at === pos ? -1 : at;
}
// The links touching from..to: those with hidden Markup, and bare https:// addresses.
function linksTouching(state, from, to) {
  const out = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter(n) {
      if (n.name === 'Image') return false;
      if (n.name === 'Link' || n.name === 'Autolink') {
        const l = hiddenLinkOf(state, n.node);
        if (l) out.push({ ...l, kind: n.name === 'Link' ? 'link' : 'auto' });
        return false;
      }
      if (n.name === 'URL' && n.to > n.from && !/^(Link|Image|Autolink)$/.test(n.node.parent?.name || '')
        && /^https?:\/\//i.test(state.sliceDoc(n.from, Math.min(n.to, n.from + 8)))) {
        out.push({ kind: 'bare', from: n.from, to: n.to, textFrom: n.from, textTo: n.to });
      }
      return undefined;
    },
  });
  return out;
}
// The range Bold, Italic or Link act on for a selection from..to, so the Markdown never breaks:
// one that runs into a link from outside (or out of one from inside) takes the whole link, and an
// address shown as it is (<https://…>, a bare https://…) goes whole. One that has a link's hidden
// Markup at an end but none of its letters leaves that link out.
function rangeAroundLinks(state, from, to) {
  for (const l of linksTouching(state, from, to)) {
    if (from >= l.textTo && from < l.to) from = l.to;
    if (to <= l.textFrom && to > l.from) to = l.from;
    if (from >= to) continue;
    const inText = l.kind === 'link' && from >= l.textFrom && to <= l.textTo;
    if (from < l.to && to > l.from && !(from <= l.from && to >= l.to) && !inText) {
      from = Math.min(from, l.from);
      to = Math.max(to, l.to);
    }
  }
  return { from, to: Math.max(from, to) };
}
// The text from..to as it shows: the links' hidden Markup left out.
function visibleText(state, from, to) {
  let out = '';
  let p = from;
  for (const l of hiddenLinks(state, from, to)) {
    for (const [a, b] of [[l.from, l.textFrom], [l.textTo, l.to]]) {
      const x = Math.max(a, p);
      const y = Math.min(b, to);
      if (y <= x) continue;
      out += state.sliceDoc(p, x);
      p = y;
    }
  }
  return out + state.sliceDoc(p, to);
}
function activeLineSet(view) {
  const set = new Set();
  if (!view.hasFocus) return set;
  for (const r of view.state.selection.ranges) {
    const a = view.state.doc.lineAt(r.from).number;
    const b = view.state.doc.lineAt(r.to).number;
    for (let n = a; n <= b && n - a < 500; n++) set.add(n);
  }
  return set;
}
function buildLinkDecos(view) {
  const { state } = view;
  const decos = [];
  const atoms = [];
  const active = activeLineSet(view);
  // A link shows only its text: its Markup is hidden (on the caret's line too: the editor hides
  // it off that line), and is one step for the caret. Its address is edited from its popover.
  const show = (l) => {
    if (l.textFrom > l.from) {
      decos.push(hideMark.range(l.from, l.textFrom));
      atoms.push(hideMark.range(l.from, l.textFrom));
    }
    if (l.to > l.textTo) {
      decos.push(hideMark.range(l.textTo, l.to));
      atoms.push(hideMark.range(l.textTo, l.to));
    }
  };
  const tree = syntaxTree(state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(n) {
        if (n.name === 'Image') return false;
        if (n.name === 'Link') {
          const l = active.has(state.doc.lineAt(n.from).number) ? hiddenLinkOf(state, n.node) : null;
          if (l) show(l);
          return false;
        }
        if (n.name === 'Autolink') {
          const l = hiddenLinkOf(state, n.node);
          if (l) {
            decos.push(urlMark.range(l.textFrom, l.textTo));
            show(l);
          }
          return false;
        }
        if (n.name === 'URL' && n.to > n.from) {
          const parent = n.node.parent;
          if (parent && !/^(Link|Image|Autolink)$/.test(parent.name) && /^https?:\/\//i.test(state.sliceDoc(n.from, Math.min(n.to, n.from + 8)))) {
            decos.push(urlMark.range(n.from, n.to));
          }
        }
        return undefined;
      },
    });
  }
  return { decorations: Decoration.set(decos, true), atoms: Decoration.set(atoms, true) };
}
const linkDecorations = ViewPlugin.fromClass(class {
  constructor(view) {
    this.build(view);
  }
  update(u) {
    if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.build(u.view);
  }
  build(view) {
    const { decorations, atoms } = buildLinkDecos(view);
    this.decorations = decorations;
    this.atoms = atoms;
  }
}, {
  decorations: (v) => v.decorations,
  provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atoms || Decoration.none),
});
// The text of the link the caret is in is lit: just inside and just outside a link's end look the
// same, and typing goes into the link only from inside. While a mouse button or a finger is down
// in the text it holds still (redrawing the text under the pointer would swallow the click, and
// the link's popover with it); it catches up once the click is over.
const litRefresh = StateEffect.define();
function buildLit(view) {
  const { state } = view;
  const main = state.selection.main;
  if (!view.hasFocus || !main.empty) return Decoration.none;
  for (const l of hiddenLinks(state, main.head, main.head)) {
    if (main.head >= l.textFrom && main.head <= l.textTo && l.textTo > l.textFrom) return Decoration.set([linkIn.range(l.textFrom, l.textTo)]);
  }
  return Decoration.none;
}
const linkLit = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = buildLit(view);
  }
  update(u) {
    if (u.transactions.some((tr) => tr.effects.some((e) => e.is(litRefresh)))) this.decorations = buildLit(u.view);
    else if (ui.pressing) this.decorations = this.decorations.map(u.changes);
    else if (u.docChanged || u.selectionSet || u.focusChanged) this.decorations = buildLit(u.view);
  }
}, { decorations: (v) => v.decorations });
function endPress() {
  clearTimeout(ui.pressTimer);
  if (!ui.pressing) return;
  ui.pressing = false;
  for (const ed of openEditors()) if (ed.view.dom.isConnected) ed.view.dispatch({ effects: litRefresh.of(null) });
}

// ---------------------------------------------------------------- links: deleting, selecting
// Deleting never takes part of a link's hidden Markup. Backspace or Delete right next to it
// crosses it and takes the next character the writer can see: just after a link, Backspace takes
// the last character of its text; at the start of its text, the character before the link. Any
// other deletion that covers part of a link (a selection, cut, typing over it, a phone keyboard's
// own deletion) keeps the Markup. A link left with no text goes altogether.
const graphemes = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
// The edge of the character before or after pos (an emoji or accented letter whole; a line break).
function charEdge(state, pos, forward) {
  if (forward ? pos >= state.doc.length : pos <= 0) return pos;
  const line = state.doc.lineAt(pos);
  if (pos === (forward ? line.to : line.from)) return pos + (forward ? 1 : -1);
  const off = pos - line.from;
  const s = forward ? line.text.slice(off, off + 32) : line.text.slice(Math.max(0, off - 32), off);
  let len = 1;
  if (graphemes) {
    for (const g of graphemes.segment(s)) {
      len = g.segment.length;
      if (forward) break;
    }
  } else if (forward ? /^[\ud800-\udbff][\udc00-\udfff]/.test(s) : /[\ud800-\udbff][\udc00-\udfff]$/.test(s)) len = 2;
  return pos + (forward ? len : -len);
}
// Deleting a..b with `insert` typed in its place, around links it covers only partly: the changes
// that keep their Markup (or take a link whole when none of its text would be left), and where
// the typed text goes. Null when no link is partly covered.
function linkSafeChanges(state, a, b, insert) {
  const links = hiddenLinks(state, a, b).filter((l) => l.to > a && l.from < b && (l.from < a || l.to > b));
  if (!links.length) return null;
  let from = a;
  let to = b;
  let at = a;
  const keep = [];
  for (const l of links) {
    const textLeft = l.textTo - l.textFrom - Math.max(0, Math.min(b, l.textTo) - Math.max(a, l.textFrom));
    if (textLeft <= 0 && !(insert && a >= l.textFrom && a <= l.textTo)) {
      from = Math.min(from, l.from);
      to = Math.max(to, l.to);
      continue;
    }
    if (l.textFrom > l.from) keep.push([l.from, l.textFrom]);
    if (l.to > l.textTo) keep.push([l.textTo, l.to]);
    if (at > l.textTo && at < l.to) at = l.to;
  }
  keep.sort((x, y) => x[0] - y[0]);
  const changes = [];
  let p = from;
  for (const [ks, ke] of keep) {
    if (ke <= p || ks >= to) continue;
    if (ks > p) changes.push({ from: p, to: ks });
    p = Math.max(p, ke);
  }
  if (p < to) changes.push({ from: p, to });
  if (insert) {
    const c = changes.find((x) => x.from <= at && x.to >= at);
    if (c) {
      c.insert = insert;
      at = c.from;
    } else changes.push({ from: at, insert });
  }
  return { changes, at };
}
const keepLinkMarkup = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  let n = 0;
  let a = 0;
  let b = 0;
  let inserted = null;
  tr.changes.iterChanges((fa, ta, _fb, _tb, ins) => {
    n++;
    a = fa;
    b = ta;
    inserted = ins;
  });
  if (n !== 1 || b === a || tr.annotation(Remote) || tr.annotation(PasteMeta) || tr.isUserEvent('input.type.compose')) return tr;
  if (!tr.isUserEvent('delete') && !tr.isUserEvent('input.type') && !tr.isUserEvent('input.paste') && !tr.isUserEvent('input.drop')) return tr;
  const state = tr.startState;
  if (state.selection.ranges.length !== 1) return tr;
  const insert = inserted.toString();
  let res = linkSafeChanges(state, a, b, insert);
  if (!res) return tr;
  const sel = state.selection.main;
  let caret = -1;
  let back = false;
  if (!res.changes.length && !insert && sel.empty && (sel.head === a || sel.head === b)) {
    // Only hidden Markup next to the caret: cross it, and take the next visible character.
    back = sel.head === b;
    const edge = acrossMarkup(state, sel.head, !back);
    const c = edge < 0 ? edge : charEdge(state, edge, !back);
    if (c === edge) return [];
    const [x, y] = back ? [c, edge] : [edge, c];
    res = linkSafeChanges(state, x, y, '') || { changes: [{ from: x, to: y }], at: x };
    caret = back ? c : edge;
  }
  if (!res.changes.length) return [];
  const changes = state.changes(res.changes);
  // (mapPos puts a position at the start of a replaced range before the new text, whatever its
  // side: the caret after typed text is counted from there.)
  return {
    changes,
    selection: EditorSelection.cursor(caret >= 0 ? changes.mapPos(caret, back ? -1 : 1) : changes.mapPos(res.at, -1) + insert.length),
    effects: tr.effects,
    scrollIntoView: tr.scrollIntoView,
    userEvent: tr.annotation(Transaction.userEvent),
  };
});

// The caret never rests inside hidden Markup, however it got there: End (it finds the line's end
// on screen, between the hidden pieces the highlighter splits "](address)" into), a click on a
// line before it shows the caret, a phone keyboard's cursor control. It goes to the Markup's
// edge on the side it was moving to (a click: the nearer edge).
const caretOutOfMarkup = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection || tr.docChanged) return tr;
  const state = tr.startState;
  const old = state.selection;
  const pointer = tr.isUserEvent('select.pointer');
  const snap = (pos, prev) => {
    for (const l of hiddenLinks(state, pos, pos)) {
      for (const [a, b] of [[l.from, l.textFrom], [l.textTo, l.to]]) {
        if (pos > a && pos < b) return (pointer ? b - pos < pos - a : pos >= prev) ? b : a;
      }
    }
    return pos;
  };
  let moved = false;
  const ranges = tr.selection.ranges.map((r, i) => {
    const was = old.ranges[i] || old.main;
    const head = snap(r.head, was.head);
    const anchor = r.empty ? head : snap(r.anchor, was.anchor);
    if (head === r.head && anchor === r.anchor) return r;
    moved = true;
    return r.empty ? EditorSelection.cursor(head, r.assoc, r.bidiLevel ?? undefined, r.goalColumn) : EditorSelection.range(anchor, head);
  });
  return moved ? [tr, { selection: EditorSelection.create(ranges, tr.selection.mainIndex) }] : tr;
});

// Shift+←/→ never spends a press on hidden Markup alone: it takes the next visible character
// with it. Word jumps and word deletion (Alt/Ctrl+arrows, Alt/Ctrl+Backspace/Delete) at a
// link's edge cross the Markup first, then do their usual thing.
const isLtr = (view, pos) => view.textDirectionAt(pos) === 0; // Direction.LTR
function selectAcross(view, right) {
  const { state } = view;
  if (state.selection.ranges.length !== 1) return false;
  const range = state.selection.main;
  const forward = right === isLtr(view, range.head);
  const at = acrossMarkup(state, range.head, forward);
  if (at < 0) return false;
  const next = view.moveByChar(EditorSelection.cursor(at), forward);
  view.dispatch({ selection: EditorSelection.range(range.anchor, next.head), scrollIntoView: true, userEvent: 'select' });
  return true;
}
function wordAcross(view, right, extend) {
  const { state } = view;
  if (state.selection.ranges.length !== 1) return false;
  const range = state.selection.main;
  if (!range.empty && !extend) return false;
  const forward = right === isLtr(view, range.head);
  const at = acrossMarkup(state, range.head, forward);
  if (at < 0) return false;
  const next = view.moveByGroup(EditorSelection.cursor(at), forward);
  view.dispatch({ selection: extend ? EditorSelection.range(range.anchor, next.head) : next, scrollIntoView: true, userEvent: 'select' });
  return true;
}
const cmRun = (key) => (defaultKeymap.find((b) => b.key === key) || {}).run;
// Home and End (Cmd+←/→ on a Mac): at the start or end of a line that begins or ends with a link,
// the caret goes just outside it.
function lineEdge(view, key, forward, extend) {
  const b = defaultKeymap.find((x) => x.key === key || x.mac === key);
  const run = b && (extend ? b.shift : b.run);
  if (!run || view.state.selection.ranges.length !== 1) return false;
  run(view);
  const { state } = view;
  const r = state.selection.main;
  const out = acrossMarkup(state, r.head, forward);
  const line = state.doc.lineAt(r.head);
  if (out >= 0 && out === (forward ? line.to : line.from)) {
    view.dispatch({ selection: extend ? EditorSelection.range(r.anchor, out) : EditorSelection.cursor(out), scrollIntoView: true, userEvent: 'select' });
  }
  return true;
}
function wordDeleteAcross(view, forward) {
  const { state } = view;
  if (state.readOnly || state.selection.ranges.length !== 1 || !state.selection.main.empty) return false;
  const at = acrossMarkup(state, state.selection.main.head, forward);
  const run = cmRun(forward ? 'Mod-Delete' : 'Mod-Backspace');
  if (at < 0 || !run) return false;
  let out = null;
  run({ state: state.update({ selection: { anchor: at } }).state, dispatch: (tr) => { out = tr; } });
  if (out && out.docChanged) view.dispatch({ changes: out.changes, selection: out.selection, userEvent: forward ? 'delete.forward' : 'delete.backward', scrollIntoView: true });
  return true;
}

// ---------------------------------------------------------------- decorations: images
function imageInfo(state, node) {
  const url = node.getChild('URL');
  const marks = node.getChildren('LinkMark');
  if (!url || marks.length < 2) return null;
  const src = state.sliceDoc(url.from, url.to);
  if (!UPLOAD_SRC.test(src)) return null;
  const [path, frag = ''] = src.split('#');
  const q = new URLSearchParams(frag);
  const w = Math.round(Number(q.get('w')));
  const hgt = Math.round(Number(q.get('h')));
  const ok = w > 0 && hgt > 0 && w < 20000 && hgt < 20000;
  return {
    from: node.from, to: node.to, altFrom: marks[0].to, altTo: marks[1].from,
    alt: state.sliceDoc(marks[0].to, marks[1].from), path, w: ok ? w : 0, h: ok ? hgt : 0,
  };
}
function imageNodeAt(state, pos) {
  const n = nodeOfType(state, pos, 'Image', 1) || nodeOfType(state, pos, 'Image', -1);
  return n ? imageInfo(state, n) : null;
}

class ImageWidget extends WidgetType {
  constructor(info) {
    super();
    this.path = info.path;
    this.alt = info.alt;
    this.w = info.w;
    this.h = info.h;
  }
  eq(o) {
    return o.path === this.path && o.alt === this.alt && o.w === this.w && o.h === this.h;
  }
  toDOM(view) {
    const img = h('img', { src: this.path, alt: this.alt || 'Image', decoding: 'async', draggable: 'false' });
    if (this.w) {
      img.width = this.w;
      img.height = this.h;
      // Tall pictures stay within the screen, keeping their shape.
      img.style.maxWidth = `min(100%, calc(70vh * ${(this.w / this.h).toFixed(4)}))`;
    }
    img.addEventListener('load', () => view.requestMeasure());
    const cap = h('span', { class: 'rt-img-cap' });
    const dom = h('span', { class: 'rt-img', contenteditable: 'false', role: 'button', tabindex: '-1', 'aria-label': 'Image: tap to describe it or remove it' }, img, cap);
    this.fill(dom);
    dom.addEventListener('mousedown', (e) => e.preventDefault());
    dom.addEventListener('click', (e) => {
      e.preventDefault();
      openImageForm(view, dom);
    });
    return dom;
  }
  fill(dom) {
    const cap = dom.querySelector('.rt-img-cap');
    const img = dom.querySelector('img');
    img.alt = this.alt || 'Image';
    cap.textContent = this.alt || 'Describe the image';
    cap.classList.toggle('is-empty', !this.alt);
    dom.dataset.path = this.path;
    dom.dataset.size = `${this.w}x${this.h}`;
  }
  // The same picture with a new description: updated in place (the description form, anchored
  // to this element, stays open while the description is typed).
  updateDOM(dom) {
    if (dom.dataset.path !== this.path || dom.dataset.size !== `${this.w}x${this.h}`) return false;
    this.fill(dom);
    return true;
  }
  ignoreEvent() {
    return true;
  }
}
function buildImageDecos(view) {
  const { state } = view;
  const decos = [];
  const tree = syntaxTree(state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(n) {
        if (n.name !== 'Image') return undefined;
        const info = imageInfo(state, n.node);
        if (info) decos.push(Decoration.replace({ widget: new ImageWidget(info) }).range(info.from, info.to));
        return false;
      },
    });
  }
  return Decoration.set(decos, true);
}
const imageWidgets = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = buildImageDecos(view);
  }
  update(u) {
    if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = buildImageDecos(u.view);
  }
}, {
  decorations: (v) => v.decorations,
  provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations || Decoration.none),
});

// ---------------------------------------------------------------- uploads in progress
// A placeholder per upload, anchored to a line (side -1: above it, side 1: below it), mapped
// through every change; it isn't text, so it makes no ops until the image is inserted.
const addUpload = StateEffect.define();
const moveUpload = StateEffect.define();
const dropUpload = StateEffect.define();
function uploadDecos(state, list) {
  if (!list.length) return Decoration.none;
  const doc = state.doc;
  return Decoration.set(list.map((u) => {
    const line = doc.lineAt(Math.min(u.pos, doc.length));
    return Decoration.widget({ widget: new UploadWidget(u.id), block: true, side: u.side < 0 ? -1 : 1 }).range(u.side < 0 ? line.from : line.to);
  }), true);
}
// Block widgets change the editor's vertical layout, so the set is built here and provided
// directly (not through a function of the view).
const uploadsField = StateField.define({
  create: () => ({ list: [], decos: Decoration.none }),
  update(value, tr) {
    let { list } = value;
    let changed = false;
    if (tr.docChanged && list.length) {
      list = list.map((u) => ({ ...u, pos: tr.changes.mapPos(u.pos, u.side < 0 ? 1 : -1) }));
      changed = true;
    }
    for (const e of tr.effects) {
      if (e.is(addUpload)) list = [...list, e.value];
      else if (e.is(moveUpload)) list = list.map((u) => (u.id === e.value.id ? { ...u, pos: e.value.pos, side: e.value.side } : u));
      else if (e.is(dropUpload)) list = list.filter((u) => u.id !== e.value);
      else continue;
      changed = true;
    }
    return changed ? { list, decos: uploadDecos(tr.state, list) } : value;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
});

const jobs = new Map(); // id -> upload job
let jobSeq = 0;

class UploadWidget extends WidgetType {
  constructor(id) {
    super();
    this.id = id;
  }
  eq(o) {
    return o.id === this.id;
  }
  toDOM() {
    const job = jobs.get(this.id);
    const dom = h('div', { class: 'rt-up', contenteditable: 'false', 'aria-live': 'polite' });
    if (job) {
      job.els.add(dom);
      renderJobInto(job, dom);
    }
    return dom;
  }
  destroy(dom) {
    jobs.get(this.id)?.els.delete(dom);
  }
  get estimatedHeight() {
    return 220;
  }
  ignoreEvent() {
    return true;
  }
}

function renderJobInto(job, dom) {
  dom.className = `rt-up is-${job.status}`;
  let frame = dom.querySelector('.rt-up-frame');
  if (!frame) {
    frame = h('span', { class: 'rt-up-frame' }, h('span', { class: 'rt-up-bar' }, h('i')));
    const cap = h('span', { class: 'rt-up-cap' }, h('span', { class: 'rt-up-text' }), h('span', { class: 'rt-up-acts' }));
    dom.append(frame, cap);
  }
  if (job.w && job.h) {
    frame.style.aspectRatio = `${job.w} / ${job.h}`;
    frame.style.maxWidth = `min(100%, ${job.w}px, calc(70vh * ${(job.w / job.h).toFixed(4)}))`;
  }
  let img = frame.querySelector('img');
  if (job.previewUrl && !img) {
    img = h('img', { alt: '', src: job.previewUrl, draggable: 'false' });
    frame.prepend(img);
  }
  frame.querySelector('.rt-up-bar i').style.transform = `scaleX(${job.status === 'uploading' ? Math.max(0.04, job.progress) : job.status === 'done' ? 1 : 0})`;
  dom.querySelector('.rt-up-text').textContent = job.text;
  const acts = dom.querySelector('.rt-up-acts');
  const want = `${job.retry ? 'r' : ''}x`;
  if (acts.dataset.want !== want) {
    acts.dataset.want = want;
    const btns = [h('button', { type: 'button', class: 'rt-up-btn', onClick: () => cancelJob(job) }, 'Remove')];
    if (job.retry) btns.unshift(h('button', { type: 'button', class: 'rt-up-btn', onClick: () => retryJob(job) }, 'Retry'));
    acts.replaceChildren(...btns);
  }
}
function setJob(job, patch) {
  Object.assign(job, patch);
  for (const el of job.els) renderJobInto(job, el);
  if (job.view && job.view.dom.isConnected) job.view.requestMeasure();
}
function wake(job) {
  const f = job.wake;
  job.wake = null;
  f?.();
}
function sleepFor(job, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      job.wake = null;
      resolve();
    }, ms);
    job.wake = () => {
      clearTimeout(t);
      resolve();
    };
  });
}

const isImageFile = (f) => f && /^image\//.test(f.type || '');

// Adds images at `pos` (a placeholder each, then the upload). Returns how many.
export function addImages(view, files, pos = view.state.selection.main.head) {
  const imgs = [...files].filter(isImageFile).slice(0, 10);
  if (!imgs.length) return 0;
  if (!isEditable(view)) {
    toast('This post can’t be changed right now.', { kind: 'warn' });
    return 0;
  }
  const doc = view.state.doc;
  const line = doc.lineAt(Math.max(0, Math.min(pos, doc.length)));
  const side = line.text.trim() ? 1 : -1;
  const batch = { jobs: [] };
  const effects = [];
  for (const file of imgs) {
    const job = {
      id: `up${++jobSeq}`, view, file, batch, status: 'processing', text: 'Preparing the image…', progress: 0,
      retry: false, els: new Set(), attempts: 0, w: 0, h: 0, previewUrl: null, prepared: null,
    };
    jobs.set(job.id, job);
    batch.jobs.push(job);
    effects.push(addUpload.of({ id: job.id, pos: side < 0 ? line.from : line.to, side }));
  }
  view.dispatch({ effects });
  runBatch(batch);
  return imgs.length;
}

// One image after the other, so they land in the order they were added.
async function runBatch(batch) {
  for (const job of batch.jobs) {
    if (!job.cancelled) await runJob(job);
  }
}

async function runJob(job) {
  if (job.running) return;
  job.running = true;
  try {
    if (!job.prepared) {
      setJob(job, { status: 'processing', text: 'Preparing the image…', retry: false });
      try {
        const r = await prepareImage(job.file);
        if (job.cancelled) return;
        job.prepared = r;
        setJob(job, { w: r.w, h: r.h, previewUrl: URL.createObjectURL(r.blob) });
      } catch (e) {
        if (!job.cancelled) setJob(job, { status: 'error', text: describeUploadError(e).text, retry: false });
        return;
      }
    }
    for (;;) {
      if (job.cancelled) return;
      if (navigator.onLine === false) {
        setJob(job, { status: 'waiting', text: 'Will upload when you’re back online.', retry: false });
        await sleepFor(job, 30_000);
        continue;
      }
      job.attempts++;
      setJob(job, { status: 'uploading', text: 'Uploading…', progress: 0, retry: false });
      let res;
      try {
        res = await uploadBlob(job.prepared.blob, {
          onProgress: (p) => {
            job.progress = p;
            for (const el of job.els) {
              const bar = el.querySelector('.rt-up-bar i');
              if (bar) bar.style.transform = `scaleX(${Math.max(0.04, p)})`;
            }
          },
        });
      } catch (e) {
        if (job.cancelled) return;
        const d = describeUploadError(e);
        if (d.offline || (d.auto && job.attempts < 6)) {
          setJob(job, { status: 'waiting', text: d.text, retry: !d.offline });
          await sleepFor(job, [2000, 4000, 8000, 15000, 30000][Math.min(job.attempts - 1, 4)]);
          continue;
        }
        setJob(job, { status: 'error', text: d.text, retry: d.retry });
        return;
      }
      if (job.cancelled) return;
      setJob(job, { status: 'done', text: 'Uploaded', progress: 1 });
      await preload(res.url);
      if (!job.cancelled) insertUploaded(job, res);
      return;
    }
  } finally {
    job.running = false;
  }
}
function retryJob(job) {
  if (job.running) wake(job);
  else runJob(job);
}
function cancelJob(job) {
  job.cancelled = true;
  wake(job);
  finishJob(job);
  if (job.view?.dom.isConnected) job.view.dispatch({ effects: dropUpload.of(job.id) });
}
function finishJob(job) {
  jobs.delete(job.id);
  if (job.previewUrl) setTimeout(() => URL.revokeObjectURL(job.previewUrl), 4000);
}
// The uploaded file comes from the server's cache before the placeholder goes: no blank frame.
function preload(url) {
  return new Promise((resolve) => {
    const img = new Image();
    const t = setTimeout(resolve, 4000);
    img.onload = img.onerror = () => {
      clearTimeout(t);
      resolve();
    };
    img.src = url;
  });
}

function insertUploaded(job, res) {
  const view = job.view;
  if (!view || !view.dom.isConnected) return finishJob(job);
  const { state } = view;
  const u = state.field(uploadsField, false)?.list.find((x) => x.id === job.id);
  if (!u) return finishJob(job);
  if (state.readOnly) {
    setJob(job, { status: 'error', text: 'This post can’t be changed any more, so the image wasn’t added.', retry: false });
    return undefined;
  }
  const w = res.w || job.w;
  const hh = res.h || job.h;
  const md = `![](${res.url}${w && hh ? `#w=${w}&h=${hh}` : ''})`;
  const doc = state.doc;
  const line = doc.lineAt(Math.min(u.pos, doc.length));
  let from;
  let insert;
  let imageEnd;
  if (u.side < 0) {
    // Above a blank line (where the caret was): a paragraph of its own.
    const prev = line.number > 1 ? doc.line(line.number - 1) : null;
    const lead = prev && prev.text.trim() ? '\n' : '';
    from = line.from;
    insert = `${lead}${md}\n\n`;
    imageEnd = from + lead.length + md.length;
  } else {
    // Below the line: a paragraph of its own after it.
    const next = line.number < doc.lines ? doc.line(line.number + 1) : null;
    from = line.to;
    insert = `\n\n${md}${next && next.text.trim() ? '\n\n' : ''}`;
    imageEnd = from + 2 + md.length;
  }
  const changes = state.changes({ from, insert });
  // The rest of this batch goes after this image.
  const effects = [dropUpload.of(job.id)];
  for (const other of job.batch.jobs) if (other !== job && jobs.has(other.id) && !other.cancelled) effects.push(moveUpload.of({ id: other.id, pos: imageEnd, side: 1 }));
  view.dispatch({ changes, effects, selection: state.selection.map(changes, u.side < 0 ? 1 : -1), userEvent: 'input.image' });
  finishJob(job);
  return undefined;
}

// Images in a paste: screenshots and copied images (also when the clipboard adds an <img> tag
// or a file name), not a document that happens to carry a picture of itself (Word does).
function imagesFromClipboard(cd) {
  let files = [...(cd.files || [])].filter(isImageFile);
  if (!files.length && cd.items) {
    for (const it of cd.items) if (it.kind === 'file' && /^image\//.test(it.type)) files.push(it.getAsFile());
    files = files.filter(Boolean);
  }
  if (!files.length) return [];
  const plain = (cd.getData('text/plain') || '').trim();
  const html = cd.getData('text/html') || '';
  if (html) {
    let doc = null;
    try {
      doc = new DOMParser().parseFromString(html, 'text/html');
    } catch { /* treat as text */ }
    if (!doc || doc.body.textContent.trim() || !doc.querySelector('img')) return [];
  }
  if (plain && !/^[^\n]*\.(?:png|jpe?g|gif|webp|heic|heif|bmp|tiff?|avif)$/i.test(plain) && !isSingleUrl(plain)) return [];
  return files;
}

// ---------------------------------------------------------------- the extension
// ---------------------------------------------------------------- footnotes (SPEC §31)
// The post's footnotes in brief (which labels have notes, their numbers by first use, and where
// "Put notes in order" goes, -1 for nowhere), kept per document. A keystroke that can't change
// them (no bracket, caret, colon or line break typed or deleted, and not next to a marker)
// carries the last one forward: typing never rescans.
const fnBrief = new WeakMap(); // Text -> { order, defined, orderAt }
function fnBriefOf(doc) {
  let b = fnBrief.get(doc);
  if (!b) {
    const text = doc.toString();
    const info = footnotes(text);
    b = { order: info.order, defined: new Set(info.defs.keys()), orderAt: notesOutOfOrder(text, info) };
    fnBrief.set(doc, b);
  }
  return b;
}
const fnSummary = (state) => fnBriefOf(state.doc);
const FN_TOUCH = /[[\]^:\n]/;
function fnUntouched(tr) {
  let safe = true;
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    if (!safe) return;
    if (FN_TOUCH.test(inserted.toString()) || FN_TOUCH.test(tr.startState.doc.sliceString(fromA, toA))) {
      safe = false;
      return;
    }
    const line = tr.newDoc.lineAt(fromB); // newDoc: tr.state would compute the whole new state (and parse) here
    if (line.text.indexOf('[^') < 0) return;
    FN_REF.lastIndex = 0;
    let m;
    while ((m = FN_REF.exec(line.text))) {
      const a = line.from + m.index;
      if (fromB <= a + m[0].length + 1 && toB >= a - 1) safe = false;
    }
  });
  return safe;
}
const fnCarry = EditorState.transactionExtender.of((tr) => {
  if (tr.docChanged && fnBrief.has(tr.startState.doc) && fnUntouched(tr)) {
    const b = fnBrief.get(tr.startState.doc);
    fnBrief.set(tr.newDoc, b.orderAt < 0 ? b : { ...b, orderAt: tr.changes.mapPos(b.orderAt, 1) });
  }
  return null;
});

class FnRefWidget extends WidgetType {
  constructor(num, label) {
    super();
    this.num = num;
    this.label = label;
  }
  eq(o) {
    return o.num === this.num && o.label === this.label;
  }
  toDOM(view) {
    const el = h('sup', { class: 'rt-fn-ref', role: 'link', title: `Note ${this.num}: go to it`, 'aria-label': `Note ${this.num}` }, String(this.num));
    el.addEventListener('mousedown', (e) => e.preventDefault());
    el.addEventListener('click', (e) => {
      e.preventDefault();
      goToNote(view, this.label);
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}
class FnNumWidget extends WidgetType {
  constructor(num, label) {
    super();
    this.num = num;
    this.label = label;
  }
  eq(o) {
    return o.num === this.num && o.label === this.label;
  }
  toDOM(view) {
    const el = h('span', { class: `rt-fn-num${this.num ? '' : ' is-unused'}`, role: this.num ? 'link' : null,
      title: this.num ? 'Back to the text' : 'Nothing in the text refers to this note yet' }, this.num ? String(this.num) : this.label);
    el.addEventListener('mousedown', (e) => e.preventDefault());
    el.addEventListener('click', (e) => {
      e.preventDefault();
      if (this.num) goToReference(view, this.label);
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}
const fnMark = Decoration.mark({ class: 'rt-fn-mark' });
const fnLine = Decoration.line({ class: 'rt-fn-def' });
const fnLineFirst = Decoration.line({ class: 'rt-fn-def rt-fn-first' });
const INDENTED_LINE = /^(?: {2,}|\t)\S/;
const NOTE_SPACES = /^(?: {2,}|\t)\s*$/;

function inCodeBlock(state, pos) {
  for (let n = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) if (/^(FencedCode|CodeBlock|InlineCode|CodeText)$/.test(n.name)) return true;
  return false;
}

function buildFootnoteDecos(view) {
  const { state } = view;
  const doc = state.doc;
  if (!fnHas(doc)) return { decorations: Decoration.none, atoms: Decoration.none };
  const fn = fnSummary(state);
  const active = activeLineSet(view);
  const sel = state.selection.ranges;
  // The caret at the start of (or inside) a reference, or a selection over it: shown as written.
  const caretIn = (a, b) => view.hasFocus && sel.some((r) => (r.empty ? r.head >= a && r.head < b : r.from < b && r.to > a));
  const decos = [];
  const atoms = []; // the numbers stand for hidden text: one step for the caret
  const widget = (w, a, b) => {
    const d = Decoration.replace({ widget: w }).range(a, b);
    decos.push(d);
    atoms.push(d);
  };
  for (const { from, to } of view.visibleRanges) {
    let ln = doc.lineAt(from).number;
    const last = doc.lineAt(to).number;
    // Is the line above part of a note (a continuation's context)?
    let inNote = false;
    for (let k = ln - 1, n = 0; k >= 1 && n < 60; k--, n++) {
      const t = doc.line(k).text;
      if (!t.trim()) continue;
      if (FN_DEF.test(t)) inNote = true;
      else if (INDENTED_LINE.test(t)) continue;
      break;
    }
    let prevNote = false;
    let gap = 0; // blank lines in a row after a note's line
    for (; ln <= last; ln++) {
      const line = doc.line(ln);
      const t = line.text;
      const d = FN_DEF.exec(t);
      let refFrom = 0;
      if (d && !inCodeBlock(state, line.from)) {
        decos.push((prevNote ? fnLine : fnLineFirst).range(line.from));
        // A note's label is always its number (the caret stops before or after it).
        widget(new FnNumWidget(fn.order.get(d[1]) || 0, d[1]), line.from, line.from + d[0].length);
        refFrom = d[0].length;
        inNote = true;
        prevNote = true;
        gap = 0;
      } else if (inNote && INDENTED_LINE.test(t)) {
        decos.push(fnLine.range(line.from));
        prevNote = true;
        gap = 0;
      } else if (t.trim()) {
        inNote = false;
        prevNote = false;
        gap = 0;
      } else if (inNote && !gap && (NOTE_SPACES.test(t) || (ln < doc.lines && INDENTED_LINE.test(doc.line(ln + 1).text)))) {
        // A line of spaces in a note (where Enter left the caret), or a blank line between two of
        // its paragraphs: part of the note.
        decos.push(fnLine.range(line.from));
        prevNote = true;
        gap = 1;
      } else {
        prevNote = false;
        if (++gap > 1) inNote = false; // two blank lines end a note
      }
      if (t.indexOf('[^') < 0) continue;
      const masked = maskCode(t);
      FN_REF.lastIndex = refFrom;
      let m;
      while ((m = FN_REF.exec(masked))) {
        const a = line.from + m.index;
        const b = a + m[0].length;
        const num = fn.order.get(m[1]);
        if (!num || inCodeBlock(state, a)) continue;
        if (active.has(ln) || caretIn(a, b)) decos.push(fnMark.range(a, b));
        else widget(new FnRefWidget(num, m[1]), a, b);
      }
    }
  }
  return { decorations: Decoration.set(decos, true), atoms: Decoration.set(atoms, true) };
}
// Cheap test before any work: does the document have a footnote marker at all?
const fnSeen = new WeakMap();
function fnHas(doc) {
  let v = fnSeen.get(doc);
  if (v === undefined) {
    v = false;
    let prev = ''; // "[" and "^" can sit in two chunks
    for (const chunk of doc.iter()) {
      if ((prev + chunk).indexOf('[^') >= 0) {
        v = true;
        break;
      }
      prev = chunk.slice(-1);
    }
    fnSeen.set(doc, v);
  }
  return v;
}
const fnSeenCarry = EditorState.transactionExtender.of((tr) => {
  if (!tr.docChanged || !fnSeen.has(tr.startState.doc)) return null;
  // Still some: unless a "[" or "^" was deleted.
  if (fnSeen.get(tr.startState.doc) === true) {
    let removed = false;
    tr.changes.iterChanges((fromA, toA) => {
      if (!removed && /[[^]/.test(tr.startState.doc.sliceString(fromA, toA))) removed = true;
    });
    if (!removed) fnSeen.set(tr.newDoc, true);
    return null;
  }
  // Still none: unless "[^" was typed (or pasted), or a deletion joined "[" and "^".
  {
    let maybe = false;
    tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      if (maybe) return;
      const s = tr.newDoc.sliceString(Math.max(0, fromB - 1), Math.min(tr.newDoc.length, toB + 1));
      if (s.indexOf('[^') >= 0 || inserted.toString().indexOf('[^') >= 0) maybe = true;
    });
    if (!maybe) fnSeen.set(tr.newDoc, false);
  }
  return null;
});
const footnoteDecorations = ViewPlugin.fromClass(class {
  constructor(view) {
    this.build(view);
  }
  update(u) {
    if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged) this.build(u.view);
  }
  build(view) {
    const { decorations, atoms } = buildFootnoteDecos(view);
    this.decorations = decorations;
    this.atoms = atoms;
  }
}, {
  decorations: (v) => v.decorations,
  provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atoms || Decoration.none),
});

function jump(view, pos) {
  view.focus();
  view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }), userEvent: 'select' });
}
// A reference's note: the caret goes to the end of the note's first line.
function goToNote(view, label) {
  const d = footnotes(view.state.doc.toString()).defs.get(label);
  if (d) jump(view, view.state.doc.lineAt(d.start).to);
}
// A note's first reference: the caret goes just after it.
function goToReference(view, label) {
  const r = footnotes(view.state.doc.toString()).refs.find((x) => x.label === label);
  if (r) jump(view, r.to);
}

// "Add footnote": a reference at the caret (after the selection) with the number of its place in
// the text, later numbers one up; its note in its place among the notes at the end of the post
// (else at the end: under the notes there, or as a paragraph of its own); notes out of order put
// in order on the way (footnotes.js orderFootnotes); the caret in the new note. One undo step.
export function addFootnote(view) {
  if (!isEditable(view)) return false;
  const { state } = view;
  const plan = orderFootnotes(state.doc.toString(), { add: state.selection.main.to });
  dispatchPlan(view, plan, { selection: { anchor: plan.caret }, effects: EditorView.scrollIntoView(plan.caret, { y: 'center' }) });
  view.focus();
  return true;
}
// "Put notes in order": the notes' numbers by first use, and the notes at the end in that order.
export function orderNotes(view) {
  if (!isEditable(view)) return false;
  const plan = orderFootnotes(view.state.doc.toString());
  if (!plan.changes.length) return false;
  dispatchPlan(view, plan);
  return true;
}
// One transaction, sent op by op as planned so the notes it moves reach the server as moved
// (lib/score.js: a move earns and costs nothing). Stamped a second early: typing that follows
// within the history's half second would otherwise join its undo step, and it undoes on its own.
function dispatchPlan(view, plan, spec = {}) {
  view.dispatch({
    changes: plan.changes,
    ...spec,
    annotations: [OpPlan.of(plan.ops), Transaction.time.of(Date.now() - 1000)],
    userEvent: 'input.footnote',
  });
}

// "Put notes in order" (SPEC §31): a quiet button above notes at the end of the post that don't
// come in the order of their numbers (written out of order, or numbered by hand), gone once they
// are. Undo puts them back.
class FnOrderWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM(view) {
    const btn = h('button', { type: 'button', class: 'rt-up-btn', title: 'Number the notes in the order the text refers to them, and list them in that order' }, 'Put notes in order');
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (orderNotes(view)) view.focus();
    });
    return h('div', { class: 'rt-fn-order', contenteditable: 'false' }, btn);
  }
  get estimatedHeight() {
    return 24;
  }
  ignoreEvent() {
    return true;
  }
}
const fnOrderDeco = Decoration.widget({ widget: new FnOrderWidget(), block: true, side: -1 });
const fnOrderDecos = (doc) => {
  const at = fnHas(doc) ? fnBriefOf(doc).orderAt : -1;
  return at < 0 ? Decoration.none : Decoration.set([fnOrderDeco.range(at)]);
};
// A block widget changes the layout, so it's provided from a field (see uploadsField).
const fnOrderField = StateField.define({
  create: (state) => fnOrderDecos(state.doc),
  update: (decos, tr) => (tr.docChanged ? fnOrderDecos(tr.newDoc) : decos),
  provide: (f) => EditorView.decorations.from(f),
});

// A note goes on while its lines are indented (two spaces; one blank line between two such lines
// stays inside it). Is `line` part of one: its first line ("[^n]: …"), an indented line under
// it, or a blank one (spaces only, or empty) still inside it?
function noteLineKind(state, line) {
  if (inCodeBlock(state, line.from)) return null;
  if (FN_DEF.test(line.text)) return 'first';
  const blank = !line.text.trim();
  if (!blank && !INDENTED_LINE.test(line.text)) return null;
  let gap = blank ? 1 : 0;
  for (let n = line.number - 1, k = 0; n >= 1 && k < 400; n--, k++) {
    const l = state.doc.line(n);
    if (FN_DEF.test(l.text)) return inCodeBlock(state, l.from) ? null : blank ? 'blank' : 'cont';
    if (!l.text.trim()) {
      if (++gap > 1) return null;
      continue;
    }
    if (!INDENTED_LINE.test(l.text)) return null;
    gap = 0;
  }
  return null;
}
// Enter in a note starts the next line with the note's indentation, so typing simply continues
// it, as in a list; Enter on such a line left empty ends the note there (the line loses its
// indentation). Shift+Enter starts a new paragraph inside the note. Lists, quotes and code blocks
// keep their own Enter.
function noteEnter(view, para) {
  const { state } = view;
  if (state.readOnly || state.selection.ranges.length !== 1) return false;
  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.from);
  if (sel.to > line.to) return false;
  const kind = noteLineKind(state, line);
  if (!kind) return false;
  const p = parseLine(line.text);
  if (p.list || p.quote || p.heading) return false;
  if (kind === 'blank') {
    if (!line.text) return false; // an empty line already: a new line as usual
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: para ? '\n  ' : '' },
      selection: { anchor: line.from + (para ? 3 : 0) },
      userEvent: 'input',
      scrollIntoView: true,
    });
    return true;
  }
  // Before the note's text (its number, or a line's indentation): a new line as usual.
  const lead = kind === 'first' ? '' : /^\s*/.exec(line.text)[0];
  const textAt = kind === 'first' ? FN_DEF.exec(line.text)[0].length : lead.length;
  if (sel.from < line.from + textAt) return false;
  const indent = lead || '  ';
  view.dispatch(state.replaceSelection(para ? `\n\n${indent}` : `\n${indent}`), { userEvent: 'input', scrollIntoView: true });
  return true;
}

const richKeymap = Prec.high(keymap.of([
  { key: 'Mod-Alt-f', run: addFootnote },
  { key: 'Enter', run: (v) => noteEnter(v, false), shift: (v) => noteEnter(v, true) },
  { key: 'Mod-b', run: (v) => toggleInline(v, 'strong') },
  { key: 'Mod-i', run: (v) => toggleInline(v, 'em') },
  { key: 'Mod-k', run: linkCommand },
  { key: 'Mod-Shift-7', run: toggleOrdered },
  { key: 'Mod-Shift-8', run: toggleBullet },
  { key: 'Backspace', run: backspaceListMarker },
  { key: 'ArrowLeft', shift: (v) => selectAcross(v, false) },
  { key: 'ArrowRight', shift: (v) => selectAcross(v, true) },
  { key: 'Mod-ArrowLeft', mac: 'Alt-ArrowLeft', run: (v) => wordAcross(v, false, false), shift: (v) => wordAcross(v, false, true) },
  { key: 'Mod-ArrowRight', mac: 'Alt-ArrowRight', run: (v) => wordAcross(v, true, false), shift: (v) => wordAcross(v, true, true) },
  { key: 'Mod-Backspace', mac: 'Alt-Backspace', run: (v) => wordDeleteAcross(v, false) },
  { key: 'Mod-Delete', mac: 'Alt-Delete', run: (v) => wordDeleteAcross(v, true) },
  { key: 'Home', run: (v) => lineEdge(v, 'Home', false, false), shift: (v) => lineEdge(v, 'Home', false, true) },
  { key: 'End', run: (v) => lineEdge(v, 'End', true, false), shift: (v) => lineEdge(v, 'End', true, true) },
  { mac: 'Cmd-ArrowLeft', run: (v) => lineEdge(v, 'Cmd-ArrowLeft', false, false), shift: (v) => lineEdge(v, 'Cmd-ArrowLeft', false, true) },
  { mac: 'Cmd-ArrowRight', run: (v) => lineEdge(v, 'Cmd-ArrowRight', true, false), shift: (v) => lineEdge(v, 'Cmd-ArrowRight', true, true) },
]));

const richEvents = Prec.high(EditorView.domEventHandlers({
  paste(e, view) {
    const cd = e.clipboardData;
    if (!cd || view.state.readOnly) return false;
    const files = imagesFromClipboard(cd);
    if (files.length) {
      e.preventDefault();
      addImages(view, files, view.state.selection.main.from);
      return true;
    }
    // A web address pasted over a selection makes it a link.
    const plain = cd.getData('text/plain');
    const sel = view.state.selection.main;
    if (!sel.empty && isSingleUrl(plain)) {
      // (Over part of a link, the whole link: see rangeAroundLinks.)
      const r = rangeAroundLinks(view.state, sel.from, sel.to);
      const widened = r.from !== sel.from || r.to !== sel.to;
      const text = visibleText(view.state, r.from, r.to);
      const url = normalizeUrl(plain);
      if (url && !text.includes('\n') && !isSingleUrl(text) && text.trim() && (widened || !linkAt(view.state, sel.from))) {
        e.preventDefault();
        setLink(view, r, text, url);
        return true;
      }
    }
    return false;
  },
  drop(e, view) {
    const dt = e.dataTransfer;
    if (!dt || !dt.files || !dt.files.length) return false;
    const all = [...dt.files];
    const imgs = all.filter(isImageFile);
    if (!imgs.length) return false;
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
    addImages(view, imgs, pos);
    if (imgs.length === all.length) {
      e.preventDefault();
      return true;
    }
    return false; // documents too: the editor opens those
  },
  mousedown(e, view) {
    if (e.button !== 0) return false;
    // Cmd/Ctrl+click opens a link, as in other editors.
    if (e.metaKey || e.ctrlKey) {
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      const link = pos == null ? null : linkAt(view.state, pos);
      if (link) {
        e.preventDefault();
        openUrl(link.url);
        return true;
      }
    }
    ui.selecting = true;
    schedule();
    return false;
  },
  click(e, view) {
    setTimeout(endPress, 0);
    if (e.metaKey || e.ctrlKey) return false;
    // A click or tap that leaves the caret in a link shows its actions.
    setTimeout(() => {
      const sel = view.state.selection.main;
      if (!sel.empty || ui.pop?.kind === 'link-form') return;
      const link = linkAt(view.state, sel.head);
      if (link) showLinkPopover(view, link);
    }, 60);
    return false;
  },
}));

const richUpdates = EditorView.updateListener.of((u) => {
  // The editor in use: whichever has focus (it may have had it before this module loaded).
  if (u.view.hasFocus && ui.view !== u.view) ui.view = u.view;
  checkPair(u);
  if (u.view !== ui.view && !(ui.pop && ui.pop.view === u.view)) return;
  // A popover follows its text, and closes when the writer moves on.
  if (ui.pop && ui.pop.view === u.view) {
    if (u.docChanged && ui.pop.range) ui.pop.range = { from: u.changes.mapPos(ui.pop.range.from, 1), to: u.changes.mapPos(ui.pop.range.to, -1) };
    if (ui.pop.kind === 'link') {
      const sel = u.state.selection.main;
      const r = ui.pop.range;
      if (u.docChanged || !sel.empty || sel.head < r.from || sel.head > r.to) closePop();
    } else if (ui.pop.kind === 'image' && u.docChanged && !ui.pop.saving) {
      const info = imageNodeAt(u.state, ui.pop.range.from);
      if (!info || info.from !== ui.pop.range.from) closePop();
    }
  }
  if (u.selectionSet || u.docChanged || u.focusChanged || u.geometryChanged || u.viewportChanged) {
    // Typing (and what follows from it: the caret moving on, the layout shifting) can't change
    // what the bar shows as on before the frame is out; a tap, a command or focus can.
    if (u.focusChanged || u.transactions.some(notTyping)) schedule();
    else scheduleTyping();
  }
});
const notTyping = (tr) => (tr.docChanged ? !tr.isUserEvent('input.type') && !tr.isUserEvent('delete') : !!tr.selection);

// Phones, bar hidden: the caret stays clear of the chevron tab over the bottom of the text.
const tabMargin = EditorView.scrollMargins.of(() => (ui.phone && ui.dock && !ui.dock.el.hidden && ui.dock.el.classList.contains('is-collapsed') ? { bottom: 34 } : null));

const richTheme = EditorView.baseTheme({
  '.rt-url': { cursor: 'text' },
});

export const richTextExtension = [richKeymap, richEvents, linkDecorations, linkLit, keepLinkMarkup, caretOutOfMarkup, imageWidgets, footnoteDecorations, fnCarry, fnSeenCarry, fnOrderField, uploadsField, richUpdates, tabMargin, richTheme];

// ---------------------------------------------------------------- the toolbar
const svg = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const ICON = {
  bullet: svg('<circle class="f" cx="5" cy="6.5" r="1.4"/><circle class="f" cx="5" cy="12" r="1.4"/><circle class="f" cx="5" cy="17.5" r="1.4"/><path d="M9.5 6.5H20M9.5 12H20M9.5 17.5H20"/>'),
  ordered: svg('<path d="M10.5 6.5H20M10.5 12H20M10.5 17.5H20"/><path class="t" d="M3.9 5.3 5.6 4.2v5.5"/><path class="t" d="M3.9 14.2c.2-.8.9-1.3 1.7-1.2.9.1 1.4.9 1.1 1.7-.3.9-2.8 2.4-2.8 3.6h3"/>'),
  quote: svg('<circle class="f" cx="7.3" cy="14.8" r="2.7"/><circle class="f" cx="16.3" cy="14.8" r="2.7"/><path class="q" d="M4.65 14.9c-.1-3.9 1.5-6.8 4.9-8.4M13.65 14.9c-.1-3.9 1.5-6.8 4.9-8.4"/>'),
  link: svg('<path d="M10 16.2H7.6a4.2 4.2 0 0 1 0-8.4H10M14 7.8h2.4a4.2 4.2 0 0 1 0 8.4H14M8.6 12h6.8"/>'),
  image: svg('<rect x="3.5" y="5" width="17" height="14" rx="2.2"/><circle cx="9" cy="10" r="1.7"/><path d="M4.5 17.5l4.6-4.6a1 1 0 0 1 1.4 0l3.1 3.1 1.6-1.6a1 1 0 0 1 1.4 0l3 3"/>'),
  undo: svg('<path d="M8.5 13.5 4 9l4.5-4.5"/><path d="M4.5 9H14a5.5 5.5 0 0 1 0 11h-3.5"/>'),
  redo: svg('<path d="M15.5 13.5 20 9l-4.5-4.5"/><path d="M19.5 9H10a5.5 5.5 0 0 0 0 11h3.5"/>'),
  down: svg('<path d="M6.5 9.5 12 15l5.5-5.5"/>'),
  up: svg('<path d="M6.5 14.5 12 9l5.5 5.5"/>'),
  open: svg('<path d="M14 5h5v5M19 5l-8 8"/><path d="M17 13.5V18a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 5 18V8.5A1.5 1.5 0 0 1 6.5 7H11"/>'),
};
const glyph = (text, cls) => `<span class="rt-glyph ${cls}" aria-hidden="true">${text}</span>`;
const TOOLS = [
  { id: 'bold', label: 'Bold', key: 'Mod-B', icon: glyph('B', 'rt-g-b'), run: (v) => toggleInline(v, 'strong') },
  { id: 'italic', label: 'Italic', key: 'Mod-I', icon: glyph('I', 'rt-g-i'), run: (v) => toggleInline(v, 'em') },
  { id: 'heading', label: 'Heading', icon: glyph('H', 'rt-g-h'), run: cycleHeading },
  { sep: true },
  { id: 'bullet', label: 'Bulleted list', key: 'Mod-Shift-8', icon: ICON.bullet, run: toggleBullet },
  { id: 'ordered', label: 'Numbered list', key: 'Mod-Shift-7', icon: ICON.ordered, run: toggleOrdered },
  { id: 'quote', label: 'Quote', icon: ICON.quote, run: toggleQuote },
  { sep: true },
  { id: 'link', label: 'Link', key: 'Mod-K', icon: ICON.link, run: linkCommand },
  { id: 'image', label: 'Image', icon: ICON.image, run: pickImage },
  { id: 'footnote', label: 'Add footnote', key: 'Mod-Alt-F', icon: glyph('<span class="rt-g-fn-a">a</span><sup>1</sup>', 'rt-g-fn'), run: addFootnote },
  { sep: true },
  { id: 'undo', label: 'Undo', key: 'Mod-Z', icon: ICON.undo, run: (v) => undo(v) },
  { id: 'redo', label: 'Redo', key: 'Mod-Shift-Z', icon: ICON.redo, run: (v) => redo(v) },
];

function buildBar(cls) {
  const bar = h('div', { class: cls, role: 'toolbar', 'aria-label': 'Formatting' });
  const buttons = {};
  for (const t of TOOLS) {
    if (t.sep) {
      bar.append(h('span', { class: 'rt-sep', 'aria-hidden': 'true' }));
      continue;
    }
    const title = t.key ? `${t.label.replace(/ \(.*\)$/, '')} (${shortcut(t.key)})` : t.label;
    const b = h('button', { type: 'button', class: `rt-btn rt-btn-${t.id}`, title, 'aria-label': t.label.replace(/ \(.*\)$/, ''), dataset: { tool: t.id } });
    b.innerHTML = t.icon;
    if (['bold', 'italic', 'heading', 'bullet', 'ordered', 'quote', 'link'].includes(t.id)) b.setAttribute('aria-pressed', 'false');
    // Keep the editor focused (and the phone keyboard up) while a button is pressed.
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => {
      e.preventDefault();
      const view = ui.view;
      if (!view || !isEditable(view)) return;
      closePop();
      t.run(view);
      if (t.id !== 'link' && t.id !== 'image') view.focus();
      schedule();
    });
    buttons[t.id] = b;
    bar.append(b);
  }
  return { bar, buttons };
}

function pickImage(view) {
  if (!isEditable(view)) return false;
  ui.pickFor = { view, pos: view.state.selection.main.head };
  ui.fileInput.value = '';
  ui.fileInput.click();
  return true;
}

// What the bar shows as on: bold, italic, heading level, list, quote, link; undo/redo available.
function formatState(view) {
  const { state } = view;
  const sel = state.selection.main;
  const inAll = (name) => {
    if (sel.empty) return !!emphasisAt(state, sel.head, name);
    for (let n = syntaxTree(state).resolveInner(sel.from, 1); n; n = n.parent) if (n.name === name && n.from <= sel.from && n.to >= sel.to) return true;
    return false;
  };
  const p = parseLine(state.doc.lineAt(sel.from).text);
  const noop = () => {};
  return {
    bold: inAll('StrongEmphasis'),
    italic: inAll('Emphasis'),
    heading: p.heading ? p.heading.level : 0,
    bullet: !!p.bullet,
    ordered: !!p.ordered,
    quote: !!p.quote,
    link: !!linkAt(state, sel.head),
    undo: undo({ state, dispatch: noop }),
    redo: redo({ state, dispatch: noop }),
  };
}
// The bars are repainted after every keystroke: only what changed is written (a write costs the
// page a style pass, and replacing the chevron's icon a layout and a repaint of the bar).
function setAttr(el, name, value) {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}
function paintButtons(buttons, st) {
  for (const id of ['bold', 'italic', 'bullet', 'ordered', 'quote', 'link']) setAttr(buttons[id], 'aria-pressed', String(!!st[id]));
  setAttr(buttons.heading, 'aria-pressed', String(!!st.heading));
  const hg = buttons.heading.querySelector('.rt-glyph');
  const want = st.heading === 2 || st.heading === 3 ? `H<sub>${st.heading}</sub>` : 'H';
  if (hg.innerHTML !== want) hg.innerHTML = want;
  setAttr(buttons.heading, 'title', st.heading === 2 ? 'Heading: large (tap for small)' : st.heading === 3 ? 'Heading: small (tap for none)' : 'Heading');
  if (buttons.undo.disabled !== !st.undo) buttons.undo.disabled = !st.undo;
  if (buttons.redo.disabled !== !st.redo) buttons.redo.disabled = !st.redo;
}

// Typing alone (scheduleTyping) updates the bar's place and visibility in the frame as usual, but
// its pressed states once the frame is out (paintDockSoon): a keystroke's frame never waits for them.
// Anything else (a tap, a command, focus, scrolling) updates everything in the frame.
let typingOnly = true;
function schedule() {
  typingOnly = false;
  if (!ui.raf) ui.raf = requestAnimationFrame(sync);
}
function scheduleTyping() {
  if (!ui.raf) ui.raf = requestAnimationFrame(sync);
}

function sync() {
  ui.raf = 0;
  const typing = typingOnly;
  typingOnly = true;
  const view = ui.view;
  const usable = view && visible(view) && isEditable(view);
  if (ui.phone) {
    hideFloat();
    hideInsert();
    syncDock(usable ? view : null, typing);
  } else {
    hideDock();
    syncFloat(usable ? view : null);
    syncInsert(usable ? view : null);
  }
  if (ui.pop) positionPop();
}

// ---- desktop: on an empty line, a quiet image button in the margin (after a pause, so it
// never flickers while paragraphs are being typed). Pasting or dropping an image works anywhere.
function hideInsert() {
  clearTimeout(ui.insertTimer);
  ui.insertTimer = 0;
  if (ui.insert && !ui.insert.hidden) ui.insert.hidden = true;
}
function syncInsert(view) {
  const sel = view && view.state.selection.main;
  const line = sel && view.state.doc.lineAt(sel.head);
  const ok = view && view.hasFocus && sel.empty && !line.text && !view.composing && !ui.pop && !ui.selecting
    && view.state.selection.ranges.length === 1;
  if (!ok) {
    hideInsert();
    return;
  }
  if (!ui.insert) {
    ui.insert = h('button', { type: 'button', class: 'rt-insert', title: 'Add an image (or paste or drop one anywhere)', 'aria-label': 'Add an image', hidden: true });
    ui.insert.innerHTML = ICON.image;
    ui.insert.addEventListener('mousedown', (e) => e.preventDefault());
    ui.insert.addEventListener('click', (e) => {
      e.preventDefault();
      if (ui.view && isEditable(ui.view)) pickImage(ui.view);
      hideInsert();
    });
    document.body.append(ui.insert);
  }
  const place = () => {
    const c = view.coordsAtPos(sel.head);
    const box = view.contentDOM.getBoundingClientRect();
    if (!c) return hideInsert();
    ui.insert.style.transform = `translate(${Math.round(box.left - 40)}px, ${Math.round((c.top + c.bottom) / 2 - 15)}px)`;
    return undefined;
  };
  if (!ui.insert.hidden) {
    place();
    return;
  }
  if (ui.insertTimer) return;
  ui.insertTimer = setTimeout(() => {
    ui.insertTimer = 0;
    const v = ui.view;
    const s2 = v && v.state.selection.main;
    if (v !== view || !v.hasFocus || !s2.empty || s2.head !== sel.head || v.state.doc.lineAt(s2.head).text) return;
    ui.insert.hidden = false;
    place();
  }, 700);
}

// ---- desktop: floating above the selection
function hideFloat() {
  if (ui.float && !ui.float.bar.hidden) ui.float.bar.hidden = true;
}
function syncFloat(view) {
  const sel = view && view.state.selection.main;
  const inPop = ui.pop && document.activeElement && ui.pop.el.contains(document.activeElement);
  if (!view || !view.hasFocus || ui.selecting || sel.empty || inPop || view.composing || isWholeImage(view.state, sel)) {
    hideFloat();
    return;
  }
  if (!ui.float) {
    ui.float = buildBar('rt-float');
    document.body.append(ui.float.bar);
  }
  const from = view.coordsAtPos(sel.from, 1);
  const to = view.coordsAtPos(sel.to, -1);
  const box = view.scrollDOM.closest('.w-sheet, .w-notes-body')?.getBoundingClientRect() || view.dom.getBoundingClientRect();
  if (!from || !to || to.bottom < box.top || from.top > box.bottom) {
    hideFloat();
    return;
  }
  paintButtons(ui.float.buttons, formatState(view));
  const bar = ui.float.bar;
  const wasHidden = bar.hidden;
  bar.hidden = false;
  const sameLine = Math.abs(from.top - to.top) < 4;
  const left = sameLine ? (from.left + to.right) / 2 : from.left + 8;
  const topLimit = Math.max(box.top, document.querySelector('.w-top')?.getBoundingClientRect().bottom || 0) + 6;
  const bw = bar.offsetWidth;
  const bh = bar.offsetHeight;
  let y = Math.min(from.top, to.top) - bh - 10;
  let below = false;
  if (y < topLimit) {
    y = Math.max(from.bottom, to.bottom) + 10;
    below = true;
  }
  const x = Math.max(8, Math.min(window.innerWidth - bw - 8, left - bw / 2));
  bar.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  bar.classList.toggle('is-below', below);
  if (wasHidden) {
    bar.classList.remove('is-in');
    void bar.offsetWidth;
    bar.classList.add('is-in');
  }
}
function isWholeImage(state, sel) {
  if (sel.empty) return false;
  const info = imageNodeAt(state, sel.from);
  return !!info && info.from === sel.from && info.to === sel.to;
}

// ---- phones: docked above the keyboard
function readPref() {
  try {
    return localStorage.getItem(PREF_KEY) === 'hidden';
  } catch {
    return false;
  }
}
function writePref(hidden) {
  try {
    localStorage.setItem(PREF_KEY, hidden ? 'hidden' : 'shown');
  } catch { /* private mode: this visit only */ }
}
function hideDock() {
  if (!ui.dock || ui.dock.el.hidden) return;
  ui.dock.el.hidden = true;
  ui.dock.app?.classList.remove('rt-docked', 'rt-dock-collapsed');
}
function buildDock() {
  const { bar, buttons } = buildBar('rt-dock-tools');
  const chev = h('button', { type: 'button', class: 'rt-chev', 'aria-label': 'Hide formatting', 'aria-expanded': 'true', title: 'Hide formatting' });
  chev.innerHTML = ICON.down;
  chev.addEventListener('mousedown', (e) => e.preventDefault());
  chev.addEventListener('click', (e) => {
    e.preventDefault();
    ui.collapsed = !ui.collapsed;
    writePref(ui.collapsed);
    ui.dock.forceOpen = false;
    sync();
    if (ui.view && !ui.collapsed) revealCaret(ui.view);
  });
  const el = h('div', { class: 'rt-dock', hidden: true }, h('div', { class: 'rt-dock-scroll' }, bar), chev);
  return { el, bar, buttons, chev, app: null };
}
function syncDock(view, typing = false) {
  const popOpen = ui.pop && (ui.pop.kind === 'link-form' || ui.pop.kind === 'image');
  const focusedish = view && (view.hasFocus || (ui.pop && ui.pop.view === view));
  if (!view || !focusedish || popOpen) {
    hideDock();
    return;
  }
  if (!ui.dock) ui.dock = buildDock();
  const d = ui.dock;
  const app = view.dom.closest('.w-app');
  if (app && d.el.parentNode !== app) {
    app.append(d.el);
    d.app = app;
  } else if (!app && d.el.parentNode !== document.body) {
    document.body.append(d.el);
    d.el.classList.add('is-fixed');
    d.app = null;
  }
  const sel = view.state.selection.main;
  const expanded = !ui.collapsed || !sel.empty;
  const wasShown = !d.el.hidden && !d.el.classList.contains('is-collapsed');
  d.el.hidden = false;
  d.el.classList.toggle('is-collapsed', !expanded);
  d.el.classList.toggle('is-kb', ui.kb);
  if (d.app && !d.app.classList.contains('rt-docked')) d.app.classList.add('rt-docked');
  d.app?.classList.toggle('rt-dock-collapsed', !expanded);
  if (!expanded) {
    const foot = d.app?.querySelector('.w-foot');
    d.el.style.setProperty('--rt-foot-h', `${foot ? foot.offsetHeight : 0}px`);
  }
  const icon = expanded ? ICON.down : ICON.up;
  if (d.chevIcon !== icon) {
    d.chevIcon = icon;
    d.chev.innerHTML = icon;
  }
  setAttr(d.chev, 'aria-expanded', String(expanded));
  setAttr(d.chev, 'aria-label', expanded ? 'Hide formatting' : 'Show formatting');
  setAttr(d.chev, 'title', expanded ? 'Hide formatting' : 'Show formatting');
  const chevOff = expanded && !sel.empty && ui.collapsed; // shown for the selection: nothing to hide
  if (d.chev.disabled !== chevOff) d.chev.disabled = chevOff;
  if (expanded && wasShown && typing) paintDockSoon();
  else if (expanded) paintButtons(d.buttons, formatState(view));
  if (expanded && !wasShown) revealCaret(view);
}
let dockPaint = 0;
function paintDockSoon() {
  if (dockPaint) return;
  const run = () => {
    dockPaint = 0;
    const d = ui.dock;
    const view = ui.view;
    if (!d || d.el.hidden || d.el.classList.contains('is-collapsed') || !view || !view.dom.isConnected || !isEditable(view)) return;
    paintButtons(d.buttons, formatState(view));
  };
  dockPaint = typeof requestIdleCallback === 'function' ? requestIdleCallback(run, { timeout: 100 }) : setTimeout(run, 16);
}
// Keep the caret line in view when the bar appears (the text area just got shorter).
function revealCaret(view) {
  requestAnimationFrame(() => {
    if (!view.dom.isConnected) return;
    view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'nearest', yMargin: 24 }) });
  });
}

// ---------------------------------------------------------------- popovers
function closePop() {
  const p = ui.pop;
  if (!p) return;
  ui.pop = null;
  p.el.remove();
  p.target?.classList.remove('is-active');
  p.onClose?.(p);
  schedule();
}
// Desktop (and the link card on phones): next to its target. Forms on phones: a sheet at the
// bottom of the visible area, above the keyboard.
function positionPop() {
  const p = ui.pop;
  if (!p || !p.el.isConnected) return;
  const vv = window.visualViewport;
  const vTop = vv ? vv.offsetTop : 0;
  const vH = vv ? vv.height : window.innerHeight;
  const vLeft = vv ? vv.offsetLeft : 0;
  const vW = vv ? vv.width : window.innerWidth;
  const el = p.el;
  if (p.sheet) {
    el.style.transform = `translate(${Math.round(vLeft)}px, ${Math.round(vTop + vH - el.offsetHeight)}px)`;
    el.style.width = `${Math.round(vW)}px`;
    return;
  }
  const a = p.anchor();
  if (!a) {
    closePop();
    return;
  }
  const w = el.offsetWidth;
  const hh = el.offsetHeight;
  let y = a.bottom + 8;
  if (y + hh > vTop + vH - 8) y = a.top - hh - 8;
  y = Math.max(vTop + 8, Math.min(vTop + vH - hh - 8, y));
  const x = Math.max(vLeft + 8, Math.min(vLeft + vW - w - 8, (a.left + a.right) / 2 - w / 2));
  el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}
function openPop({ kind, view, content, anchor, sheet = false, range = null, target = null, onClose = null, label }) {
  closePop();
  const el = h('div', { class: `rt-pop rt-pop-${kind}${sheet ? ' is-sheet' : ''}`, role: 'dialog', 'aria-label': label }, content);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closePop();
      view.focus();
    }
  });
  document.body.append(el);
  ui.pop = { kind, view, el, anchor, sheet, range, target, onClose };
  target?.classList.add('is-active');
  positionPop();
  requestAnimationFrame(positionPop);
  schedule();
  return ui.pop;
}
function linkRect(view, link) {
  const a = view.coordsAtPos(link.from, 1);
  const b = view.coordsAtPos(link.to, -1);
  if (!a || !b) return null;
  return Math.abs(a.top - b.top) < 4 ? { left: a.left, right: b.right, top: a.top, bottom: b.bottom } : { left: a.left, right: a.left + 40, top: a.top, bottom: a.bottom };
}

function prettyUrl(url) {
  return url.replace(/^mailto:/i, '').replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
}
// Open · Edit · Remove for the link under the caret.
function showLinkPopover(view, link) {
  if (ui.pop?.kind === 'link' && ui.pop.view === view && ui.pop.range?.from === link.from) return;
  const editable = isEditable(view);
  const web = WEB_URL.test(link.url);
  const open = h(web ? 'a' : 'span', { class: 'rt-pop-url', href: web ? link.url : null, target: web ? '_blank' : null, rel: web ? 'noopener noreferrer nofollow' : null, title: link.url }, prettyUrl(link.url));
  open.addEventListener('click', (e) => {
    e.preventDefault();
    openUrl(link.url);
  });
  const openBtn = h('button', { type: 'button', class: 'rt-pop-btn', title: 'Open in a new tab' }, 'Open');
  openBtn.insertAdjacentHTML('beforeend', ICON.open);
  openBtn.addEventListener('click', () => {
    openUrl(link.url);
    closePop();
  });
  const btns = web ? [openBtn] : [];
  if (editable) {
    btns.push(h('button', {
      type: 'button',
      class: 'rt-pop-btn',
      onClick: () => {
        const cur = linkAt(view.state, ui.pop?.range?.from ?? link.from) || link;
        openLinkForm(view, { link: cur });
      },
    }, 'Edit'));
    btns.push(h('button', {
      type: 'button',
      class: 'rt-pop-btn',
      title: link.kind === 'link' ? 'Remove the link, keep the text' : 'Remove this address',
      onClick: () => {
        const cur = linkAt(view.state, ui.pop?.range?.from ?? link.from) || link;
        closePop();
        unlink(view, cur);
        view.focus();
      },
    }, 'Remove'));
  }
  for (const b of btns) b.addEventListener('mousedown', (e) => e.preventDefault());
  const pop = openPop({
    kind: 'link',
    view,
    label: 'Link',
    range: { from: link.from, to: link.to },
    content: h('div', { class: 'rt-pop-row' }, open, h('span', { class: 'rt-pop-acts' }, btns)),
    anchor: () => (ui.pop ? linkRect(view, { from: ui.pop.range.from, to: ui.pop.range.to }) : null),
  });
  return pop;
}

function field(label, input, hint) {
  return h('label', { class: 'rt-field' }, h('span', { class: 'rt-field-label' }, label), input, hint ? h('span', { class: 'rt-field-hint' }, hint) : null);
}

// Add or edit a link: the address (paste-friendly) and, when there's no selection, its text.
function openLinkForm(view, { link = null, from, to, text = '' }) {
  if (!isEditable(view)) return;
  const sel = view.state.selection.main;
  const range = link ? { from: link.from, to: link.to } : { from, to };
  const curText = link ? view.state.sliceDoc(link.textFrom, link.textTo) : text;
  const showText = !!link || !text.trim();
  const urlIn = h('input', {
    type: 'url', class: 'rt-input', inputmode: 'url', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
    placeholder: 'https://…', value: link ? link.url : isSingleUrl(text) ? text.trim() : '',
  });
  const textIn = h('input', { type: 'text', class: 'rt-input', placeholder: 'Text to show (optional)', value: link && link.kind !== 'link' ? '' : curText });
  const err = h('p', { class: 'rt-form-err', role: 'alert' });
  const save = h('button', { type: 'submit', class: 'btn btn-primary rt-form-save' }, link ? 'Save' : 'Add link');
  const cancel = h('button', { type: 'button', class: 'btn btn-quiet', onClick: () => done(false) }, 'Cancel');
  const remove = link ? h('button', {
    type: 'button',
    class: 'btn btn-quiet rt-form-remove',
    onClick: () => {
      const cur = linkAt(view.state, ui.pop?.range?.from ?? link.from) || link;
      closePop();
      unlink(view, cur);
      view.focus();
    },
  }, 'Remove link') : null;
  const form = h('form', { class: 'rt-form', novalidate: true },
    h('p', { class: 'rt-form-title' }, link ? 'Edit link' : 'Add a link'),
    field('Link address', urlIn),
    showText ? field('Text', textIn) : null,
    err,
    h('div', { class: 'rt-form-actions' }, remove, h('span', { class: 'rt-grow' }), cancel, save));
  function done(ok) {
    const r = ui.pop?.range || range;
    if (ok) {
      const url = normalizeUrl(urlIn.value);
      if (!url) {
        err.textContent = urlIn.value.trim() ? 'That doesn’t look like a web address. Try one that starts with https://' : 'Paste or type the web address.';
        urlIn.setAttribute('aria-invalid', 'true');
        urlIn.focus();
        return;
      }
      const t = showText ? textIn.value : visibleText(view.state, r.from, r.to);
      // The link as it is now (the text may have moved while the form was open).
      const cur = link ? linkAt(view.state, r.from + 1) : null;
      closePop();
      setLink(view, r, t, url, cur && cur.from === r.from ? cur : null);
    } else {
      closePop();
      view.dispatch({ selection: { anchor: Math.min(sel.anchor, view.state.doc.length), head: Math.min(sel.head, view.state.doc.length) } });
    }
    view.focus();
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    done(true);
  });
  urlIn.addEventListener('input', () => {
    err.textContent = '';
    urlIn.removeAttribute('aria-invalid');
  });
  openPop({
    kind: 'link-form',
    view,
    label: link ? 'Edit link' : 'Add a link',
    sheet: ui.phone,
    range,
    content: form,
    anchor: () => {
      const r = ui.pop?.range || range;
      const a = view.coordsAtPos(r.from, 1);
      const b = view.coordsAtPos(r.to, -1) || a;
      return a ? { left: a.left, right: Math.abs(a.top - b.top) < 4 ? b.right : a.left + 40, top: a.top, bottom: a.bottom } : null;
    },
  });
  // Focus at once (inside the click or key press): keys typed right away land in the form, and
  // phones open their keyboard for it.
  (urlIn.value && showText && !textIn.value ? textIn : urlIn).focus({ preventScroll: true });
  if (!urlIn.value) {
    clipboardUrl().then((u) => {
      if (u && !urlIn.value && ui.pop?.el.contains(urlIn)) {
        urlIn.value = u;
        urlIn.select();
      }
    });
  }
}

// A description that fits between the brackets of ![…](…): one line, no brackets or backslashes.
const cleanAlt = (t) => String(t || '').replace(/[\r\n\t]+/g, ' ').replace(/[[\]\\]/g, '');
const editorFor = (view) => openEditors().find((e) => e.view === view) || null;

// Describe the image (its alt text, shown as the caption) or remove it. The description goes
// into the text as it's typed, keystroke by keystroke, so it counts like any other typing, with
// the same timing (SPEC §14b); a paste or drop into the field gets the same paste question as a
// paste into the text.
function openImageForm(view, dom) {
  let pos;
  try {
    pos = view.posAtDOM(dom);
  } catch {
    return;
  }
  const info = imageNodeAt(view.state, pos);
  if (!info) return;
  const editable = isEditable(view);
  const altIn = h('input', { type: 'text', class: 'rt-input', value: info.alt, placeholder: 'What’s in the picture?', maxlength: 300, readonly: editable ? null : true, enterkeyhint: 'done', autocapitalize: 'sentences' });
  const current = (p = ui.pop) => imageNodeAt(view.state, p?.range?.from ?? info.from);
  const write = (spec) => {
    if (ui.pop) ui.pop.saving = true;
    view.dispatch(spec);
    if (ui.pop) ui.pop.saving = false;
  };
  // The field -> the text: only what changed, as typing (an input method's word as composition).
  let composing = false;
  const mirror = (userEvent) => {
    const cur = current();
    if (!cur || !editable || view.state.readOnly) return;
    const val = cleanAlt(altIn.value);
    if (val !== altIn.value) {
      const at = Math.max(0, (altIn.selectionStart ?? val.length) - (altIn.value.length - val.length));
      altIn.value = val;
      altIn.setSelectionRange(at, at);
    }
    const old = cur.alt;
    if (val === old) return;
    let p = 0;
    while (p < old.length && p < val.length && old[p] === val[p]) p++;
    let q = 0;
    while (q < old.length - p && q < val.length - p && old[old.length - 1 - q] === val[val.length - 1 - q]) q++;
    write({ changes: { from: cur.altFrom + p, to: cur.altTo - q, insert: val.slice(p, val.length - q) }, userEvent });
  };
  altIn.addEventListener('compositionstart', () => {
    composing = true;
  });
  altIn.addEventListener('compositionend', () => {
    composing = false;
    mirror('input.type.compose');
  });
  altIn.addEventListener('input', (e) => mirror(composing || e.isComposing ? 'input.type.compose' : 'input.type'));
  // Pasted or dropped text: the paste question, then in as a paste (or not at all).
  const pasteIn = async (text, keyboard = false) => {
    const clean = cleanAlt(text).trim();
    const a = altIn.selectionStart ?? altIn.value.length;
    const b = altIn.selectionEnd ?? a;
    if (!clean || !editable) return;
    const ed = editorFor(view);
    const res = ed?.askPaste ? await ed.askPaste({ text: clean, keyboard }) : { text: clean, meta: { m: '', d: 'no' } };
    const cur = current();
    if (!res || !res.text || !cur || view.state.readOnly) {
      if (ui.pop) altIn.focus();
      return;
    }
    // The paste answer covers exactly the words asked about; anything else claims nothing.
    const ins = cleanAlt(res.text);
    const meta = ins === res.text ? res.meta : { m: '', d: 'no' };
    const from = cur.altFrom + Math.min(a, cur.alt.length);
    const to = cur.altFrom + Math.min(Math.max(a, b), cur.alt.length);
    write({ changes: { from, to, insert: ins }, annotations: PasteMeta.of(meta), userEvent: 'input.paste' });
    const now = current();
    if (now && ui.pop) {
      altIn.value = now.alt;
      altIn.focus();
      const at = Math.min(now.alt.length, (from - now.altFrom) + ins.length);
      altIn.setSelectionRange(at, at);
    }
  };
  altIn.addEventListener('paste', (e) => {
    const t = e.clipboardData?.getData('text/plain');
    if (t == null) return;
    e.preventDefault();
    pasteIn(t);
  });
  altIn.addEventListener('drop', (e) => {
    const t = e.dataTransfer?.getData('text/plain');
    if (!t) return;
    e.preventDefault();
    pasteIn(t);
  });
  altIn.addEventListener('beforeinput', (e) => {
    if (!e.cancelable) return;
    if (e.inputType === 'insertFromPaste' || e.inputType === 'insertFromDrop') {
      const t = e.dataTransfer?.getData('text/plain') ?? e.data;
      if (t) {
        e.preventDefault();
        pasteIn(t);
      }
    } else if (ANDROID && (e.inputType === 'insertText' || e.inputType === 'insertReplacementText') && e.data && e.data.length > 24 && countWords(e.data) > 12) {
      // Android's keyboard clipboard chip types a paste instead of pasting it: asked about as
      // a paste, as in the text.
      e.preventDefault();
      pasteIn(e.data, true);
    }
  });
  // Spaces left at either end go when the form closes (deleting a space costs nothing).
  const tidy = (p) => {
    const cur = current(p);
    if (!cur || !editable || view.state.readOnly) return;
    const lead = cur.alt.length - cur.alt.trimStart().length; // all of it, if it's only spaces
    const trail = cur.alt.trim() ? cur.alt.length - cur.alt.trimEnd().length : 0;
    const changes = [];
    if (lead) changes.push({ from: cur.altFrom, to: cur.altFrom + lead });
    if (trail) changes.push({ from: cur.altTo - trail, to: cur.altTo });
    if (changes.length) write({ changes, userEvent: 'input.type' });
  };
  const remove = editable ? h('button', {
    type: 'button',
    class: 'btn btn-quiet rt-form-remove',
    onClick: () => {
      const from = ui.pop?.range?.from ?? info.from;
      closePop();
      const cur = imageNodeAt(view.state, from);
      if (cur) removeImage(view, cur);
      if (!ui.phone) view.focus();
    },
  }, 'Remove image') : null;
  const form = h('form', { class: 'rt-form rt-form-image', novalidate: true },
    h('div', { class: 'rt-form-image-head' },
      h('img', { class: 'rt-form-thumb', src: info.path, alt: '' }),
      h('div', null,
        h('p', { class: 'rt-form-title' }, 'Describe the image'),
        h('p', { class: 'rt-form-note' }, 'Shown under it as a caption, and read aloud to people who can’t see it. It counts like your other words.'))),
    field('Description', altIn),
    h('div', { class: 'rt-form-actions' }, remove, h('span', { class: 'rt-grow' }),
      h('button', { type: 'submit', class: 'btn btn-primary' }, 'Done')));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    closePop();
    if (!ui.phone) view.focus();
  });
  openPop({
    kind: 'image',
    view,
    label: 'Image',
    sheet: ui.phone,
    range: { from: info.from, to: info.to },
    target: dom,
    content: form,
    anchor: () => (dom.isConnected ? dom.getBoundingClientRect() : null),
    onClose: tidy,
  });
  if (!ui.phone) altIn.focus({ preventScroll: true });
}

// Takes the image out with its line and one blank line next to it, so no gap is left.
function removeImage(view, info) {
  const { doc } = view.state;
  let from = info.from;
  let to = info.to;
  const line = doc.lineAt(from);
  if (line.text.trim() === doc.sliceString(info.from, info.to).trim()) {
    const next = line.number < doc.lines ? doc.line(line.number + 1) : null;
    const prev = line.number > 1 ? doc.line(line.number - 1) : null;
    if (next) {
      from = line.from;
      to = next.from;
      const after = next;
      if (!after.text.trim() && (!prev || !prev.text.trim()) && after.number < doc.lines) to = doc.line(after.number + 1).from;
      else if (!after.text.trim() && !prev) to = after.to < doc.length ? after.to + 1 : after.to;
    } else if (prev) {
      from = prev.to;
      to = line.to;
      if (!prev.text.trim() && prev.number > 1) from = doc.line(prev.number - 1).to;
    } else {
      from = line.from;
      to = line.to;
    }
  }
  view.dispatch({ changes: { from, to }, selection: { anchor: from }, userEvent: 'input.image' });
}

// ---------------------------------------------------------------- install
function loadStyles() {
  if (document.querySelector('link[data-rt]')) return;
  const app = document.querySelector('link[href*="/css/app.css"]');
  const v = (/[?&]v=([\w-]+)/.exec(app?.getAttribute('href') || '') || [])[1];
  document.head.append(h('link', { rel: 'stylesheet', href: `/css/richtext.css${v ? `?v=${v}` : ''}`, 'data-rt': '' }));
}

function trackKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  if (Math.abs(vv.width - ui.vvW) > 40) {
    ui.vvW = vv.width;
    ui.maxVvH = 0; // rotated: start over
  }
  ui.maxVvH = Math.max(ui.maxVvH, vv.height);
  ui.kb = window.innerHeight - vv.height > 120 || ui.maxVvH - vv.height > 120;
}

export function install() {
  if (ui.installed) return;
  ui.installed = true;
  loadStyles();
  const coarse = typeof matchMedia === 'function' ? matchMedia('(hover: none) and (pointer: coarse)') : null;
  ui.phone = !!coarse?.matches;
  coarse?.addEventListener?.('change', () => {
    ui.phone = coarse.matches;
    closePop();
    schedule();
  });
  ui.collapsed = readPref();
  // Visually hidden rather than display:none, which some phone browsers won't open a picker for.
  ui.fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'rt-file', 'aria-hidden': 'true', tabindex: '-1' });
  ui.fileInput.addEventListener('change', () => {
    const files = [...ui.fileInput.files];
    const p = ui.pickFor;
    ui.pickFor = null;
    if (p && files.length && p.view.dom.isConnected) addImages(p.view, files, Math.min(p.pos, p.view.state.doc.length));
  });
  document.body.append(ui.fileInput);
  addEditorExtension(richTextExtension);
  for (const ed of openEditors()) if (ed.view.hasFocus) ui.view = ed.view;

  window.addEventListener('mouseup', () => {
    if (ui.selecting) {
      ui.selecting = false;
      schedule();
    }
  }, true);
  // A press in the text: the lit link waits for its click (or, without one, a moment).
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !e.target.closest?.('.cm-content')) return;
    clearTimeout(ui.pressTimer);
    ui.pressing = true;
  }, true);
  const released = () => {
    if (!ui.pressing) return;
    clearTimeout(ui.pressTimer);
    ui.pressTimer = setTimeout(endPress, 400);
  };
  window.addEventListener('pointerup', released, true);
  window.addEventListener('pointercancel', released, true);
  window.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);
  const vv = window.visualViewport;
  if (vv) {
    const onVv = () => {
      trackKeyboard();
      schedule();
    };
    vv.addEventListener('resize', onVv);
    vv.addEventListener('scroll', onVv);
    trackKeyboard();
  }
  window.addEventListener('online', () => {
    for (const job of jobs.values()) if (job.status === 'waiting') wake(job);
  });
  // Outside a popover: it closes (a tap in the text moves the caret as usual).
  document.addEventListener('pointerdown', (e) => {
    const p = ui.pop;
    if (!p || p.el.contains(e.target) || p.target?.contains(e.target)) return;
    if (e.target.closest?.('dialog')) return; // the paste question, in front of the form
    if (ui.float?.bar.contains(e.target) || ui.dock?.el.contains(e.target)) return;
    if (p.kind === 'link-form' || p.kind === 'image') {
      // A form keeps what was typed only when it's confirmed: clicking away cancels it.
      closePop();
    } else if (!p.view.dom.contains(e.target)) closePop();
  }, true);
  document.addEventListener('focusin', schedule);
  document.addEventListener('focusout', () => setTimeout(schedule, 0));
  window.addEventListener('beforeunload', (e) => {
    if ([...jobs.values()].some((j) => !j.cancelled && j.status !== 'error')) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}
