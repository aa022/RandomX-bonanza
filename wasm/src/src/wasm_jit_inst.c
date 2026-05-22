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

uint32_t rxjit_emit_instruction(const rxjit_inst_t *inst, const rxjit_jump_desc_t *jump_desc,
                                uint8_t *scratchpad, int jit_feature, uint8_t *buf) {
	THUNK_BEGIN;

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
			0x10, FN_MUL128HI,
			0x21, R(inst->dst),
		});
		break;
	case RXJIT_IMULH_M:
		if (inst->src != inst->dst) {
			WASM_U8_THUNK({0x20, R(inst->dst), 0x20, R(inst->src)});
			SCRATCHPAD_LOAD_L1_L2(inst);
			WASM_U8_THUNK({0x10, FN_MUL128HI, 0x21, R(inst->dst)});
		} else {
			WASM_U8_THUNK({0x20, R(inst->dst)});
			SCRATCHPAD_DIRECT_LOAD_L3(inst);
			WASM_U8_THUNK({0x10, FN_MUL128HI, 0x21, R(inst->dst)});
		}
		break;
	case RXJIT_ISMULH_R:
		WASM_U8_THUNK({
			0x20, R(inst->dst),
			0x20, R(inst->src),
			0x10, FN_IMUL128HI,
			0x21, R(inst->dst),
		});
		break;
	case RXJIT_ISMULH_M:
		if (inst->src != inst->dst) {
			WASM_U8_THUNK({0x20, R(inst->dst), 0x20, R(inst->src)});
			SCRATCHPAD_LOAD_L1_L2(inst);
			WASM_U8_THUNK({0x10, FN_IMUL128HI, 0x21, R(inst->dst)});
		} else {
			WASM_U8_THUNK({0x20, R(inst->dst)});
			SCRATCHPAD_DIRECT_LOAD_L3(inst);
			WASM_U8_THUNK({0x10, FN_IMUL128HI, 0x21, R(inst->dst)});
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
		WASM_U8_THUNK({
			0x20, F(inst->dst),
			0x20, A(inst->src),
			0x23, GLOB_fprc,
			0x11, 2, 0, // call_indirect type=2 ((v128,v128)->v128), table=0 (fadd)
			0x21, F(inst->dst),
		});
		break;
	case RXJIT_FADD_M:
		WASM_U8_THUNK({0x20, F(inst->dst), 0x20, R(inst->src)});
		SCRATCHPAD_LOAD_F_L1_L2(inst);
		WASM_U8_THUNK({
			0x23, GLOB_fprc,
			0x11, 2, 0,
			0x21, F(inst->dst),
		});
		break;
	case RXJIT_FSUB_R:
		WASM_U8_THUNK({
			0x20, F(inst->dst),
			0x20, A(inst->src),
			0x23, GLOB_fprc,
			0x11, 2, 1, // type=2, table=1 (fsub)
			0x21, F(inst->dst),
		});
		break;
	case RXJIT_FSUB_M:
		WASM_U8_THUNK({0x20, F(inst->dst), 0x20, R(inst->src)});
		SCRATCHPAD_LOAD_F_L1_L2(inst);
		WASM_U8_THUNK({
			0x23, GLOB_fprc,
			0x11, 2, 1,
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
		WASM_U8_THUNK({
			0x20, E(inst->dst),
			0x20, A(inst->src),
			0x23, GLOB_fprc,
			0x11, 2, 2, // type=2, table=2 (fmul)
			0x21, E(inst->dst),
		});
		break;
	case RXJIT_FDIV_M:
		WASM_U8_THUNK({0x20, E(inst->dst), 0x20, R(inst->src)});
		SCRATCHPAD_LOAD_E_L1_L2(inst);
		WASM_U8_THUNK({
			0x23, GLOB_fprc,
			0x11, 2, 3, // type=2, table=3 (fdiv)
			0x21, E(inst->dst),
		});
		break;
	case RXJIT_FSQRT_R:
		WASM_U8_THUNK({
			0x20, E(inst->dst),
			0x23, GLOB_fprc,
			0x11, 3, 4, // type=3 ((v128)->v128), table=4 (fsqrt)
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
		WASM_U8_THUNK({0x8a, 0xa7, 0x41, 3, 0x71, 0x24, GLOB_fprc});
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
