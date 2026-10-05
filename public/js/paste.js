// Paste attribution: "Did you write any of this today, for this party?"
// No -> nothing counts. Yes -> pick sentences / paragraphs / word ranges.
// Words already counted for you, or matching another writer, can't be picked.

import { h, modal, plural } from './ui.js';
import { rawWords, isWordy, paragraphsAndSentences, isQuoteLine } from './text.js';

// Words on quote lines (their "> " marker isn't shown in the picker).
function quoteWords(text, words) {
  const out = new Array(words.length).fill(false);
  let lineStart = 0;
  let wi = 0;
  for (const line of text.split('\n')) {
    const lineEnd = lineStart + line.length;
    const q = isQuoteLine(line);
    while (wi < words.length && words[wi].start < lineEnd + 1) {
      if (words[wi].start >= lineStart) out[wi] = q;
      wi++;
    }
    lineStart = lineEnd + 1;
  }
  return out;
}

// Only runs of 4+ words are marked as your own earlier text: a common pair
// ("brass screws") repeating something you wrote isn't worth a mark.
const OWN_RUN = 4;
function ownRuns(own, wordy) {
  const out = own.slice();
  let i = 0;
  while (i < own.length) {
    if (!own[i]) {
      i++;
      continue;
    }
    let j = i;
    let n = 0;
    while (j < own.length && (own[j] || !wordy[j])) {
      if (own[j] && wordy[j]) n++;
      j++;
    }
    if (n < OWN_RUN) for (let k = i; k < j; k++) out[k] = false;
    i = j;
  }
  return out;
}

// Returns { text, meta } to insert, or null when the paste is cancelled.
// keyboard: the text arrived as typing (Android's keyboard clipboard), not a paste event.
export async function attributePaste({ text, askOver = 12, check, keyboard = false }) {
  const words = rawWords(text);
  const wordy = words.map((w) => isWordy(w.text));
  const nWordy = wordy.filter(Boolean).length;
  const zeros = '0'.repeat(words.length);
  if (nWordy <= askOver) return { text, meta: { m: zeros, d: 'short' } };

  let flags = null;
  try {
    flags = await Promise.race([check(text), new Promise((r) => setTimeout(() => r(null), 2500))]);
  } catch {
    flags = null;
  }
  const own = ownRuns(words.map((_, i) => !!flags && flags.own[i] === '1'), wordy);
  const other = words.map((_, i) => !!flags && flags.other[i] === '1');
  // Quote lines can be picked like any other words (SPEC §30).
  const quote = quoteWords(text, words);
  const selectable = words.map((_, i) => wordy[i] && !own[i] && !other[i]);
  const nSelectable = selectable.filter(Boolean).length;
  const nOwn = words.filter((_, i) => wordy[i] && own[i]).length;
  const nOther = words.filter((_, i) => wordy[i] && other[i] && !own[i]).length;

  // Nothing could count anyway (moving your own text around): insert without asking.
  if (flags && nSelectable === 0) {
    return { text, meta: { m: zeros, d: 'auto' }, note: nOwn >= nOther ? 'Already counted: you wrote this here earlier.' : 'This matches another writer’s text, so it won’t count.' };
  }

  const step1 = await new Promise((resolve) => {
    const preview = h('div', { class: 'paste-preview' }, text.length > 900 ? `${text.slice(0, 900)}…` : text);
    const notes = [];
    if (nOwn) notes.push(h('li', null, `${plural(nOwn, 'word')} already counted: you wrote ${nOwn === 1 ? 'it' : 'them'} here earlier.`));
    if (nOther) notes.push(h('li', null, `${plural(nOther, 'word')} match${nOther === 1 ? 'es' : ''} another writer’s text and won’t count.`));
    const body = h('div', { class: 'paste-step1' },
      h('p', { class: 'paste-sub' }, `${keyboard ? 'This arrived all at once, like a paste: ' : ''}${plural(nWordy, 'word')}. Only words you wrote today, for this party, count.`),
      preview,
      notes.length ? h('ul', { class: 'paste-notes' }, notes) : null);
    modal({
      title: 'Did you write any of this today, for this party?',
      body,
      className: 'modal-paste modal-paste-1',
      onClose: (v) => resolve(v ?? null),
      actions: [
        { label: 'Cancel', quiet: true, value: null },
        { label: 'Paste without counting', value: 'no', id: 'paste-no' },
        { label: 'Yes, I wrote some of it', primary: true, value: 'yes', id: 'paste-yes' },
      ],
    });
  });
  if (step1 === null) return null;
  if (step1 === 'no') return { text, meta: { m: zeros, d: 'no' } };

  // Nothing is claimed until the writer picks it: "Yes" opens the choice, it doesn't make it.
  const sel = selectable.map(() => false);
  const result = await new Promise((resolve) => {
    const counter = h('span', { class: 'paste-counter', 'aria-live': 'polite' });
    const wordEls = [];
    const gapEls = []; // spaces between words: highlighted when both neighbours count
    const paras = paragraphsAndSentences(text);
    const sentOf = new Array(words.length);
    const paraOf = new Int32Array(words.length).fill(-1);
    paras.forEach((para, pi) => { for (const wi of para.words) paraOf[wi] = pi; });
    const area = h('div', { class: 'ps-area' });
    const paraBtns = [];
    paras.forEach((para, pi) => {
      const btn = h('button', { class: 'ps-toggle', type: 'button', 'aria-label': `Paragraph ${pi + 1}: select all of it, or none` });
      const textEl = h('div', { class: 'ps-text' });
      para.sentences.forEach((sentence, si) => {
        const sEl = h('span', { class: 'ps-sent' });
        sentence.forEach((wi) => {
          sentOf[wi] = { pi, si };
          const w = words[wi];
          const cls = ['ps-w'];
          let title = null;
          // The quote marker itself isn't shown: the line is set as a quote.
          const shown = quote[wi] ? w.text.replace(/^>+/, '') : w.text;
          if (!shown) {
            sentOf[wi] = { pi, si };
            return;
          }
          if (!wordy[wi]) cls.push('is-punct');
          else if (own[wi]) { cls.push('is-own'); title = 'Already counted: you wrote this here earlier'; }
          else if (other[wi]) { cls.push('is-other'); title = 'Matches another writer’s text'; }
          const el = h('span', { class: cls.join(' '), 'data-i': wi, title }, shown);
          wordEls[wi] = el;
          sEl.append(el);
          const next = words[wi + 1];
          const gap = next ? text.slice(w.end, next.start) : '';
          if (next && paraOf[wi + 1] === pi) {
            const nl = (gap.match(/\n/g) || []).length;
            if (nl) for (let k = 0; k < nl; k++) sEl.append(h('br'));
            else {
              const g = h('span', { class: 'ps-gap', 'data-a': wi }, ' ');
              gapEls.push(g);
              sEl.append(g);
            }
          }
        });
        textEl.append(sEl, ' ');
      });
      btn.addEventListener('click', () => {
        const idx = para.words.filter((i) => selectable[i]);
        const allOn = idx.length && idx.every((i) => sel[i]);
        for (const i of idx) sel[i] = !allOn;
        paint();
      });
      paraBtns[pi] = { btn, para };
      area.append(h('div', { class: 'ps-para' }, btn, textEl));
    });

    function paint() {
      let n = 0;
      for (let i = 0; i < words.length; i++) {
        const el = wordEls[i];
        if (!el) continue;
        const on = selectable[i] && sel[i];
        el.classList.toggle('is-on', on);
        if (on && wordy[i]) n++;
      }
      for (const g of gapEls) {
        const a = Number(g.dataset.a);
        g.classList.toggle('is-on', selectable[a] && sel[a] && selectable[a + 1] && sel[a + 1]);
      }
      for (const { btn, para } of paraBtns) {
        const idx = para.words.filter((i) => selectable[i]);
        const on = idx.filter((i) => sel[i]).length;
        btn.dataset.state = !idx.length ? 'none' : on === idx.length ? 'all' : on ? 'some' : 'off';
        btn.setAttribute('aria-pressed', on === idx.length && idx.length ? 'true' : on ? 'mixed' : 'false');
        btn.disabled = !idx.length;
      }
      counter.textContent = n ? `${plural(n, 'word')} will count` : 'Nothing selected yet';
      const primary = document.getElementById('paste-count');
      if (primary) primary.textContent = n ? `Paste · count ${plural(n, 'word')}` : 'Paste without counting';
    }

    // Click a word: toggle its sentence. Drag across words: set that range.
    let drag = null;
    const wordAt = (x, y) => {
      const el = document.elementFromPoint(x, y);
      const w = el && el.closest ? el.closest('.ps-w') : null;
      return w && area.contains(w) ? Number(w.dataset.i) : null;
    };
    area.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const i = wordAt(e.clientX, e.clientY);
      if (i === null) return;
      drag = { anchor: i, last: i, mode: !(selectable[i] && sel[i]), snap: sel.slice(), moved: false, id: e.pointerId };
      if (!selectable[i]) {
        const s = sentOf[i];
        const firstSel = paras[s.pi].sentences[s.si].find((k) => selectable[k]);
        drag.mode = firstSel === undefined ? true : !sel[firstSel];
      }
      e.preventDefault();
    });
    area.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const i = wordAt(e.clientX, e.clientY);
      if (i === null || i === drag.last) return;
      drag.last = i;
      drag.moved = drag.moved || i !== drag.anchor;
      const lo = Math.min(drag.anchor, i);
      const hi = Math.max(drag.anchor, i);
      for (let k = 0; k < words.length; k++) sel[k] = k >= lo && k <= hi && selectable[k] ? drag.mode : drag.snap[k];
      paint();
    });
    const end = (e) => {
      if (!drag || (e && e.pointerId !== drag.id)) return;
      if (!drag.moved && e.type === 'pointerup') {
        const s = sentOf[drag.anchor];
        const idx = paras[s.pi].sentences[s.si].filter((k) => selectable[k]);
        const allOn = idx.length && idx.every((k) => sel[k]);
        for (const k of idx) sel[k] = !allOn;
        paint();
      }
      drag = null;
    };
    area.addEventListener('pointerup', end);
    area.addEventListener('pointercancel', end);
    area.addEventListener('lostpointercapture', end);

    const allBtn = h('button', { class: 'btn-link', type: 'button', onClick: () => { for (let i = 0; i < sel.length; i++) sel[i] = selectable[i]; paint(); } }, 'Select all');
    const noneBtn = h('button', { class: 'btn-link', type: 'button', onClick: () => { sel.fill(false); paint(); } }, 'Select none');
    // Always said: what the highlight means, and that the paste itself is whole either way.
    const legend = h('div', { class: 'ps-legend' },
      h('p', { class: 'ps-legend-main' }, h('span', { class: 'ps-key is-on' }, 'Highlighted'), ' words count. All text will be pasted.'),
      nOwn || nOther ? h('p', { class: 'ps-legend-more' },
        nOwn ? h('span', { class: 'ps-key is-own' }, 'already counted') : null,
        nOther ? h('span', { class: 'ps-key is-other' }, 'another writer’s') : null,
        h('span', { class: 'ps-key-note' }, 'can’t be selected')) : null,
      h('p', { class: 'ps-legend-note' }, 'Big pastes can be checked by the hosts.'));
    const body = h('div', { class: 'paste-step2' },
      h('p', { class: 'paste-sub' }, h('strong', null, 'Select the words you wrote today for this party.'), ' Tap a sentence, drag across words, or use the box beside a paragraph.'),
      legend,
      area,
      h('div', { class: 'ps-foot' }, counter, h('span', { class: 'ps-quick' }, allBtn, noneBtn)));
    modal({
      title: 'Which parts did you write today?',
      body,
      className: 'modal-paste modal-wide',
      onClose: (v) => resolve(v ?? null),
      actions: [
        { label: 'Cancel', quiet: true, value: null },
        {
          label: 'Paste without counting', primary: true, id: 'paste-count',
          onClick: () => resolve(sel.map((on, i) => (on && selectable[i] ? '1' : '0')).join('')),
        },
      ],
    });
    paint();
  });
  if (result === null) return null;
  return { text, meta: { m: result, d: 'yes' } };
}
