// REST API for the team server. JSON in/out, Bearer-token auth.
import fs from 'node:fs';
import path from 'node:path';
import { newId, now } from './db.js';
import { hashPassword, checkPassword, newToken, hashToken, pickColor, rateLimit } from './auth.js';
import { subscribe, sendTo } from './events.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

const ROLES = ['owner', 'editor', 'viewer'];
const VERSION_EVERY = 10 * 60 * 1000;
const MAX_VERSIONS = 300;

export function createApi({ db, config, collab }) {
  // ---------------------------------------------------------------- helpers
  const userPublic = (u) => u && ({ id: u.id, name: u.name, email: u.email, color: u.color, isAdmin: !!u.is_admin });
  const userById = (id) => db.get('SELECT * FROM users WHERE id = ?', id);

  function authUser(req, { optional = false } = {}) {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : new URL(req.url, 'http://x').searchParams.get('token');
    if (!token) { if (optional) return null; fail(401, 'Please sign in'); }
    const s = db.get('SELECT * FROM sessions WHERE token = ?', hashToken(token));
    if (!s) { if (optional) return null; fail(401, 'Your session has expired. Please sign in again.'); }
    if (now() - s.last_seen > 60_000) db.run('UPDATE sessions SET last_seen = ? WHERE token = ?', now(), s.token);
    return userById(s.user_id);
  }
  // used by the collaboration hooks
  const userForToken = (token) => {
    const s = token && db.get('SELECT * FROM sessions WHERE token = ?', hashToken(token));
    return s ? userById(s.user_id) : null;
  };

  const roleIn = (userId, wsId) => db.get('SELECT role FROM members WHERE workspace_id = ? AND user_id = ?', wsId, userId)?.role || null;
  function requireRole(user, wsId, min = 'viewer') {
    const role = roleIn(user.id, wsId);
    if (!role) fail(404, 'Workspace not found');
    if (ROLES.indexOf(role) > ROLES.indexOf(min)) fail(403, min === 'owner' ? 'Only owners can do that' : 'You have view-only access here');
    return role;
  }
  function pageFor(user, pageId, min = 'viewer') {
    const p = db.get('SELECT * FROM pages WHERE id = ?', pageId);
    if (!p) fail(404, 'Page not found');
    const role = requireRole(user, p.workspace_id, min);
    return { page: p, role };
  }
  const memberIds = (wsId) => db.all('SELECT user_id FROM members WHERE workspace_id = ?', wsId).map((r) => r.user_id);
  const broadcast = (wsId, event) => sendTo(memberIds(wsId), { workspaceId: wsId, ...event });

  const pagePublic = (p) => ({
    id: p.id, workspaceId: p.workspace_id, parentId: p.parent_id, title: p.title, position: p.position,
    createdAt: p.created_at, createdBy: p.created_by, updatedAt: p.updated_at, updatedBy: p.updated_by, deletedAt: p.deleted_at,
  });

  function createSession(user) {
    const token = newToken();
    db.run('INSERT INTO sessions (token, user_id, created_at, last_seen) VALUES (?, ?, ?, ?)', hashToken(token), user.id, now(), now());
    return token;
  }

  function createWorkspace(user, name, kind = 'team') {
    const id = newId(9);
    db.run('INSERT INTO workspaces (id, name, kind, owner_id, created_at) VALUES (?, ?, ?, ?, ?)', id, name, kind, user.id, now());
    db.run('INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', id, user.id, 'owner', now());
    return id;
  }

  function addPage(wsId, user, { title = 'Untitled', parentId = null, markdown = '' }) {
    const id = newId(10);
    const pos = (db.get('SELECT MAX(position) AS m FROM pages WHERE workspace_id = ? AND parent_id IS ?', wsId, parentId)?.m ?? 0) + 1;
    db.run(`INSERT INTO pages (id, workspace_id, parent_id, title, position, created_by, created_at, updated_at, updated_by, markdown)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, wsId, parentId, cleanTitle(title), pos, user.id, now(), now(), user.id, markdown);
    mirror(id);
    return db.get('SELECT * FROM pages WHERE id = ?', id);
  }

  const cleanTitle = (t) => String(t || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200) || 'Untitled';

  function descendants(pageId) {
    const out = [];
    const walk = (id) => {
      for (const c of db.all('SELECT id FROM pages WHERE parent_id = ?', id)) { out.push(c.id); walk(c.id); }
    };
    walk(pageId);
    return out;
  }

  // ---------------------------------------------------------------- markdown mirror (DATA_DIR/vault)
  // Every page is also written as a .md file, using the same "Page.md + Page/" layout as the
  // desktop app, so the server folder can be opened in Local Notes or Obsidian.
  const vaultRoot = path.join(config.dataDir, 'vault');
  const safe = (s) => String(s).replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/^\.+/, '').trim().slice(0, 120) || 'Untitled';

  function mirrorPathOf(p) {
    const ws = db.get('SELECT * FROM workspaces WHERE id = ?', p.workspace_id);
    const owner = ws.kind === 'private' ? userById(ws.owner_id) : null;
    const wsDir = ws.kind === 'private' ? `Private - ${safe(owner?.name || owner?.email || ws.id)}` : safe(ws.name);
    const parts = [];
    let cur = p;
    while (cur) {
      const dup = db.get('SELECT COUNT(*) AS n FROM pages WHERE workspace_id = ? AND parent_id IS ? AND lower(title) = lower(?) AND deleted_at IS NULL', cur.workspace_id, cur.parent_id, cur.title).n > 1;
      parts.unshift(dup ? `${safe(cur.title)} (${cur.id.slice(0, 4)})` : safe(cur.title));
      cur = cur.parent_id ? db.get('SELECT * FROM pages WHERE id = ?', cur.parent_id) : null;
    }
    return path.join(vaultRoot, `${wsDir} (${ws.id.slice(0, 4)})`, ...parts) + '.md';
  }

  function mirror(pageId, { remove = false } = {}) {
    if (!config.mirror) return;
    const p = db.get('SELECT * FROM pages WHERE id = ?', pageId);
    if (!p) return;
    try {
      if (remove || p.deleted_at) {
        if (p.mirror_path && fs.existsSync(p.mirror_path)) fs.rmSync(p.mirror_path);
        db.run('UPDATE pages SET mirror_path = NULL WHERE id = ?', pageId);
        return;
      }
      const target = mirrorPathOf(p);
      if (p.mirror_path && p.mirror_path !== target && fs.existsSync(p.mirror_path)) fs.rmSync(p.mirror_path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, p.markdown ? `${p.markdown.replace(/\s+$/, '')}\n` : '');
      if (p.mirror_path !== target) db.run('UPDATE pages SET mirror_path = ? WHERE id = ?', target, pageId);
    } catch (e) {
      console.warn('mirror failed for', pageId, e.message);
    }
  }
  const mirrorTree = (pageId, opts) => { mirror(pageId, opts); for (const d of descendants(pageId)) mirror(d, opts); };

  // ---------------------------------------------------------------- links
  const WIKI = /\[\[([^\]\n|#]+)(?:#[^\]\n|]*)?(?:\|[^\]\n]*)?\]\]/g;
  function linkIndex(wsId) {
    const pages = db.all('SELECT id, title, parent_id, markdown, updated_at FROM pages WHERE workspace_id = ? AND deleted_at IS NULL', wsId);
    const byTitle = new Map();
    for (const p of pages) if (!byTitle.has(p.title.toLowerCase())) byTitle.set(p.title.toLowerCase(), p.id);
    const links = new Map();
    for (const p of pages) {
      const out = [];
      for (const m of p.markdown.matchAll(WIKI)) {
        const target = m[1].trim().split('/').pop().toLowerCase();
        out.push({ to: byTitle.get(target) || null, name: m[1].trim(), index: m.index });
      }
      links.set(p.id, out);
    }
    return { pages, links };
  }
  const snippet = (text, index) => {
    const s = text.lastIndexOf('\n', index) + 1;
    let e = text.indexOf('\n', index);
    if (e < 0) e = text.length;
    return text.slice(s, e).trim().replace(/^(?:[-*+]\s+\[.\]\s+|[-*+>#]+\s*|\d+\.\s+)+/, '').slice(0, 240);
  };

  // ---------------------------------------------------------------- versions
  function snapshot(page, authors, label = null) {
    db.run('INSERT INTO versions (page_id, markdown, title, authors, label, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      page.id, page.markdown, page.title, JSON.stringify([...authors]), label, now());
    const extra = db.get('SELECT COUNT(*) AS n FROM versions WHERE page_id = ?', page.id).n - MAX_VERSIONS;
    if (extra > 0) db.run('DELETE FROM versions WHERE id IN (SELECT id FROM versions WHERE page_id = ? ORDER BY created_at ASC LIMIT ?)', page.id, extra);
  }
  const pendingAuthors = new Map(); // pageId -> Set<userId> since last version

  // ---------------------------------------------------------------- notifications
  function notify(userIds, n) {
    const ids = [...new Set(userIds)].filter((id) => id && id !== n.actorId);
    for (const id of ids) {
      db.run('INSERT INTO notifications (user_id, kind, workspace_id, page_id, thread_id, actor_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id, n.kind, n.workspaceId || null, n.pageId || null, n.threadId || null, n.actorId || null, n.text || '', now());
    }
    sendTo(ids, { type: 'notification' });
  }

  function threadPublic(t) {
    const comments = db.all('SELECT * FROM comments WHERE thread_id = ? ORDER BY created_at', t.id);
    return {
      id: t.id, pageId: t.page_id, quote: t.quote, createdAt: t.created_at, createdBy: t.created_by,
      resolvedAt: t.resolved_at, resolvedBy: t.resolved_by,
      comments: comments.map((c) => ({ id: c.id, userId: c.user_id, body: c.body, createdAt: c.created_at, editedAt: c.edited_at })),
    };
  }

  function mentionTargets(page, mentions) {
    const members = new Set(memberIds(page.workspace_id));
    return (Array.isArray(mentions) ? mentions : []).filter((id) => members.has(id));
  }

  // ---------------------------------------------------------------- routes
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    routes.push({ method, re, keys, handler, opts });
  };

  route('GET', '/api/team/info', () => ({
    name: config.name,
    version: config.version,
    hasUsers: !!db.get('SELECT 1 AS x FROM users LIMIT 1'),
    signup: config.signup,
  }), { public: true });

  route('POST', '/api/auth/signup', ({ body, req }) => {
    if (!rateLimit(`signup:${req.socket.remoteAddress}`, 20)) fail(429, 'Too many attempts. Try again in a few minutes.');
    const email = String(body.email || '').trim().toLowerCase();
    const name = String(body.name || '').trim().slice(0, 80);
    const pw = String(body.password || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, 'Enter a valid email address');
    if (!name) fail(400, 'Enter your name');
    if (pw.length < 8) fail(400, 'Use at least 8 characters for your password');
    const first = !db.get('SELECT 1 AS x FROM users LIMIT 1');
    const invite = body.invite ? db.get('SELECT * FROM invites WHERE token = ? AND expires_at > ?', body.invite, now()) : null;
    if (!first && config.signup !== 'open' && !invite) fail(403, 'Sign-up on this server is by invitation. Ask a teammate for an invite link.');
    if (db.get('SELECT 1 AS x FROM users WHERE email = ?', email)) fail(409, 'An account with that email already exists. Sign in instead.');
    const user = db.tx(() => {
      const id = newId(9);
      db.run('INSERT INTO users (id, email, name, pw, color, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, email, name, hashPassword(pw), pickColor(id), first ? 1 : 0, now());
      const u = userById(id);
      const priv = createWorkspace(u, 'Private', 'private');
      addPage(priv, u, { title: 'Getting started', markdown: GETTING_STARTED });
      if (first) {
        const team = createWorkspace(u, config.name || 'Team');
        addPage(team, u, { title: 'Team home', markdown: TEAM_HOME });
      }
      if (invite) acceptInvite(u, invite);
      return u;
    });
    return { token: createSession(user), user: userPublic(user) };
  }, { public: true });

  route('POST', '/api/auth/login', ({ body, req }) => {
    const email = String(body.email || '').trim().toLowerCase();
    if (!rateLimit(`login:${email}`, 10) || !rateLimit(`login-ip:${req.socket.remoteAddress}`, 40)) fail(429, 'Too many attempts. Try again in a few minutes.');
    const u = db.get('SELECT * FROM users WHERE email = ?', email);
    if (!u || !checkPassword(String(body.password || ''), u.pw)) fail(401, 'Wrong email or password');
    if (body.invite) {
      const inv = db.get('SELECT * FROM invites WHERE token = ? AND expires_at > ?', body.invite, now());
      if (inv) acceptInvite(u, inv);
    }
    return { token: createSession(u), user: userPublic(u) };
  }, { public: true });

  route('POST', '/api/auth/logout', ({ req }) => {
    const t = (req.headers.authorization || '').slice(7);
    db.run('DELETE FROM sessions WHERE token = ?', hashToken(t));
    return { ok: true };
  });

  route('GET', '/api/me', ({ user }) => {
    const workspaces = db.all(`SELECT w.id, w.name, w.kind, m.role, (SELECT COUNT(*) FROM members x WHERE x.workspace_id = w.id) AS members
      FROM members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY w.kind = 'private' DESC, w.created_at`, user.id);
    const unread = db.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', user.id).n;
    return { user: userPublic(user), workspaces, unread };
  });

  route('PATCH', '/api/me', ({ user, body }) => {
    if (body.name) db.run('UPDATE users SET name = ? WHERE id = ?', String(body.name).trim().slice(0, 80), user.id);
    if (body.newPassword) {
      if (!checkPassword(String(body.password || ''), user.pw)) fail(401, 'Your current password is incorrect');
      if (String(body.newPassword).length < 8) fail(400, 'Use at least 8 characters');
      db.run('UPDATE users SET pw = ? WHERE id = ?', hashPassword(String(body.newPassword)), user.id);
    }
    return { user: userPublic(userById(user.id)) };
  });

  // workspaces & members
  route('POST', '/api/workspaces', ({ user, body }) => {
    const name = String(body.name || '').trim().slice(0, 80);
    if (!name) fail(400, 'Give the workspace a name');
    const id = createWorkspace(user, name);
    addPage(id, user, { title: 'Welcome', markdown: TEAM_HOME });
    return { id };
  });
  route('PATCH', '/api/workspaces/:id', ({ user, params, body }) => {
    requireRole(user, params.id, 'owner');
    const name = String(body.name || '').trim().slice(0, 80);
    if (name) db.run("UPDATE workspaces SET name = ? WHERE id = ? AND kind = 'team'", name, params.id);
    broadcast(params.id, { type: 'workspace' });
    return { ok: true };
  });
  route('DELETE', '/api/workspaces/:id', ({ user, params }) => {
    requireRole(user, params.id, 'owner');
    const ws = db.get('SELECT * FROM workspaces WHERE id = ?', params.id);
    if (ws.kind === 'private') fail(400, 'Your private space can’t be deleted');
    const members = memberIds(params.id);
    for (const p of db.all('SELECT id FROM pages WHERE workspace_id = ?', params.id)) mirror(p.id, { remove: true });
    db.run('DELETE FROM workspaces WHERE id = ?', params.id);
    sendTo(members, { type: 'workspace', workspaceId: params.id });
    return { ok: true };
  });
  route('GET', '/api/workspaces/:id/members', ({ user, params }) => {
    requireRole(user, params.id);
    return {
      members: db.all(`SELECT u.id, u.name, u.email, u.color, m.role, m.joined_at AS joinedAt FROM members m JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = ? ORDER BY m.role = 'owner' DESC, u.name`, params.id),
    };
  });
  route('PATCH', '/api/workspaces/:id/members/:uid', ({ user, params, body }) => {
    requireRole(user, params.id, 'owner');
    if (!ROLES.includes(body.role)) fail(400, 'Unknown role');
    if (params.uid === user.id && body.role !== 'owner' && db.get("SELECT COUNT(*) AS n FROM members WHERE workspace_id = ? AND role = 'owner'", params.id).n < 2) fail(400, 'A workspace needs at least one owner');
    db.run('UPDATE members SET role = ? WHERE workspace_id = ? AND user_id = ?', body.role, params.id, params.uid);
    broadcast(params.id, { type: 'members' });
    return { ok: true };
  });
  route('DELETE', '/api/workspaces/:id/members/:uid', ({ user, params }) => {
    if (params.uid !== user.id) requireRole(user, params.id, 'owner');
    const ws = db.get('SELECT * FROM workspaces WHERE id = ?', params.id);
    if (ws?.kind === 'private') fail(400, 'You can’t leave your private space');
    if (roleIn(params.uid, params.id) === 'owner' && db.get("SELECT COUNT(*) AS n FROM members WHERE workspace_id = ? AND role = 'owner'", params.id).n < 2) fail(400, 'Make someone else an owner first');
    const before = memberIds(params.id);
    db.run('DELETE FROM members WHERE workspace_id = ? AND user_id = ?', params.id, params.uid);
    collab.kick(params.uid, params.id);
    sendTo(before, { type: 'members', workspaceId: params.id });
    return { ok: true };
  });

  // invites
  route('POST', '/api/workspaces/:id/invites', ({ user, params, body }) => {
    requireRole(user, params.id, 'owner');
    const ws = db.get('SELECT * FROM workspaces WHERE id = ?', params.id);
    if (ws.kind === 'private') fail(400, 'Private spaces can’t be shared');
    const role = ROLES.includes(body.role) && body.role !== 'owner' ? body.role : 'editor';
    const token = newToken().slice(0, 24);
    db.run('INSERT INTO invites (token, workspace_id, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      token, params.id, role, user.id, now(), now() + 14 * 24 * 3600 * 1000);
    return { token, role, expiresAt: now() + 14 * 24 * 3600 * 1000 };
  });
  route('GET', '/api/invites/:token', ({ params }) => {
    const inv = db.get('SELECT * FROM invites WHERE token = ? AND expires_at > ?', params.token, now());
    if (!inv) fail(404, 'This invite link has expired or is invalid');
    const ws = db.get('SELECT name FROM workspaces WHERE id = ?', inv.workspace_id);
    const by = userById(inv.created_by);
    return { workspace: ws?.name, role: inv.role, invitedBy: by?.name };
  }, { public: true });
  function acceptInvite(user, inv) {
    if (!roleIn(user.id, inv.workspace_id)) {
      db.run('INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', inv.workspace_id, user.id, inv.role, now());
      db.run('UPDATE invites SET uses = uses + 1 WHERE token = ?', inv.token);
      notify(memberIds(inv.workspace_id), { kind: 'joined', workspaceId: inv.workspace_id, actorId: user.id, text: `${user.name} joined` });
      broadcast(inv.workspace_id, { type: 'members' });
    }
    return inv.workspace_id;
  }
  route('POST', '/api/invites/:token/accept', ({ user, params }) => {
    const inv = db.get('SELECT * FROM invites WHERE token = ? AND expires_at > ?', params.token, now());
    if (!inv) fail(404, 'This invite link has expired or is invalid');
    return { workspaceId: acceptInvite(user, inv) };
  });

  // pages
  route('GET', '/api/workspaces/:id/pages', ({ user, params }) => {
    const role = requireRole(user, params.id);
    const pages = db.all('SELECT * FROM pages WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY position', params.id).map(pagePublic);
    return { role, pages };
  });
  route('POST', '/api/workspaces/:id/pages', ({ user, params, body }) => {
    requireRole(user, params.id, 'editor');
    if (body.parentId) {
      const parent = db.get('SELECT * FROM pages WHERE id = ? AND workspace_id = ?', body.parentId, params.id);
      if (!parent) fail(400, 'Parent page not found');
    }
    const p = addPage(params.id, user, { title: body.title, parentId: body.parentId || null, markdown: String(body.markdown || '') });
    broadcast(params.id, { type: 'tree', actorId: user.id });
    return { page: pagePublic(p), markdown: p.markdown };
  });
  route('GET', '/api/pages/:id', ({ user, params }) => {
    const { page, role } = pageFor(user, params.id);
    const ws = db.get('SELECT id, name, kind FROM workspaces WHERE id = ?', page.workspace_id);
    return { page: pagePublic(page), role, workspace: ws, markdown: page.markdown, updatedByName: userById(page.updated_by)?.name || null };
  });
  route('PATCH', '/api/pages/:id', ({ user, params, body }) => {
    const { page } = pageFor(user, params.id, 'editor');
    if (body.parentId !== undefined && body.parentId !== null) {
      if (body.parentId === page.id || descendants(page.id).includes(body.parentId)) fail(400, 'Can’t move a page inside itself');
      if (!db.get('SELECT 1 AS x FROM pages WHERE id = ? AND workspace_id = ?', body.parentId, page.workspace_id)) fail(400, 'Parent not found');
    }
    const title = body.title !== undefined ? cleanTitle(body.title) : page.title;
    const parentId = body.parentId !== undefined ? body.parentId : page.parent_id;
    const position = typeof body.position === 'number' ? body.position : page.position;
    db.run('UPDATE pages SET title = ?, parent_id = ?, position = ?, updated_at = ?, updated_by = ? WHERE id = ?', title, parentId, position, now(), user.id, page.id);
    mirrorTree(page.id);
    broadcast(page.workspace_id, { type: 'tree', actorId: user.id, pageId: page.id });
    return { page: pagePublic(db.get('SELECT * FROM pages WHERE id = ?', page.id)) };
  });
  route('DELETE', '/api/pages/:id', ({ user, params }) => {
    const { page } = pageFor(user, params.id, 'editor');
    const ids = [page.id, ...descendants(page.id)];
    for (const id of ids) { db.run('UPDATE pages SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', now(), id); mirror(id, { remove: true }); }
    broadcast(page.workspace_id, { type: 'tree', actorId: user.id, deleted: ids });
    return { ok: true, deleted: ids.length };
  });
  route('GET', '/api/workspaces/:id/trash', ({ user, params }) => {
    requireRole(user, params.id);
    return { pages: db.all('SELECT * FROM pages WHERE workspace_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 200', params.id).map(pagePublic) };
  });
  route('POST', '/api/pages/:id/restore', ({ user, params }) => {
    const { page } = pageFor(user, params.id, 'editor');
    let parent = page.parent_id && db.get('SELECT * FROM pages WHERE id = ?', page.parent_id);
    const parentId = parent && !parent.deleted_at ? parent.id : null;
    const ids = [page.id, ...descendants(page.id)].filter((id) => db.get('SELECT deleted_at FROM pages WHERE id = ?', id)?.deleted_at >= page.deleted_at);
    for (const id of ids) db.run('UPDATE pages SET deleted_at = NULL WHERE id = ?', id);
    db.run('UPDATE pages SET parent_id = ? WHERE id = ?', parentId, page.id);
    mirrorTree(page.id);
    broadcast(page.workspace_id, { type: 'tree', actorId: user.id });
    return { ok: true };
  });

  // Clients send their markdown rendering of the shared doc; it powers search, links,
  // history and the .md mirror. The Yjs document stays the source of truth.
  route('PUT', '/api/pages/:id/markdown', ({ user, params, body }) => {
    const { page } = pageFor(user, params.id, 'editor');
    const markdown = String(body.markdown ?? '').slice(0, 5_000_000);
    if (markdown === page.markdown) return { ok: true, unchanged: true };
    db.run('UPDATE pages SET markdown = ?, updated_at = ?, updated_by = ? WHERE id = ?', markdown, now(), user.id, page.id);
    const fresh = db.get('SELECT * FROM pages WHERE id = ?', page.id);
    mirror(page.id);
    if (!pendingAuthors.has(page.id)) pendingAuthors.set(page.id, new Set());
    pendingAuthors.get(page.id).add(user.id);
    const last = db.get('SELECT created_at FROM versions WHERE page_id = ? ORDER BY created_at DESC LIMIT 1', page.id);
    if (!last || now() - last.created_at > VERSION_EVERY) {
      snapshot(fresh, pendingAuthors.get(page.id));
      pendingAuthors.delete(page.id);
    }
    broadcast(page.workspace_id, { type: 'page', pageId: page.id, updatedAt: fresh.updated_at, updatedBy: user.id });
    return { ok: true, updatedAt: fresh.updated_at };
  });

  // history
  route('GET', '/api/pages/:id/versions', ({ user, params }) => {
    pageFor(user, params.id);
    return {
      versions: db.all('SELECT id, title, authors, label, created_at AS createdAt, length(markdown) AS size FROM versions WHERE page_id = ? ORDER BY created_at DESC', params.id)
        .map((v) => ({ ...v, authors: JSON.parse(v.authors) })),
    };
  });
  route('GET', '/api/versions/:vid', ({ user, params }) => {
    const v = db.get('SELECT * FROM versions WHERE id = ?', Number(params.vid));
    if (!v) fail(404, 'Version not found');
    pageFor(user, v.page_id);
    return { id: v.id, pageId: v.page_id, title: v.title, markdown: v.markdown, label: v.label, createdAt: v.created_at, authors: JSON.parse(v.authors) };
  });
  route('POST', '/api/pages/:id/versions', ({ user, params, body }) => {
    const { page } = pageFor(user, params.id, 'editor');
    snapshot(page, new Set([user.id, ...(pendingAuthors.get(page.id) || [])]), String(body.label || '').slice(0, 120) || null);
    pendingAuthors.delete(page.id);
    return { ok: true };
  });

  // links, graph, search
  route('GET', '/api/pages/:id/links', ({ user, params }) => {
    const { page } = pageFor(user, params.id);
    const { pages, links } = linkIndex(page.workspace_id);
    const linked = [];
    for (const p of pages) {
      if (p.id === page.id) continue;
      const hits = links.get(p.id).filter((l) => l.to === page.id);
      if (hits.length) linked.push({ id: p.id, title: p.title, snippets: [...new Set(hits.slice(0, 3).map((h) => snippet(p.markdown, h.index)))] });
    }
    return { linked, children: db.all('SELECT id, title FROM pages WHERE parent_id = ? AND deleted_at IS NULL ORDER BY position', page.id) };
  });
  route('GET', '/api/workspaces/:id/graph', ({ user, params }) => {
    requireRole(user, params.id);
    const { pages, links } = linkIndex(params.id);
    const byId = new Map(pages.map((p) => [p.id, p]));
    const top = (p) => { let c = p; while (c.parent_id && byId.get(c.parent_id)) c = byId.get(c.parent_id); return c === p ? '' : c.title; };
    const nodes = pages.map((p) => ({ id: p.id, name: p.title, folder: top(p), mtime: p.updated_at / 1000 }));
    const edges = [];
    const unresolved = new Map();
    for (const [from, ls] of links) {
      const seen = new Set();
      for (const l of ls) {
        const to = l.to || `?${l.name.toLowerCase()}`;
        if (to === from || seen.has(to)) continue;
        seen.add(to);
        if (!l.to && !unresolved.has(to)) unresolved.set(to, { id: to, name: l.name, unresolved: true });
        edges.push({ source: from, target: to });
      }
      const p = byId.get(from);
      if (p.parent_id && byId.has(p.parent_id) && !seen.has(p.parent_id)) edges.push({ source: from, target: p.parent_id });
    }
    return { nodes: [...nodes, ...unresolved.values()], edges };
  });
  route('GET', '/api/workspaces/:id/search', ({ user, params, query }) => {
    requireRole(user, params.id);
    const q = String(query.q || '').toLowerCase().trim();
    if (!q) return { results: [] };
    const results = [];
    for (const p of db.all('SELECT id, title, markdown, updated_at FROM pages WHERE workspace_id = ? AND deleted_at IS NULL', params.id)) {
      const t = p.title.toLowerCase();
      const i = p.markdown.toLowerCase().indexOf(q);
      if (!t.includes(q) && i < 0) continue;
      let s = '';
      if (i >= 0) {
        const a = Math.max(0, i - 60);
        const b = Math.min(p.markdown.length, i + q.length + 90);
        s = (a ? '…' : '') + p.markdown.slice(a, b).replace(/\s+/g, ' ').trim() + (b < p.markdown.length ? '…' : '');
      }
      results.push({ id: p.id, title: p.title, snippet: s, score: t === q ? 3 : t.startsWith(q) ? 2 : t.includes(q) ? 1 : 0, updatedAt: p.updated_at });
    }
    results.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);
    return { results: results.slice(0, 40) };
  });

  // comments
  route('GET', '/api/pages/:id/threads', ({ user, params }) => {
    const { page } = pageFor(user, params.id);
    return { threads: db.all('SELECT * FROM threads WHERE page_id = ? ORDER BY created_at', page.id).map(threadPublic) };
  });
  route('POST', '/api/pages/:id/threads', ({ user, params, body }) => {
    const { page } = pageFor(user, params.id, 'editor');
    const text = String(body.body || '').trim().slice(0, 10000);
    if (!text) fail(400, 'Write a comment first');
    const id = /^[\w-]{6,40}$/.test(body.id || '') ? body.id : newId(9);
    db.tx(() => {
      db.run('INSERT INTO threads (id, page_id, quote, created_by, created_at) VALUES (?, ?, ?, ?, ?)', id, page.id, String(body.quote || '').slice(0, 500), user.id, now());
      db.run('INSERT INTO comments (id, thread_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)', newId(9), id, user.id, text, now());
    });
    const mentioned = mentionTargets(page, body.mentions);
    notify(mentioned, { kind: 'mention', workspaceId: page.workspace_id, pageId: page.id, threadId: id, actorId: user.id, text: text.slice(0, 200) });
    broadcast(page.workspace_id, { type: 'comments', pageId: page.id });
    return { thread: threadPublic(db.get('SELECT * FROM threads WHERE id = ?', id)) };
  });
  route('POST', '/api/threads/:id/comments', ({ user, params, body }) => {
    const t = db.get('SELECT * FROM threads WHERE id = ?', params.id);
    if (!t) fail(404, 'Thread not found');
    const { page } = pageFor(user, t.page_id, 'editor');
    const text = String(body.body || '').trim().slice(0, 10000);
    if (!text) fail(400, 'Write a reply first');
    db.run('INSERT INTO comments (id, thread_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)', newId(9), t.id, user.id, text, now());
    db.run('UPDATE threads SET resolved_at = NULL, resolved_by = NULL WHERE id = ?', t.id);
    const participants = db.all('SELECT DISTINCT user_id FROM comments WHERE thread_id = ?', t.id).map((r) => r.user_id);
    const mentioned = mentionTargets(page, body.mentions);
    notify(mentioned, { kind: 'mention', workspaceId: page.workspace_id, pageId: page.id, threadId: t.id, actorId: user.id, text: text.slice(0, 200) });
    notify(participants.filter((p) => !mentioned.includes(p)), { kind: 'reply', workspaceId: page.workspace_id, pageId: page.id, threadId: t.id, actorId: user.id, text: text.slice(0, 200) });
    broadcast(page.workspace_id, { type: 'comments', pageId: page.id });
    return { thread: threadPublic(db.get('SELECT * FROM threads WHERE id = ?', t.id)) };
  });
  route('PATCH', '/api/threads/:id', ({ user, params, body }) => {
    const t = db.get('SELECT * FROM threads WHERE id = ?', params.id);
    if (!t) fail(404, 'Thread not found');
    const { page } = pageFor(user, t.page_id, 'editor');
    if (body.resolved) db.run('UPDATE threads SET resolved_at = ?, resolved_by = ? WHERE id = ?', now(), user.id, t.id);
    else db.run('UPDATE threads SET resolved_at = NULL, resolved_by = NULL WHERE id = ?', t.id);
    broadcast(page.workspace_id, { type: 'comments', pageId: page.id });
    return { thread: threadPublic(db.get('SELECT * FROM threads WHERE id = ?', t.id)) };
  });
  route('DELETE', '/api/comments/:id', ({ user, params }) => {
    const c = db.get('SELECT * FROM comments WHERE id = ?', params.id);
    if (!c) fail(404, 'Comment not found');
    const t = db.get('SELECT * FROM threads WHERE id = ?', c.thread_id);
    const { page, role } = pageFor(user, t.page_id, 'editor');
    if (c.user_id !== user.id && role !== 'owner') fail(403, 'You can only delete your own comments');
    db.run('DELETE FROM comments WHERE id = ?', c.id);
    if (!db.get('SELECT 1 AS x FROM comments WHERE thread_id = ?', t.id)) db.run('DELETE FROM threads WHERE id = ?', t.id);
    broadcast(page.workspace_id, { type: 'comments', pageId: page.id });
    return { ok: true };
  });

  // people lookup for @mentions and avatars
  route('GET', '/api/workspaces/:id/people', ({ user, params }) => {
    requireRole(user, params.id);
    return { people: db.all('SELECT u.id, u.name, u.color FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY u.name', params.id) };
  });

  // notifications
  route('GET', '/api/notifications', ({ user }) => ({
    notifications: db.all(`SELECT n.id, n.kind, n.workspace_id AS workspaceId, n.page_id AS pageId, n.thread_id AS threadId, n.text,
        n.created_at AS createdAt, n.read_at AS readAt, u.name AS actorName, u.color AS actorColor, p.title AS pageTitle, w.name AS workspaceName
      FROM notifications n LEFT JOIN users u ON u.id = n.actor_id LEFT JOIN pages p ON p.id = n.page_id LEFT JOIN workspaces w ON w.id = n.workspace_id
      WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT 60`, user.id),
  }));
  route('POST', '/api/notifications/read', ({ user, body }) => {
    if (Array.isArray(body.ids)) for (const id of body.ids) db.run('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?', now(), Number(id), user.id);
    else db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', now(), user.id);
    return { ok: true };
  });

  route('GET', '/api/events', ({ user, res }) => { subscribe(user.id, res); return undefined; }, { stream: true });

  // ---------------------------------------------------------------- dispatch
  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      let body = {};
      if (req.method !== 'GET' && req.method !== 'DELETE') body = await readJson(req);
      const user = r.opts.public ? authUser(req, { optional: true }) : authUser(req);
      const out = await r.handler({ req, res, user, params, body, query: Object.fromEntries(url.searchParams) });
      if (r.opts.stream) return true;
      json(res, 200, out);
      return true;
    }
    return false;
  }

  return { handle, userForToken, roleIn, mirror, broadcast, db };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 8 * 1024 * 1024) { reject(new HttpError(413, 'Too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

export function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload ?? {}));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

const GETTING_STARTED = `This is your **private space**. Only you can see pages here.

> [!tip] Working with your team
> Team workspaces appear in the sidebar. Open one to edit pages together in real time — you'll see each other's cursors as you type.

- [ ] Write something just for you
- [ ] Open your team workspace and say hello
`;

const TEAM_HOME = `Welcome to your team's shared space. Everyone in this workspace can see and edit these pages together.

## Get going

- [ ] Invite teammates with **Share** in the top-right corner
- [ ] Create a page for your next project
- [ ] Select some text and press **Comment** to start a discussion
`;
