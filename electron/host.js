// "Host a team server on this computer": runs the bundled team server in a background
// Electron utility process, keeps it running in the tray, and can start it with the computer.
'use strict';

const { app, utilityProcess, Tray, Menu, nativeImage, clipboard, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const DEFAULT_PORT = 3000;
const VIRTUAL = /^(vEthernet|vmnet|VMware|VirtualBox|docker|br-|veth|virbr|tailscale|utun|zt|Hyper-V|WSL|lxc|lxd|podman)|Virtual|Loopback|Pseudo/i;

const settingsFile = () => path.join(app.getPath('userData'), 'team-host.json');
const dataDir = () => path.join(app.getPath('userData'), 'team-server');
// The bundle and web app are unpacked from the app archive (asarUnpack) so the server reads them as normal files.
const unpacked = (p) => p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const bundlePath = () => unpacked(path.join(ROOT, 'team-bundle', 'server.mjs'));

let settings = { enabled: false, port: DEFAULT_PORT, openAtLogin: false }; // loaded in init(), once the profile folder is known
let child = null;
let state = { running: false, starting: false, error: null, port: DEFAULT_PORT };
let tray = null;
let onChange = () => {};
let showWindow = () => {};
let quitting = false;
let toldAboutTray = false;
let stopping = false;
let crashes = 0;

function load() {
  try { return { enabled: false, port: DEFAULT_PORT, openAtLogin: false, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch { return { enabled: false, port: DEFAULT_PORT, openAtLogin: false }; }
}
function save() {
  try { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch { /* read-only profile */ }
}

function addresses(port) {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL.test(name)) continue; // WSL, Hyper-V, Docker, VPN tunnels: not reachable by teammates
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(`http://${a.address}:${port}`);
  }
  return out.sort((a, b) => (/\/\/(192\.168|10\.)/.test(b) ? 1 : 0) - (/\/\/(192\.168|10\.)/.test(a) ? 1 : 0));
}

function status() {
  return {
    ...state,
    enabled: settings.enabled,
    port: state.running ? state.port : settings.port,
    openAtLogin: settings.openAtLogin,
    addresses: state.running ? addresses(state.port) : [],
    localUrl: state.running ? `http://localhost:${state.port}` : null,
    dataDir: dataDir(),
    computerName: os.hostname(),
  };
}

function changed() {
  updateTray();
  onChange(status());
}

function start(port = settings.port) {
  port = Math.max(1, Math.min(65535, Number(port) || DEFAULT_PORT));
  if (child) return Promise.resolve(status());
  settings = { ...settings, port, enabled: true };
  save();
  state = { running: false, starting: true, error: null, port };
  changed();
  return new Promise((resolve) => {
    let log = '';
    child = utilityProcess.fork(bundlePath(), [], {
      serviceName: 'Local Notes team server',
      stdio: 'pipe',
      env: {
        ...process.env,
        PORT: String(port),
        HOST: process.env.LOCAL_NOTES_HOST_BIND || '0.0.0.0', // tests bind to localhost only
        DATA_DIR: dataDir(),
        PUBLIC_DIR: unpacked(path.join(ROOT, 'public')),
        LN_VERSION: app.getVersion(),
        TEAM_NAME: os.hostname(),
      },
    });
    child.stdout?.on('data', (d) => { log = (log + d).slice(-4000); });
    child.stderr?.on('data', (d) => { log = (log + d).slice(-4000); });
    const done = () => { resolve(status()); };
    child.on('message', (m) => {
      if (m?.type === 'ready') { crashes = 0; state = { running: true, starting: false, error: null, port }; changed(); done(); }
      if (m?.type === 'error') { state = { ...state, starting: false, error: m.message }; }
    });
    child.on('exit', (code) => {
      const wasRunning = state.running;
      child = null;
      if (quitting || stopping) { state = { running: false, starting: false, error: null, port }; changed(); return done(); }
      const reason = state.error || log.trim().split('\n').pop() || `The team server stopped (code ${code}).`;
      if (!wasRunning) {
        // never started (port in use, etc.): switch hosting off and show why
        settings.enabled = false; save();
        state = { running: false, starting: false, error: reason, port };
        changed();
        return done();
      }
      // stopped unexpectedly while running: restart it, a few times at most
      crashes += 1;
      state = { running: false, starting: false, error: reason, port };
      changed();
      if (crashes <= 3) setTimeout(() => { if (!child && settings.enabled && !quitting) start(port); }, 2000);
      else if (Notification.isSupported()) new Notification({ title: 'Team server stopped', body: reason }).show();
      done();
    });
  });
}

function stop({ keepEnabled = false } = {}) {
  if (!keepEnabled) { settings.enabled = false; save(); }
  if (!child) { state = { ...state, running: false, starting: false }; changed(); return Promise.resolve(status()); }
  stopping = true;
  return new Promise((resolve) => {
    child.once('exit', () => { stopping = false; resolve(status()); });
    child.kill();
  });
}

function setOpenAtLogin(on) {
  settings.openAtLogin = !!on;
  save();
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!on, openAsHidden: true, args: ['--hidden'] });
  changed();
  return status();
}

// ---------------------------------------------------------------- tray
function trayIcon() {
  const img = nativeImage.createFromPath(path.join(ROOT, 'build', 'icon.png'));
  return img.isEmpty() ? img : img.resize({ width: process.platform === 'darwin' ? 18 : 16, height: process.platform === 'darwin' ? 18 : 16 });
}

function updateTray() {
  if (!state.running && !state.starting) { tray?.destroy(); tray = null; return; }
  if (!tray) {
    tray = new Tray(trayIcon());
    tray.on('click', () => showWindow());
  }
  const addr = addresses(state.port)[0] || `http://localhost:${state.port}`;
  tray.setToolTip(state.running ? `Local Notes: hosting your team server at ${addr}` : 'Local Notes: starting team server…');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Local Notes', click: () => showWindow() },
    { type: 'separator' },
    { label: state.running ? `Team server running · ${addr.replace(/^https?:\/\//, '')}` : 'Team server starting…', enabled: false },
    { label: 'Copy address for teammates', enabled: state.running, click: () => clipboard.writeText(addr) },
    { label: 'Open data folder', click: () => { fs.mkdirSync(dataDir(), { recursive: true }); shell.openPath(dataDir()); } },
    { type: 'separator' },
    { label: 'Stop hosting', click: () => stop() },
    { label: 'Quit Local Notes', click: () => { quitting = true; app.quit(); } },
  ]));
}

// When the window closes while hosting, keep running in the tray (Windows/Linux).
function shouldHideInsteadOfClose() {
  if (quitting || process.platform === 'darwin' || !(state.running || state.starting)) return false;
  if (!toldAboutTray && Notification.isSupported()) {
    toldAboutTray = true;
    new Notification({ title: 'Local Notes is still running', body: 'Your team server keeps running so teammates stay connected. Use the tray icon to open Local Notes or stop hosting.' }).show();
  }
  return true;
}

function init({ notify, show }) {
  settings = load();
  state.port = settings.port;
  onChange = notify;
  showWindow = show;
  app.on('before-quit', () => { quitting = true; if (child) child.kill(); });
  if (settings.enabled) start(settings.port);
}

module.exports = { init, start, stop, status, setOpenAtLogin, shouldHideInsteadOfClose, isHosting: () => !!child, startedHidden: () => process.argv.includes('--hidden') && load().enabled };
