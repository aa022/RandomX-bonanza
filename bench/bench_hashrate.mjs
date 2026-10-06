// Node-side RandomX hashrate bench.
//
// Loads the same wasm bundle the browser does, builds a cache (light mode)
// or full dataset (full mode), then hashes for a fixed window and prints
// the measured hashrate.
//
// Usage:
//   node bench/bench_hashrate.mjs                # light, 10 s, 1 thread
//   node bench/bench_hashrate.mjs --duration 20  # 20 s window
//   node bench/bench_hashrate.mjs --full         # full-memory (2 GiB, slow init)
//   node bench/bench_hashrate.mjs --full --threads 4
//
// Hashrate in light mode is intentionally low — RandomX is designed so that
// the full-memory path is the meaningful one. The light bench is here as a
// fast sanity check that the wasm build is functional.

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);
const createRandomX = require(join(__dirname, '..', 'public', process.env.RX_BUILD === 'st' ? 'randomx_st.js' : 'randomx.js'));

const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf(name);
  if (i < 0) return dflt;
  return args[i + 1];
}
function flag(name) { return args.includes(name); }

const DURATION_S = Number(arg('--duration', '10'));
const FULL       = flag('--full');
const THREADS    = Math.max(1, Math.min(32, Number(arg('--threads', '1'))));
const JIT        = !flag('--nojit');
const KEY        = arg('--key', 'gh-distro bench key');

const RANDOMX_FLAG_FULL_MEM = 4;

function fmt(n, w = 0) { return n.toFixed(0).padStart(w, ' '); }

async function main() {
  console.log('RandomX bonanza bench');
  console.log(`  mode     : ${FULL ? 'full' : 'light'}`);
  console.log(`  duration : ${DURATION_S}s`);
  console.log(`  threads  : ${THREADS}`);
  console.log(`  jit      : ${JIT ? 'on' : 'off'}`);

  const t0 = Date.now();
  const Module = await createRandomX();
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] wasm runtime ready`);

  const api = {
    alloc_cache:        Module.cwrap('randomx_alloc_cache',     'number', ['number']),
    init_cache:         Module.cwrap('randomx_init_cache',      null,     ['number', 'number', 'number']),
    alloc_dataset:      Module.cwrap('randomx_alloc_dataset',   'number', ['number']),
    init_dataset:       Module.cwrap('randomx_init_dataset',    null,     ['number', 'number', 'number', 'number']),
    init_dataset_par:   Module.cwrap('rxInitDatasetParallel',   'number', ['number', 'number', 'number', 'number', 'number']),
    dataset_item_count: Module.cwrap('randomx_dataset_item_count', 'number', []),
    create_vm:          Module.cwrap('randomx_create_vm',       'number', ['number', 'number', 'number']),
    calculate_hash:     Module.cwrap('randomx_calculate_hash',  null,     ['number', 'number', 'number', 'number']),
    create_mining_ctx:  Module.cwrap('rxCreateMiningContext',   'number', ['number', 'number', 'number', 'number']),
    mine_batch_ctx:     Module.cwrap('rxMineBatchContext',      'number',
                          ['number', 'number', 'number', 'number', 'number',
                           'number', 'number', 'number']),
  };

  if (Module._rxSetJitEnabled) Module._rxSetJitEnabled(JIT && FULL ? 1 : 0);
  if (JIT && FULL) {
    // Best-effort: pick the right relaxed-SIMD / FMA bit. Node typically
    // supports FMA-relaxed via V8; if not, the C-side JIT auto-falls back.
    if (Module._rxjit_set_feature) Module._rxjit_set_feature(3);
    if (Module._rxjit_set_use_threaded_interp) Module._rxjit_set_use_threaded_interp(1);
    if (Module._rxjit_set_regs_in_memory)      Module._rxjit_set_regs_in_memory(1);
    if (Module._rxjit_set_split_inner_dispatch) Module._rxjit_set_split_inner_dispatch(1);
    if (Module._rxjit_set_supjit_enabled)      Module._rxjit_set_supjit_enabled(1);
  }

  const flags = FULL ? RANDOMX_FLAG_FULL_MEM : 0;

  const keyBytes = Buffer.from(KEY);
  const keyPtr   = Module._malloc(keyBytes.length);
  Module.HEAPU8.set(keyBytes, keyPtr);

  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] allocating cache`);
  const cache = api.alloc_cache(flags);
  if (!cache) { console.error('alloc_cache failed'); process.exit(1); }

  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] initialising cache (argon2)`);
  api.init_cache(cache, keyPtr, keyBytes.length);

  let dataset = 0;
  if (FULL) {
    console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] allocating dataset`);
    dataset = api.alloc_dataset(flags);
    if (!dataset) { console.error('alloc_dataset failed'); process.exit(1); }
    const items = api.dataset_item_count();
    console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] initialising dataset (${items} items)`);
    // Parallel init across THREADS pthreads (capped at 32 in the C side).
    if (api.init_dataset_par) api.init_dataset_par(cache, dataset, 0, items, THREADS);
    else                       api.init_dataset(dataset, cache, 0, items);
    console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] dataset built`);
  }

  // 76 bytes is the canonical Monero blob length; the actual contents don't
  // matter for a hashrate bench. Nonce is at offset 39 (matches block header).
  const BLOB_LEN     = 76;
  const NONCE_OFFSET = 39;
  const blobPtr      = Module._malloc(BLOB_LEN);
  const hashPtr      = Module._malloc(32);
  const targetPtr    = Module._malloc(32);
  const resultPtr    = Module._malloc(40);
  const blob = new Uint8Array(BLOB_LEN);
  for (let i = 0; i < BLOB_LEN; i++) blob[i] = i & 0xff;
  Module.HEAPU8.set(blob, blobPtr);
  Module.HEAPU8.fill(0, targetPtr, targetPtr + 32);

  let hashes = 0;
  const deadline = Date.now() + DURATION_S * 1000;
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] hashing for ${DURATION_S}s…`);

  if (FULL && THREADS > 1 && api.create_mining_ctx && api.mine_batch_ctx) {
    const ctx = api.create_mining_ctx(flags, 0, dataset, THREADS);
    if (!ctx) { console.error('create_mining_ctx failed'); process.exit(1); }
    let nonce = 1;
    const tStart = Date.now();
    while (Date.now() < deadline) {
      // Larger batches amortise the pthread fan-out overhead.
      const batch = THREADS * 4;
      const done = api.mine_batch_ctx(ctx, blobPtr, BLOB_LEN, targetPtr,
                                      NONCE_OFFSET, nonce, batch, resultPtr);
      if (done <= 0) { console.error('mine_batch_ctx returned ' + done); break; }
      nonce  += done;
      hashes += done;
    }
    const elapsed = (Date.now() - tStart) / 1000;
    report(hashes, elapsed);
  } else {
    const vm = api.create_vm(flags, FULL ? 0 : cache, FULL ? dataset : 0);
    if (!vm) { console.error('create_vm failed'); process.exit(1); }
    let nonce = 1;
    const tStart = Date.now();
    while (Date.now() < deadline) {
      // Bump the nonce in the blob so each hash is distinct.
      blob[NONCE_OFFSET]     = nonce        & 0xff;
      blob[NONCE_OFFSET + 1] = (nonce >> 8) & 0xff;
      blob[NONCE_OFFSET + 2] = (nonce >> 16)& 0xff;
      blob[NONCE_OFFSET + 3] = (nonce >> 24)& 0xff;
      Module.HEAPU8.set(blob, blobPtr);
      api.calculate_hash(vm, blobPtr, BLOB_LEN, hashPtr);
      nonce++;
      hashes++;
    }
    const elapsed = (Date.now() - tStart) / 1000;
    report(hashes, elapsed);
  }
}

function report(hashes, elapsedS) {
  const rate = hashes / elapsedS;
  console.log('');
  console.log('────────────────────────────────────────────');
  console.log(`  hashes      ${fmt(hashes,    8)}`);
  console.log(`  elapsed     ${elapsedS.toFixed(2).padStart(7, ' ')} s`);
  console.log(`  hashrate    ${fmt(rate,      8)} H/s`);
  console.log('────────────────────────────────────────────');
}

main().catch((err) => { console.error(err); process.exit(1); });
