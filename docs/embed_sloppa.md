# Embed script

Documentation of the elegant control plane of our embed script. For ergonomic setup, visit [randomx.cc](https://randomx.cc).

The script mounts itself when the tag has `data-wallet`. Nothing loads or mines until the user consents.

```html
<script defer crossorigin="anonymous"
  src="https://cdn.jsdelivr.net/gh/aa022/RandomX-bonanza@v0.3.0/dist/embed.js"
  data-wallet="4..." data-pool="pool.example.com" data-port="3333"
  data-proxy="wss://bridge.example.com" data-mode="light" data-workload="50"></script>
```

The same setup through the API (set `data-auto="false"` or leave out `data-wallet`):

```js
const rx = RandomXEmbed.create({ wallet, pool, port: 3333, proxy, mode: 'light', workload: 50 });
```

## Options

Each `data-*` name is the kebab-case form of the option, except `nonce` and `tuning`. Boolean attributes are on only as `"true"`, except `data-route-query`, which is on unless `"false"`.

```
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
```

Invalid options make `create()`/`plan()` throw. On auto-mount the error goes to the document `randomx:error` event as `{message}`, with no instance. On success, `randomx:ready` fires on window with `{instance}`.

## Static API

```
RandomXEmbed.version         "0.3.0"
RandomXEmbed.plan(opts)      dry run -> {mode, runtime pthreads|workers, threads, wantedThreads, workers, replicas,
                             initThreads, memoryMiB, memoryBudgetMiB, memorySource, disclosure, limits}
RandomXEmbed.diagnose(mode)  -> {supported, checks, issues[{code, message, hints}], ...}
RandomXEmbed.limits(opts)    -> {cores, reportedCores, arm, armOptimized, maxThreads, maxPercentage, workloadCap, initThreads}
```

## Instance

```
rx.version / config / limits / state / diagnostics   read-only (diagnostics = diagnose() + error)
rx.on(name, fn)                     -> unsubscribe function
rx.requestConsent(e?) / start(e?)   -> bool; fires consent-request; refuses an untrusted event; never mines by itself
rx.stop(reason?)                    stops; consent is needed again
rx.setWorkload(n)                   0-100, capped at 80; a change stops the session
rx.bindControls({start, stop, consent, workload, status, hashrate, diagnostics, disclosure})  -> rx
rx.mount(container) / destroy()
```

`bindControls` takes selectors or Elements and replaces any earlier bindings, including the widget's own, so use it with `headless`. When a `consent` checkbox is bound, a checked box plus a trusted Start click mines directly, with no consent-request. Without a checkbox, Start fires consent-request.

## Events

Subscribe with `rx.on(name)`, or listen on document for `randomx:<name>`, whose detail also carries `instance`:

```
state             snapshot (see below)
error             {code, stage, message, hints[], checks}  (+ directive/resource, closeCode)
consent-request   {config, state, disclosure, accept() -> bool, decline()}
```

`accept()` starts mining and works only once. It is refused while the page is hidden. A later requestConsent, stop, workload change, page hide or destroy invalidates it.

```
state   running, phase (idle|consent|loading|connecting|initializing|mining|waiting|reconnecting|stopped|error),
        status, hashrate, accepted, rejected, progress 0-1, retries, error, workload, threads,
        effectivePercentage, nicehash, engine {mode, runtime, workers, replicas, replicasActive, memoryMiB}
errors  DEPLOYMENT_UNSUPPORTED  START_UNAVAILABLE  ASSET_DOWNLOAD_FAILED  ENGINE_WORKER_FAILED
        CSP_BLOCKED  FRAME_TOO_LARGE  KEEPALIVE_UNSUPPORTED  LOGIN_REJECTED  PROXY_SESSION_REJECTED
```

An unsupported page does not throw. `create()` sets `state.error` (DEPLOYMENT_UNSUPPORTED) before it returns, so check `rx.state.error` or listen on document first.

Only one embed per page can run. A second start sets phase 'error' without an error event. Mining continues in background tabs and stops on pagehide.

## Isolation

Full mode needs HTTPS (or localhost), COOP `same-origin` + COEP `require-corp` on the embedding page, and an allowed `cross-origin-isolated` for iframes. Light mode needs only Worker and WebAssembly. `diagnose()` issue codes: INSECURE_CONTEXT, CROSS_ORIGIN_ISOLATION, PERMISSIONS_POLICY, SHARED_MEMORY_UNAVAILABLE, ENGINE_UNSUPPORTED.
