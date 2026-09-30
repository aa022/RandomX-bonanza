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
//   const pool = await startNoSabPool({ workers, full, key, featureBase, prof, lightVms });
//   pool.info[i]     ready message: {header, lightVms}
//   pool.buildMs     cooperative dataset build, first chunk dispatch to the last replica
//                    in full mode (0 without replicas)
//   pool.modes[i]    'full' | 'light' after the build
//   await pool.request(i, msg, replyType)
//   await pool.rekey(key)   new seed: caches rebuilt, the dataset build repeats
//   pool.terminate()
//
// Worker messages: {type:'go', epoch, warmup, secs} runs the bench window (see nosab_bench)
// and replies 'done' (with lightVms 2 a light worker hashes two nonces per call on two
// VMs in lockstep, rxLightHash2, and 'done' carries pairRuns); {type:'hashes', inputs:[Buffer], jit} hashes each input
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

// Configures the JIT like light_mode_check. Returns the effective light VMs.
function setupJit(Module, featureBase, prof, lightVms) {
  let maxPages = 65536;
  try { const d = Module.wasmMemory.type(); if (d && d.maximum) maxPages = d.maximum; } catch (_) {}
  Module._rxjit_set_max_memory_pages(maxPages);
  Module._rxjit_set_use_threaded_interp(1);
  Module._rxjit_set_regs_in_memory(1);
  Module._rxjit_set_split_inner_dispatch(1);
  Module._rxjit_set_feature(featureBase | 4);
  applyProfile(Module, prof);
  Module._rxSetJitEnabled(1);
  if (lightVms > 1 && Module._rxjit_set_light_vms) {
    Module._rxjit_set_light_vms(lightVms);
    return Module._rxjit_effective_light_vms();
  }
  return 1;
}

export async function startNoSabPool({ workers: n, full = 0, key, featureBase = 3, prof, lightVms = 1 }) {
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
        key, featureBase, prof, lightVms },
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
  const lightVms = setupJit(Module, featureBase, prof, workerData.lightVms);
  if (role) Module._rxjit_set_supjit_enabled(1); // the chunk kernel
  const c = (n, r, a) => Module.cwrap(n, r, a);
  const calc = c('randomx_calculate_hash', null, ['number', 'number', 'number', 'number']);
  const post = (m, t) => parentPort.postMessage(m, t || []);
  const hash2 = c('rxLightHash2', null, ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number']);
  let seed = null, cache = 0, vm = 0, vm2 = 0, full = false;
  const setKey = (k) => { // new light cache + light VM(s) (the replica keeps its dataset)
    if (vm) Module._randomx_destroy_vm(vm);
    if (vm2) Module._randomx_destroy_vm(vm2);
    vm2 = 0;
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
    // light_vms 2: a second VM on the same cache; one call hashes two nonces
    if (lightVms === 2 && !(vm2 = Module._randomx_create_vm(0, cache, 0))) throw new Error('create_vm failed');
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
      if (vm2) Module._randomx_destroy_vm(vm2); // on the cache
      vm2 = 0;
      Module._randomx_release_cache(cache);
      cache = 0;
      full = true;
      post({ type: 'mode', mode: 'full' });
      return true;
    },
    log: (message) => post({ type: 'log', message }),
  }) : null;

  const inPtr = Module._malloc(BLOB_LEN), outPtr = Module._malloc(32);
  const inPtr2 = Module._malloc(BLOB_LEN), outPtr2 = Module._malloc(32);
  const blob = new Uint8Array(BLOB_LEN);
  for (let j = 0; j < BLOB_LEN; j++) blob[j] = (j * 131 + 7) & 0xff;
  Module.HEAPU8.set(blob, inPtr);
  Module.HEAPU8.set(blob, inPtr2);
  let nonce = slot;
  const setNonce = (p) => {
    const h = Module.HEAPU8; // re-read: the heap view can change on memory growth
    h[p + NONCE_OFF] = nonce; h[p + NONCE_OFF + 1] = nonce >>> 8;
    h[p + NONCE_OFF + 2] = nonce >>> 16; h[p + NONCE_OFF + 3] = nonce >>> 24;
    nonce = (nonce + slots) >>> 0;
  };
  // Returns the number of hashes done.
  const hash = () => {
    if (vm2) {
      setNonce(inPtr); setNonce(inPtr2);
      hash2(vm, inPtr, BLOB_LEN, outPtr, vm2, inPtr2, BLOB_LEN, outPtr2);
      return 2;
    }
    setNonce(inPtr);
    calc(vm, inPtr, BLOB_LEN, outPtr);
    return 1;
  };
  // JIT'd programs run so far (light and full mode count separately in C)
  const jitRuns = () => (full ? Module._rxjit_stat_runs() : Module._rxjit_stat_light_runs()) >>> 0;
  const pairRuns = () => (Module._rxjit_stat_light_pair_runs ? Module._rxjit_stat_light_pair_runs() >>> 0 : 0);
  const wall = () => performance.timeOrigin + performance.now();

  parentPort.on('message', (m) => {
    if (fb && fb.handle(m)) return;
    if (m.type === 'rekey') {
      setKey(m.key);
      post({ type: 'mode', mode: 'light' });
      if (fb) fb.cacheReady(m.key);
    } else if (m.type === 'go') {
      const { epoch, warmup, secs } = m;
      const r0 = jitRuns(), p0 = pairRuns();
      while (wall() < epoch) {}
      const mStart = epoch + warmup * 1000, mEnd = mStart + secs * 1000;
      let all = 0;
      while (wall() < mStart) all += hash();
      // Count the hashes that start and finish inside the window.
      let n = 0, t = wall(), first = t, last = t;
      while (t < mEnd) {
        const k = hash();
        all += k;
        const e = wall();
        if (e > mEnd) break;
        n += k; last = t = e;
      }
      post({
        type: 'done', hashes: n, secs: (last - first) / 1000, allHashes: all,
        jitRuns: jitRuns() - r0, pairRuns: pairRuns() - p0, paired: !!vm2,
      });
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
  post({ type: 'ready', header: profileHeader(Module, prof), lightVms });
  if (fb) fb.cacheReady(key);
}
