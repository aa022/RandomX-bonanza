# Embed progress

Updated: 2026-09-30.

**Status: client compatibility with the corrected VPS contract is implemented and locally validated. Preparing the delivery branch `embed-v0.2.0-demo` and a minimal Netlify test directory. The operator confirmed the donation wallet in `config.js`; public endpoint acceptance testing is still pending.**

## Completed

- Packaged the browser embed in `dist/`, including the bootstrap, worker scripts, RandomX runtime/WASM, hash manifest and licenses. `make embed` rebuilds the distribution.
- Added configurable wallet, pool, port, worker name, CPU percentage and full/light memory mode.
- Added the built-in DOM widget and a headless API for custom DOM controls.
- Added the configuration form, exported drop-in script and local preview to the web UI served by `make serve`.
- Kept consent session-only. Normal widget startup requires its checkbox and a trusted Start click. Quickstart has no built-in checkbox: the first qualifying interaction emits a consent request, and the deployer must explicitly accept it. No handler/acceptance means no mining.
- Set mining limits to 80% of browser-reported cores globally, 50% for detected/inferred ARM, and at most 32 mining threads. Removed efficiency-core configuration. Full dataset initialization still requests 32 threads and is disclosed separately.
- Implemented indefinite transport reconnect attempts during an approved, visible session, with 1–30 second backoff, login/response timeouts and prompt retry on `online`.
- Preserved the engine workers, shared memory and same-seed dataset across reconnects. Full mode releases its cache after dataset construction; light mode retains its cache. Stop, hiding the page, effective workload changes and engine failure end the worker session and require fresh consent.
- Adopted ordinary Monero JSON-RPC login/job/submit messages. Pool routing uses the WS URL's `pool` and `port` query parameters. Native WS ping/pong and negotiated `keepalived` replace the new embed's former custom handshake/heartbeat requirements. The original demo's legacy handshake remains supported by the reference bridge.
- Added automatic NiceHash/XMRig Proxy negotiation in both the embed and original demo. Login `result.extensions` containing `"nicehash"` enables assigned nonce prefixes; no UI switch is required. `instance.state.nicehash` exposes the negotiated mode.
- Preserved each aggregated job's high nonce byte while searching its remaining 24 bits. Ordinary jobs search all 32 bits. Parallel batches stop before overflow into another prefix; a fully exhausted range waits for a fresh job rather than repeating work.
- Updated [README.md](README.md) and the detailed [VPS proxy handoff](proxy_handoff.md).
- Added deployment diagnostics: the widget shows errors with expandable details, headless integrations receive structured error events, and `RandomXEmbed.diagnose()` checks browser/isolation support without engine or network work. Relevant enforced CSP violations identify blocked directives/resources; generic download/worker failures provide actionable checks. Explicit Stop clears errors and suppresses late policy reports.
- Preserved independent proxy support. `routeQuery: false` leaves a fixed-route WS/WSS URL unchanged; the default retains the reference bridge's `pool`/`port` query convention. Wallets are always sent exactly as configured, without a donation-wallet fallback or substitution.
- Added optional `nonceMode: 'nicehash'` for known NiceHash relays that omit the extension, and `keepalive: 'required'` for their 15-second keepalive contract. Defaults remain negotiated; ordinary connections search all 32 nonce bits. Builder Advanced controls export both options, while the local preview uses its reference bridge's negotiated modes.
- Added terminal login-error and policy-close handling: login errors and close codes 1008/4001 stop, preserve the server message/reason and withdraw consent; 1012/1013 retry with backoff. Outgoing frames cannot exceed 4096 UTF-8 bytes. Login/session/job validation rejects malformed work without resetting failure backoff.

## Validation completed

- `make test-embed`: **37 tests passed**, covering consent, CPU limits, lifecycle, reconnects, automatic/explicit NiceHash, ordinary 32-bit mode, prefix boundaries/exhaustion, independent proxy routing, browser-scoped replies, opaque session tokens, frame sizes, required/negotiated keepalive, terminal errors and deployment diagnostics.
- Real Chrome integration against a local fixture pool passed full-memory initialization, share submission, ordinary → NiceHash → ordinary reconnects, assigned nonce preservation, and a shortened native batch at the 24-bit boundary. The same worker objects remained resident and cache/dataset construction occurred only once across those reconnects.
- The exported headless quickstart example passed with custom consent, custom controls and cross-origin assets.
- Real Chrome failure fixtures passed missing isolation headers, denied Permissions Policy, blocked workers, blocked downloads and blocked WASM compilation. The widget rendered deployment details and the API emitted error events; preflight failures and all pre-consent checks started no engine work.
- The exported snippet passed against an independent fixed-route proxy fixture: explicit NiceHash without advertised extensions, at least 100 WASM-generated shares with correct job prefixes and zero synthetic fixture rejections, required keepalive, changed jobs/prefixes, native pong, and 1012 reconnect with identical workers/cache. A wrong donation wallet produced a visible terminal error, no upstream mining login and no retry.
- JavaScript syntax and whitespace checks passed. All five runtime distribution files matched their source copies and the manifest's SHA-256 hashes.

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

1. Obtain the actual operator donation wallet and confirm the supplied WSS endpoint/routing and admission policy.
2. Test that endpoint with `nonceMode: 'nicehash'` and `keepalive: 'required'`: verify genuine pool-accepted shares, every submitted prefix, terminal rejection of other wallets, and reconnects without a same-seed dataset rebuild. The synthetic fixture's zero rejections do not establish real pool acceptance or independently validate each hash cryptographically.
3. Publish the current distribution to a public pinned commit/release or npm version so jsDelivr can serve it. The builder's `@v0.2.0` URL remains a placeholder until publication.
4. Deploy the Netlify test page with the isolation headers and configuration documented in `proxy_handoff.md`.
5. Verify the public Netlify → jsDelivr → VPS → pool path, consent/Stop behavior and reconnect recovery.

The implementation and packaged assets are being published to the delivery branch, with the final status to be recorded after push. No npm release, VPS deployment or Netlify deployment has been performed. This progress file and `proxy_handoff.md` are explicitly included for sharing.
