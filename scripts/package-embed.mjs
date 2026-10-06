import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// Full mode: the pthread build behind embed-worker.js. Light mode: the
// randomx_st build in plain workers, plus fb_full.js for replicas.
const files = ['embed.js', 'embed-worker.js', 'worker.js', 'randomx.js', 'randomx.wasm',
  'randomx_st.js', 'randomx_st.wasm', 'fb_full.js'];
if (existsSync(root + 'public/randomx.worker.js')) files.push('randomx.worker.js');
for (const file of files) {
  if (!existsSync(root + 'public/' + file)) throw new Error('Missing public/' + file + '; run make build first');
}
mkdirSync(root + 'dist', { recursive: true });
const manifest = { version: JSON.parse(readFileSync(root + 'package.json')).version, files: {} };
for (const file of files) {
  copyFileSync(root + 'public/' + file, root + 'dist/' + file);
  const bytes = readFileSync(root + 'dist/' + file);
  manifest.files[file] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    integrity: 'sha384-' + createHash('sha384').update(bytes).digest('base64') };
}
copyFileSync(root + 'LICENSE', root + 'dist/LICENSE');
copyFileSync(root + 'wasm/src/LICENSE', root + 'dist/RandomX.LICENSE');
writeFileSync(root + 'dist/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log('jsDelivr-ready assets in dist/ (' + files.length + ' files, version ' + manifest.version + ')');
