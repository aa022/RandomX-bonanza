// C-side WASM JIT: generates a complete, self-contained WASM module that
// runs RANDOMX_PROGRAM_ITERATIONS rounds of a single RandomX program against
// a thread-local VM state + scratchpad + dataset. Module imports only a
// shared linear memory ("e.m"); all absolute addresses to VM state, the
// scratchpad and the dataset are baked in at module-generation time.
#pragma once

#include <stdint.h>
#include "wasm_jit_decode.h"

#ifdef __cplusplus
extern "C" {
#endif

// 16-byte aligned VM state laid out exactly the way the JIT module loads /
// stores via absolute pointers. Offsets must match the prologue/epilogue
// emitter in wasm_jit_gen.c.
//
//  +0   r[0..7]   i64x8           64 bytes
//  +64  f[0..3]   v128x4          64 bytes
//  +128 e[0..3]   v128x4          64 bytes
//  +192 a[0..3]   v128x4          64 bytes  (read-only input)
//  +256 emask[2]  u64x2           16 bytes
//  +272 mmask[2]  u64x2           16 bytes  (DYNAMIC_MANTISSA_MASK x2)
//  +288 fprc      u32              4 bytes
//  +292 ma        u32              4 bytes
//  +296 mx        u32              4 bytes
typedef struct rxjit_vm_state {
	uint64_t r[8];     // +0
	uint64_t f[4][2];  // +64
	uint64_t e[4][2];  // +128
	uint64_t a[4][2];  // +192
	uint64_t emask[2]; // +256
	uint64_t mmask[2]; // +272 (constant DYNAMIC_MANTISSA_MASK x2)
	uint32_t fprc;     // +288
	uint32_t ma;       // +292
	uint32_t mx;       // +296
	uint32_t _pad;     // +300 (align next field)
	// Fields below are consumed only by the threaded-interp main_loop.
	// The dynamic-module path ignores them, so adding them is backward-
	// compatible with the existing emit code.
	uint8_t read_regs[4];             // +304  read_reg0..3 indices [0..7]
	uint32_t dataset_ptr_with_offset; // +308  pre-added base + offset
} rxjit_vm_state_t;

enum {
	RXJIT_FEATURE_BASELINE = 0,
	RXJIT_FEATURE_RELAXED_SIMD = 1,
	RXJIT_FEATURE_FMA = 2, // implies RELAXED_SIMD
	// When fprc==0 (round-to-nearest, ~75% of all float ops in steady
	// state), the corresponding semifloat stub is literally the native
	// f64x2 op. Inlining a `if fprc { call_indirect } else { native }`
	// branch avoids the call_indirect dispatch in the hot path. Costs
	// ~15B per float op of dynamic-module size, so it's deliberately
	// gated — Safari, where call_indirect dispatch is expensive AND
	// memory pressure isn't the bottleneck, gets it. Firefox/Chrome,
	// where smaller modules matter more, leave it off.
	RXJIT_FEATURE_INLINE_FPRC_ZERO = 4,
};

// Generate the static module — compile this ONCE per worker thread. It
// contains the 22 SIMD semifloat + mulh stubs and exports their function
// indices via 5 funcref tables + 2 direct exports + the fprc global.
uint32_t rxjit_generate_static_module(uint32_t mem_min_pages, uint32_t mem_max_pages,
                                      int jit_feature, uint8_t *buf);

// Generate a dynamic per-program module that executes one full RandomX
// program (2048 iterations) against the supplied VM state + scratchpad +
// dataset. Imports memory, the 5 tables, the fprc global and the 2 mulh
// functions from the static module; only contains the main function.
//
// Layout / ownership notes:
//   - `vm`         absolute pointer (in linear memory) to the rxjit_vm_state_t
//   - `program`    256-instruction raw RandomX program; mutated in place
//                  during decoding (opcodes get canonicalised)
//   - `scratchpad` absolute pointer (in linear memory), 2 MiB
//   - `dataset`    absolute pointer (in linear memory) to dataset BASE; this
//                  function folds `dataset_offset` into the absolute pointer
//                  baked into the emitted WASM
//   - `dataset_offset` byte offset for this program (per-VM-init constant)
//   - `read_regs`  4 register indices [0..7] used in step 1 (sp_mix) and
//                  step 5 (mx XOR) of the VM main loop — baked into the
//                  WASM at code-emit time
//   - `mem_min_pages` / `mem_max_pages` shared-memory limits for the import
//   - `jit_feature` bitmask of RXJIT_FEATURE_*
//   - `buf`        output buffer (caller-owned, must be large enough — a
//                  module for a 256-instruction program is well under 64 KiB)
//   - returns the number of bytes written into `buf`
uint32_t rxjit_generate_dynamic_module(rxjit_vm_state_t *vm, rxjit_inst_t program[256],
                                       uint8_t *scratchpad, uint8_t *dataset,
                                       uint64_t dataset_offset, const uint8_t read_regs[4],
                                       uint32_t mem_min_pages, uint32_t mem_max_pages,
                                       int jit_feature, uint8_t *buf);

// Compute the same reciprocal as randomx_reciprocal but exposed for the
// instruction emitter (so we can keep wasm_jit_inst.c freestanding-ish).
uint64_t rxjit_reciprocal(uint32_t divisor);

#ifdef __cplusplus
}
#endif
