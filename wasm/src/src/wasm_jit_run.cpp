// Glue between the C++ VM and the C-side WASM JIT.
//
// Each worker thread compiles the "static" JIT module ONCE (containing the
// 22 SIMD semifloat + mulh stubs and the 5 funcref tables) and then per
// program only compiles a much smaller "dynamic" module containing just
// the 2048-iter main loop. The dynamic module imports the static module's
// tables, fprc global and 2 mulh functions, so per-program compile time is
// dominated by the main body rather than by the constant stub library.
#include <stdint.h>
#include <string.h>
#include <atomic>

#include "wasm_jit_gen.h"
#include "wasm_jit_decode.h"
#include "wasm_jit_fuse_table.h" // RXJIT_FUSE_NMAX, RXJIT_TRIPLE_NMAX
#include "wasm_jit_profile.h"
#include "wasm_jit_threaded.h"
#include "common.hpp"
#include "program.hpp"
#include "bytecode_machine.hpp"
#include <stdlib.h>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

extern __thread uint32_t wasm_rounding_mode;

namespace {

uint32_t g_jit_max_memory_pages = 65536;

// EXPERIMENTAL: when non-zero, the JS runner caches the FIRST dynamic
// module compiled per thread and reuses it for every subsequent program
// (without recompiling). The resulting hash will be wrong — this exists
// purely to isolate "is the per-program WebAssembly.Module creation
// what causes Safari's monotonic run-time degradation?". Toggle via
// rxjit_set_experiment_reuse_module() from JS.
std::atomic<int> g_rxjit_experiment_reuse_module{0};

// Cross-thread diagnostic counters. All pthread workers share these.
std::atomic<uint32_t> g_rxjit_runs{0};
std::atomic<uint32_t> g_rxjit_fails{0};
std::atomic<uint32_t> g_rxjit_static_init_attempts{0};
std::atomic<uint32_t> g_rxjit_static_init_failures{0};

// Cumulative microsecond timings, for diagnosing the Safari regression
// (compile-bound vs run-bound). Wrap-around at ~71 minutes is fine — we
// only care about ratios + averages between resets.
std::atomic<uint32_t> g_rxjit_static_compile_us{0};
std::atomic<uint32_t> g_rxjit_dyn_compile_us{0};
std::atomic<uint32_t> g_rxjit_run_us{0};

// Static dispatch statistic (threaded path): dispatch records per decoded
// program (rxjit_decode_for_interp's return), summed, and the number of
// programs decoded. dispatches/op = dispatches / (256 * programs). 64-bit
// (returned to JS as doubles): a 12-thread run passes 2^32 in ~2 hours.
std::atomic<uint64_t> g_rxjit_dispatches{0};
std::atomic<uint64_t> g_rxjit_decoded_programs{0};

// Shared last-error buffer. Pthread workers write into this when JS catches
// an exception during JIT module compile/instantiate; the main thread polls
// it and surfaces to the UI. Last-write-wins is fine for diagnostics.
constexpr size_t RXJIT_ERR_BUF = 512;
char g_rxjit_err_buf[RXJIT_ERR_BUF] = {0};

// Per-thread JIT bytecode buffers. The static module is ~12 KiB, the
// dynamic module ~3-5 KiB; one 64 KiB buffer per role with plenty of slack.
thread_local uint8_t g_jit_static_buf[1 << 16];
thread_local uint8_t g_jit_dyn_buf[1 << 16];
thread_local uint32_t g_jit_static_size = 0;
thread_local bool g_jit_static_failed = false;

// Threaded-interpreter path: per-thread module buffer + per-thread state.
// The threaded module is ~40 KiB with the arm profile's 200 fused pairs and
// grows with fuse_n and triples_n (all pairs + 1000 triples: 0.7-0.85 MiB); the
// generator writes unchecked (the size check runs after the fact), so keep
// ample headroom. Heap-allocated once per mining thread: a thread_local array
// would be emitted as zeros into the .wasm TLS data segment and copied into
// every pthread's TLS block (1 KiB of buffer = 1 KiB of randomx.wasm).
constexpr size_t RXJIT_THREADED_BUF_SIZE = 1 << 21;
thread_local uint8_t *g_jit_threaded_buf = nullptr;
thread_local uint32_t g_jit_threaded_size = 0;
// Both point into one per-thread RXJIT_ARENA_SIZE block (wasm_jit_threaded.h):
// vm_state == arena base (the pointer to free), program slot at +1024.
thread_local uint8_t *g_jit_threaded_program_slot = nullptr;
thread_local rxjit_vm_state_t *g_jit_threaded_vm_state = nullptr;
thread_local uint32_t g_jit_threaded_baked_sp = 0; // scratchpad baked into the module
// The module's generation key besides the scratchpad: the decoder must use
// exactly the fuse_n / triples_n / kind16 the module was generated with.
thread_local int g_jit_threaded_feature = 0;
thread_local int g_jit_threaded_fuse_n = 0;    // fused pair kinds the module was generated with
thread_local int g_jit_threaded_triples_n = 0; // fused triple kinds (after the pairs)
thread_local int g_jit_threaded_kind16 = 0; // record head width (rxjit_kind16)
thread_local bool g_jit_threaded_initted = false;
thread_local bool g_jit_threaded_failed = false;

// On/off toggle for the threaded interpreter. When 0, the (existing) dynamic-
// module path runs. When 1, every JIT call goes through the resident
// main_loop, with zero per-call WebAssembly.Module/Instance allocation.
std::atomic<int> g_rxjit_use_threaded_interp{0};

// V3: when 1, the threaded-module gen places r[0..7] in linear memory (read
// via i32.shl + i64.load offset=r_file_base) instead of in WASM locals
// (read via 8-way select tree). Module-gen-time flag — must be set before
// the first call to rxjit_run_program_threaded for the change to take effect.
std::atomic<int> g_rxjit_regs_in_memory{0};

// V2-minimal: when 1, the threaded-module gen extracts the inner pc loop
// (256 iterations × 44-arm br_table) into its own wasm function. Implies
// regs_in_memory and extends register-memory relocation to F/E/A. Goal: let
// JSC OMG the inner function independently of main_loop. Module-gen-time flag.
std::atomic<int> g_rxjit_split_inner_dispatch{0};

// Phase D: WASM JIT for SuperscalarHash dataset init. When set, the C-side
// `rxInitDatasetStart` and `rxInitDatasetParallel` invoke a per-cache
// wasm kernel (generated by rxjit_generate_superscalar_kernel) instead of
// the C++ interpreter. Default 0 — opt-in until measured to be a win.
std::atomic<int> g_rxjit_supjit_enabled{0};

// Per-init kernel bytes (shared across pthreads since each pthread compiles
// from these on first use). Regenerated at every rxInitDatasetStart call
// because cache_base and dataset_base get baked in.
//
// The 64 KiB buffer is large enough for any plausible 8-program kernel
// (~30–50 KiB observed). g_supjit_generation is bumped on every regen so
// per-pthread JS state knows to invalidate its cached Instance.
uint8_t g_supjit_kernel_bytes[1 << 16] = {0};
std::atomic<uint32_t> g_supjit_kernel_size{0};
std::atomic<uint32_t> g_supjit_generation{0};

// Diagnostic: last threaded-module-gen size. 0 if not yet generated, large if
// the gen returned a too-big module, or just the actual size otherwise.
std::atomic<uint32_t> g_rxjit_threaded_module_size{0};
std::atomic<uint32_t> g_rxjit_threaded_entries{0}; // # times rxjit_run_program_threaded was called
// 1=alloc OK, 2=gen called, 3=gen OK & init complete; 100s=failures
std::atomic<uint32_t> g_rxjit_threaded_phase{0};

// ---------------- Tier-probe ring buffer ----------------
//
// Records per-call run_us for the FIRST ~2k calls on a single chosen pthread.
// Used to visualise BBQ→OMG step-function transitions on Safari (and the
// equivalent Liftoff→TurboFan on V8). The first thread to JIT claims the
// sample slot; subsequent threads are no-ops to keep the data clean.
constexpr uint32_t RXJIT_SAMPLE_BUF_SIZE = 2048;
uint32_t g_rxjit_run_us_samples[RXJIT_SAMPLE_BUF_SIZE] = {0};
std::atomic<uint32_t> g_rxjit_sample_count{0};
std::atomic<int> g_rxjit_sample_thread_claimed{0};
thread_local bool g_rxjit_is_sample_thread = false;

constexpr uint64_t DYNAMIC_MANTISSA_MASK = (1ULL << 56) - 1;

} // namespace

// JS runner — defined here via EM_JS so it's available in every pthread
// (Emscripten replicates EM_JS-defined functions to each pthread worker).
// Returns 1 on success, 0 on any error. Caches the static module instance
// on `self._rxjit` so it's compiled only once per worker.
//
//   dynPtr/dynLen  : bytes of the per-program dynamic module
//   staticPtr/staticLen : bytes of the static module (use 0 once cached)
#ifdef __EMSCRIPTEN__
EM_JS(int, rxjit_js_run, (int dynPtr, int dynLen, int staticPtr, int staticLen), {
	// Browser UI threads + Web Workers both define `self`; Node's main
	// thread doesn't. Pick whichever global is available.
	var ctx = (typeof self !== 'undefined') ? self
	        : (typeof globalThis !== 'undefined') ? globalThis
	        : {};
	// In Emscripten pthread workers `Module.wasmMemory` may be undefined;
	// the shared memory lives on the bare `wasmMemory` global instead.
	// Resolve from any available source and validate the type.
	function findMem() {
		if (Module && Module.wasmMemory instanceof WebAssembly.Memory) return Module.wasmMemory;
		if (typeof wasmMemory !== 'undefined' && wasmMemory instanceof WebAssembly.Memory) return wasmMemory;
		if (typeof self !== 'undefined' && self.wasmMemory instanceof WebAssembly.Memory) return self.wasmMemory;
		return null;
	}
	try {
		var mem = findMem();
		if (!mem) {
			throw new Error('wasmMemory unavailable (Module.wasmMemory type=' + typeof (Module && Module.wasmMemory) + ')');
		}
		var t0, t1, t2, t3;
		var staticUs = 0;
		if (!ctx._rxjit) {
			if (staticLen === 0) {
				console.error('[rxjit] dynamic run before static init');
				return 0;
			}
			t0 = performance.now();
			// Pre-allocate ONE per-thread reusable byte buffer. Each
			// per-program call would otherwise allocate a fresh ArrayBuffer
			// via HEAPU8.slice(...) — for ~250 programs/sec that's ~1MB/s
			// of garbage. Safari's GC can't keep up, leading to a slow
			// monotonic hashrate degradation. Reuse this buffer instead.
			var reuseBuf = new Uint8Array(1 << 16);
			reuseBuf.set(Module.HEAPU8.subarray(staticPtr, staticPtr + staticLen));
			var staticMod = new WebAssembly.Module(reuseBuf.subarray(0, staticLen));
			var staticInst = new WebAssembly.Instance(staticMod, {
				e: { m: mem },
			});
			var imports = {
				e: {
					m: mem,
					mulh:   staticInst.exports.mulh,
					imulh:  staticInst.exports.imulh,
					tadd:   staticInst.exports.tadd,
					tsub:   staticInst.exports.tsub,
					tmul:   staticInst.exports.tmul,
					tdiv:   staticInst.exports.tdiv,
					tsqrt:  staticInst.exports.tsqrt,
					fprc:   staticInst.exports.fprc,
				},
			};
			ctx._rxjit = { inst: staticInst, imports: imports, buf: reuseBuf };
			t1 = performance.now();
			staticUs = Math.round((t1 - t0) * 1000);
		}
		t1 = performance.now();
		var dynMod;
		// Experiment: if reuse-module flag is set, cache & reuse the
		// first compiled dyn module across all programs. Yields WRONG
		// HASHES on purpose — used to isolate whether per-program
		// `new WebAssembly.Module` is what triggers Safari's
		// run-time degradation. If `run_us` stays flat under this mode,
		// JSC's per-module tier-up state is confirmed as the cause.
		var reuseFlag = Module._rxjit_get_experiment_reuse_module
			? Module._rxjit_get_experiment_reuse_module() : 0;
		var dynInst;
		// reuseFlag>=2: also cache the dynInst (PHASE 0d isolation: tests
		// whether the climbing dyn_compile_us is `new WebAssembly.Module`
		// or `new WebAssembly.Instance`. With dynInst cached too, every
		// hot-path call is just inst.exports.d() — no JS allocation).
		if (reuseFlag >= 2 && ctx._rxjit.cachedDynInst) {
			dynInst = ctx._rxjit.cachedDynInst;
			dynMod = ctx._rxjit.cachedDynMod;
		} else {
			if (reuseFlag && ctx._rxjit.cachedDynMod) {
				dynMod = ctx._rxjit.cachedDynMod;
			} else {
				var buf = ctx._rxjit.buf;
				buf.set(Module.HEAPU8.subarray(dynPtr, dynPtr + dynLen));
				dynMod = new WebAssembly.Module(buf.subarray(0, dynLen));
				if (reuseFlag) ctx._rxjit.cachedDynMod = dynMod;
			}
			dynInst = new WebAssembly.Instance(dynMod, ctx._rxjit.imports);
			if (reuseFlag >= 2) ctx._rxjit.cachedDynInst = dynInst;
		}
		t2 = performance.now();
		dynInst.exports.d();
		t3 = performance.now();
		if (reuseFlag < 2) dynInst = null;
		if (!reuseFlag) dynMod = null;
		Module._rxjit_record_timing(
			staticUs,
			Math.round((t2 - t1) * 1000),
			Math.round((t3 - t2) * 1000)
		);
		return 1;
	} catch (e) {
		var msg = (e && (e.message || String(e))) || 'unknown';
		// Tag failure phase + thread context so main thread can see if it's
		// the static-init (most common) or per-program-dynamic step.
		var phase = ctx._rxjit ? 'dyn' : 'static';
		var tag = (typeof self !== 'undefined' && self.name) ? self.name : 'main';
		var full = '[' + phase + '/' + tag + '] ' + msg;
		if (typeof console !== 'undefined' && console.error) {
			console.error('[rxjit] run failed:', full);
		}
		// Copy into the shared error buffer (last-write-wins).
		try {
			var ptr = Module._rxjit_err_buf_ptr();
			var cap = Module._rxjit_err_buf_size() - 1;
			var enc = new TextEncoder();
			var bytes = enc.encode(full).slice(0, cap);
			Module.HEAPU8.set(bytes, ptr);
			Module.HEAPU8[ptr + bytes.length] = 0;
		} catch (_) { /* ignore */ }
		ctx._rxjit_last_error = full;
		ctx._rxjit_fail_count = (ctx._rxjit_fail_count || 0) + 1;
		return 0;
	}
});
#else
static int rxjit_js_run(int, int, int, int) {
	return 0;
}
#endif

// ---------------- Threaded-interpreter JS runner ----------------
//
// Compiles + instantiates the threaded module ONCE per worker on first
// call, then on every subsequent call just invokes inst.exports.d(). Zero
// JS allocation in the hot path.
//
//   thrPtr/thrLen   : bytes of the threaded module; thrLen==0 means "already
//                     compiled, just call".
// ---------------- Phase D: SuperscalarHash kernel JS bridge ----------------
//
// Called from each pthread worker in initDatasetRangeJitProgress. Lazy
// per-pthread compile+instantiate; subsequent calls just invoke
// `inst.exports.k(start, count)`.
//
//   bytesPtr/bytesLen  module bytes (g_supjit_kernel_bytes). Stable across
//                      calls within a single generation.
//   generation         current value of g_supjit_generation. The JS side
//                      recompiles iff the generation changes.
//   startItem/count    range to process this call.
#ifdef __EMSCRIPTEN__
EM_JS(int, rxjit_js_run_superscalar, (int bytesPtr, int bytesLen, int generation, int startItem, int count), {
	var ctx = (typeof self !== 'undefined') ? self
	        : (typeof globalThis !== 'undefined') ? globalThis
	        : {};
	function findMem() {
		if (Module && Module.wasmMemory instanceof WebAssembly.Memory) return Module.wasmMemory;
		if (typeof wasmMemory !== 'undefined' && wasmMemory instanceof WebAssembly.Memory) return wasmMemory;
		if (typeof self !== 'undefined' && self.wasmMemory instanceof WebAssembly.Memory) return self.wasmMemory;
		return null;
	}
	try {
		if (!ctx._supjit || ctx._supjit_gen !== generation) {
			var mem = findMem();
			if (!mem) throw new Error('wasmMemory unavailable');
			var buf = new Uint8Array(bytesLen);
			buf.set(Module.HEAPU8.subarray(bytesPtr, bytesPtr + bytesLen));
			var mod = new WebAssembly.Module(buf);
			var inst = new WebAssembly.Instance(mod, { e: { m: mem } });
			ctx._supjit = { inst: inst };
			ctx._supjit_gen = generation;
		}
		ctx._supjit.inst.exports.k(startItem, count);
		return 1;
	} catch (e) {
		var msg = (e && (e.message || String(e))) || 'unknown';
		var tag = (typeof self !== 'undefined' && self.name) ? self.name : 'main';
		if (typeof console !== 'undefined' && console.error) {
			console.error('[supjit] kernel run failed:', '[' + tag + '] ' + msg);
		}
		try {
			var ptr = Module._rxjit_err_buf_ptr();
			var cap = Module._rxjit_err_buf_size() - 1;
			var enc = new TextEncoder();
			var bytes = enc.encode('[supjit/' + tag + '] ' + msg).slice(0, cap);
			Module.HEAPU8.set(bytes, ptr);
			Module.HEAPU8[ptr + bytes.length] = 0;
		} catch (_) { /* ignore */ }
		return 0;
	}
});
#else
static int rxjit_js_run_superscalar(int, int, int, int, int) {
	return 0;
}
#endif

#ifdef __EMSCRIPTEN__
EM_JS(int, rxjit_js_run_threaded, (int thrPtr, int thrLen), {
	var ctx = (typeof self !== 'undefined') ? self
	        : (typeof globalThis !== 'undefined') ? globalThis
	        : {};
	function findMem() {
		if (Module && Module.wasmMemory instanceof WebAssembly.Memory) return Module.wasmMemory;
		if (typeof wasmMemory !== 'undefined' && wasmMemory instanceof WebAssembly.Memory) return wasmMemory;
		if (typeof self !== 'undefined' && self.wasmMemory instanceof WebAssembly.Memory) return self.wasmMemory;
		return null;
	}
	try {
		var t0, t1, t2;
		var initUs = 0;
		// thrLen > 0 means C generated a fresh module (new pthread on a reused
		// pool worker, or a new scratchpad): always replace the cached instance,
		// whose baked pointers may be stale.
		if (thrLen > 0 || !ctx._rxjit_threaded) {
			if (thrLen === 0) {
				console.error('[rxjit-threaded] run before init');
				return 0;
			}
			var mem = findMem();
			if (!mem) {
				throw new Error('wasmMemory unavailable (Module.wasmMemory type=' + typeof (Module && Module.wasmMemory) + ')');
			}
			t0 = performance.now();
			// Copy the bytes out of HEAPU8 into a private buffer so the
			// Module compile sees a stable ArrayBuffer that isn't a view
			// over shared memory (some engines refuse / are slow on shared).
			var buf = new Uint8Array(thrLen);
			// The buffer is heap-allocated and may sit above 2 GiB (thrPtr is
			// a signed int) or beyond a stale Module.HEAPU8 view after growth:
			// view the live memory buffer at the unsigned address.
			buf.set(new Uint8Array(mem.buffer, thrPtr >>> 0, thrLen));
			var mod = new WebAssembly.Module(buf);
			var inst = new WebAssembly.Instance(mod, { e: { m: mem } });
			ctx._rxjit_threaded = { inst: inst };
			t1 = performance.now();
			initUs = Math.round((t1 - t0) * 1000);
		}
		t1 = performance.now();
		ctx._rxjit_threaded.inst.exports.d();
		t2 = performance.now();
		var runUs = Math.round((t2 - t1) * 1000);
		// Phase 1a: skip the tier-probe & timing imports once the ring buffer
		// is full. Each Module._foo() crossing is ~5µs on Safari JSC; at
		// ~50 H/s × 8 programs × 2 calls = 800/s pointless boundary crossings.
		if (!ctx._rxjit_tier_probe_silent) {
			Module._rxjit_record_timing(initUs, 0, runUs);
			Module._rxjit_record_run_us_sample(runUs);
			// Once we've recorded enough samples to fill the buffer (a small
			// bit of slack so non-sample-claiming threads' calls still see
			// their contribution before going silent), latch the flag.
			ctx._rxjit_tier_count = (ctx._rxjit_tier_count || 0) + 1;
			if (ctx._rxjit_tier_count >= 2200) ctx._rxjit_tier_probe_silent = true;
		}
		return 1;
	} catch (e) {
		var msg = (e && (e.message || String(e))) || 'unknown';
		var phase = ctx._rxjit_threaded ? 'thr-run' : 'thr-init';
		var tag = (typeof self !== 'undefined' && self.name) ? self.name : 'main';
		var full = '[' + phase + '/' + tag + '] ' + msg;
		if (typeof console !== 'undefined' && console.error) {
			console.error('[rxjit] threaded run failed:', full);
		}
		try {
			var ptr = Module._rxjit_err_buf_ptr();
			var cap = Module._rxjit_err_buf_size() - 1;
			var enc = new TextEncoder();
			var bytes = enc.encode(full).slice(0, cap);
			Module.HEAPU8.set(bytes, ptr);
			Module.HEAPU8[ptr + bytes.length] = 0;
		} catch (_) { /* ignore */ }
		return 0;
	}
});
#else
static int rxjit_js_run_threaded(int, int) {
	return 0;
}
#endif

extern "C" {

EMSCRIPTEN_KEEPALIVE
void rxjit_set_max_memory_pages(uint32_t pages) {
	if (pages > 0) g_jit_max_memory_pages = pages;
}

EMSCRIPTEN_KEEPALIVE
void rxjit_set_experiment_reuse_module(int on) {
	g_rxjit_experiment_reuse_module.store(on, std::memory_order_relaxed);
}

EMSCRIPTEN_KEEPALIVE
int rxjit_get_experiment_reuse_module(void) {
	return g_rxjit_experiment_reuse_module.load(std::memory_order_relaxed);
}

EMSCRIPTEN_KEEPALIVE
void rxjit_set_use_threaded_interp(int on) {
	g_rxjit_use_threaded_interp.store(on, std::memory_order_relaxed);
}

EMSCRIPTEN_KEEPALIVE
void rxjit_set_regs_in_memory(int on) {
	g_rxjit_regs_in_memory.store(on, std::memory_order_relaxed);
}

EMSCRIPTEN_KEEPALIVE
void rxjit_set_split_inner_dispatch(int on) {
	g_rxjit_split_inner_dispatch.store(on, std::memory_order_relaxed);
}

EMSCRIPTEN_KEEPALIVE
void rxjit_set_supjit_enabled(int on) {
	g_rxjit_supjit_enabled.store(on, std::memory_order_relaxed);
}

EMSCRIPTEN_KEEPALIVE
int rxjit_get_supjit_enabled(void) {
	return g_rxjit_supjit_enabled.load(std::memory_order_relaxed);
}

EMSCRIPTEN_KEEPALIVE
void *rxjit_supjit_bytes_ptr(void) {
	return g_supjit_kernel_bytes;
}

EMSCRIPTEN_KEEPALIVE
uint32_t rxjit_supjit_bytes_size(void) {
	return g_supjit_kernel_size.load(std::memory_order_relaxed);
}

EMSCRIPTEN_KEEPALIVE
uint32_t rxjit_supjit_generation(void) {
	return g_supjit_generation.load(std::memory_order_relaxed);
}

// Called by wasm_jit_compiler.cpp::rxInitDatasetStart after generating a
// fresh kernel module. Bumps the generation counter so pthread JS state
// invalidates its cached WebAssembly.Instance.
//
// Memory-order pairing: writers store the byte buffer + size first, then
// release-bump generation. Readers MUST acquire-load generation first
// (line below) — the release/acquire chain synchronises every prior write
// to g_supjit_kernel_bytes and g_supjit_kernel_size. Loading size before
// generation would leave the byte-buffer race-free only by accident.
extern "C" void rxjit_supjit_publish_bytes(uint32_t size) {
	g_supjit_kernel_size.store(size, std::memory_order_relaxed);
	g_supjit_generation.fetch_add(1, std::memory_order_release);
}

// Pthread-callable bridge: invokes the kernel for [startItem, startItem+count).
// Returns 1 on success, 0 on failure (caller should fall back to interpreter).
extern "C" int rxjit_supjit_run_range(uint32_t startItem, uint32_t count) {
	const uint32_t gen = g_supjit_generation.load(std::memory_order_acquire);
	const uint32_t sz = g_supjit_kernel_size.load(std::memory_order_relaxed);
	if (sz == 0) return 0;
	return rxjit_js_run_superscalar((int)(uintptr_t)g_supjit_kernel_bytes, (int)sz, (int)gen,
	                                (int)startItem, (int)count);
}

EMSCRIPTEN_KEEPALIVE
uint32_t rxjit_stat_threaded_module_size(void) {
	return g_rxjit_threaded_module_size.load(std::memory_order_relaxed);
}

// Calling thread's last generated threaded module (bench/jsc_validate.mjs);
// its size is rxjit_stat_threaded_module_size (g_jit_threaded_size is zeroed
// once the bytes are handed to JS).
EMSCRIPTEN_KEEPALIVE
void *rxjit_threaded_module_ptr(void) {
	return g_jit_threaded_buf;
}

EMSCRIPTEN_KEEPALIVE
uint32_t rxjit_stat_threaded_entries(void) {
	return g_rxjit_threaded_entries.load(std::memory_order_relaxed);
}

EMSCRIPTEN_KEEPALIVE
uint32_t rxjit_stat_threaded_phase(void) {
	return g_rxjit_threaded_phase.load(std::memory_order_relaxed);
}

// ---------------- Tier-probe API ----------------
//
// Called from EM_JS after every threaded `inst.exports.d()` invocation.
// First-thread-to-arrive claims the sample slot; others are no-ops. Once
// the buffer fills (2048 calls = ~256 hashes), recording stops.

EMSCRIPTEN_KEEPALIVE
void rxjit_record_run_us_sample(uint32_t run_us) {
	if (!g_rxjit_is_sample_thread) {
		int expected = 0;
		if (g_rxjit_sample_thread_claimed.compare_exchange_strong(expected, 1,
		                                                          std::memory_order_acq_rel)) {
			g_rxjit_is_sample_thread = true;
		} else {
			return;
		}
	}
	uint32_t i = g_rxjit_sample_count.fetch_add(1, std::memory_order_relaxed);
	if (i < RXJIT_SAMPLE_BUF_SIZE) {
		g_rxjit_run_us_samples[i] = run_us;
	}
}

EMSCRIPTEN_KEEPALIVE
void *rxjit_get_samples_ptr(void) {
	return g_rxjit_run_us_samples;
}

EMSCRIPTEN_KEEPALIVE
uint32_t rxjit_get_samples_capacity(void) {
	return RXJIT_SAMPLE_BUF_SIZE;
}

EMSCRIPTEN_KEEPALIVE
uint32_t rxjit_get_samples_count(void) {
	uint32_t c = g_rxjit_sample_count.load(std::memory_order_relaxed);
	return c > RXJIT_SAMPLE_BUF_SIZE ? RXJIT_SAMPLE_BUF_SIZE : c;
}

EMSCRIPTEN_KEEPALIVE uint32_t rxjit_stat_runs(void) {
	return g_rxjit_runs.load(std::memory_order_relaxed);
}
EMSCRIPTEN_KEEPALIVE uint32_t rxjit_stat_fails(void) {
	return g_rxjit_fails.load(std::memory_order_relaxed);
}
EMSCRIPTEN_KEEPALIVE uint32_t rxjit_stat_static_init_attempts(void) {
	return g_rxjit_static_init_attempts.load(std::memory_order_relaxed);
}
EMSCRIPTEN_KEEPALIVE uint32_t rxjit_stat_static_init_failures(void) {
	return g_rxjit_static_init_failures.load(std::memory_order_relaxed);
}
EMSCRIPTEN_KEEPALIVE uint32_t rxjit_stat_static_compile_us(void) {
	return g_rxjit_static_compile_us.load(std::memory_order_relaxed);
}
EMSCRIPTEN_KEEPALIVE uint32_t rxjit_stat_dyn_compile_us(void) {
	return g_rxjit_dyn_compile_us.load(std::memory_order_relaxed);
}
EMSCRIPTEN_KEEPALIVE uint32_t rxjit_stat_run_us(void) {
	return g_rxjit_run_us.load(std::memory_order_relaxed);
}
EMSCRIPTEN_KEEPALIVE double rxjit_stat_dispatches(void) {
	return (double)g_rxjit_dispatches.load(std::memory_order_relaxed);
}
EMSCRIPTEN_KEEPALIVE double rxjit_stat_decoded_programs(void) {
	return (double)g_rxjit_decoded_programs.load(std::memory_order_relaxed);
}
EMSCRIPTEN_KEEPALIVE void rxjit_stat_reset(void) {
	g_rxjit_runs.store(0, std::memory_order_relaxed);
	g_rxjit_fails.store(0, std::memory_order_relaxed);
	g_rxjit_static_compile_us.store(0, std::memory_order_relaxed);
	g_rxjit_dyn_compile_us.store(0, std::memory_order_relaxed);
	g_rxjit_run_us.store(0, std::memory_order_relaxed);
	g_rxjit_dispatches.store(0, std::memory_order_relaxed);
	g_rxjit_decoded_programs.store(0, std::memory_order_relaxed);
}
// Called from the EM_JS runner after each timed phase.
EMSCRIPTEN_KEEPALIVE void rxjit_record_timing(uint32_t static_us, uint32_t dyn_us,
                                              uint32_t run_us) {
	if (static_us) g_rxjit_static_compile_us.fetch_add(static_us, std::memory_order_relaxed);
	if (dyn_us) g_rxjit_dyn_compile_us.fetch_add(dyn_us, std::memory_order_relaxed);
	if (run_us) g_rxjit_run_us.fetch_add(run_us, std::memory_order_relaxed);
}

// Returns a stable pointer to a 512-byte shared error buffer that any
// pthread JIT runner can write into. Main thread polls and surfaces.
EMSCRIPTEN_KEEPALIVE void *rxjit_err_buf_ptr(void) {
	return g_rxjit_err_buf;
}
EMSCRIPTEN_KEEPALIVE uint32_t rxjit_err_buf_size(void) {
	return (uint32_t)RXJIT_ERR_BUF;
}

// Feature bits the JIT emitter consults at module-gen time:
//   bit 0  RELAXED_SIMD
//   bit 1  FMA (implies relaxed)
//   bit 2  INLINE_FPRC_ZERO
//   bits 3..7, 8..10 (layout pad): see RXJIT_FEATURE_* in wasm_jit_gen.h
// Set from the main thread; read by every pthread worker — must be atomic
// so the C++ memory model is satisfied. Initial value 0 (baseline emitter).
static std::atomic<int> g_rxjit_feature{0};

EMSCRIPTEN_KEEPALIVE
void rxjit_set_feature(int feature) {
	g_rxjit_feature.store(feature & RXJIT_FEATURE_MASK, std::memory_order_relaxed);
}

// Threaded-module generator profile + knob overrides (wasm_jit_profile.h).
// Like the feature, read by each pthread when it (re)generates its module;
// a change regenerates the module on that thread's next program.
static std::atomic<int> g_rxjit_profile{RXJIT_PROFILE_ARM};
static std::atomic<int> g_rxjit_fuse_n_override{-1};    // -1: the profile's fuse_n
static std::atomic<int> g_rxjit_triples_n_override{-1}; // -1: the profile's triples_n

EMSCRIPTEN_KEEPALIVE
void rxjit_set_profile(int id) {
	if (id >= 0 && id < RXJIT_PROFILE_COUNT) g_rxjit_profile.store(id, std::memory_order_relaxed);
}

EMSCRIPTEN_KEEPALIVE
int rxjit_get_profile(void) {
	return g_rxjit_profile.load(std::memory_order_relaxed);
}

EMSCRIPTEN_KEEPALIVE
void rxjit_set_fuse_n(int n) {
	g_rxjit_fuse_n_override.store(n < 0 ? -1 : n, std::memory_order_relaxed);
}

EMSCRIPTEN_KEEPALIVE
void rxjit_set_triples_n(int n) {
	g_rxjit_triples_n_override.store(n < 0 ? -1 : n, std::memory_order_relaxed);
}

int rxjit_fuse_n_for_feature(int jit_feature) {
	if (jit_feature & RXJIT_FEATURE_NO_FUSE) return 0;
	int n = g_rxjit_fuse_n_override.load(std::memory_order_relaxed);
	if (n < 0) n = rxjit_profiles[g_rxjit_profile.load(std::memory_order_relaxed)].fuse_n;
	return n > RXJIT_FUSE_NMAX ? RXJIT_FUSE_NMAX : n;
}

// Fused triple kinds (X2), like fuse_n: 0 with RXJIT_FEATURE_NO_FUSE, else the
// rxjit_set_triples_n override (>= 0) or the profile's, clamped to
// [0, RXJIT_TRIPLE_NMAX].
static int rxjit_triples_n_for_feature(int jit_feature) {
	if (jit_feature & RXJIT_FEATURE_NO_FUSE) return 0;
	int n = g_rxjit_triples_n_override.load(std::memory_order_relaxed);
	if (n < 0) n = rxjit_profiles[g_rxjit_profile.load(std::memory_order_relaxed)].triples_n;
	return n > RXJIT_TRIPLE_NMAX ? RXJIT_TRIPLE_NMAX : n;
}

// Status getters (bench headers, the worker's status line): what the next
// generated module uses with the current feature and knobs.
EMSCRIPTEN_KEEPALIVE
int rxjit_effective_fuse_n(void) {
	return rxjit_fuse_n_for_feature(g_rxjit_feature.load(std::memory_order_relaxed));
}

EMSCRIPTEN_KEEPALIVE
int rxjit_effective_triples_n(void) {
	return rxjit_triples_n_for_feature(g_rxjit_feature.load(std::memory_order_relaxed));
}

EMSCRIPTEN_KEEPALIVE
int rxjit_effective_kind16(void) {
	return rxjit_kind16(rxjit_effective_fuse_n(), rxjit_effective_triples_n());
}

// 2x dispatch replication is not generated yet: reads 0 until the generator
// uses it.
EMSCRIPTEN_KEEPALIVE
int rxjit_effective_unroll2(void) {
	return 0;
}

EMSCRIPTEN_KEEPALIVE
uint32_t rxjit_test_generate(void *program256, void *vm_state, void *scratchpad, void *dataset,
                             uint64_t dataset_offset, uint32_t rr0, uint32_t rr1, uint32_t rr2,
                             uint32_t rr3, uint32_t mem_min_pages, uint32_t mem_max_pages,
                             int feature, void *outBuf) {
	uint8_t read_regs[4] = {(uint8_t)rr0, (uint8_t)rr1, (uint8_t)rr2, (uint8_t)rr3};
	return rxjit_generate_dynamic_module((rxjit_vm_state_t *)vm_state, (rxjit_inst_t *)program256,
	                                     (uint8_t *)scratchpad, (uint8_t *)dataset, dataset_offset,
	                                     read_regs, mem_min_pages, mem_max_pages, feature,
	                                     (uint8_t *)outBuf);
}

EMSCRIPTEN_KEEPALIVE
uint32_t rxjit_test_generate_static(uint32_t mem_min_pages, uint32_t mem_max_pages, int feature,
                                    void *outBuf) {
	return rxjit_generate_static_module(mem_min_pages, mem_max_pages, feature, (uint8_t *)outBuf);
}

} // extern "C"

namespace randomx {

// ---------------- Threaded-interpreter path ----------------
//
// Allocates the per-thread program slot + vm_state once, generates the
// threaded module bytes once, then on every call writes per-program state
// into vm_state and the decoded program into the slot, and invokes
// inst.exports.d() via rxjit_js_run_threaded.
#ifdef __EMSCRIPTEN__
static int rxjit_run_program_threaded(NativeRegisterFile &nreg,
                                      Instruction program_buf[RANDOMX_PROGRAM_MAX_SIZE],
                                      const ProgramConfiguration &config, uint8_t *scratchpad,
                                      uint8_t *dataset, uint64_t dataset_offset, uint32_t ma,
                                      uint32_t mx) {
	g_rxjit_threaded_entries.fetch_add(1, std::memory_order_relaxed);
	if (g_jit_threaded_failed) return 0;

	if (!g_jit_threaded_initted) {
		g_rxjit_threaded_phase.store(1, std::memory_order_relaxed);
		// 1) allocate the per-thread arena (vm_state + program slot + reserved
		// areas), 128-B aligned so no cache line is shared with other threads.
		static_assert(sizeof(rxjit_vm_state_t) <= RXJIT_ARENA_RMASK_OFF, "vm_state grew");
		static_assert(alignof(rxjit_vm_state_t) <= RXJIT_ARENA_ALIGN, "vm_state alignment");
		static_assert(sizeof(decoded_inst_t) * 256 <= RXJIT_ARENA_SENT_OFF - RXJIT_ARENA_SLOT_OFF,
		              "program slot overflows the arena");
		static_assert(RXJIT_ARENA_SIZE % RXJIT_ARENA_ALIGN == 0, "aligned_alloc size");
		uint8_t *blk = (uint8_t *)aligned_alloc(RXJIT_ARENA_ALIGN, RXJIT_ARENA_SIZE);
		g_jit_threaded_buf = (uint8_t *)malloc(RXJIT_THREADED_BUF_SIZE);
		if (!blk || !g_jit_threaded_buf) {
			g_rxjit_threaded_phase.store(101, std::memory_order_relaxed);
			free(blk);
			free(g_jit_threaded_buf);
			g_jit_threaded_buf = nullptr;
			g_jit_threaded_failed = true;
			return 0;
		}
		memset(blk, 0, RXJIT_ARENA_SIZE);
		g_jit_threaded_vm_state = (rxjit_vm_state_t *)(blk + RXJIT_ARENA_VM_OFF);
		g_jit_threaded_program_slot = blk + RXJIT_ARENA_SLOT_OFF;
		{
			// Sentinel record #256 terminates the inner pointer walk. Bytes 12..15
			// hold the slot address: the inner loop loads it (an i32.load, not a
			// constant, so TurboFan keeps the walk pointer zero-extended). With
			// u16 kinds the kind is s[0] | s[1] << 8: s[1] stays 0 (the arena is
			// zeroed), so one sentinel serves both record head widths.
			uint8_t *s = blk + RXJIT_ARENA_SENT_OFF;
			s[0] = RXJIT_K_EXIT;
			s[1] = 0;
			uint32_t slot = (uint32_t)(uintptr_t)(blk + RXJIT_ARENA_SLOT_OFF);
			memcpy(s + 12, &slot, 4);
		}
		{
			// Inline directed-rounding masks (step 3): mode m (fprc 0=RN 1=RD
			// 2=RU 3=RZ) at +RMASK_OFF + m*128, i64x2 splats in the order
			// TEG, TEL, K1, K2, D1, D3, KON (see wasm_jit_threaded.c).
			const uint64_t PI = 0x7FF0000000000000ull, NI = 0xFFF0000000000000ull, A = ~0ull;
			static const uint64_t RM[4][7] = {
			    {PI, NI, 0, 0, 0, 1, 0}, // RN
			    {PI, 0, 0, 0, A, 1, A},  // RD
			    {0, NI, A, 0, 0, 1, A},  // RU
			    {PI, 0, 0, A, 0, A, A},  // RZ
			};
			static_assert(RXJIT_ARENA_RMASK_OFF + 4 * 128 <= RXJIT_ARENA_PAD_OFF, "rmask table");
			for (int m = 0; m < 4; m++)
				for (int i = 0; i < 7; i++) {
					uint8_t *q = blk + RXJIT_ARENA_RMASK_OFF + m * 128 + 16 * i;
					memcpy(q, &RM[m][i], 8);
					memcpy(q + 8, &RM[m][i], 8);
				}
		}
		g_jit_threaded_vm_state->mmask[0] = DYNAMIC_MANTISSA_MASK;
		g_jit_threaded_vm_state->mmask[1] = DYNAMIC_MANTISSA_MASK;
		g_rxjit_threaded_phase.store(3, std::memory_order_relaxed);
	}

	// 2) generate the threaded module bytes (with per-thread pointers baked):
	// once per thread, and again whenever the scratchpad moves (a new VM on
	// this pthread) or the feature / fuse_n / triples_n / record head width
	// changes. The JS side sees thrLen > 0 and recompiles.
	const int feature = g_rxjit_feature.load(std::memory_order_relaxed);
	const int fuse_n = rxjit_fuse_n_for_feature(feature);
	const int triples_n = rxjit_triples_n_for_feature(feature);
	const int kind16 = rxjit_kind16(fuse_n, triples_n);
	if (!g_jit_threaded_initted || (uint32_t)(uintptr_t)scratchpad != g_jit_threaded_baked_sp ||
	    feature != g_jit_threaded_feature || fuse_n != g_jit_threaded_fuse_n ||
	    triples_n != g_jit_threaded_triples_n || kind16 != g_jit_threaded_kind16) {
		int regs_in_mem = g_rxjit_regs_in_memory.load(std::memory_order_relaxed);
		int split_id = g_rxjit_split_inner_dispatch.load(std::memory_order_relaxed);
		uint32_t sz = rxjit_generate_threaded_module(
		    (uint32_t)(uintptr_t)g_jit_threaded_vm_state, (uint32_t)(uintptr_t)scratchpad,
		    (uint32_t)(uintptr_t)dataset, (uint32_t)(uintptr_t)g_jit_threaded_program_slot, 1,
		    g_jit_max_memory_pages, feature, regs_in_mem, split_id, fuse_n, triples_n, kind16,
		    g_jit_threaded_buf);
		g_rxjit_threaded_module_size.store(sz, std::memory_order_relaxed);
		if (sz == 0 || sz > RXJIT_THREADED_BUF_SIZE) {
			g_rxjit_threaded_phase.store(103, std::memory_order_relaxed);
			free(g_jit_threaded_vm_state); // the arena base; the slot lives inside it
			free(g_jit_threaded_buf);
			g_jit_threaded_program_slot = nullptr;
			g_jit_threaded_vm_state = nullptr;
			g_jit_threaded_buf = nullptr;
			g_jit_threaded_size = 0;
			g_jit_threaded_failed = true;
			return 0;
		}
		g_jit_threaded_size = sz;
		g_jit_threaded_baked_sp = (uint32_t)(uintptr_t)scratchpad;
		g_jit_threaded_feature = feature;
		g_jit_threaded_fuse_n = fuse_n;
		g_jit_threaded_triples_n = triples_n;
		g_jit_threaded_kind16 = kind16;
		// Step 9: inner_dispatch loads the scratchpad base from the arena into an
		// opaque local (a baked i32.const would be rematerialised in every arm).
		{
			uint32_t spb = (uint32_t)(uintptr_t)scratchpad;
			memcpy((uint8_t *)g_jit_threaded_vm_state + RXJIT_ARENA_SPB_OFF, &spb, 4);
		}
		g_jit_threaded_initted = true;
		g_rxjit_threaded_phase.store(10, std::memory_order_relaxed);
	}

	// Per-call: write inputs into vm_state.
	rxjit_vm_state_t *vm = g_jit_threaded_vm_state;
	memcpy(vm->r, nreg.r, sizeof(vm->r));
	memcpy(vm->f, &nreg.f[0], sizeof(vm->f));
	memcpy(vm->e, &nreg.e[0], sizeof(vm->e));
	memcpy(vm->a, &nreg.a[0], sizeof(vm->a));
	vm->emask[0] = config.eMask[0];
	vm->emask[1] = config.eMask[1];
	vm->fprc = wasm_rounding_mode;
	vm->ma = ma;
	vm->mx = mx;
	vm->read_regs[0] = (uint8_t)config.readReg0;
	vm->read_regs[1] = (uint8_t)config.readReg1;
	vm->read_regs[2] = (uint8_t)config.readReg2;
	vm->read_regs[3] = (uint8_t)config.readReg3;
	vm->dataset_ptr_with_offset = (uint32_t)((uintptr_t)dataset + (uintptr_t)dataset_offset);

	// Decode program into the slot.
	// Layout v2 bakes this thread's vm_state address into every record.
	int ndisp = rxjit_decode_for_interp(
	    (const rxjit_inst_t *)program_buf, (decoded_inst_t *)g_jit_threaded_program_slot,
	    (uint32_t)(uintptr_t)g_jit_threaded_vm_state, g_jit_threaded_fuse_n,
	    g_jit_threaded_triples_n, g_jit_threaded_kind16);
	g_rxjit_dispatches.fetch_add((uint64_t)ndisp, std::memory_order_relaxed);
	g_rxjit_decoded_programs.fetch_add(1, std::memory_order_relaxed);

	// Invoke (lazy compile+instantiate on first call). The first call sees
	// g_jit_threaded_size > 0 and hands the bytes over; subsequent calls
	// pass len=0 to signal "module already compiled on the JS side". Only
	// count the once-per-thread init in static_init_attempts so the counter
	// stays comparable with the legacy dynamic-module path.
	bool first_js_call = (g_jit_threaded_size > 0);
	if (first_js_call) {
		g_rxjit_static_init_attempts.fetch_add(1, std::memory_order_relaxed);
	}
	int ok = rxjit_js_run_threaded((int)(uintptr_t)g_jit_threaded_buf,
	                               (int)(first_js_call ? g_jit_threaded_size : 0));
	if (first_js_call) g_jit_threaded_size = 0; // bytes consumed; module is JS-side now
	if (!ok) {
		g_rxjit_fails.fetch_add(1, std::memory_order_relaxed);
		g_jit_threaded_failed = true;
		return 0;
	}
	g_rxjit_runs.fetch_add(1, std::memory_order_relaxed);

	// Copy r/f/e back into nreg from vm_state.
	memcpy(nreg.r, vm->r, sizeof(vm->r));
	memcpy(&nreg.f[0], vm->f, sizeof(vm->f));
	memcpy(&nreg.e[0], vm->e, sizeof(vm->e));
	wasm_rounding_mode = vm->fprc;
	return 1;
}
#endif

int rxjit_run_program_full(NativeRegisterFile &nreg,
                           Instruction program_buf[RANDOMX_PROGRAM_MAX_SIZE],
                           const ProgramConfiguration &config, uint8_t *scratchpad,
                           uint8_t *dataset, uint64_t dataset_offset, uint32_t ma, uint32_t mx) {
#ifdef __EMSCRIPTEN__
	if (g_rxjit_use_threaded_interp.load(std::memory_order_relaxed) != 0) {
		return rxjit_run_program_threaded(nreg, program_buf, config, scratchpad, dataset,
		                                  dataset_offset, ma, mx);
	}
	if (g_jit_static_failed) return 0;

	// Once per thread, generate the static-module bytes. The actual JS-side
	// compile+instantiate also happens once (lazily inside EM_ASM), so the
	// per-call cost in steady state is just one JS function invocation.
	const int feature = g_rxjit_feature.load(std::memory_order_relaxed);
	bool first_call = (g_jit_static_size == 0);
	if (first_call) {
		g_rxjit_static_init_attempts.fetch_add(1, std::memory_order_relaxed);
		uint32_t sz = rxjit_generate_static_module(1, g_jit_max_memory_pages, feature,
		                                           g_jit_static_buf);
		if (sz == 0 || sz > sizeof(g_jit_static_buf)) {
			g_jit_static_failed = true;
			g_rxjit_static_init_failures.fetch_add(1, std::memory_order_relaxed);
			return 0;
		}
		g_jit_static_size = sz;
	}

	alignas(16) rxjit_vm_state_t vm;
	memcpy(vm.r, nreg.r, sizeof(vm.r));
	memcpy(vm.f, &nreg.f[0], sizeof(vm.f));
	memcpy(vm.e, &nreg.e[0], sizeof(vm.e));
	memcpy(vm.a, &nreg.a[0], sizeof(vm.a));
	vm.emask[0] = config.eMask[0];
	vm.emask[1] = config.eMask[1];
	vm.mmask[0] = DYNAMIC_MANTISSA_MASK;
	vm.mmask[1] = DYNAMIC_MANTISSA_MASK;
	vm.fprc = wasm_rounding_mode;
	vm.ma = ma;
	vm.mx = mx;
	vm._pad = 0;

	const uint8_t read_regs[4] = {
	    (uint8_t)config.readReg0,
	    (uint8_t)config.readReg1,
	    (uint8_t)config.readReg2,
	    (uint8_t)config.readReg3,
	};

	uint32_t dyn_size = rxjit_generate_dynamic_module(
	    &vm, (rxjit_inst_t *)program_buf, scratchpad, dataset, dataset_offset, read_regs, 1,
	    g_jit_max_memory_pages, feature, g_jit_dyn_buf);

	if (dyn_size == 0 || dyn_size > sizeof(g_jit_dyn_buf)) return 0;

	// Hand both buffers to JS. JS lazily compiles the static module the
	// first time it sees non-zero static_size, then re-uses it forever.
	int ok =
	    rxjit_js_run((int)(uintptr_t)g_jit_dyn_buf, (int)dyn_size, (int)(uintptr_t)g_jit_static_buf,
	                 (int)(first_call ? g_jit_static_size : 0));

	if (!ok) {
		g_rxjit_fails.fetch_add(1, std::memory_order_relaxed);
		if (first_call) {
			g_jit_static_failed = true;
			g_rxjit_static_init_failures.fetch_add(1, std::memory_order_relaxed);
		}
		return 0;
	}
	g_rxjit_runs.fetch_add(1, std::memory_order_relaxed);

	memcpy(nreg.r, vm.r, sizeof(vm.r));
	memcpy(&nreg.f[0], vm.f, sizeof(vm.f));
	memcpy(&nreg.e[0], vm.e, sizeof(vm.e));
	wasm_rounding_mode = vm.fprc;
	return 1;
#else
	(void)nreg;
	(void)program_buf;
	(void)config;
	(void)scratchpad;
	(void)dataset;
	(void)dataset_offset;
	(void)ma;
	(void)mx;
	return 0;
#endif
}

} // namespace randomx
