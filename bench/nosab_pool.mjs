// The browser NoSabPool in Node: N worker_threads, each loading randomx_st.js
// (non-shared memory, no pthreads; no SharedArrayBuffer anywhere), each with
// its own light cache and a light VM on the JIT'd path (threaded interpreter +
// embedded superscalar item fn, configured like light_mode_check), and a
// disjoint nonce slot (nonce = slot + k*N at offset 39, like worker.js).
// With full > 0, workers 0..full-1 are replicas: all workers build their
// datasets cooperatively over public/fb_full.js (the browser's coordinator and
// worker side, same messages over parentPort), then they mine in full mode.
// Used by nosab_bench.mjs and fb_full_check.mjs.
//
//   const pool = await startNoSabPool({ workers, full, key, featureBase, prof });
//   pool.info[i]     ready message: {header}
//   pool.buildMs     cooperative dataset build, first chunk dispatch to the last replica
//                    in full mode (0 without replicas)
//   pool.modes[i]    'full' | 'light' after the build
//   await pool.request(i, msg, replyType)
//   await pool.rekey(key)   new seed: caches rebuilt, the dataset build repeats
//   pool.terminate()
//
// Worker messages: {type:'go', epoch, warmup, secs} runs the bench window (see nosab_bench)
// and replies 'done'; {type:'hashes', inputs:[Buffer], jit} hashes each input
// (jit false: the portable interpreter) and replies {type:'hashes', hashes:[hex], full};
// {type:'rekey', key} rebuilds the cache for key.

import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { applyProfile, profileHeader } from './profile_args.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);
const { FbWorker, FbCoordinator } = require(join(__dirname, '..', 'public', 'fb_full.js'));
const loadModule = () => require(join(__dirname, '..', 'public', 'randomx_st.js'))();
export const BLOB_LEN = 76, NONCE_OFF = 39;

// Configures the JIT like light_mode_check.
function setupJit(Module, featureBase, prof) {
  let maxPages = 65536;
  try { const d = Module.wasmMemory.type(); if (d && d.maximum) maxPages = d.maximum; } catch (_) {}
  Module._rxjit_set_max_memory_pages(maxPages);
  Module._rxjit_set_use_threaded_interp(1);
  Module._rxjit_set_regs_in_memory(1);
  Module._rxjit_set_split_inner_dispatch(1);
  Module._rxjit_set_feature(featureBase | 4);
  applyProfile(Module, prof);
  Module._rxSetJitEnabled(1);
}

export async function startNoSabPool({ workers: n, full = 0, key, featureBase = 3, prof }) {
  full = Math.max(0, Math.min(full, n));
  const workers = [];
  const modes = new Array(n).fill('light');
  const listeners = new Array(n).fill(null).map(() => new Set());
  let fail;
  const failed = new Promise((_, rej) => { fail = rej; });
  let build = null; // {start, end, done}: the current epoch's cooperative build
  const newBuild = () => {
    build = { start: 0, end: 0 };
    build.done = new Promise((res) => { build.resolve = res; });
  };
  const fb = full > 0 ? new FbCoordinator({
    n, full: [...Array(full).keys()],
    send: (i, msg, transfer) => workers[i].postMessage(msg, transfer || []),
    progress: () => { if (!build.start) build.start = performance.now(); }, // first call: the chunk work starts
    done: () => { build.end = performance.now(); build.resolve(); },
  }) : null;
  const awaitBuild = async () => {
    if (!fb) return 0;
    await Promise.race([build.done, failed]);
    return build.end - (build.start || build.end);
  };
  if (fb) { newBuild(); fb.epoch(key); }
  const ready = [];
  for (let i = 0; i < n; i++) {
    const w = new Worker(__filename, {
      workerData: { nosabPool: true, slot: i, slots: n, role: fb ? (i < full ? 'full' : 'light') : null,
        key, featureBase, prof },
    });
    w.on('error', (e) => fail(e));
    w.on('message', (m) => {
      if (fb && fb.recv(i, m)) return;
      if (m.type === 'mode') modes[i] = m.mode;
      if (m.type === 'log') console.log(`  [worker ${i}] ${m.message}`);
      for (const l of listeners[i]) l(m);
    });
    workers.push(w);
    ready.push(new Promise((res) => {
      const l = (m) => { if (m.type === 'ready') { listeners[i].delete(l); res(m); } };
      listeners[i].add(l);
    }));
  }
  const info = await Promise.race([Promise.all(ready), failed]);
  const pool = {
    workers, info, modes,
    buildMs: await awaitBuild(),
    request(i, msg, replyType) {
      return new Promise((res) => {
        const l = (m) => { if (m.type === replyType) { listeners[i].delete(l); res(m); } };
        listeners[i].add(l);
        workers[i].postMessage(msg);
      });
    },
    // New seed (epoch): every worker rebuilds its cache, the replicas go back
    // to light mode and the dataset build repeats. Resolves with its build ms.
    async rekey(k) {
      if (fb) { newBuild(); fb.epoch(k); }
      for (const w of workers) w.postMessage({ type: 'rekey', key: k });
      pool.buildMs = await awaitBuild();
      return pool.buildMs;
    },
    terminate() { for (const w of workers) w.terminate(); },
  };
  return pool;
}

if (!isMainThread && workerData && workerData.nosabPool) {
  const { slot, slots, role, key, featureBase, prof } = workerData;
  const Module = await loadModule();
  setupJit(Module, featureBase, prof);
  if (role) Module._rxjit_set_supjit_enabled(1); // the chunk kernel
  const c = (n, r, a) => Module.cwrap(n, r, a);
  const calc = c('randomx_calculate_hash', null, ['number', 'number', 'number', 'number']);
  const post = (m, t) => parentPort.postMessage(m, t || []);
  let seed = null, cache = 0, vm = 0, full = false;
  const setKey = (k) => { // new light cache + light VM (the replica keeps its dataset)
    if (vm) Module._randomx_destroy_vm(vm);
    if (cache) Module._randomx_release_cache(cache);
    cache = Module._randomx_alloc_cache(0);
    if (!cache) throw new Error('alloc_cache failed');
    const kb = Buffer.from(k);
    const kp = Module._malloc(kb.length);
    Module.HEAPU8.set(kb, kp);
    Module._randomx_init_cache(cache, kp, kb.length);
    Module._free(kp);
    vm = Module._randomx_create_vm(0, cache, 0);
    if (!vm) throw new Error('create_vm failed');
    seed = k;
    full = false;
  };
  setKey(key);

  const fb = role ? new FbWorker({
    Module, full: role === 'full', post,
    seed: () => seed,
    cache: () => cache,
    finalize: (ds) => { // like worker.js: full-mode VM on the dataset, then drop the cache
      const v = Module._randomx_create_vm(4, 0, ds); // RANDOMX_FLAG_FULL_MEM
      if (!v) return false;
      Module._randomx_destroy_vm(vm);
      vm = v;
      Module._randomx_release_cache(cache);
      cache = 0;
      full = true;
      post({ type: 'mode', mode: 'full' });
      return true;
    },
    log: (message) => post({ type: 'log', message }),
  }) : null;

  const inPtr = Module._malloc(BLOB_LEN), outPtr = Module._malloc(32);
  const blob = new Uint8Array(BLOB_LEN);
  for (let j = 0; j < BLOB_LEN; j++) blob[j] = (j * 131 + 7) & 0xff;
  Module.HEAPU8.set(blob, inPtr);
  let nonce = slot;
  const hash = () => {
    const h = Module.HEAPU8; // re-read: the heap view can change on memory growth
    h[inPtr + NONCE_OFF] = nonce; h[inPtr + NONCE_OFF + 1] = nonce >>> 8;
    h[inPtr + NONCE_OFF + 2] = nonce >>> 16; h[inPtr + NONCE_OFF + 3] = nonce >>> 24;
    calc(vm, inPtr, BLOB_LEN, outPtr);
    nonce = (nonce + slots) >>> 0;
  };
  // JIT'd programs run so far (light and full mode count separately in C)
  const jitRuns = () => (full ? Module._rxjit_stat_runs() : Module._rxjit_stat_light_runs()) >>> 0;
  const wall = () => performance.timeOrigin + performance.now();

  parentPort.on('message', (m) => {
    if (fb && fb.handle(m)) return;
    if (m.type === 'rekey') {
      setKey(m.key);
      post({ type: 'mode', mode: 'light' });
      if (fb) fb.cacheReady(m.key);
    } else if (m.type === 'go') {
      const { epoch, warmup, secs } = m;
      const r0 = jitRuns();
      while (wall() < epoch) {}
      const mStart = epoch + warmup * 1000, mEnd = mStart + secs * 1000;
      let all = 0;
      while (wall() < mStart) { hash(); all++; }
      // Count the hashes that start and finish inside the window.
      let n = 0, t = wall(), first = t, last = t;
      while (t < mEnd) {
        hash(); all++;
        const e = wall();
        if (e > mEnd) break;
        n++; last = t = e;
      }
      post({ type: 'done', hashes: n, secs: (last - first) / 1000, allHashes: all, jitRuns: jitRuns() - r0 });
    } else if (m.type === 'hashes') {
      if (!m.jit) Module._rxSetJitEnabled(0);
      const hashes = m.inputs.map((input) => {
        const p = Module._malloc(input.length);
        Module.HEAPU8.set(input, p);
        calc(vm, p, input.length, outPtr);
        Module._free(p);
        return Buffer.from(Module.HEAPU8.subarray(outPtr, outPtr + 32)).toString('hex');
      });
      if (!m.jit) Module._rxSetJitEnabled(1);
      post({ type: 'hashes', hashes, full, jitRuns: jitRuns() });
    }
  });
  post({ type: 'ready', header: profileHeader(Module, prof) });
  if (fb) fb.cacheReady(key);
}
