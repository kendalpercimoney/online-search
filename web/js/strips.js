// Hover filmstrips in memory. Each frame is a decoded image (about 0.5 MB), so only a
// budget's worth is kept; the least recently used strips are released and reload from
// browser storage in a fraction of a second when needed again.

import { loadFilmstrip } from './filmstrip.js';

const FRAME_BUDGET = 500; // about 250 MB of decoded frames

const strips = new Map();    // item.id -> { status, duration, total, frames, done, usedAt }
const listeners = new Map(); // item.id -> Set<fn>, registered by cards in the grid
const onScreen = new Set();  // item ids whose cards are on or near the screen
const readyHooks = new Set();

export const peekStrip = (id) => strips.get(id);
export const onStripReady = (fn) => readyHooks.add(fn);

export function watchStrip(id, fn) {
  if (!listeners.has(id)) listeners.set(id, new Set());
  listeners.get(id).add(fn);
  return () => {
    const set = listeners.get(id);
    set?.delete(fn);
    if (!set?.size) listeners.delete(id);
  };
}

export function getStrip(item) {
  let strip = strips.get(item.id);
  if (strip) {
    strip.usedAt = Date.now();
    return strip;
  }
  strip = { status: 'loading', duration: item.duration || 0, total: 0, frames: [], usedAt: Date.now() };
  strips.set(item.id, strip);
  const notify = () => listeners.get(item.id)?.forEach((fn) => fn());
  strip.done = loadFilmstrip(item, strip, notify).then(
    () => {
      strip.status = 'ready';
      notify();
      readyHooks.forEach((fn) => fn(item));
      trim();
    },
    (err) => {
      console.warn(`Filmstrip failed for ${item.name}:`, err);
      strip.status = 'failed';
      notify();
    },
  );
  return strip;
}

// Releases least recently used strips beyond the budget, but never one that is still
// loading or whose card is on screen (cards scrolled away reload theirs when hovered).
function trim() {
  let total = 0;
  for (const s of strips.values()) total += s.frames.length;
  if (total <= FRAME_BUDGET) return;
  const candidates = [...strips.entries()]
    .filter(([id, s]) => s.status !== 'loading' && !onScreen.has(id))
    .sort((a, b) => a[1].usedAt - b[1].usedAt);
  for (const [id, s] of candidates) {
    if (total <= FRAME_BUDGET) break;
    total -= s.frames.length;
    s.frames.forEach((f) => f.bmp.close());
    strips.delete(id);
  }
}

export function forgetAllStrips() {
  for (const [id, s] of strips) {
    if (s.status === 'loading') continue;
    s.frames.forEach((f) => f.bmp.close());
    strips.delete(id);
  }
}

export const stripStats = () => ({
  strips: strips.size,
  frames: [...strips.values()].reduce((n, s) => n + s.frames.length, 0),
  watched: listeners.size,
});

// Optionally builds strips for cards as they come into view, one clip at a time, so
// hovering is instant by the time the pointer gets there.
const queue = [];
let busy = false;
async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) await getStrip(queue.shift()).done;
  busy = false;
}
// Off by default, so browsing a folder downloads nothing until a clip is hovered (about
// 1 MB per clip from Drive's 360p copy, far more from originals). Settings can turn it on.
export const prepareInBackground = {
  get on() { return localStorage.getItem('os.prepareInBackground') === '1'; },
  set on(v) { localStorage.setItem('os.prepareInBackground', v ? '1' : '0'); },
};
const visibility = new IntersectionObserver((entries) => {
  if (!prepareInBackground.on) return;
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    visibility.unobserve(e.target);
    if (e.target._item) queue.push(e.target._item);
  }
  pump();
}, { rootMargin: '300px' });

// Tracks which cards are on or near the screen, for trim().
const screen = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const id = e.target._itemId;
    if (e.isIntersecting) onScreen.add(id);
    else onScreen.delete(id);
  }
}, { rootMargin: '600px' });

export function prepareWhenVisible(thumb) {
  thumb._itemId = thumb._item.id;
  visibility.observe(thumb);
  screen.observe(thumb);
}
export function forgetCard(thumb) {
  screen.unobserve(thumb);
  visibility.unobserve(thumb);
  onScreen.delete(thumb._itemId);
}
export function resetVisibilityQueue() {
  queue.length = 0;
  visibility.disconnect();
}
