// Side module: hashAndFillAes1Rx4 (SIMD path) on i8x16.relaxed_swizzle.
// Built by wasm/build.sh with clang-19 (NOT emcc), embedded in randomx.wasm as
// bytes (rx_aes_relaxed_blob.h) and instantiated at runtime against the shared
// memory only when the x86 profile + a relaxed-SIMD feature ask for it
// (soft_aes.cpp rx_aes_relaxed_hf). randomx.wasm itself stays relaxed-free
// (JSC rejects relaxed SIMD).
//
// Port of soft_aes.h simd_aesenc/simd_aesdec + aes_hash.cpp
// hashAndFillAes1Rx4_impl<true,true>. Every swizzle index is in 0..15 or
// >= 0x80 (nibbles masked with 0x0f, constant permutations < 16, k_inv
// outputs 0..15 | 0x80 and their xors 0..15 | 0x80..0x8f), where x86 pshufb
// and ARM tbl agree, so all of them are relaxed.
//
// NO globals / static data: a data segment would be written into the SHARED
// memory at this module's addresses. All constants come from the host struct
// at kptr (rx_aes_relaxed_k: 17 x rx_aes_simd_k, then state0..3, key0..3,
// xkey0..1).
#include <stdint.h>
#include <wasm_simd128.h>

typedef struct {
	v128_t m0f, c1b, c63, ipt_lo, ipt_hi, dipt_lo, dipt_hi, inv, inva, sbo_u, sbo_t, dsbo_u, dsbo_t;
	v128_t zero, sr, isr, rot1;
} K_t;

#define SWZ wasm_i8x16_relaxed_swizzle

#define RX_VPAES_INV(z, K, io, jo) do { \
	v128_t k_ = wasm_v128_and((z), (K).m0f); \
	v128_t i_ = wasm_v128_and(wasm_u16x8_shr((z), 4), (K).m0f); \
	v128_t ak_ = SWZ((K).inva, k_); \
	v128_t j_ = wasm_v128_xor(i_, k_); \
	v128_t iak_ = wasm_v128_xor(SWZ((K).inv, i_), ak_); \
	v128_t jak_ = wasm_v128_xor(SWZ((K).inv, j_), ak_); \
	io = wasm_v128_xor(SWZ((K).inv, iak_), j_); \
	jo = wasm_v128_xor(SWZ((K).inv, jak_), i_); \
} while (0)

static inline __attribute__((always_inline)) v128_t xtime(v128_t t, const K_t* K) {
	v128_t m = wasm_i8x16_lt(t, K->zero);
	return wasm_v128_xor(wasm_i8x16_add(t, wasm_v128_xor(t, K->zero)), wasm_v128_and(m, K->c1b));
}

static inline __attribute__((always_inline)) v128_t mc(v128_t s, const K_t* K) {
	v128_t r1 = SWZ(s, K->rot1);
	v128_t t = wasm_v128_xor(s, r1);
	v128_t r2 = wasm_i8x16_shuffle(t, t, 2, 3, 0, 1, 6, 7, 4, 5, 10, 11, 8, 9, 14, 15, 12, 13);
	return wasm_v128_xor(wasm_v128_xor(xtime(t, K), r1), r2);
}

static inline __attribute__((always_inline)) v128_t enc(const K_t* K, v128_t in, v128_t key) {
	v128_t x = SWZ(in, K->sr);
	v128_t xl = wasm_v128_and(x, K->m0f);
	v128_t xh = wasm_v128_and(wasm_u16x8_shr(x, 4), K->m0f);
	v128_t z = wasm_v128_xor(SWZ(K->ipt_lo, xl), SWZ(K->ipt_hi, xh));
	v128_t io, jo;
	RX_VPAES_INV(z, *K, io, jo);
	v128_t s = wasm_v128_xor(SWZ(K->sbo_u, io), SWZ(K->sbo_t, jo));
	return wasm_v128_xor(mc(s, K), wasm_v128_xor(key, K->c63));
}

static inline __attribute__((always_inline)) v128_t dec(const K_t* K, v128_t in, v128_t key) {
	v128_t x = SWZ(in, K->isr);
	v128_t xl = wasm_v128_and(x, K->m0f);
	v128_t xh = wasm_v128_and(wasm_u16x8_shr(x, 4), K->m0f);
	v128_t z = wasm_v128_xor(SWZ(K->dipt_lo, xl), SWZ(K->dipt_hi, xh));
	v128_t io, jo;
	RX_VPAES_INV(z, *K, io, jo);
	v128_t s = wasm_v128_xor(SWZ(K->dsbo_u, io), SWZ(K->dsbo_t, jo));
	v128_t w = wasm_v128_xor(s, wasm_i8x16_shuffle(s, s, 2, 3, 0, 1, 6, 7, 4, 5, 10, 11, 8, 9, 14, 15, 12, 13));
	s = wasm_v128_xor(s, xtime(xtime(w, K), K));
	return wasm_v128_xor(mc(s, K), key);
}

#define LD(p, i) wasm_v128_load((const v128_t*)(p) + (i))
#define ST(p, i, v) wasm_v128_store((v128_t*)(p) + (i), (v))

__attribute__((export_name("hf")))
void hf(uint32_t scratchpad, uint32_t size, uint32_t hash, uint32_t fill_state, uint32_t kptr) {
	const uint8_t* kp = (const uint8_t*)(uintptr_t)kptr;
	K_t K;
	K.m0f = LD(kp, 0); K.c1b = LD(kp, 1); K.c63 = LD(kp, 2);
	K.ipt_lo = LD(kp, 3); K.ipt_hi = LD(kp, 4); K.dipt_lo = LD(kp, 5); K.dipt_hi = LD(kp, 6);
	K.inv = LD(kp, 7); K.inva = LD(kp, 8); K.sbo_u = LD(kp, 9); K.sbo_t = LD(kp, 10);
	K.dsbo_u = LD(kp, 11); K.dsbo_t = LD(kp, 12);
	K.zero = LD(kp, 13); K.sr = LD(kp, 14); K.isr = LD(kp, 15); K.rot1 = LD(kp, 16);

	uint8_t* scratchpadPtr = (uint8_t*)(uintptr_t)scratchpad;
	uint8_t* scratchpadEnd = scratchpadPtr + size;
	void* fs = (void*)(uintptr_t)fill_state;
	void* hp = (void*)(uintptr_t)hash;

	v128_t hash_state0 = LD(kp, 17);
	v128_t hash_state1 = LD(kp, 18);
	v128_t hash_state2 = LD(kp, 19);
	v128_t hash_state3 = LD(kp, 20);

	const v128_t key0 = LD(kp, 21);
	const v128_t key1 = LD(kp, 22);
	const v128_t key2 = LD(kp, 23);
	const v128_t key3 = LD(kp, 24);

	v128_t fill_state0 = LD(fs, 0);
	v128_t fill_state1 = LD(fs, 1);
	v128_t fill_state2 = LD(fs, 2);
	v128_t fill_state3 = LD(fs, 3);

	scratchpadEnd -= 4096;

	for (int i = 0; i < 2; ++i) {
		while (scratchpadPtr < scratchpadEnd) {
			hash_state0 = enc(&K, hash_state0, LD(scratchpadPtr, 0));
			hash_state1 = dec(&K, hash_state1, LD(scratchpadPtr, 1));
			hash_state2 = enc(&K, hash_state2, LD(scratchpadPtr, 2));
			hash_state3 = dec(&K, hash_state3, LD(scratchpadPtr, 3));

			fill_state0 = dec(&K, fill_state0, key0);
			fill_state1 = enc(&K, fill_state1, key1);
			fill_state2 = dec(&K, fill_state2, key2);
			fill_state3 = enc(&K, fill_state3, key3);

			ST(scratchpadPtr, 0, fill_state0);
			ST(scratchpadPtr, 1, fill_state1);
			ST(scratchpadPtr, 2, fill_state2);
			ST(scratchpadPtr, 3, fill_state3);

			scratchpadPtr += 64;
		}
		scratchpadEnd += 4096;
	}

	ST(fs, 0, fill_state0);
	ST(fs, 1, fill_state1);
	ST(fs, 2, fill_state2);
	ST(fs, 3, fill_state3);

	const v128_t xkey0 = LD(kp, 25);
	const v128_t xkey1 = LD(kp, 26);

	hash_state0 = enc(&K, hash_state0, xkey0);
	hash_state1 = dec(&K, hash_state1, xkey0);
	hash_state2 = enc(&K, hash_state2, xkey0);
	hash_state3 = dec(&K, hash_state3, xkey0);

	hash_state0 = enc(&K, hash_state0, xkey1);
	hash_state1 = dec(&K, hash_state1, xkey1);
	hash_state2 = enc(&K, hash_state2, xkey1);
	hash_state3 = dec(&K, hash_state3, xkey1);

	ST(hp, 0, hash_state0);
	ST(hp, 1, hash_state1);
	ST(hp, 2, hash_state2);
	ST(hp, 3, hash_state3);
}
