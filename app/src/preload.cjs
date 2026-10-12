// Bridge between the window and the app: only these calls exist, nothing else of Node/Electron is reachable.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('archiver', {
  info: () => ipcRenderer.invoke('app:info'),
  chooseFolder: () => ipcRenderer.invoke('folder:choose'),
  login: () => ipcRenderer.invoke('login'),
  start: (full) => ipcRenderer.invoke('archive:start', { full: Boolean(full) }),
  cancel: () => ipcRenderer.invoke('archive:cancel'),
  openArchive: () => ipcRenderer.invoke('open:archive'),
  openIndex: () => ipcRenderer.invoke('open:index'),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, ev) => cb(ev)),
  onStatus: (cb) => ipcRenderer.on('status', (_e, s) => cb(s)),
});
