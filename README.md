# RandomX bonanza

In-browser Monero (RandomX) miner achieving ~24% of native execution efficiency, packaged with an easy to setup demo environment including a simple proxy with live pool presets. The raw miner payload is sub 500 KB. Shoutout to [Opus 4.7](https://www.anthropic.com/news/claude-opus-4-7) and [l1mey112's semifloat implementation](https://github.com/l1mey112/randomx.js).

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

The **Embed configuration** panel below the demo generates a script
from wallet, pool, port, WebSocket bridge, CPU percentage, memory mode,
interface, and startup settings. **Preview** runs the selected
widget or custom DOM interface against the local bridge. Preview mining
waits for consent; **Clear** stops and removes it. Worker, memory mode and
script URL, proxy routing, nonce mode and keepalive are under **Advanced**;
host setup is under **Deployment / CORS**.

[netlify-demo](netlify-demo/README.md) is the operator's embed configurator:
payout and bridge, a Full / Light switch with the isolation-header warning,
light workers and replicas with a `RandomXEmbed.plan()` estimate, the
snippet and a consent-gated preview. Deploy the directory to Netlify with no
build step; `make demo` serves it locally against `dist/` (`DEMO_ARGS=--no-isolation`
for a page without COOP/COEP). It is prefilled with the operator-confirmed
donation wallet, `wss://proxy.randomx.cc/embed-ws` and explicit
NiceHash/required keepalive settings. The page and builder default pin embed
0.3.0 at commit `f2594c79882775d17fa916aaedc0c5a6c927c7d9` on the
`embed-v0.2.0-demo` delivery branch; jsDelivr serves it once that commit is pushed.

## jsDelivr embed

    make embed       # → dist/ with embed, workers, both runtimes, fb_full.js and licenses
    make test-embed  # consent, core limits, lifecycle and reconnect tests
    npm pack         # build + distributable npm archive; does not publish

`dist/` is a self-contained distribution. Commit it into a public GitHub
release/tag to serve it through jsDelivr's GitHub endpoint, or publish the
npm package to use the npm endpoint. The URLs below are deployment examples;
this build does not create a GitHub tag or publish an npm version. Pin an
exact release or commit and keep all engine files together: `embed.js`,
`embed-worker.js`, `worker.js`, `randomx.js`/`.wasm` (full mode),
`randomx_st.js`/`.wasm` (light mode) and `fb_full.js` (light-mode replicas).
`manifest.json` records file sizes, SHA-256 hashes and script integrity values.
Options and API members marked (0.3.0) need a 0.3.0 or later pin.

```html
<script
  src="https://cdn.jsdelivr.net/gh/aa022/RandomX-bonanza@cdebaa57f2855d657c0424fe0e405c4aad8af839/dist/embed.js"
  crossorigin="anonymous"
  data-wallet="YOUR_MONERO_ADDRESS"
  data-pool="pool.supportxmr.com"
  data-port="3333"
  data-proxy="wss://YOUR_POOL_BRIDGE"
  data-workload="25"
></script>
```

This appends a widget to the document body after DOM readiness. It has
the randomx.cc miner widget's look (light, or dark where the page declares a
dark `color-scheme`, as `color-scheme: light dark` on a dark-preferring
device; IBM Plex Mono where the page loads that font), a progress bar,
hashrate, share counts, workload control, consent statement, Start/Stop
controls and a collapsed view with Stop still available. Shadow DOM isolates
its styling. The widget is at most 600px wide; the page's own CSS can change
that on its host element, e.g. `.randomx-embed { max-width: none; }`. No mining engine, dataset or
pool connection is loaded before consent. Consent is session-only, never
stored. Stop, navigation and destruction terminate
the engine and **every pthread or light-mode worker**, including during dataset initialization.
Approved mining continues across tab switches, including initialization and
reconnects. Browsers may throttle or suspend background tabs; uninterrupted
background execution cannot be guaranteed. Returning after navigation requires consent again.

Configuration accepts the same keys through `RandomXEmbed.create({...})`;
script attributes use kebab-case (for example `data-worker-name`,
`data-max-threads`, `data-replicas`, `data-init-threads`, `data-memory`,
`data-memory-cap`, `data-optimize-arm`); `tuning` is API
only. Set `data-auto="false"` when creating instances yourself.

| Setting | Meaning |
| --- | --- |
| `wallet`, `pool`, `port` | Required wallet and upstream pool hostname; TCP port defaults to 3333 |
| `proxy` | Compatible Monero JSON-RPC WS/WSS endpoint; defaults to the embedding page's origin |
| `routeQuery` | Default `true` adds/overwrites `pool` and `port` in the URL; `false` preserves a fixed-route proxy URL |
| `nonceMode` | `auto` (default) negotiates NiceHash from login extensions; `nicehash` forces its fixed high nonce byte for a known NiceHash endpoint |
| `keepalive` | `auto` (default) negotiates `keepalived`; `required` sends it every 15 seconds after login even without extension flags |
| `workerName` | Pool worker name, default `embed` |
| `workload` | Percentage of reported CPU cores, including decimals; default 50, maximum 80 |
| `mode` | `full` (default): the pthread engine on one shared dataset, about 2.5 GiB RAM, needs cross-origin isolation. `light` (0.3.0 semantics): one `randomx_st` worker per mining thread, about 300 MB each, **no isolation headers**. Omitted or `''` means `full`; any other value throws |
| `maxThreads` | (0.3.0) Absolute ceiling on mining threads, and so on light workers and their RAM; integer 1–32 |
| `optimizeArm` | (0.3.0) Full only, default `false`: on ARM devices count half the reported cores (about the performance cores) |
| `memory` | (0.3.0) Light only: RAM budget as a percentage of the RAM the browser reports; default 50, maximum 80 |
| `memoryCap` | (0.3.0) Light only: RAM budget in GB where the browser reports none (Firefox, Safari, insecure pages); default 2 |
| `replicas` | (0.3.0) Light only: `'auto'` (default) or a fixed 0–2. Workers that also mine on a private full dataset, about 2.3 GB each; `'auto'` picks the best count for the RAM budget |
| `initThreads` | (0.3.0) Full only: dataset initialization threads, 1–32, default 32. Light mode builds its replicas on its own workers |
| `tuning` | (0.3.0) API-only engine knobs `{profile, jit, lightMlp, kernelK, experiment}`; see below |
| `headless` | `true` creates only the API; it appends no widget |
| `quickstart` | `true` requests consent on the first trusted click or non-navigation key interaction |
| `container` | Element or CSS selector for the built-in widget; default `document.body` |
| `assetBase` | Optional directory containing the engine assets; otherwise derived from the embed script URL |
| `nonce` | CSP nonce for the widget's injected stylesheet |

Mining threads are `floor(cores × workload / 100)`, bounded by
80% of the cores, 32 mining threads and `maxThreads`. The default is **50%** on
all platforms, including ARM and Safari. API values from 80–100 are clamped
to 80%. In full mode, `optimizeArm: true` counts half the reported cores on
ARM devices, so the threads land on about the performance cores of Apple
silicon and big.LITTLE parts; light mode ignores it (its workers are
independent, so efficiency cores only add). The form accepts 0–80%; runtime
controls follow the device's cap. A percentage
too small to allow one thread cannot start. The widget shows the effective
CPU percentage and resulting thread count, the threads (in light mode the
full-dataset/light split, as planned until the datasets are built), the RAM
estimate and a **Dataset init** bar (hidden in light mode without replicas). Changing workload stops the session and requires
consent again. Only one embed instance on a page may mine at a time.

**Full-mode dataset initialization uses `initThreads` threads** (default 32),
independent of mining workload and platform. This temporary load is disclosed
in both the widget and consent event.

**Light mode** runs one `randomx_st` worker per mining thread. Each has its
own 256 MiB cache (about 300 MB) and a disjoint slice of the nonce space. It
uses no SharedArrayBuffer, so it needs only Worker and WebAssembly support and
runs on pages without COOP/COEP. The operator chooses a CPU `workload`, a RAM
budget (`memory` % of the RAM the browser reports, or `memoryCap` GB where it
reports none) and whether full-dataset replicas may be used; the embed does the
rest on each visitor's device:

- workers = the workload's threads, cut to what the budget holds at about 300 MB each;
- replicas (`'auto'`) = the count of 0–2 that maximizes `light workers + 2.25 ×
  replicas` within the budget, fewer on a tie (a replica worker mines about
  2.25× a light one; Ryzen 5600X, `NOSAB_KNOBS.md` §4). A fixed count falls
  back to the most that fits;
- RAM while mining is about `workers × 300 MB + replicas × 2.3 GB`, as the disclosure states.

Workers `0..replicas-1` also mine on a private full dataset. The workers
themselves build it, so the build stays within the same CPU workload and RAM
budget: on each seed (at the start, then every few days) every worker builds
its cache and computes dataset chunks, and nobody mines until the datasets are
done; then every worker gets the job. A replica that cannot allocate its
dataset stays light. Light mode trades hashrate per thread for running
anywhere; see [NOSAB_KNOBS.md](NOSAB_KNOBS.md).

`tuning` is for engine experiments; normal deployments leave it unset.
`profile` (`auto`, `arm`, `x86`) picks the JIT generator profile; `jit: false`
uses the portable interpreter (debugging only, far slower); `lightMlp` (0–2)
and `kernelK` (1–4) match the `light_mlp` and `kernel_k` knobs. `experiment`
is a comma list of at most 256 characters of hash-safe `jit_exp` tokens:
`no_threaded`, `no_inline_fprc`, `no_regs_mem`, `no_split_id`, `no_fuse`,
`no_inline_round`, `no_supjit`, `unroll2`, or `fuse_n`, `triples_n`,
`unroll2`, `shared_code`, `aes_simd`, `aes_relaxed`, `light_mlp`, `kernel_k`
with `=N`. Any other token throws, including the timing-only `reuse` and
`reuse2`, which produce wrong hashes on purpose.

### Headless API and custom DOM

```html
<p id="mining-details"></p>
<label><input id="mining-consent" type="checkbox"> I agree to mine for this session.</label>
<button id="mining-start">Start</button>
<button id="mining-stop">Stop</button>
<p id="mining-status" role="status"></p>
<output id="mining-rate"></output>
<script src="https://cdn.jsdelivr.net/gh/aa022/RandomX-bonanza@cdebaa57f2855d657c0424fe0e405c4aad8af839/dist/embed.js"
        crossorigin="anonymous" data-auto="false"></script>
<script>
  const miner = RandomXEmbed.create({
    wallet: 'YOUR_MONERO_ADDRESS', pool: 'pool.supportxmr.com', port: 3333,
    proxy: 'wss://YOUR_POOL_BRIDGE', workload: 25, headless: true
  });
  miner.bindControls({
    start: '#mining-start', stop: '#mining-stop', consent: '#mining-consent',
    disclosure: '#mining-details', status: '#mining-status', hashrate: '#mining-rate'
  });
  miner.on('state', state => console.log(state.phase, state.threads, state.hashrate));
</script>
```

`bindControls` takes elements or selectors, sets the disclosure text, wires
Start/Stop and optional `consent` / `workload` inputs, and updates optional
status/hashrate elements and a `diagnostics` text element. If no consent checkbox is bound, Start emits a
consent request for your own handler. The UI is entirely yours. For fully
custom event wiring, call `miner.requestConsent()` (also available as
`miner.start()`) and handle its consent event. These methods request consent;
the event's `accept()` starts the engine.

Other API members: `state` (snapshot, including `error`), `diagnostics`, `limits`, `config`,
`setWorkload(percentage)`, `stop()`, `destroy()`, and `mount(container)`.
`on('state', callback)`, `on('error', callback)` and `on('consent-request', callback)` return unsubscribe
functions. Document events are `randomx:state`, `randomx:error` and `randomx:consent-request`;
their details contain `instance` so handlers can identify their embed.
Attribute-based startup also emits `randomx:ready` on `window` with the instance.

(0.3.0) `state.engine` is `{mode, runtime: 'pthreads' | 'workers', workers,
replicas, replicasActive, memoryMiB, memoryBudgetMiB, memorySource}`; a running
session keeps the plan it started with, and `replicasActive` counts replicas
mining on their dataset.

(0.3.0) `RandomXEmbed.plan(config, nav = navigator)` validates a configuration
like `create()` and returns the resolved `{mode, runtime, threads,
wantedThreads, workers, replicas, initThreads, memoryMiB, memoryBudgetMiB,
memorySource: 'reported' | 'cap' | null, disclosure, limits}` (light
`initThreads` is the build's worker count) without an instance, DOM, engine or
network; `create()`
uses the same math. `limits` adds `reportedCores`, `arm` and `armOptimized`.
Pass `nav` (`hardwareConcurrency`, `platform`, `userAgent`, `architecture`,
`deviceMemory`) to plan for another device. Chromium reports the CPU
architecture asynchronously just after the script loads; until then a Mac
counts as ARM for `optimizeArm`. A session approved before the hint never
runs more threads than its consent stated.

### Quickstart and deployer-owned consent

Quickstart has **no built-in opt-in checkbox**. The first trusted DOM
interaction emits `randomx:consent-request` once; it does not download the
engine or start mining. The deployer hooks their consent statement/dialog
into this event and calls `accept()` only after informed consent. There is
no automatic approval when no handler is installed.

```js
document.addEventListener('randomx:consent-request', event => {
  if (event.detail.instance !== window.myMiner) return;
  const { disclosure, accept, decline } = event.detail;
  // Replace confirm with your site's consent UI if desired.
  if (window.confirm(disclosure)) accept();
  else decline();
});
window.myMiner = RandomXEmbed.create({
  wallet: 'YOUR_MONERO_ADDRESS', pool: 'pool.supportxmr.com', port: 3333,
  proxy: 'wss://YOUR_POOL_BRIDGE', workload: 25, quickstart: true
});
```

The detail also contains `config` and `state`. Consent callbacks are
single-use and invalidated by Stop, workload changes, hiding the page or
destroying the instance. Your consent UI can approve asynchronously.
The builder exports a working `confirm()` handler that you can replace.

### Stratum transport

The embed uses XMRig-shaped Monero JSON-RPC messages over WebSocket.
The bridge forwards them as newline-delimited JSON on the pool TCP socket.
Pool selection belongs to the connection URL:
`wss://YOUR_PROXY/?pool=pool.supportxmr.com&port=3333`. The embed appends
these parameters to `proxy`, preserving its path and other query parameters.

For an independent fixed-route proxy, set `routeQuery: false` (or
`data-route-query="false"`); the URL is then used unchanged. Set the disclosed
`pool`/`port` to that endpoint's actual destination. The builder exposes this
choice under Advanced. The local preview always uses the local reference
bridge with query routing and negotiated nonce/keepalive modes; exported
scripts retain your selected settings.

The embed works with independent proxies that expose Monero `rx/0` JSON-RPC
as one JSON object per WebSocket text message. Internal upstream connection
sharing is a proxy concern. Each browser uses its own returned session token,
assigned jobs and request/reply IDs. Other WebSocket protocols need an adapter.

1. Send a `login` request with `jsonrpc: '2.0'` and
   `params: {login: wallet, pass: workerName, rigid: workerName, agent, algo: ['rx/0']}`.
2. Consume the login's `result.id` / `result.job` and `method: 'job'` notifications.
3. Submit using `params: {id: minerId, job_id, nonce, result}`, with increasing
   request IDs so replies can be correlated independently.

The routed bridge preserves login and submit fields. No `set_target` or
custom JSON `ping` message is required by the embed. The original demo's
older handshake remains supported for compatibility. Message structure is
based on [XMRig's Stratum client](https://github.com/xmrig/xmrig/blob/master/src/base/net/stratum/Client.cpp).

NiceHash/XMRig Proxy nonce splitting is negotiated automatically when the
login response advertises `result.extensions: ["nicehash", ...]`. For a known
NiceHash relay that omits that flag, configure `nonceMode: 'nicehash'` (or
`data-nonce-mode="nicehash"`). Ordinary automatic-mode connections without
the extension continue to use all 32 nonce bits. The embed and original demo pass this mode
to the shared worker, which preserves each job's assigned high nonce byte and
searches the remaining 24 bits. Ordinary connections use all 32 nonce bits.
Parallel batches stop at the range boundary; exhausted jobs wait for a new
pool job instead of repeating work. Each reconnect negotiates the mode again
and reads the new prefix from the new job, while reusing the same-seed dataset.
The WS bridge must forward the login extensions and blob unchanged. This
effective mode is exposed as `instance.state.nicehash` for custom interfaces.
This is an established XMRig protocol extension, not universal support for every
Stratum variant. [XMRig Proxy nonce handling](https://github.com/xmrig/xmrig-proxy/blob/master/src/proxy/Miner.cpp).

The embed retries disconnects, connection/login timeouts and uncorrelated pool errors
indefinitely during an approved session, with backoff from 1 second
to 30 seconds. Re-login resets backoff. `online` events retry promptly.
Stale shares are discarded. The bridge sends native WebSocket ping frames;
browser implementations respond with pong automatically. The client sends
the standard `keepalived` RPC when the pool advertises the `keepalive`
extension, or when `keepalive: 'required'` is configured. Required mode sends
it every 15 seconds after login without relying on advertisements; unsupported
required keepalive stops with an actionable error. The embed monitors
unanswered share/keepalive requests. Quiet pools
without that extension are not disconnected just for sending no jobs.
Retry attempts are
guaranteed while the session is active; successful reconnection depends on
network/bridge/pool availability. Stop cancels all retries.

Login error replies are terminal and show the server's message. WebSocket
close codes `1008` and `4001` also stop the session and show the close reason;
`1012` and `1013` retry with backoff. Outgoing JSON text frames are limited
to 4096 UTF-8 bytes. Client JSON-RPC request IDs are integers, with login ID
`1` and increasing submit/keepalive IDs from `2`; nothing else is sent before
the login reply.

Reconnects retain the workers, shared memory and current seed's dataset/VM
(in light mode, every worker's cache and any replica dataset). Jobs with the same RandomX
seed hash reuse these resources, including after a new login. A new
seed requires rebuilding the dataset (light: the caches and replicas); Stop, workload changes, navigation and
engine errors end the session and release its workers.

The operator-provided public donation endpoint uses these options:

```js
const miner = RandomXEmbed.create({
  wallet: 'OPERATOR_PROVIDED_DONATION_WALLET', // replace; displayed before consent
  pool: 'pool.supportxmr.com', port: 3333,
  proxy: 'wss://proxy.randomx.cc/embed-ws',
  nonceMode: 'nicehash', keepalive: 'required'
});
```

That endpoint rejects other wallets; it does not rewrite them. Use an
independent/self-hosted proxy for another payout wallet. The embed always
sends the wallet you configure and has no operator-wallet fallback. These
settings implement the supplied endpoint contract; the public service has
not been tested from this checkout.

### CORS and deployment

For the VPS bridge and Netlify/jsDelivr demo, see the detailed
[proxy handoff](proxy_handoff.md).

Configure the page, asset server and pool proxy separately. jsDelivr serves
the distribution; this project's bridge supplies the TCP pool connection.

In full mode, the embedding **HTML page** needs HTTPS and these response headers:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

These enable the isolation required by shared WASM memory. Set them on
the HTML response, once each; a script tag or CDN cannot set them for its
host page. Ensure `Permissions-Policy` allows `cross-origin-isolated`.
COEP also affects other external resources: scripts, images and fonts need
CORS or an appropriate CORP policy. [MDN: cross-origin isolation](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated),
[MDN: COEP resource rules](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Embedder-Policy).
**Light mode needs none of these headers**; the asset, CSP and proxy rules
below still apply.

For **your own cross-origin asset server**, serve the complete distribution
with these response headers:

```http
Access-Control-Allow-Origin: *
Cross-Origin-Resource-Policy: cross-origin
```

Use `application/javascript` for `.js` and `application/wasm` for `.wasm`.
Generated script tags use `crossorigin="anonymous"`; engine downloads omit
cross-origin credentials, so wildcard CORS is suitable for public assets.
Keep asset redirects within permitted origins. Host-page CORS headers do
not authorize reads from another server. [MDN: CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS).

If the page has a **Content Security Policy**, incorporate these permissions
using your asset and proxy origins:

```http
script-src 'self' https://cdn.jsdelivr.net blob: 'wasm-unsafe-eval';
worker-src 'self' blob:;
connect-src 'self' https://cdn.jsdelivr.net wss://YOUR_PROXY;
```

Retain the site's other directives. Authorize inline initialization with
its script nonce/hash. For the widget stylesheet, pass `nonce` to `create`
and authorize that nonce in `style-src`; headless mode injects no styles.
The widget's noise texture is a `data:` image: without `img-src data:` the
browser drops only the texture.
Browsers requiring broader WASM permission may need `'unsafe-eval'`.
Blob workers run in the page's origin and load assets from the selected CDN.
Light mode needs the same directives. With `replicas`, the page also loads
`fb_full.js` from the asset origin as a classic `<script>` (crossorigin
anonymous, carrying the configured `nonce`), so `script-src` must allow the
asset origin or that nonce; a block fails at stage `assets`.

Use **WSS for the proxy** on HTTPS pages. Forward HTTP WebSocket upgrades
to the bridge and allow the embedding site's `Origin` in any proxy origin
policy. WebSockets do not use HTTP CORS preflight; adding an
`Access-Control-Allow-Origin` header does not configure that policy.
Expect an HTTP `101` upgrade response. [MDN: WebSocket handshakes](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API/Writing_WebSocket_servers).

For full mode, check the **embedding page's console** before starting:

```js
window.isSecureContext === true
window.crossOriginIsolated === true
typeof SharedArrayBuffer === 'function'
```

If isolation is false, inspect the HTML headers and Permissions Policy.
For failed downloads, inspect the asset response's CORS/CORP and CSP
errors. For failed proxy connections, inspect TLS, Origin policy and the
upgrade response. The local demo supplies isolation/CORS headers;
Safari's local demo requires HTTPS.

The widget displays deployment failures with an expandable **Deployment details**
panel. Isolation/secure-context/shared-memory checks run when the instance is
created, without downloading the engine, opening a socket or starting workers.
After consent, download and worker failures include checks for asset URLs,
CORS/CORP, CSP, matching build files and available memory. Confirmed, relevant
CSP violations identify the blocked directive and resource; report-only or
unrelated violations do not stop mining. Confirmed CSP failures end the session;
ordinary connection failures retain the existing reconnect behavior.

Headless integrations can inspect or render the same diagnostics:

```js
console.log(RandomXEmbed.diagnose()); // full mode: { supported, checks, issues, modes }; no engine/network probes
console.log(RandomXEmbed.diagnose('light').supported); // (0.3.0) light needs only Worker and WebAssembly
const renderError = error => {
  if (error) console.error(error.code, error.message, error.hints, error.checks);
};
renderError(miner.diagnostics.error); // includes errors detected during create()
miner.on('error', renderError);
// Or bindControls({ ..., diagnostics: '#rx-diagnostics' }) for plain text output.
```

`modes` is `{full, light}`: whether each mode can start here. Full-mode
isolation issues add one hint pointing to `mode: 'light'`. Instances report
for their own mode.

Reports use `DEPLOYMENT_UNSUPPORTED`, `ASSET_DOWNLOAD_FAILED`,
`ENGINE_WORKER_FAILED`, `CSP_BLOCKED`, `START_UNAVAILABLE`, `LOGIN_REJECTED`,
`PROXY_SESSION_REJECTED`, `KEEPALIVE_UNSUPPORTED` or `FRAME_TOO_LARGE` codes.
`PROXY_SESSION_REJECTED` also includes `closeCode`.
`CSP_BLOCKED` also includes `directive` and a resource URL with query strings
and credentials removed. Document `randomx:error` events include `instance`;
register a document listener before `create()` to catch immediate preflight
errors. A later CSP event can enrich an earlier generic failure for the same
attempt. Stop clears diagnostics and suppresses late reports; destroy removes
the listeners.

Generic browser failures do not prove which header or restriction is wrong;
the hints are checks, and Permissions Policy inspection is best effort. If CSP
blocks `embed.js` itself, the embed cannot render an error: inspect the browser
console. [MDN: CSP violation events](https://developer.mozilla.org/en-US/docs/Web/API/SecurityPolicyViolationEvent).

If the same widget runs much slower on a public site than localhost at the
same mining-thread count, check Chromium's per-site **JavaScript optimizers**
permission (`chrome://settings/content/v8`). Disabling optimizing compilers
also prevents WASM from using its optimizing tier, even when the engine's
own JIT reports enabled and no compilation errors. Chrome can disable this
permission on unfamiliar sites. Compare the same trusted site's allowed and
blocked settings, reloading before each run; the embed cannot override browser
security settings. [Chrome V8 settings](https://support.google.com/chrome/answer/10468685?co=GENIE.Platform%3DDesktop&hl=en),
[V8 compiler flags](https://chromium.googlesource.com/v8/v8/+/e74bcecfb1b70a4aaa8f96feb818d02c668e5650/src/flags/flag-definitions.h).

Sources: [jsDelivr URL conventions](https://github.com/jsdelivr/jsdelivr#usage-documentation),
[Emscripten pthread requirements](https://emscripten.org/docs/porting/pthreads.html),
[browser hardware concurrency](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/hardwareConcurrency).

Optional browser integration check (puppeteer-core and installed Chrome):

```sh
make embed
PUPPETEER_MODULE=/path/to/puppeteer-core node tests/embed-browser.cjs
```

It uses a local fake pool, verifies real 32-thread full-dataset initialization,
shares, automatic NiceHash negotiation and reconnects without a dataset
rebuild, a generated headless quickstart snippet and cross-origin asset
loading. Light-mode runs cover a page without COOP/COEP, disjoint nonce slots
per worker, reconnects that keep every worker and cache, Stop, and one
replica; submitted shares are re-hashed in Node. It never mines to an external pool.

## Browser support

- **Chromium / Firefox** — work out of the box over plain HTTP on localhost,
  since browsers treat `localhost` as a secure context (the proxy still
  sends the COOP/COEP headers SharedArrayBuffer / wasm pthreads need).
  Served without those headers (or over plain-HTTP LAN), the miner falls
  back to independent single-thread light-mode workers (see `?sab=0`).
- **Safari** — refuses `SharedArrayBuffer` outside HTTPS even on localhost,
  so the local demo won't run there as shipped. Drop a self-signed cert in
  front of the proxy (e.g. `caddy reverse-proxy --to :8080` or any HTTPS
  fronting of your choice) and Safari works fine — the live preview at
  <https://randomx.cc/> runs in Safari without issues.

## Bench

    make bench                           # sweep 1,4,10,32 mining threads @ 30 s/pass
    make bench DURATION=10               # shorter pass
    make bench SWEEP=1,8,16,32           # custom thread set
    make bench INIT_THREADS=16           # dataset init parallelism (1–32)
    make bench SWEEP=32 DURATION=60      # single 32-thread, 60 s pass

Mirrors the webui worker exactly: the resident threaded interpreter (inline
branchless directed rounding, fused-pair superinstructions, registers in
linear memory, supjit dataset kernel) and async dataset init
(`rxInitDatasetStart` / `rxInitDatasetProgress` / `rxInitDatasetJoin`).
Each pass forks a fresh node process so JIT/pthread state cannot leak between
thread counts. CPU model + core count are detected and printed in the
summary.

The standalone scripts also work directly:

    node bench/bench_webui.mjs --threads 32 --duration 30
    node bench/bench_sweep.mjs --sweep 1,4,32 --duration 30
    node bench/bench_regfile.mjs                   # JIT codegen micro-bench

Correctness gates (run after any change to the JIT):

    node bench/full_mode_check.mjs --count 32                  # JIT vs portable C, full dataset
    node bench/full_mode_check.mjs --count 32 --feature-base 0 # no-relaxed-SIMD path (Safari)
    node bench/mine_ctx_check.mjs                              # mining-context API
    node bench/jsc_validate.mjs --feature-base 0               # module validates in JavaScriptCore (macOS)

## Efficiency

Apple M4 base · 10 cores · `make bench` (30 s/pass) vs. native
`xmrig --bench=1M` at the same thread count:

    threads   WASM H/s    xmrig H/s    efficiency
    ───────────────────────────────────────────
       1         172          693         24.8 %
      10         934            —            —
      32         971       ~4000 ¹       ~24 %

In the browser on the same machine (32 threads): Chrome ~850–880 H/s,
Safari ~800 H/s, Firefox ~700 H/s.

v0.1.0 is ~1.7× v0.0.1 (1T 90 → 172, 32T 586 → 971): a leaner dispatch loop
(no shared join, absolute operand addresses in the decoded records),
branchless inline directed rounding instead of `call_indirect` float stubs
(with an FMA-free variant for engines without relaxed SIMD, e.g. Safari),
call-free arms, fused-pair superinstructions and atomic nonce claiming.

## Payload

Total served to the browser per page load: **467 KB**.

    index.html       21.4 KB     ui shell
    miner.js         34.8 KB     ws client + ui control
    worker.js        27.7 KB     wasm engine driver
    randomx.js       47.2 KB     emscripten glue
    randomx.wasm    335.9 KB     randomx engine + JIT + supjit kernel

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

- `?light=1` — light mode (256 MiB, instant start, lower hashrate; JIT'd)
- `?sab=0` — force the no-SharedArrayBuffer fallback (used automatically when
  the page is not `crossOriginIsolated`): N single-thread light-mode workers
  on `randomx_st.wasm`, ~300 MB each; `?threads=N` sets N
- `?fb_full=K` (K = 0–2, no-SAB only) — K of those workers mine in full mode
  on a private dataset replica (~2.3 GB each), which all workers build
  together per seed; a worker that can't allocate one stays in light mode
- `?nojit=1` — disable the C-side JIT
- `?threads=N` — start with N mining threads (1–32)
- `?init_threads=N` — dataset-init parallelism (default 32)
- `?profile=1` — per-phase wall-clock profiling in the worker
- `?jit_exp=no_fuse,no_inline_round` — per-engine A/B opt-outs (fused pairs,
  inline rounding); hashes stay correct

## Layout

    Makefile            install / build / serve / bench / test / clean
    config.js           wallet + pool + port defaults
    proxy/index.js      HTTP + WS + raw-TCP stratum bridge
    public/             demo, snippet builder, embed API, workers, built randomx.{js,wasm}
    dist/               jsDelivr/npm-ready embed distribution + hash manifest + licenses
    scripts/            package-embed.mjs
    tests/              embed lifecycle tests + optional browser integration check
    bench/              bench_webui.mjs · bench_sweep.mjs · full_mode_check.mjs · mine_ctx_check.mjs · jsc_validate.mjs · …
    wasm/               vendored RandomX C/C++ sources + build.sh
    vendor/ws/          vendored npm ws (no npm install required)
