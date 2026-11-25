// Full-size player. In the Mac app it streams one of Drive's smaller copies (copies.js),
// picked to suit the connection or chosen in the quality menu, like drive.google.com does.
// "Original" (and clips without copies) plays the camera file itself. Opening an original
// normally costs several slow trips to Drive in a row (file start, then the index at the
// end, then the point being played), so those bytes are fetched in parallel up front and
// handed to the service worker.

import { autoStream, copyUrl, currentSpeed, driveCopies } from './copies.js';
import { canDownload, download } from './downloads.js';
import { cachedFileEnds, endWindows, pauseBackground, readTrack } from './filmstrip.js';
import { expectRange, rangeFailed, shareRange } from './sw-client.js';
import { $, ICONS } from './util.js';

const MB = 1024 * 1024;
const HEAD = 4 * MB;      // camera files put the first frame right after a short header
const SEEK_LEAD = 1 * MB; // the player starts reading a little before the keyframe it seeks to
const SLACK = 256 * 1024; // and a little past it
const BLOCK = 32 * 1024;  // in 32 KB blocks

let session = null; // { item, controller, resume, streams, mbps, playing }

const QUALITY_KEY = 'os.quality'; // 'auto', 'original', or a label such as '720p'
const getQuality = () => localStorage.getItem(QUALITY_KEY) || 'auto';

const align = (n) => Math.max(0, Math.floor(n / BLOCK) * BLOCK);

function fetchRange(item, from, to) {
  expectRange(item.id, from, to, item.mime);
  return item.read(from, to - from)
    .then((bytes) => shareRange(item.id, from, bytes, item.mime))
    .catch(() => rangeFailed(item.id, from));
}

// What the player reads before the first frame shows, in order: the file start, the index
// (at the end for camera files), the first frame (even when starting later), then the
// keyframe it seeks to. One parallel round of requests covers the first three; starting
// mid-clip needs one more once the index says where that keyframe is. Everything is
// announced to the service worker before it arrives and the player starts at once, so its
// requests line up with these downloads. Past these ranges, video streams from Drive.
async function prefetch(item, startAt) {
  const windows = endWindows(item.size, HEAD);
  if (!cachedFileEnds(item.id)) {
    expectRange(item.id, 0, windows.headLen, item.mime);
    expectRange(item.id, windows.tailStart, item.size, item.mime);
  }
  const track = await readTrack(item, { headBytes: HEAD }).catch(() => null);
  const ends = cachedFileEnds(item.id);
  if (!track || !ends) {
    rangeFailed(item.id, 0);
    rangeFailed(item.id, windows.tailStart);
    return;
  }
  shareRange(item.id, 0, ends.head, item.mime);
  if (ends.tail) shareRange(item.id, ends.tailStart, ends.tail, item.mime);

  const first = track.keys[0];
  let key = first;
  for (const k of track.keys) if (k.time <= startAt + 0.01) key = k;
  if (!first) return;
  const wanted = [];
  const firstEnd = first.offset + first.size + SLACK;
  if (firstEnd > ends.head.length) wanted.push([ends.head.length, firstEnd]);
  if (key !== first) wanted.push([align(key.offset - SEEK_LEAD), key.offset + key.size + SLACK]);
  await Promise.all(wanted.map(([from, to]) => {
    to = Math.min(to, ends.tail ? ends.tailStart : item.size);
    return to > from ? fetchRange(item, from, to) : null;
  }));
}

function chooseStream(streams, mbps) {
  const q = getQuality();
  if (q === 'original' || !streams.length) return null;
  return streams.find((s) => s.label === q) || autoStream(streams, mbps);
}

function renderQuality() {
  const sel = $('playerQuality');
  const { streams = [], playing } = session || {};
  sel.hidden = !streams.length;
  if (!streams.length) return;
  const q = getQuality();
  const autoLabel = q === 'auto' && playing ? `Auto (${playing.label})` : 'Auto';
  sel.replaceChildren(...[['auto', autoLabel], ...[...streams].reverse().map((s) => [s.label, s.label]), ['original', 'Original']]
    .map(([value, text]) => new Option(text, value, false, value === q)));
}

// Points the video at a copy or the original, keeping the position and play state.
function load(startAt, autoplay = true) {
  const { item, controller: { signal } } = session;
  const v = $('playerVideo');
  const stream = chooseStream(session.streams, session.mbps);
  session.playing = stream;
  renderQuality();
  $('player').classList.add('loading');
  v.addEventListener('loadedmetadata', () => {
    v.currentTime = Math.min(startAt, Math.max(0, v.duration - 0.1));
    if (autoplay) v.play().catch(() => {});
    else $('player').classList.remove('loading');
  }, { once: true, signal });
  if (stream) v.src = copyUrl(item, stream);
  else {
    prefetch(item, startAt).catch(() => {});
    v.src = item.src;
  }
}

function openSheet(item) {
  $('playerName').textContent = item.name;
  $('playerDownload').hidden = !canDownload(item);
  $('playerMessage').textContent = '';
  $('player').classList.add('loading');
  $('player').hidden = false;
  document.body.classList.add('modal-open');
}

// ---------- photos ----------
// Shown from Drive's large thumbnail (2400 pixels, any format Drive understands), or the
// file itself when Drive has no thumbnail. ← and → step through the photos in the grid.

let photos = null; // { list, index }

function showPhoto(index) {
  const item = photos.list[index];
  photos.index = index;
  const img = $('playerImage');
  openSheet(item);
  session.item = item;
  $('photoPrev').disabled = index <= 0;
  $('photoNext').disabled = index >= photos.list.length - 1;
  // The grid's small thumbnail is already loaded, so it shows at once and the sharp
  // version replaces it when it arrives.
  const sources = [item.large, item.src].filter(Boolean);
  const current = () => session?.item === item;
  const shown = () => { img.hidden = false; $('player').classList.remove('loading'); };
  let sharp = false;
  if (item.thumb) {
    img.onload = () => current() && !sharp && shown();
    img.onerror = null;
    img.src = item.thumb;
  } else img.hidden = true;
  const tryNext = () => {
    if (!current()) return;
    const src = sources.shift();
    if (!src) {
      if (!img.hidden) return; // the small version is better than nothing
      $('player').classList.remove('loading');
      $('playerMessage').textContent = 'This photo can’t be shown here. Download it or open it in Google Drive.';
      return;
    }
    const full = new Image();
    full.referrerPolicy = 'no-referrer';
    full.onload = () => {
      if (!current()) return;
      sharp = true;
      img.onload = img.onerror = null;
      img.src = src;
      shown();
    };
    full.onerror = tryNext;
    full.src = src;
  };
  tryNext();
  // Load the neighbours so stepping through feels instant.
  for (const n of [photos.list[index + 1], photos.list[index - 1]]) if (n?.large) Object.assign(new Image(), { referrerPolicy: 'no-referrer', src: n.large });
}

export function openPhoto(item, list = [item]) {
  closePlayer();
  session = { item, controller: new AbortController(), resume: pauseBackground(), streams: [], photo: true };
  photos = { list: list.includes(item) ? list : [item], index: 0 };
  $('playerVideo').hidden = true;
  $('playerQuality').hidden = true;
  const many = photos.list.length > 1;
  $('photoPrev').hidden = $('photoNext').hidden = !many;
  showPhoto(photos.list.indexOf(item));
}

const stepPhoto = (by) => {
  const i = photos.index + by;
  if (i >= 0 && i < photos.list.length) showPhoto(i);
};

// ---------- video ----------

export async function openPlayer(item, startAt = 0) {
  closePlayer();
  const controller = new AbortController();
  const { signal } = controller;
  const own = { item, controller, resume: pauseBackground(), streams: [], mbps: null, playing: null };
  session = own;
  const v = $('playerVideo');
  v.hidden = false;
  openSheet(item);

  $('playerQuality').hidden = true;
  v.addEventListener('playing', () => $('player').classList.remove('loading'), { signal });
  v.addEventListener('waiting', () => $('player').classList.add('loading'), { signal });
  v.addEventListener('error', () => {
    if (!v.getAttribute('src')) return;
    if (session.playing) { // the copy failed: play the original instead
      session.streams = [];
      load(v.currentTime || startAt);
      return;
    }
    $('player').classList.remove('loading');
    $('playerMessage').textContent = 'This clip can’t be played here. Its format may not be supported by the app (for example ProRes).';
  }, { signal });

  const [{ streams }, mbps] = await Promise.all([driveCopies(item), currentSpeed()]);
  if (session !== own) return; // closed or replaced while looking up copies
  Object.assign(session, { streams, mbps });
  load(startAt);
}

export function closePlayer() {
  if (!session) return;
  session.controller.abort();
  session.resume();
  session = null;
  photos = null;
  const img = $('playerImage');
  img.onload = img.onerror = null;
  img.removeAttribute('src');
  img.hidden = true;
  $('photoPrev').hidden = $('photoNext').hidden = true;
  const v = $('playerVideo');
  v.pause();
  v.removeAttribute('src');
  v.load();
  $('player').hidden = true;
  document.body.classList.remove('modal-open');
}

export function initPlayer() {
  $('closePlayer').onclick = closePlayer;
  $('playerQuality').addEventListener('change', (e) => {
    localStorage.setItem(QUALITY_KEY, e.target.value);
    if (!session) return;
    const v = $('playerVideo');
    load(v.currentTime, !v.paused);
  });
  $('playerDownload').onclick = () => session && download(session.item);
  $('playerDrive').onclick = () => session && window.open(`https://drive.google.com/file/d/${session.item.id}/view`, '_blank', 'noopener');
  $('player').addEventListener('click', (e) => { if (e.target === $('player')) closePlayer(); });
  $('photoPrev').innerHTML = ICONS.prev;
  $('photoNext').innerHTML = ICONS.next;
  $('photoPrev').onclick = () => stepPhoto(-1);
  $('photoNext').onclick = () => stepPhoto(1);
  document.addEventListener('keydown', (e) => {
    if (!session) return;
    const v = $('playerVideo');
    if (e.key === 'Escape') closePlayer();
    else if (session.photo) {
      if (e.key === 'ArrowLeft') stepPhoto(-1);
      else if (e.key === 'ArrowRight') stepPhoto(1);
      else return;
    }
    else if (e.key === 'ArrowLeft') v.currentTime -= e.shiftKey ? 1 : 5;
    else if (e.key === 'ArrowRight') v.currentTime += e.shiftKey ? 1 : 5;
    else if (e.key === ' ' && e.target === document.body) (v.paused ? v.play() : v.pause());
    else return;
    e.preventDefault();
  });
}
