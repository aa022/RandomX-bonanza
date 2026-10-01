# NOSAB_KNOBS.md: configuring the no-SharedArrayBuffer fallback

This covers what runs when the page has no SharedArrayBuffer, and how to tune it. The design and history are in `appendix_handoff.md` §9 and §9.1.

## 1. When the fallback is used
`public/miner.js` decides once, at page load:

```js
const noSab = params.get('sab') === '0' || window.crossOriginIsolated !== true;
```

- **Isolated page** (the COOP/COEP headers are present): the normal path runs. That is one `worker.js` running the pthread build `randomx.wasm`, full mode by default. Nothing below applies.
- **Not isolated, but a secure context (HTTPS or localhost) and `?coi=1`**: `public/coi-sw.js` turns this case into the isolated one. See §2a.
- **Not isolated, or `?sab=0`**: the no-SAB path runs.
  - `NoSabPool` is a stand-in with the same interface as a `Worker`. It runs N workers, each `worker.js?build=st` loading `randomx_st.wasm` (no pthreads, non-shared memory), with one mining thread per worker.
  - Every worker has its own 256 MiB cache and a disjoint slice of the nonce space.
  - `?sab=0` on an isolated page forces this path, which is useful for A/B on one origin.

The build is chosen by the worker's URL (`build=st`), not by the init message, because `importScripts` runs before any message arrives.

## 2. URL parameters on the no-SAB path

| Parameter | Default | Effect | Memory |
|---|---|---|---|
| `?sab=0` | off | Forces the no-SAB path on an isolated page | |
| `?coi=1` / `?coi=0` | off | `1`: registers the COOP/COEP service worker and reloads once, so the page comes back isolated and takes the SAB path (§2a). `0`: unregisters it | SAB full: ~2.6 GB instead of 3.6 GB at 12 threads |
| `?threads=N` (1–32) | `hardwareConcurrency` | Number of workers, i.e. mining threads | ~300 MB per light worker |
| `?fb_full=K` (0–2) | **0** | Makes workers 0..K-1 full-dataset replicas; the rest stay light | +~2.3 GB per replica |
| `?jit_profile=auto\|arm\|x86` | `auto` | Generator profile, per worker (same as the isolated path) | |
| `?jit_exp=…` | – | Codegen overrides, e.g. `fuse_n=N`, `shared_code=0\|1`, `aes_relaxed=0\|1`, `no_supjit` (same as the isolated path) | |
| `?jit_exp=light_mlp=N` (0–2) | profile (x86 **2**, arm 0) | Light workers, step 7: `0` one item per iteration; `1` loads the next item's first cache line early (probe, no gain); `2` computes this and the next iteration's item together on even iterations (item pairing: +21% at 1 worker, +4% at 12 over `0`) | ~36 KB more x64 code (the pair fn) |
| `?jit_exp=kernel_k=N` (1–4) | profile (x86 **4**, arm 1); `fb_full` chunks 1 | Dataset-build kernel items per loop trip. The profile value applies to the isolated path's full-mode init (12T: 4.52 s at K = 1, 4.21 s at K = 4). The `fb_full` chunk kernels use 1 unless this knob is set, because larger K made the 12-worker build slower (6.7 s at K = 1, 10.5 s at K = 4) | |
| `?nojit=1` / `?jit=0` | JIT on | Portable interpreter (~3 H/s per worker, debugging only) | |

- **`?light=1` / `?full=0`** do nothing on the no-SAB path: a worker is always light unless `fb_full` makes it a replica. The light workers use the JIT (threaded interpreter plus the embedded superscalar item function).
- **`?init_threads`** does nothing either: every worker helps build the dataset when `fb_full > 0`.
- **The status line and log** report the choice, e.g. `No SharedArrayBuffer: 12 single-thread light-mode workers …`, then `fb_full=1: 1 of them build and mine on a full dataset replica` and `fb_full: 1/1 replica(s) mining in full mode`.

## 2a. `?coi=1`: the COOP/COEP service worker
Some deployments serve the page in a secure context but can't set COOP/COEP: static hosts, CDNs, or proxies that drop the headers. There the page lands on the no-SAB path (278 H/s at 12 workers on a 5600X, against ~630 for SAB full mode).

With `?coi=1`, a same-origin service worker (`public/coi-sw.js`, the coi-serviceworker technique) re-serves every response with `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Resource-Policy: same-origin`. After one reload the page is `crossOriginIsolated`, and `miner.js` takes the normal SAB path with no other change. It stays opt-in; any default is a product decision.

- **Where it lives:** an inline script in `index.html`, before `fb_full.js`/`miner.js`. It runs only with `?coi=1`, when the page is not isolated, the context is secure, `navigator.serviceWorker` exists, and `?sab=0` is not set.
  - It registers `coi-sw.js` relative to the page, so the scope is the page's directory and sub-path deployments work.
  - On `ready` or `controllerchange` it reloads, once per tab: a `sessionStorage` flag (`coiReloaded`) stops loops, and it is cleared once the page is isolated.
  - While it waits, `window.__coiPending` holds Start. If registration fails or nothing is active after 10 s, Start continues on the no-SAB path.
- **Staying isolated:** once registered, the worker persists. Later loads of the page without `?coi=1` stay isolated, and the log says `coi: service worker active`. **`?coi=0` removes it**: it unregisters, reloads once if the page was controlled, and the next load is no-SAB again.
- **Gives up without looping** when the page is controlled but still not isolated (the browser ignores injected headers, or another worker owns the page), when a reload already happened in this tab, when `sessionStorage`/`serviceWorker` throw (private windows), or when registration fails. Each case logs a `coi: …` line and mining runs on the no-SAB path.
- **Never caches:** the worker is a pass-through, so a deploy's new `worker.js` and wasm are never stale. Opaque responses (status 0) pass unchanged.
- **Doesn't help:**
  - plain-HTTP LAN pages: an insecure context has neither service workers nor SAB;
  - Firefox private windows: no service workers;
  - deployments that already send the headers: already isolated, so the script does nothing (the proxy, `make serve`).
- **COEP caveat:** `require-corp` blocks future cross-origin subresources that lack CORP or CORS. `index.html` has none today, and the fonts are local. If some are added, the escape hatch is `Cross-Origin-Embedder-Policy: credentialless` in `coi-sw.js` (Chromium/Firefox). The pool WebSocket is not subject to COEP.
- **Measured:** where it applies, 12 threads go from no-SAB light to SAB full: 224 → 597 H/s in headless Chromium before item pairing, 263 → 548 after (`coi_e2e`, 20 s, noisy). In Node that is 278 → ~630, and 1 thread ~44 → ~100. RAM goes from 3.6 GB to ~2.6 GB. The cost is one reload on the first visit plus the usual SAB dataset init. Nothing changes anywhere else.
- **Check:** `node bench/coi_e2e.mjs [--threads 2 --secs 8 --full 0|1]`. It serves `public/` over http://127.0.0.1 without headers and drives headless Chromium. The scenarios are: no param; `?coi=1` (one reload, then SAB light and full runs); reload without params; `?coi=0`; service workers stubbed away; registration failing while Start waits; `coi-sw.js` without the header injection. Shares are re-verified in Node.

## 3. How `fb_full=K` works
- **Build:** after each seed change, all N workers build the replicas' datasets together. `public/fb_full.js` `FbCoordinator` hands out 2^16-item chunks of 4 MB, with at most 2N in flight. Each worker computes its chunk with `rxInitItemsInto` and the supjit kernel, then sends it as a transferable buffer. The replicas copy each chunk into their own dataset.
- **After the build:** the replicas release their caches and mine in full mode (1 thread, JIT); the other workers keep mining light.
- **Failure:** a replica that can't allocate its dataset demotes itself to light and mining continues.
- **The build takes ~6.6 s at 12 workers** (8.2 s at 6) on a Ryzen 5600X, then repeats on each seed change.
- Messages from an old seed are dropped.

## 4. Measured (Ryzen 5600X, Node `bench/nosab_bench.mjs`, `randomx_st`, x86 profile)

| Workers | light only | `fb_full=1` | `fb_full=2` | RAM (light / K=1 / K=2) |
|---|---|---|---|---|
| 1 | 43.7 H/s | | | 0.3 GB |
| 6 | 250.6 | 302.5 (+21%) | | 1.8 / 3.8 GB |
| 12 | 278.2 | 308.5 (+11%) | 299 (+18%, before item pairing) | 3.6 / 5.9 / 8 GB |

Measured 2026-10-01 with item pairing (`light_mlp=2`, x86 default), one 15 s run each. Before it (2026-09-30): light 33.7 / 193 / 252 and `fb_full=1` 259 / 270 at 1 / 6 / 12 workers. The SAB full mode gets ~630 H/s at 12 threads on the same box (`bench_webui --threads 12`, 15 s; 678 in an earlier session). SMT adds only ~11% for light workers (6 → 12), so on memory-tight machines `?threads=` equal to the number of physical cores keeps ~90% of the hashrate at half the RAM.

**Why `fb_full` stays opt-in:** browsers don't report RAM reliably (`navigator.deviceMemory` is capped and missing in Firefox), and a tab killed for running out of memory loses everything. A replica also delays full speed by the build time on every seed.

## 5. Suggested settings

| Situation | URL |
|---|---|
| Default (no knobs) | light workers on every thread |
| HTTPS or localhost page without COOP/COEP | `?coi=1` once (the service worker persists; SAB full mode, ~2.2× at 12 threads, §2a) |
| Plenty of RAM (≥ 16 GB), long session | `?fb_full=2` |
| 8 GB machine | `?fb_full=1&threads=<physical cores>`, or no `fb_full` |
| Low RAM or a shared machine | `?threads=<physical cores>` |

## 6. Node equivalents (benchmarks and checks)
- `node bench/nosab_bench.mjs --workers N [--full K] [--secs 15 --warmup 4] [--profile …] [--light-mlp N] [--kernel-k N]` uses the same protocol over `worker_threads` (`bench/nosab_pool.mjs` + `public/fb_full.js`). The last two match `jit_exp=light_mlp=N` and `kernel_k=N` (`appendix_handoff.md` §9.2).
- `node bench/fb_full_check.mjs [--workers 3 --full 2]` checks that the replicas' full-mode hashes match the reference, across a seed change.
- `RX_BUILD=st node bench/<check>.mjs` runs any check on `randomx_st`.

## 7. Where it lives
- **`public/miner.js`:** `noSab`, `fbFull`, `NoSabPool` (fan-out, hashrate sum, share passthrough, replica roles, `dataset_progress`).
- **`public/worker.js`:** `build=st`, `nonceSlot/nonceSlots`, the `fbRole` messages.
- **`public/fb_full.js`:** `FbCoordinator` and `FbWorker`, shared by the browser and Node.
- **`public/coi-sw.js`** and the inline script in **`public/index.html`**: `?coi=1`/`?coi=0` (§2a).
- **`wasm/build.sh`:** the second emcc run for `randomx_st`, and `ST_BUILD=0` to skip it.

## 8. The embed (`RandomXEmbed`, 0.3.0)
The embed's `mode: 'light'` is this path: a `NoSabPool` port (`workerPool` in `public/embed.js`) with the same `randomx_st` workers, nonce slots and `FbCoordinator`. It runs whether or not the page is isolated; the embed never picks it by itself (`full` on a non-isolated page fails with the header hints and a pointer to `light`). `RandomXEmbed.plan(config)` shows the workers and RAM a configuration resolves to, without starting anything.

| Demo URL | Embed option |
|---|---|
| no-SAB path (`?sab=0`, or not isolated) | `mode: 'light'` |
| `?threads=N` | `workload` (% of cores, default 50, 80% cap), bounded by `maxThreads: N` and the RAM budget (`memory` % of reported RAM, or `memoryCap` GB) |
| `?fb_full=K` | `replicas: 'auto'` (default: the best 0–2 for the RAM budget, a replica counted as 2.25 light workers per §4) or a fixed `K` |
| build on all workers, while mining | the embed's workers build first: no mining until the datasets are done (per seed) |
| `?jit_profile=…` | `tuning.profile` |
| `?jit_exp=light_mlp=N` / `kernel_k=N` | `tuning.lightMlp` / `tuning.kernelK` |
| other `?jit_exp=` tokens | `tuning.experiment`: hash-safe tokens only; `reuse`/`reuse2` throw |
| `?nojit=1` | `tuning.jit: false` |
| `?init_threads=N` (SAB full mode) | `initThreads: N` (full mode only) |
| `?coi=1` | none yet (`coi-sw.js` is not in `dist/`) |
