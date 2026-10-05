// The writing surface: CodeMirror 6 + Markdown, styled as a live preview
// (syntax marks fade away off the line you're on), smart punctuation as you
// type, rich paste-in / copy-out, and ops taken from the transaction model.

import {
  EditorState, EditorView, ViewPlugin, Decoration, WidgetType, Annotation, Compartment, keymap,
  drawSelection, placeholder as cmPlaceholder, history, historyKeymap, undo, redo, defaultKeymap, indentWithTab,
  syntaxTree, HighlightStyle, syntaxHighlighting, Language, LanguageSupport, markdownLanguage, markdownKeymap,
  searchKeymap, search, tags, Transaction,
} from '../vendor/cm.js';
import { countWords, stripInvisible, hasInvisible, replayOps, cutsIn, BIG_CUT_WORDS, WORD_SCAN_MAX } from './text.js';

export const Remote = Annotation.define(); // changes that came from the server: no ops
export const PasteMeta = Annotation.define(); // attribution for a paste
// An edit sent as planned: its ops, one after another ({ pos, del, ins, source? }), instead of the
// ops read off its changes. Footnotes put in order (footnotes.js orderFootnotes) go this way so the
// notes they move reach the server as moved (source 'move'); their undo and redo too.
export const OpPlan = Annotation.define();

// GFM without setext headings (SPEC §14c): a line of "-" or "=" under a paragraph doesn't make
// it a heading (starting a list with "-" made the line above flash into one), and "---" is
// always a divider. Headings are "#" lines, as the public pages and exports read them too.
const mdLanguage = new Language(markdownLanguage.data, markdownLanguage.parser.configure({ remove: ['SetextHeading'] }), [], 'markdown');

// ---- live preview ---------------------------------------------------------
class BulletWidget extends WidgetType {
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-bullet';
    s.textContent = '•';
    return s;
  }
  eq() {
    return true;
  }
}
const bullet = Decoration.replace({ widget: new BulletWidget() });
// A divider ("---", "***", "___") off the caret's line: the asterism the public pages draw for it.
class RuleWidget extends WidgetType {
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-hr-mark';
    s.setAttribute('aria-hidden', 'true');
    s.textContent = '⁂';
    return s;
  }
  eq() {
    return true;
  }
}
const rule = Decoration.replace({ widget: new RuleWidget() });
const hide = Decoration.replace({});
// Link text: only on [text](address), never on "[note]" alone (the parser calls both Link).
const linkText = Decoration.mark({ class: 'cm-tok-link' });
const lineDeco = {};
const line = (cls) => (lineDeco[cls] ||= Decoration.line({ class: cls }));

function activeLines(view) {
  const set = new Set();
  if (!view.hasFocus) return set;
  for (const r of view.state.selection.ranges) {
    const a = view.state.doc.lineAt(r.from).number;
    const b = view.state.doc.lineAt(r.to).number;
    for (let n = a; n <= b && n - a < 500; n++) set.add(n);
  }
  return set;
}

const OPEN_QUOTE = /^[“‘"'«]/;

function buildDecorations(view) {
  const { state } = view;
  const doc = state.doc;
  const active = activeLines(view);
  const isActive = (pos) => active.has(doc.lineAt(pos).number);
  const decos = [];
  const lineClass = new Map(); // line start -> Set(classes)
  const addLine = (pos, cls) => {
    const l = doc.lineAt(pos);
    if (!lineClass.has(l.from)) lineClass.set(l.from, new Set());
    lineClass.get(l.from).add(cls);
  };
  const eachLine = (from, to, cls) => {
    let l = doc.lineAt(from);
    for (;;) {
      addLine(l.from, cls);
      if (l.to >= to || l.number >= doc.lines) break;
      l = doc.line(l.number + 1);
    }
  };
  const tree = syntaxTree(state);
  for (const { from, to } of view.visibleRanges) {
    // Hanging punctuation for lines that open with a quotation mark.
    for (let pos = from; pos <= to;) {
      const l = doc.lineAt(pos);
      if (OPEN_QUOTE.test(l.text)) addLine(l.from, 'cm-hang');
      pos = l.to + 1;
    }
    tree.iterate({
      from,
      to,
      enter(node) {
        const n = node.name;
        if (/^ATXHeading[1-6]$/.test(n)) {
          addLine(node.from, `cm-h cm-h${n.slice(-1)}`);
        } else if (n === 'HeaderMark') {
          const parent = node.node.parent;
          if (parent && /^ATX/.test(parent.name) && !isActive(node.from)) {
            const end = Math.min(node.to + 1, doc.lineAt(node.from).to);
            if (node.from === doc.lineAt(node.from).from) decos.push(hide.range(node.from, end));
            else decos.push(hide.range(node.from, node.to));
          }
        } else if (n === 'Blockquote') {
          eachLine(node.from, node.to, 'cm-quote');
        } else if (n === 'QuoteMark') {
          if (!isActive(node.from)) {
            const lineEnd = doc.lineAt(node.from).to;
            const next = state.sliceDoc(node.to, node.to + 1);
            decos.push(hide.range(node.from, next === ' ' && node.to < lineEnd ? node.to + 1 : node.to));
          }
        } else if (n === 'EmphasisMark' || n === 'StrikethroughMark') {
          if (!isActive(node.from)) decos.push(hide.range(node.from, node.to));
        } else if (n === 'CodeMark') {
          const parent = node.node.parent;
          if (parent && parent.name === 'InlineCode' && !isActive(node.from)) decos.push(hide.range(node.from, node.to));
        } else if (n === 'FencedCode') {
          eachLine(node.from, node.to, 'cm-codeblock');
        } else if (n === 'Link') {
          // Square brackets without an address are just text: no link look, brackets stay.
          if (!node.node.getChild('URL')) return;
          const lm = node.node.getChildren('LinkMark');
          if (lm.length >= 2 && lm[1].from > lm[0].to) decos.push(linkText.range(lm[0].to, lm[1].from));
          if (!isActive(node.from)) {
            const cur = node.node.cursor();
            if (cur.firstChild()) {
              do {
                if (cur.name === 'LinkMark' || cur.name === 'URL' || cur.name === 'LinkTitle') {
                  // hide "[" and "](url "title")"
                  decos.push(hide.range(cur.from, cur.to));
                }
              } while (cur.nextSibling());
            }
          }
        } else if (n === 'ListMark') {
          addLine(node.from, 'cm-li');
          const t = state.sliceDoc(node.from, node.to);
          if ((t === '-' || t === '*' || t === '+') && !isActive(node.from)) decos.push(bullet.range(node.from, node.to));
        } else if (n === 'HorizontalRule') {
          addLine(node.from, 'cm-hr');
          if (!isActive(node.from)) decos.push(rule.range(node.from, node.to));
        }
      },
    });
  }
  for (const [pos, set] of lineClass) decos.push(line([...set].join(' ')).range(pos));
  return Decoration.set(decos, true);
}

const livePreview = ViewPlugin.fromClass(class {
  constructor(view) {
    this.key = '';
    this.decorations = buildDecorations(view);
  }
  update(u) {
    const key = [...activeLines(u.view)].join(',');
    if (u.docChanged || u.viewportChanged || key !== this.key || u.focusChanged
      || syntaxTree(u.startState) !== syntaxTree(u.state)) {
      this.key = key;
      this.decorations = buildDecorations(u.view);
    }
  }
}, { decorations: (v) => v.decorations });

const mdHighlight = HighlightStyle.define([
  { tag: tags.heading, class: 'cm-tok-heading' },
  { tag: tags.emphasis, class: 'cm-tok-em' },
  { tag: tags.strong, class: 'cm-tok-strong' },
  { tag: tags.strikethrough, class: 'cm-tok-strike' },
  { tag: tags.url, class: 'cm-tok-url' },
  { tag: tags.monospace, class: 'cm-tok-code' },
  { tag: tags.quote, class: 'cm-tok-quote' },
  { tag: tags.processingInstruction, class: 'cm-tok-mark' },
  { tag: tags.contentSeparator, class: 'cm-tok-mark' },
]);

// ---- smart punctuation ----------------------------------------------------
let smartOn = true;
try {
  smartOn = localStorage.getItem('wh-smart') !== 'off';
} catch { /* default on */ }
export function setSmartPunctuation(on) {
  smartOn = on;
  try {
    localStorage.setItem('wh-smart', on ? 'on' : 'off');
  } catch { /* ignore */ }
}
export const smartPunctuation = () => smartOn;

// Straight quote -> curly, decided by the character before it.
function curlyQuote(q, prev) {
  const opening = !prev || /[\s([{—–/“‘-]/.test(prev);
  return q === '"' ? (opening ? '“' : '”') : (opening ? '‘' : '’');
}
function inCode(state, pos) {
  let n = syntaxTree(state).resolveInner(pos, -1);
  for (; n; n = n.parent) if (/^(InlineCode|FencedCode|CodeBlock|CodeText|URL|Autolink)$/.test(n.name)) return true;
  return false;
}
const typography = EditorView.inputHandler.of((view, from, to, text) => {
  if (!smartOn || view.composing || view.compositionStarted || text.length !== 1) return false;
  const { state } = view;
  if (state.selection.ranges.length > 1) return false;
  const before = state.sliceDoc(Math.max(0, from - 2), from);
  const prev = before.slice(-1);
  const lineStart = state.doc.lineAt(from).from;
  let insert = null;
  let replaceFrom = from;
  if (text === '"' || text === "'") {
    if (inCode(state, from)) return false;
    insert = curlyQuote(text, prev);
  } else if (text === '-' && prev === '-') {
    const lineBefore = state.sliceDoc(lineStart, from);
    if (/^\s*-*$/.test(lineBefore) || inCode(state, from)) return false; // list markers, rules
    // Between figures (10--12) it's an en dash; otherwise an em dash.
    insert = from >= 2 && /\d/.test(state.sliceDoc(from - 2, from - 1)) ? '–' : '—';
    replaceFrom = from - 1;
  } else if (text === '.' && before === '..') {
    if (inCode(state, from)) return false;
    insert = '…';
    replaceFrom = from - 2;
  }
  if (insert === null) return false;
  view.dispatch({
    changes: { from: replaceFrom, to, insert },
    selection: { anchor: replaceFrom + insert.length },
    userEvent: 'input.type',
    scrollIntoView: true,
  });
  return true;
});

// Phone keyboards (Gboard) type words through composition, which the handler above
// leaves alone; once a composition ends, its straight quotes are curled ("don't").
function composedQuotes() {
  let range = null; // { from, to } of the latest composed text, mapped through later changes
  let timer = null;
  const convert = (view) => {
    timer = null;
    if (!range || !smartOn || view.state.readOnly) {
      range = null;
      return;
    }
    if (view.composing) {
      timer = setTimeout(() => convert(view), 120);
      return;
    }
    const { state } = view;
    const from = Math.max(0, Math.min(range.from, state.doc.length));
    const to = Math.min(state.doc.length, Math.max(range.to, from));
    range = null;
    const text = state.sliceDoc(from, to);
    const changes = [];
    for (let i = 0; i < text.length; i++) {
      const q = text[i];
      if (q !== '"' && q !== "'") continue;
      const pos = from + i;
      if (inCode(state, pos)) continue;
      const prev = pos > 0 ? state.sliceDoc(pos - 1, pos) : '';
      changes.push({ from: pos, to: pos + 1, insert: curlyQuote(q, prev) });
    }
    if (changes.length) view.dispatch({ changes, userEvent: 'input.type' });
  };
  return EditorView.updateListener.of((u) => {
    if (!u.docChanged) return;
    for (const tr of u.transactions) {
      if (range) range = { from: tr.changes.mapPos(range.from, -1), to: tr.changes.mapPos(range.to, 1) };
      if (tr.isUserEvent('input.type.compose')) {
        tr.changes.iterChangedRanges((_fa, _ta, fb, tb) => {
          range = range ? { from: Math.min(range.from, fb), to: Math.max(range.to, tb) } : { from: fb, to: tb };
        });
      }
    }
    if (range && !u.view.composing && !timer) timer = setTimeout(() => convert(u.view), 0);
  });
}

// Enter on a quote or list line that holds only its marker ends the quote/list
// with a clean paragraph break, instead of continuing it forever.
const EMPTY_MARKUP = /^\s*(?:>\s?)+\s*$|^\s*(?:>\s?)*(?:[-*+]|\d+[.)])(?:\s+\[[ xX]\])?\s*$/;
function exitEmptyMarkup(view) {
  const { state } = view;
  if (state.readOnly || state.selection.ranges.length !== 1 || !state.selection.main.empty) return false;
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  if (pos !== line.to || !line.text.trim() || !EMPTY_MARKUP.test(line.text)) return false;
  view.dispatch({ changes: { from: line.from, to: line.to, insert: '\n' }, selection: { anchor: line.from + 1 }, userEvent: 'input', scrollIntoView: true });
  return true;
}

const BLOCK_START = /^(#{1,6}\s|>|[-*+]\s|\d+[.)]\s|```|~~~)/;
const ANDROID = typeof navigator !== 'undefined' && /Android\b/.test(navigator.userAgent || '');

// Where a change came from, as the scorer wants to know it: typing,
// an input method's composition, autocorrect, dictation, or a paste (incl. drop).
// - several words in one transaction (not a paste): dictation (iOS dictation,
//   Gboard voice typing, an IME committing a phrase);
// - a composition of one word: ime;
// - a word replaced next to the caret without a selection: autocorrect or a
//   predictive suggestion (also desktop spell-check replacements);
// - everything else, undo and redo included: type.
function sourceOf(tr) {
  if (tr.annotation(PasteMeta)) return 'paste';
  if (tr.isUserEvent('input.paste') || tr.isUserEvent('input.drop') || tr.isUserEvent('move.drop')) return 'paste';
  if (tr.isUserEvent('undo') || tr.isUserEvent('redo') || !tr.isUserEvent('input')) return 'type';
  if (tr.isUserEvent('input.complete')) return 'autocorrect';
  let ins = '';
  let del = 0;
  tr.changes.iterChanges((fromA, toA, _fb, _tb, inserted) => {
    ins += `${inserted.toString()} `;
    del += toA - fromA;
  });
  const words = countWords(ins);
  if (words >= 2) return 'dictation';
  if (tr.isUserEvent('input.type.compose')) return 'ime';
  if (del > 0 && words === 1 && tr.startState.selection.main.empty && tr.isUserEvent('input.type')) {
    let deleted = '';
    tr.changes.iterChanges((fromA, toA) => { deleted += tr.startState.sliceDoc(fromA, toA); });
    if (/[\p{L}\p{N}]/u.test(deleted) && ins.trim().length >= 2) return 'autocorrect';
  }
  return 'type';
}

// Invisible and control characters never enter the text (the server would remove
// them anyway). Pastes are cleaned before they get here.
const cleanInput = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.annotation(Remote) || tr.annotation(PasteMeta) || tr.isUserEvent('input.type.compose')) return tr;
  let dirty = false;
  tr.changes.iterChanges((_fa, _ta, _fb, _tb, ins) => {
    if (!dirty && hasInvisible(ins.toString())) dirty = true;
  });
  if (!dirty) return tr;
  const changes = [];
  tr.changes.iterChanges((fromA, toA, _fb, _tb, ins) => changes.push({ from: fromA, to: toA, insert: stripInvisible(ins.toString()) }));
  const cs = tr.startState.changes(changes);
  return {
    changes: cs,
    selection: tr.startState.selection.map(cs, 1),
    scrollIntoView: tr.scrollIntoView,
    annotations: tr.annotation(Transaction.userEvent) ? Transaction.userEvent.of(tr.annotation(Transaction.userEvent)) : undefined,
  };
});

// ---- word counts for immediate feedback
// How many words a transaction added (or removed), counted only on the lines it
// touched (never the whole document): `all` like any word counter, and `counted`, the
// same now that quote lines count like any other text (SPEC §30).
function lineWords(doc, from, to) {
  let all = 0;
  let counted = 0;
  const a = doc.lineAt(from).number;
  const b = doc.lineAt(Math.min(to, doc.length)).number;
  for (let i = a; i <= b; i++) {
    const t = doc.line(i).text;
    const n = countWords(t);
    all += n;
    counted += n;
  }
  return { all, counted };
}
// [from, to) widened to whole words (the runs of non-space touching either end), at most
// WORD_SCAN_MAX characters each way as the server counts (text.js wordSpan), read in small
// chunks: typing in a long paragraph never slices the whole line.
const SPACE = /\s/;
function wordWindow(doc, from, to) {
  let a = from;
  const aMin = Math.max(0, from - WORD_SCAN_MAX);
  for (;;) {
    const lo = Math.max(aMin, a - 48);
    const chunk = doc.sliceString(lo, a);
    let i = chunk.length;
    while (i > 0 && !SPACE.test(chunk[i - 1])) i--;
    a = lo + i;
    if (i > 0 || lo === aMin) break;
  }
  let b = to;
  const bMax = Math.min(doc.length, to + WORD_SCAN_MAX);
  for (;;) {
    const hi = Math.min(bMax, b + 48);
    const chunk = doc.sliceString(b, hi);
    let i = 0;
    while (i < chunk.length && !SPACE.test(chunk[i])) i++;
    b += i;
    if (i < chunk.length || hi === bMax) break;
  }
  return [a, b];
}
export function wordDelta(tr) {
  let all = 0;
  let counted = 0;
  const A = tr.startState.doc;
  const B = tr.state.doc;
  tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    const la = A.lineAt(fromA);
    const lb = B.lineAt(fromB);
    // A change near the start of a line (it may make or unmake a quote) or across lines:
    // count those whole lines. Otherwise only the words around the change.
    if (fromA - la.from < 4 || toA > la.to || fromB - lb.from < 4 || toB > lb.to) {
      const before = lineWords(A, fromA, toA);
      const after = lineWords(B, fromB, toB);
      all += after.all - before.all;
      counted += after.counted - before.counted;
      return;
    }
    const [a0, a1] = wordWindow(A, fromA, toA);
    const [b0, b1] = wordWindow(B, fromB, toB);
    const d = countWords(B.sliceString(b0, b1)) - countWords(A.sliceString(a0, a1));
    all += d;
    counted += d;
  });
  return { all, counted };
}
// Counted words in a whole document (once, when an editor opens or takes remote text).
export function countedWords(text) {
  let n = 0;
  for (const line of String(text).split('\n')) n += countWords(line);
  return n;
}

// ---- hook for other front-end modules
// addEditorExtension(ext): adds CodeMirror extensions to every editor, the ones
// already open included (they're reconfigured in place). onEditorCreated(fn):
// fn(editor) for every editor, open or future; editor = { view, kind, parent, ... }
// as returned by createEditor. Returns an unsubscribe function.
const extraExtensions = [];
const extraC = new Compartment();
const liveEditors = new Set();
const createdHooks = [];
export function addEditorExtension(ext) {
  extraExtensions.push(ext);
  const next = extraExtensions.slice();
  for (const e of liveEditors) e.view.dispatch({ effects: extraC.reconfigure(next) });
}
export function onEditorCreated(fn) {
  createdHooks.push(fn);
  for (const e of liveEditors) fn(e);
  return () => {
    const i = createdHooks.indexOf(fn);
    if (i >= 0) createdHooks.splice(i, 1);
  };
}
export const openEditors = () => [...liveEditors];

// ---- the editor -----------------------------------------------------------
// opts: { parent, text, kind: 'body'|'notes', placeholder, readOnly,
//         onOps(ops), onPaste({ text, html, from, to }) -> Promise<{ text, meta }|null>,
//         onFiles(files, pos), onCopy(markdown, clipboardData),
//         guardCut() -> null | (words) => Promise<boolean> }
// guardCut (SPEC §30): after the party, a change that takes BIG_CUT_WORDS or more words out at
// once (one op of it, counted as the server counts it) is held back, not applied, while the
// function it returns asks for a reason; true applies the same change, false leaves the text as
// it was. guardCut returns null when nothing needs asking (during the party; a reason given).
export function createEditor(opts) {
  const readOnlyC = new Compartment();
  let internalDrag = false;
  let dictating = false;
  let destroyed = false;
  // Ranges waiting for a paste or a dropped file: mapped through every change meanwhile.
  // If the text inside a selected range was edited, only an insertion at its end remains.
  const tracked = new Set();
  const trackRange = (from, to) => {
    const r = { from, to };
    tracked.add(r);
    return r;
  };
  const untrack = (r) => tracked.delete(r);
  const roExt = (ro) => [EditorState.readOnly.of(!!ro), EditorView.editable.of(!ro)];
  // Planned edits made lately (OpPlan), for their undo and redo: { before, after, ops, back }.
  const plans = [];
  // The ops a transaction goes out as when it's a planned edit, or the undo or redo of one (the
  // same texts before and after; anything else in between, such as another tab's words, and it
  // goes out as usual); else null.
  const plannedOps = (tr) => {
    const ops = tr.annotation(OpPlan);
    if (ops) {
      let r;
      try {
        r = replayOps(tr.startState.doc.toString(), ops);
      } catch {
        return null;
      }
      if (r.text.length !== tr.newDoc.length || r.text !== tr.newDoc.toString()) return null; // not this edit
      plans.unshift({ before: tr.startState.doc, after: tr.newDoc, ops, back: r.back });
      if (plans.length > 8) plans.pop();
      return ops;
    }
    return replannedOps(tr);
  };
  // The undo or redo of a planned edit: its ops (nothing is recorded).
  const replannedOps = (tr) => {
    if (!plans.length || !(tr.isUserEvent('undo') || tr.isUserEvent('redo'))) return null;
    const same = (a, b) => a === b || (a.length === b.length && a.eq(b));
    for (const p of plans) {
      if (same(tr.startState.doc, p.after) && same(tr.newDoc, p.before)) return p.back;
      if (same(tr.startState.doc, p.before) && same(tr.newDoc, p.after)) return p.ops;
    }
    return null;
  };
  // The ops a transaction goes out as, read off its changes: one per changed range, last first.
  const changeOps = (tr) => {
    const changes = [];
    tr.changes.iterChanges((fromA, toA, _fb, _tb, inserted) => {
      changes.push({ pos: fromA, del: toA - fromA, ins: inserted.toString() });
    });
    return changes.reverse();
  };

  // ---- large deletions after the party (SPEC §30): held until the writer gives a reason
  // The words the transaction's biggest cut takes out, as the server will count its ops.
  const cutWords = (tr) => {
    // Cheap first: deleted text with too few words can't make one (a cut can join two words).
    let gone = '';
    tr.changes.iterChanges((fromA, toA) => {
      if (toA > fromA) gone += `${tr.startState.sliceDoc(fromA, toA)}\n`;
    });
    if (countWords(gone) + 2 < BIG_CUT_WORDS) return 0;
    let ops = tr.annotation(OpPlan) || replannedOps(tr);
    if (ops) {
      try {
        if (replayOps(tr.startState.doc.toString(), ops).text !== tr.newDoc.toString()) ops = null; // goes out as its changes
      } catch {
        ops = null;
      }
    }
    return Math.max(0, ...cutsIn(tr.startState.doc.toString(), ops || changeOps(tr)));
  };
  // Every transaction comes through dispatchTransactions (below), undo and redo included (their
  // transactions skip filters). One that takes BIG_CUT_WORDS or more out is held, not applied (a
  // change read from the page is put back on screen), while opts.guardCut's question is open;
  // then it goes in as it was (an undo or redo by running it again), mapped through whatever
  // changed in the text meanwhile (another tab's words). One at a time: another meanwhile is
  // dropped (the question is a modal dialog, so only a script could make one).
  let held = null; // { tr, since: the changes made to the text since }
  let letThrough = false;
  const holdCut = (tr, words, ask) => {
    const h = { tr, since: null };
    held = h;
    Promise.resolve()
      .then(() => ask(words))
      .then((ok) => {
        if (held === h) held = null;
        if (destroyed) return;
        if (ok && !view.state.readOnly) {
          const ev = tr.annotation(Transaction.userEvent);
          const annotations = [];
          if (ev) annotations.push(Transaction.userEvent.of(ev));
          for (const a of [PasteMeta, OpPlan]) if (tr.annotation(a) !== undefined) annotations.push(a.of(tr.annotation(a)));
          letThrough = true;
          try {
            if (ev === 'undo' || ev === 'redo') (ev === 'undo' ? undo : redo)(view);
            else view.dispatch({ changes: h.since ? tr.changes.map(h.since) : tr.changes, selection: h.since ? undefined : tr.selection, scrollIntoView: tr.scrollIntoView, annotations });
          } finally {
            letThrough = false;
          }
        }
        view.focus();
      }, () => {
        if (held === h) held = null;
      });
  };
  function dispatchTransactions(trs, v) {
    const ask = opts.guardCut && !letThrough && trs.some((tr) => tr.docChanged && !tr.annotation(Remote)) ? opts.guardCut() : null;
    if (ask) {
      for (let i = 0; i < trs.length; i++) {
        const tr = trs[i];
        if (!tr.docChanged || tr.annotation(Remote)) continue;
        const words = cutWords(tr);
        if (words < BIG_CUT_WORDS) continue;
        if (i) applyTrs(v, trs.slice(0, i));
        if (!held) holdCut(tr, words, ask);
        return;
      }
    }
    applyTrs(v, trs);
  }
  function applyTrs(v, trs) {
    v.update(trs);
    if (held) for (const tr of trs) if (tr.docChanged) held.since = held.since ? held.since.compose(tr.changes) : tr.changes;
  }

  const extensions = [
    history(),
    drawSelection(),
    search({ top: true }),
    new LanguageSupport(mdLanguage), // GFM without setext headings; its keymap is added below, after ours
    syntaxHighlighting(mdHighlight),
    livePreview,
    typography,
    composedQuotes(),
    cleanInput,
    // A big block arriving as typing (Android's keyboard clipboard chip commits
    // text instead of firing a paste event) goes through the paste question too.
    // Only on Android: elsewhere (iOS, desktop) such inserts are dictation.
    EditorView.inputHandler.of((view, from, to, text) => {
      if (!ANDROID || view.composing || view.compositionStarted || view.state.readOnly || !opts.onPaste) return false;
      const limit = typeof opts.askOver === 'function' ? opts.askOver() : 12;
      if (text.length <= 24 || countWords(text) <= (limit ?? 12)) return false;
      runPaste(view, { text, html: '', from, to, keyboard: true });
      return true;
    }),
    EditorView.lineWrapping,
    keymap.of([{ key: 'Enter', run: exitEmptyMarkup }, ...markdownKeymap, ...defaultKeymap,
      // Redo: Ctrl+Shift+Z everywhere (CodeMirror binds it only on Mac and Linux), and Ctrl+Y.
      { key: 'Mod-Shift-z', run: redo, preventDefault: true },
      ...historyKeymap, ...searchKeymap, indentWithTab]),
    cmPlaceholder(opts.placeholder || ''),
    readOnlyC.of(roExt(opts.readOnly)),
    extraC.of(extraExtensions.slice()),
    EditorView.contentAttributes.of({
      spellcheck: 'true', autocorrect: 'on', autocapitalize: 'sentences', 'aria-label': opts.kind === 'notes' ? 'Planning notes' : 'Post text',
    }),
    EditorView.domEventHandlers({
      paste(e, view) {
        const cd = e.clipboardData;
        if (!cd) return false;
        const html = cd.getData('text/html');
        const plain = cd.getData('text/plain');
        if (!html && !plain) return false;
        e.preventDefault();
        const sel = view.state.selection.main;
        runPaste(view, { text: plain, html, from: sel.from, to: sel.to });
        return true;
      },
      dragstart() {
        internalDrag = true;
        return false;
      },
      dragend() {
        internalDrag = false;
        return false;
      },
      drop(e, view) {
        if (internalDrag) {
          internalDrag = false;
          return false; // moving text inside the editor
        }
        const dt = e.dataTransfer;
        if (!dt) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
        if (dt.files && dt.files.length) {
          const docs = [...dt.files].filter((f) => !/^image\//.test(f.type));
          if (!docs.length) return false; // images: for an extension that handles them
          e.preventDefault();
          const target = trackRange(pos, pos);
          Promise.resolve(opts.onFiles?.(docs, target)).finally(() => untrack(target));
          return true;
        }
        const html = dt.getData('text/html');
        const plain = dt.getData('text/plain');
        if (!html && !plain) return false;
        e.preventDefault();
        runPaste(view, { text: plain, html, from: pos, to: pos });
        return true;
      },
      copy(e, view) {
        return copyOut(e, view, false);
      },
      cut(e, view) {
        return copyOut(e, view, true);
      },
    }),
    EditorView.updateListener.of((u) => {
      if (!u.docChanged) return;
      if (tracked.size) {
        for (const tr of u.transactions) {
          if (!tr.docChanged) continue;
          for (const r of tracked) {
            const touched = r.to > r.from && tr.changes.touchesRange(r.from, r.to) !== false;
            r.from = tr.changes.mapPos(r.from, 1);
            r.to = Math.max(r.from, tr.changes.mapPos(r.to, -1));
            if (touched) Object.assign(r, { from: r.to, edited: true }); // edited: the paste handler asks first
          }
        }
      }
      for (const tr of u.transactions) {
        if (!tr.docChanged || tr.annotation(Remote)) continue;
        const planned = plannedOps(tr);
        if (planned) {
          dictating = false;
          const at = Date.now();
          opts.onOps?.(planned.map((o) => ({ at, ...o })), wordDelta(tr));
          continue;
        }
        const meta = tr.annotation(PasteMeta) || null;
        let source = sourceOf(tr);
        // Voice typing composes a phrase; once it has, the whole composition is dictation.
        if (tr.isUserEvent('input.type.compose.start')) dictating = false; // a new composition
        if (tr.isUserEvent('input.type.compose')) {
          if (source === 'dictation') dictating = true;
          else if (dictating && source === 'ime') source = 'dictation';
        } else if (source !== 'dictation') dictating = false;
        const changes = [];
        tr.changes.iterChanges((fromA, toA, _fb, _tb, inserted) => {
          changes.push({ pos: fromA, del: toA - fromA, ins: inserted.toString() });
        });
        const at = Date.now();
        const ops = [];
        for (let i = changes.length - 1; i >= 0; i--) {
          const op = { at, ...changes[i] };
          if (source === 'paste') {
            // Pasted text counts only through the attribution dialog: anything that
            // arrives another way (a dragged move, a paste we didn't see) claims nothing.
            if (op.ins) op.paste = meta && changes.length === 1 ? meta : { m: '', d: tr.isUserEvent('move.drop') ? 'move' : 'no' };
          } else if (source !== 'type') op.source = source;
          ops.push(op);
        }
        if (ops.length) opts.onOps?.(ops, wordDelta(tr));
      }
    }),
  ];

  const view = new EditorView({
    parent: opts.parent,
    state: EditorState.create({ doc: opts.text || '', extensions }),
    dispatchTransactions,
  });

  function copyOut(e, v, isCut) {
    const ranges = v.state.selection.ranges.filter((r) => !r.empty);
    if (!ranges.length || !e.clipboardData || !opts.onCopy) return false;
    const md = ranges.map((r) => v.state.sliceDoc(r.from, r.to)).join('\n');
    e.preventDefault();
    opts.onCopy(md, e.clipboardData);
    if (isCut && !v.state.readOnly) {
      v.dispatch(v.state.replaceSelection(''), { userEvent: 'delete.cut', scrollIntoView: true });
    }
    return true;
  }

  async function runPaste(v, req) {
    if (v.state.readOnly || !opts.onPaste) return;
    // The paste waits for a conversion, a check and maybe a question: meanwhile the
    // writer may type, or another tab's words may arrive. Its target moves with them.
    const target = trackRange(req.from, req.to);
    let res;
    try {
      res = await opts.onPaste({ ...req, target }); // the live target: onPaste can see target.edited
    } finally {
      untrack(target);
    }
    if (!res || !res.text || destroyed || v.state.readOnly) {
      if (!destroyed) v.focus();
      return;
    }
    const len = v.state.doc.length;
    const from = Math.min(target.from, len);
    const to = Math.min(Math.max(target.to, from), len);
    // Block content (a heading, list, quote or several paragraphs) pasted mid-line
    // starts on a paragraph of its own. Whitespace doesn't shift the word mask.
    let insert = res.text;
    if (from > 0 && v.state.sliceDoc(from - 1, from) !== '\n' && (BLOCK_START.test(insert) || insert.includes('\n\n'))) insert = `\n\n${insert}`;
    v.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
      annotations: PasteMeta.of(res.meta),
      userEvent: 'input.paste',
      scrollIntoView: true,
    });
    v.focus();
  }

  const ed = {
    view,
    kind: opts.kind,
    parent: opts.parent,
    get text() {
      return view.state.doc.toString();
    },
    setReadOnly(ro) {
      view.dispatch({ effects: readOnlyC.reconfigure(roExt(ro)) });
    },
    // Replace the content without producing ops (server state adopted).
    setRemoteText(text) {
      const cur = view.state.doc.toString();
      if (cur === text) return;
      let p = 0;
      const max = Math.min(cur.length, text.length);
      while (p < max && cur.charCodeAt(p) === text.charCodeAt(p)) p++;
      let s = 0;
      while (s < cur.length - p && s < text.length - p && cur.charCodeAt(cur.length - 1 - s) === text.charCodeAt(text.length - 1 - s)) s++;
      view.dispatch({ changes: { from: p, to: cur.length - s, insert: text.slice(p, text.length - s) }, annotations: [Remote.of(true), Transaction.addToHistory.of(false)] });
    },
    // Apply another tab's or device's changes (a ChangeSet over the current text)
    // without producing ops; the caret and the words around it stay put. The
    // result must equal `text`; anything else is corrected with a plain replace.
    applyRemote(changes, text) {
      if (changes && changes.length === view.state.doc.length) {
        try {
          // Not in the undo history: Undo must never remove another tab's words.
          view.dispatch({ changes, annotations: [Remote.of(true), Transaction.addToHistory.of(false)] });
        } catch { /* fall back below */ }
      }
      if (view.state.doc.length !== text.length || view.state.doc.toString() !== text) this.setRemoteText(text);
    },
    // Insert attributed text at the cursor (files opened from the menu), or at a position:
    // a number, or a { from, to } range the editor has kept up to date (a dropped file).
    insertAttributed(text, meta, pos = null) {
      if (destroyed || view.state.readOnly) return;
      const sel = view.state.selection.main;
      const len = view.state.doc.length;
      const at = typeof pos === 'number' ? { from: pos, to: pos } : pos;
      const from = Math.min(at ? at.from : sel.from, len);
      const to = Math.min(Math.max(at ? at.to : sel.to, from), len);
      // A file's content goes in as paragraphs of its own.
      const before = from > 0 ? view.state.sliceDoc(from - 1, from) : '\n';
      const after = view.state.sliceDoc(to, to + 1);
      const insert = `${before === '\n' ? '' : '\n\n'}${text}${after && after !== '\n' ? '\n\n' : ''}`;
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
        annotations: PasteMeta.of(meta),
        userEvent: 'input.paste',
        scrollIntoView: true,
      });
    },
    // The paste question for text pasted outside the editor that goes into it (an image's
    // description, richtext.js): the same checks as a paste here. -> Promise<{ text, meta } | null>
    askPaste(req) {
      return Promise.resolve(opts.onPaste ? opts.onPaste({ html: '', ...req }) : null);
    },
    focus() {
      view.focus();
    },
    // Scroll the caret into view (after the on-screen keyboard opens).
    revealCaret() {
      view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'nearest', yMargin: 32 }) });
    },
    destroy() {
      destroyed = true;
      tracked.clear();
      liveEditors.delete(ed);
      view.destroy();
    },
  };
  liveEditors.add(ed);
  for (const fn of createdHooks.slice()) {
    try {
      fn(ed);
    } catch (e) {
      console.error(e);
    }
  }
  return ed;
}
