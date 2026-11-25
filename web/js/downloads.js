// Downloads. In the Mac app, files save straight to the Downloads folder with progress
// shown here; in a browser, Drive's own download link opens in a new tab.

import { desktop } from './auth.js';
import { pauseBackground } from './filmstrip.js';
import { $, bytes, el } from './util.js';

export const canDownload = (item) => (desktop ? !!item.id : !!item.webContentLink);

export function download(item) {
  if (desktop) desktop.download({ fileId: item.id, name: item.name, size: item.size });
  else window.open(item.webContentLink, '_blank', 'noopener');
}

const toasts = new Map(); // download id -> { node, timer }
const active = new Map(); // download id -> resume(), pausing background downloads meanwhile

function render(d) {
  if (d.state === 'progressing' && !active.has(d.id)) active.set(d.id, pauseBackground());
  if (d.state !== 'progressing') { active.get(d.id)?.(); active.delete(d.id); }
  let t = toasts.get(d.id);
  if (!t) {
    const node = el('div', { className: 'toast glass' },
      el('div', { className: 'toast-title' }),
      el('div', { className: 'toast-sub' }),
      el('div', { className: 'toast-bar' }, el('div')),
      el('div', { className: 'toast-actions' }));
    $('toasts').append(node);
    t = { node };
    toasts.set(d.id, t);
  }
  const { node } = t;
  node.querySelector('.toast-title').textContent = d.name;
  const actions = node.querySelector('.toast-actions');
  actions.replaceChildren();
  const pct = d.total ? Math.round((d.received / d.total) * 100) : 0;
  node.querySelector('.toast-bar > div').style.width = `${d.state === 'completed' ? 100 : pct}%`;
  node.classList.toggle('done', d.state !== 'progressing');
  if (d.state === 'progressing') {
    node.querySelector('.toast-sub').textContent = d.total ? `${pct}% · ${bytes(d.received)} of ${bytes(d.total)}` : `${bytes(d.received)}`;
    actions.append(el('button', { className: 'pill small', textContent: 'Cancel', onclick: () => desktop.cancelDownload(d.id) }));
    return;
  }
  node.querySelector('.toast-sub').textContent =
    d.state === 'completed' ? 'Saved to Downloads' : d.state === 'cancelled' ? 'Cancelled' : `Download failed${d.error ? `: ${d.error}` : ''}`;
  if (d.state === 'completed') {
    actions.append(el('button', { className: 'pill small', textContent: 'Show in Finder', onclick: () => desktop.revealDownload(d.path) }));
  }
  clearTimeout(t.timer);
  t.timer = setTimeout(() => { node.remove(); toasts.delete(d.id); }, d.state === 'completed' ? 10000 : 6000);
}

export function initDownloads() {
  desktop?.onDownload(render);
}
