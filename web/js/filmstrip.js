// Builds hover-scrub filmstrips by reading only an MP4/MOV's index (moov box) and a spread
// of its keyframes, then decoding those with WebCodecs. Each Google Drive range request
// takes seconds, so this needs a handful of parallel requests where a <video> element
// seeking around would need dozens of sequential ones.
//
// In the Mac app, frames come from Drive's 360p copy of the clip instead (copies.js),
// which is often a hundred times smaller than the camera original: there, each frame is
// decoded from the run of frames leading up to it, so any moment can be shown.
//
// A `source` is { id, cacheKey, size, read(offset, length) -> Promise<Uint8Array> },
// plus `copy: true` for a Drive copy (index at the start, size not needed).

import { previewSource } from './copies.js';
import { idbGet, saveStrip, touchStrip } from './idb.js';
import { LRU, sleep } from './util.js';

// Filmstrip and catalogue downloads step aside while something more important uses the
// connection (the player, or a download). Each caller of pauseBackground() resumes it.
let pauses = 0;
export function pauseBackground() {
  pauses++;
  let resumed = false;
  return () => { if (!resumed) { resumed = true; pauses--; } };
}
async function waitForTurn() {
  while (pauses > 0) await sleep(400);
}

const MAX_FRAMES = 60;
const MIN_FRAMES = 12;
const STRIP_WIDTH = 320;
const PARALLEL_READS = 6;
const COPY_PARALLEL = 3;

const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

function boxes(buf, start = 0, end = buf.length) {
  const out = [];
  const d = view(buf);
  while (start + 8 <= end) {
    let len = d.getUint32(start), hdr = 8;
    if (len === 1) { len = Number(d.getBigUint64(start + 8)); hdr = 16; }
    else if (len === 0) len = end - start;
    if (len < hdr) break;
    out.push({ type: fourcc(buf, start + 4), s: start + hdr, e: Math.min(end, start + len) });
    start += len;
  }
  return out;
}
const child = (buf, box, type) => boxes(buf, box.s, box.e).find((b) => b.type === type);

// Camera files usually put the index at the end, so read both ends at once. The two ends
// are returned too: the player hands them to the service worker so playback can start
// without fetching them again.
// The two windows read: the start of the file (256 KB is enough to find the index; the
// player asks for more so the first frame comes too), and the last ~1 MB aligned to 32 KB
// (the block size the player requests in, so it can reuse these bytes).
export function endWindows(size, headBytes = 256 * 1024) {
  const headLen = Math.min(size, headBytes);
  return { headLen, tailStart: Math.max(headLen, Math.floor((size - 1024 * 1024) / 32768) * 32768) };
}

async function readMoov(read, size, headBytes) {
  const { headLen, tailStart } = endWindows(size, headBytes);
  const [head, tail] = await Promise.all([read(0, headLen), tailStart < size ? read(tailStart, size - tailStart) : null]);
  const bytes = (off, len) => {
    if (off + len <= headLen) return head.subarray(off, off + len);
    if (tail && off >= tailStart && off + len <= size) return tail.subarray(off - tailStart, off - tailStart + len);
    return read(off, len);
  };
  let off = 0;
  while (off + 8 <= size) {
    const h = await bytes(off, Math.min(16, size - off));
    let len = view(h).getUint32(0);
    if (len === 1) len = Number(view(h).getBigUint64(8));
    else if (len === 0) len = size - off;
    if (fourcc(h, 4) === 'moov') return { moov: await bytes(off, len), head, tail, tailStart };
    if (len < 8) break;
    off += len;
  }
  throw new Error('Not an MP4/MOV file (no index found)');
}

// Drive's copies put the index first, so one read from the start usually covers it.
async function readCopyMoov(read) {
  const head = await read(0, 256 * 1024);
  let off = 0;
  while (off + 8 <= head.length) {
    let len = view(head).getUint32(off);
    if (len === 1) len = Number(view(head).getBigUint64(off + 8));
    if (fourcc(head, off + 4) === 'moov') return off + len <= head.length ? head.subarray(off, off + len) : read(off, len);
    if (len < 8) break;
    off += len;
  }
  throw new Error('No index at the start of the copy');
}

function avcCodec(desc) {
  return 'avc1.' + [1, 2, 3].map((i) => desc[i].toString(16).padStart(2, '0')).join('');
}

function hevcCodec(type, desc) {
  const space = desc[1] >> 6, tier = (desc[1] >> 5) & 1, profile = desc[1] & 31;
  let compat = view(desc).getUint32(2), reversed = 0;
  for (let i = 0; i < 32; i++) { reversed = (reversed << 1) | (compat & 1); compat >>>= 1; }
  const constraints = [...desc.slice(6, 12)];
  while (constraints.length && !constraints.at(-1)) constraints.pop();
  return [type, ['', 'A', 'B', 'C'][space] + profile, (reversed >>> 0).toString(16),
    (tier ? 'H' : 'L') + desc[12], ...constraints.map((c) => c.toString(16))].join('.');
}

function parseVideoTrack(buf) {
  const d = view(buf);
  const moov = boxes(buf)[0];
  for (const trak of boxes(buf, moov.s, moov.e).filter((b) => b.type === 'trak')) {
    const mdia = child(buf, trak, 'mdia');
    const hdlr = mdia && child(buf, mdia, 'hdlr');
    if (!hdlr || fourcc(buf, hdlr.s + 8) !== 'vide') continue;
    const mdhd = child(buf, mdia, 'mdhd');
    const timescale = d.getUint32(mdhd.s + (buf[mdhd.s] === 1 ? 20 : 12));
    const stbl = child(buf, child(buf, mdia, 'minf'), 'stbl');
    const get = (t) => child(buf, stbl, t);

    const stsd = get('stsd');
    const entry = boxes(buf, stsd.s + 8, stsd.e)[0];
    const cfg = boxes(buf, entry.s + 78, entry.e).find((b) => b.type === 'avcC' || b.type === 'hvcC');
    if (!cfg) throw new Error(`Unsupported codec "${entry.type}"`);
    const description = buf.slice(cfg.s, cfg.e);
    const codec = cfg.type === 'avcC' ? avcCodec(description) : hevcCodec(entry.type, description);

    const stsz = get('stsz');
    const fixedSize = d.getUint32(stsz.s + 4), count = d.getUint32(stsz.s + 8);
    const sizes = new Uint32Array(count);
    for (let i = 0; i < count; i++) sizes[i] = fixedSize || d.getUint32(stsz.s + 12 + i * 4);

    const stts = get('stts');
    const times = new Float64Array(count);
    let n = 0, t = 0;
    for (let i = 0, c = d.getUint32(stts.s + 4); i < c; i++) {
      const samples = d.getUint32(stts.s + 8 + i * 8), delta = d.getUint32(stts.s + 12 + i * 8);
      for (let j = 0; j < samples && n < count; j++) { times[n++] = t / timescale; t += delta; }
    }

    const co = get('stco') || get('co64');
    const is64 = co.type === 'co64', chunks = d.getUint32(co.s + 4);
    const chunkOffset = (k) => (is64 ? Number(d.getBigUint64(co.s + 8 + k * 8)) : d.getUint32(co.s + 8 + k * 4));
    const stsc = get('stsc'), runs = d.getUint32(stsc.s + 4);
    const offsets = new Float64Array(count);
    n = 0;
    for (let i = 0; i < runs; i++) {
      const first = d.getUint32(stsc.s + 8 + i * 12) - 1, perChunk = d.getUint32(stsc.s + 12 + i * 12);
      const last = i + 1 < runs ? d.getUint32(stsc.s + 8 + (i + 1) * 12) - 1 : chunks;
      for (let k = first; k < last; k++) {
        let o = chunkOffset(k);
        for (let j = 0; j < perChunk && n < count; j++) { offsets[n] = o; o += sizes[n]; n++; }
      }
    }

    // Presentation times: decode time plus the composition offset (for B-frames).
    const pts = Float64Array.from(times);
    const ctts = get('ctts');
    if (ctts) {
      const signed = buf[ctts.s] === 1;
      n = 0;
      for (let i = 0, c = d.getUint32(ctts.s + 4); i < c; i++) {
        const samples = d.getUint32(ctts.s + 8 + i * 8);
        const off = signed ? d.getInt32(ctts.s + 12 + i * 8) : d.getUint32(ctts.s + 12 + i * 8);
        for (let j = 0; j < samples && n < count; j++) pts[n++] += off / timescale;
      }
    }

    const stss = get('stss');
    const keyIdx = stss
      ? Array.from({ length: d.getUint32(stss.s + 4) }, (_, i) => d.getUint32(stss.s + 8 + i * 4) - 1)
      : [...Array(count).keys()];
    const keys = keyIdx.filter((k) => k < count).map((k) => ({ time: times[k], offset: offsets[k], size: sizes[k] }));
    return { codec, description, keys, duration: t / timescale, samples: { times, pts, offsets, sizes }, keyIdx: keyIdx.filter((k) => k < count) };
  }
  throw new Error('No video track');
}

export function nearestKeyframe(keys, target) {
  let lo = 0, hi = keys.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (keys[mid].time <= target) lo = mid; else hi = mid - 1; }
  return lo + 1 < keys.length && keys[lo + 1].time - target < target - keys[lo].time ? keys[lo + 1] : keys[lo];
}

// Evenly spaced keyframes across the clip, one per second up to MAX_FRAMES.
function pickKeyframes(keys, duration) {
  const want = Math.min(MAX_FRAMES, Math.max(MIN_FRAMES, Math.ceil(duration)));
  return [...new Set(Array.from({ length: want }, (_, i) => nearestKeyframe(keys, ((i + 0.5) / want) * duration)))];
}

// 0, n/2, n/4, 3n/4, ... so the strip covers the whole clip early and fills in detail after.
function coverageOrder(n) {
  const out = [], seen = new Set();
  for (let step = 2 ** Math.ceil(Math.log2(Math.max(1, n))); step >= 1; step /= 2) {
    for (let i = 0; i < n; i += step) if (!seen.has(i)) { seen.add(i); out.push(i); }
  }
  return out;
}

// Parsed indexes for recent clips (small), plus the raw file ends for the last few
// (up to 1.3 MB each), which only the player needs.
const tracks = new LRU(200);
const fileEnds = new LRU(4);

export async function readTrack(source, { headBytes } = {}) {
  let pending = tracks.get(source.id);
  if (!pending) {
    pending = (async () => {
      if (!('VideoDecoder' in window)) throw new Error('This browser has no WebCodecs support');
      let moov;
      if (source.copy) moov = await readCopyMoov(source.read);
      else {
        const ends = await readMoov(source.read, source.size, headBytes);
        fileEnds.set(source.id, { head: ends.head, tail: ends.tail, tailStart: ends.tailStart });
        moov = ends.moov;
      }
      const track = parseVideoTrack(moov);
      const config = { codec: track.codec, description: track.description };
      if (!(await VideoDecoder.isConfigSupported(config)).supported) throw new Error(`Browser can't decode ${track.codec}`);
      return track;
    })();
    pending.catch(() => tracks.delete(source.id));
    tracks.set(source.id, pending);
  }
  return pending;
}

export const cachedFileEnds = (id) => fileEnds.get(id);

const frameCount = (duration) => Math.min(MAX_FRAMES, Math.max(MIN_FRAMES, Math.ceil(duration)));

async function buildFilmstrip(source, strip, notify) {
  const track = await readTrack(source);
  const onFrame = (frame) => {
    strip.frames.push(frame);
    strip.frames.sort((a, b) => a.time - b.time);
    notify();
  };
  strip.duration = track.duration;
  if (source.copy) {
    const want = frameCount(track.duration);
    const targets = Array.from({ length: want }, (_, i) => ((i + 0.5) / want) * track.duration);
    strip.total = want;
    notify();
    await decodeAtTimes(source.read, track, targets, onFrame);
  } else {
    const picks = pickKeyframes(track.keys, track.duration);
    strip.total = picks.length;
    notify();
    await decodeKeyframes(source.read, track, picks, onFrame);
  }
  if (!strip.frames.length) throw new Error(`Couldn't decode any frames (${track.codec})`);
}

// A few frames at chosen points (fractions of the clip's length), for quick cataloguing.
export async function sampleFrames(item, fractions) {
  const source = await previewSource(item);
  const track = await readTrack(source);
  const frames = [];
  if (source.copy) {
    await decodeAtTimes(source.read, track, fractions.map((f) => f * track.duration), (frame) => frames.push(frame));
  } else {
    const picks = [...new Set(fractions.map((f) => nearestKeyframe(track.keys, f * track.duration)))];
    await decodeKeyframes(source.read, track, picks, (frame) => frames.push(frame));
  }
  return { frames: frames.sort((a, b) => a.time - b.time), duration: track.duration };
}

const toBitmap = (frame) => createImageBitmap(frame, {
  resizeWidth: STRIP_WIDTH,
  resizeHeight: Math.round((frame.displayHeight * STRIP_WIDTH) / frame.displayWidth),
});

// Frames at exact times, for Drive copies (keyframes there are seconds apart). Targets
// sharing a keyframe form one group: one read from that keyframe to the last frame
// needed, decoded in order, keeping the first frame shown at or after each target.
async function decodeAtTimes(read, track, targets, onFrame) {
  const { times, pts, offsets, sizes } = track.samples;
  const keys = track.keyIdx;
  const lastAtOrBefore = (arr, t) => {
    let lo = 0, hi = arr.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (arr[mid] <= t) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const keyTimes = keys.map((k) => times[k]);
  const groups = new Map(); // key position -> { from, to, targets }
  for (const target of [...new Set(targets)].sort((a, b) => a - b)) {
    const g = lastAtOrBefore(keyTimes, target);
    const from = keys[g], end = g + 1 < keys.length ? keys[g + 1] : times.length;
    // a few frames past the target in decode order, so B-frames before it come out
    const to = Math.min(end - 1, lastAtOrBefore(times, target) + 4);
    const group = groups.get(g) || { from, to, targets: [] };
    group.to = Math.max(group.to, to);
    group.targets.push(target);
    groups.set(g, group);
  }
  const list = [...groups.values()];
  const order = coverageOrder(list.length).map((i) => list[i]);

  const config = { codec: track.codec, description: track.description };
  let pending = [], last = null, shots = [];
  const decoder = new VideoDecoder({
    output: (frame) => {
      const t = frame.timestamp / 1e6;
      const due = [];
      while (pending.length && pending[0] <= t + 0.001) due.push(pending.shift());
      if (due.length) {
        // several targets on one frame (very short clips) share it as a single frame
        shots.push(toBitmap(frame).then((bmp) => onFrame({ time: due[0], bmp })).catch(() => {}).finally(() => frame.close()));
        last?.close();
        last = null;
      } else {
        last?.close();
        last = frame;
      }
    },
    error: () => {},
  });
  decoder.configure(config);

  let chain = Promise.resolve();
  const decodeGroup = (group, data, base) => (chain = chain.then(async () => {
    pending = [...group.targets];
    for (let i = group.from; i <= group.to; i++) {
      decoder.decode(new EncodedVideoChunk({
        type: i === group.from ? 'key' : 'delta',
        timestamp: Math.round(pts[i] * 1e6),
        data: data.subarray(offsets[i] - base, offsets[i] - base + sizes[i]),
      }));
    }
    await decoder.flush();
    await Promise.all(shots);
    shots = [];
    if (pending.length && last) { // targets past the last decoded frame get that frame
      onFrame({ time: pending[0], bmp: await toBitmap(last) });
    }
    last?.close();
    last = null;
    pending = [];
  }).catch(() => {}));

  let next = 0;
  await Promise.all(Array.from({ length: COPY_PARALLEL }, async () => {
    while (next < order.length) {
      const group = order[next++];
      await waitForTurn();
      const base = offsets[group.from];
      const data = await read(base, offsets[group.to] + sizes[group.to] - base).catch(() => null);
      if (data) await decodeGroup(group, data, base);
    }
  }));
  await chain;
  if (decoder.state !== 'closed') decoder.close();
}

// Fetches keyframes in parallel (best spread first) and decodes them one at a time,
// calling onFrame({ time, bmp }) for each.
async function decodeKeyframes(read, track, picks, onFrame) {
  const config = { codec: track.codec, description: track.description };
  let decoded = null;
  const decoder = new VideoDecoder({ output: (f) => { decoded?.close(); decoded = f; }, error: () => {} });
  decoder.configure(config);
  let chain = Promise.resolve();
  const decode = (pick, data) => (chain = chain.then(async () => {
    decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: Math.round(pick.time * 1e6), data }));
    await decoder.flush();
    const frame = decoded;
    decoded = null;
    if (!frame) return;
    const bmp = await toBitmap(frame);
    frame.close();
    onFrame({ time: pick.time, bmp });
  }).catch(() => {}));

  const order = coverageOrder(picks.length).map((i) => picks[i]);
  let next = 0;
  await Promise.all(Array.from({ length: PARALLEL_READS }, async () => {
    while (next < order.length) {
      const pick = order[next++];
      await waitForTurn();
      const data = await read(pick.offset, pick.size).catch(() => null);
      if (data) await decode(pick, data);
    }
  }));
  await chain;
  if (decoder.state !== 'closed') decoder.close();
}

// ---------- saved in the browser, so revisiting a folder is instant ----------

async function toJpeg(bmp) {
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  c.getContext('2d').drawImage(bmp, 0, 0);
  return c.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
}

export async function loadFilmstrip(source, strip, notify) {
  const cached = await idbGet('strips', source.cacheKey);
  if (cached) {
    touchStrip(source.cacheKey);
    strip.duration = cached.duration;
    strip.total = cached.frames.length;
    strip.frames = await Promise.all(cached.frames.map(async (f) => ({ time: f.time, bmp: await createImageBitmap(f.blob) })));
    notify();
    return;
  }
  await buildFilmstrip(await previewSource(source), strip, notify);
  const frames = await Promise.all(strip.frames.map(async (f) => ({ time: f.time, blob: await toJpeg(f.bmp) })));
  saveStrip(source.cacheKey, { duration: strip.duration, frames }, frames.reduce((n, f) => n + f.blob.size, 0));
}
