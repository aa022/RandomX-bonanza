// Phase D: SuperscalarHash WASM kernel generator.
//
// The generated module:
//   imports     e.m  (shared memory; non-shared in randomx_st, RXJIT_MEM_FLAG)
//   functions   0   mulh   (stub from jit_stubs/mulh.h, i64,i64 -> i64)
//               1   smulh  (stub)
//               2   k      (the kernel; (i32,i32) -> () exported as "k")
//
// Locals layout inside k (param locals first, then declared groups):
//   0   startItem      (i32, param)
//   1   count          (i32, param)
//   2   item           (i32)
//   3   endItem        (i32)
//   4   out            (i32)  pointer into dataset[item*64]
//   5   mixBlock       (i32)
//   6   r0..r7         (i64 ×8) → indices 6..13
//   14  registerValue  (i64)
//   15  tmp64          (i64) scratch
#include "wasm_jit_superscalar.h"
#include "wasm_jit_macros.h"
#include "superscalar.hpp"
#include "common.hpp"
#include "configuration.h"
#include <string.h>

// Pull in mulh stubs at the right FUNC_OFFSET. mulh is fn 0, smulh is fn 1
// (mulh internally calls mul128hi which equals fn 0 + offset, so offset=0).
#define FUNC_OFFSET 0
#include "jit_stubs/mulh.h"

namespace {

// Constants from dataset.cpp (need to match exactly — these are part of the
// RandomX standard, not arbitrary).
constexpr uint64_t superscalarMul0 = 6364136223846793005ULL;
constexpr uint64_t superscalarAdd1 = 9298411001130361340ULL;
constexpr uint64_t superscalarAdd2 = 12065312585734608966ULL;
constexpr uint64_t superscalarAdd3 = 9306329213124626780ULL;
constexpr uint64_t superscalarAdd4 = 5281919268842080866ULL;
constexpr uint64_t superscalarAdd5 = 10536153434571861004ULL;
constexpr uint64_t superscalarAdd6 = 3398623926847679864ULL;
constexpr uint64_t superscalarAdd7 = 9549104520008361294ULL;

// cache item mask (CacheSize/CacheLineSize - 1). With CacheSize=256 MiB,
// CacheLineSize=64, mask = 4194303 = 0x3FFFFF.
constexpr uint64_t CACHE_ITEM_MASK = (randomx::CacheSize / randomx::CacheLineSize) - 1;

// Local indices in the kernel function.
constexpr int LK_startItem = 0;
constexpr int LK_count = 1;
constexpr int LK_item = 2;
constexpr int LK_endItem = 3;
constexpr int LK_out = 4;
constexpr int LK_mixBlock = 5;
constexpr int LK_r0 = 6; // r0..r7 = 6..13
constexpr int LK_registerVal = 14;
constexpr int LK_tmp64 = 15;

// Function indices in the kernel module.
constexpr int FN_MULH = 0;
constexpr int FN_SMULH = 1;
constexpr int FN_KERNEL = 2;

// Helper to emit r-local access for one of the 8 r-registers.
static inline int RREG(int idx) {
	return LK_r0 + idx;
}

// ---------- Macros ----------

#define WI32_CONST(v)                    \
	do {                                 \
		WASM_U8(0x41);                   \
		WASM_I64((int64_t)(int32_t)(v)); \
	} while (0)
#define WI64_CONST(v)           \
	do {                        \
		WASM_U8(0x42);          \
		WASM_I64((int64_t)(v)); \
	} while (0)
#define LG(n)                    \
	do {                         \
		WASM_U8(0x20);           \
		WASM_U32((uint32_t)(n)); \
	} while (0)
#define LS(n)                    \
	do {                         \
		WASM_U8(0x21);           \
		WASM_U32((uint32_t)(n)); \
	} while (0)
#define LT(n)                    \
	do {                         \
		WASM_U8(0x22);           \
		WASM_U32((uint32_t)(n)); \
	} while (0)

#define I32_ADD()       WASM_U8(0x6a)
#define I32_SHL()       WASM_U8(0x74)
#define I32_LT_U()      WASM_U8(0x49)
#define I32_WRAP_I64()  WASM_U8(0xa7)
#define I64_ADD()       WASM_U8(0x7c)
#define I64_SUB()       WASM_U8(0x7d)
#define I64_MUL()       WASM_U8(0x7e)
#define I64_AND()       WASM_U8(0x83)
#define I64_XOR()       WASM_U8(0x85)
#define I64_SHL()       WASM_U8(0x86)
#define I64_ROTR()      WASM_U8(0x8a)
#define I64_EXT_I32_U() WASM_U8(0xad)
#define LOOP_VOID()                 \
	do {                            \
		WASM_U8_THUNK({0x03, 0x40}); \
	} while (0)
#define END_BLK() WASM_U8(0x0b)
#define BR_IF(n)                 \
	do {                         \
		WASM_U8(0x0d);           \
		WASM_U32((uint32_t)(n)); \
	} while (0)
#define I64_LOAD_OFF(off)          \
	do {                           \
		WASM_U8(0x29);             \
		WASM_U8(3);                \
		WASM_U32((uint32_t)(off)); \
	} while (0)
#define I64_STORE_OFF(off)         \
	do {                           \
		WASM_U8(0x37);             \
		WASM_U8(3);                \
		WASM_U32((uint32_t)(off)); \
	} while (0)

// ---------- Per-instruction emission ----------

// Emit code for one decoded SuperscalarHash instruction.
//   Side effect on the operand stack: none (each emit is balanced).
//   Reads/writes the r0..r7 locals at indices LK_r0..LK_r7.
static uint32_t emit_super_inst(const randomx::DecodedSuperscalarInst &d, uint8_t *buf) {
	THUNK_BEGIN;
	using ST = randomx::SuperscalarInstructionType;
	const int rd = RREG(d.dst);
	const int rs = RREG(d.src);
	switch ((ST)d.op) {
	case ST::ISUB_R:
		LG(rd);
		LG(rs);
		I64_SUB();
		LS(rd);
		break;
	case ST::IXOR_R:
		LG(rd);
		LG(rs);
		I64_XOR();
		LS(rd);
		break;
	case ST::IADD_RS:
		LG(rd);
		LG(rs);
		WI64_CONST((int64_t)d.shift);
		I64_SHL();
		I64_ADD();
		LS(rd);
		break;
	case ST::IMUL_R:
		LG(rd);
		LG(rs);
		I64_MUL();
		LS(rd);
		break;
	case ST::IROR_C:
		LG(rd);
		WI64_CONST((int64_t)d.imm);
		I64_ROTR();
		LS(rd);
		break;
	case ST::IADD_C7:
	case ST::IADD_C8:
	case ST::IADD_C9:
		LG(rd);
		WI64_CONST((int64_t)d.imm);
		I64_ADD();
		LS(rd);
		break;
	case ST::IXOR_C7:
	case ST::IXOR_C8:
	case ST::IXOR_C9:
		LG(rd);
		WI64_CONST((int64_t)d.imm);
		I64_XOR();
		LS(rd);
		break;
	case ST::IMULH_R:
		LG(rd);
		LG(rs);
		WASM_U8(0x10);
		WASM_U32(FN_MULH); // call $mulh
		LS(rd);
		break;
	case ST::ISMULH_R:
		LG(rd);
		LG(rs);
		WASM_U8(0x10);
		WASM_U32(FN_SMULH); // call $smulh
		LS(rd);
		break;
	case ST::IMUL_RCP:
		LG(rd);
		WI64_CONST((int64_t)d.imm);
		I64_MUL();
		LS(rd);
		break;
	default:
		break; // unknown opcode → skip (the cache loader should never emit these)
	}
	THUNK_END;
}

// Emit body of one SuperscalarHash program (no surrounding control flow).
static uint32_t emit_super_program(const randomx::DecodedSuperscalarProgram &prog, uint8_t *buf) {
	THUNK_BEGIN;
	for (uint32_t j = 0; j < prog.size; ++j) {
		p += emit_super_inst(prog.insts[j], p);
	}
	THUNK_END;
}

// Emit the cache-mix-block address computation, leaving mixBlock in LK_mixBlock.
//   mixBlock = cache_base + ((registerValue & CACHE_ITEM_MASK) * 64)
static uint32_t emit_mix_addr(uint32_t cache_base, uint8_t *buf) {
	THUNK_BEGIN;
	LG(LK_registerVal);
	WI64_CONST((int64_t)CACHE_ITEM_MASK);
	I64_AND();
	I32_WRAP_I64();
	WI32_CONST(6);
	I32_SHL();
	WI32_CONST(cache_base);
	I32_ADD();
	LS(LK_mixBlock);
	THUNK_END;
}

// Emit the cache-line XOR: r[q] ^= load64(mixBlock + q*8) for q in 0..8.
static uint32_t emit_mix_xor(uint8_t *buf) {
	THUNK_BEGIN;
	for (int q = 0; q < 8; ++q) {
		LG(RREG(q));
		LG(LK_mixBlock);
		I64_LOAD_OFF((uint32_t)(q * 8));
		I64_XOR();
		LS(RREG(q));
	}
	THUNK_END;
}

// Emit r-register initialization at the top of each item iteration.
//   r0 = (item + 1) * superscalarMul0
//   r1 = r0 ^ superscalarAdd1
//   ...
//   r7 = r0 ^ superscalarAdd7
//   registerValue = item (i64)
static uint32_t emit_item_init(uint8_t *buf) {
	THUNK_BEGIN;
	// r0 = (item+1) * Mul0
	LG(LK_item);
	WI32_CONST(1);
	I32_ADD();
	I64_EXT_I32_U();
	WI64_CONST((int64_t)superscalarMul0);
	I64_MUL();
	LS(RREG(0));
	// r1..r7 = r0 ^ AddN
	static const uint64_t adds[7] = {
	    superscalarAdd1, superscalarAdd2, superscalarAdd3, superscalarAdd4,
	    superscalarAdd5, superscalarAdd6, superscalarAdd7,
	};
	for (int i = 0; i < 7; ++i) {
		LG(RREG(0));
		WI64_CONST((int64_t)adds[i]);
		I64_XOR();
		LS(RREG(i + 1));
	}
	// registerValue = item (i64)
	LG(LK_item);
	I64_EXT_I32_U();
	LS(LK_registerVal);
	THUNK_END;
}

// Emit dataset store: mem[out + q*8] = r[q] for q in 0..8.
static uint32_t emit_dataset_store(uint8_t *buf) {
	THUNK_BEGIN;
	for (int q = 0; q < 8; ++q) {
		LG(LK_out);
		LG(RREG(q));
		I64_STORE_OFF((uint32_t)(q * 8));
	}
	THUNK_END;
}

// Emit the body of the kernel function (no locals declaration, no end byte).
static uint32_t emit_kernel_body(const randomx::DecodedSuperscalarProgram programs[],
                                 uint32_t cache_base, uint32_t dataset_base, uint8_t *buf) {
	THUNK_BEGIN;
	// endItem = startItem + count
	LG(LK_startItem);
	LG(LK_count);
	I32_ADD();
	LS(LK_endItem);
	// out = dataset_base + startItem * 64
	WI32_CONST(dataset_base);
	LG(LK_startItem);
	WI32_CONST(6);
	I32_SHL();
	I32_ADD();
	LS(LK_out);
	// item = startItem
	LG(LK_startItem);
	LS(LK_item);

	// outer loop
	LOOP_VOID();
	{
		p += emit_item_init(p);

		// For each of RANDOMX_CACHE_ACCESSES programs:
		for (int i = 0; i < RANDOMX_CACHE_ACCESSES; ++i) {
			const auto &prog = programs[i];
			// mixBlock = cache + (registerValue & mask) * 64
			p += emit_mix_addr(cache_base, p);
			// execute program (inlined)
			p += emit_super_program(prog, p);
			// r[q] ^= mem[mixBlock + q*8]
			p += emit_mix_xor(p);
			// registerValue = r[addrReg]
			LG(RREG(prog.addrReg));
			LS(LK_registerVal);
		}

		// store r[0..7] to dataset
		p += emit_dataset_store(p);

		// out += 64
		LG(LK_out);
		WI32_CONST(64);
		I32_ADD();
		LS(LK_out);
		// item += 1; if item < endItem, br 0 (continue outer)
		LG(LK_item);
		WI32_CONST(1);
		I32_ADD();
		LT(LK_item);
		LG(LK_endItem);
		I32_LT_U();
		BR_IF(0);
	}
	END_BLK();
	THUNK_END;
}

// ---------- Module envelope ----------

// WASM_SECTION(...) confuses clang-format-19 into runaway indentation;
// wrap the module-builder so the section layout survives a format pass.
// clang-format off

// Type section: 2 types.
//   type 0: (i64, i64) -> i64    — mulh / smulh
//   type 1: (i32, i32) -> ()     — kernel
#define EMIT_TYPE_SECTION_S()                                          \
	WASM_SECTION(WASM_SECTION_TYPE, {                                  \
		WASM_U8_THUNK({                                                \
			2,                                                         \
			0x60, 2, WASM_TYPE_I64, WASM_TYPE_I64, 1, WASM_TYPE_I64,   \
			0x60, 2, WASM_TYPE_I32, WASM_TYPE_I32, 0,                  \
		});                                                            \
	})

}  // namespace

extern "C" uint32_t rxjit_generate_superscalar_kernel(
	const randomx::DecodedSuperscalarProgram programs[],
	uint32_t cache_base,
	uint32_t dataset_base,
	uint32_t mem_min_pages,
	uint32_t mem_max_pages,
	uint8_t* buf)
{
	THUNK_BEGIN;

	WASM_MAGIC();
	EMIT_TYPE_SECTION_S();

	// import section: memory only
	WASM_SECTION(WASM_SECTION_IMPORT, {
		WASM_U8_THUNK({1, 1, 'e', 1, 'm', 0x02, RXJIT_MEM_FLAG});
		WASM_U32(mem_min_pages);
		WASM_U32(mem_max_pages);
	});

	// function section: 3 functions
	WASM_SECTION(WASM_SECTION_FUNCTION, {
		WASM_U8_THUNK({
			3,
			0,   // mulh:  type 0
			0,   // smulh: type 0
			1,   // kernel: type 1
		});
	});

	// export section: just "k" → kernel (fn 2)
	WASM_SECTION(WASM_SECTION_EXPORT, {
		WASM_U8(1);
		WASM_U8(1); WASM_U8('k'); WASM_U8(0x00); WASM_U8(FN_KERNEL);
	});

	// code section: 3 function bodies
	WASM_SECTION(WASM_SECTION_CODE, {
		WASM_U8(3);
		// fn 0: mulh stub
		WASM_U32_WITH_STUB(STUB_MUL128HI);
		// fn 1: smulh stub
		WASM_U32_WITH_STUB(STUB_IMUL128HI);
		// fn 2: kernel
		WASM_U32_PATCH({
			// Locals declaration (groups after the 2 i32 params):
			//   4 i32 (item, endItem, out, mixBlock)   indices 2..5
			//   8 i64 (r0..r7)                         indices 6..13
			//   2 i64 (registerValue, tmp64)           indices 14..15
			WASM_U8_THUNK({
				3,
				4, WASM_TYPE_I32,
				8, WASM_TYPE_I64,
				2, WASM_TYPE_I64,
			});
			p += emit_kernel_body(programs, cache_base, dataset_base, p);
			WASM_U8(0x0b);  // end of function
		});
	});

	THUNK_END;
}
// clang-format on
