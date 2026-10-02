# RandomX bonanza

In-browser Monero (RandomX) miner achieving ~24% of native execution efficiency, packaged with an easy to setup demo environment including a simple proxy with live pool presets. The raw miner payload is sub 600 KB. Shoutout to [Opus 4.7](https://www.anthropic.com/news/claude-opus-4-7), [Opus 5.5](https://www.anthropic.com/news/claude-opus-5-5) and [l1mey112's semifloat implementation](https://github.com/l1mey112/randomx.js).

## Requirements

- emcc (Emscripten SDK) ≥ 3.1
- clang
- binaryen (`wasm-opt`)
- node ≥ 18

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

    make build       # → public/randomx{,_st}.{js,wasm}
    make serve       # build + start the proxy on http://localhost:8080
    make test        # canonical RandomX hash vs. reference test vector
    make embed       # build + package the jsDelivr embed into dist/
    make test-embed  # embed lifecycle and consent tests
    make bench       # full-mode hashrate sweep (see Bench)
    make bench-light # light-mode hashrate sweep (see Bench)
    make clean       # remove build outputs
    make fclean      # clean + drop .make/ stamps
    make re          # fclean + build


## Browser support

!! careful around firefox, mostly untested

- **Chromium / Firefox** — work out of the box over plain HTTP on localhost,
  since browsers treat `localhost` as a secure context (the proxy still
  sends the COOP/COEP headers SharedArrayBuffer / wasm pthreads need).
  Served without those headers, the miner falls back to single-thread
  light-mode workers (see `?sab=0`).
- **Safari** — refuses `SharedArrayBuffer` outside HTTPS even on localhost,
  so the local demo won't run there as shipped. Drop a self-signed cert in
  front of the proxy (e.g. `caddy reverse-proxy --to :8080` or any HTTPS
  fronting of your choice) and Safari works fine — the live preview at
  <https://randomx.cc/> runs without issues.

## Bench

    make bench                           # regfile micro-bench + sweep 1,4,10,32 threads @ 30 s/pass
    make bench DURATION=10               # shorter pass
    make bench SWEEP=1,8,16,32           # custom thread set
    make bench INIT_THREADS=16           # dataset init parallelism (1–32)
    make bench SWEEP=32 DURATION=60      # single 32-thread, 60 s pass
    make bench PROFILE=arm               # JIT generator profile: auto | arm | x86
    make bench-light                     # light-mode sweep (no SharedArrayBuffer), fixed passes

## Efficiency

Apple M4 base · 10 cores · `make bench` (30 s/pass) vs. native
`xmrig --bench=250K` (fast mode) at the same thread count. The xmrig numbers
come from xmrig's `master` branch, chosen deliberately over the better performing `dev`, to make the number look more interesting.

    threads   init     WASM H/s    xmrig H/s    efficiency
    ─────────────────────────────────────────────────────
       1     4.69 s       175          696         25.1 %
       4     4.76 s       647         2675         24.2 %
      10     4.74 s       947         4081         23.2 %
      32     4.69 s       993         3904         25.4 %

In the browser on the same machine (32 threads): Chrome ~850–880 H/s,
Safari ~800 H/s, Firefox ~700 H/s.

Light mode, `make bench-light` vs. `xmrig --bench=250K --randomx-mode=light`
(xmrig threads share one cache; the light workers each build their own):

    threads   init     WASM H/s    xmrig H/s    efficiency
    ─────────────────────────────────────────────────────
       1     0.49 s        47           70         66.6 %
       4     0.56 s       165          254         64.9 %
      10     0.88 s       291          546         53.3 %
      32    10.90 s       289          533         54.2 %

With full-dataset workers (`NF+M` = N full-dataset + M light workers):
!! this approach is relevant since it doesnt require SharedArrayBuffer

    workers   init     WASM H/s    RAM (est.)
    ──────────────────────────────────────────
      1F    35.20 s       170       ~2.5 GiB
      1F+3  11.06 s       293       ~3.4 GiB
      1F+9   6.95 s       360       ~5.2 GiB
      2F    19.13 s       337       ~5.1 GiB
      2F+2  11.75 s       417       ~5.7 GiB
      2F+8   7.02 s       427       ~7.4 GiB

![make bench](readme/rxb_bench_full.png)
![make bench-light](readme/rxb_bench_light.png)
![xmrig --bench=250K](readme/xmrig_bench.png)

Run the same benches on your machine with `make bench` (full mode) and
`make bench-light` (light mode); see [Bench](#bench).

## Payload

Total served to the browser per page load: **562 KB**.

    index.html       33.2 KB     ui shell
    miner.js         41.9 KB     ws client + ui control
    worker.js        37.6 KB     wasm engine driver
    randomx.js       50.9 KB     emscripten glue
    randomx.wasm    398.3 KB     randomx engine + JIT + supjit kernel

## Configuration

### Documentation of the elegant control plane of our embed script
for ergonomic setup, visit [randomx.cc](https://randomx.cc)

The script mounts itself when the tag has `data-wallet`. Nothing loads or mines until the user consents.

    <script defer crossorigin="anonymous"
      src="https://cdn.jsdelivr.net/gh/aa022/RandomX-bonanza@ababefb18fd35142547fc1e906efd8558a3c12e9/dist/embed.js"
      data-wallet="4..." data-pool="pool.example.com" data-port="3333"
      data-proxy="wss://bridge.example.com" data-mode="light" data-workload="50"></script>

The same setup through the API (set `data-auto="false"` or leave out `data-wallet`):

    const rx = RandomXEmbed.create({ wallet, pool, port: 3333, proxy, mode: 'light', workload: 50 });

Options. Each `data-*` name is the kebab-case form of the option, except `nonce` and `tuning`. Boolean attributes are on only as `"true"`, except `data-route-query`, which is on unless `"false"`.

    wallet       required    pool login, max 256 chars, no whitespace or <>
    pool         required    hostname, max 253 chars, no whitespace, / or <>
    port         3333        1-65535
    proxy        page host   ws(s):// WS-to-Stratum bridge, no credentials or #; HTTPS pages need wss://
    routeQuery   true        append ?pool=&port= to proxy (data-route-query="false" disables)
    workload     50          CPU % 0-100, capped at 80
    workerName   embed       login pass / rigid, truncated to 64 chars
    mode         full        full (pthreads, ~2.5 GiB shared dataset) | light (~300 MB per worker)
    maxThreads   -           1-32; cap = min(32, floor(cores*0.8), maxThreads)
                             threads = min(cap, floor(cores*workload%)); light mode also limited by RAM
    initThreads  32          1-32, dataset init threads (full only)
    replicas     auto        auto | 0-2 light workers that each hold a full dataset (~2.3 GB each), light only
    memory       50          light RAM budget, % of navigator.deviceMemory (max 80)
    memoryCap    2           light RAM budget in GB when deviceMemory is unknown (max 64)
    optimizeArm  false       full mode on ARM: count half the cores
    nonceMode    auto        auto | nicehash
    keepalive    auto        auto | required (fails with KEEPALIVE_UNSUPPORTED)
    headless     false       no built-in widget; drive it with the API or bindControls
    quickstart   false       no checkbox; the first trusted click/key requests consent (never grants it)
    container    body        selector or Element for the widget
    assetBase    script dir  engine file base URL; HTTPS pages need HTTPS
    nonce        tag nonce   CSP nonce for the widget style; on auto-mount, the tag's nonce="" (no data-nonce)
    tuning       {}          API only: {profile auto|arm|x86, jit bool, lightMlp 0-2, kernelK 1-4, experiment}
    data-auto    -           "false" turns off auto-mount

Invalid options make `create()`/`plan()` throw. On auto-mount the error goes to the document `randomx:error` event as `{message}`, with no instance. On success, `randomx:ready` fires on window with `{instance}`.

Static API:

    RandomXEmbed.version         "0.3.0"
    RandomXEmbed.plan(opts)      dry run -> {mode, runtime pthreads|workers, threads, wantedThreads, workers, replicas,
                                 initThreads, memoryMiB, memoryBudgetMiB, memorySource, disclosure, limits}
    RandomXEmbed.diagnose(mode)  -> {supported, checks, issues[{code, message, hints}], ...}
    RandomXEmbed.limits(opts)    -> {cores, reportedCores, arm, armOptimized, maxThreads, maxPercentage, workloadCap, initThreads}

Instance:

    rx.version / config / limits / state / diagnostics   read-only (diagnostics = diagnose() + error)
    rx.on(name, fn)                     -> unsubscribe function
    rx.requestConsent(e?) / start(e?)   -> bool; fires consent-request; refuses an untrusted event; never mines by itself
    rx.stop(reason?)                    stops; consent is needed again
    rx.setWorkload(n)                   0-100, capped at 80; a change stops the session
    rx.bindControls({start, stop, consent, workload, status, hashrate, diagnostics, disclosure})  -> rx
    rx.mount(container) / destroy()

bindControls takes selectors or Elements and replaces any earlier bindings, including the widget's own, so use it with `headless`. When a `consent` checkbox is bound, a checked box plus a trusted Start click mines directly, with no consent-request. Without a checkbox, Start fires consent-request.

Events. Subscribe with `rx.on(name)`, or listen on document for `randomx:<name>`, whose detail also carries `instance`:

    state             snapshot (see below)
    error             {code, stage, message, hints[], checks}  (+ directive/resource, closeCode)
    consent-request   {config, state, disclosure, accept() -> bool, decline()}

`accept()` starts mining and works only once. It is refused while the page is hidden. A later requestConsent, stop, workload change, page hide or destroy invalidates it.

    state   running, phase (idle|consent|loading|connecting|initializing|mining|waiting|reconnecting|stopped|error),
            status, hashrate, accepted, rejected, progress 0-1, retries, error, workload, threads,
            effectivePercentage, nicehash, engine {mode, runtime, workers, replicas, replicasActive, memoryMiB}
    errors  DEPLOYMENT_UNSUPPORTED  START_UNAVAILABLE  ASSET_DOWNLOAD_FAILED  ENGINE_WORKER_FAILED
            CSP_BLOCKED  FRAME_TOO_LARGE  KEEPALIVE_UNSUPPORTED  LOGIN_REJECTED  PROXY_SESSION_REJECTED

An unsupported page does not throw. `create()` sets `state.error` (DEPLOYMENT_UNSUPPORTED) before it returns, so check `rx.state.error` or listen on document first.

Only one embed per page can run. A second start sets phase 'error' without an error event. Mining continues in background tabs and stops on pagehide.

Isolation: full mode needs HTTPS (or localhost), COOP `same-origin` + COEP `require-corp` on the embedding page, and an allowed `cross-origin-isolated` for iframes. Light mode needs only Worker and WebAssembly. diagnose() issue codes: INSECURE_CONTEXT, CROSS_ORIGIN_ISOLATION, PERMISSIONS_POLICY, SHARED_MEMORY_UNAVAILABLE, ENGINE_UNSUPPORTED.

## Layout

    Makefile            install / build / serve / bench / test / embed / clean
    config.js           wallet + pool + port defaults
    proxy/index.js      HTTP + WS + raw-TCP stratum bridge
    public/             browser assets (miner.js, worker.js, embed.js, built randomx{,_st}.{js,wasm})
    dist/               jsDelivr/npm-ready embed distribution
    scripts/            package-embed.mjs
    tests/              embed tests
    bench/              bench_webui.mjs · bench_sweep.mjs · bench_regfile.mjs · canonical_hash.mjs · …
    readme/             README images
    wasm/               vendored RandomX C/C++ sources + build.sh
    vendor/ws/          vendored npm ws (no npm install required)