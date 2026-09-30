// Ported from randomx.js (src/jit/jit_vm.c) with two notable changes:
//   1. The SuperscalarHash function import is removed; the dataset read in
//      step 7 of the VM main loop is replaced with an inline scan of 8 i64s
//      from absolute (dataset + dataset_offset + ma) — this works because
//      we always run in FULL_MEM mode where the dataset is precomputed.
//   2. The memory import declares shared+max limits (RXJIT_MEM_FLAG) so it can be linked
//      against the Emscripten pthreads SharedArrayBuffer-backed memory.
//
// Architecture: split into a STATIC module (compiled once per pthread,
// holds the 22 SIMD semifloat + mulh stubs + funcref tables + fprc
// global) and a DYNAMIC module (compiled per program, holds only the
// 2048-iteration main function + program-specific instruction emissions).
// We tried fully hoisting prologue / epilogue / per-step helpers into
// the static module behind imported mutable globals — it builds and is
// correct, but globals-vs-locals costs ~20% runtime on Node V8 11.3 and
// doesn't actually shrink the dynamic module (the imports table grew to
// cover all the globals). Reverted; the simpler design below stays.
#include "wasm_jit_gen.h"
#include "wasm_jit_inst.h"
#include "wasm_jit_inst_locals.h"
#include "wasm_jit_macros.h"
#include "wasm_jit_decode.h"
#include "configuration.h"

// Pull in the stub byte arrays. mulh internally calls mul128hi at function
// index 1 in our combined module (we set FUNC_OFFSET=1 before the include
// so the "call 0" in imul128hi becomes "call 1" via the `_()` macro).
#define FUNC_OFFSET FN_MUL128HI
#include "jit_stubs/mulh.h"

// semifloat stubs don't call any other functions in practice (helpers are
// fully inlined), but if they ever do, FUNC_OFFSET=3 gives them the right
// absolute index in our combined module.
#define FUNC_OFFSET 3
#include "jit_stubs/semifloat.h"

// Scratchpad sub-region sizes in i64 units (the JIT addresses scratchpad
// as i64s). The "/8 - 1) * 64" shape on SCRATCHPAD_L3_MASK_64 is a
// 64-byte-aligned mask: keep low bits 6..N, clear the low 6 — this is how
// step-1 of the VM main loop forces sp_addr0/sp_addr1 onto cache-line
// boundaries before the 8×i64 register-XOR.
#define SCRATCHPAD_L3         (RANDOMX_SCRATCHPAD_L3 / 8)
#define SCRATCHPAD_L3_MASK_64 ((SCRATCHPAD_L3 / 8 - 1) * 64)
#define DATASET_ITEM_SIZE     64
// `(BASE - 1) & ~(64 - 1)` = "any byte in the base region, snapped down to
// the nearest 64-byte cache line". Used in step-5 to constrain `mx`.
#define CACHE_LINE_MASK       ((RANDOMX_DATASET_BASE_SIZE - 1) & ~(DATASET_ITEM_SIZE - 1))

// ---------------- Reciprocal (matches randomx_reciprocal) ----------------

// Precondition: divisor != 0 AND divisor is NOT a power of two. The decoder
// folds those cases to NOP before they reach here; `__builtin_clzll(0)` is
// UB so this MUST stay precondition-guarded.
uint64_t rxjit_reciprocal(uint32_t divisor) {
	const uint64_t p2exp63 = 1ULL << 63;
	const uint64_t q = p2exp63 / divisor;
	const uint64_t r = p2exp63 % divisor;
	const uint32_t shift = 64 - __builtin_clzll(divisor);
	return (q << shift) + ((r << shift) / divisor);
}

// ---------------- Prologue / epilogue helpers ----------------

// emit: i32.const <ptr>; local.set $tmp
static uint32_t ptr_to_tmp(void *ptr, uint8_t *buf) {
	THUNK_BEGIN;
	WASM_U8(0x41);
	WASM_I64((int64_t)(intptr_t)ptr);
	WASM_U8_THUNK({0x21, LOC_tmp});
	THUNK_END;
}

// emit: i32.const <ptr>; local.get $reg; i32.add; local.set $tmp
static uint32_t ptr_to_tmp_with_reg_offset(void *ptr, int reg, uint8_t *buf) {
	THUNK_BEGIN;
	WASM_U8(0x41);
	WASM_I64((int64_t)(intptr_t)ptr);
	WASM_U8_THUNK({0x20, reg, 0x6a, 0x21, LOC_tmp});
	THUNK_END;
}

// local.get $tmp; v128.load align=4 offset=$offset; local.set $reg
#define V128_LOAD(offset, reg)                 \
	WASM_U8_THUNK({0x20, LOC_tmp, 0xfd, 0x00, 4}); \
	WASM_U32(offset);                          \
	WASM_U8_THUNK({0x21, reg})

// local.get $tmp; i64.load align=3 offset=$offset; local.set $reg
#define I64_LOAD(offset, reg)             \
	WASM_U8_THUNK({0x20, LOC_tmp, 0x29, 3}); \
	WASM_U32(offset);                     \
	WASM_U8_THUNK({0x21, reg})

// local.get $tmp; i32.load align=2 offset=$offset; local.tee $reg0; local.set $reg1
#define I32_LOAD2(offset, reg0, reg1)     \
	WASM_U8_THUNK({0x20, LOC_tmp, 0x28, 2}); \
	WASM_U32(offset);                     \
	WASM_U8_THUNK({0x22, reg0, 0x21, reg1})

// local.get $tmp; i32.load align=2 offset=$offset; global.set $global
#define I32_LOAD_GLOBAL(offset, global)   \
	WASM_U8_THUNK({0x20, LOC_tmp, 0x28, 2}); \
	WASM_U32(offset);                     \
	WASM_U8_THUNK({0x24, global})

// local.get $tmp; global.get $global; i32.store align=2 offset=$offset
#define I32_STORE_GLOBAL(offset, global)              \
	WASM_U8_THUNK({0x20, LOC_tmp, 0x23, global, 0x36, 2}); \
	WASM_U32(offset)

// local.get $tmp; local.get $reg; v128.store align=4 offset=$offset
#define V128_STORE(offset, reg)                         \
	WASM_U8_THUNK({0x20, LOC_tmp, 0x20, reg, 0xfd, 0x0b, 4}); \
	WASM_U32(offset)

// local.get $tmp; local.get $reg; i64.store align=3 offset=$offset
#define I64_STORE(offset, reg)                     \
	WASM_U8_THUNK({0x20, LOC_tmp, 0x20, reg, 0x37, 3}); \
	WASM_U32(offset)

// local.get $tmp; i64.load align=3 offset=$offset; local.get $reg; i64.xor; local.set $reg
#define I64_LOAD_XOR_STORE(offset, reg)   \
	WASM_U8_THUNK({0x20, LOC_tmp, 0x29, 3}); \
	WASM_U32(offset);                     \
	WASM_U8_THUNK({0x20, reg, 0x85, 0x21, reg})

// local.get $tmp; v128.load64_zero align=3 offset=$offset; f64x2.convert_low_i32x4_s; local.set $reg
#define V128_LOAD_F(offset, reg)               \
	WASM_U8_THUNK({0x20, LOC_tmp, 0xfd, 0x5d, 3}); \
	WASM_U32(offset);                          \
	WASM_U8_THUNK({0xfd, 0xfe, 0x01, 0x21, reg})

// Same as V128_LOAD_F, but also AND mask_mant and OR mask_exp.
#define V128_LOAD_E(offset, reg)               \
	WASM_U8_THUNK({0x20, LOC_tmp, 0xfd, 0x5d, 3}); \
	WASM_U32(offset);                          \
	WASM_U8_THUNK({0xfd, 0xfe, 0x01, 0x20, LOC_mask_mant, 0xfd, 0x4e, 0x20, LOC_mask_exp, 0xfd, 0x50, 0x21, reg})

// [mode][K1, K2, D1, D3, Kon] — see the PJIT2 rounding fixup in wasm_jit_inst.c.
#define M1 UINT64_MAX
_Alignas(16) uint64_t rxjit_mode_tbl[4][5][2] = {
	{{0, 0}, {0, 0}, {0, 0}, {1, 1}, {0, 0}},             // nearest: never adjust
	{{0, 0}, {0, 0}, {M1, M1}, {1, 1}, {M1, M1}},         // down
	{{M1, M1}, {0, 0}, {0, 0}, {1, 1}, {M1, M1}},         // up
	{{0, 0}, {M1, M1}, {0, 0}, {M1, M1}, {M1, M1}},       // toward zero
};
#undef M1

// fprc (on stack, i32) → local.tee $fprc; *80 + &rxjit_mode_tbl → local.set $modeptr
uint32_t rxjit_emit_set_mode(uint8_t *buf) {
	THUNK_BEGIN;
	WASM_U8_THUNK({0x22, LOC_fprc, 0x41});
	WASM_I64(80); // sleb128: 80 needs two bytes
	WASM_U8_THUNK({0x6c, 0x41});
	WASM_I64((int64_t)(intptr_t)rxjit_mode_tbl);
	WASM_U8_THUNK({0x6a, 0x21, LOC_modeptr});
	THUNK_END;
}

static uint32_t prologue_load_registers(rxjit_vm_state_t *vm, uint8_t *buf) {
	THUNK_BEGIN;
	p += ptr_to_tmp(vm, p);

	I64_LOAD(0, R(0));
	I64_LOAD(8, R(1));
	I64_LOAD(16, R(2));
	I64_LOAD(24, R(3));
	I64_LOAD(32, R(4));
	I64_LOAD(40, R(5));
	I64_LOAD(48, R(6));
	I64_LOAD(56, R(7));
	V128_LOAD(64, F(0));
	V128_LOAD(80, F(1));
	V128_LOAD(96, F(2));
	V128_LOAD(112, F(3));
	V128_LOAD(128, E(0));
	V128_LOAD(144, E(1));
	V128_LOAD(160, E(2));
	V128_LOAD(176, E(3));
	V128_LOAD(192, A(0));
	V128_LOAD(208, A(1));
	V128_LOAD(224, A(2));
	V128_LOAD(240, A(3));
	V128_LOAD(256, LOC_mask_exp);  // emask
	V128_LOAD(272, LOC_mask_mant); // DYNAMIC_MANTISSA_MASK x2
	I32_LOAD_GLOBAL(288, GLOB_fprc);
	WASM_U8_THUNK({0x20, LOC_tmp, 0x28, 2});
	WASM_U32(288);
	p += rxjit_emit_set_mode(p);
	I32_LOAD2(292, LOC_ma, LOC_sp_addr1);
	I32_LOAD2(296, LOC_mx, LOC_sp_addr0);

	THUNK_END;
}

static uint32_t epilogue_store_registers(rxjit_vm_state_t *vm, int jit_feature, uint8_t *buf) {
	THUNK_BEGIN;
	p += ptr_to_tmp(vm, p);

	I64_STORE(0, R(0));
	I64_STORE(8, R(1));
	I64_STORE(16, R(2));
	I64_STORE(24, R(3));
	I64_STORE(32, R(4));
	I64_STORE(40, R(5));
	I64_STORE(48, R(6));
	I64_STORE(56, R(7));
	V128_STORE(64, F(0));
	V128_STORE(80, F(1));
	V128_STORE(96, F(2));
	V128_STORE(112, F(3));
	V128_STORE(128, E(0));
	V128_STORE(144, E(1));
	V128_STORE(160, E(2));
	V128_STORE(176, E(3));
	if (jit_feature & RXJIT_FEATURE_PJIT2) {
		WASM_U8_THUNK({0x20, LOC_tmp, 0x20, LOC_fprc, 0x36, 2});
		WASM_U32(288);
	} else {
		I32_STORE_GLOBAL(288, GLOB_fprc);
	}

	THUNK_END;
}

// ---------------- Main function body (one full program) ----------------

static uint32_t jit_main_body(rxjit_vm_state_t *vm, rxjit_inst_t program[256],
                              rxjit_jump_desc_t jump_desc[256], uint8_t *scratchpad,
                              uint8_t *dataset, int jit_feature, int read_reg0, int read_reg1,
                              int read_reg2, int read_reg3, uint8_t *buf) {
	THUNK_BEGIN;

	p += prologue_load_registers(vm, p);

	// $ic = RANDOMX_PROGRAM_ITERATIONS; enter outer loop
	WASM_U8(0x41);
	WASM_I64(RANDOMX_PROGRAM_ITERATIONS);
	WASM_U8_THUNK({0x21, LOC_ic, 0x03, 0x40});

	// ---- step 1: sp_mix = r[reg0] ^ r[reg1]; mix into sp_addr0/1 ----
	WASM_U8_THUNK({
		0x20, R(read_reg0),
		0x20, R(read_reg1),
		0x85,
		0x21, LOC_tmp64,
	});
	WASM_U8_THUNK({
		0x20, LOC_tmp64, 0xa7,
		0x20, LOC_sp_addr0, 0x73,
		0x41,
	});
	WASM_I64(SCRATCHPAD_L3_MASK_64);
	WASM_U8_THUNK({0x71, 0x21, LOC_sp_addr0});

	WASM_U8_THUNK({
		0x20, LOC_tmp64,
		0x42, 32, 0x88, 0xa7,
		0x20, LOC_sp_addr1, 0x73,
		0x41,
	});
	WASM_I64(SCRATCHPAD_L3_MASK_64);
	WASM_U8_THUNK({0x71, 0x21, LOC_sp_addr1});

	// ---- step 2: r[i] ^= scratchpad[sp_addr0 + i*8] ----
	p += ptr_to_tmp_with_reg_offset(scratchpad, LOC_sp_addr0, p);
	I64_LOAD_XOR_STORE(0, R(0));
	I64_LOAD_XOR_STORE(8, R(1));
	I64_LOAD_XOR_STORE(16, R(2));
	I64_LOAD_XOR_STORE(24, R(3));
	I64_LOAD_XOR_STORE(32, R(4));
	I64_LOAD_XOR_STORE(40, R(5));
	I64_LOAD_XOR_STORE(48, R(6));
	I64_LOAD_XOR_STORE(56, R(7));

	// ---- step 3: load f0..f3, e0..e3 from scratchpad[sp_addr1] ----
	p += ptr_to_tmp_with_reg_offset(scratchpad, LOC_sp_addr1, p);
	V128_LOAD_F(0, F(0));
	V128_LOAD_F(8, F(1));
	V128_LOAD_F(16, F(2));
	V128_LOAD_F(24, F(3));
	V128_LOAD_E(32, E(0));
	V128_LOAD_E(40, E(1));
	V128_LOAD_E(48, E(2));
	V128_LOAD_E(56, E(3));

	// ---- step 4: emit all 256 instructions ----
	for (int pc = 0; pc < 256; pc++) {
		p += rxjit_emit_instruction(&program[pc], &jump_desc[pc], scratchpad, jit_feature, p);
	}

	// ---- step 5: mx ^= r[reg2] ^ r[reg3]; mx &= CACHE_LINE_MASK ----
	WASM_U8_THUNK({
		0x20, R(read_reg2),
		0x20, R(read_reg3),
		0x85, 0xa7,
		0x20, LOC_mx, 0x73,
		0x41,
	});
	WASM_I64(CACHE_LINE_MASK);
	WASM_U8_THUNK({0x71, 0x21, LOC_mx});

	// ---- step 6: prefetch (skipped — WASM has no prefetch) ----

	// ---- step 7: read dataset[dataset_offset + ma], XOR with r[0..7] ----
	p += ptr_to_tmp_with_reg_offset(dataset, LOC_ma, p);
	I64_LOAD_XOR_STORE(0, R(0));
	I64_LOAD_XOR_STORE(8, R(1));
	I64_LOAD_XOR_STORE(16, R(2));
	I64_LOAD_XOR_STORE(24, R(3));
	I64_LOAD_XOR_STORE(32, R(4));
	I64_LOAD_XOR_STORE(40, R(5));
	I64_LOAD_XOR_STORE(48, R(6));
	I64_LOAD_XOR_STORE(56, R(7));

	// ---- step 8: swap mx, ma ----
	WASM_U8_THUNK({
		0x20, LOC_mx,
		0x20, LOC_ma,
		0x21, LOC_mx,
		0x21, LOC_ma,
	});

	// ---- step 9: write r[0..7] to scratchpad[sp_addr1] ----
	p += ptr_to_tmp_with_reg_offset(scratchpad, LOC_sp_addr1, p);
	I64_STORE(0, R(0));
	I64_STORE(8, R(1));
	I64_STORE(16, R(2));
	I64_STORE(24, R(3));
	I64_STORE(32, R(4));
	I64_STORE(40, R(5));
	I64_STORE(48, R(6));
	I64_STORE(56, R(7));

	// ---- step 10: f[i] ^= e[i] ----
	WASM_U8_THUNK({
		0x20, F(0), 0x20, E(0), 0xfd, 0x51, 0x21, F(0),
		0x20, F(1), 0x20, E(1), 0xfd, 0x51, 0x21, F(1),
		0x20, F(2), 0x20, E(2), 0xfd, 0x51, 0x21, F(2),
		0x20, F(3), 0x20, E(3), 0xfd, 0x51, 0x21, F(3),
	});

	// ---- step 11: write f[0..3] to scratchpad[sp_addr0] ----
	p += ptr_to_tmp_with_reg_offset(scratchpad, LOC_sp_addr0, p);
	V128_STORE(0, F(0));
	V128_STORE(16, F(1));
	V128_STORE(32, F(2));
	V128_STORE(48, F(3));

	// ---- step 12: sp_addr0 = sp_addr1 = 0 ----
	WASM_U8_THUNK({
		0x41, 0, 0x21, LOC_sp_addr0,
		0x41, 0, 0x21, LOC_sp_addr1,
	});

	// ---- step 13: decrement ic and loop ----
	WASM_U8_THUNK({
		0x20, LOC_ic,
		0x41, 1,
		0x6b,
		0x22, LOC_ic,
		0x0d, 0,
		0x0b,
	});

	p += epilogue_store_registers(vm, jit_feature, p);

	THUNK_END;
}

// ---------------- Helpers for picking the right stub set ----------------

#define EMIT_STUB(stub) WASM_U32_WITH_STUB(stub)

static uint32_t emit_function_bodies(int jit_feature, uint8_t *buf) {
	THUNK_BEGIN;

	// function 1: mul128hi
	EMIT_STUB(STUB_MUL128HI);
	// function 2: imul128hi
	EMIT_STUB(STUB_IMUL128HI);

	// fadd_0..3
	EMIT_STUB(STUB_FADD_0);
	EMIT_STUB(STUB_FADD_1);
	EMIT_STUB(STUB_FADD_2);
	EMIT_STUB(STUB_FADD_3);

	// fsub_0..3
	EMIT_STUB(STUB_FSUB_0);
	EMIT_STUB(STUB_FSUB_1);
	EMIT_STUB(STUB_FSUB_2);
	EMIT_STUB(STUB_FSUB_3);

	// fmul_0, fmul_1..3 (or fmul_fma_1..3)
	EMIT_STUB(STUB_FMUL_0);
	if (jit_feature & RXJIT_FEATURE_FMA) {
		EMIT_STUB(STUB_FMUL_FMA_1);
		EMIT_STUB(STUB_FMUL_FMA_2);
		EMIT_STUB(STUB_FMUL_FMA_3);
	} else {
		EMIT_STUB(STUB_FMUL_1);
		EMIT_STUB(STUB_FMUL_2);
		EMIT_STUB(STUB_FMUL_3);
	}

	// fdiv_0, fdiv_1..3 (or fdiv_fma_1..3)
	EMIT_STUB(STUB_FDIV_0);
	if (jit_feature & RXJIT_FEATURE_FMA) {
		EMIT_STUB(STUB_FDIV_FMA_1);
		EMIT_STUB(STUB_FDIV_FMA_2);
		EMIT_STUB(STUB_FDIV_FMA_3);
	} else {
		EMIT_STUB(STUB_FDIV_1);
		EMIT_STUB(STUB_FDIV_2);
		EMIT_STUB(STUB_FDIV_3);
	}

	// fsqrt_0, fsqrt_1..3 (or fsqrt_fma_1..3)
	EMIT_STUB(STUB_FSQRT_0);
	if (jit_feature & RXJIT_FEATURE_FMA) {
		EMIT_STUB(STUB_FSQRT_FMA_1);
		EMIT_STUB(STUB_FSQRT_FMA_2);
		EMIT_STUB(STUB_FSQRT_FMA_3);
	} else {
		EMIT_STUB(STUB_FSQRT_1);
		EMIT_STUB(STUB_FSQRT_2);
		EMIT_STUB(STUB_FSQRT_3);
	}

	THUNK_END;
}

// ---------------- Common type section helpers ----------------
//
// Type indices used across both modules:
//   0: ()->()                          (main)
//   1: (i64,i64)->i64                  (mulh, imulh)
//   2: (v128,v128)->v128               (fadd/sub/mul/div)
//   3: (v128)->v128                    (fsqrt)

#define EMIT_TYPE_SECTION()               \
	WASM_SECTION(WASM_SECTION_TYPE, {     \
		WASM_U8_THUNK({                                              \
			4,                                                       \
			0x60, 0, 0,                                              \
			0x60, 2, WASM_TYPE_I64, WASM_TYPE_I64, 1, WASM_TYPE_I64, \
			0x60, 2, WASM_TYPE_V128, WASM_TYPE_V128, 1, WASM_TYPE_V128, \
			0x60, 1, WASM_TYPE_V128, 1, WASM_TYPE_V128,              \
		}); \
	})

// The WASM_SECTION(...) macro expansion confuses clang-format-19 into
// runaway indentation. Wrap both module-builders in clang-format off / on
// so the original section-block layout survives a format pass.
// clang-format off

// ---------------- STATIC module generator ----------------

uint32_t rxjit_generate_static_module(
	uint32_t mem_min_pages,
	uint32_t mem_max_pages,
	int jit_feature,
	uint8_t *buf)
{
	THUNK_BEGIN;

	WASM_MAGIC();
	EMIT_TYPE_SECTION();

	// import section: memory only
	WASM_SECTION(WASM_SECTION_IMPORT, {
		WASM_U8_THUNK({1, 1, 'e', 1, 'm', 0x02, RXJIT_MEM_FLAG});
		WASM_U32(mem_min_pages);
		WASM_U32(mem_max_pages);
	});

	// function section: 22 functions
	WASM_SECTION(WASM_SECTION_FUNCTION, {
		WASM_U8_THUNK({
			22,
			1, 1,                                           // mulh*2
			2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, // fadd/sub/mul/div type 2
			3, 3, 3, 3,                                     // fsqrt type 3
		});
	});

	// table section: 5 funcref tables, 4 entries each
	WASM_SECTION(WASM_SECTION_TABLE, {
		WASM_U8_THUNK({
			5,
			0x70, 0x01, 4, 4,
			0x70, 0x01, 4, 4,
			0x70, 0x01, 4, 4,
			0x70, 0x01, 4, 4,
			0x70, 0x01, 4, 4,
		});
	});

	// global section: 1 mutable i32 (fprc)
	WASM_SECTION(WASM_SECTION_GLOBAL, {
		WASM_U8_THUNK({1, WASM_TYPE_I32, 0x01, 0x41, 0x00, 0x0b});
	});

	// export section: mulh, imulh, tadd..tsqrt, fprc
	WASM_SECTION(WASM_SECTION_EXPORT, {
		WASM_U8_THUNK({
			8,
			// function exports
			4, 'm', 'u', 'l', 'h', 0x00, FN_MUL128HI,
			5, 'i', 'm', 'u', 'l', 'h', 0x00, FN_IMUL128HI,
			// table exports
			4, 't', 'a', 'd', 'd',  0x01, 0,
			4, 't', 's', 'u', 'b',  0x01, 1,
			4, 't', 'm', 'u', 'l',  0x01, 2,
			4, 't', 'd', 'i', 'v',  0x01, 3,
			5, 't', 's', 'q', 'r', 't', 0x01, 4,
			// global export
			4, 'f', 'p', 'r', 'c', 0x03, 0,
		});
	});

	// element section: populate tables
	WASM_SECTION(WASM_SECTION_ELEMENT, {
		WASM_U8_THUNK({
			5,
			// table 0 (fadd) -> fadd_0..3 at func indices 2..5
			0x02, 0, 0x41, 0, 0x0b, 0x00, 4, 2, 3, 4, 5,
			// table 1 (fsub) -> fsub_0..3 at 6..9
			0x02, 1, 0x41, 0, 0x0b, 0x00, 4, 6, 7, 8, 9,
			// table 2 (fmul) -> 10..13
			0x02, 2, 0x41, 0, 0x0b, 0x00, 4, 10, 11, 12, 13,
			// table 3 (fdiv) -> 14..17
			0x02, 3, 0x41, 0, 0x0b, 0x00, 4, 14, 15, 16, 17,
			// table 4 (fsqrt) -> 18..21
			0x02, 4, 0x41, 0, 0x0b, 0x00, 4, 18, 19, 20, 21,
		});
	});

	// code section: 22 function bodies
	WASM_SECTION(WASM_SECTION_CODE, {
		WASM_U8(22);
		p += emit_function_bodies(jit_feature, p);
	});

	THUNK_END;
}

// ---------------- DYNAMIC module generator ----------------

uint32_t rxjit_generate_dynamic_module(
	rxjit_vm_state_t *vm,
	rxjit_inst_t program[256],
	uint8_t *scratchpad,
	uint8_t *dataset,
	uint64_t dataset_offset,
	const uint8_t read_regs[4],
	uint32_t mem_min_pages,
	uint32_t mem_max_pages,
	int jit_feature,
	uint8_t *buf)
{
	THUNK_BEGIN;

	rxjit_jump_desc_t jump_desc[256];
	rxjit_decode(program, jump_desc);

	int rr0 = read_regs[0], rr1 = read_regs[1];
	int rr2 = read_regs[2], rr3 = read_regs[3];

	uint8_t *dataset_with_offset = (uint8_t *)((uintptr_t)dataset + (uintptr_t)dataset_offset);

	WASM_MAGIC();
	EMIT_TYPE_SECTION();

	WASM_SECTION(WASM_SECTION_IMPORT, {
		WASM_U8_THUNK({
			9,
			1, 'e', 4, 'm', 'u', 'l', 'h',   0x00, 1,
			1, 'e', 5, 'i', 'm', 'u', 'l', 'h',  0x00, 1,
			1, 'e', 1, 'm',  0x02, RXJIT_MEM_FLAG,
		});
		WASM_U32(mem_min_pages);
		WASM_U32(mem_max_pages);
		WASM_U8_THUNK({
			1, 'e', 4, 'f', 'p', 'r', 'c',   0x03, WASM_TYPE_I32, 0x01,
			1, 'e', 4, 't', 'a', 'd', 'd',   0x01, 0x70, 0x01, 4, 4,
			1, 'e', 4, 't', 's', 'u', 'b',   0x01, 0x70, 0x01, 4, 4,
			1, 'e', 4, 't', 'm', 'u', 'l',   0x01, 0x70, 0x01, 4, 4,
			1, 'e', 4, 't', 'd', 'i', 'v',   0x01, 0x70, 0x01, 4, 4,
			1, 'e', 5, 't', 's', 'q', 'r', 't',  0x01, 0x70, 0x01, 4, 4,
		});
	});

	// function section: 1 function (main, type 0)
	WASM_SECTION(WASM_SECTION_FUNCTION, {
		WASM_U8_THUNK({1, 0});
	});

	// export section: "d" -> main
	WASM_SECTION(WASM_SECTION_EXPORT, {
		WASM_U8_THUNK({
			1,
			1, 'd', 0x00, FN_MAIN,
		});
	});

	// code section: main only
	WASM_SECTION(WASM_SECTION_CODE, {
		WASM_U8(1);
		WASM_U32_PATCH({
			WASM_U8_THUNK({
				8,
				8, WASM_TYPE_I64,
				12, WASM_TYPE_V128,
				6, WASM_TYPE_I32,
				1, WASM_TYPE_I64,
				2, WASM_TYPE_V128,
				2, WASM_TYPE_I32,  // fprc, modeptr
				4, WASM_TYPE_V128, // ft0..2, vzero
				4, WASM_TYPE_I64,  // m0..3
			});
			p += jit_main_body(vm, program, jump_desc, scratchpad, dataset_with_offset,
				jit_feature, rr0, rr1, rr2, rr3, p);
			WASM_U8(0x0b);
		});
	});

	THUNK_END;
}
// clang-format on
