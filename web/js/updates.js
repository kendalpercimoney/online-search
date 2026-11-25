// Update notices in the Mac app (desktop/updates.js checks, downloads and installs). A new
// version downloads in the background; once it's ready a notice offers Restart now, and
// Later installs it the next time the app quits. Settings has Check for updates.

import { desktop } from './auth.js';
import { $, el } from './util.js';

const api = desktop?.updates;
let status = { state: 'idle' };
let toast = null;
let laterFor = null; // a version the person said "Later" to, this session

const pct = (s) => (s.total ? Math.round((s.received / s.total) * 100) : 0);

const MAX_FEATURES = 6;

// Release notes are a list of features, one per line ("- " or "• " in front is optional).
function features(notes = '') {
  return notes.replace(/\r/g, '').split('\n').map((l) => l.replace(/^\s*[-•*]\s*/, '').trim()).filter(Boolean);
}

function closeToast() {
  toast?.remove();
  toast = null;
}

function renderToast() {
  const s = status;
  if (s.state !== 'ready' || laterFor === s.version) return closeToast();
  closeToast();
  const button = (text, onclick, primary) => el('button', { className: `pill small ${primary ? 'primary' : ''}`, textContent: text, onclick });
  const auto = s.mode === 'auto';
  const list = features(s.notes);
  const shown = list.length > MAX_FEATURES ? list.slice(0, MAX_FEATURES - 1) : list;
  toast = el('div', { className: 'toast glass update done' },
    el('div', { className: 'toast-kicker', textContent: 'Update ready' }),
    el('div', { className: 'toast-title', textContent: `Online Search ${s.version}` }),
    list.length > 0 && el('div', { className: 'toast-section', textContent: 'What’s new' }),
    list.length > 0 && el('ul', { className: 'toast-list' },
      shown.map((f) => el('li', { textContent: f })),
      list.length > shown.length && el('li', { className: 'more', textContent: `and ${list.length - shown.length} more` })),
    el('div', { className: 'toast-sub', textContent: auto
      ? 'Installs on restart, or automatically on next quit.'
      : 'Opens the installer: drag Online Search into Applications and choose Replace.' }),
    el('div', { className: 'toast-actions' },
      button('Later', () => { laterFor = s.version; closeToast(); }),
      button(auto ? 'Restart now' : 'Install…', () => api.quit(), true)));
  $('toasts').prepend(toast);
}

function renderSettings() {
  const s = status;
  const detail = $('updateDetail'), btn = $('updateButton');
  if (s.current) $('updateVersion').textContent = `Online Search ${s.current}`;
  btn.disabled = false;
  btn.classList.remove('primary');
  switch (s.state) {
    case 'checking':
      detail.textContent = 'Checking…';
      btn.disabled = true;
      break;
    case 'current':
      detail.textContent = 'Up to date.';
      break;
    case 'available':
      detail.textContent = `Version ${s.version} is available.`;
      btn.classList.add('primary');
      break;
    case 'downloading':
      detail.textContent = `Downloading ${s.version}: ${pct(s)}%`;
      break;
    case 'ready':
      detail.textContent = s.mode === 'auto'
        ? `Version ${s.version} is ready. Installs on restart or next quit.`
        : `Version ${s.version} is downloaded and ready to install.`;
      btn.classList.add('primary');
      break;
    case 'error':
      detail.textContent = `Couldn’t check for updates: ${s.error}`;
      break;
    default:
      detail.textContent = 'New versions are checked for automatically.';
  }
  btn.textContent = { available: 'Download', downloading: 'Cancel', ready: s.mode === 'auto' ? 'Restart now' : 'Install…' }[s.state] || 'Check for updates';
}

function onButton() {
  if (status.state === 'available') return api.download();
  if (status.state === 'downloading') return api.cancel();
  if (status.state === 'ready') return api.quit();
  laterFor = null; // a manual check shows the notice again
  return api.check();
}

function apply(s) {
  status = s;
  renderToast();
  renderSettings();
}

export function initUpdates() {
  $('updatesSection').hidden = !api;
  if (!api) return;
  $('updateButton').onclick = onButton;
  api.onChange(apply);
  api.status().then(apply);
}
