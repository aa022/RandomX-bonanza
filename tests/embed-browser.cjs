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
let logins = 0, submits = 0, html = '', browser, proxy, page;
let advertisedNicehash = false, nextPrefix = 0x80, nicehashSubmits = 0, boundaryShare = false;
const errors = [];
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'randomx-browser-'));
const listen = (server, port) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
const pool = net.createServer(socket => {
  poolSockets.add(socket); socket.on('close', () => poolSockets.delete(socket));
  let buffer = '';
  let nicehash = false, prefix = 0;
  const seenNonces = new Set();
  const assignedJobs = new Map();
  const peer = { shares: 0, jobShares: new Map() };
  const makeJob = id => {
    assignedJobs.set(id, prefix);
    return { ...job, job_id: id, algo: 'rx/0', height: 123,
      blob: nicehash ? job.blob.slice(0, 84) + prefix.toString(16).padStart(2, '0') + job.blob.slice(86) : job.blob };
  };
  peer.newJob = () => {
    prefix = nextPrefix++ % 256;
    const nextJob = makeJob('fixture-job-' + prefix);
    socket.write(JSON.stringify({ method: 'job', params: nextJob }) + '\n');
    return nextJob.job_id;
  };
  socket.on('close', () => fixedPeers.delete(socket));
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
        logins++; socket.write(JSON.stringify({ id: message.id, result: {
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
  const policyCase = url.pathname === '/policy' ? url.searchParams.get('case') : null;
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (policyCase !== 'isolation') res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
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
        proxy:'ws://localhost:${proxyPort}',mode:'light',workload:50});`); return;
  }
  if (url.pathname === '/test') { res.setHeader('Content-Type', 'text/html'); res.end(html); return; }
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
    proxy = spawn(process.execPath, ['-e', `const c=require('./config');c.WS_PORT=${proxyPort};c.STRATUM_TCP_PORT=17884;require('./proxy/index')`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
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
    for (const policyCase of ['isolation', 'permission', 'worker', 'assets', 'wasm']) {
      const diagnosticPage = await browser.newPage();
      let policyEngineRequests = 0;
      diagnosticPage.on('request', request => { if (/randomx\.(js|wasm)/.test(request.url())) policyEngineRequests++; });
      const loginsBeforePolicy = logins;
      await diagnosticPage.goto(`http://localhost:${fixturePort}/policy?case=${policyCase}`, { waitUntil: 'networkidle0' });
      if (['isolation', 'permission'].includes(policyCase)) {
        assert.equal(policyEngineRequests, 0, 'preflight diagnostics must not load an engine');
      } else {
        assert.equal(policyEngineRequests, 0, 'policy diagnostics preserve consent');
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
      console.log(`PASS: actionable ${policyCase} deployment diagnostics in the widget and error events`);
    }
    assert.deepEqual(errors, [], 'browser/proxy errors');
    console.log('All browser integration checks passed');
  } catch (error) {
    if (page && !page.isClosed()) console.error('Last browser states:', await page.evaluate(() => window.rxStates));
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
