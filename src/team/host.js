// Desktop only: "Host a team server on this computer".
import { icon } from '../icons.js';
import { $, h, esc, openModal, toast, copyText } from '../ui.js';

export const canHost = () => !!window.desktop?.host;

let listening = false;

export async function openHostDialog({ openTeam }) {
  if (!canHost()) return;
  const box = h('<div class="host"></div>');
  const m = openModal(box, { className: 'host-modal' });
  let s = await window.desktop.host.status();
  let showPort = false;
  const isWin = window.desktop.platform === 'win32';

  const render = () => {
    const live = s.running;
    box.innerHTML = `
      <div class="share-head"><div><h2>Host a team server</h2><p>Let teammates on your network share notes through this computer.</p></div>
        <button class="icon-btn" data-close>${icon('x', 18)}</button></div>
      <div class="host-body">
        <div class="host-status ${live ? 'on' : s.starting ? 'wait' : s.error ? 'bad' : ''}">
          <span class="host-dot"></span>
          <div><strong>${live ? 'Running on this computer' : s.starting ? 'Starting…' : s.error ? 'Couldn’t start' : 'Not running'}</strong>
            <span>${live ? `Teammates connect with the address below. ${esc(s.computerName)} needs to stay on.` : s.error ? esc(s.error) : 'Turn it on to create a shared space for your team, no IT setup needed.'}</span></div>
        </div>
        ${live ? `
          <div class="pk-label">Address for teammates</div>
          ${s.addresses.length ? s.addresses.map((a, i) => `<div class="host-addr ${i ? 'alt' : ''}"><code>${esc(a)}</code><button class="btn ${i ? 'ghost' : 'primary'} small" data-copy="${esc(a)}">${icon('copy', 15)}<span>Copy</span></button></div>`).join('')
            : `<p class="host-note">${icon('warning', 14)}<span>This computer isn’t connected to a network, so only you can use it for now.</span></p>`}
          <p class="host-note">${icon('info', 14)}<span>In the Local Notes app they choose <b>Connect to a team server</b> and paste this address, or open it in a web browser.</span></p>
          <div class="host-actions">
            <button class="btn primary" data-open-team>${icon('library', 16)}<span>Open the team workspace</span></button>
          </div>
          <label class="host-toggle"><input type="checkbox" data-login ${s.openAtLogin ? 'checked' : ''}><span><strong>Start when this computer starts</strong><em>Runs quietly in the ${window.desktop.platform === 'darwin' ? 'menu bar' : 'system tray'} so the team can always connect.</em></span></label>
          <div class="host-foot">
            <button class="link-btn" data-data>${icon('folder-open', 14)}Open data folder</button>
            <button class="btn ghost small danger-text" data-stop>Stop hosting</button>
          </div>`
        : `
          <ul class="host-points">
            <li>${icon('users', 16)}<span>Everyone on the same office network or VPN can join. You’ll create the admin account and invite people.</span></li>
            <li>${icon('drive', 16)}<span>Team notes are stored on this computer. Back up its data folder like any important files.</span></li>
            <li>${icon('clock', 16)}<span>Keep this computer on during working hours. Closing the window keeps the server running in the ${window.desktop.platform === 'darwin' ? 'menu bar' : 'tray'}.</span></li>
          </ul>
          ${showPort || s.error ? `<label class="field host-port"><span>Port</span><input name="port" type="number" min="1024" max="65535" value="${esc(s.port)}"><em>Use another number, like 3001, if something else already uses ${esc(s.port)}.</em></label>`
            : `<button class="link-btn small host-port-link" data-port>Port ${esc(s.port)} · change</button>`}
          ${isWin ? `<p class="host-note">${icon('info', 14)}<span>Windows may ask whether Local Notes can use the network. Choose <b>Allow</b> (private networks) so teammates can connect.</span></p>` : ''}
          <div class="host-actions"><button class="btn primary large" data-start ${s.starting ? 'disabled' : ''}>${icon('drive', 17)}<span>${s.starting ? 'Starting…' : 'Start hosting'}</span></button></div>`}
      </div>`;
  };
  render();

  if (!listening) {
    listening = true;
    window.desktop.host.onChange((next) => document.dispatchEvent(new CustomEvent('ln-host', { detail: next })));
  }
  const onHost = (e) => { s = e.detail; if (box.isConnected) render(); };
  document.addEventListener('ln-host', onHost);
  const close = () => { document.removeEventListener('ln-host', onHost); m.close(); };

  box.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) return close();
    if (e.target.closest('[data-port]')) { showPort = true; render(); $('[name=port]', box)?.focus(); return; }
    const cp = e.target.closest('[data-copy]');
    if (cp) { const ok = await copyText(cp.dataset.copy); toast(ok ? 'Address copied' : 'Couldn’t copy', { kind: ok ? 'success' : 'error' }); return; }
    if (e.target.closest('[data-data]')) return window.desktop.host.openDataFolder();
    if (e.target.closest('[data-open-team]')) { close(); return openTeam({ url: s.localUrl }); }
    if (e.target.closest('[data-stop]')) {
      s = await window.desktop.host.stop();
      render();
      toast('Team server stopped. Teammates can’t connect until you start it again.');
      return;
    }
    if (e.target.closest('[data-start]')) {
      const port = Number($('[name=port]', box)?.value || s.port);
      s = { ...s, starting: true, error: null };
      render();
      s = await window.desktop.host.start(port);
      render();
      if (s.running) toast('Your team server is running', { kind: 'success' });
    }
  });
  box.addEventListener('change', async (e) => {
    if (e.target.closest('[data-login]')) s = await window.desktop.host.setOpenAtLogin(e.target.checked);
  });
}
