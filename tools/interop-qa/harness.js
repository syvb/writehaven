// Exposes the interop module to Playwright and records CSP violations.
import * as WH from '/js/interop.js';

window.__csp = [];
document.addEventListener('securitypolicyviolation', (e) => {
  window.__csp.push({ directive: e.violatedDirective, blocked: e.blockedURI, sample: e.sample });
});
window.WH = WH;

// A real copy event (Ctrl+C): our editor would do exactly this.
document.addEventListener('copy', (e) => {
  if (!window.__mdForCopy) return;
  WH.fillClipboard(e.clipboardData, window.__mdForCopy);
  e.preventDefault();
});

// A button for the one-click copy, so the test can click it (a real user gesture).
const btn = document.createElement('button');
btn.id = 'qa-copy';
btn.type = 'button';
btn.textContent = 'Copy for LessWrong';
btn.style.cssText = 'position:fixed;top:8px;right:8px;z-index:9;';
btn.addEventListener('click', async () => {
  window.__copyResult = await WH.copyRich('Legacy **path** with a [link](https://example.com/x).', 'Legacy title', 'gdocs');
});
document.body.appendChild(btn);
window.__ready = true;
