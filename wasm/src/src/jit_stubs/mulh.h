#pragma once

#include <stdint.h>

#ifndef FUNC_OFFSET
#define FUNC_OFFSET 0
#endif

#define _(x) (x + FUNC_OFFSET)

// mul128hi
static const uint8_t STUB_MUL128HI[] = {
	0x01,                               // local[1]
	0x04, 0x7e,                         // local[2..5] type=i64
	0x20, 0x01,                         // local.get 1
	0x42, 0xff, 0xff, 0xff, 0xff, 0x0f, // i64.const 4294967295
	0x83,                               // i64.and
	0x22, 0x02,                         // local.tee 2
	0x20, 0x00,                         // local.get 0
	0x42, 0x20,                         // i64.const 32
	0x88,                               // i64.shr_u
	0x22, 0x03,                         // local.tee 3
	0x7e,                               // i64.mul
	0x22, 0x04,                         // local.tee 4
	0x42, 0x20,                         // i64.const 32
	0x88,                               // i64.shr_u
	0x20, 0x01,                         // local.get 1
	0x42, 0x20,                         // i64.const 32
	0x88,                               // i64.shr_u
	0x22, 0x01,                         // local.tee 1
	0x20, 0x00,                         // local.get 0
	0x42, 0xff, 0xff, 0xff, 0xff, 0x0f, // i64.const 4294967295
	0x83,                               // i64.and
	0x22, 0x00,                         // local.tee 0
	0x7e,                               // i64.mul
	0x22, 0x05,                         // local.tee 5
	0x42, 0x20,                         // i64.const 32
	0x88,                               // i64.shr_u
	0x7c,                               // i64.add
	0x20, 0x01,                         // local.get 1
	0x20, 0x03,                         // local.get 3
	0x7e,                               // i64.mul
	0x22, 0x01,                         // local.tee 1
	0x42, 0xff, 0xff, 0xff, 0xff, 0x0f, // i64.const 4294967295
	0x83,                               // i64.and
	0x7c,                               // i64.add
	0x20, 0x01,                         // local.get 1
	0x42, 0x80, 0x80, 0x80, 0x80, 0x70, // i64.const 18446744069414584320
	0x83,                               // i64.and
	0x7c,                               // i64.add
	0x20, 0x04,                         // local.get 4
	0x42, 0xff, 0xff, 0xff, 0xff, 0x0f, // i64.const 4294967295
	0x83,                               // i64.and
	0x20, 0x05,                         // local.get 5
	0x42, 0xff, 0xff, 0xff, 0xff, 0x0f, // i64.const 4294967295
	0x83,                               // i64.and
	0x7c,                               // i64.add
	0x20, 0x00,                         // local.get 0
	0x20, 0x02,                         // local.get 2
	0x7e,                               // i64.mul
	0x42, 0x20,                         // i64.const 32
	0x88,                               // i64.shr_u
	0x7c,                               // i64.add
	0x42, 0x20,                         // i64.const 32
	0x88,                               // i64.shr_u
	0x7c,                               // i64.add
	0x0b,                               // end
};

// imul128hi
static const uint8_t STUB_IMUL128HI[] = {
	0x01,                               // local[1]
	0x04, 0x7e,                         // local[2..5] type=i64
	0x20, 0x01,                         // local.get 1
	0x42, 0x20,                         // i64.const 32
	0x88,                               // i64.shr_u
	0x22, 0x02,                         // local.tee 2
	0x20, 0x00,                         // local.get 0
	0x42, 0xff, 0xff, 0xff, 0xff, 0x0f, // i64.const 4294967295
	0x83,                               // i64.and
	0x22, 0x03,                         // local.tee 3
	0x7e,                               // i64.mul
	0x22, 0x04,                         // local.tee 4
	0x42, 0x20,                         // i64.const 32
	0x88,                               // i64.shr_u
	0x20, 0x01,                         // local.get 1
	0x42, 0x3f,                         // i64.const 63
	0x87,                               // i64.shr_s
	0x20, 0x00,                         // local.get 0
	0x83,                               // i64.and
	0x20, 0x00,                         // local.get 0
	0x42, 0x3f,                         // i64.const 63
	0x87,                               // i64.shr_s
	0x20, 0x01,                         // local.get 1
	0x83,                               // i64.and
	0x7c,                               // i64.add
	0x7d,                               // i64.sub
	0x20, 0x01,                         // local.get 1
	0x42, 0xff, 0xff, 0xff, 0xff, 0x0f, // i64.const 4294967295
	0x83,                               // i64.and
	0x22, 0x01,                         // local.tee 1
	0x20, 0x00,                         // local.get 0
	0x42, 0x20,                         // i64.const 32
	0x88,                               // i64.shr_u
	0x22, 0x00,                         // local.tee 0
	0x7e,                               // i64.mul
	0x22, 0x05,                         // local.tee 5
	0x42, 0x20,                         // i64.const 32
	0x88,                               // i64.shr_u
	0x7c,                               // i64.add
	0x20, 0x00,                         // local.get 0
	0x20, 0x02,                         // local.get 2
	0x7e,                               // i64.mul
	0x22, 0x00,                         // local.tee 0
	0x42, 0xff, 0xff, 0xff, 0xff, 0x0f, // i64.const 4294967295
	0x83,                               // i64.and
	0x7c,                               // i64.add
	0x20, 0x00,                         // local.get 0
	0x42, 0x80, 0x80, 0x80, 0x80, 0x70, // i64.const 18446744069414584320
	0x83,                               // i64.and
	0x7c,                               // i64.add
	0x20, 0x05,                         // local.get 5
	0x42, 0xff, 0xff, 0xff, 0xff, 0x0f, // i64.const 4294967295
	0x83,                               // i64.and
	0x20, 0x04,                         // local.get 4
	0x42, 0xff, 0xff, 0xff, 0xff, 0x0f, // i64.const 4294967295
	0x83,                               // i64.and
	0x7c,                               // i64.add
	0x20, 0x01,                         // local.get 1
	0x20, 0x03,                         // local.get 3
	0x7e,                               // i64.mul
	0x42, 0x20,                         // i64.const 32
	0x88,                               // i64.shr_u
	0x7c,                               // i64.add
	0x42, 0x20,                         // i64.const 32
	0x88,                               // i64.shr_u
	0x7c,                               // i64.add
	0x0b,                               // end
};

#undef _
#undef FUNC_OFFSET
