import * as esbuild from 'file:///C:/Users/15040/.workbuddy/binaries/node/workspace/node_modules/esbuild/lib/main.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

await esbuild.build({
  entryPoints: [path.join(ROOT, 'src/main.ts')],
  bundle: true,
  format: 'iife',
  target: ['chrome110', 'firefox110', 'safari16'],
  outfile: path.join(ROOT, 'dist/bundle.js'),
  minify: true,
  legalComments: 'none',
  nodePaths: ['C:/Users/15040/.workbuddy/binaries/node/workspace/node_modules'],
  loader: { '.txt': 'text' },
});

const js = fs.readFileSync(path.join(ROOT, 'dist/bundle.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'dist/bundle.css'), 'utf8');
const tpl = fs.readFileSync(path.join(ROOT, 'template.html'), 'utf8');

const html = tpl
  .replace('__CSS__', () => css)
  .replace('__JS__', () => js);

const out = path.join(ROOT, 'standalone.html');
fs.writeFileSync(out, html);
const kb = n => (n / 1024).toFixed(1) + 'KB';
console.log('built:', out);
console.log('  js  :', kb(Buffer.byteLength(js)));
console.log('  css :', kb(Buffer.byteLength(css)));
console.log('  html:', kb(Buffer.byteLength(html)));
