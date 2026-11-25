#!/usr/bin/env node
// Publishes a new version of Online Search to your team:
//
//   npm run release -- 0.5.0 "Photos open with one click" "Faster search in big folders"
//
// Each quoted item after the version is one line in the update notice's "What's new" list.
//
// Installers go in a private Google Drive folder ("Online Search releases" in your My
// Drive). Only people you share that folder with (teammates' Google accounts or company
// domains) can see them, and their copies of the app find new versions there. See
// RELEASING.md for the whole process.
//
// 1. Checks the code is committed and on main.
// 2. Signs in to Google (once; remembered in ~/.config/online-search/) and finds or creates
//    the releases folder, recording its id in desktop/config.json so the app knows it.
// 3. Sets the version and builds the installer into dist/<version>.
// 4. Uploads it to the releases folder with the notes.
// 5. Commits "Release <version>", tags it v<version> and pushes (to the private code repo).

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FOLDER_NAME = 'Online Search releases';
const SCOPE = 'https://www.googleapis.com/auth/drive.file'; // only files this tool creates
const API = 'https://www.googleapis.com/drive/v3';
const TOKEN_FILE = path.join(os.homedir(), '.config', 'online-search', 'release-sign-in.json');

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const CONFIG = 'desktop/config.json';

const fail = (msg) => { console.error(`\n✗ ${msg}\n`); process.exit(1); };
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
const output = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();
const step = (msg) => console.log(`\n▸ ${msg}`);
const newer = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  return false;
};

// ---------- Google sign-in (the same "installed app" flow the Mac app uses) ----------

const config = () => JSON.parse(fs.readFileSync(CONFIG, 'utf8'));

async function tokenRequest(params) {
  const { clientId, clientSecret } = config();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
  });
  const body = await res.json();
  if (!res.ok) throw Object.assign(new Error(body.error_description || body.error), { code: body.error });
  return body;
}

async function signIn() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const redirect = `http://127.0.0.1:${server.address().port}`;
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: config().clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPE,
    code_challenge: challenge, code_challenge_method: 'S256', state, access_type: 'offline', prompt: 'consent',
  })}`;
  console.log('  Your browser is opening Google sign-in. Use the account that should own the releases folder.');
  console.log(`  If it doesn't open, visit:\n  ${url}`);
  execFileSync('open', [url]);
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Sign-in timed out after 5 minutes.')), 5 * 60 * 1000);
    server.on('request', (req, res) => {
      const q = new URL(req.url, redirect).searchParams;
      if (!q.get('code') && !q.get('error')) return res.writeHead(404).end();
      const ok = q.get('state') === state && q.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(`<p style="font:16px system-ui;margin:40px">${ok ? 'Signed in. You can close this tab and go back to Terminal.' : 'Sign-in didn’t finish. Go back to Terminal and try again.'}</p>`);
      clearTimeout(timer);
      ok ? resolve(q.get('code')) : reject(new Error(q.get('error') || 'Sign-in failed.'));
    });
  });
  server.close();
  const body = await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirect });
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ refresh: body.refresh_token }), { mode: 0o600 });
  return body.access_token;
}

async function accessToken() {
  try {
    const { refresh } = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    return (await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh })).access_token;
  } catch {
    return signIn();
  }
}

async function drive(token, url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
  if (!res.ok) throw Object.assign(new Error(`Google Drive ${res.status}: ${(await res.text()).slice(0, 300)}`), { status: res.status });
  return res;
}

// ---------- the releases folder ----------

async function releasesFolder(token) {
  const cfg = config();
  if (cfg.releasesFolderId) {
    try {
      const f = await (await drive(token, `${API}/files/${cfg.releasesFolderId}?fields=id,trashed,webViewLink`)).json();
      if (!f.trashed) return f;
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    fail(`The releases folder in ${CONFIG} (${cfg.releasesFolderId}) is gone or not yours. Remove "releasesFolderId" from ${CONFIG} to make a new one.`);
  }
  const f = await (await drive(token, `${API}/files?fields=id,webViewLink`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder',
      description: 'Online Search installers. Share this folder with your team (View access) so their app can update.',
    }),
  })).json();
  fs.writeFileSync(CONFIG, `${JSON.stringify({ ...cfg, releasesFolderId: f.id }, null, 2)}\n`);
  console.log(`  Created "${FOLDER_NAME}" in your My Drive: ${f.webViewLink}`);
  return f;
}

async function upload(token, folderId, file, version, notes) {
  const meta = {
    name: path.basename(file), parents: [folderId], mimeType: 'application/x-apple-diskimage',
    description: notes, appProperties: { osRelease: '1', version, arch: 'arm64' },
  };
  const size = fs.statSync(file).size;
  const start = await drive(token, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': meta.mimeType, 'X-Upload-Content-Length': String(size) },
    body: JSON.stringify(meta),
  });
  const res = await drive(token, start.headers.get('location'), {
    method: 'PUT', headers: { 'Content-Length': String(size) }, body: fs.readFileSync(file),
  });
  return (await res.json()).id;
}

// ---------- release ----------

const [version, ...items] = process.argv.slice(2);
const features = items.flatMap((i) => i.split('\n')).map((l) => l.replace(/^\s*[-•*]\s*/, '').trim()).filter(Boolean);
if (!/^\d+\.\d+\.\d+$/.test(version || '') || !features.length) {
  fail('Usage: npm run release -- <version> "<what\'s new>" ["<another feature>" ...]\n  For example: npm run release -- 0.5.0 "Photos open with one click" "Faster search"');
}
const notes = features.join('\n');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
if (!newer(version, pkg.version)) fail(`${version} must be newer than the current version, ${pkg.version}.`);
if (output('git', ['status', '--porcelain'])) fail('Commit or discard your changes first, so the release matches the code.');
if (output('git', ['branch', '--show-current']) !== 'main') fail('Switch to the main branch first.');
if (!fs.existsSync(CONFIG)) fail(`${CONFIG} is missing (the Google sign-in settings). See desktop/config.example.json.`);

step('Signing in to Google Drive');
const token = await accessToken();
const folder = await releasesFolder(token);

step(`Setting the version to ${version}`);
pkg.version = version;
fs.writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
const settings = 'web/js/settings.js';
fs.writeFileSync(settings, fs.readFileSync(settings, 'utf8').replace(/(desktop\?\.version \|\| ')[\d.]+'/, `$1${version}'`));

step('Building the installer');
const out = `dist/${version}`;
run('npx', ['electron-builder', '--mac', 'dmg', '--arm64', `-c.directories.output=${out}`]);
const dmg = path.join(out, `${pkg.productName}-${version}-arm64.dmg`);
if (!fs.existsSync(dmg)) fail(`The build didn't produce ${dmg}.`);
fs.copyFileSync('desktop/INSTALL.md', path.join(out, `${pkg.productName} - Install Guide.md`));

step(`Uploading to "${FOLDER_NAME}" on Google Drive`);
await upload(await accessToken(), folder.id, dmg, version, notes); // fresh token: the build takes minutes

step('Committing and pushing');
run('git', ['commit', '-q', '-am', `Release ${version}\n\n${features.map((f) => `- ${f}`).join('\n')}`]);
run('git', ['tag', '-a', `v${version}`, '-m', `${pkg.productName} ${version}`]);
run('git', ['push', '-q', '--follow-tags']);

console.log(`\n✓ ${pkg.productName} ${version} is out to everyone the releases folder is shared with.`);
console.log(`  Folder: ${folder.webViewLink}\n  Installer: ${dmg}\n`);
