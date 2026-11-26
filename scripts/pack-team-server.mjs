// Packs the bundled team server + web app into dist/local-notes-team-server.tar.gz for the
// one-command Linux installer (site/install.sh). Run after `npm run build` and `npm run build:team-bundle`.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const stage = path.join(root, 'dist', 'team-server-stage');
const app = path.join(stage, 'local-notes-team-server');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(app, { recursive: true });
for (const f of ['server.mjs', 'reset-password.mjs']) fs.copyFileSync(path.join(root, 'team-bundle', f), path.join(app, f));
fs.cpSync(path.join(root, 'public'), path.join(app, 'public'), { recursive: true });
fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'local-notes-team-server', version, type: 'module', private: true }, null, 2));
fs.writeFileSync(path.join(app, 'VERSION'), version + '\n');

const out = path.join(root, 'dist', 'local-notes-team-server.tar.gz');
execFileSync('tar', ['-czf', path.relative(root, out), '-C', path.relative(root, stage), 'local-notes-team-server'], { cwd: root, stdio: 'inherit' });
const sha = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex');
fs.writeFileSync(out + '.sha256', `${sha}  local-notes-team-server.tar.gz\n`);
fs.rmSync(stage, { recursive: true, force: true });
console.log(`packed ${path.relative(root, out)} (${version}, ${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
