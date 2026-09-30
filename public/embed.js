/* RandomX bonanza embed. Mining is session-only and starts after consent.
 * See README.md for the headless API, consent events and deployment headers. */
(function (global) {
  'use strict';
  if (global.RandomXEmbed) return;
  const script = document.currentScript;
  const defaultBase = new URL('.', script && script.src || location.href).href;
  const ownerKey = Symbol.for('randomx.bonanza.active-session');
  const VERSION = '0.2.1';
  const MAX_WORKLOAD = 80;

  function number(value, fallback, label) {
    if (value === undefined || value === '') return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(label + ' must be a finite number');
    return n;
  }

  function configure(input) {
    const wallet = String(input.wallet || '').trim();
    const pool = String(input.pool || '').trim();
    if (!wallet || wallet.length > 256 || /[\s<>]/.test(wallet)) throw new Error('Enter a wallet address');
    if (!pool || pool.length > 253 || /[\s/<>]/.test(pool)) throw new Error('Enter a pool hostname');
    const port = number(input.port, 3333, 'Port');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1–65535');
    const requestedWorkload = number(input.workload, 50, 'Workload');
    if (requestedWorkload < 0 || requestedWorkload > 100) throw new Error('Workload must be a percentage from 0 to 100');
    const workload = Math.min(MAX_WORKLOAD, requestedWorkload);
    const proxy = new URL(input.proxy || (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    if (!['ws:', 'wss:'].includes(proxy.protocol) || proxy.username || proxy.password || proxy.hash) {
      throw new Error('Proxy must be a ws:// or wss:// URL without credentials or a fragment');
    }
    if (location.protocol === 'https:' && proxy.protocol !== 'wss:') throw new Error('HTTPS pages require a wss:// proxy');
    const base = new URL(input.assetBase || defaultBase, location.href);
    if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Assets require HTTP or HTTPS');
    if (location.protocol === 'https:' && base.protocol !== 'https:') throw new Error('HTTPS pages require HTTPS assets');
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    base.search = ''; base.hash = '';
    if (input.mode && !['full', 'light'].includes(input.mode)) throw new Error('Mode must be full or light');
    if (input.routeQuery !== undefined && typeof input.routeQuery !== 'boolean') throw new Error('routeQuery must be a boolean');
    if (input.nonceMode !== undefined && !['auto', 'nicehash'].includes(input.nonceMode)) throw new Error('nonceMode must be auto or nicehash');
    if (input.keepalive !== undefined && !['auto', 'required'].includes(input.keepalive)) throw new Error('keepalive must be auto or required');
    return Object.freeze({ wallet, pool, port, proxy: proxy.href, assetBase: base.href,
      workerName: String(input.workerName || 'embed').slice(0, 64), workload,
      mode: input.mode || 'full', routeQuery: input.routeQuery !== false,
      nonceMode: input.nonceMode || 'auto', keepalive: input.keepalive || 'auto',
      headless: input.headless === true, quickstart: input.quickstart === true,
      container: input.container, nonce: input.nonce || (script && script.nonce) || '' });
  }

  function limits(config, nav = navigator) {
    const reported = Number(nav.hardwareConcurrency);
    // An unknown topology gets a single mining thread; a reported one-core
    // device gets none, since one thread would violate the 80% cap.
    const cores = Number.isFinite(reported) && reported >= 1 ? Math.floor(reported) : 2;
    const architecture = String(nav.architecture || '');
    const platform = String(nav.platform || (nav.userAgentData && nav.userAgentData.platform) || '');
    const arm = architecture ? /^(arm|aarch64)/i.test(architecture) :
      /arm|aarch64|iPhone|iPad|iPod/i.test(String(nav.userAgent || '') + ' ' + platform) || /Mac/.test(platform);
    const workloadCap = arm ? 50 : MAX_WORKLOAD;
    const maxThreads = Math.min(32, Math.floor(cores * workloadCap / 100), config.mode === 'light' ? 1 : 32);
    return Object.freeze({ cores, maxThreads, maxPercentage: maxThreads / cores * 100,
      workloadCap,
      initThreads: 32 });
  }

  function diagnose() {
    let isolationAllowed = null;
    try {
      const policy = document.permissionsPolicy || document.featurePolicy;
      if (policy && typeof policy.features === 'function' && policy.features().includes('cross-origin-isolated')) {
        isolationAllowed = policy.allowsFeature('cross-origin-isolated');
      }
    } catch (_) {}
    const checks = Object.freeze({ secureContext: global.isSecureContext === true,
      crossOriginIsolated: global.crossOriginIsolated === true,
      sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
      workers: typeof global.Worker === 'function', webAssembly: !!global.WebAssembly,
      isolationAllowed, embedded: !!global.top && global.top !== global });
    const issues = [];
    const add = (code, message, hints) => issues.push(Object.freeze({ code, message, hints: Object.freeze(hints) }));
    if (!checks.secureContext) add('INSECURE_CONTEXT', 'This page is not a secure context.',
      ['Serve the embedding page over HTTPS. Trusted localhost is suitable for local browser testing.']);
    if (!checks.crossOriginIsolated) add('CROSS_ORIGIN_ISOLATION', 'This page is not cross-origin isolated.',
      ['Check the HTML response: Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp.',
       'Set these on the embedding page, not just the CDN or WebSocket bridge. Reload after fixing the headers.',
       ...(checks.embedded ? ['For an iframe, the parent page must also provide isolation and allow cross-origin-isolated for the frame.'] : [])]);
    if (checks.isolationAllowed === false) add('PERMISSIONS_POLICY', 'Permissions Policy denies cross-origin isolation.',
      ['Allow cross-origin-isolated for this page (for example, Permissions-Policy: cross-origin-isolated=(self)); check parent/frame delegation if embedded.']);
    if (checks.crossOriginIsolated && !checks.sharedArrayBuffer) add('SHARED_MEMORY_UNAVAILABLE', 'SharedArrayBuffer is unavailable in this browser.',
      ['Use a browser with shared WebAssembly memory support; inspect browser restrictions and Permissions Policy.']);
    if (!checks.workers || !checks.webAssembly) add('ENGINE_UNSUPPORTED', 'Worker or WebAssembly support is unavailable.',
      ['Use a browser with Web Workers, WebAssembly and shared memory support.']);
    return Object.freeze({ supported: issues.length === 0, checks, issues: Object.freeze(issues) });
  }

  function safeResource(value) {
    if (String(value).startsWith('blob:')) return 'blob:';
    try {
      const url = new URL(value);
      url.search = ''; url.hash = ''; url.username = ''; url.password = '';
      return url.href;
    } catch (_) { return String(value || '').slice(0, 200); }
  }

  // Installed in our control worker and every pthread before loading glue.
  // Workers have their own CSP violation events; forward only enforced ones.
  function workerPolicyReporter() {
    if (self.__rxPolicyReporter) return;
    self.__rxPolicyReporter = true;
    self.addEventListener('securitypolicyviolation', event => {
      if (event.disposition !== 'enforce') return;
      self.postMessage({ type: 'rx:policy-error', effectiveDirective: event.effectiveDirective,
        blockedURI: event.blockedURI, disposition: event.disposition });
    });
  }

  function diagnosticText(error) {
    if (!error) return '';
    return `[${error.code}] ${error.message}\n` +
      (error.directive ? `Blocked directive: ${error.directive}\n` : '') +
      (error.resource ? `Resource: ${error.resource}\n` : '') +
      error.hints.map(hint => '\n• ' + hint).join('') +
      '\n\nBrowser checks: ' + JSON.stringify(error.checks);
  }

  const css = `
    :host{all:initial;display:block;color-scheme:light dark;font:13px 'SF Mono',Menlo,monospace;color:#1a1815}
    *{box-sizing:border-box} .widget{max-width:600px;border:1px solid #1a1815;background:#fefefc;color:#1a1815;
    font-variant-numeric:tabular-nums;box-shadow:5px 5px 0 #ffcfde} header{padding:12px 16px;border-bottom:1px solid #a8a59c;
    letter-spacing:.22em;font-size:11px;text-transform:uppercase;display:flex;justify-content:space-between;gap:12px}
    .body{padding:16px}p{line-height:1.65;margin:0 0 12px} .details{font-size:11px;overflow-wrap:anywhere;color:#4a4640}
    .stats{display:grid;grid-template-columns:100px 1fr;gap:8px;margin:14px 0} .stats span:nth-child(odd){color:#4a4640}
    .bar{letter-spacing:.08em;color:#ff3b8a;overflow:hidden;white-space:nowrap;margin:12px 0}label{display:block;line-height:1.6}
    .consent{margin:14px 0}input[type=range]{width:100%;accent-color:#ff3b8a} input[type=checkbox]{accent-color:#ff3b8a}
    button{font:inherit;cursor:pointer;border:1px solid #6e6b62;background:transparent;color:inherit;padding:8px 12px}
    button:hover{color:#ff3b8a}button:disabled{opacity:.45;cursor:default}button:focus-visible,input:focus-visible{outline:2px solid #ff3b8a;outline-offset:3px}
    .controls{display:flex;gap:10px;margin-top:14px}.status{font-size:11px;min-height:2.5em;margin-top:14px;overflow-wrap:anywhere}
    .diagnostics{font-size:11px;margin-top:12px;border-top:1px solid #a8a59c;padding-top:10px}
    .diagnostics summary{cursor:pointer}.diagnostics pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6}
    .mini{border:0;padding:0;font-size:11px}.collapsed .body{display:none}.summary{padding:12px 16px;display:flex;gap:14px;align-items:center}
    .summary[hidden]{display:none}.summary .rate{flex:1}.summary button{font-size:11px;padding:5px 8px}
    @media(prefers-color-scheme:dark){.widget{background:#1a1815;color:#f2ede4;border-color:#888579;box-shadow:5px 5px 0 #4b2839}
    .details,.stats span:nth-child(odd){color:#c0b9aa}}
  `;

  function create(input = {}) {
    const config = configure(input);
    let budget = limits(config);
    const listeners = new Map();
    let requestedPercentage = config.workload;
    let percentage = Math.min(requestedPercentage, budget.workloadCap);
    let destroyed = false;
    let epoch = 0;
    let consentTicket = 0;
    let session = null;
    let policyAttempt = null;
    let retryTimer = null;
    let attempt = 0;
    let widget = null;
    let controls = null;
    let unbind = () => {};
    let removeQuickstart = () => {};
    let lastJob = null;
    let jobSeq = 0;
    let minerId = null;
    let requestId = 1;
    const pendingRequests = new Map();
    let state = { running: false, phase: 'idle', status: 'Waiting for consent', hashrate: 0,
      accepted: 0, rejected: 0, progress: 0, retries: 0, error: null };
    const architectureReady = navigator.userAgentData && navigator.userAgentData.getHighEntropyValues ?
      navigator.userAgentData.getHighEntropyValues(['architecture']).then(({ architecture }) => {
        if (destroyed) return;
        budget = limits(config, { hardwareConcurrency: navigator.hardwareConcurrency,
          userAgent: navigator.userAgent, platform: navigator.platform,
          userAgentData: navigator.userAgentData, architecture });
        percentage = Math.min(state.phase === 'consent' ? percentage : requestedPercentage, budget.workloadCap);
        if (controls && controls.disclosure) controls.disclosure.textContent = disclosure();
        update({});
      }).catch(() => {}) : Promise.resolve();

    function threads() {
      return Math.min(budget.maxThreads, Math.floor(budget.cores * percentage / 100 + 1e-9));
    }
    function snapshot() {
      return Object.freeze({ ...state, workload: percentage, threads: threads(),
        effectivePercentage: threads() / budget.cores * 100, nicehash: !!(session && session.nicehash), limits: budget, config });
    }
    function emit(name, detail) {
      for (const fn of listeners.get(name) || []) { try { fn(detail); } catch (error) { console.error(error); } }
      document.dispatchEvent(new CustomEvent('randomx:' + name, { detail: { ...detail, instance: api } }));
    }
    function update(patch) {
      state = { ...state, ...patch };
      if (controls) {
        if (controls.status) controls.status.textContent = state.status;
        if (controls.hashrate) controls.hashrate.textContent = state.hashrate.toFixed(0) + ' H/s';
        if (controls.diagnostics) controls.diagnostics.textContent = diagnosticText(state.error);
        if (controls.start) controls.start.disabled = state.running || !budget.maxThreads;
        if (controls.stop) controls.stop.disabled = !state.running && state.phase !== 'consent';
        if (controls.workload) {
          controls.workload.max = String(budget.workloadCap);
          controls.workload.value = String(percentage);
        }
      }
      emit('state', snapshot());
    }
    function fail(issue) {
      if (destroyed) return;
      const report = Object.freeze({ ...issue, hints: Object.freeze(issue.hints || []), checks: diagnose().checks });
      const attempt = ['ASSET_DOWNLOAD_FAILED', 'ENGINE_WORKER_FAILED', 'CSP_BLOCKED'].includes(report.code) ? policyAttempt : null;
      stop(report.message);
      // Keep only resource/stage metadata so a delayed document CSP event
      // can explain a generic fetch/worker failure. Explicit Stop clears it.
      policyAttempt = attempt;
      update({ phase: 'error', status: report.message, error: report });
      console.error('[RandomXEmbed]', report);
      emit('error', report);
    }
    function policyViolation(event, ownedWorker = false) {
      if (destroyed || event.disposition !== 'enforce' || !policyAttempt || (!session && state.phase !== 'error')) return;
      const directive = event.effectiveDirective || '';
      const uri = String(event.blockedURI || '');
      const assetOrigin = new URL(config.assetBase).origin;
      const proxyOrigin = new URL(config.proxy).origin;
      let related = ownedWorker || policyAttempt.urls.includes(uri) || uri === policyAttempt.assetURL;
      // Cross-origin CSP reports may reveal only the resource's origin.
      related ||= (uri === assetOrigin || uri === assetOrigin + '/') && ['assets', 'worker'].includes(policyAttempt.stage);
      related ||= uri === 'blob' && /worker-src|child-src/.test(directive) && policyAttempt.stage === 'worker';
      related ||= policyAttempt.stage === 'transport' && directive === 'connect-src' &&
        (uri === proxyOrigin || uri === proxyOrigin + '/' || safeResource(uri) === safeResource(config.proxy));
      if (!related) return;
      let hints;
      if (/worker-src|child-src/.test(directive) || uri === 'blob') {
        hints = ["Allow page-owned workers with worker-src 'self' blob: (merge this into the site's CSP)."];
      } else if (uri === 'wasm-eval' || uri === 'eval') {
        hints = ["Allow WebAssembly compilation with script-src 'wasm-unsafe-eval'. Older browser implementations may require 'unsafe-eval'."];
      } else if (directive === 'connect-src') {
        hints = [`Allow engine downloads from ${assetOrigin} and the WebSocket bridge ${proxyOrigin} in connect-src.`];
      } else {
        hints = [`Allow engine scripts from ${assetOrigin} and blob: in script-src; check the CSP inherited by workers.`];
      }
      fail({ code: 'CSP_BLOCKED', stage: policyAttempt.stage, directive, resource: safeResource(uri),
        message: 'Content Security Policy blocked the mining engine (' + directive + ').', hints });
    }
    function workerFailure(message, stage = 'worker') {
      fail({ code: 'ENGINE_WORKER_FAILED', stage, message,
        hints: ["Check worker-src 'self' blob:, script-src for the asset origin and 'wasm-unsafe-eval', and asset CORS/CORP.",
          'Serve matching runtime/worker/WASM files from the same build. Full mode needs about 2.5 GiB of RAM.',
          'The browser did not identify a single cause; inspect its console and network errors.'] });
    }
    function disclosure() {
      return `Mine Monero for wallet ${config.wallet} via ${config.pool}:${config.port} (bridge ${config.proxy}). ` +
        `Mining uses ${threads()} of ${budget.cores} reported CPU cores (${(threads() / budget.cores * 100).toFixed(1)}%), ` +
        `at most ${budget.maxThreads}. Dataset initialization uses 32 threads. ` +
        (config.mode === 'full' ? 'Full mode needs about 2.5 GiB of RAM. ' : 'Light mode needs about 256 MiB of RAM. ') +
        'This uses electricity and can heat your device or drain its battery. Stop at any time. ' +
        'Mining continues in background tabs until you stop it or leave this page; your browser may throttle or suspend it.';
    }
    function supportCheck() {
      if (!budget.maxThreads) throw new Error('This device has no mining threads within the configured core limit');
      if (!threads()) throw new Error('Increase workload enough to allow at least one mining thread');
      const report = diagnose();
      if (!report.supported) throw Object.assign(new Error('This page cannot run the multithreaded mining engine.'), {
        code: 'DEPLOYMENT_UNSUPPORTED', hints: report.issues.flatMap(issue => [issue.message, ...issue.hints]) });
      if (document.hidden) throw new Error('Keep the page visible to start mining');
    }
    function isCurrent(s) { return !destroyed && state.running && session === s && s.epoch === epoch; }
    function send(s, message) {
      if (isCurrent(s) && s.ws && s.ws.readyState === WebSocket.OPEN) {
        const text = JSON.stringify(message);
        if (new Blob([text]).size > 4096) {
          fail({ code: 'FRAME_TOO_LARGE', stage: 'transport', message: 'Mining request exceeds the 4096-byte frame limit.',
            hints: ['Check the proxy job ID and login fields. Each request must fit in one JSON text frame.'] }); return;
        }
        s.ws.send(text);
      }
    }
    function request(s, method, params, kind) {
      const id = ++requestId;
      pendingRequests.set(id, { kind, sentAt: Date.now() });
      send(s, { id, jsonrpc: '2.0', method, params });
    }
    function clearConnection(s, closeReason = 'Transport reset') {
      clearTimeout(s.connectTimer); clearTimeout(s.errorTimer); clearInterval(s.heartbeat);
      s.connectTimer = s.errorTimer = s.heartbeat = null;
      s.nicehash = false;
      if (s.ws) {
        const ws = s.ws;
        s.ws = null;
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        try { ws.close(1000, closeReason); } catch (_) {}
      }
      minerId = null;
      lastJob = null;
      pendingRequests.clear();
      if (s.worker) s.worker.postMessage({ type: 'stop' });
    }
    function reconnect(s, reason) {
      if (!isCurrent(s) || retryTimer) return;
      clearConnection(s);
      const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5));
      update({ phase: 'reconnecting', status: `${reason}. Retrying in ${delay / 1000}s…`,
        hashrate: 0, retries: state.retries + 1 });
      retryTimer = setTimeout(() => { retryTimer = null; connect(s); }, delay);
    }
    function handleJob(s, job) {
      // Refuse malformed jobs before sending them into native/WASM buffers.
      if (!job || typeof job.job_id !== 'string' || typeof job.blob !== 'string' ||
          !/^[\da-f]{86,512}$/i.test(job.blob) || job.blob.length % 2 ||
          typeof job.seed_hash !== 'string' || !/^[\da-f]{64}$/i.test(job.seed_hash) ||
          typeof job.target !== 'string' || !/^(?:[\da-f]{8}|[\da-f]{16}|[\da-f]{64})$/i.test(job.target)) {
        reconnect(s, 'Pool supplied an invalid RandomX job'); return false;
      }
      const seed = job.seed_hash.toLowerCase();
      if (s.datasetSeed !== seed) {
        s.datasetSeed = seed;
        s.datasetReady = false;
        update({ progress: 0 });
      }
      lastJob = { type: 'job', blob: job.blob, seed_hash: seed, target: job.target,
        job_id: job.job_id, job_seq: ++jobSeq, nicehash: s.nicehash };
      if (s.ready) s.worker.postMessage(lastJob);
      update({ phase: s.datasetReady ? 'mining' : 'initializing', status: s.datasetReady ? 'Mining' : 'Building dataset (32 initialization threads)…' });
      return true;
    }
    function connect(s) {
      if (!isCurrent(s)) return;
      clearConnection(s);
      update({ phase: 'connecting', status: 'Connecting to pool bridge…' });
      let ws;
      try {
        const url = new URL(config.proxy);
        if (config.routeQuery) {
          url.searchParams.set('pool', config.pool);
          url.searchParams.set('port', String(config.port));
        }
        ws = new WebSocket(url.href);
      } catch (error) { reconnect(s, error.message); return; }
      s.ws = ws;
      const current = () => isCurrent(s) && s.ws === ws;
      s.connectTimer = setTimeout(() => { if (current()) reconnect(s, 'Connection or login timed out'); }, 15000);
      s.keepalive = false;
      requestId = 1;
      ws.onopen = () => {
        if (!current()) return;
        send(s, { id: 1, jsonrpc: '2.0', method: 'login', params: { login: config.wallet,
          pass: config.workerName, rigid: config.workerName, agent: 'randomx-embed/' + VERSION, algo: ['rx/0'] } });
        s.heartbeat = setInterval(() => {
          if (!current()) return;
          if ([...pendingRequests.values()].some(item => Date.now() - item.sentAt > 45000)) {
            reconnect(s, 'Pool response timed out'); return;
          }
          if (minerId !== null && s.keepalive && (config.keepalive === 'required' ||
              ![...pendingRequests.values()].some(item => item.kind === 'keepalive'))) {
            request(s, 'keepalived', { id: minerId }, 'keepalive');
          }
        }, 15000);
      };
      ws.onmessage = ({ data }) => {
        if (!current()) return;
        let msg;
        try { msg = JSON.parse(data); } catch (_) { reconnect(s, 'Invalid bridge response'); return; }
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) { reconnect(s, 'Invalid bridge response'); return; }
        if (pendingRequests.has(msg.id)) {
          const pending = pendingRequests.get(msg.id);
          pendingRequests.delete(msg.id);
          if (pending.kind === 'keepalive') {
            if (msg.error && (msg.error.code === -32601 || /not supported|unknown method|method not found/i.test(msg.error.message || msg.error))) {
              if (config.keepalive === 'required') fail({ code: 'KEEPALIVE_UNSUPPORTED', stage: 'transport',
                message: 'Proxy rejected the required keepalived RPC.', hints: ['Use auto keepalive only if this proxy allows idle sessions without that RPC.'] });
              else s.keepalive = false;
            } else if (msg.error) reconnect(s, msg.error.message || 'Pool keepalive failed');
          } else update(msg.error ? { rejected: state.rejected + 1 } : { accepted: state.accepted + 1 });
          return;
        }
        if (msg.error) {
          const message = typeof msg.error === 'string' ? msg.error : msg.error.message || 'Pool error';
          if (msg.id === 1) fail({ code: 'LOGIN_REJECTED', stage: 'login', message,
            hints: ['Check the configured wallet and the proxy login policy, then request a new session after correcting them.'] });
          else reconnect(s, message);
          return;
        }
        if (msg.id === 1) {
          // The bridge may use an upstream token or a browser-local token.
          // Treat it as opaque, but require a usable ID before mining work.
          if (minerId !== null) return;
          const id = msg.result && msg.result.id;
          if (!((typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isFinite(id)))) {
            reconnect(s, 'Pool login supplied an invalid session ID'); return;
          }
          minerId = msg.result.id;
          s.keepalive = config.keepalive === 'required' || (Array.isArray(msg.result.extensions) && msg.result.extensions.includes('keepalive'));
          s.nicehash = config.nonceMode === 'nicehash' || (Array.isArray(msg.result.extensions) && msg.result.extensions.includes('nicehash'));
          if (handleJob(s, msg.result.job)) {
            clearTimeout(s.connectTimer); s.connectTimer = null;
            attempt = 0;
          }
        } else if (msg.method === 'job' && minerId !== null) handleJob(s, msg.params);
      };
      ws.onclose = (event = {}) => {
        if (!current()) return;
        if ([1008, 4001].includes(event.code)) fail({ code: 'PROXY_SESSION_REJECTED', stage: 'transport',
          closeCode: event.code, message: event.reason || 'Proxy ended the session (code ' + event.code + ').',
          hints: ['Check the proxy policy and login configuration before requesting a new session.'] });
        else reconnect(s, event.reason || 'Bridge disconnected');
      };
      ws.onerror = () => {
        // Give the close event a chance to expose a terminal policy code.
        if (current() && !s.errorTimer) s.errorTimer = setTimeout(() => {
          s.errorTimer = null;
          if (current()) reconnect(s, 'Bridge connection failed');
        }, 250);
      };
    }
    function workerMessage(s, msg) {
      if (!isCurrent(s)) return;
      if (msg.type === 'rx:policy-error') { policyViolation(msg, true); return; }
      if (msg.type === 'rx:thread-create') {
        if (s.children.size >= 32 || msg.url !== s.glueURL) { stop('Unexpected engine thread request'); return; }
        try {
          const child = new Worker(msg.url, msg.options);
          s.children.set(msg.id, child);
          child.onmessage = ({ data }) => {
            if (!isCurrent(s)) return;
            if (data.type === 'rx:policy-error') policyViolation(data, true);
            else s.worker.postMessage({ type: 'rx:thread-event', id: msg.id, event: 'message', data });
          };
          child.onerror = (event) => {
            if (isCurrent(s)) workerFailure('Engine thread failed: ' + (event.message || 'unknown error'), 'pthread');
          };
        } catch (error) { workerFailure('Cannot create engine thread: ' + error.message, 'pthread'); }
        return;
      }
      if (msg.type === 'rx:thread-post') {
        const child = s.children.get(msg.id);
        if (child) child.postMessage(msg.data, msg.transfer || []);
        return;
      }
      if (msg.type === 'rx:thread-terminate') {
        const child = s.children.get(msg.id);
        if (child) child.terminate();
        s.children.delete(msg.id); return;
      }
      if (msg.type === 'ready') { s.ready = true; policyAttempt.stage = 'transport'; connect(s); }
      else if (msg.type === 'hashrate' && s.ws && s.ws.readyState === WebSocket.OPEN && lastJob) {
        update({ hashrate: Number.isFinite(msg.rate) ? msg.rate : 0, phase: 'mining', status: 'Mining' });
      } else if (msg.type === 'share' && lastJob && msg.job_id === lastJob.job_id && msg.job_seq === lastJob.job_seq && minerId !== null && s.ws && s.ws.readyState === WebSocket.OPEN) {
        request(s, 'submit', { id: minerId, job_id: msg.job_id, nonce: msg.nonce, result: msg.result }, 'share');
      } else if (msg.type === 'dataset_progress') {
        s.datasetReady = msg.done >= msg.total;
        update({ progress: Math.max(0, Math.min(1, msg.done / msg.total)),
          status: s.datasetReady ? 'Dataset ready' : `Building dataset: ${(msg.done / msg.total * 100).toFixed(0)}% (32 threads)` });
      } else if (msg.type === 'nonce_exhausted' && lastJob && msg.job_id === lastJob.job_id && msg.job_seq === lastJob.job_seq) {
        update({ hashrate: 0, phase: 'waiting', status: 'Nonce range exhausted — waiting for a new pool job' });
      } else if (msg.type === 'mode') { s.datasetReady = true; }
      else if (msg.type === 'error') workerFailure('Engine error: ' + msg.message, 'engine');
      else if (msg.type === 'status' && state.phase !== 'reconnecting') update({ status: msg.message });
    }
    async function begin() {
      if (destroyed || state.running) return;
      const ticket = consentTicket;
      const approvedWorkload = percentage;
      await architectureReady;
      if (destroyed || state.running || ticket !== consentTicket) return;
      percentage = Math.min(approvedWorkload, budget.workloadCap);
      try { supportCheck(); } catch (error) {
        fail({ code: error.code || 'START_UNAVAILABLE', stage: 'preflight', message: error.message, hints: error.hints }); return;
      }
      if (global[ownerKey] && global[ownerKey] !== api) {
        update({ phase: 'error', status: 'Another RandomX embed on this page is already running' }); return;
      }
      global[ownerKey] = api;
      attempt = 0;
      const s = { epoch: ++epoch, children: new Map(), urls: [], abort: new AbortController(), ready: false, datasetReady: false };
      session = s;
      policyAttempt = { urls: s.urls, assetURL: new URL('randomx.js', config.assetBase).href, stage: 'assets' };
      update({ running: true, phase: 'loading', status: 'Loading mining engine…', progress: 0, hashrate: 0, error: null });
      try {
        const response = await fetch(new URL('randomx.js', config.assetBase), { signal: s.abort.signal, mode: 'cors', credentials: 'omit' });
        if (!response.ok) throw new Error('Runtime download failed: HTTP ' + response.status);
        const source = await response.text();
        if (!isCurrent(s)) return;
        const monitor = '(' + workerPolicyReporter.toString() + ')();\n';
        s.glueURL = URL.createObjectURL(new Blob([monitor, source], { type: 'application/javascript' }));
        s.urls.push(s.glueURL);
        const bootstrap = monitor + 'self.__randomxAssets=' + JSON.stringify({ baseURL: config.assetBase, glueURL: s.glueURL }) +
          ';importScripts(' + JSON.stringify(new URL('embed-worker.js', config.assetBase).href) + ');';
        const url = URL.createObjectURL(new Blob([bootstrap], { type: 'application/javascript' }));
        s.urls.push(url);
        policyAttempt.stage = 'worker';
        s.worker = new Worker(url);
        s.worker.onmessage = ({ data }) => { try { workerMessage(s, data); } catch (error) { if (isCurrent(s)) workerFailure('Engine message failed: ' + error.message); } };
        s.worker.onerror = (event) => { if (isCurrent(s)) workerFailure('Engine worker failed: ' + (event.message || 'unknown error')); };
        s.worker.onmessageerror = () => { if (isCurrent(s)) workerFailure('Engine message could not be decoded'); };
        s.worker.postMessage({ type: 'init', fullMemory: config.mode === 'full', datasetThreads: threads(),
          datasetInitThreads: 32, enableJit: true, jitProfile: 'auto' });
      } catch (error) {
        if (isCurrent(s)) fail({ code: policyAttempt.stage === 'assets' ? 'ASSET_DOWNLOAD_FAILED' : 'ENGINE_WORKER_FAILED',
          stage: policyAttempt.stage, message: 'Unable to start: ' + error.message,
          hints: policyAttempt.stage === 'assets' ? [
            `Verify ${safeResource(policyAttempt.assetURL)} exists and returns JavaScript, not an HTML error page.`,
            'Check connect-src, asset CORS/CORP, redirects and the HTTP status in the network panel.'] : [
            "Check worker-src 'self' blob: and script-src for engine assets and WebAssembly compilation."] });
      }
    }
    function stop(reason = 'Stopped — consent is required to restart') {
      ++consentTicket; ++epoch;
      clearTimeout(retryTimer); retryTimer = null;
      const s = session;
      session = null;
      policyAttempt = null;
      if (s) {
        s.abort.abort();
        clearConnection(s, 'Session stopped');
        for (const child of s.children.values()) child.terminate();
        s.children.clear();
        if (s.worker) s.worker.terminate();
        s.urls.forEach(url => URL.revokeObjectURL(url));
      }
      if (global[ownerKey] === api) delete global[ownerKey];
      if (controls && controls.consent) controls.consent.checked = false;
      update({ running: false, phase: 'stopped', hashrate: 0, status: reason, error: null });
    }
    function requestConsent(event) {
      if (destroyed || state.running || (event && event.isTrusted !== true)) return false;
      removeQuickstart();
      const ticket = ++consentTicket;
      update({ phase: 'consent', status: 'Waiting for site consent…' });
      // Custom consent belongs to the deployer. No checkbox or dialog is
      // imposed in quickstart/headless mode. A ticket is single-use and is
      // invalidated by Stop, workload changes, hiding, or destruction.
      const detail = Object.freeze({ config, state: snapshot(), disclosure: disclosure(), instance: api,
        accept: () => {
          if (destroyed || ticket !== consentTicket || document.hidden || state.running) return false;
          ++consentTicket; void begin(); return true;
        }, decline: () => { if (ticket === consentTicket) stop('Consent declined'); } });
      for (const fn of listeners.get('consent-request') || []) { try { fn(detail); } catch (error) { console.error(error); } }
      document.dispatchEvent(new CustomEvent('randomx:consent-request', { detail }));
      return true;
    }
    function setWorkload(value) {
      const requested = number(value, 50, 'Workload');
      if (requested < 0 || requested > 100) throw new Error('Workload must be a percentage from 0 to 100');
      requestedPercentage = Math.min(MAX_WORKLOAD, requested);
      const n = Math.min(budget.workloadCap, requestedPercentage);
      if (n === percentage) return;
      stop('Workload changed — confirm consent to restart');
      percentage = n;
      if (controls && controls.disclosure) controls.disclosure.textContent = disclosure();
      update({});
    }
    function bindControls(elements) {
      unbind();
      const resolve = (value) => typeof value === 'string' ? document.querySelector(value) : value;
      controls = Object.fromEntries(Object.entries(elements).map(([key, value]) => [key, resolve(value)]));
      const removers = [];
      const bind = (el, name, fn) => { if (el) { el.addEventListener(name, fn); removers.push(() => el.removeEventListener(name, fn)); } };
      if (controls.disclosure) controls.disclosure.textContent = disclosure();
      bind(controls.start, 'click', (event) => {
        if (!event.isTrusted) return;
        if (controls.consent) {
          if (!controls.consent.checked) { update({ status: 'Please read the statement and opt in first' }); return; }
          void begin();
        } else requestConsent(event);
      });
      bind(controls.stop, 'click', () => stop());
      bind(controls.consent, 'change', () => { if (!controls.consent.checked) stop('Consent withdrawn'); });
      bind(controls.workload, 'change', () => { try { setWorkload(controls.workload.value); } catch (error) { update({ status: error.message }); } });
      unbind = () => { removers.forEach(fn => fn()); controls = null; };
      update({});
      return api;
    }
    function mount(container) {
      if (widget) return widget;
      const target = typeof container === 'string' ? document.querySelector(container) : container || document.body;
      if (!target) throw new Error('Widget container was not found');
      widget = document.createElement('div');
      widget.className = 'randomx-embed';
      const root = widget.attachShadow({ mode: 'open' });
      const style = document.createElement('style'); style.nonce = config.nonce; style.textContent = css;
      root.appendChild(style);
      const panel = document.createElement('section');
      panel.className = 'widget'; panel.setAttribute('aria-label', 'Monero mining controls');
      panel.innerHTML = `<header><span>randomx bonanza · ${VERSION}</span><button class="mini" aria-expanded="true">[−]</button></header>
        <div class="body"><p>Monero mining</p><p class="details"></p>
        <div class="stats"><span>Hashrate</span><span class="rate">0 H/s</span><span>Shares</span><span class="shares">0 / 0</span></div>
        <div class="bar" aria-hidden="true">${'▱'.repeat(24)}</div>
        <label>CPU: <output></output><input class="workload" type="range" min="0" max="${MAX_WORKLOAD}" step="1" aria-label="CPU percentage"></label>
        ${config.quickstart ? '' : '<label class="consent"><input type="checkbox"> I understand and agree to use my device for this session.</label>'}
        <div class="controls"><button class="start">Start</button><button class="stop" disabled>Stop</button></div>
        <div class="status" role="status" aria-live="polite"></div>
        <details class="diagnostics" hidden><summary>Deployment details</summary><pre></pre></details></div>
        <div class="summary" hidden><span class="rate">0 H/s</span><button class="stop" disabled>Stop</button></div>`;
      root.appendChild(panel); target.appendChild(widget);
      const $ = (s) => root.querySelector(s);
      bindControls({ start: $('.start'), stop: $('.stop'), consent: $('input[type=checkbox]'),
        workload: $('.workload'), status: $('.status'), hashrate: $('.rate'), disclosure: $('.details'), diagnostics: $('.diagnostics pre') });
      $('.mini').addEventListener('click', () => {
        const collapsed = panel.classList.toggle('collapsed');
        $('.summary').hidden = !collapsed;
        $('.mini').textContent = collapsed ? '[+]' : '[−]';
        $('.mini').setAttribute('aria-expanded', String(!collapsed));
      });
      $('.summary .stop').addEventListener('click', () => stop());
      api.on('state', (s) => {
        $('.diagnostics').hidden = !s.error;
        $('output').textContent = `${Number(s.effectivePercentage.toFixed(1))}% · ${s.threads}/${s.limits.cores} threads`;
        $('.shares').textContent = `${s.accepted} accepted / ${s.rejected} rejected`;
        const filled = Math.round(s.progress * 24);
        $('.bar').textContent = '▰'.repeat(filled) + '▱'.repeat(24 - filled);
        $('.summary .rate').textContent = s.hashrate.toFixed(0) + ' H/s · ' + s.phase;
        $('.summary .stop').disabled = !s.running && s.phase !== 'consent';
      });
      update({});
      return widget;
    }
    function armQuickstart() {
      // First interaction only requests consent. It never grants consent.
      const handler = (event) => {
        if (!event.isTrusted || (event.type === 'keydown' && ['Tab', 'Shift', 'Control', 'Alt', 'Meta', 'Escape'].includes(event.key))) return;
        removeQuickstart(); requestConsent(event);
      };
      document.addEventListener('click', handler);
      document.addEventListener('keydown', handler);
      removeQuickstart = () => { document.removeEventListener('click', handler); document.removeEventListener('keydown', handler); };
    }
    const onVisibility = () => {
      // An approved session survives tab switches, including initialization
      // and reconnects. A pending consent request cannot start while hidden.
      if (document.hidden && state.phase === 'consent') stop('Page hidden — consent request cancelled');
    };
    const onPageHide = () => stop('Page closed — stopped');
    const onOffline = () => { if (session) reconnect(session, 'Network offline'); };
    const onOnline = () => {
      if (session && state.running && state.phase === 'reconnecting') {
        clearTimeout(retryTimer); retryTimer = null; connect(session);
      }
    };
    const api = Object.freeze({
      version: VERSION, config,
      get limits() { return budget; },
      get state() { return snapshot(); },
      get diagnostics() { return Object.freeze({ ...diagnose(), error: state.error }); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return () => listeners.get(name).delete(fn); },
      requestConsent, start: requestConsent, stop, setWorkload, bindControls, mount,
      destroy() {
        if (destroyed) return;
        stop('Embed removed'); destroyed = true;
        removeQuickstart(); unbind();
        document.removeEventListener('visibilitychange', onVisibility);
        document.removeEventListener('securitypolicyviolation', policyViolation);
        global.removeEventListener('pagehide', onPageHide);
        global.removeEventListener('offline', onOffline); global.removeEventListener('online', onOnline);
        if (widget) widget.remove(); listeners.clear();
      }
    });
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('securitypolicyviolation', policyViolation);
    global.addEventListener('pagehide', onPageHide);
    global.addEventListener('offline', onOffline); global.addEventListener('online', onOnline);
    if (!config.headless) mount(config.container);
    const preflight = diagnose();
    if (!preflight.supported) fail({ code: 'DEPLOYMENT_UNSUPPORTED', stage: 'preflight',
      message: 'This page cannot run the multithreaded mining engine.',
      hints: preflight.issues.flatMap(issue => [issue.message, ...issue.hints]) });
    if (config.quickstart) armQuickstart();
    return api;
  }

  global.RandomXEmbed = Object.freeze({ version: VERSION, create, diagnose, limits: (input = {}, nav) => limits({ mode: 'full', ...input }, nav) });
  function autoMount() {
    if (!script || !script.hasAttribute('data-wallet') || script.dataset.auto === 'false') return;
    const data = script.dataset;
    try {
      const instance = create({ wallet: data.wallet, pool: data.pool, port: data.port, proxy: data.proxy,
        workload: data.workload, workerName: data.workerName, routeQuery: data.routeQuery !== 'false',
        nonceMode: data.nonceMode, keepalive: data.keepalive,
        mode: data.mode, headless: data.headless === 'true', quickstart: data.quickstart === 'true',
        container: data.container, assetBase: data.assetBase, nonce: script.nonce });
      global.dispatchEvent(new CustomEvent('randomx:ready', { detail: { instance } }));
    } catch (error) {
      console.error('RandomX embed:', error);
      document.dispatchEvent(new CustomEvent('randomx:error', { detail: { message: error.message } }));
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoMount, { once: true });
  else autoMount();
})(window);
