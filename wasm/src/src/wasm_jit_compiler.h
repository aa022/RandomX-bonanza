#pragma once

#include <cstdint>
#include <cstddef>
#include "bytecode_machine.hpp"

namespace randomx {

#pragma pack(push, 1)
struct JitInstruction {
	uint16_t type;
	uint8_t dstIdx;
	uint8_t srcIdx;
	uint8_t srcIsImm;
	uint8_t srcIsZero;
	uint16_t pad0;
	int64_t imm;
	int32_t memMask;
	uint16_t shift;
	int16_t target;
};
#pragma pack(pop)

static_assert(sizeof(JitInstruction) == 24, "JitInstruction must be 24 bytes");

int exportBytecodeForJit(const InstructionByteCode bytecode[], int programSize,
                         const NativeRegisterFile &nreg, JitInstruction *output);

} // namespace randomx
