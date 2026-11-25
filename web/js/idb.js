// Browser storage (IndexedDB). Stores:
//   strips      hover filmstrips as small JPEGs, so revisiting a folder scrubs instantly
//   stripTimes  when each filmstrip was last used and its size ({ t, bytes }; older
//               entries are a bare time), so old ones can be found without loading them
//   indexes     cached copies of the search catalogue files from Drive
// The database name dates from the project's working title; keeping it keeps saved data.

const DB_NAME = 'footage-scrub';
const MAX_SAVED_STRIPS = 1500; // 0.2 to 1.2 MB each
const OLD_STRIP_BYTES = 1_000_000; // size assumed for entries saved before sizes were kept
const stampTime = (v) => (typeof v === 'number' ? v : v?.t || 0);
const stampBytes = (v) => (typeof v === 'number' ? OLD_STRIP_BYTES : v?.bytes || OLD_STRIP_BYTES);

let dbPromise;
function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 3);
    req.onupgradeneeded = () => {
      for (const name of ['strips', 'stripTimes', 'indexes']) {
        if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function idbStore(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    const req = fn(Array.isArray(stores) ? stores.map((s) => tx.objectStore(s)) : tx.objectStore(stores));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}

export const idbGet = (store, key) => idbStore(store, 'readonly', (s) => s.get(key)).catch(() => null);
export const idbPut = (store, key, value) => idbStore(store, 'readwrite', (s) => s.put(value, key)).catch(() => {});

export async function saveStrip(key, value, bytes) {
  await idbStore(['strips', 'stripTimes'], 'readwrite', ([strips, times]) => {
    strips.put(value, key);
    return times.put({ t: Date.now(), bytes }, key);
  }).catch(() => {});
  if (Math.random() < 0.05) pruneStrips(); // occasional check is plenty
}

export async function clearStrips() {
  await idbStore(['strips', 'stripTimes'], 'readwrite', ([strips, times]) => { strips.clear(); return times.clear(); }).catch(() => {});
}

// Marks a saved filmstrip as used (at most once a day per entry, to keep writes rare).
export async function touchStrip(key) {
  const v = await idbGet('stripTimes', key);
  if (v != null && Date.now() - stampTime(v) < 86_400_000) return;
  idbPut('stripTimes', key, { t: Date.now(), bytes: stampBytes(v) });
}

async function allStamps() {
  const [keys, values] = await Promise.all([
    idbStore('stripTimes', 'readonly', (s) => s.getAllKeys()),
    idbStore('stripTimes', 'readonly', (s) => s.getAll()),
  ]).catch(() => [[], []]);
  return keys.map((k, i) => ({ key: k, t: stampTime(values[i]), bytes: stampBytes(values[i]) }));
}

// { count, bytes } for all saved filmstrips, and for those unused since `olderThan` (ms ago).
export async function stripCacheStats(olderThan = Infinity) {
  const all = await allStamps();
  const cutoff = Date.now() - olderThan;
  const sum = (list) => ({ count: list.length, bytes: list.reduce((n, x) => n + x.bytes, 0) });
  return { all: sum(all), old: sum(all.filter((x) => x.t < cutoff)) };
}

export async function clearOldStrips(olderThan) {
  const cutoff = Date.now() - olderThan;
  const drop = (await allStamps()).filter((x) => x.t < cutoff).map((x) => x.key);
  await idbStore(['strips', 'stripTimes'], 'readwrite', ([strips, stamps]) => {
    for (const k of drop) { strips.delete(k); stamps.delete(k); }
    return null;
  }).catch(() => {});
  return drop;
}

// Keeps the filmstrip cache bounded by dropping the least recently used entries.
async function pruneStrips() {
  const all = await allStamps();
  if (all.length <= MAX_SAVED_STRIPS) return;
  const drop = all.sort((a, b) => a.t - b.t).slice(0, all.length - MAX_SAVED_STRIPS + 100).map((x) => x.key);
  await idbStore(['strips', 'stripTimes'], 'readwrite', ([strips, stamps]) => {
    for (const k of drop) { strips.delete(k); stamps.delete(k); }
    return null;
  }).catch(() => {});
}
