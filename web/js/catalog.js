// The search catalogue. Clips are catalogued by running frames through MobileCLIP
// (embed.js) and keeping one compressed embedding per distinct shot. Each folder has one
// shared index file on Google Drive that everyone reads and adds to. See PRODUCT.md §4.
//
// Cataloguing is cheap first, detailed later (see "Detail levels"): Drive's own thumbnail
// (the clip's first frame, ~30 KB) makes a clip searchable almost instantly; keyframes and
// hover filmstrips add more moments afterwards.

import { validToken } from './auth.js';
import { readableThumb } from './copies.js';
import { drive, driveFetch, isImage, isInside, listFolders, listMedia, mediaUrl, toItem } from './drive.js';
import { EMBED_DIM, EMBED_MODEL, dot, embedImages, embedText } from './embed.js';
import { sampleFrames } from './filmstrip.js';
import { idbGet, idbPut } from './idb.js';
import { getStrip } from './strips.js';
import { mapLimit } from './util.js';

const INDEX_NAME = '.footage-scrub.idx'; // working-title name; renaming would orphan existing catalogues
const INDEX_VERSION = 1;
const SHOT_SIMILARITY = 0.9;  // a frame this similar to the last kept frame is the same shot
const MAX_SHOTS = 24;
const MATCH_FLOOR = 0.2;      // weakest visual score shown as a result
const MATCH_WINDOW = 0.06;    // also hide results this far below the best match
const MAX_RESULTS = 120;
const SAVE_DELAY = 4000;
const BULK_PARALLEL = 8;
const QUICK_SPACING = 15;     // one extra keyframe per this many seconds of clip
const QUICK_MAX_KEYFRAMES = 6;
const THUMB_MIN_GAP = 80;     // ms between thumbnail requests at full speed (~12 a second)
const LIBRARY_TTL = 2 * 60 * 1000;

export const catalogEvents = new EventTarget(); // 'status' (detail: text), 'change'
const say = (text) => catalogEvents.dispatchEvent(new CustomEvent('status', { detail: text }));
const changed = () => catalogEvents.dispatchEvent(new Event('change'));

// ---------- compact vectors ----------

const round2 = (x) => Math.round(x * 100) / 100;

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// One signed byte per number plus a scale per vector: 4× smaller than floats, and search
// ranking is effectively unchanged.
function encodeVectors(vectors) {
  const bytes = new Int8Array(vectors.length * EMBED_DIM);
  const scales = vectors.map((v, i) => {
    let max = 0;
    for (const x of v) max = Math.max(max, Math.abs(x));
    const scale = max / 127 || 1;
    for (let j = 0; j < EMBED_DIM; j++) bytes[i * EMBED_DIM + j] = Math.round(v[j] / scale);
    return +scale.toPrecision(5);
  });
  return { s: scales, e: toBase64(new Uint8Array(bytes.buffer)) };
}

const decoded = new WeakMap();
function decodeVectors(entry) {
  let vectors = decoded.get(entry);
  if (vectors) return vectors;
  const bytes = new Int8Array(fromBase64(entry.e).buffer);
  vectors = entry.s.map((scale, i) => {
    const v = new Float32Array(EMBED_DIM);
    let len = 0;
    for (let j = 0; j < EMBED_DIM; j++) { v[j] = bytes[i * EMBED_DIM + j] * scale; len += v[j] * v[j]; }
    len = Math.sqrt(len) || 1;
    for (let j = 0; j < EMBED_DIM; j++) v[j] /= len;
    return v;
  });
  decoded.set(entry, vectors);
  return vectors;
}

// Keep a frame only when it looks different from the last one kept, so a static shot
// costs one vector and a clip that cuts between angles costs one per angle.
function distinctShots(times, vectors) {
  let shots = [];
  vectors.forEach((v, i) => {
    if (!shots.length || dot(v, shots.at(-1).v) < SHOT_SIMILARITY) shots.push({ time: times[i], v });
  });
  if (shots.length > MAX_SHOTS) shots = Array.from({ length: MAX_SHOTS }, (_, i) => shots[Math.floor((i * shots.length) / MAX_SHOTS)]);
  return shots;
}

// ---------- index files on Drive ----------

let writerIdPromise;
const myWriterId = () => (writerIdPromise ??= drive('about', { fields: 'user(permissionId)' }).then((r) => r.user.permissionId));

async function listIndexFiles(folderId) {
  const files = [];
  let pageToken;
  do {
    const res = await drive('files', {
      q: `name = '${INDEX_NAME}' and trashed = false${folderId ? ` and '${folderId}' in parents` : ''}`,
      pageSize: 1000, fields: 'nextPageToken,files(id,parents,modifiedTime)',
      supportsAllDrives: true, includeItemsFromAllDrives: true, corpora: 'allDrives',
      ...(pageToken && { pageToken }),
    });
    files.push(...res.files);
    pageToken = res.nextPageToken;
  } while (pageToken);
  return files;
}

// Index contents are cached in the browser and only re-downloaded when the file changes.
async function readIndex(file) {
  const cached = await idbGet('indexes', file.id);
  if (cached?.modifiedTime === file.modifiedTime) return cached.data;
  const data = await (await driveFetch(mediaUrl(file.id))).json();
  idbPut('indexes', file.id, { modifiedTime: file.modifiedTime, data });
  return data;
}

// Embeddings from different models can't be compared, so entries from another model
// count as not catalogued and get redone.
const usableIndex = (data) => data?.v === INDEX_VERSION && data.model === EMBED_MODEL && data.dim === EMBED_DIM;

async function readIndexes(files) {
  const results = await mapLimit(files, 8, (f) => readIndex(f).catch(() => null));
  return files.map((file, i) => ({ file, data: results[i] })).filter((x) => usableIndex(x.data));
}

// The catalogue for one folder: every usable index file merged, plus the shared file
// that new entries are written to (the first usable one, whoever made it).
const folderIndexes = new Map(); // folderId -> Promise<FolderIndex>

export function folderIndex(folderId) {
  let p = folderIndexes.get(folderId);
  if (!p) {
    p = loadFolderIndex(folderId);
    folderIndexes.set(folderId, p);
    p.catch(() => folderIndexes.delete(folderId));
  }
  return p;
}

async function loadFolderIndex(folderId) {
  const idx = { folderId, clips: new Map(), mine: null, readOnly: false, dirty: false, saveTimer: null, saving: Promise.resolve() };
  for (const { file, data } of await readIndexes(await listIndexFiles(folderId))) {
    for (const [id, entry] of Object.entries(data.clips || {})) if (!idx.clips.has(id)) idx.clips.set(id, entry);
    idx.mine ??= { fileId: file.id, data };
  }
  idx.mine ??= { fileId: null, data: { v: INDEX_VERSION, model: EMBED_MODEL, dim: EMBED_DIM, folder: folderId, clips: {} } };
  return idx;
}

export const isCatalogued = (idx, item) => idx.clips.get(item.id)?.m === item.modifiedTime;

function addEntry(idx, fileId, entry) {
  idx.dirty = true;
  idx.clips.set(fileId, entry);
  idx.mine.data.clips[fileId] = entry;
  library?.entries.set(fileId, { id: fileId, entry, folder: idx.folderId });
  clearTimeout(idx.saveTimer);
  idx.saveTimer = setTimeout(() => saveIndex(idx), SAVE_DELAY);
}

function saveIndex(idx) {
  clearTimeout(idx.saveTimer);
  idx.saveTimer = null;
  idx.saving = idx.saving.then(() => writeIndex(idx)).catch((err) => {
    idx.dirty = true;
    console.warn('Saving catalogue failed:', err);
    if (err.status === 403) {
      idx.readOnly = true;
      say('Can’t save the catalogue here: you need edit access to this folder.');
    }
  });
  return idx.saving;
}

async function writeIndex(idx) {
  if (!idx.dirty) return;
  idx.dirty = false;
  let file;
  if (idx.mine.fileId) {
    try {
      // Merge in clips others added since we read it, so nobody's work is lost.
      const latest = await (await driveFetch(mediaUrl(idx.mine.fileId))).json();
      for (const [id, entry] of Object.entries(latest.clips || {})) idx.mine.data.clips[id] ??= entry;
    } catch (err) {
      if (err.status !== 403 && err.status !== 404) throw err;
      idx.mine.fileId = null;
    }
  }
  const body = JSON.stringify(idx.mine.data);
  if (idx.mine.fileId) {
    const url = `https://www.googleapis.com/upload/drive/v3/files/${idx.mine.fileId}?uploadType=media&supportsAllDrives=true&fields=id,modifiedTime`;
    try {
      file = await (await driveFetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body })).json();
    } catch (err) {
      if (err.status !== 403 && err.status !== 404) throw err;
      idx.mine.fileId = null; // no write access to the shared file: save a second one, merged when read
    }
  }
  if (!idx.mine.fileId) {
    const boundary = `os${Math.random().toString(36).slice(2)}`;
    const meta = {
      name: INDEX_NAME, parents: [idx.folderId], mimeType: 'application/json',
      description: 'Online Search catalogue (Percimoney Technologies). Safe to delete: it is rebuilt when clips are catalogued again.',
      appProperties: { fsIndex: '1', writer: await myWriterId() },
    };
    const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`
      + `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
    const url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,modifiedTime';
    file = await (await driveFetch(url, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart })).json();
    idx.mine.fileId = file.id;
  }
  idbPut('indexes', file.id, { modifiedTime: file.modifiedTime, data: idx.mine.data });
  changed();
}

// ---------- cataloguing ----------

// Detail levels, stored on each entry as q (no q means full):
//   1  Drive thumbnail only (first frame). Seconds for a whole library.
//   2  thumbnail plus a keyframe every 15 s. The same as 1 for clips under 15 s.
//   3  every hover-filmstrip frame.
const FULL = 3;
const extraKeyframes = (item) => Math.min(QUICK_MAX_KEYFRAMES, Math.floor((item.duration || 0) / QUICK_SPACING));

function catalogLevel(idx, item) {
  const entry = idx.clips.get(item.id);
  return entry?.m === item.modifiedTime ? entry.q || FULL : 0;
}

// Google's thumbnail server answers 429 when fetched too fast, so every thumbnail fetch
// shares one pace: it halves on a 429 (pausing everyone briefly) and recovers slowly.
const pace = { gapMs: THUMB_MIN_GAP, nextAt: 0 };
async function fetchThumbnail(url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const now = Date.now();
    const wait = Math.max(0, pace.nextAt - now);
    pace.nextAt = Math.max(now, pace.nextAt) + pace.gapMs;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const res = await fetch(readableThumb(url));
    if (res.ok) {
      pace.gapMs = Math.max(THUMB_MIN_GAP, pace.gapMs * 0.98);
      return createImageBitmap(await res.blob());
    }
    if (res.status !== 429) throw new Error(`Thumbnail ${res.status}`);
    pace.gapMs = Math.min(4000, pace.gapMs * 2);
    pace.nextAt = Date.now() + pace.gapMs * 8;
  }
  throw new Error('Google is limiting thumbnail requests; try again in a few minutes');
}

// A photo is one frame: Drive's 640-pixel thumbnail, or the file itself when Drive has none.
const MAX_PHOTO_DOWNLOAD = 40 * 1024 * 1024;
async function photoFrames(item) {
  let bmp = null;
  if (item.thumb) bmp = await fetchThumbnail(item.thumb);
  else if (item.size && item.size <= MAX_PHOTO_DOWNLOAD) {
    const blob = await (await driveFetch(mediaUrl(item.id))).blob();
    bmp = await createImageBitmap(blob, { resizeWidth: 640, resizeQuality: 'medium' }).catch(() => null);
  }
  return { frames: bmp ? [{ time: 0, bmp }] : [], duration: 0, level: FULL };
}

async function quickFrames(item, level) {
  const extra = level >= 2 ? extraKeyframes(item) : 0;
  const frames = [];
  // A throttled thumbnail throws, so the clip is retried on the next run instead of
  // falling back to downloading keyframes, which is far slower.
  if (item.thumb) frames.push({ time: 0, bmp: await fetchThumbnail(item.thumb) });
  const fractions = Array.from({ length: extra }, (_, i) => (i + 1) / (extra + 1));
  if (!frames.length) fractions.unshift(0, ...(fractions.length ? [] : [0.5]));
  if (fractions.length) {
    const sampled = await sampleFrames(item, fractions).catch(() => null);
    if (sampled) frames.push(...sampled.frames.filter((f) => !(f.time === 0 && frames[0]?.time === 0)));
  }
  return { frames, duration: item.duration, level: level >= 2 || !extraKeyframes(item) ? 2 : 1 };
}

async function fullFrames(item) {
  const strip = getStrip(item);
  await strip.done;
  if (strip.status !== 'ready') return { frames: [] };
  const frames = await Promise.all(strip.frames.map(async (f) => ({ time: f.time, bmp: await createImageBitmap(f.bmp) })));
  return { frames, duration: strip.duration, level: FULL };
}

async function catalogClip(item, level) {
  const { frames, duration, level: got } = isImage(item) ? await photoFrames(item)
    : level >= FULL ? await fullFrames(item) : await quickFrames(item, level);
  if (!frames.length) return null;
  const vectors = await embedImages(frames.map((f) => f.bmp));
  const shots = distinctShots(frames.map((f) => f.time), vectors);
  return {
    n: item.name, m: item.modifiedTime, z: item.size, d: round2(duration || item.duration || 0), ...(got < FULL && { q: got }),
    t: shots.map((s) => round2(s.time)), ...encodeVectors(shots.map((s) => s.v)),
  };
}

// Brings a clip's entry up to at least `level`. Resolves true when it wrote a new entry.
const inFlight = new Map(); // item.id -> Promise<boolean>
function ensureCatalogued(item, level = FULL) {
  if (!item.folderId || !validToken()) return Promise.resolve(false);
  let p = inFlight.get(item.id);
  if (p) return p;
  p = (async () => {
    const idx = await folderIndex(item.folderId);
    if (idx.readOnly || catalogLevel(idx, item) >= level) return false;
    const entry = await catalogClip(item, level);
    if (!entry) return false;
    addEntry(idx, item.id, entry);
    changed();
    return true;
  })().finally(() => inFlight.delete(item.id));
  inFlight.set(item.id, p);
  return p;
}

// Any clip whose hover filmstrip gets built is fully catalogued too, one at a time.
const autoQueue = [];
let autoBusy = false;
export function catalogWhenStripReady(item) {
  if (!item.folderId) return;
  autoQueue.push(item);
  pumpAuto();
}
async function pumpAuto() {
  if (autoBusy) return;
  autoBusy = true;
  while (autoQueue.length) {
    const item = autoQueue.shift();
    await ensureCatalogued(item, FULL).catch((err) => console.warn(`Cataloguing ${item.name} failed:`, err));
  }
  autoBusy = false;
}

let bulkRun = null;
export const isBulkRunning = () => !!bulkRun;
export function stopCataloguing() { if (bulkRun) bulkRun.stopped = true; }

// Phase 1 gives every clip a thumbnail entry, so the whole folder is searchable within
// minutes. Phase 2 then adds keyframes to the longer clips, which is slower because each
// keyframe is a separate trip to Drive.
export async function catalogFolder(folderId, recursive) {
  if (bulkRun) return;
  const run = (bulkRun = { stopped: false });
  changed();
  let done = 0, failed = 0;
  const attempt = async (item, level) => {
    if (run.stopped) return;
    try {
      if (!(await ensureCatalogued(item, level))) failed++;
    } catch (err) {
      console.warn(`Cataloguing ${item.name} failed:`, err);
      failed++;
    }
    done++;
  };
  try {
    say('Finding clips and photos…');
    // Walk the folder tree a level at a time, each level in parallel.
    const folders = [folderId];
    for (let level = [folderId]; recursive && level.length && !run.stopped; ) {
      level = (await Promise.all(level.map((id) => listFolders(`'${id}' in parents`)))).flat().map((f) => f.id);
      folders.push(...level);
    }
    const items = (await mapLimit(folders, 8, (id) => listMedia(`'${id}' in parents`))).flat().map(toItem);
    const indexes = new Map(await mapLimit([...new Set(items.map((i) => i.folderId))], 8, async (id) => [id, await folderIndex(id)]));
    const writable = items.filter((item) => !indexes.get(item.folderId).readOnly);
    for (const item of writable) { // entries from before the file size was stored
      const idx = indexes.get(item.folderId), entry = idx.clips.get(item.id);
      if (entry && entry.z == null && idx.mine.data.clips[item.id] === entry) { entry.z = item.size; idx.dirty = true; }
    }
    const levelOf = (item) => catalogLevel(indexes.get(item.folderId), item);

    const phase1 = writable.filter((item) => levelOf(item) < 1);
    const report1 = () => say(`Cataloguing ${done} of ${phase1.length}…`);
    report1();
    await mapLimit(phase1, BULK_PARALLEL, async (item) => { await attempt(item, 1); report1(); });
    await Promise.all([...indexes.values()].map(saveIndex));
    const searchable = done - failed;

    const phase2 = writable.filter((item) => !isImage(item) && extraKeyframes(item) > 0 && levelOf(item) < 2);
    done = 0;
    const report2 = () => say(`Searchable now. Adding detail to longer clips: ${done} of ${phase2.length}…`);
    if (phase2.length && !run.stopped) report2();
    await mapLimit(phase2, BULK_PARALLEL, async (item) => { await attempt(item, 2); report2(); });
    await Promise.all([...indexes.values()].map(saveIndex));

    const skipped = writable.length - phase1.length;
    say(run.stopped
      ? 'Stopped. Everything catalogued so far is saved and searchable.'
      : `Catalogued ${searchable} file${searchable === 1 ? '' : 's'}${skipped ? ` (${skipped} already done)` : ''}${failed ? `, ${failed} couldn’t be read (run it again later to retry)` : ''}.`);
  } catch (err) {
    say(`Cataloguing failed: ${err.message}`);
  } finally {
    bulkRun = null;
    changed();
  }
}

// ---------- search ----------

// Every catalogued clip the signed-in account can see, kept in memory for a couple of
// minutes so searching as you type needs no network requests.
let library = null;        // { at, entries: Map<id, { id, entry, folder }> }
let libraryLoading = null;
const scopes = new Map();  // ancestorId -> Promise<Set<folderId>>

export function loadLibrary({ refresh = false } = {}) {
  if (!refresh && library && Date.now() - library.at < LIBRARY_TTL) return Promise.resolve(library);
  libraryLoading ??= (async () => {
    const entries = new Map();
    for (const { data } of await readIndexes(await listIndexFiles())) {
      for (const [id, entry] of Object.entries(data.clips || {})) {
        if (!entries.has(id)) entries.set(id, { id, entry, folder: data.folder });
      }
    }
    library = { at: Date.now(), entries };
    scopes.clear();
    return library;
  })().finally(() => { libraryLoading = null; });
  return libraryLoading;
}

// The catalogued folders that sit inside `ancestorId`.
function foldersInside(lib, ancestorId) {
  let p = scopes.get(ancestorId);
  if (!p) {
    const folders = [...new Set([...lib.entries.values()].map((e) => e.folder))];
    p = mapLimit(folders, 8, (f) => isInside(f, ancestorId).catch(() => false))
      .then((inside) => new Set(folders.filter((_, i) => inside[i])));
    scopes.set(ancestorId, p);
  }
  return p;
}

async function scopedEntries(within) {
  const lib = await loadLibrary();
  const all = [...lib.entries.values()];
  if (!within) return all;
  const inside = await foldersInside(lib, within);
  return all.filter((e) => inside.has(e.folder));
}

// Catalogued clips whose file name contains the text anywhere (Drive's own name search
// only matches the start of words).
export async function searchNames(query, within) {
  const needle = query.toLowerCase();
  const entries = await scopedEntries(within);
  return { total: entries.length, hits: entries.filter((e) => e.entry.n?.toLowerCase().includes(needle)) };
}

// Clips whose frames look like the text, best first, each with the best matching moment.
export async function searchVisual(query, within) {
  const [q, entries] = await Promise.all([embedText(query), scopedEntries(within)]);
  const scored = entries.map((e) => {
    let score = -1, time = 0;
    decodeVectors(e.entry).forEach((v, i) => {
      const s = dot(v, q);
      if (s > score) { score = s; time = e.entry.t[i]; }
    });
    return { ...e, score, time };
  }).sort((a, b) => b.score - a.score);
  const top = scored[0]?.score ?? 0;
  return scored.filter((r) => r.score >= MATCH_FLOOR && r.score >= top - MATCH_WINDOW).slice(0, MAX_RESULTS);
}
