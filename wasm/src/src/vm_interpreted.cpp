/*
Copyright (c) 2018-2019, tevador <tevador@gmail.com>

All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
	* Redistributions of source code must retain the above copyright
	  notice, this list of conditions and the following disclaimer.
	* Redistributions in binary form must reproduce the above copyright
	  notice, this list of conditions and the following disclaimer in the
	  documentation and/or other materials provided with the distribution.
	* Neither the name of the copyright holder nor the
	  names of its contributors may be used to endorse or promote products
	  derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

#include <iostream>
#include <iomanip>
#include <stdexcept>
#include <sstream>
#include <cmath>
#include <cfloat>
#include "vm_interpreted.hpp"
#include "dataset.hpp"
#include "intrin_portable.h"
#include "reciprocal.h"
#include "soft_aes.h"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>

extern __thread uint32_t wasm_rounding_mode;
extern "C" int rxProfileIsEnabledForCore();
extern "C" void rxProfileAddBytecode(double ms);

// Set by JS via rxSetJitEnabled. The C-side WASM JIT module generator is
// used when this is non-zero AND we're in FULL_MEM (no light-mode JIT).
static int g_jitEnabled = 0;

extern "C" {
EMSCRIPTEN_KEEPALIVE
void rxSetJitEnabled(int enabled) {
	g_jitEnabled = enabled;
}

EMSCRIPTEN_KEEPALIVE
uint32_t* rxGetRoundingModePtr() {
	return &wasm_rounding_mode;
}
}

namespace randomx {
	int rxjit_run_program_full(
		NativeRegisterFile& nreg,
		Instruction program_buf[RANDOMX_PROGRAM_MAX_SIZE],
		const ProgramConfiguration& config,
		uint8_t* scratchpad,
		uint8_t* dataset,
		uint64_t dataset_offset,
		uint32_t ma,
		uint32_t mx);
	int rxjit_run_program_light(
		NativeRegisterFile& nreg,
		Instruction program_buf[RANDOMX_PROGRAM_MAX_SIZE],
		const ProgramConfiguration& config,
		uint8_t* scratchpad,
		randomx_cache* cache,
		uint64_t dataset_offset,
		uint32_t ma,
		uint32_t mx);
}
#endif

namespace randomx {

	template<class Allocator, bool softAes>
	void InterpretedVm<Allocator, softAes>::setDataset(randomx_dataset* dataset) {
		datasetPtr = dataset;
		mem.memory = dataset->memory;
	}

	template<class Allocator, bool softAes>
	void InterpretedVm<Allocator, softAes>::run(void* seed) {
		VmBase<Allocator, softAes>::generateProgram(seed);
		randomx_vm::initialize();
		execute();
	}

	template<class Allocator, bool softAes>
	void InterpretedVm<Allocator, softAes>::execute() {

		NativeRegisterFile nreg;
		const randomx_flags flags = randomx_vm::getFlags();
		const bool isV2 = (flags & RANDOMX_FLAG_V2) != 0;
		const int progSize = Program::getSize(flags);

		for(unsigned i = 0; i < RegisterCountFlt; ++i)
			nreg.a[i] = rx_load_vec_f128(&reg.a[i].lo);

		compileProgram(program, bytecode, nreg, flags);

#ifdef __EMSCRIPTEN__
		int programJitOk = 0;
		if (g_jitEnabled && (flags & RANDOMX_FLAG_FULL_MEM) && !isV2) {
			programJitOk = rxjit_run_program_full(
				nreg,
				program.programBufferRaw(),
				config,
				scratchpad,
				mem.memory,
				datasetOffset,
				mem.ma,
				mem.mx);
		} else if (g_jitEnabled && !isV2 && this->cachePtr != nullptr) {
			// light mode (InterpretedLightVm, cachePtr set by setCache):
			// dataset items are computed by the embedded superscalar kernel
			programJitOk = rxjit_run_program_light(
				nreg,
				program.programBufferRaw(),
				config,
				scratchpad,
				this->cachePtr,
				datasetOffset,
				mem.ma,
				mem.mx);
		}
#endif

		uint32_t spAddr0 = mem.mx;
		uint32_t spAddr1 = mem.ma;

#ifdef __EMSCRIPTEN__
		if (programJitOk) {
			// JIT ran the entire 2048-iteration loop and wrote r/f/e back
			// into nreg directly.
		} else
#endif
		{
		for(unsigned ic = 0; ic < RANDOMX_PROGRAM_ITERATIONS; ++ic) {
			uint64_t spMix = nreg.r[config.readReg0] ^ nreg.r[config.readReg1];
			spAddr0 ^= spMix;
			spAddr0 &= ScratchpadL3Mask64;
			spAddr1 ^= spMix >> 32;
			spAddr1 &= ScratchpadL3Mask64;

			for (unsigned i = 0; i < RegistersCount; ++i)
				nreg.r[i] ^= load64(scratchpad + spAddr0 + 8 * i);

			for (unsigned i = 0; i < RegisterCountFlt; ++i)
				nreg.f[i] = rx_cvt_packed_int_vec_f128(scratchpad + spAddr1 + 8 * i);

			for (unsigned i = 0; i < RegisterCountFlt; ++i)
				nreg.e[i] = maskRegisterExponentMantissa(config, rx_cvt_packed_int_vec_f128(scratchpad + spAddr1 + 8 * (RegisterCountFlt + i)));

#ifdef __EMSCRIPTEN__
			{
				bool profileBytecode = rxProfileIsEnabledForCore() != 0;
				double profileBytecodeStart = profileBytecode ? emscripten_get_now() : 0.0;
				executeBytecode(bytecode, scratchpad, config, flags, progSize);
				if (profileBytecode) rxProfileAddBytecode(emscripten_get_now() - profileBytecodeStart);
			}
#else
			executeBytecode(bytecode, scratchpad, config, flags, progSize);
#endif

			const uint64_t readPtr = datasetOffset + (mem.ma & CacheLineAlignMask);

			auto& mp = isV2 ? mem.ma : mem.mx;
			mp ^= nreg.r[config.readReg2] ^ nreg.r[config.readReg3];

			datasetPrefetch(datasetOffset + (mp & CacheLineAlignMask));
			datasetRead(readPtr, nreg.r);
			std::swap(mem.mx, mem.ma);

			for (unsigned i = 0; i < RegistersCount; ++i)
				store64(scratchpad + spAddr1 + 8 * i, nreg.r[i]);

			if (isV2) {
				rx_vec_i128 ekey[RegisterCountFlt];
				rx_vec_i128 freg[RegisterCountFlt];

				for (unsigned i = 0; i < RegisterCountFlt; ++i) {
					ekey[i] = rx_cast_vec_f2i(nreg.e[i]);
					freg[i] = rx_cast_vec_f2i(nreg.f[i]);
				}

				for (unsigned i = 0; i < RegisterCountFlt; ++i) {
					freg[0] = aesenc<softAes>(freg[0], ekey[i]);
					freg[1] = aesdec<softAes>(freg[1], ekey[i]);
					freg[2] = aesenc<softAes>(freg[2], ekey[i]);
					freg[3] = aesdec<softAes>(freg[3], ekey[i]);
				}

				for (unsigned i = 0; i < RegisterCountFlt; ++i)
					nreg.f[i] = rx_cast_vec_i2f(freg[i]);
			}
			else {
				for (unsigned i = 0; i < RegisterCountFlt; ++i)
					nreg.f[i] = rx_xor_vec_f128(nreg.f[i], nreg.e[i]);
			}

			for (unsigned i = 0; i < RegisterCountFlt; ++i)
				rx_store_vec_f128((double*)(scratchpad + spAddr0 + 16 * i), nreg.f[i]);

			spAddr0 = 0;
			spAddr1 = 0;
		}
		}

		for (unsigned i = 0; i < RegistersCount; ++i)
			store64(&reg.r[i], nreg.r[i]);

		for (unsigned i = 0; i < RegisterCountFlt; ++i)
			rx_store_vec_f128(&reg.f[i].lo, nreg.f[i]);

		for (unsigned i = 0; i < RegisterCountFlt; ++i)
			rx_store_vec_f128(&reg.e[i].lo, nreg.e[i]);
	}

	template<class Allocator, bool softAes>
	void InterpretedVm<Allocator, softAes>::datasetRead(uint64_t address, int_reg_t(&r)[RegistersCount]) {
		uint64_t* datasetLine = (uint64_t*)(mem.memory + address);
		for (int i = 0; i < RegistersCount; ++i)
			r[i] ^= datasetLine[i];
	}

	template<class Allocator, bool softAes>
	void InterpretedVm<Allocator, softAes>::datasetPrefetch(uint64_t address) {
		rx_prefetch_nta(mem.memory + address);
	}

	template class InterpretedVm<AlignedAllocator<CacheLineSize>, false>;
	template class InterpretedVm<AlignedAllocator<CacheLineSize>, true>;
	template class InterpretedVm<LargePageAllocator, false>;
	template class InterpretedVm<LargePageAllocator, true>;
}
