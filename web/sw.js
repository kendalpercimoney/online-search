// Streams Google Drive files to the <video> player.
// A <video src> can't send an Authorization header, so the page points videos at
// /drive-media/<fileId>?size=<bytes> and this worker forwards the request (including
// Range, so seeking works without downloading the whole file) to the Drive API.
//
// Drive takes seconds to answer each request and a player makes several before showing
// anything, so the page fetches the byte ranges the player will need (the file's two ends,
// the first frame and the stretch where playback starts) in parallel and hands them over.
// It announces each range first, so a player request that arrives while the page is still
// downloading it waits for those bytes instead of starting a second, slower download.
// Requests that begin inside a range are answered from it, and anything past its end
// streams from Drive straight after.

const MAX_CACHED_FILES = 3;
const PENDING_WAIT = 20000;

let token = null;
// fileId -> { type, chunks: [{ start, bytes }], pending: [{ start, end, done, resolve }] }, most recent last
const ranges = new Map();

function entryFor(fileId, mime) {
  const entry = ranges.get(fileId) || { type: mime, chunks: [], pending: [] };
  entry.type ||= mime;
  ranges.delete(fileId);
  ranges.set(fileId, entry);
  while (ranges.size > MAX_CACHED_FILES) ranges.delete(ranges.keys().next().value);
  return entry;
}

function settle(entry, start) {
  entry.pending = entry.pending.filter((p) => {
    if (p.start !== start) return true;
    p.resolve();
    return false;
  });
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('message', (e) => {
  const m = e.data;
  if (m?.type === 'token') token = m.token;
  if (m?.type === 'expect-range') {
    const entry = entryFor(m.fileId, m.mime);
    let resolve;
    const done = new Promise((r) => { resolve = r; });
    entry.pending.push({ start: m.start, end: m.end, done, resolve });
    setTimeout(() => settle(entry, m.start), PENDING_WAIT);
  }
  if (m?.type === 'cache-range') {
    const entry = entryFor(m.fileId, m.mime);
    addChunk(entry.chunks, m.start, new Uint8Array(m.bytes));
    settle(entry, m.start);
  }
  if (m?.type === 'range-failed') {
    const entry = ranges.get(m.fileId);
    if (entry) settle(entry, m.start);
  }
});

// Joins touching or overlapping ranges, so a request can run through all of them.
function addChunk(chunks, start, bytes) {
  let merged = { start, bytes };
  for (let i = chunks.length - 1; i >= 0; i--) {
    const c = chunks[i], cEnd = c.start + c.bytes.length, mEnd = merged.start + merged.bytes.length;
    if (c.start > mEnd || merged.start > cEnd) continue;
    const from = Math.min(c.start, merged.start), to = Math.max(cEnd, mEnd);
    const out = new Uint8Array(to - from);
    out.set(c.bytes, c.start - from);
    out.set(merged.bytes, merged.start - from);
    merged = { start: from, bytes: out };
    chunks.splice(i, 1);
  }
  chunks.push(merged);
}

// The worker can be stopped and restarted at any time, losing `token`; ask a page for it.
async function askPageForToken() {
  const pages = await self.clients.matchAll({ type: 'window' });
  for (const page of pages) {
    const t = await new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => resolve(e.data?.token || null);
      page.postMessage({ type: 'get-token' }, [ch.port2]);
      setTimeout(() => resolve(null), 3000);
    });
    if (t) return t;
  }
  return null;
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  const m = url.pathname.match(/\/drive-media\/([\w-]+)$/);
  if (!m) return;
  e.respondWith(proxy(m[1], Number(url.searchParams.get('size')) || 0, e.request.headers.get('range')));
});

async function upstream(fileId, range) {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`;
  const send = () => fetch(url, { headers: { Authorization: `Bearer ${token}`, ...(range && { Range: range }) } });
  if (!token) token = await askPageForToken();
  let res = await send();
  if (res.status === 401) {
    token = await askPageForToken();
    res = await send();
  }
  return res;
}

function parseRange(header, size) {
  const m = header?.match(/bytes=(\d+)-(\d*)/);
  if (!m || !size) return null;
  return { start: Number(m[1]), end: m[2] ? Math.min(Number(m[2]), size - 1) : size - 1 };
}

async function proxy(fileId, size, rangeHeader) {
  const range = parseRange(rangeHeader, size);
  const entry = range && ranges.get(fileId);
  const findChunk = () => entry.chunks.find((c) => c.start <= range.start && range.start < c.start + c.bytes.length);
  const covered = entry && (findChunk() || entry.pending.some((p) => p.start <= range.start && range.start < p.end));
  if (covered) return fromCache(fileId, size, range, entry);

  const res = await upstream(fileId, rangeHeader);
  const headers = new Headers({ 'Accept-Ranges': 'bytes' });
  for (const k of ['content-type', 'content-length', 'content-range']) {
    const v = res.headers.get(k);
    if (v) headers.set(k, v);
  }
  // Content-Range may not be readable cross-origin; rebuild it from the request and known size.
  if (res.status === 206 && !headers.has('content-range') && range) {
    const len = Number(res.headers.get('content-length')) || size - range.start;
    headers.set('content-range', `bytes ${range.start}-${range.start + len - 1}/${size}`);
  }
  // A fresh Response (no upstream URL) counts as same-origin.
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// Serves the range from cached bytes (waiting for an announced download if the start of
// the range is on its way), and starts the Drive download for whatever follows at the same
// moment, so its delay overlaps with the cached part being played.
function fromCache(fileId, size, range, entry) {
  let pos = range.start;
  let rest = null, reader = null;
  const chunkAt = (p) => entry.chunks.find((c) => c.start <= p && p < c.start + c.bytes.length);
  const pendingAt = (p) => entry.pending.find((x) => x.start <= p && p < x.end);
  const startRest = (from) => { if (!rest && from <= range.end) rest = upstream(fileId, `bytes=${from}-${range.end}`); };
  const body = new ReadableStream({
    async pull(controller) {
      if (pos > range.end) return controller.close();
      if (!reader) {
        let chunk = chunkAt(pos);
        const waiting = !chunk && !rest && pendingAt(pos);
        if (waiting) {
          await waiting.done;
          chunk = chunkAt(pos);
        }
        if (chunk) {
          const end = Math.min(range.end, chunk.start + chunk.bytes.length - 1);
          if (!chunkAt(end + 1) && !pendingAt(end + 1)) startRest(end + 1);
          controller.enqueue(chunk.bytes.slice(pos - chunk.start, end - chunk.start + 1));
          pos = end + 1;
          return;
        }
        startRest(pos);
        const res = await rest;
        if (res.status !== 206) return controller.error(new Error(`Drive answered ${res.status}`));
        reader = res.body.getReader();
      }
      const { done, value } = await reader.read();
      if (done) return controller.close();
      pos += value.length;
      controller.enqueue(value);
    },
    cancel() {
      if (reader) reader.cancel().catch(() => {});
      else rest?.then((r) => r.body?.cancel()).catch(() => {});
    },
  });
  return new Response(body, {
    status: 206,
    headers: {
      'Content-Type': entry.type || 'video/mp4',
      'Content-Length': String(range.end - range.start + 1),
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      'Accept-Ranges': 'bytes',
    },
  });
}
