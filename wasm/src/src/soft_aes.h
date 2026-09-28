/*
Copyright (c) 2018-2019, tevador <tevador@gmail.com>

All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
	* Redistributions of source code must retain the above copyright
	  notice, this list of conditions and the following disclaimer.
	* Redistributions in binary form must reproduce the above copyright
	  notice, this list of conditions and the following disclaimer in the
	  documentation and/or other materials provided with the distribution.
	* Neither the name of the copyright holder nor the
	  names of its contributors may be used to endorse or promote products
	  derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

#pragma once

#include <stdint.h>
#include "intrin_portable.h"

extern "C" const uint32_t randomx_aes_lut_enc[4][256];
extern "C" const uint32_t randomx_aes_lut_dec[4][256];

extern "C" const uint8_t randomx_aes_lut_enc_index[4][32];
extern "C" const uint8_t randomx_aes_lut_dec_index[4][32];

rx_vec_i128 soft_aesenc(rx_vec_i128 in, rx_vec_i128 key);

rx_vec_i128 soft_aesdec(rx_vec_i128 in, rx_vec_i128 key);

template<bool soft>
inline rx_vec_i128 aesenc(rx_vec_i128 in, rx_vec_i128 key) {
	return soft ? soft_aesenc(in, key) : rx_aesenc_vec_i128(in, key);
}

template<bool soft>
inline rx_vec_i128 aesdec(rx_vec_i128 in, rx_vec_i128 key) {
	return soft ? soft_aesdec(in, key) : rx_aesdec_vec_i128(in, key);
}


// SIMD AES (x86 profile, rxjit_set_aes_simd): vector-permutation AES ("vpaes",
// Hamburg's GF(2^4) tower-field inversion) on standard wasm i8x16.swizzle, one
// full round with exact AES-NI semantics, bit-exact with soft_aesenc/dec
// (rx_aes_selftest). State stays in the standard basis between rounds: per
// round ShiftRows (1 shuffle), input basis change (2 swizzles), inversion (6),
// output tables (2), MixColumns in the standard basis (xtime + 2 shuffles).
// Tables derived/verified exhaustively from OpenSSL vpaes-x86_64.pl .Lk_inv /
// .Lk_ipt (.Lk_sbo = our enc output); the dec input/output tables are ours.
// The constants are loaded once per aes_hash call through a volatile pointer
// (rx_aes_simd_load) so they live in locals/registers instead of being
// re-materialised as v128.const inside the loops.
// NO relaxed SIMD here: randomx.wasm must stay valid in JSC.
extern "C" int g_rx_aes_simd; // 0 = T-table, 1 = SIMD; set from the profile (wasm_jit_run.cpp)

#if defined(__wasm_simd128__)
struct rx_aes_simd_k {
	v128_t m0f, c1b, c63, ipt_lo, ipt_hi, dipt_lo, dipt_hi, inv, inva, sbo_u, sbo_t, dsbo_u, dsbo_t;
	v128_t zero, sr, isr, rot1; // opaque: see rx_vpaes_xtime / the shuffles
};

// V8 x64 lowers (a) a generic constant i8x16.shuffle to a 4-instruction
// constant materialisation + pshufb and (b) i8x16.shl / i8x16.shr_s to 5-6
// instruction emulations, which LLVM produces from add(t, t) and
// lt_s(t, 0) & c. So the byte permutations are swizzles with indices from K
// (paddusb + pshufb), and xtime compares against an opaque zero and adds t to
// a copy of itself xor'ed with that opaque zero (pxor + paddb; LLVM cannot
// lower v128 inline asm, so no free barrier).
extern "C" const rx_aes_simd_k rx_aes_simd_tab;

static inline rx_aes_simd_k rx_aes_simd_load() {
	const rx_aes_simd_k* volatile p = &rx_aes_simd_tab;
	const rx_aes_simd_k* q = p;
	return *q;
}

// tower-field inversion of z (already in the vpaes basis) -> (io, jo) nibbles
// (0x80.. = "infinity", swizzle gives 0 like pshufb)
#define RX_VPAES_INV(z, K, io, jo) do { \
	v128_t k_ = wasm_v128_and((z), (K).m0f); \
	v128_t i_ = wasm_v128_and(wasm_u16x8_shr((z), 4), (K).m0f); \
	v128_t ak_ = wasm_i8x16_swizzle((K).inva, k_); \
	v128_t j_ = wasm_v128_xor(i_, k_); \
	v128_t iak_ = wasm_v128_xor(wasm_i8x16_swizzle((K).inv, i_), ak_); \
	v128_t jak_ = wasm_v128_xor(wasm_i8x16_swizzle((K).inv, j_), ak_); \
	io = wasm_v128_xor(wasm_i8x16_swizzle((K).inv, iak_), j_); \
	jo = wasm_v128_xor(wasm_i8x16_swizzle((K).inv, jak_), i_); \
} while (0)

static inline __attribute__((always_inline)) v128_t rx_vpaes_xtime(v128_t t, const rx_aes_simd_k& K) {
	v128_t m = wasm_i8x16_lt(t, K.zero);
	return wasm_v128_xor(wasm_i8x16_add(t, wasm_v128_xor(t, K.zero)), wasm_v128_and(m, K.c1b));
}

// MixColumns in the standard basis: out_r = 2a_r ^ 3a_{r+1} ^ a_{r+2} ^ a_{r+3}
static inline __attribute__((always_inline)) v128_t rx_vpaes_mc(v128_t s, const rx_aes_simd_k& K) {
	v128_t r1 = wasm_i8x16_swizzle(s, K.rot1); // 1 2 3 0 per column
	v128_t t = wasm_v128_xor(s, r1);
	v128_t r2 = wasm_i8x16_shuffle(t, t, 2, 3, 0, 1, 6, 7, 4, 5, 10, 11, 8, 9, 14, 15, 12, 13);
	return wasm_v128_xor(wasm_v128_xor(rx_vpaes_xtime(t, K), r1), r2);
}

static inline __attribute__((always_inline)) rx_vec_i128 simd_aesenc(const rx_aes_simd_k& K, rx_vec_i128 in, rx_vec_i128 key) {
	v128_t x = wasm_i8x16_swizzle(in, K.sr); // ShiftRows
	v128_t xl = wasm_v128_and(x, K.m0f);
	v128_t xh = wasm_v128_and(wasm_u16x8_shr(x, 4), K.m0f);
	v128_t z = wasm_v128_xor(wasm_i8x16_swizzle(K.ipt_lo, xl), wasm_i8x16_swizzle(K.ipt_hi, xh));
	v128_t io, jo;
	RX_VPAES_INV(z, K, io, jo);
	v128_t s = wasm_v128_xor(wasm_i8x16_swizzle(K.sbo_u, io), wasm_i8x16_swizzle(K.sbo_t, jo)); // SubBytes ^ 0x63
	// MC(0x63 splat) = 0x63 splat, so the affine constant goes in with the key
	return wasm_v128_xor(rx_vpaes_mc(s, K), wasm_v128_xor(key, K.c63));
}

static inline __attribute__((always_inline)) rx_vec_i128 simd_aesdec(const rx_aes_simd_k& K, rx_vec_i128 in, rx_vec_i128 key) {
	v128_t x = wasm_i8x16_swizzle(in, K.isr); // InvShiftRows
	v128_t xl = wasm_v128_and(x, K.m0f);
	v128_t xh = wasm_v128_and(wasm_u16x8_shr(x, 4), K.m0f);
	// dipt = ipt o A^-1, with the 0x63 folded into the lo table
	v128_t z = wasm_v128_xor(wasm_i8x16_swizzle(K.dipt_lo, xl), wasm_i8x16_swizzle(K.dipt_hi, xh));
	v128_t io, jo;
	RX_VPAES_INV(z, K, io, jo);
	v128_t s = wasm_v128_xor(wasm_i8x16_swizzle(K.dsbo_u, io), wasm_i8x16_swizzle(K.dsbo_t, jo)); // InvSubBytes
	// InvMixColumns = MixColumns after a0^=u, a2^=u, a1^=v, a3^=v with
	// u = 4(a0^a2), v = 4(a1^a3)
	v128_t w = wasm_v128_xor(s, wasm_i8x16_shuffle(s, s, 2, 3, 0, 1, 6, 7, 4, 5, 10, 11, 8, 9, 14, 15, 12, 13));
	s = wasm_v128_xor(s, rx_vpaes_xtime(rx_vpaes_xtime(w, K), K));
	return wasm_v128_xor(rx_vpaes_mc(s, K), key);
}
#else
struct rx_aes_simd_k { int unused; };
static inline rx_aes_simd_k rx_aes_simd_load() { return rx_aes_simd_k{0}; }
static inline rx_vec_i128 simd_aesenc(const rx_aes_simd_k&, rx_vec_i128 in, rx_vec_i128 key) { return soft_aesenc(in, key); }
static inline rx_vec_i128 simd_aesdec(const rx_aes_simd_k&, rx_vec_i128 in, rx_vec_i128 key) { return soft_aesdec(in, key); }
#endif

// Loop-invariant round keys for the SIMD path: xor with the opaque zero so the
// key is a register value computed once, not a v128.const that V8
// re-materialises (movq + vmovq + movq + vpinsrq) at every use in the loop.
template<bool simd>
inline rx_vec_i128 rx_aes_key(const rx_aes_simd_k& K, rx_vec_i128 key) {
#if defined(__wasm_simd128__)
	return simd ? wasm_v128_xor(key, K.zero) : key;
#else
	(void)K;
	return key;
#endif
}

// aes_hash.cpp variant: simd = the SIMD round (only meaningful with soft)
template<bool soft, bool simd>
inline rx_vec_i128 aesenc(const rx_aes_simd_k& K, rx_vec_i128 in, rx_vec_i128 key) {
	return simd ? simd_aesenc(K, in, key) : soft ? soft_aesenc(in, key) : rx_aesenc_vec_i128(in, key);
}

template<bool soft, bool simd>
inline rx_vec_i128 aesdec(const rx_aes_simd_k& K, rx_vec_i128 in, rx_vec_i128 key) {
	return simd ? simd_aesdec(K, in, key) : soft ? soft_aesdec(in, key) : rx_aesdec_vec_i128(in, key);
}
