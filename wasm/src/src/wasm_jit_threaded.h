// Threaded-interpreter WASM module: ONE resident module per pthread that
// runs every RandomX program by reading a 256×16-byte decoded-instruction
// array out of linear memory and dispatching opcodes via a br_table.
//
// Per-thread: compile + instantiate ONCE; eliminates per-program new
// WebAssembly.Module/Instance allocation (proven cause of Safari JSC
// run-time degradation under the old dynamic-module-per-program design).
#pragma once

#include <stdint.h>
#include "wasm_jit_gen.h" // rxjit_vm_state_t

// Per-thread arena: one aligned_alloc(RXJIT_ARENA_ALIGN, RXJIT_ARENA_SIZE)
// block per pthread holds vm_state and the program slot (M4 cache lines are
// 128 B, so nothing is shared with other threads' data).
//   +0     rxjit_vm_state_t (312 B)          vm_state_ptr = blk
//   +320   rounding-mask table, 4 x 128 B
//   +832   64 B layout-pad dummy-store area (feature bits 256..1024)
//   +896   u32 scratchpad base
//   +1024  program slot: 256 records x 16 B  program_slot_ptr = blk + 1024
//   +5120  sentinel record #256
#define RXJIT_ARENA_ALIGN     128
#define RXJIT_ARENA_VM_OFF    0
#define RXJIT_ARENA_RMASK_OFF 320
#define RXJIT_ARENA_PAD_OFF   832
#define RXJIT_ARENA_SPB_OFF   896
#define RXJIT_ARENA_SLOT_OFF  1024
#define RXJIT_ARENA_SENT_OFF  5120
#define RXJIT_ARENA_SIZE      6144

#ifdef __cplusplus
extern "C" {
#endif

// Generate a complete self-contained WASM module that runs an entire
// RandomX program against linear memory. All per-thread pointers are baked
// in as i32.const; per-program state lives in vm_state and program_slot,
// loaded at main_loop prologue.
//
// Arguments:
//   vm_state_ptr    absolute pointer to the rxjit_vm_state_t in linear mem.
//   scratchpad_ptr  absolute pointer to the 2 MiB scratchpad base.
//   dataset_ptr     absolute pointer to the dataset BASE (no offset folded).
//                   The dataset_offset is loaded per-call from vm_state.
//   program_slot_ptr absolute pointer to a 4 KiB block in linear memory
//                   where the C side writes 256 decoded_inst_t records
//                   before invoking main_loop.
//   mem_min_pages   shared-memory limits for the import.
//   mem_max_pages
//   jit_feature     bitmask of RXJIT_FEATURE_* (FMA/RELAXED_SIMD/etc.)
//   fuse_n          fused pair kinds (rxjit_fuse_n_for_feature)
//   triples_n       fused triple kinds, after the pairs (X2)
//   kind16          record head width (rxjit_kind16); the decoder must be
//                   called with the same fuse_n, triples_n and kind16
//   shared_code     no per-thread pointer in the bytes (wasm_jit_profile.h):
//                   the four pointers are ignored, the module exports a
//                   mutable i32 global "a" that must be set to the arena
//                   base (vm_state) before "d" runs, and every address is
//                   arena-relative (the scratchpad base from +SPB_OFF)
//   buf             output buffer (caller-owned), rxjit_threaded_buf_need() bytes
//                   in wasm_jit_run.cpp; ~40 KiB at 200 pairs, far more
//                   with every pair and triple.
//
// Returns number of bytes written into buf. The module exports a single
// "d" function (takes no arguments, returns nothing) that runs the full
// 2048-iteration program; everything else is internal.
uint32_t rxjit_generate_threaded_module(uint32_t vm_state_ptr, uint32_t scratchpad_ptr,
                                        uint32_t dataset_ptr, uint32_t program_slot_ptr,
                                        uint32_t mem_min_pages, uint32_t mem_max_pages,
                                        int jit_feature, int regs_in_memory,
                                        int split_inner_dispatch, int fuse_n, int triples_n,
                                        int kind16, int shared_code, uint8_t *buf);

#ifdef __cplusplus
}
#endif
