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
#include "wasm_jit_fuse_table.h" // step 6: fused pair kinds; X2: fused triples
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
#define LOCT_arena        LOCT_spare // i32: shared_code arena base (TGLOB_arena)
#define LOCT_fx1          59 // v128: no-FMA Dekker temps (step 8 part B; declared only without FMA)
#define LOCT_fx2          60

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
// shared_code only: exported mutable i32 global "a" = this thread's arena base
// (vm_state), set by rxjit_js_run_threaded after instantiation.
#define TGLOB_arena 1

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

// Program slot address (records 0..255; sentinel EXIT record at +4096).
// Used by the CBRANCH taken path to form the target record pointer.
static _Thread_local uint32_t g_slot = 0;

// shared_code (wasm_jit_profile.h): no per-thread pointer in the module bytes,
// so every thread generates the same bytes and V8's native module cache
// compiles them once for all workers. main_loop and inner_dispatch read the
// arena base from global TGLOB_arena into LOCT_arena once at entry; the
// generator then works with arena-relative "pointers" (vm_state_ptr = 0,
// g_r_file_base = 0, g_slot = RXJIT_ARENA_SLOT_OFF) and every vm_state /
// arena / slot access adds LOCT_arena (the macros below). main_loop's steps
// read the scratchpad base from the arena's SPB slot (LOCT_spb), like
// inner_dispatch. The records keep their absolute operand addresses (data,
// decoded per thread). Off: every macro emits exactly the old bytes.
static _Thread_local int g_shared = 0;

// Light mode (no dataset): the body of the superscalar item function
// item(i32 item, i32 out) -> () (rxjit_emit_superscalar_item_fn), appended
// as function TFN_ITEM with type TTYPE_ITEM. Step 7 then calls it with
// item = LOCT_ds_ptr (dataset_offset / 64 in light mode) + ma / 64 and
// out = arena +RXJIT_ARENA_ITEM_OFF, and xors those 64 bytes instead of a
// dataset line. Set by rxjit_threaded_set_light_fn for one generation;
// len 0 (the default) emits exactly the full-mode bytes.
// g_light_mlp (rxjit_threaded_set_light_mlp, wasm_jit_threaded.h): 1 adds the
// next item's line probe before the call, 2 makes TFN_ITEM item_pair (type
// TTYPE_ITEM becomes (i32, i32, i32) -> ()) called on even iterations.
static _Thread_local const uint8_t *g_light_fn = 0;
static _Thread_local uint32_t g_light_fn_len = 0;
static _Thread_local int g_light_mlp = 0;
static _Thread_local uint32_t g_light_cache_base = 0;
#define TFN_ITEM   24 // after main_loop (split_id is always on)
#define TTYPE_ITEM 4
// light_mlp 2 pairs iterations (2i, 2i + 1) within one main_loop call, which
// counts ic down from RANDOMX_PROGRAM_ITERATIONS: iteration i even <=> ic even.
_Static_assert(RANDOMX_PROGRAM_ITERATIONS % 2 == 0, "light_mlp 2 pairs iterations");

void rxjit_threaded_set_light_fn(const uint8_t *body, uint32_t len) {
	g_light_fn = body;
	g_light_fn_len = body ? len : 0;
}
void rxjit_threaded_set_light_mlp(int mode, uint32_t cache_base) {
	g_light_mlp = mode;
	g_light_cache_base = cache_base;
}

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

// Decoded-inst field offsets within the 16-byte record (layout v2, see
// wasm_jit_decode.h). Only D_OP is loaded by the loop header; every arm loads
// its own fields (each at most once) at g_ro + D_* (aux: g_ro + g_d_aux).
#define D_OP    0  // u8 kind (i32.load8_u), or u16 with g_kind16 (i32.load16_u)
#define D_DSTA  4  // u32 absolute dst operand address
#define D_SRCA  8  // u32 absolute src operand address
#define D_CBIMM 8  // CBRANCH: int32 composed imm
#define D_IMM64 8  // IMUL_RCP: u64 reciprocal
#define D_IMM32 12 // raw imm32 / CBRANCH mask / CFROUND rot (pre-masked & 63)

// Record offset added to every in-arm record load (stays 0 until fused
// superinstructions read the second record at +16, a triple's third at +32).
static _Thread_local uint32_t g_ro = 0;
// Step 6 (fused pairs): g_no_exit suppresses emit_arm_exit while emitting the
// parts of a fused arm; g_k_total = RXJIT_K_COUNT + fuse_n + triples_n is the
// number of br_table arms (branch depths are computed from it). X2: fused
// triple kinds start at RXJIT_K_COUNT + g_fuse_n.
static _Thread_local int g_no_exit = 0;
static _Thread_local int g_k_total = RXJIT_K_COUNT;
static _Thread_local int g_fuse_n = 0;
// Record head width (rxjit_kind16): u8 kinds with aux at +1 (the arm profile,
// layout v2 as before), or u16 kinds with aux at +2. g_d_aux is the aux byte
// offset (CBRANCH: target_pc; others: MOD_SHIFT | RXJIT_FLAG_MEM_L1).
static _Thread_local int g_kind16 = 0;
static _Thread_local uint32_t g_d_aux = 1;
// X3 (RXJIT_FEATURE_UNROLL2): set while emitting copy 0 of the two dispatch
// copies in $L. Its arm exits advance ip by nrec-1 records and leave through
// copy 0's $end_dispatch (the join adds the last 16) instead of `br $L`.
static _Thread_local int g_unroll_c0 = 0;

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
// i32.load16_u align=1 offset=$off
#define I32_LOAD16U_OFF(off)       \
	do {                           \
		WASM_U8(0x2f);             \
		WASM_U8(1);                \
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
// shared_code addressing (g_shared). ARENA_BASE: the address operand of a
// vm_state / arena access whose memarg offset is g_r_file_base + X (baked:
// i32.const 0; shared: LOCT_arena, the offset being arena-relative).
// ARENA_ADD: after a computed index (idx << 3, fprc << 7), add the arena base.
// ARENA_PTR(a): a pointer value (baked: i32.const a; shared: LOCT_arena + a,
// a arena-relative). SP_PTR(a): the scratchpad base (baked: i32.const a;
// shared: LOCT_spb).
#define ARENA_BASE()           \
	do {                       \
		if (g_shared)          \
			LG(LOCT_arena);    \
		else                   \
			WI32_CONST(0);     \
	} while (0)
#define ARENA_ADD()            \
	do {                       \
		if (g_shared) {        \
			LG(LOCT_arena);    \
			I32_ADD();         \
		}                      \
	} while (0)
#define ARENA_PTR(a)                   \
	do {                               \
		if (!g_shared) {               \
			WI32_CONST(a);             \
		} else {                       \
			LG(LOCT_arena);            \
			if (a) {                   \
				WI32_CONST(a);         \
				I32_ADD();             \
			}                          \
		}                              \
	} while (0)
#define SP_PTR(a)              \
	do {                       \
		if (g_shared)          \
			LG(LOCT_spb);      \
		else                   \
			WI32_CONST(a);     \
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
		ARENA_ADD();
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
	ARENA_ADD();
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
		ARENA_ADD();
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
		ARENA_ADD();
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

// Arm field loaders (layout v2). LOCT_dst_byte / LOCT_src_byte hold absolute
// operand ADDRESSES now (the names are historical). TurboFan does not CSE
// repeated loads of the same address, so each field is loaded once per arm.
static uint32_t emit_ld_dst(uint8_t *buf) {
	THUNK_BEGIN;
	LG(LOCT_inst_ptr);
	I32_LOAD_OFF(g_ro + D_DSTA);
	LS(LOCT_dst_byte);
	THUNK_END;
}
static uint32_t emit_ld_src(uint8_t *buf) {
	THUNK_BEGIN;
	LG(LOCT_inst_ptr);
	I32_LOAD_OFF(g_ro + D_SRCA);
	LS(LOCT_src_byte);
	THUNK_END;
}
// i64 / v128 at the address held in local l.
#define RD64(l)            \
	do {                   \
		LG(l);             \
		I64_LOAD_OFF(0);   \
	} while (0)
#define RDV(l)             \
	do {                   \
		LG(l);             \
		V128_LOAD_OFF(0);  \
	} while (0)

// Scratchpad base. Step 9: an opaque i32 local (LOCT_spb), loaded once per
// inner_dispatch call from arena +RXJIT_ARENA_SPB_OFF (written by
// wasm_jit_run.cpp), so each memory arm does one `add` instead of
// rematerialising the constant (movz/movk/add). The scratchpad_base
// parameters of the address helpers are kept for the signature only.
static uint32_t emit_load_spb(uint8_t *buf) {
	THUNK_BEGIN;
	ARENA_BASE();
	I32_LOAD_OFF(g_r_file_base + RXJIT_ARENA_SPB_OFF);
	LS(LOCT_spb);
	THUNK_END;
}
#define SP_BASE() LG(LOCT_spb)

// L1/L2 address: ((u32)imm32 + (u32)r[reg]) & mask + scratchpad_base
// (i32 math == low half of the i64 sum). Step 5: mask (SCRATCHPAD_L1_MASK or
// SCRATCHPAD_L2_MASK) is baked per kind; both are ARM64 logical immediates.
// reg_local holds the address of the register.
static uint32_t emit_addr_l1l2(uint32_t scratchpad_base, uint32_t mask, int reg_local,
                               uint8_t *buf) {
	THUNK_BEGIN;
	(void)scratchpad_base;
	LG(LOCT_inst_ptr);
	I32_LOAD_OFF(g_ro + D_IMM32);
	LG(reg_local);
	I32_LOAD_OFF(0); // low 32 bits of r[reg] (little-endian)
	I32_ADD();
	WI32_CONST(mask);
	I32_AND();
	SP_BASE();
	I32_ADD();
	THUNK_END;
}

// L3 direct address: (imm32) & L3_MASK + scratchpad_base
static uint32_t emit_addr_l3_direct(uint32_t scratchpad_base, uint8_t *buf) {
	THUNK_BEGIN;
	LG(LOCT_inst_ptr);
	I32_LOAD_OFF(g_ro + D_IMM32);
	WI32_CONST(SCRATCHPAD_L3_MASK);
	I32_AND();
	(void)scratchpad_base;
	SP_BASE();
	I32_ADD();
	THUNK_END;
}

// L3 address with register: ((u32)imm32 + (u32)r[reg]) & L3_MASK + scratchpad_base
static uint32_t emit_addr_l3_reg(uint32_t scratchpad_base, int reg_local, uint8_t *buf) {
	THUNK_BEGIN;
	LG(LOCT_inst_ptr);
	I32_LOAD_OFF(g_ro + D_IMM32);
	LG(reg_local);
	I32_LOAD_OFF(0);
	I32_ADD();
	WI32_CONST(SCRATCHPAD_L3_MASK);
	I32_AND();
	(void)scratchpad_base;
	SP_BASE();
	I32_ADD();
	THUNK_END;
}

// ---------------- Inline directed rounding (step 3) ----------------
//
// Branchless, bit-exact with the semifloat FMA stubs. c = round-to-nearest
// result, res = exact residue (TwoSum / FMA), then a per-mode mask fixup
// nudges c by one ulp (integer +-1 on the bit pattern). Masks live in the
// arena at vm_state + RXJIT_ARENA_RMASK_OFF + fprc*128 + 16*i, i = TEG, TEL,
// K1, K2, D1, D3, KON (filled once by wasm_jit_run.cpp), and are reloaded into
// LOCT_mTEG..mKON at every inner_dispatch entry and after every CFROUND.
// add/sub use TwoSum (plain SIMD128, no FMA). mul/div/sqrt use a fused
// relaxed_madd/nmadd with RXJIT_FEATURE_FMA, else the Dekker TwoProduct
// sequences below (plain SIMD128: Safari/JSC). All inline unless
// NO_INLINE_ROUND (then emit_fprc_dispatch stubs everywhere).
static inline int rxjit_inline_round_addsub_on(int jit_feature) {
	return !(jit_feature & RXJIT_FEATURE_NO_INLINE_ROUND);
}
static inline int rxjit_inline_round_muldiv_on(int jit_feature) {
	return !(jit_feature & RXJIT_FEATURE_NO_INLINE_ROUND);
}
static inline int rxjit_inline_round_muldiv_fma(int jit_feature) {
	return (jit_feature & RXJIT_FEATURE_FMA) != 0;
}
static inline int rxjit_inline_round_any_on(int jit_feature) {
	return rxjit_inline_round_addsub_on(jit_feature);
}

// 0xfd-prefixed SIMD op (uleb128 opcode: relaxed and i64x2 ops are multi-byte).
// f64x2.lt 0x49 gt 0x4a | v128.and 0x4e or 0x50 xor 0x51 bitselect 0x52 |
// i64x2.add 0xce sub 0xd1 | f64x2.neg 0xed sqrt 0xef add 0xf0 sub 0xf1 mul 0xf2
// div 0xf3 | f64x2.relaxed_madd 0x107 relaxed_nmadd 0x108
#define SIMD(op)                      \
	do {                              \
		WASM_U8(0xfd);                \
		WASM_U32((uint32_t)(op));     \
	} while (0)
// v128.const 0 (a literal zero lets TurboFan use fcmlt/fcmgt #0.0)
#define V128_ZERO()                                                          \
	do {                                                                     \
		WASM_U8_THUNK({0xfd, 0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, \
		               0, 0});                                               \
	} while (0)

static uint32_t emit_load_round_masks(uint8_t *buf) {
	THUNK_BEGIN;
	GG(TGLOB_fprc);
	WI32_CONST(7);
	I32_SHL();
	ARENA_ADD();
	LS(LOCT_rmoff);
	for (int i = 0; i < 7; i++) {
		LG(LOCT_rmoff);
		V128_LOAD_OFF(g_r_file_base + RXJIT_ARENA_RMASK_OFF + 16 * (uint32_t)i);
		LS(LOCT_mTEG + i);
	}
	THUNK_END;
}

// fa, fb -> fc = fa op fb (nearest), fr = exact residue (TwoSum).
static uint32_t emit_twosum(int is_sub, uint8_t *buf) {
	THUNK_BEGIN;
	const uint32_t op = is_sub ? 0xf1 : 0xf0, inv = is_sub ? 0xf0 : 0xf1;
	LG(LOCT_fa);
	LG(LOCT_fb);
	SIMD(op);
	LS(LOCT_fc);
	LG(LOCT_fa);
	LG(LOCT_fc);
	LG(LOCT_fb);
	SIMD(inv);
	SIMD(0xf1);
	LG(LOCT_fb);
	LG(LOCT_fc);
	LG(LOCT_fa);
	SIMD(0xf1);
	SIMD(inv);
	SIMD(op);
	LS(LOCT_fr);
	THUNK_END;
}

// F fixup: stack [addr] -> [addr, out]. out = c + ((bitselect(res>0, res<0,
// K1|(s&K2)) & KON) & ((s^D1)|D3)), s = c<0.
static uint32_t emit_round_f(uint8_t *buf) {
	THUNK_BEGIN;
	LG(LOCT_fc);
	V128_ZERO();
	SIMD(0x49);
	LS(LOCT_fs);
	LG(LOCT_fc);
	LG(LOCT_fr);
	V128_ZERO();
	SIMD(0x4a);
	LG(LOCT_fr);
	V128_ZERO();
	SIMD(0x49);
	LG(LOCT_fs);
	LG(LOCT_mK2);
	SIMD(0x4e);
	LG(LOCT_mK1);
	SIMD(0x50);
	SIMD(0x52);
	LG(LOCT_mKON);
	SIMD(0x4e);
	LG(LOCT_fs);
	LG(LOCT_mD1);
	SIMD(0x51);
	LG(LOCT_mD3);
	SIMD(0x50);
	SIMD(0x4e);
	SIMD(0xce);
	THUNK_END;
}

// ---- No-FMA residue sign for E results (step 8 part B) ----
//
// emit_round_e only needs sign(res) and NaN-ness, so without FMA the exact
// residue comes from Dekker's TwoProduct: every partial product and partial
// sum is exact and the last add is RN, which keeps the exact sign. One factor
// is split by bit truncation (hi = top 26 significant bits, lo = the other 27:
// 2 ops, never overflows), the other by Veltkamp (C = 2^27+1, 26 + 26 bits),
// so all four partial products fit in 53 bits. sqrt squares one value, so it
// needs Veltkamp on both sides (TwoSqr). The Veltkamp operand is pre-scaled by
// an exact power of two (mul 2^-40, div 1/2; sqrt c/2 and a/4) so C*x and the
// partial products stay finite for E up to DBL_MAX (and for c = +inf in mul).
// RandomX E values are >= 2^-511 (loads >= 2^-255, A >= 1, FDIV divisors < 2),
// far from underflow (checked down to 2^-850 .. 2^-960).
// Specials match the FMA path: c = +inf from finite operands -> res = -inf
// (mul: -inf propagates; div: the NaN error term is clamped by pmin), an inf
// operand -> NaN (never rounds). Bit-exact with the FMA fixup and an exact
// BigInt reference on 48M harness pairs x 4 modes incl. |res| = 1 unit (the
// session scratchpad harness, not committed), and identical in JSC.
#define RX_F64_SPLIT   0x41A0000002000000ull // 2^27 + 1
#define RX_F64_2M40    0x3D70000000000000ull // 2^-40
#define RX_F64_2P1000  0x7E70000000000000ull // 2^1000
#define RX_F64_HALF    0x3FE0000000000000ull
#define RX_F64_QUARTER 0x3FD0000000000000ull
#define RX_F64_TRUNC26 0xFFFFFFFFF8000000ull // keep sign, exponent, top 25 mantissa bits

static uint32_t emit_f64x2_splat(uint64_t b, uint8_t *buf) {
	THUNK_BEGIN;
	WASM_U8(0xfd);
	WASM_U8(0x0c);
	for (int i = 0; i < 16; i++)
		WASM_U8((uint8_t)(b >> (8 * (i & 7))));
	THUNK_END;
}

// Veltkamp split of local v: hi -> h, lo -> l (l may equal v). Uses LOCT_fs.
static uint32_t emit_split(uint32_t v, uint32_t h, uint32_t l, uint8_t *buf) {
	THUNK_BEGIN;
	LG(v);
	p += emit_f64x2_splat(RX_F64_SPLIT, p);
	SIMD(0xf2);
	LT(LOCT_fs);
	LG(LOCT_fs);
	LG(v);
	SIMD(0xf1);
	SIMD(0xf1);
	LS(h);
	LG(v);
	LG(h);
	SIMD(0xf1);
	LS(l);
	THUNK_END;
}

// Truncation split of local v: hi (26 bits) -> h, lo (27 bits, >= 0) -> l.
static uint32_t emit_split_trunc(uint32_t v, uint32_t h, uint32_t l, uint8_t *buf) {
	THUNK_BEGIN;
	LG(v);
	p += emit_f64x2_splat(RX_F64_TRUNC26, p);
	SIMD(0x4e);
	LS(h);
	LG(v);
	LG(h);
	SIMD(0xf1);
	LS(l);
	THUNK_END;
}

// fa = E, fb = A -> fc = fa*fb, fr ~ sign(fa*fb - fc). Clobbers fa, fb, fs, fx1, fx2.
static uint32_t emit_nofma_mul(uint8_t *buf) {
	THUNK_BEGIN;
	LG(LOCT_fa);
	LG(LOCT_fb);
	SIMD(0xf2);
	LS(LOCT_fc);
	LG(LOCT_fb);
	p += emit_f64x2_splat(RX_F64_2M40, p);
	SIMD(0xf2);
	LS(LOCT_fb);                                          // b' = b*2^-40
	p += emit_split_trunc(LOCT_fa, LOCT_fx1, LOCT_fa, p); // fx1 = ah, fa = al
	p += emit_split(LOCT_fb, LOCT_fx2, LOCT_fb, p);       // fx2 = bh, fb = bl
	LG(LOCT_fx1);
	LG(LOCT_fx2);
	SIMD(0xf2);
	LG(LOCT_fc);
	p += emit_f64x2_splat(RX_F64_2M40, p);
	SIMD(0xf2);
	SIMD(0xf1);                                           // ah*bh - c'
	LG(LOCT_fa);
	LG(LOCT_fx2);
	SIMD(0xf2);
	SIMD(0xf0);                                           // + al*bh
	LG(LOCT_fx1);
	LG(LOCT_fb);
	SIMD(0xf2);
	SIMD(0xf0);                                           // + ah*bl
	LG(LOCT_fa);
	LG(LOCT_fb);
	SIMD(0xf2);
	SIMD(0xf0);                                           // + al*bl (RN)
	LS(LOCT_fr);
	THUNK_END;
}

// fa = E, fb = divisor -> fc = fa/fb, fr ~ sign(fa - fc*fb). Clobbers fb, fs, fx1, fx2.
static uint32_t emit_nofma_div(uint8_t *buf) {
	THUNK_BEGIN;
	LG(LOCT_fa);
	LG(LOCT_fb);
	SIMD(0xf3);
	LS(LOCT_fc);
	LG(LOCT_fb);
	p += emit_f64x2_splat(RX_F64_HALF, p);
	SIMD(0xf2);
	LS(LOCT_fb);                                          // b' = b/2
	p += emit_split_trunc(LOCT_fc, LOCT_fx1, LOCT_fr, p); // fx1 = ch, fr = cl
	LG(LOCT_fc);
	LG(LOCT_fb);
	SIMD(0xf2);
	LS(LOCT_fx2);                                         // p = c*b'
	p += emit_split(LOCT_fb, LOCT_fs, LOCT_fb, p);        // fs = bh, fb = bl
	LG(LOCT_fa);
	p += emit_f64x2_splat(RX_F64_HALF, p);
	SIMD(0xf2);
	LG(LOCT_fx2);
	SIMD(0xf1);                                           // a/2 - p (exact)
	p += emit_f64x2_splat(RX_F64_2P1000, p);
	LG(LOCT_fx1);
	LG(LOCT_fs);
	SIMD(0xf2);
	LG(LOCT_fx2);
	SIMD(0xf1);                                           // ch*bh - p
	LG(LOCT_fr);
	LG(LOCT_fs);
	SIMD(0xf2);
	SIMD(0xf0);                                           // + cl*bh
	LG(LOCT_fx1);
	LG(LOCT_fb);
	SIMD(0xf2);
	SIMD(0xf0);                                           // + ch*bl
	LG(LOCT_fr);
	LG(LOCT_fb);
	SIMD(0xf2);
	SIMD(0xf0);                                           // e = c*b' - p
	SIMD(0xf6);                                           // f64x2.pmin(2^1000, e): NaN -> 2^1000
	SIMD(0xf1);
	LS(LOCT_fr);
	THUNK_END;
}

// fa = E -> fc = sqrt(fa), fr ~ sign(fa - fc*fc). Clobbers fs, fx1, fx2.
static uint32_t emit_nofma_sqrt(uint8_t *buf) {
	THUNK_BEGIN;
	LG(LOCT_fa);
	SIMD(0xef);
	LS(LOCT_fc);
	LG(LOCT_fc);
	p += emit_f64x2_splat(RX_F64_HALF, p);
	SIMD(0xf2);
	LS(LOCT_fx1);                                    // c' = c/2
	p += emit_split(LOCT_fx1, LOCT_fx2, LOCT_fr, p); // fx2 = ch, fr = cl
	LG(LOCT_fx1);
	LG(LOCT_fx1);
	SIMD(0xf2);
	LS(LOCT_fx1);                                    // p = c'^2
	LG(LOCT_fa);
	p += emit_f64x2_splat(RX_F64_QUARTER, p);
	SIMD(0xf2);
	LG(LOCT_fx1);
	SIMD(0xf1);                                      // a/4 - p (exact)
	LG(LOCT_fx2);
	LG(LOCT_fx2);
	SIMD(0xf2);
	LG(LOCT_fx1);
	SIMD(0xf1);
	LG(LOCT_fx2);
	LG(LOCT_fx2);
	SIMD(0xf0);
	LG(LOCT_fr);
	SIMD(0xf2);
	SIMD(0xf0);
	LG(LOCT_fr);
	LG(LOCT_fr);
	SIMD(0xf2);
	SIMD(0xf0);                                      // e = c'^2 - p
	SIMD(0xf1);
	LS(LOCT_fr);
	THUNK_END;
}

// E fixup (E results are always > 0): stack [addr] -> [addr, out].
// out = (c - (res > TEG)) + (res < TEL); compare masks are -1 when true.
static uint32_t emit_round_e(uint8_t *buf) {
	THUNK_BEGIN;
	LG(LOCT_fc);
	LG(LOCT_fr);
	LG(LOCT_mTEG);
	SIMD(0x4a);
	SIMD(0xd1);
	LG(LOCT_fr);
	LG(LOCT_mTEL);
	SIMD(0x49);
	SIMD(0xce);
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
	ARENA_PTR(vm_state_ptr);
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
static uint32_t emit_local_decls(int jit_feature, uint8_t *buf);

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
	SP_PTR(scratchpad_ptr);
	LG(LOC_sp_addr0);
	I32_ADD();
	LS(LOC_tmp);
	if (g_emit_regs_in_mem) {
		for (int i = 0; i < 8; i++) {
			// Stack: addr=0 (for store) ; sp[i] ; r[i] → xor → r[i]^sp[i]
			//        i64.store pops (i32 addr, i64 value).
			ARENA_BASE();
			LG(LOC_tmp);
			I64_LOAD_OFF((uint32_t)(i * 8));
			ARENA_BASE();
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
	SP_PTR(scratchpad_ptr);
	LG(LOC_sp_addr1);
	I32_ADD();
	LS(LOC_tmp);
	if (g_emit_split_id) {
		for (int i = 0; i < 4; i++) {
			ARENA_BASE(); // addr=0 for v128.store
			LG(LOC_tmp);
			V128_LOAD64_ZERO_OFF((uint32_t)(i * 8));
			WASM_U8_THUNK({0xfd, 0xfe, 0x01}); // f64x2.convert_low_i32x4_s
			V128_STORE_OFF(g_r_file_base + VM_F0_OFFSET + (uint32_t)(i * 16));
		}
		for (int i = 0; i < 4; i++) {
			ARENA_BASE(); // addr=0 for v128.store
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
// Light: the item is ds_ptr (dataset_offset / 64) + ma / 64. mx after step 5
// is the next iteration's ma (step 8 swaps them), so its item is known here
// too: g_light_mlp 1 touches its first cache line, 2 computes it together with
// this one on even iterations (ic even) into the ITEM2 line, which the odd
// iteration then xors without a call.
static uint32_t emit_step7_dataset_xor(uint8_t *buf) {
	THUNK_BEGIN;
	if (g_light_fn_len && g_light_mlp == 2) {
		// if ((ic & 1) == 0) item_pair(ds_ptr + ma/64, ds_ptr + mx/64, arena ITEM)
		LG(LOC_ic);
		WI32_CONST(1);
		I32_AND();
		I32_EQZ();
		WASM_U8_THUNK({0x04, 0x40}); // if (no result)
		LG(LOCT_ds_ptr);
		LG(LOC_ma);
		WI32_CONST(6);
		I32_SHR_U();
		I32_ADD();
		LG(LOCT_ds_ptr);
		LG(LOC_mx);
		WI32_CONST(6);
		I32_SHR_U();
		I32_ADD();
		ARENA_PTR(g_r_file_base + RXJIT_ARENA_ITEM_OFF);
		WASM_U8(0x10);
		WASM_U32(TFN_ITEM);
		END_BLK();
		// line = arena ITEM + (ic & 1) * (ITEM2 - ITEM), branchless
		ARENA_PTR(g_r_file_base + RXJIT_ARENA_ITEM_OFF);
		LG(LOC_ic);
		WI32_CONST(1);
		I32_AND();
		WI32_CONST(RXJIT_ARENA_ITEM2_OFF - RXJIT_ARENA_ITEM_OFF);
		WASM_U8(0x6c); // i32.mul
		I32_ADD();
	} else if (g_light_fn_len) { // light: item(ds_ptr + ma/64, arena ITEM), then xor that line
		if (g_light_mlp == 1 && g_light_cache_base) {
			// probe: arena ITEM qword 0 = the next item's first cache-line
			// qword (overwritten by the call; the store keeps the load alive)
			ARENA_PTR(g_r_file_base + RXJIT_ARENA_ITEM_OFF);
			LG(LOCT_ds_ptr);
			LG(LOC_mx);
			WI32_CONST(6);
			I32_SHR_U();
			I32_ADD();
			WI32_CONST(0x3FFFFF); // CACHE_ITEM_MASK (wasm_jit_superscalar.cpp)
			I32_AND();
			WI32_CONST(6);
			I32_SHL();
			WI32_CONST((int32_t)g_light_cache_base);
			I32_ADD();
			I64_LOAD_OFF(0);
			I64_STORE_OFF(0);
		}
		LG(LOCT_ds_ptr);
		LG(LOC_ma);
		WI32_CONST(6);
		I32_SHR_U();
		I32_ADD();
		ARENA_PTR(g_r_file_base + RXJIT_ARENA_ITEM_OFF);
		WASM_U8(0x10);
		WASM_U32(TFN_ITEM);
		ARENA_PTR(g_r_file_base + RXJIT_ARENA_ITEM_OFF);
	} else {
		LG(LOCT_ds_ptr);
		LG(LOC_ma);
		I32_ADD();
	}
	LS(LOC_tmp);
	if (g_emit_regs_in_mem) {
		for (int i = 0; i < 8; i++) {
			ARENA_BASE();
			LG(LOC_tmp);
			I64_LOAD_OFF((uint32_t)(i * 8));
			ARENA_BASE();
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
	SP_PTR(scratchpad_ptr);
	LG(LOC_sp_addr1);
	I32_ADD();
	LS(LOC_tmp);
	if (g_emit_regs_in_mem) {
		for (int i = 0; i < 8; i++) {
			LG(LOC_tmp);
			ARENA_BASE();
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
			ARENA_BASE(); // addr=0 for store
			ARENA_BASE();
			V128_LOAD_OFF(g_r_file_base + VM_F0_OFFSET + (uint32_t)(i * 16));
			ARENA_BASE();
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
	SP_PTR(scratchpad_ptr);
	LG(LOC_sp_addr0);
	I32_ADD();
	LS(LOC_tmp);
	if (g_emit_split_id) {
		for (int i = 0; i < 4; i++) {
			LG(LOC_tmp);
			ARENA_BASE();
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
	// Sentinel-terminated pointer walk. ip starts at the slot, loaded (not a
	// constant) from the sentinel record's bytes 12..15 so TurboFan can prove
	// the loop phi zero-extended (a const init costs a mov per record load).
	// Every arm ends with `ip += 16; br $L` itself (tail-duplicated back-edge,
	// no shared join); the EXIT sentinel at record #256 does `br $exit`.
	if (rxjit_inline_round_any_on(jit_feature))
		p += emit_load_round_masks(p); // once per call (256 ops); CFROUND reloads
	p += emit_load_spb(p);             // step 9: opaque scratchpad base
	if (g_shared) { // arena-relative program_slot_ptr: fold it into the offset
		LG(LOCT_arena);
		I32_LOAD_OFF(program_slot_ptr + RXJIT_ARENA_SENT_OFF - RXJIT_ARENA_SLOT_OFF + 12);
	} else {
		WI32_CONST(program_slot_ptr);
		I32_LOAD_OFF(RXJIT_ARENA_SENT_OFF - RXJIT_ARENA_SLOT_OFF + 12);
	}
	LS(LOCT_inst_ptr);
	BLOCK_VOID(); // $exit
	LOOP_VOID();  // $L
	{
		// X3 (RXJIT_FEATURE_UNROLL2): a second br_table site. Copy 0 sits
		// directly in $L like copy 1, so the CBRANCH-taken (br $L) and EXIT
		// (br $exit) depths are the same in both; its other exits and its
		// br_table default land here, at the join (ip += 16, into copy 1).
		if (jit_feature & RXJIT_FEATURE_UNROLL2) {
			g_unroll_c0 = 1;
			p += emit_inner_dispatch(scratchpad_ptr, jit_feature, p);
			g_unroll_c0 = 0;
			LG(LOCT_inst_ptr);
			WI32_CONST(16);
			I32_ADD();
			LS(LOCT_inst_ptr);
		}
		// dispatch via br_table over opcode_kind (arms load their own fields)
		p += emit_inner_dispatch(scratchpad_ptr, jit_feature, p);

		// only the br_table default lands here (never taken)
		LG(LOCT_inst_ptr);
		WI32_CONST(16);
		I32_ADD();
		LS(LOCT_inst_ptr);
		BR(0);
	}
	END_BLK(); // $L
	END_BLK(); // $exit
	THUNK_END;
}

// Emit the locals declaration shared between main_loop and inner_dispatch
// (split_id mode). Indices match wasm_jit_inst_locals.h + the LOCT_* extension.
static uint32_t emit_local_decls(int jit_feature, uint8_t *buf) {
	THUNK_BEGIN;
	// The no-FMA Dekker temps are declared only when used, so the FMA
	// (feature 7) module stays byte-identical.
	const int nofma = rxjit_inline_round_muldiv_on(jit_feature) &&
	                  !rxjit_inline_round_muldiv_fma(jit_feature);
	WASM_U8(nofma ? 12 : 11);               // local groups
	WASM_U8_THUNK({
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
	if (nofma) {
		WASM_U8(2);                         // 59..60 LOCT_fx1, fx2
		WASM_U8(WASM_TYPE_V128);
	}
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
	if (g_shared) { // shared_code: the arena base, once per call
		GG(TGLOB_arena);
		LS(LOCT_arena);
	}
	// Debug layout-pad knob (feature bits 256..1024): n dummy i32 stores into
	// the arena's pad area, each ~3 ARM64 instructions, shifting all code
	// that follows. Used to average A/B measurements over code layouts.
	{
		int pad = (jit_feature >> RXJIT_FEATURE_PAD_SHIFT) & 7;
		for (int i = 0; i < pad; i++) {
			ARENA_BASE();
			WI32_CONST(0);
			I32_STORE_OFF(vm_state_ptr + RXJIT_ARENA_PAD_OFF + 4 * i);
		}
	}
	// vm_state pointer in LOC_tmp; many arms expect this (K_FDIV_M loads mask
	// constants from it via the preloaded mask locals, but the addr load
	// helpers don't reference LOC_tmp directly — they use LOCT_inst_ptr).
	ARENA_PTR(vm_state_ptr);
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

	if (g_shared) { // shared_code: the arena base and scratchpad base, once per call
		GG(TGLOB_arena);
		LS(LOCT_arena);
		p += emit_load_spb(p);
	}
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
// Step 6: the arm count is g_k_total (base kinds + fused pair and triple kinds).
#define ARM_BR_END(k)   ((uint32_t)(g_k_total - (k) - 1))
#define ARM_BR_INNER(k) ((uint32_t)(g_k_total - (k)))

// Arm tail: advance the walk pointer by nrec records and branch straight back
// to the loop header $L (tail-duplicated back-edge). `extra` = number of
// blocks the caller has open inside the arm. X3 copy 0 (g_unroll_c0): advance
// by nrec-1 records and branch to its $end_dispatch; the join after it adds
// the last 16 and falls into copy 1.
static uint32_t emit_arm_exit(int k, int nrec, int extra, uint8_t *buf) {
	if (g_no_exit)
		return 0; // inside a fused arm: the fused arm emits one exit (ip += 32 or 48)
	THUNK_BEGIN;
	const int adv = g_unroll_c0 ? nrec - 1 : nrec;
	if (adv) {
		LG(LOCT_inst_ptr);
		WI32_CONST(16 * adv);
		I32_ADD();
		LS(LOCT_inst_ptr);
	}
	BR((g_unroll_c0 ? ARM_BR_END(k) : ARM_BR_INNER(k)) + (uint32_t)extra);
	THUNK_END;
}

// ---------------- Individual arm emitters ----------------

// All take: scratchpad_ptr, jit_feature, k (kind index, for BR depth).
// They write to *p in their caller.

// K_NOP: just exit
static uint32_t emit_arm_nop(int k, uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_arm_exit(k, 1, 0, p);
	THUNK_END;
}

// Arm shapes (layout v2): d = LOCT_dst_byte, s = LOCT_src_byte hold absolute
// operand addresses loaded by emit_ld_dst / emit_ld_src. Stores push the
// address first, then the value.

// K_IADD_RS: r[dst] = r[dst] + (r[src] << shift)
//   shift = aux & 3
static uint32_t emit_arm_iadd_rs(int k, uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_ld_dst(p);
	p += emit_ld_src(p);
	LG(LOCT_dst_byte);
	RD64(LOCT_dst_byte);
	RD64(LOCT_src_byte);
	LG(LOCT_inst_ptr);
	I32_LOAD8U_OFF(g_ro + g_d_aux);
	WI32_CONST(0x03);
	I32_AND();
	I64_EXT_I32_U();
	I64_SHL();
	I64_ADD();
	I64_STORE_OFF(0);
	p += emit_arm_exit(k, 1, 0, p);
	THUNK_END;
}

// K_IADD_RS_DISPL: r[dst] = r[dst] + (r[src] << shift) + sext(imm32)
static uint32_t emit_arm_iadd_rs_displ(int k, uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_ld_dst(p);
	p += emit_ld_src(p);
	LG(LOCT_dst_byte);
	RD64(LOCT_dst_byte);
	RD64(LOCT_src_byte);
	LG(LOCT_inst_ptr);
	I32_LOAD8U_OFF(g_ro + g_d_aux);
	WI32_CONST(0x03);
	I32_AND();
	I64_EXT_I32_U();
	I64_SHL();
	I64_ADD();
	LG(LOCT_inst_ptr);
	I64_LOAD32S_OFF(g_ro + D_IMM32);
	I64_ADD();
	I64_STORE_OFF(0);
	p += emit_arm_exit(k, 1, 0, p);
	THUNK_END;
}

// Generic "r[dst] = r[dst] OP scratchpad[L1/L2 addr]" memory load arm
static uint32_t emit_arm_alu_mem_l1l2(uint32_t scratchpad_ptr, uint32_t mask, uint8_t op, int k,
                                      uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_ld_dst(p);
	p += emit_ld_src(p);
	LG(LOCT_dst_byte);
	RD64(LOCT_dst_byte);
	p += emit_addr_l1l2(scratchpad_ptr, mask, LOCT_src_byte, p);
	I64_LOAD_OFF(0);
	WASM_U8(op);
	I64_STORE_OFF(0);
	p += emit_arm_exit(k, 1, 0, p);
	THUNK_END;
}

// Generic "r[dst] = r[dst] OP scratchpad[L3 direct addr]" memory load arm
static uint32_t emit_arm_alu_mem_l3(uint32_t scratchpad_ptr, uint8_t op, int k, uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_ld_dst(p);
	LG(LOCT_dst_byte);
	RD64(LOCT_dst_byte);
	p += emit_addr_l3_direct(scratchpad_ptr, p);
	I64_LOAD_OFF(0);
	WASM_U8(op);
	I64_STORE_OFF(0);
	p += emit_arm_exit(k, 1, 0, p);
	THUNK_END;
}

// K_ISUB_R, K_IMUL_R, K_IXOR_R, K_IROR_R, K_IROL_R: r[dst] = r[dst] OP r[src]
static uint32_t emit_arm_alu_rr(uint8_t op, int k, uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_ld_dst(p);
	p += emit_ld_src(p);
	LG(LOCT_dst_byte);
	RD64(LOCT_dst_byte);
	RD64(LOCT_src_byte);
	WASM_U8(op);
	I64_STORE_OFF(0);
	p += emit_arm_exit(k, 1, 0, p);
	THUNK_END;
}

// *_IMM variant: r[dst] = r[dst] OP sext(imm32)
static uint32_t emit_arm_alu_imm(uint8_t op, int k, uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_ld_dst(p);
	LG(LOCT_dst_byte);
	RD64(LOCT_dst_byte);
	LG(LOCT_inst_ptr);
	I64_LOAD32S_OFF(g_ro + D_IMM32);
	WASM_U8(op);
	I64_STORE_OFF(0);
	p += emit_arm_exit(k, 1, 0, p);
	THUNK_END;
}

// Inline 64x64 -> high 64 multiply (step 6). Stack [a, b] -> [hi].
// Unsigned (Hacker's Delight mulhu, 4 multiplies, no overflow anywhere):
//   t  = aH*bL + ((aL*bL) >> 32)
//   w1 = aL*bH + (t & M)
//   hi = aH*bH + (t >> 32) + (w1 >> 32)
// Signed: hi -= ((a >> 63) & b) + ((b >> 63) & a) (arithmetic shifts).
// Uses LOCT_m0..m2 (40..42, i64); never LOC_m0..m3 (i32 collisions).
// V8 does not inline the call-based stubs, so this makes the arm call-free.
#define I64_SHR_S() WASM_U8(0x87)
#define I64_SHR_U() WASM_U8(0x88)
static uint32_t emit_mulh_inline(int is_signed, uint8_t *buf) {
	THUNK_BEGIN;
	LS(LOCT_m1); // b
	LS(LOCT_m0); // a
	// t = aH*bL + ((aL*bL) >> 32)
	LG(LOCT_m0);
	WI64_CONST(32);
	I64_SHR_U();
	LG(LOCT_m1);
	WI64_CONST(0xffffffffLL);
	I64_AND();
	I64_MUL();
	LG(LOCT_m0);
	WI64_CONST(0xffffffffLL);
	I64_AND();
	LG(LOCT_m1);
	WI64_CONST(0xffffffffLL);
	I64_AND();
	I64_MUL();
	WI64_CONST(32);
	I64_SHR_U();
	I64_ADD();
	LS(LOCT_m2);
	// (aL*bH + (t & M)) >> 32
	LG(LOCT_m0);
	WI64_CONST(0xffffffffLL);
	I64_AND();
	LG(LOCT_m1);
	WI64_CONST(32);
	I64_SHR_U();
	I64_MUL();
	LG(LOCT_m2);
	WI64_CONST(0xffffffffLL);
	I64_AND();
	I64_ADD();
	WI64_CONST(32);
	I64_SHR_U();
	// + aH*bH + (t >> 32)
	LG(LOCT_m0);
	WI64_CONST(32);
	I64_SHR_U();
	LG(LOCT_m1);
	WI64_CONST(32);
	I64_SHR_U();
	I64_MUL();
	I64_ADD();
	LG(LOCT_m2);
	WI64_CONST(32);
	I64_SHR_U();
	I64_ADD();
	if (is_signed) {
		LG(LOCT_m0);
		WI64_CONST(63);
		I64_SHR_S();
		LG(LOCT_m1);
		I64_AND();
		I64_SUB();
		LG(LOCT_m1);
		WI64_CONST(63);
		I64_SHR_S();
		LG(LOCT_m0);
		I64_AND();
		I64_SUB();
	}
	THUNK_END;
}

// K_IMULH_R / K_ISMULH_R: r[dst] = mulh(r[dst], r[src])
// fn_idx: TFN_MULH = unsigned (IMULH), TFN_IMULH = signed (ISMULH).
static uint32_t emit_arm_mulh_r(uint32_t fn_idx, int k, uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_ld_dst(p);
	p += emit_ld_src(p);
	LG(LOCT_dst_byte);
	RD64(LOCT_dst_byte);
	RD64(LOCT_src_byte);
	p += emit_mulh_inline(fn_idx == TFN_IMULH, p);
	I64_STORE_OFF(0);
	p += emit_arm_exit(k, 1, 0, p);
	THUNK_END;
}

// K_IMULH_M_RR / K_ISMULH_M_RR: r[dst] = mulh(r[dst], mem_l1l2_load)
static uint32_t emit_arm_mulh_m_rr(uint32_t scratchpad_ptr, uint32_t mask, uint32_t fn_idx, int k,
                                   uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_ld_dst(p);
	p += emit_ld_src(p);
	LG(LOCT_dst_byte);
	RD64(LOCT_dst_byte);
	p += emit_addr_l1l2(scratchpad_ptr, mask, LOCT_src_byte, p);
	I64_LOAD_OFF(0);
	p += emit_mulh_inline(fn_idx == TFN_IMULH, p);
	I64_STORE_OFF(0);
	p += emit_arm_exit(k, 1, 0, p);
	THUNK_END;
}

// K_IMULH_M_DIRECT / K_ISMULH_M_DIRECT
static uint32_t emit_arm_mulh_m_direct(uint32_t scratchpad_ptr, uint32_t fn_idx, int k,
                                       uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_ld_dst(p);
	LG(LOCT_dst_byte);
	RD64(LOCT_dst_byte);
	p += emit_addr_l3_direct(scratchpad_ptr, p);
	I64_LOAD_OFF(0);
	p += emit_mulh_inline(fn_idx == TFN_IMULH, p);
	I64_STORE_OFF(0);
	p += emit_arm_exit(k, 1, 0, p);
	THUNK_END;
}

// K_IMUL_RCP: r[dst] = r[dst] * u64 reciprocal (record +8..+15)
static uint32_t emit_arm_imul_rcp(int k, uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_ld_dst(p);
	LG(LOCT_dst_byte);
	RD64(LOCT_dst_byte);
	LG(LOCT_inst_ptr);
	I64_LOAD_OFF(g_ro + D_IMM64);
	I64_MUL();
	I64_STORE_OFF(0);
	p += emit_arm_exit(k, 1, 0, p);
	THUNK_END;
}

// K_INEG_R: r[dst] = 0 - r[dst]
static uint32_t emit_arm_ineg_r(int k, uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_ld_dst(p);
	LG(LOCT_dst_byte);
	WI64_CONST(0);
	RD64(LOCT_dst_byte);
	I64_SUB();
	I64_STORE_OFF(0);
	p += emit_arm_exit(k, 1, 0, p);
	THUNK_END;
}

// K_ISWAP_R: swap r[dst], r[src]. Both loads happen before both stores
// (the decoder guarantees dst != src).
static uint32_t emit_arm_iswap_r(int k, uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_ld_dst(p);
	p += emit_ld_src(p);
	LG(LOCT_dst_byte);
	RD64(LOCT_src_byte);
	LG(LOCT_src_byte);
	RD64(LOCT_dst_byte);
	I64_STORE_OFF(0); // r[src] = old r[dst]
	I64_STORE_OFF(0); // r[dst] = old r[src]
	p += emit_arm_exit(k, 1, 0, p);
	THUNK_END;
}

// K_FSWAP_R_F / K_FSWAP_R_E: swap the two 64-bit halves of the v128 at
// dst_addr (F or E register; both arms are identical under layout v2).
static uint32_t emit_arm_fswap_r(int k, int jit_feature, uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_ld_dst(p);
	LG(LOCT_dst_byte);
	RDV(LOCT_dst_byte);
	// Step 5: constant i8x16.shuffle [8..15, 0..7] (all lanes from the first
	// operand; the second is a dummy zero). V8 lowers it to one `ext #8`
	// instead of v128.const + swizzle (about 10 instructions).
	(void)jit_feature;
	V128_ZERO();
	WASM_U8_THUNK({
		0xfd, 0x0d, // i8x16.shuffle (lane bytes are raw, not LEB)
		8, 9, 10, 11, 12, 13, 14, 15,
		0, 1, 2, 3, 4, 5, 6, 7,
	});
	V128_STORE_OFF(0);
	p += emit_arm_exit(k, 1, 0, p);
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

// K_FADD_R / K_FSUB_R: F(dst) = op(F(dst), A(src))
// K_FMUL_R:            E(dst) = mul(E(dst), A(src))
// The decoder picks the banks; the store address stays below the (v128,v128)
// block params of the fprc if, which is valid.
static uint32_t emit_arm_fbin_r(uint32_t tbl_idx, uint8_t native_op, int k, int jit_feature,
                                uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_ld_dst(p);
	p += emit_ld_src(p);
	LG(LOCT_dst_byte);
	if (native_op == 0xf2 ? rxjit_inline_round_muldiv_on(jit_feature)
	                      : rxjit_inline_round_addsub_on(jit_feature)) {
		RDV(LOCT_dst_byte);
		LS(LOCT_fa);
		RDV(LOCT_src_byte);
		LS(LOCT_fb);
		if (native_op == 0xf2 && !rxjit_inline_round_muldiv_fma(jit_feature)) {
			p += emit_nofma_mul(p); // FMUL_R -> E, Dekker residue sign
			p += emit_round_e(p);
		} else if (native_op == 0xf2) { // FMUL_R -> E: res = fma(a, b, -c)
			LG(LOCT_fa);
			LG(LOCT_fb);
			SIMD(0xf2);
			LS(LOCT_fc);
			LG(LOCT_fa);
			LG(LOCT_fb);
			LG(LOCT_fc);
			SIMD(0xed);
			SIMD(0x107);
			LS(LOCT_fr);
			p += emit_round_e(p);
		} else {
			p += emit_twosum(native_op == 0xf1, p);
			p += emit_round_f(p);
		}
	} else {
		RDV(LOCT_dst_byte);
		RDV(LOCT_src_byte);
		p += emit_fprc_dispatch(native_op, 2, tbl_idx, jit_feature, p);
	}
	V128_STORE_OFF(0);
	p += emit_arm_exit(k, 1, 0, p);
	THUNK_END;
}

// K_FADD_M_L1/L2 / K_FSUB_M_L1/L2: F(dst) = op(F(dst), load_F_from_mem)
// K_FDIV_M_L1/L2 (emask=1):         E(dst) = div(E(dst), masked load_F_from_mem)
//   load_F_from_mem = f64x2.convert_low_i32x4_s(v128.load64_zero(addr))
//   mask = scratchpad L1/L2 address mask (baked per kind)
static uint32_t emit_arm_fbin_m(uint32_t scratchpad_ptr, uint32_t mask, uint32_t tbl_idx,
                                uint8_t native_op, int emask, int k, int jit_feature,
                                uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_ld_dst(p);
	p += emit_ld_src(p);
	LG(LOCT_dst_byte);
	RDV(LOCT_dst_byte);
	const int inl = native_op == 0xf3 ? rxjit_inline_round_muldiv_on(jit_feature)
	                                  : rxjit_inline_round_addsub_on(jit_feature);
	if (inl)
		LS(LOCT_fa);
	p += emit_addr_l1l2(scratchpad_ptr, mask, LOCT_src_byte, p);
	WASM_U8_THUNK({0xfd, 0x5d, 3, 0});  // v128.load64_zero align=3 offset=0
	WASM_U8_THUNK({0xfd, 0xfe, 0x01}); // f64x2.convert_low_i32x4_s
	if (emask) {
		LG(LOC_mask_mant);
		WASM_U8_THUNK({0xfd, 0x4e}); // v128.and
		LG(LOC_mask_exp);
		WASM_U8_THUNK({0xfd, 0x50}); // v128.or
	}
	if (inl) {
		LS(LOCT_fb);
		if (native_op == 0xf3 && !rxjit_inline_round_muldiv_fma(jit_feature)) {
			p += emit_nofma_div(p); // FDIV_M -> E, Dekker residue sign
			p += emit_round_e(p);
		} else if (native_op == 0xf3) { // FDIV_M -> E: res = a - c*b
			LG(LOCT_fa);
			LG(LOCT_fb);
			SIMD(0xf3);
			LS(LOCT_fc);
			LG(LOCT_fc);
			LG(LOCT_fb);
			LG(LOCT_fa);
			SIMD(0x108);
			LS(LOCT_fr);
			p += emit_round_e(p);
		} else {
			p += emit_twosum(native_op == 0xf1, p);
			p += emit_round_f(p);
		}
	} else {
		p += emit_fprc_dispatch(native_op, 2, tbl_idx, jit_feature, p);
	}
	V128_STORE_OFF(0);
	p += emit_arm_exit(k, 1, 0, p);
	THUNK_END;
}

// K_FSCAL_R: F(dst) = F(dst) ^ (0x80F0000000000000 x 2)
static uint32_t emit_arm_fscal_r(int k, uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_ld_dst(p);
	LG(LOCT_dst_byte);
	RDV(LOCT_dst_byte);
	WASM_U8_THUNK({
		0xfd, 0x0c,
		0, 0, 0, 0, 0, 0, 0xf0, 0x80,
		0, 0, 0, 0, 0, 0, 0xf0, 0x80,
	});     // v128.const i64x2(0x80F0_0000_0000_0000 x2)
	WASM_U8_THUNK({0xfd, 0x51}); // v128.xor
	V128_STORE_OFF(0);
	p += emit_arm_exit(k, 1, 0, p);
	THUNK_END;
}

// K_FSQRT_R: E(dst) = sqrt(E(dst))
static uint32_t emit_arm_fsqrt_r(int k, int jit_feature, uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_ld_dst(p);
	LG(LOCT_dst_byte);
	RDV(LOCT_dst_byte);
	if (rxjit_inline_round_muldiv_on(jit_feature) && !rxjit_inline_round_muldiv_fma(jit_feature)) {
		LS(LOCT_fa);
		p += emit_nofma_sqrt(p); // Dekker residue sign
		p += emit_round_e(p);
	} else if (rxjit_inline_round_muldiv_on(jit_feature)) { // res = a - c*c
		LS(LOCT_fa);
		LG(LOCT_fa);
		SIMD(0xef);
		LS(LOCT_fc);
		LG(LOCT_fc);
		LG(LOCT_fc);
		LG(LOCT_fa);
		SIMD(0x108);
		LS(LOCT_fr);
		p += emit_round_e(p);
	} else {
		p += emit_fprc_dispatch(0xef /* f64x2.sqrt */, 3, TBL_FSQRT, jit_feature, p);
	}
	V128_STORE_OFF(0);
	p += emit_arm_exit(k, 1, 0, p);
	THUNK_END;
}

// K_CBRANCH: r[dst] += sext(imm) (composed); if (r[dst] & mask) == 0, jump to
//            target record; else fall through to the next record.
// +8 holds the int32 imm here, never a src address: no emit_ld_src.
// mask = 0xff << b with b <= 23 fits in 31 bits, so the test is done in i32.
static uint32_t emit_arm_cbranch(int k, uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_ld_dst(p);
	LG(LOCT_dst_byte);
	RD64(LOCT_dst_byte);
	LG(LOCT_inst_ptr);
	I64_LOAD32S_OFF(g_ro + D_CBIMM);
	I64_ADD();
	LT(LOCT_tmp64_b);
	I64_STORE_OFF(0);
	LG(LOCT_tmp64_b);
	I32_WRAP_I64();
	LG(LOCT_inst_ptr);
	I32_LOAD_OFF(g_ro + D_IMM32);
	I32_AND();
	I32_EQZ();
	WASM_U8_THUNK({0x04, 0x40}); // if () -> ()
	// ip = slot + (target_pc << 4)
	LG(LOCT_inst_ptr);
	I32_LOAD8U_OFF(g_ro + g_d_aux);
	WI32_CONST(4);
	I32_SHL();
	ARENA_PTR(g_slot);
	I32_ADD();
	LS(LOCT_inst_ptr);
	BR(ARM_BR_INNER(k) + 1); // +1 for the if block
	END_BLK();               // end of if
	p += emit_arm_exit(k, 1, 0, p);
	THUNK_END;
}

// K_CFROUND: fprc = (r[src] rotr imm) & 3. The decoder pre-masks imm & 63
// (and i64.rotr is mod 64 anyway).
static uint32_t emit_arm_cfround(int k, int jit_feature, uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_ld_src(p);
	RD64(LOCT_src_byte);
	LG(LOCT_inst_ptr);
	I64_LOAD32U_OFF(g_ro + D_IMM32);
	I64_ROTR();
	I32_WRAP_I64();
	WI32_CONST(3);
	I32_AND();
	GS(TGLOB_fprc);
	if (rxjit_inline_round_any_on(jit_feature))
		p += emit_load_round_masks(p);
	p += emit_arm_exit(k, 1, 0, p);
	THUNK_END;
}

// K_ISTORE_L1 / K_ISTORE_L2: store r[src] to scratchpad[(imm + r[dst]) & mask]
//   Note: here dst is the address-source register, src is the value-source.
static uint32_t emit_arm_istore_l12(uint32_t scratchpad_ptr, uint32_t mask, int k, uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_ld_dst(p);
	p += emit_ld_src(p);
	p += emit_addr_l1l2(scratchpad_ptr, mask, LOCT_dst_byte, p);
	RD64(LOCT_src_byte);
	I64_STORE_OFF(0);
	p += emit_arm_exit(k, 1, 0, p);
	THUNK_END;
}

// K_ISTORE_L3
static uint32_t emit_arm_istore_l3(uint32_t scratchpad_ptr, int k, uint8_t *buf) {
	THUNK_BEGIN;
	p += emit_ld_dst(p);
	p += emit_ld_src(p);
	p += emit_addr_l3_reg(scratchpad_ptr, LOCT_dst_byte, p);
	RD64(LOCT_src_byte);
	I64_STORE_OFF(0);
	p += emit_arm_exit(k, 1, 0, p);
	THUNK_END;
}

// ---------------- The dispatch itself ----------------

// Body of one arm: `kind` selects the code, `k` is the arm position (used
// for branch depths). k == kind for base kinds; for a fused arm k is the
// fused kind and this is called once per part (step 6 pairs, X2 triples).
static uint32_t emit_arm_kind(int kind, int k, uint32_t scratchpad_ptr, int jit_feature,
                              uint8_t *buf) {
	THUNK_BEGIN;
	switch (kind) {
	case RXJIT_K_NOP:
		p += emit_arm_nop(k, p);
		break;
	case RXJIT_K_IADD_RS:
		p += emit_arm_iadd_rs(k, p);
		break;
	case RXJIT_K_IADD_RS_DISPL:
		p += emit_arm_iadd_rs_displ(k, p);
		break;
	case RXJIT_K_IADD_M_L1:
		p += emit_arm_alu_mem_l1l2(scratchpad_ptr, SCRATCHPAD_L1_MASK, 0x7c /*add*/, k, p);
		break;
	case RXJIT_K_IADD_M_L2:
		p += emit_arm_alu_mem_l1l2(scratchpad_ptr, SCRATCHPAD_L2_MASK, 0x7c /*add*/, k, p);
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
	case RXJIT_K_ISUB_M_L1:
		p += emit_arm_alu_mem_l1l2(scratchpad_ptr, SCRATCHPAD_L1_MASK, 0x7d, k, p);
		break;
	case RXJIT_K_ISUB_M_L2:
		p += emit_arm_alu_mem_l1l2(scratchpad_ptr, SCRATCHPAD_L2_MASK, 0x7d, k, p);
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
	case RXJIT_K_IMUL_M_L1:
		p += emit_arm_alu_mem_l1l2(scratchpad_ptr, SCRATCHPAD_L1_MASK, 0x7e, k, p);
		break;
	case RXJIT_K_IMUL_M_L2:
		p += emit_arm_alu_mem_l1l2(scratchpad_ptr, SCRATCHPAD_L2_MASK, 0x7e, k, p);
		break;
	case RXJIT_K_IMUL_M_DIRECT:
		p += emit_arm_alu_mem_l3(scratchpad_ptr, 0x7e, k, p);
		break;
	case RXJIT_K_IMULH_R:
		p += emit_arm_mulh_r(TFN_MULH, k, p);
		break;
	case RXJIT_K_IMULH_M_L1:
		p += emit_arm_mulh_m_rr(scratchpad_ptr, SCRATCHPAD_L1_MASK, TFN_MULH, k, p);
		break;
	case RXJIT_K_IMULH_M_L2:
		p += emit_arm_mulh_m_rr(scratchpad_ptr, SCRATCHPAD_L2_MASK, TFN_MULH, k, p);
		break;
	case RXJIT_K_IMULH_M_DIRECT:
		p += emit_arm_mulh_m_direct(scratchpad_ptr, TFN_MULH, k, p);
		break;
	case RXJIT_K_ISMULH_R:
		p += emit_arm_mulh_r(TFN_IMULH, k, p);
		break;
	case RXJIT_K_ISMULH_M_L1:
		p += emit_arm_mulh_m_rr(scratchpad_ptr, SCRATCHPAD_L1_MASK, TFN_IMULH, k, p);
		break;
	case RXJIT_K_ISMULH_M_L2:
		p += emit_arm_mulh_m_rr(scratchpad_ptr, SCRATCHPAD_L2_MASK, TFN_IMULH, k, p);
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
	case RXJIT_K_IXOR_M_L1:
		p += emit_arm_alu_mem_l1l2(scratchpad_ptr, SCRATCHPAD_L1_MASK, 0x85, k, p);
		break;
	case RXJIT_K_IXOR_M_L2:
		p += emit_arm_alu_mem_l1l2(scratchpad_ptr, SCRATCHPAD_L2_MASK, 0x85, k, p);
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
		p += emit_arm_fswap_r(k, jit_feature, p);
		break;
	case RXJIT_K_FSWAP_R_E:
		p += emit_arm_fswap_r(k, jit_feature, p);
		break;
	case RXJIT_K_FADD_R:
		p += emit_arm_fbin_r(TBL_FADD, 0xf0 /* f64x2.add */, k, jit_feature, p);
		break;
	case RXJIT_K_FADD_M_L1:
		p += emit_arm_fbin_m(scratchpad_ptr, SCRATCHPAD_L1_MASK, TBL_FADD, 0xf0, 0, k, jit_feature, p);
		break;
	case RXJIT_K_FADD_M_L2:
		p += emit_arm_fbin_m(scratchpad_ptr, SCRATCHPAD_L2_MASK, TBL_FADD, 0xf0, 0, k, jit_feature, p);
		break;
	case RXJIT_K_FSUB_R:
		p += emit_arm_fbin_r(TBL_FSUB, 0xf1 /* f64x2.sub */, k, jit_feature, p);
		break;
	case RXJIT_K_FSUB_M_L1:
		p += emit_arm_fbin_m(scratchpad_ptr, SCRATCHPAD_L1_MASK, TBL_FSUB, 0xf1, 0, k, jit_feature, p);
		break;
	case RXJIT_K_FSUB_M_L2:
		p += emit_arm_fbin_m(scratchpad_ptr, SCRATCHPAD_L2_MASK, TBL_FSUB, 0xf1, 0, k, jit_feature, p);
		break;
	case RXJIT_K_FSCAL_R:
		p += emit_arm_fscal_r(k, p);
		break;
	case RXJIT_K_FMUL_R:
		p += emit_arm_fbin_r(TBL_FMUL, 0xf2 /* f64x2.mul */, k, jit_feature, p);
		break;
	case RXJIT_K_FDIV_M_L1:
		p += emit_arm_fbin_m(scratchpad_ptr, SCRATCHPAD_L1_MASK, TBL_FDIV, 0xf3 /* f64x2.div */, 1, k, jit_feature, p);
		break;
	case RXJIT_K_FDIV_M_L2:
		p += emit_arm_fbin_m(scratchpad_ptr, SCRATCHPAD_L2_MASK, TBL_FDIV, 0xf3 /* f64x2.div */, 1, k, jit_feature, p);
		break;
	case RXJIT_K_FSQRT_R:
		p += emit_arm_fsqrt_r(k, jit_feature, p);
		break;
	case RXJIT_K_CBRANCH:
		p += emit_arm_cbranch(k, p);
		break;
	case RXJIT_K_CFROUND:
		p += emit_arm_cfround(k, jit_feature, p);
		break;
	case RXJIT_K_ISTORE_L1:
		p += emit_arm_istore_l12(scratchpad_ptr, SCRATCHPAD_L1_MASK, k, p);
		break;
	case RXJIT_K_ISTORE_L2:
		p += emit_arm_istore_l12(scratchpad_ptr, SCRATCHPAD_L2_MASK, k, p);
		break;
	case RXJIT_K_ISTORE_L3:
		p += emit_arm_istore_l3(scratchpad_ptr, k, p);
		break;
	case RXJIT_K_EXIT:
		BR(ARM_BR_INNER(k) + 1); // $exit (sentinel record #256)
		break;
	default:
		p += emit_arm_nop(k, p);
		break;
	}
	THUNK_END;
}

static uint32_t emit_inner_dispatch(uint32_t scratchpad_ptr, int jit_feature, uint8_t *buf) {
	THUNK_BEGIN;
	const int KT = g_k_total; // RXJIT_K_COUNT base kinds + fused pair and triple kinds

	// Open KT+1 blocks ($end_dispatch + arm_0..arm_{KT-1})
	for (int i = 0; i < KT + 1; i++)
		BLOCK_VOID();

	// load opcode_kind and dispatch
	LG(LOCT_inst_ptr);
	if (g_kind16)
		I32_LOAD16U_OFF(D_OP);
	else
		I32_LOAD8U_OFF(D_OP);
	WASM_U8(0x0e);          // br_table opcode
	WASM_U32((uint32_t)KT); // count of labels
	for (int i = 0; i < KT; i++)
		WASM_U32((uint32_t)i);
	WASM_U32((uint32_t)KT); // default → $end_dispatch

	// arm_0..arm_{KT-1} bodies. After closing arm_k's block, we're at
	// the position where br_table label k landed.
	for (int k = 0; k < KT; k++) {
		END_BLK();
		if (k < RXJIT_K_COUNT) {
			p += emit_arm_kind(k, k, scratchpad_ptr, jit_feature, p);
			continue;
		}
		// Step 6: fused pair: record r as kind a, record r+1 (at +16) as kind
		// b, then ip += 32. X2: a fused triple (kinds after the pairs) also
		// runs record r+2 (at +32) as kind c, then ip += 48. A taken CBRANCH
		// in any part branches to $L itself; its not-taken exit is suppressed
		// like every other exit, so it falls through to the next part.
		const int j = k - RXJIT_K_COUNT - g_fuse_n; // >= 0: triple j
		const uint8_t *part = j < 0 ? rxjit_fuse_pairs[k - RXJIT_K_COUNT] : rxjit_fuse_triples[j];
		const int nrec = j < 0 ? 2 : 3;
		g_no_exit = 1;
		for (int i = 0; i < nrec; i++) {
			g_ro = 16u * (uint32_t)i;
			p += emit_arm_kind(part[i], k, scratchpad_ptr, jit_feature, p);
		}
		g_no_exit = 0;
		g_ro = 0;
		p += emit_arm_exit(k, nrec, 0, p);
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
		WASM_U8(g_light_fn_len ? 5 : 4);                               \
		WASM_U8_THUNK({                                                \
			0x60, 0, 0,                                                \
			0x60, 2, WASM_TYPE_I64, WASM_TYPE_I64, 1, WASM_TYPE_I64,   \
			0x60, 2, WASM_TYPE_V128, WASM_TYPE_V128, 1, WASM_TYPE_V128,\
			0x60, 1, WASM_TYPE_V128, 1, WASM_TYPE_V128,                \
		});                                                            \
		if (g_light_fn_len && g_light_mlp == 2) {                      \
			/* TTYPE_ITEM: item_pair (i32, i32, i32) -> () */          \
			WASM_U8_THUNK({0x60, 3, WASM_TYPE_I32, WASM_TYPE_I32,      \
			               WASM_TYPE_I32, 0});                         \
		} else if (g_light_fn_len) { /* TTYPE_ITEM: (i32, i32) -> () */\
			WASM_U8_THUNK({0x60, 2, WASM_TYPE_I32, WASM_TYPE_I32, 0}); \
		}                                                              \
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
	int fuse_n,
	int triples_n,
	int kind16,
	int shared_code,
	uint8_t *buf)
{
	// Per-thread module-gen flags. VM_R0_OFFSET is 0, so r_file_base == vm_state_ptr.
	// split_id implies regs_in_memory (F/E/A go through memory too).
	// Step 2 (record layout v2): records carry absolute operand addresses,
	// which only the split + registers-in-memory arms can consume. The
	// non-split and registers-in-locals variants are retired; the two
	// parameters are accepted and ignored.
	(void)regs_in_memory;
	(void)split_inner_dispatch;
	g_emit_split_id    = 1;
	g_emit_regs_in_mem = 1;
	g_ro               = 0;
	g_no_exit          = 0;
	g_unroll_c0        = 0;
	g_k_total          = RXJIT_K_COUNT + fuse_n + triples_n;
	g_fuse_n           = fuse_n;
	g_kind16           = kind16;
	g_d_aux            = kind16 ? 2 : 1;
	g_shared           = shared_code != 0;
	if (g_shared) {
		// Arena-relative from here on (vm_state is the arena base); the
		// scratchpad base comes from the arena's SPB slot, the dataset from
		// vm_state (ds_ptr), so neither is baked.
		vm_state_ptr     = RXJIT_ARENA_VM_OFF;
		program_slot_ptr = RXJIT_ARENA_SLOT_OFF;
		scratchpad_ptr   = 0;
		dataset_ptr      = 0;
	}
	g_r_file_base      = vm_state_ptr + VM_R0_OFFSET;
	g_slot             = program_slot_ptr;

	const int split = g_emit_split_id;
	const uint8_t fn_main_loop_idx = split ? TFN_MAIN_LOOP_SPLIT : TFN_MAIN_LOOP;

	THUNK_BEGIN;

	WASM_MAGIC();
	EMIT_TYPE_SECTION_T();

	// import section: memory only
	WASM_SECTION(WASM_SECTION_IMPORT, {
		WASM_U8_THUNK({1, 1, 'e', 1, 'm', 0x02, RXJIT_MEM_FLAG});
		WASM_U32(mem_min_pages);
		WASM_U32(mem_max_pages);
	});

	// function section: 23 (or 24 in split_id) functions: 22 stubs + [inner_dispatch] + main_loop
	WASM_SECTION(WASM_SECTION_FUNCTION, {
		if (split) {
			WASM_U8(g_light_fn_len ? 25 : 24);
			WASM_U8_THUNK({
				1, 1,                                           // mulh, imulh
				2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, // fadd/fsub/fmul/fdiv type 2
				3, 3, 3, 3,                                     // fsqrt type 3
				0,                                              // inner_dispatch type 0
				0,                                              // main_loop type 0
			});
			if (g_light_fn_len) WASM_U8(TTYPE_ITEM);        // light: item (TFN_ITEM)
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

	// global section: 1 mutable i32 (fprc) init 0; shared_code adds the
	// mutable i32 arena base (TGLOB_arena) init 0
	WASM_SECTION(WASM_SECTION_GLOBAL, {
		WASM_U8(g_shared ? 2 : 1);
		WASM_U8_THUNK({WASM_TYPE_I32, 0x01, 0x41, 0x00, 0x0b});
		if (g_shared) { // (WASM_U8_THUNK is two statements)
			WASM_U8_THUNK({WASM_TYPE_I32, 0x01, 0x41, 0x00, 0x0b});
		}
	});

	// export section: "d" → main_loop (index depends on split); shared_code
	// also exports global "a" (TGLOB_arena) for rxjit_js_run_threaded to set
	WASM_SECTION(WASM_SECTION_EXPORT, {
		WASM_U8(g_shared ? 2 : 1);
		WASM_U8(1); WASM_U8('d'); WASM_U8(0x00);
		WASM_U8(fn_main_loop_idx);
		if (g_shared) {
			WASM_U8(1); WASM_U8('a'); WASM_U8(0x03);
			WASM_U8(TGLOB_arena);
		}
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
		WASM_U8((split ? 24 : 23) + (g_light_fn_len ? 1 : 0)); // function count
		p += emit_stub_bodies(jit_feature, p);    // stubs 0..21
		if (split) {
			// inner_dispatch function body (index 22 when split is on)
			WASM_U32_PATCH({
				p += emit_local_decls(jit_feature, p);
				p += emit_inner_dispatch_fn(vm_state_ptr, scratchpad_ptr,
				                            program_slot_ptr, jit_feature, p);
				WASM_U8(0x0b);                      // end of function
			});
		}
		// main_loop function body (index 22 or 23)
		WASM_U32_PATCH({
			p += emit_local_decls(jit_feature, p);
			p += emit_main_loop_body(vm_state_ptr, scratchpad_ptr, dataset_ptr,
			                         program_slot_ptr, jit_feature, p);
			WASM_U8(0x0b);                          // end of function
		});
		if (g_light_fn_len) { // light: item function body (index TFN_ITEM)
			WASM_U32_PATCH({
				memcpy(p, g_light_fn, g_light_fn_len);
				p += g_light_fn_len;
			});
		}
	});

	THUNK_END;
}
// clang-format on
