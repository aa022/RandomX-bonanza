// C-side WASM JIT instruction decoder + CBRANCH/IMUL_RCP analysis.
// Ported from randomx.js (src/jit/jit_vm_decoder.c) with naming adjustments.
#pragma once

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

// Canonical opcode kinds after decoding. Same set + order as randomx.js
// jit_vm.h jit_inst_kind_t, but we use a struct + uint8_t opcode field.
enum {
	RXJIT_IADD_RS = 0,
	RXJIT_IADD_M,
	RXJIT_ISUB_R,
	RXJIT_ISUB_M,
	RXJIT_IMUL_R,
	RXJIT_IMUL_M,
	RXJIT_IMULH_R,
	RXJIT_IMULH_M,
	RXJIT_ISMULH_R,
	RXJIT_ISMULH_M,
	RXJIT_IMUL_RCP,
	RXJIT_INEG_R,
	RXJIT_IXOR_R,
	RXJIT_IXOR_M,
	RXJIT_IROR_R,
	RXJIT_IROL_R,
	RXJIT_ISWAP_R,
	RXJIT_FSWAP_R,
	RXJIT_FADD_R,
	RXJIT_FADD_M,
	RXJIT_FSUB_R,
	RXJIT_FSUB_M,
	RXJIT_FSCAL_R,
	RXJIT_FMUL_R,
	RXJIT_FDIV_M,
	RXJIT_FSQRT_R,
	RXJIT_CBRANCH,
	RXJIT_CFROUND,
	RXJIT_ISTORE,
	RXJIT_NOP,
};

// Raw RandomX instruction layout (matches randomx::Instruction byte layout).
typedef struct {
	uint8_t opcode;
	uint8_t dst;
	uint8_t src;
	uint8_t mod;
	uint32_t imm32;
} rxjit_inst_t;

typedef struct {
	bool target;   // true if this PC is a loop target (CBRANCH dest)
	uint32_t mask; // CBRANCH mask: branch if (dst & mask) == 0
	uint64_t imm;  // CBRANCH imm: dst += imm
} rxjit_jump_desc_t;

// Decode 256 instructions in-place: canonicalise opcodes, mask dst/src,
// detect power-of-two IMUL_RCP (→ NOP), compute CBRANCH targets/masks.
void rxjit_decode(rxjit_inst_t insts[256], rxjit_jump_desc_t jump_desc[256]);

// =================== Threaded-interpreter decoder ===================
//
// Expanded opcode kinds. Each maps to one br_table arm in the threaded
// interpreter's main_loop. Sub-paths that need distinct WASM (src==dst vs
// src!=dst for memory ops, R-form using imm vs r[src], IADD_RS dst==5
// displacement, FSWAP F-half vs E-half, ISTORE L1/L2 vs L3) get their own
// kind to keep dispatch a single br_table lookup.
enum {
	RXJIT_K_NOP = 0,
	RXJIT_K_IADD_RS,       // dst != REGISTER_NEEDS_DISPLACEMENT
	RXJIT_K_IADD_RS_DISPL, // dst == REGISTER_NEEDS_DISPLACEMENT (5)
	RXJIT_K_IADD_M_RR,     // src != dst (L1/L2 with reg offset)
	RXJIT_K_IADD_M_DIRECT, // src == dst (L3, no reg offset)
	RXJIT_K_ISUB_R,        // src != dst
	RXJIT_K_ISUB_R_IMM,    // src == dst (use imm32)
	RXJIT_K_ISUB_M_RR,
	RXJIT_K_ISUB_M_DIRECT,
	RXJIT_K_IMUL_R,
	RXJIT_K_IMUL_R_IMM,
	RXJIT_K_IMUL_M_RR,
	RXJIT_K_IMUL_M_DIRECT,
	RXJIT_K_IMULH_R,
	RXJIT_K_IMULH_M_RR,
	RXJIT_K_IMULH_M_DIRECT,
	RXJIT_K_ISMULH_R,
	RXJIT_K_ISMULH_M_RR,
	RXJIT_K_ISMULH_M_DIRECT,
	RXJIT_K_IMUL_RCP,
	RXJIT_K_INEG_R,
	RXJIT_K_IXOR_R,
	RXJIT_K_IXOR_R_IMM,
	RXJIT_K_IXOR_M_RR,
	RXJIT_K_IXOR_M_DIRECT,
	RXJIT_K_IROR_R,
	RXJIT_K_IROR_R_IMM,
	RXJIT_K_IROL_R,
	RXJIT_K_IROL_R_IMM,
	RXJIT_K_ISWAP_R,
	RXJIT_K_FSWAP_R_F, // dst < 4 (F register)
	RXJIT_K_FSWAP_R_E, // dst >= 4 (E register; dst byte stores low 2 bits)
	RXJIT_K_FADD_R,
	RXJIT_K_FADD_M,
	RXJIT_K_FSUB_R,
	RXJIT_K_FSUB_M,
	RXJIT_K_FSCAL_R,
	RXJIT_K_FMUL_R,
	RXJIT_K_FDIV_M,
	RXJIT_K_FSQRT_R,
	RXJIT_K_CBRANCH,
	RXJIT_K_CFROUND,
	RXJIT_K_ISTORE_L12, // MOD_COND < 14 (L1 or L2 by MOD_MEM)
	RXJIT_K_ISTORE_L3,  // MOD_COND >= 14
	RXJIT_K_COUNT,      // marker; not a real kind
};

// flags byte bits (non-CBRANCH ops):
//   [0..1] MOD_SHIFT (0..3) — IADD_RS / IADD_RS_DISPL read this directly
//          off the inline byte; no mask macro is needed.
//   [2]    MOD_MEM_L1 (1=L1 mask, 0=L2 mask) — used by L1/L2 memory ops
// For CBRANCH this byte holds the target_pc instead.
#define RXJIT_FLAG_MEM_L1 0x04

// 16-byte decoded instruction record. Lives in linear memory; the threaded
// main_loop loads dst/src/imm/etc via i32.load(8_u) at runtime.
//
// Per-kind interpretation:
//   CBRANCH: flags = target_pc; imm32 = mask (low 24 bits used);
//            imm64 = composed jump imm.
//   IMUL_RCP: imm64 = rxjit_reciprocal(orig imm32); imm32 unused.
//   Others:  flags = MOD_SHIFT/MOD_MEM_L1; imm32 = raw 32-bit imm
//            (sign-extended at use site); imm64 = 0.
typedef struct {
	uint8_t opcode_kind; // 0..RXJIT_K_COUNT-1  (offset 0)
	uint8_t dst;         // 0..7 (R/A) or 0..3 (F/E)  (offset 1)
	uint8_t src;         // 0..7 (R/A) or 0..3 (F/E)  (offset 2)
	uint8_t flags;       // see RXJIT_FLAG_* / CBRANCH target_pc  (offset 3)
	uint32_t imm32;      // raw imm32 / CBRANCH mask  (offset 4)
	uint64_t imm64;      // CBRANCH composed imm / IMUL_RCP reciprocal  (offset 8)
} decoded_inst_t;
// sizeof(decoded_inst_t) must be 16 — the threaded main_loop multiplies pc<<4
// to compute the record address. A static_assert is asserted in the .c.

// Decode raw program → 256 × 16-byte records in `out`. Does NOT mutate
// `insts`. Computes the same canonicalisations as rxjit_decode plus the
// expanded opcode_kind, packed flags, pre-computed reciprocals, and
// CBRANCH (mask, composed imm, target_pc).
void rxjit_decode_for_interp(const rxjit_inst_t insts[256], decoded_inst_t out[256]);

#ifdef __cplusplus
}
#endif
