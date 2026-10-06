#pragma once

#ifdef __EMSCRIPTEN__

#include <cstdint>
#include <cmath>
#include <cfloat>

static uint32_t wasm_rounding_mode = 0; // 0=nearest, 1=down, 2=up, 3=toward_zero

static inline double nextup(double x) {
    if (x != x || x == INFINITY) return x;
    if (x == 0.0) return DBL_TRUE_MIN;
    uint64_t bits;
    __builtin_memcpy(&bits, &x, sizeof(bits));
    if (x > 0) bits++; else bits--;
    __builtin_memcpy(&x, &bits, sizeof(x));
    return x;
}

static inline double nextdown(double x) {
    if (x != x || x == -INFINITY) return x;
    if (x == 0.0) return -DBL_TRUE_MIN;
    uint64_t bits;
    __builtin_memcpy(&bits, &x, sizeof(bits));
    if (x > 0) bits--; else bits++;
    __builtin_memcpy(&x, &bits, sizeof(x));
    return x;
}

static inline double softround_add(double a, double b) {
    double s = a + b;
    if (wasm_rounding_mode == 0) return s;
    // Knuth two-sum: compute rounding error
    double a1 = s - b;
    double b1 = s - a1;
    double da = a - a1;
    double db = b - b1;
    double err = da + db; // err > 0 means true result > s
    if (err == 0.0) return s;
    switch (wasm_rounding_mode) {
        case 1: // down
            return (err < 0.0) ? nextdown(s) : s;
        case 2: // up
            return (err > 0.0) ? nextup(s) : s;
        case 3: // toward zero
            if (s > 0.0) return (err < 0.0) ? nextdown(s) : s;
            if (s < 0.0) return (err > 0.0) ? nextup(s) : s;
            return s;
    }
    return s;
}

static inline double softround_sub(double a, double b) {
    return softround_add(a, -b);
}

static inline double softround_mul(double a, double b) {
    double p = a * b;
    if (wasm_rounding_mode == 0) return p;
    double err = fma(a, b, -p);
    if (err == 0.0) return p;
    switch (wasm_rounding_mode) {
        case 1: return (err < 0.0) ? nextdown(p) : p;
        case 2: return (err > 0.0) ? nextup(p) : p;
        case 3:
            if (p > 0.0) return (err < 0.0) ? nextdown(p) : p;
            if (p < 0.0) return (err > 0.0) ? nextup(p) : p;
            return p;
    }
    return p;
}

static inline double softround_div(double a, double b) {
    double q = a / b;
    if (wasm_rounding_mode == 0) return q;
    // remainder: a - q*b. If positive, true quotient > q
    double err = fma(-q, b, a);
    if (err == 0.0) return q;
    switch (wasm_rounding_mode) {
        case 1: return (err < 0.0) ? nextdown(q) : q;
        case 2: return (err > 0.0) ? nextup(q) : q;
        case 3:
            if (q > 0.0) return (err < 0.0) ? nextdown(q) : q;
            if (q < 0.0) return (err > 0.0) ? nextup(q) : q;
            return q;
    }
    return q;
}

static inline double softround_sqrt(double a) {
    double s = sqrt(a);
    if (wasm_rounding_mode == 0) return s;
    // residual: a - s*s. If positive, true sqrt > s
    double err = fma(-s, s, a);
    if (err == 0.0) return s;
    switch (wasm_rounding_mode) {
        case 1: return (err < 0.0) ? nextdown(s) : s;
        case 2: return (err > 0.0) ? nextup(s) : s;
        case 3:
            // sqrt result is always >= 0
            return (err < 0.0) ? nextdown(s) : s;
    }
    return s;
}

#endif // __EMSCRIPTEN__
