// Starts every module a page needs in parallel, right away, instead of one import
// at a time (app.js -> write.js -> editor.js -> cm.js was six round trips on a
// slow phone network). Classic script, loaded before app.js; it only adds hints.
(function () {
  var path = location.pathname.replace(/\/+$/, '') || '/';
  var writer = false;
  try {
    var s = JSON.parse(localStorage.getItem('wh-session') || 'null');
    writer = !!(s && s.user && !s.user.isAdmin);
  } catch (e) { /* no storage */ }
  var mods = ['/js/ui.js', '/js/net.js'];
  if (path === '/write' || (path === '/' && writer)) {
    mods.push('/js/write.js', '/js/sync.js', '/js/editor.js', '/js/paste.js', '/js/text.js', '/vendor/cm.js');
  } else if (path === '/host') {
    mods.push('/js/host.js', '/js/md-render.js', '/js/footnotes.js');
  } else if (path === '/' || path === '/live' || path === '/archive' || path.indexOf('/p/') === 0) {
    mods.push('/js/live.js', '/js/md-render.js', '/js/footnotes.js');
  }
  // The server serves every module with ?v=<build> on its imports; hint the same URLs
  // (this script is loaded as preload.js?v=<build>) so a hint is never a stale extra copy.
  var me = document.currentScript && document.currentScript.src;
  var vm = me && me.match(/[?&]v=([^&#]+)/);
  var q = vm ? '?v=' + vm[1] : '';
  for (var i = 0; i < mods.length; i++) {
    var l = document.createElement('link');
    l.rel = 'modulepreload';
    l.href = mods[i] + q;
    document.head.appendChild(l);
  }
})();
