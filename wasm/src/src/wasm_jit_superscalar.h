// Phase D: WASM JIT for SuperscalarHash dataset init.
//
// Generates ONE wasm module per cache rebuild (cache lives ~2 days on a real
// chain, so amortized compile cost is negligible). The module exports a
// single function "k" with signature (i32 startItem, i32 count) -> () that
// runs the entire initDatasetItem loop (RANDOMX_CACHE_ACCESSES programs,
// cache-line mix, dataset write) inline for [startItem, startItem+count).
//
// The 8 SuperscalarHash programs are inlined directly as wasm code; per-item
// dispatch overhead and per-instruction switch dispatch both vanish. Wasm
// engines can register-allocate the r[0..7] locals and OMG-tier the loop.
// Target: 3-5× wall-clock reduction in dataset init.
#pragma once

#include <stdint.h>
#include "superscalar.hpp"

#ifdef __cplusplus
extern "C" {
#endif

// Generate a complete WASM module that runs initDatasetItem for a range of
// dataset items.
//
//   programs        the 8 DecodedSuperscalarPrograms from randomx_cache.
//   cache_base      absolute pointer (in linear memory) to the 256 MiB
//                   randomx cache, baked into the module as i32.const.
//   dataset_base    absolute pointer to the dataset memory, baked in.
//   mem_min_pages / mem_max_pages  shared-memory import limits.
//   buf             output buffer (caller-owned). 64 KiB is plenty for an
//                   ~8-program kernel (~30-40 KiB typical).
//
// Returns number of bytes written into buf. The module imports "e.m" (shared
// memory) and exports "k" (the kernel function).
uint32_t rxjit_generate_superscalar_kernel(
    const randomx::DecodedSuperscalarProgram programs[/*RANDOMX_CACHE_ACCESSES*/],
    uint32_t cache_base, uint32_t dataset_base, uint32_t mem_min_pages, uint32_t mem_max_pages,
    uint8_t *buf);

// Light mode (wasm_jit_threaded.c): the function body (locals + code + end,
// no size prefix) of item(i32 item, i32 out) -> (), one initDatasetItem into
// out. Expects mulh/smulh at function indices 0/1. At most ~64 KiB.
uint32_t rxjit_emit_superscalar_item_fn(
    const randomx::DecodedSuperscalarProgram programs[/*RANDOMX_CACHE_ACCESSES*/],
    uint32_t cache_base, uint8_t *buf);

// Light 2-VM lockstep: the function body of item2(i32 itemA, i32 outA, i32
// itemB, i32 outB) -> (), two initDatasetItem interleaved instruction by
// instruction (same cache). At most ~128 KiB.
uint32_t rxjit_emit_superscalar_item2_fn(
    const randomx::DecodedSuperscalarProgram programs[/*RANDOMX_CACHE_ACCESSES*/],
    uint32_t cache_base, uint8_t *buf);

#ifdef __cplusplus
}
#endif
