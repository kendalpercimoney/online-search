// Runs MobileCLIP off the main thread. Turns filmstrip frames and search text into
// embeddings (512 numbers each, length 1) whose dot product says how well they match.
// Messages in:  { id, op: 'images', bitmaps: ImageBitmap[] } | { id, op: 'text', texts: string[] }
// Messages out: { id, vectors: Float32Array[] } | { id, error } | { type: 'progress', ... }

import {
  AutoProcessor, AutoTokenizer, CLIPTextModelWithProjection, CLIPVisionModelWithProjection, RawImage,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2';

// The page picks the model with ?model= (see EMBED_MODEL in catalog.js).
const MODEL = `Xenova/${new URL(self.location.href).searchParams.get('model') || 'mobileclip_s0'}`;
let vision, text;

async function hasWebGPU() {
  try { return !!(navigator.gpu && (await navigator.gpu.requestAdapter())); } catch { return false; }
}

const progress = (part) => (p) => {
  if (p.status === 'progress') postMessage({ type: 'progress', part, file: p.file, loaded: p.loaded, total: p.total });
};

// Image model on the graphics chip when available (fp16 is fast there); otherwise the
// 8-bit version on the CPU. The text model only runs once per search, so CPU is fine.
function loadVision() {
  return (vision ??= (async () => {
    const gpu = await hasWebGPU();
    const [processor, model] = await Promise.all([
      AutoProcessor.from_pretrained(MODEL),
      CLIPVisionModelWithProjection.from_pretrained(MODEL, {
        device: gpu ? 'webgpu' : 'wasm', dtype: gpu ? 'fp16' : 'q8', progress_callback: progress('image model'),
      }),
    ]);
    return { processor, model, device: gpu ? 'webgpu' : 'wasm' };
  })());
}

function loadText() {
  return (text ??= (async () => {
    const [tokenizer, model] = await Promise.all([
      AutoTokenizer.from_pretrained(MODEL),
      CLIPTextModelWithProjection.from_pretrained(MODEL, { device: 'wasm', dtype: 'q8', progress_callback: progress('text model') }),
    ]);
    return { tokenizer, model };
  })());
}

function normalizedRows(tensor) {
  const t = tensor.type === 'float32' ? tensor : tensor.to('float32');
  const [n, dim] = t.dims;
  const rows = [];
  for (let i = 0; i < n; i++) {
    const v = Float32Array.from(t.data.subarray(i * dim, (i + 1) * dim));
    let len = 0;
    for (const x of v) len += x * x;
    len = Math.sqrt(len) || 1;
    for (let j = 0; j < dim; j++) v[j] /= len;
    rows.push(v);
  }
  return rows;
}

function toRawImage(bmp) {
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  return new RawImage(data, width, height, 4);
}

async function embedImages(bitmaps) {
  const { processor, model } = await loadVision();
  const inputs = await processor(bitmaps.map(toRawImage));
  const { image_embeds } = await model(inputs);
  return normalizedRows(image_embeds);
}

async function embedText(texts) {
  const { tokenizer, model } = await loadText();
  const inputs = tokenizer(texts, { padding: 'max_length', truncation: true });
  const { text_embeds } = await model(inputs);
  return normalizedRows(text_embeds);
}

// One job at a time keeps GPU memory flat while a whole folder is catalogued.
let queue = Promise.resolve();
self.onmessage = (e) => {
  const { id, op } = e.data;
  queue = queue.then(async () => {
    try {
      const vectors = op === 'images' ? await embedImages(e.data.bitmaps)
        : op === 'text' ? await embedText(e.data.texts)
        : op === 'info' ? [] : null;
      if (!vectors) throw new Error(`Unknown op ${op}`);
      const device = vision ? (await vision).device : null;
      postMessage({ id, vectors, device }, vectors.map((v) => v.buffer));
    } catch (err) {
      postMessage({ id, error: String(err?.message || err) });
    }
  });
};
