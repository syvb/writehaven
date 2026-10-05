// Interop QA: fixtures, round trips, API checks, every export format, print view, imports.
//   node tools/interop-qa/run.mjs [--port N]   (starts and stops its own server; port: --port, env
//                                               PORT, else 8111)
// Outputs: qa/interop/ (report.json, screenshots, downloads, rendered PDF pages).
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const { unzipSync, strFromU8 } = require('../vendor/node_modules/fflate'); // installed by npm ci in tools/vendor

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const OUT = path.join(root, 'qa/interop');
const DL = path.join(OUT, 'downloads');
const portArg = process.argv.indexOf('--port');
const PORT = Number((portArg > 0 && process.argv[portArg + 1]) || process.env.PORT || 8111);
if (!(PORT > 0 && PORT < 65536)) throw new Error('bad --port');
const BASE = 'http://127.0.0.1:' + PORT;
const CHROME = process.env.CHROME_PATH || undefined; // unset: Playwright's own Chromium
const PANDOC = process.env.PANDOC || 'pandoc';
for (const d of [OUT, DL]) fs.mkdirSync(d, { recursive: true });

const results = [];
function check(group, name, ok, detail) {
  results.push({ group, name, ok: !!ok, detail: ok ? undefined : detail });
  if (!ok) console.log('FAIL [' + group + '] ' + name + (detail ? '\n' + String(detail).slice(0, 2000) : ''));
}

function lineDiff(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  const out = [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] !== y[i]) out.push('  line ' + (i + 1) + '\n    expected: ' + JSON.stringify(x[i]) + '\n    got:      ' + JSON.stringify(y[i]));
    if (out.length > 12) break;
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Sample posts
// ---------------------------------------------------------------------------

const POST1 = {
  title: 'The Lighthouse Keeper’s Year',
  body: `The lamp turned all night — every night — and “nobody,” she said, “ever thanks the lamp.” She kept a log in **bold**, in *italics*, and once in ~~ink she regretted~~… The log ran to 1,284 entries over 1997–2003, which is more than 3 a week.

She wrote about the [Fresnel lens](https://en.wikipedia.org/wiki/Fresnel_lens) and the cost of paraffin & wicks (< £5 a month), and kept her \`lamp.log\` file neat.
A line break inside the paragraph, like a verse.

## The routine

- Wind the clockwork at dusk
- Trim the wick
  - with the small scissors
  - never the big ones
- Log the weather

1. Climb the 114 stairs
2. Light the lamp
3. Watch

> The sea does not care about your schedule.
> It never has.
>
> — the harbourmaster

---

### Supplies

| Item | Per month | Notes |
| --- | ---: | --- |
| Paraffin | 40 l | from the mainland |
| Wicks | 6 | cotton |

\`\`\`
log("dusk", lamp.on)
\`\`\`

>! The keeper was the lamp all along.

Привет, маяк. Ελληνικά too. Emoji 🌊 and a final sentence with *emphasis* and **strength**.`,
};
const SPOILER_TEXT = 'The keeper was the lamp all along.';

const PROSE = [
  'Winter arrived the way it always did on the island: first as a rumour in the gulls, then as a smell of iron in the wind, and finally all at once, in a night of sleet that rattled the lantern glass until dawn. The keeper did not mind. She had grown up with storms the way other people grow up with cats, and she knew their moods.',
  'In the mornings she walked the gallery with a cloth and a tin of polish, working the salt off the brass. It took two hours if she was careful and three if she let herself look at the sea. Most days she let herself look at the sea.',
  'The supply boat came on Thursdays, weather allowing, which in January meant roughly one Thursday in three. She kept a list on the back of the pantry door: flour, paraffin, tea, matches, the newspaper she would read a week late and enjoy all the more for it. When the boat did not come she crossed the date off anyway and wrote it again at the bottom.',
  'There were 114 stairs between the kitchen and the lamp room. She had counted them on her first day and had never needed to count them again; her legs knew. On the bad nights she climbed them every hour, trimming the wick, checking the clockwork, watching the beam sweep out across the water and come back empty, which was exactly what you wanted it to do.',
  'Spring, when it came, came sideways. A warm afternoon in March, a single crocus by the oil store, then six more weeks of hail. But the light changed before the weather did, and she noticed it in the log: the entries got longer, the handwriting looser. She wrote about birds again.',
];
const POST2 = {
  title: 'Notes from the Harbour',
  body: PROSE.join('\n\n') + '\n\n## After the season\n\n' + PROSE.slice(0, 3).join('\n\n') + '\n\n> Every lighthouse is a promise kept in the dark.',
};
const POST3 = { title: '', body: 'An untitled scrap with a [link](https://example.com/) and nothing else.' };
// Uploaded images (SPEC §14), served by the harness from fixtures/uploads/: an opaque WebP (embedded
// as JPEG), a transparent WebP (embedded as PNG) and a JPEG (embedded byte for byte).
const POST4 = {
  title: 'Pictures from the Point',
  body: 'The light came back on the third night.\n\n![The harbour at dusk](/u/qa-harbour-01.webp#w=1200&h=800)\n\nShe drew it from memory: ![Pencil sketch](/u/qa-sketch-02.webp) and pinned it by the lamp.\n\n![](/u/qa-lamp-03.jpg)\n\nThat was the whole of it.',
};
const ALL = [POST1, POST2, POST3, POST4];
const BOOK = 'Writehaven — Ana’s posts';

const ROUND_TRIP_MD = `# Title of the piece

A paragraph with **bold**, *italic*, ~~struck~~, \`code\`, and a [link](https://example.com/page?a=1&b=2).
A second line in the same paragraph — with “quotes” and an ellipsis…

## A list

- First item
- Second item with **bold**
  - Nested item
  - Another nested
- Third item

1. One
2. Two
   1. Two point one
3. Three

> A quote line
> continues here
>
> Second quote paragraph

---

\`\`\`js
const x = 1;
\`\`\`

| Name | Count |
| --- | ---: |
| Apples | 3 |
| Pears | 10 |

>! A spoiler line
>!
>! with a **second** paragraph

### Small heading

Final paragraph with ***bold italic*** and 5 * 3 = 15.

1\\. Escaped list marker and a [link with [brackets]](https://example.com/b).

- [ ] task open
- [x] task done`;

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(here, 'server.mjs'), '--port', String(PORT)], {
      env: Object.assign({}, process.env, { PORT: String(PORT) }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => reject(new Error('server did not start')), 8000);
    child.stdout.on('data', (d) => {
      if (/interop-qa server on/.test(String(d))) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code) reject(new Error('server exited ' + code));
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Headless Chrome drops the 11th download in a row from one page (the next one works again), so a
// missing download is retried once, and said so.
async function captureDownload(page, fn, arg) {
  const what = () => JSON.stringify(arg, (k, v) => (typeof v === 'string' && v.length > 40 ? v.slice(0, 40) + '…' : v));
  let dl;
  for (let attempt = 1; !dl; attempt++) {
    try {
      [dl] = await Promise.all([page.waitForEvent('download', { timeout: attempt === 1 ? 10000 : 30000 }), page.evaluate(fn, arg)]);
    } catch (err) {
      if (attempt === 2 || !/Timeout/.test(err.message)) throw new Error('no download for ' + what() + ': ' + err.message.split('\n')[0]);
      console.log('note: no download event for ' + what().slice(0, 120) + ' (Chrome download limiter); retrying once');
    }
  }
  const name = dl.suggestedFilename();
  const file = path.join(DL, name);
  await dl.saveAs(file);
  return { name, file };
}

async function xmlError(page, text, type) {
  return page.evaluate(
    ([t, ty]) => {
      const d = new DOMParser().parseFromString(t, ty);
      const e = d.getElementsByTagName('parsererror')[0];
      return e ? e.textContent.slice(0, 300) : null;
    },
    [text, type],
  );
}

// On a busy machine, starting a process can fail for a moment (EAGAIN) while other jobs hold
// many threads. Retry with a short back-off instead of failing the run.
function execRetry(cmd, args, opts) {
  for (let i = 0; ; i++) {
    try {
      return execFileSync(cmd, args, opts);
    } catch (err) {
      if (err.code !== 'EAGAIN' || i >= 6) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000 * (i + 1));
    }
  }
}

function pandoc(file, to) {
  return execRetry(PANDOC, [file, '-t', to, '--wrap=none'], { encoding: 'utf8' });
}

function zipHeader(buf) {
  // First local file header: signature, method, extra length, name.
  const sig = buf.readUInt32LE(0);
  const method = buf.readUInt16LE(8);
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const name = buf.slice(30, 30 + nameLen).toString('utf8');
  const data = buf.slice(30 + nameLen + extraLen, 30 + nameLen + extraLen + 20).toString('utf8');
  return { sig, method, extraLen, name, data };
}

function b64(file) {
  return fs.readFileSync(file).toString('base64');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const server = await startServer();
console.log('server pid', server.pid);
let browser;
const timings = {};
try {
  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'], headless: true });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  page.on('response', (r) => {
    if (r.status() >= 400) consoleErrors.push('HTTP ' + r.status() + ' ' + r.url());
  });
  await page.goto(BASE + '/qa/harness.html');
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 10000 });

  // --- 1. Fixtures -------------------------------------------------------
  const fixDir = path.join(here, 'fixtures');
  const outFix = path.join(OUT, 'fixtures-out');
  fs.mkdirSync(outFix, { recursive: true });
  const fixtures = fs.readdirSync(fixDir).filter((f) => f.endsWith('.html')).sort();
  for (const f of fixtures) {
    const html = fs.readFileSync(path.join(fixDir, f), 'utf8');
    const expected = fs.readFileSync(path.join(fixDir, f.replace(/\.html$/, '.md')), 'utf8').replace(/\s+$/, '');
    const got = await page.evaluate((h) => window.WH.htmlToMarkdown(h), html);
    fs.writeFileSync(path.join(outFix, f.replace(/\.html$/, '.md')), got + '\n');
    check('fixture', f, got === expected, lineDiff(expected, got));
    check('hygiene', f + ': no trailing whitespace', !/[ \t]+$/m.test(got), got.match(/.*[ \t]+$/m));
    check('hygiene', f + ': no runs of blank lines', !/\n\n\n/.test(got.replace(/```[\s\S]*?```/g, 'CODE')), 'triple newline');
    const emptyMarks = await page.evaluate((m) => /<(strong|em|del)>\s*<\/\1>/.test(window.WH.markdownToHtml(m)), got);
    check('hygiene', f + ': no emphasis around whitespace only', !emptyMarks, got);
    // Idempotence: our own Markdown must survive Markdown -> HTML -> Markdown unchanged.
    const again = await page.evaluate((m) => window.WH.htmlToMarkdown(window.WH.markdownToHtml(m)), got);
    check('idempotent', f, again === got, lineDiff(got, again));
  }

  // --- 2. Round trips ------------------------------------------------------
  {
    const back = await page.evaluate((m) => window.WH.htmlToMarkdown(window.WH.markdownToHtml(m)), ROUND_TRIP_MD);
    check('roundtrip', 'md -> html -> md (all constructs)', back === ROUND_TRIP_MD, lineDiff(ROUND_TRIP_MD, back));
    const back1 = await page.evaluate((m) => window.WH.htmlToMarkdown(window.WH.markdownToHtml(m)), POST1.body);
    check('roundtrip', 'md -> html -> md (post 1)', back1 === POST1.body, lineDiff(POST1.body, back1));
    // Our own clipboard HTML (with the marker) also converts back exactly.
    const viaClip = await page.evaluate((m) => {
      const dt = new DataTransfer();
      window.WH.fillClipboard(dt, m);
      return window.WH.htmlToMarkdown(dt.getData('text/html'));
    }, ROUND_TRIP_MD);
    check('roundtrip', 'clipboard html -> md', viaClip === ROUND_TRIP_MD, lineDiff(ROUND_TRIP_MD, viaClip));
  }

  // --- 3. API unit checks -------------------------------------------------
  {
    const cases = [
      ['CRLF and CR', 'a\r\nb\rc', 'a\nb\nc'],
      ['NBSP', 'x\u{A0}y', 'x y'],
      ['zero width and BOM', '\u{FEFF}zero\u{200B}width\u{2060}', 'zerowidth'],
      ['soft hyphen', 'co\u{AD}operate', 'cooperate'],
      ['trailing spaces per line', 'line  \t\nnext \nlast', 'line\nnext\nlast'],
      ['line/paragraph separators', 'a\u{2028}b\u{2029}c', 'a\nb\nc'],
      ['typography unchanged', '“quotes” ‘single’ — dash – en … ellipsis', '“quotes” ‘single’ — dash – en … ellipsis'],
      ['emoji ZWJ kept', 'dev 👩\u{200D}💻 ok', 'dev 👩\u{200D}💻 ok'],
      ['leading blank lines kept', '\n\nhello', '\n\nhello'],
      ['control chars removed', 'a\u{7}b\u{0}c', 'abc'],
    ];
    for (const [name, input, want] of cases) {
      const got = await page.evaluate((s) => window.WH.normalizePlain(s), input);
      check('normalizePlain', name, got === want, JSON.stringify({ got, want }));
    }
    const own = await page.evaluate(() => {
      const dt = new DataTransfer();
      window.WH.fillClipboard(dt, '**hi**');
      const html = dt.getData('text/html');
      return {
        html,
        plain: dt.getData('text/plain'),
        own: window.WH.isOwnHtml(html),
        notOwn: window.WH.isOwnHtml('<p>data-writehaven-copy is a word here</p>'),
        plainP: window.WH.isOwnHtml('<p>hello</p>'),
        marker: window.WH.OWN_HTML_MARKER,
      };
    });
    check('clipboard', 'fillClipboard text/plain is the Markdown', own.plain === '**hi**', own.plain);
    check('clipboard', 'fillClipboard html carries marker on wrapper', /<div data-writehaven-copy="1">/.test(own.html), own.html);
    check('clipboard', 'isOwnHtml true for our html', own.own === true);
    check('clipboard', 'isOwnHtml false for text mention / foreign html', own.notOwn === false && own.plainP === false);
    check('clipboard', 'OWN_HTML_MARKER value', own.marker === 'data-writehaven-copy');

    const san = await page.evaluate(() => {
      const H = window.WH.markdownToHtml;
      const out = {
        script: H('<script>alert(1)</script>\n\nhi'),
        jsLink: H('[x](javascript:alert(1)) and [y](JaVaScRiPt:alert(2)) and [z](data:text/html,hi)'),
        img: H('![alt text](https://x.test/y.png)'),
        dataImg: H('![pic](data:image/png;base64,AAAA)'),
        rawImg: H('<img src=x onerror=alert(1)>'),
        style: H('<style>body{display:none}</style><iframe src="https://evil.test"></iframe>'),
        link: H('[ok](https://example.com "T")'),
        strike: H('~one~ and ~~two~~'),
        name: H('Dear <name>, hello'),
        table: H('| a | b |\n| :-: | --: |\n| 1 | 2 |'),
        task: H('- [x] done'),
        code: H('```js\nlet a = 1 < 2;\n```'),
        breaks: H('one\ntwo'),
        spoiler: H('>! hidden *words*\n>!\n>! second'),
        notSpoiler: H('\\>! escaped and\n\n> ! a quote and <div data-wh-spoiler>raw</div>'),
        images: H('![Harbour](/u/qa-harbour-01.webp#w=1200&h=800) and ![remote](https://x.test/y.png) and ![odd](/u/../x.webp) and ![short](/u/ab.png)'),
      };
      // Every element and attribute in every output must be on the allowlist.
      const allowedTags = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'BR', 'STRONG', 'B', 'EM', 'I', 'S', 'DEL', 'A', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'CODE', 'PRE', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'DIV', 'IMG']);
      const allowedAttrs = new Set(['href', 'title', 'rel', 'colspan', 'rowspan', 'align', 'start', 'class']);
      const imgAttrs = new Set(['src', 'alt', 'width', 'height']);
      const bad = [];
      for (const [k, html] of Object.entries(out)) {
        const d = document.implementation.createHTMLDocument('');
        d.body.innerHTML = html;
        for (const el of d.body.querySelectorAll('*')) {
          if (!allowedTags.has(el.tagName)) bad.push(k + ': tag ' + el.tagName);
          if (el.tagName === 'DIV' && el.getAttribute('class') !== 'spoilers') bad.push(k + ': div without the spoiler class');
          for (const a of el.attributes) {
            if (el.tagName === 'IMG') {
              if (!imgAttrs.has(a.name)) bad.push(k + ': img attr ' + a.name);
              if (a.name === 'src' && !/^\/u\/[A-Za-z0-9_-]{6,80}\.(?:webp|png|jpe?g|gif)$/.test(a.value)) bad.push(k + ': img src ' + a.value);
              continue;
            }
            if (!allowedAttrs.has(a.name)) bad.push(k + ': attr ' + a.name);
            if (a.name === 'href' && !/^(https?:|mailto:)/i.test(a.value)) bad.push(k + ': href ' + a.value);
            if (a.name === 'class' && !/^language-/.test(a.value) && !(el.tagName === 'DIV' && a.value === 'spoilers')) bad.push(k + ': class ' + a.value);
          }
        }
      }
      out.bad = bad;
      return out;
    });
    check('sanitise', 'only allowlisted tags/attributes/hrefs', san.bad.length === 0, san.bad.join('\n'));
    check('sanitise', 'script shown as text, never executed', !/<script/i.test(san.script) && /&lt;script&gt;/.test(san.script), san.script);
    check('sanitise', 'javascript:/data: links dropped', !/href="(?:javascript|data)/i.test(san.jsLink) && /x/.test(san.jsLink), san.jsLink);
    check('sanitise', 'image becomes link', /<a href="https:\/\/x\.test\/y\.png" rel="noopener">alt text<\/a>/.test(san.img), san.img);
    check('sanitise', 'data: image becomes alt text', /pic/.test(san.dataImg) && !/data:/.test(san.dataImg), san.dataImg);
    check('sanitise', 'raw <img onerror> is text', !/<img/i.test(san.rawImg) && !/onerror="/i.test(san.rawImg), san.rawImg);
    check('sanitise', 'style/iframe dropped', !/<style|<iframe/i.test(san.style), san.style);
    check('sanitise', 'links get rel=noopener and title', /rel="noopener"/.test(san.link) && /title="T"/.test(san.link), san.link);
    check('sanitise', 'single tilde is text, double is strike', /~one~/.test(san.strike) && /<del>two<\/del>/.test(san.strike), san.strike);
    check('sanitise', '<name> stays visible text', /Dear &lt;name&gt;, hello/.test(san.name), san.name);
    check('sanitise', 'table alignment kept', /align="center"/.test(san.table) && /align="right"/.test(san.table), san.table);
    check('sanitise', 'task checkbox becomes a symbol', /\u{2611}/u.test(san.task), san.task);
    check('sanitise', 'code block keeps language class and escapes <', /class="language-js"/.test(san.code) && /1 &lt; 2/.test(san.code), san.code);
    check('sanitise', 'single newline is a line break', /one<br>two/.test(san.breaks), san.breaks);
    check('sanitise', '>! lines are one spoiler block (LessWrong markup)', /^<div class="spoilers"><p>hidden <em>words<\/em><\/p>\s*<p>second<\/p>\s*<\/div>\s*$/.test(san.spoiler), san.spoiler);
    check('sanitise', 'uploaded images (/u/…) are images with their size; remote and odd paths are not', san.images.includes('<img src="/u/qa-harbour-01.webp" alt="Harbour" width="1200" height="800">') && /<a href="https:\/\/x\.test\/y\.png" rel="noopener">remote<\/a>/.test(san.images) && (san.images.match(/<img/g) || []).length === 1 && / odd /.test(san.images) && / short</.test(san.images), san.images);
    check('sanitise', 'escaped \\>!, "> !" and raw HTML are not spoilers', !/<div/.test(san.notSpoiler) && /&gt;! escaped/.test(san.notSpoiler) && /<blockquote>/.test(san.notSpoiler) && /&lt;div data-wh-spoiler&gt;raw/.test(san.notSpoiler), san.notSpoiler);

    const plain = await page.evaluate((m) => window.WH.markdownToPlain(m), ROUND_TRIP_MD);
    fs.writeFileSync(path.join(OUT, 'markdownToPlain.txt'), plain);
    check('plain', 'no Markdown marks left', !/\*\*|^#|^>|~~|`/m.test(plain), plain);
    check('plain', 'bullets and numbers', /^\u{2022} First item$/mu.test(plain) && /^1\. One$/m.test(plain) && /^ {2}\u{2022} Nested item$/mu.test(plain), plain);
    check('plain', 'links become text (url)', /a link \(https:\/\/example\.com\/page\?a=1&b=2\)/.test(plain), plain);
    check('plain', 'quote text kept', /A quote line\ncontinues here/.test(plain), plain);
    check('plain', 'table as tab-separated rows', /Apples\t3/.test(plain), plain);
    check('plain', 'spoiler labelled, its lines kept together', /\n\n\[Spoiler\]\nA spoiler line\nwith a second paragraph\n\n/.test(plain), plain);
  }

  // --- 4. copyRich (async clipboard) ---------------------------------------
  // LessWrong and Substack have their own title field: their copy is the body alone. Google Docs has
  // none: its copy starts with the title, and the body's headings move down a level.
  {
    await page.bringToFront();
    const body = '# Section\n\nSome **bold** text and a [link](https://example.com).';
    const r = await page.evaluate(async (b) => {
      const read = async () => {
        const out = { html: '', plain: '' };
        try {
          for (const it of await navigator.clipboard.read()) {
            if (it.types.includes('text/html')) out.html = await (await it.getType('text/html')).text();
            if (it.types.includes('text/plain')) out.plain = await (await it.getType('text/plain')).text();
          }
        } catch (e) {
          out.html = 'READ FAILED: ' + e.message;
        }
        return out;
      };
      const okBody = await window.WH.copyRich(b);
      const bodyOnly = await read();
      const okDocs = await window.WH.copyRich(b, 'My Title', 'gdocs');
      const docs = await read();
      return {
        okBody, bodyOnly, okDocs, docs,
        lw: window.WH.richCopyData(b, 'My Title', 'lesswrong'),
        sub: window.WH.richCopyData(b, 'My Title', 'substack'),
        gd: window.WH.richCopyData(b, 'My Title', 'gdocs'),
        plainBody: window.WH.richCopyData(b),
      };
    }, body);
    check('clipboard', 'copyRich(body) resolves true: body only, marker and formatting', r.okBody === true && !/My Title/.test(r.bodyOnly.html) && /<h1>Section<\/h1>/.test(r.bodyOnly.html) && /data-writehaven-copy/.test(r.bodyOnly.html) && /<strong>bold<\/strong>/.test(r.bodyOnly.html) && r.bodyOnly.plain === body, JSON.stringify(r.bodyOnly));
    check('clipboard', 'copy for Google Docs: the title is the only <h1>, body headings one level down', r.okDocs === true && (r.docs.html.match(/<h1[\s>]/g) || []).length === 1 && /<h1>My Title<\/h1><h2>Section<\/h2>/.test(r.docs.html) && r.docs.plain === '# My Title\n\n' + body, JSON.stringify(r.docs));
    check('clipboard', 'copy for LessWrong / Substack: no title even when one is passed', !/My Title/.test(r.lw.html + r.lw.plain + r.sub.html + r.sub.plain) && r.lw.plain === body && /<h1>Section<\/h1>/.test(r.lw.html), JSON.stringify([r.lw, r.sub]));
    // Chrome normalises link targets when it reads the clipboard ("https://example.com/").
    const normHrefs = (h) => h.replace(/href="([^"]*)"/g, (m, u) => 'href="' + new URL(u).href + '"');
    check('clipboard', 'richCopyData = what copyRich writes', normHrefs(r.gd.html) === normHrefs(r.docs.html) && r.gd.plain === r.docs.plain && normHrefs(r.plainBody.html) === normHrefs(r.bodyOnly.html), JSON.stringify([r.gd, r.docs, r.plainBody, r.bodyOnly]));
    const sp = await page.evaluate(() => {
      const dt = new DataTransfer();
      window.WH.fillClipboard(dt, 'Before.\n\n>! Hidden twist.');
      const html = dt.getData('text/html');
      return { html, back: window.WH.htmlToMarkdown(html) };
    });
    const ci = await page.evaluate((m) => {
      const dt = new DataTransfer();
      window.WH.fillClipboard(dt, m);
      const html = dt.getData('text/html');
      return { html, plain: dt.getData('text/plain'), back: window.WH.htmlToMarkdown(html) };
    }, POST4.body);
    check('clipboard', 'uploaded images copy by full address (the Markdown flavour stays as written) and read back as uploads', ci.html.includes('<img src="' + BASE + '/u/hotlink-ok/qa-harbour-01.webp" alt="The harbour at dusk" width="1200" height="800" style="max-width:100%;height:auto;">') && ci.html.includes('<img src="' + BASE + '/u/hotlink-ok/qa-sketch-02.webp" alt="Pencil sketch" style="max-width:100%;height:auto;">') && ci.plain === POST4.body && ci.back === POST4.body, JSON.stringify(ci));
    check('clipboard', 'spoiler copies as LessWrong markup with a visible label, and reads back', /<div class="spoilers"><p data-wh-spoiler-label="1"><strong>Spoiler<\/strong><\/p><p>Hidden twist\.<\/p>/.test(sp.html) && sp.back === 'Before.\n\n>! Hidden twist.', JSON.stringify(sp));
  }

  // Real copy event (Ctrl+C) through fillClipboard, and the execCommand fallback of copyRich.
  {
    await page.evaluate(() => {
      window.__mdForCopy = 'Copied **from the editor** with a [link](https://example.com/c).';
      const sel = window.getSelection();
      const r = document.createRange();
      r.selectNodeContents(document.querySelector('.editor p'));
      sel.removeAllRanges();
      sel.addRange(r);
    });
    await page.keyboard.press('Control+C');
    const ev = await page.evaluate(async () => {
      const out = { html: '', plain: '' };
      for (const it of await navigator.clipboard.read()) {
        if (it.types.includes('text/html')) out.html = await (await it.getType('text/html')).text();
        if (it.types.includes('text/plain')) out.plain = await (await it.getType('text/plain')).text();
      }
      window.__mdForCopy = null;
      return out;
    });
    check('clipboard', 'Ctrl+C copy event: Markdown as text/plain, marked HTML as text/html', ev.plain === 'Copied **from the editor** with a [link](https://example.com/c).' && /data-writehaven-copy/.test(ev.html) && /<strong>from the editor<\/strong>/.test(ev.html), JSON.stringify(ev));
    await page.evaluate(() => {
      window.__ci = window.ClipboardItem;
      window.ClipboardItem = undefined;
      window.__copyResult = undefined;
    });
    await page.click('#qa-copy');
    await page.waitForFunction(() => window.__copyResult !== undefined, null, { timeout: 5000 });
    const legacy = await page.evaluate(async () => {
      window.ClipboardItem = window.__ci;
      const out = { ok: window.__copyResult, html: '', plain: '' };
      for (const it of await navigator.clipboard.read()) {
        if (it.types.includes('text/html')) out.html = await (await it.getType('text/html')).text();
        if (it.types.includes('text/plain')) out.plain = await (await it.getType('text/plain')).text();
      }
      return out;
    });
    check('clipboard', 'copyRich fallback without ClipboardItem (execCommand) still copies rich HTML (Google Docs, with title)', legacy.ok === true && /<h1>Legacy title<\/h1>/.test(legacy.html) && legacy.plain.startsWith('# Legacy title'), JSON.stringify(legacy));
  }

  // --- 5. Exports ----------------------------------------------------------
  const files = {};
  const singleFormats = ['md', 'txt', 'html', 'docx'];
  for (const fmt of singleFormats) {
    files['post-' + fmt] = await captureDownload(page, ([p, f]) => window.WH.exportPost(p, f), [POST1, fmt]);
  }
  files['untitled-md'] = await captureDownload(page, ([p, f]) => window.WH.exportPost(p, f), [POST3, 'md']);
  for (const fmt of singleFormats) {
    files['img-' + fmt] = await captureDownload(page, ([p, f]) => window.WH.exportPost(p, f), [POST4, fmt]);
  }
  for (const fmt of ['md', 'txt', 'html', 'docx', 'epub']) {
    files['all-' + fmt] = await captureDownload(page, ([ps, f, b]) => window.WH.exportAll(ps, f, b), [ALL, fmt, BOOK]);
  }
  check('export', 'file names', files['post-md'].name === 'the-lighthouse-keepers-year.md' && files['all-epub'].name === 'writehaven-anas-posts.epub' && files['untitled-md'].name === 'untitled.md', JSON.stringify(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.name]))));

  const mdOut = fs.readFileSync(files['post-md'].file, 'utf8');
  check('export', 'md = # title + body', mdOut === '# ' + POST1.title + '\n\n' + POST1.body + '\n', lineDiff('# ' + POST1.title + '\n\n' + POST1.body + '\n', mdOut));
  const txtOut = fs.readFileSync(files['post-txt'].file, 'utf8');
  check('export', 'txt has title, underline, bullets, no marks', txtOut.startsWith(POST1.title + '\n====') && /\u{2022} Trim the wick/u.test(txtOut) && !/\*\*|~~|^#/m.test(txtOut), txtOut.slice(0, 400));
  const allMd = fs.readFileSync(files['all-md'].file, 'utf8');
  check('export', 'all md: book title, each post titled, separators', allMd.startsWith('# ' + BOOK + '\n\n---\n\n# ' + POST1.title) && allMd.includes('# Notes from the Harbour') && allMd.includes('# Untitled'), allMd.slice(0, 300));
  const allTxt = fs.readFileSync(files['all-txt'].file, 'utf8');
  check('export', 'all txt: titles underlined', allTxt.startsWith(BOOK + '\n====') && allTxt.includes('Notes from the Harbour\n------'), allTxt.slice(0, 300));
  const htmlOut = fs.readFileSync(files['post-html'].file, 'utf8');
  check('export', 'html is a complete document', /^<!DOCTYPE html>/.test(htmlOut) && /<meta charset="utf-8">/.test(htmlOut) && /<title>The Lighthouse Keeper’s Year<\/title>/.test(htmlOut) && /<style>/.test(htmlOut) && !/<script/i.test(htmlOut), htmlOut.slice(0, 500));
  check('export', 'html: post title is the only h1, body keeps ## / ### levels', (htmlOut.match(/<h1/g) || []).length === 1 && /<h1 class="post-title">/.test(htmlOut) && /<h2>The routine<\/h2>/.test(htmlOut) && /<h3>Supplies<\/h3>/.test(htmlOut), htmlOut.match(/<h[1-6][^>]*>[^<]*/g));
  check('export', 'txt: spoiler labelled [Spoiler]', txtOut.includes('\n\n[Spoiler]\n' + SPOILER_TEXT + '\n\n'), txtOut.slice(-400));
  {
    const abs = (p) => BASE + (/^\/u\/[^/]+$/.test(p) ? '/u/hotlink-ok/' + p.slice(3) : p);
    const imgMd = fs.readFileSync(files['img-md'].file, 'utf8');
    const wantMd = '# ' + POST4.title + '\n\n' + POST4.body.split('](/u/').join('](' + BASE + '/u/hotlink-ok/') + '\n';
    check('images', 'md: uploaded images by full address', imgMd === wantMd, lineDiff(wantMd, imgMd));
    const imgTxt = fs.readFileSync(files['img-txt'].file, 'utf8');
    check('images', 'txt: images as [image: alt] (address)', imgTxt.includes('\n[image: The harbour at dusk] (' + abs('/u/qa-harbour-01.webp') + ')\n') && imgTxt.includes('She drew it from memory: [image: Pencil sketch] (' + abs('/u/qa-sketch-02.webp') + ') and pinned it by the lamp.') && imgTxt.includes('\n[image] (' + abs('/u/qa-lamp-03.jpg') + ')\n'), imgTxt);
    const imgHtml = fs.readFileSync(files['img-html'].file, 'utf8');
    check('images', 'html: images by full address; an image on its own line is a figure captioned with its alt text', imgHtml.includes('<figure class="image"><img src="' + abs('/u/qa-harbour-01.webp') + '" alt="The harbour at dusk" width="1200" height="800" loading="lazy" decoding="async"><figcaption>The harbour at dusk</figcaption></figure>') && imgHtml.includes('She drew it from memory: <img src="' + abs('/u/qa-sketch-02.webp') + '" alt="Pencil sketch" loading="lazy" decoding="async"> and pinned it') && imgHtml.includes('<figure class="image"><img src="' + abs('/u/qa-lamp-03.jpg') + '" alt="" loading="lazy" decoding="async"></figure>') && /figure\.image figcaption/.test(imgHtml), (imgHtml.match(/<(?:img|figure|figcaption)[^>]*>/g) || []).join('\n'));
  }
  check('export', 'html: spoiler is a <details> the reader opens, styled', /<details class="spoiler"><summary>Spoiler<\/summary><p>The keeper was the lamp all along\.<\/p>\s*<\/details>/.test(htmlOut) && /details\.spoiler > summary/.test(htmlOut), (htmlOut.match(/[^\n]*spoiler[^\n]*/g) || []).join('\n'));

  // DOCX: structure, XML well-formedness (browser + expat), pandoc can read it.
  for (const key of ['post-docx', 'all-docx']) {
    const buf = fs.readFileSync(files[key].file);
    const z = unzipSync(new Uint8Array(buf));
    const names = Object.keys(z);
    const need = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/settings.xml', 'word/footer1.xml', 'word/_rels/document.xml.rels', 'docProps/core.xml', 'docProps/app.xml'];
    check('docx', key + ': all parts present', need.every((n) => names.includes(n)), names.join(', '));
    for (const n of names) {
      if (!/\.(?:xml|rels)$/.test(n)) continue; // word/media/* are images
      const err = await xmlError(page, strFromU8(z[n]), 'application/xml');
      check('docx', key + ': well-formed ' + n, !err, err);
    }
    const doc = strFromU8(z['word/document.xml']);
    const rels = strFromU8(z['word/_rels/document.xml.rels']);
    const ids = [...doc.matchAll(/r:id="([^"]+)"/g)].map((m) => m[1]);
    check('docx', key + ': every r:id has a relationship', ids.every((id) => rels.includes('Id="' + id + '"')), ids.join(','));
    check('docx', key + ': hyperlink target present', rels.includes('https://en.wikipedia.org/wiki/Fresnel_lens'), rels.slice(0, 500));
    const styles = strFromU8(z['word/styles.xml']);
    const defined = new Set([...styles.matchAll(/w:styleId="([^"]+)"/g)].map((m) => m[1]));
    const undef = [...new Set([...doc.matchAll(/<w:(?:pStyle|rStyle|tblStyle) w:val="([^"]+)"/g)].map((m) => m[1]))].filter((s) => !defined.has(s));
    check('docx', key + ': every style used is defined', undef.length === 0, undef.join(', '));
    check('docx', key + ': spoiler under a "Spoiler" label, in the Spoiler style', /<w:pStyle w:val="SpoilerLabel"\/><\/w:pPr><w:r><w:t xml:space="preserve">Spoiler<\/w:t><\/w:r><\/w:p><w:p><w:pPr><w:pStyle w:val="Spoiler"\/><\/w:pPr><w:r><w:t xml:space="preserve">The keeper was the lamp all along\.<\/w:t><\/w:r><\/w:p>/.test(doc), (doc.match(/.{0,200}Spoiler.{0,300}/) || [''])[0]);
    let expat = '';
    try {
      expat = execRetry('python3', [path.join(here, 'xmlcheck.py'), files[key].file], { encoding: 'utf8' });
      check('docx', key + ': expat strict parse of every part', !/FAIL/.test(expat), expat);
    } catch (e) {
      check('docx', key + ': expat strict parse of every part', false, String(e.stdout || e.message));
    }
    const asMd = pandoc(files[key].file, 'markdown');
    fs.writeFileSync(path.join(OUT, key + '.pandoc.md'), asMd);
    check('docx', key + ': pandoc reads text, bold, link, list, table', /\*\*bold\*\*/.test(asMd) && /Fresnel lens\]\(https:\/\/en\.wikipedia\.org\/wiki\/Fresnel_lens\)/.test(asMd) && /Trim the wick/.test(asMd) && /Paraffin/.test(asMd) && /~~ink she regretted~~/.test(asMd), asMd.slice(0, 1500));
  }

  // DOCX with uploaded images: media parts, content types, relationships, drawings, sizes, captions.
  for (const key of ['img-docx', 'all-docx']) {
    const z = unzipSync(new Uint8Array(fs.readFileSync(files[key].file)));
    const names = Object.keys(z);
    const doc = strFromU8(z['word/document.xml']);
    const rels = strFromU8(z['word/_rels/document.xml.rels']);
    const ct = strFromU8(z['[Content_Types].xml']);
    const media = names.filter((n) => n.startsWith('word/media/')).sort();
    const sig = (u8) => (u8[0] === 0x89 && u8[1] === 0x50 ? 'png' : u8[0] === 0xff && u8[1] === 0xd8 ? 'jpg' : u8[0] === 0x47 && u8[1] === 0x49 ? 'gif' : '?');
    const kinds = media.map((n) => n.slice('word/media/'.length) + ':' + sig(z[n]));
    check('docx-images', key + ': opaque WebP embedded as JPEG, transparent WebP as PNG, JPEG byte for byte', JSON.stringify(kinds) === JSON.stringify(['image1.jpg:jpg', 'image2.png:png', 'image3.jpg:jpg']) && Buffer.from(z['word/media/image3.jpg']).equals(fs.readFileSync(path.join(here, 'fixtures/uploads/qa-lamp-03.jpg'))), kinds.join(', '));
    check('docx-images', key + ': content types for the image formats', /<Default Extension="jpg" ContentType="image\/jpeg"\/>/.test(ct) && /<Default Extension="png" ContentType="image\/png"\/>/.test(ct), ct);
    const imgRels = [...rels.matchAll(/<Relationship Id="([^"]+)" Type="[^"]*\/relationships\/image" Target="([^"]+)"\/>/g)].map((m) => ({ id: m[1], target: m[2] }));
    check('docx-images', key + ': image relationships point at the media parts', imgRels.length === 3 && imgRels.every((r) => names.includes('word/' + r.target)), JSON.stringify(imgRels));
    const info = [...doc.matchAll(/<wp:inline[^>]*>([\s\S]*?)<\/wp:inline>/g)].map((m) => {
      const ext = /<wp:extent cx="(\d+)" cy="(\d+)"\/>/.exec(m[1]);
      return { cx: +ext[1], cy: +ext[2], id: /<wp:docPr id="(\d+)"/.exec(m[1])[1], descr: /<wp:docPr [^>]*descr="([^"]*)"/.exec(m[1])[1], embed: /r:embed="([^"]+)"/.exec(m[1])[1] };
    });
    check('docx-images', key + ': three drawings with unique ids, alt text, resolving embeds', info.length === 3 && new Set(info.map((i) => i.id)).size === 3 && info.every((i) => imgRels.some((r) => r.id === i.embed)) && info.map((i) => i.descr).join('|') === 'The harbour at dusk|Pencil sketch|', JSON.stringify(info));
    const pg = /<w:pgSz w:w="(\d+)" w:h="(\d+)"\/>/.exec(doc);
    const mar = /<w:pgMar [^>]*w:right="(\d+)"[^>]*w:left="(\d+)"/.exec(doc);
    const maxW = (+pg[1] - +mar[1] - +mar[2]) * 635;
    const ratio = (i) => i.cx / i.cy;
    check('docx-images', key + ': sizes are the pixels at 96 dpi, scaled down to the text width, aspect kept', info.length === 3 && info[0].cx === maxW && Math.abs(ratio(info[0]) - 1.5) < 0.001 && info[1].cx === 300 * 9525 && info[1].cy === 200 * 9525 && info[2].cx === Math.min(640 * 9525, maxW) && Math.abs(ratio(info[2]) - 4 / 3) < 0.001, JSON.stringify({ maxW, info }));
    check('docx-images', key + ': own-line images are centred figures; the alt text is the caption', (doc.match(/<w:pStyle w:val="Picture"\/>/g) || []).length === 2 && /<w:pStyle w:val="PictureCaption"\/><\/w:pPr><w:r><w:t xml:space="preserve">The harbour at dusk<\/w:t><\/w:r><\/w:p>/.test(doc) && (doc.match(/w:val="PictureCaption"/g) || []).length === 1, (doc.match(/.{0,120}Picture.{0,160}/g) || []).join('\n'));
    const mediaDir = path.join(OUT, key + '-media');
    fs.rmSync(mediaDir, { recursive: true, force: true });
    execRetry(PANDOC, [files[key].file, '-t', 'markdown', '--extract-media=' + mediaDir, '-o', path.join(OUT, key + '.media.md')]);
    const extracted = fs.existsSync(path.join(mediaDir, 'media')) ? fs.readdirSync(path.join(mediaDir, 'media')).sort() : [];
    check('docx-images', key + ': pandoc extracts the three images', extracted.length === 3, extracted.join(', '));
    if (key === 'img-docx') {
      try {
        const out = execRetry('python3', [path.join(here, 'xmlcheck.py'), files[key].file], { encoding: 'utf8' });
        check('docx-images', key + ': expat strict parse of every XML part', !/FAIL/.test(out), out);
      } catch (e) {
        check('docx-images', key + ': expat strict parse of every XML part', false, String(e.stdout || e.message));
      }
    }
  }

  // An image the host removed: the app then serves an SVG placeholder under the original name,
  // which createImageBitmap can't decode. The export still embeds a picture (the placeholder).
  {
    const POST5 = { title: 'Removed', body: 'Before.\n\n![A photo](/u/qa-removed-04.webp#w=1200&h=675)\n\nAfter.' };
    const d = await captureDownload(page, ([p, f]) => window.WH.exportPost(p, f), [POST5, 'docx']);
    const z = unzipSync(new Uint8Array(fs.readFileSync(d.file)));
    const media = Object.keys(z).filter((n) => n.startsWith('word/media/'));
    const doc = strFromU8(z['word/document.xml']);
    const jpeg = media.length === 1 && z[media[0]][0] === 0xff && z[media[0]][1] === 0xd8;
    check('docx-images', 'host-removed image (SVG placeholder) still embedded as a picture', media.join() === 'word/media/image1.jpg' && jpeg && /<wp:inline/.test(doc) && /descr="A photo"/.test(doc), media.join(', ') + ' | ' + (doc.match(/<w:drawing>[\s\S]{0,240}/) || ['no drawing'])[0]);
  }

  // EPUB: mimetype first + stored, container, opf, nav, every XHTML strict-parsed.
  {
    const buf = fs.readFileSync(files['all-epub'].file);
    const h = zipHeader(buf);
    check('epub', 'mimetype is the first entry, stored, no extra field', h.sig === 0x04034b50 && h.name === 'mimetype' && h.method === 0 && h.extraLen === 0 && h.data.startsWith('application/epub+zip'), JSON.stringify(h));
    const z = unzipSync(new Uint8Array(buf));
    const names = Object.keys(z);
    check('epub', 'required files', ['META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/nav.xhtml', 'OEBPS/toc.ncx', 'OEBPS/style.css', 'OEBPS/title.xhtml', 'OEBPS/post-1.xhtml', 'OEBPS/post-2.xhtml', 'OEBPS/post-3.xhtml'].every((n) => names.includes(n)), names.join(', '));
    const extract = path.join(OUT, 'epub-extract');
    for (const n of names) {
      const t = path.join(extract, n);
      fs.mkdirSync(path.dirname(t), { recursive: true });
      fs.writeFileSync(t, Buffer.from(z[n]));
      if (/\.(xhtml)$/.test(n)) {
        const err = await xmlError(page, strFromU8(z[n]), 'application/xhtml+xml');
        check('epub', 'XHTML well-formed ' + n, !err, err);
      } else if (/\.(xml|opf|ncx)$/.test(n)) {
        const err = await xmlError(page, strFromU8(z[n]), 'application/xml');
        check('epub', 'XML well-formed ' + n, !err, err);
      }
    }
    const opf = strFromU8(z['OEBPS/content.opf']);
    const ch1 = strFromU8(z['OEBPS/post-1.xhtml']);
    {
      const imgs = names.filter((n) => n.startsWith('OEBPS/images/')).sort();
      check('epub', 'uploaded images embedded (opaque WebP as JPEG, transparent WebP as PNG, JPEG as is)', JSON.stringify(imgs) === JSON.stringify(['OEBPS/images/img-1.jpg', 'OEBPS/images/img-2.png', 'OEBPS/images/img-3.jpg']), imgs.join(', '));
      check('epub', 'images in the manifest with their media types', /<item id="img-1" href="images\/img-1\.jpg" media-type="image\/jpeg"\/>/.test(opf) && /<item id="img-2" href="images\/img-2\.png" media-type="image\/png"\/>/.test(opf) && /<item id="img-3" href="images\/img-3\.jpg" media-type="image\/jpeg"\/>/.test(opf), opf);
      const listed = [...opf.matchAll(/ href="([^"]+)"/g)].map((m) => 'OEBPS/' + m[1]);
      const unlisted = names.filter((n) => !['mimetype', 'META-INF/container.xml', 'OEBPS/content.opf'].includes(n) && !listed.includes(n));
      check('epub', 'every file is in the manifest and every manifest item exists', !unlisted.length && listed.every((n) => names.includes(n)), JSON.stringify({ unlisted, missing: listed.filter((n) => !names.includes(n)) }));
      const ch4 = strFromU8(z['OEBPS/post-4.xhtml']);
      const srcs = [...ch4.matchAll(/<img src="([^"]+)" alt="([^"]*)"/g)].map((m) => m[1] + '|' + m[2]);
      check('epub', 'chapter images point at the embedded files, with alt text, size and caption', srcs.join(',') === 'images/img-1.jpg|The harbour at dusk,images/img-2.png|Pencil sketch,images/img-3.jpg|' && /<figure class="image"><img src="images\/img-1\.jpg" alt="The harbour at dusk" width="1200" height="800" \/><figcaption>The harbour at dusk<\/figcaption><\/figure>/.test(ch4), ch4);
    }
    check('epub', 'spoiler is a <details> (shown open by readers without it)', /<details class="spoiler"><summary>Spoiler<\/summary><p>The keeper was the lamp all along\.<\/p>\s*<\/details>/.test(ch1), (ch1.match(/[^\n]*spoiler[^\n]*/g) || []).join('\n'));
    check('epub', 'opf metadata', /unique-identifier="bookid"/.test(opf) && /<dc:identifier id="bookid">urn:uuid:[0-9a-f-]{36}<\/dc:identifier>/.test(opf) && /<dc:title>Writehaven — Ana’s posts<\/dc:title>/.test(opf) && /<dc:language>en<\/dc:language>/.test(opf) && /<meta property="dcterms:modified">\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ<\/meta>/.test(opf), opf);
    try {
      const out = execRetry('python3', [path.join(here, 'xmlcheck.py'), files['all-epub'].file], { encoding: 'utf8' });
      check('epub', 'expat strict parse of every part', !/FAIL/.test(out), out);
    } catch (e) {
      check('epub', 'expat strict parse of every part', false, String(e.stdout || e.message));
    }
    const asMd = pandoc(files['all-epub'].file, 'markdown');
    fs.writeFileSync(path.join(OUT, 'all-epub.pandoc.md'), asMd);
    check('epub', 'pandoc reads every chapter', /Lighthouse Keeper/.test(asMd) && /Notes from the Harbour/.test(asMd) && /untitled scrap/.test(asMd), asMd.slice(0, 800));
  }

  // --- 6. Screenshots of the standalone HTML exports and an EPUB chapter ---
  {
    const p2 = await context.newPage();
    await p2.setViewportSize({ width: 1280, height: 900 });
    await p2.goto(BASE + '/qa-out/downloads/' + encodeURIComponent(files['post-html'].name));
    await p2.evaluate(() => document.fonts.ready);
    await p2.screenshot({ path: path.join(OUT, 'html-export-desktop.png'), fullPage: true });
    await p2.setViewportSize({ width: 390, height: 844 });
    await p2.screenshot({ path: path.join(OUT, 'html-export-phone.png'), fullPage: false });
    await p2.setViewportSize({ width: 1280, height: 900 });
    await p2.goto(BASE + '/qa-out/downloads/' + encodeURIComponent(files['all-html'].name));
    await p2.screenshot({ path: path.join(OUT, 'html-export-all-titlepage.png'), fullPage: false });
    await p2.goto(BASE + '/qa-out/epub-extract/OEBPS/post-1.xhtml');
    await p2.setViewportSize({ width: 600, height: 900 });
    await p2.screenshot({ path: path.join(OUT, 'epub-chapter.png'), fullPage: true });
    await p2.goto(BASE + '/qa-out/epub-extract/OEBPS/title.xhtml');
    await p2.screenshot({ path: path.join(OUT, 'epub-titlepage.png'), fullPage: false });
    await p2.close();
  }

  // --- 7. PDF print view ---------------------------------------------------
  async function printFlow(label, fn, arg, expectTitle) {
    await page.evaluate(() => {
      window.__printed = 0;
      window.print = () => {
        window.__printed++;
      };
    });
    const titleBefore = await page.title();
    await page.evaluate(fn, arg);
    const state = await page.evaluate(() => ({
      printed: window.__printed,
      root: !!document.getElementById('wh-print'),
      cls: document.documentElement.classList.contains('wh-printing'),
      title: document.title,
      hiddenOnScreen: getComputedStyle(document.getElementById('wh-print') || document.body).display === 'none',
      fontsOk: document.fonts.check('300 16px Newsreader') && document.fonts.check('italic 400 16px Newsreader'),
      spoiler: (() => {
        const s = document.querySelector('#wh-print .spoiler');
        return s ? { label: (s.querySelector('.spoiler-label') || {}).textContent, text: s.textContent } : null;
      })(),
      imgs: Array.from(document.querySelectorAll('#wh-print img')).map((i) => ({ src: i.getAttribute('src'), loaded: i.complete && i.naturalWidth > 0 })),
    }));
    check('pdf', label + ': images loaded before print() (' + state.imgs.length + ')', state.imgs.every((i) => i.loaded) && state.imgs.length === (label === 'all' ? 3 : 0), JSON.stringify(state.imgs));
    check('pdf', label + ': print view mounted, print() called once', state.printed === 1 && state.root && state.cls, JSON.stringify(state));
    check('pdf', label + ': spoiler printed in a labelled box', !!state.spoiler && state.spoiler.label === 'Spoiler' && state.spoiler.text.includes(SPOILER_TEXT), JSON.stringify(state.spoiler));
    check('pdf', label + ': hidden on screen while mounted', state.hiddenOnScreen, JSON.stringify(state));
    check('pdf', label + ': Newsreader faces loaded before print', state.fontsOk, JSON.stringify(state));
    check('pdf', label + ': document title used for the PDF name while printing', state.title === expectTitle, state.title);
    await page.emulateMedia({ media: 'print' });
    await page.setViewportSize({ width: 794, height: 1123 });
    const visible = await page.evaluate(() => ({
      app: getComputedStyle(document.getElementById('app')).display,
      toast: getComputedStyle(document.querySelector('.toast')).display,
      print: getComputedStyle(document.getElementById('wh-print')).display,
      bodyOverflow: getComputedStyle(document.body).overflow,
      font: getComputedStyle(document.querySelector('#wh-print .wh-doc')).fontFamily,
    }));
    check('pdf', label + ': app hidden, print view shown in print media', visible.app === 'none' && visible.toast === 'none' && visible.print === 'block' && visible.bodyOverflow === 'visible', JSON.stringify(visible));
    await page.screenshot({ path: path.join(OUT, 'print-view-' + label + '.png'), fullPage: true });
    const pdfA4 = path.join(OUT, 'print-' + label + '-a4.pdf');
    await page.pdf({ path: pdfA4, format: 'A4', printBackground: true });
    // Chrome fires afterprint once the PDF is printed: the view must have cleaned itself up.
    const after = await page.evaluate(() => ({ root: !!document.getElementById('wh-print'), cls: document.documentElement.classList.contains('wh-printing'), title: document.title }));
    check('pdf', label + ': cleaned up after printing (afterprint), title restored', !after.root && !after.cls && after.title === titleBefore, JSON.stringify(after));
    await page.evaluate(fn, arg);
    const pdfLetter = path.join(OUT, 'print-' + label + '-letter.pdf');
    await page.pdf({ path: pdfLetter, format: 'Letter', printBackground: true });
    await page.emulateMedia({ media: 'screen' });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    const after2 = await page.evaluate(() => !!document.getElementById('wh-print') || document.documentElement.classList.contains('wh-printing'));
    check('pdf', label + ': second print cleaned up too', !after2, String(after2));
    return { pdfA4, pdfLetter };
  }
  const single = await printFlow('single', ([p]) => window.WH.exportPost(p, 'pdf'), [POST1], POST1.title);
  const multi = await printFlow('all', ([ps, b]) => window.WH.exportAll(ps, 'pdf', b), [ALL, BOOK], BOOK);
  const pagesDir = path.join(OUT, 'pdf-pages');
  fs.mkdirSync(pagesDir, { recursive: true });
  for (const [label, file] of [['single-a4', single.pdfA4], ['single-letter', single.pdfLetter], ['all-a4', multi.pdfA4], ['all-letter', multi.pdfLetter]]) {
    execRetry('pdftoppm', ['-r', '60', '-png', file, path.join(pagesDir, label)]);
    const text = execRetry('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
    fs.writeFileSync(path.join(pagesDir, label + '.txt'), text);
  }
  {
    const pages = execRetry('pdftotext', [multi.pdfA4, '-'], { encoding: 'utf8' }).split('\f');
    const startPage = (title) => pages.findIndex((t, i) => i > 0 && t.trim().startsWith(title));
    const p1 = startPage('The Lighthouse Keeper’s Year');
    const p2 = startPage('Notes from the Harbour');
    const p3 = startPage('Untitled');
    check('pdf', 'all: title page first, each post starts a new page', pages[0].includes('Writehaven') && pages[0].replace(/\s+/g, '').toUpperCase().includes('CONTENTS') && p1 >= 1 && p2 > p1 && p3 > p2, JSON.stringify({ count: pages.length, p1, p2, p3, first: pages[0].slice(0, 200) }));
    const numbered = pages.slice(1).some((t) => /\n\s*\d+\s*$/.test(t.trimEnd()));
    const letterText = execRetry('pdftotext', [multi.pdfLetter, '-'], { encoding: 'utf8' });
    check('pdf', 'all (Letter): same structure', letterText.includes('Notes from the Harbour') && !letterText.includes('App chrome'), letterText.slice(0, 300));
    check('pdf', 'all: page numbers printed in the footer', numbered, pages.slice(1, 3).join('\n----\n').slice(-400));
    const singleText = execRetry('pdftotext', [single.pdfA4, '-'], { encoding: 'utf8' });
    const listed = execRetry('pdfimages', ['-list', multi.pdfA4], { encoding: 'utf8' }).split('\n').slice(2).filter((l) => /\S/.test(l));
    check('pdf', 'all: the three uploaded images are printed', listed.length >= 3, listed.join('\n'));
    check('pdf', 'single: spoiler label and text in the PDF', /SPOILER\s+The keeper was the lamp all along\./.test(singleText), (singleText.match(/[^\n]*(?:SPOILER|keeper was)[^\n]*/g) || []).join('\n'));
  }

  // --- 8. Imports ----------------------------------------------------------
  {
    const imp = async (name, b64data, type) =>
      page.evaluate(
        async ([n, d, t]) => {
          const bin = atob(d);
          const u8 = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          try {
            const r = await window.WH.importFile(new File([u8], n, { type: t || '' }));
            return { ok: true, title: r.title, markdown: r.markdown };
          } catch (e) {
            return { ok: false, error: e.message };
          }
        },
        [name, b64data, type],
      );
    const enc = (s) => Buffer.from(s, 'utf8').toString('base64');
    let r = await imp('Essay.md', enc('# The *Real* Title\n\nBody with **bold**.\n'));
    check('import', '.md title from H1 (inline marks stripped), H1 removed', r.ok && r.title === 'The Real Title' && r.markdown === 'Body with **bold**.', JSON.stringify(r));
    r = await imp('my notes.txt', enc('Just text\r\nsecond line   \n'));
    check('import', '.txt title from file name, CRLF normalised', r.ok && r.title === 'my notes' && r.markdown === 'Just text\nsecond line', JSON.stringify(r));
    r = await imp('setext.markdown', enc('Title Here\n==========\n\nText.'));
    check('import', '.markdown setext H1 title', r.ok && r.title === 'Title Here' && r.markdown === 'Text.', JSON.stringify(r));
    r = await imp('later.md', enc('Intro paragraph.\n\n# Section one\n\nText.'));
    check('import', 'H1 not at the top stays in the body', r.ok && r.title === 'later' && r.markdown.startsWith('Intro paragraph.'), JSON.stringify(r));
    r = await imp(files['post-html'].name, b64(files['post-html'].file));
    check('import', '.html export round trip: title', r.ok && r.title === POST1.title, JSON.stringify(r).slice(0, 300));
    const expectHtml = POST1.body;
    check('import', '.html export round trip: body', r.ok && r.markdown === expectHtml, lineDiff(expectHtml, r.markdown || ''));
    r = await imp(files['img-html'].name, b64(files['img-html'].file));
    check('import', '.html export with images round trip: uploaded images come back as uploads', r.ok && r.title === POST4.title && r.markdown === POST4.body, lineDiff(POST4.body, r.markdown || ''));
    const before = await page.evaluate(() => typeof window.mammoth);
    r = await imp(files['post-docx'].name, b64(files['post-docx'].file));
    const after = await page.evaluate(() => typeof window.mammoth);
    check('import', 'mammoth loads lazily on first .docx', before === 'undefined' && after === 'object', before + ' -> ' + after);
    fs.writeFileSync(path.join(OUT, 'import-docx-roundtrip.md'), (r.markdown || r.error || '') + '\n');
    check('import', '.docx export round trip: title', r.ok && r.title === POST1.title, JSON.stringify(r).slice(0, 300));
    const mustHave = ['**bold**', '*italics*', '~~ink she regretted~~', '[Fresnel lens](https://en.wikipedia.org/wiki/Fresnel_lens)', '`lamp.log`', '# The routine', '## Supplies', '- Trim the wick', '  - with the small scissors', '1. Climb the 114 stairs', '> The sea does not care about your schedule.', '---', '| Paraffin | 40 l | from the mainland |', 'log("dusk", lamp.on)', '\n\n>! ' + SPOILER_TEXT + '\n\n', 'Привет, маяк.'];
    const missing = mustHave.filter((s) => !(r.markdown || '').includes(s));
    check('import', '.docx export round trip: constructs survive', r.ok && !missing.length, 'missing: ' + JSON.stringify(missing));
    // A .docx made by another tool (pandoc).
    const foreignMd = path.join(OUT, 'foreign.md');
    fs.writeFileSync(foreignMd, '# Foreign Doc\n\nA *pandoc* paragraph with **bold** and a [link](https://pandoc.org).\n\n- one\n- two\n\n> quoted\n');
    const foreignDocx = path.join(OUT, 'foreign.docx');
    execRetry(PANDOC, [foreignMd, '-o', foreignDocx]);
    r = await imp('foreign.docx', b64(foreignDocx));
    check('import', 'foreign .docx (pandoc)', r.ok && r.title === 'Foreign Doc' && /A \*pandoc\* paragraph with \*\*bold\*\* and a \[link\]\(https:\/\/pandoc\.org\/?\)\./.test(r.markdown) && /- one\n- two/.test(r.markdown), JSON.stringify(r));
    r = await imp('scan.pdf', enc('%PDF-1.4'));
    check('import', 'unsupported type: clear message', !r.ok && r.error === "Can't read this file: only .md, .txt, .docx and .html are supported", JSON.stringify(r));
    r = await imp('old.doc', enc('xx'));
    check('import', '.doc: specific message', !r.ok && /old Word format/.test(r.error), JSON.stringify(r));
    r = await imp('bad.docx', enc('PK\u{3}\u{4} this is not really a zip'));
    check('import', 'corrupt .docx: clear message', !r.ok && /damaged/.test(r.error), JSON.stringify(r));
    r = await imp('text.docx', enc('hello'));
    check('import', 'non-zip .docx: clear message', !r.ok && /doesn't look like a Word document/.test(r.error), JSON.stringify(r));
    r = await imp('big.md', Buffer.alloc(5 * 1024 * 1024 + 10, 97).toString('base64'));
    check('import', 'over 5 MB rejected', !r.ok && /5 MB/.test(r.error), JSON.stringify(r));
    r = await imp('utf16.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Hello “world”\n', 'utf16le')]).toString('base64'));
    check('import', 'UTF-16 text with BOM', r.ok && r.markdown === 'Hello “world”', JSON.stringify(r));
    r = await imp('legacy.txt', Buffer.from([0x93, 0x51, 0x75, 0x6f, 0x74, 0x65, 0x94, 0x20, 0x96, 0x20, 0x6f, 0x6b]).toString('base64'));
    check('import', 'Windows-1252 text', r.ok && r.markdown === '“Quote” – ok', JSON.stringify(r));
    r = await imp('binary.txt', Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0x00, 0x10, 0x20, 0x00, 0x00, 0x7f, 0x80]).toString('base64'));
    check('import', 'binary .txt rejected', !r.ok && /doesn't look like text/.test(r.error), JSON.stringify(r));
    r = await imp('page.htm', enc('<html><head><title>Ignored</title><style>p{}</style></head><body><h1>Web Title</h1><p>Some <em>text</em>.</p><script>x()</script></body></html>'));
    check('import', '.htm body only, H1 title', r.ok && r.title === 'Web Title' && r.markdown === 'Some *text*.', JSON.stringify(r));
  }

  // --- 9. Performance ------------------------------------------------------
  {
    const big = fs.readFileSync(path.join(here, 'fixtures/gdocs.html'), 'utf8');
    const t = await page.evaluate((h) => {
      const html = Array.from({ length: 60 }, () => h).join('');
      const t0 = performance.now();
      const md = window.WH.htmlToMarkdown(html);
      const t1 = performance.now();
      const words = md.split(/\s+/).length;
      const longMd = Array.from({ length: 120 }, (_, i) => 'Paragraph ' + i + ' with **bold**, *italic* and a [link](https://example.com/' + i + ') plus some ordinary words to make it longer than usual, roughly eighty words in total across the line so that the whole document approaches ten thousand words of realistic text for the export path to chew through without trouble.').join('\n\n');
      const t2 = performance.now();
      window.WH.markdownToHtml(longMd);
      const t3 = performance.now();
      return { htmlBytes: html.length, pasteMs: Math.round(t1 - t0), pasteWords: words, mdWords: longMd.split(/\s+/).length, renderMs: Math.round(t3 - t2) };
    }, big);
    timings.paste = t;
    check('perf', 'large Google Docs paste converts in under 2 s', t.pasteMs < 2000, JSON.stringify(t));
  }

  // --- 10. Property fuzz: visible text survives HTML -> Markdown -> HTML ----------
  for (const [mode, seed, count] of [['inline', 1, 1500], ['inline', 7, 1500], ['inline', 23, 1500], ['block', 3, 800], ['block', 11, 800], ['block', 29, 800]]) {
    const res = await page.evaluate(([s, c, m]) => window.runFuzz(s, c, m), [seed, count, mode]);
    fs.writeFileSync(path.join(OUT, 'fuzz-' + mode + '-' + seed + '.json'), JSON.stringify(res.failures.slice(0, 40), null, 2));
    check('fuzz', mode + ' seed ' + seed + ': ' + count + ' random documents keep their visible text', res.failures.length === 0, res.failures.length + ' failures; first: ' + JSON.stringify(res.failures[0]));
  }

  for (const seed of [5, 17, 41]) {
    const res = await page.evaluate((s) => window.runFormatFuzz(s, 1000), seed);
    fs.writeFileSync(path.join(OUT, 'fuzz-format-' + seed + '.json'), JSON.stringify(res.failures.slice(0, 40), null, 2));
    timings['format-' + seed] = { exactRate: +res.exactRate.toFixed(3), charKeep: +res.charKeep.toFixed(4), allDropped: res.allDropped };
    check('fuzz', 'format seed ' + seed + ': dense prose keeps formatting (no paragraph loses all of it, >=96% of formatted characters exact)', res.allDropped === 0 && res.charKeep >= 0.96, JSON.stringify(timings['format-' + seed]) + ' first diff: ' + JSON.stringify(res.failures[0]));
  }

  const csp = await page.evaluate(() => window.__csp);
  check('csp', 'no CSP violations (harness, mammoth, print view)', csp.length === 0, JSON.stringify(csp));
  check('console', 'no console errors', consoleErrors.length === 0, consoleErrors.join('\n'));
} catch (err) {
  check('runner', 'unexpected error', false, err && err.stack);
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}

const failed = results.filter((r) => !r.ok);
const byGroup = {};
for (const r of results) {
  byGroup[r.group] = byGroup[r.group] || { pass: 0, fail: 0 };
  byGroup[r.group][r.ok ? 'pass' : 'fail']++;
}
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ when: new Date().toISOString(), byGroup, timings, results }, null, 2));
console.log('\n' + JSON.stringify(byGroup));
console.log('timings', JSON.stringify(timings));
console.log(results.length - failed.length + '/' + results.length + ' checks passed');
process.exit(failed.length ? 1 : 0);
