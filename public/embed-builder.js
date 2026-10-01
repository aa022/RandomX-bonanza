(function () {
  'use strict';
  const form = document.getElementById('embedBuilder');
  if (!form) return;
  const field = name => form.elements.namedItem(name);
  const output = document.getElementById('embedSnippet');
  const status = document.getElementById('embedBuilderStatus');
  const preview = document.getElementById('embedPreview');
  const defaults = window.MINER_DEFAULTS || {};
  field('wallet').value = defaults.wallet || '';
  field('pool').value = defaults.poolHost || '';
  field('port').value = defaults.poolPort || 3333;
  field('proxy').value = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  let instance = null;

  function settings() {
    const config = { wallet: field('wallet').value.trim(), pool: field('pool').value.trim(),
      port: Number(field('port').value), proxy: field('proxy').value.trim(), routeQuery: field('routeQuery').value !== 'false',
      workerName: field('workerName').value.trim(), workload: Number(field('workload').value),
      nonceMode: field('nonceMode').value, keepalive: field('keepalive').value,
      mode: field('mode').value, headless: field('display').value === 'headless', quickstart: field('quickstart').checked };
    return config;
  }
  const html = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const json = value => JSON.stringify(value, null, 2).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  function snippet(config) {
    const src = new URL(field('scriptURL').value.trim(), location.href);
    if (!['http:', 'https:'].includes(src.protocol) || src.username || src.password) throw new Error('Use an HTTP(S) embed script URL');
    const lines = [];
    if (config.headless) {
      lines.push(`<section id="randomx-custom" aria-label="Mining controls">
  <p id="rx-disclosure"></p>
  <label>CPU % <input id="rx-workload" type="number" min="0" max="80" step="any" value="${config.workload}"></label>
  ${config.quickstart ? '' : '<label><input id="rx-consent" type="checkbox"> I agree to use my device for this session.</label>\n  '}<button id="rx-start" type="button">Start mining</button>
  <button id="rx-stop" type="button">Stop mining</button>
  <p id="rx-status" role="status"></p><output id="rx-rate">0 H/s</output>
</section>`);
    }
    lines.push(`<script src="${html(src.href)}" crossorigin="anonymous" data-auto="false"></script>`);
    lines.push('<script>');
    if (config.quickstart) {
      lines.push(`// Replace this handler with your site's consent statement / dialog.
// Call accept() only after informed consent; decline() cancels the request.
document.addEventListener('randomx:consent-request', function (event) {
  if (event.detail.instance !== window.randomxMiner) return;
  if (window.confirm(event.detail.disclosure)) event.detail.accept();
  else event.detail.decline();
});`);
    }
    lines.push('window.randomxMiner = RandomXEmbed.create(' + json(config) + ');');
    if (config.headless) {
      lines.push(`window.randomxMiner.bindControls({
  start: '#rx-start', stop: '#rx-stop', ${config.quickstart ? '' : "consent: '#rx-consent', "}
  workload: '#rx-workload', disclosure: '#rx-disclosure',
  status: '#rx-status', hashrate: '#rx-rate'
});`);
    }
    lines.push('</script>');
    return lines.join('\n');
  }
  function generate() {
    if (!form.reportValidity()) return false;
    try {
      const config = settings();
      // Validate through the actual API, without a widget, engine or network.
      const probe = RandomXEmbed.create({ ...config, headless: true, quickstart: false });
      const budget = probe.limits;
      const { threads, engine } = probe.state;
      probe.destroy();
      output.value = snippet(config);
      document.getElementById('embedBudget').textContent = `${threads}/${budget.cores} mining threads on this device · ` +
        (engine.runtime === 'workers' ? `${engine.workers} light worker${engine.workers === 1 ? '' : 's'}, about ${(engine.memoryMiB / 1000).toFixed(1)} GB` :
          `initialization ${probe.config.initThreads} threads`);
      status.textContent = 'Script generated';
      return true;
    } catch (error) { status.textContent = error.message; return false; }
  }
  form.addEventListener('submit', event => { event.preventDefault(); generate(); });
  form.addEventListener('input', generate);
  document.getElementById('embedCopy').addEventListener('click', async () => {
    if (!generate()) return;
    try { await navigator.clipboard.writeText(output.value); status.textContent = 'Script copied'; }
    catch (_) { output.focus(); output.select(); status.textContent = 'Select and copy the script'; }
  });
  document.getElementById('embedShowPreview').addEventListener('click', () => {
    if (!generate()) return;
    if (instance) instance.destroy();
    preview.replaceChildren();
    const config = settings();
    config.assetBase = new URL('.', location.href).href;
    // This preview intentionally uses the local proxy and local build. The
    // exported snippet retains the deployer's selected bridge/CDN settings.
    config.proxy = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
    config.routeQuery = true;
    config.nonceMode = 'auto'; config.keepalive = 'auto';
    config.container = preview;
    instance = RandomXEmbed.create(config);
    if (config.headless) {
      preview.innerHTML = `<div class="custom-preview"><p>Custom DOM · headless API</p><p class="rx-disclosure"></p>
        <label>CPU % <input class="rx-workload" type="number" min="0" max="80" step="any" value="${config.workload}"></label>
        ${config.quickstart ? '' : '<label><input class="rx-consent" type="checkbox"> I agree to use my device for this session.</label>'}
        <button class="rx-start" type="button">Start mining</button><button class="rx-stop" type="button">Stop</button>
        <p class="rx-status" role="status"></p><output class="rx-rate">0 H/s</output></div>`;
      const $ = selector => preview.querySelector(selector);
      instance.bindControls({ start: $('.rx-start'), stop: $('.rx-stop'), consent: $('.rx-consent'),
        workload: $('.rx-workload'), disclosure: $('.rx-disclosure'), status: $('.rx-status'), hashrate: $('.rx-rate') });
    }
    status.textContent = 'Preview ready';
  });
  document.getElementById('embedClearPreview').addEventListener('click', () => {
    if (instance) instance.destroy(); instance = null; preview.replaceChildren();
    status.textContent = 'Preview cleared';
  });
  document.addEventListener('randomx:consent-request', ({ detail }) => {
    if (!instance || detail.instance !== instance) return;
    const old = preview.querySelector('.site-consent'); if (old) old.remove();
    const notice = document.createElement('div'); notice.className = 'site-consent';
    const text = document.createElement('p'); text.textContent = detail.disclosure;
    const allow = document.createElement('button'); allow.type = 'button'; allow.textContent = 'Allow this session';
    const decline = document.createElement('button'); decline.type = 'button'; decline.textContent = 'Decline';
    allow.addEventListener('click', () => { detail.accept(); notice.remove(); });
    decline.addEventListener('click', () => { detail.decline(); notice.remove(); });
    notice.append(text, allow, decline); preview.appendChild(notice); allow.focus();
    status.textContent = 'Consent required';
  });
  window.addEventListener('pagehide', () => { if (instance) instance.destroy(); });
  generate();
})();
