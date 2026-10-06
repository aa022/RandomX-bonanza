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

// Items per kernel loop trip (rxjit_set_kernel_k): 1..RXJIT_KERNEL_K_MAX.
#define RXJIT_KERNEL_K_MAX 4

// Generate a complete WASM module that runs initDatasetItem for a range of
// dataset items.
//
//   programs        the 8 DecodedSuperscalarPrograms from randomx_cache.
//   cache_base      absolute pointer (in linear memory) to the 256 MiB
//                   randomx cache, baked into the module as i32.const.
//   dataset_base    absolute pointer to the dataset memory, baked in.
//   mem_min_pages / mem_max_pages  shared-memory import limits.
//   items_per_trip  K independent items per loop trip (their cache misses
//                   overlap), clamped to 1..RXJIT_KERNEL_K_MAX; 1 = the one-
//                   item kernel. Falls back to 1 if K items might not fit.
//   cap             size of buf; the emitters write unchecked, so a
//                   conservative bound is checked first (~30-40 KiB per item
//                   typical).
//   buf             output buffer (caller-owned).
//
// Returns number of bytes written into buf, 0 if even K = 1 might not fit.
// The module imports "e.m" (shared memory) and exports "k" (the kernel
// function).
uint32_t rxjit_generate_superscalar_kernel(
    const randomx::DecodedSuperscalarProgram programs[/*RANDOMX_CACHE_ACCESSES*/],
    uint32_t cache_base, uint32_t dataset_base, uint32_t mem_min_pages, uint32_t mem_max_pages,
    int items_per_trip, uint32_t cap, uint8_t *buf);

// Light mode (wasm_jit_threaded.c): the function body (locals + code + end,
// no size prefix) of item(i32 item, i32 out) -> (), one initDatasetItem into
// out. 0 if it might not fit in cap bytes (~20-40 KiB typical).
uint32_t rxjit_emit_superscalar_item_fn(
    const randomx::DecodedSuperscalarProgram programs[/*RANDOMX_CACHE_ACCESSES*/],
    uint32_t cache_base, uint32_t cap, uint8_t *buf);

// Light mode, item pairing (light_mlp 2): the body of
// item_pair(i32 itemA, i32 itemB, i32 out) -> (), itemA into out and itemB
// into out + out_delta, computed as one 2-item block. 0 if it might not fit.
uint32_t rxjit_emit_superscalar_item_pair_fn(
    const randomx::DecodedSuperscalarProgram programs[/*RANDOMX_CACHE_ACCESSES*/],
    uint32_t cache_base, uint32_t out_delta, uint32_t cap, uint8_t *buf);

#ifdef __cplusplus
}
#endif
