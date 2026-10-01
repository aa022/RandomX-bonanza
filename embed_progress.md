# Embed progress

Updated: 2026-10-01.

**Status: runtime 0.2.1 is committed and pushed on `embed-v0.2.0-demo` at `cdebaa57f2855d657c0424fe0e405c4aad8af839`; the user deployed `netlify-demo/` at https://fluffy-elf-267140.netlify.app/ against it. Runtime 0.2.1 fixes background sessions; genuine public-pool share acceptance is still pending. Embed 0.3.0 (light-mode worker pool, [below](#embed-030-2026-10-01), plus the RAM budget [below](#light-mode-budget-2026-10-01-after-the-configurator)) is committed locally at `d71ea8b607af072452edb3268c1fdf7225a7a4bf` (it supersedes the unpushed `2f5603e`), and `netlify-demo/` is now the operator configurator pinned to it ([below](#configurator-2026-10-01)); neither is pushed, so jsDelivr and the live site still serve 0.2.1.**

## Completed

- Packaged the browser embed in `dist/`, including the bootstrap, worker scripts, RandomX runtime/WASM, hash manifest and licenses. `make embed` rebuilds the distribution.
- Added configurable wallet, pool, port, worker name, CPU percentage and full/light memory mode.
- Added the built-in DOM widget and a headless API for custom DOM controls.
- Added the configuration form, exported drop-in script and local preview to the web UI served by `make serve`.
- Kept consent session-only. Normal widget startup requires its checkbox and a trusted Start click. Quickstart has no built-in checkbox: the first qualifying interaction emits a consent request, and the deployer must explicitly accept it. No handler/acceptance means no mining.
- Set mining limits to 80% of browser-reported cores globally, 50% for detected/inferred ARM, and at most 32 mining threads. Removed efficiency-core configuration. Full dataset initialization still requests 32 threads and is disclosed separately.
- Implemented indefinite transport reconnect attempts during an approved session, with 1–30 second backoff, login/response timeouts and prompt retry on `online`.
- Preserved the engine workers, shared memory and same-seed dataset across reconnects and tab switches. Full mode releases its cache after dataset construction; light mode retains its cache. Stop, page unload, effective workload changes and engine failure end the worker session and require fresh consent. Hiding cancels pending consent requests, but leaves approved mining running, subject to browser throttling/suspension.
- Adopted ordinary Monero JSON-RPC login/job/submit messages. Pool routing uses the WS URL's `pool` and `port` query parameters. Native WS ping/pong and negotiated `keepalived` replace the new embed's former custom handshake/heartbeat requirements. The original demo's legacy handshake remains supported by the reference bridge.
- Added automatic NiceHash/XMRig Proxy negotiation in both the embed and original demo. Login `result.extensions` containing `"nicehash"` enables assigned nonce prefixes; no UI switch is required. `instance.state.nicehash` exposes the negotiated mode.
- Preserved each aggregated job's high nonce byte while searching its remaining 24 bits. Ordinary jobs search all 32 bits. Parallel batches stop before overflow into another prefix; a fully exhausted range waits for a fresh job rather than repeating work.
- Updated [README.md](README.md) and the detailed [VPS proxy handoff](proxy_handoff.md).
- Added deployment diagnostics: the widget shows errors with expandable details, headless integrations receive structured error events, and `RandomXEmbed.diagnose()` checks browser/isolation support without engine or network work. Relevant enforced CSP violations identify blocked directives/resources; generic download/worker failures provide actionable checks. Explicit Stop clears errors and suppresses late policy reports.
- Preserved independent proxy support. `routeQuery: false` leaves a fixed-route WS/WSS URL unchanged; the default retains the reference bridge's `pool`/`port` query convention. Wallets are always sent exactly as configured, without a donation-wallet fallback or substitution.
- Added optional `nonceMode: 'nicehash'` for known NiceHash relays that omit the extension, and `keepalive: 'required'` for their 15-second keepalive contract. Defaults remain negotiated; ordinary connections search all 32 nonce bits. Builder Advanced controls export both options, while the local preview uses its reference bridge's negotiated modes.
- Added terminal login-error and policy-close handling: login errors and close codes 1008/4001 stop, preserve the server message/reason and withdraw consent; 1012/1013 retry with backoff. Outgoing frames cannot exceed 4096 UTF-8 bytes. Login/session/job validation rejects malformed work without resetting failure backoff.

## Validation completed

- `make test-embed`: **38 tests passed**, covering consent, CPU limits, lifecycle, background initialization/mining/reconnects, automatic/explicit NiceHash, ordinary 32-bit mode, prefix boundaries/exhaustion, independent proxy routing, browser-scoped replies, opaque session tokens, frame sizes, required/negotiated keepalive, terminal errors and deployment diagnostics.
- Real Chrome integration against a local fixture pool passed full-memory initialization, share submission, ordinary → NiceHash → ordinary reconnects, assigned nonce preservation, and a shortened native batch at the 24-bit boundary. The same worker objects remained resident and cache/dataset construction occurred only once across those reconnects.
- The exported headless quickstart example passed with custom consent, custom controls and cross-origin assets.
- Real Chrome failure fixtures passed missing isolation headers, denied Permissions Policy, blocked workers, blocked downloads and blocked WASM compilation. The widget rendered deployment details and the API emitted error events; preflight failures and all pre-consent checks started no engine work.
- The exported snippet passed against an independent fixed-route proxy fixture: explicit NiceHash without advertised extensions, at least 100 WASM-generated shares with correct job prefixes and zero synthetic fixture rejections, required keepalive, changed jobs/prefixes, native pong, and 1012 reconnect with identical workers/cache. A wrong donation wallet produced a visible terminal error, no upstream mining login and no retry.
- JavaScript syntax and whitespace checks passed. All five runtime distribution files matched their source copies and the manifest's SHA-256 hashes.
- The published jsDelivr pin returned HTTP 200 for all five runtime assets, with matching SHA-256 hashes, correct JS/WASM types, wildcard CORS and cross-origin CORP.
- Chrome loaded the actual Netlify test page against that public CDN pin with its isolation headers: browser support/isolation, wallet/proxy/modes and disclosure were correct. Pre-consent and unchecked Start produced no engine downloads, workers or WS connections. This did not start mining against the public proxy.

These checks used a fixture pool. They do **not** establish acceptance by a real pool or a deployed XMRig Proxy binary.

## VPS demo direction

The proposed simpler public demo is:

```text
Browser → WSS framing bridge → local XMRig Proxy → fixed pool and owner wallet
```

The page must disclose the actual fixed payout wallet and pool before consent. The VPS can let XMRig Proxy handle aggregation; the framing bridge only needs transport framing, admission limits and basic monitoring. It must enforce its fixed route rather than honor arbitrary upstream targets.

The corrected handoff names `wss://proxy.randomx.cc/embed-ws?pool=pool.supportxmr.com&port=3333`. This path accepts only the operator donation wallet and rejects other wallets instead of rewriting them. The earlier pasted bring-your-own-wallet/consolidation handoff was superseded. Other payout wallets require an independent/self-hosted compatible proxy; the embed remains configurable for those.

The local reference `proxy/index.js` still supports configurable direct upstream routing. It has not been converted into the proposed public fixed-wallet service. The handoff documents both its actual behavior and the requirements for the VPS implementation.

## Resume after VPS setup

1. Deploy `netlify-demo/` to Netlify and record the final site URL. The donation wallet is confirmed; check the WSS endpoint's admission policy for the deployed origin.
2. Test that endpoint with `nonceMode: 'nicehash'` and `keepalive: 'required'`: verify genuine pool-accepted shares, every submitted prefix, terminal rejection of other wallets, and reconnects without a same-seed dataset rebuild. The synthetic fixture's zero rejections do not establish real pool acceptance or independently validate each hash cryptographically.
3. Keep the test on the published full-commit jsDelivr pin; publish a new runtime commit for any runtime changes rather than mixing versions.
4. Verify the actual Netlify HTML response has the isolation headers from the supplied `_headers` file.
5. Verify the public Netlify → jsDelivr → VPS → pool path, consent/Stop behavior and reconnect recovery.

The implementation and packaged assets are published on the delivery branch. The Netlify directory pins the runtime commit. The user deployed the VPS and Netlify site; no npm release has been performed. This progress file and `proxy_handoff.md` are explicitly included for sharing.

## Live debugging, 2026-09-30

The user deployed https://fluffy-elf-267140.netlify.app/ and the VPS relay is
operational. The actual HTML supplies COOP/COEP/Permissions Policy correctly.
A clean Chrome 154 session with the published embed initialized full memory,
received real jobs and 15-second keepalive replies, and mined for two minutes
with zero reconnects/JIT errors. All five downloaded runtime assets matched
the published manifest. This bounded run produced no submitted shares, so it
does not establish real-pool acceptance. The observed target's difficulty was
approximately 75,000; short runs without shares are expected at browser rates.

Four-thread comparison used the identical real pool blob and seed in a local
fixture, a 10-second warmup and 25-second sampling window, with sequential
fresh Chrome instances. Median rates on this machine:

| Assets / Chromium mode | H/s |
| --- | ---: |
| Local `public/` assets, normal optimizers | 620 |
| Published jsDelivr assets, normal optimizers | 622 |
| Published jsDelivr assets, `--js-flags=--disable-optimizing-compilers` | 286 |

All three used four mining threads, full mode, the ARM engine profile and
NiceHash nonce handling, with no JIT failures. This reproduces the reported
speed gap and points to Chromium's per-site JavaScript optimizers permission;
the user's actual permission has not been inspected. Safari performing well
is consistent with that hypothesis. A checked runtime JIT flag alone does not
confirm browser WASM tiering is enabled. See README's Chromium diagnostic.

The background-stop bug is fixed in runtime 0.2.1: approved initialization,
mining and reconnects survive tab switches without destroying the workers or
dataset. The consent disclosure explains background continuation and possible
browser throttling/suspension. Stop/unload still withdraw consent and terminate
the engine. Intentional WS closes use code 1000 and an explicit short reason
instead of an empty close frame. All 38 deterministic checks and the real-browser
regression suite passed, including hidden-tab shares/reconnects with identical
workers and one cache/dataset build. Runtime 0.2.1 is published at the status
commit above; all five CDN assets returned HTTP 200 and matching hashes.

## Embed 0.3.0, 2026-10-01

After the `perf/amd64` merge (the no-SharedArrayBuffer fallback), the embed
gains a light mode that runs without isolation headers and a wider control
API. Full mode is unchanged. Committed locally on `embed-v0.2.0-demo`, not
pushed; the configurator below pins it.

- **Light mode is the `randomx_st` worker pool**, a port of `NoSabPool`:
  one single-thread worker per mining thread, ~300 MB each, disjoint nonce
  slots, no SharedArrayBuffer. It replaces 0.2.1's one-thread pthread light
  mode, on isolated pages too. Reconnects keep every worker and cache; Stop
  and pagehide terminate all of them.
- **Replicas** (`replicas: 0–2`, light only): workers that also mine on a
  private full dataset (~2.3 GB each), built by all workers after each seed
  change. The page loads `fb_full.js` after consent as a `<script>` from the
  asset base. Dropped when `navigator.deviceMemory` reports under 8.
- **New options:** `maxThreads` (absolute ceiling), `initThreads` (full mode,
  disclosed), API-only `tuning` (`profile`, `jit`, `lightMlp`, `kernelK`,
  and `experiment` limited to hash-safe `jit_exp` tokens), and
  `data-max-threads` / `data-replicas` / `data-init-threads`. Modes stay
  strictly `full` | `light`; the embed never switches mode by itself.
- **New API:** `RandomXEmbed.plan()` (threads, workers, RAM and disclosure
  without an instance or network), `diagnose(mode)` with `modes: {full,
  light}`, and `state.engine`. Full mode on a non-isolated page fails at
  preflight with the header hints plus one pointer to `mode: 'light'`.
- **Disclosure and status** state the light worker count, per-worker and
  replica RAM and the total; full mode states its initialization threads.
- **Packaging:** `dist/` ships 8 engine files (adds `randomx_st.js`/`.wasm`
  and `fb_full.js`); `coi-sw.js` is deferred and not shipped. The login
  agent is `randomx-embed/0.3.0`.
- **Review fixes before the commit:** `tuning.experiment` rejects the
  timing-only `reuse`/`reuse2` tokens (wrong hashes on purpose) and unknown
  tokens; `mode: null`, `false` or `0` throws instead of becoming full;
  Chromium's architecture hint is requested once per page, so `plan()`
  agrees with `create()` on Intel Macs and Windows on ARM; status lines say
  "1 worker" / "1 thread". The builder's light-mode label and budget line
  follow the plan.

### Validation, 2026-10-01

- `make test-embed`: **57 tests passed**. The new tests cover the pool
  bootstrap and `init` fields, aggregation, Stop, non-isolated light starts,
  replicas and their demotion, `plan()`, `diagnose(mode)` and validation
  (worker nonce slots were covered in the merge step). Each review fix's test fails against the code before
  the fix (checked in scratch copies).
- `make embed`: 8 files, each identical to its `public/` source and matching
  the manifest's size, SHA-256 and SHA-384; version 0.3.0.
- Real Chrome (headless `tests/embed-browser.cjs`, fixture pool and local
  bridge only): all 21 checks passed. Light mode on a page without COOP/COEP
  with 3 workers was consent-gated, loaded only the `randomx_st` build, got
  accepted NiceHash shares in each worker's own nonce slot, kept the same
  workers and caches across a pool reconnect, and Stop terminated every
  worker. Light mode on an isolated page and `replicas: 1` also passed, the
  latter with worker 0 mining on its replica. Full mode on a header-less
  page failed at preflight with one light-mode hint, and the CSP/policy cases
  passed in both modes. 15 submitted light-mode shares (5 from the replica's
  full dataset) re-hash in Node to their submitted results. The 0.2.1 full-mode
  checks passed unchanged.
- **No hashrate numbers.** The machine was heavily loaded by other work
  during this validation, so H/s figures would mean nothing. They are
  pending one bench pass on an idle machine.

These checks used a fixture pool; they do not establish acceptance by a
real pool.

## Light-mode budget, 2026-10-01 (after the configurator)

Operator ergonomics for light mode: choose a CPU `workload`, a RAM budget and
whether the full-dataset boost may be used; the embed derives the rest per
visitor device (README "Light mode").

- `memory` (% of reported RAM, default 50) and `memoryCap` (GB where the
  browser reports none, default 2) form the budget; workers are cut to it.
- `replicas: 'auto'` (new default) picks 0–2 by `light workers + 2.25 ×
  replicas` within the budget; fixed counts fall back to what fits. The old
  "drop below 8 GB" rule is gone.
- Replica builds use `initThreads` (default 32, the user's choice) threads:
  the pool plus temporary helper workers (`seed` message in `worker.js`,
  `FbCoordinator.lost()` requeues a failed helper's chunks). Helpers take
  ~300 MB each while the build runs; `plan().peakMemoryMiB` and the
  disclosure state the peak, which is above the RAM budget by design.
- The ARM 50% workload cap is gone; `optimizeArm` (full mode only, default
  off) counts half the reported cores on ARM devices. A session approved
  before Chromium's architecture hint never runs more threads than approved.
- The 2.25 weight and the build-helper speedup are x86 (5600X) figures; they
  need the idle-machine bench pass on the M4.

## Configurator, 2026-10-01

`netlify-demo/` replaces the single-widget test page with the operator's
pre-deployment configurator (first draft; the form design is to be iterated
with the user). The page is `index.html`, `configurator.js` and
`configurator.css`. It pins embed 0.3.0 at `d71ea8b607af072452edb3268c1fdf7225a7a4bf`.
It has payout/bridge fields with Advanced options, a Full / Light switch, and
a full-mode panel: the headers, what they can break, and a choice between
arming them and switching to light. A light panel covers replicas, and a
`RandomXEmbed.plan()` estimate shows this device. The page produces the
snippet (full mode prefixed with a header comment) and a consent-gated
preview. `coi-sw.js` stays out of it. `make demo`
(`scripts/serve-demo.mjs`) serves it locally with the pin rewritten to
`dist/`, applying `_headers` or, with `DEMO_ARGS=--no-isolation`, no
COOP/COEP.

Checked in headless Chrome against a local fake bridge only:
- both servers: no engine, worker or WebSocket on load;
- panels, header block and "Switch to light";
- estimates against `plan()`, including the replica drop under 4 GB `deviceMemory`;
- Copy snippet;
- no horizontal scroll at 390 px;
- full preview on the non-isolated page stops at preflight;
- light preview mining without isolation;
- full preview mining on the isolated page;
- exported light, full and headless-quickstart snippets on blank isolated and
  non-isolated fixture pages, light mining on the non-isolated one.

No hashrate numbers were recorded.

Operator review (same day): 1280 / 390 px, light / dark, isolated,
`--no-isolation` and behind an HTTPS front, against a local fake bridge.
Fixed:
- at 390 px the headless preview's disclosure and the consent notice
  overflowed: the unbroken wallet widened the mobile layout viewport;
- a relative Script URL resolved against the configurator's own origin; it
  must now be absolute;
- Copy headers confirmed in the snippet section, far below the button;
- the Show preview click itself opened a quickstart preview's consent notice
  instead of the next interaction;
- Show preview with invalid settings said nothing beside the button, and an
  unparsable bridge URL showed the URL constructor's message;
- the estimate now says why replicas are capped at one per worker.

Re-checked after the fixes: the full widget snippet on an isolated blank page
and the light headless + quickstart snippet with 1 replica on a non-isolated
one mine only after consent, with the chosen `state.engine` (replica active),
NiceHash byte 42 kept and shares re-hashing in Node. Preview mining works in
both modes, and Stop and Remove preview end every worker and the socket.
