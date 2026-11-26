// REST API for the team server. JSON in/out, Bearer-token auth.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { newId, now } from './db.js';
import { hashPassword, checkPassword, newToken, hashToken, pickColor, rateLimit } from './auth.js';
import { subscribe, sendTo } from './events.js';
import { sendEmail, emailConfigured } from './mailer.js';
import Anthropic from '@anthropic-ai/sdk';
import aiLib from '../../server/ai.js';

// The provider layer is shared with the desktop app (server/ai.js in the repository).
const aiClient = aiLib.createAI({ Anthropic });

const VIRTUAL_NIC = /^(vEthernet|vmnet|VMware|VirtualBox|docker|br-|veth|virbr|tailscale|utun|zt|Hyper-V|WSL|lxc|lxd|podman)|Virtual|Loopback|Pseudo/i;

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
    const u = s ? userById(s.user_id) : null;
    if (!u || u.disabled_at) return null;
    if (now() - s.last_seen > 3600e3) db.run('UPDATE sessions SET last_seen = ? WHERE token = ?', now(), s.token);
    return u;
  };

  // Server settings chosen in the setup wizard / admin console override the environment defaults.
  const SETTINGS_KEY = 'server';
  const loadServerSettings = () => { try { return JSON.parse(db.get('SELECT value FROM settings WHERE key = ?', SETTINGS_KEY)?.value || '{}'); } catch { return {}; } };
  function saveServerSettings(patch) {
    const next = { ...loadServerSettings(), ...patch };
    db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', SETTINGS_KEY, JSON.stringify(next));
    Object.assign(config, next);
  }
  Object.assign(config, loadServerSettings());
  // This machine's addresses on the local network, so links shared from "localhost" still work for teammates.
  function lanAddresses() {
    if (config.publicUrl) return [config.publicUrl];
    const out = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      if (VIRTUAL_NIC.test(name)) continue; // WSL, Hyper-V, Docker, VPN tunnels
      for (const a of list || []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(`http://${a.address}:${config.port}`);
    }
    return out.sort((a, b) => (/\/\/(192\.168|10\.)/.test(b) ? 1 : 0) - (/\/\/(192\.168|10\.)/.test(a) ? 1 : 0));
  }
  const hasUsers = () => !!db.get('SELECT 1 AS x FROM users LIMIT 1');
  const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

  // One-time links to set a password: for new accounts an admin adds, and for password resets.
  function passwordLink(userId, kind, createdBy, days) {
    const token = newToken();
    db.run('DELETE FROM password_links WHERE user_id = ?', userId);
    db.run('INSERT INTO password_links (token, user_id, kind, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      hashToken(token), userId, kind, createdBy, now(), now() + days * 86400e3);
    return token;
  }
  const linkFor = (token) => db.get('SELECT * FROM password_links WHERE token = ? AND expires_at > ?', hashToken(String(token || '')), now());

  const roleIn = (userId, wsId) => db.get('SELECT role FROM members WHERE workspace_id = ? AND user_id = ?', wsId, userId)?.role || null;
  function requireRole(user, wsId, min = 'viewer') {
    const role = roleIn(user.id, wsId);
    if (!role) fail(404, 'Workspace not found');
    if (ROLES.indexOf(role) > ROLES.indexOf(min)) fail(403, min === 'owner' ? 'Only owners can do that' : 'You have view-only access here');
    return role;
  }
  // ---------------------------------------------------------------- page access
  // A page is visible to: workspace owners; other workspace members unless the page (or an
  // ancestor) is restricted, in which case only its creator keeps member access; and anyone the
  // page or an ancestor is shared with. The nearest share wins; roles never go below a member's.
  const RANK = { viewer: 1, editor: 2, owner: 3 };
  const best = (a, b) => (!a ? b : !b ? a : RANK[a] >= RANK[b] ? a : b);
  const pageById = (id) => db.get('SELECT * FROM pages WHERE id = ?', id);
  function chainOf(page, lookup = pageById) {
    const out = [];
    const seen = new Set();
    for (let p = page; p && !seen.has(p.id); p = p.parent_id ? lookup(p.parent_id) : null) { seen.add(p.id); out.push(p); }
    return out;
  }
  function accessFor(userId, page, { chain = chainOf(page), wsRole = roleIn(userId, page.workspace_id), shares = null } = {}) {
    if (wsRole === 'owner') return 'owner';
    let shareRole = null;
    for (const p of chain) {
      const s = shares ? shares.get(p.id) : db.get('SELECT role FROM page_shares WHERE page_id = ? AND user_id = ?', p.id, userId)?.role;
      if (s) { shareRole = s; break; }
    }
    const restrictedBy = chain.find((p) => p.access === 'restricted');
    if (wsRole && !restrictedBy) return best(wsRole, shareRole);
    if (wsRole && restrictedBy.created_by === userId) return best(wsRole === 'viewer' ? 'editor' : wsRole, shareRole);
    return shareRole;
  }
  const pageRole = (userId, pageId) => { const p = pageById(pageId); return p && !p.deleted_at && !userById(userId)?.disabled_at ? accessFor(userId, p) : null; };
  const canManage = (userId, page, role = accessFor(userId, page)) => role === 'owner' || (role === 'editor' && chainOf(page).some((p) => p.created_by === userId));

  function pageFor(user, pageId, min = 'viewer') {
    const p = pageById(pageId);
    if (!p) fail(404, 'Page not found');
    const role = accessFor(user.id, p);
    if (!role) fail(404, 'Page not found');
    if (RANK[role] < RANK[min]) fail(403, 'You have view-only access to this page');
    return { page: p, role };
  }

  // Every page of a workspace this person may see, with their role on each (one pass, no N+1).
  function visiblePages(userId, wsId) {
    const all = db.all('SELECT * FROM pages WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY position', wsId);
    const byId = new Map(all.map((p) => [p.id, p]));
    const shares = new Map(db.all('SELECT s.page_id, s.role FROM page_shares s JOIN pages p ON p.id = s.page_id WHERE s.user_id = ? AND p.workspace_id = ?', userId, wsId).map((r) => [r.page_id, r.role]));
    const shared = new Set(db.all('SELECT DISTINCT s.page_id FROM page_shares s JOIN pages p ON p.id = s.page_id WHERE p.workspace_id = ?', wsId).map((r) => r.page_id));
    const wsRole = roleIn(userId, wsId);
    const out = [];
    for (const p of all) {
      const chain = chainOf(p, (id) => byId.get(id));
      const role = accessFor(userId, p, { chain, wsRole, shares });
      if (role) out.push({ page: p, role, restricted: chain.some((x) => x.access === 'restricted'), shared: shared.has(p.id) });
    }
    return out;
  }

  const memberIds = (wsId) => db.all('SELECT user_id FROM members WHERE workspace_id = ?', wsId).map((r) => r.user_id);
  const shareUserIds = (wsId) => db.all('SELECT DISTINCT s.user_id FROM page_shares s JOIN pages p ON p.id = s.page_id WHERE p.workspace_id = ?', wsId).map((r) => r.user_id);
  // events carry ids only, so members and people with shared pages can all be told to refresh
  const broadcast = (wsId, event) => sendTo([...memberIds(wsId), ...shareUserIds(wsId)], { workspaceId: wsId, ...event });

  const pagePublic = (p) => ({
    id: p.id, workspaceId: p.workspace_id, parentId: p.parent_id, title: p.title, position: p.position,
    createdAt: p.created_at, createdBy: p.created_by, updatedAt: p.updated_at, updatedBy: p.updated_by, deletedAt: p.deleted_at,
    access: p.access || 'workspace',
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
  function linkIndex(wsId, userId) {
    const pages = visiblePages(userId, wsId).map((v) => v.page);
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
  // ---------------------------------------------------------------- email, contacts, invitations
  const emailSettings = () => { try { return JSON.parse(db.get("SELECT value FROM settings WHERE key = 'email'")?.value || '{}'); } catch { return {}; } };
  const emailOn = () => emailConfigured(emailSettings());
  // Where links in emails point: what the sender's app uses, a configured PUBLIC_URL, or this request's host.
  function baseUrlFor(req, body) {
    const b = String(body?.baseUrl || '');
    if (/^https?:\/\/[^\s/]+$/i.test(b.replace(/\/+$/, '')) && !/^https?:\/\/(localhost|127\.|\[::1\])/i.test(b)) return b.replace(/\/+$/, '');
    if (config.publicUrl) return config.publicUrl;
    const proto = req.headers['x-forwarded-proto'] || 'http';
    return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
  }
  // Send without failing the request; report what happened.
  async function mail(to, subject, content, replyTo) {
    if (!emailOn()) return { emailed: false };
    try { await sendEmail(emailSettings(), { to, subject, replyTo, ...content }); return { emailed: true }; }
    catch (e) { console.error('email failed:', e.message); return { emailed: false, emailError: e.message }; }
  }
  function rememberContact(ownerId, email, name = '', source = 'shared') {
    email = String(email || '').trim().toLowerCase();
    if (!validEmail(email) || !ownerId) return;
    db.run(`INSERT INTO contacts (owner_id, email, name, source, last_used, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_id, email) DO UPDATE SET name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE contacts.name END,
      last_used = COALESCE(excluded.last_used, contacts.last_used)`, ownerId, email, String(name || '').slice(0, 120), source, source === 'imported' ? null : now(), now());
  }
  // Someone with pending page invitations now has an account: turn them into shares.
  function acceptPageInvites(user) {
    const rows = db.all('SELECT * FROM page_invites WHERE email = ? AND expires_at > ?', String(user.email).toLowerCase(), now());
    for (const r of rows) {
      const page = pageById(r.page_id);
      if (!page || page.deleted_at) continue;
      db.run(`INSERT INTO page_shares (page_id, user_id, role, created_by, created_at, kind) VALUES (?, ?, ?, ?, ?, 'direct')
        ON CONFLICT(page_id, user_id) DO UPDATE SET role = excluded.role, kind = 'direct'`, page.id, user.id, r.role, r.invited_by, now());
      notify([user.id], { kind: 'shared', workspaceId: page.workspace_id, pageId: page.id, actorId: r.invited_by, text: '' });
      if (r.invited_by) rememberContact(user.id, userById(r.invited_by)?.email, userById(r.invited_by)?.name);
    }
    db.run('DELETE FROM page_invites WHERE email = ?', String(user.email).toLowerCase());
    if (rows.length) sendTo([user.id], { type: 'shared' });
    return rows.map((r) => r.page_id);
  }
  const externalSharing = () => (['anyone', 'admins'].includes(config.externalSharing) ? config.externalSharing : 'anyone');

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
    return (Array.isArray(mentions) ? mentions : []).filter((id) => typeof id === 'string' && accessFor(id, page));
  }
  // Everyone who can open this page: for @mentions, avatars and the share dialog.
  function pagePeople(page) {
    const chain = chainOf(page);
    const ids = new Set([...memberIds(page.workspace_id), ...db.all(`SELECT user_id FROM page_shares WHERE page_id IN (${chain.map(() => '?').join(',')})`, ...chain.map((p) => p.id)).map((r) => r.user_id)]);
    return [...ids].map((id) => ({ user: userById(id), role: accessFor(id, page, { chain }) })).filter((x) => x.user && x.role);
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
    hasUsers: hasUsers(),
    needsSetup: !hasUsers(),
    signup: config.signup,
  }), { public: true });

  // First-run setup: creates the admin account, names the team and picks who can join.
  route('POST', '/api/setup', ({ body, req }) => {
    if (!rateLimit(`setup:${req.socket.remoteAddress}`, 20)) fail(429, 'Too many attempts. Try again in a few minutes.');
    if (hasUsers()) fail(409, 'This server is already set up. Sign in instead.');
    const teamName = String(body.teamName || '').trim().slice(0, 80);
    const email = String(body.email || '').trim().toLowerCase();
    const name = String(body.name || '').trim().slice(0, 80);
    const pw = String(body.password || '');
    if (!teamName) fail(400, 'Give your team a name');
    if (!name) fail(400, 'Enter your name');
    if (!validEmail(email)) fail(400, 'Enter a valid email address');
    if (pw.length < 8) fail(400, 'Use at least 8 characters for your password');
    const user = db.tx(() => {
      saveServerSettings({ name: teamName, signup: body.signup === 'open' ? 'open' : 'invite' });
      const id = newId(9);
      db.run('INSERT INTO users (id, email, name, pw, color, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)', id, email, name, hashPassword(pw), pickColor(id), now());
      const u = userById(id);
      const priv = createWorkspace(u, 'Private', 'private');
      addPage(priv, u, { title: 'Getting started', markdown: GETTING_STARTED });
      const team = createWorkspace(u, teamName);
      addPage(team, u, { title: 'Team home', markdown: TEAM_HOME });
      return u;
    });
    return { token: createSession(user), user: userPublic(user) };
  }, { public: true });

  // Set a password from a one-time link (new account or reset).
  route('GET', '/api/auth/password-link/:token', ({ params }) => {
    const l = linkFor(params.token);
    if (!l) fail(404, 'This link has expired or was already used. Ask your admin for a new one.');
    const u = userById(l.user_id);
    return { name: u.name, email: u.email, kind: l.kind, team: config.name };
  }, { public: true });
  route('POST', '/api/auth/password-link/:token', ({ params, body, req }) => {
    if (!rateLimit(`pwlink:${req.socket.remoteAddress}`, 20)) fail(429, 'Too many attempts. Try again in a few minutes.');
    const l = linkFor(params.token);
    if (!l) fail(404, 'This link has expired or was already used. Ask your admin for a new one.');
    const pw = String(body.password || '');
    if (pw.length < 8) fail(400, 'Use at least 8 characters for your password');
    db.run('UPDATE users SET pw = ? WHERE id = ?', hashPassword(pw), l.user_id);
    db.run('DELETE FROM sessions WHERE user_id = ?', l.user_id);
    db.run('DELETE FROM password_links WHERE user_id = ?', l.user_id);
    const u = userById(l.user_id);
    if (u.disabled_at) fail(403, 'Your account is suspended. Contact your admin.');
    acceptPageInvites(u);
    return { token: createSession(u), user: userPublic(u) };
  }, { public: true });

  route('POST', '/api/auth/signup', ({ body, req }) => {
    if (!rateLimit(`signup:${req.socket.remoteAddress}`, 20)) fail(429, 'Too many attempts. Try again in a few minutes.');
    const email = String(body.email || '').trim().toLowerCase();
    const name = String(body.name || '').trim().slice(0, 80);
    const pw = String(body.password || '');
    if (!validEmail(email)) fail(400, 'Enter a valid email address');
    if (!name) fail(400, 'Enter your name');
    if (pw.length < 8) fail(400, 'Use at least 8 characters for your password');
    const first = !db.get('SELECT 1 AS x FROM users LIMIT 1');
    const invite = body.invite ? db.get('SELECT * FROM invites WHERE token = ? AND expires_at > ?', body.invite, now()) : null;
    const pageInvite = body.pageInvite ? db.get('SELECT * FROM page_invites WHERE token = ? AND expires_at > ?', hashToken(String(body.pageInvite)), now()) : null;
    if (pageInvite && pageInvite.email !== email) fail(403, `This invitation is for ${pageInvite.email}. Sign up with that email address.`);
    if (!first && config.signup !== 'open' && !invite && !pageInvite) fail(403, 'Sign-up on this server is by invitation. Ask a teammate for an invite link.');
    if (db.get('SELECT 1 AS x FROM users WHERE email = ?', email)) fail(409, 'An account with that email already exists. Sign in instead.');
    const user = db.tx(() => {
      const id = newId(9);
      db.run('INSERT INTO users (id, email, name, pw, color, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, email, name, hashPassword(pw), pickColor(id), first ? 1 : 0, now());
      if (first && body.teamName) saveServerSettings({ name: String(body.teamName).trim().slice(0, 80) });
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
    const opened = acceptPageInvites(user);
    return { token: createSession(user), user: userPublic(user), openPage: pageInvite?.page_id || opened[0] || null };
  }, { public: true });

  route('POST', '/api/auth/login', ({ body, req }) => {
    const email = String(body.email || '').trim().toLowerCase();
    if (!rateLimit(`login:${email}`, 10) || !rateLimit(`login-ip:${req.socket.remoteAddress}`, 40)) fail(429, 'Too many attempts. Try again in a few minutes.');
    const u = db.get('SELECT * FROM users WHERE email = ?', email);
    if (!u || !checkPassword(String(body.password || ''), u.pw)) fail(401, 'Wrong email or password');
    if (u.disabled_at) fail(403, 'Your account is suspended. Contact your admin.');
    const pinv = body.pageInvite ? db.get('SELECT page_id FROM page_invites WHERE token = ?', hashToken(String(body.pageInvite))) : null;
    acceptPageInvites(u);
    if (body.invite) {
      const inv = db.get('SELECT * FROM invites WHERE token = ? AND expires_at > ?', body.invite, now());
      if (inv) acceptInvite(u, inv);
    }
    return { token: createSession(u), user: userPublic(u), openPage: pinv?.page_id || null };
  }, { public: true });

  // What a page invitation is for (shown before signing up or in).
  route('GET', '/api/page-invites/:token', ({ params }) => {
    const r = db.get('SELECT * FROM page_invites WHERE token = ? AND expires_at > ?', hashToken(params.token), now());
    if (!r) fail(404, 'This invitation has expired or was already used. Ask for a new one, or sign in if you already accepted it.');
    const page = pageById(r.page_id);
    return { email: r.email, pageTitle: page?.title || 'a page', invitedBy: userById(r.invited_by)?.name || 'Someone', role: r.role, team: config.name, hasAccount: !!db.get('SELECT 1 AS x FROM users WHERE email = ?', r.email) };
  }, { public: true });

  route('POST', '/api/page-invites/:token/accept', ({ user, params }) => {
    const r = db.get('SELECT * FROM page_invites WHERE token = ?', hashToken(params.token));
    if (!r) {
      fail(404, 'This invitation has expired or was already used.');
    }
    if (r.email !== String(user.email).toLowerCase()) fail(403, `This invitation was sent to ${r.email}. Sign out, then sign in or create an account with that email.`);
    acceptPageInvites(user);
    return { pageId: r.page_id };
  });

  route('POST', '/api/auth/logout', ({ req }) => {
    const t = (req.headers.authorization || '').slice(7);
    db.run('DELETE FROM sessions WHERE token = ?', hashToken(t));
    return { ok: true };
  });

  route('GET', '/api/me', ({ user }) => {
    const workspaces = db.all(`SELECT w.id, w.name, w.kind, m.role, (SELECT COUNT(*) FROM members x WHERE x.workspace_id = w.id) AS members
      FROM members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY w.kind = 'private' DESC, w.created_at`, user.id);
    const unread = db.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', user.id).n;
    return { user: userPublic(user), workspaces, unread, server: { addresses: lanAddresses() } };
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
    const pages = visiblePages(user.id, params.id).map((v) => ({ ...pagePublic(v.page), role: v.role, restricted: v.restricted, shared: v.shared }));
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
    // "Anyone with the link": opening the page by its link gives access and adds it to Shared with me.
    const raw = pageById(params.id);
    if (raw && !raw.deleted_at && !accessFor(user.id, raw)) {
      const linked = chainOf(raw).find((p) => p.link_role);
      if (linked) {
        db.run("INSERT OR IGNORE INTO page_shares (page_id, user_id, role, created_by, created_at, kind) VALUES (?, ?, ?, NULL, ?, 'link')", linked.id, user.id, linked.link_role, now());
        sendTo([user.id], { type: 'shared' });
      }
    }
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
    const { pages, links } = linkIndex(page.workspace_id, user.id);
    const linked = [];
    for (const p of pages) {
      if (p.id === page.id) continue;
      const hits = links.get(p.id).filter((l) => l.to === page.id);
      if (hits.length) linked.push({ id: p.id, title: p.title, snippets: [...new Set(hits.slice(0, 3).map((h) => snippet(p.markdown, h.index)))] });
    }
    const children = db.all('SELECT * FROM pages WHERE parent_id = ? AND deleted_at IS NULL ORDER BY position', page.id).filter((c) => accessFor(user.id, c)).map((c) => ({ id: c.id, title: c.title }));
    return { linked, children };
  });
  route('GET', '/api/workspaces/:id/graph', ({ user, params }) => {
    requireRole(user, params.id);
    const { pages, links } = linkIndex(params.id, user.id);
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
    for (const p of visiblePages(user.id, params.id).map((v) => v.page)) {
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
  route('GET', '/api/pages/:id/people', ({ user, params }) => {
    const { page } = pageFor(user, params.id);
    return { people: pagePeople(page).map(({ user: u }) => ({ id: u.id, name: u.name, color: u.color })).sort((a, b) => a.name.localeCompare(b.name)) };
  });
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

  // ---------------------------------------------------------------- people, teams & sharing
  route('GET', '/api/users', ({ query }) => {
    const q = `%${String(query.q || '').trim().toLowerCase()}%`;
    return { users: db.all('SELECT id, name, email, color FROM users WHERE lower(name) LIKE ? OR lower(email) LIKE ? ORDER BY name LIMIT 20', q, q) };
  });

  route('POST', '/api/workspaces/:id/members', ({ user, params, body }) => {
    requireRole(user, params.id, 'owner');
    const ws = db.get('SELECT * FROM workspaces WHERE id = ?', params.id);
    if (ws.kind === 'private') fail(400, 'Private spaces can’t have members. Share individual pages instead.');
    const target = userById(String(body.userId || ''));
    if (!target) fail(404, 'Person not found');
    const role = ROLES.includes(body.role) ? body.role : 'editor';
    if (roleIn(target.id, ws.id)) db.run('UPDATE members SET role = ? WHERE workspace_id = ? AND user_id = ?', role, ws.id, target.id);
    else {
      db.run('INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', ws.id, target.id, role, now());
      notify([target.id], { kind: 'added', workspaceId: ws.id, actorId: user.id, text: `${user.name} added you to ${ws.name}` });
    }
    sendTo([target.id], { type: 'workspace', workspaceId: ws.id });
    broadcast(ws.id, { type: 'members' });
    return { ok: true };
  });

  const nearestShares = (chain) => {
    const map = new Map();
    for (const p of chain) {
      for (const r of db.all('SELECT user_id, role, kind FROM page_shares WHERE page_id = ?', p.id)) if (!map.has(r.user_id)) map.set(r.user_id, { role: r.role, kind: r.kind, pageId: p.id, title: p.title });
    }
    return map;
  };

  route('GET', '/api/pages/:id/access', ({ user, params }) => {
    const { page, role } = pageFor(user, params.id);
    const chain = chainOf(page);
    const ws = db.get('SELECT id, name, kind FROM workspaces WHERE id = ?', page.workspace_id);
    const restrictedBy = chain.find((p) => p.access === 'restricted');
    const shares = nearestShares(chain);
    const people = pagePeople(page).map(({ user: u, role: r }) => {
      const s = shares.get(u.id);
      const wsRole = roleIn(u.id, page.workspace_id);
      return {
        id: u.id, name: u.name, email: u.email, color: u.color, role: r,
        via: s ? (s.kind === 'link' ? 'link' : 'share') : wsRole === 'owner' ? 'owner' : 'member',
        inheritedFrom: s && s.pageId !== page.id ? s.title : null,
        removable: !!s && s.pageId === page.id,
      };
    }).sort((a, b) => (RANK[b.role] - RANK[a.role]) || a.name.localeCompare(b.name));
    const pending = db.all('SELECT email, role, created_at AS createdAt FROM page_invites WHERE page_id = ? AND expires_at > ? ORDER BY created_at', page.id, now());
    const linkFrom = chainOf(page).find((p) => p.link_role);
    return {
      mode: page.access || 'workspace',
      restrictedBy: restrictedBy && restrictedBy.id !== page.id ? { id: restrictedBy.id, title: restrictedBy.title } : null,
      workspace: { id: ws.id, name: ws.name, kind: ws.kind, members: memberIds(ws.id).length },
      canManage: canManage(user.id, page, role),
      canShare: RANK[role] >= RANK.editor,
      role,
      people,
      pending,
      linkRole: page.link_role || null,
      linkInheritedFrom: linkFrom && linkFrom.id !== page.id ? { id: linkFrom.id, title: linkFrom.title, role: linkFrom.link_role } : null,
      emailOn: emailOn(),
      canInviteNew: externalSharing() === 'anyone' || !!user.is_admin,
    };
  });

  function requireManage(user, page) {
    if (!canManage(user.id, page)) fail(403, 'Only the page’s creator or a workspace owner can change who has access');
  }
  const subtree = (page) => [page.id, ...descendants(page.id)];

  route('PUT', '/api/pages/:id/access', ({ user, params, body }) => {
    const { page } = pageFor(user, params.id);
    requireManage(user, page);
    const ws = db.get('SELECT kind FROM workspaces WHERE id = ?', page.workspace_id);
    if (body.linkRole !== undefined) {
      const linkRole = ['viewer', 'editor'].includes(body.linkRole) ? body.linkRole : null;
      db.run('UPDATE pages SET link_role = ? WHERE id = ?', linkRole, page.id);
      if (linkRole) db.run("UPDATE page_shares SET role = ? WHERE page_id = ? AND kind = 'link'", linkRole, page.id);
      else db.run("DELETE FROM page_shares WHERE page_id = ? AND kind = 'link'", page.id);
    }
    if (body.mode === undefined) {
      collab.reset(subtree(page));
      broadcast(page.workspace_id, { type: 'tree', actorId: user.id });
      sendTo(shareUserIds(page.workspace_id), { type: 'shared' });
      return { ok: true, linkRole: pageById(page.id).link_role };
    }
    if (ws.kind === 'private') fail(400, 'Pages in your private space are already private. Share them with people instead.');
    const mode = body.mode === 'restricted' ? 'restricted' : 'workspace';
    db.run('UPDATE pages SET access = ? WHERE id = ?', mode, page.id);
    collab.reset(subtree(page));
    broadcast(page.workspace_id, { type: 'tree', actorId: user.id });
    return { ok: true, mode };
  });

  route('POST', '/api/pages/:id/shares', async ({ user, params, body, req }) => {
    // like Google Docs: anyone who can edit a page can share it
    const { page } = pageFor(user, params.id, 'editor');
    const role = body.role === 'viewer' ? 'viewer' : 'editor';
    const notifyThem = body.notify !== false;
    const message = String(body.message || '').trim().slice(0, 2000);
    const base = baseUrlFor(req, body);
    const pageUrl = `${base}/#/p/${page.id}`;
    const ROLE_WORD = { editor: 'edit', viewer: 'view' };
    // accept one userId, or a list of people: [{ userId } | { email, name }]
    const targets = Array.isArray(body.people) ? body.people : [{ userId: body.userId, email: body.email, name: body.name }];
    const results = [];
    for (const t of targets.slice(0, 50)) {
      let target = t.userId ? userById(String(t.userId)) : null;
      const email = String(t.email || target?.email || '').trim().toLowerCase();
      if (!target && email) target = db.get('SELECT * FROM users WHERE email = ?', email) || null;
      if (target) {
        if (target.id === user.id) { results.push({ email: target.email, error: 'You already have access' }); continue; }
        const existed = db.get("SELECT 1 AS x FROM page_shares WHERE page_id = ? AND user_id = ? AND kind = 'direct'", page.id, target.id);
        db.run(`INSERT INTO page_shares (page_id, user_id, role, created_by, created_at, kind) VALUES (?, ?, ?, ?, ?, 'direct')
          ON CONFLICT(page_id, user_id) DO UPDATE SET role = excluded.role, kind = 'direct', created_by = excluded.created_by`, page.id, target.id, role, user.id, now());
        rememberContact(user.id, target.email, target.name);
        const r = { email: target.email, name: target.name, userId: target.id, shared: true };
        if (!existed) {
          notify([target.id], { kind: 'shared', workspaceId: page.workspace_id, pageId: page.id, actorId: user.id, text: message || `${user.name} shared “${page.title}” with you` });
          if (notifyThem) Object.assign(r, await mail(target.email, `${user.name} shared “${page.title}” with you`, {
            heading: `${user.name} shared a page with you`,
            lines: [`You can ${ROLE_WORD[role]} “${page.title}” in ${config.name} on Local Notes.`],
            quote: message, button: { label: `Open “${page.title}”`, url: pageUrl },
          }, user.email));
        }
        sendTo([target.id], { type: 'shared' });
        results.push(r);
        continue;
      }
      // not on this server yet: an invitation tied to their email address
      if (!validEmail(email)) { results.push({ email, error: 'Not a valid email address' }); continue; }
      if (externalSharing() !== 'anyone' && !user.is_admin) { results.push({ email, error: 'Only admins can invite people who aren’t on this server yet' }); continue; }
      const token = newToken();
      db.run('DELETE FROM page_invites WHERE page_id = ? AND email = ?', page.id, email);
      db.run('INSERT INTO page_invites (token, page_id, email, role, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        hashToken(token), page.id, email, role, user.id, now(), now() + 30 * 86400e3);
      rememberContact(user.id, email, t.name || '');
      const link = `${base}/#/join/${token}`;
      const r = { email, invited: true, link };
      if (notifyThem) Object.assign(r, await mail(email, `${user.name} invited you to “${page.title}”`, {
        heading: `${user.name} invited you to a page`,
        lines: [`You can ${ROLE_WORD[role]} “${page.title}” in ${config.name} on Local Notes. Open the link to create your account; it takes a minute.`],
        quote: message, button: { label: 'Accept invitation', url: link },
        footer: 'This invitation works for 30 days.',
      }, user.email));
      results.push(r);
    }
    collab.reset(subtree(page));
    broadcast(page.workspace_id, { type: 'tree', actorId: user.id });
    return { ok: true, results, emailOn: emailOn() };
  });

  // pending invitations (people without an account yet)
  route('PATCH', '/api/pages/:id/invites', ({ user, params, body }) => {
    const { page } = pageFor(user, params.id);
    requireManage(user, page);
    db.run('UPDATE page_invites SET role = ? WHERE page_id = ? AND email = ?', body.role === 'viewer' ? 'viewer' : 'editor', page.id, String(body.email || '').toLowerCase());
    return { ok: true };
  });
  route('DELETE', '/api/pages/:id/invites', ({ user, params, query }) => {
    const { page } = pageFor(user, params.id);
    requireManage(user, page);
    db.run('DELETE FROM page_invites WHERE page_id = ? AND email = ?', page.id, String(query.email || '').toLowerCase());
    return { ok: true };
  });
  // a fresh link for a pending invitation (to copy and send yourself)
  route('POST', '/api/pages/:id/invites/link', ({ user, params, body, req }) => {
    const { page } = pageFor(user, params.id);
    requireManage(user, page);
    const email = String(body.email || '').toLowerCase();
    const row = db.get('SELECT * FROM page_invites WHERE page_id = ? AND email = ?', page.id, email);
    if (!row) fail(404, 'Invitation not found');
    const token = newToken();
    db.run('UPDATE page_invites SET token = ?, expires_at = ? WHERE token = ?', hashToken(token), now() + 30 * 86400e3, row.token);
    return { link: `${baseUrlFor(req, body)}/#/join/${token}` };
  });

  // ---------------------------------------------------------------- address book
  // Suggestions as you type: people on this server plus your own contacts (people you've
  // shared with, and contacts you imported from Gmail/Outlook), most recently used first.
  route('GET', '/api/contacts', ({ user, query }) => {
    const q = String(query.q || '').trim().toLowerCase();
    const like = `%${q}%`;
    const word = (s) => !q || String(s || '').toLowerCase().split(/[\s.@_-]+/).some((w) => w.startsWith(q)) || String(s || '').toLowerCase().startsWith(q);
    const mine = db.all(`SELECT email, name, source, last_used AS lastUsed FROM contacts WHERE owner_id = ? ${q ? 'AND (lower(name) LIKE ? OR email LIKE ?)' : 'AND last_used IS NOT NULL'} ORDER BY last_used DESC NULLS LAST, name LIMIT 200`, user.id, ...(q ? [like, like] : []));
    const users = q ? db.all('SELECT id, name, email, color FROM users WHERE disabled_at IS NULL AND (lower(name) LIKE ? OR email LIKE ?) LIMIT 100', like, like) : [];
    const byEmail = new Map();
    for (const u of users) byEmail.set(u.email, { id: u.id, name: u.name, email: u.email, color: u.color, onServer: true, lastUsed: null });
    for (const c of mine) {
      const u = byEmail.get(c.email) || db.get('SELECT id, name, email, color FROM users WHERE email = ? AND disabled_at IS NULL', c.email);
      byEmail.set(c.email, { id: u?.id || null, name: u?.name || c.name || '', email: c.email, color: u?.color || null, onServer: !!u, lastUsed: c.lastUsed });
    }
    const list = [...byEmail.values()].filter((p) => p.email !== user.email && (word(p.name) || word(p.email) || (q.includes('@') && p.email.includes(q))));
    list.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0) || Number(b.onServer) - Number(a.onServer) || (a.name || a.email).localeCompare(b.name || b.email));
    return { people: list.slice(0, q ? 8 : 6) };
  });
  route('GET', '/api/contacts/all', ({ user }) => ({
    contacts: db.all('SELECT email, name, source, last_used AS lastUsed FROM contacts WHERE owner_id = ? ORDER BY lower(CASE WHEN name <> \'\' THEN name ELSE email END)', user.id)
      .map((c) => ({ ...c, onServer: !!db.get('SELECT 1 AS x FROM users WHERE email = ?', c.email) })),
  }));
  route('POST', '/api/contacts/import', ({ user, body }) => {
    const list = Array.isArray(body.contacts) ? body.contacts.slice(0, 10000) : [];
    let added = 0;
    db.tx(() => {
      for (const c of list) {
        const email = String(c?.email || '').trim().toLowerCase();
        if (!validEmail(email) || email === user.email) continue;
        const had = db.get('SELECT 1 AS x FROM contacts WHERE owner_id = ? AND email = ?', user.id, email);
        rememberContact(user.id, email, c.name || '', 'imported');
        if (!had) added++;
      }
    });
    return { added, total: db.get('SELECT COUNT(*) AS n FROM contacts WHERE owner_id = ?', user.id).n };
  });
  route('DELETE', '/api/contacts', ({ user, query }) => {
    if (query.all === '1') db.run('DELETE FROM contacts WHERE owner_id = ?', user.id);
    else db.run('DELETE FROM contacts WHERE owner_id = ? AND email = ?', user.id, String(query.email || '').toLowerCase());
    return { ok: true };
  });

  route('PATCH', '/api/pages/:id/shares/:uid', ({ user, params, body }) => {
    const { page } = pageFor(user, params.id);
    requireManage(user, page);
    db.run('UPDATE page_shares SET role = ? WHERE page_id = ? AND user_id = ?', body.role === 'viewer' ? 'viewer' : 'editor', page.id, params.uid);
    collab.reset(subtree(page));
    sendTo([params.uid], { type: 'shared' });
    return { ok: true };
  });

  route('DELETE', '/api/pages/:id/shares/:uid', ({ user, params }) => {
    const { page } = pageFor(user, params.id);
    if (params.uid !== user.id) requireManage(user, page);
    db.run('DELETE FROM page_shares WHERE page_id = ? AND user_id = ?', page.id, params.uid);
    collab.reset(subtree(page));
    sendTo([params.uid], { type: 'shared' });
    broadcast(page.workspace_id, { type: 'tree', actorId: user.id });
    return { ok: true };
  });

  // Pages shared with this person that they don't already see through their own workspaces.
  function sharedWithMe(user) {
    const out = new Map();
    const rows = db.all('SELECT s.page_id, s.created_by FROM page_shares s JOIN pages p ON p.id = s.page_id WHERE s.user_id = ? AND p.deleted_at IS NULL ORDER BY s.created_at DESC', user.id);
    for (const r of rows) {
      const root = pageById(r.page_id);
      if (roleIn(user.id, root.workspace_id)) continue; // already in their sidebar under that workspace
      const walk = (p, isRoot) => {
        if (out.has(p.id)) return;
        const role = accessFor(user.id, p);
        if (!role) return;
        out.set(p.id, { page: p, role, root: isRoot, sharedBy: r.created_by });
        for (const c of db.all('SELECT * FROM pages WHERE parent_id = ? AND deleted_at IS NULL ORDER BY position', p.id)) walk(c, false);
      };
      walk(root, true);
    }
    for (const v of out.values()) if (v.root && v.page.parent_id && out.has(v.page.parent_id)) v.root = false;
    return [...out.values()];
  }

  route('GET', '/api/shared', ({ user }) => ({
    pages: sharedWithMe(user).map((v) => ({
      ...pagePublic(v.page), role: v.role, root: v.root,
      workspaceName: db.get('SELECT name FROM workspaces WHERE id = ?', v.page.workspace_id)?.name,
      sharedBy: userById(v.sharedBy)?.name || null,
    })),
  }));

  route('POST', '/api/pages/:id/move', ({ user, params, body }) => {
    const { page } = pageFor(user, params.id, 'editor');
    const target = String(body.workspaceId || '');
    requireRole(user, target, 'editor');
    if (target === page.workspace_id) return { ok: true };
    const from = page.workspace_id;
    const ids = subtree(page);
    const pos = (db.get('SELECT MAX(position) AS m FROM pages WHERE workspace_id = ? AND parent_id IS NULL', target)?.m ?? 0) + 1;
    db.tx(() => {
      for (const id of ids) db.run('UPDATE pages SET workspace_id = ?, updated_at = ? WHERE id = ?', target, now(), id);
      db.run('UPDATE pages SET parent_id = NULL, position = ? WHERE id = ?', pos, page.id);
    });
    mirrorTree(page.id);
    collab.reset(ids);
    broadcast(from, { type: 'tree', actorId: user.id, deleted: ids });
    broadcast(target, { type: 'tree', actorId: user.id });
    return { ok: true, page: pagePublic(pageById(page.id)) };
  });

  // ---------------------------------------------------------------- server admin console
  const requireServerAdmin = (user) => { if (!user.is_admin) fail(403, 'Only server admins can do that'); };
  const adminCount = () => db.get('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND disabled_at IS NULL').n;
  const adminUser = (u) => ({
    ...userPublic(u),
    disabled: !!u.disabled_at,
    createdAt: u.created_at,
    lastSeen: db.get('SELECT MAX(last_seen) AS t FROM sessions WHERE user_id = ?', u.id)?.t || null,
    workspaces: db.all("SELECT w.name, m.role FROM members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? AND w.kind = 'team' ORDER BY w.name", u.id),
    pendingSetup: !!db.get("SELECT 1 AS x FROM password_links WHERE user_id = ? AND kind = 'welcome' AND expires_at > ?", u.id, now()),
  });

  route('GET', '/api/admin/overview', ({ user }) => {
    requireServerAdmin(user);
    return {
      settings: { name: config.name, signup: config.signup, externalSharing: externalSharing() },
      emailOn: emailOn(),
      version: config.version,
      dataDir: config.dataDir,
      addresses: lanAddresses(),
      users: db.all('SELECT * FROM users ORDER BY disabled_at IS NOT NULL, name').map(adminUser),
      workspaces: db.all("SELECT * FROM workspaces WHERE kind = 'team' ORDER BY name").map((w) => ({
        id: w.id, name: w.name, createdAt: w.created_at,
        members: db.get('SELECT COUNT(*) AS n FROM members WHERE workspace_id = ?', w.id).n,
        pages: db.get('SELECT COUNT(*) AS n FROM pages WHERE workspace_id = ? AND deleted_at IS NULL', w.id).n,
        owners: db.all("SELECT u.name FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.role = 'owner' ORDER BY u.name", w.id).map((r) => r.name),
        myRole: roleIn(user.id, w.id),
      })),
    };
  });

  route('PATCH', '/api/admin/settings', ({ user, body }) => {
    requireServerAdmin(user);
    const patch = {};
    if (body.name !== undefined) {
      const name = String(body.name).trim().slice(0, 80);
      if (!name) fail(400, 'Give the server a name');
      patch.name = name;
    }
    if (body.signup !== undefined) patch.signup = body.signup === 'open' ? 'open' : 'invite';
    if (body.externalSharing !== undefined) patch.externalSharing = body.externalSharing === 'admins' ? 'admins' : 'anyone';
    saveServerSettings(patch);
    return { settings: { name: config.name, signup: config.signup, externalSharing: externalSharing() } };
  });

  // outgoing email (SMTP) for invitations and share notifications
  const publicEmail = (s) => ({ host: s.host || '', port: s.port || '', secure: !!s.secure, user: s.user || '', from: s.from || '', hasPassword: !!s.pass, configured: emailConfigured(s) });
  route('GET', '/api/admin/email', ({ user }) => { requireServerAdmin(user); return publicEmail(emailSettings()); });
  route('PUT', '/api/admin/email', ({ user, body }) => {
    requireServerAdmin(user);
    const cur = emailSettings();
    const next = {
      host: String(body.host || '').trim(), port: Number(body.port) || '', secure: !!body.secure,
      user: String(body.user || '').trim(), from: String(body.from || '').trim(),
      pass: body.pass === undefined || body.pass === '' ? cur.pass || '' : String(body.pass),
    };
    if (body.clear) Object.assign(next, { host: '', port: '', user: '', from: '', pass: '', secure: false });
    if (next.host && !next.from) fail(400, 'Enter the “From” address emails are sent from');
    db.run("INSERT INTO settings (key, value) VALUES ('email', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(next));
    return publicEmail(next);
  });
  route('POST', '/api/admin/email/test', async ({ user, body }) => {
    requireServerAdmin(user);
    const to = String(body.to || user.email).trim();
    try {
      await sendEmail(emailSettings(), { to, subject: 'Local Notes: test email', heading: 'Email is working', lines: [`This test came from ${config.name} on Local Notes. Invitations and share notifications will be sent from this address.`] });
    } catch (e) { fail(400, `Couldn’t send: ${e.message}`); }
    return { ok: true, to };
  });

  // Add a person directly: creates the account and returns a link for them to choose a password.
  route('POST', '/api/admin/users', async ({ user, body, req }) => {
    requireServerAdmin(user);
    const email = String(body.email || '').trim().toLowerCase();
    const name = String(body.name || '').trim().slice(0, 80);
    if (!name) fail(400, 'Enter their name');
    if (!validEmail(email)) fail(400, 'Enter a valid email address');
    if (db.get('SELECT 1 AS x FROM users WHERE email = ?', email)) fail(409, 'Someone with that email already has an account');
    const role = ROLES.includes(body.role) ? body.role : 'editor';
    const wsIds = (Array.isArray(body.workspaceIds) ? body.workspaceIds : []).filter((id) => db.get("SELECT 1 AS x FROM workspaces WHERE id = ? AND kind = 'team'", id));
    const { u, token } = db.tx(() => {
      const id = newId(9);
      db.run('INSERT INTO users (id, email, name, pw, color, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, email, name, hashPassword(newToken()), pickColor(id), body.isAdmin ? 1 : 0, now());
      const nu = userById(id);
      const priv = createWorkspace(nu, 'Private', 'private');
      addPage(priv, nu, { title: 'Getting started', markdown: GETTING_STARTED });
      for (const ws of wsIds) db.run('INSERT OR IGNORE INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', ws, id, role, now());
      return { u: nu, token: passwordLink(id, 'welcome', user.id, 14) };
    });
    acceptPageInvites(u);
    for (const ws of wsIds) broadcast(ws, { type: 'members' });
    let emailed = {};
    if (body.sendEmail !== false && body.baseUrl !== undefined) {
      emailed = await mail(u.email, `You’ve been added to ${config.name} on Local Notes`, {
        heading: `Welcome to ${config.name}`,
        lines: [`${user.name} added you to ${config.name} on Local Notes. Choose a password to get started.`],
        button: { label: 'Choose your password', url: `${baseUrlFor(req, body)}/#/password/${token}` },
        footer: 'This link works once, for 14 days.',
      }, user.email);
    }
    return { user: adminUser(u), token, ...emailed };
  });

  route('PATCH', '/api/admin/users/:id', ({ user, params, body }) => {
    requireServerAdmin(user);
    const target = userById(params.id);
    if (!target) fail(404, 'Person not found');
    if (body.isAdmin !== undefined) {
      if (!body.isAdmin && target.is_admin && adminCount() <= 1) fail(400, 'The server needs at least one admin. Make someone else an admin first.');
      db.run('UPDATE users SET is_admin = ? WHERE id = ?', body.isAdmin ? 1 : 0, target.id);
    }
    if (body.disabled !== undefined) {
      if (target.id === user.id) fail(400, 'You can’t suspend your own account');
      if (body.disabled && target.is_admin && adminCount() <= 1) fail(400, 'The server needs at least one admin.');
      db.run('UPDATE users SET disabled_at = ? WHERE id = ?', body.disabled ? now() : null, target.id);
      if (body.disabled) {
        db.run('DELETE FROM sessions WHERE user_id = ?', target.id);
        for (const m of db.all('SELECT workspace_id FROM members WHERE user_id = ?', target.id)) collab.kick(target.id, m.workspace_id);
        collab.kickUser?.(target.id);
      }
    }
    return { user: adminUser(userById(target.id)) };
  });

  route('POST', '/api/admin/users/:id/password-link', async ({ user, params, body, req }) => {
    requireServerAdmin(user);
    const target = userById(params.id);
    if (!target) fail(404, 'Person not found');
    const pending = db.get("SELECT 1 AS x FROM password_links WHERE user_id = ? AND kind = 'welcome' AND expires_at > ?", target.id, now());
    const token = passwordLink(target.id, pending ? 'welcome' : 'reset', user.id, pending ? 14 : 2);
    let emailed = {};
    if (body.sendEmail) {
      const url = `${baseUrlFor(req, body)}/#/password/${token}`;
      emailed = await mail(target.email, pending ? `Your invitation to ${config.name}` : `Reset your ${config.name} password`, pending
        ? { heading: `Welcome to ${config.name}`, lines: [`${user.name} added you to ${config.name} on Local Notes. Choose a password to get started.`], button: { label: 'Choose your password', url }, footer: 'This link works once, for 14 days.' }
        : { heading: 'Choose a new password', lines: [`${user.name} sent you a link to reset your ${config.name} password.`], button: { label: 'Choose a new password', url }, footer: 'This link works once, for 2 days. If you didn’t ask for it, you can ignore this email.' }, user.email);
    }
    return { token, ...emailed };
  });

  // Join a workspace as owner (e.g. one whose owners have left).
  route('POST', '/api/admin/workspaces/:id/join', ({ user, params }) => {
    requireServerAdmin(user);
    const ws = db.get("SELECT * FROM workspaces WHERE id = ? AND kind = 'team'", params.id);
    if (!ws) fail(404, 'Workspace not found');
    if (roleIn(user.id, ws.id)) db.run("UPDATE members SET role = 'owner' WHERE workspace_id = ? AND user_id = ?", ws.id, user.id);
    else db.run("INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)", ws.id, user.id, now());
    broadcast(ws.id, { type: 'members' });
    return { ok: true };
  });

  route('GET', '/api/events', ({ user, res }) => { subscribe(user.id, res); return undefined; }, { stream: true });

  // ---------------------------------------------------------------- AI (admin picks the provider; members use it)
  const aiSettings = () => { try { return JSON.parse(db.get("SELECT value FROM settings WHERE key = 'ai'")?.value || '{}'); } catch { return {}; } };
  const saveAISettings = (v) => db.run("INSERT INTO settings (key, value) VALUES ('ai', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(v));
  const requireAdmin = (user) => { if (!user.is_admin) fail(403, 'Only server admins can change AI settings'); };
  const override = (b = {}) => Object.fromEntries(['provider', 'apiKey', 'baseUrl', 'model'].filter((k) => b[k]).map((k) => [k, b[k]]));
  const aiFail = (e) => fail(e.status || 502, e.message);

  route('GET', '/api/ai/status', () => {
    const p = aiLib.publicSettings(aiSettings());
    return { enabled: p.enabled, provider: p.provider, model: p.model, label: p.providers.find((x) => x.id === p.provider)?.label || null };
  });
  route('GET', '/api/ai/settings', ({ user }) => { requireAdmin(user); return aiLib.publicSettings(aiSettings()); });
  route('PUT', '/api/ai/settings', ({ user, body }) => {
    requireAdmin(user);
    try { saveAISettings(aiLib.applySettings(aiSettings(), body)); } catch (e) { aiFail(e); }
    return aiLib.publicSettings(aiSettings());
  });
  route('POST', '/api/ai/models', async ({ user, body }) => {
    requireAdmin(user);
    try { return { models: await aiClient.listModels(aiSettings(), override(body)) }; } catch (e) { return aiFail(e); }
  });
  route('POST', '/api/ai/test', async ({ user, body }) => {
    requireAdmin(user);
    try { return { reply: await aiClient.test(aiSettings(), override(body)) }; } catch (e) { return aiFail(e); }
  });

  async function streamAI(res, start, head) {
    const ac = new AbortController();
    let iterator;
    try { iterator = start(ac.signal); } catch (e) { return aiFail(e); }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    if (head) res.write(`${JSON.stringify(head)}\n`);
    try {
      for await (const t of iterator) res.write(`${JSON.stringify({ delta: t })}\n`);
      res.write('{"done":true}\n');
    } catch (e) {
      if (e.name !== 'AbortError') res.write(`${JSON.stringify({ error: e.message || 'The AI request failed' })}\n`);
    }
    res.end();
    return undefined;
  }
  const aiAllowed = (user) => { if (!rateLimit(`ai:${user.id}`, config.aiRate, 10 * 60 * 1000)) fail(429, 'You’ve reached the AI limit for now. Try again in a few minutes.'); };

  route('POST', '/api/ai/complete', ({ user, body, res }) => {
    aiAllowed(user);
    return streamAI(res, (signal) => aiClient.stream(aiSettings(), {
      system: String(body.system || ''), messages: [{ role: 'user', content: String(body.prompt || '').slice(0, 400000) }],
      effort: ['low', 'medium', 'high'].includes(body.effort) ? body.effort : 'low', maxTokens: 16000, signal,
    }));
  }, { stream: true });

  route('POST', '/api/ai/ask', ({ user, body, res }) => {
    aiAllowed(user);
    // only pages from workspaces this person belongs to (their private space included)
    const docs = [];
    for (const w of db.all('SELECT workspace_id AS id FROM members WHERE user_id = ?', user.id)) {
      for (const v of visiblePages(user.id, w.id)) docs.push({ id: v.page.id, title: v.page.title, text: v.page.markdown, updatedAt: v.page.updated_at });
    }
    for (const sp of sharedWithMe(user)) docs.push({ id: sp.page.id, title: sp.page.title, text: sp.page.markdown, updatedAt: sp.page.updated_at });
    docs.sort((a, b) => b.updatedAt - a.updatedAt).splice(3000);
    const picked = aiLib.pickNotes(String(body.question || ''), docs, { currentId: body.currentPath || null });
    const history = (Array.isArray(body.history) ? body.history : []).slice(-8).filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string');
    return streamAI(res, (signal) => aiClient.stream(aiSettings(), {
      ...aiLib.askPrompt(picked, config.name), messages: [...history, { role: 'user', content: String(body.question || '') }], effort: 'medium', maxTokens: 16000, signal,
    }), { sources: picked.map((p) => ({ id: p.id, title: p.title })) });
  }, { stream: true });

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

  return { handle, userForToken, roleIn, pageRole, mirror, broadcast, db };
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
