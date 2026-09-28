#include "wasm_jit_compiler.h"
#include "instruction.hpp"
#include "wasm_jit_superscalar.h"
#include "dataset.hpp"
#include <cstring>
#include <atomic>

// Glue declared in wasm_jit_run.cpp. The g_rxjit_supjit_enabled atomic lives
// in an anonymous namespace there, so access goes through the C-linkage
// getter/setter instead of a direct extern.
extern "C" void rxjit_supjit_publish_bytes(uint32_t size);
extern "C" int rxjit_supjit_run_range(uint32_t startItem, uint32_t count);
extern "C" void *rxjit_supjit_bytes_ptr(void);
extern "C" int rxjit_get_supjit_enabled(void);
extern "C" void rxjit_set_supjit_enabled(int on);

namespace randomx {

static int resolveIntReg(const int_reg_t *ptr, const NativeRegisterFile &nreg) {
	ptrdiff_t off = ptr - &nreg.r[0];
	if (off >= 0 && off < RegistersCount) return (int)off;
	return -1; // points to ibc.imm or zero
}

static int resolveFloatReg(const rx_vec_f128 *ptr, const NativeRegisterFile &nreg) {
	// Check f registers
	ptrdiff_t off = ptr - &nreg.f[0];
	if (off >= 0 && off < RegisterCountFlt) return (int)off;
	// Check e registers
	off = ptr - &nreg.e[0];
	if (off >= 0 && off < RegisterCountFlt) return (int)off + RegisterCountFlt;
	// Check a registers
	off = ptr - &nreg.a[0];
	if (off >= 0 && off < RegisterCountFlt) return (int)off;
	return -1;
}

int exportBytecodeForJit(const InstructionByteCode bytecode[], int programSize,
                         const NativeRegisterFile &nreg, JitInstruction *output) {
	static const int_reg_t zero = 0;

	for (int i = 0; i < programSize; i++) {
		const auto &ibc = bytecode[i];
		auto &out = output[i];
		memset(&out, 0, sizeof(JitInstruction));

		out.type = (uint16_t)ibc.type;

		switch (ibc.type) {
		case InstructionType::IADD_RS: {
			out.dstIdx = resolveIntReg(ibc.idst, nreg);
			int srcReg = resolveIntReg(ibc.isrc, nreg);
			out.srcIdx = srcReg >= 0 ? srcReg : 0;
			out.srcIsImm = 0;
			out.shift = ibc.shift;
			out.imm = (int64_t)ibc.imm;
			break;
		}
		case InstructionType::IADD_M:
		case InstructionType::ISUB_M:
		case InstructionType::IMUL_M:
		case InstructionType::IXOR_M: {
			out.dstIdx = resolveIntReg(ibc.idst, nreg);
			int srcReg = resolveIntReg(ibc.isrc, nreg);
			out.srcIsZero = (srcReg < 0) ? 1 : 0;
			out.srcIdx = srcReg >= 0 ? srcReg : 0;
			out.imm = (int64_t)ibc.imm;
			out.memMask = ibc.memMask;
			break;
		}
		case InstructionType::ISUB_R:
		case InstructionType::IMUL_R:
		case InstructionType::IXOR_R: {
			out.dstIdx = resolveIntReg(ibc.idst, nreg);
			int srcReg = resolveIntReg(ibc.isrc, nreg);
			if (srcReg >= 0) {
				out.srcIdx = srcReg;
				out.srcIsImm = 0;
			} else {
				out.srcIsImm = 1;
				out.imm = (int64_t)ibc.imm;
			}
			break;
		}
		case InstructionType::IMULH_R:
		case InstructionType::ISMULH_R: {
			out.dstIdx = resolveIntReg(ibc.idst, nreg);
			out.srcIdx = resolveIntReg(ibc.isrc, nreg);
			break;
		}
		case InstructionType::IMULH_M:
		case InstructionType::ISMULH_M: {
			out.dstIdx = resolveIntReg(ibc.idst, nreg);
			int srcReg = resolveIntReg(ibc.isrc, nreg);
			out.srcIsZero = (srcReg < 0) ? 1 : 0;
			out.srcIdx = srcReg >= 0 ? srcReg : 0;
			out.imm = (int64_t)ibc.imm;
			out.memMask = ibc.memMask;
			break;
		}
		case InstructionType::INEG_R: {
			out.dstIdx = resolveIntReg(ibc.idst, nreg);
			break;
		}
		case InstructionType::IROR_R:
		case InstructionType::IROL_R: {
			out.dstIdx = resolveIntReg(ibc.idst, nreg);
			int srcReg = resolveIntReg(ibc.isrc, nreg);
			if (srcReg >= 0) {
				out.srcIdx = srcReg;
				out.srcIsImm = 0;
			} else {
				out.srcIsImm = 1;
				out.imm = (int64_t)ibc.imm;
			}
			break;
		}
		case InstructionType::ISWAP_R: {
			out.dstIdx = resolveIntReg(ibc.idst, nreg);
			out.srcIdx = resolveIntReg(ibc.isrc, nreg);
			break;
		}
		case InstructionType::FSWAP_R: {
			// fdst points to either f[0-3] or e[0-3]
			out.dstIdx = resolveFloatReg(ibc.fdst, nreg);
			break;
		}
		case InstructionType::FADD_R:
		case InstructionType::FSUB_R: {
			// fdst = f[dst], fsrc = a[src]
			ptrdiff_t doff = ibc.fdst - &nreg.f[0];
			out.dstIdx = (doff >= 0 && doff < RegisterCountFlt) ? (int)doff : 0;
			ptrdiff_t soff = ibc.fsrc - &nreg.a[0];
			out.srcIdx = (soff >= 0 && soff < RegisterCountFlt) ? (int)soff : 0;
			break;
		}
		case InstructionType::FADD_M:
		case InstructionType::FSUB_M: {
			ptrdiff_t doff = ibc.fdst - &nreg.f[0];
			out.dstIdx = (doff >= 0 && doff < RegisterCountFlt) ? (int)doff : 0;
			out.srcIdx = resolveIntReg(ibc.isrc, nreg);
			out.imm = (int64_t)ibc.imm;
			out.memMask = ibc.memMask;
			break;
		}
		case InstructionType::FSCAL_R: {
			ptrdiff_t doff = ibc.fdst - &nreg.f[0];
			out.dstIdx = (doff >= 0 && doff < RegisterCountFlt) ? (int)doff : 0;
			break;
		}
		case InstructionType::FMUL_R: {
			// fdst = e[dst], fsrc = a[src]
			ptrdiff_t doff = ibc.fdst - &nreg.e[0];
			out.dstIdx = (doff >= 0 && doff < RegisterCountFlt) ? (int)doff : 0;
			ptrdiff_t soff = ibc.fsrc - &nreg.a[0];
			out.srcIdx = (soff >= 0 && soff < RegisterCountFlt) ? (int)soff : 0;
			break;
		}
		case InstructionType::FDIV_M: {
			ptrdiff_t doff = ibc.fdst - &nreg.e[0];
			out.dstIdx = (doff >= 0 && doff < RegisterCountFlt) ? (int)doff : 0;
			out.srcIdx = resolveIntReg(ibc.isrc, nreg);
			out.imm = (int64_t)ibc.imm;
			out.memMask = ibc.memMask;
			break;
		}
		case InstructionType::FSQRT_R: {
			ptrdiff_t doff = ibc.fdst - &nreg.e[0];
			out.dstIdx = (doff >= 0 && doff < RegisterCountFlt) ? (int)doff : 0;
			break;
		}
		case InstructionType::CBRANCH: {
			out.dstIdx = resolveIntReg(ibc.idst, nreg);
			out.imm = (int64_t)ibc.imm;
			out.memMask = ibc.memMask;
			out.target = ibc.target;
			break;
		}
		case InstructionType::CFROUND: {
			out.srcIdx = resolveIntReg(ibc.isrc, nreg);
			out.imm = (int64_t)ibc.imm;
			break;
		}
		case InstructionType::ISTORE: {
			out.dstIdx = resolveIntReg(ibc.idst, nreg);
			out.srcIdx = resolveIntReg(ibc.isrc, nreg);
			out.imm = (int64_t)ibc.imm;
			out.memMask = ibc.memMask;
			break;
		}
		case InstructionType::NOP:
		default:
			break;
		}
	}
	return programSize;
}

} // namespace randomx

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#include <algorithm>
#include <atomic>
#include "dataset.hpp"
#include "intrin_portable.h"
#include "randomx.h"

#ifdef __EMSCRIPTEN_PTHREADS__
#include <pthread.h>
#endif

extern uint64_t mulh(uint64_t, uint64_t);
extern int64_t smulh(int64_t, int64_t);

extern "C" {

EMSCRIPTEN_KEEPALIVE
int rxExportBytecodeForJit(void *bytecodePtr, int programSize, void *nregPtr, void *outputPtr) {
	return randomx::exportBytecodeForJit(
	    static_cast<const randomx::InstructionByteCode *>(bytecodePtr), programSize,
	    *static_cast<const randomx::NativeRegisterFile *>(nregPtr),
	    static_cast<randomx::JitInstruction *>(outputPtr));
}

EMSCRIPTEN_KEEPALIVE
uint64_t rxMulh(uint64_t a, uint64_t b) {
	return mulh(a, b);
}

EMSCRIPTEN_KEEPALIVE
int64_t rxSmulh(int64_t a, int64_t b) {
	return smulh(a, b);
}

EMSCRIPTEN_KEEPALIVE
double rxSoftroundAdd(double a, double b) {
	return softround_add(a, b);
}

EMSCRIPTEN_KEEPALIVE
double rxSoftroundSub(double a, double b) {
	return softround_sub(a, b);
}

EMSCRIPTEN_KEEPALIVE
double rxSoftroundMul(double a, double b) {
	return softround_mul(a, b);
}

EMSCRIPTEN_KEEPALIVE
double rxSoftroundDiv(double a, double b) {
	return softround_div(a, b);
}

EMSCRIPTEN_KEEPALIVE
double rxSoftroundSqrt(double a) {
	return softround_sqrt(a);
}

struct DatasetThreadJob {
	randomx_cache *cache;
	uint8_t *dataset;
	uint32_t start;
	uint32_t end;
};

// Phase C: shared progress counter + persistent thread handles for the async
// init API (start / progress / join). One concurrent init job at a time.
static std::atomic<uint32_t> g_init_progress{0};

#ifdef __EMSCRIPTEN_PTHREADS__
static pthread_t g_init_threads[32];
static DatasetThreadJob g_init_jobs[32];
static int g_init_thread_count = 0;
#endif

static uint64_t load64le(const uint8_t *ptr) {
	uint64_t value;
	memcpy(&value, ptr, sizeof(value));
	return value;
}

static bool hashMeetsTarget(const uint8_t *hash, const uint8_t *target) {
	return load64le(hash + 24) < load64le(target);
}

static void initDatasetRange(DatasetThreadJob *job) {
	uint8_t *out = job->dataset + (uint64_t)job->start * randomx::CacheLineSize;
	for (uint32_t item = job->start; item < job->end; ++item, out += randomx::CacheLineSize) {
		randomx::initDatasetItem(job->cache, out, item);
	}
}

// Variant that publishes batched progress for the async init API. Batched
// (BATCH items per atomic add) so the atomic fetch_add doesn't dominate the
// hot loop on heavily oversubscribed configurations.
static void initDatasetRangeWithProgress(DatasetThreadJob *job) {
	constexpr uint32_t BATCH = 1024;
	uint8_t *out = job->dataset + (uint64_t)job->start * randomx::CacheLineSize;
	uint32_t item = job->start;
	while (item < job->end) {
		const uint32_t step = (job->end - item) < BATCH ? (job->end - item) : BATCH;
		for (uint32_t k = 0; k < step; ++k, ++item, out += randomx::CacheLineSize) {
			randomx::initDatasetItem(job->cache, out, item);
		}
		g_init_progress.fetch_add(step, std::memory_order_relaxed);
	}
}

#ifdef __EMSCRIPTEN_PTHREADS__
static void *initDatasetRangeThread(void *arg) {
	initDatasetRange(static_cast<DatasetThreadJob *>(arg));
	return nullptr;
}

static void *initDatasetRangeThreadProgress(void *arg) {
	initDatasetRangeWithProgress(static_cast<DatasetThreadJob *>(arg));
	return nullptr;
}

// JIT pthread worker — calls the wasm SuperscalarHash kernel in 16384-item
// chunks (so progress updates remain ~150ms-scale even with 8× per-program
// speedup). Falls back to the interpreter for any chunk where the JS bridge
// returns 0 (compile failure, runtime exception, etc.) and disables the
// global JIT flag so subsequent chunks don't re-attempt.
static void initDatasetRangeWithJit(DatasetThreadJob *job) {
	constexpr uint32_t CHUNK = 16384;
	uint32_t item = job->start;
	while (item < job->end) {
		const uint32_t step = (job->end - item) < CHUNK ? (job->end - item) : CHUNK;
		const int ok = rxjit_supjit_run_range(item, step);
		if (!ok) {
			rxjit_set_supjit_enabled(0);
			DatasetThreadJob fb = {job->cache, job->dataset, item, item + step};
			initDatasetRangeWithProgress(&fb);
			item += step;
			continue;
		}
		g_init_progress.fetch_add(step, std::memory_order_relaxed);
		item += step;
	}
}

static void *initDatasetRangeThreadJit(void *arg) {
	initDatasetRangeWithJit(static_cast<DatasetThreadJob *>(arg));
	return nullptr;
}
#endif

EMSCRIPTEN_KEEPALIVE
int rxInitDatasetParallel(randomx_cache *cache, randomx_dataset *dataset, uint32_t startItem,
                          uint32_t itemCount, int threadCount) {
	if (cache == nullptr || dataset == nullptr || dataset->memory == nullptr || itemCount == 0) {
		return 0;
	}

	if (threadCount < 1) {
		threadCount = 1;
	}
	if (threadCount > 32) {
		threadCount = 32;
	}
	if ((uint32_t)threadCount > itemCount) {
		threadCount = (int)itemCount;
	}

#ifdef __EMSCRIPTEN_PTHREADS__
	DatasetThreadJob jobs[32];
	pthread_t threads[32];
	const uint32_t base = itemCount / (uint32_t)threadCount;
	const uint32_t extra = itemCount % (uint32_t)threadCount;
	uint32_t cursor = startItem;

	for (int i = 0; i < threadCount; ++i) {
		const uint32_t count = base + ((uint32_t)i < extra ? 1 : 0);
		jobs[i] = {cache, dataset->memory, cursor, cursor + count};
		cursor += count;
		const int rc = pthread_create(&threads[i], nullptr, initDatasetRangeThread, &jobs[i]);
		if (rc != 0) {
			for (int j = 0; j < i; ++j) {
				pthread_join(threads[j], nullptr);
			}
			DatasetThreadJob fallback = {cache, dataset->memory, startItem, startItem + itemCount};
			initDatasetRange(&fallback);
			return 1;
		}
	}

	for (int i = 0; i < threadCount; ++i) {
		pthread_join(threads[i], nullptr);
	}
#else
	DatasetThreadJob job = {cache, dataset->memory, startItem, startItem + itemCount};
	initDatasetRange(&job);
#endif

	return 1;
}

// ============================================================
// Phase C: async start / progress / join init API
// ============================================================
//
// The JS side previously called rxInitDatasetParallel once per 1<<19-item
// chunk inside a 64-chunk JS loop. Each chunk paid pthread_create + barrier
// pthread_join + an `await delay(0)` macrotask hop. With this API the JS
// side does:
//   rxInitDatasetStart(... 32 threads ... 0, itemCount);
//   while (rxInitDatasetProgress() < itemCount) { await delay(150); ... }
//   rxInitDatasetJoin();
// — one pthread_create burst, one join burst, smooth progress updates from
// a SAB-backed atomic counter, no barrier stalls between chunks.

EMSCRIPTEN_KEEPALIVE
int rxInitDatasetStart(randomx_cache *cache, randomx_dataset *dataset, uint32_t startItem,
                       uint32_t itemCount, int threadCount) {
	if (cache == nullptr || dataset == nullptr || dataset->memory == nullptr || itemCount == 0) {
		return 0;
	}

	if (threadCount < 1) threadCount = 1;
	if (threadCount > 32) threadCount = 32;
	if ((uint32_t)threadCount > itemCount) threadCount = (int)itemCount;

	g_init_progress.store(0, std::memory_order_relaxed);

	// Phase D: if SuperscalarHash JIT is enabled, generate the per-cache
	// kernel module once per init call (regenerated to bake in the current
	// cache_base + dataset_base). Generation cost is ~1 ms.
	bool useSupjit = rxjit_get_supjit_enabled() != 0;
	if (useSupjit) {
		uint32_t sz = rxjit_generate_superscalar_kernel(
		    cache->decodedPrograms, (uint32_t)(uintptr_t)cache->memory,
		    (uint32_t)(uintptr_t)dataset->memory, 1, 65536, (uint8_t *)rxjit_supjit_bytes_ptr());
		if (sz == 0 || sz > (1 << 16)) {
			// Generator failed — disable JIT and fall back to interpreter path.
			rxjit_set_supjit_enabled(0);
			useSupjit = false;
		} else {
			rxjit_supjit_publish_bytes(sz);
		}
	}

#ifdef __EMSCRIPTEN_PTHREADS__
	if (g_init_thread_count != 0) {
		// A previous job hasn't been joined. Caller bug — refuse to overlap.
		return 0;
	}

	void *(*worker)(void *) =
	    useSupjit ? initDatasetRangeThreadJit : initDatasetRangeThreadProgress;

	const uint32_t base = itemCount / (uint32_t)threadCount;
	const uint32_t extra = itemCount % (uint32_t)threadCount;
	uint32_t cursor = startItem;

	for (int i = 0; i < threadCount; ++i) {
		const uint32_t count = base + ((uint32_t)i < extra ? 1 : 0);
		g_init_jobs[i] = {cache, dataset->memory, cursor, cursor + count};
		cursor += count;
		const int rc = pthread_create(&g_init_threads[i], nullptr, worker, &g_init_jobs[i]);
		if (rc != 0) {
			// Roll back: join the threads we did spawn, then fall back to
			// single-threaded synchronous init.
			for (int j = 0; j < i; ++j) {
				pthread_join(g_init_threads[j], nullptr);
			}
			DatasetThreadJob fallback = {cache, dataset->memory, startItem, startItem + itemCount};
			initDatasetRangeWithProgress(&fallback);
			g_init_thread_count = 0;
			return 1;
		}
	}
	g_init_thread_count = threadCount;
#else
	DatasetThreadJob job = {cache, dataset->memory, startItem, startItem + itemCount};
	initDatasetRangeWithProgress(&job);
#endif

	return 1;
}

EMSCRIPTEN_KEEPALIVE
uint32_t rxInitDatasetProgress(void) {
	return g_init_progress.load(std::memory_order_relaxed);
}

EMSCRIPTEN_KEEPALIVE
int rxInitDatasetJoin(void) {
#ifdef __EMSCRIPTEN_PTHREADS__
	for (int i = 0; i < g_init_thread_count; ++i) {
		pthread_join(g_init_threads[i], nullptr);
	}
	g_init_thread_count = 0;
#endif
	return 1;
}

struct MineThreadJob {
	randomx_flags flags;
	randomx_cache *cache;
	randomx_dataset *dataset;
	randomx_vm *vm;
	const uint8_t *blob;
	uint32_t blobLen;
	const uint8_t *target;
	uint32_t nonceOffset;
	uint32_t startNonce;
	uint32_t nonceCount;
	std::atomic<uint32_t> *found;
	uint8_t *result;
};

static void writeFoundResult(MineThreadJob *job, uint32_t nonce, const uint8_t *hash) {
	uint32_t expected = 0;
	if (!job->found->compare_exchange_strong(expected, 1)) {
		return;
	}

	job->result[0] = 1;
	job->result[4] = (uint8_t)(nonce & 0xff);
	job->result[5] = (uint8_t)((nonce >> 8) & 0xff);
	job->result[6] = (uint8_t)((nonce >> 16) & 0xff);
	job->result[7] = (uint8_t)((nonce >> 24) & 0xff);
	memcpy(job->result + 8, hash, RANDOMX_HASH_SIZE);
}

static void setNonce(uint8_t *input, uint32_t nonceOffset, uint32_t nonce) {
	input[nonceOffset] = (uint8_t)(nonce & 0xff);
	input[nonceOffset + 1] = (uint8_t)((nonce >> 8) & 0xff);
	input[nonceOffset + 2] = (uint8_t)((nonce >> 16) & 0xff);
	input[nonceOffset + 3] = (uint8_t)((nonce >> 24) & 0xff);
}

static void mineRange(MineThreadJob *job) {
	if (job->nonceCount == 0 || job->blobLen > 256 || job->nonceOffset + 4 > job->blobLen) {
		return;
	}

	randomx_vm *vm =
	    job->vm != nullptr ? job->vm : randomx_create_vm(job->flags, job->cache, job->dataset);
	if (vm == nullptr) {
		return;
	}

	uint8_t input[256];
	uint8_t hash[RANDOMX_HASH_SIZE];
	memcpy(input, job->blob, job->blobLen);

	uint32_t currentNonce = job->startNonce;
	setNonce(input, job->nonceOffset, currentNonce);
	randomx_calculate_hash_first(vm, input, job->blobLen);

	for (uint32_t i = 0; i + 1 < job->nonceCount; ++i) {
		setNonce(input, job->nonceOffset, currentNonce + 1);
		randomx_calculate_hash_next(vm, input, job->blobLen, hash);

		if (hashMeetsTarget(hash, job->target)) {
			writeFoundResult(job, currentNonce, hash);
			break;
		}

		currentNonce++;
	}

	if (job->found->load() == 0) {
		randomx_calculate_hash_last(vm, hash);

		if (hashMeetsTarget(hash, job->target)) {
			writeFoundResult(job, currentNonce, hash);
		}
	}

	if (job->vm == nullptr) {
		randomx_destroy_vm(vm);
	}
}

#ifdef __EMSCRIPTEN_PTHREADS__
static void *mineRangeThread(void *arg) {
	mineRange(static_cast<MineThreadJob *>(arg));
	return nullptr;
}
#endif

EMSCRIPTEN_KEEPALIVE
uint32_t rxMineBatchParallel(int flags, randomx_cache *cache, randomx_dataset *dataset,
                             const uint8_t *blob, uint32_t blobLen, const uint8_t *target,
                             uint32_t nonceOffset, uint32_t startNonce, uint32_t nonceCount,
                             int threadCount, uint8_t *result) {
	if (blob == nullptr || target == nullptr || result == nullptr || nonceCount == 0 ||
	    blobLen > 256 || nonceOffset + 4 > blobLen) {
		return 0;
	}
	if ((flags & RANDOMX_FLAG_FULL_MEM) && dataset == nullptr) {
		return 0;
	}
	if (!(flags & RANDOMX_FLAG_FULL_MEM) && cache == nullptr) {
		return 0;
	}

	if (threadCount < 1) {
		threadCount = 1;
	}
	if (!(flags & RANDOMX_FLAG_FULL_MEM)) {
		threadCount = 1;
	}
	if (threadCount > 32) {
		threadCount = 32;
	}
	if ((uint32_t)threadCount > nonceCount) {
		threadCount = (int)nonceCount;
	}

	memset(result, 0, 40);
	std::atomic<uint32_t> found(0);

#ifdef __EMSCRIPTEN_PTHREADS__
	MineThreadJob jobs[32];
	pthread_t threads[32];
	const uint32_t base = nonceCount / (uint32_t)threadCount;
	const uint32_t extra = nonceCount % (uint32_t)threadCount;
	uint32_t cursor = startNonce;

	for (int i = 0; i < threadCount; ++i) {
		const uint32_t count = base + ((uint32_t)i < extra ? 1 : 0);
		jobs[i] = {
		    (randomx_flags)flags, cache,  dataset, nullptr, blob,   blobLen, target,
		    nonceOffset,          cursor, count,   &found,  result,
		};
		cursor += count;
		const int rc = pthread_create(&threads[i], nullptr, mineRangeThread, &jobs[i]);
		if (rc != 0) {
			for (int j = 0; j < i; ++j) {
				pthread_join(threads[j], nullptr);
			}
			MineThreadJob fallback = {
			    (randomx_flags)flags, cache,      dataset,    nullptr, blob,   blobLen, target,
			    nonceOffset,          startNonce, nonceCount, &found,  result,
			};
			mineRange(&fallback);
			return nonceCount;
		}
	}

	for (int i = 0; i < threadCount; ++i) {
		pthread_join(threads[i], nullptr);
	}
#else
	MineThreadJob job = {
	    (randomx_flags)flags, cache,      dataset,    nullptr, blob,   blobLen, target,
	    nonceOffset,          startNonce, nonceCount, &found,  result,
	};
	mineRange(&job);
#endif

	return nonceCount;
}

#ifdef __EMSCRIPTEN_PTHREADS__
struct PersistentMineThread;
#endif

struct MiningContext {
	randomx_flags flags;
	randomx_cache *cache;
	randomx_dataset *dataset;
	int threadCount;
	randomx_vm *vms[32];
	MineThreadJob jobs[32];
	std::atomic<uint32_t> found;
	uint8_t *result;
#ifdef __EMSCRIPTEN_PTHREADS__
	// Perf step 4: in-batch dynamic nonce claiming (no run-ahead). nextIdx
	// is padded onto its own 128-B line; batchStart/batchCount are read-only
	// while a batch runs.
	char claimPad0[128];
	std::atomic<uint32_t> nextIdx;
	char claimPad1[124];
	uint32_t batchStart;
	uint32_t batchCount;
	pthread_t threads[32];
	PersistentMineThread *threadArgs;
	pthread_mutex_t mutex;
	pthread_cond_t startCond;
	pthread_cond_t doneCond;
	bool stop;
	uint32_t jobSeq;
	int activeCount;
	int doneCount;
#endif
};

#ifdef __EMSCRIPTEN_PTHREADS__
struct PersistentMineThread {
	MiningContext *ctx;
	int index;
};

// Perf step 4: threads claim nonce indices of the current batch one at a
// time, so fast (P) cores take more nonces than slow (E) cores instead of
// idling at the batch barrier. No run-ahead: a thread only hashes indices
// < batchCount, and the call returns after all of them are hashed. The
// pipelined first/next/last API is kept: hash_next(n) returns the hash of
// the previously claimed idx while preparing n.
static void mineClaim(MiningContext *ctx, MineThreadJob *job) {
	const uint32_t start = ctx->batchStart;
	const uint32_t count = ctx->batchCount;
	uint32_t idx = ctx->nextIdx.fetch_add(1, std::memory_order_relaxed);
	if (idx >= count) {
		return;
	}
	randomx_vm *vm = job->vm;
	uint8_t input[256];
	uint8_t hash[RANDOMX_HASH_SIZE];
	memcpy(input, job->blob, job->blobLen);
	setNonce(input, job->nonceOffset, start + idx);
	randomx_calculate_hash_first(vm, input, job->blobLen);
	for (;;) {
		const uint32_t n = ctx->nextIdx.fetch_add(1, std::memory_order_relaxed);
		const bool more = n < count;
		if (more) {
			setNonce(input, job->nonceOffset, start + n);
			randomx_calculate_hash_next(vm, input, job->blobLen, hash);
		} else {
			randomx_calculate_hash_last(vm, hash);
		}
		// hash belongs to idx (the previously claimed nonce)
		if (hashMeetsTarget(hash, job->target)) {
			writeFoundResult(job, start + idx, hash);
		}
		if (!more) {
			break;
		}
		idx = n;
	}
}

static void *persistentMineThread(void *arg) {
	PersistentMineThread *thread = static_cast<PersistentMineThread *>(arg);
	MiningContext *ctx = thread->ctx;
	const int index = thread->index;
	uint32_t seenSeq = 0;

	pthread_mutex_lock(&ctx->mutex);
	for (;;) {
		while (!ctx->stop && ctx->jobSeq == seenSeq) {
			pthread_cond_wait(&ctx->startCond, &ctx->mutex);
		}

		if (ctx->stop) {
			pthread_mutex_unlock(&ctx->mutex);
			return nullptr;
		}

		seenSeq = ctx->jobSeq;
		pthread_mutex_unlock(&ctx->mutex);

		if (index < ctx->activeCount) {
			mineClaim(ctx, &ctx->jobs[index]);
		}

		pthread_mutex_lock(&ctx->mutex);
		ctx->doneCount++;
		if (ctx->doneCount >= ctx->activeCount) {
			pthread_cond_signal(&ctx->doneCond);
		}
	}
}
#endif

EMSCRIPTEN_KEEPALIVE
MiningContext *rxCreateMiningContext(int flags, randomx_cache *cache, randomx_dataset *dataset,
                                     int threadCount) {
	if ((flags & RANDOMX_FLAG_FULL_MEM) && dataset == nullptr) {
		return nullptr;
	}
	if (!(flags & RANDOMX_FLAG_FULL_MEM) && cache == nullptr) {
		return nullptr;
	}
	if (threadCount < 1) {
		threadCount = 1;
	}
	if (!(flags & RANDOMX_FLAG_FULL_MEM)) {
		threadCount = 1;
	}
	if (threadCount > 32) {
		threadCount = 32;
	}

	MiningContext *ctx = new MiningContext();
	ctx->flags = (randomx_flags)flags;
	ctx->cache = cache;
	ctx->dataset = dataset;
	ctx->threadCount = threadCount;
	ctx->found.store(0);
	ctx->result = nullptr;
	for (int i = 0; i < 32; ++i) {
		ctx->vms[i] = nullptr;
		memset(&ctx->jobs[i], 0, sizeof(ctx->jobs[i]));
	}

#ifdef __EMSCRIPTEN_PTHREADS__
	ctx->stop = false;
	ctx->threadArgs = nullptr;
	ctx->jobSeq = 0;
	ctx->activeCount = 0;
	ctx->doneCount = 0;
	ctx->nextIdx.store(0);
	ctx->batchStart = 0;
	ctx->batchCount = 0;
	pthread_mutex_init(&ctx->mutex, nullptr);
	pthread_cond_init(&ctx->startCond, nullptr);
	pthread_cond_init(&ctx->doneCond, nullptr);
#endif

	for (int i = 0; i < threadCount; ++i) {
		ctx->vms[i] = randomx_create_vm(ctx->flags, ctx->cache, ctx->dataset);
		if (ctx->vms[i] == nullptr) {
			for (int j = 0; j < i; ++j) {
				randomx_destroy_vm(ctx->vms[j]);
			}
#ifdef __EMSCRIPTEN_PTHREADS__
			pthread_cond_destroy(&ctx->doneCond);
			pthread_cond_destroy(&ctx->startCond);
			pthread_mutex_destroy(&ctx->mutex);
#endif
			delete ctx;
			return nullptr;
		}
	}

#ifdef __EMSCRIPTEN_PTHREADS__
	ctx->threadArgs = new PersistentMineThread[threadCount];
	for (int i = 0; i < threadCount; ++i) {
		ctx->threadArgs[i] = {ctx, i};
		const int rc =
		    pthread_create(&ctx->threads[i], nullptr, persistentMineThread, &ctx->threadArgs[i]);
		if (rc != 0) {
			pthread_mutex_lock(&ctx->mutex);
			ctx->stop = true;
			ctx->jobSeq++;
			pthread_cond_broadcast(&ctx->startCond);
			pthread_mutex_unlock(&ctx->mutex);
			for (int j = 0; j < i; ++j) {
				pthread_join(ctx->threads[j], nullptr);
			}
			for (int j = 0; j < threadCount; ++j) {
				if (ctx->vms[j] != nullptr) {
					randomx_destroy_vm(ctx->vms[j]);
				}
			}
			pthread_cond_destroy(&ctx->doneCond);
			pthread_cond_destroy(&ctx->startCond);
			pthread_mutex_destroy(&ctx->mutex);
			delete[] ctx->threadArgs;
			delete ctx;
			return nullptr;
		}
	}
#endif

	return ctx;
}

EMSCRIPTEN_KEEPALIVE
void rxDestroyMiningContext(MiningContext *ctx) {
	if (ctx == nullptr) {
		return;
	}
#ifdef __EMSCRIPTEN_PTHREADS__
	pthread_mutex_lock(&ctx->mutex);
	ctx->stop = true;
	ctx->jobSeq++;
	pthread_cond_broadcast(&ctx->startCond);
	pthread_mutex_unlock(&ctx->mutex);

	for (int i = 0; i < ctx->threadCount; ++i) {
		pthread_join(ctx->threads[i], nullptr);
	}
#endif
	for (int i = 0; i < ctx->threadCount; ++i) {
		if (ctx->vms[i] != nullptr) {
			randomx_destroy_vm(ctx->vms[i]);
		}
	}
#ifdef __EMSCRIPTEN_PTHREADS__
	pthread_cond_destroy(&ctx->doneCond);
	pthread_cond_destroy(&ctx->startCond);
	pthread_mutex_destroy(&ctx->mutex);
	delete[] ctx->threadArgs;
#endif
	delete ctx;
}

EMSCRIPTEN_KEEPALIVE
uint32_t rxMineBatchContext(MiningContext *ctx, const uint8_t *blob, uint32_t blobLen,
                            const uint8_t *target, uint32_t nonceOffset, uint32_t startNonce,
                            uint32_t nonceCount, uint8_t *result) {
	if (ctx == nullptr || blob == nullptr || target == nullptr || result == nullptr ||
	    nonceCount == 0 || blobLen > 256 || nonceOffset + 4 > blobLen) {
		return 0;
	}

#ifdef __EMSCRIPTEN_PTHREADS__
	// Every thread takes part in every batch (surplus threads claim nothing):
	// doneCount then counts exactly the threads that were woken, so the call
	// cannot return while a thread still hashes. (Before step 4, threads with
	// index >= min(threads, nonceCount) also bumped doneCount, which could
	// end the wait early when nonceCount < threads.)
	const int threadCount = ctx->threadCount;
	memset(result, 0, 40);
	ctx->found.store(0);
	ctx->result = result;

	pthread_mutex_lock(&ctx->mutex);
	// Nonces are claimed dynamically (mineClaim); jobs[] only carries the
	// per-thread vm and the shared call parameters.
	ctx->nextIdx.store(0, std::memory_order_relaxed);
	ctx->batchStart = startNonce;
	ctx->batchCount = nonceCount;
	for (int i = 0; i < threadCount; ++i) {
		ctx->jobs[i] = {
		    ctx->flags, ctx->cache,  ctx->dataset, ctx->vms[i], blob,        blobLen,
		    target,     nonceOffset, startNonce,   nonceCount,  &ctx->found, result,
		};
	}

	ctx->activeCount = threadCount;
	ctx->doneCount = 0;
	ctx->jobSeq++;
	pthread_cond_broadcast(&ctx->startCond);

	while (ctx->doneCount < ctx->activeCount) {
		pthread_cond_wait(&ctx->doneCond, &ctx->mutex);
	}

	pthread_mutex_unlock(&ctx->mutex);
#else
	memset(result, 0, 40);
	std::atomic<uint32_t> found(0);
	MineThreadJob job = {
	    ctx->flags, ctx->cache,  ctx->dataset, ctx->vms[0], blob,   blobLen,
	    target,     nonceOffset, startNonce,   nonceCount,  &found, result,
	};
	mineRange(&job);
#endif

	return nonceCount;
}

} // extern "C"
#endif
