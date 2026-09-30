# RandomX embed: VPS bridge and public demo handoff

Snapshot: 2026-09-30, embed version `0.2.1`, delivery branch `embed-v0.2.0-demo`.

This describes the implementation in this checkout. The intended public demo is a Netlify page loading the embed from jsDelivr, connecting through a VPS WebSocket bridge to a Monero RandomX pool. The browser does the mining; the VPS only relays pool traffic.

Local browser integration has exercised real full-memory initialization, share submission to a fixture pool, automatic NiceHash negotiation including a shortened native batch at the nonce boundary, ordinary → NiceHash → ordinary reconnects with the same workers and dataset, background mining/reconnects without rebuilding, cross-origin assets, and the exported headless quickstart example. **The public Netlify/jsDelivr → VPS → real pool path has been checked through login, real jobs, sustained hashing and keepalive replies; genuine share acceptance is still pending.** The runtime, bridge changes and `dist/` assets are published on `embed-v0.2.0-demo` at commit `cdebaa57f2855d657c0424fe0e405c4aad8af839`. All five runtime files at that jsDelivr pin returned HTTP 200 with matching hashes, JavaScript/WASM MIME types, wildcard CORS and cross-origin CORP. The builder defaults to this published pin; no npm version or release tag has been published.

## Deployment contract at a glance

```text
Netlify HTTPS page
  ├── HTTPS → jsDelivr: embed.js + worker/glue/WASM assets
  └── WSS → VPS /ws?pool=<hostname>&port=<port>
                └── TCP → selected Monero rx/0 pool
```

The VPS must provide a valid public TLS endpoint, support WebSocket upgrade and expose normal Monero JSON-RPC. The reference bridge preserves the routing query and wallet and gives each browser its own pool TCP connection. Other compatible bridges may consolidate upstream work while retaining independent browser sessions, replies and nonce assignments. No custom `set_target` or JSON `ping` is required by the new embed.

### Current public donation endpoint contract

The corrected VPS handoff specifies `wss://proxy.randomx.cc/embed-ws?pool=pool.supportxmr.com&port=3333`. It accepts only the operator-provided donation wallet in `login.params.login` and rejects others with a clear login error. Configure the actual donation wallet in the widget before consent; never silently replace a configured wallet. Independent/self-hosted proxies can serve other wallets.

For this endpoint use:

```js
RandomXEmbed.create({
  wallet: 'OPERATOR_PROVIDED_DONATION_WALLET',
  pool: 'pool.supportxmr.com', port: 3333,
  proxy: 'wss://proxy.randomx.cc/embed-ws',
  nonceMode: 'nicehash', keepalive: 'required'
});
```

The upstream uses NiceHash nonce allocation. The handoff requires preserving blob byte 42 without depending on extension advertisements, so this configuration explicitly enables NiceHash mode. It reads the byte from every job/reconnect and varies only bytes 39–41, including bounded native batches. This restriction applies to NiceHash mode; ordinary automatic-mode connections without the extension search all 32 bits.

Login is the first frame; no submit/keepalive precedes its reply. Each outgoing frame is a JSON text object of at most 4096 UTF-8 bytes, with an integer JSON-RPC ID. Required `keepalived` runs every 15 seconds after login, even if no extension is advertised. Login error replies and close codes `1008`/`4001` end the session and show the server message/reason; `1012`/`1013` retry with backoff. Extra job fields such as `algo`/`height` are tolerated, and 8-character targets are supported.

This corrects the earlier pasted handoff's claim that this public endpoint is bring-your-own-wallet. The operator confirmed the donation wallet already present in `config.js` for the test page. No public VPS → real pool test has been performed here. Client compatibility with independently hosted JSON-RPC proxies remains supported.

The Netlify HTML response must provide cross-origin isolation. These headers on the VPS or CDN cannot substitute for headers on the embedding page. The page must explicitly configure the VPS `proxy` URL; the default would try a WebSocket on the Netlify site's own origin.

Implementation references:

| File | Responsibility |
| --- | --- |
| [`public/embed.js`](public/embed.js) | Configuration, widget/API, consent, worker ownership, JSON-RPC, reconnect |
| [`public/embed-worker.js`](public/embed-worker.js) | Worker bootstrap and pthread message broker |
| [`public/worker.js`](public/worker.js) | RandomX cache/dataset, job handling and mining |
| [`proxy/index.js`](proxy/index.js) | Reference WS ↔ TCP bridge, transport heartbeat, legacy compatibility |
| [`config.js`](config.js) | Reference bridge ports and legacy fallback pool/wallet |
| [`public/embed-builder.js`](public/embed-builder.js) | Frontend configuration form and exported script examples |
| [`dist/`](dist/) | Packaged browser assets; keep these from the same build |
| [`tests/embed-browser.cjs`](tests/embed-browser.cjs) | Local fixture-pool browser integration, including dataset reuse |

## Browser configuration and resource behavior

`window.RandomXEmbed.create(options)` returns an instance. Defaults below are actual runtime defaults, not deployment settings to assume.

| Option | Meaning |
| --- | --- |
| `wallet` | Required payout address; checked for basic string validity, not cryptographic address validity |
| `pool` | Required hostname, without a scheme or path |
| `port` | Pool TCP port, integer 1–65535; default `3333` |
| `proxy` | WS/WSS bridge URL; HTTPS pages require `wss://`; configure explicitly for Netlify |
| `routeQuery` | Default `true` sets URL `pool`/`port`; use `false` to preserve a fixed-route proxy URL exactly |
| `nonceMode` | Default `auto` follows login extensions; `nicehash` explicitly enables the fixed high nonce byte for a known NiceHash endpoint |
| `keepalive` | Default `auto` follows login extensions; `required` sends `keepalived` every 15 s after login without requiring advertisements |
| `workerName` | Default `embed`; sent as both login `pass` and `rigid`, truncated to 64 characters |
| `workload` | Reported-core percentage, decimals allowed; default `50`; 0–100 accepted, capped at 80 globally and 50 on detected/inferred ARM |
| `mode` | `full` by default; `light` uses a cache instead of the full dataset and at most one mining thread |
| `headless` | `true` appends no widget; use the API and your own DOM |
| `quickstart` | `true` requests deployer-provided consent on the first qualifying trusted interaction |
| `container` | Built-in widget destination: element or selector; default `document.body` |
| `assetBase` | Optional HTTP(S) directory for all engine assets; normally inferred from the embed script's directory |
| `nonce` | Optional CSP nonce for the built-in widget's stylesheet |

There is currently no separate pool password or upstream TLS option. A pool requiring a password distinct from the worker name needs a deliberate client/configuration change or an explicitly configured adapter. Do not silently substitute the bridge's donation wallet.

Mining threads are rounded down:

```text
cores = floor(navigator.hardwareConcurrency), or 2 if unavailable
cap = 50% on ARM, 80% otherwise
threads = min(32, floor(cores × min(workload, cap) / 100))
light mode additionally caps threads at 1
```

These are browser-reported logical cores, not selectable physical cores. ARM detection uses Chromium architecture information when available, otherwise platform/UA hints; Mac platforms conservatively receive the ARM cap when architecture is unavailable. Thus an unidentified Intel Mac can also receive the 50% cap. There is no efficiency-core field or CPU affinity. A one-core report, or a workload too low to permit one whole thread, prevents startup.

**Full-dataset initialization always requests 32 threads**, independent of the mining percentage. The mining cap therefore does not describe peak initialization CPU use. This is disclosed in the widget and consent statement. Full mode needs approximately 2.5 GiB of browser RAM during initialization; light mode needs approximately 256 MiB and does not build a full dataset. The runtime provisions a 32-pthread pool in either mode. Keep the first public test on a machine with adequate memory.

## Consent, widget and headless API

The normal widget appends a Shadow DOM panel with the payout/pool/resource disclosure, workload control, checkbox, Start/Stop buttons, dataset progress, hashrate, share counters and status. The checkbox must be checked and Start must receive a trusted click. Loading/creating the embed does not fetch the mining engine, spawn mining workers or connect to the bridge before consent.

Quickstart removes the built-in checkbox and listens once for a trusted document `click` or a qualifying `keydown`. Tab, Shift, Control, Alt, Meta and Escape do not trigger it. It **requests** consent through `randomx:consent-request` on `document`; it does not automatically approve mining. The deployer supplies the consent presentation and calls `detail.accept()` only after agreement. Without a handler/acceptance, no mining starts.

Consent event detail:

```js
{ config, state, disclosure, instance, accept, decline }
```

The callback can be used after an asynchronous site dialog. It is single-use and becomes invalid after Stop, a changed workload, page hiding or destruction. `instance.start()` is an alias for `instance.requestConsent()`; both request consent rather than bypassing it.

Useful integration methods/events:

- `instance.on('state', callback)`, `.on('error', callback)` and `.on('consent-request', callback)` return an unsubscribe function.
- `instance.state` contains `running`, `phase`, `status`, `error`, `hashrate`, `accepted`, `rejected`, `progress` (0–1), `retries`, `workload`, `threads`, `effectivePercentage`, `nicehash` (currently effective mode, negotiated or explicitly configured), `limits` and `config`.
- `instance.bindControls({ start, stop, consent, workload, disclosure, status, hashrate, diagnostics })` accepts elements or selectors. `consent` is optional: without a checkbox, Start emits the consent request for the deployer to handle. Optional `diagnostics` receives plain text failure details.
- `instance.stop()`, `.setWorkload(percentage)`, `.mount(container)` and `.destroy()` support custom integrations. Changing the effective workload stops the session and requires consent again.
- `randomx:state` is dispatched on `document` with `detail.instance`. Data-attribute auto-initialization dispatches `randomx:ready` on **window**, with `detail.instance`; its configuration failures dispatch `randomx:error` on **document**.

Only one embed instance on the same page can mine at once. Other tabs are not coordinated. Stop, `pagehide`, or destroy terminates the control worker and all pthreads, aborts a pending runtime download, closes WS, cancels retries and withdraws consent. Returning after navigation requires a fresh Start/consent; quickstart does not automatically re-arm after its first interaction. An approved session continues across tab switches, including initialization and reconnects, with its workers/dataset retained. Hiding the page cancels a pending consent request. Browsers may throttle or suspend background tabs; the embed cannot guarantee uninterrupted background execution.

### Deployment diagnostics

`RandomXEmbed.diagnose()` returns `{ supported, checks, issues }` without any engine/network probes. Instance creation checks secure context, cross-origin isolation, shared memory, Worker/WebAssembly availability and, when inspectable, Permissions Policy. Unsupported pages immediately display an error in the widget with expandable **Deployment details**, before consent. Check the **HTML page's** COOP/COEP response headers, rather than relying on headers from this bridge or the CDN. Embedded frames also require isolation/delegation by their parent.

`instance.diagnostics.error` and `instance.state.error` expose the latest failure. `instance.on('error', handler)` and document `randomx:error` events supply `{ code, message, hints, checks, stage }`; confirmed CSP violations also include `directive` and `resource` (query strings and credentials removed). Register a document listener before creating the embed, or inspect `.diagnostics.error` immediately afterward, to capture preflight failures. Generic download/worker errors list possible checks rather than asserting an unconfirmed cause. A delayed CSP report may replace a generic error for the same failed attempt.

Relevant enforced CSP violations are captured from the page and owned workers, including denied blob workers, runtime fetches and WASM compilation. Report-only and unrelated violations are ignored. A confirmed policy failure ends the session instead of retrying a permanently blocked operation; normal transport hiccups still reconnect while approved and preserve the dataset. Stop clears the error and suppresses late reports; destroy removes the listeners. If CSP blocks `embed.js` itself, only the browser console can explain that failure because the embed never runs. Permissions Policy introspection is optional and browser-dependent. [MDN: CSP violation events](https://developer.mozilla.org/en-US/docs/Web/API/SecurityPolicyViolationEvent).

## Exact bridge URL and framing

Given:

```js
{ proxy: 'wss://proxy.example.com/ws', pool: 'pool.supportxmr.com', port: 3333 }
```

The browser opens:

```text
wss://proxy.example.com/ws?pool=pool.supportxmr.com&port=3333
```

By default the embed sets/overwrites `pool` and `port` through `URL.searchParams`, preserving the configured path and any other query parameters. `routeQuery: false` uses an independent fixed-route proxy URL unchanged; the disclosed pool/port must match its actual destination. The reference bridge requires query routing for wallet passthrough, so its local preview always uses that mode. The wallet is in the login payload, not the URL. WS URL credentials and fragments are rejected. No WebSocket subprotocol is requested.

Each **WebSocket text message** is one complete JSON object. Do not return multiple newline-delimited objects in one WS message or an envelope such as `{type, data}`. On the **upstream TCP socket**, messages are JSON objects delimited by `\n`. Buffer incomplete TCP lines and split multiple lines received in a single TCP chunk. Forward each parsed pool object as a separate WS text message.

In the reference 1:1 bridge, one browser WS connection maps to one upstream pool TCP connection. Open that pool connection on login, queue login until TCP is connected, preserve request IDs and fields, and destroy upstream when the browser disconnects. A consolidating backend may translate session/request/job IDs internally, but each browser must see its own coherent logical session and replies. In NiceHash mode it must provide a distinct assigned prefix for each concurrent slice and retain the appropriate blob/target/seed. The embed does not require or implement upstream consolidation.

### Login

On every WS open, the embed sends request ID `1`:

```json
{
  "id": 1,
  "jsonrpc": "2.0",
  "method": "login",
  "params": {
    "login": "<configured wallet>",
    "pass": "<configured workerName>",
    "rigid": "<configured workerName>",
    "agent": "randomx-embed/0.2.1",
    "algo": ["rx/0"]
  }
}
```

The pool response must contain `result.id` (an opaque pool/bridge miner session token: a nonempty string or finite number) and `result.job`. For example, this is the response **shape**; angle-bracket values are placeholders, not a valid mining job:

```json
{
  "id": 1,
  "jsonrpc": "2.0",
  "error": null,
  "result": {
    "id": "<pool session id>",
    "status": "OK",
    "extensions": ["keepalive"],
    "job": {
      "job_id": "<pool job id>",
      "blob": "<pool blob hex>",
      "seed_hash": "<64 hex characters>",
      "target": "<pool target hex>"
    }
  }
}
```

The embed validates `job_id` as a string; `blob` as even-length hex, 86–512 hex characters (at least 43 bytes, covering the complete nonce); `seed_hash` as 64 hex characters; and `target` as 8, 16 or 64 hex characters. Forward real Monero pool blobs and targets unchanged. Mining assumes Monero's nonce layout (four bytes starting at byte 39); satisfying the basic length validator alone does not make an arbitrary blob mineable. The supported advertised algorithm is `rx/0`, not arbitrary coin-specific Stratum protocols.

Subsequent jobs arrive as:

```json
{"jsonrpc":"2.0","method":"job","params":{"job_id":"<id>","blob":"<hex>","seed_hash":"<64 hex>","target":"<hex>"}}
```

### Automatic NiceHash/XMRig Proxy negotiation

The embed now recognizes `"nicehash"` in the login response's `result.extensions`, following [XMRig's extension negotiation](https://github.com/xmrig/xmrig/blob/master/src/base/net/stratum/Client.cpp). For example:

```json
{"id":1,"result":{"id":"<session id>","extensions":["nicehash","keepalive"],"job":{"job_id":"<id>","blob":"<hex>","seed_hash":"<64 hex>","target":"<hex>"}}}
```

This enables nonce splitting automatically for every job on that connection. The worker preserves the high nonce byte supplied at blob byte 42 and varies only the remaining 24 bits. The explicit `nonceMode: 'nicehash'` option also enables this mode when a known NiceHash relay omits its extension flag. Automatic mode without the extension searches all 32 bits; a nonzero byte alone does not enable NiceHash mode. The original demo also recognizes the extension. The builder offers Negotiated/NiceHash under Advanced; neither choice adds a custom RPC or WebSocket subprotocol.

Parallel batches are shortened at the 24-bit boundary, so the existing native batch routine cannot carry into another miner's prefix. A job's search traverses its range once, including a bounded wrap of the low bits from its random starting point. After exhausting the range it pauses and reports `phase: 'waiting'` / `Nonce range exhausted — waiting for a new pool job`; it does not repeat that range or rebuild the dataset. A fresh job resumes mining. Reconnect clears the connection mode, reapplies the explicit NiceHash option or the new login's extensions, and reads the new job's assigned byte, reusing the same-seed dataset as before.

For the public donation demo, the topology can be `WSS framing bridge → localhost XMRig Proxy → fixed pool/operator wallet`. The framing bridge leaves aggregation to XMRig Proxy and rejects a different login wallet rather than diverting its payout. It must enforce approved routes server-side; legacy `set_target` must not bypass them. The page's configuration and consent disclosure must already name the actual donation wallet/pool. The reference `proxy/index.js` still implements configurable direct upstream routing; it has not been converted into the public donation service. Browser integration uses a fixture pool, not the deployed XMRig Proxy binary.

### Shares and replies

Submit request IDs increment from `2` for each connection, shared with keepalive requests. `params.id` is the session ID from login:

```json
{"id":2,"jsonrpc":"2.0","method":"submit","params":{"id":"<pool session id>","job_id":"<job id>","nonce":"<8 hex>","result":"<64 hex>"}}
```

Typical responses:

```json
{"id":2,"jsonrpc":"2.0","error":null,"result":{"status":"OK"}}
{"id":3,"jsonrpc":"2.0","error":{"code":-1,"message":"Low difficulty share"}}
```

The embed correlates responses by numeric ID, counts a pending share response with no truthy `error` as accepted, and counts a response with `error` as rejected. An ordinary share rejection does not force reconnect. Preserve the pool's response object. Never manufacture an acceptance or replay pending submissions after a disconnect; the embed discards outstanding requests and stale shares when reconnecting.

For upstream failure, close the browser WS or send an uncorrelated error such as the reference bridge's `{"error":"Pool disconnected"}` / `{"error":"Pool connection error: ..."}`. This tells the embed to retry. Do not leave a dead upstream behind an apparently healthy WS indefinitely.

### Heartbeats

The reference bridge sends **native WebSocket ping frames every 15 seconds** and terminates a client that has not answered by the next heartbeat. Browser WebSocket implementations send pong automatically; JavaScript does not send a JSON `ping`.

If login advertises `result.extensions` containing `"keepalive"`, or `keepalive: 'required'` is configured, the embed also sends the pool's standard RPC:

```json
{"id":4,"jsonrpc":"2.0","method":"keepalived","params":{"id":"<pool session id>"}}
```

The spelling is **`keepalived`**, not `keepalive`. A 15-second timer starts on WS open but sends no RPC until login succeeds. Automatic mode sends one when no previous keepalive request is pending; required mode sends every 15 seconds while logged in, even if a previous request is pending. Unanswered requests remain bounded by the response timeout. Unsupported-method errors (`-32601` or an appropriate unknown/not-supported-method message) disable automatic keepalive, while required mode stops with `KEEPALIVE_UNSUPPORTED`; other keepalive errors reconnect. The bridge forwards the RPC/reply normally or supplies coherent browser-scoped replies if it multiplexes upstream sessions.

Automatic mode without the advertised extension does not invent pool keepalive traffic and does not reconnect just because a pool has not sent a new job. Required mode follows the endpoint's keepalive contract regardless of extension flags. Native WS heartbeat still detects dead browser/transport connections.

### Legacy demo compatibility

`public/miner.js` (the original local demo miner) still uses the old `set_target`/JSON `ping` convention. `proxy/index.js` retains that compatibility. The new embed uses `?pool=...&port=...`, which selects login passthrough; the bridge forwards its wallet, worker name, agent, algorithm and submit session ID without legacy rewriting. Requests without the routing query fall back to `config.js` and the legacy login rewrite.

A new VPS implementation only needs the current URL routing and JSON-RPC contract to serve the embed. If it must also run the original miner UI, deliberately support the legacy path separately. Do not require a legacy handshake from the new embed.

## Reconnect and dataset lifetime

| Condition | Current behavior |
| --- | --- |
| WS closes/errors, malformed response/job, uncorrelated pool error | Pause mining and reconnect, except terminal policy closes below |
| Login error reply or WS close code `1008`/`4001` | Stop, show the server message/reason and require a new consent/start; no retries |
| WS close code `1012`/`1013` | Retry with backoff, retaining the engine and same-seed resources |
| Unsupported required keepalive or request exceeds 4096 UTF-8 bytes | Stop with an actionable error |
| WS connection plus initial login/job takes over 15 seconds | Reconnect; this timer starts at WS creation, after runtime initialization |
| Pending share or keepalive response exceeds 45 seconds | Reconnect on the next 15-second check (approximately 45–60 seconds) |
| Repeated connection failures | Retry after 1, 2, 4, 8, 16, then 30 seconds; continue at 30 seconds while approved |
| Successful login with an initial job | Reset backoff; resume job handling |
| Browser `online` event during reconnect | Attempt immediately |
| Ordinary rejected share | Increment rejected count; keep mining |
| Assigned nonce range exhausted | Wait for a fresh job; keep WS, consent and dataset resident |
| Engine download/WASM/worker error | Stop the session; new consent/start required, rather than a transport retry |

Reconnect attempts continue indefinitely during an approved session; successful recovery depends on the actual network, bridge and pool. The bridge should let the browser perform a fresh login after reconnect. A bridge process restart should close sockets promptly and permit new sessions after startup.

**Transport reconnect and tab switches do not destroy the control worker, its 32 pthreads, shared memory, VM or current seed's dataset.** A new login/job with the same seed reuses the existing resources. If initialization was already underway, the same-seed job can wait for that build instead of starting another one. In full mode the Argon2 cache is released after the dataset is built; it is the resident dataset/VM that is reused. In light mode the cache is retained and reused.

A different RandomX seed triggers rebuilding for that seed. Explicit Stop, effective workload changes, page unload, destruction and engine errors end the worker session; the next approved start builds resources again. Do not confuse these intentional lifecycle resets with a connection hiccup. Job IDs may change on reconnect without a dataset rebuild; the seed determines reuse.

## VPS setup

The existing bridge can run directly with Node 18+ from the repository root:

```sh
node proxy/index.js
```

It uses the vendored `vendor/ws`; no `npm install`, Emscripten or RandomX build is required for a bridge-only VPS. Keep `proxy/`, `vendor/ws/` and `config.js` available. Its HTTP/static + WS listener defaults to `8080`; it also starts an optional raw-TCP Stratum listener on `8081`. Both currently listen on all interfaces, and port settings come from `config.js`, not environment variables. For this demo, expose only the public TLS reverse proxy; firewall internal ports or change the listeners to loopback, and disable the unused raw-TCP frontend if building a standalone bridge. Run the process under the VPS's service manager with restart on failure.

The reference upstream connection is `net.Socket` **plain TCP**. Select a pool's plain TCP Stratum port. A TLS-only pool port needs an explicit TLS-capable upstream adapter; choosing port 443 does not add TLS. Public WSS encryption terminates at the reverse proxy and is independent of upstream pool TLS.

The reference code is a local demo bridge, with no Origin/target allowlist or authentication. For a public demo, allow the intended Netlify origin(s) and approved pool host/port pairs, enforce target restrictions at the upstream connection as well as URL parsing, and prevent connections to private/internal destinations. If retaining legacy methods, `set_target` must not bypass those restrictions (it is still accepted by the reference handler). Origin filtering controls browser access but is not authentication for non-browser clients. Put bounded frame/line/queue sizes and connection limits in the public bridge so a broken client or pool cannot grow buffers indefinitely.

Minimal nginx location inside an existing TLS server for `proxy.example.com`:

```nginx
location = /ws {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 75s;
    proxy_send_timeout 75s;
    proxy_buffering off;
}
```

Supply the domain/certificate and the surrounding HTTPS server configuration separately. This `proxy_pass` preserves `/ws` and its query. Native 15-second heartbeat frames keep the upgraded tunnel active. Upgrade headers must be forwarded explicitly, and inactivity timeout must accommodate heartbeat cadence. See [nginx WebSocket proxying](https://nginx.org/en/docs/http/websocket.html).

WebSockets use the HTTP upgrade's `Origin` policy, not fetch CORS preflight. The browser sends the **Netlify page origin**, not `https://cdn.jsdelivr.net`. Allow the exact production demo origin and any preview origins actually used; preserve `Origin` through the reverse proxy. An `Access-Control-Allow-Origin` header on this WS endpoint is not a substitute for accepting the upgrade. A separate health endpoint is useful, but its HTTP 200 does not prove WS/login/pool connectivity.

## jsDelivr publication

Run `make embed` in the build environment. Publish these co-located files from a single build:

```text
dist/embed.js
dist/embed-worker.js
dist/worker.js
dist/randomx.js
dist/randomx.wasm
dist/manifest.json
dist/LICENSE
dist/RandomX.LICENSE
```

The manifest records asset SHA-256 and SRI values. It is release metadata; the embed does not fetch or enforce the manifest at runtime. Asset paths are resolved relative to the embed script, unless `assetBase` overrides them. Blob workers are constructed on the page's origin; they import the versioned worker scripts and fetch WASM from the asset directory. Stop can therefore terminate all page-owned engine threads immediately.

For the GitHub route, commit and push the distribution and required source changes, then pin the public site to that full commit SHA or an immutable release tag:

```text
https://cdn.jsdelivr.net/gh/aa022/RandomX-bonanza@FULL_COMMIT_SHA/dist/embed.js
```

An npm alternative is `https://cdn.jsdelivr.net/npm/randomx-bonanza-embed@0.2.1/dist/embed.js`, **after** that version is actually published. Do not use a floating branch/latest URL or mix asset versions for the acceptance test. Do not replace an already cached release in place; publish a new version/commit. jsDelivr documents both URL formats and permanent caching of static versions in its [usage documentation](https://github.com/jsdelivr/jsdelivr#usage-documentation).

Before deploying the test page, verify HTTP 200, JavaScript/WASM content types and cross-origin availability for all five runtime assets at the chosen pin. The Netlify page cannot fix missing CORS on a CDN. For an alternative asset host, provide `Access-Control-Allow-Origin: *` and `Cross-Origin-Resource-Policy: cross-origin`; engine fetches omit credentials. Use `application/javascript` for `.js` and `application/wasm` for `.wasm`.

## Minimal Netlify test page

The ready-to-upload [netlify-demo directory](netlify-demo/README.md) contains `index.html`, `demo.js` and `_headers`, uses the confirmed wallet from `config.js`, and pins the published runtime commit. Drag the entire directory into Netlify's manual deploy interface; its contents are the publish directory, with no build command. Chrome loaded that page using the actual pinned jsDelivr embed and these headers, confirmed isolation/support and the payout disclosure, and verified that pre-consent/unchecked Start created no engine downloads, workers or WS connections. The Netlify site itself has not been deployed by this session.

The examples below describe a custom equivalent. Replace their placeholders before use; the ready-to-upload directory already has its real configuration.

`index.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RandomX embed demo</title>
  <script defer crossorigin="anonymous" data-auto="false"
    src="https://cdn.jsdelivr.net/gh/aa022/RandomX-bonanza@FULL_COMMIT_SHA/dist/embed.js"></script>
  <script defer src="/demo.js"></script>
</head>
<body>
  <main id="mining-demo"></main>
</body>
</html>
```

`demo.js` (normal widget; no custom consent handler needed):

```js
window.demoMiner = RandomXEmbed.create({
  wallet: 'REPLACE_WITH_DEMO_PAYOUT_ADDRESS',
  pool: 'REPLACE_WITH_APPROVED_POOL_HOST',
  port: 3333, // Replace with that pool's plain TCP rx/0 port.
  workerName: 'netlify-demo',
  proxy: 'wss://proxy.example.com/ws',
  workload: 50,
  mode: 'full',
  container: '#mining-demo'
});
demoMiner.on('state', ({ phase, status, hashrate, accepted, rejected, retries }) => {
  console.log('[randomx]', { phase, status, hashrate, accepted, rejected, retries });
});
```

`_headers`:

```text
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Permissions-Policy: cross-origin-isolated=(self)
```

Put `_headers` in the actual **publish directory**, including after a build step. Netlify applies these custom headers to its static files; functions, SSR or proxied responses must return their own headers. Configure each isolation header once. See [Netlify custom headers](https://docs.netlify.com/manage/routing/headers/).

This standalone test page can initially omit CSP. If configuring CSP, the external-script example above needs at least the following permissions, merged with the site's other directives:

```text
default-src 'self'; script-src 'self' https://cdn.jsdelivr.net blob: 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' https://cdn.jsdelivr.net wss://proxy.example.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:
```

Replace the proxy origin with the actual endpoint origin. WASM compilation, including the engine's generated WASM modules, needs the WASM evaluation permission; older browser CSP implementations may require `'unsafe-eval'` as used by the local demo. Widget styling needs either the shown style permission or the `nonce` option with a matching style CSP nonce. Inline exported configuration/consent scripts need their own CSP nonce/hash or should be moved into `demo.js`. COEP also applies to unrelated external images, fonts and scripts; they must be allowed through CORS/CORP. Keep this first test page minimal to make failures attributable.

For quickstart/custom DOM, register the handler before the first interaction and instantiate with `headless: true, quickstart: true`. For example, adapt the `demo.js` configuration above and add:

```js
document.addEventListener('randomx:consent-request', (event) => {
  const consent = event.detail;
  if (consent.instance !== window.demoMiner) return;
  if (window.confirm(consent.disclosure)) consent.accept();
  else consent.decline();
});
// Bind your own visible Stop button, status display, and workload controls:
demoMiner.bindControls({
  start: '#mine-start', stop: '#mine-stop', workload: '#mine-workload',
  disclosure: '#mine-disclosure', status: '#mine-status', hashrate: '#mine-rate'
});
```

Supply those DOM elements on the page. The confirmation is an example deployer-owned consent presentation; quickstart itself imposes no built-in checkbox or dialog. A visible Stop control should remain available throughout the session.

## End-to-end acceptance and debugging

1. Record the final VPS WSS URL/path, allowed Netlify origin(s), approved upstream host/port and TCP/TLS mode, demo payout address, worker name and pinned CDN revision. The bridge and page must use the same agreed routing contract.
2. Verify the VPS certificate, WS upgrade (`101 Switching Protocols`), routing query, upstream TCP connection and unchanged login response. Check bridge logs for a job belonging to that browser session. The browser's WS inspector should show `login`, pool response and `job` notifications; no `set_target` is expected.
3. Verify the actual Netlify HTML response has both isolation headers. In the page console, confirm `isSecureContext === true`, `crossOriginIsolated === true`, and `typeof SharedArrayBuffer === 'function'`. If false, fix HTML headers/Permissions Policy before debugging the pool.
4. Before consent, verify there is no `randomx.js`/`.wasm` engine request, mining worker creation or bridge WS. Clicking Start with an unchecked checkbox must still leave these absent. The small `embed.js` script is expected to load before consent.
5. Approve and start. Check all versioned assets load, the engine becomes ready, WS logs in, full-dataset progress completes and hashrate becomes nonzero. Mining workers/dataset live in the browser, not on the VPS.
6. Wait for a genuine pool-accepted share and confirm the pool response correlates to a submit ID. A real pool's difficulty can make this take substantially longer than the fixture test. Nonzero hashrate or a successful login alone does not prove accepted shares.
7. Including in a background tab, deliberately restart the bridge or disconnect upstream. Expect `reconnecting`, retries, a fresh login and resumed mining. With the same seed, there should be no second dataset/cache initialization and the worker objects should remain the same. Compare worker identities/build instrumentation as in `tests/embed-browser.cjs`; lack of a second download alone is insufficient proof because browser caching can hide downloads.
8. Stop and verify all engine workers and WS terminate and retries cease. Restart requires fresh consent. Tabbing away must retain the approved session, connection and dataset. A changed effective workload also stops/requires consent; it is not a reconnect reuse test.
9. Exercise quickstart/headless separately: no DOM widget, first interaction emits consent, decline/no handler does not mine, acceptance starts, and custom Stop shuts everything down. Check the ARM 50%/other 80% mining-thread limits against browser-reported cores and remember initialization remains 32 threads.

Common failure clues:

| Symptom | First place to inspect |
| --- | --- |
| Isolation/support error before engine starts | Netlify HTML headers, secure context, Permissions Policy |
| Engine asset/CSP/worker error | Pinned asset existence, CORS/CORP, content types, CSP, memory availability |
| WS fails before login | Public DNS/certificate, WSS URL, Origin allowlist, nginx upgrade/path/query |
| Login repeats after 15 seconds | Upstream connectivity, plain TCP vs TLS port, pool response framing/shape, wallet/pool compatibility |
| WS alive but pool disconnected | Forward upstream failure or close WS; do not only heartbeat a dead upstream |
| Shares rejected | Pool error text, algorithm, actual wallet/pool requirements, unchanged blob/target/session ID |
| Dataset rebuilt | Seed changed, or a Stop/workload/page unload/worker failure ended the session |
| Chromium public-site hashrate about half of localhost at equal threads | Per-site JavaScript optimizers permission; the engine JIT being enabled does not imply V8's optimizing WASM tier is allowed |

Intentional client closes now carry code `1000` and a short reason:
`Session stopped` for Stop/unload, `Transport reset` before reconnect. Earlier
versions called `ws.close()` without arguments, which sends an empty close
frame. A relay message saying it **received a close frame** with
`StatusNoStatusRcvd` is consistent with that empty frame; it does not establish
that no close frame arrived. Tab switches no longer intentionally close WS.

Observed public target `b2df0000` represents difficulty approximately 75,000.
At 600 H/s the mean interval between shares is about 125 seconds; at 300 H/s
it is about 250 seconds. Actual arrivals vary. Zero shares in a 20–60 second
session does not by itself show that mining has failed, and a pool-side rate
estimate based on submitted shares will initially be zero.

Local regression commands from the repository root:

```sh
make test-embed
PUPPETEER_MODULE=/path/to/puppeteer-core node tests/embed-browser.cjs
```

The browser integration expects installed Chrome; set `CHROME_PATH` if it is not at the test's default macOS path. It launches its own local bridge/fixture pool/asset origin and does not submit to an external pool. `make serve` serves the configuration form and local preview; `make embed` builds the distribution. Neither command publishes to jsDelivr or deploys to Netlify.
