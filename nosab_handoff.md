# nosab_handoff.md: mining without SharedArrayBuffer

This is the handoff for the **no-SAB fallback**, for pages served without COOP/COEP (so no SharedArrayBuffer, no shared wasm memory and no pthreads). It covers the work of 2026-09-30 and 2026-10-01 on `perf/amd64`, and should give the next person enough to continue without the chat history.

Related documents:
- `NOSAB_KNOBS.md`: how the fallback is configured (URL parameters, suggested settings).
- `appendix_handoff.md` §9–9.3: the full engineering log (design detail, every measurement, gates).
- `opus_handoff.md` and the rest of `appendix_handoff.md`: the SAB/pthread miner, which this work leaves unchanged.

## 1. Result

**Before this work**, a page without COOP/COEP mined nothing, because `worker.js` threw at startup. With the headers present, `?light=1` ran the portable interpreter on 1 thread at ~3 H/s.

**Now** (Ryzen 5 5600X, 6C/12T, Node 26 benches, which the user confirmed translate almost 1:1 to Chromium):

| Page without COOP/COEP | H/s | RAM |
|---|---|---|
| 1 worker | 43.7 | ~0.3 GB |
| 6 workers | 251 | ~1.8 GB |
| 12 workers (default = `hardwareConcurrency`) | **278** | ~3.6 GB |
| 12 workers, `?fb_full=1` (opt-in) | 309 | ~5.9 GB |
| Chromium, 12 workers, measured end to end | 263, shares verified | |
| For comparison: SAB full mode, 12 threads | ~632 (this session; ~678 in older notes) | ~2.6 GB |

- Light mode per thread went from ~3 to ~44 H/s (~14×). On a 12-thread machine a header-less page now does 278 H/s where it did nothing; that is ~90× the old 1-thread `?light=1`, and ~44% of the SAB full mode.
- The SAB path did not regress (631 vs 633 H/s at 12T), and its dataset init got faster (4.96 → 4.21 s).
- The `arm` profile's full-mode module is byte-identical throughout.

## 2. How it works

```
miner.js: noSab = ?sab=0 || !crossOriginIsolated
  └─ NoSabPool (Worker-shaped facade)  ×N  worker.js?build=st  →  randomx_st.wasm (no pthreads, plain memory)
       each worker: own 256 MiB cache, own nonce slot, one mining thread, light mode + JIT
       optional ?fb_full=K: workers 0..K-1 get a private 2 GB dataset, built cooperatively by all N
```

**Build:** `wasm/build.sh` runs emcc twice: `randomx.wasm` (pthreads, unchanged) and `randomx_st.wasm` (single-thread; `ST_BUILD=0` skips it). Generated modules import memory with `RXJIT_MEM_FLAG`: `0x03` (shared) in the pthread build, `0x01` in `_st`. The relaxed-AES side module is built twice; the `_st` copy is `rx_aes_relaxed_blob_st.h`.

**Light-mode JIT**, in both builds. Before this work, light mode had no JIT.
- `vm_interpreted.cpp` sends light VMs to `rxjit_run_program_light` (`wasm_jit_run.cpp`).
- That generates the **superscalar item function** for the current cache (`rxjit_emit_superscalar_item_fn`, `wasm_jit_superscalar.cpp`) and embeds it in the threaded interpreter module (`wasm_jit_threaded.c`, fn 24).
- Step 7 calls it in place of the dataset read, and the item lands in arena +960.
- Everything is arena-relative (`shared_code`), so all workers generate identical bytes, and V8 compiles the module once per process.

**Item pairing** (`light_mlp=2`, default on for the x86 profile):
- A light hash is ~70% item computation, which is instruction-bound plus 8 dependent DRAM misses per item.
- In light mode the next iteration's item address (`mx`) is already known at step 7, so on even iterations one call computes **two** items as blocks, with both cache misses in flight.
- The odd iteration then reads the second item without computing anything. This gives +31% at 1 worker and +14% at 12.

**Multiply-high**, the costliest op: a single `mulh` is ~50% of item compute. What's now in place:
- inline Hacker's Delight instead of the stub call (V8 doesn't inline the stub; −18%);
- a signed variant using arithmetic shifts, which drops the 10-op sign correction and most of the spills;
- a 3-multiply square case;
- the first cache word loaded early.

**Dataset kernel:** `kernel_k` = 1..4 items per loop trip (x86 default 4). It speeds up the SAB full-mode init by 15%. The `fb_full` chunk kernel stays at 1 item per trip, because it's recompiled per chunk and K > 1 was slower at 12 workers.

**Full replicas** (`?fb_full=K`, K = 0–2, **default 0, opt-in by the user's decision**):
- `public/fb_full.js` has `FbCoordinator`, which hands out 4 MB chunks to every worker (`rxInitItemsInto`), and `FbWorker`, which runs in each worker.
- Chunks travel as transferable buffers; the replicas copy them into their own dataset.
- The build takes ~7 s at 12 workers and repeats on each seed change. A replica that can't allocate its dataset falls back to light mode.

**`?coi=1`**, opt-in: `public/coi-sw.js` is a service worker that adds COOP/COEP headers and reloads once, so a header-less **secure-context** page takes the normal SAB path (224 → 597 H/s in Chromium). It doesn't help on plain-HTTP LAN origins or inside a non-isolated iframe; those use the fallback.

## 3. Using it
- **Browser:**
  - Nothing to configure; no headers means the fallback is used.
  - `?sab=0` forces it on an isolated page, for A/B.
  - `?threads=N` sets the worker count. Hyperthreading adds only +11% in light mode, so on low-RAM machines use the number of physical cores.
  - `?fb_full=1|2` for machines with ≥ 8 / 16 GB. `NOSAB_KNOBS.md` has the full table.
- **Node (benchmarks):**
  - `node bench/nosab_bench.mjs --workers N [--full K] [--secs 15 --warmup 4]`: N `worker_threads` on `randomx_st` (no shared memory, the same protocol as the browser via `bench/nosab_pool.mjs` + `public/fb_full.js`).
  - Item cost: `RX_BUILD=st node --no-liftoff bench/supjit_check.mjs --items 262144`.
  - Knobs: `--light-mlp 0|1|2`, `--kernel-k 1..4`, plus the usual `--profile`, `--fuse-n`, … (`bench/profile_args.mjs`). Browser: `?jit_exp=light_mlp=N,kernel_k=N`.
  - House rule: one short run per variant, on an idle box.
- **Correctness gates**, which must pass before merging anything. `RX_BUILD=st` runs any check on `randomx_st`.
  - `supjit_check`: the kernel against `initDatasetItem`, byte for byte. The full-mode gates can't see a broken kernel on their own, because both of their sides read the kernel-built dataset.
  - `light_mode_check`: JIT against the portable interpreter; `--light-mlp 0|1|2`, arm/x86, feature bases 3/0/1, both builds.
  - `fb_full_check`: cooperative replicas, across a seed change.
  - `coi_e2e`: browser, `?coi=1`.
  - Plus the existing `full_mode_check`, `mine_ctx_check`, `aes_check`, `canonical_hash`, the arm identity diff (f7/f4), and `/usr/bin/node` (v20) validating `randomx.wasm`.
  - The exact list is `appendix_handoff.md` §7.

## 4. Tried and dropped, so they don't get re-tried

| Idea | Result | Why |
|---|---|---|
| 2 hashes per thread in lockstep (`?light_vms=2`) | −6/−3/−10% at 1/6/12 workers | Second 2 MB scratchpad per thread, ~22 live values spill; reverted (branch `nosab/light-2vm`) |
| 4-independent-product mulh (shorter chain) | −5% item, −3% H/s | Item is throughput-bound, more ops lose (`nosab/mulh-lat`) |
| Signed HD mulh in the **VM** (`vm_smulh_hd`) | SAB full 1T −3% | Same pattern (`nosab/x-vm-light-tune`) |
| Light-only fusion tables | +3% 1w, −2% 12w, 0% after pairing | `nosab/x-vm-light-tune` |
| Pipelined first/next hashing through the relaxed-AES module | neutral | `nosab/x-light-pipeline` |
| SIMD mulh (`i64x2.extmul`), SIMD item pairs | slower | V8 lowering costs more than it saves |
| Wide arithmetic (`i64.mul_wide_u`) | n/a | Not in V8 14.6, not even behind a flag |
| Prefetching the next mix block early | no gain | RandomX picks the address register with the longest chain; a load at the ROB head blocks retirement anyway |
| Item server (one dataset, served by message) | dead | postMessage RTT ≫ 0.56 µs per iteration |
| Per-program wasm compile in light mode | dead | Compile ≈ savings |
| Whole-program folding / dead-register elimination | < 0.1% | The superscalar generator forbids the foldable patterns |
| Item memo / partial dataset | worse per GB than `fb_full` | Items are uniform, no reuse |

The experiment branches are local to the author's machine; they are not pushed.

## 5. Where the time goes (1T light hash, x86; profiled just before item pairing)
- **Item function:** ~70%. The two mulh ops are the largest share of its compute, and DRAM waits are ~0.35–0.4 µs per item.
- **Threaded interpreter:** ~25%. It runs ~15% slower than in full mode because the item code evicts its L1/L2 lines.
- **AES fill/hash + blake2b:** ~4%.
- **Glue:** < 1%.

## 6. Pitfalls
- **`?light=1` on the isolated (SAB) path** still mines on one thread (~44 H/s); only the no-SAB pool is multi-worker. That's a cheap follow-up (see §7).
- **SAB full-mode baseline:** this session measured ~632 H/s at 12T (`bench_webui --threads 12`) before and after all merges, against ~678 in older notes. It isn't caused by this work; the reason is unknown (thermal or box state?). Also, `bench_webui` with no `--threads` runs 32 threads.
- **Browser memory:** each light worker is ~300 MB and each replica ~2.3 GB. The browser can't report RAM reliably, which is why `fb_full` stays opt-in.
- **`perf` on the dev box** needs root (`perf_event_paranoid=3`). The profiling this time used V8 `--cpu-prof`, `--perf-prof` jitdumps and ablation builds.
- **V8 emits every mix-block load twice** (a dead protected load plus a folded `xor` operand, ~64 per item). Harmless so far, but worth a look.
- **Rebuilding the relaxed-AES blobs** needs clang-19 and wasm-ld-19. Otherwise the committed headers are used, and a change to `aes_relaxed.c` silently does nothing.

## 7. Open levers, most promising first
1. **Multi-worker `?light=1` on the SAB path:** reuse `NoSabPool`, or make light mode multi-threaded under pthreads with one shared cache (256 MB total instead of N×).
2. **The doubled mix loads** in V8 codegen: try operand forms that avoid the protected-load duplicate.
3. **VM slowdown in light mode** (+15% against full): shrink the item/pair function's footprint, or pin the work to reduce L1i/L2 contention.
4. **An arm (M-series) pass:** the x86 defaults (`light_mlp 2`, `kernel_k 4`) have not been measured on arm. The arm profile stays `{0, 1}` until `bench/arm_ab.sh`-style numbers exist. The dropped mulh and 2-VM branches might behave differently there.
5. **Chromium numbers at 1/6 workers,** and Firefox (without relaxed SIMD it gets the arm profile; see `appendix_handoff.md` §6).
