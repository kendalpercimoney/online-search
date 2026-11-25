// Update notices (optional). Installers are kept in a private Google Drive folder that only
// your team is given access to (shared with their Google account or company domain), so
// nobody else can see or download them. The app looks in that folder with the person's
// own sign-in, shortly after launch and every few hours. A newer version downloads in the
// background and is unpacked ready to go; the person chooses Restart now, or it installs
// when they next quit. The app replaces its own bundle (a small script swaps it in once
// the app has exited), so no Apple certificate is needed. Where it can't (for example the
// app is somewhere the person can't write to), it falls back to opening the installer
// for them to drag into Applications.
// Publishing a release: `npm run release -- <version> "<notes>"` (scripts/release.mjs),
// which also records the folder's id in config.json as releasesFolderId.

const { app, net, shell } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const FIRST_CHECK = 10 * 1000;
const CHECK_EVERY = 6 * 60 * 60 * 1000;
const API = 'https://www.googleapis.com/drive/v3';

let FOLDER = null;
try { FOLDER = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')).releasesFolderId || null; } catch {}

// ONLINE_SEARCH_PRETEND_VERSION lets a development run act as an older version, to test.
const currentVersion = () => process.env.ONLINE_SEARCH_PRETEND_VERSION || app.getVersion();
let getToken = async () => null;

// state: idle | checking | current | available | downloading | ready | error
let status = { state: 'idle', current: currentVersion() };
let send = () => {};
let downloading = null;
let retries = 0;

function set(next) {
  status = { ...next, current: currentVersion() };
  send(status);
}

// "0.10.0" > "0.9.2"
function newer(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

async function drive(url, init = {}) {
  const t = await getToken();
  if (!t) { const err = new Error('Sign in with Google to check for updates.'); err.signedOut = true; throw err; }
  return net.fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${t.token}` } });
}

// The newest installer in the releases folder. Someone without access to the folder simply
// sees none, the same as when nothing has been published.
async function latestRelease() {
  if (!FOLDER) return null;
  const q = `'${FOLDER}' in parents and trashed = false and appProperties has { key='osRelease' and value='1' }`;
  const params = new URLSearchParams({
    q, pageSize: '100', fields: 'files(id,name,size,description,appProperties,webViewLink)',
    supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
  });
  const res = await drive(`${API}/files?${params}`);
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) throw new Error(`Google Drive answered ${res.status}`);
  const { files = [] } = await res.json();
  const ours = files.filter((f) => /^\d+\.\d+\.\d+$/.test(f.appProperties?.version || '')
    && (f.appProperties.arch || 'arm64') === process.arch);
  return ours.reduce((best, f) => (!best || newer(f.appProperties.version, best.appProperties.version) ? f : best), null);
}

async function check({ quiet = false } = {}) {
  if (['checking', 'downloading', 'ready'].includes(status.state)) return status;
  const before = status;
  if (!quiet) set({ state: 'checking' });
  try {
    const f = await latestRelease();
    retries = 0;
    const version = f?.appProperties.version;
    if (!f || !newer(version, currentVersion())) set({ state: 'current' });
    else {
      set({
        state: 'available', version, notes: f.description || '', name: f.name, total: Number(f.size) || 0,
        url: `${API}/files/${f.id}?alt=media&supportsAllDrives=true`, page: f.webViewLink,
      });
      download(); // in the background; the notice appears once it's ready to install
    }
  } catch (err) {
    // A background check can run before the sign-in is ready, or while offline: try again
    // in a couple of minutes, a few times, before waiting for the next regular check.
    if (quiet && retries < 5) { retries++; setTimeout(() => check({ quiet: true }), 2 * 60 * 1000); }
    if (quiet) set(before.state === 'checking' ? { state: 'idle' } : before);
    else set({ state: 'error', error: err.message });
  }
  return status;
}

// ---------- installing ----------

const workDir = () => path.join(app.getPath('temp'), 'online-search-update');
const runTool = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, (err, out, errOut) => (err ? reject(new Error((errOut || err.message).trim())) : resolve(out)));
});
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The app bundle to replace, e.g. /Applications/Online Search.app, when the app is allowed
// to replace it. ONLINE_SEARCH_INSTALL_TARGET points a development run at a copy, to test.
function installTarget() {
  const target = process.env.ONLINE_SEARCH_INSTALL_TARGET
    || (app.isPackaged ? path.resolve(process.execPath, '..', '..', '..') : null);
  if (!target?.endsWith('.app') || target.includes('/AppTranslocation/')) return null;
  try {
    fs.accessSync(path.dirname(target), fs.constants.W_OK);
    fs.accessSync(target, fs.constants.W_OK);
    return target;
  } catch {
    return null;
  }
}

// Copies the new app out of the installer into a waiting area and checks its version.
async function unpack(dmg, version) {
  const mount = path.join(workDir(), 'mount');
  const staged = path.join(workDir(), 'Online Search.app');
  fs.rmSync(staged, { recursive: true, force: true });
  fs.mkdirSync(mount, { recursive: true });
  await runTool('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, dmg]);
  try {
    const bundle = fs.readdirSync(mount).find((n) => n.endsWith('.app'));
    if (!bundle) throw new Error('The installer has no app in it.');
    await runTool('ditto', [path.join(mount, bundle), staged]);
  } finally {
    await runTool('hdiutil', ['detach', mount, '-force']).catch(() => {});
  }
  const plist = path.join(staged, 'Contents', 'Info.plist');
  const got = (await runTool('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist])).trim();
  if (got !== version) throw new Error(`The installer holds version ${got}, not ${version}.`);
  return staged;
}

// Swaps the new app in once this one has exited, keeping the old one until the new one is
// in place (so a failure leaves the old app working), then optionally opens it again.
let installScheduled = false;
function installAfterExit(relaunch) {
  if (installScheduled || status.state !== 'ready' || status.mode !== 'auto') return false;
  installScheduled = true;
  const { target, staged } = status;
  const script = `
exec >>${shq(path.join(app.getPath('userData'), 'update-install.log'))} 2>&1
echo "$(date): installing ${status.version}"
while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done
target=${shq(target)}; staged=${shq(staged)}
rm -rf "$target.updating" "$target.previous"
if ditto "$staged" "$target.updating" && mv "$target" "$target.previous" && mv "$target.updating" "$target"; then
  rm -rf "$target.previous" "$staged"
  echo "installed"
else
  [ -d "$target" ] || mv "$target.previous" "$target"
  rm -rf "$target.updating"
  echo "failed; kept the current version"
fi
xattr -dr com.apple.quarantine "$target" 2>/dev/null
${relaunch ? 'open "$target"' : ''}
`;
  spawn('/bin/bash', ['-c', script], { detached: true, stdio: 'ignore' }).unref();
  return true;
}

// Downloads the installer, then unpacks it ready to install (or, where the app can't
// replace itself, keeps it in Downloads for the person to install).
async function download() {
  if (status.state !== 'available') return status;
  const info = status;
  const target = installTarget();
  downloading = new AbortController();
  set({ ...info, state: 'downloading', received: 0 });
  const dir = target ? workDir() : app.getPath('downloads');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, info.name);
  const part = `${file}.part`;
  try {
    const res = await drive(info.url, { signal: downloading.signal });
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const total = Number(res.headers.get('content-length')) || info.total || 0;
    const out = fs.createWriteStream(part);
    let received = 0, lastSent = 0;
    for await (const chunk of res.body) {
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      received += chunk.length;
      if (Date.now() - lastSent > 250) {
        lastSent = Date.now();
        set({ ...info, state: 'downloading', received, total });
      }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    fs.renameSync(part, file);
    if (target) {
      try {
        const staged = await unpack(file, info.version);
        fs.rmSync(file, { force: true });
        set({ ...info, state: 'ready', mode: 'auto', target, staged });
        return status;
      } catch (err) {
        console.warn('Unpacking the update failed; falling back to the installer:', err);
        const kept = path.join(app.getPath('downloads'), info.name);
        fs.renameSync(file, kept);
        set({ ...info, state: 'ready', mode: 'manual', path: kept });
        return status;
      }
    }
    set({ ...info, state: 'ready', mode: 'manual', path: file });
  } catch (err) {
    fs.rmSync(part, { force: true });
    set(err.name === 'AbortError' ? info : { ...info, state: 'error', error: err.message, retry: 'available' });
    // A dropped connection shouldn't leave people waiting hours for the next check.
    if (err.name !== 'AbortError' && retries < 5) { retries++; setTimeout(() => check({ quiet: true }), 2 * 60 * 1000); }
  } finally {
    downloading = null;
  }
  return status;
}

function cancel() {
  downloading?.abort();
}

// Restart now: install and open the new version. Where the app can't replace itself, opens
// the installer (which shows the app beside Applications) and quits, so it can be dragged.
function restartToUpdate() {
  if (status.mode === 'manual' && status.path) shell.openPath(status.path);
  else installAfterExit(true);
  setTimeout(() => app.quit(), 200);
}

function start(ipcMain, getWindow, tokenSource) {
  getToken = tokenSource;
  send = (s) => getWindow()?.webContents.send('update', s);
  ipcMain.handle('update:status', () => status);
  ipcMain.handle('update:check', () => check());
  ipcMain.handle('update:download', () => {
    if (status.state === 'error' && status.retry) set({ ...status, state: status.retry });
    return download();
  });
  ipcMain.handle('update:cancel', () => cancel());
  ipcMain.handle('update:quit', () => restartToUpdate());
  ipcMain.handle('update:open-page', () => status.page && shell.openExternal(status.page));
  fs.rmSync(workDir(), { recursive: true, force: true }); // anything left from an earlier run
  app.on('will-quit', () => installAfterExit(false)); // "Later": install on the way out
  setTimeout(() => check({ quiet: true }), FIRST_CHECK);
  setInterval(() => check({ quiet: true }), CHECK_EVERY);
}

// After signing in, so someone who signs in later doesn't wait hours for the next check.
const checkSoon = () => setTimeout(() => check({ quiet: true }), 3000);

module.exports = { start, checkSoon };
