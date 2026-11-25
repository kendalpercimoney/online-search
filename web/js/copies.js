// Drive's smaller copies of each video (360p, 720p, 1080p), reached through the Mac app's
// local proxy (desktop/copies.js). Hover previews are built from the 360p copy and the
// player streams whichever copy suits the connection. In a browser, or for a clip Drive
// hasn't processed yet, there are none and the original file is used.

import { desktop } from './auth.js';
import { LRU } from './util.js';

const base = desktop?.copyBase || null;
const lookups = new LRU(500);

const short = (s) => Math.min(s.width, s.height); // 360, 720, 1080 whatever the orientation

// -> { streams: [{ itag, width, height, label }] smallest first, mbps }
export function driveCopies(item) {
  if (!base) return Promise.resolve({ streams: [], mbps: null });
  let p = lookups.get(item.id);
  if (!p) {
    p = fetch(`${base}copies/${item.id}`)
      .then((r) => r.json())
      .then((d) => ({ ...d, streams: (d.streams || []).map((s) => ({ ...s, label: `${short(s)}p` })) }))
      .catch(() => ({ streams: [], mbps: null }));
    lookups.set(item.id, p);
    p.then((d) => { if (!d.streams.length) setTimeout(() => lookups.delete(item.id), 60_000); });
  }
  return p;
}

// The connection speed measured from recent copy downloads (Mbit/s), or null.
export const currentSpeed = () => (base
  ? fetch(`${base}speed`).then((r) => r.json()).then((d) => d.mbps).catch(() => null)
  : Promise.resolve(null));

export const copyUrl = (item, stream) => `${base}copy/${item.id}/${stream.itag}`;

// Drive thumbnails of files in someone's own My Drive can't be read by the page directly,
// so the Mac app fetches them; in a browser this is the thumbnail address itself.
export const readableThumb = (url) => (base ? `${base}thumb?u=${encodeURIComponent(url)}` : url);

// A filmstrip source for one copy. Copies keep their index at the start of the file.
export function copySource(item, stream) {
  const url = copyUrl(item, stream);
  return {
    id: `${item.id}@${stream.itag}`,
    cacheKey: item.cacheKey,
    copy: true,
    async read(offset, length) {
      const r = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
      if (!r.ok) throw new Error(`Copy read failed (${r.status})`);
      return new Uint8Array(await r.arrayBuffer());
    },
  };
}

// The smallest copy at least 300 pixels on its short side: plenty for hover frames.
export async function previewSource(item) {
  const { streams } = await driveCopies(item);
  const s = streams.find((x) => short(x) >= 300) || streams.at(-1);
  return s ? copySource(item, s) : item;
}

// Rough bitrates of Drive's copies, in Mbit/s, for choosing one to play.
const NEED = { 360: 0.8, 480: 1.4, 720: 2.5, 1080: 5 };
export function autoStream(streams, mbps) {
  if (!streams.length) return null;
  if (mbps == null) return streams.find((s) => short(s) >= 720) || streams.at(-1);
  const fits = streams.filter((s) => (NEED[short(s)] ?? 5) * 1.6 <= mbps);
  return fits.at(-1) || streams[0];
}
