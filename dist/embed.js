/* RandomX bonanza embed. Mining is session-only and starts after consent.
 * See README.md for the headless API, consent events and deployment headers. */
(function (global) {
  'use strict';
  if (global.RandomXEmbed) return;
  const script = document.currentScript;
  const defaultBase = new URL('.', script && script.src || location.href).href;
  const ownerKey = Symbol.for('randomx.bonanza.active-session');
  const VERSION = '0.3.0';
  const MAX_WORKLOAD = 80;
  // Approximate RAM (MiB; light-mode texts state them as MB/GB, like the
  // no-SAB docs): the pthread full mode, one randomx_st light worker (its own
  // 256 MiB cache), one light-mode full-dataset replica.
  const FULL_MIB = 2560, WORKER_MIB = 300, REPLICA_MIB = 2300;
  // A replica worker mines about 2.25× a light one (Ryzen 5600X, no-SAB
  // pool: 2.24 at 6 workers, 2.31 at 12; NOSAB_KNOBS.md §4). Light mode picks
  // the replica count that maximizes light-worker equivalents within budget.
  const REPLICA_WEIGHT = 2.25;
  const LIGHT_HINT = "Or set mode: 'light', which needs no isolation headers.";
  const count = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

  function number(value, fallback, label) {
    if (value === undefined || value === '') return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(label + ' must be a finite number');
    return n;
  }

  function integer(value, fallback, label, min, max) {
    if (value === undefined || value === null || value === '') return fallback;
    const n = ['number', 'string'].includes(typeof value) ? Number(value) : NaN;
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be an integer from ${min} to ${max}`);
    return n;
  }

  // API-only engine knobs, passed to every worker's init (worker.js jitProfile,
  // enableJit, jitExperiment). Only the keys the operator set are kept.
  // experiment takes only the hash-safe worker.js jit_exp tokens: reuse and
  // reuse2 (timing-only, wrong hashes on purpose) and unknown tokens throw.
  const EXPERIMENT = /^(?:no_(?:threaded|inline_fprc|regs_mem|split_id|fuse|inline_round|supjit)|unroll2|(?:fuse_n|triples_n|unroll2|shared_code|aes_simd|aes_relaxed|light_mlp|kernel_k)=\d+)$/i;
  const TUNING = {
    profile: [v => ['auto', 'arm', 'x86'].includes(v), 'auto, arm or x86'],
    jit: [v => typeof v === 'boolean', 'a boolean'],
    lightMlp: [v => Number.isInteger(v) && v >= 0 && v <= 2, 'an integer from 0 to 2'],
    kernelK: [v => Number.isInteger(v) && v >= 1 && v <= 4, 'an integer from 1 to 4'],
    experiment: [v => typeof v === 'string' && v.length <= 256 && v.split(',').every(t => !t || EXPERIMENT.test(t)),
      'a comma-separated list of hash-safe engine tokens (see README), at most 256 characters'],
  };
  function tuning(input) {
    if (input === undefined || input === null) return Object.freeze({});
    const proto = input && typeof input === 'object' && !Array.isArray(input) ? Object.getPrototypeOf(input) : undefined;
    // Realm-agnostic: the embed and its caller may have different Object.prototypes.
    if (!(proto === null || (proto && Object.getPrototypeOf(proto) === null))) throw new Error('tuning must be a plain object');
    const out = {};
    for (const [key, value] of Object.entries(input)) {
      if (!Object.prototype.hasOwnProperty.call(TUNING, key)) throw new Error('Unknown tuning option ' + key);
      if (value === undefined) continue;
      if (!TUNING[key][0](value)) throw new Error(`tuning.${key} must be ${TUNING[key][1]}`);
      out[key] = value;
    }
    return Object.freeze(out);
  }
  // worker.js jit_exp tokens: the typed knobs first (the worker takes the
  // first k=N match), then the free-form experiment tokens.
  function jitExperiment(t) {
    return [t.lightMlp !== undefined && 'light_mlp=' + t.lightMlp, t.kernelK !== undefined && 'kernel_k=' + t.kernelK,
      ...(t.experiment || '').split(',')].filter(Boolean).join(',');
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
    if (![undefined, '', 'full', 'light'].includes(input.mode)) throw new Error('Mode must be full or light');
    if (input.routeQuery !== undefined && typeof input.routeQuery !== 'boolean') throw new Error('routeQuery must be a boolean');
    if (input.nonceMode !== undefined && !['auto', 'nicehash'].includes(input.nonceMode)) throw new Error('nonceMode must be auto or nicehash');
    if (input.keepalive !== undefined && !['auto', 'required'].includes(input.keepalive)) throw new Error('keepalive must be auto or required');
    const mode = input.mode || 'full';
    const maxThreads = integer(input.maxThreads, null, 'maxThreads', 1, 32);
    const replicas = input.replicas === 'auto' || input.replicas === undefined || input.replicas === '' ? 'auto' :
      integer(input.replicas, 'auto', 'replicas', 0, 2);
    if (replicas !== 'auto' && replicas && mode !== 'light') throw new Error("replicas need mode: 'light' (full mode already mines on one shared dataset)");
    const initThreads = integer(input.initThreads, 32, 'initThreads', 1, 32); // full mode; light builds on its workers
    const memory = number(input.memory, 50, 'memory');
    if (memory <= 0 || memory > MAX_WORKLOAD) throw new Error(`memory must be a percentage of reported RAM above 0, at most ${MAX_WORKLOAD}`);
    const memoryCap = number(input.memoryCap, 2, 'memoryCap');
    if (memoryCap <= 0 || memoryCap > 64) throw new Error('memoryCap must be a size in GB above 0, at most 64');
    if (input.optimizeArm !== undefined && typeof input.optimizeArm !== 'boolean') throw new Error('optimizeArm must be a boolean');
    return Object.freeze({ wallet, pool, port, proxy: proxy.href, assetBase: base.href,
      workerName: String(input.workerName || 'embed').slice(0, 64), workload,
      mode, maxThreads, replicas, initThreads, memory, memoryCap, optimizeArm: input.optimizeArm === true,
      tuning: tuning(input.tuning), routeQuery: input.routeQuery !== false,
      nonceMode: input.nonceMode || 'auto', keepalive: input.keepalive || 'auto',
      headless: input.headless === true, quickstart: input.quickstart === true,
      container: input.container, nonce: input.nonce || (script && script.nonce) || '' });
  }

  // Chromium reports the CPU architecture only asynchronously: asked once per
  // page, so plan() and create() agree once it resolves. Until then (and in
  // other browsers) limits() infers it from the platform string.
  let hintedArchitecture = '';
  const architectureHint = navigator.userAgentData && navigator.userAgentData.getHighEntropyValues ?
    navigator.userAgentData.getHighEntropyValues(['architecture'])
      .then(({ architecture }) => { hintedArchitecture = String(architecture || ''); }).catch(() => {}) : null;

  function limits(config, nav = navigator) {
    const reported = Number(nav.hardwareConcurrency);
    // An unknown topology gets a single mining thread; a reported one-core
    // device gets none, since one thread would violate the 80% cap.
    const reportedCores = Number.isFinite(reported) && reported >= 1 ? Math.floor(reported) : 2;
    const architecture = String(nav.architecture || (nav === navigator && hintedArchitecture) || '');
    const platform = String(nav.platform || (nav.userAgentData && nav.userAgentData.platform) || '');
    const arm = architecture ? /^(arm|aarch64)/i.test(architecture) :
      /arm|aarch64|iPhone|iPad|iPod/i.test(String(nav.userAgent || '') + ' ' + platform) || /Mac/.test(platform);
    // optimizeArm (full mode only): count half the reported cores, about the
    // performance cores of big.LITTLE / Apple silicon parts. Light workers are
    // independent, so efficiency cores only add to them; it never applies there.
    const armOptimized = arm && config.optimizeArm === true && config.mode !== 'light';
    const cores = armOptimized ? Math.max(1, Math.floor(reportedCores / 2)) : reportedCores;
    const workloadCap = MAX_WORKLOAD;
    const maxThreads = Math.min(32, Math.floor(cores * workloadCap / 100), config.maxThreads || 32);
    return Object.freeze({ cores, reportedCores, arm, armOptimized, maxThreads, maxPercentage: maxThreads / cores * 100,
      workloadCap,
      initThreads: config.initThreads || 32 });
  }

  // Light mode's RAM budget and worker/replica split. The budget is
  // config.memory % of the RAM the browser reports, or config.memoryCap GB
  // where it reports none (Firefox, Safari, insecure contexts). Workers come
  // from the CPU workload, cut to what the budget holds; replicas (0–2, or
  // 'auto') take REPLICA_MIB more each and replace a light worker's rate with
  // REPLICA_WEIGHT of it. 'auto' maximizes that, fewer replicas on a tie; a
  // fixed count falls back to the most that fits. The workers themselves
  // build the replicas, so the build stays within the same CPU and RAM.
  function lightSplit(config, wanted, deviceMemory) {
    const reported = typeof deviceMemory === 'number' && deviceMemory > 0;
    const budgetMiB = Math.floor(reported ? deviceMemory * 1024 * config.memory / 100 : config.memoryCap * 1024);
    const fit = k => Math.min(wanted, Math.floor((budgetMiB - k * REPLICA_MIB) / WORKER_MIB));
    const options = config.replicas === 'auto' ? [0, 1, 2] : Array.from({ length: config.replicas + 1 }, (_, k) => config.replicas - k);
    let best = null;
    for (const k of options) {
      const workers = fit(k);
      if (workers < Math.max(1, k)) continue;
      const score = workers - k + REPLICA_WEIGHT * k;
      if (config.replicas !== 'auto') { best = { workers, replicas: k }; break; }
      if (!best || score > best.score) best = { workers, replicas: k, score };
    }
    return { workers: best ? best.workers : 0, replicas: best ? best.replicas : 0, budgetMiB,
      memorySource: reported ? 'reported' : 'cap' };
  }

  // Single source of truth for the thread, memory and disclosure math, shared
  // by create() and RandomXEmbed.plan(). Full: one engine worker owning the
  // mining pthreads. Light: one randomx_st worker per mining thread (lightSplit).
  function resolve(config, budget, percentage, deviceMemory) {
    const wanted = Math.min(budget.maxThreads, Math.floor(budget.cores * percentage / 100 + 1e-9));
    const light = config.mode === 'light';
    const split = light ? lightSplit(config, wanted, deviceMemory) : null;
    const threads = light ? split.workers : wanted;
    const workers = light ? split.workers : Math.min(threads, 1);
    const replicas = light ? split.replicas : 0;
    // Light: the workers build the replicas (none without replicas).
    const initThreads = light ? (replicas ? workers : 0) : config.initThreads;
    const memoryMiB = light ? workers * WORKER_MIB + replicas * REPLICA_MIB : FULL_MIB;
    const gb = mib => (mib / 1000).toFixed(1) + ' GB';
    const share = (threads / budget.reportedCores * 100).toFixed(1);
    const disclosure = `Mine Monero for wallet ${config.wallet} via ${config.pool}:${config.port} (bridge ${config.proxy}). ` +
      `Mining uses ${threads} of ${budget.reportedCores} reported CPU cores (${share}%), ` + (light ? '' : `at most ${budget.maxThreads}. `) +
      (budget.armOptimized ? `On this ARM device it counts half of them, about its performance cores. ` : '') + (light ?
        `${threads < wanted ? 'limited by memory, ' : ''}as ${count(workers, 'light-mode worker')} at about ${WORKER_MIB} MB${workers === 1 ? '' : ' each'}` +
        (replicas ? `; ${replicas} of them also ${replicas === 1 ? 'holds' : 'hold'} a private full dataset ` +
          `(about ${REPLICA_MIB / 1000} GB${replicas === 1 ? '' : ' each'}), which the workers build before mining starts and again ` +
          `after each seed change (every few days)` : '') +
        `. Mining needs about ${gb(memoryMiB)} of RAM. ` :
        `Dataset initialization uses ${count(initThreads, 'thread')}. Full mode needs about 2.5 GiB of RAM. `) +
      'This uses electricity and can heat your device or drain its battery. Stop at any time. ' +
      'Mining continues in background tabs until you stop it or leave this page; your browser may throttle or suspend it.';
    return Object.freeze({ mode: config.mode, runtime: light ? 'workers' : 'pthreads', threads, wantedThreads: wanted, workers,
      replicas, initThreads, memoryMiB,
      memoryBudgetMiB: light ? split.budgetMiB : null, memorySource: light ? split.memorySource : null,
      disclosure, limits: budget });
  }

  function plan(input = {}, nav = navigator) {
    const config = configure(input);
    const budget = limits(config, nav);
    return resolve(config, budget, Math.min(config.workload, budget.workloadCap), nav.deviceMemory);
  }

  function diagnose(mode = 'full') {
    if (!['full', 'light'].includes(mode)) throw new Error('Mode must be full or light');
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
    // Light mode (randomx_st workers) needs only Worker and WebAssembly.
    const engine = checks.workers && checks.webAssembly;
    const light = engine ? [] : [Object.freeze({ code: 'ENGINE_UNSUPPORTED', message: 'Worker or WebAssembly support is unavailable.',
      hints: Object.freeze(['Use a browser with Web Workers and WebAssembly support.']) })];
    const issues = [];
    const add = (code, message, hints) => issues.push(Object.freeze({ code, message, hints: Object.freeze(hints) }));
    const alt = engine ? [LIGHT_HINT] : [];
    if (!checks.secureContext) add('INSECURE_CONTEXT', 'This page is not a secure context.',
      ['Serve the embedding page over HTTPS. Trusted localhost is suitable for local browser testing.']);
    if (!checks.crossOriginIsolated) add('CROSS_ORIGIN_ISOLATION', 'This page is not cross-origin isolated.',
      ['Check the HTML response: Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp.',
       'Set these on the embedding page, not just the CDN or WebSocket bridge. Reload after fixing the headers.',
       ...(checks.embedded ? ['For an iframe, the parent page must also provide isolation and allow cross-origin-isolated for the frame.'] : []), ...alt]);
    if (checks.isolationAllowed === false) add('PERMISSIONS_POLICY', 'Permissions Policy denies cross-origin isolation.',
      ['Allow cross-origin-isolated for this page (for example, Permissions-Policy: cross-origin-isolated=(self)); check parent/frame delegation if embedded.', ...alt]);
    if (checks.crossOriginIsolated && !checks.sharedArrayBuffer) add('SHARED_MEMORY_UNAVAILABLE', 'SharedArrayBuffer is unavailable in this browser.',
      ['Use a browser with shared WebAssembly memory support; inspect browser restrictions and Permissions Policy.', ...alt]);
    if (!engine) add('ENGINE_UNSUPPORTED', 'Worker or WebAssembly support is unavailable.',
      ['Use a browser with Web Workers, WebAssembly and shared memory support.']);
    const report = mode === 'light' ? light : issues;
    return Object.freeze({ supported: report.length === 0, checks, issues: Object.freeze(report),
      modes: Object.freeze({ full: issues.length === 0, light: engine }) });
  }
  // Issue messages and hints, once each (the light-mode hint repeats per isolation issue).
  const flatHints = report => [...new Set(report.issues.flatMap(issue => [issue.message, ...issue.hints]))];

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

  // Light mode: a Worker-shaped facade over n single-thread randomx_st workers
  // (ported from miner.js NoSabPool). init fans out with a disjoint nonce slot
  // each; 'ready' once every worker is, hashrates summed, shares and policy
  // reports passed through, errors tagged with the worker index,
  // 'nonce_exhausted' once every slot ran out on that job, and chatty messages
  // from worker 0 only. 'mode' reports the full/light split.
  // With replicas, workers 0..replicas-1 mine on a private full dataset that
  // an RxFbFull.FbCoordinator on the page has all n workers build, per seed,
  // before anyone mines: a new seed sends every worker 'seed' (cache only),
  // jobs wait until the build is done, and 'mode' (the embed's readiness)
  // follows it.
  function workerPool(n, url, replicas, Fb) {
    const pool = { onmessage: null, onerror: null, onmessageerror: null };
    const workers = [], rates = new Array(n).fill(0), modes = new Array(n).fill(null), ready = new Set();
    const exhausted = new Map(); // `${job_id}/${job_seq}` -> exhausted slots
    let building = false, held = null; // a replica build, and the latest job waiting for it
    const emit = data => { if (pool.onmessage) pool.onmessage({ data }); };
    const fail = message => { if (pool.onerror) pool.onerror({ message }); };
    const sum = () => rates.reduce((a, b) => a + b, 0);
    const split = () => {
      const full = modes.filter(m => m === 'full').length;
      emit({ type: 'mode', mode: full === n ? 'full' : full ? 'mixed' : 'light', full, light: n - full });
    };
    const fb = replicas ? new Fb.FbCoordinator({ n, full: [...Array(replicas).keys()],
      send: (i, m, transfer) => workers[i].postMessage(m, transfer || []),
      progress: (done, total, etaSec) => emit({ type: 'dataset_progress', done, total, etaSec, threads: n }),
      done: (seed, full) => {
        building = false;
        emit({ type: 'status', message: full.length ? `Full dataset${replicas === 1 ? '' : 's'} ready: ${full.length} of ${replicas} mining in full mode` :
          'No full dataset could be allocated: mining in light mode' });
        split();
        if (held) { const job = held; held = null; workers.forEach(worker => worker.postMessage(job)); }
      } }) : null;
    function recv(i, msg) {
      if (!msg || typeof msg !== 'object' || (fb && fb.recv(i, msg))) return;
      if (typeof msg.type === 'string' && msg.type.startsWith('rx:')) { emit(msg); return; }
      switch (msg.type) {
        case 'ready':
          ready.add(i);
          if (ready.size === n) emit(msg);
          break;
        case 'hashrate':
          rates[i] = Number.isFinite(msg.rate) ? msg.rate : 0;
          emit({ type: 'hashrate', rate: sum() });
          break;
        case 'mode':
          // Every report: a worker with a cache for the new seed can mine,
          // except while a replica build runs; its end reports the split.
          modes[i] = msg.mode;
          if (!building) split();
          break;
        case 'nonce_exhausted': {
          // A worker exhausts only its own slot: its rate leaves the sum now;
          // the page is out of nonces once every slot is, for the same job.
          rates[i] = 0;
          emit({ type: 'hashrate', rate: sum() });
          const key = msg.job_id + '/' + msg.job_seq;
          const slots = (exhausted.get(key) || new Set()).add(i);
          exhausted.set(key, slots);
          if (slots.size === n) { exhausted.delete(key); emit(msg); }
          break;
        }
        case 'share': emit(msg); break;
        case 'error': emit({ ...msg, message: `[worker ${i}] ${msg.message}` }); break;
        default: if (i === 0) emit(msg);
      }
    }
    try {
      for (let i = 0; i < n; i++) {
        const worker = new Worker(url, { name: 'rx-st-' + i });
        workers.push(worker);
        worker.onmessage = ({ data }) => { try { recv(i, data); } catch (error) { fail(`[worker ${i}] ${error.message}`); } };
        worker.onerror = event => fail(`[worker ${i}] ${event.message || 'unknown error'}`);
        worker.onmessageerror = event => { if (pool.onmessageerror) pool.onmessageerror(event); };
      }
    } catch (error) { workers.forEach(worker => worker.terminate()); throw error; }
    pool.postMessage = msg => {
      if (msg.type === 'stop') { rates.fill(0); held = null; }
      if (msg.type === 'stop' || msg.type === 'job') exhausted.clear();
      if (fb && msg.type === 'job') {
        // A new seed: every worker stops, rebuilds its cache and joins the build.
        if (msg.seed_hash !== fb.seed) {
          building = true; held = msg; rates.fill(0);
          fb.epoch(msg.seed_hash);
          workers.forEach(worker => { worker.postMessage({ type: 'stop' }); worker.postMessage({ type: 'seed', seed_hash: msg.seed_hash }); });
          return;
        }
        if (building) { held = msg; return; }
      }
      workers.forEach((worker, i) => worker.postMessage(msg.type !== 'init' ? msg : { ...msg, fullMemory: false,
        datasetThreads: 1, datasetInitThreads: 1, nonceSlot: i, nonceSlots: n,
        ...(fb ? { fbRole: i < replicas ? 'full' : 'light' } : {}) }));
    };
    pool.terminate = () => workers.forEach(worker => { try { worker.terminate(); } catch (_) {} });
    return pool;
  }

  function diagnosticText(error) {
    if (!error) return '';
    return `[${error.code}] ${error.message}\n` +
      (error.directive ? `Blocked directive: ${error.directive}\n` : '') +
      (error.resource ? `Resource: ${error.resource}\n` : '') +
      error.hints.map(hint => '\n• ' + hint).join('') +
      '\n\nBrowser checks: ' + JSON.stringify(error.checks);
  }

  // The randomx.cc miner widget's look (its #widget: --w-* tokens, type scale,
  // rules, bracketed buttons, log box), in px so the host page's root font size
  // cannot rescale it. IBM Plex Mono renders where the host page loads it (as
  // randomx.cc does); elsewhere the stack falls back. The noise texture is a
  // data: image and purely decorative: a host CSP that blocks data: images
  // drops the texture and nothing else. The widget is light unless the host
  // page declares a dark color-scheme (it inherits the page's color-scheme
  // and picks each token with light-dark()), so it follows the page, not the
  // visitor's OS. Its width is a :host default the page can override.
  const noise = `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='1.4' numOctaves='1' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)' opacity='0.18'/></svg>")`;
  const css = `
    :host{all:initial;display:block;max-width:600px;color-scheme:inherit}
    *{box-sizing:border-box} p{margin:0}
    .widget{--w-bg:#fefefc;--w-rule:#a8a59c;--w-ink:#1a1815;--w-ink-dim:#4a4640;--w-ink-faint:#888579;--w-amber:#ff3b8a;
    --w-amber-bright:#ff6da6;--w-stone-border:#6e6b62;--w-log-bg:#f4f4f2;--w-log-ink:#1a1815;--w-frame:#000;
    font:16px/normal 'IBM Plex Mono','SF Mono',Menlo,'Cascadia Mono','Roboto Mono',monospace;color:var(--w-ink);
    background:var(--w-bg) ${noise} repeat;background-size:220px 220px;background-blend-mode:multiply;
    border:1px solid var(--w-frame);font-variant-numeric:tabular-nums}
    @supports(color:light-dark(#000,#fff)){.widget{--w-bg:light-dark(#fefefc,#1a1815);--w-rule:light-dark(#a8a59c,#4a4640);
    --w-ink:light-dark(#1a1815,#f2ede4);--w-ink-dim:light-dark(#4a4640,#c0b9aa);--w-log-bg:light-dark(#f4f4f2,#211e1a);
    --w-log-ink:light-dark(#1a1815,#f2ede4);--w-frame:light-dark(#000,#888579)}}
    header{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:11.2px 17.6px 9.6px;border-bottom:1px solid var(--w-rule)}
    .title{font-size:11.2px;letter-spacing:.12em} .mini{background:transparent;border:0;padding:0;color:var(--w-ink-dim);font:inherit;
    font-size:11.5px;letter-spacing:.15em;line-height:1;cursor:pointer} .mini:hover{color:var(--w-amber)}
    .body{padding:16.8px 17.6px 18.4px;container-type:inline-size}.collapsed .body{display:none}
    .lead,.stats span:nth-child(odd),.init span:first-child,.cpu span{font-size:9.9px;color:var(--w-ink-dim);text-transform:uppercase;letter-spacing:.15em}
    .lead,.init span:first-child,.cpu span{display:block;margin-bottom:3.5px} .details{font-size:11.2px;line-height:1.6;color:var(--w-ink-dim);overflow-wrap:anywhere}
    .stats{display:grid;grid-template-columns:128px minmax(0,1fr);gap:12px 9.6px;align-items:baseline;margin:15.2px 0;padding:11.7px 0;
    border-top:1px solid var(--w-rule);border-bottom:1px solid var(--w-rule)} .stats span{padding:3.5px 0}
    .stats span:nth-child(even),.summary .rate{font-size:14.7px;letter-spacing:.02em;overflow-wrap:anywhere}
    .init{display:grid;grid-template-columns:minmax(0,max-content) auto;justify-content:start;column-gap:.7em;align-items:baseline;margin-bottom:12px}
    .init[hidden]{display:none}.init span:first-child{grid-column:1/-1}
    .bar,.pct,output{font-size:14.1px;letter-spacing:.06em;white-space:nowrap}.bar{color:var(--w-ink);overflow:hidden}
    .cpu{display:block;padding-bottom:15.2px;border-bottom:1px solid var(--w-rule);margin-bottom:15.2px} output{display:block;letter-spacing:.02em}
    input[type=range]{-webkit-appearance:none;appearance:none;display:block;width:100%;height:14px;margin:8px 0 0;background:transparent;cursor:pointer}
    input[type=range]::-webkit-slider-runnable-track{height:1px;background:linear-gradient(var(--w-ink),var(--w-ink)) 0 0/calc(4px + (100% - 8px) * var(--fill,0)) 100% no-repeat,var(--w-rule)}
    input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:8px;height:14px;margin-top:-6.5px;border:0;border-radius:0;background:var(--w-ink)}
    input[type=range]:hover::-webkit-slider-thumb,input[type=range]:focus-visible::-webkit-slider-thumb{background:var(--w-amber)}
    input[type=range]::-moz-range-track{height:1px;background:var(--w-rule)}
    input[type=range]::-moz-range-progress{height:1px;background:var(--w-ink)}
    input[type=range]::-moz-range-thumb{width:8px;height:14px;border:0;border-radius:0;background:var(--w-ink)}
    input[type=range]:hover::-moz-range-thumb,input[type=range]:focus-visible::-moz-range-thumb{background:var(--w-amber)}
    .consent{display:flex;gap:9.6px;align-items:flex-start;margin-bottom:15.2px;font-size:11.2px;line-height:1.6;cursor:pointer}
    input[type=checkbox]{flex:none;margin:3px 0 0;accent-color:var(--w-amber);cursor:pointer}
    .controls{display:flex;flex-wrap:wrap;gap:25.6px}
    .controls button,.summary button{background:transparent;color:var(--w-ink);border:0;padding:0;font:inherit;font-size:13.1px;
    letter-spacing:.24em;text-transform:uppercase;line-height:1.2;cursor:pointer}
    .controls button::before,.summary button::before{content:"[";color:var(--w-ink-faint);margin-right:.55em}
    .controls button::after,.summary button::after{content:"]";color:var(--w-ink-faint);margin-left:.55em}
    .controls button:enabled:hover,.summary button:enabled:hover{color:var(--w-amber-bright)}
    button:enabled:hover::before,button:enabled:hover::after{color:var(--w-amber)}
    .controls button:disabled,.summary button:disabled{color:var(--w-ink-faint);cursor:default}
    button:focus-visible,input:focus-visible,summary:focus-visible{outline:1px solid var(--w-amber);outline-offset:4px}
    .status,.diagnostics pre{font-size:11.2px;line-height:1.42;color:var(--w-log-ink);overflow-wrap:anywhere;padding:12px 14.4px;
    background:var(--w-log-bg) ${noise} repeat;background-size:220px 220px;background-blend-mode:multiply;border:1px solid var(--w-stone-border)}
    .status{margin-top:15.2px;min-height:calc(2.84em + 26px)}
    .diagnostics{margin-top:12px}.diagnostics summary{list-style:none;cursor:pointer;font-size:9.9px;color:var(--w-amber);
    text-transform:uppercase;letter-spacing:.15em}.diagnostics summary::-webkit-details-marker{display:none}
    .diagnostics summary::before{content:"▸";margin-right:.6em}.diagnostics[open] summary::before{content:"▾"}
    .diagnostics pre{font-family:inherit;white-space:pre-wrap;margin:8px 0 0}
    .summary{display:flex;gap:16px;align-items:baseline;padding:12px 17.6px}.summary[hidden]{display:none}.summary .rate{flex:1;min-width:0}
    @media(max-width:1280px),(max-height:820px){header{padding:8.8px 14.4px 8px}.title{font-size:9.6px;letter-spacing:.1em}.mini{font-size:9.9px}
    .body{padding:12.8px 14.4px 14.4px}.summary{padding:9.6px 14.4px}.stats{grid-template-columns:96px minmax(0,1fr);gap:8.8px 8px;margin:10.4px 0;padding:7.8px 0}
    .stats span{padding:2.6px 0}.lead,.stats span:nth-child(odd),.init span:first-child,.cpu span{font-size:8.6px}
    .lead,.init span:first-child,.cpu span{margin-bottom:2.6px;letter-spacing:.13em}.stats span:nth-child(even),.summary .rate{font-size:12.8px}
    .init{margin-bottom:8.8px}.bar,.pct,output{font-size:12.2px;letter-spacing:.04em}output{letter-spacing:.02em}
    .cpu{padding-bottom:10.4px;margin-bottom:10.4px}.consent{margin-bottom:10.4px}.status{margin-top:10.4px}.controls{gap:19.2px}
    .controls button,.summary button{font-size:11.5px;letter-spacing:.2em}}
    @container(max-width:400px){.stats{grid-template-columns:minmax(0,1fr);row-gap:0}.stats span:nth-child(odd){padding-bottom:0}
    .stats span:nth-child(even){padding-top:2px;padding-bottom:9px}.stats span:last-child{padding-bottom:0}}
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
    const light = config.mode === 'light';
    const unsupported = light ? 'This page cannot run the mining engine.' : 'This page cannot run the multithreaded mining engine.';
    let state = { running: false, phase: 'idle', status: 'Waiting for consent', hashrate: 0,
      accepted: 0, rejected: 0, progress: 0, retries: 0, error: null };
    const architectureReady = architectureHint ? architectureHint.then(() => {
      if (destroyed) return;
      budget = limits(config);
      percentage = Math.min(state.phase === 'consent' ? percentage : requestedPercentage, budget.workloadCap);
      if (controls && controls.disclosure) controls.disclosure.textContent = disclosure();
      update({});
    }).catch(() => {}) : Promise.resolve();

    // A session keeps the plan it was approved with.
    function planNow() { return session ? session.plan : resolve(config, budget, percentage, navigator.deviceMemory); }
    function threads() { return planNow().threads; }
    function disclosure() { return planNow().disclosure; }
    function snapshot() {
      const p = planNow();
      return Object.freeze({ ...state, workload: percentage, threads: p.threads,
        effectivePercentage: p.threads / budget.cores * 100, nicehash: !!(session && session.nicehash), limits: budget, config,
        engine: Object.freeze({ mode: p.mode, runtime: p.runtime, workers: p.workers, replicas: p.replicas,
          replicasActive: session ? session.replicasActive : 0, memoryMiB: p.memoryMiB,
          memoryBudgetMiB: p.memoryBudgetMiB, memorySource: p.memorySource }) });
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
      const report = Object.freeze({ ...issue, hints: Object.freeze(issue.hints || []), checks: diagnose(config.mode).checks });
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
          'Serve matching runtime/worker/WASM files from the same build. ' + (config.mode === 'full' ? 'Full mode needs about 2.5 GiB of RAM.' :
            `This light-mode session needs about ${(planNow().memoryMiB / 1000).toFixed(1)} GB of RAM.`),
          'The browser did not identify a single cause; inspect its console and network errors.'] });
    }
    function supportCheck() {
      if (!budget.maxThreads) throw new Error('This device has no mining threads within the configured core limit');
      const p = planNow();
      if (light && !p.threads && p.wantedThreads) throw new Error(p.memorySource === 'reported' ?
        `The memory share (${config.memory}% of reported RAM) is below one light worker (about ${WORKER_MIB} MB)` :
        `The memory cap (${config.memoryCap} GB, used where the browser reports no RAM) is below one light worker (about ${WORKER_MIB} MB)`);
      if (!threads()) throw new Error('Increase workload enough to allow at least one mining thread');
      const report = diagnose(config.mode);
      if (!report.supported) throw Object.assign(new Error(unsupported), { code: 'DEPLOYMENT_UNSUPPORTED', hints: flatHints(report) });
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
        update({ progress: 0, hashrate: 0 });
      }
      lastJob = { type: 'job', blob: job.blob, seed_hash: seed, target: job.target,
        job_id: job.job_id, job_seq: ++jobSeq, nicehash: s.nicehash };
      if (s.ready) s.worker.postMessage(lastJob);
      update({ phase: s.datasetReady ? 'mining' : 'initializing', status: s.datasetReady ? 'Mining' : light ?
        (s.plan.replicas ? `Building the full dataset${s.plan.replicas === 1 ? '' : 's'} on ${count(s.plan.workers, 'worker')} before mining…` :
          `Initializing light-mode caches (${count(s.plan.workers, 'worker')})…`) :
        `Building dataset (${count(config.initThreads, 'initialization thread')})…` });
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
      // Pool workers run randomx_st and never create pthreads.
      if (/^rx:thread-/.test(msg.type) && s.plan.runtime !== 'pthreads') { stop('Unexpected engine thread request'); return; }
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
        const progress = Math.max(0, Math.min(1, msg.done / msg.total));
        // Light: a replica build, which every worker finishes before mining.
        if (light) update(s.datasetReady ? { progress } : { progress, status:
          `Building the full dataset${s.plan.replicas === 1 ? '' : 's'}: ${(progress * 100).toFixed(0)}% (${count(s.plan.workers, 'worker')})` });
        else {
          s.datasetReady = msg.done >= msg.total;
          update({ progress, status: s.datasetReady ? 'Dataset ready' :
            `Building dataset: ${(msg.done / msg.total * 100).toFixed(0)}% (${count(config.initThreads, 'thread')})` });
        }
      } else if (msg.type === 'nonce_exhausted' && lastJob && msg.job_id === lastJob.job_id && msg.job_seq === lastJob.job_seq) {
        update({ hashrate: 0, phase: 'waiting', status: 'Nonce range exhausted — waiting for a new pool job' });
      } else if (msg.type === 'mode') {
        // Light pools report the full/light split: replicas mining on a full dataset.
        s.datasetReady = true;
        if (Number.isInteger(msg.full) && msg.full !== s.replicasActive) { s.replicasActive = msg.full; update({}); }
      }
      else if (msg.type === 'error') workerFailure('Engine error: ' + msg.message, 'engine');
      else if (msg.type === 'status' && state.phase !== 'reconnecting') update({ status: msg.message });
    }
    async function begin() {
      if (destroyed || state.running) return;
      const ticket = consentTicket;
      const approvedWorkload = percentage, approved = planNow();
      await architectureReady;
      if (destroyed || state.running || ticket !== consentTicket) return;
      percentage = Math.min(approvedWorkload, budget.workloadCap);
      // Late architecture discovery (optimizeArm) may lower the approved
      // thread count, never raise it.
      const resolved = planNow(), p = resolved.threads > approved.threads ? approved : resolved;
      try { supportCheck(); } catch (error) {
        fail({ code: error.code || 'START_UNAVAILABLE', stage: 'preflight', message: error.message, hints: error.hints }); return;
      }
      if (global[ownerKey] && global[ownerKey] !== api) {
        update({ phase: 'error', status: 'Another RandomX embed on this page is already running' }); return;
      }
      global[ownerKey] = api;
      attempt = 0;
      const s = { epoch: ++epoch, children: new Map(), urls: [], abort: new AbortController(), ready: false, datasetReady: false,
        plan: p, replicasActive: 0 };
      session = s;
      // Full: the pthread build behind the embed-worker.js thread broker.
      // Light: the randomx_st build in a pool of plain workers (workerPool).
      const glue = light ? 'randomx_st.js' : 'randomx.js';
      policyAttempt = { urls: s.urls, assetURL: new URL(glue, config.assetBase).href, stage: 'assets' };
      update({ running: true, phase: 'loading', status: 'Loading mining engine…', progress: 0, hashrate: 0, error: null });
      try {
        const response = await fetch(new URL(glue, config.assetBase), { signal: s.abort.signal, mode: 'cors', credentials: 'omit' });
        if (!response.ok) throw new Error('Runtime download failed: HTTP ' + response.status);
        const source = await response.text();
        if (!isCurrent(s)) return;
        if (p.replicas) {
          await replicaCoordinator();
          if (!isCurrent(s)) return;
        }
        const monitor = '(' + workerPolicyReporter.toString() + ')();\n';
        s.glueURL = URL.createObjectURL(new Blob([monitor, source], { type: 'application/javascript' }));
        s.urls.push(s.glueURL);
        const assets = { baseURL: config.assetBase, glueURL: s.glueURL, ...(light ? { build: 'st' } : {}) };
        const bootstrap = monitor + 'self.__randomxAssets=' + JSON.stringify(assets) +
          ';importScripts(' + JSON.stringify(new URL(light ? 'worker.js' : 'embed-worker.js', config.assetBase).href) + ');';
        const url = URL.createObjectURL(new Blob([bootstrap], { type: 'application/javascript' }));
        s.urls.push(url);
        policyAttempt.stage = 'worker';
        s.worker = light ? workerPool(p.workers, url, p.replicas, global.RxFbFull) : new Worker(url);
        s.worker.onmessage = ({ data }) => { try { workerMessage(s, data); } catch (error) { if (isCurrent(s)) workerFailure('Engine message failed: ' + error.message); } };
        s.worker.onerror = (event) => { if (isCurrent(s)) workerFailure('Engine worker failed: ' + (event.message || 'unknown error')); };
        s.worker.onmessageerror = () => { if (isCurrent(s)) workerFailure('Engine message could not be decoded'); };
        // The pool overrides the memory and thread fields per worker.
        const tune = config.tuning;
        s.worker.postMessage({ type: 'init', fullMemory: !light, datasetThreads: p.threads,
          datasetInitThreads: config.initThreads, enableJit: tune.jit !== false, jitProfile: tune.profile || 'auto',
          jitExperiment: jitExperiment(tune) });
      } catch (error) {
        if (isCurrent(s)) fail({ code: policyAttempt.stage === 'assets' ? 'ASSET_DOWNLOAD_FAILED' : 'ENGINE_WORKER_FAILED',
          stage: policyAttempt.stage, message: 'Unable to start: ' + error.message,
          hints: policyAttempt.stage === 'assets' ? [
            `Verify ${safeResource(policyAttempt.assetURL)} exists and returns JavaScript, not an HTML error page.`,
            'Check connect-src, asset CORS/CORP, redirects and the HTTP status in the network panel.'] : [
            "Check worker-src 'self' blob: and script-src for engine assets and WebAssembly compilation."] });
      }
    }
    // Replicas need an RxFbFull.FbCoordinator on the page: fb_full.js, loaded
    // once as a classic script from the asset base (script-src allows it).
    function replicaCoordinator() {
      if (global.RxFbFull) return Promise.resolve();
      policyAttempt.assetURL = new URL('fb_full.js', config.assetBase).href;
      return new Promise((resolve, reject) => {
        const element = document.createElement('script');
        element.src = policyAttempt.assetURL; element.crossOrigin = 'anonymous';
        if (config.nonce) element.nonce = config.nonce;
        element.onload = () => { element.remove(); global.RxFbFull ? resolve() : reject(new Error('fb_full.js did not define RxFbFull')); };
        element.onerror = () => { element.remove(); reject(new Error('Replica coordinator download failed')); };
        (document.head || document.documentElement).appendChild(element);
      });
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
      panel.innerHTML = `<header><span class="title">randomx bonanza · v${VERSION}</span><button class="mini" aria-expanded="true">[ − ]</button></header>
        <div class="body"><p class="lead">Monero mining</p><p class="details"></p>
        <div class="stats"><span>Hashrate</span><span class="rate">0 H/s</span><span>Shares</span><span class="shares">0 / 0</span>
        <span>Threads</span><span class="engine"></span><span>RAM</span><span class="ram"></span></div>
        <div class="init"><span>Dataset init</span><span class="bar" aria-hidden="true">${'▱'.repeat(40)}</span><span class="pct">0%</span></div>
        <label class="cpu"><span>CPU</span><output></output><input class="workload" type="range" min="0" max="${MAX_WORKLOAD}" step="1" aria-label="CPU percentage"></label>
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
        $('.mini').textContent = collapsed ? '[ + ]' : '[ − ]';
        $('.mini').setAttribute('aria-expanded', String(!collapsed));
      });
      $('.summary .stop').addEventListener('click', () => stop());
      // The slider's filled part, drawn by the track (WebKit has no progress pseudo-element).
      const range = $('.workload'), fill = () => range.style.setProperty('--fill', String(Math.min(1, range.value / range.max || 0)));
      range.addEventListener('input', fill);
      api.on('state', (s) => {
        fill();
        $('.diagnostics').hidden = !s.error;
        $('output').textContent = `${Number(s.effectivePercentage.toFixed(1))}% · ${s.threads}/${s.limits.cores} threads`;
        $('.shares').textContent = `${s.accepted} accepted / ${s.rejected} rejected`;
        // Light: the full-dataset/light split, as planned until the build is done.
        const e = s.engine, full = e.mode === 'light' ? (s.progress >= 1 ? e.replicasActive : e.replicas) : 0;
        $('.engine').textContent = e.mode === 'full' ? `${count(s.threads, 'thread')} on the shared dataset` :
          full ? `${full} full-dataset + ${count(e.workers - full, 'light thread')}` : count(e.workers, 'light thread');
        $('.ram').textContent = e.mode === 'full' ? 'about 2.5 GiB' : `about ${(e.memoryMiB / 1000).toFixed(1)} GB`;
        // Light mode without replicas has no dataset to initialize.
        $('.init').hidden = e.mode === 'light' && !e.replicas;
        const filled = Math.round(s.progress * 40);
        $('.bar').textContent = '▰'.repeat(filled) + '▱'.repeat(40 - filled);
        $('.pct').textContent = Math.round(s.progress * 100) + '%';
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
      get diagnostics() { return Object.freeze({ ...diagnose(config.mode), error: state.error }); },
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
    const preflight = diagnose(config.mode);
    if (!preflight.supported) fail({ code: 'DEPLOYMENT_UNSUPPORTED', stage: 'preflight',
      message: unsupported, hints: flatHints(preflight) });
    if (config.quickstart) armQuickstart();
    return api;
  }

  global.RandomXEmbed = Object.freeze({ version: VERSION, create, diagnose, plan,
    limits: (input = {}, nav) => limits({ mode: input.mode === 'light' ? 'light' : 'full', optimizeArm: input.optimizeArm === true,
      maxThreads: integer(input.maxThreads, null, 'maxThreads', 1, 32),
      initThreads: integer(input.initThreads, 32, 'initThreads', 1, 32) }, nav) });
  function autoMount() {
    if (!script || !script.hasAttribute('data-wallet') || script.dataset.auto === 'false') return;
    const data = script.dataset;
    try {
      const instance = create({ wallet: data.wallet, pool: data.pool, port: data.port, proxy: data.proxy,
        workload: data.workload, workerName: data.workerName, routeQuery: data.routeQuery !== 'false',
        nonceMode: data.nonceMode, keepalive: data.keepalive,
        mode: data.mode, maxThreads: data.maxThreads, replicas: data.replicas, initThreads: data.initThreads,
        memory: data.memory, memoryCap: data.memoryCap, optimizeArm: data.optimizeArm === undefined ? undefined : data.optimizeArm === 'true',
        headless: data.headless === 'true', quickstart: data.quickstart === 'true',
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
