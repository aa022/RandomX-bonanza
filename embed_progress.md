# Embed progress

Updated: 2026-09-30.

**Status: the runtime is committed and pushed on `embed-v0.2.0-demo` at `cdebaa57f2855d657c0424fe0e405c4aad8af839`. The user deployed `netlify-demo/` at https://fluffy-elf-267140.netlify.app/. Runtime 0.2.1 fixes background sessions; genuine public-pool share acceptance is still pending.**

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
