// Clip cards with hover-scrub. Cards are reused between renders when the same clip is
// still shown (so search results can update while typing without flicker), and each card
// releases everything it holds when it leaves the grid.

import { canDownload, download } from './downloads.js';
import { isImage } from './drive.js';
import { openPhoto, openPlayer } from './player.js';
import { forgetCard, getStrip, peekStrip, prepareWhenVisible, resetVisibilityQueue, watchStrip } from './strips.js';
import { ICONS, el, timecode } from './util.js';

const shown = new Map(); // render key -> card

const renderKey = (item) => `${item.id}|${item.matchTime ?? ''}|${item.sub}`;

export function renderCards(container, items) {
  resetVisibilityQueue();
  const previous = new Map(shown);
  shown.clear();
  const nodes = items.map((item) => {
    const key = renderKey(item);
    const card = previous.get(key) || makeCard(item);
    previous.delete(key);
    shown.set(key, card);
    if (!isImage(item)) prepareWhenVisible(card.thumb);
    return card.node;
  });
  for (const card of previous.values()) card.dispose();
  container.replaceChildren(...nodes);
}

function cardMeta(item) {
  const name = el('div', { className: 'name', textContent: item.name, title: item.name });
  const sub = el('div', { className: 'sub', textContent: item.sub || '' });
  const meta = el('div', { className: 'meta' }, el('div', { className: 'meta-text' }, name, sub));
  if (canDownload(item)) {
    meta.append(el('button', {
      className: 'icon-btn round dl', title: 'Download', 'aria-label': `Download ${item.name}`, html: ICONS.download,
      onclick: () => download(item),
    }));
  }
  return meta;
}

// The photos currently in the grid, in order, for stepping through them in the viewer.
const shownPhotos = () => [...shown.values()].map((c) => c.item).filter(isImage);

function makePhotoCard(item) {
  const thumb = el('div', { className: 'thumb photo' });
  let img = null;
  const fallback = () => {
    if (!thumb.querySelector('.msg')) thumb.append(el('div', { className: 'msg', html: ICONS.image || '', title: 'No preview' }));
  };
  if (item.thumb) {
    img = el('img', { alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', src: item.thumb });
    img.onerror = () => { img.remove(); img = null; fallback(); };
    thumb.append(img);
  } else fallback();
  thumb.append(el('div', { className: 'tc kind', title: 'Photo', html: ICONS.image }));
  thumb.addEventListener('click', () => openPhoto(item, shownPhotos()));
  const node = el('article', { className: 'card' }, thumb, cardMeta(item));
  return {
    node, thumb, item,
    dispose() { if (img) img.src = ''; },
  };
}

function makeCard(item) {
  if (isImage(item)) return makePhotoCard(item);
  const thumb = el('div', { className: 'thumb' });
  thumb._item = item;
  let img = null;
  if (item.thumb) {
    img = el('img', { alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', src: item.thumb });
    img.onerror = () => { img.remove(); img = null; update(); };
    thumb.append(img);
  }
  const playhead = el('div', { className: 'playhead' });
  const progress = el('div', { className: 'progress' });
  const tc = el('div', { className: 'tc', textContent: timecode(item.duration) });
  const play = el('div', { className: 'play-badge', html: ICONS.play });
  thumb.append(playhead, progress, play, tc);
  if (item.matchTime != null && item.duration) {
    thumb.append(el('div', { className: 'match', title: 'Best match', style: `left:${(item.matchTime / item.duration) * 100}%` }));
  }

  const node = el('article', { className: 'card' }, thumb, cardMeta(item));

  // ---- hover scrub ----
  let canvas = null, ctx = null, fraction = 0, hovering = false;
  let video = null, seeking = false, pending = null;
  const strip = () => peekStrip(item.id);
  const duration = () => strip()?.duration || item.duration || 0;
  // Search results show their matching moment; clips without a Drive thumbnail use an early frame.
  const wantsPoster = () => item.matchTime != null || !img;

  function draw(source) {
    if (!canvas) {
      canvas = el('canvas');
      ctx = canvas.getContext('2d');
      thumb.insertBefore(canvas, playhead);
    }
    const w = Math.round(thumb.clientWidth * devicePixelRatio), h = Math.round(thumb.clientHeight * devicePixelRatio);
    if (!w || !h) return;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const sw = source.videoWidth || source.width, sh = source.videoHeight || source.height;
    const scale = Math.max(w / sw, h / sh); // fill the card like the thumbnail does
    ctx.drawImage(source, (w - sw * scale) / 2, (h - sh * scale) / 2, sw * scale, sh * scale);
    thumb.classList.add('has-frame');
  }

  function releaseCanvas() {
    if (!canvas) return;
    canvas.width = canvas.height = 0; // frees the backing memory straight away
    canvas.remove();
    canvas = ctx = null;
    thumb.classList.remove('has-frame');
  }

  function nearestFrame(t) {
    let best = null;
    for (const f of strip()?.frames || []) if (!best || Math.abs(f.time - t) < Math.abs(best.time - t)) best = f;
    return best;
  }

  function update() {
    const s = strip();
    const total = duration();
    progress.style.width = s?.status === 'loading' && s.total ? `${(s.frames.length / s.total) * 100}%` : '0';
    if (!hovering) {
      const poster = wantsPoster() && s?.frames.length && nearestFrame(item.matchTime ?? total * 0.1);
      if (poster) draw(poster.bmp);
      return;
    }
    const t = fraction * total;
    playhead.style.left = `${fraction * 100}%`;
    tc.textContent = `${timecode(t)} / ${timecode(total)}`;
    if (s?.status === 'failed') return seekVideo(t);
    const frame = nearestFrame(t);
    if (frame) draw(frame.bmp);
  }

  // Fallback for files the filmstrip can't read (non-MP4 containers, unusual codecs).
  function seekVideo(t) {
    if (!video) {
      video = el('video', { muted: true, preload: 'auto', src: item.src });
      video.addEventListener('loadedmetadata', () => { seeking = false; seekVideo(pending ?? t); });
      video.addEventListener('seeked', () => { seeking = false; draw(video); if (pending != null) seekVideo(pending); });
      video.addEventListener('error', () => {
        if (!thumb.querySelector('.msg')) thumb.append(el('div', { className: 'msg', textContent: 'This format can’t be previewed here (for example ProRes).' }));
      });
      thumb.append(video);
    }
    pending = t;
    if (seeking || video.readyState < 1) return;
    seeking = true;
    pending = null;
    video.currentTime = t;
  }

  function stopVideo() {
    if (!video) return;
    video.removeAttribute('src');
    video.load();
    video.remove();
    video = null;
    seeking = false;
    pending = null;
  }

  const unwatch = watchStrip(item.id, update);
  thumb.addEventListener('pointerenter', () => {
    hovering = true;
    thumb.classList.add('scrubbing');
    getStrip(item);
    update();
  });
  thumb.addEventListener('pointermove', (e) => {
    const r = thumb.getBoundingClientRect();
    fraction = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    update();
  });
  thumb.addEventListener('pointerleave', () => {
    hovering = false;
    thumb.classList.remove('scrubbing');
    tc.textContent = timecode(duration());
    stopVideo();
    if (wantsPoster()) update();
    else releaseCanvas();
  });
  thumb.addEventListener('click', () => openPlayer(item, fraction * duration()));
  update();

  return {
    node,
    thumb,
    item,
    dispose() {
      unwatch();
      forgetCard(thumb);
      stopVideo();
      releaseCanvas();
      thumb._item = null;
      if (img) img.src = '';
    },
  };
}
