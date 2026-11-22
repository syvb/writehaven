// The public site as a static website (lib/static-site.js, lib/static-worker.js, lib/zip.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeParty, addUser, startApp, client } from './helpers.js';
import { MIN } from './sim.js';
import { zip, unzip, crc32 } from '../lib/zip.js';
import { buildStaticSite, siteModel } from '../lib/static-site.js';

test('zip: deflated and stored entries, UTF-8 names, read back with their checksums', async () => {
  const entries = [
    { name: 'index.html', data: '<p>Hello</p>'.repeat(200) },
    { name: 'u/abc.webp', data: Buffer.from([1, 2, 3, 4, 5]) },
    { name: 'p/café/index.html', data: 'Crème brûlée ✓' },
  ];
  const buf = await zip(entries);
  const back = unzip(buf);
  assert.deepEqual(back.map((e) => [e.name, e.data.toString('utf8')]), entries.map((e) => [e.name, Buffer.from(e.data).toString('utf8')]));
  assert.ok(buf.length < 3000, 'html is deflated');
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  await assert.rejects(zip([{ name: 'a', data: '' }, { name: 'a', data: '' }]), /repeated/);
  await assert.rejects(zip([{ name: '../etc/passwd', data: '' }]), /bad/);
});

// A party with every kind of post, ended: what goes in the static site and what never does.
function party() {
  const { party, clock } = makeParty({ settings: { hourLengthMin: 10, targetPerHour: 20 } });
  const host = addUser(party, 'host');
  party.start(host.id);
  const ana = addUser(party, 'ana', 'Ana Ruiz');
  const bo = addUser(party, 'bo', 'Bo Lin');
  for (const w of [ana, bo]) party.join(w.id);
  party.setPublicProfile(ana.id, true); // Ana is on the list of writers; Bo isn't
  const post = (w, title, body, privacy = 'live', notes = '') => {
    const p = party.newPost(w.id, { title });
    party.applyOps(w.id, { postId: p.id, pane: 'body', baseVersion: 0, seq: `${p.id}b`, ops: [{ pos: 0, del: 0, ins: body }] });
    if (notes) party.applyOps(w.id, { postId: p.id, pane: 'notes', baseVersion: 0, seq: `${p.id}n`, ops: [{ pos: 0, del: 0, ins: notes }] });
    if (privacy !== 'live') party.updatePost(w.id, { id: p.id, privacy });
    clock.advance(MIN);
    return p;
  };
  const IMG = 'a'.repeat(32) + '.webp';
  const signed = post(ana, 'Harbour <script>alert(1)</script>', `The lights went out one by one.[^1]\n\n![A harbour at night](/u/${IMG}#w=4&h=3)\n\n[^1]: Mostly.`, 'named', 'PLANNINGSECRET outline here');
  const anon = post(bo, 'Unsigned', 'Nobody knows who wrote this anonymous piece of prose.');
  const priv = post(ana, 'Diary', 'PRIVATESECRET words nobody else should read.', 'private');
  const sep = post(ana, 'Apart', 'SEPARATEPIECE kept apart from the rest of my work.', 'separate');
  const hidden = post(bo, 'Hidden', 'HIDDENSECRET the host hid this one.');
  party.adminPost(host.id, { id: hidden.id, unlisted: true });
  clock.advance(5 * MIN);
  party.end(host.id);
  return { party, host, ana, bo, IMG, signed, anon, priv, sep, hidden };
}

test('the static site: every public page as plain HTML with relative links; nothing private, hidden or unpublished', async () => {
  const x = party();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-static-'));
  fs.writeFileSync(path.join(dir, x.IMG), Buffer.from('RIFF....WEBPVP8 '));
  fs.writeFileSync(path.join(dir, 'b'.repeat(32) + '.webp'), Buffer.from('not shown anywhere'));
  try {
    const built = await buildStaticSite(x.party, { uploadsDir: dir });
    const files = new Map(unzip(built.zip).map((f) => [f.name, f.data]));
    const html = (n) => files.get(n)?.toString('utf8');
    const pub = (p) => p.publicId;
    // The pages.
    for (const n of ['index.html', 'archive/1/index.html', 'writers/index.html', `w/${x.ana.publicProfile.id}/index.html`, '404.html', 'README.txt',
      'css/app.css', 'css/writers.css', 'fonts/fonts.css', 'favicon.svg', `u/${x.IMG}`]) assert.ok(files.has(n), n);
    for (const p of [x.signed, x.anon, x.sep]) assert.ok(files.has(`p/${pub(p)}/index.html`), p.title);
    for (const p of [x.priv, x.hidden]) assert.ok(!files.has(`p/${pub(p)}/index.html`), `${p.title}: no page`);
    assert.ok(!files.has(`u/${'b'.repeat(32)}.webp`), 'only images that published pieces show');
    assert.equal(built.posts, 3);
    // What's in them: the anthology, escaped; the post rendered as the live page does.
    const index = html('index.html');
    assert.match(index, /<h1 class="a-title">The anthology<\/h1>/);
    assert.match(index, /Harbour &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(index, /<script/);
    const page = html(`p/${pub(x.signed)}/index.html`);
    assert.match(page, /<p class="p-by">by <a href="\.\.\/\.\.\/w\/[a-z0-9]+\/">Ana Ruiz<\/a><\/p>/);
    assert.match(page, /<img[^>]*src="\.\.\/\.\.\/u\/a{32}\.webp"/);
    assert.match(page, /class="footnotes"/);
    assert.match(page, /href="\.\.\/\.\.\/css\/app\.css"/);
    assert.doesNotMatch(page, /<script/);
    assert.match(html(`p/${pub(x.sep)}/index.html`), /SEPARATEPIECE/);
    assert.doesNotMatch(html(`p/${pub(x.sep)}/index.html`), /Ana Ruiz/, 'a separate piece carries no name');
    // The writers: Ana listed (with her signed piece only), Bo not.
    assert.match(html('writers/index.html'), /Ana Ruiz/);
    assert.doesNotMatch(html('writers/index.html'), /Bo Lin/);
    const ana = html(`w/${x.ana.publicProfile.id}/index.html`);
    assert.match(ana, /Harbour/);
    assert.doesNotMatch(ana, /Apart|Diary|SEPARATEPIECE/);
    assert.equal(html('fonts/fonts.css').includes('url(/fonts/'), false, 'font URLs are relative');
    // Nothing private anywhere, no planning notes, no account names or server addresses.
    const all = [...files].filter(([n]) => /\.(html|txt)$/.test(n)).map(([, d]) => d.toString('utf8')).join('\n'); // (the stylesheets have at-rules like @bottom-center)
    for (const secret of ['PRIVATESECRET', 'HIDDENSECRET', 'PLANNINGSECRET', '@ana', '@bo', '@host', '/api/']) assert.ok(!all.includes(secret), secret);
    // Every internal link and image resolves inside the site.
    let links = 0;
    for (const [n, d] of files) {
      if (!n.endsWith('.html') || n === '404.html') continue;
      for (const m of d.toString('utf8').matchAll(/\s(?:href|src)="([^"]*)"/g)) {
        const u = m[1];
        if (/^(https?:|mailto:|#)/.test(u)) continue;
        links++;
        assert.ok(!u.startsWith('/'), `${n}: relative link ${u}`);
        let t = path.posix.normalize(path.posix.join(path.posix.dirname(n), u.split('#')[0]));
        if (u.endsWith('/') || u === './') t = path.posix.join(t, 'index.html');
        assert.ok(files.has(t), `${n} → ${u}`);
      }
    }
    assert.ok(links > 20);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the static site waits for a party to end; over HTTP it is for hosts only', async (t) => {
  const { party: p, clock } = makeParty();
  const host = addUser(p, 'host');
  p.start(host.id);
  clock.advance(MIN);
  assert.throws(() => siteModel(p), (e) => e.status === 409 && /ended/.test(e.message));

  const { base, close } = await startApp();
  t.after(close);
  const h = client(base);
  await h.post('/api/register', { username: 'host', password: 'longpassword', name: 'Host' });
  await h.post('/api/admin/start', {});
  const w = client(base);
  await w.post('/api/register', { username: 'wren', password: 'longpassword', name: 'Wren' });
  assert.equal((await h.get('/api/admin/static-site.zip')).status, 409, 'not before the end');
  await h.post('/api/admin/end', {});
  assert.equal((await w.get('/api/admin/static-site.zip')).status, 404, 'writers can’t');
  assert.equal((await client(base).get('/api/admin/static-site.zip')).status, 404, 'nor visitors');
  const res = await h.get('/api/admin/static-site.zip', { raw: true });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="writehaven-site-[\d-]+\.zip"$/);
  const names = unzip(Buffer.from(await res.arrayBuffer())).map((f) => f.name);
  assert.ok(names.includes('index.html') && names.includes('writers/index.html'));
});
