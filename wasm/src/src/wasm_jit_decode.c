// Ported from randomx.js (src/jit/jit_vm_decoder.c).
#include "wasm_jit_decode.h"
#include "wasm_jit_fuse_table.h"
#include "wasm_jit_gen.h"          // rxjit_reciprocal
#include "wasm_jit_inst_locals.h"  // IMM_SEXT64, MOD_COND, REGISTER_NEEDS_DISPLACEMENT
#include "configuration.h"
#include <string.h>
#include <assert.h>

_Static_assert(sizeof(decoded_inst_t) == 16,
               "decoded_inst_t must be exactly 16 bytes — main_loop uses pc<<4 to index.");

// `(x & (x-1)) == 0` is the canonical pow-of-two test, except it also matches
// x == 0. The IMUL_RCP decoder uses both behaviours: RandomX folds /0 and
// /pow2 to NOP, so catching both with one predicate is the desired shape.
#define POWER_OF_ZERO_OR_TWO(x) (((x) & ((x) - 1)) == 0)

#define OPCODE_CEIL_DECLARE(curr, prev) \
	static const int rxjit_ceil_##curr = rxjit_ceil_##prev + RANDOMX_FREQ_##curr;
static const int rxjit_ceil_NULL = 0;
OPCODE_CEIL_DECLARE(IADD_RS, NULL)
OPCODE_CEIL_DECLARE(IADD_M, IADD_RS)
OPCODE_CEIL_DECLARE(ISUB_R, IADD_M)
OPCODE_CEIL_DECLARE(ISUB_M, ISUB_R)
OPCODE_CEIL_DECLARE(IMUL_R, ISUB_M)
OPCODE_CEIL_DECLARE(IMUL_M, IMUL_R)
OPCODE_CEIL_DECLARE(IMULH_R, IMUL_M)
OPCODE_CEIL_DECLARE(IMULH_M, IMULH_R)
OPCODE_CEIL_DECLARE(ISMULH_R, IMULH_M)
OPCODE_CEIL_DECLARE(ISMULH_M, ISMULH_R)
OPCODE_CEIL_DECLARE(IMUL_RCP, ISMULH_M)
OPCODE_CEIL_DECLARE(INEG_R, IMUL_RCP)
OPCODE_CEIL_DECLARE(IXOR_R, INEG_R)
OPCODE_CEIL_DECLARE(IXOR_M, IXOR_R)
OPCODE_CEIL_DECLARE(IROR_R, IXOR_M)
OPCODE_CEIL_DECLARE(IROL_R, IROR_R)
OPCODE_CEIL_DECLARE(ISWAP_R, IROL_R)
OPCODE_CEIL_DECLARE(FSWAP_R, ISWAP_R)
OPCODE_CEIL_DECLARE(FADD_R, FSWAP_R)
OPCODE_CEIL_DECLARE(FADD_M, FADD_R)
OPCODE_CEIL_DECLARE(FSUB_R, FADD_M)
OPCODE_CEIL_DECLARE(FSUB_M, FSUB_R)
OPCODE_CEIL_DECLARE(FSCAL_R, FSUB_M)
OPCODE_CEIL_DECLARE(FMUL_R, FSCAL_R)
OPCODE_CEIL_DECLARE(FDIV_M, FMUL_R)
OPCODE_CEIL_DECLARE(FSQRT_R, FDIV_M)
OPCODE_CEIL_DECLARE(CBRANCH, FSQRT_R)
OPCODE_CEIL_DECLARE(CFROUND, CBRANCH)
OPCODE_CEIL_DECLARE(ISTORE, CFROUND)
#undef OPCODE_CEIL_DECLARE

void rxjit_decode(rxjit_inst_t insts[256], rxjit_jump_desc_t jump_desc[256]) {
	int register_usage[8] = {-1, -1, -1, -1, -1, -1, -1, -1};
	memset(jump_desc, 0, sizeof(rxjit_jump_desc_t) * 256);

	for (int pc = 0; pc < 256; pc++) {
		rxjit_inst_t *inst = &insts[pc];
		int opcode = inst->opcode;

		if (opcode < rxjit_ceil_IADD_RS) {
			inst->opcode = RXJIT_IADD_RS;
			inst->dst %= 8;
			inst->src %= 8;
			register_usage[inst->dst] = pc;
			continue;
		}
		if (opcode < rxjit_ceil_IADD_M) {
			inst->opcode = RXJIT_IADD_M;
			inst->dst %= 8;
			inst->src %= 8;
			register_usage[inst->dst] = pc;
			continue;
		}
		if (opcode < rxjit_ceil_ISUB_R) {
			inst->opcode = RXJIT_ISUB_R;
			inst->dst %= 8;
			inst->src %= 8;
			register_usage[inst->dst] = pc;
			continue;
		}
		if (opcode < rxjit_ceil_ISUB_M) {
			inst->opcode = RXJIT_ISUB_M;
			inst->dst %= 8;
			inst->src %= 8;
			register_usage[inst->dst] = pc;
			continue;
		}
		if (opcode < rxjit_ceil_IMUL_R) {
			inst->opcode = RXJIT_IMUL_R;
			inst->dst %= 8;
			inst->src %= 8;
			register_usage[inst->dst] = pc;
			continue;
		}
		if (opcode < rxjit_ceil_IMUL_M) {
			inst->opcode = RXJIT_IMUL_M;
			inst->dst %= 8;
			inst->src %= 8;
			register_usage[inst->dst] = pc;
			continue;
		}
		if (opcode < rxjit_ceil_IMULH_R) {
			inst->opcode = RXJIT_IMULH_R;
			inst->dst %= 8;
			inst->src %= 8;
			register_usage[inst->dst] = pc;
			continue;
		}
		if (opcode < rxjit_ceil_IMULH_M) {
			inst->opcode = RXJIT_IMULH_M;
			inst->dst %= 8;
			inst->src %= 8;
			register_usage[inst->dst] = pc;
			continue;
		}
		if (opcode < rxjit_ceil_ISMULH_R) {
			inst->opcode = RXJIT_ISMULH_R;
			inst->dst %= 8;
			inst->src %= 8;
			register_usage[inst->dst] = pc;
			continue;
		}
		if (opcode < rxjit_ceil_ISMULH_M) {
			inst->opcode = RXJIT_ISMULH_M;
			inst->dst %= 8;
			inst->src %= 8;
			register_usage[inst->dst] = pc;
			continue;
		}
		if (opcode < rxjit_ceil_IMUL_RCP) {
			uint32_t divisor = inst->imm32;
			if (POWER_OF_ZERO_OR_TWO(divisor)) {
				inst->opcode = RXJIT_NOP;
			} else {
				inst->opcode = RXJIT_IMUL_RCP;
				inst->dst %= 8;
				register_usage[inst->dst] = pc;
			}
			continue;
		}
		if (opcode < rxjit_ceil_INEG_R) {
			inst->opcode = RXJIT_INEG_R;
			inst->dst %= 8;
			register_usage[inst->dst] = pc;
			continue;
		}
		if (opcode < rxjit_ceil_IXOR_R) {
			inst->opcode = RXJIT_IXOR_R;
			inst->dst %= 8;
			inst->src %= 8;
			register_usage[inst->dst] = pc;
			continue;
		}
		if (opcode < rxjit_ceil_IXOR_M) {
			inst->opcode = RXJIT_IXOR_M;
			inst->dst %= 8;
			inst->src %= 8;
			register_usage[inst->dst] = pc;
			continue;
		}
		if (opcode < rxjit_ceil_IROR_R) {
			inst->opcode = RXJIT_IROR_R;
			inst->dst %= 8;
			inst->src %= 8;
			register_usage[inst->dst] = pc;
			continue;
		}
		if (opcode < rxjit_ceil_IROL_R) {
			inst->opcode = RXJIT_IROL_R;
			inst->dst %= 8;
			inst->src %= 8;
			register_usage[inst->dst] = pc;
			continue;
		}
		if (opcode < rxjit_ceil_ISWAP_R) {
			inst->dst %= 8;
			inst->src %= 8;
			if (inst->src == inst->dst) {
				inst->opcode = RXJIT_NOP;
			} else {
				inst->opcode = RXJIT_ISWAP_R;
				register_usage[inst->dst] = pc;
				register_usage[inst->src] = pc;
			}
			continue;
		}
		if (opcode < rxjit_ceil_FSWAP_R) {
			inst->opcode = RXJIT_FSWAP_R;
			inst->dst %= 8;
			continue;
		}
		if (opcode < rxjit_ceil_FADD_R) {
			inst->opcode = RXJIT_FADD_R;
			inst->dst %= 4;
			inst->src %= 4;
			continue;
		}
		if (opcode < rxjit_ceil_FADD_M) {
			inst->opcode = RXJIT_FADD_M;
			inst->dst %= 4;
			inst->src %= 8;
			continue;
		}
		if (opcode < rxjit_ceil_FSUB_R) {
			inst->opcode = RXJIT_FSUB_R;
			inst->dst %= 4;
			inst->src %= 4;
			continue;
		}
		if (opcode < rxjit_ceil_FSUB_M) {
			inst->opcode = RXJIT_FSUB_M;
			inst->dst %= 4;
			inst->src %= 8;
			continue;
		}
		if (opcode < rxjit_ceil_FSCAL_R) {
			inst->opcode = RXJIT_FSCAL_R;
			inst->dst %= 4;
			continue;
		}
		if (opcode < rxjit_ceil_FMUL_R) {
			inst->opcode = RXJIT_FMUL_R;
			inst->dst %= 4;
			inst->src %= 4;
			continue;
		}
		if (opcode < rxjit_ceil_FDIV_M) {
			inst->opcode = RXJIT_FDIV_M;
			inst->dst %= 4;
			inst->src %= 8;
			continue;
		}
		if (opcode < rxjit_ceil_FSQRT_R) {
			inst->opcode = RXJIT_FSQRT_R;
			inst->dst %= 4;
			continue;
		}
		if (opcode < rxjit_ceil_CBRANCH) {
			inst->opcode = RXJIT_CBRANCH;
			inst->dst %= 8;
			int b = MOD_COND(inst->mod) + RANDOMX_JUMP_OFFSET;

			uint64_t imm = (uint64_t)IMM_SEXT64(inst->imm32) | (1ULL << b);
			if (RANDOMX_JUMP_OFFSET > 0 || b > 0) {
				imm &= ~(1ULL << (b - 1));
			}

			uint32_t mask = ((1u << RANDOMX_JUMP_BITS) - 1u) << b;
			int target = register_usage[inst->dst] + 1; // -1 + 1 = 0

			jump_desc[target].target = true;
			jump_desc[pc].imm = imm;
			jump_desc[pc].mask = mask;

			for (int i = 0; i < 8; i++) {
				register_usage[i] = pc;
			}
			continue;
		}
		if (opcode < rxjit_ceil_CFROUND) {
			inst->opcode = RXJIT_CFROUND;
			inst->src %= 8;
			continue;
		}
		if (opcode < rxjit_ceil_ISTORE) {
			inst->opcode = RXJIT_ISTORE;
			inst->dst %= 8;
			inst->src %= 8;
			continue;
		}
		inst->opcode = RXJIT_NOP;
	}
}

// ---------------- Threaded-interpreter decoder ----------------
//
// Mirrors rxjit_decode but writes a wider 16-byte decoded_inst_t record per
// instruction (without mutating the input). Pre-expands sub-paths into
// distinct opcode_kind values so the interpreter dispatch is a single
// br_table lookup with no secondary branches inside the arm.

// Pre-v2 (index-based) record: the classification below fills this, then
// rxjit_pack_v2 turns it into the absolute-address v2 record.
typedef struct {
	uint8_t opcode_kind;
	uint8_t dst;
	uint8_t src;
	uint8_t flags;
	uint32_t imm32;
	uint64_t imm64;
} rxjit_dec_idx_t;

static inline void rxjit_pack_v2(const rxjit_dec_idx_t *t, decoded_inst_t *o, uint32_t vm) {
	const uint32_t RA_d = vm + 8u * t->dst, RA_s = vm + 8u * t->src;
	const uint32_t FA_d = vm + 64u + 16u * t->dst, EA_d = vm + 128u + 16u * t->dst;
	const uint32_t AA_s = vm + 192u + 16u * t->src;
	memset(o, 0, sizeof(*o));
	o->opcode_kind = t->opcode_kind;
	o->aux = t->flags;
	o->imm32 = t->imm32;
	switch (t->opcode_kind) {
	case RXJIT_K_NOP:
		memset(o, 0, sizeof(*o));
		break;
	case RXJIT_K_IMUL_RCP:
		o->dst_addr = RA_d;
		memcpy((uint8_t *)o + 8, &t->imm64, 8); // overlaps src_addr + imm32
		break;
	case RXJIT_K_INEG_R:
		o->dst_addr = RA_d;
		break;
	case RXJIT_K_FSWAP_R_F:
	case RXJIT_K_FSCAL_R:
		o->dst_addr = FA_d;
		break;
	case RXJIT_K_FSWAP_R_E:
	case RXJIT_K_FSQRT_R:
		o->dst_addr = EA_d;
		break;
	case RXJIT_K_FADD_R:
	case RXJIT_K_FSUB_R:
		o->dst_addr = FA_d;
		o->src_addr = AA_s;
		break;
	case RXJIT_K_FMUL_R:
		o->dst_addr = EA_d;
		o->src_addr = AA_s;
		break;
	case RXJIT_K_FADD_M_L1:
	case RXJIT_K_FADD_M_L2:
	case RXJIT_K_FSUB_M_L1:
	case RXJIT_K_FSUB_M_L2:
		o->dst_addr = FA_d;
		o->src_addr = RA_s;
		break;
	case RXJIT_K_FDIV_M_L1:
	case RXJIT_K_FDIV_M_L2:
		o->dst_addr = EA_d;
		o->src_addr = RA_s;
		break;
	case RXJIT_K_CBRANCH: {
		int32_t imm = (int32_t)t->imm64;
		// b = cond + 8 <= 23, so bits 32..63 are copies of bit 31.
		assert((uint64_t)(int64_t)imm == t->imm64);
		o->dst_addr = RA_d;
		memcpy((uint8_t *)o + 8, &imm, 4);
		break; // aux = target_pc, imm32 = mask (set above)
	}
	case RXJIT_K_CFROUND:
		o->src_addr = RA_s;
		o->imm32 = t->imm32 & 63;
		break;
	default: // integer ops (incl. ISWAP, ISTORE): r[dst], r[src]
		o->dst_addr = RA_d;
		o->src_addr = RA_s;
		break;
	}
}

// L1/L2 kind split: MOD_MEM != 0 selects the L1 mask (RandomX level rule).
#define L12(k1, k2) ((inst->mod & 3) ? (k1) : (k2))

int rxjit_fuse_n_for_feature(int jit_feature) {
	return (jit_feature & RXJIT_FEATURE_NO_FUSE) ? 0 : RXJIT_FUSE_N;
}

void rxjit_decode_for_interp(const rxjit_inst_t insts[256], decoded_inst_t out[256], uint32_t vm,
                             int fuse_n) {
	int register_usage[8] = {-1, -1, -1, -1, -1, -1, -1, -1};

	for (int pc = 0; pc < 256; pc++) {
		const rxjit_inst_t *inst = &insts[pc];
		rxjit_dec_idx_t tmp;
		rxjit_dec_idx_t *o = &tmp;
		memset(o, 0, sizeof(tmp));
		int opcode = inst->opcode;
		// `continue` inside the do/while(0) exits to the v2 pack below.
		do {

		uint8_t flags = (uint8_t)(((inst->mod >> 2) & 0x3) /* MOD_SHIFT */);
		if (inst->mod & 0x3) flags |= RXJIT_FLAG_MEM_L1; /* MOD_MEM */
		o->flags = flags;
		o->imm32 = inst->imm32;

		if (opcode < rxjit_ceil_IADD_RS) {
			o->dst = (uint8_t)(inst->dst % 8);
			o->src = (uint8_t)(inst->src % 8);
			o->opcode_kind = (o->dst == REGISTER_NEEDS_DISPLACEMENT) ? RXJIT_K_IADD_RS_DISPL
			                                                         : RXJIT_K_IADD_RS;
			register_usage[o->dst] = pc;
			continue;
		}
		if (opcode < rxjit_ceil_IADD_M) {
			o->dst = (uint8_t)(inst->dst % 8);
			o->src = (uint8_t)(inst->src % 8);
			o->opcode_kind = (o->src == o->dst) ? RXJIT_K_IADD_M_DIRECT
			                                    : L12(RXJIT_K_IADD_M_L1, RXJIT_K_IADD_M_L2);
			register_usage[o->dst] = pc;
			continue;
		}
		if (opcode < rxjit_ceil_ISUB_R) {
			o->dst = (uint8_t)(inst->dst % 8);
			o->src = (uint8_t)(inst->src % 8);
			o->opcode_kind = (o->src == o->dst) ? RXJIT_K_ISUB_R_IMM : RXJIT_K_ISUB_R;
			register_usage[o->dst] = pc;
			continue;
		}
		if (opcode < rxjit_ceil_ISUB_M) {
			o->dst = (uint8_t)(inst->dst % 8);
			o->src = (uint8_t)(inst->src % 8);
			o->opcode_kind = (o->src == o->dst) ? RXJIT_K_ISUB_M_DIRECT
			                                    : L12(RXJIT_K_ISUB_M_L1, RXJIT_K_ISUB_M_L2);
			register_usage[o->dst] = pc;
			continue;
		}
		if (opcode < rxjit_ceil_IMUL_R) {
			o->dst = (uint8_t)(inst->dst % 8);
			o->src = (uint8_t)(inst->src % 8);
			o->opcode_kind = (o->src == o->dst) ? RXJIT_K_IMUL_R_IMM : RXJIT_K_IMUL_R;
			register_usage[o->dst] = pc;
			continue;
		}
		if (opcode < rxjit_ceil_IMUL_M) {
			o->dst = (uint8_t)(inst->dst % 8);
			o->src = (uint8_t)(inst->src % 8);
			o->opcode_kind = (o->src == o->dst) ? RXJIT_K_IMUL_M_DIRECT
			                                    : L12(RXJIT_K_IMUL_M_L1, RXJIT_K_IMUL_M_L2);
			register_usage[o->dst] = pc;
			continue;
		}
		if (opcode < rxjit_ceil_IMULH_R) {
			o->dst = (uint8_t)(inst->dst % 8);
			o->src = (uint8_t)(inst->src % 8);
			o->opcode_kind = RXJIT_K_IMULH_R;
			register_usage[o->dst] = pc;
			continue;
		}
		if (opcode < rxjit_ceil_IMULH_M) {
			o->dst = (uint8_t)(inst->dst % 8);
			o->src = (uint8_t)(inst->src % 8);
			o->opcode_kind = (o->src == o->dst) ? RXJIT_K_IMULH_M_DIRECT
			                                    : L12(RXJIT_K_IMULH_M_L1, RXJIT_K_IMULH_M_L2);
			register_usage[o->dst] = pc;
			continue;
		}
		if (opcode < rxjit_ceil_ISMULH_R) {
			o->dst = (uint8_t)(inst->dst % 8);
			o->src = (uint8_t)(inst->src % 8);
			o->opcode_kind = RXJIT_K_ISMULH_R;
			register_usage[o->dst] = pc;
			continue;
		}
		if (opcode < rxjit_ceil_ISMULH_M) {
			o->dst = (uint8_t)(inst->dst % 8);
			o->src = (uint8_t)(inst->src % 8);
			o->opcode_kind = (o->src == o->dst) ? RXJIT_K_ISMULH_M_DIRECT
			                                    : L12(RXJIT_K_ISMULH_M_L1, RXJIT_K_ISMULH_M_L2);
			register_usage[o->dst] = pc;
			continue;
		}
		if (opcode < rxjit_ceil_IMUL_RCP) {
			uint32_t divisor = inst->imm32;
			if (POWER_OF_ZERO_OR_TWO(divisor)) {
				o->opcode_kind = RXJIT_K_NOP;
			} else {
				o->dst = (uint8_t)(inst->dst % 8);
				o->opcode_kind = RXJIT_K_IMUL_RCP;
				o->imm64 = rxjit_reciprocal(divisor);
				register_usage[o->dst] = pc;
			}
			continue;
		}
		if (opcode < rxjit_ceil_INEG_R) {
			o->dst = (uint8_t)(inst->dst % 8);
			o->opcode_kind = RXJIT_K_INEG_R;
			register_usage[o->dst] = pc;
			continue;
		}
		if (opcode < rxjit_ceil_IXOR_R) {
			o->dst = (uint8_t)(inst->dst % 8);
			o->src = (uint8_t)(inst->src % 8);
			o->opcode_kind = (o->src == o->dst) ? RXJIT_K_IXOR_R_IMM : RXJIT_K_IXOR_R;
			register_usage[o->dst] = pc;
			continue;
		}
		if (opcode < rxjit_ceil_IXOR_M) {
			o->dst = (uint8_t)(inst->dst % 8);
			o->src = (uint8_t)(inst->src % 8);
			o->opcode_kind = (o->src == o->dst) ? RXJIT_K_IXOR_M_DIRECT
			                                    : L12(RXJIT_K_IXOR_M_L1, RXJIT_K_IXOR_M_L2);
			register_usage[o->dst] = pc;
			continue;
		}
		if (opcode < rxjit_ceil_IROR_R) {
			o->dst = (uint8_t)(inst->dst % 8);
			o->src = (uint8_t)(inst->src % 8);
			o->opcode_kind = (o->src == o->dst) ? RXJIT_K_IROR_R_IMM : RXJIT_K_IROR_R;
			register_usage[o->dst] = pc;
			continue;
		}
		if (opcode < rxjit_ceil_IROL_R) {
			o->dst = (uint8_t)(inst->dst % 8);
			o->src = (uint8_t)(inst->src % 8);
			o->opcode_kind = (o->src == o->dst) ? RXJIT_K_IROL_R_IMM : RXJIT_K_IROL_R;
			register_usage[o->dst] = pc;
			continue;
		}
		if (opcode < rxjit_ceil_ISWAP_R) {
			uint8_t d = (uint8_t)(inst->dst % 8);
			uint8_t s = (uint8_t)(inst->src % 8);
			if (s == d) {
				o->opcode_kind = RXJIT_K_NOP;
			} else {
				o->dst = d;
				o->src = s;
				o->opcode_kind = RXJIT_K_ISWAP_R;
				register_usage[d] = pc;
				register_usage[s] = pc;
			}
			continue;
		}
		if (opcode < rxjit_ceil_FSWAP_R) {
			uint8_t d = (uint8_t)(inst->dst % 8);
			if (d < 4) {
				o->dst = d;
				o->opcode_kind = RXJIT_K_FSWAP_R_F;
			} else {
				o->dst = (uint8_t)(d - 4);
				o->opcode_kind = RXJIT_K_FSWAP_R_E;
			}
			continue;
		}
		if (opcode < rxjit_ceil_FADD_R) {
			o->dst = (uint8_t)(inst->dst % 4);
			o->src = (uint8_t)(inst->src % 4);
			o->opcode_kind = RXJIT_K_FADD_R;
			continue;
		}
		if (opcode < rxjit_ceil_FADD_M) {
			o->dst = (uint8_t)(inst->dst % 4);
			o->src = (uint8_t)(inst->src % 8);
			o->opcode_kind = L12(RXJIT_K_FADD_M_L1, RXJIT_K_FADD_M_L2);
			continue;
		}
		if (opcode < rxjit_ceil_FSUB_R) {
			o->dst = (uint8_t)(inst->dst % 4);
			o->src = (uint8_t)(inst->src % 4);
			o->opcode_kind = RXJIT_K_FSUB_R;
			continue;
		}
		if (opcode < rxjit_ceil_FSUB_M) {
			o->dst = (uint8_t)(inst->dst % 4);
			o->src = (uint8_t)(inst->src % 8);
			o->opcode_kind = L12(RXJIT_K_FSUB_M_L1, RXJIT_K_FSUB_M_L2);
			continue;
		}
		if (opcode < rxjit_ceil_FSCAL_R) {
			o->dst = (uint8_t)(inst->dst % 4);
			o->opcode_kind = RXJIT_K_FSCAL_R;
			continue;
		}
		if (opcode < rxjit_ceil_FMUL_R) {
			o->dst = (uint8_t)(inst->dst % 4);
			o->src = (uint8_t)(inst->src % 4);
			o->opcode_kind = RXJIT_K_FMUL_R;
			continue;
		}
		if (opcode < rxjit_ceil_FDIV_M) {
			o->dst = (uint8_t)(inst->dst % 4);
			o->src = (uint8_t)(inst->src % 8);
			o->opcode_kind = L12(RXJIT_K_FDIV_M_L1, RXJIT_K_FDIV_M_L2);
			continue;
		}
		if (opcode < rxjit_ceil_FSQRT_R) {
			o->dst = (uint8_t)(inst->dst % 4);
			o->opcode_kind = RXJIT_K_FSQRT_R;
			continue;
		}
		if (opcode < rxjit_ceil_CBRANCH) {
			uint8_t d = (uint8_t)(inst->dst % 8);
			int b = MOD_COND(inst->mod) + RANDOMX_JUMP_OFFSET;
			uint64_t imm = (uint64_t)IMM_SEXT64(inst->imm32) | (1ULL << b);
			if (RANDOMX_JUMP_OFFSET > 0 || b > 0) {
				imm &= ~(1ULL << (b - 1));
			}
			uint32_t mask = ((1u << RANDOMX_JUMP_BITS) - 1u) << b;
			int target = register_usage[d] + 1; // -1 + 1 = 0

			o->dst = d;
			o->opcode_kind = RXJIT_K_CBRANCH;
			o->imm32 = mask;
			o->imm64 = imm;
			o->flags = (uint8_t)target; // CBRANCH stores target_pc in flags byte

			for (int i = 0; i < 8; i++) {
				register_usage[i] = pc;
			}
			continue;
		}
		if (opcode < rxjit_ceil_CFROUND) {
			o->src = (uint8_t)(inst->src % 8);
			o->opcode_kind = RXJIT_K_CFROUND;
			continue;
		}
		if (opcode < rxjit_ceil_ISTORE) {
			o->dst = (uint8_t)(inst->dst % 8);
			o->src = (uint8_t)(inst->src % 8);
			o->opcode_kind = (MOD_COND(inst->mod) < 14)
			                     ? L12(RXJIT_K_ISTORE_L1, RXJIT_K_ISTORE_L2)
			                     : RXJIT_K_ISTORE_L3;
			continue;
		}
		o->opcode_kind = RXJIT_K_NOP;
		} while (0);
		rxjit_pack_v2(o, &out[pc], vm);
	}
	// Step 6: fused pair superinstructions. Only record pc's kind byte changes;
	// out[pc+1] still holds its base kind here. Record 255 is never fused (its
	// successor is the sentinel).
	if (fuse_n > 0) {
		for (int pc = 0; pc < 255; pc++) {
			uint8_t f = rxjit_fuse_tab[out[pc].opcode_kind][out[pc + 1].opcode_kind];
			if (f && f < RXJIT_K_COUNT + fuse_n) out[pc].opcode_kind = f;
		}
	}
}
