// Internal: local indices, function indices, and helper macros shared between
// the per-instruction emitter (wasm_jit_inst.c) and the main module generator
// (wasm_jit_gen.c). Mirrors randomx.js src/jit/jit_vm.h.
#pragma once

#include "wasm_jit_macros.h"

// Dynamic-module layout. The dynamic module imports two functions (mulh
// and imulh) and the 5 tables from the static module, so function indices
// 0/1 are the imports and 2 is our main.
//
// WASM local indices (NOT byte offsets — for vm_state byte offsets see
// rxjit_vm_state_t in wasm_jit_gen.h). R/F/E/A occupy contiguous 8/4/4/4
// slots; the loose locals 20..28 sit immediately after them in main's
// local-decl block emitted by jit_main_body.
#define R(i)          (0 + (i))
#define F(i)          (8 + (i))
#define E(i)          (12 + (i))
#define A(i)          (16 + (i))
#define LOC_sp_addr0  20
#define LOC_sp_addr1  21
#define LOC_mx        22
#define LOC_ma        23
#define LOC_tmp       24
#define LOC_ic        25
#define LOC_tmp64     26
#define LOC_mask_mant 27
#define LOC_mask_exp  28
// PJIT2 extras (declared unconditionally; unused locals are free).
#define LOC_fprc      29 // i32: current rounding mode 0..3
#define LOC_modeptr   30 // i32: &rxjit_mode_tbl[fprc]
#define LOC_ft0       31 // v128 temps for inline rounding
#define LOC_ft1       32
#define LOC_ft2       33
#define LOC_vzero     34 // v128, never written (== 0)
#define LOC_m0        35 // i64 temps for inline mulh
#define LOC_m1        36
#define LOC_m2        37
#define LOC_m3        38

// imported mutable global 0 = fprc (shared with static module)
#define GLOB_fprc 0

// function indices in the dynamic module:
//   import 0: e.mulh  -> mul128hi
//   import 1: e.imulh -> imul128hi
//   defined  2: main
#define FN_MUL128HI  0
#define FN_IMUL128HI 1
#define FN_MAIN      2

// IMM_SEXT64: WASM is always two's complement; sign-extend imm32 to i64.
#define IMM_SEXT64(x)               ((int64_t)(int32_t)(x))
#define MOD_MEM(x)                  ((x) & 3)
#define MOD_SHIFT(x)                (((x) >> 2) & 3)
#define MOD_COND(x)                 ((x) >> 4)

#define REGISTER_NEEDS_DISPLACEMENT 5
