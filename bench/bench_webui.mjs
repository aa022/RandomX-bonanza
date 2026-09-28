// Node-side RandomX bench that mirrors the webui worker setup byte-for-byte.
//
//   - Full-memory mode (2 GiB dataset).
//   - All JIT bits the webui turns on BEFORE any cache/dataset work:
//       _rxjit_set_max_memory_pages    (without this, pthread modules fail to
//                                       link against the shared memory)
//       _rxjit_set_feature             (fma+relaxed-simd, fallback inside C)
//       _rxjit_set_use_threaded_interp + INLINE_FPRC_ZERO + V3 regs_in_memory
//       _rxjit_set_split_inner_dispatch + supjit kernel
//   - JIT self-test: validate + instantiate the static module on the main
//     thread. Fails loud if anything is wrong before init burns 7+ s.
//   - Async dataset init: rxInitDatasetStart -> poll rxInitDatasetProgress
//     every 150 ms -> rxInitDatasetJoin.
//   - One thread count per process: trying to sweep multiple thread counts
//     inside a single Module instance leaks Emscripten pthread-pool state
//     and tanks the later passes. bench_sweep.mjs reruns this script in a
//     fresh process per pass instead.
//
// Usage:
//   node bench/bench_webui.mjs                          # 32 threads, 30s
//   node bench/bench_webui.mjs --threads 8              # mine at 8 threads
//   node bench/bench_webui.mjs --init-threads 16        # split init vs. mine
//   node bench/bench_webui.mjs --duration 60            # 60s window
//   node bench/bench_webui.mjs --out result.json        # also write JSON
//   node bench/bench_webui.mjs --quiet                  # only summary + JSON
//   node bench/bench_webui.mjs --no-supjit              # disable supjit kernel
//   node bench/bench_webui.mjs --no-threaded            # disable threaded interp
//   node bench/bench_webui.mjs --nojit                  # interpreter only
//   node bench/bench_webui.mjs --feature-base 0         # no relaxed SIMD / FMA (Safari's feature set)

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync } from 'fs';

const __dirname    = dirname(fileURLToPath(import.meta.url));
const require      = createRequire(import.meta.url);
const createRandomX = require(join(__dirname, '..', 'public', 'randomx.js'));

const args = process.argv.slice(2);
function arg(name, dflt) { const i = args.indexOf(name); return i < 0 ? dflt : args[i + 1]; }
function flag(name)      { return args.includes(name); }

const THREADS      = Math.max(1, Math.min(32, Number(arg('--threads', '32'))));
const INIT_THREADS = Math.max(1, Math.min(32, Number(arg('--init-threads', String(THREADS)))));
const DURATION_S   = Number(arg('--duration', '30'));
const KEY          = arg('--key', 'gh-distro bench key');
const OUT          = arg('--out', '');
const QUIET        = flag('--quiet');
const NO_JIT       = flag('--nojit');
const NO_SUPJIT    = flag('--no-supjit');
const NO_THREADED  = flag('--no-threaded');
// Probe: --regs locals → threaded interp with regs/F/E/A in wasm locals
// (regs_in_memory=0, split_inner_dispatch=0) instead of the JSC-tuned default.
const REGS_MODE    = arg('--regs', 'mem');
if (REGS_MODE === 'locals') console.error('note: --regs locals is retired (perf step 2); the threaded interpreter always uses split + registers-in-memory.');

const RANDOMX_FLAG_FULL_MEM = 4;
const pad = (s, w) => String(s).padStart(w, ' ');
const fmt = (n, w = 0) => n.toFixed(0).padStart(w, ' ');

const t0 = Date.now();
const ts = () => pad(((Date.now() - t0) / 1000).toFixed(2), 6) + 's';
const log = (...a) => { if (!QUIET) console.log(...a); };
const writeProgress = (s) => { if (!QUIET) process.stdout.write(s); };

async function main() {
  const Module = await createRandomX();
  log(`[${ts()}] wasm runtime ready`);

  // ── JIT setup, mirrored from public/worker.js ────────────────────────
  // Order matters: max_memory_pages + feature flags MUST be set before the
  // first JIT module is generated, otherwise pthread workers emit modules
  // whose imported-memory limits disagree with the shared wasmMemory and
  // every WebAssembly.Module() call throws "expected magic word".
  let jitFeature = 0;
  if (!NO_JIT && Module._rxSetJitEnabled) {
    jitFeature = Number(arg('--feature-base', '3')) | Number(arg('--feature-extra', '0')); // bit 0 = relaxed-simd, bit 1 = fma  (C side auto-falls-back); --feature-base 0 = Safari/JSC; --feature-extra ORs in probe/diag bits
    if (Module._rxjit_set_feature) Module._rxjit_set_feature(jitFeature);

    let maxPages = 65536; // emscripten MAXIMUM_MEMORY/65536 default = 4 GiB
    try {
      const tfn = Module.wasmMemory && Module.wasmMemory.type;
      if (typeof tfn === 'function') {
        const d = tfn.call(Module.wasmMemory);
        if (d && d.maximum) maxPages = d.maximum;
      }
    } catch (_) { /* keep default */ }
    if (Module._rxjit_set_max_memory_pages) Module._rxjit_set_max_memory_pages(maxPages);

    if (!NO_THREADED) {
      if (Module._rxjit_set_use_threaded_interp)  Module._rxjit_set_use_threaded_interp(1);
      jitFeature |= 4; // INLINE_FPRC_ZERO
      if (Module._rxjit_set_feature)              Module._rxjit_set_feature(jitFeature);
      const inMem = REGS_MODE !== 'locals' ? 1 : 0;
      if (Module._rxjit_set_regs_in_memory)       Module._rxjit_set_regs_in_memory(inMem);
      if (Module._rxjit_set_split_inner_dispatch) Module._rxjit_set_split_inner_dispatch(inMem);
    }
    if (!NO_SUPJIT && Module._rxjit_set_supjit_enabled) {
      Module._rxjit_set_supjit_enabled(1);
    }

    Module._rxSetJitEnabled(1);

    if (Module._rxjit_test_generate_static) {
      const buf = Module._malloc(1 << 16);
      try {
        const sz = Module._rxjit_test_generate_static(1, maxPages, jitFeature, buf);
        if (sz === 0) throw new Error('static generator returned 0 bytes');
        const bytes = Module.HEAPU8.slice(buf, buf + sz);
        if (!WebAssembly.validate(bytes)) throw new Error('WebAssembly.validate=false');
        new WebAssembly.Instance(
          new WebAssembly.Module(bytes),
          { e: { m: Module.wasmMemory } },
        );
        log(`[${ts()}] JIT self-test OK (${sz} B static module, maxPages=${maxPages}, feature=${jitFeature})`);
      } catch (e) {
        console.error(`[${ts()}] JIT self-test FAILED: ${e && (e.message || e)} — disabling JIT`);
        Module._rxSetJitEnabled(0);
      } finally {
        Module._free(buf);
      }
    }
  } else if (Module._rxSetJitEnabled) {
    Module._rxSetJitEnabled(0);
  }

  const api = {
    alloc_cache:           Module.cwrap('randomx_alloc_cache',       'number', ['number']),
    init_cache:            Module.cwrap('randomx_init_cache',        null,     ['number', 'number', 'number']),
    alloc_dataset:         Module.cwrap('randomx_alloc_dataset',     'number', ['number']),
    init_dataset_start:    Module.cwrap('rxInitDatasetStart',        'number', ['number', 'number', 'number', 'number', 'number']),
    init_dataset_progress: Module.cwrap('rxInitDatasetProgress',     'number', []),
    init_dataset_join:     Module.cwrap('rxInitDatasetJoin',         'number', []),
    init_dataset_par:      Module.cwrap('rxInitDatasetParallel',     'number', ['number', 'number', 'number', 'number', 'number']),
    dataset_item_count:    Module.cwrap('randomx_dataset_item_count','number', []),
    release_cache:         Module.cwrap('randomx_release_cache',     null,     ['number']),
    create_mining_ctx:     Module.cwrap('rxCreateMiningContext',     'number', ['number', 'number', 'number', 'number']),
    mine_batch_ctx:        Module.cwrap('rxMineBatchContext',        'number',
                             ['number', 'number', 'number', 'number', 'number',
                              'number', 'number', 'number']),
    destroy_mining_ctx:    Module.cwrap('rxDestroyMiningContext',    null,     ['number']),
  };

  const flags = RANDOMX_FLAG_FULL_MEM;

  // ── cache (argon2) ────────────────────────────────────────────────────
  const keyBytes = Buffer.from(KEY);
  const keyPtr   = Module._malloc(keyBytes.length);
  Module.HEAPU8.set(keyBytes, keyPtr);

  log(`[${ts()}] allocating cache + initialising (argon2)`);
  const cache = api.alloc_cache(flags);
  if (!cache) { console.error('alloc_cache failed'); process.exit(1); }
  api.init_cache(cache, keyPtr, keyBytes.length);

  // ── dataset (async init, just like worker.js Phase C) ─────────────────
  log(`[${ts()}] allocating dataset`);
  const dataset = api.alloc_dataset(flags);
  if (!dataset) { console.error('alloc_dataset failed'); process.exit(1); }
  const items = api.dataset_item_count();

  log(`[${ts()}] initialising dataset (${items} items, ${INIT_THREADS} threads)`);
  const initT0 = Date.now();
  let usedAsync = false;

  if (api.init_dataset_start) {
    const ok = api.init_dataset_start(cache, dataset, 0, items, INIT_THREADS);
    if (ok) {
      usedAsync = true;
      let lastPrint = 0;
      while (true) {
        await new Promise((r) => setTimeout(r, 150));
        const done = api.init_dataset_progress() >>> 0;
        const now = Date.now();
        if (now - lastPrint >= 1000 || done >= items) {
          const pct  = (100 * done / items).toFixed(1);
          const dt   = (now - initT0) / 1000;
          const rate = done / Math.max(dt, 0.001);
          const eta  = Math.max(0, (items - done) / Math.max(rate, 1));
          writeProgress(
            `\r  init: ${pad(pct, 5)}%  ${(rate / 1e6).toFixed(2)} M items/s  eta ${eta.toFixed(1)}s     `);
          lastPrint = now;
        }
        if (done >= items) break;
      }
      api.init_dataset_join();
      writeProgress('\n');
    }
  }
  if (!usedAsync) {
    api.init_dataset_par(cache, dataset, 0, items, INIT_THREADS);
  }
  const initS = (Date.now() - initT0) / 1000;
  log(`[${ts()}] dataset built in ${initS.toFixed(2)}s`);

  api.release_cache(cache);
  Module._free(keyPtr);

  // ── mining ────────────────────────────────────────────────────────────
  const BLOB_LEN     = 76;
  const NONCE_OFFSET = 39;
  const blobPtr   = Module._malloc(BLOB_LEN);
  const targetPtr = Module._malloc(32);
  const resultPtr = Module._malloc(40);
  const blob = new Uint8Array(BLOB_LEN);
  for (let i = 0; i < BLOB_LEN; i++) blob[i] = i & 0xff;
  Module.HEAPU8.set(blob, blobPtr);
  Module.HEAPU8.fill(0, targetPtr, targetPtr + 32);

  const ctx = api.create_mining_ctx(flags, 0, dataset, THREADS);
  if (!ctx) { console.error('create_mining_ctx failed'); process.exit(1); }

  log(`[${ts()}] hashing for ${DURATION_S}s @ ${THREADS} threads…`);
  let hashes = 0;
  let nonce  = 1;
  const tStart   = Date.now();
  const deadline = tStart + DURATION_S * 1000;
  let lastPrint  = tStart;
  while (Date.now() < deadline) {
    const batch = Math.max(4, THREADS * 4);
    const done = api.mine_batch_ctx(ctx, blobPtr, BLOB_LEN, targetPtr,
                                    NONCE_OFFSET, nonce, batch, resultPtr);
    if (done <= 0) { console.error('mine_batch_ctx returned ' + done); break; }
    nonce  += done;
    hashes += done;
    const now = Date.now();
    if (now - lastPrint >= 2000) {
      const dt   = (now - tStart) / 1000;
      const rate = hashes / dt;
      const eta  = Math.max(0, (deadline - now) / 1000);
      writeProgress(`\r  mine: ${pad(rate.toFixed(0), 6)} H/s  ` +
                    `(${hashes} hashes, ${dt.toFixed(1)}s, eta ${eta.toFixed(1)}s)     `);
      lastPrint = now;
    }
  }
  writeProgress('\n');
  const elapsed = (Date.now() - tStart) / 1000;
  api.destroy_mining_ctx(ctx);

  const rate = hashes / elapsed;

  if (flag('--stats') && Module._rxjit_stat_runs) {
    const runs = Module._rxjit_stat_runs() >>> 0;
    const dyn  = Module._rxjit_stat_dyn_compile_us() >>> 0;
    const run  = Module._rxjit_stat_run_us() >>> 0;
    console.error(`[stats] runs=${runs} dyn_compile_us=${dyn} run_us=${run} ` +
      `per-run: compile=${(dyn / Math.max(runs, 1)).toFixed(0)}us run=${(run / Math.max(runs, 1)).toFixed(0)}us`);
  }

  const result = {
    threads:      THREADS,
    init_threads: INIT_THREADS,
    duration_s:   DURATION_S,
    init_s:       Number(initS.toFixed(3)),
    hashes,
    elapsed_s:    Number(elapsed.toFixed(3)),
    hashrate:     Number(rate.toFixed(2)),
    per_thread:   Number((rate / THREADS).toFixed(2)),
    jit:          !NO_JIT,
    supjit:       !NO_JIT && !NO_SUPJIT,
    threaded:     !NO_JIT && !NO_THREADED,
  };

  log('');
  log('────────────────────────────────────────────');
  log(`  init time    ${pad(initS.toFixed(2), 8)} s   (${INIT_THREADS} threads)`);
  log(`  hashes       ${fmt(hashes,    9)}`);
  log(`  elapsed      ${pad(elapsed.toFixed(2), 8)} s`);
  log(`  hashrate     ${fmt(rate,      9)} H/s  (${THREADS} threads)`);
  log(`  per-thread   ${fmt(rate / THREADS, 9)} H/s`);
  log('────────────────────────────────────────────');

  if (OUT) {
    writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n');
    log(`[${ts()}] wrote ${OUT}`);
  } else if (QUIET) {
    // No --out but --quiet: stdout JSON so the parent can capture it.
    process.stdout.write(JSON.stringify(result) + '\n');
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
