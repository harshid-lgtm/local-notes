// Team mode: shared workspaces on a Local Notes team server, with a private space per
// person, live co-editing, comments with @mentions, version history and an inbox.
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { ySyncPluginKey } from 'y-prosemirror';
import MarkdownIt from 'markdown-it';
import { createEditor, host, getMarkdown } from '../editor.js';
import { icon, logo } from '../icons.js';
import { $, h, esc, showMenu, openModal, confirmDialog, toast, store, timeAgo, modKey, copyText } from '../ui.js';
import { mountGraph, setFolders, folderColor } from '../graph.js';
import { formatButtons, runFormat, syncFormat } from '../format.js';
import { openFindBar, closeFindBar } from '../find.js';
import { exportMenuItems, printPage } from '../export.js';
import { convertFile, linkImages, IMPORT_ACCEPT } from '../importer.js';
import { teamClient, normalizeUrl, saveTeam, forgetTeam, savedTeams } from './client.js';
import { setAITransport, resetAITransport, setAIHooks, forgetAIStatus, openAIMenu, openWritePanel, summarizePage, toggleAskPanel, openAISettings, closeAskPanel } from '../ai/ai.js';

let T = null; // the running team session
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
const initials = (name) => (name || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const avatar = (u, size = 24) => `<span class="avatar" style="--c:${esc(u?.color || '#999')};--s:${size}px" title="${esc(u?.name || '')}">${esc(initials(u?.name))}</span>`;
const ROLE_LABEL = { owner: 'Owner', editor: 'Can edit', viewer: 'Can view' };

// ================================================================== sign in
export async function showTeamSignIn({ hosted = false, url = '', invite = null, onBack = null, passwordToken = null, joinToken = null } = {}) {
  const root = mountRoot();
  if (passwordToken) return showPasswordLink({ root, hosted, url, token: passwordToken, onBack });
  let info = null;
  let mode = 'login';
  const serverUrl = () => (hosted ? location.origin : normalizeUrl($('[name=server]', root)?.value || url));

  async function loadInfo() {
    info = null;
    const base = serverUrl();
    if (!base) return render();
    try {
      info = await teamClient({ url: base }).get('/api/team/info');
      if (!info.hasUsers) return showSetup({ root, hosted, base, onBack });
      if (invite) {
        try { info.invite = await teamClient({ url: base }).get(`/api/invites/${invite}`); mode = 'signup'; } catch (e) { info.inviteError = e.message; }
      }
      if (joinToken) {
        try { info.join = await teamClient({ url: base }).get(`/api/page-invites/${joinToken}`); mode = info.join.hasAccount ? 'login' : 'signup'; } catch (e) { info.inviteError = e.message; }
      }
    } catch (e) {
      info = { error: hosted ? e.message : 'Can’t reach a Local Notes team server at that address.' };
    }
    render();
  }

  function render() {
    // keep whatever the person already typed across re-renders
    const kept = Object.fromEntries([...root.querySelectorAll('.auth-form input')].map((i) => [i.name, i.value]));
    if (kept.server !== undefined) url = kept.server;
    const first = info && !info.error && !info.hasUsers;
    const title = first ? 'Set up your team' : mode === 'signup' ? 'Create your account' : 'Welcome back';
    const sub = first ? 'You’re the first person here — your account will be the admin.'
      : info?.join ? `${esc(info.join.invitedBy)} invited you to <b>${esc(info.join.pageTitle)}</b> in ${esc(info.join.team)}. ${info.join.hasAccount ? 'Sign in to open it.' : 'Create your account to open it.'}`
      : info?.invite ? `${esc(info.invite.invitedBy || 'A teammate')} invited you to <b>${esc(info.invite.workspace)}</b>.`
        : info?.name ? `Sign in to <b>${esc(info.name)}</b> on Local Notes.` : 'Connect to your team’s Local Notes server.';
    root.innerHTML = `
      <div class="wl-bg" aria-hidden="true"><div class="wl-glow"></div><div class="wl-grid"></div></div>
      <div class="auth">
        ${onBack ? `<button class="auth-back btn ghost small">${icon('arrow-right', 15)}<span>Back to local notes</span></button>` : ''}
        <div class="auth-card pop">
          <div class="auth-logo">${logo(48)}</div>
          <h1>${title}</h1>
          <p class="auth-sub">${sub}</p>
          ${info?.inviteError ? `<div class="auth-error">${esc(info.inviteError)}</div>` : ''}
          <form class="auth-form" novalidate>
            ${hosted ? '' : `<label class="field"><span>Server address</span><input name="server" placeholder="notes.yourcompany.com" value="${esc(url)}" spellcheck="false" autocomplete="url"></label>`}
            ${info?.error ? `<div class="auth-error">${esc(info.error)}</div>` : ''}
            ${mode === 'signup' ? '<label class="field"><span>Your name</span><input name="name" autocomplete="name" placeholder="Maya Chen"></label>' : ''}
            <label class="field"><span>Email</span><input name="email" type="email" autocomplete="email" placeholder="you@company.com" ${info?.join ? `value="${esc(info.join.email)}" readonly` : ''}></label>
            <label class="field"><span>Password</span><input name="password" type="password" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}" placeholder="${mode === 'signup' ? 'At least 8 characters' : ''}"></label>
            <button class="btn primary large auth-submit" type="submit">${mode === 'signup' ? (first ? 'Create admin account' : 'Create account') : 'Sign in'}</button>
          </form>
          ${first ? '' : `<div class="auth-switch">${mode === 'signup' ? 'Already have an account?' : 'New here?'} <button class="link-btn" data-mode>${mode === 'signup' ? 'Sign in' : 'Create an account'}</button></div>`}
          ${mode === 'login' && info && !info.error ? '<div class="auth-switch subtle"><button class="link-btn" data-forgot>Forgot your password?</button></div>' : ''}
        </div>
        <p class="auth-foot">${icon('info', 14)}<span>Your private space is only visible to you. Team workspaces are shared with the people you invite.</span></p>
      </div>`;
    for (const [k, v] of Object.entries(kept)) { const i = $(`.auth-form [name=${k}]`, root); if (i && k !== 'server' && !i.readOnly) i.value = v; }
    $('[data-mode]', root)?.addEventListener('click', () => { mode = mode === 'signup' ? 'login' : 'signup'; render(); });
    $('.auth-back', root)?.addEventListener('click', () => { root.remove(); onBack(); });
    $('[data-forgot]', root)?.addEventListener('click', () => toast('Ask an admin of this server to send you a password reset link (Server admin → People).', { timeout: 9000 }));
    const srv = $('[name=server]', root);
    srv?.addEventListener('change', () => { url = srv.value; loadInfo(); });
    $('.auth-form', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const base = serverUrl();
      if (!base) { srv?.focus(); return; }
      const btn = $('.auth-submit', root);
      btn.disabled = true;
      try {
        const api = teamClient({ url: base });
        const r = await api.post(mode === 'signup' ? '/api/auth/signup' : '/api/auth/login', { ...f, ...(info?.join ? { email: info.join.email } : {}), invite, pageInvite: joinToken || undefined });
        const conn = { url: base, token: r.token, user: r.user };
        saveTeam(conn);
        if (invite && hosted) history.replaceState(null, '', '#');
        if (joinToken && hosted) history.replaceState(null, '', r.openPage ? `#/p/${r.openPage}` : '#');
        root.remove();
        await startTeam(conn, { hosted, onExit: onBack });
      } catch (err) {
        toast(err.message, { kind: 'error' });
        btn.disabled = false;
      }
    });
    setTimeout(() => (srv && !srv.value ? srv : [...root.querySelectorAll('.auth-form input:not([name=server])')].find((i) => !i.value))?.focus(), 30);
  }
  render();
  if (hosted || url) loadInfo();
}

const authShell = (inner, { onBack } = {}) => `
  <div class="wl-bg" aria-hidden="true"><div class="wl-glow"></div><div class="wl-grid"></div></div>
  <div class="auth">
    ${onBack ? `<button class="auth-back btn ghost small">${icon('arrow-right', 15)}<span>Back to local notes</span></button>` : ''}
    <div class="auth-card pop">${inner}</div>
  </div>`;

// First run on a new server: name the team, create the admin account, choose who can join.
function showSetup({ root, hosted, base, onBack }) {
  const v = { teamName: '', name: '', email: '', password: '', signup: 'invite' };
  let step = 0;
  const steps = ['Team', 'Admin', 'Access'];
  const render = () => {
    root.innerHTML = authShell(`
      <div class="auth-logo">${logo(48)}</div>
      <h1>Set up your team server</h1>
      <p class="auth-sub">${hosted ? '' : `<b>${esc(base.replace(/^https?:\/\//, ''))}</b> · `}Three quick steps. You can change all of this later.</p>
      <ol class="setup-steps">${steps.map((t, i) => `<li class="${i < step ? 'done' : i === step ? 'on' : ''}"><i>${i < step ? icon('check', 12, 2.6) : i + 1}</i><span>${t}</span></li>`).join('')}</ol>
      <form class="auth-form setup-form" novalidate>
        ${step === 0 ? `<label class="field"><span>Team or company name</span><input name="teamName" placeholder="Navgold, Acme Design, Marketing…" value="${esc(v.teamName)}"></label>
          <p class="setup-hint">This becomes your first shared workspace. People see it when they sign in.</p>` : ''}
        ${step === 1 ? `<label class="field"><span>Your name</span><input name="name" autocomplete="name" placeholder="Maya Chen" value="${esc(v.name)}"></label>
          <label class="field"><span>Email</span><input name="email" type="email" autocomplete="email" placeholder="you@company.com" value="${esc(v.email)}"></label>
          <label class="field"><span>Password</span><input name="password" type="password" autocomplete="new-password" placeholder="At least 8 characters" value="${esc(v.password)}"></label>
          <p class="setup-hint">${icon('lock', 13)}This is the server admin account. Admins add people, reset passwords and choose settings.</p>` : ''}
        ${step === 2 ? `<div class="choice-list">
            <label class="choice ${v.signup === 'invite' ? 'on' : ''}"><input type="radio" name="signup" value="invite" ${v.signup === 'invite' ? 'checked' : ''}>
              <span class="choice-ic">${icon('lock', 18)}</span><span><strong>Only people I invite</strong><em>You add people or send them invite links. Recommended.</em></span></label>
            <label class="choice ${v.signup === 'open' ? 'on' : ''}"><input type="radio" name="signup" value="open" ${v.signup === 'open' ? 'checked' : ''}>
              <span class="choice-ic">${icon('users', 18)}</span><span><strong>Anyone who can reach this server</strong><em>Fine on a private office network. Each person still only sees workspaces they’re added to.</em></span></label>
          </div>` : ''}
        <div class="setup-nav">
          ${step ? '<button type="button" class="btn ghost" data-prev>Back</button>' : '<span></span>'}
          <button class="btn primary large auth-submit" type="submit">${step < 2 ? 'Continue' : 'Finish setup'}</button>
        </div>
      </form>`, { onBack });
    $('.auth-back', root)?.addEventListener('click', () => { root.remove(); onBack(); });
    const form = $('.setup-form', root);
    const keep = () => { for (const [k, val] of new FormData(form)) v[k] = String(val); };
    form.addEventListener('change', () => { keep(); if (step === 2) render(); });
    $('[data-prev]', root)?.addEventListener('click', () => { keep(); step--; render(); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      keep();
      if (step === 0 && !v.teamName.trim()) return toast('Give your team a name', { kind: 'error' });
      if (step === 1) {
        if (!v.name.trim()) return toast('Enter your name', { kind: 'error' });
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email.trim())) return toast('Enter a valid email address', { kind: 'error' });
        if (v.password.length < 8) return toast('Use at least 8 characters for your password', { kind: 'error' });
      }
      if (step < 2) { step++; return render(); }
      const btn = $('.auth-submit', root);
      btn.disabled = true;
      try {
        const r = await teamClient({ url: base }).post('/api/setup', v);
        const conn = { url: base, token: r.token, user: r.user };
        saveTeam(conn);
        root.remove();
        await startTeam(conn, { hosted, onExit: onBack });
        adminConsole('people', { welcome: true });
      } catch (err) { toast(err.message, { kind: 'error' }); btn.disabled = false; }
    });
    setTimeout(() => [...root.querySelectorAll('.setup-form input:not([type=radio])')].find((i) => !i.value)?.focus(), 30);
  };
  render();
}

// "Choose a password" from a link an admin sent (new account or password reset).
async function showPasswordLink({ root, hosted, url, token, onBack }) {
  const base = hosted ? location.origin : normalizeUrl(url);
  const api = teamClient({ url: base });
  let link;
  try { link = await api.get(`/api/auth/password-link/${token}`); } catch (e) { link = { error: e.message }; }
  root.innerHTML = authShell(`
    <div class="auth-logo">${logo(48)}</div>
    ${link.error ? `<h1>Link expired</h1><p class="auth-sub">${esc(link.error)}</p>
      <button class="btn primary large auth-submit" data-signin>Go to sign in</button>`
      : `<h1>${link.kind === 'welcome' ? `Welcome, ${esc(link.name.split(' ')[0])}` : 'Choose a new password'}</h1>
      <p class="auth-sub">${link.kind === 'welcome' ? `You’ve been added to <b>${esc(link.team)}</b> on Local Notes. Choose a password to get started.` : `For <b>${esc(link.email)}</b> on ${esc(link.team)}.`}</p>
      <form class="auth-form" novalidate>
        <label class="field"><span>Email</span><input value="${esc(link.email)}" disabled></label>
        <label class="field"><span>New password</span><input name="password" type="password" autocomplete="new-password" placeholder="At least 8 characters"></label>
        <label class="field"><span>Type it again</span><input name="again" type="password" autocomplete="new-password"></label>
        <button class="btn primary large auth-submit" type="submit">${link.kind === 'welcome' ? 'Join' : 'Save password'}</button>
      </form>`}`, { onBack });
  $('.auth-back', root)?.addEventListener('click', () => { root.remove(); onBack(); });
  const toSignIn = () => { history.replaceState(null, '', '#'); showTeamSignIn({ hosted, url: base, onBack }); };
  $('[data-signin]', root)?.addEventListener('click', toSignIn);
  $('.auth-form', root)?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (f.password.length < 8) return toast('Use at least 8 characters', { kind: 'error' });
    if (f.password !== f.again) return toast('The passwords don’t match', { kind: 'error' });
    const btn = $('.auth-submit', root);
    btn.disabled = true;
    try {
      const r = await api.post(`/api/auth/password-link/${token}`, { password: f.password });
      const conn = { url: base, token: r.token, user: r.user };
      saveTeam(conn);
      history.replaceState(null, '', '#');
      root.remove();
      await startTeam(conn, { hosted, onExit: onBack });
      toast(link.kind === 'welcome' ? 'Welcome to Local Notes' : 'Password saved', { kind: 'success' });
    } catch (err) { toast(err.message, { kind: 'error' }); btn.disabled = false; }
  });
  setTimeout(() => $('.auth-form [name=password]', root)?.focus(), 30);
}

function mountRoot() {
  $('#team-root')?.remove();
  const root = h('<div id="team-root" class="team-root"></div>');
  document.body.append(root);
  $('#shell').hidden = true;
  $('#welcome').hidden = true;
  return root;
}

// ================================================================== session
export async function startTeam(conn, { hosted = false, onExit = null } = {}) {
  const api = teamClient(conn, { onAuthLost: () => signOut(true) });
  let me;
  try {
    me = await api.get('/api/me');
  } catch (e) {
    if (e.status === 401) { forgetTeam(conn.url); return showTeamSignIn({ hosted, url: conn.url, onBack: onExit }); }
    if (!hosted) toast(e.message, { kind: 'error' });
    return showTeamSignIn({ hosted, url: conn.url, onBack: onExit });
  }
  const root = mountRoot();
  T = {
    conn, api, hosted, onExit, root,
    me: me.user, workspaces: me.workspaces, unread: me.unread, addresses: me.server?.addresses || [],
    pages: new Map(), roles: new Map(), people: new Map(),
    expanded: new Set(store.get(`ln:team:${conn.url}:expanded`, [])),
    collapsedWs: new Set(store.get(`ln:team:${conn.url}:collapsed`, [])),
    current: null, drawer: null, graph: null,
  };
  saveTeam({ ...conn, user: me.user });
  installHost();
  setAITransport({
    base: T.api.base,
    headers: () => ({ Authorization: `Bearer ${T.conn.token}` }),
    canConfigure: !!T.me.isAdmin,
    label: 'your team server',
    statusPath: T.me.isAdmin ? '/api/ai/settings' : '/api/ai/status',
  });
  forgetAIStatus();
  setAIHooks({
    openLink: (l) => host.openLink(l),
    vaultName: () => 'your workspaces',
    currentPage: () => (T?.current ? { id: T.current.page.id, title: T.current.page.title } : null),
  });
  host.aiWrite = () => T?.current && openWritePanel(T.current.editor);
  buildShell();
  await Promise.all([...T.workspaces.map((w) => loadPages(w.id)), loadShared()]);
  renderSidebar();
  listen();
  const route = location.hash.match(/^#\/p\/([\w-]+)/);
  const last = store.get(`ln:team:${conn.url}:last`, null);
  const start = route?.[1] || last;
  if (start && findPage(start)) await openPage(start, { replace: true });
  else showHome();
}

export function stopTeam() {
  if (!T) return;
  closePage();
  closeAskPanel();
  resetAITransport();
  forgetAIStatus();
  document.removeEventListener('keydown', T.keyHandler);
  T.events?.close();
  T.graph?.destroy();
  T.root.remove();
  restoreHost();
  T = null;
}

async function signOut(expired = false) {
  if (!T) return;
  const { conn, hosted, onExit } = T;
  if (!expired) { try { await T.api.post('/api/auth/logout'); } catch { /* already gone */ } }
  forgetTeam(conn.url);
  stopTeam();
  if (expired) toast('Your session ended. Please sign in again.');
  showTeamSignIn({ hosted, url: conn.url, onBack: onExit });
}

// wikilinks inside team pages resolve against the current workspace
let savedHost = null;
function installHost() {
  savedHost = { ...host };
  host.resolveNote = (target) => pageByTitle(target)?.id || null;
  host.resolveAsset = () => null;
  host.noteSuggestions = (q) => {
    const ws = T.current?.page.workspaceId;
    const list = (T.pages.get(ws) || []).filter((p) => p.title.toLowerCase().includes(q.trim().toLowerCase()));
    return list.slice(0, 8).map((p) => ({ name: p.title, path: p.id, folder: findPage(p.parentId)?.title || '' }));
  };
  host.openLink = async (href) => {
    if (href && typeof href === 'object') {
      const target = href.wikilink.split('|')[0].split('#')[0].split('/').pop();
      const p = pageByTitle(target);
      if (p) return openPage(p.id);
      return createPage(T.current?.page.workspaceId, null, target);
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) window.open(href, '_blank', 'noopener');
    return undefined;
  };
  host.insertTemplate = () => toast('Templates are coming to team workspaces soon');
}
function restoreHost() { if (savedHost) Object.assign(host, savedHost); }

const findPage = (id) => { for (const list of T.pages.values()) { const p = list.find((x) => x.id === id); if (p) return p; } return null; };
const wsById = (id) => T.workspaces.find((w) => w.id === id);
// Base address for links people send to each other: if you're on the server machine itself
// (localhost), use its network address instead so the link works on teammates' computers.
const isLocalHost = (u) => /^https?:\/\/(localhost|127\.|\[::1\])/.test(u);
const shareBase = () => (isLocalHost(T.api.base) && T.addresses?.length ? T.addresses[0] : T.api.base);
const canEdit = (wsId) => ['owner', 'editor'].includes(wsById(wsId)?.role);
const SHARED = 'shared'; // sidebar section for pages people shared with you from workspaces you're not in
const canEditPage = (p) => !!p && (p.role ? p.role !== 'viewer' : canEdit(p.workspaceId));
const sectionOf = (p) => (p && !wsById(p.workspaceId) ? SHARED : p?.workspaceId);
// Reload whichever sidebar list holds this workspace's pages.
const refreshWs = (wsId) => (wsById(wsId) ? loadPages(wsId) : loadShared());
function pageByTitle(title) {
  const ws = T.current?.page.workspaceId;
  const t = String(title).trim().toLowerCase();
  return (T.pages.get(ws) || []).find((p) => p.title.toLowerCase() === t) || null;
}
const persist = () => {
  store.set(`ln:team:${T.conn.url}:expanded`, [...T.expanded]);
  store.set(`ln:team:${T.conn.url}:collapsed`, [...T.collapsedWs]);
};

async function loadPages(wsId) {
  const r = await T.api.get(`/api/workspaces/${wsId}/pages`);
  T.pages.set(wsId, r.pages);
  T.roles.set(wsId, r.role);
}
async function loadShared() {
  try { T.pages.set(SHARED, (await T.api.get('/api/shared')).pages); } catch { T.pages.set(SHARED, []); }
}
// Everyone who can open a page (for avatars, @mentions and history), cached per page.
async function loadPeople(pageId) {
  if (!T.people.has(pageId)) T.people.set(pageId, (await T.api.get(`/api/pages/${pageId}/people`)).people);
  return T.people.get(pageId);
}
async function reloadMe() {
  const me = await T.api.get('/api/me');
  T.me = me.user;
  T.workspaces = me.workspaces;
  T.unread = me.unread;
  for (const id of [...T.pages.keys()]) if (id !== SHARED && !wsById(id)) T.pages.delete(id);
  await Promise.all([...T.workspaces.filter((w) => !T.pages.has(w.id)).map((w) => loadPages(w.id)), loadShared()]);
  renderSidebar();
  checkCurrent();
}

// live updates from the server
function listen() {
  const url = `${T.api.base}/api/events?token=${encodeURIComponent(T.conn.token)}`;
  const es = new EventSource(url);
  T.events = es;
  es.onmessage = async (msg) => {
    if (!T) return;
    let ev;
    try { ev = JSON.parse(msg.data); } catch { return; }
    if (ev.type === 'tree' || ev.type === 'shared') {
      if (ev.type === 'tree' && wsById(ev.workspaceId)) await loadPages(ev.workspaceId);
      await loadShared();
      T.people.clear();
      renderSidebar();
      if (checkCurrent()) return;
      if (T.current) syncCurrentMeta();
      if (!$('#t-home').hidden) renderHome();
    } else if (ev.type === 'page' && T.current?.page.id === ev.pageId) {
      T.current.page.updatedAt = ev.updatedAt;
      T.current.page.updatedBy = ev.updatedBy;
      renderMeta();
    } else if (ev.type === 'comments' && T.current?.page.id === ev.pageId) {
      await loadThreads();
    } else if (ev.type === 'notification') {
      T.unread = (await T.api.get('/api/me')).unread;
      renderBadge();
      if (T.drawer === 'inbox') renderInbox();
      toast('You have a new notification', { kind: 'info' });
    } else if (ev.type === 'members' || ev.type === 'workspace') {
      T.people.clear();
      await reloadMe();
    }
  };
}

// After access changes: leave a page you can no longer open, and reopen one whose role changed.
function checkCurrent() {
  const c = T?.current;
  if (!c) return false;
  const p = findPage(c.page.id);
  if (!p) { toast('This page was moved, deleted, or you no longer have access'); showHome(); return true; }
  if (p.role && p.role !== c.role) { openPage(p.id, { replace: true }); return true; }
  return false;
}

// ================================================================== shell
function buildShell() {
  T.root.innerHTML = `
  <div class="shell team-shell">
    <aside class="sidebar" id="t-sidebar">
      <div class="sb-top">
        <button class="vault-switch" id="t-account">${avatar(T.me, 22)}<span class="vault-label">${esc(T.me.name)}</span><span class="vs-chev">${icon('chevron-down', 14, 2)}</span></button>
        <button class="icon-btn sb-collapse" id="t-collapse" title="Close sidebar">${icon('sidebar-close', 17)}</button>
      </div>
      <nav class="sb-nav">
        <button class="nav-item" data-nav="search">${icon('search', 17)}<span>Search</span><kbd>${modKey} K</kbd></button>
        <button class="nav-item ai-nav" data-nav="ask">${icon('sparkles', 17)}<span>Ask AI</span><kbd>${modKey} J</kbd></button>
        <button class="nav-item" data-nav="inbox">${icon('note', 17)}<span>Inbox</span><b class="badge" id="t-badge" hidden></b></button>
        <button class="nav-item" data-nav="home">${icon('home', 17)}<span>Home</span></button>
        <button class="nav-item" data-nav="graph">${icon('graph', 17)}<span>Graph view</span></button>
      </nav>
      <div class="sb-scroll" id="t-tree"></div>
      <div class="sb-foot">
        <button class="nav-item" data-nav="new-ws">${icon('plus', 17)}<span>New workspace</span></button>
      </div>
    </aside>
    <main class="main">
      <header class="topbar" id="t-topbar">
        <button class="icon-btn sb-expand" id="t-expand" title="Open sidebar">${icon('sidebar-open', 18)}</button>
        <nav class="crumbs" id="t-crumbs"></nav>
        <div class="tb-right">
          <span class="live" id="t-live" hidden></span>
          <span class="presence-stack" id="t-presence"></span>
          <span class="ro-badge" id="t-ro" hidden>${icon('book', 13)}View only</span>
          <button class="btn ghost small share-btn" id="t-share" hidden>${icon('arrow-up-right', 15)}<span>Share</span></button>
          <button class="icon-btn" id="t-comments" title="Comments" hidden>${icon('note', 18)}<b class="dot-count" id="t-ccount" hidden></b></button>
          <button class="icon-btn" id="t-history" title="Version history" hidden>${icon('clock', 18)}</button>
          <button class="icon-btn" id="t-more" title="More" hidden>${icon('more', 18)}</button>
        </div>
      </header>
      <div class="t-body">
        <div class="scroller" id="t-scroller">
          <div class="home" id="t-home" hidden></div>
          <article class="page" id="t-page" hidden>
            <div class="page-inner">
              <h1 class="title" id="t-title" spellcheck="false" data-placeholder="Untitled"></h1>
              <div class="t-meta" id="t-meta"></div>
              <div id="t-editor"></div>
              <div class="page-tail" id="t-tail"></div>
              <div class="page-links" id="t-links"></div>
            </div>
          </article>
        </div>
        <aside class="drawer" id="t-drawer" hidden></aside>
      </div>
      <div class="graph-view" id="t-graph" hidden></div>
    </main>
  </div>
  <div id="t-block-handle" class="hide block-handle">
    <button class="bh-add" title="Click to add a block below">${icon('plus', 17, 1.8)}</button>
    <span class="bh-grip" title="Drag to move">${icon('grip', 17, 1.8)}</span>
  </div>`;
  document.body.classList.toggle('sidebar-collapsed', false);

  T.root.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]')?.dataset.nav;
    if (nav === 'search') openSearch();
    else if (nav === 'inbox') toggleDrawer('inbox');
    else if (nav === 'ask') toggleAskPanel();
    else if (nav === 'home') showHome();
    else if (nav === 'graph') showGraph();
    else if (nav === 'new-ws') newWorkspace();
  });
  $('#t-account', T.root).onclick = (e) => accountMenu(e.currentTarget);
  $('#t-collapse', T.root).onclick = () => document.body.classList.add('sidebar-collapsed');
  $('#t-expand', T.root).onclick = () => document.body.classList.remove('sidebar-collapsed');
  $('#t-share', T.root).onclick = () => T.current && pageShareDialog(T.current.page.id);
  $('#t-comments', T.root).onclick = () => toggleDrawer('comments');
  $('#t-history', T.root).onclick = () => toggleDrawer('history');
  $('#t-more', T.root).onclick = (e) => pageMenu(e.currentTarget);
  $('#t-crumbs', T.root).addEventListener('click', (e) => { const c = e.target.closest('[data-open]'); if (c) openPage(c.dataset.open); });
  $('#t-links', T.root).addEventListener('click', (e) => {
    if (e.target.closest('[data-subpage]')) return createPage(T.current.page.workspaceId, T.current.page.id);
    const c = e.target.closest('[data-open]');
    if (c) openPage(c.dataset.open);
  });
  $('#t-home', T.root).addEventListener('click', (e) => {
    const c = e.target.closest('[data-open]');
    if (c) return openPage(c.dataset.open);
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'new') createPage(firstTeamWs()?.id || T.workspaces[0].id);
    if (act === 'private') createPage(T.workspaces.find((w) => w.kind === 'private').id);
    if (act === 'search') openSearch();
    if (act === 'invite') shareDialog(firstTeamWs()?.id);
  });
  $('#t-tail', T.root).addEventListener('mousedown', (e) => {
    const ed = T.current?.editor;
    if (!ed || !ed.isEditable) return;
    e.preventDefault();
    ed.commands.focus('end');
  });
  $('#t-scroller', T.root).addEventListener('scroll', (e) => {
    $('#t-block-handle').classList.add('hide');
    $('#t-topbar').classList.toggle('scrolled', e.target.scrollTop > 4);
  }, { passive: true });
  wireTree();
  wireTitle();
  wireKeys();
  wireTeamDrop();
  renderBadge();
  const add = $('#t-block-handle .bh-add');
  add.addEventListener('mousedown', (e) => e.preventDefault());
  add.addEventListener('click', () => {
    const ed = T.current?.editor;
    if (!ed) return;
    const r = $('#t-block-handle').getBoundingClientRect();
    const hit = ed.view.posAtCoords({ left: r.right + 40, top: r.top + 12 });
    if (!hit) return;
    const $pos = ed.state.doc.resolve(hit.pos);
    if ($pos.depth < 1) return;
    const after = $pos.after(1);
    ed.chain().insertContentAt(after, { type: 'paragraph' }).setTextSelection(after + 1).insertContent('/').focus().run();
  });
}

const firstTeamWs = () => T.workspaces.find((w) => w.kind === 'team');

function wireKeys() {
  T.keyHandler = (e) => {
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (mod && (k === 'k' || k === 'p') && !e.shiftKey) {
      if (k === 'k' && T.current?.editor?.isFocused && !T.current.editor.state.selection.empty) return;
      e.preventDefault();
      if (!$('.palette')) openSearch();
    } else if (mod && k === 'j') {
      e.preventDefault();
      const ed = T.current?.editor;
      if (ed?.isFocused && !ed.state.selection.empty) openAIMenu(ed, T.current.bubble.querySelector('[data-cmd="ai"]') || { x: innerWidth / 2, y: 120 });
      else if (ed?.isFocused && ed.isEditable) openWritePanel(ed);
      else toggleAskPanel();
    } else if (mod && (k === 'f' || k === 'h') && !e.shiftKey && !e.altKey && T.current) {
      e.preventDefault();
      openFindBar(T.current.editor, { replace: k === 'h' });
    } else if (mod && e.shiftKey && k === 'f') {
      e.preventDefault();
      if (!$('.palette')) openSearch();
    } else if (mod && e.altKey && k === 'm') {
      e.preventDefault();
      startComment();
    } else if (mod && k === 's') {
      e.preventDefault();
      pushMarkdown(true);
    }
  };
  document.addEventListener('keydown', T.keyHandler);
}

// ================================================================== sidebar
function childrenOf(wsId, parentId) {
  const list = T.pages.get(wsId) || [];
  if (wsId === SHARED) return parentId ? list.filter((p) => !p.root && p.parentId === parentId).sort((a, b) => a.position - b.position) : list.filter((p) => p.root);
  return list.filter((p) => (p.parentId || null) === parentId).sort((a, b) => a.position - b.position);
}

function treeRows(wsId, parentId, depth) {
  return childrenOf(wsId, parentId).map((p) => {
    const kids = childrenOf(wsId, p.id);
    const open = T.expanded.has(p.id);
    const active = T.current?.page.id === p.id;
    const edit = canEditPage(p);
    const badge = p.access === 'restricted' ? `<span class="row-badge" title="Only invited people can see this page">${icon('lock', 12)}</span>`
      : p.shared ? `<span class="row-badge" title="Shared with people outside this workspace">${icon('users', 12)}</span>`
        : wsId === SHARED && depth === 0 && p.workspaceName ? `<span class="row-from" title="From ${esc(p.workspaceName)}${p.sharedBy ? `, shared by ${esc(p.sharedBy)}` : ''}">${esc(p.sharedBy || p.workspaceName)}</span>` : '';
    let html = `<div class="row note ${kids.length ? 'has-sub' : ''} ${open ? 'open' : ''} ${active ? 'active' : ''}" data-page="${p.id}" data-ws="${wsId}" draggable="${wsId !== SHARED && edit}" style="--depth:${depth}">
      <span class="twisty">${kids.length ? icon('chevron-right', 14, 2) : ''}</span>
      <span class="row-icon">${icon(kids.length ? 'book' : 'page', 16)}</span>
      <span class="row-label">${esc(p.title || 'Untitled')}</span>${badge}
      <span class="row-actions">
        <button class="row-btn" data-act="more" title="More">${icon('more', 15)}</button>
        ${edit ? `<button class="row-btn" data-act="add" title="Add a subpage">${icon('plus', 15)}</button>` : ''}
      </span></div>`;
    if (kids.length && open) html += `<div class="children">${treeRows(wsId, p.id, depth + 1)}</div>`;
    return html;
  }).join('');
}

function renderSidebar() {
  const el = $('#t-tree', T.root);
  const shared = (T.pages.get(SHARED) || []).length ? `<section class="ws-sec ${T.collapsedWs.has(SHARED) ? 'collapsed' : ''}" data-ws="${SHARED}">
      <div class="sb-label ws-head" data-ws-head="${SHARED}">
        <span class="ws-chev">${icon('chevron-right', 12, 2.2)}</span>
        <span class="ws-name">Shared with me</span>
        <span class="ws-lock" title="Pages people shared with you directly">${icon('users', 13)}</span>
      </div>
      <div class="ws-tree tree" data-ws-tree="${SHARED}">${treeRows(SHARED, null, 0)}</div>
    </section>` : '';
  el.innerHTML = T.workspaces.map((w, i) => (i === 1 ? shared : '') + (() => {
    const collapsed = T.collapsedWs.has(w.id);
    const rows = treeRows(w.id, null, 0);
    return `<section class="ws-sec ${collapsed ? 'collapsed' : ''}" data-ws="${w.id}">
      <div class="sb-label ws-head" data-ws-head="${w.id}">
        <span class="ws-chev">${icon('chevron-right', 12, 2.2)}</span>
        <span class="ws-name">${w.kind === 'private' ? 'Private' : esc(w.name)}</span>
        ${w.kind === 'private' ? `<span class="ws-lock" title="Only you can see these pages">${icon('lock', 13)}</span>` : `<span class="ws-tag" title="${w.members} member${w.members === 1 ? '' : 's'}">${w.members}</span>`}
        <span class="ws-actions">
          ${w.kind === 'team' ? `<button class="icon-btn tiny" data-ws-act="more" title="Workspace options">${icon('more', 15)}</button>` : ''}
          ${canEdit(w.id) ? `<button class="icon-btn tiny" data-ws-act="add" title="New page">${icon('plus', 15)}</button>` : ''}
        </span>
      </div>
      <div class="ws-tree tree" data-ws-tree="${w.id}">${rows || `<div class="tree-empty">${canEdit(w.id) ? `No pages yet. <button class="link-btn" data-ws-act="add">Add a page</button>` : 'No pages yet.'}</div>`}</div>
    </section>`;
  })()).join('') + (T.workspaces.length < 2 ? shared : '');
}

function wireTree() {
  const el = $('#t-tree', T.root);
  el.addEventListener('click', (e) => {
    const wsAct = e.target.closest('[data-ws-act]');
    const sec = e.target.closest('[data-ws]');
    if (wsAct) {
      e.stopPropagation();
      const wsId = sec.dataset.ws;
      if (wsAct.dataset.wsAct === 'add') createPage(wsId);
      else workspaceMenu(wsId, wsAct);
      return;
    }
    const head = e.target.closest('[data-ws-head]');
    if (head) {
      const id = head.dataset.wsHead;
      if (T.collapsedWs.has(id)) T.collapsedWs.delete(id); else T.collapsedWs.add(id);
      persist();
      renderSidebar();
      return;
    }
    const row = e.target.closest('.row');
    if (!row) return;
    const btn = e.target.closest('.row-btn');
    if (btn) {
      e.stopPropagation();
      if (btn.dataset.act === 'add') { T.expanded.add(row.dataset.page); createPage(findPage(row.dataset.page)?.workspaceId, row.dataset.page); }
      else rowMenu(row.dataset.page, btn);
      return;
    }
    if (e.target.closest('.twisty') && row.classList.contains('has-sub')) {
      const id = row.dataset.page;
      if (T.expanded.has(id)) T.expanded.delete(id); else T.expanded.add(id);
      persist();
      renderSidebar();
      return;
    }
    openPage(row.dataset.page);
  });
  el.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    e.preventDefault();
    rowMenu(row.dataset.page, { x: e.clientX, y: e.clientY });
  });
  // drag a page onto another page to nest it, or onto a workspace heading to make it top-level
  let drag = null;
  const clear = () => el.querySelectorAll('.drop-target').forEach((x) => x.classList.remove('drop-target'));
  el.addEventListener('dragstart', (e) => {
    const row = e.target.closest?.('.row');
    if (!row) return;
    drag = { id: row.dataset.page, ws: row.dataset.ws };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `[[${findPage(drag.id)?.title}]]`);
  });
  el.addEventListener('dragend', () => { drag = null; clear(); });
  el.addEventListener('dragover', (e) => {
    if (!drag) return;
    const target = e.target.closest('.row') || e.target.closest('[data-ws-head]');
    if (!target) return;
    const ws = target.closest('[data-ws]').dataset.ws;
    if (ws !== drag.ws || target.dataset.page === drag.id) return;
    e.preventDefault();
    clear();
    target.classList.add('drop-target');
  });
  el.addEventListener('drop', async (e) => {
    if (!drag) return;
    e.preventDefault();
    clear();
    const row = e.target.closest('.row');
    const parentId = row ? row.dataset.page : null;
    const { id } = drag;
    drag = null;
    if (parentId === id) return;
    try {
      const pos = Math.max(0, ...childrenOf(findPage(id).workspaceId, parentId).map((p) => p.position)) + 1;
      await T.api.patch(`/api/pages/${id}`, { parentId, position: pos });
      if (parentId) T.expanded.add(parentId);
      await loadPages(findPage(id).workspaceId);
      renderSidebar();
    } catch (err) { toast(err.message, { kind: 'error' }); }
  });
}

function renderBadge() {
  const b = $('#t-badge', T.root);
  if (!b) return;
  b.hidden = !T.unread;
  b.textContent = T.unread > 9 ? '9+' : T.unread;
}

function markActive() {
  T.root.querySelectorAll('#t-tree .row').forEach((r) => r.classList.toggle('active', r.dataset.page === T.current?.page.id));
}

function accountMenu(anchor) {
  const others = savedTeams().filter((c) => c.url !== T.conn.url);
  showMenu([
    { custom: h(`<div class="menu-vault">${avatar(T.me, 34)}<div><strong>${esc(T.me.name)}</strong><span>${esc(T.me.email)}</span></div></div>`) },
    { custom: h(`<div class="menu-server">${icon('drive', 13)}<span>${esc(T.api.base.replace(/^https?:\/\//, ''))}</span></div>`) },
    'sep',
    { label: 'Profile & password…', icon: 'pencil', run: profileDialog },
    { label: 'Contacts…', icon: 'users', run: () => contactsDialog() },
    ...(T.me.isAdmin ? [{ label: 'Server admin…', icon: 'drive', run: () => adminConsole() }] : []),
    { label: 'Appearance', icon: 'sun', run: () => themeMenuTeam(anchor) },
    ...(others.length ? ['sep', { header: 'Other servers' }, ...others.map((c) => ({ label: c.url.replace(/^https?:\/\//, ''), icon: 'drive', run: () => { const exit = T.onExit; stopTeam(); startTeam(c, { onExit: exit }); } }))] : []),
    'sep',
    ...(T.onExit ? [{ label: 'Back to local notes', icon: 'folder-open', run: () => { const exit = T.onExit; stopTeam(); exit(); } }] : []),
    { label: 'Sign out', icon: 'logout', danger: true, run: () => signOut() },
  ], anchor, { className: 'wide' });
}

function themeMenuTeam(anchor) {
  const prefs = { theme: 'system', ...store.get('ln:prefs', {}) };
  const set = (theme) => {
    prefs.theme = theme;
    store.set('ln:prefs', prefs);
    document.documentElement.dataset.theme = theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme;
    window.desktop?.setTheme(document.documentElement.dataset.theme === 'dark');
  };
  const sizes = h(`<div class="size-picker"><span class="size-label">Text size</span><div class="size-opts">${[['small', 13], ['default', 15], ['large', 17.5], ['xl', 20]].map(([k, px]) => `
    <button class="size-opt ${(prefs.textSize || 'default') === k ? 'on' : ''}" data-size="${k}"><span style="font-size:${px}px">A</span></button>`).join('')}</div></div>`);
  sizes.addEventListener('click', (e) => {
    e.stopPropagation();
    const b = e.target.closest('[data-size]');
    if (!b) return;
    prefs.textSize = b.dataset.size;
    store.set('ln:prefs', prefs);
    document.documentElement.dataset.textsize = prefs.textSize;
    sizes.querySelectorAll('.size-opt').forEach((x) => x.classList.toggle('on', x === b));
  });
  showMenu([
    { header: 'Appearance' },
    { label: 'System', icon: 'monitor', checked: prefs.theme === 'system', run: () => set('system') },
    { label: 'Light', icon: 'sun', checked: prefs.theme === 'light', run: () => set('light') },
    { label: 'Dark', icon: 'moon', checked: prefs.theme === 'dark', run: () => set('dark') },
    'sep',
    { custom: sizes },
  ], anchor);
}

function profileDialog() {
  const box = h(`<div class="cv">
    <div class="cv-art">${avatar(T.me, 52)}</div>
    <h3>Your profile</h3><p>${esc(T.me.email)}</p>
    <label class="field"><span>Name</span><input name="name" value="${esc(T.me.name)}"></label>
    <label class="field"><span>Current password</span><input name="password" type="password" placeholder="Only needed to change it"></label>
    <label class="field"><span>New password</span><input name="newPassword" type="password" placeholder="At least 8 characters"></label>
    <div class="confirm-actions"><button class="btn ghost" data-no>Cancel</button><button class="btn primary" data-yes>Save</button></div></div>`);
  const m = openModal(box, { className: 'small' });
  $('[data-no]', box).onclick = () => m.close();
  $('[data-yes]', box).onclick = async () => {
    const v = (n) => $(`[name=${n}]`, box).value;
    try {
      const r = await T.api.patch('/api/me', { name: v('name'), password: v('password') || undefined, newPassword: v('newPassword') || undefined });
      T.me = r.user;
      m.close();
      toast('Profile updated', { kind: 'success' });
      $('#t-account', T.root).innerHTML = `${avatar(T.me, 22)}<span class="vault-label">${esc(T.me.name)}</span><span class="vs-chev">${icon('chevron-down', 14, 2)}</span>`;
    } catch (e) { toast(e.message, { kind: 'error' }); }
  };
}

function workspaceMenu(wsId, anchor) {
  const ws = wsById(wsId);
  const owner = ws.role === 'owner';
  showMenu([
    { header: ws.name },
    { label: 'Share & members…', icon: 'arrow-up-right', run: () => shareDialog(wsId) },
    { label: 'Graph of this workspace', icon: 'graph', run: () => showGraph(wsId) },
    ...(canEdit(wsId) ? [{ label: 'Import files…', icon: 'file-up', run: () => pickTeamImport(wsId) }] : []),
    { label: 'Trash', icon: 'trash', run: () => trashDialog(wsId) },
    ...(owner ? ['sep', { label: 'Rename…', icon: 'pencil', run: () => renameWorkspace(wsId) }] : []),
    'sep',
    { label: 'Leave workspace', icon: 'logout', run: () => leaveWorkspace(wsId) },
    ...(owner ? [{ label: 'Delete workspace…', icon: 'trash', danger: true, run: () => deleteWorkspace(wsId) }] : []),
  ], anchor);
}

function rowMenu(pageId, anchor) {
  const p = findPage(pageId);
  if (!p) return;
  const edit = canEditPage(p);
  showMenu([
    ...(edit ? [{ label: 'Add subpage', icon: 'file-plus', run: () => { T.expanded.add(p.id); createPage(p.workspaceId, p.id); } }] : []),
    { label: 'Share…', icon: 'user-plus', run: () => pageShareDialog(p.id) },
    ...(edit && moveTargets(p).length ? [{ label: 'Move to…', icon: 'move', run: () => moveMenu(p.id, anchor) }] : []),
    ...(edit ? [{ label: 'Import files as subpages…', icon: 'file-up', run: () => { T.expanded.add(p.id); pickTeamImport(p.workspaceId, p.id); } }] : []),
    { label: 'Copy link', icon: 'link', run: () => copyLink(p.id) },
    { label: 'Copy as wikilink', icon: 'page-link', run: () => copy(`[[${p.title}]]`, 'Wikilink copied') },
    ...(edit ? ['sep', { label: 'Move to trash', icon: 'trash', danger: true, run: () => deletePage(p.id) }] : []),
  ], anchor);
}

// ================================================================== address book
// Read contacts exported from Google Contacts / Gmail (CSV), Outlook (CSV) or any vCard (.vcf) file.
function parseContactsFile(name, text) {
  const out = [];
  const add = (n, e) => { const email = String(e || '').trim().replace(/^mailto:/i, ''); if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) out.push({ name: String(n || '').trim(), email }); };
  if (/\.vcf$/i.test(name) || /BEGIN:VCARD/i.test(text)) {
    const unfolded = text.replace(/\r?\n[ \t]/g, '');
    for (const card of unfolded.split(/BEGIN:VCARD/i).slice(1)) {
      const fn = /^FN(?:;[^:]*)?:(.*)$/im.exec(card)?.[1] || (/^N(?:;[^:]*)?:([^;\r\n]*);([^;\r\n]*)/im.exec(card) || []).slice(1, 3).reverse().join(' ');
      for (const m of card.matchAll(/^(?:item\d+\.)?EMAIL(?:;[^:]*)?:(.*)$/gim)) add(fn.replace(/\\,/g, ','), m[1]);
    }
    return out;
  }
  const rows = parseCsv(text);
  if (!rows.length) return out;
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names) => head.findIndex((h) => names.some((n) => h === n));
  const emailCols = head.map((h, i) => (/e-?mail/.test(h) && !/type|label|display/.test(h) ? i : -1)).filter((i) => i >= 0);
  const nameCol = col('name', 'display name', 'full name');
  const first = col('first name', 'given name');
  const middle = col('middle name', 'additional name');
  const last = col('last name', 'family name', 'surname');
  for (const r of rows.slice(1)) {
    const name = nameCol >= 0 && r[nameCol] ? r[nameCol] : [r[first], r[middle], r[last]].filter((x) => x && x.trim()).join(' ');
    const cells = emailCols.length ? emailCols.map((i) => r[i]) : r;
    for (const cell of cells) for (const e of String(cell || '').split(/\s*:::\s*|[;,\s]+/)) add(name, e);
  }
  return out;
}
function parseCsv(text) {
  const src = text.replace(/^\ufeff/, '');
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) { if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && src[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

async function contactsDialog() {
  const box = h(`<div class="share contacts">
    <div class="share-head"><div><h2>Contacts</h2><p>Suggestions when you share come from people on this server and these contacts. People you share with are added automatically.</p></div>
      <button class="icon-btn" data-close>${icon('x', 18)}</button></div>
    <div class="ct-import">
      <div><strong>Import your address book</strong>
        <span>Gmail: <a href="https://contacts.google.com" target="_blank" rel="noopener">Google Contacts</a> → Export → Google CSV. Outlook: People → Manage contacts → Export contacts. Apple Contacts: File → Export vCard.</span></div>
      <button class="btn primary small" data-import>${icon('upload', 15)}<span>Import file</span></button>
    </div>
    <div class="ct-search">${icon('search', 15)}<input placeholder="Search contacts" spellcheck="false"></div>
    <div class="share-list ct-list">Loading…</div>
    <div class="ct-foot"><span class="ct-count"></span><button class="link-btn small danger-text" data-clear hidden>Remove all</button></div>
  </div>`);
  const m = openModal(box, { className: 'share-modal' });
  let all = [];
  const render = () => {
    const q = $('.ct-search input', box).value.trim().toLowerCase();
    const shown = all.filter((c) => !q || c.email.includes(q) || c.name.toLowerCase().includes(q));
    $('.ct-list', box).innerHTML = shown.slice(0, 300).map((c) => `<div class="member" data-email="${esc(c.email)}">
      ${c.onServer ? avatar({ name: c.name || c.email, color: '#7c8a9b' }, 30) : `<span class="ep-av-mail big">${icon('mail', 15)}</span>`}
      <div class="member-info"><strong>${esc(c.name || c.email)}</strong><span>${esc(c.name ? c.email : '')}${c.onServer ? ' · on this server' : ''}${c.source === 'imported' ? ' · imported' : ''}</span></div>
      <button class="icon-btn" data-remove title="Remove">${icon('x', 16)}</button></div>`).join('') || `<p class="bl-empty pad">${all.length ? 'No matches.' : 'No contacts yet. Import your address book, or share a page with someone.'}</p>`;
    $('.ct-count', box).textContent = `${all.length} contact${all.length === 1 ? '' : 's'}`;
    $('[data-clear]', box).hidden = !all.length;
  };
  const load = async () => { all = (await T.api.get('/api/contacts/all')).contacts; render(); };
  $('[data-close]', box).onclick = () => m.close();
  $('.ct-search input', box).addEventListener('input', render);
  box.addEventListener('click', async (e) => {
    if (e.target.closest('[data-import]')) {
      const input = h('<input type="file" accept=".csv,.vcf,.vcard,text/csv,text/vcard" hidden>');
      document.body.append(input);
      input.onchange = async () => {
        const f = input.files[0];
        input.remove();
        if (!f) return;
        const found = parseContactsFile(f.name, await f.text());
        if (!found.length) { toast('No email addresses found in that file', { kind: 'error' }); return; }
        try {
          const r = await T.api.post('/api/contacts/import', { contacts: found });
          toast(`Imported ${r.added} new contact${r.added === 1 ? '' : 's'}`, { kind: 'success' });
          await load();
        } catch (err) { toast(err.message, { kind: 'error' }); }
      };
      input.click();
    }
    const rm = e.target.closest('[data-remove]');
    if (rm) { await T.api.del(`/api/contacts?email=${encodeURIComponent(rm.closest('[data-email]').dataset.email)}`); await load(); }
    if (e.target.closest('[data-clear]') && await confirmDialog({ title: 'Remove all contacts?', body: 'Suggestions will only come from people on this server until you share or import again. People on the server aren’t affected.', confirm: 'Remove all', danger: true })) {
      await T.api.del('/api/contacts?all=1');
      await load();
    }
  });
  load();
}

// ================================================================== server admin console
async function adminConsole(tab = 'people', { welcome = false } = {}) {
  const box = h(`<div class="admin">
    <div class="share-head"><div><h2>Server admin</h2><p class="adm-sub"></p></div><button class="icon-btn" data-close>${icon('x', 18)}</button></div>
    <nav class="adm-tabs">${[['people', 'users', 'People'], ['workspaces', 'library', 'Workspaces'], ['settings', 'drive', 'Server'], ['email', 'mail', 'Email'], ['ai', 'sparkles', 'AI']]
      .map(([k, ic, label]) => `<button data-tab="${k}">${icon(ic, 15)}<span>${label}</span></button>`).join('')}</nav>
    <div class="adm-body"></div>
  </div>`);
  const m = openModal(box, { className: 'admin-modal' });
  $('[data-close]', box).onclick = () => m.close();
  let data;
  const body = $('.adm-body', box);
  const linkUrl = (token) => `${shareBase()}/#/password/${token}`;
  const load = async () => { data = await T.api.get('/api/admin/overview'); $('.adm-sub', box).textContent = `${data.settings.name} · ${data.users.filter((u) => !u.disabled).length} people · version ${data.version}`; };
  const linkBox = (u, token, kind) => `<div class="adm-link pop">
      <div class="adm-link-head">${icon(kind === 'welcome' ? 'user-plus' : 'lock', 16)}<strong>${kind === 'welcome' ? `Send this link to ${esc(u.name)}` : `Password reset link for ${esc(u.name)}`}</strong></div>
      <p>${kind === 'welcome' ? 'They open it, choose a password and they’re in. It works once, for 14 days.' : 'They open it and choose a new password. It works once, for 2 days.'} Send it by email or chat.</p>
      <div class="share-link"><input readonly value="${esc(linkUrl(token))}"><button class="btn primary small" data-copy-url>${icon('copy', 15)}<span>Copy</span></button></div>
    </div>`;

  async function show(name) {
    tab = name;
    box.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    if (name === 'ai') {
      body.innerHTML = `<div class="adm-empty">${icon('sparkles', 28, 1.4)}<strong>AI for everyone on this server</strong><span>Choose the AI provider and key your team uses. People never see the key.</span>
        <button class="btn primary" data-ai>Open AI settings</button></div>`;
      return;
    }
    body.innerHTML = '<p class="bl-empty pad">Loading…</p>';
    try { await load(); } catch (e) { body.innerHTML = `<p class="bl-empty pad">${esc(e.message)}</p>`; return; }
    if (tab !== name) return;
    if (name === 'people') renderPeople();
    if (name === 'workspaces') renderWorkspaces();
    if (name === 'settings') renderSettings();
    if (name === 'email') renderEmail();
  }

  async function renderEmail() {
    let st;
    try { st = await T.api.get('/api/admin/email'); } catch (e) { body.innerHTML = `<p class="bl-empty pad">${esc(e.message)}</p>`; return; }
    body.innerHTML = `<div class="adm-email">
      <div class="adm-email-status ${st.configured ? 'on' : ''}">${icon(st.configured ? 'success' : 'mail', 18)}<div><strong>${st.configured ? 'Email is set up' : 'Email isn’t set up yet'}</strong>
        <span>${st.configured ? `Invitations, share notifications and password links are sent from ${esc(st.from)}.` : 'Without it, people are notified inside Local Notes and you copy invitation links yourself. Use your company’s email server or a provider like Microsoft 365, Google Workspace, Brevo or SendGrid.'}</span></div></div>
      <form class="adm-form flat" novalidate autocomplete="off">
        <div class="adm-row"><label class="field"><span>SMTP server</span><input name="host" value="${esc(st.host)}" placeholder="smtp.office365.com"></label>
          <label class="field"><span>Port</span><input name="port" value="${esc(st.port || '')}" placeholder="587" inputmode="numeric"></label></div>
        <div class="adm-row"><label class="field"><span>Username</span><input name="user" value="${esc(st.user)}" placeholder="notes@company.com" autocomplete="off"></label>
          <label class="field"><span>Password</span><input name="pass" type="password" placeholder="${st.hasPassword ? '•••••••• (saved)' : ''}" autocomplete="new-password"></label></div>
        <div class="adm-row"><label class="field"><span>Send from</span><input name="from" value="${esc(st.from)}" placeholder="Local Notes &lt;notes@company.com&gt;"></label>
          <label class="adm-check"><input type="checkbox" name="secure" ${st.secure ? 'checked' : ''}><span>Use SSL/TLS from the start<em>Usually only for port 465. Port 587 upgrades to TLS automatically.</em></span></label></div>
        <div class="adm-actions">
          ${st.configured ? '<button type="button" class="btn ghost" data-email-clear>Turn off email</button>' : ''}
          <button type="button" class="btn ghost" data-email-test ${st.configured ? '' : 'disabled'}>Send test email</button>
          <button class="btn primary" type="submit">Save</button></div>
      </form></div>`;
    const f = $('.adm-form', body);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(f);
      try {
        await T.api.put('/api/admin/email', { host: fd.get('host'), port: fd.get('port'), user: fd.get('user'), pass: fd.get('pass'), from: fd.get('from'), secure: !!fd.get('secure') });
        toast('Email settings saved', { kind: 'success' });
        renderEmail();
      } catch (err) { toast(err.message, { kind: 'error' }); }
    });
    $('[data-email-test]', body)?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try { const r = await T.api.post('/api/admin/email/test', {}); toast(`Test email sent to ${r.to}`, { kind: 'success' }); } catch (err) { toast(err.message, { kind: 'error', timeout: 9000 }); }
      e.target.disabled = false;
    });
    $('[data-email-clear]', body)?.addEventListener('click', async () => {
      if (!(await confirmDialog({ title: 'Turn off email?', body: 'People will only be notified inside Local Notes, and you’ll copy invitation links yourself.', confirm: 'Turn off' }))) return;
      await T.api.put('/api/admin/email', { clear: true });
      renderEmail();
    });
  }

  function renderPeople(extra = '') {
    const ago = (t) => (t ? timeAgo(t / 1000) : 'never');
    body.innerHTML = `
      ${welcome ? `<div class="adm-welcome">${icon('success', 20)}<div><strong>Your team server is ready</strong><span>Add the people who should use it. Each person gets a link to choose their own password. You can also share workspace invite links later.</span></div></div>` : ''}
      <div class="adm-bar"><div class="pk-label">${data.users.length} ${data.users.length === 1 ? 'person' : 'people'}</div><button class="btn primary small" data-add-person>${icon('user-plus', 15)}<span>Add person</span></button></div>
      <div class="adm-slot">${extra}</div>
      <div class="share-list adm-list">${data.users.map((u) => `<div class="member ${u.disabled ? 'off' : ''}" data-user="${u.id}">
        ${avatar(u, 34)}<div class="member-info"><strong>${esc(u.name)}${u.id === T.me.id ? ' <em>(you)</em>' : ''}
          ${u.isAdmin ? '<b class="adm-tag">Admin</b>' : ''}${u.disabled ? '<b class="adm-tag warn">Suspended</b>' : ''}${u.pendingSetup ? '<b class="adm-tag soft">Invited</b>' : ''}</strong>
          <span>${esc(u.email)} · ${u.pendingSetup ? 'hasn’t chosen a password yet' : `active ${ago(u.lastSeen)}`}</span>
          ${u.workspaces.length ? `<span class="adm-ws">${u.workspaces.map((w) => `${esc(w.name)} <i>${ROLE_LABEL[w.role].toLowerCase()}</i>`).join(' · ')}</span>` : '<span class="adm-ws">Not in any team workspace</span>'}</div>
        <button class="icon-btn" data-person-menu title="Options">${icon('more', 17)}</button></div>`).join('')}</div>`;
    if (welcome) { welcome = false; setTimeout(() => $('[data-add-person]', body)?.click(), 60); }
  }

  function addPersonForm() {
    const ws = data.workspaces;
    $('.adm-slot', body).innerHTML = `<form class="adm-form pop" novalidate>
      <div class="adm-form-head"><strong>Add a person</strong><button type="button" class="icon-btn" data-cancel>${icon('x', 16)}</button></div>
      <div class="adm-row"><label class="field"><span>Name</span><input name="name" placeholder="Sam Kim"></label>
        <label class="field"><span>Email</span><input name="email" type="email" placeholder="sam@company.com"></label></div>
      ${ws.length ? `<div class="field"><span>Workspaces</span><div class="adm-checks">${ws.map((w, i) => `<label><input type="checkbox" name="ws" value="${w.id}" ${i === 0 ? 'checked' : ''}>${esc(w.name)}</label>`).join('')}</div></div>` : ''}
      <div class="adm-row"><label class="field"><span>Access in those workspaces</span><select name="role"><option value="editor">Can edit</option><option value="viewer">Can view</option><option value="owner">Owner</option></select></label>
        <label class="adm-check"><input type="checkbox" name="isAdmin"><span>Server admin<em>Can add people and change server settings</em></span></label></div>
      ${data.emailOn ? '<label class="adm-check inline"><input type="checkbox" name="sendEmail" checked><span>Email them the link</span></label>' : ''}
      <div class="adm-actions"><button type="button" class="btn ghost" data-cancel>Cancel</button><button class="btn primary" type="submit">${data.emailOn ? 'Add person' : 'Add and get link'}</button></div>
    </form>`;
    const f = $('.adm-form', body);
    setTimeout(() => $('[name=name]', f).focus(), 30);
    f.addEventListener('click', (e) => { if (e.target.closest('[data-cancel]')) $('.adm-slot', body).innerHTML = ''; });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(f);
      try {
        const r = await T.api.post('/api/admin/users', { name: fd.get('name'), email: fd.get('email'), role: fd.get('role'), isAdmin: !!fd.get('isAdmin'), workspaceIds: fd.getAll('ws'), sendEmail: !!fd.get('sendEmail'), baseUrl: shareBase() });
        await load();
        if (r.emailed) { toast(`${r.user.name} was added and emailed a link to choose their password`, { kind: 'success' }); renderPeople(); }
        else renderPeople((r.emailError ? `<p class="adm-warn">${icon('warning', 14)}The email couldn’t be sent (${esc(r.emailError)}). Send the link below yourself.</p>` : '') + linkBox(r.user, r.token, 'welcome'));
        reloadMe().catch(() => {});
      } catch (err) { toast(err.message, { kind: 'error' }); }
    });
  }

  async function personAction(u, act) {
    try {
      if (act === 'link' || act === 'email-link') {
        const r = await T.api.post(`/api/admin/users/${u.id}/password-link`, { sendEmail: act === 'email-link', baseUrl: shareBase() });
        if (r.emailed) { toast(`Emailed ${u.pendingSetup ? 'a new setup' : 'a password reset'} link to ${u.email}`, { kind: 'success' }); return; }
        return renderPeople((r.emailError ? `<p class="adm-warn">${icon('warning', 14)}The email couldn’t be sent (${esc(r.emailError)}).</p>` : '') + linkBox(u, r.token, u.pendingSetup ? 'welcome' : 'reset'));
      }
      if (act === 'suspend' && !(await confirmDialog({ title: `Suspend ${u.name}?`, body: 'They’re signed out everywhere and can’t sign in until you restore access. Their pages stay where they are.', confirm: 'Suspend', danger: true }))) return;
      const patch = act === 'admin' ? { isAdmin: !u.isAdmin } : { disabled: act === 'suspend' };
      await T.api.patch(`/api/admin/users/${u.id}`, patch);
      toast(act === 'admin' ? (u.isAdmin ? `${u.name} is no longer an admin` : `${u.name} is now an admin`) : act === 'suspend' ? `${u.name} is suspended` : `${u.name} can sign in again`, { kind: 'success' });
      await load();
      renderPeople();
    } catch (e) { toast(e.message, { kind: 'error' }); }
  }

  function renderWorkspaces() {
    body.innerHTML = `<div class="adm-bar"><div class="pk-label">${data.workspaces.length} team workspace${data.workspaces.length === 1 ? '' : 's'}</div><button class="btn primary small" data-new-ws>${icon('plus', 15)}<span>New workspace</span></button></div>
      <div class="share-list adm-list">${data.workspaces.map((w) => `<div class="member" data-ws="${w.id}">
        <span class="share-ic">${icon('library', 17)}</span><div class="member-info"><strong>${esc(w.name)}</strong>
          <span>${w.members} member${w.members === 1 ? '' : 's'} · ${w.pages} page${w.pages === 1 ? '' : 's'} · owner${w.owners.length === 1 ? '' : 's'}: ${esc(w.owners.join(', ') || 'none')}</span></div>
        ${w.myRole === 'owner' ? '<button class="btn ghost small" data-ws-members>Members</button>' : `<button class="btn ghost small" data-ws-join title="Add yourself as an owner so you can manage it">${w.myRole ? 'Make me owner' : 'Join as owner'}</button>`}
      </div>`).join('') || '<p class="bl-empty pad">No team workspaces yet.</p>'}</div>`;
  }

  function renderSettings() {
    const st = data.settings;
    body.innerHTML = `<form class="adm-form flat" novalidate>
      <label class="field"><span>Team or server name</span><input name="name" value="${esc(st.name)}"></label>
      <div class="field"><span>Who can create an account</span><div class="choice-list">
        <label class="choice ${st.signup === 'invite' ? 'on' : ''}"><input type="radio" name="signup" value="invite" ${st.signup === 'invite' ? 'checked' : ''}><span class="choice-ic">${icon('lock', 18)}</span><span><strong>Only people you add or invite</strong><em>Recommended</em></span></label>
        <label class="choice ${st.signup === 'open' ? 'on' : ''}"><input type="radio" name="signup" value="open" ${st.signup === 'open' ? 'checked' : ''}><span class="choice-ic">${icon('users', 18)}</span><span><strong>Anyone who can reach this server</strong><em>They only see workspaces they’re added to</em></span></label>
      </div></div>
      <div class="field"><span>Inviting people who aren’t on this server yet</span><div class="choice-list">
        <label class="choice ${st.externalSharing !== 'admins' ? 'on' : ''}"><input type="radio" name="externalSharing" value="anyone" ${st.externalSharing !== 'admins' ? 'checked' : ''}><span class="choice-ic">${icon('share', 18)}</span><span><strong>Anyone who can edit a page</strong><em>Like Google Docs: type any email to invite them</em></span></label>
        <label class="choice ${st.externalSharing === 'admins' ? 'on' : ''}"><input type="radio" name="externalSharing" value="admins" ${st.externalSharing === 'admins' ? 'checked' : ''}><span class="choice-ic">${icon('lock', 18)}</span><span><strong>Only server admins</strong><em>Others can share only with people already on the server</em></span></label>
      </div></div>
      <div class="adm-actions"><button class="btn primary" type="submit">Save changes</button></div>
    </form>
    <div class="adm-facts">
      <div><span>Address for your team</span><strong>${esc(shareBase())}</strong><button class="link-btn small" data-copy-base>Copy</button></div>
      ${isLocalHost(T.api.base) && !T.addresses.length ? `<p>${icon('warning', 13)}This computer isn’t connected to a network, so teammates can’t reach it yet.</p>` : ''}
      <div><span>Version</span><strong>${esc(data.version)}</strong></div>
      <div><span>Data folder</span><strong class="mono">${esc(data.dataDir)}</strong></div>
      <p>${icon('info', 13)}Back up the data folder regularly: it holds the database and a plain-markdown copy of every page.</p>
    </div>`;
    const f = $('.adm-form', body);
    f.addEventListener('change', () => f.querySelectorAll('.choice').forEach((c) => c.classList.toggle('on', $('input', c).checked)));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(f);
      try { await T.api.patch('/api/admin/settings', { name: fd.get('name'), signup: fd.get('signup'), externalSharing: fd.get('externalSharing') }); toast('Settings saved', { kind: 'success' }); await load(); } catch (err) { toast(err.message, { kind: 'error' }); }
    });
  }

  box.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-tab]');
    if (t) return show(t.dataset.tab);
    if (e.target.closest('[data-ai]')) { m.close(); return openAISettings(); }
    if (e.target.closest('[data-add-person]')) return addPersonForm();
    if (e.target.closest('[data-copy-url]')) return copy($('.adm-link input', box).value, 'Link copied');
    if (e.target.closest('[data-copy-base]')) return copy(shareBase(), 'Address copied');
    if (e.target.closest('[data-new-ws]')) { m.close(); return newWorkspace(); }
    const pm = e.target.closest('[data-person-menu]');
    if (pm) {
      const u = data.users.find((x) => x.id === pm.closest('[data-user]').dataset.user);
      return showMenu([
        { header: u.name },
        ...(!u.disabled ? [{ label: u.pendingSetup ? 'Copy a new setup link' : 'Password reset link', icon: u.pendingSetup ? 'user-plus' : 'lock', run: () => personAction(u, 'link') }] : []),
        ...(!u.disabled && data.emailOn ? [{ label: u.pendingSetup ? 'Email a new setup link' : 'Email a password reset link', icon: 'mail', run: () => personAction(u, 'email-link') }] : []),
        { label: u.isAdmin ? 'Remove admin rights' : 'Make server admin', icon: 'drive', run: () => personAction(u, 'admin') },
        ...(u.id !== T.me.id ? ['sep', u.disabled ? { label: 'Restore access', icon: 'success', run: () => personAction(u, 'restore') } : { label: 'Suspend access…', icon: 'logout', danger: true, run: () => personAction(u, 'suspend') }] : []),
      ], pm, { align: 'end' });
    }
    const wsRow = e.target.closest('[data-ws]');
    if (wsRow && e.target.closest('[data-ws-members]')) { m.close(); return shareDialog(wsRow.dataset.ws); }
    if (wsRow && e.target.closest('[data-ws-join]')) {
      try { await T.api.post(`/api/admin/workspaces/${wsRow.dataset.ws}/join`); await reloadMe(); toast('You’re now an owner of that workspace', { kind: 'success' }); await load(); renderWorkspaces(); } catch (err) { toast(err.message, { kind: 'error' }); }
    }
  });
  show(tab);
}

// ================================================================== import into a workspace
const dataUrl = (blob) => new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => resolve(null); r.readAsDataURL(blob); });

async function pickTeamImport(wsId, parentId = null) {
  if (window.desktop?.openFiles) {
    const files = await window.desktop.openFiles();
    if (files?.length) importIntoWorkspace(wsId, files.map((f) => new File([f.data], f.name)), parentId);
    return;
  }
  const input = h(`<input type="file" multiple accept="${IMPORT_ACCEPT}" hidden>`);
  document.body.append(input);
  input.onchange = () => { importIntoWorkspace(wsId, [...input.files], parentId); input.remove(); };
  input.click();
}

async function importIntoWorkspace(wsId, files, parentId = null) {
  if (!wsId || !files.length) return;
  if (parentId ? !canEditPage(findPage(parentId)) : !canEdit(wsId)) { toast('You have view-only access here'); return; }
  const t = toast(files.length === 1 ? `Importing ${files[0].name}…` : `Importing ${files.length} files…`, { timeout: 0 });
  let last = null;
  const failed = [];
  for (const file of files) {
    try {
      const r = await convertFile(file);
      const urls = new Map();
      for (const im of r.images) urls.set(im.id, im.blob.size <= 2 * 1024 * 1024 ? await dataUrl(im.blob) : null);
      let md = linkImages(r.markdown, r.images, (im) => urls.get(im.id) || 'image-too-large');
      md = md.replace(/!\[([^\]]*)\]\(image-too-large\)/g, '_[image “$1” was too large to import]_');
      last = (await T.api.post(`/api/workspaces/${wsId}/pages`, { title: r.title, markdown: md, parentId })).page.id;
    } catch (e) {
      console.error(e);
      failed.push(`${file.name}: ${e.message}`);
    }
  }
  t?.remove();
  await refreshWs(wsId);
  renderSidebar();
  if (last) {
    await openPage(last);
    const ok = files.length - failed.length;
    toast(ok === 1 ? 'Imported 1 page' : `Imported ${ok} pages`, { kind: 'success' });
  }
  if (failed.length) toast(failed.join('\n'), { kind: 'error', timeout: 10000 });
}

function wireTeamDrop() {
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const target = () => T?.current?.page.workspaceId && canEditPage(T.current.page) ? T.current.page.workspaceId : (firstTeamWs()?.id || T?.workspaces[0]?.id);
  T.dropHandlers = {
    dragover: (e) => { if (T && hasFiles(e)) e.preventDefault(); },
    drop: (e) => {
      if (!T || !hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      importIntoWorkspace(target(), [...e.dataTransfer.files]);
    },
  };
  T.root.addEventListener('dragover', T.dropHandlers.dragover);
  T.root.addEventListener('drop', T.dropHandlers.drop, true);
}

// ================================================================== workspaces
async function newWorkspace() {
  const box = h(`<div class="cv">
    <div class="cv-art ws-art">${icon('library', 30, 1.5)}</div>
    <h3>Create a workspace</h3>
    <p>A shared space for a team or project. Invite people once it’s created.</p>
    <label class="field"><span>Name</span><input name="name" placeholder="Engineering, Marketing, Launch…"></label>
    <div class="confirm-actions"><button class="btn ghost" data-no>Cancel</button><button class="btn primary" data-yes>Create</button></div></div>`);
  const m = openModal(box, { className: 'small' });
  const input = $('input', box);
  setTimeout(() => input.focus(), 30);
  const go = async () => {
    try {
      const r = await T.api.post('/api/workspaces', { name: input.value });
      m.close();
      await reloadMe();
      const first = T.pages.get(r.id)?.[0];
      if (first) openPage(first.id);
      shareDialog(r.id);
    } catch (e) { toast(e.message, { kind: 'error' }); }
  };
  $('[data-no]', box).onclick = () => m.close();
  $('[data-yes]', box).onclick = go;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

async function renameWorkspace(wsId) {
  const ws = wsById(wsId);
  const box = h(`<div class="cv"><h3>Rename workspace</h3><label class="field"><span>Name</span><input value="${esc(ws.name)}"></label>
    <div class="confirm-actions"><button class="btn ghost" data-no>Cancel</button><button class="btn primary" data-yes>Save</button></div></div>`);
  const m = openModal(box, { className: 'small' });
  const input = $('input', box);
  setTimeout(() => { input.focus(); input.select(); }, 30);
  $('[data-no]', box).onclick = () => m.close();
  $('[data-yes]', box).onclick = async () => {
    try { await T.api.patch(`/api/workspaces/${wsId}`, { name: input.value }); m.close(); await reloadMe(); } catch (e) { toast(e.message, { kind: 'error' }); }
  };
}

async function leaveWorkspace(wsId) {
  const ws = wsById(wsId);
  if (!(await confirmDialog({ title: `Leave “${ws.name}”?`, body: 'You’ll lose access to its pages until someone invites you again.', confirm: 'Leave', danger: true }))) return;
  try {
    await T.api.del(`/api/workspaces/${wsId}/members/${T.me.id}`);
    if (T.current?.page.workspaceId === wsId) showHome();
    await reloadMe();
  } catch (e) { toast(e.message, { kind: 'error' }); }
}

async function deleteWorkspace(wsId) {
  const ws = wsById(wsId);
  if (!(await confirmDialog({ title: `Delete “${ws.name}”?`, body: 'All of its pages, history and comments are permanently deleted for everyone. This can’t be undone.', confirm: 'Delete workspace', danger: true }))) return;
  try {
    await T.api.del(`/api/workspaces/${wsId}`);
    if (T.current?.page.workspaceId === wsId) showHome();
    await reloadMe();
    toast('Workspace deleted');
  } catch (e) { toast(e.message, { kind: 'error' }); }
}

async function shareDialog(wsId) {
  const ws = wsById(wsId);
  if (!ws) return;
  if (ws.kind === 'private') {
    toast('Your private space is just for you. Use Share on a page to invite people to it.');
    return;
  }
  const owner = ws.role === 'owner';
  const box = h(`<div class="share">
    <div class="share-head"><div><h2>Share “${esc(ws.name)}”</h2><p>Members can see every page here except ones set to “Only people invited”. To share a single page, use Share on that page.</p></div>
      <button class="icon-btn" data-close>${icon('x', 18)}</button></div>
    ${owner ? `<div class="share-invite">
      <div class="share-row"><span class="share-ic">${icon('link', 17)}</span><div class="share-copy"><strong>Invite with a link</strong><span>Anyone with the link can join for 14 days.</span></div>
        <select class="share-role"><option value="editor">Can edit</option><option value="viewer">Can view</option></select>
        <button class="btn primary small" data-invite>Create link</button></div>
      <div class="share-link" hidden><input readonly><button class="btn ghost small" data-copy>${icon('copy', 15)}<span>Copy</span></button></div>
    </div>` : ''}
    <div class="ws-picker"></div>
    <div class="share-members"><div class="pk-label">Members</div><div class="share-list">Loading…</div></div>
  </div>`);
  const m = openModal(box, { className: 'share-modal' });
  let memberIds = new Set();
  if (owner) {
    $('.ws-picker', box).append(h('<div class="pk-label">Add people already on this server</div>'), peoplePicker({
      roles: ['editor', 'viewer', 'owner'],
      button: 'Add',
      exclude: () => memberIds,
      onAdd: async (users, role) => {
        for (const u of users) await T.api.post(`/api/workspaces/${wsId}/members`, { userId: u.id, role });
        toast(users.length === 1 ? `${users[0].name} added to ${ws.name}` : `${users.length} people added to ${ws.name}`, { kind: 'success' });
        renderMembers();
      },
    }));
  }
  $('[data-close]', box).onclick = () => m.close();
  $('[data-invite]', box)?.addEventListener('click', async () => {
    try {
      const r = await T.api.post(`/api/workspaces/${wsId}/invites`, { role: $('.share-role', box).value });
      const link = `${shareBase()}/#/invite/${r.token}`;
      $('.share-link', box).hidden = false;
      $('.share-link input', box).value = link;
      $('.share-link input', box).select();
    } catch (e) { toast(e.message, { kind: 'error' }); }
  });
  $('[data-copy]', box)?.addEventListener('click', () => copy($('.share-link input', box).value, 'Invite link copied'));
  const renderMembers = async () => {
    const { members } = await T.api.get(`/api/workspaces/${wsId}/members`);
    memberIds = new Set(members.map((u) => u.id));
    $('.share-list', box).innerHTML = members.map((u) => `<div class="member" data-user="${u.id}">
      ${avatar(u, 32)}<div class="member-info"><strong>${esc(u.name)}${u.id === T.me.id ? ' <em>(you)</em>' : ''}</strong><span>${esc(u.email)}</span></div>
      ${owner ? `<select data-role>${['owner', 'editor', 'viewer'].map((r) => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}</select>
        ${u.id !== T.me.id ? `<button class="icon-btn" data-remove title="Remove">${icon('x', 16)}</button>` : '<span class="member-gap"></span>'}`
        : `<span class="member-role">${ROLE_LABEL[u.role]}</span>`}
    </div>`).join('');
  };
  box.addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-role]');
    if (!sel) return;
    try { await T.api.patch(`/api/workspaces/${wsId}/members/${sel.closest('[data-user]').dataset.user}`, { role: sel.value }); toast('Role updated', { kind: 'success' }); } catch (err) { toast(err.message, { kind: 'error' }); renderMembers(); }
  });
  box.addEventListener('click', async (e) => {
    const rm = e.target.closest('[data-remove]');
    if (!rm) return;
    try { await T.api.del(`/api/workspaces/${wsId}/members/${rm.closest('[data-user]').dataset.user}`); renderMembers(); } catch (err) { toast(err.message, { kind: 'error' }); }
  });
  renderMembers();
}

async function trashDialog(wsId) {
  const { pages } = await T.api.get(`/api/workspaces/${wsId}/trash`);
  const box = h(`<div class="share"><div class="share-head"><div><h2>Trash</h2><p>Pages deleted from “${esc(wsById(wsId).name)}”.</p></div><button class="icon-btn" data-close>${icon('x', 18)}</button></div>
    <div class="share-list">${pages.length ? pages.map((p) => `<div class="member"><span class="share-ic">${icon('page', 16)}</span><div class="member-info"><strong>${esc(p.title)}</strong><span>Deleted ${timeAgo(p.deletedAt / 1000)}</span></div>
      ${canEdit(wsId) ? `<button class="btn ghost small" data-restore="${p.id}">Restore</button>` : ''}</div>`).join('') : '<p class="bl-empty pad">Trash is empty.</p>'}</div></div>`);
  const m = openModal(box, { className: 'share-modal' });
  $('[data-close]', box).onclick = () => m.close();
  box.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-restore]');
    if (!b) return;
    await T.api.post(`/api/pages/${b.dataset.restore}/restore`);
    await loadPages(wsId);
    renderSidebar();
    m.close();
    openPage(b.dataset.restore);
    toast('Page restored', { kind: 'success' });
  });
}

// Search everyone on this server by name or email, choose a role, and add them.
function peoplePicker({ roles = ['editor', 'viewer'], role = 'editor', button = 'Invite', exclude = () => new Set(), onAdd }) {
  const el = h(`<div class="pp">
    <div class="pp-row">
      <span class="pp-ic">${icon('user-plus', 16)}</span>
      <input class="pp-input" placeholder="Add people by name or email" autocomplete="off" spellcheck="false">
      <select class="pp-role">${roles.map((r) => `<option value="${r}" ${r === role ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}</select>
      <button class="btn primary small" data-add disabled>${esc(button)}</button>
    </div>
    <div class="pp-chips"></div>
    <div class="pp-list" hidden></div>
  </div>`);
  const input = $('.pp-input', el);
  const list = $('.pp-list', el);
  const chips = $('.pp-chips', el);
  const addBtn = $('[data-add]', el);
  let picked = new Map();
  let results = [];
  let active = 0;
  let seq = 0;
  const renderChips = () => {
    chips.innerHTML = [...picked.values()].map((u) => `<span class="pp-chip" data-user="${u.id}">${avatar(u, 18)}<span>${esc(u.name)}</span><button data-unpick title="Remove">${icon('x', 12, 2.2)}</button></span>`).join('');
    addBtn.disabled = !picked.size;
  };
  const renderList = () => {
    list.hidden = !results.length && !input.value.trim();
    list.innerHTML = results.length ? results.map((u, i) => `<button class="pp-item ${i === active ? 'active' : ''}" data-i="${i}">${avatar(u, 26)}<span class="member-info"><strong>${esc(u.name)}</strong><span>${esc(u.email)}</span></span></button>`).join('')
      : `<div class="pp-empty">No one on this server matches “${esc(input.value.trim())}”. Invite them to a workspace with a link first.</div>`;
  };
  const search = async () => {
    const q = input.value.trim();
    const n = ++seq;
    if (!q) { results = []; list.hidden = true; return; }
    const { users } = await T.api.get(`/api/users?q=${encodeURIComponent(q)}`).catch(() => ({ users: [] }));
    if (n !== seq) return;
    const skip = exclude();
    results = users.filter((u) => u.id !== T.me.id && !skip.has(u.id) && !picked.has(u.id)).slice(0, 8);
    active = 0;
    renderList();
  };
  const pick = (u) => {
    if (!u) return;
    picked.set(u.id, u);
    input.value = '';
    results = [];
    list.hidden = true;
    renderChips();
    input.focus();
  };
  let t;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(search, 120); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!results.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      renderList();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results.length && !list.hidden) pick(results[active]);
      else if (picked.size) addBtn.click();
    } else if (e.key === 'Backspace' && !input.value && picked.size) {
      picked.delete([...picked.keys()].pop());
      renderChips();
    } else if (e.key === 'Escape' && !list.hidden) {
      e.stopPropagation();
      list.hidden = true;
    }
  });
  list.addEventListener('mousedown', (e) => { e.preventDefault(); const b = e.target.closest('[data-i]'); if (b) pick(results[+b.dataset.i]); });
  chips.addEventListener('click', (e) => { const b = e.target.closest('[data-unpick]'); if (b) { picked.delete(b.closest('[data-user]').dataset.user); renderChips(); } });
  addBtn.addEventListener('click', async () => {
    if (!picked.size) return;
    addBtn.disabled = true;
    const role = $('.pp-role', el).value;
    try {
      await onAdd([...picked.values()], role);
      picked = new Map();
      renderChips();
    } catch (e) { toast(e.message, { kind: 'error' }); addBtn.disabled = false; }
  });
  el.focus = () => input.focus();
  return el;
}

// Gmail-style "To:" field: chips for people, suggestions from the server and your address book
// as you type, and any full email address can be added (they get an invitation).
function emailPicker({ exclude = () => new Set(), allowNew = true, onChange = () => {} }) {
  const el = h(`<div class="ep">
    <div class="ep-box"><div class="ep-chips"></div><input class="ep-input" placeholder="Add people and emails" autocomplete="off" spellcheck="false"></div>
    <div class="ep-list" hidden></div>
  </div>`);
  const input = $('.ep-input', el);
  const list = $('.ep-list', el);
  const chipsEl = $('.ep-chips', el);
  const picked = new Map(); // email -> person
  let results = [];
  let active = 0;
  let seq = 0;
  const isEmail = (v) => /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/.test(v);
  const label = (p) => p.name || p.email;
  const renderChips = () => {
    chipsEl.innerHTML = [...picked.values()].map((p) => `<span class="ep-chip ${p.onServer ? '' : 'new'}" data-email="${esc(p.email)}" title="${esc(p.onServer ? p.email : `${p.email} will get an invitation`)}">
      ${p.onServer ? avatar(p, 20) : `<span class="ep-mail">${icon('mail', 12)}</span>`}<span>${esc(label(p))}</span><button type="button" data-unpick title="Remove">${icon('x', 12, 2.2)}</button></span>`).join('');
    input.placeholder = picked.size ? '' : 'Add people and emails';
    onChange([...picked.values()]);
  };
  const renderList = () => {
    const q = input.value.trim();
    const typedNew = isEmail(q) && !results.some((r) => r.email === q.toLowerCase());
    const rows = [...results.map((p, i) => `<button type="button" class="ep-item ${i === active ? 'active' : ''}" data-i="${i}">
        ${p.onServer ? avatar(p, 30) : `<span class="ep-av-mail">${icon('mail', 15)}</span>`}
        <span class="ep-who"><strong>${esc(p.name || p.email)}</strong><span>${esc(p.name ? p.email : (p.onServer ? '' : 'Not on Local Notes yet'))}</span></span>
        ${p.onServer ? '' : '<em class="ep-tag">Invite</em>'}</button>`)];
    if (typedNew) rows.unshift(`<button type="button" class="ep-item ${active === -1 ? 'active' : ''}" data-new><span class="ep-av-mail">${icon('mail', 15)}</span><span class="ep-who"><strong>${esc(q)}</strong><span>${allowNew ? 'Send an invitation to this address' : 'Only admins can invite people who aren’t on this server'}</span></span></button>`);
    if (!rows.length && q) rows.push(`<div class="ep-empty">No matches. Type a full email address to invite someone new.</div>`);
    list.innerHTML = rows.join('');
    list.hidden = !rows.length;
  };
  const add = (p) => {
    if (!p?.email) return;
    const email = p.email.toLowerCase();
    if (exclude().has(email) || picked.has(email)) { toast(`${p.name || email} already has access`); return; }
    if (!p.onServer && !allowNew) { toast('Only admins can invite people who aren’t on this server yet', { kind: 'error' }); return; }
    picked.set(email, { ...p, email });
    input.value = '';
    results = [];
    list.hidden = true;
    renderChips();
    input.focus();
  };
  const addTyped = () => {
    const parts = input.value.split(/[,;\s]+/).map((x) => x.replace(/^<|>$/g, '').trim()).filter(Boolean);
    let any = false;
    for (const e of parts) if (isEmail(e)) { const known = results.find((r) => r.email === e.toLowerCase()); add(known || { email: e, name: '', onServer: false }); any = true; }
    return any;
  };
  const search = async () => {
    const q = input.value.trim();
    const n = ++seq;
    const { people } = await T.api.get(`/api/contacts?q=${encodeURIComponent(q)}`).catch(() => ({ people: [] }));
    if (n !== seq) return;
    const skip = exclude();
    results = people.filter((p) => !picked.has(p.email) && !skip.has(p.email));
    active = isEmail(q) && !results.some((r) => r.email === q.toLowerCase()) ? -1 : 0;
    if (!q && !results.length) { list.hidden = true; return; }
    renderList();
  };
  let timer;
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 90); });
  input.addEventListener('blur', () => setTimeout(() => { list.hidden = true; if (isEmail(input.value.trim())) addTyped(); }, 150));
  input.addEventListener('paste', (e) => {
    const text = e.clipboardData.getData('text');
    if (/[,;\n]/.test(text) && /@/.test(text)) { e.preventDefault(); input.value = text; addTyped(); }
  });
  input.addEventListener('keydown', (e) => {
    const hasNew = !!list.querySelector('[data-new]');
    const max = results.length - 1;
    if (e.key === 'ArrowDown' && !list.hidden) { e.preventDefault(); active = Math.min(max, active + 1); renderList(); }
    else if (e.key === 'ArrowUp' && !list.hidden) { e.preventDefault(); active = Math.max(hasNew ? -1 : 0, active - 1); renderList(); }
    else if (e.key === 'Enter' || e.key === 'Tab' || e.key === ',' || e.key === ';') {
      if (!input.value.trim() && e.key === 'Tab') return;
      if (!input.value.trim() && e.key === 'Enter') return;
      e.preventDefault();
      if (!list.hidden && active >= 0 && results[active]) add(results[active]);
      else if (!addTyped() && e.key === 'Enter') toast('Type a full email address, like sam@company.com', { kind: 'error' });
    } else if (e.key === 'Backspace' && !input.value && picked.size) {
      picked.delete([...picked.keys()].pop());
      renderChips();
    } else if (e.key === 'Escape' && !list.hidden) { e.stopPropagation(); list.hidden = true; }
  });
  list.addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (e.target.closest('[data-new]')) { addTyped(); return; }
    const b = e.target.closest('[data-i]');
    if (b) add(results[+b.dataset.i]);
  });
  chipsEl.addEventListener('click', (e) => { const b = e.target.closest('[data-unpick]'); if (b) { picked.delete(b.closest('[data-email]').dataset.email); renderChips(); input.focus(); } });
  el.addEventListener('click', (e) => { if (e.target.closest('.ep-box') && !e.target.closest('button')) input.focus(); });
  el.focus = () => input.focus();
  el.people = () => { addTyped(); return [...picked.values()]; };
  el.clear = () => { picked.clear(); input.value = ''; renderChips(); };
  return el;
}

async function pageShareDialog(pageId) {
  const box = h(`<div class="share gshare">
    <div class="share-head"><div><h2>Share “<span class="ps-title"></span>”</h2></div>
      <button class="icon-btn" data-close title="Close">${icon('x', 18)}</button></div>
    <div class="gs-add"><div class="gs-picker"></div><select class="gs-role" hidden><option value="editor">Editor</option><option value="viewer">Viewer</option></select></div>
    <div class="gs-compose" hidden>
      <label class="gs-notify"><input type="checkbox" checked><span>Notify people</span></label>
      <textarea class="gs-message" rows="3" placeholder="Message (optional)"></textarea>
      <p class="gs-note"></p>
    </div>
    <div class="gs-main">
      <div class="gs-result"></div>
      <div class="pk-label">People with access</div>
      <div class="share-list gs-people"></div>
      <div class="ps-general"></div>
    </div>
    <div class="gs-foot">
      <button class="btn ghost" data-copy-link>${icon('link', 15)}<span>Copy link</span></button>
      <span class="gs-spacer"></span>
      <button class="btn ghost" data-ws-share hidden>${icon('users', 15)}<span></span></button>
      <button class="btn ghost" data-cancel hidden>Cancel</button>
      <button class="btn primary" data-done>Done</button>
    </div>
  </div>`);
  const m = openModal(box, { className: 'share-modal gshare-modal' });
  let data;
  let composing = false;
  const close = () => m.close();
  $('[data-close]', box).onclick = close;
  $('[data-copy-link]', box).onclick = () => copyLink(pageId);
  const setCompose = (on) => {
    composing = on;
    $('.gs-compose', box).hidden = !on;
    $('.gs-main', box).hidden = on;
    $('.gs-role', box).hidden = !on;
    $('[data-cancel]', box).hidden = !on;
    $('[data-copy-link]', box).hidden = on;
    $('[data-ws-share]', box).hidden = on || !data || data.workspace.kind === 'private' || !wsById(data.workspace.id);
    $('[data-done]', box).textContent = on ? ($('.gs-notify input', box).checked ? 'Send' : 'Share') : 'Done';
  };
  const changed = async () => {
    T.people.delete(pageId);
    if (data?.workspace.id) await refreshWs(data.workspace.id).catch(() => {});
    renderSidebar();
    await render();
  };
  const picker = emailPicker({
    exclude: () => new Set([...(data?.people || []).filter((u) => u.via !== 'member').map((u) => u.email), ...(data?.pending || []).map((x) => x.email), T.me.email]),
    allowNew: true,
    onChange: (people) => setCompose(people.length > 0),
  });
  $('.gs-picker', box).append(picker);

  const render = async () => {
    try { data = await T.api.get(`/api/pages/${pageId}/access`); } catch (e) { toast(e.message, { kind: 'error' }); close(); return; }
    const page = findPage(pageId) || T.current?.page;
    $('.ps-title', box).textContent = page?.title || 'Untitled';
    const ws = data.workspace;
    const priv = ws.kind === 'private';
    const restricted = data.mode === 'restricted' || !!data.restrictedBy;
    $('.gs-add', box).hidden = !data.canShare;
    $('.gs-note', box).textContent = data.emailOn ? 'People get an email with a link. People without an account get an invitation to join.'
      : 'Email isn’t set up on this server, so people are notified inside Local Notes. People without an account get an invitation link to send them yourself.';
    // people
    const listed = data.people.filter((u) => u.via !== 'member' || restricted || priv);
    const rest = data.people.length - listed.length;
    const roleCell = (u) => {
      if (u.removable && data.canManage) return `<select data-share-role>${['editor', 'viewer'].map((r) => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${r === 'editor' ? 'Editor' : 'Viewer'}</option>`).join('')}<option value="remove">Remove access</option></select>`;
      if (u.removable && u.id === T.me.id) return `<span class="member-role">${u.role === 'editor' ? 'Editor' : 'Viewer'}</span><button class="icon-btn" data-unshare title="Remove yourself">${icon('logout', 15)}</button>`;
      return `<span class="member-role">${u.role === 'owner' ? 'Owner' : u.role === 'editor' ? 'Editor' : 'Viewer'}</span>`;
    };
    const why = (u) => (u.inheritedFrom ? `${esc(u.email)} · from “${esc(u.inheritedFrom)}”` : u.via === 'link' ? `${esc(u.email)} · opened with the link` : esc(u.email || ''));
    $('.gs-people', box).innerHTML = listed.map((u) => `<div class="member" data-user="${u.id}">
        ${avatar(u, 32)}<div class="member-info"><strong>${esc(u.name)}${u.id === T.me.id ? ' <em>(you)</em>' : ''}</strong><span>${why(u)}</span></div>${roleCell(u)}</div>`).join('')
      + (data.pending || []).map((x) => `<div class="member pending" data-invite="${esc(x.email)}">
        <span class="ep-av-mail big">${icon('mail', 15)}</span><div class="member-info"><strong>${esc(x.email)}</strong><span>Invited · hasn’t joined yet</span></div>
        ${data.canManage ? `<select data-invite-role>${['editor', 'viewer'].map((r) => `<option value="${r}" ${r === x.role ? 'selected' : ''}>${r === 'editor' ? 'Editor' : 'Viewer'}</option>`).join('')}<option value="copy">Copy invitation link</option><option value="remove">Cancel invitation</option></select>` : `<span class="member-role">${x.role === 'editor' ? 'Editor' : 'Viewer'}</span>`}</div>`).join('')
      + (rest > 0 ? `<div class="member everyone"><span class="share-ic">${icon('library', 17)}</span><div class="member-info"><strong>Everyone in ${esc(ws.name)}</strong><span>${rest} more ${rest === 1 ? 'person' : 'people'}</span></div><span class="member-role">From workspace</span></div>` : '');
    // general access
    const gen = $('.ps-general', box);
    const current = data.linkRole ? 'link' : priv || restricted ? 'restricted' : 'workspace';
    const opts = [['restricted', priv ? 'Restricted' : 'Only people invited'], ...(priv ? [] : [['workspace', `Everyone in ${ws.name}`]]), ['link', 'Anyone with the link']];
    const desc = {
      restricted: priv ? 'Only people with access can open it' : 'Only the people above can open it. Hidden from the rest of the workspace.',
      workspace: `Everyone in ${ws.name} can open it (${ws.members} member${ws.members === 1 ? '' : 's'})`,
      link: `Anyone on this server who has the link can ${data.linkRole === 'editor' ? 'edit' : 'view'}${priv ? '' : `, plus everyone in ${ws.name}`}`,
    };
    if (data.restrictedBy && !data.linkRole) {
      gen.innerHTML = `<div class="pk-label">General access</div><div class="ga-row"><span class="ga-ic restricted">${icon('lock', 17)}</span><div class="member-info"><strong>Only people invited</strong><span>Set on the parent page “${esc(data.restrictedBy.title)}”.</span></div><button class="btn ghost small" data-open-parent="${data.restrictedBy.id}">Open</button></div>`;
    } else {
      gen.innerHTML = `<div class="pk-label">General access</div><div class="ga-row"><span class="ga-ic ${current === 'restricted' ? 'restricted' : current === 'link' ? 'link' : ''}">${icon(current === 'link' ? 'globe' : current === 'restricted' ? 'lock' : 'library', 17)}</span>
        <div class="member-info">${data.canManage ? `<select data-general>${opts.map(([k, l]) => `<option value="${k}" ${k === current ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>` : `<strong>${esc(opts.find(([k]) => k === current)?.[1] || '')}</strong>`}
        <span>${esc(desc[current])}</span></div>
        ${current === 'link' && data.canManage ? `<select data-link-role class="ga-role"><option value="viewer" ${data.linkRole === 'viewer' ? 'selected' : ''}>Viewer</option><option value="editor" ${data.linkRole === 'editor' ? 'selected' : ''}>Editor</option></select>` : ''}</div>
        ${data.linkInheritedFrom && !data.linkRole ? `<p class="gs-hint">${icon('info', 13)}Anyone with the link to “${esc(data.linkInheritedFrom.title)}” can also open this page.</p>` : ''}`;
    }
    const wsBtn = $('[data-ws-share]', box);
    $('span', wsBtn).textContent = 'Workspace members';
    setCompose(composing);
  };

  const send = async () => {
    const people = picker.people();
    if (!people.length) return;
    const btn = $('[data-done]', box);
    btn.disabled = true;
    try {
      const r = await T.api.post(`/api/pages/${pageId}/shares`, {
        people: people.map((p) => (p.id ? { userId: p.id } : { email: p.email, name: p.name })),
        role: $('.gs-role', box).value,
        notify: $('.gs-notify input', box).checked,
        message: $('.gs-message', box).value,
        baseUrl: shareBase(),
      });
      const errors = r.results.filter((x) => x.error);
      const invitedNoEmail = r.results.filter((x) => x.invited && !x.emailed);
      const sharedCount = r.results.filter((x) => x.shared || x.invited).length;
      picker.clear();
      $('.gs-message', box).value = '';
      await changed();
      if (sharedCount) toast(sharedCount === 1 ? `Shared with ${r.results.find((x) => x.shared || x.invited).name || r.results.find((x) => x.shared || x.invited).email}` : `Shared with ${sharedCount} people`, { kind: 'success' });
      if (errors.length) toast(errors.map((x) => `${x.email}: ${x.error}`).join('\n'), { kind: 'error', timeout: 8000 });
      $('.gs-result', box).innerHTML = invitedNoEmail.length ? `<div class="adm-link pop"><div class="adm-link-head">${icon('mail', 16)}<strong>Send ${invitedNoEmail.length === 1 ? 'this invitation' : 'these invitations'} yourself</strong></div>
        <p>${r.emailOn ? 'The email couldn’t be sent.' : 'Email isn’t set up on this server.'} Copy the link and send it by email or chat. It works for 30 days.</p>
        ${invitedNoEmail.map((x) => `<div class="gs-invite"><span>${esc(x.email)}</span><div class="share-link"><input readonly value="${esc(x.link)}"><button class="btn primary small" data-copy-text="${esc(x.link)}">${icon('copy', 15)}<span>Copy</span></button></div></div>`).join('')}</div>` : '';
    } catch (e) { toast(e.message, { kind: 'error' }); }
    btn.disabled = false;
  };

  box.addEventListener('change', async (e) => {
    if (e.target.closest('.gs-notify')) { setCompose(composing); return; }
    const sel = e.target.closest('[data-share-role]');
    const inv = e.target.closest('[data-invite-role]');
    const gen = e.target.closest('[data-general]');
    const lr = e.target.closest('[data-link-role]');
    try {
      if (sel) {
        const uid = sel.closest('[data-user]').dataset.user;
        if (sel.value === 'remove') await T.api.del(`/api/pages/${pageId}/shares/${uid}`);
        else await T.api.patch(`/api/pages/${pageId}/shares/${uid}`, { role: sel.value });
        toast(sel.value === 'remove' ? 'Access removed' : 'Access updated', { kind: 'success' });
        await changed();
      }
      if (inv) {
        const email = inv.closest('[data-invite]').dataset.invite;
        if (inv.value === 'copy') { const r = await T.api.post(`/api/pages/${pageId}/invites/link`, { email, baseUrl: shareBase() }); await copy(r.link, 'Invitation link copied'); }
        else if (inv.value === 'remove') { await T.api.del(`/api/pages/${pageId}/invites?email=${encodeURIComponent(email)}`); toast('Invitation cancelled'); }
        else { await T.api.patch(`/api/pages/${pageId}/invites`, { email, role: inv.value }); toast('Invitation updated', { kind: 'success' }); }
        await changed();
      }
      if (gen) {
        const priv = data.workspace.kind === 'private';
        const body = gen.value === 'link' ? { linkRole: data.linkRole || 'viewer', ...(priv ? {} : { mode: 'workspace' }) }
          : { linkRole: null, ...(priv ? {} : { mode: gen.value }) };
        await T.api.put(`/api/pages/${pageId}/access`, body);
        toast(gen.value === 'link' ? 'Anyone with the link can now open this page' : gen.value === 'restricted' ? 'Now only invited people can open this page' : 'Everyone in the workspace can open this page', { kind: 'success' });
        await changed();
      }
      if (lr) { await T.api.put(`/api/pages/${pageId}/access`, { linkRole: lr.value }); toast(`Anyone with the link can ${lr.value === 'editor' ? 'edit' : 'view'}`, { kind: 'success' }); await changed(); }
    } catch (err) { toast(err.message, { kind: 'error' }); render(); }
  });
  box.addEventListener('click', async (e) => {
    const parent = e.target.closest('[data-open-parent]');
    if (parent) { close(); openPage(parent.dataset.openParent); return; }
    const ct = e.target.closest('[data-copy-text]');
    if (ct) { copy(ct.dataset.copyText, 'Link copied'); return; }
    if (e.target.closest('[data-ws-share]')) { close(); shareDialog(data.workspace.id); return; }
    if (e.target.closest('[data-cancel]')) { picker.clear(); return; }
    if (e.target.closest('[data-done]')) { if (composing) send(); else close(); return; }
    const rm = e.target.closest('[data-unshare]');
    if (!rm) return;
    const uid = rm.closest('[data-user]').dataset.user;
    if (uid === T.me.id && !(await confirmDialog({ title: 'Remove your access?', body: 'You won’t be able to open this page until someone shares it with you again.', confirm: 'Remove', danger: true }))) return;
    try {
      await T.api.del(`/api/pages/${pageId}/shares/${uid}`);
      if (uid === T.me.id) { close(); await loadShared(); renderSidebar(); checkCurrent(); return; }
      await changed();
    } catch (err) { toast(err.message, { kind: 'error' }); }
  });
  await render();
  setTimeout(() => picker.focus(), 40);
}

// Workspaces a page can be moved into: ones where you can add pages, other than its own.
const moveTargets = (p) => T.workspaces.filter((w) => w.id !== p.workspaceId && canEdit(w.id));

function moveMenu(pageId, anchor) {
  const p = findPage(pageId) || T.current?.page;
  if (!p) return;
  showMenu([
    { header: 'Move to' },
    ...moveTargets(p).map((w) => ({ label: w.kind === 'private' ? 'Private' : w.name, icon: w.kind === 'private' ? 'lock' : 'library', run: () => movePage(p, w) })),
  ], anchor);
}

async function movePage(p, ws) {
  const kids = childrenOf(sectionOf(p), p.id).length;
  const into = ws.kind === 'private' ? 'your private space' : `“${ws.name}”`;
  const body = ws.kind === 'private' ? `${kids ? 'It and its subpages' : 'It'} will be visible only to you and anyone it’s shared with.`
    : `Everyone in ${ws.name} will be able to see ${kids ? 'it and its subpages' : 'it'}, unless it’s set to “Only people invited”.`;
  if (!(await confirmDialog({ title: `Move “${p.title}” to ${into}?`, body: `${body} History and comments move with it.`, confirm: 'Move' }))) return;
  try {
    await T.api.post(`/api/pages/${p.id}/move`, { workspaceId: ws.id });
    T.collapsedWs.delete(ws.id);
    persist();
    await Promise.all([refreshWs(p.workspaceId), loadPages(ws.id)]);
    renderSidebar();
    toast(`Moved to ${ws.kind === 'private' ? 'Private' : ws.name}`, { kind: 'success' });
    if (T.current && (T.current.page.id === p.id || !findPage(T.current.page.id) || findPage(T.current.page.id).workspaceId !== T.current.page.workspaceId)) openPage(T.current.page.id, { replace: true });
  } catch (e) { toast(e.message, { kind: 'error' }); }
}

// ================================================================== pages
async function createPage(wsId, parentId = null, title = 'Untitled') {
  if (!wsId) return;
  if (parentId ? !canEditPage(findPage(parentId)) : !canEdit(wsId)) { toast(parentId ? 'You have view-only access to this page' : 'You have view-only access to this workspace'); return; }
  try {
    const r = await T.api.post(`/api/workspaces/${wsId}/pages`, { title, parentId });
    T.collapsedWs.delete(wsById(wsId) ? wsId : SHARED);
    if (parentId) T.expanded.add(parentId);
    persist();
    await refreshWs(wsId);
    renderSidebar();
    await openPage(r.page.id, { fresh: title === 'Untitled' });
  } catch (e) { toast(e.message, { kind: 'error' }); }
}

async function deletePage(id) {
  const p = findPage(id);
  const kids = childrenOf(sectionOf(p), id).length;
  if (!(await confirmDialog({ title: `Move “${p.title}” to trash?`, body: `${kids ? 'This page and its subpages' : 'This page'} will move to the workspace trash. Anyone in the workspace can restore it.`, confirm: 'Move to trash', danger: true }))) return;
  try {
    await T.api.del(`/api/pages/${id}`);
    if (T.current?.page.id === id || isDescendant(T.current?.page.id, id)) showHome();
    await refreshWs(p.workspaceId);
    renderSidebar();
  } catch (e) { toast(e.message, { kind: 'error' }); }
}

function isDescendant(id, ancestor) {
  let p = id && findPage(id);
  while (p?.parentId) { if (p.parentId === ancestor) return true; p = findPage(p.parentId); }
  return false;
}

function closePage() {
  const c = T?.current;
  if (!c) return;
  closeFindBar();
  pushMarkdown(true);
  c.provider.destroy();
  c.editor.destroy();
  c.doc.destroy();
  c.bubble.remove();
  T.current = null;
}

async function openPage(id, { replace = false, fresh = false, thread = null } = {}) {
  let data;
  try { data = await T.api.get(`/api/pages/${id}`); } catch (e) { toast(e.message, { kind: 'error' }); return; }
  closePage();
  hideGraph();
  const editable = data.role !== 'viewer';
  const doc = new Y.Doc();
  const user = { id: T.me.id, name: T.me.name, color: T.me.color };
  const c = { page: data.page, role: data.role, markdown: data.markdown, updatedByName: data.updatedByName, doc, threads: [], dirty: false };
  T.current = c;
  c.provider = new HocuspocusProvider({
    url: T.api.wsUrl,
    name: `page:${id}`,
    document: doc,
    token: T.conn.token,
    onStatus: ({ status }) => { if (T?.current === c) setLive(status); },
    onSynced: () => { if (T?.current === c) seed(c); },
    onAuthenticationFailed: async () => {
      if (T?.current !== c) return;
      await Promise.all([...T.workspaces.map((w) => loadPages(w.id)), loadShared()]).catch(() => {});
      renderSidebar();
      if (T?.current === c && !checkCurrent()) { toast('You no longer have access to this page', { kind: 'error' }); showHome(); }
    },
  });
  c.bubble = buildBubble(c);
  const el = $('#t-editor', T.root);
  el.innerHTML = '';
  c.editor = createEditor({
    element: el,
    bubble: c.bubble,
    editable,
    handleSelector: '#t-block-handle',
    collab: { doc, provider: c.provider, user },
    onUpdate: (_ed, tr) => {
      if (tr?.getMeta(ySyncPluginKey)?.isChangeOrigin) return;
      schedulePush();
    },
  });
  c.editor.on('selectionUpdate', () => syncBubble(c));
  c.provider.awareness?.on('change', () => { if (T?.current === c) renderPresence(); });
  el.onclick = (e) => {
    const mark = e.target.closest('.comment-mark');
    if (mark) openDrawer('comments').then(() => focusThread(mark.dataset.thread));
  };

  $('#t-home', T.root).hidden = true;
  const page = $('#t-page', T.root);
  page.hidden = false;
  page.classList.remove('enter');
  void page.offsetWidth;
  page.classList.add('enter');
  const title = $('#t-title', T.root);
  title.textContent = data.page.title === 'Untitled' && fresh ? '' : data.page.title;
  title.contentEditable = editable ? 'plaintext-only' : 'false';
  T.root.classList.toggle('read-only', !editable);
  $('#t-ro', T.root).hidden = editable;
  for (const b of ['#t-comments', '#t-history', '#t-more']) $(b, T.root).hidden = false;
  $('#t-share', T.root).hidden = false;
  renderCrumbs();
  renderMeta();
  renderPresence();
  setLive('connecting');
  markActive();
  revealInTree(id);
  history[replace ? 'replaceState' : 'pushState'](null, '', `#/p/${id}`);
  store.set(`ln:team:${T.conn.url}:last`, id);
  $('#t-scroller', T.root).scrollTop = 0;
  loadThreads().then(async () => { if (thread) { await openDrawer('comments'); focusThread(thread); } });
  renderLinks();
  if (T.drawer === 'history') renderHistory();
  if (fresh) { title.focus(); }
}

// A page created with markdown (e.g. from a template or the first run) gets its shared
// document filled once, by the first editor that opens it.
function seed(c) {
  const meta = c.doc.getMap('meta');
  if (meta.get('seeded')) return;
  const frag = c.doc.getXmlFragment('default');
  if (c.role === 'viewer') return;
  c.doc.transact(() => meta.set('seeded', true));
  if (frag.length === 0 && c.markdown.trim()) c.editor.commands.setContent(c.markdown);
}

let pushTimer = null;
function schedulePush() {
  const c = T?.current;
  if (!c || c.role === 'viewer') return;
  c.dirty = true;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => pushMarkdown(), 1200);
}

function pushMarkdown(now = false) {
  const c = T?.current;
  if (!c?.dirty) return;
  clearTimeout(pushTimer);
  c.dirty = false;
  const markdown = getMarkdown(c.editor);
  const req = T.api.put(`/api/pages/${c.page.id}/markdown`, { markdown }).catch(() => { c.dirty = true; });
  if (now) return req;
  return req;
}

function setLive(status) {
  const el = $('#t-live', T.root);
  el.hidden = false;
  el.dataset.state = status;
  el.innerHTML = status === 'connected' ? '<i></i>Live' : status === 'connecting' ? '<i></i>Connecting…' : '<i></i>Offline — changes will sync';
}

function renderCrumbs() {
  const c = T.current;
  const ws = wsById(c.page.workspaceId);
  const chain = [];
  let p = findPage(c.page.parentId);
  while (p) { chain.unshift(p); p = findPage(p.parentId); }
  const mine = findPage(c.page.id);
  const root = ws ? `<span class="crumb">${icon(ws.kind === 'private' ? 'lock' : 'library', 14)}<span>${esc(ws.kind === 'private' ? 'Private' : ws.name)}</span></span>`
    : `<span class="crumb" title="${esc(mine?.workspaceName ? `From ${mine.workspaceName}` : '')}">${icon('users', 14)}<span>Shared with me</span></span>`;
  $('#t-crumbs', T.root).innerHTML = [
    `${root}<span class="crumb-sep">/</span>`,
    ...chain.map((x) => `<button class="crumb" data-open="${x.id}">${icon('page', 14)}<span>${esc(x.title)}</span></button><span class="crumb-sep">/</span>`),
    `<span class="crumb current">${icon('page', 14)}<span>${esc(c.page.title || 'Untitled')}</span></span>`,
  ].join('');
}

async function renderMeta() {
  const c = T.current;
  if (!c) return;
  const people = await loadPeople(c.page.id).catch(() => []);
  const by = people.find((u) => u.id === c.page.updatedBy);
  $('#t-meta', T.root).innerHTML = `${by ? avatar(by, 18) : ''}<span>${by ? `${esc(by.id === T.me.id ? 'You' : by.name)} edited` : 'Edited'} ${timeAgo(c.page.updatedAt / 1000)}</span>`;
}

function syncCurrentMeta() {
  const fresh = findPage(T.current.page.id);
  if (!fresh) return;
  const titleChanged = fresh.title !== T.current.page.title;
  Object.assign(T.current.page, fresh);
  if (titleChanged && document.activeElement !== $('#t-title', T.root)) $('#t-title', T.root).textContent = fresh.title;
  renderCrumbs();
}

function renderPresence() {
  const c = T.current;
  const el = $('#t-presence', T.root);
  if (!c?.provider.awareness) { el.innerHTML = ''; return; }
  const seen = new Map();
  for (const [clientId, state] of c.provider.awareness.getStates()) {
    if (clientId === c.doc.clientID || !state.user) continue;
    if (state.user.id !== T.me.id) seen.set(state.user.id || state.user.name, state.user);
  }
  const users = [...seen.values()];
  el.innerHTML = users.slice(0, 4).map((u) => avatar(u, 26)).join('') + (users.length > 4 ? `<span class="avatar more" style="--s:26px">+${users.length - 4}</span>` : '');
  el.title = users.length ? `${users.map((u) => u.name).join(', ')} ${users.length === 1 ? 'is' : 'are'} here` : '';
}

function revealInTree(id) {
  let p = findPage(id);
  let changed = false;
  if (p && T.collapsedWs.has(sectionOf(p))) { T.collapsedWs.delete(sectionOf(p)); changed = true; }
  while (p?.parentId) { if (!T.expanded.has(p.parentId)) { T.expanded.add(p.parentId); changed = true; } p = findPage(p.parentId); }
  if (changed) { persist(); renderSidebar(); }
  markActive();
  T.root.querySelector(`#t-tree .row[data-page="${id}"]`)?.scrollIntoView({ block: 'nearest' });
}

async function renderLinks() {
  const c = T.current;
  const el = $('#t-links', T.root);
  el.innerHTML = '';
  let data;
  try { data = await T.api.get(`/api/pages/${c.page.id}/links`); } catch { return; }
  if (T.current !== c) return;
  const wiki = (s) => esc(s).replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '<span class="bl-link">$2</span>').replace(/\[\[([^\]]+)\]\]/g, '<span class="bl-link">$1</span>');
  el.innerHTML = `
    ${data.children.length ? `<section class="pl-sec"><h3>${icon('book', 15)}Subpages<span class="pl-count">${data.children.length}</span></h3>
      <div class="sub-grid">${data.children.map((p) => `<button class="sub-card" data-open="${p.id}">${icon('page', 16)}<span>${esc(p.title)}</span></button>`).join('')}
      ${c.role !== 'viewer' ? `<button class="sub-card add" data-subpage>${icon('plus', 16)}<span>Add subpage</span></button>` : ''}</div></section>` : ''}
    <section class="pl-sec"><h3>${icon('page-link', 15)}Linked mentions<span class="pl-count">${data.linked.length}</span></h3>
      ${data.linked.length ? `<div class="bl-list">${data.linked.map((m) => `<button class="bl-item" data-open="${m.id}"><span class="bl-title">${icon('page', 15)}<span>${esc(m.title)}</span></span>${m.snippets.map((s) => `<span class="bl-snippet">${wiki(s)}</span>`).join('')}</button>`).join('')}</div>`
        : `<p class="bl-empty">No other pages link here yet. Type <kbd>[[</kbd> in any page in this workspace to link to it.</p>`}
    </section>`;
}

function wireTitle() {
  const t = $('#t-title', T.root);
  let timer;
  const commit = async () => {
    clearTimeout(timer);
    const c = T.current;
    if (!c || c.role === 'viewer') return;
    const title = t.textContent.replace(/\s+/g, ' ').trim() || 'Untitled';
    if (title === c.page.title) return;
    c.page.title = title;
    const p = findPage(c.page.id);
    if (p) p.title = title;
    renderCrumbs();
    try { await T.api.patch(`/api/pages/${c.page.id}`, { title }); } catch (e) { toast(e.message, { kind: 'error' }); }
  };
  t.addEventListener('input', () => {
    const c = T.current;
    if (!c) return;
    const row = T.root.querySelector(`#t-tree .row[data-page="${c.page.id}"] .row-label`);
    if (row) row.textContent = t.textContent.trim() || 'Untitled';
    clearTimeout(timer);
    timer = setTimeout(commit, 700);
  });
  t.addEventListener('blur', commit);
  t.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); T.current?.editor.commands.focus('start'); }
  });
  t.addEventListener('paste', (e) => { e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain').replace(/\n+/g, ' ')); });
}

function pageMenu(anchor) {
  const c = T.current;
  if (!c) return;
  const edit = c.role !== 'viewer';
  showMenu([
    { label: 'Share…', icon: 'user-plus', run: () => pageShareDialog(c.page.id) },
    ...(edit && moveTargets(c.page).length ? [{ label: 'Move to…', icon: 'move', run: () => moveMenu(c.page.id, anchor) }] : []),
    { label: 'Copy link', icon: 'link', run: () => copyLink(c.page.id) },
    { label: 'Copy as markdown', icon: 'code', run: () => copy(getMarkdown(c.editor), 'Markdown copied') },
    { label: 'Export…', icon: 'file-down', run: () => showMenu([{ header: 'Export as' }, ...exportMenuItems(() => ({ editor: c.editor, title: c.page.title, markdown: getMarkdown(c.editor) }))], anchor, { align: 'end' }) },
    { label: 'Print…', icon: 'printer', run: () => printPage({ editor: c.editor, title: c.page.title }) },
    { label: 'Find in page', icon: 'search', hint: `${modKey}+F`, run: () => openFindBar(c.editor) },
    ...(edit ? [{ label: 'Find and replace', icon: 'replace', hint: `${modKey}+H`, run: () => openFindBar(c.editor, { replace: true }) }] : []),
    { label: 'Version history', icon: 'clock', run: () => openDrawer('history') },
    { label: 'Summarize with AI', icon: 'sparkles', run: () => summarizePage(c.editor, 'summary') },
    { label: 'Find action items with AI', icon: 'todo', run: () => summarizePage(c.editor, 'actions') },
    { label: 'Open local graph', icon: 'graph', run: () => showGraph(c.page.workspaceId, c.page.id) },
    ...(edit ? ['sep', { label: 'Move to trash', icon: 'trash', danger: true, run: () => deletePage(c.page.id) }] : []),
  ], anchor, { align: 'end' });
}

const copy = (text, msg) => copyText(text).then((ok) => toast(ok ? msg : 'Couldn’t copy — select the text and press Ctrl+C', { kind: ok ? 'success' : 'error' }));
const copyLink = (id) => copy(`${shareBase()}/#/p/${id}`, 'Link copied');

// ================================================================== bubble menu (format + comment)
function buildBubble(c) {
  const el = h(`<div class="bubble pop">
    <button data-cmd="ai" class="bb-ai" title="Ask AI (${modKey}+J)">${icon('sparkles', 15)}<span class="bb-text">Ask AI</span></button>
    <span class="bb-sep"></span>
    <button data-cmd="comment" class="bb-comment" title="Comment (${modKey}+Alt+M)">${icon('note', 16, 2)}<span class="bb-text">Comment</span></button>
    <span class="bb-sep"></span>
    ${formatButtons(modKey)}
    <span class="bb-sep"></span>
    <button data-cmd="link" title="Link">${icon('link', 16, 2)}</button>
  </div>`);
  el.addEventListener('mousedown', (e) => e.preventDefault());
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cmd]');
    if (!b) return;
    const ch = c.editor.chain().focus();
    if (runFormat(c.editor, b.dataset.cmd, b)) { syncBubble(c); return; }
    switch (b.dataset.cmd) {
      case 'comment': startComment(); break;
      case 'ai': openAIMenu(c.editor, b); break;
      case 'link': {
        const href = prompt('Link address', c.editor.getAttributes('link').href || 'https://');
        if (href === null) break;
        if (!href.trim()) ch.extendMarkRange('link').unsetLink().run(); else ch.extendMarkRange('link').setLink({ href: href.trim() }).run();
        break;
      }
      default:
    }
    syncBubble(c);
  });
  return el;
}

function syncBubble(c) {
  syncFormat(c.editor, c.bubble);
  c.bubble.querySelector('[data-cmd="link"]')?.classList.toggle('on', c.editor.isActive('link'));
  const commentBtn = c.bubble.querySelector('[data-cmd="comment"]');
  commentBtn.hidden = c.role === 'viewer';
  c.bubble.querySelectorAll('[data-cmd]:not([data-cmd="comment"]), .bb-sep').forEach((b) => { b.hidden = c.role === 'viewer'; });
}

// ================================================================== comments
async function loadThreads() {
  const c = T.current;
  if (!c) return;
  try { c.threads = (await T.api.get(`/api/pages/${c.page.id}/threads`)).threads; } catch { return; }
  if (T.current !== c) return;
  const open = c.threads.filter((t) => !t.resolvedAt).length;
  const badge = $('#t-ccount', T.root);
  badge.hidden = !open;
  badge.textContent = open;
  // resolved threads lose their highlight
  let style = $('#t-comment-style');
  if (!style) { style = h('<style id="t-comment-style"></style>'); document.head.append(style); }
  style.textContent = c.threads.filter((t) => t.resolvedAt).map((t) => `.comment-mark[data-thread="${CSS.escape(t.id)}"]`).join(',') + (c.threads.some((t) => t.resolvedAt) ? '{background:none;border-bottom:0;cursor:text}' : '');
  if (T.drawer === 'comments') renderComments();
}

function startComment() {
  const c = T.current;
  if (!c || c.role === 'viewer') return;
  const { from, to, empty } = c.editor.state.selection;
  if (empty) { toast('Select some text to comment on'); return; }
  const quote = c.editor.state.doc.textBetween(from, to, ' ').slice(0, 300);
  const id = `t${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  c.editor.chain().setMark('comment', { thread: id }).setTextSelection(to).run();
  c.pendingThread = { id, quote };
  openDrawer('comments');
}

function removeThreadMark(threadId) {
  const c = T.current;
  if (!c) return;
  const type = c.editor.schema.marks.comment;
  const { tr } = c.editor.state;
  c.editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return;
    const m = node.marks.find((x) => x.type === type && x.attrs.thread === threadId);
    if (m) tr.removeMark(pos, pos + node.nodeSize, m);
  });
  if (tr.docChanged) c.editor.view.dispatch(tr);
}

function focusThread(id) {
  const card = $(`.thread[data-thread="${CSS.escape(id)}"]`, T.root);
  if (!card) return;
  T.root.querySelectorAll('.thread.focus').forEach((x) => x.classList.remove('focus'));
  card.classList.add('focus');
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function commentBody(text, people) {
  let out = esc(text);
  for (const p of people) out = out.split(`@${esc(p.name)}`).join(`<span class="mention" style="--c:${p.color}">@${esc(p.name)}</span>`);
  return out.replace(/\n/g, '<br>');
}

async function renderComments() {
  const c = T.current;
  const d = $('#t-drawer', T.root);
  if (!c) { d.innerHTML = drawerHead('Comments') + '<p class="bl-empty pad">Open a page to see its comments.</p>'; return; }
  const people = await loadPeople(c.page.id).catch(() => []);
  const show = d.dataset.filter || 'open';
  const threads = c.threads.filter((t) => (show === 'open' ? !t.resolvedAt : !!t.resolvedAt));
  const personOf = (id) => people.find((p) => p.id === id) || { name: 'Former member', color: '#999' };
  d.innerHTML = `${drawerHead('Comments', `<div class="seg"><button data-filter="open" class="${show === 'open' ? 'on' : ''}">Open</button><button data-filter="resolved" class="${show === 'resolved' ? 'on' : ''}">Resolved</button></div>`)}
    <div class="drawer-body">
      ${c.pendingThread ? `<div class="thread new focus" data-thread="${c.pendingThread.id}">
        <div class="thread-quote">${esc(c.pendingThread.quote)}</div>
        ${composer('Add a comment… use @ to mention')}
      </div>` : ''}
      ${threads.length ? threads.map((t) => `<div class="thread ${t.resolvedAt ? 'resolved' : ''}" data-thread="${t.id}">
        <div class="thread-top"><div class="thread-quote">${esc(t.quote || 'Comment')}</div>
          ${c.role !== 'viewer' ? `<button class="icon-btn tiny" data-resolve title="${t.resolvedAt ? 'Reopen' : 'Resolve'}">${icon(t.resolvedAt ? 'arrow-up-right' : 'check', 15, 2)}</button>` : ''}</div>
        ${t.comments.map((m) => { const u = personOf(m.userId); return `<div class="cmt">${avatar(u, 24)}<div class="cmt-main"><div class="cmt-head"><strong>${esc(u.name)}</strong><span>${timeAgo(m.createdAt / 1000)}</span>
          ${m.userId === T.me.id ? `<button class="cmt-del" data-del="${m.id}" title="Delete">${icon('trash', 13)}</button>` : ''}</div><div class="cmt-body">${commentBody(m.body, people)}</div></div></div>`; }).join('')}
        ${c.role !== 'viewer' && !t.resolvedAt ? composer('Reply…', true) : ''}
      </div>`).join('') : (c.pendingThread ? '' : `<div class="drawer-empty">${icon('note', 28, 1.4)}<strong>${show === 'open' ? 'No open comments' : 'Nothing resolved yet'}</strong><span>${show === 'open' ? 'Select text and press Comment to start a discussion.' : ''}</span></div>`)}
    </div>`;
  d.querySelector('.thread.new textarea')?.focus();
}

const composer = (placeholder, reply = false) => `<div class="composer ${reply ? 'reply' : ''}"><textarea rows="${reply ? 1 : 2}" placeholder="${esc(placeholder)}"></textarea>
  <div class="composer-actions">${reply ? '' : '<button class="btn ghost small" data-cancel>Cancel</button>'}<button class="btn primary small" data-send>${reply ? 'Reply' : 'Comment'}</button></div></div>`;

function wireDrawer() {
  const d = $('#t-drawer', T.root);
  d.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close-drawer]')) return closeDrawer();
    const filt = e.target.closest('[data-filter]');
    if (filt) { d.dataset.filter = filt.dataset.filter; return renderComments(); }
    const c = T.current;
    const thread = e.target.closest('.thread');
    if (e.target.closest('[data-cancel]') && c?.pendingThread) {
      removeThreadMark(c.pendingThread.id);
      c.pendingThread = null;
      return renderComments();
    }
    if (e.target.closest('[data-send]')) return sendComment(thread);
    if (e.target.closest('[data-resolve]')) {
      const t = c.threads.find((x) => x.id === thread.dataset.thread);
      await T.api.patch(`/api/threads/${t.id}`, { resolved: !t.resolvedAt });
      return loadThreads();
    }
    const del = e.target.closest('[data-del]');
    if (del) { await T.api.del(`/api/comments/${del.dataset.del}`); return loadThreads(); }
    if (thread && !e.target.closest('textarea, button') && c) {
      const el = c.editor.view.dom.querySelector(`.comment-mark[data-thread="${CSS.escape(thread.dataset.thread)}"]`);
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      focusThread(thread.dataset.thread);
    }
    // history
    const v = e.target.closest('[data-version]');
    if (v) return previewVersion(Number(v.dataset.version));
    if (e.target.closest('[data-save-version]')) return saveVersion();
    // inbox
    const n = e.target.closest('[data-notif]');
    if (n) return openNotification(n.dataset);
    if (e.target.closest('[data-read-all]')) { await T.api.post('/api/notifications/read', {}); T.unread = 0; renderBadge(); return renderInbox(); }
    return undefined;
  });
  d.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'TEXTAREA' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendComment(e.target.closest('.thread')); }
    if (e.target.tagName === 'TEXTAREA' && e.key === 'Escape' && T.current?.pendingThread) { removeThreadMark(T.current.pendingThread.id); T.current.pendingThread = null; renderComments(); }
  });
  d.addEventListener('input', (e) => {
    if (e.target.tagName !== 'TEXTAREA') return;
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(200, e.target.scrollHeight)}px`;
    mentionPopup(e.target);
  });
}

// @mention autocomplete inside comment boxes
let mentionEl = null;
async function mentionPopup(ta) {
  mentionEl?.remove();
  mentionEl = null;
  const before = ta.value.slice(0, ta.selectionStart);
  const m = before.match(/(^|\s)@([\w .'-]{0,30})$/);
  if (!m || !T.current) return;
  const q = m[2].toLowerCase();
  const people = (await loadPeople(T.current.page.id)).filter((p) => p.id !== T.me.id && p.name.toLowerCase().startsWith(q)).slice(0, 6);
  if (!people.length) return;
  mentionEl = h(`<div class="suggest pop mention-pop">${people.map((p, i) => `<button class="suggest-item compact ${i ? '' : 'active'}" data-i="${i}">${avatar(p, 20)}<span class="si-title">${esc(p.name)}</span></button>`).join('')}</div>`);
  document.body.append(mentionEl);
  const r = ta.getBoundingClientRect();
  mentionEl.style.left = `${r.left}px`;
  mentionEl.style.top = `${r.bottom + 6}px`;
  const pick = (p) => {
    // re-read the text: the person may have kept typing since the list opened
    const cur = ta.value.slice(0, ta.selectionStart).match(/@([\w .'-]{0,30})$/);
    const start = cur ? ta.selectionStart - cur[0].length : ta.selectionStart;
    ta.value = `${ta.value.slice(0, start)}@${p.name} ${ta.value.slice(ta.selectionStart)}`;
    ta.selectionStart = ta.selectionEnd = start + p.name.length + 2;
    ta.focus();
    mentionEl?.remove();
    mentionEl = null;
  };
  mentionEl.addEventListener('mousedown', (e) => { e.preventDefault(); const b = e.target.closest('[data-i]'); if (b) pick(people[+b.dataset.i]); });
  const onKey = (e) => {
    if (!mentionEl) { ta.removeEventListener('keydown', onKey, true); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); pick(people[0]); ta.removeEventListener('keydown', onKey, true); }
    if (e.key === 'Escape') { mentionEl.remove(); mentionEl = null; }
  };
  ta.addEventListener('keydown', onKey, true);
}

async function sendComment(thread) {
  const c = T.current;
  if (!c || !thread) return;
  const ta = thread.querySelector('textarea');
  const body = ta.value.trim();
  if (!body) return;
  const people = await loadPeople(c.page.id);
  const mentions = people.filter((p) => body.includes(`@${p.name}`)).map((p) => p.id);
  try {
    if (thread.classList.contains('new')) {
      await T.api.post(`/api/pages/${c.page.id}/threads`, { id: c.pendingThread.id, quote: c.pendingThread.quote, body, mentions });
      c.pendingThread = null;
    } else {
      await T.api.post(`/api/threads/${thread.dataset.thread}/comments`, { body, mentions });
    }
    await loadThreads();
  } catch (e) { toast(e.message, { kind: 'error' }); }
}

// ================================================================== drawers: comments / history / inbox
const drawerHead = (title, extra = '') => `<div class="drawer-head"><h3>${title}</h3>${extra}<button class="icon-btn" data-close-drawer title="Close">${icon('x', 17)}</button></div>`;

function toggleDrawer(name) { if (T.drawer === name) closeDrawer(); else openDrawer(name); }

async function openDrawer(name) {
  const d = $('#t-drawer', T.root);
  if (!d.dataset.wired) { wireDrawer(); d.dataset.wired = '1'; }
  T.drawer = name;
  d.hidden = false;
  T.root.classList.add('drawer-open');
  for (const [k, sel] of [['comments', '#t-comments'], ['history', '#t-history']]) $(sel, T.root).classList.toggle('on', k === name);
  if (name === 'comments') await renderComments();
  if (name === 'history') await renderHistory();
  if (name === 'inbox') await renderInbox();
}

function closeDrawer() {
  const c = T.current;
  if (c?.pendingThread) { removeThreadMark(c.pendingThread.id); c.pendingThread = null; }
  T.drawer = null;
  $('#t-drawer', T.root).hidden = true;
  T.root.classList.remove('drawer-open');
  $('#t-comments', T.root).classList.remove('on');
  $('#t-history', T.root).classList.remove('on');
}

async function renderHistory() {
  const c = T.current;
  const d = $('#t-drawer', T.root);
  if (!c) { d.innerHTML = drawerHead('Version history') + '<p class="bl-empty pad">Open a page to see its history.</p>'; return; }
  const [{ versions }, people] = await Promise.all([T.api.get(`/api/pages/${c.page.id}/versions`), loadPeople(c.page.id)]);
  if (T.drawer !== 'history' || T.current !== c) return;
  const day = (ts) => new Date(ts).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  let last = '';
  d.innerHTML = `${drawerHead('Version history')}
    <div class="drawer-body">
      ${c.role !== 'viewer' ? `<button class="btn ghost small save-ver" data-save-version>${icon('check', 14, 2)}<span>Save a named version</span></button>` : ''}
      <p class="drawer-hint">A version is saved automatically every 10 minutes while people edit.</p>
      ${versions.length ? versions.map((v) => {
        const d0 = day(v.createdAt);
        const head = d0 !== last ? `<div class="ver-day">${d0}</div>` : '';
        last = d0;
        const authors = v.authors.map((id) => people.find((p) => p.id === id)).filter(Boolean);
        return `${head}<button class="ver" data-version="${v.id}">
          <span class="ver-time">${new Date(v.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
          ${v.label ? `<span class="ver-label">${esc(v.label)}</span>` : ''}
          <span class="ver-authors">${authors.map((a) => avatar(a, 18)).join('')}<span>${esc(authors.map((a) => a.name.split(' ')[0]).join(', '))}</span></span>
        </button>`;
      }).join('') : `<div class="drawer-empty">${icon('clock', 28, 1.4)}<strong>No versions yet</strong><span>Versions appear here as the page is edited.</span></div>`}
    </div>`;
}

async function saveVersion() {
  const c = T.current;
  const label = prompt('Name this version (optional)', '');
  if (label === null) return;
  await pushMarkdown(true);
  await T.api.post(`/api/pages/${c.page.id}/versions`, { label });
  toast('Version saved', { kind: 'success' });
  renderHistory();
}

async function previewVersion(id) {
  const v = await T.api.get(`/api/versions/${id}`);
  const c = T.current;
  const html = md.render(v.markdown.replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => `**${b || a}**`));
  const box = h(`<div class="ver-preview">
    <div class="share-head"><div><h2>${esc(v.title)}</h2><p>${new Date(v.createdAt).toLocaleString()}${v.label ? ` · ${esc(v.label)}` : ''}</p></div><button class="icon-btn" data-close>${icon('x', 18)}</button></div>
    <div class="ver-doc prose">${html || '<p class="bl-empty">This version was empty.</p>'}</div>
    <div class="ver-foot"><span>Restoring replaces the page for everyone. The current text is saved as a version first.</span>
      ${c?.role !== 'viewer' ? `<button class="btn primary" data-restore>${icon('clock', 16)}<span>Restore this version</span></button>` : ''}</div>
  </div>`);
  const m = openModal(box, { className: 'ver-modal' });
  $('[data-close]', box).onclick = () => m.close();
  $('[data-restore]', box)?.addEventListener('click', async () => {
    await pushMarkdown(true);
    await T.api.post(`/api/pages/${c.page.id}/versions`, { label: 'Before restore' });
    c.editor.commands.setContent(v.markdown, true);
    await pushMarkdown(true);
    m.close();
    toast('Version restored', { kind: 'success' });
    renderHistory();
  });
}

async function renderInbox() {
  const d = $('#t-drawer', T.root);
  const { notifications } = await T.api.get('/api/notifications');
  if (T.drawer !== 'inbox') return;
  const verb = { mention: 'mentioned you in', reply: 'replied in', joined: 'joined', shared: 'shared', added: 'added you to' };
  const byWs = (k) => k === 'joined' || k === 'added';
  d.innerHTML = `${drawerHead('Inbox', notifications.some((n) => !n.readAt) ? '<button class="link-btn small" data-read-all>Mark all read</button>' : '')}
    <div class="drawer-body">
      ${notifications.length ? notifications.map((n) => `<button class="notif ${n.readAt ? '' : 'unread'}" data-notif data-id="${n.id}" data-page="${n.pageId || ''}" data-thread="${n.threadId || ''}">
        ${avatar({ name: n.actorName, color: n.actorColor }, 30)}
        <span class="notif-main"><span class="notif-line"><strong>${esc(n.actorName || 'Someone')}</strong> ${verb[n.kind] || ''} <strong>${esc(byWs(n.kind) ? n.workspaceName || '' : n.pageTitle || 'a page')}</strong>${n.kind === 'shared' ? ' with you' : ''}</span>
          ${n.text && !byWs(n.kind) && !(n.kind === 'shared' && /shared “/.test(n.text)) ? `<span class="notif-text">${esc(n.text)}</span>` : ''}
          <span class="notif-time">${timeAgo(n.createdAt / 1000)}${n.workspaceName ? ` · ${esc(n.workspaceName)}` : ''}</span></span>
      </button>`).join('') : `<div class="drawer-empty">${icon('note', 28, 1.4)}<strong>You’re all caught up</strong><span>Mentions, replies and pages shared with you show up here.</span></div>`}
    </div>`;
}

async function openNotification({ id, page, thread }) {
  T.api.post('/api/notifications/read', { ids: [id] }).then(async () => { T.unread = (await T.api.get('/api/me')).unread; renderBadge(); });
  if (page && findPage(page)) await openPage(page, { thread: thread || null });
  else renderInbox();
}

// ================================================================== home, search, graph
function showHome() {
  closePage();
  closeDrawer();
  hideGraph();
  history.replaceState(null, '', '#');
  $('#t-page', T.root).hidden = true;
  $('#t-home', T.root).hidden = false;
  for (const b of ['#t-comments', '#t-history', '#t-more', '#t-share', '#t-ro', '#t-live']) $(b, T.root).hidden = true;
  $('#t-presence', T.root).innerHTML = '';
  $('#t-crumbs', T.root).innerHTML = `<span class="crumb current">${icon('home', 15)}<span>Home</span></span>`;
  markActive();
  renderHome();
}

function renderHome() {
  const all = [...T.pages.entries()].flatMap(([ws, list]) => list.map((p) => ({ ...p, ws: wsById(ws) }))).filter((p) => p.ws);
  const recent = all.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8);
  const hr = new Date().getHours();
  const greet = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  const teams = T.workspaces.filter((w) => w.kind === 'team');
  const hue = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 0);
  $('#t-home', T.root).innerHTML = `<div class="home-inner">
    <div class="home-date">${esc(new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }))}</div>
    <h1 class="home-title">${greet}, ${esc(T.me.name.split(' ')[0])}</h1>
    <div class="home-stats"><span>${icon('drive', 15)}${esc(T.api.base.replace(/^https?:\/\//, ''))}</span><span>${teams.length} team workspace${teams.length === 1 ? '' : 's'}</span><span>${all.length} pages</span></div>
    <div class="home-actions">
      <button class="action" data-act="new"><span class="action-icon">${icon('file-plus', 18)}</span><span><strong>New team page</strong><em>${esc(firstTeamWs()?.name || '')}</em></span></button>
      <button class="action" data-act="private"><span class="action-icon">${icon('lock', 18)}</span><span><strong>Private page</strong><em>Only you can see it</em></span></button>
      <button class="action" data-act="search"><span class="action-icon">${icon('search', 18)}</span><span><strong>Search</strong><em>${modKey}+K</em></span></button>
      <button class="action" data-act="invite"><span class="action-icon">${icon('arrow-up-right', 18)}</span><span><strong>Invite people</strong><em>Share a workspace</em></span></button>
    </div>
    ${recent.length ? `<section class="home-sec"><h2>${icon('clock', 15)}Recently updated</h2><div class="cards">${recent.map((p) => `<button class="card" data-open="${p.id}" style="--hue:${hue(p.title)}">
      <span class="card-cover"></span><span class="card-icon">${icon('page', 18)}</span><span class="card-title">${esc(p.title)}</span>
      <span class="card-meta">${icon(p.ws.kind === 'private' ? 'lock' : 'library', 12)}<span>${esc(p.ws.kind === 'private' ? 'Private' : p.ws.name)}</span><i>·</i><span>${timeAgo(p.updatedAt / 1000)}</span></span></button>`).join('')}</div></section>` : ''}
  </div>`;
}

function openSearch() {
  const box = h(`<div class="palette">
    <div class="pl-input">${icon('search', 18)}<input placeholder="Search all your workspaces…" spellcheck="false"><kbd>esc</kbd></div>
    <div class="pl-results"></div>
    <div class="pl-foot"><span><kbd>↑</kbd><kbd>↓</kbd>Navigate</span><span><kbd>↵</kbd>Open</span></div></div>`);
  const modal = openModal(box, { className: 'palette-modal' });
  const input = $('input', box);
  const results = $('.pl-results', box);
  let items = [];
  let index = 0;
  let seq = 0;
  const all = () => [...T.pages.entries()].flatMap(([ws, list]) => list.map((p) => ({ ...p, ws: wsById(ws) }))).filter((p) => p.ws);
  const wsLabel = (w) => (w.kind === 'private' ? 'Private' : w.name);
  const render = (q, content = []) => {
    const ql = q.toLowerCase().trim();
    const names = (ql ? all().filter((p) => p.title.toLowerCase().includes(ql)) : all().sort((a, b) => b.updatedAt - a.updatedAt)).slice(0, 10);
    const seen = new Set(names.map((p) => p.id));
    const extra = content.filter((r) => !seen.has(r.id));
    items = [...names.map((p) => p.id), ...extra.map((r) => r.id)];
    results.innerHTML = (names.length ? `<div class="pl-group">${ql ? 'Pages' : 'Recent'}</div>${names.map((p, i) => `<button class="pl-item" data-i="${i}"><span class="pl-icon">${icon('page', 17)}</span><span class="pl-body"><span class="pl-title">${esc(p.title)}</span>${content.find((r) => r.id === p.id)?.snippet ? `<span class="pl-snippet">${esc(content.find((r) => r.id === p.id).snippet)}</span>` : ''}</span><span class="pl-folder">${esc(wsLabel(p.ws))}</span></button>`).join('')}` : '')
      + (extra.length ? `<div class="pl-group">Mentions in content</div>${extra.map((r, j) => `<button class="pl-item" data-i="${names.length + j}"><span class="pl-icon">${icon('text', 17)}</span><span class="pl-body"><span class="pl-title">${esc(r.title)}</span><span class="pl-snippet">${esc(r.snippet)}</span></span><span class="pl-folder">${esc(wsLabel(r.ws))}</span></button>`).join('')}` : '')
      || `<div class="pl-empty">${icon('search', 26, 1.4)}<span>No pages match “${esc(q)}”</span></div>`;
    index = Math.min(index, Math.max(0, items.length - 1));
    results.querySelectorAll('.pl-item').forEach((b) => b.classList.toggle('active', +b.dataset.i === index));
  };
  const go = (i) => { const id = items[i]; if (!id) return; modal.close(); openPage(id); };
  input.addEventListener('input', () => {
    const q = input.value;
    index = 0;
    render(q);
    if (q.trim().length < 2) return;
    const my = ++seq;
    setTimeout(async () => {
      if (my !== seq) return;
      const res = await Promise.all(T.workspaces.map((w) => T.api.get(`/api/workspaces/${w.id}/search?q=${encodeURIComponent(q)}`).then((r) => r.results.map((x) => ({ ...x, ws: w }))).catch(() => [])));
      if (my === seq) render(q, res.flat());
    }, 180);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); index = (index + 1) % Math.max(1, items.length); render(input.value); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); index = (index - 1 + items.length) % Math.max(1, items.length); render(input.value); }
    else if (e.key === 'Enter') { e.preventDefault(); go(index); }
  });
  results.addEventListener('click', (e) => { const b = e.target.closest('.pl-item'); if (b) go(+b.dataset.i); });
  render('');
  input.focus();
}

async function showGraph(wsId = null, focus = null) {
  const ws = wsById(wsId || T.current?.page.workspaceId) || firstTeamWs() || T.workspaces[0];
  let data;
  try { data = await T.api.get(`/api/workspaces/${ws.id}/graph`); } catch (e) { toast(e.message, { kind: 'error' }); return; }
  const from = focus || T.current?.page.id;
  closePage();
  closeDrawer();
  $('#t-page', T.root).hidden = true;
  $('#t-home', T.root).hidden = true;
  for (const b of ['#t-comments', '#t-history', '#t-more', '#t-share', '#t-ro', '#t-live']) $(b, T.root).hidden = true;
  $('#t-crumbs', T.root).innerHTML = `<span class="crumb current">${icon('graph', 15)}<span>${esc(focus ? `Local graph · ${findPage(focus)?.title || ''}` : `Graph · ${ws.kind === 'private' ? 'Private' : ws.name}`)}</span></span>`;
  const gv = $('#t-graph', T.root);
  gv.hidden = false;
  const folders = [...new Set(data.nodes.filter((n) => !n.unresolved).map((n) => n.folder))].sort();
  setFolders(folders);
  gv.innerHTML = `<canvas class="gv-canvas"></canvas>
    <div class="gv-panel pop"><div class="gv-search">${icon('search', 15)}<input placeholder="Filter pages…" spellcheck="false"></div>
      <div class="gv-ws">${T.workspaces.map((w) => `<button class="${w.id === ws.id ? 'on' : ''}" data-gws="${w.id}">${esc(w.kind === 'private' ? 'Private' : w.name)}</button>`).join('')}</div>
      <div class="gv-stats">${data.nodes.filter((n) => !n.unresolved).length} pages · ${data.edges.length} links</div></div>
    <div class="gv-legend">${folders.filter(Boolean).map((f) => `<span><i style="background:${folderColor(f, document.documentElement.dataset.theme === 'dark')}"></i>${esc(f)}</span>`).join('')}</div>
    <div class="gv-zoom"><button class="icon-btn" data-z="in">${icon('zoom-in', 17)}</button><button class="icon-btn" data-z="out">${icon('zoom-out', 17)}</button><button class="icon-btn" data-z="fit">${icon('fit', 17)}</button></div>`;
  T.graph?.destroy();
  T.graph = mountGraph($('.gv-canvas', gv), data, { current: from, focus, onOpen: (id) => openPage(id) });
  $('.gv-search input', gv).addEventListener('input', (e) => T.graph.setFilter({ query: e.target.value }));
  gv.querySelector('.gv-ws').addEventListener('click', (e) => { const b = e.target.closest('[data-gws]'); if (b) showGraph(b.dataset.gws); });
  gv.querySelector('.gv-zoom').addEventListener('click', (e) => {
    const z = e.target.closest('[data-z]')?.dataset.z;
    if (z === 'in') T.graph.zoom(1.4); else if (z === 'out') T.graph.zoom(1 / 1.4); else if (z === 'fit') T.graph.fit();
  });
}

function hideGraph() {
  T?.graph?.destroy();
  if (T) T.graph = null;
  const gv = T && $('#t-graph', T.root);
  if (gv) { gv.hidden = true; gv.innerHTML = ''; }
}

export const teamActive = () => !!T;
// Save the open team page's markdown copy now (before the app quits).
export async function flushTeam() { if (T?.current) await pushMarkdown(true); }
