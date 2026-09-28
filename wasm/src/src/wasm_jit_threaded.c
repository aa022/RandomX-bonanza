// Threaded-interpreter WASM module generator.
//
// Big-picture: emit ONE WebAssembly module per pthread that contains
//   1) the same 22 SIMD semifloat + mulh stubs as the original static module
//   2) the 5 funcref tables for fprc-driven dispatch
//   3) the fprc mutable global
//   4) a single "main_loop" function exported as "d" that runs the entire
//      RandomX program (2048 iterations × 256 instructions) by reading a
//      256×16-byte decoded-instruction array out of linear memory and
//      dispatching opcodes via a single big br_table.
//
// Why this beats the dynamic-module-per-program design:
//   - new WebAssembly.Module() and new WebAssembly.Instance() happen ZERO
//     times per program (the threaded module is compiled+instantiated once
//     per pthread).
//   - All per-program state (the decoded program, fprc, ma, mx, read_regs,
//     dataset_offset) lives in linear memory; main_loop reads from it via
//     the existing memory import. No JS allocation in the hot path.
//   - Phase 0 V8 Liftoff experiments (recorded in memory entry
//     project_safari_degradation_root_cause.md) proved per-Instance is the
//     load-bearing cost, not per-Module.
#include "wasm_jit_threaded.h"
#include "wasm_jit_decode.h"
#include "wasm_jit_macros.h"
#include "wasm_jit_inst_locals.h" // R/F/E/A/LOC_* indices we mirror
#include "wasm_jit_gen.h"         // rxjit_reciprocal (unused here, but for consistency)
#include "configuration.h"
#include <string.h>

// Pull in the stub byte arrays just like wasm_jit_gen.c does. Self-included
// (the .h is #pragma once but the static const arrays will be duplicated in
// this TU; that's fine — they're small and only referenced at module-gen
// time, which is once per thread).
#define FUNC_OFFSET FN_MUL128HI
#include "jit_stubs/mulh.h"

#undef FUNC_OFFSET
#define FUNC_OFFSET 3
#include "jit_stubs/semifloat.h"
#undef FUNC_OFFSET

// ---------------- Module-wide constants ----------------

// Scratchpad-region masks. The `/8 - 1) * 8` shape is "all bits required to
// address inside the region, with low 3 bits cleared so the result is i64-
// aligned" (memory ops always load 8 bytes). _MASK_64 is the same trick at
// 64-byte (cache-line) granularity for the step-1 sp_addr setup.
#define SCRATCHPAD_L1_MASK    ((RANDOMX_SCRATCHPAD_L1 / 8 - 1) * 8)
#define SCRATCHPAD_L2_MASK    ((RANDOMX_SCRATCHPAD_L2 / 8 - 1) * 8)
#define SCRATCHPAD_L3_MASK    ((RANDOMX_SCRATCHPAD_L3 / 8 - 1) * 8)
#define SCRATCHPAD_L3_MASK_64 ((RANDOMX_SCRATCHPAD_L3 / 8 / 8 - 1) * 64)
// Dataset is addressed by `ma` snapped to 64-byte cache-line boundaries.
#define CACHE_LINE_MASK       ((RANDOMX_DATASET_BASE_SIZE - 1) & ~((uint64_t)64 - 1))

// ---------------- Threaded main_loop local indices ----------------
// Mirrors wasm_jit_inst_locals.h for indices 0..28, then appends new ones.
//   R(0..7)        = 0..7       i64
//   F/E/A(0..3)    = 8..19      v128
//   LOC_sp_addr0   = 20         i32
//   LOC_sp_addr1   = 21
//   LOC_mx         = 22
//   LOC_ma         = 23
//   LOC_tmp        = 24
//   LOC_ic         = 25
//   LOC_tmp64      = 26         i64
//   LOC_mask_mant  = 27         v128
//   LOC_mask_exp   = 28
//   ---- threaded-specific ----
//   LOCT_inst_ptr  = 29         i32
//   LOCT_pc        = 30
//   LOCT_dst_byte  = 31
//   LOCT_src_byte  = 32
//   LOCT_rr0..3    = 33..36
//   LOCT_ds_ptr    = 37  (dataset_base + dataset_offset, i32)
//   LOCT_tmp64_b   = 38         i64
#define LOCT_inst_ptr     29
#define LOCT_pc           30
#define LOCT_dst_byte     31
#define LOCT_src_byte     32
#define LOCT_rr0          33
#define LOCT_rr1          34
#define LOCT_rr2          35
#define LOCT_rr3          36
#define LOCT_ds_ptr       37
#define LOCT_tmp64_b      38
#define LOCT_v128_scratch 39
// Reserved locals (declared in emit_local_decls; unused locals are free in
// TurboFan). NEVER use LOC_m0..m3 / LOC_ft* from wasm_jit_inst_locals.h here:
// their indices 29..38 collide with the LOCT_* i32 locals above.
#define LOCT_m0           40 // i64: inline mulh temps
#define LOCT_m1           41
#define LOCT_m2           42
#define LOCT_m3           43
#define LOCT_fa           44 // v128: inline rounding temps
#define LOCT_fb           45
#define LOCT_fc           46
#define LOCT_fr           47
#define LOCT_fs           48
#define LOCT_mTEG         49 // v128: rounding masks
#define LOCT_mTEL         50
#define LOCT_mK1          51
#define LOCT_mK2          52
#define LOCT_mD1          53
#define LOCT_mD3          54
#define LOCT_mKON         55
#define LOCT_rmoff        56 // i32: rounding-mask table offset
#define LOCT_spb          57 // i32: scratchpad base
#define LOCT_spare        58 // i32

// Function indices in the threaded module (no imports, so first locally-
// defined function is index 0).
#define TFN_MULH  0
#define TFN_IMULH 1
// When split_id is off, main_loop is the only non-stub function at index 22.
// When split_id is on, we insert inner_dispatch at index 22 and shift
// main_loop to 23. Use TFN_MAIN_LOOP_FOR / TFN_INNER_DISPATCH_FOR helpers
// when an emitter needs the correct index (the helpers below).
#define TFN_INNER_DISPATCH  22
#define TFN_MAIN_LOOP       22
#define TFN_MAIN_LOOP_SPLIT 23

// Funcref table indices (matches static module).
#define TBL_FADD  0
#define TBL_FSUB  1
#define TBL_FMUL  2
#define TBL_FDIV  3
#define TBL_FSQRT 4

// Mutable i32 global: fprc (same role as in static/dynamic modules).
#define TGLOB_fprc 0

// ---------------- V3 module-gen flags (thread-local) ----------------
//
// These three are CODE-GEN PARAMETERS, not runtime switches. They are
// written ONCE at the top of rxjit_generate_threaded_module() and then
// read-only for the duration of that call by the emit_* helpers below.
// _Thread_local because every pthread runs its own gen pass concurrently;
// there's no synchronisation around them by design.
//
// V3 = "r registers live in linear memory instead of WASM locals". The
// select trees / br_table writes get replaced with direct i64.load/store;
// the prologue/epilogue R-load/R-store becomes a no-op (the C side already
// keeps vm->r in sync via memcpy from/to nreg.r). On JSC this is a measured
// win because BBQ does not register-allocate locals across instructions, so
// the select-tree reads become real loads anyway, but with 5-7× the wasm
// bytes.
static _Thread_local int g_emit_regs_in_mem = 0;
static _Thread_local uint32_t g_r_file_base = 0;

// V2-minimal (a.k.a. "split inner dispatch"): when 1, the entire inner pc
// loop (256 iterations × br_table dispatch) is extracted into its own wasm
// function. JSC's OMG tier-up heuristic appears to refuse the ~9–14 KiB
// `main_loop` function but should accept this isolated ~2.5 KiB function.
// Implies V3 + extends register-memory relocation to F/E/A so the function
// can be `() -> ()` with no argument-passing overhead at the call boundary.
static _Thread_local int g_emit_split_id = 0;

// vm_state offsets (mirrors rxjit_vm_state_t in wasm_jit_gen.h).
#define VM_R0_OFFSET    0
#define VM_F0_OFFSET    64
#define VM_E0_OFFSET    128
#define VM_A0_OFFSET    192
#define VM_EMASK_OFFSET 256
#define VM_MMASK_OFFSET 272
#define VM_FPRC_OFFSET  288
#define VM_MA_OFFSET    292
#define VM_MX_OFFSET    296
// Extended fields used only by the threaded interpreter.
#define VM_READ_REGS_OFFSET 304 // 4 bytes: read_reg0..3 packed as bytes
#define VM_DS_PTR_OFFSET    308 // 4 bytes: dataset_base + dataset_offset
#define VM_EXT_END          312 // total size for threaded mode

// Decoded-inst field offsets within the 16-byte record.
#define D_OP    0
#define D_DST   1
#define D_SRC   2
#define D_FLAGS 3 // CBRANCH: target_pc
#define D_IMM32 4 // raw imm32 / CBRANCH mask
#define D_IMM64 8 // CBRANCH composed imm / IMUL_RCP recip

// ---------------- Small helpers (operate on `uint8_t *p`) ----------------

// Emit `i32.const $v` (sleb128).
#define WI32_CONST(v)                    \
	do {                                 \
		WASM_U8(0x41);                   \
		WASM_I64((int64_t)(int32_t)(v)); \
	} while (0)
// Emit `i64.const $v` (sleb128).
#define WI64_CONST(v)           \
	do {                        \
		WASM_U8(0x42);          \
		WASM_I64((int64_t)(v)); \
	} while (0)
// `local.get N`
#define LG(n)                    \
	do {                         \
		WASM_U8(0x20);           \
		WASM_U32((uint32_t)(n)); \
	} while (0)
// `local.set N`
#define LS(n)                    \
	do {                         \
		WASM_U8(0x21);           \
		WASM_U32((uint32_t)(n)); \
	} while (0)
// `local.tee N`
#define LT(n)                    \
	do {                         \
		WASM_U8(0x22);           \
		WASM_U32((uint32_t)(n)); \
	} while (0)
// `global.get N` / `global.set N`
#define GG(n)                    \
	do {                         \
		WASM_U8(0x23);           \
		WASM_U32((uint32_t)(n)); \
	} while (0)
#define GS(n)                    \
	do {                         \
		WASM_U8(0x24);           \
		WASM_U32((uint32_t)(n)); \
	} while (0)
// `block $type ()->()`
#define BLOCK_VOID()                \
	do {                            \
		WASM_U8_THUNK({0x02, 0x40}); \
	} while (0)
// `loop ()->()`
#define LOOP_VOID()                 \
	do {                            \
		WASM_U8_THUNK({0x03, 0x40}); \
	} while (0)
// `end`
#define END_BLK() WASM_U8(0x0b)
// `br N`, `br_if N`
#define BR(n)                    \
	do {                         \
		WASM_U8(0x0c);           \
		WASM_U32((uint32_t)(n)); \
	} while (0)
#define BR_IF(n)                 \
	do {                         \
		WASM_U8(0x0d);           \
		WASM_U32((uint32_t)(n)); \
	} while (0)

// Plain typed instructions used a lot
#define I64_ADD()       WASM_U8(0x7c)
#define I64_SUB()       WASM_U8(0x7d)
#define I64_MUL()       WASM_U8(0x7e)
#define I64_AND()       WASM_U8(0x83)
#define I64_OR()        WASM_U8(0x84)
#define I64_XOR()       WASM_U8(0x85)
#define I64_SHL()       WASM_U8(0x86)
#define I64_ROTL()      WASM_U8(0x89)
#define I64_ROTR()      WASM_U8(0x8a)
#define I64_EQZ()       WASM_U8(0x50)
#define I32_ADD()       WASM_U8(0x6a)
#define I32_SUB()       WASM_U8(0x6b)
#define I32_AND()       WASM_U8(0x71)
#define I32_XOR()       WASM_U8(0x73)
#define I32_SHL()       WASM_U8(0x74)
#define I32_SHR_U()     WASM_U8(0x76)
#define I32_EQZ()       WASM_U8(0x45)
#define I32_LT_U()      WASM_U8(0x49)
#define I32_WRAP_I64()  WASM_U8(0xa7)
#define I64_EXT_I32_U() WASM_U8(0xad)
#define I64_EXT_I32_S() WASM_U8(0xac)
// `select` untyped (numeric only — i64 ok, NOT v128)
#define SELECT_NUM() WASM_U8(0x1b)
// `select t*` with single type v128 → 0x1c 0x01 0x7b
#define SELECT_V128()                    \
	do {                                 \
		WASM_U8_THUNK({0x1c, 0x01, 0x7b}); \
	} while (0)

// load/store helpers. offset is uleb128 immediately after alignment byte.
// i64.load align=3 offset=$off
#define I64_LOAD_OFF(off)          \
	do {                           \
		WASM_U8(0x29);             \
		WASM_U8(3);                \
		WASM_U32((uint32_t)(off)); \
	} while (0)
// i64.store align=3 offset=$off
#define I64_STORE_OFF(off)         \
	do {                           \
		WASM_U8(0x37);             \
		WASM_U8(3);                \
		WASM_U32((uint32_t)(off)); \
	} while (0)
// i32.load align=2 offset=$off
#define I32_LOAD_OFF(off)          \
	do {                           \
		WASM_U8(0x28);             \
		WASM_U8(2);                \
		WASM_U32((uint32_t)(off)); \
	} while (0)
// i32.store align=2 offset=$off
#define I32_STORE_OFF(off)         \
	do {                           \
		WASM_U8(0x36);             \
		WASM_U8(2);                \
		WASM_U32((uint32_t)(off)); \
	} while (0)
// i32.load8_u align=0 offset=$off
#define I32_LOAD8U_OFF(off)        \
	do {                           \
		WASM_U8(0x2d);             \
		WASM_U8(0);                \
		WASM_U32((uint32_t)(off)); \
	} while (0)
// i64.load32_s align=2 offset=$off  (sign-extend 32→64)
#define I64_LOAD32S_OFF(off)       \
	do {                           \
		WASM_U8(0x34);             \
		WASM_U8(2);                \
		WASM_U32((uint32_t)(off)); \
	} while (0)
// i64.load32_u align=2 offset=$off
#define I64_LOAD32U_OFF(off)       \
	do {                           \
		WASM_U8(0x35);             \
		WASM_U8(2);                \
		WASM_U32((uint32_t)(off)); \
	} while (0)
// v128.load align=4 offset=$off
#define V128_LOAD_OFF(off)          \
	do {                            \
		WASM_U8_THUNK({0xfd, 0x00}); \
		WASM_U8(4);                 \
		WASM_U32((uint32_t)(off));  \
	} while (0)
// v128.store align=4 offset=$off
#define V128_STORE_OFF(off)         \
	do {                            \
		WASM_U8_THUNK({0xfd, 0x0b}); \
		WASM_U8(4);                 \
		WASM_U32((uint32_t)(off));  \
	} while (0)
// v128.load64_zero align=3 offset=$off
#define V128_LOAD64_ZERO_OFF(off)   \
	do {                            \
		WASM_U8_THUNK({0xfd, 0x5d}); \
		WASM_U8(3);                 \
		WASM_U32((uint32_t)(off));  \
	} while (0)
// i32.load8_u align=0 offset=$off  (alias)
// i32.const + i32.add pattern: `i32.const $base; LG; i32.add`
#define I32_BASE_PLUS_LOCAL(base, loc) \
	do {                               \
		WI32_CONST(base);              \
		LG(loc);                       \
		I32_ADD();                     \
	} while (0)

// ---------------- Register-by-index select trees (READS) ----------------
//
// All trees consume one i32 "index local" and leave the selected value on
// stack. For r-registers we use untyped `select`; for v128 (F/E/A) we use
// `select t* v128`.

// Read R(idx_local) → i64 on stack. 8-way select tree using bits 0/1/2 of
// the index byte. Bytes: ~37 bytes worst case.
// In V3 mode (g_emit_regs_in_mem): emit `(idx<<3) i64.load offset=r_file_base`
// instead — ~9 bytes, no select tree.
static uint32_t emit_select_r(int idx_local, uint8_t *buf) {
	THUNK_BEGIN;
	if (g_emit_regs_in_mem) {
		LG(idx_local);
		WI32_CONST(3);
		I32_SHL();
		I64_LOAD_OFF(g_r_file_base);
		THUNK_END;
	}
	// Pair (R7,R6) → first picks R7 if (idx&1)!=0, else R6
	LG(R(7));
	LG(R(6));
	LG(idx_local);
	WI32_CONST(1);
	I32_AND();
	SELECT_NUM();
	// Pair (R5,R4) → picks R5 if (idx&1)!=0, else R4
	LG(R(5));
	LG(R(4));
	LG(idx_local);
	WI32_CONST(1);
	I32_AND();
	SELECT_NUM();
	// Level-1: pair (above): want top one (R(4..5) pair) if (idx&2)!=0
	LG(idx_local);
	WI32_CONST(2);
	I32_AND();
	SELECT_NUM(); // → R(4..7) group
	// Pair (R3,R2)
	LG(R(3));
	LG(R(2));
	LG(idx_local);
	WI32_CONST(1);
	I32_AND();
	SELECT_NUM();
	// Pair (R1,R0)
	LG(R(1));
	LG(R(0));
	LG(idx_local);
	WI32_CONST(1);
	I32_AND();
	SELECT_NUM();
	// Level-1: pair (R(2..3), R(0..1))
	LG(idx_local);
	WI32_CONST(2);
	I32_AND();
	SELECT_NUM(); // → R(0..3) group
	// Level-2: pair (R(4..7), R(0..3)) using bit 2
	LG(idx_local);
	WI32_CONST(4);
	I32_AND();
	SELECT_NUM(); // → R(idx)
	THUNK_END;
}

// Memory-mode v128 read: load F/E/A[idx_local] from vm_state.
//   Pattern: `(idx<<4) v128.load offset=g_r_file_base+bank_offset`.
static uint32_t emit_select_v128_mem(int idx_local, uint32_t bank_offset, uint8_t *buf) {
	THUNK_BEGIN;
	LG(idx_local);
	WI32_CONST(4);
	I32_SHL(); // idx * 16 (sizeof v128)
	V128_LOAD_OFF(g_r_file_base + bank_offset);
	THUNK_END;
}

// Read F(idx_local) → v128 on stack. 4-way select tree (bits 0,1 of idx).
// In split_id mode: emit a direct v128.load from vm_state F slot.
static uint32_t emit_select_f(int idx_local, uint8_t *buf) {
	THUNK_BEGIN;
	if (g_emit_split_id) {
		p += emit_select_v128_mem(idx_local, VM_F0_OFFSET, p);
		THUNK_END;
	}
	LG(F(3));
	LG(F(2));
	LG(idx_local);
	WI32_CONST(1);
	I32_AND();
	SELECT_V128();
	LG(F(1));
	LG(F(0));
	LG(idx_local);
	WI32_CONST(1);
	I32_AND();
	SELECT_V128();
	LG(idx_local);
	WI32_CONST(2);
	I32_AND();
	SELECT_V128();
	THUNK_END;
}

static uint32_t emit_select_e(int idx_local, uint8_t *buf) {
	THUNK_BEGIN;
	if (g_emit_split_id) {
		p += emit_select_v128_mem(idx_local, VM_E0_OFFSET, p);
		THUNK_END;
	}
	LG(E(3));
	LG(E(2));
	LG(idx_local);
	WI32_CONST(1);
	I32_AND();
	SELECT_V128();
	LG(E(1));
	LG(E(0));
	LG(idx_local);
	WI32_CONST(1);
	I32_AND();
	SELECT_V128();
	LG(idx_local);
	WI32_CONST(2);
	I32_AND();
	SELECT_V128();
	THUNK_END;
}

static uint32_t emit_select_a(int idx_local, uint8_t *buf) {
	THUNK_BEGIN;
	if (g_emit_split_id) {
		p += emit_select_v128_mem(idx_local, VM_A0_OFFSET, p);
		THUNK_END;
	}
	LG(A(3));
	LG(A(2));
	LG(idx_local);
	WI32_CONST(1);
	I32_AND();
	SELECT_V128();
	LG(A(1));
	LG(A(0));
	LG(idx_local);
	WI32_CONST(1);
	I32_AND();
	SELECT_V128();
	LG(idx_local);
	WI32_CONST(2);
	I32_AND();
	SELECT_V128();
	THUNK_END;
}

// ---------------- Register-by-index WRITES (br_table dispatch) ----------------
//
// Consumes the value on stack and writes to the indexed register. Uses
// br_table to jump to one of 8/4 sub-arms. The value is saved to a temp
// local first because each sub-arm needs to re-push it.

// Write i64 on top of stack to R(idx_local). Uses LOC_tmp64.
// In V3 mode: emit `LS(tmp64); (idx<<3) LG(tmp64) i64.store offset=r_file_base`
// instead of the 9-block br_table.
static uint32_t emit_store_r_i64(int idx_local, uint8_t *buf) {
	THUNK_BEGIN;
	LS(LOC_tmp64);
	if (g_emit_regs_in_mem) {
		LG(idx_local);
		WI32_CONST(3);
		I32_SHL();
		LG(LOC_tmp64);
		I64_STORE_OFF(g_r_file_base);
		THUNK_END;
	}
	// 9 nested blocks: 1 outer "end" + 8 arm blocks (one per dst index)
	BLOCK_VOID();
	BLOCK_VOID();
	BLOCK_VOID();
	BLOCK_VOID();
	BLOCK_VOID();
	BLOCK_VOID();
	BLOCK_VOID();
	BLOCK_VOID();
	BLOCK_VOID();
	// br_table on idx_local: labels 0..7 → R(0..7); label 8 → end
	LG(idx_local);
	WASM_U8(0x0e); // br_table opcode
	WASM_U32(8);   // count (labels for 0..7, default is label 8)
	for (int i = 0; i < 8; i++)
		WASM_U32((uint32_t)i);
	WASM_U32(8); // default → end
	// arm bodies. Each closes one block; from inside arm-i body we still
	// have (7-i + 1) blocks open (arm_{i+1}..arm_7 plus the outer end-block),
	// so `br (7-i)` jumps to the outer "end".
	for (int i = 0; i < 8; i++) {
		END_BLK();             // closes arm_i
		LG(LOC_tmp64);         // re-push the value
		LS(R(i));              // local.set R(i)
		BR((uint32_t)(7 - i)); // jump to end of outermost block
	}
	END_BLK(); // closes the outer "end" block
	THUNK_END;
}

// Write v128 on top of stack to F/E/A(idx_local) (4-way br_table).
// In split_id mode: emit a direct v128.store to vm_state F/E/A slot using
// LOCT_v128_scratch as scratch. target_base must be F(0), E(0), or A(0).
static uint32_t emit_store_v128_at(int target_base /* F(0) / E(0) / A(0) */, int idx_local,
                                   uint8_t *buf) {
	THUNK_BEGIN;
	if (g_emit_split_id) {
		// Map locals-style base to a vm_state offset. (We never store to A,
		// but keep parity with the locals path: A(0) maps to VM_A0_OFFSET.)
		uint32_t bank_offset = (target_base == F(0))   ? VM_F0_OFFSET
		                       : (target_base == E(0)) ? VM_E0_OFFSET
		                                               : VM_A0_OFFSET;
		LS(LOCT_v128_scratch); // stash v128 value
		LG(idx_local);
		WI32_CONST(4);
		I32_SHL();             // idx * 16
		LG(LOCT_v128_scratch); // re-push value
		V128_STORE_OFF(g_r_file_base + bank_offset);
		THUNK_END;
	}
	WASM_U8_THUNK({0x21, LOCT_v128_scratch}); // local.set 39
	// 5 nested blocks: 1 outer end + 4 arms
	BLOCK_VOID();
	BLOCK_VOID();
	BLOCK_VOID();
	BLOCK_VOID();
	BLOCK_VOID();
	LG(idx_local);
	WASM_U8(0x0e); // br_table
	WASM_U32(4);   // 4 entries
	for (int i = 0; i < 4; i++)
		WASM_U32((uint32_t)i);
	WASM_U32(4); // default
	for (int i = 0; i < 4; i++) {
		END_BLK();
		WASM_U8_THUNK({0x20, LOCT_v128_scratch}); // local.get 39
		WASM_U8_THUNK({0x21});                   // local.set (one byte)
		WASM_U32((uint32_t)(target_base + i));   // local index
		BR((uint32_t)(3 - i));
	}
	END_BLK();
	THUNK_END;
}

// ---------------- Scratchpad helpers ----------------
//
// Compute a scratchpad address (as i32) for L1/L2/L3 access patterns
// matching the existing wasm_jit_inst.c macros, but with dst/src/imm
// loaded at runtime from the decoded record.
//
// All leave a single i32 (absolute address in linear memory) on stack.

// L1/L2 address: (imm32 + r[src]) & mask + scratchpad_base
// mask is L1 if flags bit 2 set, else L2.
static uint32_t emit_addr_l1l2(uint32_t scratchpad_base, uint8_t *buf) {
	THUNK_BEGIN;
	LG(LOCT_inst_ptr);
	I64_LOAD32S_OFF(D_IMM32);
	p += emit_select_r(LOCT_src_byte, p);
	I64_ADD();
	I32_WRAP_I64();
	WI32_CONST(SCRATCHPAD_L1_MASK);
	WI32_CONST(SCRATCHPAD_L2_MASK);
	LG(LOCT_inst_ptr);
	I32_LOAD8U_OFF(D_FLAGS);
	WI32_CONST(0x04);
	I32_AND();
	SELECT_NUM();
	I32_AND();
	WI32_CONST(scratchpad_base);
	I32_ADD();
	THUNK_END;
}

// L3 direct address: (imm32) & L3_MASK + scratchpad_base
static uint32_t emit_addr_l3_direct(uint32_t scratchpad_base, uint8_t *buf) {
	THUNK_BEGIN;
	LG(LOCT_inst_ptr);
	I64_LOAD32S_OFF(D_IMM32);
	I32_WRAP_I64();
	WI32_CONST(SCRATCHPAD_L3_MASK);
	I32_AND();
	WI32_CONST(scratchpad_base);
	I32_ADD();
	THUNK_END;
}


// ---------------- Stub function bodies (same as static module) ----------------
//
// Emit the 22 stub function bodies in the order required by the function
// section. Adapted from wasm_jit_gen.c::emit_function_bodies.

static uint32_t emit_stub_bodies(int jit_feature, uint8_t *buf) {
	THUNK_BEGIN;
	WASM_U32_WITH_STUB(STUB_MUL128HI);
	WASM_U32_WITH_STUB(STUB_IMUL128HI);
	WASM_U32_WITH_STUB(STUB_FADD_0);
	WASM_U32_WITH_STUB(STUB_FADD_1);
	WASM_U32_WITH_STUB(STUB_FADD_2);
	WASM_U32_WITH_STUB(STUB_FADD_3);
	WASM_U32_WITH_STUB(STUB_FSUB_0);
	WASM_U32_WITH_STUB(STUB_FSUB_1);
	WASM_U32_WITH_STUB(STUB_FSUB_2);
	WASM_U32_WITH_STUB(STUB_FSUB_3);
	WASM_U32_WITH_STUB(STUB_FMUL_0);
	if (jit_feature & RXJIT_FEATURE_FMA) {
		WASM_U32_WITH_STUB(STUB_FMUL_FMA_1);
		WASM_U32_WITH_STUB(STUB_FMUL_FMA_2);
		WASM_U32_WITH_STUB(STUB_FMUL_FMA_3);
	} else {
		WASM_U32_WITH_STUB(STUB_FMUL_1);
		WASM_U32_WITH_STUB(STUB_FMUL_2);
		WASM_U32_WITH_STUB(STUB_FMUL_3);
	}
	WASM_U32_WITH_STUB(STUB_FDIV_0);
	if (jit_feature & RXJIT_FEATURE_FMA) {
		WASM_U32_WITH_STUB(STUB_FDIV_FMA_1);
		WASM_U32_WITH_STUB(STUB_FDIV_FMA_2);
		WASM_U32_WITH_STUB(STUB_FDIV_FMA_3);
	} else {
		WASM_U32_WITH_STUB(STUB_FDIV_1);
		WASM_U32_WITH_STUB(STUB_FDIV_2);
		WASM_U32_WITH_STUB(STUB_FDIV_3);
	}
	WASM_U32_WITH_STUB(STUB_FSQRT_0);
	if (jit_feature & RXJIT_FEATURE_FMA) {
		WASM_U32_WITH_STUB(STUB_FSQRT_FMA_1);
		WASM_U32_WITH_STUB(STUB_FSQRT_FMA_2);
		WASM_U32_WITH_STUB(STUB_FSQRT_FMA_3);
	} else {
		WASM_U32_WITH_STUB(STUB_FSQRT_1);
		WASM_U32_WITH_STUB(STUB_FSQRT_2);
		WASM_U32_WITH_STUB(STUB_FSQRT_3);
	}
	THUNK_END;
}

// ---------------- Prologue / outer-step / epilogue emitters ----------------

// Emit `i32.const $vm_state_ptr; local.set $LOC_tmp` (so subsequent loads
// can use `local.get $LOC_tmp` + i64.load offset=$N to read fields).
static uint32_t emit_vm_ptr_to_tmp(uint32_t vm_state_ptr, uint8_t *buf) {
	THUNK_BEGIN;
	WI32_CONST(vm_state_ptr);
	LS(LOC_tmp);
	THUNK_END;
}

// Prologue: load r/f/e/a/emask/mmask/fprc/ma/mx/read_regs/ds_ptr from vm_state.
// V3 mode: skip the r-load entirely — r-touching emitters read r[i] directly
// from linear memory at every access.
static uint32_t emit_prologue(uint32_t vm_state_ptr, uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_vm_ptr_to_tmp(vm_state_ptr, p);

	// r[0..7]
	if (!g_emit_regs_in_mem) {
		for (int i = 0; i < 8; i++) {
			LG(LOC_tmp);
			I64_LOAD_OFF(VM_R0_OFFSET + i * 8);
			LS(R(i));
		}
	}
	// f/e/a v128 each — split_id mode keeps them in vm_state throughout.
	if (!g_emit_split_id) {
		for (int i = 0; i < 4; i++) {
			LG(LOC_tmp);
			V128_LOAD_OFF(VM_F0_OFFSET + i * 16);
			LS(F(i));
		}
		for (int i = 0; i < 4; i++) {
			LG(LOC_tmp);
			V128_LOAD_OFF(VM_E0_OFFSET + i * 16);
			LS(E(i));
		}
		for (int i = 0; i < 4; i++) {
			LG(LOC_tmp);
			V128_LOAD_OFF(VM_A0_OFFSET + i * 16);
			LS(A(i));
		}
	}
	// emask (i.e. mask_exp), mmask (mask_mant)
	LG(LOC_tmp);
	V128_LOAD_OFF(VM_EMASK_OFFSET);
	LS(LOC_mask_exp);
	LG(LOC_tmp);
	V128_LOAD_OFF(VM_MMASK_OFFSET);
	LS(LOC_mask_mant);
	// fprc → global
	LG(LOC_tmp);
	I32_LOAD_OFF(VM_FPRC_OFFSET);
	GS(TGLOB_fprc);
	// ma and sp_addr1 (mem.ma / spAddr1 from RandomX execute)
	LG(LOC_tmp);
	I32_LOAD_OFF(VM_MA_OFFSET);
	LT(LOC_ma);
	LS(LOC_sp_addr1);
	// mx and sp_addr0
	LG(LOC_tmp);
	I32_LOAD_OFF(VM_MX_OFFSET);
	LT(LOC_mx);
	LS(LOC_sp_addr0);
	// read_regs (4 bytes at +304)
	LG(LOC_tmp);
	I32_LOAD8U_OFF(VM_READ_REGS_OFFSET + 0);
	LS(LOCT_rr0);
	LG(LOC_tmp);
	I32_LOAD8U_OFF(VM_READ_REGS_OFFSET + 1);
	LS(LOCT_rr1);
	LG(LOC_tmp);
	I32_LOAD8U_OFF(VM_READ_REGS_OFFSET + 2);
	LS(LOCT_rr2);
	LG(LOC_tmp);
	I32_LOAD8U_OFF(VM_READ_REGS_OFFSET + 3);
	LS(LOCT_rr3);
	// dataset_ptr (already base+offset, written by C side)
	LG(LOC_tmp);
	I32_LOAD_OFF(VM_DS_PTR_OFFSET);
	LS(LOCT_ds_ptr);
	THUNK_END;
}

// Epilogue: store r/f/e/fprc back to vm_state.
// V3 mode: r[] is already live in vm_state's memory throughout execution; skip.
static uint32_t emit_epilogue(uint32_t vm_state_ptr, uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_vm_ptr_to_tmp(vm_state_ptr, p);
	if (!g_emit_regs_in_mem) {
		for (int i = 0; i < 8; i++) {
			LG(LOC_tmp);
			LG(R(i));
			I64_STORE_OFF(VM_R0_OFFSET + i * 8);
		}
	}
	// split_id mode: F/E live in vm_state throughout, no store needed.
	if (!g_emit_split_id) {
		for (int i = 0; i < 4; i++) {
			LG(LOC_tmp);
			LG(F(i));
			V128_STORE_OFF(VM_F0_OFFSET + i * 16);
		}
		for (int i = 0; i < 4; i++) {
			LG(LOC_tmp);
			LG(E(i));
			V128_STORE_OFF(VM_E0_OFFSET + i * 16);
		}
	}
	// fprc back
	LG(LOC_tmp);
	GG(TGLOB_fprc);
	I32_STORE_OFF(VM_FPRC_OFFSET);
	THUNK_END;
}

// ---------------- Forward decl of arm emitters & main_loop body ----------------

static uint32_t emit_main_loop_body(uint32_t vm_state_ptr, uint32_t scratchpad_ptr,
                                    uint32_t dataset_base /* unused — uses LOCT_ds_ptr */,
                                    uint32_t program_slot_ptr, int jit_feature, uint8_t *buf);
static uint32_t emit_inner_dispatch(uint32_t scratchpad_ptr, int jit_feature, uint8_t *buf);
static uint32_t emit_inner_pc_loop(uint32_t scratchpad_ptr, uint32_t program_slot_ptr,
                                   int jit_feature, uint8_t *buf);
static uint32_t emit_inner_dispatch_fn(uint32_t vm_state_ptr, uint32_t scratchpad_ptr,
                                       uint32_t program_slot_ptr, int jit_feature, uint8_t *buf);
static uint32_t emit_local_decls(uint8_t *buf);

// ---------------- Step 1 / 2 / 3 / 5-13 emitters ----------------

// Step 1: sp_mix = r[rr0] ^ r[rr1]
//         sp_addr0 = (sp_addr0 ^ low32(sp_mix)) & L3_MASK_64
//         sp_addr1 = (sp_addr1 ^ high32(sp_mix)) & L3_MASK_64
static uint32_t emit_step1_sp_mix(uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_select_r(LOCT_rr0, p);
	p += emit_select_r(LOCT_rr1, p);
	I64_XOR();
	LS(LOC_tmp64);

	// sp_addr0
	LG(LOC_tmp64);
	I32_WRAP_I64();
	LG(LOC_sp_addr0);
	I32_XOR();
	WI32_CONST(SCRATCHPAD_L3_MASK_64);
	I32_AND();
	LS(LOC_sp_addr0);

	// sp_addr1
	LG(LOC_tmp64);
	WI64_CONST(32);
	WASM_U8(0x88); /* i64.shr_u */
	I32_WRAP_I64();
	LG(LOC_sp_addr1);
	I32_XOR();
	WI32_CONST(SCRATCHPAD_L3_MASK_64);
	I32_AND();
	LS(LOC_sp_addr1);
	THUNK_END;
}

// Step 2: r[i] ^= scratchpad[sp_addr0 + i*8] for i in 0..7
//   V3 mode: r[i] lives at offset (r_file_base + i*8) in linear memory;
//   read/xor/write directly with no scratch local. The compile-time-known
//   index means each access uses a constant offset (no i32.shl).
static uint32_t emit_step2_xor_r(uint32_t scratchpad_ptr, uint8_t *buf) {
	THUNK_BEGIN;
	// LOC_tmp = scratchpad + sp_addr0
	WI32_CONST(scratchpad_ptr);
	LG(LOC_sp_addr0);
	I32_ADD();
	LS(LOC_tmp);
	if (g_emit_regs_in_mem) {
		for (int i = 0; i < 8; i++) {
			// Stack: addr=0 (for store) ; sp[i] ; r[i] → xor → r[i]^sp[i]
			//        i64.store pops (i32 addr, i64 value).
			WI32_CONST(0);
			LG(LOC_tmp);
			I64_LOAD_OFF((uint32_t)(i * 8));
			WI32_CONST(0);
			I64_LOAD_OFF(g_r_file_base + (uint32_t)(i * 8));
			I64_XOR();
			I64_STORE_OFF(g_r_file_base + (uint32_t)(i * 8));
		}
	} else {
		for (int i = 0; i < 8; i++) {
			LG(LOC_tmp);
			I64_LOAD_OFF((uint32_t)(i * 8));
			LG(R(i));
			I64_XOR();
			LS(R(i));
		}
	}
	THUNK_END;
}

// Step 3: load F(0..3) from scratchpad[sp_addr1 + 0..24], load E(0..3) from +32..56
//   F(i) = f64x2 convert (load64_zero scratchpad[sp_addr1 + i*8])
//   E(i) = (F-like load) & mask_mant | mask_exp
// split_id mode: results land in vm_state F/E slots (memory) instead of locals.
static uint32_t emit_step3_load_fe(uint32_t scratchpad_ptr, uint8_t *buf) {
	THUNK_BEGIN;
	WI32_CONST(scratchpad_ptr);
	LG(LOC_sp_addr1);
	I32_ADD();
	LS(LOC_tmp);
	if (g_emit_split_id) {
		for (int i = 0; i < 4; i++) {
			WI32_CONST(0); // addr=0 for v128.store
			LG(LOC_tmp);
			V128_LOAD64_ZERO_OFF((uint32_t)(i * 8));
			WASM_U8_THUNK({0xfd, 0xfe, 0x01}); // f64x2.convert_low_i32x4_s
			V128_STORE_OFF(g_r_file_base + VM_F0_OFFSET + (uint32_t)(i * 16));
		}
		for (int i = 0; i < 4; i++) {
			WI32_CONST(0); // addr=0 for v128.store
			LG(LOC_tmp);
			V128_LOAD64_ZERO_OFF((uint32_t)(32 + i * 8));
			WASM_U8_THUNK({0xfd, 0xfe, 0x01}); // f64x2.convert_low_i32x4_s
			LG(LOC_mask_mant);
			WASM_U8_THUNK({0xfd, 0x4e}); // v128.and
			LG(LOC_mask_exp);
			WASM_U8_THUNK({0xfd, 0x50}); // v128.or
			V128_STORE_OFF(g_r_file_base + VM_E0_OFFSET + (uint32_t)(i * 16));
		}
		THUNK_END;
	}
	for (int i = 0; i < 4; i++) {
		LG(LOC_tmp);
		V128_LOAD64_ZERO_OFF((uint32_t)(i * 8));
		WASM_U8_THUNK({0xfd, 0xfe, 0x01}); // f64x2.convert_low_i32x4_s
		LS(F(i));
	}
	for (int i = 0; i < 4; i++) {
		LG(LOC_tmp);
		V128_LOAD64_ZERO_OFF((uint32_t)(32 + i * 8));
		WASM_U8_THUNK({0xfd, 0xfe, 0x01}); // f64x2.convert_low_i32x4_s
		LG(LOC_mask_mant);
		WASM_U8_THUNK({0xfd, 0x4e}); // v128.and
		LG(LOC_mask_exp);
		WASM_U8_THUNK({0xfd, 0x50}); // v128.or
		LS(E(i));
	}
	THUNK_END;
}

// Step 5: mx ^= (r[rr2] ^ r[rr3]).low32; mx &= CACHE_LINE_MASK
static uint32_t emit_step5_mx_xor(uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_select_r(LOCT_rr2, p);
	p += emit_select_r(LOCT_rr3, p);
	I64_XOR();
	I32_WRAP_I64();
	LG(LOC_mx);
	I32_XOR();
	WI32_CONST((int32_t)CACHE_LINE_MASK);
	I32_AND();
	LS(LOC_mx);
	THUNK_END;
}

// Step 7: r[i] ^= dataset[LOCT_ds_ptr + ma + i*8] for i in 0..7
//   V3 mode: same direct-memory pattern as step 2 (compile-time index).
static uint32_t emit_step7_dataset_xor(uint8_t *buf) {
	THUNK_BEGIN;
	LG(LOCT_ds_ptr);
	LG(LOC_ma);
	I32_ADD();
	LS(LOC_tmp);
	if (g_emit_regs_in_mem) {
		for (int i = 0; i < 8; i++) {
			WI32_CONST(0);
			LG(LOC_tmp);
			I64_LOAD_OFF((uint32_t)(i * 8));
			WI32_CONST(0);
			I64_LOAD_OFF(g_r_file_base + (uint32_t)(i * 8));
			I64_XOR();
			I64_STORE_OFF(g_r_file_base + (uint32_t)(i * 8));
		}
	} else {
		for (int i = 0; i < 8; i++) {
			LG(LOC_tmp);
			I64_LOAD_OFF((uint32_t)(i * 8));
			LG(R(i));
			I64_XOR();
			LS(R(i));
		}
	}
	THUNK_END;
}

// Step 8: swap mx, ma
static uint32_t emit_step8_swap_mx_ma(uint8_t *buf) {
	THUNK_BEGIN;
	LG(LOC_mx);
	LG(LOC_ma);
	LS(LOC_mx);
	LS(LOC_ma);
	THUNK_END;
}

// Step 9: store r[0..7] to scratchpad[sp_addr1 + i*8]
//   V3 mode: r[i] loaded from linear memory; scratchpad store unchanged.
static uint32_t emit_step9_store_r(uint32_t scratchpad_ptr, uint8_t *buf) {
	THUNK_BEGIN;
	WI32_CONST(scratchpad_ptr);
	LG(LOC_sp_addr1);
	I32_ADD();
	LS(LOC_tmp);
	if (g_emit_regs_in_mem) {
		for (int i = 0; i < 8; i++) {
			LG(LOC_tmp);
			WI32_CONST(0);
			I64_LOAD_OFF(g_r_file_base + (uint32_t)(i * 8));
			I64_STORE_OFF((uint32_t)(i * 8));
		}
	} else {
		for (int i = 0; i < 8; i++) {
			LG(LOC_tmp);
			LG(R(i));
			I64_STORE_OFF((uint32_t)(i * 8));
		}
	}
	THUNK_END;
}

// Step 10: f[i] ^= e[i]   (v128.xor)
// split_id mode: read/write F/E via vm_state slots.
static uint32_t emit_step10_f_xor_e(uint8_t *buf) {
	THUNK_BEGIN;
	if (g_emit_split_id) {
		for (int i = 0; i < 4; i++) {
			WI32_CONST(0); // addr=0 for store
			WI32_CONST(0);
			V128_LOAD_OFF(g_r_file_base + VM_F0_OFFSET + (uint32_t)(i * 16));
			WI32_CONST(0);
			V128_LOAD_OFF(g_r_file_base + VM_E0_OFFSET + (uint32_t)(i * 16));
			WASM_U8_THUNK({0xfd, 0x51}); // v128.xor
			V128_STORE_OFF(g_r_file_base + VM_F0_OFFSET + (uint32_t)(i * 16));
		}
		THUNK_END;
	}
	for (int i = 0; i < 4; i++) {
		LG(F(i));
		LG(E(i));
		WASM_U8_THUNK({0xfd, 0x51}); // v128.xor
		LS(F(i));
	}
	THUNK_END;
}

// Step 11: store f[0..3] to scratchpad[sp_addr0 + i*16] (v128 = 16 bytes)
// split_id mode: read F[i] from vm_state slot.
static uint32_t emit_step11_store_f(uint32_t scratchpad_ptr, uint8_t *buf) {
	THUNK_BEGIN;
	WI32_CONST(scratchpad_ptr);
	LG(LOC_sp_addr0);
	I32_ADD();
	LS(LOC_tmp);
	if (g_emit_split_id) {
		for (int i = 0; i < 4; i++) {
			LG(LOC_tmp);
			WI32_CONST(0);
			V128_LOAD_OFF(g_r_file_base + VM_F0_OFFSET + (uint32_t)(i * 16));
			V128_STORE_OFF((uint32_t)(i * 16));
		}
		THUNK_END;
	}
	for (int i = 0; i < 4; i++) {
		LG(LOC_tmp);
		LG(F(i));
		V128_STORE_OFF((uint32_t)(i * 16));
	}
	THUNK_END;
}

// Step 12: sp_addr0 = sp_addr1 = 0
static uint32_t emit_step12_clear_sp(uint8_t *buf) {
	THUNK_BEGIN;
	WI32_CONST(0);
	LS(LOC_sp_addr0);
	WI32_CONST(0);
	LS(LOC_sp_addr1);
	THUNK_END;
}

// Inner pc loop body (without surrounding function envelope). Shared between
// the inline path (main_loop directly contains this when split_id is off) and
// the standalone-function path (emit_inner_dispatch_fn wraps this with a
// function header/locals decl/end).
static uint32_t emit_inner_pc_loop(uint32_t scratchpad_ptr, uint32_t program_slot_ptr,
                                   int jit_feature, uint8_t *buf) {
	THUNK_BEGIN;
	WI32_CONST(0);
	LS(LOCT_pc);
	LOOP_VOID();
	{
		// inst_ptr = program_slot + (pc << 4)
		WI32_CONST(program_slot_ptr);
		LG(LOCT_pc);
		WI32_CONST(4);
		I32_SHL();
		I32_ADD();
		LS(LOCT_inst_ptr);

		// preload dst_byte / src_byte
		LG(LOCT_inst_ptr);
		I32_LOAD8U_OFF(D_DST);
		LS(LOCT_dst_byte);
		LG(LOCT_inst_ptr);
		I32_LOAD8U_OFF(D_SRC);
		LS(LOCT_src_byte);

		// dispatch via br_table over opcode_kind
		p += emit_inner_dispatch(scratchpad_ptr, jit_feature, p);

		// pc++ then continue if pc < 256
		LG(LOCT_pc);
		WI32_CONST(1);
		I32_ADD();
		LT(LOCT_pc);
		WI32_CONST(256);
		I32_LT_U();
		BR_IF(0); // continue inner loop
	}
	END_BLK(); // end of inner loop
	THUNK_END;
}

// Emit the locals declaration shared between main_loop and inner_dispatch
// (split_id mode). Indices match wasm_jit_inst_locals.h + the LOCT_* extension.
static uint32_t emit_local_decls(uint8_t *buf) {
	THUNK_BEGIN;
	WASM_U8_THUNK({
		11,                                 // 11 local groups
		8,  WASM_TYPE_I64,                  // R(0..7) (unused if regs_in_mem)
		12, WASM_TYPE_V128,                 // F/E/A (unused if split_id)
		6,  WASM_TYPE_I32,                  // sp_addr0/1, mx, ma, tmp, ic
		1,  WASM_TYPE_I64,                  // tmp64
		2,  WASM_TYPE_V128,                 // mask_mant, mask_exp
		9,  WASM_TYPE_I32,                  // threaded i32 locals (inst_ptr/pc/...)
		1,  WASM_TYPE_I64,                  // tmp64_b
		1,  WASM_TYPE_V128,                 // v128_scratch
		4,  WASM_TYPE_I64,                  // 40..43 LOCT_m0..m3
		12, WASM_TYPE_V128,                 // 44..55 LOCT_fa..fs, LOCT_mTEG..mKON
		3,  WASM_TYPE_I32,                  // 56..58 LOCT_rmoff, spb, spare
	});
	THUNK_END;
}

// inner_dispatch standalone function body (split_id mode).
//   - Sets LOC_tmp = vm_state_ptr (used by mask loads & step-style helpers).
//   - Loads mask_mant / mask_exp from vm_state into locals (so K_FDIV_M's
//     LG(LOC_mask_mant) keeps working without main_loop's prologue).
//   - Runs the inner pc loop (256 iterations × 44-arm br_table).
// Function type: () -> (). State all lives in vm_state via the V3-extended
// memory layout.
static uint32_t emit_inner_dispatch_fn(uint32_t vm_state_ptr, uint32_t scratchpad_ptr,
                                       uint32_t program_slot_ptr, int jit_feature, uint8_t *buf) {
	THUNK_BEGIN;
	// Debug layout-pad knob (feature bits 256..1024): n dummy i32 stores into
	// the arena's pad area, each ~3 ARM64 instructions, shifting all code
	// that follows. Used to average A/B measurements over code layouts.
	{
		int pad = (jit_feature >> RXJIT_FEATURE_PAD_SHIFT) & 7;
		for (int i = 0; i < pad; i++) {
			WI32_CONST(0);
			WI32_CONST(0);
			I32_STORE_OFF(vm_state_ptr + RXJIT_ARENA_PAD_OFF + 4 * i);
		}
	}
	// vm_state pointer in LOC_tmp; many arms expect this (K_FDIV_M loads mask
	// constants from it via the preloaded mask locals, but the addr load
	// helpers don't reference LOC_tmp directly — they use LOCT_inst_ptr).
	WI32_CONST(vm_state_ptr);
	LS(LOC_tmp);
	// Preload v128 mask constants (used by K_FDIV_M arm).
	LG(LOC_tmp);
	V128_LOAD_OFF(VM_EMASK_OFFSET);
	LS(LOC_mask_exp);
	LG(LOC_tmp);
	V128_LOAD_OFF(VM_MMASK_OFFSET);
	LS(LOC_mask_mant);
	// Run the pc loop.
	p += emit_inner_pc_loop(scratchpad_ptr, program_slot_ptr, jit_feature, p);
	THUNK_END;
}

// ---------------- main_loop body ----------------

static uint32_t emit_main_loop_body(uint32_t vm_state_ptr, uint32_t scratchpad_ptr,
                                    uint32_t dataset_base, uint32_t program_slot_ptr,
                                    int jit_feature, uint8_t *buf) {
	(void)dataset_base;     // unused — comes from LOCT_ds_ptr (set in prologue)
	(void)program_slot_ptr; // consumed in emit_inner_dispatch
	THUNK_BEGIN;

	p += emit_prologue(vm_state_ptr, p);

	// $ic = RANDOMX_PROGRAM_ITERATIONS
	WI32_CONST(RANDOMX_PROGRAM_ITERATIONS);
	LS(LOC_ic);

	// outer loop
	LOOP_VOID();
	{
		p += emit_step1_sp_mix(p);
		p += emit_step2_xor_r(scratchpad_ptr, p);
		p += emit_step3_load_fe(scratchpad_ptr, p);

		// step 4: INNER dispatch loop
		if (g_emit_split_id) {
			// Extracted as its own wasm function so JSC can OMG it
			// independently of main_loop (which is too large to tier up).
			WASM_U8(0x10);
			WASM_U32(TFN_INNER_DISPATCH);
		} else {
			p += emit_inner_pc_loop(scratchpad_ptr, program_slot_ptr, jit_feature, p);
		}

		p += emit_step5_mx_xor(p);
		// step 6: prefetch — wasm has no prefetch, skipped
		p += emit_step7_dataset_xor(p);
		p += emit_step8_swap_mx_ma(p);
		p += emit_step9_store_r(scratchpad_ptr, p);
		p += emit_step10_f_xor_e(p);
		p += emit_step11_store_f(scratchpad_ptr, p);
		p += emit_step12_clear_sp(p);

		// step 13: ic--; loop while ic != 0
		LG(LOC_ic);
		WI32_CONST(1);
		I32_SUB();
		LT(LOC_ic);
		BR_IF(0); // continue outer loop while ic != 0
	}
	END_BLK(); // end of outer loop

	p += emit_epilogue(vm_state_ptr, p);

	THUNK_END;
}

// ---------------- Inner dispatch (br_table + all arm bodies) ----------------
//
// Layout: nested blocks for K_COUNT arms + one outer $end_dispatch block.
// br_table jumps to the correct arm. Each arm ends with `br N` to escape
// to $end_dispatch (or `br N+1` for CBRANCH to escape to the inner loop).
//
// Counters in the helpers below:
//   K_COUNT     = number of arms (44)
//   For arm at handler-position-index k (0..43): br depth to $end_dispatch
//     is (K_COUNT - 1 - k) = (43 - k).
//   For CBRANCH only: br depth to $inner is (K_COUNT - k) = (44 - k).

// BR depth from arm_k handler back to the wrapping blocks.
//
// We open 1 $end_dispatch + K_COUNT arm blocks (K_COUNT+1 total). After
// END(arm_k), the still-open blocks are arm_{k+1}..arm_{K_COUNT-1} plus
// $end_dispatch — that's (K_COUNT - k) blocks. $end_dispatch is the
// outermost, at BR depth K_COUNT - k - 1. $inner sits one further out
// (K_COUNT - k).
#define ARM_BR_END(k)   ((uint32_t)(RXJIT_K_COUNT - (k) - 1))
#define ARM_BR_INNER(k) ((uint32_t)(RXJIT_K_COUNT - (k)))

// ---------------- Individual arm emitters ----------------

// All take: scratchpad_ptr, jit_feature, k (kind index, for BR depth).
// They write to *p in their caller.

// K_NOP: just exit
static uint32_t emit_arm_nop(int k, uint8_t *buf) {
	THUNK_BEGIN;
	BR(ARM_BR_END(k));
	THUNK_END;
}

// K_IADD_RS: r[dst] = r[dst] + (r[src] << shift)
//   shift = flags & 3
static uint32_t emit_arm_iadd_rs(int k, uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_select_r(LOCT_dst_byte, p);
	p += emit_select_r(LOCT_src_byte, p);
	LG(LOCT_inst_ptr);
	I32_LOAD8U_OFF(D_FLAGS);
	WI32_CONST(0x03);
	I32_AND();
	I64_EXT_I32_U();
	I64_SHL();
	I64_ADD();
	p += emit_store_r_i64(LOCT_dst_byte, p);
	BR(ARM_BR_END(k));
	THUNK_END;
}

// K_IADD_RS_DISPL: r[dst] = r[dst] + (r[src] << shift) + sext(imm32)
static uint32_t emit_arm_iadd_rs_displ(int k, uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_select_r(LOCT_dst_byte, p);
	p += emit_select_r(LOCT_src_byte, p);
	LG(LOCT_inst_ptr);
	I32_LOAD8U_OFF(D_FLAGS);
	WI32_CONST(0x03);
	I32_AND();
	I64_EXT_I32_U();
	I64_SHL();
	I64_ADD();
	LG(LOCT_inst_ptr);
	I64_LOAD32S_OFF(D_IMM32);
	I64_ADD();
	p += emit_store_r_i64(LOCT_dst_byte, p);
	BR(ARM_BR_END(k));
	THUNK_END;
}

// Generic "r[dst] = r[dst] OP scratchpad[L1/L2 addr]" memory load arm
static uint32_t emit_arm_alu_mem_l1l2(uint32_t scratchpad_ptr, uint8_t op, int k, uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_select_r(LOCT_dst_byte, p);
	p += emit_addr_l1l2(scratchpad_ptr, p);
	I64_LOAD_OFF(0);
	WASM_U8(op);
	p += emit_store_r_i64(LOCT_dst_byte, p);
	BR(ARM_BR_END(k));
	THUNK_END;
}

// Generic "r[dst] = r[dst] OP scratchpad[L3 direct addr]" memory load arm
static uint32_t emit_arm_alu_mem_l3(uint32_t scratchpad_ptr, uint8_t op, int k, uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_select_r(LOCT_dst_byte, p);
	p += emit_addr_l3_direct(scratchpad_ptr, p);
	I64_LOAD_OFF(0);
	WASM_U8(op);
	p += emit_store_r_i64(LOCT_dst_byte, p);
	BR(ARM_BR_END(k));
	THUNK_END;
}

// K_ISUB_R, K_IMUL_R, K_IXOR_R, K_IROR_R, K_IROL_R: r[dst] = r[dst] OP r[src]
static uint32_t emit_arm_alu_rr(uint8_t op, int k, uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_select_r(LOCT_dst_byte, p);
	p += emit_select_r(LOCT_src_byte, p);
	WASM_U8(op);
	p += emit_store_r_i64(LOCT_dst_byte, p);
	BR(ARM_BR_END(k));
	THUNK_END;
}

// *_IMM variant: r[dst] = r[dst] OP sext(imm32)
static uint32_t emit_arm_alu_imm(uint8_t op, int k, uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_select_r(LOCT_dst_byte, p);
	LG(LOCT_inst_ptr);
	I64_LOAD32S_OFF(D_IMM32);
	WASM_U8(op);
	p += emit_store_r_i64(LOCT_dst_byte, p);
	BR(ARM_BR_END(k));
	THUNK_END;
}

// K_IMULH_R / K_ISMULH_R: r[dst] = mulh(r[dst], r[src])
static uint32_t emit_arm_mulh_r(uint32_t fn_idx, int k, uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_select_r(LOCT_dst_byte, p);
	p += emit_select_r(LOCT_src_byte, p);
	WASM_U8(0x10);
	WASM_U32(fn_idx); // call <fn>
	p += emit_store_r_i64(LOCT_dst_byte, p);
	BR(ARM_BR_END(k));
	THUNK_END;
}

// K_IMULH_M_RR / K_ISMULH_M_RR: r[dst] = mulh(r[dst], mem_l1l2_load)
static uint32_t emit_arm_mulh_m_rr(uint32_t scratchpad_ptr, uint32_t fn_idx, int k, uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_select_r(LOCT_dst_byte, p);
	p += emit_addr_l1l2(scratchpad_ptr, p);
	I64_LOAD_OFF(0);
	WASM_U8(0x10);
	WASM_U32(fn_idx);
	p += emit_store_r_i64(LOCT_dst_byte, p);
	BR(ARM_BR_END(k));
	THUNK_END;
}

// K_IMULH_M_DIRECT / K_ISMULH_M_DIRECT
static uint32_t emit_arm_mulh_m_direct(uint32_t scratchpad_ptr, uint32_t fn_idx, int k,
                                       uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_select_r(LOCT_dst_byte, p);
	p += emit_addr_l3_direct(scratchpad_ptr, p);
	I64_LOAD_OFF(0);
	WASM_U8(0x10);
	WASM_U32(fn_idx);
	p += emit_store_r_i64(LOCT_dst_byte, p);
	BR(ARM_BR_END(k));
	THUNK_END;
}

// K_IMUL_RCP: r[dst] = r[dst] * imm64 (precomputed reciprocal)
static uint32_t emit_arm_imul_rcp(int k, uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_select_r(LOCT_dst_byte, p);
	LG(LOCT_inst_ptr);
	I64_LOAD_OFF(D_IMM64);
	I64_MUL();
	p += emit_store_r_i64(LOCT_dst_byte, p);
	BR(ARM_BR_END(k));
	THUNK_END;
}

// K_INEG_R: r[dst] = -r[dst] = 0 - r[dst]
static uint32_t emit_arm_ineg_r(int k, uint8_t *buf) {
	THUNK_BEGIN;
	WI64_CONST(0);
	p += emit_select_r(LOCT_dst_byte, p);
	I64_SUB();
	p += emit_store_r_i64(LOCT_dst_byte, p);
	BR(ARM_BR_END(k));
	THUNK_END;
}

// K_ISWAP_R: swap r[dst], r[src]
//   tmp_d = r[dst]; tmp_s = r[src]
//   r[dst] = tmp_s; r[src] = tmp_d
// We need TWO i64 scratch locals (tmp64 used by store helper, tmp64_b for the
// second value). The store helper consumes its input from $tmp64.
static uint32_t emit_arm_iswap_r(int k, uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_select_r(LOCT_dst_byte, p);
	LS(LOCT_tmp64_b);                        // tmp_b = r[dst]
	p += emit_select_r(LOCT_src_byte, p);    // stack: r[src]
	p += emit_store_r_i64(LOCT_dst_byte, p); // r[dst] = r[src]
	LG(LOCT_tmp64_b);                        // stack: old r[dst]
	p += emit_store_r_i64(LOCT_src_byte, p); // r[src] = old r[dst]
	BR(ARM_BR_END(k));
	THUNK_END;
}

// K_FSWAP_R_F / K_FSWAP_R_E:
//   Take the v128 at F(dst) or E(dst), swap its two 64-bit halves, write back.
//   Encoding: local.get (selected reg)  ; v128.const (byte-shuffle indices)
//             ; i8x16.swizzle  (or i8x16.relaxed_swizzle when RELAXED_SIMD).
//   Matches existing wasm_jit_inst.c emit shape.
static uint32_t emit_arm_fswap_r_bank(int target_base, int k, int jit_feature, uint8_t *buf) {
	THUNK_BEGIN;
	if (target_base == F(0))
		p += emit_select_f(LOCT_dst_byte, p);
	else
		p += emit_select_e(LOCT_dst_byte, p);
	// v128.const i8x16 [8..15, 0..7] — the swizzle indices that swap halves.
	WASM_U8_THUNK({
		0xfd, 0x0c,
		8, 9, 10, 11, 12, 13, 14, 15,
		0, 1, 2, 3, 4, 5, 6, 7,
	});
	if (jit_feature & RXJIT_FEATURE_RELAXED_SIMD) {
		WASM_U8_THUNK({0xfd, 0x80, 0x02}); // i8x16.relaxed_swizzle
	} else {
		WASM_U8_THUNK({0xfd, 0x0e}); // i8x16.swizzle
	}
	p += emit_store_v128_at(target_base, LOCT_dst_byte, p);
	BR(ARM_BR_END(k));
	THUNK_END;
}

// Emit the "fprc-driven dispatch" tail of a float arm.
//   Stack on entry: operands for the f64x2 op (matches call_indirect type's
//                   params: (v128,v128) for binary / (v128) for unary).
//   Stack on exit:  one v128 result.
//
// When INLINE_FPRC_ZERO is on, emits `if fprc==0 { native f64x2.<op> } else {
// call_indirect <stub> }`. fprc==0 (round-to-nearest) is the steady-state case
// for ~75% of float ops; inlining it avoids the v128-ABI register shuffle
// that dominates JSC's call_indirect cost.
//   native_op_byte: low byte of the f64x2 simd opcode (0xf0=add, 0xf1=sub,
//                   0xf2=mul, 0xf3=div, 0xef=sqrt — full encoding is 0xfd N 0x01).
//   wasm_type_idx:  2 = (v128,v128)->v128, 3 = (v128)->v128 (see EMIT_TYPE_SECTION_T).
//   tbl_idx:        funcref table index (TBL_F{ADD,SUB,MUL,DIV,SQRT}).
static uint32_t emit_fprc_dispatch(uint8_t native_op_byte, int wasm_type_idx, uint32_t tbl_idx,
                                   int jit_feature, uint8_t *buf) {
	THUNK_BEGIN;
	if (jit_feature & RXJIT_FEATURE_INLINE_FPRC_ZERO) {
		GG(TGLOB_fprc);
		I32_EQZ();
		WASM_U8(0x04);                    // if
		WASM_I64((int64_t)wasm_type_idx); // blocktype = typeidx (sleb128)
		// then-branch: fprc==0 → native f64x2.<op>. Operands fall through.
		WASM_U8(0xfd);
		WASM_U8(native_op_byte);
		WASM_U8(0x01);
		WASM_U8(0x05); // else
		// else-branch: fprc!=0 → call_indirect on the soft-rounding stub.
		GG(TGLOB_fprc);
		WASM_U8(0x11);
		WASM_U32((uint32_t)wasm_type_idx);
		WASM_U32(tbl_idx);
		END_BLK(); // end if
	} else {
		GG(TGLOB_fprc);
		WASM_U8(0x11);
		WASM_U32((uint32_t)wasm_type_idx);
		WASM_U32(tbl_idx);
	}
	THUNK_END;
}

// K_FADD_R / K_FSUB_R: F(dst) = call_indirect[tbl, fprc](F(dst), A(src))
static uint32_t emit_arm_fadd_fsub_r(uint32_t tbl_idx, uint8_t native_op, int k, int jit_feature,
                                     uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_select_f(LOCT_dst_byte, p);
	p += emit_select_a(LOCT_src_byte, p);
	p += emit_fprc_dispatch(native_op, 2, tbl_idx, jit_feature, p);
	p += emit_store_v128_at(F(0), LOCT_dst_byte, p);
	BR(ARM_BR_END(k));
	THUNK_END;
}

// K_FADD_M / K_FSUB_M: F(dst) = call_indirect[tbl, fprc](F(dst), load_F_from_mem)
//   load_F_from_mem = f64x2.convert_low_i32x4_s(v128.load64_zero(addr))
static uint32_t emit_arm_fadd_fsub_m(uint32_t scratchpad_ptr, uint32_t tbl_idx, uint8_t native_op,
                                     int k, int jit_feature, uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_select_f(LOCT_dst_byte, p);
	p += emit_addr_l1l2(scratchpad_ptr, p);
	WASM_U8_THUNK({0xfd, 0x5d, 3, 0});  // v128.load64_zero align=3 offset=0
	WASM_U8_THUNK({0xfd, 0xfe, 0x01}); // f64x2.convert_low_i32x4_s
	p += emit_fprc_dispatch(native_op, 2, tbl_idx, jit_feature, p);
	p += emit_store_v128_at(F(0), LOCT_dst_byte, p);
	BR(ARM_BR_END(k));
	THUNK_END;
}

// K_FSCAL_R: F(dst) = F(dst) ^ const_v128
//   const = (0x80F0000000000000 x 2)
static uint32_t emit_arm_fscal_r(int k, uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_select_f(LOCT_dst_byte, p);
	WASM_U8_THUNK({
		0xfd, 0x0c,
		0, 0, 0, 0, 0, 0, 0xf0, 0x80,
		0, 0, 0, 0, 0, 0, 0xf0, 0x80,
	});     // v128.const i64x2(0x80F0_0000_0000_0000 x2)
	WASM_U8_THUNK({0xfd, 0x51}); // v128.xor
	p += emit_store_v128_at(F(0), LOCT_dst_byte, p);
	BR(ARM_BR_END(k));
	THUNK_END;
}

// K_FMUL_R: E(dst) = call_indirect[tmul, fprc](E(dst), A(src))
static uint32_t emit_arm_fmul_r(int k, int jit_feature, uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_select_e(LOCT_dst_byte, p);
	p += emit_select_a(LOCT_src_byte, p);
	p += emit_fprc_dispatch(0xf2 /* f64x2.mul */, 2, TBL_FMUL, jit_feature, p);
	p += emit_store_v128_at(E(0), LOCT_dst_byte, p);
	BR(ARM_BR_END(k));
	THUNK_END;
}

// K_FDIV_M: E(dst) = call_indirect[tdiv, fprc](E(dst), masked_mem_load)
static uint32_t emit_arm_fdiv_m(uint32_t scratchpad_ptr, int k, int jit_feature, uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_select_e(LOCT_dst_byte, p);
	p += emit_addr_l1l2(scratchpad_ptr, p);
	WASM_U8_THUNK({0xfd, 0x5d, 3, 0});  // v128.load64_zero
	WASM_U8_THUNK({0xfd, 0xfe, 0x01}); // f64x2.convert_low_i32x4_s
	LG(LOC_mask_mant);
	WASM_U8_THUNK({0xfd, 0x4e}); // v128.and
	LG(LOC_mask_exp);
	WASM_U8_THUNK({0xfd, 0x50}); // v128.or
	p += emit_fprc_dispatch(0xf3 /* f64x2.div */, 2, TBL_FDIV, jit_feature, p);
	p += emit_store_v128_at(E(0), LOCT_dst_byte, p);
	BR(ARM_BR_END(k));
	THUNK_END;
}

// K_FSQRT_R: E(dst) = call_indirect[tsqrt, fprc](E(dst))
static uint32_t emit_arm_fsqrt_r(int k, int jit_feature, uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_select_e(LOCT_dst_byte, p);
	p += emit_fprc_dispatch(0xef /* f64x2.sqrt */, 3, TBL_FSQRT, jit_feature, p);
	p += emit_store_v128_at(E(0), LOCT_dst_byte, p);
	BR(ARM_BR_END(k));
	THUNK_END;
}

// K_CBRANCH: r[dst] += imm64 (composed); if (r[dst] & mask) == 0, pc = target;
//            jump to inner loop (skips pc++); else fall through normally.
static uint32_t emit_arm_cbranch(int k, uint8_t *buf) {
	THUNK_BEGIN;
	// r[dst] += imm64; tee tmp64_b; store back to r[dst]
	p += emit_select_r(LOCT_dst_byte, p);
	LG(LOCT_inst_ptr);
	I64_LOAD_OFF(D_IMM64);
	I64_ADD();
	LT(LOCT_tmp64_b);
	p += emit_store_r_i64(LOCT_dst_byte, p);
	// (tmp64_b & mask) == 0 ?
	LG(LOCT_tmp64_b);
	LG(LOCT_inst_ptr);
	I64_LOAD32U_OFF(D_IMM32);
	I64_AND();
	I64_EQZ();
	// if cond { pc = target_pc; br $inner }
	WASM_U8_THUNK({0x04, 0x40}); // if () -> ()
	LG(LOCT_inst_ptr);
	I32_LOAD8U_OFF(D_FLAGS);
	LS(LOCT_pc);
	BR(ARM_BR_INNER(k) + 1); // +1 for the if block
	END_BLK();               // end of if
	BR(ARM_BR_END(k));
	THUNK_END;
}

// K_CFROUND: fprc = (r[src] rotr imm) & 3
//   (existing emit: i64.rotr → low 32 → mask 3 → set fprc)
static uint32_t emit_arm_cfround(int k, uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_select_r(LOCT_src_byte, p);
	LG(LOCT_inst_ptr);
	I64_LOAD32U_OFF(D_IMM32);
	WI64_CONST(63);
	I64_AND(); // existing code did (imm32 & 63) on C side; here we mask at runtime
	I64_ROTR();
	I32_WRAP_I64();
	WI32_CONST(3);
	I32_AND();
	GS(TGLOB_fprc);
	BR(ARM_BR_END(k));
	THUNK_END;
}

// K_ISTORE_L12: store r[src] to scratchpad[ (imm + r[dst]) & (L1|L2 mask) ]
//   Note: here dst is the address-source register, src is the value-source.
static uint32_t emit_arm_istore_l12(uint32_t scratchpad_ptr, int k, uint8_t *buf) {
	THUNK_BEGIN;
	// address: imm32 + r[dst], wrap, & mask (L1/L2), + scratchpad
	LG(LOCT_inst_ptr);
	I64_LOAD32S_OFF(D_IMM32);
	p += emit_select_r(LOCT_dst_byte, p);
	I64_ADD();
	I32_WRAP_I64();
	WI32_CONST(SCRATCHPAD_L1_MASK);
	WI32_CONST(SCRATCHPAD_L2_MASK);
	LG(LOCT_inst_ptr);
	I32_LOAD8U_OFF(D_FLAGS);
	WI32_CONST(0x04);
	I32_AND();
	SELECT_NUM();
	I32_AND();
	WI32_CONST(scratchpad_ptr);
	I32_ADD();
	// value: r[src]
	p += emit_select_r(LOCT_src_byte, p);
	I64_STORE_OFF(0);
	BR(ARM_BR_END(k));
	THUNK_END;
}

// K_ISTORE_L3
static uint32_t emit_arm_istore_l3(uint32_t scratchpad_ptr, int k, uint8_t *buf) {
	THUNK_BEGIN;
	LG(LOCT_inst_ptr);
	I64_LOAD32S_OFF(D_IMM32);
	p += emit_select_r(LOCT_dst_byte, p);
	I64_ADD();
	I32_WRAP_I64();
	WI32_CONST(SCRATCHPAD_L3_MASK);
	I32_AND();
	WI32_CONST(scratchpad_ptr);
	I32_ADD();
	p += emit_select_r(LOCT_src_byte, p);
	I64_STORE_OFF(0);
	BR(ARM_BR_END(k));
	THUNK_END;
}

// ---------------- The dispatch itself ----------------

static uint32_t emit_inner_dispatch(uint32_t scratchpad_ptr, int jit_feature, uint8_t *buf) {
	THUNK_BEGIN;

	// Open K_COUNT+1 blocks ($end_dispatch + arm_0..arm_{K_COUNT-1})
	for (int i = 0; i < RXJIT_K_COUNT + 1; i++)
		BLOCK_VOID();

	// load opcode_kind and dispatch
	LG(LOCT_inst_ptr);
	I32_LOAD8U_OFF(D_OP);
	WASM_U8(0x0e);           // br_table opcode
	WASM_U32(RXJIT_K_COUNT); // count of labels
	for (int i = 0; i < RXJIT_K_COUNT; i++)
		WASM_U32((uint32_t)i);
	WASM_U32(RXJIT_K_COUNT); // default → $end_dispatch

	// arm_0..arm_{K_COUNT-1} bodies. After closing arm_k's block, we're at
	// the position where br_table label k landed.
	for (int k = 0; k < RXJIT_K_COUNT; k++) {
		END_BLK();
		switch (k) {
		case RXJIT_K_NOP:
			p += emit_arm_nop(k, p);
			break;
		case RXJIT_K_IADD_RS:
			p += emit_arm_iadd_rs(k, p);
			break;
		case RXJIT_K_IADD_RS_DISPL:
			p += emit_arm_iadd_rs_displ(k, p);
			break;
		case RXJIT_K_IADD_M_RR:
			p += emit_arm_alu_mem_l1l2(scratchpad_ptr, 0x7c /*add*/, k, p);
			break;
		case RXJIT_K_IADD_M_DIRECT:
			p += emit_arm_alu_mem_l3(scratchpad_ptr, 0x7c, k, p);
			break;
		case RXJIT_K_ISUB_R:
			p += emit_arm_alu_rr(0x7d /*sub*/, k, p);
			break;
		case RXJIT_K_ISUB_R_IMM:
			p += emit_arm_alu_imm(0x7d, k, p);
			break;
		case RXJIT_K_ISUB_M_RR:
			p += emit_arm_alu_mem_l1l2(scratchpad_ptr, 0x7d, k, p);
			break;
		case RXJIT_K_ISUB_M_DIRECT:
			p += emit_arm_alu_mem_l3(scratchpad_ptr, 0x7d, k, p);
			break;
		case RXJIT_K_IMUL_R:
			p += emit_arm_alu_rr(0x7e /*mul*/, k, p);
			break;
		case RXJIT_K_IMUL_R_IMM:
			p += emit_arm_alu_imm(0x7e, k, p);
			break;
		case RXJIT_K_IMUL_M_RR:
			p += emit_arm_alu_mem_l1l2(scratchpad_ptr, 0x7e, k, p);
			break;
		case RXJIT_K_IMUL_M_DIRECT:
			p += emit_arm_alu_mem_l3(scratchpad_ptr, 0x7e, k, p);
			break;
		case RXJIT_K_IMULH_R:
			p += emit_arm_mulh_r(TFN_MULH, k, p);
			break;
		case RXJIT_K_IMULH_M_RR:
			p += emit_arm_mulh_m_rr(scratchpad_ptr, TFN_MULH, k, p);
			break;
		case RXJIT_K_IMULH_M_DIRECT:
			p += emit_arm_mulh_m_direct(scratchpad_ptr, TFN_MULH, k, p);
			break;
		case RXJIT_K_ISMULH_R:
			p += emit_arm_mulh_r(TFN_IMULH, k, p);
			break;
		case RXJIT_K_ISMULH_M_RR:
			p += emit_arm_mulh_m_rr(scratchpad_ptr, TFN_IMULH, k, p);
			break;
		case RXJIT_K_ISMULH_M_DIRECT:
			p += emit_arm_mulh_m_direct(scratchpad_ptr, TFN_IMULH, k, p);
			break;
		case RXJIT_K_IMUL_RCP:
			p += emit_arm_imul_rcp(k, p);
			break;
		case RXJIT_K_INEG_R:
			p += emit_arm_ineg_r(k, p);
			break;
		case RXJIT_K_IXOR_R:
			p += emit_arm_alu_rr(0x85 /*xor*/, k, p);
			break;
		case RXJIT_K_IXOR_R_IMM:
			p += emit_arm_alu_imm(0x85, k, p);
			break;
		case RXJIT_K_IXOR_M_RR:
			p += emit_arm_alu_mem_l1l2(scratchpad_ptr, 0x85, k, p);
			break;
		case RXJIT_K_IXOR_M_DIRECT:
			p += emit_arm_alu_mem_l3(scratchpad_ptr, 0x85, k, p);
			break;
		case RXJIT_K_IROR_R:
			p += emit_arm_alu_rr(0x8a /*rotr*/, k, p);
			break;
		case RXJIT_K_IROR_R_IMM:
			p += emit_arm_alu_imm(0x8a, k, p);
			break;
		case RXJIT_K_IROL_R:
			p += emit_arm_alu_rr(0x89 /*rotl*/, k, p);
			break;
		case RXJIT_K_IROL_R_IMM:
			p += emit_arm_alu_imm(0x89, k, p);
			break;
		case RXJIT_K_ISWAP_R:
			p += emit_arm_iswap_r(k, p);
			break;
		case RXJIT_K_FSWAP_R_F:
			p += emit_arm_fswap_r_bank(F(0), k, jit_feature, p);
			break;
		case RXJIT_K_FSWAP_R_E:
			p += emit_arm_fswap_r_bank(E(0), k, jit_feature, p);
			break;
		case RXJIT_K_FADD_R:
			p += emit_arm_fadd_fsub_r(TBL_FADD, 0xf0 /* f64x2.add */, k, jit_feature, p);
			break;
		case RXJIT_K_FADD_M:
			p += emit_arm_fadd_fsub_m(scratchpad_ptr, TBL_FADD, 0xf0, k, jit_feature, p);
			break;
		case RXJIT_K_FSUB_R:
			p += emit_arm_fadd_fsub_r(TBL_FSUB, 0xf1 /* f64x2.sub */, k, jit_feature, p);
			break;
		case RXJIT_K_FSUB_M:
			p += emit_arm_fadd_fsub_m(scratchpad_ptr, TBL_FSUB, 0xf1, k, jit_feature, p);
			break;
		case RXJIT_K_FSCAL_R:
			p += emit_arm_fscal_r(k, p);
			break;
		case RXJIT_K_FMUL_R:
			p += emit_arm_fmul_r(k, jit_feature, p);
			break;
		case RXJIT_K_FDIV_M:
			p += emit_arm_fdiv_m(scratchpad_ptr, k, jit_feature, p);
			break;
		case RXJIT_K_FSQRT_R:
			p += emit_arm_fsqrt_r(k, jit_feature, p);
			break;
		case RXJIT_K_CBRANCH:
			p += emit_arm_cbranch(k, p);
			break;
		case RXJIT_K_CFROUND:
			p += emit_arm_cfround(k, p);
			break;
		case RXJIT_K_ISTORE_L12:
			p += emit_arm_istore_l12(scratchpad_ptr, k, p);
			break;
		case RXJIT_K_ISTORE_L3:
			p += emit_arm_istore_l3(scratchpad_ptr, k, p);
			break;
		default:
			p += emit_arm_nop(k, p);
			break;
		}
	}
	END_BLK(); // close $end_dispatch

	THUNK_END;
}

// ---------------- Module envelope ----------------

// WASM_SECTION(...) defeats clang-format-19's indenter; wrap so the
// module-builder's section layout survives a format pass.
// clang-format off

#define EMIT_TYPE_SECTION_T()                                          \
	WASM_SECTION(WASM_SECTION_TYPE, {                                  \
		WASM_U8_THUNK({                                                \
			4,                                                         \
			0x60, 0, 0,                                                \
			0x60, 2, WASM_TYPE_I64, WASM_TYPE_I64, 1, WASM_TYPE_I64,   \
			0x60, 2, WASM_TYPE_V128, WASM_TYPE_V128, 1, WASM_TYPE_V128,\
			0x60, 1, WASM_TYPE_V128, 1, WASM_TYPE_V128,                \
		});                                                            \
	})

uint32_t rxjit_generate_threaded_module(
	uint32_t vm_state_ptr,
	uint32_t scratchpad_ptr,
	uint32_t dataset_ptr,
	uint32_t program_slot_ptr,
	uint32_t mem_min_pages,
	uint32_t mem_max_pages,
	int jit_feature,
	int regs_in_memory,
	int split_inner_dispatch,
	uint8_t *buf)
{
	// Per-thread module-gen flags. VM_R0_OFFSET is 0, so r_file_base == vm_state_ptr.
	// split_id implies regs_in_memory (F/E/A go through memory too).
	g_emit_split_id    = !!split_inner_dispatch;
	g_emit_regs_in_mem = !!(regs_in_memory || split_inner_dispatch);
	g_r_file_base      = vm_state_ptr + VM_R0_OFFSET;

	const int split = g_emit_split_id;
	const uint8_t fn_main_loop_idx = split ? TFN_MAIN_LOOP_SPLIT : TFN_MAIN_LOOP;

	THUNK_BEGIN;

	WASM_MAGIC();
	EMIT_TYPE_SECTION_T();

	// import section: memory only
	WASM_SECTION(WASM_SECTION_IMPORT, {
		WASM_U8_THUNK({1, 1, 'e', 1, 'm', 0x02, 0x03});
		WASM_U32(mem_min_pages);
		WASM_U32(mem_max_pages);
	});

	// function section: 23 (or 24 in split_id) functions: 22 stubs + [inner_dispatch] + main_loop
	WASM_SECTION(WASM_SECTION_FUNCTION, {
		if (split) {
			WASM_U8_THUNK({
				24,
				1, 1,                                           // mulh, imulh
				2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, // fadd/fsub/fmul/fdiv type 2
				3, 3, 3, 3,                                     // fsqrt type 3
				0,                                              // inner_dispatch type 0
				0,                                              // main_loop type 0
			});
		} else {
			WASM_U8_THUNK({
				23,
				1, 1,                                           // mulh, imulh
				2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, // fadd/fsub/fmul/fdiv type 2
				3, 3, 3, 3,                                     // fsqrt type 3
				0,                                              // main_loop type 0
			});
		}
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

	// global section: 1 mutable i32 (fprc) init 0
	WASM_SECTION(WASM_SECTION_GLOBAL, {
		WASM_U8_THUNK({1, WASM_TYPE_I32, 0x01, 0x41, 0x00, 0x0b});
	});

	// export section: just "d" → main_loop (index depends on split)
	WASM_SECTION(WASM_SECTION_EXPORT, {
		WASM_U8(1);
		WASM_U8(1); WASM_U8('d'); WASM_U8(0x00);
		WASM_U8(fn_main_loop_idx);
	});

	// element section: populate the 5 tables (same as static module)
	WASM_SECTION(WASM_SECTION_ELEMENT, {
		WASM_U8_THUNK({
			5,
			0x02, 0, 0x41, 0, 0x0b, 0x00, 4, 2, 3, 4, 5,     // fadd
			0x02, 1, 0x41, 0, 0x0b, 0x00, 4, 6, 7, 8, 9,     // fsub
			0x02, 2, 0x41, 0, 0x0b, 0x00, 4, 10, 11, 12, 13, // fmul
			0x02, 3, 0x41, 0, 0x0b, 0x00, 4, 14, 15, 16, 17, // fdiv
			0x02, 4, 0x41, 0, 0x0b, 0x00, 4, 18, 19, 20, 21, // fsqrt
		});
	});

	// code section: 22 stubs + [inner_dispatch] + main_loop
	WASM_SECTION(WASM_SECTION_CODE, {
		WASM_U8(split ? 24 : 23);                 // function count
		p += emit_stub_bodies(jit_feature, p);    // stubs 0..21
		if (split) {
			// inner_dispatch function body (index 22 when split is on)
			WASM_U32_PATCH({
				p += emit_local_decls(p);
				p += emit_inner_dispatch_fn(vm_state_ptr, scratchpad_ptr,
				                            program_slot_ptr, jit_feature, p);
				WASM_U8(0x0b);                      // end of function
			});
		}
		// main_loop function body (index 22 or 23)
		WASM_U32_PATCH({
			p += emit_local_decls(p);
			p += emit_main_loop_body(vm_state_ptr, scratchpad_ptr, dataset_ptr,
			                         program_slot_ptr, jit_feature, p);
			WASM_U8(0x0b);                          // end of function
		});
	});

	THUNK_END;
}
// clang-format on
