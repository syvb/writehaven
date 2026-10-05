// Mounts the food components the way the app's screens will (dev only). Query:
//   view=pending|lobby|sheet|host|host-narrow|drawer   theme=light|dark   seed=sample|empty|no-options
import { h, fill, applyTheme, setTheme } from '/js/ui.js';
import { renderFoodForm, openFoodSheet, openEveryonesFood, mountFoodCard, mountWriterFood } from '/js/food.js';

const q = new URLSearchParams(location.search);
const view = q.get('view') || 'pending';
const theme = q.get('theme');
if (theme === 'light' || theme === 'dark') setTheme(theme);
else applyTheme();
const app = document.getElementById('app');

async function main() {
  if (q.get('seed')) await fetch('/harness/api/reset', { method: 'POST', body: JSON.stringify({ seed: q.get('seed') }) });
  // The waiting card is for a pending guest; the sheet and "Everyone's food" for an approved writer.
  await fetch('/harness/api/me', { method: 'POST', body: JSON.stringify({ approval: view === 'pending' ? 'pending' : 'approved' }) });
  try {
    if (q.get('fresh') === '1') localStorage.removeItem('wh-food:me');
  } catch { /* ignore */ }
  if (view === 'pending') {
    document.body.dataset.screen = 'approval';
    const food = h('section', { class: 'ap-food', 'aria-label': 'Food preferences' });
    const card = h('div', { class: 'ap-card', role: 'main' },
      h('p', { class: 'ap-kicker' }, 'Sunday Writing Party'),
      h('h1', { class: 'ap-title' }, 'Waiting for the host to approve your account.'),
      h('p', { class: 'ap-lede' }, 'You’re signed up as Ines Duarte (@ines). This page opens the editor by itself as soon as the host lets you in, so you can leave it open.'),
      h('div', { class: 'ap-sent' },
        h('p', { class: 'ap-label' }, 'Your message to the host'),
        h('blockquote', { class: 'ap-quote' }, 'Hi, it’s Ines from the book club!'),
        h('p', { class: 'ap-sent-row' }, h('span', { class: 'ap-ok' }, 'Sent ✓'), ' · ', h('button', { class: 'btn-link', type: 'button' }, 'Edit'))),
      h('p', { class: 'ap-foot' }, h('a', { href: '#' }, 'Watch the live page'), h('button', { class: 'btn-link ap-signout', type: 'button' }, 'Sign out')));
    // As app.js mounts it: a card of its own under the approval card.
    fill(app, h('div', { class: 'ap' }, card, food));
    window.foodForm = renderFoodForm(food, { title: 'While you wait: food preferences', lede: 'So the hosts can feed everyone well. Only the hosts see this.' });
    await window.foodForm.ready;
  } else if (view === 'lobby' || view === 'sheet' || view === 'everyone') {
    document.body.dataset.screen = 'write';
    const btn = h('button', { class: 'btn', type: 'button', id: 'fh-open' }, 'Food preferences');
    btn.addEventListener('click', () => { window.sheet = openFoodSheet(); });
    fill(app, h('div', { class: 'fh-writer' },
      h('header', { class: 'fh-top' }, h('span', { class: 'fh-brand' }, 'Sunday Writing Party'), h('span', null, 'The lighthouse keeper'), h('span', { class: 'fh-me' }, 'Ana Ruiz')),
      h('main', { class: 'fh-lobby' },
        h('h1', null, 'Sunday Writing Party'),
        h('p', null, 'The party hasn’t started yet. This page opens for writing the moment the host starts.'),
        h('p', null, btn))));
    if (view === 'sheet') window.sheet = openFoodSheet();
    if (view === 'everyone') window.sheet = openEveryonesFood();
  } else if (view === 'host' || view === 'host-narrow') {
    document.body.dataset.screen = 'host';
    const card = h('section', { class: 'h-card h-food', 'aria-label': 'Food' });
    const narrow = view === 'host-narrow';
    fill(app, h('div', { class: 'fh-host h-app' },
      h('div', { class: 'fh-host-top' }, 'Sunday Writing Party'),
      h('div', { class: `fh-host-grid${narrow ? ' is-narrow' : ''}` },
        narrow ? h('div', { class: 'fh-side' }, 'Other host cards') : null,
        card,
        narrow ? null : h('div', { class: 'fh-side' }, 'Other host cards'))));
    window.foodCard = mountFoodCard(card);
  } else if (view === 'drawer') {
    document.body.dataset.screen = 'host';
    const sec = h('div');
    fill(app, h('aside', { class: 'h-drawer', role: 'dialog', 'aria-label': 'Writer details' },
      h('div', { class: 'h-drawer-head' }, h('div', null, h('h2', null, 'Ana Ruiz'), h('p', { class: 'h-drawer-meta' }, '@ana · joined 18:04'))),
      h('section', { class: 'h-dsec' }, h('h3', null, 'Food'), sec)));
    await mountWriterFood(sec, q.get('id') || 'ana');
  }
  document.body.dataset.ready = '1';
}
main().catch((e) => {
  console.error(e);
  document.body.dataset.ready = 'error';
});
