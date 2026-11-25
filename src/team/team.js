// Team mode: shared workspaces on a Local Notes team server, with a private space per
// person, live co-editing, comments with @mentions, version history and an inbox.
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { ySyncPluginKey } from 'y-prosemirror';
import MarkdownIt from 'markdown-it';
import { createEditor, host, getMarkdown } from '../editor.js';
import { icon, logo } from '../icons.js';
import { $, h, esc, showMenu, openModal, confirmDialog, toast, store, timeAgo, modKey } from '../ui.js';
import { mountGraph, setFolders, folderColor } from '../graph.js';
import { teamClient, normalizeUrl, saveTeam, forgetTeam, savedTeams } from './client.js';

let T = null; // the running team session
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
const initials = (name) => (name || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const avatar = (u, size = 24) => `<span class="avatar" style="--c:${esc(u?.color || '#999')};--s:${size}px" title="${esc(u?.name || '')}">${esc(initials(u?.name))}</span>`;
const ROLE_LABEL = { owner: 'Owner', editor: 'Can edit', viewer: 'Can view' };

// ================================================================== sign in
export async function showTeamSignIn({ hosted = false, url = '', invite = null, onBack = null } = {}) {
  const root = mountRoot();
  let info = null;
  let mode = 'login';
  const serverUrl = () => (hosted ? location.origin : normalizeUrl($('[name=server]', root)?.value || url));

  async function loadInfo() {
    info = null;
    const base = serverUrl();
    if (!base) return render();
    try {
      info = await teamClient({ url: base }).get('/api/team/info');
      if (!info.hasUsers) mode = 'signup';
      if (invite) {
        try { info.invite = await teamClient({ url: base }).get(`/api/invites/${invite}`); mode = 'signup'; } catch (e) { info.inviteError = e.message; }
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
            <label class="field"><span>Email</span><input name="email" type="email" autocomplete="email" placeholder="you@company.com"></label>
            <label class="field"><span>Password</span><input name="password" type="password" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}" placeholder="${mode === 'signup' ? 'At least 8 characters' : ''}"></label>
            <button class="btn primary large auth-submit" type="submit">${mode === 'signup' ? (first ? 'Create admin account' : 'Create account') : 'Sign in'}</button>
          </form>
          ${first ? '' : `<div class="auth-switch">${mode === 'signup' ? 'Already have an account?' : 'New here?'} <button class="link-btn" data-mode>${mode === 'signup' ? 'Sign in' : 'Create an account'}</button></div>`}
        </div>
        <p class="auth-foot">${icon('info', 14)}<span>Your private space is only visible to you. Team workspaces are shared with the people you invite.</span></p>
      </div>`;
    for (const [k, v] of Object.entries(kept)) { const i = $(`.auth-form [name=${k}]`, root); if (i && k !== 'server') i.value = v; }
    $('[data-mode]', root)?.addEventListener('click', () => { mode = mode === 'signup' ? 'login' : 'signup'; render(); });
    $('.auth-back', root)?.addEventListener('click', () => { root.remove(); onBack(); });
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
        const r = await api.post(mode === 'signup' ? '/api/auth/signup' : '/api/auth/login', { ...f, invite });
        const conn = { url: base, token: r.token, user: r.user };
        saveTeam(conn);
        if (invite && hosted) history.replaceState(null, '', '#');
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
    me: me.user, workspaces: me.workspaces, unread: me.unread,
    pages: new Map(), roles: new Map(), people: new Map(),
    expanded: new Set(store.get(`ln:team:${conn.url}:expanded`, [])),
    collapsedWs: new Set(store.get(`ln:team:${conn.url}:collapsed`, [])),
    current: null, drawer: null, graph: null,
  };
  saveTeam({ ...conn, user: me.user });
  installHost();
  buildShell();
  await Promise.all(T.workspaces.map((w) => loadPages(w.id)));
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
const canEdit = (wsId) => ['owner', 'editor'].includes(wsById(wsId)?.role);
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
async function loadPeople(wsId) {
  if (!T.people.has(wsId)) T.people.set(wsId, (await T.api.get(`/api/workspaces/${wsId}/people`)).people);
  return T.people.get(wsId);
}
async function reloadMe() {
  const me = await T.api.get('/api/me');
  T.me = me.user;
  T.workspaces = me.workspaces;
  T.unread = me.unread;
  for (const id of [...T.pages.keys()]) if (!wsById(id)) T.pages.delete(id);
  await Promise.all(T.workspaces.filter((w) => !T.pages.has(w.id)).map((w) => loadPages(w.id)));
  renderSidebar();
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
    if (ev.type === 'tree') {
      await loadPages(ev.workspaceId);
      renderSidebar();
      if (T.current && !findPage(T.current.page.id)) { toast('This page was moved to trash'); showHome(); return; }
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
      T.people.delete(ev.workspaceId);
      await reloadMe();
    }
  };
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
    else if (nav === 'home') showHome();
    else if (nav === 'graph') showGraph();
    else if (nav === 'new-ws') newWorkspace();
  });
  $('#t-account', T.root).onclick = (e) => accountMenu(e.currentTarget);
  $('#t-collapse', T.root).onclick = () => document.body.classList.add('sidebar-collapsed');
  $('#t-expand', T.root).onclick = () => document.body.classList.remove('sidebar-collapsed');
  $('#t-share', T.root).onclick = () => T.current && shareDialog(T.current.page.workspaceId);
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
  return (T.pages.get(wsId) || []).filter((p) => (p.parentId || null) === parentId).sort((a, b) => a.position - b.position);
}

function treeRows(wsId, parentId, depth) {
  return childrenOf(wsId, parentId).map((p) => {
    const kids = childrenOf(wsId, p.id);
    const open = T.expanded.has(p.id);
    const active = T.current?.page.id === p.id;
    let html = `<div class="row note ${kids.length ? 'has-sub' : ''} ${open ? 'open' : ''} ${active ? 'active' : ''}" data-page="${p.id}" data-ws="${wsId}" draggable="${canEdit(wsId)}" style="--depth:${depth}">
      <span class="twisty">${kids.length ? icon('chevron-right', 14, 2) : ''}</span>
      <span class="row-icon">${icon(kids.length ? 'book' : 'page', 16)}</span>
      <span class="row-label">${esc(p.title || 'Untitled')}</span>
      <span class="row-actions">
        <button class="row-btn" data-act="more" title="More">${icon('more', 15)}</button>
        ${canEdit(wsId) ? `<button class="row-btn" data-act="add" title="Add a subpage">${icon('plus', 15)}</button>` : ''}
      </span></div>`;
    if (kids.length && open) html += `<div class="children">${treeRows(wsId, p.id, depth + 1)}</div>`;
    return html;
  }).join('');
}

function renderSidebar() {
  const el = $('#t-tree', T.root);
  el.innerHTML = T.workspaces.map((w) => {
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
  }).join('');
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
      if (btn.dataset.act === 'add') { T.expanded.add(row.dataset.page); createPage(row.dataset.ws, row.dataset.page); }
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
  showMenu([
    { header: 'Appearance' },
    { label: 'System', icon: 'monitor', checked: prefs.theme === 'system', run: () => set('system') },
    { label: 'Light', icon: 'sun', checked: prefs.theme === 'light', run: () => set('light') },
    { label: 'Dark', icon: 'moon', checked: prefs.theme === 'dark', run: () => set('dark') },
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
  const edit = canEdit(p.workspaceId);
  showMenu([
    ...(edit ? [{ label: 'Add subpage', icon: 'file-plus', run: () => { T.expanded.add(p.id); createPage(p.workspaceId, p.id); } }] : []),
    { label: 'Copy link', icon: 'link', run: () => copyLink(p.id) },
    { label: 'Copy as wikilink', icon: 'page-link', run: () => copy(`[[${p.title}]]`, 'Wikilink copied') },
    ...(edit ? ['sep', { label: 'Move to trash', icon: 'trash', danger: true, run: () => deletePage(p.id) }] : []),
  ], anchor);
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
    toast('Pages in your private space are only visible to you. Move a page to a team workspace to share it.');
    return;
  }
  const owner = ws.role === 'owner';
  const box = h(`<div class="share">
    <div class="share-head"><div><h2>Share “${esc(ws.name)}”</h2><p>Everyone here can see every page in this workspace.</p></div>
      <button class="icon-btn" data-close>${icon('x', 18)}</button></div>
    ${owner ? `<div class="share-invite">
      <div class="share-row"><span class="share-ic">${icon('link', 17)}</span><div class="share-copy"><strong>Invite with a link</strong><span>Anyone with the link can join for 14 days.</span></div>
        <select class="share-role"><option value="editor">Can edit</option><option value="viewer">Can view</option></select>
        <button class="btn primary small" data-invite>Create link</button></div>
      <div class="share-link" hidden><input readonly><button class="btn ghost small" data-copy>${icon('copy', 15)}<span>Copy</span></button></div>
    </div>` : ''}
    <div class="share-members"><div class="pk-label">Members</div><div class="share-list">Loading…</div></div>
  </div>`);
  const m = openModal(box, { className: 'share-modal' });
  $('[data-close]', box).onclick = () => m.close();
  $('[data-invite]', box)?.addEventListener('click', async () => {
    try {
      const r = await T.api.post(`/api/workspaces/${wsId}/invites`, { role: $('.share-role', box).value });
      const link = `${T.api.base}/#/invite/${r.token}`;
      $('.share-link', box).hidden = false;
      $('.share-link input', box).value = link;
      $('.share-link input', box).select();
    } catch (e) { toast(e.message, { kind: 'error' }); }
  });
  $('[data-copy]', box)?.addEventListener('click', () => copy($('.share-link input', box).value, 'Invite link copied'));
  const renderMembers = async () => {
    const { members } = await T.api.get(`/api/workspaces/${wsId}/members`);
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

// ================================================================== pages
async function createPage(wsId, parentId = null, title = 'Untitled') {
  if (!wsId) return;
  if (!canEdit(wsId)) { toast('You have view-only access to this workspace'); return; }
  try {
    const r = await T.api.post(`/api/workspaces/${wsId}/pages`, { title, parentId });
    T.collapsedWs.delete(wsId);
    if (parentId) T.expanded.add(parentId);
    persist();
    await loadPages(wsId);
    renderSidebar();
    await openPage(r.page.id, { fresh: title === 'Untitled' });
  } catch (e) { toast(e.message, { kind: 'error' }); }
}

async function deletePage(id) {
  const p = findPage(id);
  const kids = childrenOf(p.workspaceId, id).length;
  if (!(await confirmDialog({ title: `Move “${p.title}” to trash?`, body: `${kids ? 'This page and its subpages' : 'This page'} will move to the workspace trash. Anyone in the workspace can restore it.`, confirm: 'Move to trash', danger: true }))) return;
  try {
    await T.api.del(`/api/pages/${id}`);
    if (T.current?.page.id === id || isDescendant(T.current?.page.id, id)) showHome();
    await loadPages(p.workspaceId);
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
    onAuthenticationFailed: () => { if (T?.current === c) toast('You no longer have access to this page', { kind: 'error' }); },
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
  $('#t-share', T.root).hidden = wsById(data.page.workspaceId)?.kind === 'private';
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
  $('#t-crumbs', T.root).innerHTML = [
    `<span class="crumb">${icon(ws?.kind === 'private' ? 'lock' : 'library', 14)}<span>${esc(ws?.kind === 'private' ? 'Private' : ws?.name || '')}</span></span><span class="crumb-sep">/</span>`,
    ...chain.map((x) => `<button class="crumb" data-open="${x.id}">${icon('page', 14)}<span>${esc(x.title)}</span></button><span class="crumb-sep">/</span>`),
    `<span class="crumb current">${icon('page', 14)}<span>${esc(c.page.title || 'Untitled')}</span></span>`,
  ].join('');
}

async function renderMeta() {
  const c = T.current;
  if (!c) return;
  const people = await loadPeople(c.page.workspaceId).catch(() => []);
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
  if (p && T.collapsedWs.has(p.workspaceId)) { T.collapsedWs.delete(p.workspaceId); changed = true; }
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
      ${canEdit(c.page.workspaceId) ? `<button class="sub-card add" data-subpage>${icon('plus', 16)}<span>Add subpage</span></button>` : ''}</div></section>` : ''}
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
    { label: 'Copy link', icon: 'link', run: () => copyLink(c.page.id) },
    { label: 'Copy as markdown', icon: 'code', run: () => copy(getMarkdown(c.editor), 'Markdown copied') },
    { label: 'Version history', icon: 'clock', run: () => openDrawer('history') },
    { label: 'Open local graph', icon: 'graph', run: () => showGraph(c.page.workspaceId, c.page.id) },
    ...(edit ? ['sep', { label: 'Move to trash', icon: 'trash', danger: true, run: () => deletePage(c.page.id) }] : []),
  ], anchor, { align: 'end' });
}

const copy = (text, msg) => navigator.clipboard?.writeText(text).then(() => toast(msg, { kind: 'success' }), () => toast('Clipboard unavailable', { kind: 'error' }));
const copyLink = (id) => copy(`${T.api.base}/#/p/${id}`, 'Link copied');

// ================================================================== bubble menu (format + comment)
function buildBubble(c) {
  const el = h(`<div class="bubble pop">
    <button data-cmd="comment" class="bb-comment" title="Comment (${modKey}+Alt+M)">${icon('note', 16, 2)}<span class="bb-text">Comment</span></button>
    <span class="bb-sep"></span>
    <button data-cmd="bold" title="Bold">${icon('bold', 16, 2.2)}</button>
    <button data-cmd="italic" title="Italic">${icon('italic', 16, 2)}</button>
    <button data-cmd="strike" title="Strikethrough">${icon('strike', 16, 2)}</button>
    <button data-cmd="code" title="Inline code">${icon('code', 16, 2)}</button>
    <button data-cmd="highlight" title="Highlight">${icon('highlight', 16, 2)}</button>
    <button data-cmd="link" title="Link">${icon('link', 16, 2)}</button>
  </div>`);
  el.addEventListener('mousedown', (e) => e.preventDefault());
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cmd]');
    if (!b) return;
    const ch = c.editor.chain().focus();
    switch (b.dataset.cmd) {
      case 'comment': startComment(); break;
      case 'bold': ch.toggleBold().run(); break;
      case 'italic': ch.toggleItalic().run(); break;
      case 'strike': ch.toggleStrike().run(); break;
      case 'code': ch.toggleCode().run(); break;
      case 'highlight': ch.toggleHighlight().run(); break;
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
  for (const k of ['bold', 'italic', 'strike', 'code', 'highlight', 'link']) c.bubble.querySelector(`[data-cmd="${k}"]`)?.classList.toggle('on', c.editor.isActive(k));
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
  const people = await loadPeople(c.page.workspaceId).catch(() => []);
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
  const people = (await loadPeople(T.current.page.workspaceId)).filter((p) => p.id !== T.me.id && p.name.toLowerCase().startsWith(q)).slice(0, 6);
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
  const people = await loadPeople(c.page.workspaceId);
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
  const [{ versions }, people] = await Promise.all([T.api.get(`/api/pages/${c.page.id}/versions`), loadPeople(c.page.workspaceId)]);
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
  const verb = { mention: 'mentioned you in', reply: 'replied in', joined: 'joined' };
  d.innerHTML = `${drawerHead('Inbox', notifications.some((n) => !n.readAt) ? '<button class="link-btn small" data-read-all>Mark all read</button>' : '')}
    <div class="drawer-body">
      ${notifications.length ? notifications.map((n) => `<button class="notif ${n.readAt ? '' : 'unread'}" data-notif data-id="${n.id}" data-page="${n.pageId || ''}" data-thread="${n.threadId || ''}">
        ${avatar({ name: n.actorName, color: n.actorColor }, 30)}
        <span class="notif-main"><span class="notif-line"><strong>${esc(n.actorName || 'Someone')}</strong> ${verb[n.kind] || ''} <strong>${esc(n.kind === 'joined' ? n.workspaceName || '' : n.pageTitle || 'a page')}</strong></span>
          ${n.text && n.kind !== 'joined' ? `<span class="notif-text">${esc(n.text)}</span>` : ''}
          <span class="notif-time">${timeAgo(n.createdAt / 1000)}${n.workspaceName ? ` · ${esc(n.workspaceName)}` : ''}</span></span>
      </button>`).join('') : `<div class="drawer-empty">${icon('note', 28, 1.4)}<strong>You’re all caught up</strong><span>Mentions and replies show up here.</span></div>`}
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
