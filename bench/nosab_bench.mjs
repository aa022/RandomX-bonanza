// No-SAB scaling bench: the browser NoSabPool setup in Node. N worker_threads,
// each loading randomx_st.js (non-shared memory, no pthreads; no
// SharedArrayBuffer anywhere), each with its own light cache and a light VM
// on the JIT'd path (threaded interpreter + embedded superscalar item fn,
// configured like light_mode_check), hashing a 76-byte blob over its own
// disjoint nonce slot (nonce = slot + k*N at offset 39, like worker.js).
//
// All workers start on one wall-clock epoch: warm-up (TurboFan tier-up,
// excluded), then a measured window; each worker times its own hashes inside
// the window (no shared counters without SAB) and the main thread sums them.
//
// Usage:
//   node bench/nosab_bench.mjs [--workers N] [--secs 15] [--warmup 4]
//        [--profile arm|x86|auto] [--feature-base 3] [--key K]
//        [--light-vms N]   future: VMs per worker in lockstep (ignored if the build lacks it)
//        [--full K]        future: K full-dataset replicas (errors out: not supported yet)
//   default --workers = os.availableParallelism(); always runs randomx_st.

import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import os from 'os';
import { parseProfileArgs, applyProfile, profileHeader } from './profile_args.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);
const loadModule = () => require(join(__dirname, '..', 'public', 'randomx_st.js'))();

const args = isMainThread ? process.argv.slice(2) : workerData.args;
const arg = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const WORKERS = Math.max(1, Number(arg('--workers', String(os.availableParallelism()))));
const SECS = Number(arg('--secs', '15'));
const WARMUP = Number(arg('--warmup', '4'));
const FEATURE_BASE = Number(arg('--feature-base', '3'));
const KEY = arg('--key', 'gh-distro bench key');
const LIGHT_VMS = Number(arg('--light-vms', '1'));
const FULL = Number(arg('--full', '0'));
const PROF = parseProfileArgs(args);
const BLOB_LEN = 76, NONCE_OFF = 39;

// Configures the JIT like light_mode_check. Returns the effective --light-vms.
function setupJit(Module) {
  let maxPages = 65536;
  try { const d = Module.wasmMemory.type(); if (d && d.maximum) maxPages = d.maximum; } catch (_) {}
  Module._rxjit_set_max_memory_pages(maxPages);
  Module._rxjit_set_use_threaded_interp(1);
  Module._rxjit_set_regs_in_memory(1);
  Module._rxjit_set_split_inner_dispatch(1);
  Module._rxjit_set_feature(FEATURE_BASE | 4);
  applyProfile(Module, PROF);
  Module._rxSetJitEnabled(1);
  if (LIGHT_VMS > 1 && Module._rxjit_set_light_vms) { Module._rxjit_set_light_vms(LIGHT_VMS); return LIGHT_VMS; }
  return 1;
}

if (isMainThread) {
  // Capability probes for the future knobs, on a throwaway instance.
  if (FULL > 0 || LIGHT_VMS > 1) {
    const M = await loadModule();
    if (FULL > 0) {
      if (!M._rxInitItemsInto) { console.error(`--full ${FULL}: this randomx_st build has no full-replica support (rxInitItemsInto)`); process.exit(2); }
      console.error(`--full ${FULL}: not implemented in nosab_bench yet`); process.exit(2);
    }
    if (!M._rxjit_set_light_vms) console.log(`note: --light-vms ${LIGHT_VMS} ignored (build lacks rxjit_set_light_vms)`);
  }

  console.log(`nosab bench: randomx_st, ${WORKERS} worker_threads, light mode, warm-up ${WARMUP}s + ${SECS}s`);
  const t0 = performance.now();
  const workers = [], ready = [], results = [];
  for (let i = 0; i < WORKERS; i++) {
    const w = new Worker(__filename, { workerData: { args, slot: i, slots: WORKERS } });
    const on = (type) => new Promise((res, rej) => {
      w.once('error', rej);
      w.on('message', (m) => { if (m.type === type) res(m); });
    });
    workers.push(w); ready.push(on('ready')); results.push(on('done'));
  }
  const info = await Promise.all(ready);
  console.log(`caches ready in ${((performance.now() - t0) / 1000).toFixed(1)} s (Argon2 per worker, concurrent)`);
  console.log(`light threaded (feature=${FEATURE_BASE | 4} ${info[0].header}) light_vms=${info[0].lightVms}`);

  const epoch = performance.timeOrigin + performance.now() + 200; // shared start, wall-clock ms
  for (const w of workers) w.postMessage({ type: 'go', epoch });
  const res = await Promise.all(results);
  let total = 0, hashes = 0, fallback = 0;
  for (const [i, r] of res.entries()) {
    const hs = r.hashes / r.secs;
    total += hs; hashes += r.hashes;
    if (r.jitRuns < r.allHashes * 8) fallback++;
    console.log(`  worker ${String(i).padStart(2)}: ${hs.toFixed(2).padStart(7)} H/s  (${r.hashes} hashes / ${r.secs.toFixed(2)} s, ${(1000 / hs).toFixed(1)} ms/hash)`);
  }
  if (fallback) console.log(`WARNING: ${fallback} worker(s) fell back to the C interpreter for some programs`);
  console.log(`total ${total.toFixed(1)} H/s over ${WORKERS} workers (${(total / WORKERS).toFixed(2)} H/s per worker, ${hashes} hashes)`);
  for (const w of workers) w.terminate();
  process.exit(0);
} else {
  const Module = await loadModule();
  const lightVms = setupJit(Module);
  const c = (n, r, a) => Module.cwrap(n, r, a);
  const cache = c('randomx_alloc_cache', 'number', ['number'])(0);
  if (!cache) throw new Error('alloc_cache failed');
  const key = Buffer.from(KEY);
  const keyPtr = Module._malloc(key.length);
  Module.HEAPU8.set(key, keyPtr);
  c('randomx_init_cache', null, ['number', 'number', 'number'])(cache, keyPtr, key.length);
  const vm = c('randomx_create_vm', 'number', ['number', 'number', 'number'])(0, cache, 0);
  if (!vm) throw new Error('create_vm failed');
  const calc = c('randomx_calculate_hash', null, ['number', 'number', 'number', 'number']);

  const inPtr = Module._malloc(BLOB_LEN), outPtr = Module._malloc(32);
  const blob = new Uint8Array(BLOB_LEN);
  for (let j = 0; j < BLOB_LEN; j++) blob[j] = (j * 131 + 7) & 0xff;
  Module.HEAPU8.set(blob, inPtr);
  const { slot, slots } = workerData;
  let nonce = slot;
  const hash = () => {
    const h = Module.HEAPU8; // re-read: the heap view can change on memory growth
    h[inPtr + NONCE_OFF] = nonce; h[inPtr + NONCE_OFF + 1] = nonce >>> 8;
    h[inPtr + NONCE_OFF + 2] = nonce >>> 16; h[inPtr + NONCE_OFF + 3] = nonce >>> 24;
    calc(vm, inPtr, BLOB_LEN, outPtr);
    nonce = (nonce + slots) >>> 0;
  };
  const wall = () => performance.timeOrigin + performance.now();
  parentPort.postMessage({ type: 'ready', header: profileHeader(Module, PROF), lightVms });
  parentPort.once('message', ({ epoch }) => {
    const r0 = Module._rxjit_stat_light_runs() >>> 0;
    while (wall() < epoch) {}
    const mStart = epoch + WARMUP * 1000, mEnd = mStart + SECS * 1000;
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
    parentPort.postMessage({
      type: 'done', hashes: n, secs: (last - first) / 1000, allHashes: all,
      jitRuns: (Module._rxjit_stat_light_runs() >>> 0) - r0,
    });
  });
}
