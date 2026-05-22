// Minimal freestanding helpers for stub compilation.
// Ported from randomx.js/include/freestanding.h.
#pragma once

#include <stdbool.h>

#ifndef INFINITY
#define INFINITY (__builtin_inff())
#endif

#ifdef __wasm__
#define WASM_EXPORT(name) \
	__attribute__((export_name(name)))
#else
#define WASM_EXPORT(name)
#endif

#define likely(x) __builtin_expect(!!(x), 1)
#define unlikely(x) __builtin_expect(!!(x), 0)
