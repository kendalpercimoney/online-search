// Screens and navigation. The current screen lives in the URL hash so Back/Forward work:
//   #/                home        #/folder/<id>   a folder
//   #/recent          recent      #/shared        shared with me
//   #/search?q=…&in=… search (handled by search.js)

import { desktop, signIn, validToken } from './auth.js';
import { renderCards } from './cards.js';
import { catalogEvents, catalogFolder, folderIndex, isBulkRunning, isCatalogued, stopCataloguing } from './catalog.js';
import { drive, folderInfo, folderPath, folderMedia, isImage, listFolders, listMedia, toItem } from './drive.js';
import { $, ICONS, el, parseFolderId, plural } from './util.js';

export const view = { name: 'home', folderId: null, seq: 0 };
const handlers = {};
let leaveView = () => {};

export const registerView = (name, fn) => { handlers[name] = fn; };
export const currentSeq = () => view.seq;

export function go(hash, { replace = false } = {}) {
  if (location.hash === hash) return route();
  if (replace) {
    history.replaceState(null, '', hash);
    return route();
  }
  location.hash = hash;
}

export function setStatus(text, isError = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', isError);
}

export function renderCrumbs(trail) {
  const nav = $('crumbs');
  nav.replaceChildren();
  if (trail.length) trail = [{ label: 'Home', hash: '#/' }, ...trail];
  trail.forEach((c, i) => {
    if (i) nav.append(el('span', { className: 'sep', textContent: '›' }));
    const last = i === trail.length - 1;
    nav.append(el(last ? 'span' : 'a', { textContent: c.label, title: c.label, ...(!last && { href: c.hash }) }));
  });
}

function tile({ label, hash, icon, tint }) {
  return el('a', { className: 'tile glass', href: hash, title: label },
    el('span', { className: `tile-icon ${tint || ''}`, html: ICONS[icon] }),
    el('span', { className: 'tile-label', textContent: label }));
}

// sections: [{ title?, tiles: [...] }]
export function showTiles(sections) {
  $('tiles').replaceChildren(...sections.filter((s) => s.tiles.length).map((s) =>
    el('section', { className: 'tile-section' },
      s.title && el('h2', { className: 'section-title', textContent: s.title }),
      el('div', { className: 'tile-grid' }, s.tiles.map(tile)))));
}

export function showItems(items) {
  renderCards($('grid'), items);
}

function clear() {
  showTiles([]);
  showItems([]);
}

// "12 videos, 3 photos"
function mediaCount(items) {
  const photos = items.filter(isImage).length, videos = items.length - photos;
  return [videos && plural(videos, 'video'), photos && plural(photos, 'photo')].filter(Boolean).join(', ');
}

function folderTiles(folders) {
  return folders.map((f) => ({ label: f.name, hash: `#/folder/${f.id}`, icon: 'folder' }));
}

export function updateCatalogControls() {
  const running = isBulkRunning();
  $('catalogControls').hidden = running || view.name !== 'folder' || !validToken();
  $('catalogStop').hidden = !running;
}

function showSignedOut() {
  clear();
  renderCrumbs([]);
  setStatus('');
  document.body.classList.add('signed-out');
}

// Keeps a folder's "… catalogued for search" count current while it is on screen.
function trackCatalogued(folderId, folderCount, videos) {
  const update = async () => {
    const idx = await folderIndex(folderId).catch(() => null);
    if (!idx || view.folderId !== folderId) return;
    const done = videos.filter((v) => isCatalogued(idx, v)).length;
    const parts = [folderCount && plural(folderCount, 'folder'), mediaCount(videos)].filter(Boolean);
    setStatus(`${parts.join(', ')} · ${done === videos.length ? 'all' : done} catalogued for search`);
  };
  catalogEvents.addEventListener('change', update);
  update();
  return () => catalogEvents.removeEventListener('change', update);
}

export async function route() {
  const [, name = '', id] = location.hash.match(/^#\/(\w*)\/?([\w-]*)/) || [];
  const seq = ++view.seq;
  const current = () => seq === view.seq;
  leaveView();
  leaveView = () => {};
  view.name = name || 'home';
  view.folderId = name === 'folder' ? id : null;
  document.body.dataset.view = view.name;
  updateCatalogControls();

  if (!validToken()) return showSignedOut();
  document.body.classList.remove('signed-out');
  if (name !== 'search') {
    $('search').value = '';
    $('scope').replaceChildren();
  }

  try {
    if (name === 'search') {
      return await handlers.search(new URLSearchParams(location.hash.split('?')[1] || ''), current);
    }
    clear();
    setStatus('Loading…');
    if (name === 'folder' && id) {
      // folderMedia is cached, which also lets search reuse this listing for results.
      const [path, folders, videoMap] = await Promise.all([
        folderPath(id), listFolders(`'${id}' in parents`), folderMedia(id, { refresh: true }),
      ]);
      const videos = [...videoMap.values()];
      if (!current()) return;
      view.folderId = path.at(-1)?.id || id; // 'root' becomes My Drive's real id
      renderCrumbs(path.map((f) => ({ label: f.name, hash: `#/folder/${f.id}` })));
      showTiles([{ tiles: folderTiles(folders) }]);
      const items = videos.map(toItem);
      showItems(items);
      localStorage.setItem('scrub.lastFolder', id);
      localStorage.setItem('scrub.lastFolderName', path.at(-1)?.name || '');
      if (items.length) leaveView = trackCatalogued(view.folderId, folders.length, items);
      else setStatus(folders.length ? plural(folders.length, 'folder') : 'This folder is empty.');
      updateCatalogControls();
    } else if (name === 'recent') {
      const videos = await listMedia('', 'modifiedTime desc', 100);
      if (!current()) return;
      renderCrumbs([{ label: 'Recent' }]);
      const items = videos.map(toItem);
      showItems(items);
      setStatus(items.length ? `${mediaCount(items)}, newest first` : 'Nothing recent.');
    } else if (name === 'shared') {
      const [folders, videos] = await Promise.all([listFolders('sharedWithMe = true'), listMedia('sharedWithMe = true')]);
      if (!current()) return;
      renderCrumbs([{ label: 'Shared with me' }]);
      showTiles([{ tiles: folderTiles(folders) }]);
      const items = videos.map(toItem);
      showItems(items);
      setStatus([folders.length && plural(folders.length, 'folder'), mediaCount(items)].filter(Boolean).join(', ') || 'Nothing shared with you yet.');
    } else {
      const { drives = [] } = await drive('drives', { pageSize: 100, fields: 'drives(id,name)' });
      if (!current()) return;
      renderCrumbs([]);
      const last = localStorage.getItem('scrub.lastFolder');
      showTiles([
        {
          title: 'Library',
          tiles: [
            { label: 'My Drive', hash: '#/folder/root', icon: 'drive', tint: 'blue' },
            { label: 'Shared with me', hash: '#/shared', icon: 'shared', tint: 'green' },
            { label: 'Recent', hash: '#/recent', icon: 'recent', tint: 'orange' },
            ...(last && last !== 'root' ? [{ label: localStorage.getItem('scrub.lastFolderName') || folderInfo.get(last)?.name || 'Last opened folder', hash: `#/folder/${last}`, icon: 'folder', tint: 'purple' }] : []),
          ],
        },
        { title: 'Shared drives', tiles: drives.map((d) => ({ label: d.name, hash: `#/folder/${d.id}`, icon: 'drive' })) },
      ]);
      setStatus('');
    }
  } catch (err) {
    if (current()) setStatus(err.message, true);
  }
}

export function initViews() {
  window.addEventListener('hashchange', route);
  $('welcomeSignIn').onclick = async () => {
    if (!desktop && !localStorage.getItem('scrub.clientId')) return $('openSettings').click();
    $('welcomeMessage').textContent = desktop ? 'Finish signing in in your web browser…' : '';
    try {
      await signIn();
      $('welcomeMessage').textContent = '';
    } catch (err) {
      $('welcomeMessage').textContent = err.message;
    }
  };
  $('catalogBtn').onclick = () => catalogFolder(view.folderId, $('catalogRecursive').checked);
  $('catalogStop').onclick = stopCataloguing;
  catalogEvents.addEventListener('status', (e) => { $('catalogStatus').textContent = e.detail; });
  catalogEvents.addEventListener('change', updateCatalogControls);
  $('openLink').onclick = () => { $('linkDialog').showModal(); $('linkInput').value = ''; $('linkInput').focus(); };
  $('linkForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = parseFolderId($('linkInput').value);
    $('linkDialog').close();
    if (id) go(`#/folder/${id}`);
  });
  $('linkDialog').addEventListener('click', (e) => { if (e.target === $('linkDialog')) $('linkDialog').close(); });
}
