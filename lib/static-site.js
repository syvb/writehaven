// A static copy of the public site, for the host to keep and serve from any static host once
// the server is gone (GET /api/admin/static-site.zip). Every public page as plain HTML: each
// round's anthology (the latest at the root, every round under archive/<n>/), every published
// piece (p/<id>/), the list of writers (writers/) and each listed writer's page (w/<id>/), with
// the site's stylesheets and fonts and the images the pieces show (u/<name>). No JavaScript.
//
// Only what the public site itself shows goes in: the model is built from the same public views
// the pages read (archiveView, pastArchiveView, publicPost, writersView, writerPageView), and a
// round only once it has ended. Rendering runs in a worker (lib/static-worker.js) with its own
// minimal DOM, off the server's main thread.
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { zip } from './zip.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const UPLOAD_REF = /\/u\/(?:hotlink-ok\/)?([0-9a-f]{32}\.(?:png|jpg|webp|gif))\b/g;

// What the pages are made from: public views only. Throws (409) when nothing has been published.
export function siteModel(party) {
  const rounds = [];
  const posts = [];
  const add = (n, name, startedAt, endedAt, archive) => {
    rounds.push({ n, name, startedAt: startedAt ?? null, endedAt: endedAt ?? null, archive });
    for (const row of archive.posts) {
      let p;
      try {
        p = party.publicPost(row.id);
      } catch {
        continue; // not public after all
      }
      posts.push({ ...p, roundN: n });
    }
  };
  const times = new Map(party.roundsList().map((r) => [r.n, r]));
  for (const r of party.roundNames()) {
    const t = times.get(r.n) || {};
    add(r.n, r.name, t.startedAt, t.endedAt, party.pastArchiveView(r.n));
  }
  const ended = party.phase === 'ended';
  if (ended) add(party.round, party.state.party.name, party.state.party.startedAt, party.state.party.endedAt, party.archiveView());
  if (!rounds.length) {
    const e = new Error('Nothing is published yet: the static site holds the anthology of a party that has ended.');
    e.status = 409;
    throw e;
  }
  rounds.sort((a, b) => a.n - b.n);
  const postIds = posts.map((p) => p.id);
  // The writers list as the public site shows it after the end (this round's listed writers),
  // with their hours only when this round has ended; their pages, and the page of any other
  // listed writer a published piece links to.
  const listed = party.writersView().writers;
  const writerIds = new Set(listed.map((w) => w.id));
  for (const p of posts) if (p.profile) writerIds.add(p.profile);
  const writerPages = [];
  for (const id of writerIds) {
    let v;
    try {
      v = party.writerPageView(id);
    } catch {
      continue;
    }
    writerPages.push({
      id, name: v.name, met: v.met, judged: v.judged, out: v.out, left: v.left,
      rate: ended && v.inRound !== false, round: v.party.round,
      posts: ended ? v.posts : [], // this round's pieces only once it has ended
      past: v.past,
    });
  }
  const pages = new Set(writerPages.map((w) => w.id));
  return {
    name: party.state.party.name,
    tz: party.tz,
    latest: rounds[rounds.length - 1].n,
    rounds,
    posts,
    postIds,
    writers: listed.filter((w) => pages.has(w.id)).map((w) => ({ id: w.id, name: w.name, met: w.met, judged: w.judged, out: w.out, left: w.left })),
    rates: ended,
    writerPages,
    writerIds: [...pages],
  };
}

// model -> Promise<[{ path, text }]> (rendered in a worker).
export function renderSite(model, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./static-worker.js', import.meta.url), { workerData: model });
    const timer = setTimeout(() => {
      w.terminate();
      reject(new Error('Building the static site took too long'));
    }, timeoutMs);
    w.once('message', (m) => {
      clearTimeout(timer);
      w.terminate();
      if (m && m.ok) resolve(m.files);
      else reject(new Error(`static site: ${m && m.error}`));
    });
    w.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

const README = (name) => `${name}: the anthology, as a static website
${'='.repeat(name.length + 36)}

Every public page of the party, as plain HTML: no server, database or JavaScript needed.

  index.html         the anthology of the latest round
  archive/<n>/       each round's anthology
  p/<id>/            each published piece
  writers/, w/<id>/  the writers who chose to be listed, and their pages
  u/                 the images the pieces show

To put it online, upload everything in this folder to any static host (for example GitHub
Pages, Netlify, Cloudflare Pages, or a plain web server). Links are relative, so it also works
from a subfolder. 404.html is the "not here" page for hosts that use one.

To read it on your own computer, serve the folder with any small web server, for example
"python3 -m http.server" in this folder, and open http://localhost:8000/.
`;

// The whole site as a ZIP: Promise<Buffer>.
export async function buildStaticSite(party, { uploadsDir }) {
  const model = siteModel(party);
  const pages = await renderSite(model);
  const entries = pages.map((f) => ({ name: f.path, data: f.text }));
  // The site's own styles and fonts (font URLs made relative to the stylesheet).
  const css = (f) => fs.readFileSync(path.join(PUBLIC, 'css', f));
  entries.push({ name: 'css/app.css', data: css('app.css') }, { name: 'css/writers.css', data: css('writers.css') }, { name: 'css/print.css', data: css('print.css') });
  entries.push({ name: 'fonts/fonts.css', data: fs.readFileSync(path.join(PUBLIC, 'fonts', 'fonts.css'), 'utf8').replace(/url\(\/fonts\//g, 'url(') });
  for (const f of fs.readdirSync(path.join(PUBLIC, 'fonts'))) {
    if (/\.(woff2|txt)$/.test(f)) entries.push({ name: `fonts/${f}`, data: fs.readFileSync(path.join(PUBLIC, 'fonts', f)) });
  }
  entries.push({ name: 'favicon.svg', data: fs.readFileSync(path.join(PUBLIC, 'favicon.svg')) });
  // The images the published pieces show, and only those.
  const images = new Set();
  for (const p of model.posts) for (const m of String(p.text).matchAll(UPLOAD_REF)) images.add(m[1]);
  for (const name of [...images].sort()) {
    const file = path.join(uploadsDir, name);
    try {
      entries.push({ name: `u/${name}`, data: fs.readFileSync(file) });
    } catch { /* gone: the page shows its alt text */ }
  }
  entries.push({ name: 'README.txt', data: README(model.name) });
  return { zip: await zip(entries), pages: pages.length, images: images.size, posts: model.posts.length, rounds: model.rounds.length };
}
