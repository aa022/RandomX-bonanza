# Netlify embed test

Drag this entire directory into Netlify's manual deploy interface. Its contents
are the site's publish directory; keep `_headers` beside `index.html`.
No build command or dependency installation is needed.

The page imports the embed and its runtime from jsDelivr, pinned to commit
`2ea238ff993873097e18788b5892390f0d0fd803` on `embed-v0.2.0-demo`. The files
in `dist/` are not uploaded to Netlify. All runtime assets resolve from the
same pinned CDN directory.

Configured endpoint: `wss://proxy.randomx.cc/embed-ws`, with pool
`pool.supportxmr.com:3333`. `demo.js` contains the operator-confirmed donation
wallet from `config.js`. Explicit NiceHash mode preserves byte 42 even if the
relay omits extension flags; required `keepalived` runs every 15 seconds after
login. The proxy must accept the deployed site's Origin if it restricts origins.

The normal widget displays the payout, pool and resource disclosure. Mining
requires a checked consent box and a trusted Start click; loading the page
does not initialize the engine or connect to the proxy. Stop and page unload
end the session and require fresh consent. Approved mining continues in
background tabs, subject to browser throttling or suspension. Default mining workload is 50%;
full dataset initialization uses 32 threads and roughly 2.5 GiB of RAM.

After deploying, check the widget, consent, hashrate and genuine pool-accepted
shares. Test a proxy restart, including while the tab is in the background: transport retries
should reuse the same-seed dataset. Browser diagnostics are available in the
widget's Deployment details and in `window.demoMiner.state` /
`window.demoMiner.diagnostics`. The public VPS/pool path still needs this live
acceptance test; local fixtures did not validate acceptance by the real pool.
