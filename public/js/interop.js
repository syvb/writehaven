/*
 * Writehaven interop: paste-in, copy-out, export and import. Everything runs client-side.
 *
 *   htmlToMarkdown(html)              clipboard HTML (Google Docs, Word, Notion, Apple Notes,
 *                                     LessWrong / EA Forum, web pages) -> clean Markdown
 *   OWN_HTML_MARKER, isOwnHtml(html)  our own copied HTML carries the marker
 *   normalizePlain(text)              plain-text paste clean-up (never alters words)
 *   markdownToHtml(md)                Markdown -> sanitised HTML
 *   markdownToPlain(md)               Markdown -> readable plain text
 *   fillClipboard(dataTransfer, md)   copy event: rich HTML + Markdown
 *   copyRich(md, title?, target?)     one-click rich copy for LessWrong / Substack / Google Docs
 *   richCopyData(md, title?, target?) the same { html, plain } without writing the clipboard
 *   exportPost(post, format)          md | txt | html | docx | pdf
 *   exportAll(posts, format, title)   md | txt | html | docx | pdf | epub
 *                                     (uploaded images: embedded in docx/epub, by full address in
 *                                     html/md/txt and copies, printed in the PDF)
 *   importFile(file)                  .md .markdown .txt .docx .html .htm -> { title, markdown }
 *
 * Markdown dialect (shared with the editor): CommonMark + GFM tables, ~~strike~~ (two tildes only),
 * single newlines are line breaks, raw HTML is shown as text, and lines starting with ">!" are a
 * spoiler block (LessWrong's syntax).
 */

import { Marked, zipSync, strToU8 } from '../vendor/interop.js';
import { footnotes } from './footnotes.js';

export const OWN_HTML_MARKER = 'data-writehaven-copy';

const ACCENT = '#2B4C7E';
const INK = '#1A1C1E';
const SERIF = '"Newsreader", "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif';
const SANS = '"Instrument Sans", "Helvetica Neue", Helvetica, Arial, sans-serif';
const MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAMMOTH_SRC = '/vendor/mammoth.js';
const PRINT_CSS_HREF = '/css/print.css';

const ZERO_WIDTH_RE = /[\u{200B}\u{2060}\u{FEFF}\xAD]/gu;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const ASCII_PUNCT_RE = /[!-/:-@[-`{-~]/;
const UNI_PUNCT_RE = /[\p{P}\p{S}]/u;
const WS_RE = /\s/;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function str(v) {
  return v == null ? '' : String(v);
}

// Remove characters that are not allowed in XML 1.0 (control chars, lone surrogates).
function xmlSafe(s) {
  return str(s)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\u{FFFE}\u{FFFF}]/gu, '')
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (m) => (m.length === 2 ? m : ''));
}

function escText(s) {
  return xmlSafe(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(s) {
  return escText(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function cleanTitle(t) {
  return str(t).replace(/\s+/g, ' ').trim();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let inertDocument = null;
// A document without a browsing context: parsing HTML into it never runs scripts or loads images.
function inertDoc() {
  if (!inertDocument) inertDocument = document.implementation.createHTMLDocument('');
  return inertDocument;
}

// Uploaded images (SPEC §14): ![alt](/u/<name>.<ext>), served by this site, optionally with their
// size in the fragment (#w=1200&h=800), as the public pages read it. Pages and documents show
// them; any other image address stays a link.
const UPLOAD_RE = /^\/u\/[A-Za-z0-9_-]{6,80}\.(?:webp|png|jpe?g|gif)(?:#[^\s]*)?$/i;
// The address copies and exports give an upload: Cloudflare's hotlink protection refuses images
// that other sites' editors (LessWrong, WordPress) load from /u/, and exempts any path with a
// hotlink-ok directory. The server answers both addresses.
const HOTLINK_OK = '/u/hotlink-ok/';

function siteOrigin() {
  try {
    return typeof location !== 'undefined' && /^https?:$/.test(location.protocol) ? location.origin : '';
  } catch (err) {
    return '';
  }
}

// "/u/x.webp#w=1200&h=800" or "<this site>/u/x.webp" -> { path, w, h } (w, h 0 if unknown), else null.
function uploadRef(src) {
  let s = str(src).trim();
  const origin = siteOrigin();
  if (origin && s.slice(0, origin.length + 3) === origin + '/u/') s = s.slice(origin.length);
  if (s.slice(0, HOTLINK_OK.length) === HOTLINK_OK) s = '/u/' + s.slice(HOTLINK_OK.length);
  if (!UPLOAD_RE.test(s)) return null;
  const hash = s.indexOf('#');
  let w = 0;
  let h = 0;
  if (hash >= 0) {
    const q = new URLSearchParams(s.slice(hash + 1));
    w = Math.round(Number(q.get('w')));
    h = Math.round(Number(q.get('h')));
    if (!(w > 0 && h > 0 && w < 20000 && h < 20000)) w = h = 0;
  }
  return { path: hash < 0 ? s : s.slice(0, hash), w, h };
}

// Where an uploaded image lives for readers outside this page (copies, exported files).
function absoluteUrl(path) {
  const p = str(path);
  return siteOrigin() + (/^\/u\/[^/]+$/.test(p) ? HOTLINK_OK + p.slice(3) : p);
}

// ---------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------

export function normalizePlain(text) {
  if (text == null) return '';
  return String(text)
    .replace(/\r\n?|[\u{2028}\u{2029}]/gu, '\n')
    .replace(/\xA0/g, ' ')
    .replace(ZERO_WIDTH_RE, '')
    .replace(CONTROL_RE, '')
    .replace(/[^\S\n]+$/gm, '');
}

export function isOwnHtml(html) {
  if (typeof html !== 'string' || html.indexOf(OWN_HTML_MARKER) === -1) return false;
  return /\sdata-writehaven-copy(?:\s*=|[\s/>])/i.test(html);
}

// ---------------------------------------------------------------------------
// Markdown -> HTML (marked + allowlist sanitiser)
// ---------------------------------------------------------------------------

// Spoiler blocks, as on LessWrong and the EA Forum: consecutive lines starting with ">!" (a bare
// ">!" line separates paragraphs inside the spoiler). Rendered as <div data-wh-spoiler>, which the
// sanitiser turns into <div class="spoilers"> (LessWrong's own markup); raw HTML never reaches the
// output as tags, so only this extension can produce it.
const SPOILER_EXT = {
  name: 'spoiler',
  level: 'block',
  // Where a paragraph must stop for a spoiler. marked passes the paragraph source minus its first
  // character, so only a ">!" after a newline is a line start here ("\>!" stays text).
  start(src) {
    const m = /\n {0,3}>!/.exec(src);
    return m ? m.index + 1 : undefined;
  },
  tokenizer(src) {
    const m = /^(?: {0,3}>![^\n]*(?:\n|$))+/.exec(src);
    if (!m) return undefined;
    const inner = m[0]
      .replace(/\n$/, '')
      .split('\n')
      .map((l) => l.replace(/^ {0,3}>! ?/, ''))
      .join('\n');
    // Like a blockquote: the content is lexed as top-level blocks (paragraphs even inside list items).
    const top = this.lexer.state.top;
    this.lexer.state.top = true;
    const tokens = this.lexer.blockTokens(inner, []);
    this.lexer.state.top = top;
    return { type: 'spoiler', raw: m[0], tokens };
  },
  renderer(token) {
    return '<div data-wh-spoiler="">' + this.parser.parse(token.tokens) + '</div>\n';
  },
};

// Footnotes (SPEC §31, footnotes.js): while renderSafe renders a text with notes, a reference
// becomes <sup class="footnote-ref"><a href="#fn-1" id="fnref-1">1</a></sup> (numbered by first
// use; one without a note stays text), the notes leave the flow, and they follow the text as
// <section class="footnotes"><ol><li id="fn-1">… <a class="footnote-backref" href="#fnref-1">↩︎</a></li></ol></section>.
// In a document with several posts each gets its own prefix (fn2-1, fn2ref-1, ...).
let fnState = null; // { order, prefix, seen } during one renderSafe
const FOOTNOTE_REF_EXT = {
  name: 'footnoteRef',
  level: 'inline',
  start(src) {
    if (!fnState) return undefined;
    const i = src.indexOf('[^');
    return i < 0 ? undefined : i;
  },
  tokenizer(src) {
    if (!fnState) return undefined;
    const m = /^\[\^([^\]\s^[]{1,40})\]/.exec(src);
    if (!m || !fnState.order.has(m[1])) return undefined;
    return { type: 'footnoteRef', raw: m[0], num: fnState.order.get(m[1]) };
  },
  renderer(token) {
    const n = token.num;
    const p = fnState ? fnState.prefix : 'fn';
    const first = !!fnState && !fnState.seen.has(n);
    if (fnState) fnState.seen.add(n);
    return '<sup class="footnote-ref"><a href="#' + p + '-' + n + '"' + (first ? ' id="' + p + 'ref-' + n + '"' : '') + '>' + n + '</a></sup>';
  },
};
const FN_HREF_RE = /^#fn\d{0,4}(?:ref)?-\d{1,4}$/;
const FN_ID_RE = /^fn\d{0,4}(?:ref)?-\d{1,4}$/;

// The text with its listed notes blanked (same lines, so nothing around them joins up).
function withoutNotes(src, fn) {
  const listed = [];
  for (const [label] of fn.order) listed.push(fn.defs.get(label));
  listed.sort((x, y) => x.start - y.start);
  let out = '';
  let pos = 0;
  for (const d of listed) {
    if (d.start < pos) continue;
    out += src.slice(pos, d.start) + src.slice(d.start, d.end).replace(/[^\n]+/g, '');
    pos = d.end;
  }
  return out + src.slice(pos);
}
function notesHtml(fn, prefix) {
  let out = '<section class="footnotes"><ol>';
  for (const [label, n] of fn.order) {
    const lines = fn.defs.get(label).body.split('\n');
    let body = '';
    for (let k = 0; k < lines.length; k++) {
      if (k) body += '<br>';
      try {
        body += markdownEngine().parseInline(lines[k]);
      } catch (err) {
        body += escText(lines[k]);
      }
    }
    out += '<li id="' + prefix + '-' + n + '">' + body + ' <a class="footnote-backref" href="#' + prefix + 'ref-' + n + '">\u21A9\uFE0E</a></li>';
  }
  return out + '</ol></section>';
}

let markedInstance = null;
function markdownEngine() {
  if (markedInstance) return markedInstance;
  markedInstance = new Marked(
    { gfm: true, breaks: true, async: false },
    {
      tokenizer: {
        // Raw HTML is shown as text: writers type "<name>" far more often than real tags.
        html() {
          return undefined;
        },
        tag() {
          return undefined;
        },
        // No setext headings (a line of "-" or "=" under a paragraph), as in the editor: "---"
        // there is a divider (SPEC §14c).
        lheading() {
          return undefined;
        },
        // Strikethrough needs two tildes, as in the editor ("~5 minutes" stays text).
        del(src) {
          const m = /^~~(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))~~(?!~)/.exec(src);
          if (!m) return undefined;
          return { type: 'del', raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) };
        },
      },
    },
    { extensions: [SPOILER_EXT, FOOTNOTE_REF_EXT] },
  );
  return markedInstance;
}

function renderMarkdownRaw(md) {
  const src = str(md).replace(/\r\n?/g, '\n');
  try {
    return markdownEngine().parse(src);
  } catch (err) {
    return '<p>' + escText(src).replace(/\n/g, '<br>') + '</p>';
  }
}

const SAFE_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'strong', 'b', 'em', 'i', 's', 'del', 'a',
  'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
]);
const DROP_TAGS = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'noscript', 'template', 'svg',
  'math', 'canvas', 'video', 'audio', 'head', 'title', 'meta', 'link', 'base', 'textarea', 'select',
  'button', 'form',
]);

// Absolute http(s) and mailto links only; everything else is dropped (the text stays).
function safeHref(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  const compact = s.replace(/[\x00-\x20\x7F]/g, '');
  if (/^\/\//.test(compact)) s = 'https:' + s.replace(/^\s+/, '');
  else if (!/^(?:https?:|mailto:)/i.test(compact)) return null;
  s = s.replace(/[\u0000-\u001F\u007F]/g, '').replace(/ /g, '%20');
  return s;
}

function sanitizeInto(src, dst, d, inLink) {
  for (let c = src.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 3) {
      dst.appendChild(d.createTextNode(c.data));
      continue;
    }
    if (c.nodeType !== 1) continue;
    const tag = c.localName;
    if (DROP_TAGS.has(tag)) continue;
    if (tag === 'img') {
      const alt = cleanTitle(c.getAttribute('alt'));
      const up = uploadRef(c.getAttribute('src'));
      if (up) {
        const img = d.createElement('img');
        img.setAttribute('src', up.path);
        img.setAttribute('alt', alt);
        if (up.w) {
          img.setAttribute('width', String(up.w));
          img.setAttribute('height', String(up.h));
        }
        dst.appendChild(img);
        continue;
      }
      const href = safeHref(c.getAttribute('src'));
      if (!inLink && href && /^https?:/i.test(href)) {
        const a = d.createElement('a');
        a.setAttribute('href', href);
        a.setAttribute('rel', 'noopener');
        a.textContent = alt || 'image';
        dst.appendChild(a);
      } else {
        dst.appendChild(d.createTextNode(alt || (inLink ? 'image' : '[image]')));
      }
      continue;
    }
    if (tag === 'input') {
      if ((c.getAttribute('type') || '').toLowerCase() === 'checkbox') {
        dst.appendChild(d.createTextNode(c.hasAttribute('checked') ? '☑' : '☐'));
      }
      continue;
    }
    if ((tag === 'sup' && c.getAttribute('class') === 'footnote-ref') || (tag === 'section' && c.getAttribute('class') === 'footnotes')) {
      const el = d.createElement(tag);
      el.setAttribute('class', c.getAttribute('class'));
      sanitizeInto(c, el, d, inLink);
      dst.appendChild(el);
      continue;
    }
    if (tag === 'a' && FN_HREF_RE.test(c.getAttribute('href') || '')) {
      const a = d.createElement('a');
      a.setAttribute('href', c.getAttribute('href'));
      const id = c.getAttribute('id');
      if (id && FN_ID_RE.test(id)) a.setAttribute('id', id);
      if (c.getAttribute('class') === 'footnote-backref') a.setAttribute('class', 'footnote-backref');
      sanitizeInto(c, a, d, true);
      dst.appendChild(a);
      continue;
    }
    if (tag === 'div' && c.hasAttribute('data-wh-spoiler')) {
      const el = d.createElement('div');
      el.setAttribute('class', 'spoilers');
      sanitizeInto(c, el, d, inLink);
      dst.appendChild(el);
      continue;
    }
    if (!SAFE_TAGS.has(tag)) {
      sanitizeInto(c, dst, d, inLink);
      continue;
    }
    if (tag === 'a') {
      const href = safeHref(c.getAttribute('href'));
      if (!href || inLink) {
        sanitizeInto(c, dst, d, inLink);
        continue;
      }
      const a = d.createElement('a');
      a.setAttribute('href', href);
      a.setAttribute('rel', 'noopener');
      const title = c.getAttribute('title');
      if (title) a.setAttribute('title', title);
      sanitizeInto(c, a, d, true);
      dst.appendChild(a);
      continue;
    }
    const el = d.createElement(tag);
    if (tag === 'th' || tag === 'td') {
      for (const name of ['colspan', 'rowspan']) {
        const v = c.getAttribute(name);
        if (v && /^\d{1,3}$/.test(v) && +v > 1) el.setAttribute(name, v);
      }
      const align = (c.getAttribute('align') || '').toLowerCase();
      if (align === 'left' || align === 'center' || align === 'right') el.setAttribute('align', align);
    } else if (tag === 'ol') {
      const start = c.getAttribute('start');
      if (start && /^\d{1,9}$/.test(start) && +start !== 1) el.setAttribute('start', String(+start));
    } else if (tag === 'li') {
      const id = c.getAttribute('id');
      if (id && FN_ID_RE.test(id)) el.setAttribute('id', id);
    } else if (tag === 'code') {
      const m = /(?:^|\s)(language-[\w+#.-]{1,40})(?:\s|$)/.exec(c.getAttribute('class') || '');
      if (m) el.setAttribute('class', m[1]);
    }
    sanitizeInto(c, el, d, inLink);
    dst.appendChild(el);
  }
}

// Markdown -> sanitised DOM container (a <div> in the inert document). `fnPrefix` names the
// footnote anchors (see FOOTNOTE_REF_EXT).
function renderSafe(md, fnPrefix = 'fn') {
  const d = inertDoc();
  const tmp = d.createElement('div');
  const src = str(md).replace(/\r\n?/g, '\n');
  const fn = src.indexOf('[^') >= 0 ? footnotes(src) : null;
  if (fn && fn.order.size) {
    fnState = { order: fn.order, prefix: fnPrefix, seen: new Set() };
    try {
      tmp.innerHTML = renderMarkdownRaw(withoutNotes(src, fn)) + notesHtml(fn, fnPrefix);
    } finally {
      fnState = null;
    }
  } else tmp.innerHTML = renderMarkdownRaw(src);
  const out = d.createElement('div');
  sanitizeInto(tmp, out, d, false);
  return out;
}

export function markdownToHtml(md) {
  return renderSafe(md).innerHTML;
}

// Text a reader sees for a Markdown snippet (used to verify generated Markdown).
function renderedText(md) {
  const div = inertDoc().createElement('div');
  div.innerHTML = renderMarkdownRaw(md);
  return div.textContent || '';
}

// ---------------------------------------------------------------------------
// Markdown -> plain text
// ---------------------------------------------------------------------------

const PLAIN_BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'pre', 'hr', 'table', 'div', 'section']);
const isNotesEl = (el) => el.localName === 'section' && el.getAttribute('class') === 'footnotes';

// A spoiler block in sanitised output (see SPOILER_EXT).
function isSpoilerEl(el) {
  return el.localName === 'div' && el.getAttribute('class') === 'spoilers';
}

function plainInline(node) {
  let out = '';
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 3) {
      out += c.data;
      continue;
    }
    if (c.nodeType !== 1) continue;
    const tag = c.localName;
    if (tag === 'br') out += '\n';
    else if (tag === 'sup' && c.getAttribute('class') === 'footnote-ref') out += '[' + (c.textContent || '').trim() + ']';
    else if (tag === 'a' && c.getAttribute('class') === 'footnote-backref') continue;
    else if (tag === 'img') {
      const alt = c.getAttribute('alt');
      out += (alt ? '[image: ' + alt + ']' : '[image]') + ' (' + absoluteUrl(c.getAttribute('src')) + ')';
    } else if (tag === 'a') {
      const text = plainInline(c);
      const href = c.getAttribute('href') || '';
      const shown = /^mailto:/i.test(href) ? href.slice(7) : href;
      const same = (u) => u.replace(/^(?:https?:\/\/|mailto:)/i, '').replace(/\/$/, '');
      if (!href || !text.trim() || same(text.trim()) === same(shown)) out += text || shown;
      else out += text + ' (' + shown + ')';
    } else if (PLAIN_BLOCKS.has(tag)) out += '\n' + plainBlock(c) + '\n';
    else out += plainInline(c);
  }
  return out;
}

function plainBlocks(node, tight) {
  const parts = [];
  let inline = '';
  const flush = () => {
    const t = inline.replace(/^\s+|\s+$/g, '');
    if (t) parts.push(t);
    inline = '';
  };
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 3) {
      inline += c.data;
      continue;
    }
    if (c.nodeType !== 1) continue;
    if (PLAIN_BLOCKS.has(c.localName)) {
      flush();
      const b = plainBlock(c);
      if (b) parts.push(b);
    } else inline += plainInline(c);
  }
  flush();
  return parts.join(tight ? '\n' : '\n\n');
}

function plainList(el) {
  const ordered = el.localName === 'ol';
  let n = parseInt(el.getAttribute('start'), 10);
  if (!(n >= 0)) n = 1;
  const items = [];
  for (const li of el.children) {
    if (li.localName !== 'li') continue;
    const marker = ordered ? n++ + '. ' : '• ';
    const pad = ' '.repeat(marker.length);
    const body = plainBlocks(li, true);
    items.push(
      body
        .split('\n')
        .map((l, i) => (i === 0 ? marker + l : l ? pad + l : ''))
        .join('\n'),
    );
  }
  return items.join('\n');
}

function plainBlock(el) {
  switch (el.localName) {
    case 'blockquote':
      return plainBlocks(el, false);
    case 'ul':
    case 'ol':
      return plainList(el);
    case 'pre':
      return (el.textContent || '').replace(/\n$/, '');
    case 'section': {
      if (!isNotesEl(el)) return plainBlocks(el, false);
      const ol = el.querySelector('ol');
      const items = ol ? Array.from(ol.children).filter((li) => li.localName === 'li') : [];
      return items.map((li, k) => '[' + (k + 1) + '] ' + plainInline(li).replace(/^\s+|\s+$/g, '')).join('\n');
    }
    case 'hr':
      return '* * *';
    case 'div':
      // Plain text can't hide a spoiler: label it and keep its lines together.
      return isSpoilerEl(el) ? '[Spoiler]\n' + plainBlocks(el, true) : plainBlocks(el, false);
    case 'table': {
      const rows = [];
      for (const tr of el.querySelectorAll('tr')) {
        const cells = [];
        for (const td of tr.children) cells.push(plainInline(td).replace(/\s+/g, ' ').trim());
        rows.push(cells.join('\t'));
      }
      return rows.join('\n');
    }
    default:
      return plainInline(el).replace(/^\s+|\s+$/g, '');
  }
}

export function markdownToPlain(md) {
  const root = renderSafe(md);
  return plainBlocks(root, false)
    .replace(/[^\S\n]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Inline Markdown (a title) -> its visible text.
function inlineText(md) {
  return cleanTitle(renderedText(md));
}

// ---------------------------------------------------------------------------
// HTML -> Markdown: reading clipboard HTML into a small document model
// ---------------------------------------------------------------------------
//
// Block model:  { type: 'p', runs } | { type: 'h', level, runs } | { type: 'quote', blocks }
//               | { type: 'list', ordered, start, items: [{ blocks, task }] }
//               | { type: 'code', lang, text } | { type: 'hr' } | { type: 'table', rows }
// Inline runs:  { text, b, i, s, code, mono, href, size } or BR.

const BR = Object.freeze({ br: true });
const EMPTY_STYLE = Object.freeze({});
const ROOT_FMT = Object.freeze({
  b: false, i: false, s: false, code: false, mono: false, href: null, sup: false, sub: false, size: null,
});

const SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'head', 'title', 'meta', 'link', 'base', 'svg', 'canvas',
  'iframe', 'frame', 'frameset', 'object', 'embed', 'video', 'audio', 'source', 'track', 'map', 'area',
  'button', 'select', 'option', 'optgroup', 'datalist', 'textarea', 'colgroup', 'col', 'param', 'rp', 'rt',
  'o:p', 'dialog', 'xml', 'menuitem',
]);
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'center', 'dd', 'details', 'dir', 'div',
  'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hgroup', 'hr', 'html', 'legend', 'li', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'search',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);
const HEADING_RE = /^h([1-6])$/;
const MONO_FONT_RE = new RegExp(
  '^(?:courier|courier new|courier prime|consolas|monaco|menlo|monospace|ui-monospace|sf ?mono|sfmono-regular|' +
    'lucida console|lucida sans typewriter|andale mono|source code pro|roboto mono|fira code|fira mono|' +
    'jetbrains mono|ubuntu mono|dejavu sans mono|liberation mono|ibm plex mono|inconsolata|cascadia code|' +
    'cascadia mono|noto sans mono|pt mono|droid sans mono|space mono|overpass mono|anonymous pro|hack|' +
    'cousine|oxygen mono|victor mono|go mono|red hat mono|dm mono|b612 mono|geist mono|iosevka|' +
    'nimbus mono(?: ps| l)?|freemono|everson mono|ocr a(?: std| extended)?)$',
  'i',
);

const styleCache = new Map();
function parseStyle(text) {
  if (!text) return EMPTY_STYLE;
  const hit = styleCache.get(text);
  if (hit) return hit;
  const out = {};
  let depth = 0;
  let quote = '';
  let start = 0;
  const push = (seg) => {
    const i = seg.indexOf(':');
    if (i <= 0) return;
    const prop = seg.slice(0, i).trim().toLowerCase();
    const val = seg
      .slice(i + 1)
      .trim()
      .replace(/\s*!\s*important\s*$/i, '');
    if (prop && val) out[prop] = val;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) {
      push(text.slice(start, i));
      start = i + 1;
    }
  }
  push(text.slice(start));
  if (styleCache.size > 4000) styleCache.clear();
  styleCache.set(text, out);
  return out;
}

// CSS `font` shorthand -> { size, family, weight, style }. The shorthand resets weight/style.
function parseFontShorthand(v) {
  const m = /(?:^|\s)((?:\d*\.)?\d+(?:px|pt|em|rem|%)|xx-small|x-small|small|medium|large|x-large|xx-large)(?:\s*\/\s*\S+)?\s+(\S[\s\S]*)$/i.exec(
    v,
  );
  if (!m) return null;
  const pre = v.slice(0, m.index).toLowerCase();
  const w = /\b(bold|bolder|lighter|[1-9]00)\b/.exec(pre);
  return {
    size: m[1],
    family: m[2],
    weight: w ? w[1] : 'normal',
    style: /\b(?:italic|oblique)\b/.test(pre) ? 'italic' : 'normal',
  };
}

function weightOf(v) {
  const s = str(v).trim().toLowerCase();
  if (s === 'bold' || s === 'bolder') return 700;
  if (s === 'normal') return 400;
  if (s === 'lighter') return 300;
  const n = parseInt(s, 10);
  return n > 0 ? n : null;
}

function sizePx(v) {
  const m = /^((?:\d*\.)?\d+)\s*(px|pt)?$/i.exec(str(v).trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  return (m[2] || 'px').toLowerCase() === 'pt' ? (n * 4) / 3 : n;
}

function isMonoFamily(ff) {
  const first = str(ff)
    .split(',')[0]
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
  return MONO_FONT_RE.test(first);
}

function stripAtRules(css) {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf('@', i);
    if (at === -1) {
      out += css.slice(i);
      break;
    }
    out += css.slice(i, at);
    const open = css.indexOf('{', at);
    const semi = css.indexOf(';', at);
    if (open === -1 || (semi !== -1 && semi < open)) {
      i = semi === -1 ? css.length : semi + 1;
      continue;
    }
    let depth = 0;
    let j = open;
    for (; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}' && --depth === 0) break;
    }
    i = j + 1;
  }
  return out;
}

// Simple `tag.class` / `.class` rules from <style> blocks (Apple Notes / TextEdit put formatting there).
function parseClassRules(doc) {
  const rules = new Map();
  for (const st of doc.querySelectorAll('style')) {
    let css = st.textContent || '';
    if (css.length > 400000) continue;
    css = stripAtRules(css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--|-->/g, ''));
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(css))) {
      const decls = parseStyle(m[2].trim());
      for (const sel of m[1].split(',')) {
        const mm = /^\s*([a-z][a-z0-9]*)?\.([\w-]+)\s*$/i.exec(sel);
        if (!mm) continue;
        const key = (mm[1] ? mm[1].toLowerCase() : '') + '.' + mm[2];
        rules.set(key, Object.assign(rules.get(key) || {}, decls));
      }
    }
  }
  return rules;
}

function isHidden(el, st) {
  if (el.hasAttribute('hidden')) return true;
  if (st.display && /^none\b/i.test(st.display)) return true;
  if (st.visibility && /^hidden\b/i.test(st.visibility)) return true;
  if (st['mso-hide'] && /all/i.test(st['mso-hide'])) return true;
  return false;
}

function isBlockDisplay(st) {
  return !!st.display && /^(?:block|flex|grid|list-item|table|flow-root)\b/i.test(st.display.trim());
}

// Link targets worth keeping in Markdown: absolute http(s) and mailto.
function linkHref(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s || s[0] === '#') return null;
  const compact = s.replace(/[\x00-\x20\x7F]/g, '');
  if (/^\/\//.test(compact)) s = 'https:' + compact;
  else if (!/^(?:https?:|mailto:)/i.test(compact)) return null;
  s = s.replace(/[\u0000-\u001F\u007F]/g, '');
  // Google redirect wrappers (published Google Docs, search results).
  const g = /^https?:\/\/(?:www\.)?google\.[a-z.]+\/url\?(.*)$/i.exec(s);
  if (g) {
    const q = /(?:^|&)q=([^&]+)/.exec(g[1]);
    if (q) {
      try {
        const real = decodeURIComponent(q[1]);
        if (/^https?:\/\//i.test(real)) s = real;
      } catch (err) {
        /* keep the wrapper */
      }
    }
  }
  return s.replace(/ /g, '%20');
}

const SUPERSCRIPT = {
  0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷',
  8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽',
  ')': '⁾', n: 'ⁿ', i: 'ⁱ',
};
const SUBSCRIPT = {
  0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇',
  8: '₈', 9: '₉', '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍',
  ')': '₎',
};
// x<sup>2</sup> -> x², H<sub>2</sub>O -> H₂O. Anything else (e.g. "[1]", "st") stays as typed.
function mapScript(s, sup) {
  const map = sup ? SUPERSCRIPT : SUBSCRIPT;
  const t = s.trim();
  if (!t || t.length > 12) return s;
  for (const ch of t) if (!map[ch]) return s;
  return s.replace(/\S/g, (ch) => map[ch]);
}

function deriveFmt(f, el, tag, st, cls, ctx) {
  let o = null;
  const set = (k, v) => {
    if ((o || f)[k] !== v) {
      if (!o) o = Object.assign({}, f);
      o[k] = v;
    }
  };
  switch (tag) {
    case 'b':
    case 'strong':
      set('b', true);
      break;
    case 'i':
    case 'em':
    case 'cite':
    case 'dfn':
    case 'var':
      set('i', true);
      break;
    case 's':
    case 'strike':
    case 'del':
      set('s', true);
      break;
    case 'code':
    case 'kbd':
    case 'samp':
    case 'tt':
      set('code', true);
      break;
    case 'sup':
      set('sup', true);
      break;
    case 'sub':
      set('sub', true);
      break;
    case 'a': {
      const h = linkHref(el.getAttribute('href'));
      if (h) set('href', h);
      break;
    }
    case 'font': {
      const face = el.getAttribute('face');
      if (face) set('mono', isMonoFamily(face));
      break;
    }
    default:
  }
  if (cls && ctx.src.wordOnline && /\b(?:MacChrome)?Bold\b/.test(cls)) set('b', true);
  const font = st.font ? parseFontShorthand(st.font) : null;
  const fw = st['font-weight'] || (font && font.weight);
  if (fw) {
    // Sites often style <strong> at 500; for a span only 600+ reads as bold.
    const n = weightOf(fw);
    if (n != null) set('b', tag === 'b' || tag === 'strong' ? n >= 500 : n >= 600);
  }
  const fs = st['font-style'] || (font && font.style);
  if (fs) {
    if (/italic|oblique/i.test(fs)) set('i', true);
    else if (/^normal$/i.test(fs.trim())) set('i', false);
  }
  const td = (st['text-decoration'] || '') + ' ' + (st['text-decoration-line'] || '');
  if (/line-through/i.test(td)) set('s', true);
  const va = st['vertical-align'];
  if (va) {
    if (/^super/i.test(va.trim())) set('sup', true);
    else if (/^sub$/i.test(va.trim())) set('sub', true);
  }
  const ff = st['font-family'] || (font && font.family);
  if (ff) set('mono', isMonoFamily(ff));
  const fsz = st['font-size'] || (font && font.size);
  if (fsz) {
    const px = sizePx(fsz);
    if (px) set('size', px);
  }
  return o || f;
}

function hasVisible(runs) {
  for (const r of runs) if (!r.br && /\S/.test(r.text)) return true;
  return false;
}

// Text inside <pre>: keep whitespace, <br> and block children become newlines.
function preText(el) {
  let out = '';
  const rec = (n) => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) out += c.data;
      else if (c.nodeType === 1) {
        const t = c.localName;
        if (t === 'br') {
          out += '\n';
          continue;
        }
        if (SKIP_TAGS.has(t)) continue;
        const block = BLOCK_TAGS.has(t);
        if (block && out && !out.endsWith('\n')) out += '\n';
        rec(c);
        if (block && !out.endsWith('\n')) out += '\n';
      }
    }
  };
  rec(el);
  return out.replace(/\r\n?/g, '\n').replace(/\xA0/g, ' ').replace(ZERO_WIDTH_RE, '').replace(CONTROL_RE, '');
}

function codeLang(el) {
  const nodes = [el];
  const code = el.querySelector('code');
  if (code) nodes.push(code);
  for (const n of nodes) {
    const m = /\b(?:language|lang)-([A-Za-z0-9_+#.-]+)/.exec(n.getAttribute('class') || '');
    if (m && !/^(?:plaintext|plain|text|none|nohighlight|txt)$/i.test(m[1])) return m[1].toLowerCase();
  }
  return '';
}

const SKIP_CLASS_RE = /\b(?:footnote-back-?link|footnote-backref|MsoCommentReference|msocomoff|headerlink|anchorjs-link|mw-editsection)\b/i;

// Placeholders for uploaded images while a paste is converted (private-use characters).
const IMAGE_MARK_OPEN = '\u{E000}';
const IMAGE_MARK_CLOSE = '\u{E001}';
const IMAGE_MARK_CHARS_RE = /[\u{E000}\u{E001}]/gu;
const IMAGE_MARK_RE = /\u{E000}(\d+)\u{E001}/gu;
const BACK_ARROW_RE = /^(?:[\u{2191}\u{21A9}\u{2934}^\xB6\xA7#]|\u{21A9}\u{FE0E}|\u{21A9}\u{FE0F}|\u{1F517})$/u;

// Spoiler blocks: LessWrong / EA Forum (div.spoilers), our HTML exports (details.spoiler) and other
// class="spoiler" blocks. The label our own copies and exports add is not part of the text.
const SPOILER_CLASS_RE = /(?:^|\s)spoilers?(?:\s|$)/i;
const SPOILER_LABEL_ATTR = 'data-wh-spoiler-label';
const SPOILER_LABEL_CLASS_RE = /(?:^|\s)spoiler-label(?:\s|$)/;

function codeFmt(f) {
  return f.code ? f : Object.assign({}, f, { code: true });
}

// TeX source, as pasted: Wikipedia wraps it in {\displaystyle ...}.
function cleanTex(s) {
  let t = str(s).replace(/\s+/g, ' ').trim();
  const m = /^\{\\(?:display|text|script|scriptscript)style\s*([\s\S]*)\}$/.exec(t);
  if (m) t = m[1].trim();
  return t.length > 4000 ? '' : t;
}

// The TeX behind a MathML <math> element (KaTeX and MathJax annotations, Wikipedia's alttext).
function mathTex(m) {
  for (const a of m.querySelectorAll('annotation')) {
    if (/tex/i.test(a.getAttribute('encoding') || '')) {
      const t = cleanTex(a.textContent);
      if (t) return t;
    }
  }
  return cleanTex(m.getAttribute('alttext'));
}

// Emoji drawn as images. Slack: <img data-stringify-type="emoji" alt=":tada:" src=".../1f389.png">;
// Twitter, Facebook, Discord and Gmail put the emoji itself in alt or data-emoji.
const EMOJI_ONLY_RE = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|[\u{200D}\u{FE0E}\u{FE0F}\u{20E3}#*0-9]|[\u{E0020}-\u{E007F}])+$/u;
const EMOJI_CORE_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u{20E3}/u;
const SHORTCODE_RE = /^:[\w+-]{1,64}:$/;
const CODEPOINT_FILE_RE = /(?:^|[/_])([0-9a-f]{2,6}(?:[-_][0-9a-f]{2,6}){0,9})\.(?:png|gif|svg|webp|jpe?g)(?:[?#]|$)/i;

function isEmojiText(s) {
  return !!s && s.length <= 40 && EMOJI_ONLY_RE.test(s) && EMOJI_CORE_RE.test(s);
}

function emojiOf(el, src, alt) {
  if (isEmojiText(alt)) return alt;
  const data = cleanTitle(el.getAttribute('data-emoji'));
  if (isEmojiText(data)) return data;
  const shortcode = [cleanTitle(el.getAttribute('data-stringify-emoji')), alt].find((s) => SHORTCODE_RE.test(s)) || '';
  const emojiLike = !!shortcode || el.getAttribute('data-stringify-type') === 'emoji' || /(?:^|[\s_-])emoji(?:$|[\s_-])/i.test(el.getAttribute('class') || '');
  if (!emojiLike) return '';
  // Standard emoji images are named after their code points ("1f389.png", "1f44d-1f3fd.png").
  const m = CODEPOINT_FILE_RE.exec(src);
  if (m) {
    try {
      const s = String.fromCodePoint(...m[1].split(/[-_]/).map((h) => parseInt(h, 16)));
      if (isEmojiText(s)) return s;
    } catch (err) {
      /* not code points */
    }
  }
  if (shortcode) return shortcode; // custom emoji: keep the name people typed
  return alt && alt.length <= 40 ? alt : '';
}

class HtmlReader {
  constructor(ctx) {
    this.ctx = ctx;
    this.root = { blocks: [] };
    this.cur = this.root;
    this.runs = [];
    this.heading = 0;
  }

  styleOf(el, cls) {
    const inline = parseStyle(el.getAttribute('style'));
    const rules = this.ctx.classRules;
    if (!cls || !rules.size) return inline;
    let merged = null;
    const tag = el.localName;
    for (const c of cls.split(/\s+/)) {
      if (!c) continue;
      const r = rules.get(tag + '.' + c) || rules.get('.' + c);
      if (r) merged = Object.assign(merged || {}, r);
    }
    return merged ? Object.assign(merged, inline) : inline;
  }

  text(s, f) {
    if (!s) return;
    s = s.replace(/\xA0/g, ' ').replace(ZERO_WIDTH_RE, '').replace(CONTROL_RE, '').replace(IMAGE_MARK_CHARS_RE, '');
    if (!s) return;
    if (f.sup || f.sub) s = mapScript(s, f.sup);
    this.runs.push({ text: s, b: f.b, i: f.i, s: f.s, code: f.code, mono: f.mono, href: f.href, size: f.size });
  }

  br() {
    this.runs.push(BR);
  }

  // Close the current paragraph (or heading). Two or more <br> in a row start a new paragraph.
  flush() {
    if (!this.runs.length) return;
    const runs = this.runs;
    this.runs = [];
    const groups = [];
    let g = [];
    let i = 0;
    while (i < runs.length) {
      const r = runs[i];
      if (r.br) {
        let j = i;
        let n = 0;
        while (j < runs.length && (runs[j].br || !/\S/.test(runs[j].text))) {
          if (runs[j].br) n++;
          j++;
        }
        if (n >= 2) {
          groups.push(g);
          g = [];
          i = j;
          continue;
        }
      }
      g.push(r);
      i++;
    }
    groups.push(g);
    for (const grp of groups) {
      if (!hasVisible(grp)) continue;
      this.cur.blocks.push(this.heading ? { type: 'h', level: this.heading, runs: grp } : { type: 'p', runs: grp });
    }
  }

  push(block) {
    this.flush();
    this.cur.blocks.push(block);
  }

  within(container, fn) {
    this.flush();
    const prev = this.cur;
    const prevHeading = this.heading;
    this.cur = container;
    this.heading = 0;
    fn();
    this.flush();
    this.cur = prev;
    this.heading = prevHeading;
  }

  withHeading(level, fn) {
    this.flush();
    const prev = this.heading;
    this.heading = level;
    fn();
    this.flush();
    this.heading = prev;
  }

  quote(fn, fromClass) {
    const q = { type: 'quote', blocks: [], fromClass: !!fromClass };
    this.push(q);
    this.within(q, fn);
  }

  spoilerBlock(el, f) {
    const s = { type: 'spoiler', blocks: [] };
    this.push(s);
    this.within(s, () => {
      for (let c = el.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) this.text(c.data, f);
        else if (c.nodeType === 1 && c.localName !== 'summary' && !SPOILER_LABEL_CLASS_RE.test(c.getAttribute('class') || '')) this.visit(c, f);
      }
    });
  }

  // MathML: TeX as inline code when the source carries it, else the formula's text. A display
  // formula stands on its own line, as on the page.
  math(m, f, display) {
    if (display) this.flush();
    const tex = mathTex(m);
    if (tex) this.text(tex, codeFmt(f));
    else this.text(' ' + (m.textContent || '').trim() + ' ', f);
    if (display) this.flush();
  }

  // Math wrappers whose visible parts are images or duplicated markup: Wikipedia (hidden MathML and
  // an aria-hidden fallback image), KaTeX (MathML plus aria-hidden HTML) and LessWrong's \( \) spans.
  mathSpan(el, f, cls) {
    let tex = '';
    let display = false;
    if (/(?:^|\s)mwe-math-element(?:\s|$)/.test(cls)) {
      const m = el.querySelector('math');
      const img = el.querySelector('img[alt]');
      tex = (m && mathTex(m)) || (img && cleanTex(img.getAttribute('alt'))) || '';
      if (!tex && m) tex = cleanTex(m.textContent);
      display = /(?:^|\s)mwe-math-element-block(?:\s|$)/.test(cls) || (!!m && m.getAttribute('display') === 'block');
    } else if (/(?:^|\s)katex(?:-display)?(?:\s|$)/.test(cls)) {
      const m = el.querySelector('math');
      if (!m) return false;
      this.math(m, f, /(?:^|\s)katex-display(?:\s|$)/.test(cls));
      return true;
    } else if (/(?:^|\s)math-tex(?:\s|$)/.test(cls)) {
      const mm = /^\\\(([\s\S]+)\\\)$|^\\\[([\s\S]+)\\\]$/.exec((el.textContent || '').trim());
      if (!mm) return false;
      tex = cleanTex(mm[1] || mm[2]);
      display = !!mm[2];
    } else return false;
    if (display) this.flush();
    if (tex) this.text(tex, codeFmt(f));
    if (display) this.flush();
    return true;
  }

  walk(node, f) {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) this.text(c.data, f);
      else if (c.nodeType === 1) this.visit(c, f);
    }
  }

  visit(el, f) {
    const tag = el.localName;
    if (SKIP_TAGS.has(tag) || (tag.startsWith('mjx-') && tag !== 'mjx-container')) return;
    const cls = el.getAttribute('class') || '';
    if (cls && SKIP_CLASS_RE.test(cls)) return;
    if (el.hasAttribute('data-footnote-back-link') || el.getAttribute('role') === 'doc-backlink') return;
    if (el.hasAttribute(SPOILER_LABEL_ATTR)) return;
    const st = this.styleOf(el, cls);
    if (isHidden(el, st)) return;
    if (st['mso-list'] && /^ignore/i.test(st['mso-list'].trim())) return;
    if (st['mso-element'] && /comment/i.test(st['mso-element'])) return;
    // aria-hidden glyphs are decoration (icons, anchor marks). A line break never is (Slack marks
    // every <br> aria-hidden), and images decide for themselves (emoji, math, decorative).
    if (tag !== 'br' && tag !== 'img' && el.getAttribute('aria-hidden') === 'true' && (el.textContent || '').trim().length <= 2) return;
    const nf = deriveFmt(f, el, tag, st, cls, this.ctx);
    if (cls && this.mathSpan(el, nf, cls)) return;
    if (cls && tag !== 'span' && SPOILER_CLASS_RE.test(cls) && (BLOCK_TAGS.has(tag) || isBlockDisplay(st))) {
      this.spoilerBlock(el, nf);
      return;
    }
    switch (tag) {
      case 'br':
        this.br();
        return;
      case 'img':
        this.image(el, nf);
        return;
      case 'hr':
        this.push({ type: 'hr' });
        return;
      case 'input':
        this.checkbox(el);
        return;
      case 'pre':
        this.code(el);
        return;
      case 'table':
        this.table(el, nf);
        return;
      case 'ul':
      case 'ol':
        this.list(el, nf);
        return;
      case 'li': {
        const ordered = /decimal|alpha|roman|numeric/i.test(st['list-style-type'] || '');
        this.implicitItem(ordered, () => this.walk(el, nf));
        return;
      }
      case 'blockquote':
        this.quote(() => this.walk(el, nf));
        return;
      case 'q':
        this.text('“', nf);
        this.walk(el, nf);
        this.text('”', nf);
        return;
      case 'math':
        this.math(el, nf, el.getAttribute('display') === 'block');
        return;
      case 'mjx-container': {
        const m = el.querySelector('math');
        if (m) this.math(m, nf, el.getAttribute('display') === 'true' || m.getAttribute('display') === 'block');
        return;
      }
      case 'a': {
        const href = el.getAttribute('href') || '';
        if (href[0] === '#' && BACK_ARROW_RE.test((el.textContent || '').trim())) return;
        break;
      }
      case 'figcaption': {
        // A caption that repeats the image's alt text (our exports, the public pages) is said once.
        const fig = el.closest('figure');
        const im = fig && fig.querySelector('img');
        const alt = im ? cleanTitle(im.getAttribute('alt')) : '';
        if (alt && alt === cleanTitle(el.textContent)) return;
        break;
      }
      default:
    }
    const hm = HEADING_RE.exec(tag);
    if (hm) {
      this.withHeading(+hm[1], () => this.walk(el, nf));
      return;
    }
    if ((cls || el.hasAttribute('role')) && this.special(el, nf, cls)) return;
    // Code copied from editors and terminals (VS Code, highlighted snippets): monospace, pre spacing.
    if (nf.mono && (tag === 'div' || tag === 'p') && /^pre/i.test((st['white-space'] || '').trim())) {
      this.code(el);
      return;
    }
    if (BLOCK_TAGS.has(tag) || isBlockDisplay(st)) {
      this.flush();
      this.walk(el, nf);
      this.flush();
      return;
    }
    this.walk(el, nf);
  }

  // Class- and role-based structure: Word (MsoTitle, MsoQuote), Word online (role=heading), Notion blocks.
  special(el, f, cls) {
    const role = el.getAttribute('role');
    if (role === 'heading' && el.localName !== 'a') {
      const lvl = parseInt(el.getAttribute('aria-level'), 10);
      this.withHeading(lvl >= 1 && lvl <= 6 ? lvl : 2, () => this.walk(el, f));
      return true;
    }
    if (!cls) return false;
    if (/\bMsoTitle\b/.test(cls)) {
      this.withHeading(1, () => this.walk(el, f));
      return true;
    }
    if (/\bMso(?:Intense)?Quote\b/.test(cls)) {
      this.quote(() => this.walk(el, f), true);
      return true;
    }
    if (cls.indexOf('notion-') !== -1) {
      // Notion's live page DOM: blocks are divs with a class per type. Semantic tags inside win.
      const h = /\bnotion-(header|sub_header|sub_sub_header)-block\b/.exec(cls);
      if (h) {
        if (el.querySelector('h1,h2,h3,h4,h5,h6')) return false;
        this.withHeading(h[1] === 'header' ? 1 : h[1] === 'sub_header' ? 2 : 3, () => this.walk(el, f));
        return true;
      }
      if (/\bnotion-(?:bulleted_list|to_do)-block\b/.test(cls)) {
        this.implicitItem(false, () => this.walk(el, f));
        return true;
      }
      if (/\bnotion-numbered_list-block\b/.test(cls)) {
        this.implicitItem(true, () => this.walk(el, f));
        return true;
      }
      if (/\bnotion-(?:quote|callout)-block\b/.test(cls)) {
        if (el.querySelector('blockquote')) return false;
        this.quote(() => this.walk(el, f));
        return true;
      }
      if (/\bnotion-divider-block\b/.test(cls)) {
        this.push({ type: 'hr' });
        return true;
      }
      if (/\bnotion-code-block\b/.test(cls)) {
        if (el.querySelector('pre')) return false;
        this.code(el.querySelector('[contenteditable], code') || el);
        return true;
      }
    }
    if (el.localName === 'figure' && /\bcallout\b/.test(cls)) {
      this.quote(() => this.walk(el, f));
      return true;
    }
    const box = /\bcheckbox-(on|off)\b/.exec(cls);
    if (box) {
      this.markTask(box[1] === 'on');
      return true;
    }
    return false;
  }

  checkbox(el) {
    if ((el.getAttribute('type') || '').toLowerCase() !== 'checkbox') return;
    this.markTask(el.hasAttribute('checked'));
  }

  markTask(checked) {
    if (this.cur.task !== undefined && !this.cur.blocks.length && !hasVisible(this.runs)) this.cur.task = checked;
    else this.text(checked ? '☑ ' : '☐ ', ROOT_FMT);
  }

  code(el) {
    const text = preText(el)
      .replace(/^\n+/, '')
      .replace(/\s+$/, '');
    if (!text) return;
    this.push({ type: 'code', lang: codeLang(el), text });
  }

  image(el, f) {
    const src = (el.getAttribute('src') || '').trim();
    const alt = cleanTitle(el.getAttribute('alt') || el.getAttribute('title') || '');
    const w = parseInt(el.getAttribute('width'), 10);
    const h = parseInt(el.getAttribute('height'), 10);
    if ((w > 0 && w <= 2) || (h > 0 && h <= 2)) return; // tracking pixels
    const emoji = emojiOf(el, src, alt);
    if (emoji) {
      this.text(emoji, f);
      return;
    }
    // A formula drawn as an image (Wikipedia's fallback) carries its TeX in alt.
    if (/(?:^|\s)mwe-math-fallback-image/.test(el.getAttribute('class') || '') || /^\{\\(?:display|text)style[\s{\\]/.test(alt)) {
      const tex = cleanTex(alt);
      if (tex) this.text(tex, codeFmt(f));
      return;
    }
    if (el.getAttribute('aria-hidden') === 'true') return; // decorative
    // An image uploaded to this site (copied from a post, the live page or our exports) stays an
    // image; its size travels in the fragment, as the editor and public pages write it.
    const up = uploadRef(src);
    if (up) {
      let w = up.w;
      let h = up.h;
      if (!w) {
        w = parseInt(el.getAttribute('width'), 10);
        h = parseInt(el.getAttribute('height'), 10);
        if (!(w > 0 && h > 0 && w < 20000 && h < 20000)) w = h = 0;
      }
      const md = '![' + alt.replace(/[\\[\]*_`]/g, '\\$&') + '](' + up.path + (w ? '#w=' + w + '&h=' + h : '') + ')';
      // A placeholder the Markdown writer treats as a word; convertHtml puts the image back. (Pushed
      // directly: text() strips these characters from pasted text.)
      const mark = IMAGE_MARK_OPEN + (this.ctx.images.push(md) - 1) + IMAGE_MARK_CLOSE;
      this.runs.push({ text: mark, b: f.b, i: f.i, s: f.s, code: false, mono: false, href: f.href, size: f.size });
      return;
    }
    // Remote images stay links (privacy, CSP): "[image: alt](url)".
    const target = f.href || (/^https?:\/\//i.test(src) ? linkHref(src) : null);
    if (target) this.text(alt ? 'image: ' + alt : 'image', Object.assign({}, f, { href: target }));
    else this.text(alt || '[image]', f);
  }

  list(el, f) {
    const ordered = el.localName === 'ol';
    const start = parseInt(el.getAttribute('start'), 10);
    const L = { type: 'list', ordered, start: start >= 0 ? start : 1, items: [] };
    this.push(L);
    let item = null;
    const newItem = () => {
      item = { blocks: [], task: null };
      L.items.push(item);
      return item;
    };
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) {
        if (/\S/.test(c.data)) this.within(item || newItem(), () => this.text(c.data, f));
        continue;
      }
      if (c.nodeType !== 1) continue;
      if (c.localName === 'li') {
        const lcls = c.getAttribute('class') || '';
        const st = this.styleOf(c, lcls);
        if (isHidden(c, st)) continue;
        const lf = deriveFmt(f, c, 'li', st, lcls, this.ctx);
        this.within(newItem(), () => this.walk(c, lf));
        continue;
      }
      // Lists nested directly in a list (Google Docs, Apple Notes) belong to the previous item.
      this.within(item || newItem(), () => this.visit(c, f));
    }
  }

  // List items that are not inside <ul>/<ol> (orphan <li>, Notion list blocks).
  implicitItem(ordered, fn) {
    this.flush();
    const blocks = this.cur.blocks;
    let L = blocks[blocks.length - 1];
    if (!L || L.type !== 'list' || !L.implicit || L.ordered !== ordered) {
      L = { type: 'list', ordered, start: 1, items: [], implicit: true };
      blocks.push(L);
    }
    const it = { blocks: [], task: null };
    L.items.push(it);
    this.within(it, fn);
  }

  table(el, f) {
    this.flush();
    const caption = el.querySelector(':scope > caption');
    if (caption) {
      this.walk(caption, f);
      this.flush();
    }
    const rows = [];
    const trs = el.rows || [];
    for (const tr of trs) {
      const cells = [];
      for (const td of tr.cells) {
        const tcls = td.getAttribute('class') || '';
        const st = this.styleOf(td, tcls);
        if (isHidden(td, st)) continue;
        const align = ((td.getAttribute('align') || st['text-align'] || '') + '').toLowerCase().trim();
        const cell = {
          blocks: [],
          header: td.localName === 'th',
          colspan: Math.max(1, parseInt(td.getAttribute('colspan'), 10) || 1),
          rowspan: Math.max(1, parseInt(td.getAttribute('rowspan'), 10) || 1),
          align: align === 'center' || align === 'right' ? align : '',
        };
        const cf = deriveFmt(f, td, td.localName, st, tcls, this.ctx);
        this.within(cell, () => this.walk(td, cf));
        cells.push(cell);
      }
      if (cells.length) rows.push({ cells, head: !!tr.parentNode && tr.parentNode.localName === 'thead' });
    }
    if (rows.length) this.push({ type: 'table', rows });
  }
}

// ---------------------------------------------------------------------------
// HTML -> Markdown: structural pre-passes for Word and Google Docs / Word online lists
// ---------------------------------------------------------------------------

function isListEl(el) {
  return !!el && (el.localName === 'ul' || el.localName === 'ol');
}

function closestList(node) {
  let p = node.parentElement;
  while (p && !isListEl(p)) p = p.parentElement;
  return p;
}

function significantChildren(el) {
  const out = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 || (n.nodeType === 3 && /\S/.test(n.data))) out.push(n);
  }
  return out;
}

function isListish(el) {
  if (isListEl(el)) return true;
  if (el.localName !== 'div') return false;
  const k = significantChildren(el);
  return k.length === 1 && k[0].nodeType === 1 && isListish(k[0]);
}

function nextSignificantSibling(node) {
  let n = node.nextSibling;
  while (n && ((n.nodeType === 3 && !/\S/.test(n.data)) || n.nodeType === 8)) n = n.nextSibling;
  return n;
}

// tokens: [{ level (1-based), ordered, start, content: Node[], style }] -> fragment with nested lists.
function buildNestedLists(doc, tokens) {
  const frag = doc.createDocumentFragment();
  const stack = [];
  for (const t of tokens) {
    while (stack.length && stack[stack.length - 1].level > t.level) stack.pop();
    let top = stack[stack.length - 1];
    if (top && top.level === t.level && top.ordered !== t.ordered) {
      stack.pop();
      top = stack[stack.length - 1];
    }
    if (!top || top.level < t.level) {
      const list = doc.createElement(t.ordered ? 'ol' : 'ul');
      if (t.ordered && t.start !== 1) list.setAttribute('start', String(t.start));
      if (!top) frag.appendChild(list);
      else {
        let host = top.list.lastElementChild;
        if (!host) {
          host = doc.createElement('li');
          top.list.appendChild(host);
        }
        host.appendChild(list);
      }
      top = { list, level: t.level, ordered: t.ordered };
      stack.push(top);
    }
    const li = doc.createElement('li');
    if (t.style) li.setAttribute('style', t.style);
    for (const n of t.content) li.appendChild(n);
    top.list.appendChild(li);
  }
  return frag;
}

const MSO_LIST_RE = /mso-list\s*:\s*l(\d+)\s+level(\d+)/i;
const MSO_IGNORE_RE = /mso-list\s*:\s*ignore/i;

function takeWordMarker(p) {
  let marker = '';
  for (const s of p.querySelectorAll('span[style]')) {
    if (MSO_IGNORE_RE.test(s.getAttribute('style'))) {
      marker = (s.textContent || '').replace(/[\s\xA0]+/g, '');
      s.remove();
      break;
    }
  }
  const num = /^\(?(\d+)[.)]$/.exec(marker);
  return {
    ordered: /^\(?(?:\d+|[A-Za-z]|[ivxlcdmIVXLCDM]+)[.)]$/.test(marker),
    start: num ? +num[1] : 1,
  };
}

// Word desktop: list items are <p style="mso-list:l0 level2 lfo1"> with the bullet in an
// mso-list:Ignore span. Rebuild them as real nested lists.
function prepareWordLists(doc) {
  const cands = doc.querySelectorAll(
    'p[style*="mso-list"],div[style*="mso-list"],h1[style*="mso-list"],h2[style*="mso-list"],' +
      'h3[style*="mso-list"],h4[style*="mso-list"],h5[style*="mso-list"],h6[style*="mso-list"]',
  );
  if (!cands.length) return;
  const done = new Set();
  for (const el of cands) {
    if (done.has(el) || !el.parentNode || !MSO_LIST_RE.test(el.getAttribute('style') || '')) continue;
    if (HEADING_RE.test(el.localName)) {
      // Numbered headings keep their number as text.
      done.add(el);
      for (const s of el.querySelectorAll('span[style]')) {
        if (MSO_IGNORE_RE.test(s.getAttribute('style'))) {
          const label = (s.textContent || '').replace(/[\s\xA0]+/g, '');
          s.replaceWith(doc.createTextNode(label ? label + ' ' : ''));
          break;
        }
      }
      continue;
    }
    const run = [];
    for (let cur = el; cur; cur = nextSignificantSibling(cur)) {
      if (cur.nodeType !== 1 || HEADING_RE.test(cur.localName)) break;
      const m = MSO_LIST_RE.exec(cur.getAttribute('style') || '');
      if (!m) break;
      done.add(cur);
      const info = takeWordMarker(cur);
      run.push({
        el: cur,
        level: Math.max(1, Math.min(+m[2] || 1, 9)),
        ordered: info.ordered,
        start: info.start,
        content: Array.from(cur.childNodes),
      });
    }
    if (!run.length) continue;
    const frag = buildNestedLists(doc, run);
    run[0].el.parentNode.insertBefore(frag, run[0].el);
    for (const t of run) t.el.remove();
  }
}

function depthWithin(li, root) {
  let d = 0;
  for (let p = li.parentElement; p && p !== root.parentElement; p = p.parentElement) if (isListEl(p)) d++;
  return Math.max(1, d);
}

function rebuildLeveledRun(doc, run) {
  if (!run.length) return;
  const tokens = [];
  for (const el of run) {
    const lis = el.querySelectorAll('li');
    for (const li of lis) {
      const list = closestList(li);
      const lvl = parseInt(li.getAttribute('aria-level') || li.getAttribute('data-aria-level'), 10);
      const ordered = !!list && list.localName === 'ol';
      let start = 1;
      if (ordered && list.firstElementChild === li) {
        const s = parseInt(list.getAttribute('start'), 10);
        if (s >= 0) start = s;
      }
      tokens.push({
        level: lvl > 0 ? Math.min(lvl, 9) : depthWithin(li, el),
        ordered,
        start,
        content: Array.from(li.childNodes).filter((n) => !(n.nodeType === 1 && isListEl(n))),
        style: li.getAttribute('style'),
      });
    }
  }
  const frag = buildNestedLists(doc, tokens);
  run[0].parentNode.insertBefore(frag, run[0]);
  for (const el of run) el.remove();
}

// Google Docs and Word online mark list items with aria-level / data-aria-level and nest lists
// in non-standard ways (ul > ul, one <ul> per item). Rebuild those runs as clean nested lists.
function prepareLeveledLists(doc) {
  const lis = doc.querySelectorAll('li[aria-level], li[data-aria-level]');
  if (!lis.length) return;
  const parents = new Set();
  for (const li of lis) {
    let top = closestList(li);
    if (!top) continue;
    for (;;) {
      const p = top.parentElement;
      if (!p || p === doc.body) break;
      if (isListEl(p)) {
        top = p;
        continue;
      }
      if (p.localName === 'li' && isListEl(p.parentElement)) {
        top = p.parentElement;
        continue;
      }
      if (/^(?:div|span)$/.test(p.localName)) {
        const k = significantChildren(p);
        if (k.length === 1 && k[0] === top) {
          top = p;
          continue;
        }
      }
      break;
    }
    if (top.parentElement) parents.add(top.parentElement);
  }
  for (const P of parents) {
    let run = [];
    for (const k of Array.from(P.childNodes)) {
      if (k.nodeType === 1 && isListish(k) && k.querySelector('li[aria-level], li[data-aria-level]')) {
        run.push(k);
        continue;
      }
      if ((k.nodeType === 3 && !/\S/.test(k.data)) || k.nodeType === 8) continue;
      rebuildLeveledRun(doc, run);
      run = [];
    }
    rebuildLeveledRun(doc, run);
  }
}

// Slack writes a nested list as sibling lists marked data-indent="0", "1", ...: nest them again.
function prepareIndentedLists(doc) {
  const lists = doc.querySelectorAll('ul[data-indent], ol[data-indent]');
  if (lists.length < 2) return;
  const done = new Set();
  for (const first of lists) {
    if (done.has(first) || !first.parentNode) continue;
    const run = [];
    for (let cur = first; cur && cur.nodeType === 1 && isListEl(cur) && cur.hasAttribute('data-indent'); cur = nextSignificantSibling(cur)) {
      run.push(cur);
      done.add(cur);
    }
    if (run.length < 2) continue;
    const tokens = [];
    for (const list of run) {
      const level = Math.max(1, Math.min(9, (parseInt(list.getAttribute('data-indent'), 10) || 0) + 1));
      const s = parseInt(list.getAttribute('start'), 10);
      let start = s >= 0 ? s : 1;
      for (const li of Array.from(list.children)) {
        if (li.localName !== 'li') continue;
        tokens.push({ level, ordered: list.localName === 'ol', start, content: Array.from(li.childNodes), style: li.getAttribute('style') });
        start = 1;
      }
    }
    const frag = buildNestedLists(doc, tokens);
    run[0].parentNode.insertBefore(frag, run[0]);
    for (const el of run) el.remove();
  }
}

// Footnote references become "[1]", the form Google Docs, Word and LessWrong pastes already take,
// instead of a bare number glued to the word before it (Substack: "here.1") or a superscript
// inside brackets (Wikipedia: "[¹]").
const FOOTNOTE_REF_SEL = 'a.footnote-anchor, sup.reference, [role="doc-noteref"], sup.footnote-ref, a.footnote-ref';

function footnoteLabel(el) {
  const t = (el.textContent || '').replace(/[\s\xA0]+/g, ' ').trim();
  const m = /^\[?\s*([^[\]\s](?:[^[\]]{0,10}[^[\]\s])?)\s*\]?$/.exec(t);
  return m && /^[\p{L}\p{N}*\u{2020}\u{2021}\xA7\xB6]/u.test(m[1]) ? m[1] : null;
}

function prepareFootnotes(doc) {
  for (const el of doc.querySelectorAll(FOOTNOTE_REF_SEL)) {
    if (!el.isConnected) continue; // inside a reference replaced already
    const label = footnoteLabel(el);
    if (label) el.replaceWith(doc.createTextNode('[' + label + ']'));
  }
  // Substack's notes: <div class="footnote"><a class="footnote-number">1</a><div class="footnote-content">
  // <p>Text</p></div></div> -> "[1] Text".
  for (const note of doc.querySelectorAll('div.footnote, div[data-component-name="FootnoteToDOM"]')) {
    const num = note.querySelector('a.footnote-number');
    if (!num) continue;
    const label = footnoteLabel(num);
    num.remove();
    if (!label) continue;
    const content = note.querySelector('.footnote-content') || note;
    const first = content.querySelector('p') || content;
    first.insertBefore(doc.createTextNode('[' + label + '] '), first.firstChild);
  }
}

// ---------------------------------------------------------------------------
// HTML -> Markdown: clean-up of the document model
// ---------------------------------------------------------------------------

function collectStats(blocks, st) {
  for (const b of blocks) {
    if (b.type === 'p' || b.type === 'h') {
      for (const r of b.runs) {
        if (r.br) continue;
        const n = r.text.replace(/\s+/g, '').length;
        if (!n) continue;
        st.chars += n;
        if (r.mono && !r.code) st.mono += n;
        if (r.size && b.type === 'p') {
          const k = Math.round(r.size * 2) / 2;
          st.sizes.set(k, (st.sizes.get(k) || 0) + n);
          st.sized += n;
        }
      }
    } else if (b.type === 'quote' || b.type === 'spoiler') collectStats(b.blocks, st);
    else if (b.type === 'list') for (const it of b.items) collectStats(it.blocks, st);
    else if (b.type === 'table') for (const row of b.rows) for (const c of row.cells) collectStats(c.blocks, st);
  }
}

function plainRun(text) {
  return { text, b: false, i: false, s: false, code: false, href: null };
}

function sameFlags(a, b) {
  return a.b === b.b && a.i === b.i && a.s === b.s && a.code === b.code && a.href === b.href;
}

// Collapse whitespace like a browser, keep spaces outside formatting, merge equal neighbours.
function normalizeRuns(raw, ctx, isHeading) {
  const runs = [];
  let lineStart = true;
  const endsSpace = () => {
    const last = runs[runs.length - 1];
    return !!last && !last.br && / $/.test(last.text);
  };
  const trimTail = () => {
    while (runs.length) {
      const r = runs[runs.length - 1];
      if (r.br) return;
      const t = r.text.replace(/ +$/, '');
      if (t) {
        r.text = t;
        return;
      }
      runs.pop();
    }
  };
  for (const r0 of raw) {
    if (r0.br) {
      if (isHeading) {
        if (!lineStart && !endsSpace()) runs.push(plainRun(' '));
        continue;
      }
      trimTail();
      if (runs.length && !runs[runs.length - 1].br) runs.push(BR);
      lineStart = true;
      continue;
    }
    let t = r0.text.replace(/[ \t\n\r\f]+/g, ' ');
    if (lineStart || endsSpace()) t = t.replace(/^ /, '');
    if (!t) continue;
    runs.push({
      text: t,
      b: !isHeading && !!r0.b,
      i: !!r0.i,
      s: !!r0.s,
      code: !!(r0.code || (ctx.monoAsCode && r0.mono && !isHeading)),
      href: r0.href || null,
    });
    lineStart = false;
  }
  trimTail();
  while (runs.length && runs[runs.length - 1].br) {
    runs.pop();
    trimTail();
  }
  // Move edge spaces out of formatted runs.
  const a = [];
  for (const r of runs) {
    if (r.br || !(r.b || r.i || r.s || r.code || r.href)) {
      a.push(r);
      continue;
    }
    const m = /^( *)([\s\S]*?)( *)$/.exec(r.text);
    if (m[1]) a.push(plainRun(m[1]));
    if (m[2]) a.push(Object.assign({}, r, { text: m[2] }));
    if (m[3]) a.push(plainRun(m[3]));
  }
  // A space between two runs keeps the formatting they share.
  for (let i = 0; i < a.length; i++) {
    const r = a[i];
    if (r.br || /\S/.test(r.text)) continue;
    const p = a[i - 1];
    const n = a[i + 1];
    if (!p || !n || p.br || n.br) {
      Object.assign(r, plainRun(r.text));
      continue;
    }
    r.b = p.b && n.b;
    r.i = p.i && n.i;
    r.s = p.s && n.s;
    r.code = p.code && n.code;
    r.href = p.href && p.href === n.href ? p.href : null;
  }
  const out = [];
  for (const r of a) {
    const last = out[out.length - 1];
    if (last && !last.br && !r.br) {
      if (sameFlags(last, r)) {
        last.text += r.text;
        continue;
      }
      if (last.code && r.code && last.href === r.href) {
        last.text += r.text;
        last.b = last.b && r.b;
        last.i = last.i && r.i;
        last.s = last.s && r.s;
        continue;
      }
    }
    out.push(r.br ? r : Object.assign({}, r));
  }
  return out;
}

function isAllMono(runs) {
  let any = false;
  for (const r of runs) {
    if (r.br || !/\S/.test(r.text)) continue;
    if (!r.mono || r.code || r.href) return false;
    any = true;
  }
  return any;
}

function codeTextOf(runs) {
  return runs
    .map((r) => (r.br ? '\n' : r.text.replace(/[\r\n]+/g, ' ')))
    .join('')
    .replace(/[^\S\n]+$/gm, '');
}

// Google Docs titles and Apple Notes headings are only big text: guess the level from the size.
function sizeHeadingLevel(runs, base) {
  let chars = 0;
  let minRatio = Infinity;
  let allBold = true;
  for (const r of runs) {
    if (r.br) return 0;
    const n = r.text.replace(/\s+/g, '').length;
    if (!n) continue;
    if (!r.size) return 0;
    chars += n;
    minRatio = Math.min(minRatio, r.size / base);
    if (!r.b) allBold = false;
  }
  if (!chars || chars > 160) return 0;
  if (minRatio >= 1.6) return 1;
  if (minRatio >= 1.25) return 2;
  if (minRatio >= 1.1 && allBold) return 3;
  return 0;
}

function finalizeBlocks(blocks, ctx, where) {
  const out = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'p':
      case 'h': {
        if (b.type === 'p' && where !== 'cell' && ctx.monoAsCode && isAllMono(b.runs)) {
          out.push({ type: 'code', lang: '', text: codeTextOf(b.runs), mono: true });
          break;
        }
        let type = b.type;
        let level = b.level;
        if (type === 'p' && where === 'root' && ctx.baseSize) {
          const lvl = sizeHeadingLevel(b.runs, ctx.baseSize);
          if (lvl) {
            type = 'h';
            level = lvl;
          }
        }
        const runs = normalizeRuns(b.runs, ctx, type === 'h');
        if (runs.length) out.push(type === 'h' ? { type, level, runs } : { type, runs });
        break;
      }
      case 'quote': {
        const inner = finalizeBlocks(b.blocks, ctx, where === 'root' ? 'quote' : where);
        if (inner.length) out.push({ type: 'quote', blocks: inner, fromClass: b.fromClass });
        break;
      }
      case 'spoiler': {
        const inner = finalizeBlocks(b.blocks, ctx, where === 'root' ? 'quote' : where);
        if (inner.length) out.push({ type: 'spoiler', blocks: inner });
        break;
      }
      case 'list': {
        const items = [];
        for (const it of b.items) {
          const bl = finalizeBlocks(it.blocks, ctx, 'item');
          let task = it.task;
          // Our exports write task boxes as ballot-box symbols; read them back as task items.
          const first = bl[0] && bl[0].type === 'p' ? bl[0].runs[0] : null;
          if (task == null && first && !first.br && !first.code && /^[\u{2610}\u{2611}\u{2612}] /u.test(first.text)) {
            task = first.text[0] !== '\u{2610}';
            first.text = first.text.slice(2);
            if (!first.text) bl[0].runs.shift();
            if (!bl[0].runs.length) bl.shift();
          }
          if (bl.length || task != null) items.push({ blocks: bl, task });
        }
        if (items.length) out.push({ type: 'list', ordered: b.ordered, start: b.start, items });
        break;
      }
      case 'table': {
        const rows = b.rows.map((r) => ({
          head: r.head,
          cells: r.cells.map((c) => Object.assign({}, c, { blocks: finalizeBlocks(c.blocks, ctx, 'cell') })),
        }));
        out.push({ type: 'table', rows });
        break;
      }
      case 'code':
        if (b.text.trim()) out.push(b);
        break;
      case 'hr':
        out.push(b);
        break;
      default:
    }
  }
  const merged = [];
  for (const b of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.type === 'list' && b.type === 'list' && prev.ordered === b.ordered) {
      prev.items = prev.items.concat(b.items);
      continue;
    }
    if (prev && prev.type === 'code' && prev.mono && b.type === 'code' && b.mono) {
      prev.text += '\n' + b.text;
      continue;
    }
    if (prev && prev.type === 'quote' && prev.fromClass && b.type === 'quote' && b.fromClass) {
      prev.blocks = prev.blocks.concat(b.blocks);
      continue;
    }
    if (prev && prev.type === 'hr' && b.type === 'hr') continue;
    merged.push(b);
  }
  if (merged.length && merged[0].type === 'hr' && where === 'root') merged.shift();
  return merged;
}

// ---------------------------------------------------------------------------
// HTML -> Markdown: writing Markdown
// ---------------------------------------------------------------------------

const DELIM = { s: '~~', b: '**', i: '*' };
const MARK_ORDER = { a: 0, s: 1, b: 2, i: 3 };
const ENTITY_RE = /^&(?:#\d{1,7}|#[xX][\da-fA-F]{1,6}|[A-Za-z][A-Za-z\d]{1,31});/;
const AUTOLINK_RE = /^<(?:[A-Za-z][A-Za-z\d+.-]{1,31}:[^\s<>]*|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)>/;
const BARE_URL_RE = /^(?:https?:\/\/|www\.)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?::\d+)?(?:[/?#][^\s<>"'`]*)?$/;
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const NEEDS_CHECK_RE = /[\\`*_~[\]<&|]|(?:^|\n)[ \t]*(?:[#>+=-]|\d{1,9}[.)])/;

function codeSpan(text, cell) {
  const t = cell ? text.replace(/\|/g, '\\|') : text;
  const ticks = t.match(/`+/g) || [];
  let n = 1;
  while (ticks.some((x) => x.length === n)) n++;
  const fence = '`'.repeat(n);
  const pad = t[0] === '`' || t[t.length - 1] === '`' || (t[0] === ' ' && t[t.length - 1] === ' ' && /[^ ]/.test(t)) ? ' ' : '';
  return fence + pad + t + pad + fence;
}

function parensBalanced(s) {
  let d = 0;
  for (const c of s) {
    if (c === '(') d++;
    else if (c === ')' && --d < 0) return false;
  }
  return d === 0;
}

function linkDest(href) {
  let h = String(href).replace(/[\s<>\\]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
  if (!parensBalanced(h)) h = h.replace(/[()]/g, '\\$&');
  return h;
}

// A link whose text is its own URL can be written as a bare URL (GFM autolink).
function isBareLinkable(r, prev, next) {
  const t = r.text;
  if (/^mailto:/i.test(r.href)) {
    if (r.href.slice(7) !== t || !EMAIL_RE.test(t)) return false;
  } else {
    const sameUrl = t === r.href || (/^www\./i.test(t) && r.href === 'http://' + t);
    if (!sameUrl || !BARE_URL_RE.test(t) || /[.,:;!?'"*_~]$/.test(t) || !parensBalanced(t)) return false;
  }
  if (prev && !prev.br && !/[\s(]$/.test(prev.text)) return false;
  if (next && !next.br && !/^[\s.,:;!?)]/.test(next.text)) return false;
  return true;
}

function protectUrls(ch, isText) {
  const prot = new Uint8Array(ch.length);
  let i = 0;
  while (i < ch.length) {
    if (!isText[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < ch.length && isText[j]) j++;
    const seg = ch.slice(i, j);
    const s = seg.join('');
    if (/https?:\/\/|www\./i.test(s)) {
      const offs = [];
      let o = 0;
      for (const c of seg) {
        offs.push(o);
        o += c.length;
      }
      const re = /(?:https?:\/\/|www\.)[^\s<>]+/gi;
      let m;
      while ((m = re.exec(s))) {
        const a = m.index;
        const b = a + m[0].length;
        for (let k = 0; k < seg.length; k++) if (offs[k] >= a && offs[k] < b) prot[i + k] = 1;
      }
    }
    i = j;
  }
  return prot;
}

function lineStartEscapes(ch, isText, esc, opt) {
  const line = ch.join('');
  if (/^#{1,6}(?:[ \t]|$)/.test(line) || line[0] === '>' || /^[-+*](?:[ \t]|$)/.test(line)) {
    esc[0] = 1;
    return;
  }
  if (/^([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line) || /^(?:=+|-+)[ \t]*$/.test(line) || /^(?:`{3,}|~{3,})/.test(line)) {
    esc[0] = 1;
    return;
  }
  const m = /^(\d{1,9})([.)])(?:[ \t]|$)/.exec(line);
  if (m && isText[m[1].length]) {
    esc[m[1].length] = 1;
    return;
  }
  if (/^\[[^\]]*\]:/.test(line) || (opt.itemFirst && /^\[[ xX]\](?:[ \t]|$)/.test(line))) esc[0] = 1;
}

// Delimiter runs of `*` and `_` (CommonMark flanking rules) and `~~` (strikethrough). A run of user
// text is escaped only when another run in the line could pair with it.
function emphasisEscapes(ch, isText, prot, esc) {
  const n = ch.length;
  const runs = { '*': [], _: [], '~': [] };
  for (let i = 0; i < n; ) {
    const c = ch[i];
    if ((c === '*' || c === '_' || c === '~') && !prot[i]) {
      let j = i;
      while (j + 1 < n && ch[j + 1] === c && !prot[j + 1]) j++;
      let text = 0;
      for (let k = i; k <= j; k++) if (isText[k]) text++;
      const before = ch[i - 1];
      const after = ch[j + 1];
      const wsB = before === undefined || WS_RE.test(before);
      const wsA = after === undefined || WS_RE.test(after);
      const pB = !wsB && UNI_PUNCT_RE.test(before);
      const pA = !wsA && UNI_PUNCT_RE.test(after);
      const lf = !wsA && (!pA || wsB || pB);
      const rf = !wsB && (!pB || wsA || pA);
      const len = j - i + 1;
      let canOpen;
      let canClose;
      if (c === '_') {
        canOpen = lf && (!rf || pB);
        canClose = rf && (!lf || pA);
      } else if (c === '*') {
        canOpen = lf;
        canClose = rf;
      } else {
        canOpen = len >= 2 && !wsA;
        canClose = len >= 2 && !wsB;
      }
      runs[c].push({ i, j, text, len, canOpen, canClose });
      i = j + 1;
    } else i++;
  }
  for (const c of ['*', '_', '~']) {
    const list = runs[c];
    let openerBefore = false;
    list.forEach((R, idx) => {
      if (R.text) {
        const laterCloser = list.slice(idx + 1).some((x) => x.canClose);
        if ((R.canOpen && laterCloser) || (R.canClose && openerBefore)) {
          for (let k = R.i; k <= R.j; k++) if (isText[k]) esc[k] = 1;
          if (R.text === R.len) return;
        }
      }
      if (R.canOpen) openerBefore = true;
    });
  }
}

// toks: [{ s, text?, link? }]. Text tokens are user text; everything else is Markdown syntax.
function escapeLine(toks, opt, mode) {
  const ch = [];
  const isText = [];
  const linkOf = [];
  for (const t of toks) {
    for (const c of t.s) {
      ch.push(c);
      isText.push(!!t.text);
      linkOf.push(t.text ? t.link || 0 : 0);
    }
  }
  const n = ch.length;
  const esc = new Uint8Array(n);
  if (mode === 'escaped' || mode === 'plain') {
    for (let i = 0; i < n; i++) if (isText[i] && ASCII_PUNCT_RE.test(ch[i])) esc[i] = 1;
  } else {
    const prot = protectUrls(ch, isText);
    emphasisEscapes(ch, isText, prot, esc);
    let ticks = 0;
    for (let i = 0; i < n; i++) if (ch[i] === '`' && (i === 0 || ch[i - 1] !== '`')) ticks++;
    let openBracket = false;
    for (let i = 0; i < n; i++) {
      if (ch[i] === '[' && !esc[i]) openBracket = true;
      // In a table cell every pipe is a column break, even inside a URL.
      if (opt.cell && isText[i] && ch[i] === '|') esc[i] = 1;
      if (!isText[i] || prot[i]) continue;
      const c = ch[i];
      if (c === '\\') {
        if (i + 1 >= n || ASCII_PUNCT_RE.test(ch[i + 1])) esc[i] = 1;
      } else if (c === '`') {
        // A lone backtick is just a character; two or more could open a code span.
        if (ticks > 1) esc[i] = 1;
      } else if (c === ']') {
        if (openBracket && (ch[i + 1] === '(' || ch[i + 1] === '[')) esc[i] = 1;
      } else if (c === '&') {
        if (ENTITY_RE.test(ch.slice(i, i + 40).join(''))) esc[i] = 1;
      } else if (c === '|') {
        if (opt.cell) esc[i] = 1;
      } else if (c === '<') {
        const m = AUTOLINK_RE.exec(ch.slice(i, i + 300).join(''));
        if (m) {
          esc[i] = 1;
          // Also break the bare-URL autolink inside, so "<https\://...>" stays plain text.
          const colon = m[0].indexOf(':');
          if (colon > 0 && !/@/.test(m[0].slice(0, colon))) esc[i + colon] = 1;
        }
      }
    }
    // Brackets inside link text must balance.
    const groups = new Map();
    for (let i = 0; i < n; i++) {
      if (linkOf[i] && isText[i] && (ch[i] === '[' || ch[i] === ']')) {
        if (!groups.has(linkOf[i])) groups.set(linkOf[i], []);
        groups.get(linkOf[i]).push(i);
      }
    }
    for (const idxs of groups.values()) {
      let d = 0;
      let ok = true;
      for (const i of idxs) {
        d += ch[i] === '[' ? 1 : -1;
        if (d < 0) ok = false;
      }
      if (!ok || d !== 0) for (const i of idxs) esc[i] = 1;
    }
    if (opt.lineStart && n && isText[0]) lineStartEscapes(ch, isText, esc, opt);
    if (opt.heading) {
      // A trailing " #" would be read as a closing sequence.
      let k = n - 1;
      while (k >= 0 && ch[k] === '#' && isText[k]) k--;
      if (k < n - 1 && (k < 0 || ch[k] === ' ' || ch[k] === '\t')) esc[k + 1] = 1;
    }
  }
  let out = '';
  for (let i = 0; i < n; i++) out += (esc[i] ? '\\' : '') + ch[i];
  return out;
}

function firstCp(s) {
  if (!s) return '';
  const c = s.charCodeAt(0);
  return c >= 0xd800 && c <= 0xdbff && s.length > 1 ? s.slice(0, 2) : s.slice(0, 1);
}

function lastCp(s) {
  if (!s) return '';
  const c = s.charCodeAt(s.length - 1);
  return c >= 0xdc00 && c <= 0xdfff && s.length > 1 ? s.slice(-2) : s.slice(-1);
}

// Scripts written without spaces between words, where emphasis is legitimately intraword.
const SPACELESS_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}]/u;
const WORD_HEAD_RE = /^[\p{L}\p{N}\p{M}]+(?:['\u{2019}][\p{L}\p{N}\p{M}]+)*/u;
const WORD_TAIL_RE = /(?:[\p{L}\p{N}\p{M}]+['\u{2019}])*[\p{L}\p{N}\p{M}]+$/u;

// `*` delimiters cannot close between punctuation and a letter ("**“quoted”**s") or open between a
// letter and punctuation ("x**(note)**"), and marked mis-reads a one-sided intraword delimiter inside
// another emphasis ("*a **of**x*"). In those cases stretch the emphasis over the adjacent word.
function fixFlanking(runs) {
  const a = runs.map((r) => (r.br ? r : Object.assign({}, r)));
  const wordy = (c) => !!c && !WS_RE.test(c) && !UNI_PUNCT_RE.test(c) && !SPACELESS_RE.test(c);
  const punct = (c) => !!c && UNI_PUNCT_RE.test(c);
  // The character a delimiter actually touches: a link boundary is "[" or ")", a code span "`".
  const endChar = (r, next) => (r.code ? '`' : r.href && next.href !== r.href ? ')' : lastCp(r.text));
  const startChar = (r, prev) => (r.code ? '`' : r.href && prev.href !== r.href ? '[' : firstCp(r.text));
  const nested = (A, B, M) => ['b', 'i'].some((N) => N !== M && A[N] && B[N]);
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 200) {
    changed = false;
    for (let k = 0; k + 1 < a.length && !changed; k++) {
      const A = a[k];
      const B = a[k + 1];
      if (A.br || B.br) continue;
      for (const M of ['b', 'i']) {
        if (A[M] && !B[M] && !B.code && !(B.href && B.href !== A.href)) {
          const e = endChar(A, B);
          const f = startChar(B, A);
          if (wordy(f) && (punct(e) || (wordy(e) && nested(A, B, M)))) {
            const m = WORD_HEAD_RE.exec(B.text);
            if (!m) continue;
            const piece = Object.assign({}, B, { text: m[0] });
            piece[M] = true;
            const rest = B.text.slice(m[0].length);
            a.splice(k + 1, 1, piece);
            if (rest) a.splice(k + 2, 0, Object.assign({}, B, { text: rest }));
            changed = true;
            break;
          }
        }
        if (!A[M] && B[M] && !A.code && !(A.href && A.href !== B.href)) {
          const e = endChar(A, B);
          const f = startChar(B, A);
          if (wordy(e) && (punct(f) || (wordy(f) && nested(A, B, M)))) {
            const m = WORD_TAIL_RE.exec(A.text);
            if (!m) continue;
            const piece = Object.assign({}, A, { text: m[0] });
            piece[M] = true;
            const rest = A.text.slice(0, A.text.length - m[0].length);
            a.splice(k, 1, piece);
            if (rest) a.splice(k, 0, Object.assign({}, A, { text: rest }));
            changed = true;
            break;
          }
        }
      }
    }
  }
  const out = [];
  for (const r of a) {
    const last = out[out.length - 1];
    if (last && !last.br && !r.br && sameFlags(last, r)) last.text += r.text;
    else out.push(r);
  }
  return out;
}

function writeLine(runsIn, opt) {
  const mode = opt.mode || 'normal';
  const marked = mode === 'normal' || mode === 'escaped';
  const runs = marked ? fixFlanking(runsIn) : runsIn;
  const prepared = runs.map((r, k) => ({
    r,
    bare: !!r.href && !r.code && !r.b && !r.i && !r.s && isBareLinkable(r, runs[k - 1], runs[k + 1]),
  }));
  const marks = prepared.map((p) => {
    const m = [];
    if (p.r.href && !p.bare) m.push({ k: 'a', v: p.r.href });
    if (marked) {
      if (p.r.s) m.push({ k: 's' });
      if (p.r.b) m.push({ k: 'b' });
      if (p.r.i) m.push({ k: 'i' });
    }
    return m;
  });
  const has = (list, mk) => list.some((x) => x.k === mk.k && x.v === mk.v);
  const reach = (idx, mk) => {
    let len = 0;
    for (let j = idx; j < prepared.length && has(marks[j], mk); j++) len += prepared[j].r.text.length;
    return len;
  };
  const toks = [];
  const stack = [];
  let linkId = 0;
  let openLink = 0;
  const close = () => {
    const mk = stack.pop();
    if (mk.k === 'a') {
      openLink = 0;
      toks.push({ s: '](' + linkDest(mk.v) + ')', close: true });
    } else toks.push({ s: DELIM[mk.k], close: true });
  };
  for (let idx = 0; idx < prepared.length; idx++) {
    const act = marks[idx];
    let keep = 0;
    while (keep < stack.length && has(act, stack[keep])) keep++;
    while (stack.length > keep) close();
    const open = act.filter((mk) => !has(stack, mk));
    open.sort((x, y) => reach(idx, y) - reach(idx, x) || MARK_ORDER[x.k] - MARK_ORDER[y.k]);
    for (const mk of open) {
      if (mk.k === 'a') {
        toks.push({ s: '[', open: true });
        openLink = ++linkId;
      } else toks.push({ s: DELIM[mk.k], open: true, link: openLink });
      stack.push(mk);
    }
    const p = prepared[idx];
    // Last resort ('plain'): code becomes escaped text too (marked cannot parse some code spans in links).
    if (p.r.code && mode !== 'plain') toks.push({ s: codeSpan(p.r.text, opt.cell) });
    else if (p.bare) toks.push({ s: p.r.text });
    else toks.push({ s: p.r.text, text: true, link: openLink });
  }
  while (stack.length) close();
  return escapeLine(shiftSpaces(toks), opt, mode);
}

// Delimiters must hug the text: move spaces from just inside an opener or closer to the outside.
function shiftSpaces(toks) {
  const t = toks.slice();
  for (let guard = 0; guard < 400; guard++) {
    let moved = false;
    for (let k = 0; k + 1 < t.length; k++) {
      const a = t[k];
      const b = t[k + 1];
      if (a.open && b.text && /^\s/.test(b.s)) {
        const sp = /^\s+/.exec(b.s)[0];
        t[k + 1] = Object.assign({}, b, { s: b.s.slice(sp.length) });
        t.splice(k, 0, { s: sp, text: true, link: a.s === '[' ? 0 : a.link || 0 });
        moved = true;
        break;
      }
      if (b.close && a.text && /\s$/.test(a.s)) {
        const sp = /\s+$/.exec(a.s)[0];
        t[k] = Object.assign({}, a, { s: a.s.slice(0, a.s.length - sp.length) });
        t.splice(k + 2, 0, { s: sp, text: true, link: b.s === '[' || /^\]\(/.test(b.s) ? 0 : a.link || 0 });
        moved = true;
        break;
      }
    }
    if (!moved) break;
  }
  return t.filter((x) => x.s !== '');
}

function runsText(runs) {
  return runs.map((r) => (r.br ? '\n' : r.text)).join('');
}

function squash(s) {
  return s.replace(/\s+/g, '');
}

// Does the generated Markdown read back as exactly the expected text?
function verifies(md, expected) {
  if (!NEEDS_CHECK_RE.test(md)) return true;
  return squash(renderedText(md)) === squash(expected);
}

function splitLines(runs) {
  const lines = [[]];
  for (const r of runs) {
    if (r.br) lines.push([]);
    else lines[lines.length - 1].push(r);
  }
  return lines;
}

// The emphasis stretches (bold / italic / strike) of a line, most suspicious first: stretches whose
// edges touch non-space characters or other stretches are the ones parsers disagree on.
function markSegments(runs) {
  const segs = [];
  for (const M of ['b', 'i', 's']) {
    let start = -1;
    for (let k = 0; k <= runs.length; k++) {
      const on = k < runs.length && !runs[k].br && !!runs[k][M];
      if (on && start < 0) start = k;
      if (!on && start >= 0) {
        segs.push({ M, a: start, b: k - 1 });
        start = -1;
      }
    }
  }
  const edgeOf = (k, atEnd) => {
    const r = runs[k];
    if (!r || r.br) return ' ';
    return atEnd ? lastCp(r.text) : firstCp(r.text);
  };
  const ends = new Map();
  for (const sg of segs) {
    ends.set(sg.a, (ends.get(sg.a) || 0) + 1);
    ends.set(sg.b + 1, (ends.get(sg.b + 1) || 0) + 1);
  }
  for (const sg of segs) {
    let score = 0;
    if (!WS_RE.test(edgeOf(sg.a - 1, true) || ' ')) score += 2;
    if (!WS_RE.test(edgeOf(sg.b + 1, false) || ' ')) score += 2;
    if ((ends.get(sg.a) || 0) > 1) score += 1;
    if ((ends.get(sg.b + 1) || 0) > 1) score += 1;
    sg.score = score;
    sg.len = 0;
    for (let k = sg.a; k <= sg.b; k++) sg.len += runs[k].text.length;
  }
  return segs.sort((x, y) => y.score - x.score || x.len - y.len);
}

// Write runs with `render(runs, mode)`, keeping as much formatting as reads back correctly:
// minimal escapes; then without the most suspicious emphasis stretches, one at a time; then every
// punctuation mark escaped; then without emphasis; then both (always reproduces the text).
function writeVerified(runs, render, check) {
  let md = render(runs, 'normal');
  if (check(md)) return md;
  let cur = runs;
  const segs = markSegments(runs).slice(0, 16);
  for (const sg of segs) {
    cur = cur.map((r, k) => (k >= sg.a && k <= sg.b && !r.br ? Object.assign({}, r, { [sg.M]: false }) : r));
    md = render(cur, 'normal');
    if (check(md)) return md;
  }
  for (const mode of ['escaped', 'nomarks', 'plain']) {
    md = render(runs, mode);
    if (mode === 'plain' || check(md)) return md;
  }
  return md;
}

function writeParagraph(runs, opt) {
  const expected = runsText(runs);
  return writeVerified(
    runs,
    (rs, mode) =>
      splitLines(rs)
        .map((ln, k) => writeLine(ln, { mode, lineStart: true, itemFirst: !!opt.itemFirst && k === 0, cell: false }))
        .join('\n'),
    (md) => verifies(md, expected),
  );
}

function writeHeading(b) {
  const prefix = '#'.repeat(b.level) + ' ';
  const expected = runsText(b.runs);
  return writeVerified(b.runs, (rs, mode) => prefix + writeLine(rs, { mode, heading: true }), (md) => verifies(md, expected));
}

function writeCell(runs) {
  const expected = runsText(runs);
  // `\|` is a table-cell escape (also inside code spans); check the cell as a plain paragraph.
  return writeVerified(runs, (rs, mode) => writeLine(rs, { mode, cell: true }), (md) => verifies(md.replace(/\\\|/g, '|'), expected));
}

function writeCode(b) {
  const text = b.text.replace(/[^\S\n]+$/gm, '').replace(/\n+$/, '');
  const fences = text.match(/^ {0,3}`{3,}/gm);
  let fence = '```';
  if (fences) fence = '`'.repeat(Math.max.apply(null, fences.map((f) => f.trim().length)) + 1);
  const lang = (b.lang || '').replace(/[^\w+#.-]/g, '');
  return fence + lang + '\n' + text + '\n' + fence;
}

function writeList(L) {
  let n = L.start;
  let loose = false;
  const items = [];
  for (const it of L.items) {
    const marker = L.ordered ? n++ + '.' : '-';
    const pad = ' '.repeat(marker.length + 1);
    let body = writeBlocks(it.blocks, { inItem: true, itemFirst: it.task == null });
    if (it.task != null) body = (it.task ? '[x]' : '[ ]') + (body ? ' ' + body : '');
    if (/\n\n/.test(body)) loose = true;
    const lines = body.split('\n');
    items.push(
      marker +
        (lines[0] ? ' ' + lines[0] : '') +
        lines
          .slice(1)
          .map((l) => '\n' + (l ? pad + l : ''))
          .join(''),
    );
  }
  return items.join(loose ? '\n\n' : '\n');
}

function cellRuns(cell) {
  const out = [];
  for (const b of cell.blocks) {
    if (b.type !== 'p' && b.type !== 'h') continue;
    if (out.length) out.push(plainRun(' '));
    for (const r of b.runs) out.push(r.br ? plainRun(' ') : r);
  }
  return normalizeRuns(out, { monoAsCode: false }, false);
}

function writeTable(T, opt) {
  const rows = T.rows.filter((r) => r.cells.length);
  if (!rows.length) return '';
  const all = [];
  for (const r of rows) for (const c of r.cells) all.push(c);
  const ncols = Math.max.apply(
    null,
    rows.map((r) => r.cells.reduce((n, c) => n + c.colspan, 0)),
  );
  const blocksOf = (cells) => {
    const out = [];
    for (const c of cells) for (const b of c.blocks) out.push(b);
    return out;
  };
  // One cell or one column: not really a table (callout boxes, code galleries).
  if (all.length === 1 || ncols === 1) return writeBlocks(blocksOf(all), opt);
  // Layout tables (lists, quotes, code or nested tables inside cells): keep the content in order.
  if (!all.every((c) => c.blocks.every((b) => b.type === 'p' || b.type === 'h'))) return writeBlocks(blocksOf(all), opt);
  if (all.some((c) => c.colspan > 1 || c.rowspan > 1)) {
    // Merged cells cannot be a GFM table: one line per row.
    return rows
      .map((r) => {
        const runs = [];
        for (const c of r.cells) {
          const cr = cellRuns(c);
          if (!cr.length) continue;
          if (runs.length) runs.push(plainRun(' · '));
          for (const x of cr) runs.push(x);
        }
        return runs.length ? writeParagraph(runs, {}) : '';
      })
      .filter(Boolean)
      .join('\n\n');
  }
  const head = rows[0].cells;
  const line = (cells, isHead) => {
    const out = [];
    for (let i = 0; i < ncols; i++) {
      let runs = cells[i] ? cellRuns(cells[i]) : [];
      if (isHead && runs.length && runs.every((r) => r.b || !/\S/.test(r.text))) {
        runs = runs.map((r) => Object.assign({}, r, { b: false }));
      }
      out.push(writeCell(runs));
    }
    return '| ' + out.join(' | ') + ' |';
  };
  const delim =
    '| ' +
    Array.from({ length: ncols }, (_, i) => {
      const a = head[i] ? head[i].align : '';
      return a === 'center' ? ':---:' : a === 'right' ? '---:' : '---';
    }).join(' | ') +
    ' |';
  return [line(head, true), delim].concat(rows.slice(1).map((r) => line(r.cells, false))).join('\n');
}

function writeBlock(b, opt) {
  switch (b.type) {
    case 'p':
      return writeParagraph(b.runs, opt);
    case 'h':
      return writeHeading(b);
    case 'quote':
      return writeBlocks(b.blocks, {})
        .split('\n')
        .map((l) => (l ? '> ' + l : '>'))
        .join('\n');
    case 'spoiler':
      return writeBlocks(b.blocks, {})
        .split('\n')
        .map((l) => (l ? '>! ' + l : '>!'))
        .join('\n');
    case 'list':
      return writeList(b);
    case 'code':
      return writeCode(b);
    case 'hr':
      return '---';
    case 'table':
      return writeTable(b, opt);
    default:
      return '';
  }
}

function writeBlocks(blocks, opt) {
  let out = '';
  let prev = null;
  blocks.forEach((b, i) => {
    const s = writeBlock(b, i === 0 ? opt : Object.assign({}, opt, { itemFirst: false }));
    if (!s) return;
    if (prev) {
      const tight =
        opt.inItem && b.type === 'list' && (prev.type === 'p' || prev.type === 'list') && (!b.ordered || b.start === 1);
      out += tight ? '\n' : '\n\n';
    }
    out += s;
    prev = b;
  });
  return out;
}

function makeContext(doc, html) {
  const src = {
    gdocs: /docs-internal-guid/.test(html),
    word: /urn:schemas-microsoft-com:office|class=["']?Mso|mso-[a-z]/i.test(html),
    wordOnline: /\b(?:TextRun|NormalTextRun|OutlineElement)\b|data-ccp-props/.test(html),
    cocoa: /Cocoa HTML Writer/i.test(html),
  };
  return {
    src,
    // Word's <style> describes paragraph styles (italic quotes, big titles): use inline formatting only.
    classRules: src.word ? new Map() : parseClassRules(doc),
    monoAsCode: true,
    baseSize: 0,
    images: [], // Markdown for uploaded images, by placeholder index
  };
}

function convertHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const ctx = makeContext(doc, html);
  prepareWordLists(doc);
  prepareLeveledLists(doc);
  prepareIndentedLists(doc);
  prepareFootnotes(doc);
  const reader = new HtmlReader(ctx);
  reader.walk(doc.body || doc.documentElement, ROOT_FMT);
  reader.flush();
  const stats = { chars: 0, mono: 0, sized: 0, sizes: new Map() };
  collectStats(reader.root.blocks, stats);
  ctx.monoAsCode = stats.chars > 0 && stats.mono / stats.chars < 0.5;
  if ((ctx.src.gdocs || ctx.src.cocoa) && stats.sized >= stats.chars * 0.6) {
    let best = 0;
    let bestN = 0;
    for (const [k, v] of stats.sizes) {
      if (v > bestN) {
        best = k;
        bestN = v;
      }
    }
    ctx.baseSize = best;
  }
  const blocks = finalizeBlocks(reader.root.blocks, ctx, 'root');
  return writeBlocks(blocks, {})
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '')
    .replace(IMAGE_MARK_RE, (m, i) => ctx.images[+i] || '');
}

function fallbackText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const el of doc.querySelectorAll('script,style,noscript,template,head,svg,iframe')) el.remove();
  for (const br of doc.querySelectorAll('br')) br.replaceWith('\n');
  for (const el of doc.querySelectorAll('p,div,li,h1,h2,h3,h4,h5,h6,blockquote,pre,tr')) el.append('\n\n');
  return normalizePlain((doc.body && doc.body.textContent) || '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function htmlToMarkdown(html) {
  const src = str(html);
  if (!src.trim()) return '';
  try {
    return convertHtml(src);
  } catch (err) {
    console.warn('[interop] htmlToMarkdown fell back to plain text', err);
    try {
      return fallbackText(src);
    } catch (err2) {
      return '';
    }
  }
}

// ---------------------------------------------------------------------------
// Copy out
// ---------------------------------------------------------------------------

const CLIP_STYLE = {
  blockquote: `margin:0 0 0 1.25em;padding:0 0 0 1em;border-left:2px solid ${ACCENT};`,
  pre: 'font-family:Consolas,"Courier New",monospace;font-size:0.9em;white-space:pre-wrap;',
  code: 'font-family:Consolas,"Courier New",monospace;',
  table: 'border-collapse:collapse;',
  th: 'border:1px solid #c9c9c9;padding:4px 8px;text-align:left;',
  td: 'border:1px solid #c9c9c9;padding:4px 8px;',
};

// Semantic HTML with a few inline styles, so Google Docs, Word and the LessWrong editor keep formatting.
// With a title, the title is the <h1> and the body's headings move down a level (as in the exports),
// so a body that starts with its own "# heading" doesn't give two top-level headings.
function richHtml(md, title) {
  const root = title ? bodyDom(md) : renderSafe(md);
  const d = root.ownerDocument;
  if (title) {
    const h = d.createElement('h1');
    h.textContent = title;
    root.insertBefore(h, root.firstChild);
  }
  // Spoilers keep LessWrong's markup (its editor makes them spoiler blocks again); editors without
  // spoilers (Google Docs, Substack) show the label instead of revealing the text unannounced.
  for (const el of root.querySelectorAll('div.spoilers')) {
    const label = d.createElement('p');
    label.setAttribute(SPOILER_LABEL_ATTR, '1');
    const b = d.createElement('strong');
    b.textContent = 'Spoiler';
    label.appendChild(b);
    el.insertBefore(label, el.firstChild);
  }
  // Uploaded images by their full address, so the editor pasted into can fetch them.
  for (const img of root.querySelectorAll('img')) {
    img.setAttribute('src', absoluteUrl(img.getAttribute('src')));
    img.setAttribute('style', 'max-width:100%;height:auto;');
  }
  for (const el of root.querySelectorAll('blockquote,pre,code,table,th,td')) {
    let s = CLIP_STYLE[el.localName] || '';
    if (el.localName === 'code' && el.parentNode && el.parentNode.localName === 'pre') s = '';
    const align = el.getAttribute('align');
    if (align) {
      s += 'text-align:' + align + ';';
      el.removeAttribute('align');
    }
    if (s) el.setAttribute('style', s);
  }
  return '<meta charset="utf-8"><div ' + OWN_HTML_MARKER + '="1">' + root.innerHTML + '</div>';
}

export function fillClipboard(clipboardData, markdown) {
  const md = str(markdown);
  clipboardData.setData('text/plain', md);
  try {
    clipboardData.setData('text/html', richHtml(md));
  } catch (err) {
    console.warn('[interop] rich copy failed, plain text only', err);
  }
}

function legacyCopy(html, plain) {
  let wrote = false;
  const onCopy = (e) => {
    e.clipboardData.setData('text/plain', plain);
    e.clipboardData.setData('text/html', html);
    e.preventDefault();
    wrote = true;
  };
  const active = document.activeElement;
  const ta = document.createElement('textarea');
  ta.value = plain || ' ';
  ta.setAttribute('readonly', '');
  ta.setAttribute('aria-hidden', 'true');
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;';
  document.addEventListener('copy', onCopy, true);
  document.body.appendChild(ta);
  let ok = false;
  try {
    ta.select();
    ok = document.execCommand('copy');
  } catch (err) {
    ok = false;
  }
  document.removeEventListener('copy', onCopy, true);
  ta.remove();
  if (active && typeof active.focus === 'function') {
    try {
      active.focus({ preventScroll: true });
    } catch (err) {
      /* ignore */
    }
  }
  return ok && wrote;
}

// The title for a rich copy. LessWrong and Substack have their own title field, so their copy is
// the body alone; Google Docs has none, so its copy (target 'gdocs') starts with the title. With no
// target, a title is used when one is given.
function copyTitle(title, target) {
  return target === 'lesswrong' || target === 'substack' ? '' : cleanTitle(title);
}

// What copyRich puts on the clipboard, without writing it (for a ClipboardItem built synchronously
// in a click handler, which iOS Safari needs):
//   richCopyData(body)                    body only (LessWrong, Substack: they have a title field)
//   richCopyData(body, title, 'gdocs')    title first, the body's headings one level down
export function richCopyData(markdown, title, target) {
  const md = str(markdown);
  const t = copyTitle(title, target);
  return { html: richHtml(md, t), plain: t ? '# ' + t + '\n\n' + md : md };
}

export async function copyRich(markdown, title, target) {
  const md = str(markdown);
  const t = copyTitle(title, target);
  let html;
  try {
    html = richHtml(md, t);
  } catch (err) {
    console.warn('[interop] could not build rich HTML', err);
    return false;
  }
  const plain = t ? '# ' + t + '\n\n' + md : md;
  // Call the async clipboard synchronously from the click (Safari requires the user gesture).
  if (typeof ClipboardItem === 'function' && navigator.clipboard && typeof navigator.clipboard.write === 'function') {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([plain], { type: 'text/plain' }),
        }),
      ]);
      return true;
    } catch (err) {
      /* fall back to execCommand below */
    }
  }
  return legacyCopy(html, plain);
}

// ---------------------------------------------------------------------------
// Export: shared pieces
// ---------------------------------------------------------------------------

function normPost(post) {
  return { title: cleanTitle(post && post.title), body: str(post && post.body).replace(/\r\n?/g, '\n') };
}

function slugify(s, fallback) {
  let t = str(s)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['’‘`]/g, '')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  const chars = Array.from(t);
  if (chars.length > 80) t = chars.slice(0, 80).join('').replace(/-+$/, '');
  if (!t) t = fallback || 'untitled';
  if (/^(?:con|prn|aux|nul|com\d|lpt\d)$/i.test(t)) t += '-post';
  return t;
}

function download(filename, data, mime) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 60000);
}

// ---------------------------------------------------------------------------
// Export: uploaded images for the formats that embed them (.docx, .epub)
// ---------------------------------------------------------------------------

const EMBED_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' };

// Decoded pixels of an image file. createImageBitmap can't read SVG (the "removed by the host"
// placeholder is one); an <img> can.
async function decodeImage(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob);
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close && bmp.close() };
    } catch (err) {
      /* try an <img> below */
    }
  }
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
  return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
}

function hasTransparency(ctx, w, h) {
  const px = ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < px.length; i += 4) if (px[i] < 255) return true;
  return false;
}

// One uploaded image -> { bytes, mime, ext, width, height }. PNG, JPEG and GIF are embedded as
// they are; WebP (what the editor uploads) isn't safe in older Word versions and e-readers, so it
// is re-encoded: PNG when it has transparency, else JPEG.
async function loadUpload(path) {
  const res = await fetch(path, { credentials: 'same-origin' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const blob = await res.blob();
  const type = (res.headers.get('content-type') || blob.type || '').split(';')[0].trim().toLowerCase();
  const pic = await decodeImage(blob);
  try {
    const { width, height } = pic;
    if (!(width > 0 && height > 0)) throw new Error('empty image');
    if (EMBED_TYPES[type]) return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: type, ext: EMBED_TYPES[type], width, height };
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(pic.source, 0, 0);
    const mime = hasTransparency(ctx, width, height) ? 'image/png' : 'image/jpeg';
    const out = await new Promise((resolve) => canvas.toBlob(resolve, mime, 0.9));
    if (!out) throw new Error('could not re-encode');
    canvas.width = canvas.height = 0;
    return { bytes: new Uint8Array(await out.arrayBuffer()), mime, ext: EMBED_TYPES[mime], width, height };
  } finally {
    pic.close();
  }
}

// Every uploaded image in the posts -> Map(path -> image | null when it couldn't be loaded; the
// document then links to it). Two at a time: decoded images are large on a phone.
async function loadUploads(posts) {
  const paths = [];
  for (const p of posts) {
    for (const img of renderSafe(p.body).querySelectorAll('img')) {
      const path = img.getAttribute('src');
      if (!paths.includes(path)) paths.push(path);
    }
  }
  const out = new Map();
  let next = 0;
  const worker = async () => {
    while (next < paths.length) {
      const path = paths[next++];
      try {
        out.set(path, await loadUpload(path));
      } catch (err) {
        console.warn('[interop] image not embedded: ' + path, err);
        out.set(path, null);
      }
    }
  };
  await Promise.all([worker(), worker()]);
  return out;
}

function formatDate(d) {
  try {
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  } catch (err) {
    return d.toISOString().slice(0, 10);
  }
}

function countLabel(n) {
  return n + (n === 1 ? ' post' : ' posts');
}

function topHeadingLevel(root) {
  let min = 7;
  for (const h of root.querySelectorAll('h1,h2,h3,h4,h5,h6')) min = Math.min(min, +h.localName[1]);
  return min;
}

// Body DOM for documents. The post title is the h1, so a body that uses `#` headings moves down
// one level; a body whose top level is already `##` keeps its levels.
function bodyDom(md, fnPrefix) {
  const root = renderSafe(md, fnPrefix);
  const d = root.ownerDocument;
  if (topHeadingLevel(root) !== 1) return root;
  for (const h of Array.from(root.querySelectorAll('h1,h2,h3,h4,h5,h6'))) {
    const lvl = Math.min(6, +h.localName[1] + 1);
    const nh = d.createElement('h' + lvl);
    while (h.firstChild) nh.appendChild(h.firstChild);
    h.replaceWith(nh);
  }
  return root;
}

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input']);

// Spoilers in documents. On screen (HTML export, EPUB) a <details> the reader opens; readers without
// <details> support show it open under its "Spoiler" summary. On paper (PDF) a labelled box.
const PRINT_SPOILER_STYLE = 'margin:1.2em 0;padding:0.7em 1em 0.05em;border:0.6pt solid #c9c4b8;border-radius:3px;break-inside:avoid;';
const PRINT_SPOILER_LABEL_STYLE =
  'font-family:' + SANS + ';font-size:7.5pt;font-weight:600;letter-spacing:0.15em;text-transform:uppercase;color:#6b6f73;margin:0 0 0.6em;';

function spoilerMarkup(inner, opts) {
  if (opts && opts.spoiler === 'box') {
    return (
      '<div class="spoiler" style="' + escAttr(PRINT_SPOILER_STYLE) + '"><p class="spoiler-label" style="' +
      escAttr(PRINT_SPOILER_LABEL_STYLE) + '">Spoiler</p>' + inner + '</div>'
    );
  }
  return '<details class="spoiler"><summary>Spoiler</summary>' + inner + '</details>';
}

// The only element of a paragraph that holds just an image (shown as a figure, as on the public
// pages), else null.
function soleImage(el) {
  let img = null;
  for (let c = el.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 3) {
      if (/\S/.test(c.data)) return null;
      continue;
    }
    if (c.nodeType !== 1) continue;
    if (c.localName !== 'img' || img) return null;
    img = c;
  }
  return img;
}

// An uploaded image in a document. opts.img(path, el) -> { src, width?, height? } (null when the
// file couldn't be fetched: the image becomes a link to it); the default is its full address.
function imageMarkup(el, opts) {
  const path = el.getAttribute('src');
  const alt = el.getAttribute('alt') || '';
  const w = el.getAttribute('width');
  const h = el.getAttribute('height');
  const ref = opts && opts.img ? opts.img(path, el) : { src: absoluteUrl(path), width: w, height: h };
  if (!ref) return '<a href="' + escAttr(absoluteUrl(path)) + '">' + escText(alt ? '[image: ' + alt + ']' : '[image]') + '</a>';
  let a = ' src="' + escAttr(ref.src) + '" alt="' + escAttr(alt) + '"';
  if (ref.width && ref.height) a += ' width="' + escAttr(String(ref.width)) + '" height="' + escAttr(String(ref.height)) + '"';
  if (opts && opts.imgStyle) a += ' style="' + escAttr(opts.imgStyle) + '"';
  if (opts && opts.lazy) a += ' loading="lazy" decoding="async"';
  return '<img' + a + (opts && opts.xhtml ? ' />' : '>');
}

function figureMarkup(img, opts) {
  const alt = img.getAttribute('alt') || '';
  const st = (k) => (opts && opts[k] ? ' style="' + escAttr(opts[k]) + '"' : '');
  return (
    '<figure class="image"' + st('figureStyle') + '>' + imageMarkup(img, opts) +
    (alt ? '<figcaption' + st('captionStyle') + '>' + escText(alt) + '</figcaption>' : '') + '</figure>'
  );
}

// Serialise the sanitised DOM as XHTML-compatible markup (also valid HTML5).
function serialize(node, opts) {
  let out = '';
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 3) {
      out += escText(c.data);
      continue;
    }
    if (c.nodeType !== 1) continue;
    const tag = c.localName;
    if (isSpoilerEl(c)) {
      out += spoilerMarkup(serialize(c, opts), opts);
      continue;
    }
    if (tag === 'img') {
      out += imageMarkup(c, opts);
      continue;
    }
    if (tag === 'p') {
      const img = soleImage(c);
      if (img) {
        out += figureMarkup(img, opts);
        continue;
      }
    }
    let attrs = '';
    for (const a of Array.from(c.attributes)) {
      if (a.name === 'align') attrs += ' style="text-align:' + escAttr(a.value) + '"';
      else attrs += ' ' + a.name + '="' + escAttr(a.value) + '"';
    }
    if (VOID_TAGS.has(tag)) {
      out += '<' + tag + attrs + (opts && opts.xhtml ? ' />' : '>');
      continue;
    }
    const inner = serialize(c, opts);
    if (tag === 'table' && opts && opts.wrapTables) out += '<div class="table-wrap"><table' + attrs + '>' + inner + '</table></div>';
    else out += '<' + tag + attrs + '>' + inner + '</' + tag + '>';
  }
  return out;
}

// ---------------------------------------------------------------------------
// Export: Markdown and plain text
// ---------------------------------------------------------------------------

// Exported Markdown points uploaded images at this site (code blocks and code spans untouched).
const UPLOAD_IMAGE_MD_RE = /(`+)[^`]*?\1|(!\[(?:\\.|[^\]\\\n])*\]\()(\/u\/[A-Za-z0-9_-]{6,80}\.(?:webp|png|jpe?g|gif)(?:#[^\s)]*)?(?:\s+"[^"\n]*")?\))/gi;

function absoluteUploads(md) {
  const origin = siteOrigin();
  if (!origin || md.indexOf('](/u/') === -1) return md;
  let fence = '';
  return md
    .split('\n')
    .map((line) => {
      const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !/\S/.test(line.slice(f[0].length))) fence = '';
        return line;
      }
      if (f) {
        fence = f[1];
        return line;
      }
      return line.replace(UPLOAD_IMAGE_MD_RE, (m, ticks, open, rest) => (ticks ? m : open + origin + HOTLINK_OK + rest.slice(3)));
    })
    .join('\n');
}

function postMarkdown(p) {
  const body = absoluteUploads(p.body.replace(/\s+$/, ''));
  if (!p.title) return body + '\n';
  return '# ' + p.title + (body ? '\n\n' + body : '') + '\n';
}

function underline(title, ch) {
  return title + '\n' + ch.repeat(Math.min(72, Math.max(3, Array.from(title).length)));
}

function postText(p, ch) {
  const body = markdownToPlain(p.body);
  if (!p.title) return body;
  return underline(p.title, ch) + (body ? '\n\n' + body : '');
}

// ---------------------------------------------------------------------------
// Export: standalone HTML
// ---------------------------------------------------------------------------

const EXPORT_CSS = `
:root { color-scheme: light; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; background: #fff; }
body { margin: 0; background: #fff; color: ${INK}; font-family: ${SERIF}; font-size: 20px; line-height: 1.55;
  font-variant-numeric: oldstyle-nums proportional-nums; font-kerning: normal; font-optical-sizing: auto;
  text-rendering: optimizeLegibility; -webkit-font-smoothing: antialiased; hanging-punctuation: first allow-end;
  overflow-wrap: break-word; }
.book { max-width: 33em; margin: 0 auto; padding: 16vh 1.5rem 20vh; }
.post + .post { margin-top: 9em; }
.post + .post::before { content: "* * *"; display: block; text-align: center; letter-spacing: 0.6em; padding-left: 0.6em;
  color: ${ACCENT}; margin-bottom: 6em; }
.post-title { font-size: 2.6em; font-weight: 300; line-height: 1.08; letter-spacing: -0.016em; margin: 0 0 1.15em;
  text-wrap: balance; }
p { margin: 0 0 1em; }
h2, h3, h4, h5, h6 { font-weight: 400; line-height: 1.22; margin: 2em 0 0.6em; text-wrap: balance; break-after: avoid; }
h2 { font-size: 1.5em; letter-spacing: -0.008em; }
h3 { font-size: 1.2em; font-style: italic; }
h4 { font-size: 1em; font-weight: 600; }
h5, h6 { font-family: ${SANS}; font-size: 0.72em; font-weight: 600; text-transform: uppercase; letter-spacing: 0.13em; }
a { color: ${ACCENT}; text-decoration: underline; text-decoration-thickness: 0.06em; text-underline-offset: 0.18em;
  text-decoration-color: rgba(43, 76, 126, 0.38); }
a:hover { text-decoration-color: currentColor; }
strong, b { font-weight: 600; }
blockquote { margin: 1.6em 0; padding: 0 0 0 1.25em; border-left: 1px solid ${ACCENT}; color: #2f3337; }
blockquote p:last-child { margin-bottom: 0; }
ul, ol { margin: 0 0 1em; padding-left: 1.35em; }
li { margin: 0.3em 0; padding-left: 0.25em; }
li > ul, li > ol { margin: 0.3em 0 0; }
li::marker { color: ${ACCENT}; }
code { font-family: ${MONO}; font-size: 0.8em; background: #f3f1ec; border-radius: 3px; padding: 0.1em 0.32em; }
pre { font-family: ${MONO}; font-size: 0.78em; line-height: 1.55; background: #f6f4ef; border-radius: 4px;
  padding: 1em 1.2em; margin: 1.5em 0; overflow-x: auto; white-space: pre; }
pre code { background: none; padding: 0; font-size: inherit; border-radius: 0; }
hr { border: 0; margin: 2.6em 0; height: auto; text-align: center; }
hr::before { content: "* * *"; letter-spacing: 0.6em; padding-left: 0.6em; color: ${ACCENT}; }
details.spoiler { margin: 1.6em 0; padding: 0.7em 1.1em; background: #f3f1ec; border-radius: 4px; }
details.spoiler > summary { cursor: pointer; font-family: ${SANS}; font-size: 0.66em; font-weight: 600; letter-spacing: 0.15em;
  text-transform: uppercase; color: #6b6f73; }
details.spoiler > summary:hover, details.spoiler > summary:focus-visible { color: ${ACCENT}; }
details.spoiler[open] > summary { margin-bottom: 1.1em; }
details.spoiler > :last-child { margin-bottom: 0; }
img { max-width: 100%; height: auto; }
figure.image { margin: 2em 0; text-align: center; }
figure.image img { display: block; margin: 0 auto; border-radius: 2px; }
figure.image figcaption { margin-top: 0.7em; font-size: 0.82em; font-style: italic; color: #6b6f73; text-wrap: balance; }
sup.footnote-ref { font-family: ${SANS}; font-size: 0.62em; font-weight: 600; line-height: 0; margin-left: 0.08em; }
sup.footnote-ref a, a.footnote-backref { text-decoration: none; }
section.footnotes { margin-top: 3em; padding-top: 1.2em; border-top: 1px solid #e4e1da; font-size: 0.86em; line-height: 1.5; color: #2f3337; }
section.footnotes li::marker { font-family: ${SANS}; font-size: 0.8em; font-weight: 600; }
.table-wrap { overflow-x: auto; margin: 1.6em 0; }
table { border-collapse: collapse; font-size: 0.86em; line-height: 1.45; font-variant-numeric: lining-nums tabular-nums; }
th, td { text-align: left; vertical-align: top; padding: 0.5em 1.1em 0.5em 0; border-bottom: 1px solid #e4e1da; }
th { font-weight: 600; border-bottom-color: ${INK}; }
::selection { background: rgba(43, 76, 126, 0.16); }
.titlepage { min-height: 62vh; display: flex; flex-direction: column; justify-content: center; margin-bottom: 9em; }
.book-title { font-size: 3.1em; font-weight: 300; line-height: 1.04; letter-spacing: -0.022em; margin: 0 0 0.45em;
  text-wrap: balance; }
.book-meta { font-family: ${SANS}; font-size: 0.66em; font-weight: 500; letter-spacing: 0.15em; text-transform: uppercase;
  color: #6b6f73; margin: 0 0 4.5em; font-variant-numeric: lining-nums; }
.contents h2 { font-family: ${SANS}; font-size: 0.66em; font-weight: 600; letter-spacing: 0.15em; text-transform: uppercase;
  color: #6b6f73; margin: 0 0 1.2em; }
.contents ol { list-style: none; padding: 0; margin: 0; counter-reset: toc; }
.contents li { counter-increment: toc; display: flex; gap: 1em; align-items: baseline; margin: 0.45em 0; padding: 0; }
.contents li::before { content: counter(toc, decimal-leading-zero); font-family: ${SANS}; font-size: 0.66em; color: ${ACCENT};
  letter-spacing: 0.06em; font-variant-numeric: lining-nums tabular-nums; }
.contents a { color: inherit; text-decoration: none; }
.contents a:hover { color: ${ACCENT}; }
@media (max-width: 640px) {
  body { font-size: 18px; }
  .book { padding: 4.5rem 1.25rem 6rem; }
  .post-title { font-size: 2.1em; }
  .book-title { font-size: 2.35em; }
  .titlepage { min-height: 0; margin-bottom: 6em; }
}
@media print {
  @page { margin: 20mm 18mm 22mm; }
  body { font-size: 11.5pt; }
  .book { max-width: 35em; padding: 0; }
  .titlepage { min-height: 0; padding-top: 30vh; margin: 0; break-after: page; }
  .post + .post { margin-top: 0; break-before: page; }
  .post + .post::before { display: none; }
  a { color: inherit; text-decoration: none; }
  p { orphans: 3; widows: 3; }
  blockquote, pre, table, h2, h3, h4, details, figure { break-inside: avoid; }
}
`;

function articleMarkup(p, i, multi, opts) {
  const title = p.title || 'Untitled';
  const body = serialize(bodyDom(p.body, multi ? 'fn' + (i + 1) : 'fn'), opts);
  const attrs = multi ? ' id="post-' + (i + 1) + '"' : '';
  return '<article class="post"' + attrs + '>\n<h1 class="post-title">' + escText(title) + '</h1>\n' + body + '\n</article>';
}

function titlePageMarkup(posts, bookTitle, opts) {
  const items = posts
    .map((p, i) => '<li><a href="' + (opts && opts.hrefFor ? opts.hrefFor(i) : '#post-' + (i + 1)) + '">' + escText(p.title || 'Untitled') + '</a></li>')
    .join('\n');
  return (
    '<header class="titlepage">\n<h1 class="book-title">' +
    escText(bookTitle) +
    '</h1>\n<p class="book-meta">' +
    escText(countLabel(posts.length) + ' · ' + formatDate(new Date())) +
    '</p>\n<nav class="contents" aria-label="Contents">\n<h2>Contents</h2>\n<ol>\n' +
    items +
    '\n</ol>\n</nav>\n</header>'
  );
}

function htmlDocument(posts, multi, bookTitle) {
  const opts = { wrapTables: true, lazy: true };
  const title = multi ? bookTitle : posts[0].title || 'Untitled';
  const parts = [];
  if (multi) parts.push(titlePageMarkup(posts, bookTitle));
  posts.forEach((p, i) => parts.push(articleMarkup(p, i, multi, opts)));
  return (
    '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta name="generator" content="Writehaven">\n<title>' +
    escText(title) +
    '</title>\n<style>' +
    EXPORT_CSS +
    '</style>\n</head>\n<body>\n<main class="book">\n' +
    parts.join('\n') +
    '\n</main>\n</body>\n</html>\n'
  );
}

// ---------------------------------------------------------------------------
// Export: .docx (Office Open XML, zipped with fflate)
// ---------------------------------------------------------------------------

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const WP_NS = 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PIC_NS = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const EMU_PER_PX = 9525; // at 96 dpi
const EMU_PER_TWIP = 635;
// Wide side margins: about 70 characters per line in 11.5 pt Georgia. Letter paper where it is the
// local standard (North America and a few others), A4 everywhere else.
const MARGIN_X = 1980;
function pageSize() {
  const lang = (typeof navigator !== 'undefined' && (navigator.language || '')) || '';
  const letter = /^(?:en-(?:US|CA|PH)|fr-CA|es-(?:US|MX|CL|CO|VE|PR|GT|CR))$/i.test(lang);
  return letter ? { w: 12240, h: 15840 } : { w: 11906, h: 16838 };
}
const DOCX_SERIF = 'Georgia';
const DOCX_MONO = 'Consolas';
const DOCX_BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'pre', 'hr', 'table', 'div', 'section']);

function fontsXml(name) {
  return '<w:rFonts w:ascii="' + name + '" w:hAnsi="' + name + '" w:eastAsia="' + name + '" w:cs="' + name + '"/>';
}

const SPOILER_BOX =
  '<w:pBdr><w:top w:val="single" w:sz="4" w:space="6" w:color="C9C4B8"/><w:left w:val="single" w:sz="4" w:space="8" w:color="C9C4B8"/>' +
  '<w:bottom w:val="single" w:sz="4" w:space="6" w:color="C9C4B8"/><w:right w:val="single" w:sz="4" w:space="8" w:color="C9C4B8"/></w:pBdr>';

const DOCX_STYLES =
  XML_HEAD +
  '<w:styles ' +
  W_NS +
  '>' +
  '<w:docDefaults><w:rPrDefault><w:rPr>' +
  fontsXml(DOCX_SERIF) +
  '<w:color w:val="1A1C1E"/><w:sz w:val="23"/><w:szCs w:val="23"/>' +
  '</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="170" w:line="348" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:widowControl/></w:pPr></w:style>' +
  '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>' +
  '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/>' +
  '<w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
  '<w:style w:type="numbering" w:default="1" w:styleId="NoList"><w:name w:val="No List"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="10"/><w:qFormat/>' +
  '<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="0" w:after="560" w:line="240" w:lineRule="auto"/><w:outlineLvl w:val="0"/></w:pPr>' +
  '<w:rPr><w:spacing w:val="-10"/><w:kern w:val="28"/><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="11"/><w:qFormat/>' +
  '<w:pPr><w:spacing w:after="1200"/></w:pPr><w:rPr>' +
  fontsXml('Arial') +
  '<w:caps/><w:color w:val="6B6F73"/><w:spacing w:val="30"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>' +
  '<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="480" w:after="160" w:line="264" w:lineRule="auto"/><w:outlineLvl w:val="1"/></w:pPr>' +
  '<w:rPr><w:sz w:val="34"/><w:szCs w:val="34"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:unhideWhenUsed/><w:qFormat/>' +
  '<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="400" w:after="120" w:line="276" w:lineRule="auto"/><w:outlineLvl w:val="2"/></w:pPr>' +
  '<w:rPr><w:i/><w:iCs/><w:sz w:val="27"/><w:szCs w:val="27"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:unhideWhenUsed/><w:qFormat/>' +
  '<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="320" w:after="100"/><w:outlineLvl w:val="3"/></w:pPr>' +
  '<w:rPr><w:b/><w:bCs/><w:sz w:val="23"/><w:szCs w:val="23"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="29"/><w:qFormat/>' +
  '<w:pPr><w:pBdr><w:left w:val="single" w:sz="6" w:space="14" w:color="2B4C7E"/></w:pBdr><w:spacing w:before="120" w:after="120"/><w:ind w:left="454" w:right="340"/></w:pPr>' +
  '<w:rPr><w:color w:val="33373B"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/>' +
  '<w:pPr><w:spacing w:after="80"/><w:ind w:left="720"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="39"/><w:qFormat/>' +
  '<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F6F4EF"/><w:spacing w:before="120" w:after="240" w:line="264" w:lineRule="auto"/><w:ind w:left="170" w:right="170"/></w:pPr>' +
  '<w:rPr>' +
  fontsXml(DOCX_MONO) +
  '<w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style>' +
  // Spoilers: a ruled box (consecutive paragraphs with the same borders share one) under a small-caps
  // "Spoiler" label. Paper can't hide them; the label warns the reader.
  '<w:style w:type="paragraph" w:styleId="SpoilerLabel"><w:name w:val="Spoiler Label"/><w:basedOn w:val="Normal"/><w:next w:val="Spoiler"/><w:uiPriority w:val="39"/>' +
  '<w:pPr><w:keepNext/>' + SPOILER_BOX + '<w:spacing w:before="240" w:after="80"/><w:ind w:left="284" w:right="284"/></w:pPr><w:rPr>' +
  fontsXml('Arial') +
  '<w:b/><w:bCs/><w:caps/><w:color w:val="6B6F73"/><w:spacing w:val="30"/><w:sz w:val="15"/><w:szCs w:val="15"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Spoiler"><w:name w:val="Spoiler"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="39"/><w:qFormat/>' +
  '<w:pPr>' + SPOILER_BOX + '<w:spacing w:after="120"/><w:ind w:left="284" w:right="284"/></w:pPr></w:style>' +
  // Images on their own line: centred, kept with their caption (the alt text, as on the public pages).
  '<w:style w:type="paragraph" w:styleId="Picture"><w:name w:val="Picture"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="39"/>' +
  '<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="PictureCaption"><w:name w:val="Picture Caption"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="39"/>' +
  '<w:pPr><w:spacing w:after="320"/><w:jc w:val="center"/></w:pPr><w:rPr><w:i/><w:iCs/><w:color w:val="6B6F73"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="SceneBreak"><w:name w:val="Scene Break"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="39"/>' +
  '<w:pPr><w:spacing w:before="360" w:after="360"/><w:jc w:val="center"/></w:pPr><w:rPr><w:color w:val="2B4C7E"/><w:spacing w:val="60"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="ContentsHeading"><w:name w:val="Contents Heading"/><w:basedOn w:val="Normal"/><w:next w:val="ContentsEntry"/><w:uiPriority w:val="39"/>' +
  '<w:pPr><w:keepNext/><w:spacing w:after="200"/></w:pPr><w:rPr>' +
  fontsXml('Arial') +
  '<w:b/><w:bCs/><w:caps/><w:color w:val="6B6F73"/><w:spacing w:val="30"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="ContentsEntry"><w:name w:val="Contents Entry"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="39"/>' +
  '<w:pPr><w:spacing w:after="100"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/>' +
  '<w:pPr><w:spacing w:after="0"/><w:jc w:val="center"/></w:pPr><w:rPr>' +
  fontsXml('Arial') +
  '<w:color w:val="6B6F73"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:style>' +
  '<w:style w:type="character" w:styleId="InlineCode"><w:name w:val="Inline Code"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="39"/><w:qFormat/>' +
  '<w:rPr>' +
  fontsXml(DOCX_MONO) +
  '<w:sz w:val="20"/><w:szCs w:val="20"/><w:shd w:val="clear" w:color="auto" w:fill="F3F1EC"/></w:rPr></w:style>' +
  '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/>' +
  '<w:rPr><w:color w:val="2B4C7E"/><w:u w:val="single"/></w:rPr></w:style>' +
  '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/>' +
  '<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>' +
  '<w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="D5D1C8"/><w:left w:val="single" w:sz="4" w:space="0" w:color="D5D1C8"/>' +
  '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="D5D1C8"/><w:right w:val="single" w:sz="4" w:space="0" w:color="D5D1C8"/>' +
  '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="D5D1C8"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="D5D1C8"/></w:tblBorders>' +
  '<w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
  '</w:styles>';

const DOCX_SETTINGS =
  XML_HEAD +
  '<w:settings ' +
  W_NS +
  '><w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/>' +
  '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>';

const DOCX_FOOTER =
  XML_HEAD +
  '<w:ftr ' +
  W_NS +
  '><w:p><w:pPr><w:pStyle w:val="Footer"/></w:pPr>' +
  '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>' +
  '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>';

// [Content_Types].xml, with a Default for each image format embedded.
function docxContentTypes(media) {
  const exts = new Map();
  for (const m of media) exts.set(m.data.ext, m.data.mime);
  let defaults = '';
  for (const [ext, mime] of exts) defaults += '<Default Extension="' + ext + '" ContentType="' + mime + '"/>';
  return DOCX_CONTENT_TYPES.replace('<Default Extension="xml" ContentType="application/xml"/>', '$&' + defaults);
}

const DOCX_CONTENT_TYPES =
  XML_HEAD +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
  '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
  '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' +
  '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
  '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
  '</Types>';

const DOCX_ROOT_RELS =
  XML_HEAD +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
  '</Relationships>';

const DOCX_APP =
  XML_HEAD +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
  'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Writehaven</Application></Properties>';

function w3cdtf(d) {
  return d.toISOString().replace(/\.\d+Z$/, 'Z');
}

function listIndent(ilvl) {
  return 720 + 360 * ilvl;
}

function quoteIndent(depth) {
  return 454 * depth;
}

// The size of an image in the document: its pixels at 96 dpi, never wider than the text column or
// taller than a page (aspect ratio kept).
function docxExtent(w, h) {
  const size = pageSize();
  const maxW = (size.w - 2 * MARGIN_X) * EMU_PER_TWIP;
  const maxH = (size.h - 1531 - 1588 - 1400) * EMU_PER_TWIP;
  const k = Math.min(1, maxW / (w * EMU_PER_PX), maxH / (h * EMU_PER_PX));
  return { cx: Math.max(1, Math.round(w * EMU_PER_PX * k)), cy: Math.max(1, Math.round(h * EMU_PER_PX * k)) };
}

class DocxWriter {
  constructor(images) {
    this.parts = [];
    this.links = new Map();
    this.lists = [];
    this.lastWasTable = false;
    this.images = images || new Map(); // path -> loaded image (see loadUploads)
    this.media = []; // [{ rid, name, data }] -> word/media/<name>
    this.mediaByPath = new Map();
    this.picId = 0;
  }

  // An uploaded image as an inline drawing (a link to it when it couldn't be embedded).
  picture(img) {
    const path = img.getAttribute('src');
    const alt = img.getAttribute('alt') || '';
    const data = this.images.get(path);
    if (!data) return this.run({ text: alt ? '[image: ' + alt + ']' : '[image]', f: {} });
    let m = this.mediaByPath.get(path);
    if (!m) {
      const n = this.media.length + 1;
      m = { rid: 'rIdImg' + n, name: 'image' + n + '.' + data.ext, data };
      this.media.push(m);
      this.mediaByPath.set(path, m);
    }
    const id = ++this.picId;
    const { cx, cy } = docxExtent(data.width, data.height);
    const descr = escAttr(alt);
    return (
      '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">' +
      '<wp:extent cx="' + cx + '" cy="' + cy + '"/><wp:effectExtent l="0" t="0" r="0" b="0"/>' +
      '<wp:docPr id="' + id + '" name="Picture ' + id + '" descr="' + descr + '"/>' +
      '<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="' + A_NS + '" noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
      '<a:graphic xmlns:a="' + A_NS + '"><a:graphicData uri="' + PIC_NS + '"><pic:pic xmlns:pic="' + PIC_NS + '">' +
      '<pic:nvPicPr><pic:cNvPr id="' + id + '" name="' + m.name + '" descr="' + descr + '"/><pic:cNvPicPr><a:picLocks noChangeAspect="1"/></pic:cNvPicPr></pic:nvPicPr>' +
      '<pic:blipFill><a:blip r:embed="' + m.rid + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
      '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
      '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'
    );
  }

  // An image on its own line: centred, captioned with its alt text.
  figure(img) {
    this.p(this.picture(img), { style: 'Picture' });
    const alt = img.getAttribute('alt');
    if (alt && this.images.get(img.getAttribute('src'))) this.p(this.textRuns(alt, {}), { style: 'PictureCaption' });
  }

  rel(url) {
    if (!this.links.has(url)) this.links.set(url, 'rIdL' + (this.links.size + 1));
    return this.links.get(url);
  }

  newList(ordered, start) {
    this.lists.push({ ordered, start });
    return this.lists.length;
  }

  p(inner, o) {
    o = o || {};
    let pp = '';
    if (o.style) pp += '<w:pStyle w:val="' + o.style + '"/>';
    if (o.keepNext) pp += '<w:keepNext/>';
    if (o.pageBreakBefore) pp += '<w:pageBreakBefore/>';
    if (o.numId) pp += '<w:numPr><w:ilvl w:val="' + (o.ilvl || 0) + '"/><w:numId w:val="' + o.numId + '"/></w:numPr>';
    if (o.spacing) pp += o.spacing;
    if (o.indLeft != null) pp += '<w:ind w:left="' + o.indLeft + '"/>';
    if (o.jc) pp += '<w:jc w:val="' + o.jc + '"/>';
    this.parts.push('<w:p>' + (pp ? '<w:pPr>' + pp + '</w:pPr>' : '') + inner + '</w:p>');
    this.lastWasTable = false;
  }

  // Inline content of a DOM node -> runs (and hyperlinks).
  inline(nodes, base) {
    const segs = [];
    const rec = (node, f) => {
      if (node.nodeType === 3) {
        segs.push({ text: node.data, f });
        return;
      }
      if (node.nodeType !== 1) return;
      const t = node.localName;
      if (t === 'br') {
        segs.push({ br: true, f });
        return;
      }
      if (t === 'img') {
        segs.push({ img: node, f });
        return;
      }
      if (t === 'a' && node.getAttribute('class') === 'footnote-backref') return;
      let nf = f;
      if (t === 'sup') nf = Object.assign({}, f, { sup: true });
      else if (t === 'strong' || t === 'b') nf = Object.assign({}, f, { b: true });
      else if (t === 'em' || t === 'i') nf = Object.assign({}, f, { i: true });
      else if (t === 'del' || t === 's') nf = Object.assign({}, f, { s: true });
      else if (t === 'code') nf = Object.assign({}, f, { code: true });
      else if (t === 'a' && !f.link) {
        const href = node.getAttribute('href');
        if (href && href[0] !== '#') nf = Object.assign({}, f, { link: href });
      }
      for (let c = node.firstChild; c; c = c.nextSibling) rec(c, nf);
    };
    for (const n of nodes) rec(n, base || {});
    // Collapse whitespace like HTML and trim the paragraph edges.
    let prevSpace = true;
    for (const s of segs) {
      if (s.br) {
        prevSpace = true;
        continue;
      }
      if (s.img) {
        prevSpace = false;
        continue;
      }
      if (s.f.code) {
        s.text = s.text.replace(/\n/g, ' ');
        prevSpace = / $/.test(s.text);
        continue;
      }
      let t = s.text.replace(/[ \t\n\r\f]+/g, ' ');
      if (prevSpace) t = t.replace(/^ /, '');
      s.text = t;
      if (t) prevSpace = / $/.test(t);
    }
    for (let i = segs.length - 1; i >= 0; i--) {
      const s = segs[i];
      if (s.br || s.img) break;
      s.text = s.text.replace(/ +$/, '');
      if (s.text) break;
    }
    let out = '';
    let i = 0;
    while (i < segs.length) {
      const link = segs[i].f.link;
      if (link) {
        let runs = '';
        while (i < segs.length && segs[i].f.link === link) runs += this.run(segs[i++]);
        if (runs) out += '<w:hyperlink r:id="' + this.rel(link) + '" w:history="1">' + runs + '</w:hyperlink>';
      } else out += this.run(segs[i++]);
    }
    return out;
  }

  run(seg) {
    if (seg.img) return this.picture(seg.img);
    const f = seg.f;
    let rp = '';
    if (f.link) rp += '<w:rStyle w:val="Hyperlink"/>' + (f.code ? fontsXml(DOCX_MONO) : '');
    else if (f.code) rp += '<w:rStyle w:val="InlineCode"/>';
    if (f.b) rp += '<w:b/><w:bCs/>';
    if (f.i) rp += '<w:i/><w:iCs/>';
    if (f.s) rp += '<w:strike/>';
    if (f.color) rp += '<w:color w:val="' + f.color + '"/>';
    if (f.sup) rp += '<w:vertAlign w:val="superscript"/>';
    const rPr = rp ? '<w:rPr>' + rp + '</w:rPr>' : '';
    if (seg.br) return '<w:r>' + rPr + '<w:br/></w:r>';
    const text = xmlSafe(seg.text);
    if (!text) return '';
    let body = '';
    text.split('\t').forEach((part, k) => {
      if (k) body += '<w:tab/>';
      if (part) body += '<w:t xml:space="preserve">' + escText(part) + '</w:t>';
    });
    return '<w:r>' + rPr + body + '</w:r>';
  }

  textRuns(text, f) {
    return this.run({ text, f: f || {} });
  }

  blocks(container, ctx) {
    let pending = [];
    const flush = () => {
      if (!pending.length) return;
      const x = this.inline(pending, {});
      pending = [];
      if (x) this.p(x, this.paraOpts(ctx));
    };
    for (let c = container.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) {
        if (pending.length || /\S/.test(c.data)) pending.push(c);
        continue;
      }
      if (c.nodeType !== 1) continue;
      if (!DOCX_BLOCKS.has(c.localName)) {
        pending.push(c);
        continue;
      }
      flush();
      this.block(c, ctx);
    }
    flush();
  }

  paraOpts(ctx) {
    if (ctx.quote) return { style: 'Quote', indLeft: quoteIndent(ctx.quote) + (ctx.listInd || 0) };
    if (ctx.listInd != null) return { style: 'ListParagraph', indLeft: ctx.listInd };
    if (ctx.spoiler) return { style: 'Spoiler' };
    return {};
  }

  // A spoiler: the label, then its blocks in the Spoiler style, then a little air below the box.
  spoiler(el, ctx) {
    this.p(this.textRuns('Spoiler', {}), { style: 'SpoilerLabel' });
    this.blocks(el, Object.assign({}, ctx, { spoiler: true }));
    this.p('', { spacing: '<w:spacing w:after="0" w:line="160" w:lineRule="exact"/>' });
  }

  block(el, ctx) {
    const t = el.localName;
    const hm = HEADING_RE.exec(t);
    if (hm) {
      // The body's top heading level becomes Heading 1 (the post title uses the Title style).
      const lvl = Math.max(1, Math.min(3, +hm[1] - (ctx.headingBase || 1) + 1));
      const x = this.inline([el], {});
      if (x) this.p(x, { style: 'Heading' + lvl });
      return;
    }
    switch (t) {
      case 'p': {
        const img = soleImage(el);
        if (img && !ctx.quote && ctx.listInd == null && !ctx.spoiler) {
          this.figure(img);
          return;
        }
        const x = this.inline([el], {});
        if (x) this.p(x, this.paraOpts(ctx));
        return;
      }
      case 'blockquote':
        this.blocks(el, Object.assign({}, ctx, { quote: (ctx.quote || 0) + 1 }));
        return;
      case 'ul':
      case 'ol':
        this.list(el, ctx, ctx.ilvl || 0);
        return;
      case 'pre': {
        const lines = (el.textContent || '').replace(/\n$/, '').split('\n');
        let x = '';
        lines.forEach((line, k) => {
          if (k) x += '<w:r><w:br/></w:r>';
          if (line) x += this.textRuns(line, {});
        });
        const o = { style: 'CodeBlock' };
        const ind = (ctx.quote ? quoteIndent(ctx.quote) : 0) + (ctx.listInd || 0);
        if (ind) o.indLeft = ind;
        this.p(x, o);
        return;
      }
      case 'hr':
        this.p(this.textRuns('*   *   *', {}), { style: 'SceneBreak' });
        return;
      case 'table':
        this.table(el);
        return;
      case 'div':
        if (isSpoilerEl(el)) this.spoiler(el, ctx);
        else this.blocks(el, ctx);
        return;
      default:
        this.blocks(el, ctx);
    }
  }

  list(el, ctx, ilvl) {
    const ordered = el.localName === 'ol';
    let start = parseInt(el.getAttribute('start'), 10);
    if (!(start >= 0)) start = 1;
    const numId = this.newList(ordered, start);
    for (const li of el.children) {
      if (li.localName !== 'li') continue;
      let first = true;
      let pending = [];
      const emit = (x) => {
        const o = { style: 'ListParagraph' };
        if (first) {
          o.numId = numId;
          o.ilvl = ilvl;
        } else o.indLeft = listIndent(ilvl);
        if (ctx.quote) o.indLeft = (o.indLeft || listIndent(ilvl)) + quoteIndent(ctx.quote);
        this.p(x, o);
        first = false;
      };
      const flush = () => {
        if (!pending.length) return;
        const x = this.inline(pending, {});
        pending = [];
        if (x) emit(x);
      };
      for (let c = li.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) {
          if (pending.length || /\S/.test(c.data)) pending.push(c);
          continue;
        }
        if (c.nodeType !== 1) continue;
        const t = c.localName;
        if (!DOCX_BLOCKS.has(t)) {
          pending.push(c);
          continue;
        }
        flush();
        if (t === 'p') {
          const x = this.inline([c], {});
          if (x) emit(x);
        } else if (t === 'ul' || t === 'ol') {
          if (first) emit('');
          this.list(c, ctx, Math.min(ilvl + 1, 8));
        } else {
          if (first) emit('');
          this.block(c, Object.assign({}, ctx, { listInd: listIndent(ilvl), ilvl: Math.min(ilvl + 1, 8) }));
        }
      }
      flush();
      if (first) emit('');
    }
  }

  table(el) {
    const rows = Array.from(el.querySelectorAll('tr'));
    if (!rows.length) return;
    let ncols = 1;
    for (const tr of rows) {
      let n = 0;
      for (const td of tr.children) n += Math.max(1, parseInt(td.getAttribute('colspan'), 10) || 1);
      ncols = Math.max(ncols, n);
    }
    const colW = Math.floor((pageSize().w - 2 * MARGIN_X) / ncols);
    let x =
      '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/>' +
      '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>';
    for (let i = 0; i < ncols; i++) x += '<w:gridCol w:w="' + colW + '"/>';
    x += '</w:tblGrid>';
    rows.forEach((tr, ri) => {
      const isHead = tr.parentNode && tr.parentNode.localName === 'thead';
      x += '<w:tr>' + (isHead ? '<w:trPr><w:tblHeader/></w:trPr>' : '');
      let used = 0;
      for (const td of tr.children) {
        const span = Math.max(1, parseInt(td.getAttribute('colspan'), 10) || 1);
        used += span;
        const header = td.localName === 'th' || (isHead && ri === 0);
        const align = td.getAttribute('align');
        const inner = this.cellInline(td, header);
        x +=
          '<w:tc><w:tcPr><w:tcW w:w="' + colW * span + '" w:type="dxa"/>' + (span > 1 ? '<w:gridSpan w:val="' + span + '"/>' : '') +
          '</w:tcPr><w:p><w:pPr><w:spacing w:before="20" w:after="20"/>' +
          (align === 'center' || align === 'right' ? '<w:jc w:val="' + align + '"/>' : '') +
          '</w:pPr>' + inner + '</w:p></w:tc>';
      }
      for (; used < ncols; used++) x += '<w:tc><w:tcPr><w:tcW w:w="' + colW + '" w:type="dxa"/></w:tcPr><w:p/></w:tc>';
      x += '</w:tr>';
    });
    x += '</w:tbl>';
    this.parts.push(x);
    // Word needs a paragraph between two tables and before the end of the body.
    this.p('', { spacing: '<w:spacing w:after="120"/>' });
    this.lastWasTable = true;
  }

  cellInline(td, header) {
    return this.inline([td], header ? { b: true } : {});
  }

  numberingXml() {
    let abs = '';
    let nums = '';
    this.lists.forEach((l, k) => {
      const id = k + 1;
      abs += '<w:abstractNum w:abstractNumId="' + id + '"><w:multiLevelType w:val="hybridMultilevel"/>';
      for (let lvl = 0; lvl < 9; lvl++) {
        const ind = '<w:pPr><w:ind w:left="' + listIndent(lvl) + '" w:hanging="360"/></w:pPr>';
        if (l.ordered) {
          abs +=
            '<w:lvl w:ilvl="' + lvl + '"><w:start w:val="' + (lvl === 0 ? l.start : 1) + '"/><w:numFmt w:val="decimal"/>' +
            '<w:lvlText w:val="%' + (lvl + 1) + '."/><w:lvlJc w:val="left"/>' + ind + '</w:lvl>';
        } else {
          abs +=
            '<w:lvl w:ilvl="' + lvl + '"><w:start w:val="1"/><w:numFmt w:val="bullet"/>' +
            '<w:lvlText w:val="' + (lvl % 2 ? '–' : '•') + '"/><w:lvlJc w:val="left"/>' + ind +
            '<w:rPr><w:color w:val="2B4C7E"/></w:rPr></w:lvl>';
        }
      }
      abs += '</w:abstractNum>';
      nums += '<w:num w:numId="' + id + '"><w:abstractNumId w:val="' + id + '"/></w:num>';
    });
    return XML_HEAD + '<w:numbering ' + W_NS + '>' + abs + nums + '</w:numbering>';
  }

  documentXml() {
    if (!this.parts.length || this.lastWasTable) this.p('');
    return (
      XML_HEAD +
      '<w:document ' + W_NS + ' ' + WP_NS + '><w:body>' + this.parts.join('') +
      '<w:sectPr><w:footerReference w:type="default" r:id="rIdFtr1"/>' +
      '<w:pgSz w:w="' + pageSize().w + '" w:h="' + pageSize().h + '"/>' +
      '<w:pgMar w:top="1531" w:right="' + MARGIN_X + '" w:bottom="1588" w:left="' + MARGIN_X + '" w:header="709" w:footer="760" w:gutter="0"/>' +
      '<w:cols w:space="708"/><w:titlePg/></w:sectPr></w:body></w:document>'
    );
  }

  relsXml() {
    let x =
      XML_HEAD +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '<Relationship Id="rIdNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' +
      '<Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>' +
      '<Relationship Id="rIdFtr1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>';
    for (const [url, id] of this.links) {
      x +=
        '<Relationship Id="' + id + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="' +
        escAttr(url) + '" TargetMode="External"/>';
    }
    for (const m of this.media) {
      x += '<Relationship Id="' + m.rid + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/' + m.name + '"/>';
    }
    return x + '</Relationships>';
  }
}

// images: Map(path -> loaded image) from loadUploads (uploaded images are embedded).
function docxBytes(posts, multi, bookTitle, images) {
  const D = new DocxWriter(images);
  if (multi) {
    D.p('', { spacing: '<w:spacing w:before="2600" w:after="0"/>' });
    D.p(D.textRuns(bookTitle, {}), { style: 'Title' });
    D.p(D.textRuns(countLabel(posts.length) + ' · ' + formatDate(new Date()), {}), { style: 'Subtitle' });
    D.p(D.textRuns('Contents', {}), { style: 'ContentsHeading' });
    for (const p of posts) D.p(D.textRuns(p.title || 'Untitled', {}), { style: 'ContentsEntry' });
  }
  posts.forEach((p) => {
    D.p(D.textRuns(p.title || 'Untitled', {}), { style: 'Title', pageBreakBefore: multi });
    const root = renderSafe(p.body);
    const top = topHeadingLevel(root);
    D.blocks(root, { headingBase: top < 7 ? top : 1 });
  });
  const now = new Date();
  const title = multi ? bookTitle : posts[0].title || 'Untitled';
  const core =
    XML_HEAD +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    '<dc:title>' + escText(title) + '</dc:title>' +
    '<dcterms:created xsi:type="dcterms:W3CDTF">' + w3cdtf(now) + '</dcterms:created>' +
    '<dcterms:modified xsi:type="dcterms:W3CDTF">' + w3cdtf(now) + '</dcterms:modified>' +
    '</cp:coreProperties>';
  const documentXml = D.documentXml();
  const files = {
    '[Content_Types].xml': docxContentTypes(D.media),
    '_rels/.rels': DOCX_ROOT_RELS,
    'docProps/core.xml': core,
    'docProps/app.xml': DOCX_APP,
    'word/document.xml': documentXml,
    'word/styles.xml': DOCX_STYLES,
    'word/numbering.xml': D.numberingXml(),
    'word/settings.xml': DOCX_SETTINGS,
    'word/footer1.xml': DOCX_FOOTER,
    'word/_rels/document.xml.rels': D.relsXml(),
  };
  const entries = {};
  for (const k of Object.keys(files)) entries[k] = strToU8(files[k]);
  // Images are compressed already: stored as they are.
  for (const m of D.media) entries['word/media/' + m.name] = [m.data.bytes, { level: 0 }];
  return zipSync(entries, { level: 6 });
}

// ---------------------------------------------------------------------------
// Export: .epub (EPUB 3 with an EPUB 2 NCX for older readers)
// ---------------------------------------------------------------------------

const EPUB_CSS = `
html { color: ${INK}; }
body { font-family: ${SERIF}; line-height: 1.55; margin: 0 5%; font-variant-numeric: oldstyle-nums; hanging-punctuation: first; }
.post-title { font-size: 2.1em; font-weight: 300; line-height: 1.1; letter-spacing: -0.01em; margin: 2.5em 0 1.2em; }
p { margin: 0 0 0.9em; }
h2, h3, h4, h5, h6 { font-weight: 400; line-height: 1.25; margin: 1.8em 0 0.6em; page-break-after: avoid; break-after: avoid; }
h2 { font-size: 1.4em; } h3 { font-size: 1.18em; font-style: italic; } h4 { font-size: 1em; font-weight: 600; }
h5, h6 { font-family: ${SANS}; font-size: 0.75em; font-weight: 600; text-transform: uppercase; letter-spacing: 0.12em; }
a { color: ${ACCENT}; }
blockquote { margin: 1.4em 0 1.4em 0.4em; padding: 0 0 0 1.1em; border-left: 1px solid ${ACCENT}; }
ul, ol { margin: 0 0 1em; padding-left: 1.4em; }
li { margin: 0.25em 0; }
li > ul, li > ol { margin: 0.25em 0 0; }
li::marker { color: ${ACCENT}; }
code { font-family: ${MONO}; font-size: 0.82em; }
pre { font-family: ${MONO}; font-size: 0.8em; line-height: 1.5; white-space: pre-wrap; margin: 1.3em 0; padding: 0.8em 1em; background: #f6f4ef; }
pre code { font-size: inherit; }
hr { border: 0; margin: 2em 0; text-align: center; }
hr::before { content: "* * *"; letter-spacing: 0.5em; color: ${ACCENT}; }
details.spoiler { margin: 1.4em 0; padding: 0.6em 1em; background: #f3f1ec; }
details.spoiler > summary { font-family: ${SANS}; font-size: 0.75em; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: #6b6f73; }
details.spoiler[open] > summary { margin-bottom: 0.8em; }
img { max-width: 100%; height: auto; }
figure.image { margin: 1.6em 0; text-align: center; page-break-inside: avoid; break-inside: avoid; }
figure.image img { display: block; margin: 0 auto; }
figure.image figcaption { margin-top: 0.5em; font-size: 0.85em; font-style: italic; color: #6b6f73; }
table { border-collapse: collapse; margin: 1.4em 0; font-size: 0.88em; }
th, td { text-align: left; vertical-align: top; padding: 0.35em 0.8em 0.35em 0; border-bottom: 1px solid #ddd8ce; }
th { font-weight: 600; border-bottom-color: ${INK}; }
.titlepage { margin-top: 30%; }
.book-title { font-size: 2.4em; font-weight: 300; line-height: 1.08; letter-spacing: -0.015em; margin: 0 0 0.6em; }
.book-meta { font-family: ${SANS}; font-size: 0.7em; letter-spacing: 0.14em; text-transform: uppercase; color: #6b6f73; }
nav ol { list-style: none; padding: 0; }
nav li { margin: 0.5em 0; }
nav a { color: inherit; text-decoration: none; }
`;

function xhtmlPage(title, body) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n' +
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en">\n' +
    '<head>\n<meta charset="utf-8" />\n<title>' + escText(title) + '</title>\n' +
    '<link rel="stylesheet" type="text/css" href="style.css" />\n</head>\n<body>\n' + body + '\n</body>\n</html>\n'
  );
}

function uuid() {
  if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
}

// images: Map(path -> loaded image) from loadUploads (uploaded images are embedded).
function epubBytes(posts, bookTitle, images) {
  const id = 'urn:uuid:' + uuid();
  const modified = w3cdtf(new Date());
  const files = {};
  files.mimetype = [strToU8('application/epub+zip'), { level: 0 }];
  files['META-INF/container.xml'] = strToU8(
    '<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
      '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>\n',
  );
  files['OEBPS/style.css'] = strToU8(EPUB_CSS);
  const chapterFile = (i) => 'post-' + (i + 1) + '.xhtml';
  const titleBody =
    '<section class="titlepage" epub:type="titlepage">\n<h1 class="book-title">' + escText(bookTitle) + '</h1>\n' +
    '<p class="book-meta">' + escText(countLabel(posts.length) + ' · ' + formatDate(new Date())) + '</p>\n</section>';
  files['OEBPS/title.xhtml'] = strToU8(xhtmlPage(bookTitle, titleBody));
  const media = []; // [{ id, href, data }] -> OEBPS/<href>
  const mediaByPath = new Map();
  const img = (path) => {
    const data = images && images.get(path);
    if (!data) return null;
    let m = mediaByPath.get(path);
    if (!m) {
      const n = media.length + 1;
      m = { id: 'img-' + n, href: 'images/img-' + n + '.' + data.ext, data };
      media.push(m);
      mediaByPath.set(path, m);
    }
    return { src: m.href, width: data.width, height: data.height };
  };
  posts.forEach((p, i) => {
    const t = p.title || 'Untitled';
    const body =
      '<section epub:type="chapter" class="post" id="post-' + (i + 1) + '">\n<h1 class="post-title">' + escText(t) + '</h1>\n' +
      serialize(bodyDom(p.body), { xhtml: true, img }) + '\n</section>';
    files['OEBPS/' + chapterFile(i)] = strToU8(xhtmlPage(t, body));
  });
  const navItems = posts.map((p, i) => '<li><a href="' + chapterFile(i) + '">' + escText(p.title || 'Untitled') + '</a></li>').join('\n');
  files['OEBPS/nav.xhtml'] = strToU8(
    xhtmlPage('Contents', '<nav epub:type="toc" id="toc">\n<h1>Contents</h1>\n<ol>\n' + navItems + '\n</ol>\n</nav>'),
  );
  const ncxPoints = posts
    .map(
      (p, i) =>
        '<navPoint id="np-' + (i + 1) + '" playOrder="' + (i + 1) + '"><navLabel><text>' + escText(p.title || 'Untitled') +
        '</text></navLabel><content src="' + chapterFile(i) + '"/></navPoint>',
    )
    .join('\n');
  files['OEBPS/toc.ncx'] = strToU8(
    '<?xml version="1.0" encoding="UTF-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n' +
      '<head><meta name="dtb:uid" content="' + escAttr(id) + '"/><meta name="dtb:depth" content="1"/>' +
      '<meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>\n' +
      '<docTitle><text>' + escText(bookTitle) + '</text></docTitle>\n<navMap>\n' + ncxPoints + '\n</navMap>\n</ncx>\n',
  );
  for (const m of media) files['OEBPS/' + m.href] = [m.data.bytes, { level: 0 }];
  const manifest = posts
    .map((p, i) => '<item id="post-' + (i + 1) + '" href="' + chapterFile(i) + '" media-type="application/xhtml+xml"/>')
    .concat(media.map((m) => '<item id="' + m.id + '" href="' + m.href + '" media-type="' + m.data.mime + '"/>'))
    .join('\n');
  const spine = posts.map((p, i) => '<itemref idref="post-' + (i + 1) + '"/>').join('\n');
  files['OEBPS/content.opf'] = strToU8(
    '<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="en">\n' +
      '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n<dc:identifier id="bookid">' + escText(id) + '</dc:identifier>\n' +
      '<dc:title>' + escText(bookTitle) + '</dc:title>\n<dc:language>en</dc:language>\n' +
      '<meta property="dcterms:modified">' + modified + '</meta>\n</metadata>\n<manifest>\n' +
      '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n' +
      '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n' +
      '<item id="css" href="style.css" media-type="text/css"/>\n' +
      '<item id="titlepage" href="title.xhtml" media-type="application/xhtml+xml"/>\n' + manifest +
      '\n</manifest>\n<spine toc="ncx">\n<itemref idref="titlepage"/>\n' + spine + '\n</spine>\n</package>\n',
  );
  return zipSync(files, { level: 6 });
}

// ---------------------------------------------------------------------------
// Export: PDF via a print view
// ---------------------------------------------------------------------------

let printState = null;

function ensurePrintCss() {
  if (document.querySelector('link[rel~="stylesheet"][href*="/css/print.css"]')) return Promise.resolve();
  return new Promise((resolve) => {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = PRINT_CSS_HREF;
    l.media = 'print';
    l.onload = () => resolve();
    l.onerror = () => resolve();
    document.head.appendChild(l);
    setTimeout(resolve, 3000);
  });
}

function loadPrintFonts() {
  if (!document.fonts || typeof document.fonts.load !== 'function') return Promise.resolve();
  const specs = [
    '300 16px Newsreader', '400 16px Newsreader', '600 16px Newsreader', 'italic 400 16px Newsreader',
    'italic 600 16px Newsreader', '500 16px "Instrument Sans"',
  ];
  return Promise.race([Promise.all(specs.map((s) => document.fonts.load(s).catch(() => null))), delay(2500)]);
}

function endPrint(state) {
  const s = state || printState;
  if (!s || s.done) return;
  s.done = true;
  s.root.remove();
  document.documentElement.classList.remove('wh-printing');
  document.title = s.prevTitle;
  window.removeEventListener('afterprint', s.finish);
  if (s.onInteract) {
    window.removeEventListener('pointerdown', s.onInteract, true);
    window.removeEventListener('keydown', s.onInteract, true);
  }
  if (printState === s) printState = null;
}

// The print view lives in the app page: images load from this site; print.css knows nothing of
// figures, so they carry their own styles.
const PRINT_OPTS = {
  spoiler: 'box',
  img: (path, el) => ({ src: path, width: el.getAttribute('width'), height: el.getAttribute('height') }),
  imgStyle: 'max-width:100%;height:auto;max-height:190mm;',
  figureStyle: 'margin:1.4em 0;text-align:center;break-inside:avoid;page-break-inside:avoid;',
  captionStyle: 'margin-top:0.5em;font-size:9pt;font-style:italic;color:#6b6f73;',
};

function printMarkup(posts, multi, bookTitle) {
  const parts = [];
  if (multi) parts.push(titlePageMarkup(posts, bookTitle, { hrefFor: (i) => '#wh-post-' + (i + 1) }));
  posts.forEach((p, i) => {
    parts.push(
      '<article class="post" id="wh-post-' + (i + 1) + '">\n<h1 class="post-title">' + escText(p.title || 'Untitled') + '</h1>\n' +
        serialize(bodyDom(p.body, multi ? 'fn' + (i + 1) : 'fn'), PRINT_OPTS) + '\n</article>',
    );
  });
  return '<div class="wh-doc">\n' + parts.join('\n') + '\n</div>';
}

// Images in the print view must be loaded before the print dialog takes its snapshot.
function loadPrintImages(root) {
  const imgs = Array.from(root.querySelectorAll('img'));
  if (!imgs.length) return Promise.resolve();
  const each = imgs.map((im) => (typeof im.decode === 'function' ? im.decode() : Promise.resolve()).catch(() => null));
  return Promise.race([Promise.all(each), delay(8000)]);
}

async function printView(posts, multi, bookTitle) {
  endPrint();
  await ensurePrintCss();
  const root = document.createElement('div');
  root.id = 'wh-print';
  root.className = multi ? 'wh-print wh-print-multi' : 'wh-print';
  root.setAttribute('aria-hidden', 'true');
  root.style.display = 'none';
  root.innerHTML = printMarkup(posts, multi, bookTitle);
  document.body.appendChild(root);
  document.documentElement.classList.add('wh-printing');
  const state = { root, prevTitle: document.title, done: false, finish: null, onInteract: null };
  state.finish = () => endPrint(state);
  printState = state;
  // The browser suggests the document title as the PDF file name.
  document.title = multi ? bookTitle : posts[0].title || 'Untitled';
  await Promise.all([loadPrintFonts(), loadPrintImages(root)]);
  if (state.done) return;
  window.addEventListener('afterprint', state.finish);
  try {
    window.print();
  } catch (err) {
    endPrint(state);
    throw new Error("Printing isn't available in this browser.");
  }
  // Some mobile browsers never fire afterprint: clean up on the next interaction instead.
  setTimeout(() => {
    if (state.done) return;
    state.onInteract = () => endPrint(state);
    window.addEventListener('pointerdown', state.onInteract, true);
    window.addEventListener('keydown', state.onInteract, true);
  }, 1000);
}

// ---------------------------------------------------------------------------
// Export: public API
// ---------------------------------------------------------------------------

export async function exportPost(post, format) {
  const p = normPost(post);
  const name = slugify(p.title, 'untitled');
  switch (format) {
    case 'md':
      download(name + '.md', postMarkdown(p), 'text/markdown;charset=utf-8');
      return;
    case 'txt':
      download(name + '.txt', postText(p, '=') + '\n', 'text/plain;charset=utf-8');
      return;
    case 'html':
      download(name + '.html', htmlDocument([p], false), 'text/html;charset=utf-8');
      return;
    case 'docx': {
      const images = await loadUploads([p]);
      download(name + '.docx', new Blob([docxBytes([p], false, '', images)], { type: DOCX_MIME }), DOCX_MIME);
      return;
    }
    case 'pdf':
      await printView([p], false);
      return;
    default:
      throw new Error("Can't export as " + format + ': choose Markdown, plain text, HTML, Word or PDF.');
  }
}

export async function exportAll(posts, format, bookTitle) {
  const list = (Array.isArray(posts) ? posts : []).filter(Boolean).map(normPost);
  if (!list.length) throw new Error('There are no posts to export yet.');
  const book = cleanTitle(bookTitle) || 'Writehaven';
  const name = slugify(book, 'writehaven-posts');
  switch (format) {
    case 'md': {
      const parts = ['# ' + book];
      for (const p of list) {
        const body = absoluteUploads(p.body.replace(/\s+$/, ''));
        parts.push('# ' + (p.title || 'Untitled') + (body ? '\n\n' + body : ''));
      }
      download(name + '.md', parts.join('\n\n---\n\n') + '\n', 'text/markdown;charset=utf-8');
      return;
    }
    case 'txt': {
      const parts = [underline(book, '=')];
      for (const p of list) parts.push(postText({ title: p.title || 'Untitled', body: p.body }, '-'));
      download(name + '.txt', parts.join('\n\n\n') + '\n', 'text/plain;charset=utf-8');
      return;
    }
    case 'html':
      download(name + '.html', htmlDocument(list, true, book), 'text/html;charset=utf-8');
      return;
    case 'docx': {
      const images = await loadUploads(list);
      download(name + '.docx', new Blob([docxBytes(list, true, book, images)], { type: DOCX_MIME }), DOCX_MIME);
      return;
    }
    case 'epub': {
      const images = await loadUploads(list);
      download(name + '.epub', new Blob([epubBytes(list, book, images)], { type: 'application/epub+zip' }), 'application/epub+zip');
      return;
    }
    case 'pdf':
      await printView(list, true, book);
      return;
    default:
      throw new Error("Can't export as " + format + ': choose Markdown, plain text, HTML, Word, PDF or EPUB.');
  }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

const IMPORT_KINDS = { md: 'md', markdown: 'md', mdown: 'md', mkd: 'md', txt: 'txt', text: 'txt', docx: 'docx', html: 'html', htm: 'html', xhtml: 'html' };
const UNSUPPORTED = "Can't read this file: only .md, .txt, .docx and .html are supported";

const DOCX_STYLE_MAP = [
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Subtitle'] => p:fresh",
  "p[style-name='Quote'] => blockquote > p:fresh",
  "p[style-name='Intense Quote'] => blockquote > p:fresh",
  "p[style-name='Block Text'] => blockquote > p:fresh",
  "p[style-name='Code Block'] => pre:separator('\\n')",
  "p[style-name='HTML Preformatted'] => pre:separator('\\n')",
  "p[style-name='Source Code'] => pre:separator('\\n')",
  "r[style-name='Inline Code'] => code",
  "r[style-name='HTML Code'] => code",
  "r[style-name='Verbatim Char'] => code",
  "p[style-name='Scene Break'] => hr:fresh",
  "p[style-name='Spoiler Label'] => !",
  "p[style-name='Picture Caption'] => !",
  "p[style-name='Spoiler'] => div.spoilers > p:fresh",
  "p[style-name='Contents Heading'] => p:fresh",
  "p[style-name='Contents Entry'] => p:fresh",
];

let mammothPromise = null;
function loadMammoth() {
  if (window.mammoth) return Promise.resolve(window.mammoth);
  if (!mammothPromise) {
    mammothPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = MAMMOTH_SRC;
      s.async = true;
      s.onload = () => (window.mammoth ? resolve(window.mammoth) : reject(new Error("Couldn't load the Word reader.")));
      s.onerror = () => {
        mammothPromise = null;
        s.remove();
        reject(new Error("Couldn't load the Word reader. Check your connection and try again."));
      };
      document.head.appendChild(s);
    });
  }
  return mammothPromise;
}

function readArrayBuffer(file) {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(file);
  });
}

function decodeBytes(u8, kind) {
  try {
    if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return new TextDecoder('utf-8').decode(u8.subarray(3));
    if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8.subarray(2));
    if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8.subarray(2));
  } catch (err) {
    /* fall through */
  }
  const head = u8.subarray(0, 8192);
  let zeros = 0;
  for (let i = 0; i < head.length; i++) if (head[i] === 0) zeros++;
  if (zeros) {
    // UTF-16 without a byte order mark: every other byte is zero for Latin text.
    let evenZero = 0;
    let oddZero = 0;
    for (let i = 0; i + 1 < head.length; i += 2) {
      if (head[i] === 0) evenZero++;
      if (head[i + 1] === 0) oddZero++;
    }
    const half = head.length / 2;
    if (oddZero > half * 0.3 && evenZero < half * 0.05) return new TextDecoder('utf-16le').decode(u8);
    if (evenZero > half * 0.3 && oddZero < half * 0.05) return new TextDecoder('utf-16be').decode(u8);
    throw new Error("Can't read this file: it doesn't look like text.");
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(u8);
  } catch (err) {
    if (kind === 'html') {
      const sniff = new TextDecoder('windows-1252').decode(head.subarray(0, 4096));
      const m = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(sniff);
      if (m) {
        try {
          return new TextDecoder(m[1]).decode(u8);
        } catch (err2) {
          /* unknown label */
        }
      }
    }
    return new TextDecoder('windows-1252').decode(u8);
  }
}

// Title from a leading level-1 heading (removed from the body), else the fallback.
function splitTitle(markdown, fallback) {
  const lines = markdown.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  let title = null;
  let rest = null;
  const atx = i < lines.length ? /^ {0,3}#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(lines[i]) : null;
  if (atx) {
    title = atx[1];
    rest = lines.slice(i + 1);
  } else if (i + 1 < lines.length && /\S/.test(lines[i]) && !/^ {0,3}[-*+>#|]/.test(lines[i]) && /^ {0,3}=+[ \t]*$/.test(lines[i + 1])) {
    title = lines[i];
    rest = lines.slice(i + 2);
  }
  if (title != null) {
    const plain = inlineText(title);
    if (plain) return { title: plain, markdown: rest.join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '') };
  }
  return { title: fallback, markdown: markdown.replace(/\s+$/, '') };
}

export async function importFile(file) {
  if (!file || typeof file.size !== 'number') throw new Error("Can't read this file.");
  const name = str(file.name) || 'Untitled';
  const extMatch = /\.([A-Za-z0-9]+)$/.exec(name);
  const ext = extMatch ? extMatch[1].toLowerCase() : '';
  let kind = IMPORT_KINDS[ext];
  if (!kind && !ext) {
    const t = str(file.type);
    if (/markdown/.test(t)) kind = 'md';
    else if (/^text\/plain/.test(t)) kind = 'txt';
    else if (/html/.test(t)) kind = 'html';
    else if (/wordprocessingml/.test(t)) kind = 'docx';
  }
  if (!kind) {
    if (ext === 'doc') throw new Error("Can't read this file: .doc is the old Word format. Save it as .docx and try again.");
    throw new Error(UNSUPPORTED);
  }
  if (file.size > MAX_IMPORT_BYTES) throw new Error("Can't open this file: it is larger than 5 MB.");
  const fallback = (extMatch ? name.slice(0, -extMatch[0].length) : name).trim() || 'Untitled';
  let bytes;
  try {
    bytes = new Uint8Array(await readArrayBuffer(file));
  } catch (err) {
    throw new Error("Can't read this file: the browser couldn't open it.");
  }
  let markdown;
  if (kind === 'docx') {
    if (!(bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b)) {
      throw new Error("Can't read this file: it doesn't look like a Word document (.docx).");
    }
    const mammoth = await loadMammoth();
    let result;
    try {
      result = await mammoth.convertToHtml(
        { arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) },
        { styleMap: DOCX_STYLE_MAP, convertImage: mammoth.images.imgElement(() => ({ src: '' })) },
      );
    } catch (err) {
      throw new Error("Can't read this file: the Word document seems to be damaged.");
    }
    markdown = htmlToMarkdown((result && result.value) || '');
  } else {
    const text = decodeBytes(bytes, kind);
    markdown = kind === 'html' ? htmlToMarkdown(text) : normalizePlain(text);
  }
  return splitTitle(markdown, fallback);
}
