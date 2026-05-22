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
//   buf             output buffer (caller-owned). 64 KiB is plenty.
//
// Returns number of bytes written into buf. The module exports a single
// "d" function (takes no arguments, returns nothing) that runs the full
// 2048-iteration program; everything else is internal.
uint32_t rxjit_generate_threaded_module(uint32_t vm_state_ptr, uint32_t scratchpad_ptr,
                                        uint32_t dataset_ptr, uint32_t program_slot_ptr,
                                        uint32_t mem_min_pages, uint32_t mem_max_pages,
                                        int jit_feature, int regs_in_memory,
                                        int split_inner_dispatch, uint8_t *buf);

#ifdef __cplusplus
}
#endif
