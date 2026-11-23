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
  counted from when each writer first opens the editor. Words over an hour's target, up to 200
  (a host setting; 0 turns it off), count toward the next hour too. A missed hour puts the writer out of the
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
- **After the party**: posts stay freely editable, and new
  posts start private.
- **Rounds**: the same site can hold one party after another. A new round opens in a fresh lobby
  with the same accounts; earlier rounds stay readable: their anthologies (`/archive/<n>`), their
  post pages at the same addresses, each writer's signed pieces on their page, and a writer's own
  posts from them, private ones included (`/past`).
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

Once a party has ended, a host can download the public site as a static website (Export → "Export the
public site", `GET /api/admin/static-site.zip`, `lib/static-site.js`): every round's anthology, every
published piece, the list of writers and their pages, as plain HTML with relative links, the site's
stylesheets and fonts, and the images the pieces show. It needs no server or JavaScript, so it can
live on any static host after the party; only what the public site shows goes in. The download asks
for an optional note for the front page, in Markdown (where the party lives on now, say), shown
above the contents and kept for the next download.

A host can take back the end of the latest party from the dashboard ("Resume the party…"): it runs
again from then on, the time it was over counts as a pause (no hour is missed in it), and edits made
meanwhile count like writing during a break.

`node server.js --new-round` closes a party that has ended and opens the next round in the lobby
(`lib/rounds.js`). Run it while the server is stopped, then start the server again. The closed
round moves to `rounds/<n>/` in the state directory: `round.json` (what the site serves from it),
the full `state.json` and its op journal. Carried over: accounts, passwords, emails, hosts,
approvals, sign-ins, the writers-list pages, custom CSS, the scoring settings, the party's name,
push subscriptions and the standing food answers (the food order answers are cleared into the food
history). Started again: posts, hours, passes, reviews, breaks, alerts and the log. Images from the
closed round stay where its posts link to them but no longer count towards upload quotas.

Everything the server reads from the environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8110` | Port to listen on. |
| `HOST` | `127.0.0.1` | Address to listen on. |
| `WH_STATE_FILE` | `data/state.json` | The state file. Its directory also holds the op journal (`<state file>.ops/`, one file per writer), `uploads/`, `notify.json`, `vapid.json` (the Web Push keys, made at the first start), `client-errors.log` and `acme/` (Let's Encrypt's challenges, with `WH_HTTP_PORT`). |
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
| `WH_TLS_CERT` | none | With `WH_TLS_KEY`: serve HTTPS on `PORT` with this certificate chain (PEM, such as certbot's `fullchain.pem`). Both files are checked every minute, so a renewed certificate needs no restart. |
| `WH_TLS_KEY` | none | The certificate's private key (PEM, such as certbot's `privkey.pem`). |
| `WH_HTTP_PORT` | none | With TLS: also listen on this port over plain HTTP, answer Let's Encrypt's HTTP-01 challenges from `acme/` in the state directory, and redirect everything else to HTTPS. |

In production, serve it over HTTPS: by itself, with a Let's Encrypt certificate (below), or
behind an HTTPS reverse proxy or tunnel on the same machine. Behind a proxy, it takes the
client's address from `CF-Connecting-IP` or `X-Forwarded-For` only when the connection
comes from loopback, and marks the session cookie `Secure` when `X-Forwarded-Proto` is `https`.
Browsers allow Web Push and the service worker only over HTTPS (or on localhost).

### HTTPS with Let's Encrypt

With `WH_TLS_CERT` and `WH_TLS_KEY` the server speaks HTTPS itself. With `WH_HTTP_PORT` as
well, it answers Let's Encrypt's challenges for certbot's webroot mode, so certbot never needs
the server stopped. Here the server runs as the user `writehaven` in `/srv/writehaven`, for
`party.example.org`:

1. Point the domain's DNS at the machine, and start the server on ports 443 and 80. Ports below
   1024 need root or the `CAP_NET_BIND_SERVICE` capability (in a systemd unit:
   `AmbientCapabilities=CAP_NET_BIND_SERVICE`). Until the certificate files exist, the server
   answers only the challenges and redirects, and logs that it is waiting for them.

   ```sh
   HOST=:: PORT=443 WH_HTTP_PORT=80 WH_PUBLIC_URL=https://party.example.org \
   WH_TLS_CERT=/etc/writehaven/tls/fullchain.pem WH_TLS_KEY=/etc/writehaven/tls/privkey.pem \
   node server.js
   ```

2. As root, get the certificate. certbot keeps its files where only root can read them; the
   deploy hook copies them for the server, now and after every renewal:

   ```sh
   install -d -m 700 -o writehaven /etc/writehaven/tls
   certbot certonly --webroot -w /srv/writehaven/data/acme -d party.example.org \
     --deploy-hook 'install -m 600 -o writehaven "$RENEWED_LINEAGE"/fullchain.pem "$RENEWED_LINEAGE"/privkey.pem /etc/writehaven/tls/'
   ```

The server loads the certificate within a minute. certbot's own timer renews it before it
expires, and the server switches to the new one by itself, also within a minute.

### As a service, with backups

`deploy/` has what a server needs to run it unattended, as examples to adapt (paths, domain, ports):

- `deploy/writehaven.service`: a systemd unit for the setup above (the app in `/srv/writehaven`, its
  data in `/srv/writehaven/data` owned by the user `writehaven`, HTTPS on 443 and certbot's
  challenges on 80), able to write nothing but its data directory. It restarts the server if it
  stops. A restart takes a few seconds (the server re-scores the whole op log at start); writers
  lose nothing meanwhile, since their editors keep unsent words and send them when it's back, and
  open pages offer a reload when the code has changed. On `systemctl stop` the server saves first.
- `deploy/writehaven-backup`, with `deploy/writehaven-backup.service` and `.timer`: a backup of the
  data directory every 30 minutes, taken while the server runs, to
  `/var/backups/writehaven/auto-<UTC time>.tar.gz` (root only). It copies `state.json` first and
  the rest after, so a copy looks like a crash, which the server's start handles; it checks each
  copy before keeping it, never runs when it would leave less than 1.5 GB free, and never deletes
  a backup unless `WH_BACKUP_KEEP` is set. Install steps are at the top of the timer.
- `deploy/check-backup.mjs`: loads a backup (a `.tar.gz` or a data directory) the way the server
  starts, on a temporary copy, without serving it or sending anything, and says what's in it:
  `sudo node deploy/check-backup.mjs /var/backups/writehaven/auto-….tar.gz`.

The data directory is everything a party is: the state, the op journal, earlier rounds, uploaded
images, and `vapid.json`, the Web Push keys (without it, everyone's notifications stop until they
turn them on again). To restore a backup, or move to another machine:

```sh
sudo systemctl stop writehaven
sudo mv /srv/writehaven/data /srv/writehaven/data.before-restore
sudo tar -xzf /var/backups/writehaven/auto-….tar.gz -C /srv/writehaven   # makes data/
sudo chown -R writehaven:writehaven /srv/writehaven/data && sudo chmod 700 /srv/writehaven/data
sudo systemctl start writehaven
```

Never edit `state.json` while the server runs: it keeps its state in memory and writes the file
over yours.

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

