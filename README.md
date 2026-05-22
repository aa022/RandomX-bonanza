# RandomX bonanza

In-browser Monero (RandomX) miner achieving ~13% of native execution efficiency, packaged with an easy to setup demo environment including a simple proxy with live pool presets. The raw miner payload is sub 600 KB. Shoutout to [Opus 4.7](https://www.anthropic.com/news/claude-opus-4-7) and [l1mey112's semifloat implementation](https://github.com/l1mey112/randomx.js).

## Requirements

- emcc (Emscripten SDK) ≥ 3.1
- clang
- binaryen (`wasm-opt`)
- node ≥ 16

Common package-manager examples:

    brew install emscripten node binaryen llvm           # macOS
    sudo apt install emscripten nodejs clang binaryen    # Debian/Ubuntu
    sudo dnf install emscripten nodejs clang binaryen    # Fedora
    sudo pacman -S  emscripten nodejs clang binaryen     # Arch

If your distro's `emscripten` is too old, install the upstream SDK instead:

    git clone https://github.com/emscripten-core/emsdk
    cd emsdk && ./emsdk install latest && ./emsdk activate latest
    source ./emsdk_env.sh

Install project dependencies (toolchain check only — `ws` is vendored under
`vendor/`, no `npm install`):

    make install

## Build & run

    make build      # → public/randomx.{js,wasm}
    make serve      # build + start the proxy on http://localhost:8080
    make test       # canonical RandomX hash vs. reference test vector
    make clean      # remove build outputs
    make fclean     # clean + drop .make/ stamps
    make re         # fclean + build

Open <http://localhost:8080>, press **Start**. The *Wallet setup* panel
overrides wallet/pool per session (persisted in `localStorage`).

## Browser support

- **Chromium / Firefox** — work out of the box over plain HTTP on localhost,
  since browsers treat `localhost` as a secure context (the proxy still
  sends the COOP/COEP headers SharedArrayBuffer / wasm pthreads need).
- **Safari** — refuses `SharedArrayBuffer` outside HTTPS even on localhost,
  so the local demo won't run there as shipped. Drop a self-signed cert in
  front of the proxy (e.g. `caddy reverse-proxy --to :8080` or any HTTPS
  fronting of your choice) and Safari works fine — the live preview at
  <https://randomx.cc/> runs in Safari without issues.

## Bench

    make bench                           # sweep 1,4,32 mining threads @ 30 s/pass
    make bench DURATION=10               # shorter pass
    make bench SWEEP=1,8,16,32           # custom thread set
    make bench INIT_THREADS=16           # dataset init parallelism (1–32)
    make bench SWEEP=32 DURATION=60      # single 32-thread, 60 s pass

Mirrors the webui worker exactly: threaded-interpreter JIT (+ INLINE_FPRC_ZERO
+ V3 regs_in_memory + split_inner_dispatch + supjit kernel) and async dataset
init (`rxInitDatasetStart` / `rxInitDatasetProgress` / `rxInitDatasetJoin`).
Each pass forks a fresh node process so JIT/pthread state cannot leak between
thread counts. CPU model + core count are detected and printed in the
summary.

The standalone scripts also work directly:

    node bench/bench_webui.mjs --threads 32 --duration 30
    node bench/bench_sweep.mjs --sweep 1,4,32 --duration 30
    node bench/bench_regfile.mjs                   # JIT codegen micro-bench

## Efficiency

Apple M4 base · 10 cores · `make bench` (30 s/pass) vs. native
`xmrig --bench=1M` at the same thread count:

    threads   init     WASM H/s    xmrig H/s    efficiency
    ─────────────────────────────────────────────────────
       1     7.54 s        90          693         13.0 %
       4     6.95 s       362         2676         13.5 %
      32     6.65 s       586       ~4000 ¹       14.7 %


WASM tracks ~13 % of native per thread and ~15 % at full load.

## Payload

Total served to the browser per page load: **577 KB**.

    index.html       15.1 KB     ui shell
    miner.js         35.9 KB     ws client + ui control
    worker.js        27.2 KB     wasm engine driver
    randomx.js       47.1 KB     emscripten glue
    randomx.wasm    451.7 KB     randomx engine + JIT + supjit kernel

## Native miners

The proxy exposes a raw TCP stratum endpoint alongside the WebSocket one,
so any standard stratum client (xmrig, p2pool, …) can join the same
upstream session as the browser tab:

    xmrig -o 127.0.0.1:8081 -u <monero-address> -p worker --tls=false

## Configuration

`config.js`:

    WALLET            Monero address mined to
    POOL_HOST/PORT    upstream pool
    WORKER_NAME       stratum worker tag
    WS_PORT           HTTP + WebSocket port  (default 8080)
    STRATUM_TCP_PORT  raw TCP stratum port   (default 8081)

The **Wallet setup** panel in the UI overrides these per-session
without a restart.

URL parameters:

- `?light=1` — light mode (256 MiB, instant start, low hashrate)
- `?nojit=1` — disable the C-side JIT
- `?threads=N` — start with N mining threads (1–32)
- `?init_threads=N` — dataset-init parallelism (default 32)
- `?profile=1` — per-phase wall-clock profiling in the worker

## Layout

    Makefile            install / build / serve / bench / test / clean
    config.js           wallet + pool + port defaults
    proxy/index.js      HTTP + WS + raw-TCP stratum bridge
    public/             browser assets (miner.js, worker.js, built randomx.{js,wasm})
    bench/              bench_webui.mjs · bench_sweep.mjs · bench_regfile.mjs · canonical_hash.mjs
    wasm/               vendored RandomX C/C++ sources + build.sh
    vendor/ws/          vendored npm ws (no npm install required)