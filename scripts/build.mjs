// Bundles src/ into public/app.js + public/app.css (fonts land in public/fonts/).
// Big, rarely used libraries (import/export) are split into public/chunks/ and loaded on demand.
import { build } from 'esbuild';
import { rmSync, copyFileSync } from 'node:fs';

rmSync('public/fonts', { recursive: true, force: true });
rmSync('public/chunks', { recursive: true, force: true });
await build({
  entryPoints: { app: 'src/main.js' },
  bundle: true,
  minify: true,
  format: 'esm',
  splitting: true,
  target: 'es2022',
  outdir: 'public',
  chunkNames: 'chunks/[name]-[hash]',
  loader: { '.woff2': 'file', '.woff': 'file' },
  assetNames: 'fonts/[name]-[hash]',
  publicPath: '/',
  legalComments: 'none',
  logLevel: 'info',
});
// PDF import runs pdf.js in a worker
copyFileSync('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'public/pdf.worker.js');
