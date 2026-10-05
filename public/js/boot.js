/* Start-up watchdog: a classic ES5 script, loaded before the app's modules so that it
   runs on any browser. If the app hasn't started within 8 seconds, or an error happens
   before it starts, the "Opening…" screen becomes a plain message with a Reload button,
   and what went wrong is reported to the server (/api/client-error). The app replaces
   the message as soon as it does start. */
(function () {
  var shown = false;
  var reports = 0;
  var errored = false;

  function booted() {
    var app = document.getElementById('app');
    return !!app && !app.querySelector('.boot');
  }

  function loadedScripts() {
    try {
      var list = performance.getEntriesByType('resource');
      var names = [];
      for (var i = 0; i < list.length; i++) {
        var m = /\/(js|vendor)\/([\w.-]+\.js)/.exec(list[i].name);
        if (m) names.push(m[2]);
      }
      return names.join(',').slice(0, 300);
    } catch (e) {
      return '';
    }
  }

  function report(kind, message, source, line, col) {
    if (reports >= 3) return;
    reports++;
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/api/client-error', true);
      x.setRequestHeader('Content-Type', 'application/json');
      x.setRequestHeader('X-WH', '1');
      x.send(JSON.stringify({
        kind: kind,
        message: String(message || '').slice(0, 500),
        source: String(source || '').slice(0, 300),
        line: line || null,
        col: col || null,
        path: location.pathname,
        scripts: loadedScripts(),
        online: navigator.onLine,
      }));
    } catch (e) { /* nothing more to do */ }
  }

  function show() {
    if (shown || booted()) return;
    var app = document.getElementById('app');
    if (!app) return;
    shown = true;
    while (app.firstChild) app.removeChild(app.firstChild);
    var box = document.createElement('div');
    box.setAttribute('role', 'alert');
    box.style.cssText = 'max-width:30rem;margin:18vh auto 0;padding:0 1.5rem;font:400 1.1rem/1.55 Georgia,serif;';
    var p = document.createElement('p');
    p.style.margin = '0 0 1.2rem';
    p.textContent = errored
      ? 'Writehaven couldn’t start on this browser. Try reloading, or open it in Safari or Chrome.'
      : 'Writehaven is taking a long time to start. Try reloading, or open it in Safari or Chrome.';
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-primary';
    b.textContent = 'Reload';
    b.onclick = function () { location.reload(); };
    box.appendChild(p);
    box.appendChild(b);
    app.appendChild(box);
  }

  function failed(kind, message, source, line, col) {
    if (booted()) return;
    errored = true;
    report(kind, message, source, line, col);
    // A moment's grace: an error that doesn't stop the app (an extension, say) is ignored.
    setTimeout(show, 1500);
  }

  window.addEventListener('error', function (e) {
    var t = e && e.target;
    if (t && t !== window && t.tagName) {
      // A resource failed to load: only our scripts matter here.
      if (t.tagName === 'SCRIPT') failed('script-load', 'could not load ' + (t.src || 'a script'), t.src || '', null, null);
      return;
    }
    var src = (e && e.filename) || '';
    if (src && src.indexOf(location.origin) !== 0) return; // another site's script (an extension)
    failed('error', (e && (e.message || (e.error && e.error.message))) || 'error', src, e && e.lineno, e && e.colno);
  }, true);

  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    var msg = r ? (r.stack || r.message || String(r)) : 'unhandled rejection';
    if (r && r.network) return; // offline: the app says so itself
    failed('rejection', msg, '', null, null);
  });

  setTimeout(function () {
    if (booted()) return;
    report('timeout', 'not started after 8 s', '', null, null);
    show();
  }, 8000);
})();
