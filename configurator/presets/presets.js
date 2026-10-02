/* Preset pages: one widget per page, created from the same config object the
 * snippet below it prints, so the snippet reproduces exactly this widget.
 * The page's <body data-preset> picks the preset. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const embedScript = document.querySelector('script[src$="/embed.js"]');
  // The demo's payout and bridge (as in the configurator). The bridge is not a
  // public proxy: embeds on it mine to this donation wallet.
  const BASE = { wallet: '4AEm9oe64pUY2saKdCQfSrg5Xy5N8TgGcecM8qZhcri1FSWdvJ4mFAzhfS3my4Cca7dNyZea7BRb2KannBpRBY1yGytE5fv',
    pool: 'pool.supportxmr.com', port: 3333, proxy: 'wss://proxy.randomx.cc/embed-ws', workerName: 'configurator' };
  const TAIL = { nonceMode: 'nicehash', keepalive: 'required', container: '#randomx-miner' };
  const PRESETS = {
    'full-20': { mode: 'full', workload: 20 },
    'full-50': { mode: 'full', workload: 50 },
    'full-80': { mode: 'full', workload: 80 },
    'gentle-light': { mode: 'light', workload: 20, memory: 40, memoryCap: 6, replicas: 0 },
    'mild-light': { mode: 'light', workload: 50, memory: 50, memoryCap: 8, replicas: 'auto' },
    'harsh-light': { mode: 'light', workload: 80, memory: 80, memoryCap: 12, replicas: 'auto' },
  };
  const HEADERS = ['Cross-Origin-Opener-Policy: same-origin', 'Cross-Origin-Embedder-Policy: require-corp',
    'Permissions-Policy: cross-origin-isolated=(self)'];
  const preset = PRESETS[document.body.dataset.preset];
  if (!preset || !window.RandomXEmbed) {
    $('loadError').hidden = false;
    $('loadError').textContent = window.RandomXEmbed ? 'Unknown preset.' :
      `The embed did not load from ${embedScript ? embedScript.src : 'its script URL'}; reload, or check the network and content blockers.`;
    return;
  }
  const config = { ...BASE, ...preset, ...TAIL };
  $('embedVersion').textContent = 'embed ' + RandomXEmbed.version;

  const html = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const json = value => JSON.stringify(value, null, 2).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const snippet = [
    `<!-- wss://proxy.randomx.cc/embed-ws is the randomx.cc demo bridge, not a public wss proxy:
embeds pointed at it mine to the randomx.cc donation wallet, whatever wallet they are configured with.
Point "proxy" at your own bridge to mine to your wallet. -->`,
    ...(config.mode === 'full' ? [`<!-- RandomX embed, full mode. The HTML response of this page must send
  ${HEADERS.join('\n  ')}
(allow cross-origin-isolated in an existing Permissions-Policy instead of a second one).
Without them the embed stops at its preflight check and does not mine; mode "light" needs none. -->`] : []),
    '<div id="randomx-miner"></div>',
    `<script src="${html(embedScript.src)}" crossorigin="anonymous" data-auto="false"></script>`,
    '<script>',
    'window.randomxMiner = RandomXEmbed.create(' + json(config) + ');',
    '</script>'].join('\n');
  $('snippet').textContent = snippet;
  $('copySnippet').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(snippet); $('copyStatus').textContent = 'Snippet copied'; }
    catch (_) { getSelection().selectAllChildren($('snippet')); $('copyStatus').textContent = 'Select the text and copy it'; }
  });
  window.randomxMiner = RandomXEmbed.create(config);
  window.addEventListener('pagehide', () => window.randomxMiner.destroy());
})();
