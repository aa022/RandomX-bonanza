#pragma once

// Threaded-interpreter generator profiles: one set of module-gen parameters
// per target microarchitecture. The wasm build is arch-neutral; JS picks a
// profile by id (rxjit_set_profile) before the first threaded module is
// generated, and explicit knobs (rxjit_set_fuse_n, rxjit_set_triples_n,
// rxjit_set_unroll2) override single fields. The C-side default is arm.
//
//   fuse_n     fused pair kinds, the top-fuse_n prefix of wasm_jit_fuse_table.h
//              (RXJIT_FEATURE_NO_FUSE forces 0)
//   unroll2    2x dispatch replication, two br_table sites (X3): sets
//              RXJIT_FEATURE_UNROLL2 on the generated module (feature bit 128
//              also turns it on); about doubles the module
//   triples_n  fused triple kinds after the pairs, the top-triples_n prefix of
//              wasm_jit_fuse_table.h (RXJIT_FEATURE_NO_FUSE forces 0)
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
} rxjit_profile_t;

static const rxjit_profile_t rxjit_profiles[RXJIT_PROFILE_COUNT] = {
	{200, 0, 0}, // arm: RXJIT_FUSE_N_DEFAULT, u8 kinds
	{200, 0, 0}, // x86: = arm until the fuse-n sweep picks its values
};
