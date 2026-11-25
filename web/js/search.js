// Search as you type. Results arrive in stages and the grid updates in place:
//   1. catalogued file names containing the text (from memory, instant)
//   2. clips whose shots look like the text (MobileCLIP, ~0.1 s once the model is warm)
//   3. Drive's own file-name search, which also covers clips not catalogued yet
// Searching from inside a folder covers that folder and its subfolders.

import { validToken } from './auth.js';
import { loadLibrary, searchNames, searchVisual } from './catalog.js';
import { folderPath, folderMedia, isImage, isInside, listMedia, quote, toItem } from './drive.js';
import { modelEvents, warmTextModel } from './embed.js';
import { $, bytes, debounce, el, mapLimit, plural, timecode } from './util.js';
import { go, registerView, renderCrumbs, route, setStatus, showItems, showTiles, view } from './views.js';

const VISUAL_MIN_CHARS = 3; // shorter fragments rarely describe anything visual
const DRIVE_MIN_CHARS = 2;

let returnHash = '#/';

const hashFor = (q, within) => `#/search?q=${encodeURIComponent(q)}${within ? `&in=${within}` : ''}`;
const currentScope = () => new URLSearchParams(location.hash.split('?')[1] || '').get('in');

const runSoon = debounce(route, 150);

function onInput() {
  const q = $('search').value.trim();
  if (!q) return leave();
  if (!validToken()) return;
  const inSearch = location.hash.startsWith('#/search');
  if (!inSearch) {
    returnHash = location.hash || '#/';
    const within = view.name === 'folder' ? view.folderId : null;
    history.pushState(null, '', hashFor(q, within)); // Back returns to where the search started
  } else {
    history.replaceState(null, '', hashFor(q, currentScope()));
  }
  runSoon();
}

function leave() {
  runSoon.cancel();
  if (location.hash.startsWith('#/search')) go(returnHash, { replace: true });
}

// Drive file objects for catalogue hits, from cached folder listings (one request per
// folder, shared by every keystroke).
async function filesFor(hits) {
  const folders = [...new Set(hits.map((h) => h.folder))];
  const listings = new Map(await mapLimit(folders, 8, async (f) => [f, await folderMedia(f).catch(() => new Map())]));
  return hits.map((h) => listings.get(h.folder)?.get(h.id)).filter(Boolean);
}

async function driveNameSearch(q, within) {
  const files = await listMedia(`name contains '${quote(q)}'`, 'name', 100).catch(() => []);
  if (!within) return files;
  const inside = await mapLimit(files, 8, (f) => isInside(f.parents?.[0], within).catch(() => false));
  return files.filter((_, i) => inside[i]);
}

function scopeToggle(q, within, scopeName) {
  const node = $('scope');
  node.replaceChildren();
  const origin = within || (returnHash.startsWith('#/folder/') ? returnHash.slice(9) : null);
  if (!origin) return;
  const label = within ? scopeName : 'This folder';
  node.append(
    el('button', { className: `seg ${within ? 'on' : ''}`, textContent: label, onclick: () => go(hashFor(q, origin), { replace: true }) }),
    el('button', { className: `seg ${within ? '' : 'on'}`, textContent: 'Everywhere', onclick: () => go(hashFor(q, null), { replace: true }) }),
  );
}

async function render(params, current) {
  const q = (params.get('q') || '').trim();
  const within = params.get('in');
  if (document.activeElement !== $('search')) $('search').value = q; // arrived via Back/Forward
  if (!q) return go(returnHash, { replace: true });
  if (!returnHash.startsWith('#/folder/') && within) returnHash = `#/folder/${within}`;

  showTiles([]);
  const scope = within ? await folderPath(within) : [];
  if (!current()) return;
  const scopeName = scope.at(-1)?.name || 'this folder';
  renderCrumbs([...scope.map((f) => ({ label: f.name, hash: `#/folder/${f.id}` })), { label: `“${q}”` }]);
  scopeToggle(q, within, scopeName);
  if (!$('grid').children.length) setStatus('Searching…');

  const found = { names: [], drive: [], visual: [], total: 0 };
  const present = async (final) => {
    const [nameFiles, visualFiles] = await Promise.all([filesFor(found.names), filesFor(found.visual)]);
    if (!current()) return;
    const items = [];
    const seen = new Set();
    for (const f of [...found.drive, ...nameFiles].sort((a, b) => a.name.localeCompare(b.name))) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      const item = toItem(f);
      item.sub = [!isImage(item) && timecode(item.duration), bytes(item.size), 'name match'].filter(Boolean).join(' · ');
      items.push(item);
    }
    visualFiles.forEach((f, i) => {
      if (seen.has(f.id)) return;
      const hit = found.visual.find((v) => v.id === f.id);
      const item = toItem(f);
      if (isImage(item)) item.sub = [bytes(item.size), 'looks like a match'].join(' · ');
      else {
        item.matchTime = hit?.time ?? 0;
        item.sub = [timecode(item.duration), bytes(item.size), `match at ${timecode(item.matchTime)}`].join(' · ');
      }
      items.push(item);
    });
    showItems(items);
    const where = within ? `in ${scopeName}` : 'everywhere';
    if (items.length) setStatus(`${plural(items.length, 'result')} for “${q}” ${where}`);
    else if (final) setStatus(found.total ? `Nothing matches “${q}” ${where}.` : `Nothing catalogued ${where} yet. Open a folder and choose Catalog folder.`);
  };

  const names = await searchNames(q, within);
  if (!current()) return;
  found.names = names.hits;
  found.total = names.total;
  await present(false);

  const visual = q.length >= VISUAL_MIN_CHARS
    ? searchVisual(q, within).then((v) => { found.visual = v; return current() && present(false); })
    : null;
  const drive = q.length >= DRIVE_MIN_CHARS
    ? driveNameSearch(q, within).then((f) => { found.drive = f; return current() && present(false); })
    : null;
  await Promise.allSettled([visual, drive].filter(Boolean));
  if (current()) await present(true);
}

export function initSearch() {
  registerView('search', render);
  const box = $('search');
  box.addEventListener('input', onInput);
  box.addEventListener('focus', () => {
    if (!validToken()) return;
    warmTextModel();
    loadLibrary().catch(() => {});
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { box.value = ''; leave(); box.blur(); }
  });
  $('searchForm').addEventListener('submit', (e) => { e.preventDefault(); runSoon.cancel(); route(); });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); box.focus(); box.select(); }
  });
  modelEvents.addEventListener('progress', (e) => { $('modelStatus').textContent = e.detail; });
}
