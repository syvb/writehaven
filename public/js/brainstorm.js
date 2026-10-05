// "Before you start": a gentle brainstorm offered the first time a writer opens the
// editor (and from the menu and the notes). Three short questions; the answers go into
// the planning notes of the current post, where they count like any writing.

import { h, modal } from './ui.js';

export const QUESTIONS = [
  'What do you want to achieve today?',
  'What can you experiment with?',
  'What would help you become a better writer?',
];

// opts: { onAdd(answers: string[]) }. Resolves when the panel closes.
export function openBrainstorm({ onAdd }) {
  const fields = QUESTIONS.map((q) => h('textarea', { class: 'w-bs-field', rows: 2, 'aria-label': q, spellcheck: 'true' }));
  const body = h('div', { class: 'w-bs' },
    h('p', { class: 'w-bs-lede' }, 'A few minutes of thinking first. Your answers go into this post’s planning notes, which only you and the hosts can read. This counts towards your first hour.'),
    QUESTIONS.map((q, i) => h('label', { class: 'w-bs-q' }, h('span', null, q), fields[i])));
  return new Promise((resolve) => {
    modal({
      title: 'Before you start',
      body,
      className: 'modal-brainstorm',
      onClose: () => resolve(),
      actions: [
        { label: 'Not now', quiet: true },
        {
          label: 'Add to my planning notes', primary: true,
          onClick: () => {
            const answers = fields.map((f) => f.value.trim());
            // onAdd returns false when they couldn't go in: the panel stays open with them.
            if (answers.some(Boolean) && onAdd?.(answers) === false) return false;
            return undefined;
          },
        },
      ],
    });
    setTimeout(() => fields[0].focus(), 50);
  });
}
