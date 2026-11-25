// Drive's own smaller copies of each video (360p, 720p and 1080p, made when the file is
// uploaded), the ones drive.google.com plays. Google's public API doesn't list them, but
// the endpoint Drive's player uses answers to the app's sign-in. Their addresses expire
// after a few hours and don't allow other web pages to read them, so the page reaches
// them through this local proxy:
//
//   GET /copy-api/<key>/copies/<fileId>        -> { streams: [{ itag, width, height }], mbps }
//   GET /copy-api/<key>/copy/<fileId>/<itag>   -> the copy itself, with Range support
//   GET /copy-api/<key>/speed                   -> { mbps } measured from recent downloads
//   GET /copy-api/<key>/thumb?u=<thumbnailLink>  -> a Drive thumbnail (for files in My Drive
//                                                  Google doesn't let pages read these directly)
//
// <key> is random per launch, so other programs on this Mac can't use the proxy.

const crypto = require('crypto');
const { net } = require('electron');
const { Readable } = require('stream');

const KEY = crypto.randomBytes(18).toString('base64url');
const INFO_TTL = 45 * 60 * 1000; // the addresses last longer; this is a safe margin
const info = new Map();          // fileId -> { at, promise }
let mbps = null;                 // measured speed of recent copy downloads

const PREFIX = `/copy-api/${KEY}/`;

async function lookup(fileId, getToken) {
  const t = await getToken();
  if (!t) throw new Error('Not signed in');
  const res = await net.fetch(
    `https://drive.google.com/u/0/get_video_info?docid=${encodeURIComponent(fileId)}&drive_originator_app=303`,
    { headers: { Authorization: `Bearer ${t.token}` } },
  );
  if (!res.ok) throw new Error(`Drive answered ${res.status}`);
  const q = new URLSearchParams(await res.text());
  if (q.get('status') !== 'ok') return { streams: [], reason: q.get('reason') || 'unavailable' };
  const sizes = new Map((q.get('fmt_list') || '').split(',').map((f) => {
    const [itag, dims] = f.split('/');
    const [w, h] = (dims || '').split('x').map(Number);
    return [itag, { width: w || 0, height: h || 0 }];
  }));
  const urls = new Map((q.get('fmt_stream_map') || '').split(',').filter(Boolean).map((s) => {
    const i = s.indexOf('|');
    return [s.slice(0, i), s.slice(i + 1)];
  }));
  const streams = [...urls.keys()].map((itag) => ({ itag: Number(itag), ...(sizes.get(itag) || {}) }))
    .sort((a, b) => Math.min(a.width, a.height) - Math.min(b.width, b.height));
  return { streams, urls };
}

function getInfo(fileId, getToken, fresh = false) {
  const hit = info.get(fileId);
  if (hit && !fresh && Date.now() - hit.at < INFO_TTL) return hit.promise;
  const promise = lookup(fileId, getToken);
  promise.catch(() => info.delete(fileId));
  // A clip Drive is still processing has no copies yet: look again in a minute, not 45.
  promise.then((r) => {
    if (!r.streams.length) setTimeout(() => { if (info.get(fileId)?.promise === promise) info.delete(fileId); }, 60_000);
  }, () => {});
  info.set(fileId, { at: Date.now(), promise });
  if (info.size > 2000) info.delete(info.keys().next().value);
  return promise;
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
}

async function streamCopy(req, res, fileId, itag, getToken) {
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  const headers = req.headers.range ? { Range: req.headers.range } : {};
  let upstream = null;
  for (const fresh of [false, true]) { // an expired address gets one fresh lookup
    const { urls } = await getInfo(fileId, getToken, fresh);
    const url = urls?.get(String(itag));
    if (!url) return res.writeHead(404).end();
    upstream = await net.fetch(url, { headers, signal: abort.signal });
    if (upstream.status !== 403 && upstream.status !== 410) break;
  }
  const out = { 'Content-Type': upstream.headers.get('content-type') || 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  for (const h of ['content-length', 'content-range']) if (upstream.headers.get(h)) out[h] = upstream.headers.get(h);
  res.writeHead(upstream.status, out);
  if (!upstream.body) return res.end();
  // Speed: the player stops reading once it has buffered enough, so only the start of
  // each response (up to 2 MB, when the connection is running flat out) is measured.
  const started = Date.now();
  let received = 0, measured = false;
  const measure = () => {
    if (measured) return;
    const secs = (Date.now() - started) / 1000;
    if (received < 1024 * 1024 || secs < 0.15) return; // smaller reads mostly measure delay
    measured = true;
    const now = (received * 8) / secs / 1e6;
    mbps = mbps == null ? now : mbps * 0.6 + now * 0.4;
  };
  const body = Readable.fromWeb(upstream.body);
  body.on('data', (c) => { received += c.length; if (received >= 2 * 1024 * 1024) measure(); });
  body.on('end', measure);
  body.on('error', () => res.destroy());
  body.pipe(res);
}

// Drive thumbnails live on googleusercontent.com; only those addresses are fetched.
async function proxyThumb(req, res) {
  let target;
  try {
    target = new URL(new URL(req.url, 'http://127.0.0.1').searchParams.get('u'));
  } catch {
    return res.writeHead(400).end();
  }
  if (target.protocol !== 'https:' || !/(^|\.)googleusercontent\.com$/.test(target.hostname)) return res.writeHead(403).end();
  try {
    const up = await net.fetch(target.href);
    const body = Buffer.from(await up.arrayBuffer());
    res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'no-store' }).end(body);
  } catch {
    if (!res.headersSent) res.writeHead(502).end();
  }
}

// Returns true when it handled the request.
function handle(req, res, getToken) {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (!path.startsWith(PREFIX)) return path.startsWith('/copy-api/') ? (res.writeHead(403).end(), true) : false;
  const [kind, fileId, itag] = path.slice(PREFIX.length).split('/');
  if (kind === 'speed') return json(res, 200, { mbps }), true;
  if (kind === 'thumb') return proxyThumb(req, res), true;
  if (!/^[\w-]+$/.test(fileId || '')) return res.writeHead(400).end(), true;
  if (kind === 'copies') {
    getInfo(fileId, getToken)
      .then(({ streams, reason }) => json(res, 200, { streams, reason, mbps }))
      .catch((err) => json(res, 200, { streams: [], reason: err.message, mbps }));
  } else if (kind === 'copy' && /^\d+$/.test(itag || '')) {
    streamCopy(req, res, fileId, Number(itag), getToken).catch(() => {
      if (!res.headersSent) res.writeHead(502).end(); else res.destroy();
    });
  } else {
    res.writeHead(404).end();
  }
  return true;
}

module.exports = { handle, base: PREFIX.slice(1) };
