# Writehaven

Writehaven is a web app for a live writing party. Everyone writes in their own editor for a few
hours while a public page shows the writing as it happens, on phones and on a projector. Each
hour has a word target, and the count rewards new writing rather than ways of gaming it. When the
host ends the party, the published pieces become an anthology.

It runs on Node 20 with no runtime dependencies: the server uses only Node's built-in modules,
and the front end is plain ES modules plus a few vendored bundles.

## What it does

- **The writer's page** (`/write`): a Markdown editor (CodeMirror 6) that reads as formatted text,
  with a formatting bar (floating on a desktop, above the keyboard on a phone) for bold, italics,
  headings, lists, quotes, links, images and footnotes. Posts open in tabs, each with planning
  notes. Edits are kept on the device (in IndexedDB, or localStorage where IndexedDB isn't
  available) until the server confirms them, and go out about once a second, so a dropped
  connection or a closed tab loses nothing as long as the browser allows that storage. Two tabs
  or devices writing in one post are merged.
- **Paste-in, copy-out, export**: pastes from Google Docs, Word, Notion, Apple Notes, Slack,
  LessWrong, Substack and web pages become clean Markdown. A post copies out as rich text and
  exports as Markdown, plain text, HTML, Word (.docx) or PDF (through the browser's print
  dialog); all of a writer's posts export together in the same formats or as an EPUB. .md,
  .txt, .html and .docx files can be imported.
- **The count** (`lib/score.js`): a word counts once it has stayed on the page for 90 seconds, and
  each piece of writing counts once: retyping, moving or re-pasting earns nothing, rewording
  does. A paste longer than a dozen words counts only for the words the writer says they wrote
  that day. Keyboard mash, lorem ipsum, word salad, repetition, macro-sized inserts and
  machine-steady typing are flagged for the host to check, never silently removed.
- **Hours**: a target per hour (400 words by default), with hours on the clock for everyone or
  counted from when each writer first opens the editor. A missed hour puts the writer out of the
  challenge (or only alerts the host); there are free passes, breaks that pause the clock or
  lower the target, and a way to leave the party without being out.
- **Public pages**: the live page (`/live`) streams the posts being written, anonymous unless
  the writer signs them; a projector view (`/live?wall`) with the join address and a QR code;
  a page per post; an opt-in list of writers with a page each; and after the end, the anthology
  (`/archive`). A post can instead be published under a separate identity once the party ends,
  or kept private.
- **The host dashboard** (`/host`): each writer's status and pace, alerts and a queue of hours
  to check, approval of new accounts, co-hosts, breaks, scoring settings with a preview of what a
  change would do, messages to everyone or to groups (on the page and as Web Push
  notifications), food preferences and a food order, and exports.
- **After the party**: posts stay editable (removing a large part asks for a reason), and new
  posts start private.
- **Accounts**: username and password (scrypt); an email that only the person and the hosts see;
  each person's own custom CSS for their own screens.
- It installs as an app (web app manifest and service worker), and the writer's page opens
  offline.

## Running it

```sh
node server.js
```

Then open http://127.0.0.1:8110. The first account to register becomes the host; with
`WH_SETUP_TOKEN` set, it can only be made through `/register?setup=<token>`. Hosts start and
end the party from the dashboard.

`node server.js --make-admin <username>` makes an existing account a host in the state file. Run
it while the server is stopped: a running server would overwrite the change.

Everything the server reads from the environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8110` | Port to listen on. |
| `HOST` | `127.0.0.1` | Address to listen on. |
| `WH_STATE_FILE` | `data/state.json` | The state file. Its directory also holds the op journal (`<state file>.ops/`, one file per writer), `uploads/`, `notify.json`, `vapid.json` (the Web Push keys, made at the first start) and `client-errors.log`. |
| `WH_PUBLIC_URL` | `https://writehaven.example.org` | The join address shown on the projector and the host's screens, and the contact sent with Web Push requests. Set it to your site's address. |
| `WH_TZ` | `Europe/London` | The party clock's time zone: where hours on the clock start, and the times in logs and exports. Screens show each viewer's own local time. |
| `WH_SETUP_TOKEN` | none | When set, the first account (the host) can only be made through `/register?setup=<token>`, under any username; after that, nobody can sign up under a name in `WH_ADMIN_USERS`. |
| `WH_ADMIN_USERS` | none | Comma-separated usernames that are hosts: at sign-up, and again at every sign-in. Without `WH_SETUP_TOKEN`, whoever signs up under one of them becomes a host. |
| `WH_REG_PER_IP` | `60` | Sign-ups per address per 10 minutes. |
| `WH_REG_PER_HOST_IP` | `200` | The same from a network a host is signed in from (the venue). |
| `WH_REG_FAILS_PER_IP` | `30` | Failed sign-up attempts per address per 10 minutes. |
| `WH_SSE_PER_IP` | `200` | Anonymous live-page streams per address. |
| `WH_SSE_PER_SESSION` | `4` | Streams of each kind per signed-in session (the oldest closes). |
| `WH_SSE_MAX` | `2000` | Live-page streams in all; past it, anonymous ones are refused. |
| `WH_MAX_CONNECTIONS` | `2000` | Open connections the server accepts. |
| `WH_FSYNC` | on | `0`: don't flush each batch of edits to disk before acknowledging it. |
| `WH_HOUR_MIN` | none | Hour length in minutes, for testing. |
| `WH_TEST_KNOBS` | none | `1`: the host may change test-only settings. |

In production, put the server behind an HTTPS reverse proxy or tunnel on the same machine. It
takes the client's address from `CF-Connecting-IP` or `X-Forwarded-For` only when the connection
comes from loopback, and marks the session cookie `Secure` when `X-Forwarded-Proto` is `https`.
Browsers allow Web Push and the service worker only over HTTPS (or on localhost).

## Tests

```sh
npm test    # node --test test/*.test.js
```

The suite starts its own servers on free ports and needs nothing installed.

## QA tools

The browser checks in `tools/` drive Chromium through Playwright, which the app itself doesn't
depend on. Install `playwright-core` and a Chromium, for example:

```sh
npm install --no-save playwright-core
npx playwright-core install chromium
node tools/qa-e2e.mjs
```

or point the tools at copies you already have:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PLAYWRIGHT_CORE` | `playwright-core` | The module to load: a module name, or an absolute path to a `playwright-core` directory. |
| `CHROME_PATH` | Playwright's own Chromium | A Chromium or Chrome executable. |
| `PANDOC` | `pandoc` | The pandoc binary (`tools/interop-qa/run.mjs` only). |

Each tool starts the servers it needs on scratch state and writes screenshots and reports under
`qa/` (ignored by git); its options are in its header comment. `tools/qa-e2e.mjs` is an
end-to-end run (`npm run qa`); `account-qa`, `afterparty-qa`, `customcss-qa`, `fn-order-qa`,
`footnotes-qa`, `linkcaret-qa`, `notify-qa`, `notify-layout-qa`, `richtext-qa`, `update-qa` and
`writers-qa` check one area each, on a desktop and a phone. `tools/interop-qa/run.mjs` checks
paste-in against the samples in `tools/interop-qa/fixtures`, and every export format; it also
needs pandoc, python3, `pdftotext` and `pdftoppm` (poppler), and fflate from `tools/vendor`
(`cd tools/vendor && npm ci`). `tools/food-harness` and `tools/help-harness` serve those
components on their own for development. `tools/load.mjs` and `tools/load-scale.mjs` are load
tests and need no browser.

## Bundled third-party code

- `public/vendor/cm.js` is a CodeMirror 6 bundle (with the Markdown language),
  `public/vendor/interop.js` bundles marked and fflate for the exports, and
  `public/vendor/mammoth.js` is mammoth's browser build for .docx import. They are built from the
  pinned versions in `tools/vendor` (`cd tools/vendor && npm ci && ./build.sh`), which also
  writes `public/vendor/LICENSES.txt`.
- `public/vendor/qrcode.js` is qrcode-generator 2.0.4 (MIT), minified.
- The fonts in `public/fonts` are Newsreader and Instrument Sans, under the SIL Open Font
  License 1.1 (`public/fonts/OFL.txt`).

## Notes

Comments in the code cite sections of the design spec as “SPEC §N”; the spec itself is not part
of this repository.

