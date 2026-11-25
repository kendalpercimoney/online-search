// Mac app shell for Online Search. It serves the web app (../web) from inside the app and
// adds what a browser can't: desktop sign-in (auth.js) and downloads that save straight to
// the Downloads folder, a local route to Drive's smaller playback copies (copies.js) and
// notices when a new version is out (updates.js).
// preload.js exposes these to the page.

const { app, BrowserWindow, dialog, ipcMain, session, shell } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');
const copies = require('./copies');
const updates = require('./updates');

// A fixed local address keeps the page's browser storage (saved filmstrips, search cache)
// between launches, because that storage belongs to the address.
const PORT = 47615;
const WEB_ROOT = path.join(__dirname, '..', 'web');
const ICON = path.join(__dirname, 'build', 'icon.png');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json',
};

let win = null;
let auth = null;

function serve() {
  const server = http.createServer((req, res) => {
    if (copies.handle(req, res, () => auth.getToken())) return;
    const rel = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.join(WEB_ROOT, rel);
    if (!file.startsWith(WEB_ROOT + path.sep) || !TYPES[path.extname(file)]) return res.writeHead(404).end();
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'no-cache' });
      fs.createReadStream(file).pipe(res);
    });
  });
  return new Promise((resolve) => {
    server.once('error', () => server.listen(0, '127.0.0.1')); // port taken: any free one
    server.on('listening', () => resolve(`http://127.0.0.1:${server.address().port}/`));
    server.listen(PORT, '127.0.0.1');
  });
}

function createWindow(appUrl) {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 760, minHeight: 520,
    title: 'Online Search', backgroundColor: '#15152a',
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 22, y: 22 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true,
      backgroundThrottling: false, // keep cataloguing while the window is hidden or minimised
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(appUrl)) return;
    e.preventDefault();
    shell.openExternal(url);
  });
  win.on('closed', () => { win = null; });
  win.loadURL(appUrl);
}

function bringToFront() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  app.focus({ steal: true });
}

// ---------- downloads ----------

const downloads = new Map(); // id -> DownloadItem
const pendingNames = [];     // names for downloads that have been requested but not started

function uniquePath(dir, name) {
  const safe = name.replace(/[/:]/g, '-');
  const ext = path.extname(safe), base = safe.slice(0, safe.length - ext.length);
  let candidate = path.join(dir, safe);
  for (let n = 2; fs.existsSync(candidate); n++) candidate = path.join(dir, `${base} (${n})${ext}`);
  return candidate;
}

function updateDockProgress() {
  let received = 0, total = 0;
  for (const item of downloads.values()) {
    if (item.getState() !== 'progressing') continue;
    received += item.getReceivedBytes();
    total += item.getTotalBytes();
  }
  win?.setProgressBar(total ? received / total : -1);
}

function trackDownloads() {
  session.defaultSession.on('will-download', (_e, item) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const name = pendingNames.shift() || item.getFilename();
    const savePath = uniquePath(app.getPath('downloads'), name);
    item.setSavePath(savePath);
    downloads.set(id, item);
    let lastSent = 0;
    const send = (state, extra = {}) => win?.webContents.send('download', {
      id, name: path.basename(savePath), path: savePath, state,
      received: item.getReceivedBytes(), total: item.getTotalBytes(), ...extra,
    });
    send('progressing');
    item.on('updated', () => {
      if (Date.now() - lastSent < 250) return;
      lastSent = Date.now();
      send('progressing');
      updateDockProgress();
    });
    item.once('done', (_e2, state) => {
      downloads.delete(id);
      send(state === 'interrupted' ? 'failed' : state);
      updateDockProgress();
      if (state === 'completed') app.dock?.downloadFinished(savePath);
    });
  });
}

// ---------- start-up ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setName('Online Search');
  app.setAboutPanelOptions({
    applicationName: 'Online Search', applicationVersion: app.getVersion(),
    copyright: '© Percimoney Technologies', iconPath: ICON,
  });
  app.on('second-instance', bringToFront);

  app.whenReady().then(async () => {
    app.dock?.setIcon(ICON); // packaged builds use the .icns; this covers development runs
    try {
      auth = require('./auth');
    } catch (err) {
      dialog.showErrorBox('Online Search can’t start', `This copy is missing its Google sign-in settings (desktop/config.json).\n\n${err.message}`);
      return app.quit();
    }
    ipcMain.on('app:version', (e) => { e.returnValue = app.getVersion(); });
    ipcMain.on('app:copy-base', (e) => { e.returnValue = copies.base; });
    ipcMain.handle('auth:get-token', () => auth.getToken());
    ipcMain.handle('auth:sign-in', async () => {
      const result = await auth.signIn();
      bringToFront();
      updates.checkSoon();
      return result;
    });
    ipcMain.handle('auth:sign-out', () => auth.signOut());
    ipcMain.handle('download:start', async (_e, { fileId, name }) => {
      const t = await auth.getToken();
      if (!t) throw new Error('Not signed in');
      pendingNames.push(name);
      win.webContents.downloadURL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, {
        headers: { Authorization: `Bearer ${t.token}` },
      });
    });
    ipcMain.handle('download:cancel', (_e, id) => downloads.get(id)?.cancel());
    ipcMain.handle('download:reveal', (_e, file) => shell.showItemInFolder(file));
    trackDownloads();
    updates.start(ipcMain, () => win, () => auth.getToken());

    const appUrl = await serve();
    createWindow(appUrl);
    app.on('activate', () => { if (!win) createWindow(appUrl); });
  });

  app.on('render-process-gone', (_e, _wc, details) => console.error('Page process ended:', details));
  app.on('child-process-gone', (_e, details) => console.error('Helper process ended:', details));
  app.on('window-all-closed', () => app.quit());
}
