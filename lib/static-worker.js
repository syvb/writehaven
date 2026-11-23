// Worker for lib/static-site.js: renders the static copy of the public site as HTML. It runs
// public/js/md-render.js (the posts' Markdown, exactly as the live pages show it) against a
// minimal DOM of its own, so no global `document` ever exists in the server's main thread.
// workerData: the model lib/static-site.js gathers (public views only). Posts back
// { ok, files: [{ path, text }] } or { ok: false, error }.
//
// The pages mirror the live ones (public/js/live.js mountArchive / mountPost, writers.js) and
// use the same classes, so the site's own stylesheets style them; nothing needs JavaScript.
// Links are relative (`P` climbs back to the root), so the folder works anywhere.
import { parentPort, workerData } from 'node:worker_threads';

// ------------------------------------------------------------------ a minimal DOM
const VOID = new Set(['br', 'hr', 'img', 'wbr']);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
class Text {
  constructor(data) { this.data = String(data); this.parentNode = null; this.nodeType = 3; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}
class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.childNodes = []; this.parentNode = null; this.nodeType = 1;
    this.attributes = {}; this.className = ''; this.dataset = {}; this.style = {};
  }
  append(...xs) {
    for (const x of xs) {
      if (x === null || x === undefined) continue;
      const n = typeof x === 'string' ? new Text(x) : x;
      if (n.tagName === '#FRAGMENT') { this.append(...n.childNodes.slice()); continue; }
      if (n.parentNode) n.parentNode.childNodes.splice(n.parentNode.childNodes.indexOf(n), 1);
      n.parentNode = this;
      this.childNodes.push(n);
    }
  }
  appendChild(x) { this.append(x); return x; }
  prepend(...xs) {
    const kids = this.childNodes;
    this.childNodes = [];
    this.append(...xs);
    for (const k of kids) { k.parentNode = this; this.childNodes.push(k); }
  }
  remove() { if (this.parentNode) { this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1); this.parentNode = null; } }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  removeAttribute(k) { delete this.attributes[k]; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get lastElementChild() { for (let i = this.childNodes.length - 1; i >= 0; i--) if (this.childNodes[i].nodeType === 1) return this.childNodes[i]; return null; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { this.childNodes = []; if (v !== '' && v != null) this.append(String(v)); }
  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    return {
      contains: (c) => names().includes(c),
      add: (...c) => { this.className = [...new Set([...names(), ...c])].join(' '); },
      remove: (...c) => { this.className = names().filter((x) => !c.includes(x)).join(' '); },
      toggle: (c, on) => { const has = names().includes(c); const want = on === undefined ? !has : !!on; if (want !== has) this.className = want ? [...names(), c].join(' ') : names().filter((x) => x !== c).join(' '); return want; },
    };
  }
}
globalThis.document = {
  createElement: (t) => new El(t),
  createElementNS: (ns, t) => new El(t),
  createDocumentFragment: () => new El('#fragment'),
  createTextNode: (d) => new Text(d),
};

// Element properties md-render.js sets, written out as attributes.
const PROPS = ['id', 'href', 'src', 'alt', 'loading', 'decoding', 'width', 'height', 'start', 'target', 'rel', 'title'];
const kebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
// mapSrc: an image address → this page's relative one.
function serialize(node, mapSrc) {
  if (node.nodeType === 3) return esc(node.data);
  const tag = node.tagName.toLowerCase();
  if (tag === '#fragment') return node.childNodes.map((c) => serialize(c, mapSrc)).join('');
  const attrs = [];
  if (node.className) attrs.push(['class', node.className]);
  for (const k of PROPS) {
    let v = node[k];
    if (v === undefined || v === null || v === '') continue;
    if (k === 'src') v = mapSrc(String(v));
    attrs.push([k, String(v)]);
  }
  for (const [k, v] of Object.entries(node.dataset || {})) attrs.push([`data-${kebab(k)}`, v]);
  const css = Object.entries(node.style || {}).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${kebab(k)}: ${v}`).join('; ');
  if (css) attrs.push(['style', css]);
  for (const [k, v] of Object.entries(node.attributes)) attrs.push([k, v]);
  if (node.hidden) attrs.push(['hidden', '']);
  if (node.open) attrs.push(['open', '']);
  const open = `<${tag}${attrs.map(([k, v]) => (v === '' && (k === 'hidden' || k === 'open') ? ` ${k}` : ` ${k}="${esc(v)}"`)).join('')}>`;
  if (VOID.has(tag)) return open;
  return `${open}${node.childNodes.map((c) => serialize(c, mapSrc)).join('')}</${tag}>`;
}

const { renderBlocks, renderNotes } = await import('../public/js/md-render.js');
const { footnotes } = await import('../public/js/footnotes.js');

// ------------------------------------------------------------------ words (as the live pages)
const nf = new Intl.NumberFormat('en-GB');
const fmtInt = (x) => nf.format(Math.round(x || 0));
const plural = (n, one, many = `${one}s`) => `${fmtInt(n)} ${Math.round(n) === 1 ? one : many}`;
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const spell = (n) => (n >= 0 && n <= 20 && Number.isInteger(n) ? ONES[n] : fmtInt(n));
const cap1 = (s) => s.charAt(0).toUpperCase() + s.slice(1);
function spellHours(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 25) return min <= 1 ? 'a minute' : `${spell(min)} minutes`;
  const halves = Math.round(min / 30);
  const whole = Math.floor(halves / 2);
  const half = halves % 2 === 1;
  if (whole === 0) return 'half an hour';
  if (whole === 1) return half ? 'an hour and a half' : 'an hour';
  return `${spell(whole)}${half ? ' and a half' : ''} hours`;
}
const model = workerData;
function longDate(ms) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: model.tz }).formatToParts(ms);
    const get = (t) => parts.find((p) => p.type === t)?.value || '';
    return `${get('weekday')} ${get('day')} ${get('month')} ${get('year')}`;
  } catch {
    return new Date(ms).toDateString();
  }
}
function blurb(s, max = 170) {
  const t = String(s || '').replace(/\s+/g, ' ').trim().replace(/(\.\.\.|[.!?…])\s*…$/u, '$1');
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const m = /^[\s\S]*[.!?…][”’"')\]]*(?=\s)/u.exec(cut);
  if (m && m[0].length >= max * 0.55) return m[0];
  const w = cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 30)).replace(/[\s,;:–—-]+$/u, '');
  return /(\.\.\.|[.!?…])$/u.test(w) ? w : `${w}…`;
}
function rateText({ met, judged }, phase) {
  if (judged > 0) return `${fmtInt(met)} of ${plural(judged, 'hour')} met`;
  return phase === 'ended' ? 'No hours judged' : 'No hours judged yet';
}

// ------------------------------------------------------------------ HTML
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const up = (depth) => '../'.repeat(depth);
const rootHref = (P) => P || './';
const roundHref = (P, n) => (n === model.latest ? rootHref(P) : `${P}archive/${n}/`);
const postHref = (P, id) => `${P}p/${id}/`;
const writerHref = (P, id) => `${P}w/${id}/`;
// An attribute list → ' k="v"…' (null and false leave an attribute out).
const at = (o) => Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== false).map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${esc(v)}"`)).join('');
const tag = (t, o, ...kids) => `<${t}${at(o || {})}>${kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false).join('')}</${t}>`;
const txt = (s) => esc(s);

function page({ P, title, description = null, writersCss = false, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f3f3ef" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#16181b" media="(prefers-color-scheme: dark)">
<title>${esc(title)}</title>
${description ? `<meta name="description" content="${esc(description)}">\n` : ''}<link rel="icon" type="image/svg+xml" href="${P}favicon.svg">
<link rel="stylesheet" href="${P}fonts/fonts.css">
<link rel="stylesheet" href="${P}css/app.css">
${writersCss ? `<link rel="stylesheet" href="${P}css/writers.css">\n` : ''}<link rel="stylesheet" href="${P}css/print.css" media="print">
</head>
<body>
<div id="app">${body}</div>
</body>
</html>
`;
}

// An uploaded image (/u/<name>, /u/hotlink-ok/<name>) → u/<name> beside the pages; anything else stays.
const UPLOAD_SRC = /^\/u\/(?:hotlink-ok\/)?([0-9a-f]{32}\.(?:png|jpg|webp|gif))$/;
const srcMapper = (P) => (src) => {
  const m = UPLOAD_SRC.exec(src);
  return m ? `${P}u/${m[1]}` : src;
};

// ------------------------------------------------------------------ pages
const rounds = new Map(model.rounds.map((r) => [r.n, r]));
const multi = model.rounds.length > 1;
const files = [];
const out = (path, text) => files.push({ path, text });

function anthologyPage(r, P, { note = null } = {}) {
  const v = r.archive;
  const name = r.name;
  const roundName = multi ? `round ${r.n}` : '';
  const n = v.counters.posts;
  const w = Number.isFinite(v.counters.participants) && v.counters.participants >= 3 ? v.counters.participants : null;
  const words = v.counters.words;
  const span = r.startedAt && r.endedAt ? r.endedAt - r.startedAt : null;
  const lede = n
    ? `${cap1(spell(n))} ${n === 1 ? 'piece' : 'pieces'} written${r.startedAt ? ` on ${longDate(r.startedAt)}` : ''}${w ? ` by ${spell(w)} writers` : ''}${span ? ` in ${spellHours(span)}` : ''}. ${plural(words, 'word')}${n < 2 ? '.' : v.starredFirst ? '. Signed pieces their writers starred come first; the rest are in no particular order.' : ', in no particular order.'}`
    : 'Nothing was published.';
  const others = model.rounds.filter((x) => x.n !== r.n).map((x) => tag('a', { href: roundHref(P, x.n) }, txt(`Round ${x.n}${x.startedAt ? `, ${longDate(x.startedAt)}` : ''}`)));
  const toc = tag('ol', { class: 'a-toc a-list' }, v.posts.filter((p) => SAFE_ID.test(p.id)).map((p, i) => tag('li', { class: 'a-entry a-item' },
    tag('a', { href: postHref(P, p.id) },
      tag('span', { class: 'a-num' }, String(i + 1)),
      tag('span', { class: 'a-entry-main' },
        tag('span', { class: 'a-entry-line' },
          tag('span', { class: 'a-entry-title' }, txt(p.title || 'Untitled')),
          tag('span', { class: 'a-leader', 'aria-hidden': 'true' }),
          tag('span', { class: 'a-entry-words' }, txt(plural(p.words, 'word')))),
        p.name ? tag('span', { class: 'a-entry-by' }, txt(p.name)) : null,
        p.added || p.edited ? tag('span', { class: 'a-entry-edited' }, p.added ? 'Added after the party' : 'Edited after the party') : null,
        p.excerpt ? tag('span', { class: 'a-entry-ex' }, txt(blurb(p.excerpt))) : null)))));
  const body = tag('div', { class: 'l-page a-page' },
    tag('header', { class: 'a-head' },
      tag('div', { class: 'l-mast-top' },
        tag('span', { class: 'l-chip is-ended' }, txt(roundName ? `${name} · Round ${r.n}` : name)),
        tag('nav', { class: 'l-mast-nav' }, tag('a', { class: 'l-link', href: `${P}writers/` }, 'The writers'))),
      tag('h1', { class: 'a-title' }, 'The anthology'),
      tag('p', { class: 'a-lede' }, txt(lede))),
    note ? noteBox(note, P) : null,
    n ? tag('nav', { class: 'a-contents', 'aria-label': 'Contents' }, tag('h2', { class: 'a-contents-h' }, 'Contents'), toc) : null,
    tag('footer', { class: 'a-colophon' },
      tag('p', { class: 'a-orn', 'aria-hidden': 'true' }, '⁂'),
      tag('p', null, txt(`Written at ${name}${roundName ? `, ${roundName}` : ''}${r.startedAt ? `, ${longDate(r.startedAt)}` : ''}, in one sitting, and published as it was written. Set in Newsreader and Instrument Sans.`)),
      others.length ? tag('nav', { class: 'a-rounds', 'aria-label': 'Other rounds' }, tag('p', null, 'The other rounds: ', others.join(' · '))) : null));
  return page({ P, title: roundName ? `${name}, ${roundName}: the anthology` : `${name}: the anthology`, description: lede, body });
}

// The host's note on the front page, Markdown rendered like a post (its footnotes kept apart).
function noteBox(text, P) {
  const notes = footnotes(text);
  const mapSrc = srcMapper(P);
  const blocks = renderBlocks(text, { notes, idPrefix: 'nfn' }).blocks.map((b) => serialize(b.el, mapSrc)).join('');
  const notesEl = renderNotes(notes, { idPrefix: 'nfn' });
  return tag('section', { class: 'a-note prose', 'aria-label': 'A note from the hosts' }, blocks, notesEl ? serialize(notesEl, mapSrc) : null);
}

function postPage(p, r, P) {
  const notes = footnotes(p.text);
  const mapSrc = srcMapper(P);
  const blocks = renderBlocks(p.text, { notes }).blocks.map((b) => serialize(b.el, mapSrc)).join('');
  const notesEl = renderNotes(notes);
  const home = roundHref(P, r.n);
  const homeLabel = multi ? `${r.name}, round ${r.n}: the anthology` : `${r.name}: the anthology`;
  const profile = p.name && p.profile && SAFE_ID.test(p.profile) && model.writerIds.includes(p.profile) ? p.profile : null;
  const list = r.archive.posts;
  const i = list.findIndex((x) => x.id === p.id);
  const next = i >= 0 ? list.slice(i + 1).find((x) => SAFE_ID.test(x.id)) : null;
  const body = tag('article', { class: 'l-page p-page' },
    tag('p', { class: 'p-back' }, tag('a', { href: home }, txt(homeLabel))),
    tag('h1', { class: 'p-title' }, txt(p.title || 'Untitled')),
    p.name ? tag('p', { class: 'p-by' }, 'by ', profile ? tag('a', { href: writerHref(P, profile) }, txt(p.name)) : txt(p.name)) : null,
    tag('div', { class: 'p-body prose' }, blocks),
    tag('div', { class: 'p-notes prose' }, notesEl ? serialize(notesEl, mapSrc) : ''),
    tag('p', { class: 'p-end' }, txt(plural(p.words, 'word')), p.added || p.edited ? tag('span', { class: 'p-edited' }, p.added ? ' · Added after the party' : ' · Edited after the party') : null),
    tag('nav', { class: 'p-after', 'aria-label': 'More from the anthology' },
      tag('p', { class: 'a-orn', 'aria-hidden': 'true' }, '⁂'),
      next
        ? tag('p', { class: 'p-next' }, tag('span', { class: 'p-next-k' }, 'Next'), tag('a', { href: postHref(P, next.id) }, txt(next.title || 'Untitled')))
        : tag('p', { class: 'p-next' }, tag('span', { class: 'p-next-k' }, 'That’s the last piece')),
      profile ? tag('p', { class: 'p-contents p-more' }, tag('a', { href: writerHref(P, profile) }, txt(`More by ${p.name}`))) : null,
      tag('p', { class: 'p-contents' }, tag('a', { href: home }, 'All pieces: the contents'))));
  return page({ P, title: `${p.title || 'Untitled'}: ${r.name}`, description: blurb(p.text, 160), body });
}

const STAR_PATH = 'M12 2.8l2.75 5.86 6.42.78-4.73 4.42 1.22 6.36L12 17.07l-5.66 3.15 1.22-6.36-4.73-4.42 6.42-.78z';
const star = (cls) => `<svg viewBox="0 0 24 24" class="${cls}" aria-hidden="true" focusable="false"><path d="${STAR_PATH}" stroke-linejoin="round" fill="currentColor"></path></svg>`;
const siteName = () => rounds.get(model.latest)?.name || model.name;

function writersPage(P) {
  const ws = model.writers.filter((w) => SAFE_ID.test(w.id));
  const lede = model.rates
    ? 'Writers who chose to be listed, and how many of their hours met the hourly challenge. Their pages hold the pieces they signed.'
    : 'Writers who chose to be listed. Their pages hold the pieces they signed.';
  const list = ws.length
    ? tag('ul', { class: 'wr-list', 'aria-label': plural(ws.length, 'writer') }, ws.map((w) => tag('li', { class: 'wr-row' },
      tag('a', { class: 'wr-link', href: writerHref(P, w.id) },
        tag('span', { class: 'wr-name' }, txt(w.name)),
        tag('span', { class: 'wr-leader', 'aria-hidden': 'true' }),
        model.rates ? tag('span', { class: `wr-rate${w.judged > 0 ? '' : ' is-none'}` }, txt(rateText(w, 'ended')),
          w.out ? tag('span', { class: 'wr-out' }, ' · out of the challenge') : w.left ? tag('span', { class: 'wr-out' }, ' · left the party') : null) : null))))
    : tag('p', { class: 'wr-none' }, 'No one chose to be listed.');
  const body = tag('div', { class: 'l-page wr-page' },
    tag('header', { class: 'a-head wr-head' },
      tag('div', { class: 'l-mast-top' }, tag('span', { class: 'wr-crumb' }, tag('a', { class: 'l-link wr-party', href: rootHref(P) }, txt(`${siteName()}: the anthology`))), tag('nav', { class: 'l-mast-nav' })),
      tag('h1', { class: 'a-title' }, 'The writers'),
      tag('p', { class: 'a-lede wr-lede' }, txt(lede))),
    tag('div', { class: 'wr-body' }, list),
    tag('footer', { class: 'wr-foot' },
      tag('p', { class: 'a-orn', 'aria-hidden': 'true' }, '⁂'),
      tag('p', null, 'Only writers who chose to be here are listed. Their pages show only the pieces they signed; anonymous writing stays anonymous.')));
  return page({ P, title: `${siteName()}: the writers`, writersCss: true, body });
}

function writerPage(w, P) {
  const entry = (p) => tag('li', { class: 'a-entry wp-entry' },
    tag('a', { href: postHref(P, p.publicId) },
      tag('span', { class: 'a-entry-line' },
        tag('span', { class: 'a-entry-title' }, txt(p.title || 'Untitled')),
        tag('span', { class: 'a-leader', 'aria-hidden': 'true' }),
        tag('span', { class: 'a-entry-words' }, txt(plural(p.words, 'word')))),
      p.excerpt ? tag('span', { class: 'a-entry-ex' }, txt(p.excerpt)) : null));
  const ok = (list) => list.filter((p) => SAFE_ID.test(p.publicId) && model.postIds.includes(p.publicId));
  const posts = ok(w.posts);
  const starred = posts.filter((p) => p.starred);
  const rest = posts.filter((p) => !p.starred);
  const past = w.past.map((g) => ({ ...g, posts: ok(g.posts) })).filter((g) => g.posts.length && rounds.has(g.round));
  const roundLabel = past.length && w.round ? ` · Round ${w.round}` : '';
  const group = (hid, label, list, mark = false) => tag('section', { class: 'wp-group', 'aria-labelledby': hid },
    tag('h2', { class: 'a-contents-h wp-group-h', id: hid }, mark ? star('wp-mark') : null, txt(label)),
    tag('ol', { class: 'a-toc wp-list' }, list.map(entry)));
  const body = tag('div', { class: 'l-page wp-page' },
    tag('header', { class: 'wp-head' },
      tag('div', { class: 'l-mast-top' },
        tag('a', { class: 'l-link wr-crumb', href: `${P}writers/` }, tag('span', { 'aria-hidden': 'true' }, '← '), 'The writers'),
        tag('nav', { class: 'l-mast-nav' }, tag('a', { class: 'l-link wr-party', href: rootHref(P) }, txt(`${siteName()}: the anthology`)))),
      tag('h1', { class: 'wp-name' }, txt(w.name)),
      w.rate ? tag('p', { class: 'wp-rate' }, txt(rateText(w, 'ended')), w.out ? tag('span', { class: 'wp-out' }, ' · out of the challenge') : w.left ? tag('span', { class: 'wp-out' }, ' · left the party') : null) : null),
    tag('div', { class: 'wp-pieces' },
      posts.length || past.length ? null : tag('section', { class: 'wp-group' }, tag('h2', { class: 'a-contents-h wp-group-h' }, 'Signed pieces'), tag('p', { class: 'wr-none' }, 'No signed pieces.')),
      starred.length ? group('wp-starred-h', 'Starred', starred, true) : null,
      rest.length ? group('wp-rest-h', starred.length ? `More pieces${roundLabel}` : `${rest.length === 1 ? 'Signed piece' : 'Signed pieces'}${roundLabel}`, rest) : null,
      past.map((g) => tag('section', { class: 'wp-group', 'aria-labelledby': `wp-round-${g.round}` },
        tag('h2', { class: 'a-contents-h wp-group-h', id: `wp-round-${g.round}` }, tag('a', { href: roundHref(P, g.round) }, `Round ${g.round}`)),
        tag('ol', { class: 'a-toc wp-list' }, g.posts.map(entry))))),
    tag('footer', { class: 'wr-foot' },
      tag('p', { class: 'a-orn', 'aria-hidden': 'true' }, '⁂'),
      tag('p', { class: 'wp-end' }, 'Only pieces signed with this name appear here.'),
      tag('p', { class: 'wr-all' }, tag('a', { href: `${P}writers/` }, 'All the writers'))));
  return page({ P, title: `${w.name}: ${siteName()}`, writersCss: true, body });
}

function notFoundPage() {
  // Served by static hosts at any address, so it can't link relatively: plain, with its own styles.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Not here</title>
<style>body{font:1.1rem/1.55 Georgia,serif;max-width:30rem;margin:18vh auto 0;padding:0 1.5rem}a{color:inherit}</style>
</head>
<body>
<h1>Not here</h1>
<p>There’s no page at this address. <a href="/">Go to the anthology</a>.</p>
</body>
</html>
`;
}

try {
  const latest = rounds.get(model.latest);
  if (latest) out('index.html', anthologyPage(latest, '', { note: model.note }));
  for (const r of model.rounds) out(`archive/${r.n}/index.html`, anthologyPage(r, up(2)));
  for (const p of model.posts) {
    if (!SAFE_ID.test(p.id) || !rounds.has(p.roundN)) continue;
    out(`p/${p.id}/index.html`, postPage(p, rounds.get(p.roundN), up(2)));
  }
  out('writers/index.html', writersPage(up(1)));
  for (const w of model.writerPages) if (SAFE_ID.test(w.id)) out(`w/${w.id}/index.html`, writerPage(w, up(2)));
  out('404.html', notFoundPage());
  parentPort.postMessage({ ok: true, files });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String((e && e.stack) || e) });
}
