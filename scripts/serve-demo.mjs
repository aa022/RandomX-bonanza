// Local server for netlify-demo/ (the configurator). The page's jsDelivr pin
// is rewritten to /dist/, served from this checkout's dist/ with the CORS and
// CORP headers jsDelivr sends. netlify-demo/_headers applies to the page as on
// Netlify; --no-isolation drops COOP/COEP to test a page without them.
//   node scripts/serve-demo.mjs [--port 8090] [--no-isolation]
import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const site = join(root, 'netlify-demo'), dist = join(root, 'dist');
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const port = Number(option('--port') || process.env.PORT || 8090);
const isolation = !args.includes('--no-isolation');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be 1–65535');
if (!existsSync(join(dist, 'embed.js'))) throw new Error('Missing dist/embed.js; run make embed first');
const PIN = /https:\/\/cdn\.jsdelivr\.net\/gh\/aa022\/RandomX-bonanza@[0-9a-f]{7,40}\/dist\//g;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.json': 'application/json', '.md': 'text/plain; charset=utf-8', '': 'text/plain; charset=utf-8' };
const ISOLATION = ['cross-origin-opener-policy', 'cross-origin-embedder-policy'];

// Netlify _headers: a path pattern line, then indented "Name: value" lines.
const rules = [];
for (const line of readFileSync(join(site, '_headers'), 'utf8').split('\n')) {
  if (!line.trim() || line.trim().startsWith('#')) continue;
  if (!/^\s/.test(line)) {
    const glob = line.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    rules.push({ pattern: new RegExp('^' + glob + '$'), headers: [] }); continue;
  }
  const at = line.indexOf(':');
  if (rules.length && at > 0) rules.at(-1).headers.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
}

function file(base, path) {
  const target = normalize(join(base, decodeURIComponent(path)));
  if (target !== base && !target.startsWith(base + sep)) return null;
  try { return statSync(target).isFile() ? target : null; } catch (_) { return null; }
}

createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
  res.setHeader('Cache-Control', 'no-store');
  let target;
  try {
    if (pathname.startsWith('/dist/')) {
      // The CDN stand-in: cross-origin readable, no page headers.
      target = file(dist, pathname.slice(6));
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    } else {
      target = file(site, pathname.endsWith('/') ? pathname + 'index.html' : pathname);
      if (target && target.endsWith(sep + '_headers')) target = null;
      for (const rule of rules) {
        if (!rule.pattern.test(pathname)) continue;
        for (const [name, value] of rule.headers) if (isolation || !ISOLATION.includes(name.toLowerCase())) res.setHeader(name, value);
      }
    }
  } catch (_) { target = null; }
  if (!target) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found\n'); return; }
  res.setHeader('Content-Type', TYPES[extname(target)] || 'application/octet-stream');
  if (target.endsWith('.html')) { res.end(req.method === 'HEAD' ? '' : readFileSync(target, 'utf8').replace(PIN, '/dist/')); return; }
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(target).pipe(res);
}).listen(port, '127.0.0.1', () => {
  const pin = (readFileSync(join(site, 'index.html'), 'utf8').match(PIN) || ['(no jsDelivr pin found)'])[0];
  console.log(`[demo] http://localhost:${port}/ serves netlify-demo/ ` +
    (isolation ? 'with _headers (cross-origin isolated)' : 'without COOP/COEP (--no-isolation)'));
  console.log(`[demo] ${pin} → /dist/ from this checkout`);
});
