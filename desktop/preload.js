// Gives the page what the Mac app adds over a browser: Google sign-in through the system
// browser (auth.js), downloads straight to the Downloads folder, and update notices. Its presence is how
// the page knows it is running inside the Mac app.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopApp', {
  version: ipcRenderer.sendSync('app:version'),
  copyBase: ipcRenderer.sendSync('app:copy-base'),
  getToken: () => ipcRenderer.invoke('auth:get-token'),
  signIn: () => ipcRenderer.invoke('auth:sign-in'),
  signOut: () => ipcRenderer.invoke('auth:sign-out'),
  download: (file) => ipcRenderer.invoke('download:start', file),
  cancelDownload: (id) => ipcRenderer.invoke('download:cancel', id),
  revealDownload: (filePath) => ipcRenderer.invoke('download:reveal', filePath),
  onDownload: (fn) => ipcRenderer.on('download', (_e, d) => fn(d)),
  updates: {
    status: () => ipcRenderer.invoke('update:status'),
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    cancel: () => ipcRenderer.invoke('update:cancel'),
    quit: () => ipcRenderer.invoke('update:quit'),
    openPage: () => ipcRenderer.invoke('update:open-page'),
    onChange: (fn) => ipcRenderer.on('update', (_e, s) => fn(s)),
  },
});
