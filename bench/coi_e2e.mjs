// Browser E2E for the opt-in COOP/COEP service worker (?coi=1, public/coi-sw.js).
//
// Serves public/ over http://127.0.0.1 WITHOUT COOP/COEP (localhost is a secure
// context, so service workers work), drives headless Chromium over CDP and
// checks the page's own path decision (miner.js noSab / fullMemory, the log
// after Start), the reload count (index.html hits on the server) and a short
// hash run through the page's state.worker on a synthetic job, whose shares
// are re-verified in Node with randomx_st (portable interpreter).
//
// Scenarios (each in a fresh Chromium profile):
//   plain   no param: not isolated, no-SAB path, no SW registered
//   coi     ?coi=1: one reload, isolated, SAB path (?light=1 run, then a
//           full-mode run unless --full 0); reload without params stays
//           isolated; ?coi=0 unregisters, the next load is no-SAB again
//   nosw    navigator.serviceWorker stubbed away: no reload, no-SAB runs
//   regfail register() rejects late, Start clicked meanwhile: no reload, Start is
//           held until the failure settles, then no-SAB runs
//   noinject coi-sw.js served without the header injection: at most one
//           reload, then no-SAB with a 'still not crossOriginIsolated' note
//   headers the server sends COOP/COEP itself (like the proxy): ?coi=1 does nothing
//
//   node bench/coi_e2e.mjs [--threads 2] [--secs 8] [--full 0|1] [--only coi,nosw]
//
// Hashrates printed here are from short runs and noisy; the A/B against the
// proxy (`make serve`, real headers) uses the same page with --threads/--secs.
import http from 'http'; import fs from 'fs'; import os from 'os'; import path from 'path';
import { spawn } from 'child_process'; import { createRequire } from 'module'; import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const THREADS = Number(arg('threads', 2)), SECS = Number(arg('secs', 8)), FULL = arg('full', '1') !== '0';
const ONLY = arg('only', 'plain,coi,nosw,regfail,noinject,headers').split(',');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── static server, no COOP/COEP; counts page loads; optional non-injecting SW ──
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.woff2': 'font/woff2' };
let pageHits = 0, noInject = false, withHeaders = false;
const srv = http.createServer((q, r) => {
  const rel = decodeURIComponent(new URL(q.url, 'http://x').pathname);
  const f = path.join(ROOT, rel === '/' ? 'index.html' : rel);
  if (!f.startsWith(ROOT + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
  if (f.endsWith('index.html')) pageHits++;
  r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store',
    ...(withHeaders ? { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } : {}) });
  if (noInject && f.endsWith('coi-sw.js')) {
    const src = fs.readFileSync(f, 'utf8'), stub = src.replace(/^.*headers\.set\('Cross-Origin.*$/gm, '');
    if (stub === src) throw new Error('coi-sw.js: header injection lines not found');
    return r.end(stub);
  }
  fs.createReadStream(f).pipe(r);
}).listen(0, '127.0.0.1');
await new Promise((r) => srv.once('listening', r));
const BASE = `http://127.0.0.1:${srv.address().port}/index.html`;

// ── Chromium over CDP (fresh profile per scenario, debugging port from the profile) ──
async function launch() {
  const prof = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'coi-chr-'));
  const chr = spawn('/usr/bin/chromium', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${prof}`,
    '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(100);
    try { port = fs.readFileSync(path.join(prof, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch (_) {}
  }
  let tgt;
  for (let i = 0; i < 50 && !tgt; i++) {
    try { tgt = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); } catch (_) {}
    if (!tgt) await sleep(100);
  }
  const ws = new WebSocket(tgt.webSocketDebuggerUrl); await new Promise((r) => ws.onopen = r);
  let id = 0; const pend = new Map(); const ev = { loads: 0, last: Date.now() };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    if (m.method === 'Page.loadEventFired' || m.method === 'Page.frameNavigated') { ev.last = Date.now(); if (m.method === 'Page.loadEventFired') ev.loads++; }
  };
  const cdp = (method, params = {}) => new Promise((r) => { pend.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  await cdp('Page.enable');
  const close = async () => {
    try { ws.close(); } catch (_) {}
    const gone = new Promise((r) => chr.once('exit', r)); chr.kill(); await gone;
    fs.rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { cdp, ev, close };
}

// Navigate, then wait until no navigation/load for 3 s (a coi reload lands well within that).
async function load(b, query) {
  const hits0 = pageHits, loads0 = b.ev.loads;
  await b.cdp('Page.navigate', { url: BASE + query });
  const t0 = Date.now();
  while (Date.now() - t0 < 30000 && (b.ev.loads === loads0 || Date.now() - b.ev.last < 3000)) await sleep(100);
  return pageHits - hits0;
}

async function evaluate(b, expression, timeoutMs = 30000) {
  const res = (await b.cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs })).result;
  if (!res.result || res.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(res).slice(0, 600));
  return res.result.value;
}

const probe = (b) => evaluate(b, `(async () => ({
  coi: self.crossOriginIsolated, sab: typeof SharedArrayBuffer, noSab, fullMemory,
  ctl: (navigator.serviceWorker && navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL) || null,
  regs: navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).length : -1,
  pending: !!window.__coiPending, coiLog: window.__coiLog || null,
}))()`);

// Start through the page's own toggle(), hook state.worker, post a synthetic job,
// hash for SECS after the 'mode' message, stop. Returns shares/rates/log.
const blob = '0e0ea1e1d2a106' + 'aa'.repeat(32) + '00000000' + 'bb'.repeat(32) + '01';
const seed = 'cd'.repeat(32);
const run = (b, secs) => evaluate(b, `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  toggle();
  for (let i = 0; i < 200 && !state.worker; i++) await sleep(50);
  const w = state.worker, orig = w.onmessage;
  const got = { shares: [], rates: [], modes: [], errors: [], ready: false };
  w.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'share') got.shares.push(m);
    else if (m.type === 'hashrate') got.rates.push(m.rate); else if (m.type === 'mode') got.modes.push(m.mode);
    else if (m.type === 'error') got.errors.push(m.message);
    orig.call(w, e);
  };
  for (let i = 0; i < 600 && !state.workerReady; i++) await sleep(50);
  got.ready = state.workerReady; // a deferred (coi) start may be ready before the hook
  const t0 = performance.now();
  w.postMessage({ type: 'job', blob: '${blob}', target: 'ffffff7f', seed_hash: '${seed}', job_id: 't1', job_seq: 1 });
  for (let i = 0; i < 1800 && !got.modes.length && !got.errors.length; i++) await sleep(100);
  got.modeMs = performance.now() - t0; got.rates = [];
  await sleep(${secs * 1000});
  w.postMessage({ type: 'stop' }); toggle();
  got.log = document.getElementById('log').innerText;
  return got;
})()`, (secs + 240) * 1000);

// ── share verification in Node (randomx_st, light, portable interpreter) ──
let V;
function verify(shares) {
  if (!V) V = { p: require(path.join(ROOT, 'randomx_st.js'))() };
  return V.p.then((M) => {
    const c = (n, r, a) => M.cwrap(n, r, a);
    if (!V.vm) {
      const cache = c('randomx_alloc_cache', 'number', ['number'])(0); const kb = Buffer.from(seed, 'hex'); const kp = M._malloc(64); M.HEAPU8.set(kb, kp);
      c('randomx_init_cache', null, ['number', 'number', 'number'])(cache, kp, kb.length);
      V.vm = c('randomx_create_vm', 'number', ['number', 'number', 'number'])(0, cache, 0);
      V.inp = M._malloc(256); V.out = M._malloc(32);
    }
    let ok = 0, bad = 0;
    for (const s of [...shares].sort(() => Math.random() - 0.5).slice(0, 24)) {
      const bb = Buffer.from(blob, 'hex'); Buffer.from(s.nonce, 'hex').copy(bb, 39); M.HEAPU8.set(bb, V.inp);
      c('randomx_calculate_hash', null, ['number', 'number', 'number', 'number'])(V.vm, V.inp, bb.length, V.out);
      Buffer.from(M.HEAPU8.slice(V.out, V.out + 32)).toString('hex') === s.result ? ok++ : bad++;
    }
    return { ok, bad, distinct: new Set(shares.map((s) => s.nonce)).size === shares.length };
  });
}

let fails = 0;
const check = (name, cond, info = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' ' + info : ''}`); if (!cond) fails++; };
const pathOf = (log) => /No SharedArrayBuffer/.test(log) ? 'no-SAB' : /crossOriginIsolated=true/.test(log) ? 'SAB' : '?';

async function hashRun(b, label, wantPath) {
  const g = await run(b, SECS);
  const v = await verify(g.shares);
  const tail = g.rates.slice(-3), hs = tail.length ? tail.reduce((a, x) => a + x, 0) / tail.length : 0;
  console.log(`  ${label}: path=${pathOf(g.log)} mode=${g.modes.join(',') || '-'} (${(g.modeMs / 1000).toFixed(1)} s to mode) ` +
    `H/s~${hs.toFixed(1)} (noisy, ${SECS} s) ready=${g.ready} shares=${g.shares.length} verified=${v.ok} bad=${v.bad} distinct=${v.distinct} errors=${JSON.stringify(g.errors)}`);
  check(`${label}: ${wantPath} path in the page log`, pathOf(g.log) === wantPath);
  check(`${label}: shares verify`, g.ready && v.ok > 0 && v.bad === 0 && v.distinct && !g.errors.length);
  return g;
}

const q = (s) => `?threads=${THREADS}${s ? '&' + s : ''}`;

if (ONLY.includes('plain')) {
  console.log('[plain] no param');
  const b = await launch();
  try {
    const hits = await load(b, q(''));
    const p = await probe(b);
    console.log('  ', JSON.stringify(p));
    check('one page load', hits === 1, `(hits=${hits})`);
    check('not isolated, no-SAB, no SW', p.coi === false && p.noSab === true && p.regs === 0 && p.ctl === null);
    await hashRun(b, 'plain', 'no-SAB');
  } finally { await b.close(); }
}

if (ONLY.includes('coi')) {
  console.log('[coi] ?coi=1, then no params, then ?coi=0');
  const b = await launch();
  try {
    let hits = await load(b, q('coi=1&light=1'));
    let p = await probe(b);
    console.log('  ', JSON.stringify(p));
    check('exactly one reload', hits === 2, `(hits=${hits})`);
    check('isolated, SAB path, controlled by coi-sw.js', p.coi === true && p.sab === 'function' && p.noSab === false && /coi-sw\.js$/.test(p.ctl || ''));
    const g = await hashRun(b, 'coi light', 'SAB');
    check('log says the coi service worker is active', /coi: service worker active/.test(g.log));
    if (FULL) {
      hits = await load(b, q('coi=1'));
      p = await probe(b);
      check('?coi=1 again: no reload, full mode chosen', hits === 1 && p.coi === true && p.fullMemory === true, `(hits=${hits})`);
      const gf = await hashRun(b, 'coi full', 'SAB');
      check('full mode reached', gf.modes.includes('full'));
    }
    hits = await load(b, q(''));
    p = await probe(b);
    check('reload without params stays isolated', hits === 1 && p.coi === true && p.noSab === false, `(hits=${hits})`);
    hits = await load(b, q('coi=0'));
    p = await probe(b);
    console.log('  ', JSON.stringify(p));
    check('?coi=0: one reload, unregistered, not isolated', hits === 2 && p.regs === 0 && p.coi === false && p.noSab === true, `(hits=${hits})`);
    hits = await load(b, q(''));
    p = await probe(b);
    check('next load is no-SAB again', hits === 1 && p.coi === false && p.noSab === true && p.regs === 0, `(hits=${hits})`);
  } finally { await b.close(); }
}

if (ONLY.includes('nosw')) {
  console.log('[nosw] navigator.serviceWorker stubbed to undefined, ?coi=1');
  const b = await launch();
  try {
    await b.cdp('Page.addScriptToEvaluateOnNewDocument', { source:
      "Object.defineProperty(Navigator.prototype, 'serviceWorker', { get() { return undefined; }, configurable: true });" });
    const hits = await load(b, q('coi=1'));
    const p = await probe(b);
    console.log('  ', JSON.stringify(p));
    check('no reload, not isolated, no-SAB, not pending', hits === 1 && p.coi === false && p.noSab === true && !p.pending, `(hits=${hits})`);
    await hashRun(b, 'nosw', 'no-SAB');
  } finally { await b.close(); }
}

if (ONLY.includes('regfail')) {
  console.log('[regfail] ServiceWorkerContainer.register rejects after 5 s, Start clicked while pending, ?coi=1');
  const b = await launch();
  try {
    await b.cdp('Page.addScriptToEvaluateOnNewDocument', { source:
      "ServiceWorkerContainer.prototype.register = function () { return new Promise((_, no) => setTimeout(() => no(new Error('blocked by test')), 5000)); };" });
    const hits = await load(b, q('coi=1'));
    let p = await probe(b);
    check('no reload, no-SAB decided, Start held while pending', hits === 1 && p.noSab === true && p.pending === true, `(hits=${hits})`);
    const g = await hashRun(b, 'regfail', 'no-SAB');
    check('Start waited for the settle', /coi: waiting for the service worker reload/.test(g.log) && /registration failed/.test(g.log));
    p = await probe(b);
    check('settled, not pending', !p.pending && /registration failed/.test(p.coiLog || ''));
    const again = await load(b, q('coi=1'));
    check('second ?coi=1 load in the tab: no retry', again === 1 && /already reloaded once/.test((await probe(b)).coiLog || ''), `(hits=${again})`);
  } finally { await b.close(); }
}

if (ONLY.includes('noinject')) {
  console.log('[noinject] coi-sw.js without header injection, ?coi=1');
  noInject = true;
  const b = await launch();
  try {
    const hits = await load(b, q('coi=1'));
    await sleep(3000);
    const p = await probe(b);
    console.log('  ', JSON.stringify(p));
    check('at most one reload, controlled, not isolated, no-SAB', hits <= 2 && p.coi === false && p.noSab === true &&
      /coi-sw\.js$/.test(p.ctl || '') && /still not crossOriginIsolated/.test(p.coiLog || ''), `(hits=${hits})`);
    const again = await load(b, q('coi=1'));
    check('another ?coi=1 load: no reload', again === 1, `(hits=${again})`);
    await hashRun(b, 'noinject', 'no-SAB');
  } finally { await b.close(); noInject = false; }
}

if (ONLY.includes('headers')) {
  console.log('[headers] server sends COOP/COEP, ?coi=1');
  withHeaders = true;
  const b = await launch();
  try {
    const hits = await load(b, q('coi=1'));
    const p = await probe(b);
    console.log('  ', JSON.stringify(p));
    check('no reload, isolated, SAB, no SW registered', hits === 1 && p.coi === true && p.noSab === false && p.regs === 0 && !p.pending, `(hits=${hits})`);
  } finally { await b.close(); withHeaders = false; }
}

srv.close();
console.log(fails ? `coi_e2e: ${fails} FAILED` : 'coi_e2e: PASS');
process.exit(fails ? 1 : 0);
