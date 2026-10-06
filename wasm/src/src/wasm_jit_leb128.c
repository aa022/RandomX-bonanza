// Ported from randomx.js (src/jit/wasm_jit.c).
#include <stdbool.h>
#include <stdint.h>

uint32_t rxjit_i64_leb128(int64_t val, uint8_t data[10]) {
	bool negative = val < 0;
	uint32_t i = 0;
	while (1) {
		uint8_t b = val & 0x7F;
		val >>= 7;
		if (negative) {
			// Force sign-extension fill of the top bits — using a literal
			// avoids the UB of left-shifting a negative signed value.
			val |= (int64_t)(~(uint64_t)0 << 57);
		}
		if (((val == 0) && (!(b & 0x40))) || ((val == -1) && (b & 0x40))) {
			data[i++] = b;
			return i;
		} else {
			data[i++] = b | 0x80;
		}
	}
}

uint32_t rxjit_u32_leb128(uint32_t val, uint8_t data[5]) {
	uint32_t i = 0;
	while (1) {
		uint8_t b = val & 0x7F;
		val >>= 7;
		if (val == 0) {
			data[i++] = b;
			return i;
		} else {
			data[i++] = b | 0x80;
		}
	}
}
