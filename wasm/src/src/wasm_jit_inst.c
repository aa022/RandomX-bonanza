// Ported from randomx.js (src/jit/jit_vm_inst.c).
//
// Each call returns the number of bytes written into `buf`.
#include "wasm_jit_inst.h"
#include "wasm_jit_inst_locals.h"
#include "wasm_jit_gen.h"
#include "configuration.h"

#define SCRATCHPAD_L1_MASK ((RANDOMX_SCRATCHPAD_L1 / 8 - 1) * 8)
#define SCRATCHPAD_L2_MASK ((RANDOMX_SCRATCHPAD_L2 / 8 - 1) * 8)
#define SCRATCHPAD_L3_MASK ((RANDOMX_SCRATCHPAD_L3 / 8 - 1) * 8)

// Scratchpad pointer emission helpers. All emit the address on the stack
// using absolute pointer + register offset + mask.

// i64.const $imm64
// i64.add
// i32.wrap_i64
// i32.const $mask (L1 or L2 depending on inst->mod)
// i32.and
// i32.const $scratchpad
// i32.add
#define SCRATCHPAD_PTR_L1_L2(inst)                                            \
	WASM_U8_THUNK({0x42});                                                    \
	WASM_I64(IMM_SEXT64((inst)->imm32));                                      \
	WASM_U8_THUNK({0x7c, 0xa7, 0x41});                                          \
	WASM_I64(MOD_MEM((inst)->mod) ? SCRATCHPAD_L1_MASK : SCRATCHPAD_L2_MASK); \
	WASM_U8_THUNK({0x71, 0x41});                                               \
	WASM_I64((int64_t)(intptr_t)scratchpad);                                  \
	WASM_U8_THUNK({0x6a})

// Direct (no register offset) L3 scratchpad pointer.
#define SCRATCHPAD_DIRECT_PTR_L3(inst)       \
	WASM_U8_THUNK({0x42});                   \
	WASM_I64(IMM_SEXT64((inst)->imm32));     \
	WASM_U8_THUNK({0xa7, 0x41});              \
	WASM_I64(SCRATCHPAD_L3_MASK);            \
	WASM_U8_THUNK({0x71, 0x41});              \
	WASM_I64((int64_t)(intptr_t)scratchpad); \
	WASM_U8_THUNK({0x6a})

// L3 pointer with register offset (for ISTORE when MOD_COND >= 14).
#define SCRATCHPAD_PTR_L3(inst)              \
	WASM_U8_THUNK({0x42});                   \
	WASM_I64(IMM_SEXT64((inst)->imm32));     \
	WASM_U8_THUNK({0x7c, 0xa7, 0x41});         \
	WASM_I64(SCRATCHPAD_L3_MASK);            \
	WASM_U8_THUNK({0x71, 0x41});              \
	WASM_I64((int64_t)(intptr_t)scratchpad); \
	WASM_U8_THUNK({0x6a})

#define SCRATCHPAD_LOAD_L1_L2(inst) \
	SCRATCHPAD_PTR_L1_L2(inst);     \
	WASM_U8_THUNK({0x29, 2, 0})

#define SCRATCHPAD_LOAD_F_L1_L2(inst) \
	SCRATCHPAD_PTR_L1_L2(inst);       \
	WASM_U8_THUNK({0xfd, 0x5d, 3, 0, 0xfd, 0xfe, 0x01})

#define SCRATCHPAD_LOAD_E_L1_L2(inst) \
	SCRATCHPAD_PTR_L1_L2(inst);       \
	WASM_U8_THUNK({0xfd, 0x5d, 3, 0, 0xfd, 0xfe, 0x01, 0x20, LOC_mask_mant, 0xfd, 0x4e, 0x20, LOC_mask_exp, 0xfd, 0x50})

#define SCRATCHPAD_DIRECT_LOAD_L3(inst) \
	SCRATCHPAD_DIRECT_PTR_L3(inst);     \
	WASM_U8_THUNK({0x29, 2, 0})

// Float op tail (5 bytes either way): call_indirect into the rounding-stub
// table, or — DIAG_NATIVE_FP, wrong hashes when fprc != 0 — two `nop`s and
// the native round-to-nearest f64x2 op.
#define FP_D (jit_feature & RXJIT_FEATURE_DIAG_NATIVE_FP)
#define FP_BYTES(op, type, tbl)                                              \
	(uint8_t)(FP_D ? 0x01 : 0x23), (uint8_t)(FP_D ? 0x01 : GLOB_fprc),       \
	(uint8_t)(FP_D ? 0xfd : 0x11), (uint8_t)(FP_D ? (op) : (type)),          \
	(uint8_t)(FP_D ? 0x01 : (tbl))
#define FP_OP(tbl) FP_OP_##tbl
#define FP_OP_0 FP_BYTES(0xf0, 2, 0)
#define FP_OP_1 FP_BYTES(0xf1, 2, 1)
#define FP_OP_2 FP_BYTES(0xf2, 2, 2)
#define FP_OP_3 FP_BYTES(0xf3, 2, 3)
#define FP_OP_4 FP_BYTES(0xef, 3, 4)


// ---------------- PJIT2: inline mulh / directed-rounding float ops ----------------

#define PJ_I64_CONST_M32() \
	WASM_U8(0x42);         \
	WASM_I64((int64_t)0xffffffffLL)

// Stack [a:i64, b:i64] -> [mulhi(a, b)]; signed_ selects smulh.
// Unsigned: 4 32x32->64 partial products. Signed: hi_u - (a<0?b:0) - (b<0?a:0).
static uint32_t pj_emit_mulh(int signed_, uint8_t *buf) {
	THUNK_BEGIN;
	WASM_U8_THUNK({0x21, LOC_m1, 0x21, LOC_m0});
	// hh = (a>>32) * (b>>32)
	WASM_U8_THUNK({0x20, LOC_m0, 0x42, 32, 0x88, 0x20, LOC_m1, 0x42, 32, 0x88, 0x7e});
	// + ((lh = lo(a) * (b>>32)) >> 32)
	WASM_U8_THUNK({0x20, LOC_m0});
	PJ_I64_CONST_M32();
	WASM_U8_THUNK({0x83, 0x20, LOC_m1, 0x42, 32, 0x88, 0x7e, 0x22, LOC_m2, 0x42, 32, 0x88, 0x7c});
	// + ((hl = (a>>32) * lo(b)) >> 32)
	WASM_U8_THUNK({0x20, LOC_m0, 0x42, 32, 0x88, 0x20, LOC_m1});
	PJ_I64_CONST_M32();
	WASM_U8_THUNK({0x83, 0x7e, 0x22, LOC_m3, 0x42, 32, 0x88, 0x7c});
	// + ((lo(a)*lo(b) >> 32) + lo(lh) + lo(hl)) >> 32
	WASM_U8_THUNK({0x20, LOC_m0});
	PJ_I64_CONST_M32();
	WASM_U8_THUNK({0x83, 0x20, LOC_m1});
	PJ_I64_CONST_M32();
	WASM_U8_THUNK({0x83, 0x7e, 0x42, 32, 0x88, 0x20, LOC_m2});
	PJ_I64_CONST_M32();
	WASM_U8_THUNK({0x83, 0x7c, 0x20, LOC_m3});
	PJ_I64_CONST_M32();
	WASM_U8_THUNK({0x83, 0x7c, 0x42, 32, 0x88, 0x7c});
	if (signed_) {
		WASM_U8_THUNK({
			0x20, LOC_m0, 0x42, 63, 0x87, 0x20, LOC_m1, 0x83, 0x7d, // - ((a>>63) & b)
			0x20, LOC_m1, 0x42, 63, 0x87, 0x20, LOC_m0, 0x83, 0x7d, // - ((b>>63) & a)
		});
	}
	THUNK_END;
}

// local.get $modeptr; v128.load offset=16*k
#define PJ_MODE(k) 0x20, LOC_modeptr, 0xfd, 0x00, 4, (uint8_t)(16 * (k))
#define PJ_K1  0
#define PJ_K2  1
#define PJ_D1  2
#define PJ_D3  3
#define PJ_KON 4

// Inputs: $ft0 = c (round-to-nearest result), $ft1 = res (true - c, sign
// only matters; may be NaN once an E register overflowed to inf). Pushes the
// directed-rounded result. Branchless and exactly equivalent to the semifloat
// nextafter_{1,2,3}_{finite,nozero} stubs (NaN/zero res never rounds):
//   csign = c < 0
//   delta = ((csign ^ D1) | D3)                            (-1 / +1 ulp on the bits)
//   round = bitselect(res > 0, res < 0, K1 | (csign & K2)) & Kon
//   out   = c + (round & delta)                            (i64x2)
static uint32_t pj_emit_round_fixup(uint8_t *buf) {
	THUNK_BEGIN;
	WASM_U8_THUNK({
		0x20, LOC_ft0, 0x20, LOC_vzero, 0xfd, 0x49, 0x21, LOC_ft2, // ft2 = csign
		0x20, LOC_ft0,
		0x20, LOC_ft2, PJ_MODE(PJ_D1), 0xfd, 0x51, PJ_MODE(PJ_D3), 0xfd, 0x50,
		0x20, LOC_ft1, 0x20, LOC_vzero, 0xfd, 0x4a, // res > 0
		0x20, LOC_ft1, 0x20, LOC_vzero, 0xfd, 0x49, // res < 0
		0x20, LOC_ft2, PJ_MODE(PJ_K2), 0xfd, 0x4e, PJ_MODE(PJ_K1), 0xfd, 0x50,
		0xfd, 0x52,                                 // v128.bitselect
		PJ_MODE(PJ_KON), 0xfd, 0x4e,
		0xfd, 0x4e,       // round & delta
		0xfd, 0xce, 0x01, // i64x2.add
	});
	THUNK_END;
}

// Stack [b'] (already negated for sub); a in local `a`. Writes result to `a`.
// c = a + b'; res = (a - (c - b')) + (b' - (c - a))   (semifloat sum_residue)
static uint32_t pj_emit_fadd(int a, uint8_t *buf) {
	THUNK_BEGIN;
	WASM_U8_THUNK({
		0x21, LOC_ft2,
		0x20, a, 0x20, LOC_ft2, 0xfd, 0xf0, 0x01, 0x21, LOC_ft0,
		0x20, a, 0x20, LOC_ft0, 0x20, LOC_ft2, 0xfd, 0xf1, 0x01, 0xfd, 0xf1, 0x01,
		0x20, LOC_ft2, 0x20, LOC_ft0, 0x20, a, 0xfd, 0xf1, 0x01, 0xfd, 0xf1, 0x01,
		0xfd, 0xf0, 0x01, 0x21, LOC_ft1,
	});
	p += pj_emit_round_fixup(p);
	WASM_U8_THUNK({0x21, a});
	THUNK_END;
}

// Stack [b]; c = a * b; res = fma(a, b, -c)
static uint32_t pj_emit_fmul(int a, uint8_t *buf) {
	THUNK_BEGIN;
	WASM_U8_THUNK({
		0x21, LOC_ft2,
		0x20, a, 0x20, LOC_ft2, 0xfd, 0xf2, 0x01, 0x21, LOC_ft0,
		0x20, a, 0x20, LOC_ft2, 0x20, LOC_ft0, 0xfd, 0xed, 0x01, 0xfd, 0x87, 0x02, 0x21, LOC_ft1,
	});
	p += pj_emit_round_fixup(p);
	WASM_U8_THUNK({0x21, a});
	THUNK_END;
}

// Stack [b]; c = a / b; res = -fma(c, b, -a)
static uint32_t pj_emit_fdiv(int a, uint8_t *buf) {
	THUNK_BEGIN;
	WASM_U8_THUNK({
		0x21, LOC_ft2,
		0x20, a, 0x20, LOC_ft2, 0xfd, 0xf3, 0x01, 0x21, LOC_ft0,
		0x20, LOC_ft0, 0x20, LOC_ft2, 0x20, a, 0xfd, 0xed, 0x01, 0xfd, 0x87, 0x02,
		0xfd, 0xed, 0x01, 0x21, LOC_ft1,
	});
	p += pj_emit_round_fixup(p);
	WASM_U8_THUNK({0x21, a});
	THUNK_END;
}

// c = sqrt(a); res = -fma(c, c, -a)
static uint32_t pj_emit_fsqrt(int a, uint8_t *buf) {
	THUNK_BEGIN;
	WASM_U8_THUNK({
		0x20, a, 0xfd, 0xef, 0x01, 0x21, LOC_ft0,
		0x20, LOC_ft0, 0x20, LOC_ft0, 0x20, a, 0xfd, 0xed, 0x01, 0xfd, 0x87, 0x02,
		0xfd, 0xed, 0x01, 0x21, LOC_ft1,
	});
	p += pj_emit_round_fixup(p);
	WASM_U8_THUNK({0x21, a});
	THUNK_END;
}

uint32_t rxjit_emit_set_mode(uint8_t *buf);

uint32_t rxjit_emit_instruction(const rxjit_inst_t *inst, const rxjit_jump_desc_t *jump_desc,
                                uint8_t *scratchpad, int jit_feature, uint8_t *buf) {
	THUNK_BEGIN;
	const int pj = jit_feature & RXJIT_FEATURE_PJIT2;
	const int pj_fp = pj && (jit_feature & RXJIT_FEATURE_FMA);

	if (jump_desc->target) {
		WASM_U8_THUNK({0x03, 0x40}); // loop () -> ()
	}

	switch (inst->opcode) {
	case RXJIT_IADD_RS:
		if (inst->dst != REGISTER_NEEDS_DISPLACEMENT) {
			WASM_U8_THUNK({
				0x20, R(inst->dst),
				0x20, R(inst->src),
				0x42, MOD_SHIFT(inst->mod),
				0x86, 0x7c,
				0x21, R(inst->dst),
			});
		} else {
			WASM_U8_THUNK({
				0x20, R(inst->dst),
				0x20, R(inst->src),
				0x42, MOD_SHIFT(inst->mod),
				0x86, 0x7c,
				0x42,
			});
			WASM_I64(IMM_SEXT64(inst->imm32));
			WASM_U8_THUNK({0x7c, 0x21, R(inst->dst)});
		}
		break;
	case RXJIT_IADD_M:
		if (inst->src != inst->dst) {
			WASM_U8_THUNK({0x20, R(inst->dst), 0x20, R(inst->src)});
			SCRATCHPAD_LOAD_L1_L2(inst);
			WASM_U8_THUNK({0x7c, 0x21, R(inst->dst)});
		} else {
			WASM_U8_THUNK({0x20, R(inst->dst)});
			SCRATCHPAD_DIRECT_LOAD_L3(inst);
			WASM_U8_THUNK({0x7c, 0x21, R(inst->dst)});
		}
		break;
	case RXJIT_ISUB_R:
		if (inst->src != inst->dst) {
			WASM_U8_THUNK({
				0x20, R(inst->dst),
				0x20, R(inst->src),
				0x7d,
				0x21, R(inst->dst),
			});
		} else {
			WASM_U8_THUNK({0x20, R(inst->dst), 0x42});
			WASM_I64(IMM_SEXT64(inst->imm32));
			WASM_U8_THUNK({0x7d, 0x21, R(inst->dst)});
		}
		break;
	case RXJIT_ISUB_M:
		if (inst->src != inst->dst) {
			WASM_U8_THUNK({0x20, R(inst->dst), 0x20, R(inst->src)});
			SCRATCHPAD_LOAD_L1_L2(inst);
			WASM_U8_THUNK({0x7d, 0x21, R(inst->dst)});
		} else {
			WASM_U8_THUNK({0x20, R(inst->dst)});
			SCRATCHPAD_DIRECT_LOAD_L3(inst);
			WASM_U8_THUNK({0x7d, 0x21, R(inst->dst)});
		}
		break;
	case RXJIT_IMUL_R:
		if (inst->src != inst->dst) {
			WASM_U8_THUNK({
				0x20, R(inst->dst),
				0x20, R(inst->src),
				0x7e,
				0x21, R(inst->dst),
			});
		} else {
			WASM_U8_THUNK({0x20, R(inst->dst), 0x42});
			WASM_I64(IMM_SEXT64(inst->imm32));
			WASM_U8_THUNK({0x7e, 0x21, R(inst->dst)});
		}
		break;
	case RXJIT_IMUL_M:
		if (inst->src != inst->dst) {
			WASM_U8_THUNK({0x20, R(inst->dst), 0x20, R(inst->src)});
			SCRATCHPAD_LOAD_L1_L2(inst);
			WASM_U8_THUNK({0x7e, 0x21, R(inst->dst)});
		} else {
			WASM_U8_THUNK({0x20, R(inst->dst)});
			SCRATCHPAD_DIRECT_LOAD_L3(inst);
			WASM_U8_THUNK({0x7e, 0x21, R(inst->dst)});
		}
		break;
	case RXJIT_IMULH_R:
		WASM_U8_THUNK({
			0x20, R(inst->dst),
			0x20, R(inst->src),
		});
		if (pj) {
			p += pj_emit_mulh(0, p);
		} else {
			WASM_U8_THUNK({0x10, FN_MUL128HI});
		}
		WASM_U8_THUNK({0x21, R(inst->dst)});
		break;
	case RXJIT_IMULH_M:
		if (inst->src != inst->dst) {
			WASM_U8_THUNK({0x20, R(inst->dst), 0x20, R(inst->src)});
			SCRATCHPAD_LOAD_L1_L2(inst);
			if (pj) {
				p += pj_emit_mulh(0, p);
			} else {
				WASM_U8_THUNK({0x10, FN_MUL128HI});
			}
			WASM_U8_THUNK({0x21, R(inst->dst)});
		} else {
			WASM_U8_THUNK({0x20, R(inst->dst)});
			SCRATCHPAD_DIRECT_LOAD_L3(inst);
			if (pj) {
				p += pj_emit_mulh(0, p);
			} else {
				WASM_U8_THUNK({0x10, FN_MUL128HI});
			}
			WASM_U8_THUNK({0x21, R(inst->dst)});
		}
		break;
	case RXJIT_ISMULH_R:
		WASM_U8_THUNK({
			0x20, R(inst->dst),
			0x20, R(inst->src),
		});
		if (pj) {
			p += pj_emit_mulh(1, p);
		} else {
			WASM_U8_THUNK({0x10, FN_IMUL128HI});
		}
		WASM_U8_THUNK({0x21, R(inst->dst)});
		break;
	case RXJIT_ISMULH_M:
		if (inst->src != inst->dst) {
			WASM_U8_THUNK({0x20, R(inst->dst), 0x20, R(inst->src)});
			SCRATCHPAD_LOAD_L1_L2(inst);
			if (pj) {
				p += pj_emit_mulh(1, p);
			} else {
				WASM_U8_THUNK({0x10, FN_IMUL128HI});
			}
			WASM_U8_THUNK({0x21, R(inst->dst)});
		} else {
			WASM_U8_THUNK({0x20, R(inst->dst)});
			SCRATCHPAD_DIRECT_LOAD_L3(inst);
			if (pj) {
				p += pj_emit_mulh(1, p);
			} else {
				WASM_U8_THUNK({0x10, FN_IMUL128HI});
			}
			WASM_U8_THUNK({0x21, R(inst->dst)});
		}
		break;
	case RXJIT_IMUL_RCP:
		WASM_U8_THUNK({0x20, R(inst->dst), 0x42});
		WASM_I64((int64_t)rxjit_reciprocal(inst->imm32));
		WASM_U8_THUNK({0x7e, 0x21, R(inst->dst)});
		break;
	case RXJIT_INEG_R:
		WASM_U8_THUNK({
			0x42, 0,
			0x20, R(inst->dst),
			0x7d,
			0x21, R(inst->dst),
		});
		break;
	case RXJIT_IXOR_R:
		if (inst->src != inst->dst) {
			WASM_U8_THUNK({
				0x20, R(inst->dst),
				0x20, R(inst->src),
				0x85,
				0x21, R(inst->dst),
			});
		} else {
			WASM_U8_THUNK({0x20, R(inst->dst), 0x42});
			WASM_I64(IMM_SEXT64(inst->imm32));
			WASM_U8_THUNK({0x85, 0x21, R(inst->dst)});
		}
		break;
	case RXJIT_IXOR_M:
		if (inst->src != inst->dst) {
			WASM_U8_THUNK({0x20, R(inst->dst), 0x20, R(inst->src)});
			SCRATCHPAD_LOAD_L1_L2(inst);
			WASM_U8_THUNK({0x85, 0x21, R(inst->dst)});
		} else {
			WASM_U8_THUNK({0x20, R(inst->dst)});
			SCRATCHPAD_DIRECT_LOAD_L3(inst);
			WASM_U8_THUNK({0x85, 0x21, R(inst->dst)});
		}
		break;
	case RXJIT_IROR_R:
		if (inst->src != inst->dst) {
			WASM_U8_THUNK({
				0x20, R(inst->dst),
				0x20, R(inst->src),
				0x8a,
				0x21, R(inst->dst),
			});
		} else {
			WASM_U8_THUNK({0x20, R(inst->dst), 0x42});
			WASM_I64(IMM_SEXT64(inst->imm32));
			WASM_U8_THUNK({0x8a, 0x21, R(inst->dst)});
		}
		break;
	case RXJIT_IROL_R:
		if (inst->src != inst->dst) {
			WASM_U8_THUNK({
				0x20, R(inst->dst),
				0x20, R(inst->src),
				0x89,
				0x21, R(inst->dst),
			});
		} else {
			WASM_U8_THUNK({0x20, R(inst->dst), 0x42});
			WASM_I64(IMM_SEXT64(inst->imm32));
			WASM_U8_THUNK({0x89, 0x21, R(inst->dst)});
		}
		break;
	case RXJIT_ISWAP_R:
		WASM_U8_THUNK({
			0x20, R(inst->dst),
			0x20, R(inst->src),
			0x21, R(inst->dst),
			0x21, R(inst->src),
		});
		break;
	case RXJIT_FSWAP_R: {
		int wdst = inst->dst < 4 ? F(inst->dst) : E(inst->dst - 4);
		WASM_U8_THUNK({
			0x20, wdst,
			0xfd, 0x0c, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
			0x0f, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
		});
		if (jit_feature & RXJIT_FEATURE_RELAXED_SIMD) {
			WASM_U8_THUNK({0xfd, 0x80, 0x02});
		} else {
			WASM_U8_THUNK({0xfd, 0x0e});
		}
		WASM_U8_THUNK({0x21, wdst});
		break;
	}
	case RXJIT_FADD_R:
		if (pj_fp) {
			WASM_U8_THUNK({0x20, A(inst->src)});
			p += pj_emit_fadd(F(inst->dst), p);
			break;
		}
		WASM_U8_THUNK({
			0x20, F(inst->dst),
			0x20, A(inst->src),
			FP_OP(0), // call_indirect type=2 ((v128,v128)->v128), table=0 (fadd)
			0x21, F(inst->dst),
		});
		break;
	case RXJIT_FADD_M:
		if (pj_fp) {
			WASM_U8_THUNK({0x20, R(inst->src)});
			SCRATCHPAD_LOAD_F_L1_L2(inst);
			p += pj_emit_fadd(F(inst->dst), p);
			break;
		}
		WASM_U8_THUNK({0x20, F(inst->dst), 0x20, R(inst->src)});
		SCRATCHPAD_LOAD_F_L1_L2(inst);
		WASM_U8_THUNK({
			FP_OP(0),
			0x21, F(inst->dst),
		});
		break;
	case RXJIT_FSUB_R:
		if (pj_fp) {
			WASM_U8_THUNK({0x20, A(inst->src), 0xfd, 0xed, 0x01});
			p += pj_emit_fadd(F(inst->dst), p);
			break;
		}
		WASM_U8_THUNK({
			0x20, F(inst->dst),
			0x20, A(inst->src),
			FP_OP(1), // type=2, table=1 (fsub)
			0x21, F(inst->dst),
		});
		break;
	case RXJIT_FSUB_M:
		if (pj_fp) {
			WASM_U8_THUNK({0x20, R(inst->src)});
			SCRATCHPAD_LOAD_F_L1_L2(inst);
			WASM_U8_THUNK({0xfd, 0xed, 0x01});
			p += pj_emit_fadd(F(inst->dst), p);
			break;
		}
		WASM_U8_THUNK({0x20, F(inst->dst), 0x20, R(inst->src)});
		SCRATCHPAD_LOAD_F_L1_L2(inst);
		WASM_U8_THUNK({
			FP_OP(1),
			0x21, F(inst->dst),
		});
		break;
	case RXJIT_FSCAL_R:
		WASM_U8_THUNK({
			0x20, F(inst->dst),
			0xfd, 0x0c, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0,
			0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x80,
			0xfd, 0x51,
			0x21, F(inst->dst),
		});
		break;
	case RXJIT_FMUL_R:
		if (pj_fp) {
			WASM_U8_THUNK({0x20, A(inst->src)});
			p += pj_emit_fmul(E(inst->dst), p);
			break;
		}
		WASM_U8_THUNK({
			0x20, E(inst->dst),
			0x20, A(inst->src),
			FP_OP(2), // type=2, table=2 (fmul)
			0x21, E(inst->dst),
		});
		break;
	case RXJIT_FDIV_M:
		if (pj_fp) {
			WASM_U8_THUNK({0x20, R(inst->src)});
			SCRATCHPAD_LOAD_E_L1_L2(inst);
			p += pj_emit_fdiv(E(inst->dst), p);
			break;
		}
		WASM_U8_THUNK({0x20, E(inst->dst), 0x20, R(inst->src)});
		SCRATCHPAD_LOAD_E_L1_L2(inst);
		WASM_U8_THUNK({
			FP_OP(3), // type=2, table=3 (fdiv)
			0x21, E(inst->dst),
		});
		break;
	case RXJIT_FSQRT_R:
		if (pj_fp) {
			p += pj_emit_fsqrt(E(inst->dst), p);
			break;
		}
		WASM_U8_THUNK({
			0x20, E(inst->dst),
			FP_OP(4), // type=3 ((v128)->v128), table=4 (fsqrt)
			0x21, E(inst->dst),
		});
		break;
	case RXJIT_CBRANCH:
		WASM_U8_THUNK({0x20, R(inst->dst), 0x42});
		WASM_I64((int64_t)jump_desc->imm);
		WASM_U8_THUNK({0x7c, 0x22, R(inst->dst), 0x42});
		WASM_I64((int64_t)(uint64_t)jump_desc->mask);
		WASM_U8_THUNK({0x83, 0x50, 0x0d, 0, 0x0b});
		break;
	case RXJIT_CFROUND:
		WASM_U8_THUNK({0x20, R(inst->src), 0x42});
		WASM_I64((int64_t)(inst->imm32 & 63));
		if (pj) {
			WASM_U8_THUNK({0x8a, 0xa7, 0x41, 3, 0x71});
			p += rxjit_emit_set_mode(p);
			// keep the imported global in sync for any float op still using call_indirect
			WASM_U8_THUNK({0x20, LOC_fprc, 0x24, GLOB_fprc});
		} else {
			WASM_U8_THUNK({0x8a, 0xa7, 0x41, 3, 0x71, 0x24, GLOB_fprc});
		}
		break;
	case RXJIT_ISTORE:
		if (MOD_COND(inst->mod) < 14) {
			WASM_U8_THUNK({0x20, R(inst->dst)});
			SCRATCHPAD_PTR_L1_L2(inst);
			WASM_U8_THUNK({0x20, R(inst->src), 0x37, 2, 0});
		} else {
			WASM_U8_THUNK({0x20, R(inst->dst)});
			SCRATCHPAD_PTR_L3(inst);
			WASM_U8_THUNK({0x20, R(inst->src), 0x37, 2, 0});
		}
		break;
	case RXJIT_NOP:
	default:
		break;
	}

	THUNK_END;
}
