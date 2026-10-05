// QR codes as inline SVG (built with DOM calls, no markup strings), for the join
// address on the live page, the projector and the host's setup card.
//   import { qrSvg } from './qr.js';
//   el.append(qrSvg('https://writehaven.example.org', { label: 'Join at …' }));
// Dark modules on a white square (scanners expect dark on light, also in dark mode).

import qrcode from '../vendor/qrcode.js';

const NS = 'http://www.w3.org/2000/svg';

export function qrSvg(text, { margin = 2, ecc = 'M', label = null, className = 'qr' } = {}) {
  const qr = qrcode(0, ecc);
  // The generator takes one byte per char: pass UTF-8 bytes so any address encodes.
  qr.addData(String.fromCharCode(...new TextEncoder().encode(String(text))), 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const size = n + margin * 2;
  // One path: a horizontal run of dark modules per segment.
  let d = '';
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!qr.isDark(r, c)) {
        c++;
        continue;
      }
      let e = c + 1;
      while (e < n && qr.isDark(r, e)) e++;
      d += `M${c + margin} ${r + margin}h${e - c}v1h${c - e}z`;
      c = e;
    }
  }
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('class', className);
  svg.setAttribute('shape-rendering', 'crispEdges');
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else svg.setAttribute('aria-hidden', 'true');
  const bg = document.createElementNS(NS, 'rect');
  bg.setAttribute('width', String(size));
  bg.setAttribute('height', String(size));
  bg.setAttribute('fill', '#fff');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#111');
  svg.append(bg, path);
  return svg;
}

// "https://writehaven.example.org/" -> "writehaven.example.org" (for display).
export function displayUrl(url) {
  try {
    const u = new URL(url);
    const p = u.pathname === '/' ? '' : u.pathname;
    return `${u.host}${p}${u.search}`;
  } catch {
    return String(url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  }
}
