const state = {
  ws: null,
  worker: null,
  mining: false,
  hashrate: 0,
  accepted: 0,
  rejected: 0,
  mode: 'standby',
  status: 'disconnected',
  workerReady: false,
  pendingConnect: false,
  reconnectTimer: null,
  currentJobId: null,
  currentJobSeq: 0,
  currentJobDiff: 0,
  lastJob: null,
  nicehash: false,
  shareEtaStart: 0,        // anchored on first non-zero hashrate + share-accepted
  shareEtaTotal: 0,        // SNAPSHOT of diff/hashrate at anchor time — stable for the duration of one share search
  datasetBuilt: false,     // light mode: true on first 'mode'; full: set by dataset_progress
  hashrateMax: 0,          // session-max for the htop-style hashrate bar
};

const params = new URLSearchParams(location.search);
// No SharedArrayBuffer (the page is not crossOriginIsolated, or ?sab=0 forces
// it for A/B): no pthreads, so mining runs as N single-thread workers on the
// randomx_st build (NoSabPool below), each in JIT'd light mode with its own
// 256 MiB cache (~300 MB per worker; ?threads=N caps it).
const noSab = params.get('sab') === '0' || window.crossOriginIsolated !== true;
// ?fb_full=K (0..2, no SAB only): K of those workers become full-dataset
// replicas (a private ~2.3 GB dataset each), built cooperatively by all workers
// (fb_full.js); a worker that can't allocate one stays in light mode.
const fbFull = noSab ? Math.max(0, Math.min(2, Math.floor(Number(params.get('fb_full')) || 0))) : 0;
// Full-memory mode is the default. Opt out with ?light=1 (or legacy ?full=0).
const fullMemory = !noSab && params.get('light') !== '1' && params.get('full') !== '0';
// JIT defaults: on for all engines. The threaded-interpreter + V2-minimal
// (split_inner_dispatch) path landed in worker.js makes the JIT a clear win
// everywhere — Safari 560 H/s, Chrome 530 H/s, Firefox 550+ at 32T on M4
// Mini. The old Safari-only auto-disable (which existed because per-program
// dynamic-module compile cost exceeded runtime saving on JSC) is no longer
// relevant once the resident-module path is the default. Opt out with
// ?nojit=1 / ?jit=0.
let jitDecision;
if (params.get('jit') === '0' || params.get('nojit') === '1') {
  jitDecision = false;
} else {
  jitDecision = true;
}
const enableJit = jitDecision;
const profileCore = params.get('profile') === '1';
const requestedThreads = Number(params.get('threads'));
const defaultThreads = fullMemory ? 32 : (navigator.hardwareConcurrency || 4);
let datasetThreads = Math.max(1, Math.min(32, requestedThreads || defaultThreads));
// Dataset init thread count is decoupled from mining threads. The em-pthread
// pool is 32 (build.sh:PTHREAD_POOL_SIZE), per-item init is independent
// compute on a read-mostly cache, so oversubscription on hardware threads
// is safe and helps wall-clock when hardwareConcurrency<32. Users at
// ?threads=1 used to wait ~150s for init on M4 Mini; now ~26s. Override
// for benchmarking with ?init_threads=N.
let datasetInitThreads = Math.max(1, Math.min(32,
  Number(params.get('init_threads')) || 32));

const $ = (id) => document.getElementById(id);

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function readLe(bytes, offset, len) {
  let value = 0n;
  for (let i = 0; i < len; i++) {
    value |= BigInt(bytes[offset + i]) << BigInt(i * 8);
  }
  return value;
}

function targetToDiff(targetHex) {
  const raw = hexToBytes(targetHex);
  let target = 0n;

  if (raw.length === 4) {
    const target32 = readLe(raw, 0, 4);
    if (target32 !== 0n) {
      target = 0xffffffffffffffffn / (0xffffffffn / target32);
    }
  } else if (raw.length === 8) {
    target = readLe(raw, 0, 8);
  } else if (raw.length >= 32) {
    target = readLe(raw, 24, 8);
  }

  return target ? Number(0xffffffffffffffffn / target) : 0;
}

function updateUI() {
  $('hashrateBar').innerHTML = renderHashrateBar(state.hashrate, state.hashrateMax)
    + ' ' + state.hashrate.toFixed(0).padStart(4, ' ') + ' H/s';
  $('hashrateMeta').textContent = state.hashrateMax > 0
    ? `max ${state.hashrateMax.toFixed(0)} H/s · session`
    : 'no samples yet';
  $('accepted').textContent = state.accepted;
  $('rejected').textContent = state.rejected;
  $('mode').textContent = state.mode;
  $('status').textContent = state.status;
  $('toggle').textContent = state.mining ? 'Stop' : 'Start';
  // Don't blow away .pulse — toggle only the .active modifier.
  $('toggle').classList.toggle('active', state.mining);
  updateMini();
}

// Pads numeric fields so digit-count changes don't shift the collapsed row.
function updateMini() {
  if (!$('miniEta')) return;
  // Time remaining to next share (negative = overdue, prefixed with +Ns).
  let etaText = '--';
  if (state.mining && state.shareEtaStart > 0 && state.shareEtaTotal > 0) {
    const remain = state.shareEtaTotal - (performance.now() - state.shareEtaStart) / 1000;
    etaText = remain >= 0
      ? Math.ceil(remain) + 's'
      : '+' + Math.ceil(-remain) + 's';
  }
  $('miniEta').textContent = etaText.padStart(5, ' ');
  $('miniShares').textContent = state.accepted + '/' + state.rejected;
  $('miniHashrate').textContent = state.hashrate.toFixed(0).padStart(4, ' ');
  $('miniToggle').textContent = state.mining ? 'Stop' : 'Start';
  $('miniToggle').classList.toggle('active', state.mining);
}

// htop-style hashrate bar: 40 cells, filled to round(current/max * 40), with
// the rightmost filled cell wrapped in .blink-cell so it pulses.
function renderHashrateBar(current, max) {
  if (!max || max <= 0 || !current || current <= 0) return '▱'.repeat(40);
  const ratio = Math.min(1, current / max);
  let n = Math.round(ratio * 40);
  if (n < 1) n = 1;
  if (n > 40) n = 40;
  return '▰'.repeat(n - 1) + '<span class="blink-cell">▰</span>' + '▱'.repeat(40 - n);
}

// 40-cell progress bar: ▰×n ▱×(40-n) NNN%. Tabular-nums in the CSS keeps the
// percent from jittering. Returns an HTML string (safe — content is fully
// controlled here). When opts.blinkOnOverflow is set and pct > 100, the last
// cell is wrapped in a .blink-cell span so CSS can pulse it.
function renderBar(pct, opts) {
  opts = opts || {};
  if (typeof pct !== 'number' || !isFinite(pct) || pct < 0) {
    return '▱'.repeat(40) + '  --%';
  }
  if (pct > 100 && opts.blinkOnOverflow) {
    const pctStr = Math.round(pct).toString().padStart(3, ' ') + '%';
    return '▰'.repeat(39) + '<span class="blink-cell">▰</span> ' + pctStr;
  }
  const p = Math.min(100, pct);
  const n = Math.round(p * 40 / 100);
  return '▰'.repeat(n) + '▱'.repeat(40 - n) + ' ' + p.toFixed(0).padStart(3, ' ') + '%';
}

function tickBars() {
  updateMini();
  if (state.mining && state.shareEtaStart > 0 && state.shareEtaTotal > 0) {
    const elapsed = (performance.now() - state.shareEtaStart) / 1000;
    const eta = state.shareEtaTotal;
    const pct = (elapsed / eta) * 100;
    $('shareBar').innerHTML = renderBar(pct, { blinkOnOverflow: true });
    if (pct > 100) {
      $('shareBarMeta').textContent =
        `${Math.floor(elapsed)}s elapsed · ~${Math.ceil(eta)}s mean · ${Math.ceil(elapsed - eta)}s over`;
    } else {
      $('shareBarMeta').textContent =
        `${Math.floor(elapsed)}s elapsed · ~${Math.ceil(eta)}s mean · ${Math.ceil(eta - elapsed)}s to go`;
    }
  } else {
    // Static idle render — bar at 0%, meta says why. No animation.
    $('shareBar').innerHTML = renderBar(0);
    $('shareBarMeta').textContent = state.mining ? 'awaiting hashrate' : 'not mining';
  }
}

function log(msg) {
  const el = $('log');
  // Only auto-scroll to the bottom if the user is already there (within a few
  // px of slop for sub-pixel rounding). If they've scrolled up to read older
  // entries, leave their position alone.
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.appendChild(line);
  if (atBottom) el.scrollTop = el.scrollHeight;
}

function scheduleReconnect(reason) {
  if (!state.mining || state.reconnectTimer) return;
  if (state.worker) state.worker.postMessage({ type: 'stop' });
  log(`${reason}; reconnecting in 5s...`);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connectWS();
  }, 5000);
}

function connectWS() {
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  state.nicehash = false;
  state.ws = new WebSocket(`${proto}//${location.host}`);

  state.ws.onopen = () => {
    state.status = 'connected to proxy';
    log('Connected to proxy');
    updateUI();

    // Tell the proxy which pool + wallet this session wants BEFORE login,
    // so it can reconnect upstream if the user customised them.
    const target = readConnectionInputs();
    state.ws.send(JSON.stringify({
      method: 'set_target',
      params: target,
      id: 0,
    }));
    log(`Pool target → ${target.host}:${target.port}, wallet ${(target.wallet || '').slice(0, 12)}…`);

    state.ws.send(JSON.stringify({
      method: 'login',
      params: {},
      id: 1,
    }));
  };

  state.ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);

    if (msg.error) {
      if (msg.id === 2) {
        state.rejected++;
        log('Share rejected: ' + (typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error)));
        updateUI();
        return;
      }

      const errorText = typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error);
      log('Error: ' + errorText);
      state.status = 'error';
      updateUI();
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.close();
      }
      scheduleReconnect('Pool connection error');
      return;
    }

    // Login response with first job
    if (msg.result && msg.result.job) {
      state.nicehash = Array.isArray(msg.result.extensions) && msg.result.extensions.includes('nicehash');
      log('Logged in, received first job');
      handleJob(msg.result.job);
    }

    // New job notification
    if (msg.method === 'job') {
      log('New job received');
      handleJob(msg.params);
    }

    // Share response. Login responses can also contain status OK, so only
    // count submit responses as shares.
    if (msg.id === 2 && msg.result && msg.result.status === 'OK') {
      state.accepted++;
      log('Share accepted! Total: ' + state.accepted);
      // Share-ETA bar resets only here (and on Start). Snapshot the eta with
      // the now-stable hashrate so the bar fills smoothly toward the next
      // share without jittering.
      state.shareEtaStart = performance.now();
      state.shareEtaTotal = state.hashrate > 0 && state.currentJobDiff > 0
        ? state.currentJobDiff / state.hashrate
        : 0;
      updateUI();
    }
  };

  state.ws.onclose = () => {
    state.status = 'disconnected';
    log('Disconnected from proxy');
    updateUI();
    scheduleReconnect('Disconnected');
  };

  state.ws.onerror = (e) => {
    log('WebSocket error');
  };
}

function handleJob(job) {
  if (!state.mining) return;
  job = { ...job, nicehash: state.nicehash };
  const diff = targetToDiff(job.target);
  state.currentJobId = job.job_id;
  state.currentJobSeq++;
  state.currentJobDiff = diff;
  state.lastJob = job;
  const eta = state.hashrate > 0 && diff > 0 ? `, est share ${Math.ceil(diff / state.hashrate)}s` : '';
  log(`Job diff ${diff || 'unknown'}${job.height ? ` height ${job.height}` : ''}${eta}`);
  // Worker may be null mid-rebuild; the cached lastJob is replayed on 'ready'.
  if (!state.worker || !state.workerReady) return;
  // Don't flip status to 'Mining' until the dataset is built — dataset_progress
  // owns the label until then.
  if (state.datasetBuilt || !fullMemory) state.status = `mining with ${datasetThreads} thread${datasetThreads === 1 ? '' : 's'}`;
  updateUI();
  state.worker.postMessage({
    type: 'job',
    blob: job.blob,
    target: job.target,
    seed_hash: job.seed_hash,
    job_id: job.job_id,
    job_seq: state.currentJobSeq,
    nicehash: job.nicehash,
  });
}

// Worker-shaped facade over N single-thread randomx_st workers (no SAB). It
// fans init/job/stop out (init with a disjoint nonce slot each), sums the
// per-worker hashrates, passes shares and errors through, emits 'ready' once
// all workers are ready, and forwards the chatty per-worker messages
// (status/jit/profile) from worker 0 only. With fbFull = K, workers 0..K-1 are
// replicas and an RxFbFull.FbCoordinator runs the dataset build per seed
// (its progress as 'dataset_progress'); 'mode' reports the full/light split.
class NoSabPool {
  constructor(n, vTag, fbFull = 0) {
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
    this.workers = [];
    this.rates = new Array(n).fill(0);
    this.ready = new Set();
    this.modes = new Array(n).fill(null);
    this.modeSent = '';
    this.full = Math.min(fbFull, n);
    this.fb = null;
    if (this.full > 0 && typeof RxFbFull !== 'undefined') {
      this.fb = new RxFbFull.FbCoordinator({
        n,
        full: [...Array(this.full).keys()],
        send: (i, m, transfer) => this.workers[i].postMessage(m, transfer || []),
        progress: (done, total, etaSec) => this._emit({ type: 'dataset_progress', done, total, etaSec, threads: n }),
        done: (seed, replicas) => this._emit({
          type: 'status', message: `fb_full: ${replicas.length}/${this.full} replica(s) mining in full mode`,
        }),
      });
    } else {
      this.full = 0;
    }
    for (let i = 0; i < n; i++) {
      const w = new Worker(`worker.js?v=${vTag}&build=st`, { name: `rx-st-${i}` });
      w.onmessage = (e) => this._recv(i, e.data);
      w.onerror = (e) => { if (this.onerror) this.onerror(e); };
      w.onmessageerror = (e) => { if (this.onmessageerror) this.onmessageerror(e); };
      this.workers.push(w);
    }
  }

  _emit(data) {
    if (this.onmessage) this.onmessage({ data });
  }

  _recv(i, msg) {
    if (this.fb && this.fb.recv(i, msg)) return;
    switch (msg.type) {
      case 'ready':
        this.ready.add(i);
        if (this.ready.size === this.workers.length) this._emit(msg);
        break;
      case 'hashrate':
        this.rates[i] = msg.rate;
        this._emit({ type: 'hashrate', rate: this.rates.reduce((a, b) => a + b, 0) });
        break;
      case 'mode': {
        this.modes[i] = msg.mode;
        const n = this.workers.length;
        const nFull = this.modes.filter((m) => m === 'full').length;
        const mode = nFull ? `${nFull} full + ${n - nFull} light (no SAB)` : `light (no SAB, ${n} workers)`;
        if (mode !== this.modeSent) {
          this.modeSent = mode;
          this._emit({ ...msg, mode });
        }
        break;
      }
      case 'share':
        this._emit(msg);
        break;
      case 'error':
        this._emit({ ...msg, message: `[worker ${i}] ${msg.message}` });
        break;
      default:
        if (i === 0) this._emit(msg);
    }
  }

  postMessage(msg) {
    if (msg.type === 'stop') this.rates.fill(0);
    // a new seed starts a build (the workers report fb_cache once rekeyed)
    if (this.fb && msg.type === 'job') this.fb.epoch(msg.seed_hash);
    const n = this.workers.length;
    this.workers.forEach((w, i) => {
      w.postMessage(msg.type === 'init'
        ? { ...msg, fullMemory: false, datasetThreads: 1, datasetInitThreads: 1, nonceSlot: i, nonceSlots: n,
            ...(this.fb ? { fbRole: i < this.full ? 'full' : 'light' } : {}) }
        : msg);
    });
  }

  terminate() {
    for (const w of this.workers) {
      try { w.terminate(); } catch (_) {}
    }
    this.workers = [];
  }
}

function initWorker() {
  if (state.worker) {
    if (state.workerReady) {
      connectWS();
    } else {
      state.pendingConnect = true;
    }
    return;
  }
  // ?coi=1: index.html is registering coi-sw.js and about to reload into an
  // isolated page; start after that (or on the no-SAB path if it gives up).
  if (window.__coiPending) {
    if (!state.coiWait) {
      state.coiWait = true;
      log('coi: waiting for the service worker reload...');
      window.addEventListener('coi-settled', () => { if (state.mining) initWorker(); }, { once: true });
    }
    return;
  }

  const vTag = (window.MINER_BUILD || 'dev').replace(/[^a-zA-Z0-9-]/g, '');
  state.worker = noSab ? new NoSabPool(datasetThreads, vTag, fbFull) : new Worker(`worker.js?v=${vTag}`);
  log(`build=${window.MINER_BUILD || '?'} (cside-jit split)`);
  if (noSab) {
    log(`No SharedArrayBuffer${params.get('sab') === '0' ? ' (forced by ?sab=0)' : ''}: ` +
        `${datasetThreads} single-thread light-mode workers (randomx_st, ~300 MB each)`);
    if (fbFull) {
      log(state.worker.full
        ? `fb_full=${fbFull}: ${state.worker.full} of them build and mine on a full dataset replica (~2.3 GB each)`
        : `fb_full=${fbFull}: fb_full.js not loaded, staying in light mode`);
    }
  }
  if (!enableJit) {
    log('JIT disabled by URL param.');
  }
  log(`crossOriginIsolated=${window.crossOriginIsolated === true}`);
  const swCtl = navigator.serviceWorker && navigator.serviceWorker.controller;
  if (swCtl && /\/coi-sw\.js$/.test(swCtl.scriptURL)) log('coi: service worker active (COOP/COEP injected; ?coi=0 removes it)');
  if (window.__coiLog) log(window.__coiLog);
  log(`navigator.hardwareConcurrency=${navigator.hardwareConcurrency || 'unknown'}, mining threads=${datasetThreads}, init threads=${datasetInitThreads}`);

  state.worker.onerror = (e) => {
    const location = e.filename ? ` (${e.filename}:${e.lineno || 0})` : '';
    log(`Worker error: ${e.message || 'unknown error'}${location}`);
    state.status = 'worker error';
    updateUI();
  };

  state.worker.onmessageerror = () => {
    log('Worker message error');
    state.status = 'worker error';
    updateUI();
  };

  state.worker.onmessage = (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'ready':
        log('WASM module loaded');
        state.workerReady = true;
        state.status = 'wasm ready';
        updateUI();
        if (state.mining || state.pendingConnect) {
          state.pendingConnect = false;
          connectWS();
        }
        // Replay the cached job after a rebuild so the fresh worker
        // rebuilds the dataset from the current seed and resumes hashing.
        if (state.mining && state.lastJob) {
          log('Replaying last job into fresh worker');
          const job = state.lastJob;
          state.worker.postMessage({
            type: 'job',
            blob: job.blob,
            target: job.target,
            seed_hash: job.seed_hash,
            job_id: job.job_id,
            job_seq: state.currentJobSeq,
            nicehash: job.nicehash,
          });
        }
        break;
      case 'hashrate':
        // Drop stale rate reports that arrive after a Stop — the worker's
        // last mineLoop slice posts one more rate before it sees mining=false,
        // and without this guard the cell would be pinned to a non-zero value
        // even though we're idle.
        if (!state.mining) break;
        state.hashrate = msg.rate;
        if (state.hashrate > state.hashrateMax) state.hashrateMax = state.hashrate;
        // Share-ETA: anchor the start clock on the first non-zero hashrate,
        // and TRACK the minimum eta seen since then (max hashrate). The first
        // sample is the worker's partial sub-second post-dataset slice and is
        // wildly pessimistic; locking it would peg the bar at ~0% for ages.
        // Tracking the minimum gives an optimistic eta that drops as the
        // worker ramps up, while keeping pct monotonically increasing.
        if (state.hashrate > 0 && state.currentJobDiff > 0) {
          const candidate = state.currentJobDiff / state.hashrate;
          if (state.shareEtaStart === 0) state.shareEtaStart = performance.now();
          if (state.shareEtaTotal === 0 || candidate < state.shareEtaTotal) {
            state.shareEtaTotal = candidate;
          }
        }
        updateUI();
        break;
      case 'share':
        log(`Found share! Nonce: ${msg.nonce}, share diff ${msg.share_diff || 'unknown'} / job diff ${msg.target_diff || state.currentJobDiff || 'unknown'}`);
        if (msg.job_id !== state.currentJobId) {
          log(`Dropped stale share for old job ${msg.job_id}`);
          break;
        }
        if (msg.job_seq && msg.job_seq !== state.currentJobSeq) {
          log(`Dropped stale share for old job sequence ${msg.job_seq}`);
          break;
        }
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({
            method: 'submit',
            params: {
              job_id: msg.job_id,
              nonce: msg.nonce,
              result: msg.result,
            },
            id: 2,
          }));
        } else {
          log('Share not submitted: pool connection is not open');
        }
        break;
      case 'nonce_exhausted':
        if (state.mining && msg.job_id === state.currentJobId && msg.job_seq === state.currentJobSeq) {
          state.hashrate = 0;
          state.status = 'nonce range exhausted; waiting for a new job';
          log(state.status);
          updateUI();
        }
        break;
      case 'mode':
        state.mode = msg.mode;
        log(`Mining mode: ${msg.mode}`);
        // 'mode' fires after the dataset is fully built (or immediately for
        // light mode). Safe to consider the dataset ready from this point.
        state.datasetBuilt = true;
        updateUI();
        break;
      case 'jit': {
        const stats = msg.stats || {};
        if (stats.enabled && stats.failCount && stats.lastError && stats.lastError !== state.lastJitError) {
          state.lastJitError = stats.lastError;
          log(`JIT fallback: ${stats.lastError}`);
        }
        break;
      }
      case 'profile': {
        const total = msg.initMs + msg.runMs + msg.finalMs;
        if (total > 0) {
          const pct = (v) => ((v / total) * 100).toFixed(1);
          const runOtherMs = Math.max(0, msg.runMs - (msg.bytecodeMs || 0));
          log(`Core profile ${Math.round(msg.hashes)} hashes: init ${pct(msg.initMs)}%, bytecode ${pct(msg.bytecodeMs || 0)}%, run-other ${pct(runOtherMs)}%, final ${pct(msg.finalMs)}%`);
        }
        break;
      }
      case 'status':
        // Don't overwrite state.status with chatty worker text — that was the
        // cause of the flashing/overflow in the Status field. Log-only.
        log(msg.message);
        break;
      case 'dataset_progress': {
        const pct = msg.total > 0 ? (msg.done / msg.total) * 100 : 0;
        $('datasetBarRow').hidden = false;
        $('datasetBar').textContent = renderBar(pct);
        $('datasetBarMeta').textContent =
          msg.done >= msg.total
            ? `complete · ${msg.threads} init threads`
            : `~${msg.etaSec}s remaining · ${msg.threads} init threads`;
        if (msg.done >= msg.total) {
          state.datasetBuilt = true;
          if (state.mining) state.status = `mining with ${datasetThreads} thread${datasetThreads === 1 ? '' : 's'}`;
        } else {
          state.datasetBuilt = false;
          state.status = 'building dataset';
        }
        updateUI();
        break;
      }
      case 'error':
        log('Error: ' + msg.message);
        state.status = 'error';
        updateUI();
        break;
    }
  };

  const jitExperiment = params.get('jit_exp') || '';
  if (jitExperiment) {
    const tokens = jitExperiment.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    // 'reuse' / 'reuse2' are the only modes that produce wrong hashes; the
    // rest (threaded / regs_mem / inline_fprc / no_*) are all correctness-
    // preserving and just toggle codegen.
    const wrongHash = tokens.includes('reuse') || tokens.includes('reuse2');
    if (wrongHash) {
      log(`JIT experiment mode active: ${jitExperiment} (hashes will be WRONG; use only for timing analysis)`);
    } else {
      log(`JIT experiment mode active: ${jitExperiment} (hashes are correct)`);
    }
  }
  // ?jit_profile=auto|arm|x86: threaded-module generator profile (worker.js).
  const jitProfile = params.get('jit_profile') || 'auto';
  state.worker.postMessage({ type: 'init', enableJit, fullMemory, datasetThreads, datasetInitThreads, profileCore, jitExperiment, jitProfile });
}

// Reads the threads input (the only source of truth the user can edit) and
// returns a clamped 1-32 integer.
function readDesiredThreads() {
  const inputEl = $('rebuildThreads');
  if (!inputEl) return datasetThreads;
  return Math.max(1, Math.min(32, Math.floor(Number(inputEl.value) || 1)));
}

function toggle() {
  // One-shot: kill the attention pulse the moment the user engages either
  // Start button (or hits Stop later — both call this).
  $('toggle').classList.remove('pulse');
  if ($('miniToggle')) $('miniToggle').classList.remove('pulse');
  if (state.mining) {
    state.mining = false;
    state.hashrate = 0;
    state.hashrateMax = 0;
    state.status = 'stopped';
    state.currentJobId = null;
    state.currentJobSeq = 0;
    state.currentJobDiff = 0;
    state.shareEtaStart = 0;
    state.shareEtaTotal = 0;
    state.datasetBuilt = false;
    state.lastJob = null;
    // Reset the dataset bar to its idle "not started" look.
    $('datasetBar').textContent = renderBar(0);
    $('datasetBarMeta').textContent = 'not started';
    state.mode = 'standby';
    if (state.worker) state.worker.postMessage({ type: 'stop' });
    if (state.ws) state.ws.close();
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    state.ws = null;
    log('Mining stopped');
  } else {
    // Sync datasetThreads from the input so the very first Start picks up
    // any value the user set before clicking. If a (paused) worker is sitting
    // around from a previous run with a different thread count, terminate it
    // so the new count actually takes effect — otherwise initWorker() would
    // reuse the stale instance.
    const desired = readDesiredThreads();
    if (desired !== datasetThreads) {
      datasetThreads = desired;
      if (state.worker) {
        log(`Threads changed to ${datasetThreads}; terminating stale worker`);
        try { state.worker.terminate(); } catch (_) {}
        state.worker = null;
        state.workerReady = false;
      }
    }
    state.mining = true;
    state.status = 'starting…';
    state.shareEtaStart = 0;
    state.shareEtaTotal = 0;
    state.hashrateMax = 0;
    state.datasetBuilt = false;
    log(`Starting miner${enableJit ? '' : ' without JIT'} in ${fullMemory ? `full mode (${datasetThreads} threads)` : 'light mode'}${profileCore ? ' with core profile' : ''}...`);
    initWorker();
  }
  updateUI();
}

// Hard rebuild: terminate the worker entirely and respawn with the requested
// thread count. This avoids destroy_mining_context (Emscripten pthread join
// corrupts wasm memory). The new worker re-runs init from scratch; on 'ready'
// state.lastJob is replayed so it rebuilds the dataset and resumes hashing.
function hardRebuild(newThreads) {
  const clamped = Math.max(1, Math.min(32, Math.floor(Number(newThreads) || 1)));
  datasetThreads = clamped;

  // A "hard rebuild" always means a fresh wasm instance. Terminate the
  // existing worker unconditionally — otherwise the Stop→change-threads
  // →Hard-rebuild path would silently reuse the paused worker (which still
  // holds the old datasetThreads baked into its mineCtx).
  if (state.worker) {
    try { state.worker.terminate(); } catch (_) {}
    state.worker = null;
    state.workerReady = false;
  }

  if (!state.mining) {
    log(`Hard rebuild: starting miner with ${datasetThreads} threads`);
    toggle();
    return;
  }
  if (!state.lastJob) {
    log('Hard rebuild: no job cached yet, will pick up first job from pool');
    initWorker();
    return;
  }

  log(`Hard rebuild: respawning worker with ${datasetThreads} threads`);
  state.status = `rebuilding with ${datasetThreads} thread${datasetThreads === 1 ? '' : 's'}…`;
  state.hashrate = 0;
  state.hashrateMax = 0;
  state.shareEtaStart = 0;
  state.shareEtaTotal = 0;
  state.datasetBuilt = false;
  // Reset the dataset bar so the rebuild is visible immediately.
  $('datasetBarRow').hidden = false;
  $('datasetBar').textContent = renderBar(0);
  $('datasetBarMeta').textContent = 'starting…';
  updateUI();
  // Worker already terminated above; initWorker() spawns a fresh one and the
  // 'ready' handler replays state.lastJob.
  initWorker();
}

$('toggle').addEventListener('click', toggle);

const threadsInput = $('rebuildThreads');
const miniThreadsInput = $('miniThreads');
if (threadsInput) {
  threadsInput.value = String(datasetThreads);
  $('rebuildBtn').addEventListener('click', () => {
    hardRebuild(threadsInput.value);
  });
}
if (miniThreadsInput) {
  miniThreadsInput.value = String(datasetThreads);
  // Two-way sync with the expanded input.
  miniThreadsInput.addEventListener('input', () => {
    if (threadsInput) threadsInput.value = miniThreadsInput.value;
  });
  if (threadsInput) {
    threadsInput.addEventListener('input', () => {
      miniThreadsInput.value = threadsInput.value;
    });
  }
  $('miniToggle').addEventListener('click', toggle);
  $('miniRebuild').addEventListener('click', () => {
    hardRebuild(miniThreadsInput.value);
  });
}

// ───── Connection settings (wallet + pool host:port + donate macro) ────────

const LS_WALLET    = 'rxminer.wallet';
const LS_POOL_HOST = 'rxminer.pool_host';
const LS_POOL_PORT = 'rxminer.pool_port';
const LS_WORKER    = 'rxminer.worker';

// Pool presets the user can one-click into the host/port inputs. Plain TCP
// only — the proxy doesn't wrap pool sockets in TLS, so TLS-only ports of
// each pool are intentionally omitted.
const POOL_PRESETS = {
  supportxmr:   { host: 'pool.supportxmr.com',     port: 3333  },
  moneroocean:  { host: 'gulf.moneroocean.stream', port: 10004 },
};

// Defaults injected by the proxy via window.MINER_DEFAULTS (rewritten from
// config.js at serve time). Fall back to empty strings if not present so
// the page still works when served outside the proxy.
const MINER_DEFAULTS = (window.MINER_DEFAULTS && typeof window.MINER_DEFAULTS === 'object')
  ? window.MINER_DEFAULTS
  : { wallet: '', poolHost: '', poolPort: '' };

function readStored(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return (v == null || v === '') ? fallback : v;
  } catch (_) { return fallback; }
}

const walletInput   = $('walletInput');
const poolHostInput = $('poolHostInput');
const poolPortInput = $('poolPortInput');
const workerInput   = $('workerInput');

// Wallet truncation: store the full address in .dataset.full; only that is
// authoritative. The visible input.value is the truncated `WWWWWWWW……WWWWWWWW`
// form while blurred. On focus the field swaps back to full text so the user
// can edit normally.
function truncateAddr(addr) {
  if (!addr || addr.length <= 20) return addr || '';
  return addr.slice(0, 8) + '……' + addr.slice(-8);
}
function getFullWallet() {
  if (!walletInput) return '';
  return (walletInput.dataset.full || walletInput.value || '').trim();
}
function setFullWallet(full) {
  if (!walletInput) return;
  const v = (full || '').trim();
  walletInput.dataset.full = v;
  walletInput.value = (document.activeElement === walletInput) ? v : truncateAddr(v);
}

const initWallet = readStored(LS_WALLET, MINER_DEFAULTS.wallet);
const initHost   = readStored(LS_POOL_HOST, MINER_DEFAULTS.poolHost);
const initPort   = readStored(LS_POOL_PORT, MINER_DEFAULTS.poolPort);
const initWorkerName = readStored(LS_WORKER, '');
if (walletInput)   setFullWallet(initWallet);
if (poolHostInput) poolHostInput.value = initHost;
if (poolPortInput) poolPortInput.value = initPort;
if (workerInput)   workerInput.value   = initWorkerName;

function persistConnection() {
  try {
    if (walletInput)   localStorage.setItem(LS_WALLET,    getFullWallet());
    if (poolHostInput) localStorage.setItem(LS_POOL_HOST, poolHostInput.value.trim());
    if (poolPortInput) localStorage.setItem(LS_POOL_PORT, poolPortInput.value.trim());
    if (workerInput)   localStorage.setItem(LS_WORKER,    workerInput.value.trim());
  } catch (_) {}
}

if (walletInput) {
  walletInput.addEventListener('focus', () => {
    walletInput.value = getFullWallet();
  });
  walletInput.addEventListener('input', () => {
    walletInput.dataset.full = walletInput.value.trim();
  });
  walletInput.addEventListener('blur', () => {
    walletInput.dataset.full = walletInput.value.trim();
    walletInput.value = truncateAddr(walletInput.dataset.full);
    persistConnection();
  });
}
if (poolHostInput) poolHostInput.addEventListener('change', persistConnection);
if (poolPortInput) poolPortInput.addEventListener('change', persistConnection);
if (workerInput)   workerInput.addEventListener('change',   persistConnection);

function readConnectionInputs() {
  return {
    wallet: getFullWallet() || MINER_DEFAULTS.wallet || '',
    host:   (poolHostInput && poolHostInput.value.trim()) || MINER_DEFAULTS.poolHost || '',
    port:   Number((poolPortInput && poolPortInput.value.trim()) || MINER_DEFAULTS.poolPort) || 0,
    worker: (workerInput && workerInput.value.trim()) || '',
  };
}

// Apply a pool preset (host + port only). Wallet and worker stay as the
// user set them.
function applyPreset(name) {
  const p = POOL_PRESETS[name];
  if (!p) return;
  if (poolHostInput) poolHostInput.value = p.host;
  if (poolPortInput) poolPortInput.value = String(p.port);
  persistConnection();
  log(`Preset → ${name} (${p.host}:${p.port})`);
}
const presetSupportxmrBtn  = $('presetSupportxmr');
const presetMonerooceanBtn = $('presetMoneroocean');
if (presetSupportxmrBtn)  presetSupportxmrBtn.addEventListener('click',  () => applyPreset('supportxmr'));
if (presetMonerooceanBtn) presetMonerooceanBtn.addEventListener('click', () => applyPreset('moneroocean'));

// Wallet-setup collapse — toggles worker/preset/pool rows. Initial state is
// collapsed (those rows are advanced; most users just want wallet + Set).
// Persisted to localStorage so the choice survives reload.
const LS_SETUP_COLLAPSED = 'rxminer.setup_collapsed';
const setupToggle   = $('setupToggle');
const walletSection = $('walletSection');
if (setupToggle && walletSection) {
  let collapsed = readStored(LS_SETUP_COLLAPSED, '1') !== '0';
  const apply = () => {
    walletSection.classList.toggle('expanded', !collapsed);
    setupToggle.textContent = collapsed ? '[+]' : '[-]';
  };
  apply();
  setupToggle.addEventListener('click', () => {
    collapsed = !collapsed;
    apply();
    try { localStorage.setItem(LS_SETUP_COLLAPSED, collapsed ? '1' : '0'); } catch (_) {}
  });
}


const donateBtn = $('donateBtn');
if (donateBtn) {
  donateBtn.addEventListener('click', () => {
    if (walletInput)   setFullWallet(MINER_DEFAULTS.wallet);
    if (poolHostInput) poolHostInput.value = MINER_DEFAULTS.poolHost;
    if (poolPortInput) poolPortInput.value = MINER_DEFAULTS.poolPort;
    persistConnection();
    log('Donation defaults loaded — Hard rebuild (or Stop/Start) to apply');
  });
}

// "Set" button: commits the wallet + pool inputs to localStorage and opens
// a throwaway WebSocket to the proxy, sends set_target + a probe login, and
// reports back whether the pool accepted the address.
const setAddressBtn = $('setAddressBtn');
if (setAddressBtn) {
  setAddressBtn.addEventListener('click', () => {
    persistConnection();
    const target = readConnectionInputs();
    if (!target.wallet || !target.host || !target.port) {
      log('Set: wallet, host, and port are all required');
      return;
    }
    log(`Testing handshake → ${target.host}:${target.port}, wallet ${target.wallet.slice(0, 12)}…`);
    setAddressBtn.disabled = true;
    setAddressBtn.textContent = 'Testing…';

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const probe = new WebSocket(`${proto}//${location.host}`);
    let done = false;
    const finish = (text) => {
      if (done) return;
      done = true;
      log(text);
      try { probe.close(); } catch (_) {}
      setAddressBtn.disabled = false;
      setAddressBtn.textContent = 'Set';
    };

    probe.onopen = () => {
      probe.send(JSON.stringify({ method: 'set_target', params: target, id: 0 }));
      probe.send(JSON.stringify({ method: 'login',      params: {},     id: 99 }));
    };
    probe.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch (_) { return; }
      if (msg.error) {
        const err = typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error);
        finish(`Handshake FAILED: ${err}`);
      } else if (msg.id === 99 && msg.result) {
        finish(`Handshake OK — pool accepted login (job ${msg.result.job ? msg.result.job.job_id : '?'})`);
      }
    };
    probe.onerror = () => finish('Handshake FAILED: WebSocket error');
    setTimeout(() => finish('Handshake TIMEOUT (no pool response in 6 s)'), 6000);
  });
}

updateUI();
tickBars();
setInterval(tickBars, 1000);

// ───── Lorem ipsum scrollable background ────────────────────────────────────

(function setupLorem() {
  const bg = $('loremBg');
  if (!bg) return;
  const para = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.';
  const headings = [
    'de natura miner', 'wasm musings', 'on the dataset', 'thread harmony',
    'cryptographic prose', 'hash incantations', 'p2pool ponderings', 'randomx reverie',
  ];
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 36; i++) {
    if (i % 4 === 0) {
      const h = document.createElement('h2');
      h.textContent = headings[(i / 4) % headings.length];
      frag.appendChild(h);
    }
    const p = document.createElement('p');
    p.textContent = para;
    frag.appendChild(p);
  }
  bg.appendChild(frag);
})();

// ───── Floating widget: drag + collapse ─────────────────────────────────────

(function setupWidget() {
  const widget = $('widget');
  const header = $('widgetHeader');
  const toggle = $('widgetToggle');
  if (!widget || !header || !toggle) return;

  let dragOffset = null;

  function beginDrag(clientX, clientY) {
    const rect = widget.getBoundingClientRect();
    dragOffset = { x: clientX - rect.left, y: clientY - rect.top };
    // Switch from transform-centering to explicit left/top so we can move it.
    widget.style.transform = 'none';
    widget.style.left = rect.left + 'px';
    widget.style.top = rect.top + 'px';
    widget.classList.add('dragging');
  }

  function moveDrag(clientX, clientY) {
    if (!dragOffset) return;
    const w = widget.offsetWidth;
    const h = widget.offsetHeight;
    let nx = clientX - dragOffset.x;
    let ny = clientY - dragOffset.y;
    nx = Math.max(0, Math.min(window.innerWidth - w, nx));
    ny = Math.max(0, Math.min(window.innerHeight - h, ny));
    widget.style.left = nx + 'px';
    widget.style.top = ny + 'px';
  }

  function endDrag() {
    dragOffset = null;
    widget.classList.remove('dragging');
  }

  header.addEventListener('mousedown', (e) => {
    if (e.target === toggle || toggle.contains(e.target)) return;
    e.preventDefault();
    beginDrag(e.clientX, e.clientY);
  });
  window.addEventListener('mousemove', (e) => moveDrag(e.clientX, e.clientY));
  window.addEventListener('mouseup', endDrag);

  // Touch support: same flow.
  header.addEventListener('touchstart', (e) => {
    if (e.target === toggle || toggle.contains(e.target)) return;
    const t = e.touches[0];
    beginDrag(t.clientX, t.clientY);
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (!dragOffset) return;
    const t = e.touches[0];
    moveDrag(t.clientX, t.clientY);
  }, { passive: true });
  window.addEventListener('touchend', endDrag);

  toggle.addEventListener('click', () => {
    widget.classList.toggle('collapsed');
    toggle.textContent = widget.classList.contains('collapsed') ? '[+]' : '[-]';
  });
})();
