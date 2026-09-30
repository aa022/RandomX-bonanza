# appendix_handoff.md: x86-64 work on `perf/amd64`

This is an appendix to `opus_handoff.md`, which covers the ARM history and the threaded interpreter. It is tracked in git; the other local `.md` notes are gitignored. The longer per-step log is `amd64_notes.md` (local only).

- **Box:** Ryzen 5 5600X (Zen 3, 6C/12T with SMT; CPUs n and n+6 are siblings), Debian 13, Chromium 154, Node 26.10 (V8 14.6) at `/usr/local/bin`.
- **Branch:** `perf/amd64`, cut from `threaded-interp` @ `ea261c3` (v0.1.0). It is pushed to `origin/perf/amd64`; `git log ea261c3..` gives the step commits.

## 1. Result

| Where | Before (`ea261c3`) | Now (x86 profile) |
|---|---|---|
| Node 1T | 82 H/s | about 109 |
| Node 12T | 525 | about 678 |
| Chromium (measured by the user) | about 550 | 615 (max 632) before the relaxed AES; **max 660** with it |
| ARM (the `arm` profile) | | unchanged: the generated module is byte-identical to v0.1.0 |

**Where the 12T gain came from** (Node, one run per step, ±5%):

| Step | 12T change | Note |
|---|---|---|
| 800 fused pairs | 525 → about 585, +12% | 1T +22% |
| `shared_code` | +7% | one compiled copy for all threads |
| relaxed-swizzle AES side module | +7.6% | 630 → 678 |
| vpaes AES on plain swizzle | ±0 | superseded for hashAndFill |

On this box the whole history, including the earlier ARM-tuned series, went from about 280 to 660 H/s in Chromium.

## 2. Design: one build, runtime profiles
`public/randomx.wasm` is a single arch-neutral binary. The hot path is the threaded-interpreter module, which each pthread **generates at runtime** (`wasm/src/src/wasm_jit_threaded.c`). An "x86 mode" is therefore just a different set of generator and runtime parameters: no second build and no second download.

**Profiles** live in `wasm/src/src/wasm_jit_profile.h`:

| Field | arm | x86 | What it does |
|---|---|---|---|
| `fuse_n` | 200 | **800** | fused pair superinstructions: the top-N prefix of the ranked pair table |
| `unroll2` | 0 | 0 | 2× dispatch replication (two `br_table` sites); knob only |
| `triples_n` | 0 | 0 | fused triple superinstructions; knob only |
| `shared_code` | 0 | **1** | no per-thread pointers in the module bytes, so all workers share one compiled copy |
| `aes_simd` | 0 | **1** | vpaes-style SIMD AES in `randomx.wasm` instead of T-tables (perf-neutral on x64, see §5); still used by the AES functions the side module doesn't cover |
| `aes_relaxed` | 0 | **1** | `hashAndFillAes1Rx4` (about 98% of AES rounds) runs in a separate relaxed-SIMD side module (`i8x16.relaxed_swizzle`, one `pshufb`). Effective only when the feature has relaxed SIMD (bit 1 or 2), so JSC and feature 4 never use it |
| `light_mlp` | 0 | **2** | light mode only: on even iterations one call computes this and the next iteration's item (item pairing, §9.2) |
| `kernel_k` | 1 | **4** | supjit dataset-init kernel items per loop trip (`rxInitDatasetStart`); the `fb_full` chunk kernels stay at 1 unless the knob is set (§9.2) |

**Knob precedence:** the profile sets every field, and an explicit knob overrides one field. The C setters take `-1` to mean "use the profile":
- `rxjit_set_profile`
- `rxjit_set_fuse_n`
- `rxjit_set_triples_n`
- `rxjit_set_unroll2`
- `rxjit_set_shared_code`
- `rxjit_set_aes_simd`
- `rxjit_set_aes_relaxed`
- `rxjit_set_light_mlp`
- `rxjit_set_kernel_k`

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
3. Apply the profile with `_rxjit_set_profile`, then the fine overrides from `?jit_exp=` tokens: `fuse_n=N`, `triples_n=N`, `unroll2` or `unroll2=0|1`, `shared_code=0|1`, `aes_simd=0|1`, `aes_relaxed=0|1`. The older `no_fuse` and `no_inline_round` still work.
4. The status line reports the result, for example `JIT profile: x86 (auto) fuse_n=800 triples_n=0 unroll2=0 shared_code=1 aes_simd=1 aes_relaxed=1`; a forced profile shows `(forced)`.
5. All of this runs **before** any cache or dataset work. Every mining pthread generates its module from the effective values.

**Node** (`bench/profile_args.mjs`, used by `bench_webui`, `full_mode_check`, `mine_ctx_check` and `prof/dump_module`): `--profile auto|arm|x86`, where auto means `process.arch === 'x64'`, plus `--fuse-n`, `--triples-n`, `--unroll2 [0|1]`, `--shared-code 0|1`, `--aes-simd 0|1` and `--aes-relaxed 0|1`. The bench header prints the effective values. For the Makefile: `make bench PROFILE=x86 EXTRA='--fuse-n 1600'`.

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
- **Relaxed AES side module** (`813a0d4`):
  - **Source:** `wasm/aes_relaxed/aes_relaxed.c`, a freestanding C port of `hashAndFillAes1Rx4_impl<true,true>` using `wasm_i8x16_relaxed_swizzle` (176 of them). It exports one function, `hf(scratchpad, size, hash, fill_state, kptr)`.
  - **Build:** `wasm/build.sh` compiles it with `clang-19 --target=wasm32 -msimd128 -mrelaxed-simd -matomics -mbulk-memory -nostdlib` and `wasm-ld-19` (`--import-memory --shared-memory --max-memory=4GiB --no-entry`). The result is 4.3 KB; it imports only the shared `env.memory` and has no data section, globals or stack.
  - **Embedding:** the bytes are written to `wasm/src/src/rx_aes_relaxed_blob.h`, which is committed and rewritten only when its content changes, so the Makefile doesn't loop. Without clang-19, the committed header is used.
  - **Constants:** the 17 vpaes vectors plus the 1R states, keys and xkeys sit in the host struct `rx_aes_relaxed_k` in `aes_hash.cpp`, filled at startup, and are passed by pointer. The side module has no constants of its own in memory.
  - **Bridge:** EM_JS `rx_js_aes_relaxed_hf` in `soft_aes.cpp`. On first use it compiles and instantiates the blob per worker (cached in `globalThis.__rxAesR`). It copies the bytes from `mem.buffer`, because `HEAPU8` can be stale after memory growth. Any failure caches `null`, and the worker falls back for good.
  - **Hook:** the first line of `hashAndFillAes1Rx4<softAes>`, `if (softAes && g_rx_aes_relaxed && rx_aes_relaxed_hf(...)) return;`; otherwise the existing path runs. `rx_aes_relaxed_calls()` counts successful calls, so tests can catch a silent fallback.
  - **Index rule:** every relaxed swizzle index is in 0..15 (masked nibbles, constant permutations) or 0x80..0x8f (vpaes's `k_inv` outputs). x86 `pshufb` and ARM `tbl` agree on those, so forcing `?jit_profile=x86` on ARM still hashes correctly.
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
- **AES needs `relaxed_swizzle` on x64:** the relaxed side module turns each lookup into one `pshufb`, and that gives the +7.6% at 12T (AES was 13% of the 1T mining thread). Because relaxed ops can't go in `randomx.wasm` (Safari), they live in a separate module that only relaxed engines ever compile.
- **SIMD AES is perf-neutral on x64:** V8 lowers each non-relaxed `i8x16.swizzle` to `movq`, `vpaddusb [const]` and `vpshufb`, i.e. 3 instructions and 2 loads. vpaes needs about 11 swizzles per round, so a round is about 61 instructions (enc) or 74 (dec), against about 95 for the T-table. The measurement was 1T 107.6 → 104.8 and 12T 609 → 610.

## 6. Pitfalls and caveats
- **Firefox may land on arm.** If Firefox doesn't expose relaxed SIMD, `isX86()` can't compile and `auto` picks **arm** even on x86. It still works, just without the x86 gains. Check the `JIT profile:` status line in Firefox. A fallback probe without relaxed SIMD (a UA or timing check) is not written yet.
- **Safari is always arm**, including on Intel Macs, by design (see §3).
- **Rosetta:** an x86 browser under Rosetta on Apple Silicon probes as x86 (the probe tests the semantics of the emitted code) and gets the x86 profile. Untested.
- **The probe relies on implementation-defined behaviour.** If an engine ever canonicalises out-of-range `relaxed_swizzle` to 0 on x86, the probe fails safe to arm.
- **The x86 profile has not been measured on ARM.** `bench/arm_ab.sh` runs `--profile arm` vs `--profile x86` at 1T/10T on the M4. Only if the result is ≥0.98× at every thread count should x86 values become the global default. Note that this A/B now also toggles `aes_simd`, and vpaes should do better on arm64, where a swizzle is one `TBL`.
- **The AES gate gap:** `full_mode_check` and `mine_ctx_check` compare the JIT against the portable interpreter **in the same module**, and both read the same AES flags, so they would pass with a broken AES. **`bench/aes_check.mjs` is the AES gate:** T-table against relaxed through the first/next/last chain, plus the canonical vector and a check that the relaxed path really ran. The `rx_aes_selftest(n)` export covers the vpaes rounds.
- **Relaxed AES needs relaxed SIMD** (feature bit 1 or 2). Firefox without relaxed SIMD and Safari silently use the older AES path, so check `aes_relaxed=` in the status line. Each worker compiles the 4.3 KB side module on its first hashAndFill; V8's native module cache dedupes this.
- **Rebuilding the side module needs clang-19 and `/usr/bin/wasm-ld-19`.** Without them, build.sh keeps the committed `rx_aes_relaxed_blob.h`, so a C change to `aes_relaxed.c` silently does nothing on a box without clang-19.
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
| `bench/aes_check.mjs` | AES gate: T-table vs relaxed (chain + canonical vector), the relaxed call counter, and the knob semantics; needs Node ≥24 |

**perf recipe:**
- `sudo sysctl -w kernel.perf_event_paranoid=-1` (it resets on reboot).
- jitdump needs `perf record -k 1`, and **IBS can't use `-k 1`**, so use plain `cycles`.
- `perf report` on a V8 jitdump is unusably slow (86k JIT objects); use the parsers above.
- `node --trace-wasm-compilation-times` counts TurboFan compiles, which verifies code sharing.

**Gates** (all must print OK):
- `node bench/full_mode_check.mjs --count 32` at `--feature-base 3`, `0`, `1`, and `0 --feature-extra 32`, for `--profile arm` and `x86`;
- `node bench/light_mode_check.mjs` at `--feature-base 3`, `0`, `1`, for `--profile arm` and `x86`, on both builds (`RX_BUILD=st` for `randomx_st`), and with `--light-mlp 0`, `1`, `2` (§9.2);
- `node bench/supjit_check.mjs`, both builds (the full-mode gates can't see a broken superscalar kernel, since both of their sides read the kernel-built dataset), and with `--kernel-k 1` to `4` (§9.2);
- `node bench/mine_ctx_check.mjs`;
- `node bench/fb_full_check.mjs` (no-SAB full replicas, §9.1), also with `--light-mlp 2 --kernel-k 2`;
- `node bench/coi_e2e.mjs` (headless Chromium, `?coi=1`; only when `index.html`, `miner.js` or `coi-sw.js` change);
- the ARM identity check;
- `node bench/aes_check.mjs` (must print `AES CHECK PASS`);
- `/usr/bin/node` (v20) `WebAssembly.validate(public/randomx.wasm)` must be true, meaning there are no relaxed ops in the main module.

## 8. Open levers
1. ~~**AES with `relaxed_swizzle`**~~ **Done for hashAndFill** (`813a0d4`): a separate 4.3 KB relaxed side module (`wasm/aes_relaxed/`), whose bytes are embedded in `randomx.wasm` and instantiated per worker only when `aes_relaxed` (x86 = 1) is set and the feature has relaxed SIMD. One run: 1T 105.1 → 108.8 H/s (+3.5%), 12T 630.4 → 678.4 (+7.6%). Left: `fillAes1Rx4`/`hashAes1Rx4`/`fillAes4Rx4` (about 2% of rounds) are still on the plain swizzle.
2. **The remaining AES on relaxed:** `fillAes4Rx4` (program generation), `fillAes1Rx4` and `hashAes1Rx4` (the first and last hash), about 2% of rounds, go into the same side module. A small gain.
3. **Float-arm trims:** `v128.const 0` is rematerialised 3× per FADD/FSUB, and the rounding fixup could be tighter (+2–4%).
4. **Size-aware pair selection** (prefer small integer pairs per byte of code) for the 12T footprint.
5. **A Firefox fallback** for `auto` detection without relaxed SIMD.
6. **The M4 sign-off** (`bench/arm_ab.sh`), then possibly one profile for all.
7. **`aes_simd` for x86:** the vpaes rounds on plain swizzle are neutral. They now only run where the relaxed module doesn't: the other AES functions, or engines without relaxed SIMD. 0 is the conservative choice.
8. **A slimmer deliverable, if it ever matters:** `randomx.wasm` was 242 KB raw (86 KB gzipped) before the relaxed side module; the embedded 4.3 KB blob plus the bridge add a little. See §6.

## 9. No-SAB fallback (`nosab`, 2026-09-30)
When the page is not `crossOriginIsolated` (no COOP/COEP), there is no SharedArrayBuffer, no shared `WebAssembly.Memory` and no pthreads. Before this, `worker.js` threw and nothing ran, not even `?light=1`. Now the miner falls back to a fast light mode; `?sab=0` forces it on an isolated page for A/B.

**Decision: light mode first.** Full mode would need a private 2 GB dataset per worker. Light mode needs 256 MiB per worker and no dataset build, and in wasm it loses much less than in native RandomX. The VM itself is ~9 ms/hash, so the per-hash item work (16384 × t_item) is not 10× on top of it.

**Pieces** (commits `a3d3653`, `40a3b79`, `7289a20`, `691c474`):
- **`randomx_st.{js,wasm}`**: a second emcc run in `wasm/build.sh`, same sources without pthreads (`ST_BUILD=0` skips it). The generated modules import a max-only memory (`RXJIT_MEM_FLAG` = `0x01`; `0x03` in the pthread build). The relaxed AES blob is built twice (`rx_aes_relaxed_blob_st.h`). The pthread `randomx.wasm` stayed byte-identical through the build change.
- **JIT'd light mode** (both builds): `vm_interpreted.cpp` sends light VMs (`cachePtr`) to `rxjit_run_program_light`.
  - That builds the superscalar item function `item(i32 item, i32 out)` per cache (pointer + `cacheKey`) via `rxjit_emit_superscalar_item_fn`.
  - It embeds that function into the threaded module as function 24 / type 4 (`rxjit_threaded_set_light_fn`).
  - Step 7 calls it with item = ds_ptr (`dataset_offset/64`) + ma/64, into arena +960 (`RXJIT_ARENA_ITEM_OFF`), before the usual xor. Without a light fn the bytes are the full-mode ones, so the arm identity holds.
- **Inline mulh in the superscalar kernel:** V8 doesn't inline the stub calls, and they were ~39% of the item time. This speeds up the dataset init as well.
- **Browser:** `miner.js` `NoSabPool` is a Worker-shaped facade over N `worker.js?build=st` workers (`?threads=`, default `hardwareConcurrency`), one mining thread each.
  - Each worker has its own cache and a disjoint nonce slot (`nonceSlot/nonceSlots`).
  - It sums the hashrates, passes shares through, and emits `ready` once.
  - `worker.js` now also JITs the isolated `?light=1`.

**Numbers** (Zen 3, 1T unless noted):

| | t_item | light ms/hash | H/s per worker |
|---|---|---|---|
| before (interpreter) | 16.7 µs | ~320 | ~3 |
| light JIT | 1.44 µs | ~36 | ~28 |
| + inline mulh | 1.18 µs | ~32 | ~31 |
| Chromium, no COOP/COEP, 2 workers (before inline mulh) | | | 59 summed |

**Scaling** (Node `nosab_bench.mjs`, `randomx_st`, x86 profile, one 15 s run each, 2026-09-30; t_item 1.218 µs):

| workers | light | `--light-vms 2` (removed) | `--full 1` | `--full 2` |
|---|---|---|---|---|
| 1 | 33.7 | 31.5 (−6%) | | |
| 6 | 193.0 (32.2/w) | 186.5 (−3%) | 258.5 (+34%; full 97.6 + 5 × 32.2) | |
| 12 | 252.5 (21.0/w) | 226.2 (−10%) | 270.4 (+7%; full 49.7 + 11 × 20.1) | 298.8 (+18%; 2 × ~50 + 10 × 19.9) |

SMT costs a light worker ~35% (32 → 21 H/s) and a full one ~50% (98 → 50); 12 workers are 1.31× 6. The cooperative build takes 7.4 s (12 workers, K = 1 or 2) and 8.8 s (6 workers, K = 1), about 2× the §9.1 estimate at 12. Per seed, K = 2 at 12 workers repays a 7.5 s build of all 12 workers in ~40 s.

t_item breakdown: ~0.4 µs of dependent cache misses (1.04 µs with the cache index masked to 64 KiB). Of the remaining compute, mulh is still ~0.3 µs (0.88 µs with mulh replaced by `i64.mul`).

**Gates:** `light_mode_check`, `supjit_check`, and every older gate on `RX_BUILD=st`. The browser E2E is a scratch script: a server without COOP/COEP, headless Chromium over CDP, `NoSabPool` on a synthetic job, shares re-verified in Node.

**Caveats:**
- Memory is ~300 MB per worker (12 workers ≈ 3.6 GB); `?threads=` caps it.
- Each worker runs its own Argon2 cache init (0.7 s at 1T).
- `wasm_jit_superscalar.cpp`'s kernel still defines the mulh stubs (fn 0/1, now unused).
- Wide arithmetic (`i64.mul_wide_u`) is not in V8 14.6, not even behind a flag.

**2-VM lockstep light mode: tried and removed.** One thread ran two hashes at once, with the two item computations interleaved instruction by instruction (`item2`, `main_loop2`, `rxLightHash2`, knob `?light_vms=2`). It was bit-exact, but measured slower at 1/6/12 workers (−6%, −3%, −10%, with every pair in lockstep). The causes: two 2 MB scratchpads per thread double the L2 footprint, `item2`'s ~22 live values spill on x64's 16 GPRs, and the item is instruction-bound rather than latency-bound. It was reverted from `perf/amd64`; the code is still on branch `nosab/light-2vm` (`838d06d`) for an arm trial.

**Open levers:**
1. Measure 1/6/12 workers in Chromium (Node numbers above).
2. ~~Multi-VM lockstep~~ tried and reverted (above); slower on Zen 3 at 1/6/12 workers. Branch `nosab/light-2vm` for an arm trial.
3. ~~A lower-latency mulh~~ tried (branch `nosab/mulh-lat`, not merged): 4 independent partial products cut the chain from ~11 to ~8 ops but add ~3 ops per mulh, and it was ~5% slower per item and ~3% slower in light H/s on Zen 3. The item is throughput-bound, not latency-bound, so only fewer ops per mulh would help. Might still be worth trying on arm. Fewer ops per mulh: done in §9.2 (signed shifts, squares).
4. ~~Opt-in full replicas~~ **Done** (`?fb_full=K`, see §9.1); opt-in, default K = 0 (see `NOSAB_KNOBS.md`).
5. One cache build broadcast to all workers.
6. OPFS persistence.
7. ~~**Item MLP**~~ **Done** (§9.2): x86 defaults `light_mlp=2`, `kernel_k=4` (chunk kernels 1).
8. **Opt-in `?coi=1`** (merged, off by default; §9.3): a COOP/COEP service worker (`public/coi-sw.js`) makes a header-less secure-context page `crossOriginIsolated` after one reload, so it leaves this path for SAB full mode (Node ~630 vs 278 H/s at 12 threads; Chromium 548 vs 263). It changes nothing for plain-HTTP LAN pages, Firefox private windows or header-sending deployments. `bench/coi_e2e.mjs` covers it; the details are in `NOSAB_KNOBS.md` §2a.

### 9.1 Full replicas (`?fb_full=K`, K = 0–2, default 0)
**Default: K = 0, opt-in.** One replica wins in the Node benches (+7% at 12 workers, +34% at 6; K = 2 +18% at 12), but costs ~2.3 GB and a ~7.5 s build per seed, so it stays a knob (a default of 1 was tried in `3f7ec77` and reverted). The URL parameters and how they combine are in `NOSAB_KNOBS.md`.

Workers 0..K-1 of the `NoSabPool` get a private dataset (~2.3 GB each: dataset + cache + heap); all N workers build it together per seed, then the replicas mine in full mode (1 thread, JIT) and the others stay light.
- **`rxInitItemsInto(cache, dst, start, count)`** (`wasm_jit_compiler.cpp`, both builds): items into any buffer on the supjit kernel, regenerated per call with `dataset_base = dst - start*64` (the kernel's `out` wraps in i32 back to `dst`); falls back to `initDatasetItem`. The regen + compile is ~0.1 ms, and a fresh kernel runs at full speed from its first call.
- **`public/fb_full.js`** (classic script: `RxFbFull` global, or `require()`): `FbCoordinator` (main thread) and `FbWorker` (worker side), shared by `miner.js`/`worker.js` and the Node pool (`bench/nosab_pool.mjs`).
  - Each worker reports `fb_cache` after its cache build; a replica allocates its dataset once (kept across seeds; a failed allocation demotes it to light).
  - Once all replica-role workers have reported, the coordinator hands out 2^16-item chunks (4 MiB; 520 per dataset, the last one short) to the least-busy worker: 2 requests per worker, at most 2N chunks in flight until every replica has written them.
  - A light worker returns a transferable `HEAPU8.slice`; a replica computes its own chunks straight into its dataset (and shares them only with K = 2). The coordinator forwards to the replicas (clones first, the last one takes the buffer), each writes at `(randomx_get_dataset_memory(ds)>>>0) + start*64`.
  - A replica with all chunks gets `fb_finalize`: full-mode VM on the dataset, cache released, `mode: full`. A new seed (`job`) starts a new epoch; stale messages are dropped by seed.
  - `worker.js`: the mine loop yields to queued chunk work and runs 50 ms slices while a build is on (a replica's writes stuck behind a 900 ms slice would stall everyone at the in-flight cap). Without `fbRole` in `init` nothing changes.
- **Build time**: 3 workers ≈ 16–17 s in Node (both K = 1 and 2), 4 workers with K = 2 ≈ 15 s in Chromium; 6 workers 8.8 s and 12 workers 7.4 s in Node benches (SMT: ~2× the 4 s a linear 1.3 µs/item/worker would give).
- **Gates:** `bench/fb_full_check.mjs` (replicas built by 3 workers, K = 2: reference vectors + light interpreter, before and after a seed change); `supjit_check` now also compares `rxInitItemsInto` with `randomx_init_dataset` on random ranges (kernel and fallback, the dataset's top end past 2 GiB). `nosab_bench.mjs --full K` prints the build time and per-worker roles.

### 9.2 Superscalar item MLP (`light_mlp`, `kernel_k`, 2026-10-01)
Branch `nosab/x-item-mlp`. The item is throughput-bound plus 8 dependent cache misses (~0.4 µs of ~1.1 µs). Moving a miss earlier within one item does not help: a load at the ROB head blocks retirement wherever it sits. Having **two independent misses in flight** does. The only independent addresses are other items: in light mode, `mx` after step 5 is exactly the next iteration's `ma`, so item(i + 1) is known at step 7 of iteration i (a depth of 2 is the ceiling; item(i + 2) needs i + 1's registers). In the dataset-init kernel every item is independent.

**Changes** (`wasm_jit_superscalar.cpp`, `wasm_jit_threaded.c`, `wasm_jit_run.cpp`):
- **shd + early** (`a08f146`, always on): ISMULH_R uses arithmetic shifts for aH, bH and the two t-derived shifts, which gives mulhs directly, so the 10-op sign correction is gone. Qword 0 of each mix block is loaded right after the address, before the program.
- **Square mulh** (`3306b97`, always on): for src == dst, `aL*bH` is emitted as `aH*bL`, the same expression `t` uses, and TurboFan's value numbering folds them. The jitdump shows 43 fewer `imul` and 43 fewer instructions per item for the bench key (2045 → 2002).
- **`emit_itemK_compute`** (`ItemLocals` per item, ported from `nosab/light-2vm`): K items as blocks. Per program it emits the K mix addresses, the K early loads back to back, then each item's program, xor and next registerValue in turn. It does not interleave op by op, because that spilled in 2-VM lockstep. K = 1 emits the old bytes exactly; the light fn and kernel were diffed.
- **`kernel_k`** (1..4, `rxjit_set_kernel_k`, profile field): the supjit kernel does K items per loop trip. A short last trip clamps item k to `endItem - 1` with a `select` and rewrites the last item's 64 bytes, so there is no tail loop. `out_k` wraps like `out` (`rxInitItemsInto`). The kernel buffer is now 512 KiB. The generator checks a conservative size bound first (≤ 90 B per mulh, ≤ 16 B per other op) and falls back to K = 1.
- **`light_mlp`** (0..2, `rxjit_set_light_mlp`, profile field), step 7 of the light module:
  - `1` (probe): before the call, the next item's first cache line is loaded into arena ITEM qword 0. The store keeps V8 from dropping the load.
  - `2` (item pairing): 2048 iterations per `main_loop` call, and `ic` counts down, so on even iterations (ic even) `item_pair(ds+ma/64, ds+mx/64, arena ITEM)` computes both items as one 2-item block. The second item goes to arena +5184 (`RXJIT_ARENA_ITEM2_OFF`). The xor then reads `ITEM + (ic & 1) * 4224` without a branch, so an odd iteration uses the line the even one left.
  - Type 4 becomes `(i32, i32, i32) -> ()`. The pair fn has no baked arena pointer, so `shared_code` still gives identical bytes.
  - The light fn's regen key includes the mode. The pair fn falls back to the one-item fn if its size bound exceeds the light fn cap (now 256 KiB).
- **Defaults** (after the idle-box A/B in §9.3): x86 `{light_mlp 2, kernel_k 4}`, arm unchanged `{0, 1}`. `rxInitItemsInto` (the `fb_full` chunks) uses `rxjit_chunk_kernel_k()`: the `kernel_k` override if set, else 1, because a chunk kernel is regenerated and recompiled per 4 MiB chunk and larger K made the 12-worker cooperative build slower (K = 1 / 2 / 3 / 4: 6.7 / 7.5 / 8.5 / 10.5 s). The arm full-mode module is byte-identical under every knob value.

**Measured on the branch** (Zen 3, Node, x86 profile, box not idle, load 1–3; the idle-box numbers are in §9.3):

| | value |
|---|---|
| supjit µs/item, 1T st (step 0 / +square) | 1.082 / 1.070 |
| supjit `kernel_k` 2 / 3 / 4 | 0.953 / 0.915 / 0.905 (−11% / −14% / −15%) |
| light 1T `light_mlp` 0 / 1 / 2 (`nosab_bench`, 10 s, ABAB) | 36.2 / 36.0 / **43.5 H/s (+20%)** |
| SAB full-dataset init, 10 threads, `kernel_k` 1 / 2 / 3 / 4 (one run each) | 5.27 / 4.71 / 4.61 / 4.46 s |
| `fb_full_check` build (3 workers, K = 2), `kernel_k` 1 / 2 | 14.9 / 12.8 s |

- The probe does nothing (−0.6%), like `touch_line0` before it, but pairing gives +20%, about twice the estimate. Part of that is fewer item calls and main-loop steps per item. The ROB-exposure model holds only for true MLP.
- **Not measured on the branch** (done in §9.3, except THP off): 6 and 12 workers, SAB 12T H/s with `kernel_k`, Chromium.
  - 12 workers was the risk (the pair fn is ~71 KB of x64 vs 35 KB, shared by SMT siblings); it still gained +4% there (§9.3).
  - Rule for flipping x86 defaults: `light_mlp=2` if it wins at 1 **and** 12 workers (12 must not lose beyond noise); `kernel_k` = the best K if it wins on both builds' supjit_check and doesn't slow the SAB 12T init.
- **jitdump** of the pair fn: 17.6k instructions, 4004 `imul`, 536 `rbp` spill ops (2 × 92 in the one-item fn; ~22 extra per block switch, as expected for 10 idle live values). The two early loads are adjacent at the top of each program pair.
- **Finding for later:** V8 emits every mix-block qword load **twice**: a dead `mov r15, [addr]` (the protected load, kept) and the same load folded into the `xor`. The early qword-0 load works as a prefetch only; the xor reloads it. That's ~64 redundant loads per item.

**Gates added:**
- `light_mode_check --light-mlp 0|1|2` (all profiles and features, both builds). After the second key it also flips `light_mlp` 0 ↔ 2 on the same cache (regen key).
- `supjit_check --kernel-k K`, with extra short ranges (counts 2, 5, 7) so that count % K ≠ 0.
- `fb_full_check --light-mlp 2 --kernel-k 2`.
- The arm identity under light_mlp/kernel_k combinations.

### 9.3 Last push (2026-10-01): four branches measured, two merged
Four experiment branches from `a8b7ca0`, each built in its own worktree and measured on an idle box (Node 26, x86 profile, one 15 s run after a 4 s warm-up; item cost is `RX_BUILD=st node --no-liftoff bench/supjit_check.mjs --items 262144`). The baseline, rebuilt, was item 1.214 µs, 1 worker 33.3 H/s, 12 workers 243.0 (252 in §9; ±5% at 12).

| Variant | item µs | 1w H/s | 12w H/s | Verdict |
|---|---|---|---|---|
| baseline `a8b7ca0` | 1.214 | 33.3 | 243.0 | |
| item-mlp, `light_mlp` 0 (shd + early + square only) | 1.128 (K = 1) | 36.0 (+8%) | 267.8 (+10%) | |
| item-mlp, `light_mlp` 2 (pairing) | 0.981 (K = 4) | **43.5 (+31%)** | **278.0 (+14%)** | **merged, x86 default** |
| vm-light-tune, `vm_smulh_hd` 1 / 0 | = base | 33.5 / 33.6 | 246.9 | dropped (SAB 1T −3%, see below) |
| vm-light-tune, light tables 1600/1000 | = base | 34.6 (+3%) | 242.3 (−2%) | dropped (0% on top of pairing) |
| vm-light-tune, light tables 400 | = base | 32.1 (−4%) | | dropped |
| light-pipeline, `pipeline` 0 / 1 | = base | 34.1 / 34.3, rerun 33.7 / 33.7 | 243.6 / 249.1 | dropped (neutral) |
| coi-sw, Chromium, header-less page, 12 threads, 20 s | | | no param 224 → `?coi=1` 597 (SAB full) | **merged, opt-in** |

- **item-mlp** (§9.2) is the whole gain. Supjit item cost by K: 1.128 / 1.008 / 0.982 / 0.981 µs. SAB 12T dataset init by K: 4.52 / 4.36 (K = 3) / 4.21 s (K = 4), against 4.96 s at the baseline. `fb_full=1` at 12 workers: cooperative build 6.7 / 7.5 / 8.5 / 10.0–10.5 s at K = 1 / 2 / 3 / 4 (two runs of 3 and 4). So K = 4 for `rxInitDatasetStart` and 1 for the chunk kernels (§9.2 defaults). At 3 workers K = 2 was faster (`fb_full_check`: 15.1 → 13.0 s); the cause of the 12-worker loss (per-chunk recompile or SMT code footprint) was not measured.
- **`vm_smulh_hd`** (signed Hacker's Delight ISMULH in the VM): SAB full mode, x86, 1T 102.2 / 102.0 H/s (0) vs 99.9 / 98.6 (1), two alternating runs, and 12T 632.6 vs 620.8. It removes ops but is ~3% slower, the same pattern as `nosab/mulh-lat`. Light mode was neutral. Not merged.
- **Light-only dispatch tables** (`fuse_n_light`, `triples_n_light`): +3% at 1 worker before pairing, −2% at 12. On the merged build, `--fuse-n 1600 --triples-n 1000` gives 43.6 vs 43.6 at 1 worker, so there is nothing left to tune. Not merged; the branch keeps the per-worker module FNV report (all 12 workers share one module in Node and Chromium) and `bench/smulh_check.mjs`.
- **Pipelined first/next** (`?jit_exp=pipeline=1`, every hash's AES through the relaxed side module): +0.6% then 0.0% at 1 worker, +2% at 12 (noise). Not merged.
- **`?coi=1`** (`public/coi-sw.js`, `NOSAB_KNOBS.md` §2a) stays opt-in: it registers a service worker that persists and reloads the page once, and `require-corp` constrains future cross-origin embeds. Whether to default it is a product decision.

**Combined** (`perf/amd64` after the merges, same protocol):

| | start of push | now |
|---|---|---|
| supjit item | 1.22 µs | 0.980 µs (K = 4), 1.139 µs (K = 1) |
| 1 worker | 33.7 H/s | 43.7 (+30%) |
| 6 workers | 193 | 250.6 (+30%) |
| 12 workers | 252 | 278.2 (+10%) |
| Chromium, no COOP/COEP, 12 workers (`coi_e2e` plain, 20 s) | 224 | 263 (+17%) |
| SAB full 12T (`bench_webui --threads 12`) | 632.6 H/s, init 4.96 s | 631.2 H/s, init 4.21 s |

SMT now adds only 11% for light workers (6 → 12: 251 → 278). The branches `nosab/x-vm-light-tune` and `nosab/x-light-pipeline` are kept for reference.
