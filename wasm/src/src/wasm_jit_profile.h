#pragma once

// Threaded-interpreter generator profiles: one set of module-gen parameters
// per target microarchitecture. The wasm build is arch-neutral; JS picks a
// profile by id (rxjit_set_profile) before the first threaded module is
// generated, and explicit knobs (rxjit_set_fuse_n, rxjit_set_triples_n,
// rxjit_set_unroll2, rxjit_set_shared_code) override single fields. The C-side
// default is arm.
//
//   fuse_n     fused pair kinds, the top-fuse_n prefix of wasm_jit_fuse_table.h
//              (RXJIT_FEATURE_NO_FUSE forces 0)
//   unroll2    2x dispatch replication, two br_table sites (X3): sets
//              RXJIT_FEATURE_UNROLL2 on the generated module (feature bit 128
//              also turns it on); about doubles the module
//   triples_n  fused triple kinds after the pairs, the top-triples_n prefix of
//              wasm_jit_fuse_table.h (RXJIT_FEATURE_NO_FUSE forces 0)
//   shared_code no per-thread pointer in the module bytes: the arena base comes
//              from an exported mutable global (set by the EM_JS bridge), so
//              every thread generates byte-identical modules and V8's native
//              module cache compiles the code once for all workers (SMT
//              siblings then share L1i / op-cache / BTB entries)
//   aes_simd   main-module AES (aes_hash.cpp): 1 = vpaes-style SIMD rounds on
//              i8x16.swizzle (soft_aes.h), 0 = the T-table soft AES. Not a
//              module-gen knob: rxjit_set_profile / rxjit_set_aes_simd update
//              g_rx_aes_simd directly.
//
// K + fuse_n + triples_n > 255 switches the records to u16 kinds
// (rxjit_kind16, wasm_jit_decode.h).

#define RXJIT_PROFILE_ARM   0 // Apple M-series tuning; the module is unchanged from v0.1.0
#define RXJIT_PROFILE_X86   1 // x86-64 (Zen 3) tuning
#define RXJIT_PROFILE_COUNT 2

typedef struct {
	int fuse_n;
	int unroll2;
	int triples_n;
	int shared_code;
	int aes_simd;
} rxjit_profile_t;

static const rxjit_profile_t rxjit_profiles[RXJIT_PROFILE_COUNT] = {
	{200, 0, 0, 0, 0}, // arm: RXJIT_FUSE_N_DEFAULT, u8 kinds, per-thread pointers baked
	// x86: 800 pairs (u16 kinds). Zen 3 sweep (amd64_notes.md): 12T 525 -> 570-599
	// H/s, 1T 82 -> 100; bigger tables / triples / unroll2 win at 1T and 6T but
	// not at 12T (SMT siblings share the op cache and L1i). shared_code: one
	// copy of the machine code for all threads. aes_simd: vpaes SIMD AES
	// instead of the T-tables (13% of the mining thread).
	{800, 0, 0, 1, 1},
};
