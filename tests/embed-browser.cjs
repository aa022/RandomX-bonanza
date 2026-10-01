// Optional real-browser integration check. Requires puppeteer-core (set
// PUPPETEER_MODULE to its path) and CHROME_PATH if Chrome is elsewhere.
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const puppeteer = require(process.env.PUPPETEER_MODULE || 'puppeteer-core');
const { WebSocketServer } = require('../vendor/ws');
const root = path.resolve(__dirname, '..');
const proxyPort = 17880, poolPort = 17881, fixturePort = 17882;
const job = { job_id: 'fixture-job', blob: '00'.repeat(76), seed_hash: '00'.repeat(32), target: 'ffffffff' };
const poolSockets = new Set();
const fixedBridges = new Set(), fixedURLs = [], fixedLogins = [];
const fixedPeers = new Map();
let fixedPongs = 0, fixedKeepalives = 0, forceFixedNonce = false;
const donationWallet = 'fixture-donation-wallet';
let logins = 0, submits = 0, html = '', browser, proxy, page, lightTab;
let advertisedNicehash = false, nextPrefix = 0x80, nicehashSubmits = 0, boundaryShare = false;
// Every submit with the blob the pool assigned (re-hashed in Node at the end),
// the last login, and every fixture path served (workers' fetches included).
const poolShares = [], served = [];
let lastLogin = null;
const agent = 'randomx-embed/' + require('../package.json').version;
const engineAsset = /^\/(randomx(_st)?\.(js|wasm)|(embed-)?worker\.js|fb_full\.js)$/;
const errors = [];
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'randomx-browser-'));
const listen = (server, port) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
const pool = net.createServer(socket => {
  poolSockets.add(socket); socket.on('close', () => poolSockets.delete(socket));
  // Reconnect scenarios reset these connections; a reset is not a test failure.
  socket.on('error', () => {});
  let buffer = '';
  let nicehash = false, prefix = 0;
  const seenNonces = new Set();
  const assignedJobs = new Map();
  const peer = { shares: 0, jobShares: new Map() };
  const jobBlob = p => nicehash ? job.blob.slice(0, 84) + p.toString(16).padStart(2, '0') + job.blob.slice(86) : job.blob;
  const makeJob = id => {
    assignedJobs.set(id, prefix);
    return { ...job, job_id: id, algo: 'rx/0', height: 123, blob: jobBlob(prefix) };
  };
  peer.newJob = () => {
    prefix = nextPrefix++ % 256;
    const nextJob = makeJob('fixture-job-' + prefix);
    socket.write(JSON.stringify({ method: 'job', params: nextJob }) + '\n');
    return nextJob.job_id;
  };
  socket.on('close', () => fixedPeers.delete(socket));
  socket.on('error', () => {});
  socket.on('data', chunk => {
    buffer += chunk.toString(); const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      assert.ok(Number.isInteger(message.id));
      assert.ok(Buffer.byteLength(line) <= 4096);
      if (message.method === 'login') {
        assert.equal(message.jsonrpc, '2.0');
        assert.ok(message.params.login); assert.ok(message.params.pass);
        nicehash = advertisedNicehash || forceFixedNonce; prefix = nextPrefix++ % 256;
        if (forceFixedNonce) fixedPeers.set(socket, peer);
        lastLogin = message.params; logins++; socket.write(JSON.stringify({ id: message.id, result: {
          id: 'fixture-miner', job: makeJob(job.job_id),
          extensions: advertisedNicehash ? ['nicehash', 'keepalive'] : []
        } }) + '\n');
      } else if (message.method === 'submit') {
        assert.equal(message.params.id, 'fixture-miner');
        assert.match(message.params.nonce, /^[0-9a-f]{8}$/);
        assert.match(message.params.result, /^[0-9a-f]{64}$/);
        if (nicehash) {
          assert.equal(message.params.nonce.slice(6), assignedJobs.get(message.params.job_id).toString(16).padStart(2, '0'), 'each job assigned nonce byte is preserved during real mining');
          const nonceKey = message.params.job_id + ':' + message.params.nonce;
          assert.ok(!seenNonces.has(nonceKey), 'a session must not repeat submitted nonces for a job');
          if (['feffff', 'ffffff'].includes(message.params.nonce.slice(0, 6))) boundaryShare = true;
          seenNonces.add(nonceKey); nicehashSubmits++;
        }
        poolShares.push({ blob: jobBlob(assignedJobs.get(message.params.job_id)), nonce: message.params.nonce, result: message.params.result });
        peer.shares++; peer.jobShares.set(message.params.job_id, (peer.jobShares.get(message.params.job_id) || 0) + 1);
        submits++; socket.write(JSON.stringify({ id: message.id, result: { status: 'OK' } }) + '\n');
      } else if (message.method === 'keepalived') {
        socket.write(JSON.stringify({ id: message.id, result: { status: 'KEEPALIVED' } }) + '\n');
      } else assert.fail('Unexpected pool RPC: ' + message.method);
    }
  });
});
const fixture = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  served.push(url.pathname);
  const policyCase = url.pathname === '/policy' ? url.searchParams.get('case') : null;
  // /open serves the test page without COOP/COEP: not crossOriginIsolated.
  const open = url.pathname === '/open';
  if (!open) res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (!open && policyCase !== 'isolation') res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (policyCase === 'permission') res.setHeader('Permissions-Policy', 'cross-origin-isolated=()');
  if (['worker', 'assets', 'wasm'].includes(policyCase)) {
    res.setHeader('Content-Security-Policy', `default-src 'self'; style-src 'unsafe-inline'; ` +
      `script-src 'self' blob:${policyCase === 'wasm' ? '' : " 'wasm-unsafe-eval'"}; ` +
      `worker-src ${policyCase === 'worker' ? "'none'" : "'self' blob:"}; ` +
      `connect-src ${policyCase === 'assets' ? "'none'" : "'self' ws://localhost:" + proxyPort}`);
  }
  if (url.pathname === '/policy') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><body><script defer src="/embed.js" data-auto="false"></script>' +
      '<script defer src="/policy-init.js"></script></body></html>'); return;
  }
  if (url.pathname === '/policy-init.js') {
    res.setHeader('Content-Type', 'application/javascript');
    res.end(`window.policyErrors=[]; document.addEventListener('randomx:error', e=>policyErrors.push(e.detail));
      window.policyMiner=RandomXEmbed.create({wallet:'fixture-wallet',pool:'127.0.0.1',port:${poolPort},
        proxy:'ws://localhost:${proxyPort}',mode:new URLSearchParams(location.search).get('mode'),workload:50,
        ...(new URLSearchParams(location.search).get('mode')==='light'?{replicas:0}:{})});`); return;
  }
  if (url.pathname === '/test' || open) { res.setHeader('Content-Type', 'text/html'); res.end(html); return; }
  const file = path.basename(url.pathname);
  const target = path.join(root, 'dist', file);
  if (!fs.existsSync(target)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'application/javascript');
  fs.createReadStream(target).pipe(res);
});

// An independent fixed-route JSON-RPC adapter: it does not implement the
// reference bridge's query routing, legacy methods or default wallet.
const fixedWS = new WebSocketServer({ noServer: true });
fixture.on('upgrade', (req, socket, head) => {
  if (req.url !== '/fixed?token=fixture') { socket.destroy(); return; }
  fixedURLs.push(req.url);
  fixedWS.handleUpgrade(req, socket, head, ws => fixedWS.emit('connection', ws));
});
fixedWS.on('connection', ws => {
  const upstream = net.createConnection({ host: '127.0.0.1', port: poolPort });
  const link = { ws, upstream };
  fixedBridges.add(link);
  let ready = false, queue = [], buffer = '';
  upstream.on('connect', () => { ready = true; for (const line of queue) upstream.write(line); queue = []; });
  ws.on('message', bytes => {
    const message = JSON.parse(bytes.toString());
    assert.ok(['login', 'submit', 'keepalived'].includes(message.method));
    if (message.method === 'login') {
      fixedLogins.push(message.params);
      if (message.params.login !== donationWallet) {
        ws.send(JSON.stringify({ id: message.id, error: { code: -1, message: 'Donation wallet required' } }));
        ws.close(4001, 'Donation wallet required'); return;
      }
    }
    if (message.method === 'keepalived') fixedKeepalives++;
    const line = JSON.stringify(message) + '\n';
    if (ready) upstream.write(line); else queue.push(line);
  });
  upstream.on('data', bytes => {
    buffer += bytes.toString(); const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines) if (line.trim() && ws.readyState === 1) ws.send(line);
  });
  upstream.on('error', () => ws.close());
  upstream.on('close', () => ws.close());
  ws.on('close', () => { upstream.destroy(); fixedBridges.delete(link); });
  ws.on('pong', () => fixedPongs++);
  ws.ping();
});

function forceNonceBoundary(page) {
  let controlWorker;
  page.on('workercreated', worker => {
    // The root worker exists before its page-owned pthreads are spawned.
    // Seed only its nonce RNG; keep the served distribution and CSP intact.
    if (controlWorker) return;
    controlWorker = worker;
    worker.evaluate(() => { Math.random = () => 1 - 3 / 0x1000000; })
      .catch(error => errors.push('Cannot force test nonce boundary: ' + error.message));
  });
}
// Light-mode fixture page. A Worker subclass, installed before the embed,
// records each engine worker the embed constructs or terminates, with the
// cache builds, mode reports and shares that the worker pool aggregates away.
const lightPage = options => `<!doctype html><html><body><script>
  window.rx = { names: [], terminated: 0, caches: 0, modes: [], shares: [], statuses: new Set(), early: 0 };
  window.Worker = class extends Worker {
    constructor(url, options) {
      super(url, options);
      const i = rx.names.push(options && options.name) - 1;
      let mode = null;
      this.addEventListener('message', ({ data }) => {
        if (data.type === 'status' && data.message === 'Initializing cache...') rx.caches++;
        else if (data.type === 'mode') rx.modes.push({ worker: i, mode: mode = data.mode });
        // Hashing before a replica build is done (the embed holds jobs until then).
        else if (data.type === 'hashrate' && data.rate > 0 && window.rxMiner && rxMiner.state.engine.replicas &&
          !rxMiner.state.engine.replicasActive) rx.early++;
        else if (data.type === 'share') rx.shares.push({ worker: i, full: mode === 'full', job_id: data.job_id,
          nonce: data.nonce, result: data.result });
      });
    }
    terminate() { rx.terminated++; super.terminate(); }
  };
</script><script src="/embed.js" data-auto="false"></script><script>
  document.addEventListener('randomx:state', ({ detail }) => rx.statuses.add(detail.status));
  window.rxMiner = RandomXEmbed.create(${JSON.stringify(options)});
</script></body></html>`;
// The worker that mined a nonce: n disjoint slots of the 2^24 (NiceHash) or
// 2^32 space; the last slot takes the remainder (worker.js initializeNonceRange).
function nonceSlot(nonce, n, nicehash) {
  const space = nicehash ? 0x1000000 : 0x100000000;
  return Math.min(n - 1, Math.floor(Buffer.from(nonce, 'hex').readUInt32LE(0) % space / Math.floor(space / n)));
}
// The fake pool accepts any hash. Re-hash shares in Node with randomx_st in
// light mode and the interpreter (flags 0): independent of the browser's JIT
// and of a replica's dataset. Returns the shares whose result does not match.
async function rehash(shares) {
  const M = await require(path.join(root, 'dist', 'randomx_st.js'))();
  const seed = Buffer.from(job.seed_hash, 'hex'), seedPtr = M._malloc(seed.length);
  M.HEAPU8.set(seed, seedPtr);
  const cache = M.cwrap('randomx_alloc_cache', 'number', ['number'])(0);
  M.cwrap('randomx_init_cache', null, ['number', 'number', 'number'])(cache, seedPtr, seed.length);
  const vm = M.cwrap('randomx_create_vm', 'number', ['number', 'number', 'number'])(0, cache, 0);
  const hash = M.cwrap('randomx_calculate_hash', null, ['number', 'number', 'number', 'number']);
  const input = M._malloc(256), output = M._malloc(32);
  return shares.filter(share => {
    const blob = Buffer.from(share.blob, 'hex');
    Buffer.from(share.nonce, 'hex').copy(blob, 39);
    M.HEAPU8.set(blob, input); hash(vm, input, blob.length, output);
    return Buffer.from(M.HEAPU8.subarray(output, output + 32)).toString('hex') !== share.result;
  });
}
async function waitUntil(check, timeout = 30000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error('Fixture condition timed out');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

(async () => {
  try {
    await listen(pool, poolPort); await listen(fixture, fixturePort);
    // Unrouted sessions, too, stay on the fixture pool.
    proxy = spawn(process.execPath, ['-e', `const c=require('./config');c.WS_PORT=${proxyPort};c.STRATUM_TCP_PORT=17884;` +
      `c.POOL_HOST='127.0.0.1';c.POOL_PORT=${poolPort};require('./proxy/index')`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Proxy startup timed out')), 5000);
      proxy.stdout.on('data', bytes => { if (bytes.toString().includes('webminer demo')) { clearTimeout(timeout); resolve(); } });
      proxy.once('exit', code => { clearTimeout(timeout); reject(new Error('Proxy exited: ' + code)); });
      proxy.stderr.on('data', bytes => errors.push(bytes.toString()));
    });
    browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true, userDataDir: profile, args: ['--no-first-run', '--no-default-browser-check'] });
    page = await browser.newPage();
    forceNonceBoundary(page);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://localhost:${proxyPort}/`, { waitUntil: 'networkidle0' });
    assert.equal(await page.evaluate(() => crossOriginIsolated), true);
    assert.ok(await page.$('#embedBuilder'));
    assert.equal(await page.$('input[name=efficiencyCores]'), null);
    assert.equal(await page.$eval('input[name=workload]', el => el.max), '80');
    await page.evaluate(() => {
      window.cacheBuilds = 0;
      window.rxStates = [];
      document.addEventListener('randomx:state', ({ detail }) => {
        window.rxStates.push({ phase: detail.phase, status: detail.status });
        if (window.rxStates.length > 20) window.rxStates.shift();
        if (detail.status === 'Initializing cache...') window.cacheBuilds++;
      });
    });
    let engineRequests = 0;
    page.on('request', request => { if (/randomx\.(js|wasm)/.test(request.url())) engineRequests++; });
    await page.evaluate(({ poolPort, proxyPort }) => {
      const form = document.getElementById('embedBuilder');
      form.elements.pool.value = '127.0.0.1'; form.elements.port.value = poolPort;
      form.elements.proxy.value = 'ws://localhost:' + proxyPort;
      form.elements.scriptURL.value = 'http://127.0.0.1:17882/embed.js';
      form.dispatchEvent(new Event('input', { bubbles: true }));
    }, { poolPort, proxyPort });
    await page.click('#embedShowPreview');
    assert.equal(engineRequests, 0);
    assert.equal(logins, 0);
    const shadow = 'div.randomx-embed >>> ';
    await page.click(shadow + '.start');
    assert.equal(engineRequests, 0, 'unchecked consent must block startup');
    await page.click(shadow + 'input[type=checkbox]');
    await page.click(shadow + '.start');
    await page.waitForFunction(() => document.querySelector('#embedPreview .randomx-embed')?.shadowRoot.querySelector('.rate').textContent !== '0 H/s', { timeout: 60000 });
    assert.ok(logins >= 1); assert.ok(submits >= 1);
    console.log('PASS: real full-memory initialization (32 threads), mining, and shares through the embed worker broker');
    const residentWorkers = page.workers();
    const buildsBefore = await page.evaluate(() => window.cacheBuilds);
    assert.equal(buildsBefore, 1);
    const backgroundLogins = logins, backgroundShares = submits;
    const otherTab = await browser.newPage();
    await otherTab.goto('about:blank'); await otherTab.bringToFront();
    await page.waitForFunction(() => document.hidden, { polling: 100, timeout: 10000 });
    await waitUntil(() => submits > backgroundShares);
    assert.equal(logins, backgroundLogins, 'tabbing out does not close the pool connection');
    for (const socket of poolSockets) socket.destroy();
    await waitUntil(() => logins > backgroundLogins && submits > backgroundShares + 1);
    assert.equal(await page.evaluate(() => window.cacheBuilds), buildsBefore);
    assert.deepEqual(page.workers(), residentWorkers, 'background reconnect keeps all engine workers');
    await otherTab.close(); await page.bringToFront();
    console.log('PASS: mining and reconnects continue in a background tab without rebuilding the dataset');
    const loginsBefore = logins;
    advertisedNicehash = true;
    for (const socket of poolSockets) socket.destroy();
    await page.waitForFunction(() => document.querySelector('#embedPreview .randomx-embed').shadowRoot.querySelector('.status').textContent.includes('Retrying'), { timeout: 10000 });
    await page.waitForFunction(() => document.querySelector('#embedPreview .randomx-embed').shadowRoot.querySelector('.rate').textContent !== '0 H/s', { timeout: 30000 });
    assert.ok(logins > loginsBefore);
    assert.ok(nicehashSubmits > 0);
    assert.ok(boundaryShare, 'real WASM hashes the shortened batch at the nonce boundary');
    assert.equal(await page.evaluate(() => window.cacheBuilds), buildsBefore, 'no cache/dataset rebuild on reconnect');
    assert.deepEqual(page.workers(), residentWorkers, 'same engine and pthreads remain resident');
    console.log('PASS: reconnect negotiates NiceHash, preserves assigned nonce bytes, and reuses the same workers/dataset');
    advertisedNicehash = false;
    const directLoginsBefore = logins, directSubmitsBefore = submits;
    for (const socket of poolSockets) socket.destroy();
    await page.waitForFunction(() => document.querySelector('#embedPreview .randomx-embed').shadowRoot.querySelector('.status').textContent.includes('Retrying'), { timeout: 10000 });
    await page.waitForFunction(() => document.querySelector('#embedPreview .randomx-embed').shadowRoot.querySelector('.rate').textContent !== '0 H/s', { timeout: 30000 });
    assert.ok(logins > directLoginsBefore); assert.ok(submits > directSubmitsBefore);
    assert.equal(await page.evaluate(() => window.cacheBuilds), buildsBefore);
    assert.deepEqual(page.workers(), residentWorkers);
    console.log('PASS: a later ordinary login clears NiceHash negotiation without rebuilding the dataset');
    await page.click(shadow + '.stop');
    await page.waitForFunction(() => !document.querySelector('#embedPreview .randomx-embed').shadowRoot.querySelector('input[type=checkbox]').checked);
    await page.click('#embedClearPreview');
    await page.evaluate(() => {
      const form = document.getElementById('embedBuilder');
      form.elements.display.value = 'headless'; form.elements.quickstart.checked = true;
      form.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const snippet = await page.$eval('#embedSnippet', el => el.value);
    assert.ok(snippet.includes('randomx:consent-request'));
    assert.ok(!snippet.includes('id="rx-consent"'));
    html = '<!doctype html><html><body><button id="first">Site interaction</button>' + snippet + '</body></html>';
    const exported = await browser.newPage();
    forceNonceBoundary(exported);
    advertisedNicehash = true;
    let exportedEngineRequests = 0;
    exported.on('request', request => { if (/randomx\.(js|wasm)/.test(request.url())) exportedEngineRequests++; });
    exported.on('pageerror', error => errors.push(error.message));
    await exported.goto(`http://localhost:${fixturePort}/test`, { waitUntil: 'networkidle0' });
    assert.equal(exportedEngineRequests, 0);
    assert.equal(await exported.$('div.randomx-embed'), null, 'headless must not append a widget');
    let dialogs = 0;
    exported.on('dialog', async dialog => { dialogs++; assert.match(dialog.message(), /initialization uses 32 threads/); await dialog.accept(); });
    await exported.click('#first');
    await exported.waitForFunction(() => window.randomxMiner.state.hashrate > 0, { timeout: 60000 });
    assert.equal(dialogs, 1);
    assert.ok(exportedEngineRequests > 0);
    await exported.click('#rx-stop');
    assert.equal(await exported.evaluate(() => window.randomxMiner.state.running), false);
    console.log('PASS: exported headless quickstart snippet, custom consent event, custom DOM controls, and cross-origin asset loading');
    await page.evaluate(({ fixturePort }) => {
      const form = document.getElementById('embedBuilder');
      form.elements.display.value = 'widget'; form.elements.quickstart.checked = false;
      form.elements.mode.value = 'light'; form.elements.routeQuery.value = 'false';
      form.elements.nonceMode.value = 'nicehash'; form.elements.keepalive.value = 'required';
      form.elements.wallet.value = 'fixture-donation-wallet';
      form.elements.proxy.value = `ws://localhost:${fixturePort}/fixed?token=fixture`;
      form.dispatchEvent(new Event('input', { bubbles: true }));
    }, { fixturePort });
    const fixedSnippet = await page.$eval('#embedSnippet', el => el.value);
    assert.ok(fixedSnippet.includes('"routeQuery": false'));
    assert.ok(fixedSnippet.includes('"nonceMode": "nicehash"'));
    assert.ok(fixedSnippet.includes('"keepalive": "required"'));
    advertisedNicehash = false; forceFixedNonce = true;
    html = '<!doctype html><html><body>' + fixedSnippet + `<script>window.fixedBuilds=0;
      document.addEventListener('randomx:state',e=>{if(e.detail.status==='Initializing cache...')fixedBuilds++});
      </script></body></html>`;
    const independent = await browser.newPage();
    forceNonceBoundary(independent);
    independent.on('pageerror', error => errors.push(error.message));
    await independent.goto(`http://localhost:${fixturePort}/test`, { waitUntil: 'networkidle0' });
    assert.equal(fixedLogins.length, 0);
    await independent.click(shadow + 'input[type=checkbox]');
    await independent.click(shadow + '.start');
    await independent.waitForFunction(() => window.randomxMiner.state.accepted >= 100 && window.randomxMiner.state.hashrate > 0, { timeout: 120000 });
    assert.equal(fixedLogins[0].login, donationWallet);
    assert.equal(await independent.evaluate(() => randomxMiner.state.rejected), 0);
    await waitUntil(() => fixedKeepalives > 0);
    assert.ok(fixedPongs > 0, 'an independent proxy native WS ping gets the browser pong');
    assert.equal(await independent.evaluate(() => fixedBuilds), 1);
    const independentWorkers = independent.workers();
    // 0.3.0 light mode: one randomx_st worker per mining thread, on an isolated page too.
    assert.deepEqual(await independent.evaluate(() => [crossOriginIsolated, randomxMiner.state.engine.runtime,
      randomxMiner.state.engine.workers, randomxMiner.state.threads]), [true, 'workers', independentWorkers.length, independentWorkers.length]);
    const prefixBefore = await independent.evaluate(() => randomxMiner.state.nicehash);
    assert.equal(prefixBefore, true);
    const peer = [...fixedPeers.values()][0];
    assert.ok(peer.shares >= 100);
    const freshJob = peer.newJob();
    await waitUntil(() => peer.jobShares.get(freshJob) > 0);
    assert.equal(await independent.evaluate(() => fixedBuilds), 1);
    for (const link of fixedBridges) link.ws.close(1012, 'Proxy restart');
    await independent.waitForFunction(() => randomxMiner.state.phase === 'reconnecting', { timeout: 10000 });
    await independent.waitForFunction(() => randomxMiner.state.retries > 0 && randomxMiner.state.hashrate > 0, { timeout: 30000 });
    assert.equal(fixedLogins.length, 2); assert.equal(fixedLogins[1].login, donationWallet);
    assert.deepEqual(fixedURLs, ['/fixed?token=fixture', '/fixed?token=fixture']);
    assert.equal(await independent.evaluate(() => fixedBuilds), 1);
    assert.deepEqual(independent.workers(), independentWorkers);
    await independent.click(shadow + '.stop');
    await independent.close();
    console.log('PASS: independent proxy, forced NiceHash without flags, >=100 real-WASM shares with fixed job prefixes and zero fixture rejections, required keepalive, new jobs and 1012 reconnect with the same workers/cache');
    const loginsBeforeRejection = logins, submitsBeforeRejection = submits;
    html = '<!doctype html><html><body>' + fixedSnippet.replace('"wallet": "fixture-donation-wallet"', '"wallet": "other-wallet"') + '</body></html>';
    const rejected = await browser.newPage();
    rejected.on('pageerror', error => errors.push(error.message));
    await rejected.goto(`http://localhost:${fixturePort}/test`, { waitUntil: 'networkidle0' });
    await rejected.click(shadow + 'input[type=checkbox]'); await rejected.click(shadow + '.start');
    await rejected.waitForFunction(() => randomxMiner.state.error?.code === 'LOGIN_REJECTED', { timeout: 30000 });
    assert.equal(await rejected.evaluate(() => randomxMiner.state.status), 'Donation wallet required');
    assert.equal(await rejected.evaluate(() => randomxMiner.state.running), false);
    const rejectedConnections = fixedURLs.length;
    await rejected.evaluate(() => new Promise(resolve => setTimeout(resolve, 1500)));
    assert.equal(fixedURLs.length, rejectedConnections, 'rejected donation login must not reconnect');
    assert.equal(logins, loginsBeforeRejection); assert.equal(submits, submitsBeforeRejection);
    assert.match(await rejected.$eval(shadow + '.diagnostics', el => el.textContent), /Donation wallet required/);
    await rejected.close();
    forceFixedNonce = false;
    console.log('PASS: wrong donation wallet is displayed as a terminal login error, with no upstream mining or retry');
    // Light mode (0.3.0): a randomx_st worker pool through the reference bridge to the fixture pool.
    // replicas: 0 unless a run asks: Chrome may report enough RAM for 'auto' to add replicas.
    const lightConfig = { wallet: 'fixture-wallet', pool: '127.0.0.1', port: poolPort, proxy: `ws://localhost:${proxyPort}`, mode: 'light', replicas: 0 };
    const sharesOf = {};
    const openLight = async (pathname, options) => {
      html = lightPage({ ...lightConfig, ...options });
      lightTab = await browser.newPage();
      lightTab.on('pageerror', error => errors.push(error.message));
      await lightTab.goto(`http://localhost:${fixturePort}${pathname}`, { waitUntil: 'networkidle0' });
      return lightTab;
    };
    const lightState = tab => tab.evaluate(() => ({ names: rx.names, caches: rx.caches, terminated: rx.terminated, modes: rx.modes,
      shares: rx.shares, statuses: [...rx.statuses], engine: rxMiner.state.engine, running: rxMiner.state.running,
      accepted: rxMiner.state.accepted, rejected: rxMiner.state.rejected, progress: rxMiner.state.progress }));
    const stopLight = async (tab, n) => {
      await tab.click(shadow + '.stop');
      await waitUntil(() => tab.workers().length === 0, 15000);
      const stopped = await lightState(tab);
      assert.equal(stopped.running, false); assert.equal(stopped.terminated, n, 'Stop terminates every engine worker');
      assert.equal(stopped.rejected, 0);
      await tab.close();
      return stopped;
    };
    forceFixedNonce = true;
    let lightServed = served.length;
    const lightPool = poolShares.length, loginsBeforeLight = logins;
    const open = await openLight('/open', { maxThreads: 3, nonceMode: 'nicehash' });
    const openChecks = await open.evaluate(() => ({ isolated: crossOriginIsolated, sab: typeof SharedArrayBuffer,
      full: RandomXEmbed.diagnose(), light: RandomXEmbed.diagnose('light'), error: rxMiner.state.error, engine: rxMiner.state.engine,
      disclosure: document.querySelector('.randomx-embed').shadowRoot.querySelector('.details').textContent,
      rows: (r => ({ engine: r.querySelector('.engine').textContent, ram: r.querySelector('.ram').textContent,
        init: r.querySelector('.init').hidden }))(document.querySelector('.randomx-embed').shadowRoot) }));
    assert.deepEqual(openChecks.rows, { engine: '3 light threads', ram: 'about 0.9 GB', init: true }, 'no dataset row without replicas');
    assert.equal(openChecks.isolated, false); assert.equal(openChecks.sab, 'undefined');
    assert.equal(openChecks.full.supported, false); assert.deepEqual(openChecks.full.modes, { full: false, light: true });
    assert.equal(openChecks.light.supported, true); assert.deepEqual(openChecks.light.issues, []); assert.equal(openChecks.error, null);
    assert.deepEqual([openChecks.engine.mode, openChecks.engine.runtime, openChecks.engine.workers, openChecks.engine.replicas,
      openChecks.engine.memoryMiB], ['light', 'workers', 3, 0, 900]);
    assert.match(openChecks.disclosure, /as 3 light-mode workers at about 300 MB each\. Mining needs about 0\.9 GB of RAM\./);
    assert.doesNotMatch(openChecks.disclosure, /isolation headers/);
    // Full mode on the same page stops at preflight and points at light mode.
    const fullAttempt = await open.evaluate(config => {
      const miner = RandomXEmbed.create({ ...config, mode: 'full', headless: true });
      const { error, running } = miner.state; miner.destroy(); return { error, running };
    }, lightConfig);
    assert.equal(fullAttempt.running, false);
    assert.equal(fullAttempt.error.code, 'DEPLOYMENT_UNSUPPORTED'); assert.equal(fullAttempt.error.stage, 'preflight');
    assert.ok(fullAttempt.error.hints.some(hint => hint.includes('Cross-Origin-Embedder-Policy: require-corp')));
    assert.equal(fullAttempt.error.hints.filter(hint => hint.includes("mode: 'light'")).length, 1);
    console.log("PASS: full mode on a page without COOP/COEP fails at preflight (DEPLOYMENT_UNSUPPORTED) with one mode: 'light' hint");
    await open.click(shadow + '.start');
    assert.equal((await lightState(open)).names.length, 0, 'unchecked consent must block startup');
    assert.deepEqual(served.slice(lightServed).filter(file => engineAsset.test(file)), [], 'no engine download before consent');
    assert.equal(logins, loginsBeforeLight);
    await open.click(shadow + 'input[type=checkbox]'); await open.click(shadow + '.start');
    await open.waitForFunction(() => rxMiner.state.accepted >= 30 && rxMiner.state.hashrate > 0 &&
      new Set(rx.shares.map(share => share.worker)).size === 3, { timeout: 180000, polling: 250 });
    const lightWorkers = open.workers();
    let light = await lightState(open);
    assert.equal(lightWorkers.length, 3);
    assert.deepEqual(light.names, ['rx-st-0', 'rx-st-1', 'rx-st-2']); assert.equal(light.caches, 3);
    assert.equal(lastLogin.agent, agent);
    const lightFiles = new Set(served.slice(lightServed));
    assert.ok(['/randomx_st.js', '/randomx_st.wasm', '/worker.js'].every(file => lightFiles.has(file)));
    assert.ok(!['/randomx.js', '/randomx.wasm', '/embed-worker.js', '/fb_full.js'].some(file => lightFiles.has(file)), 'light mode loads only the randomx_st build');
    assert.ok(light.shares.every(share => nonceSlot(share.nonce, 3, true) === share.worker), 'each worker mines its own nonce slot');
    console.log('PASS: light mode without COOP/COEP: consent-gated, 3 randomx_st workers (no pthread build) mining NiceHash shares in disjoint nonce slots');
    const lightJob = [...fixedPeers.values()].at(-1).newJob();
    await open.waitForFunction(id => new Set(rx.shares.filter(share => share.job_id === id).map(share => share.worker)).size === 3,
      { timeout: 60000, polling: 250 }, lightJob);
    const lightLogins = logins, lightSubmits = submits;
    for (const socket of poolSockets) socket.destroy();
    await open.waitForFunction(() => rxMiner.state.retries > 0 && rxMiner.state.phase === 'mining' && rxMiner.state.hashrate > 0,
      { timeout: 60000, polling: 250 });
    await waitUntil(() => logins > lightLogins && submits > lightSubmits + 30, 60000);
    light = await lightState(open);
    assert.equal(light.caches, 3, 'no cache rebuild on reconnect'); assert.equal(light.names.length, 3); assert.equal(light.terminated, 0);
    assert.deepEqual(open.workers(), lightWorkers, 'reconnect keeps the same engine workers');
    const lightKeys = poolShares.slice(lightPool).map(share => share.blob + share.nonce);
    assert.equal(new Set(lightKeys).size, lightKeys.length, 'no submitted nonce repeats across the workers');
    sharesOf.open = (await stopLight(open, 3)).shares;
    console.log('PASS: light-mode new jobs reach every worker; a pool reconnect keeps the same 3 workers and caches; no repeated nonce; Stop terminates all workers');
    lightServed = served.length;
    const isolatedLight = await openLight('/test', { maxThreads: 2, nonceMode: 'nicehash' });
    assert.deepEqual(await isolatedLight.evaluate(() => [crossOriginIsolated, typeof SharedArrayBuffer,
      rxMiner.state.engine.runtime, rxMiner.state.engine.workers]), [true, 'function', 'workers', 2]);
    await isolatedLight.click(shadow + 'input[type=checkbox]'); await isolatedLight.click(shadow + '.start');
    await isolatedLight.waitForFunction(() => rxMiner.state.accepted >= 20 && rxMiner.state.hashrate > 0 &&
      new Set(rx.shares.map(share => share.worker)).size === 2, { timeout: 180000, polling: 250 });
    light = await lightState(isolatedLight);
    assert.equal(isolatedLight.workers().length, 2); assert.equal(light.caches, 2);
    assert.ok(light.shares.every(share => nonceSlot(share.nonce, 2, true) === share.worker));
    assert.ok(!served.slice(lightServed).some(file => ['/randomx.js', '/embed-worker.js'].includes(file)), 'no pthread build when isolated');
    sharesOf.isolated = (await stopLight(isolatedLight, 2)).shares;
    forceFixedNonce = false;
    console.log('PASS: light mode on a crossOriginIsolated page runs the same randomx_st pool (2 workers, no pthreads) with accepted NiceHash shares');
    lightServed = served.length;
    const replica = await openLight('/open', { maxThreads: 3, replicas: 1, memoryCap: 8 });
    const replicaPlan = await replica.evaluate(() => ({ engine: rxMiner.state.engine, deviceMemory: navigator.deviceMemory,
      disclosure: document.querySelector('.randomx-embed').shadowRoot.querySelector('.details').textContent }));
    assert.deepEqual([replicaPlan.engine.workers, replicaPlan.engine.replicas, replicaPlan.engine.memoryMiB], [3, 1, 3200],
      'a replica is planned (navigator.deviceMemory ' + replicaPlan.deviceMemory + ')');
    assert.match(replicaPlan.disclosure, /1 of them also holds a private full dataset .*which the workers build before mining starts.*Mining needs about 3\.2 GB of RAM/);
    await replica.click(shadow + 'input[type=checkbox]'); await replica.click(shadow + '.start');
    // All three workers build worker 0's private 2 GiB dataset: generous on a loaded host.
    await replica.waitForFunction(() => rxMiner.state.engine.replicasActive === 1, { timeout: 600000, polling: 1000 });
    const replicaAccepted = (await lightState(replica)).accepted;
    await replica.waitForFunction(accepted => rxMiner.state.accepted >= accepted + 20 && rxMiner.state.hashrate > 0 &&
      rx.shares.filter(share => share.worker === 0 && share.full).length >= 5 && new Set(rx.shares.map(share => share.worker)).size === 3,
      { timeout: 180000, polling: 250 }, replicaAccepted);
    light = await lightState(replica);
    assert.equal(await replica.evaluate(() => typeof RxFbFull.FbCoordinator), 'function');
    assert.ok(served.slice(lightServed).includes('/fb_full.js'));
    assert.deepEqual(light.modes.filter(report => report.mode === 'full').map(report => report.worker), [0], 'worker 0 alone mines on a replica');
    assert.ok(light.statuses.includes('Full dataset ready: 1 of 1 mining in full mode'));
    assert.ok([...light.statuses].some(status => /^Building the full dataset: \d+% \(3 workers\)$/.test(status)));
    assert.equal(light.progress, 1); assert.equal(light.caches, 3);
    const built = await replica.evaluate(() => ({ names: rx.names, early: rx.early }));
    assert.deepEqual(built.names, ['rx-st-0', 'rx-st-1', 'rx-st-2'], 'the workers build the dataset themselves');
    assert.equal(built.early, 0, 'no worker hashed before the full dataset was built');
    const rows = await replica.evaluate(() => { const r = document.querySelector('.randomx-embed').shadowRoot;
      return { engine: r.querySelector('.engine').textContent, ram: r.querySelector('.ram').textContent,
        init: r.querySelector('.init').hidden, label: r.querySelector('.init span').textContent, pct: r.querySelector('.pct').textContent }; });
    assert.deepEqual(rows, { engine: '1 full-dataset + 2 light threads', ram: 'about 3.2 GB', init: false, label: 'Dataset init', pct: '100%' });
    assert.ok(light.shares.every(share => nonceSlot(share.nonce, 3, false) === share.worker));
    sharesOf.replica = (await stopLight(replica, 3)).shares;
    console.log('PASS: light mode with replicas: 1 loads fb_full.js, builds worker 0\'s full dataset on the 3 workers before any mining, then mines with accepted shares');
    // Isolation failures are full-mode preflight errors (light mode needs no
    // isolation headers); the CSP cases run in both modes.
    const policyCases = [['isolation', 'full'], ['permission', 'full'],
      ...['worker', 'assets', 'wasm'].flatMap(policyCase => [[policyCase, 'full'], [policyCase, 'light']])];
    for (const [policyCase, mode] of policyCases) {
      const diagnosticPage = await browser.newPage();
      const servedBeforePolicy = served.length;
      const engineServed = () => served.slice(servedBeforePolicy).filter(file => engineAsset.test(file)).length;
      const loginsBeforePolicy = logins;
      await diagnosticPage.goto(`http://localhost:${fixturePort}/policy?case=${policyCase}&mode=${mode}`, { waitUntil: 'networkidle0' });
      if (['isolation', 'permission'].includes(policyCase)) {
        assert.equal(engineServed(), 0, 'preflight diagnostics must not load an engine');
      } else {
        assert.equal(engineServed(), 0, 'policy diagnostics preserve consent');
        await diagnosticPage.click(shadow + 'input[type=checkbox]');
        await diagnosticPage.click(shadow + '.start');
      }
      await diagnosticPage.waitForFunction(() => window.policyMiner.state.phase === 'error', { timeout: 10000 });
      const diagnostic = await diagnosticPage.evaluate(() => {
        const details = document.querySelector('.randomx-embed').shadowRoot.querySelector('.diagnostics');
        return { error: policyMiner.state.error, visible: !details.hidden, text: details.textContent,
          running: policyMiner.state.running, events: policyErrors.length };
      });
      assert.equal(diagnostic.visible, true); assert.equal(diagnostic.running, false);
      assert.ok(diagnostic.events > 0); assert.equal(logins, loginsBeforePolicy);
      if (['isolation', 'permission'].includes(policyCase)) {
        assert.equal(diagnostic.error.code, 'DEPLOYMENT_UNSUPPORTED');
        assert.match(diagnostic.text, policyCase === 'isolation' ? /Cross-Origin-Embedder-Policy/ : /Permissions Policy/);
        assert.equal(diagnostic.text.split("Or set mode: 'light'").length, 2, 'one light-mode hint');
        assert.equal(engineServed(), 0);
      } else if (policyCase === 'wasm') {
        assert.match(diagnostic.text, /wasm-unsafe-eval/);
        assert.ok(['CSP_BLOCKED', 'ENGINE_WORKER_FAILED'].includes(diagnostic.error.code));
      } else {
        // The confirmed document violation may arrive just after the generic
        // fetch/constructor error; the embed enriches the same failed attempt.
        await diagnosticPage.waitForFunction(() => window.policyMiner.state.error.code === 'CSP_BLOCKED', { timeout: 5000 });
        assert.equal(await diagnosticPage.evaluate(() => policyMiner.state.error.directive), policyCase === 'worker' ? 'worker-src' : 'connect-src');
      }
      await diagnosticPage.evaluate(() => policyMiner.destroy());
      await diagnosticPage.close();
      console.log(`PASS: actionable ${policyCase} deployment diagnostics (${mode} mode) in the widget and error events`);
    }
    // Two submitted shares per light worker without isolation, one per isolated
    // worker, five that worker 0 mined on its replica dataset and one per other
    // replica-page worker; a corrupted nonce proves the check can fail.
    const submitted = new Map(poolShares.map(share => [share.nonce + share.result, share]));
    const sample = (shares, keep, k) => shares.filter(share => keep(share) && submitted.has(share.nonce + share.result))
      .sort(() => Math.random() - 0.5).slice(0, k).map(share => submitted.get(share.nonce + share.result));
    const samples = [...[0, 1, 2].flatMap(w => sample(sharesOf.open, share => share.worker === w, 2)),
      ...[0, 1].flatMap(w => sample(sharesOf.isolated, share => share.worker === w, 1)),
      ...sample(sharesOf.replica, share => share.worker === 0 && share.full, 5),
      ...[1, 2].flatMap(w => sample(sharesOf.replica, share => share.worker === w, 1))];
    assert.equal(samples.length, 15, 'every sampled worker submitted shares');
    const corrupt = { ...samples[0], nonce: (samples[0].nonce[0] === '0' ? '1' : '0') + samples[0].nonce.slice(1) };
    assert.deepEqual(await rehash([...samples, corrupt]), [corrupt], 'submitted shares re-hash to their results');
    console.log(`PASS: ${samples.length} submitted light-mode shares, 5 from the replica's full dataset, re-hash in Node to their results`);
    assert.deepEqual(errors, [], 'browser/proxy errors');
    console.log('All browser integration checks passed');
  } catch (error) {
    if (page && !page.isClosed()) console.error('Last browser states:', await page.evaluate(() => window.rxStates));
    if (lightTab && !lightTab.isClosed()) console.error('Light page:', await lightTab.evaluate(() => ({ statuses: [...rx.statuses].slice(-20),
      state: rxMiner.state, names: rx.names, caches: rx.caches, modes: rx.modes, shares: rx.shares.length })).catch(e => e.message));
    throw error;
  } finally {
    if (browser) await browser.close();
    if (proxy) proxy.kill('SIGTERM');
    for (const { ws, upstream } of fixedBridges) { ws.terminate(); upstream.destroy(); }
    fixedWS.close();
    for (const socket of poolSockets) socket.destroy();
    pool.close(); fixture.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); if (errors.length) console.error(errors); process.exitCode = 1; });
