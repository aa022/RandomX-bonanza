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
//   15  tmp64          (i64) qword 0 of the mix block, loaded early (emit_item_compute)
//   16  mt             (i64) inline mulh temp
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
constexpr int LK_mt = 16; // inline mulh temp (t)

// Function indices in the kernel module.
constexpr int FN_MULH = 0;
constexpr int FN_SMULH = 1;
constexpr int FN_KERNEL = 2;

// The locals one item computation uses. The kernel and the light item
// function use the layout above (KL); a K-item block (emit_itemK_compute)
// gives every item its own set.
struct ItemLocals {
	int item;        // i32 item number
	int out;         // i32 output pointer
	int mixBlock;    // i32
	int r0;          // i64 r0..r7 = r0..r0+7
	int registerVal; // i64
	int tmp64;       // i64 qword 0 of the mix block, loaded early
	int mt;          // i64 inline mulh temp
};
constexpr ItemLocals KL = {LK_item, LK_out, LK_mixBlock, LK_r0, LK_registerVal, LK_tmp64, LK_mt};

// Helper to emit r-local access for one of the 8 r-registers.
static inline int RREG(const ItemLocals &L, int idx) {
	return L.r0 + idx;
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
#define I32_SUB()       WASM_U8(0x6b)
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
#define I64_SHR_S()     WASM_U8(0x87)
#define I64_SHR_U()     WASM_U8(0x88)
#define SELECT()        WASM_U8(0x1b)
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

// Inline 64x64 -> high 64 multiply of locals a, b; pushes hi. Hacker's
// Delight mulhu/mulhs (M = 0xffffffff):
//   t  = aH*bL + ((aL*bL) >>u 32)
//   hi = aH*bH + (t >> 32) + ((aL*bH + (t & M)) >> 32)
// Unsigned: every >> is logical and aH/bH = a/b >>u 32. Signed ("shd"): aH,
// bH and the two t-derived shifts are arithmetic (aH/bH are the signed high
// halves, every partial product fits in an i64), which gives mulhs directly
// with no ((a >> 63) & b) correction; aL*bL >> 32 stays logical. V8 does not
// inline the call-based stubs; the calls were ~40% of the item time (1T, x64).
static uint32_t emit_mulh_inline(const ItemLocals &L, int a, int b, bool is_signed, uint8_t *buf) {
	THUNK_BEGIN;
#define HSHR() do { if (is_signed) I64_SHR_S(); else I64_SHR_U(); } while (0)
	// t = aH*bL + ((aL*bL) >>u 32)
	LG(a); WI64_CONST(32); HSHR();
	LG(b); WI64_CONST(0xffffffffLL); I64_AND(); I64_MUL();
	LG(a); WI64_CONST(0xffffffffLL); I64_AND();
	LG(b); WI64_CONST(0xffffffffLL); I64_AND(); I64_MUL();
	WI64_CONST(32); I64_SHR_U(); I64_ADD();
	LS(L.mt);
	// (aL*bH + (t & M)) >> 32
	LG(a); WI64_CONST(0xffffffffLL); I64_AND();
	LG(b); WI64_CONST(32); HSHR(); I64_MUL();
	LG(L.mt); WI64_CONST(0xffffffffLL); I64_AND(); I64_ADD();
	WI64_CONST(32); HSHR();
	// + aH*bH + (t >> 32)
	LG(a); WI64_CONST(32); HSHR();
	LG(b); WI64_CONST(32); HSHR(); I64_MUL(); I64_ADD();
	LG(L.mt); WI64_CONST(32); HSHR(); I64_ADD();
#undef HSHR
	THUNK_END;
}

// Emit code for one decoded SuperscalarHash instruction.
//   Side effect on the operand stack: none (each emit is balanced).
//   Reads/writes the r0..r7 locals at indices L.r0..L.r0+7.
static uint32_t emit_super_inst(const ItemLocals &L, const randomx::DecodedSuperscalarInst &d,
                                uint8_t *buf) {
	THUNK_BEGIN;
	using ST = randomx::SuperscalarInstructionType;
	const int rd = RREG(L, d.dst);
	const int rs = RREG(L, d.src);
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
		p += emit_mulh_inline(L, rd, rs, false, p);
		LS(rd);
		break;
	case ST::ISMULH_R:
		p += emit_mulh_inline(L, rd, rs, true, p);
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
static uint32_t emit_super_program(const ItemLocals &L, const randomx::DecodedSuperscalarProgram &prog,
                                   uint8_t *buf) {
	THUNK_BEGIN;
	for (uint32_t j = 0; j < prog.size; ++j) {
		p += emit_super_inst(L, prog.insts[j], p);
	}
	THUNK_END;
}

// Emit the cache-mix-block address computation, leaving mixBlock in L.mixBlock.
//   mixBlock = cache_base + ((registerValue & CACHE_ITEM_MASK) * 64)
static uint32_t emit_mix_addr(const ItemLocals &L, uint32_t cache_base, uint8_t *buf) {
	THUNK_BEGIN;
	LG(L.registerVal);
	WI64_CONST((int64_t)CACHE_ITEM_MASK);
	I64_AND();
	I32_WRAP_I64();
	WI32_CONST(6);
	I32_SHL();
	WI32_CONST(cache_base);
	I32_ADD();
	LS(L.mixBlock);
	THUNK_END;
}

// Emit the cache-line XOR: r[q] ^= load64(mixBlock + q*8) for q in 0..8
// (q = 0 from tmp64, loaded right after emit_mix_addr).
static uint32_t emit_mix_xor(const ItemLocals &L, uint8_t *buf) {
	THUNK_BEGIN;
	for (int q = 0; q < 8; ++q) {
		LG(RREG(L, q));
		if (q == 0) {
			LG(L.tmp64); // loaded early, right after emit_mix_addr
		} else {
			LG(L.mixBlock);
			I64_LOAD_OFF((uint32_t)(q * 8));
		}
		I64_XOR();
		LS(RREG(L, q));
	}
	THUNK_END;
}

// Emit r-register initialization at the top of each item iteration.
//   r0 = (item + 1) * superscalarMul0
//   r1 = r0 ^ superscalarAdd1
//   ...
//   r7 = r0 ^ superscalarAdd7
//   registerValue = item (i64)
static uint32_t emit_item_init(const ItemLocals &L, uint8_t *buf) {
	THUNK_BEGIN;
	// r0 = (item+1) * Mul0
	LG(L.item);
	WI32_CONST(1);
	I32_ADD();
	I64_EXT_I32_U();
	WI64_CONST((int64_t)superscalarMul0);
	I64_MUL();
	LS(RREG(L, 0));
	// r1..r7 = r0 ^ AddN
	static const uint64_t adds[7] = {
	    superscalarAdd1, superscalarAdd2, superscalarAdd3, superscalarAdd4,
	    superscalarAdd5, superscalarAdd6, superscalarAdd7,
	};
	for (int i = 0; i < 7; ++i) {
		LG(RREG(L, 0));
		WI64_CONST((int64_t)adds[i]);
		I64_XOR();
		LS(RREG(L, i + 1));
	}
	// registerValue = item (i64)
	LG(L.item);
	I64_EXT_I32_U();
	LS(L.registerVal);
	THUNK_END;
}

// Emit dataset store: mem[out + q*8] = r[q] for q in 0..8.
static uint32_t emit_dataset_store(const ItemLocals &L, uint8_t *buf) {
	THUNK_BEGIN;
	for (int q = 0; q < 8; ++q) {
		LG(L.out);
		LG(RREG(L, q));
		I64_STORE_OFF((uint32_t)(q * 8));
	}
	THUNK_END;
}

// K independent initDatasetItem computations, each on its own locals L[k]
// (K = 1: one item, the kernel / light fn layout KL), stored to
// mem[L[k].out..+64). Block interleave, per program: the K mix addresses, the
// K early qword-0 loads back to back (K cache misses in flight), then each
// item's whole program, mix xor and next registerValue in turn. Items are not
// interleaved op by op: that keeps ~22 values live and spills on x64 (the
// removed 2-VM lockstep). K = 1 emits exactly the one-item code.
static uint32_t emit_itemK_compute(const randomx::DecodedSuperscalarProgram programs[],
                                   uint32_t cache_base, int K, const ItemLocals L[],
                                   uint8_t *buf) {
	THUNK_BEGIN;
	for (int k = 0; k < K; ++k)
		p += emit_item_init(L[k], p);

	// For each of RANDOMX_CACHE_ACCESSES programs:
	for (int i = 0; i < RANDOMX_CACHE_ACCESSES; ++i) {
		const auto &prog = programs[i];
		// mixBlock = cache + (registerValue & mask) * 64
		for (int k = 0; k < K; ++k)
			p += emit_mix_addr(L[k], cache_base, p);
		// tmp64 = mem[mixBlock]: the cache misses issue before the programs
		// instead of at the xor after each
		for (int k = 0; k < K; ++k) {
			LG(L[k].mixBlock);
			I64_LOAD_OFF(0);
			LS(L[k].tmp64);
		}
		for (int k = 0; k < K; ++k) {
			// execute program (inlined)
			p += emit_super_program(L[k], prog, p);
			// r[q] ^= mem[mixBlock + q*8]
			p += emit_mix_xor(L[k], p);
			// registerValue = r[addrReg]
			LG(RREG(L[k], prog.addrReg));
			LS(L[k].registerVal);
		}
	}

	// store r[0..7] to dataset
	for (int k = 0; k < K; ++k)
		p += emit_dataset_store(L[k], p);
	THUNK_END;
}

// One initDatasetItem: r = f(item) over the RANDOMX_CACHE_ACCESSES programs,
// stored to mem[out..out+64).
static uint32_t emit_item_compute(const randomx::DecodedSuperscalarProgram programs[],
                                  uint32_t cache_base, uint8_t *buf) {
	return emit_itemK_compute(programs, cache_base, 1, &KL, buf);
}

// Kernel locals declaration (groups after the 2 i32 params):
//   4 i32 (item, endItem, out, mixBlock)   indices 2..5
//   8 i64 (r0..r7)                         indices 6..13
//   3 i64 (registerValue, tmp64, mt)       indices 14..16
// A K-item kernel appends, per extra item k = 1..K-1 at base b = 17 + (k-1)*14:
//   3 i32 (item, out, mixBlock)            b..b+2
//  11 i64 (r0..r7, registerValue, tmp64, mt) b+3..b+13
constexpr int KERNEL_LANE_LOCALS = 14;
static uint32_t emit_kernel_locals(int K, uint8_t *buf) {
	THUNK_BEGIN;
	WASM_U8((uint8_t)(3 + 2 * (K - 1)));
	WASM_U8_THUNK({4, WASM_TYPE_I32, 8, WASM_TYPE_I64, 3, WASM_TYPE_I64});
	for (int k = 1; k < K; ++k) {
		WASM_U8_THUNK({3, WASM_TYPE_I32, 11, WASM_TYPE_I64});
	}
	THUNK_END;
}
static ItemLocals kernel_lane(int k) {
	if (k == 0) return KL;
	const int b = 17 + (k - 1) * KERNEL_LANE_LOCALS;
	return {b, b + 1, b + 2, b + 3, b + 11, b + 12, b + 13};
}

// Upper bound on the bytes emit_itemK_compute writes per item (the emitters
// write unchecked): an inline mulh is 90 B, any other op at most 16 B (a
// 10-byte i64.const, local indices < 128); per program the mix address, early
// load, xor and registerValue are 109 B, init + store 193 B.
static uint32_t item_bytes_bound(const randomx::DecodedSuperscalarProgram programs[]) {
	using ST = randomx::SuperscalarInstructionType;
	uint32_t n = 256;
	for (int i = 0; i < RANDOMX_CACHE_ACCESSES; ++i) {
		n += 128;
		for (uint32_t j = 0; j < programs[i].size; ++j) {
			const ST op = (ST)programs[i].insts[j].op;
			n += (op == ST::IMULH_R || op == ST::ISMULH_R) ? 96 : 16;
		}
	}
	return n;
}

// Emit the body of the kernel function (no locals declaration, no end byte).
// K items per loop trip (emit_itemK_compute). A short last trip is not
// special-cased: item k = min(item + k, endItem - 1) and its out follows, so
// the extra items recompute the last one and rewrite the same 64 bytes.
static uint32_t emit_kernel_body(const randomx::DecodedSuperscalarProgram programs[],
                                 uint32_t cache_base, uint32_t dataset_base, int K, uint8_t *buf) {
	THUNK_BEGIN;
	ItemLocals L[RXJIT_KERNEL_K_MAX];
	for (int k = 0; k < K; ++k)
		L[k] = kernel_lane(k);
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
		for (int k = 1; k < K; ++k) {
			// item_k = item + k < endItem ? item + k : endItem - 1
			LG(LK_item);
			WI32_CONST(k);
			I32_ADD();
			LG(LK_endItem);
			WI32_CONST(1);
			I32_SUB();
			LG(LK_item);
			WI32_CONST(k);
			I32_ADD();
			LG(LK_endItem);
			I32_LT_U();
			SELECT();
			LT(L[k].item);
			// out_k = out + (item_k - item) * 64 (wraps like out)
			LG(LK_item);
			I32_SUB();
			WI32_CONST(6);
			I32_SHL();
			LG(LK_out);
			I32_ADD();
			LS(L[k].out);
		}
		p += emit_itemK_compute(programs, cache_base, K, L, p);

		// out += 64 * K
		LG(LK_out);
		WI32_CONST(64 * K);
		I32_ADD();
		LS(LK_out);
		// item += K; if item < endItem, br 0 (continue outer)
		LG(LK_item);
		WI32_CONST(K);
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
	int items_per_trip,
	uint32_t cap,
	uint8_t* buf)
{
	// K items per loop trip, 1 unless the size bound fits the buffer
	const uint32_t bound = item_bytes_bound(programs);
	int K = items_per_trip < 1 ? 1 : items_per_trip > RXJIT_KERNEL_K_MAX ? RXJIT_KERNEL_K_MAX : items_per_trip;
	if (K > 1 && 4096 + (uint64_t)K * bound > cap) K = 1;
	if (4096 + (uint64_t)bound > cap) return 0;
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
			p += emit_kernel_locals(K, p);
			p += emit_kernel_body(programs, cache_base, dataset_base, K, p);
			WASM_U8(0x0b);  // end of function
		});
	});

	THUNK_END;
}

// Light mode: the body (locals + code + end, without the size prefix) of the
// function (i32 item, i32 out) -> () that the threaded module embeds (type
// (i32,i32)->(), no calls: mulh is inline): one initDatasetItem(item) into
// mem[out..out+64). The params reuse the kernel's slots 0/1 (startItem/count),
// so the program emitters are shared. 0 if it might not fit in cap bytes.
extern "C" uint32_t rxjit_emit_superscalar_item_fn(
	const randomx::DecodedSuperscalarProgram programs[],
	uint32_t cache_base,
	uint32_t cap,
	uint8_t* buf)
{
	if (256 + (uint64_t)item_bytes_bound(programs) > cap) return 0;
	THUNK_BEGIN;
	p += emit_kernel_locals(1, p);
	LG(LK_startItem);
	LS(LK_item);
	LG(LK_count);
	LS(LK_out);
	p += emit_item_compute(programs, cache_base, p);
	WASM_U8(0x0b);  // end of function
	THUNK_END;
}

// Light mode, item pairing (light_mlp 2): the body of
// item_pair(i32 itemA, i32 itemB, i32 out) -> (), initDatasetItem(itemA) into
// mem[out..+64) and initDatasetItem(itemB) into mem[out + out_delta..+64) as
// one 2-item block (emit_itemK_compute), so the two items' cache misses
// overlap. Locals after the params: outB (3), mixBlock A/B (4, 5), A's r0..r7,
// registerValue, tmp64, mt (6..16), B's (17..27). 0 if it might not fit in cap.
extern "C" uint32_t rxjit_emit_superscalar_item_pair_fn(
	const randomx::DecodedSuperscalarProgram programs[],
	uint32_t cache_base,
	uint32_t out_delta,
	uint32_t cap,
	uint8_t* buf)
{
	static const ItemLocals L[2] = {{0, 2, 4, 6, 14, 15, 16}, {1, 3, 5, 17, 25, 26, 27}};
	if (256 + 2 * (uint64_t)item_bytes_bound(programs) > cap) return 0;
	THUNK_BEGIN;
	WASM_U8_THUNK({2, 3, WASM_TYPE_I32, 22, WASM_TYPE_I64});
	// outB = out + out_delta
	LG(2);
	WI32_CONST(out_delta);
	I32_ADD();
	LS(3);
	p += emit_itemK_compute(programs, cache_base, 2, L, p);
	WASM_U8(0x0b);  // end of function
	THUNK_END;
}
// clang-format on
