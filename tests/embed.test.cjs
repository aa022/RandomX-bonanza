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
function harness(options = {}) {
  const win = new Target();
  const doc = new Target();
  doc.currentScript = null; doc.readyState = 'complete'; doc.hidden = false;
  const sockets = [], workers = [], downloads = [], timers = new Map(), revoked = [], reports = [];
  doc.permissionsPolicy = options.permissionsPolicy;
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
    constructor(url) {
      if (options.workerError) throw new Error(options.workerError);
      this.url = url; this.sent = []; this.terminated = false; workers.push(this);
    }
    postMessage(msg) { this.sent.push(msg); }
    terminate() { this.terminated = true; }
    message(msg) { this.onmessage?.({ data: msg }); }
  }
  class BrowserURL extends URL {
    static createObjectURL() { return 'blob:http://localhost/' + ++blobId; }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  win.Worker = Worker; win.WebAssembly = WebAssembly;
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
  return { win, doc, sockets, workers, downloads, timers, revoked, reports,
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
  assert.equal(h.win.RandomXEmbed.limits({ mode: 'light' }, safari).maxThreads, 1);
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
    login: 'own-wallet', pass: 'own-worker', rigid: 'own-worker', agent: 'randomx-embed/0.2.1', algo: ['rx/0'] } }]);
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
