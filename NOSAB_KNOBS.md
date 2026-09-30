# NOSAB_KNOBS.md: configuring the no-SharedArrayBuffer fallback

This covers what runs when the page has no SharedArrayBuffer, and how to tune it. The design and history are in `appendix_handoff.md` §9 and §9.1.

## 1. When the fallback is used
`public/miner.js` decides once, at page load:

```js
const noSab = params.get('sab') === '0' || window.crossOriginIsolated !== true;
```

- **Isolated page** (the COOP/COEP headers are present): the normal path runs. That is one `worker.js` running the pthread build `randomx.wasm`, full mode by default. Nothing below applies.
- **Not isolated, or `?sab=0`**: the no-SAB path runs.
  - `NoSabPool` is a stand-in with the same interface as a `Worker`. It runs N workers, each `worker.js?build=st` loading `randomx_st.wasm` (no pthreads, non-shared memory), with one mining thread per worker.
  - Every worker has its own 256 MiB cache and a disjoint slice of the nonce space.
  - `?sab=0` on an isolated page forces this path, which is useful for A/B on one origin.

The build is chosen by the worker's URL (`build=st`), not by the init message, because `importScripts` runs before any message arrives.

## 2. URL parameters on the no-SAB path

| Parameter | Default | Effect | Memory |
|---|---|---|---|
| `?sab=0` | off | Forces the no-SAB path on an isolated page | |
| `?threads=N` (1–32) | `hardwareConcurrency` | Number of workers, i.e. mining threads | ~300 MB per light worker |
| `?fb_full=K` (0–2) | **0** | Makes workers 0..K-1 full-dataset replicas; the rest stay light | +~2.3 GB per replica |
| `?jit_profile=auto\|arm\|x86` | `auto` | Generator profile, per worker (same as the isolated path) | |
| `?jit_exp=…` | – | Codegen overrides, e.g. `fuse_n=N`, `shared_code=0\|1`, `aes_relaxed=0\|1`, `no_supjit` (same as the isolated path) | |
| `?nojit=1` / `?jit=0` | JIT on | Portable interpreter (~3 H/s per worker, debugging only) | |

- **`?light=1` / `?full=0`** do nothing on the no-SAB path: a worker is always light unless `fb_full` makes it a replica. The light workers use the JIT (threaded interpreter plus the embedded superscalar item function).
- **`?init_threads`** does nothing either: every worker helps build the dataset when `fb_full > 0`.
- **The status line and log** report the choice, e.g. `No SharedArrayBuffer: 12 single-thread light-mode workers …`, then `fb_full=1: 1 of them build and mine on a full dataset replica` and `fb_full: 1/1 replica(s) mining in full mode`.

## 3. How `fb_full=K` works
- **Build:** after each seed change, all N workers build the replicas' datasets together. `public/fb_full.js` `FbCoordinator` hands out 2^16-item chunks of 4 MB, with at most 2N in flight. Each worker computes its chunk with `rxInitItemsInto` and the supjit kernel, then sends it as a transferable buffer. The replicas copy each chunk into their own dataset.
- **After the build:** the replicas release their caches and mine in full mode (1 thread, JIT); the other workers keep mining light.
- **Failure:** a replica that can't allocate its dataset demotes itself to light and mining continues.
- **The build takes ~7.5 s at 12 workers** (8.8 s at 6) on a Ryzen 5600X, then repeats on each seed change.
- Messages from an old seed are dropped.

## 4. Measured (Ryzen 5600X, Node `bench/nosab_bench.mjs`, `randomx_st`, x86 profile)

| Workers | light only | `fb_full=1` | `fb_full=2` | RAM (light / K=1 / K=2) |
|---|---|---|---|---|
| 1 | 33.7 H/s | | | 0.3 GB |
| 6 | 193 | 259 (+34%) | | 1.8 / 3.8 GB |
| 12 | 252 | 270 (+7%) | 299 (+18%) | 3.6 / 5.9 / 8 GB |

The SAB full mode gets ~678 H/s at 12 threads on the same box. SMT adds only ~25% for light workers, so on memory-tight machines `?threads=` equal to the number of physical cores keeps most of the hashrate at half the RAM.

**Why `fb_full` stays opt-in:** browsers don't report RAM reliably (`navigator.deviceMemory` is capped and missing in Firefox), and a tab killed for running out of memory loses everything. A replica also delays full speed by the build time on every seed.

## 5. Suggested settings

| Situation | URL |
|---|---|
| Default (no knobs) | light workers on every thread |
| Plenty of RAM (≥ 16 GB), long session | `?fb_full=2` |
| 8 GB machine | `?fb_full=1&threads=<physical cores>`, or no `fb_full` |
| Low RAM or a shared machine | `?threads=<physical cores>` |

## 6. Node equivalents (benchmarks and checks)
- `node bench/nosab_bench.mjs --workers N [--full K] [--secs 15 --warmup 4] [--profile …]` uses the same protocol over `worker_threads` (`bench/nosab_pool.mjs` + `public/fb_full.js`).
- `node bench/fb_full_check.mjs [--workers 3 --full 2]` checks that the replicas' full-mode hashes match the reference, across a seed change.
- `RX_BUILD=st node bench/<check>.mjs` runs any check on `randomx_st`.

## 7. Where it lives
- **`public/miner.js`:** `noSab`, `fbFull`, `NoSabPool` (fan-out, hashrate sum, share passthrough, replica roles, `dataset_progress`).
- **`public/worker.js`:** `build=st`, `nonceSlot/nonceSlots`, the `fbRole` messages.
- **`public/fb_full.js`:** `FbCoordinator` and `FbWorker`, shared by the browser and Node.
- **`wasm/build.sh`:** the second emcc run for `randomx_st`, and `ST_BUILD=0` to skip it.
