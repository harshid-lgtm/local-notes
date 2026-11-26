// Bundles the team server into one file the desktop app can run ("Host a team server on this computer").
// Output: team-bundle/server.mjs and reset-password.mjs (git-ignored). Used by the desktop installers
// and packed into local-notes-team-server.tar.gz for the Linux installer (scripts/pack-team-server.mjs).
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
  // some dependencies call require() for Node built-ins
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
};
await esbuild.build({ ...common, entryPoints: [path.join(root, 'team-server', 'src', 'index.js')], outfile: path.join(root, 'team-bundle', 'server.mjs') });
await esbuild.build({ ...common, entryPoints: [path.join(root, 'team-server', 'src', 'reset-password.js')], outfile: path.join(root, 'team-bundle', 'reset-password.mjs') });
console.log('team server bundle -> team-bundle/server.mjs, reset-password.mjs');
