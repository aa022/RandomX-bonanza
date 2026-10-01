# Embed configurator (Netlify)

This directory is the operator's pre-deployment configurator for the RandomX
embed, published as a static Netlify site. Drag the entire directory into
Netlify's manual deploy interface. Its contents are the site's publish
directory; keep `_headers` beside `index.html`. No build command or
dependency installation is needed.

## The pages

- `presets/*.html`: one live widget per page with the snippet that creates
  exactly that widget below it (`presets/presets.js` builds both from one
  config object). Full · 20 / 50 / 80 %; gentle light (20 % CPU, 40 % RAM,
  6 GB cap, no full-dataset workers); mild light (50 / 50 %, 8 GB, boost on);
  harsh light (80 / 80 %, 12 GB, boost on). The configurator links them.

- `index.html`: the form, from top to bottom.
  1. **Payout and bridge**: wallet, pool, port and WebSocket bridge.
     **Advanced** holds the worker name, bridge routing, nonce mode, keepalive
     and script URL.
  2. **Engine mode**: the Full / Light switch.
     - **Full** shows a warning panel: the COOP/COEP/Permissions-Policy
       headers the embedding page must send, what arming them can break, and
       two choices. Either arm the headers (copyable block, Netlify / nginx /
       Apache hints) or **Switch to light** in one click. It also says whether
       this page itself is isolated (`RandomXEmbed.diagnose('full').modes`).
     - **Light** shows its own panel: RAM % of the reported RAM, the RAM cap
       where none is reported, and the full-dataset boost (`replicas:
       'auto'`), which the workers build before they mine.
     - Both modes take a CPU workload %; full mode also an optional thread
       ceiling (`maxThreads`) and ARM halving (`optimizeArm`). An "On this
       device" estimate comes from `RandomXEmbed.plan()`: threads, the RAM
       budget, light and full-dataset workers and RAM. Visitors' devices
       differ.
  3. **Visitor interface**: widget or headless API, and quickstart consent.
  4. **Snippet**: regenerated on every change and validated by `plan()`; it
     creates no instance and opens no network connection. A full-mode snippet
     starts with an HTML comment listing the required headers. **Copy
     snippet** copies it, and **Deployment notes** cover asset hosting, CSP
     and the bridge's Origin policy.
  5. **Preview on this device**: runs the configured settings through the
     embed this page loaded. Its mining is real: it pays the configured wallet
     through the configured pool and bridge, but only after consent and Start.
- `configurator.js`: the form logic. The snippet generation, HTML/JSON
  escaping and the consent notice follow `public/embed-builder.js`.
- `configurator.css`: the widget's look (monospace, paper/ink, pink accent,
  hard offset shadow) with dark mode via `prefers-color-scheme`.
- `_headers`: COOP `same-origin`, COEP `require-corp` and
  `Permissions-Policy: cross-origin-isolated=(self)`. These make this page
  cross-origin isolated, so the preview can run full mode. Light mode runs
  with or without them.

Loading the page does not start an engine, a worker or a WebSocket. The
preview follows the embed's consent rules: the widget's checkbox and a trusted
Start click (or the site consent notice for headless/quickstart). Stop,
**Remove preview** and leaving the page end the session.

## The pin

The page loads `embed.js` (`data-auto="false"`, `crossorigin`) from jsDelivr,
pinned to commit `f2594c79882775d17fa916aaedc0c5a6c927c7d9` on
`embed-v0.2.0-demo` (embed 0.3.0). The engine assets resolve from the same
pinned `dist/` directory, and nothing from `dist/` is uploaded to Netlify. The
**Script URL** field defaults to the embed this page loaded, so exported
snippets carry the same pin. It must be absolute: the snippet runs on the
operator's site, not on this page.

jsDelivr serves that commit only once it is pushed to GitHub. To move the
pin, commit `dist/` first. Then change the SHA in `index.html` (and here) in
a later commit, and never rewrite the pinned commit.

## Defaults

The form is prefilled with the former test page's values:

- bridge `wss://proxy.randomx.cc/embed-ws`;
- pool `pool.supportxmr.com:3333`;
- the operator-confirmed donation wallet from `config.js`;
- worker `netlify-demo`;
- NiceHash nonce mode, which preserves byte 42 even if the relay omits
  extension flags;
- required `keepalived` every 15 seconds;
- full mode at 50 % workload.

The bridge must accept the deployed site's Origin if it restricts origins.

## Local testing

    make demo                            # http://localhost:8090, with _headers (isolated)
    make demo DEMO_ARGS=--no-isolation   # the same page without COOP/COEP
    make demo DEMO_PORT=9000             # another port

`scripts/serve-demo.mjs` (Node built-ins only) serves this directory. It
rewrites the jsDelivr pin in the HTML to a local `/dist/` route, served from
the checkout's `dist/` with `Access-Control-Allow-Origin: *` and
`Cross-Origin-Resource-Policy: cross-origin`, as jsDelivr does. `_headers`
applies to the page as on Netlify. `--no-isolation` drops COOP/COEP, which
shows the full-mode warning on a page that is not isolated and lets light
mode be tested there. Snippets exported from the local page point at
`http://localhost:8090/dist/embed.js`, so they also work from other local
origins.

For a preview that does not touch a real pool, point the bridge field at a
local test bridge (for example the reference `proxy/index.js` configured for a
fixture pool, as `tests/embed-browser.cjs` does). After deploying, check the
live page's isolation headers and that the pinned jsDelivr assets return
HTTP 200 with the hashes in `dist/manifest.json`.
