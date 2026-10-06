// Internal: per-instruction WASM emitter API.
#pragma once

#include <stdint.h>
#include "wasm_jit_decode.h"

#ifdef __cplusplus
extern "C" {
#endif

// Emit a single RandomX instruction (post-decode) as WASM bytes into `buf`.
// `scratchpad` is the absolute pointer to the scratchpad in linear memory
// (baked into emitted WASM as an i32 constant). `jit_feature` selects the
// FSWAP_R variant (swizzle vs relaxed_swizzle).
// Returns number of bytes written.
uint32_t rxjit_emit_instruction(const rxjit_inst_t *inst, const rxjit_jump_desc_t *jump_desc,
                                uint8_t *scratchpad, int jit_feature, uint8_t *buf);

#ifdef __cplusplus
}
#endif
