// Talks to the MobileCLIP worker (catalog-worker.js), which turns images and text into
// embeddings: 512 numbers whose dot product says how well two things match.

import { LRU } from './util.js';

export const EMBED_MODEL = 'mobileclip_s0';
export const EMBED_DIM = 512;

export const modelEvents = new EventTarget(); // 'progress' (detail: text, '' when done)

let worker, seq = 0, loadStart = null;
const calls = new Map();
const modelFiles = {};
const textCache = new LRU(200);

function call(op, payload, transfer = []) {
  if (!worker) {
    worker = new Worker(`catalog-worker.js?model=${EMBED_MODEL}`, { type: 'module' });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') return reportProgress(m);
      const pending = calls.get(m.id);
      calls.delete(m.id);
      if (m.error) pending.reject(new Error(m.error));
      else pending.resolve(m.vectors);
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++seq;
    calls.set(id, { resolve, reject });
    worker.postMessage({ id, op, ...payload }, transfer);
  });
}

function reportProgress(m) {
  modelFiles[m.file] = m;
  loadStart ??= Date.now();
  if (Date.now() - loadStart < 1500) return; // reading from the browser cache is quicker than this
  const files = Object.values(modelFiles);
  const loaded = files.reduce((s, f) => s + f.loaded, 0), total = files.reduce((s, f) => s + f.total, 0);
  const text = loaded < total ? `Downloading the search model: ${Math.round(loaded / 1e6)} of ${Math.round(total / 1e6)} MB` : '';
  modelEvents.dispatchEvent(new CustomEvent('progress', { detail: text }));
}

// ImageBitmaps are handed over to the worker, which closes them.
export const embedImages = (bitmaps) => call('images', { bitmaps }, bitmaps);

export function embedText(text) {
  let pending = textCache.get(text);
  if (!pending) {
    pending = call('text', { texts: [`a photo of ${text}`] }).then(([v]) => v);
    pending.catch(() => textCache.delete(text));
    textCache.set(text, pending);
  }
  return pending;
}

// Loads the text model ahead of the first search, e.g. when the search box gets focus.
export const warmTextModel = () => embedText('a').catch(() => {});

export const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};
