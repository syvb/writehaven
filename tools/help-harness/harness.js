// Mounts the help sheet with sample settings (no server: settings are passed to openHelp).
// URL parameters:
//   theme=light|dark   role=writer|host|guest   section=<id>   open=0 (don't open on load)
//   mode=synced|personal|none (hoursMode; none = a server without §17)   approval=pending|declined
//   target=<n> passes=<n> out=alert-only   waiting=1 (show howTonightWorks on the page)
//   break=reduce|pause (a break in view)   brainstorm=1 (the writer page's brainstorm hook)
//   first=prorated|extended|reduced (this writer's current hour)
import { openHelp, howTonightWorks, helpSections, setBrainstormOpener } from '/js/help.js';

const q = new URLSearchParams(location.search);
const theme = q.get('theme');
if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;

const role = q.get('role') || 'writer';
const mode = q.get('mode') || 'synced';
const settings = {
  // The writer payload of GET /api/me (lib/party.js meView) ...
  pasteAskOverWords: 12, settleSec: 90, targetPerHour: Number(q.get('target') || 400), hourLengthMin: 60,
  freePassesPerWriter: Number(q.get('passes') ?? 1), personalTargets: false,
  missedHourOutcome: q.get('out') === 'alert-only' ? 'alert-only' : 'out', cutWeight: 0.5, cutMatureMin: 10, shortPastesCount: true,
  ...(mode === 'none' ? {} : { hoursMode: mode, syncMinute: 0, minFirstHourMin: 20 }),
  // ... plus what only the host view carries.
  ...(role === 'host' ? { approvalRequired: true, bigPasteWords: 100, reviewBigPastes: true, speedCapWpm: 90, dictationCapWpm: 180, contextWords: 6, cutCapPerHour: null } : {}),
};
// ?first=prorated|extended|reduced: this writer's current hour (me.hour, SPEC §17/§17b/§19).
const first = q.get('first');
const hour = first ? {
  index: first === 'reduced' ? 2 : 0, startAt: Date.now() - 10 * 60_000, endAt: Date.now() + (first === 'extended' ? 70 : 30) * 60_000,
  target: first === 'prorated' ? 267 : first === 'reduced' ? 200 : 400, prorated: first === 'prorated', extended: first === 'extended',
  ...(first === 'reduced' ? { baseTarget: 400, reducedBy: [{ breakId: 'b1', minutes: 30 }] } : {}),
} : null;
const me = role === 'guest' ? null : { isAdmin: role === 'host', approval: q.get('approval') || 'approved', targetOverride: null, hour };
// ?break=reduce|pause: a dinner break starting in 10 minutes, in that mode (SPEC §19).
const breakMode = q.get('break');
const breaks = breakMode ? [{ id: 'b1', label: 'Dinner break', startAt: Date.now() + 10 * 60_000, endAt: Date.now() + 40 * 60_000, status: 'scheduled', mode: breakMode }] : [];
const opts = role === 'guest' ? {} : { settings, me, role, breaks, partyName: 'Sunday Writing Party' };
// ?brainstorm=1: the writer page's "Before you start" panel, as help can reopen it (SPEC §17b).
if (q.get('brainstorm') === '1') setBrainstormOpener(() => { document.body.dataset.brainstorm = 'opened'; });

function open(section) {
  return openHelp(section, opts);
}
document.getElementById('hh-open').addEventListener('click', () => open());
document.getElementById('hh-open-counting').addEventListener('click', () => open('counting'));
if (q.get('waiting') === '1') {
  const box = document.querySelector('.hh-waiting');
  box.hidden = false;
  for (const line of howTonightWorks(settings)) {
    const li = document.createElement('li');
    li.textContent = line;
    document.getElementById('hh-lines').append(li);
  }
}
window.__help = { open, helpSections, howTonightWorks, settings };
if (q.get('open') !== '0') open(q.get('section') || undefined);
