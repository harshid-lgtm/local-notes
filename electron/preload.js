// The only bridge between the UI and the desktop shell.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  info: () => ipcRenderer.invoke('app-info'),
  pickFolder: (opts) => ipcRenderer.invoke('pick-folder', opts),
  // export: native save dialog, PDF rendering and printing
  saveFile: (opts) => ipcRenderer.invoke('save-file', opts),
  openFiles: () => ipcRenderer.invoke('open-files'),
  exportPdf: (opts) => ipcRenderer.invoke('export-pdf', opts),
  printHtml: (html) => ipcRenderer.invoke('print-html', html),
  setTheme: (dark) => ipcRenderer.send('set-theme', { dark }),
  reveal: (fullPath) => ipcRenderer.send('reveal', fullPath),
  onUpdateReady: (cb) => ipcRenderer.on('update-ready', (_e, info) => cb(info)),
  installUpdate: () => ipcRenderer.send('install-update'),
  // UI settings live in a file in the profile, so they survive restarts and updates
  state: {
    load: () => { try { return ipcRenderer.sendSync('state:load') || {}; } catch { return {}; } },
    save: (data) => ipcRenderer.send('state:save', data),
  },
  // the app asks the page to save unsaved work before it quits (e.g. to install an update)
  onFlush: (cb) => ipcRenderer.on('flush-request', async () => { try { await cb(); } finally { ipcRenderer.send('flush-done'); } }),
  host: {
    status: () => ipcRenderer.invoke('host:status'),
    start: (port) => ipcRenderer.invoke('host:start', { port }),
    stop: () => ipcRenderer.invoke('host:stop'),
    setOpenAtLogin: (on) => ipcRenderer.invoke('host:open-at-login', !!on),
    openDataFolder: () => ipcRenderer.send('host:open-data'),
    onChange: (cb) => ipcRenderer.on('host-changed', (_e, s) => cb(s)),
  },
});
