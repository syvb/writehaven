// Property tests for htmlToMarkdown, run inside the harness page (window.WH must exist).
// For random HTML built from inline formatting, links, code, line breaks and block structure with
// Markdown-significant characters, the text a reader sees must survive HTML -> Markdown -> HTML.
// Exposes window.runFuzz(seed, count) -> { cases, failures: [{ html, md, want, got }] }.

(function () {
  function rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const WORDS = [
    'plain', 'words', 'here', 'and', 'the', 'sea', '*', '**', '_', '__', '~', '~~', '`', '``', '[', ']', '(', ')',
    '[1]', '[x]', '<', '>', '&', '&copy;', '#', '##', '-', '+', '1.', '2)', '\\', '\\*', '|', '!', '=', '===', '---',
    'a*b', 'snake_case', '_lead', 'trail_', '*lead', 'trail*', 'https://example.com/a_b', 'www.example.org',
    'x@example.org', '“quoted”', '‘single’', '—', '–', '…', 'émigré', 'Привет', '2026.', '3.14', '50%', '$5', '<tag>',
    '<https://x.y>', '![alt]', '](', '[a](b)', '**bold**', '*it*', '~~s~~', '`c`', ':', ';', '?', '"', "'",
  ];

  function text(r) {
    const n = 1 + Math.floor(r() * 4);
    const out = [];
    for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(r() * WORDS.length)]);
    const sep = r() < 0.15 ? '' : ' ';
    return out.join(sep);
  }

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  const INLINE = ['b', 'strong', 'i', 'em', 's', 'del', 'code', 'a', 'span-b', 'span-i', 'span-s', 'br', 'u'];

  function inline(r, depth) {
    let html = '';
    const parts = 1 + Math.floor(r() * 4);
    for (let i = 0; i < parts; i++) {
      if (depth > 2 || r() < 0.45) {
        html += (r() < 0.3 ? ' ' : '') + esc(text(r)) + (r() < 0.3 ? ' ' : '');
        continue;
      }
      const t = INLINE[Math.floor(r() * INLINE.length)];
      const inner = t === 'code' ? esc(text(r)) : inline(r, depth + 1);
      if (t === 'br') html += '<br>';
      else if (t === 'a') {
        const href = r() < 0.2 ? 'javascript:void(0)' : r() < 0.3 ? 'https://example.com/p_(1)' : 'https://example.com/' + Math.floor(r() * 99);
        html += '<a href="' + href + '">' + inner + '</a>';
      } else if (t === 'span-b') html += '<span style="font-weight:700">' + inner + '</span>';
      else if (t === 'span-i') html += '<span style="font-style:italic">' + inner + '</span>';
      else if (t === 'span-s') html += '<span style="text-decoration:line-through">' + inner + '</span>';
      else html += '<' + t + '>' + inner + '</' + t + '>';
    }
    return html;
  }

  function block(r, depth) {
    const k = Math.floor(r() * (depth > 1 ? 4 : 9));
    switch (k) {
      case 0:
      case 1:
        return '<p>' + inline(r, 0) + '</p>';
      case 2:
        return '<div>' + inline(r, 0) + '</div>';
      case 3:
      {
        const lvl = 1 + Math.floor(r() * 3);
        return '<h' + lvl + '>' + inline(r, 1) + '</h' + lvl + '>';
      }
      case 4: {
        const tag = r() < 0.5 ? 'ul' : 'ol';
        let items = '';
        const n = 1 + Math.floor(r() * 3);
        for (let i = 0; i < n; i++) items += '<li>' + inline(r, 1) + (r() < 0.3 ? block(r, depth + 1) : '') + '</li>';
        return '<' + tag + '>' + items + '</' + tag + '>';
      }
      case 5:
        return '<blockquote>' + block(r, depth + 1) + (r() < 0.5 ? block(r, depth + 1) : '') + '</blockquote>';
      case 6:
        return '<pre><code>' + esc(text(r)) + '\n' + esc(text(r)) + '</code></pre>';
      case 7: {
        let rows = '';
        const cols = 2 + Math.floor(r() * 2);
        for (let i = 0; i < 2 + Math.floor(r() * 2); i++) {
          rows += '<tr>';
          for (let j = 0; j < cols; j++) rows += (i === 0 ? '<th>' : '<td>') + inline(r, 1) + (i === 0 ? '</th>' : '</td>');
          rows += '</tr>';
        }
        return '<table>' + rows + '</table>';
      }
      default:
        return '<hr><p>' + inline(r, 0) + '</p>';
    }
  }

  function visibleText(html) {
    const d = document.implementation.createHTMLDocument('');
    d.body.innerHTML = html;
    for (const a of d.body.querySelectorAll('br')) a.replaceWith(' ');
    return d.body.textContent || '';
  }

  // Realistic prose with ordinary punctuation, for the formatting-fidelity property.
  const PROSE = [
    'the', 'sea', 'lamp', 'keeper', 'night', 'light', 'was', 'calm', 'and', 'grey,', 'she', 'said', 'it', 'is', 'a',
    'of', 'to', 'in', 'on', '“quoted”', '(aside)', 'well,', 'yes.', 'no!', 'why?', '—', 'dawn;', 'dusk:', '1997',
    '3.5', 'don’t', 'it’s', 'Ana’s', '…', 'e.g.', 'well-known', 'naïve', 'Zoë', '50%', '$12',
  ];
  const FMT = ['b', 'i', 's', 'code', 'a', 'b+i', 'strong', 'em'];

  function proseWords(r, n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(PROSE[Math.floor(r() * PROSE.length)]);
    return out.join(' ');
  }

  function proseInline(r, depth) {
    let html = '';
    const parts = 2 + Math.floor(r() * 4);
    for (let i = 0; i < parts; i++) {
      const sep = r() < 0.1 ? '' : ' ';
      if (depth > 1 || r() < 0.5) {
        html += esc(proseWords(r, 1 + Math.floor(r() * 4))) + sep;
        continue;
      }
      const t = FMT[Math.floor(r() * FMT.length)];
      const inner = t === 'code' ? esc(proseWords(r, 1 + Math.floor(r() * 2))) : proseInline(r, depth + 1).trim();
      if (t === 'a') html += '<a href="https://example.com/' + Math.floor(r() * 50) + '">' + inner + '</a>' + sep;
      else if (t === 'b+i') html += '<b><i>' + inner + '</i></b>' + sep;
      else html += '<' + t + '>' + inner + '</' + t + '>' + sep;
    }
    return html;
  }

  // Per visible character: [char, bold, italic, strike, code, href].
  function charFlags(html) {
    const d = document.implementation.createHTMLDocument('');
    d.body.innerHTML = html;
    const out = [];
    const rec = (n, f) => {
      for (let c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) {
          for (const ch of c.data) if (/\S/.test(ch)) out.push([ch, f.b, f.i, f.s, f.c, f.a].join('|'));
        } else if (c.nodeType === 1) {
          const t = c.localName;
          const g = Object.assign({}, f);
          if (t === 'b' || t === 'strong') g.b = 1;
          if (t === 'i' || t === 'em') g.i = 1;
          if (t === 's' || t === 'del') g.s = 1;
          if (t === 'code') g.c = 1;
          if (t === 'a' && /^https?:/.test(c.getAttribute('href') || '')) g.a = c.getAttribute('href');
          rec(c, g);
        }
      }
    };
    rec(d.body, { b: 0, i: 0, s: 0, c: 0, a: '' });
    return out;
  }

  window.runFormatFuzz = function (seed, count) {
    const r = rng(seed);
    const failures = [];
    let allDropped = 0;
    let formatted = 0;
    let kept = 0;
    for (let c = 0; c < count; c++) {
      const html = '<p>' + proseInline(r, 0).trim() + '</p>';
      const md = window.WH.htmlToMarkdown(html);
      const want = charFlags(html);
      const got = charFlags(window.WH.markdownToHtml(md));
      for (let i = 0; i < want.length; i++) {
        if (/^.\|0\|0\|0\|0\|$/.test(want[i])) continue;
        formatted++;
        if (want[i] === got[i]) kept++;
      }
      if (want.join('\n') !== got.join('\n')) {
        failures.push({ html, md });
        if (/<(b|strong|i|em|s|del)>/.test(html) && !/<(strong|em|del)>/.test(window.WH.markdownToHtml(md))) allDropped++;
      }
    }
    return { cases: count, failures, allDropped, exactRate: 1 - failures.length / count, charKeep: kept / Math.max(1, formatted) };
  };

  window.runFuzz = function (seed, count, mode) {
    const r = rng(seed);
    const failures = [];
    for (let c = 0; c < count; c++) {
      let html = '';
      if (mode === 'inline') html = '<p>' + inline(r, 0) + '</p>';
      else for (let b = 0; b < 1 + Math.floor(r() * 4); b++) html += block(r, 0);
      let md;
      try {
        md = window.WH.htmlToMarkdown(html);
      } catch (e) {
        failures.push({ html, error: String(e && e.stack) });
        continue;
      }
      const want = visibleText(html).replace(/\s+/g, '');
      const got = visibleText(window.WH.markdownToHtml(md)).replace(/\s+/g, '');
      if (want !== got) failures.push({ html, md, want, got });
      if (/[ \t]+$/m.test(md)) failures.push({ html, md, problem: 'trailing whitespace' });
    }
    return { cases: count, failures };
  };
})();
