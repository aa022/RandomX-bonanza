// Try to extract the version tag the worker was spawned with so we pull
// a fresh randomx.js bundle every restart.
// ?build=st selects the single-thread no-SAB build (randomx_st.js): the page
// is not crossOriginIsolated, so miner.js runs N of these workers (NoSabPool),
// one mining thread each. It must be known before the first message, hence
// the URL rather than the init message.
const stBuild = /[?&]build=st(&|$)/.test((self.location && self.location.search) || '');
const rxScript = stBuild ? 'randomx_st.js' : 'randomx.js';
const rxVersion = (() => {
  let v = 'dev';
  try {
    const m = (self.location && self.location.search || '').match(/[?&]v=([^&]+)/);
    if (m) v = m[1];
  } catch (_) {}
  return encodeURIComponent(v);
})();
importScripts(`${rxScript}?v=${rxVersion}`);

let Module = null;
let vm = null;
let cache = null;
let dataset = null;
let currentSeedHash = null;
let mining = false;
let api = {};
let inputPtr = 0;
let hashPtr = 0;
let targetPtr = 0;
let mineResultPtr = 0;
let mineCtx = 0;
let jitEnabled = true;
let jitFeature = 0;
let fullMemory = false;
let datasetThreads = 1;
let datasetInitThreads = 32;
let initPromise = null;
let cachePromise = null;
let cacheSeedHash = null;
let profileCore = false;
let lastProfilePost = 0;
// NoSabPool: this worker's slice of the 32-bit nonce space (slot of slots).
let nonceSlot = 0;
let nonceSlots = 1;
// NoSabPool ?fb_full=K (randomx_st only): this worker's part of the cooperative
// full-dataset build (fb_full.js FbWorker; init fbRole 'full' = replica).
let fb = null;
let fbPaused = false;

let currentJob = null;
let pendingJob = null;
let jobSeq = 0;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Last-seen JIT error reported from any pthread. Polled inside the mine loop
// so we can surface Safari/Firefox-specific instantiation errors in the UI.
let lastJitError = null;
let lastJitErrorPosted = '';
let lastJitFailCount = 0;

function postJitStats() {
  postMessage({
    type: 'jit',
    stats: {
      enabled: jitEnabled,
      feature: jitFeature, // 0=baseline, 1=relaxed-simd, 3=relaxed-simd+FMA
      kind: 'c-side-wasm',
      lastError: lastJitError,
      failCount: lastJitFailCount,
    },
  });
}

// Surfaces any JIT errors (per-worker last-error or the shared pthread
// error buffer) to the status log. Runs every mine-loop tick but is
// effectively idle when nothing failed. The periodic runs=N/fails=N
// heartbeat used to live here too — removed; the headline rate is
// already visible in the hashrate bar.
function checkJitErrors() {
  if (!Module) return;
  if (typeof self._rxjit_last_error !== 'undefined' && self._rxjit_last_error !== lastJitErrorPosted) {
    lastJitError = self._rxjit_last_error;
    lastJitErrorPosted = self._rxjit_last_error;
    postMessage({ type: 'status', message: `JIT error: ${lastJitError}` });
  }
  if (typeof self._rxjit_fail_count === 'number') {
    lastJitFailCount = self._rxjit_fail_count;
  }

  // Also read the shared error buffer (any pthread can write into it).
  // TextDecoder refuses views over SharedArrayBuffer, so we have to copy
  // into a regular Uint8Array first — `new Uint8Array(view)` allocates a
  // fresh non-shared ArrayBuffer.
  if (Module._rxjit_err_buf_ptr) {
    const ptr = Module._rxjit_err_buf_ptr();
    let len = 0;
    while (Module.HEAPU8[ptr + len] !== 0 && len < 511) len++;
    if (len > 0) {
      const localCopy = new Uint8Array(Module.HEAPU8.subarray(ptr, ptr + len));
      const msg = new TextDecoder().decode(localCopy);
      if (msg !== lastJitErrorPosted) {
        lastJitErrorPosted = msg;
        postMessage({ type: 'status', message: `JIT pthread error: ${msg}` });
      }
    }
  }
}

// Tiny WASM modules used purely for feature probing — validates iff the
// browser implements the opcode. The function signature has `arity` v128
// inputs and one v128 output; the body just pushes those inputs and runs
// the candidate opcode, which by construction must net-pop `arity` v128s
// and push 1 v128 (this matches f64x2.relaxed_madd with arity=3, and
// i8x16.relaxed_swizzle with arity=2).
function detectJitFeature() {
  function probe(opcodeBytes, arity) {
    // type section: 1 type (v128 × arity) -> v128
    const typeEntry = [0x60, arity, ...Array(arity).fill(0x7b), 0x01, 0x7b];
    const typeSection = [0x01, typeEntry.length + 1, 0x01, ...typeEntry];
    // function section: 1 function of type 0
    const funcSection = [0x03, 0x02, 0x01, 0x00];
    // code section: 1 body — 0 locals, push each input, run opcode, end
    const body = [0x00]; // 0 local entries
    for (let i = 0; i < arity; i++) body.push(0x20, i);
    body.push(...opcodeBytes);
    body.push(0x0b); // end
    const codeBody = [body.length, ...body]; // length-prefixed
    const codeSection = [0x0a, codeBody.length + 1, 0x01, ...codeBody];
    const bytes = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      ...typeSection, ...funcSection, ...codeSection,
    ]);
    try { return WebAssembly.validate(bytes); }
    catch (_) { return false; }
  }
  // i8x16.relaxed_swizzle: (v128, v128) -> v128   simd op 0x100 = uleb 0x80 0x02
  const hasRelaxedSimd = probe([0xfd, 0x80, 0x02], 2);
  // f64x2.relaxed_madd: (v128, v128, v128) -> v128  simd op 0x107 = uleb 0x87 0x02
  // (the FMA semifloat stubs use this exact byte sequence — see
  // wasm/src/src/jit_stubs/semifloat.h STUB_FMUL_FMA_1)
  const hasFma = probe([0xfd, 0x87, 0x02], 3);
  if (hasRelaxedSimd && hasFma) return 3;
  if (hasRelaxedSimd)           return 1;
  return 0;
}

// CPU probe for ?jit_profile=auto: () -> i32 returning lane 0 of
// i8x16.relaxed_swizzle(v128.const [10..25], v128.const [0x11 x16]). Index
// 0x11 is out of range: x86 (pshufb, index & 15) gives 11, ARM (tbl) gives 0.
// No relaxed SIMD (JSC/Safari) or any other failure -> not x86.
function isX86() {
  // type section: 1 type () -> i32
  const typeSection = [0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f];
  // function section: 1 function of type 0
  const funcSection = [0x03, 0x02, 0x01, 0x00];
  // export section: "f" = function 0
  const exportSection = [0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x00];
  // code section: 0 locals, v128.const (0xfd 0x0c) data, v128.const indices,
  // i8x16.relaxed_swizzle (0xfd 0x80 0x02), i8x16.extract_lane_u 0 (0xfd 0x16 0x00)
  const data = Array.from({ length: 16 }, (_, i) => 10 + i);
  const body = [0x00, 0xfd, 0x0c, ...data, 0xfd, 0x0c, ...Array(16).fill(0x11),
    0xfd, 0x80, 0x02, 0xfd, 0x16, 0x00, 0x0b];
  const codeSection = [0x0a, body.length + 2, 0x01, body.length, ...body];
  const bytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...typeSection, ...funcSection, ...exportSection, ...codeSection,
  ]);
  try { return new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports.f() === 11; }
  catch (_) { return false; }
}

async function init(options = {}) {
  if (Module) {
    postJitStats();
    postMessage({ type: 'ready' });
    return;
  }
  fullMemory = options.fullMemory === true;
  datasetThreads = Math.max(1, Math.min(32, Number(options.datasetThreads) || 1));
  datasetInitThreads = Math.max(1, Math.min(32, Number(options.datasetInitThreads) || 32));
  // The new C-side WASM JIT runs the full 2048-iter program loop on each
  // worker thread; it's compatible with multi-thread full-memory mining.
  // Light mode JITs too: the threaded module embeds the superscalar item
  // function in place of the dataset read (rxjit_run_program_light).
  jitEnabled = options.enableJit !== false;
  profileCore = options.profileCore === true;
  nonceSlots = Math.max(1, Math.floor(Number(options.nonceSlots) || 1));
  nonceSlot = Math.max(0, Math.min(nonceSlots - 1, Math.floor(Number(options.nonceSlot) || 0)));
  postMessage({
    type: 'status',
    message: `Loading WASM runtime ${rxScript} (crossOriginIsolated=${self.crossOriginIsolated === true})...`,
  });

  if (!stBuild && self.crossOriginIsolated !== true) {
    throw new Error('WASM pthreads require crossOriginIsolated=true. Use HTTPS/trusted localhost, or mark this LAN origin as secure in the browser.');
  }

  Module = await createRandomX({
    mainScriptUrlOrBlob: rxScript,
    locateFile: (path) => path,
    print: (...args) => postMessage({
      type: 'status',
      message: `WASM: ${args.join(' ')}`,
    }),
    printErr: (...args) => postMessage({
      type: 'status',
      message: `WASM err: ${args.join(' ')}`,
    }),
    monitorRunDependencies: (left) => {
      if (left > 0) {
        postMessage({ type: 'status', message: `WASM startup dependencies: ${left}` });
      }
    },
  });

  postMessage({ type: 'status', message: 'WASM runtime ready' });
  api = {
    alloc_cache: Module.cwrap('randomx_alloc_cache', 'number', ['number']),
    init_cache: Module.cwrap('randomx_init_cache', null, ['number', 'number', 'number']),
    alloc_dataset: Module.cwrap('randomx_alloc_dataset', 'number', ['number']),
    init_dataset: Module.cwrap('randomx_init_dataset', null, ['number', 'number', 'number', 'number']),
    init_dataset_parallel: Module.cwrap('rxInitDatasetParallel', 'number', ['number', 'number', 'number', 'number', 'number']),
    init_dataset_start: Module.cwrap('rxInitDatasetStart', 'number', ['number', 'number', 'number', 'number', 'number']),
    init_dataset_progress: Module.cwrap('rxInitDatasetProgress', 'number', []),
    init_dataset_join: Module.cwrap('rxInitDatasetJoin', 'number', []),
    dataset_item_count: Module.cwrap('randomx_dataset_item_count', 'number', []),
    create_vm: Module.cwrap('randomx_create_vm', 'number', ['number', 'number', 'number']),
    vm_set_cache: Module.cwrap('randomx_vm_set_cache', null, ['number', 'number']),
    vm_set_dataset: Module.cwrap('randomx_vm_set_dataset', null, ['number', 'number']),
    calculate_hash: Module.cwrap('randomx_calculate_hash', null, ['number', 'number', 'number', 'number']),
    mine_batch_parallel: Module.cwrap('rxMineBatchParallel', 'number', [
      'number', 'number', 'number', 'number', 'number', 'number',
      'number', 'number', 'number', 'number', 'number',
    ]),
    create_mining_context: Module.cwrap('rxCreateMiningContext', 'number', ['number', 'number', 'number', 'number']),
    mine_batch_context: Module.cwrap('rxMineBatchContext', 'number', [
      'number', 'number', 'number', 'number', 'number',
      'number', 'number', 'number',
    ]),
    destroy_mining_context: Module.cwrap('rxDestroyMiningContext', null, ['number']),
    profile_set_enabled: Module.cwrap('rxProfileSetEnabled', null, ['number']),
    profile_reset: Module.cwrap('rxProfileReset', null, []),
    profile_get_init_ms: Module.cwrap('rxProfileGetInitMs', 'number', []),
    profile_get_run_ms: Module.cwrap('rxProfileGetRunMs', 'number', []),
    profile_get_bytecode_ms: Module.cwrap('rxProfileGetBytecodeMs', 'number', []),
    profile_get_final_ms: Module.cwrap('rxProfileGetFinalMs', 'number', []),
    profile_get_hashes: Module.cwrap('rxProfileGetHashes', 'number', []),
    destroy_vm: Module.cwrap('randomx_destroy_vm', null, ['number']),
    release_cache: Module.cwrap('randomx_release_cache', null, ['number']),
    release_dataset: Module.cwrap('randomx_release_dataset', null, ['number']),
  };
  inputPtr = Module._malloc(256);
  hashPtr = Module._malloc(32);
  targetPtr = Module._malloc(32);
  mineResultPtr = Module._malloc(40);

  if (jitEnabled && Module._rxSetJitEnabled) {
    jitFeature = detectJitFeature();
    if (Module._rxjit_set_feature) Module._rxjit_set_feature(jitFeature);
    // Tell the C JIT the max # of pages the imported memory will declare
    // in the WASM module it generates. With ALLOW_MEMORY_GROWTH + shared
    // memory, Emscripten's max is fixed to MAXIMUM_MEMORY/65536; default
    // is 4 GiB = 65536 pages. Prefer reading from Memory.type() when
    // supported (Chrome/Firefox), otherwise fall back to that default.
    let maxPages = 65536;
    try {
      const t = Module.wasmMemory.type;
      if (typeof t === 'function') {
        const desc = t.call(Module.wasmMemory);
        if (desc && desc.maximum) maxPages = desc.maximum;
      }
    } catch (_) { /* keep default */ }
    if (Module._rxjit_set_max_memory_pages) Module._rxjit_set_max_memory_pages(maxPages);
    // jit_exp is a comma list, e.g. ?jit_exp=threaded,inline_fprc,regs_mem.
    // Old single-string form ('threaded' / 'reuse' / 'reuse2') still works.
    const jitExpRaw = (options.jitExperiment || '');
    const jitExp = jitExpRaw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const hasExp = (s) => jitExp.includes(s);
    if ((hasExp('reuse') || hasExp('reuse2')) && Module._rxjit_set_experiment_reuse_module) {
      const lvl = hasExp('reuse2') ? 2 : 1;
      Module._rxjit_set_experiment_reuse_module(lvl);
      postMessage({ type: 'status', message: `JIT experiment: REUSE_MODULE=${lvl} active (wrong hashes, timing-only)` });
    }
    // Threaded interpreter + V3 (regs_in_memory) + V2-minimal (split_id) +
    // INLINE_FPRC_ZERO: empirically the right default on every engine at 32T.
    //   Safari (JSC):    ~300 → 560 H/s @ 32T (matches Firefox)
    //   Chrome (V8):     ~250 → 530+ H/s @ 32T (per-program Module alloc
    //                    contention disappears with a resident module)
    //   Firefox: same path predicted to match or exceed default
    // Override individually with ?jit_exp=no_threaded / no_split_id /
    // no_inline_fprc / no_regs_mem.
    if (Module._rxjit_set_use_threaded_interp) {
      const wantThreaded = !hasExp('no_threaded')
                        && (options.jitThreaded !== false);
      if (wantThreaded) {
        Module._rxjit_set_use_threaded_interp(1);
        if (!hasExp('no_inline_fprc')) {
          jitFeature |= 4; // RXJIT_FEATURE_INLINE_FPRC_ZERO
          if (Module._rxjit_set_feature) Module._rxjit_set_feature(jitFeature);
          postMessage({ type: 'status', message: 'JIT feature: INLINE_FPRC_ZERO on' });
        }
        // V3 is implied by split_id internally, but set it explicitly so the
        // stats / status display reflects it even when split_id is overridden.
        if (!hasExp('no_regs_mem') && Module._rxjit_set_regs_in_memory) {
          Module._rxjit_set_regs_in_memory(1);
          postMessage({ type: 'status', message: 'JIT feature: V3 REGS_IN_MEMORY on' });
        }
        if (!hasExp('no_split_id') && Module._rxjit_set_split_inner_dispatch) {
          Module._rxjit_set_split_inner_dispatch(1);
          postMessage({ type: 'status', message: 'JIT feature: V2-MINIMAL split_inner_dispatch on' });
        }
        // Opt-outs of the perf series, for per-engine A/B (feature bits in
        // wasm_jit_gen.h): ?jit_exp=no_fuse (fused pairs), no_inline_round
        // (old call_indirect float path).
        const optOut = (hasExp('no_fuse') ? 64 : 0) | (hasExp('no_inline_round') ? 32 : 0);
        if (optOut && Module._rxjit_set_feature) {
          jitFeature |= optOut;
          Module._rxjit_set_feature(jitFeature);
          postMessage({ type: 'status', message: `JIT feature: opt-out bits ${optOut} set` });
        }
        // Module-gen profile (wasm_jit_profile.h): ?jit_profile=auto|arm|x86,
        // with fine overrides in jit_exp: fuse_n=N, triples_n=N, unroll2 or
        // unroll2=0|1 (2x dispatch replication), shared_code=0|1 (no per-thread
        // pointer in the module bytes, so V8 compiles one copy for all
        // workers), aes_simd=0|1 (SIMD vs T-table AES in randomx.wasm),
        // aes_relaxed=0|1 (hashAndFill AES in the relaxed-SIMD side module),
        // light_mlp=0|1|2 (light mode: next-item line probe / item pairing),
        // kernel_k=1..4 (supjit dataset-init items per loop trip). 'auto' is isX86() ? x86 : arm;
        // JSC always gets arm (it refused to tier up the large functions).
        if (Module._rxjit_set_profile) {
          const PROFILE_NAMES = ['arm', 'x86']; // index = RXJIT_PROFILE_*
          let req = String(options.jitProfile || 'auto').trim().toLowerCase();
          if (req !== 'auto' && !PROFILE_NAMES.includes(req)) {
            postMessage({ type: 'status', message: `JIT profile: unknown '${req}', using auto` });
            req = 'auto';
          }
          const auto = req === 'auto';
          if (auto) {
            const ua = String((self.navigator && self.navigator.userAgent) || '');
            const jsc = /AppleWebKit\//.test(ua) && !/Chrom(e|ium)\//.test(ua);
            req = !jsc && isX86() ? 'x86' : 'arm';
          }
          const expNum = (k) => { // jit_exp token k=N, else -1 (the profile's)
            const t = jitExp.find((s) => s.startsWith(k + '='));
            return t && /^\d+$/.test(t.slice(k.length + 1)) ? Number(t.slice(k.length + 1)) : -1;
          };
          Module._rxjit_set_profile(PROFILE_NAMES.indexOf(req));
          Module._rxjit_set_fuse_n(expNum('fuse_n'));
          Module._rxjit_set_triples_n(expNum('triples_n'));
          // unroll2 (= unroll2=1) or unroll2=0 overrides the profile's
          Module._rxjit_set_unroll2(hasExp('unroll2') ? 1 : expNum('unroll2'));
          if (Module._rxjit_set_shared_code) Module._rxjit_set_shared_code(expNum('shared_code'));
          // aes_simd=0|1: main-module AES, vpaes SIMD rounds (x86 profile) or T-tables
          if (Module._rxjit_set_aes_simd) Module._rxjit_set_aes_simd(expNum('aes_simd'));
          // aes_relaxed=0|1: hashAndFill via the relaxed side module (x86 profile, relaxed feature only)
          if (Module._rxjit_set_aes_relaxed) Module._rxjit_set_aes_relaxed(expNum('aes_relaxed'));
          // light_mlp=0|1|2: light-mode step 7 (1 next-item probe, 2 item pairing)
          if (Module._rxjit_set_light_mlp) Module._rxjit_set_light_mlp(expNum('light_mlp'));
          // kernel_k=N: supjit dataset-init kernel items per loop trip (1..4)
          if (Module._rxjit_set_kernel_k) Module._rxjit_set_kernel_k(expNum('kernel_k'));
          postMessage({
            type: 'status',
            message: `JIT profile: ${PROFILE_NAMES[Module._rxjit_get_profile()]} (${auto ? 'auto' : 'forced'})` +
              ` fuse_n=${Module._rxjit_effective_fuse_n()} triples_n=${Module._rxjit_effective_triples_n()}` +
              ` unroll2=${Module._rxjit_effective_unroll2()}` +
              (Module._rxjit_effective_shared_code ? ` shared_code=${Module._rxjit_effective_shared_code()}` : '') +
              (Module._rxjit_effective_aes_simd ? ` aes_simd=${Module._rxjit_effective_aes_simd()}` : '') +
              (Module._rxjit_effective_aes_relaxed ? ` aes_relaxed=${Module._rxjit_effective_aes_relaxed()}` : '') +
              (Module._rxjit_effective_light_mlp ? ` light_mlp=${Module._rxjit_effective_light_mlp()}` : '') +
              (Module._rxjit_effective_kernel_k ? ` kernel_k=${Module._rxjit_effective_kernel_k()}` : ''),
          });
        }
        postMessage({ type: 'status', message: 'JIT path: THREADED-INTERPRETER (resident module)' });
      }
    }

    // Phase D: SuperscalarHash WASM kernel for dataset init. Measured
    // 8× speedup on V8 (26.9s → 3.3s), ~4.3× on Safari (~26s → 6s) for the
    // full 256-MiB→2-GiB dataset. Auto-on everywhere — override with
    // ?jit_exp=no_supjit. The C-side pthread worker has automatic per-chunk
    // fallback to the interpreter if any engine rejects the kernel, so this
    // is safe-by-default.
    if (Module._rxjit_set_supjit_enabled && !hasExp('no_supjit')) {
      Module._rxjit_set_supjit_enabled(1);
      postMessage({ type: 'status', message: 'Dataset init: SUPJIT (wasm SuperscalarHash kernel) on' });
    }
    Module._rxSetJitEnabled(1);
    const featLabel = jitFeature === 3 ? 'fma+relaxed' : jitFeature === 1 ? 'relaxed' : 'baseline';
    postMessage({
      type: 'status',
      message: `>>> JIT-SPLIT-V2 enabled, feature=${featLabel}, maxPages=${maxPages} <<<`,
    });
    // Quick self-test: compile the static module on the main thread.
    // Catches encoding bugs before any mining starts and surfaces the
    // error somewhere visible (especially on Safari, where pthread
    // console errors can be harder to spot).
    let selfTestBuf = 0;
    try {
      selfTestBuf = Module._malloc(1 << 16);
      if (!Module._rxjit_test_generate_static) {
        throw new Error('build is missing _rxjit_test_generate_static — rebuild wasm');
      }
      const sz = Module._rxjit_test_generate_static(1, maxPages, jitFeature, selfTestBuf);
      if (sz === 0) throw new Error('static-module generator returned 0 bytes');
      const bytes = Module.HEAPU8.slice(selfTestBuf, selfTestBuf + sz);
      const ok = WebAssembly.validate(bytes);
      if (!ok) {
        try { new WebAssembly.Module(bytes); }
        catch (ee) { throw new Error('rejected: ' + (ee && ee.message)); }
        throw new Error('WebAssembly.validate returned false');
      }
      // Also instantiate it once on the main thread to confirm linking
      // against Module.wasmMemory works (shared-memory + max flags).
      new WebAssembly.Instance(new WebAssembly.Module(bytes), { e: { m: Module.wasmMemory } });
      postMessage({ type: 'status', message: `JIT self-test OK: static module = ${sz} bytes` });
    } catch (e) {
      const msg = e && (e.message || String(e));
      postMessage({ type: 'status', message: `JIT self-test FAILED: ${msg} — falling back to interpreter` });
      Module._rxSetJitEnabled(0);
      jitEnabled = false;
    } finally {
      if (selfTestBuf) Module._free(selfTestBuf);
    }
  } else if (Module._rxSetJitEnabled) {
    Module._rxSetJitEnabled(0);
  }
  if (api.profile_set_enabled) {
    api.profile_set_enabled(profileCore ? 1 : 0);
    if (profileCore) api.profile_reset();
  }

  if (stBuild && (options.fbRole === 'full' || options.fbRole === 'light')) {
    importScripts(`fb_full.js?v=${rxVersion}`);
    fb = new RxFbFull.FbWorker({
      Module,
      full: options.fbRole === 'full',
      post: (m, transfer) => postMessage(m, transfer || []),
      seed: () => currentSeedHash,
      cache: () => cache || 0,
      finalize: fbFinalize,
      log: (message) => postMessage({ type: 'status', message }),
    });
  }

  postJitStats();
  postMessage({ type: 'ready' });
}

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

function writeU64Le(value) {
  const bytes = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    bytes[i] = Number((value >> BigInt(i * 8)) & 0xffn);
  }
  return bytes;
}

function parsePoolTarget(targetHex) {
  const raw = hexToBytes(targetHex);
  let target64 = 0n;

  if (raw.length === 4) {
    const target32 = readLe(raw, 0, 4);
    if (target32 !== 0n) {
      target64 = 0xffffffffffffffffn / (0xffffffffn / target32);
    }
  } else if (raw.length === 8) {
    target64 = readLe(raw, 0, 8);
  } else {
    target64 = readLe(raw, 24, 8);
  }

  return writeU64Le(target64);
}

function hashMeetsTarget(hashPtr, targetBytes) {
  const hashHi = readLe(Module.HEAPU8, hashPtr + 24, 8);
  const target = readLe(targetBytes, 0, 8);
  return hashHi < target;
}

function targetToDiff(targetBytes) {
  const target = readLe(targetBytes, 0, 8);
  return target ? 0xffffffffffffffffn / target : 0n;
}

function hashToDiff(hashBytes) {
  const hashHi = readLe(hashBytes, 24, 8);
  if (hashHi === 0n) return 'inf';
  return (0xffffffffffffffffn / hashHi).toString();
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function initDatasetChunked(datasetPtr, cachePtr, itemCount) {
  // Init runs at datasetInitThreads (default 32), not datasetThreads (mining).
  // Decoupled so users at low mining thread counts don't pay 6× init time.
  const initThreads = datasetInitThreads;
  const started = performance.now();

  const postProgress = (done) => {
    const elapsed = (performance.now() - started) / 1000;
    const rate = done / Math.max(elapsed, 0.001);
    const remaining = Math.max(0, (itemCount - done) / Math.max(rate, 1));
    postMessage({
      type: 'dataset_progress',
      done,
      total: itemCount,
      etaSec: Math.ceil(remaining),
      threads: initThreads,
    });
  };

  // Phase C: one start/poll/join cycle instead of 64 chunked pthread_create
  // + barrier waits. The C-side worker threads publish an atomic counter
  // (via SharedArrayBuffer underneath wasmMemory); JS polls it.
  if (initThreads > 1 && api.init_dataset_start) {
    const ok = api.init_dataset_start(cachePtr, datasetPtr, 0, itemCount, initThreads);
    if (!ok) {
      postMessage({ type: 'status', message: 'init_dataset_start failed; falling back to chunked path' });
      // fall through to the legacy chunked path below
    } else {
      postProgress(0);
      let lastUpdate = 0;
      while (true) {
        await delay(150);
        const done = api.init_dataset_progress() >>> 0;
        const now = performance.now();
        if (now - lastUpdate > 1000 || done >= itemCount) {
          lastUpdate = now;
          postProgress(done);
        }
        if (done >= itemCount) break;
      }
      api.init_dataset_join();
      postProgress(itemCount);
      return;
    }
  }

  // Legacy / single-thread path (also fallback if start failed).
  const chunkItems = initThreads > 1 ? 1 << 19 : 1 << 15;
  postProgress(0);
  let lastUpdate = 0;
  for (let start = 0; start < itemCount; start += chunkItems) {
    const count = Math.min(chunkItems, itemCount - start);
    if (initThreads > 1 && api.init_dataset_parallel) {
      api.init_dataset_parallel(cachePtr, datasetPtr, start, count, initThreads);
    } else {
      api.init_dataset(datasetPtr, cachePtr, start, count);
    }
    const done = start + count;
    const now = performance.now();

    if (now - lastUpdate > 1000 || done === itemCount) {
      lastUpdate = now;
      postProgress(done);
    }

    await delay(0);
  }
  postProgress(itemCount);
}

async function ensureCache(seedHash) {
  if (currentSeedHash === seedHash) return true;
  if (cachePromise && cacheSeedHash === seedHash) return cachePromise;
  if (cachePromise) await cachePromise;
  if (currentSeedHash === seedHash) return true;

  cacheSeedHash = seedHash;
  cachePromise = buildCache(seedHash).finally(() => {
    cachePromise = null;
  });
  return cachePromise;
}

async function buildCache(seedHash) {
  const seedBytes = hexToBytes(seedHash);
  const seedPtr = Module._malloc(seedBytes.length);
  Module.HEAPU8.set(seedBytes, seedPtr);

  if (vm) { api.destroy_vm(vm); vm = null; }
  if (mineCtx) { api.destroy_mining_context(mineCtx); mineCtx = 0; }
  if (dataset) { api.release_dataset(dataset); dataset = null; }
  if (cache) { api.release_cache(cache); cache = null; }

  const flags = fullMemory ? 4 : 0; // RANDOMX_FLAG_FULL_MEM
  cache = api.alloc_cache(flags);
  if (!cache) {
    postMessage({ type: 'error', message: 'Failed to allocate cache' });
    Module._free(seedPtr);
    return false;
  }

  postMessage({ type: 'status', message: 'Initializing cache...' });
  api.init_cache(cache, seedPtr, seedBytes.length);

  if (fullMemory) {
    postMessage({ type: 'status', message: 'Allocating full dataset...' });
    dataset = api.alloc_dataset(flags);
    if (!dataset) {
      postMessage({ type: 'error', message: 'Failed to allocate full dataset' });
      Module._free(seedPtr);
      return false;
    }

    const itemCount = api.dataset_item_count();
    postMessage({ type: 'status', message: `Initializing full dataset (${itemCount} items)...` });
    await initDatasetChunked(dataset, cache, itemCount);
    api.release_cache(cache);
    cache = null;
    postMessage({ type: 'status', message: 'Released cache after full dataset init' });
    postMessage({ type: 'mode', mode: 'full' });
  } else {
    postMessage({ type: 'mode', mode: 'light' });
  }

  vm = api.create_vm(flags, fullMemory ? null : cache, fullMemory ? dataset : null);
  if (!vm) {
    postMessage({ type: 'error', message: 'Failed to create VM' });
    Module._free(seedPtr);
    return false;
  }

  if (fullMemory && datasetThreads > 1 && api.create_mining_context) {
    mineCtx = api.create_mining_context(flags, 0, dataset, datasetThreads);
    if (!mineCtx) {
      postMessage({ type: 'error', message: 'Failed to create mining thread VMs' });
      Module._free(seedPtr);
      return false;
    }
    postMessage({ type: 'status', message: `Mining context ready (${datasetThreads} VMs)` });
  }

  currentSeedHash = seedHash;
  Module._free(seedPtr);
  postMessage({ type: 'status', message: 'Ready to mine' });
  if (fb) fb.cacheReady(seedHash);
  return true;
}

// fb_full replica with every chunk: full-mode VM on the dataset, drop the cache.
function fbFinalize(ds) {
  const v = api.create_vm(4, null, ds); // RANDOMX_FLAG_FULL_MEM
  if (!v) return false;
  if (vm) api.destroy_vm(vm);
  vm = v;
  api.release_cache(cache);
  cache = null;
  postMessage({ type: 'status', message: 'fb_full: dataset replica complete, released cache' });
  postMessage({ type: 'mode', mode: 'full' });
  return true;
}

function mineLoop() {
  if (!mining) return;

  // fb_full chunk work goes first (the build is what everyone waits for), and
  // while a build is on, short slices let its messages in between.
  if (fb && fb.busy()) {
    if (!fbPaused && currentJob) postMessage({ type: 'hashrate', rate: 0 });
    fbPaused = true;
    setTimeout(mineLoop, 20);
    return;
  }
  fbPaused = false;
  const sliceMs = fb && fb.active() ? 50 : 900;

  // Pick up new job if available
  if (pendingJob) {
    currentJob = pendingJob;
    pendingJob = null;
    currentJob._blob = hexToBytes(currentJob.blob);
    currentJob._targetBytes = parsePoolTarget(currentJob.target);
    currentJob._targetDiff = targetToDiff(currentJob._targetBytes).toString();
    // random start inside this worker's slot (the whole space with one slot)
    const span = Math.floor(0x100000000 / nonceSlots);
    currentJob._nonce = (nonceSlot * span + Math.floor(Math.random() * span)) >>> 0;
  }

  if (!currentJob || !vm) {
    setTimeout(mineLoop, 50);
    return;
  }

  const blob = currentJob._blob;
  const targetBytes = currentJob._targetBytes;
  const nonceOffset = 39;
  let hashCount = 0;
  const start = performance.now();
  const useParallelMining = fullMemory && datasetThreads > 1 && mineCtx && api.mine_batch_context;

  // Hash until ~1 second has passed, then yield
  while (performance.now() - start < sliceMs) {
    if (useParallelMining) {
      const batchCount = Math.max(datasetThreads, datasetThreads * 2);
      const batchJob = currentJob;
      const startNonce = (currentJob._nonce + 1) >>> 0;

      blob[nonceOffset] = startNonce & 0xFF;
      blob[nonceOffset + 1] = (startNonce >> 8) & 0xFF;
      blob[nonceOffset + 2] = (startNonce >> 16) & 0xFF;
      blob[nonceOffset + 3] = (startNonce >> 24) & 0xFF;

      Module.HEAPU8.set(blob, inputPtr);
      Module.HEAPU8.set(targetBytes, targetPtr);
      const done = api.mine_batch_context(
        mineCtx,
        inputPtr,
        blob.length,
        targetPtr,
        nonceOffset,
        startNonce,
        batchCount,
        mineResultPtr,
      );

      if (!done) {
        postMessage({ type: 'error', message: 'Parallel mining batch failed' });
        break;
      }

      currentJob._nonce = (startNonce + done - 1) >>> 0;
      hashCount += done;

      if (Module.HEAPU8[mineResultPtr]) {
        const hashBytes = new Uint8Array(32);
        for (let j = 0; j < 32; j++) hashBytes[j] = Module.HEAPU8[mineResultPtr + 8 + j];

        const nonceHex = Module.HEAPU8[mineResultPtr + 4].toString(16).padStart(2, '0') +
                         Module.HEAPU8[mineResultPtr + 5].toString(16).padStart(2, '0') +
                         Module.HEAPU8[mineResultPtr + 6].toString(16).padStart(2, '0') +
                         Module.HEAPU8[mineResultPtr + 7].toString(16).padStart(2, '0');

        postMessage({
          type: 'share',
          job_id: batchJob.job_id,
          job_seq: batchJob._seq,
          target_diff: batchJob._targetDiff,
          share_diff: hashToDiff(hashBytes),
          nonce: nonceHex,
          result: bytesToHex(hashBytes),
        });
      }
    } else {
      currentJob._nonce = (currentJob._nonce + 1) >>> 0;
      blob[nonceOffset] = currentJob._nonce & 0xFF;
      blob[nonceOffset + 1] = (currentJob._nonce >> 8) & 0xFF;
      blob[nonceOffset + 2] = (currentJob._nonce >> 16) & 0xFF;
      blob[nonceOffset + 3] = (currentJob._nonce >> 24) & 0xFF;

      Module.HEAPU8.set(blob, inputPtr);
      api.calculate_hash(vm, inputPtr, blob.length, hashPtr);
      hashCount++;

      const valid = hashMeetsTarget(hashPtr, targetBytes);

      if (valid) {
        const hashBytes = new Uint8Array(32);
        for (let j = 0; j < 32; j++) hashBytes[j] = Module.HEAPU8[hashPtr + j];

        const nonceHex = blob[nonceOffset].toString(16).padStart(2, '0') +
                         blob[nonceOffset + 1].toString(16).padStart(2, '0') +
                         blob[nonceOffset + 2].toString(16).padStart(2, '0') +
                         blob[nonceOffset + 3].toString(16).padStart(2, '0');

        postMessage({
          type: 'share',
          job_id: currentJob.job_id,
          job_seq: currentJob._seq,
          target_diff: currentJob._targetDiff,
          share_diff: hashToDiff(hashBytes),
          nonce: nonceHex,
          result: bytesToHex(hashBytes),
        });
      }
    }

    // Check for new job between hashes
    if (pendingJob) break;
  }

  const elapsed = (performance.now() - start) / 1000;
  if (hashCount > 0) {
    postMessage({ type: 'hashrate', rate: hashCount / elapsed });
    checkJitErrors();
    if (profileCore && performance.now() - lastProfilePost > 5000) {
      lastProfilePost = performance.now();
      postMessage({
        type: 'profile',
        initMs: api.profile_get_init_ms(),
        runMs: api.profile_get_run_ms(),
        bytecodeMs: api.profile_get_bytecode_ms(),
        finalMs: api.profile_get_final_ms(),
        hashes: api.profile_get_hashes(),
      });
    }
    postJitStats();
  }

  setTimeout(mineLoop, 0);
}

self.onmessage = function(e) {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      initPromise = init(msg).catch((err) => {
        postMessage({
          type: 'error',
          message: `WASM init failed: ${err && err.message ? err.message : String(err)}`,
        });
        throw err;
      });
      break;
    case 'job': (async () => {
      if (initPromise) await initPromise;
      if (!await ensureCache(msg.seed_hash)) return;
      pendingJob = msg;
      pendingJob._seq = msg.job_seq || ++jobSeq;
      if (!mining) {
        mining = true;
        mineLoop();
      }
    })();
      break;
    case 'stop':
      mining = false;
      currentJob = null;
      pendingJob = null;
      break;
    default:
      if (fb) fb.handle(msg); // fb_* chunk messages (NoSabPool ?fb_full)
  }
};
