// Writehaven push notifications (SPEC §22), loaded by the offline shell with
//   importScripts('/sw-push.js');
// at the top of public/sw.js. A push carries { id, at, kind, from, fromName, title, body, times,
// url, sound, tag } and nothing secret. Times in the text are templates ({t}) with epoch ms in
// `times`, shown here in the device's own time zone (SPEC §24). Tapping a notification focuses
// a Writehaven tab that is already open (taking it to the notice's page) or opens one.

const WH_CLOCK = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function whFill(text, times) {
  const s = String(text || '');
  if (!times || typeof times !== 'object') return s;
  return s.replace(/\{(\w+)\}/g, (all, k) => (Number.isFinite(times[k]) ? WH_CLOCK.format(times[k]) : all));
}

function whPost(path, body) {
  return fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-WH': '1' },
    body: JSON.stringify(body),
  }).catch(() => null);
}

// The app's icon, from the web app manifest when there is one (looked up once per worker).
let whIconsP = null;
function whIcons() {
  if (!whIconsP) {
    whIconsP = fetch('/manifest.webmanifest')
      .then((r) => (r.ok ? r.json() : {}))
      .then((m) => {
        const icons = Array.isArray(m.icons) ? m.icons : [];
        const any = icons.filter((i) => i && i.src && !/maskable|monochrome/.test(i.purpose || ''));
        const icon = any.find((i) => /\b192x192\b/.test(i.sizes || '')) || any[0] || null;
        const mono = icons.find((i) => i && i.src && /monochrome/.test(i.purpose || '')) || null;
        const abs = (i) => (i ? new URL(i.src, self.location.origin).href : undefined);
        return { icon: abs(icon), badge: abs(mono) };
      })
      .catch(() => ({}));
  }
  return whIconsP;
}

self.addEventListener('push', (event) => {
  let n = {};
  try {
    n = event.data ? event.data.json() : {};
  } catch {
    n = { body: event.data ? event.data.text() : '' };
  }
  const title = whFill(n.title, n.times) || (n.from === 'host' ? `From ${n.fromName || 'the host'}` : 'Writehaven');
  event.waitUntil((async () => {
    const { icon, badge } = await whIcons();
    const tag = n.tag || n.id;
    await self.registration.showNotification(title, {
      body: whFill(n.body, n.times),
      tag: tag ? `wh-${tag}` : undefined,
      renotify: !!tag,
      timestamp: Number.isFinite(n.at) ? n.at : Date.now(),
      silent: n.sound === false,
      vibrate: n.sound === false ? undefined : [90, 60, 90],
      icon,
      badge,
      data: { id: n.id || null, url: typeof n.url === 'string' ? n.url : '/' },
    });
    // Shown on this device: the server counts it as delivered.
    if (n.id) await whPost('/api/me/notices/seen', { ids: [n.id], via: 'push' });
  })());
});

self.addEventListener('notificationclick', (event) => {
  const data = event.notification.data || {};
  event.notification.close();
  let url = new URL('/', self.location.origin);
  try {
    const u = new URL(data.url || '/', self.location.origin);
    if (u.origin === self.location.origin) url = u;
  } catch { /* keep the start page */ }
  event.waitUntil((async () => {
    const read = data.id ? whPost('/api/me/notices/read', { ids: [data.id] }) : null;
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const same = (c) => {
      try {
        return new URL(c.url).pathname === url.pathname;
      } catch {
        return false;
      }
    };
    const win = wins.find(same) || wins.find((c) => c.focused) || wins[0];
    if (win) {
      try {
        await win.focus();
      } catch { /* not allowed: still try to show the page */ }
      if (!same(win)) {
        // navigate() works for pages this worker controls; others are asked to go there.
        const moved = await win.navigate(url.href).then(() => true, () => false);
        if (!moved) win.postMessage({ type: 'wh-open', url: url.pathname + url.search + url.hash, id: data.id || null });
      } else {
        win.postMessage({ type: 'wh-notice-read', id: data.id || null });
      }
    } else {
      await self.clients.openWindow(url.href);
    }
    await read;
  })());
});

// The page asks whether this worker shows pushes (it subscribes only if so): sw.js must import
// this file, or every push would end as the browser's generic "updated in the background".
self.addEventListener('message', (event) => {
  const d = event.data;
  if (d && d.type === 'wh-push-ping' && event.ports && event.ports[0]) event.ports[0].postMessage({ type: 'wh-push-pong', v: 1 });
});

// The browser replaced the subscription (Firefox does this): tell the server about the new one.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      let sub = event.newSubscription || null;
      if (!sub && event.oldSubscription && event.oldSubscription.options) sub = await self.registration.pushManager.subscribe(event.oldSubscription.options);
      if (sub) await whPost('/api/push/subscribe', { subscription: sub.toJSON(), device: 'Renewed by the browser' });
      if (event.oldSubscription) await whPost('/api/push/unsubscribe', { endpoint: event.oldSubscription.endpoint });
    } catch { /* the page re-registers it on its next load */ }
  })());
});
