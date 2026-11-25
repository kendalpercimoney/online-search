// Google Drive API access: listing, metadata, byte ranges and folder paths.

import { validToken } from './auth.js';
import { bytes, timecode } from './util.js';

const API = 'https://www.googleapis.com/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,parents,thumbnailLink,webContentLink,videoMediaMetadata,imageMediaMetadata(width,height)';
const LISTING_TTL = 5 * 60 * 1000;

function requireToken() {
  const token = validToken();
  if (!token) throw new Error('Not signed in, or the Google session has expired.');
  return token;
}

export async function drive(path, params = {}) {
  const url = new URL(`${API}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${requireToken()}` } });
  if (!res.ok) {
    const err = new Error(`Drive API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Authorised fetch for uploads and downloads; throws with .status on failure.
export async function driveFetch(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${requireToken()}` } });
  if (!res.ok) {
    const err = new Error(`Drive ${res.status}: ${(await res.text()).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

export const mediaUrl = (fileId) => `${API}/files/${fileId}?alt=media&supportsAllDrives=true`;

// A byte range of a file, retried a couple of times (Drive is occasionally slow to answer).
export async function driveRead(fileId, offset, length) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(mediaUrl(fileId), {
        headers: { Authorization: `Bearer ${requireToken()}`, Range: `bytes=${offset}-${offset + length - 1}` },
      });
      if (res.status !== 206) throw new Error(`Drive range read ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      if (attempt >= 3) throw err;
    }
  }
}

export async function listFiles(q, orderBy, max) {
  const files = [];
  let pageToken;
  do {
    const res = await drive('files', {
      q, orderBy, pageSize: 200, fields: `nextPageToken,files(${FILE_FIELDS})`,
      supportsAllDrives: true, includeItemsFromAllDrives: true, corpora: 'allDrives',
      ...(pageToken && { pageToken }),
    });
    files.push(...res.files);
    pageToken = res.nextPageToken;
  } while (pageToken && files.length < max);
  return files;
}

// Files named "._something" are Mac Finder metadata (AppleDouble), a few KB each, that get
// copied along with footage from camera cards. Drive labels them video by their extension.
const isAppleDouble = (f) => f.name.startsWith('._');

// Videos and photos. Kinds of image the app can't show (Photoshop files, vector art) are left
// out unless Drive made a thumbnail for them.
const SHOWN_IMAGE = /^image\/(jpeg|png|gif|webp|heic|heif|avif|bmp|tiff|x-|dng)/;
const isMedia = (f) => !isAppleDouble(f) && (f.mimeType.startsWith('video/') || SHOWN_IMAGE.test(f.mimeType) || !!f.thumbnailLink);
export const listMedia = (where, orderBy = 'name', max = 2000) =>
  listFiles(`(mimeType contains 'video/' or mimeType contains 'image/') and trashed = false${where ? ` and ${where}` : ''}`, orderBy, max)
    .then((files) => files.filter(isMedia));
export const listFolders = (where) =>
  listFiles(`mimeType = '${FOLDER_MIME}' and trashed = false and ${where}`, 'name', 500);
export const quote = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

// Videos and photos in one folder, cached for a few minutes (search results reuse this for
// thumbnails and fresh details).
const listings = new Map(); // folderId -> { at, promise: Promise<Map<id, file>> }
export function folderMedia(folderId, { refresh = false } = {}) {
  const hit = listings.get(folderId);
  if (!refresh && hit && Date.now() - hit.at < LISTING_TTL) return hit.promise;
  const promise = listMedia(`'${folderId}' in parents`).then((files) => new Map(files.map((f) => [f.id, f])));
  promise.catch(() => listings.delete(folderId));
  listings.set(folderId, { at: Date.now(), promise });
  return promise;
}

// Folder names and parents, for breadcrumbs and "is this inside that folder" checks.
export const folderInfo = new Map();
export async function folderPath(id) {
  const path = [];
  for (let cur = id; cur && path.length < 25; ) {
    let f = folderInfo.get(cur);
    if (!f) {
      try {
        f = await drive(`files/${cur}`, { fields: 'id,name,parents,driveId', supportsAllDrives: true });
        if (f.driveId && f.driveId === f.id) f.name = (await drive(`drives/${f.id}`, { fields: 'name' })).name;
      } catch {
        break; // a parent we can't see, e.g. above a folder someone shared with us
      }
      folderInfo.set(cur, f);
      if (f.id !== cur) folderInfo.set(f.id, f); // 'root' resolves to My Drive's real id
    }
    path.unshift(f);
    cur = f.parents?.[0];
  }
  return path;
}

export const realFolderId = (id) => folderInfo.get(id)?.id || id;

export async function isInside(folderId, ancestorId) {
  if (!folderId) return false;
  const target = realFolderId(ancestorId);
  return (await folderPath(folderId)).some((f) => f.id === target);
}

export const isImage = (item) => item.kind === 'image';

// Everything the UI needs to show and play a clip, or show a photo.
export function toItem(f) {
  const image = f.mimeType.startsWith('image/');
  const meta = image ? f.imageMediaMetadata : f.videoMediaMetadata;
  const duration = image ? 0 : meta?.durationMillis / 1000;
  return {
    kind: image ? 'image' : 'video',
    id: f.id,
    cacheKey: `${f.id}:${f.size}:${f.modifiedTime}`,
    name: f.name,
    mime: f.mimeType,
    size: Number(f.size) || 0,
    modifiedTime: f.modifiedTime,
    folderId: f.parents?.[0],
    read: (offset, length) => driveRead(f.id, offset, length),
    src: `drive-media/${f.id}?size=${f.size || 0}`,
    thumb: f.thumbnailLink?.replace(/=s\d+$/, '=s640'),
    // Drive's thumbnail server also makes large versions, in a format any browser shows
    // (camera RAW and HEIC included), so the viewer uses one of those.
    large: f.thumbnailLink?.replace(/=s\d+$/, '=s2400'),
    downloadable: !!f.webContentLink,
    webContentLink: f.webContentLink,
    duration,
    sub: [!image && timecode(duration), meta?.width && `${meta.width}×${meta.height}`, bytes(Number(f.size))].filter(Boolean).join(' · '),
  };
}
