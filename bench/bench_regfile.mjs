// Micro-benchmark: register-file access patterns for the threaded interpreter.
//
// Two hand-built WASM modules, each running the same number of logical
// "r[dst] = r[dst] OP r[src]" ops:
//
//   Variant L (locals):  r[0..7] are i64 locals; reads use a 7-deep select
//                        tree, writes use a 9-arm br_table.
//   Variant M (memory):  r[0..7] are i64 slots at a fixed linear-memory
//                        offset; reads/writes use i64.load / i64.store.
//
// The driver loop reads (dst, src) byte pairs from a 256-entry index table
// (also in linear memory) so the indices are runtime values — same as the
// real threaded main_loop.
//
// Usage:
//   node              bench_regfile.mjs        # default tier (TurboFan)
//   node --liftoff-only bench_regfile.mjs      # baseline tier (Safari/JSC analog)
//   node --jitless    bench_regfile.mjs        # interpreter (sanity floor)
//
// Plumbing notes:
// - We declare a single internal memory (not imported) of 1 page.
// - The "index table" lives at memory offset 0 (256 × 2 bytes = 512 bytes).
// - For variant M, the register file lives at memory offset 1024 (8 × 8 = 64 B).
// - Both functions take an i32 "iter count" arg and return an i64 checksum
//   (so the JIT can't dead-code-eliminate the work).

// ---------- LEB128 + small helpers ----------

function uleb128(n) {
  const out = [];
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n);
  return out;
}
function sleb128(n) {
  const out = []; let more = true;
  while (more) {
    let b = n & 0x7f;
    n >>= 7;
    if ((n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40) !== 0)) more = false;
    else b |= 0x80;
    out.push(b);
  }
  return out;
}
function sleb64(bigN) {
  // signed LEB for 64-bit. Here n is a BigInt.
  const out = []; let more = true; let n = bigN;
  while (more) {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    const signBit = b & 0x40;
    if ((n === 0n && signBit === 0) || (n === -1n && signBit !== 0)) more = false;
    else b |= 0x80;
    out.push(b);
  }
  return out;
}
function bytes(...xs) {
  const out = [];
  for (const x of xs) {
    if (Array.isArray(x)) out.push(...x);
    else out.push(x & 0xff);
  }
  return out;
}
function section(id, body) {
  return [id, ...uleb128(body.length), ...body];
}
const T_I32 = 0x7f, T_I64 = 0x7e, T_FUNC = 0x60;

// ---------- Build a complete module given a function body ----------

function buildModule(funcBody, localGroups /* e.g. [[8, T_I64]] */) {
  // type[0]: (i32) -> i64
  const types = [1, T_FUNC, 1, T_I32, 1, T_I64];
  // funcs: one function of type 0
  const funcs = [1, 0];
  // memory: 1 page initial, 1 page max
  // memory section: count=1, limits flag=0x01 (has max), min=1, max=1
  const mems = [1, 0x01, 1, 1];
  // export: "run" -> func 0
  const exportName = [...Buffer.from('run', 'utf8')];
  const exports = [
    1, // one export
    exportName.length, ...exportName, 0x00, 0,
  ];

  // code section: 1 function
  // function body = locals + body bytes + 0x0b
  const localsBytes = [
    uleb128(localGroups.length).flat ? uleb128(localGroups.length) : uleb128(localGroups.length),
    ...localGroups.flatMap(([n, t]) => [...uleb128(n), t]),
  ].flat();
  const fnBytes = [...localsBytes, ...funcBody, 0x0b];
  const code = [
    1, // one function body
    ...uleb128(fnBytes.length), ...fnBytes,
  ];

  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, types),
    ...section(3, funcs),
    ...section(5, mems),
    ...section(7, exports),
    ...section(10, code),
  ]);
}

// ---------- Body emitters ----------

// We need local indices to be stable. We'll use a fixed layout per variant.
//
// Both variants share these locals (after their R-specific group):
//   $iter        i32   — current outer iter
//   $inner       i32   — current inner index 0..255
//   $idx_ptr     i32   — pointer into index table (= inner*2)
//   $dst_byte    i32   — dst u8
//   $src_byte    i32   — src u8
//   $tmp64       i64   — scratch
//   $sum         i64   — accumulator for checksum
//
// We'll prefill r[0..7] / r-file from constants so the loop has data to chew on.
// Then run N outer iterations of: inner 0..255 { r[dst] OP= r[src]; }
// Return XOR of all 8 r values.

function emit_locals_variant_body() {
  // Locals (after the 8 i64 R's):
  //   index 8:  iter   i32
  //   index 9:  inner  i32
  //   index 10: idx_ptr i32
  //   index 11: dst_byte i32
  //   index 12: src_byte i32
  //   index 13: tmp64 i64
  //   index 14: sum   i64
  //
  // localGroups: [[8, i64], [5, i32], [2, i64]] -> indices 0..7 = R, 8..12 = i32, 13..14 = i64
  const R = (i) => i;
  const L_iter = 8, L_inner = 9, L_idxp = 10, L_dst = 11, L_src = 12, L_tmp64 = 13, L_sum = 14;
  const FN_ARG = 0;  // hmm — function args ARE locals 0..N-1.
  // (1 i32 arg) → R locals shift by 1!
  //
  // Per WASM, function args precede declared locals. So if we have 1 arg + 8 R locals,
  // arg is local 0, R(0) = local 1, ..., R(7) = local 8.
  // Let's redefine.

  // Reset:
  const ARG_N = 0;
  const Ri = (i) => 1 + i;
  const _L_iter = 9, _L_inner = 10, _L_idxp = 11, _L_dst = 12, _L_src = 13, _L_tmp64 = 14, _L_sum = 15;

  const body = [];
  const e = (...xs) => body.push(...bytes(...xs));

  // Init r[0..7] with i*0x0123456789ABCDEF + 1
  for (let i = 0; i < 8; i++) {
    const v = (BigInt(i) * 0x0123456789ABCDEFn + 1n) & 0xffffffffffffffffn;
    // i64.const + local.set R(i)
    const signed = v >= 0x8000000000000000n ? v - 0x10000000000000000n : v;
    e(0x42, ...sleb64(signed), 0x21, ...uleb128(Ri(i)));
  }

  // iter = 0
  e(0x41, 0x00, 0x21, _L_iter);

  // outer loop
  e(0x03, 0x40);  // loop ()->()
  //   inner = 0
  e(0x41, 0x00, 0x21, _L_inner);
  //   inner loop
  e(0x03, 0x40);  // loop ()->()
  //     idx_ptr = inner * 2  (table at offset 0; 2 bytes per entry: dst, src)
  e(0x20, _L_inner, 0x41, 0x01, 0x74, 0x21, _L_idxp);  // inner; const 1; shl; set idx_ptr
  //     dst_byte = mem[idx_ptr + 0]
  e(0x20, _L_idxp, 0x2d, 0x00, 0x00, 0x21, _L_dst);
  //     src_byte = mem[idx_ptr + 1]
  e(0x20, _L_idxp, 0x2d, 0x00, 0x01, 0x21, _L_src);

  //     --- READ r[src] via 7-select tree ---
  //     Stack: R[1], R[0], (src&1) → select1 → "pair_01"  ... etc.
  //     Per the threaded module's emit_select_r:
  //       R7; R6; src&1; select        ; → pair{6,7}
  //       R5; R4; src&1; select        ; → pair{4,5}
  //       src&2; select                ; → group{4..7}
  //       R3; R2; src&1; select        ; → pair{2,3}
  //       R1; R0; src&1; select        ; → pair{0,1}
  //       src&2; select                ; → group{0..3}
  //       src&4; select                ; → final
  const emitSelectR = (idxLocal) => {
    const sel = () => e(0x1b);  // select (untyped)
    // pair {6,7}
    e(0x20, Ri(7), 0x20, Ri(6), 0x20, idxLocal, 0x41, 0x01, 0x71); sel();
    // pair {4,5}
    e(0x20, Ri(5), 0x20, Ri(4), 0x20, idxLocal, 0x41, 0x01, 0x71); sel();
    // group {4..7}
    e(0x20, idxLocal, 0x41, 0x02, 0x71); sel();
    // pair {2,3}
    e(0x20, Ri(3), 0x20, Ri(2), 0x20, idxLocal, 0x41, 0x01, 0x71); sel();
    // pair {0,1}
    e(0x20, Ri(1), 0x20, Ri(0), 0x20, idxLocal, 0x41, 0x01, 0x71); sel();
    // group {0..3}
    e(0x20, idxLocal, 0x41, 0x02, 0x71); sel();
    // final
    e(0x20, idxLocal, 0x41, 0x04, 0x71); sel();
  };
  emitSelectR(_L_dst);
  emitSelectR(_L_src);
  e(0x7c);  // i64.add (the OP)

  //     --- WRITE r[dst] via 9-arm br_table ---
  //     local.set tmp64; open 9 blocks; br_table dst → arms 0..7 + default; each arm: get tmp; set R(N); br outer-end
  e(0x21, _L_tmp64);
  for (let i = 0; i < 9; i++) e(0x02, 0x40);  // 9 blocks
  // br_table 8 labels (0..7) + default 8
  e(0x20, _L_dst, 0x0e, 8);
  for (let i = 0; i < 8; i++) e(...uleb128(i));
  e(...uleb128(8));
  // 8 arm bodies
  for (let i = 0; i < 8; i++) {
    e(0x0b);                                       // end (arm_i)
    e(0x20, _L_tmp64, 0x21, ...uleb128(Ri(i)));    // get tmp; set R(i)
    e(0x0c, ...uleb128(7 - i));                    // br (7-i) → outermost end
  }
  e(0x0b);  // final end

  //     inner++; if inner<256 continue
  e(0x20, _L_inner, 0x41, 0x01, 0x6a, 0x22, _L_inner);
  e(0x41, 0x80, 0x02);  // i32.const 256 (LEB: 0x80 0x02)
  e(0x49);              // i32.lt_u
  e(0x0d, 0x00);        // br_if 0  → top of inner loop
  e(0x0b);              // end inner loop

  //   iter++; if iter < ARG continue
  e(0x20, _L_iter, 0x41, 0x01, 0x6a, 0x22, _L_iter);
  e(0x20, ARG_N);
  e(0x49);              // i32.lt_u
  e(0x0d, 0x00);        // br_if 0  → top of outer loop
  e(0x0b);              // end outer loop

  // sum = r[0] ^ r[1] ^ ... ^ r[7]
  e(0x20, Ri(0));
  for (let i = 1; i < 8; i++) e(0x20, ...uleb128(Ri(i)), 0x85);
  // return sum (top of stack already)

  return body;
}

function emit_memory_variant_body() {
  // No R locals; register file lives in memory at offset 1024.
  //
  // Args + locals: [1 arg i32] + 5 i32 + 2 i64
  //   index 0: ARG (i32)
  //   1: iter (i32)
  //   2: inner (i32)
  //   3: idx_ptr (i32)
  //   4: dst_byte (i32)
  //   5: src_byte (i32)
  //   6: tmp64 (i64)
  //   7: sum (i64)
  const ARG_N = 0;
  const L_iter = 1, L_inner = 2, L_idxp = 3, L_dst = 4, L_src = 5, L_tmp64 = 6, L_sum = 7;
  const R_BASE = 1024;
  const body = [];
  const e = (...xs) => body.push(...bytes(...xs));

  // Init r-file in memory
  for (let i = 0; i < 8; i++) {
    const v = (BigInt(i) * 0x0123456789ABCDEFn + 1n) & 0xffffffffffffffffn;
    const signed = v >= 0x8000000000000000n ? v - 0x10000000000000000n : v;
    e(0x41, ...sleb128(R_BASE + i * 8));    // address
    e(0x42, ...sleb64(signed));             // value
    e(0x37, 0x03, 0x00);                    // i64.store align=3 offset=0
  }

  // iter = 0
  e(0x41, 0x00, 0x21, L_iter);
  e(0x03, 0x40);  // outer loop
    e(0x41, 0x00, 0x21, L_inner);
    e(0x03, 0x40);  // inner loop
      // idx_ptr = inner << 1
      e(0x20, L_inner, 0x41, 0x01, 0x74, 0x21, L_idxp);
      // dst_byte
      e(0x20, L_idxp, 0x2d, 0x00, 0x00, 0x21, L_dst);
      // src_byte
      e(0x20, L_idxp, 0x2d, 0x00, 0x01, 0x21, L_src);

      // value = mem[R_BASE + (dst<<3)]  +  mem[R_BASE + (src<<3)]
      //   load r[dst]
      e(0x41, ...sleb128(R_BASE));
      e(0x20, L_dst, 0x41, 0x03, 0x74, 0x6a);   // (dst << 3) + R_BASE
      e(0x29, 0x03, 0x00);                       // i64.load align=3 offset=0
      //   load r[src]
      e(0x41, ...sleb128(R_BASE));
      e(0x20, L_src, 0x41, 0x03, 0x74, 0x6a);
      e(0x29, 0x03, 0x00);
      //   i64.add → tmp64
      e(0x7c);
      e(0x21, L_tmp64);
      // store r[dst] = tmp64
      e(0x41, ...sleb128(R_BASE));
      e(0x20, L_dst, 0x41, 0x03, 0x74, 0x6a);
      e(0x20, L_tmp64);
      e(0x37, 0x03, 0x00);                       // i64.store align=3 offset=0

      // inner++; if <256 continue
      e(0x20, L_inner, 0x41, 0x01, 0x6a, 0x22, L_inner);
      e(0x41, 0x80, 0x02);
      e(0x49);
      e(0x0d, 0x00);
    e(0x0b);  // end inner

    // iter++; if <N continue
    e(0x20, L_iter, 0x41, 0x01, 0x6a, 0x22, L_iter);
    e(0x20, ARG_N);
    e(0x49);
    e(0x0d, 0x00);
  e(0x0b);  // end outer

  // sum = XOR of all 8 r-file slots
  e(0x42, 0x00);  // i64.const 0
  for (let i = 0; i < 8; i++) {
    e(0x41, ...sleb128(R_BASE + i * 8));
    e(0x29, 0x03, 0x00);
    e(0x85);  // i64.xor
  }

  return body;
}

// ---------- Driver ----------

function buildLocalsModule() {
  const body = emit_locals_variant_body();
  // locals: 8 i64 (R), 5 i32 (iter,inner,idx,dst,src), 2 i64 (tmp,sum)
  return buildModule(body, [[8, T_I64], [5, T_I32], [2, T_I64]]);
}
function buildMemoryModule() {
  const body = emit_memory_variant_body();
  // locals: 5 i32, 2 i64
  return buildModule(body, [[5, T_I32], [2, T_I64]]);
}

function setupTable(mem) {
  // Fill 256 × 2 bytes with a deterministic but varied dst/src pattern.
  const view = new Uint8Array(mem.buffer);
  let seed = 0xc4f5a89bn;
  for (let i = 0; i < 256; i++) {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    view[i * 2 + 0] = Number(seed & 7n);          // dst ∈ [0..7]
    view[i * 2 + 1] = Number((seed >> 3n) & 7n);   // src ∈ [0..7]
  }
}

async function runModule(label, modBytes, outerN, runs) {
  const mod = new WebAssembly.Module(modBytes);
  const inst = new WebAssembly.Instance(mod);
  const mem = inst.exports.mem;
  if (!mem) throw new Error('"mem" export missing from module');
  setupTable(mem);
  // Warmup
  for (let i = 0; i < 3; i++) inst.exports.run(1000);
  // Measure
  let bestNs = Infinity;
  for (let i = 0; i < runs; i++) {
    setupTable(mem);  // reset
    const t0 = process.hrtime.bigint();
    const checksum = inst.exports.run(outerN);
    const t1 = process.hrtime.bigint();
    const ns = Number(t1 - t0);
    if (ns < bestNs) bestNs = ns;
    if (i === 0) {
      console.log(`  [${label}] checksum=0x${checksum.toString(16).padStart(16, '0')}  iters=${outerN * 256}`);
    }
  }
  const opCount = outerN * 256;
  const nsPerOp = bestNs / opCount;
  console.log(`  [${label}] best: ${(bestNs / 1e6).toFixed(2)} ms  → ${nsPerOp.toFixed(2)} ns/op`);
  return { bestNs, opCount, nsPerOp };
}

// We need to add a memory export to both modules. Update buildModule:
function buildModuleWithMemExport(funcBody, localGroups) {
  // (regenerate with both "run" and "memory" exports)
  const types = [1, T_FUNC, 1, T_I32, 1, T_I64];
  const funcs = [1, 0];
  const mems = [1, 0x01, 1, 1];

  const exportRun = [3, 0x72, 0x75, 0x6e, 0x00, 0];  // "run" → func 0
  const exportMem = [3, 0x6d, 0x65, 0x6d, 0x02, 0];  // "mem" → memory 0
  const exports = [2, ...exportRun, ...exportMem];

  const localsBytes = [
    ...uleb128(localGroups.length),
    ...localGroups.flatMap(([n, t]) => [...uleb128(n), t]),
  ];
  const fnBytes = [...localsBytes, ...funcBody, 0x0b];
  const code = [1, ...uleb128(fnBytes.length), ...fnBytes];

  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, types),
    ...section(3, funcs),
    ...section(5, mems),
    ...section(7, exports),
    ...section(10, code),
  ]);
}

async function main() {
  const outerN = parseInt(process.argv.find(a => a.startsWith('--n='))?.slice(4) || '300000', 10);
  const runs = 7;

  const modL = buildModuleWithMemExport(emit_locals_variant_body(), [[8, T_I64], [5, T_I32], [2, T_I64]]);
  const modM = buildModuleWithMemExport(emit_memory_variant_body(), [[5, T_I32], [2, T_I64]]);

  console.log(`module sizes: L=${modL.length}B  M=${modM.length}B`);
  console.log(`outerN=${outerN}  (=> ${outerN * 256} ops per run)  runs=${runs}\n`);

  // Validate both compile
  try { new WebAssembly.Module(modL); }
  catch (e) { console.error('L module invalid:', e.message); process.exit(1); }
  try { new WebAssembly.Module(modM); }
  catch (e) { console.error('M module invalid:', e.message); process.exit(1); }

  const resL = await runModule('LOCALS', modL, outerN, runs);
  const resM = await runModule('MEMORY', modM, outerN, runs);

  const ratio = resL.nsPerOp / resM.nsPerOp;
  console.log(`\nratio LOCALS / MEMORY = ${ratio.toFixed(3)}x  (>1 means memory is faster)`);
  if (ratio > 1.10) console.log('→ memory variant is meaningfully faster');
  else if (ratio < 0.90) console.log('→ locals variant is meaningfully faster');
  else console.log('→ no significant difference (within ±10%)');
}

main().catch((e) => { console.error(e); process.exit(1); });
