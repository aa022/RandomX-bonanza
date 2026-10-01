const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

// A deterministic browser boundary: these tests cover consent tickets,
// asynchronous cancellation, reconnect timers and thread lifetime. The
// companion browser test exercises the real DOM and WASM runtime.
class Target {
  constructor() { this.handlers = new Map(); }
  addEventListener(name, fn) { if (!this.handlers.has(name)) this.handlers.set(name, new Set()); this.handlers.get(name).add(fn); }
  removeEventListener(name, fn) { this.handlers.get(name)?.delete(fn); }
  dispatchEvent(event) { for (const fn of [...this.handlers.get(event.type) || []]) fn(event); return true; }
}
// fb_full.js as the page's <script> defines it (window.RxFbFull).
const fbSource = readFileSync(require.resolve('../public/fb_full.js'), 'utf8');
function harness(options = {}) {
  const win = new Target();
  const doc = new Target();
  doc.currentScript = options.script || null; doc.readyState = 'complete'; doc.hidden = false;
  const sockets = [], workers = [], downloads = [], timers = new Map(), revoked = [], reports = [], scripts = [], ready = [];
  const blobs = new Map();
  doc.permissionsPolicy = options.permissionsPolicy;
  // Script elements (fb_full.js) load, or fail with options.scriptError, a microtask after insertion.
  doc.createElement = tagName => ({ tagName, remove() { this.removed = true; } });
  doc.head = { appendChild(element) {
    scripts.push(element);
    queueMicrotask(() => {
      if (options.scriptError) { element.onerror(); return; }
      const sandbox = {}; vm.runInNewContext(fbSource, sandbox); win.RxFbFull = sandbox.RxFbFull; element.onload();
    });
  } };
  win.addEventListener('randomx:ready', event => ready.push(event.detail.instance));
  let timerId = 0, blobId = 0;
  class Socket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(text) { this.sent.push(JSON.parse(text)); }
    close(code = 1000, reason = '') { this.closeCode = code; this.closeReason = reason; this.readyState = 3; this.onclose?.({ code, reason }); }
    open() { this.readyState = 1; this.onopen?.(); }
    message(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  class Worker {
    constructor(url, init) {
      if (options.workerError) throw new Error(options.workerError);
      this.url = url; this.options = init; this.sent = []; this.terminated = false; workers.push(this);
    }
    postMessage(msg) { this.sent.push(msg); }
    terminate() { this.terminated = true; }
    message(msg) { this.onmessage?.({ data: msg }); }
  }
  class BrowserURL extends URL {
    static createObjectURL(blob) { const url = 'blob:http://localhost/' + ++blobId; blobs.set(url, blob); return url; }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  win.Worker = options.workers === false ? undefined : Worker; win.WebAssembly = WebAssembly;
  win.isSecureContext = options.secure !== false; win.crossOriginIsolated = options.isolated !== false;
  win.top = options.embedded ? {} : win;
  const context = { window: win, document: doc, navigator: options.navigator || { hardwareConcurrency: 12, userAgent: 'Chrome/130', platform: 'Linux x86_64' },
    location: { href: 'http://localhost/', host: 'localhost', protocol: 'http:' },
    URL: BrowserURL, Blob, AbortController, SharedArrayBuffer: options.sharedMemory === false ? undefined : SharedArrayBuffer,
    WebAssembly, WebSocket: Socket, Worker,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    console: { error: (...args) => reports.push(args) },
    fetch: async (url, init) => { downloads.push({ url: String(url), init }); return options.fetch ? options.fetch(init) : { ok: true, text: async () => 'runtime' }; },
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    setInterval: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay, repeat: true }); return id; },
    clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id),
    Date: options.Date || Date };
  vm.runInNewContext(readFileSync(require.resolve('../public/embed.js'), 'utf8'), context);
  const config = { wallet: 'test-wallet', pool: 'pool.example', port: 3333, workload: 50, headless: true };
  return { win, doc, sockets, workers, downloads, timers, revoked, reports, scripts, blobs, ready,
    create: (extra = {}) => win.RandomXEmbed.create({ ...config, ...extra }),
    runTimer(delay) { const pair = [...timers].find(([, t]) => t.delay === delay); assert.ok(pair, 'expected timer ' + delay); if (!pair[1].repeat) timers.delete(pair[0]); pair[1].fn(); } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
async function approve(h, extra) {
  const api = h.create(extra);
  let consent;
  api.on('consent-request', detail => { consent = detail; });
  api.requestConsent(); assert.ok(consent); consent.accept(); await flush();
  return { api, consent, root: h.workers[0] };
}
const job = { job_id: 'job', blob: '00'.repeat(76), seed_hash: '00'.repeat(32), target: 'ffffffff' };

test('no engine, network or CPU work occurs before consent; accept is single-use', async () => {
  const h = harness(); const api = h.create();
  assert.equal(h.downloads.length, 0); assert.equal(h.workers.length, 0); assert.equal(h.sockets.length, 0);
  let consent; api.on('consent-request', detail => { consent = detail; });
  api.requestConsent(); assert.equal(h.downloads.length, 0);
  assert.match(consent.disclosure, /initialization uses 32 threads/);
  assert.match(consent.disclosure, /test-wallet/);
  assert.equal(consent.accept(), true); assert.equal(consent.accept(), false); await flush();
  assert.equal(h.workers[0].sent[0].datasetInitThreads, 32);
  assert.equal(h.workers[0].sent[0].datasetThreads, 6);
  api.destroy();
});
test('50% default, global 80% cap, and ARM half-core cap', () => {
  const h = harness();
  for (const cores of [1, 2, 3, 8, 10, 128]) {
    for (const workload of [0, 1, 25, 49.9, 50, 75, 80, 100]) {
      const local = harness({ navigator: { hardwareConcurrency: cores, userAgent: 'Chrome/130', platform: 'Linux' } });
      const api = local.create({ workload });
      assert.ok(api.state.threads <= Math.floor(cores * 0.8)); assert.ok(api.state.threads <= 32);
      assert.equal(api.state.workload, Math.min(80, workload)); api.destroy();
    }
  }
  const safari = { hardwareConcurrency: 10, userAgent: 'Version/18 Safari/605', platform: 'MacIntel' };
  assert.equal(h.win.RandomXEmbed.limits({}, safari).maxThreads, 5);
  assert.equal(h.win.RandomXEmbed.limits({}, { ...safari, userAgent: 'Chrome/130', platform: 'Linux aarch64' }).maxThreads, 5);
  for (const nav of [safari, { ...safari, userAgent: 'Chrome/130', platform: 'Linux aarch64' },
    { ...safari, userAgent: 'Chrome/130', platform: 'Linux x86_64' }]) {
    const api = harness({ navigator: nav }).create({ workload: undefined });
    assert.equal(api.state.workload, 50); assert.equal(api.state.threads, 5); api.destroy();
  }
  for (const nav of [safari, { ...safari, architecture: 'arm', platform: 'Win32' }]) {
    const api = harness({ navigator: nav }).create({ workload: 100 });
    assert.equal(api.state.threads, 5); assert.equal(api.state.workload, 50); api.destroy();
  }
  assert.equal(h.win.RandomXEmbed.limits({ mode: 'light' }, safari).maxThreads, 5, 'light mode has no one-thread cap');
  assert.equal(h.win.RandomXEmbed.limits({ maxThreads: 2 }, safari).maxThreads, 2);
  assert.equal(h.win.RandomXEmbed.limits({ maxThreads: 32 }, safari).maxThreads, 5, 'maxThreads is a ceiling only');
  assert.throws(() => h.win.RandomXEmbed.limits({ maxThreads: 0 }, safari), /maxThreads/);
  for (const workload of [NaN, Infinity, -1, 101]) assert.throws(() => h.create({ workload }));
});
test('Chromium ARM architecture is resolved before mining starts', async () => {
  const nav = { hardwareConcurrency: 12, userAgent: 'Chrome/130', platform: 'Win32',
    userAgentData: { getHighEntropyValues: async () => ({ architecture: 'arm' }) } };
  const h = harness({ navigator: nav }); const { api, root } = await approve(h, { workload: 80 });
  assert.equal(api.state.workload, 50); assert.equal(root.sent[0].datasetThreads, 6);
  assert.equal(root.sent[0].datasetInitThreads, 32); api.destroy();
});
test('Intel Macs can use 80%, and late architecture discovery never increases approved workload', async () => {
  const nav = { hardwareConcurrency: 10, userAgent: 'Chrome/130', platform: 'MacIntel',
    userAgentData: { getHighEntropyValues: async () => ({ architecture: 'x86' }) } };
  const h = harness({ navigator: nav }); const api = h.create({ workload: 80 });
  await flush(); assert.equal(api.state.workload, 80); assert.equal(api.state.threads, 8); api.destroy();
  const early = harness({ navigator: nav }); const approved = await approve(early, { workload: 80 });
  assert.equal(approved.api.state.workload, 50); assert.equal(approved.root.sent[0].datasetThreads, 5);
  approved.api.destroy();
});
test('plan() and create() agree once the Chromium architecture hint resolves', async () => {
  const intelMac = { hardwareConcurrency: 10, userAgent: 'Chrome/130', platform: 'MacIntel',
    userAgentData: { getHighEntropyValues: async () => ({ architecture: 'x86' }) } };
  const h = harness({ isolated: false, navigator: intelMac });
  const input = { wallet: 'test-wallet', pool: 'pool.example', mode: 'light', workload: 80 };
  assert.equal(h.win.RandomXEmbed.plan(input).workers, 5, 'before the hint: the platform guess (Mac is ARM, 50%)');
  await flush();
  const p = h.win.RandomXEmbed.plan(input);
  assert.equal(p.workers, 8); assert.equal(p.memoryMiB, 2400); assert.equal(p.limits.workloadCap, 80);
  assert.equal(h.win.RandomXEmbed.plan(input, { hardwareConcurrency: 10, platform: 'MacIntel' }).workers, 5, 'an explicit nav ignores the hint');
  const api = h.create(input);
  assert.deepEqual({ ...api.state.engine }, { mode: 'light', runtime: 'workers', workers: 8, replicas: 0, replicasActive: 0, memoryMiB: 2400 });
  let consent; api.on('consent-request', detail => { consent = detail; }); api.requestConsent();
  assert.equal(consent.disclosure, p.disclosure);
  consent.accept(); await flush(); assert.equal(h.workers.length, 8);
  api.destroy();
});
test('quickstart emits exactly one request on first trusted interaction with no built-in DOM', async () => {
  const h = harness(); const api = h.create({ quickstart: true });
  const requests = []; api.on('consent-request', detail => requests.push(detail));
  h.doc.dispatchEvent({ type: 'click', isTrusted: false }); assert.equal(requests.length, 0);
  h.doc.dispatchEvent({ type: 'keydown', key: 'Tab', isTrusted: true }); assert.equal(requests.length, 0);
  h.doc.dispatchEvent({ type: 'click', isTrusted: true });
  h.doc.dispatchEvent({ type: 'click', isTrusted: true });
  assert.equal(requests.length, 1); assert.equal(h.downloads.length, 0);
  requests[0].decline(); assert.equal(requests[0].accept(), false); assert.equal(h.workers.length, 0);
  api.destroy();
});
test('Stop cancels pending downloads and kills every page-owned thread', async () => {
  const h = harness(); const { api, root } = await approve(h);
  root.message({ type: 'rx:thread-create', id: 1, url: h.workers[0].url.replace('/2', '/1'), options: { name: 'em-pthread' } });
  assert.equal(h.workers.length, 2);
  api.stop(); assert.ok(h.workers.every(w => w.terminated)); assert.equal(h.revoked.length, 2);
  root.message({ type: 'ready' }); assert.equal(h.sockets.length, 0);
  let resolve;
  const pending = harness({ fetch: () => new Promise(r => { resolve = r; }) });
  const p = await approve(pending); p.api.stop();
  assert.equal(pending.downloads[0].init.signal.aborted, true);
  resolve({ ok: true, text: async () => 'runtime' }); await flush();
  assert.equal(pending.workers.length, 0);
});
test('disconnects retry indefinitely with capped backoff, but Stop cancels retries', async () => {
  const h = harness(); const { api, root } = await approve(h);
  root.message({ type: 'ready' });
  const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
  for (const delay of delays) { h.sockets.at(-1).close(); assert.equal(api.state.phase, 'reconnecting'); h.runTimer(delay); }
  assert.equal(h.sockets.length, delays.length + 1);
  h.sockets.at(-1).close(); api.stop();
  assert.equal(h.timers.size, 0); assert.equal(api.state.running, false);
});
test('successful re-login resets backoff and shares for stale jobs are discarded', async () => {
  const h = harness(); const { api, root } = await approve(h); root.message({ type: 'ready' });
  let ws = h.sockets[0]; ws.open();
  assert.deepEqual(ws.sent.map(x => x.method), ['login']);
  assert.equal(ws.sent[0].jsonrpc, '2.0');
  assert.equal(ws.sent[0].params.login, 'test-wallet');
  assert.equal(ws.sent[0].params.pass, 'embed');
  assert.equal(new URL(ws.url).searchParams.get('pool'), 'pool.example');
  assert.equal(new URL(ws.url).searchParams.get('port'), '3333');
  ws.message({ id: 1, result: { id: 'miner-id', job } });
  const first = root.sent.at(-1);
  ws.close(); assert.equal(root.sent.at(-1).type, 'stop'); h.runTimer(1000);
  ws = h.sockets.at(-1); ws.open(); ws.message({ id: 1, result: { id: 'new-id', job } });
  const next = root.sent.at(-1); assert.ok(next.job_seq > first.job_seq);
  root.message({ type: 'share', job_id: job.job_id, job_seq: first.job_seq }); assert.equal(ws.sent.length, 1);
  root.message({ type: 'share', job_id: job.job_id, job_seq: next.job_seq, nonce: '00000000', result: '00'.repeat(32) });
  assert.equal(ws.sent.at(-1).method, 'submit'); assert.equal(ws.sent.at(-1).id, 2);
  assert.equal(ws.sent.at(-1).params.id, 'new-id');
  assert.equal(h.workers.length, 1, 'reconnection reuses the same engine');
  assert.equal(root.sent.filter(msg => msg.type === 'init').length, 1);
  ws.message({ id: ws.sent.at(-1).id, result: { status: 'OK' } }); assert.equal(api.state.accepted, 1);
  root.message({ type: 'share', job_id: job.job_id, job_seq: next.job_seq, nonce: '01000000', result: '00'.repeat(32) });
  assert.equal(ws.sent.at(-1).id, 3, 'share request IDs increase');
  ws.close(); h.runTimer(1000); api.destroy();
});
test('nicehash is negotiated automatically per connection and applied to every job', async () => {
  const h = harness(); const { api, root } = await approve(h); root.message({ type: 'ready' });
  let ws = h.sockets[0]; ws.open();
  ws.message({ id: 1, result: { id: 'miner', job, extensions: ['nicehash', 'keepalive'] } });
  assert.equal(api.state.nicehash, true);
  assert.equal(root.sent.at(-1).nicehash, true, 'zero prefixes still require extension detection');
  ws.message({ method: 'job', params: { ...job, job_id: 'next' } });
  const next = root.sent.at(-1);
  assert.equal(next.nicehash, true);
  root.message({ type: 'nonce_exhausted', job_id: next.job_id, job_seq: next.job_seq - 1 });
  assert.notEqual(api.state.phase, 'waiting', 'stale exhaustion cannot pause a newer job');
  root.message({ type: 'nonce_exhausted', job_id: next.job_id, job_seq: next.job_seq });
  assert.equal(api.state.phase, 'waiting'); assert.equal(api.state.running, true);
  ws.message({ method: 'job', params: { ...job, job_id: 'fresh' } });
  assert.notEqual(api.state.phase, 'waiting');
  ws.close(); assert.equal(api.state.nicehash, false); h.runTimer(1000); ws = h.sockets.at(-1); ws.open();
  ws.message({ id: 1, result: { id: 'direct', job, extensions: ['keepalive'] } });
  assert.equal(root.sent.at(-1).nicehash, false, 'a later direct-pool login clears negotiation');
  assert.equal(api.state.nicehash, false);
  assert.equal(h.workers.length, 1); api.destroy();
});
test('VPS contract preserves route/query and the exact configured wallet/login payload', async () => {
  const h = harness();
  const { api, root } = await approve(h, { wallet: 'own-wallet', pool: 'selected.example', port: 4444,
    workerName: 'own-worker', proxy: 'ws://localhost/ws?token=route-key&pool=old.example&port=1' });
  root.message({ type: 'ready' }); const ws = h.sockets[0]; ws.open();
  const url = new URL(ws.url);
  assert.equal(url.pathname, '/ws'); assert.equal(url.searchParams.get('token'), 'route-key');
  assert.equal(url.searchParams.get('pool'), 'selected.example'); assert.equal(url.searchParams.get('port'), '4444');
  assert.equal(url.searchParams.has('wallet'), false);
  assert.deepEqual(ws.sent, [{ id: 1, jsonrpc: '2.0', method: 'login', params: {
    login: 'own-wallet', pass: 'own-worker', rigid: 'own-worker', agent: 'randomx-embed/0.3.0', algo: ['rx/0'] } }]);
  assert.equal(h.win.RandomXEmbed.version, '0.3.0'); assert.equal(api.version, '0.3.0');
  assert.throws(() => h.create({ wallet: '' }), /wallet/);
  assert.equal(ws.sent.some(message => ['set_target', 'ping'].includes(message.method)), false);
  api.destroy();
});
test('consolidated browsers keep nonce assignments, request IDs and replies scoped to their own connection', async () => {
  const a = harness(), b = harness();
  const first = await approve(a, { wallet: 'shared-wallet' }), second = await approve(b, { wallet: 'shared-wallet' });
  const assignedJob = prefix => ({ ...job, blob: job.blob.slice(0, 84) + prefix + job.blob.slice(86) });
  for (const [h, instance, prefix] of [[a, first, '00'], [b, second, 'ff']]) {
    instance.root.message({ type: 'ready' }); const ws = h.sockets[0]; ws.open();
    // Even identical upstream session/job IDs are opaque and connection-local.
    ws.message({ id: 1, result: { id: 'consolidated-upstream', job: assignedJob(prefix), extensions: ['nicehash', 'keepalive'] } });
    const work = instance.root.sent.at(-1);
    assert.equal(work.nicehash, true); assert.equal(work.blob.slice(84, 86), prefix);
    instance.root.message({ type: 'share', job_id: work.job_id, job_seq: work.job_seq,
      nonce: '000000' + prefix, result: '00'.repeat(32) });
    assert.equal(ws.sent.at(-1).id, 2); assert.equal(ws.sent.at(-1).params.id, 'consolidated-upstream');
    h.runTimer(15000); assert.equal(ws.sent.at(-1).id, 3); assert.equal(ws.sent.at(-1).method, 'keepalived');
  }
  a.sockets[0].message({ id: 2, error: { code: -1, message: 'Low difficulty share' } });
  b.sockets[0].message({ id: 3, result: { status: 'KEEPALIVED' } });
  b.sockets[0].message({ id: 2, error: null, result: { status: 'OK' } });
  assert.equal(first.api.state.rejected, 1); assert.equal(first.api.state.accepted, 0);
  assert.equal(second.api.state.accepted, 1); assert.equal(second.api.state.rejected, 0);
  a.sockets[0].close(); a.runTimer(1000); a.sockets[1].open();
  a.sockets[1].message({ id: 1, result: { id: 'new-browser-token', job: assignedJob('80'), extensions: ['nicehash'] } });
  assert.equal(a.sockets[1].sent[0].params.login, 'shared-wallet');
  assert.equal(first.root.sent.at(-1).blob.slice(84, 86), '80');
  assert.equal(a.workers.length, 1); assert.equal(b.workers.length, 1);
  assert.equal(b.sockets.length, 1); assert.equal(second.api.state.running, true);
  first.api.destroy(); second.api.destroy();
});
test('fixed-route WSS proxies receive the exact configured URL and standard login on every reconnect', async () => {
  const h = harness(); const proxy = 'wss://independent.example/miner?auth=route-token&pool=fixed';
  const { api, root } = await approve(h, { wallet: 'external-wallet', proxy, routeQuery: false });
  root.message({ type: 'ready' });
  for (let i = 0; i < 2; i++) {
    const ws = h.sockets[i]; assert.equal(ws.url, proxy); ws.open();
    assert.equal(ws.sent[0].params.login, 'external-wallet');
    assert.equal(ws.sent[0].method, 'login'); assert.equal(ws.sent[0].id, 1);
    ws.message({ id: 1, result: { id: 'independent-token', job } });
    if (i === 0) { ws.close(); h.runTimer(1000); }
  }
  assert.equal(api.config.routeQuery, false); assert.equal(h.workers.length, 1);
  assert.throws(() => h.create({ routeQuery: 'false' }), /boolean/);
  api.destroy();
});
test('invalid login IDs and malformed jobs reconnect with increasing backoff instead of starting unusable work', async () => {
  for (const id of [undefined, null, '', {}, []]) {
    const h = harness(); const { api, root } = await approve(h); root.message({ type: 'ready' });
    const ws = h.sockets[0]; ws.open(); ws.message({ id: 1, result: { id, job } });
    assert.equal(api.state.phase, 'reconnecting');
    assert.equal(root.sent.some(message => message.type === 'job'), false);
    h.runTimer(1000); h.sockets[1].open();
    h.sockets[1].message({ id: 1, result: { id: 'token', job: { ...job, target: ['ffffffff'] } } });
    assert.equal(api.state.phase, 'reconnecting');
    h.runTimer(2000); h.sockets[2].open();
    h.sockets[2].message({ id: 1, result: { id: 'token' } });
    h.runTimer(4000); api.destroy();
  }
});
test('session tokens are opaque, including numeric zero; array WS envelopes are rejected', async () => {
  const h = harness(); const { api, root } = await approve(h); root.message({ type: 'ready' });
  const ws = h.sockets[0]; ws.open(); ws.message({ id: 1, result: { id: 0, job, extensions: ['keepalive'] } });
  const work = root.sent.at(-1);
  root.message({ type: 'share', job_id: work.job_id, job_seq: work.job_seq, nonce: '00000000', result: '00'.repeat(32) });
  assert.equal(ws.sent.at(-1).params.id, 0);
  h.runTimer(15000); assert.equal(ws.sent.at(-1).params.id, 0);
  ws.message({ method: 'job', params: { ...job, job_id: 'next' } });
  assert.equal(root.sent.at(-1).job_id, 'next');
  ws.message([{ id: 2, result: { status: 'OK' } }]);
  assert.equal(api.state.phase, 'reconnecting'); assert.equal(api.state.accepted, 0);
  api.destroy();
});
test('jobs must contain the entire four-byte nonce before reaching the worker', async () => {
  for (const bytes of [40, 41, 42]) {
    const h = harness(); const { api, root } = await approve(h); root.message({ type: 'ready' });
    const ws = h.sockets[0]; ws.open();
    ws.message({ id: 1, result: { id: 'miner', job: { ...job, blob: '00'.repeat(bytes) }, extensions: ['nicehash'] } });
    assert.equal(api.state.phase, 'reconnecting');
    assert.equal(root.sent.some(msg => msg.type === 'job'), false);
    api.destroy();
  }
});
test('login timeout, heartbeat timeout, and online recovery all initiate reconnects', async () => {
  let now = 0;
  const h = harness({ Date: { now: () => now } }); const { api, root } = await approve(h);
  root.message({ type: 'ready' }); h.runTimer(15000); assert.equal(api.state.phase, 'reconnecting');
  h.runTimer(1000); let ws = h.sockets.at(-1); ws.open(); ws.message({ id: 1, result: { id: 'miner', job, extensions: ['keepalive'] } });
  h.runTimer(15000);
  assert.equal(ws.sent.at(-1).method, 'keepalived');
  assert.equal(ws.sent.at(-1).params.id, 'miner');
  now = 46000; h.runTimer(15000); assert.equal(api.state.phase, 'reconnecting');
  h.win.dispatchEvent({ type: 'online' }); assert.equal(api.state.phase, 'connecting');
  ws = h.sockets.at(-1); ws.open(); ws.message({ error: 'Pool unavailable' });
  assert.equal(api.state.phase, 'reconnecting'); api.destroy();
});
test('quiet pools without keepalive support are not sent custom RPCs or disconnected for silence', async () => {
  let now = 0;
  const h = harness({ Date: { now: () => now } }); const { api, root } = await approve(h);
  root.message({ type: 'ready' }); const ws = h.sockets[0]; ws.open();
  ws.message({ id: 1, result: { id: 'miner', job } });
  now = 600000; h.runTimer(15000);
  assert.equal(ws.sent.length, 1); assert.equal(api.state.running, true);
  root.message({ type: 'share', job_id: job.job_id, job_seq: root.sent.at(-1).job_seq,
    nonce: '00000000', result: '00'.repeat(32) });
  now += 46000; h.runTimer(15000); assert.equal(api.state.phase, 'reconnecting');
  api.destroy();
});
test('explicit NiceHash mode preserves every assigned prefix without extension flags and across reconnects', async () => {
  const h = harness(); const { api, root } = await approve(h, { nonceMode: 'nicehash' });
  root.message({ type: 'ready' }); let ws = h.sockets[0]; ws.open();
  const assigned = prefix => ({ ...job, blob: job.blob.slice(0, 84) + prefix + job.blob.slice(86), algo: 'rx/0', height: 123 });
  ws.message({ id: 1, result: { id: 'slot-one', job: assigned('00') } });
  assert.equal(api.state.nicehash, true); assert.equal(root.sent.at(-1).nicehash, true);
  ws.message({ method: 'job', params: assigned('ff') });
  assert.equal(root.sent.at(-1).blob.slice(84, 86), 'ff'); assert.equal(root.sent.at(-1).nicehash, true);
  ws.close(); h.runTimer(1000); ws = h.sockets[1]; ws.open();
  ws.message({ id: 1, result: { id: 'slot-two', job: assigned('80') } });
  assert.equal(root.sent.at(-1).blob.slice(84, 86), '80'); assert.equal(root.sent.at(-1).nicehash, true);
  assert.equal(h.workers.length, 1); assert.equal(root.sent.filter(message => message.type === 'init').length, 1);
  assert.throws(() => h.create({ nonceMode: 'fixed-everywhere' }), /nonceMode/);
  api.destroy();
});
test('required keepalive starts after login and sends integer IDs every 15 seconds without advertisements', async () => {
  let now = 0;
  const h = harness({ Date: { now: () => now } }); const { api, root } = await approve(h, { keepalive: 'required' });
  root.message({ type: 'ready' }); const ws = h.sockets[0]; ws.open();
  [...h.timers.values()].find(timer => timer.repeat).fn();
  assert.deepEqual(ws.sent.map(message => message.method), ['login'], 'no other frames before the login reply');
  ws.message({ id: 1, result: { id: 'opaque-session', job } });
  for (const time of [15000, 30000, 45000]) { now = time; h.runTimer(15000); }
  assert.deepEqual(ws.sent.slice(1), [2, 3, 4].map(id => ({ id, jsonrpc: '2.0', method: 'keepalived', params: { id: 'opaque-session' } })));
  now = 61000; h.runTimer(15000);
  assert.equal(api.state.phase, 'reconnecting'); api.destroy();
});
test('unsupported required keepalive is actionable; unsupported negotiated keepalive is disabled', async () => {
  for (const keepalive of ['auto', 'required']) {
    const h = harness(); const { api, root } = await approve(h, { keepalive });
    root.message({ type: 'ready' }); const ws = h.sockets[0]; ws.open();
    ws.message({ id: 1, result: { id: 'miner', job, extensions: ['keepalive'] } });
    h.runTimer(15000); ws.message({ id: 2, error: { code: -32601, message: 'Method not found' } });
    if (keepalive === 'required') {
      assert.equal(api.state.error.code, 'KEEPALIVE_UNSUPPORTED'); assert.equal(root.terminated, true);
      assert.equal(h.timers.size, 0);
    } else {
      assert.equal(api.state.running, true); h.runTimer(15000);
      assert.equal(ws.sent.length, 2);
    }
    assert.throws(() => h.create({ keepalive: 'custom-ping' }), /keepalive/);
    api.destroy();
  }
});
test('login errors and policy close codes are terminal, retain the server message and withdraw consent', async () => {
  for (const failure of ['login-string', 'login-object', 1008, 4001]) {
    const h = harness(); const { api, root } = await approve(h);
    root.message({ type: 'ready' }); const ws = h.sockets[0]; ws.open();
    const reason = 'This endpoint accepts only its disclosed donation wallet';
    if (typeof failure === 'string') ws.message({ id: 1, error: failure === 'login-string' ? reason : { code: -1, message: reason } });
    else { ws.onerror(); ws.close(failure, reason); }
    assert.equal(api.state.phase, 'error'); assert.equal(api.state.running, false);
    assert.equal(api.state.status, reason); assert.equal(api.state.error.message, reason);
    assert.equal(api.state.error.code, typeof failure === 'string' ? 'LOGIN_REJECTED' : 'PROXY_SESSION_REJECTED');
    assert.equal(root.terminated, true); assert.equal(h.timers.size, 0);
    h.doc.dispatchEvent({ type: 'securitypolicyviolation', disposition: 'enforce',
      effectiveDirective: 'connect-src', blockedURI: 'ws://localhost/' });
    assert.equal(api.state.error.message, reason, 'late policy reports cannot replace the terminal proxy reason');
    h.win.dispatchEvent({ type: 'online' }); assert.equal(h.sockets.length, 1);
    api.destroy();
  }
});
test('restart and overload close codes retry with the same engine; error-only events have a fallback', async () => {
  for (const code of [1012, 1013]) {
    const h = harness(); const { api, root } = await approve(h);
    root.message({ type: 'ready' }); h.sockets[0].open(); h.sockets[0].close(code, 'Retry later');
    assert.equal(api.state.phase, 'reconnecting'); h.runTimer(1000);
    assert.equal(h.sockets.length, 2); assert.equal(root.terminated, false);
    h.sockets[1].onerror(); h.runTimer(250);
    assert.equal(api.state.phase, 'reconnecting'); h.runTimer(2000);
    assert.equal(h.workers.length, 1); api.destroy();
  }
});
test('outbound frames fit 4096 UTF-8 bytes and oversized requests stop before sending', async () => {
  const h = harness(); const { api, root } = await approve(h, { wallet: '𐍈'.repeat(128), workerName: '🌕'.repeat(32) });
  root.message({ type: 'ready' }); const ws = h.sockets[0]; ws.open();
  assert.ok(new Blob([JSON.stringify(ws.sent[0])]).size <= 4096);
  ws.message({ id: 1, result: { id: 'miner', job: { ...job, job_id: 'x'.repeat(4096) } } });
  const work = root.sent.at(-1);
  root.message({ type: 'share', job_id: work.job_id, job_seq: work.job_seq, nonce: '00000000', result: '00'.repeat(32) });
  assert.equal(ws.sent.length, 1); assert.equal(api.state.error.code, 'FRAME_TOO_LARGE');
  assert.equal(root.terminated, true); assert.equal(h.timers.size, 0); api.destroy();
});
test('hiding invalidates pending consent; changing workload ends the approved session', async () => {
  const h = harness(); const api = h.create(); let ticket;
  api.on('consent-request', detail => { ticket = detail; }); api.requestConsent();
  api.setWorkload(25); assert.equal(ticket.accept(), false);
  api.requestConsent(); h.doc.hidden = true; h.doc.dispatchEvent({ type: 'visibilitychange' });
  assert.equal(ticket.accept(), false); h.doc.hidden = false; h.doc.dispatchEvent({ type: 'visibilitychange' });
  assert.equal(h.workers.length, 0);
  api.requestConsent(); ticket.accept(); await flush();
  api.setWorkload(100); assert.equal(api.state.running, false); assert.equal(api.state.threads, 9);
  assert.equal(api.state.workload, 80);
  assert.equal(h.workers.length, 1); api.destroy();
});
test('approved mining and reconnects survive tab switches with the same workers', async () => {
  const h = harness(); const { api, root } = await approve(h);
  h.doc.hidden = true; h.doc.dispatchEvent({ type: 'visibilitychange' });
  assert.equal(api.state.running, true); assert.equal(root.terminated, false);
  root.message({ type: 'ready' });
  const ws = h.sockets[0]; ws.open(); ws.message({ id: 1, result: { id: 'miner', job } });
  root.message({ type: 'hashrate', rate: 100 });
  assert.equal(api.state.hashrate, 100);
  ws.close(); h.runTimer(1000);
  const recovered = h.sockets[1]; recovered.open(); recovered.message({ id: 1, result: { id: 'new-miner', job } });
  assert.equal(h.workers.length, 1); assert.equal(root.terminated, false);
  assert.equal(api.state.running, true);
  h.doc.hidden = false; h.doc.dispatchEvent({ type: 'visibilitychange' });
  assert.equal(api.state.running, true); assert.equal(h.sockets.length, 2);
  assert.equal(root.sent[0].type, 'init');
  h.win.dispatchEvent({ type: 'pagehide' });
  assert.equal(root.terminated, true); assert.equal(api.state.running, false);
  assert.equal(recovered.closeCode, 1000); assert.equal(recovered.closeReason, 'Session stopped');
  assert.equal(h.timers.size, 0); api.destroy();
});
test('non-isolated pages cannot start; a second instance cannot double the CPU budget', async () => {
  const isolated = harness({ isolated: false }); const p = await approve(isolated);
  assert.equal(p.api.state.phase, 'error'); assert.equal(isolated.downloads.length, 0);
  const h = harness(); const a = await approve(h); const b = await approve(h);
  assert.match(b.api.state.status, /already running/); assert.equal(h.workers.length, 1);
  a.api.destroy(); b.api.destroy();
});
test('custom DOM binding enforces checkbox consent and Stop resets it', async () => {
  const h = harness(); const api = h.create();
  const start = new Target(), stop = new Target(), consent = new Target(), disclosure = {}, status = {};
  consent.checked = false;
  api.bindControls({ start, stop, consent, disclosure, status });
  start.dispatchEvent({ type: 'click', isTrusted: true }); assert.equal(h.downloads.length, 0);
  consent.checked = true; start.dispatchEvent({ type: 'click', isTrusted: false }); assert.equal(h.downloads.length, 0);
  start.dispatchEvent({ type: 'click', isTrusted: true }); await flush(); assert.equal(h.workers.length, 1);
  stop.dispatchEvent({ type: 'click' }); assert.equal(consent.checked, false); assert.equal(api.state.running, false);
  assert.match(disclosure.textContent, /initialization uses 32 threads/); api.destroy();
});

test('preflight diagnostics explain missing isolation before consent without engine or network work', () => {
  const h = harness({ isolated: false, secure: false, embedded: true });
  let event;
  h.doc.addEventListener('randomx:error', e => { event = e.detail; });
  const api = h.create();
  const report = h.win.RandomXEmbed.diagnose();
  assert.equal(report.supported, false);
  assert.deepEqual(Array.from(report.issues, issue => issue.code), ['INSECURE_CONTEXT', 'CROSS_ORIGIN_ISOLATION']);
  assert.equal(api.state.phase, 'error'); assert.equal(api.state.error.code, 'DEPLOYMENT_UNSUPPORTED');
  assert.equal(event.instance, api); assert.equal(event.checks.embedded, true);
  assert.match(event.hints.join(' '), /HTML response.*Cross-Origin-Opener-Policy/);
  assert.match(event.hints.join(' '), /parent page/);
  const output = {};
  api.bindControls({ diagnostics: output });
  assert.match(output.textContent, /DEPLOYMENT_UNSUPPORTED/);
  assert.match(output.textContent, /HTTPS/);
  assert.equal(h.workers.length + h.downloads.length + h.sockets.length, 0);
  api.destroy();
  assert.equal(h.doc.handlers.get('securitypolicyviolation').size, 0);
});
test('diagnostics distinguish denied permissions and unavailable shared memory from unknown policy support', () => {
  const denied = harness({ permissionsPolicy: { features: () => ['cross-origin-isolated'], allowsFeature: () => false } });
  const report = denied.win.RandomXEmbed.diagnose();
  assert.equal(report.checks.isolationAllowed, false);
  assert.equal(report.issues[0].code, 'PERMISSIONS_POLICY');
  const unknown = harness({ permissionsPolicy: { features: () => [], allowsFeature: () => false } });
  assert.equal(unknown.win.RandomXEmbed.diagnose().checks.isolationAllowed, null);
  assert.equal(unknown.win.RandomXEmbed.diagnose().supported, true);
  const unavailable = harness({ sharedMemory: false });
  assert.equal(unavailable.win.RandomXEmbed.diagnose().issues[0].code, 'SHARED_MEMORY_UNAVAILABLE');
  assert.equal(denied.downloads.length + unknown.downloads.length + unavailable.downloads.length, 0);
});
test('download errors provide checks and a delayed enforced CSP report supplies the precise cause', async () => {
  const h = harness({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
  const { api } = await approve(h, { assetBase: 'https://cdn.example/runtime/' });
  assert.equal(api.state.error.code, 'ASSET_DOWNLOAD_FAILED');
  assert.match(api.state.error.hints.join(' '), /CORS\/CORP/);
  const events = [];
  api.on('error', report => events.push(report));
  h.doc.dispatchEvent({ type: 'securitypolicyviolation', disposition: 'enforce',
    effectiveDirective: 'connect-src', blockedURI: 'https://cdn.example' });
  assert.equal(api.state.error.code, 'CSP_BLOCKED');
  assert.equal(api.state.error.directive, 'connect-src');
  assert.equal(events.length, 1); assert.equal(h.workers.length, 0);
  assert.equal(h.timers.size, 0);
  api.destroy();
});
test('unrelated and report-only CSP violations do not interrupt a running engine', async () => {
  const h = harness(); const { api, root } = await approve(h);
  h.doc.dispatchEvent({ type: 'securitypolicyviolation', disposition: 'report',
    effectiveDirective: 'worker-src', blockedURI: root.url });
  h.doc.dispatchEvent({ type: 'securitypolicyviolation', disposition: 'enforce',
    effectiveDirective: 'img-src', blockedURI: 'https://other.example/banner.png' });
  assert.equal(api.state.running, true); assert.equal(root.terminated, false);
  assert.equal(api.state.error, null);
  api.destroy();
});
test('owned pthread policy errors identify WASM permission and tear down every worker', async () => {
  const h = harness(); const { api, root } = await approve(h);
  root.message({ type: 'rx:thread-create', id: 1, url: root.url.replace('/2', '/1'), options: {} });
  h.workers[1].message({ type: 'rx:policy-error', disposition: 'enforce',
    effectiveDirective: 'script-src', blockedURI: 'wasm-eval' });
  assert.equal(api.state.error.code, 'CSP_BLOCKED');
  assert.match(api.state.error.hints.join(' '), /wasm-unsafe-eval/);
  assert.ok(h.workers.every(worker => worker.terminated));
  assert.equal(h.revoked.length, 2); assert.equal(h.timers.size, 0);
  assert.equal(api.state.running, false);
  api.destroy();
});
test('worker constructor failures are actionable; explicit Stop suppresses late policy reports', async () => {
  const h = harness({ workerError: 'SecurityError: Worker denied' });
  const { api } = await approve(h);
  assert.equal(api.state.error.code, 'ENGINE_WORKER_FAILED');
  assert.match(api.state.error.hints.join(' '), /worker-src/);
  h.doc.dispatchEvent({ type: 'securitypolicyviolation', disposition: 'enforce',
    effectiveDirective: 'worker-src', blockedURI: 'blob' });
  assert.equal(api.state.error.code, 'CSP_BLOCKED');
  assert.equal(h.workers.length, 0); assert.equal(h.revoked.length, 2);
  api.stop();
  h.doc.dispatchEvent({ type: 'securitypolicyviolation', disposition: 'enforce',
    effectiveDirective: 'worker-src', blockedURI: 'blob' });
  assert.equal(api.state.phase, 'stopped'); assert.equal(api.diagnostics.error, null);
  api.destroy();
});
test('blocked bridge reports stop retries and remove URL queries from diagnostic resources', async () => {
  const h = harness(); const { api, root } = await approve(h, { proxy: 'ws://localhost/bridge?token=private' });
  root.message({ type: 'ready' }); h.sockets[0].close();
  h.doc.dispatchEvent({ type: 'securitypolicyviolation', disposition: 'enforce',
    effectiveDirective: 'connect-src', blockedURI: 'ws://localhost/bridge?token=private&pool=pool.example' });
  assert.equal(api.state.error.code, 'CSP_BLOCKED');
  assert.equal(api.state.error.resource, 'ws://localhost/bridge');
  assert.equal(h.timers.size, 0); assert.equal(root.terminated, true);
  api.destroy();
});

// Light mode: a pool of randomx_st workers (workerPool) behind the same
// session lifecycle. nav(cores) is an x86 browser, so 50% gives cores / 2.
const nav = (cores, extra) => ({ hardwareConcurrency: cores, userAgent: 'Chrome/130', platform: 'Linux x86_64', ...extra });
const statusesOf = api => { const seen = []; api.on('state', s => seen.push(s.status)); return seen; };
test('light mode runs a randomx_st worker pool on a non-isolated page, one nonce slot per worker', async () => {
  const h = harness({ isolated: false, sharedMemory: false });
  const api = h.create({ mode: 'light' });
  assert.equal(api.state.error, null); assert.notEqual(api.state.phase, 'error');
  assert.deepEqual({ ...api.state.engine }, { mode: 'light', runtime: 'workers', workers: 6, replicas: 0, replicasActive: 0, memoryMiB: 1800 });
  assert.ok(Object.isFrozen(api.state.engine));
  let consent; api.on('consent-request', detail => { consent = detail; });
  api.requestConsent();
  assert.equal(h.downloads.length + h.workers.length + h.sockets.length + h.scripts.length, 0);
  assert.match(consent.disclosure, /Mining uses 6 of 12 reported CPU cores \(50\.0%\), at most 9\. Light mode runs 6 workers at about 300 MB each\. /);
  assert.match(consent.disclosure, /about 1\.8 GB of RAM in total and no isolation headers\. This uses electricity.*battery\. Stop at any time\. Mining continues in background tabs/);
  assert.doesNotMatch(consent.disclosure, /initialization|full dataset/);
  consent.accept(); await flush();
  assert.deepEqual(h.downloads.map(download => download.url), ['http://localhost/randomx_st.js']);
  assert.equal(h.workers.length, 6);
  const glue = await h.blobs.get('blob:http://localhost/1').text();
  assert.ok(glue.includes('__rxPolicyReporter') && glue.endsWith(')();\nruntime'), 'the glue blob carries the policy reporter');
  const bootstrap = await h.blobs.get(h.workers[0].url).text();
  assert.ok(bootstrap.includes('__rxPolicyReporter'));
  assert.ok(bootstrap.endsWith('self.__randomxAssets=' + JSON.stringify({ baseURL: 'http://localhost/',
    glueURL: 'blob:http://localhost/1', build: 'st' }) + ';importScripts("http://localhost/worker.js");'));
  assert.ok(h.workers.every(worker => worker.url === h.workers[0].url));
  assert.deepEqual(h.workers.map(worker => worker.options.name), [0, 1, 2, 3, 4, 5].map(i => 'rx-st-' + i));
  assert.deepEqual(h.workers.map(worker => ({ ...worker.sent[0] })), [0, 1, 2, 3, 4, 5].map(nonceSlot => ({ type: 'init',
    fullMemory: false, datasetThreads: 1, datasetInitThreads: 1, enableJit: true, jitProfile: 'auto', jitExperiment: '',
    nonceSlot, nonceSlots: 6 })));
  assert.equal(h.scripts.length, 0); assert.equal(api.state.running, true); assert.equal(api.state.error, null);
  api.destroy();
});
test('the light pool reports ready once, sums hashrates, passes shares through and exhausts a job only when every slot has', async () => {
  const h = harness({ isolated: false, navigator: nav(6) });
  const { api } = await approve(h, { mode: 'light' });
  const pool = h.workers; assert.equal(pool.length, 3);
  pool[0].message({ type: 'ready' }); pool[1].message({ type: 'ready' });
  assert.equal(h.sockets.length, 0, 'ready once every worker is');
  pool[2].message({ type: 'ready' }); assert.equal(h.sockets.length, 1);
  let ws = h.sockets[0]; ws.open(); ws.message({ id: 1, result: { id: 'miner', job } });
  const work = pool[0].sent.at(-1);
  assert.equal(work.type, 'job'); assert.ok(pool.every(worker => worker.sent.at(-1) === work));
  assert.equal(api.state.status, 'Initializing light-mode caches (3 workers)…');
  pool[1].message({ type: 'status', message: 'chatty' }); assert.notEqual(api.state.status, 'chatty');
  pool[0].message({ type: 'status', message: 'Ready to mine' }); assert.equal(api.state.status, 'Ready to mine');
  pool.forEach(worker => worker.message({ type: 'mode', mode: 'light' }));
  [10, 20, 30].forEach((rate, i) => pool[i].message({ type: 'hashrate', rate }));
  assert.equal(api.state.hashrate, 60); assert.equal(api.state.phase, 'mining');
  pool[1].message({ type: 'hashrate', rate: 25 }); assert.equal(api.state.hashrate, 65);
  pool[2].message({ type: 'share', job_id: work.job_id, job_seq: work.job_seq, nonce: 'aabbccdd', result: '00'.repeat(32) });
  assert.equal(ws.sent.at(-1).method, 'submit'); assert.equal(ws.sent.at(-1).params.nonce, 'aabbccdd');
  for (const i of [0, 1]) pool[i].message({ type: 'nonce_exhausted', job_id: work.job_id, job_seq: work.job_seq });
  assert.equal(api.state.phase, 'mining'); assert.equal(api.state.hashrate, 30, 'exhausted slots leave the sum');
  pool[2].message({ type: 'nonce_exhausted', job_id: work.job_id, job_seq: work.job_seq - 1 });
  assert.notEqual(api.state.phase, 'waiting', 'another job sequence does not complete this one');
  pool[2].message({ type: 'nonce_exhausted', job_id: work.job_id, job_seq: work.job_seq });
  assert.equal(api.state.phase, 'waiting'); assert.equal(api.state.hashrate, 0); assert.equal(api.state.running, true);
  ws.message({ method: 'job', params: { ...job, job_id: 'fresh' } });
  const fresh = pool[0].sent.at(-1); assert.equal(fresh.job_id, 'fresh'); assert.notEqual(api.state.phase, 'waiting');
  for (const i of [0, 1]) pool[i].message({ type: 'nonce_exhausted', job_id: 'fresh', job_seq: fresh.job_seq });
  assert.notEqual(api.state.phase, 'waiting');
  // A new seed waits for a rekeyed cache; one worker with it is enough to mine.
  ws.message({ method: 'job', params: { ...job, job_id: 'reseed', seed_hash: '11'.repeat(32) } });
  assert.equal(api.state.status, 'Initializing light-mode caches (3 workers)…');
  pool[2].message({ type: 'mode', mode: 'light' });
  ws.message({ method: 'job', params: { ...job, job_id: 'same-seed', seed_hash: '11'.repeat(32) } });
  assert.equal(api.state.status, 'Mining'); assert.equal(api.state.phase, 'mining');
  // Reconnects keep the same workers and their resident caches.
  ws.close(); assert.ok(pool.every(worker => worker.sent.at(-1).type === 'stop')); h.runTimer(1000);
  ws = h.sockets.at(-1); ws.open(); ws.message({ id: 1, result: { id: 'again', job } });
  assert.equal(h.workers.length, 3); assert.ok(pool.every(worker => worker.sent.filter(m => m.type === 'init').length === 1));
  assert.ok(pool.every(worker => worker.sent.at(-1).type === 'job'));
  pool[1].message({ type: 'error', message: 'Failed to allocate cache' });
  assert.equal(api.state.error.code, 'ENGINE_WORKER_FAILED');
  assert.match(api.state.error.message, /\[worker 1\] Failed to allocate cache/);
  assert.match(api.state.error.hints.join(' '), /light-mode session needs about 0\.9 GB of RAM/);
  assert.ok(pool.every(worker => worker.terminated)); assert.equal(h.revoked.length, 2); assert.equal(api.state.running, false);
  api.destroy();
});
test('Stop and pagehide terminate every pool worker and revoke its URLs; late messages start nothing', async () => {
  const h = harness({ isolated: false });
  const { api } = await approve(h, { mode: 'light' });
  assert.equal(h.workers.length, 6);
  api.stop();
  assert.ok(h.workers.every(worker => worker.terminated));
  assert.deepEqual(h.revoked, ['blob:http://localhost/1', 'blob:http://localhost/2']);
  h.workers.forEach(worker => worker.message({ type: 'ready' })); assert.equal(h.sockets.length, 0);
  let consent; api.on('consent-request', detail => { consent = detail; });
  api.requestConsent(); consent.accept(); await flush();
  assert.equal(h.workers.length, 12, 'a new consent starts a new pool');
  h.workers.slice(6).forEach(worker => worker.message({ type: 'ready' })); assert.equal(h.sockets.length, 1);
  h.win.dispatchEvent({ type: 'pagehide' });
  assert.ok(h.workers.every(worker => worker.terminated)); assert.equal(h.revoked.length, 4);
  assert.equal(api.state.running, false); assert.equal(h.timers.size, 0); assert.equal(h.sockets[0].closeReason, 'Session stopped');
  api.destroy();
  let resolve;
  const pending = harness({ isolated: false, fetch: () => new Promise(r => { resolve = r; }) });
  const p = await approve(pending, { mode: 'light' }); p.api.stop();
  assert.equal(pending.downloads[0].init.signal.aborted, true);
  resolve({ ok: true, text: async () => 'runtime' }); await flush();
  assert.equal(pending.workers.length, 0);
});
test('pool workers cannot create pthreads; their policy reports identify the cause', async () => {
  const h = harness({ isolated: false });
  const { api } = await approve(h, { mode: 'light' });
  h.workers[3].message({ type: 'rx:thread-create', id: 1, url: 'blob:http://localhost/1', options: {} });
  assert.equal(h.workers.length, 6, 'no pthread worker is created');
  assert.ok(h.workers.every(worker => worker.terminated)); assert.equal(api.state.running, false);
  assert.equal(api.state.status, 'Unexpected engine thread request');
  const c = harness({ isolated: false }); const second = await approve(c, { mode: 'light' });
  c.workers[4].message({ type: 'rx:policy-error', disposition: 'enforce', effectiveDirective: 'script-src', blockedURI: 'wasm-eval' });
  assert.equal(second.api.state.error.code, 'CSP_BLOCKED');
  assert.match(second.api.state.error.hints.join(' '), /wasm-unsafe-eval/);
  assert.ok(c.workers.every(worker => worker.terminated)); assert.equal(c.revoked.length, 2);
  api.destroy(); second.api.destroy();
});
test('replicas load fb_full.js once, take the first worker roles and build through the page coordinator', async () => {
  const h = harness({ isolated: false, navigator: nav(6, { deviceMemory: 16 }) });
  const api = h.create({ mode: 'light', replicas: 2, nonce: 'page-nonce' });
  const statuses = statusesOf(api);
  assert.deepEqual({ ...api.state.engine }, { mode: 'light', runtime: 'workers', workers: 3, replicas: 2, replicasActive: 0, memoryMiB: 5500 });
  let consent; api.on('consent-request', detail => { consent = detail; });
  api.requestConsent(); assert.equal(h.scripts.length + h.downloads.length + h.workers.length, 0, 'nothing loads before consent');
  assert.match(consent.disclosure, /runs 3 workers at about 300 MB each; 2 of them also hold a private full dataset \(about 2\.3 GB each\), which all workers rebuild after each seed change\. It needs about 5\.5 GB of RAM in total/);
  consent.accept(); await flush();
  assert.equal(h.scripts.length, 1);
  const [element] = h.scripts;
  assert.equal(element.tagName, 'script'); assert.equal(element.src, 'http://localhost/fb_full.js');
  assert.equal(element.crossOrigin, 'anonymous'); assert.equal(element.nonce, 'page-nonce'); assert.equal(element.removed, true);
  const pool = h.workers; assert.equal(pool.length, 3);
  assert.deepEqual(pool.map(worker => worker.sent[0].fbRole), ['full', 'full', 'light']);
  assert.deepEqual(pool.map(worker => worker.sent[0].nonceSlot), [0, 1, 2]);
  pool.forEach(worker => worker.message({ type: 'ready' })); const ws = h.sockets[0]; ws.open();
  ws.message({ id: 1, result: { id: 'miner', job } });
  const seed = job.seed_hash, items = 2 * 65536, sent = (worker, type) => worker.sent.filter(m => m.type === type);
  pool.forEach((worker, i) => {
    worker.message({ type: 'mode', mode: 'light' });
    worker.message({ type: 'fb_cache', seed, full: i < 2, items });
  });
  assert.equal(api.state.progress, 0);
  assert.deepEqual(pool.map(worker => sent(worker, 'fb_compute').map(m => m.chunk)), [[0], [1], []]);
  pool[0].message({ type: 'hashrate', rate: 40 }); assert.equal(api.state.phase, 'mining', 'light workers mine while replicas build');
  pool[0].message({ type: 'fb_chunk', seed, chunk: 0, own: true, buf: new ArrayBuffer(8) });
  assert.deepEqual(sent(pool[1], 'fb_write').map(m => m.chunk), [0]);
  pool[1].message({ type: 'fb_written', seed, chunk: 0 });
  pool[1].message({ type: 'fb_chunk', seed, chunk: 1, own: true, buf: new ArrayBuffer(8) });
  pool[0].message({ type: 'fb_written', seed, chunk: 1 });
  assert.equal(sent(pool[0], 'fb_finalize').length, 1); assert.equal(sent(pool[1], 'fb_finalize').length, 1);
  pool[0].message({ type: 'mode', mode: 'full' }); pool[0].message({ type: 'fb_final', seed, ok: true });
  assert.equal(api.state.engine.replicasActive, 1);
  pool[1].message({ type: 'mode', mode: 'full' }); pool[1].message({ type: 'fb_final', seed, ok: true });
  assert.equal(api.state.engine.replicasActive, 2); assert.equal(api.state.progress, 1);
  assert.equal(api.state.status, 'Replica datasets ready: 2 of 2 mining in full mode');
  assert.ok(!statuses.some(status => /Building dataset|fb_/.test(status)), 'replica progress never takes over the status line');
  api.stop(); assert.ok(pool.every(worker => worker.terminated)); assert.equal(api.state.engine.replicasActive, 0);
  api.requestConsent(); consent.accept(); await flush();
  assert.equal(h.scripts.length, 1, 'window.RxFbFull is reused'); assert.equal(h.workers.length, 6);
  assert.equal(h.workers[3].sent[0].fbRole, 'full');
  api.destroy();
});
test('replicas demote on low reported memory; a failed fb_full.js load is a diagnosable asset failure', async () => {
  const base = { wallet: 'test-wallet', pool: 'pool.example', mode: 'light', replicas: 1 };
  const low = harness({ isolated: false, navigator: nav(6, { deviceMemory: 4 }) });
  const plan = low.win.RandomXEmbed.plan(base);
  assert.equal(plan.replicas, 0); assert.equal(plan.replicasDemoted, true); assert.equal(plan.memoryMiB, 900);
  assert.doesNotMatch(plan.disclosure, /full dataset/);
  for (const deviceMemory of [8, undefined]) {
    const kept = low.win.RandomXEmbed.plan(base, nav(6, { deviceMemory }));
    assert.equal(kept.replicas, 1); assert.equal(kept.replicasDemoted, false);
  }
  const { api } = await approve(low, { mode: 'light', replicas: 1 });
  assert.equal(low.scripts.length, 0); assert.equal(low.workers.length, 3);
  assert.ok(low.workers.every(worker => !('fbRole' in worker.sent[0])));
  assert.equal(api.state.engine.replicas, 0); api.destroy();
  const blocked = harness({ isolated: false, scriptError: true, navigator: nav(6) });
  const failed = await approve(blocked, { mode: 'light', replicas: 1 });
  assert.equal(failed.api.state.error.code, 'ASSET_DOWNLOAD_FAILED'); assert.equal(failed.api.state.error.stage, 'assets');
  assert.match(failed.api.state.error.hints.join(' '), /http:\/\/localhost\/fb_full\.js exists/);
  assert.equal(blocked.workers.length, 0); assert.equal(blocked.scripts[0].removed, true);
  blocked.doc.dispatchEvent({ type: 'securitypolicyviolation', disposition: 'enforce',
    effectiveDirective: 'script-src-elem', blockedURI: 'http://localhost/fb_full.js' });
  assert.equal(failed.api.state.error.code, 'CSP_BLOCKED'); assert.equal(failed.api.state.error.directive, 'script-src-elem');
  failed.api.destroy();
});
test('mode, replica, thread and tuning options are validated strictly and frozen into config', () => {
  const h = harness();
  assert.throws(() => h.create({ replicas: 1 }), /replicas need mode: 'light'/);
  for (const mode of ['auto', null, false, 0, 'Light']) assert.throws(() => h.create({ mode }), /full or light/);
  const blank = h.create({ mode: '' }); assert.equal(blank.config.mode, 'full'); blank.destroy();
  for (const maxThreads of [0, 33, 1.5, 'x', true]) assert.throws(() => h.create({ maxThreads }), /maxThreads/);
  for (const replicas of [-1, 3, 0.5]) assert.throws(() => h.create({ mode: 'light', replicas }), /replicas/);
  for (const initThreads of [0, 33, 2.5]) assert.throws(() => h.create({ initThreads }), /initThreads/);
  // 256 characters of hash-safe tokens; one more is too long.
  const long = 'no_supjit,'.repeat(24) + 'fuse_n=3,no_fuse';
  for (const tuning of [[], 'x86', { speed: 1 }, { profile: 'arm64' }, { jit: 'false' }, { lightMlp: 3 }, { kernelK: 0 },
    { kernelK: '2' }, { experiment: 'fuse_n=3 no_supjit' }, { experiment: long + '1' }, { experiment: 'a;b' },
    // reuse/reuse2 cache the first JIT module: wrong hashes on purpose.
    { experiment: 'reuse' }, { experiment: 'no_threaded,reuse' }, { experiment: 'REUSE2' }, { experiment: 'fuse_n=3,reuse2' },
    { experiment: 'threaded' }, { experiment: 'fuse_n=x' }, { experiment: 'kernel_k' }]) {
    assert.throws(() => h.create({ tuning }), /tuning/);
  }
  assert.throws(() => h.win.RandomXEmbed.plan({ wallet: 'w', pool: 'p', tuning: { experiment: 'no_threaded,reuse' } }), /hash-safe/);
  const api = h.create({ mode: 'light', maxThreads: '4', replicas: '2', initThreads: '8',
    tuning: { profile: 'arm', experiment: long, lightMlp: undefined } });
  assert.equal(long.length, 256);
  assert.equal(api.config.maxThreads, 4); assert.equal(api.config.replicas, 2); assert.equal(api.config.initThreads, 8);
  assert.deepEqual({ ...api.config.tuning }, { profile: 'arm', experiment: long });
  const safe = 'no_threaded,no_inline_fprc,no_regs_mem,no_split_id,no_fuse,no_inline_round,no_supjit,unroll2,unroll2=0,' +
    'fuse_n=3,triples_n=2,shared_code=1,aes_simd=0,aes_relaxed=1,light_mlp=2,kernel_k=4';
  const tuned = h.create({ tuning: { experiment: safe } }); assert.equal(tuned.config.tuning.experiment, safe); tuned.destroy();
  assert.ok(Object.isFrozen(api.config) && Object.isFrozen(api.config.tuning));
  const defaults = h.create();
  assert.equal(defaults.config.mode, 'full'); assert.equal(defaults.config.maxThreads, null);
  assert.equal(defaults.config.replicas, 0); assert.equal(defaults.config.initThreads, 32);
  assert.deepEqual({ ...defaults.config.tuning }, {});
  api.destroy(); defaults.destroy();
});
test('maxThreads is an absolute ceiling on mining threads and light workers', async () => {
  const unbounded = harness({ navigator: nav(32) }).create({ workload: 80 });
  assert.equal(unbounded.state.threads, 25); unbounded.destroy();
  const h = harness({ isolated: false, navigator: nav(32) });
  const { api } = await approve(h, { mode: 'light', workload: 80, maxThreads: 4 });
  assert.equal(api.limits.maxThreads, 4); assert.equal(api.state.threads, 4); assert.equal(api.state.engine.workers, 4);
  assert.equal(h.workers.length, 4); assert.ok(h.workers.every(worker => worker.sent[0].nonceSlots === 4));
  api.destroy();
  const full = harness({ navigator: nav(32) }); const f = await approve(full, { workload: 80, maxThreads: 3 });
  assert.equal(f.root.sent[0].datasetThreads, 3); assert.equal(f.api.state.engine.workers, 1);
  assert.match(f.consent.disclosure, /Mining uses 3 of 32 reported CPU cores \(9\.4%\), at most 3\./);
  f.api.destroy();
});
test('plan() resolves threads, memory and disclosure without an instance, engine or network', () => {
  const h = harness({ isolated: false });
  const { plan } = h.win.RandomXEmbed;
  const base = { wallet: 'test-wallet', pool: 'pool.example', port: 3333 };
  const full = plan(base, nav(12));
  assert.ok(Object.isFrozen(full));
  assert.deepEqual({ ...full, disclosure: 0, limits: 0 }, { mode: 'full', runtime: 'pthreads', threads: 6, workers: 1,
    replicas: 0, replicasDemoted: false, initThreads: 32, memoryMiB: 2560, disclosure: 0, limits: 0 });
  assert.match(full.disclosure, /Dataset initialization uses 32 threads\. Full mode needs about 2\.5 GiB of RAM\./);
  assert.equal(full.limits.maxThreads, 9); assert.equal(full.limits.cores, 12);
  assert.match(plan({ ...base, initThreads: 1 }, nav(12)).disclosure, /initialization uses 1 thread\./);
  const light = plan({ ...base, mode: 'light', replicas: 1, workload: 25 }, nav(12, { deviceMemory: 8 }));
  assert.deepEqual({ ...light, disclosure: 0, limits: 0 }, { mode: 'light', runtime: 'workers', threads: 3, workers: 3,
    replicas: 1, replicasDemoted: false, initThreads: 3, memoryMiB: 3200, disclosure: 0, limits: 0 });
  assert.match(light.disclosure, /runs 3 workers at about 300 MB each; 1 of them also holds a private full dataset \(about 2\.3 GB\), which all workers rebuild after each seed change\. It needs about 3\.2 GB of RAM in total and no isolation headers\./);
  assert.equal(plan({ ...base, mode: 'light' }, nav(10, { platform: 'MacIntel', userAgent: 'Version/18 Safari/605' })).workers, 5);
  assert.equal(plan({ ...base, mode: 'light', replicas: 2, workload: 10 }, nav(12)).replicas, 1, 'replicas never exceed workers');
  assert.equal(plan({ ...base, mode: 'light', workload: 1 }, nav(12)).workers, 0);
  assert.throws(() => plan({ pool: 'pool.example' }), /wallet/);
  assert.throws(() => plan({ ...base, replicas: 1 }), /light/);
  assert.equal(h.downloads.length + h.workers.length + h.sockets.length + h.scripts.length + h.timers.size, 0);
  const api = h.create({ mode: 'light', replicas: 1, workload: 25 });
  const same = plan({ ...base, mode: 'light', replicas: 1, workload: 25 });
  assert.deepEqual({ ...api.state.engine }, { mode: same.mode, runtime: same.runtime, workers: same.workers,
    replicas: same.replicas, replicasActive: 0, memoryMiB: same.memoryMiB });
  let consent; api.on('consent-request', detail => { consent = detail; });
  api.requestConsent(); assert.equal(consent.disclosure, same.disclosure);
  api.destroy();
});
test('diagnose(mode) reports both modes; light needs only Worker and WebAssembly', () => {
  const h = harness({ isolated: false, secure: false, sharedMemory: false });
  const full = h.win.RandomXEmbed.diagnose();
  assert.deepEqual(Array.from(full.issues, issue => issue.code), ['INSECURE_CONTEXT', 'CROSS_ORIGIN_ISOLATION']);
  assert.deepEqual({ ...full.modes }, { full: false, light: true });
  assert.ok(full.issues[1].hints.includes("Or set mode: 'light', which needs no isolation headers."));
  assert.equal(JSON.stringify(h.win.RandomXEmbed.diagnose('full')), JSON.stringify(full));
  const light = h.win.RandomXEmbed.diagnose('light');
  assert.equal(light.supported, true); assert.equal(light.issues.length, 0);
  assert.deepEqual({ ...light.modes }, { full: false, light: true }); assert.equal(light.checks.crossOriginIsolated, false);
  assert.throws(() => h.win.RandomXEmbed.diagnose('auto'), /full or light/);
  const none = harness({ workers: false });
  const report = none.win.RandomXEmbed.diagnose('light');
  assert.deepEqual(Array.from(report.issues, issue => issue.code), ['ENGINE_UNSUPPORTED']);
  assert.equal(report.supported, false); assert.deepEqual({ ...report.modes }, { full: false, light: false });
  assert.match(report.issues[0].hints[0], /Web Workers and WebAssembly/);
  const offline = none.create({ mode: 'light' });
  assert.equal(offline.state.error.code, 'DEPLOYMENT_UNSUPPORTED'); assert.equal(offline.state.error.message, 'This page cannot run the mining engine.');
  offline.destroy();
  assert.deepEqual({ ...harness().win.RandomXEmbed.diagnose().modes }, { full: true, light: true });
  const denied = harness({ isolated: false, permissionsPolicy: { features: () => ['cross-origin-isolated'], allowsFeature: () => false } });
  const fullApi = denied.create();
  assert.equal(fullApi.state.error.code, 'DEPLOYMENT_UNSUPPORTED');
  assert.equal(fullApi.state.error.hints.filter(hint => /mode: 'light'/.test(hint)).length, 1, 'the light pointer appears once');
  const lightApi = denied.create({ mode: 'light' });
  assert.equal(lightApi.state.error, null); assert.equal(lightApi.diagnostics.supported, true);
  assert.equal(denied.downloads.length + denied.workers.length, 0);
  fullApi.destroy(); lightApi.destroy();
});
test('tuning reaches every engine init; full mode initializes with initThreads', async () => {
  const h = harness();
  const tuning = { profile: 'x86', jit: false, lightMlp: 2, kernelK: 4, experiment: 'fuse_n=3,,no_supjit' };
  const { api, root, consent } = await approve(h, { initThreads: 8, tuning });
  assert.match(consent.disclosure, /Dataset initialization uses 8 threads\./);
  assert.deepEqual({ ...root.sent[0] }, { type: 'init', fullMemory: true, datasetThreads: 6, datasetInitThreads: 8,
    enableJit: false, jitProfile: 'x86', jitExperiment: 'light_mlp=2,kernel_k=4,fuse_n=3,no_supjit' });
  root.message({ type: 'ready' }); h.sockets[0].open(); h.sockets[0].message({ id: 1, result: { id: 'miner', job } });
  assert.equal(api.state.status, 'Building dataset (8 initialization threads)…');
  root.message({ type: 'dataset_progress', done: 1, total: 4 });
  assert.equal(api.state.status, 'Building dataset: 25% (8 threads)'); assert.equal(api.state.progress, 0.25);
  root.message({ type: 'mode', mode: 'full' }); assert.equal(api.state.engine.replicasActive, 0);
  assert.deepEqual({ ...api.state.engine }, { mode: 'full', runtime: 'pthreads', workers: 1, replicas: 0, replicasActive: 0, memoryMiB: 2560 });
  api.destroy();
  const l = harness({ isolated: false, navigator: nav(4) });
  const light = await approve(l, { mode: 'light', tuning: { kernelK: 1 } });
  assert.deepEqual(l.workers.map(worker => [worker.sent[0].enableJit, worker.sent[0].jitProfile, worker.sent[0].jitExperiment]),
    [[true, 'auto', 'kernel_k=1'], [true, 'auto', 'kernel_k=1']]);
  light.api.destroy();
});
test('status lines count a single worker or thread in the singular', async () => {
  const l = harness({ isolated: false, navigator: nav(6) });
  const light = await approve(l, { mode: 'light', maxThreads: 1 });
  assert.equal(l.workers.length, 1); assert.match(light.consent.disclosure, /Light mode runs 1 worker at about 300 MB\. /);
  l.workers[0].message({ type: 'ready' }); l.sockets[0].open(); l.sockets[0].message({ id: 1, result: { id: 'miner', job } });
  assert.equal(light.api.state.status, 'Initializing light-mode caches (1 worker)…');
  light.api.destroy();
  const h = harness(); const { api, root } = await approve(h, { initThreads: 1 });
  root.message({ type: 'ready' }); h.sockets[0].open(); h.sockets[0].message({ id: 1, result: { id: 'miner', job } });
  assert.equal(api.state.status, 'Building dataset (1 initialization thread)…');
  root.message({ type: 'dataset_progress', done: 2, total: 5 });
  assert.equal(api.state.status, 'Building dataset: 40% (1 thread)');
  api.destroy();
});
test('script attributes configure light mode, replicas and thread limits without starting anything', () => {
  const dataset = { wallet: 'attr-wallet', pool: 'pool.example', headless: 'true', mode: 'light',
    maxThreads: '3', replicas: '1', initThreads: '16' };
  const h = harness({ isolated: false, script: { src: 'http://localhost/dist/embed.js', nonce: '', dataset,
    hasAttribute: name => name === 'data-wallet' } });
  assert.equal(h.ready.length, 1); const [api] = h.ready;
  assert.equal(api.config.mode, 'light'); assert.equal(api.config.maxThreads, 3);
  assert.equal(api.config.replicas, 1); assert.equal(api.config.initThreads, 16);
  assert.equal(api.config.assetBase, 'http://localhost/dist/');
  assert.equal(api.state.engine.workers, 3); assert.equal(api.state.engine.replicas, 1); assert.equal(api.state.error, null);
  assert.equal(h.downloads.length + h.workers.length + h.sockets.length + h.scripts.length, 0);
  api.destroy();
});

// Execute the real worker's range allocator and mining loop with a small
// engine boundary. Actual WASM pthreads are covered by embed-browser.cjs.
// slot/slots are the NoSabPool init fields (one slot: the whole space).
function nonceHarness(random = 0, slot = 0, slots = 1) {
  const messages = [], timers = [], batches = [], hashes = [];
  let time = 0;
  const math = Object.create(Math); math.random = () => random;
  const context = vm.createContext({ self: { location: {} }, importScripts() {}, Math: math,
    postMessage: msg => messages.push(msg), setTimeout: fn => timers.push(fn),
    performance: { now: () => { time += 300; return time; } }, console });
  vm.runInContext(readFileSync(require.resolve('../public/worker.js'), 'utf8'), context);
  vm.runInContext(`nonceSlot = ${slot}; nonceSlots = ${slots};`, context);
  return { context, messages, timers, batches, hashes,
    run: source => vm.runInContext(source, context),
    prepare(nicehash, prefix) {
      context.job = { nicehash, _blob: new Uint8Array(76) };
      context.job._blob[42] = prefix;
      vm.runInContext('initializeNonceRange(job)', context);
      return context.job;
    },
    // copied into this realm, so strict deepEqual compares only the fields
    range(count) { const r = vm.runInContext('nextNonceRange(job, ' + count + ')', context); return r && { ...r }; }
  };
}
test('negotiated nonce prefixes include zero and high-bit values; direct jobs use all 32 bits', () => {
  for (const prefix of [0, 1, 0x80, 0xff]) {
    const h = nonceHarness(); h.prepare(true, prefix);
    const range = h.range(32);
    assert.equal(range.startNonce, prefix * 0x1000000 + 1);
    assert.equal(range.count, 32);
  }
  const h = nonceHarness(0.5); h.prepare(false, 0xab);
  assert.equal(h.range(1).startNonce, 0x80000001, 'ordinary jobs do not inherit the blob prefix');
});
test('parallel ranges stop before the prefix boundary, wrap low bits, and never repeat a nonce', () => {
  const h = nonceHarness(0xfffffd / 0x1000000); const job = h.prepare(true, 0xff);
  assert.equal(job._nonce, 0xfffffd);
  const first = h.range(64);
  assert.equal(first.startNonce, 0xfffffffe); assert.equal(first.count, 2);
  const wrapped = h.range(64);
  assert.equal(wrapped.startNonce, 0xff000000); assert.equal(wrapped.count, 64);
  // Claim the rest in large contiguous ranges to exercise the real allocator
  // without hashing all 16 million candidates in a unit test.
  const rest = h.range(0x1000000);
  assert.equal(rest.startNonce, 0xff000040); assert.equal(rest.count, 0xffffbe);
  assert.equal(first.count + wrapped.count + rest.count, 0x1000000);
  assert.equal(h.range(1), null, 'exhaustion waits for a fresh job rather than repeating work');
  assert.equal(job._nonceRemaining, 0);
});
test('ordinary ranges safely cross the 32-bit boundary and exhaust exactly once', () => {
  const h = nonceHarness(0xfffffffd / 0x100000000); h.prepare(false, 0);
  const first = h.range(64), second = h.range(0x100000000);
  assert.equal(first.startNonce, 0xfffffffe); assert.equal(first.count, 2);
  assert.equal(second.startNonce, 0); assert.equal(second.count, 0xfffffffe);
  assert.equal(h.range(1), null);
});
test('single-thread and parallel mining hash assigned nonces at the 24-bit boundary', () => {
  for (const parallel of [false, true]) {
    const h = nonceHarness(); const job = h.prepare(true, 0xab);
    job._nonce = 0xfffffd; job._nonceRemaining = 4;
    Object.assign(job, { job_id: 'boundary', _seq: 7, _targetBytes: new Uint8Array(8), _targetDiff: '1' });
    const heap = new Uint8Array(512);
    heap[324] = 255; // A hash above the zero target, so this stub reports no shares.
    h.context.engine = { HEAPU8: heap };
    h.context.captureHash = (_vm, pointer, length) => {
      assert.equal(length, 76); h.hashes.push(Array.from(heap.slice(pointer + 39, pointer + 43)));
    };
    h.context.captureBatch = (ctx, pointer, length, target, offset, start, count) => {
      assert.equal(offset, 39); assert.equal(length, 76);
      assert.equal(heap[pointer + 42], 0xab);
      assert.equal(start >>> 24, 0xab);
      assert.equal((start + count - 1) >>> 24, 0xab, 'native range stays in its assigned prefix');
      h.batches.push({ start, count }); return count;
    };
    h.run(`Module = engine; vm = 1; currentJob = job; mining = true;
      fullMemory = ${parallel}; datasetThreads = 32; mineCtx = 1;
      inputPtr = 0; hashPtr = 300; targetPtr = 340; mineResultPtr = 400;
      api = { calculate_hash: captureHash, mine_batch_context: captureBatch };`);
    h.run('mineLoop()');
    while (h.timers.length) h.timers.shift()();
    if (parallel) assert.deepEqual(h.batches, [{ start: 0xabfffffe, count: 2 }, { start: 0xab000000, count: 2 }]);
    else assert.deepEqual(h.hashes, [[254, 255, 255, 171], [255, 255, 255, 171], [0, 0, 0, 171], [1, 0, 0, 171]]);
    assert.equal(h.run('mining'), false);
    assert.equal(h.messages.at(-1).type, 'nonce_exhausted');
    assert.equal(h.messages.at(-1).job_seq, 7);
    assert.equal(h.timers.length, 0, 'no busy loop while waiting for a new job');
  }
});
test('worker slots tile a negotiated prefix disjointly; each span wraps and exhausts on its own', () => {
  const span = 5592405, ends = []; // floor(2^24 / 3); the last slot takes the remainder
  for (let slot = 0; slot < 3; slot++) {
    const h = nonceHarness(0, slot, 3); const job = h.prepare(true, 0xab);
    const base = slot * span, len = slot === 2 ? 0x1000000 - 2 * span : span;
    assert.equal(job._nonceBase, base); assert.equal(job._nonceSpace, len); assert.equal(job._nonce, 0);
    const first = h.range(0x1000000), wrapped = h.range(0x1000000);
    assert.deepEqual(first, { startNonce: 0xab000000 + base + 1, count: len - 1 });
    assert.deepEqual(wrapped, { startNonce: 0xab000000 + base, count: 1 });
    assert.equal(h.range(1), null, 'a slot exhausts on its own');
    for (const r of [first, wrapped]) {
      assert.equal(r.startNonce >>> 24, 0xab); assert.equal((r.startNonce + r.count - 1) >>> 24, 0xab);
    }
    ends.push([base, base + len]);
  }
  assert.deepEqual(ends, [[0, span], [span, 2 * span], [2 * span, 0x1000000]]);
  // Batches stop at the span edge (inside the prefix, or at its boundary for
  // the last span), then wrap to the span base rather than the prefix base.
  for (const slot of [1, 2]) {
    const h = nonceHarness(0, slot, 3); const job = h.prepare(true, 0xab);
    job._nonce = job._nonceSpace - 3;
    assert.deepEqual(h.range(64), { startNonce: 0xab000000 + job._nonceBase + job._nonceSpace - 2, count: 2 });
    assert.deepEqual(h.range(64), { startNonce: 0xab000000 + job._nonceBase, count: 64 });
  }
  assert.equal(0xab000000 + 2 * span + (0x1000000 - 2 * span) - 2, 0xabfffffe);
});
test('worker slots split the ordinary 32-bit space and ignore the blob prefix', () => {
  const h = nonceHarness(0, 3, 4); const job = h.prepare(false, 0xab);
  assert.equal(job._nonceBase, 0xc0000000); assert.equal(job._nonceSpace, 0x40000000);
  assert.equal(h.range(1).startNonce, 0xc0000001);
  job._nonce = 0x3ffffffd;
  assert.deepEqual(h.range(64), { startNonce: 0xfffffffe, count: 2 });
  assert.deepEqual(h.range(64), { startNonce: 0xc0000000, count: 64 }, 'wraps inside the span, never to 0');
  const t = nonceHarness(0.5, 2, 3); const last = t.prepare(false, 0xab);
  assert.equal(last._noncePrefix, 0);
  assert.equal(last._nonceBase, 2863311530); assert.equal(last._nonceSpace, 1431655766);
  const first = t.range(1), rest = t.range(0x100000000), wrapped = t.range(0x100000000);
  assert.equal(first.startNonce, 2863311530 + 715827883 + 1);
  assert.equal(rest.startNonce + rest.count - 1, 0xffffffff, 'the last span ends at 2^32');
  assert.equal(wrapped.startNonce, 2863311530);
  assert.equal(first.count + rest.count + wrapped.count, 1431655766);
  assert.equal(t.range(1), null);
});
test('parallel mining keeps batches inside the worker slot and reports its exhaustion', () => {
  for (const slot of [0, 1]) {
    const h = nonceHarness(0, slot, 2); const job = h.prepare(true, 0xab);
    const lo = 0xab000000 + slot * 0x800000, hi = lo + 0x800000;
    job._nonce = job._nonceSpace - 3; job._nonceRemaining = 4;
    Object.assign(job, { job_id: 'slot', _seq: 9, _targetBytes: new Uint8Array(8), _targetDiff: '1' });
    const heap = new Uint8Array(512);
    h.context.engine = { HEAPU8: heap };
    h.context.captureBatch = (ctx, pointer, length, target, offset, start, count) => {
      assert.equal(heap[pointer + 42], 0xab);
      assert.ok(start >= lo && start + count <= hi, 'native range stays in the worker slot');
      h.batches.push({ start, count }); return count;
    };
    h.run(`Module = engine; vm = 1; currentJob = job; mining = true;
      fullMemory = true; datasetThreads = 32; mineCtx = 1;
      inputPtr = 0; hashPtr = 300; targetPtr = 340; mineResultPtr = 400;
      api = { mine_batch_context: captureBatch };`);
    h.run('mineLoop()');
    while (h.timers.length) h.timers.shift()();
    assert.deepEqual(h.batches, [{ start: hi - 2, count: 2 }, { start: lo, count: 2 }]);
    assert.equal(h.run('mining'), false);
    assert.deepEqual({ ...h.messages.at(-1) }, { type: 'nonce_exhausted', job_id: 'slot', job_seq: 9 });
    assert.equal(h.timers.length, 0);
  }
});
test('embed asset bootstraps select the worker build without a query string', () => {
  for (const build of [undefined, 'st']) {
    const imports = [];
    const context = vm.createContext({ importScripts: url => imports.push(url), self: { location: {},
      __randomxAssets: { baseURL: 'https://cdn.example/rx/', glueURL: 'blob:glue', build } } });
    vm.runInContext(readFileSync(require.resolve('../public/worker.js'), 'utf8'), context);
    assert.deepEqual(imports, ['blob:glue']);
    assert.equal(vm.runInContext('stBuild', context), build === 'st');
  }
  const imports = [];
  vm.runInContext(readFileSync(require.resolve('../public/worker.js'), 'utf8'),
    vm.createContext({ importScripts: url => imports.push(url), self: { location: { search: '?v=abc&build=st' } } }));
  assert.deepEqual(imports, ['randomx_st.js?v=abc']);
});
test('a blob-bootstrapped st worker loads its WASM and fb_full.js from the asset base', async () => {
  const imports = [], posted = [];
  let engine;
  const context = vm.createContext({ console, setTimeout, URL, postMessage: msg => posted.push(msg),
    self: { location: {}, __randomxAssets: { baseURL: 'https://cdn.example/rx/', glueURL: 'blob:glue', build: 'st' } },
    importScripts(url) {
      imports.push(url);
      if (url.endsWith('fb_full.js')) context.RxFbFull = { FbWorker: class { constructor(host) { context.fbHost = host; } } };
    },
    createRandomX: async options => { engine = options; return { cwrap: () => () => 0, _malloc: () => 0 }; } });
  vm.runInContext(readFileSync(require.resolve('../public/worker.js'), 'utf8'), context);
  await vm.runInContext("init({ fullMemory: false, enableJit: false, fbRole: 'full', nonceSlot: 1, nonceSlots: 3 })", context);
  assert.equal(engine.locateFile('randomx_st.wasm'), 'https://cdn.example/rx/randomx_st.wasm');
  assert.equal(engine.mainScriptUrlOrBlob, 'blob:glue');
  assert.deepEqual(imports, ['blob:glue', 'https://cdn.example/rx/fb_full.js']);
  assert.equal(context.fbHost.full, true); assert.equal(vm.runInContext('`${nonceSlot}/${nonceSlots}`', context), '1/3');
  assert.equal(posted.at(-1).type, 'ready');
});
