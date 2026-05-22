// Ported from randomx.js (src/jit/wasm_jit.h) with namespace tweaks.
// WASM binary encoding macros for the C-side JIT generator.
#pragma once

#include <stdint.h>
#include <string.h>

#ifdef __cplusplus
extern "C" {
#endif

uint32_t rxjit_i64_leb128(int64_t val, uint8_t data[10]);
uint32_t rxjit_u32_leb128(uint32_t val, uint8_t data[5]);

#ifdef __cplusplus
}
#endif

#define WASM_U8(v)  \
	do {            \
		*p++ = (v); \
	} while (0)

// uleb128
#define WASM_U32(v)                    \
	do {                               \
		p += rxjit_u32_leb128((v), p); \
	} while (0)

// sleb128
#define WASM_I64(v)                    \
	do {                               \
		p += rxjit_i64_leb128((v), p); \
	} while (0)

#define WASM_TYPE_I32  0x7f
#define WASM_TYPE_I64  0x7e
#define WASM_TYPE_V128 0x7b

#define WASM_MAGIC()   WASM_U8_THUNK({0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00})

#define _RXJIT_IGNORE_SHADOW_BEGIN \
	_Pragma("clang diagnostic push") _Pragma("clang diagnostic ignored \"-Wshadow\"")
#define _RXJIT_IGNORE_SHADOW_END _Pragma("clang diagnostic pop")

#define WASM_U32_PATCH(...)                                \
	do {                                                   \
		_RXJIT_IGNORE_SHADOW_BEGIN                         \
		uint8_t *__patch = p;                              \
		_RXJIT_IGNORE_SHADOW_END                           \
		__VA_ARGS__;                                       \
		_RXJIT_IGNORE_SHADOW_BEGIN                         \
		uint32_t __size = (uint32_t)(p - __patch);         \
		uint8_t __data[5];                                 \
		uint32_t __len = rxjit_u32_leb128(__size, __data); \
		memmove(__patch + __len, __patch, __size);         \
		memcpy(__patch, __data, __len);                    \
		_RXJIT_IGNORE_SHADOW_END                           \
		p += __len;                                        \
	} while (0)

#define WASM_U8_THUNK(...)                                             \
	memcpy(p, (uint8_t[])__VA_ARGS__, sizeof((uint8_t[])__VA_ARGS__)); \
	p += sizeof((uint8_t[])__VA_ARGS__)

#define WASM_U32_WITH_STUB(stub)       \
	do {                               \
		WASM_U32(sizeof(stub));        \
		memcpy(p, stub, sizeof(stub)); \
		p += sizeof(stub);             \
	} while (0)

#define WASM_SECTION(type, ...) \
	WASM_U8(type);              \
	WASM_U32_PATCH(__VA_ARGS__)

// WASM 1.0 section IDs. Only the ones the JIT actually emits are kept;
// custom (0x00), memory (0x05), start (0x08), data (0x0B), data-count
// (0x0C) are intentionally absent — re-add if a generator ever needs them.
#define WASM_SECTION_TYPE     0x01
#define WASM_SECTION_IMPORT   0x02
#define WASM_SECTION_FUNCTION 0x03
#define WASM_SECTION_TABLE    0x04
#define WASM_SECTION_GLOBAL   0x06
#define WASM_SECTION_EXPORT   0x07
#define WASM_SECTION_ELEMENT  0x09
#define WASM_SECTION_CODE     0x0A

#define THUNK_BEGIN            uint8_t *p = buf

#define THUNK_END              return (uint32_t)(p - buf)
