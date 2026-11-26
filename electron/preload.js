// The only bridge between the UI and the desktop shell.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  info: () => ipcRenderer.invoke('app-info'),
  pickFolder: (opts) => ipcRenderer.invoke('pick-folder', opts),
  setTheme: (dark) => ipcRenderer.send('set-theme', { dark }),
  reveal: (fullPath) => ipcRenderer.send('reveal', fullPath),
  onUpdateReady: (cb) => ipcRenderer.on('update-ready', (_e, info) => cb(info)),
  installUpdate: () => ipcRenderer.send('install-update'),
  host: {
    status: () => ipcRenderer.invoke('host:status'),
    start: (port) => ipcRenderer.invoke('host:start', { port }),
    stop: () => ipcRenderer.invoke('host:stop'),
    setOpenAtLogin: (on) => ipcRenderer.invoke('host:open-at-login', !!on),
    openDataFolder: () => ipcRenderer.send('host:open-data'),
    onChange: (cb) => ipcRenderer.on('host-changed', (_e, s) => cb(s)),
  },
});
