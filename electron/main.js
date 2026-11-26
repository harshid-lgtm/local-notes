// Local Notes desktop app: embeds the vault server on a private localhost port and
// shows the UI in a frameless window with native folder dialogs and auto-updates.
'use strict';

const { app, BrowserWindow, dialog, ipcMain, shell, Menu, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { createVaultServer } = require('../server/core');
const host = require('./host');

const IS_MAC = process.platform === 'darwin';
const ROOT = path.join(__dirname, '..');

// lets tests and portable setups keep settings out of the normal profile
if (process.env.LOCAL_NOTES_USER_DATA) app.setPath('userData', process.env.LOCAL_NOTES_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

let win = null;
let port = 0;
const boundsFile = () => path.join(app.getPath('userData'), 'window.json');

function loadBounds() {
  try { return JSON.parse(fs.readFileSync(boundsFile(), 'utf8')); } catch { return { width: 1320, height: 860 }; }
}

function saveBounds() {
  if (!win || win.isDestroyed()) return;
  const b = { ...win.getNormalBounds(), maximized: win.isMaximized() };
  try { fs.writeFileSync(boundsFile(), JSON.stringify(b)); } catch { /* read-only profile */ }
}

function overlayColors(dark) {
  return dark ? { color: '#191918', symbolColor: '#d4d3cf', height: 46 } : { color: '#ffffff', symbolColor: '#5f5d58', height: 46 };
}

function showWindow() {
  if (!port) return;
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  const b = loadBounds();
  win = new BrowserWindow({
    width: b.width, height: b.height, x: b.x, y: b.y,
    minWidth: 760, minHeight: 500,
    show: false,
    title: 'Local Notes',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#191918' : '#ffffff',
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 18, y: 16 },
    titleBarOverlay: IS_MAC ? undefined : overlayColors(nativeTheme.shouldUseDarkColors),
    icon: path.join(ROOT, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  if (b.maximized) win.maximize();
  win.loadURL(`http://localhost:${port}/`);
  win.once('ready-to-show', () => win.show());
  win.on('close', (e) => {
    saveBounds();
    if (host.shouldHideInsteadOfClose()) { e.preventDefault(); win.hide(); }
  });
  win.on('closed', () => { win = null; });

  const own = (url) => url.startsWith(`http://localhost:${port}/`);
  // links open in the system browser; the app itself never navigates away
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!own(url)) { e.preventDefault(); if (/^(https?|mailto):/i.test(url)) shell.openExternal(url); }
  });

  // right-click: spelling suggestions + clipboard actions
  win.webContents.on('context-menu', (_e, p) => {
    const items = [];
    for (const s of p.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => win.webContents.replaceMisspelling(s) });
    if (p.misspelledWord) {
      items.push({ label: 'Add to dictionary', click: () => win.webContents.session.addWordToSpellCheckerDictionary(p.misspelledWord) });
      items.push({ type: 'separator' });
    }
    if (p.isEditable) items.push({ role: 'cut', enabled: p.editFlags.canCut }, { role: 'copy', enabled: p.editFlags.canCopy }, { role: 'paste', enabled: p.editFlags.canPaste }, { role: 'selectAll' });
    else if (p.selectionText) items.push({ role: 'copy' });
    if (p.linkURL && /^https?:/.test(p.linkURL)) items.push({ type: 'separator' }, { label: 'Copy link address', click: () => require('electron').clipboard.writeText(p.linkURL) });
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
}

function buildMenu() {
  if (!IS_MAC) { Menu.setApplicationMenu(null); return; }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'Local Notes on GitHub', click: () => shell.openExternal('https://github.com/harshid-lgtm/local-notes') }] },
  ]));
}

function setupUpdater() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch { return; }
  autoUpdater.autoDownload = true;
  autoUpdater.on('update-downloaded', (info) => win?.webContents.send('update-ready', { version: info.version }));
  autoUpdater.on('error', () => { /* offline or no release yet: stay quiet */ });
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
  ipcMain.on('install-update', async () => { await flushPage(); if (stateTimer) writeState(); autoUpdater.quitAndInstall(); });
}

ipcMain.handle('pick-folder', async (_e, opts = {}) => {
  const r = await dialog.showOpenDialog(win, {
    title: opts.title || 'Choose a vault folder',
    buttonLabel: opts.button || 'Open vault',
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});
// ---------------------------------------------------------------- UI settings file
const stateFile = () => path.join(app.getPath('userData'), 'ui-state.json');
let stateCache = null;
let stateTimer = null;
function writeState() {
  clearTimeout(stateTimer);
  stateTimer = null;
  try {
    const tmp = stateFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(stateCache || {}));
    fs.renameSync(tmp, stateFile());
  } catch { /* read-only profile */ }
}
ipcMain.on('state:load', (e) => {
  if (!stateCache) { try { stateCache = JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { stateCache = {}; } }
  e.returnValue = stateCache;
});
ipcMain.on('state:save', (_e, data) => {
  if (!data || typeof data !== 'object') return;
  stateCache = data;
  if (!stateTimer) stateTimer = setTimeout(writeState, 400);
});

// Ask the page to save unsaved work, then continue (at most a few seconds).
function flushPage() {
  if (!win || win.isDestroyed()) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 4000);
    ipcMain.once('flush-done', () => { clearTimeout(t); resolve(); });
    win.webContents.send('flush-request');
  });
}

// ---------------------------------------------------------------- export & print
const FILTERS = {
  pdf: ['PDF document', ['pdf']], docx: ['Word document', ['docx']], html: ['Web page', ['html', 'htm']],
  md: ['Markdown', ['md']], txt: ['Plain text', ['txt']],
};
async function askSavePath(name, ext) {
  const [label, exts] = FILTERS[ext] || ['File', [ext]];
  const r = await dialog.showSaveDialog(win, {
    title: 'Export',
    defaultPath: path.join(app.getPath('documents'), name),
    filters: [{ name: label, extensions: exts }],
  });
  return r.canceled ? null : r.filePath;
}
// Pick files to open/import (any local, network or synced cloud drive).
ipcMain.handle('open-files', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Open or import files',
    buttonLabel: 'Open',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Documents', extensions: ['md', 'markdown', 'txt', 'docx', 'pdf', 'html', 'htm', 'xlsx', 'csv', 'tsv', 'pptx', 'odt', 'rtf', 'json'] },
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (r.canceled) return [];
  return r.filePaths.filter((p) => fs.statSync(p).size <= 100 * 1024 * 1024).map((p) => ({ name: path.basename(p), path: p, data: fs.readFileSync(p) }));
});
ipcMain.handle('save-file', async (_e, { name, ext, data } = {}) => {
  const target = await askSavePath(String(name || 'Untitled'), String(ext || 'txt'));
  if (!target) return null;
  fs.writeFileSync(target, Buffer.from(data));
  return target;
});
// Render exported HTML in a hidden window with scripts off.
async function withHtmlWindow(html, fn) {
  const tmp = path.join(app.getPath('temp'), `local-notes-export-${Date.now()}.html`);
  fs.writeFileSync(tmp, html);
  const w = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true } });
  try {
    await w.loadFile(tmp);
    return await fn(w);
  } finally {
    if (!w.isDestroyed()) w.destroy();
    fs.rmSync(tmp, { force: true });
  }
}
ipcMain.handle('export-pdf', async (_e, { html, name } = {}) => {
  const pdf = await withHtmlWindow(String(html || ''), (w) => w.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { marginType: 'default' } }));
  const target = await askSavePath(String(name || 'Untitled.pdf'), 'pdf');
  if (!target) return null;
  fs.writeFileSync(target, pdf);
  return target;
});
ipcMain.handle('print-html', (_e, html) => withHtmlWindow(String(html || ''), (w) => new Promise((resolve) => {
  w.webContents.print({ printBackground: true }, (ok) => resolve(ok));
})));

ipcMain.handle('app-info', () => ({ version: app.getVersion(), platform: process.platform }));
ipcMain.on('set-theme', (_e, { dark }) => {
  if (win && !IS_MAC) { try { win.setTitleBarOverlay(overlayColors(dark)); } catch { /* unsupported */ } }
  if (win) win.setBackgroundColor(dark ? '#191918' : '#ffffff');
});
ipcMain.on('reveal', (_e, p) => { if (typeof p === 'string' && fs.existsSync(p)) shell.showItemInFolder(p); });

// hosting a team server on this computer
ipcMain.handle('host:status', () => host.status());
ipcMain.handle('host:start', (_e, opts = {}) => host.start(opts.port));
ipcMain.handle('host:stop', () => host.stop());
ipcMain.handle('host:open-at-login', (_e, on) => host.setOpenAtLogin(on));
ipcMain.on('host:open-data', () => { const d = host.status().dataDir; fs.mkdirSync(d, { recursive: true }); shell.openPath(d); });

app.whenReady().then(async () => {
  const { server } = createVaultServer({ configDir: app.getPath('userData'), publicDir: path.join(ROOT, 'public') });
  // Keep the same local port between launches so the page's origin (and anything the
  // browser engine stores for it) stays the same; fall back to any free port.
  const portFile = path.join(app.getPath('userData'), 'port.json');
  let preferred = 0;
  try { preferred = Number(JSON.parse(fs.readFileSync(portFile, 'utf8')).port) || 0; } catch { /* first run */ }
  const listen = (p) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(p, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  try { await listen(preferred || 47321); } catch { await listen(0); }
  port = server.address().port;
  try { fs.writeFileSync(portFile, JSON.stringify({ port })); } catch { /* read-only profile */ }
  buildMenu();
  host.init({ notify: (s) => { if (win && !win.isDestroyed()) win.webContents.send('host-changed', s); }, show: showWindow });
  // started with the computer to host the team server: stay in the tray until opened
  if (!host.startedHidden()) createWindow();
  setupUpdater();
  app.on('activate', () => showWindow());
});

app.on('will-quit', () => { if (stateTimer) writeState(); });

app.on('window-all-closed', () => { if (!IS_MAC && !host.isHosting()) app.quit(); });
