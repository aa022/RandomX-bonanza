# appendix_handoff.md: x86-64 work on `perf/amd64`

This is an appendix to `opus_handoff.md`, which covers the ARM history and the threaded interpreter. It is tracked in git; the other local `.md` notes are gitignored. The longer per-step log is `amd64_notes.md` (local only).

- **Box:** Ryzen 5 5600X (Zen 3, 6C/12T with SMT; CPUs n and n+6 are siblings), Debian 13, Chromium 154, Node 26.10 (V8 14.6) at `/usr/local/bin`.
- **Branch:** `perf/amd64`, cut from `threaded-interp` @ `ea261c3` (v0.1.0). HEAD at the time of writing is `fbb8bc9`.

## 1. Result

| Where | Before (`ea261c3`) | Now (x86 profile) |
|---|---|---|
| Node 1T | 82 H/s | 100–108 |
| Node 12T | 525 | 580–610 |
| Chromium (measured by the user) | about 550 | 615 (max 632) before the relaxed AES; **max 660** with it |
| ARM (the `arm` profile) | | unchanged: the generated module is byte-identical to v0.1.0 |

## 2. Design: one build, runtime profiles
`public/randomx.wasm` is a single arch-neutral binary. The hot path is the threaded-interpreter module, which each pthread **generates at runtime** (`wasm/src/src/wasm_jit_threaded.c`). An "x86 mode" is therefore just a different set of generator and runtime parameters: no second build and no second download.

**Profiles** live in `wasm/src/src/wasm_jit_profile.h`:

| Field | arm | x86 | What it does |
|---|---|---|---|
| `fuse_n` | 200 | **800** | fused pair superinstructions: the top-N prefix of the ranked pair table |
| `unroll2` | 0 | 0 | 2× dispatch replication (two `br_table` sites); knob only |
| `triples_n` | 0 | 0 | fused triple superinstructions; knob only |
| `shared_code` | 0 | **1** | no per-thread pointers in the module bytes, so all workers share one compiled copy |
| `aes_simd` | 0 | **1** | vpaes-style SIMD AES in `randomx.wasm` instead of T-tables (perf-neutral on x64, see §5) |

**Knob precedence:** the profile sets every field, and an explicit knob overrides one field. The C setters take `-1` to mean "use the profile":
- `rxjit_set_profile`
- `rxjit_set_fuse_n`
- `rxjit_set_triples_n`
- `rxjit_set_unroll2`
- `rxjit_set_shared_code`
- `rxjit_set_aes_simd`

Getters `rxjit_effective_*` read back what is actually used. The C-side default profile is **arm**.

## 3. Selection flow
**Browser** (`public/miner.js` → `public/worker.js:313–345`):
1. The page URL has `?jit_profile=auto|arm|x86`, default `auto`. `miner.js` forwards it to the worker as `jitProfile`.
2. For `auto`:
   - If the UA is WebKit without `Chrome`/`Chromium` (Safari/JSC), use **arm**. JSC has no relaxed SIMD, and it refused to tier up large functions in earlier work.
   - Otherwise run `isX86()` (`worker.js:137`). It is a hand-assembled wasm module computing `i8x16.extract_lane_u 0 (i8x16.relaxed_swizzle([10..25], [0x11 × 16]))`. The result is implementation-defined:
     - x86 (`pshufb`, which keeps the low 4 bits of the index) returns **11**, so the profile is **x86**;
     - ARM (`tbl`, where an index ≥ 16 gives 0) returns **0**, so the profile is **arm**;
     - if the probe fails to compile or instantiate (no relaxed SIMD), the profile is **arm**.
3. Apply the profile with `_rxjit_set_profile`, then the fine overrides from `?jit_exp=` tokens: `fuse_n=N`, `triples_n=N`, `unroll2` or `unroll2=0|1`, `shared_code=0|1`, `aes_simd=0|1`. The older `no_fuse` and `no_inline_round` still work.
4. The status line reports the result, for example `JIT profile: x86 (auto) fuse_n=800 triples_n=0 unroll2=0 shared_code=1 aes_simd=1`; a forced profile shows `(forced)`.
5. All of this runs **before** any cache or dataset work. Every mining pthread generates its module from the effective values.

**Node** (`bench/profile_args.mjs`, used by `bench_webui`, `full_mode_check`, `mine_ctx_check` and `prof/dump_module`): `--profile auto|arm|x86`, where auto means `process.arch === 'x64'`, plus `--fuse-n`, `--triples-n`, `--unroll2 [0|1]`, `--shared-code 0|1` and `--aes-simd 0|1`. The bench header prints the effective values. For the Makefile: `make bench PROFILE=x86 EXTRA='--fuse-n 1600'`.

## 4. Implementation notes
- **Fuse table** (`wasm/tools/gen_fuse_table.py` generates `wasm_jit_fuse_table.h`).
  - All 2704 pairs are ranked by p(A)p(B), under the i.i.d. kind model with NOP, CFROUND and EXIT excluded. Any `fuse_n` uses the top-N prefix, and the first 200 pairs are exactly v0.1.0's.
  - The top 1000 triples, ranked by p(A)p(B)p(C), come with a sorted key array that the decoder binary-searches.
  - Regenerate with `python3 wasm/tools/gen_fuse_table.py` whenever the kind enum changes; a `_Static_assert` enforces this.
- **Record layout by need** (`kind16`):
  - If `K + fuse_n + triples_n <= 255` (K = 55), the records use exactly the v0.1.0 layout: kind u8 at +0 (`i32.load8_u`), aux at +1.
  - Otherwise kind is u16 at +0 (`i32.load16_u`) and aux moves to +2. `decoded_inst_t` is a 16-byte union of both views, and the generator reads aux through `g_d_aux`.
  - The EXIT sentinel's high kind byte (+1) is always 0, so one sentinel serves both widths.
- **Decoder and module agree:** the decoder must use exactly the `fuse_n`, `triples_n` and `kind16` the thread's module was generated with. `wasm_jit_run.cpp` stores them at generation and passes them to every decode.
  - The regeneration key is the feature (including the effective UNROLL2 bit), `fuse_n`, `triples_n`, `kind16` and `shared_code`, plus the scratchpad address when not shared.
- **Fused arms:**
  - A pair or triple arm runs `emit_arm_kind` for each part at `g_ro` = 0/16/32 under `g_no_exit`, then does one `ip += 16·n`.
  - Only record r's kind is rewritten, so every record stays a valid CBRANCH target.
  - A CBRANCH in any part: taken does `ip = target; br $L`, not taken falls through.
- **unroll2** (bit 128): `emit_inner_dispatch` is emitted twice inside `$L`. Copy 0's exits do `ip += 16·(n-1)` and branch to copy 0's `$end_dispatch`; the join adds 16 and falls into copy 1. The CBRANCH-taken and EXIT depths are unchanged.
- **shared_code:**
  - The module gets a second mutable i32 global, exported as `"a"`, holding the thread's arena base (vm_state is the arena base). The EM_JS bridge sets `inst.exports.a.value` after instantiating.
  - `main_loop` and `inner_dispatch` load it into a local at entry, and every former `i32.const` pointer becomes arena-relative. The scratchpad base is read from the arena's SPB slot.
  - Result: byte-identical modules on every thread. V8's native module cache (`--wasm-native-module-cache`, default on) compiles once, and concurrent compiles wait for the first one. That is 1 TurboFan compile instead of N, and SMT siblings share i-cache, op-cache and BTB entries.
  - In shared mode, a moved scratchpad (a new VM on the same thread) only rewrites SPB and does not regenerate.
  - An FNV-1a stat checks the identity: `mine_ctx_check` and `bench_webui --stats` print `same=… mismatch=…`.
- **Module buffer:** 256 KiB (v0.1.0) for u8 kinds without unroll, i.e. the arm profile; 2 MiB otherwise, grown on regeneration. The generator writes **unchecked** and the size is only checked afterwards; the largest measured module is 1.70 MB (2704+1000+unroll2 at feature 4).
- **SIMD AES** (`soft_aes.cpp`, `aes_hash.cpp`):
  - Drop-in `aesenc`/`aesdec` with exact AES-NI semantics.
  - vpaes nibble tables: `inv`, `inva`, `ipt` and `sbo` come from OpenSSL; the decryption-side tables were derived and checked exhaustively by `bench/prof/x86/vpaes_derive.py`.
  - Each aes_hash function is an `_impl<soft, simd>` behind a per-call branch on `g_rx_aes_simd`.
  - Standard `i8x16.swizzle` only (there is no relaxed SIMD in `randomx.wasm`).
- **Stats:** the decoder counts dispatch records per program; `bench_webui --stats` prints the static dispatches/op. The simulation matches it exactly (200 pairs: 0.673, 800: 0.546, 1600: 0.512, 1600+1000 triples: 0.458).

## 5. What we learned on x86 (Zen 3)
- **The fixed cost is per dispatch, not per op.** At 1T the dispatch rate is flat at about 230M/s (about 20 cycles per dispatch) across every config, while `br_table` mispredicts went from 41% (no fusion) to 7% (1600 pairs + 1000 triples). Mispredicts are **not** the limiter; only fewer dispatches helped. That is why fusion is +50% here against +6.7% on the M4.
- **SMT caps 12T.** The two siblings on a core share one 32 KiB L1i, the op cache and a 512 KiB L2, which also holds two scratchpads' L2 regions. Bigger tables win at 1T and 6T (1600 pairs + 1000 triples: 1T 114, 6T 605), but 12T saturates at about 550–610. With big code, 6T equals 12T. `shared_code` cut 12T i-cache misses from about 30 to 19 per 1k instructions (+7% at 12T).
- **1T profile of the mining thread** (x86 profile): `inner_dispatch` 69%, `main_loop` 16%, T-table AES 13%, blake2 1%.
  - `main_loop` costs about 96 ns per iteration: the dataset read is an exposed DRAM miss. wasm has no prefetch, and a real load blocks retirement, so only SMT hides it.
- **Cycles per execution, by arm:**

  | Arm | Cycles |
  |---|---|
  | integer ALU | 3–7 |
  | integer from scratchpad L2 | 12–15 |
  | FADD/FSUB_R pairs | 24–27 |
  | FADD/FSUB_M | 22–32 |
  | FDIV_M | 25–40 |

  Float emulation of directed rounding (TwoSum or FMA residue plus the mask fixup) costs about 25 x64 instructions per float op.
- **x64 codegen is clean:** the `br_table` header is 7 instructions, and the 9 mask v128s stay pinned in `xmm0`–`xmm8` with no spills. The handoff's x86 suspects (fusion too big for L1i, XMM pressure) were both false.
- **SIMD AES is perf-neutral on x64:** V8 lowers each non-relaxed `i8x16.swizzle` to `movq`, `vpaddusb [const]` and `vpshufb`, i.e. 3 instructions and 2 loads. vpaes needs about 11 swizzles per round, so a round is about 61 instructions (enc) or 74 (dec), against about 95 for the T-table. The measurement was 1T 107.6 → 104.8 and 12T 609 → 610.

## 6. Pitfalls and caveats
- **Firefox may land on arm.** If Firefox doesn't expose relaxed SIMD, `isX86()` can't compile and `auto` picks **arm** even on x86. It still works, just without the x86 gains. Check the `JIT profile:` status line in Firefox. A fallback probe without relaxed SIMD (a UA or timing check) is not written yet.
- **Safari is always arm**, including on Intel Macs, by design (see §3).
- **Rosetta:** an x86 browser under Rosetta on Apple Silicon probes as x86 (the probe tests the semantics of the emitted code) and gets the x86 profile. Untested.
- **The probe relies on implementation-defined behaviour.** If an engine ever canonicalises out-of-range `relaxed_swizzle` to 0 on x86, the probe fails safe to arm.
- **The x86 profile has not been measured on ARM.** `bench/arm_ab.sh` runs `--profile arm` vs `--profile x86` at 1T/10T on the M4. Only if the result is ≥0.98× at every thread count should x86 values become the global default. Note that this A/B now also toggles `aes_simd`, and vpaes should do better on arm64, where a swizzle is one `TBL`.
- **The AES gate gap:** `full_mode_check` and `mine_ctx_check` compare the JIT against the portable interpreter **in the same module**, and both read the same `g_rx_aes_simd`, so they would pass with a broken AES. Use `bench/canonical_hash.mjs` (with `_rxjit_set_aes_simd(1)`) and the `rx_aes_selftest(n)` export to test AES.
- **The ARM identity check on x64 needs `--profile arm`**, because `auto` is x86 here:
  ```
  node bench/prof/dump_module.mjs --feature-base 3 --profile arm --out /tmp/f7.wasm
  wasm2wat --enable-all /tmp/f7.wasm | sed -E 's/\b[0-9]{7,}\b/P/g' | diff - bench/results/ref_f7.wat
  ```
  Repeat for f4 against `ref_f4.wat`. The references are gitignored in `bench/results/`; regenerate them from `ea261c3` if they are missing.
- **Node versions:** `/usr/bin/node` (Debian v20, V8 11.3) **rejects relaxed SIMD**, so use Node ≥24. v20 is still useful as a "no relaxed SIMD" validator for `randomx.wasm`.
- **Big modules compile slowly:** Liftoff runs first, then TurboFan. A 0.5–1.7 MB module takes longer to reach full speed, so short benches understate big configs. `shared_code` helps, because there is one compile.
- **Oversubscription:** at 32 threads the scratchpads (32 × 2 MB) no longer fit the 32 MB L3. With shared code, try 12 and 16 threads in the browser too.
- **Deliverable size:** `randomx.wasm` grew 202 → 242 KB raw (66 → 86 KB gzipped). The causes are the fuse and triple tables (+19 KB data), the SIMD AES copies, the AES test exports (`rx_aes_selftest`, `rx_aes_bench`, about 6.4 KB) and the generator paths. The user accepted this. There is a slimming plan if needed: build the lookup tables at init, drop the test exports, compile out the unused paths.
- **Worker scope:** the profile, and with it `aes_simd`, is applied only inside the threaded-interpreter setup block. With `?jit_exp=no_threaded`, the C default (arm) applies.
- **Low audit leftovers:**
  - the AES key-constant hack is defeated in `hashAndFillAes1Rx4` (about 0.4%);
  - the RandomX V2 AES path in `vm_interpreted.cpp` is not switched (it is dead code today);
  - the unchecked generator writes.
- **The relaxed AES side module must stay data-free:** it imports the SHARED memory, so any data segment, global or stack use in `wasm/aes_relaxed/aes_relaxed.c` would write over randomx.wasm's memory. Check `wasm-objdump -h` after edits (only Type/Import/Function/Export/Code). Gate: `bench/aes_check.mjs`, which needs Node ≥24 (it prints FAIL on v20, because nothing calls the side module).
- **Benchmarks:** use an idle box, one short run per variant (`bench/prof/x86_ab.sh`), and treat 12T noise as about ±5%.

## 7. Tooling (all committed)

| Tool | Purpose |
|---|---|
| `bench/prof/dump_module.mjs` | dump a thread's generated module (cross-build and identity diffs) |
| `bench/prof/x86_ab.sh [-t "1 12"] [-d 15] -- A -- B` | A/B under `perf stat`: H/s, dispatches/op, mispredict %, op-cache hit %, IC misses per 1k |
| `bench/arm_ab.sh` | the M4 sign-off A/B (macOS bash 3.2, no perf) |
| `bench/prof/x86/pstat.sh` | per-thread `perf stat` on the mining thread |
| `bench/prof/x86/{jd,thr,arms}.py` | jitdump parsers: per-function and per-`br_table`-arm cycles from `perf record -k 1 -e cycles` plus `node --perf-prof` |
| `bench/prof/x86/vpaes_derive.py` | derivation and check of the vpaes tables |

**perf recipe:**
- `sudo sysctl -w kernel.perf_event_paranoid=-1` (it resets on reboot).
- jitdump needs `perf record -k 1`, and **IBS can't use `-k 1`**, so use plain `cycles`.
- `perf report` on a V8 jitdump is unusably slow (86k JIT objects); use the parsers above.
- `node --trace-wasm-compilation-times` counts TurboFan compiles, which verifies code sharing.

**Gates** (all must print OK):
- `node bench/full_mode_check.mjs --count 32` at `--feature-base 3`, `0`, `1`, and `0 --feature-extra 32`, for `--profile arm` and `x86`;
- `node bench/mine_ctx_check.mjs`;
- the ARM identity check;
- for AES changes, also the canonical hash and `rx_aes_selftest`.

## 8. Open levers (not done)
1. ~~**AES with `relaxed_swizzle`**~~ **Done for hashAndFill** (`813a0d4`): a separate 4.3 KB relaxed side module (`wasm/aes_relaxed/`), whose bytes are embedded in `randomx.wasm` and instantiated per worker only when `aes_relaxed` (x86 = 1) is set and the feature has relaxed SIMD. One run: 1T 105.1 → 108.8 H/s (+3.5%), 12T 630.4 → 678.4 (+7.6%). Left: `fillAes1Rx4`/`hashAes1Rx4`/`fillAes4Rx4` (about 2% of rounds) are still on the plain swizzle.
2. **Float-arm trims:** `v128.const 0` is rematerialised 3× per FADD/FSUB, and the rounding fixup could be tighter (+2–4%).
3. **Size-aware pair selection** (prefer small integer pairs per byte of code) for the 12T footprint.
4. **A Firefox fallback** for `auto` detection without relaxed SIMD.
5. **The M4 sign-off** (`bench/arm_ab.sh`), then possibly one profile for all.
6. **Decide on `aes_simd` for x86:** neutral today, so 0 would be the conservative choice.
